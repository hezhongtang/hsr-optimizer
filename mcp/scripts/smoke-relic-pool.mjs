// relicPool on permutations / optimize: a per-run restriction on +0 relics that
// leaves levelled relics, the save and the form alone.
// The sample save has no +0 relics, so the fixture injects three per part with
// known weighted-roll scores, stale +0 copies that share their id with a
// levelled relic (real saves contain such pairs), and a +0 body that is alone
// in its main stat.
// All persistence targets and fixtures stay in a temporary directory.
// Usage: node scripts/smoke-relic-pool.mjs [serverEntry]
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
const targetId = '1212b1'
const PARTS = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope']
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-relic-pool-`)
const sample = JSON.parse(readFileSync(resolve(mcpDir, '../src/data/sample-save.json'), 'utf8'))

// One low roll per substat, so a substat scores exactly its weight: the target's
// saved weights are all 1 and flat stats are scaled to 0.4 upstream. A relic never
// rolls its main stat as a substat, so each list leaves the donor's main stat out.
const LOW_ROLL = {
  'CRIT Rate': 2.592,
  'CRIT DMG': 5.184,
  'Effect Hit Rate': 3.456,
  'Break Effect': 5.184,
  'Effect RES': 3.456,
  'HP': 33.87,
  'ATK': 16.935,
  'DEF': 16.935,
}
const FLAT_STATS = ['HP', 'ATK', 'DEF']
const substatsOf = (stats, mainStat, count) => stats.filter((stat) => stat !== mainStat).slice(0, count).map((stat) => ({ stat, value: LOW_ROLL[stat] }))
const percentSubstats = (mainStat) => substatsOf(['CRIT Rate', 'CRIT DMG', 'Effect Hit Rate', 'Break Effect', 'Effect RES'], mainStat, 4)
const flatSubstats = (mainStat) => substatsOf(FLAT_STATS, mainStat, 3)
// What the gate should see: preview substats count below the main-stat upscale level.
const weightedRolls = (relic) => [...relic.substats, ...relic.previewSubstats].reduce((sum, { stat }) => sum + (FLAT_STATS.includes(stat) ? 0.4 : 1), 0)

const target = sample.characters.find((character) => character.id === targetId)
const worn = new Set(Object.values(target.equipped))
const wornRelic = (part) => sample.relics.find((relic) => relic.part === part && relic.grade === 5 && worn.has(relic.id))
const unleveledCopy = (donor, overrides) => ({ ...structuredClone(donor), enhance: 0, previewSubstats: [], ...overrides })
const injected = []
for (const part of PARTS) {
  const donor = wornRelic(part)
  const mainStat = donor.main.stat
  const clone = (suffix, substats, previewSubstats = []) =>
    unleveledCopy(donor, { id: `pool-${part}-${suffix}`, substats, previewSubstats, equippedBy: undefined })
  const strong = clone('strong', percentSubstats(mainStat))
  // Twenty rolls' worth of CRIT DMG: a +0 relic that is certain to reach the top rows.
  if (part === 'Head') strong.substats.find((substat) => substat.stat === 'CRIT DMG').value = 103.68
  injected.push(
    strong,
    clone('preview', flatSubstats(mainStat), [{ stat: 'Effect RES', value: LOW_ROLL['Effect RES'] }]),
    clone('weak', flatSubstats(mainStat)),
  )
}
// Real saves hold some ids twice: the levelled record and a stale +0 copy of it.
// One such pair for a relic nobody on the target wears, one for a relic the target wears.
const twinOf = sample.relics.find((relic) => relic.part === 'Hands' && relic.grade === 5 && relic.enhance === 15 && !worn.has(relic.id))
injected.push(
  unleveledCopy(twinOf, { substats: flatSubstats(twinOf.main.stat) }),
  unleveledCopy(wornRelic('Feet'), { substats: flatSubstats(wornRelic('Feet').main.stat) }),
)
// A +0 body with a main stat no other body has: a form that asks for it has nothing else to search.
const loneMain = ['Effect Hit Rate', 'Outgoing Healing Boost', 'HP%'].find((stat) =>
  !sample.relics.some((relic) => relic.part === 'Body' && relic.main.stat === stat)
)
assert.ok(loneMain, 'fixture: no unused body main stat in the sample save')
injected.push(
  unleveledCopy(wornRelic('Body'), {
    id: 'pool-Body-lone',
    main: { ...wornRelic('Body').main, stat: loneMain },
    substats: flatSubstats(loneMain),
    equippedBy: undefined,
  }),
)
assert.deepEqual(sample.relics.filter((relic) => relic.enhance === 0), [], 'fixture: the sample save is expected to hold no +0 relics')
sample.relics.push(...injected)
const savePath = `${tempDir}/save.json`
writeFileSync(savePath, JSON.stringify(sample))
// The same inventory with the target's own rope still at +0 and no levelled record of it.
const wornUnleveledPath = `${tempDir}/save-worn-unleveled.json`
wornRelic('LinkRope').enhance = 0
writeFileSync(wornUnleveledPath, JSON.stringify(sample))

const client = new Client({ name: 'smoke-relic-pool', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/state.json` },
  stderr: 'inherit',
})

