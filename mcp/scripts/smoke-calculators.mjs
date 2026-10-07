// End-to-end smoke test for the calculators trio extensions + language /
// sample-archive surface (M6-C):
//
// Spawns the built server over stdio and walks:
//   load_save (temp copy)
//   → calc_aha: reverse solve vs the web's acceptance numbers (180/135 → 110),
//     forward re-verification of the solved config, alreadyMet / noSlots
//     statuses, save=true draft roundtrip (fromSaved read-back + structured
//     snapshot ahaSpeedTuner), Chinese missing-input error, no-regression on
//     the plain speeds path (no new payload keys)
//   → calc_ehr: default reverse mode unchanged (25% oracle), mode=probability
//     single + cumulative hand fixtures (90% / 99.9%), unreachable inputs
//     still report achievable=false, mode=grid shape (21×9 at default range,
//     center-row snapping at EHR 52, ±2 rows at range 10), cell oracles
//     against the hand formula, non-multiple-of-10 range rejection
//   → warp_plan: applyPlannerMode=true swaps in the quick-combined E6S5 target
//     and diverges from the same request computed as multi, default
//     plannerMode is simple, normalizeTargets chains same-character /
//     same-light-cone goals head-to-tail and seeds a new character goal from
//     the save's owned eidolon, save=true roundtrips warpRequest through the
//     structured snapshot and a fromSaved replay
//   → update_state(session language) roundtrip (preference switches, the
//     process render language does not, the value survives a save reload and
//     never leaks into savedSession.global), invalid locale rejected with the
//     legal enum
//   → load_save(sample=true): loads the web's built-in sample (counts equal
//     the repository file), replaces prior state, mutually exclusive with path
//   → revision stability: pure calculator calls never bump the revision
//
// Everything persists into a temp directory (save copy + HSR_MCP_STATE_FILE);
// the repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-calculators.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  existsSync,
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

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-calculators-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

// Pinned expectations are computed from the very file the server also loads,
// so the oracle and the server can never drift apart on sample content.
const sampleJson = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
const sampleCharacterWithEidolon = sampleJson.characters.find((c) => (c.form?.characterEidolon ?? -1) > 0)
  ?? sampleJson.characters[0]
const ownedEidolon = sampleCharacterWithEidolon.form?.characterEidolon ?? -1

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

async function expectToolError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

function closeEnough(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) <= epsilon
}

