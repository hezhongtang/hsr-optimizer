// Optimizer form domain (M5-B): update_form — the persistent write path for
// the OptimizerTab form, plus serializers shared with the query domain.
//
// The web keeps the working form in useOptimizerRequestStore and writes it back
// to characters[].form at trigger points (start/equip/character switch/combo
// drawer close/stat-sim save — optimizer.form.persist). This server is
// headless, so update_form models ONE trigger point per call:
//
//   1. re-establish the store invariant the upstream switch path relies on
//      (the scratchpad holds the session character's saved form),
//   2. switchToCharacter(target) when a characterId is passed — the real
//      upstream entry (sync outgoing form → computeLoadForm merge → rank sync
//      → session key), never a bare pointer move,
//   3. apply the requested edits through the upstream store actions /
//      services (applySpdPreset, resetFilters, deserializeBuild,
//      handleConditionalChange, updateTeammate, the combo drawer actions),
//   4. persist displayToInternal(store) back over the character's saved form
//      with the exact merge shape of syncFormToCharacterStore
//      ({ ...found.form, ...form }).
//
// Everything runs inside runtimeContext.withChange so a failure midway (e.g.
// saving character A then failing to load B) rolls the character store back
// instead of leaving a chimera.
//
// update_form vs optimize(formOverrides): formOverrides is a per-run temporary
// overlay merged onto the saved form for that single call and never persisted;
// update_form writes the character's PERSISTED form (characters[].form), so
// the change survives into later optimize/simulate_build/get_form calls and
// the web UI.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import i18next from 'i18next'
import { applySpdPreset } from 'lib/conditionals/evaluation/applyPresets'
import { CharacterConditionalsResolver } from 'lib/conditionals/resolver/characterConditionalsResolver'
import {
  CombatBuffs,
  PartsMainStats,
  SubStats,
} from 'lib/constants/constants'
import { generateSpdPresets } from 'lib/constants/spdPresetConfig'
import { initializeComboState } from 'lib/optimization/combo/comboInitializers'
import { getDefaultForm } from 'lib/optimization/defaultForm'
import {
  AbilityNameToTurnAbility,
  NULL_TURN_ABILITY_NAME,
} from 'lib/optimization/rotation/turnAbilityConfig'
import type { TurnAbilityName } from 'lib/optimization/rotation/turnAbilityConfig'
import { SortOption } from 'lib/optimization/sortOptions'
import { deserializeBuild } from 'lib/services/buildConverter'
import {
  SetsOrnamentsNames,
  SetsRelicsNames,
} from 'lib/sets/setConfigRegistry'
import { StatSimTypes } from 'lib/simulations/statSimulationTypes'
import type {
  Simulation,
  SimulationRequest,
} from 'lib/simulations/statSimulationTypes'
import { blankSimRequest } from 'lib/simulations/utils/requestUtils'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { useGlobalStore } from 'lib/stores/app/appStore'
import {
  getCharacterById,
  getCharacters,
  useCharacterStore,
} from 'lib/stores/character/characterStore'
import { displayToInternal } from 'lib/stores/optimizerForm/optimizerFormConversions'
import {
  computeLoadForm,
  resolveLcDefaults,
} from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import type {
  OptimizerRequestState,
  TeammateState,
} from 'lib/stores/optimizerForm/optimizerFormTypes'
import { useOptimizerRequestStore } from 'lib/stores/optimizerForm/useOptimizerRequestStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import {
  flushComboDrawerToForm,
  persistSelectedSets,
} from 'lib/tabs/tabOptimizer/combo/comboDrawerService'
import { resolveSourceKeyRoute } from 'lib/tabs/tabOptimizer/combo/comboDrawerUtils'
import {
  locateConditional,
  useComboDrawerStore,
} from 'lib/tabs/tabOptimizer/combo/useComboDrawerStore'
import { updateTeammate } from 'lib/tabs/tabOptimizer/optimizerForm/components/teammate/updateTeammate'
import {
  handleConditionalChange,
  switchToCharacter,
} from 'lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions'
import { uuid } from 'lib/utils/miscUtils'
import { objectHash } from 'lib/utils/objectUtils'
import type { CharacterId } from 'types/character'
import type { Form } from 'types/form'
import type { LightConeId } from 'types/lightCone'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { applyFormOverrides } from '../permutations'
import { toolResult } from '../toolResult'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

// ─── combo matrix serialization (shared with get_form(expandCombo=true)) ─────

export type SerializedComboConditional = {
  id: string,
  type: 'boolean' | 'number' | 'select',
  /** 默认值:布尔取 activations[0],数值/选择取 partitions[0].value */
  defaultValue: boolean | number,
  /** 布尔型:每个技能位是否生效(下标 0 为默认段,对应 turnAbilities 下标) */
  activations?: boolean[],
  /** 数值/选择型:分段取值与各自生效的技能位 */
  partitions?: Array<{ value: number, activations: boolean[] }>,
}

export type SerializedComboEntity = {
  /** 连招矩阵定位键,update_form(combo.edits[].target) 使用同一套键 */
  sourceKey: string,
  role: 'character' | 'lightCone' | 'set' | 'teammate-character' | 'teammate-lightCone' | 'teammate-relicSet' | 'teammate-ornamentSet',
  /** 该实体对应的人物(主角色或队友位) */
  characterId: string | null,
  name: string | null,
  conditionals: SerializedComboConditional[],
}

export type SerializedComboMatrix = {
  comboType: 'simple' | 'advanced',
  preprocessor: boolean,
  version: string | null,
  /** 连招技能序列(下标 0 为起手占位 NULL) */
  turnAbilities: string[],
  entities: SerializedComboEntity[],
  /** 参与逐技能矩阵显示的套装行(comboCharacter.displayedRelicSets/…) */
  displayedSets: { relics: string[], ornaments: string[] },
  stateJsonBytes: number,
}

type ComboEntityBucket = {
  sourceKey: string,
  role: SerializedComboEntity['role'],
  characterId: string | null,
  conditionals: Record<string, Any> | undefined,
}

function serializeConditional(id: string, conditional: Any): SerializedComboConditional {
  // 稀疏数组容错:历史状态可能因越界编辑留有 null 洞(输出 schema 只收 boolean),
  // 序列化时截断到首个洞并过滤 null,让读取通道不因存量脏状态整体报错
  const denseActivations = (activations: unknown[] | undefined): boolean[] => {
    const list = [...(activations ?? [])]
    const firstHole = list.findIndex((value) => value == null)
    return (firstHole === -1 ? list : list.slice(0, firstHole)).map((value) => value === true)
  }
  if (conditional.type === 'boolean') {
    return {
      id,
      type: 'boolean',
      defaultValue: conditional.activations?.[0] === true,
      activations: denseActivations(conditional.activations),
    }
  }
  return {
    id,
    type: conditional.type === 'select' ? 'select' : 'number',
    defaultValue: conditional.partitions?.[0]?.value ?? 0,
    partitions: (conditional.partitions ?? []).map((partition: Any) => ({
      value: partition.value,
      activations: denseActivations(partition.activations),
    })),
  }
}

/**
 * Expand a form's comboStateJson into the "conditional × ability" matrix the
 * combo drawer renders. Same round trip the drawer performs on open:
 * initializeComboState(form, merge=true) — saved per-turn activations are
 * merged under the current conditional definitions.
 */
export function expandComboMatrix(form: Form): SerializedComboMatrix {
  const comboState = initializeComboState(form as Any, true)
  const entityName = (characterId: string | null | undefined) => {
    if (!characterId) return null
    return getGameMetadata().characters[characterId as CharacterId]?.name ?? null
  }

  const buckets: ComboEntityBucket[] = []
  const character = comboState.comboCharacter
  if (character) {
    buckets.push(
      { sourceKey: 'comboCharacter', role: 'character', characterId: character.metadata?.characterId ?? null, conditionals: character.characterConditionals },
      {
        sourceKey: 'comboCharacterLightCone',
        role: 'lightCone',
        characterId: character.metadata?.characterId ?? null,
        conditionals: character.lightConeConditionals,
      },
      { sourceKey: 'comboCharacterRelicSets', role: 'set', characterId: character.metadata?.characterId ?? null, conditionals: character.setConditionals },
    )
  }
  const teammateRoles: Array<[string, SerializedComboEntity['role'], string]> = [
    ['characterConditionals', 'teammate-character', ''],
    ['lightConeConditionals', 'teammate-lightCone', 'LightCone'],
    ['relicSetConditionals', 'teammate-relicSet', 'RelicSet'],
    ['ornamentSetConditionals', 'teammate-ornamentSet', 'OrnamentSet'],
  ]
  for (const teammateIndex of [0, 1, 2] as const) {
    const teammate = (comboState as Any)[`comboTeammate${teammateIndex}`]
    if (!teammate) continue
    for (const [conditionalsKey, role, suffix] of teammateRoles) {
      buckets.push({
        sourceKey: `comboTeammate${teammateIndex}${suffix}`,
        role,
        characterId: teammate.metadata?.characterId ?? null,
        conditionals: teammate[conditionalsKey],
      })
    }
  }

  const entities: SerializedComboEntity[] = []
  for (const bucket of buckets) {
    const conditionals = bucket.conditionals ?? {}
    const serialized = Object.entries(conditionals)
      .filter(([, conditional]) => conditional != null && typeof conditional === 'object')
      .map(([id, conditional]) => serializeConditional(id, conditional))
    if (serialized.length > 0) {
      entities.push({
        sourceKey: bucket.sourceKey,
        role: bucket.role,
        characterId: bucket.characterId,
        name: entityName(bucket.characterId),
        conditionals: serialized,
      })
    }
  }

  return {
    comboType: form.comboType === 'advanced' ? 'advanced' : 'simple',
    preprocessor: form.comboPreprocessor !== false,
    version: comboState.version ?? null,
    turnAbilities: [...(comboState.comboTurnAbilities ?? [])],
    entities,
    displayedSets: {
      relics: [...(character?.displayedRelicSets ?? [])],
      ornaments: [...(character?.displayedOrnamentSets ?? [])],
    },
    stateJsonBytes: form.comboStateJson?.length ?? 0,
  }
}

