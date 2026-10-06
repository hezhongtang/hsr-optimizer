// Unified job management domain (M4-B): `get_job` / `cancel_job` over a
// module-level registry the optimizer and simulation domains register their
// long-running work in.
//
//   optimize        → the run's cacheId doubles as its jobId; progress comes
//                     from the driver's progress events (searched/total/
//                     results/ratePerSec)
//   benchmark_runs  → ONE job per batch: cancellation only lands between
//                     presets and the tool returns a single aggregated result,
//                     so per-preset granularity lives in progress
//                     (completedPresets/totalPresets) instead of extra jobs
//
// cancel_job routes to each run's OWN cooperative-cancel path: the domain
// passes the linkedAbortController(extra.signal).signal where it previously
// passed extra.signal (runOptimization → driver CANCEL / the benchmark preset
// loop), and registers controller.abort as the job's cancel hook — no
// cancellation logic is duplicated here.
//
// The registry is main-thread only and bounded (most recent MAX_JOBS kept,
// oldest dropped). It is purely informational: get_job / cancel_job never
// touch the stores, so they leave the change revision untouched.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { toolResult } from '../toolResult'

export type JobKind = 'optimize' | 'benchmark_runs'
export type JobStatus = 'running' | 'completed' | 'cancelled' | 'failed'
/** Terminal job statuses — the only values finishJob accepts. */
export type JobEndStatus = Exclude<JobStatus, 'running'>

/** Progress a run can report; whatever a kind cannot produce stays absent. */
export type JobProgress = {
  /** Free-text stage marker (benchmark: the last per-preset notification text) */
  phase?: string,
  /** optimize: permutations searched so far */
  searched?: number,
  /** optimize: total searchable permutations */
  totalPermutations?: number,
  /** optimize: candidate rows found so far */
  results?: number,
  /** optimize: search rate, permutations/second */
  ratePerSec?: number,
  /** benchmark_runs: presets fully finished so far */
  completedPresets?: number,
  /** benchmark_runs: presets in the batch */
  totalPresets?: number,
}

/** Free-form references a domain attaches (characterId/preset labels/rows/…) */
export type JobSummary = Record<string, unknown>

export type JobRecord = {
  jobId: string,
  kind: JobKind,
  status: JobStatus,
  /** Epoch ms */
  startedAt: number,
  /** Epoch ms; null while running */
  endedAt: number | null,
  progress: JobProgress,
  /** Registration-time info merged with finishJob's terminal summary */
  summary: JobSummary,
  /** Cooperative-cancel hook (dropped by finishJob); only set while running */
  cancel: (() => void) | null,
}

const MAX_JOBS = 50

const jobs = new Map<string, JobRecord>()
let jobSeq = 0

/** Fresh job id for kinds without a natural one (optimize reuses its cacheId). */
export function nextJobId(prefix: string): string {
  return `${prefix}-${++jobSeq}-${Date.now().toString(36)}`
}

/**
 * AbortController that also fires when `source` aborts — the plumbing that
 * lets cancel_job drive the exact cooperative-cancel path a request-signal
 * cancellation already takes. Passing `controller.signal` where a domain
 * previously passed `extra.signal` keeps client-side cancellation identical.
 */
