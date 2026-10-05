// Throwaway feasibility spike for the MCP design. Not production code.
// Each stage is isolated so one failure doesn't hide the others; results are printed as JSON on stdout.
import { shimsEnabled } from './shims'

import { runEngineA } from './engineA'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const results: Record<string, unknown> = { shimsEnabled, node: process.version }
const repoRoot = process.cwd()

async function stage<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const t0 = performance.now()
  try {
    const detail = await fn()
    results[name] = { ok: true, ms: Math.round(performance.now() - t0), ...(detail && typeof detail === 'object' ? detail : { value: detail }) }
    return detail
  } catch (e) {
    const err = e as Error
    results[name] = {
      ok: false,
      ms: Math.round(performance.now() - t0),
      error: String(err?.message ?? e),
      at: err?.stack?.split('\n').slice(1, 3).map((l) => l.trim().replace(/file:.*\.build\//, '')),
    }
    return undefined
  }
}

// Silence the app's console.log chatter so stdout stays parseable.
const realLog = console.log
console.log = () => {}
console.info = () => {}
const warnings: string[] = []
console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' ').slice(0, 200))
console.error = (...a: unknown[]) => void warnings.push('ERR ' + a.map(String).join(' ').slice(0, 200))
process.on('unhandledRejection', (e) => void warnings.push('UNHANDLED ' + String((e as Error)?.message ?? e).slice(0, 300)))

// ───────────────────────── S1: metadata ─────────────────────────
await stage('S1_metadata', async () => {
  const { Metadata } = await import('lib/state/metadataInitializer')
  Metadata.initialize()
  const { getGameMetadata } = await import('lib/state/gameMetadata')
  const m = getGameMetadata()
  return { characters: Object.keys(m.characters).length, lightCones: Object.keys(m.lightCones).length }
})

// ───────────────────────── S2: stores ─────────────────────────
await stage('S2_stores_import', async () => {
  await import('lib/stores/relic/relicStore')
  await import('lib/stores/character/characterStore')
  await import('lib/stores/scoring/scoringStore')
  await import('lib/stores/app/appStore')
  await import('lib/stores/optimizerForm/useOptimizerRequestStore')
  return {}
})

// ───────────────────────── S3: services ─────────────────────────
await stage('S3a_equipmentService_import', async () => void (await import('lib/services/equipmentService')))
await stage('S3b_persistenceService_import', async () => void (await import('lib/services/persistenceService')))
await stage('S3c_saveState_import', async () => void (await import('lib/state/saveState')))
await stage('S3d_importer_import', async () => void (await import('lib/importer/importConfig')))
await stage('S3e_optimizer_ts_import', async () => void (await import('lib/optimization/optimizer')))
await stage('S3f_optimizerFormActions_import', async () => void (await import('lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions')))

// ───────────────────────── S4: load sample save ─────────────────────────
const sampleSave = JSON.parse(readFileSync(resolve(repoRoot, 'src/data/sample-save.json'), 'utf8'))
await stage('S4_loadSaveData', async () => {
  const persistenceService = await import('lib/services/persistenceService')
  persistenceService.loadSaveData(structuredClone(sampleSave), false, false)
  const { getRelics } = await import('lib/stores/relic/relicStore')
  const { getCharacters } = await import('lib/stores/character/characterStore')
  const chars = getCharacters()
  return {
    relics: getRelics().length,
    characters: chars.length,
    equippedCounts: chars.map((c: Any) => `${c.id}:${Object.values(c.equipped).filter(Boolean).length}`),
  }
})

// ───────────────────────── S5: headless Engine A ─────────────────────────
const TARGET = '1212b1'
let engineARun: Any
await stage('S5a_engineA_sampleSave', async () => {
  engineARun = await runEngineA(TARGET, () => {})
  const top = engineARun.rows[0]
  return {
    sizes: engineARun.sizes,
    permutations: engineARun.permutations,
    searched: engineARun.searched,
    searchMs: Math.round(engineARun.ms),
    permsPerSec: Math.round(engineARun.searched / (engineARun.ms / 1000)),
    results: engineARun.rows.length,
    sortColumn: engineARun.gridSortColumn,
    resultSort: engineARun.request.resultSort,
    top3: engineARun.rows.slice(0, 3).map((r: Any) => ({
      id: r.id,
      sort: r[engineARun.gridSortColumn],
      SPD: r.SPD,
      CR: r.CR,
      CD: r.CD,
      COMBO: r.COMBO,
      EHP: r.EHP,
    })),
    topBuild: top ? engineARun.decode(top.id) : null,
  }
})

