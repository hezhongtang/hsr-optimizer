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
//                     fanned out over 4pc-set × SPD-threshold presets
//
// Damage-split labels resolve through the offline i18next bootstrap
// (ensureI18nReady → zh_CN), the same singleton upstream reads.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import i18next from 'i18next'
import {
  applyScoringMetadataPresets,
  applySetConditionalPresets,
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
import { RelicFilters } from 'lib/relics/relicFilters'
import {
  SetsOrnamentsNames,
  SetsRelicsNames,
} from 'lib/sets/setConfigRegistry'
import { aggregatePerActionBuffs } from 'lib/simulations/combatBuffsAnalysis'
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
} from 'lib/simulations/statSimulationTypes'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  getCharacterById,
  getCharacters,
} from 'lib/stores/character/characterStore'
import { displayToInternal } from 'lib/stores/optimizerForm/optimizerFormConversions'
import { computeLoadForm } from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import { getRelicById } from 'lib/stores/relic/relicStore'
import { getScoringMetadata } from 'lib/stores/scoring/scoringStore'
import type {
  BenchmarkForm,
  SimpleCharacter,
} from 'lib/tabs/tabBenchmarks/useBenchmarksTabStore'
import { extractDamageSplits } from 'lib/tabs/tabOptimizer/analysis/damageSplitsExtractor'
import {
  calculateStatUpgrades,
  calculateTeammateUpgrades,
} from 'lib/tabs/tabOptimizer/analysis/expandedDataPanelController'
import type { OptimizerResultAnalysis } from 'lib/tabs/tabOptimizer/analysis/expandedDataPanelController'
import { clone } from 'lib/utils/objectUtils'
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const MAX_STAT_SIM_VARIANTS = 12
const MAX_BENCHMARK_PRESETS = 16
const TOP_BENCHMARK_CANDIDATES = 5
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
      + '(每条带来源归因 source.buffType=角色/光锥/套装、source.ability=技能/行迹/星魂)、基础属性增益追踪与完整容器归约。',
    inputSchema: {
      characterId: z.string().describe('角色 id,如 "1212b1"(可用 id 见 load_save 返回的 characterIds)'),
      relicIds: z.array(z.string()).min(1).max(6).optional().describe('遗器 id 列表(每部件一件;缺省取角色当前装备)'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(FORM_OVERRIDES_DESCRIPTION),
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
    },
  }, async ({ characterId, relicIds, formOverrides, trace }): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = requireCharacter(characterId)
    const form = buildCharacterForm(character, formOverrides)
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

    const buildByPart = resolveBuildByPart(characterId, relicIds)
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
        fromEquipped: relicIds == null,
      },
      trace,
      durationMs,
      stats,
      actionDamage: built.actionDamage ? serializeActionDamage(built.actionDamage) : null,
      rotationDamage: (built.rotationDamage ?? []).map(serializeRotationDamageStep),
    }

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
      + '逐技能与轮次伤害,以及相对基准变体(默认第 0 个,可指定 baselineIndex)的差值与全部变体排名。',
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
      })).min(1).max(MAX_STAT_SIM_VARIANTS).describe('变体列表(上游 SimulationRequest 字段名)'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(FORM_OVERRIDES_DESCRIPTION),
      quality: z.number().min(0).max(1).default(1).describe('副词条品质(1=最高 roll,上游默认)'),
      speedRollValue: z.number().min(0).default(2.6).describe('SPD 每 roll 数值(上游默认 2.6)'),
      baselineIndex: z.number().int().min(0).default(0).describe('作为差值基准的变体下标(默认第 0 个)'),
    },
    outputSchema: {
      characterId: z.string(),
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
    },
  }, async ({ characterId, simulations, formOverrides, quality, speedRollValue, baselineIndex }): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = requireCharacter(characterId)
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

    const form = buildCharacterForm(character, formOverrides)
    const context = generateContext(form)
    if (!context.defaultActions?.length) {
      throw new Error(`角色 ${characterId} 的配置未生成任何默认战斗动作——请检查角色/光锥配置后再试`)
    }

    const sims: Simulation[] = simulations.map((sim, index) => ({
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

    const started = performance.now()
    // stabilize:true clones each result so per-variant stats can't alias the
    // next simulation's arrays (upstream Stat Simulations tab does the same).
    const results = runStatSimulations(sims, form, context, { quality, speedRollValue, stabilize: true })
    const durationMs = Math.round(performance.now() - started)

    const baselineScore = results[baselineIndex]?.simScore ?? 0
    const bestScore = Math.max(...results.map((r) => r.simScore))
    const variants = results.map((result, index) => ({
      index,
      name: sims[index].name,
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
    }))

    const ranking = variants
      .map((v) => ({ index: v.index, name: v.name, simScore: v.simScore }))
      .sort((a, b) => b.simScore - a.simScore)

    return toolResult(
      {
        characterId,
        baselineIndex,
        params: { quality, speedRollValue },
        durationMs,
        variants,
        ranking,
      },
      `${characterId} 的 ${variants.length} 个假想配装模拟完成,耗时 ${durationMs}ms:`
        + `最佳变体 #${ranking[0]?.index}(${ranking[0]?.name},COMBO ${ranking[0]?.simScore.toLocaleString()}),`
        + `基准变体 #${baselineIndex} 为 ${baselineScore.toLocaleString()}`,
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
      + '基础表单取角色已保存的优化表单,可传 formOverrides。',
    inputSchema: {
      characterId: z.string().describe('角色 id,如 "1212b1"'),
      newRelicIds: z.array(z.string()).min(1).max(6).describe('候选(新)配装的遗器 id 列表,每部件一件'),
      oldRelicIds: z.array(z.string()).min(1).max(6).optional().describe('基准(旧)配装遗器 id;缺省取角色当前装备'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(FORM_OVERRIDES_DESCRIPTION),
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
    },
  }, async ({ characterId, newRelicIds, oldRelicIds, formOverrides }): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = requireCharacter(characterId)
    const oldByPart = resolveBuildByPart(characterId, oldRelicIds)
    const newByPart = resolveBuildByPart(characterId, newRelicIds)

    // generateAnalysisData recipe, with the row-id decode replaced by explicit ids
    const request = clone(buildCharacterForm(character, formOverrides)) as Any
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
      description: 'Benchmarks 页签的无头版(runCustomBenchmarkOrchestrator,同一条上游链路):对角色按预设集'
        + '(4pc 候选套装 × SPD 阈值)批量跑战斗基准,返回每预设的 COMBO 伤害(100% 基准配装)、200% 极限分与百分比得分,'
        + '并按 COMBO 排名、给出与最优预设的差距。角色/光锥/星魂默认取存档中角色表单,队友默认取该角色评分元数据的推荐队,'
        + '均可覆盖;SPD 阈值 0 或缺省表示不限速(其余常用值如 120.000/133.334,与网页端 SPD 下拉一致)。'
        + '长任务:提供 progressToken 时逐预设发送进度通知,取消(cancel)会在当前预设结束后停止并返回已完成部分。',
      inputSchema: {
        characterId: z.string().describe('角色 id(须有战斗评分元数据,即网页端 Benchmarks 页签可选的角色)'),
        presets: z.array(z.object({
          relicSet1: z.string().describe('遗器套装 1(与套装 2 相同即 4pc)'),
          relicSet2: z.string().describe('遗器套装 2'),
          ornamentSet: z.string().optional().describe('位面饰品套装;缺省取评分元数据的第一个推荐饰品'),
          spdThreshold: z.number().min(0).optional().describe('SPD 阈值(基础面板速度下限),0 或缺省不限速'),
        })).min(1).max(MAX_BENCHMARK_PRESETS).describe('预设列表(4pc 候选 × SPD 阈值)'),
        lightCone: z.string().optional().describe('覆盖光锥 id(缺省取角色表单)'),
        lightConeSuperimposition: z.number().int().min(1).max(5).optional().describe('覆盖光锥叠影'),
        characterEidolon: z.number().int().min(0).max(6).optional().describe('覆盖星魂'),
        errRope: z.boolean().default(false).describe('是否强制充能绳(与网页端 ERR Rope 开关一致)'),
        subDps: z.boolean().optional().describe('副C模式(降低队友增益权重);缺省取评分元数据默认'),
        teammates: z.array(z.object({
          characterId: z.string(),
          lightCone: z.string().optional().describe('缺省取推荐队配置'),
          characterEidolon: z.number().int().min(0).max(6).optional(),
          lightConeSuperimposition: z.number().int().min(1).max(5).optional(),
        })).max(3).optional().describe('覆盖队友(缺省取评分元数据推荐队)'),
        includePerfection: z.boolean().default(true).describe('是否同时跑 200% 极限模拟(更全面的得分,耗时约翻倍)'),
      },
      outputSchema: {
        characterId: z.string(),
        form: z.object({
          lightCone: z.string(),
          characterEidolon: z.number(),
          lightConeSuperimposition: z.number(),
          errRope: z.boolean(),
          subDps: z.boolean(),
          teammates: z.array(z.string()),
        }),
        includePerfection: z.boolean(),
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
          topCandidates: z.array(echoedSimRequestSchema.extend({ simScore: z.number() })).optional(),
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
        })),
        ranking: z.array(z.object({
          rank: z.number().int(),
          index: z.number().int(),
          preset: z.record(z.string(), z.unknown()),
          benchmarkScore: z.number(),
          deltaPercentVsTop: z.number(),
        })),
      },
    },
    async (
      { characterId, presets, lightCone, lightConeSuperimposition, characterEidolon, errRope, subDps, teammates, includePerfection },
      extra,
    ): Promise<CallToolResult> => {
      runtimeContext.ensureMetadataReady()
      runtimeContext.requireSave()

      const character = requireCharacter(characterId)
      const simulationMetadata = getScoringMetadata(characterId as Any)?.simulation
        ?? (getGameMetadata().characters as Record<string, Any>)[characterId]?.scoringMetadata?.simulation
      if (!simulationMetadata) {
        throw new Error(`角色 ${characterId} 没有战斗基准评分元数据(网页端 Benchmarks 页签不支持该角色)——无法跑基准测试`)
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

      // Teammates: explicit overrides win, else the effective scoring metadata's team
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
        // Literal-union ids are proven by the metadata validation loop below.
        characterId: mate.characterId as CharacterId,
        lightCone: (mate.lightCone ?? defaultTeammates[index]?.lightCone) as LightConeId,
        characterEidolon: mate.characterEidolon ?? defaultTeammates[index]?.characterEidolon ?? 0,
        lightConeSuperimposition: mate.lightConeSuperimposition ?? defaultTeammates[index]?.lightConeSuperimposition ?? 1,
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

      const progressToken = (extra._meta as Any)?.progressToken
      const notify = (completed: number, message: string) => {
        if (progressToken == null) return
        void extra.sendNotification({
          method: 'notifications/progress' as const,
          params: { progressToken, progress: completed, total: presets.length, message },
        } as Any).catch(() => {})
      }

      const baseBenchmarkForm = {
        characterId,
        lightCone: lightCone ?? character.form.lightCone,
        characterEidolon: characterEidolon ?? character.form.characterEidolon ?? 0,
        lightConeSuperimposition: lightConeSuperimposition ?? character.form.lightConeSuperimposition ?? 1,
        errRope,
        subDps: subDps ?? !!simulationMetadata.deprioritizeBuffs,
      }
      if (!baseBenchmarkForm.lightCone) {
        throw new Error(`角色 ${characterId} 没有配置光锥(存档表单与覆盖项均为空)——请先 upsert_character 设置光锥或传入 lightCone`)
      }

      const started = performance.now()
      const results: Array<Record<string, unknown>> = []
      let cancelled = false

      for (const [index, preset] of presets.entries()) {
        if (extra.signal?.aborted) {
          cancelled = true
          notify(results.length, `cancelled before preset ${index + 1}/${presets.length}`)
          break
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
        // seeded per character element/path, then scoring-metadata presets
        const teammateInfo = resolveTeammateInfo(...resolvedTeammates)
        applySetConditionalPresets(benchmarkForm, teammateInfo)
        applyScoringMetadataPresets(benchmarkForm, teammateInfo)

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
          entry.topCandidates = candidates.slice(0, TOP_BENCHMARK_CANDIDATES).map((candidate) => ({
            simScore: candidate.result?.simScore ?? 0,
            ...echoSimRequest(candidate.request),
          }))
          entry.candidateCount = candidates.length
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

      const durationMs = Math.round(performance.now() - started)

      // Ranking among completed presets (web grid semantics: combo desc, delta % vs top)
      const completed = results.filter((r) => r.status === 'completed') as Array<{ index: number, benchmarkScore: number, preset: Record<string, unknown> }>
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

      return toolResult(
        {
          characterId,
          form: {
            lightCone: baseBenchmarkForm.lightCone,
            characterEidolon: baseBenchmarkForm.characterEidolon,
            lightConeSuperimposition: baseBenchmarkForm.lightConeSuperimposition,
            errRope,
            subDps: baseBenchmarkForm.subDps,
            teammates: resolvedTeammates.map((mate) => mate.characterId),
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
