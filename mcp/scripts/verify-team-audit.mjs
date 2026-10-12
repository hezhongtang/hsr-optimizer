// team_audit and plan_diff against the tools they are composed from.
// team_audit adds no engine logic, so its numbers must equal what the same
// calls return when made by hand: the checks below repeat the searches with
// optimize / permutations / dps_score and compare. plan_diff is checked by
// loading changed copies of the save and asking which audits went stale.
// The sample save has no +0 relics, so the fixture injects one per part with
// four percent substats, the head one boosted far enough to beat every
// levelled head. CPU engine throughout: no browser needed.
// All persistence targets and fixtures stay in a temporary directory.
// Usage: node scripts/verify-team-audit.mjs [serverEntry]
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
// Everything team_audit may call: none of these writes the save or a form.
const READ_TOOLS = new Set([
  'get_form',
  'get_character',
  'get_scoring_metadata',
  'default_form',
  'permutations',
  'optimize',
  'get_runtime_capabilities',
  'simulate_build',
  'list_relics',
  'list_characters',
  'score_relics',
  'dps_score',
])
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-team-audit-`)
const sample = JSON.parse(readFileSync(resolve(mcpDir, '../src/data/sample-save.json'), 'utf8'))

const LOW_ROLL = { 'CRIT Rate': 2.592, 'CRIT DMG': 5.184, 'Effect Hit Rate': 3.456, 'Break Effect': 5.184, 'Effect RES': 3.456 }
const target = sample.characters.find((character) => character.id === targetId)
const worn = new Set(Object.values(target.equipped))
for (const part of PARTS) {
  const donor = sample.relics.find((relic) => relic.part === part && relic.grade === 5 && worn.has(relic.id))
  const substats = Object.keys(LOW_ROLL).filter((stat) => stat !== donor.main.stat).slice(0, 4).map((stat) => ({ stat, value: LOW_ROLL[stat] }))
  // Twenty rolls' worth of CRIT DMG on the head.
  if (part === 'Head') substats.find((substat) => substat.stat === 'CRIT DMG').value = 103.68
  sample.relics.push({ ...structuredClone(donor), id: `audit-${part}`, enhance: 0, substats, previewSubstats: [], equippedBy: undefined })
}
const write = (name, save) => {
  const path = `${tempDir}/${name}.json`
  writeFileSync(path, JSON.stringify(save))
  return path
}
const savePath = write('save', sample)

// A relic the audit could have used changes, and so does the core's superimposition.
const changed = structuredClone(sample)
// The saved form locks a four-piece set, so only that set's relics are in the audit's scope.
const lockedSet = target.form.relicSets[0][1]
const inScope = changed.relics.find((relic) => relic.part === 'Head' && relic.set === lockedSet && relic.enhance === 15 && !worn.has(relic.id))
assert.ok(inScope, 'fixture: the sample save needs a spare head of the locked set')
inScope.substats[0].value += 1
const changedCore = changed.characters.find((character) => character.id === targetId)
changedCore.form.lightConeSuperimposition = changedCore.form.lightConeSuperimposition === 5 ? 4 : 5
const changedPath = write('save-changed', changed)

// A relic the audit could not have used changes: a body whose main stat the form does not allow.
const unrelated = structuredClone(sample)
const outOfScope = unrelated.relics.find((relic) => relic.part === 'Body' && !target.form.mainBody.includes(relic.main.stat) && relic.equippedBy !== targetId)
assert.ok(outOfScope, 'fixture: the sample save needs a body outside the form\'s main-stat filter')
outOfScope.substats[0].value += 1
const unrelatedPath = write('save-unrelated', unrelated)

const client = new Client({ name: 'verify-team-audit', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/state.json` },
  stderr: 'ignore',
  maxBufferSize: 128 * 1024 * 1024,
})