// ─── spd preset catalog (shared with default_form(spdPreset)) ────────────────

/** 速度档位全集(值域与网页端推荐预设下拉一致;0 = 不限速,对应主按钮)。 */
export function spdPresetCatalog(): {
  values: number[],
  presets: Array<{ key: string, label: string, value: number, category: string }>,
} {
  ensureI18nReady()
  const t = i18next.getFixedT(null, 'optimizerTab', 'Presets')
  const { categories, allPresets } = generateSpdPresets(t as Any)
  const categoryOf = new Map<string, string>()
  for (const category of categories) {
    for (const preset of Object.values(category.presets)) categoryOf.set(preset.key, category.label)
  }
  const values = new Set<number>([0])
  const presets: Array<{ key: string, label: string, value: number, category: string }> = []
  for (const preset of Object.values(allPresets)) {
    // SPD0(不限速)value 为 undefined,与 0 等价
    const value = preset.value ?? 0
    values.add(value)
    presets.push({ key: preset.key, label: preset.label, value, category: categoryOf.get(preset.key) ?? '' })
  }
  return { values: [...values], presets }
}

// ─── patch field specs (legal internal-Form keys + per-field validation) ─────

type FieldSpec = {
  schema: z.ZodTypeAny,
  /** 中文期望说明,直接进错误消息 */
  expected: string,
}

const RESULT_SORT_KEYS = Object.keys(SortOption) as [string, ...string[]]
const SUBSTAT_KEYS = [...SubStats, 'minWeightedRolls'] as string[]
const LEGACY_WEIGHT_KEYS = new Set(['topPercent'])
const COMBAT_BUFF_KEYS: string[] = Object.values(CombatBuffs).map((buff) => buff.key)
const RELIC_SET_NAMES = new Set<string>(SetsRelicsNames)
const ORNAMENT_SET_NAMES = new Set<string>(SetsOrnamentsNames)
const MAIN_PART_KEYS = ['mainHead', 'mainHands', 'mainBody', 'mainFeet', 'mainPlanarSphere', 'mainLinkRope'] as const

const booleanField = (expected: string): FieldSpec => ({ schema: z.boolean(), expected })
const intField = (expected: string, min: number, max?: number): FieldSpec => ({
  schema: max == null ? z.number().int().min(min) : z.number().int().min(min).max(max),
  expected,
})

/** 内部 Form 字段清单 — get_form 返回的字段即此处合法的 patch 键 */
const PATCH_FIELD_SPECS: Record<string, FieldSpec> = {
  // 角色与光锥(optimizer.form.character)
  characterEidolon: intField('0..6 的整数(星魂)', 0, 6),
  characterLevel: intField('1..100 的整数(等级,上游固定 80)', 1, 100),
  lightCone: { schema: z.string().min(1), expected: '光锥 id 字符串(游戏内 id,如 "23014")' },
  lightConeLevel: intField('1..100 的整数(上游固定 80)', 1, 100),
  lightConeSuperimposition: intField('1..5 的整数(叠影)', 1, 5),

  // 敌人配置(optimizer.form.enemy)
  enemyCount: intField('≥1 的整数(敌人数量)', 1),
  enemyLevel: intField('≥1 的整数(敌人等级)', 1),
  enemyResistance: { schema: z.number().min(0).max(1), expected: '0..1 小数(敌人抗性,0.2=20%)' },
  enemyEffectResistance: { schema: z.number().min(0).max(1), expected: '0..1 小数(敌人效果抵抗,0.3=30%)' },
  enemyMaxToughness: { schema: z.number().min(0), expected: '≥0 数值(敌人韧性上限)' },
  enemyElementalWeak: booleanField('布尔(是否带对应属性弱点)'),
  enemyWeaknessBroken: booleanField('布尔(是否已被击破)'),

  // 遗器筛选选项(optimizer.form.options / mainStats / setFilters)
  enhance: intField('0..15 的整数(最低强化等级,常用 0|3|6|9|12|15)', 0, 15),
  grade: intField('2..5 的整数(最低星级)', 2, 5),
  rank: intField('≥0 整数(优先级,角色在列表中的位置)', 0),
  exclude: { schema: z.array(z.string()), expected: '角色 id 字符串数组(排除其身上的遗器)' },
  includeEquippedRelics: booleanField('布尔(是否使用其他角色身上的遗器)'),
  keepCurrentRelics: booleanField('布尔(是否保留当前已装备遗器)'),
  rankFilter: booleanField('布尔(优先级过滤)'),
  mainStatUpscaleLevel: intField('0..15 的整数(主词条计算等级)', 0, 15),
  mainHead: { schema: z.array(z.string()), expected: '主词条数组(头部固定 HP,界面不可选)' },
  mainHands: { schema: z.array(z.string()), expected: '主词条数组(手部固定 ATK,界面不可选)' },
  mainBody: { schema: z.array(z.string()), expected: '主词条数组,可选值如 "CRIT DMG"、"CRIT Rate"(躯干)' },
  mainFeet: { schema: z.array(z.string()), expected: '主词条数组,可选值含 "SPD"(脚部)' },
  mainPlanarSphere: { schema: z.array(z.string()), expected: '主词条数组(位面球,可为属性伤害加成)' },
  mainLinkRope: { schema: z.array(z.string()), expected: '主词条数组(连结绳)' },
  setFilters: {
    schema: z.object({
      fourPiece: z.array(z.string()).optional(),
      twoPieceCombos: z.array(z.object({
        a: z.object({ type: z.string(), value: z.string().optional() }),
        b: z.object({ type: z.string(), value: z.string().optional() }),
      })).optional(),
      ornaments: z.array(z.string()).optional(),
    }),
    expected: '套装筛选对象 { fourPiece: string[], twoPieceCombos: [{a,b}], ornaments: string[] },槽位 type 为 Set|Stat|Any',
  },
  relicSets: { schema: z.array(z.array(z.union([z.string(), z.number()]))), expected: '内部套装筛选元组数组(如 [["4 Piece","套装名"]],与 get_form 返回同构)' },
  ornamentSets: { schema: z.array(z.string()), expected: '饰品套装名数组(内部别名)' },

  // 权重与增益(optimizer.form.weights / combatBuffs)
  weights: { schema: z.record(z.string(), z.number()), expected: '副词条名 → 0..1 权重的映射(另可含 minWeightedRolls);键如 "CRIT DMG"、"SPD"' },
  combatBuffs: { schema: z.record(z.string(), z.number()), expected: '增益键 → 数值映射(内部小数:百分比增益 0.25=25%);合法键见 get_form 返回的 combatBuffs' },

  // 属性视图(optimizer.grid.display)
  statDisplay: { schema: z.enum(['combat', 'base']), expected: '"combat" | "base"(属性视图)' },
  memoDisplay: { schema: z.enum(['summoner', 'memo']), expected: '"summoner" | "memo"(忆灵视图)' },

  // 连招定义(optimizer.combo.definition;矩阵编辑用 combo 参数)
  comboType: { schema: z.enum(['simple', 'advanced']), expected: '"simple" | "advanced"(连招模式)' },
  comboPreprocessor: booleanField('布尔(是否按技能自动套用条件预设)'),
  comboTurnAbilities: { schema: z.array(z.string()), expected: '技能名数组(下标 0 为起手占位 "NULL",其后最多 12 个,如 "DEFAULT_SKILL")' },
  comboStateJson: { schema: z.string(), expected: '序列化连招状态字符串(建议经 get_form(expandCombo=true) 读取、update_form(combo=...) 编辑,而不是手写)' },

  // 优化目标(optimizer.form.target)
  resultSort: { schema: z.enum(RESULT_SORT_KEYS as Any), expected: `排序目标枚举:${RESULT_SORT_KEYS.join(' | ')}` },
  resultsLimit: intField('1..65536 的整数(保留条数)', 1, 65536),
  deprioritizeBuffs: booleanField('布尔(副 C 模式)'),

  // 队伍套装贡献
  teamRelicSet: { schema: z.string().nullable(), expected: '有全队效果的遗器套装名字符串,或 null 清除' },
  teamOrnamentSet: { schema: z.string().nullable(), expected: '有全队效果的饰品套装名字符串,或 null 清除' },

  // 条件(optimizer.form.conditionals / setConditionals;经 handleConditionalChange 联动连招默认值)
  characterConditionals: { schema: z.record(z.string(), z.union([z.boolean(), z.number()])), expected: '角色条件键 → 布尔|数值(键见 describe_conditionals)' },
  lightConeConditionals: { schema: z.record(z.string(), z.union([z.boolean(), z.number()])), expected: '光锥条件键 → 布尔|数值(键见 describe_conditionals)' },
  setConditionals: {
    schema: z.record(z.string(), z.union([z.boolean(), z.number(), z.tuple([z.any(), z.union([z.boolean(), z.number()])])])),
    expected: '套装名 → 布尔|数值(也可用 [null, 值] 元组形式,与 get_form 返回同构)',
  },
}

