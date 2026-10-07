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
import i18next from 'i18next'
import { DEFAULT_SHOWCASE_COLOR } from 'lib/characterPreview/color/showcaseColorService'
import { editShowcasePreferences } from 'lib/characterPreview/customization/showcaseCustomizationController'
import {
  type DebugVisualConfig,
  NATURAL_PRESET,
  SHINE_PRESET,
  ShowcasePreset,
  TEXT_SHADOW_PRESETS,
  useDebugVisualConfigStore,
} from 'lib/characterPreview/debugVisualConfigStore'
import {
  COMPUTE_ENGINE_CPU,
  COMPUTE_ENGINE_GPU_EXPERIMENTAL,
  COMPUTE_ENGINE_GPU_STABLE,
  ShowcaseColorMode,
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
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import {
  type CharacterGridDensity,
  characterGridPresets,
} from 'lib/tabs/tabCharacters/characterGridPresets'
import {
  DEFAULT_WEBSOCKET_URL,
  useScannerState,
} from 'lib/tabs/tabImport/scannerStore'
import {
  initialMenuState,
  OptimizerMenuIds,
} from 'lib/tabs/tabOptimizer/optimizerForm/layout/optimizerMenuIds'
import { useRelicsTabStore } from 'lib/tabs/tabRelics/useRelicsTabStore'
import type { ShowcaseTabSavedSession } from 'lib/tabs/tabShowcase/showcaseTabTypes'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import type { CharacterId } from 'types/character'
import type {
  GlobalSavedSession,
  UserSettings,
} from 'types/store'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { MCP_I18N_LANGUAGE } from '../i18n/i18nNode'
import { toolResult } from '../toolResult'
import { replayScannerSettings } from './scanner'

// ─── sections ────────────────────────────────────────────────────────────────

const GET_SECTIONS = ['revision', 'settings', 'session', 'flags', 'scanner', 'showcase', 'visualDebug', 'relicsTab', 'layout'] as const
const UPDATE_SECTIONS = ['settings', 'session', 'flags', 'scanner', 'showcase', 'visualDebug', 'relicsTab', 'layout'] as const
type GetSection = (typeof GET_SECTIONS)[number]
type UpdateSection = (typeof UPDATE_SECTIONS)[number]

// ─── language (global.language.switch / global.language persistence) ─────────
// 查证结论:上游语言不落在存档里——i18n.ts 用 i18next-browser-languagedetector
// 初始化,changeLanguage 后由 detector 写入自己的缓存键 localStorage['i18nextLng']
// (detector 默认 lookup,上游未覆写;src/lib/i18n/i18n.ts:48-49 的 .use(LanguageDetector)
// 不带 options)。GlobalSavedSession(src/types/store.ts:43-56)没有 language 字段,
// SaveState.save() 也不序列化它。因此 MCP 侧 language 属于「会话临时态」:
//   - 读:detector 缓存键,缺省回落到本进程当前渲染语言(MCP 启动固定 zh_CN);
//   - 写:只写同一个缓存键(镜像 detector 的 cacheUserLanguage 行为),由
//     localStorage shim(文件后端)跨进程持久化;本进程已初始化的 i18n 语言
//     不因此切换——ensureI18nReady 固定 zh_CN,切不切由调用方进程决定。
// 正式站语言清单 completedLocales 转写自 src/lib/i18n/i18n.ts:14(该模块在
// import 时即初始化网页版 i18next/http-backend,MCP 不能引入,故按上游同值
// 转写,与 SETTING_LABELS 的转写先例一致);测试站(BETA)另有 de_DE/it_IT/
// tr_TR/zh_TW/aa_ER 等 WIP 语言,不在正式站枚举内。
const I18NEXT_LOOKUP_KEY = 'i18nextLng'
const COMPLETED_LOCALES = ['en_US', 'es_ES', 'fr_FR', 'ja_JP', 'ko_KR', 'pt_BR', 'ru_RU', 'vi_VN', 'zh_CN'] as const
type LanguageLocale = (typeof COMPLETED_LOCALES)[number]

function activeI18nLanguage(): string {
  return (i18next.isInitialized && i18next.resolvedLanguage) || MCP_I18N_LANGUAGE
}

function readLanguagePreference(): string {
  return localStorage.getItem(I18NEXT_LOOKUP_KEY) ?? activeI18nLanguage()
}

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
    bootLoaded: runtimeContext.isBootLoaded(),
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
    // 会话临时态:存在于内存 store、但 SaveState.save() 不落盘的字段。
    // language 是网页端 i18next 语言选择器的持久偏好(上游经
    // LanguageDetector 缓存在 localStorage['i18nextLng'],不在存档里);
    // activeLanguage 是本进程当前实际渲染语言(MCP 固定 zh_CN,写入
    // language 不改变它——见 update_state 的 describe)。
    ephemeral: {
      activeKey: globalState.activeKey,
      scoringAlgorithmFocusCharacter: globalState.scoringAlgorithmFocusCharacter ?? null,
      statTracesDrawerFocusCharacter: globalState.statTracesDrawerFocusCharacter ?? null,
      language: readLanguagePreference(),
      activeLanguage: activeI18nLanguage(),
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

// 展示评分偏好(useShowcaseTabStore.showcasePreferences,SaveState.save 落盘为
// save.showcasePreferences;角色页展示卡与组队面板槽位卡共用同一份数据)。
function showcaseSection() {
  const preferences = useShowcaseTabStore.getState().showcasePreferences
  return {
    preferences: { ...preferences },
    count: Object.keys(preferences).length,
  }
}

// ─── visualDebug 段(会话临时态,不落盘) ─────────────────────────────────────
//
// useDebugVisualConfigStore(src/lib/characterPreview/debugVisualConfigStore.ts)
// 是纯 zustand 会话 store:上游从不把它写进 SaveState.save(),刷新即回到
// 默认值——MCP 侧同语义,update 不走 withChange/markDirty、不进 revision。
// 19 个字段的含义/默认值派生自上游常量(PORTRAIT_* / CARD_BG_ALPHA_DEFAULT /
// DEFAULT_CONFIG.cardBg / SHADOW_* / TEXT_SHADOW_DEFAULT),此处不硬编码。
// cardDebug 对应 globalThis.CARD_DEBUG(CharacterPreview.tsx:138 模块加载即
// false):上游是页面全局布尔,MCP 侧在本模块持有一个 Node 会话变量,渲染/
// 调试任务经 taskGlobals 把它带给页面(browserManager.setCardDebug)。
let cardDebugSession = false

/** DebugVisualConfig 的全部配置键。as const + 下面的穷尽性断言保证:上游
 * DebugVisualConfig 加字段时 tsgo 在此报错(缺失键会让 Exclude 非 never),
 * 提示把新键补进本列表与字段校验——宽类型注解的数组做不到这一点。 */
const DEBUG_VISUAL_FIELDS = [
  'portraitBlur',
  'portraitBrightness',
  'portraitSaturate',
  'portraitContrast',
  'cardBgAlpha',
  'debugMaxC',
  'debugMinC',
  'debugChromaScale',
  'debugTargetL',
  'debugMinL',
  'debugMaxL',
  'blendMode',
  'shadowX',
  'shadowY',
  'shadowBlur',
  'shadowOpacity',
  'insetBlur',
  'insetOpacity',
  'textShadow',
] as const

// 编译期穷尽性:列表没跟上上游类型时,这里的类型不再是 never。
type MissingVisualField = Exclude<keyof DebugVisualConfig, (typeof DEBUG_VISUAL_FIELDS)[number]>
const assertVisualFieldsExhaustive: MissingVisualField = undefined as never

function readDebugVisualConfig(): DebugVisualConfig {
  const state = useDebugVisualConfigStore.getState()
  // Object.fromEntries 只能给 index-signature 形状,字段级对应由 DEBUG_VISUAL_
  // FIELDS(上游 keyof DebugVisualConfig 穷尽)保证,经 unknown 收窄到目标类型。
  return Object.fromEntries(DEBUG_VISUAL_FIELDS.map((key) => [key, state[key]])) as unknown as DebugVisualConfig
}

function visualDebugSection() {
  return {
    config: readDebugVisualConfig(),
    cardDebug: cardDebugSession,
    // 参考数据:textShadow 预设 label → value(update_state 两者都收)与两个
    // 整套预设(update_state 的 applyPreset 落点)
    textShadowPresets: TEXT_SHADOW_PRESETS.map((preset) => ({ label: preset.label, value: preset.value })),
    presets: {
      [ShowcasePreset.SHINE]: SHINE_PRESET,
      [ShowcasePreset.NATURAL]: NATURAL_PRESET,
    },
  }
}

// ─── relicsTab 段 ─────────────────────────────────────────────────────────────
//
// excludedRelicPotentialCharacters 来自 useRelicsTabStore(遗器页「潜力角色」
// 排除清单),随存档落盘(saveState.ts:78 → save.excludedRelicPotentialCharacters,
// saveSnapshot.ts:70 同链),update 走 withChange + markDirty。
// recentRelics(最近遗器折叠区的卡片数据)经核实不在 useRelicsTabStore 里,
// 而在扫描器 store(scannerStore.ts:53):uid 列表、扫描器推送驱动
// (updateInitialScan 取末 6 件倒序,updateRelic 前插,断连即清空)、
// 会话态不落盘——因此 update 侧不提供该字段(只读,由扫描器推送驱动),
// 读侧按折叠区同一算法投影(RecentRelics.tsx:23-28:ids → relicsById 解析
// → 过滤缺件,展示取前 6)。
function relicsTabSection() {
  const relicsTab = useRelicsTabStore.getState()
  const scanner = useScannerState.getState()
  const relicsById = useRelicStore.getState().relicsById
  const ids = [...scanner.recentRelics]
  const cards = ids
    .map((id) => relicsById[id])
    .filter((relic) => relic != null)
    .map((relic) => ({
      id: relic.id,
      part: relic.part,
      equippedBy: relic.equippedBy ?? null,
      enhance: relic.enhance,
    }))
  return {
    excludedRelicPotentialCharacters: [...relicsTab.excludedRelicPotentialCharacters],
    recentRelics: {
      ids,
      // 折叠区实际渲染的卡片(库存中已存在的那些;顺序与 ids 一致)
      cards,
    },
  }
}

// ─── layout (optimizer.layout.sections) ──────────────────────────────────────
// 优化器表单分区折叠状态(useOptimizerDisplayStore.menuState,FormRow 标题条
// 点击切换,optimizerMenuIds.ts 的 initialMenuState 为默认),随存档落盘
// (saveKey optimizerMenuState,saveSnapshot.ts:69 同链),update 走
// withChange + markDirty。写语义镜像 FormRow 的单键切换:patch 只需给出
// 要改的分区,其余保持当前值(整组 setMenuState 写回)。
function layoutSection() {
  return {
    menuState: { ...useOptimizerDisplayStore.getState().menuState },
    defaults: { ...initialMenuState },
  }
}

const sectionReaders: Record<GetSection, () => Record<string, unknown>> = {
  revision: revisionSection,
  settings: settingsSection,
  session: sessionSection,
  flags: flagsSection,
  scanner: scannerSection,
  showcase: showcaseSection,
  visualDebug: visualDebugSection,
  relicsTab: relicsTabSection,
  layout: layoutSection,
}

const sectionSummaries: Record<GetSection, (data: Record<string, unknown>) => string> = {
  revision: (data) => {
    const r = data as ReturnType<typeof revisionSection>
    return `修订号 revision=${r.revision},存档世代 generation=${r.generation},存档${
      r.loaded ? `已载入(${r.path ?? (r.bootLoaded ? '进程启动自动恢复,内联语义' : '内联 JSON')})` : '未载入'
    }${r.dirty ? ',有未落盘变更' : ''}${r.blockedWrite ? `,写回被拦截:${r.blockedWrite.reason}` : ''}`
  },
  settings: () => '设置已返回:每项含当前值、枚举值、上游默认值与中文说明(默认值派生自上游 DefaultSettingOptions)',
  session: (data) => {
    const s = data as ReturnType<typeof sessionSection>
    return `持久化会话字段已返回(savedSession.showcaseTab + savedSession.global,与存档落盘字段一致);defaults 为上游默认值;`
      + `ephemeral 为会话临时态,不写入存档(语言偏好 language=${s.ephemeral.language},当前渲染语言 activeLanguage=${s.ephemeral.activeLanguage})`
  },
  flags: (data) => {
    const f = data as ReturnType<typeof flagsSection>
    return `已读特性标记 ${f.seenFeatures.length} 项;当前活跃的新特性键:${f.activeNewFeatures.join(', ') || '(无)'}`
  },
  scanner: (data) => {
    const s = data as ReturnType<typeof scannerSection>
    return `扫描器配置:websocketUrl=${s.websocketUrl}${s.customUrl ? '(自定义)' : '(默认)'},ingest=${s.ingest},ingestCharacters=${s.ingestCharacters}`
      + `,ingestOnlyExistingCharacters=${s.ingestOnlyExistingCharacters},ingestWarpResources=${s.ingestWarpResources}`
  },
  showcase: (data) => {
    const s = data as ReturnType<typeof showcaseSection>
    return `已返回 ${s.count} 个角色的展示评分偏好(showcasePreferences,与存档落盘字段一致)`
  },
  visualDebug: () => '已返回视觉调试参数(19 个字段 + cardDebug;视觉调试参数为会话临时状态,上游不落盘,MCP 同语义——update 不递增 revision、不写存档)',
  relicsTab: (data) => {
    const s = data as ReturnType<typeof relicsTabSection>
    return `遗器页状态:排除潜力角色 ${s.excludedRelicPotentialCharacters.length} 名(随存档落盘),`
      + `最近遗器 ${s.recentRelics.ids.length} 个 uid/折叠区卡片 ${s.recentRelics.cards.length} 张`
      + '(recentRelics 为扫描器推送驱动的会话态,只读不落盘)'
  },
  layout: (data) => {
    const s = data as ReturnType<typeof layoutSection>
    const collapsed = Object.entries(s.menuState).filter(([, open]) => !open).map(([id]) => id)
    return `优化器表单分区折叠状态已返回(随存档落盘):当前折叠 ${
      collapsed.length ? collapsed.join('、') : '(无,全部展开)'
    };defaults 为上游默认(自定义属性模拟折叠,其余展开)`
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
  bootLoaded: z.boolean().describe('当前存档是否来自进程启动时的自动恢复(状态文件后端;此时 path 为 null)'),
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
    language: z.string().describe('语言偏好(上游 LanguageDetector 缓存键 i18nextLng 的值,不在存档里)'),
    activeLanguage: z.string().describe('本进程当前实际渲染语言(ensureI18nReady 固定 zh_CN,写 language 不改变它)'),
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

const showcaseSectionSchema = z.object({
  preferences: z.record(z.string(), z.unknown()),
  count: z.number().int(),
})

const debugVisualConfigSchema = z.object({
  portraitBlur: z.number(),
  portraitBrightness: z.number(),
  portraitSaturate: z.number(),
  portraitContrast: z.number(),
  cardBgAlpha: z.number(),
  debugMaxC: z.number(),
  debugMinC: z.number(),
  debugChromaScale: z.number(),
  debugTargetL: z.number(),
  debugMinL: z.number(),
  debugMaxL: z.number(),
  blendMode: z.enum(['screen', 'normal']),
  shadowX: z.number(),
  shadowY: z.number(),
  shadowBlur: z.number(),
  shadowOpacity: z.number(),
  insetBlur: z.number(),
  insetOpacity: z.number(),
  textShadow: z.string(),
})

const visualDebugSectionSchema = z.object({
  config: debugVisualConfigSchema,
  cardDebug: z.boolean().describe('调试面板开关(Node 会话变量,镜像 globalThis.CARD_DEBUG;渲染任务经 taskGlobals 传给页面)'),
  textShadowPresets: z.array(z.object({ label: z.string(), value: z.string() })),
  presets: z.object({
    shine: debugVisualConfigSchema,
    natural: debugVisualConfigSchema,
  }),
})

const relicsTabSectionSchema = z.object({
  excludedRelicPotentialCharacters: z.array(z.string()),
  recentRelics: z.object({
    ids: z.array(z.string()),
    cards: z.array(z.object({
      id: z.string(),
      part: z.string(),
      equippedBy: z.string().nullable(),
      enhance: z.number().int(),
    })),
  }),
})

const layoutSectionSchema = z.object({
  menuState: z.record(z.string(), z.boolean()),
  defaults: z.record(z.string(), z.boolean()),
})

const sectionEchoSchemas = {
  settings: settingsSectionSchema.optional(),
  session: sessionSectionSchema.optional(),
  flags: flagsSectionSchema.optional(),
  scanner: scannerSectionSchema.optional(),
  showcase: showcaseSectionSchema.optional(),
  visualDebug: visualDebugSectionSchema.optional(),
  relicsTab: relicsTabSectionSchema.optional(),
  layout: layoutSectionSchema.optional(),
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
// `language` 是 MCP 侧新增的会话键:上游语言偏好不在 GlobalSavedSession 里(由
// i18next LanguageDetector 缓存在 localStorage['i18nextLng']),见文件头部查证注释。
type SessionFieldKey = keyof GlobalSavedSession | keyof ShowcaseTabSavedSession | 'language'
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
  language: {
    schema: z.enum(COMPLETED_LOCALES),
    expected: `语言 locale 枚举:${COMPLETED_LOCALES.join(' | ')}(上游正式站 completedLocales;测试站专属的 de_DE/it_IT/tr_TR/zh_TW/aa_ER 不支持)`,
  },
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

// showcase 段写的是「单个角色的展示偏好」(editShowcasePreferences,定制侧栏
// 取色器/配色模式下拉与组队面板槽位卡「基准」下拉共用):patch 必须携带
// characterId + 至少一个要写的字段(scoringType/color/colorMode),见
// validatePatch 的附加校验。网页侧颜色均为 hex(取色器产出、DEFAULT_SHOWCASE_
// COLOR=#2473e1、STANDARD_COLOR=#647bb0),故 color 按 hex 校验。
const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const showcaseFieldSpecs = {
  characterId: {
    schema: z.string().min(1),
    expected: '角色 id 字符串(必须存在于游戏元数据,如 "1212b1")',
  },
  scoringType: {
    schema: z.nativeEnum(ScoringType),
    expected: '评分类型枚举:0=DPS_SCORE,1=SUBSTAT_SCORE,2=NONE,3=BUFFER_SCORE,4=HEAL_SCORE,5=SHIELD_SCORE',
  },
  color: {
    schema: z.string().regex(HEX_COLOR_REGEX),
    expected:
      `hex 颜色字符串(如 "#2473e1",支持 #RGB/#RRGGBB;上游取色器只产出 hex)。注意:等于上游默认展示色 ${DEFAULT_SHOWCASE_COLOR} 时网页取色器视为无操作不写偏好,MCP 同语义报错——回自动配色请写 colorMode="AUTO"`,
  },
  colorMode: {
    schema: z.nativeEnum(ShowcaseColorMode),
    expected:
      '配色模式枚举(上游 ShowcaseColorMode):"AUTO"(从肖像提取色) | "CUSTOM"(用该角色存的 color) | "STANDARD"(全局标准蓝,联动全局 showcaseStandardMode=true)',
  },
} satisfies Record<string, FieldSpec>

// visualDebug 段写的是「视觉调试参数」(useDebugVisualConfigStore 的会话态
// store):数值字段的范围以上游组件/预设值为准——上游没有为这些字段提供
// 输入组件约束(调试面板已收进 CARD_DEBUG 分支),故按 CSS/色彩管线语义
// 给常识范围并在 expected 写明:CSS 乘数(亮度/饱和/对比)非负,不透明度
// 与 alpha 类 0–1,模糊半径非负,阴影位移可为负,色彩管线(lightness/chroma)
// 非负。blendMode/textShadow 为枚举/预设映射 + 原始字符串。
const nonNegativeFinite = z.number().finite().min(0)
const unitFraction = z.number().finite().min(0).max(1)
const finiteNumber = z.number().finite()

const visualDebugFieldSpecs = {
  portraitBlur: { schema: nonNegativeFinite, expected: '非负有限数(肖像背景模糊半径,px;上游默认 40)' },
  portraitBrightness: { schema: nonNegativeFinite, expected: '非负有限数(肖像背景亮度,CSS 乘数;上游 Matte 默认 0.10)' },
  portraitSaturate: { schema: nonNegativeFinite, expected: '非负有限数(肖像背景饱和度,CSS 乘数;上游 Matte 默认 2.00)' },
  portraitContrast: { schema: nonNegativeFinite, expected: '非负有限数(肖像背景对比度,CSS 乘数;上游 Matte 默认 1.25)' },
  cardBgAlpha: { schema: unitFraction, expected: '0–1 有限数(卡面底色 alpha;上游默认 0.40)' },
  debugMaxC: { schema: nonNegativeFinite, expected: '非负有限数(卡底色阶 chroma 上限;上游默认 0.120)' },
  debugMinC: { schema: nonNegativeFinite, expected: '非负有限数(卡底色阶 chroma 下限;上游默认 0.010)' },
  debugChromaScale: { schema: nonNegativeFinite, expected: '非负有限数(卡底色阶 chroma 缩放;上游默认 1.20)' },
  debugTargetL: { schema: unitFraction, expected: '0–1 有限数(卡底目标 lightness;上游默认 0.50)' },
  debugMinL: { schema: unitFraction, expected: '0–1 有限数(卡底 lightness 下限;上游默认 0.05)' },
  debugMaxL: { schema: unitFraction, expected: '0–1 有限数(卡底 lightness 上限;上游默认 0.70)' },
  blendMode: {
    schema: z.enum(['screen', 'normal'] as const),
    expected: '混合模式枚举:"screen" | "normal"(上游 BlendMode;默认 normal)',
  },
  shadowX: { schema: finiteNumber, expected: '有限数(外阴影 X 位移 px,可为负)' },
  shadowY: { schema: finiteNumber, expected: '有限数(外阴影 Y 位移 px,可为负)' },
  shadowBlur: { schema: nonNegativeFinite, expected: '非负有限数(外阴影模糊半径 px)' },
  shadowOpacity: { schema: unitFraction, expected: '0–1 有限数(外阴影不透明度)' },
  insetBlur: { schema: nonNegativeFinite, expected: '非负有限数(内发光模糊半径 px)' },
  insetOpacity: { schema: unitFraction, expected: '0–1 有限数(内发光不透明度)' },
  textShadow: {
    schema: z.string().min(1),
    expected: `预设 label(${TEXT_SHADOW_PRESETS.map((preset) => preset.label).join(' / ')},命中即映射为对应 CSS 值)或原始 CSS text-shadow 字符串`,
  },
  cardDebug: booleanSpec('布尔(调试面板开关,Node 会话变量;渲染任务经 taskGlobals 传给页面)'),
  applyPreset: {
    schema: z.enum([ShowcasePreset.SHINE, ShowcasePreset.NATURAL] as const),
    expected: `整套预设枚举:"${ShowcasePreset.SHINE}" | "${ShowcasePreset.NATURAL}"(一次性覆盖全部 19 个字段)`,
  },
  reset: { schema: z.literal(true), expected: 'true(恢复全部视觉调试默认值)' },
} satisfies Record<string, FieldSpec>

// relicsTab 段:excludedRelicPotentialCharacters 随存档落盘(saveState.ts:78),
// 角色 id 校验同 showcase 段(必须在游戏元数据中)。recentRelics 是扫描器
// 推送驱动的会话态(scannerStore.ts:53),刻意不提供写入口——传它会被
// 未知字段校验拦下并列出合法键。
const relicsTabFieldSpecs = {
  excludedRelicPotentialCharacters: {
    schema: z.array(z.string().min(1)),
    expected: '角色 id 字符串数组,整组替换潜力评分排除清单(每个 id 必须存在于游戏元数据)',
  },
} satisfies Record<string, FieldSpec>

// layout 段:menuState 是「分区 id → 是否展开」的部分覆盖(分区 id 即上游
// OptimizerMenuIds 的五个英文标题键),其余分区保持当前值;随存档落盘。
const MENU_STATE_EXPECTED = `「分区 id → 布尔(是否展开)」对象,只需给出要改的分区,合法分区 id:${
  Object.values(OptimizerMenuIds).map((id) => `"${id}"`).join(', ')
}`
const layoutFieldSpecs = {
  menuState: {
    schema: z.object(
      Object.fromEntries(Object.values(OptimizerMenuIds).map((id) => [id, z.boolean().optional()])),
    ).strict(),
    expected: MENU_STATE_EXPECTED,
  },
} satisfies Record<string, FieldSpec>

const sectionFieldSpecs: Record<UpdateSection, Record<string, FieldSpec>> = {
  settings: settingsFieldSpecs,
  session: sessionFieldSpecs,
  flags: flagsFieldSpecs,
  scanner: scannerFieldSpecs,
  showcase: showcaseFieldSpecs,
  visualDebug: visualDebugFieldSpecs,
  relicsTab: relicsTabFieldSpecs,
  layout: layoutFieldSpecs,
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
  // showcase 段的 patch 是「单角色偏好」:必须提供 characterId(characterId
  // 单独出现没有意义)与至少一个要写的字段(scoringType/color/colorMode);
  // characterId 必须存在于游戏元数据。
  if (section === 'showcase') {
    const hasWritableField = patch['scoringType'] != null || patch['color'] != null || patch['colorMode'] != null
    if (patch['characterId'] == null || !hasWritableField) {
      throw new Error(
        `update_state(section=showcase): patch 必须提供 characterId,且至少一个要写的字段(scoringType/color/colorMode) — 该段写单个角色的展示偏好(定制侧栏取色器/配色模式,与组队面板槽位卡「基准」下拉共用)`,
      )
    }
    const showcaseId = patch['characterId'] as string
    if (!getGameMetadata().characters[showcaseId as CharacterId]) {
      throw new Error(
        `update_state(section=showcase): 字段 characterId 的值 "${showcaseId}" 不在游戏元数据中 — 请使用有效的角色 id`,
      )
    }
    // 网页取色器对默认展示色视为「无自定义颜色」不落偏好(ShowcaseCustomization-
    // Sidebar.tsx onColorChangeEnd:newColor === DEFAULT_SHOWCASE_COLOR 直接 return);
    // MCP 侧同一约束显式报错更可操作(同 patch 显式给了 colorMode 则不在该拦截内,
    // 对应下拉+存量色板的组合语义)。
    if (patch['color'] === DEFAULT_SHOWCASE_COLOR && patch['colorMode'] == null) {
      throw new Error(
        `update_state(section=showcase): color 等于上游默认展示色 ${DEFAULT_SHOWCASE_COLOR} — 网页取色器对该值视为无操作、不写入偏好;如需回到自动配色请写 colorMode="AUTO"`,
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
  // relicsTab 段的排除清单:逐 id 校验游戏元数据(口径同 showcase 段)
  if (section === 'relicsTab' && patch['excludedRelicPotentialCharacters'] != null) {
    const ids = patch['excludedRelicPotentialCharacters'] as string[]
    const invalid = ids.filter((id) => !getGameMetadata().characters[id as CharacterId])
    if (invalid.length > 0) {
      throw new Error(
        `update_state(section=relicsTab): excludedRelicPotentialCharacters 含不在游戏元数据中的角色 id:${
          invalid.map((id) => `"${id}"`).join(', ')
        } — 请使用有效的角色 id`,
      )
    }
  }
  // visualDebug 的三个动作键互斥语义靠 applyPreset/reset 的 zod 校验兜底;
  // 字段本身的范围/枚举校验已由 specs 完成,无需附加规则。
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
      // language 走单独通道:镜像 i18next-browser-languagedetector 的
      // cacheUserLanguage(语言切换后 detector 写 localStorage['i18nextLng'])——
      // 只写缓存键,不进 savedSession(上游存档不含该字段),也不调用
      // i18next.changeLanguage(本进程渲染语言固定 zh_CN,切不切由调用方进程
      // 决定)。持久化由 localStorage shim 的文件后端完成,markDirty 已由
      // update_state 的 withChange 统一负责。
      if (patch['language'] != null) {
        localStorage.setItem(I18NEXT_LOOKUP_KEY, String(patch['language']))
      }
      // global 走 useGlobalStore.setSavedSession(上游载入/引擎切换同款完整对象语义),
      // showcaseTab 走 useShowcaseTabStore.setSavedSession(上游部分合并语义)。
      const restPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'language'))
      const globalPatch = Object.fromEntries(Object.entries(restPatch).filter(([key]) => !showcaseTabSessionKeys.has(key))) as Partial<GlobalSavedSession>
      const showcasePatch = Object.fromEntries(Object.entries(restPatch).filter(([key]) => showcaseTabSessionKeys.has(key))) as Partial<ShowcaseTabSavedSession>
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
      // fire even after a rolled-back transaction. Since M6 the socket CAN be
      // connected (scanner action=connect), so the setters' re-import branches
      // are no longer dormant — replayScannerSettings reproduces them below
      // (scannerStore.ts:164-228 semantics) without the stray timer.
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
    case 'showcase': {
      // editShowcasePreferences(ShowcaseCustomizationSidebar 的取色器/配色模式
      // 下拉与组队面板「基准」下拉共用路径):按角色浅合并偏好,colorMode 非
      // null 时联动全局 showcaseStandardMode(= 是否 STANDARD),最后
      // SaveState.delayedSave(MCP 侧由 update_state 的事务路径统一负责落盘)。
      // 网页取色器落色总是成对传 { color, colorMode: CUSTOM }
      // (onColorChangeEnd/onKeyDown,ShowcaseCustomizationSidebar.tsx),MCP 侧
      // 只给 color 时补同样的 colorMode=CUSTOM;只给 colorMode 对应下拉语义。
      const changed: { scoringType?: number, color?: string, colorMode?: ShowcaseColorMode } = {}
      if (patch['scoringType'] != null) changed.scoringType = patch['scoringType'] as number
      if (patch['color'] != null) {
        changed.color = patch['color'] as string
        if (patch['colorMode'] == null) changed.colorMode = ShowcaseColorMode.CUSTOM
      }
      if (patch['colorMode'] != null) changed.colorMode = patch['colorMode'] as ShowcaseColorMode
      editShowcasePreferences(patch['characterId'] as CharacterId, changed)
      return
    }
    case 'visualDebug': {
      // 会话临时态(上游不落盘):不走 withChange/markDirty,调用方
      // (update_state 的 visualDebug 分支)直接同步执行本函数。reset 先于
      // 其他键生效,applyPreset 随后可再覆盖个别字段(与逐字段 set 等价:
      // 上游 store 的 setter 也只是 set({key: value}))。
      if (patch['reset'] === true) {
        const initial = useDebugVisualConfigStore.getInitialState()
        useDebugVisualConfigStore.setState(
          Object.fromEntries(DEBUG_VISUAL_FIELDS.map((key) => [key, initial[key]])) as Partial<DebugVisualConfig>,
        )
      }
      if (patch['applyPreset'] === ShowcasePreset.SHINE) {
        useDebugVisualConfigStore.getState().applyPreset(SHINE_PRESET)
      } else if (patch['applyPreset'] === ShowcasePreset.NATURAL) {
        useDebugVisualConfigStore.getState().applyPreset(NATURAL_PRESET)
      }
      if (patch['cardDebug'] != null) {
        cardDebugSession = patch['cardDebug'] as boolean
      }
      const configPatch: Partial<DebugVisualConfig> = {}
      let hasConfigPatch = false
      for (const key of DEBUG_VISUAL_FIELDS) {
        if (!(key in patch)) continue
        hasConfigPatch = true
        if (key === 'textShadow') {
          // 预设 label → CSS 值映射;非 label 的字符串按原始 CSS 值透传
          const raw = patch[key] as string
          const preset = TEXT_SHADOW_PRESETS.find((candidate) => candidate.label === raw)
          configPatch[key] = preset != null ? preset.value : raw
        } else {
          ;(configPatch as Record<string, unknown>)[key] = patch[key]
        }
      }
      if (hasConfigPatch) useDebugVisualConfigStore.setState(configPatch)
      return
    }
    case 'relicsTab': {
      // 上游 setter(setExcludedRelicPotentialCharacters)整组替换 + 克隆;
      // 该字段随存档落盘,markDirty 由 update_state 的事务路径统一负责。
      useRelicsTabStore.getState().setExcludedRelicPotentialCharacters(
        patch['excludedRelicPotentialCharacters'] as CharacterId[],
      )
      return
    }
    case 'layout': {
      // FormRow 单键切换的批量形态:当前值居中 + patch 覆盖后整组 setMenuState;
      // 随存档落盘(saveKey optimizerMenuState),markDirty 由事务路径统一负责。
      const current = useOptimizerDisplayStore.getState().menuState
      const changed = patch['menuState'] as Record<string, boolean>
      useOptimizerDisplayStore.getState().setMenuState({ ...current, ...changed })
      return
    }
  }
}

// ─── tool registration ───────────────────────────────────────────────────────

export function registerStateTools(server: McpServer): void {
  server.registerTool('get_state', {
    title: '读取状态域',
    description: '读取服务器状态与配置域的当前值——对应网页端设置抽屉/侧栏/扫描器设置等持久化状态。'
      + 'section=revision:变更修订号与存档概况(loaded/path/dirty/revision/generation/blockedWrite/bootLoaded,口径同 save_status;bootLoaded=存档来自进程启动时的自动恢复);'
      + 'section=settings:六项用户设置 + 每项定义(枚举值/上游默认值/中文说明);'
      + 'section=session:存档真正落盘的会话字段(savedSession:showcaseTab + global,含 sidebarCollapsed 等)与上游默认值,'
      + 'ephemeral 子对象为会话临时态(不写入存档),其中 language=语言偏好(上游经 i18next LanguageDetector 缓存在'
      + ' localStorage 键「i18nextLng」,不在存档里),activeLanguage=本进程当前实际渲染语言(MCP 固定 zh_CN);'
      + 'section=flags:已读特性标记 seenFeatures 数组(附当前活跃的新特性键);'
      + 'section=scanner:扫描器接入配置六字段(ingest/ingestCharacters/ingestOnlyExistingCharacters/ingestWarpResources/websocketUrl/customUrl);'
      + 'section=showcase:各角色的展示偏好 showcasePreferences(含 scoringType 评分类型与 color/colorMode 展示配色,角色页展示卡与组队面板槽位卡共用,随存档落盘);'
      + 'section=visualDebug:视觉调试参数(19 个字段 + cardDebug 调试面板开关 + textShadow 预设表/整套预设参考值;会话临时状态,上游不落盘,MCP 同语义);'
      + 'section=relicsTab:遗器页状态(excludedRelicPotentialCharacters 潜力评分排除清单,随存档落盘;recentRelics 最近遗器折叠区的 uid 顺序与卡片投影,扫描器推送驱动的只读会话态);'
      + 'section=layout:优化器表单分区折叠状态(menuState,分区 id → 是否展开,随存档落盘)。'
      + '只读无副作用,不递增 revision。',
    inputSchema: {
      section: z.enum(GET_SECTIONS).describe(
        '要读取的状态域:revision=修订与存档概况,settings=用户设置,session=持久化会话字段,flags=已读特性标记,scanner=扫描器接入配置,showcase=角色展示评分偏好,visualDebug=视觉调试参数(会话态),relicsTab=遗器页状态,layout=优化器表单分区折叠状态',
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
      + 'settings/session/scanner 按字段覆盖合并(未提及字段保持不变),flags 的 seenFeatures 为整组替换,'
      + 'showcase 写单角色展示偏好(patch 必须提供 characterId 与至少一个要写的字段:scoringType 评分类型对应组队面板槽位卡「基准」下拉,'
      + 'color(hex)/colorMode(AUTO/CUSTOM/STANDARD)对应展示定制侧栏的取色器与配色模式——逐字镜像 editShowcasePreferences:'
      + '只给 color 时按网页取色器联动补 colorMode=CUSTOM,colorMode 非 null 时联动全局 showcaseStandardMode=是否 STANDARD)。'
      + 'session.language 写语言偏好(枚举 en_US/es_ES/fr_FR/ja_JP/ko_KR/pt_BR/ru_RU/vi_VN/zh_CN):镜像网页端语言下拉经 '
      + 'i18next LanguageDetector 的缓存行为,只更新 localStorage 键「i18nextLng」(不在存档里,由 shim 的文件后端跨进程持久化),'
      + '本进程已初始化的 i18n 语言不因此切换——ensureI18nReady 固定 zh_CN,是否按该偏好切换由调用方进程决定;'
      + '可选 baseRevision 做乐观并发检查:与当前修订号不一致即报冲突(消息含两个修订号),需重读状态后重试。'
      + '变更经事务协调器提交:任一步失败整体回滚;成功后标记 dirty、revision 递增,由防抖写回落盘。'
      + 'visualDebug 段例外:视觉调试参数为会话临时状态,上游不落盘,MCP 同语义——update 不要求已载入存档、'
      + '不走事务/markDirty、revision 保持不变(baseRevision 若提供仍做纯检查);可写 19 个数值/枚举字段'
      + '(数值范围:alpha 与不透明度类 0–1,模糊半径与 CSS 乘数类非负,阴影位移可为负)、cardDebug 布尔、'
      + 'applyPreset(shine/natural 整套预设)与 reset(true 恢复默认);textShadow 收预设 label(命中映射为对应 CSS 值)或原始 CSS 字符串。'
      + 'relicsTab 段:excludedRelicPotentialCharacters 整组替换(角色 id 须在游戏元数据中,随存档落盘);'
      + 'recentRelics 只读(扫描器推送驱动),不提供写入口。'
      + '注意:revision 域只读不可写(枚举里没有它);scanner.customUrl 是派生标记——置 false 会把地址重置为默认,置 true 需同时在 patch 中提供自定义 websocketUrl。',
    inputSchema: {
      section: z.enum(UPDATE_SECTIONS).describe('要更新的状态域:settings/session/flags/scanner/showcase/visualDebug/relicsTab/layout(revision 只读,不在此列)'),
      patch: z.record(z.string(), z.unknown()).describe('字段 patch 对象:键为该 section 的已知字段,值为新值(合法字段与枚举见 get_state 对应 section 的返回)'),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突,需重读后重试'),
    },
    outputSchema: {
      updated: z.boolean(),
      replayed: z.array(z.string()).optional().describe('scanner 段专用:设置变更触发的网页端重放动作(reimport=重放完整导入,warp-re-emit=重发跃迁资源)'),
      section: z.enum(UPDATE_SECTIONS),
      revision: z.number().int(),
      dirty: z.boolean(),
      ...sectionEchoSchemas,
    },
  }, async ({ section, patch, baseRevision }) => {
    runtimeContext.ensureMetadataReady()

    // visualDebug 是会话临时态(上游不落盘):不走事务协调器——不要求已载入
    // 存档、不 markDirty、revision 保持不变;baseRevision 若提供仍做冲突检查
    // (纯检查,无回滚需求:本分支没有可回滚的持久化副作用)。
    if (section === 'visualDebug') {
      validatePatch(section, patch)
      if (baseRevision != null) runtimeContext.requireRevision(baseRevision, 'update_state')
      applyPatch(section, patch)
      const payload: Record<string, unknown> = {
        updated: true,
        section,
        revision: runtimeContext.getRevision(),
        dirty: runtimeContext.isDirty(),
      }
      payload[section] = sectionReaders[section]()
      return toolResult(
        payload,
        `已更新 visualDebug(字段:${Object.keys(patch).join(', ')})——会话临时状态,不落盘、revision 不变(${runtimeContext.getRevision()})`,
      )
    }

    runtimeContext.requireSave()
    validatePatch(section, patch)

    // baseRevision is checked INSIDE the scope (after earlier-queued changes
    // landed) so a same-batch write cannot slip past the conflict gate.
    await runtimeContext.withChange('update_state', () => {
      applyPatch(section, patch)
      runtimeContext.markDirty()
    }, baseRevision != null ? { baseRevision } : {})

    // 网页 setter 的重放语义(scannerStore.ts:164-228):已连接时打开 ingest/
    // 角色开关 → 用当前扫描缓存重放一次完整导入;打开 ingestWarpResources →
    // 重发资源事件(再同步一次跃迁底稿)。设置先落地,重放是其服务端后续。
    const replayed = section === 'scanner' ? await replayScannerSettings(Object.keys(patch)) : []

    const revision = runtimeContext.getRevision()
    const payload: Record<string, unknown> = {
      updated: true,
      section,
      revision,
      dirty: true,
      ...(replayed.length > 0 ? { replayed } : {}),
    }
    payload[section] = sectionReaders[section]()
    return toolResult(
      payload,
      `已更新 ${section}(字段:${Object.keys(patch).join(', ')}),revision=${revision},变更已标记待防抖写回`
        + (replayed.length > 0 ? `;已按网页端语义重放:${replayed.join('、')}` : ''),
    )
  })
}
