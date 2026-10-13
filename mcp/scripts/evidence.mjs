// Shared handling of coverage/evidence/<area>.json: the commit stamp the
// verify-*.mjs scripts write, and the rule that ties a feature row's status to
// what the evidence records. coverage-check enforces the rule; flip-verified
// applies it.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import {
  dirname,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(mcpDir, '..')
export const evidenceDir = resolve(mcpDir, 'coverage/evidence')

// Inputs of the two builds a parity run executes (root dist/ and mcp/dist). The
// verify script driving them is added per script.
const ENGINE_PATHS = [
  'src',
  'public',
  'index.html',
  'vite.config.ts',
  'package-lock.json',
  'patches',
  'mcp/src',
  'mcp/vite.mcp.config.ts',
  'mcp/package-lock.json',
]

function git(...args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Stamp for an evidence file: the short HEAD the run executed against, with
 * "+dirty" when the build inputs or the calling verify script (pass
 * import.meta.url) carry uncommitted changes — the bare hash would then name a
 * tree that never ran. Take it once at startup: HEAD may move during a long run.
 */
export function evidenceCommit(scriptUrl) {
  const head = git('rev-parse', '--short=8', 'HEAD')
  if (!head) return 'unknown'
  const script = relative(repoRoot, fileURLToPath(scriptUrl))
  const pending = git('status', '--porcelain', '--', ...ENGINE_PATHS, script)
  // A failed status proves nothing about the tree: do not claim it was clean.
  return pending === '' ? head : `${head}+dirty`
}

/** Every evidence file by area, plus each feature's records across all of them. */
export function loadEvidence() {
  const docs = new Map()
  const byFeature = new Map()
  if (!existsSync(evidenceDir)) return { docs, byFeature }
  for (const file of readdirSync(evidenceDir).filter((name) => name.endsWith('.json')).sort()) {
    const area = file.replace(/\.json$/, '')
    let doc
    try {
      doc = JSON.parse(readFileSync(resolve(evidenceDir, file), 'utf8'))
    } catch (e) {
      throw new Error(`coverage/evidence/${file} is not valid JSON (${e.message}) — rerun its verify script`)
    }
    if (doc == null || typeof doc !== 'object' || !Array.isArray(doc.cases)) {
      throw new Error(`coverage/evidence/${file} has no cases array — rerun its verify script`)
    }
    docs.set(area, doc)
    for (const record of doc.cases) {
      if (!byFeature.has(record.feature)) byFeature.set(record.feature, [])
      byFeature.get(record.feature).push({ ...record, area })
    }
  }
  return { docs, byFeature }
}

/**
 * Whether the evidence supports `verified` for a row (PROTOCOL.md): the row's
 * own area file records PASS for every acceptance case, and no record of the
 * feature anywhere is FAIL or UNPROVEN. A case recorded more than once counts
 * only if every record of it passed.
 */
export function evidenceVerdict(row, area, evidence) {
  const records = evidence.byFeature.get(row.id) ?? []
  const expected = row.acceptance.cases.length
  const blockers = records
    .filter((record) => record.result !== 'PASS')
    .map((record) => `#${record.case} ${record.result}${record.area === area ? '' : ` (${record.area}.json)`}`)
  const own = records.filter((record) => record.area === area)
  const unrecorded = []
  for (let index = 1; index <= expected; index++) {
    if (!own.some((record) => record.case === index)) unrecorded.push(`#${index}`)
  }
  if (unrecorded.length > 0) blockers.push(`${unrecorded.join(' ')} not recorded in ${area}.json`)
  const supported = expected > 0 && blockers.length === 0
  if (!supported) return { supported, blockers, citation: null }

  const doc = evidence.docs.get(area)
  const methods = [...new Set(own.filter((record) => record.case <= expected).map((record) => record.method))].sort()
  const citation = `mcp/coverage/evidence/${area}.json#${row.id} cases 1-${expected} PASS ${String(doc.generatedAt).slice(0, 10)} (${
    shortStamp(doc.gitCommit)
  }, ${methods.join(' + ')})`
  return { supported, blockers, citation }
}

const shortStamp = (stamp) => (/^[0-9a-f]{40}$/.test(stamp) ? stamp.slice(0, 8) : String(stamp))

/**
 * Areas whose evidence no longer describes the current code: stamped from an
 * uncommitted tree, or the sources it exercised have changed since the stamp.
 * `unknown` lists areas whose stamp cannot be compared (not a commit in this
 * clone, e.g. a shallow checkout).
 */
export function staleEvidence(evidence) {
  const stale = []
  const unknown = []
  for (const [area, doc] of evidence.docs) {
    const stamp = String(doc.gitCommit ?? '')
    const commit = stamp.replace(/\+dirty$/, '')
    if (stamp.endsWith('+dirty')) {
      stale.push({ area, stamp, reason: 'generated from uncommitted changes' })
      continue
    }
    if (!/^[0-9a-f]{7,40}$/.test(commit) || git('cat-file', '-e', `${commit}^{commit}`) == null) {
      unknown.push({ area, stamp })
      continue
    }
    const paths = [...ENGINE_PATHS, ...new Set(doc.cases.map((record) => record.script).filter(Boolean))]
    // Against the working tree, so uncommitted edits count too; diff does not list untracked files.
    const changed = spawnSync('git', ['-C', repoRoot, 'diff', '--quiet', commit, '--', ...paths]).status !== 0
      || git('ls-files', '--others', '--exclude-standard', '--', ...paths) !== ''
    if (changed) stale.push({ area, stamp, reason: 'sources changed since' })
  }
  return { stale, unknown }
}
