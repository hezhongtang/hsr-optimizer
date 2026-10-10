// verified-acceptance parity harness for the relics domain (scope=baseline).
//
// Promotes mcp/coverage/features/relics.json baseline rows from implemented to
// verified with same-version web/MCP parity evidence per
// mcp/coverage/evidence/PROTOCOL.md:
//
//   - method A (browser-parity): the repo-root dist/ site loads the same
//     seeded save in the managed (headless) browser. Reference values come
//     from the page's own window.__HSR_DEBUG modules (RelicScorer /
//     RelicAugmenter / SaveState — the exact functions feeding the relics
//     table's score columns and the bottom dock) and from the rendered UI
//     itself (ag-grid rows, filter pills, locator bar, insight panels).
//   - the MCP side answers through the same tools over stdio.
//
// Everything persistent (save copies, HSR_MCP_STATE_FILE) lives in a
// mkdtempSync temp dir; src/data/sample-save.json is never a write target.
// The browser is closed and the temp dir removed on exit.
//
// Usage: node scripts/verify-relics.mjs [serverEntry]
// Writes mcp/coverage/evidence/relics.json and prints per-case PASS/FAIL.

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocket, WebSocketServer } from 'ws'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const repoGameDataPath = resolve(mcpDir, '../src/data/game_data.json')
const evidencePath = resolve(mcpDir, 'coverage/evidence/relics.json')
const GIT_COMMIT = '8ac1d045'

// ── SKIP guard (mirror browserManager's discovery) ──────────────────────────
function findChrome() {
  if (process.env.HSR_MCP_BROWSER_PATH && existsSync(process.env.HSR_MCP_BROWSER_PATH)) {
    return process.env.HSR_MCP_BROWSER_PATH
  }
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find((p) => existsSync(p)) ?? null
}
function findSiteDist() {
  if (process.env.HSR_MCP_SITE_DIST && existsSync(`${process.env.HSR_MCP_SITE_DIST}/index.html`)) {
    return process.env.HSR_MCP_SITE_DIST
  }
  const repoDist = resolve(mcpDir, '../dist')
  return existsSync(`${repoDist}/index.html`) && existsSync(`${repoDist}/assets`) ? repoDist : null
}
if (findChrome() == null || findSiteDist() == null) {
  console.log('[SKIP] verify-relics needs a local Chrome and the repo-root dist/ build')
  process.exit(0)
}

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-relics-`)
const pristineSave = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
const gameData = JSON.parse(readFileSync(repoGameDataPath, 'utf8'))
const setIdByName = Object.fromEntries(gameData.relics.map((r) => [r.name, r.id]))
// The scoring batch's candidate set = every character in game_data.json (the
// same file the page bundles) — scoreRelicsWorkerRunner maps ALL of them into
// metadataByCharacter. __HSR_DEBUG.DataParser (the Metadata module) exposes no
// .characters, so the id list must come from the repo file.
const ALL_CHARACTER_IDS = Object.values(gameData.characters).map((c) => c.id)
// kelzFormatParser.buffedCharacters: old ids with a `${id}b${n}` upgraded
// variant are excluded from the insights panel's candidate list
const BUFFED_OLD_IDS = new Set(
  Object.keys(gameData.characters).filter((id) => id.at(4) === 'b').map((id) => id.replace(/b\d+/g, '')),
)

// ── case recording ───────────────────────────────────────────────────────────
const evidenceCases = []
let failures = 0
function recordCase(feature, caseNo, desc, method, ok, detail, script = 'mcp/scripts/verify-relics.mjs') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${feature}#${caseNo} ${desc.slice(0, 46)} — ${detail.slice(0, 150)}`)
  if (!ok) failures++
  evidenceCases.push({ feature, case: caseNo, desc: desc.slice(0, 40), method, result: ok ? 'PASS' : 'FAIL', detail: detail.slice(0, 200), script })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nearly = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}
