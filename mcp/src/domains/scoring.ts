// Scoring domain: `score_relics` (stat scoring + relic potential + estTBP),
// `dps_score` (Engine B combat benchmark scoring) and `score_character`
// (the showcase card's full SimScoring surface — all four scoring configs,
// every card source, temporary team/spd options, buff analysis).
//
// score_relics runs fully synchronous on the main thread via the pure scorer
// entry points (RelicScorer instance methods + scoreTbp direct call) — the
// spike-verified pattern (162 relics in ~7ms; estTBP adds a few ms per 5★).
// scope=all/custom mirrors scoreRelicsAsync's O(relics × characters) loop
// (scoreRelicsBatch semantics) but page-bounded, on the main thread.
//
// dps_score / score_character mirror the web showcase's orchestrator chain:
//   resolveSimulationMetadata → prepareOrchestrator → executeOrchestrator
//   → executeUpgradeOrchestrator, with SEQUENTIAL_BENCHMARKS=true so the
//   optimal-simulation search runs inline on the main thread (measured ~0.3s)
//   instead of the browser worker pool. The resulting SimulationScore is
//   reduced to JSON-safe data by serializers/scoring.ts.
//
// score_character differs from dps_score the same way the card differs from
// its DPS panel: config ∈ {dps,buffer,heal,shield} (auto = the card's default
// scoring type walk), team auto/default/custom/ephemeral (handleTeamSelection
// semantics; an inline team never touches the save), spdBenchmark
// (ShowcaseTemporaryOptions → orchestrator.setOriginalBuild), deprioritizeBuffs
// (DPS-only per-run override), trace=true (BuffsAnalysisDisplay.rerunSim over
// the scoring simulation form), and three card sources — roster, a saved build
// (BuildsModal BuildPreview: build's relics + eidolon/lightCone + team) or an
// unimported showcase character (fetch_showcase cache, with the simulation
// sidebar's character override). MCP calls the computation layer directly —
// no UI request lifecycle (SimScoringContext caches/progress are bypassed).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  resolveShowcaseScoringOrder,
  resolveShowcaseScoringType,
} from 'lib/characterPreview/scoring/showcaseScoringOrder'
import { resolveEffectiveDeprioritizeBuffs } from 'lib/characterPreview/showcaseDerivedData'
import { countRelicRolls } from 'lib/characterPreview/summary/statScoringSummaryController'
import { getCharacterConfig } from 'lib/conditionals/resolver/characterConfigRegistry'
import {
  CUSTOM_TEAM,
  DEFAULT_TEAM,
} from 'lib/constants/constants'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { scoreTbp } from 'lib/relics/estTbp/estTbp'
import { RelicScorer } from 'lib/relics/scoring/relicScorer'
import {
  CONFIG_DISPLAY_ORDER,
  configTypeForScoringType,
  SCORING_CONFIG_REGISTRY,
} from 'lib/scoring/scoringConfig'
import { originalScoringParams } from 'lib/scoring/simScoringUtils'
import {
  SetsOrnamentsNames,
  SetsRelicsNames,
} from 'lib/sets/setConfigRegistry'
import {
  executeOrchestrator,
  executeUpgradeOrchestrator,
  prepareOrchestrator,
  resolveSimulationMetadata,
} from 'lib/simulations/orchestrator/runDpsScoreBenchmarkOrchestrator'
import { runStatSimulations } from 'lib/simulations/statSimulation'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  getCharacterById,
  getCharacters,
} from 'lib/stores/character/characterStore'
import {
  getRelicById,
  getRelics,
} from 'lib/stores/relic/relicStore'
import { getScoringMetadata } from 'lib/stores/scoring/scoringStore'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import {
  clone,
  objectHash,
} from 'lib/utils/objectUtils'
import { ScoringConfigType } from 'types/metadata'
import type { Relic } from 'types/relic'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { serializeSimulationScore } from '../serializers/scoring'
import {
  serializeActionDamage,
  serializeBuff,
  serializeComputedStats,
  serializeRotationDamageStep,
} from '../serializers/stats'
import { toolResult } from '../toolResult'
import { getShowcaseCache } from './showcase'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

function filterRelics(relics: Relic[], input: {
  part?: string | undefined,
  set?: string | undefined,
  mainStat?: string | undefined,
  subStat?: string | undefined,
  enhance?: number | undefined,
  grade?: number | undefined,
  equippedBy?: string | undefined,
  verified?: boolean | undefined,
}): Relic[] {
  return relics.filter((relic) => {
    if (input.part != null && relic.part !== input.part) return false
    if (input.set != null && relic.set !== input.set) return false
    if (input.mainStat != null && relic.main.stat !== input.mainStat) return false
    if (input.subStat != null && !relic.substats.some((s) => s.stat === input.subStat)) return false
    if (input.enhance != null && relic.enhance !== input.enhance) return false
    if (input.grade != null && relic.grade !== input.grade) return false
    if (input.equippedBy != null) {
      const isEquipped = relic.equippedBy != null
      if (input.equippedBy === 'none' ? isEquipped : relic.equippedBy !== input.equippedBy) return false
    }
    if (input.verified != null && (relic.verified === true) !== input.verified) return false
    return true
  })
}

const relicFilterSchema = {
  part: z.string().optional().describe('部件:Head | Hands | Body | Feet | PlanarSphere | LinkRope'),
  set: z.string().optional().describe('套装名'),
  mainStat: z.string().optional().describe('主词条名,如 "CRIT DMG"'),
  subStat: z.string().optional().describe('含有该副词条'),
  enhance: z.number().int().min(0).max(15).optional(),
  grade: z.number().int().min(2).max(5).optional(),
  equippedBy: z.string().optional().describe('按归属角色过滤,"none" 表示未装备'),
  verified: z.boolean().optional(),
}

// outputSchema 形状——以 handler 实际 return 的对象为准。score_relics 未传
// characterId 时逐件只返回基础字段,评分/潜力/reroll/estTbpDays 均按分支 .optional()。
const scoredRelicSchema = z.object({
  id: z.string(),
  part: z.string(),
  set: z.string(),
  grade: z.number(),
  enhance: z.number(),
  equippedBy: z.string().nullable(),
  current: z.object({ percentScore: z.number(), rating: z.string() }).optional(),
  potential: z.object({
    currentPct: z.number(),
    bestPct: z.number(),
    averagePct: z.number(),
    worstPct: z.number(),
  }).optional(),
  reroll: z.object({
    rerollAvgPct: z.number(),
    blockedRerollAvgPct: z.number(),
    blockedStat: z.string().optional(),
  }).optional(),
  estTbpDays: z.number().optional(),
  // scope=custom|all:网页端遗器表格「自定义角色集/全部角色」两个范围列
  // (scoreRelicsBatch 的 potentialAllCustom/potentialAllAll 口径)
  rangePotential: z.object({
    bestPct: z.number(),
    averagePct: z.number(),
    rerollAvgPct: z.number(),
    blockedRerollAvgPct: z.number(),
    bestCharacterId: z.string(),
  }).optional(),
  // rollsSummary=true:逐件 roll 分布(high/mid/low 合计,网页构筑分析
  // 「遗器稀有度」一栏的每件 roll 统计口径)
  rollsSummary: z.object({
    high: z.number(),
    mid: z.number(),
    low: z.number(),
    total: z.number(),
    weightedRolls: z.number().optional(),
  }).optional(),
})

