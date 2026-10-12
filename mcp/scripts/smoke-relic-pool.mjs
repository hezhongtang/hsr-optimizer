// relicPool on permutations / optimize: a per-run restriction on +0 relics that
// leaves levelled relics, the save and the form alone.
// The sample save has no +0 relics, so the fixture injects three per part with
// known weighted-roll scores, plus a stale +0 twin that shares its id with a
// levelled relic (real saves contain such pairs).
// All persistence targets and fixtures stay in a temporary directory.
// Usage: node scripts/smoke-relic-pool.mjs [serverEntry]
import assert from 'node:assert/strict'
import {
  existsSync,
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

// Low-roll values: one roll each, so a substat scores exactly its weight (the
// target's saved weights are all 1; flat stats are scaled to 0.4 upstream).
const percentSubstats = (boosted) => [
  { stat: 'CRIT Rate', value: 2.592 },
  { stat: 'CRIT DMG', value: boosted ? 103.68 : 5.184 },
  { stat: 'Effect Hit Rate', value: 3.456 },
  { stat: 'Break Effect', value: 5.184 },
]
const flatSubstats = [
  { stat: 'HP', value: 33.87 },
  { stat: 'ATK', value: 16.935 },
  { stat: 'DEF', value: 16.935 },
]
// A relic cannot roll its main stat as a substat, and the engines disagree on one
// that does (the CPU adds both, the GPU keeps the main stat only). The clashing
// substat is dropped and the next one takes its roll, so the weighted rolls stay
// what the lists above add up to.
const withoutMainStat = (substats, mainStat) => {
  const kept = substats.filter((substat) => substat.stat !== mainStat)
  if (kept.length < substats.length) kept[0] = { ...kept[0], value: kept[0].value * 2 }
  return kept
}
const target = sample.characters.find((character) => character.id === targetId)
const worn = new Set(Object.values(target.equipped))
const injected = []
for (const part of PARTS) {
  const donor = sample.relics.find((relic) => relic.part === part && relic.grade === 5 && worn.has(relic.id))
  const unleveled = (suffix, substats, previewSubstats = []) => ({
    ...structuredClone(donor),
    id: `pool-${part}-${suffix}`,
    enhance: 0,
    substats: withoutMainStat(substats, donor.main.stat),
    previewSubstats,
    equippedBy: undefined,
  })
  injected.push(
    // 4 weighted rolls; the Head one carries twenty rolls' worth of CRIT DMG so that a +0
    // relic is certain to reach the top rows.
    unleveled('strong', percentSubstats(part === 'Head')),
    // 3 × 0.4 from the flats, plus one for the preview substat = 2.2.
    unleveled('preview', flatSubstats, [{ stat: 'Effect RES', value: 3.456 }]),
    // 1.2.
    unleveled('weak', flatSubstats),
  )
}
// The stale twin: same id as a levelled relic nobody wears, still +0.
const twinOf = sample.relics.find((relic) => relic.part === 'Hands' && relic.grade === 5 && relic.enhance === 15 && !worn.has(relic.id))
injected.push({ ...structuredClone(twinOf), enhance: 0, substats: withoutMainStat(flatSubstats, twinOf.main.stat), previewSubstats: [] })
sample.relics.push(...injected)
const savePath = `${tempDir}/save.json`
writeFileSync(savePath, JSON.stringify(sample))

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
  console.log('[PASS] excludeUnleveled counts exactly the levelled relics (the levelled twin of a duplicated id stays)')

  // Head has no main-stat filter, so each admitted clone adds one.
  for (const [gate, admittedPerPart] of [[3, 1], [2, 2], [1, 3]]) {
    const gated = await permutations(base, { unleveledMinWeightedRolls: gate })
    assert.equal(gated.partCounts.Head, levelledOnly.partCounts.Head + admittedPerPart, `gate ${gate}: Head count`)
    assert.equal(gated.relicPool.unleveledMinWeightedRolls, gate)
    // The stale twin scores 1.2: admitted from gate 1 down.
    assert.equal(gated.relicPool.unleveledKept, PARTS.length * admittedPerPart + (gate <= 1 ? 1 : 0), `gate ${gate}: unleveledKept`)
  }
  console.log('[PASS] unleveledMinWeightedRolls admits +0 relics by weighted rolls (flat scaling and preview substats counted)')

  const open = await permutations(base, { unleveledMinWeightedRolls: 0 })
  assert.equal(open.validPermutations, everything.validPermutations)
  assert.equal(open.relicPool.excluded, 0)
  const noRestriction = await permutations(base, {})
  assert.equal(noRestriction.relicPool, undefined)
  assert.equal(noRestriction.validPermutations, everything.validPermutations)
  console.log('[PASS] gate 0 and an empty relicPool restrict nothing')

  const both = await client.callTool({
    name: 'permutations',
    arguments: { characterId: targetId, formOverrides: base, relicPool: { excludeUnleveled: true, unleveledMinWeightedRolls: 2 } },
  })
  assert.equal(both.isError, true)
  assert.match(both.content[0].text, /二选一/)
  console.log('[PASS] excludeUnleveled together with unleveledMinWeightedRolls is rejected')

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
  const rejected = await call('optimize', {
    characterId: targetId,
    formOverrides: { ...base, mainBody: [], mainFeet: [], mainPlanarSphere: [], mainLinkRope: [], rankFilter: false, weights: { minWeightedRolls: 0 } },
    relicPool: { unleveledMinWeightedRolls: 1 },
    diagnose: true,
  })
  assert.equal(rejected.relicPool.unleveledMinWeightedRolls, 1)
  console.log('[PASS] validate and diagnose count the restricted pool')

  assert.equal((await call('list_relics', { limit: 1 })).total, inventoryBefore)
  assert.equal((await permutations(base)).validPermutations, everything.validPermutations)
  console.log('[PASS] the inventory and later unrestricted estimates are untouched')

  // ── optimize (GPU, when the managed browser can run it) ───────────────────
  const gpuCall = existsSync(resolve(mcpDir, '../dist/index.html'))
    ? await client.callTool(
      {
        name: 'optimize',
        arguments: { characterId: targetId, formOverrides: base, resultsLimit: 20, force: true, engine: 'gpu', relicPool: { unleveledMinWeightedRolls: 3 } },
      },
      undefined,
      { timeout: 600_000 },
    )
    : null
  if (gpuCall == null || gpuCall.isError) {
    console.log(`[SKIP] optimize(engine=gpu, relicPool) — ${gpuCall ? gpuCall.content?.[0]?.text?.slice(0, 120) : '站点 dist 不存在'}`)
  } else if (!gpuCall.structuredContent.rows) {
    console.log('[SKIP] optimize(engine=gpu, relicPool) — 站点 dist 早于结果钩子,没有结构化结果')
  } else {
    const gpu = gpuCall.structuredContent
    // The page counts and searches the pruned seed with its own code; a pool
    // that differed from the estimate would already have failed the run.
    assert.equal(gpu.summary.validPermutations, gate3.validPermutations)
    assert.deepEqual(gpu.relicPool, gate3.relicPool)
    assert.equal(gpu.comparison.topBuildMatch, true)
    // Rows at the cut-off can differ: the GPU ranks by its own float32 values.
    assert.ok(gpu.comparison.matchingBuilds >= gpu.rows.length - 1, `matchingBuilds ${gpu.comparison.matchingBuilds} of ${gpu.rows.length}`)
    assert.ok(injectedIn(gpu.rows).includes('pool-Head-strong'))
    console.log('[PASS] optimize(engine=gpu, relicPool) agrees with the CPU search of the same pool')
  }
} finally {
  await client.close().catch(() => {})
  rmSync(tempDir, { recursive: true, force: true })
}
