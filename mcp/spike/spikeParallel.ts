// Throwaway spike #2: drive the REAL upstream Optimizer.optimize headlessly on a node:worker_threads pool,
// and use it as an oracle for the mirrored inline scheduler in engineA.ts.
import './shims'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runEngineA } from './engineA'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any
const g = globalThis as Any

g.__HSR_MCP_WORKER_URL = new URL('./workerThread.js', import.meta.url).href
// Optimizer.optimize calls OptimizerTabController.scrollToGrid() → document.getElementById
g.document ??= { getElementById: () => null }

const results: Record<string, unknown> = { node: process.version, cores: navigator.hardwareConcurrency }
const realLog = console.log
const warnings: string[] = []
console.log = () => {}
console.info = () => {}
console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' ').slice(0, 200))
console.error = (...a: unknown[]) => void warnings.push('ERR ' + a.map(String).join(' ').slice(0, 300))
process.on('unhandledRejection', (e) => void warnings.push('UNHANDLED ' + String((e as Error)?.stack ?? e).slice(0, 400)))

const { Metadata } = await import('lib/state/metadataInitializer')
Metadata.initialize()
const persistenceService = await import('lib/services/persistenceService')
const { Optimizer } = await import('lib/optimization/optimizer')
const { OptimizerTabController } = await import('lib/tabs/tabOptimizer/optimizerTabController')
const { useOptimizerDisplayStore } = await import('lib/stores/optimizerUI/useOptimizerDisplayStore')
const { useGlobalStore } = await import('lib/stores/app/appStore')
const { SavedSessionKeys } = await import('lib/constants/constantsSession')
const { COMPUTE_ENGINE_CPU } = await import('lib/constants/constants')
const { computeLoadForm } = await import('lib/stores/optimizerForm/optimizerFormStoreActions')
const { displayToInternal } = await import('lib/stores/optimizerForm/optimizerFormConversions')
const { getCharacterById, getCharacters } = await import('lib/stores/character/characterStore')
const { getRelics, useRelicStore } = await import('lib/stores/relic/relicStore')
const { workerPool } = await import('lib/worker/workerPool')

const sampleSave = JSON.parse(readFileSync(resolve(process.cwd(), 'src/data/sample-save.json'), 'utf8'))
persistenceService.loadSaveData(sampleSave, false, false)
useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_CPU as Any)

const TARGET = '1212b1'

function buildRequest(): Any {
  const character = getCharacterById(TARGET as Any)!
  const request: Any = displayToInternal(computeLoadForm(character.form))
  request.rank = getCharacters().findIndex((c: Any) => c.id === TARGET)
  return request
}

let runCounter = 0
function startRealOptimizer(request: Any) {
  const id = `spike-run-${++runCounter}`
  useOptimizerDisplayStore.setState({
    permutationsSearched: 0,
    permutationsResults: 0,
    optimizerStartTime: null,
    optimizerEndTime: null,
    optimizerProgress: 0,
    optimizationInProgress: true,
  } as Any)
  useOptimizerDisplayStore.getState().setOptimizationId(id)
  request.optimizationId = id
  const done = new Promise<void>((res) => {
    const unsub = useOptimizerDisplayStore.subscribe((s: Any, prev: Any) => {
      if (prev.optimizationInProgress && !s.optimizationInProgress) {
        unsub()
        setTimeout(res, 50) // finalize() flips the flag before it publishes rows
      }
    })
  })
  void Optimizer.optimize(request)
  return done
}

// ── P1: real orchestrator + worker_threads pool on the sample save, vs the mirrored inline scheduler ──
try {
  const t0 = performance.now()
  await startRealOptimizer(buildRequest())
  const realMs = performance.now() - t0
  const realRows: Any[] = OptimizerTabController.getRows()
  const display = useOptimizerDisplayStore.getState() as Any

  const mirror = await runEngineA(TARGET, () => {})
  const col = mirror.gridSortColumn as string
  const realSorted = [...realRows].sort((a, b) => b[col] - a[col] || a.id - b.id)
  const mirrorSorted = [...mirror.rows].sort((a: Any, b: Any) => b[col] - a[col] || a.id - b.id)
  let firstMismatch = -1
  for (let i = 0; i < Math.min(realSorted.length, mirrorSorted.length); i++) {
    if (realSorted[i].id !== mirrorSorted[i].id || realSorted[i][col] !== mirrorSorted[i][col]) {
      firstMismatch = i
      break
    }
  }
  const realIds = new Set(realSorted.map((r) => r.id))
  const sameIdSet = mirrorSorted.every((r: Any) => realIds.has(r.id))
  const realBuild = OptimizerTabController.calculateRelicIdsFromId(realSorted[0].id)
  const mirrorBuild = mirror.decode!(mirrorSorted[0].id)

  results.P1_realOrchestrator_vs_mirror = {
    poolSize: workerPool.getPoolSize(),
    poolStats: workerPool.getStats(),
    realMs: Math.round(realMs),
    realRows: realRows.length,
    realPermutations: display.permutations,
    realPermutationsNaive: display.permutationsNaive,
    mirrorMs: Math.round(mirror.ms),
    mirrorRows: mirror.rows.length,
    sortColumn: col,
    firstMismatchIndex: firstMismatch,
    sameIdSet,
    top1SameBuild: JSON.stringify(realBuild) === JSON.stringify(mirrorBuild),
    realTop1: { id: realSorted[0].id, value: realSorted[0][col] },
    mirrorTop1: { id: mirrorSorted[0].id, value: mirrorSorted[0][col] },
  }
} catch (e) {
  results.P1_realOrchestrator_vs_mirror = { ok: false, error: String((e as Error)?.stack ?? e).slice(0, 600) }
}

// ── P2: multi-core throughput on a ~1900-relic inventory, then cancel ──
try {
  const base = getRelics()
  const big: Any[] = []
  for (let k = 0; k < 12; k++) for (const r of base) big.push({ ...r, id: `${r.id}#${k}`, equippedBy: k === 0 ? r.equippedBy : undefined })
  useRelicStore.getState().setRelics(big)

  const done = startRealOptimizer(buildRequest())
  const samples: { t: number, searched: number }[] = []
  const tStart = performance.now()
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = useOptimizerDisplayStore.getState() as Any
    samples.push({ t: Math.round(performance.now() - tStart), searched: Math.round(s.optimizerProgress * s.permutationsNaive) })
  }
  const s = useOptimizerDisplayStore.getState() as Any
  const first = samples[1]
  const last = samples[samples.length - 1]
  const tCancel = performance.now()
  Optimizer.cancel()
  await done
  results.P2_parallelThroughput = {
    inventory: big.length,
    permutationsNaive: s.permutationsNaive,
    permutationsValid: s.permutations,
    samples,
    steadyStatePermsPerSec: Math.round((last.searched - first.searched) / ((last.t - first.t) / 1000)),
    cancelLatencyMs: Math.round(performance.now() - tCancel),
    rowsAfterCancel: OptimizerTabController.getRows().length,
    poolStats: workerPool.getStats(),
  }
} catch (e) {
  results.P2_parallelThroughput = { ok: false, error: String((e as Error)?.stack ?? e).slice(0, 600) }
}

results.warnings = [...new Set(warnings)].slice(0, 20)
results.rssMb = Math.round(process.memoryUsage().rss / 1e6)
workerPool.terminate()
realLog(JSON.stringify(results, null, 2))
process.exit(0)
