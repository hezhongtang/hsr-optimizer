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
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll duplicate-relic smoke checks passed')
