// State & session domain (M4-B): get_state / update_state over the runtime
// context's revision, the persisted settings, saved-session fields, seen-feature
// flags and the scanner ingest configuration. Owned by the M4-B state
// workstream — see mcp/hsr-optimizer-MCP-全站覆盖计划.md §5 M4.
//
// The persisted sections map 1:1 onto what SaveState.save() writes:
//   - settings → globalStore.settings (the SettingsDrawer's six selects)
//   - session  → savedSession { showcaseTab, global } (+ an `ephemeral` block
//                for session-shaped runtime fields that never reach the file)
//   - flags    → seenFeatures
//   - scanner  → scannerSettings (customUrl derived exactly like SaveState.save)
// Enum values and defaults are derived from upstream constants
// (SettingOptions / DefaultSettingOptions / savedSessionDefaults), never
// hardcoded; only the Chinese labels are transcribed from
// public/locales/zh_CN/settings.yaml. Writes reuse the upstream store setters
// (SettingsDrawer's setSettings path, setSavedSession, setSeenFeatures, the
// scanner action setters) inside runtimeContext.withChange, then markDirty.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ShowcasePreset } from 'lib/characterPreview/debugVisualConfigStore'
import {
  COMPUTE_ENGINE_CPU,
  COMPUTE_ENGINE_GPU_EXPERIMENTAL,
  COMPUTE_ENGINE_GPU_STABLE,
} from 'lib/constants/constants'
import { ACTIVE_NEW_FEATURES } from 'lib/constants/newFeatures'
import {
  DefaultSettingOptions,
  SettingOptions,
} from 'lib/constants/settingsConstants'
import { ScoringType } from 'lib/scoring/scoringTypes'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  savedSessionDefaults,
  useGlobalStore,
} from 'lib/stores/app/appStore'
import { useCharacterStore } from 'lib/stores/character/characterStore'
import { useNewFeatureStore } from 'lib/stores/newFeatureStore'
import {
  type CharacterGridDensity,
  characterGridPresets,
} from 'lib/tabs/tabCharacters/characterGridPresets'
import {
  DEFAULT_WEBSOCKET_URL,
  useScannerState,
} from 'lib/tabs/tabImport/scannerStore'
import type { ShowcaseTabSavedSession } from 'lib/tabs/tabShowcase/showcaseTabTypes'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import type { CharacterId } from 'types/character'
import type {
  GlobalSavedSession,
  UserSettings,
} from 'types/store'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { toolResult } from '../toolResult'

// ─── sections ────────────────────────────────────────────────────────────────

const GET_SECTIONS = ['revision', 'settings', 'session', 'flags', 'scanner'] as const
const UPDATE_SECTIONS = ['settings', 'session', 'flags', 'scanner'] as const
type GetSection = (typeof GET_SECTIONS)[number]
type UpdateSection = (typeof UPDATE_SECTIONS)[number]

// ─── section readers (payload shapes mirror SaveState.save()) ───────────────

function revisionSection() {
  const save = runtimeContext.getSave()
  return {
    loaded: save != null,
    path: save?.path ?? null,
    dirty: runtimeContext.isDirty(),
    revision: runtimeContext.getRevision(),
    generation: runtimeContext.getSaveGeneration(),
    blockedWrite: runtimeContext.getLastBlockedWrite(),
  }
}

