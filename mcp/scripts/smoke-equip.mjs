// End-to-end smoke test for the equipment + scoring tool surface (M1 phase 3).
//
// Spawns the built server over stdio and walks the mutation happy path:
//   load_save (temp copy) → optimize (cache + first rows)
//   → equip_build fromCache (six slots, equippedBy rewired)
//   → Replace behavior on a foreign relic + Swap behavior via forceSwap
//   → unequip_character / switch_relics
//   → save_build (current + fromCache incl. a formOverrides run snapshot) / list_builds / equip_saved_build / delete_build
//   → 9c: per-character scoring resolution (Natasha heal config + default heal team)
//   → score_relics (162 relics, ratings, estTBP 5★-only)
//   → dps_score (percent / grade / upgrades / JSON round-trip / < 10s)
//   → set_scoring_override ↔ get_scoring_metadata round trip + reset
//   → upsert_character / set_character_rank / delete_character
//   → export_save → load back → equipment + builds persisted
//   → 15: equip_build fromCache writes the run's (formOverrides) form onto the character
//   → 16: equip with a deleted relic skips it (skipped list) and equips the rest
//   → 17: fromCache cache is invalidated by load_save (generation rejection)
//   → 18: save_build/list_builds survive empty equipped slots (upstream keeps
//        equipped[part] = undefined with the key retained; the summary must
//        drop them or the z.record outputSchema rejects the whole payload)
//
// Everything persists into a temp directory (save copy + HSR_MCP_STATE_FILE);
// the repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-equip.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
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
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const TARGET = '1212b1'
const CHAR_B = '1005' // 6 equipped relics
const CHAR_C = '1102' // 6 equipped relics
const CHAR_UNEQUIP = '1202' // 5 equipped relics
const NEW_CHAR = '1107' // Clara — valid game id, not in the sample save
const NEW_CHAR_LC = '20000'

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-equip-`)
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

async function equippedIdsBy(client, characterId) {
  const relics = await callTool(client, 'list_relics', { equippedBy: characterId, limit: 500 })
  return relics.relics.map((r) => r.id).sort()
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-equip', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  // 1. tool surface
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  const required = [
    'equip_build',
    'unequip_character',
    'switch_relics',
    'upsert_character',
    'delete_character',
    'set_character_rank',
    'save_build',
    'list_builds',
    'delete_build',
    'equip_saved_build',
    'get_scoring_metadata',
    'set_scoring_override',
    'score_relics',
    'dps_score',
  ]
  for (const name of required) check(`tool ${name} registered`, toolNames.includes(name))

  // 2. load sample save (temp copy — write-backs target it)
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save relics = 162', loaded.relics === 162, `got ${loaded.relics}`)
  check('load_save characters = 8', loaded.characters === 8, `got ${loaded.characters}`)

  // 3. optimize → cache + first two rows
  const optimized = await callTool(client, 'optimize', { characterId: TARGET }, { timeout: 300_000 })
  check('optimize completed', optimized.status === 'completed', `status=${optimized.status}, ${optimized.rows.length} rows`)
  const cacheId = optimized.summary.cacheId
  const row0Id = optimized.rows[0].id
  const row1Id = optimized.rows[1]?.id
  check('optimize produced rows for cache', row0Id != null && row1Id != null, `cacheId=${cacheId}, row0=${row0Id}, row1=${row1Id}`)
  const row0Ids = Object.values(optimized.rows[0].build.relics).map((r) => r?.id)
  const row1Ids = Object.values(optimized.rows[1].build.relics).map((r) => r?.id)

  // 4. equip_build fromCache — six slots rewired to TARGET
  const equipped = await callTool(client, 'equip_build', { characterId: TARGET, fromCache: { cacheId, rowId: row0Id } })
  const slots = Object.keys(equipped.build.relics)
  check('equip_build fromCache fills 6 slots', slots.length === 6, `slots: ${slots.join(',')}`)
  check(
    'equip_build equippedBy points at target',
    slots.every((s) => equipped.build.relics[s].id != null && equipped.build.relics[s].equippedBy === TARGET),
  )
  check('equip_build reports Replace by default', equipped.relicEquippingBehavior.applied === 'Replace', JSON.stringify(equipped.relicEquippingBehavior))
  const afterEquipIds = await equippedIdsBy(client, TARGET)
  check('target now owns exactly the row-0 relics', JSON.stringify(afterEquipIds) === JSON.stringify([...row0Ids].sort()), `${afterEquipIds.length} relics`)

  // 5. Replace behavior: take a relic off CHAR_B
  const bRelics = await callTool(client, 'list_relics', { equippedBy: CHAR_B, limit: 500 })
  const bRelic = bRelics.relics[0]
  check('found a relic equipped by CHAR_B', bRelic != null, `${bRelics.relics.length} to pick from`)
  const displacedByReplace = equipped.build.relics[bRelic.part]?.id
  const replaceResult = await callTool(client, 'equip_build', { characterId: TARGET, relicIds: [bRelic.id] })
  check('Replace: applied behavior reported', replaceResult.relicEquippingBehavior.applied === 'Replace')
  const replaceMove = replaceResult.changes.find((c) => c.relicId === bRelic.id)
  check('Replace: relic taken from previous owner', replaceMove?.from === CHAR_B && replaceMove?.to === TARGET, JSON.stringify(replaceMove))
  const displacedMove = replaceResult.changes.find((c) => c.relicId === displacedByReplace)
  check('Replace: displaced relic returned to inventory', displacedMove?.from === TARGET && displacedMove?.to === null, JSON.stringify(displacedMove))
  check(
    'Replace: conflicts narrate the takeover',
    replaceResult.conflicts.some((c) => c.includes(bRelic.id) && c.includes(CHAR_B)),
    replaceResult.conflicts.join(' | '),
  )

  // 6. Swap behavior: take a relic off CHAR_C with forceSwap
  const cRelics = await callTool(client, 'list_relics', { equippedBy: CHAR_C, limit: 500 })
  const cRelic = cRelics.relics[0]
  const displacedBySwap = replaceResult.build.relics[cRelic.part]?.id
  const swapResult = await callTool(client, 'equip_build', { characterId: TARGET, relicIds: [cRelic.id], forceSwap: true })
  check('Swap: applied behavior reported', swapResult.relicEquippingBehavior.applied === 'Swap')
  const swapTake = swapResult.changes.find((c) => c.relicId === cRelic.id)
  check('Swap: relic taken from previous owner', swapTake?.from === CHAR_C && swapTake?.to === TARGET, JSON.stringify(swapTake))
  const swapGive = swapResult.changes.find((c) => c.relicId === displacedBySwap)
  check('Swap: displaced relic moved to the previous owner', swapGive?.from === TARGET && swapGive?.to === CHAR_C, JSON.stringify(swapGive))
  const cRelicAfter = (await callTool(client, 'list_relics', { equippedBy: TARGET, limit: 500 })).relics.find((r) => r.id === cRelic.id)
  check('Swap: inventory agrees relic now on target', cRelicAfter != null, `equippedBy=${cRelicAfter?.equippedBy}`)

  // 7. unequip_character
  const unequipped = await callTool(client, 'unequip_character', { characterId: CHAR_UNEQUIP })
  check('unequip_character cleared the slots', unequipped.clearedSlots === 5, `cleared ${unequipped.clearedSlots}`)
  check('unequip_character leaves nothing equipped', (await equippedIdsBy(client, CHAR_UNEQUIP)).length === 0)

  // 8. switch_relics
  const beforeB = await equippedIdsBy(client, CHAR_B)
  const beforeC = await equippedIdsBy(client, CHAR_C)
  const switched = await callTool(client, 'switch_relics', { characterIdA: CHAR_B, characterIdB: CHAR_C })
  const afterB = await equippedIdsBy(client, CHAR_B)
  const afterC = await equippedIdsBy(client, CHAR_C)
  check(
    'switch_relics swapped both sides',
    JSON.stringify(afterB) === JSON.stringify(beforeC) && JSON.stringify(afterC) === JSON.stringify(beforeB),
    `B: ${afterB.length} relics, C: ${afterC.length} relics`,
  )
  check(
    'switch_relics returns both builds',
    Object.keys(switched.buildA.relics).length === beforeC.length
      && Object.keys(switched.buildB.relics).length === beforeB.length,
  )

  // 9. saved builds: current equipment + optimizer row, then round trip
  const savedCurrent = await callTool(client, 'save_build', { characterId: TARGET, name: 'mcp-current' })
  check('save_build (current) stores a character-source build', savedCurrent.saved.source === 'character', savedCurrent.saved.source)
  check(
    'save_build (current) resolves DPS scoring for a DPS character',
    savedCurrent.saved.scoringConfigType === 'dps',
    `scoringConfigType=${savedCurrent.saved.scoringConfigType}`,
  )

  // 9c. scoring resolution is per-character, not hardcoded DPS: Natasha (1105,
  // in the sample save) only has a healSimulation — her character-tab build
  // must save with the HEAL config type and the heal sim's default teammates
  // (upstream buildService → resolveShowcaseScoringOrder chain)
  const savedHeal = await callTool(client, 'save_build', { characterId: '1105', name: 'mcp-heal' })
  check(
    '9c: save_build resolves HEAL scoring for Natasha (no DPS hardcode)',
    savedHeal.saved.scoringConfigType === 'heal',
    `scoringConfigType=${savedHeal.saved.scoringConfigType}`,
  )
  check(
    '9c: heal build snapshots the heal simulation default team',
    Array.isArray(savedHeal.saved.team) && savedHeal.saved.team.length === 3 && savedHeal.saved.team.every((id) => id != null),
    `team=${JSON.stringify(savedHeal.saved.team)}`,
  )
  const savedRow = await callTool(client, 'save_build', { characterId: TARGET, name: 'mcp-opt-row', fromCache: { cacheId, rowId: row1Id } })
  check('save_build (fromCache) stores an optimizer-source build', savedRow.saved.source === 'optimizer', savedRow.saved.source)
  let dupRejected = false
  try {
    await callTool(client, 'save_build', { characterId: TARGET, name: 'mcp-current' })
  } catch {
    dupRejected = true
  }
  check('save_build rejects duplicate names without overwrite', dupRejected)

  const builds = await callTool(client, 'list_builds', { characterId: TARGET })
  check(
    'list_builds shows both builds',
    builds.total === 2
      && builds.builds.some((b) => b.name === 'mcp-current')
      && builds.builds.some((b) => b.name === 'mcp-opt-row'),
    JSON.stringify(builds.builds.map((b) => b.name)),
  )

  const equippedSaved = await callTool(client, 'equip_saved_build', { characterId: TARGET, buildName: 'mcp-opt-row' })
  const equippedSavedIds = Object.values(equippedSaved.build.relics).map((r) => r?.id).sort()
  check('equip_saved_build equips the stored row', JSON.stringify(equippedSavedIds) === JSON.stringify([...row1Ids].sort()), `${equippedSavedIds.join(',')}`)

  const deleted = await callTool(client, 'delete_build', { characterId: TARGET, name: 'mcp-current' })
  check('delete_build removes the build', deleted.remaining === 1, `remaining ${deleted.remaining}`)

  // 9b. save_build fromCache must snapshot the form the run ACTUALLY used —
  // an optimize with formOverrides (lightConeSuperimposition 1 → 5) has to be
  // reflected in the saved build's form snapshot, not the stored character form
  const overrideSi = 5
  const overrideRun = await callTool(client, 'optimize', {
    characterId: TARGET,
    formOverrides: { lightConeSuperimposition: overrideSi },
  }, { timeout: 300_000 })
  check('9b: overridden optimize completed', overrideRun.status === 'completed', `${overrideRun.status}, ${overrideRun.rows.length} rows`)
  const overrideRowId = overrideRun.rows[0].id
  const savedOverride = await callTool(client, 'save_build', {
    characterId: TARGET,
    name: 'mcp-override-row',
    fromCache: { cacheId: overrideRun.summary.cacheId, rowId: overrideRowId },
  })
  check(
    '9b: fromCache snapshot reflects the formOverrides run form',
    savedOverride.saved.source === 'optimizer' && savedOverride.saved.lightConeSuperimposition === overrideSi,
    `source=${savedOverride.saved.source}, s${savedOverride.saved.lightConeSuperimposition} (expected s${overrideSi})`,
  )
  let mismatchRejected = false
  try {
    await callTool(client, 'save_build', {
      characterId: CHAR_B,
      name: 'mcp-wrong-owner',
      fromCache: { cacheId: overrideRun.summary.cacheId, rowId: overrideRowId },
    })
  } catch {
    mismatchRejected = true
  }
  check('9b: fromCache rejects a cache owned by another character', mismatchRejected)

  // 10. score_relics
  const scored = await callTool(client, 'score_relics', { characterId: TARGET, limit: 500 })
  check('score_relics total = 162', scored.total === 162, `got ${scored.total}`)
  check('score_relics returned all relics', scored.relics.length === 162, `${scored.relics.length} in page`)
  check(
    'score_relics rating/percent present on every relic',
    scored.relics.every(
      (r) => typeof r.current?.percentScore === 'number' && typeof r.current?.rating === 'string' && r.current.rating.length > 0,
    ),
  )
  const ratedLetters = scored.relics.filter((r) => r.current.rating !== '?')
  // '?' is legitimate for non-5★ relics and 5★ with off-meta main stats for the focus character
  check('score_relics produces real letter grades', ratedLetters.length > 80, `${ratedLetters.length} letter-graded`)
  const fiveStar = scored.relics.filter((r) => r.grade === 5)
  const nonFiveStar = scored.relics.filter((r) => r.grade !== 5)
  check(
    'score_relics estTbp present on all 5★',
    fiveStar.length > 0 && fiveStar.every((r) => typeof r.estTbpDays === 'number' && r.estTbpDays >= 0),
    `${fiveStar.length} 5★`,
  )
  check('score_relics estTbp absent on non-5★', nonFiveStar.every((r) => r.estTbpDays === undefined), `${nonFiveStar.length} non-5★`)
  check(
    'score_relics potential quartile present',
    scored.relics.every(
      (r) =>
        typeof r.potential?.currentPct === 'number' && typeof r.potential?.bestPct === 'number'
        && typeof r.potential?.averagePct === 'number' && typeof r.potential?.worstPct === 'number',
    ),
  )
  console.log(`        score_relics: ${scored.durationMs}ms for ${scored.relics.length} relics (incl. estTBP on ${fiveStar.length} 5★)`)
  const grade4Count = scored.relics.filter((r) => r.grade === 4).length
  const scoredFiltered = await callTool(client, 'score_relics', { characterId: TARGET, relicFilters: { grade: 4 }, limit: 500 })
  check(
    'score_relics relicFilters narrow the set',
    scoredFiltered.total === grade4Count
      && scoredFiltered.relics.every((r) => r.grade === 4 && r.estTbpDays === undefined),
    `total=${scoredFiltered.total} (expected ${grade4Count})`,
  )

  // 11. dps_score
  const progressEvents = []
  const dpsStart = Date.now()
  const dps = await callTool(client, 'dps_score', { characterId: TARGET, team: 'default' }, {
    timeout: 120_000,
    onprogress: (p) => progressEvents.push(p),
  })
  const dpsWall = Date.now() - dpsStart
  check(
    'dps_score percent sane (0–200 display scale)',
    typeof dps.percent === 'number' && dps.percent >= 0 && dps.percent <= 2,
    `percent=${(dps.percent * 100).toFixed(1)}% grade=${dps.grade}`,
  )
  check('dps_score grade non-empty', typeof dps.grade === 'string' && dps.grade.length > 0, dps.grade)
  check(
    'dps_score four score groups',
    [dps.scores?.original, dps.scores?.baseline, dps.scores?.benchmark, dps.scores?.maximum].every((v) => typeof v === 'number'),
    JSON.stringify(dps.scores),
  )
  check(
    'dps_score substat upgrades non-empty',
    Array.isArray(dps.upgrades?.substats) && dps.upgrades.substats.length > 0,
    `${dps.upgrades?.substats?.length} substat, ${dps.upgrades?.sets?.length} set, ${dps.upgrades?.mains?.length} main, ${dps.upgrades?.teammateOrnaments?.length} teammate`,
  )
  check(
    'dps_score upgrade entries carry part/stat/percent/delta',
    dps.upgrades.substats.every(
      (u) => u.stat != null && typeof u.percent === 'number' && typeof u.delta === 'number' && u.simScore != null,
    ),
  )
  check(
    'dps_score SPD fields present',
    typeof dps.originalSpd === 'number' && (dps.benchmarkSpd === null || typeof dps.benchmarkSpd === 'number'),
    `originalSpd=${dps.originalSpd}, benchmarkSpd=${dps.benchmarkSpd}`,
  )
  const dpsRoundTrip = JSON.parse(JSON.stringify(dps))
  check(
    'dps_score payload JSON round-trips with types intact',
    typeof dpsRoundTrip.percent === 'number' && Number.isFinite(dpsRoundTrip.percent)
      && typeof dpsRoundTrip.grade === 'string' && dpsRoundTrip.grade.length > 0
      && Array.isArray(dpsRoundTrip.upgrades?.substats)
      && dpsRoundTrip.upgrades.substats.every((u) => typeof u.percent === 'number' && typeof u.stat === 'string'),
    `percent=${typeof dpsRoundTrip.percent}, grade=${typeof dpsRoundTrip.grade}, ${dpsRoundTrip.upgrades?.substats?.length} upgrades`,
  )
  check('dps_score under 10s', dps.timing.totalMs < 10_000, `totalMs=${dps.timing.totalMs} (wall ${dpsWall}ms)`)
  check('dps_score sent progress notifications', progressEvents.length >= 1, `${progressEvents.length} event(s)`)
  console.log(`        dps_score: ${(dps.percent * 100).toFixed(1)}% ${dps.grade}, scores=${JSON.stringify(dps.scores)}, ${dps.timing.totalMs}ms`)

  // 12. scoring overrides round trip
  const metaBefore = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check('get_scoring_metadata returns stats/parts', metaBefore.stats != null && metaBefore.parts != null, `modified=${metaBefore.modified}`)
  const overridden = await callTool(client, 'set_scoring_override', { characterId: TARGET, weights: { 'CRIT DMG': 0.5 } })
  check('set_scoring_override applies the weight', overridden.stats['CRIT DMG'] === 0.5, JSON.stringify(overridden.override?.stats))
  check('set_scoring_override flags modified', overridden.modified === true && overridden.override?.stats != null)
  const metaAfter = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check('get_scoring_metadata reflects the override', metaAfter.stats['CRIT DMG'] === 0.5 && metaAfter.modified === true)
  check(
    'get_scoring_metadata exposes defaults + simulations',
    metaAfter.defaults?.stats != null && Object.keys(metaAfter.simulations ?? {}).length >= 1,
    `simulations: ${Object.keys(metaAfter.simulations ?? {}).join(',')}`,
  )
  const reset = await callTool(client, 'set_scoring_override', { characterId: TARGET, reset: true })
  check(
    'set_scoring_override reset restores defaults',
    reset.override === null && reset.stats['CRIT DMG'] === metaBefore.stats['CRIT DMG'] && reset.modified === false,
  )

  // 13. character lifecycle
  const upserted = await callTool(client, 'upsert_character', {
    characterId: NEW_CHAR,
    lightCone: NEW_CHAR_LC,
    characterEidolon: 1,
    lightConeSuperimposition: 2,
  })
  check(
    'upsert_character creates the character',
    upserted.created === true && upserted.form.lightCone === NEW_CHAR_LC,
    `rank=${upserted.rank}, lc=${upserted.form.lightCone}, e${upserted.form.characterEidolon}`,
  )
  const updated = await callTool(client, 'upsert_character', { characterId: NEW_CHAR, characterEidolon: 6 })
  check('upsert_character updates in place', updated.created === false && updated.form.characterEidolon === 6 && updated.form.lightCone === NEW_CHAR_LC)
  const ranked = await callTool(client, 'set_character_rank', { characterId: NEW_CHAR, index: 0 })
  check('set_character_rank moves to front', ranked.order[0] === NEW_CHAR, `position ${ranked.order.indexOf(NEW_CHAR)} of ${ranked.order.length}`)
  const deletedChar = await callTool(client, 'delete_character', { characterId: NEW_CHAR })
  check('delete_character removes it', !deletedChar.remainingCharacters.includes(NEW_CHAR), `${deletedChar.remainingCharacters.length} left`)

  // 14. persistence: debounced write-back + export → reload
  await new Promise((r) => setTimeout(r, 2000)) // let the 1s debounce flush to the temp save copy
  const tempSave = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  const persistedEquipped = tempSave.relics.filter((r) => r.equippedBy === TARGET).map((r) => r.id).sort()
  check(
    'write-back persisted equipment into the loaded save file',
    JSON.stringify(persistedEquipped) === JSON.stringify([...row1Ids].sort()),
    `${persistedEquipped.length} relics on ${TARGET}`,
  )

  const exportPath = `${tempDir}/exported-save.json`
  const exported = await callTool(client, 'export_save', { path: exportPath })
  check('export_save wrote a file', existsSync(exportPath) && exported.bytes > 0, `${exported.bytes} bytes`)
  await callTool(client, 'load_save', { path: exportPath })
  const reloadedEquipped = await equippedIdsBy(client, TARGET)
  check('reloaded save keeps the equipped build', JSON.stringify(reloadedEquipped) === JSON.stringify([...row1Ids].sort()), `${reloadedEquipped.length} relics`)
  const reloadedBuilds = await callTool(client, 'list_builds', { characterId: TARGET })
  const reloadedRow = reloadedBuilds.builds.find((b) => b.name === 'mcp-opt-row')
  check(
    'reloaded save keeps the saved build',
    reloadedRow != null && JSON.stringify(Object.values(reloadedRow.equipped).sort()) === JSON.stringify([...row1Ids].sort()),
  )

  // 15. fromCache equip persists the run's form onto the character (web parity:
  // optimizerFormActions.equipClicked → upsertCharacterFromForm before equipping).
  // The optimize below overrides lightConeSuperimposition to 5; equipping one of
  // its rows must rewrite the stored character form from s=1 to s=5.
  const formBeforeEquip = await callTool(client, 'get_character', { characterId: TARGET })
  const sBefore = formBeforeEquip.savedForm?.lightConeSuperimposition
  const formRun = await callTool(client, 'optimize', {
    characterId: TARGET,
    formOverrides: { lightConeSuperimposition: overrideSi },
  }, { timeout: 300_000 })
  check('15: formOverrides optimize completed', formRun.status === 'completed', `${formRun.status}`)
  const equipFormRun = await callTool(client, 'equip_build', {
    characterId: TARGET,
    fromCache: { cacheId: formRun.summary.cacheId, rowId: formRun.rows[0].id },
  })
  check(
    '15: fromCache equip fills 6 slots',
    Object.keys(equipFormRun.build.relics).length === 6,
    `${Object.keys(equipFormRun.build.relics).length} slots`,
  )
  const formAfterEquip = await callTool(client, 'get_character', { characterId: TARGET })
  check(
    '15: fromCache equip writes the cached form (s=5) onto the character',
    formAfterEquip.savedForm?.lightConeSuperimposition === overrideSi && sBefore !== overrideSi,
    `lightConeSuperimposition: ${sBefore} → ${formAfterEquip.savedForm?.lightConeSuperimposition}`,
  )

  // 16. equipping a build that references deleted relics equips the rest and
  // reports the missing ones in `skipped` (web equipRelicIds skips silently;
  // only ALL-missing is an error). Construct save C from the exported file with
  // one relic referenced by the 'mcp-opt-row' build removed from the inventory.
  const exportedSave = JSON.parse(readFileSync(exportPath, 'utf8'))
  const buildEquipped = Object.values(reloadedRow.equipped).filter((id) => id != null)
  const deletedRelicId = buildEquipped[0]
  const deletedPart = Object.keys(reloadedRow.equipped).find((part) => reloadedRow.equipped[part] === deletedRelicId)
  exportedSave.relics = exportedSave.relics.filter((r) => r.id !== deletedRelicId)
  const partialSavePath = `${tempDir}/partial-save.json`
  writeFileSync(partialSavePath, JSON.stringify(exportedSave))
  await callTool(client, 'load_save', { path: partialSavePath })

  const partialEquip = await callTool(client, 'equip_saved_build', { characterId: TARGET, buildName: 'mcp-opt-row' })
  check(
    '16: missing relics are skipped, the rest equip',
    Object.keys(partialEquip.build.relics).length === buildEquipped.length - 1,
    `${Object.keys(partialEquip.build.relics).length}/${buildEquipped.length - 1} slots`,
  )
  check(
    '16: skipped lists the missing relic with part + id',
    Array.isArray(partialEquip.skipped) && partialEquip.skipped.length === 1
      && partialEquip.skipped[0].relicId === deletedRelicId && partialEquip.skipped[0].part === deletedPart,
    JSON.stringify(partialEquip.skipped),
  )
  let allMissingRejected = false
  try {
    await callTool(client, 'equip_build', { characterId: TARGET, relicIds: ['no-such-relic-1'] })
  } catch {
    allMissingRejected = true
  }
  check('16: equipping only-missing relics still errors', allMissingRejected)

  // 17. the optimize cache is invalidated by load_save (generation check):
  // a run cached before a save swap must be refused, not applied — relic ids
  // from the previous inventory could collide with unrelated relics in the new one.
  const genRun = await callTool(client, 'optimize', { characterId: TARGET }, { timeout: 300_000 })
  check('17: optimize on the partial save completed', genRun.status === 'completed', genRun.status)
  const saveBPath = `${tempDir}/save-b.json`
  copyFileSync(repoSampleSavePath, saveBPath)
  await callTool(client, 'load_save', { path: saveBPath })
  let staleEquipRejected = null
  try {
    await callTool(client, 'equip_build', {
      characterId: TARGET,
      fromCache: { cacheId: genRun.summary.cacheId, rowId: genRun.rows[0].id },
    })
  } catch (e) {
    staleEquipRejected = e
  }
  check(
    '17: fromCache equip rejected after load_save (stale generation)',
    staleEquipRejected != null && /previous save load/.test(String(staleEquipRejected.message))
      && /re-run optimize/.test(String(staleEquipRejected.message)),
    String(staleEquipRejected?.message ?? '(no error)').slice(0, 160),
  )
  let staleSaveRejected = null
  try {
    await callTool(client, 'save_build', {
      characterId: TARGET,
      name: 'mcp-stale',
      fromCache: { cacheId: genRun.summary.cacheId, rowId: genRun.rows[0].id },
    })
  } catch (e) {
    staleSaveRejected = e
  }
  check(
    '17: fromCache save_build rejected after load_save too',
    staleSaveRejected != null && /previous save load/.test(String(staleSaveRejected.message)),
    String(staleSaveRejected?.message ?? '(no error)').slice(0, 160),
  )

  // 18. outputSchema regression (P1-B): upstream semantics keep empty slots as
  // equipped[part] = undefined with the key retained (equipmentService
  // unequipRelic / unequipCharacter / equipRelic Replace branch), and
  // buildConverter spreads that map as-is into SavedBuild.equipped. The
  // saved-build summary must drop those keys — z.record(z.string(), z.string())
  // rejects undefined values, and an outputSchema validation failure discards
  // the entire structuredContent (isError) even though the change already
  // landed in the store, poisoning every later list_builds in the session.
  // save-b was just loaded, so CHAR_UNEQUIP (5 relics) and CHAR_B (6 relics)
  // are in their pristine sample state.
  await callTool(client, 'unequip_character', { characterId: CHAR_UNEQUIP })
  let emptySaved = null
  let emptySaveError = null
  try {
    emptySaved = await callTool(client, 'save_build', { characterId: CHAR_UNEQUIP, name: 'mcp-unequipped' })
  } catch (e) {
    emptySaveError = e
  }
  check(
    '18a: save_build after unequip_character succeeds (undefined slots dropped)',
    emptySaveError == null && emptySaved?.saved?.source === 'character',
    String(emptySaveError?.message ?? '').slice(0, 160),
  )
  check(
    '18a: saved.equipped has no empty-slot keys left',
    emptySaved != null && Object.keys(emptySaved.saved.equipped).length === 0,
    `equipped=${JSON.stringify(emptySaved?.saved?.equipped)}`,
  )

  // 18b: Replace takeover empties the victim's slot in place — saving the
  // VICTIM must succeed with exactly that slot omitted and every summary
  // field still complete.
  const bRelics18 = await callTool(client, 'list_relics', { equippedBy: CHAR_B, limit: 500 })
  const stolen = bRelics18.relics[0]
  await callTool(client, 'equip_build', { characterId: TARGET, relicIds: [stolen.id] })
  let victimSaved = null
  let victimSaveError = null
  try {
    victimSaved = await callTool(client, 'save_build', { characterId: CHAR_B, name: 'mcp-replace-victim' })
  } catch (e) {
    victimSaveError = e
  }
  check(
    '18b: save_build for a Replace victim succeeds',
    victimSaveError == null && victimSaved?.saved?.source === 'character',
    String(victimSaveError?.message ?? '').slice(0, 160),
  )
  const victimEquipped = victimSaved?.saved?.equipped ?? { '(payload lost)': '(payload lost)' }
  check(
    '18b: victim equipped misses exactly the stolen slot, no undefined values',
    Object.keys(victimEquipped).length === 5
      && victimEquipped[stolen.part] === undefined
      && Object.values(victimEquipped).every((id) => typeof id === 'string'),
    `${Object.keys(victimEquipped).length}/6 slots, missing ${stolen.part}`,
  )
  check(
    '18b: summary fields stay complete around equipped',
    victimSaved?.saved?.name === 'mcp-replace-victim'
      && victimSaved.saved.characterId === CHAR_B
      && typeof victimSaved.saved.characterEidolon === 'number'
      && typeof victimSaved.saved.lightConeSuperimposition === 'number'
      && typeof victimSaved.saved.lightCone === 'string'
      && Array.isArray(victimSaved.saved.team) && victimSaved.saved.team.length === 3,
    JSON.stringify({
      lc: victimSaved?.saved?.lightCone,
      s: victimSaved?.saved?.lightConeSuperimposition,
      e: victimSaved?.saved?.characterEidolon,
      team: victimSaved?.saved?.team,
    }),
  )

  // 18c: list_builds across every character stays healthy — with an unfiltered
  // summary the poisoned builds make this call an isError forever.
  let allBuilds = null
  let allBuildsError = null
  try {
    allBuilds = await callTool(client, 'list_builds', {})
  } catch (e) {
    allBuildsError = e
  }
  check(
    '18c: list_builds (all characters) survives the empty-slot builds',
    allBuildsError == null && allBuilds.total >= 2
      && allBuilds.builds.every((b) => Object.values(b.equipped ?? {}).every((id) => id != null)),
    String(allBuildsError?.message ?? `${allBuilds?.total} builds`),
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-equip: ALL CHECKS PASSED' : `\nsmoke-equip: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
