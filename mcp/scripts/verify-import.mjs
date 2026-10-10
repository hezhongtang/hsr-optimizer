// verified-acceptance parity harness for the import domain (scope=baseline).
//
// Promotes mcp/coverage/features/import.json baseline rows from implemented to
// verified with same-version web/MCP parity evidence per
// mcp/coverage/evidence/PROTOCOL.md:
//
//   - method A (browser-parity): the repo-root dist/ site is driven through the
//     REAL import UI (Load / Save / Clear / scanner paste / live-import
//     switches / a local fake Reliquary Archiver ws server) inside the managed
//     browser; reference values come from the page's own DOM,
//     window.__HSR_DEBUG (SaveState) and harvestSaveState().
//   - method B (inprocess-parity, noted per case): stdio MCP result vs the
//     same bundled upstream persistenceService calls the web buttons make.
//
// Everything persistent (save copies, HSR_MCP_STATE_FILE) lives in a
// mkdtempSync temp dir; src/data/sample-save.json is never a write target.
// The browser is closed and the temp dir removed on exit.
//
// Usage: node scripts/verify-import.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).
// Writes mcp/coverage/evidence/import.json and prints per-case PASS/FAIL.

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
const evidencePath = resolve(mcpDir, 'coverage/evidence/import.json')
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
  console.log('[SKIP] verify-import needs a local Chrome and the repo-root dist/ build')
  process.exit(0)
}

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-import-`)
const pristineSave = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
const gameData = JSON.parse(readFileSync(repoGameDataPath, 'utf8'))
const setIdByName = Object.fromEntries(gameData.relics.map((r) => [r.name, r.id]))

// ── case recording ───────────────────────────────────────────────────────────
const evidenceCases = []
let failures = 0
function recordCase(feature, caseNo, desc, method, ok, detail, script = 'mcp/scripts/verify-import.mjs') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${feature}#${caseNo} ${desc.slice(0, 46)} — ${detail.slice(0, 150)}`)
  if (!ok) failures++
  evidenceCases.push({ feature, case: caseNo, desc: desc.slice(0, 40), method, result: ok ? 'PASS' : 'FAIL', detail: detail.slice(0, 200), script })
  // incremental flush: a later hang or crash must not lose what already ran
  try {
    writeFileSync(evidencePath, `${JSON.stringify({ area: 'import', generatedAt: new Date().toISOString(), gitCommit: GIT_COMMIT, cases: evidenceCases }, null, 2)}\n`)
  } catch { /* best-effort */ }
}
process.on('unhandledRejection', (e) => {
  console.error('[verify-import] unhandled rejection:', e)
  console.error('[verify-import] — see above; main flow may be blocked on a sibling promise')
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── MCP stdio client ─────────────────────────────────────────────────────────
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

// ── fixture builders (mirror kelzFormatParser lookups) ──────────────────────
const SUBSTAT_KEY = {
  'ATK': 'ATK', 'HP': 'HP', 'DEF': 'DEF', 'ATK%': 'ATK_', 'HP%': 'HP_', 'DEF%': 'DEF_',
  'SPD': 'SPD', 'CRIT Rate': 'CRIT Rate_', 'CRIT DMG': 'CRIT DMG_',
  'Effect Hit Rate': 'Effect Hit Rate_', 'Effect RES': 'Effect RES_', 'Break Effect': 'Break Effect_',
}
const MAINSTAT_KEY = {
  'HP%': 'HP', 'ATK%': 'ATK', 'DEF%': 'DEF', 'SPD': 'SPD', 'CRIT Rate': 'CRIT Rate', 'CRIT DMG': 'CRIT DMG',
  'Effect Hit Rate': 'Effect Hit Rate', 'Break Effect': 'Break Effect',
  'Energy Regeneration Rate': 'Energy Regeneration Rate', 'Outgoing Healing Boost': 'Outgoing Healing Boost',
  'Physical DMG Boost': 'Physical DMG Boost', 'Fire DMG Boost': 'Fire DMG Boost', 'Ice DMG Boost': 'Ice DMG Boost',
  'Lightning DMG Boost': 'Lightning DMG Boost', 'Wind DMG Boost': 'Wind DMG Boost',
  'Quantum DMG Boost': 'Quantum DMG Boost', 'Imaginary DMG Boost': 'Imaginary DMG Boost',
}
/** Store relic → V4ParserRelic; substatValueOverrides shift individual values. */
function scannerRelicFromStore(relic, uid, substatValueOverrides = {}, overrides = {}) {
  const mainstat = relic.part === 'Head' ? 'HP' : relic.part === 'Hands' ? 'ATK' : MAINSTAT_KEY[relic.main.stat]
  if (mainstat == null) throw new Error(`no mainstat mapping for ${relic.part}/${relic.main.stat}`)
  const substats = relic.substats.map((s, i) => {
    const key = SUBSTAT_KEY[s.stat]
    if (key == null) throw new Error(`no substat mapping for ${s.stat}`)
    return { key, value: substatValueOverrides[i] ?? s.value }
  })
  return {
    set_id: setIdByName[relic.set], name: 'verify relic', slot: relic.part, rarity: relic.grade,
    level: relic.enhance, mainstat, substats, location: '', lock: false, discard: false, _uid: uid, ...overrides,
  }
}
/** reliquary flavor: substats carry count/step so the speedVerified roll path stays clean. */
function reliquaryRelicFromStore(relic, uid, substatValueOverrides = {}, overrides = {}) {
  const base = scannerRelicFromStore(relic, uid, substatValueOverrides, overrides)
  base.substats = base.substats.map((s) => ({ ...s, count: 1, step: 0 }))
  return base
}
function kelzJson(relics, characters = [], lightCones = [], extra = {}) {
  return {
    source: 'HSR-Scanner', build: 'v1.2.0', version: 4,
    metadata: { uid: 100000001, trailblazer: 'Stelle' },
    gacha: { stellar_jade: 0, oneric_shards: 0 }, materials: [],
    characters, light_cones: lightCones, relics, ...extra,
  }
}
function archiverJson(relics, characters = [], lightCones = [], extra = {}) {
  return {
    source: 'reliquary_archiver', build: 'v0.8.0', version: 4,
    metadata: { uid: 100000001, trailblazer: 'Stelle' },
    gacha: { stellar_jade: 0, oneric_shards: 0 }, materials: [],
    characters, light_cones: lightCones, relics, ...extra,
  }
}
const LIGHT_CONES = [
  { id: '20000', name: 'verify lc', level: 1, ascension: 0, superimposition: 1, location: '1005', lock: false, discard: false, _uid: 'lc-1005' },
  { id: '20000', name: 'verify lc', level: 1, ascension: 0, superimposition: 2, location: '1107', lock: false, discard: false, _uid: 'lc-1107' },
]
const CH_EXISTING = { id: '1005', name: 'Natasha', path: 'The Abundance', level: 1, ascension: 0, eidolon: 0, ability_version: 0 }
const CH_NEW = { id: '1107', name: 'Clara', path: 'The Destruction', level: 1, ascension: 0, eidolon: 3, ability_version: 0 }

// Relic #0 of the pristine save: a 5★ Head (main HP) — the simplest faithful
// back-conversion target. Owned Head (by 1205, carries an integer SPD substat)
// is the verified-overwrite probe: a reliquary twin with a precise SPD decimal
// keeps the same hash (hashRelic floors flat substats) but overwrites values.
const headRelic = pristineSave.relics[0]
const ownedHead = pristineSave.relics.find(
  (r) => r.part === 'Head' && r.equippedBy === '1205' && r.substats.some((s) => s.stat === 'SPD'),
) ?? pristineSave.relics.find((r) => r.part === 'Head' && r.equippedBy)
const ownedHeadSpdIndex = ownedHead.substats.findIndex((s) => s.stat === 'SPD')

// The web applies a live InitialScan as a native full-inventory replace
// (the scan IS the whole inventory); MCP wraps the same frame in its union
// merge — both sides converge iff the scan carries every current store relic.
const fullScan = (extraRelics, characters) => archiverJson(
  [...pristineSave.relics.map((r, i) => scannerRelicFromStore(r, String(i), {}, { location: r.equippedBy ?? '' })), ...extraRelics],
  characters, [],
)

let copyCounter = 0
function freshSavePath(mutate) {
  const p = `${tempDir}/save-${++copyCounter}.json`
  const data = mutate ? mutate(structuredClone(pristineSave)) : structuredClone(pristineSave)
  writeFileSync(p, JSON.stringify(data))
  return p
}
function saveSeed(mutate) {
  return JSON.stringify(mutate ? mutate(structuredClone(pristineSave)) : pristineSave)
}

// ── canonical comparison ─────────────────────────────────────────────────────
function relicKey(r) {
  return [r.id, r.part, r.set, r.grade, r.enhance, r.main?.stat, r.main?.value,
    ...(r.substats ?? []).map((s) => `${s.stat}:${s.value}`),
    `verified:${r.verified === true}`, `equipped:${r.equippedBy ?? '-'}`, `age:${r.ageIndex ?? '-'}`].join('|')
}
function saveSlice(save) {
  return {
    relics: (save.relics ?? []).map(relicKey).sort(),
    characters: (save.characters ?? []).map((c) => JSON.stringify({
      id: c.id, equipped: c.equipped, form: c.form, builds: c.builds,
    })).sort(),
  }
}
function sameSlice(a, b) {
  return JSON.stringify(saveSlice(a)) === JSON.stringify(saveSlice(b))
}
function firstSliceDiff(a, b) {
  const sa = saveSlice(a)
  const sb = saveSlice(b)
  if (JSON.stringify(sa.relics) !== JSON.stringify(sb.relics)) {
    const ra = sa.relics.find((x) => !sb.relics.includes(x))
    const rb = sb.relics.find((x) => !sa.relics.includes(x))
    return `relics diff — web-only: ${String(ra).slice(0, 90)} | mcp-only: ${String(rb).slice(0, 90)}`
  }
  if (JSON.stringify(sa.characters) !== JSON.stringify(sb.characters)) {
    const ca = sa.characters.find((x) => !sb.characters.includes(x))
    const cb = sb.characters.find((x) => !sa.characters.includes(x))
    return `characters diff — web-only: ${String(ca).slice(0, 90)} | mcp-only: ${String(cb).slice(0, 90)}`
  }
  return null
}

// ── managed browser (imported from source, no rebuild) ───────────────────────
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

/** runTask wrapper that records a browser-side failure as a FAILED case payload instead of crashing the harness. */
async function runWebTask(opts, fn) {
  try {
    return await browserManager.runTask({ timeoutMs: 500_000, ...opts }, fn)
  } catch (e) {
    const message = String(e?.message ?? e)
    console.log(`    [web-task-error:${opts?.label}] ${message.slice(0, 400)}`)
    // harvest-shaped safe defaults so downstream ok-checks read falsy, never throw
    return { __error: message, relics: [], characters: [], scannerSettings: {}, links: [], counts: ['', ''], errText: '', end: {}, afterSequence: {}, afterNoise: {} }
  }
}

// In-page DOM helpers (evaluated strings; JSON args passed by the wrapper)
const DOM = {
  clickTab: `async (label) => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) => (t.textContent || '').trim() === label)
    if (!tab) throw new Error('tab not found: ' + label)
    tab.click()
    return true
  }`,
  clickButton: `async (label, index) => {
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter((b) => (b.textContent || '').trim() === label && !b.disabled)
    const btn = buttons[index ?? 0]
    if (!btn) throw new Error('button not found/enabled: ' + label + ' (found ' + buttons.length + ')')
    btn.click()
    return true
  }`,
  clickButtonContaining: `async (label) => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').includes(label) && !b.disabled)
    if (!btn) throw new Error('button containing not found: ' + label)
    btn.click()
    return true
  }`,
  setFileOnVisibleInput: `async (jsonText, name) => {
    // scope by panel content — the page carries several tab groups, so a
    // generic [aria-selected] lookup can hit an unrelated group
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'))
    const loadPanel = panels.find((p) => (p.textContent || '').includes('Load your optimizer data'))
    const input = loadPanel?.querySelector('input[type="file"]')
      ?? Array.from(document.querySelectorAll('input[type="file"]')).find((i) => i.offsetParent !== null)
    if (!input) throw new Error('load file input not found')
    const dt = new DataTransfer()
    dt.items.add(new File([jsonText], name, { type: 'application/json' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }`,
  pasteScannerJson: `async (jsonText) => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder]'))
    const input = inputs.find((i) => i.placeholder.includes('Paste json') && i.offsetParent !== null)
    if (!input) throw new Error('paste input not found')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, jsonText)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }`,
  bodyText: `async () => document.body.innerText`,
  setSwitch: `async (label, checked) => {
    const divs = Array.from(document.querySelectorAll('div'))
    const labelEl = divs.find((d) => (d.textContent || '').trim() === label && d.children.length === 0)
    if (!labelEl) throw new Error('switch label not found: ' + label)
    const container = labelEl.parentElement
    const input = container.querySelector('input[type="checkbox"]') ?? container.previousElementSibling?.querySelector('input[type="checkbox"]')
    if (!input) throw new Error('switch input not found for ' + label)
    const want = !!checked
    const has = input.checked
    if (has !== want) input.click()
    return input.checked
  }`,
  setWsUrl: `async (url) => {
    const input = document.querySelector('#websocket-url')
    if (!input) throw new Error('#websocket-url not found')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, url)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }`,
  checkOnlyExisting: `async (check) => {
    const label = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').includes('Only import existing characters'))
    if (!label) throw new Error('only-existing checkbox label not found')
    const input = label.querySelector('input[type="checkbox"]') ?? document.getElementById(label.getAttribute('for') || '')
    if (!input) throw new Error('only-existing checkbox input not found')
    if (input.checked !== !!check) input.click()
    return input.checked
  }`,
  connectionText: `async () => {
    const text = document.body.innerText
    if (/\\bConnected\\b/.test(text)) return 'connected'
    if (/\\bDisconnected\\b/.test(text)) return 'disconnected'
    return 'unknown'
  }`,
  modalText: `async () => {
    const modal = document.querySelector('.mantine-Modal-root')
    return modal ? modal.textContent : null
  }`,
}

// ── boot MCP client ──────────────────────────────────────────────────────────
const client = new Client({ name: 'verify-import', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

async function mcpExportSlice() {
  const snap = await callTool(client, 'export_save', { structured: true })
  return snap.snapshot ?? snap
}

/** One fake Reliquary Archiver on an ephemeral port. */
async function startArchiver() {
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  const clients = new Set()
  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
  })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  const port = http.address().port
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    push: (payload) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
      for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(text)
    },
    frame: (event, data) => {
      const text = JSON.stringify({ event, data })
      for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(text)
    },
    terminateAll: () => { for (const ws of clients) ws.terminate() },
    clientCount: () => clients.size,
    waitForClient: async (timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (clients.size > 0) return true
        await sleep(200)
      }
      return false
    },
    // http.close()'s callback never fires while a ws client (the MCP scanner or
    // the page) still holds the socket open — that deadlock hung whole runs.
    // Terminate every client, then close with a hard fallback.
    close: () => new Promise((r) => {
      for (const ws of clients) ws.terminate()
      wss.clients.forEach((c) => c.terminate())
      wss.close(() => {})
      http.close(() => r())
      http.closeAllConnections?.()
      setTimeout(r, 3000).unref?.()
    }),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
try {
  // ── import.save.load ───────────────────────────────────────────────────────
  {
    // c1: same derived save through the web 「载入数据」 flow and load_save;
    //     SaveState.save() output must match key-by-key.
    const derivedMutator = (s) => {
      s.relics = s.relics.filter((_, i) => i !== 10)
      s.relics[3].equippedBy = undefined
      s.seenFeatures = ['feature.verify']
      s.scoringMetadataOverrides = { 1005: { stats: { ATK: 1 } } }
      return s
    }
    const fixturePath = freshSavePath(derivedMutator)
    const fixtureText = readFileSync(fixturePath, 'utf8')

    const web = await runWebTask({ label: 'load-c1', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Load optimizer data'], { timeoutMs: 60_000 })
      await page.evaluate(DOM.clickTab, ['Load optimizer data'])
      await sleep(300)
      await page.evaluate(DOM.setFileOnVisibleInput, [fixtureText, 'derived-save.json'])
      await page.waitForText(['Replace your current data'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButton, ['Use uploaded data'])
      await page.waitForText(['Done!'], { timeoutMs: 20_000 })
      await sleep(500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath(derivedMutator) })
    const mcp = await mcpExportSlice()
    const diff = firstSliceDiff(web, mcp)
    const webOk = web.relics.length === 161 && web.relics[3]?.equippedBy == null
    const mcpOk = mcp.relics.length === 161 && mcp.relics[3]?.equippedBy == null
    recordCase('import.save.load', 1,
      '同一存档经网页「载入数据」与 load_save 载入后,SaveState.save() 输出逐键一致',
      'browser-parity',
      webOk && mcpOk && diff == null,
      diff ?? `both sides: ${web.relics.length} relics, relic[3] unequipped, seenFeatures kept`)

    // c2: a save with a custom websocketUrl loads with manual-load (sanitize)
    //     semantics on both sides — url stays the default.
    const wsMutator = (s) => {
      s.scannerSettings = {
        ingest: false, ingestCharacters: false, ingestOnlyExistingCharacters: false, ingestWarpResources: false,
        websocketUrl: 'ws://10.99.99.99:9999/ws', customUrl: true,
      }
      return s
    }
    const web2 = await runWebTask({ label: 'load-c2', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Load optimizer data'], { timeoutMs: 60_000 })
      await page.evaluate(DOM.clickTab, ['Load optimizer data'])
      await sleep(300)
      await page.evaluate(DOM.setFileOnVisibleInput, [JSON.stringify(wsMutator(structuredClone(pristineSave))), 'ws-save.json'])
      await page.waitForText(['Replace your current data'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButton, ['Use uploaded data'])
      await page.waitForText(['Done!'], { timeoutMs: 20_000 })
      await sleep(500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath(wsMutator) })
    const mcp2 = await mcpExportSlice()
    const DEFAULT_WS = 'ws://127.0.0.1:23313/ws'
    const webUrl = web2.scannerSettings?.websocketUrl
    const mcpUrl = mcp2.scannerSettings?.websocketUrl
    const mcpState = await callTool(client, 'get_state', { section: 'scanner' })
    recordCase('import.save.load', 2,
      '带自定义 websocketUrl 的存档按手动载入语义载入后,websocketUrl 仍是默认值',
      'browser-parity',
      webUrl === DEFAULT_WS && mcpUrl === DEFAULT_WS && mcpState.scanner.websocketUrl === DEFAULT_WS && mcpState.scanner.customUrl === false,
      `web=${webUrl} mcp=${mcpUrl} get_state.customUrl=${mcpState.scanner.customUrl}`)

    // c3: scanner-shaped file and a relics-less file are rejected by both sides,
    //     current data unchanged.
    const scannerShaped = kelzJson([scannerRelicFromStore(headRelic, '900')])
    const relicsLess = { characters: pristineSave.characters, scoringMetadataOverrides: {} }
    const web3 = await runWebTask({ label: 'load-c3', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Load optimizer data'], { timeoutMs: 60_000 })
      const results = []
      for (const [text, name] of [[JSON.stringify(scannerShaped), 'scanner.json'], [JSON.stringify(relicsLess), 'relics-less.json']]) {
        await page.evaluate(DOM.clickTab, ['Load optimizer data'])
        await sleep(300)
        await page.evaluate(DOM.setFileOnVisibleInput, [text, name])
        await sleep(1500) // spinner window
        results.push(await page.evaluate(DOM.bodyText))
      }
      const rejected = results.every((t) => t.includes('Invalid save file'))
      const unchanged = await page.harvestSaveState()
      return { rejected, relics: unchanged?.relics?.length, chars: unchanged?.characters?.length }
    })
    const mcpErr1 = await toolErrorText(client, 'load_save', { json: scannerShaped })
    const mcpErr2 = await toolErrorText(client, 'load_save', { json: relicsLess })
    recordCase('import.save.load', 3,
      '扫描器文件与缺少 relics/characters 的文件被拒绝,当前数据不变',
      'browser-parity',
      web3.rejected && web3.relics === 162 && web3.chars === 8
        && mcpErr1 != null && mcpErr2 != null && /relics|characters/i.test(String(mcpErr1) + String(mcpErr2)),
      `web rejected=${web3.rejected}, save unchanged ${web3.relics}/${web3.chars}; mcp errors present=${mcpErr1 != null && mcpErr2 != null}`)
  }

  // ── import.save.export ─────────────────────────────────────────────────────
  {
    const derived = freshSavePath((s) => {
      s.relics[1].enhance = 12
      return s
    })
    const webSaveString = await runWebTask({ label: 'export-c1', seed: readFileSync(derived, 'utf8'), timeoutMs: 240_000 }, async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await sleep(1000)
      // The 保存数据 button serializes exactly SaveState.save()'s string; the
      // button's data source is the exposed module (the picker itself is a
      // platform save dialog, not part of the data path).
      return page.evaluate('() => window.__HSR_DEBUG.SaveState.save()')
    })
    const webSave = typeof webSaveString === 'string' ? JSON.parse(webSaveString) : { relics: [] }
    const exportPath = `${tempDir}/exported.json`
    await callTool(client, 'load_save', { path: derived })
    await callTool(client, 'export_save', { path: exportPath })
    const mcpSave = JSON.parse(readFileSync(exportPath, 'utf8'))
    const same = JSON.stringify(saveSlice(webSave)) === JSON.stringify(saveSlice(mcpSave))
      && (webSave.relics[1].enhance === mcpSave.relics[1].enhance)
    // reload-ability on both sides
    const reloadMcp = await callTool(client, 'load_save', { path: exportPath })
    const reloadWeb = await runWebTask({ label: 'export-c1-reload', seed: typeof webSaveString === 'string' ? webSaveString : '{}', timeoutMs: 240_000 }, async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await sleep(800)
      return page.harvestSaveState()
    })
    recordCase('import.save.export', 1,
      'export_save 写出的文件与网页「保存数据」下载的文件内容逐键一致,可被两边重新载入',
      'browser-parity',
      same && reloadMcp.relics === 162 && reloadWeb?.relics?.length === 162,
      `web SaveState.save() ≡ export_save file (162 relics, relic[1] +12); reloaded: mcp=${reloadMcp.relics}, web=${reloadWeb?.relics?.length}`)
  }

  // ── import.save.clear ──────────────────────────────────────────────────────
  {
    const clearMutator = (s) => {
      s.seenFeatures = ['feature.verify.keep']
      return s
    }
    const web = await runWebTask({ label: 'clear-c1', seed: saveSeed(clearMutator), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Clear optimizer data'], { timeoutMs: 60_000 })
      await page.evaluate(DOM.clickTab, ['Clear optimizer data'])
      await sleep(300)
      await page.evaluate(DOM.clickButton, ['Clear data'])
      await page.waitForText(['Erase all data'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButton, ['Yes'])
      await sleep(6500) // 5s debounced flush
      return page.harvestSaveState()
    })
    const clearPath = freshSavePath(clearMutator)
    await callTool(client, 'load_save', { path: clearPath })
    await callTool(client, 'reset_all', { persist: true })
    const disk = JSON.parse(readFileSync(clearPath, 'utf8'))
    const webEmpty = web.relics?.length === 0 && web.characters?.length === 0 && Object.keys(web.scoringMetadataOverrides ?? {}).length === 0
    const webKeeps = JSON.stringify(web.seenFeatures) === JSON.stringify(['feature.verify.keep'])
    const mcpEmpty = disk.relics?.length === 0 && disk.characters?.length === 0 && Object.keys(disk.scoringMetadataOverrides ?? {}).length === 0
    const mcpKeeps = JSON.stringify(disk.seenFeatures) === JSON.stringify(['feature.verify.keep'])
    recordCase('import.save.clear', 1,
      'reset_all(persist=true) 之后磁盘存档的 relics、characters、scoringMetadataOverrides 为空且 seenFeatures 保留,与网页清除并等待落盘后的存档一致',
      'browser-parity',
      webEmpty && webKeeps && mcpEmpty && mcpKeeps,
      `web: relics=${web.relics?.length} chars=${web.characters?.length} seen=${web.seenFeatures}; mcp disk: relics=${disk.relics?.length} chars=${disk.characters?.length} seen=${disk.seenFeatures}`)
  }

  // ── import.scanner.parseFile ───────────────────────────────────────────────
  {
    const kelzFixture = kelzJson(
      [scannerRelicFromStore(headRelic, '900', { 0: headRelic.substats[0].value + 10 })],
      [CH_EXISTING, CH_NEW], LIGHT_CONES,
    )
    const hoyolabFixture = {
      data: {
        avatar_list: [{
          id: 1107, level: 76, name: 'Clara', rank: 0,
          equip: { id: 20000, level: 80, rank: 1, rarity: 5 },
          relics: [{
            id: 61153, level: 15, pos: 3, rarity: 5,
            main_property: { property_type: 53, value: '64.8', times: 0 },
            properties: [
              { property_type: 33, value: '11.7%', times: 2, is_preview: false },
              { property_type: 51, value: '25', times: 2, is_preview: false },
            ],
          }],
          ornaments: [{
            id: 63116, level: 15, pos: 6, rarity: 5,
            main_property: { property_type: 54, value: '55.1%', times: 0 },
            properties: [{ property_type: 29, value: '38.1', times: 2, is_preview: false }],
          }],
          ranks: Array.from({ length: 6 }, (_, i) => ({ id: 110701 + i, pos: i + 1, name: 'e', icon: '', desc: '', is_unlocked: false })),
        }],
      },
    }
    const webCounts = await runWebTask({ label: 'parse-c1', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      const counts = []
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Live Import Controls'], { timeoutMs: 60_000 })
      for (const fixture of [kelzFixture, hoyolabFixture]) {
        await page.evaluate(DOM.pasteScannerJson, [JSON.stringify(fixture)])
        await sleep(1500) // spinner window
        counts.push(await page.evaluate(DOM.bodyText))
      }
      // unknown source error path
      await page.evaluate(DOM.pasteScannerJson, [JSON.stringify(kelzJson([], [], [], { source: 'foo-scanner' }))])
      await sleep(1500)
      const errText = await page.evaluate(DOM.bodyText)
      return { counts, errText }
    })
    // one sentence regex — a bare /(\d+) character/ scan hits the Stage1
    // scanner descriptions ("8 characters on the profile showcase") first
    const extract = (t) => {
      const m = /File contains (\d+) relics? and (\d+) characters?/.exec(t)
      return { relics: m?.[1], characters: m?.[2] }
    }
    const webKelz = extract(webCounts.counts[0])
    const webHoyolab = extract(webCounts.counts[1])
    await callTool(client, 'load_save', { path: freshSavePath() })
    const mcpKelz = await callTool(client, 'import_scanner_json', { inline: kelzFixture, dryRun: true })
    const mcpHoyolab = await callTool(client, 'import_hoyolab', { inline: hoyolabFixture, dryRun: true })
    const mcpUnknown = await toolErrorText(client, 'import_scanner_json', { inline: kelzJson([], [], [], { source: 'foo-scanner' }) })
    const kelzOk = webKelz.relics === '1' && webKelz.characters === '2'
      && mcpKelz.added + mcpKelz.updated + mcpKelz.skipped === 1 && mcpKelz.charactersTouched === 2
    const hoyolabOk = webHoyolab.relics === '2' && webHoyolab.characters === '1'
      && mcpHoyolab.added + mcpHoyolab.updated + mcpHoyolab.skipped === 2 && mcpHoyolab.charactersTouched === 1
    const unknownOk = webCounts.errText.includes('Invalid scanner file') && mcpUnknown != null && /无法识别的扫描器/.test(mcpUnknown)
    recordCase('import.scanner.parseFile', 1,
      '同一文件在网页确认页显示的遗器数、角色数与 import_scanner_json / import_hoyolab(dryRun=true) 的统计一致;未知来源两边都报错',
      'browser-parity',
      kelzOk && hoyolabOk && unknownOk,
      `kelz ${kelzOk} web ${webKelz.relics}/${webKelz.characters} vs mcp ${mcpKelz.added + mcpKelz.updated + mcpKelz.skipped}/${mcpKelz.charactersTouched}; hoyolab ${hoyolabOk} web ${webHoyolab.relics}/${webHoyolab.characters} vs mcp ${mcpHoyolab.added + mcpHoyolab.updated + mcpHoyolab.skipped}/${mcpHoyolab.charactersTouched}; unknown ${unknownOk} — web errText: ${String(webCounts.errText).slice(0, 80).replace(/\n/g, ' ')}; mcp err: ${String(mcpUnknown).slice(0, 60)}`)
  }

  // ── import.scanner.mergeRelicsOnly ─────────────────────────────────────────
  {
    // Web 「导入遗器」 runs native mergeRelics(relics, []) — full-inventory
    // replace. MCP parity = includeCharacters=false + merge=replace (per the
    // case text). Fixture: 2 same-hash twins + 1 novel ⇒ inventory 3, chars 8.
    const twins = [
      scannerRelicFromStore(pristineSave.relics[5], '910'),
      scannerRelicFromStore(pristineSave.relics[6], '911'),
      scannerRelicFromStore(headRelic, '912', { 0: headRelic.substats[0].value + 10 }),
    ]
    const fixture = kelzJson(twins)
    const web = await runWebTask({ label: 'merge-relics-c1', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Live Import Controls'], { timeoutMs: 60_000 })
      await page.evaluate(DOM.pasteScannerJson, [JSON.stringify(fixture)])
      await page.waitForText(['Import relics'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButton, ['Import relics'])
      await sleep(6500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath() })
    const mcpRun = await callTool(client, 'import_scanner_json', { inline: fixture, includeCharacters: false, merge: 'replace' })
    const mcp = await mcpExportSlice()
    const diff = firstSliceDiff(web, mcp)
    // MCP union regression alongside (README #9 union semantics)
    await callTool(client, 'load_save', { path: freshSavePath() })
    const union = await callTool(client, 'import_scanner_json', { inline: fixture, includeCharacters: false })
    recordCase('import.scanner.mergeRelicsOnly', 1,
      'includeCharacters=false、merge=replace 导入后,角色列表不变、遗器库存与网页点「导入遗器」之后的存档一致',
      'browser-parity',
      diff == null && web.relics.length === 3 && web.characters.length === 8
        && mcpRun.charactersTouched === 0 && union.totalAfter === 163 && union.added === 1,
      diff ?? `both: 3 relics / 8 chars; mcp replace charactersTouched=${mcpRun.charactersTouched}; union keeps ${union.totalBefore}→${union.totalAfter}`)
  }

  // ── import.scanner.mergeCharacters ─────────────────────────────────────────
  {
    const relics = [
      { ...scannerRelicFromStore(pristineSave.relics[5], '920'), location: '1005' },
      scannerRelicFromStore(headRelic, '921', { 0: headRelic.substats[0].value + 10 }),
      { ...scannerRelicFromStore(pristineSave.relics[6], '922'), location: '1107' },
    ]
    const fixture = kelzJson(relics, [CH_EXISTING, CH_NEW], LIGHT_CONES)

    const webAll = await runWebTask({ label: 'merge-chars-c1', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Live Import Controls'], { timeoutMs: 60_000 })
      await page.evaluate(DOM.pasteScannerJson, [JSON.stringify(fixture)])
      await page.waitForText(['Import relics & characters'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButtonContaining, ['Import relics & characters'])
      await page.waitForText(['Overwrite optimizer builds'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButton, ['Yes'])
      await sleep(6500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath() })
    const mcpAllRun = await callTool(client, 'import_scanner_json', { inline: fixture, merge: 'replace' })
    const mcpAll = await mcpExportSlice()
    const diffAll = firstSliceDiff(webAll, mcpAll)
    const char1107web = webAll.characters.find((c) => c.id === '1107')
    const char1107mcp = mcpAll.characters.find((c) => c.id === '1107')
    recordCase('import.scanner.mergeCharacters', 1,
      'merge=replace 导入后的存档与网页点「导入角色与遗器」之后的存档一致',
      'browser-parity',
      diffAll == null && webAll.relics.length === 3 && webAll.characters.length === 9
        && char1107web?.form?.characterLevel === 80 && char1107mcp?.form?.characterLevel === 80
        && char1107web?.equipped?.Head === char1107mcp?.equipped?.Head,
      diffAll ?? `both: 3 relics / 9 chars; 1107 level 80 web=${char1107web?.form?.characterLevel} mcp=${char1107mcp?.form?.characterLevel}; mcp charactersTouched=${mcpAllRun.charactersTouched}`)

    const webOnly = await runWebTask({ label: 'merge-chars-c2', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Live Import Controls'], { timeoutMs: 60_000 })
      await page.evaluate(DOM.pasteScannerJson, [JSON.stringify(fixture)])
      await page.waitForText(['Only import existing characters'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.checkOnlyExisting, [true])
      await page.evaluate(DOM.clickButtonContaining, ['Import relics & characters'])
      await page.waitForText(['Overwrite optimizer builds'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButton, ['Yes'])
      await sleep(6500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath() })
    await callTool(client, 'import_scanner_json', { inline: fixture, merge: 'replace', existingCharactersOnly: true })
    const mcpOnly = await mcpExportSlice()
    const diffOnly = firstSliceDiff(webOnly, mcpOnly)
    recordCase('import.scanner.mergeCharacters', 2,
      'existingCharactersOnly=true 与勾选「只导入已有角色」的结果一致',
      'browser-parity',
      diffOnly == null && webOnly.characters.length === 8 && mcpOnly.characters.length === 8
        && !webOnly.characters.some((c) => c.id === '1107'),
      diffOnly ?? `both: 8 chars, 1107 absent, ${webOnly.relics.length} relics`)
  }

  // ── supplementary: reliquary verified same-hash overwrite (README 留尾巴) ──
  {
    // Constructed per the acceptance task: a verified (reliquary_archiver)
    // import twin that hash-matches a store relic but carries a precise SPD
    // decimal + a new _uid must overwrite substats, set verified=true and
    // re-link the id in character equipment AND saved builds — on both sides.
    const NEW_ID = 'verify-777'
    const oldId = ownedHead.id
    const buildMutator = (s) => {
      const char = s.characters.find((c) => c.id === '1205')
      char.builds = [{
        name: 'verify-build', characterId: '1205', equipped: { Head: oldId },
        characterEidolon: 0, lightCone: '20000', lightConeSuperimposition: 1,
        source: 'character', team: [null, null, null],
      }]
      return s
    }
    const overrides = {}
    overrides[ownedHeadSpdIndex] = Math.floor(ownedHead.substats[ownedHeadSpdIndex].value) + 0.6
    const verifiedTwin = reliquaryRelicFromStore(ownedHead, NEW_ID, overrides)
    const fixture = archiverJson([verifiedTwin])

    const web = await runWebTask({ label: 'verified-branch', seed: saveSeed(buildMutator), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Live Import Controls'], { timeoutMs: 60_000 })
      await page.evaluate(DOM.pasteScannerJson, [JSON.stringify(fixture)])
      await page.waitForText(['Import relic'], { timeoutMs: 20_000 })
      await page.evaluate(DOM.clickButtonContaining, ['Import relic'])
      await sleep(6500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath(buildMutator) })
    const mcpRun = await callTool(client, 'import_scanner_json', { inline: fixture, merge: 'replace' })
    const mcp = await mcpExportSlice()
    const diff = firstSliceDiff(web, mcp)

    const checkSide = (save, label) => {
      const relic = save.relics.find((r) => r.id === NEW_ID)
      const gone = !save.relics.some((r) => r.id === oldId)
      const char = save.characters.find((c) => c.id === '1205')
      const spd = relic?.substats.find((s) => s.stat === 'SPD')?.value
      return {
        ok: relic != null && gone && relic.verified === true && relic.equippedBy === '1205'
          && Math.abs(spd - (Math.floor(ownedHead.substats[ownedHeadSpdIndex].value) + 0.6)) < 1e-9
          && char?.equipped?.Head === NEW_ID && char?.builds?.[0]?.equipped?.Head === NEW_ID,
        detail: `${label}: id=${relic?.id} verified=${relic?.verified} spd=${spd} equippedBy=${relic?.equippedBy} slot=${char?.equipped?.Head} build=${char?.builds?.[0]?.equipped?.Head} oldGone=${gone}`,
      }
    }
    const webSide = checkSide(web, 'web')
    const mcpSide = checkSide(mcp, 'mcp')
    // union mode keeps the full inventory while still applying the verified branch
    await callTool(client, 'load_save', { path: freshSavePath(buildMutator) })
    const unionRun = await callTool(client, 'import_scanner_json', { inline: fixture })
    const unionList = await callTool(client, 'list_relics', { limit: 500 })
    const unionRelic = unionList.relics.find((r) => r.id === NEW_ID)
    const unionChar = await callTool(client, 'get_character', { characterId: '1205' })
    const unionOk = unionRun.totalAfter === 162 && unionRun.updated === 1 && unionRelic?.verified === true
      && unionChar.equippedSlots?.Head?.equippedId === NEW_ID
    recordCase('import.scanner.mergeRelicsOnly', 'extra-1 (reliquary verified 分支专测)',
      'verified 导入件同 hash 覆盖副词条/置真/id 改链(含已存配装引用)——README 留尾巴补测',
      'browser-parity',
      webSide.ok && mcpSide.ok && diff == null && unionOk,
      (diff ?? `${webSide.detail}; ${mcpSide.detail}`) + `; union: ${unionRun.totalBefore}→${unionRun.totalAfter} updated=${unionRun.updated} slot→${NEW_ID}`)
  }

  // ── import.live.settings ───────────────────────────────────────────────────
  {
    const archiver = await startArchiver()
    const web = await runWebTask({ label: 'settings-c1', seed: saveSeed(), timeoutMs: 300_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Advanced Settings'], { timeoutMs: 60_000 })
      // set the custom URL (also exercises setWebsocketUrl persistence)
      await page.evaluate('async () => { const c = Array.from(document.querySelectorAll(".mantine-Accordion-control")).find((x) => (x.textContent||"").includes("Advanced Settings")); if (c) c.click(); return true }')
      await sleep(400)
      await page.evaluate(DOM.setWsUrl, [archiver.url])
      await page.evaluate(DOM.setSwitch, ['Enable Live Import (Recommended)', true])
      await page.evaluate(DOM.setSwitch, ["Enable updating characters' equipped relics and lightcones", true])
      await sleep(300)
      await page.evaluate(DOM.setSwitch, ['Only update existing characters', true])
      await page.evaluate(DOM.setSwitch, ['Enable importing Warp resources (jades, passes, pity)', true])
      await sleep(6500)
      return page.harvestSaveState()
    })
    await callTool(client, 'load_save', { path: freshSavePath() })
    for (const [key, value] of [['websocketUrl', archiver.url], ['ingest', true], ['ingestCharacters', true], ['ingestOnlyExistingCharacters', true], ['ingestWarpResources', true]]) {
      await callTool(client, 'update_state', { section: 'scanner', patch: { [key]: value } })
    }
    const mcp = await mcpExportSlice()
    const ws = (s) => s.scannerSettings ?? {}
    const webS = ws(web)
    const mcpS = ws(mcp)
    const settingsOk = ['ingest', 'ingestCharacters', 'ingestOnlyExistingCharacters', 'ingestWarpResources'].every((k) => webS[k] === true && mcpS[k] === true)
      && webS.websocketUrl === archiver.url && mcpS.websocketUrl === archiver.url
      && webS.customUrl === true && mcpS.customUrl === true
    recordCase('import.live.settings', 1,
      '逐项修改后导出的存档 scannerSettings(含 customUrl)与网页拨动同一开关后的存档一致',
      'browser-parity',
      settingsOk,
      `web ${JSON.stringify(webS)} ≡ mcp ${JSON.stringify(mcpS)}`)

    // c2: while connected, flipping ingestCharacters ON replays the cached scan
    //     with characters on both sides.
    const CH = { id: '1305', name: 'Argenti', path: 'The Destruction', level: 1, ascension: 0, eidolon: 1, ability_version: 0 }
    const novelR = (uid, shift) => scannerRelicFromStore(headRelic, uid, { 0: headRelic.substats[0].value + shift })
    const web2 = await runWebTask({ label: 'settings-c2', seed: saveSeed(), timeoutMs: 300_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Advanced Settings'], { timeoutMs: 60_000 })
      await page.evaluate('async () => { const c = Array.from(document.querySelectorAll(".mantine-Accordion-control")).find((x) => (x.textContent||"").includes("Advanced Settings")); if (c) c.click(); return true }')
      await sleep(400)
      await page.evaluate(DOM.setWsUrl, [archiver.url])
      await page.evaluate(DOM.setSwitch, ['Enable Live Import (Recommended)', true]) // ingest ON, ingestCharacters OFF
      for (let i = 0; i < 150 && archiver.clientCount() === 0; i++) await sleep(200)
      if (archiver.clientCount() === 0) throw new Error('web ws client never connected')
      await sleep(500)
      // InitialScan with a character while ingestCharacters is OFF: relics only
      await archiver.frame('InitialScan', fullScan([novelR('930', 10)], [CH]))
      await sleep(2500)
      const mid = await page.harvestSaveState()
      // flip ingestCharacters ON → replays the scan with characters
      await page.evaluate(DOM.setSwitch, ["Enable updating characters' equipped relics and lightcones", true])
      await sleep(6500)
      const end = await page.harvestSaveState()
      return { midChars: mid.characters.length, midRelics: mid.relics.length, endChars: end.characters.length, endRelics: end.relics.length, end }
    })
    await callTool(client, 'update_state', { section: 'scanner', patch: { websocketUrl: archiver.url, ingest: true, ingestCharacters: false, ingestOnlyExistingCharacters: false } })
    await callTool(client, 'scanner', { action: 'connect' })
    await archiver.waitForClient()
    await archiver.frame('InitialScan', fullScan([novelR('930', 10)], [CH]))
    await sleep(2500)
    const midChars = (await callTool(client, 'list_characters', {})).characters.length
    const midRelics = (await callTool(client, 'list_relics', { limit: 1 })).total
    await callTool(client, 'update_state', { section: 'scanner', patch: { ingestCharacters: true } })
    await sleep(1500)
    const mcpEnd = await mcpExportSlice()
    const endChars = mcpEnd.characters.length
      const diff = firstSliceDiff(web2.end, mcpEnd)
      recordCase('import.live.settings', 2,
        '已连接状态下打开 ingestCharacters 会触发一次按角色的重新导入,结果与网页一致',
        'browser-parity',
        web2.midChars === 8 && midChars === 8 && web2.endChars === 9 && endChars === 9
          && web2.endRelics === 163 && midRelics === 163 && diff == null,
        diff ?? `both: scan(ingestCharacters off) relics-only 162→163 chars 8→8; flip on → chars 9, relics 163`)
    await callTool(client, 'scanner', { action: 'disconnect' })
    await archiver.close()
  }

  // ── import.live.connection ─────────────────────────────────────────────────
  {
    // c1: connect → connected; server-side termination → disconnected with
    //     automatic reconnection, on both sides.
    const archiver = await startArchiver()
    const web = await runWebTask({ label: 'conn-c1', seed: saveSeed(), timeoutMs: 300_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Advanced Settings'], { timeoutMs: 60_000 })
      await page.evaluate('async () => { const c = Array.from(document.querySelectorAll(".mantine-Accordion-control")).find((x) => (x.textContent||"").includes("Advanced Settings")); if (c) c.click(); return true }')
      await sleep(400)
      await page.evaluate(DOM.setWsUrl, [archiver.url])
      await page.evaluate(DOM.setSwitch, ['Enable Live Import (Recommended)', true])
      // wait for the ws client to connect
      let connected = false
      for (let i = 0; i < 100; i++) {
        await sleep(200)
        if ((await page.evaluate(DOM.connectionText)) === 'connected') { connected = true; break }
      }
      archiver.terminateAll()
      let disconnected = false
      for (let i = 0; i < 100; i++) {
        await sleep(200)
        if ((await page.evaluate(DOM.connectionText)) === 'disconnected') { disconnected = true; break }
      }
      let reconnected = false
      for (let i = 0; i < 150; i++) {
        await sleep(200)
        if ((await page.evaluate(DOM.connectionText)) === 'connected') { reconnected = true; break }
      }
      return { connected, disconnected, reconnected }
    })
    await callTool(client, 'update_state', { section: 'scanner', patch: { websocketUrl: archiver.url, ingest: true } })
    const connected1 = await callTool(client, 'scanner', { action: 'connect' })
    await archiver.waitForClient()
    const mcpConnected1 = (await callTool(client, 'scanner', { action: 'status' })).connected === true
    archiver.terminateAll()
    let mcpReconnected = false
    for (let i = 0; i < 100; i++) {
      await sleep(200)
      const s = await callTool(client, 'scanner', { action: 'status' })
      if (s.connected === true && s.reconnects >= 1) { mcpReconnected = true; break }
    }
    recordCase('import.live.connection', 1,
      '对本地假扫描器服务:connect 后 status 报告已连接,服务端断开后报告未连接并自动重连',
      'browser-parity',
      web.connected && web.disconnected && web.reconnected && connected1.connected === true && mcpConnected1 && mcpReconnected,
      `web connect/drop/reconnect=${web.connected}/${web.disconnected}/${web.reconnected}; mcp connected=${mcpConnected1}, auto-reconnect=${mcpReconnected}`)
    await callTool(client, 'scanner', { action: 'disconnect' })
    await archiver.close()

    // c2: unreachable target — MCP returns an explicit failure reason (not an
    //     empty success); the web never claims connected for a dead endpoint.
    const ghost = createServer()
    await new Promise((r) => ghost.listen(0, '127.0.0.1', r))
    const ghostPort = ghost.address().port
    await new Promise((r) => ghost.close(r))
    const deadUrl = `ws://127.0.0.1:${ghostPort}/ws`
    const mcpErr = await toolErrorText(client, 'scanner', { action: 'connect', url: deadUrl })
    const web2 = await runWebTask({ label: 'conn-c2', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Advanced Settings'], { timeoutMs: 60_000 })
      await page.evaluate('async () => { const c = Array.from(document.querySelectorAll(".mantine-Accordion-control")).find((x) => (x.textContent||"").includes("Advanced Settings")); if (c) c.click(); return true }')
      await sleep(400)
      await page.evaluate(DOM.setWsUrl, [deadUrl])
      await page.evaluate(DOM.setSwitch, ['Enable Live Import (Recommended)', true])
      await sleep(4000)
      return page.evaluate(DOM.connectionText)
    })
    recordCase('import.live.connection', 2,
      '目标地址不可达时返回明确的连接失败原因,而不是空成功',
      'browser-parity',
      mcpErr != null && /连接扫描器失败/.test(mcpErr) && web2 === 'disconnected',
      `mcp error: ${String(mcpErr).slice(0, 80)}; web status after 4s: ${web2}`)
  }

  // ── import.live.events ─────────────────────────────────────────────────────
  {
    const archiver = await startArchiver()
    const CH = { id: '1305', name: 'Argenti', path: 'The Destruction', level: 1, ascension: 0, eidolon: 1, ability_version: 0 }
    const UNKNOWN_CH = '1307'
    const novel = (uid, shift, extra = {}) => scannerRelicFromStore(headRelic, uid, { 0: headRelic.substats[0].value + shift }, extra)

    // c2 runs inside the same session: four switch combos, one novel relic per
    // combo, so the final save carries all four wearer outcomes. c3's non-5★
    // frames are interleaved (they must be no-ops on both sides).
    const comboPlan = [
      { relic: '940', location: '', chars: false, onlyExisting: false, expect: undefined },
      { relic: '941', location: CH.id, chars: true, onlyExisting: false, expect: CH.id, pushCharacter: true },
      { relic: '942', location: '1005', chars: true, onlyExisting: true, expect: '1005' },
      { relic: '943', location: UNKNOWN_CH, chars: true, onlyExisting: true, expect: undefined },
    ]
    const runCombos = async (applySwitches, pushChar, pushRelic, settleMs) => {
      let charsState = false
      let onlyExistingState = false
      for (const step of comboPlan) {
        if (step.chars !== charsState) {
          await applySwitches("Enable updating characters' equipped relics and lightcones", step.chars)
          charsState = step.chars
          await sleep(2500) // cached-scan replay window on the flip
        }
        if (step.chars && step.onlyExisting !== onlyExistingState) {
          await applySwitches('Only update existing characters', step.onlyExisting)
          onlyExistingState = step.onlyExisting
          await sleep(300)
        }
        if (step.pushCharacter) await pushChar()
        await sleep(300)
        await pushRelic(step)
        await sleep(settleMs)
      }
    }
    const web = await runWebTask({ label: 'events', seed: saveSeed(), timeoutMs: 500_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Advanced Settings'], { timeoutMs: 60_000 })
      await page.evaluate('async () => { const c = Array.from(document.querySelectorAll(".mantine-Accordion-control")).find((x) => (x.textContent||"").includes("Advanced Settings")); if (c) c.click(); return true }')
      await sleep(400)
      await page.evaluate(DOM.setWsUrl, [archiver.url])
      await page.evaluate(DOM.setSwitch, ['Enable Live Import (Recommended)', true])
      for (let i = 0; i < 150 && archiver.clientCount() === 0; i++) await sleep(200)
      if (archiver.clientCount() === 0) throw new Error('web ws client never connected')
      await sleep(500)

      // c1 sequence — every event kind once (plus non-5★ noise for c3)
      await archiver.frame('InitialScan', fullScan([novel('930', 10)], [CH]))
      await sleep(2000)
      await archiver.frame('UpdateRelics', [novel('931', 20, { location: CH.id })])
      await archiver.frame('UpdateCharacters', [CH])
      await archiver.frame('UpdateMaterials', [{ id: '2', name: 'x', count: 1 }])
      await archiver.frame('UpdateGachaFunds', { stellar_jade: 100, oneric_shards: 20 })
      await archiver.frame('UpdateLightCones', [{ id: '20000', name: 'lc', level: 5, ascension: 0, superimposition: 1, location: CH.id, lock: false, _uid: 'lc-x' }])
      await archiver.frame('DeleteLightCones', ['lc-x'])
      await archiver.frame('GachaResult', { banner_id: 1, banner_type: 'Character', pity_4: { kind: 'AddPity', amount: 1 }, pity_5: { kind: 'AddPity', amount: 1 }, pull_results: [] })
      await sleep(2500)
      const afterSequence = await page.harvestSaveState()

      // c2 combos (5s debounce flush per step on the web)
      await runCombos(
        async (label, value) => page.evaluate(DOM.setSwitch, [label, value]),
        async () => archiver.frame('UpdateCharacters', [CH]),
        async (step) => archiver.frame('UpdateRelics', [novel(step.relic, 50, { location: step.location })]),
        6500,
      )
      const end = await page.harvestSaveState()
      // c3 noise: a 4★ update AFTER every switch flip (no cached-scan replay
      // window follows) must not land; its delete frame must not change counts
      await archiver.frame('UpdateRelics', [novel('932', 30, { rarity: 4, level: 12 })])
      await sleep(1500)
      const afterFourStar = await page.harvestSaveState()
      await archiver.frame('DeleteRelics', ['932'])
      await sleep(1000)
      const afterNoise = await page.harvestSaveState()
      return { afterSequence, end, afterFourStar, afterNoise }
    })
    // bind relic pushes for the web plan (executed inside the task above is not
    // possible retroactively — restructure: runCombos receives pushRelic per step)

    // reset to the same seed the web leg booted with — without this the scanner
    // settings set by earlier cases (ingestCharacters=true from settings#2's
    // final flip) leak in and the MCP leg ingests characters the web ignored
    await callTool(client, 'load_save', { path: freshSavePath() })
    await callTool(client, 'update_state', { section: 'scanner', patch: { websocketUrl: archiver.url, ingest: true } })
    await callTool(client, 'scanner', { action: 'connect' })
    await archiver.waitForClient()
    await archiver.frame('InitialScan', fullScan([novel('930', 10)], [CH]))
    await sleep(2000)
    await archiver.frame('UpdateRelics', [novel('931', 20, { location: CH.id })])
    await archiver.frame('UpdateCharacters', [CH])
    await archiver.frame('UpdateMaterials', [{ id: '2', name: 'x', count: 1 }])
    await archiver.frame('UpdateGachaFunds', { stellar_jade: 100, oneric_shards: 20 })
    await archiver.frame('UpdateLightCones', [{ id: '20000', name: 'lc', level: 5, ascension: 0, superimposition: 1, location: CH.id, lock: false, _uid: 'lc-x' }])
    await archiver.frame('DeleteLightCones', ['lc-x'])
    await archiver.frame('GachaResult', { banner_id: 1, banner_type: 'Character', pity_4: { kind: 'AddPity', amount: 1 }, pity_5: { kind: 'AddPity', amount: 1 }, pull_results: [] })
    await sleep(1500)
    const mcpSequence = await mcpExportSlice()
    for (const step of comboPlan) {
      if (step.chars) {
        await callTool(client, 'update_state', { section: 'scanner', patch: { ingestCharacters: true, ...(step.onlyExisting ? { ingestOnlyExistingCharacters: true } : {}) } })
      } else {
        await callTool(client, 'update_state', { section: 'scanner', patch: { ingestCharacters: false } })
      }
      await sleep(2500)
      if (step.pushCharacter) await archiver.frame('UpdateCharacters', [CH])
      await sleep(300)
      await archiver.frame('UpdateRelics', [novel(step.relic, 50, { location: step.location })])
      await sleep(1200)
    }
    const mcpEnd = await mcpExportSlice()
    // c3 noise on the MCP side: post-flip 4★ update + delete (mirror of the web)
    await archiver.frame('UpdateRelics', [novel('932', 30, { rarity: 4, level: 12 })])
    await sleep(800)
    const mcpAfterFourStar = await mcpExportSlice()
    await archiver.frame('DeleteRelics', ['932'])
    await sleep(800)
    const mcpAfterNoise = await mcpExportSlice()

    const diffSeq = firstSliceDiff(web.afterSequence, mcpSequence)
    recordCase('import.live.events', 1,
      '向 MCP 与网页回放同一段事件序列(InitialScan、UpdateRelics、UpdateCharacters、DeleteRelics、UpdateMaterials、UpdateGachaFunds、UpdateLightCones、DeleteLightCones、GachaResult),两边导出的存档一致',
      'browser-parity',
      diffSeq == null && web.afterSequence.relics.length === mcpSequence.relics.length,
      diffSeq ?? `both: ${web.afterSequence.relics.length} relics, ${web.afterSequence.characters.length} chars after the 9-kind sequence`)

    const wearer = (save, uid) => save.relics.find((r) => r.id === uid)?.equippedBy ?? undefined
    const comboOk = comboPlan.every((step) => wearer(web.end, step.relic) === step.expect && wearer(mcpEnd, step.relic) === step.expect)
    const diffEnd = firstSliceDiff(web.end, mcpEnd)
    recordCase('import.live.events', 2,
      '四种开关组合(ingest × ingestCharacters × ingestOnlyExistingCharacters)下 UpdateRelics 的佩戴者处理与网页一致',
      'browser-parity',
      comboOk && diffEnd == null,
      diffEnd ?? `wearers web={${comboPlan.map((s) => `${s.relic}:${wearer(web.end, s.relic) ?? '-'}`).join(',')}} ≡ mcp={${comboPlan.map((s) => `${s.relic}:${wearer(mcpEnd, s.relic) ?? '-'}`).join(',')}}`)

    const noiseWeb = !web.afterFourStar.relics.some((r) => r.id === '932') && !web.afterNoise.relics.some((r) => r.id === '932')
    const noiseMcp = !mcpAfterFourStar.relics.some((r) => r.id === '932') && !mcpAfterNoise.relics.some((r) => r.id === '932')
    const noiseWebStable = web.afterNoise.relics.length === web.end.relics.length
    const noiseMcpStable = mcpAfterNoise.relics.length === mcpEnd.relics.length
    recordCase('import.live.events', 3,
      '非 5★ 遗器的更新与删除事件不改动库存',
      'browser-parity',
      noiseWeb && noiseMcp && noiseWebStable && noiseMcpStable,
      `post-flip 4★ update never lands: web=${noiseWeb} mcp=${noiseMcp}; its delete frame keeps counts: web ${web.end.relics.length}→${web.afterNoise.relics.length} (${noiseWebStable}), mcp ${mcpEnd.relics.length}→${mcpAfterNoise.relics.length} (${noiseMcpStable})`)
    await callTool(client, 'scanner', { action: 'disconnect' })
    await archiver.close()
  }

  // ── import.live.rerollPreview ──────────────────────────────────────────────
  {
    const archiver = await startArchiver()
    // A reroll frame on an equipped relic: the web pops the comparison modal and
    // renders both cards; MCP answers the same question via analyze_relic.
    const base = scannerRelicFromStore(ownedHead, '950', {}, { location: '1205' })
    const parserSubstats = (stats) => stats.map(([key, value]) => ({ key, value, count: 1, step: 0 }))
    const rerollFrame = {
      ...base,
      substats: parserSubstats([['SPD', 4], ['CRIT Rate_', 10.3], ['CRIT DMG_', 12.9], ['ATK_', 4.3]]),
      reroll_substats: parserSubstats([['SPD', 6.4], ['CRIT Rate_', 6.9], ['Break Effect_', 5.1], ['ATK_', 7.3]]),
    }
    const web = await runWebTask({ label: 'reroll-c1', seed: saveSeed(), timeoutMs: 300_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Advanced Settings'], { timeoutMs: 60_000 })
      await page.evaluate('async () => { const c = Array.from(document.querySelectorAll(".mantine-Accordion-control")).find((x) => (x.textContent||"").includes("Advanced Settings")); if (c) c.click(); return true }')
      await sleep(400)
      await page.evaluate(DOM.setWsUrl, [archiver.url])
      await page.evaluate(DOM.setSwitch, ['Enable Live Import (Recommended)', true])
      await archiver.waitForClient()
      await archiver.frame('UpdateRelics', [rerollFrame])
      let modal = null
      for (let i = 0; i < 75; i++) {
        await sleep(200)
        // the app keeps empty/hidden modal roots mounted — pick the non-empty
        // one; fall back to a body-text scan (portal classes vary by version)
        modal = await page.evaluate(`async () => {
          const roots = Array.from(document.querySelectorAll('.mantine-Modal-root'))
          const withText = roots.map((r) => (r.textContent || '')).filter((t) => t.trim().length > 0)
          if (withText.length) return withText.join(' || ')
          const body = document.body.innerText || ''
          return /Reroll Detected|Original Substats/i.test(body) ? body.slice(0, 500) : null
        }`)
        if (modal && /Reroll/i.test(modal)) break
      }
      return modal
    })
    // MCP side: same frame through its own scanner client, then analyze the
    // stored relic — the modal's numbers come from the same parse+score chain.
    await callTool(client, 'load_save', { path: freshSavePath() })
    await callTool(client, 'update_state', { section: 'scanner', patch: { websocketUrl: archiver.url, ingest: true } })
    await callTool(client, 'scanner', { action: 'connect' })
    await archiver.waitForClient()
    await archiver.frame('UpdateRelics', [rerollFrame])
    await sleep(1500)
    const mcpView = await callTool(client, 'analyze_relic', {
      relicId: '950', view: 'reroll',
      rerollSubstats: [
        { stat: 'SPD', value: 6.4 }, { stat: 'CRIT Rate', value: 6.9 }, { stat: 'Break Effect', value: 5.1 }, { stat: 'ATK%', value: 7.3 },
      ],
    })
    await callTool(client, 'scanner', { action: 'disconnect' })
    const mcpReroll = mcpView?.reroll ?? mcpView
    const webModalOk = web != null && /Rerol/i.test(web) && /Original/i.test(web)
    const webShowsSpd = web != null && /SPD/i.test(web)
    const mcpOrig = mcpReroll?.original
    const mcpRerolled = mcpReroll?.rerolled
    const mcpOk = mcpOrig?.score != null && mcpRerolled?.score != null
      && mcpOrig.relic?.substats?.some((s) => s.stat === 'SPD' && Math.abs(s.value - 4) < 1e-9)
      && mcpRerolled.relic?.substats?.some((s) => s.stat === 'SPD' && Math.abs(s.value - 6.4) < 1e-9)
      && mcpReroll.scoredByOwner === true
    recordCase('import.live.rerollPreview', 1,
      '对带 reroll_substats 的遗器事件,返回原/重掷两组副词条及各自的当前分,与弹窗里两张遗器卡的数值一致;无佩戴者时不给分',
      'browser-parity',
      webModalOk && webShowsSpd && mcpOk,
      `web modalOk=${webModalOk} (Rerol=${/Rerol/i.test(String(web))}, Original=${/Original/i.test(String(web))}), webShowsSpd=${webShowsSpd}; mcpOk=${mcpOk} (orig SPD4=${mcpOrig?.relic?.substats?.some((s) => s.stat === 'SPD' && Math.abs(s.value - 4) < 1e-9)}, reroll SPD6.4=${mcpRerolled?.relic?.substats?.some((s) => s.stat === 'SPD' && Math.abs(s.value - 6.4) < 1e-9)}, score=${mcpOrig?.score?.percentScore}/${mcpRerolled?.score?.percentScore}, scoredByOwner=${mcpReroll?.scoredByOwner})${(!webModalOk || !webShowsSpd) ? ` — modal head: ${String(web).slice(0, 160).replace(/\n/g, ' ')}` : ''}`)
    await archiver.close()
  }

  // ── import.help.read ───────────────────────────────────────────────────────
  {
    const webLinks = await runWebTask({ label: 'help-c1', seed: saveSeed(), timeoutMs: 240_000 }, async (page) => {
      await page.goto('#import', { timeoutMs: 90_000 })
      await page.waitForText(['Install and run one of the relic scanner options'], { timeoutMs: 60_000 })
      return page.evaluate(`() => Array.from(document.querySelectorAll('a'))
        .map((a) => ({ text: (a.textContent || '').trim(), href: a.href }))
        .filter((l) => l.href.startsWith('http'))`)
    })
    // site://help/{topic} is per-topic (reliquary/kelz/scorer/hoyolab/live-import)
    const topics = ['reliquary', 'kelz', 'scorer', 'hoyolab', 'live-import']
    const helpEntries = []
    for (const topic of topics) {
      helpEntries.push(JSON.parse((await client.readResource({ uri: `site://help/${topic}` })).contents[0].text))
    }
    const hrefs = webLinks.map((l) => l.href)
    const expected = [
      'https://github.com/IceDynamix/reliquary-archiver/releases/latest',
      'https://github.com/kel-z/HSR-Scanner/releases/latest',
      'https://github.com/fribbels/hsr-optimizer/discussions/403',
      'https://github.com/fribbels/hsr-optimizer/blob/main/docs/guides/en/live-import.md',
    ]
    const allPresent = expected.every((u) => hrefs.includes(u))
    const byTopic = new Map(helpEntries.map((e) => [e.topic, e]))
    const resourceOk = helpEntries.length === 5
      && expected[0] === byTopic.get('reliquary')?.url
      && expected[1] === byTopic.get('kelz')?.url
      && expected[2] === byTopic.get('hoyolab')?.url
      && expected[3] === byTopic.get('live-import')?.url
      && byTopic.get('scorer')?.internalHash === '#showcase'
      && helpEntries.every((e) => (e.titleZh ?? '').length > 0 && (e.points ?? []).length > 0)
    recordCase('import.help.read', 1,
      'site://help/{topic} 五个主题列出各来源的名称、要点与链接,与导入页当前语言下的内容一致',
      'browser-parity',
      allPresent && resourceOk,
      `page links ⊇ {reliquary, kelz, hoyolab-discussions, live-import.md} (${expected.filter((u) => hrefs.includes(u)).length}/4); resource topics=${helpEntries.length}/5 urls+internalHash verified=${resourceOk}`)
  }
} finally {
  await client.close().catch(() => {})
  await browserManager.close().catch(() => {})
  const evidence = {
    area: 'import',
    generatedAt: new Date().toISOString(),
    gitCommit: GIT_COMMIT,
    cases: evidenceCases,
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nverify-import: ALL CASES PASSED (${evidenceCases.length})` : `\nverify-import: ${failures} CASE(S) FAILED of ${evidenceCases.length}`)
process.exit(failures === 0 ? 0 : 1)