// 上下限扁平键(内部单位;百分比键为小数)与队友位
const FLAT_FILTER_KEYS = [
  'minAtk',
  'maxAtk',
  'minHp',
  'maxHp',
  'minDef',
  'maxDef',
  'minSpd',
  'maxSpd',
  'minCr',
  'maxCr',
  'minCd',
  'maxCd',
  'minEhr',
  'maxEhr',
  'minRes',
  'maxRes',
  'minBe',
  'maxBe',
  'minErr',
  'maxErr',
  'minBasic',
  'maxBasic',
  'minSkill',
  'maxSkill',
  'minUlt',
  'maxUlt',
  'minFua',
  'maxFua',
  'minMemoSkill',
  'maxMemoSkill',
  'minMemoTalent',
  'maxMemoTalent',
  'minDot',
  'maxDot',
  'minBreak',
  'maxBreak',
  'minEhp',
  'maxEhp',
] as const

const PATCH_FIELD_SPECS_FLAT: Record<string, FieldSpec> = {}
for (const key of FLAT_FILTER_KEYS) {
  PATCH_FIELD_SPECS_FLAT[key] = { schema: z.number().nullable(), expected: '数值或 null(null 清除该门槛;minCr/minCd 等百分比项为小数,0.7=70%)' }
}
const teammateSlotSpec: FieldSpec = {
  schema: z.record(z.string(), z.unknown()).nullable(),
  expected:
    '队友对象(部分字段合并,可含 characterId/characterEidolon/lightCone/lightConeSuperimposition/teamRelicSet/teamOrnamentSet/characterConditionals/lightConeConditionals)或 null(清空该位)',
}
PATCH_FIELD_SPECS_FLAT.teammate0 = teammateSlotSpec
PATCH_FIELD_SPECS_FLAT.teammate1 = teammateSlotSpec
PATCH_FIELD_SPECS_FLAT.teammate2 = teammateSlotSpec

const ALL_PATCH_SPECS = { ...PATCH_FIELD_SPECS, ...PATCH_FIELD_SPECS_FLAT }
const CONDITIONAL_PATCH_KEYS = new Set(['characterConditionals', 'lightConeConditionals', 'setConditionals'])

// 指向专用参数的键 — 出现在 patch 里时给更可操作的提示
const PATCH_REDIRECTS: Record<string, string> = {
  characterId: '切换优化器当前角色请用 update_form 的 characterId 参数(patch 不改角色身份)',
  statSim: '假想配装列表管理请用 update_form 的 statSimulations 参数(patch 不接受 statSim 整体对象)',
  optimizationId: 'optimizationId 由运行时管理,不可写入表单',
  resultMinFilter: 'resultMinFilter 由 optimize 运行时管理(恒为 0),不可写入表单',
  trace: 'trace 由 simulate_build/analyze_build 的 trace 参数控制,不可写入表单',
}

// ─── input schemas ───────────────────────────────────────────────────────────

const simRequestSchema = z.object({
  name: z.string().optional().describe('模拟显示名(可不填)'),
  simRelicSet1: z.string().describe('遗器套装 1(游戏内套装名)'),
  simRelicSet2: z.string().describe('遗器套装 2(与套装 1 相同即 4pc)'),
  simOrnamentSet: z.string().describe('位面饰品套装名'),
  simBody: z.string().describe('Body 主词条,如 "CRIT DMG"'),
  simFeet: z.string().describe('Feet 主词条,如 "SPD"'),
  simPlanarSphere: z.string().describe('PlanarSphere 主词条'),
  simLinkRope: z.string().describe('LinkRope 主词条'),
  stats: z.record(z.string(), z.number()).default({}).describe('副词条 → 词条数映射,键如 "CRIT DMG"、"SPD"'),
})

const comboEditSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('setActivation'),
    target: z.string().describe('矩阵实体定位键,如 "comboCharacter"、"comboTeammate0LightCone"(见 get_form(expandCombo=true).entities[].sourceKey)'),
    id: z.string().describe('条件键(见矩阵中 conditionals[].id)'),
    index: z.number().int().min(1).describe('技能位下标(从 1 起;0 是默认段不可直接改)'),
    value: z.boolean().describe('该技能位是否生效'),
  }),
  z.object({
    kind: z.literal('setPartitionActivation'),
    target: z.string(),
    id: z.string(),
    partitionIndex: z.number().int().min(0).describe('分段下标(0 为默认段)'),
    index: z.number().int().min(1).describe('技能位下标(从 1 起)'),
  }),
  z.object({
    kind: z.literal('setBooleanDefault'),
    target: z.string(),
    id: z.string(),
    value: z.boolean().describe('新的默认值(写入默认段并同步全部技能位)'),
  }),
  z.object({
    kind: z.literal('setNumberDefault'),
    target: z.string(),
    id: z.string(),
    partitionIndex: z.number().int().min(0),
    value: z.number().describe('该分段的新取值'),
  }),
  z.object({
    kind: z.literal('addPartition'),
    target: z.string(),
    id: z.string(),
    value: z.number().describe('新分段的取值'),
  }),
  z.object({
    kind: z.literal('deletePartition'),
    target: z.string(),
    id: z.string(),
    partitionIndex: z.number().int().min(1).describe('要删除的分段下标(默认段 0 不可删)'),
  }),
])

const COMBO_TARGETS = [
  'comboCharacter',
  'comboCharacterLightCone',
  'comboCharacterRelicSets',
  'comboTeammate0',
  'comboTeammate0LightCone',
  'comboTeammate0RelicSet',
  'comboTeammate0OrnamentSet',
  'comboTeammate1',
  'comboTeammate1LightCone',
  'comboTeammate1RelicSet',
  'comboTeammate1OrnamentSet',
  'comboTeammate2',
  'comboTeammate2LightCone',
  'comboTeammate2RelicSet',
  'comboTeammate2OrnamentSet',
]

// ─── output schema blocks ────────────────────────────────────────────────────

const comboSummarySchema = z.object({
  comboType: z.enum(['simple', 'advanced']),
  preprocessor: z.boolean(),
  turnAbilities: z.array(z.string()),
  stateJsonBytes: z.number().int(),
  displayedSets: z.object({ relics: z.array(z.string()), ornaments: z.array(z.string()) }),
})

const appliedEchoSchema = z.object({
  patch: z.array(z.string()),
  preset: z.object({ spd: z.number() }).nullable(),
  reset: z.string().nullable(),
  fromBuild: z.string().nullable(),
  comboEdits: z.number().int(),
  comboSetsUpdated: z.boolean(),
  teammateSlots: z.array(z.number().int()),
  syncFromRoster: z.boolean(),
  statSimulations: z.object({
    added: z.array(z.string()),
    overwritten: z.array(z.string()),
    deleted: z.array(z.string()),
    deletedAll: z.boolean(),
    loadedKey: z.string().nullable(),
    total: z.number().int(),
  }),
})

const statSimListEchoSchema = z.object({
  total: z.number().int(),
  simulations: z.array(z.object({
    key: z.string(),
    name: z.string().nullable(),
    simType: z.string(),
  })),
})

// ─── validation helpers ──────────────────────────────────────────────────────

function requireSaveCharacter(characterId: string) {
  const character = getCharacterById(characterId as CharacterId)
  if (!character) {
    throw new Error(
      `update_form: 角色 ${characterId} 不在当前存档中——已载入角色: ${getCharacters().map((c) => c.id).join(', ')}(新角色请先用 upsert_character 加入)`,
    )
  }
  return character
}

function validatePatchFields(patch: Record<string, unknown>): void {
  const keys = Object.keys(patch)
  if (keys.length === 0) {
    throw new Error(`update_form: patch 不能为空 — 至少提供一个要修改的字段;合法字段(内部表单口径,同 get_form 返回):${Object.keys(ALL_PATCH_SPECS).join(', ')}`)
  }
  const unknownKeys = keys.filter((key) => !(key in ALL_PATCH_SPECS))
  if (unknownKeys.length > 0) {
    for (const key of unknownKeys) {
      const redirect = PATCH_REDIRECTS[key]
      if (redirect) throw new Error(`update_form: patch 不接受字段 "${key}" — ${redirect}`)
    }
    throw new Error(
      `update_form: 未知字段 ${unknownKeys.map((key) => `"${key}"`).join(', ')} — 合法字段(内部表单口径,同 get_form 返回):${
        Object.keys(ALL_PATCH_SPECS).join(', ')
      }`,
    )
  }
  for (const key of keys) {
    const spec = ALL_PATCH_SPECS[key]
    const parsed = spec.schema.safeParse(patch[key])
    if (!parsed.success) {
      throw new Error(
        `update_form: 字段 ${key} 的值无效 — 期望 ${spec.expected},实际收到 ${JSON.stringify(patch[key])?.slice(0, 200)}`,
      )
    }
  }
}

