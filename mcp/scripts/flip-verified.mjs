// Mechanically flips baseline feature rows implemented → verified when the
// area's evidence file records PASS for every acceptance case of the row.
//
// Rules (PROTOCOL.md):
//   - a row flips only if evidence covers case indices 1..cases.length, all PASS
//   - flip = mcp.status "verified" + acceptance.evidence citation
//   - rows with any FAIL / UNPROVEN / missing case stay untouched
//
// Usage: node scripts/flip-verified.mjs [area ...]   (no args = all areas)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDir = resolve(mcpDir, 'coverage/evidence')
const featuresDir = resolve(mcpDir, 'coverage/features')

const args = process.argv.slice(2)
const areas = args.length > 0 ? args : readdirSync(featuresDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))

let totalFlipped = 0
for (const area of areas) {
  const evidencePath = resolve(evidenceDir, `${area}.json`)
  const featuresPath = resolve(featuresDir, `${area}.json`)
  if (!existsSync(evidencePath) || !existsSync(featuresPath)) {
    console.log(`${area}: 跳过（缺 evidence 或 features 文件）`)
    continue
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  const doc = JSON.parse(readFileSync(featuresPath, 'utf8'))
  const byFeature = new Map()
  for (const c of evidence.cases ?? []) {
    if (!byFeature.has(c.feature)) byFeature.set(c.feature, new Map())
    byFeature.get(c.feature).set(c.case, c.result)
  }
  let flipped = 0
  const pending = []
  for (const row of doc.features) {
    if (row.scope !== 'baseline' || row.mcp.status !== 'implemented') continue
    const expected = row.acceptance.cases.length
    const results = byFeature.get(row.id)
    let passCount = 0
    if (results) for (let i = 1; i <= expected; i++) if (results.get(i) === 'PASS') passCount++
    if (passCount === expected && expected > 0) {
      row.mcp.status = 'verified'
      row.acceptance.evidence = [
        `mcp/coverage/evidence/${area}.json#${row.id} cases 1-${expected} PASS ${evidence.generatedAt?.slice(0, 10) ?? ''} (${(evidence.gitCommit ?? '').slice(0, 8)})`,
      ]
      flipped++
    } else if (!results || passCount < expected) {
      pending.push(`${row.id}(${passCount}/${expected})`)
    }
  }
  if (flipped > 0) writeFileSync(featuresPath, JSON.stringify(doc, null, 2) + '\n')
  totalFlipped += flipped
  console.log(`${area}: flipped ${flipped}${pending.length ? `；未齐: ${pending.join(' ')}` : ''}`)
}
console.log(`\n共翻转 ${totalFlipped} 行`)
