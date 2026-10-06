// Optimizer domain: the `optimize` and `get_results` tools.
//
// optimize flow (mirrors the web UI's Start button plus MCP-specific guardrails):
//   1. character's saved form → computeLoadForm (merges conditional defaults)
//   2. merge agent `formOverrides` (display fields or get_form's internal fields;
//      nested maps like weights merge by key)
//   3. displayToInternal → internal request + rank + resultsLimit
//   4. permutation estimate via the recalculatePermutations recipe
//      (RelicFilters.getFilteredRelicCounts + set-solver valid count)
//   5. scale gate: > 5e7 valid permutations refuses unless force:true,
//      returning per-part counts and constraint-tightening suggestions
//   6. run in the driver worker with progress notifications (progressToken)
//      and cooperative cancellation (extra.signal → upstream CANCEL);
//      cancelled runs return the top-N rows found so far
//   7. top rows + full per-row 6-relic build details, cached for get_results

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  getCharacterById,
  getCharacters,
} from 'lib/stores/character/characterStore'
import { displayToInternal } from 'lib/stores/optimizerForm/optimizerFormConversions'
import { computeLoadForm } from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import { z } from 'zod'

import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { runtimeContext } from '../context'
import {
  applyFormOverrides,
  constraintSuggestions,
  estimatePermutations,
  PERMUTATION_GATE,
} from '../permutations'
import {
  isOptimizationRunning,
  type OptimizeRunResult,
  runOptimization,
} from '../runOptimizer'
import { serializeBuild } from '../serializers/builds'
import { toolResult } from '../toolResult'
import {
  finishJob,
  linkedAbortController,
  registerJob,
  updateJobProgress,
} from './jobs'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const MAX_RESULTS = 1024
const ROW_STATS_KEYS_TO_SKIP = new Set(['id'])

// outputSchema 形状——以 handler 实际 return 的对象为准(serializeRowStats /
// serializeBuild 的序列化结果)。optimize 有拒绝/完成两种形状:除恒有的 status 外
// 其余字段按分支 .optional()。
const serializedSubstatSchema = z.object({
  stat: z.string(),
  value: z.number(),
  rolls: z.object({ high: z.number(), mid: z.number(), low: z.number() }).optional(),
  addedRolls: z.number().optional(),
})

const serializedRelicSchema = z.object({
  id: z.string(),
  part: z.string(),
  set: z.string(),
  grade: z.number(),
  enhance: z.number(),
  main: z.object({ stat: z.string(), value: z.number() }),
  substats: z.array(serializedSubstatSchema),
  initialRolls: z.number(),
  verified: z.boolean(),
  equippedBy: z.string().optional(),
  weightScore: z.null(),
})

const serializedBuildSchema = z.object({
  relics: z.record(z.string(), serializedRelicSchema),
  conflicts: z.array(z.string()),
})

const optimizerRowSchema = z.object({
  id: z.number(),
  stats: z.record(z.string(), z.number()),
  build: serializedBuildSchema,
})

const optimizeSummarySchema = z.object({
  gridSortColumn: z.string(),
  validPermutations: z.number(),
  naivePermutations: z.number(),
  searched: z.number(),
  durationMs: z.number(),
  cancelled: z.boolean(),
  cacheId: z.string(),
  characterId: z.string(),
  resultsLimit: z.number(),
})

function serializeRowStats(row: OptimizerDisplayData): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'number' && !ROW_STATS_KEYS_TO_SKIP.has(key)) stats[key] = value
  }
  return stats
}

