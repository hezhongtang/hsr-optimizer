// Shutdown-path smoke test: stdin EOF must stop the server cleanly, and a
// restart over the same HSR_MCP_STATE_FILE must boot-restore the last state.
//
// The SDK's StdioServerTransport only hooks stdin 'data'/'error' — a client
// that closes its pipe (every disconnect, and StdioClientTransport.close()
// before its 2s SIGTERM fallback) would otherwise leave the process and the
// driver worker's ~2GB engine heap alive forever. Phase 1 spawns the server
// RAW (no SDK client), drives one handshake + tool call + dirtying mutations
// over the wire, ends stdin, and asserts:
//   1. the process exits by itself within 1.5s — exit code 0, no signal
//      (the SDK client fallback would be SIGTERM after 2s);
//   2. the shutdown flushed the pending debounced write-back (the mutation
//      lands in the save file even though the 1s debounce never fired);
//   3. the shutdown also flushed the localStorage backend — the state file
//      carries the 'state' key with the mutated inventory and the custom
//      scanner url (global.state.bootLoad's source of truth).
//
// Phase 2 spawns a SECOND server process over the SAME state file (no save
// path anywhere) and asserts the boot restore (global.state.bootLoad, the
// web's SaveState.load(false,false) startup chain):
//   - save_status reports loaded/path=null/bootLoaded=true/dirty=false and
//     the pre-restart inventory (relics + the mutated character);
//   - the custom scanner websocket url IS applied (startup sanitize=false —
//     deliberately different from load_save's manual-load sanitize=true);
//   - a fresh mutation persists back through the state-file backend on EOF
//     (inline-shaped save: flushSave writes localStorage, not a save path).
//
// Phase 3 spawns a THIRD server with HSR_MCP_NO_BOOT_LOAD=1 over the same
// state file and asserts the escape hatch: default empty state, not loaded.
//
// Usage: node scripts/smoke-shutdown.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import { spawn } from 'node:child_process'
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

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-shutdown-`)
const savePath = `${tempDir}/sample-save.json`
const statePath = `${tempDir}/localstorage.json`
const customWsUrl = 'ws://127.0.0.1:39998/boot-restore'
copyFileSync(repoSampleSavePath, savePath)

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Minimal newline-delimited JSON-RPC client over the raw child stdio. */
function rpc(child) {
  let buffer = ''
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        if (message.id != null && pending.has(message.id)) {
          pending.get(message.id)(message)
          pending.delete(message.id)
        }
      } catch {
        // Non-JSON chatter on stdout would itself be a protocol violation; ignore here
      }
    }
  })
  return {
    call(id, method, params) {
      return new Promise((resolveCall, rejectCall) => {
        pending.set(id, (message) => {
          if (message.error) rejectCall(new Error(`${method}: ${JSON.stringify(message.error)}`))
          else resolveCall(message.result)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

function spawnServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: mcpDir,
    env: { ...process.env, HSR_MCP_STATE_FILE: statePath, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return child
}

async function handshake(child) {
  const client = rpc(child)
  await client.call(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-shutdown', version: '0.0.0' },
  })
  client.notify('notifications/initialized')
  return client
}

/** Drive stdin EOF and resolve on process close with { code, signal, ms }. */
async function eofAndWait(child) {
  const exit = new Promise((resolveExit) => child.once('close', (code, signal) => resolveExit({ code, signal })))
  const endedAt = Date.now()
  child.stdin.end()
  const hardKill = setTimeout(() => child.kill('SIGKILL'), 5_000)
  const closed = await exit
  clearTimeout(hardKill)
  return { ...closed, ms: Date.now() - endedAt }
}

function payloadOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = result?.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callToolRaw(client, id, name, args) {
  const result = await client.call(id, 'tools/call', { name, arguments: args })
  if (result?.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}

// ── Phase 1: dirty mutations, then stdin EOF must flush and exit ────────────
{
  const child = spawnServer()
  try {
    const client = await handshake(child)
    const status = await callToolRaw(client, 2, 'save_status', {})
    check('save_status answered over raw stdio', status != null, 'handshake + tool call ok')

    await callToolRaw(client, 3, 'load_save', { path: savePath })
    const loadedStatus = await callToolRaw(client, 4, 'save_status', {})
    const relicsBeforeRestart = loadedStatus.relics
    check('sample save loaded before the shutdown window', loadedStatus.loaded === true && relicsBeforeRestart > 0, `relics=${relicsBeforeRestart}`)

    // Marks dirty — the 1s debounce is still pending when we cut stdin below.
    // The custom scanner url is the phase-2 differentiator: the boot restore
    // (sanitize=false) applies it, a manual load_save (sanitize=true) would not.
    await callToolRaw(client, 5, 'upsert_character', {
      characterId: '1107',
      lightCone: '20000',
    })
    await callToolRaw(client, 6, 'update_state', {
      section: 'scanner',
      patch: { websocketUrl: customWsUrl },
    })

    const { code, signal, ms } = await eofAndWait(child)
    check('server exits itself on stdin EOF (no external kill)', code !== null || signal !== 'SIGKILL')
    check('exit code 0', code === 0, `code=${code}, signal=${signal}`)
    check('clean exit, not killed by a signal', signal === null, `signal=${signal}`)
    check('exit within 1.5s (before the SDK client 2s SIGTERM fallback)', ms < 1_500, `${ms}ms`)

    const persisted = JSON.parse(readFileSync(savePath, 'utf8'))
    const persistedIds = persisted.characters.map((c) => c.id)
    check(
      'pending debounced write-back flushed on EOF shutdown',
      persistedIds.includes('1107'),
      `characters in file: ${persistedIds.join(',')}`,
    )

    // The localStorage backend must carry the same state for the restart.
    check('state file (localStorage backend) exists after shutdown', existsSync(statePath))
    const backend = JSON.parse(readFileSync(statePath, 'utf8'))
    const backendState = backend.state ? JSON.parse(backend.state) : null
    check(
      'shutdown flushed the localStorage backend with the mutated state (bootLoad source)',
      backendState != null
        && backendState.characters.some((c) => c.id === '1107')
        && backendState.scannerSettings?.websocketUrl === customWsUrl
        && backendState.scannerSettings?.customUrl === true
        && backendState.relics.length === relicsBeforeRestart,
      `relics=${backendState?.relics?.length} scannerUrl=${backendState?.scannerSettings?.websocketUrl}`,
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

// ── Phase 2: second process over the SAME state file boot-restores ──────────
{
  const child = spawnServer()
  try {
    const client = await handshake(child)
    const status = await callToolRaw(client, 2, 'save_status', {})
    check(
      'restart auto-restores the last state (bootLoaded, inline path, clean)',
      status.loaded === true && status.path === null && status.bootLoaded === true && status.dirty === false,
      `loaded=${status.loaded} path=${status.path} bootLoaded=${status.bootLoaded} dirty=${status.dirty}`,
    )
    check(
      'restored inventory matches the pre-restart state',
      status.characterIds.includes('1107') && status.relics > 0,
      `relics=${status.relics} characters=${status.characterIds.join(',')}`,
    )
    const revision = await callToolRaw(client, 3, 'get_state', { section: 'revision' })
    check(
      'get_state(revision) mirrors the boot restore (revision/generation bumped once, bootLoaded echoed)',
      revision.revision.loaded === true && revision.revision.bootLoaded === true && revision.revision.revision === 1,
      `revision=${JSON.stringify(revision.revision)}`,
    )
    const scanner = await callToolRaw(client, 4, 'get_state', { section: 'scanner' })
    check(
      'boot restore applies the persisted custom scanner url (startup sanitize=false semantics)',
      scanner.scanner.websocketUrl === customWsUrl && scanner.scanner.customUrl === true,
      `websocketUrl=${scanner.scanner.websocketUrl}`,
    )

    // A fresh mutation after the boot restore must persist through the state
    // file backend on EOF (inline-shaped save: flushSave writes localStorage).
    await callToolRaw(client, 5, 'upsert_character', { characterId: '1107', characterEidolon: 3 })
    const { code, signal } = await eofAndWait(child)
    check('phase 2 exits cleanly on EOF', code === 0 && signal === null, `code=${code}, signal=${signal}`)
    const backend = JSON.parse(readFileSync(statePath, 'utf8'))
    const backendState = JSON.parse(backend.state)
    check(
      'post-restore mutation persists through the state-file backend on shutdown',
      backendState.characters.find((c) => c.id === '1107')?.form?.characterEidolon === 3,
      `eidolon=${backendState.characters.find((c) => c.id === '1107')?.form?.characterEidolon}`,
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

// ── Phase 3: HSR_MCP_NO_BOOT_LOAD=1 disables the restore ────────────────────
{
  const child = spawnServer({ HSR_MCP_NO_BOOT_LOAD: '1' })
  try {
    const client = await handshake(child)
    const status = await callToolRaw(client, 2, 'save_status', {})
    check(
      'HSR_MCP_NO_BOOT_LOAD=1 starts with the default empty state (escape hatch)',
      status.loaded === false && status.revision === 0 && status.relics === 0,
      `loaded=${status.loaded} revision=${status.revision}`,
    )
    const { code } = await eofAndWait(child)
    check('phase 3 exits cleanly on EOF', code === 0, `code=${code}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(tempDir, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nsmoke-shutdown: ALL CHECKS PASSED' : `\nsmoke-shutdown: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