// 中文标签转写自 public/locales/zh_CN/settings.yaml(设置抽屉的实际文案);
// 枚举值与默认值不在此处——由上游 SettingOptions / DefaultSettingOptions 派生。
const SETTING_LABELS: Record<keyof UserSettings, { label: string, options: Record<string, string> }> = {
  RelicEquippingBehavior: {
    label: '装备其他角色所装备的遗器(跨角色装备行为)',
    options: {
      Replace: '替换遗器而不交换',
      Swap: '与该遗器装备者交换遗器',
    },
  },
  PermutationsSidebarBehavior: {
    label: '在较小屏幕上缩小优化器侧边工具栏(小屏收缩侧栏)',
    options: {
      'Show XL': '侧边工具栏大部分被隐藏时最小化(默认)',
      'Show XXL': '侧边工具栏任何部分被隐藏时最小化',
      'Do Not Show': '始终将工具栏保持在右侧',
    },
  },
  ExpandedInfoPanelPosition: {
    label: '优化器扩展信息面板位置',
    options: {
      Above: '在遗器预览上方显示扩展信息',
      Below: '在遗器预览下方显示扩展信息(默认)',
    },
  },
  ShowLocatorInRelicsModal: {
    label: '遗物编辑器中的遗物定位器',
    options: {
      Yes: '在遗物编辑器中显示遗物定位器',
      No: '在遗物编辑器中不显示遗物定位器(默认)',
    },
  },
  ShowComboDmgWarning: {
    label: '显示连招伤害(Combo DMG)警告',
    options: {
      Show: '显示警告(默认)',
      HideV2: '隐藏警告',
    },
  },
  NewCharacterDefaultRank: {
    label: '新角色默认排序',
    options: {
      First: '最高优先级(第 1 位,默认)',
      Last: '最低优先级',
    },
  },
}

function settingsSection() {
  const settings = useGlobalStore.getState().settings
  const definitions: Record<string, { type: 'enum', values: string[], default: string, label: string, options: Record<string, string> }> = {}
  for (const key of Object.keys(SettingOptions) as (keyof UserSettings)[]) {
    const values = [...Object.values(SettingOptions[key])]
    const labels = SETTING_LABELS[key]
    const options: Record<string, string> = {}
    for (const value of values) options[value] = labels.options[value] ?? value
    definitions[key] = {
      type: 'enum',
      values,
      default: DefaultSettingOptions[key],
      label: labels.label,
      options,
    }
  }
  return { settings: { ...settings }, definitions }
}

function sessionSection() {
  const globalState = useGlobalStore.getState()
  return {
    savedSession: {
      showcaseTab: { ...useShowcaseTabStore.getState().savedSession },
      global: { ...globalState.savedSession },
    },
    defaults: { ...savedSessionDefaults },
    // 会话临时态:存在于内存 store、但 SaveState.save() 不落盘的字段
    ephemeral: {
      activeKey: globalState.activeKey,
      scoringAlgorithmFocusCharacter: globalState.scoringAlgorithmFocusCharacter ?? null,
      statTracesDrawerFocusCharacter: globalState.statTracesDrawerFocusCharacter ?? null,
    },
  }
}

function flagsSection() {
  return {
    seenFeatures: [...useNewFeatureStore.getState().seenFeatures],
    activeNewFeatures: [...ACTIVE_NEW_FEATURES],
  }
}

function scannerSection() {
  const scanner = useScannerState.getState()
  return {
    ingest: scanner.ingest,
    ingestCharacters: scanner.ingestCharacters,
    ingestOnlyExistingCharacters: scanner.ingestOnlyExistingCharacters,
    ingestWarpResources: scanner.ingestWarpResources,
    websocketUrl: scanner.websocketUrl,
    // 与 SaveState.save() 同一派生:customUrl = 地址非默认
    customUrl: scanner.websocketUrl !== DEFAULT_WEBSOCKET_URL,
    defaultWebsocketUrl: DEFAULT_WEBSOCKET_URL,
  }
}

const sectionReaders: Record<GetSection, () => Record<string, unknown>> = {
  revision: revisionSection,
  settings: settingsSection,
  session: sessionSection,
  flags: flagsSection,
  scanner: scannerSection,
}

