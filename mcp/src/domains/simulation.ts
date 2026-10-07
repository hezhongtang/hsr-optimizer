// Simulation domain: `simulate_build`, `stat_simulate`, `analyze_build` and
// `benchmark_runs` — headless versions of the Optimizer tool page's simulation
// surfaces, all running the same upstream engine code as the web UI:
//
//   simulate_build  → simulateBuild() — the per-row combat engine behind the
//                     optimizer grid rows and the Expanded Data Panel
//   stat_simulate   → runStatSimulations() — the Stat Simulations tab's
//                     hypothetical-build batch simulator
//   analyze_build   → generateAnalysisData's pipeline (minus the grid-coupled
//                     row-id decode, relics come in as explicit ids):
//                     calculateStatUpgrades + calculateTeammateUpgrades +
//                     extractDamageSplits on trace=true double simulations
//   benchmark_runs  → runCustomBenchmarkOrchestrator() — the Benchmarks tab's
//                     custom benchmark (SEQUENTIAL_BENCHMARKS inline search),
//                     fanned out over 4pc-set × SPD-threshold presets; with
//                     sweep="sets" it is the metadata-test Set Benchmark
//                     Auditor instead (runAudit over the generated set grid)
//
// Damage-split labels resolve through the offline i18next bootstrap
// (ensureI18nReady → zh_CN), the same singleton upstream reads.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import i18next from 'i18next'
import {
  applyScoringMetadataPresets,
  applySetConditionalPresets,
  applyTeamAwareSetConditionalPresets,
  applyTeammateConditionalPresets,
  resolveTeammateInfo,
} from 'lib/conditionals/evaluation/applyPresets'
import {
  ElementToDamage,
  Parts,
  PartsMainStats,
  PathNames,
  Stats,
  SubStats,
} from 'lib/constants/constants'
import type { SingleRelicByPart } from 'lib/gpu/webgpuTypes'
import { BasicStatsArrayCore } from 'lib/optimization/basicStatsArray'
import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { defaultSetConditionals } from 'lib/optimization/defaultForm'
import {
  GlobalRegister,
  StatKey,
} from 'lib/optimization/engine/config/keys'
import { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import { SortOption } from 'lib/optimization/sortOptions'
import { RelicFilters } from 'lib/relics/relicFilters'
import { getElementalDmgFromContainer } from 'lib/scoring/simScoringUtils'
import {
  SetsOrnamentsNames,
  SetsRelicsNames,
} from 'lib/sets/setConfigRegistry'
import { aggregatePerActionBuffs } from 'lib/simulations/combatBuffsAnalysis'
import { transformOptimizerDisplayData } from 'lib/simulations/optimizerDisplayDataTransform'
import { runCustomBenchmarkOrchestrator } from 'lib/simulations/orchestrator/runCustomBenchmarkOrchestrator'
import {
  precomputeSetState,
  simulateBuild,
} from 'lib/simulations/simulateBuild'
import { runStatSimulations } from 'lib/simulations/statSimulation'
import { StatSimTypes } from 'lib/simulations/statSimulationTypes'
import type {
  Simulation,
  SimulationRelicByPart,
  SimulationRequest,
} from 'lib/simulations/statSimulationTypes'
import {
  convertRelicsToSimulation,
  ornamentSetIndexToName,
  relicSetIndexToNames,
} from 'lib/simulations/statSimulationUtils'
import { blankSimRequest } from 'lib/simulations/utils/requestUtils'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  getCharacterById,
  getCharacters,
  useCharacterStore,
} from 'lib/stores/character/characterStore'
import { displayToInternal } from 'lib/stores/optimizerForm/optimizerFormConversions'
import { computeLoadForm } from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import type { OptimizerRequestState } from 'lib/stores/optimizerForm/optimizerFormTypes'
import { getRelicById } from 'lib/stores/relic/relicStore'
import { getScoringMetadata } from 'lib/stores/scoring/scoringStore'
import type {
  BenchmarkForm,
  SimpleCharacter,
} from 'lib/tabs/tabBenchmarks/useBenchmarksTabStore'
import { getErrRopePermutations } from 'lib/tabs/tabMetadata/setAuditor/setAuditorConstants'
import {
  generateOrnamentSetCombos,
  generateParamCombos,
  generateRelicSetCombos,
  runAudit,
} from 'lib/tabs/tabMetadata/setAuditor/setAuditorEngine'
import type {
  AuditorConfig,
  AuditorResults,
} from 'lib/tabs/tabMetadata/setAuditor/setAuditorTypes'
import { extractDamageSplits } from 'lib/tabs/tabOptimizer/analysis/damageSplitsExtractor'
import {
  calculateStatUpgrades,
  calculateTeammateUpgrades,
} from 'lib/tabs/tabOptimizer/analysis/expandedDataPanelController'
import type { OptimizerResultAnalysis } from 'lib/tabs/tabOptimizer/analysis/expandedDataPanelController'
import { uuid } from 'lib/utils/miscUtils'
import {
  clone,
  objectHash,
} from 'lib/utils/objectUtils'
import type {
  Character,
  CharacterId,
} from 'types/character'
import type { Form } from 'types/form'
import type { LightConeId } from 'types/lightCone'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { applyFormOverrides } from '../permutations'
import {
  serializeActionDamage,
  serializeBuff,
  serializeComputedStats,
  serializeDamageSplits,
  serializeRotationDamageStep,
} from '../serializers/stats'
import { toolResult } from '../toolResult'
import {
  finishJob,
  linkedAbortController,
  nextJobId,
  registerJob,
  updateJobProgress,
} from './jobs'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const MAX_STAT_SIM_VARIANTS = 12
const MAX_BENCHMARK_PRESETS = 16
// Default top-candidates echo per preset (the pre-M9 shape); `candidateLimit`
// widens it up to MAX_BENCHMARK_CANDIDATES for the full-results read.
const TOP_BENCHMARK_CANDIDATES = 5
const MAX_BENCHMARK_CANDIDATES = 50
// sweep=sets grid cap (set combos × param combos + reference runs) — the
// presets-mode MAX_BENCHMARK_PRESETS semantics applied to a generated grid:
// refuse up front with a narrowing hint instead of running for hours.
const MAX_SWEEP_RUNS = 512
const DEFAULT_SWEEP_SET_TYPES = ['relic4p', 'ornament'] as const
const DEFAULT_SWEEP_SPD_BREAKPOINTS = [0, 133, 160]
const FORM_OVERRIDES_DESCRIPTION = '合并部分 display 表单或 get_form/default_form 内部字段,嵌套对象与队友按键合并;内部别名优先。'
  + 'flat minCr/minCd 等使用小数,nested statFilters 使用百分数;format:"internal"/"display" 指定 combatBuffs 百分比单位。'
  + '未指定 format 时有内部专有字段则 combatBuffs 用小数,否则用百分数。characterId 必须匹配调用角色。'

const RELIC_SET_NAMES = new Set<string>(SetsRelicsNames)
const ORNAMENT_SET_NAMES = new Set<string>(SetsOrnamentsNames)
const SUBSTAT_NAMES = new Set<string>(SubStats)

// outputSchema 形状——以各 handler 实际 return 的对象为准(serializers/stats.ts 的
// 序列化结果)。trace 分支才出现的 damageSplits/buffs 按 .optional() 声明。
const serializedBuffSchema = z.object({
  stat: z.string(),
  value: z.number(),
  memo: z.boolean(),
  source: z.object({ id: z.string(), label: z.string(), ability: z.string(), buffType: z.string() }),
  damageTags: z.number().optional(),
  damageTagsLabel: z.string().optional(),
  outputTagsLabel: z.string().optional(),
})

const rotationDamageStepSchema = z.object({
  actionType: z.string(),
  actionName: z.string(),
  damage: z.number(),
  buffStat: z.number().optional(),
})

const computedStatsSchema = z.object({
  computed: z.record(z.string(), z.number()),
  basic: z.record(z.string(), z.number()),
  combo: z.object({ damage: z.number(), heal: z.number(), shield: z.number(), buff: z.number() }).optional(),
  entities: z.array(z.object({
    name: z.string(),
    memosprite: z.boolean(),
    stats: z.record(z.string(), z.number()),
  })),
})

const damageSplitsSchema = z.object({
  byAbility: z.array(z.object({
    name: z.string(),
    total: z.number(),
    segments: z.array(z.object({
      damageType: z.number(),
      label: z.string(),
      damage: z.number(),
      hitIndex: z.number(),
    })),
  })),
  rotation: z.array(z.object({
    name: z.string(),
    total: z.number(),
    segments: z.array(z.object({
      damageType: z.number(),
      label: z.string(),
      damage: z.number(),
      hitIndex: z.number(),
    })),
  })),
})

/** echoSimRequest 的序列化结果(变体/基准请求回显)。stats 与 dps_score 同源:
 * 上游类型声明为 Record<string, number>,但编排器产出的请求实测对不适用词条
 * (如 DEF%)填 null,按实际返回放宽。 */
const echoedSimRequestSchema = z.object({
  relicSet1: z.string(),
  relicSet2: z.string(),
  ornamentSet: z.string().nullable(),
  body: z.string(),
  feet: z.string(),
  planarSphere: z.string(),
  linkRope: z.string(),
  stats: z.record(z.string(), z.union([z.number(), z.null()])),
})

/** 基准候选行(网页端结果表一行):请求回显 + 分数 + 与最优行的差距;
 * includeCandidateDetails=true 时再带 basicStats/combatStats(展开行的面板
 * 与战斗属性)、actionDamage/rotationDamage(各技能伤害)。详情字段刻意避开
 * 请求回显里的 stats 键——那是副词条 roll 数。 */
const benchmarkCandidateSchema = echoedSimRequestSchema.extend({
  simScore: z.number(),
  deltaPercentVsTop: z.number().optional(),
  deltaBaselinePercent: z.number().optional(),
  basicStats: z.record(z.string(), z.number()).optional(),
  combatStats: z.record(z.string(), z.number()).optional(),
  actionDamage: z.record(z.string(), z.number()).nullable().optional(),
  rotationDamage: z.array(rotationDamageStepSchema).optional(),
})

/** fromCache 引用(optimize 返回的 cacheId;rowId 给出时同时取该行配装)。 */
const cachedRunRefSchema = z.object({
  cacheId: z.string().describe('optimize 返回的 cacheId(仅最近一次运行被缓存)'),
  rowId: z.number().optional().describe('目标行的 row id;给出后分析配装取该行(仅该行配装,不改其它行为)'),
})

// ─── shared helpers ──────────────────────────────────────────────────────────

function requireCharacter(characterId: string): Character {
  const character = getCharacterById(characterId as Any)
  if (!character) {
    throw new Error(`角色 ${characterId} 未在当前存档中——已载入角色: ${getCharacters().map((c) => c.id).join(', ')}`)
  }
  return character
}

/** Character's saved optimizer form → internal Form, with optional agent overrides merged in. */
function buildCharacterForm(character: Character, formOverrides?: Record<string, unknown>): Form {
  const state = computeLoadForm(character.form)
  if (formOverrides) applyFormOverrides(state, formOverrides)
  const form = displayToInternal(state) as Form
  form.characterId = character.id
  return form
}

/** Validate the requested presets' set names before spending any CPU on them. */
function assertRelicSetName(name: string): void {
  if (!RELIC_SET_NAMES.has(name)) {
    throw new Error(`未知遗器套装 "${name}"——须为游戏内套装名(如 "Scholar Lost in Erudition")`)
  }
}

function assertOrnamentSetName(name: string): void {
  if (!ORNAMENT_SET_NAMES.has(name)) {
    throw new Error(`未知位面饰品套装 "${name}"——须为游戏内饰品套装名(如 "Firmament Frontline: Glamoth")`)
  }
}

/**
 * Resolve explicit relic ids (≤6, one per part) into a part→relicId map; when
 * `relicIds` is omitted the character's currently equipped build is used.
 */