export function registerOptimizerTools(server: McpServer): void {
  server.registerTool('optimize', {
    title: '执行遗器优化搜索',
    description: '为单个角色执行遗器优化搜索——对应网页端 Optimizer 页签的「开始优化」按钮(同一台上游引擎,CPU 多线程版,'
      + '结果与网页端一致)。从角色已保存表单出发,可合并 formOverrides:支持显示表单的 statFilters/ratingFilters/setFilters/teammates,'
      + '以及 get_form/default_form 返回的内部字段 minSpd 等 min/max、relicSets/ornamentSets、teammate0/1/2。'
      + '含内部专有字段的完整表单自动按内部格式识别;仅覆盖 combatBuffs 等两种格式共有字段时可用 format:"internal" 显式选择内部格式。'
      + '显示格式 combatBuffs 百分数字段使用百分数(如 50 表示 50%);内部格式使用小数(0.5)。weights 与条件等嵌套对象按键合并,其余字段整体替换。'
      + '有效排列超过 5e7 时默认拒绝(CPU 引擎约 1e6 排列/秒;网页端默认 WebGPU 更快,结果相同),可用 force=true 强制运行。'
      + '客户端提供 progressToken 时发送进度通知;取消会保留已搜索到的结果。运行期间 load_save 切档时丢弃该次结果并报错,须对当前存档重新优化。'
      + '返回前 resultsLimit 行(每行附 6 件遗器配装明细),'
      + '并附 equippedRow(角色当前已装备 6 件遗器的基线行,含属性与配装明细;极快/被取消的运行可能为 null),结果缓存供 get_results 翻页。',
    inputSchema: {
      characterId: z.string().describe('角色 id,如 "1212b1"(可用 id 见 load_save 返回的 characterIds)'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(
        '部分覆盖,支持显示表单与 get_form/default_form 内部字段。内部专有字段自动识别;共有字段可加 format:"internal"。'
          + '显示格式 combatBuffs 百分数字段用百分数,内部格式用小数。weights/条件/队友等嵌套对象按键合并;其余字段整体替换。',
      ),
      resultsLimit: z.number().int().min(1).max(MAX_RESULTS).default(50).describe('保留并返回的前 N 行'),
      force: z.boolean().default(false).describe('跳过 5e7 有效排列规模闸门'),
    },
    outputSchema: {
      status: z.enum(['rejected', 'completed', 'cancelled']),
      reason: z.string().optional(),
      validPermutations: z.number().optional(),
      naivePermutations: z.number().optional(),
      partCounts: z.record(z.string(), z.number()).optional(),
      partCountsBeforeFilters: z.record(z.string(), z.number()).optional(),
      suggestions: z.array(z.string()).optional(),
      rows: z.array(optimizerRowSchema).optional(),
      equippedRow: z.object({
        stats: z.record(z.string(), z.number()),
        build: serializedBuildSchema,
      }).nullable().optional(),
      summary: optimizeSummarySchema.optional(),
    },
  }, async ({ characterId, formOverrides, resultsLimit, force }, extra): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = getCharacterById(characterId as Any)
    if (!character) {
      throw new Error(`Character ${characterId} not found. Loaded characters: ${getCharacters().map((c) => c.id).join(', ')}`)
    }
    if (isOptimizationRunning()) {
      throw new Error('Another optimization is already running — wait for it or cancel it first')
    }

    const state = computeLoadForm(character.form)
    if (formOverrides) applyFormOverrides(state, formOverrides)

    const request: Any = displayToInternal(state)
    request.characterId = characterId
    request.rank = getCharacters().findIndex((c: Any) => c.id === characterId)
    request.resultsLimit = resultsLimit

    const estimate = estimatePermutations(request)

    if (estimate.validPermutations > PERMUTATION_GATE && !force) {
      return toolResult(
        {
          status: 'rejected',
          reason: `有效排列 ${estimate.validPermutations.toLocaleString()} 超过 ${PERMUTATION_GATE.toExponential()} 闸门`,
          validPermutations: estimate.validPermutations,
          naivePermutations: estimate.naivePermutations,
          partCounts: estimate.counts,
          partCountsBeforeFilters: estimate.preCounts,
          suggestions: constraintSuggestions(request),
        },
        `已拒绝:约 ${estimate.validPermutations.toExponential(2)} 有效排列超过 5e7 闸门。`
          + '请收紧约束(见 suggestions)或用 force:true 重试。',
      )
    }

    // Job registry (M4-B): the run's cacheId doubles as its jobId. cancel_job
    // aborts the linked controller — the exact cooperative-cancel path a
    // request-signal cancellation takes (runOptimization forwards it to the
    // driver as CANCEL; partial results are kept, never thrown away).
    const cacheId = runtimeContext.nextCacheId()
    const cancelController = linkedAbortController(extra.signal)
    registerJob(cacheId, 'optimize', {
      cancel: () => cancelController.abort(),
      summary: { characterId, resultsLimit, validPermutations: estimate.validPermutations },
    })

    // Progress: the job registry is always updated (get_job reads it);
    // notifications go out only when the client sent a progressToken
    const progressToken = (extra._meta as Any)?.progressToken
    const onProgress = (p: {
      searched: number,
      total: number,
      results: number,
      ratePerSec: number,
    }) => {
      updateJobProgress(cacheId, {
        searched: p.searched,
        totalPermutations: p.total,
        results: p.results,
        ratePerSec: p.ratePerSec,
      })
      if (progressToken == null) return
      void extra.sendNotification({
        method: 'notifications/progress' as const,
        params: {
          progressToken,
          progress: p.searched,
          ...(p.total > 0 ? { total: p.total } : {}),
          message: `searched ${p.searched.toLocaleString()} permutations, ${p.results} results, ${p.ratePerSec.toLocaleString()}/s`,
        },
      } as Any).catch(() => {
        // Transport closing mid-run — progress is best-effort
      })
    }

    // Force-flush pending mutations into the snapshot the driver reloads from,
    // so a run can never search a stale inventory (matters once equip tools land)
    runtimeContext.flushSave()

    const generation = runtimeContext.getSaveGeneration()
    let run: OptimizeRunResult
    try {
      run = await runOptimization(runtimeContext.requireSave().data, request, {
        onProgress,
        signal: cancelController.signal,
      })
    } catch (e) {
      finishJob(cacheId, 'failed', { error: String((e as Error)?.message ?? e) })
      throw e
    }

    // load_save remains available while the driver searches its own snapshot.
    // Discard that snapshot's results before caching or hydrating relic ids:
    // the new inventory may contain different relics with the same ids.
    if (generation !== runtimeContext.getSaveGeneration()) {
      finishJob(cacheId, 'failed', { error: '运行期间 load_save 切换了存档,结果已丢弃——请对当前存档重新优化' })
      throw new Error('A load_save changed the save while optimization was running — results were discarded; re-run optimize for the current save')
    }

    finishJob(cacheId, run.summary.cancelled ? 'cancelled' : 'completed', {
      searched: run.summary.searched,
      durationMs: run.summary.durationMs,
      rows: run.rows.length,
    })
    runtimeContext.cacheOptimizeResult({
      summary: {
        cacheId,
        characterId,
        gridSortColumn: run.summary.gridSortColumn,
        validPermutations: run.summary.validPermutations,
        naivePermutations: run.summary.naivePermutations,
        searched: run.summary.searched,
        durationMs: run.summary.durationMs,
        cancelled: run.summary.cancelled,
        resultsLimit,
      },
      rows: run.rows,
      builds: run.builds,
      displayState: state,
      generation,
      at: Date.now(),
    })

    const rows = run.rows.map((row, index) => ({
      id: row.id,
      stats: serializeRowStats(row),
      build: serializeBuild(run.builds[index] ?? {}, characterId),
    }))

    // Baseline row for the character's currently equipped 6 relics (the web UI's
    // pinned top row). The driver computes it during the run; null when the run
    // finished before the baseline simulation landed (very fast / cancelled runs).
    const equippedRow = run.equippedRow != null
      ? {
        stats: run.equippedRow.stats,
        build: serializeBuild(run.equippedRow.build, characterId),
      }
      : null

    return toolResult(
      {
        status: run.summary.cancelled ? 'cancelled' : 'completed',
        rows,
        equippedRow,
        summary: {
          ...run.summary,
          cacheId,
          characterId,
          resultsLimit,
        },
      },
      `${run.summary.cancelled ? '已取消' : '已完成'} ${characterId} 的优化:`
        + `${rows.length} 行,在 ${(run.summary.durationMs / 1000).toFixed(2)}s 内搜索了 ${run.summary.searched.toLocaleString()} / `
        + `${run.summary.validPermutations.toLocaleString()} 个有效排列(cacheId ${cacheId})`,
    )
  })

  server.registerTool('get_results', {
    title: '翻页读取最近一次优化结果',
    description: '从最近一次 optimize 的缓存结果翻页读取——对应网页端优化结果网格的排序与筛选:'
      + 'offset/limit 分页,可按任意数值列(如 COMBO、EHP、xSPD)重新排序,支持数值列 min/max 过滤。'
      + '每行保留完整属性块与 6 件遗器配装明细;响应附 summary(该次运行的 cancelled/searched/validPermutations/'
      + 'characterId/gridSortColumn/resultsLimit 等,取消语义以此为准)。缓存所属存档必须仍是当前存档;load_save 后须重新运行 optimize。',
    inputSchema: {
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(50),
      sortBy: z.string().optional().describe('排序用的数值列名,如 "COMBO"(默认保持优化器输出顺序)'),
      sortDir: z.enum(['asc', 'desc']).default('desc'),
      filters: z.array(z.object({
        column: z.string().describe('数值列名,如 "COMBO"、"EHP"、"xSPD"、"WEIGHT"'),
        min: z.number().optional(),
        max: z.number().optional(),
      })).optional().describe('保留所有列出列都落在 [min, max] 区间内的行'),
    },
    outputSchema: {
      cacheId: z.string(),
      characterId: z.string(),
      summary: optimizeSummarySchema,
      total: z.number().int(),
      offset: z.number().int(),
      limit: z.number().int(),
      sort: z.object({ by: z.string(), dir: z.enum(['asc', 'desc']) }).nullable(),
      rows: z.array(optimizerRowSchema),
    },
  }, async ({ offset, limit, sortBy, sortDir, filters }) => {
    const cached = runtimeContext.getLastOptimizeResult()
    if (!cached) {
      throw new Error('No cached optimize results — run optimize first')
    }
    if (cached.generation !== runtimeContext.getSaveGeneration()) {
      throw new Error('Cached optimize results belong to a previous save load — re-run optimize for the current save before reading results')
    }

    let entries = cached.rows.map((row, index) => ({ row, build: cached.builds[index] ?? {} }))

    if (filters?.length) {
      entries = entries.filter(({ row }) =>
        filters.every((f) => {
          const value = (row as Any)[f.column]
          if (typeof value !== 'number') {
            throw new Error(`Unknown or non-numeric result column "${f.column}"`)
          }
          if (f.min != null && value < f.min) return false
          if (f.max != null && value > f.max) return false
          return true
        })
      )
    }

    if (sortBy != null) {
      const sample = (entries[0]?.row as Any)?.[sortBy]
      if (typeof sample !== 'number') {
        throw new Error(`Unknown or non-numeric sort column "${sortBy}"`)
      }
      entries.sort((a, b) =>
        sortDir === 'asc'
          ? (a.row as Any)[sortBy] - (b.row as Any)[sortBy]
          : (b.row as Any)[sortBy] - (a.row as Any)[sortBy]
      )
    }

    const page = entries.slice(offset, offset + limit)
    return toolResult(
      {
        cacheId: cached.summary.cacheId,
        characterId: cached.summary.characterId,
        summary: { ...cached.summary },
        total: entries.length,
        offset,
        limit,
        sort: sortBy != null ? { by: sortBy, dir: sortDir } : null,
        rows: page.map(({ row, build }) => ({
          id: row.id,
          stats: serializeRowStats(row),
          build: serializeBuild(build, cached.summary.characterId),
        })),
      },
      `返回 ${cached.summary.cacheId} 缓存中 ${entries.length} 行里的 ${page.length} 行${cached.summary.cancelled ? '(该次运行已被取消,结果为部分保留)' : ''}`,
    )
  })
}
