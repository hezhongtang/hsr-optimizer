// End-to-end smoke test for the team-management + character-side extension
// surface (M5-C).
//
// Spawns the built server over stdio and walks:
//   load_save (temp copy)
//   → save_team x2 → manage_team move (saved-team reorder) → load (working
//     team == saved content; roster-restoring load adds unowned characters)
//   → manage_team compose: whole-team setup / single-slot swap (incl. the
//     duplicate-slot auto-clear) / reorder / clear / the empty-team slot-0
//     autofill semantics (custom scoring team from equip_saved_build
//     applyScoringTeam, owned-only filling)
//   → manage_team sync_benchmarks (snapshot captured, written into the active
//     saved team; slot change drops the working snapshot)
//   → manage_team delete
//   → save_team(benchmarkSnapshot=true) roundtrip (+ the missing-light-cone
//     rejection)
//   → delete_build(all=true) / equip_saved_build(applyScoringTeam=true) and its
//     default no-side-effect mode
//   → set_character_rank(sortBy=effectiveSubstats) order/score consistency
//   → set_scoring_override(traces) cascade roundtrip via the metadata resource
//   → update_state(section=showcase) scoringType roundtrip
//   → Chinese error paths (unknown teamId / characterId / trace node)
//   → export_save → reload: teams + builds + showcase preferences persist
//
// Everything persists into a temp directory (save copy + HSR_MCP_STATE_FILE);
// the repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-teams.mjs [serverEntry]
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