await stage('S5b_engineA_determinism_freshContext', async () => {
  const a = engineARun
  const b = await runEngineA(TARGET, () => {}, { freshContextPerChunk: true })
  const same = a.rows.length === b.rows.length
    && a.rows.every((r: Any, i: number) => r.id === b.rows[i].id && r[a.gridSortColumn] === b.rows[i][a.gridSortColumn])
  return { identicalToSharedContextRun: same, rows: b.rows.length }
})

// Cross-check: re-simulate the top row's 6 relics through simulateBuild and compare to the packed row.
await stage('S5c_engineA_crosscheck_simulateBuild', async () => {
  const { simulateBuild } = await import('lib/simulations/simulateBuild')
  const { GlobalRegister } = await import('lib/optimization/engine/config/keys')
  const { getRelicById } = await import('lib/stores/relic/relicStore')
  const { RelicFilters } = await import('lib/relics/relicFilters')
  const { clone } = await import('lib/utils/objectUtils')
  const top = engineARun.rows[0]
  const ids = engineARun.decode(top.id)
  const single: Any = {}
  for (const [part, id] of Object.entries(ids)) single[part] = clone(getRelicById(id as string))
  RelicFilters.calculateWeightScore(engineARun.request, Object.values(single))
  RelicFilters.applyMainStatsFilter(engineARun.request, Object.values(single))
  RelicFilters.condenseSingleRelicByPartSubstatsForOptimizer(single)
  const { x } = simulateBuild(single, engineARun.context, null, null, true)
  const combo = x.getGlobalRegisterValue(GlobalRegister.COMBO_DMG)
  return {
    rowCombo: top.COMBO,
    simCombo: combo,
    relDiff: Math.abs(combo - top.COMBO) / (Math.abs(top.COMBO) || 1),
    tracedBuffs: x.buffs?.length ?? null,
    tracedBuffSample: (x.buffs ?? []).slice(0, 3).map((b: Any) => JSON.stringify(b).slice(0, 160)),
  }
})

// Throughput at realistic inventory scale: clone the inventory 12x (~1900 relics), measure a fixed number of chunks.
await stage('S5d_engineA_throughput_bigInventory', async () => {
  const { getRelics } = await import('lib/stores/relic/relicStore')
  const base = getRelics()
  const big: Any[] = []
  for (let k = 0; k < 12; k++) for (const r of base) big.push({ ...r, id: `${r.id}#${k}`, equippedBy: k === 0 ? r.equippedBy : undefined })
  const run = await runEngineA(TARGET, () => {}, { maxChunks: 30, relicsOverride: big })
  return {
    inventory: big.length,
    sizes: run.sizes,
    permutations: run.permutations,
    searched: run.searched,
    searchMs: Math.round(run.ms),
    permsPerSec: Math.round(run.searched / (run.ms / 1000)),
  }
})

// ───────────────────────── S6: DPS score (Engine B) ─────────────────────────
await stage('S6_dpsScore', async () => {
  const { resolveSimulationMetadata, prepareOrchestrator, executeOrchestrator, executeUpgradeOrchestrator } = await import(
    'lib/simulations/orchestrator/runDpsScoreBenchmarkOrchestrator'
  )
  const { ScoringConfigType } = await import('types/metadata')
  const { DEFAULT_TEAM } = await import('lib/constants/constants')
  const { getCharacterById } = await import('lib/stores/character/characterStore')
  const { getRelicById } = await import('lib/stores/relic/relicStore')
  ;(globalThis as Any).SEQUENTIAL_BENCHMARKS = true

  const character: Any = getCharacterById(TARGET as Any)
  const sim = resolveSimulationMetadata(character, ScoringConfigType.DPS, DEFAULT_TEAM as Any)
  if (!sim) return { skipped: 'no simulation metadata for character' }
  const single: Any = {}
  for (const [part, id] of Object.entries(character.equipped)) single[part] = getRelicById(id as string)
  const t0 = performance.now()
  const orch: Any = prepareOrchestrator(character, { configType: ScoringConfigType.DPS, simulation: sim }, single, {} as Any)
  const prepareMs = Math.round(performance.now() - t0)
  const t1 = performance.now()
  await executeOrchestrator(orch)
  const executeMs = Math.round(performance.now() - t1)
  const t2 = performance.now()
  await executeUpgradeOrchestrator(orch)
  const upgradeMs = Math.round(performance.now() - t2)
  return {
    prepareMs,
    executeMs,
    upgradeMs,
    percent: orch.percent,
    originalSimScore: orch.originalSimResult?.simScore,
    benchmarkSimScore: orch.benchmarkSimScore,
    perfectionSimScore: orch.perfectionSimScore,
    substatUpgrades: orch.substatUpgradeResults?.length,
    setUpgrades: orch.setUpgradeResults?.length,
    mainUpgrades: orch.mainUpgradeResults?.length,
    simulationScoreKeys: orch.simulationScore ? Object.keys(orch.simulationScore) : null,
  }
})