const sectionSummaries: Record<GetSection, (data: Record<string, unknown>) => string> = {
  revision: (data) => {
    const r = data as ReturnType<typeof revisionSection>
    return `修订号 revision=${r.revision},存档世代 generation=${r.generation},存档${r.loaded ? `已载入(${r.path ?? '内联 JSON'})` : '未载入'}${
      r.dirty ? ',有未落盘变更' : ''
    }${r.blockedWrite ? `,写回被拦截:${r.blockedWrite.reason}` : ''}`
  },
  settings: () => '设置已返回:每项含当前值、枚举值、上游默认值与中文说明(默认值派生自上游 DefaultSettingOptions)',
  session: () =>
    '持久化会话字段已返回(savedSession.showcaseTab + savedSession.global,与存档落盘字段一致);defaults 为上游默认值;ephemeral 为会话临时态,不写入存档',
  flags: (data) => {
    const f = data as ReturnType<typeof flagsSection>
    return `已读特性标记 ${f.seenFeatures.length} 项;当前活跃的新特性键:${f.activeNewFeatures.join(', ') || '(无)'}`
  },
  scanner: (data) => {
    const s = data as ReturnType<typeof scannerSection>
    return `扫描器配置:websocketUrl=${s.websocketUrl}${s.customUrl ? '(自定义)' : '(默认)'},ingest=${s.ingest},ingestCharacters=${s.ingestCharacters}`
      + `,ingestOnlyExistingCharacters=${s.ingestOnlyExistingCharacters},ingestWarpResources=${s.ingestWarpResources}`
  },
}

// ─── output schema blocks (shared by get_state and update_state echoes) ─────

const blockedWriteSchema = z.object({
  at: z.number(),
  reason: z.string(),
}).nullable()

const revisionSectionSchema = z.object({
  loaded: z.boolean(),
  path: z.string().nullable(),
  dirty: z.boolean(),
  revision: z.number().int(),
  generation: z.number().int(),
  blockedWrite: blockedWriteSchema,
})

const settingDefinitionSchema = z.object({
  type: z.literal('enum'),
  values: z.array(z.string()),
  default: z.string(),
  label: z.string(),
  options: z.record(z.string(), z.string()),
})

const settingsSectionSchema = z.object({
  settings: z.record(z.string(), z.string()),
  definitions: z.record(z.string(), settingDefinitionSchema),
})

const globalSessionSchema = z.object({
  optimizerCharacterId: z.string().nullable(),
  scoringType: z.number(),
  computeEngine: z.string(),
  showcaseStandardMode: z.boolean(),
  showcaseDarkMode: z.boolean(),
  showcasePreset: z.string(),
  showcaseUID: z.boolean(),
  showcaseL2D: z.boolean(),
  showcasePreciseSpd: z.boolean(),
  sidebarCollapsed: z.boolean(),
  characterGridDensity: z.string(),
  teamShowcaseSavedTeams: z.array(z.unknown()),
})

const sessionSectionSchema = z.object({
  savedSession: z.object({
    showcaseTab: z.object({
      scorerId: z.string().nullable(),
      sidebarOpen: z.boolean(),
    }),
    global: globalSessionSchema,
  }),
  defaults: globalSessionSchema,
  ephemeral: z.object({
    activeKey: z.string(),
    scoringAlgorithmFocusCharacter: z.string().nullable(),
    statTracesDrawerFocusCharacter: z.string().nullable(),
  }),
})

const flagsSectionSchema = z.object({
  seenFeatures: z.array(z.string()),
  activeNewFeatures: z.array(z.string()),
})

const scannerSectionSchema = z.object({
  ingest: z.boolean(),
  ingestCharacters: z.boolean(),
  ingestOnlyExistingCharacters: z.boolean(),
  ingestWarpResources: z.boolean(),
  websocketUrl: z.string(),
  customUrl: z.boolean(),
  defaultWebsocketUrl: z.string(),
})

const sectionEchoSchemas = {
  settings: settingsSectionSchema.optional(),
  session: sessionSectionSchema.optional(),
  flags: flagsSectionSchema.optional(),
  scanner: scannerSectionSchema.optional(),
} as const

