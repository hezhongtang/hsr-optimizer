// Shutdown-path smoke test: stdin EOF must stop the server cleanly.
//
// The SDK's StdioServerTransport only hooks stdin 'data'/'error' — a client
// that closes its pipe (every disconnect, and StdioClientTransport.close()
// before its 2s SIGTERM fallback) would otherwise leave the process and the
// driver worker's ~2GB engine heap alive forever. This test spawns the server
// RAW (no SDK client), drives one handshake + tool call + one dirtying
// mutation over the wire, ends stdin, and asserts:
//   1. the process exits by itself within 1.5s — exit code 0, no signal
//      (the SDK client fallback would be SIGTERM after 2s);
//   2. the shutdown flushed the pending debounced write-back (the mutation
//      lands in the save file even though the 1s debounce never fired).
//
// Usage: node scripts/smoke-shutdown.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import { spawn } from 'node:child_process'
import {
  copyFileSync,
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

const child = spawn(process.execPath, [serverEntry], {
  cwd: mcpDir,
  env: { ...process.env, HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stdio: ['pipe', 'pipe', 'inherit'],
})

try {
  const client = rpc(child)
  await client.call(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-shutdown', version: '0.0.0' },
  })
  client.notify('notifications/initialized')

  const status = await client.call(2, 'tools/call', { name: 'save_status', arguments: {} })
  check('save_status answered over raw stdio', status?.content != null, 'handshake + tool call ok')

  await client.call(3, 'tools/call', { name: 'load_save', arguments: { path: savePath } })
  // Marks dirty — the 1s debounce is still pending when we cut stdin below
  await client.call(4, 'tools/call', {
    name: 'upsert_character',
    arguments: { characterId: '1107', lightCone: '20000' },
  })

  // Cut the pipe: EOF must shut the server down (flush + driver terminate + exit 0)
  const exit = new Promise((resolveExit) => child.once('close', (code, signal) => resolveExit({ code, signal })))
  const endedAt = Date.now()
  child.stdin.end()

  const hardKill = setTimeout(() => child.kill('SIGKILL'), 5_000)
  const { code, signal } = await exit
  clearTimeout(hardKill)
  const exitMs = Date.now() - endedAt

  check('server exits itself on stdin EOF (no external kill)', code !== null || signal !== 'SIGKILL')
  check('exit code 0', code === 0, `code=${code}, signal=${signal}`)
  check('clean exit, not killed by a signal', signal === null, `signal=${signal}`)
  check('exit within 1.5s (before the SDK client 2s SIGTERM fallback)', exitMs < 1_500, `${exitMs}ms`)

  const persisted = JSON.parse(readFileSync(savePath, 'utf8'))
  const persistedIds = persisted.characters.map((c) => c.id)
  check(
    'pending debounced write-back flushed on EOF shutdown',
    persistedIds.includes('1107'),
    `characters in file: ${persistedIds.join(',')}`,
  )
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-shutdown: ALL CHECKS PASSED' : `\nsmoke-shutdown: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