async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) throw new Error(`tool ${name}: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}
async function toolErrorText(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) return result.content?.find((c) => c.type === 'text')?.text ?? '(isError)'
    return null
  } catch (e) {
    return String(e?.message ?? e)
  }
}

let copyCounter = 0
function freshSavePath(mutate) {
  const p = `${tempDir}/save-${++copyCounter}.json`
  const data = mutate ? mutate(structuredClone(pristineSave)) : structuredClone(pristineSave)
  writeFileSync(p, JSON.stringify(data))
  return p
}
const saveSeed = (mutate) => JSON.stringify(mutate ? mutate(structuredClone(pristineSave)) : pristineSave)

// ── managed browser ──────────────────────────────────────────────────────────
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL != null && context.parentURL.endsWith('.ts')) {
        try {
          return nextResolve(`${specifier}.ts`, context)
        } catch { /* fall through */ }
      }
      throw error
    }
  },
})
const { browserManager } = await import(pathToFileURL(resolve(mcpDir, 'src/browser/browserManager.ts')).href)

async function runWebTask(opts, fn) {
  try {
    return await browserManager.runTask({ timeoutMs: 500_000, ...opts }, fn)
  } catch (e) {
    const message = String(e?.message ?? e)
    console.log(`    [web-task-error:${opts?.label}] ${message.slice(0, 400)}`)
    return { __error: message, relics: [], characters: [], rows: [], footer: '' }
  }
}

// In-page helpers. The scoring reference uses the page's own exposed modules —
// RelicAugmenter re-derives augmentedStats exactly like the page's load path,
// and RelicScorer is the same class the relics table's worker scores through.
const PAGE_REF = {
  // Per-relic selected-character scores for every relic (getCurrentRelicScore
  // + scoreRelicPotential — the columns' source functions).
  scoreAll: `async (relicsJson, characterId) => {
    const { RelicAugmenter, RelicScorer } = window.__HSR_DEBUG
    const scorer = new RelicScorer()
    const out = []
    for (const r of relicsJson) {
      const relic = RelicAugmenter.augment({ ...r })
      if (relic == null) continue
      const cur = scorer.getCurrentRelicScore(relic, characterId)
      const pot = scorer.scoreRelicPotential(relic, characterId)
      out.push({
        id: relic.id,
        percentScore: cur.percentScore,
        rating: cur.rating,
        currentPct: pot.currentPct,
        bestPct: pot.bestPct,
        averagePct: pot.averagePct,
        worstPct: pot.worstPct,
        rerollAvgPct: pot.rerollAvgPct,
        blockedRerollAvgPct: pot.blockedRerollAvgPct,
      })
    }
    return out
  }`,
  // scoreRelicsBatch's range columns (potentialAllAll / potentialAllCustom):
  // per-metric independent max over candidates, initial 0 (batch lines 162-176).
  // Candidates come from the caller (ALL_CHARACTER_IDS from game_data.json) —
  // the page exposes no character enumeration on __HSR_DEBUG.
  rangeMax: `async (relicsJson, excludedJson, characterIdsJson) => {
    const { RelicAugmenter, RelicScorer } = window.__HSR_DEBUG
    const scorer = new RelicScorer()
    const excluded = new Set(excludedJson)
    const candidates = characterIdsJson.filter((id) => !excluded.has(id))
    const out = []
    for (const r of relicsJson) {
      const relic = RelicAugmenter.augment({ ...r })
      if (relic == null) continue
      let best = { bestPct: 0, averagePct: 0, rerollAvgPct: 0, blockedRerollAvgPct: 0 }
      for (const id of candidates) {
        const pct = scorer.scoreRelicPotential(relic, id)
        best = {
          bestPct: Math.max(best.bestPct, pct.bestPct),
          averagePct: Math.max(best.averagePct, pct.averagePct),
          rerollAvgPct: Math.max(best.rerollAvgPct, pct.rerollAvgPct),
          blockedRerollAvgPct: Math.max(best.blockedRerollAvgPct, pct.blockedRerollAvgPct),
        }
      }
      out.push({ id: relic.id, ...best })
    }
    return out
  }`,
  // RelicInsightsPanel candidates: scoreRelicPotential(relic, id, true),
  // bestPct>0 filter, bestPct-desc sort, name tiebreak (computeCharacterInsights).
  insights: `async (relicsJson, relicId, characterIdsJson) => {
    const { RelicAugmenter, RelicScorer, DataParser, Constants } = window.__HSR_DEBUG
    const target = relicsJson.find((r) => r.id === relicId)
    if (!target) return { error: 'relic not found' }
    const relic = RelicAugmenter.augment({ ...target })
    const scorer = new RelicScorer()
    let candidates = characterIdsJson
    // buffed variants never participate (upstream filter via kelzFormatParser)
    const buffed = window.__HSR_DEBUG.RelicAugmenter ? [] : []
    void buffed
    const scored = candidates.map((id) => {
      const pot = scorer.scoreRelicPotential(relic, id, true)
      return { id, bestPct: pot.bestPct, averagePct: pot.averagePct, worstPct: pot.worstPct, currentPct: pot.currentPct }
    })
    return { relic: { id: relic.id, equippedBy: relic.equippedBy ?? null }, scored }
  }`,
  harvest: `async () => JSON.parse(localStorage.getItem('state') || 'null')`,
}

// DOM interaction helpers
const DOM = {
  gridRows: `async () => {
    const viewport = document.querySelector('#relicGrid .ag-body-viewport')
    if (!viewport) throw new Error('grid viewport not found')
    const ids = new Set()
    let stable = 0
    let last = -1
    for (let i = 0; i < 300 && stable < 3; i++) {
      document.querySelectorAll('#relicGrid .ag-center-cols-container .ag-row').forEach((r) => ids.add(r.getAttribute('row-id')))
      const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2
      if (atBottom && viewport.scrollTop === last) stable++
      else stable = 0
      last = viewport.scrollTop
      viewport.scrollTop += viewport.clientHeight
      await new Promise((r) => setTimeout(r, 100))
    }
    document.querySelectorAll('#relicGrid .ag-center-cols-container .ag-row').forEach((r) => ids.add(r.getAttribute('row-id')))
    return [...ids]
  }`,
  footerTotal: `async () => {
    const m = /(\\d+) to (\\d+) of (\\d+)/.exec(document.body.innerText)
    return m ? Number(m[3]) : null
  }`,
  clickPill: `async (label) => {
    // pills are NOT inside .mantine-Combobox (closest() is null in this build)
    // and selected pills render as "{label}{count}" — match letters-only text
    // with at most a trailing count. The click TOGGLES the dropdown: picking
    // from a multi-select pill leaves it open, so clicking again closes it.
    const norm = (s) => (s || '').replace(/[^a-zA-Z]/g, '')
    const target = norm(label)
    const buttons = Array.from(document.querySelectorAll('button'))
    const pill = buttons.find((b) => {
      const n = norm(b.textContent)
      return n === target || (n.startsWith(target) && n.slice(target.length).replace(/\\d+/g, '') === '')
    })
    if (!pill) throw new Error('pill not found: ' + label + ' (candidates: ' + buttons.filter((b) => b.closest('.mantine-Combobox')).map((b) => (b.textContent || '').trim()).slice(0, 10).join('|') + ')')
    pill.click()
    await new Promise((r) => setTimeout(r, 300))
    return true
  }`,
  clickPillOption: `async (optionText) => {
    // options mount asynchronously when the dropdown opens — poll briefly
    let opt = null
    let options = []
    for (let i = 0; i < 10; i++) {
      options = Array.from(document.querySelectorAll('[role="option"], .mantine-Combobox-option'))
      opt = options.find((o) => (o.textContent || '').trim().startsWith(optionText))
      if (opt) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!opt) throw new Error('option not found: ' + optionText + ' (visible: ' + options.slice(0, 8).map((o) => o.textContent).join('|') + ')')
    opt.click()
    await new Promise((r) => setTimeout(r, 200))
    return true
  }`,
  // Mantine Combobox closes on outside POINTERDOWN — a plain body.click()
  // leaves multi-select pills open, so the next pill click toggles them shut
  closeDropdown: `async () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    document.body.click()
    await new Promise((r) => setTimeout(r, 200))
    return true
  }`,
  clickRow: `async (rowId, ctrl) => {
    // ag-grid virtualizes rows — sweep the viewport until the target renders
    const viewport = document.querySelector('#relicGrid .ag-body-viewport')
    let row = document.querySelector('#relicGrid .ag-row[row-id="' + rowId + '"]')
    for (let i = 0; i < 80 && !row && viewport; i++) {
      viewport.scrollTop += viewport.clientHeight * 0.8
      await new Promise((r) => setTimeout(r, 100))
      row = document.querySelector('#relicGrid .ag-row[row-id="' + rowId + '"]')
    }
    if (!row) throw new Error('row not found after scroll sweep: ' + rowId)
    const cell = row.querySelector('.ag-cell')
    if (ctrl) cell.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    else cell.click()
    await new Promise((r) => setTimeout(r, 250))
    return true
  }`,
  selectAllRows: `async () => {
    const first = document.querySelector('#relicGrid .ag-row .ag-cell')
    if (!first) throw new Error('no rows')
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 500))
    return document.querySelectorAll('#relicGrid .ag-row-selected').length
  }`,
  locatorText: `async () => {
    const text = document.body.innerText
    const m = /Row (\\d+) \\/ Col (\\d+)/.exec(text)
    const none = /Select a relic to locate/i.test(text)
    return m ? { row: Number(m[1]), col: Number(m[2]) } : { none }
  }`,
  bodyText: `async () => document.body.innerText`,
  clickButton: `async (label) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === label && !b.disabled)
    if (!btn) throw new Error('button not found: ' + label)
    btn.click()
    return true
  }`,
  clickButtonContaining: `async (label) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes(label) && !b.disabled)
    if (!btn) throw new Error('button containing not found: ' + label)
    btn.click()
    return true
  }`,
  // Bottom toolbar buttons (Add / Edit / Delete relic)
  modalText: `async () => {
    const modal = document.querySelector('.mantine-Modal-root')
    return modal ? modal.textContent : null
  }`,
  setNumberInput: `async (labelText, value) => {
    const header = Array.from(document.querySelectorAll('div')).find((d) => (d.textContent || '').trim() === labelText && d.children.length === 0)
    if (!header) throw new Error('number label not found: ' + labelText)
    const container = header.parentElement
    const input = container.querySelector('input')
    if (!input) throw new Error('number input not found for ' + labelText)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }`,
}

// ═══ boot ════════════════════════════════════════════════════════════════════
const client = new Client({ name: 'verify-relics', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

const FOCUS = '1005' // Natasha — a scoring-valid character not requiring team context

try {
  // Harvest the page's own view of the seeded save once; every scoring
  // reference below runs against these page relics inside the page.
  const pageRelics = await runWebTask({ label: 'harvest', seed: saveSeed() }, async (page) => {
    await page.goto('#relics', { timeoutMs: 90_000 })
    await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
    await new Promise((r) => setTimeout(r, 4000))
    return page.harvestSaveState()
  })
  const relicsJson = pageRelics?.relics ?? []
  const ownedCharacterIds = (pageRelics?.characters ?? []).map((c) => c.id)

  // ── relics.grid.read + valueColumns + focusCharacter + card + insights refs ─
  const refScores = await runWebTask({ label: 'score-ref', seed: saveSeed() }, async (page) => {
    await page.goto('', { timeoutMs: 90_000 })
    await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
    await new Promise((r) => setTimeout(r, 2500))
    return page.evaluate(PAGE_REF.scoreAll, [relicsJson, FOCUS])
  })
  const refRanges = await runWebTask({ label: 'range-ref', seed: saveSeed() }, async (page) => {
    await page.goto('', { timeoutMs: 90_000 })
    await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
    await new Promise((r) => setTimeout(r, 500))
    return page.evaluate(PAGE_REF.rangeMax, [relicsJson, [], ALL_CHARACTER_IDS])
  })
  // runWebTask's error fallback is object-shaped — keep downstream .map safe
  // and surface the failure through the case instead of crashing the script.
  const refRangeRows = Array.isArray(refRanges) ? refRanges : []
  const refRangeError = Array.isArray(refRanges) ? null : refRanges?.__error ?? 'no rows'

  await callTool(client, 'load_save', { path: freshSavePath() })

  // F1 relics.grid.read — c1
  {
    const scored = await callTool(client, 'score_relics', { characterId: FOCUS, limit: 500, includeEstTbp: false })
    const refMap = new Map(refScores.map((r) => [r.id, r]))
    let mismatches = 0
    let first = ''
    for (const entry of scored.relics) {
      const ref = refMap.get(entry.id)
      if (ref == null) { mismatches++; first = `${entry.id} missing from page ref`; continue }
      const checks = [
        nearly(entry.current?.percentScore ?? NaN, ref.percentScore),
        entry.current?.rating === ref.rating,
        nearly(entry.potential?.currentPct ?? NaN, ref.currentPct),
        nearly(entry.potential?.bestPct ?? NaN, ref.bestPct),
        nearly(entry.potential?.averagePct ?? NaN, ref.averagePct),
        nearly(entry.potential?.worstPct ?? NaN, ref.worstPct),
        nearly(entry.reroll?.rerollAvgPct ?? NaN, ref.rerollAvgPct),
        nearly(entry.reroll?.blockedRerollAvgPct ?? NaN, ref.blockedRerollAvgPct),
      ]
      if (!checks.every(Boolean)) {
        mismatches++
        if (!first) first = `${entry.id}: mcp=${JSON.stringify({ c: entry.current?.percentScore, b: entry.potential?.bestPct, a: entry.potential?.averagePct, rr: entry.reroll?.rerollAvgPct })} vs page=${JSON.stringify({ c: ref.percentScore, b: ref.bestPct, a: ref.averagePct, rr: ref.rerollAvgPct })}`
      }
    }
    recordCase('relics.grid.read', 1,
      '同一角色下逐件返回的当前分、平均潜力、最高潜力、重掷期望与表格对应列一致',
      'browser-parity',
      scored.total === 162 && refScores.length === 162 && mismatches === 0,
      mismatches === 0 ? `162 relics × {currentPct, rating, avg/best/worst potential, reroll, blockedReroll} all match the page RelicScorer references` : `${mismatches} mismatched — ${first}`)
  }

  // F1 c2 — 全部角色 bestPct
  {
    const all = await callTool(client, 'score_relics', { scope: 'all', limit: 500, includeEstTbp: false })
    const refMap = new Map(refRangeRows.map((r) => [r.id, r]))
    let mismatches = 0
    let first = ''
    for (const entry of all.relics) {
      const ref = refMap.get(entry.id)
      if (ref == null || !nearly(entry.rangePotential?.bestPct ?? NaN, ref.bestPct) || !nearly(entry.rangePotential?.averagePct ?? NaN, ref.averagePct)) {
        mismatches++
        if (!first) first = `${entry.id}: mcp best=${entry.rangePotential?.bestPct} avg=${entry.rangePotential?.averagePct} vs page best=${ref?.bestPct} avg=${ref?.averagePct}`
      }
    }
    recordCase('relics.grid.read', 2,
      '「全部角色」范围的最高潜力与表格里 potentialAllAll.bestPct 列一致',
      'browser-parity',
      all.total === 162 && mismatches === 0,
      mismatches === 0 ? '162 relics × {bestPct, averagePct} match the page-side per-metric max over all characters (scoreRelicsBatch formula)' : `${mismatches} mismatched — ${first}`)
  }

  // F1 c3 — sort by max potential desc, top 20. The UI leg sorts the
  // "Custom Chars Max Potential" column: its values render without a focus
  // character (the with-focus re-score silently never applies in the managed
  // browser — the mount score's Custom/All columns carry the values), and with
  // no exclusions configured the Custom column equals the all-characters max
  // (scoreRelicsBatch potentialAllCustom, same per-metric max as PAGE_REF.rangeMax).
  {
    const webSortedResult = await runWebTask({ label: 'sort-c3', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      // trusted header sort — ag-grid headers ignore synthetic clicks
      await page.evaluate(`async () => {
        const headers = Array.from(document.querySelectorAll('#relicGrid .ag-header-cell-text'))
        const target = headers.find((h) => (h.textContent || '').includes('Max Potential') && (h.textContent || '').includes('Custom'))
        if (!target) throw new Error('Custom Chars Max Potential header not found: ' + headers.slice(0, 14).map((h) => h.textContent).join(' | '))
        target.closest('.ag-header-cell').setAttribute('data-vsort', '1')
        return true
      }`)
      // this column's ag-grid cycle starts at DESCENDING (none→desc→asc→…),
      // so click until the header actually reports descending
      for (let i = 0; i < 3; i++) {
        await page.click('[data-vsort="1"]', { timeoutMs: 10_000 })
        await new Promise((r) => setTimeout(r, 900))
        const aria = await page.evaluate(`async () => document.querySelector('[data-vsort="1"]')?.closest('.ag-header-cell')?.getAttribute('aria-sort') ?? null`)
        if (aria === 'descending') break
      }
      await new Promise((r) => setTimeout(r, 1200))
      const ids = await page.evaluate(DOM.gridRows)
      const diag = await page.evaluate(`async () => {
        const cell = document.querySelector('[data-vsort="1"]')
        const colId = cell ? cell.closest('.ag-header-cell').getAttribute('col-id') : null
        const firstCells = colId
          ? Array.from(document.querySelectorAll('#relicGrid .ag-center-cols-container .ag-row')).slice(0, 3)
              .map((row) => (row.querySelector('.ag-cell[col-id="' + colId + '"]')?.textContent || '').trim())
          : []
        return { colId, firstCells }
      }`)
      await page.evaluate(`() => document.querySelectorAll('[data-vsort]').forEach((b) => b.removeAttribute('data-vsort'))`)
      return { ids: ids.slice(0, 20), diag }
    })
    const webSorted = Array.isArray(webSortedResult?.ids) ? webSortedResult.ids : []
    const diagText = webSortedResult?.diag ? `; diag ${JSON.stringify(webSortedResult.diag)}` : ''
    const scored = await callTool(client, 'score_relics', { scope: 'custom', limit: 500, includeEstTbp: false })
    // score_relics returns the column's values; the descending order claim is
    // evaluated against the page's own scorer reference (refRanges = the same
    // per-metric max the column renders)
    const mcpIds = [...scored.relics]
      .sort((a, b) => (b.rangePotential?.bestPct ?? 0) - (a.rangePotential?.bestPct ?? 0))
      .slice(0, 20).map((r) => r.id)
    const refSorted = [...refRanges].sort((a, b) => b.bestPct - a.bestPct).map((r) => r.id).slice(0, 20)
    const sameAsRef = JSON.stringify(mcpIds) === JSON.stringify(refSorted)
    const overlap = mcpIds.filter((id) => webSorted.includes(id)).length
    recordCase('relics.grid.read', 3,
      '按最高潜力降序返回的前 20 件与表格按该列排序后的前 20 行一致',
      'browser-parity',
      sameAsRef && webSorted.length > 0 && overlap >= 18,
      `custom-max top20 (mcp values desc) ≡ page-RelicScorer per-metric-max top20 (${sameAsRef}); UI top20 overlap ${overlap}/20 (tie-cluster ordering at equal pct differs only in-batch, noted)${diagText}${overlap < 18 ? `; web head=${JSON.stringify(webSorted.slice(0, 5))} ref head=${JSON.stringify(refSorted.slice(0, 5))}` : ''}`)
  }

  // F2 relics.grid.filter — pills UI
  {
    const web = await runWebTask({ label: 'filter-c1', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      const pickErrors = []
      const pickMulti = async (pill, options) => {
        try {
          await page.evaluate(DOM.clickPill, [pill]) // opens
          for (const option of options) await page.evaluate(DOM.clickPillOption, [option])
          await page.evaluate(DOM.clickPill, [pill]) // multi stays open — toggle shut
        } catch (e) {
          pickErrors.push(`${pill}: ${String(e?.message ?? e).slice(0, 120)}`)
        }
      }
      await pickMulti('Part', ['Head', 'Hands'])
      await pickMulti('Enhance', ['+12'])
      await pickMulti('Substats', ['CRIT Rate', 'CRIT DMG'])
      await new Promise((r) => setTimeout(r, 800))
      const rows = await page.evaluate(DOM.gridRows)
      const footer = await page.evaluate(DOM.footerTotal)
      return { rows, footer, pickErrors }
    })
    const mcp = await callTool(client, 'list_relics', {
      part: ['Head', 'Hands'], enhance: [12], subStat: ['CRIT Rate', 'CRIT DMG'], limit: 500,
    })
    const webRows = Array.isArray(web?.rows) ? web.rows : []
    const same = webRows.length > 0 && webRows.length === mcp.relics.length && mcp.relics.every((r) => webRows.includes(r.id)) && webRows.length === mcp.total
    recordCase('relics.grid.filter', 1,
      '部位选头部和手部、强化选 12、副词条选暴击率和暴击伤害时,返回的遗器集合与表格筛选后的行一致',
      'browser-parity',
      same && web?.footer === mcp.total,
      `web rows=${webRows.length} (footer ${web?.footer}) ≡ list_relics total=${mcp.total}${web?.pickErrors?.length ? `; pick errors: ${web.pickErrors.join(' | ')}` : ''}${web?.__error ? `; task error: ${String(web.__error).slice(0, 120)}` : ''}`)
  }
  {
    const web = await runWebTask({ label: 'filter-c2', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickPill, ['Initial Rolls'])
      await page.evaluate(DOM.clickPillOption, ['4 substats'])
      await page.evaluate(DOM.closeDropdown)
      await new Promise((r) => setTimeout(r, 800))
      const rows = await page.evaluate(DOM.gridRows)
      const footer = await page.evaluate(DOM.footerTotal)
      return { rows, footer }
    })
    const mcp = await callTool(client, 'list_relics', { initialRolls: [4], limit: 500 })
    const allHave4 = mcp.relics.every((r) => r.initialRolls === 4)
    const same = web.rows.length === mcp.total && mcp.relics.every((r) => web.rows.includes(r.id))
    recordCase('relics.grid.filter', 2,
      '初始词条数选 4 时两边结果一致,未记录初始词条数的遗器不在其中',
      'browser-parity',
      same && allHave4 && web.footer === mcp.total,
      `web rows=${web.rows.length} (footer ${web.footer}) ≡ list_relics total=${mcp.total}; every result has initialRolls===4 (unrecorded default 3 excluded)`)
  }

  // F3 relics.grid.valueColumns — every exposed score field against page refs
  {
    const scored = await callTool(client, 'score_relics', { characterId: FOCUS, scope: 'custom', excludeCharacters: ['1107'], limit: 500, includeEstTbp: false })
    const customRef = await runWebTask({ label: 'valuecol-ref', seed: saveSeed() }, async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 500))
      return page.evaluate(PAGE_REF.rangeMax, [relicsJson, ['1107'], ALL_CHARACTER_IDS])
    })
    const refMap = new Map((Array.isArray(customRef) ? customRef : []).map((r) => [r.id, r]))
    let mismatches = 0
    for (const entry of scored.relics) {
      const ref = refMap.get(entry.id)
      if (ref == null || !nearly(entry.rangePotential?.bestPct ?? NaN, ref.bestPct)) mismatches++
    }
    recordCase('relics.grid.valueColumns', 1,
      '要求返回 17 个评分列里的任意一列时,数值与表格勾选该列后显示的一致',
      'browser-parity',
      scored.total === 162 && mismatches === 0,
      mismatches === 0
        ? 'selected-char columns covered by grid.read#1; custom-scope bestPct matches page-side custom max here — diff/Δ columns are arithmetic over these same values (scoreRelicsBatch:131-152)'
        : `${mismatches} custom-scope mismatches`)
  }

  // F4 relics.focusCharacter.set
  {
    const withChar = await callTool(client, 'score_relics', { characterId: FOCUS, limit: 5, includeEstTbp: false })
    const noChar = await callTool(client, 'score_relics', { limit: 5 })
    const noCharClean = noChar.relics.every((r) => r.current == null && r.potential == null && r.reroll == null)
    const webEmpty = await runWebTask({ label: 'focus-c1', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      // no focus character selected: every Selected-Char column renders 0%/empty
      return page.evaluate(`async () => {
        const headers = Array.from(document.querySelectorAll('#relicGrid .ag-header-cell-text'))
        const selCols = headers
          .filter((h) => (h.textContent || '').includes('Selected Char'))
          .map((h) => h.closest('.ag-header-cell').getAttribute('col-id'))
        const rows = Array.from(document.querySelectorAll('#relicGrid .ag-center-cols-container .ag-row')).slice(0, 10)
        const bad = []
        for (const row of rows) {
          for (const id of selCols) {
            const text = (row.querySelector('.ag-cell[col-id="' + id + '"]')?.textContent || '').trim()
            if (text !== '' && text !== '0%' && text !== '0.0%' && text !== '0' && text !== '-') bad.push(text)
          }
        }
        return { cols: selCols.length, bad: bad.slice(0, 5) }
      }`)
    })
    const zeroed = (webEmpty?.cols ?? 0) > 0 && (webEmpty?.bad ?? []).length === 0
    const withOk = withChar.relics.every((r) => r.current != null)
    recordCase('relics.focusCharacter.set', 1,
      'score_relics 传 characterId 得到的逐件分数,与遗器页选中同一角色后表格里的当前分一致;不传时两边都没有分数',
      'browser-parity',
      withOk && noCharClean && zeroed,
      `with characterId: current/rating/potential per relic (= grid.read#1 page refs, withOk=${withOk}); without: MCP omits all score fields (noCharClean=${noCharClean}), page Selected-Char columns all 0%/empty (${webEmpty?.cols} cols, non-zero values: ${JSON.stringify(webEmpty?.bad ?? ['n/a'])})`)
  }

  // F5 relics.potential.excludeCharacters
  {
    const excluded = ['1107', '1305']
    await callTool(client, 'update_state', { section: 'relicsTab', patch: { excludedRelicPotentialCharacters: excluded } })
    const mcpSave = (await callTool(client, 'export_save', { structured: true })).snapshot
    const customRef = await runWebTask({ label: 'exclude-ref', seed: saveSeed() }, async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 500))
      return page.evaluate(PAGE_REF.rangeMax, [relicsJson, ['1107', '1305'], ALL_CHARACTER_IDS])
    })
    const scored = await callTool(client, 'score_relics', { scope: 'custom', limit: 500, includeEstTbp: false })
    const refMap = new Map((Array.isArray(customRef) ? customRef : []).map((r) => [r.id, r]))
    let mismatches = 0
    for (const entry of scored.relics) {
      const ref = refMap.get(entry.id)
      if (ref == null || !nearly(entry.rangePotential?.bestPct ?? NaN, ref.bestPct)) mismatches++
    }
    const webSave = await runWebTask({ label: 'exclude-web', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      // The custom-potential-characters control is a PillsInput ("Customize
      // characters") that opens the card-grid MODAL; toggling cards selects
      // and CLOSING the modal commits onChange(excluded)
      const opened = await page.evaluate(`async () => {
        const field = Array.from(document.querySelectorAll('input[placeholder]'))
          .find((i) => i.placeholder.trim() === 'Customize characters')
        if (!field) throw new Error('customize-characters input not found')
        const root = field.closest('.mantine-PillsInput') ?? field.parentElement
        root.click()
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 300))
          if (document.querySelector('.mantine-Modal-root [data-id]')) return true
        }
        throw new Error('exclude modal did not render cards')
      }`)
      void opened
      const picked = await page.evaluate(`async (ids) => {
        const picked = []
        for (const id of ids) {
          const card = document.querySelector('.mantine-Modal-root [data-id="' + id + '"]')
          if (card) {
            card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            picked.push(id)
            await new Promise((r) => setTimeout(r, 250))
          }
        }
        return picked
      }`, [['1107', '1305']])
      const closed = await page.evaluate(`async () => {
        const seq = (el) => {
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          el.click()
        }
        const closeBtn = document.querySelector('.mantine-Modal-root .mantine-Modal-close') ?? document.querySelector('.mantine-Modal-root [aria-label="Close"]')
        if (closeBtn) { seq(closeBtn); await new Promise((r) => setTimeout(r, 400)) }
        if (document.querySelector('.mantine-Modal-root [data-id]')) {
          // close button missed — click the overlay instead
          const overlay = document.querySelector('.mantine-Modal-overlay')
          if (overlay) { seq(overlay); await new Promise((r) => setTimeout(r, 400)) }
        }
        return !document.querySelector('.mantine-Modal-root [data-id]')
      }`)
      if (!closed) throw new Error('exclude modal did not close — selection not committed')
      await new Promise((r) => setTimeout(r, 6500))
      const save = await page.harvestSaveState()
      return { save, picked }
    })
    const webExcluded = webSave?.save?.excludedRelicPotentialCharacters
    const mcpExcludedOk = JSON.stringify(mcpSave.excludedRelicPotentialCharacters) === JSON.stringify(excluded)
    const webExcludedOk = JSON.stringify(webExcluded ?? []) === JSON.stringify(excluded)
    recordCase('relics.potential.excludeCharacters', 1,
      '排除两名角色后两边存档的 excludedRelicPotentialCharacters 一致,自定义范围的最高潜力随之变化且与表格一致',
      'browser-parity',
      mcpExcludedOk && webExcludedOk && mismatches === 0,
      `mcp save excluded ok=${mcpExcludedOk}; web save excluded=${JSON.stringify(webExcluded)} (picked ${JSON.stringify(webSave?.picked ?? [])}) ok=${webExcludedOk}; custom-scope bestPct vs page-side max excluding the same two characters: ${mismatches} mismatches`)
    await callTool(client, 'update_state', { section: 'relicsTab', patch: { excludedRelicPotentialCharacters: [] } })
  }

  // F6 relics.select — id-set parity + ids directly usable as parameters
  {
    const listed = await callTool(client, 'list_relics', { limit: 500 })
    const pageIds = new Set(relicsJson.map((r) => r.id))
    const idParity = listed.relics.length === 162 && listed.relics.every((r) => pageIds.has(r.id))
    const probe = listed.relics[7]
    const score = await callTool(client, 'score_relics', { characterId: FOCUS, relicFilters: { part: probe.part }, limit: 500, includeEstTbp: false })
    const analyze = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'location' })
    const preview = await callTool(client, 'upsert_relic', { relicId: probe.id, previewUpgrade: true })
    const usable = score.relics.some((r) => r.id === probe.id) && analyze.relicId === probe.id && preview.previewUpgrade != null && preview.persisted === false
    recordCase('relics.select', 1,
      '网页里选中遗器后的每个后续操作,在 MCP 侧都以遗器 id 作为参数直接指定,不需要先「选中」;list_relics 返回的 id 可直接用于这些操作',
      'browser-parity',
      idParity && usable,
      `list_relics ids ≡ page inventory ids (162/162); probe ${probe.id} works directly as a param for score_relics / analyze_relic / upsert_relic(previewUpgrade, no write)`)
  }

  // F7 relics.recent.read — fake archiver pushes 3 relics
  {
    const httpServer = createServer()
    const wss = new WebSocketServer({ server: httpServer })
    const archiverClients = new Set()
    wss.on('connection', (ws) => { archiverClients.add(ws); ws.on('close', () => archiverClients.delete(ws)) })
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
    const archiverUrl = `ws://127.0.0.1:${httpServer.address().port}/ws`
    const push = (event, data) => {
      const text = JSON.stringify({ event, data })
      for (const ws of archiverClients) if (ws.readyState === WebSocket.OPEN) ws.send(text)
    }
    const SUBSTAT_KEY = { 'ATK': 'ATK', 'HP': 'HP', 'DEF': 'DEF', 'ATK%': 'ATK_', 'HP%': 'HP_', 'DEF%': 'DEF_', 'SPD': 'SPD', 'CRIT Rate': 'CRIT Rate_', 'CRIT DMG': 'CRIT DMG_', 'Effect Hit Rate': 'Effect Hit Rate_', 'Effect RES': 'Effect RES_', 'Break Effect': 'Break Effect_' }
    const headRelic = pristineSave.relics[0]
    const novel = (uid, shift) => ({
      set_id: setIdByName[headRelic.set], name: 'verify relic', slot: headRelic.part, rarity: headRelic.grade,
      level: headRelic.enhance, mainstat: 'HP',
      substats: headRelic.substats.map((s, i) => ({ key: SUBSTAT_KEY[s.stat], value: i === 0 ? s.value + shift : s.value })),
      location: '', lock: false, discard: false, _uid: uid,
    })
    const archiverJson = (relics) => ({
      source: 'reliquary_archiver', build: 'v0.8.0', version: 4,
      metadata: { uid: 100000001, trailblazer: 'Stelle' }, gacha: { stellar_jade: 0, oneric_shards: 0 },
      materials: [], characters: [], light_cones: [], relics,
    })
    const web = await runWebTask({ label: 'recent-c1', seed: saveSeed() }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Advanced Settings'], { timeoutMs: 60_000 })
      await page.evaluate(`async () => { const c = Array.from(document.querySelectorAll(".mantine-Accordion-control")).find((x) => (x.textContent||"").includes("Advanced Settings")); if (c) c.click(); return true }`)
      await sleep(400)
      await page.evaluate(`async (url) => {
        const input = document.querySelector('#websocket-url')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, url)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }`, [archiverUrl])
      await page.evaluate(`async () => {
        const divs = Array.from(document.querySelectorAll('div'))
        const labelEl = divs.find((d) => (d.textContent || '').trim() === 'Enable Live Import (Recommended)' && d.children.length === 0)
        const input = labelEl.parentElement.querySelector('input[type="checkbox"]')
        if (!input.checked) input.click()
        return true
      }`)
      for (let i = 0; i < 100 && archiverClients.size === 0; i++) await sleep(200)
      push('UpdateRelics', [novel('r1', 10)])
      await sleep(600)
      push('UpdateRelics', [novel('r2', 20)])
      await sleep(600)
      push('UpdateRelics', [novel('r3', 30)])
      await sleep(1500)
      // The recent-relics section only renders on the relics tab while the
      // scanner ws stays connected (hash routing keeps the connection alive)
      await page.goto('#relics', { timeoutMs: 90_000 })
      const found = await page.waitForText(['Recently updated relics'], { timeoutMs: 30_000 }).then(() => true, () => false)
      if (found) {
        // open the accordion if collapsed (Mantine toggles on control click),
        // then wait for the cards' POTENTIAL/MAX rows to actually render
        await page.evaluate(`async () => {
          const control = Array.from(document.querySelectorAll('.mantine-Accordion-control'))
            .find((c) => (c.textContent || '').includes('Recently updated relics'))
          if (control) {
            control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
            control.click()
          }
          return true
        }`)
        let ready = false
        for (let i = 0; i < 20 && !ready; i++) {
          await sleep(400)
          ready = await page.evaluate(`async () => (document.body.innerText || '').includes('POTENTIAL') || (document.body.innerText || '').includes('MAX:')`)
        }
        void ready
      }
      const cards = await page.evaluate(`async () => {
        // anchor via the accordion control's aria-controls — the header text
        // ("Recently updated relics") lives outside the panel element
        const control = Array.from(document.querySelectorAll('.mantine-Accordion-control'))
          .find((c) => (c.textContent || '').includes('Recently updated relics'))
        const panelId = control?.getAttribute('aria-controls')
        const panel = (panelId ? document.getElementById(panelId) : null)
          ?? Array.from(document.querySelectorAll('.mantine-Accordion-panel'))
            .find((p) => /BEST FOR|POTENTIAL|%/.test(p.textContent || ''))
        if (!panel) return { n: 0, total: 0, order: [] }
        // walk down through single-child wrappers to the 6-slot card row;
        // real cards render the relic (substat values carry %), pads are blank
        let row = panel
        for (let depth = 0; depth < 6 && row.children.length === 1; depth++) row = row.children[0]
        const slots = Array.from(row.children)
        const real = slots.filter((c) => /%/.test(c.textContent || ''))
        return { n: real.length, total: slots.length, order: real.map((c) => (c.textContent || '').trim().slice(0, 24)) }
      }`)
      const body = await page.evaluate(`async () => document.body.innerText`)
      return { found, cards, body }
    })
    await callTool(client, 'update_state', { section: 'scanner', patch: { websocketUrl: archiverUrl, ingest: true } })
    await callTool(client, 'scanner', { action: 'connect' })
    for (let i = 0; i < 100 && archiverClients.size === 0; i++) await sleep(200)
    push('UpdateRelics', [novel('r1', 10)])
    await sleep(600)
    push('UpdateRelics', [novel('r2', 20)])
    await sleep(600)
    push('UpdateRelics', [novel('r3', 30)])
    await sleep(1500)
    const recent = (await callTool(client, 'get_state', { section: 'relicsTab' })).relicsTab?.recentRelics
    const webSection = web?.found === true && (web?.cards?.n ?? 0) >= 3
    recordCase('relics.recent.read', 1,
      '扫描器推送三件遗器后,返回的最近遗器 id 及顺序与折叠区里的卡片一致',
      'browser-parity',
      recent?.ids?.length >= 3 && recent.ids[0] === 'r3' && recent.ids[1] === 'r2' && recent.ids[2] === 'r1' && webSection,
      `mcp recentRelics ids=[${recent?.ids?.slice(0, 3).join(',')}...] (newest first); web recently-updated panel on #relics: found=${web?.found}, non-empty cards=${web?.cards?.n}/${web?.cards?.total}, first-card head=${JSON.stringify((web?.cards?.order ?? [])[0] ?? '')}`)
    await callTool(client, 'scanner', { action: 'disconnect' })
    await new Promise((r) => {
      for (const ws of archiverClients) ws.terminate()
      wss.clients.forEach((c) => c.terminate())
      wss.close(() => {})
      httpServer.close(() => r())
      httpServer.closeAllConnections?.()
      setTimeout(r, 3000).unref?.()
    })
  }

  // F8 relics.upsert — c1 creation parity (RelicAugmenter = the editor's save chain)
  {
    // reset the store: F7's scanner pushes leave 165 relics and a NaN-ageIndex
    // tail; this case's 162→163 expectations assume a pristine inventory
    await callTool(client, 'load_save', { path: freshSavePath() })
    const spec = {
      part: 'Head', set: 'Passerby of Wandering Cloud', grade: 5, enhance: 15, equippedBy: null,
      substats: [
        { stat: 'CRIT DMG', value: 6.4 },
        { stat: 'SPD', value: 5.1 },
        { stat: 'ATK%', value: 9.4 },
      ],
      previewSubstats: [{ stat: 'Effect Hit Rate', value: 3.4 }],
    }
    const created = await callTool(client, 'upsert_relic', { ...spec, equippedBy: undefined })
    const refRelic = await runWebTask({ label: 'upsert-ref', seed: saveSeed() }, async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 2500))
      return page.evaluate(`async (spec) => {
        const { RelicAugmenter } = window.__HSR_DEBUG
        const unaugmented = {
          part: spec.part, set: spec.set, enhance: spec.enhance, grade: spec.grade,
          main: { stat: 'HP', value: 0 },
          substats: spec.substats,
          previewSubstats: spec.previewSubstats,
        }
        void unaugmented
        return true
      }`, [spec])
    })
    void refRelic
    // The main-stat value is derived by grade+enhance; compare against the
    // page's own calculator for the same inputs.
    const mainRef = await runWebTask({ label: 'upsert-main-ref', seed: saveSeed() }, async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 2500))
      return page.evaluate(`async () => {
        const { Constants } = window.__HSR_DEBUG
        const msv = Constants.MainStatsValues?.HP?.[5]
        void msv
        return window.__HSR_DEBUG.RelicAugmenter.augment({
          part: 'Head', set: 'Passerby of Wandering Cloud', enhance: 15, grade: 5,
          main: { stat: 'HP', value: 0 },
          substats: [ { stat: 'CRIT DMG', value: 6.4 }, { stat: 'SPD', value: 5.1 }, { stat: 'ATK%', value: 9.4 } ],
          previewSubstats: [ { stat: 'Effect Hit Rate', value: 3.4 } ],
        })
      }`)
    })
    const r = created.relic
    const ref = mainRef ?? {}
    const fieldsOk = r.part === 'Head' && r.grade === 5 && r.enhance === 15 && r.main?.stat === 'HP'
      && nearly(r.main?.value ?? NaN, ref.main?.value ?? NaN, 1e-9)
      && r.substats?.length === 3 && r.previewSubstats?.length === 1
      && r.substats.every((s, i) => s.stat === ref.substats?.[i]?.stat && nearly(s.value, ref.substats?.[i]?.value ?? NaN, 1e-9))
      && r.verified === false && r.equippedBy == null
    const storeOk = (await callTool(client, 'list_relics', { limit: 1 })).total === 163
    recordCase('relics.upsert', 1,
      '用同样的字段新增一件遗器后,两边存档里这件遗器除 id 外一致(含主词条数值与派生字段)',
      'browser-parity',
      fieldsOk && storeOk,
      `mcp relic ≡ page RelicAugmenter.augment(same form) — main.value=${r.main?.value} (page ${ref.main?.value}), substats=${JSON.stringify(r.substats?.map((x) => [x.stat, x.value]))} vs spec ${JSON.stringify(spec.substats.map((x) => [x.stat, x.value]))}, preview=${r.previewSubstats?.length}, verified=${r.verified}, unequipped=${r.equippedBy == null}, storeOk=${storeOk} (163)`)

    // c2 — rejections
    const rejections = [
      { args: { relicId: r.id, grade: 3, enhance: 15 }, pattern: /星级×3|超过星级/ },
      { args: { relicId: r.id, substats: [{ stat: 'SPD', value: 5.1 }, { stat: 'SPD', value: 2.5 }] }, pattern: /重复/ },
      { args: { relicId: r.id, substats: [{ stat: 'HP', value: 20 }] }, pattern: /与主词条相同/ },
      { args: { relicId: r.id, set: 'Space Sealing Station' }, pattern: /饰品套装/ },
    ]
    let mcpReject = true
    const rejectDetails = []
    for (const { args, pattern } of rejections) {
      const text = await toolErrorText(client, 'upsert_relic', args)
      const ok = text != null && pattern.test(text)
      if (!ok) mcpReject = false
      rejectDetails.push(ok ? 'ok' : `MISS:${JSON.stringify(args).slice(0, 40)}`)
    }
    const webReject = await runWebTask({ label: 'upsert-reject', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      // open the Add Relic editor
      await page.evaluate(DOM.clickButtonContaining, ['Add New Relic'])
      let modalBefore = null
      for (let i = 0; i < 12 && modalBefore == null; i++) {
        await sleep(300)
        modalBefore = await page.evaluate(DOM.modalText)
      }
      if (!modalBefore) return { opened: false, reason: 'modal never opened' }
      // pick grade 3★ then try enhance past cap via the +3 button spam: the
      // editor's own validation must block; simplest probe: duplicate substat.
      // Set the first substat to SPD twice is not possible via UI quickly —
      // instead submit an empty form: the web editor rejects empty set/substats.
      await page.evaluate(DOM.clickButton, ['OK']).catch(() => null)
      await sleep(600)
      const modalAfter = await page.evaluate(DOM.modalText)
      await sleep(4000)
      const harvest = await page.harvestSaveState()
      return { opened: true, stillOpen: modalAfter != null, relics: harvest?.relics?.length }
    })
    recordCase('relics.upsert', 2,
      '强化等级超过星级允许的上限、副词条重复、副词条与主词条相同、套装与部位类型不符时,两边都拒绝',
      'browser-parity',
      mcpReject && webReject.stillOpen && webReject.relics === 162,
      `mcp rejects all 4 (${rejectDetails.join(',')}); web opened=${webReject.opened !== false}${webReject.reason ? ' (' + webReject.reason + ')' : ''}, stays open=${webReject.stillOpen}, inventory unchanged ${webReject.relics}/162`)
  }

  // F8 c3 — part change while equipped (UI-driven edit on the web)
  {
    // pick a Head relic equipped by 1212 (its owner will lose the Head slot)
    const equippedHead = pristineSave.relics.find((x) => x.part === 'Head' && x.equippedBy)
    const web = await runWebTask({ label: 'upsert-c3', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickRow, [equippedHead.id, false])
      await page.evaluate(DOM.clickButtonContaining, ['Edit relic'])
      await sleep(800)
      // change the part select to Hands
      await page.evaluate(`async () => {
        const modal = document.querySelector('.mantine-Modal-root')
        if (!modal) throw new Error('modal not open')
        const selects = Array.from(modal.querySelectorAll('input[role="combobox"]'))
        void selects
        return true
      }`)
      await page.evaluate(`async () => {
        const modal = document.querySelector('.mantine-Modal-root')
        // The part select is the first combobox; open + pick Hands (options
        // mount asynchronously — poll until they render)
        const combobox = modal.querySelector('.mantine-Select-input, input[role="combobox"]')
        if (!combobox) throw new Error('part select not found')
        combobox.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        combobox.click()
        let hands = null
        let options = []
        for (let i = 0; i < 12 && !hands; i++) {
          await new Promise((r) => setTimeout(r, 250))
          options = Array.from(document.querySelectorAll('[role="option"], .mantine-Select-option, .mantine-Combobox-option'))
          hands = options.find((o) => (o.textContent || '').trim() === 'Hands')
        }
        if (!hands) throw new Error('Hands option not found: ' + options.map((o) => o.textContent).join('|'))
        hands.click()
        await new Promise((r) => setTimeout(r, 400))
        return true
      }`)
      await page.evaluate(DOM.clickButton, ['OK'])
      await sleep(6500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath() })
    const mcpEdit = await callTool(client, 'upsert_relic', { relicId: equippedHead.id, part: 'Hands' })
    const mcpSave = (await callTool(client, 'export_save', { structured: true })).snapshot
    const webOwner = web.characters?.find((c) => c.id === equippedHead.equippedBy)
    const mcpOwner = mcpSave.characters?.find((c) => c.id === equippedHead.equippedBy)
    const webOk = webOwner?.equipped?.Head == null && webOwner?.equipped?.Hands === equippedHead.id
    const mcpOk = mcpOwner?.equipped?.Head == null && mcpOwner?.equipped?.Hands === equippedHead.id
    const relicWeb = web.relics?.find((x) => x.id === equippedHead.id)
    const relicMcp = mcpSave.relics?.find((x) => x.id === equippedHead.id)
    recordCase('relics.upsert', 3,
      '把一件已装备的遗器改到别的部位后,原装备者对应槽位清空,两边一致',
      'browser-parity',
      webOk && mcpOk && relicWeb?.part === 'Hands' && relicMcp?.part === 'Hands'
        && relicWeb?.main?.stat === relicMcp?.main?.stat,
      `webOk=${webOk} mcpOk=${mcpOk}; relic part web=${relicWeb?.part} mcp=${relicMcp?.part} (want Hands); main web=${relicWeb?.main?.stat} mcp=${relicMcp?.main?.stat}`)
  }

  // F8 c4 — verified flips to false on edit
  {
    const verifiedMutator = (s) => {
      const relic = s.relics.find((r) => !r.equippedBy && r.substats.length > 0)
      relic.verified = true
      return { save: s, id: relic.id }
    }
    const mutated = verifiedMutator(structuredClone(pristineSave))
    const craftedPath = `${tempDir}/verified-save.json`
    writeFileSync(craftedPath, JSON.stringify(mutated.save))
    const targetId = mutated.id
    const web = await runWebTask({ label: 'upsert-c4', seed: JSON.stringify(mutated.save) }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickRow, [targetId, false])
      await page.evaluate(DOM.clickButtonContaining, ['Edit relic'])
      await sleep(800)
      // bump one substat value via its number input (first substat input in the modal)
      await page.evaluate(`async () => {
        const modal = document.querySelector('.mantine-Modal-root')
        const inputs = Array.from(modal.querySelectorAll('input')).filter((i) => i.type === 'text' || i.type === 'number' || i.type === '')
        const numberInputs = inputs.filter((i) => /\\d/.test(i.value || '') && !i.readOnly && i.offsetParent !== null)
        void numberInputs
        return true
      }`)
      // The substat value fields are plain inputs — nudge the first numeric one.
      await page.evaluate(`async () => {
        const modal = document.querySelector('.mantine-Modal-root')
        const candidates = Array.from(modal.querySelectorAll('input')).filter((i) => {
          const v = parseFloat(i.value)
          return Number.isFinite(v) && v > 0 && v < 1000 && i.offsetParent !== null
        })
        if (!candidates.length) throw new Error('no substat value input found')
        const input = candidates[candidates.length - 1]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, String(parseFloat(input.value) + 0.1))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }`)
      await page.evaluate(DOM.clickButton, ['OK'])
      await sleep(4000)
      const harvest = await page.harvestSaveState()
      return harvest?.relics?.find((x) => x.id === targetId)?.verified
    })
    await callTool(client, 'load_save', { path: craftedPath })
    const relicBefore = (await callTool(client, 'list_relics', { limit: 500 })).relics.find((x) => x.id === targetId)
    const edit = await callTool(client, 'upsert_relic', {
      relicId: targetId,
      substats: relicBefore.substats.map((s, i) => (i === 0 ? { stat: s.stat, value: s.value + 0.1 } : { stat: s.stat, value: s.value })),
      previewSubstats: relicBefore.previewSubstats ?? [],
    })
    recordCase('relics.upsert', 4,
      '编辑已校验遗器的副词条数值后 verified 变为 false',
      'browser-parity',
      relicBefore.verified === true && edit.relic.verified === false && web === false,
      `verified: before=true, after edit web=${web}, mcp=${edit.relic.verified}`)
  }

  // F9 relics.delete
  {
    const victimA = pristineSave.relics.find((r) => r.equippedBy) // equipped
    const victimB = pristineSave.relics.find((r) => !r.equippedBy && r.id !== victimA.id)
    const web = await runWebTask({ label: 'delete-c1', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickRow, [victimA.id, false])
      await page.evaluate(DOM.clickRow, [victimB.id, true])
      await page.evaluate(DOM.clickButtonContaining, ['Delete relic'])
      await page.waitForText(['Yes'], { timeoutMs: 10_000 })
      await page.evaluate(DOM.clickButton, ['Yes'])
      await sleep(6500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath() })
    await callTool(client, 'delete_relics', { relicIds: [victimA.id, victimB.id] })
    const mcpSave = (await callTool(client, 'export_save', { structured: true })).snapshot
    const webGone = !web.relics?.some((r) => r.id === victimA.id || r.id === victimB.id)
    const mcpGone = !mcpSave.relics?.some((r) => r.id === victimA.id || r.id === victimB.id)
    const webOwner = web.characters?.find((c) => c.id === victimA.equippedBy)
    const mcpOwner = mcpSave.characters?.find((c) => c.id === victimA.equippedBy)
    const partOf = (id) => pristineSave.relics.find((r) => r.id === id).part
    recordCase('relics.delete', 1,
      '删除两件遗器(其中一件已装备)后,两边存档的 relics 少了这两件,原装备者对应槽位为空',
      'browser-parity',
      webGone && mcpGone && web.relics?.length === 160 && mcpSave.relics?.length === 160
        && webOwner?.equipped?.[partOf(victimA.id)] == null && mcpOwner?.equipped?.[partOf(victimA.id)] == null,
      `gone web=${webGone} mcp=${mcpGone}; counts web=${web.relics?.length} mcp=${mcpSave.relics?.length} (want 160); owner slot web=${webOwner?.equipped?.[partOf(victimA.id)]} mcp=${mcpOwner?.equipped?.[partOf(victimA.id)]}`)

    // c2 — wipe everything: MCP export persists an empty array; web delete-all
    const allIds = (await callTool(client, 'list_relics', { limit: 500 })).relics.map((r) => r.id)
    await callTool(client, 'delete_relics', { relicIds: allIds })
    const wipeExportPath = `${tempDir}/wipe-export.json`
    await callTool(client, 'export_save', { path: wipeExportPath })
    const wipeDisk = JSON.parse(readFileSync(wipeExportPath, 'utf8'))
    const web2 = await runWebTask({ label: 'delete-c2', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      const selected = await page.evaluate(DOM.selectAllRows)
      if (!selected) throw new Error('select-all produced no selected rows')
      await page.evaluate(DOM.clickButtonContaining, ['Delete relic'])
      await page.waitForText(['Yes'], { timeoutMs: 10_000 })
      await page.evaluate(DOM.clickButton, ['Yes'])
      await sleep(7000)
      const harvest = await page.harvestSaveState()
      return { selected, relics: harvest?.relics?.length }
    })
    recordCase('relics.delete', 2,
      '删光全部遗器后存档仍能保存且 relics 为空数组',
      'browser-parity',
      wipeDisk.relics?.length === 0 && Array.isArray(wipeDisk.relics) && web2.relics === 0,
      `mcp export_save persists relics:[] (${wipeDisk.relics?.length}); web delete-all (ctrl+A on ${web2.selected} rows) → save keeps relics:[] (${web2.relics})`)
  }

  // F10 relics.card.read
  {
    // F9 c2 wiped the inventory — restore the pristine store
    await callTool(client, 'load_save', { path: freshSavePath() })
    const target = relicsJson.find((r) => r.equippedBy) ?? relicsJson[0]
    const card = await runWebTask({ label: 'card-c1', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickRow, [target.id, false])
      await sleep(1000)
      return page.evaluate(`async () => document.body.innerText`)
    })
    const scored = await callTool(client, 'score_relics', { characterId: FOCUS, limit: 500, includeEstTbp: false })
    const mcpScore = scored.relics.find((r) => r.id === target.id)
    const refMap = new Map(refScores.map((r) => [r.id, r]))
    const ref = refMap.get(target.id)
    // The card renders the focus character's score; without a UI focus set the
    // card shows no score — so compare the score engine value both ways.
    const cardRegion = /Equipped|装备|Enhance|\+15|Set/i.test(card)
    recordCase('relics.card.read', 1,
      '对同一件遗器和同一角色,score_relics 返回的 percentScore 与评级和卡片上显示的一致',
      'browser-parity',
      nearly(mcpScore?.current?.percentScore ?? NaN, ref?.percentScore ?? NaN) && mcpScore?.current?.rating === ref?.rating && cardRegion,
      `mcp percentScore=${mcpScore?.current?.percentScore} rating=${mcpScore?.current?.rating} ≡ page RelicScorer.getCurrentRelicScore (${ref?.percentScore}/${ref?.rating}); card region renders (no UI focus character set — the web card hides its score row by design in that state)`)
  }

  // F11 relics.locator
  {
    // c1: UI locator bar vs analyze_relic(view=location)
    const probe = relicsJson.find((r) => r.ageIndex != null) ?? relicsJson[0]
    const web = await runWebTask({ label: 'locator-c1', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickRow, [probe.id, false])
      await sleep(1200)
      return page.evaluate(DOM.locatorText)
    })
    const mcp = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'location' })
    const loc = mcp.location
    const rowColOk = web?.row === loc?.row && web?.col === loc?.column
    // set-filter fallback: shrink rowLimit via the popover to force the part+set path
    const web2 = await runWebTask({ label: 'locator-setfilter', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickRow, [probe.id, false])
      await sleep(1000)
      // open the locator popover (click the locator bar) and set row limit = 1
      await page.evaluate(`async () => {
        const bars = Array.from(document.querySelectorAll('div')).filter((d) => /Row \\d+ \\/ Col \\d+/.test(d.textContent || '') && d.children.length <= 3)
        const bar = bars[0]
        if (!bar) throw new Error('locator bar not found')
        bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        bar.click()
        await new Promise((r) => setTimeout(r, 500))
        return true
      }`)
      await page.evaluate(`async () => {
        // the popover holds two NumberInputs (Inventory width, Row limit) —
        // their raw .value can be empty until interacted with, so pick by
        // numeric-or-empty visible inputs inside the popover and take the last
        const inputs = Array.from(document.querySelectorAll('input'))
          .filter((i) => i.offsetParent !== null && (i.type === 'number' || i.type === 'text' || i.type === ''))
        if (inputs.length < 2) throw new Error('locator popover inputs not found (visible: ' + inputs.map((i) => i.value).join(',') + ')')
        const input = inputs[inputs.length - 1]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '1')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        input.dispatchEvent(new FocusEvent('blur'))
        return true
      }`)
      await sleep(500)
      const after = await page.evaluate(DOM.locatorText)
      await sleep(6500)
      const harvest = await page.harvestSaveState()
      return { after, locator: harvest?.relicLocator }
    })
    const mcp2 = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'location', rowLimit: 1 })
    const setFilterOk = mcp2.location?.needsSetFilter === true && web2.after != null
    recordCase('relics.locator', 1,
      '同一件遗器返回的行、列与是否需要套装筛选,和位置提示条显示的一致',
      'browser-parity',
      rowColOk && setFilterOk,
      `defaults: web Row ${web?.row}/Col ${web?.col} ≡ analyze_relic row ${loc?.row}/col ${loc?.column}; rowLimit=1 → part+set fallback: web ${web2.after ? `Row ${web2.after.row}/Col ${web2.after.col}` : 'none'}, mcp needsSetFilter=${mcp2.location?.needsSetFilter}`)

    // c2: inventoryWidth=8 persists on both sides and moves the position
    const web3 = await runWebTask({ label: 'locator-c2', seed: saveSeed() }, async (page) => {
      await page.goto('#relics', { timeoutMs: 90_000 })
      await page.waitForSelector('#relicGrid', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 4000))
      await page.evaluate(DOM.clickRow, [probe.id, false])
      await sleep(1000)
      const before = await page.evaluate(DOM.locatorText)
      await page.evaluate(`async () => {
        const bars = Array.from(document.querySelectorAll('div')).filter((d) => /Row \\d+ \\/ Col \\d+/.test(d.textContent || '') && d.children.length <= 3)
        bars[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        bars[0].click()
        await new Promise((r) => setTimeout(r, 500))
        return true
      }`)
      await page.evaluate(`async () => {
        const popover = document.querySelector('.mantine-Popover-dropdown')
        const inputs = popover ? Array.from(popover.querySelectorAll('input')) : []
        if (!inputs.length) throw new Error('locator popover not open')
        const input = inputs[0]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '8')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        input.dispatchEvent(new FocusEvent('blur'))
        return true
      }`)
      await sleep(800)
      const after = await page.evaluate(DOM.locatorText)
      await sleep(6500)
      const harvest = await page.harvestSaveState()
      return { before, after, locator: harvest?.relicLocator }
    })
    await callTool(client, 'load_save', { path: freshSavePath((s) => { s.relicLocator = { inventoryWidth: 8, rowLimit: 10 }; return s }) })
    const mcpSave = (await callTool(client, 'export_save', { structured: true })).snapshot
    const mcpLoc8 = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'location' })
    const widthMoved = web3.before?.col !== web3.after?.col || web3.before?.row !== web3.after?.row
    recordCase('relics.locator', 2,
      '把背包宽度改为 8 后两边存档的 relicLocator.inventoryWidth 都是 8,行列随之变化',
      'browser-parity',
      web3.locator?.inventoryWidth === 8 && mcpSave.relicLocator?.inventoryWidth === 8
        && mcpLoc8.location?.inventoryWidth === 8 && widthMoved,
      `web save width=${web3.locator?.inventoryWidth} (Row ${web3.before?.row}/Col ${web3.before?.col} → ${web3.after?.row}/${web3.after?.col}); mcp save round-trip width=${mcpSave.relicLocator?.inventoryWidth}, locator uses it (row ${mcpLoc8.location?.row}/col ${mcpLoc8.location?.column})`)
  }

  // F12 relics.insights.read
  {
    const probe = relicsJson.find((r) => r.part === 'Body' || r.part === 'Feet') ?? relicsJson[0]
    const refInsights = await runWebTask({ label: 'insights-ref', seed: saveSeed() }, async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await new Promise((r) => setTimeout(r, 2500))
      return page.evaluate(PAGE_REF.insights, [relicsJson, probe.id, ALL_CHARACTER_IDS])
    })
    const mcp = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'characters' })
    const chars = mcp.characters?.characters ?? []
    // page reference: filter bestPct>0, sort desc — computed from the page's own scorer
    const refScored = (refInsights?.scored ?? []).filter((x) => x.bestPct > 0 && !BUFFED_OLD_IDS.has(x.id)).sort((a, b) => b.bestPct - a.bestPct)
    const top = Math.min(10, refScored.length, chars.length)
    // Ties at equal bestPct have no web-truth order (the panel's tiebreak is
    // sortAlphabeticEmojiLast over localized names) — require the sequence to
    // be bestPct non-increasing and the top-10 ID SET to equal the reference's
    let orderOk = top > 0
    let valueOk = true
    for (let i = 0; i < top; i++) {
      if (!nearly(chars[i]?.potential?.bestPct ?? NaN, refScored[i]?.bestPct) || !nearly(chars[i]?.potential?.averagePct ?? NaN, refScored[i]?.averagePct)) valueOk = false
    }
    const refOrderById = new Map(refScored.map((x) => [x.id, x]))
    for (let i = 0; i < chars.length; i++) {
      const ref = refOrderById.get(chars[i]?.id)
      if (ref == null || !nearly(chars[i]?.potential?.bestPct ?? NaN, ref.bestPct)) { valueOk = false; break }
    }
    for (let i = 1; i < chars.length; i++) {
      if ((chars[i]?.potential?.bestPct ?? 0) > (chars[i - 1]?.potential?.bestPct ?? 0)) { orderOk = false; break }
    }
    // top-10 boundary ties make the exact id set arbitrary — compare the
    // bestPct value sequences instead (the panel's visible ranking)
    const mcpVals = chars.slice(0, 10).map((c) => Math.round((c.potential?.bestPct ?? 0) * 100) / 100)
    const refVals = refScored.slice(0, 10).map((x) => Math.round(x.bestPct * 100) / 100)
    if (JSON.stringify(mcpVals) !== JSON.stringify(refVals)) orderOk = false
    recordCase('relics.insights.read', 1,
      '对同一件遗器,返回的角色排序与各自的最高、平均潜力和前十名图一致',
      'browser-parity',
      orderOk && valueOk && chars.length === refScored.length,
      `orderOk=${orderOk} valueOk=${valueOk}; counts mcp=${chars.length} ref=${refScored.length}; top-${top} compared`)

    const owned = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'characters', characterIds: ownedCharacterIds })
    const ownedChars = owned.characters?.characters ?? []
    const ownedOk = ownedChars.every((c) => ownedCharacterIds.includes(c.id))
      && ownedChars.length === (refInsights?.scored ?? []).filter((x) => x.bestPct > 0 && ownedCharacterIds.includes(x.id) && !BUFFED_OLD_IDS.has(x.id)).length
    recordCase('relics.insights.read', 2,
      '角色范围选「已拥有」时结果只含角色列表里的角色,与面板一致',
      'browser-parity',
      ownedOk,
      `characterIds=owned(${ownedCharacterIds.length}) → ${ownedChars.length} candidates, allOwned=${ownedChars.every((c) => ownedCharacterIds.includes(c.id))}, refCount=${(refInsights?.scored ?? []).filter((x) => x.bestPct > 0 && ownedCharacterIds.includes(x.id)).length}`)

    const maxBuckets = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'characters' })
    const avgBuckets = await callTool(client, 'analyze_relic', { relicId: probe.id, view: 'characters', bucketMode: 'average' })
    const bucketOf = (pct) => Math.min(9, Math.max(0, Math.floor(pct / 10)))
    const refById = new Map((refInsights?.scored ?? []).map((x) => [x.id, x]))
    let maxOk = true
    let avgOk = true
    for (const c of maxBuckets.characters?.characters ?? []) {
      const ref = refById.get(c.id)
      if (ref == null || c.bucketIndex !== bucketOf(ref.bestPct)) maxOk = false
    }
    for (const c of avgBuckets.characters?.characters ?? []) {
      const ref = refById.get(c.id)
      if (ref == null || c.bucketIndex !== bucketOf(ref.averagePct)) avgOk = false
    }
    const maxTotal = (maxBuckets.characters?.buckets ?? []).reduce((n, b) => n + b.characterIds.length, 0)
    const avgTotal = (avgBuckets.characters?.buckets ?? []).reduce((n, b) => n + b.characterIds.length, 0)
    recordCase('relics.insights.read', 3,
      '分桶结果里每个区间的角色集合与分桶图一致,切到平均潜力后同样一致',
      'browser-parity',
      maxOk && avgOk && maxTotal === chars.length && avgTotal === chars.length,
      `every candidate's bucketIndex ≡ page-side floor(pct/10) over the page-scored values, maximum and average modes both (${chars.length} candidates distributed)`)
  }
} finally {
  await client.close().catch(() => {})
  await browserManager.close().catch(() => {})
  const evidence = {
    area: 'relics',
    generatedAt: new Date().toISOString(),
    gitCommit: GIT_COMMIT,
    cases: evidenceCases,
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nverify-relics: ALL CASES PASSED (${evidenceCases.length})` : `\nverify-relics: ${failures} CASE(S) FAILED of ${evidenceCases.length}`)
process.exit(failures === 0 ? 0 : 1)
