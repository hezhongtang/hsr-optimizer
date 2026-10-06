// Coverage check: validates the frozen feature inventory (mcp/coverage/features.json
// plus the per-area files it lists) and proves it against the census.
//
// What it enforces:
//   1. every feature row matches the schema, and feature ids are unique
//   2. every upstream reference resolves: the file exists and names the symbol
//   3. every MCP tool / resource a row claims is actually registered by the server,
//      and every registered tool is claimed by at least one row
//   4. row status is consistent with what it claims (missing / partial / implemented / verified)
//   5. every census entry (control, store action, exported action, interaction,
//      persistence call) is covered by a feature row, or by a mechanism row that
//      says which features that piece of plumbing serves
//   6. the committed census still matches the web source (no silent upstream drift)
//   7. registered tools plus proposed new tools stay within the manifest's toolBudget
//   8. coverage/summary.md is up to date
//
// Usage: node scripts/coverage-check.mjs                    full check (exit 1 on any failure)
//        node scripts/coverage-check.mjs --write            regenerate coverage/summary.md, then check
//        node scripts/coverage-check.mjs --uncovered        also list every uncovered census entry
//        node scripts/coverage-check.mjs --allow-uncovered  report coverage gaps without failing (authoring mode)

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  buildCensus,
  censusKeys,
  censusPath,
} from './coverage-census.mjs'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(mcpDir, '..')
const coverageDir = resolve(mcpDir, 'coverage')
const manifestPath = resolve(coverageDir, 'features.json')
const summaryPath = resolve(coverageDir, 'summary.md')

const PAGES = [
  'GLOBAL',
  'HOME',
  'OPTIMIZER',
  'CHARACTERS',
  'RELICS',
  'IMPORT',
  'SHOWCASE',
  'WARP',
  'BENCHMARKS',
  'CALCULATORS',
  'LEADERBOARD',
  'CHANGELOG',
  'WEBGPU_TEST',
  'METADATA_TEST',
]
const KINDS = ['read', 'write', 'compute', 'artifact', 'external', 'navigate', 'view']
const RUNTIMES = ['node', 'browser', 'host']
const LIFECYCLES = ['persisted', 'session', 'ephemeral', 'derived', 'external', 'none']
const STATUSES = ['missing', 'partial', 'implemented', 'verified']
const SCOPES = ['baseline', 'foundation', 'enhancement']
const UPSTREAM_CHANGES = ['none', 'mirror', 'export', 'extract']

const text = z.string().min(1)
const reference = z.object({ file: text, symbol: text }).strict()

const featureSchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/),
  title: text,
  surface: z.object({
    page: z.enum(PAGES),
    overlay: text.optional(),
    entry: text,
  }).strict(),
  kind: z.enum(KINDS),
  action: text,
  // Baseline rows must name their web entry points; enhancement/foundation rows describe
  // MCP-only capabilities and may have no upstream counterpart (enforced in checkFeature).
  upstream: z.array(reference),
  params: z.array(z.object({ name: text, type: text, default: z.string().optional(), notes: text.optional() }).strict()).optional(),
  defaultsFrom: reference.optional(),
  conditions: text.optional(),
  runtime: z.enum(RUNTIMES),
  state: z.object({
    owner: text,
    lifecycle: z.enum(LIFECYCLES),
    saveKey: text.optional(),
  }).strict(),
  sideEffects: z.array(text).optional(),
  mcp: z.object({
    status: z.enum(STATUSES),
    tools: z.array(text).optional(),
    resources: z.array(text).optional(),
    candidates: z.array(text).optional(),
    gaps: text.optional(),
  }).strict(),
  scope: z.enum(SCOPES),
  upstreamChange: z.enum(UPSTREAM_CHANGES),
  acceptance: z.object({
    cases: z.array(text).min(1),
    tests: z.array(text).optional(),
    evidence: z.array(text).optional(),
  }).strict(),
}).strict()

// Plumbing the census finds but that is not a feature in its own right (scroll
// locking, the generic open/close store, test hooks). It is listed, never excluded:
// each row names the features it serves and why it needs no entry of its own.
const mechanismSchema = z.object({
  id: featureSchema.shape.id,
  title: text,
  upstream: z.array(reference).min(1),
  serves: z.array(text),
  reason: text,
}).strict()

const areaSchema = z.object({
  area: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  title: text,
  features: z.array(featureSchema),
  mechanisms: z.array(mechanismSchema).optional(),
}).strict()

