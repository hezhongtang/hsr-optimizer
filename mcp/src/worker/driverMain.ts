// Driver worker main loop — the headless twin of "Start Optimizer" in the web UI.
//
// Lives inside the driverThread worker (NOT the MCP main thread). Protocol:
//   in : { type: 'run', saveData, request }   — reload save snapshot, run Optimizer.optimize
//   in : { type: 'cancel' }                   — Optimizer.cancel(); partial results are kept
//   out: { type: 'progress', ... }            — throttled display-store progress (~200ms)
//   out: { type: 'done', ok, rows?, builds?, equippedRow?, summary?, error? }
//
// Runs are strictly sequential (one at a time, mirroring the web UI). The
// optimizer pool is reaped after a idle period to return worker memory.

import { parentPort } from 'node:worker_threads'

import { COMPUTE_ENGINE_CPU } from 'lib/constants/constants'
import { SavedSessionKeys } from 'lib/constants/constantsSession'
import { Optimizer } from 'lib/optimization/optimizer'
import { SortOption } from 'lib/optimization/sortOptions'
import * as persistenceService from 'lib/services/persistenceService'
import { Metadata } from 'lib/state/metadataInitializer'
import { useGlobalStore } from 'lib/stores/app/appStore'
import { getCharacterById } from 'lib/stores/character/characterStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { OptimizerTabController } from 'lib/tabs/tabOptimizer/optimizerTabController'
import { workerPool } from 'lib/worker/workerPool'
import type { Form } from 'types/form'

import type { HsrOptimizerSaveFormat } from 'types/store'

type RunMessage = {
  type: 'run',
  saveData: HsrOptimizerSaveFormat,
  request: Form,
}

type InMessage = RunMessage | { type: 'cancel' }

type EquippedRowPayload = {
  stats: Record<string, number>,
  build: Partial<Record<string, string | undefined>>,
}

type DoneMessage = {
  type: 'done',
  ok: boolean,
  error?: string,
  rows?: unknown[],
  builds?: Array<Partial<Record<string, string | undefined>>>,
  equippedRow?: EquippedRowPayload | null,
  summary?: {
    validPermutations: number,
    naivePermutations: number,
    searched: number,
    durationMs: number,
    cancelled: boolean,
    gridSortColumn: string,
  },
}

const PROGRESS_THROTTLE_MS = 200
const FINALIZE_SETTLE_MS = 50 // finalize() flips the in-progress flag before publishing rows
const IDLE_POOL_REAP_MS = 30_000

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

let running = false
let cancelRequested = false
let runCounter = 0
let reapTimer: ReturnType<typeof setTimeout> | null = null
let lastProgressPost = 0

function post(message: DoneMessage | { type: 'progress', [k: string]: unknown }): void {
  parentPort!.postMessage(message)
}

function postProgress(state: Any, force: boolean): void {
  const now = performance.now()
  if (!force && now - lastProgressPost < PROGRESS_THROTTLE_MS) return
  lastProgressPost = now
  const elapsedMs = state.optimizerStartTime ? Date.now() - state.optimizerStartTime : 0
  post({
    type: 'progress',
    searched: state.permutationsSearched,
    total: state.permutationsNaive,
    validPermutations: state.permutations,
    results: state.permutationsResults,
    progress: state.optimizerProgress,
    ratePerSec: elapsedMs > 0 ? Math.round(state.permutationsSearched / (elapsedMs / 1000)) : 0,
  })
}

function computeGridSortColumn(request: Form, context: Any): string {
  const sortOption = SortOption[request.resultSort!]
  if (!sortOption) return 'COMBO'
  if (!context) return sortOption.combatGridColumn
  const showMemo = request.memoDisplay === 'memo'
    && context.defaultActions[context.defaultActions.length - 1].config.entitiesArray.some((entity: Any) => entity.memosprite)
  if (request.statDisplay === 'combat') {
    return showMemo ? sortOption.memoCombatGridColumn : sortOption.combatGridColumn
  }
  return showMemo ? sortOption.memoBasicGridColumn : sortOption.basicGridColumn
}

/**
 * Baseline row for the character's currently equipped relics. Upstream computes
 * it mid-run via `calculateCurrentlyEquippedRow`, which — with no AG Grid
 * mounted — parks the row in `useOptimizerDisplayStore.optimizerSelectedRowData`
 * (the `setTopRow` branch is a no-op headless). A reference change vs. the
 * pre-run snapshot means THIS run refreshed it; without the check a fast or
 * cancelled run would echo the previous run's baseline.
 */