async function call(name, args = {}, options = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, ...options })
  assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`)
  return result.structuredContent
}
async function errorOf(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })
  assert.equal(result.isError, true, `${name} was expected to fail`)
  return result.content[0].text
}
const topCombo = (optimized) => optimized.rows[0].stats.COMBO
const search = (formOverrides, relicPool) =>
  call('optimize', { characterId: targetId, formOverrides, resultsLimit: 5, force: true, engine: 'cpu', ...(relicPool && { relicPool }) })

try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  for (const name of ['team_audit', 'plan_diff']) assert.ok(tools.some((tool) => tool.name === name), `${name} is not registered`)
  await call('load_save', { path: savePath })
  const saveBytes = readFileSync(savePath)

  const formBefore = await call('get_form', { characterId: targetId })
  const statusBefore = await call('save_status')
  const relicsBefore = (await call('list_relics', { limit: 1 })).total

  // ── tiered ────────────────────────────────────────────────────────────────
  const progress = []
  const audit = await call('team_audit', { characterId: targetId, engine: 'cpu' }, {
    onprogress: (update) => progress.push(update.message),
    resetTimeoutOnProgress: true,
  })
  assert.equal(audit.status, 'completed')
  assert.equal(audit.strategy, 'tiered')
  assert.ok(progress.length > 0, 'a client that sends a progress token gets the stages reported')
  assert.deepEqual(audit.calls.filter((entry) => !READ_TOOLS.has(entry.name)), [])
  console.log('[PASS] team_audit completes with the tiered strategy and calls read-only tools only')

  const levelled = await search(audit.formOverrides, { excludeUnleveled: true })
  assert.equal(audit.comboBest, topCombo(levelled))
  assert.equal(audit.comboNow, levelled.equippedRow.stats.COMBO)
  assert.equal(audit.permutations.final, levelled.summary.validPermutations)
  assert.deepEqual(Object.values(audit.topRows[0].relicIds), PARTS.map((part) => levelled.rows[0].build.relics[part].id))
  const levelledFree = await search({ ...audit.formOverrides, includeEquippedRelics: false }, { excludeUnleveled: true })
  assert.equal(audit.bestConflictFreeRow.combo, topCombo(levelledFree))
  assert.deepEqual(audit.bestConflictFreeRow.swaps.filter((swap) => swap.heldBy != null), [])
  console.log('[PASS] the main list and the conflict-free best equal optimize over the levelled relics')

  const current = (await call('get_character', { characterId: targetId })).equippedSlots
  const differing = PARTS.filter((part) => audit.topRows[0].relicIds[part] !== current[part].equippedId)
  assert.deepEqual(audit.zeroCostSwaps.map((swap) => swap.slot), differing)
  assert.equal(audit.swapSummary.zeroCostSwaps + audit.swapSummary.contestedSwaps + audit.swapSummary.needsLevelingSwaps >= differing.length, true)
  console.log('[PASS] the swap list covers exactly the slots where the best build differs from the equipped one')

  const priority = audit.worthLeveling.variants.priority
  assert.ok(priority.gate != null, `pass 2 did not run: ${priority.skipped}`)
  const gated = await search(audit.formOverrides, { unleveledMinWeightedRolls: priority.gate })
  const candidatePass = audit.passes.find((pass) => pass.pass === 'candidates' && pass.variant === 'priority')
  assert.equal(candidatePass.comboBest, topCombo(gated))
  assert.equal(candidatePass.permutations, gated.summary.validPermutations)
  assert.deepEqual(candidatePass.relicPool, { unleveledMinWeightedRolls: priority.gate })
  assert.equal(priority.bestWithUnleveled.floorCombo, topCombo(gated))
  const head = priority.guaranteed.find((entry) => entry.relicId === 'audit-Head')
  assert.ok(head, 'the boosted +0 head must be listed as a guaranteed upgrade')
  assert.equal(head.standalone, true)
  assert.deepEqual(head.alsoUnleveled, [])
  assert.ok(head.floorCombo > audit.comboBest)
  assert.equal(head.build.Head, 'audit-Head')
  for (const entry of [...priority.guaranteed, ...priority.potential]) {
    assert.ok(entry.relicId.startsWith('audit-'), `${entry.relicId} is not a +0 relic`)
    if (priority.guaranteed.includes(entry)) assert.ok(entry.standalone && entry.floorCombo > priority.leveledBest)
    else assert.ok(entry.floorCombo >= priority.leveledBest * (1 - audit.worthLeveling.tolerance))
  }
  console.log('[PASS] pass 2 equals optimize over the gated pool and lists the +0 relic that beats the levelled best on its own')

  assert.equal(audit.farmAdvice.pieces.length, PARTS.length)
  assert.deepEqual(audit.farmAdvice.pieces.map((piece) => piece.relicId), Object.values(audit.topRows[0].relicIds))
  const scored = await call('score_relics', { characterId: targetId, relicFilters: { part: 'Head' }, limit: 500 })
  const headPiece = audit.farmAdvice.pieces[0]
  assert.equal(headPiece.rating, scored.relics.find((relic) => relic.id === headPiece.relicId).current.rating)
  assert.deepEqual(
    audit.farmAdvice.targets.map((entry) => entry.slot).sort(),
    audit.farmAdvice.pieces.filter((piece) => piece.weak).map((piece) => piece.slot).sort(),
  )
  const dps = await call('dps_score', { characterId: targetId, team: 'default' })
  assert.equal(audit.score.percent, dps.percent)
  console.log('[PASS] farming advice rates the six pieces of the best build as score_relics does; the score equals dps_score')

  assert.deepEqual(audit.roster, [{
    characterId: targetId,
    owned: true,
    characterEidolon: formBefore.form.characterEidolon,
    lightCone: formBefore.form.lightCone,
    lightConeSuperimposition: formBefore.form.lightConeSuperimposition,
  }])
  assert.deepEqual(await call('get_form', { characterId: targetId }), formBefore)
  assert.equal((await call('save_status')).revision, statusBefore.revision)
  assert.equal((await call('list_relics', { limit: 1 })).total, relicsBefore)
  assert.deepEqual(readFileSync(savePath), saveBytes)
  console.log('[PASS] the audit leaves the form, the save revision, the inventory and the save file untouched')

  // ── teammates, and a budget too small for pass 2 ──────────────────────────
  // Bronya: a teammate whose buffs move the target's damage.
  const mate = sample.characters.find((character) => character.id === '1101')
  const teamed = await call('team_audit', { characterId: targetId, engine: 'cpu', budgetSeconds: 0, teammates: [{ characterId: mate.id }] })
  assert.equal(teamed.basis.teammatesSource, 'argument')
  assert.deepEqual(teamed.basis.teammates, [
    {
      characterId: mate.id,
      characterEidolon: mate.form.characterEidolon,
      lightCone: mate.form.lightCone,
      lightConeSuperimposition: mate.form.lightConeSuperimposition,
    },
    null,
    null,
  ])
  assert.deepEqual(teamed.roster.map((entry) => entry.characterId), [targetId, mate.id])
  assert.equal(teamed.roster[1].characterEidolon, mate.form.characterEidolon)
  assert.equal(teamed.roster[1].lightCone, mate.form.lightCone)
  assert.equal(teamed.roster[1].lightConeSuperimposition, mate.form.lightConeSuperimposition)
  assert.notEqual(teamed.comboBest, audit.comboBest)
  assert.ok(teamed.worthLeveling.variants.priority.skipped, 'with no budget pass 2 must be reported as skipped')
  assert.equal(teamed.worthLeveling.variants.priority.gate, null)
  console.log('[PASS] teammates fall back to their saved forms; a spent budget is reported, not silently ignored')

  // ── locked ────────────────────────────────────────────────────────────────
  const locked = await call('team_audit', { characterId: targetId, strategy: 'locked', engine: 'cpu', targetPermutations: 5e5 })
  assert.equal(locked.strategy, 'locked')
  assert.ok(locked.tightenSteps.length > 1, 'a target below the unrestricted space must be tightened towards')
  assert.equal(locked.tightenSteps.filter((step) => step.chosen).length, 1)
  assert.equal(locked.permutations.final, locked.tightenSteps.find((step) => step.chosen).permutations)
  assert.equal(locked.comboBest, topCombo(await search(locked.formOverrides)))
  console.log('[PASS] the locked strategy searches the tightened form it reports')

  // ── rejections and errors ─────────────────────────────────────────────────
  const unusedMain = ['Effect Hit Rate', 'Outgoing Healing Boost'].find((stat) =>
    !sample.relics.some((relic) => relic.part === 'Body' && relic.main.stat === stat)
  )
  const rejected = await call('team_audit', { characterId: targetId, engine: 'cpu', formOverrides: { mainBody: [unusedMain] } })
  assert.equal(rejected.status, 'rejected')
  assert.ok(rejected.reason)
  assert.ok(rejected.diagnosis.length > 0)
  assert.equal(typeof rejected.inventoryFingerprint?.hash, 'string')
  assert.match(await errorOf('team_audit', { characterId: 'no-such-character' }), /no-such-character/)
  assert.match(await errorOf('team_audit', { characterId: targetId, teammates: [{ characterId: '9999' }] }), /lightCone/)
  console.log('[PASS] an empty search space is a rejected audit with a diagnosis; bad input is an error')

  // ── plan_diff ─────────────────────────────────────────────────────────────
  const baselines = [{ ...audit, key: 'tiered' }, { ...locked, key: 'locked' }]
  const same = await call('plan_diff', { audits: baselines })
  assert.deepEqual(same.affected, [])
  assert.deepEqual(same.unaffected, ['tiered', 'locked'])
  assert.equal(same.audits[0].relics.current.hash, audit.inventoryFingerprint.hash)
  assert.equal(same.audits[0].relics.current.relicCount, audit.inventoryFingerprint.relicCount)

  await call('load_save', { path: unrelatedPath })
  assert.deepEqual((await call('plan_diff', { audits: baselines })).affected, [])

  await call('load_save', { path: changedPath })
  const stale = await call('plan_diff', { audits: baselines })
  assert.deepEqual(stale.affected, ['tiered', 'locked'])
  for (const entry of stale.audits) {
    assert.deepEqual(entry.reasons, ['relicsChanged', 'rosterChanged'])
    assert.deepEqual(entry.rosterChanges, [{
      characterId: targetId,
      field: 'lightConeSuperimposition',
      baseline: formBefore.form.lightConeSuperimposition,
      current: changedCore.form.lightConeSuperimposition,
    }])
  }
  const bare = await call('plan_diff', { audits: [{ characterId: targetId, inventoryFingerprint: audit.inventoryFingerprint }] })
  assert.deepEqual(bare.audits[0].reasons, ['relicsChanged'])
  assert.equal(bare.audits[0].rosterCompared, false)
  assert.equal(bare.audits[0].key, `${targetId}#0`)
  if (stale.engine.gitCommit != null) {
    const moved = await call('plan_diff', { audits: [{ ...audit, engine: { gitCommit: '0'.repeat(40) } }] })
    assert.ok(moved.audits[0].reasons.includes('engineChanged'))
  } else if (stale.engine.serverBuiltAt != null) {
    const moved = await call('plan_diff', { audits: [{ ...audit, engine: { gitCommit: null, serverBuiltAt: '1970-01-01T00:00:00.000Z' } }] })
    assert.ok(moved.audits[0].reasons.includes('engineChanged'))
  }
  await call('load_save', { path: savePath })
  const tampered = structuredClone(audit)
  assert.ok(tampered.inventoryFingerprint.savedOwnership.characterOrder.length > 1)
  tampered.inventoryFingerprint.savedOwnership.characterOrder = [...tampered.inventoryFingerprint.savedOwnership.characterOrder].reverse()
  const rankMoved = await call('plan_diff', { audits: [{ ...tampered, key: 'rank' }] })
  assert.deepEqual(rankMoved.audits[0].reasons, ['ownershipChanged'])
  console.log('[PASS] plan_diff flags an audit when a relic in its scope, a member\'s build or the engine changed, and only then')
} finally {
  await client.close().catch(() => {})
  rmSync(tempDir, { recursive: true, force: true })
}
console.log('verify-team-audit: ALL CHECKS PASSED')