function resolveBuildByPart(characterId: string, relicIds?: string[]): Partial<Record<string, string | undefined>> {
  if (relicIds == null) {
    const equipped: Partial<Record<string, string | undefined>> = {}
    for (const [part, relicId] of Object.entries(requireCharacter(characterId).equipped)) {
      if (relicId) equipped[part] = relicId
    }
    if (Object.keys(equipped).length === 0) {
      throw new Error(`角色 ${characterId} 当前没有装备任何遗器——请先装备(equip_build)或显式传入 relicIds`)
    }
    return equipped
  }

  const byPart: Record<string, string> = {}
  for (const relicId of relicIds) {
    const relic = getRelicById(relicId)
    if (!relic) throw new Error(`遗器 ${relicId} 不在当前库存中——请检查 id 或重新 load_save`)
    if (byPart[relic.part]) throw new Error(`部件 ${relic.part} 传入了多件遗器(${byPart[relic.part]} 与 ${relicId})——每部件只能一件`)
    byPart[relic.part] = relicId
  }
  if (relicIds.length > 6) throw new Error(`一次最多 6 件遗器,收到 ${relicIds.length} 件`)
  return byPart
}

/**
 * Hydrate a part→relicId build into SimulationRelic-compatible relics: clone
 * the store relics (upstream clones too — condensation mutates the relic) and
 * condense substats+main via RelicFilters.condenseSingleRelicByPartSubstatsForOptimizer,
 * exactly the generateAnalysisData recipe. Missing parts are filled by
 * simulateBuild itself with blank relics.
 */
function toSimulationRelics(byPart: Partial<Record<string, string | undefined>>): Partial<SingleRelicByPart> {
  const single: Partial<SingleRelicByPart> = {}
  for (const [part, relicId] of Object.entries(byPart)) {
    if (!relicId) continue
    const relic = getRelicById(relicId)
    if (!relic) throw new Error(`遗器 ${relicId} 不在当前库存中——请检查 id 或重新 load_save`)
    single[part as Parts] = clone(relic)
  }
  RelicFilters.condenseSingleRelicByPartSubstatsForOptimizer(single)
  return single
}

/** OptimizerTab t function over the offline zh_CN bundles (labels for damage splits etc.). */
function optimizerTabT(): Any {
  ensureI18nReady()
  return i18next.getFixedT(null, 'optimizerTab')
}

/** Compact echo of a SimulationRequest for responses. */
function echoSimRequest(request: {
  simRelicSet1: string,
  simRelicSet2: string,
  simOrnamentSet?: string,
  simBody: string,
  simFeet: string,
  simPlanarSphere: string,
  simLinkRope: string,
  stats: Record<string, number>,
}) {
  return {
    relicSet1: request.simRelicSet1,
    relicSet2: request.simRelicSet2,
    ornamentSet: request.simOrnamentSet ?? null,
    body: request.simBody,
    feet: request.simFeet,
    planarSphere: request.simPlanarSphere,
    linkRope: request.simLinkRope,
    stats: { ...request.stats },
  }
}

// ─── fromCache (optimizer.analysis.read) ─────────────────────────────────────
//
// The web's expanded-data-panel analysis (`getCachedForm`) runs against the
// form THE RUN used — i.e. the saved form with that optimize call's
// formOverrides already merged. MCP mirrors it by starting from
// runtimeContext's cached `displayState` (the exact state optimize passed
// through displayToInternal, see domains/optimizer.ts cacheOptimizeResult).
// This is the same resolution equipment.ts's private resolveCachedBuild does
// for equip_build/save_build; re-implemented here over the public
// runtimeContext.getLastOptimizeResult() API so equipment.ts stays untouched
// (cross-file dependency is documented in the M9 report).

function resolveCachedRun(
  fromCache: { cacheId: string, rowId?: number | undefined },
  characterId: string,
): {
  state: OptimizerRequestState,
  build: Partial<Record<string, string | undefined>> | null,
  rowId: number | null,
} {
  const cached = runtimeContext.getLastOptimizeResult()
  if (!cached || cached.summary.cacheId !== fromCache.cacheId) {
    throw new Error(`fromCache: 找不到 cacheId ${fromCache.cacheId} 的结果缓存 — 请使用最近一次 optimize 返回的 cacheId(仅最近一次运行被缓存)`)
  }
  if (cached.generation !== runtimeContext.getSaveGeneration()) {
    throw new Error('fromCache: 结果缓存属于上一次 load_save 之前的存档 — 请对当前存档重新运行 optimize')
  }
  if (cached.summary.characterId !== characterId) {
    throw new Error(`fromCache: 缓存归属角色 ${cached.summary.characterId} 与请求角色 ${characterId} 不一致`)
  }
  if (fromCache.rowId != null) {
    const rowIndex = cached.rows.findIndex((row) => row.id === fromCache.rowId)
    if (rowIndex === -1) {
      throw new Error(`fromCache: 缓存中没有 row id ${fromCache.rowId} 的结果行`)
    }
    return { state: cached.displayState, build: cached.builds[rowIndex] ?? {}, rowId: fromCache.rowId }
  }
  return { state: cached.displayState, build: null, rowId: null }
}

/** Cached run's display state (already formOverrides-merged) → internal Form;
 * optional extra overrides still merge on top. */
function formFromDisplayState(
  state: OptimizerRequestState,
  formOverrides: Record<string, unknown> | undefined,
  characterId: string,
): Form {
  const merged = clone(state) as Any
  if (formOverrides) applyFormOverrides(merged, formOverrides)
  const form = displayToInternal(merged) as Form
  form.characterId = characterId as Any
  return form
}

/** Validate manual set-conditional keys (web drawer vocabulary: any game set). */
function assertSetConditionalKeys(conditionals: Record<string, boolean | number>): void {
  for (const name of Object.keys(conditionals)) {
    if (!RELIC_SET_NAMES.has(name) && !ORNAMENT_SET_NAMES.has(name)) {
      throw new Error(`未知套装 "${name}"——setConditionals 的键须为游戏内遗器或位面饰品套装名(如 "Pioneer Diver of Dead Waters"、"Rutilant Arena")`)
    }
  }
}

// ─── benchmark_runs candidates (result-table rows) ───────────────────────────

/**
 * One row of the web result table (BenchmarkResults.aggregateCandidates):
 * request echo + simScore. With `detail`, also the ExpandedRow payload —
 * panel/combat stats (elemental DMG combined the way CharacterStatSummary
 * displays it) plus per-ability and rotation damage.
 */
function serializeBenchmarkCandidate(args: {
  candidate: Simulation,
  element: string,
  elementalDmgValue: string,
  detail: boolean,
}): Record<string, unknown> {
  const { candidate, element, elementalDmgValue, detail } = args
  const result = candidate.result
  if (!result) throw new Error('基准候选缺少模拟结果(引擎异常)——请重试或上报')

  const entry: Record<string, unknown> = {
    simScore: result.simScore,
    ...echoSimRequest(candidate.request),
  }
  if (!detail) return entry

  // computeOptimalSimulationWorker strips result.x; the web ExpandedRow
  // rebuilds the container from the typed arrays (BenchmarkResults.tsx).
  const x = result.x ?? ComputedStatsContainer.fromArrays(result.xa, result.ca)
  const stats = serializeComputedStats(x)
  // Web display combines DMG_BOOST + the character's element boost into the
  // elemental DMG entry before rendering combat stats.
  stats.computed[elementalDmgValue] = getElementalDmgFromContainer(x, element as Any)
  entry.basicStats = stats.basic
  entry.combatStats = stats.computed
  entry.actionDamage = result.actionDamage ? serializeActionDamage(result.actionDamage) : null
  entry.rotationDamage = (result.rotationDamage ?? []).map(serializeRotationDamageStep)
  return entry
}

/** Web delta columns: vs the batch's top row and vs the top→baseline range. */
function candidateDeltaPercents(score: number, top: number, baseline: number): {
  deltaPercentVsTop: number,
  deltaBaselinePercent: number,
} {
  return {
    deltaPercentVsTop: top !== 0 ? ((top - score) / top) * 100 : 0,
    deltaBaselinePercent: top !== baseline ? ((top - score) / (top - baseline)) * 100 : 0,
  }
}

// ─── benchmark_runs sweep="sets" (Set Benchmark Auditor, headless) ───────────
//
// Mirrors the metadata-test page's SetBenchmarkAuditor: runAudit over the
// generated set grid (all 4pc / 2p2p representative pairs / ornaments × the
// param combos), against the reference build from the character's simulation
// scoring metadata. Same batch semantics as presets mode: one job per batch,
// progress completedPresets/totalPresets, cooperative cancel between benchmark
// runs, every throwing validation BEFORE registerJob (the M4 lesson — a job
// registered earlier would stay running forever).

type SweepOptionsInput = {
  setTypes?: Array<'relic4p' | 'relic2p2p' | 'ornament'> | undefined,
  spdBreakpoints?: number[] | undefined,
  modes?: Array<'dps' | 'subDps'> | undefined,
  errRope?: Array<'noErr' | 'err'> | undefined,
  scoringModes?: Array<'benchmark' | 'perfection'> | undefined,
}

