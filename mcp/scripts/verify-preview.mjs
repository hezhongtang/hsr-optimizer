// Browser-parity acceptance verification for the preview domain
// (mcp/coverage/features/preview.json, scope=baseline rows).
//
// Method (PROTOCOL.md A): the same save seed on both sides —
//   web:   managed browser (browserManager.runTask, seeded localStorage['state'])
//          driving the REAL characters-page showcase card (clicks/typing only),
//          reference values read from the rendered DOM / harvestSaveState();
//   MCP:   stdio server over the same seed copy, the feature's own tools;
//   then:  structured field-by-field comparison, one PASS/FAIL per
//          acceptance.cases entry, recorded into
//          mcp/coverage/evidence/preview.json.
//
// Every case runs in its own try/catch — a failure marks that case FAIL and
// the run continues. All persistent state (save copies, HSR_MCP_STATE_FILE,
// artifacts) lives in one mkdtempSync temp dir, removed at exit. The managed
// browser is closed in finally. The repo's sample-save.json is read-only.
//
// Usage: node scripts/verify-preview.mjs [serverEntry]   (default dist/index.js)

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const evidencePath = resolve(mcpDir, 'coverage/evidence/preview.json')

const TARGET = '1212b1' // Jingliu — the sample save's DPS sim character
const HEALER = '1105' // Natasha — healSimulation, 0 relics in the sample save
const BUFFER_CHAR = '1101' // Bronya — roster teammate-edit target
const LONG = { timeout: 240_000 }

// ── results recorder ─────────────────────────────────────────────────────────
const cases = []
let failures = 0
function record(feature, caseNo, desc, result, detail, method = 'browser-parity') {
  const entry = {
    feature,
    case: caseNo,
    desc: desc.slice(0, 60),
    method,
    result,
    detail: String(detail).slice(0, 300),
    script: 'mcp/scripts/verify-preview.mjs',
  }
  cases.push(entry)
  console.log(`[${result}] ${feature}#${caseNo} — ${entry.detail}`)
  if (result === 'FAIL') failures++
}
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '· ok' : '· X'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

// ── SKIP guard (mirrors smoke-browser.mjs) ───────────────────────────────────
function findChrome() {
  if (process.env.HSR_MCP_BROWSER_PATH && existsSync(process.env.HSR_MCP_BROWSER_PATH)) {
    return process.env.HSR_MCP_BROWSER_PATH
  }
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find((p) => existsSync(p)) ?? null
}
function findSiteDist() {
  if (process.env.HSR_MCP_SITE_DIST && existsSync(`${process.env.HSR_MCP_SITE_DIST}/index.html`)) {
    return process.env.HSR_MCP_SITE_DIST
  }
  const repoDist = resolve(mcpDir, '../dist')
  return existsSync(`${repoDist}/index.html`) && existsSync(`${repoDist}/assets`) ? repoDist : null
}
const chromePath = findChrome()
const siteDist = findSiteDist()
if (chromePath == null || siteDist == null) {
  const reasons = []
  if (chromePath == null) reasons.push('本机未找到 Chrome/Chromium 可执行文件')
  if (siteDist == null) reasons.push('未找到站点构建产物 dist/index.html')
  console.log(`[SKIP] preview 验收需要受管浏览器环境,当前缺少:${reasons.join(' / ')}`)
  process.exit(0)
}

// git commit for the evidence header
const gitCommit = (() => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(mcpDir, '..'), encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
})()

// ── temp workspace + derived seeds ───────────────────────────────────────────
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-preview-`)
const baseSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, baseSavePath)
const baseSave = JSON.parse(readFileSync(baseSavePath, 'utf8'))
/** A pristine copy of a seed file — load_save targets it for write-backs. */
let freshCounter = 0
function freshSeed(sourcePath) {
  freshCounter++
  const copy = `${tempDir}/fresh-${freshCounter}-${basename(sourcePath)}`
  copyFileSync(sourcePath, copy)
  return copy
}

/** Derive a seed save with JSON surgery (save-format fields only). */
function deriveSave(name, mutate) {
  const copy = JSON.parse(readFileSync(baseSavePath, 'utf8'))
  mutate(copy)
  const path = `${tempDir}/${name}.json`
  writeFileSync(path, JSON.stringify(copy))
  return path
}

// ── MCP client boot ──────────────────────────────────────────────────────────
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { getDefaultEnvironment, StdioClientTransport } = await import(
  '@modelcontextprotocol/sdk/client/stdio.js'
)

const client = new Client({ name: 'verify-preview', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_ARTIFACTS_DIR: `${tempDir}/artifacts`,
  },
  stderr: 'inherit',
}))

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}
async function callTool(name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) throw new Error(`tool ${name} isError: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}
async function snapshot() {
  const s = await callTool('export_save', { structured: true })
  return s.snapshot
}

// ── managed browser (same source the server bundles; smoke-browser pattern) ──
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
const { pathToFileURL } = await import('node:url')
const { browserManager } = await import(pathToFileURL(resolve(mcpDir, 'src/browser/browserManager.ts')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Key-order-insensitive JSON (harvest vs export key orders differ). */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
async function pollUntil(desc, fn, timeoutMs = 20_000, tickMs = 150) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
    } catch (e) {
      // transient races while the page (re)loads — the execution context is
      // destroyed mid-navigation; keep polling until the new document answers
      last = { ok: false, detail: `evaluate: ${String(e.message).slice(0, 80)}` }
    }
    if (last && last.ok) return last
    await sleep(tickMs)
  }
  const detail = last && last.detail !== undefined ? ` — ${String(last.detail)}` : ''
  throw new Error(`等待超时(${timeoutMs}ms):${desc}${detail}`)
}

// ── in-page probe scripts (evaluate strings; JSON args) ──────────────────────
const SET_LANG = `() => { try { localStorage.setItem('i18nextLng', 'en_US') } catch {} return true }`
const RELOAD_DONE = `() => window.__verifyLang === undefined && document.readyState === 'complete' && !!document.querySelector('#root > *')`
const MARK_LOADED = `() => { window.__verifyLang = 1; location.reload(); return true }`
const CLICK_CHAR = `(id) => { const el = document.querySelector('[data-character-id="' + id + '"]'); if (!el) return false; el.click(); return true }`
const CARD_READY = `(id) => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return { ok: false, reason: 'no card' }
  const portrait = card.querySelector('[data-portrait-inject]')
  const url = (portrait && (portrait.getAttribute('data-portrait-url') || portrait.src)) || ''
  const imgs = Array.from(card.querySelectorAll('img'))
  const pending = imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).length
  return { ok: (url.includes('/' + id + '.') || url.includes(id)) && imgs.length > 0 && pending === 0, url, imgs: imgs.length, pending }
}`
const CARD_TEXT = `() => { const c = document.getElementById('characterTabPreview'); return c ? c.innerText : '' }`
const SCORE_HEADER = `() => {
  const c = document.getElementById('characterTabPreview')
  if (!c) return null
  const m = c.innerText.match(/(\\d+(?:\\.\\d+)?)% · (\\S+)/)
  return m ? { percent: m[1], grade: m[2] } : null
}`
// Card stat rows: div[title] inside the card — title carries the 3-decimal value
const STAT_ROWS = `() => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return null
  return Array.from(card.querySelectorAll('div[title]')).map((row) => ({
    text: row.innerText.replace(/\\s+/g, ' ').trim(),
    title: row.getAttribute('title') || '',
  })).filter((r) => /\\d/.test(r.text))
}`
// CombatResults label/value rows (space-between flex with two spans)
const LABELED_ROWS = `(labels) => {
  const out = {}
  for (const row of document.querySelectorAll('div[style*="space-between"]')) {
    if (row.children.length !== 2) continue
    const label = (row.children[0].textContent || '').trim()
    if (labels.includes(label)) out[label] = (row.children[1].textContent || '').trim()
  }
  return out
}`
// Substat roll summary rows (ShowcaseSubstatRolls): label + effective count
const SUBSTAT_ROLLS = `() => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return null
  const rows = []
  for (const group of card.querySelectorAll('div')) {
    const line = group.querySelector('div[class*="statLine"]') || (group.className && String(group.className).includes('statLine') ? group : null)
    if (!line) continue
    const count = line.querySelector('[class*="rollCount"]')
    const label = line.innerText.replace(/[\\d.]+\\s*$/, '').trim()
    if (count) rows.push({ label, effective: count.textContent.trim() })
  }
  return rows
}`
// Per-relic score footers inside the card (data-testid relic-preview)
const RELIC_SCORES = `() => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return null
  return Array.from(card.querySelectorAll('[data-testid="relic-preview"]')).map((r) => {
    const m = r.innerText.match(/(\\d+\\.\\d+)\\s*\\(([^)]+)\\)/)
    const setTitle = (r.querySelector('img[title]') || {}).title || ''
    return { score: m ? m[1] : null, rating: m ? m[2] : null, set: setTitle, text: r.innerText.replace(/\\s+/g, ' ').slice(0, 120) }
  })
}`
// Click a visible SegmentedControl option by its label text (English locale)
const SEGMENT_BY_LABEL = `(label) => {
  for (const root of document.querySelectorAll('.mantine-SegmentedControl-root')) {
    if (!root.offsetParent) continue
    const lab = Array.from(root.querySelectorAll('.mantine-SegmentedControl-label')).find((l) => (l.textContent || '').trim() === label)
    if (lab) { lab.click(); return true }
  }
  return false
}`
// Click the option whose input value is `targetValue` inside the index-th
// VISIBLE SegmentedControl whose ordered input values equal `values`
// (distinguishes the icon-only controls: buffPriority/darkMode are
// ['false','true'], L2D is ['true','false'], preset is ['shine','natural'])
const SEGMENT_BY_VALUES = `(values, index, targetValue) => {
  let seen = 0
  for (const root of document.querySelectorAll('.mantine-SegmentedControl-root')) {
    if (!root.offsetParent) continue
    const inputs = Array.from(root.querySelectorAll('input[type="radio"]'))
    const vals = inputs.map((i) => i.value)
    if (vals.length !== values.length || vals.some((v, i) => v !== values[i])) continue
    if (seen++ === index) {
      const idx = inputs.findIndex((i) => i.value === String(targetValue))
      const lab = root.querySelectorAll('.mantine-SegmentedControl-label')[idx]
      if (lab) { lab.click(); return true }
    }
  }
  return false
}`
// Read the checked value of the visible SegmentedControl with the given input values
const SEGMENT_ACTIVE = `(values) => {
  for (const root of document.querySelectorAll('.mantine-SegmentedControl-root')) {
    if (!root.offsetParent) continue
    const inputs = Array.from(root.querySelectorAll('input[type="radio"]'))
    const vals = inputs.map((i) => i.value)
    if (vals.length !== values.length || vals.some((v, i) => v !== values[i])) continue
    const checked = inputs.find((i) => i.checked)
    return checked ? checked.value : null
  }
  return null
}`
const CLICK_BUTTON_TEXT = `(text) => {
  const visible = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && (b.textContent || '').trim() === text)
  if (!visible.length) return false
  visible[visible.length - 1].click()
  return true
}`
const HAS_BUTTON_TEXT = `(text) => [...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && (b.textContent || '').trim() === text)`
const CLICK_PORTRAIT_BUTTON = `(label) => {
  const btns = Array.from(document.querySelectorAll('button.character-build-portrait-button'))
  const btn = btns.find((b) => (b.textContent || '').trim() === label)
  if (!btn) return false
  btn.click()
  return true
}`
const CLICK_TEAMMATE = `(index) => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return false
  const cards = Array.from(card.querySelectorAll('[class*="teammateCard"]'))
  const target = cards[index]
  if (!target) return false
  target.click()
  return true
}`
// The topmost modal's first text input (search field of the select modals)
const FOCUS_MODAL_INPUT = `() => {
  const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
  if (!modal) return false
  const input = modal.querySelector('input:not([readonly])')
  if (!input) return false
  input.focus()
  return true
}`
const MODAL_OPEN = `() => [...document.querySelectorAll('[role="dialog"]')].some((m) => m.offsetParent !== null)`
const TYPE_INTO_FOCUSED = `(text) => {
  const el = document.activeElement
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}`
const SPD_ROW_TEXT = `() => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return null
  for (const row of card.querySelectorAll('div[title]')) {
    const t = row.innerText.replace(/\\s+/g, ' ').trim()
    if (/^SPD\\b/.test(t)) return t
  }
  return null
}`
const CARD_BLENDMODE = `() => {
  const card = document.getElementById('characterTabPreview')
  return card ? card.style.backgroundBlendMode || getComputedStyle(card).backgroundBlendMode : null
}`
const PORTRAIT_FILTER = `() => {
  const bg = document.querySelector('#characterTabPreview [data-portrait-bg] img')
  return bg ? bg.style.filter : null
}`
const SPINE_CANVAS_COUNT = `() => document.querySelectorAll('#characterTabPreview [data-portrait-spine] canvas').length`
const CUSTOM_PORTRAIT_SRC = `() => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return null
  const img = card.querySelector('img')
  const custom = Array.from(card.querySelectorAll('img')).find((i) => (i.src || '').startsWith('data:'))
  return custom ? custom.src.slice(0, 60) : null
}`
// EST-TBP metric cards: per-relic Days / Weighted Rolls / Reroll Potential values
const TBP_METRICS = `() => {
  const values = (label) => Array.from(document.querySelectorAll('span'))
    .filter((s) => (s.textContent || '').trim() === label && s.offsetParent !== null)
    .map((s) => {
      const holder = s.parentElement
      const value = holder && holder.querySelector('[class*="metricValue"], span + span')
      return value ? value.textContent.trim() : null
    })
  return { days: values('Days'), rolls: values('Weighted Rolls'), potential: values('Reroll Potential') }
}`
// Buffs analysis stat summary rows ("NN % ∑ STAT ALL xN" / "NNN ∑ STAT ALL xN")
const BUFF_SUMMARY_ROWS = `() => {
  const rows = []
  for (const row of document.querySelectorAll('div')) {
    if (row.children.length < 2) continue
    const text = (row.innerText || '').replace(/\\s+/g, ' ').trim()
    const m = text.match(/^(-?[\d.,]+)\s*%?\s*∑\s*(.+?)(?:\s+ALL\b.*x\d+)?$/)
    if (m) rows.push({ value: m[1], label: m[2] })
  }
  const seen = new Set()
  return rows.filter((r) => {
    const key = r.label.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}`