// ───────────────────────── S7: relic scoring ─────────────────────────
await stage('S7_relicScoring', async () => {
  const { RelicScorer } = await import('lib/relics/scoring/relicScorer')
  const { getRelics } = await import('lib/stores/relic/relicStore')
  const relics = getRelics()
  const t0 = performance.now()
  let n = 0
  let sample: Any
  for (const r of relics) {
    const cur = RelicScorer.scoreCurrentRelic(r, TARGET as Any)
    const pot = RelicScorer.scoreRelicPotential(r, TARGET as Any)
    if (!sample) sample = { current: cur, potential: pot }
    n++
  }
  return { scored: n, totalMs: Math.round(performance.now() - t0), sample: JSON.stringify(sample).slice(0, 400) }
})

// ───────────────────────── S8: equip + export save ─────────────────────────
await stage('S8a_equipTopBuild', async () => {
  const equipmentService = await import('lib/services/equipmentService')
  const { getCharacterById } = await import('lib/stores/character/characterStore')
  const before = { ...getCharacterById(TARGET as Any)!.equipped }
  const ids = engineARun.decode(engineARun.rows[0].id)
  equipmentService.equipRelicIds(Object.values(ids) as string[], TARGET as Any)
  const after = getCharacterById(TARGET as Any)!.equipped
  return { changedSlots: Object.keys(after).filter((k) => (after as Any)[k] !== (before as Any)[k]) }
})

await stage('S8b_saveState_save', async () => {
  const { SaveState } = await import('lib/state/saveState')
  const str = SaveState.save()
  const parsed = str ? JSON.parse(str) : null
  return { bytes: str?.length ?? 0, keys: parsed ? Object.keys(parsed) : null }
})

// ───────────────────────── S9: scanner import → mergeRelics ─────────────────────────
await stage('S9_scannerImport_mergeRelics', async () => {
  const { ReliquaryArchiverParser } = await import('lib/importer/importConfig')
  const persistenceService = await import('lib/services/persistenceService')
  const { getRelics } = await import('lib/stores/relic/relicStore')
  const before = getRelics().length
  const scan: Any = {
    source: 'reliquary_archiver',
    build: 'v0.8.0',
    version: 4,
    metadata: { uid: 1, trailblazer: 'Stelle' },
    gacha: { stellar_jade: 0, oneric_shards: 0 },
    materials: [],
    characters: [],
    light_cones: [],
    relics: [{
      set_id: '101',
      name: 'x',
      slot: 'Head',
      rarity: 5,
      level: 15,
      mainstat: 'HP',
      substats: [
        { key: 'CRIT Rate_', value: 5.8, count: 2, step: 3 },
        { key: 'CRIT DMG_', value: 11.6, count: 2, step: 3 },
        { key: 'SPD', value: 4.3, count: 2, step: 1 },
        { key: 'ATK_', value: 7.7, count: 2, step: 2 },
      ],
      location: '',
      lock: false,
      discard: false,
      _uid: '424242',
    }],
  }
  const parsed = ReliquaryArchiverParser.parse(scan)
  persistenceService.mergeRelics(parsed.relics, [])
  await new Promise((r) => setTimeout(r, 300)) // let mergeRelics' trailing dynamic import settle
  return { parsedRelics: parsed.relics.length, before, after: getRelics().length }
})

results.warnings = [...new Set(warnings)].slice(0, 25)
results.rssMb = Math.round(process.memoryUsage().rss / 1e6)
realLog(JSON.stringify(results, null, 2))
process.exit(0)