const manifestSchema = z.object({
  schema: z.literal(1),
  baseline: z.object({ commit: text, srcTree: text }).strict(),
  toolBudget: z.number().int().positive(),
  areas: z.array(z.object({ id: text, file: text }).strict()).min(1),
}).strict()

const TOOL_NAME = /^[a-z][a-z0-9_]*$/
const RESOURCE_URI = /^[a-z]+:\/\/\S+$/

const errors = []
const warnings = []
const fail = (message) => errors.push(message)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const fileTextCache = new Map()
function repoFileText(file) {
  if (!fileTextCache.has(file)) {
    const full = resolve(repoRoot, file)
    fileTextCache.set(file, existsSync(full) ? readFileSync(full, 'utf8') : null)
  }
  return fileTextCache.get(file)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function namesSymbol(source, symbol) {
  return new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`).test(source)
}

// ── Load the inventory ───────────────────────────────────────────────────────

function loadInventory() {
  const manifest = manifestSchema.safeParse(readJson(manifestPath))
  if (!manifest.success) {
    fail(`features.json: ${manifest.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    return { manifest: null, features: [], mechanisms: [] }
  }
  const features = []
  const mechanisms = []
  const seen = new Map()
  for (const entry of manifest.data.areas) {
    const areaPath = resolve(coverageDir, entry.file)
    if (!existsSync(areaPath)) {
      fail(`features.json: area file ${entry.file} does not exist`)
      continue
    }
    const raw = readJson(areaPath)
    const area = areaSchema.safeParse(raw)
    if (!area.success) {
      for (const issue of area.error.issues) {
        const [list, index] = issue.path
        const row = typeof index === 'number' && Array.isArray(raw[list]) ? raw[list][index]?.id ?? `${list}#${index}` : ''
        fail(`${entry.file}${row ? ` [${row}]` : ''}: ${issue.path.slice(row ? 2 : 0).join('.')} ${issue.message}`)
      }
      continue
    }
    if (area.data.area !== entry.id) fail(`${entry.file}: area "${area.data.area}" does not match manifest id "${entry.id}"`)
    const register = (row) => {
      if (!row.id.startsWith(`${entry.id}.`)) fail(`${entry.file} [${row.id}]: id must start with "${entry.id}."`)
      if (seen.has(row.id)) fail(`${entry.file} [${row.id}]: duplicate id (also in ${seen.get(row.id)})`)
      seen.set(row.id, entry.file)
      return { ...row, area: entry.id }
    }
    for (const feature of area.data.features) features.push(register(feature))
    for (const mechanism of area.data.mechanisms ?? []) mechanisms.push(register(mechanism))
  }
  return { manifest: manifest.data, features, mechanisms }
}

// ── What the MCP server actually registers ───────────────────────────────────

function registeredSurface() {
  const tools = new Set()
  const resources = new Set()
  const domainFiles = readdirSync(resolve(mcpDir, 'src/domains')).filter((name) => name.endsWith('.ts')).map((name) => `src/domains/${name}`)
  for (const file of ['src/resources.ts', ...domainFiles]) {
    const source = readFileSync(resolve(mcpDir, file), 'utf8')
    // Grammar mirrors TOOL_NAME below: tool names may contain digits.
    for (const match of source.matchAll(/registerTool\(\s*'([a-z][a-z0-9_]*)'/g)) tools.add(match[1])
    for (const match of source.matchAll(/registerResource\(\s*'[^']+',\s*'(game:\/\/[^']+)'/g)) resources.add(match[1])
    for (const match of source.matchAll(/new ResourceTemplate\('(game:\/\/[^']+)'/g)) resources.add(match[1])
  }
  return { tools, resources }
}

// ── Row-level checks ─────────────────────────────────────────────────────────

function checkReferences(where, references) {
  for (const ref of references) {
    const source = repoFileText(ref.file)
    if (source == null) fail(`${where}: upstream file ${ref.file} does not exist`)
    else if (ref.symbol !== '*' && !namesSymbol(source, ref.symbol)) fail(`${where}: ${ref.file} does not name symbol "${ref.symbol}"`)
  }
}

/** "update_state(section=settings)" → "update_state"; resource URIs are kept whole. */
function candidateName(candidate) {
  return candidate.replace(/[(（].*$/, '').trim()
}

function checkFeature(feature, surface) {
  const where = `[${feature.id}]`
  if (feature.scope === 'baseline' && feature.upstream.length === 0) {
    fail(`${where}: baseline rows must name at least one upstream entry point`)
  }
  checkReferences(where, [...feature.upstream, ...(feature.defaultsFrom ? [feature.defaultsFrom] : [])])
  for (const tool of feature.mcp.tools ?? []) {
    if (!surface.tools.has(tool)) fail(`${where}: mcp.tools names "${tool}", which the server does not register`)
  }
  for (const uri of feature.mcp.resources ?? []) {
    if (!surface.resources.has(uri)) fail(`${where}: mcp.resources names "${uri}", which the server does not register`)
  }
  for (const candidate of feature.mcp.candidates ?? []) {
    const name = candidateName(candidate)
    if (!TOOL_NAME.test(name) && !RESOURCE_URI.test(name)) fail(`${where}: candidate "${candidate}" is neither a tool name nor a resource URI`)
  }
  for (const test of feature.acceptance.tests ?? []) {
    if (!existsSync(resolve(repoRoot, test))) fail(`${where}: acceptance test ${test} does not exist`)
  }

  const hasEntry = (feature.mcp.tools?.length ?? 0) + (feature.mcp.resources?.length ?? 0) > 0
  const { status } = feature.mcp
  if (status === 'missing' && hasEntry) fail(`${where}: status is missing but an existing tool/resource is listed (use partial)`)
  if (status !== 'missing' && !hasEntry) fail(`${where}: status ${status} needs at least one existing tool or resource`)
  if (status === 'partial' && !feature.mcp.gaps) fail(`${where}: partial rows must describe the gap in mcp.gaps`)
  if ((status === 'missing' || status === 'partial') && !(feature.mcp.candidates?.length)) {
    fail(`${where}: ${status} rows must name at least one candidate entry`)
  }
  if (status === 'verified' && !(feature.acceptance.evidence?.length)) fail(`${where}: verified rows must cite parity evidence`)
  if (feature.state.lifecycle === 'persisted' && !feature.state.saveKey) fail(`${where}: persisted state must name its saveKey`)
  if (feature.state.lifecycle !== 'persisted' && feature.state.saveKey) fail(`${where}: saveKey is only valid for persisted state`)
}

function checkMechanism(mechanism, featureIds) {
  const where = `[${mechanism.id}]`
  checkReferences(where, mechanism.upstream)
  for (const id of mechanism.serves) {
    if (!featureIds.has(id)) fail(`${where}: serves "${id}", which is not a feature id`)
  }
}

/** Splits the proposed entries into new tools, new resources, and extensions of tools that already exist. */
function proposedSurface(features, surface) {
  const newTools = new Set()
  const newResources = new Set()
  const extendedTools = new Set()
  for (const candidate of features.flatMap((feature) => feature.mcp.candidates ?? [])) {
    const name = candidateName(candidate)
    if (RESOURCE_URI.test(name)) {
      if (!surface.resources.has(name)) newResources.add(name)
    } else if (surface.tools.has(name)) extendedTools.add(name)
    else newTools.add(name)
  }
  return { newTools, newResources, extendedTools }
}

// ── Census coverage ──────────────────────────────────────────────────────────

function indexReferences(rows) {
  const byFile = new Map()
  for (const row of rows) {
    for (const ref of row.upstream) {
      if (!byFile.has(ref.file)) byFile.set(ref.file, [])
      byFile.get(ref.file).push({ symbol: ref.symbol, id: row.id })
    }
  }
  return byFile
}

/** 'precise' when a row names the entry itself, 'wildcard' when only a whole-file row covers it, else null. */
function coverageOf(refs, matches) {
  if (!refs) return null
  if (refs.some((ref) => ref.symbol !== '*' && matches(ref.symbol))) return 'precise'
  return refs.some((ref) => ref.symbol === '*') ? 'wildcard' : null
}

function checkCensus(census, features, mechanisms) {
  const featureRefs = indexReferences(features)
  const mechanismRefs = indexReferences(mechanisms)
  const sections = {}
  const uncovered = []
  const tally = (section, file, matches, describe) => {
    // A feature row always wins; a mechanism row only accounts for what no feature claims.
    const coverage = coverageOf(featureRefs.get(file), matches) ?? (coverageOf(mechanismRefs.get(file), matches) ? 'mechanism' : null)
    sections[section] ??= { total: 0, precise: 0, wildcard: 0, mechanism: 0, uncovered: 0 }
    sections[section].total++
    sections[section][coverage ?? 'uncovered']++
    if (!coverage) uncovered.push(`${section}: ${describe}`)
  }

  for (const control of census.controls) {
    const handlerText = Object.values(control.handlers).join(' ')
    tally(
      'controls',
      control.file,
      (symbol) => symbol === control.owner || symbol === control.scope || symbol === control.tag || namesSymbol(handlerText, symbol),
      `${control.file} ${control.owner}${control.scope !== control.owner ? `/${control.scope}` : ''} <${control.tag}> ${compactHandlers(control)}`,
    )
  }
  for (const store of census.stores) {
    for (const action of store.actions) tally('storeActions', store.file, (symbol) => symbol === action, `${store.file} ${store.store}.${action}`)
  }
  for (const module of census.actionModules) {
    for (const name of module.exports) {
      const parts = name.split(/\(\)\.|\./)
      tally('exports', module.file, (symbol) => parts.includes(symbol), `${module.file} ${name}`)
    }
  }
  // Interaction points and persistence call sites are accounted for per file:
  // some row must reference the file that contains them.
  for (const section of ['interactions', 'persistence']) {
    for (const entry of census[section]) {
      tally(section, entry.file, () => true, `${entry.file} ${entry.kind ?? entry.call}${entry.scope ? ` in ${entry.scope}` : ''}`)
    }
  }
  return { sections, uncovered }
}

function compactHandlers(control) {
  const names = Object.keys(control.handlers)
  const hint = control.hints?.[0] ? ` "${control.hints[0]}"` : ''
  return `${names.length ? names.join(',') : 'bind'}${hint}`
}

// ── Summary ──────────────────────────────────────────────────────────────────

function countBy(items, keyOf) {
  const counts = new Map()
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1)
  return counts
}

function table(header, rows) {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

function renderSummary(manifest, features, mechanisms, coverage, surface, proposed) {
  const baseline = features.filter((feature) => feature.scope === 'baseline')
  const areaRows = manifest.areas.map((area) => {
    const rows = features.filter((feature) => feature.area === area.id)
    const counts = countBy(rows, (feature) => feature.mcp.status)
    return [area.id, rows.length, ...STATUSES.map((status) => counts.get(status) ?? 0), mechanisms.filter((mechanism) => mechanism.area === area.id).length]
  })
  const totals = countBy(features, (feature) => feature.mcp.status)
  areaRows.push(['**合计**', features.length, ...STATUSES.map((status) => totals.get(status) ?? 0), mechanisms.length])

  const breakdown = (title, values, keyOf, source = features) => {
    const counts = countBy(source, keyOf)
    return `**${title}**：${values.map((value) => `${value} ${counts.get(value) ?? 0}`).join(' · ')}`
  }
  const claimedTools = new Set(features.flatMap((feature) => feature.mcp.tools ?? []))
  const names = (set) => [...set].sort().map((name) => `\`${name}\``).join('、') || '无'
  const projected = surface.tools.size + proposed.newTools.size

  return [
    '# 功能覆盖矩阵摘要',
    '',
    '本文件由 `npm run coverage:check -- --write` 生成，请勿手改。条目定义见 [README](../README.md)。',
    '',
    `基线：\`${manifest.baseline.commit}\`（src 树 \`${manifest.baseline.srcTree.slice(0, 12)}\`）。`,
    '',
    '## 按域与状态',
    '',
    table(['域', '功能条目', ...STATUSES, '机制项'], areaRows),
    '',
    `网站基线条目 ${baseline.length} 个，其中已验证 ${baseline.filter((feature) => feature.mcp.status === 'verified').length} 个。`,
    '',
    '## 分布',
    '',
    `- ${breakdown('范围', SCOPES, (feature) => feature.scope)}`,
    `- ${breakdown('运行环境', RUNTIMES, (feature) => feature.runtime)}`,
    `- ${breakdown('是否需要动上游', UPSTREAM_CHANGES, (feature) => feature.upstreamChange)}`,
    `- ${breakdown('类型', KINDS, (feature) => feature.kind)}`,
    `- ${breakdown('状态生命周期', LIFECYCLES, (feature) => feature.state.lifecycle)}`,
    '',
    '## 工具面与预算',
    '',
    `- 已注册工具 ${surface.tools.size} 个（被条目引用 ${claimedTools.size} 个），已注册资源 ${surface.resources.size} 个。`,
    `- 候选新工具 ${proposed.newTools.size} 个：${names(proposed.newTools)}。`,
    `- 候选新资源 ${proposed.newResources.size} 个：${names(proposed.newResources)}。`,
    `- 需扩展参数的现有工具 ${proposed.extendedTools.size} 个：${names(proposed.extendedTools)}。`,
    `- 全部建成后工具数 ${projected}，预算 ${manifest.toolBudget}。`,
    '',
    '## 普查对照',
    '',
    table(
      ['普查项', '总数', '精确对应', '整文件对应', '仅机制项', '未覆盖'],
      Object.entries(coverage.sections).map((
        [section, counts],
      ) => [section, counts.total, counts.precise, counts.wildcard, counts.mechanism, counts.uncovered]),
    ),
    '',
    '## 机制项',
    '',
    '普查扫到、但本身不构成功能的实现管道。逐条列出它服务于哪些功能、为何不需要独立入口。',
    '',
    table(
      ['id', '名称', '服务于', '说明'],
      mechanisms.map((mechanism) => [mechanism.id, mechanism.title, mechanism.serves.join('、') || '—', mechanism.reason]),
    ),
    '',
  ].join('\n')
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2))
const { manifest, features, mechanisms } = loadInventory()
const surface = registeredSurface()

const featureIds = new Set(features.map((feature) => feature.id))
for (const feature of features) checkFeature(feature, surface)
for (const mechanism of mechanisms) checkMechanism(mechanism, featureIds)

const claimedTools = new Set(features.flatMap((feature) => feature.mcp.tools ?? []))
for (const tool of surface.tools) {
  if (!claimedTools.has(tool)) fail(`registered tool "${tool}" is not claimed by any feature row`)
}
const claimedResources = new Set(features.flatMap((feature) => feature.mcp.resources ?? []))
for (const uri of surface.resources) {
  if (!claimedResources.has(uri)) fail(`registered resource "${uri}" is not claimed by any feature row`)
}

const proposed = proposedSurface(features, surface)
if (manifest && surface.tools.size + proposed.newTools.size > manifest.toolBudget) {
  fail(
    `tool budget exceeded: ${surface.tools.size} registered + ${proposed.newTools.size} proposed > ${manifest.toolBudget} — consolidate candidates or raise toolBudget deliberately`,
  )
}

if (!existsSync(censusPath)) {
  fail('coverage/census.json is missing — run `npm run coverage:census`')
} else if (manifest) {
  const committed = readJson(censusPath)
  const fresh = buildCensus()
  const committedKeys = censusKeys(committed)
  const freshKeys = censusKeys(fresh)
  const drift = [...freshKeys].filter((key) => !committedKeys.has(key)).length + [...committedKeys].filter((key) => !freshKeys.has(key)).length
  if (drift > 0) fail(`census drift: ${drift} entries differ from the web source — run \`npm run coverage:census -- --check\` and triage`)
  if (committed.source.srcTree !== manifest.baseline.srcTree) {
    warnings.push(
      `features.json baseline srcTree ${manifest.baseline.srcTree.slice(0, 12)} differs from census srcTree ${committed.source.srcTree.slice(0, 12)}`,
    )
  }

  const coverage = checkCensus(committed, features, mechanisms)
  const uncoveredTotal = coverage.uncovered.length
  if (uncoveredTotal > 0) {
    const message = `census coverage: ${uncoveredTotal} entries are not covered by any feature or mechanism row`
    if (args.has('--allow-uncovered')) warnings.push(message)
    else fail(message)
    if (args.has('--uncovered')) { for (const line of coverage.uncovered) console.log(`  uncovered ${line}`) }
  }

  const summary = renderSummary(manifest, features, mechanisms, coverage, surface, proposed)
  if (args.has('--write')) {
    writeFileSync(summaryPath, summary)
    console.log(`coverage: wrote ${relative(repoRoot, summaryPath)}`)
  } else if (!existsSync(summaryPath) || readFileSync(summaryPath, 'utf8') !== summary) {
    fail('coverage/summary.md is stale — run `npm run coverage:check -- --write`')
  }

  console.log(`coverage: ${features.length} features and ${mechanisms.length} mechanisms in ${manifest.areas.length} areas`)
  for (const [section, counts] of Object.entries(coverage.sections)) {
    const cell = (label, value) => `${label} ${String(value).padStart(4)}`
    console.log(
      `  ${section.padEnd(13)} ${cell('total', counts.total)}  ${cell('precise', counts.precise)}  ${cell('wildcard', counts.wildcard)}  ${
        cell('mechanism', counts.mechanism)
      }  ${cell('uncovered', counts.uncovered)}`,
    )
  }
  console.log(`  tools         registered ${surface.tools.size}  proposed ${proposed.newTools.size}  budget ${manifest.toolBudget}`)
}

for (const warning of warnings) console.log(`[WARN] ${warning}`)
for (const error of errors) console.log(`[FAIL] ${error}`)
if (errors.length > 0) {
  console.log(`\ncoverage-check: ${errors.length} problem(s)`)
  process.exit(1)
}
console.log('\ncoverage-check: ALL CHECKS PASSED')
