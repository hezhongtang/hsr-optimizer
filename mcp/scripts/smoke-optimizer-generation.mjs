// End-to-end regression for a load_save received while optimize is running.
// Uses one worker and a 4x inventory to keep the first progress/load handshake
// ahead of completion, then cancels immediately after the load succeeds. The
// replacement inventory deliberately reuses every relic id. A stale run must
// neither hydrate those ids against the replacement nor publish an applicable
// cache. Same-save completed and cancelled runs must still retain usable rows.
//
// Usage: node scripts/smoke-optimizer-generation.mjs [serverEntry]
// All save files and localStorage writes are isolated in a temporary directory.

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
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-optimizer-generation-`)
const samplePath = `${tempDir}/sample-save.json`
copyFileSync(resolve(mcpDir, '../src/data/sample-save.json'), samplePath)
const sample = JSON.parse(readFileSync(samplePath, 'utf8'))
const TARGET = '1212b1'

const expanded = { ...sample, relics: [] }
for (let copy = 0; copy < 4; copy++) {
  for (const relic of sample.relics) {
    expanded.relics.push({
      ...relic,
      id: copy === 0 ? relic.id : `${relic.id}#${copy}`,
      equippedBy: copy === 0 ? relic.equippedBy : undefined,
    })
  }
}
const saveAPath = `${tempDir}/save-a.json`
const saveBPath = `${tempDir}/save-b.json`
writeFileSync(saveAPath, JSON.stringify(expanded))
writeFileSync(
  saveBPath,
  JSON.stringify({
    ...expanded,
    relics: expanded.relics.map((relic) => ({ ...relic, verified: true })),
    characters: expanded.characters.map((character) =>
      character.id === TARGET
        ? { ...character, form: { ...character.form, characterEidolon: 6 } }
        : character
    ),
  }),
)

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((content) => content.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

function errorText(result) {
  return result.content?.find((content) => content.type === 'text')?.text ?? ''
}

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) throw new Error(`tool ${name} returned isError: ${errorText(result)}`)
  return payloadOf(result)
}

async function within(promise, ms, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// The non-forced call hits the scale gate once the old driver run has settled;
// it never starts another search or replaces the cache we are inspecting.
async function waitUntilIdle(client) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: 'optimize', arguments: { characterId: TARGET } })
    if (!result.isError) {
      const payload = payloadOf(result)
      if (payload.status !== 'rejected') throw new Error('Idle probe unexpectedly started a search; the fixture must exceed the scale gate')
      return
    }
    if (!/Another optimization is already running/.test(errorText(result))) throw new Error(errorText(result))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Cancelled optimizer did not become idle within 30s')
}

const client = new Client({ name: 'smoke-optimizer-generation', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_WORKERS: '1',
  },
  stderr: 'inherit',
})