/** 值级校验(需要元数据/注册表参与的检查),返回写入 warnings 的软提示 */
function validatePatchValues(patch: Record<string, unknown>): string[] {
  const warnings: string[] = []
  const dbMetadata = getGameMetadata()

  if (typeof patch.lightCone === 'string' && !(patch.lightCone in dbMetadata.lightCones)) {
    throw new Error(`update_form: 字段 lightCone 的值 "${patch.lightCone}" 不在游戏元数据中 — 请核对光锥 id`)
  }
  for (const key of ['teamRelicSet', 'teamOrnamentSet']) {
    const value = patch[key]
    if (typeof value === 'string' && !(RELIC_SET_NAMES.has(value) || ORNAMENT_SET_NAMES.has(value))) {
      throw new Error(`update_form: 字段 ${key} 的值 "${value}" 不是已知套装名 — 须为游戏内套装名(见 game://metadata/sets)`)
    }
  }
  for (const id of (patch.exclude as string[] | undefined) ?? []) {
    if (!(id in dbMetadata.characters)) {
      throw new Error(`update_form: 字段 exclude 中的角色 id "${id}" 不在游戏元数据中`)
    }
  }
  for (const field of MAIN_PART_KEYS) {
    const partKey = field.replace('main', '') as keyof typeof PartsMainStats
    const values = patch[field] as string[] | undefined
    if (!values) continue
    const valid = PartsMainStats[partKey] as unknown as string[]
    for (const stat of values) {
      if (!valid.includes(stat)) {
        throw new Error(`update_form: 字段 ${field} 的主词条 "${stat}" 不是 ${partKey} 部位的合法主词条 — 可选: ${valid.join(', ')}`)
      }
    }
  }
  const setFilters = patch.setFilters
  if (setFilters != null) {
    const names = [
      ...((setFilters as Any).fourPiece ?? []),
      ...((setFilters as Any).ornaments ?? []),
    ]
    for (const name of names) {
      if (!RELIC_SET_NAMES.has(name) && !ORNAMENT_SET_NAMES.has(name)) {
        throw new Error(`update_form: 字段 setFilters 中的套装名 "${name}" 不是已知套装 — 须为游戏内套装名(见 game://metadata/sets)`)
      }
    }
    for (const [index, combo] of (((setFilters as Any).twoPieceCombos ?? []) as Any[]).entries()) {
      for (const slot of [combo.a, combo.b]) {
        if (!['Set', 'Stat', 'Any'].includes(slot?.type)) {
          throw new Error(`update_form: setFilters.twoPieceCombos[${index}] 的槽位 type 须为 "Set" | "Stat" | "Any",实际 "${slot?.type}"`)
        }
        if (slot.type === 'Set' && (typeof slot.value !== 'string' || (!RELIC_SET_NAMES.has(slot.value) && !ORNAMENT_SET_NAMES.has(slot.value)))) {
          throw new Error(`update_form: setFilters.twoPieceCombos[${index}] 的 type=Set 槽位需要合法套装名,实际 ${JSON.stringify(slot.value)}`)
        }
      }
    }
  }
  const weights = patch.weights as Record<string, number> | undefined
  if (weights != null) {
    for (const [key, value] of Object.entries(weights)) {
      if (LEGACY_WEIGHT_KEYS.has(key)) {
        // 引擎不读该键(Constants.SubStats 不含);真正从 patch 剥离,
        // 让「已忽略」的警告与实际行为一致,否则 get_form 往返会把它带回。
        delete weights[key]
        warnings.push(`patch.weights 中的旧字段 "${key}" 已废弃,本次写入已忽略`)
        continue
      }
      if (!SUBSTAT_KEYS.includes(key)) {
        throw new Error(`update_form: 字段 weights 中的副词条名 "${key}" 不存在 — 可用: ${SUBSTAT_KEYS.join(', ')}`)
      }
      if (key === 'minWeightedRolls' ? value < 0 : (value < 0 || value > 1)) {
        throw new Error(
          key === 'minWeightedRolls'
            ? `update_form: weights.minWeightedRolls 需要 ≥0 的数值,实际 ${value}`
            : `update_form: weights["${key}"] 需要 0..1 的权重(0.25=25%),实际 ${value}`,
        )
      }
    }
  }
  const combatBuffs = patch.combatBuffs as Record<string, number> | undefined
  if (combatBuffs != null) {
    for (const key of Object.keys(combatBuffs)) {
      if (!COMBAT_BUFF_KEYS.includes(key)) {
        throw new Error(`update_form: 字段 combatBuffs 中的增益键 "${key}" 不存在 — 可用: ${COMBAT_BUFF_KEYS.join(', ')}`)
      }
    }
  }
  const abilities = patch.comboTurnAbilities as string[] | undefined
  if (abilities != null) {
    if (abilities.length > 13) {
      throw new Error(`update_form: 字段 comboTurnAbilities 最多 13 项(下标 0 起手占位 + 12 个技能),实际 ${abilities.length} 项`)
    }
    for (const ability of abilities) {
      if (ability !== NULL_TURN_ABILITY_NAME && !(ability in AbilityNameToTurnAbility)) {
        throw new Error(
          `update_form: 字段 comboTurnAbilities 中的技能名 "${ability}" 不存在 — 合法形如 "DEFAULT_SKILL"、"WHOLE_BASIC"、"NULL"(可选技能见 describe_conditionals(includeAbilities=true))`,
        )
      }
    }
  }
  const comboStateJson = patch.comboStateJson
  if (typeof comboStateJson === 'string' && comboStateJson.length > 0 && comboStateJson !== '{}') {
    try {
      const parsed = JSON.parse(comboStateJson) as unknown
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
    } catch {
      throw new Error('update_form: 字段 comboStateJson 不是合法的 JSON 对象 — 建议经 get_form(expandCombo=true) 读取、update_form(combo=...) 编辑,而不是手写')
    }
  }
  for (const slotKey of ['teammate0', 'teammate1', 'teammate2']) {
    const slot = patch[slotKey]
    if (slot == null || typeof slot !== 'object') continue
    validateTeammateSlotFields(slotKey, slot as Record<string, unknown>)
  }
  return warnings
}

const TEAMMATE_SLOT_FIELDS: string[] = [
  'characterId',
  'characterEidolon',
  'lightCone',
  'lightConeSuperimposition',
  'teamRelicSet',
  'teamOrnamentSet',
  'characterConditionals',
  'lightConeConditionals',
]

function validateTeammateSlotFields(slotLabel: string, slot: Record<string, unknown>): void {
  const dbMetadata = getGameMetadata()
  for (const [key, value] of Object.entries(slot)) {
    if (!TEAMMATE_SLOT_FIELDS.includes(key)) {
      throw new Error(`update_form: ${slotLabel} 的未知字段 "${key}" — 合法字段: ${TEAMMATE_SLOT_FIELDS.join(', ')}`)
    }
    if (key === 'characterId' && value != null && !(String(value) in dbMetadata.characters)) {
      throw new Error(`update_form: ${slotLabel}.characterId 的值 "${String(value)}" 不在游戏元数据中`)
    }
    if (key === 'lightCone' && value != null && !(String(value) in dbMetadata.lightCones)) {
      throw new Error(`update_form: ${slotLabel}.lightCone 的值 "${String(value)}" 不在游戏元数据中`)
    }
    for (const condKey of ['characterConditionals', 'lightConeConditionals'] as const) {
      if (key !== condKey) continue
      const conds = value as Record<string, unknown> | null | undefined
      if (conds == null) continue
      for (const [condId, condValue] of Object.entries(conds)) {
        if (typeof condValue !== 'boolean' && typeof condValue !== 'number') {
          throw new Error(`update_form: ${slotLabel}.${condKey}["${condId}"] 的值须为布尔或数值,实际 ${JSON.stringify(condValue)}`)
        }
      }
    }
  }
}

/**
 * 条件键合法性:主角色/光锥/套装与队友位,键集来自与 computeLoadForm 相同的
 * resolver(网页端 UI 只允许在列出的条件上取值,API 同样拒绝未知键)。
 */
function validateConditionalKeys(state: OptimizerRequestState, patch: Record<string, unknown>): void {
  const dbMetadata = getGameMetadata()
  const charConds = patch.characterConditionals as Record<string, unknown> | undefined
  if (charConds != null && Object.keys(charConds).length > 0) {
    const controller = CharacterConditionalsResolver.get({
      characterId: state.characterId as CharacterId,
      characterEidolon: state.characterEidolon,
    })
    const legal = new Set<string>([
      ...controller.content().map((item) => item.id),
      ...Object.keys(controller.defaults?.() ?? {}),
    ])
    for (const key of Object.keys(charConds)) {
      if (!legal.has(key)) {
        throw new Error(
          `update_form: characterConditionals 中的条件键 "${key}" 不属于角色 ${state.characterId}(当前星魂 e${state.characterEidolon}) — 合法键: ${
            [...legal].join(', ')
          }(完整定义见 describe_conditionals)`,
        )
      }
    }
  }
  const lcConds = patch.lightConeConditionals as Record<string, unknown> | undefined
  if (lcConds != null && Object.keys(lcConds).length > 0) {
    if (!state.lightCone) {
      throw new Error('update_form: 表单未选择光锥,不能修改 lightConeConditionals — 先在同一个 patch 里设置 lightCone')
    }
    const defaults = resolveLcDefaults(
      {
        characterId: state.characterId!,
        characterEidolon: state.characterEidolon,
        lightCone: state.lightCone,
        lightConeSuperimposition: state.lightConeSuperimposition,
      },
      dbMetadata,
      false,
    )
    const legal = new Set<string>(Object.keys(defaults ?? {}))
    for (const key of Object.keys(lcConds)) {
      if (!legal.has(key)) {
        throw new Error(
          `update_form: lightConeConditionals 中的条件键 "${key}" 不属于光锥 ${state.lightCone} — 合法键: ${
            [...legal].join(', ')
          }(完整定义见 describe_conditionals)`,
        )
      }
    }
  }
  const setConds = patch.setConditionals as Record<string, unknown> | undefined
  if (setConds != null) {
    for (const key of Object.keys(setConds)) {
      if (!RELIC_SET_NAMES.has(key) && !ORNAMENT_SET_NAMES.has(key)) {
        throw new Error(`update_form: setConditionals 中的套装名 "${key}" 不是已知套装 — 可选套装的条件定义见 describe_conditionals(includeSets=true)`)
      }
    }
  }
  for (const index of [0, 1, 2] as const) {
    const slot = patch[`teammate${index}`]
    if (slot == null || typeof slot !== 'object') continue
    validateTeammateConditionalKeys(index, slot as Record<string, unknown>)
  }
}

