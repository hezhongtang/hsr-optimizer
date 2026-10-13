// Duplicate relic id reporting smoke (load_save / save_status / boot restore).
//
// A save can carry one relic id on two records (the same relic at two enhance
// levels). The upstream load chain keeps both in the relics array and indexes
// them last-write-wins; MCP loads through the same chain and must only REPORT
// the condition, never repair it. Against the built server (dist/index.js):
//   - a clean save (the repo sample, copied to a temp dir) reports an empty
//     duplicateRelicIds from load_save and save_status, and both summaries are
//     the exact pre-existing strings — save_status before anything is loaded
//     reports empty too
//   - the same save with one injected pair reports it: count, ids, both
//     records with their enhance levels and array positions, and which record
//     id lookups resolve to (the last one — upstream relicsById)
//   - reporting changes nothing: both records stay in the inventory, the load
//     is clean, the save file is byte-identical, the legacy output fields of
//     both tools are untouched
//   - the report matches what detail paths show: get_character resolves the
//     wearer's slot to the record flagged resolvedById (the stale one here)
//   - the field tracks the live store: the first relic write makes the
//     upstream store drop the unindexed record, and save_status goes back to
//     empty (pins the upstream collapse the tool description relies on)
//   - a save whose whole inventory is duplicated reports the full count but
//     lists only the first 50 ids
//   - the boot restore prints one stderr warning for a state holding the pair
//     and none for a clean state; save_status reports the pair either way
//   - dedupe_relics merges on request only: dryRun reports and changes nothing;
//     the real call keeps the highest-enhance record of each id whose records
//     are states of one relic, leaves ids whose records differ untouched, and
//     settles who wears the relic (the kept record's wearer, else the dropped
//     record's; a second character whose slot pointed at the id loses it);
//     the merged inventory is what export_save writes; a clean save is a no-op
//
// Usage: node scripts/smoke-duplicate-relics.mjs [serverEntry]

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
import { isDeepStrictEqual } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const sample = JSON.parse(readFileSync(resolve(mcpDir, '../src/data/sample-save.json'), 'utf8'))

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-duplicate-relics-`)
const cleanPath = `${tempDir}/clean-save.json`
const injectedPath = `${tempDir}/injected-save.json`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The injected pair mirrors the shape found in real saves: the current record
// (+15, four substats, worn) stays where it is, and a stale record of the same
// id (+0, three substats, not worn) sits at the end of the array.
const originalIndex = sample.relics.findIndex((r) => r.equippedBy && r.enhance === 15 && r.substats.length === 4)
if (originalIndex < 0) throw new Error('sample save has no worn +15 relic with four substats to duplicate')
const original = sample.relics[originalIndex]
const { equippedBy: wearer, ...unworn } = structuredClone(original)
const stale = { ...unworn, enhance: 0, substats: unworn.substats.slice(0, 3) }
const injected = { ...structuredClone(sample), relics: [...structuredClone(sample.relics), stale] }
const staleIndex = injected.relics.length - 1
const otherWornId = sample.relics.find((r) => r.equippedBy === wearer && r.id !== original.id).id

writeFileSync(cleanPath, JSON.stringify(sample))
writeFileSync(injectedPath, JSON.stringify(injected))
const injectedBytes = readFileSync(injectedPath, 'utf8')

const EMPTY = { count: 0, ids: [], entries: [], truncated: false }
const REPORTED_IDS = 50
const expectedPair = {
  count: 1,
  ids: [original.id],
  entries: [{
    id: original.id,
    records: [
      { index: originalIndex, part: original.part, set: original.set, enhance: 15, equippedBy: wearer, resolvedById: false },
      { index: staleIndex, part: original.part, set: original.set, enhance: 0, equippedBy: null, resolvedById: true },
    ],
  }],
  truncated: false,
}

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Connect a fresh server over its own state file; stderr is captured so the
 * boot restore's lines can be asserted. */
async function startServer(name, statePath) {
  const client = new Client({ name, version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: statePath },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  await client.connect(transport)
  return {
    stderr: () => stderr,
    async call(tool, args = {}) {
      const result = await client.callTool({ name: tool, arguments: args })
      if (result.isError) throw new Error(`tool ${tool} returned isError: ${result.content?.[0]?.text}`)
      return { payload: result.structuredContent, text: result.content?.find((c) => c.type === 'text')?.text ?? '' }
    },
    /** Resolves once the child's stderr has drained, so "this line was never
     * printed" can be asserted on the complete output. */
    async close() {
      const drained = transport.stderr.readableEnded ? Promise.resolve() : new Promise((r) => transport.stderr.once('end', r))
      await client.close()
      await Promise.race([drained, sleep(3000)])
    },
  }
}

/** stderr arrives on its own pipe, with no ordering against tool responses. */
async function waitForStderr(server, needle, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!server.stderr().includes(needle) && Date.now() < deadline) await sleep(50)
  return server.stderr().includes(needle)
}

function withoutDuplicates(payload) {
  const { duplicateRelicIds: _dropped, ...legacy } = payload
  return Object.keys(legacy).sort()
}

try {
  // ── load_save / save_status ────────────────────────────────────────────────
  const server = await startServer('smoke-duplicate-relics', `${tempDir}/localstorage.json`)
  try {
    const cold = await server.call('save_status')
    check('save_status with no save loaded reports no duplicates', isDeepStrictEqual(cold.payload.duplicateRelicIds, EMPTY))

    const cleanLoad = await server.call('load_save', { path: cleanPath })
    check(
      'load_save of a clean save reports an empty duplicateRelicIds',
      isDeepStrictEqual(cleanLoad.payload.duplicateRelicIds, EMPTY) && cleanLoad.payload.relics === sample.relics.length,
      JSON.stringify(cleanLoad.payload.duplicateRelicIds),
    )
    const cleanStatus = await server.call('save_status')
    check('save_status of a clean save reports an empty duplicateRelicIds', isDeepStrictEqual(cleanStatus.payload.duplicateRelicIds, EMPTY))
    const counted = `${sample.relics.length} 件遗器、${sample.characters.length} 个角色`
    check(
      'clean summaries are the exact pre-existing strings',
      cleanLoad.text === `已载入存档:${counted}(来自 ${cleanPath})` && cleanStatus.text === `存档已载入(来自 ${cleanPath}):${counted}`,
      `${cleanLoad.text} | ${cleanStatus.text}`,
    )

    const load = await server.call('load_save', { path: injectedPath })
    check(
      'load_save reports the injected pair (ids, enhance levels, positions, resolved record)',
      isDeepStrictEqual(load.payload.duplicateRelicIds, expectedPair),
      JSON.stringify(load.payload.duplicateRelicIds),
    )
    check(
      'load_save keeps both records (no dedupe on load)',
      load.payload.relics === sample.relics.length + 1,
      `relics=${load.payload.relics} sample=${sample.relics.length}`,
    )
    check('load_save summary warns and names the id', load.text.includes('⚠') && load.text.includes(`${original.id}(+15/+0)`), load.text.slice(-160))
    check(
      'load_save legacy output fields are unchanged',
      isDeepStrictEqual(withoutDuplicates(load.payload), ['characterIds', 'characters', 'loaded', 'path', 'relics', 'version']),
      withoutDuplicates(load.payload).join(','),
    )

    const status = await server.call('save_status')
    check('save_status reports the same pair', isDeepStrictEqual(status.payload.duplicateRelicIds, expectedPair))
    check('save_status summary warns and names the id', status.text.includes('⚠') && status.text.includes(original.id))
    check(
      'save_status legacy output fields are unchanged',
      isDeepStrictEqual(
        withoutDuplicates(status.payload),
        ['blockedWrite', 'bootLoaded', 'characterIds', 'characters', 'dirty', 'generation', 'lastOptimize', 'loaded', 'path', 'relics', 'revision'],
      ),
      withoutDuplicates(status.payload).join(','),
    )
    check(
      'reporting is read-only: load stays clean and the save file is byte-identical',
      status.payload.dirty === false && readFileSync(injectedPath, 'utf8') === injectedBytes,
    )

    // The symptom the report explains: the wearer's slot resolves by id to the
    // stale record, although the record carrying equippedBy is the +15 one.
    const worn = (await server.call('get_character', { characterId: wearer })).payload.equippedSlots[original.part]
    check(
      'get_character resolves the wearer\'s slot to the record flagged resolvedById',
      worn.equippedId === original.id && worn.relic.enhance === 0,
      `equippedId=${worn.equippedId} enhance=${worn.relic?.enhance}`,
    )

    // Upstream collapse: upsertRelic rebuilds the array from relicsById, so any
    // relic write drops the unindexed (+15) record. Re-equipping a relic the
    // wearer already has is enough.
    await server.call('equip_build', { characterId: wearer, relicIds: [otherWornId] })
    const collapsed = await server.call('save_status')
    check(
      'after a relic write the upstream store has dropped the unindexed record and the report is empty again',
      isDeepStrictEqual(collapsed.payload.duplicateRelicIds, EMPTY) && collapsed.payload.relics === sample.relics.length,
      `relics=${collapsed.payload.relics} duplicates=${collapsed.payload.duplicateRelicIds.count}`,
    )
    const survivor = (await server.call('get_character', { characterId: wearer })).payload.equippedSlots[original.part]
    check('the record that survives the collapse is the stale one', survivor.relic?.enhance === 0, `enhance=${survivor.relic?.enhance}`)

    // Whole inventory duplicated: the total is exact, the listing is capped.
    const doubled = { ...structuredClone(sample), relics: [...structuredClone(sample.relics), ...structuredClone(sample.relics)] }
    const flood = (await server.call('load_save', { json: doubled })).payload.duplicateRelicIds
    check(
      `a fully duplicated inventory reports the total and lists the first ${REPORTED_IDS} ids`,
      flood.count === sample.relics.length && flood.truncated === true
        && flood.ids.length === REPORTED_IDS && flood.entries.length === REPORTED_IDS
        && isDeepStrictEqual(flood.ids, sample.relics.slice(0, REPORTED_IDS).map((r) => r.id)),
      `count=${flood.count} ids=${flood.ids.length} entries=${flood.entries.length} truncated=${flood.truncated}`,
    )
  } finally {
    await server.close()
  }

  // ── boot restore ───────────────────────────────────────────────────────────
  // The localStorage backend file is a { key: string } map; its `state` key is
  // what the boot restore loads (web: localStorage['state']).
  const bootCases = [
    { label: 'injected', save: injected, expected: expectedPair, warns: true },
    { label: 'clean', save: sample, expected: EMPTY, warns: false },
  ]
  for (const { label, save, expected, warns } of bootCases) {
    const statePath = `${tempDir}/boot-${label}.json`
    writeFileSync(statePath, JSON.stringify({ state: JSON.stringify(save) }))
    const booted = await startServer(`smoke-duplicate-relics-boot-${label}`, statePath)
    try {
      const status = await booted.call('save_status')
      check(
        `boot restore (${label} state): save_status reports ${expected.count} duplicate id(s)`,
        status.payload.bootLoaded === true && isDeepStrictEqual(status.payload.duplicateRelicIds, expected),
        `bootLoaded=${status.payload.bootLoaded} ${JSON.stringify(status.payload.duplicateRelicIds).slice(0, 120)}`,
      )
      // The warning is its own stderr write after the restored line: wait for
      // it directly when expected, and judge its absence on the drained output.
      if (warns) await waitForStderr(booted, 'bootLoad: WARNING')
    } finally {
      await booted.close()
    }
    const warningLines = booted.stderr().split('\n').filter((line) => line.includes('bootLoad: WARNING'))
    check(
      `boot restore (${label} state): ${warns ? 'one stderr warning naming the id' : 'no stderr warning'}`,
      booted.stderr().includes('bootLoad: restored') && (warns
        ? warningLines.length === 1 && warningLines[0].includes(`1 relic id(s)`) && warningLines[0].includes(`${original.id}(+15/+0)`)
        : warningLines.length === 0),
      warningLines[0]?.slice(0, 140) ?? 'no warning line',
    )
  }

  // ── dedupe_relics ──────────────────────────────────────────────────────────
  // Five ids, each with a second record appended behind the current +15 one:
  //   kept worn, +0 state unworn           → merged, wearer unchanged
  //   kept worn, +0 state worn by another  → merged, the other character's slot emptied
  //   kept unworn, +0 state worn           → merged, that character goes on wearing it
  //   +0 record has a substat the current record lacks              → different relics, skipped
  //   +12 record lines up but two substats grew in one enhance step → different relics, skipped
  //   +0 record lines up but has the wrong number of substats for how the +15 one grew → skipped
  // The +0 states are what the relic really was at +0: one roll per substat,
  // and only three substats when the +15 record's rolls show it started with three.
  const fourSubstats = (r) => r.enhance === 15 && r.grade === 5 && r.substats.length === 4
  const contested = sample.relics.find((r) => fourSubstats(r) && r.equippedBy && r.id !== original.id)
  const loose = sample.relics.filter((r) => fourSubstats(r) && !r.equippedBy)
  const [inherited, mismatched, unpayable, miscounted] = loose
  if (!fourSubstats(original) || !contested || !miscounted) throw new Error('sample save lacks the worn/unworn +15 relics the dedupe fixture needs')
  const bystanders = sample.characters.map((c) => c.id).filter((id) => id !== wearer && id !== contested.equippedBy)
  const [rival, heir] = bystanders
  if (!rival || !heir) throw new Error('sample save needs two more characters for the dedupe fixture')
  const indexIn = (relic) => sample.relics.findIndex((r) => r.id === relic.id)
  const substatsOf = (relic) => relic.substats.map(({ stat, value }) => ({ stat, value }))

  const repairer = await startServer('smoke-duplicate-relics-dedupe', `${tempDir}/dedupe-state.json`)
  try {
    await repairer.call('load_save', { path: cleanPath })
    const cleanBefore = (await repairer.call('save_status')).payload
    const noop = (await repairer.call('dedupe_relics')).payload
    const cleanAfter = (await repairer.call('save_status')).payload
    check(
      'dedupe_relics on a clean save merges nothing and leaves revision and dirty alone',
      noop.merged.length === 0 && noop.skipped.length === 0 && noop.relicsAfter === sample.relics.length
        && cleanAfter.revision === cleanBefore.revision && cleanAfter.dirty === false,
      `merged=${noop.merged.length} revision ${cleanBefore.revision}→${cleanAfter.revision} dirty=${cleanAfter.dirty}`,
    )

    // The server's roll breakdown says how each +15 record grew.
    const graded = new Map()
    for (let offset = 0; offset < sample.relics.length; offset += 500) {
      for (const relic of (await repairer.call('list_relics', { offset, limit: 500 })).payload.relics) graded.set(relic.id, relic)
    }
    const rollsOf = (relic) => graded.get(relic.id).substats.map((sub) => ({ ...sub.rolls, added: sub.addedRolls }))
    const oneRoll = (sub, rolls) => {
      const weight = rolls.high > 0 ? 1 : rolls.mid > 0 ? 0.9 : 0.8
      return { stat: sub.stat, value: sub.value * weight / (rolls.high + 0.9 * rolls.mid + 0.8 * rolls.low) }
    }
    const startedWithFour = (relic) => rollsOf(relic).reduce((sum, entry) => sum + entry.added, 0) === 5
    const initialOf = (relic, equippedBy, substatCount = startedWithFour(relic) ? 4 : 3) => {
      const { equippedBy: _owner, ...rest } = structuredClone(relic)
      const rolls = rollsOf(relic)
      const substats = rest.substats.map((sub, i) => oneRoll(sub, rolls[i])).slice(0, substatCount)
      return { ...rest, enhance: 0, substats, ...(equippedBy ? { equippedBy } : {}) }
    }
    const initial = initialOf(original)
    const rivalRecord = initialOf(contested, rival)
    const heirRecord = initialOf(inherited, heir)
    const foreign = initialOf(mismatched)
    const absentStat = ['HP', 'ATK', 'DEF', 'SPD', 'CRIT Rate', 'CRIT DMG'].find((stat) =>
      stat !== mismatched.main.stat && !mismatched.substats.some((sub) => sub.stat === stat)
    )
    foreign.substats[0] = { ...foreign.substats[0], stat: absentStat }
    // One step below +15 a single substat can differ; this record has two smaller ones.
    const twoSmaller = { ...structuredClone(unpayable), enhance: 12 }
    twoSmaller.substats = twoSmaller.substats.map((sub, i) => i < 2 ? { ...sub, value: sub.value * 0.5 } : sub)
    // Every substat is there and none is larger; only the roll counts say this +0 record cannot have become that +15 one.
    const wrongStart = initialOf(miscounted, null, startedWithFour(miscounted) ? 3 : 4)
    check(
      'the fixture\'s +0 states have smaller substat values than the +15 records',
      [[initial, original], [rivalRecord, contested], [heirRecord, inherited]].every(([before, after]) =>
        before.substats.some((sub, i) => sub.value < after.substats[i].value - 1e-6)
      ),
    )

    const mixed = {
      ...structuredClone(sample),
      relics: [...structuredClone(sample.relics), initial, rivalRecord, heirRecord, foreign, twoSmaller, wrongStart],
    }
    const mixedPath = `${tempDir}/mixed-save.json`
    writeFileSync(mixedPath, JSON.stringify(mixed))

    await repairer.call('load_save', { path: mixedPath })
    const loadedStatus = (await repairer.call('save_status')).payload
    const expectedMerged = [
      {
        id: original.id,
        part: original.part,
        set: original.set,
        kept: { index: originalIndex, enhance: 15, substats: substatsOf(original) },
        dropped: [{ index: sample.relics.length, enhance: 0, equippedBy: null, substats: initial.substats }],
        equippedBy: wearer,
        unequipped: [],
      },
      {
        id: contested.id,
        part: contested.part,
        set: contested.set,
        kept: { index: indexIn(contested), enhance: 15, substats: substatsOf(contested) },
        dropped: [{ index: sample.relics.length + 1, enhance: 0, equippedBy: rival, substats: rivalRecord.substats }],
        equippedBy: contested.equippedBy,
        unequipped: [rival],
      },
      {
        id: inherited.id,
        part: inherited.part,
        set: inherited.set,
        kept: { index: indexIn(inherited), enhance: 15, substats: substatsOf(inherited) },
        dropped: [{ index: sample.relics.length + 2, enhance: 0, equippedBy: heir, substats: heirRecord.substats }],
        equippedBy: heir,
        unequipped: [],
      },
    ]
    // Substat values come back as the load pipeline normalised them, a few 1e-5 off the file's.
    const byId = (entries) =>
      JSON.parse(JSON.stringify(entries), (key, value) => key === 'value' ? Math.round(value * 1e3) / 1e3 : value)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const skippedEntry = (relic, index, enhance) => ({
      id: relic.id,
      reason: 'differentRelics',
      records: [
        { index: indexIn(relic), part: relic.part, set: relic.set, enhance: 15 },
        { index, part: relic.part, set: relic.set, enhance },
      ],
    })
    const expectedSkipped = [
      skippedEntry(mismatched, sample.relics.length + 3, 0),
      skippedEntry(unpayable, sample.relics.length + 4, 12),
      skippedEntry(miscounted, sample.relics.length + 5, 0),
    ]

    const preview = await repairer.call('dedupe_relics', { dryRun: true })
    const afterPreview = (await repairer.call('save_status')).payload
    check(
      'dryRun reports the merge plan',
      preview.payload.dryRun === true && isDeepStrictEqual(byId(preview.payload.merged), byId(expectedMerged))
        && isDeepStrictEqual(byId(preview.payload.skipped), byId(expectedSkipped)) && preview.text.startsWith('[dryRun]'),
      JSON.stringify(preview.payload.merged).slice(0, 200),
    )
    check(
      'dryRun changes nothing: same duplicates, revision, relic count, and the save file',
      isDeepStrictEqual(afterPreview.duplicateRelicIds, loadedStatus.duplicateRelicIds) && afterPreview.revision === loadedStatus.revision
        && afterPreview.dirty === false && preview.payload.relicsAfter === mixed.relics.length
        && readFileSync(mixedPath, 'utf8') === JSON.stringify(mixed),
      `count=${afterPreview.duplicateRelicIds.count} revision ${loadedStatus.revision}→${afterPreview.revision}`,
    )

    const applied = (await repairer.call('dedupe_relics')).payload
    check(
      'dedupe_relics merges the three ids whose records are one relic and skips the other three',
      applied.dryRun === false && isDeepStrictEqual(byId(applied.merged), byId(expectedMerged))
        && isDeepStrictEqual(byId(applied.skipped), byId(expectedSkipped))
        && applied.relicsBefore === mixed.relics.length && applied.relicsAfter === mixed.relics.length - 3
        && applied.dirty === true && applied.revision > loadedStatus.revision,
      `merged=${applied.merged.length} skipped=${applied.skipped.length} relics ${applied.relicsBefore}→${applied.relicsAfter}`,
    )
    const afterApply = (await repairer.call('save_status')).payload
    check(
      'afterwards only the skipped ids are still reported, with both records each',
      isDeepStrictEqual([...afterApply.duplicateRelicIds.ids].sort(), [mismatched.id, unpayable.id, miscounted.id].sort())
        && afterApply.duplicateRelicIds.entries.every((entry) => entry.records.length === 2),
      JSON.stringify(afterApply.duplicateRelicIds.ids),
    )
    const slotOf = async (characterId, part) => (await repairer.call('get_character', { characterId })).payload.equippedSlots[part]
    const keptSlot = await slotOf(wearer, original.part)
    const contestedSlot = await slotOf(contested.equippedBy, contested.part)
    const rivalSlot = await slotOf(rival, contested.part)
    const heirSlot = await slotOf(heir, inherited.part)
    check(
      'the wearers of the kept records now resolve to the +15 record',
      keptSlot.equippedId === original.id && keptSlot.relic.enhance === 15
        && contestedSlot.equippedId === contested.id && contestedSlot.relic.enhance === 15,
      `${keptSlot.relic?.enhance}/${contestedSlot.relic?.enhance}`,
    )
    check('the second character whose slot pointed at a merged id has that slot emptied', rivalSlot.equippedId == null, `equippedId=${rivalSlot.equippedId}`)
    check(
      'an unworn kept record is worn by the dropped record\'s wearer, with the current stats',
      heirSlot.equippedId === inherited.id && heirSlot.relic.enhance === 15 && heirSlot.relic.substats.length === 4,
      `equippedId=${heirSlot.equippedId} enhance=${heirSlot.relic?.enhance}`,
    )

    await repairer.call('export_save')
    const written = JSON.parse(readFileSync(mixedPath, 'utf8'))
    const writtenOf = (id) => written.relics.filter((r) => r.id === id)
    check(
      'export_save writes the merged inventory: one +15 record per merged id, both records of each skipped id',
      [original, contested, inherited].every((relic) => writtenOf(relic.id).length === 1 && writtenOf(relic.id)[0].enhance === 15)
        && [mismatched, unpayable, miscounted].every((relic) => writtenOf(relic.id).length === 2) && written.relics.length === mixed.relics.length - 3
        && writtenOf(inherited.id)[0].equippedBy === heir && writtenOf(contested.id)[0].equippedBy === contested.equippedBy,
      `relics=${written.relics.length}`,
    )
    const again = (await repairer.call('dedupe_relics')).payload
    check('a second dedupe_relics has nothing left to merge', again.merged.length === 0 && again.skipped.length === 3)
  } finally {
    await repairer.close()
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll duplicate-relic smoke checks passed')
