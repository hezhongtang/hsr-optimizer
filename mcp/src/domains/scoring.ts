// Scoring domain: `score_relics` (stat scoring + relic potential + estTBP) and
// `dps_score` (Engine B combat benchmark scoring).
//
// score_relics runs fully synchronous on the main thread via the pure scorer
// entry points (RelicScorer instance methods + scoreTbp direct call) — the
// spike-verified pattern (162 relics in ~7ms; estTBP adds a few ms per 5★).
//
// dps_score mirrors the web showcase's orchestrator chain:
//   resolveSimulationMetadata → prepareOrchestrator → executeOrchestrator
//   → executeUpgradeOrchestrator, with SEQUENTIAL_BENCHMARKS=true so the
//   optimal-simulation search runs inline on the main thread (measured ~0.3s)
//   instead of the browser worker pool. The resulting SimulationScore is
//   reduced to JSON-safe data by serializers/scoring.ts.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  CUSTOM_TEAM,
  DEFAULT_TEAM,
} from 'lib/constants/constants'
import { scoreTbp } from 'lib/relics/estTbp/estTbp'
import { RelicScorer } from 'lib/relics/scoring/relicScorer'
import {
  executeOrchestrator,
  executeUpgradeOrchestrator,
  prepareOrchestrator,
  resolveSimulationMetadata,
} from 'lib/simulations/orchestrator/runDpsScoreBenchmarkOrchestrator'
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
import { ScoringConfigType } from 'types/metadata'
import type { Relic } from 'types/relic'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { serializeSimulationScore } from '../serializers/scoring'
import { toolResult } from '../toolResult'

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
})

const simulationRequestSchema = z.object({
  relicSet1: z.string(),
  relicSet2: z.string(),
  ornamentSet: z.string(),
  body: z.string(),
  feet: z.string(),
  planarSphere: z.string(),
  linkRope: z.string(),
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

export function registerScoringTools(server: McpServer): void {
  // ── score_relics ───────────────────────────────────────────────────────────
  server.registerTool('score_relics', {
    title: '遗器评分(当前分/潜力/estTBP)',
    description: '对应网页端遗器页的评分列与角色页的遗器分析卡:对库存遗器逐件评分(RelicScorer 纯函数,主线程同步)。'
      + '传 characterId 时逐件返回:当前分(percentScore + 字母评级)、潜力四分位(currentPct/bestPct/averagePct/worstPct)、'
      + 'reroll 摘要(重掷平均潜力等);includeEstTbp=true(默认)时对 5★ 遗器附带 estTBP 天数(scoreTbp 直调,'
      + '估算刷出不低于当前权重分的遗器所需体力天数)。不传 characterId 则只返回基础信息(评分需要角色上下文)。'
      + 'relicFilters 各条件 AND 组合;评分权重可通过 set_scoring_override 自定义。',
    inputSchema: {
      characterId: z.string().optional().describe('评分基准角色 id(决定权重与潜力口径)'),
      relicFilters: z.object(relicFilterSchema).optional().describe('与 list_relics 相同的结构化筛选'),
      includeEstTbp: z.boolean().default(true).describe('是否对 5★ 遗器计算 estTBP 天数(略慢)'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    outputSchema: {
      characterId: z.string().nullable(),
      total: z.number().int(),
      offset: z.number().int(),
      limit: z.number().int(),
      includeEstTbp: z.boolean(),
      durationMs: z.number(),
      relics: z.array(scoredRelicSchema),
    },
  }, async ({ characterId, relicFilters, includeEstTbp, offset, limit }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    if (characterId != null && (getGameMetadata().characters as Record<string, unknown>)[characterId] == null) {
      throw new Error(`Unknown character id ${characterId} (not present in game metadata)`)
    }

    const matched = relicFilters != null
      ? filterRelics(getRelics(), relicFilters)
      : getRelics()
    const page = matched.slice(offset, offset + limit)

    const started = performance.now()
    const scorer = characterId != null ? new RelicScorer() : null
    // Raw (unprepared) stat weights, mirroring the web's estTBP card input
    const estTbpWeights = characterId != null
      ? (getScoringMetadata(characterId as Any).stats as Record<string, number>)
      : null

    const relics = page.map((relic) => {
      const base = {
        id: relic.id,
        part: relic.part,
        set: relic.set,
        grade: relic.grade,
        enhance: relic.enhance,
        equippedBy: relic.equippedBy ?? null,
      }
      if (scorer == null || characterId == null) return base

      const current = scorer.getCurrentRelicScore(relic, characterId as Any)
      const potential = scorer.scoreRelicPotential(relic, characterId as Any)
      const estTbpDays = includeEstTbp && relic.grade === 5 && estTbpWeights != null
        ? scoreTbp(relic, estTbpWeights)
        : null

      return {
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
    })
    const durationMs = Math.round(performance.now() - started)

    return toolResult(
      {
        characterId: characterId ?? null,
        total: matched.length,
        offset,
        limit,
        includeEstTbp: includeEstTbp && characterId != null,
        durationMs,
        relics,
      },
      `已对 ${matched.length} 件遗器中的 ${relics.length} 件评分${characterId != null ? `(基准角色 ${characterId})` : '(未传角色——评分字段需要 characterId)'},`
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
      + '(scoringMetadataOverrides[角色].simulation.teammates,未设置时与 default 相同);自定义队伍只能随存档载入(在网页端编辑),'
      + '目前没有 MCP 工具可以设置——set_scoring_override 只改副词条权重与主词条候选。',
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
}
