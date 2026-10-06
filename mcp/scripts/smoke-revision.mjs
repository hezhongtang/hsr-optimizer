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

  // ── same-batch pipelined writes: a failed scope must not roll back a
  // committed sibling (regression for the snapshot-at-submission bug) ─────
  // The SDK client serializes requests, so this needs a raw stdio child with
  // two request frames in ONE stdin write — the exact interleaving the M4
  // review reproduced the bug with.
  const raw = await sameBatchDoubleWrite()
  check(
    'same-batch double write: committed sibling survives the failed scope',
    raw.committedSettingsSurvived && raw.revisionMonotonic,
    `settings value survived=${raw.committedSettingsSurvived}, revision ${raw.revisionBeforeFailure} → ${raw.revisionAfterFailure} (monotonic=${raw.revisionMonotonic}), failed scope isError=${raw.secondFailed}`,
  )

  console.log(failures === 0 ? 'smoke-revision: ALL CHECKS PASSED' : `smoke-revision: ${failures} FAILED`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)

// ── raw stdio same-batch probe ───────────────────────────────────────────────
// Spawns a fresh server, performs the initialize handshake, then sends TWO
// tools/call request frames in a SINGLE stdin write: W1 = update_state settings
// (must commit), W2 = update_state scanner customUrl=true with no custom url
// (throws inside the withChange body). With the submission-time-snapshot bug,
// W2's rollback restored the state from BEFORE W1's body ran, silently wiping
// W1's committed change and rewinding the revision; with the dequeue-time
// snapshot both invariants hold. Returns what the probe observed.
async function sameBatchDoubleWrite() {
  const { spawn } = await import('node:child_process')
  const rawTemp = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-revision-raw-`)
  const rawSave = `${rawTemp}/sample-save.json`
  copyFileSync(repoSampleSavePath, rawSave)

  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, HSR_MCP_STATE_FILE: `${rawTemp}/localstorage.json` },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  const responses = new Map()
  const pending = []
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null) {
          responses.set(msg.id, msg)
          for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].id === msg.id) {
              pending[i].resolve(msg)
              pending.splice(i, 1)
            }
          }
        }
      } catch { /* partial line */ }
    }
  })
  child.stderr.on('data', () => {/* rollbacks are logged; noise */})
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
  const nextId = (() => {
    let n = 0
    return () => ++n
  })()
  const awaitResponse = (id, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const existing = responses.get(id)
      if (existing) return resolve(existing)
      const entry = { id, resolve }
      pending.push(entry)
      setTimeout(() => reject(new Error(`raw probe: no response for id ${id}`)), timeoutMs)
    })

  try {
    const initId = nextId()
    send({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw-smoke', version: '0' } },
    })
    await awaitResponse(initId)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const loadId = nextId()
    send({ jsonrpc: '2.0', id: loadId, method: 'tools/call', params: { name: 'load_save', arguments: { path: rawSave } } })
    await awaitResponse(loadId)

    // The probe: both frames in ONE write.
    const w1 = nextId()
    const w2 = nextId()
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: w1,
        method: 'tools/call',
        params: { name: 'update_state', arguments: { section: 'settings', patch: { RelicEquippingBehavior: 'Swap' } } },
      }) + '\n'
        + JSON.stringify({
          jsonrpc: '2.0',
          id: w2,
          method: 'tools/call',
          params: { name: 'update_state', arguments: { section: 'scanner', patch: { customUrl: true } } },
        }) + '\n',
    )
    const [r1, r2] = await Promise.all([awaitResponse(w1), awaitResponse(w2)])

    const checkId = nextId()
    send({ jsonrpc: '2.0', id: checkId, method: 'tools/call', params: { name: 'get_state', arguments: { section: 'settings' } } })
    const settingsPayload = (await awaitResponse(checkId)).result?.structuredContent ?? {}

    const revId = nextId()
    send({ jsonrpc: '2.0', id: revId, method: 'tools/call', params: { name: 'get_state', arguments: { section: 'revision' } } })
    const revisionPayload = (await awaitResponse(revId)).result?.structuredContent?.revision ?? {}

    const revision1 = r1.result?.structuredContent?.revision
    return {
      firstSucceeded: r1.result?.isError !== true,
      secondFailed: r2.result?.isError === true,
      committedSettingsSurvived: settingsPayload.settings?.settings?.RelicEquippingBehavior === 'Swap',
      revisionBeforeFailure: revision1,
      revisionAfterFailure: revisionPayload.revision,
      revisionMonotonic: typeof revision1 === 'number' && typeof revisionPayload.revision === 'number' && revisionPayload.revision >= revision1,
    }
  } finally {
    child.kill()
    rmSync(rawTemp, { recursive: true, force: true })
  }
}
