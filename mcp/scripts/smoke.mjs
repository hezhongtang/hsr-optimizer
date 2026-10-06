// End-to-end smoke test for the HSR Optimizer MCP server.
//
// Spawns the built server (dist/index.js) over stdio with the SDK client and
// walks the M1 happy path:
//   listTools ≥ 6 → load_save (sample save: 162 relics / 8 characters)
//   → list_relics (162) → optimize 1212b1 (rows ≥ 1, first build = 6 known
//   relic ids, full summary) → cancellation path on a 12x-cloned inventory
//   (progress observed, abort lands, partial results cached) → export_save →
//   reset_all.
//
// Everything the server can persist (loaded save file, localStorage backend)
// is pointed at a temp directory — the repo's sample-save.json is never a
// write target.
//
// Usage: node scripts/smoke.mjs [serverEntry]
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

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-`)
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

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke', version: '0.0.0' })
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
  const toolNames = tools.tools.map((t) => t.name).sort()
  check('listTools count >= 6', tools.tools.length >= 6, `${tools.tools.length}: ${toolNames.join(', ')}`)
  for (const required of ['load_save', 'list_relics', 'optimize', 'get_results']) {
    check(`tool ${required} registered`, toolNames.includes(required))
  }

  // 2. load sample save (temp copy — the server may write back to it)
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save relics = 162', loaded.relics === 162, `got ${loaded.relics}`)
  check('load_save characters = 8', loaded.characters === 8, `got ${loaded.characters}`)

  // 3. list_relics
  const relics = await callTool(client, 'list_relics', { limit: 500 })
  check('list_relics total = 162', relics.total === 162, `got ${relics.total}`)
  const spdRelics = await callTool(client, 'list_relics', { subStat: 'SPD', limit: 500 })
  check('list_relics subStat filter works', spdRelics.total > 0 && spdRelics.total < 162, `${spdRelics.total} with SPD substat`)
  check(
    'list_relics carries roll info',
    relics.relics.every((r) => r.substats.every((s) => s.rolls != null && s.addedRolls != null)),
  )

  // 4. optimize happy path
  const optimizeStart = Date.now()
  const optimized = await callTool(client, 'optimize', { characterId: '1212b1' }, { timeout: 300_000 })
  check('optimize status completed', optimized.status === 'completed', `status=${optimized.status}`)
  check('optimize rows >= 1', optimized.rows.length >= 1, `${optimized.rows.length} rows`)
  check(
    'optimize summary fields',
    ['validPermutations', 'naivePermutations', 'searched', 'durationMs', 'cancelled', 'cacheId', 'gridSortColumn']
      .every((k) => optimized.summary[k] !== undefined),
    JSON.stringify(optimized.summary),
  )

  const inventoryIds = new Set(relics.relics.map((r) => r.id))
  if (relics.total > relics.relics.length) {
    const rest = await callTool(client, 'list_relics', { offset: relics.relics.length, limit: 500 })
    for (const r of rest.relics) inventoryIds.add(r.id)
  }
  const firstBuild = optimized.rows[0]?.build?.relics ?? {}
  const buildSlots = Object.keys(firstBuild)
  const buildIds = Object.values(firstBuild).map((r) => r?.id)
  check('optimize first row has 6 relics', buildSlots.length === 6, `slots: ${buildSlots.join(',')}`)
  check(
    'optimize first build ids all in inventory',
    buildIds.length === 6 && buildIds.every((id) => inventoryIds.has(id)),
    buildIds.join(','),
  )
  console.log(`        optimize took ${Date.now() - optimizeStart}ms, top row id=${optimized.rows[0].id}, COMBO=${optimized.rows[0].stats.COMBO}`)

  // 4b. equippedRow baseline — must match the character's live equipped slots
  const character = await callTool(client, 'get_character', { characterId: '1212b1' })
  const equippedRow = optimized.equippedRow
  check(
    'optimize carries an equippedRow baseline',
    equippedRow != null && equippedRow.stats != null,
    equippedRow ? `stats columns: ${Object.keys(equippedRow.stats).length}` : 'missing',
  )
  check(
    'equippedRow stats carry combat columns',
    equippedRow != null && typeof equippedRow.stats.COMBO === 'number' && typeof equippedRow.stats.EHP === 'number',
    equippedRow ? `COMBO=${equippedRow.stats.COMBO}, EHP=${equippedRow.stats.EHP}` : '',
  )
  check(
    'equippedRow build matches get_character equipped slots',
    equippedRow != null && Object.keys(equippedRow.build.relics).length === 6
      && Object.entries(equippedRow.build.relics).every(([part, relic]) => character.equippedSlots?.[part]?.equippedId === relic.id),
    equippedRow ? Object.values(equippedRow.build.relics).map((r) => r.id).join(',') : '',
  )

  // 5. get_results pagination + filter
  const page = await callTool(client, 'get_results', { offset: 0, limit: 5, filters: [{ column: 'COMBO', min: 0 }] })
  check('get_results pages the cache', page.total === optimized.rows.length && page.rows.length === 5, `total=${page.total}, page=${page.rows.length}`)

  // 6. cancellation path on a cloned (12x) inventory — big enough to abort mid-flight
  const sampleSave = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  const cloned = {
    ...sampleSave,
    relics: [],
  }
  for (let k = 0; k < 12; k++) {
    for (const r of sampleSave.relics) {
      cloned.relics.push({ ...r, id: `${r.id}#${k}`, equippedBy: k === 0 ? r.equippedBy : undefined })
    }
  }
  await callTool(client, 'load_save', { json: cloned })
  const bigRelics = await callTool(client, 'list_relics', { limit: 1 })
  check('cloned inventory loaded', bigRelics.total === 162 * 12, `${bigRelics.total}`)

  const progressEvents = []
  const abortController = new AbortController()
  let cancelledRunError = null
  const cancelledPromise = callTool(
    client,
    'optimize',
    { characterId: '1212b1', force: true, resultsLimit: 1024 },
    {
      signal: abortController.signal,
      timeout: 600_000,
      resetTimeoutOnProgress: true,
      onprogress: (p) => {
        progressEvents.push(p)
        if (progressEvents.length >= 1) abortController.abort()
      },
    },
  ).catch((e) => {
    cancelledRunError = e
    return null
  })
  await cancelledPromise
  check('cancel path: progress observed before abort', progressEvents.length >= 1, `${progressEvents.length} progress event(s)`)
  console.log(`        cancel path: client promise settled as ${cancelledRunError ? `rejection (${cancelledRunError.message})` : 'resolution'}`)

  // The server-side handler keeps running after client abort and caches partial results.
  let cancelledCache = null
  const cancelDeadline = Date.now() + 120_000
  while (Date.now() < cancelDeadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const results = await callTool(client, 'get_results', { limit: 1 })
    if (results.cacheId !== optimized.summary.cacheId) {
      cancelledCache = results
      break
    }
  }
  check('cancel path: new cache was written', cancelledCache != null, cancelledCache ? `total=${cancelledCache.total}` : 'still previous cache')
  check(
    'cancel path: cache summary reports cancelled',
    cancelledCache?.summary?.cancelled === true,
    `summary.cancelled=${String(cancelledCache?.summary?.cancelled)}`,
  )

  // restore the sample save (from the temp copy) for the export check
  await callTool(client, 'load_save', { path: sampleSavePath })

  // 7. export_save round-trip and reset_all
  const exportPath = `${tempDir}/exported-save.json`
  const exported = await callTool(client, 'export_save', { path: exportPath })
  const exportedData = JSON.parse(readFileSync(exportPath, 'utf8'))
  check('export_save wrote a parseable save file', existsSync(exportPath) && exportedData.relics?.length === 162, `${exported.bytes} bytes`)

  const reset = await callTool(client, 'reset_all', {})
  check('reset_all clears the inventory', reset.relics === 0 && reset.characters === 0, JSON.stringify(reset))

  // Give the debounced write-back a chance to fire, then verify the guard held
  // (the non-empty save file must NOT have been overwritten with the wipe)
  await new Promise((r) => setTimeout(r, 2000))
  const afterReset = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  check('reset write-back guard held', (afterReset.relics?.length ?? 0) === 162, `${afterReset.relics?.length} relics still on disk`)

  // 8. empty-characters save switch — write-backs must not be silently swallowed.
  // SaveState.save() carries its own anti-wipe guard comparing the stores
  // against its localStorage 'state' reference; load_save must resync that
  // reference to the save it just loaded. Pre-fix, the reference stayed on the
  // PREVIOUS save, so after switching to a save with zero characters every
  // relic-side write of the session was refused upstream, reported as success
  // and never reached the disk (dirty cleared, flush a silent no-op).
  const emptyCharsSave = { ...sampleSave, characters: [] }
  const emptyCharsPath = `${tempDir}/empty-chars-save.json`
  writeFileSync(emptyCharsPath, JSON.stringify(emptyCharsSave))

  // 8a. re-load the populated save and land one flushed mutation so the guard's
  // reference holds a populated state (mirrors a real working session)
  await callTool(client, 'load_save', { path: sampleSavePath })
  await callTool(client, 'save_team', { name: 'guard-reference', characterIds: ['1212'] })
  await new Promise((r) => setTimeout(r, 2000))

  // 8b. switch to the empty-characters save and mutate the relic-side state
  const switched = await callTool(client, 'load_save', { path: emptyCharsPath })
  check(
    'switched to the empty-characters save (162 relics / 0 characters)',
    switched.relics === 162 && switched.characters === 0,
    `${switched.relics}/${switched.characters}`,
  )
  await callTool(client, 'save_team', { name: 'post-switch', characterIds: ['1005'] })
  await new Promise((r) => setTimeout(r, 2000))

  const afterSwitch = JSON.parse(readFileSync(emptyCharsPath, 'utf8'))
  const teamsOnDisk = afterSwitch.savedSession?.global?.teamShowcaseSavedTeams ?? []
  check(
    'write-back lands after switching to an empty-characters save',
    teamsOnDisk.some((t) => t.name === 'post-switch'),
    `teams on disk: ${teamsOnDisk.map((t) => t.name).join(', ') || '(none — writes were swallowed)'}`,
  )
  check(
    'empty-characters save keeps its shape (162 relics / 0 characters, not wiped)',
    (afterSwitch.relics?.length ?? 0) === 162 && (afterSwitch.characters?.length ?? 0) === 0,
    `${afterSwitch.relics?.length} relics / ${afterSwitch.characters?.length} characters`,
  )

  // 9. load_save cancels the pending debounced flush. A mutation on save A
  // arms the 1s debounce; loading save B right after must not let that stale
  // timer fire and write B's freshly loaded (normalized) state back out
  // unrequested — the write-back would also strip unknown top-level keys like
  // the marker below from B's file.
  {
    await callTool(client, 'load_save', { path: sampleSavePath })
    await callTool(client, 'save_team', { name: 'debounce-cancel-probe', characterIds: ['1212'] }) // arms the 1s timer
    const saveBPath = `${tempDir}/debounce-target.json`
    // marker key first so a normalized write-back is guaranteed to differ
    const saveBRaw = readFileSync(repoSampleSavePath, 'utf8').replace(/^\{/, '{"__mcpDebounceMarker":"keep-me",')
    writeFileSync(saveBPath, saveBRaw)
    const bytesBefore = readFileSync(saveBPath, 'utf8')
    await callTool(client, 'load_save', { path: saveBPath })
    await new Promise((r) => setTimeout(r, 1600)) // past the 1s window the stale timer would use
    const bytesAfter = readFileSync(saveBPath, 'utf8')
    check(
      'load_save cancels the pending debounced flush (save B untouched)',
      bytesAfter === bytesBefore,
      bytesAfter === bytesBefore ? 'byte-identical' : `changed: ${bytesBefore.length} -> ${bytesAfter.length} bytes`,
    )
  }

  // 10. a save whose migration chain throws mid-way must not leave a chimera
  // (new-save markers already in the stores + previous-save inventory) with
  // loadedSave still pointing at the OLD file — the next flush would persist
  // that chimera into the old save. A character entry missing `form` makes
  // migrateCharacterForm throw (character.form.characterLevel = 80).
  {
    await callTool(client, 'load_save', { path: sampleSavePath })
    const badSave = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
    delete badSave.characters[0].form
    badSave.completedMigrations = { ...badSave.completedMigrations, zzzMcpChimeraMarker: 1 }
    const badPath = `${tempDir}/broken-save.json`
    writeFileSync(badPath, JSON.stringify(badSave))

    const badResult = await client.callTool({ name: 'load_save', arguments: { path: badPath } })
    check(
      'broken save (character missing form) surfaces isError',
      badResult.isError === true,
      String(badResult.content?.[0]?.text ?? '').slice(0, 140),
    )

    const status = await callTool(client, 'save_status', {})
    check(
      'save_status still reports the previous save after a failed load',
      status.path === sampleSavePath && status.relics === 162 && status.characters === 8,
      `path=${status.path}, ${status.relics}/${status.characters}`,
    )

    // one mutation -> the flush must persist only the previous save's state
    await callTool(client, 'save_team', { name: 'post-failure-probe', characterIds: ['1212'] })
    await new Promise((r) => setTimeout(r, 2000))
    const oldSaveNow = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
    check(
      'failed migration leaves no chimera markers in the old save file',
      oldSaveNow.completedMigrations?.zzzMcpChimeraMarker == null && (oldSaveNow.relics?.length ?? 0) === 162,
      `marker=${String(oldSaveNow.completedMigrations?.zzzMcpChimeraMarker)}, relics=${oldSaveNow.relics?.length}`,
    )
  }

  // 11. a BLOCKED write-back must not push the sync bridge: the un-persisted
  // state (here: a full inventory wipe) must not reach web clients as
  // DeleteRelics/InitialScan frames — only a successful write notifies.
  {
    const { WebSocket } = await import('ws')
    await callTool(client, 'load_save', { path: sampleSavePath })
    const port = 23419
    await callTool(client, 'sync_bridge_start', { port })

    const frames = []
    const ws = await new Promise((resolveReady, rejectReady) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      const timer = setTimeout(() => rejectReady(new Error('bridge client never connected')), 5000)
      socket.on('open', () => {
        clearTimeout(timer)
        resolveReady(socket)
      })
      socket.on('message', (raw) => frames.push(String(raw)))
      socket.on('error', (e) => rejectReady(e))
    })
    try {
      const initialDeadline = Date.now() + 5000
      while (frames.length < 1 && Date.now() < initialDeadline) await new Promise((r) => setTimeout(r, 100))
      check('bridge pushes the initial scan on connect', frames.length >= 1, `${frames.length} frame(s)`)

      // blocked path: reset_all wipes the stores; the debounced flush is held
      // by the wipe guard — nothing may reach the bridge in the meantime
      const framesBeforeBlock = frames.length
      await callTool(client, 'reset_all', {})
      await new Promise((r) => setTimeout(r, 2500))
      check(
        'blocked write-back does not push the bridge',
        frames.length === framesBeforeBlock,
        `${frames.length - framesBeforeBlock} frame(s) after the blocked flush`,
      )

      // success path: a populated reload + a mutation that flushes cleanly -> push
      await callTool(client, 'load_save', { path: sampleSavePath })
      await callTool(client, 'save_team', { name: 'bridge-notify-probe', characterIds: ['1212'] })
      const successDeadline = Date.now() + 5000
      while (frames.length === framesBeforeBlock && Date.now() < successDeadline) await new Promise((r) => setTimeout(r, 100))
      check(
        'successful write-back pushes the bridge',
        frames.length > framesBeforeBlock,
        `${frames.length - framesBeforeBlock} frame(s) after the clean flush`,
      )
    } finally {
      await callTool(client, 'sync_bridge_stop', {})
      ws.close()
    }
  }
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke: ALL CHECKS PASSED' : `\nsmoke: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
