// M4 change-coordinator smoke: revision semantics, transacted load rollback.
//
// Exercises the Phase A coordinator surface end-to-end against the built
// server (dist/index.js):
//   - save_status exposes revision + generation from a cold boot
//   - read-only tools leave the revision untouched
//   - every write tool call (markDirty path) bumps the revision
//   - load_save bumps both revision and generation (save swap)
//   - a save whose migration chain throws rolls the FULL pre-load state back:
//     inventory, dirty flag, blockedWrite marker and the revision itself —
//     the failed load leaves no chimera and no phantom revision
//
// The malformed save reuses the same shape as smoke-archive's (a character
// missing its `form` object makes migrateCharacterForm throw mid-chain, after
// the chain has already written migration markers into the stores).
//
// Usage: node scripts/smoke-revision.mjs [serverEntry]

import {
  copyFileSync,
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

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-revision-`)
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

async function callToolExpectError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-revision', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
  },
})
await client.connect(transport)

try {
  // ── cold boot surface ────────────────────────────────────────────────────
  let status = await callTool(client, 'save_status', {})
  check(
    'cold boot reports revision 0 and generation 0',
    status.revision === 0 && status.generation === 0,
    `revision=${status.revision} generation=${status.generation}`,
  )

  // ── first load bumps both counters ───────────────────────────────────────
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('sample save loaded', loaded.loaded === true, `${loaded.relics} relics / ${loaded.characters} characters`)
  status = await callTool(client, 'save_status', {})
  check(
    'after load: revision and generation both bumped',
    status.revision === 1 && status.generation === 1,
    `revision=${status.revision} generation=${status.generation}`,
  )
  const baseRelics = status.relics

  // ── read-only tools never bump ───────────────────────────────────────────
  await callTool(client, 'list_relics', { limit: 5 })
  await callTool(client, 'list_characters', {})
  status = await callTool(client, 'save_status', {})
  check('reads leave revision unchanged', status.revision === 1, `revision=${status.revision}`)

  // ── a write tool bumps (set_character_rank → markDirty path) ─────────────
  const characters = await callTool(client, 'list_characters', {})
  const charId = characters.characters[0].id
  const rankBefore = characters.characters[0].rank
  const movedTo = rankBefore === 0 ? 1 : 0
  await callTool(client, 'set_character_rank', { characterId: charId, index: movedTo })
  status = await callTool(client, 'save_status', {})
  check(
    'write tool bumps revision, not generation',
    status.revision === 2 && status.generation === 1,
    `revision=${status.revision} generation=${status.generation}`,
  )

  // ── second load bumps both again ─────────────────────────────────────────
  await callTool(client, 'load_save', { path: sampleSavePath })
  status = await callTool(client, 'save_status', {})
  check(
    're-load bumps revision and generation again',
    status.revision === 3 && status.generation === 2,
    `revision=${status.revision} generation=${status.generation}`,
  )

  // ── failing load rolls back revision, dirty, inventory ───────────────────
  // Make an edit first so the rollback has real state to restore. Whether the
  // debounced flush already fired is timing — snapshot whatever the state is
  // right before the failing load and require the rollback to restore it.
  await callTool(client, 'set_character_rank', { characterId: charId, index: rankBefore })
  await callTool(client, 'set_character_rank', { characterId: charId, index: movedTo })
  const before = await callTool(client, 'save_status', {})
  check('pre-failure state: revision 5', before.revision === 5, `revision=${before.revision} dirty=${before.dirty}`)

  const malformed = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  delete malformed.characters[0].form
  const malformedPath = `${tempDir}/malformed-save.json`
  writeFileSync(malformedPath, JSON.stringify(malformed))

  const errText = await callToolExpectError(client, 'load_save', { path: malformedPath })
  check('malformed load fails with rollback message', errText.includes('载入失败'), errText.slice(0, 90))

  status = await callTool(client, 'save_status', {})
  check(
    'failed load restores revision, generation, dirty and inventory',
    status.revision === before.revision
      && status.generation === before.generation
      && status.dirty === before.dirty
      && status.relics === before.relics
      && status.characters === before.characters,
    `revision=${status.revision}/${before.revision} generation=${status.generation}/${before.generation} `
      + `dirty=${status.dirty}/${before.dirty} relics=${status.relics}/${before.relics}`,
  )

  // ── the rolled-back state is real: the rank edit survived ────────────────
  const afterCharacters = await callTool(client, 'list_characters', {})
  const afterChar = afterCharacters.characters.find((c) => c.id === charId)
  check('edit survives the failed load (stores restored, not reset)', afterChar.rank === movedTo, `rank=${afterChar.rank}`)

  // ── mutation after rollback still works and continues the counter ───────
  await callTool(client, 'set_character_rank', { characterId: charId, index: rankBefore })
  status = await callTool(client, 'save_status', {})
  check('post-rollback write bumps revision to 6', status.revision === 6, `revision=${status.revision}`)

  // ── flush persists and revision keeps counting (not reset by flush) ─────
  await callTool(client, 'export_save', { path: `${tempDir}/out-save.json` })
  status = await callTool(client, 'save_status', {})
  check('export does not bump revision', status.revision === 6, `revision=${status.revision}`)

  console.log(failures === 0 ? 'smoke-revision: ALL CHECKS PASSED' : `smoke-revision: ${failures} FAILED`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
