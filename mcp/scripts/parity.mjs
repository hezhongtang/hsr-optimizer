// M1 acceptance parity harness for the HSR Optimizer MCP server.
//
// The M1 acceptance bar is "same save, same form → the MCP optimize output is
// line-by-line identical to the upstream engine". The MCP driver already runs
// the upstream `Optimizer.optimize`, so what this harness proves is that the
// WRAPPER layer (request building, snapshot reload, serialization) introduces
// no drift, plus the operational guardrails:
//
//   (a) determinism — two consecutive stdio optimize runs (sample save,
//       1212b1, no overrides) produce the identical row id sequence and
//       bitwise-identical stat values
//   (b) in-process baseline — dist/parityRef.js replays the optimize tool's
//       exact request recipe (saved form → computeLoadForm → displayToInternal
//       → rank/resultsLimit sync, flushSave snapshot) straight into
//       runOptimization, bypassing the MCP layer; compared with the stdio run
//       row-by-row, firstMismatch style (id + every numeric column)
//   (c) formOverrides round — a setFilters 4pc constraint yields DIFFERENT
//       rows and fewer valid permutations than the unconstrained run
//       (overrides genuinely reach the engine)
//   (d) scale gate — a ~1944-relic inventory (12x clone, spike S5d recipe):
//       optimize is refused with per-part counts + tightening suggestions;
//       force:true + immediate cancel → cancelled semantics with partial
//       results retained and served from the cache
//   (e) wipe protection — reset_all never overwrites the non-empty save file
//       on disk, and neither does the follow-up character-only write whose
//       flush shrinks the relics set to zero (critical-set shrink guard);
//       the blocked write stays VISIBLE: save_status keeps reporting
//       dirty:true and surfaces blockedWrite instead of silently clearing
//       the pending-changes flag while every change of the session is dropped
//
// Everything the server can persist (save copy, localStorage backend) lives in
// a temp directory; repo files are never write targets.
//
// Usage: node scripts/parity.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/);
//   the parityRef entry is resolved from the same directory.

import {
  spawn,
} from 'node:child_process'
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
const parityRefEntry = resolve(dirname(serverEntry), 'parityRef.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const TARGET = '1212b1'
// Foundation-phase optimize measured this for 1212b1 on the sample save —
// every full (non-cancelled) run must reproduce it exactly.
const EXPECTED_VALID_PERMUTATIONS = 462672

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-parity-`)
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

/** Normalize stdio optimize rows ({id, stats}) into flat {id, ...stats} rows. */
function toComparable(run) {
  return run.rows.map((row) => ({ id: row.id, ...row.stats }))
}

/**
 * Row-by-row comparison, firstMismatch style (spike P1 heritage).
 * Both sides are flat rows: {id, ...numericColumns}.
 * Returns null when identical, else the first divergence with ids/key columns.
 */
function firstMismatch(leftRows, rightRows) {
  if (leftRows.length !== rightRows.length) {
    return { kind: 'length', left: leftRows.length, right: rightRows.length }
  }
  for (let i = 0; i < leftRows.length; i++) {
    const left = leftRows[i]
    const right = rightRows[i]
    if (left.id !== right.id) {
      return { index: i, kind: 'id', left: left.id, right: right.id }
    }
    for (const [column, value] of Object.entries(left)) {
      if (column === 'id') continue
      if (right[column] !== value) {
        return { index: i, id: left.id, kind: 'column', column, left: value, right: right[column] }
      }
    }
  }
  return null
}

function runParityRef(savePath, characterId) {
  // Spawned as a plain subprocess: node dist/parityRef.js <save> <characterId>
  // → JSON { rows, summary } on stdout. Its shims-backed localStorage is
  // pointed at a temp file so nothing leaks into the user's home directory.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [parityRefEntry, savePath, characterId], {
      cwd: mcpDir,
      env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/parityref-localstorage.json` },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => void (stdout += chunk))
    child.stderr.on('data', (chunk) => void (stderr += chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`parityRef exited ${code}: ${stderr.slice(-2000)}`))
        return
      }
      try {
        resolvePromise(JSON.parse(stdout))
      } catch (e) {
        reject(new Error(`parityRef stdout not JSON: ${String(e)}; tail: ${stdout.slice(-500)} / stderr: ${stderr.slice(-500)}`))
      }
    })
  })
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'parity', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'pipe',
})
await client.connect(transport)

// Drain server stderr: stdout carries protocol frames, diagnostics land here.
// An undrained pipe would eventually backpressure the server; the string itself
// is only inspected ad hoc when debugging a harness failure.
let serverStderr = ''
transport.stderr?.on('data', (chunk) => void (serverStderr += chunk))

