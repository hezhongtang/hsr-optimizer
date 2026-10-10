// verified-acceptance parity harness for the GLOBAL domain (coverage/features/global.json).
//
// Walks every scope=baseline acceptance case of the global area and records a
// reproducible PASS/FAIL verdict per case (PROTOCOL.md §产出物). Methods:
//   - browser-parity: one managed-browser session drives the REAL site build
//     (repo dist/, seeded localStorage['state'] = sample save copy, language
//     preset via localStorage['i18nextLng'] + reload — smoke-browser.mjs /
//     smoke-m8.mjs patterns); the MCP side runs the same input through stdio
//     tools over StdioClientTransport; values are compared field-by-field.
//   - inprocess-parity: MCP stdio results vs mirrors parsed straight out of
//     the upstream sources (PageToHash/HashToPage, SettingOptions/
//     DefaultSettingOptions) or vs the MCP-side SaveState.save() snapshot —
//     parity.mjs (b)/(e) heritage.
//
// Destructive scenarios (reset_all wipe guard, process restart, sample load)
// each get a FRESH mkdtempSync sub-directory and a dedicated server process;
// the repo's src/data/sample-save.json is only ever read through a temp copy.
// Existing smoke assertions are cited alongside (method C, auxiliary only).
//
// The run writes mcp/coverage/evidence/global.json (one row per case).
//
// Usage: node scripts/verify-global.mjs [--keep]   (from mcp/ or repo root)
//   --keep  keep the temp workspace when cases fail (default: always cleaned)

import {
  spawnSync,
} from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
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
const repoRoot = resolve(mcpDir, '..')
const serverEntry = resolve(mcpDir, 'dist/index.js')
const repoSampleSavePath = resolve(repoRoot, 'src/data/sample-save.json')
const navConstantsPath = resolve(repoRoot, 'src/lib/tabs/navigation/constants.ts')
const calculatorPanelsPath = resolve(repoRoot, 'src/lib/tabs/tabCalculators/calculatorPanels.ts')
const settingsConstantsPath = resolve(repoRoot, 'src/lib/constants/settingsConstants.ts')
const featuresPath = resolve(mcpDir, 'coverage/features/global.json')
const evidencePath = resolve(mcpDir, 'coverage/evidence/global.json')

const keepOnFailure = process.argv.includes('--keep')
const tempRoot = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-global-`)

let gitCommit = '8ac1d045'
try {
  gitCommit = String(spawnSync('git', ['-C', repoRoot, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).stdout).trim().slice(0, 8) || gitCommit
} catch { /* keep the pinned commit */ }

// ── case registry (desc pulled from the feature inventory at runtime) ────────

const CASES = [
  { feature: 'global.state.bootLoad', no: 1, method: 'browser-parity' },
  { feature: 'global.state.bootLoad', no: 2, method: 'inprocess-parity' },
  { feature: 'global.state.autosave', no: 1, method: 'inprocess-parity' },
  { feature: 'global.state.autosave', no: 2, method: 'inprocess-parity' },
  { feature: 'global.navigate.page', no: 1, method: 'inprocess-parity' },
  { feature: 'global.navigate.page', no: 2, method: 'browser-parity' },
  { feature: 'global.sidebar.collapse', no: 1, method: 'browser-parity' },
  { feature: 'global.settings.update', no: 1, method: 'inprocess-parity' },
  { feature: 'global.settings.update', no: 2, method: 'browser-parity' },
  { feature: 'global.settings.update', no: 3, method: 'inprocess-parity' },
  { feature: 'global.language.switch', no: 1, method: 'browser-parity' },
  { feature: 'global.language.switch', no: 2, method: 'browser-parity' },
  { feature: 'global.gettingStarted.loadSample', no: 1, method: 'browser-parity' },
  { feature: 'global.links.external', no: 1, method: 'browser-parity' },
  { feature: 'global.links.external', no: 2, method: 'inprocess-parity' },
  { feature: 'global.changelog.whatsNew', no: 1, method: 'inprocess-parity' },
  { feature: 'global.changelog.whatsNew', no: 2, method: 'browser-parity' },
  { feature: 'global.newFeature.badges', no: 1, method: 'browser-parity' },
]

const featureInventory = JSON.parse(readFileSync(featuresPath, 'utf8'))
const descOf = (featureId, no) => {
  const row = featureInventory.features.find((f) => f.id === featureId)
  return (row?.acceptance.cases[no - 1] ?? '').slice(0, 40)
}

const results = new Map() // `${feature}#${no}` -> { pass, details[] }
let failures = 0

/** Multiple trackers may feed one case (MCP side + browser side): they merge,
 *  and the case passes only when every check in every tracker passed. */
function caseTracker(feature, no) {
  const key = `${feature}#${no}`
  if (!results.has(key)) results.set(key, { pass: true, details: [] })
  const entry = results.get(key)
  return {
    check(name, ok, detail = '') {
      console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${feature}#${no} ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok) {
        entry.pass = false
        failures++
      }
      if (detail) entry.details.push(`${name}: ${detail}`)
      return ok
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pollUntil(desc, fn, timeoutMs = 15_000, tickMs = 150) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last && last.ok) return last
    await sleep(tickMs)
  }
  const detail = last && last.detail !== undefined ? ` — ${String(last.detail)}` : ''
  throw new Error(`等待超时(${timeoutMs}ms):${desc}${detail}`)
}

// ── MCP stdio client helpers (parity.mjs patterns) ──────────────────────────

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}

async function toolError(client, name, args) {
  try {
    await callTool(client, name, args)
  } catch (e) {
    return String(e.message)
  }
  return null
}

async function getState(client, section) {
  const payload = await callTool(client, 'get_state', { section })
  return payload[section]
}

async function readJsonResource(client, uri) {
  const read = await client.readResource({ uri })
  return JSON.parse(read.contents[0].text)
}

async function readResourceError(client, uri) {
  try {
    await client.readResource({ uri })
    return null
  } catch (e) {
    return String(e.message)
  }
}

function spawnServer(stateFile, cwd = mcpDir) {
  const client = new Client({ name: 'verify-global', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd,
    env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: stateFile },
    stderr: 'pipe',
  })
  return { client, transport, connect: () => client.connect(transport) }
}

/** Deep compare with first-diff reporting; returns null when equal. */
function deepDiff(left, right, path = '$', out = []) {
  if (Object.is(left, right)) return out.length ? out : null
  const typeOf = (v) => (v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : typeof v)
  const leftT = typeOf(left)
  const rightT = typeOf(right)
  if (leftT !== rightT || (leftT === 'array' && left.length !== right.length)) {
    out.push(`${path}: ${JSON.stringify(left)?.slice(0, 60)} vs ${JSON.stringify(right)?.slice(0, 60)}`)
    return out
  }
  if (leftT === 'array') {
    for (let i = 0; i < left.length; i++) {
      deepDiff(left[i], right[i], `${path}[${i}]`, out)
      if (out.length >= 8) return out
    }
    return out.length ? out : null
  }
  if (leftT === 'object') {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])]) {
      if (!(key in left) || !(key in right)) out.push(`${path}.${key}: ${key in left ? '仅网页侧存在' : '仅 MCP 侧存在'}`)
      else deepDiff(left[key], right[key], `${path}.${key}`, out)
      if (out.length >= 8) return out
    }
    return out.length ? out : null
  }
  out.push(`${path}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`)
  return out
}

// ── upstream source mirrors (parsed, never transcribed) ─────────────────────

function parseNavigationMaps() {
  const source = readFileSync(navConstantsPath, 'utf8')
  const panels = readFileSync(calculatorPanelsPath, 'utf8')
  const panelHash = (panel) => {
    const m = panels.match(new RegExp(`\\[CalculatorPanel\\.${panel}\\]:\\s*'([^']+)'`))
    if (!m) throw new Error(`cannot locate CalculatorPanel.${panel} hash`)
    return m[1]
  }
  const start = source.indexOf('export const PageToHash')
  const block = source.slice(start, source.indexOf('} as const', start))
  const pageToHash = {}
  for (const m of block.matchAll(/\[AppPages\.(\w+)\]:\s*([^,\n]+)/g)) {
    let value = m[2].trim()
    if (value === 'CALCULATOR_PANEL_HASH[CalculatorPanel.AHA]') value = panelHash('AHA')
    else if (value === 'CHARACTERS_HASH') value = '#characters'
    else value = value.replace(/^'|'$/g, '')
    pageToHash[m[1]] = value
  }
  const hashToPage = {}
  for (const [page, hash] of Object.entries(pageToHash)) hashToPage[hash] = page
  hashToPage[panelHash('EHR')] = 'CALCULATORS' // constants.ts HashToPage extras
  hashToPage['#teams'] = 'CHARACTERS'
  return { pageToHash, hashToPage }
}

