// End-to-end smoke for the M6 analysis surface: analyze_relic (insights /
// location / reroll), optimize's validate / diagnose / applyFixes modes,
// resultsLimit, get_results(rowIds), analyze_build/simulate_build fromCache
// (the run's form snapshot — an E6-override run must analyse at E6 while the
// plain saved form differs), and benchmark_runs(sweep="sets").
//
// Spawns the built server over stdio against a temp copy of the sample save
// (the repo file is never a write target).
//
// Usage: node scripts/smoke-analysis.mjs [serverEntry]

import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const TARGET = '1212b1' // Jingliu
const OTHER = '1101'
const EQUIPPED_HEAD = 'cd85c14c-a662-4413-a149-a379e6d538d3' // Jingliu's Head in the sample save

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-analysis-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

async function errorTextOf(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  return result.isError ? (result.content?.[0]?.text ?? '') : null
}

async function getForm(client, characterId) {
  return callTool(client, 'get_form', { characterId })
}

try {
  const client = new Client({ name: 'smoke-analysis', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/state.json` },
    stderr: 'inherit',
  })
  await client.connect(transport)

  const tools = await client.listTools()
  check('tool analyze_relic registered', tools.tools.map((t) => t.name).includes('analyze_relic'))
  await callTool(client, 'load_save', { path: sampleSavePath })

  // ── 1. analyze_relic view=characters ─────────────────────────────────────
  const insights = await callTool(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'characters' })
  const ins = insights.characters
  check(
    'insights considers multiple characters',
    ins.considered > 1 && ins.characters.length >= 1 && ins.characters.length <= ins.considered,
    `characters=${ins.characters.length}/${ins.considered}`,
  )
  const pot = (c) => (ins.bucketMode === 'average' ? c.potential.averagePct : c.potential.bestPct)
  check(
    'insights potentials are finite and sorted descending',
    ins.characters.every((c) => Number.isFinite(pot(c)))
      && ins.characters.every((c, i) => i === 0 || pot(ins.characters[i - 1]) >= pot(c)),
    ins.characters.slice(0, 3).map((c) => `${c.id}:${pot(c).toFixed(1)}`).join(' '),
  )
  check(
    'every listed character sits in its bucket (buckets partition the listed set)',
    ins.buckets.length > 0
      && ins.characters.every((c) => ins.buckets[c.bucketIndex]?.characterIds.includes(c.id) === true)
      && ins.buckets.reduce((sum, b) => sum + b.characterIds.length, 0) === ins.characters.length
      // considered counts every eligible character; the web filters bestPct<=0
      // entries out of the listed set (RelicInsightsPanel's own `.filter`)
      && ins.considered >= ins.characters.length,
    `${ins.buckets.reduce((sum, b) => sum + b.characterIds.length, 0)} bucketed / ${ins.characters.length} listed / ${ins.considered} considered`,
  )
  const narrowed = await callTool(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'characters', characterIds: [TARGET, OTHER] })
  check('characterIds narrows the candidate set', narrowed.characters.considered === 2, `considered=${narrowed.characters.considered}`)

  // ── 2. analyze_relic view=location ───────────────────────────────────────
  const location1 = await callTool(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'location' })
  const location2 = await callTool(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'location' })
  check(
    'location view is deterministic and carries the grid settings',
    JSON.stringify(location1) === JSON.stringify(location2)
      && location1.location.inventoryWidth >= 1 && location1.location.rowLimit >= 1,
    `width=${location1.location.inventoryWidth} rows=${location1.location.rowLimit}`,
  )
  const locationTuned = await callTool(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'location', inventoryWidth: 5, rowLimit: 3 })
  check('location honors explicit width/rowLimit', locationTuned.location.inventoryWidth === 5 && locationTuned.location.rowLimit === 3)

  // ── 3. analyze_relic view=reroll ─────────────────────────────────────────
  const equipped = (await callTool(client, 'list_relics', { limit: 500 })).relics.find((r) => r.id === EQUIPPED_HEAD)
  const rerollSubstats = equipped.substats.map((s, i) => (i === 0 ? { stat: s.stat, value: s.value + 1 } : { stat: s.stat, value: s.value }))
  const reroll1 = await callTool(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'reroll', rerollSubstats })
  const reroll2 = await callTool(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'reroll', rerollSubstats })
  // durationMs is wall-clock noise — everything else must be identical
  const stripTiming = (payload) => {
    const { durationMs: _drop, ...rest } = payload
    return rest
  }
  check('reroll comparison is deterministic', JSON.stringify(stripTiming(reroll1)) === JSON.stringify(stripTiming(reroll2)))
  check(
    'reroll view carries before/after payloads',
    reroll1.reroll != null && JSON.stringify(reroll1.reroll).length > 10,
    Object.keys(reroll1.reroll ?? {}).join(','),
  )
  check(
    'reroll does not mutate the inventory',
    (await callTool(client, 'list_relics', { limit: 500 })).relics.find((r) => r.id === EQUIPPED_HEAD).substats[0].value === equipped.substats[0].value,
  )
  const noRerollErr = await errorTextOf(client, 'analyze_relic', { relicId: EQUIPPED_HEAD, view: 'reroll' })
  check(
    'view=reroll without rerollSubstats rejected (Chinese)',
    noRerollErr != null && noRerollErr.includes('rerollSubstats'),
    String(noRerollErr).slice(0, 90),
  )
  const unknownRelicErr = await errorTextOf(client, 'analyze_relic', { relicId: 'no-such-relic', view: 'characters' })
  check('unknown relicId rejected (Chinese)', unknownRelicErr != null && unknownRelicErr.includes('不存在'), String(unknownRelicErr).slice(0, 90))

  // ── 4. optimize validate=true (no search) ────────────────────────────────
  const revBefore = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  const validated = await callTool(client, 'optimize', { characterId: TARGET, validate: true })
  check(
    'validate=true runs the form checks without a search',
    Array.isArray(validated.errors) && validated.errors.length === 0 && validated.cacheId == null && validated.rows == null,
    `errors=${validated.errors?.length} cacheId=${validated.cacheId ?? 'none'}`,
  )
  const revAfterValidate = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  check('validate is read-only (revision unchanged)', revAfterValidate === revBefore, `${revBefore} → ${revAfterValidate}`)
  const bothModesErr = await errorTextOf(client, 'optimize', { characterId: TARGET, validate: true, diagnose: true })
  check('validate + diagnose together rejected', bothModesErr != null && /互斥|至多传一个/.test(bothModesErr), String(bothModesErr).slice(0, 90))

  // ── 5. diagnose on an impossible speed filter ────────────────────────────
  const impossible = { statFilters: { minSpd: 999 } }
  const diagnosed = await callTool(client, 'optimize', { characterId: TARGET, diagnose: true, formOverrides: impossible })
  check(
    'diagnose reports suggestions for a zero-permutation form without searching',
    Array.isArray(validated.errors) && (diagnosed.diagnosis?.length ?? 0) > 0 && diagnosed.cacheId == null,
    `suggestions=${diagnosed.diagnosis?.length}`,
  )

  // ── 6. applyFixes relaxes the SAVED form (transactional) ─────────────────
  // applyFixes runs its fixes against the character's saved form (the web modal
  // fixes what the grid shows), so the offending filters must be persisted via
  // update_form first — formOverrides only affect the diagnose estimate above.
  // Two different root-cause families:
  //   a) minSpd 999 = zero-RESULT cause (stat filters never enter the combo
  //      estimate — the web's validPermutations counts parts/sets, not stats);
  //      the fix clears the impossible filter.
  //   b) a 4pc set filter nobody owns = zero-PERMUTATION cause; the estimate
  //      drops to 0 and the fix clears set filters, lifting it back.
  await callTool(client, 'update_form', { characterId: TARGET, patch: { minSpd: 999 } })
  const fixedStat = await callTool(client, 'optimize', { characterId: TARGET, applyFixes: true })
  check(
    'applyFixes clears an impossible stat filter (zero-result family)',
    (fixedStat.applied?.length ?? 0) > 0 && fixedStat.applied.some((a) => a.kind === 'zeroResults'),
    `applied=${fixedStat.applied?.map((a) => a.cause).join(',')}`,
  )
  const formAfterStatFix = await getForm(client, TARGET)
  check('the fixed form no longer carries the impossible filter', (formAfterStatFix.form.minSpd ?? 0) < 999, `minSpd=${formAfterStatFix.form.minSpd}`)

  await callTool(client, 'update_form', { characterId: TARGET, patch: { relicSets: [['4 Piece', 'Poet of Mourning Collapse']] } })
  const zeroDiagnosed = await callTool(client, 'optimize', { characterId: TARGET, diagnose: true })
  check('a 4pc set nobody owns drives the estimate to zero permutations', zeroDiagnosed.validPermutations === 0, `valid=${zeroDiagnosed.validPermutations}`)
  const fixedSets = await callTool(client, 'optimize', { characterId: TARGET, applyFixes: true })
  check(
    'applyFixes lifts valid permutations after clearing the set filter (zero-permutation family)',
    (fixedSets.applied?.length ?? 0) > 0
      && fixedSets.permutations.after > 0 && fixedSets.permutations.before === 0
      && fixedSets.applied.some((a) => a.kind === 'zeroPermutations'),
    `applied=${fixedSets.applied?.map((a) => a.cause).join(',')} perms ${fixedSets.permutations.before} → ${fixedSets.permutations.after}`,
  )
  // The baseRevision gate lives inside withChange, which only runs when there
  // IS something to fix — re-apply the offending filter first so the stale
  // probe actually reaches the conflict check.
  await callTool(client, 'update_form', { characterId: TARGET, patch: { minSpd: 999 } })
  const staleErr = await errorTextOf(client, 'optimize', {
    characterId: TARGET,
    applyFixes: true,
    baseRevision: Math.max(0, (await callTool(client, 'get_state', { section: 'revision' })).revision.revision - 1),
  })
  check('applyFixes with a stale baseRevision conflicts (Chinese)', staleErr != null && staleErr.includes('修订号冲突'), String(staleErr).slice(0, 90))
  const formAfterConflict = await getForm(client, TARGET)
  check(
    'the conflicted applyFixes left the filter in place (nothing landed)',
    formAfterConflict.form.minSpd > 900,
    `minSpd=${formAfterConflict.form.minSpd} (999 normalizes to 998.9999 through the display round-trip)`,
  )
  await callTool(client, 'optimize', { characterId: TARGET, applyFixes: true }) // clean up for the next section

  // ── 7. resultsLimit caps the returned rows ───────────────────────────────
  const capped = await callTool(client, 'optimize', { characterId: TARGET, resultsLimit: 7 }, { timeout: 300_000 })
  check(
    'resultsLimit=7 caps the rows',
    capped.rows.length === 7 && capped.summary?.cacheId != null,
    `rows=${capped.rows.length} cacheId=${capped.summary?.cacheId}`,
  )

  // ── 8. get_results(rowIds) pinned selection ──────────────────────────────
  // Row ids are result ids (not indices) — pin two ids straight from the run.
  const pinnedIds = [capped.rows[0].id, capped.rows[2].id]
  const pinned = await callTool(client, 'get_results', { rowIds: pinnedIds })
  check(
    'rowIds returns exactly those rows with build details',
    pinned.rows.length === 2 && pinned.rows.every((row) => pinnedIds.includes(row.id) && Object.values(row.build?.relics ?? {}).filter(Boolean).length === 6),
    pinned.rows.map((row) => `${row.id}:${Object.values(row.build?.relics ?? {}).filter(Boolean).length} build keys`).join(' '),
  )
  const badRowErr = await errorTextOf(client, 'get_results', { rowIds: [999999] })
  check('unknown rowIds rejected (Chinese)', badRowErr != null && /不存在|无效/.test(badRowErr), String(badRowErr).slice(0, 90))

  // ── 8b. analyze_build / simulate_build fromCache (optimizer.analysis.read) ─
  // The web analysis runs against the form THE RUN used (getCachedForm) — here
  // proven with an eidolon-6 override: the fromCache analysis must reflect the
  // run's merged form, while the same build analysed against the plain saved
  // form must differ. simulate_build(fromCache) on the same row must agree
  // exactly with analyze_build's new-side COMBO (same form + build pipeline).
  const optE6 = await callTool(client, 'optimize', {
    characterId: TARGET,
    resultsLimit: 7,
    formOverrides: { characterEidolon: 6 },
  }, { timeout: 300_000 })
  const e6CacheId = optE6.summary?.cacheId
  const e6RowId = optE6.rows[0].id
  // serializeBuild returns per-part SerializedRelic objects — take their ids
  const e6BuildIds = Object.values(optE6.rows[0].build?.relics ?? {}).map((r) => r.id).filter(Boolean)
  check(
    'fromCache fixture: E6-override optimize run cached with a 6-slot row build',
    e6CacheId != null && e6BuildIds.length === 6,
    `cacheId=${e6CacheId}, build=${e6BuildIds.length}`,
  )

  const anaE6 = await callTool(client, 'analyze_build', {
    characterId: TARGET,
    fromCache: { cacheId: e6CacheId, rowId: e6RowId },
  }, { timeout: 300_000 })
  check(
    'analyze_build fromCache echoes the reference and takes the row build as the candidate',
    anaE6.fromCache?.cacheId === e6CacheId && anaE6.fromCache?.rowId === e6RowId
      && Object.values(anaE6.builds.new.relicIds).length === 6,
    `rowId=${anaE6.fromCache?.rowId}, new=${Object.keys(anaE6.builds.new.relicIds).length} parts`,
  )

  const simE6 = await callTool(client, 'simulate_build', {
    characterId: TARGET,
    fromCache: { cacheId: e6CacheId, rowId: e6RowId },
    trace: true,
  }, { timeout: 300_000 })
  const comboAna = anaE6.combo.new.damage
  const comboSim = simE6.stats.combo.damage
  check(
    'fromCache form+build consistency: simulate_build(fromCache) COMBO equals analyze_build new-side COMBO',
    simE6.fromCache?.rowId === e6RowId && Math.abs(comboSim - comboAna) <= 1e-6 * Math.max(1, Math.abs(comboAna)),
    `sim=${Math.round(comboSim)} vs analysis new=${Math.round(comboAna)}`,
  )

  const anaSaved = await callTool(client, 'analyze_build', {
    characterId: TARGET,
    newRelicIds: e6BuildIds,
  }, { timeout: 300_000 })
  check(
    'analyze_build fromCache uses the RUN\'s form (E6) — same build against the saved form differs',
    Math.abs(anaSaved.combo.new.damage - comboAna) > 1,
    `E6 run form ${Math.round(comboAna)} vs saved form ${Math.round(anaSaved.combo.new.damage)}`,
  )

  const badCacheErr = await errorTextOf(client, 'analyze_build', {
    characterId: TARGET,
    fromCache: { cacheId: 'bench-nope', rowId: 0 },
    newRelicIds: e6BuildIds,
  })
  check('fromCache with an unknown cacheId rejected (Chinese)', badCacheErr != null && badCacheErr.includes('fromCache'), String(badCacheErr).slice(0, 90))
  const noBuildErr = await errorTextOf(client, 'analyze_build', { characterId: TARGET })
  check(
    'analyze_build without newRelicIds and without fromCache.rowId rejected (Chinese)',
    noBuildErr != null && noBuildErr.includes('newRelicIds'),
    String(noBuildErr).slice(0, 90),
  )
  const bothErr = await errorTextOf(client, 'simulate_build', { characterId: TARGET, relicIds: e6BuildIds, fromCache: { cacheId: e6CacheId, rowId: e6RowId } })
  check(
    'simulate_build relicIds + fromCache.rowId rejected as mutually exclusive (Chinese)',
    bothErr != null && /互斥/.test(bothErr),
    String(bothErr).slice(0, 90),
  )

  // ── 9. benchmark_runs(sweep=sets) ────────────────────────────────────────
  const swept = await callTool(client, 'benchmark_runs', {
    characterId: TARGET,
    sweep: 'sets',
    sweepOptions: { setTypes: ['relic4p'], spdBreakpoints: [0], modes: ['dps'], errRope: ['noErr'], scoringModes: ['benchmark'] },
  }, { timeout: 600_000 })
  check(
    'sweep=sets completes the grid and returns summaries',
    swept.sweep === 'sets' && swept.cancelled === false && (swept.summaries?.length ?? 0) > 0 && swept.config != null,
    `summaries=${swept.summaries?.length} jobId=${swept.jobId ?? 'none'}`,
  )
  const flagged = swept.summaries.filter((summary) => summary.flag === 'red' || summary.flag === 'yellow')
  check(
    'summaries carry reference deltas and flags',
    swept.summaries.every((summary) => Number.isFinite(summary.bestDelta) && summary.results.length > 0)
      && swept.summaries.every((summary) => summary.results.every((row) => Number.isFinite(row.score))),
    `flagged=${flagged.length}/${swept.summaries.length}`,
  )
  const jobList = await callTool(client, 'get_job', {})
  check(
    'the sweep registered a job',
    (jobList.jobs ?? []).some((job) => job.jobId === swept.jobId),
    `jobId=${swept.jobId}`,
  )

  await client.close()
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nsmoke-analysis: ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nsmoke-analysis: ALL CHECKS PASSED')