try {
  await callTool(client, 'load_save', { path: sampleSavePath })

  // ── (a) determinism: two consecutive stdio optimize runs ──────────────────
  const run1 = await callTool(client, 'optimize', { characterId: TARGET }, { timeout: 300_000 })
  const run2 = await callTool(client, 'optimize', { characterId: TARGET }, { timeout: 300_000 })

  check('a: both runs completed', run1.status === 'completed' && run2.status === 'completed', `${run1.status}/${run2.status}, ${run1.rows.length} rows`)
  check(
    'a: valid permutations reproduce 462672 on both runs',
    run1.summary.validPermutations === EXPECTED_VALID_PERMUTATIONS
      && run2.summary.validPermutations === EXPECTED_VALID_PERMUTATIONS,
    `${run1.summary.validPermutations}/${run2.summary.validPermutations}`,
  )
  const mismatch12 = firstMismatch(toComparable(run1), toComparable(run2))
  check(
    'a: row id sequence + all stat columns identical across runs',
    mismatch12 == null,
    mismatch12 ? JSON.stringify(mismatch12) : `${run1.rows.length} rows, top COMBO=${run1.rows[0].stats.COMBO}`,
  )
  console.log(
    `        run1: id=${run1.rows[0].id} COMBO=${run1.rows[0].stats.COMBO}, `
      + `${run1.summary.searched.toLocaleString()} searched in ${run1.summary.durationMs}ms; `
      + `run2: ${run2.summary.durationMs}ms`,
  )

  // ── (b) in-process baseline: exact recipe → runOptimization directly ──────
  const ref = await runParityRef(sampleSavePath, TARGET)
  check(
    'b: parityRef ran the full search',
    ref.summary.cancelled === false
      && ref.summary.validPermutations === EXPECTED_VALID_PERMUTATIONS,
    `${ref.rows.length} rows, searched ${ref.summary.searched?.toLocaleString()}, gridSortColumn=${ref.summary.gridSortColumn}`,
  )
  const mismatchRef = firstMismatch(toComparable(run1), ref.rows)
  check(
    'b: stdio optimize === in-process runOptimization (row-by-row)',
    mismatchRef == null,
    mismatchRef ? `firstMismatch ${JSON.stringify(mismatchRef)}` : `${run1.rows.length} rows bitwise identical`,
  )

  // ── (c) formOverrides round: setFilters 4pc constraint ────────────────────
  const constrained = await callTool(client, 'optimize', {
    characterId: TARGET,
    formOverrides: { setFilters: { fourPiece: ['Hunter of Glacial Forest'] } },
  }, { timeout: 300_000 })
  check('c: constrained run completed', constrained.status === 'completed' && constrained.rows.length >= 1, `${constrained.rows.length} rows`)
  check(
    'c: valid permutations dropped vs unconstrained',
    constrained.summary.validPermutations < run1.summary.validPermutations,
    `${constrained.summary.validPermutations.toLocaleString()} < ${run1.summary.validPermutations.toLocaleString()}`,
  )
  const constrainedIds = constrained.rows.map((r) => r.id).join(',')
  const runIds = run1.rows.map((r) => r.id).join(',')
  check(
    'c: constrained results differ from unconstrained',
    constrainedIds !== runIds,
    `top id ${constrained.rows[0].id} (COMBO=${constrained.rows[0].stats.COMBO}) vs ${run1.rows[0].id} (COMBO=${run1.rows[0].stats.COMBO})`,
  )
  check(
    'c: constrained optimum does not exceed unconstrained',
    constrained.rows[0].stats.COMBO <= run1.rows[0].stats.COMBO,
    `${constrained.rows[0].stats.COMBO} <= ${run1.rows[0].stats.COMBO}`,
  )

  // ── (d) scale gate on a ~1944-relic inventory ─────────────────────────────
  const sampleSave = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  const bigRelics = []
  for (let k = 0; k < 12; k++) {
    for (const r of sampleSave.relics) {
      bigRelics.push({ ...r, id: `${r.id}#${k}`, equippedBy: k === 0 ? r.equippedBy : undefined })
    }
  }
  const bigSavePath = `${tempDir}/big-save.json`
  writeFileSync(bigSavePath, JSON.stringify({ ...sampleSave, relics: bigRelics }))
  await callTool(client, 'load_save', { path: bigSavePath })

  const refused = await callTool(client, 'optimize', { characterId: TARGET })
  check(
    'd: refused without force',
    refused.status === 'rejected' && refused.validPermutations > 5e7,
    `status=${refused.status}, valid=${refused.validPermutations?.toExponential(2)}`,
  )
  check(
    'd: refusal carries all 6 per-part counts',
    refused.partCounts != null && Object.keys(refused.partCounts).length === 6,
    JSON.stringify(refused.partCounts),
  )
  check(
    'd: refusal carries tightening suggestions',
    Array.isArray(refused.suggestions) && refused.suggestions.length > 0,
    `${refused.suggestions?.length} suggestion(s)`,
  )

  // force:true + cancel on the first progress event (spike-measured cancel
  // latency 80–180ms; partial results are kept server-side and cached)
  const progressEvents = []
  const abortController = new AbortController()
  let cancelledRunError = null
  await callTool(client, 'optimize', { characterId: TARGET, force: true, resultsLimit: 1024 }, {
    signal: abortController.signal,
    timeout: 600_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => {
      progressEvents.push(p)
      if (progressEvents.length >= 1) abortController.abort()
    },
  }).catch((e) => {
    cancelledRunError = e
    return null
  })
  check(
    'd: progress observed and client cancel landed',
    progressEvents.length >= 1 && cancelledRunError != null,
    `${progressEvents.length} progress event(s), client settled as: ${cancelledRunError?.message ?? 'resolution'}`,
  )
  const lastProgress = progressEvents[progressEvents.length - 1]
  check('d: search was underway before the cancel', (lastProgress?.progress ?? 0) > 0, `searched ~${lastProgress?.progress?.toLocaleString()}`)

  // The server-side handler finishes after the client abort and caches the
  // partial results — poll get_results for the new cacheId.
  let cancelledCache = null
  const cancelDeadline = Date.now() + 120_000
  while (Date.now() < cancelDeadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const results = await callTool(client, 'get_results', { limit: 1 })
    if (results.cacheId !== run1.summary.cacheId && results.cacheId !== constrained.summary.cacheId) {
      cancelledCache = results
      break
    }
  }
  check(
    'd: cancelled run retained partial results in the cache',
    cancelledCache != null,
    cancelledCache ? `cacheId=${cancelledCache.cacheId}, total=${cancelledCache.total} row(s)` : 'cache never advanced',
  )
  check(
    'd: server reported the run as cancelled (get_results summary.cancelled)',
    cancelledCache?.summary?.cancelled === true,
    `summary.cancelled=${String(cancelledCache?.summary?.cancelled)}, searched=${cancelledCache?.summary?.searched?.toLocaleString()}`,
  )

  // ── (e) wipe protection — critical-set shrink guard ────────────────────────
  await callTool(client, 'load_save', { path: sampleSavePath })
  await callTool(client, 'reset_all', {})
  await new Promise((r) => setTimeout(r, 2000)) // let the 1s debounced write-back fire
  const afterReset = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  check('e: reset write-back guard held (disk save untouched)', (afterReset.relics?.length ?? 0) === 162, `${afterReset.relics?.length} relics still on disk`)

  // Shrink variant: after the reset, a character-producing write would flush
  // {relics: 0, characters: 1} — the relics set shrinking to zero against a
  // 162-relic file must stay blocked (the pre-fix guard only caught both-empty)
  await callTool(client, 'upsert_character', { characterId: '1107', lightCone: '20000', characterEidolon: 0 })
  await new Promise((r) => setTimeout(r, 2000)) // a fresh debounce window for the upsert
  const afterShrink = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  check(
    'e: shrink write-back guard held (reset + new character must not wipe relics)',
    (afterShrink.relics?.length ?? 0) === 162 && (afterShrink.characters?.length ?? 0) === 8,
    `disk still holds ${afterShrink.relics?.length} relics / ${afterShrink.characters?.length} characters`,
  )

  // The block must also stay VISIBLE: pre-fix, the blocked detectWipe branch
  // silently cleared dirty, so save_status reported dirty:false while every
  // change of the session was being dropped — an agent would believe its
  // writes were persisted. Post-fix dirty stays true and the block is
  // surfaced through the blockedWrite field.
  const blockedStatus = await callTool(client, 'save_status', {})
  check(
    'e: blocked write-back stays visible (dirty true + blockedWrite set)',
    blockedStatus.dirty === true && blockedStatus.blockedWrite != null
      && typeof blockedStatus.blockedWrite.reason === 'string' && blockedStatus.blockedWrite.reason.length > 0,
    `dirty=${String(blockedStatus.dirty)}, blockedWrite=${blockedStatus.blockedWrite ? JSON.stringify(blockedStatus.blockedWrite) : 'missing'}`,
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nparity: ALL CHECKS PASSED' : `\nparity: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