function validateTeammateConditionalKeys(index: 0 | 1 | 2, slot: Record<string, unknown>): void {
  const dbMetadata = getGameMetadata()
  const teammate = useOptimizerRequestStore.getState().teammates[index]
  for (const condKey of ['characterConditionals', 'lightConeConditionals'] as const) {
    const conds = slot[condKey] as Record<string, unknown> | undefined
    if (conds == null || Object.keys(conds).length === 0) continue
    if (!teammate.characterId) {
      throw new Error(`update_form: teammate${index} 还没有角色,不能修改它的 ${condKey} — 先设置该队友位的 characterId`)
    }
    if (condKey === 'lightConeConditionals' && !teammate.lightCone) {
      throw new Error(`update_form: teammate${index} 没有光锥,不能修改 lightConeConditionals — 先设置该队友位的 lightCone`)
    }
    const legal = new Set<string>()
    if (condKey === 'characterConditionals') {
      const eidolon = typeof slot.characterEidolon === 'number' ? slot.characterEidolon : teammate.characterEidolon
      const controller = CharacterConditionalsResolver.get({
        characterId: teammate.characterId,
        characterEidolon: eidolon,
      })
      for (const item of controller.teammateContent?.() ?? []) legal.add(item.id)
      for (const key of Object.keys(controller.teammateDefaults?.() ?? {})) legal.add(key)
      for (const item of controller.content()) legal.add(item.id)
    } else {
      const superimposition = typeof slot.lightConeSuperimposition === 'number' ? slot.lightConeSuperimposition : teammate.lightConeSuperimposition
      const defaults = resolveLcDefaults(
        {
          characterId: teammate.characterId,
          characterEidolon: teammate.characterEidolon,
          lightCone: teammate.lightCone!,
          lightConeSuperimposition: superimposition,
        },
        dbMetadata,
        true,
      )
      for (const key of Object.keys(defaults ?? {})) legal.add(key)
    }
    for (const key of Object.keys(conds)) {
      if (!legal.has(key)) {
        throw new Error(`update_form: teammate${index}.${condKey} 中的条件键 "${key}" 不属于队友 ${teammate.characterId} — 合法键: ${[...legal].join(', ')}`)
      }
    }
  }
}

// ─── stat simulation helpers (mirror statSimulationController) ───────────────

function cleanSimRequest(request: SimulationRequest): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request as unknown as Record<string, unknown>)) {
    if (value != null) cleaned[key] = value
  }
  return cleaned
}

function hashSimulation(simType: StatSimTypes, request: SimulationRequest): string {
  return objectHash({ simType, request: cleanSimRequest(request) })
}

function assertSimRequest(request: SimulationRequest, label: string): void {
  if (!RELIC_SET_NAMES.has(request.simRelicSet1)) {
    throw new Error(`update_form: ${label} 的 simRelicSet1 "${request.simRelicSet1}" 不是已知遗器套装名`)
  }
  if (!RELIC_SET_NAMES.has(request.simRelicSet2)) {
    throw new Error(`update_form: ${label} 的 simRelicSet2 "${request.simRelicSet2}" 不是已知遗器套装名`)
  }
  if (!ORNAMENT_SET_NAMES.has(request.simOrnamentSet)) {
    throw new Error(`update_form: ${label} 的 simOrnamentSet "${request.simOrnamentSet}" 不是已知位面饰品套装名`)
  }
  const mainChecks: Array<[string, string | undefined, keyof typeof PartsMainStats]> = [
    ['simBody', request.simBody, 'Body'],
    ['simFeet', request.simFeet, 'Feet'],
    ['simPlanarSphere', request.simPlanarSphere, 'PlanarSphere'],
    ['simLinkRope', request.simLinkRope, 'LinkRope'],
  ]
  for (const [field, mainStat, partKey] of mainChecks) {
    const valid = PartsMainStats[partKey] as unknown as string[]
    if (!mainStat || !valid.includes(mainStat)) {
      // 网页端「四个主词条没选全不让存」(statSimulationController.validateRequest)
      throw new Error(`update_form: ${label} 的 ${field}="${mainStat ?? ''}" 缺失或不是 ${partKey} 部位的合法主词条 — 可选: ${valid.join(', ')}`)
    }
  }
  for (const stat of Object.keys(request.stats ?? {})) {
    if (!SUBSTAT_KEYS.includes(stat)) {
      throw new Error(`update_form: ${label} 的副词条 "${stat}" 不存在 — 可用: ${SubStats.join(', ')}`)
    }
  }
}

type StatSimState = {
  key: string,
  benchmarks: SimulationRequest,
  substatRolls: SimulationRequest,
  simulations: Simulation[],
}

function currentStatSim(): StatSimState {
  const existing = useOptimizerRequestStore.getState().statSim as Form['statSim'] | undefined
  return {
    key: existing?.key ?? '',
    benchmarks: existing?.benchmarks ?? blankSimRequest(),
    substatRolls: existing?.substatRolls ?? blankSimRequest(),
    simulations: existing?.simulations ?? [],
  }
}

/** 未选主词条(空串/0)→ null,镜像网页端回填语义 */
function blankMainsToNull(request: SimulationRequest): SimulationRequest {
  const copy = { ...request } as Any
  for (const field of ['simBody', 'simFeet', 'simPlanarSphere', 'simLinkRope']) {
    if (!copy[field]) copy[field] = null
  }
  return copy as SimulationRequest
}

// ─── warnings (validateForm 的非致命化移植) ─────────────────────────────────

function collectFormWarnings(form: Form): string[] {
  const warnings: string[] = []
  if (!form.lightCone || !form.lightConeSuperimposition) {
    warnings.push('表单未选择光锥(或叠影为 0)— optimize 会拒绝运行;用 patch.lightCone / patch.lightConeSuperimposition 补齐')
  }
  if (!form.resultsLimit || !form.resultSort) {
    warnings.push('表单未选择优化目标或保留条数 — optimize 会拒绝运行;用 patch.resultSort / patch.resultsLimit 补齐')
  }
  const weights = (form.weights ?? {}) as Record<string, number | undefined>
  const hasWeight = SubStats.some((stat) => !!weights[stat])
  if (!hasWeight) {
    warnings.push('副词条权重全为 0 — optimize 会拒绝运行;用 patch.weights 设置至少一个非零权重')
  }
  const metadata = getGameMetadata()
  const lcMeta = form.lightCone ? metadata.lightCones[form.lightCone as LightConeId] : undefined
  const charMeta = metadata.characters[form.characterId as CharacterId]
  if (lcMeta && charMeta && lcMeta.path !== charMeta.path) {
    warnings.push(
      `光锥 ${form.lightCone}(${lcMeta.name},命途 ${lcMeta.path})与角色 ${charMeta.name}(命途 ${charMeta.path})命途不符 — 光锥效果不会生效(网页端同样仅警告)`,
    )
  }
  if (charMeta?.scoringMetadata?.simulation && (!form.teammate0?.characterId || !form.teammate1?.characterId || !form.teammate2?.characterId)) {
    warnings.push(`角色 ${charMeta.name} 有模拟评分配置但队友未填满 — 评分口径可能失真(网页端同样仅警告);用 teammates 参数补齐三位队友`)
  }
  return warnings
}

// ─── registration ────────────────────────────────────────────────────────────

