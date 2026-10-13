// Keeps the feature rows' verified status in step with the evidence files.
// The rule is evidenceVerdict (evidence.mjs, per PROTOCOL.md); coverage-check
// fails until every row agrees with it.
//
//   - baseline row, implemented, evidence passes every case → verified + citation
//   - verified row the evidence no longer supports          → implemented, citation dropped
//   - verified row, still supported                         → citation follows the current evidence file
//   - any other row carrying a citation                     → citation dropped
//
// An area with verified rows but no evidence file is refused rather than
// demoted wholesale: that is a missing file, not a failed re-verification.
//
// Usage: node scripts/flip-verified.mjs [area ...]   (no args = all areas)
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evidenceVerdict,
  loadEvidence,
} from './evidence.mjs'

const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const featuresDir = resolve(mcpDir, 'coverage/features')

const args = process.argv.slice(2)
const areas = args.length > 0 ? args : readdirSync(featuresDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
const evidence = loadEvidence()

const totals = { promoted: 0, demoted: 0, refreshed: 0 }
for (const area of areas) {
  const featuresPath = resolve(featuresDir, `${area}.json`)
  if (!existsSync(featuresPath)) {
    console.log(`${area}: 跳过（缺 features 文件）`)
    continue
  }
  const doc = JSON.parse(readFileSync(featuresPath, 'utf8'))
  if (!evidence.docs.has(area) && doc.features.some((row) => row.mcp.status === 'verified')) {
    console.error(`${area}: verified 行存在但缺 coverage/evidence/${area}.json——先跑 npm run verify:all 重新取证,未改动`)
    process.exitCode = 1
    continue
  }
  const promoted = []
  const demoted = []
  let refreshed = 0
  const pending = []
  for (const row of doc.features) {
    const verdict = evidenceVerdict(row, area, evidence)
    if (row.mcp.status === 'verified') {
      if (!verdict.supported) {
        row.mcp.status = 'implemented'
        delete row.acceptance.evidence
        // coverage-check requires implemented rows to cite a test file; only a person can add one.
        const untested = row.acceptance.tests?.length ? '' : ' — 该行没有 acceptance.tests,coverage:check 会要求补上'
        demoted.push(`${row.id}(${verdict.blockers.join('; ')})${untested}`)
      } else if (row.acceptance.evidence?.length !== 1 || row.acceptance.evidence[0] !== verdict.citation) {
        row.acceptance.evidence = [verdict.citation]
        refreshed++
      }
    } else if (row.scope === 'baseline' && row.mcp.status === 'implemented' && verdict.supported) {
      row.mcp.status = 'verified'
      row.acceptance.evidence = [verdict.citation]
      promoted.push(row.id)
    } else {
      // Only verified rows cite evidence (a citation left behind by a hand edit).
      if (row.acceptance.evidence) {
        delete row.acceptance.evidence
        refreshed++
      }
      if (row.scope === 'baseline' && row.mcp.status === 'implemented') pending.push(`${row.id}(${verdict.blockers.join('; ')})`)
    }
  }
  if (promoted.length + demoted.length + refreshed > 0) writeFileSync(featuresPath, `${JSON.stringify(doc, null, 2)}\n`)
  totals.promoted += promoted.length
  totals.demoted += demoted.length
  totals.refreshed += refreshed
  console.log(`${area}: 升为 verified ${promoted.length} · 退回 implemented ${demoted.length} · 更新引用 ${refreshed}`)
  for (const id of promoted) console.log(`  ↑ ${id}`)
  for (const entry of demoted) console.log(`  ↓ ${entry}`)
  for (const entry of pending) console.log(`  · 未齐 ${entry}`)
}
console.log(`\n共升 ${totals.promoted} 行,退 ${totals.demoted} 行,更新引用 ${totals.refreshed} 行`)