const simulationRequestSchema = z.object({
  // 上游类型声明这些为 string,但编排器实测对 buffer/heal/shield 配置(或装备
  // 缺件的角色)产出的请求会把不适用字段填 null 或整个省略 —— 与 stats 同理
  // 按实际返回放宽(nullish = null | undefined 都接受)
  relicSet1: z.string().nullish(),
  relicSet2: z.string().nullish(),
  ornamentSet: z.string().nullish(),
  body: z.string().nullish(),
  feet: z.string().nullish(),
  planarSphere: z.string().nullish(),
  linkRope: z.string().nullish(),
  // 上游类型声明为 Record<string, number>,但编排器产出的请求实测对不适用词条
  // (如 DEF%)填 null——按实际返回放宽(dps_score 冒烟实证)
  stats: z.record(z.string(), z.union([z.number(), z.null()])),
})

const serializedUpgradeSchema = z.object({
  part: z.string().optional(),
  stat: z.string().optional(),
  percent: z.number(),
  simScore: z.number(),
  delta: z.number(),
  request: simulationRequestSchema,
})

// serializeComputedStats 的 zod 形状(与 domains/simulation.ts 同一序列化器)
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

// score_character 四套配装(original/baseline/benchmark/maximum)各自的详情
const scoredBuildSchema = z.object({
  request: simulationRequestSchema.nullable(),
  simScore: z.number(),
  stats: computedStatsSchema.nullable(),
  actionDamage: z.record(z.string(), z.number()).nullable(),
  rotationDamage: z.array(rotationDamageStepSchema),
})

/** Sim configs the character has game-metadata defaults for (the card's可选项). */
function availableConfigTypes(characterId: string): ScoringConfigType[] {
  const defaults = (getGameMetadata().characters as Record<string, Any>)[characterId]?.scoringMetadata
  return CONFIG_DISPLAY_ORDER.filter((configType) => defaults?.[SCORING_CONFIG_REGISTRY[configType].metadataField] != null)
}

/**
 * The card's default scoring-type walk (resolveShowcaseScoringData): metadata
 * configured order → remaining available sim configs → SUBSTAT_SCORE/NONE,
 * then the stored per-character showcase preference resolved against it.
 * Returns null when the walk lands on a non-simulation type (SUBSTAT/NONE).
 */
function resolveAutoConfigType(characterId: string): {
  configType: ScoringConfigType | null,
  scoringType: number,
  order: number[],
} {
  const available: Partial<Record<ScoringConfigType, unknown>> = {}
  for (const configType of availableConfigTypes(characterId)) available[configType] = true
  const order = resolveShowcaseScoringOrder(
    getCharacterConfig(characterId as Any)?.display.showcaseScoringOrder,
    available,
  )
  const stored = (useShowcaseTabStore.getState().showcasePreferences as Record<string, { scoringType?: number }> | undefined)?.[characterId]?.scoringType
  const scoringType = resolveShowcaseScoringType(stored, order)
  return { configType: configTypeForScoringType(scoringType) ?? null, scoringType, order: [...order] }
}

/**
 * handleTeamSelection (characterPreviewController): the stored session
 * preference wins (explicit Default beats a custom-team diff); without one,
 * Custom exactly when the effective teammates differ from the game defaults.
 */
function resolveAutoTeamSelection(characterId: string, configType: ScoringConfigType): typeof DEFAULT_TEAM | typeof CUSTOM_TEAM {
  const stored = (useShowcaseTabStore.getState().showcaseTeamPreferenceByConfig as Record<string, Record<string, string> | undefined> | undefined)
    ?.[characterId]?.[configType]
  if (stored === DEFAULT_TEAM) return DEFAULT_TEAM
  if (stored === CUSTOM_TEAM) return CUSTOM_TEAM
  const metadataField = SCORING_CONFIG_REGISTRY[configType].metadataField
  const defaults = (getGameMetadata().characters as Record<string, Any>)[characterId]?.scoringMetadata
  const effective = getScoringMetadata(characterId as Any)
  if (
    defaults?.[metadataField]
    && effective[metadataField]?.teammates
    && objectHash(effective[metadataField].teammates) !== objectHash(defaults[metadataField].teammates)
  ) {
    return CUSTOM_TEAM
  }
  return DEFAULT_TEAM
}