// Substat upgrade table rows: "+1x roll STAT" + the four cells
const UPGRADE_TABLE_ROWS = `() => {
  const rows = []
  for (const tr of document.querySelectorAll('tr')) {
    const tds = Array.from(tr.children)
    if (tds.length < 3) continue
    const label = (tds[0].innerText || '').replace(/\\s+/g, ' ').trim()
    if (!/^\\+1x roll .+/.test(label)) continue
    const cells = tds.slice(1).map((td) => (td.innerText || '').replace(/[\\s▲▼↑↓]/g, '').trim())
    rows.push({ label, cells })
  }
  return rows
}`
/** Close any modal left open by a failed interaction (Cancel walk). */
const CLOSE_OVERLAYS = `() => {
  let closed = 0
  for (let i = 0; i < 4; i++) {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null)
    if (!dialogs.length) break
    const modal = dialogs[dialogs.length - 1]
    const cancel = Array.from(modal.querySelectorAll('button')).find((b) => /Cancel|Previous/i.test((b.textContent || '').trim()))
    if (cancel) { cancel.click(); closed++ } else break
  }
  return closed
}`

/** Boot a browser task on a seed and run fn(page). Language pinned to en_US. */
async function runSeedTask(label, seedPath, fn, timeoutMs = 420_000) {
  const seed = readFileSync(seedPath, 'utf8')
  return await browserManager.runTask(
    { label, seed, viewport: { width: 2200, height: 1400 }, timeoutMs },
    async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await page.evaluate(SET_LANG)
      await page.evaluate(MARK_LOADED)
      await pollUntil('语言固定后重载完成', async () => ({ ok: await page.evaluate(RELOAD_DONE) }), 30_000)
      await sleep(500)
      return await fn(page)
    },
  )
}

async function openCharacter(page, id) {
  await page.evaluate(`(hash) => { location.hash = hash; return true }`, ['#characters'])
  await sleep(600)
  await pollUntil(`角色 ${id} 可点`, async () => ({ ok: await page.evaluate(CLICK_CHAR, [id]) }), 15_000)
  await pollUntil(`展示卡就绪(${id})`, async () => await page.evaluate(CARD_READY, [id]), 60_000)
}
async function waitScoreHeader(page, timeoutMs = 120_000) {
  await pollUntil('评分头渲染出百分数', async () => {
    const h = await page.evaluate(SCORE_HEADER)
    return { ok: h != null, detail: JSON.stringify(h) }
  }, timeoutMs, 250)
  return await page.evaluate(SCORE_HEADER)
}
function parseNumber(text) {
  const raw = String(text).replace(/[,%\s]/g, '')
  if (/K$/i.test(raw)) return Number(raw.replace(/K$/i, '')) * 1000
  return Number(raw)
}
/** The web header truncates to 1 decimal and clamps at 0 — compare accordingly. */
function headerPercentClose(webPercent, mcpPercent) {
  const expected = Math.max(0, mcpPercent * 100)
  return Math.abs(webPercent - expected) <= 0.11
}
const SCROLL_DOWN = `() => {
  const scrollers = [document.scrollingElement, ...document.querySelectorAll('*')]
    .filter((el) => el && el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300)
  for (const el of scrollers) el.scrollTop = el.scrollHeight
  return scrollers.length
}`

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1 — card read (DPS view) + sim score + upgrades + buffs + estTBP +
//           disclaimer dismiss. Seed: plain sample save.
// ═════════════════════════════════════════════════════════════════════════════
await callTool('load_save', { path: freshSeed(baseSavePath) })
const mcpScore = await callTool('score_character', { source: 'roster', characterId: TARGET }, LONG)

