// Runs every evidence script (verify-<area>.mjs) in turn and reports what each
// one recorded in coverage/evidence/.
//
// A verify script exits 1 as soon as one of its cases fails, so chaining them
// with && would stop at the first area that has a known FAIL. Here a failed
// case is data. The run itself fails when a script proved nothing: it left its
// evidence untouched (crashed before writing, or printed [SKIP] because Chrome
// or the site dist is missing), ran past the time limit, or was killed. A
// killed script's partial writes are rolled back.
//
// Usage: node scripts/verify-all.mjs [name ...]   (from mcp/; no names = every script)
//   name is the part between "verify-" and ".mjs", e.g. `showcase preview site`
//   VERIFY_TIMEOUT_MIN  per-script limit in minutes (default 90)
//
// Afterwards: npm run coverage:flip && npm run coverage:check -- --write

import { spawn } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { evidenceDir } from './evidence.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const mcpDir = dirname(scriptsDir)
const repoRoot = resolve(mcpDir, '..')

// verify-team-audit is a smoke suite (part of smoke:all); it writes no evidence.
const NOT_EVIDENCE = new Set(['verify-all.mjs', 'verify-team-audit.mjs'])
const available = readdirSync(scriptsDir).filter((name) => /^verify-.+\.mjs$/.test(name) && !NOT_EVIDENCE.has(name)).sort()
const nameOf = (script) => script.replace(/^verify-|\.mjs$/g, '')

const requested = process.argv.slice(2)
const unknown = requested.filter((name) => !available.some((script) => nameOf(script) === name))
if (unknown.length > 0) {
  console.error(`verify-all: no such script: ${unknown.join(', ')} (available: ${available.map(nameOf).join(' ')})`)
  process.exit(2)
}
const scripts = requested.length > 0 ? available.filter((script) => requested.includes(nameOf(script))) : available

const timeoutMs = Number(process.env.VERIFY_TIMEOUT_MIN ?? 90) * 60_000
// setTimeout treats NaN, 0 and anything past 2^31-1 ms as "now".
if (!(timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1)) {
  console.error(`verify-all: VERIFY_TIMEOUT_MIN must be a number of minutes between 0 and 35791, got "${process.env.VERIFY_TIMEOUT_MIN}"`)
  process.exit(2)
}

// ── Preflight: the evidence describes the builds, not the sources ───────────

function newestMtime(path) {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(resolve(path, entry)))
  return newest
}

function preflight() {
  const warnings = []
  const serverBuild = resolve(mcpDir, 'dist/index.js')
  if (!existsSync(serverBuild)) {
    console.error('verify-all: mcp/dist/index.js is missing — run `npm run build` in mcp/ first')
    process.exit(2)
  }
  const sourcesOf = (...paths) => Math.max(...paths.map((path) => newestMtime(resolve(repoRoot, path))))
  if (statSync(serverBuild).mtimeMs < sourcesOf('src', 'mcp/src', 'mcp/vite.mcp.config.ts')) {
    warnings.push('mcp/dist is older than its sources — rebuild it, or the evidence describes the previous server build')
  }
  // Same resolution as the scripts' findSiteDist: the override counts only when it holds a build.
  const override = process.env.HSR_MCP_SITE_DIST
  const siteBuild = resolve(override && existsSync(`${override}/index.html`) ? override : resolve(repoRoot, 'dist'), 'index.html')
  if (!existsSync(siteBuild)) {
    warnings.push('the site dist is missing — the scripts will [SKIP]; run `npm run build` in the repo root first')
  } else if (statSync(siteBuild).mtimeMs < sourcesOf('src', 'public', 'index.html', 'vite.config.ts')) {
    warnings.push('the site dist is older than its sources — rebuild it, or the web side of the parity runs the previous site build')
  }
  return warnings
}

// ── Run ──────────────────────────────────────────────────────────────────────

const STOP_GRACE_MS = 10_000

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch { /* already gone */ }
}

// SIGINT rather than SIGTERM: puppeteer's SIGTERM handler closes Chrome but
// leaves the script running, which would then record the fallout as FAILs; its
// SIGINT handler kills Chrome and exits. The MCP server in the same process
// group shuts down on either. SIGKILL is the backstop for a script that hangs.
function stop(child) {
  signalGroup(child, 'SIGINT')
  const backstop = setTimeout(() => {
    console.warn('[WARN] the script ignored SIGINT — killing it; a Chrome it started may be left behind')
    signalGroup(child, 'SIGKILL')
  }, STOP_GRACE_MS)
  child.once('close', () => clearTimeout(backstop))
}