export function registerScoringTools(server: McpServer): void {
  // ── score_relics ───────────────────────────────────────────────────────────
  server.registerTool('score_relics', {
    title: '遗器评分(当前分/潜力/estTBP)',
    description: '对应网页端遗器页的评分列与角色页的遗器分析卡:对库存遗器逐件评分(RelicScorer 纯函数,主线程同步)。'
      + '传 characterId 时逐件返回:当前分(percentScore + 字母评级)、潜力四分位(currentPct/bestPct/averagePct/worstPct)、'
      + 'reroll 摘要(重掷平均潜力等);includeEstTbp=true(默认)时对 5★ 遗器附带 estTBP 天数(scoreTbp 直调,'
      + '估算刷出不低于当前权重分的遗器所需体力天数)。不传 characterId 则只返回基础信息(评分需要角色上下文)。'
      + 'relicFilters 各条件 AND 组合;评分权重可通过 set_scoring_override 自定义。'
      + '`scope` 选择评分范围(网页端遗器表格的评分列分组):selected=选中角色(characterId 的列,默认);'
      + 'all=全部角色——逐件返回各角色中的最高潜力/重掷期望(rangePotential,即表格 potentialAllAll 列);'
      + 'custom=自定义角色集——同 all 但排除 excludeCharacters 列出的角色(即表格 potentialAllCustom 列;'
      + '对应网页端「潜力计算自定义角色集」的排除名单(随存档持久,可经 export_save(structured=true)/get_save_snapshot 读出)。scope=all/custom 会对分页内每件 × 全角色计算,较慢。'
      + '`rollsSummary=true` 附带逐件 roll 分布合计(high/mid/low)与全页汇总 rollsTotals'
      + '(传 characterId 时再给加权 roll 数 countRelicRolls 口径),对应构筑分析「遗器稀有度」一栏的每件 roll 统计。',
    inputSchema: {
      characterId: z.string().optional().describe('评分基准角色 id(决定权重与潜力口径;scope=selected 的必备上下文)'),
      relicFilters: z.object(relicFilterSchema).optional().describe('与 list_relics 相同的结构化筛选'),
      scope: z.enum(['selected', 'custom', 'all']).default('selected').describe(
        '评分范围:selected=选中角色(默认)/custom=自定义角色集(排除 excludeCharacters)/all=全部角色',
      ),
      excludeCharacters: z.array(z.string()).optional().describe('scope=custom 时从全部角色中排除的角色 id 列表(网页端「自定义角色集」的排除名单)'),
      rollsSummary: z.boolean().default(false).describe('是否附带逐件 roll 分布(high/mid/low)与全页汇总'),
      includeEstTbp: z.boolean().default(true).describe('是否对 5★ 遗器计算 estTBP 天数(略慢)'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    outputSchema: {
      characterId: z.string().nullable(),
      total: z.number().int(),
      offset: z.number().int(),
      limit: z.number().int(),
      scope: z.enum(['selected', 'custom', 'all']),
      excludeCharacters: z.array(z.string()).optional(),
      includeEstTbp: z.boolean(),
      rollsTotals: z.object({
        relicCount: z.number().int(),
        high: z.number(),
        mid: z.number(),
        low: z.number(),
        total: z.number(),
        weightedRolls: z.number().optional(),
      }).optional(),
      durationMs: z.number(),
      relics: z.array(scoredRelicSchema),
    },
  }, async ({ characterId, relicFilters, scope, excludeCharacters, rollsSummary, includeEstTbp, offset, limit }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    if (characterId != null && (getGameMetadata().characters as Record<string, unknown>)[characterId] == null) {
      throw new Error(`Unknown character id ${characterId} (not present in game metadata)`)
    }

    // scope=custom:排除名单里的每个 id 都必须是真实角色(网页端从角色选择器勾选)
    const excluded = scope === 'custom' ? (excludeCharacters ?? []) : []
    if (scope === 'custom') {
      const unknown = excluded.filter((id) => (getGameMetadata().characters as Record<string, unknown>)[id] == null)
      if (unknown.length) {
        throw new Error(`score_relics:excludeCharacters 含未知角色 id:${unknown.join(', ')} — 须为游戏元数据内的角色`)
      }
    }

    const matched = relicFilters != null
      ? filterRelics(getRelics(), relicFilters)
      : getRelics()
    const page = matched.slice(offset, offset + limit)

    const started = performance.now()
    const scorer = new RelicScorer()
    // Raw (unprepared) stat weights, mirroring the web's estTBP card input
    const estTbpWeights = characterId != null
      ? (getScoringMetadata(characterId as Any).stats as Record<string, number>)
      : null
    const rollsWeights = rollsSummary && characterId != null
      ? (getScoringMetadata(characterId as Any).stats as Record<string, number>)
      : null

    // scope=all/custom:scoreRelicsBatch 的角色循环,分页内逐件 × 全角色
    // (all 与 custom 共用同一循环,custom 跳过排除名单——网页端两个范围列的口径)
    const rangeCharacterIds = scope === 'all' || scope === 'custom'
      ? Object.values(getGameMetadata().characters).map((character) => character.id as string)
      : null

    const totals = { high: 0, mid: 0, low: 0, total: 0, weighted: 0 }

    const relics = page.map((relic) => {
      const base = {
        id: relic.id,
        part: relic.part,
        set: relic.set,
        grade: relic.grade,
        enhance: relic.enhance,
        equippedBy: relic.equippedBy ?? null,
      }

      let entry: Record<string, unknown> = base

      if (characterId != null) {
        const current = scorer.getCurrentRelicScore(relic, characterId as Any)
        const potential = scorer.scoreRelicPotential(relic, characterId as Any)
        const estTbpDays = includeEstTbp && relic.grade === 5 && estTbpWeights != null
          ? scoreTbp(relic, estTbpWeights)
          : null

        entry = {
          ...base,
          current: { percentScore: current.percentScore, rating: current.rating },
          potential: {
            currentPct: potential.currentPct,
            bestPct: potential.bestPct,
            averagePct: potential.averagePct,
            worstPct: potential.worstPct,
          },
          reroll: {
            rerollAvgPct: potential.rerollAvgPct,
            blockedRerollAvgPct: potential.blockedRerollAvgPct,
            ...(potential.meta?.blockedStat != null ? { blockedStat: potential.meta.blockedStat } : {}),
          },
          ...(estTbpDays != null ? { estTbpDays } : {}),
        }
      }

      if (rangeCharacterIds != null) {
        // 网页端 potentialAllAll/potentialAllCustom 对四个指标各自独立取全候选
        // 最大值(scoreRelicsBatch.ts:161-177,初值 0);bestCharacterId 只标注
        // bestPct 的归属(网页无归属列,MCP 附加信息)。
        let best = { bestPct: -1, averagePct: -1, rerollAvgPct: -1, blockedRerollAvgPct: -1, characterId: '' }
        for (const candidateId of rangeCharacterIds) {
          if (excluded.includes(candidateId)) continue
          const pct = scorer.scoreRelicPotential(relic, candidateId as Any)
          if (pct.bestPct > best.bestPct) {
            best = {
              bestPct: pct.bestPct,
              averagePct: pct.averagePct,
              rerollAvgPct: Math.max(0, pct.rerollAvgPct),
              blockedRerollAvgPct: Math.max(0, pct.blockedRerollAvgPct),
              characterId: candidateId,
            }
          } else {
            best = {
              ...best,
              averagePct: Math.max(best.averagePct, pct.averagePct),
              rerollAvgPct: Math.max(best.rerollAvgPct, Math.max(0, pct.rerollAvgPct)),
              blockedRerollAvgPct: Math.max(best.blockedRerollAvgPct, Math.max(0, pct.blockedRerollAvgPct)),
            }
          }
        }
        entry.rangePotential = {
          bestPct: best.bestPct,
          averagePct: best.averagePct,
          rerollAvgPct: best.rerollAvgPct,
          blockedRerollAvgPct: best.blockedRerollAvgPct,
          bestCharacterId: best.characterId,
        }
      }

      if (rollsSummary) {
        // countRelicRolls 反解缺失的 roll 分布时会写回 substat.rolls —— 用克隆,
        // 不动库存对象(库存遗器在载入时已由 RelicAugmenter 反解,这里通常只是读)
        let high = 0
        let mid = 0
        let low = 0
        for (const substat of relic.substats) {
          high += substat.rolls?.high ?? 0
          mid += substat.rolls?.mid ?? 0
          low += substat.rolls?.low ?? 0
        }
        const weightedRolls = rollsWeights != null ? countRelicRolls(clone(relic), rollsWeights as Any) : undefined
        totals.high += high
        totals.mid += mid
        totals.low += low
        totals.total += high + mid + low
        totals.weighted += weightedRolls ?? 0
        entry.rollsSummary = {
          high,
          mid,
          low,
          total: high + mid + low,
          ...(weightedRolls != null ? { weightedRolls } : {}),
        }
      }

      return entry
    })
    const durationMs = Math.round(performance.now() - started)

    return toolResult(
      {
        characterId: characterId ?? null,
        total: matched.length,
        offset,
        limit,
        scope,
        ...(scope === 'custom' ? { excludeCharacters: excluded } : {}),
        includeEstTbp: includeEstTbp && characterId != null,
        ...(rollsSummary
          ? {
            rollsTotals: {
              relicCount: relics.length,
              high: totals.high,
              mid: totals.mid,
              low: totals.low,
              total: totals.total,
              ...(rollsWeights != null ? { weightedRolls: totals.weighted } : {}),
            },
          }
          : {}),
        durationMs,
        relics,
      },
      `已对 ${matched.length} 件遗器中的 ${relics.length} 件评分`
        + `${characterId != null ? `(基准角色 ${characterId})` : '(未传角色——评分字段需要 characterId)'}`
        + `${scope !== 'selected' ? `,范围 ${scope === 'all' ? '全部角色' : `自定义角色集(排除 ${excluded.length} 人)`}` : ''},`
        + `耗时 ${durationMs}ms`,
    )
  })

  // ── dps_score ──────────────────────────────────────────────────────────────
  server.registerTool('dps_score', {
    title: 'DPS 战斗评分',
    description: '对应网页端角色展示页的 DPS Score 卡片:对角色当前装备跑战斗基准评测'
      + '(prepareOrchestrator → executeOrchestrator → executeUpgradeOrchestrator,与网页同一条链路,实测 <1s)。'
      + '返回:总分 percent(1.0=基准线,数值保持上游原样)与字母评级(SS/WTF…,六件套且全 verified 才可能 AEON)、'
      + 'original/baseline/benchmark/maximum 四组分数对比、原 SPD 与基准 SPD、副词条/套装/主词条升级表'
      + '(每项含 part/stat/新百分比/分数增量)、队友饰品升级摘要。team="default" 用官方推荐队,"custom" 用存档评分覆盖里的自定义队伍'
      + '(scoringMetadataOverrides[角色].simulation.teammates,未设置时与 default 相同);自定义队伍可经 set_scoring_override(configs.editTeammate/syncTeam) 设置,或随存档载入(在网页端编辑)。',
    inputSchema: {
      characterId: z.string().describe('角色 id(需已载入存档,按其当前装备评分)'),
      team: z.enum(['default', 'custom']).default('default').describe('基准队伍:官方推荐队或自定义覆盖队'),
    },
    outputSchema: {
      characterId: z.string(),
      team: z.enum(['default', 'custom']),
      percent: z.number(),
      grade: z.string(),
      scores: z.object({
        original: z.number(),
        baseline: z.number(),
        benchmark: z.number(),
        maximum: z.number(),
      }),
      originalSpd: z.number(),
      benchmarkSpd: z.number().nullable(),
      upgrades: z.object({
        substats: z.array(serializedUpgradeSchema),
        sets: z.array(serializedUpgradeSchema),
        mains: z.array(serializedUpgradeSchema),
        teammateOrnaments: z.array(z.object({
          teammates: z.array(z.string()),
          set: z.array(z.string()),
          oldSet: z.string().nullable(),
          simScore: z.number(),
        })),
      }),
      benchmarkRequest: simulationRequestSchema.nullable(),
      originalRequest: simulationRequestSchema.nullable(),
      simulationFlags: z.object({
        overcapCritRate: z.boolean(),
        forceErrRope: z.boolean(),
        benchmarkBasicSpdTarget: z.number(),
      }),
      timing: z.object({
        prepareMs: z.number(),
        executeMs: z.number(),
        upgradeMs: z.number(),
        totalMs: z.number(),
      }),
      relics: z.object({ equipped: z.number(), verified: z.boolean() }),
    },
  }, async ({ characterId, team }, extra): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = getCharacterById(characterId as Any)
    if (!character) {
      throw new Error(`Character ${characterId} not found. Loaded characters: ${getCharacters().map((c) => c.id).join(', ')}`)
    }

    const single: Record<string, Relic | undefined> = {}
    let numRelics = 0
    let verified = true
    for (const [part, relicId] of Object.entries(character.equipped)) {
      if (!relicId) continue
      const relic = getRelicById(relicId)
      if (!relic) throw new Error(`Equipped relic ${relicId} (${part}) not found in inventory — reload the save`)
      single[part] = relic
      numRelics++
      if (relic.verified !== true) verified = false
    }
    if (numRelics === 0) {
      throw new Error(`Character ${characterId} has no relics equipped — equip a build first (equip_build)`)
    }

    const teamSelection = team === 'custom' ? CUSTOM_TEAM : DEFAULT_TEAM
    const sim = resolveSimulationMetadata(character, ScoringConfigType.DPS, teamSelection)
    if (!sim) {
      throw new Error(`No DPS scoring metadata for character ${characterId} (no default or overridden simulation config)`)
    }

    const progressToken = (extra._meta as Any)?.progressToken
    const notify = (progress: number, message: string) => {
      if (progressToken == null) return
      void extra.sendNotification({
        method: 'notifications/progress' as const,
        params: { progressToken, progress, total: 3, message },
      } as Any).catch(() => {})
    } // Run the optimal-simulation search inline on the main thread (spike S6
     // pattern). The flag stays set for the process lifetime — every consumer
    // of defaultComputeOptimalSimulationSearchRunner in this server should run
    // inline; the browser worker pool is not wired for the orchestrator path.
    ;(globalThis as Any).SEQUENTIAL_BENCHMARKS = true

    const started = performance.now()
    const orchestrator = prepareOrchestrator(
      character as Any,
      { configType: ScoringConfigType.DPS, simulation: sim },
      single as Any,
      {} as Any,
    )
    const prepareMs = Math.round(performance.now() - started)
    notify(1, `prepare done in ${prepareMs}ms; running benchmark + perfection search`)

    // Generation gate (mirrors optimize): the orchestrator awaits below yield
    // to the event loop, and a load_save in that window swaps the inventory —
    // scoring the previous save's relics as if they were current must error,
    // not return a stale score silently.
    const generation = runtimeContext.getSaveGeneration()

    const executeStart = performance.now()
    await executeOrchestrator(orchestrator as Any)
    const executeMs = Math.round(performance.now() - executeStart)
    notify(2, `benchmark + perfection done in ${executeMs}ms; computing upgrades`)

    const upgradeStart = performance.now()
    await executeUpgradeOrchestrator(orchestrator as Any)
    const upgradeMs = Math.round(performance.now() - upgradeStart)
    const totalMs = Math.round(performance.now() - started)

    if (generation !== runtimeContext.getSaveGeneration()) {
      throw new Error('A load_save changed the save while dps_score was running — the score belongs to the previous save; re-run for the current save')
    }

    const score = serializeSimulationScore(orchestrator.simulationScore!, {
      verified: verified && numRelics === 6,
      numRelics,
      hasLightCone: !!character.form.lightCone,
    })

    return toolResult(
      {
        characterId,
        team,
        ...score,
        timing: { prepareMs, executeMs, upgradeMs, totalMs },
        relics: { equipped: numRelics, verified },
      },
      `${characterId} 的 DPS 评分:${(score.percent * 100).toFixed(1)}%(${score.grade}),`
        + `耗时 ${totalMs}ms——副词条升级 ${score.upgrades.substats.length} 项、套装 ${score.upgrades.sets.length} 项、`
        + `主词条 ${score.upgrades.mains.length} 项、队友饰品 ${score.upgrades.teammateOrnaments.length} 项`,
    )
  })

  // ── score_character ────────────────────────────────────────────────────────
  server.registerTool(
    'score_character',
    {
      title: '角色展示卡评分(四类配置)',
      description: '网页端展示卡背后模拟评分引擎(SimScoring)的完整无头版——dps_score 的超集:任意评分配置、'
        + '任意卡来源、临时队伍与基准速度,同一 orchestrator 链路(resolveSimulationMetadata → prepareOrchestrator → '
        + 'executeOrchestrator → executeUpgradeOrchestrator;MCP 直调计算层,不走 UI 请求生命周期,基准搜索主线程内联执行)。'
        + '`source` 三种评分对象:roster=存档内角色的当前装备(默认);build=角色某个已保存配装'
        + '(用配装记录的遗器、光锥、星魂与队伍,而非角色当前状态——配装弹窗的展示卡);'
        + 'showcase=fetch_showcase 缓存里未导入的角色(展示柜页的展示卡,不需要存档;配 `override` 临时换成别的角色+光锥来评分,'
        + '即展示卡左侧模拟栏「用这套遗器模拟别的角色」,override 的角色与光锥必填)。'
        + '`config` 评分配置:dps/buffer/heal/shield 四类(只有角色评分元数据带对应配置时可用);'
        + '缺省 auto=展示卡默认评分类型(元数据配置顺序→dps/buffer/heal/shield→副词条/无;存有展示偏好时按偏好解析回退到第一项;'
        + 'build 来源优先配装记录的评分类型)。落到副词条/无(非模拟类型)时报错——那是 score_relics 的领域。'
        + '`team`:auto=网页默认判定(存有自定义队友与默认不同就用自定义队,会话偏好优先)/default=官方推荐队/'
        + 'custom=存档评分覆盖里的自定义队;`teammates` 直接给一支临时队伍(≤3 人,角色与光锥必填)——只在本次评分生效,'
        + '不写存档,持久化自定义队走 set_scoring_override(configs)。build 来源缺省取配装记录的队伍;显式传 teammates 时临时队伍优先(同其它来源)。'
        + '`spdBenchmark` 临时基准速度(定制侧栏「属性」的基准速度输入框):不传=当前速度,0=基础速度,正数=对齐到该速度;'
        + '只影响本次评分,不写存档。`deprioritizeBuffs` DPS 增益优先级(false=主 C/true=副 C,仅 config=dps;缺省用存档覆盖或默认)。'
        + '`trace=true` 额外返回评分模拟的逐动作增益汇总(与 simulate_build(trace=true) 同一归因风格:来源/能力/数值/伤害标签),'
        + '即构筑分析「增益分析」的数据底表。评分是只读计算,不递增 revision。',
      inputSchema: {
        source: z.enum(['roster', 'build', 'showcase']).default('roster').describe(
          '评分对象来源:roster=存档内角色当前装备/build=已保存配装/showcase=展示柜缓存角色',
        ),
        characterId: z.string().describe('角色 id(roster/build=存档内角色;showcase=缓存档案里的角色 id)'),
        buildName: z.string().optional().describe('source=build 必填:配装名'),
        cacheId: z.string().optional().describe('source=showcase 可选:fetch_showcase(remember=true) 返回的缓存选择键;缺省用最近一次缓存'),
        override: z.object({
          characterId: z.string().describe('要换成的角色 id(必填)'),
          lightCone: z.string().describe('要换成的光锥 id(必填)'),
          characterEidolon: z.number().int().min(0).max(6).optional().describe('星魂(默认 0,预设按钮口径)'),
          lightConeSuperimposition: z.number().int().min(1).max(5).optional().describe('叠影(默认 1,预设按钮口径)'),
        }).optional().describe('source=showcase:临时换成另一个角色+光锥评分(遗器原样保留;只在本次调用生效)'),
        config: z.enum(['auto', 'dps', 'buffer', 'heal', 'shield']).default('auto').describe('评分配置类型(缺省 auto=展示卡默认评分类型)'),
        team: z.enum(['auto', 'default', 'custom']).default('auto').describe('基准队伍(缺省 auto=网页默认判定)'),
        teammates: z.array(z.object({
          characterId: z.string().describe('队友角色 id(必填)'),
          lightCone: z.string().describe('队友光锥 id(必填)'),
          characterEidolon: z.number().int().min(0).max(6).optional().describe('星魂(默认 0)'),
          lightConeSuperimposition: z.number().int().min(1).max(5).optional().describe('叠影(默认 1)'),
          teamRelicSet: z.string().optional().describe('队伍遗器套装'),
          teamOrnamentSet: z.string().optional().describe('队伍饰品套装'),
        })).min(1).max(3).optional().describe('临时队伍(≤3 人):只本次评分生效,不写存档(优先级高于 team/default 覆盖)'),
        spdBenchmark: z.number().min(0).optional().describe('临时基准速度:不传=当前速度,0=基础速度,正数=对齐该速度(只本次生效)'),
        deprioritizeBuffs: z.boolean().optional().describe('DPS 增益优先级:false=主 C,true=副 C(仅 config=dps;缺省用存档覆盖或默认)'),
        trace: z.boolean().default(false).describe('是否附带评分模拟的逐动作增益汇总(略慢)'),
      },
      outputSchema: {
        source: z.enum(['roster', 'build', 'showcase']),
        characterId: z.string(),
        scoredCharacterId: z.string(),
        buildName: z.string().optional(),
        showcaseOverride: z.object({ characterId: z.string(), lightCone: z.string() }).optional(),
        configType: z.enum(['dps', 'buffer', 'heal', 'shield']),
        configResolution: z.object({
          requested: z.enum(['auto', 'dps', 'buffer', 'heal', 'shield']),
          scoringType: z.number(),
          order: z.array(z.number()),
        }),
        team: z.enum(['default', 'custom']),
        teamResolution: z.enum(['auto', 'default', 'custom', 'ephemeral', 'build']),
        teammates: z.array(z.string()),
        spdBenchmark: z.number().nullable(),
        deprioritizeBuffs: z.boolean().nullable(),
        percent: z.number(),
        grade: z.string(),
        scores: z.object({
          original: z.number(),
          baseline: z.number(),
          benchmark: z.number(),
          maximum: z.number(),
        }),
        originalSpd: z.number(),
        benchmarkSpd: z.number().nullable(),
        upgrades: z.object({
          substats: z.array(serializedUpgradeSchema),
          sets: z.array(serializedUpgradeSchema),
          mains: z.array(serializedUpgradeSchema),
          teammateOrnaments: z.array(z.object({
            teammates: z.array(z.string()),
            set: z.array(z.string()),
            oldSet: z.string().nullable(),
            simScore: z.number(),
          })),
        }),
        benchmarkRequest: simulationRequestSchema.nullable(),
        originalRequest: simulationRequestSchema.nullable(),
        simulationFlags: z.object({
          overcapCritRate: z.boolean(),
          forceErrRope: z.boolean(),
          benchmarkBasicSpdTarget: z.number(),
        }),
        builds: z.object({
          original: scoredBuildSchema.nullable(),
          baseline: scoredBuildSchema.nullable(),
          benchmark: scoredBuildSchema.nullable(),
          maximum: scoredBuildSchema.nullable(),
        }),
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
          primaryAction: z.string(),
        }).optional(),
        timing: z.object({
          prepareMs: z.number(),
          executeMs: z.number(),
          upgradeMs: z.number(),
          traceMs: z.number(),
          totalMs: z.number(),
        }),
        relics: z.object({ equipped: z.number(), verified: z.boolean() }),
      },
    },
    async (
      { source, characterId, buildName, cacheId, override, config, team, teammates, spdBenchmark, deprioritizeBuffs, trace },
      extra,
    ): Promise<CallToolResult> => {
      runtimeContext.ensureMetadataReady()
      if (source !== 'showcase') runtimeContext.requireSave()

      // ── 1. 评分对象:角色 + 遗器 + 表单(三种卡来源) ──
      let form: Record<string, Any>
      let relicsByPart: Record<string, Relic | null | undefined> = {}
      let buildOverride: Any = null
      let showcaseOverrideEcho: { characterId: string, lightCone: string } | undefined
      let scoredCharacterId = characterId

      if (source === 'roster') {
        const character = getCharacterById(characterId as Any)
        if (!character) {
          throw new Error(`score_character:角色 ${characterId} 不在当前存档中——已载入角色: ${getCharacters().map((c) => c.id).join(', ')}`)
        }
        form = { ...character.form }
        let numRelics = 0
        for (const [part, relicId] of Object.entries(character.equipped ?? {})) {
          if (!relicId) continue
          const relic = getRelicById(relicId)
          if (!relic) throw new Error(`score_character:角色 ${characterId} 装备的遗器 ${relicId}(${part})不在库存中——存档可能已变动,请重新 load_save`)
          relicsByPart[part] = relic
          numRelics++
        }
        if (numRelics === 0) {
          throw new Error(`score_character:角色 ${characterId} 没有装备任何遗器——模拟评分需要至少一件遗器,请先 equip_build`)
        }
      } else if (source === 'build') {
        if (buildName == null) {
          throw new Error('score_character:source=build 需要同时传入 buildName(取 list_builds 返回的配装名)')
        }
        const character = getCharacterById(characterId as Any)
        if (!character) {
          throw new Error(`score_character:角色 ${characterId} 不在当前存档中——已载入角色: ${getCharacters().map((c) => c.id).join(', ')}`)
        }
        const build = (character.builds ?? []).find((x) => x.name === buildName)
        if (!build) {
          throw new Error(
            `score_character:角色 ${characterId} 没有配装「${buildName}」。已保存: ${(character.builds ?? []).map((b) => b.name).join(', ') || '(无)'}`,
          )
        }
        // BuildPreview(CharacterPreview.tsx):光锥/星魂/叠影取配装记录,其余表单取角色
        form = {
          ...character.form,
          characterEidolon: build.characterEidolon,
          lightCone: build.lightCone,
          lightConeSuperimposition: build.lightConeSuperimposition,
        }
        let numRelics = 0
        for (const [part, relicId] of Object.entries(build.equipped ?? {})) {
          if (!relicId) continue
          const relic = getRelicById(relicId)
          if (!relic) throw new Error(`score_character:配装「${buildName}」引用的遗器 ${relicId}(${part})不在库存中——请检查配装或重新 load_save`)
          relicsByPart[part] = relic
          numRelics++
        }
        if (numRelics === 0) {
          throw new Error(`score_character:配装「${buildName}」没有记录任何遗器,无法评分`)
        }
        if ((build.team ?? []).every((teammate) => teammate == null)) {
          throw new Error(`score_character:配装「${buildName}」没有记录评分队伍(至少需要一名队友)`)
        }
        buildOverride = build
      } else {
        const cache = getShowcaseCache(cacheId)
        if (cache == null) {
          throw new Error(
            cacheId != null
              ? `score_character:找不到展示柜缓存 ${cacheId}——缓存选择键来自 fetch_showcase(remember=true) 返回的 cached 列表`
              : 'score_character:进程内没有展示柜缓存——先 fetch_showcase(可用 json 内联,零网络)',
          )
        }
        const entry = cache.characters.find((character) => character.id === characterId)
        if (!entry) {
          throw new Error(`score_character:缓存 ${cache.cacheId} 里没有角色 ${characterId}。档案内角色: ${cache.characters.map((c) => c.id).join(', ')}`)
        }
        // 模拟栏覆写(computeCharacterOverride):换角色+光锥,遗器原样保留并换主
        if (override != null) {
          if ((getGameMetadata().characters as Record<string, unknown>)[override.characterId] == null) {
            throw new Error(`score_character:override.characterId ${override.characterId} 不存在于游戏元数据`)
          }
          if ((getGameMetadata().lightCones as Record<string, unknown>)[override.lightCone] == null) {
            throw new Error(`score_character:override.lightCone ${override.lightCone} 不存在于游戏元数据`)
          }
          scoredCharacterId = override.characterId
          showcaseOverrideEcho = { characterId: override.characterId, lightCone: override.lightCone }
          form = {
            characterId: override.characterId,
            characterEidolon: override.characterEidolon ?? 0,
            lightCone: override.lightCone,
            lightConeSuperimposition: override.lightConeSuperimposition ?? 1,
          }
          relicsByPart = Object.fromEntries(
            Object.entries(entry.equipped).map(([part, relic]) => [part, relic ? { ...relic, equippedBy: override.characterId as Relic['equippedBy'] } : null]),
          )
        } else {
          scoredCharacterId = entry.id as string
          if (entry.form.lightCone == null) {
            throw new Error(`score_character:展示柜角色 ${characterId} 没有光锥——模拟评分需要光锥;可用 override 临时指定角色与光锥`)
          }
          form = {
            characterId: entry.id,
            characterEidolon: entry.form.characterEidolon,
            lightCone: entry.form.lightCone,
            lightConeSuperimposition: entry.form.lightConeSuperimposition,
          }
          relicsByPart = { ...entry.equipped }
        }
        if (!Object.values(relicsByPart).some((relic) => relic != null)) {
          throw new Error(`score_character:展示柜角色 ${characterId} 没有穿戴任何遗器,无法评分`)
        }
      }

      const relicsList = Object.values(relicsByPart).filter((relic): relic is Relic => relic != null)
      const numRelics = relicsList.length
      const verified = relicsList.length === 6 && relicsList.every((relic) => relic.verified === true)

      // ── 2. 评分配置解析(auto = 展示卡默认评分类型;build 优先配装记录) ──
      const available = availableConfigTypes(scoredCharacterId)
      let requestedConfig: ScoringConfigType | null = null
      let autoScoringType: number | null = null
      let autoOrder: number[] = []
      if (config === 'auto') {
        if (source === 'build' && buildOverride?.scoringConfigType != null) {
          requestedConfig = buildOverride.scoringConfigType as ScoringConfigType
        } else {
          const auto = resolveAutoConfigType(scoredCharacterId)
          requestedConfig = auto.configType
          autoScoringType = auto.scoringType
          autoOrder = auto.order
        }
        if (requestedConfig == null) {
          throw new Error(
            `score_character:角色 ${scoredCharacterId} 的默认评分类型解析为非模拟评分`
              + `(scoringType=${autoScoringType ?? buildOverride?.scoringConfigType ?? '?'},即副词条评分/无)`
              + '——副词条评分用 score_relics;若要战斗评分请显式传 config'
              + (available.length ? `(可用: ${available.join(', ')})` : '(该角色没有任何模拟评分配置)'),
          )
        }
      } else {
        requestedConfig = config === 'dps'
          ? ScoringConfigType.DPS
          : config === 'buffer'
          ? ScoringConfigType.BUFFER
          : config === 'heal'
          ? ScoringConfigType.HEAL
          : ScoringConfigType.SHIELD
        if (!available.includes(requestedConfig)) {
          throw new Error(
            `score_character:角色 ${scoredCharacterId} 没有 ${config} 评分配置——可用: ${available.join(', ') || '(无)'}。`
              + '可用配置也可经 get_scoring_metadata 的 simulations 字段确认',
          )
        }
      }
      const configType = requestedConfig!
      if (autoScoringType == null && config === 'auto' && source === 'build' && buildOverride?.scoringConfigType != null) {
        // build 分支的 auto 用了配装记录的类型,补齐 resolution 上下文
        const auto = resolveAutoConfigType(scoredCharacterId)
        autoScoringType = auto.scoringType
        autoOrder = auto.order
      }

      // ── 3. 队伍解析:显式 ephemeral > build 记录 > team 参数/auto 判定 ──
      let teamSelection: typeof DEFAULT_TEAM | typeof CUSTOM_TEAM
      let teamResolution: 'auto' | 'default' | 'custom' | 'ephemeral' | 'build'
      if (teammates != null) {
        teamSelection = CUSTOM_TEAM
        teamResolution = 'ephemeral'
      } else if (source === 'build') {
        // 配装弹窗:队伍固定为配装记录的队伍(getTeammates 的 buildOverride 分支)
        teamSelection = CUSTOM_TEAM
        teamResolution = 'build'
      } else if (team === 'default') {
        teamSelection = DEFAULT_TEAM
        teamResolution = 'default'
      } else if (team === 'custom') {
        teamSelection = CUSTOM_TEAM
        teamResolution = 'custom'
      } else {
        teamSelection = resolveAutoTeamSelection(scoredCharacterId, configType)
        teamResolution = 'auto'
      }

      const sim = resolveSimulationMetadata(
        { id: scoredCharacterId as Any, form: form as Any },
        configType,
        teamSelection,
        buildOverride,
      )
      if (!sim) {
        throw new Error(`score_character:角色 ${scoredCharacterId} 的 ${configType} 评分配置无法解析(默认配置缺失)`)
      }

      // 临时队伍(injectedOverride 语义,applySimulationMetadataOverrides):只本次生效
      if (teammates != null) {
        const resolved: Array<Record<string, unknown>> = []
        for (const [index, teammate] of teammates.entries()) {
          if ((getGameMetadata().characters as Record<string, unknown>)[teammate.characterId] == null) {
            throw new Error(`score_character:临时队伍第 ${index} 位角色 ${teammate.characterId} 不存在于游戏元数据`)
          }
          if ((getGameMetadata().lightCones as Record<string, unknown>)[teammate.lightCone] == null) {
            throw new Error(`score_character:临时队友 ${teammate.characterId} 的光锥 ${teammate.lightCone} 不存在于游戏元数据`)
          }
          if (teammate.teamRelicSet != null && !SetsRelicsNames.includes(teammate.teamRelicSet as never)) {
            throw new Error(`score_character:队友 ${teammate.characterId} 的未知遗器套装 "${teammate.teamRelicSet}"`)
          }
          if (teammate.teamOrnamentSet != null && !SetsOrnamentsNames.includes(teammate.teamOrnamentSet as never)) {
            throw new Error(`score_character:队友 ${teammate.characterId} 的未知饰品套装 "${teammate.teamOrnamentSet}"`)
          }
          resolved.push({
            characterId: teammate.characterId,
            lightCone: teammate.lightCone,
            characterEidolon: teammate.characterEidolon ?? 0,
            lightConeSuperimposition: teammate.lightConeSuperimposition ?? 1,
            ...(teammate.teamRelicSet != null ? { teamRelicSet: teammate.teamRelicSet } : {}),
            ...(teammate.teamOrnamentSet != null ? { teamOrnamentSet: teammate.teamOrnamentSet } : {}),
          })
        }
        sim.teammates = resolved as Any
      }

      // DPS 增益优先级:显式参数 > 存档覆盖/默认(resolveSimulationMetadata 已合并)。
      // 无显式覆盖时按网页端 applySimulationMetadataOverrides 解析生效值
      // (showcaseDerivedData.ts:186-199):副 C 默认角色在没有真输出位队友的
      // 队伍里按主 C(不降增益)评分——resolveEffectiveDeprioritizeBuffs 内部
      // 再区分存档显式覆盖(尊重)与默认值(可翻转)。
      let effectiveDeprioritizeBuffs: boolean | null = sim.deprioritizeBuffs ?? null
      if (deprioritizeBuffs != null) {
        if (!SCORING_CONFIG_REGISTRY[configType].supportsDeprioritizeBuffs) {
          throw new Error('score_character:deprioritizeBuffs 只属于 DPS 评分配置(其余配置固定按副 C 孤立评分)——请传 config="dps" 或去掉该参数')
        }
        sim.deprioritizeBuffs = deprioritizeBuffs
        effectiveDeprioritizeBuffs = deprioritizeBuffs
      } else if (SCORING_CONFIG_REGISTRY[configType].supportsDeprioritizeBuffs) {
        effectiveDeprioritizeBuffs = resolveEffectiveDeprioritizeBuffs(scoredCharacterId as Any, sim as Any)
        if (effectiveDeprioritizeBuffs != null) sim.deprioritizeBuffs = effectiveDeprioritizeBuffs
      }

      const progressToken = (extra._meta as Any)?.progressToken
      const notify = (progress: number, message: string) => {
        if (progressToken == null) return
        void extra.sendNotification({
          method: 'notifications/progress' as const,
          params: { progressToken, progress, total: 3, message },
        } as Any).catch(() => {})
      } // 基准搜索主线程内联(dps_score 同款;标志进程级生效)
      ;(globalThis as Any).SEQUENTIAL_BENCHMARKS = true

      // ── 4. 跑分:同一 orchestrator 链路 ──
      const started = performance.now()
      const orchestrator = prepareOrchestrator(
        { form: form as Any },
        { configType, simulation: sim },
        relicsByPart as Any,
        { ...(spdBenchmark != null ? { spdBenchmark } : {}) },
      )
      const prepareMs = Math.round(performance.now() - started)
      notify(1, `prepare done in ${prepareMs}ms; running ${configType} benchmark + perfection search`)

      const generation = runtimeContext.getSaveGeneration()

      const executeStart = performance.now()
      await executeOrchestrator(orchestrator as Any)
      const executeMs = Math.round(performance.now() - executeStart)
      notify(
        2,
        `${configType} benchmark + perfection done in ${executeMs}ms; ${
          SCORING_CONFIG_REGISTRY[configType].supportsUpgrades ? 'computing upgrades' : 'no upgrades for this config'
        }`,
      )

      // 升级表是 DPS 专属(网页 requestScoreUpgrades 的 supportsUpgrades 门)
      const upgradeStart = performance.now()
      if (SCORING_CONFIG_REGISTRY[configType].supportsUpgrades) {
        await executeUpgradeOrchestrator(orchestrator as Any)
      }
      const upgradeMs = Math.round(performance.now() - upgradeStart)

      if (generation !== runtimeContext.getSaveGeneration()) {
        throw new Error('A load_save changed the save while score_character was running — the score belongs to the previous save; re-run for the current save')
      }

      // ── 5. trace=true:评分模拟的逐动作增益汇总(BuffsAnalysisDisplay.rerunSim) ──
      const traceStart = performance.now()
      let buffs: Record<string, unknown> | undefined
      if (trace) {
        const traceForm = { ...orchestrator.form!, trace: true } as Any
        const traceContext = generateContext(traceForm)
        const rerun = runStatSimulations([{ ...orchestrator.originalSim!, result: undefined } as Any], traceForm, traceContext, originalScoringParams)[0]
        if (rerun?.actionBuffSnapshots) {
          buffs = {
            byAction: Object.fromEntries(
              Object.entries(rerun.actionBuffSnapshots).map(([actionName, snapshot]) => [
                actionName,
                { buffs: snapshot.buffs.map(serializeBuff), buffsMemo: snapshot.buffsMemo.map(serializeBuff) },
              ]),
            ),
            rotationSteps: (rerun.rotationBuffSteps ?? []).map((step) => ({
              actionType: step.actionType,
              buffs: step.snapshot.buffs.map(serializeBuff),
              buffsMemo: step.snapshot.buffsMemo.map(serializeBuff),
            })),
            basic: (rerun.x.c as unknown as { buffs?: Any[] }).buffs?.map(serializeBuff) ?? [],
            primaryAction: traceContext.primaryAbilityKey ?? '',
          }
        }
      }
      const traceMs = Math.round(performance.now() - traceStart)
      const totalMs = Math.round(performance.now() - started)

      const simulationScore = orchestrator.simulationScore!
      const score = serializeSimulationScore(simulationScore, {
        verified,
        numRelics,
        hasLightCone: form.lightCone != null,
      })

      // 四套配装各自的请求/战斗属性/逐技能伤害(构筑分析对比表的数据底表)
      const buildDetail = (entry: {
        request?: {
          simRelicSet1: string,
          simRelicSet2: string,
          simOrnamentSet?: string,
          simBody: string,
          simFeet: string,
          simPlanarSphere: string,
          simLinkRope: string,
          stats: Record<string, number>,
        } | undefined,
        result?: { x: Any, simScore: number, actionDamage?: Any, rotationDamage?: Any[] } | undefined,
        simScore?: number,
      }) => ({
        request: entry.request
          ? {
            relicSet1: entry.request.simRelicSet1,
            relicSet2: entry.request.simRelicSet2,
            ornamentSet: entry.request.simOrnamentSet ?? '',
            body: entry.request.simBody,
            feet: entry.request.simFeet,
            planarSphere: entry.request.simPlanarSphere,
            linkRope: entry.request.simLinkRope,
            stats: { ...entry.request.stats },
          }
          : null,
        simScore: entry.result?.simScore ?? entry.simScore ?? 0,
        stats: entry.result?.x ? serializeComputedStats(entry.result.x) : null,
        actionDamage: entry.result?.actionDamage ? serializeActionDamage(entry.result.actionDamage) : null,
        rotationDamage: (entry.result?.rotationDamage ?? []).map(serializeRotationDamageStep),
      })

      const payload: Record<string, unknown> = {
        source,
        characterId,
        scoredCharacterId,
        ...(source === 'build' ? { buildName: buildName! } : {}),
        ...(showcaseOverrideEcho != null ? { showcaseOverride: showcaseOverrideEcho } : {}),
        configType: String(configType) as 'dps' | 'buffer' | 'heal' | 'shield',
        configResolution: {
          requested: config,
          scoringType: simulationScoreToType(configType),
          order: autoOrder,
        },
        team: teamSelection === CUSTOM_TEAM ? 'custom' : 'default',
        teamResolution,
        teammates: (sim.teammates ?? []).map((teammate: Any) => teammate.characterId as string),
        spdBenchmark: orchestrator.spdBenchmark ?? null,
        deprioritizeBuffs: effectiveDeprioritizeBuffs,
        ...score,
        builds: {
          original: buildDetail({ request: simulationScore.originalSim?.request, result: simulationScore.originalSimResult as Any }),
          baseline: buildDetail({ request: simulationScore.baselineSim?.request, result: simulationScore.baselineSimResult as Any }),
          benchmark: buildDetail({ request: simulationScore.benchmarkSim?.request, result: simulationScore.benchmarkSimResult as Any }),
          maximum: buildDetail({ request: simulationScore.maximumSim?.request, result: simulationScore.maximumSimResult as Any }),
        },
        ...(buffs != null ? { buffs } : {}),
        timing: { prepareMs, executeMs, upgradeMs, traceMs, totalMs },
        relics: { equipped: numRelics, verified },
      }

      return toolResult(
        payload,
        `${scoredCharacterId} 的 ${String(configType)} 评分(${source === 'roster' ? '存档角色' : source === 'build' ? `配装「${buildName}」` : '展示柜角色'}`
          + `${showcaseOverrideEcho != null ? `,已覆写为 ${showcaseOverrideEcho.characterId}` : ''}):`
          + `${(score.percent * 100).toFixed(1)}%(${score.grade}),队伍 ${teamSelection === CUSTOM_TEAM ? '自定义' : '默认'}(${
            (sim.teammates ?? []).map((t: Any) => t.characterId).join(', ')
          }),`
          + `耗时 ${totalMs}ms${trace ? `(含增益汇总 ${Object.keys((buffs as Any)?.byAction ?? {}).length} 个动作)` : ''}`,
      )
    },
  )
}

/** configType → ScoringType 数值(DPS_SCORE=0/BUFFER_SCORE=3/HEAL_SCORE=4/SHIELD_SCORE=5)。 */
function simulationScoreToType(configType: ScoringConfigType): number {
  return Number(SCORING_CONFIG_REGISTRY[configType].scoringType)
}
