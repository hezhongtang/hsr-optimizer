// Main-thread wrapper around the driver worker (src/worker/driverThread.ts).
//
// `runOptimization` keeps the MCP main thread free: the upstream
// `Optimizer.optimize` orchestration runs inside the driver worker thread,
// whose internal workerPool becomes a node:worker_threads pool via the
// `?worker` alias (spike-verified pattern).
//
// Cancellation is cooperative: an aborted `signal` forwards `Optimizer.cancel()`
// into the driver; the run then finishes with whatever top-N rows were already
// found (measured stop latency 80–180ms), so partial results are returned
// rather than dropped.

import { Worker } from 'node:worker_threads'

import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import type { Form } from 'types/form'
import type { HsrOptimizerSaveFormat } from 'types/store'

export type OptimizeProgress = {
  searched: number,
  total: number,
  validPermutations: number,
  results: number,
  progress: number,
  ratePerSec: number,
}

/** Baseline row for the character's currently equipped relics (driver-side stats + slot→relicId map). */
export type EquippedRow = {
  /** Numeric stat columns of the equipped-row simulation (same shape as row stats, minus id) */
  stats: Record<string, number>,
  /** Part → equipped relic id, from the character's equipped map in the driver */
  build: Partial<Record<string, string | undefined>>,
}

export type OptimizeRunResult = {
  rows: OptimizerDisplayData[],
  builds: Array<Partial<Record<string, string | undefined>>>,
  /** Currently-equipped baseline row; null when the run finished before the
   * baseline simulation landed (very fast or cancelled runs) */
  equippedRow: EquippedRow | null,
  summary: {
    validPermutations: number,
    naivePermutations: number,
    searched: number,
    durationMs: number,
    cancelled: boolean,
    gridSortColumn: string,
  },
}

export type OptimizeRunOptions = {
  onProgress?: (progress: OptimizeProgress) => void,
  signal?: AbortSignal,
}

type ActiveRun = {
  resolve: (result: OptimizeRunResult) => void,
  reject: (error: Error) => void,
  onProgress?: (progress: OptimizeProgress) => void,
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

let driver: Worker | null = null
let activeRun: ActiveRun | null = null

function ensureDriver(): Worker {
  if (driver) return driver

  const driverUrl = (globalThis as Any).__HSR_MCP_DRIVER_URL as string | undefined
  if (!driverUrl) {
    throw new Error('Driver worker URL not set — server entry did not bootstrap worker URLs')
  }

  const worker = new Worker(new URL(driverUrl))
  worker.on('message', (message: Any) => {
    if (message.type === 'progress') {
      activeRun?.onProgress?.({
        searched: message.searched,
        total: message.total,
        validPermutations: message.validPermutations,
        results: message.results,
        progress: message.progress,
        ratePerSec: message.ratePerSec,
      })
      return
    }
    if (message.type === 'done') {
      const run = activeRun
      activeRun = null
      if (!run) return
      if (message.ok) {
        run.resolve({
          rows: message.rows as OptimizerDisplayData[],
          builds: message.builds,
          equippedRow: message.equippedRow ?? null,
          summary: message.summary,
        })
      } else {
        run.reject(new Error(`Optimizer driver failed: ${message.error}`))
      }
    }
  })
  worker.on('error', (error: Error) => {
    const run = activeRun
    activeRun = null
    driver = null
    run?.reject(new Error(`Optimizer driver crashed: ${error.message}`))
  })
  worker.on('exit', (code) => {
    // Unexpected exit while idle or mid-run: drop the handle so the next call respawns
    const run = activeRun
    activeRun = null
    if (driver === worker) driver = null
    // ANY exit settles an in-flight run — a driver that exits "cleanly" (code 0)
    // without delivering its `done` message would otherwise leave the promise
    // pending forever
    run?.reject(new Error(`Optimizer driver exited with code ${code} before reporting results`))
  })

  driver = worker
  return worker
}

/**
 * Run one optimization inside the driver worker. One run at a time —
 * concurrent calls reject immediately (mirrors the web UI's single-search model).
 */
export async function runOptimization(
  saveData: HsrOptimizerSaveFormat,
  request: Form,
  options: OptimizeRunOptions = {},
): Promise<OptimizeRunResult> {
  if (activeRun) {
    throw new Error('Another optimization is already running — wait for it or cancel it first')
  }

  const worker = ensureDriver()

  const result = new Promise<OptimizeRunResult>((resolve, reject) => {
    activeRun = { resolve, reject, onProgress: options.onProgress }
    worker.postMessage({ type: 'run', saveData, request })
  })

  if (options.signal) {
    const signal = options.signal
    const forwardCancel = () => {
      // Ask the driver to stop; DO NOT reject the promise — the cancelled run
      // still resolves with partial results (upstream CANCEL keeps top-N rows).
      if (driver && activeRun) driver.postMessage({ type: 'cancel' })
    }
    signal.addEventListener('abort', forwardCancel, { once: true })
    result.then(() => signal.removeEventListener('abort', forwardCancel), () => signal.removeEventListener('abort', forwardCancel))
  }

  return result
}

export function isOptimizationRunning(): boolean {
  return activeRun != null
}

/**
 * Terminate the driver worker and drop the handle (shutdown path — stdin EOF /
 * signals before process.exit). Safe when no driver was ever spawned. An
 * in-flight run is left to the process exit, which tears worker threads down.
 */
export function terminateDriver(): void {
  const worker = driver
  driver = null
  activeRun = null
  void worker?.terminate()
}