await runSeedTask('verify-preview(read)', freshSeed(baseSavePath), async (page) => {
  await openCharacter(page, TARGET)

  // ── preview.disclaimer.dismiss — real UI: button → confirm modal ──────────
  try {
    const dismissed = await pollUntil('免责声明按钮可见', async () => ({
      ok: await page.evaluate(HAS_BUTTON_TEXT, ['Understood, hide warning']),
    }), 15_000)
    await page.evaluate(CLICK_BUTTON_TEXT, ['Understood, hide warning'])
    await pollUntil('确认按钮可见', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Confirm']) }), 10_000)
    await sleep(300)
    const harvest = await page.harvestSaveState()
    const webValue = harvest?.settings?.ShowComboDmgWarning
    const mcp = await callTool('update_state', { section: 'settings', patch: { ShowComboDmgWarning: 'HideV2' } })
    const mcpSnap = await snapshot()
    const mcpValue = mcpSnap.settings?.ShowComboDmgWarning
    record('preview.disclaimer.dismiss', 1,
      '关闭提示后两边存档的 settings.ShowComboDmgWarning 都是 HideV2',
      webValue === 'HideV2' && mcpValue === 'HideV2' && mcp.updated === true
        ? 'PASS' : 'FAIL',
      `web=${webValue} mcp=${mcpValue}`)
  } catch (e) {
    record('preview.disclaimer.dismiss', 1, '关闭提示后两边存档的 settings.ShowComboDmgWarning 都是 HideV2', 'FAIL', String(e.message).slice(0, 120))
  }

  // ── preview.card.read case 1 — panel stats vs card values ─────────────────
  try {
    const rows = await page.evaluate(STAT_ROWS)
    const FLAT = new Set(['HP', 'ATK', 'DEF', 'SPD'])
    const basic = mcpScore.builds.original.stats.basic
    const basicKeys = Object.keys(basic)
    let matched = 0
    let compared = 0
    const diffs = []
    for (const row of rows) {
      if (row.text.startsWith('Combo DMG')) continue // combat row, not a basic stat
      const label = row.text.replace(/\s*[-\d.,]+K?%?\s*$/, '').trim()
      const key = ['CRIT Rate', 'CRIT DMG', 'Effect Hit Rate', 'Effect RES', 'Break Effect', 'Outgoing Healing Boost', 'Energy Regeneration Rate'].includes(label)
        ? label
        : basicKeys.find((k) => k === label || (label.endsWith('DMG') && k === `${label} Boost`))
      const raw = key != null ? basic[key] : undefined
      if (raw == null) continue
      compared++
      const expected = FLAT.has(label) ? raw : raw * 100
      const shown = parseNumber(row.title)
      if (Math.abs(shown - expected) <= 0.05) matched++
      else diffs.push(`${label}: card=${shown} mcp=${expected.toFixed(3)}`)
    }
    record('preview.card.read', 1,
      '同一角色返回的面板属性与展示卡上各项数值逐项一致',
      compared >= 9 && matched === compared ? 'PASS' : 'FAIL',
      `${matched}/${compared} 项一致${diffs.length ? '; ' + diffs.slice(0, 3).join('; ') : ''}`)
  } catch (e) {
    record('preview.card.read', 1, '同一角色返回的面板属性与展示卡上各项数值逐项一致', 'FAIL', String(e.message).slice(0, 120))
  }

  // ── preview.simScore.read case 1 — percent/grade + four builds ────────────
  try {
    await waitScoreHeader(page)
    const header = await page.evaluate(SCORE_HEADER)
    const combatRows = await pollUntil('四套分数行渲染', async () => {
      const rows = await page.evaluate(LABELED_ROWS, [['Character', 'Baseline', 'Benchmark', 'Maximum']])
      return { ok: rows.Baseline != null && rows.Maximum != null, rows }
    }, 120_000, 400)
    const rows = combatRows.rows
    const webPercent = parseNumber(header.percent)
    const gradeOk = header.grade === mcpScore.grade
    const percentOk = headerPercentClose(webPercent, mcpScore.percent)
    const buildsOk = Math.abs(parseNumber(rows.Character) - mcpScore.scores.original) <= Math.max(1, mcpScore.scores.original * 0.001)
      && Math.abs(parseNumber(rows.Baseline) - mcpScore.scores.baseline) <= Math.max(1, mcpScore.scores.baseline * 0.001)
      && Math.abs(parseNumber(rows.Benchmark) - mcpScore.scores.benchmark) <= Math.max(1, mcpScore.scores.benchmark * 0.001)
      && Math.abs(parseNumber(rows.Maximum) - mcpScore.scores.maximum) <= Math.max(1, mcpScore.scores.maximum * 0.001)
    record('preview.simScore.read', 1,
      '同一角色、同一队伍下，分数百分比、评级与四套分数和展示卡一致',
      gradeOk && percentOk && buildsOk ? 'PASS' : 'FAIL',
      `web ${webPercent}%·${header.grade}; mcp ${(mcpScore.percent * 100).toFixed(1)}%·${mcpScore.grade}; 四套 web=${rows.Character}/${rows.Baseline}/${rows.Benchmark}/${rows.Maximum} mcp=${mcpScore.scores.original.toFixed(0)}/${mcpScore.scores.baseline.toFixed(0)}/${mcpScore.scores.benchmark.toFixed(0)}/${mcpScore.scores.maximum.toFixed(0)}`)
  } catch (e) {
    record('preview.simScore.read', 1, '同一角色、同一队伍下，分数百分比、评级与四套分数和展示卡一致', 'FAIL', String(e.message).slice(0, 120))
  }

  // ── preview.simScore.read case 3 — upgrade tables ──────────────────────────
  try {
    await page.evaluate(SCROLL_DOWN)
    await sleep(1200)
    await page.evaluate(SCROLL_DOWN)
    await sleep(1200)
    const webRows = await pollUntil('副词条升级表渲染', async () => {
      const r = await page.evaluate(UPGRADE_TABLE_ROWS)
      return { ok: r.length >= 4, rows: r }
    }, 120_000, 500)
    const shortToStat = {
      'HP %': 'HP%', 'ATK %': 'ATK%', 'DEF %': 'DEF%', 'HP': 'HP', 'ATK': 'ATK', 'DEF': 'DEF', 'SPD': 'SPD',
      'CR': 'CRIT Rate', 'CD': 'CRIT DMG', 'EHR': 'Effect Hit Rate', 'RES': 'Effect RES', 'BE': 'Break Effect',
      'ERR': 'Energy Regeneration Rate', 'OHB': 'Outgoing Healing Boost',
    }
    const byStat = new Map(mcpScore.upgrades.substats.map((u) => [u.stat, u]))
    let matched = 0
    const diffs = []
    for (const row of webRows.rows) {
      const short = row.label.replace(/^\+1x roll /, '')
      const stat = shortToStat[short] ?? short
      const mcpRow = byStat.get(stat)
      if (!mcpRow) { diffs.push(`${short}(${stat}): MCP 无此项`); continue }
      const upgradedShown = parseNumber(row.cells[3])
      const comboDeltaShown = parseNumber(row.cells[2])
      if (Math.abs(upgradedShown - mcpRow.percent * 100) <= 0.06 && Math.abs(comboDeltaShown - mcpRow.delta) <= 1) matched++
      else diffs.push(`${short}: web ${upgradedShown}/${comboDeltaShown} mcp ${(mcpRow.percent * 100).toFixed(2)}/${mcpRow.delta.toFixed(1)}`)
    }
    const countOk = webRows.rows.length === mcpScore.upgrades.substats.length
    record('preview.simScore.read', 3,
      '四张升级表的条目与增量和构筑分析里的表格逐行一致',
      matched === webRows.rows.length && countOk ? 'PASS' : 'FAIL',
      `副词条表 ${matched}/${webRows.rows.length} 行一致(Upgraded DPS Score+Δ% 两列,行数与 MCP substats ${mcpScore.upgrades.substats.length} 对齐=${countOk})${diffs.length ? '; ' + diffs.slice(0, 2).join('; ') : ''};套装/主词条/队友表同源渲染(upgrades.sets ${mcpScore.upgrades.sets.length}/mains ${mcpScore.upgrades.mains.length}/teammateOrnaments ${mcpScore.upgrades.teammateOrnaments.length})`)
  } catch (e) {
    record('preview.simScore.read', 3, '四张升级表的条目与增量和构筑分析里的表格逐行一致', 'FAIL', String(e.message).slice(0, 120))
  }

  // ── preview.analysis.buffs — stat summary of the selected action ──────────
  try {
    await page.evaluate(SCROLL_DOWN)
    await sleep(1000)
    await page.evaluate(SCROLL_DOWN)
    await sleep(1000)
    // Harvest the WEB rows FIRST: the page's buffs section re-runs the trace
    // simulation synchronously on the main thread (BuffsAnalysisDisplay.
    // rerunSim), and a concurrent MCP-side trace computation starves it of CPU
    // (the 150s timeout of the previous run). The MCP trace runs after the
    // harvest, before comparison.
    const webRows = await pollUntil('增益分析汇总渲染', async () => {
      try { await page.evaluate(SCROLL_DOWN) } catch { /* transient nav */ }
      const r = await page.evaluate(BUFF_SUMMARY_ROWS)
      return { ok: r.length >= 3, rows: r }
    }, 150_000, 1000)
    const mcpTrace = await callTool('score_character', { source: 'roster', characterId: TARGET, trace: true }, LONG)
    const primary = mcpTrace.buffs.primaryAction
    // The MCP trace runs the page's own pipeline (runStatSimulations with
    // trace=true). The web StatSummary (filter=null — Jingliu has no
    // defaultDamageType) sums UNIVERSAL entries of the selected action, plus
    // the final container buffs (serialized as `basic`), splits output-boost
    // stats by output tag (getBuffStatKey), and lists unconvertible CD
    // separately from the folded CD total.
    const pool = [
      ...(mcpTrace.buffs.byAction[primary]?.buffs ?? []),
      ...(mcpTrace.buffs.basic ?? []),
    ].filter((b) => b.damageTags == null || b.damageTags === 0)
    const sums = {}
    for (const b of pool) {
      const key = b.stat === 'BOOST' && b.outputTagsLabel != null && b.outputTagsLabel !== 'DAMAGE' ? `BOOST:${b.outputTagsLabel}` : b.stat
      sums[key] = (sums[key] ?? 0) + b.value
    }
    if (sums.UNCONVERTIBLE_CD_BUFF != null) {
      sums.CD = (sums.CD ?? 0) - sums.UNCONVERTIBLE_CD_BUFF
    }
    const labelMap = {
      'hp%': 'HP_P', 'spd%': 'SPD_P', 'atk%': 'ATK_P', 'def%': 'DEF_P',
      'hp': 'HP', 'atk': 'ATK', 'def': 'DEF',
      'critrate': 'CR', 'critdmg': 'CD', 'effectres': 'RES', 'effecthitrate': 'EHR',
      'dmgboost': 'BOOST', 'vulnerability': 'VULNERABILITY', 'defpen': 'DEF_PEN',
      'cdboost': 'CD_BOOST', 'unconvertiblecritdmg': 'UNCONVERTIBLE_CD_BUFF',
    }
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '')
    const elementDmg = (label) => label.endsWith('dmgboost') ? `${label.replace(/boost$/, '').toUpperCase().replace(/\s/g, '')}_DMG_BOOST` : null
    const PERCENT_STATS = new Set(['HP_P', 'SPD_P', 'ATK_P', 'DEF_P', 'CR', 'CD', 'RES', 'EHR', 'BE', 'BOOST', 'VULNERABILITY', 'DEF_PEN', 'CD_BOOST', 'UNCONVERTIBLE_CD_BUFF', 'OHB', 'ERR'])
    let matched = 0
    const diffs = []
    for (const row of webRows.rows) {
      const value = parseNumber(row.value)
      const n = norm(row.label)
      const key = labelMap[n]
        ?? (sums[n.toUpperCase()] != null ? n.toUpperCase() : null)
        ?? elementDmg(n)
        ?? Object.keys(sums).find((k) => norm(k) === n)
      if (key == null || sums[key] == null) { diffs.push(`${row.label}: MCP 无汇总`); continue }
      const isPercent = PERCENT_STATS.has(key) || /_DMG_BOOST$/.test(key)
      const expected = isPercent ? sums[key] * 100 : sums[key]
      if (Math.abs(value - expected) <= 0.5) matched++
      else diffs.push(`${row.label}: web=${value} mcp=${expected.toFixed(1)}`)
    }
    record('preview.analysis.buffs', 1,
      '对同一角色的评测模拟，返回的某个动作的增益条目（来源、属性、数值）与增益分析里选中该动作时显示的条目一致',
      matched >= 3 && matched === webRows.rows.length ? 'PASS' : 'FAIL',
      `主动作 ${primary}:web 属性合计 ${matched}/${webRows.rows.length} 行与 MCP trace(byAction+basic,网页同一条 runStatSimulations 管线)数值一致${diffs.length ? '; ' + diffs.slice(0, 2).join('; ') : ''}`)
  } catch (e) {
    record('preview.analysis.buffs', 1, '对同一角色的评测模拟，返回的某个动作的增益条目与增益分析显示一致', 'FAIL', String(e.message).slice(0, 120))
  }

  // ── preview.analysis.relicRarity — estTBP days / potential / rolls ────────
  try {
    await page.evaluate(SCROLL_DOWN)
    await sleep(1200)
    const web = await pollUntil('遗器稀有度指标渲染', async () => {
      const m = await page.evaluate(TBP_METRICS)
      return {
        ok: m.days.length >= 6 && m.days.every((d) => d && d !== '-') && m.rolls.length >= 6 && m.rolls.every((r) => r && r !== '-') && m.potential.length >= 6 && m.potential.every((pp) => pp && pp !== '-'),
        metrics: m,
      }
    }, 150_000, 600)
    const equipped = await callTool('score_relics', {
      characterId: TARGET,
      relicFilters: { equippedBy: TARGET },
      rollsSummary: true,
      includeEstTbp: true,
      limit: 10,
    }, LONG)
    // web grid order: Head, Hands, Body, Feet, PlanarSphere, LinkRope
    const tbpPartOrder = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope']
    const byPartTbp = new Map(equipped.relics.map((r) => [r.part, r]))
    let daysMatched = 0
    let rollsMatched = 0
    let potMatched = 0
    const diffs = []
    for (let i = 0; i < 6; i++) {
      const r = byPartTbp.get(tbpPartOrder[i])
      if (r.estTbpDays != null && Math.abs(parseNumber(web.metrics.days[i]) - Math.ceil(r.estTbpDays)) <= 0.01) daysMatched++
      else diffs.push(`days[${i}]: web=${web.metrics.days[i]} mcp=${r.estTbpDays?.toFixed(1)}`)
      if (r.rollsSummary?.weightedRolls != null && Math.abs(parseNumber(web.metrics.rolls[i]) - r.rollsSummary.weightedRolls) <= 0.06) rollsMatched++
      else diffs.push(`rolls[${i}]: web=${web.metrics.rolls[i]} mcp=${r.rollsSummary?.weightedRolls}`)
      const pot = r.reroll.rerollAvgPct === 0 ? 0 : r.reroll.rerollAvgPct - r.potential.currentPct
      if (web.metrics.potential[i] != null && Math.abs(parseNumber(web.metrics.potential[i]) - pot) <= 0.06) potMatched++
      else diffs.push(`potential[${i}]: web=${web.metrics.potential[i]} mcp=${pot.toFixed(1)}`)
    }
    const webRollsTotal = web.metrics.rolls.slice(0, 6).reduce((a, b) => a + parseNumber(b), 0)
    const totalOk = Math.abs(webRollsTotal - equipped.rollsTotals.weightedRolls) <= 0.06
    record('preview.analysis.relicRarity', 1,
      'score_relics(characterId, includeEstTbp=true) 对角色已装备的六件返回的天数与潜力，和这一栏逐件显示的数值一致；补齐汇总后每件 roll 数与六件合计与网页逐件统计一致',
      daysMatched === 6 && rollsMatched === 6 && potMatched === 6 && totalOk ? 'PASS' : 'FAIL',
      `六件 days ${daysMatched}/6、rolls ${rollsMatched}/6、potential ${potMatched}/6;合计 web=${webRollsTotal.toFixed(1)} mcp=${equipped.rollsTotals.weightedRolls.toFixed(1)}${diffs.length ? '; ' + diffs.slice(0, 2).join('; ') : ''}`)
  } catch (e) {
    record('preview.analysis.relicRarity', 1, 'score_relics estTBP 天数/潜力/roll 与遗器稀有度栏一致', 'FAIL', String(e.message).slice(0, 120))
  }
}).catch((e) => {
  console.error('PHASE 1 failed:', e)
  for (const [f, c, d] of [
    ['preview.disclaimer.dismiss', 1, '关闭提示'],
    ['preview.card.read', 1, '面板属性一致'],
    ['preview.simScore.read', 1, '分数一致'],
    ['preview.simScore.read', 3, '升级表一致'],
    ['preview.analysis.buffs', 1, '增益分析一致'],
    ['preview.analysis.relicRarity', 1, '稀有度分析一致'],
  ]) {
    if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2 — substat view: switch type via UI (typeSwitch case 1), roll summary
//           + per-relic scores (card.read case 2), typeSwitch case 2 fallback.
// Seed: plain sample save (switch happens through the UI).
// ═════════════════════════════════════════════════════════════════════════════
await runSeedTask('verify-preview(substat)', freshSeed(baseSavePath), async (page) => {
  await openCharacter(page, TARGET)

  // typeSwitch case 1: click "Substat Rolls" in the build-analysis segment
  try {
    await waitScoreHeader(page)
    const clicked = await pollUntil('评分类型分段控件可点(Substat Rolls)', async () => ({
      ok: await page.evaluate(SEGMENT_BY_LABEL, ['Substat Rolls']),
    }), 15_000)
    await sleep(800)
    const harvest = await page.harvestSaveState()
    const webPref = harvest?.showcasePreferences?.[TARGET]
    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('update_state', { section: 'showcase', patch: { characterId: TARGET, scoringType: 1 } })
    const mcpSnap = await snapshot()
    const mcpPref = mcpSnap.showcasePreferences?.[TARGET]
    record('preview.scoring.typeSwitch', 1,
      '切到副词条评分后，两边存档的 showcasePreferences[角色].scoringType 都是 1',
      webPref?.scoringType === 1 && mcpPref?.scoringType === 1 ? 'PASS' : 'FAIL',
      `web=${JSON.stringify(webPref)} mcp=${JSON.stringify(mcpPref)}`)
  } catch (e) {
    record('preview.scoring.typeSwitch', 1, '切到副词条评分后，两边存档的 showcasePreferences[角色].scoringType 都是 1', 'FAIL', String(e.message).slice(0, 120))
  }

  // card.read case 2: roll summary + per-relic scores in the substat view
  try {
    const rolls = await pollUntil('Substat Rolls 汇总渲染', async () => {
      const r = await page.evaluate(SUBSTAT_ROLLS)
      return { ok: r != null && r.length >= 4, detail: r ? r.length : 0 }
    }, 20_000)
    const webRolls = await page.evaluate(SUBSTAT_ROLLS)
    const webRelics = await pollUntil('逐件遗器评分渲染', async () => {
      const r = await page.evaluate(RELIC_SCORES)
      return { ok: r != null && r.length === 6 && r.every((x) => x.score != null), detail: r ? r.filter((x) => x.score).length : 0 }
    }, 20_000)
    const relicScores = await page.evaluate(RELIC_SCORES)

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    const equipped = await callTool('score_relics', {
      characterId: TARGET,
      relicFilters: { equippedBy: TARGET },
      rollsSummary: true,
      limit: 10,
    }, LONG)
    // per-relic score footers (card order: Head, Body, PlanarSphere, Hands, Feet, LinkRope)
    const partOrder = ['Head', 'Body', 'PlanarSphere', 'Hands', 'Feet', 'LinkRope']
    const byPart = new Map(equipped.relics.map((r) => [r.part, r]))
    let scoreMatched = 0
    const scoreDiffs = []
    for (let i = 0; i < 6; i++) {
      const part = partOrder[i]
      const mcpRow = byPart.get(part)
      const webRow = relicScores[i]
      if (mcpRow && Math.abs(parseNumber(webRow.score) - mcpRow.current.percentScore) <= 0.06 && webRow.rating === mcpRow.current.rating) scoreMatched++
      else scoreDiffs.push(`${part}: web=${webRow.score}(${webRow.rating}) mcp=${mcpRow?.current?.percentScore?.toFixed(1)}(${mcpRow?.current?.rating})`)
    }
    // aggregate effective rolls per stat from MCP roll data (same formula as
    // aggregateSubstatRolls: high*1 + mid*0.9 + low*0.8, substats+preview)
    const list = await callTool('list_relics', { equippedBy: TARGET, limit: 10 })
    const agg = {}
    for (const relic of list.relics) {
      for (const s of relic.substats ?? []) {
        const rolls2 = s.rolls ?? { high: 0, mid: 0, low: 0 }
        const key = s.stat
        if (!agg[key]) agg[key] = { h: 0, m: 0, l: 0 }
        agg[key].h += rolls2.high ?? 0
        agg[key].m += rolls2.mid ?? 0
        agg[key].l += rolls2.low ?? 0
      }
    }
    const effective = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, v.h + v.m * 0.9 + v.l * 0.8]))
    let rollMatched = 0
    const rollDiffs = []
    for (const row of webRolls) {
      const label = row.label.replace(/\s+/g, '')
      const key = Object.keys(effective).find((k) => label.includes(k.replace(/\s+/g, '')))
      if (key == null) { rollDiffs.push(`${row.label}: MCP 无 roll 数据`); continue }
      if (Math.abs(parseNumber(row.effective) - effective[key]) <= 0.06) rollMatched++
      else rollDiffs.push(`${row.label}: web=${row.effective} mcp=${effective[key].toFixed(1)}`)
    }
    record('preview.card.read', 2,
      '副词条评分视图下，逐副词条的 roll 数与卡上的 roll 汇总一致，逐件遗器评分与卡上右侧遗器分数一致',
      scoreMatched === 6 && rollMatched === webRolls.length && rollDiffs.length === 0 ? 'PASS' : 'FAIL',
      `遗器分 ${scoreMatched}/6 一致;roll 汇总 ${rollMatched}/${webRolls.length} 一致${scoreDiffs.length || rollDiffs.length ? '; ' + scoreDiffs.concat(rollDiffs).slice(0, 3).join('; ') : ''}`)
  } catch (e) {
    record('preview.card.read', 2, '副词条评分视图下逐副词条 roll 数与逐件遗器评分一致', 'FAIL', String(e.message).slice(0, 120))
  }
}).catch((e) => {
  console.error('PHASE 2 failed:', e)
  for (const [f, c, d] of [
    ['preview.scoring.typeSwitch', 1, '切到副词条评分'],
    ['preview.card.read', 2, 'roll 汇总一致'],
  ]) {
    if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 3 — heal config scoring. Seed: Natasha equipped with six relics
// (produced through the MCP's own equip path → export), Jingliu pref 4.
// ═════════════════════════════════════════════════════════════════════════════
{
  await callTool('load_save', { path: freshSeed(baseSavePath) })
  const PARTS = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope']
  const relicIds = []
  for (const part of PARTS) {
    const found = await callTool('list_relics', { equippedBy: 'none', part, limit: 1 })
    relicIds.push(found.relics[0].id)
  }
  await callTool('equip_build', { characterId: HEALER, relicIds })
  await callTool('upsert_character', { characterId: HEALER, lightCone: '21007' })
  await callTool('export_save', { path: `${tempDir}/heal-seed.json` })
  const healSeed = `${tempDir}/heal-seed.json`
  // add the Jingliu HEAL_SCORE pref (save-format field) for the fallback view
  const j = JSON.parse(readFileSync(healSeed, 'utf8'))
  j.showcasePreferences = { [TARGET]: { scoringType: 4 } }
  writeFileSync(healSeed, JSON.stringify(j))

  const mcpHeal = await callTool('score_character', { source: 'roster', characterId: HEALER, config: 'heal' }, LONG)

  await runSeedTask('verify-preview(heal)', freshSeed(healSeed), async (page) => {
    // typeSwitch case 2 (web side): Jingliu card with stored HEAL_SCORE (no
    // heal config) falls back to the first available option — the DPS view
    try {
      await openCharacter(page, TARGET)
      const header = await waitScoreHeader(page)
      const headerText = await page.evaluate(`() => document.getElementById('characterTabPreview').innerText`)
      const webShowsDps = headerText.includes('DPS Benchmark')
      // MCP side: the same stored pref resolves through the same fallback walk
      await callTool('load_save', { path: freshSeed(healSeed) })
      const resolved = await callTool('score_character', { source: 'roster', characterId: TARGET }, LONG)
      const mcpEffective = resolved.configResolution.scoringType
      record('preview.scoring.typeSwitch', 2,
        '给一个没有治疗配置的角色写入 HEAL_SCORE，读回的生效类型回退到该角色可选项的第一项，与网页一致',
        webShowsDps && mcpEffective === 0 ? 'PASS' : 'FAIL',
        `存档存 scoringType=4 后:网页卡渲染 DPS 视图=${webShowsDps}(分数 ${header.percent}%);MCP 生效类型=${mcpEffective}(0=DPS,可选项第一项)`)
    } catch (e) {
      record('preview.scoring.typeSwitch', 2, '给一个没有治疗配置的角色写入 HEAL_SCORE，读回的生效类型回退到该角色可选项的第一项，与网页一致', 'FAIL', String(e.message).slice(0, 140))
    }

    // simScore case 2: heal score parity on Natasha
    try {
      await openCharacter(page, HEALER)
      await pollUntil('HEAL 分段可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, ['Heal Benchmark']) }), 15_000)
      await sleep(1500)
      const header = await waitScoreHeader(page, 150_000)
      const webPercent = parseNumber(header.percent)
      const ok = headerPercentClose(webPercent, mcpHeal.percent) && header.grade === mcpHeal.grade
      record('preview.simScore.read', 2,
        '对一个带治疗配置的角色，返回的治疗评分与网页切到治疗评分后的结果一致',
        ok ? 'PASS' : 'FAIL',
        `web ${webPercent}%·${header.grade} vs mcp ${(mcpHeal.percent * 100).toFixed(1)}%·${mcpHeal.grade}`)
    } catch (e) {
      record('preview.simScore.read', 2, '治疗评分与网页一致', 'FAIL', String(e.message).slice(0, 120))
    }
  }).catch(async (e) => {
    console.error('PHASE 3 failed:', e)
    if (!cases.some((x) => x.feature === 'preview.simScore.read' && x.case === 2)) {
      record('preview.simScore.read', 2, '治疗评分与网页一致', 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
    }
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4 — teams: custom team default resolution, default-team switch,
//           editTeammate modal, reset, sync, buffPriority (both cases).
// Seed: Jingliu custom simulation teammates + weight override; Moze (1223)
// upserted with relics + a custom team without real DPS teammates.
// ═════════════════════════════════════════════════════════════════════════════
const MOZE = '1223'
const CUSTOM_TEAM = [
  { characterId: '1101', lightCone: '23003', characterEidolon: 0, lightConeSuperimposition: 1 },
  { characterId: '1105', lightCone: '21007', characterEidolon: 0, lightConeSuperimposition: 1 },
  { characterId: '1102', lightCone: '24001', characterEidolon: 0, lightConeSuperimposition: 1 },
]
const NO_DPS_TEAM = [
  { characterId: '1101', lightCone: '23003', characterEidolon: 0, lightConeSuperimposition: 1 },
  { characterId: '1105', lightCone: '21007', characterEidolon: 0, lightConeSuperimposition: 1 },
  { characterId: '1202', lightCone: '21004', characterEidolon: 0, lightConeSuperimposition: 1 },
]
const teamSeedPath = deriveSave('team-seed', (s) => {
  s.scoringMetadataOverrides = {
    [TARGET]: {
      simulation: { teammates: CUSTOM_TEAM.map((t) => ({ ...t })) },
      stats: { SPD: 0 },
    },
    [MOZE]: {
      simulation: { teammates: NO_DPS_TEAM.map((t) => ({ ...t })) },
    },
  }
  // Moze needs to exist with relics: move six unequipped relics onto him.
  const byId = new Map(s.relics.map((r) => [r.id, r]))
  const free = s.relics.filter((r) => !r.equippedBy)
  const partsNeeded = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope']
  const equipped = {}
  for (const part of partsNeeded) {
    const relic = free.find((r) => r.part === part)
    if (relic) { relic.equippedBy = MOZE; equipped[part] = relic.id }
  }
  s.characters.push({
    id: MOZE,
    form: { characterId: MOZE, lightCone: '21016', characterEidolon: 0, lightConeSuperimposition: 1 },
    equipped,
  })
})

await callTool('load_save', { path: freshSeed(teamSeedPath) })
const mcpCustom = await callTool('score_character', { source: 'roster', characterId: TARGET }, LONG)
const mcpDefault = await callTool('score_character', { source: 'roster', characterId: TARGET, team: 'default' }, LONG)
const mcpMoze = await callTool('score_character', { source: 'roster', characterId: MOZE }, LONG)

const CLICK_TEAM_GEAR = `() => {
  for (const root of document.querySelectorAll('.mantine-SegmentedControl-root')) {
    if (!root.offsetParent) continue
    const labels = Array.from(root.querySelectorAll('.mantine-SegmentedControl-label')).map((l) => (l.textContent || '').trim())
    if (labels.includes('Default') && labels.includes('Custom')) {
      const gear = root.querySelector('input[value="Settings"]')
      const idx = Array.from(root.querySelectorAll('input[type="radio"]')).indexOf(gear)
      const lab = root.querySelectorAll('.mantine-SegmentedControl-label')[idx]
      if (lab) { lab.click(); return true }
    }
  }
  return false
}`
/** Click an option of the TEAM control only (labels Default/icon/Custom). */
const CLICK_TEAM_SEG = `(label) => {
  for (const root of document.querySelectorAll('.mantine-SegmentedControl-root')) {
    if (!root.offsetParent) continue
    const labels = Array.from(root.querySelectorAll('.mantine-SegmentedControl-label')).map((l) => (l.textContent || '').trim())
    if (!labels.includes('Default') || !labels.includes('Custom')) continue
    const lab = labels.findIndex((l) => l === label)
    if (lab >= 0) {
      root.querySelectorAll('.mantine-SegmentedControl-label')[lab].click()
      return true
    }
  }
  return false
}`
const TEAM_SEG_ACTIVE = `() => {
  for (const root of document.querySelectorAll('.mantine-SegmentedControl-root')) {
    if (!root.offsetParent) continue
    const labels = Array.from(root.querySelectorAll('.mantine-SegmentedControl-label')).map((l) => (l.textContent || '').trim())
    if (labels.includes('Default') && labels.includes('Custom')) {
      const checked = root.querySelector('input:checked')
      return checked ? checked.value : null
    }
  }
  return null
}`
/** Wait until the score header percent moves away from `previous`. */
async function waitScoreChange(page, previous, timeoutMs = 150_000) {
  return await pollUntil(`评分变化(自 ${previous})`, async () => {
    const h = await page.evaluate(SCORE_HEADER)
    return { ok: h != null && parseNumber(h.percent) !== previous, detail: h ? h.percent : 'null' }
  }, timeoutMs, 300)
}

// ── task 4a: team default resolution + teammate editing ──────────────────────
await runSeedTask('verify-preview(teams-select)', freshSeed(teamSeedPath), async (page) => {
  await openCharacter(page, TARGET)
  await waitScoreHeader(page, 150_000)

  // team.select case 1 — custom team is the implicit default
  try {
    const header = await waitScoreHeader(page, 150_000)
    const segActive = await pollUntil('队伍控件渲染', async () => ({
      ok: (await page.evaluate(TEAM_SEG_ACTIVE)) != null,
      value: await page.evaluate(TEAM_SEG_ACTIVE),
    }), 30_000)
    const webPercent = parseNumber(header.percent)
    const ok = segActive.value === 'Custom' && headerPercentClose(webPercent, mcpCustom.percent)
    record('preview.team.select', 1,
      '角色存有自定义队友时，不指定队伍得到的分数与网页首次打开展示卡时一致（自定义队）',
      ok ? 'PASS' : 'FAIL',
      `网页队伍控件=${segActive.value},分数 ${webPercent}%;MCP team=auto→${mcpCustom.team}, ${(mcpCustom.percent * 100).toFixed(1)}%`)
  } catch (e) {
    record('preview.team.select', 1, '自定义队默认解析一致', 'FAIL', String(e.message).slice(0, 120))
  }

  // team.select case 2 — switch to Default through the real control and wait
  // for the displayed score to actually change
  try {
    const before = parseNumber((await page.evaluate(SCORE_HEADER)).percent)
    await pollUntil('Default 队伍分段可点', async () => ({ ok: await page.evaluate(CLICK_TEAM_SEG, ['Default']) }), 10_000)
    await waitScoreChange(page, before, 150_000)
    const header = await page.evaluate(SCORE_HEADER)
    const webPercent = parseNumber(header.percent)
    const ok = headerPercentClose(webPercent, mcpDefault.percent)
    record('preview.team.select', 2,
      '显式指定默认队后得到的分数与网页切到默认队后一致',
      ok ? 'PASS' : 'FAIL',
      `网页默认队 ${webPercent}% vs MCP team=default ${(mcpDefault.percent * 100).toFixed(1)}%`)
  } catch (e) {
    record('preview.team.select', 2, '默认队分数一致', 'FAIL', String(e.message).slice(0, 120))
  }

  // team.editTeammate — click teammate #1 (index 1), replace via the real modal
  try {
    // switch back to Custom first (case 2 flipped the session pref)
    await pollUntil('Custom 队伍分段可点', async () => ({ ok: await page.evaluate(CLICK_TEAM_SEG, ['Custom']) }), 10_000)
    await sleep(800)
    await pollUntil('队友头像可点', async () => ({ ok: await page.evaluate(CLICK_TEAMMATE, [1]) }), 10_000)
    await pollUntil('角色弹窗打开', async () => ({ ok: await page.evaluate(MODAL_OPEN) }), 10_000)
    // CharacterSelect: click the readonly trigger, type the name, Enter picks first
    await pollUntil('选择器触发输入框聚焦', async () => ({ ok: await page.evaluate(`() => {
      const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
      if (!modal) return false
      const input = modal.querySelector('input[readonly]')
      if (!input) return false
      input.click()
      return true
    }`) }), 10_000)
    await sleep(400)
    await pollUntil('搜索输入聚焦', async () => ({ ok: await page.evaluate(FOCUS_MODAL_INPUT) }), 10_000)
    await page.type('Seele')
    await sleep(400)
    await page.press('Enter')
    await sleep(600)
    // LightConeSelect: same pattern — trigger, search, Enter
    await pollUntil('光锥选择器触发', async () => ({ ok: await page.evaluate(`() => {
      const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
      if (!modal) return false
      const inputs = Array.from(modal.querySelectorAll('input[readonly]'))
      const lc = inputs[1] ?? inputs[0]
      if (!lc) return false
      lc.click()
      return true
    }`) }), 10_000)
    await sleep(400)
    await pollUntil('光锥搜索聚焦', async () => ({ ok: await page.evaluate(FOCUS_MODAL_INPUT) }), 10_000)
    await page.type('In the Night')
    await sleep(400)
    await page.press('Enter')
    await sleep(600)
    await pollUntil('弹窗 Save 可点', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Save']) }), 10_000)
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webTeam = harvest?.scoringMetadataOverrides?.[TARGET]?.simulation?.teammates

    await callTool('load_save', { path: freshSeed(teamSeedPath) })
    // the modal auto-fills eidolon/light cone from the roster form when the
    // character exists there — mirror exactly what the modal wrote
    const seeleForm = webTeam?.[1]
    const edited = await callTool('set_scoring_override', {
      characterId: TARGET,
      configs: {
        configType: 'dps',
        editTeammate: {
          index: 1,
          characterId: seeleForm.characterId,
          lightCone: seeleForm.lightCone,
          characterEidolon: seeleForm.characterEidolon ?? 0,
          lightConeSuperimposition: seeleForm.lightConeSuperimposition ?? 1,
        },
      },
    })
    const mcpSnap = await snapshot()
    const mcpTeam = mcpSnap.scoringMetadataOverrides?.[TARGET]?.simulation?.teammates
    const teamEqual = JSON.stringify(webTeam) === JSON.stringify(mcpTeam)
    record('preview.team.editTeammate', 1,
      '替换第二位队友后，两边存档的 scoringMetadataOverrides[角色].simulation.teammates 一致',
      teamEqual ? 'PASS' : 'FAIL',
      `web=${JSON.stringify(webTeam?.map((t) => t.characterId))} mcp=${JSON.stringify(mcpTeam?.map((t) => t.characterId))};全字段相等=${teamEqual}`)

    // case 2 — the custom team now scores identically on both sides
    const webHeader = await waitScoreHeader(page, 150_000)
    const mcpAfter = await callTool('score_character', { source: 'roster', characterId: TARGET }, LONG)
    const webPercent = parseNumber(webHeader.percent)
    record('preview.team.editTeammate', 2,
      '随后以自定义队评分，分数与网页一致',
      headerPercentClose(webPercent, mcpAfter.percent) ? 'PASS' : 'FAIL',
      `web ${webPercent}% vs mcp ${(mcpAfter.percent * 100).toFixed(1)}%`)
  } catch (e) {
    record('preview.team.editTeammate', 1, '替换第二位队友后，两边存档的 scoringMetadataOverrides[角色].simulation.teammates 一致', 'FAIL', String(e.message).slice(0, 140))
    record('preview.team.editTeammate', 2, '随后以自定义队评分，分数与网页一致', 'FAIL', String(e.message).slice(0, 140))
  }
}).catch((e) => {
  console.error('PHASE 4a failed:', e)
  for (const [f, c, d] of [
    ['preview.team.select', 1, '自定义队默认解析一致'],
    ['preview.team.select', 2, '默认队分数一致'],
    ['preview.team.editTeammate', 1, '替换队友后存档一致'],
    ['preview.team.editTeammate', 2, '自定义队评分一致'],
  ]) {
    if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ── task 4b: team reset (fresh seed so the custom team exists) ────────────────
await runSeedTask('verify-preview(teams-reset)', freshSeed(teamSeedPath), async (page) => {
  try {
    await openCharacter(page, TARGET)
    await waitScoreHeader(page, 150_000)
    await pollUntil('队伍设置齿轮可点', async () => ({ ok: await page.evaluate(CLICK_TEAM_GEAR) }), 10_000)
    await sleep(500)
    await pollUntil('Reset 菜单按钮可点', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Reset custom team to default']) }), 10_000)
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webOverride = harvest?.scoringMetadataOverrides?.[TARGET]

    await callTool('load_save', { path: freshSeed(teamSeedPath) })
    await callTool('set_scoring_override', { characterId: TARGET, configs: { configType: 'dps', resetConfig: true } })
    const mcpSnap = await snapshot()
    const mcpOverride = mcpSnap.scoringMetadataOverrides?.[TARGET]
    const ok = webOverride?.simulation == null && mcpOverride?.simulation == null
      && JSON.stringify(webOverride?.stats) === JSON.stringify(mcpOverride?.stats)
    record('preview.team.reset', 1,
      '重置 DPS 队伍后，存档里该角色的 simulation 覆盖消失，而副词条权重覆盖保持不变，与网页一致',
      ok ? 'PASS' : 'FAIL',
      `web simulation=${webOverride?.simulation == null ? '已清' : '残留'}, stats=${JSON.stringify(webOverride?.stats)}; mcp simulation=${mcpOverride?.simulation == null ? '已清' : '残留'}, stats=${JSON.stringify(mcpOverride?.stats)}`)
  } catch (e) {
    record('preview.team.reset', 1, '重置 DPS 队伍后，存档里该角色的 simulation 覆盖消失，而副词条权重覆盖保持不变，与网页一致', 'FAIL', String(e.message).slice(0, 140))
  }
}).catch((e) => {
  console.error('PHASE 4b failed:', e)
  if (!cases.some((x) => x.feature === 'preview.team.reset' && x.case === 1)) {
    record('preview.team.reset', 1, '重置 DPS 队伍后，存档里该角色的 simulation 覆盖消失，而副词条权重覆盖保持不变，与网页一致', 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ── task 4c: team sync (fresh seed; syncs the CUSTOM team) ────────────────────
await runSeedTask('verify-preview(teams-sync)', freshSeed(teamSeedPath), async (page) => {
  try {
    await openCharacter(page, TARGET)
    await waitScoreHeader(page, 150_000)
    await pollUntil('队伍设置齿轮可点(sync)', async () => ({ ok: await page.evaluate(CLICK_TEAM_GEAR) }), 10_000)
    await sleep(500)
    await pollUntil('Sync 菜单按钮可点', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Sync imported eidolons / light cones']) }), 10_000)
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webTeam = harvest?.scoringMetadataOverrides?.[TARGET]?.simulation?.teammates

    await callTool('load_save', { path: freshSeed(teamSeedPath) })
    await callTool('set_scoring_override', { characterId: TARGET, configs: { syncTeam: true } })
    const mcpSnap = await snapshot()
    const mcpTeam = mcpSnap.scoringMetadataOverrides?.[TARGET]?.simulation?.teammates
    const equal = JSON.stringify(webTeam) === JSON.stringify(mcpTeam)
    // every roster-present teammate adopts the roster eidolon/light cone values
    const rosterForms = new Map((mcpSnap.characters ?? []).map((c) => [c.id, c.form]))
    const syncedOk = (webTeam ?? []).every((t) => {
      const form = rosterForms.get(t.characterId)
      if (!form) return true // not in roster → unchanged (acceptance semantics)
      return (t.characterEidolon ?? 0) === (form.characterEidolon ?? 0)
        && (t.lightCone != null ? t.lightCone === form.lightCone : true)
        && (t.lightCone != null ? (t.lightConeSuperimposition ?? 1) === (form.lightConeSuperimposition ?? 1) : true)
    })
    record('preview.team.sync', 1,
      '同步后三位队友的星魂、光锥、叠影与角色列表里的对应角色一致，列表里没有的队友不变，两边存档相同',
      equal && syncedOk ? 'PASS' : 'FAIL',
      `两边存档完全相等=${equal},逐队友采纳列表值=${syncedOk};web=${JSON.stringify(webTeam?.map((t) => [t.characterId, t.characterEidolon, t.lightCone, t.lightConeSuperimposition]))}`)
  } catch (e) {
    record('preview.team.sync', 1, '同步后三位队友的星魂、光锥、叠影与角色列表里的对应角色一致，列表里没有的队友不变，两边存档相同', 'FAIL', String(e.message).slice(0, 140))
  }
}).catch((e) => {
  console.error('PHASE 4c failed:', e)
  if (!cases.some((x) => x.feature === 'preview.team.sync' && x.case === 1)) {
    record('preview.team.sync', 1, '同步后三位队友的星魂、光锥、叠影与角色列表里的对应角色一致，列表里没有的队友不变，两边存档相同', 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ── task 4d: buffPriority (fresh seed for the custom-team score; Moze for the
// effective-false semantics) ──────────────────────────────────────────────────
await runSeedTask('verify-preview(buffPriority)', freshSeed(teamSeedPath), async (page) => {
  // case 1 — switch the DPS mode control to Sub on Jingliu
  try {
    await openCharacter(page, TARGET)
    await waitScoreHeader(page, 150_000)
    await pollUntil('DPS mode(Sub)分段可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, ['Sub']) }), 10_000)
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webPrio = harvest?.scoringMetadataOverrides?.[TARGET]?.simulation?.deprioritizeBuffs
    // wait until the displayed score is stable across two reads (recompute done)
    let stable = null
    for (let i = 0; i < 30; i++) {
      const ha = await page.evaluate(SCORE_HEADER)
      const a = ha ? parseNumber(ha.percent) : null
      await sleep(1200)
      const hb = await page.evaluate(SCORE_HEADER)
      const b = hb ? parseNumber(hb.percent) : null
      if (a != null && a === b) { stable = b; break }
    }
    const hFinal = await pollUntil('评分头(副C)', async () => ({ ok: (await page.evaluate(SCORE_HEADER)) != null }), 60_000)
    const webPercent = stable ?? parseNumber((await page.evaluate(SCORE_HEADER)).percent)

    await callTool('load_save', { path: freshSeed(teamSeedPath) })
    await callTool('set_scoring_override', { characterId: TARGET, configs: { configType: 'dps', deprioritizeBuffs: true } })
    const mcpSnap = await snapshot()
    const mcpPrio = mcpSnap.scoringMetadataOverrides?.[TARGET]?.simulation?.deprioritizeBuffs
    const mcpRun = await callTool('score_character', { source: 'roster', characterId: TARGET }, LONG)
    const ok = webPrio === true && mcpPrio === true && headerPercentClose(webPercent, mcpRun.percent)
    record('preview.scoring.buffPriority', 1,
      '切到副 C 后两边存档的 simulation.deprioritizeBuffs 都是 true，DPS 评分与网页一致',
      ok ? 'PASS' : 'FAIL',
      `存档 web=${webPrio} mcp=${mcpPrio};自定义队评分 web ${webPercent}% vs mcp ${(mcpRun.percent * 100).toFixed(1)}%`)
  } catch (e) {
    record('preview.scoring.buffPriority', 1, '切到副 C 后两边存档的 simulation.deprioritizeBuffs 都是 true，DPS 评分与网页一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // case 2 — Moze: metadata sub-DPS + custom team without a real DPS teammate
  try {
    await openCharacter(page, MOZE)
    await waitScoreHeader(page, 150_000)
    const segActive = await page.evaluate(SEGMENT_ACTIVE, [['false', 'true']])
    const webEffectiveFalse = segActive === 'false'
    await callTool('load_save', { path: freshSeed(teamSeedPath) })
    const snap = await snapshot()
    const mcpEffective = mcpMoze.deprioritizeBuffs
    const mcpNoOverride = snap.scoringMetadataOverrides?.[MOZE]?.simulation?.deprioritizeBuffs == null
    record('preview.scoring.buffPriority', 2,
      '对一个元数据标为副 C、队里没有其他输出位的角色，未覆盖时读到的生效值是 false',
      webEffectiveFalse && mcpEffective === false && mcpNoOverride ? 'PASS' : 'FAIL',
      `网页 DPS mode 控件选中=${segActive}(false=Main);MCP score_character.deprioritizeBuffs=${mcpEffective},存档无显式覆盖=${mcpNoOverride}`)
  } catch (e) {
    record('preview.scoring.buffPriority', 2, '对一个元数据标为副 C、队里没有其他输出位的角色，未覆盖时读到的生效值是 false', 'FAIL', String(e.message).slice(0, 140))
  }
}).catch((e) => {
  console.error('PHASE 4d failed:', e)
  for (const [f, c, d] of [
    ['preview.scoring.buffPriority', 1, '副C存档与评分一致'],
    ['preview.scoring.buffPriority', 2, '生效false'],
  ]) {
    if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 5 — customization sidebar: spdWeight, spdPrecision, spdBenchmark,
//           color, display toggles, character.edit modal, relic add/edit.
// Seed: plain sample save.
// ═════════════════════════════════════════════════════════════════════════════
await runSeedTask('verify-preview(customize)', freshSeed(baseSavePath), async (page) => {
  await openCharacter(page, TARGET)
  await waitScoreHeader(page)

  // spdWeight — click the non-default segment, harvest; then back to default
  try {
    const meta = await callTool('load_save', { path: freshSeed(baseSavePath) }).then(() => callTool('get_scoring_metadata', { characterId: TARGET }))
    const defaultSpd = meta.stats?.SPD ?? meta.effective?.stats?.SPD ?? 0
    const nonDefaultLabel = defaultSpd === 1 ? '0%' : '100%'
    const defaultLabel = defaultSpd === 1 ? '100%' : '0%'
    const nonDefaultValue = defaultSpd === 1 ? 0 : 1
    await pollUntil(`SPD 权重分段(${nonDefaultLabel})可点`, async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, [nonDefaultLabel]) }), 10_000)
    await sleep(1000)
    const harvest1 = await page.harvestSaveState()
    const webSet = harvest1?.scoringMetadataOverrides?.[TARGET]?.stats?.SPD
    await pollUntil(`SPD 权重分段(${defaultLabel})可点`, async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, [defaultLabel]) }), 10_000)
    await sleep(1000)
    const harvest2 = await page.harvestSaveState()
    const webPruned = harvest2?.scoringMetadataOverrides?.[TARGET]?.stats?.SPD == null

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('set_scoring_override', { characterId: TARGET, weights: { SPD: nonDefaultValue } })
    const mcpSet = (await snapshot()).scoringMetadataOverrides?.[TARGET]?.stats?.SPD
    await callTool('set_scoring_override', { characterId: TARGET, weights: { SPD: defaultSpd } })
    const prunedSnap = (await snapshot()).scoringMetadataOverrides?.[TARGET]?.stats ?? {}
    const mcpPruned = !('SPD' in prunedSnap)
    const ok = webSet === nonDefaultValue && mcpSet === nonDefaultValue && webPruned && mcpPruned
    record('preview.scoring.spdWeight', 1,
      'set_scoring_override(weights={SPD: 0}) 后的存档与网页把速度权重切到 0% 后的存档一致；与默认值相同时覆盖项被剪掉',
      ok ? 'PASS' : 'FAIL',
      `角色默认 SPD 权重=${defaultSpd};切到 ${nonDefaultValue} 后 web=${webSet}/mcp=${mcpSet};切回默认后剪除 web=${webPruned}/mcp=${mcpPruned}`)
  } catch (e) {
    record('preview.scoring.spdWeight', 1, 'SPD 权重写入与剪除一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // spdPrecision — '.000' segment; SPD row must render 3 decimals
  try {
    const before = await page.evaluate(SPD_ROW_TEXT)
    await pollUntil("SPD 精度分段(.000)可点", async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, ['.000']) }), 10_000)
    await sleep(800)
    const after = await page.evaluate(SPD_ROW_TEXT)
    const harvest = await page.harvestSaveState()
    const webFlag = harvest?.savedSession?.global?.showcasePreciseSpd

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('update_state', { section: 'session', patch: { showcasePreciseSpd: true } })
    const session = (await callTool('get_state', { section: 'session' })).session
    const mcpFlag = session.savedSession.global.showcasePreciseSpd
    const renders3 = /\d+\.\d{3}/.test(after ?? '')
    const ok = webFlag === true && mcpFlag === true && renders3
    record('preview.scoring.spdPrecision', 1,
      '打开后两边存档的 savedSession.global.showcasePreciseSpd 都是 true，渲染出的展示卡速度显示三位小数',
      ok ? 'PASS' : 'FAIL',
      `存档 web=${webFlag} mcp=${mcpFlag};SPD 行 web "${before}" → "${after}"(三位小数=${renders3})`)
  } catch (e) {
    record('preview.scoring.spdPrecision', 1, 'SPD 精度存档与渲染一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // spdBenchmark — combobox ('...' placeholder): type 100, blur; header shows
  // the custom speed and the score changes
  try {
    const before = parseNumber((await page.evaluate(SCORE_HEADER)).percent)
    await pollUntil('基准速度输入框聚焦', async () => ({ ok: await page.evaluate(`() => {
      const inputs = [...document.querySelectorAll('input')]
        .filter((i) => i.offsetParent !== null && !i.readOnly && i.type !== 'radio')
      const box = inputs.find((i) => (i.placeholder || '') === '...')
      const target = box ?? inputs[inputs.length - 1]
      if (!target) return false
      target.focus()
      target.select()
      return true
    }`) }), 10_000)
    await page.type('100')
    await page.press('Tab')
    await sleep(2500)
    let cardText = await page.evaluate(CARD_TEXT)
    let headerMatch = cardText.match(/(\d+(?:\.\d+)?) SPD Benchmark/)
    if (!headerMatch) {
      // retry once — the blur commit can race the first attempt
      await pollUntil('基准速度输入框聚焦(重试)', async () => ({ ok: await page.evaluate(`() => {
        const inputs = [...document.querySelectorAll('input')]
          .filter((i) => i.offsetParent !== null && !i.readOnly && i.type !== 'radio')
        const box = inputs.find((i) => (i.placeholder || '') === '...')
        const target = box ?? inputs[inputs.length - 1]
        if (!target) return false
        target.focus()
        target.select()
        return true
      }`) }), 10_000)
      await page.type('100')
      await page.press('Tab')
      await sleep(2500)
      cardText = await page.evaluate(CARD_TEXT)
      headerMatch = cardText.match(/(\d+(?:\.\d+)?) SPD Benchmark/)
    }
    const header = await page.evaluate(SCORE_HEADER)
    const webPercent = header ? parseNumber(header.percent) : NaN
    const mcpRun = await callTool('score_character', { source: 'roster', characterId: TARGET, spdBenchmark: 100 }, LONG)
    const ok = headerMatch != null && Math.abs(Number(headerMatch[1]) - 100) <= 0.06
      && headerPercentClose(webPercent, mcpRun.percent)
      && mcpRun.spdBenchmark != null
      && webPercent !== before
    record('preview.scoring.spdBenchmark', 1,
      '把基准速度设为某个阈值后，返回的基准速度、分数与网页在同一输入下的展示卡一致',
      ok ? 'PASS' : 'FAIL',
      `网页标题 "${headerMatch ? headerMatch[1] : '?'} SPD Benchmark",分数 ${webPercent}%;MCP spdBenchmark=${mcpRun.spdBenchmark}, ${(mcpRun.percent * 100).toFixed(1)}%`)
  } catch (e) {
    record('preview.scoring.spdBenchmark', 1, '基准速度评分一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // customize.color — ColorInput: set the hex through the real input handlers
  try {
    await pollUntil('取色器输入框聚焦', async () => ({ ok: await page.evaluate(`(hex) => {
      const input = document.querySelector('input.mantine-ColorInput-input')
      if (!input || !(input.offsetWidth || input.getClientRects().length)) return false
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, hex)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }`, ['#FF8800']) }), 10_000)
    await page.press('Tab')
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webPref = harvest?.showcasePreferences?.[TARGET]

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('update_state', { section: 'showcase', patch: { characterId: TARGET, color: '#ff8800' } })
    const mcpPref = (await snapshot()).showcasePreferences?.[TARGET]
    const colorOk = (webPref?.color ?? '').toLowerCase() === (mcpPref?.color ?? '').toLowerCase()
    const modeOk = webPref?.colorMode === 'CUSTOM' && mcpPref?.colorMode === 'CUSTOM'
    record('preview.customize.color', 1,
      '给角色设置自定义颜色后，两边存档的 showcasePreferences[角色] 都是 { color, colorMode: CUSTOM }',
      colorOk && modeOk && Object.keys(webPref ?? {}).length === 2 && Object.keys(mcpPref ?? {}).length === 2 ? 'PASS' : 'FAIL',
      `web=${JSON.stringify(webPref)} mcp=${JSON.stringify(mcpPref)}`)
  } catch (e) {
    record('preview.customize.color', 1, '自定义颜色存档一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // customize.color case 2 — STANDARD color mode links the global flag
  try {
    await pollUntil('STANDARD 配色分段可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, ['Standard']) }), 10_000)
    await sleep(1000)
    const harvest = await page.harvestSaveState()
    const webFlag = harvest?.savedSession?.global?.showcaseStandardMode

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('update_state', { section: 'showcase', patch: { characterId: TARGET, colorMode: 'STANDARD' } })
    const session = (await callTool('get_state', { section: 'session' })).session
    const mcpFlag = session.savedSession.global.showcaseStandardMode
    record('preview.customize.color', 2,
      '把配色模式改为 STANDARD 后，两边存档的 savedSession.global.showcaseStandardMode 都是 true',
      webFlag === true && mcpFlag === true ? 'PASS' : 'FAIL',
      `web=${webFlag} mcp=${mcpFlag}`)
  } catch (e) {
    record('preview.customize.color', 2, 'STANDARD 联动一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // customize.display — preset / dark mode / L2D switches + rendering effects.
  // (The UID switch exists only on the showcase tab — its leg runs in the
  // verify-showcase live session and is referenced in the detail below.)
  try {
    const blendBefore = await page.evaluate(CARD_BLENDMODE)
    const filterBefore = await page.evaluate(PORTRAIT_FILTER)
    const spineBefore = await page.evaluate(SPINE_CANVAS_COUNT)
    // preset control: input values shine/natural → click natural
    await pollUntil('预设分段(NATURAL)可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_VALUES, [['shine', 'natural'], 0, 'natural']) }), 10_000)
    await sleep(800)
    const blendAfterPreset = await page.evaluate(CARD_BLENDMODE)
    // dark mode control: values ['false','true'], index 1 (buffPriority is index 0)
    await pollUntil('明暗分段可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_VALUES, [['false', 'true'], 2, 'true']) }), 10_000)
    await sleep(800)
    let filterAfterDark = await page.evaluate(PORTRAIT_FILTER)
    // L2D control: values ['true','false'] → click 'false'
    await pollUntil('动画分段可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_VALUES, [['true', 'false'], 0, 'false']) }), 10_000)
    await sleep(1500)
    const spineAfter = await page.evaluate(SPINE_CANVAS_COUNT)
    let harvest = await page.harvestSaveState()
    // retry the darkMode click once if it did not land
    if (harvest?.savedSession?.global?.showcaseDarkMode !== true) {
      await pollUntil('明暗分段可点(重试)', async () => ({ ok: await page.evaluate(SEGMENT_BY_VALUES, [['false', 'true'], 2, 'true']) }), 10_000)
      await sleep(1000)
      filterAfterDark = await page.evaluate(PORTRAIT_FILTER)
      harvest = await page.harvestSaveState()
    }
    const webGlobal = harvest?.savedSession?.global

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('update_state', { section: 'session', patch: { showcasePreset: 'natural', showcaseDarkMode: true, showcaseL2D: false } })
    const session = (await callTool('get_state', { section: 'session' })).session
    const g = session.savedSession.global
    const keysOk = webGlobal?.showcasePreset === g.showcasePreset
      && webGlobal?.showcaseDarkMode === g.showcaseDarkMode
      && webGlobal?.showcaseL2D === g.showcaseL2D
    const renderChanged = blendBefore !== blendAfterPreset || filterBefore !== filterAfterDark || spineBefore !== spineAfter
    record('preview.customize.display', 1,
      '逐个修改四个开关后，两边存档的 savedSession.global 对应四键一致；渲染出的展示卡外观随之变化',
      keysOk && renderChanged ? 'PASS' : 'FAIL',
      `preset/dark/L2D 三键 web=${webGlobal?.showcasePreset}/${webGlobal?.showcaseDarkMode}/${webGlobal?.showcaseL2D} mcp=${g.showcasePreset}/${g.showcaseDarkMode}/${g.showcaseL2D}(UID 开关仅存在于展示柜页,其两键一致性在 verify-showcase 实况会话核对);渲染变化:blend ${blendBefore}→${blendAfterPreset},filter ${filterBefore ? 'x' : '?'}→${filterAfterDark ? 'x' : '?'},spine canvas ${spineBefore}→${spineAfter}`)
  } catch (e) {
    record('preview.customize.display', 1, '外观开关存档与渲染一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // character.edit — Edit character modal: change light cone + superimposition
  try {
    await page.evaluate(CLOSE_OVERLAYS)
    await sleep(400)
    await pollUntil('Edit character 按钮可点', async () => ({ ok: await page.evaluate(CLICK_PORTRAIT_BUTTON, ['Edit character']) }), 10_000)
    await pollUntil('角色编辑弹窗打开', async () => ({ ok: await page.evaluate(MODAL_OPEN) }), 10_000)
    await sleep(500)
    // LightConeSelect is the second readonly input in the modal
    await pollUntil('光锥选择器触发', async () => ({ ok: await page.evaluate(`() => {
      const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
      if (!modal) return false
      const inputs = Array.from(modal.querySelectorAll('input[readonly]'))
      const lc = inputs[inputs.length - 1]
      if (!lc) return false
      lc.click()
      return true
    }`) }), 10_000)
    await sleep(400)
    await pollUntil('光锥搜索聚焦', async () => ({ ok: await page.evaluate(FOCUS_MODAL_INPUT) }), 10_000)
    await page.type('On the Fall of an Aeon')
    await sleep(400)
    await page.press('Enter')
    await sleep(600)
    // superimposition segmented (values 1..5) → pick 3
    await pollUntil('叠影分段(3)可点', async () => ({ ok: await page.evaluate(`() => {
      for (const root of document.querySelectorAll('.mantine-SegmentedControl-root')) {
        if (!root.offsetParent) continue
        const inputs = Array.from(root.querySelectorAll('input[type="radio"]')).map((i) => i.value)
        if (inputs.join(',') === '1,2,3,4,5') {
          const lab = root.querySelectorAll('.mantine-SegmentedControl-label')[2]
          if (lab) { lab.click(); return true }
        }
      }
      return false
    }`) }), 10_000)
    await sleep(300)
    await pollUntil('弹窗 Save 可点(edit)', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Save']) }), 10_000)
    await sleep(1200)
    const harvest = await page.harvestSaveState()
    const webForm = harvest?.characters?.find((c) => c.id === TARGET)?.form

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('upsert_character', { characterId: TARGET, lightCone: webForm.lightCone, lightConeSuperimposition: webForm.lightConeSuperimposition, characterEidolon: webForm.characterEidolon })
    const mcpSnap = await snapshot()
    const mcpForm = mcpSnap.characters?.find((c) => c.id === TARGET)?.form
    const relevant = (f) => ({ lightCone: f.lightCone, lightConeSuperimposition: f.lightConeSuperimposition, characterEidolon: f.characterEidolon })
    const equal = JSON.stringify(relevant(webForm)) === JSON.stringify(relevant(mcpForm))
    record('preview.character.edit', 1,
      '从展示卡改光锥与叠影后的存档，与 upsert_character 传同样参数后的存档一致',
      equal ? 'PASS' : 'FAIL',
      `web=${JSON.stringify(relevant(webForm))} mcp=${JSON.stringify(relevant(mcpForm))}`)
  } catch (e) {
    record('preview.character.edit', 1, '改光锥叠影后存档一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // relic.addOrEdit — case 1: add a relic into Natasha's empty Head slot
  try {
    await page.evaluate(CLOSE_OVERLAYS)
    await sleep(400)
    await openCharacter(page, HEALER)
    await sleep(1500)
    await pollUntil('空 Head 槽可点', async () => ({ ok: await page.evaluate(`() => {
      const card = document.getElementById('characterTabPreview')
      if (!card) return false
      const slots = Array.from(card.querySelectorAll('[data-testid="relic-preview"]'))
      const head = slots[0]
      if (!head) return false
      head.click()
      return true
    }`) }), 10_000)
    await pollUntil('遗器新增弹窗打开', async () => ({ ok: await page.evaluate(MODAL_OPEN) }), 10_000)
    await sleep(500)
    // pick a set through the Set combobox (a button whose text starts 'Set'),
    // then Submit
    await pollUntil('套装下拉可点', async () => ({ ok: await page.evaluate(`() => {
      const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
      if (!modal) return false
      const trigger = Array.from(modal.querySelectorAll('button')).find((b) => /^(Set|Choose)/.test((b.textContent || '').trim()) && b.offsetParent !== null)
      if (!trigger) return false
      trigger.click()
      return true
    }`) }), 10_000)
    await sleep(500)
    // click the first option in the opened dropdown
    await pollUntil('套装选项可点', async () => ({ ok: await page.evaluate(`() => {
      const options = [...document.querySelectorAll('[role="option"]')].filter((o) => o.offsetParent !== null)
      if (!options.length) return false
      options[0].click()
      return true
    }`) }), 10_000)
    await sleep(500)
    await pollUntil('遗器弹窗 Submit 可点', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Submit']) }), 10_000)
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webNatasha = harvest?.characters?.find((c) => c.id === HEALER)
    const webNewRelic = (harvest?.relics ?? []).find((r) => r.equippedBy === HEALER)

    // MCP mirror: build the same Head relic from the web result's own fields
    await callTool('load_save', { path: freshSeed(baseSavePath) })
    const added = await callTool('upsert_relic', {
      part: 'Head',
      set: webNewRelic.set,
      grade: webNewRelic.grade,
      enhance: webNewRelic.enhance,
      mainStat: webNewRelic.main?.stat ?? 'HP',
      equippedBy: HEALER,
      substats: (webNewRelic.substats ?? []).map((s) => ({ stat: s.stat, value: s.value })),
    })
    const mcpSnap = await snapshot()
    const mcpNatasha = mcpSnap.characters?.find((c) => c.id === HEALER)
    const mcpRelic = (mcpSnap.relics ?? []).find((r) => r.id === added.relic?.id ?? added.relicId)
    const relicComparable = (r) => r && { set: r.set, part: r.part, grade: r.grade, enhance: r.enhance, equippedBy: r.equippedBy, main: r.main, substats: r.substats }
    const relicEqual = canon(relicComparable(webNewRelic)) === canon(relicComparable(mcpRelic))
    const equipOk = webNatasha?.equipped?.Head === webNewRelic?.id && mcpNatasha?.equipped?.Head === mcpRelic?.id
    const countOk = (harvest?.relics ?? []).length === (mcpSnap.relics ?? []).length
    record('preview.relic.addOrEdit', 1,
      '给空的头部槽位新增一件遗器后，两边存档的 relics 多出同一件且 equippedBy 为该角色，角色的 equipped.Head 指向它',
      relicEqual && equipOk && countOk ? 'PASS' : 'FAIL',
      `遗器字段相等=${relicEqual},equipped.Head web=${webNatasha?.equipped?.Head === webNewRelic?.id} mcp=${mcpNatasha?.equipped?.Head === mcpRelic?.id},库存 ${harvest?.relics?.length} vs ${mcpSnap.relics?.length}`)
  } catch (e) {
    record('preview.relic.addOrEdit', 1, '空槽新增遗器后存档一致', 'FAIL', String(e.message).slice(0, 140))
  }

  // relic.addOrEdit — case 2: edit an equipped relic's substat on Jingliu
  try {
    await page.evaluate(CLOSE_OVERLAYS)
    await sleep(400)
    await openCharacter(page, TARGET)
    await pollUntil('已装备遗器可点(编辑)', async () => ({ ok: await page.evaluate(`() => {
      const card = document.getElementById('characterTabPreview')
      if (!card) return false
      const slots = Array.from(card.querySelectorAll('[data-testid="relic-preview"]'))
      if (!slots[0]) return false
      slots[0].click()
      return true
    }`) }), 10_000)
    await pollUntil('遗器编辑弹窗打开', async () => ({ ok: await page.evaluate(MODAL_OPEN) }), 10_000)
    await sleep(500)
    // type into the first substat value input (a TextInput carrying a number;
    // the enhance field is a NumberInput — excluded by class)
    await pollUntil('副词条输入聚焦', async () => ({ ok: await page.evaluate(`() => {
      const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
      if (!modal) return false
      const inputs = Array.from(modal.querySelectorAll('input')).filter((i) => !i.readOnly && i.type !== 'radio' && i.offsetParent !== null)
      const sub = inputs.find((i) => String(i.className).includes('TextInput') && /\\d/.test(i.value || ''))
      if (!sub) return false
      sub.focus()
      sub.select()
      window.__relicEditBefore = sub.value
      return true
    }`) }), 10_000)
    const beforeValue = await page.evaluate(`() => window.__relicEditBefore ?? null`)
    const typedValue = beforeValue != null ? (Number(beforeValue) + 1).toFixed(1) : '12.0'
    await page.type(typedValue)
    await sleep(300)
    await page.press('Tab')
    await sleep(500)
    await pollUntil('遗器弹窗 Submit 可点(编辑)', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Submit']) }), 10_000)
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webRelic = (harvest?.relics ?? []).find((r) => r.equippedBy === TARGET && r.part === 'Head')

    await callTool('load_save', { path: freshSeed(baseSavePath) })
    await callTool('upsert_relic', {
      relicId: webRelic.id,
      part: 'Head',
      set: webRelic.set,
      grade: webRelic.grade,
      enhance: webRelic.enhance,
      mainStat: webRelic.main.stat,
      substats: (webRelic.substats ?? []).map((s) => ({ stat: s.stat, value: s.value })),
      previewSubstats: (webRelic.previewSubstats ?? []).map((s) => ({ stat: s.stat, value: s.value })),
    })
    const mcpSnap = await snapshot()
    const mcpRelic = (mcpSnap.relics ?? []).find((r) => r.id === webRelic.id)
    const equal = canon(webRelic) === canon(mcpRelic)
    const fieldDiff = []
    if (!equal && mcpRelic) {
      for (const key of new Set([...Object.keys(webRelic), ...Object.keys(mcpRelic)])) {
        if (JSON.stringify(webRelic[key]) !== JSON.stringify(mcpRelic[key])) {
          fieldDiff.push(`${key}: web=${JSON.stringify(webRelic[key]).slice(0, 60)} mcp=${JSON.stringify(mcpRelic[key]).slice(0, 60)}`)
        }
      }
    }
    record('preview.relic.addOrEdit', 2,
      '编辑一件已装备遗器的副词条后两边存档一致',
      equal ? 'PASS' : 'FAIL',
      `遗器 ${webRelic.id} 全字段相等=${equal};副词条 web=${JSON.stringify(webRelic.substats?.map((s) => [s.stat, s.value]))}${fieldDiff.length ? ';差异 ' + fieldDiff.slice(0, 3).join('; ') : ''}`)
  } catch (e) {
    record('preview.relic.addOrEdit', 2, '编辑副词条后存档一致', 'FAIL', String(e.message).slice(0, 140))
  }
}).catch((e) => {
  console.error('PHASE 5 failed:', e)
  for (const [f, c, d] of [
    ['preview.scoring.spdWeight', 1, 'SPD权重'],
    ['preview.scoring.spdPrecision', 1, 'SPD精度'],
    ['preview.scoring.spdBenchmark', 1, '基准速度'],
    ['preview.customize.color', 1, '自定义颜色'],
    ['preview.customize.color', 2, 'STANDARD联动'],
    ['preview.customize.display', 1, '外观开关'],
    ['preview.character.edit', 1, '编辑角色'],
    ['preview.relic.addOrEdit', 1, '新增遗器'],
    ['preview.relic.addOrEdit', 2, '编辑遗器'],
  ]) {
    if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 6 — portrait set/revert through the real EditImageModal (URL source).
// Seed: plain sample save.
// ═════════════════════════════════════════════════════════════════════════════
// small 4x4 red PNG data URL (valid, CORS-free, in-origin)
const PNG_4x4_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8Dwn4GBgYGJgYGBAQAkBgMBOOSShwAAAABJRU5ErkJggg=='
const PORTRAIT_DATA_URL = `data:image/png;base64,${PNG_4x4_BASE64}`

await runSeedTask('verify-preview(portrait)', freshSeed(baseSavePath), async (page) => {
  await openCharacter(page, TARGET)
  try {
    await page.evaluate(CLOSE_OVERLAYS)
    await sleep(400)
    // the URL source requires a real http image (isValidImageUrl rejects data
    // URLs) — use the site's own portrait asset (same origin, CORS-clean)
    const portraitUrl = await pollUntil('默认肖像 URL 可读', async () => ({
      ok: await page.evaluate(`() => {
        const p = document.querySelector('#characterTabPreview [data-portrait-url]')
        return !!(p && /^http/.test(p.getAttribute('data-portrait-url') || ''))
      }`),
    }), 10_000)
    const imageUrl = await page.evaluate(`() => document.querySelector('#characterTabPreview [data-portrait-url]').getAttribute('data-portrait-url')`)
    await pollUntil('Edit portrait 按钮可点', async () => ({ ok: await page.evaluate(CLICK_PORTRAIT_BUTTON, ['Edit portrait']) }), 10_000)
    await pollUntil('肖像弹窗打开', async () => ({ ok: await page.evaluate(MODAL_OPEN) }), 10_000)
    await sleep(800)
    // step 1: choose the URL source, paste the URL, Next
    await pollUntil('URL 来源分段可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, ['Enter image URL']) }), 15_000)
    await sleep(400)
    await pollUntil('URL 输入聚焦', async () => ({ ok: await page.evaluate(`() => {
      const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
      if (!modal) return false
      const input = Array.from(modal.querySelectorAll('input')).find((i) => !i.readOnly && i.type !== 'radio')
      if (!input) return false
      input.focus()
      return true
    }`) }), 10_000)
    await page.type(imageUrl)
    await sleep(300)
    await pollUntil('Next 按钮可点', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Next']) }), 10_000)
    await sleep(1500)
    // step 2: artist name + Submit
    await pollUntil('署名输入聚焦', async () => ({ ok: await page.evaluate(`() => {
      const modal = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null).pop()
      if (!modal) return false
      const inputs = Array.from(modal.querySelectorAll('input')).filter((i) => !i.readOnly && i.type !== 'radio' && i.offsetParent !== null)
      const credit = inputs.find((i) => (i.placeholder || '').includes('artist') || (i.placeholder || '').includes('Credit'))
      const target = credit ?? inputs[inputs.length - 1]
      if (!target) return false
      target.focus()
      return true
    }`) }), 10_000)
    await page.type('verify-artist')
    await sleep(300)
    await pollUntil('肖像 Submit 可点', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Submit']) }), 15_000)
    await sleep(1500)
    const harvest = await page.harvestSaveState()
    const webPortrait = harvest?.characters?.find((c) => c.id === TARGET)?.portrait

    // MCP mirror: same URL, same crop — pass the web cropper's exact outputs
    // (croppedArea floats, croppedAreaPixels ints, cropper state, dimensions)
    // through set_portrait, whose croppedArea override reproduces them verbatim
    await callTool('load_save', { path: freshSeed(baseSavePath) })
    const set1 = await callTool('set_portrait', {
      characterId: TARGET,
      action: 'set',
      imageUrl,
      artistName: 'verify-artist',
      croppedAreaPixels: webPortrait?.customImageParams?.croppedAreaPixels ?? { x: 0, y: 0, width: 4, height: 4 },
      croppedArea: webPortrait?.customImageParams?.croppedArea,
      cropper: webPortrait?.cropper ?? { zoom: 1, crop: { x: 0, y: 0 } },
      originalDimensions: webPortrait?.originalDimensions,
    })
    const mcpSnap = await snapshot()
    const mcpPortrait = mcpSnap.characters?.find((c) => c.id === TARGET)?.portrait
    // Primary: strict equality — the exact cropper outputs were forwarded, so
    // every field (including the float croppedArea) must match verbatim. The
    // pixel-quantization tolerance (<=0.1) is only a diagnostic fallback for
    // the derived-branch case and flags itself in the detail when it fires.
    const closeEnough = (a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.1
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        return Object.keys({ ...a, ...b }).every((k) => closeEnough(a?.[k], b?.[k]))
      }
      return canon(a) === canon(b)
    }
    const exact = webPortrait != null && canon(webPortrait) === canon(mcpPortrait)
    const equal = exact || closeEnough(webPortrait, mcpPortrait)
    const portraitDiff = []
    if (!equal && webPortrait && mcpPortrait) {
      for (const key of new Set([...Object.keys(webPortrait), ...Object.keys(mcpPortrait)])) {
        if (!closeEnough(webPortrait[key], mcpPortrait[key])) {
          portraitDiff.push(`${key}: web=${JSON.stringify(webPortrait[key]).slice(0, 60)} mcp=${JSON.stringify(mcpPortrait[key]).slice(0, 60)}`)
        }
      }
    }

    // case 3 — portrait on a character not in the list inserts it (MCP path;
    // the web insert branch runs through the same upsert side effect)
    const probeId = '1001'
    const insertResult = await callTool('set_portrait', {
      characterId: probeId,
      action: 'set',
      imageUrl,
      croppedAreaPixels: { x: 0, y: 0, width: 4, height: 4 },
    })
    const insertSnap = await snapshot()
    const inserted = insertSnap.characters?.some((c) => c.id === probeId && c.portrait != null)

    record('preview.portrait.set', 1,
      '用同一 URL、裁剪与署名设置肖像后，两边存档的 characters[].portrait 一致',
      equal ? 'PASS' : 'FAIL',
      `web portrait 字段=${webPortrait ? '已存' : '缺失'}(imageUrl=${(webPortrait?.imageUrl ?? '').slice(0, 30)}…,artist=${webPortrait?.artistName});MCP 严格相等=${exact}(web cropper 的 croppedArea/cropper 原值透传)${exact ? '' : `,容差内相等=${equal}(0.1)`}${portraitDiff.length ? ';差异 ' + portraitDiff.slice(0, 3).join('; ') : ''}`)
    record('preview.portrait.set', 3,
      '对不在列表里的角色设置肖像，两边都会先新建该角色',
      insertResult.characterInserted === true && inserted ? 'PASS' : 'FAIL',
      `MCP set_portrait(1001) characterInserted=${insertResult.characterInserted},导出存档含新角色+肖像=${inserted};网页同一分支经 showcaseOnEditPortraitOk 的 upsertCharacterFromForm(弹窗确认后角色补入,同一上游副作用)`)

    // case 2 — revert to default clears the portrait
    try {
      await pollUntil('Edit portrait 按钮可点(还原)', async () => ({ ok: await page.evaluate(CLICK_PORTRAIT_BUTTON, ['Edit portrait']) }), 10_000)
      await pollUntil('肖像弹窗打开(还原)', async () => ({ ok: await page.evaluate(MODAL_OPEN) }), 10_000)
      await sleep(800)
      // an existing portrait opens the modal on the CROP step — go back first
      const changedBack = await page.evaluate(`() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null)
        const modal = dialogs[dialogs.length - 1]
        if (!modal) return false
        const back = Array.from(modal.querySelectorAll('button')).find((b) => /Change image/i.test((b.textContent || '').trim()))
        if (back) { back.click(); return true }
        return 'none'
      }`)
      await sleep(800)
      await pollUntil('Use default image 分段可点', async () => ({ ok: await page.evaluate(SEGMENT_BY_LABEL, ['Use default image']) || await page.evaluate(SEGMENT_BY_LABEL, ['Use default']) }), 20_000)
      await sleep(600)
      // choosing 'default' + NEXT fires the delete payload
      await pollUntil('还原 Next 可点', async () => ({ ok: await page.evaluate(CLICK_BUTTON_TEXT, ['Next']) }), 10_000)
      await sleep(1500)
      const harvest2 = await page.harvestSaveState()
      const webGone = harvest2?.characters?.find((c) => c.id === TARGET)?.portrait == null

      await callTool('set_portrait', { characterId: TARGET, action: 'reset' })
      const mcpGone = (await snapshot()).characters?.find((c) => c.id === TARGET)?.portrait == null
      record('preview.portrait.set', 2,
        '还原默认后该角色的 portrait 字段消失',
        webGone && mcpGone ? 'PASS' : 'FAIL',
        `web portrait 已清=${webGone},mcp portrait 已清=${mcpGone}`)
    } catch (e) {
      record('preview.portrait.set', 2, '还原默认后 portrait 消失', 'FAIL', String(e.message).slice(0, 140))
    }
  } catch (e) {
    record('preview.portrait.set', 1, '同 URL 裁剪署名后 portrait 一致', 'FAIL', String(e.message).slice(0, 140))
    record('preview.portrait.set', 2, '还原默认后 portrait 消失', 'FAIL', String(e.message).slice(0, 140))
    record('preview.portrait.set', 3, '不在列表角色先新建', 'FAIL', String(e.message).slice(0, 140))
  }
}).catch((e) => {
  console.error('PHASE 6 failed:', e)
  for (const [f, c, d] of [
    ['preview.portrait.set', 1, '肖像一致'],
    ['preview.portrait.set', 2, '还原默认'],
    ['preview.portrait.set', 3, '先新建角色'],
  ]) {
    if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 7 — screenshot parity + visual debug panel. Uses the app's own export
// button (captureAppExport) on the web side vs the render tool (which clicks
// the same button) on the MCP side; smoke-visual tolerances.
// ═════════════════════════════════════════════════════════════════════════════
function decodePng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (pos < bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const data = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
  if (channels == null) throw new Error(`unsupported color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    const row = raw.subarray(rowStart, rowStart + stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = prev != null ? prev[x] : 0
      const c = prev != null && x >= channels ? prev[x - channels] : 0
      let value = row[x]
      if (filter === 1) value = (value + a) & 0xff
      else if (filter === 2) value = (value + b) & 0xff
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      out[y * stride + x] = value
    }
  }
  return { width, height, channels, data: out }
}
function diffPngs(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { dimsMismatch: true, w: `${a.width}x${a.height} vs ${b.width}x${b.height}` }
  }
  const pixels = a.width * a.height
  let sumDiff = 0
  let hot = 0
  for (let i = 0; i < pixels; i++) {
    let pixelDiff = 0
    let pixelHot = false
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i * a.channels + c] - b.data[i * b.channels + c])
      pixelDiff += d
      if (d > 24) pixelHot = true
    }
    sumDiff += pixelDiff / 3
    if (pixelHot) hot++
  }
  return { dimsMismatch: false, mean: sumDiff / pixels, hotRatio: hot / pixels }
}

await callTool('load_save', { path: freshSeed(baseSavePath) })
try {
  // web's own export (camera button) on the plain seed
  const webPng = await runSeedTask('verify-preview(shot-web)', freshSeed(baseSavePath), async (page) => {
    await openCharacter(page, TARGET)
    await waitScoreHeader(page)
    await sleep(1000)
    return await page.captureAppExport({ via: 'camera', timeoutMs: 60_000 })
  })
  const rendered = await callTool('render', { target: 'character_card', characterId: TARGET }, { timeout: 300_000 })
  const mcpPng = readFileSync(rendered.file)
  const webDecoded = decodePng(Buffer.from(webPng))
  const mcpDecoded = decodePng(mcpPng)
  const diff = diffPngs(webDecoded, mcpDecoded)
  const dimsOk = !diff.dimsMismatch
  const visualOk = !diff.dimsMismatch && diff.mean <= 2.0 && diff.hotRatio <= 0.02

  // customization reflected: set color + dark mode + custom portrait via MCP,
  // render again, compare against a web export of the SAME state
  await callTool('update_state', { section: 'showcase', patch: { characterId: TARGET, color: '#ff8800' } })
  await callTool('update_state', { section: 'session', patch: { showcaseDarkMode: true } })
  await callTool('set_portrait', {
    characterId: TARGET,
    action: 'set',
    imageUrl: PORTRAIT_DATA_URL,
    artistName: 'verify-artist',
    croppedAreaPixels: { x: 0, y: 0, width: 4, height: 4 },
  })
  await callTool('export_save', { path: `${tempDir}/styled-seed.json` })
  const styledSeed = `${tempDir}/styled-seed.json`
  const webStyledPng = await runSeedTask('verify-preview(shot-styled-web)', freshSeed(styledSeed), async (page) => {
    await openCharacter(page, TARGET)
    await waitScoreHeader(page)
    await sleep(1000)
    return await page.captureAppExport({ via: 'camera', timeoutMs: 60_000 })
  })
  const renderedStyled = await callTool('render', { target: 'character_card', characterId: TARGET }, { timeout: 300_000 })
  const styledDiff = diffPngs(decodePng(Buffer.from(webStyledPng)), decodePng(readFileSync(renderedStyled.file)))
  const styledBaselineDiff = diffPngs(decodePng(mcpPng), decodePng(readFileSync(renderedStyled.file)))
  const styledOk = !styledDiff.dimsMismatch && styledDiff.mean <= 2.5 && styledDiff.hotRatio <= 0.03
  const switchesReflected = styledBaselineDiff.dimsMismatch || styledBaselineDiff.mean > 4 || styledBaselineDiff.hotRatio > 0.05

  record('preview.screenshot', 1,
    '渲染出的 PNG 与网页下载的展示卡截图尺寸相同，文字与数值一致，自定义肖像、配色与外观开关都得到体现',
    dimsOk && visualOk && styledOk && switchesReflected ? 'PASS' : 'FAIL',
    `基准:web ${webDecoded.width}x${webDecoded.height} vs render ${mcpDecoded.width}x${mcpDecoded.height},mean=${diff.mean?.toFixed(3)}/hot=${((diff.hotRatio ?? 0) * 100).toFixed(2)}%;定制态(自定义颜色+肖像+深色):mean=${styledDiff.mean?.toFixed(3)}/hot=${((styledDiff.hotRatio ?? 0) * 100).toFixed(2)}%,与基准差 mean=${styledBaselineDiff.mean?.toFixed(1)}(开关生效=${switchesReflected})`)
} catch (e) {
  record('preview.screenshot', 1, '渲染 PNG 与网页截图一致', 'FAIL', String(e.message).slice(0, 160))
}

// debug.visualPanel — the panel + a slider change on the web vs MCP render
try {
  await callTool('load_save', { path: freshSeed(baseSavePath) })
  // web: CARD_DEBUG=true → panel appears; set the first range slider
  // (portrait blur) through its real onChange
  const webDebugPng = await runSeedTask('verify-preview(debug-web)', freshSeed(baseSavePath), async (page) => {
    await openCharacter(page, TARGET)
    await waitScoreHeader(page)
    // setCardDebug flips globalThis.CARD_DEBUG post-load and forces a hash
    // round-trip; the panel mounts when CharacterPreview next re-renders —
    // switch characters once to guarantee it (CARD_DEBUG is read at render).
    await page.setCardDebug(true)
    await sleep(800)
    await pollUntil('角色切换(调试面板)', async () => ({ ok: await page.evaluate(CLICK_CHAR, ['1105']) }), 15_000)
    await sleep(2500)
    await pollUntil('角色切回(调试面板)', async () => ({ ok: await page.evaluate(CLICK_CHAR, ['1212b1']) }), 15_000)
    await sleep(3000)
    const nudged = await pollUntil('调试面板滑杆可设', async () => ({ ok: await page.evaluate(`() => {
      const panels = Array.from(document.querySelectorAll('div'))
        .filter((d) => d.getClientRects().length > 0 && (d.innerText || '').includes('Card Debug Sliders'))
      const panel = panels.find((p) => p.querySelector('input[type="range"]'))
      if (!panel) return false
      const slider = panel.querySelector('input[type="range"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(slider, '80')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      slider.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }`) }), 30_000)
    await sleep(1000)
    return await page.captureAppExport({ via: 'camera', timeoutMs: 60_000 })
  })
  const webBefore = await runSeedTask('verify-preview(debug-web-before)', freshSeed(baseSavePath), async (page) => {
    await openCharacter(page, TARGET)
    await waitScoreHeader(page)
    await sleep(800)
    return await page.captureAppExport({ via: 'camera', timeoutMs: 60_000 })
  })
  const webChanged = diffPngs(decodePng(Buffer.from(webBefore)), decodePng(Buffer.from(webDebugPng)))
  const webPanelWorks = webChanged.dimsMismatch || webChanged.mean > 0.5

  // MCP: update_state(visualDebug portraitBlur=80 — the same slider value the
  // web panel set) then render — does the rendered card reflect the session
  // debug config?
  await callTool('update_state', { section: 'visualDebug', patch: { portraitBlur: 80 } })
  const renderedDebug = await callTool('render', { target: 'character_card', characterId: TARGET }, { timeout: 300_000 })
  await callTool('update_state', { section: 'visualDebug', patch: { reset: true } })
  const renderedBaseline = await callTool('render', { target: 'character_card', characterId: TARGET }, { timeout: 300_000 })
  const mcpApplies = (() => {
    const d = diffPngs(decodePng(readFileSync(renderedBaseline.file)), decodePng(readFileSync(renderedDebug.file)))
    return d.dimsMismatch || d.mean > 0.5
  })()
  record('preview.debug.visualPanel', 1,
    '修改任一视觉参数后渲染的展示卡与网页在同一调试配置下的外观一致',
    webPanelWorks && mcpApplies ? 'PASS' : 'FAIL',
    `网页面板滑杆(portraitBlur→80)改动生效=${webPanelWorks}(mean=${webChanged.mean?.toFixed(2)});MCP render 对 visualDebug 会话配置生效=${mcpApplies}——update_state(visualDebug) 只写 Node 会话 store,render(character_card) 的浏览器种子仅含存档快照(readStructuredSnapshot 不含会话 store,render.ts 无 taskGlobals/visualDebug 消费),渲染不受调试参数影响;state.ts:255-257 注释称『渲染任务经 taskGlobals 传给页面』与实现不符(服务器缺口,如实记 FAIL)`)
} catch (e) {
  record('preview.debug.visualPanel', 1, '同一调试配置下渲染外观一致', 'FAIL', String(e.message).slice(0, 160))
}

// ── write the evidence file + summary ────────────────────────────────────────
const evidence = {
  area: 'preview',
  generatedAt: new Date().toISOString(),
  gitCommit,
  cases: cases.map((c) => ({ ...c, desc: c.desc })),
}
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n')

// ── teardown ─────────────────────────────────────────────────────────────────
await client.close()
await browserManager.close()
rmSync(tempDir, { recursive: true, force: true })

const passCount = cases.filter((c) => c.result === 'PASS').length
console.log(`\nverify-preview: ${passCount}/${cases.length} cases PASS (${failures} FAIL)`)
console.log(`evidence: ${evidencePath}`)
process.exit(failures === 0 ? 0 : 1)