export function registerFormTools(server: McpServer): void {
  server.registerTool('update_form', {
    title: '更新优化器表单',
    description: '优化器页表单的持久化写入入口——把改动写进角色的已保存表单(characters[].form),对齐网页端的表单落盘时机'
      + '(点「开始」/「装备」/切换角色/关连招抽屉/存模拟时写回)。'
      + '与 optimize(formOverrides=...) 的关系:formOverrides 是单次运行的临时覆写、用完即弃不落盘;'
      + 'update_form 写的是持久表单——之后的 optimize / simulate_build / get_form / 网页端都会读到新值。'
      + '一次调用按固定顺序组合各子动作:characterId(切换角色)→ fromBuild(载入配装)→ reset(重置筛选)→ preset(推荐预设)'
      + '→ patch(字段覆盖)→ combo(连招矩阵编辑)→ teammates(队友更新)→ statSimulations(假想配装列表管理),可任意组合。'
      + 'characterId 走上游 switchToCharacter 语义:先保存离开角色的表单、再载入新角色(条件默认值垫在已存值下面、rank 对齐列表位置),不是只改会话指针;'
      + '改 conditionals 时复用上游 handleConditionalChange 联动(同步连招默认值、保留逐回合覆写)。'
      + 'patch 为内部表单口径(同 get_form 返回):未知字段报错并列合法字段清单,认识但类型错的字段单独报可操作错误;'
      + '百分比一律小数(0.5=50%),嵌套映射按键合并、数组整体替换;statSim(假想配装列表)不接受整对象写入,用 statSimulations 参数。'
      + '可选 baseRevision 乐观并发(口径同 update_state);返回新 revision、应用回显与非致命校验警告 warnings'
      + '(validateForm 的结果:缺光锥/缺优化目标/权重全 0/命途不符/队友未满——表单照常应用,仅提示)。',
    inputSchema: {
      characterId: z.string().optional().describe(
        '切换优化器当前角色(须在存档中)。走 switchToCharacter 语义:自动保存离开角色的表单再载入新角色;缺省时编辑会话当前角色',
      ),
      patch: z.record(z.string(), z.unknown()).optional().describe(
        '部分字段更新(内部表单口径,同 get_form 返回):mainStats/setFilters/weights/resultFilters/conditionals/enemy/combatBuffs 等;未知字段报错并列合法字段清单',
      ),
      preset: z.object({
        spd: z.number().min(0).max(400).default(0).describe(
          '速度档位(推荐预设按最低速度分档);0=不限速(主按钮),常用值如 120.000 / 133.334(完整清单见 default_form(spdPreset=…) 返回的 availableSpdPresets)',
        ),
      }).optional().describe(
        '应用推荐预设(网页端「推荐预设」按钮族):恢复条件默认值、套用评分元数据推荐筛选,有模拟评分配置时把优化目标设为 COMBO;可与 patch 组合(preset 先、patch 后)',
      ),
      reset: z.literal('filters').optional().describe(
        '重置遗器筛选为默认(侧栏「重置」按钮):最低强化/星级/优先级/排除/是否用已装备遗器/主词条计算等级/各部位主词条/套装筛选;角色、光锥、条件、权重、上下限、队友与连招不动;可与 preset/patch 组合(reset 先、patch 后)',
      ),
      combo: z.object({
        comboType: z.enum(['simple', 'advanced']).optional().describe('连招模式;矩阵编辑仅在 advanced 下可用'),
        preprocessor: z.boolean().optional().describe('是否按技能自动套用条件预设'),
        turnAbilities: z.array(z.string()).max(13).optional().describe(
          '连招技能序列(下标 0 为 "NULL" 起手占位,其后最多 12 个);可选技能名见 describe_conditionals(includeAbilities=true)',
        ),
        displayedSets: z.object({
          relics: z.array(z.string()).optional(),
          ornaments: z.array(z.string()).optional(),
        }).optional().describe('选择参与逐技能矩阵的套装行(连招抽屉的套装多选框)'),
        edits: z.array(comboEditSchema).optional().describe(
          '矩阵编辑列表:布尔条件按技能位勾选(setActivation/setBooleanDefault),数值/选择条件按分段取值与生效位(setPartitionActivation/setNumberDefault/addPartition/deletePartition);target+id 定位,见 get_form(expandCombo=true)',
        ),
      }).optional().describe('连招编辑:矩阵 ↔ 可序列化往返走上游连招抽屉逻辑(useComboDrawerStore.initialize → 编辑 → flushComboDrawerToForm)'),
      teammates: z.array(z.union([z.record(z.string(), z.unknown()), z.null()])).max(3).optional().describe(
        '队友位列表(最多 3 个,不足之位保持不变):每项为队友字段的部分对象,null 清空该位;其中的条件改动同样经 handleConditionalChange 联动连招默认值',
      ),
      syncFromRoster: z.boolean().optional().describe(
        '队友是否走网页端「从角色列表同步」语义:选中角色时自动带入其在角色列表中的星魂/光锥/叠影与身上的队伍套装,换人时条件重置为默认(默认 false=按传入字段合并,formOverrides 语义)',
      ),
      fromBuild: z.string().optional().describe(
        '把角色的一条已保存配装载入优化器表单(配装名;来源为优化器的配装会连同队友/条件/连招快照一起载入,角色页配装只载入光锥/星魂)',
      ),
      statSimulations: z.object({
        add: z.array(z.object({
          name: z.string().optional(),
          simType: z.enum(['substatRolls', 'benchmarks']).default('substatRolls'),
          request: simRequestSchema,
        })).optional().describe('新增假想配装(四个主词条必须齐全;与现有条目内容重复会被拒绝,与网页端一致)'),
        load: z.object({ key: z.string() }).optional().describe('按 key 把一条已存模拟回填到模拟输入区'),
        overwrite: z.object({
          key: z.string(),
          name: z.string().optional(),
          request: simRequestSchema,
        }).optional().describe('用给定内容覆盖指定条目(覆盖后获得新 key,查重排除自身)'),
        delete: z.object({ keys: z.array(z.string()).min(1) }).optional().describe('删除指定 key 的条目'),
        deleteAll: z.boolean().optional().describe('清空全部已存模拟'),
      }).optional().describe('假想配装(stat simulation)列表管理:新增/载入/覆盖/删除/全清;保存的模拟随角色表单落盘,stat_simulate(saved=true) 可直接运行它们'),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突(需重读后重试)'),
    },
    outputSchema: {
      updated: z.boolean(),
      characterId: z.string(),
      switchedFrom: z.string().nullable(),
      revision: z.number().int(),
      dirty: z.boolean(),
      applied: appliedEchoSchema,
      combo: comboSummarySchema,
      statSimulations: statSimListEchoSchema,
      warnings: z.array(z.string()),
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    ensureI18nReady()

    const hasAction = input.patch != null || input.preset != null || input.reset != null
      || input.combo != null || input.teammates != null || input.fromBuild != null
      || input.statSimulations != null || input.characterId != null
    if (!hasAction) {
      throw new Error('update_form: 没有可执行的动作 — 至少提供 characterId / patch / preset / reset / combo / teammates / fromBuild / statSimulations 之一')
    }

    // patch 预校验(事务外快速失败,不消耗修订号)
    if (input.patch != null) validatePatchFields(input.patch)
    const warnings = input.patch != null ? validatePatchValues(input.patch) : []
    if (input.teammates != null) {
      for (const [index, slot] of input.teammates.entries()) {
        if (slot != null) validateTeammateSlotFields(`teammates[${index}]`, slot)
      }
    }
    if (input.preset != null) {
      const catalog = spdPresetCatalog()
      if (!catalog.values.includes(input.preset.spd)) {
        throw new Error(
          `update_form: preset.spd 的值 ${input.preset.spd} 不是推荐预设的速度档位 — 可选: ${
            catalog.values.join(', ')
          }(完整清单见 default_form(spdPreset=…) 返回的 availableSpdPresets)`,
        )
      }
    }

    const applied = {
      patch: Object.keys(input.patch ?? {}),
      preset: input.preset != null ? { spd: input.preset.spd } : null,
      reset: input.reset ?? null,
      fromBuild: input.fromBuild ?? null,
      comboEdits: input.combo?.edits?.length ?? 0,
      comboSetsUpdated: input.combo?.displayedSets != null,
      teammateSlots: [] as number[],
      syncFromRoster: input.syncFromRoster === true,
      statSimulations: {
        added: [] as string[],
        overwritten: [] as string[],
        deleted: [] as string[],
        deletedAll: false,
        loadedKey: null as string | null,
        total: 0,
      },
    }

    const outcome = await runtimeContext.withChange('update_form', () => {
      const globalState = useGlobalStore.getState()

      // ① 建立上游切换路径依赖的存储不变量:请求存储持有会话角色的已存表单。
      // 网页端该不变量由上一次切换建立;无头环境下其他工具可能把草稿态留在
      // 别处,这里按会话指针重放,保证 switchToCharacter 内部的
      // syncFormToCharacterStore 永远不会把陈旧草稿写到任何角色上。
      const sessionPointer: string | null | undefined = globalState.savedSession.optimizerCharacterId
      const target = input.characterId ?? sessionPointer
      if (!target) {
        throw new Error('update_form: 没有当前角色(会话中未记录 optimizerCharacterId)— 请显式传 characterId 指定要编辑的角色')
      }
      const character = requireSaveCharacter(target)

      const outgoingCharacter = sessionPointer ? getCharacterById(sessionPointer as CharacterId) : undefined
      useOptimizerRequestStore.getState().loadForm(outgoingCharacter ? outgoingCharacter.form : getDefaultForm({} as Any))

      // 上游 syncFormToCharacterStore 走 getForm():form.statSim.simulations 会被
      // display store 的列表整体覆盖(optimizerFormActions.ts:237-247)。网页端该
      // store 与每次列表增删同步;无头环境若不播种,切换角色时离开角色的已存
      // 列表会被 display 里的陈旧/空列表抹掉(并随 markDirty 落盘)。这里按会话
      // 指针(即将被 sync 的角色)播种,过滤与 updateCharacter 载入新角色时同款。
      const outgoingForm = outgoingCharacter?.form ?? getDefaultForm({} as Any)
      useOptimizerDisplayStore.getState().setStatSimulations(
        (outgoingForm.statSim?.simulations ?? []).filter((sim) => sim.request?.stats),
      )

      // ② 切换角色:上游 switchToCharacter → updateCharacter
      //    (src/lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions.ts:391/346)
      //    = 保存离开角色表单 → computeLoadForm 载入(条件默认值垫底)→ rank
      //    对齐列表位置 → 会话指针 + 防抖落盘。
      if (input.characterId != null) {
        switchToCharacter(target as CharacterId)
      } else {
        // 非切换路径:草稿态已在上一步载入;rank 仍对齐当前列表位置(updateCharacter 同款)
        const rosterIndex = getCharacters().findIndex((c) => c.id === target)
        if (rosterIndex >= 0) useOptimizerRequestStore.getState().setRelicFilterField('rank', rosterIndex)
      }

      // ③ fromBuild:loadBuildInOptimizer(src/lib/services/buildService.ts:112)配方 —
      //    角色已存表单(或默认表单)经 computeLoadForm 后叠加配装反序列化字段
      if (input.fromBuild != null) {
        const build = (character.builds ?? []).find((b) => b.name === input.fromBuild)
        if (!build) {
          throw new Error(
            `update_form: 角色 ${target} 没有名为 "${input.fromBuild}" 的已保存配装 — 现有配装: ${
              (character.builds ?? []).map((b) => b.name).join(', ') || '(无)'
            }`,
          )
        }
        const currentForm = displayToInternal(useOptimizerRequestStore.getState())
        const mergedState = {
          ...computeLoadForm(character.form ?? getDefaultForm({ id: target as CharacterId })),
          ...deserializeBuild(build, currentForm),
        }
        useOptimizerRequestStore.setState(mergedState as Any)
      }

      // ④ reset:上游 resetFilters(侧栏「重置」按钮)
      if (input.reset === 'filters') {
        useOptimizerRequestStore.getState().resetFilters()
      }

      // ⑤ preset:上游 applySpdPreset(「推荐预设」按钮族)
      if (input.preset != null) {
        applySpdPreset(input.preset.spd, target as CharacterId)
      }

      // ⑥ patch:先写非条件字段,再走 handleConditionalChange 联动连招默认值
      if (input.patch != null) {
        const patch = input.patch
        const nonConditional: Record<string, unknown> = { format: 'internal' }
        for (const [key, value] of Object.entries(patch)) {
          if (!CONDITIONAL_PATCH_KEYS.has(key)) nonConditional[key] = value
        }
        const probeState = { ...useOptimizerRequestStore.getState() } as Any
        applyFormOverrides(probeState, nonConditional)
        // 存量表单可能带着引擎已不读的旧权重键(如 topPercent);一旦调用方
        // 触碰 weights,顺手把死键从存储里剥掉,让 get_form 不再回传。
        if (patch.weights != null && probeState.weights != null) {
          for (const legacy of LEGACY_WEIGHT_KEYS) delete probeState.weights[legacy]
        }
        useOptimizerRequestStore.setState(probeState)
        // 条件键的合法性在「非条件字段已生效」的状态下校验(如先换光锥再看光锥条件键)
        validateConditionalKeys(useOptimizerRequestStore.getState() as Any, patch)

        const applyConds = (condType: 'characterConditionals' | 'lightConeConditionals', conds: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(conds)) {
            handleConditionalChange([condType, key], value as boolean | number)
          }
        }
        if (patch.characterConditionals != null) applyConds('characterConditionals', patch.characterConditionals as Record<string, unknown>)
        if (patch.lightConeConditionals != null) applyConds('lightConeConditionals', patch.lightConeConditionals as Record<string, unknown>)
        if (patch.setConditionals != null) {
          for (const [setName, value] of Object.entries(patch.setConditionals as Record<string, unknown>)) {
            const normalized = Array.isArray(value) ? (value as [undefined, boolean | number])[1] : value
            handleConditionalChange(['setConditionals', setName], normalized as boolean | number)
          }
        }
        for (const index of [0, 1, 2] as const) {
          const slot = patch[`teammate${index}`]
          if (slot == null || typeof slot !== 'object') continue
          const { characterConditionals, lightConeConditionals, ...plainFields } = slot as Record<string, unknown>
          if (Object.keys(plainFields).length > 0) applyPlainTeammateFields(index, plainFields)
          applyTeammateConditionalsViaLinkage(index, { characterConditionals, lightConeConditionals })
        }
      }

      // ⑦ combo:连招抽屉等价逻辑(initialize → 编辑 → flushComboDrawerToForm)
      if (input.combo != null) {
        const combo = input.combo
        const store = useOptimizerRequestStore.getState()
        if (combo.comboType != null) store.setComboType(combo.comboType as Any)
        if (combo.preprocessor != null) store.setComboPreprocessor(combo.preprocessor)
        if (combo.turnAbilities != null) store.setComboTurnAbilities(combo.turnAbilities as TurnAbilityName[])

        const needsDrawer = (combo.edits?.length ?? 0) > 0 || combo.displayedSets != null
        if (needsDrawer) {
          if (useOptimizerRequestStore.getState().comboType !== 'advanced') {
            throw new Error(
              'update_form: 连招矩阵编辑仅在 advanced 模式可用 — 先在同一个 combo 里设置 comboType:"advanced"(网页端简单模式下高级连招按钮同样禁用)',
            )
          }
          // 抽屉打开:从当前表单展开矩阵(保存的逐回合覆写按版本合并)
          useComboDrawerStore.getState().initialize(displayToInternal(useOptimizerRequestStore.getState()))
          for (const edit of combo.edits ?? []) {
            if (!resolveSourceKeyRoute(edit.target)) {
              throw new Error(`update_form: combo.edits 的 target "${edit.target}" 不是矩阵定位键 — 合法值: ${COMBO_TARGETS.join(', ')}`)
            }
            const conditional = locateConditional(useComboDrawerStore.getState(), edit.target, edit.id)
            if (!conditional) {
              throw new Error(`update_form: 连招矩阵中 target="${edit.target}" 下没有条件 "${edit.id}" — 现有条件见 get_form(expandCombo=true) 的对应实体`)
            }
            // 界内校验:上游 setter 不查上界(setActivation 直接按下标赋值,
            // useComboDrawerStore.ts:211),越界会写出稀疏数组 — 序列化产生 null
            // 洞后 get_form(expandCombo) 对该角色永久报错,且 merge 只补洞不截断
            const turnCount = ((conditional as { activations?: unknown[] }).activations ?? []).length
            if ((edit.kind === 'setActivation' || edit.kind === 'setPartitionActivation') && edit.index > turnCount - 1) {
              throw new Error(
                `update_form: combo.edits 的 index ${edit.index} 超出技能位范围 — "${edit.target}/${edit.id}" 当前矩阵共 ${turnCount} 个技能位(下标 0..${
                  turnCount - 1
                },0 为默认段)`,
              )
            }
            const partitionCount = (conditional as { partitions?: { value: number }[] }).partitions?.length
            if (
              (edit.kind === 'setPartitionActivation' || edit.kind === 'setNumberDefault' || edit.kind === 'deletePartition')
              && partitionCount != null && edit.partitionIndex > partitionCount - 1
            ) {
              throw new Error(
                `update_form: combo.edits 的 partitionIndex ${edit.partitionIndex} 超出分段范围 — "${edit.target}/${edit.id}" 当前共 ${partitionCount} 个分段(下标 0..${
                  partitionCount - 1
                })`,
              )
            }
            const drawer = useComboDrawerStore.getState()
            switch (edit.kind) {
              case 'setActivation':
                drawer.setActivation(edit.target, edit.id, edit.index, edit.value)
                break
              case 'setPartitionActivation':
                drawer.setPartitionActivation(edit.target, edit.id, edit.partitionIndex, edit.index)
                break
              case 'setBooleanDefault':
                drawer.setBooleanDefault(edit.target, edit.id, edit.value)
                break
              case 'setNumberDefault':
                drawer.setNumberDefault(edit.target, edit.id, edit.partitionIndex, edit.value)
                break
              case 'addPartition':
                drawer.addPartition(edit.target, edit.id, 0, edit.value)
                break
              case 'deletePartition':
                drawer.deletePartition(edit.target, edit.id, edit.partitionIndex)
                break
            }
          }
          if (combo.displayedSets != null) {
            const drawer = useComboDrawerStore.getState()
            if (combo.displayedSets.relics != null) drawer.updateSelectedSets(combo.displayedSets.relics, false)
            if (combo.displayedSets.ornaments != null) drawer.updateSelectedSets(combo.displayedSets.ornaments, true)
            persistSelectedSets()
          }
          // 抽屉关闭:序列化回表单并写角色存储(comboDrawerService.flushComboDrawerToForm)
          flushComboDrawerToForm()
          useComboDrawerStore.getState().reset()
        }
      }

      // ⑧ teammates:网页端 updateTeammate(选人/换光锥)或字段合并(formOverrides 语义)
      if (input.teammates != null) {
        for (const [index, slot] of input.teammates.entries()) {
          if (index > 2) break
          const slotIndex = index as 0 | 1 | 2
          applied.teammateSlots.push(slotIndex)
          if (slot == null) {
            useOptimizerRequestStore.getState().clearTeammate(slotIndex)
            continue
          }
          const { characterConditionals, lightConeConditionals, ...plainFields } = slot as Record<string, unknown>
          // 换光锥必须走上游 updateTeammate 的换锥分支(updateTeammate.ts:24-45):
          // lightConeChanged 时把 lightConeConditionals 重置为新锥默认,而不是沿用
          // 旧锥条件键 — 键名冲突时(如 dmgBuff)残留值会静默覆盖新锥默认值。
          if (typeof plainFields.lightCone === 'string') {
            const current = useOptimizerRequestStore.getState().teammates[slotIndex]
            if (current?.characterId) {
              updateTeammate({ [`teammate${slotIndex}`]: { lightCone: plainFields.lightCone } } as Any)
              delete plainFields.lightCone
            }
          }
          if (applied.syncFromRoster && typeof plainFields.characterId === 'string') {
            // 「从角色列表同步」:只传 characterId 走 updateTeammate 的选人路径
            // (带入星魂/光锥/叠影/队伍套装,换人重置条件,联动队伍感知套装预设)
            updateTeammate({ [`teammate${slotIndex}`]: { characterId: plainFields.characterId } } as Any)
            const { characterId: _used, ...rest } = plainFields
            if (Object.keys(rest).length > 0) applyPlainTeammateFields(slotIndex, rest)
          } else {
            applyPlainTeammateFields(slotIndex, plainFields)
          }
          applyTeammateConditionalsViaLinkage(slotIndex, { characterConditionals, lightConeConditionals })
        }
      }

      // ⑨ statSimulations:statSimulationController 的列表管理语义
      if (input.statSimulations != null) {
        const ops = input.statSimulations
        const statSim = currentStatSim()
        const simulations = [...statSim.simulations]

        if (ops.deleteAll === true) {
          simulations.length = 0
          applied.statSimulations.deletedAll = true
        }
        if (ops.delete != null) {
          const existingKeys = new Set(simulations.map((sim) => sim.key))
          for (const key of ops.delete.keys) {
            if (!existingKeys.has(key)) {
              throw new Error(`update_form: statSimulations.delete 的 key "${key}" 不存在 — 现有 key: ${[...existingKeys].join(', ') || '(无)'}`)
            }
          }
          const removed = new Set(ops.delete.keys)
          for (let i = simulations.length - 1; i >= 0; i--) {
            if (removed.has(simulations[i].key!)) simulations.splice(i, 1)
          }
          applied.statSimulations.deleted.push(...ops.delete.keys)
        }
        for (const entry of ops.add ?? []) {
          const label = `statSimulations.add[${entry.name ?? simulations.length}]`
          assertSimRequest(entry.request as SimulationRequest, label)
          const simType = entry.simType === 'benchmarks' ? StatSimTypes.Benchmarks : StatSimTypes.SubstatRolls
          const hash = hashSimulation(simType, entry.request as SimulationRequest)
          for (const existing of simulations) {
            if (hash === hashSimulation(existing.simType, existing.request)) {
              // 网页端重复保存直接拒绝(statSimulationController.saveStatSimulationRequest)
              throw new Error(
                `update_form: ${label} 的内容与已存模拟「${existing.name ?? existing.key}」完全相同 — 网页端不允许重复保存;如需更新请用 overwrite`,
              )
            }
          }
          const simulation: Simulation = {
            name: entry.name ?? '',
            key: uuid(),
            simType,
            request: { ...entry.request } as Simulation['request'],
          }
          simulations.push(simulation)
          applied.statSimulations.added.push(simulation.key!)
        }
        if (ops.overwrite != null) {
          const index = simulations.findIndex((sim) => sim.key === ops.overwrite!.key)
          if (index === -1) {
            throw new Error(
              `update_form: statSimulations.overwrite 的 key "${ops.overwrite.key}" 不存在 — 现有 key: ${
                simulations.map((sim) => sim.key).join(', ') || '(无)'
              }`,
            )
          }
          assertSimRequest(ops.overwrite.request as SimulationRequest, 'statSimulations.overwrite')
          const replacement: Simulation = {
            name: ops.overwrite.name ?? ops.overwrite.request.name ?? simulations[index].name ?? '',
            key: uuid(),
            simType: simulations[index].simType,
            request: { ...ops.overwrite.request } as Simulation['request'],
          }
          // 查重排除被覆盖的那条(网页端同款)
          const hash = hashSimulation(replacement.simType, replacement.request)
          for (const [i, existing] of simulations.entries()) {
            if (i === index) continue
            if (hash === hashSimulation(existing.simType, existing.request)) {
              throw new Error(`update_form: statSimulations.overwrite 的内容与已存模拟「${existing.name ?? existing.key}」完全相同 — 网页端不允许重复保存`)
            }
          }
          simulations[index] = replacement
          applied.statSimulations.overwritten.push(replacement.key!)
        }
        if (ops.load != null) {
          const entry = simulations.find((sim) => sim.key === ops.load!.key)
          if (!entry) {
            throw new Error(
              `update_form: statSimulations.load 的 key "${ops.load.key}" 不存在 — 现有 key: ${simulations.map((sim) => sim.key).join(', ') || '(无)'}`,
            )
          }
          applied.statSimulations.loadedKey = entry.key ?? null
          // 回填到对应模式的输入区(未选主词条 0 值转 null,网页端同款)
          const backfilled = blankMainsToNull(entry.request)
          if (entry.simType === StatSimTypes.Benchmarks) statSim.benchmarks = backfilled
          else statSim.substatRolls = backfilled
        }

        useOptimizerRequestStore.getState().setStatSim({ ...statSim, simulations } as Any)
        applied.statSimulations.total = simulations.length
      }

      // ⑩ 持久化:displayToInternal(存储) → { ...found.form, ...form }
      //    (syncFormToCharacterStore 的合并形状,comboDrawerUtils.ts:50)
      const finalForm = displayToInternal(useOptimizerRequestStore.getState())
      const found = getCharacterById(target as CharacterId)!
      useCharacterStore.getState().setCharacter({ ...found, form: { ...found.form, ...finalForm } })
      runtimeContext.markDirty()

      warnings.push(...collectFormWarnings(finalForm))
      return {
        target,
        switchedFrom: input.characterId != null && sessionPointer !== input.characterId ? (sessionPointer ?? null) : null,
      }
    }, input.baseRevision != null ? { baseRevision: input.baseRevision } : {})

    // 应用后回显
    const character = requireSaveCharacter(outcome.target)
    const savedForm = character.form!
    const comboEcho = expandComboMatrix(savedForm)
    const sims = savedForm.statSim?.simulations ?? []

    return toolResult(
      {
        updated: true,
        characterId: character.id,
        switchedFrom: outcome.switchedFrom,
        revision: runtimeContext.getRevision(),
        dirty: true,
        applied,
        combo: {
          comboType: comboEcho.comboType,
          preprocessor: comboEcho.preprocessor,
          turnAbilities: comboEcho.turnAbilities,
          stateJsonBytes: comboEcho.stateJsonBytes,
          displayedSets: comboEcho.displayedSets,
        },
        statSimulations: {
          total: sims.length,
          simulations: sims.map((sim) => ({
            key: sim.key ?? '',
            name: sim.name ?? null,
            simType: String(sim.simType),
          })),
        },
        warnings,
      },
      `已更新 ${character.id} 的优化器表单(${describeActions(applied)}),revision=${runtimeContext.getRevision()}`
        + (warnings.length > 0 ? `;${warnings.length} 条校验警告(表单已照常应用)` : ''),
    )
  })
}