function collectEquippedRow(request: Form, selectedBeforeRun: unknown): EquippedRowPayload | null {
  const selected = (useOptimizerDisplayStore.getState() as Any).optimizerSelectedRowData
  if (selected == null || selected === selectedBeforeRun) return null
  const stats: Record<string, number> = {}
  for (const [key, value] of Object.entries(selected as Record<string, unknown>)) {
    if (key === 'id') continue
    if (typeof value === 'number') stats[key] = value
  }
  const equipped = getCharacterById(request.characterId)?.equipped as Partial<Record<string, string | undefined>> | undefined
  return { stats, build: equipped ?? {} }
}

function schedulePoolReap(): void {
  if (reapTimer != null) clearTimeout(reapTimer)
  reapTimer = setTimeout(() => {
    reapTimer = null
    if (running) return
    // Frees the pool worker threads; the pool lazily re-initializes on the
    // next run. Idle workers each hold a full engine heap, so reaping matters.
    workerPool.terminate()
  }, IDLE_POOL_REAP_MS)
}

async function handleRun(message: RunMessage): Promise<void> {
  if (running) {
    post({ type: 'done', ok: false, error: 'Another optimization is already running in the driver' })
    return
  }
  running = true
  cancelRequested = false
  if (reapTimer != null) {
    clearTimeout(reapTimer)
    reapTimer = null
  }

  try {
    Metadata.initialize()
    // Reload the snapshot so the driver's stores match the main thread exactly.
    persistenceService.loadSaveData(structuredClone(message.saveData), false, false)
    useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_CPU as Any)

    const request = message.request
    const optimizationId = `driver-run-${++runCounter}`
    // Snapshot the pinned-row slot so collectEquippedRow can tell whether THIS
    // run refreshed it (the store is not reset between runs)
    const selectedBeforeRun = (useOptimizerDisplayStore.getState() as Any).optimizerSelectedRowData
    useOptimizerDisplayStore.setState({
      permutationsSearched: 0,
      permutationsResults: 0,
      optimizerStartTime: null,
      optimizerEndTime: null,
      optimizerProgress: 0,
      optimizationInProgress: true,
    } as Any)
    useOptimizerDisplayStore.getState().setOptimizationId(optimizationId)
    request.optimizationId = optimizationId

    const startedAt = performance.now()
    const done = new Promise<void>((resolve) => {
      const unsubscribe = useOptimizerDisplayStore.subscribe((state: Any, prev: Any) => {
        if (state.permutationsSearched !== prev.permutationsSearched || state.optimizerProgress !== prev.optimizerProgress) {
          postProgress(state, false)
        }
        if (prev.optimizationInProgress && !state.optimizationInProgress) {
          unsubscribe()
          postProgress(useOptimizerDisplayStore.getState(), true)
          setTimeout(resolve, FINALIZE_SETTLE_MS)
        }
      })
    })

    void Optimizer.optimize(request)
    await done

    const display = useOptimizerDisplayStore.getState() as Any
    const rows: Any[] = OptimizerTabController.getRows()
    const builds = rows.map((row) => row.id === -1 ? {} : OptimizerTabController.calculateRelicIdsFromId(row.id, request))
    const equippedRow = collectEquippedRow(request, selectedBeforeRun)

    const summary = {
      validPermutations: display.permutations ?? 0,
      naivePermutations: display.permutationsNaive ?? 0,
      searched: display.permutationsSearched ?? 0,
      durationMs: Math.round(performance.now() - startedAt),
      cancelled: cancelRequested,
      gridSortColumn: computeGridSortColumn(request, display.context),
    }
    post({ type: 'done', ok: true, rows, builds, equippedRow, summary })
  } catch (e) {
    post({ type: 'done', ok: false, error: String((e as Error)?.stack ?? e) })
  } finally {
    running = false
    schedulePoolReap()
  }
}

function handleCancel(): void {
  if (!running) return
  cancelRequested = true
  Optimizer.cancel()
}

parentPort!.on('message', (message: InMessage) => {
  if (message.type === 'run') void handleRun(message)
  else if (message.type === 'cancel') handleCancel()
})
