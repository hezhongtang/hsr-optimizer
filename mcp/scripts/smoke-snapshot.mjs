// M4-B structured-snapshot smoke: read-only parity with export_save files.
//
// Exercises export_save(structured=true) end-to-end against the built server
// (dist/index.js):
//   - with no save loaded the structured mode errors (requireSave, no writes)
//   - the snapshot deep-equals the file export_save writes — proving the
//     saveSnapshot.ts mirror produces exactly what SaveState.save() serializes
//     (version and every optional field included; a mismatch = mirror drift)
//   - the structured call is side-effect free: revision/dirty unchanged, no
//     new files in the target directory, localStorage['state'] untouched
//     (calling SaveState.save() would have rewritten it)
//   - after a mutation (set_character_rank) the snapshot still deep-equals a
//     fresh file export AND reflects the unflushed change — it reads the live
//     store values, not the persisted file
//   - default-path regression: without `structured` the tool keeps its exact
//     legacy payload {exported, path, bytes}, writes back to the loaded path,
//     and both overwrite guardrails (symlink refusal, save-shape check) hold
//
// Usage: node scripts/smoke-snapshot.mjs [serverEntry]

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-snapshot-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const statePath = `${tempDir}/localstorage.json`
// The localStorage backend debounces file writes by 300ms (shims.ts), so
// "unchanged localStorage" assertions need settle windows on both sides.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

async function callToolExpectError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

function localStorageState() {
  return existsSync(statePath) ? readFileSync(statePath, 'utf8') : null
}

function sortedDir() {
  return readdirSync(tempDir).sort()
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-snapshot', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: statePath,
  },
})
await client.connect(transport)

