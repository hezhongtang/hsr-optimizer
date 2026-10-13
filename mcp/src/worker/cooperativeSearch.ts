// Cooperative benchmark search for the MCP main thread.
//
// Upstream dispatches every optimal-simulation search through one seam:
// defaultComputeOptimalSimulationSearchRunner runs it inline when
// globalThis.SEQUENTIAL_BENCHMARKS is set and hands it to workerPool.runTask
// otherwise. The main thread has no pool workers (the pool lives in the
// optimize driver thread), so the inline path used to be the only one that
// worked here — and a batch of inline searches only ever yields to microtasks,
// which leaves stdin unread: get_job, cancel_job and cancellation
// notifications queue up until the whole batch has finished.
//
// This takes over the pool side of the seam instead. Each search still runs
// through upstream's runComputeOptimalSimulationInline, but only after a real
// event-loop turn, one at a time in dispatch order. Dispatching first and
// searching afterwards is the order the web app's worker pool runs in, so
// results are unchanged; the server reads requests between searches.

import {
  type ComputeOptimalSimulationWorkerInput,
  runComputeOptimalSimulationInline,
} from 'lib/worker/computeOptimalSimulationWorkerRunner'
import { workerPool } from 'lib/worker/workerPool'
import { WorkerType } from 'lib/worker/workerUtils'

let installed = false
let tail: Promise<unknown> = Promise.resolve()

// setImmediate runs after the poll phase, so pending stdin frames are handled first
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

function install() {
  if (installed) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((globalThis as any).__HSR_MCP_POOL_WORKER_URL) {
    throw new Error('Cooperative search is for the MCP main thread — this thread owns a real worker pool')
  }
  installed = true

  const poolRunTask = workerPool.runTask.bind(workerPool)
  workerPool.runTask = ((input, options) => {
    if (input.workerType !== WorkerType.COMPUTE_OPTIMAL_SIMULATION) return poolRunTask(input, options)
    const run = tail.then(nextTurn).then(() => runComputeOptimalSimulationInline(input as unknown as ComputeOptimalSimulationWorkerInput))
    tail = run.catch(() => {})
    return run
  }) as typeof workerPool.runTask
}

/**
 * Routes the next orchestrator run's searches through the cooperative queue.
 * dps_score, score_character and the leaderboard tools set
 * SEQUENTIAL_BENCHMARKS for the process and never clear it, so callers
 * re-assert this before every orchestrator run of a long batch. Should the
 * flag flip back mid-run, searches already queued still go one per turn and
 * the phases not dispatched yet search inline: same results, that stretch
 * just holds the thread.
 */
export function enableCooperativeSearch() {
  install()
  globalThis.SEQUENTIAL_BENCHMARKS = false
}