async function call(name, args = {}, options = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`)
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text)
}

const base = { enhance: 0 }
const permutations = (formOverrides, relicPool) => call('permutations', { characterId: targetId, formOverrides, ...(relicPool && { relicPool }) })
const injectedIn = (rows) => rows.flatMap((row) => Object.values(row.build.relics).map((relic) => relic.id)).filter((id) => id.startsWith('pool-'))

try {
  await client.connect(transport)
  await call('load_save', { path: savePath })
  const inventoryBefore = (await call('list_relics', { limit: 1 })).total

  // ── permutations ──────────────────────────────────────────────────────────
  const everything = await permutations(base)
  const levelledOnly = await permutations({ enhance: 1 })
  assert.ok(everything.validPermutations > levelledOnly.validPermutations, 'fixture: +0 relics must widen the unrestricted space')

  const excluded = await permutations(base, { excludeUnleveled: true })
  assert.deepEqual(excluded.partCounts, levelledOnly.partCounts)
  assert.equal(excluded.validPermutations, levelledOnly.validPermutations)
  assert.deepEqual(excluded.relicPool, {
    excludeUnleveled: true,
    unleveledTotal: injected.length,
    unleveledKept: 0,
    excluded: injected.length,
  })
  console.log('[PASS] excludeUnleveled counts exactly the levelled relics (stale +0 copies go, their levelled records stay, worn or not)')

  // Head has no main-stat filter, so each admitted clone adds one. Gate 1.5 sits
  // between a head's flats with the preview substat (1.8) and without it (0.8),
  // and below what the flats would score unscaled (2).
  for (const gate of [3, 1.5, 0.5]) {
    const admitted = injected.filter((relic) => weightedRolls(relic) >= gate)
    const gated = await permutations(base, { unleveledMinWeightedRolls: gate })
    assert.equal(gated.partCounts.Head, levelledOnly.partCounts.Head + admitted.filter((relic) => relic.part === 'Head').length, `gate ${gate}: Head count`)
    assert.equal(gated.relicPool.unleveledMinWeightedRolls, gate)
    assert.equal(gated.relicPool.unleveledKept, admitted.length, `gate ${gate}: unleveledKept`)
  }
  assert.deepEqual([3, 1.5, 0.5].map((gate) => injected.filter((relic) => relic.part === 'Head' && weightedRolls(relic) >= gate).length), [1, 2, 3])
  console.log('[PASS] unleveledMinWeightedRolls admits +0 relics by weighted rolls (flat scaling and preview substats counted)')

  const open = await permutations(base, { unleveledMinWeightedRolls: 0 })
  assert.equal(open.validPermutations, everything.validPermutations)
  assert.equal(open.relicPool.excluded, 0)
  const noRestriction = await permutations(base, {})
  assert.equal(noRestriction.relicPool, undefined)
  assert.equal(noRestriction.validPermutations, everything.validPermutations)
  console.log('[PASS] gate 0 and an empty relicPool restrict nothing')

  const misspelt = await client.callTool({
    name: 'permutations',
    arguments: { characterId: targetId, formOverrides: base, relicPool: { unleveledMinRolls: 2 } },
  })
  assert.equal(misspelt.isError, true, 'an unknown relicPool key must not pass as "no restriction"')
  const both = await client.callTool({
    name: 'permutations',
    arguments: { characterId: targetId, formOverrides: base, relicPool: { excludeUnleveled: true, unleveledMinWeightedRolls: 2 } },
  })
  assert.equal(both.isError, true)
  assert.match(both.content[0].text, /二选一/)
  console.log('[PASS] excludeUnleveled together with unleveledMinWeightedRolls, and an unknown key, are rejected')

  // ── optimize (CPU) ────────────────────────────────────────────────────────
  const optimize = (formOverrides, relicPool, extra = {}) =>
    call('optimize', { characterId: targetId, formOverrides, resultsLimit: 20, force: true, ...(relicPool && { relicPool }), ...extra }, { timeout: 600_000 })

  const cpuExcluded = await optimize(base, { excludeUnleveled: true })
  const cpuLevelled = await optimize({ enhance: 1 })
  assert.equal(cpuExcluded.status, 'completed')
  assert.equal(cpuExcluded.summary.validPermutations, excluded.validPermutations)
  assert.equal(cpuExcluded.summary.searched, excluded.validPermutations)
  assert.deepEqual(cpuExcluded.relicPool, excluded.relicPool)
  assert.deepEqual(injectedIn(cpuExcluded.rows), [])
  assert.deepEqual(cpuExcluded.rows.map((row) => row.id), cpuLevelled.rows.map((row) => row.id))
  console.log('[PASS] optimize(excludeUnleveled) searches the same space as an enhance floor of 1 and returns the same rows')

  const gate3 = await permutations(base, { unleveledMinWeightedRolls: 3 })
  const cpuGated = await optimize(base, { unleveledMinWeightedRolls: 3 })
  assert.equal(cpuGated.summary.validPermutations, gate3.validPermutations)
  const admitted = new Set(injectedIn(cpuGated.rows))
  assert.ok(admitted.has('pool-Head-strong'), 'the boosted +0 head must reach the result rows')
  assert.ok([...admitted].every((id) => id.endsWith('-strong')), `only strong clones pass gate 3, got ${[...admitted]}`)
  assert.ok(
    cpuGated.rows[0].stats[cpuGated.summary.gridSortColumn] > cpuLevelled.rows[0].stats[cpuLevelled.summary.gridSortColumn],
    'a pool with the strong clones must beat the levelled-only pool',
  )
  console.log('[PASS] optimize(unleveledMinWeightedRolls) searches the gated pool and decodes the admitted +0 relics')

  const validated = await call('optimize', { characterId: targetId, formOverrides: base, validate: true, relicPool: { excludeUnleveled: true } })
  assert.equal(validated.validPermutations, excluded.validPermutations)
  const diagnosed = await call('optimize', { characterId: targetId, formOverrides: base, diagnose: true, relicPool: { unleveledMinWeightedRolls: 3 } })
  assert.equal(diagnosed.status, 'diagnosed')
  assert.equal(diagnosed.validPermutations, gate3.validPermutations)
  assert.deepEqual(diagnosed.relicPool, gate3.relicPool)
  // Only the +0 body carries this main stat: the pool, not the form, is what empties the search.
  const loneBody = { ...base, mainBody: [loneMain], weights: { minWeightedRolls: 0 } }
  assert.ok((await permutations(loneBody)).validPermutations > 0, 'fixture: the lone body must be searchable without a pool')
  const emptied = await call('optimize', { characterId: targetId, formOverrides: loneBody, diagnose: true, relicPool: { excludeUnleveled: true } })
  assert.equal(emptied.validPermutations, 0)
  assert.equal(emptied.partCounts.Body, 0)
  assert.ok(emptied.diagnosis.some((entry) => entry.kind === 'zeroPermutations'), 'a pool that empties a part must reach the zero-permutation diagnosis')
  assert.equal(emptied.relicPool.excluded, injected.length)
  console.log('[PASS] validate and diagnose count the restricted pool, down to zero permutations')

  assert.equal((await call('list_relics', { limit: 1 })).total, inventoryBefore)
  assert.equal((await permutations(base)).validPermutations, everything.validPermutations)
  console.log('[PASS] the inventory and later unrestricted estimates are untouched')

  // ── optimize (GPU, when the managed browser can run it) ───────────────────
  // Skipped only for a missing capability; any other failure of a GPU run is a failure here
  // (a seed that was not pruned shows up as a permutation-count mismatch error).
  const capabilities = await call('get_runtime_capabilities')
  const gpu = async (relicPool) => {
    const result = await client.callTool(
      { name: 'optimize', arguments: { characterId: targetId, formOverrides: base, resultsLimit: 20, force: true, engine: 'gpu', relicPool } },
      undefined,
      { timeout: 600_000 },
    )
    const text = result.content?.[0]?.text ?? ''
    if (result.isError && /WebGPU/.test(text) && /engine=cpu/.test(text)) return { skipped: text.slice(0, 120) }
    assert.ok(!result.isError, `optimize(engine=gpu): ${text}`)
    if (!result.structuredContent.rows) return { skipped: '站点 dist 早于结果钩子,没有结构化结果' }
    return { run: result.structuredContent }
  }
  const gpuExcluded = capabilities.browserReady ? await gpu({ excludeUnleveled: true }) : { skipped: '受管浏览器环境不齐(缺 Chrome 或站点 dist)' }
  if (gpuExcluded.skipped) {
    console.log(`[SKIP] optimize(engine=gpu, relicPool) — ${gpuExcluded.skipped}`)
  } else {
    // The page counts and searches the pruned seed with its own code. Were the CPU
    // leg of the cross-check left unpruned, the boosted +0 head would top its list.
    assert.equal(gpuExcluded.run.summary.validPermutations, excluded.validPermutations)
    assert.deepEqual(gpuExcluded.run.relicPool, excluded.relicPool)
    assert.equal(gpuExcluded.run.comparison.topBuildMatch, true)
    assert.deepEqual(injectedIn(gpuExcluded.run.rows), [])
    assert.equal(gpuExcluded.run.rows[0].id, cpuExcluded.rows[0].id)

    const gpuGated = (await gpu({ unleveledMinWeightedRolls: 3 })).run
    assert.equal(gpuGated.summary.validPermutations, gate3.validPermutations)
    assert.deepEqual(gpuGated.relicPool, gate3.relicPool)
    assert.equal(gpuGated.comparison.topBuildMatch, true)
    // Rows at the cut-off can differ: the GPU ranks by its own float32 values.
    assert.ok(gpuGated.comparison.matchingBuilds >= gpuGated.rows.length - 1, `matchingBuilds ${gpuGated.comparison.matchingBuilds} of ${gpuGated.rows.length}`)
    assert.ok(injectedIn(gpuGated.rows).includes('pool-Head-strong'))
    console.log('[PASS] optimize(engine=gpu, relicPool) agrees with the CPU search of the same pool')
  }

  // ── a +0 relic the target wears, with no levelled record of it ─────────────
  await call('load_save', { path: wornUnleveledPath })
  const wornLevelled = await permutations({ enhance: 1 })
  const wornExcluded = await permutations(base, { excludeUnleveled: true })
  assert.deepEqual(wornExcluded.partCounts, { ...wornLevelled.partCounts, LinkRope: wornLevelled.partCounts.LinkRope + 1 })
  assert.equal(wornExcluded.relicPool.unleveledKept, 1)
  assert.equal(wornExcluded.relicPool.excluded, injected.length)
  console.log('[PASS] a +0 relic the target wears stays in the pool')
} finally {
  await client.close().catch(() => {})
  rmSync(tempDir, { recursive: true, force: true })
}