try {
  // ── structured mode without a loaded save errors, writes nothing ─────────
  const coldError = await callToolExpectError(client, 'export_save', { structured: true })
  check('structured export with no save loaded is an error', coldError.includes('No save loaded'), coldError.slice(0, 80))
  check('failed cold structured export wrote no state file', localStorageState() === null)

  // ── load the sample save, then snapshot at a quiescent point ─────────────
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('sample save loaded', loaded.loaded === true, `${loaded.relics} relics / ${loaded.characters} characters`)
  await sleep(400) // settle load_save's anti-wipe setItem → state-file flush

  const before = {
    status: await callTool(client, 'save_status', {}),
    dir: sortedDir(),
    lsState: localStorageState(),
  }
  check('pre-snapshot state is quiescent (rev 1, gen 1, clean)', before.status.revision === 1 && before.status.generation === 1 && !before.status.dirty)

  // ── read-only structured snapshot ────────────────────────────────────────
  const snap1 = await callTool(client, 'export_save', { structured: true })
  check(
    'structured payload shape is exactly {structured, snapshot, revision, generation, counts}',
    snap1.structured === true
      && isDeepStrictEqual(Object.keys(snap1).sort(), ['counts', 'generation', 'revision', 'snapshot', 'structured'])
      && isDeepStrictEqual(Object.keys(snap1.counts), ['relics', 'characters']),
    `keys=${Object.keys(snap1).join(',')}`,
  )
  check(
    'structured payload carries current revision/generation and matching counts',
    snap1.revision === 1 && snap1.generation === 1
      && snap1.counts.relics === snap1.snapshot.relics.length && snap1.counts.characters === snap1.snapshot.characters.length
      && snap1.counts.relics === loaded.relics && snap1.counts.characters === loaded.characters,
    `revision=${snap1.revision} generation=${snap1.generation} counts=${snap1.counts.relics}/${snap1.counts.characters}`,
  )
  await sleep(400) // a setItem the structured call might have scheduled would land here

  const after = {
    status: await callTool(client, 'save_status', {}),
    dir: sortedDir(),
    lsState: localStorageState(),
  }
  check(
    'structured call leaves revision and dirty flag unchanged',
    after.status.revision === before.status.revision && after.status.dirty === before.status.dirty,
    `revision=${after.status.revision}/${before.status.revision} dirty=${after.status.dirty}/${before.status.dirty}`,
  )
  check('structured call creates no files in the target directory', isDeepStrictEqual(after.dir, before.dir), after.dir.join(','))
  check(
    'structured call does not run SaveState.save() (localStorage untouched)',
    after.lsState === before.lsState,
    after.lsState === before.lsState ? 'identical' : 'changed',
  )

  // ── default-path regression + parity check #1 ────────────────────────────
  const export1 = await callTool(client, 'export_save', {})
  check(
    'default export keeps the exact legacy payload {exported, path, bytes}',
    export1.exported === true && export1.path === sampleSavePath && export1.bytes > 0
      && isDeepStrictEqual(Object.keys(export1).sort(), ['bytes', 'exported', 'path']),
    `keys=${Object.keys(export1).join(',')} path=${export1.path}`,
  )
  const file1 = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  check(
    'parity #1: snapshot deep-equals the default-path export file',
    isDeepStrictEqual(snap1.snapshot, file1),
    `relics=${file1.relics?.length} characters=${file1.characters?.length} version=${file1.version}`,
  )
  check(
    'parity #1 includes the version field',
    typeof file1.version === 'string' && file1.version === snap1.snapshot.version,
    `snapshot=${snap1.snapshot.version} file=${file1.version}`,
  )

  // ── mutate, then parity #2 must carry the unflushed change ───────────────
  const characters = await callTool(client, 'list_characters', {})
  const characterId = characters.characters[0].id
  const movedTo = 3
  const rankMoved = await callTool(client, 'set_character_rank', { characterId, index: movedTo })

  const snap2 = await callTool(client, 'export_save', { structured: true })
  check('post-mutation snapshot reports the bumped revision', snap2.revision === 2, `revision=${snap2.revision}`)
  check(
    'snapshot reflects the unflushed rank change (reads live store values)',
    isDeepStrictEqual(snap2.snapshot.characters.map((c) => c.id), rankMoved.order),
    `character ${characterId} at index ${snap2.snapshot.characters.findIndex((c) => c.id === characterId)}`,
  )
  const statusDirty = await callTool(client, 'save_status', {})
  check(
    'structured call neither flushed nor cleared the dirty flag',
    statusDirty.revision === 2 && statusDirty.dirty === true,
    `revision=${statusDirty.revision} dirty=${statusDirty.dirty}`,
  )

  const changedPath = `${tempDir}/after-change.json`
  await callTool(client, 'export_save', { path: changedPath })
  const file2 = JSON.parse(readFileSync(changedPath, 'utf8'))
  check(
    'parity #2: post-mutation snapshot deep-equals a fresh file export',
    isDeepStrictEqual(snap2.snapshot, file2),
    file2.characters.findIndex((c) => c.id === characterId) === movedTo ? 'rank change present in file' : 'rank missing in file',
  )

  // ── write-mode guardrails hold without `structured` ──────────────────────
  const notSavePath = `${tempDir}/not-a-save.txt`
  writeFileSync(notSavePath, JSON.stringify({ hello: 'world' }))
  const shapeError = await callToolExpectError(client, 'export_save', { path: notSavePath })
  check('overwriting a non-save-shaped file is refused', shapeError.includes('Invalid save data'), shapeError.slice(0, 90))
  check('refused shape overwrite leaves the target intact', readFileSync(notSavePath, 'utf8') === JSON.stringify({ hello: 'world' }))

  const realSaveCopy = `${tempDir}/symlink-target.json`
  copyFileSync(sampleSavePath, realSaveCopy)
  const symlinkPath = `${tempDir}/symlink-save.json`
  symlinkSync(realSaveCopy, symlinkPath)
  const symlinkError = await callToolExpectError(client, 'export_save', { path: symlinkPath })
  check('exporting over a symlink is refused', symlinkError.includes('symlink'), symlinkError.slice(0, 90))

  console.log(failures === 0 ? 'smoke-snapshot: ALL CHECKS PASSED' : `smoke-snapshot: ${failures} FAILED`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