// Hand mirror of the upstream forward grid formula (ehrCalculations.ts):
// rate% = clamp(0, 100, 100 × (base/100) × (1+ehr/100) × (1-res/100) × (1-debuff/100))
function mirrorGridRate({ baseChance, ehr, effectRes, debuffRes }) {
  const raw = 100 * (baseChance / 100) * (1 + ehr / 100) * (1 - effectRes / 100) * (1 - debuffRes / 100)
  return Math.round(Math.min(100, Math.max(0, raw)))
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-calculators', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  // ── 1. load the sample save (temp copy — write-backs target it) ───────────
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save(path) characters match the sample file', loaded.characters === sampleJson.characters.length, `${loaded.characters}`)

  const revisionBefore = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision

  // ── 2. calc_aha reverse solve ↔ web acceptance numbers ───────────────────
  const solveRun = await callTool(client, 'calc_aha', { speeds: [180, 135], desiredAha: 135 })
  check(
    'calc_aha solve: 180/135 → third teammate needs 110 (web acceptance)',
    solveRun.solve?.status === 'solved' && closeEnough(solveRun.solve.requiredSpeed, 110) && solveRun.solve.nextTeammatePosition === 3,
    JSON.stringify(solveRun.solve),
  )
  check('calc_aha solve keeps the forward block intact', closeEnough(solveRun.ahaSpeed, 129.5) && solveRun.contributions.length === 2)

  // Forward re-verification: adding the solved speed reaches the target.
  const verified = await callTool(client, 'calc_aha', { speeds: [180, 135, 110] })
  check(
    'calc_aha solved config forward-verifies to the target',
    closeEnough(verified.ahaSpeed, 135) && verified.ahaSpeed >= 135,
    `${verified.ahaSpeed}`,
  )

  const alreadyMet = await callTool(client, 'calc_aha', { speeds: [180, 135], desiredAha: 129 })
  check(
    'calc_aha solve alreadyMet when current speed ≥ target',
    alreadyMet.solve?.status === 'alreadyMet' && alreadyMet.solve.requiredSpeed !== null,
    JSON.stringify(alreadyMet.solve),
  )
  const noSlots = await callTool(client, 'calc_aha', { speeds: [180, 160, 140, 120], desiredAha: 200 })
  check(
    'calc_aha solve noSlots with 4 filled slots (null, not a number)',
    noSlots.solve?.status === 'noSlots' && noSlots.solve.requiredSpeed === null,
    JSON.stringify(noSlots.solve),
  )

  const missingSpeeds = await expectToolError(client, 'calc_aha', {})
  check('calc_aha without speeds/fromSaved errors (Chinese)', missingSpeeds.includes('缺少队友速度'), missingSpeeds.slice(0, 90))

  // ── 3. calc_aha save=true draft roundtrip ────────────────────────────────
  const ahaSaved = await callTool(client, 'calc_aha', { speeds: [160, 120, 100], desiredAha: 140, save: true })
  check(
    'calc_aha save=true echoes the written draft',
    ahaSaved.draft?.teammate0 === 160 && ahaSaved.draft?.teammate1 === 120 && ahaSaved.draft?.teammate2 === 100
      && ahaSaved.draft?.teammate3 === '' && ahaSaved.draft?.desiredAha === 140,
    JSON.stringify(ahaSaved.draft),
  )
  const ahaFromSaved = await callTool(client, 'calc_aha', { fromSaved: true })
  check(
    'calc_aha fromSaved reads the draft back (same speeds + solve)',
    JSON.stringify(ahaFromSaved.speeds) === JSON.stringify([160, 120, 100])
      && ahaFromSaved.solve?.targetAhaSpeed === 140,
    JSON.stringify(ahaFromSaved.speeds),
  )
  const snapshot1 = await callTool(client, 'export_save', { structured: true })
  check(
    'saved aha draft lands in the archive key ahaSpeedTuner',
    JSON.stringify(snapshot1.snapshot.ahaSpeedTuner) === JSON.stringify({
      teammate0: 160,
      teammate1: 120,
      teammate2: 100,
      teammate3: '',
      desiredAha: 140,
    }),
    JSON.stringify(snapshot1.snapshot.ahaSpeedTuner),
  )
  // desiredAha omitted on save → the draft's existing value is preserved
  const ahaKeep = await callTool(client, 'calc_aha', { speeds: [111], save: true })
  check(
    'calc_aha save without desiredAha keeps the stored target',
    ahaKeep.draft?.desiredAha === 140 && ahaKeep.draft?.teammate0 === 111 && ahaKeep.draft?.teammate1 === '',
    JSON.stringify(ahaKeep.draft),
  )
  const negativeSave = await expectToolError(client, 'calc_aha', { speeds: [-5], save: true })
  check('calc_aha save rejects negative speeds (Chinese)', negativeSave.includes('不能为负'), negativeSave.slice(0, 90))
  const tooMany = await expectToolError(client, 'calc_aha', { speeds: [1, 2, 3, 4, 5], save: true })
  check('calc_aha save rejects a 5th teammate (Chinese)', tooMany.includes('最多 4 名'), tooMany.slice(0, 90))

  // Plain path regression: no new payload keys, pure call does not bump revision
  const plainAha = await callTool(client, 'calc_aha', { speeds: [160, 120, 100] })
  check(
    'calc_aha plain speeds path unchanged (no solve/draft keys)',
    plainAha.ahaSpeed === 129 && !('solve' in plainAha) && !('draft' in plainAha),
    Object.keys(plainAha).join(','),
  )
  const revisionAfterPure = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  check(
    'pure calc_aha / calc_ehr calls leave the revision alone',
    revisionAfterPure === revisionBefore + 2, // exactly the two save=true writes above
    `${revisionBefore} → ${revisionAfterPure}`,
  )

  // ── 4. calc_ehr ───────────────────────────────────────────────────────────
  const classic = await callTool(client, 'calc_ehr', { effectRes: 20, debuffRes: 0, baseChance: 100, attempts: 1, desiredHitRate: 100 })
  check(
    'calc_ehr default reverse mode unchanged (25% oracle, mode echo solve)',
    classic.mode === 'solve' && closeEnough(classic.requiredEhr, 25) && !('perAttemptPercent' in classic) && !('grid' in classic),
    `${classic.requiredEhr}`,
  )

  const prob1 = await callTool(client, 'calc_ehr', {
    mode: 'probability',
    effectRes: 40,
    debuffRes: 0,
    baseChance: 100,
    attempts: 1,
    effectHitRate: 50,
  })
  check(
    'calc_ehr probability single attempt = 90% (hand fixture, web acceptance)',
    prob1.mode === 'probability' && closeEnough(prob1.perAttemptProbability, 0.9) && closeEnough(prob1.perAttemptPercent, 90)
      && closeEnough(prob1.applicationProbability, 0.9) && closeEnough(prob1.applicationPercent, 90),
    `${prob1.perAttemptProbability}/${prob1.perAttemptPercent}/${prob1.applicationProbability}/${prob1.applicationPercent}`,
  )
  const prob3 = await callTool(client, 'calc_ehr', {
    mode: 'probability',
    effectRes: 40,
    debuffRes: 0,
    baseChance: 100,
    attempts: 3,
    effectHitRate: 50,
  })
  check(
    'calc_ehr probability cumulative over 3 attempts = 1−0.1³ = 99.9%',
    closeEnough(prob3.perAttemptProbability, 0.9)
      && closeEnough(prob3.applicationProbability, 1 - 0.1 ** 3)
      && closeEnough(prob3.applicationPercent, 99.9) && prob3.attemptsUsed === 3,
    `${prob3.applicationPercent}`,
  )
  check(
    'calc_ehr probability still carries the solver block with the default target (100)',
    prob3.achievable === true && typeof prob3.requiredEhr === 'number' && prob3.inputs.desiredHitRate === 100 && prob3.effectHitRate === 50,
    `requiredEhr=${prob3.requiredEhr}`,
  )
  const unreachable = await callTool(client, 'calc_ehr', {
    mode: 'probability',
    effectRes: 40,
    debuffRes: 100,
    baseChance: 100,
    attempts: 1,
    effectHitRate: 50,
  })
  check(
    'calc_ehr probability with debuffRes 100% still reports achievable=false + reasons',
    unreachable.achievable === false && unreachable.requiredEhr === null
      && unreachable.reasons.some((r) => r.includes('减益抵抗')) && closeEnough(unreachable.perAttemptProbability, 0),
    JSON.stringify(unreachable.reasons),
  )

  const gridDefault = await callTool(client, 'calc_ehr', {
    mode: 'grid',
    effectRes: 40,
    debuffRes: 0,
    baseChance: 100,
    attempts: 1,
    effectHitRate: 50,
  })
  check(
    'calc_ehr grid default range: 21 rows × 9 columns, rows 100 → 0',
    gridDefault.grid.rows.length === 21 && gridDefault.grid.effectResSteps.length === 9
      && gridDefault.grid.rows[0].ehr === 100 && gridDefault.grid.rows[20].ehr === 0,
    `${gridDefault.grid.rows.length} rows`,
  )
  const currentRow = gridDefault.grid.rows.find((row) => row.isCurrentRow)
  check(
    'calc_ehr grid marks the snapped center row and nearest res column',
    currentRow?.ehr === 50 && currentRow.cells.filter((c) => c.isCurrentColumn).length === 1
      && currentRow.cells.find((c) => c.isCurrentColumn)?.effectRes === 40
      && gridDefault.grid.nearestRes === 40,
    `center=${currentRow?.ehr}, nearestRes=${gridDefault.grid.nearestRes}`,
  )
  check(
    'calc_ehr grid cell oracles match the hand formula',
    currentRow.cells.find((c) => c.effectRes === 0)?.rate === mirrorGridRate({ baseChance: 100, ehr: 50, effectRes: 0, debuffRes: 0 })
      && currentRow.cells.find((c) => c.effectRes === 80)?.rate === mirrorGridRate({ baseChance: 100, ehr: 50, effectRes: 80, debuffRes: 0 })
      && gridDefault.grid.rows.find((r) => r.ehr === 100)?.cells.find((c) => c.effectRes === 80)?.rate === mirrorGridRate({
          baseChance: 100,
          ehr: 100,
          effectRes: 80,
          debuffRes: 0,
        }),
    `cell(50,0)=${currentRow.cells.find((c) => c.effectRes === 0)?.rate}, cell(50,80)=${currentRow.cells.find((c) => c.effectRes === 80)?.rate}`,
  )

  const grid52 = await callTool(client, 'calc_ehr', {
    mode: 'grid',
    effectRes: 44,
    debuffRes: 0,
    baseChance: 100,
    attempts: 1,
    effectHitRate: 52,
  })
  check(
    'calc_ehr grid snaps EHR 52 to center row 50 and res 44 to the 40 column',
    grid52.grid.centerEhr === 50 && grid52.grid.nearestRes === 40
      && grid52.grid.rows.find((r) => r.isCurrentRow)?.ehr === 50
      && grid52.grid.rows.every((r) => r.cells.find((c) => c.isCurrentColumn)?.effectRes === 40),
    `center=${grid52.grid.centerEhr}, nearest=${grid52.grid.nearestRes}`,
  )
  const grid10 = await callTool(client, 'calc_ehr', {
    mode: 'grid',
    effectRes: 40,
    debuffRes: 0,
    baseChance: 100,
    attempts: 1,
    effectHitRate: 50,
    windowHalf: 10,
  })
  check(
    'calc_ehr grid range 10 → center ± 2 rows (60…40)',
    grid10.grid.rows.length === 5 && grid10.grid.rows[0].ehr === 60 && grid10.grid.rows[4].ehr === 40 && grid10.grid.windowMin === 40,
    grid10.grid.rows.map((r) => r.ehr).join(','),
  )
  const badWindow = await expectToolError(client, 'calc_ehr', {
    mode: 'grid',
    effectRes: 40,
    debuffRes: 0,
    baseChance: 100,
    attempts: 1,
    windowHalf: 15,
  })
  check(
    'calc_ehr grid rejects a non-multiple-of-10 range (Chinese)',
    badWindow.includes('windowHalf') && badWindow.includes('10 的倍数'),
    badWindow.slice(0, 110),
  )

  // ── 5. warp_plan applyPlannerMode ─────────────────────────────────────────
  const baseWarp = {
    jades: 16000, // 100 pulls
    starlight: 'REFUND_NONE',
    strategy: 0,
    targets: [{ characterId: sampleCharacterWithEidolon.id, currentEidolonLevel: -1, targetEidolonLevel: 0, targetSuperimpositionLevel: 1 }],
  }
  const multiRun = await callTool(client, 'warp_plan', { ...baseWarp, plannerMode: 'multi' })
  check(
    'warp_plan multi mode: caller targets used, no substitution marker',
    multiRun.targetResults.length === 1 && multiRun.targetResults[0].target.id === 'target-1'
      && multiRun.targetResults[0].finalMilestone?.label === 'E0S1' && multiRun.plannerModeApplied === undefined,
    JSON.stringify(multiRun.targetResults[0].milestones.map((m) => m.label)),
  )
  const simpleRun = await callTool(client, 'warp_plan', { ...baseWarp, applyPlannerMode: true, plannerMode: 'simple' })
  check(
    'warp_plan applyPlannerMode(simple) swaps in the quick-combined E6S5 target',
    simpleRun.plannerModeApplied === true && simpleRun.targetResults.length === 1
      && simpleRun.targetResults[0].target.id === 'quick-combined'
      && simpleRun.targetResults[0].finalMilestone?.label === 'E6S5',
    `${simpleRun.targetResults[0].target.id} → ${simpleRun.targetResults[0].finalMilestone?.label}`,
  )
  check(
    'warp_plan simple vs multi actually diverge (milestone count + final label + final expected warps)',
    simpleRun.targetResults[0].milestones.length !== multiRun.targetResults[0].milestones.length
      && simpleRun.targetResults[0].finalMilestone.label !== multiRun.targetResults[0].finalMilestone.label
      && !closeEnough(simpleRun.targetResults[0].finalMilestone.warps, multiRun.targetResults[0].finalMilestone.warps),
    `${simpleRun.targetResults[0].milestones.length} vs ${multiRun.targetResults[0].milestones.length} milestones, `
      + `${simpleRun.targetResults[0].finalMilestone.warps.toFixed(1)} vs ${multiRun.targetResults[0].finalMilestone.warps.toFixed(1)} warps`,
  )
  const simpleNoTargets = await callTool(client, 'warp_plan', { jades: 0, applyPlannerMode: true })
  check(
    'warp_plan applyPlannerMode without targets: default plannerMode is simple (upstream default), quick target used',
    simpleNoTargets.plannerModeApplied === true && simpleNoTargets.targetResults[0].target.id === 'quick-combined',
    `${simpleNoTargets.request.plannerMode}`,
  )
  const explicitMulti = await callTool(client, 'warp_plan', { ...baseWarp, applyPlannerMode: true, plannerMode: 'multi' })
  check(
    'warp_plan applyPlannerMode with plannerMode=multi keeps the caller targets',
    explicitMulti.plannerModeApplied === undefined && explicitMulti.targetResults[0].target.id === 'target-1',
    JSON.stringify(explicitMulti.targetResults.map((t) => t.target.id)),
  )

  // ── 6. warp_plan normalizeTargets ─────────────────────────────────────────
  const charId = sampleCharacterWithEidolon.id
  const chained = await callTool(client, 'warp_plan', {
    jades: 0,
    plannerMode: 'multi',
    normalizeTargets: true,
    targets: [
      { id: 'chain-1', characterId: charId, currentEidolonLevel: 0, targetEidolonLevel: 2 },
      { id: 'chain-2', characterId: charId },
    ],
  })
  const chainedTargets = chained.request.targets
  check(
    'normalizeTargets: same-character goals chain head-to-tail (E0→E2 then E2→E3)',
    chainedTargets.length === 2 && chainedTargets[0].id === 'chain-1' && chainedTargets[0].currentEidolonLevel === 0
      && chainedTargets[0].targetEidolonLevel === 2 && chainedTargets[1].currentEidolonLevel === 2 && chainedTargets[1].targetEidolonLevel === 3,
    JSON.stringify(chainedTargets.map((t) => [t.currentEidolonLevel, t.targetEidolonLevel])),
  )
  const seeded = await callTool(client, 'warp_plan', {
    jades: 0,
    plannerMode: 'multi',
    normalizeTargets: true,
    targets: [{ characterId: charId }],
  })
  check(
    `normalizeTargets: a character-id-only goal starts at the save's owned eidolon (${ownedEidolon}) and pulls +1`,
    seeded.request.targets[0].currentEidolonLevel === ownedEidolon
      && seeded.request.targets[0].targetEidolonLevel === ownedEidolon + 1
      && seeded.request.targets[0].targetSuperimpositionLevel === 0,
    JSON.stringify(seeded.request.targets[0]),
  )
  const lcChained = await callTool(client, 'warp_plan', {
    jades: 0,
    plannerMode: 'multi',
    normalizeTargets: true,
    targets: [
      { id: 'lc-1', characterId: charId, targetEidolonLevel: 1, lightConeId: null },
      { id: 'lc-2', lightConeId: '23014' },
      { id: 'lc-3', lightConeId: '23014' },
    ],
  })
  check(
    'normalizeTargets: same-light-cone goals chain (S0→S1 then S1→S2) and char goal stays eidolon-only',
    lcChained.request.targets[1].currentSuperimpositionLevel === 0 && lcChained.request.targets[1].targetSuperimpositionLevel === 1
      && lcChained.request.targets[2].currentSuperimpositionLevel === 1 && lcChained.request.targets[2].targetSuperimpositionLevel === 2
      && lcChained.request.targets[0].targetSuperimpositionLevel === 0,
    JSON.stringify(lcChained.request.targets.map((t) => [t.currentSuperimpositionLevel, t.targetSuperimpositionLevel])),
  )
  // Without normalizeTargets the raw final-form list passes through untouched
  const rawPassthrough = await callTool(client, 'warp_plan', {
    jades: 0,
    plannerMode: 'multi',
    targets: [{ id: 'raw', characterId: charId, currentEidolonLevel: 0, targetEidolonLevel: 2 }],
  })
  check(
    'warp_plan without normalizeTargets keeps the caller-supplied final form',
    rawPassthrough.request.targets[0].currentEidolonLevel === 0 && rawPassthrough.request.targets[0].targetEidolonLevel === 2,
    JSON.stringify(rawPassthrough.request.targets[0]),
  )

  // ── 7. warp_plan save=true roundtrip ──────────────────────────────────────
  const warpSaved = await callTool(client, 'warp_plan', {
    jades: 16000,
    passes: 3,
    income: ['4.5_p1_1'],
    plannerMode: 'multi',
    strategy: 2,
    targets: [{ characterId: charId, currentEidolonLevel: -1, targetEidolonLevel: 1, targetSuperimpositionLevel: 1 }],
    save: true,
  })
  check(
    'warp_plan save=true echoes saved=true + the persisted request',
    warpSaved.saved === true && warpSaved.savedRequest.jades === 16000 && warpSaved.savedRequest.passes === 3
      && warpSaved.savedRequest.strategy === 2 && warpSaved.savedRequest.plannerMode === 'multi'
      && JSON.stringify(warpSaved.savedRequest.income) === JSON.stringify(['4.5_p1_1']),
    JSON.stringify(warpSaved.savedRequest?.income),
  )
  const snapshot2 = await callTool(client, 'export_save', { structured: true })
  check(
    'saved warp request lands in the archive key warpRequest',
    snapshot2.snapshot.warpRequest.jades === 16000 && snapshot2.snapshot.warpRequest.passes === 3
      && snapshot2.snapshot.warpRequest.strategy === 2 && snapshot2.snapshot.warpRequest.plannerMode === 'multi'
      && snapshot2.snapshot.warpRequest.targets[0].targetEidolonLevel === 1,
    JSON.stringify(snapshot2.snapshot.warpRequest?.targets?.[0]),
  )
  const warpFromSaved = await callTool(client, 'warp_plan', { fromSaved: true, plannerMode: 'multi' })
  check(
    'warp_plan fromSaved replays the persisted request',
    warpFromSaved.request.jades === 16000 && warpFromSaved.targetResults.length === 1
      && warpFromSaved.targetResults[0].target.targetEidolonLevel === 1 && warpFromSaved.totalWarps === warpSaved.totalWarps,
    `jades=${warpFromSaved.request.jades}, totalWarps=${warpFromSaved.totalWarps}`,
  )

  // ── 8. update_state(session language) ─────────────────────────────────────
  const sessionBefore = await callTool(client, 'get_state', { section: 'session' })
  check(
    'session language starts at the zh_CN render default (fresh detector cache)',
    sessionBefore.session.ephemeral.language === 'zh_CN' && sessionBefore.session.ephemeral.activeLanguage === 'zh_CN',
    JSON.stringify(sessionBefore.session.ephemeral),
  )
  const langUpdated = await callTool(client, 'update_state', { section: 'session', patch: { language: 'en_US' } })
  check(
    'update_state(session language=en_US) commits: preference switches, render language does not',
    langUpdated.session.ephemeral.language === 'en_US' && langUpdated.session.ephemeral.activeLanguage === 'zh_CN',
    JSON.stringify(langUpdated.session.ephemeral),
  )
  const sessionAfter = await callTool(client, 'get_state', { section: 'session' })
  check('get_state(session) reads the new preference back', sessionAfter.session.ephemeral.language === 'en_US')
  const snapshot3 = await callTool(client, 'export_save', { structured: true })
  check(
    'language never leaks into the archive (savedSession.global has no language key)',
    !('language' in snapshot3.snapshot.savedSession.global),
    Object.keys(snapshot3.snapshot.savedSession.global).join(','),
  )
  const badLocale = await expectToolError(client, 'update_state', { section: 'session', patch: { language: 'klingon' } })
  check(
    'invalid locale rejected (Chinese, enum listed)',
    badLocale.includes('language') && badLocale.includes('语言 locale 枚举') && badLocale.includes('en_US') && badLocale.includes('zh_CN'),
    badLocale.slice(0, 110),
  )
  const betaLocale = await expectToolError(client, 'update_state', { section: 'session', patch: { language: 'aa_ER' } })
  check('beta-only locale aa_ER rejected (official-site enum)', betaLocale.includes('不支持') || betaLocale.includes('枚举'), betaLocale.slice(0, 110))

  // ── 9. load_save(sample=true) ─────────────────────────────────────────────
  const bothSources = await expectToolError(client, 'load_save', { sample: true, path: sampleSavePath })
  check('load_save rejects sample + path together (Chinese, 三选一)', bothSources.includes('三选一'), bothSources.slice(0, 90))
  const sampleLoaded = await callTool(client, 'load_save', { sample: true })
  check(
    'load_save(sample=true) loads the built-in sample (counts equal the repository file)',
    sampleLoaded.sample === true && sampleLoaded.path === null && sampleLoaded.loaded === true
      && sampleLoaded.characters === sampleJson.characters.length && sampleLoaded.relics === sampleJson.relics.length,
    `${sampleLoaded.relics} relics / ${sampleLoaded.characters} characters`,
  )
  check(
    'sample load replaced the previous state (warp draft reset away)',
    (await callTool(client, 'warp_plan', { fromSaved: true })).request.jades === 0,
    '',
  )
  const sessionAfterSample = await callTool(client, 'get_state', { section: 'session' })
  check(
    'language preference survives a save reload (detector cache, not archive-coupled)',
    sessionAfterSample.session.ephemeral.language === 'en_US',
    sessionAfterSample.session.ephemeral.language,
  )
  const sampleExportPath = `${tempDir}/sample-export.json`
  const sampleExport = await callTool(client, 'export_save', { path: sampleExportPath })
  check('export after sample load writes a valid save file', existsSync(sampleExportPath) && sampleExport.bytes > 0, `${sampleExport.bytes} bytes`)

  // ── 10. final regression: old warp_plan budget path ───────────────────────
  const budget = await callTool(client, 'warp_plan', { jades: 16000, passes: 5, income: ['4.5_p1_1', '4.6_p2_1'] })
  check(
    'warp_plan legacy budget math unchanged (204 warps)',
    budget.totalWarps === 204 && budget.request.warps === 204,
    `${budget.totalWarps}`,
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-calculators: ALL CHECKS PASSED' : `\nsmoke-calculators: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