/** 队友非条件字段的直接合并(formOverrides 语义;队伍套装 null → undefined) */
function applyPlainTeammateFields(index: 0 | 1 | 2, fields: Record<string, unknown>): void {
  if (Object.keys(fields).length === 0) return
  if (fields.characterId === null) {
    useOptimizerRequestStore.getState().clearTeammate(index)
    return
  }
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = key === 'teamRelicSet' || key === 'teamOrnamentSet' ? (value ?? undefined) : value
  }
  useOptimizerRequestStore.getState().setTeammate(index, safe as Partial<TeammateState>)
}

/** 队友条件统一经 handleConditionalChange 联动(同步连招默认值、保留逐回合覆写) */
function applyTeammateConditionalsViaLinkage(
  index: 0 | 1 | 2,
  conds: { characterConditionals?: unknown, lightConeConditionals?: unknown },
): void {
  for (const condType of ['characterConditionals', 'lightConeConditionals'] as const) {
    const map = conds[condType] as Record<string, unknown> | undefined
    if (map == null) continue
    validateTeammateConditionalKeys(index, { [condType]: map })
    for (const [key, value] of Object.entries(map)) {
      handleConditionalChange([`teammate${index}`, condType, key], value as boolean | number)
    }
  }
}

function describeActions(applied: {
  patch: string[],
  preset: { spd: number } | null,
  reset: string | null,
  fromBuild: string | null,
  comboEdits: number,
  comboSetsUpdated: boolean,
  teammateSlots: number[],
  statSimulations: { added: string[], overwritten: string[], deleted: string[], deletedAll: boolean },
}): string {
  const parts: string[] = []
  if (applied.fromBuild != null) parts.push(`载入配装「${applied.fromBuild}」`)
  if (applied.reset != null) parts.push(`重置 ${applied.reset}`)
  if (applied.preset != null) parts.push(`推荐预设 spd=${applied.preset.spd}`)
  if (applied.patch.length > 0) parts.push(`patch ${applied.patch.length} 字段`)
  if (applied.comboEdits > 0) parts.push(`连招矩阵 ${applied.comboEdits} 处编辑`)
  if (applied.comboSetsUpdated) parts.push('矩阵套装行更新')
  if (applied.teammateSlots.length > 0) parts.push(`队友位 ${applied.teammateSlots.join('/')}`)
  const simOps = applied.statSimulations
  if (simOps.added.length > 0) parts.push(`模拟 +${simOps.added.length}`)
  if (simOps.overwritten.length > 0) parts.push(`模拟覆盖 ${simOps.overwritten.length}`)
  if (simOps.deleted.length > 0) parts.push(`模拟删除 ${simOps.deleted.length}`)
  if (simOps.deletedAll) parts.push('模拟全清')
  return parts.join(' → ') || '无字段变更'
}