export function linkedAbortController(source?: AbortSignal): AbortController {
  const controller = new AbortController()
  if (source == null) return controller
  if (source.aborted) controller.abort()
  else source.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

/** Register a starting job; evicts the oldest records beyond MAX_JOBS. */
export function registerJob(
  jobId: string,
  kind: JobKind,
  options: { cancel?: () => void, summary?: JobSummary, progress?: JobProgress } = {},
): void {
  jobs.delete(jobId) // a same-id retry replaces its previous record
  while (jobs.size >= MAX_JOBS) {
    const oldest = jobs.keys().next().value
    if (oldest === undefined) break
    jobs.delete(oldest)
  }
  jobs.set(jobId, {
    jobId,
    kind,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    progress: options.progress ?? {},
    summary: options.summary ?? {},
    cancel: options.cancel ?? null,
  })
}

/** Merge partial progress into a RUNNING job; ended jobs ignore it. */
export function updateJobProgress(jobId: string, progress: JobProgress): void {
  const job = jobs.get(jobId)
  if (job == null || job.status !== 'running') return
  job.progress = { ...job.progress, ...progress }
}

/** Settle a job: terminal status, endedAt, merged summary, cancel hook dropped. */
export function finishJob(jobId: string, status: JobEndStatus, summary?: JobSummary): void {
  const job = jobs.get(jobId)
  if (job == null) return
  job.status = status
  job.endedAt = Date.now()
  job.cancel = null
  if (summary != null) job.summary = { ...job.summary, ...summary }
}

export function getJobRecord(jobId: string): JobRecord | null {
  return jobs.get(jobId) ?? null
}

export function listJobRecords(): JobRecord[] {
  return [...jobs.values()]
}

function unknownJobMessage(jobId: string): string {
  const recent = listJobRecords().slice(-5).map((job) => job.jobId)
  return `未知任务 id "${jobId}"——注册表中没有这个任务。不带参数调用 get_job 可列出全部任务`
    + (recent.length > 0 ? `(最近的任务: ${recent.join(', ')})` : '(注册表当前为空)')
}

// ─── tool registration ───────────────────────────────────────────────────────

const jobKindEnum = z.enum(['optimize', 'benchmark_runs'])
const jobStatusEnum = z.enum(['running', 'completed', 'cancelled', 'failed'])

const jobProgressOutSchema = z.object({
  phase: z.string().optional(),
  searched: z.number().optional(),
  totalPermutations: z.number().optional(),
  results: z.number().optional(),
  ratePerSec: z.number().optional(),
  completedPresets: z.number().optional(),
  totalPresets: z.number().optional(),
})

// summary 由各域自由填写(cacheId/预设名/行数/耗时等引用),值按 unknown 放宽
const jobDetailOutSchema = z.object({
  jobId: z.string(),
  kind: jobKindEnum,
  status: jobStatusEnum,
  startedAt: z.number().describe('开始时间,epoch 毫秒'),
  endedAt: z.number().nullable().describe('结束时间,epoch 毫秒;运行中为 null'),
  durationMs: z.number().nullable().describe('耗时毫秒;运行中为 null'),
  cancellable: z.boolean().describe('是否仍有可用的取消路径(已结束为 false)'),
  progress: jobProgressOutSchema,
  summary: z.record(z.string(), z.unknown()),
})

const jobListItemOutSchema = z.object({
  jobId: z.string(),
  kind: jobKindEnum,
  status: jobStatusEnum,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
})

function serializeJobDetail(job: JobRecord) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: job.endedAt != null ? job.endedAt - job.startedAt : null,
    cancellable: job.cancel != null,
    progress: { ...job.progress },
    summary: { ...job.summary },
  }
}

function describeProgress(progress: JobProgress): string {
  const bits: string[] = []
  if (progress.completedPresets != null) bits.push(`预设 ${progress.completedPresets}/${progress.totalPresets ?? '?'}`)
  if (progress.searched != null) {
    bits.push(`已搜索 ${progress.searched.toLocaleString()} 个排列`)
    if (progress.ratePerSec != null) bits.push(`${progress.ratePerSec.toLocaleString()}/s`)
  }
  return bits.length > 0 ? bits.join(', ') : '暂无进度信号'
}