async function runSetSweep(args: {
  character: Character | null,
  characterId: string,
  simulationMetadata: Any,
  sweepOptions: SweepOptionsInput | undefined,
  lightCone: string | undefined,
  lightConeSuperimposition: number | undefined,
  characterEidolon: number | undefined,
  teammates:
    | Array<{
      characterId: string,
      lightCone?: string,
      characterEidolon?: number,
      lightConeSuperimposition?: number,
    }>
    | undefined,
  extra: Any,
}): Promise<CallToolResult> {
  const {
    character,
    characterId,
    simulationMetadata,
    sweepOptions,
    lightCone,
    lightConeSuperimposition,
    characterEidolon,
    teammates,
    extra,
  } = args

  if (sweepOptions?.setTypes != null && sweepOptions.setTypes.length === 0) {
    throw new Error('benchmark_runs: sweepOptions.setTypes 不能为空——至少勾选一种套装类型(网页端同样拒绝空多选)')
  }
  if (sweepOptions?.spdBreakpoints != null && sweepOptions.spdBreakpoints.length === 0) {
    throw new Error('benchmark_runs: sweepOptions.spdBreakpoints 不能为空——至少勾选一个速度档位(网页端同样拒绝空多选)')
  }

  const setTypes = sweepOptions?.setTypes ?? [...DEFAULT_SWEEP_SET_TYPES]
  const spdBreakpoints = sweepOptions?.spdBreakpoints ?? DEFAULT_SWEEP_SPD_BREAKPOINTS
  const scoringModes = sweepOptions?.scoringModes ?? ['perfection']
  // Web defaults: sub-DPS characters audit in subDps mode, others dps; ERR rope
  // permutations come from the metadata (allowed at E0 → both, else noErr only)
  const modes = sweepOptions?.modes ?? [simulationMetadata.deprioritizeBuffs ? 'subDps' : 'dps']
  const allowedErr = getErrRopePermutations(simulationMetadata).map((v) => v ? 'err' : 'noErr') as Array<'err' | 'noErr'>
  const errRopeModes = sweepOptions?.errRope ?? allowedErr

  // Reference build: first recommended relic set + first recommended ornament
  // (runAudit's own derivation — precomputed here for validation and the cap)
  const defaultRelic1 = simulationMetadata.relicSets?.[0]?.[0]
  const defaultRelic2 = simulationMetadata.relicSets?.[0]?.[1] ?? defaultRelic1
  const defaultOrnament = simulationMetadata.ornamentSets?.[0]
  if (defaultRelic1 == null || defaultOrnament == null) {
    throw new Error(`角色 ${characterId} 的评分元数据没有推荐套装(relicSets/ornamentSets 为空)——无法确定套装审计的参照配装`)
  }

  const paramCombos = generateParamCombos(simulationMetadata, {
    spdBreakpoints,
    modes,
    errRope: errRopeModes,
  } as Any)
  const setCombos = [
    ...(setTypes.includes('relic4p') || setTypes.includes('relic2p2p')
      ? generateRelicSetCombos(defaultOrnament).filter((combo) => setTypes.includes(combo.type))
      : []),
    ...(setTypes.includes('ornament') ? generateOrnamentSetCombos(defaultRelic1, defaultRelic2) : []),
  ]
  const totalRuns = setCombos.length * paramCombos.length + paramCombos.length
  if (totalRuns > MAX_SWEEP_RUNS) {
    throw new Error(
      `benchmark_runs: 套装审计网格共 ${totalRuns} 次基准运行,超过上限 ${MAX_SWEEP_RUNS}`
        + `(套装组合 ${setCombos.length} × 参数组合 ${paramCombos.length} + 参照 ${paramCombos.length})`
        + ' — 请收窄 sweepOptions:减少 spdBreakpoints/modes/errRope 档位,或缩小 setTypes(例如只扫 ["ornament"])',
    )
  }

  // Web auditor semantics: selecting a character resets eidolon to 0 and
  // superimposition to 1; the light cone still has to come from somewhere.
  // Un-owned characters (web benchmarks semantics) have no saved form to fall
  // back on, so the light cone must be explicit.
  const effectiveLightCone = lightCone ?? character?.form.lightCone
  if (!effectiveLightCone) {
    throw new Error(
      character == null
        ? `角色 ${characterId} 不在当前存档中且未传入 lightCone——网页端未入库角色需要手动选择光锥后才能生成基准,请显式传入 lightCone`
        : `角色 ${characterId} 没有配置光锥(存档表单与覆盖项均为空)——请先 upsert_character 设置光锥或传入 lightCone`,
    )
  }
  if (!(getGameMetadata().lightCones as Record<string, unknown>)[effectiveLightCone]) {
    throw new Error(`未知光锥 id ${effectiveLightCone}`)
  }

  // Teammates: explicit overrides win, else the scoring metadata's team
  // (same resolution as presets mode). Team sets are intentionally NOT passed
  // through here: the web auditor page explicitly clears them when seeding its
  // teammates (SetBenchmarkAuditor.tsx onCharacterSelect → updateTeammate with
  // teamRelicSet/teamOrnamentSet: undefined).
  const defaultTeammates = ((simulationMetadata as Any).teammates ?? []) as Array<{
    characterId: string,
    lightCone?: string,
    characterEidolon?: number,
    lightConeSuperimposition?: number,
  }>
  const requestedTeammates = teammates ?? defaultTeammates.map((mate) => ({
    characterId: mate.characterId,
    lightCone: mate.lightCone,
    characterEidolon: mate.characterEidolon ?? 0,
    lightConeSuperimposition: mate.lightConeSuperimposition ?? 1,
  }))
  const resolvedTeammates: SimpleCharacter[] = requestedTeammates.map((mate, index) => ({
    characterId: mate.characterId as CharacterId,
    lightCone: (mate.lightCone ?? defaultTeammates[index]?.lightCone) as LightConeId,
    characterEidolon: mate.characterEidolon ?? defaultTeammates[index]?.characterEidolon ?? 0,
    lightConeSuperimposition: mate.lightConeSuperimposition ?? defaultTeammates[index]?.lightConeSuperimposition ?? 1,
  }))
  while (resolvedTeammates.length < 3) {
    const fallback = defaultTeammates[resolvedTeammates.length]
    if (!fallback) throw new Error('套装审计需要三名队友——评分元数据推荐队不完整且未通过 teammates 覆盖')
    resolvedTeammates.push({
      characterId: fallback.characterId as CharacterId,
      lightCone: fallback.lightCone as LightConeId,
      characterEidolon: fallback.characterEidolon ?? 0,
      lightConeSuperimposition: fallback.lightConeSuperimposition ?? 1,
    })
  }
  for (const mate of resolvedTeammates) {
    if (!(getGameMetadata().characters as Record<string, unknown>)[mate.characterId]) {
      throw new Error(`队友角色 id ${mate.characterId} 不存在于游戏元数据`)
    }
    if (mate.lightCone == null || !(getGameMetadata().lightCones as Record<string, unknown>)[mate.lightCone]) {
      throw new Error(`队友 ${mate.characterId} 的光锥 "${mate.lightCone ?? ''}" 不存在——请显式传入 teammates 或修正评分元数据`)
    }
  }

  const config: AuditorConfig = {
    spdBreakpoints,
    modes,
    errRope: errRopeModes,
    setTypes,
    lightCone: effectiveLightCone as LightConeId,
    characterEidolon: characterEidolon ?? 0,
    lightConeSuperimposition: lightConeSuperimposition ?? 1,
    teammates: resolvedTeammates,
    scoringModes,
  } // Inline benchmark search on the main thread (the presets-mode pattern)
  ;(globalThis as Any).SEQUENTIAL_BENCHMARKS = true

  // Everything above can throw — register the job only now (M4 lesson)
  const jobId = nextJobId('bench')
  const cancelController = linkedAbortController(extra.signal)
  const cancelRef = { current: false }
  registerJob(jobId, 'benchmark_runs', {
    cancel: () => {
      cancelController.abort()
      cancelRef.current = true
    },
    summary: {
      sweep: 'sets',
      characterId,
      setTypes,
      spdBreakpoints,
      modes,
      errRope: errRopeModes,
      scoringModes,
      setCombos: setCombos.length,
      paramCombos: paramCombos.length,
      totalRuns,
    },
    progress: { completedPresets: 0, totalPresets: totalRuns },
  })

  const progressToken = (extra._meta as Any)?.progressToken
  const notify = (completed: number, message: string) => {
    updateJobProgress(jobId, { completedPresets: completed, totalPresets: totalRuns, phase: message })
    if (progressToken == null) return
    void extra.sendNotification({
      method: 'notifications/progress' as const,
      params: { progressToken, progress: completed, total: totalRuns, message },
    } as Any).catch(() => {})
  }

  const generation = runtimeContext.getSaveGeneration()
  const started = performance.now()
  let results: AuditorResults
  try {
    results = await runAudit(
      characterId as Any,
      config,
      (completed, total) => notify(completed, `audit ${completed}/${total} benchmark runs done`),
      cancelRef,
    )
  } catch (e) {
    finishJob(jobId, 'failed', { error: String((e as Error)?.message ?? e), totalRuns })
    throw e
  }

  const durationMs = Math.round(performance.now() - started)
  if (generation !== runtimeContext.getSaveGeneration()) {
    finishJob(jobId, 'failed', { error: '运行期间 load_save 切换了存档,审计结果已丢弃——请对当前存档重新运行', durationMs })
    throw new Error('A load_save changed the save while the set audit was running — results were discarded; re-run for the current save')
  }

  const cancelled = cancelRef.current && results.summaries.length === 0
  finishJob(jobId, cancelled ? 'cancelled' : 'completed', {
    completedPresets: cancelled ? 0 : totalRuns,
    totalPresets: totalRuns,
    durationMs,
    flaggedSets: results.summaries.filter((s) => s.flag != null).length,
  })

  const summaries = results.summaries.map((summary) => ({
    type: summary.setCombo.type,
    label: summary.setCombo.label,
    relicSet1: summary.setCombo.relicSet1,
    relicSet2: summary.setCombo.relicSet2,
    ornamentSet: summary.setCombo.ornamentSet,
    matched: summary.matched,
    flag: summary.flag,
    bestDelta: summary.bestDelta,
    bestDeltaParams: {
      spd: summary.bestDeltaParams.spd,
      errRope: summary.bestDeltaParams.errRope,
      subDps: summary.bestDeltaParams.subDps,
    },
    results: summary.results.map((run) => ({
      spd: run.paramCombo.spd,
      errRope: run.paramCombo.errRope,
      subDps: run.paramCombo.subDps,
      modeLabel: run.modeLabel ?? null,
      score: run.score,
      referenceScore: run.referenceScore,
      deltaPct: run.deltaPct,
      flag: run.flag,
      error: run.error === true,
    })),
  }))

  const red = summaries.filter((s) => s.flag === 'red').length
  const yellow = summaries.filter((s) => s.flag === 'yellow').length
  return toolResult(
    {
      characterId,
      sweep: 'sets',
      jobId,
      config: {
        lightCone: effectiveLightCone,
        characterEidolon: config.characterEidolon,
        lightConeSuperimposition: config.lightConeSuperimposition,
        setTypes,
        spdBreakpoints,
        modes,
        errRope: errRopeModes,
        scoringModes,
        teammates: resolvedTeammates.map((mate) => mate.characterId),
      },
      reference: {
        relic: results.relicReferenceLabel,
        ornament: results.ornamentReferenceLabel,
      },
      cancelled,
      durationMs,
      summaries,
    },
    `${characterId} 套装基准审计${cancelled ? '(已取消,无汇总)' : '完成'}:${summaries.length} 个套装组合 × ${paramCombos.length} 组参数`
      + `(${totalRuns} 次基准运行,耗时 ${(durationMs / 1000).toFixed(1)}s);`
      + `参照 ${results.relicReferenceLabel} + ${results.ornamentReferenceLabel},`
      + `红标 ${red}(不在推荐名单却持平或更高)、黄标 ${yellow}(差距 ≤2%)`
      + `;任务 ${jobId} 已注册(get_job 可查)`,
  )
}

// ─── domain registration ─────────────────────────────────────────────────────