let current = null
let interrupted = null
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (interrupted) return
    interrupted = signal
    // The loop below exits once the script is gone, so it cannot write evidence after we return.
    if (current) stop(current)
    else process.exit(130)
  })
}

function run(script) {
  return new Promise((done) => {
    const startedAt = Date.now()
    const finish = (exit) => {
      clearTimeout(timer)
      current = null
      done({ exit, seconds: (Date.now() - startedAt) / 1000 })
    }
    // Own process group: the script starts the MCP server, and both must go on a stop.
    const child = spawn(process.execPath, [resolve(scriptsDir, script)], { cwd: mcpDir, stdio: 'inherit', detached: true })
    current = child
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop(child)
    }, timeoutMs)
    child.on('error', (e) => finish(`spawn failed: ${e.message}`))
    child.on('close', (code, signal) => finish(timedOut ? 'timeout' : code ?? signal))
  })
}

const evidenceFiles = () => (existsSync(evidenceDir) ? readdirSync(evidenceDir).filter((name) => name.endsWith('.json')) : [])
const snapshot = () => new Map(evidenceFiles().map((name) => [name, readFileSync(resolve(evidenceDir, name), 'utf8')]))

function rollBack(before) {
  for (const name of evidenceFiles()) {
    const path = resolve(evidenceDir, name)
    if (!before.has(name)) rmSync(path)
    else if (readFileSync(path, 'utf8') !== before.get(name)) writeFileSync(path, before.get(name))
  }
}

function tally(name, text) {
  try {
    const doc = JSON.parse(text)
    const count = (result) => (doc.cases ?? []).filter((record) => record.result === result).length
    return `${name.replace(/\.json$/, '')} ${count('PASS')}/${count('FAIL')}/${count('UNPROVEN')} @${doc.gitCommit}`
  } catch {
    return `${name} UNREADABLE`
  }
}

const buildWarnings = preflight()
for (const warning of buildWarnings) console.warn(`[WARN] ${warning}`)

const rows = []
for (const script of scripts) {
  console.log(`\n━━ ${script} ${'━'.repeat(Math.max(0, 70 - script.length))}`)
  const before = snapshot()
  const outcome = await run(script)
  // 0 = every case passed, 1 = some case failed; anything else, or a stop request mid-run, means it did not finish.
  const completed = !interrupted && (outcome.exit === 0 || outcome.exit === 1)
  if (!completed) rollBack(before)
  const written = completed ? [...snapshot()].filter(([name, text]) => before.get(name) !== text) : []
  rows.push({ script, ...outcome, completed, evidence: written.map(([name, text]) => tally(name, text)) })
  if (interrupted) break
}

console.log(`\n${'━'.repeat(74)}\nverify-all: evidence written (PASS/FAIL/UNPROVEN @commit)\n`)
for (const row of rows) {
  const time = `${Math.floor(row.seconds / 60)}m${String(Math.floor(row.seconds % 60)).padStart(2, '0')}s`
  const evidence = row.evidence.length > 0 ? row.evidence.join(' · ') : row.completed ? 'NO EVIDENCE WRITTEN' : 'DID NOT FINISH — evidence left as it was'
  console.log(`  ${row.script.padEnd(26)} exit ${String(row.exit).padEnd(8)} ${time.padStart(7)}  ${evidence}`)
}
// Repeated here: by now the startup warnings are hours of output away.
for (const warning of buildWarnings) console.warn(`[WARN] ${warning}`)

if (interrupted) {
  console.log(`\nverify-all: stopped by ${interrupted} after ${rows.length} of ${scripts.length} script(s)`)
  process.exit(130)
}
const broken = rows.filter((row) => row.evidence.length === 0)
if (broken.length > 0) {
  console.log(`\nverify-all: ${broken.length} script(s) proved nothing: ${broken.map((row) => row.script).join(', ')}`)
  process.exit(1)
}
console.log('\nverify-all: every script wrote its evidence — next: npm run coverage:flip && npm run coverage:check -- --write')