// ─── patch field specs (key allowlist + per-field zod partial schemas) ──────

type FieldSpec = {
  schema: z.ZodTypeAny,
  /** 中文期望说明,直接进错误消息 */
  expected: string,
}

const booleanSpec = (expected: string): FieldSpec => ({ schema: z.boolean(), expected })

const settingsFieldSpecs = {} as Record<keyof UserSettings, FieldSpec>
for (const key of Object.keys(SettingOptions) as (keyof UserSettings)[]) {
  const values = Object.values(SettingOptions[key]) as [string, ...string[]]
  settingsFieldSpecs[key] = {
    schema: z.enum(values),
    expected: `枚举值:${values.join(' | ')}`,
  }
}

const GRID_DENSITY_KEYS = Object.keys(characterGridPresets) as [CharacterGridDensity, ...CharacterGridDensity[]]
const showcaseTabSessionKeys = new Set<string>(Object.keys(useShowcaseTabStore.getInitialState().savedSession))

// Record<联合键, ...> 让本表对上游类型穷尽:上游新增会话键时 tsgo 直接报错,直到补到这里。
type SessionFieldKey = keyof GlobalSavedSession | keyof ShowcaseTabSavedSession
const sessionFieldSpecs: Record<SessionFieldKey, FieldSpec> = {
  optimizerCharacterId: { schema: z.string().nullable(), expected: '角色 id 字符串(如 "1003")或 null(清除)' },
  scoringType: {
    schema: z.nativeEnum(ScoringType),
    expected: '评分类型枚举:0=DPS_SCORE,1=SUBSTAT_SCORE,2=NONE,3=BUFFER_SCORE,4=HEAL_SCORE,5=SHIELD_SCORE',
  },
  computeEngine: {
    schema: z.enum([COMPUTE_ENGINE_CPU, COMPUTE_ENGINE_GPU_STABLE, COMPUTE_ENGINE_GPU_EXPERIMENTAL] as const),
    expected: `计算引擎枚举:"${COMPUTE_ENGINE_CPU}" | "${COMPUTE_ENGINE_GPU_STABLE}" | "${COMPUTE_ENGINE_GPU_EXPERIMENTAL}"`,
  },
  showcaseStandardMode: booleanSpec('布尔'),
  showcaseDarkMode: booleanSpec('布尔'),
  showcasePreset: {
    schema: z.enum([ShowcasePreset.SHINE, ShowcasePreset.NATURAL] as const),
    expected: `展示预设枚举:"${ShowcasePreset.SHINE}" | "${ShowcasePreset.NATURAL}"`,
  },
  showcaseUID: booleanSpec('布尔'),
  showcaseL2D: booleanSpec('布尔'),
  showcasePreciseSpd: booleanSpec('布尔'),
  sidebarCollapsed: booleanSpec('布尔(侧栏收缩标记)'),
  characterGridDensity: {
    schema: z.enum(GRID_DENSITY_KEYS),
    expected: `角色网格密度枚举:${GRID_DENSITY_KEYS.join(' | ')}`,
  },
  teamShowcaseSavedTeams: {
    schema: z.array(z.unknown()),
    expected: '已保存组队数组(结构同 get_state(session) 的 teamShowcaseSavedTeams,整组替换)',
  },
  scorerId: { schema: z.string().nullable(), expected: '展示页评分器 id 字符串或 null' },
  sidebarOpen: booleanSpec('布尔(showcaseTab 侧栏)'),
}