try {
  await client.connect(transport)
  await callTool(client, 'load_save', { path: samplePath })
  const completed = await callTool(client, 'optimize', { characterId: TARGET, resultsLimit: 5 }, { timeout: 300_000 })
  check('same-save optimize completes with rows', completed.status === 'completed' && completed.rows.length > 0)
  const completedPage = await callTool(client, 'get_results', { limit: 1 })
  check('completed results remain readable', completedPage.cacheId === completed.summary.cacheId && completedPage.rows.length === 1)

  await callTool(client, 'load_save', { path: saveAPath })
  const gate = await callTool(client, 'optimize', { characterId: TARGET })
  if (gate.status !== 'rejected') throw new Error('The 4x fixture must exceed the scale gate to make the progress handshake deterministic')

  const abort = new AbortController()
  let switchPromise = null
  let progressObserved = false
  const inFlight = callTool(client, 'optimize', { characterId: TARGET, force: true, resultsLimit: 5 }, {
    signal: abort.signal,
    timeout: 60_000,
    resetTimeoutOnProgress: true,
    onprogress: (progress) => {
      if (switchPromise || progress.progress <= 0) return
      progressObserved = true
      // Load first, cancel second: cancellation alone must not make a stale
      // run safe by stopping it before the save's generation changes.
      switchPromise = callTool(client, 'load_save', { path: saveBPath }).finally(() => abort.abort())
      // The outer flow observes failures; suppress an unhandled rejection if
      // this promise rejects before it gets out of the SDK progress callback.
      void switchPromise.catch(() => {})
    },
  }).catch((error) => error)
  await within(inFlight, 60_000, 'No progress/load/cancel handshake within 60s').finally(() => abort.abort())
  if (!switchPromise) throw new Error('Optimization completed before the test could switch saves')
  await switchPromise
  check('load_save completed during search progress', progressObserved)
  await waitUntilIdle(client)

  const stalePage = await client.callTool({ name: 'get_results', arguments: { limit: 1 } })
  check('discarded results are never hydrated against the replacement inventory', stalePage.isError === true && /previous save load/.test(errorText(stalePage)))

  // With the old bug get_results exposes the just-finished run stamped with
  // save B's generation. Probe THAT cache too, so both mutation checks fail
  // even when every id still resolves in save B.
  const leaked = stalePage.isError ? null : payloadOf(stalePage)
  const fromCache = {
    cacheId: leaked?.cacheId ?? completed.summary.cacheId,
    rowId: leaked?.rows[0]?.id ?? completed.rows[0].id,
  }
  const before = await callTool(client, 'get_character', { characterId: TARGET })
  const staleEquip = await client.callTool({ name: 'equip_build', arguments: { characterId: TARGET, fromCache } })
  check('equip_build refuses cross-save cached rows with colliding ids', staleEquip.isError === true && /previous save load/.test(errorText(staleEquip)))
  const staleSave = await client.callTool({
    name: 'save_build',
    arguments: { characterId: TARGET, name: 'cross-save-must-not-exist', fromCache },
  })
  check('save_build refuses cross-save cached rows with colliding ids', staleSave.isError === true && /previous save load/.test(errorText(staleSave)))
  const after = await callTool(client, 'get_character', { characterId: TARGET })
  check('rejected cache applications preserve the new character and builds', JSON.stringify(after) === JSON.stringify(before))

  // Cancellation without a load still publishes partial results. Wait for
  // reported matches before aborting so this assertion cannot pass on an
  // empty cache created by a cancellation before the first search batch.
  const partialAbort = new AbortController()
  let matchingProgress = false
  const cancelled = callTool(client, 'optimize', { characterId: TARGET, force: true, resultsLimit: 5 }, {
    signal: partialAbort.signal,
    timeout: 60_000,
    resetTimeoutOnProgress: true,
    onprogress: (progress) => {
      if (progress.progress > 0 && /, [1-9]\d* results,/.test(progress.message ?? '')) {
        matchingProgress = true
        partialAbort.abort()
      }
    },
  }).catch((error) => error)
  await within(cancelled, 60_000, 'No matching rows before the cancellation deadline').finally(() => partialAbort.abort())
  await waitUntilIdle(client)
  const partial = await callTool(client, 'get_results', { limit: 1 })
  check('same-save cancellation retains nonempty partial results', matchingProgress && partial.summary.cancelled === true && partial.rows.length === 1)
  const partialRef = { cacheId: partial.cacheId, rowId: partial.rows[0].id }
  const equipped = await callTool(client, 'equip_build', { characterId: TARGET, fromCache: partialRef })
  check('same-save partial cache can equip all six slots', Object.keys(equipped.build.relics).length === 6)
  const saved = await callTool(client, 'save_build', { characterId: TARGET, name: 'partial-same-save', fromCache: partialRef })
  check('same-save partial cache can save a build', saved.saved.source === 'optimizer')
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-optimizer-generation: ALL CHECKS PASSED' : `\nsmoke-optimizer-generation: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