function parseSettingsConstants() {
  const source = readFileSync(settingsConstantsPath, 'utf8')
  const optionsStart = source.indexOf('export const SettingOptions')
  const optionsBlock = source.slice(optionsStart, source.indexOf('} as const', optionsStart))
  const settingOptions = {}
  for (const km of optionsBlock.matchAll(/^ {2}(\w+): \{$/gm)) {
    const key = km[1]
    const keyStart = optionsBlock.indexOf(km[0])
    const keyEnd = optionsBlock.indexOf('\n  },', keyStart)
    const body = optionsBlock.slice(keyStart, keyEnd)
    settingOptions[key] = {}
    for (const vm of body.matchAll(/^ {4}(\w+): '([^']+)'/gm)) settingOptions[key][vm[1]] = vm[2]
  }
  const defaultsBlock = source.slice(source.indexOf('export const DefaultSettingOptions'))
  const defaults = {}
  for (const m of defaultsBlock.matchAll(/^ {2}(\w+): SettingOptions\.(\w+)\.(\w+),/gm)) {
    defaults[m[1]] = settingOptions[m[2]][m[3]]
  }
  return { settingOptions, defaults }
}

// ── in-page probes for the managed browser (evaluate strings) ────────────────

const PAGE_IDS = '["HOME","OPTIMIZER","CHARACTERS","RELICS","IMPORT","SHOWCASE","WARP","BENCHMARKS","CALCULATORS","LEADERBOARD","CHANGELOG","WEBGPU_TEST","METADATA_TEST"]'

const ACTIVE_PAGE = `() => {
  const ids = ${PAGE_IDS}
  const active = ids.filter((id) => {
    const el = document.getElementById(id)
    return el != null && getComputedStyle(el).display !== 'none'
  })
  return { active, hash: location.hash }
}`

const HARVEST_SAVE = `() => {
  if (!window.__HSR_DEBUG || !window.__HSR_DEBUG.SaveState) return null
  window.__HSR_DEBUG.SaveState.save()
  return JSON.parse(localStorage.getItem('state') || '{}')
}`

const BODY_TEXT = `() => (document.body ? document.body.innerText : '')`

/** Sidebar scoping: the tools group (展示), the optimizer group (跃迁规划器)
 *  and the links group (主页/无爆料) only co-occur inside MenuDrawer, so the
 *  innermost visible div containing all four markers is the nav root. Both
 *  probes below scope their element search to that root so page content can
 *  never shadow a sidebar label. Unread new-feature items carry a trailing
 *  "New" badge inside the button text (MenuDrawer newBadgeFloat), so the
 *  match strips exactly that suffix. */
const NAV_CLICKABLE = `(label) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const roots = [...document.querySelectorAll('div')]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => {
      const t = (el.textContent || '').replace(/\\s+/g, '')
      return t.includes('无爆料') && t.includes('展示') && t.includes('主页') && t.includes('跃迁规划器')
    })
    .sort((a, b) => a.textContent.length - b.textContent.length)
  const scope = roots.length ? roots[0] : document
  return [...scope.querySelectorAll('button, a')]
    .some((el) => el.offsetParent !== null && norm(el.textContent).replace(/\\s*New$/, '') === norm(label))
}`

/** Unscoped visibility probe for portal-rendered elements (dropdown options,
 *  drawer/modal buttons) — those never live inside the sidebar root. */
const ELEMENT_CLICKABLE = `(label) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  return [...document.querySelectorAll('button, [role="option"], a')]
    .some((el) => el.offsetParent !== null && norm(el.textContent) === norm(label))
}`

const CLICK_NAV = `(label) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const roots = [...document.querySelectorAll('div')]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => {
      const t = (el.textContent || '').replace(/\\s+/g, '')
      return t.includes('无爆料') && t.includes('展示') && t.includes('主页') && t.includes('跃迁规划器')
    })
    .sort((a, b) => a.textContent.length - b.textContent.length)
  const scope = roots.length ? roots[0] : document
  const els = [...scope.querySelectorAll('button, a')]
    .filter((el) => el.offsetParent !== null && norm(el.textContent).replace(/\\s*New$/, '') === norm(label))
  if (!els.length) return { ok: false, reason: '侧边栏未找到导航项 ' + label }
  els[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, cancelable: true }))
  els[0].click()
  return { ok: true }
}`

const CLICK_TOPMOST = `(label) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const els = [...document.querySelectorAll('button, [role="option"]')]
    .filter((el) => el.offsetParent !== null && norm(el.textContent) === norm(label))
  if (!els.length) return { ok: false, reason: '未找到可见元素 ' + label }
  const el = els[els.length - 1] // portals (dropdowns/modals) append at body end
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, cancelable: true }))
  el.click()
  return { ok: true }
}`

const CLICK_HEADER_BUTTON = `() => {
  const header = document.querySelector('header')
  const button = header ? header.querySelector('button') : null
  if (!button) return { ok: false, reason: '顶栏按钮未找到' }
  button.click()
  return { ok: true }
}`

/** Click the index-th combobox in the given scope ('header' or 'drawer'). */
const OPEN_COMBOBOX = `(scope, index) => {
  const visible = [...document.querySelectorAll('input[role="combobox"]')].filter((el) => el.offsetParent !== null)
  const list = scope === 'header' ? visible.filter((el) => el.closest('header')) : visible.filter((el) => !el.closest('header'))
  const el = list[index]
  if (!el) return { ok: false, reason: 'combobox ' + scope + '[' + index + '] 不存在(可见 ' + list.length + ')' }
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  el.click()
  return { ok: true, count: list.length }
}`

const COMBOBOX_COUNT = `() => [...document.querySelectorAll('input[role="combobox"]')].filter((el) => el.offsetParent !== null && !el.closest('header')).length`

const COMBOBOX_VALUES = `() => [...document.querySelectorAll('input[role="combobox"]')]
  .filter((el) => el.offsetParent !== null && !el.closest('header'))
  .map((el) => el.value)`

const EXTERNAL_HREFS = `() => [...document.querySelectorAll('a[target="_blank"]')]
  .map((el) => el.getAttribute('href'))
  .filter((href) => href != null && /^https?:/.test(href))`

/** Anchors inside the sidebar nav root (containment, not marker climbing —
 *  climbing from a hidden-mounted page's anchor would reach the app root,
 *  which contains the sidebar text and wrongly adopt e.g. the warp page's
 *  guide links into the sidebar surface). */
const SIDEBAR_HREFS = `() => {
  const roots = [...document.querySelectorAll('div')]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => {
      const t = (el.textContent || '').replace(/\\s+/g, '')
      return t.includes('无爆料') && t.includes('展示') && t.includes('主页') && t.includes('跃迁规划器')
    })
    .sort((a, b) => a.textContent.length - b.textContent.length)
  const scope = roots.length ? roots[0] : null
  if (!scope) return []
  return [...scope.querySelectorAll('a[target="_blank"]')]
    .map((el) => el.getAttribute('href'))
    .filter((href) => href != null && /^https?:/.test(href))
}`

/** Anchors inside a portal surface (changelog modal / getting-started drawer):
 *  the nearest ancestor carrying the marker must NOT also carry sidebar text
 *  (the app root and <body> contain the sidebar, portals do not). */
const LINKS_IN_PORTAL = `(marker) => [...document.querySelectorAll('a[target="_blank"]')]
  .filter((el) => /^https?:/.test(el.getAttribute('href') || ''))
  .filter((el) => {
    let node = el
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      const t = node.textContent || ''
      if (t.includes(marker) && !t.includes('无爆料') && !t.includes('跃迁规划器')) return true
      node = node.parentElement
    }
    return false
  })
  .map((el) => el.getAttribute('href'))`

const HEADER_HREFS = `() => [...document.querySelectorAll('header a[target="_blank"]')]
  .map((el) => el.getAttribute('href'))
  .filter((href) => href != null && /^https?:/.test(href))`

const RESET_SEEN_FEATURES = `() => {
  if (!window.__HSR_DEBUG || !window.__HSR_DEBUG.resetSeenFeatures) return false
  window.__HSR_DEBUG.resetSeenFeatures()
  return true
}`

const I18N_CACHE_KEY = `() => localStorage.getItem('i18nextLng')`

const CARD_TEXT = `() => {
  const card = document.getElementById('characterTabPreview')
  return card ? card.innerText.slice(0, 1200) : null
}`

const CARD_READY = `() => {
  const card = document.getElementById('characterTabPreview')
  if (!card) return false
  return card.querySelector('[data-portrait-inject]') != null
}`

const MODAL_ENTRY = `() => {
  const els = [...document.querySelectorAll('div,span')]
    .filter((el) => el.offsetParent !== null && (el.textContent || '').includes("What's New"))
    .sort((a, b) => a.textContent.length - b.textContent.length)
  if (!els.length) return null
  const title = els[0].textContent || ''
  const m = title.match(/(\\d{4}-\\d{2}-\\d{2})/)
  return { date: m ? m[1] : null, title: title.trim().slice(0, 60) }
}`

const DISMISS_TOP_MODAL = `() => {
  const close = [...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null)
    .find((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes('close'))
  if (close) { close.click(); return true }
  return false
}`

const SET_LANG_AND_RELOAD = `(locale) => {
  localStorage.setItem('i18nextLng', locale)
  window.__verifyReload = 'old'
  location.reload()
  return true
}`

const RELOADED = `() => window.__verifyReload === undefined && document.readyState === 'complete' && !!document.querySelector('#root > *')`

// ── evidence writer ──────────────────────────────────────────────────────────

function writeEvidence() {
  const cases = CASES.map(({ feature, no, method }) => {
    const entry = results.get(`${feature}#${no}`)
    return {
      feature,
      case: no,
      desc: descOf(feature, no),
      method,
      result: entry == null ? 'UNPROVEN' : entry.pass ? 'PASS' : 'FAIL',
      detail: entry == null ? '脚本未执行到该 case(阶段异常,见运行日志)' : entry.details.join(' | ').slice(0, 300) || (entry.pass ? '(断言全部通过)' : '(存在失败断言,该断言未附数值 detail)'),
      script: 'mcp/scripts/verify-global.mjs',
    }
  })
  writeFileSync(evidencePath, `${JSON.stringify({
    area: 'global',
    generatedAt: new Date().toISOString(),
    gitCommit,
    cases,
  }, null, 2)}\n`)
  return cases
}

function makeScenarioDir(name) {
  const dir = resolve(tempRoot, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  const seedText = readFileSync(repoSampleSavePath, 'utf8')

  // Phase-1 outputs consumed by later phases:
  let bootSnapshot = null // MCP load_save → structured snapshot
  let linksResource = null // site://links
  let firstDated = null // game://changelog first dated entry
  let mcpSettingsSnapshot = null // MCP six-setting export snapshot
  let browserSide = null
  let tryItSide = null
  const sampleExportPath = `${tempRoot}/main/sample-export.json`
  const SETTINGS_TARGET = {
    RelicEquippingBehavior: 'Swap',
    PermutationsSidebarBehavior: 'Show XXL',
    ExpandedInfoPanelPosition: 'Above',
    ShowLocatorInRelicsModal: 'Yes',
    ShowComboDmgWarning: 'HideV2',
    NewCharacterDefaultRank: 'Last',
  }

  // ══ Phase 1 — main MCP server, non-destructive surface ═══════════════════
  const dirMain = makeScenarioDir('main')
  const mainState = `${dirMain}/localstorage.json`
  const saveCopyA = `${dirMain}/sample-a.json`
  copyFileSync(repoSampleSavePath, saveCopyA)
  const main = spawnServer(mainState)
  await main.connect()
  const mcp = main.client

  try {
    // ── global.navigate.page case 1: site://pages vs PageToHash/HashToPage ──
    {
      const c = caseTracker('global.navigate.page', 1)
      const { pageToHash } = parseNavigationMaps()
      const pages = await readJsonResource(mcp, 'site://pages')
      const byPage = new Map(pages.pages.map((p) => [p.page, p]))
      c.check(
        'site://pages 列出全部 13 页(AppPages 全集)',
        pages.count === 13 && pages.pages.length === 13 && byPage.size === 13,
        `count=${pages.count}`,
      )
      const mismatches = Object.entries(pageToHash).filter(([page, hash]) => byPage.get(page)?.hash !== hash)
      c.check(
        '每页 hash 与上游 PageToHash 逐条一致(含 CALCULATORS→#aha)',
        mismatches.length === 0,
        mismatches.length ? mismatches.map(([p, h]) => `${p}:${byPage.get(p)?.hash}≠${h}`).join(',') : `${Object.keys(pageToHash).length} 页全对`,
      )
      const renderPageOk = pages.pages.every((p) => p.renderPage === p.page)
      const urlOk = pages.pages.every((p) => p.urlForm === `/hsr-optimizer${p.hash}`)
      c.check('renderPage 字段=page 枚举、urlForm=BASE_PATH+hash', renderPageOk && urlOk && pages.basePath === '/hsr-optimizer')
      const zhNamed = pages.pages.filter((p) => !p.devOnly)
      c.check(
        '11 个正式页带 zh 标题、2 个开发页 devOnly 标记(无侧边栏入口)',
        zhNamed.length === 11 && zhNamed.every((p) => typeof p.nameZh === 'string' && p.nameZh.length > 0)
          && pages.pages.filter((p) => p.devOnly).map((p) => p.page).join(',') === 'WEBGPU_TEST,METADATA_TEST',
      )
      const tools = await mcp.listTools()
      const renderTool = tools.tools.find((t) => t.name === 'render')
      const pageEnum = renderTool?.inputSchema?.properties?.page?.enum
      const expectedEnum = [...new Set([...Object.values(pageToHash), '#ehr'])].sort()
      c.check(
        'render 工具 page 参数枚举 = PageToHash 值集 + #ehr(无 #teams),即 HashToPage 收录集',
        JSON.stringify([...(pageEnum ?? [])].sort()) === JSON.stringify(expectedEnum),
        `${pageEnum?.length ?? 0} 个枚举值`,
      )
    }

    // ── global.settings.update case 1: get_state(settings) vs 上游常量 ──────
    await callTool(mcp, 'load_save', { path: saveCopyA })
    {
      const c = caseTracker('global.settings.update', 1)
      const settings = await getState(mcp, 'settings')
      const { settingOptions, defaults } = parseSettingsConstants()
      const keys = Object.keys(settingOptions)
      c.check(
        '六项设置定义齐备(键 = 上游 SettingOptions 键集)',
        Object.keys(settings.definitions).length === 6 && keys.every((k) => k in settings.definitions),
        keys.join(','),
      )
      const valuesBad = keys.filter((k) => JSON.stringify(settings.definitions[k].values) !== JSON.stringify(Object.values(settingOptions[k])))
      c.check('每项枚举值序列与上游 SettingOptions 一致', valuesBad.length === 0, valuesBad.join(',') || '六项全对')
      const defaultsBad = keys.filter((k) => settings.definitions[k].default !== defaults[k])
      c.check('每项默认值与上游 DefaultSettingOptions 一致', defaultsBad.length === 0, defaultsBad.join(',') || '六项全对')
      c.check(
        '示例存档无 settings 字段 → 当前值 = 上游默认值',
        keys.every((k) => settings.settings[k] === defaults[k]),
        JSON.stringify(settings.settings),
      )
    }

    // ── global.state.bootLoad case 1 (MCP side) ─────────────────────────────
    bootSnapshot = (await callTool(mcp, 'export_save', { structured: true })).snapshot

    // ── global.settings.update case 2 (MCP side): 逐项写入 + 非法拒绝 ──────
    {
      const c = caseTracker('global.settings.update', 2)
      for (const [key, value] of Object.entries(SETTINGS_TARGET)) {
        await callTool(mcp, 'update_state', { section: 'settings', patch: { [key]: value } })
      }
      mcpSettingsSnapshot = (await callTool(mcp, 'export_save', { structured: true })).snapshot
      const diff = deepDiff(mcpSettingsSnapshot.settings, SETTINGS_TARGET)
      c.check('逐项 update_state 后导出存档 settings = 六项目标值', diff == null, diff ? diff.join(' | ').slice(0, 160) : '六项全对')
      const bad = await toolError(mcp, 'update_state', { section: 'settings', patch: { RelicEquippingBehavior: 'Nonsense' } })
      c.check(
        '非法取值被拒绝并列出合法枚举',
        bad != null && bad.includes('RelicEquippingBehavior') && bad.includes('Replace') && bad.includes('Swap'),
        bad?.slice(0, 100) ?? '未报错',
      )
    }

    // ── global.sidebar.collapse (MCP side) ───────────────────────────────────
    {
      const c = caseTracker('global.sidebar.collapse', 1)
      await callTool(mcp, 'update_state', { section: 'session', patch: { sidebarCollapsed: true } })
      const snapshot = (await callTool(mcp, 'export_save', { structured: true })).snapshot
      c.check(
        'update_state(sidebarCollapsed=true) 后导出存档该键 = true',
        snapshot.savedSession?.global?.sidebarCollapsed === true,
        `sidebarCollapsed=${String(snapshot.savedSession?.global?.sidebarCollapsed)}`,
      )
    }

    // ── global.newFeature.badges (MCP side) ──────────────────────────────────
    {
      const c = caseTracker('global.newFeature.badges', 1)
      await callTool(mcp, 'update_state', { section: 'flags', patch: { seenFeatures: ['leaderboard'] } })
      let snapshot = (await callTool(mcp, 'export_save', { structured: true })).snapshot
      c.check('update_state(flags) 标记 leaderboard 后导出存档 seenFeatures=["leaderboard"]', JSON.stringify(snapshot.seenFeatures) === '["leaderboard"]', JSON.stringify(snapshot.seenFeatures))
      const flags = await getState(mcp, 'flags')
      c.check('get_state(flags).activeNewFeatures 派生自 ACTIVE_NEW_FEATURES(=leaderboard)', JSON.stringify(flags.activeNewFeatures) === '["leaderboard"]')
      await callTool(mcp, 'update_state', { section: 'flags', patch: { seenFeatures: [] } })
      snapshot = (await callTool(mcp, 'export_save', { structured: true })).snapshot
      c.check('清空后 seenFeatures 恢复为空数组', Array.isArray(snapshot.seenFeatures) && snapshot.seenFeatures.length === 0)
    }

    // ── global.language.switch case 1 (MCP side) ─────────────────────────────
    {
      const c = caseTracker('global.language.switch', 1)
      const before = await getState(mcp, 'session')
      c.check(
        '默认语言 zh_CN(渲染语言与偏好一致)',
        before.ephemeral.language === 'zh_CN' && before.ephemeral.activeLanguage === 'zh_CN',
        JSON.stringify(before.ephemeral),
      )
      const labelsOf = async () => (await callTool(mcp, 'describe_conditionals', { characterId: '1212' })).conditionals.map((x) => x.label)
      const labelsBefore = await labelsOf()
      const updated = await callTool(mcp, 'update_state', { section: 'session', patch: { language: 'en_US' } })
      const labelsAfter = await labelsOf()
      c.check('update_state(language=en_US) 提交后偏好切到 en_US', updated.session.ephemeral.language === 'en_US', JSON.stringify(updated.session.ephemeral))
      const labelsSwitched = JSON.stringify(labelsBefore) !== JSON.stringify(labelsAfter)
      c.check(
        'describe_conditionals 返回的标签随之变为英文(与网页英文界面一致)',
        labelsSwitched,
        labelsSwitched ? `前 3 项:${labelsAfter.slice(0, 3).join('/')}` : `切换前后标签逐字相同(前 3 项:${labelsBefore.slice(0, 3).join('/')})——update_state(language) 只写 i18nextLng 缓存键,本进程渲染语言按实现固定 zh_CN(mcp/src/domains/state.ts:86-101),标签不随切换`,
      )
      const restored = await callTool(mcp, 'update_state', { section: 'session', patch: { language: 'zh_CN' } })
      c.check('切回 zh_CN 后偏好恢复', restored.session.ephemeral.language === 'zh_CN')
    }

    // ── global.state.autosave case 1: dirty → 防抖落盘 = SaveState.save 输出 ─
    {
      const c = caseTracker('global.state.autosave', 1)
      await callTool(mcp, 'load_save', { path: saveCopyA })
      await callTool(mcp, 'save_team', { name: 'autosave-probe', characterIds: ['1212'] })
      const dirtyStatus = await callTool(mcp, 'save_status', {})
      c.check('写操作后立即 save_status.dirty=true(防抖未落盘)', dirtyStatus.dirty === true, `dirty=${String(dirtyStatus.dirty)}`)
      await sleep(2400) // markDirty debounce is 1000ms
      const flushedStatus = await callTool(mcp, 'save_status', {})
      c.check('防抖结束后 dirty=false(已落盘)', flushedStatus.dirty === false && flushedStatus.blockedWrite === null, `dirty=${String(flushedStatus.dirty)}`)
      const diskJson = JSON.parse(readFileSync(saveCopyA, 'utf8'))
      const snapshot = (await callTool(mcp, 'export_save', { structured: true })).snapshot
      const diff = deepDiff(diskJson, snapshot)
      c.check(
        '落盘文件与 SaveState.save() 输出逐键一致(团队写入在盘上可见)',
        diff == null && diskJson.savedSession?.global?.teamShowcaseSavedTeams?.some((t) => t.name === 'autosave-probe'),
        diff ? diff.join(' | ').slice(0, 160) : '逐键相等',
      )
    }

    // ── global.settings.update case 3: Swap/Replace 改变 equip_build 行为 ──
    try {
      const c = caseTracker('global.settings.update', 3)
      const charA = '1101' // Bronya — 4 件装备,含 Head
      const charB = '1205' // Blade — 全 6 件装备,含 Head
      const runEquip = async () => {
        const a = await callTool(mcp, 'get_character', { characterId: charA })
        const b = await callTool(mcp, 'get_character', { characterId: charB })
        const relicA = a.equippedSlots.Head.equippedId
        const relicB = b.equippedSlots.Head.equippedId
        await callTool(mcp, 'equip_build', { characterId: charB, relicIds: [relicA] })
        const afterA = await callTool(mcp, 'get_character', { characterId: charA })
        const afterB = await callTool(mcp, 'get_character', { characterId: charB })
        return { relicA, relicB, bHead: afterB.equippedSlots.Head?.equippedId ?? null, aHead: afterA.equippedSlots.Head?.equippedId ?? null }
      }
      await callTool(mcp, 'load_save', { path: saveCopyA }) // fresh defaults → Replace
      const replaceRun = await runEquip()
      c.check(
        '默认 Replace:B 拿走 A 的头部件,A 头部清空',
        replaceRun.bHead === replaceRun.relicA && replaceRun.aHead === null,
        `B.Head=${replaceRun.bHead},A.Head=${replaceRun.aHead}`,
      )
      await callTool(mcp, 'load_save', { path: saveCopyA })
      await callTool(mcp, 'update_state', { section: 'settings', patch: { RelicEquippingBehavior: 'Swap' } })
      const swapRun = await runEquip()
      c.check(
        '改为 Swap 后:B 拿走 A 的头部件,A 收到 B 原头部件(交换)',
        swapRun.bHead === swapRun.relicA && swapRun.aHead === swapRun.relicB,
        `B.Head=${swapRun.bHead},A.Head=${swapRun.aHead}(期望 ${swapRun.relicB})`,
      )
    } catch (e) {
      const c = caseTracker('global.settings.update', 3)
      c.check('Swap/Replace equip 行为对拍执行', false, String(e?.message ?? e).slice(0, 160))
    }

    // ── global.changelog.whatsNew case 1 (MCP side): 旧版本存档版本报告 ─────
    {
      const c = caseTracker('global.changelog.whatsNew', 1)
      const oldSave = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
      oldSave.version = 'v0.0.1'
      const oldSavePath = `${dirMain}/old-version.json`
      writeFileSync(oldSavePath, JSON.stringify(oldSave))
      const loaded = await callTool(mcp, 'load_save', { path: oldSavePath })
      c.check('载入旧版本存档:load_save 直读存档 version 字段(v0.0.1)', loaded.version === 'v0.0.1', `version=${JSON.stringify(loaded.version)}`)
      const revision = await getState(mcp, 'revision')
      const session = await getState(mcp, 'session')
      const versionFields = Object.entries({ ...revision, ...session }).filter(([k, v]) => /version/i.test(k) || /outdated|过期/i.test(String(k ?? '')))
      c.check(
        'get_state 报告存档版本、当前版本和是否过期(与 isVersionOutdated 一致)',
        versionFields.length > 0,
        versionFields.length ? JSON.stringify(versionFields) : 'get_state(revision/session) 无任何版本/过期字段——当前版本仅 site://home.optimizerVersion 与导出快照 version(恒为 CURRENT_OPTIMIZER_VERSION)可读,「是否过期」未透出;与用例描述不符',
      )
      const snapshot = (await callTool(mcp, 'export_save', { structured: true })).snapshot
      const home = await readJsonResource(mcp, 'site://home')
      c.check(
        '可读版本面交叉核对:导出快照 version = site://home.optimizerVersion(saveState.ts:84 恒写当前版)',
        snapshot.version === home.optimizerVersion,
        `snapshot.version=${snapshot.version},optimizerVersion=${home.optimizerVersion}`,
      )
    }

    // ── global.gettingStarted.loadSample (MCP side) ──────────────────────────
    {
      const c = caseTracker('global.gettingStarted.loadSample', 1)
      const loaded = await callTool(mcp, 'load_save', { sample: true })
      c.check(
        'load_save(sample=true) 载入内置示例(162 遗器 / 8 角色,sample echo,无路径)',
        loaded.sample === true && loaded.loaded === true && loaded.relics === 162 && loaded.characters === 8 && loaded.path === null,
        `${loaded.relics}/${loaded.characters}`,
      )
      await callTool(mcp, 'export_save', { path: sampleExportPath })
      const sampleDisk = JSON.parse(readFileSync(sampleExportPath, 'utf8'))
      c.check('导出示例存档成功且数量正确', sampleDisk.relics?.length === 162 && sampleDisk.characters?.length === 8)
    }

    // ── global.links.external case 2: site://help/optimizer ─────────────────
    {
      const c = caseTracker('global.links.external', 2)
      const err = await readResourceError(mcp, 'site://help/optimizer')
      if (err == null) {
        const help = await readJsonResource(mcp, 'site://help/optimizer')
        c.check('site://help/optimizer 返回指南正文', help != null && ((help.points?.length ?? 0) > 0 || help.url != null))
      } else {
        c.check(
          'site://help/optimizer 返回仓库内 docs/guides 对应指南的正文',
          false,
          `资源读取报错:${err.slice(0, 120)}——已注册帮助主题仅 reliquary/kelz/scorer/hoyolab/live-import(resources.ts SITE_HELP_TOPICS,导入页帮助区),无 optimizer 主题;docs/guides/en/optimizer.md 只被入门抽屉引用`,
        )
        const liveImport = await readJsonResource(mcp, 'site://help/live-import')
        c.check('旁证:site://help/live-import 指向仓库内指南 md', liveImport.url?.includes('docs/guides/en/live-import.md') === true, String(liveImport.url))
      }
    }

    // ── 对拍参考(浏览器阶段使用) ────────────────────────────────────────────
    const changelogResource = await readJsonResource(mcp, 'game://changelog')
    firstDated = changelogResource.entries.find((e) => (e.date ?? '').length > 0)
    linksResource = await readJsonResource(mcp, 'site://links')
  } catch (e) {
    failures++
    console.error('Phase 1 (main MCP server) 异常:', e)
  }

  // ══ Phase 2 — script-side managed browser(真实站点,同版本构建) ═════════
  try {
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

    // ---- Task A: 全局面壳(更新弹窗/导航/侧栏/设置/标记/语言/链接) ----
    browserSide = await browserManager.runTask(
      { label: 'verify-global(shell)', seed: seedText, timeoutMs: 420_000 },
      async (page) => {
        const out = { changelogCtaHrefs: [] }
        await page.goto('', { timeoutMs: 90_000 })
        await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
        await sleep(1500)

        // 默认语言探测(render 工具的任务上下文不预置 i18nextLng,记录实际语言)
        out.defaultLanguage = {
          cache: await page.evaluate(I18N_CACHE_KEY),
          looksEnglish: (await page.evaluate(BODY_TEXT)).includes('Warp Planner'),
        }

        // 预置 zh_CN 并重载(语言种子方式照抄 smoke-m8;reload 期间 evaluate 会
        // 随旧文档销毁,poll 里捕获后重试 —— smoke-m8 同款防御)
        await page.evaluate(SET_LANG_AND_RELOAD, ['zh_CN'])
        await pollUntil('zh_CN 重载完成', async () => {
          try {
            return { ok: (await page.evaluate(RELOADED)) === true }
          } catch {
            return { ok: false, detail: 'evaluate during reload' }
          }
        }, 40_000)
        await sleep(2500) // 更新弹窗在启动约 1 秒后自动弹出(存档无 version)

        // ── global.changelog.whatsNew case 2: 弹窗内容 vs game://changelog ──
        {
          const c = caseTracker('global.changelog.whatsNew', 2)
          // 观察记录:受管无头环境里「启动 1 秒自动弹出」未触发(appStore 初始
          // version=CURRENT_OPTIMIZER_VERSION 与 App.tsx:38 的 1 秒 tick 竞争);
          // 用功能条目自身登记的另一入口 globalThis.openChangelogModal() 打开
          // (ChangelogModal.tsx:27),对拍内容——case 本身只比较弹窗内容。
          const autoOpen = await (async () => {
            try {
              await pollUntil('更新弹窗自动弹出', async () => ({ ok: (await page.evaluate(BODY_TEXT)).includes("What's New") }), 8000, 300)
              return true
            } catch {
              return false
            }
          })()
          if (!autoOpen) {
            await page.evaluate(`() => { globalThis.openChangelogModal && globalThis.openChangelogModal(); return true }`)
            await pollUntil('openChangelogModal() 打开更新弹窗', async () => ({ ok: (await page.evaluate(BODY_TEXT)).includes("What's New") }), 10_000, 200)
          }
          c.check('更新弹窗可打开(自动弹出或 globalThis.openChangelogModal 入口)', true, autoOpen ? '启动自动弹出' : '经 openChangelogModal() 入口打开(受管环境内自动弹出未触发,详见报告)')
          {
            const entry = await page.evaluate(MODAL_ENTRY)
            c.check(
              `弹窗日期徽标 = game://changelog 首个带日期条目(${firstDated?.date})`,
              entry?.date === firstDated?.date,
              `弹窗=${entry?.date},资源=${firstDated?.date}`,
            )
            const flat = (await page.evaluate(BODY_TEXT)).replace(/\s+/g, ' ')
            const textItems = (firstDated?.content ?? []).filter((item) => !item.endsWith('.webp'))
            const missing = textItems.filter((item) => !flat.includes(item.slice(0, 24).replace(/\s+/g, ' ')))
            c.check(
              `弹窗正文逐条 = 资源条目内容(${textItems.length} 条非图片项)`,
              missing.length === 0,
              missing.length ? `缺失:${missing.slice(0, 2).join(' / ').slice(0, 100)}` : '全部在场',
            )
            out.changelogCtaHrefs = await page.evaluate(LINKS_IN_PORTAL, ["What's New"]) // 弹窗底部 CTA 卡(按弹窗容器收敛)
            await sleep(600)
            const dismissed = await page.evaluate(DISMISS_TOP_MODAL)
            if (!dismissed) await page.press('Escape')
            await sleep(800)
          }
        }

        // ── global.state.bootLoad case 1(网页侧):启动载入 + SaveState.save ─
        const bootHarvest = await page.evaluate(HARVEST_SAVE)

        // ── global.navigate.page case 2(网页侧): 侧边栏点击 ────────────────
        // 注:SHOWCASE 不进本表——无 UID/存档 scorerId 时网页自身改跳首页
        // (ShowcaseTab.tsx RedirectToHome),单独断言该真实行为
        const navPlan = [
          ['Leaderboards', 'LEADERBOARD'],
          ['基准', 'BENCHMARKS'],
          ['计算器', 'CALCULATORS'],
          ['跃迁规划器', 'WARP'],
          ['优化器', 'OPTIMIZER'],
          ['角色', 'CHARACTERS'],
          ['遗器', 'RELICS'],
          ['导入 / 保存', 'IMPORT'],
          ['主页', 'HOME'],
          ['更新日志', 'CHANGELOG'],
        ]
        {
          const c = caseTracker('global.navigate.page', 2)
          const { pageToHash } = parseNavigationMaps()
          const observed = []
          let retried = 0
          for (const [label, pageKey] of navPlan) {
            await pollUntil(`侧边栏项可点(${label})`, async () => ({ ok: (await page.evaluate(NAV_CLICKABLE, [label])) === true }), 20_000)
            let state = null
            for (let attempt = 0; attempt < 3; attempt++) {
              await page.evaluate(CLICK_NAV, [label])
              const deadline = Date.now() + 3000
              while (Date.now() < deadline) {
                state = await page.evaluate(ACTIVE_PAGE)
                if (state.hash === pageToHash[pageKey]) break
                await sleep(250)
              }
              if (state.hash === pageToHash[pageKey]) break
              retried++
            }
            await sleep(400) // 让页面内容挂载稳定
            state = await page.evaluate(ACTIVE_PAGE)
            observed.push({ label, page: pageKey, hash: state.hash, active: state.active })
          }
          const bad = observed.filter((o) => o.hash !== pageToHash[o.page] || o.active[o.active.length - 1] !== o.page)
          c.check(
            '侧边栏逐项点击:activeKey 与地址栏 hash 逐项命中(PageToHash 预期)',
            bad.length === 0 && observed.length === navPlan.length,
            bad.length
              ? bad.map((o) => `${o.label}:hash=${o.hash},active=${o.active.join('/')}`).join(';').slice(0, 160)
              : `${observed.length} 项全对${retried ? `(首轮点击未生效重试 ${retried} 次)` : ''}`,
          )
          for (const [hash, pageKey] of [['#ehr', 'CALCULATORS'], ['#teams', 'CHARACTERS'], ['#webgpu', 'WEBGPU_TEST'], ['#metadata', 'METADATA_TEST']]) {
            await page.evaluate('(hash) => { location.hash = hash; return true }', [hash])
            await sleep(900)
            const state = await page.evaluate(ACTIVE_PAGE)
            c.check(`hashchange 直达 ${hash} → activeKey=${pageKey}(HashToPage 归一)`, state.hash === hash && state.active[state.active.length - 1] === pageKey, `hash=${state.hash},active=${state.active.join('/')}`)
          }
          // SHOWCASE 特例:裸 #showcase 被网页守卫改跳首页;带 id 参数驻留
          await page.evaluate(`() => { location.hash = ''; return true }`)
          await sleep(900)
          await page.evaluate(CLICK_NAV, ['展示'])
          await sleep(1200)
          let state = await page.evaluate(ACTIVE_PAGE)
          c.check(
            '侧边栏点击「展示」(无 UID/存档 scorerId)→ 网页守卫改跳首页(activeKey=HOME,hash="")',
            state.hash === '' && state.active[state.active.length - 1] === 'HOME',
            `hash=${JSON.stringify(state.hash)},active=${state.active.join('/')}(ShowcaseTab.tsx RedirectToHome)`,
          )
          await page.evaluate('(hash) => { location.hash = hash; return true }', ['#showcase?id=808162595'])
          await sleep(1500)
          state = await page.evaluate(ACTIVE_PAGE)
          c.check(
            '#showcase?id=<uid> 带 URL 参数 → activeKey=SHOWCASE 驻留(navigateTo params 通道)',
            state.hash.startsWith('#showcase') && state.active[state.active.length - 1] === 'SHOWCASE',
            `hash=${state.hash},active=${state.active.join('/')}`,
          )
        }

        // ── global.sidebar.collapse(网页侧): 顶栏菜单按钮 ───────────────────
        {
          const c = caseTracker('global.sidebar.collapse', 1)
          const before = await page.evaluate(BODY_TEXT)
          await page.evaluate(CLICK_HEADER_BUTTON)
          await sleep(700)
          const afterText = await page.evaluate(BODY_TEXT)
          const collapsedHarvest = await page.evaluate(HARVEST_SAVE)
          const labelsGone = before.includes('跃迁规划器') && !afterText.includes('跃迁规划器')
          c.check(
            '浏览器运行环境渲染出折叠态侧边栏(点击菜单按钮后导航文字消失、图标保留)',
            labelsGone,
            labelsGone ? '折叠态渲染确认' : '折叠后仍可见导航文字',
          )
          c.check(
            '折叠态经防抖保存写入 savedSession.global.sidebarCollapsed=true',
            collapsedHarvest.savedSession?.global?.sidebarCollapsed === true,
            `sidebarCollapsed=${String(collapsedHarvest.savedSession?.global?.sidebarCollapsed)}`,
          )
          out.sidebarCollapsed = collapsedHarvest.savedSession?.global?.sidebarCollapsed
          await page.evaluate(CLICK_HEADER_BUTTON) // 还原展开
          await sleep(600)
        }

        // ── global.settings.update case 2(网页侧):设置抽屉六项逐项修改 ────
        {
          const c = caseTracker('global.settings.update', 2)
          await pollUntil('侧边栏「设置」项可点', async () => ({ ok: (await page.evaluate(NAV_CLICKABLE, ['设置'])) === true }), 20_000)
          await page.evaluate(CLICK_NAV, ['设置'])
          await pollUntil('设置抽屉打开(六项 Select 就绪)', async () => ({ ok: (await page.evaluate(COMBOBOX_COUNT)) === 6 }), 20_000)
          const body = await page.evaluate(BODY_TEXT)
          const labelOrder = ['装备其他角色所装备的遗器', '在较小屏幕上缩小优化器侧边工具栏', '优化器扩展信息面板位置', '遗物编辑器中的遗物定位器', '显示连招伤害警告', '新角色默认排序']
          const orderOk = labelOrder.every((label) => body.includes(label)) && labelOrder.every((label, i) => i === 0 || body.indexOf(labelOrder[i - 1]) < body.indexOf(label))
          c.check('设置抽屉列出六项下拉(标签齐备,顺序与 SettingOptions 键序一致)', orderOk, orderOk ? '' : '标签存在性或顺序不符')
          const zhOptionLabels = [
            '与该遗器装备者交换遗器', // RelicEquippingBehavior → Swap
            '最小化工具栏如果侧边工具栏的任何部分被隐藏', // → Show XXL
            '在遗器预览上方显示扩展信息', // → Above
            '在遗物编辑器中显示遗物定位器', // → Yes
            '隐藏警告', // → HideV2
            '最低优先级', // → Last
          ]
          for (let i = 0; i < zhOptionLabels.length; i++) {
            await page.evaluate(OPEN_COMBOBOX, ['drawer', i])
            await sleep(350)
            await pollUntil(`下拉选项可点(${zhOptionLabels[i]})`, async () => ({ ok: (await page.evaluate(ELEMENT_CLICKABLE, [zhOptionLabels[i]])) === true }), 8000, 120)
            await page.evaluate(CLICK_TOPMOST, [zhOptionLabels[i]])
            await sleep(350)
          }
          const values = await page.evaluate(COMBOBOX_VALUES)
          c.check('六项逐项修改后输入框值 = 目标项中文文案', JSON.stringify(values) === JSON.stringify(zhOptionLabels), values.join(' | ').slice(0, 160))
          const settingsHarvest = await page.evaluate(HARVEST_SAVE)
          const diff = deepDiff(settingsHarvest.settings, SETTINGS_TARGET)
          c.check(
            '网页修改同一项后的存档 settings 与 MCP 逐项 update_state 导出结果逐键一致',
            diff == null && mcpSettingsSnapshot != null && deepDiff(mcpSettingsSnapshot.settings, settingsHarvest.settings) == null,
            diff ? diff.join(' | ').slice(0, 160) : '六项逐键一致',
          )
          await page.press('Escape') // 关抽屉
          await sleep(500)
        }

        // ── global.newFeature.badges(网页侧):进入排行榜页标记已读 ──────────
        {
          const c = caseTracker('global.newFeature.badges', 1)
          // 导航循环已访问过排行榜,先经上游控制台工具 resetSeenFeatures 归零
          // (index.tsx __HSR_DEBUG 暴露)再观察「进入页面 → markFeatureSeen」
          const resetOk = await page.evaluate(RESET_SEEN_FEATURES)
          const before = await page.evaluate(HARVEST_SAVE)
          await pollUntil('侧边栏 Leaderboards 项可点', async () => ({ ok: (await page.evaluate(NAV_CLICKABLE, ['Leaderboards'])) === true }), 20_000)
          await page.evaluate(CLICK_NAV, ['Leaderboards'])
          await sleep(1200)
          const after = await page.evaluate(HARVEST_SAVE)
          c.check(
            '进入排行榜页后存档 seenFeatures=["leaderboard"](与 MCP flags 写入一致)',
            resetOk
              && JSON.stringify(before.seenFeatures ?? []) === '[]'
              && JSON.stringify(after.seenFeatures) === '["leaderboard"]',
            `reset=${String(resetOk)},前=${JSON.stringify(before.seenFeatures ?? [])},后=${JSON.stringify(after.seenFeatures)}`,
          )
          out.webSeenFeatures = after.seenFeatures
        }

        // ── global.language.switch case 2: 指定语言下的角色卡文字 ────────────
        {
          const c = caseTracker('global.language.switch', 2)
          const selectAndHarvest = async () => {
            await page.evaluate('(hash) => { location.hash = hash; return true }', ['#characters'])
            await pollUntil('角色页容器就绪', async () => ({
              ok: (await page.evaluate('(id) => { const el = document.getElementById(id); return el != null && getComputedStyle(el).display !== "none" }', ['CHARACTERS'])) === true,
            }), 20_000)
            await page.waitForSelector('[data-character-id="1212b1"]', { timeoutMs: 30_000, visible: true })
            await page.click('[data-character-id="1212b1"]', { timeoutMs: 30_000 })
            await pollUntil('展示卡就绪(1212b1 肖像)', async () => ({ ok: (await page.evaluate(CARD_READY)) === true }), 30_000)
            await sleep(1200)
            return page.evaluate(CARD_TEXT)
          }
          const zhCard = await selectAndHarvest()
          c.check('zh_CN 预置语言下角色卡文字为中文(含角色名「镜流」)', zhCard != null && zhCard.includes('镜流'), (zhCard || 'null').slice(0, 80).replace(/\n/g, '/'))
          await page.evaluate(OPEN_COMBOBOX, ['header', 0])
          await sleep(400)
          await pollUntil('语言选项 English 可点', async () => ({ ok: (await page.evaluate(ELEMENT_CLICKABLE, ['English'])) === true }), 8000, 120)
          await page.evaluate(CLICK_TOPMOST, ['English'])
          await pollUntil('卡面文字切换为英文(Jingliu)', async () => ({ ok: (await page.evaluate(CARD_TEXT)).includes('Jingliu') }), 20_000)
          const enCard = await page.evaluate(CARD_TEXT)
          const cacheKey = await page.evaluate(I18N_CACHE_KEY)
          c.check(
            '语言下拉(UI 真路径)切 en_US:卡面变英文并写 i18nextLng 缓存键(与 MCP update_state(language) 同一键)',
            cacheKey === 'en_US' && enCard.includes('Jingliu') && !enCard.includes('镜流'),
            `i18nextLng=${cacheKey}`,
          )
          c.check(
            '指定语言(en_US)渲染的角色卡文字与网页同语言切换结果一致、且与 zh_CN 不同',
            enCard !== zhCard && enCard.length > 50 && zhCard.length > 50,
            `en 前 50:${enCard.slice(0, 50).replace(/\n/g, '/')} ≠ zh 前 50:${zhCard.slice(0, 50).replace(/\n/g, '/')}`,
          )
          out.cardText = { zh: zhCard?.slice(0, 120), en: enCard?.slice(0, 120) }
          await page.evaluate(OPEN_COMBOBOX, ['header', 0])
          await sleep(400)
          await pollUntil('语言选项 中文 可点', async () => ({ ok: (await page.evaluate(ELEMENT_CLICKABLE, ['中文'])) === true }), 8000, 120)
          await page.evaluate(CLICK_TOPMOST, ['中文'])
          await pollUntil('卡面文字切回镜流', async () => ({ ok: (await page.evaluate(CARD_TEXT)).includes('镜流') }), 20_000)
        }

        // ── global.links.external case 1: 四处 UI 的 href 采集(按界面区域收敛) ─
        {
          const c = caseTracker('global.links.external', 1)
          const sidebarHrefs = await page.evaluate(SIDEBAR_HREFS)
          const headerHrefs = await page.evaluate(HEADER_HREFS)
          const modalHrefs = out.changelogCtaHrefs // 弹窗打开期间按 "What's New" 收敛采集
          await pollUntil('侧边栏「开始使用」可点', async () => ({ ok: (await page.evaluate(NAV_CLICKABLE, ['开始使用'])) === true }), 20_000)
          await page.evaluate(CLICK_NAV, ['开始使用'])
          await pollUntil('入门抽屉打开(试试看按钮)', async () => ({ ok: (await page.evaluate(ELEMENT_CLICKABLE, ['试试看！'])) === true }), 20_000)
          const drawerHrefs = await page.evaluate(LINKS_IN_PORTAL, ['试试看'])
          const surfaces = {
            侧边栏: sidebarHrefs,
            顶栏: headerHrefs,
            更新弹窗: modalHrefs,
            入门抽屉: drawerHrefs,
          }
          const resourceUrls = new Set(linksResource.groups.flatMap((g) => g.links).filter((l) => l.url != null).map((l) => l.url))
          const sidebarSet = [...new Set([...sidebarHrefs, ...headerHrefs, ...modalHrefs])]
          const sidebarMissing = sidebarSet.filter((url) => !resourceUrls.has(url))
          c.check(
            'site://links 收录侧边栏、顶栏、更新弹窗的全部外链',
            sidebarMissing.length === 0,
            sidebarMissing.length ? `未收录:${sidebarMissing.join(',')}` : `${sidebarSet.length} 条全部收录`,
          )
          const allSurface = [...new Set([...sidebarSet, ...drawerHrefs])]
          const missing = allSurface.filter((url) => !resourceUrls.has(url))
          c.check(
            '入门抽屉的外链同样逐条一致(四处 UI ⊆ site://links)',
            missing.length === 0,
            missing.length ? `入门抽屉「查看完整指南」等链接未收录进 site://links:${missing.join(',')}——资源组仅覆盖首页社区卡/侧边栏链接组/页眉(resources.ts SITE_LINK_GROUPS),指南类链接只经 site://help/{topic} 部分提供` : '逐条一致',
          )
          out.linkSurfaces = surfaces
          await page.press('Escape')
          await sleep(500)
        }

        // ── global.state.bootLoad case 1 对拍 ────────────────────────────────
        {
          const c = caseTracker('global.state.bootLoad', 1)
          const diff = deepDiff(bootHarvest, bootSnapshot)
          c.check(
            '同一份存档:网页启动载入的 SaveState.save() 输出与 MCP load_save 后导出逐键一致',
            diff == null,
            diff ? diff.join(' | ').slice(0, 200) : `${Object.keys(bootHarvest).length} 个顶层键逐键相等`,
          )
        }

        return out
      },
    )

    // ---- Task C: 入门抽屉「试一试」(整体替换 → 与 load_save(sample=true) 对拍) ----
    tryItSide = await browserManager.runTask(
      { label: 'verify-global(try-it)', seed: seedText, timeoutMs: 240_000 },
      async (page) => {
        await page.goto('', { timeoutMs: 90_000 })
        await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
        await page.evaluate(SET_LANG_AND_RELOAD, ['zh_CN'])
        await pollUntil('zh_CN 重载完成', async () => {
          try {
            return { ok: (await page.evaluate(RELOADED)) === true }
          } catch {
            return { ok: false, detail: 'evaluate during reload' }
          }
        }, 40_000)
        await sleep(2500)
        // 自动弹出的更新弹窗若在场则先关掉(受管环境下常不触发,勿点无关按钮)
        const modalPresent = await page.evaluate(`() => document.body.innerText.includes("What's New")`)
        if (modalPresent) {
          const dismissed = await page.evaluate(DISMISS_TOP_MODAL)
          if (!dismissed) await page.press('Escape')
          await sleep(800)
        }
        await pollUntil('侧边栏「开始使用」可点', async () => ({ ok: (await page.evaluate(NAV_CLICKABLE, ['开始使用'])) === true }), 20_000)
        await page.evaluate(CLICK_NAV, ['开始使用'])
        await pollUntil('「试试看！」按钮可点', async () => ({ ok: (await page.evaluate(ELEMENT_CLICKABLE, ['试试看！'])) === true }), 20_000)
        await page.evaluate(CLICK_TOPMOST, ['试试看！'])
        await pollUntil('确认框出现(是)', async () => ({ ok: (await page.evaluate(ELEMENT_CLICKABLE, ['是'])) === true }), 10_000)
        await page.evaluate(CLICK_TOPMOST, ['是'])
        await pollUntil('成功提示出现(数据加载成功)', async () => ({ ok: (await page.evaluate(BODY_TEXT)).includes('数据加载成功') }), 20_000)
        return { harvest: await page.evaluate(HARVEST_SAVE) }
      },
    )

    {
      const c = caseTracker('global.gettingStarted.loadSample', 1)
      const mcpSide = JSON.parse(readFileSync(sampleExportPath, 'utf8'))
      const diff = deepDiff(tryItSide.harvest, mcpSide)
      c.check(
        '网页「试一试」后的存档与 load_save(sample=true) 导出逐键一致',
        diff == null,
        diff ? diff.join(' | ').slice(0, 200) : `${Object.keys(tryItSide.harvest).length} 个顶层键逐键相等`,
      )
      c.check(
        '试一经确认框执行并整体替换(162/8 全量示例)',
        tryItSide.harvest.relics?.length === 162 && tryItSide.harvest.characters?.length === 8,
        `${tryItSide.harvest.relics?.length}/${tryItSide.harvest.characters?.length}`,
      )
    }

    await browserManager.close()
  } catch (e) {
    failures++
    console.error('Phase 2 (managed browser) 异常:', e)
  }

  // ══ Phase 3 — render 工具(服务器侧受管浏览器;脚本侧浏览器已关) ══════════
  try {
    await callTool(mcp, 'load_save', { path: saveCopyA })
    {
      const c = caseTracker('global.navigate.page', 2)
      const rendered = await callTool(mcp, 'render', { target: 'page', page: '#leaderboard' }, { timeout: 240_000 })
      c.check(
        'MCP 按页打开(render page=#leaderboard):URL hash 与网页点击侧边栏的结果一致,页面容器就绪后截图',
        rendered.page === '#leaderboard' && /\/hsr-optimizer\/leaderboard$/.test(rendered.url ?? '') && rendered.width > 0 && rendered.height > 0,
        `url=${rendered.url},${rendered.width}x${rendered.height}`,
      )
    }
    {
      const c = caseTracker('global.language.switch', 2)
      const card = await callTool(mcp, 'render', { target: 'character_card', characterId: '1212b1' }, { timeout: 240_000 })
      c.check(
        '同一受管浏览器运行环境按默认上下文渲染角色卡成功(网页相机导出链真跑)',
        card.width > 0 && card.height > 0 && card.bytes > 1000,
        `${card.width}x${card.height},${card.bytes} 字节(默认语言探测:${JSON.stringify(browserSide?.defaultLanguage ?? null)})`,
      )
    }
  } catch (e) {
    failures++
    console.error('Phase 3 (render 工具) 异常:', e)
  }

  // ══ Phase 4 — 破坏性场景(每场景全新临时目录 + 独立进程) ═════════════════
  // 场景 1:reset_all 擦写保护 + export_save 落盘(autosave case 2)
  try {
    const dir = makeScenarioDir('wipe-guard')
    const savePath = `${dir}/sample.json`
    copyFileSync(repoSampleSavePath, savePath)
    const server = spawnServer(`${dir}/localstorage.json`)
    await server.connect()
    try {
      const c = caseTracker('global.state.autosave', 2)
      await callTool(server.client, 'load_save', { path: savePath })
      await callTool(server.client, 'reset_all', {})
      await sleep(2400) // 让 1s 防抖写回尝试发生并被拦截
      const diskAfterReset = JSON.parse(readFileSync(savePath, 'utf8'))
      c.check(
        '集合被清空(reset_all)后自动写回被拦截:磁盘存档保持 162 件遗器 / 8 角色',
        diskAfterReset.relics?.length === 162 && diskAfterReset.characters?.length === 8,
        `磁盘 ${diskAfterReset.relics?.length} 遗器 / ${diskAfterReset.characters?.length} 角色`,
      )
      const status = await callTool(server.client, 'save_status', {})
      c.check(
        '拦截在 save_status.blockedWrite 中报告(且 dirty 保持 true)',
        status.dirty === true && status.blockedWrite != null && typeof status.blockedWrite.reason === 'string' && status.blockedWrite.reason.length > 0,
        `dirty=${String(status.dirty)},blockedWrite=${status.blockedWrite ? JSON.stringify(status.blockedWrite) : '缺失'}`,
      )
      const emptyPath = `${dir}/empty-export.json`
      await callTool(server.client, 'export_save', { path: emptyPath })
      const emptyDisk = JSON.parse(readFileSync(emptyPath, 'utf8'))
      c.check(
        'export_save 才能落盘:刻意清空写到显式目标(空集合存档合法)',
        Array.isArray(emptyDisk.relics) && emptyDisk.relics.length === 0 && Array.isArray(emptyDisk.characters) && emptyDisk.characters.length === 0,
        `${emptyDisk.relics?.length} 遗器 / ${emptyDisk.characters?.length} 角色`,
      )
    } finally {
      await server.client.close()
    }
    await sleep(2000)
  } catch (e) {
    failures++
    console.error('Phase 4 场景 1(reset_all 护栏) 异常:', e)
  }

  // 场景 2:进程重启 bootLoad 恢复(bootLoad case 2)
  try {
    const dir = makeScenarioDir('restart')
    const stateFile = `${dir}/localstorage.json`
    const savePath = `${dir}/sample.json`
    copyFileSync(repoSampleSavePath, savePath)
    const first = spawnServer(stateFile)
    await first.connect()
    let preRestart = null
    try {
      await callTool(first.client, 'load_save', { path: savePath })
      await callTool(first.client, 'save_team', { name: 'restart-probe', characterIds: ['1212'] })
      preRestart = await callTool(first.client, 'save_status', {})
      await sleep(1600) // 防抖写回落盘
    } finally {
      await first.client.close()
    }
    await sleep(2500) // EOF 干净退出(含关停 flush)
    const second = spawnServer(stateFile) // 不带任何存档路径
    await second.connect()
    try {
      const c = caseTracker('global.state.bootLoad', 2)
      const status = await callTool(second.client, 'save_status', {})
      c.check(
        'MCP 进程重启后不带路径恢复上次存档(bootLoaded=true、path=null)',
        status.loaded === true && status.bootLoaded === true && status.path === null,
        `loaded=${String(status.loaded)},bootLoaded=${String(status.bootLoaded)},path=${status.path}`,
      )
      c.check(
        `角色数与遗器数与重启前一致(${preRestart.relics}/${preRestart.characters})`,
        status.relics === preRestart.relics && status.characters === preRestart.characters && JSON.stringify(status.characterIds) === JSON.stringify(preRestart.characterIds),
        `${status.relics}/${status.characters} vs ${preRestart.relics}/${preRestart.characters}`,
      )
    } finally {
      await second.client.close()
    }
    await sleep(2000)
  } catch (e) {
    failures++
    console.error('Phase 4 场景 2(重启恢复) 异常:', e)
  }

  // 场景 3:仓库外安装目录载入样例(gettingStarted case 1 的仓库外子句)
  try {
    const dir = makeScenarioDir('outside-repo')
    const server = spawnServer(`${dir}/localstorage.json`, dir) // cwd = 仓库外临时目录
    await server.connect()
    try {
      const c = caseTracker('global.gettingStarted.loadSample', 1)
      const loaded = await callTool(server.client, 'load_save', { sample: true })
      c.check(
        '服务器工作目录在仓库外(便携安装形态)时 sample=true 同样可用(示例存档内嵌于构建产物)',
        loaded.sample === true && loaded.relics === 162 && loaded.characters === 8,
        `cwd=${dir},${loaded.relics}/${loaded.characters}`,
      )
    } finally {
      await server.client.close()
    }
    await sleep(1500)
  } catch (e) {
    failures++
    console.error('Phase 4 场景 3(仓库外样例) 异常:', e)
  }

  // ══ 主服务器收尾 ══════════════════════════════════════════════════════════
  try {
    await mcp.close()
  } catch { /* already closed */ }
}

try {
  await main()
} catch (e) {
  failures++
  console.error('verify-global 顶层异常:', e)
}

// ══ evidence 汇总写出 ═══════════════════════════════════════════════════════
const cases = writeEvidence()
const passCount = cases.filter((x) => x.result === 'PASS').length
console.log(`\nverify-global: ${passCount}/${cases.length} case PASS`)
for (const item of cases.filter((x) => x.result !== 'PASS')) {
  console.log(`  ${item.result} ${item.feature}#${item.case} — ${item.detail.slice(0, 160)}`)
}

if (!keepOnFailure || failures === 0) {
  rmSync(tempRoot, { recursive: true, force: true })
} else {
  console.log(`(临时工作区保留(失败调试):${tempRoot})`)
}

process.exit(failures === 0 ? 0 : 1)