type ScannerFieldKey = 'ingest' | 'ingestCharacters' | 'ingestOnlyExistingCharacters' | 'ingestWarpResources' | 'websocketUrl' | 'customUrl'
const scannerFieldSpecs: Record<ScannerFieldKey, FieldSpec> = {
  ingest: booleanSpec('布尔(是否摄入扫描器数据)'),
  ingestCharacters: booleanSpec('布尔(是否摄入角色数据)'),
  ingestOnlyExistingCharacters: booleanSpec('布尔(是否仅摄入已有角色)'),
  ingestWarpResources: booleanSpec('布尔(是否自动导入跃迁资源)'),
  websocketUrl: {
    schema: z.string().min(1),
    expected: `非空字符串(扫描器 websocket 地址,如 "${DEFAULT_WEBSOCKET_URL}")`,
  },
  customUrl: booleanSpec('布尔(true=使用自定义地址;false=重置为默认地址)'),
}

const flagsFieldSpecs = {
  seenFeatures: {
    schema: z.array(z.string()),
    expected: '字符串数组,整组替换已读特性标记(当前活跃的新特性键见 get_state(flags).activeNewFeatures)',
  },
} satisfies Record<string, FieldSpec>

const sectionFieldSpecs: Record<UpdateSection, Record<string, FieldSpec>> = {
  settings: settingsFieldSpecs,
  session: sessionFieldSpecs,
  flags: flagsFieldSpecs,
  scanner: scannerFieldSpecs,
}

function validatePatch(section: UpdateSection, patch: Record<string, unknown>): void {
  const specs = sectionFieldSpecs[section]
  const legalKeys = Object.keys(specs)
  const keys = Object.keys(patch)
  if (keys.length === 0) {
    throw new Error(`update_state(section=${section}): patch 不能为空 — 至少提供一个要修改的字段;合法字段:${legalKeys.join(', ')}`)
  }
  const unknownKeys = keys.filter((key) => !(key in specs))
  if (unknownKeys.length > 0) {
    throw new Error(
      `update_state(section=${section}): 未知字段 ${unknownKeys.map((key) => `"${key}"`).join(', ')} — 该 section 的合法字段:${legalKeys.join(', ')}`,
    )
  }
  for (const key of keys) {
    const spec = specs[key] as FieldSpec
    const parsed = spec.schema.safeParse(patch[key])
    if (!parsed.success) {
      throw new Error(
        `update_state(section=${section}): 字段 ${key} 的值无效 — 期望 ${spec.expected},实际收到 ${JSON.stringify(patch[key])}`,
      )
    }
  }
  // 上游载入归一化按「当前存档的角色集」校验 optimizerCharacterId,不在其中
  // 即静默归一为 null(persistenceService.loadSaveData);API 侧显式报错比静默
  // 清空更可操作,且校验口径与载入一致(元数据 ∩ 当前存档)。
  const optimizerCharacterId = patch['optimizerCharacterId']
  if (section === 'session' && optimizerCharacterId != null) {
    const inMetadata = !!getGameMetadata().characters[optimizerCharacterId as CharacterId]
    const inSave = !!(useCharacterStore.getState().charactersById as Record<string, unknown>)[optimizerCharacterId as string]
    if (!inMetadata || !inSave) {
      throw new Error(
        `update_state(section=session): 字段 optimizerCharacterId 的值 "${optimizerCharacterId}" ${
          inMetadata ? '不在当前存档的角色列表中(网页端载入时会把这种引用静默清空)' : '不在游戏元数据中'
        } — 请改用当前存档里已存在的角色 id,或显式传 null 清除`,
      )
    }
  }
}