export function registerJobsTools(server: McpServer): void {
  server.registerTool('get_job', {
    title: '查询后台任务',
    description: '统一查询长任务(optimize 优化搜索 / benchmark_runs 批量跑分)的生命周期与进度。'
      + '不传 jobId:列出任务注册表(新任务在前,只保留最近 50 条,含 id/类型/状态/起止时间);'
      + '传 jobId:返回单个任务详情,含进度(optimize:已搜索排列数/速率;benchmark_runs:已完成预设数)'
      + '与摘要引用(optimize 的 cacheId 与行数、benchmark 的预设清单与耗时)。'
      + '纯只读查询,不改任何状态、不影响 revision。'
      + 'jobId 口径:optimize 任务以其 cacheId 为 id(形如 "opt-3-…"),benchmark_runs 任务形如 "bench-1-…"。',
    inputSchema: {
      jobId: z.string().optional().describe('任务 id;缺省列出全部任务(紧凑列表)'),
    },
    outputSchema: {
      mode: z.enum(['list', 'detail']),
      total: z.number().int().describe('列表条数(详情模式为 1)'),
      jobs: z.array(jobListItemOutSchema).optional().describe('列表模式:全部任务,新任务在前'),
      job: jobDetailOutSchema.optional().describe('详情模式:单个任务的完整记录'),
    },
  }, async ({ jobId }): Promise<CallToolResult> => {
    if (jobId == null) {
      const records = listJobRecords().reverse() // newest first
      const byStatus = new Map<string, number>()
      for (const job of records) byStatus.set(job.status, (byStatus.get(job.status) ?? 0) + 1)
      const breakdown = [...byStatus.entries()].map(([status, count]) => `${count} ${status}`).join(' / ')
      return toolResult(
        {
          mode: 'list',
          total: records.length,
          jobs: records.map((job) => ({
            jobId: job.jobId,
            kind: job.kind,
            status: job.status,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
          })),
        },
        `任务注册表共 ${records.length} 条(${breakdown || '空'}),新任务在前;传 jobId 可查单个任务详情`,
      )
    }

    const job = getJobRecord(jobId)
    if (job == null) throw new Error(unknownJobMessage(jobId))
    const detail = serializeJobDetail(job)
    return toolResult(
      { mode: 'detail', total: 1, job: detail },
      `任务 ${detail.jobId}(${detail.kind}):${detail.status},${describeProgress(detail.progress)}`
        + (detail.endedAt != null ? `,耗时 ${detail.durationMs}ms` : ',进行中'),
    )
  })

  server.registerTool('cancel_job', {
    title: '取消后台任务',
    description: '请求取消一个运行中的长任务——路由到该任务自身的协作取消路径,不引入新的取消逻辑:'
      + 'optimize 尽快停止搜索并保留已找到的部分结果(原 optimize 调用正常返回 status="cancelled" 而非报错,'
      + '结果照常缓存供 get_results 翻页);benchmark_runs 在当前预设跑完后停止,返回已完成部分。'
      + '取消是异步落地的:本工具返回时任务仍为 running,状态稍后转为 cancelled,用 get_job 轮询确认。'
      + '对已结束(completed/cancelled/failed)的任务不做任何事,直接返回其当前状态;未知 id 报错。',
    inputSchema: {
      jobId: z.string().describe('要取消的任务 id(get_job 可查)'),
    },
    outputSchema: {
      jobId: z.string(),
      kind: jobKindEnum,
      jobStatus: jobStatusEnum.describe('本次调用时的任务状态(发出取消请求后仍为 running,稍后转为 cancelled)'),
      cancelRequested: z.boolean().describe('是否实际发出了取消请求(false=任务已结束或没有取消路径)'),
    },
  }, async ({ jobId }): Promise<CallToolResult> => {
    const job = getJobRecord(jobId)
    if (job == null) throw new Error(unknownJobMessage(jobId))

    if (job.status !== 'running') {
      return toolResult(
        { jobId: job.jobId, kind: job.kind, jobStatus: job.status, cancelRequested: false },
        `任务 ${job.jobId} 已结束(状态 ${job.status}),无需取消`,
      )
    }
    if (job.cancel == null) {
      return toolResult(
        { jobId: job.jobId, kind: job.kind, jobStatus: job.status, cancelRequested: false },
        `任务 ${job.jobId}(${job.kind})运行中,但没有注册取消路径——等待其自然结束`,
      )
    }

    job.cancel()
    return toolResult(
      { jobId: job.jobId, kind: job.kind, jobStatus: 'running', cancelRequested: true },
      `已向任务 ${job.jobId}(${job.kind})发出取消请求:任务稍后转为 cancelled(期间仍显示 running)——`
        + 'optimize 保留已搜到的部分结果、benchmark_runs 完成当前预设后停止;用 get_job 轮询确认',
    )
  })
}
