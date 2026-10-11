// Read-only optimizer results hook for the MCP server's managed-browser GPU
// path (mcp/src/domains/optimizer.ts → runGpuEngineOptimize).
//
// The GPU engines only run on this page's main thread, so the MCP drives the
// real page and has to read the run's results back out of it. The results
// grid's DOM holds display strings for the rendered rows only (the infinite row
// model renders the viewport plus rowBuffer), with no relic identity. This hook
// hands out the rows the grid is fed from, plus the six relic ids each row id
// decodes to. The decode has to happen here: a row id is an index into the
// relic lists THIS page filtered for the run (OptimizerTabController.setMetadata),
// and the GPU's tuple mode re-sorts those lists in place by set
// (webgpuInternals.ts), so the same build gets a different id than on a CPU run.
//
// Mounted at window.__HSR_OPTIMIZER_RESULTS (independent of window.__HSR_DEBUG,
// like __HSR_FULL_SYNC). Nothing in here writes to a store or to the grid.

import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { gridStore } from 'lib/stores/gridStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { OptimizerTabController } from 'lib/tabs/tabOptimizer/optimizerTabController'

export interface HsrOptimizerRunStatus {
  inProgress: boolean
  /** Engine the last run actually started on (the display store's value) */
  runningEngine: string
  /** The display store's optimizerStartTime — the GPU engines reset it after pipeline warmup, so it does not mark the start of the run */
  startedAt: number | null
  /** When optimizationInProgress last flipped to true; null before the first run starts */
  runStartedAt: number | null
  /** When optimizationInProgress last flipped to false; null before the first run ends */
  finishedAt: number | null
  /** The display store's optimizerProgress: 1 once a search ran to completion, below 1 when it stopped early */
  progress: number
  permutations: number
  permutationsNaive: number
  permutationsSearched: number
  /** Rows the engine kept — the row list is published once rowCount reaches this */
  permutationsResults: number
  rowCount: number
  /** Column the grid is sorted by (set by the engine when it publishes rows) */
  sortColumn: string | null
}

export interface HsrOptimizerResultRow {
  row: OptimizerDisplayData
  /** Part → relic id, decoded from row.id against this run's filtered relic lists */
  build: Partial<Record<string, string | undefined>>
}

export interface HsrOptimizerResultsApi {
  status: () => HsrOptimizerRunStatus
  /** A page of result rows in the grid data source's current order (the grid re-sorts that array in place) */
  rows: (offset?: number, limit?: number) => HsrOptimizerResultRow[]
  /** The pinned baseline row for the currently equipped relics, if computed */
  equippedRow: () => OptimizerDisplayData | null
}

let initialized = false
let runStartedAt: number | null = null
let finishedAt: number | null = null

function status(): HsrOptimizerRunStatus {
  const display = useOptimizerDisplayStore.getState()
  const sorted = gridStore.optimizerGridApi()?.getColumnState().find((column) => column.sort != null)
  return {
    inProgress: display.optimizationInProgress,
    runningEngine: display.optimizerRunningEngine,
    startedAt: display.optimizerStartTime,
    runStartedAt,
    finishedAt,
    progress: display.optimizerProgress,
    permutations: display.permutations,
    permutationsNaive: display.permutationsNaive,
    permutationsSearched: display.permutationsSearched,
    permutationsResults: display.permutationsResults,
    rowCount: OptimizerTabController.getRows().length,
    sortColumn: sorted?.colId ?? null,
  }
}

function rows(offset = 0, limit = Number.MAX_SAFE_INTEGER): HsrOptimizerResultRow[] {
  return OptimizerTabController.getRows().slice(offset, offset + limit).map((row) => ({
    row,
    build: OptimizerTabController.calculateRelicIdsFromId(row.id),
  }))
}

function equippedRow(): OptimizerDisplayData | null {
  const pinned = gridStore.optimizerGridApi()?.getPinnedTopRow(0)?.data
  return pinned ?? useOptimizerDisplayStore.getState().optimizerSelectedRowData ?? null
}

export function initOptimizerResultsHook(): void {
  if (initialized) return
  initialized = true

  useOptimizerDisplayStore.subscribe((state, prev) => {
    if (!prev.optimizationInProgress && state.optimizationInProgress) {
      runStartedAt = Date.now()
      finishedAt = null
    }
    if (prev.optimizationInProgress && !state.optimizationInProgress) finishedAt = Date.now()
  })

  window.__HSR_OPTIMIZER_RESULTS = { status, rows, equippedRow }
}