function applyPatch(section: UpdateSection, patch: Record<string, unknown>): void {
  switch (section) {
    case 'settings': {
      // SettingsDrawer 的写入路径:onValuesChange 直接 setSettings(完整对象)。
      // 默认值打底 + 当前值居中 + patch 覆盖,保持上游载入归一化语义。
      const current = useGlobalStore.getState().settings
      useGlobalStore.getState().setSettings({ ...DefaultSettingOptions, ...current, ...patch } as UserSettings)
      return
    }
    case 'session': {
      // global 走 useGlobalStore.setSavedSession(上游载入/引擎切换同款完整对象语义),
      // showcaseTab 走 useShowcaseTabStore.setSavedSession(上游部分合并语义)。
      const globalPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => !showcaseTabSessionKeys.has(key))) as Partial<GlobalSavedSession>
      const showcasePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => showcaseTabSessionKeys.has(key))) as Partial<ShowcaseTabSavedSession>
      if (Object.keys(globalPatch).length > 0) {
        useGlobalStore.getState().setSavedSession({
          ...savedSessionDefaults,
          ...useGlobalStore.getState().savedSession,
          ...globalPatch,
        })
      }
      if (Object.keys(showcasePatch).length > 0) {
        // setSavedSession 的 action 类型要求完整对象(setter 自身也是合并语义),
        // 用当前值打底把 patch 摊成完整 session 再传入
        useShowcaseTabStore.getState().setSavedSession({
          ...useShowcaseTabStore.getState().savedSession,
          ...showcasePatch,
        })
      }
      return
    }
    case 'flags': {
      // 上游 store setter 即整组替换(载入路径 new Set(saveData.seenFeatures))
      useNewFeatureStore.getState().setSeenFeatures(new Set(patch['seenFeatures'] as string[]))
      return
    }
    case 'scanner': {
      // Direct setState over the scanner fields (the load path's approach in
      // saveStores.replaceSaveStores): the upstream action setters schedule a
      // 5s SaveState.delayedSave() the coordinator cannot cancel, which would
      // fire even after a rolled-back transaction. In this server the socket
      // is never connected, so the setters' re-import branches are dormant and
      // direct writes are behaviorally identical minus that stray timer.
      const update: Record<string, unknown> = {}
      if (typeof patch['ingest'] === 'boolean') update.ingest = patch['ingest']
      if (typeof patch['ingestCharacters'] === 'boolean') update.ingestCharacters = patch['ingestCharacters']
      if (typeof patch['ingestOnlyExistingCharacters'] === 'boolean') update.ingestOnlyExistingCharacters = patch['ingestOnlyExistingCharacters']
      if (typeof patch['ingestWarpResources'] === 'boolean') update.ingestWarpResources = patch['ingestWarpResources']
      if (typeof patch['websocketUrl'] === 'string') update.websocketUrl = patch['websocketUrl']
      if (patch['customUrl'] === false && typeof patch['websocketUrl'] === 'string' && patch['websocketUrl'] !== DEFAULT_WEBSOCKET_URL) {
        // Symmetric with the customUrl=true guard below: an explicit custom
        // url silently reset to default in the same patch would drop a value
        // the caller deliberately provided.
        throw new Error(
          `update_state(section=scanner): 同一 patch 里 websocketUrl 提供了自定义地址,又传 customUrl=false 要求重置 — 两者矛盾,请只保留其一`,
        )
      }
      if (patch['customUrl'] === false) update.websocketUrl = DEFAULT_WEBSOCKET_URL
      if (patch['customUrl'] === true) {
        // customUrl 是派生标记(SaveState.save:websocketUrl !== 默认地址):
        // true = 要求(可能同 patch 刚写入的)地址非默认。
        const url = (update.websocketUrl as string | undefined) ?? useScannerState.getState().websocketUrl
        if (url === DEFAULT_WEBSOCKET_URL) {
          throw new Error(
            `update_state(section=scanner): customUrl=true 但 websocketUrl 仍是默认地址 ${DEFAULT_WEBSOCKET_URL} — 请在同一个 patch 中带上自定义 websocketUrl`
              + '(或直接只改 websocketUrl,customUrl 随之派生)',
          )
        }
      }
      useScannerState.setState(update)
      return
    }
  }
}

// ─── tool registration ───────────────────────────────────────────────────────