export function registerSimulationTools(server: McpServer): void {
  // ── simulate_build ─────────────────────────────────────────────────────────
  server.registerTool('simulate_build', {
    title: '单套配装战斗模拟',
    description: '对一套具体配装跑战斗模拟——对应网页端 Optimizer 结果行的战斗引擎与「展开数据面板」(Expanded Data Panel)'
      + '底层的 simulateBuild:输入 characterId + relicIds(≤6 件,缺省取角色当前装备),基于角色已保存的优化表单'
      + '(可传 formOverrides 覆盖条件,与 optimize 同名字段合并)。trace=false 返回汇总:战斗属性归约'
      + '(面板/战斗属性,Float 精度与引擎一致)+ COMBO 总伤/治疗/护盾 + 逐技能伤害(actionDamage)与轮次伤害(rotationDamage);'
      + 'trace=true 额外返回:伤害类型拆分表(逐技能 × 伤害类型,含真伤段)、逐动作 Buff 快照'
      + '(每条带来源归因 source.buffType=角色/光锥/套装、source.ability=技能/行迹/星魂)、基础属性增益追踪与完整容器归约。'
      + 'fromCache={cacheId,rowId?} 沿用最近一次 optimize 实际使用的表单(已合并那轮的 formOverrides,网页端分析区同款):'
      + '给出 rowId 时配装取该结果行(此时不可再传 relicIds),不给则配装仍按 relicIds/当前装备。',
    inputSchema: {
      characterId: z.string().describe('角色 id,如 "1212b1"(可用 id 见 load_save 返回的 characterIds)'),
      relicIds: z.array(z.string()).min(1).max(6).optional().describe('遗器 id 列表(每部件一件;缺省取角色当前装备;与 fromCache.rowId 互斥)'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(FORM_OVERRIDES_DESCRIPTION),
      fromCache: cachedRunRefSchema.optional().describe('沿用最近一次 optimize 的表单快照(那一轮已合并 formOverrides 的版本);rowId 给出时配装取该行'),
      trace: z.boolean().default(false).describe('是否返回伤害拆分与逐动作 Buff 快照(略慢)'),
    },
    outputSchema: {
      characterId: z.string(),
      build: z.object({
        relicIds: z.record(z.string(), z.string()),
        relicCount: z.number().int(),
        fromEquipped: z.boolean(),
      }),
      trace: z.boolean(),
      durationMs: z.number(),
      stats: computedStatsSchema,
      actionDamage: z.record(z.string(), z.number()).nullable(),
      rotationDamage: z.array(rotationDamageStepSchema),
      damageSplits: damageSplitsSchema.optional(),
      buffs: z.object({
        byAction: z.record(
          z.string(),
          z.object({
            buffs: z.array(serializedBuffSchema),
            buffsMemo: z.array(serializedBuffSchema),
          }),
        ),
        rotationSteps: z.array(z.object({
          actionType: z.string(),
          buffs: z.array(serializedBuffSchema),
          buffsMemo: z.array(serializedBuffSchema),
        })),
        basic: z.array(serializedBuffSchema),
      }).optional(),
      fromCache: z.object({ cacheId: z.string(), rowId: z.number().nullable() }).optional(),
    },
  }, async ({ characterId, relicIds, formOverrides, fromCache, trace }): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    // fromCache: analysis uses the form THE RUN used (web getCachedForm);
    // rowId additionally pins the build to that result row.
    const cachedRun = fromCache != null ? resolveCachedRun(fromCache, characterId) : null
    if (cachedRun?.rowId != null && relicIds != null) {
      throw new Error('simulate_build: relicIds 与 fromCache.rowId 互斥——rowId 已把配装固定为该结果行')
    }

    const character = requireCharacter(characterId)
    const form = cachedRun != null
      ? formFromDisplayState(cachedRun.state, formOverrides, characterId)
      : buildCharacterForm(character, formOverrides)
    // Trace flag must be on the FORM before generateContext, not just the
    // simulateBuild call: character-kit/light-cone buffs are precomputed at
    // context time and only recorded when request.trace is set
    // (actionTransform.ts traces the precompute container conditionally, and
    // simulateBuild's mergePrecomputedTraces drops untraced ones). This is the
    // upstream generateAnalysisData recipe (request.trace = true).
    form.trace = trace
    const context = generateContext(form)
    if (!context.defaultActions?.length) {
      throw new Error(`角色 ${characterId} 的配置未生成任何默认战斗动作——请检查角色/光锥配置后再试`)
    }

    const buildByPart = cachedRun?.build != null ? cachedRun.build : resolveBuildByPart(characterId, relicIds)
    const relics = toSimulationRelics(buildByPart)

    const started = performance.now()
    // Trace mode constructs a traced BasicStatsArrayCore (upstream generateAnalysisData
    // recipe) so basic-stat buffs are captured alongside the container's combat buffs.
    const built = simulateBuild(
      relics as unknown as SimulationRelicByPart,
      context,
      trace ? new BasicStatsArrayCore(true) : null,
      null,
      trace,
      0,
      false,
    )
    const durationMs = Math.round(performance.now() - started)

    const stats = serializeComputedStats(built.x)
    const payload: Record<string, unknown> = {
      characterId,
      build: {
        relicIds: { ...buildByPart },
        relicCount: Object.keys(buildByPart).length,
        fromEquipped: relicIds == null && cachedRun?.build == null,
      },
      trace,
      durationMs,
      stats,
      actionDamage: built.actionDamage ? serializeActionDamage(built.actionDamage) : null,
      rotationDamage: (built.rotationDamage ?? []).map(serializeRotationDamageStep),
    }
    if (cachedRun != null) payload.fromCache = { cacheId: fromCache!.cacheId, rowId: cachedRun.rowId }

    if (trace) {
      const t = optimizerTabT()
      payload.damageSplits = {
        byAbility: serializeDamageSplits(extractDamageSplits(built.x, context.defaultActions, 'default', t)),
        rotation: serializeDamageSplits(extractDamageSplits(built.x, context.rotationActions, 'rotation', t)),
      }
      payload.buffs = {
        byAction: Object.fromEntries(
          Object.entries(built.actionBuffSnapshots ?? {}).map(([actionName, snapshot]) => [
            actionName,
            { buffs: snapshot.buffs.map(serializeBuff), buffsMemo: snapshot.buffsMemo.map(serializeBuff) },
          ]),
        ),
        rotationSteps: (built.rotationBuffSteps ?? []).map((step) => ({
          actionType: step.actionType,
          buffs: step.snapshot.buffs.map(serializeBuff),
          buffsMemo: step.snapshot.buffsMemo.map(serializeBuff),
        })),
        // Basic-stat trace (relic mains/subs, set base effects) from the traced core
        basic: built.x.c.buffs.map(serializeBuff),
      }
    }

    const combo = stats.combo
    return toolResult(
      payload,
      `${characterId} 配装模拟完成(${Object.keys(buildByPart).length} 件遗器${relicIds == null ? ',取当前装备' : ''}):`
        + `COMBO 伤害 ${(combo?.damage ?? 0).toLocaleString()},耗时 ${durationMs}ms`
        + (trace ? '(含伤害拆分与 Buff 快照)' : ''),
    )
  })

  // ── stat_simulate ──────────────────────────────────────────────────────────
  server.registerTool('stat_simulate', {
    title: '假想配装批量模拟',
    description: 'Stat Simulations 页签的无头版:不依赖具体遗器,按「套装 + 四件主词条 + 副词条 roll 数」批量模拟假想配装,'
      + '一次跑多个变体并返回变体间差值。字段名与上游 SimulationRequest 一致(simRelicSet1/simRelicSet2/simOrnamentSet/'
      + 'simBody/simFeet/simPlanarSphere/simLinkRope/stats);stats 在 substatRolls 模式下是各副词条的 roll 数'
      + '(SPD 每 roll 取 speedRollValue,默认 2.6),benchmarks 模式下直接取数值。'
      + '基准表单取角色已保存的优化表单(可传 formOverrides)。每个变体返回 COMBO 伤害(simScore)、战斗/面板属性归约、'
      + '逐技能与轮次伤害,以及相对基准变体(默认第 0 个,可指定 baselineIndex)的差值与全部变体排名。'
      + '变体来源四选一:simulations(显式定义,默认)/ saved=true(直接运行角色表单里已保存的全部假想配装,'
      + '按表单 resultSort 排序返回,与网页端点「模拟」后的结果表格一致——已保存列表用 update_form(statSimulations=…) 管理)/ '
      + 'fromCache(把最近一次 optimize 的某行结果「导入」为模拟:取套装与四个主词条、副词条折算成词条数,'
      + '保存为一条新模拟并运行,重复内容会被拒绝——网页端「导入」按钮同款)/ fromRelicIds(按遗器 id 折算成模拟,保存并运行)。',
    inputSchema: {
      characterId: z.string().describe('角色 id,如 "1212b1"'),
      simulations: z.array(z.object({
        name: z.string().optional().describe('变体名(缺省自动编号)'),
        simType: z.enum(['substatRolls', 'benchmarks']).default('substatRolls').describe('substatRolls=stats 为 roll 数;benchmarks=stats 为直接数值'),
        simRelicSet1: z.string().describe('遗器套装 1(游戏内套装名)'),
        simRelicSet2: z.string().describe('遗器套装 2(与套装 1 相同即 4pc)'),
        simOrnamentSet: z.string().describe('位面饰品套装名'),
        simBody: z.string().describe('Body 主词条,如 "CRIT DMG"'),
        simFeet: z.string().describe('Feet 主词条,如 "SPD"'),
        simPlanarSphere: z.string().describe('PlanarSphere 主词条'),
        simLinkRope: z.string().describe('LinkRope 主词条'),
        stats: z.record(z.string(), z.number()).default({}).describe('副词条 → 数值/roll 数映射,键如 "CRIT DMG"、"SPD"'),
      })).min(1).max(MAX_STAT_SIM_VARIANTS).optional().describe('变体列表(上游 SimulationRequest 字段名);与 saved/fromCache/fromRelicIds 四选一'),
      saved: z.boolean().optional().describe('直接运行角色表单里已保存的全部假想配装(characters[].form.statSim.simulations);无需传 simulations'),
      fromCache: z.object({
        cacheId: z.string().describe('optimize 返回的 cacheId'),
        rowId: z.number().describe('目标行的 row id(optimize 返回行中的 id 字段;模拟行不能导入)'),
      }).optional().describe('把最近一次 optimize 的某行结果导入为模拟并运行(与 simulations 四选一)'),
      fromRelicIds: z.array(z.string()).min(1).max(6).optional().describe(
        '按遗器 id(每部件一件,须含躯干/脚部/位面球/连结绳四个主词条部位)折算成一条模拟,保存并运行(与 simulations 四选一)',
      ),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(FORM_OVERRIDES_DESCRIPTION),
      quality: z.number().min(0).max(1).default(1).describe('副词条品质(1=最高 roll,上游默认)'),
      speedRollValue: z.number().min(0).default(2.6).describe('SPD 每 roll 数值(上游默认 2.6)'),
      baselineIndex: z.number().int().min(0).default(0).describe('作为差值基准的变体下标(默认第 0 个)'),
    },
    outputSchema: {
      characterId: z.string(),
      source: z.enum(['explicit', 'saved', 'imported']),
      baselineIndex: z.number().int(),
      params: z.object({ quality: z.number(), speedRollValue: z.number() }),
      durationMs: z.number(),
      variants: z.array(z.object({
        index: z.number().int(),
        name: z.string(),
        request: echoedSimRequestSchema,
        simScore: z.number(),
        deltaVsBaseline: z.object({ simScore: z.number(), pct: z.number() }),
        deltaVsBest: z.object({ simScore: z.number(), pct: z.number() }),
        stats: computedStatsSchema,
        actionDamage: z.record(z.string(), z.number()).nullable(),
        rotationDamage: z.array(rotationDamageStepSchema),
      })),
      ranking: z.array(z.object({ index: z.number().int(), name: z.string(), simScore: z.number() })),
      orderedByResultSort: z.boolean().optional(),
      importedSimulation: z.object({
        key: z.string(),
        name: z.string(),
        simType: z.string(),
        request: echoedSimRequestSchema,
      }).optional(),
    },
  }, async ({ characterId, simulations, saved, fromCache, fromRelicIds, formOverrides, quality, speedRollValue, baselineIndex }): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const provided = [simulations, saved === true, fromCache, fromRelicIds].filter((x) => x != null && x !== false).length
    if (provided !== 1) {
      throw new Error('stat_simulate: 变体来源必须四选一 — simulations(显式定义)/ saved=true / fromCache / fromRelicIds')
    }

    const character = requireCharacter(characterId)
    let source: 'explicit' | 'saved' | 'imported' = 'explicit'
    let importedEcho: { key: string, name: string, simType: string, request: ReturnType<typeof echoSimRequest> } | undefined

    let sims: Simulation[]
    if (simulations != null) {
      if (baselineIndex >= simulations.length) {
        throw new Error(`baselineIndex ${baselineIndex} 超出范围(共 ${simulations.length} 个变体,合法范围 0..${simulations.length - 1})`)
      }
      // Validate before simulating: sets, mains per part, substat keys
      for (const [index, sim] of simulations.entries()) {
        assertRelicSetName(sim.simRelicSet1)
        assertRelicSetName(sim.simRelicSet2)
        assertOrnamentSetName(sim.simOrnamentSet)
        const mainChecks: Array<[string, string]> = [
          ['simBody', sim.simBody],
          ['simFeet', sim.simFeet],
          ['simPlanarSphere', sim.simPlanarSphere],
          ['simLinkRope', sim.simLinkRope],
        ]
        for (const [field, mainStat] of mainChecks) {
          const part = field === 'simBody' ? Parts.Body : field === 'simFeet' ? Parts.Feet : field === 'simPlanarSphere' ? Parts.PlanarSphere : Parts.LinkRope
          const valid = PartsMainStats[part as Parts]
          if (!valid.includes(mainStat as never)) {
            throw new Error(`变体 ${index} 的 ${field}="${mainStat}" 不是该部件的合法主词条——可选: ${valid.join(', ')}`)
          }
        }
        for (const stat of Object.keys(sim.stats)) {
          if (!SUBSTAT_NAMES.has(stat)) {
            throw new Error(`变体 ${index} 的副词条 "${stat}" 不存在——可用: ${SubStats.join(', ')}`)
          }
        }
      }
      sims = simulations.map((sim, index) => ({
        name: sim.name ?? `variant-${index}`,
        key: sim.name ?? `variant-${index}`,
        simType: sim.simType === 'benchmarks' ? StatSimTypes.Benchmarks : StatSimTypes.SubstatRolls,
        // Set/main names are validated against the registries above; the branded
        // literal unions (SetsRelics/SetsOrnaments/…) are satisfied by that check.
        request: {
          name: sim.name ?? '',
          simRelicSet1: sim.simRelicSet1,
          simRelicSet2: sim.simRelicSet2,
          simOrnamentSet: sim.simOrnamentSet,
          simBody: sim.simBody,
          simFeet: sim.simFeet,
          simPlanarSphere: sim.simPlanarSphere,
          simLinkRope: sim.simLinkRope,
          stats: sim.stats,
        } as Simulation['request'],
      }))
    } else if (saved === true) {
      // 直接运行表单里已保存的模拟(网页端「模拟」按钮);只计算 request 完整的条目
      source = 'saved'
      const savedSims = (character.form?.statSim?.simulations ?? []).filter((sim) => sim.request?.stats)
      if (savedSims.length === 0) {
        throw new Error(`stat_simulate: 角色 ${characterId} 的表单里没有已保存的假想配装 — 先用 update_form(statSimulations={add:…}) 添加,或直接传 simulations`)
      }
      if (baselineIndex >= savedSims.length) {
        throw new Error(`baselineIndex ${baselineIndex} 超出范围(共 ${savedSims.length} 个已保存模拟,合法范围 0..${savedSims.length - 1})`)
      }
      sims = savedSims
    } else {
      // 「从结果导入」:fromCache(最近一次 optimize 的某行)或 fromRelicIds(显式遗器)
      source = 'imported'
      let byPart: Partial<Record<string, string | undefined>>
      let relicSetIndex: number | undefined
      let ornamentSetIndex: number | undefined
      if (fromCache != null) {
        const cached = runtimeContext.getLastOptimizeResult()
        if (!cached || cached.summary.cacheId !== fromCache.cacheId) {
          throw new Error(`fromCache: 找不到 cacheId ${fromCache.cacheId} 的结果缓存 — 请使用最近一次 optimize 返回的 cacheId`)
        }
        if (cached.generation !== runtimeContext.getSaveGeneration()) {
          throw new Error('fromCache: 结果缓存属于上一次 load_save 之前的存档 — 请对当前存档重新运行 optimize')
        }
        if (cached.summary.characterId !== characterId) {
          throw new Error(`fromCache: 缓存归属角色 ${cached.summary.characterId} 与请求角色 ${characterId} 不一致`)
        }
        const rowIndex = cached.rows.findIndex((row) => row.id === fromCache.rowId)
        if (rowIndex === -1) {
          throw new Error(`fromCache: 缓存中没有 row id ${fromCache.rowId} 的结果行`)
        }
        const row = cached.rows[rowIndex]
        // 网页端:选中的是模拟行时不导入(statSimulationController.importOptimizerBuild)
        if ((row as Any).statSim) {
          throw new Error('fromCache: 选中的是模拟行,不能导入为模拟 — 请选择一条真实配装行')
        }
        byPart = cached.builds[rowIndex]
        relicSetIndex = (row as Any).relicSetIndex
        ornamentSetIndex = (row as Any).ornamentSetIndex
      } else {
        byPart = resolveBuildByPart(characterId, fromRelicIds!)
      }

      // 套装名:行内索引经 relicSetIndexToNames/ornamentSetIndexToName 反解
      // (fromRelicIds 用 precomputeSetState 编码,同一条链路);遗器用原始
      // (未 condense)克隆,convertRelicsToSimulation 直接读 main/substats。
      const rawByPart: Record<string, Any> = {}
      for (const [part, relicId] of Object.entries(byPart)) {
        if (!relicId) continue
        const relic = getRelicById(relicId)
        if (!relic) throw new Error(`遗器 ${relicId} 不在当前库存中——请检查 id 或重新 load_save`)
        rawByPart[part] = clone(relic)
      }
      if (relicSetIndex == null || ornamentSetIndex == null) {
        const condensed = toSimulationRelics(byPart)
        const indices = precomputeSetState(condensed as unknown as SimulationRelicByPart)
        relicSetIndex = indices.relicSetIndex
        ornamentSetIndex = indices.ornamentSetIndex
      }
      const relicSetNames = relicSetIndexToNames(relicSetIndex)
      const ornamentSetName = ornamentSetIndexToName(ornamentSetIndex)
      const importedRequest = convertRelicsToSimulation(
        rawByPart as Any,
        relicSetNames[0],
        relicSetNames[1],
        ornamentSetName,
        1,
      ) as SimulationRequest
      for (const [part, field] of [['Body', 'simBody'], ['Feet', 'simFeet'], ['PlanarSphere', 'simPlanarSphere'], ['LinkRope', 'simLinkRope']] as const) {
        if (!importedRequest[field as keyof SimulationRequest]) {
          throw new Error(`导入失败: 配装缺少 ${part} 部位的遗器,无法折算主词条 — 请补全该部位后重试`)
        }
      }

      // 网页端「导入」即保存:内容重复直接拒绝(statSimulationController)
      const simType = StatSimTypes.SubstatRolls
      const cleaned: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(importedRequest as unknown as Record<string, unknown>)) {
        if (value != null) cleaned[key] = value
      }
      const hash = objectHash({ simType, request: cleaned })
      for (const existing of character.form?.statSim?.simulations ?? []) {
        const existingCleaned: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(existing.request as unknown as Record<string, unknown>)) {
          if (value != null) existingCleaned[key] = value
        }
        if (hash === objectHash({ simType: existing.simType, request: existingCleaned })) {
          throw new Error(`导入失败: 内容与已保存模拟「${existing.name ?? existing.key}」完全相同 — 网页端不允许重复保存`)
        }
      }
      const simulation: Simulation = {
        name: importedRequest.name ?? '',
        key: uuid(),
        simType,
        request: importedRequest,
      }
      await runtimeContext.withChange('stat_simulate', () => {
        const current = requireCharacter(characterId)
        const statSim = current.form?.statSim
        useCharacterStore.getState().setCharacter({
          ...current,
          form: {
            ...current.form,
            statSim: {
              key: statSim?.key ?? '',
              benchmarks: statSim?.benchmarks ?? blankSimRequest(),
              substatRolls: statSim?.substatRolls ?? blankSimRequest(),
              simulations: [...(statSim?.simulations ?? []), simulation],
            },
          },
        })
        runtimeContext.markDirty()
      })
      sims = [simulation]
      importedEcho = { key: simulation.key!, name: simulation.name ?? '', simType: String(simType), request: echoSimRequest(importedRequest) }
    }

    const form = buildCharacterForm(character, formOverrides)
    const context = generateContext(form)
    if (!context.defaultActions?.length) {
      throw new Error(`角色 ${characterId} 的配置未生成任何默认战斗动作——请检查角色/光锥配置后再试`)
    }

    const started = performance.now()
    // stabilize:true clones each result so per-variant stats can't alias the
    // next simulation's arrays (upstream Stat Simulations tab does the same).
    const results = runStatSimulations(sims, form, context, { quality, speedRollValue, stabilize: true })
    const durationMs = Math.round(performance.now() - started)

    const baselineScore = results[baselineIndex]?.simScore ?? 0
    const bestScore = Math.max(...results.map((r) => r.simScore))

    // saved 模式按表单 resultSort 排序返回(startOptimizerStatSimulation 同款);
    // 其余模式保持输入顺序。
    let orderedIndices = results.map((_, index) => index)
    let orderedByResultSort = false
    if (source === 'saved') {
      const sortOption = form.resultSort != null ? SortOption[form.resultSort] : undefined
      if (sortOption) {
        const gridSortColumn = (form.statDisplay === 'base' ? sortOption.basicGridColumn : sortOption.combatGridColumn) as Any
        const rows: Any[] = results.map((result, index) => transformOptimizerDisplayData(result.x, sims[index].key))
        orderedIndices = rows
          .map((_, index) => index)
          .sort((a, b) => (rows[b][gridSortColumn] as number) - (rows[a][gridSortColumn] as number))
        orderedByResultSort = true
      }
    }

    const variants = orderedIndices.map((index) => {
      const result = results[index]
      return {
        index,
        name: sims[index].name ?? '',
        request: echoSimRequest(sims[index].request),
        simScore: result.simScore,
        deltaVsBaseline: {
          simScore: result.simScore - baselineScore,
          pct: baselineScore !== 0 ? ((result.simScore - baselineScore) / baselineScore) * 100 : 0,
        },
        deltaVsBest: {
          simScore: result.simScore - bestScore,
          pct: bestScore !== 0 ? ((result.simScore - bestScore) / bestScore) * 100 : 0,
        },
        stats: serializeComputedStats(result.x),
        actionDamage: result.actionDamage ? serializeActionDamage(result.actionDamage) : null,
        rotationDamage: (result.rotationDamage ?? []).map(serializeRotationDamageStep),
      }
    })

    const ranking = [...variants]
      .map((v) => ({ index: v.index, name: v.name, simScore: v.simScore }))
      .sort((a, b) => b.simScore - a.simScore)

    return toolResult(
      {
        characterId,
        source,
        baselineIndex,
        params: { quality, speedRollValue },
        durationMs,
        variants,
        ranking,
        ...(orderedByResultSort ? { orderedByResultSort } : {}),
        ...(importedEcho != null ? { importedSimulation: importedEcho } : {}),
      },
      `${characterId} 的 ${variants.length} 个假想配装模拟完成(${
        source === 'saved' ? '已保存列表' : source === 'imported' ? '导入并保存' : '显式定义'
      }),耗时 ${durationMs}ms:`
        + `最佳变体 #${ranking[0]?.index}(${ranking[0]?.name},COMBO ${ranking[0]?.simScore.toLocaleString()}),`
        + `基准变体 #${baselineIndex} 为 ${baselineScore.toLocaleString()}`
        + (importedEcho != null ? `;已保存为新模拟 key=${importedEcho.key}` : ''),
    )
  })

  // ── analyze_build ──────────────────────────────────────────────────────────
  server.registerTool('analyze_build', {
    title: '新旧配装对比分析',
    description: '对应网页端优化结果行「展开数据面板」的对比分析链(generateAnalysisData 的无头版,遗器直接按 id 传入'
      + '而不是从结果行反解):对基准配装(oldRelicIds,缺省取角色当前装备)与候选配装(newRelicIds)各跑一次战斗模拟,'
      + '返回:① 新旧 COMBO/治疗/护盾与逐技能伤害对比及差值;② 伤害拆分表(逐技能 × 伤害类型,含真伤段,新旧各一份);'
      + '③ 逐副词条 +1 roll 升级表(calculateStatUpgrades:每个副词条加 1 roll 后 COMBO/EHP 的增量与百分比);'
      + '④ 队友位面饰品升级表(calculateTeammateUpgrades:给每个队友换饰品套装对 COMBO 的影响)。'
      + '基础表单取角色已保存的优化表单,可传 formOverrides。'
      + 'fromCache={cacheId,rowId?} 沿用最近一次 optimize 实际使用的表单(已合并那轮的 formOverrides)——'
      + '分析与结果行对齐的关键,网页端分析区(getCachedForm)同款;给出 rowId 时候选(新)配装取该结果行,'
      + '此时 newRelicIds 可省略(给了则以 newRelicIds 为准)。',
    inputSchema: {
      characterId: z.string().describe('角色 id,如 "1212b1"'),
      newRelicIds: z.array(z.string()).min(1).max(6).optional().describe('候选(新)配装的遗器 id 列表,每部件一件;缺省时须给 fromCache.rowId(取该结果行配装)'),
      oldRelicIds: z.array(z.string()).min(1).max(6).optional().describe('基准(旧)配装遗器 id;缺省取角色当前装备'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(FORM_OVERRIDES_DESCRIPTION),
      fromCache: cachedRunRefSchema.optional().describe('沿用最近一次 optimize 的表单快照做分析(那一轮已合并 formOverrides);rowId 给出时候选配装取该行'),
    },
    outputSchema: {
      characterId: z.string(),
      durationMs: z.number(),
      builds: z.object({
        old: z.object({ relicIds: z.record(z.string(), z.string()), relicCount: z.number().int(), fromEquipped: z.boolean() }),
        new: z.object({ relicIds: z.record(z.string(), z.string()), relicCount: z.number().int(), fromEquipped: z.boolean() }),
      }),
      combo: z.object({
        old: z.object({ damage: z.number(), heal: z.number(), shield: z.number(), buff: z.number() }).nullable(),
        new: z.object({ damage: z.number(), heal: z.number(), shield: z.number(), buff: z.number() }).nullable(),
        damageDelta: z.number(),
      }),
      actionDamage: z.object({
        old: z.record(z.string(), z.number()),
        new: z.record(z.string(), z.number()),
        delta: z.record(z.string(), z.number()),
      }),
      stats: z.object({ old: computedStatsSchema, new: computedStatsSchema }),
      damageSplits: z.object({ old: damageSplitsSchema, new: damageSplitsSchema }),
      statUpgrades: z.array(z.object({
        stat: z.string(),
        rollsAfter: z.number().nullable(),
        combo: z.object({ delta: z.number(), pct: z.number() }),
        ehp: z.object({ delta: z.number(), pct: z.number() }),
      })),
      teammateOrnamentUpgrades: z.array(z.object({
        teammates: z.array(z.string()),
        set: z.array(z.string()),
        oldSet: z.string().nullable(),
        simScore: z.number(),
        delta: z.number(),
      })),
      fromCache: z.object({ cacheId: z.string(), rowId: z.number().nullable() }).optional(),
    },
  }, async ({ characterId, newRelicIds, oldRelicIds, formOverrides, fromCache }): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    // fromCache: the web analysis pipeline runs against the form the optimize
    // run used (getCachedForm). rowId also supplies the candidate build.
    const cachedRun = fromCache != null ? resolveCachedRun(fromCache, characterId) : null
    if (newRelicIds == null && cachedRun?.build == null) {
      throw new Error('analyze_build: 缺少候选配装——请传 newRelicIds,或给 fromCache.rowId 取缓存结果行的配装')
    }

    const character = requireCharacter(characterId)
    const oldByPart = resolveBuildByPart(characterId, oldRelicIds)
    const newByPart = cachedRun?.build != null
      ? cachedRun.build
      : resolveBuildByPart(characterId, newRelicIds!)

    // generateAnalysisData recipe, with the row-id decode replaced by explicit ids
    const request = clone(
      cachedRun != null
        ? formFromDisplayState(cachedRun.state, formOverrides, characterId)
        : buildCharacterForm(character, formOverrides),
    ) as Any
    request.trace = true

    const contextOld = generateContext(request)
    const contextNew = generateContext(request)
    if (!contextOld.defaultActions?.length || !contextNew.defaultActions?.length) {
      throw new Error(`角色 ${characterId} 的配置未生成任何默认战斗动作——请检查角色/光锥配置后再试`)
    }

    const oldRelics = toSimulationRelics(oldByPart)
    const newRelics = toSimulationRelics(newByPart)

    const started = performance.now()
    const oldRun = simulateBuild(oldRelics as unknown as SimulationRelicByPart, contextOld, null)
    const newRun = simulateBuild(
      newRelics as unknown as SimulationRelicByPart,
      contextNew,
      new BasicStatsArrayCore(true),
      null,
      true,
    )

    const oldX = oldRun.x
    const newX = newRun.x
    const perActionBuffGroups = newRun.actionBuffSnapshots
      ? aggregatePerActionBuffs(newRun.actionBuffSnapshots, newRun.rotationBuffSteps ?? [], newX, request, contextNew.primaryAbilityKey)
      : { byAction: {}, rotationSteps: [], primaryAction: '' }

    // Set indices for the stat-upgrade request derivation (upstream reads them
    // off the optimizer row; precomputeSetState produces the same encoding and
    // simulateBuild has already filled any missing parts on our relic object).
    const { relicSetIndex, ornamentSetIndex } = precomputeSetState(newRelics as unknown as SimulationRelicByPart)

    const characterMetadata = getGameMetadata().characters[character.id]
    const analysis: OptimizerResultAnalysis = {
      oldRowData: {} as OptimizerDisplayData,
      newRowData: { relicSetIndex, ornamentSetIndex } as unknown as OptimizerDisplayData,
      oldRelics,
      newRelics,
      request,
      oldX,
      newX,
      perActionBuffGroups,
      context: contextNew,
      elementalDmgValue: ElementToDamage[characterMetadata.element],
      extraRows: characterMetadata.path === PathNames.Elation ? [Stats.Elation] : [],
    }

    const statUpgrades = calculateStatUpgrades(analysis)
    const teammateUpgrades = calculateTeammateUpgrades(analysis)
    const durationMs = Math.round(performance.now() - started)

    // ── damage deltas (old vs new) ──
    const oldStats = serializeComputedStats(oldX)
    const newStats = serializeComputedStats(newX)
    const oldCombo = oldStats.combo

    const t = optimizerTabT()
    const oldSplits = {
      byAbility: serializeDamageSplits(extractDamageSplits(oldX, contextOld.defaultActions, 'default', t)),
      rotation: serializeDamageSplits(extractDamageSplits(oldX, contextOld.rotationActions, 'rotation', t)),
    }
    const newSplits = {
      byAbility: serializeDamageSplits(extractDamageSplits(newX, contextNew.defaultActions, 'default', t)),
      rotation: serializeDamageSplits(extractDamageSplits(newX, contextNew.rotationActions, 'rotation', t)),
    }

    // ── per-substat +1 roll upgrades (web SubstatUpgrades.tsx recipe) ──
    const baseCombo = newX.getGlobalRegisterValue(GlobalRegister.COMBO_DMG)
    const baseEhp = newX.getSelfValue(StatKey.EHP)
    const serializedStatUpgrades = statUpgrades.map((upgrade) => {
      const combo = upgrade.x.getGlobalRegisterValue(GlobalRegister.COMBO_DMG)
      const ehp = upgrade.x.getSelfValue(StatKey.EHP)
      return {
        stat: upgrade.stat,
        rollsAfter: upgrade.simRequest.stats[upgrade.stat] ?? null,
        combo: {
          delta: combo - baseCombo,
          pct: baseCombo !== 0 ? ((combo - baseCombo) / baseCombo) * 100 : 0,
        },
        ehp: {
          delta: ehp - baseEhp,
          pct: baseEhp !== 0 ? ((ehp - baseEhp) / baseEhp) * 100 : 0,
        },
      }
    })
    serializedStatUpgrades.sort((a, b) => b.combo.delta - a.combo.delta)

    const serializedTeammateUpgrades = teammateUpgrades.map((upgrade) => ({
      teammates: [...upgrade.ids],
      set: [...upgrade.set],
      oldSet: upgrade.oldSet ?? null,
      simScore: upgrade.simScore,
      delta: upgrade.simScore - baseCombo,
    }))

    const oldAction = oldRun.actionDamage ? serializeActionDamage(oldRun.actionDamage) : {}
    const newAction = newRun.actionDamage ? serializeActionDamage(newRun.actionDamage) : {}
    const actionDamageDelta: Record<string, number> = {}
    for (const key of new Set([...Object.keys(oldAction), ...Object.keys(newAction)])) {
      actionDamageDelta[key] = (newAction[key] ?? 0) - (oldAction[key] ?? 0)
    }

    return toolResult(
      {
        characterId,
        durationMs,
        ...(cachedRun != null ? { fromCache: { cacheId: fromCache!.cacheId, rowId: cachedRun.rowId } } : {}),
        builds: {
          old: { relicIds: { ...oldByPart }, relicCount: Object.keys(oldByPart).length, fromEquipped: oldRelicIds == null },
          new: { relicIds: { ...newByPart }, relicCount: Object.keys(newByPart).length, fromEquipped: false },
        },
        combo: {
          old: oldCombo ?? null,
          new: newStats.combo ?? null,
          damageDelta: (newStats.combo?.damage ?? 0) - (oldCombo?.damage ?? 0),
        },
        actionDamage: { old: oldAction, new: newAction, delta: actionDamageDelta },
        stats: { old: oldStats, new: newStats },
        damageSplits: { old: oldSplits, new: newSplits },
        statUpgrades: serializedStatUpgrades,
        teammateOrnamentUpgrades: serializedTeammateUpgrades,
      },
      `${characterId} 配装对比完成,耗时 ${durationMs}ms:COMBO 伤害 ${(oldCombo?.damage ?? 0).toLocaleString()} → `
        + `${newStats.combo?.damage.toLocaleString()}(${(newStats.combo?.damage ?? 0) - (oldCombo?.damage ?? 0) >= 0 ? '+' : ''}`
        + `${((newStats.combo?.damage ?? 0) - (oldCombo?.damage ?? 0)).toLocaleString()});`
        + `副词条升级表 ${serializedStatUpgrades.length} 项,队友饰品升级 ${serializedTeammateUpgrades.length} 项`,
    )
  })

  // ── benchmark_runs ─────────────────────────────────────────────────────────
  server.registerTool(
    'benchmark_runs',
    {
      title: '基准测试批量跑分',
      description: 'Benchmarks 页签的无头版(runCustomBenchmarkOrchestrator,同一条上游链路),两种模式:'
        + '① sweep="presets"(默认)对角色按预设集(4pc 候选套装 × SPD 阈值)批量跑战斗基准,返回每预设的 COMBO 伤害'
        + '(100% 基准配装)、200% 极限分与百分比得分,并按 COMBO 排名、给出与最优预设的差距。'
        + '角色不必在存档里:任何有模拟评分配置的角色都能跑(网页端语义)——在存档的角色默认取其表单的'
        + '光锥/星魂/叠影,不在存档的角色星魂/叠影重置为 0/1 且必须显式传 lightCone;'
        + '队友默认取该角色评分元数据的推荐队(含推荐队伍套装),均可覆盖,teammates 可逐个指定'
        + 'teamRelicSet/teamOrnamentSet(网页端队友弹窗的队伍遗器/饰品套装);'
        + 'setConditionals 可手动改套装条件(套装名 → 布尔/数值,网页端套装条件抽屉),不传则按角色与队伍套用预设;'
        + 'candidateLimit 控制每预设返回的候选行数(默认 5,最大 50,candidateCount 是总数),'
        + 'includeCandidateDetails=true 时候选行带展开详情(面板/战斗属性与各技能伤害);'
        + 'includePerfection 时另返回 200% 口径候选行(perfectionTopCandidates,网页端 200% 页签)。'
        + 'SPD 阈值 0 或缺省表示不限速(其余常用值如 120.000/133.334,与网页端 SPD 下拉一致)。'
        + '② sweep="sets" 套装基准审计(metadata 页 Set Benchmark Auditor 的无头版,runAudit 同一条引擎):'
        + '先用角色评分元数据的第一组推荐套装算参照分,再把全部候选套装(4件套/二加二代表组合/饰品套装)逐个替换进去重算,'
        + '按与参照分的差距排序并标记——不在推荐名单里却持平或更高标 red,差距在 2% 以内标 yellow,已在名单里不标。'
        + '扫遗器套装时饰品固定为参照饰品、扫饰品时遗器固定为参照遗器(两者联动审计不了,与网页端提示一致)。'
        + '星魂/叠影按网页审计面板口径重置为 0/1(可覆盖);网格总运行数(套装组合×参数组合+参照)超过 512 时拒绝并提示收窄。'
        + '长任务:提供 progressToken 时逐预设/逐组发送进度通知,取消会在当前基准结束后停止;'
        + '任务注册进 jobs 注册表(get_job/cancel_job 可见,jobId 形如 "bench-N-…")。',
      inputSchema: {
        characterId: z.string().describe('角色 id(须有战斗评分元数据,即网页端 Benchmarks 页签可选的角色)'),
        sweep: z.enum(['presets', 'sets']).default('presets').describe(
          'presets=按 presets 列表逐个跑(默认);sets=套装基准审计网格(sweepOptions 配置,不接受 presets)',
        ),
        presets: z.array(z.object({
          relicSet1: z.string().describe('遗器套装 1(与套装 2 相同即 4pc)'),
          relicSet2: z.string().describe('遗器套装 2'),
          ornamentSet: z.string().optional().describe('位面饰品套装;缺省取评分元数据的第一个推荐饰品'),
          spdThreshold: z.number().min(0).optional().describe('SPD 阈值(基础面板速度下限),0 或缺省不限速'),
        })).min(1).max(MAX_BENCHMARK_PRESETS).optional().describe('预设列表(4pc 候选套装 × SPD 阈值);sweep="presets" 时必填'),
        sweepOptions: z.object({
          setTypes: z.array(z.enum(['relic4p', 'relic2p2p', 'ornament'])).min(1).default([...DEFAULT_SWEEP_SET_TYPES]).describe(
            '要扫的套装类型:relic4p=全部四件套、relic2p2p=二加二代表组合(按两件套效果归类取代表,非全部两两配对)、'
              + 'ornament=全部饰品套装;默认 relic4p+ornament(网页端默认)',
          ),
          spdBreakpoints: z.array(z.number().min(0)).min(1).default(DEFAULT_SWEEP_SPD_BREAKPOINTS).describe(
            '速度档位多选,0 表示不限速;默认 [0,133,160](网页端可选 0/133/160/200)',
          ),
          modes: z.array(z.enum(['dps', 'subDps'])).min(1).optional().describe('输出/副C 模式;缺省按角色配置(副C 角色为 subDps,否则 dps)'),
          errRope: z.array(z.enum(['noErr', 'err'])).min(1).optional().describe('是否带充能绳;缺省按角色配置(允许充能绳的角色两项都选,否则只选 noErr)'),
          scoringModes: z.array(z.enum(['benchmark', 'perfection'])).min(1).default(['perfection']).describe(
            '比较口径:benchmark=100% 基准分、perfection=200% 极限分;默认 perfection(网页端默认)',
          ),
        }).optional().describe('sweep="sets" 的网格配置;其余模式忽略'),
        lightCone: z.string().optional().describe('覆盖光锥 id(缺省取角色表单;角色不在存档时必传)'),
        lightConeSuperimposition: z.number().int().min(1).max(5).optional().describe('覆盖光锥叠影(缺省:存档角色取表单,未入库角色取 1)'),
        characterEidolon: z.number().int().min(0).max(6).optional().describe('覆盖星魂(缺省:存档角色取表单,未入库角色取 0)'),
        errRope: z.boolean().default(false).describe('是否强制充能绳(与网页端 ERR Rope 开关一致;仅 presets 模式)'),
        subDps: z.boolean().optional().describe('副C模式(降低队友增益权重);缺省取评分元数据默认(仅 presets 模式)'),
        teammates: z.array(z.object({
          characterId: z.string(),
          lightCone: z.string().optional().describe('缺省取推荐队配置'),
          characterEidolon: z.number().int().min(0).max(6).optional(),
          lightConeSuperimposition: z.number().int().min(1).max(5).optional(),
          teamRelicSet: z.string().optional().describe('该队友提供全队效果的遗器套装(网页端队友弹窗「队伍遗器套装」;须为遗器套装名)'),
          teamOrnamentSet: z.string().optional().describe('该队友提供全队效果的饰品套装(网页端队友弹窗「队伍饰品套装」;须为位面饰品套装名)'),
        })).max(3).optional().describe('覆盖队友(缺省取评分元数据推荐队);可指定 teamRelicSet/teamOrnamentSet'),
        setConditionals: z.record(z.string(), z.union([z.boolean(), z.number()])).optional().describe(
          '手动套装条件:套装名 → 条件值(布尔或数值,网页端套装条件抽屉的取值);不传则按角色与队伍套用预设,传入项在预设之后生效',
        ),
        candidateLimit: z.number().int().min(1).max(MAX_BENCHMARK_CANDIDATES).default(TOP_BENCHMARK_CANDIDATES).describe(
          `每预设返回的候选行数(100% 与 200% 口径各取前 N,已按 COMBO 降序;默认 ${TOP_BENCHMARK_CANDIDATES},candidateCount 是总候选数)`,
        ),
        includeCandidateDetails: z.boolean().default(false).describe(
          '候选行是否带展开详情(面板属性/战斗属性/逐技能与轮次伤害,网页端展开行);体积明显变大,配合 candidateLimit 使用',
        ),
        includePerfection: z.boolean().default(true).describe('是否同时跑 200% 极限模拟(更全面的得分,耗时约翻倍;仅 presets 模式)'),
      },
      outputSchema: {
        characterId: z.string(),
        sweep: z.enum(['presets', 'sets']).optional(),
        jobId: z.string().optional().describe('sweep="sets" 模式:jobs 注册表里的任务 id(get_job/cancel_job 可用)'),
        form: z.object({
          lightCone: z.string(),
          characterEidolon: z.number(),
          lightConeSuperimposition: z.number(),
          errRope: z.boolean(),
          subDps: z.boolean(),
          teammates: z.array(z.string()),
          teammateSets: z.array(z.object({
            teamRelicSet: z.string().nullable().optional(),
            teamOrnamentSet: z.string().nullable().optional(),
          })).optional().describe('各队友生效的队伍套装(未指定为 null;顺序与 teammates 一致)'),
        }).optional(),
        includePerfection: z.boolean().optional(),
        cancelled: z.boolean(),
        durationMs: z.number(),
        presets: z.array(z.object({
          index: z.number().int(),
          preset: z.object({
            relicSet1: z.string(),
            relicSet2: z.string(),
            ornamentSet: z.string(),
            spdThreshold: z.number(),
          }),
          status: z.enum(['completed', 'error']),
          durationMs: z.number().optional(),
          benchmarkScore: z.number().optional(),
          bestBuild: echoedSimRequestSchema.nullable().optional(),
          topCandidates: z.array(benchmarkCandidateSchema).optional().describe(
            '100% 口径候选行(网页端结果表 100% 页签;candidateCount 条已按 COMBO 降序,此处取前 candidateLimit 条)',
          ),
          perfectionTopCandidates: z.array(benchmarkCandidateSchema).optional().describe(
            '200% 口径候选行(网页端结果表 200% 页签;includePerfection=false 时不返回)',
          ),
          candidateCount: z.number().int().optional(),
          originalSpd: z.number().nullable().optional(),
          spdBenchmark: z.number().nullable().optional(),
          benchmarkBasicSpdTarget: z.number().optional(),
          perfectionScore: z.number().optional(),
          percent: z.number().nullable().optional(),
          scores: z.object({
            original: z.number(),
            baseline: z.number(),
            benchmark: z.number(),
            maximum: z.number(),
          }).nullable().optional(),
          error: z.string().optional(),
          rank: z.number().int().optional(),
          deltaPercentVsTop: z.number().optional(),
        })).optional(),
        ranking: z.array(z.object({
          rank: z.number().int(),
          index: z.number().int(),
          preset: z.record(z.string(), z.unknown()),
          benchmarkScore: z.number(),
          deltaPercentVsTop: z.number(),
        })).optional(),
        // sweep="sets"(套装基准审计)分支
        config: z.object({
          lightCone: z.string(),
          characterEidolon: z.number(),
          lightConeSuperimposition: z.number(),
          setTypes: z.array(z.string()),
          spdBreakpoints: z.array(z.number()),
          modes: z.array(z.string()),
          errRope: z.array(z.string()),
          scoringModes: z.array(z.string()),
          teammates: z.array(z.string()),
        }).optional().describe('sweep="sets":生效的审计配置'),
        reference: z.object({
          relic: z.string(),
          ornament: z.string(),
        }).optional().describe('sweep="sets":参照套装(角色评分元数据的第一组推荐套装,网页端 "Compared to" 同款)'),
        summaries: z.array(z.object({
          type: z.enum(['relic4p', 'relic2p2p', 'ornament']),
          label: z.string(),
          relicSet1: z.string(),
          relicSet2: z.string(),
          ornamentSet: z.string(),
          matched: z.boolean().describe('是否已在角色评分元数据的推荐套装名单里(绿底)'),
          flag: z.enum(['red', 'yellow']).nullable().describe('red=不在名单却持平或更高;yellow=差距在 2% 以内;null=其余/已在名单'),
          bestDelta: z.number().describe('与参照分的最佳差距(百分比)'),
          bestDeltaParams: z.object({ spd: z.number(), errRope: z.boolean(), subDps: z.boolean() }),
          results: z.array(z.object({
            spd: z.number(),
            errRope: z.boolean(),
            subDps: z.boolean(),
            modeLabel: z.string().nullable(),
            score: z.number(),
            referenceScore: z.number(),
            deltaPct: z.number(),
            flag: z.enum(['red', 'yellow']).nullable(),
            error: z.boolean(),
          })).describe('展开数据:每组参数下的分数、参照分与差距(网页端展开行)'),
        })).optional().describe('sweep="sets":按 red→yellow→其余、最佳差距降序排列的套装汇总'),
      },
    },
    async (
      {
        characterId,
        sweep,
        presets,
        sweepOptions,
        lightCone,
        lightConeSuperimposition,
        characterEidolon,
        errRope,
        subDps,
        teammates,
        setConditionals,
        candidateLimit,
        includeCandidateDetails,
        includePerfection,
      },
      extra,
    ): Promise<CallToolResult> => {
      runtimeContext.ensureMetadataReady()
      runtimeContext.requireSave()

      // Web benchmarks semantics: the character only needs simulation scoring
      // metadata — being in the save merely seeds the form defaults
      // (handleCharacterSelectChange: saved lightCone/eidolon/superimposition
      // for owned characters; light cone cleared + 0/1 for un-owned).
      const gameCharacters = getGameMetadata().characters as Record<string, Any>
      if (!gameCharacters[characterId]) {
        throw new Error(`未知角色 id ${characterId}——不在游戏元数据中(可用 id 见 characters-metadata 资源或 load_save 返回)`)
      }
      const character = getCharacterById(characterId as Any) ?? null // null = 未入库角色
      const simulationMetadata = getScoringMetadata(characterId as Any)?.simulation
        ?? gameCharacters[characterId]?.scoringMetadata?.simulation
      if (!simulationMetadata) {
        throw new Error(`角色 ${characterId} 没有战斗基准评分元数据(网页端 Benchmarks 页签不支持该角色)——无法跑基准测试`)
      }

      // ── sweep="sets":套装基准审计(metadata 页 Set Benchmark Auditor) ──────
      if (sweep === 'sets') {
        return await runSetSweep({
          character,
          characterId,
          simulationMetadata,
          sweepOptions,
          lightCone,
          lightConeSuperimposition,
          characterEidolon,
          teammates,
          extra,
        })
      }

      if (presets == null) {
        throw new Error('benchmark_runs: sweep="presets"(默认)需要 presets(预设列表)——或改用 sweep="sets" 跑套装审计网格')
      }

      for (const [index, preset] of presets.entries()) {
        assertRelicSetName(preset.relicSet1)
        assertRelicSetName(preset.relicSet2)
        if (preset.ornamentSet != null) assertOrnamentSetName(preset.ornamentSet)
        if (
          presets.findIndex((p) =>
            p.relicSet1 === preset.relicSet1 && p.relicSet2 === preset.relicSet2
            && p.ornamentSet === preset.ornamentSet && p.spdThreshold === preset.spdThreshold
          ) !== index
        ) {
          throw new Error(`预设 ${index} 与更早的预设重复——请去重后重试`)
        }
      }
      if (lightCone != null && !(getGameMetadata().lightCones as Record<string, unknown>)[lightCone]) {
        throw new Error(`未知光锥 id ${lightCone}`)
      }
      if (setConditionals != null) assertSetConditionalKeys(setConditionals)
      for (const mate of teammates ?? []) {
        if (mate.teamRelicSet != null) assertRelicSetName(mate.teamRelicSet)
        if (mate.teamOrnamentSet != null) assertOrnamentSetName(mate.teamOrnamentSet)
      }

      // Teammates: explicit overrides win, else the effective scoring metadata's
      // team (verbatim, including any teamRelicSet/teamOrnamentSet the metadata
      // recommends — the web drops them into the store the same way)
      type ResolvedTeammate = SimpleCharacter & { teamRelicSet?: string, teamOrnamentSet?: string }
      const defaultTeammates = ((simulationMetadata as Any).teammates ?? []) as Array<{
        characterId: string,
        lightCone?: string,
        characterEidolon?: number,
        lightConeSuperimposition?: number,
        teamRelicSet?: string,
        teamOrnamentSet?: string,
      }>
      const requestedTeammates = teammates ?? defaultTeammates.map((mate) => ({
        characterId: mate.characterId,
        lightCone: mate.lightCone,
        characterEidolon: mate.characterEidolon ?? 0,
        lightConeSuperimposition: mate.lightConeSuperimposition ?? 1,
        teamRelicSet: mate.teamRelicSet,
        teamOrnamentSet: mate.teamOrnamentSet,
      }))
      const resolvedTeammates: ResolvedTeammate[] = requestedTeammates.map((mate, index) => ({
        // Literal-union ids are proven by the metadata validation loop below.
        characterId: mate.characterId as CharacterId,
        lightCone: (mate.lightCone ?? defaultTeammates[index]?.lightCone) as LightConeId,
        characterEidolon: mate.characterEidolon ?? defaultTeammates[index]?.characterEidolon ?? 0,
        lightConeSuperimposition: mate.lightConeSuperimposition ?? defaultTeammates[index]?.lightConeSuperimposition ?? 1,
        teamRelicSet: mate.teamRelicSet ?? undefined,
        teamOrnamentSet: mate.teamOrnamentSet ?? undefined,
      }))
      while (resolvedTeammates.length < 3) {
        const fallback = defaultTeammates[resolvedTeammates.length]
        if (!fallback) throw new Error('基准测试需要三名队友——评分元数据推荐队不完整且未通过 teammates 覆盖')
        resolvedTeammates.push({
          characterId: fallback.characterId as CharacterId,
          lightCone: fallback.lightCone as LightConeId,
          characterEidolon: fallback.characterEidolon ?? 0,
          lightConeSuperimposition: fallback.lightConeSuperimposition ?? 1,
        })
      }
      for (const mate of resolvedTeammates) {
        if (!(getGameMetadata().characters as Record<string, unknown>)[mate.characterId]) {
          throw new Error(`队友角色 id ${mate.characterId} 不存在于游戏元数据`)
        }
        if (mate.lightCone == null || !(getGameMetadata().lightCones as Record<string, unknown>)[mate.lightCone]) {
          throw new Error(`队友 ${mate.characterId} 的光锥 "${mate.lightCone ?? ''}" 不存在——请显式传入 teammates 或修正评分元数据`)
        }
      } // Run the optimal-simulation search inline on the main thread (dps_score's
      // spike-verified pattern) — the browser worker pool is not wired here.

      ;(globalThis as Any).SEQUENTIAL_BENCHMARKS = true

      // Job registry (M4-B): ONE job per batch — cancellation only lands
      // between presets and the tool returns a single aggregated result, so
      // per-preset granularity lives in progress (completedPresets/
      // totalPresets) instead of one job per preset. cancel_job aborts the
      // linked controller, checked at the top of each preset iteration.
      // Resolved before the job is registered: this guard throws, and the
      // per-preset try below only settles jobs for throws INSIDE the loop —
      // an earlier registerJob would leave a running zombie.
      if (!(lightCone ?? character?.form.lightCone)) {
        throw new Error(
          character == null
            ? `角色 ${characterId} 不在当前存档中且未传入 lightCone——网页端未入库角色需要手动选择光锥后才能生成基准,请显式传入 lightCone`
            : `角色 ${characterId} 没有配置光锥(存档表单与覆盖项均为空)——请先 upsert_character 设置光锥或传入 lightCone`,
        )
      }

      const jobId = nextJobId('bench')
      const cancelController = linkedAbortController(extra.signal)
      registerJob(jobId, 'benchmark_runs', {
        cancel: () => cancelController.abort(),
        summary: {
          characterId,
          presets: presets.map((preset) =>
            `${preset.relicSet1}${preset.relicSet2 === preset.relicSet1 ? ' (4pc)' : ` + ${preset.relicSet2}`} × ${
              preset.ornamentSet ?? '(元数据推荐饰品)'
            } @SPD≥${preset.spdThreshold ?? 0}`
          ),
        },
        progress: { completedPresets: 0, totalPresets: presets.length },
      })

      const progressToken = (extra._meta as Any)?.progressToken
      const notify = (completed: number, message: string) => {
        // Job progress updates always land (get_job reads them); the
        // notification itself only goes out when a progressToken was sent.
        updateJobProgress(jobId, { completedPresets: completed, totalPresets: presets.length, phase: message })
        if (progressToken == null) return
        void extra.sendNotification({
          method: 'notifications/progress' as const,
          params: { progressToken, progress: completed, total: presets.length, message },
        } as Any).catch(() => {})
      }

      // Owned → saved-form defaults (web handleCharacterSelectChange); un-owned
      // → eidolon 0 / superimposition 1 and an explicit light cone (guarded above)
      const baseBenchmarkForm = {
        characterId,
        lightCone: lightCone ?? character?.form.lightCone,
        characterEidolon: characterEidolon ?? character?.form.characterEidolon ?? 0,
        lightConeSuperimposition: lightConeSuperimposition ?? character?.form.lightConeSuperimposition ?? 1,
        errRope,
        subDps: subDps ?? !!simulationMetadata.deprioritizeBuffs,
      }
      if (!baseBenchmarkForm.lightCone) {
        throw new Error(
          character == null
            ? `角色 ${characterId} 不在当前存档中且未传入 lightCone——网页端未入库角色需要手动选择光锥后才能生成基准,请显式传入 lightCone`
            : `角色 ${characterId} 没有配置光锥(存档表单与覆盖项均为空)——请先 upsert_character 设置光锥或传入 lightCone`,
        )
      }

      const started = performance.now()
      const results: Array<Record<string, unknown>> = []
      let cancelled = false
      // Captured before the preset loop; rechecked at the top of every
      // iteration (see the generation gate inside the loop).
      const generation = runtimeContext.getSaveGeneration()

      // Result-table row context (BenchmarkResults.generateBenchmarkRows):
      // candidates are collected during the loop and serialized once the
      // batch-wide tops are known (deltas are relative to the best row of the
      // whole call, and the baseline to the best zero-mains score).
      const characterElement = (gameCharacters[characterId]?.element ?? '') as string
      const elementalDmgValue = (ElementToDamage as Record<string, string>)[characterElement]
      const presetCandidates = new Map<number, {
        benchmark: Simulation[],
        perfection: Simulation[],
        baselineScore: number,
      }>()

      // A throw escaping the per-preset catch (e.g. an unresolvable ornament
      // set) must settle the job failed instead of leaving a running zombie.
      try {
        for (const [index, preset] of presets.entries()) {
          if (cancelController.signal.aborted) {
            cancelled = true
            notify(results.length, `cancelled before preset ${index + 1}/${presets.length}`)
            break
          }

          // Generation gate (mirrors optimize): the orchestrator awaits below
          // yield to the event loop; a load_save in that window means the
          // remaining presets would silently score the PREVIOUS save's
          // inventory. Stop the batch instead.
          if (generation !== runtimeContext.getSaveGeneration()) {
            throw new Error('A load_save changed the save while benchmark_runs was running — 已完成的预设结果基于旧存档;请对当前存档重新运行')
          }

          const benchmarkForm: BenchmarkForm = {
            ...baseBenchmarkForm,
            basicSpd: preset.spdThreshold ?? 0,
            simRelicSet1: preset.relicSet1,
            simRelicSet2: preset.relicSet2,
            simOrnamentSet: preset.ornamentSet ?? simulationMetadata.ornamentSets?.[0],
            teammate0: resolvedTeammates[0],
            teammate1: resolvedTeammates[1],
            teammate2: resolvedTeammates[2],
            setConditionals: clone(defaultSetConditionals),
          } as BenchmarkForm
          if (benchmarkForm.simOrnamentSet == null) {
            throw new Error(`预设 ${index} 无法确定位面饰品套装——评分元数据没有推荐饰品,请显式传入 preset.ornamentSet`)
          }

          // handleCharacterSelectChange's preset recipe: set-conditional defaults
          // seeded per character element/path, then scoring-metadata presets.
          // Custom teammates additionally get the web's teammate-change pass
          // (applyTeamAwareSetConditionalPresetsToBenchmarkFormInstance:
          // team-aware presets + teammate-conditioned presets re-gated on the
          // new team, non-matching ones reset to defaults). Manual
          // setConditionals apply last — the web drawer edits after presets.
          const teammateInfo = resolveTeammateInfo(...resolvedTeammates)
          applySetConditionalPresets(benchmarkForm, teammateInfo)
          applyScoringMetadataPresets(benchmarkForm, teammateInfo)
          if (teammates != null) {
            applyTeamAwareSetConditionalPresets(benchmarkForm, teammateInfo)
            applyTeammateConditionalPresets(benchmarkForm, teammateInfo)
          }
          if (setConditionals != null) {
            // computeSetSetConditional semantics: the drawer writes tuple[1]
            for (const [set, value] of Object.entries(setConditionals)) {
              ;(benchmarkForm.setConditionals as Record<string, [undefined, boolean | number]>)[set] = [undefined, value]
            }
          }

          const presetStart = performance.now()
          const entry: Record<string, unknown> = {
            index,
            preset: {
              relicSet1: preset.relicSet1,
              relicSet2: preset.relicSet2,
              ornamentSet: benchmarkForm.simOrnamentSet,
              spdThreshold: preset.spdThreshold ?? 0,
            },
          }
          try {
            const orchestrator = await runCustomBenchmarkOrchestrator(
              benchmarkForm,
              includePerfection ? undefined : { benchmarkOnly: true },
            )
            const candidates = orchestrator.benchmarkSimCandidates ?? []
            entry.status = 'completed'
            entry.durationMs = Math.round(performance.now() - presetStart)
            entry.benchmarkScore = orchestrator.benchmarkSimScore
            entry.bestBuild = orchestrator.benchmarkSimRequest ? echoSimRequest(orchestrator.benchmarkSimRequest) : null
            entry.candidateCount = candidates.length
            // Raw candidates stashed for post-loop serialization (web rows are
            // ranked against the whole call's top, not the single preset)
            presetCandidates.set(index, {
              benchmark: candidates,
              perfection: includePerfection ? (orchestrator.perfectionSimCandidates ?? []) : [],
              baselineScore: orchestrator.zeroMainsStatResult?.simScore ?? 0,
            })
            entry.originalSpd = orchestrator.originalSpd ?? null
            entry.spdBenchmark = orchestrator.spdBenchmark ?? null
            entry.benchmarkBasicSpdTarget = orchestrator.flags.benchmarkBasicSpdTarget
            if (includePerfection) {
              entry.perfectionScore = orchestrator.perfectionSimScore
              entry.percent = orchestrator.percent ?? null
              entry.scores = orchestrator.simulationScore
                ? {
                  original: orchestrator.simulationScore.originalSimScore,
                  baseline: orchestrator.simulationScore.baselineSimScore,
                  benchmark: orchestrator.simulationScore.benchmarkSimScore,
                  maximum: orchestrator.simulationScore.maximumSimScore,
                }
                : null
            }
          } catch (e) {
            entry.status = 'error'
            entry.error = String((e as Error)?.message ?? e)
          }
          results.push(entry)
          notify(results.length, `preset ${results.length}/${presets.length} done (${String(entry.status)})`)
        }
      } catch (e) {
        finishJob(jobId, 'failed', {
          error: String((e as Error)?.message ?? e),
          completedPresets: results.length,
          totalPresets: presets.length,
        })
        throw e
      }

      const durationMs = Math.round(performance.now() - started)
      finishJob(jobId, cancelled ? 'cancelled' : 'completed', {
        completedPresets: results.filter((r) => r.status === 'completed').length,
        totalPresets: presets.length,
        durationMs,
      })

      // Ranking among completed presets (web grid semantics: combo desc, delta % vs top)
      const completed = results.filter((r) => r.status === 'completed') as Array<{
        index: number,
        benchmarkScore: number,
        perfectionScore?: number,
        preset: Record<string, unknown>,
      }>
      const topScore = completed.length ? Math.max(...completed.map((r) => r.benchmarkScore)) : 0
      const ranked = [...completed].sort((a, b) => b.benchmarkScore - a.benchmarkScore)
      const rankOf = new Map(ranked.map((r, i) => [r.index, i + 1]))
      for (const entry of results) {
        const idx = entry.index as number
        if (rankOf.has(idx)) {
          entry.rank = rankOf.get(idx)
          entry.deltaPercentVsTop = topScore !== 0 ? ((entry.benchmarkScore as number) - topScore) / topScore * 100 : 0
        }
      }

      // Result-table rows (BenchmarkResults.generateBenchmarkRows semantics):
      // both scoring modes' candidate lists, ranked against the whole call's
      // tops; candidateLimit caps the rows, includeCandidateDetails adds the
      // expanded-row payload.
      const topPerfectionScore = completed.length
        ? Math.max(...completed.map((r) => r.perfectionScore ?? 0))
        : 0
      const topBaselineScore = Math.max(0, ...[...presetCandidates.values()].map((c) => c.baselineScore))
      for (const entry of results) {
        const stash = presetCandidates.get(entry.index as number)
        if (stash == null) continue
        entry.topCandidates = stash.benchmark.slice(0, candidateLimit).map((candidate) => ({
          ...serializeBenchmarkCandidate({
            candidate,
            element: characterElement,
            elementalDmgValue,
            detail: includeCandidateDetails,
          }),
          ...candidateDeltaPercents(candidate.result!.simScore, topScore, topBaselineScore),
        }))
        if (includePerfection && stash.perfection.length > 0) {
          entry.perfectionTopCandidates = stash.perfection.slice(0, candidateLimit).map((candidate) => ({
            ...serializeBenchmarkCandidate({
              candidate,
              element: characterElement,
              elementalDmgValue,
              detail: includeCandidateDetails,
            }),
            ...candidateDeltaPercents(candidate.result!.simScore, topPerfectionScore, topBaselineScore),
          }))
        }
      }

      return toolResult(
        {
          characterId,
          sweep: 'presets',
          form: {
            lightCone: baseBenchmarkForm.lightCone,
            characterEidolon: baseBenchmarkForm.characterEidolon,
            lightConeSuperimposition: baseBenchmarkForm.lightConeSuperimposition,
            errRope,
            subDps: baseBenchmarkForm.subDps,
            teammates: resolvedTeammates.map((mate) => mate.characterId),
            teammateSets: resolvedTeammates.map((mate) => ({
              ...(mate.teamRelicSet != null ? { teamRelicSet: mate.teamRelicSet } : { teamRelicSet: null }),
              ...(mate.teamOrnamentSet != null ? { teamOrnamentSet: mate.teamOrnamentSet } : { teamOrnamentSet: null }),
            })),
          },
          includePerfection,
          cancelled,
          durationMs,
          presets: results,
          ranking: ranked.map((r, i) => ({
            rank: i + 1,
            index: r.index,
            preset: r.preset,
            benchmarkScore: r.benchmarkScore,
            deltaPercentVsTop: topScore !== 0 ? (r.benchmarkScore - topScore) / topScore * 100 : 0,
          })),
        },
        `${characterId} 基准测试${cancelled ? '(已取消,保留已完成部分)' : '完成'}:${completed.length}/${presets.length} 个预设成功,`
          + `耗时 ${durationMs}ms。`
          + (ranked.length
            ? `最优预设 #${ranked[0].index}(COMBO ${ranked[0].benchmarkScore.toLocaleString()})`
            : '没有成功的预设'),
      )
    },
  )
}