const TARGET = '1212b1' // Jingliu — DPS sim, 6 equipped relics, light cone 23014
const CHAR_B = '1005'
const CHAR_C = '1102'
const CHAR_D = '1217'
const CHAR_E = '1205'
const CHAR_F = '1202'
const CHAR_G = '1101'
const HEALER = '1105' // Natasha — 0 equipped relics, light cone equipped
const NEW_CHAR = '1107' // Clara — valid game id, not in the sample save

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-teams-`)
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

async function expectToolError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

async function readJsonResource(client, uri) {
  const result = await client.readResource({ uri })
  const contents = result.contents ?? []
  if (contents.length !== 1 || contents[0].mimeType !== 'application/json') {
    throw new Error(`resource ${uri}: expected 1 application/json content, got ${contents.length}`)
  }
  return JSON.parse(contents[0].text)
}

/** Same walk as StatTracesDrawer: every node id + the descendant set of a node. */
function traceTreeFacts(tree) {
  const nodesById = new Map()
  const stack = [...tree]
  while (stack.length) {
    const node = stack.pop()
    nodesById.set(node.id, node)
    for (const child of node.children) stack.push(child)
  }
  const descendants = (id) => {
    const out = new Set()
    const walk = [id]
    while (walk.length) {
      const node = nodesById.get(walk.pop())
      if (!node) continue
      for (const child of node.children) {
        if (!out.has(child.id)) {
          out.add(child.id)
          walk.push(child.id)
        }
      }
    }
    return out
  }
  return { nodesById, descendants }
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-teams', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  // ── 1. tool surface ────────────────────────────────────────────────────────
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  check('tool manage_team registered', toolNames.includes('manage_team'))

  // ── 2. load sample save (temp copy — write-backs target it) ───────────────
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save characters = 8', loaded.characters === 8, `got ${loaded.characters}`)

  // ── 3. save_team x2 ────────────────────────────────────────────────────────
  const teamAIds = [TARGET, CHAR_B, CHAR_C, CHAR_D]
  const teamBIds = [CHAR_E, CHAR_F, CHAR_G, null]
  const savedA = await callTool(client, 'save_team', { name: 'smoke-a', characterIds: teamAIds })
  check('save_team A created with 4 slots', savedA.created === true && savedA.team.characterIds.length === 4)
  check('save_team A has no benchmark snapshot by default', savedA.benchmarkSnapshotAttached === false && savedA.team.hasBenchmarkSnapshot === false)
  const savedB = await callTool(client, 'save_team', { name: 'smoke-b', characterIds: teamBIds })
  check('save_team B pads the 4th slot with null', savedB.team.characterIds[3] === null, JSON.stringify(savedB.team.characterIds))
  check('save_team B reports 2 total teams', savedB.totalTeams === 2)

  // ── 4. manage_team move: saved-team reorder ────────────────────────────────
  const moved = await callTool(client, 'manage_team', { action: 'move', from: 1, to: 0 })
  check(
    'move puts team B first, A second',
    JSON.stringify(moved.teamOrder) === JSON.stringify([savedB.teamId, savedA.teamId]),
    JSON.stringify(moved.teamOrder),
  )
  let listed = await callTool(client, 'list_teams', {})
  check('list_teams reflects the new order', listed.teams.map((t) => t.id).join() === moved.teamOrder.join())
  let moveErr = await expectToolError(client, 'manage_team', { action: 'move', from: 0, to: 5 })
  check('move rejects an out-of-range index (Chinese)', moveErr.includes('越界'), moveErr.slice(0, 90))

  // ── 5. manage_team load: working team == saved content ─────────────────────
  const loadA = await callTool(client, 'manage_team', { action: 'load', teamId: savedA.teamId })
  check(
    'load sets the working team to the saved slots',
    JSON.stringify(loadA.workingTeam.characterIds) === JSON.stringify(teamAIds),
    JSON.stringify(loadA.workingTeam.characterIds),
  )
  check('load keeps the active saved team id', loadA.workingTeam.activeSavedTeamId === savedA.teamId)
  check('load without a snapshot leaves hasBenchmarkSnapshot false', loadA.workingTeam.hasBenchmarkSnapshot === false)

  // ── 6. load restores unowned characters into the roster ────────────────────
  const savedC = await callTool(client, 'save_team', { name: 'smoke-c', characterIds: [HEALER, NEW_CHAR, null, null] })
  const loadC = await callTool(client, 'manage_team', { action: 'load', teamId: savedC.teamId })
  check(
    'load adds the unowned member to the roster',
    loadC.rosterAdded.length === 1 && loadC.rosterAdded[0] === NEW_CHAR,
    JSON.stringify(loadC.rosterAdded),
  )
  const rosterAfterLoad = await callTool(client, 'list_characters', {})
  check(
    'roster really contains the restored character',
    rosterAfterLoad.characters.some((c) => c.id === NEW_CHAR),
    `${rosterAfterLoad.characters.length} characters`,
  )
  check(
    'load of team C replaces the working team',
    JSON.stringify(loadC.workingTeam.characterIds) === JSON.stringify([HEALER, NEW_CHAR, null, null]),
  )

  // ── 7. compose: whole-team setup slot by slot (no autofill off slot 0 on a
  //        non-empty team / non-zero index on an empty one) ───────────────────
  await callTool(client, 'manage_team', { action: 'compose', op: 'clear' })
  const s1 = await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 1, characterId: CHAR_G })
  check('set_slot on empty team index 1 does not autofill', JSON.stringify(s1.workingTeam.characterIds) === JSON.stringify([null, CHAR_G, null, null]))
  await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 2, characterId: CHAR_E })
  await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 3, characterId: CHAR_F })
  const s0 = await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 0, characterId: CHAR_B })
  check(
    'whole-team setup reaches all four slots',
    JSON.stringify(s0.workingTeam.characterIds) === JSON.stringify([CHAR_B, CHAR_G, CHAR_E, CHAR_F]),
    JSON.stringify(s0.workingTeam.characterIds),
  )

  // ── 8. compose: single-slot swap + duplicate auto-clear ────────────────────
  const swap = await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 0, characterId: CHAR_D })
  check('single-slot swap replaces only that slot', swap.workingTeam.characterIds[0] === CHAR_D && swap.workingTeam.characterIds[1] === CHAR_G)
  const dup = await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 2, characterId: CHAR_G })
  check(
    'picking a character already in another slot empties that slot',
    dup.workingTeam.characterIds[1] === null && dup.workingTeam.characterIds[2] === CHAR_G,
    JSON.stringify(dup.workingTeam.characterIds),
  )
  const removeSlot = await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 2, characterId: null })
  check('set_slot null removes the character', removeSlot.workingTeam.characterIds[2] === null)

  // ── 9. compose: reorder ────────────────────────────────────────────────────
  // slots are [CHAR_D, null, null, CHAR_F] now → order [3,0,1,2] → [CHAR_F, CHAR_D, null, null]
  const reordered = await callTool(client, 'manage_team', { action: 'compose', op: 'reorder', order: [3, 0, 1, 2] })
  check(
    'reorder applies the source-index permutation',
    JSON.stringify(reordered.workingTeam.characterIds) === JSON.stringify([CHAR_F, CHAR_D, null, null]),
    JSON.stringify(reordered.workingTeam.characterIds),
  )
  let reorderErr = await expectToolError(client, 'manage_team', { action: 'compose', op: 'reorder', order: [0, 0, 1, 2] })
  check('reorder rejects a non-permutation order (Chinese)', reorderErr.includes('排列'), reorderErr.slice(0, 90))

  // ── 10. compose: clear ─────────────────────────────────────────────────────
  const cleared = await callTool(client, 'manage_team', { action: 'compose', op: 'clear' })
  check(
    'clear empties every slot',
    cleared.workingTeam.characterIds.every((id) => id === null),
    JSON.stringify(cleared.workingTeam.characterIds),
  )
  listed = await callTool(client, 'list_teams', {})
  check('clear leaves saved teams untouched', listed.total === 3, `${listed.total} teams`)

  // ── 11. sync_benchmarks: capture + write into the active saved team ────────
  const loadAgain = await callTool(client, 'manage_team', { action: 'load', teamId: savedA.teamId })
  check('reload team A before sync', loadAgain.workingTeam.activeSavedTeamId === savedA.teamId)
  const synced = await callTool(client, 'manage_team', { action: 'sync_benchmarks' })
  check(
    'sync captures 4 benchmark members',
    synced.snapshot?.members?.length === 4
      && synced.snapshot.members.every((m) => m.lightCone != null && typeof m.characterEidolon === 'number'),
    `${synced.snapshot?.members?.length} members`,
  )
  check(
    'sync infers teammate sets (relic 4p + ornament 2p fields present)',
    synced.snapshot.members.every((m) => m.teamRelicSet !== undefined && m.teamOrnamentSet !== undefined),
    JSON.stringify(synced.snapshot.members.map((m) => [m.characterId, m.teamRelicSet, m.teamOrnamentSet])),
  )
  check('sync writes the snapshot into the active saved team', synced.savedTeamId === savedA.teamId, `savedTeamId=${synced.savedTeamId}`)
  listed = await callTool(client, 'list_teams', {})
  check(
    'list_teams shows the snapshot on team A',
    listed.teams.find((t) => t.id === savedA.teamId)?.hasBenchmarkSnapshot === true,
  )
  const afterSync = await callTool(client, 'manage_team', { action: 'get' })
  check('working team carries the synced snapshot', afterSync.workingTeam.hasBenchmarkSnapshot === true)
  const slotChange = await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 3, characterId: null })
  check('a slot change drops the working snapshot (setSlot semantics)', slotChange.workingTeam.hasBenchmarkSnapshot === false)

  // ── 12. save_team(benchmarkSnapshot=true) roundtrip ────────────────────────
  const savedSnap = await callTool(client, 'save_team', {
    name: 'smoke-snap',
    characterIds: [CHAR_G, CHAR_F, CHAR_E, CHAR_D],
    benchmarkSnapshot: true,
  })
  check(
    'save_team(benchmarkSnapshot) attaches a 4-member snapshot',
    savedSnap.benchmarkSnapshotAttached === true && savedSnap.snapshot?.members?.length === 4,
  )
  listed = await callTool(client, 'list_teams', {})
  check('list_teams exposes the attached snapshot', listed.teams.find((t) => t.id === savedSnap.teamId)?.hasBenchmarkSnapshot === true)
  const loadSnap = await callTool(client, 'manage_team', { action: 'load', teamId: savedSnap.teamId })
  check(
    'load roundtrips the snapshot into the working team',
    loadSnap.workingTeam.hasBenchmarkSnapshot === true && loadSnap.workingTeam.activeSavedTeamId === savedSnap.teamId,
  )
  const noLcSave = await expectToolError(client, 'save_team', {
    name: 'smoke-nolc',
    characterIds: [NEW_CHAR, CHAR_G, CHAR_F, CHAR_E],
    benchmarkSnapshot: true,
  })
  check(
    'benchmarkSnapshot with a light-cone-less member is rejected (Chinese)',
    noLcSave.includes('光锥'),
    noLcSave.slice(0, 100),
  )

  // ── 13. equip_saved_build(applyScoringTeam=true) + autofill semantics ──────
  const teamBuild = await callTool(client, 'save_build', { characterId: TARGET, name: 'mcp-team-build' })
  check(
    'save_build snapshots a full 3-teammate team',
    teamBuild.saved.team.length === 3 && teamBuild.saved.team.every((id) => id != null),
    JSON.stringify(teamBuild.saved.team),
  )
  const buildTeamIds = teamBuild.saved.team
  const equippedBuild = await callTool(client, 'equip_saved_build', {
    characterId: TARGET,
    buildName: 'mcp-team-build',
    applyScoringTeam: true,
  })
  check(
    'applyScoringTeam reports the applied DPS custom team',
    equippedBuild.scoringTeam.requested === true && equippedBuild.scoringTeam.applied === true
      && JSON.stringify(equippedBuild.scoringTeam.teammates) === JSON.stringify(buildTeamIds),
    JSON.stringify(equippedBuild.scoringTeam),
  )
  const metaAfterEquip = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check(
    'scoring override now carries the build team (persisted simulation.teammates)',
    JSON.stringify(metaAfterEquip.override?.simulation?.teammates?.map((t) => t.characterId)) === JSON.stringify(buildTeamIds),
    JSON.stringify(metaAfterEquip.override?.simulation?.teammates?.map((t) => t.characterId)),
  )

  // default mode: no scoring side effect on a fresh character
  await callTool(client, 'save_build', { characterId: CHAR_C, name: 'mcp-plain-build' })
  const plainEquip = await callTool(client, 'equip_saved_build', { characterId: CHAR_C, buildName: 'mcp-plain-build' })
  const metaPlain = await callTool(client, 'get_scoring_metadata', { characterId: CHAR_C })
  check(
    'equip_saved_build without applyScoringTeam leaves the scoring config untouched',
    plainEquip.scoringTeam.requested === false && metaPlain.override?.simulation?.teammates == null,
    JSON.stringify(plainEquip.scoringTeam),
  )

  // autofill: roster the custom teammates first so the owned filter lets them
  // all through, then fill slot 0 of an empty team with the custom-team leader.
  await callTool(client, 'manage_team', { action: 'compose', op: 'clear' })
  const rosterBeforeAutofill = new Set((await callTool(client, 'list_characters', {})).characters.map((c) => c.id))
  for (const [i, teammateId] of buildTeamIds.entries()) {
    await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: i + 1, characterId: teammateId })
  }
  const rosterAfterTeammates = (await callTool(client, 'list_characters', {})).characters.map((c) => c.id)
  check(
    'set_slot restored the unowned teammates into the roster',
    buildTeamIds.every((id) => rosterAfterTeammates.includes(id)),
    `${rosterBeforeAutofill.size} → ${rosterAfterTeammates.length} characters`,
  )
  await callTool(client, 'manage_team', { action: 'compose', op: 'clear' })
  const autofill = await callTool(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 0, characterId: TARGET })
  // autofillTeamSlots semantics: candidates = custom teammates minus the
  // leader, owned-only, filling empty slots 1..3 in team order.
  const candidates = buildTeamIds.filter((id) => id !== TARGET)
  const expectedAutofill = [TARGET, ...candidates, null, null, null].slice(0, 4)
  check(
    'slot-0 pick on an empty team autofills from the custom scoring team',
    JSON.stringify(autofill.workingTeam.characterIds) === JSON.stringify(expectedAutofill),
    `${JSON.stringify(autofill.workingTeam.characterIds)} vs ${JSON.stringify(expectedAutofill)}`,
  )
  check(
    'autofilled lists exactly the teammates the web would fill',
    JSON.stringify(autofill.autofilled) === JSON.stringify(candidates),
    JSON.stringify(autofill.autofilled),
  )

  // ── 14. manage_team delete ─────────────────────────────────────────────────
  listed = await callTool(client, 'list_teams', {})
  const orderBeforeDelete = listed.teams.map((t) => t.id)
  const deleted = await callTool(client, 'manage_team', { action: 'delete', teamId: savedC.teamId })
  check(
    'delete removes the team and keeps the others in order',
    JSON.stringify(deleted.remainingTeamIds) === JSON.stringify(orderBeforeDelete.filter((id) => id !== savedC.teamId)),
  )
  listed = await callTool(client, 'list_teams', {})
  check('list_teams agrees after delete', listed.total === deleted.remainingTeamIds.length)

  // ── 15. delete_build(all=true) ─────────────────────────────────────────────
  await callTool(client, 'save_build', { characterId: CHAR_B, name: 'mcp-b1' })
  await callTool(client, 'save_build', { characterId: CHAR_B, name: 'mcp-b2' })
  const clearedBuilds = await callTool(client, 'delete_build', { characterId: CHAR_B, all: true })
  check(
    'delete_build(all) clears every build by name',
    clearedBuilds.clearedAll === true
      && JSON.stringify(clearedBuilds.deletedBuilds.sort()) === JSON.stringify(['mcp-b1', 'mcp-b2'])
      && clearedBuilds.remaining === 0,
    JSON.stringify(clearedBuilds),
  )
  const buildsAfterClear = await callTool(client, 'list_builds', { characterId: CHAR_B })
  check('list_builds shows zero builds after the clear', buildsAfterClear.total === 0)
  const allConflict = await expectToolError(client, 'delete_build', { characterId: CHAR_B, name: 'x', all: true })
  check('delete_build rejects name + all together (Chinese)', allConflict.includes('互斥'), allConflict.slice(0, 90))

  // ── 16. set_character_rank(sortBy=effectiveSubstats) ───────────────────────
  const sortedRank = await callTool(client, 'set_character_rank', { sortBy: 'effectiveSubstats' })
  const rosterIds = (await callTool(client, 'list_characters', {})).characters.map((c) => c.id)
  check(
    'sortBy keeps the roster complete',
    new Set(sortedRank.order).size === rosterIds.length && rosterIds.every((id) => sortedRank.order.includes(id)),
    `${sortedRank.order.length} vs ${rosterIds.length}`,
  )
  check(
    'sortBy scores align with the order and are non-increasing',
    sortedRank.scores.length === sortedRank.order.length
      && sortedRank.scores.every((s, i) =>
        s.characterId === sortedRank.order[i]
        && (i === 0 || sortedRank.scores[i - 1].effectiveSubstats >= s.effectiveSubstats)
      ),
    sortedRank.scores.map((s) => `${s.characterId}:${s.effectiveSubstats.toFixed(1)}`).join(' '),
  )
  const sortedIds = sortedRank.scores.map((s) => s.characterId)
  const byScore = [...sortedRank.scores].sort((a, b) => b.effectiveSubstats - a.effectiveSubstats).map((s) => s.characterId)
  check('order matches an independent desc sort of the returned scores', JSON.stringify(sortedIds) === JSON.stringify(byScore))
  const rankConflict = await expectToolError(client, 'set_character_rank', { sortBy: 'effectiveSubstats', characterId: TARGET, index: 0 })
  check('sortBy rejects characterId/index together (Chinese)', rankConflict.includes('互斥'), rankConflict.slice(0, 90))
  const movedRank = await callTool(client, 'set_character_rank', { characterId: TARGET, index: 0 })
  check('move mode still works (default behavior unchanged)', movedRank.order[0] === TARGET)

  // ── 17. set_scoring_override(traces) cascade roundtrip ─────────────────────
  const targetDetail = await readJsonResource(client, `game://metadata/characters/${TARGET}`)
  const { nodesById, descendants } = traceTreeFacts(targetDetail.traceTree)
  check('trace tree resource exposes nodes', nodesById.size >= 10, `${nodesById.size} nodes`)
  const nodeWithChildren = [...nodesById.values()].find((n) => n.children.length > 0 && n.children.every((c) => c.children.length === 0))
  const expectedDeactivated = [nodeWithChildren.id, ...descendants(nodeWithChildren.id)].sort()
  const tracesSet = await callTool(client, 'set_scoring_override', {
    characterId: TARGET,
    traces: { deactivated: [nodeWithChildren.id] },
  })
  check(
    'traces write cascades to all descendants like the drawer',
    JSON.stringify([...tracesSet.traces.deactivated].sort()) === JSON.stringify(expectedDeactivated)
      && tracesSet.traces.expanded === true
      && tracesSet.traces.totalNodes === nodesById.size,
    `${tracesSet.traces.deactivated.length} deactivated of ${nodesById.size}`,
  )
  const metaTraces = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check(
    'override.traces.deactivated roundtrips through the store',
    JSON.stringify([...(metaTraces.override?.traces?.deactivated ?? [])].sort()) === JSON.stringify(expectedDeactivated),
  )
  const tracesReset = await callTool(client, 'set_scoring_override', { characterId: TARGET, traces: { deactivated: [] } })
  check('empty deactivated re-enables everything', tracesReset.traces.deactivated.length === 0 && tracesReset.traces.expanded === false)
  const unknownTrace = await expectToolError(client, 'set_scoring_override', {
    characterId: TARGET,
    traces: { deactivated: ['no-such-trace-node'] },
  })
  check('unknown trace node id rejected (Chinese)', unknownTrace.includes('未知行迹节点'), unknownTrace.slice(0, 90))

  // ── 18. update_state(section=showcase) scoringType roundtrip ───────────────
  const showcaseUpdated = await callTool(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: TARGET, scoringType: 1 },
  })
  check('update_state(showcase) commits', showcaseUpdated.updated === true)
  const showcaseRead = await callTool(client, 'get_state', { section: 'showcase' })
  check(
    'get_state(showcase) reflects the stored scoringType',
    showcaseRead.showcase.preferences[TARGET]?.scoringType === 1,
    JSON.stringify(showcaseRead.showcase.preferences[TARGET] ?? null),
  )
  const showcasePartial = await expectToolError(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: TARGET },
  })
  check('showcase patch without scoringType rejected (Chinese)', showcasePartial.includes('scoringType'), showcasePartial.slice(0, 90))

  // ── 19. Chinese error paths ────────────────────────────────────────────────
  const badTeam = await expectToolError(client, 'manage_team', { action: 'load', teamId: 'no-such-team' })
  check('load with unknown teamId errors (Chinese, lists existing)', badTeam.includes('不存在') && badTeam.includes('smoke-a'), badTeam.slice(0, 90))
  const badDelete = await expectToolError(client, 'manage_team', { action: 'delete', teamId: 'no-such-team' })
  check('delete with unknown teamId errors (Chinese)', badDelete.includes('不存在'))
  const badSlot = await expectToolError(client, 'manage_team', { action: 'compose', op: 'set_slot', index: 0, characterId: 'not-a-character' })
  check('set_slot with unknown characterId errors (Chinese)', badSlot.includes('未知角色'), badSlot.slice(0, 90))

  // ── 20. persistence: export → reload keeps teams, builds, preferences ──────
  const exportPath = `${tempDir}/exported-save.json`
  const exported = await callTool(client, 'export_save', { path: exportPath })
  check('export_save wrote a file', existsSync(exportPath) && exported.bytes > 0, `${exported.bytes} bytes`)
  listed = await callTool(client, 'list_teams', {})
  const teamsBeforeExport = listed.teams.map((t) => ({
    id: t.id,
    name: t.name,
    characterIds: t.characterIds,
    hasBenchmarkSnapshot: t.hasBenchmarkSnapshot,
  }))
  await callTool(client, 'load_save', { path: exportPath })
  const listedAfter = await callTool(client, 'list_teams', {})
  check(
    'teams persist across export → reload (order, slots, snapshots)',
    JSON.stringify(listedAfter.teams.map((t) => ({
      id: t.id,
      name: t.name,
      characterIds: t.characterIds,
      hasBenchmarkSnapshot: t.hasBenchmarkSnapshot,
    }))) === JSON.stringify(teamsBeforeExport),
    `${listedAfter.total} teams`,
  )
  const buildsAfterReload = await callTool(client, 'list_builds', { characterId: TARGET })
  check('builds persist across export → reload', buildsAfterReload.builds.some((b) => b.name === 'mcp-team-build'))
  const showcaseAfterReload = await callTool(client, 'get_state', { section: 'showcase' })
  check(
    'showcase preferences persist across export → reload',
    showcaseAfterReload.showcase.preferences[TARGET]?.scoringType === 1,
  )
  const freshWorking = await callTool(client, 'manage_team', { action: 'get' })
  check(
    'working team resets on a new save load (ephemeral, like a page reload)',
    freshWorking.workingTeam.characterIds.every((id) => id === null) && freshWorking.workingTeam.activeSavedTeamId === null,
    JSON.stringify(freshWorking.workingTeam.characterIds),
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-teams: ALL CHECKS PASSED' : `\nsmoke-teams: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