export function registerStateTools(server: McpServer): void {
  server.registerTool('get_state', {
    title: '读取状态域',
    description: '读取服务器状态与配置域的当前值——对应网页端设置抽屉/侧栏/扫描器设置等持久化状态。'
      + 'section=revision:变更修订号与存档概况(loaded/path/dirty/revision/generation/blockedWrite,口径同 save_status);'
      + 'section=settings:六项用户设置 + 每项定义(枚举值/上游默认值/中文说明);'
      + 'section=session:存档真正落盘的会话字段(savedSession:showcaseTab + global,含 sidebarCollapsed 等)与上游默认值,'
      + 'ephemeral 子对象为会话临时态(不写入存档);'
      + 'section=flags:已读特性标记 seenFeatures 数组(附当前活跃的新特性键);'
      + 'section=scanner:扫描器接入配置六字段(ingest/ingestCharacters/ingestOnlyExistingCharacters/ingestWarpResources/websocketUrl/customUrl)。'
      + '只读无副作用,不递增 revision。',
    inputSchema: {
      section: z.enum(GET_SECTIONS).describe(
        '要读取的状态域:revision=修订与存档概况,settings=用户设置,session=持久化会话字段,flags=已读特性标记,scanner=扫描器接入配置',
      ),
    },
    outputSchema: {
      section: z.enum(GET_SECTIONS),
      revision: revisionSectionSchema.optional(),
      ...sectionEchoSchemas,
    },
  }, async ({ section }) => {
    const data = sectionReaders[section]()
    const payload: Record<string, unknown> = { section }
    payload[section] = data
    return toolResult(payload, sectionSummaries[section](data))
  })

  server.registerTool('update_state', {
    title: '更新状态域字段',
    description: '按 section 覆盖更新状态字段——对应网页端设置抽屉改设置、收缩侧栏、扫描器设置等写入动作。'
      + 'patch 的键必须是该 section 的已知字段,未知键报错并列出全部合法键;'
      + 'settings/session/scanner 按字段覆盖合并(未提及字段保持不变),flags 的 seenFeatures 为整组替换。'
      + '可选 baseRevision 做乐观并发检查:与当前修订号不一致即报冲突(消息含两个修订号),需重读状态后重试。'
      + '变更经事务协调器提交:任一步失败整体回滚;成功后标记 dirty、revision 递增,由防抖写回落盘。'
      + '注意:revision 域只读不可写(枚举里没有它);scanner.customUrl 是派生标记——置 false 会把地址重置为默认,置 true 需同时在 patch 中提供自定义 websocketUrl。',
    inputSchema: {
      section: z.enum(UPDATE_SECTIONS).describe('要更新的状态域:settings/session/flags/scanner(revision 只读,不在此列)'),
      patch: z.record(z.string(), z.unknown()).describe('字段 patch 对象:键为该 section 的已知字段,值为新值(合法字段与枚举见 get_state 对应 section 的返回)'),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突,需重读后重试'),
    },
    outputSchema: {
      updated: z.boolean(),
      section: z.enum(UPDATE_SECTIONS),
      revision: z.number().int(),
      dirty: z.boolean(),
      ...sectionEchoSchemas,
    },
  }, async ({ section, patch, baseRevision }) => {
    runtimeContext.requireSave()
    runtimeContext.ensureMetadataReady()
    validatePatch(section, patch)

    // baseRevision is checked INSIDE the scope (after earlier-queued changes
    // landed) so a same-batch write cannot slip past the conflict gate.
    await runtimeContext.withChange('update_state', () => {
      applyPatch(section, patch)
      runtimeContext.markDirty()
    }, baseRevision != null ? { baseRevision } : {})

    const revision = runtimeContext.getRevision()
    const payload: Record<string, unknown> = {
      updated: true,
      section,
      revision,
      dirty: true,
    }
    payload[section] = sectionReaders[section]()
    return toolResult(
      payload,
      `已更新 ${section}(字段:${Object.keys(patch).join(', ')}),revision=${revision},变更已标记待防抖写回`,
    )
  })
}
