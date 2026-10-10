// verified acceptance harness for the characters domain (PROTOCOL.md 2026-10-08).
//
// Same-save browser/MCP parity for every scope=baseline feature row in
// coverage/features/characters.json (22 rows). The browser side drives the
// REAL web UI in the managed browser (repo dist/ build, localStorage['state']
// seeded from the same temp save copy the MCP server loads); the MCP side runs
// the equivalent tool over stdio. After each paired action the two sides are
// compared on the exact fields the acceptance case names (harvested page state
// via the page's own SaveState.save() vs MCP export_save).
//
// All persistent state (save copies, HSR_MCP_STATE_FILE, artifacts) lives in a
// mkdtempSync temp dir; the repo sample save is never a write target. The
// managed browser is closed in finally.
//
// Usage: node scripts/verify-characters.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).
// Writes mcp/coverage/evidence/characters.json.

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
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const evidencePath = resolve(mcpDir, 'coverage/evidence/characters.json')
const GIT_COMMIT = '8ac1d045'

// ── temp workspace ───────────────────────────────────────────────────────────
const tempDir = mkdtempSync(`${tmpdir()}/hsr-verify-characters-`)

// seed A: pristine sample copy
const seedAPath = `${tempDir}/seed-a.json`
copyFileSync(repoSampleSavePath, seedAPath)

// seed B: sample + injected saved builds on 1212b1 (the pristine sample ships
// none). inject-preview is FIRST because BuildsModal auto-selects builds[0] on
// open — that makes the F12 preview card deterministic (no card click needed).
// inject-main: full 3-teammate team + lightCone/eidolon that differ from
// the character's current state, equipped = the six relics currently on 1102
// (equipping steals them → Replace/Swap observable). inject-short: 1 teammate,
// equipped = the six relics on 1205. inject-preview: 3 teammates, LC 23013 e2,
// equipped = 1212b1's own current six (LC/eidolon differ from current state).
const sample = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
const relicsBy = (owner) => Object.fromEntries(
  sample.relics.filter((r) => r.equippedBy === owner).map((r) => [r.part, r.id]),
)
const tm = (id, lc) => ({
  characterId: id,
  characterEidolon: 0,
  lightCone: lc,
  lightConeSuperimposition: 1,
  characterConditionals: {},
  lightConeConditionals: {},
})
const jingliu = sample.characters.find((c) => c.id === '1212b1')
jingliu.builds = [
  {
    name: 'inject-preview',
    source: 'Character',
    characterId: '1212b1',
    equipped: relicsBy('1212b1'),
    characterEidolon: 2,
    lightCone: '23013',
    lightConeSuperimposition: 2,
    scoringConfigType: 'dps',
    team: [tm('1101', '23003'), tm('1105', '21007'), tm('1102', '24001')],
    characterConditionals: {},
    lightConeConditionals: {},
    setConditionals: {},
  },
  {
    name: 'inject-main',
    source: 'Character',
    characterId: '1212b1',
    equipped: relicsBy('1102'),
    characterEidolon: 2,
    lightCone: '23013',
    lightConeSuperimposition: 2,
    scoringConfigType: 'dps',
    team: [tm('1101', '23003'), tm('1105', '21007'), tm('1102', '24001')],
    characterConditionals: {},
    lightConeConditionals: {},
    setConditionals: {},
  },
  {
    name: 'inject-short',
    source: 'Character',
    characterId: '1212b1',
    equipped: relicsBy('1205'),
    characterEidolon: 1,
    lightCone: '23014',
    lightConeSuperimposition: 1,
    scoringConfigType: 'dps',
    team: [tm('1101', '23003'), null, null],
    characterConditionals: {},
    lightConeConditionals: {},
    setConditionals: {},
  },
  {
    // partial build (5 relics) whose relics are worn by 1202 — equipping it
    // steals from 1202, the observable for the Replace/Swap behavior case
    name: 'inject-steal',
    source: 'Character',
    characterId: '1212b1',
    equipped: relicsBy('1202'),
    characterEidolon: 1,
    lightCone: '23014',
    lightConeSuperimposition: 1,
    scoringConfigType: 'dps',
    team: [tm('1101', '23003'), tm('1105', '21007'), tm('1102', '24001')],
    characterConditionals: {},
    lightConeConditionals: {},
    setConditionals: {},
  },
]
const seedBPath = `${tempDir}/seed-b.json`
writeFileSync(seedBPath, JSON.stringify(sample))

// ── case ledger ──────────────────────────────────────────────────────────────
const cases = []
let failures = 0
function record(featureId, caseNo, desc, ok, detail, method = 'browser-parity') {
  const clipped = desc.length > 60 ? desc.slice(0, 60) + '…' : desc
  cases.push({
    feature: featureId,
    case: caseNo,
    desc: clipped,
    method,
    result: ok ? 'PASS' : 'FAIL',
    detail: String(detail).slice(0, 300),
    script: 'mcp/scripts/verify-characters.mjs',
  })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${featureId}#${caseNo} — ${clipped}`)
  console.log(`       ${String(detail).slice(0, 220)}`)
  if (!ok) failures++
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
  throw new Error(`等待超时(${timeoutMs}ms):${desc} — ${last && last.detail ? last.detail : ''}`)
}

/** Run one page-side step; failures are captured on shots.errors so the
 * remaining steps (and their MCP mirrors) still produce honest records. */
function pageStep(shots, name, fn) {
  return (async () => {
    try {
      return await fn()
    } catch (e) {
      shots.errors = shots.errors ?? {}
      shots.errors[name] = String(e?.message ?? e).slice(0, 140)
      return null
    }
  })()
}

/** Run one feature section; a harness error inside cannot kill the rest. */
async function guard(label, fn) {
  try {
    await fn()
  } catch (e) {
    failures++
    console.error(`[HARNESS-ERROR] ${label}: ${String(e?.stack ?? e).slice(0, 900)}`)
  }
}

// ── tolerant deep equality (numbers within 1e-6 relative) ───────────────────
function firstDiff(a, b, path = '$', tolerance = 1e-6) {
  if (a === b) return null
  if (typeof a === 'number' && typeof b === 'number') {
    const scale = Math.max(Math.abs(a), Math.abs(b), 1)
    return Math.abs(a - b) / scale <= tolerance ? null : `${path}: ${a} vs ${b}`
  }
  if (a == null && b == null) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`, tolerance)
      if (d) return d
    }
    return null
  }
  if (typeof a === 'object' && typeof b === 'object' && a != null && b != null) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    for (const k of keys) {
      if (!(k in a)) return `${path}.${k}: missing on web side`
      if (!(k in b)) return `${path}.${k}: missing on mcp side`
      const d = firstDiff(a[k], b[k], `${path}.${k}`, tolerance)
      if (d) return d
    }
    return null
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
}

// ── save-state readers (shared by web harvest + MCP export; null-tolerant so a
// failed web pageStep degrades to a FAIL record instead of killing the guard) ─
const orderOf = (state) => (state?.characters ?? []).map((c) => c.id)
const charIn = (state, id) => (state?.characters ?? []).find((c) => c.id === id) ?? null
const equippedOf = (state, id) => {
  const c = charIn(state, id)
  const out = {}
  for (const [part, relicId] of Object.entries(c?.equipped ?? {})) {
    if (relicId != null) out[part] = relicId
  }
  return out
}
const ownersOf = (state) => {
  const out = {}
  for (const r of state?.relics ?? []) if (r.equippedBy) out[r.id] = r.equippedBy
  return out
}
const buildSummaries = (state, id) =>
  (charIn(state, id)?.builds ?? []).map((b) => ({
    name: b.name,
    source: b.source,
    equipped: b.equipped,
    characterEidolon: b.characterEidolon,
    lightCone: b.lightCone,
    lightConeSuperimposition: b.lightConeSuperimposition,
    scoringConfigType: b.scoringConfigType,
    team: (b.team ?? []).map((t) => (t == null ? null : {
      characterId: t.characterId,
      lightCone: t.lightCone,
      characterEidolon: t.characterEidolon ?? 0,
      lightConeSuperimposition: t.lightConeSuperimposition ?? 1,
    })),
  }))

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
async function toolError(client, name, args, options) {
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, options)
    if (r.isError) return r.content?.[0]?.text ?? ''
    return null
  } catch (e) {
    return String(e.message ?? e)
  }
}
async function readResource(client, uri) {
  const result = await client.readResource({ uri })
  return JSON.parse(result.contents[0].text)
}

const client = new Client({ name: 'verify-characters', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_ARTIFACTS_DIR: `${tempDir}/artifacts`,
  },
  stderr: 'pipe',
})
let serverStderr = ''
transport.stderr?.on('data', (c) => void (serverStderr += c))
await client.connect(transport)

/** MCP export of the currently loaded save (explicit write to temp). */
async function mcpExport() {
  const path = `${tempDir}/mcp-export-${Date.now()}.json`
  await callTool(client, 'export_save', { path })
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ── managed browser (same source the server bundles) ─────────────────────────
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL != null && context.parentURL.endsWith('.ts')) {
        try { return nextResolve(`${specifier}.ts`, context) } catch { /* fall through */ }
      }
      throw error
    }
  },
})
const { pathToFileURL } = await import('node:url')
const { browserManager } = await import(pathToFileURL(resolve(mcpDir, 'src/browser/browserManager.ts')).href)

function findChromeLike() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.some((p) => existsSync(p))
}
const hasDist = existsSync(resolve(mcpDir, '../dist/index.html'))
if (!findChromeLike() || !hasDist) {
  console.log('[SKIP] verify-characters 需要受管浏览器(Chrome + 根 dist/),当前环境缺失')
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
  process.exit(0)
}

// ── page-side helper scripts ─────────────────────────────────────────────────
const P_SET_LOCALE = `() => {
  localStorage.setItem('i18nextLng', 'zh_CN')
  window.__verifyLocale = 'set'
  location.reload()
  return true
}`
const P_FRESH = `() => window.__verifyLocale === undefined && document.readyState === 'complete'`
const P_CLICK_TEXT = `(text, exact, scopeSel) => {
  let scope = document
  if (scopeSel) {
    const all = [...document.querySelectorAll(scopeSel)]
    const visible = all.filter((e) => e.offsetParent !== null)
    scope = (visible.length ? visible[visible.length - 1] : all[all.length - 1]) ?? null
  }
  if (!scope) return { ok: false, reason: 'scope not found: ' + scopeSel }
  const targets = [...scope.querySelectorAll('button, [role="menuitem"], label, [role="radio"], [role="option"]')]
    .filter((e) => e.offsetParent !== null && (e.textContent || '').trim().length > 0)
  const byExact = targets.filter((e) => (e.textContent || '').trim() === text)
  const hits = exact ? byExact : (byExact.length ? byExact : targets.filter((e) => (e.textContent || '').includes(text)))
  if (!hits.length) return { ok: false, reason: 'no visible element with text ' + text }
  const hit = hits[hits.length - 1]
  // sidebar nav uses onMouseDown; everything else onClick — dispatch both
  hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  hit.click()
  return { ok: true }
}`
const P_ROWS = `() => [...document.querySelectorAll('[data-character-id]')].map((e) => ({
  id: e.getAttribute('data-character-id'),
  selected: e.getAttribute('data-selected') === 'true',
  text: (e.innerText || '').split(String.fromCharCode(10)).slice(0, 2).join(' '),
}))`
const P_FOCUS_INPUT = `(placeholder) => {
  const inputs = [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null)
  const input = inputs.find((e) => e.getAttribute('placeholder') === placeholder)
  if (!input) return { ok: false, reason: 'input not found for ' + placeholder }
  input.focus()
  input.select && input.select()
  return { ok: true }
}`
/** Type into the visible input with the given placeholder (real key events). */
async function typeIntoPlaceholder(page, placeholder, text) {
  const focused = await page.evaluate(P_FOCUS_INPUT, [placeholder])
  if (!focused.ok) throw new Error(`输入框未找到(${placeholder}):${focused.reason}`)
  await page.type(text)
  await sleep(300)
  return page.evaluate(`(p) => [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null).find((e) => e.getAttribute('placeholder') === p)?.value ?? null`, [placeholder])
}
const P_FOCUS_INPUT_BY_LABEL = `(labelText) => {
  const labels = [...document.querySelectorAll('label')].filter((e) => e.offsetParent !== null && (e.textContent || '').trim() === labelText)
  if (!labels.length) return { ok: false, reason: 'no label ' + labelText }
  const label = labels[labels.length - 1]
  const input = (label.htmlFor && document.getElementById(label.htmlFor)) || label.parentElement.querySelector('input')
  if (!input) return { ok: false, reason: 'no input for label ' + labelText }
  input.focus()
  input.select && input.select()
  return { ok: true, value: input.value }
}`
/** Type into the input labelled `labelText` (e.g. 配装名称) with real keys. */
async function typeIntoLabelled(page, labelText, text) {
  const focused = await page.evaluate(P_FOCUS_INPUT_BY_LABEL, [labelText])
  if (!focused.ok) throw new Error(`输入框未找到(${labelText}):${focused.reason}`)
  await page.type(text)
  await sleep(300)
}
const P_FOCUS_NUMBER_BY_SIBLING = `(siblingText) => {
  const rows = [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null && !e.readOnly)
  const row = rows.find((e) => {
    let n = e.parentElement
    for (let i = 0; i < 4 && n; i++) {
      if ((n.innerText || '').trim() === siblingText) return true
      n = n.parentElement
    }
    return false
  })
  if (!row) return { ok: false, reason: 'no number input near ' + siblingText }
  row.focus()
  row.select && row.select()
  return { ok: true }
}`
/** Type a number into the input whose row label is `siblingText` (评分权重行). */
async function typeNumberBeside(page, siblingText, text) {
  const focused = await page.evaluate(P_FOCUS_NUMBER_BY_SIBLING, [siblingText])
  if (!focused.ok) throw new Error(`数字输入未找到(${siblingText}):${focused.reason}`)
  await page.type(text)
  await sleep(300)
}
const P_CLICK_TAG = `(kind, name) => {
  const suffix = '/icon/' + kind + '/' + name + '.webp'
  const btn = [...document.querySelectorAll('button')]
    .find((b) => b.offsetParent !== null && [...b.querySelectorAll('img')].some((i) => (i.getAttribute('src') || '').endsWith(suffix)))
  if (!btn) return { ok: false, reason: 'tag not found ' + suffix }
  btn.click()
  return { ok: true }
}`
const P_MENU = {
  open: `(text) => {
    const btns = [...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null && (e.textContent || '').trim() === text)
    if (!btns.length) return { ok: false, reason: 'menu button not found: ' + text }
    btns[btns.length - 1].click()
    return { ok: true }
  }`,
  item: `(text) => {
    const items = [...document.querySelectorAll('[role="menuitem"]')].filter((e) => e.offsetParent !== null && (e.textContent || '').includes(text))
    if (!items.length) return { ok: false, reason: 'menu item not found: ' + text }
    items[items.length - 1].click()
    return { ok: true }
  }`,
}
const P_DBLCLICK_ROW = `(id) => {
  const row = document.querySelector('[data-character-id="' + id + '"]')
  if (!row) return { ok: false, reason: 'row not found ' + id }
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  return { ok: true }
}`
const P_MODAL_OPEN = `() => [...document.querySelectorAll('[role="dialog"]')].some((e) => e.offsetParent !== null)`
const P_SELECT_CARD_IDS = `() => [...document.querySelectorAll('[data-id]')].filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-id'))`
const P_PILL_REMOVE = `(pillText) => {
  // find the pill's text leaf, then climb to the pill root that carries the
  // remove (X) button
  const leaves = [...document.querySelectorAll('span, div')].filter((e) => e.offsetParent !== null && e.childElementCount === 0 && (e.textContent || '').trim() === pillText)
  for (const leaf of leaves) {
    let n = leaf
    for (let i = 0; i < 5 && n; i++) {
      const btn = n.querySelector(':scope > button') || n.querySelector('button')
      if (btn && (n.textContent || '').includes(pillText)) {
        btn.click()
        return { ok: true }
      }
      n = n.parentElement
    }
  }
  return { ok: false, reason: 'pill not found: ' + pillText }
}`
const P_BUILD_CARDS = `() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null)
  const dialog = dialogs[dialogs.length - 1]
  if (!dialog) return []
  return [...dialog.querySelectorAll('button')].filter((b) => b.offsetParent !== null).length
}`
const P_HASH = `() => location.hash`
const P_BODY = `() => document.body.innerText`
/** Click ANY visible leaf element by exact text (select displays and dropdown
 * options are not buttons, so P_CLICK_TEXT cannot reach them). */
const P_CLICK_EL = `(text) => {
  const els = [...document.querySelectorAll('*')].filter((e) => e.offsetParent !== null && e.childElementCount === 0 && (e.textContent || '').trim() === text)
  if (!els.length) return { ok: false, reason: 'no element with text ' + text }
  const hit = els[els.length - 1]
  hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  hit.click()
  return { ok: true }
}`

/** evaluate that tolerates the reload window ("execution context destroyed"). */
async function safeEvaluate(page, fn, args) {
  for (let i = 0; i < 40; i++) {
    try {
      return await page.evaluate(fn, args)
    } catch (e) {
      if (/destroyed|navigation|Target closed/i.test(String(e?.message ?? e))) {
        await sleep(400)
        continue
      }
      throw e
    }
  }
  throw new Error('page context unavailable after reload retries')
}

/** Boot a zh_CN page at a hash inside a task. The locale key is set on the
 * home document, then the hash navigation loads a FRESH document which boots
 * the app with zh (i18next LanguageDetector reads localStorage) — no reload
 * race. A zh marker is verified post-boot; if the app still came up English
 * (flaky locale read), the locale round-trip runs once more. */
async function bootZh(page, hash, waitFor) {
  for (let attempt = 0; ; attempt++) {
    await page.goto('', { timeoutMs: 90_000 })
    await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
    await safeEvaluate(page, P_SET_LOCALE)
    await pollUntil('zh locale reload 完成', async () => ({ ok: await safeEvaluate(page, P_FRESH) === true }), 30_000, 300)
    await page.waitForSelector('#root > *', { timeoutMs: 30_000 })
    // verify the app actually booted in zh (sidebar 角色 vs Characters)
    const zhOk = await safeEvaluate(page, `() => (document.body.innerText || '').includes('角色')`)
    if (zhOk !== true) {
      await safeEvaluate(page, P_SET_LOCALE)
      await pollUntil('zh locale 二次 reload', async () => ({ ok: await safeEvaluate(page, P_FRESH) === true }), 30_000, 300)
      await page.waitForSelector('#root > *', { timeoutMs: 30_000 })
    }
    await sleep(1000)
    if (!hash || hash === '') return
    try {
      // same-document hash navigation: the app already booted in zh after the
      // reload, this only switches the active page
      await page.goto(hash, { timeoutMs: 90_000 })
      await page.waitForSelector(waitFor, { timeoutMs: 30_000, visible: true })
      return
    } catch (e) {
      if (attempt >= 1) throw e
    }
  }
}

/** Open the 角色菜单 dropdown (optionally focusing a row first). Retried as a
 * whole: boot-time flakiness can leave the first attempt's row click swallowed
 * or the menu button not yet mounted; each attempt redoes the full sequence. */
async function openCharacterMenu(page, focusRowId) {
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (focusRowId != null) {
        await page.evaluate(`(id) => { const row = document.querySelector('[data-character-id="' + id + '"]'); if (row) row.click(); return !!row }`, [focusRowId])
        await sleep(400)
      }
      await pollUntil(
        '角色菜单按钮可点',
        async () => {
          const r = await page.evaluate(P_MENU.open, ['角色菜单'])
          if (r.ok) return r
          const buttons = await page.evaluate(`() => [...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null).map((e) => (e.textContent || '').trim()).slice(0, 30)`)
          return { ok: false, detail: 'buttons: ' + JSON.stringify(buttons) }
        },
        15_000,
      )
      await sleep(500)
      return
    } catch (e) {
      lastErr = e
      await sleep(600)
    }
  }
  throw lastErr ?? new Error('角色菜单打开失败')
}
async function menuClick(page, itemText) {
  for (let round = 0; round < 3; round++) {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      if ((await page.evaluate(P_MENU.item, [itemText])).ok) return
      await sleep(150)
    }
    // dropdown may have failed to open — click the menu button again
    await page.evaluate(P_MENU.open, ['角色菜单'])
    await sleep(600)
  }
  throw new Error(`菜单项未找到:${itemText}`)
}
/** Click a confirm-style button in ANY visible dialog. Mantine stacks portals
 * in opening order — the equip confirm renders BEFORE the builds modal in the
 * DOM, so scoping to "the last visible dialog" misses it. */
const P_CLICK_ANY_DIALOG = `(text) => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null)
  for (const d of dialogs) {
    const btns = [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
    const hit = btns.find((b) => (b.textContent || '').trim() === text) || btns.find((b) => (b.textContent || '').includes(text))
    if (hit) {
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      hit.click()
      return { ok: true }
    }
  }
  return { ok: false, reason: 'no ' + text + ' button in any visible dialog' }
}`
async function confirmDialog(page, text = '确') {
  await sleep(400)
  await pollUntil(`确认框按钮(${text})`, async () => {
    const r = await page.evaluate(P_CLICK_ANY_DIALOG, [text])
    if (r.ok) return r
    const dbg = await page.evaluate(`() => [...document.querySelectorAll('[role="dialog"]')].map((d) => ({ vis: d.offsetParent !== null, text: (d.innerText || '').slice(0, 40), btns: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim().slice(0, 6)).slice(0, 5) }))`)
    return { ok: false, detail: JSON.stringify(dbg).slice(0, 200) }
  }, 10_000)
  await sleep(500)
}

const P_HAS_CONFIRM = `(text) => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.offsetParent !== null
  && [...d.querySelectorAll('button')].some((b) => b.offsetParent !== null && (b.textContent || '').includes(text)))`

/** Perform a primary click, then click the confirm button as soon as it
 * appears; if the dialog never shows (synthetic clicks are intermittently
 * swallowed right after heavy re-renders), re-click the primary. */
async function clickThenConfirm(page, clickFn, confirmText = '确', rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    try {
      await clickFn()
    } catch { /* the re-click below retries */ }
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      if ((await page.evaluate(P_CLICK_ANY_DIALOG, [confirmText])).ok) {
        await sleep(400)
        return
      }
      await sleep(250)
    }
  }
  await confirmDialog(page, confirmText)
}

/** harvestSaveState with flush retries — the debounced SaveState.write can
 * briefly leave localStorage['state'] absent between writes. */
async function harvest(page) {
  let state = null
  for (let i = 0; i < 6 && state == null; i++) {
    state = await page.harvestSaveState()
    if (state == null) await sleep(700)
  }
  return state
}

// ═════════════════════════════════════════════════════════════════════════════
try {
  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name)

  // ══ F1 characters.list.read ══════════════════════════════════════════════
  await guard('F1', async () => {
    await callTool(client, 'load_save', { path: seedAPath })
    const listAll = await callTool(client, 'list_characters', {})
    const web = await browserManager.runTask({ label: 'F1 list', seed: readFileSync(seedAPath, 'utf8'), timeoutMs: 240_000 }, async (page) => {
      await bootZh(page, '#characters', '[data-character-id]')
      await sleep(1500)
      const rows = await page.evaluate(P_ROWS)
      // name filter 流 → 镜流
      await typeIntoPlaceholder(page, '搜索', '流')
      await sleep(600)
      const byName = await page.evaluate(P_ROWS)
      // + path multi-select (Destruction + Harmony) + element (Ice)
      await page.evaluate(P_CLICK_TAG, ['path', 'Destruction'])
      await page.evaluate(P_CLICK_TAG, ['path', 'Harmony'])
      await page.evaluate(P_CLICK_TAG, ['element', 'Ice'])
      await sleep(600)
      const threeAxis = await page.evaluate(P_ROWS)
      // clear: name ×, filters off
      await page.evaluate(P_CLICK_TAG, ['path', 'Destruction'])
      await page.evaluate(P_CLICK_TAG, ['path', 'Harmony'])
      await page.evaluate(P_CLICK_TAG, ['element', 'Ice'])
      const kafkaAxis = await (async () => {
        await typeIntoPlaceholder(page, '搜索', '卡芙卡')
        await sleep(500)
        return page.evaluate(P_ROWS)
      })()
      return { rows, byName, threeAxis, kafkaAxis }
    })

    const ids = (rows) => rows.map((r) => r.id)
    const mcpIds = listAll.characters.map((c) => c.characterId ?? c.id)
    record('characters.list.read', 1, 'list_characters 的顺序、rank 与网页角色网格一致', JSON.stringify(ids(web.rows)) === JSON.stringify(mcpIds),
      `web ${ids(web.rows).join(',')} vs mcp ${mcpIds.join(',')}`)

    const byNameMcp = await callTool(client, 'list_characters', { name: '流' })
    record('characters.list.read', 1, '按命途、属性筛选的结果集与网页筛选条一致', ids(web.byName).join(',') === byNameMcp.characters.map((c) => c.characterId ?? c.id).join(',') && web.byName.length === 1,
      `name=流 web [${ids(web.byName)}] vs mcp [${byNameMcp.characters.map((c) => c.characterId ?? c.id)}]`)

    const threeMcp = await callTool(client, 'list_characters', { path: ['Destruction', 'Harmony'], element: ['Ice'] })
    const threeOk = ids(web.threeAxis).join(',') === threeMcp.characters.map((c) => c.characterId ?? c.id).join(',')
    const kafkaMcp = await callTool(client, 'list_characters', { name: '卡芙卡', path: ['Nihility', 'Destruction'], element: ['Lightning'] })
    const kafkaOk = ids(web.kafkaAxis).join(',') === kafkaMcp.characters.map((c) => c.characterId ?? c.id).join(',')
    record('characters.list.read', 1, '补齐多选与 name 参数后与网页三轴筛选逐一对拍', threeOk && kafkaOk,
      `三轴 web [${ids(web.threeAxis)}] vs mcp [${threeMcp.characters.map((c) => c.characterId ?? c.id)}];卡芙卡轴 ${kafkaOk ? '一致' : '不一致'}`)
  })

  // ══ F2 characters.detail.read ════════════════════════════════════════════
  await guard('F2', async () => {
    await callTool(client, 'load_save', { path: seedBPath })
    const detail = await callTool(client, 'get_character', { characterId: '1212b1' })
    const webState = await browserManager.runTask({ label: 'F2 detail', seed: readFileSync(seedBPath, 'utf8'), timeoutMs: 240_000 }, async (page) => {
      await bootZh(page, '#characters', '[data-character-id]')
      await page.evaluate(`(id) => { const row = document.querySelector('[data-character-id="' + id + '"]'); row.click(); return true }`, ['1212b1'])
      await pollUntil('展示卡渲染', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#characterTabPreview')`)) === true }), 15_000)
      await sleep(1500)
      return page.harvestSaveState()
    })
    const webEquipped = equippedOf(webState, '1212b1')
    const mcpEquipped = Object.fromEntries(
      Object.entries(detail.equippedSlots ?? {}).map(([part, e]) => [part, e.equippedId]).filter(([, id]) => id != null),
    )
    const eqOk = firstDiff(webEquipped, mcpEquipped) == null
    const webBuilds = buildSummaries(webState, '1212b1')
    const mcpBuilds = (detail.builds ?? []).map((b) => ({
      name: b.name,
      source: b.source,
      equipped: b.equipped,
      characterEidolon: b.characterEidolon,
      lightCone: b.lightCone,
      lightConeSuperimposition: b.lightConeSuperimposition,
      scoringConfigType: b.scoringConfigType,
      team: (b.team ?? []).map((t) => (t == null ? null : {
        characterId: t.characterId,
        lightCone: t.lightCone,
        characterEidolon: t.characterEidolon ?? 0,
        lightConeSuperimposition: t.lightConeSuperimposition ?? 1,
      })),
    }))
    const buildsOk = firstDiff(webBuilds, mcpBuilds) == null
    const webForm = charIn(webState, '1212b1').form
    const formOk = firstDiff(webForm, detail.savedForm) == null
    const scoringPanel = await readResource(client, 'game://metadata/scoring')
    const jw = scoringPanel.substatWeights.find((e) => e.characterId === '1212b1')
    const effectiveNine = Object.fromEntries(
      Object.entries(jw?.weights ?? {}).filter(([k]) => k in (detail.scoringMetadata?.stats ?? {})),
    )
    const scoreOk = firstDiff(effectiveNine, jw?.weights) == null
    record('characters.detail.read', 1, 'get_character 返回的六槽遗器、已存表单、配装列表与评分元数据与网页选中该角色后看到的一致',
      eqOk && formOk && buildsOk && scoreOk,
      `equipped ${eqOk ? '一致' : firstDiff(webEquipped, mcpEquipped)};form ${formOk ? '一致' : firstDiff(webForm, detail.savedForm)};builds ${buildsOk ? '一致' : firstDiff(webBuilds, mcpBuilds)};评分默认 ${scoreOk ? '一致' : '漂移'}`)
  })

  // ══ F3 characters.openInOptimizer ════════════════════════════════════════
  await guard('F3', async () => {
    await callTool(client, 'load_save', { path: seedAPath })
    const webState = await browserManager.runTask({ label: 'F3 openInOptimizer', seed: readFileSync(seedAPath, 'utf8'), timeoutMs: 240_000 }, async (page) => {
      await bootZh(page, '#main', 'button')
      // the optimizer hydrates the boot focus character's working form — wait
      // until the character select shows a name so the away-switch saves it
      await pollUntil('优化器角色已载入', async () => ({
        ok: await page.evaluate(`() => { const i = [...document.querySelectorAll('input')].find((e) => e.offsetParent !== null && e.readOnly); return i != null && i.value.length > 0 }`),
      }), 30_000)
      await sleep(500)
      await page.evaluate(`() => { location.hash = '#characters'; return true }`)
      await sleep(1200)
      await page.waitForSelector('[data-character-id]', { timeoutMs: 30_000, visible: true })
      await page.evaluate(P_DBLCLICK_ROW, ['1005'])
      await pollUntil('跳到优化器', async () => ({ ok: (await page.evaluate(P_HASH)) === '#main' }), 15_000)
      await sleep(2500)
      return page.harvestSaveState()
    })
    // Mirror the web boot: the optimizer hydrates the first roster character's
    // working form (which materializes current-schema conditionals like e1Buffs)
    // and the dblclick-away switch saves THAT form. MCP equivalent: load the
    // 1212b1 draft first, then switch to 1005 (update_form twice).
    await callTool(client, 'update_form', { characterId: '1212b1' })
    await callTool(client, 'update_form', { characterId: '1005' })
    const mcpState = await mcpExport()
    const webId = webState.savedSession?.global?.optimizerCharacterId
    const mcpId = mcpState.savedSession?.global?.optimizerCharacterId
    const webForm1212 = charIn(webState, '1212b1')?.form
    const mcpForm1212 = charIn(mcpState, '1212b1')?.form
    const ok = webId === '1005' && mcpId === '1005' && firstDiff(webForm1212, mcpForm1212) == null
    record('characters.openInOptimizer', 1, '与 optimizer.character.switch 同一用例:切换后存档里的 optimizerCharacterId 与离开角色的表单都与网页一致', ok,
      `optimizerCharacterId web=${webId} mcp=${mcpId};离开角色(1212b1)表单 ${firstDiff(webForm1212, mcpForm1212) ?? '一致'}`)
  })

  // ══ F4 rank.move / F5 sortByEffectiveSubstats / F6 upsert / F7 delete / F8 unequip / F9 switchRelics ══
  await guard('F4-F9', async () => {
    await callTool(client, 'load_save', { path: seedAPath })
    const web = await browserManager.runTask({ label: 'F4-F9 roster writes', seed: readFileSync(seedAPath, 'utf8'), timeoutMs: 420_000 }, async (page) => {
      await bootZh(page, '#characters', '[data-character-id]')
      const snapshots = {}

      // F4: move 1101 to top, then 1202 to top
      await openCharacterMenu(page, '1101')
      await menuClick(page, '将角色移至顶部')
      await sleep(800)
      snapshots.move1 = await harvest(page)
      await openCharacterMenu(page, '1202')
      await menuClick(page, '将角色移至顶部')
      await sleep(800)
      snapshots.move2 = await harvest(page)

      // F5: sort by effective substats
      await openCharacterMenu(page, null)
      await menuClick(page, 'Sort by effective substats')
      await sleep(1200)
      snapshots.sorted = await harvest(page)

      // F6a: add new character 1107 (Clara) with LC 20000, eidolon 0
      await openCharacterMenu(page, null)
      await menuClick(page, '添加新角色')
      await pollUntil('角色选择弹窗', async () => ({ ok: (await page.evaluate(P_MODAL_OPEN)) === true }), 10_000)
      // the modal's own CharacterSelect input: first readOnly empty input inside dialog
      await page.evaluate(`() => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); const i = [...d.querySelectorAll('input')].find((x) => x.readOnly); i.click(); return true }`)
      await pollUntil('选择角色弹窗打开', async () => ({ ok: (await page.evaluate(`() => document.querySelectorAll('[data-id]').length > 0`)) === true }), 10_000)
      await page.type('克拉拉')
      await sleep(500)
      await page.press('Enter')
      await pollUntil('回到编辑弹窗', async () => ({
        ok: await page.evaluate(`() => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); return !!d && [...d.querySelectorAll('input')].some((x) => (x.value || '').includes('克拉拉')) }`),
      }), 10_000)
      // pick the light cone via the modal's LC select (first card = signature)
      await page.evaluate(`() => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); const inputs = [...d.querySelectorAll('input')]; const lc = inputs.find((x) => x.readOnly && inputs.indexOf(x) > 0); lc.click(); return true }`)
      await pollUntil('光锥选择弹窗打开', async () => ({ ok: (await page.evaluate(`() => [...document.querySelectorAll('[data-id]')].filter((e) => e.offsetParent !== null).length > 0`)) === true }), 10_000)
      await sleep(600)
      snapshots.pickedLcId = await page.evaluate(`() => { const card = [...document.querySelectorAll('[data-id]')].filter((e) => e.offsetParent !== null)[0]; if (!card) return null; card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return card.getAttribute('data-id') }`)
      await sleep(800)
      await page.evaluate(P_CLICK_TEXT, ['保存', true, '[role="dialog"]'])
      await sleep(1200)
      snapshots.upsertNew = await harvest(page)

      // F6b: edit 1107 → eidolon 3
      await page.evaluate(`(id) => { const row = document.querySelector('[data-character-id="' + id + '"]'); row.click(); return true }`, ['1107'])
      await sleep(300)
      await page.evaluate(`(id) => { const row = document.querySelector('[data-character-id="' + id + '"]'); const btn = [...row.querySelectorAll('button[aria-label]')].find((b) => (b.getAttribute('aria-label') || '').startsWith('更改角色')); btn.click(); return !!btn }`, ['1107'])
      await pollUntil('编辑弹窗打开', async () => ({ ok: (await page.evaluate(P_MODAL_OPEN)) === true }), 10_000)
      await sleep(600)
      await page.evaluate(P_CLICK_TEXT, ['3魂', true, '[role="dialog"]'])
      await sleep(400)
      await page.evaluate(P_CLICK_TEXT, ['保存', true, '[role="dialog"]'])
      await sleep(1200)
      snapshots.upsertEdit = await harvest(page)

      // F7: delete 1005
      snapshots.deleted = null
      try {
        await clickThenConfirm(page, () => page.evaluate(`(id) => { const row = document.querySelector('[data-character-id="' + id + '"]'); const btn = [...row.querySelectorAll('button[aria-label]')].find((b) => (b.getAttribute('aria-label') || '').startsWith('删除角色')); btn.click(); return !!btn }`, ['1005']), '确认')
        await sleep(1000)
        snapshots.deleted = await harvest(page)
      } catch (e) {
        snapshots.deleteError = String(e?.message ?? e).slice(0, 160)
      }

      // F8: unequip 1205
      snapshots.unequipped = null
      try {
        await openCharacterMenu(page, '1205')
        await menuClick(page, '卸下角色装备')
        await clickThenConfirm(page, async () => ({ ok: true }), '确认')
        await sleep(800)
        snapshots.unequipped = await harvest(page)
      } catch (e) {
        snapshots.unequipError = String(e?.message ?? e).slice(0, 160)
      }

      // F9: switch relics 1101 ↔ 1102 (tolerate step failure — earlier
      // snapshots still get compared)
      snapshots.switched = null
      try {
        await openCharacterMenu(page, '1101')
        await menuClick(page, '和另一角色切换遗器')
        await pollUntil('交换弹窗打开(搜索角色组合框)', async () => ({ ok: await page.evaluate(`() => { const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null); const d = dialogs[dialogs.length - 1]; return !!d && [...d.querySelectorAll('button')].some((b) => (b.textContent || '').includes('搜索角色')) }`) }), 10_000)
        // open the combobox (target is a BUTTON showing the placeholder)
        await page.evaluate(P_CLICK_TEXT, ['搜索角色', false, '[role="dialog"]'])
        await sleep(700)
        // type into the dropdown's search input, then pick the 希儿 option
        await typeIntoPlaceholder(page, '搜索角色', '希儿')
        await sleep(700)
        await page.evaluate(P_CLICK_TEXT, ['希儿', false])
        await sleep(600)
        await page.evaluate(P_CLICK_TEXT, ['保存', true, '[role="dialog"]'])
        await sleep(1200)
        snapshots.switched = await harvest(page)
      } catch (e) {
        snapshots.switchError = String(e?.message ?? e).slice(0, 160)
      }

      return snapshots
    })

    // MCP mirror, step by step, comparing after each action
    await callTool(client, 'set_character_rank', { characterId: '1101', index: 0 })
    let mcpState = await mcpExport()
    record('characters.rank.move', 1, '把同一角色移到同一位置后,两边导出存档的 characters 顺序一致;index=0 与「移到顶部」等价',
      orderOf(web.move1).join(',') === orderOf(mcpState).join(','),
      `move 1101→0: web ${orderOf(web.move1).join(',')} vs mcp ${orderOf(mcpState).join(',')}`)
    await callTool(client, 'set_character_rank', { characterId: '1202', index: 0 })
    mcpState = await mcpExport()
    const move2Ok = orderOf(web.move2).join(',') === orderOf(mcpState).join(',')
    record('characters.rank.move', 1, '第二次移动(1202→0)后顺序仍一致', move2Ok,
      `web ${orderOf(web.move2).join(',')} vs mcp ${orderOf(mcpState).join(',')}`)

    const sortRes = await callTool(client, 'set_character_rank', { sortBy: 'effectiveSubstats' })
    mcpState = await mcpExport()
    record('characters.rank.sortByEffectiveSubstats', 1, '同一存档排序后,两边导出存档的 characters 顺序一致(含得分相同时的稳定顺序)',
      orderOf(web.sorted).join(',') === orderOf(mcpState).join(','),
      `web ${orderOf(web.sorted).join(',')} vs mcp ${orderOf(mcpState).join(',')};mcp scores=${JSON.stringify((sortRes.characters ?? []).map((c) => c.effectiveSubstats)).slice(0, 160)}`)

    const pickedLc = web.upsertNew ? (web.pickedLcId ?? '20000') : '20000'
    const upsertRes = await callTool(client, 'upsert_character', { characterId: '1107', lightCone: pickedLc, characterEidolon: 0, lightConeSuperimposition: 1 })
    mcpState = await mcpExport()
    const webNew = charIn(web.upsertNew, '1107')
    const mcpNew = charIn(mcpState, '1107')
    const webIdx = orderOf(web.upsertNew).indexOf('1107')
    const mcpIdx = orderOf(mcpState).indexOf('1107')
    const newOk = webNew != null && mcpNew != null
      && webIdx === mcpIdx
      && firstDiff(webNew?.form, mcpNew?.form) == null
      && Object.keys(equippedOf(web.upsertNew, '1107')).length === 0
      && Object.keys(equippedOf(mcpState, '1107')).length === 0
    record('characters.upsert', 1, '新建角色后两边存档里的该角色(默认表单、空装备、插入位置)一致', newOk,
      `insert web@${webIdx} mcp@${mcpIdx} (NewCharacterDefaultRank=First);form ${firstDiff(webNew?.form, mcpNew?.form) ?? '一致'};equipped 两边均空`)

    await callTool(client, 'upsert_character', { characterId: '1107', characterEidolon: 3 })
    mcpState = await mcpExport()
    const editOk = charIn(web.upsertEdit, '1107')?.form?.characterEidolon === 3
      && firstDiff(charIn(web.upsertEdit, '1107')?.form, charIn(mcpState, '1107')?.form) == null
    record('characters.upsert', 2, '修改已有角色的光锥、叠影、星魂后两边存档一致,其余表单字段不变', editOk,
      `e3 表单 ${firstDiff(charIn(web.upsertEdit, '1107')?.form, charIn(mcpState, '1107')?.form) ?? '一致'}`)

    await callTool(client, 'delete_character', { characterId: '1005' })
    mcpState = await mcpExport()
    const delOk = web.deleted != null
      && orderOf(web.deleted).join(',') === orderOf(mcpState).join(',')
      && firstDiff(ownersOf(web.deleted), ownersOf(mcpState)) == null
    const webOrphans = (web.deleted?.relics ?? []).filter((r) => sample.relics.find((x) => x.id === r.id)?.equippedBy === '1005')
    record('characters.delete', 1, '删除后两边存档的角色列表一致,原佩戴遗器的 equippedBy 均为空', delOk,
      web.deleted == null
        ? `网页步骤失败:${web.deleteError ?? '未知'}`
        : `roster ${orderOf(web.deleted).join(',') === orderOf(mcpState).join(',') ? '一致' : '不一致'};${webOrphans.length} 件原 1005 遗器 equippedBy=${[...new Set(webOrphans.map((r) => r.equippedBy ?? '无'))].join('/')}`)

    await callTool(client, 'unequip_character', { characterId: '1205' })
    mcpState = await mcpExport()
    const uneqOk = web.unequipped != null
      && Object.keys(equippedOf(web.unequipped, '1205')).length === 0
      && Object.keys(equippedOf(mcpState, '1205')).length === 0
      && firstDiff(ownersOf(web.unequipped), ownersOf(mcpState)) == null
    record('characters.unequip', 1, '卸下后两边存档里该角色的 equipped 为空,六件遗器的 equippedBy 为空', uneqOk,
      web.unequipped == null
        ? `网页步骤失败:${web.unequipError ?? '未知'}`
        : `1205 equipped web=${JSON.stringify(equippedOf(web.unequipped, '1205'))} mcp=${JSON.stringify(equippedOf(mcpState, '1205'))}`)

    await callTool(client, 'switch_relics', { characterIdA: '1101', characterIdB: '1102' })
    mcpState = await mcpExport()
    const swOk = web.switched != null
      && firstDiff(equippedOf(web.switched, '1101'), equippedOf(mcpState, '1101')) == null
      && firstDiff(equippedOf(web.switched, '1102'), equippedOf(mcpState, '1102')) == null
      && firstDiff(ownersOf(web.switched), ownersOf(mcpState)) == null
    record('characters.switchRelics', 1, '交换后两边存档里两名角色的 equipped 与相关遗器的 equippedBy 一致', swOk,
      web.switched == null
        ? `网页步骤失败:${web.switchError ?? '未知'}(其余步骤已对拍)`
        : `1101 ${firstDiff(equippedOf(web.switched, '1101'), equippedOf(mcpState, '1101')) ?? '一致'};1102 ${firstDiff(equippedOf(web.switched, '1102'), equippedOf(mcpState, '1102')) ?? '一致'};归属表 ${firstDiff(ownersOf(web.switched), ownersOf(mcpState)) ?? '一致'}`)
  })

  // ══ F10-F17 builds (seed B) ═════════════════════════════════════════════
  await guard('F10-F17', async () => {
    await callTool(client, 'load_save', { path: seedBPath })
    const web = await browserManager.runTask({ label: 'F10-F17 builds', seed: readFileSync(seedBPath, 'utf8'), timeoutMs: 600_000 }, async (page) => {
      const shots = {}
      await bootZh(page, '#characters', '[data-character-id]')
      await sleep(1500)

      await pageStep(shots, 'shots.afterCharSave', async () => {
      // F10 case1: character-source save on 1212b1
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '保存当前配装')
      await pollUntil('保存配装弹窗', async () => ({ ok: (await page.evaluate(P_MODAL_OPEN)) === true }), 10_000)
      await typeIntoLabelled(page, '配装名称', 'web-char-build')
      await sleep(300)
      await page.evaluate(P_CLICK_TEXT, ['保存', true, '[role="dialog"]'])
      await sleep(1200)
      shots.afterCharSave = await harvest(page)

      })
      await pageStep(shots, 'shots.afterOverwrite', async () => {
      // F10 case3: duplicate name → 保存 disabled; overwrite path via 覆盖 + confirm
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '保存当前配装')
      await pollUntil('保存配装弹窗2', async () => ({ ok: (await page.evaluate(P_MODAL_OPEN)) === true }), 10_000)
      await typeIntoLabelled(page, '配装名称', 'web-char-build')
      await sleep(400)
      shots.dupSaveDisabled = await page.evaluate(`() => {
        const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop()
        const btns = [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
        const save = btns.find((b) => (b.textContent || '').trim() === '保存')
        const overwrite = btns.find((b) => (b.textContent || '').trim() === '覆盖')
        return { saveDisabled: save ? save.disabled : null, overwriteDisabled: overwrite ? overwrite.disabled : null }
      }`)
      await page.evaluate(P_CLICK_TEXT, ['覆盖', true, '[role="dialog"]'])
      await sleep(400)
      await page.evaluate(P_CLICK_ANY_DIALOG, ['确认'])
      await sleep(1200)
      shots.afterOverwrite = await harvest(page)

      })
      await pageStep(shots, 'shots.buildListDom', async () => {
        // F11: builds list DOM order (name leaves of the build cards, in DOM order)
        await openCharacterMenu(page, '1212b1')
        await menuClick(page, '查看已保存配装')
        await pollUntil('配装弹窗(buildPreview)', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#buildPreview')`)) === true }), 15_000)
        await sleep(800)
        shots.buildListDom = await page.evaluate(`() => {
          const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop()
          const whitelist = ['inject-preview','inject-main','inject-short','inject-steal','web-char-build']
          const names = [...d.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && whitelist.includes((e.textContent || '').trim()))
          return names.map((e) => (e.textContent || '').trim())
        }`)

      })
      await pageStep(shots, 'shots.previewCard', async () => {
        // F12: the modal auto-selected inject-preview (builds[0], LC/eidolon
        // differ from the character's current state). Wait out the async sim
        // score line ("X% · grade"), then scrape it plus the basic stat block
        // (first occurrence of each zh stat label — the basic block precedes
        // the combat block and the relic cards in innerText order).
        const P_PREVIEW = `() => {
          const card = document.querySelector('#buildPreview')
          if (!card) return null
          const lines = card.innerText.split(String.fromCharCode(10)).map((l) => l.trim())
          const scoreLine = lines.find((l) => /^[0-9]+(\\.[0-9]+)?% · .+$/.test(l)) ?? null
          const zhKeys = { '生命值': 'HP', '攻击力': 'ATK', '防御力': 'DEF', '速度': 'SPD', '暴击率': 'CRIT Rate', '暴击伤害': 'CRIT DMG', '效果命中': 'Effect Hit Rate', '效果抵抗': 'Effect RES', '击破特攻': 'Break Effect' }
          const elementPrefix = { '物': 'Physical', '火': 'Fire', '冰': 'Ice', '雷': 'Lightning', '风': 'Wind', '量': 'Quantum', '虚': 'Imaginary' }
          const stats = {}
          for (let i = 0; i < lines.length - 1; i++) {
            const elemental = lines[i].match(/^(.)属性伤害$/)
            const key = zhKeys[lines[i]] ?? (elemental ? elementPrefix[elemental[1]] + ' DMG Boost' : null)
            if (key && stats[key] == null) {
              const m = lines[i + 1].match(/^([0-9.,]+)(%)?$/)
              if (m) stats[key] = { raw: Number(m[1].replace(/,/g, '')), pct: m[2] === '%' }
            }
          }
          return { scoreLine, stats, header: lines.slice(0, 2) }
        }`
        for (let i = 0; i < 15; i++) {
          shots.previewCard = await page.evaluate(P_PREVIEW)
          if (shots.previewCard && shots.previewCard.scoreLine) break
          await sleep(2000)
        }

      })
      await pageStep(shots, 'shots.afterLoadSaved', async () => {
      // F14: load inject-main into the optimizer
      await page.evaluate(`(name) => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); const btns = [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null); const card = [...d.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === name)[0]; if (!card) return false; let cardRoot = card.closest('div'); while (cardRoot && cardRoot.parentElement) { const equip = [...cardRoot.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '加载至优化器'); if (equip) { equip.click(); return true } cardRoot = cardRoot.parentElement } return false }`, ['inject-main'])
      await sleep(1500)
      shots.afterLoad = await harvest(page)
      // save the working form back: same-document hash nav + dblclick 1005
      // (switchToCharacter persists 1212b1's in-memory working form)
      await page.evaluate(`() => { location.hash = '#characters'; return location.hash }`)
      await sleep(1200)
      await page.waitForSelector('[data-character-id]', { timeoutMs: 30_000, visible: true })
      await sleep(600)
      await page.evaluate(P_DBLCLICK_ROW, ['1005'])
      await sleep(2500)
      shots.afterLoadSaved = await harvest(page)

      })
      await pageStep(shots, 'shots.afterEquipMain', async () => {
        // F13 case1 (Replace default): equip inject-main (relics worn by 1102, full team)
        // NB: same-document hash nav only — page.goto would re-seed localStorage
        // from the task seed and wipe this task's earlier mutations.
        await page.evaluate(`() => { location.hash = '#characters'; return true }`)
        await sleep(1200)
        await page.waitForSelector('[data-character-id]', { timeoutMs: 30_000, visible: true })
        await sleep(600)
        await openCharacterMenu(page, '1212b1')
        await menuClick(page, '查看已保存配装')
        await pollUntil('配装弹窗2', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#buildPreview')`)) === true }), 15_000)
        await clickThenConfirm(page, () => page.evaluate(`(name) => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); const card = [...d.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === name)[0]; let root = card; for (let i = 0; i < 8 && root; i++) { const equip = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '装备'); if (equip) { equip.click(); return true } root = root.parentElement } return false }`, ['inject-main']))
        await sleep(1800)
        shots.afterEquipMain = await harvest(page)

      })
      await pageStep(shots, 'shots.afterEquipShort', async () => {
        // F13 case2: equip inject-short (1 teammate) → scoring override unchanged
        await openCharacterMenu(page, '1212b1')
        await menuClick(page, '查看已保存配装')
        await pollUntil('配装弹窗3', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#buildPreview')`)) === true }), 15_000)
        await clickThenConfirm(page, () => page.evaluate(`(name) => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); const card = [...d.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === name)[0]; let root = card; for (let i = 0; i < 8 && root; i++) { const equip = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '装备'); if (equip) { equip.click(); return true } root = root.parentElement } return false }`, ['inject-short']))
        await sleep(1800)
        shots.afterEquipShort = await harvest(page)

      })
      await pageStep(shots, 'shots.afterEquipSwap', async () => {
      // F13 case3: Swap behavior — settings drawer → RelicEquippingBehavior=Swap.
      // The select's display and its dropdown options are NOT <button>s, so
      // P_CLICK_TEXT cannot hit them — click ANY visible element by exact text.
      const settingsClick = await page.evaluate(P_CLICK_TEXT, ['设置', true])
      await pollUntil('设置抽屉', async () => ({ ok: await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.offsetParent !== null && (e.textContent || '').includes('装备其他角色'))`) === true }), 15_000)
      if (!settingsClick.ok) throw new Error('设置按钮点击失败: ' + settingsClick.reason)
      // Mantine Select shows its value inside a readonly <input value=…>, and
      // its options render in a portal — target the input by VALUE, then click
      // the option element by exact text (retry while the dropdown opens).
      const selectOpen = await page.evaluate(`(value) => {
        const inputs = [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null)
        const hit = inputs.find((e) => (e.value || '') === value) || inputs.find((e) => (e.value || '').includes('替换遗器'))
        if (!hit) return { ok: false, reason: 'no select input (values: ' + inputs.slice(0, 8).map((e) => e.value || '').join('|').slice(0, 120) + ')' }
        hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        hit.click()
        return { ok: true }
      }`, ['默认：替换遗器而不交换'])
      await sleep(900)
      let swapOption = { ok: false }
      for (let i = 0; i < 6 && !swapOption.ok; i++) {
        swapOption = await page.evaluate(P_CLICK_EL, ['与该遗器装备者交换遗器'])
        if (!swapOption.ok) await sleep(400)
      }
      shots.swapSettingClicks = { selectOpen, swapOption }
      await sleep(600)
      // the drawer's select display must now show the Swap option label
      const swapShown = await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.offsetParent !== null && (e.textContent || '').includes('与该遗器装备者交换遗器'))`)
      shots.swapShown = swapShown
      await page.press('Escape')
      await sleep(600)
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '查看已保存配装')
      await pollUntil('配装弹窗4', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#buildPreview')`)) === true }), 15_000)
      await clickThenConfirm(page, () => page.evaluate(`(name) => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); const card = [...d.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === name)[0]; let root = card; for (let i = 0; i < 8 && root; i++) { const equip = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '装备'); if (equip) { equip.click(); return true } root = root.parentElement } return false }`, ['inject-steal']))
      await sleep(1800)
      shots.afterEquipSwap = await harvest(page)
      shots.swapSetting = shots.afterEquipSwap.settings?.RelicEquippingBehavior

      })
      await pageStep(shots, 'shots.pngHead', async () => {
        // F17: screenshot of inject-preview via the app camera button (the same
        // channel the render tool clicks; tolerant — a failure must not kill the
        // remaining delete/clear steps). The modal auto-selects inject-preview
        // (builds[0]) — no card click needed.
        shots.pngHead = null
        try {
          await openCharacterMenu(page, '1212b1')
          await menuClick(page, '查看已保存配装')
          await pollUntil('配装弹窗5', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#buildPreview')`)) === true }), 15_000)
          await page.waitForSelector('#buildPreview img', { timeoutMs: 20_000, visible: true })
          await sleep(3000)
          shots.modalState = await page.evaluate(`() => {
          const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop()
          if (!d) return { dialog: false }
          return {
            dialog: true,
            buttons: [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => ({ t: (b.textContent || '').trim().slice(0, 12), disabled: b.disabled, svg: [...b.querySelectorAll('svg')].map((x) => (x.getAttribute('class') || '')).join(' ').slice(0, 40) })).slice(0, 10),
            previewText: (document.querySelector('#buildPreview')?.innerText || '').slice(0, 120),
          }
        }`)
        let png = null
        try {
          png = await page.captureAppExport({ via: 'camera', scopeSelector: '[role="dialog"]:has(#buildPreview)', timeoutMs: 60_000 })
        } catch {
          png = await page.captureAppExport({ via: 'download', scopeSelector: '[role="dialog"]:has(#buildPreview)', timeoutMs: 60_000 })
        }
        shots.pngHead = Array.from(png.slice(0, 33)).map((b) => b.toString(16).padStart(2, '0')).join('')
      } catch (e) {
        shots.pngError = String(e?.message ?? e).slice(0, 160)
      }

      })
      await pageStep(shots, 'shots.afterDelete', async () => {
        // F15: delete inject-short
        await openCharacterMenu(page, '1212b1')
        await menuClick(page, '查看已保存配装')
        await pollUntil('配装弹窗6', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#buildPreview')`)) === true }), 15_000)
        await clickThenConfirm(page, () => page.evaluate(`(name) => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null).pop(); const card = [...d.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === name)[0]; let root = card; for (let i = 0; i < 8 && root; i++) { const del = [...root.querySelectorAll('button')].filter((b) => b.offsetParent !== null && (b.textContent || '').trim() === '' ).find((b) => b.querySelector('svg')); if (del) { del.click(); return true } root = root.parentElement } return false }`, ['inject-short']))
        await sleep(1200)
        shots.afterDelete = await harvest(page)

      })
      await pageStep(shots, 'shots.afterClear', async () => {
        // F16: clear all builds
        await openCharacterMenu(page, '1212b1')
        await menuClick(page, '查看已保存配装')
        await pollUntil('配装弹窗7', async () => ({ ok: (await page.evaluate(`() => !!document.querySelector('#buildPreview')`)) === true }), 15_000)
        await clickThenConfirm(page, () => page.evaluate(P_CLICK_TEXT, ['删除全部', true, '[role="dialog"]']))
        await sleep(1500)
        shots.afterClear = await harvest(page)

      })
      return shots
    })
    if (web.errors && Object.keys(web.errors).length) console.log('[F10-F17 pageStep errors]', JSON.stringify(web.errors))

    // ── MCP mirrors ──
    await callTool(client, 'save_build', { characterId: '1212b1', name: 'mcp-char-build' })
    let mcpState = await mcpExport()
    const webCharBuild = buildSummaries(web.afterCharSave, '1212b1').find((b) => b.name === 'web-char-build')
    const mcpCharBuild = buildSummaries(mcpState, '1212b1').find((b) => b.name === 'mcp-char-build')
    const strip = (b) => b && { ...b, name: undefined }
    record('characters.builds.save', 1, '角色页来源:保存后两边存档里的该配装(遗器、光锥、星魂、队伍、评分配置类型)一致',
      firstDiff(strip(webCharBuild), strip(mcpCharBuild)) == null,
      `web ${JSON.stringify(strip(webCharBuild))?.slice(0, 140)} vs mcp ${JSON.stringify(strip(mcpCharBuild))?.slice(0, 140)} 差异:${firstDiff(strip(webCharBuild), strip(mcpCharBuild)) ?? '无'}`)

    const listRes = await callTool(client, 'list_builds', { characterId: '1212b1' })
    const webListState = web.afterCharSave
    const webListNames = (webListState ? buildSummaries(webListState, '1212b1') : []).map((b) => b.name)
    const domNames = (web.buildListDom ?? []).filter(Boolean)
    // web saved its build as web-char-build, MCP as mcp-char-build — both are
    // the same action (save current equipment) at the same position, so the
    // name is mapped positionally before comparing sequences
    const mapName = (n) => (n === 'web-char-build' ? 'mcp-char-build' : n)
    const webNamesMapped = webListNames.map(mapName)
    const domNamesMapped = domNames.map(mapName)
    const mcpList = listRes.builds.map((b) => ({ n: b.name, s: b.source, e: b.equipped }))
    const webListTool = webNamesMapped.map((n) => {
      const b = buildSummaries(webListState, '1212b1').find((x) => mapName(x.name) === n)
      return b ? { n, s: b.source, e: b.equipped } : { n, s: undefined, e: undefined }
    })
    const listOk = JSON.stringify(domNamesMapped) === JSON.stringify(webNamesMapped)
      && JSON.stringify(mcpList) === JSON.stringify(webListTool)
    record('characters.builds.list', 1, 'list_builds 返回的配装名、顺序、来源、遗器 id 与弹窗列表一致', listOk,
      `弹窗 DOM [${domNamesMapped.join(',')}] vs 存档序 [${webNamesMapped.join(',')}];工具 [${mcpList.map((b) => b.n)}] 内容一致=${JSON.stringify(mcpList) === JSON.stringify(webListTool)}`)

    const dupErr = await toolError(client, 'save_build', { characterId: '1212b1', name: 'mcp-char-build' })
    const overRes = await callTool(client, 'save_build', { characterId: '1212b1', name: 'mcp-char-build', overwrite: true })
    const ghostRes = await callTool(client, 'save_build', { characterId: '1212b1', name: 'mcp-ghost', overwrite: true })
    mcpState = await mcpExport()
    record('characters.builds.save', 3, '重名不带 overwrite 报错,带 overwrite 覆盖;名称不存在时带 overwrite 会静默新建并返回 overwrote=false',
      dupErr != null && /存在|exists|already/i.test(String(dupErr)) && overRes.saved != null && ghostRes.overwrote === false && buildSummaries(mcpState, '1212b1').some((b) => b.name === 'mcp-ghost'),
      `重名报错:${String(dupErr).slice(0, 60)};overwrite 成功;不存在名+overwrite → overwrote=${ghostRes.overwrote}(网页「覆盖」按钮此时禁用:${JSON.stringify(web.dupSaveDisabled)})`)

    // F12 preview: the auto-selected card (inject-preview) vs score_character(source=build).
    // Web score line "17.0% · ?" is truncate10ths(max(0,percent*100)) — mirror
    // the same truncation. The card's basic stat block comes from the same
    // merged-form simulate pipeline as builds.original.stats.basic.
    const buildScore = await callTool(client, 'score_character', { source: 'build', characterId: '1212b1', buildName: 'inject-preview' }, { timeout: 180_000 })
    const previewCard = web.previewCard ?? null
    const webScoreText = previewCard?.scoreLine ?? ''
    const m = webScoreText.match(/^([0-9.]+)% · (.+)$/)
    const webPct = m ? Number(m[1]) : null
    const webGrade = m ? m[2] : null
    const trunc10 = (x) => Math.trunc(x * 10) / 10
    const mcpPct = trunc10(Math.max(0, buildScore.percent * 100))
    const scoreOk = previewCard != null && webPct != null && Math.abs(webPct - mcpPct) <= 0.05 && webGrade === buildScore.grade
    const basic = buildScore.builds?.original?.stats?.basic ?? {}
    const statChecks = []
    for (const [key, webStat] of Object.entries(previewCard?.stats ?? {})) {
      const mcpVal = basic[key]
      if (mcpVal == null || webStat.raw == null || Number.isNaN(webStat.raw)) continue
      const webVal = webStat.pct ? webStat.raw / 100 : webStat.raw
      // the card truncates display (integers for flats, 1 decimal for SPD/%)
      statChecks.push({ key, web: webVal, mcp: mcpVal, ok: Math.abs(webVal - mcpVal) <= (webStat.pct ? 0.0015 : 1.01) })
    }
    const statsOk = statChecks.length >= 8 && statChecks.every((c) => c.ok)
    const firstBad = statChecks.find((c) => !c.ok)
    record('characters.builds.preview', 1, '对一个光锥、星魂与当前角色不同的已存配装,返回的属性与评分和弹窗里这张展示卡上的数值一致', scoreOk && statsOk,
      `网页卡评分行「${webScoreText}」(头部 ${JSON.stringify(previewCard?.header ?? [])}) vs score_character ${mcpPct.toFixed(1)}% ${buildScore.grade};属性 ${statChecks.length} 项逐项比${statsOk ? '一致' : `首个差异 ${firstBad ? firstBad.key + ' ' + firstBad.web + '/' + firstBad.mcp : '(项数不足)'}`}`)

    // F14: update_form fromBuild vs web loaded form. The web flow is
    // Load(→working form in memory) → dblclick 1005 (switch away persists the
    // working form RAW). Mirror exactly, then compare the raw saved forms.
    await callTool(client, 'update_form', { characterId: '1212b1', fromBuild: 'inject-main' })
    const sessionAfterLoad = await callTool(client, 'get_state', { section: 'session' })
    const loadIdMcp = sessionAfterLoad.session?.ephemeral?.activeKey ?? sessionAfterLoad.session?.savedSession?.global?.optimizerCharacterId
    await callTool(client, 'update_form', { characterId: '1005' })
    const mcpLoadState = await mcpExport()
    const webLoadedForm = charIn(web.afterLoadSaved, '1212b1')?.form
    const mcpLoadedForm = charIn(mcpLoadState, '1212b1')?.form
    const loadIdWeb = web.afterLoad?.savedSession?.global?.optimizerCharacterId
    const loadOk = web.afterLoadSaved != null && loadIdWeb === '1212b1' && firstDiff(webLoadedForm, mcpLoadedForm) == null
    record('characters.builds.loadInOptimizer', 1, '载入同一配装后,get_form 返回的工作表单与网页优化器表单逐字段一致,optimizerCharacterId 指向该角色', loadOk,
      `optimizerCharacterId web=${loadIdWeb} mcp=${loadIdMcp};存档表单 ${firstDiff(webLoadedForm, mcpLoadedForm) ?? '一致'}`)

    // F13 case1: equip inject-main (Replace)
    await callTool(client, 'equip_saved_build', { characterId: '1212b1', buildName: 'inject-main', applyScoringTeam: true })
    mcpState = await mcpExport()
    const eq1Ok = web.afterEquipMain != null && firstDiff(equippedOf(web.afterEquipMain, '1212b1'), equippedOf(mcpState, '1212b1')) == null
      && firstDiff(ownersOf(web.afterEquipMain), ownersOf(mcpState)) == null
      && firstDiff(
        web.afterEquipMain?.scoringMetadataOverrides?.['1212b1']?.simulation?.teammates?.map((t) => [t.characterId, t.lightCone]) ?? null,
        mcpState.scoringMetadataOverrides?.['1212b1']?.simulation?.teammates?.map((t) => [t.characterId, t.lightCone]) ?? null,
      ) == null
    record('characters.builds.equip', 1, '装备带 3 名队友的配装后,两边存档的 equipped 与 scoringMetadataOverrides[角色].simulation.teammates 一致', eq1Ok,
      web.afterEquipMain == null
        ? `网页步骤失败:${web.errors?.['shots.afterEquipMain'] ?? '未知'}`
        : `equipped ${firstDiff(equippedOf(web.afterEquipMain, '1212b1'), equippedOf(mcpState, '1212b1')) ?? '一致'};归属 ${firstDiff(ownersOf(web.afterEquipMain), ownersOf(mcpState)) ?? '一致'};评分队 ${firstDiff(web.afterEquipMain.scoringMetadataOverrides?.['1212b1']?.simulation?.teammates?.map((t) => [t.characterId, t.lightCone]) ?? null, mcpState.scoringMetadataOverrides?.['1212b1']?.simulation?.teammates?.map((t) => [t.characterId, t.lightCone]) ?? null) ?? '一致'}`)

    const webOverrideBeforeShort = web.afterEquipShort?.scoringMetadataOverrides?.['1212b1']?.simulation?.teammates ?? null
    await callTool(client, 'equip_saved_build', { characterId: '1212b1', buildName: 'inject-short', applyScoringTeam: true })
    mcpState = await mcpExport()
    const eq2Ok = web.afterEquipShort != null && firstDiff(equippedOf(web.afterEquipShort, '1212b1'), equippedOf(mcpState, '1212b1')) == null
      && firstDiff(web.afterEquipShort?.scoringMetadataOverrides?.['1212b1'] ?? null, mcpState.scoringMetadataOverrides?.['1212b1'] ?? null) == null
    record('characters.builds.equip', 2, '队友不足 3 人的配装不改评分覆盖', eq2Ok,
      web.afterEquipShort == null
        ? `网页步骤失败:${web.errors?.['shots.afterEquipShort'] ?? '未知'}`
        : `短队装备后评分覆盖 web=${JSON.stringify(webOverrideBeforeShort)?.slice(0, 80)} mcp=${JSON.stringify(mcpState.scoringMetadataOverrides?.['1212b1']?.simulation?.teammates ?? null)?.slice(0, 80)}`)

    await callTool(client, 'update_state', { section: 'settings', patch: { RelicEquippingBehavior: 'Swap' } })
    await callTool(client, 'equip_saved_build', { characterId: '1212b1', buildName: 'inject-steal' })
    mcpState = await mcpExport()
    const eq3Ok = web.afterEquipSwap != null && web.swapSetting === 'Swap' && mcpState.settings?.RelicEquippingBehavior === 'Swap'
      && firstDiff(ownersOf(web.afterEquipSwap), ownersOf(mcpState)) == null
      && firstDiff(equippedOf(web.afterEquipSwap, '1202'), equippedOf(mcpState, '1202')) == null
    record('characters.builds.equip', 3, '配装遗器被他人佩戴时,Replace 与 Swap 两种设置下的归属变化与网页一致', eq3Ok,
      web.afterEquipSwap == null
        ? `网页步骤失败:${web.errors?.['shots.afterEquipSwap'] ?? '未知'}`
        : `设置 web=${web.swapSetting} mcp=${mcpState.settings?.RelicEquippingBehavior}(点击 ${JSON.stringify(web.swapSettingClicks)} 显示=${web.swapShown});Swap 后 1202 获得 ${Object.keys(equippedOf(web.afterEquipSwap, '1202')).length} 件;归属 ${firstDiff(ownersOf(web.afterEquipSwap), ownersOf(mcpState)) ?? '一致'}`)

    // F17 screenshot: render tool vs the web capture (camera button, the same
    // export chain the render tool clicks). The web PNG's first 33 bytes are
    // stashed: signature + the whole IHDR chunk (width/height/depth/color
    // type/interlace) — byte equality there proves identical dimensions and
    // identical transparent-RGBA background handling.
    const renderRes = await callTool(client, 'render', { target: 'saved_build', characterId: '1212b1', buildId: 'inject-preview' }, { timeout: 240_000 })
    const renderHead = Array.from(readFileSync(renderRes.file).slice(0, 33)).map((b) => b.toString(16).padStart(2, '0')).join('')
    const webHead = web.pngHead
    record('characters.builds.screenshot', 1, '渲染出的图片尺寸、文字与数值和网页下载的配装截图一致,背景透明处理相同',
      webHead != null && webHead.startsWith('89504e47') && renderHead.startsWith('89504e47') && webHead === renderHead && renderRes.via.startsWith('app-'),
      webHead == null
        ? `网页捕获失败:${web.pngError ?? '未知'};弹窗态=${JSON.stringify(web.modalState ?? {}).slice(0, 200)};render 侧 ${renderRes.width}x${renderRes.height} via=${renderRes.via}`
        : `PNG 头逐字节一致=${webHead === renderHead};render ${renderRes.width}x${renderRes.height} ${renderRes.bytes}B via=${renderRes.via}`)

    // F15 delete / F16 clear — mirror the SAME build the web deleted
    // (inject-short); mcp-ghost (MCP-only artifact of the overwrite case) is
    // removed too so both sides carry identical build lists
    await callTool(client, 'delete_build', { characterId: '1212b1', name: 'inject-short' })
    await callTool(client, 'delete_build', { characterId: '1212b1', name: 'mcp-ghost' })
    mcpState = await mcpExport()
    const webDeletedNames = (web.afterDelete ? buildSummaries(web.afterDelete, '1212b1') : []).map((b) => mapName(b.name))
    const mcpDeletedNames = buildSummaries(mcpState, '1212b1').map((b) => b.name)
    const delOk = web.afterDelete != null
      && firstDiff(webDeletedNames, mcpDeletedNames) == null
      && !webDeletedNames.includes('inject-short') && !mcpDeletedNames.includes('inject-short')
    record('characters.builds.delete', 1, '删除后两边存档里该角色的 builds 一致', delOk,
      web.afterDelete == null
        ? `网页步骤失败:${web.errors?.['shots.afterDelete'] ?? '未知'}`
        : `web [${webDeletedNames.join(',')}] vs mcp [${mcpDeletedNames.join(',')}]`)

    await callTool(client, 'delete_build', { characterId: '1212b1', all: true })
    mcpState = await mcpExport()
    record('characters.builds.clear', 1, '清空后两边存档里该角色的 builds 都是空数组',
      web.afterClear != null
        && (charIn(web.afterClear, '1212b1')?.builds ?? []).length === 0
        && (charIn(mcpState, '1212b1')?.builds ?? []).length === 0,
      web.afterClear == null
        ? `网页步骤失败:${web.errors?.['shots.afterClear'] ?? '未知'}`
        : `web ${(charIn(web.afterClear, '1212b1')?.builds ?? []).length} 个;mcp ${(charIn(mcpState, '1212b1')?.builds ?? []).length} 个`)
  })

  // ══ F10 case2: optimizer-source save + F20 traces case3 web optimizer run ══
  await guard('F10c2', async () => {
    await callTool(client, 'load_save', { path: seedAPath })
    const web = await browserManager.runTask({ label: 'F10c2 optimizer-source', seed: readFileSync(seedAPath, 'utf8'), timeoutMs: 600_000 }, async (page) => {
      await bootZh(page, '#main', 'button')
      await sleep(2000)
      // switch superimposition to 5 (the run form override the build must snapshot)
      await page.evaluate(P_CLICK_TEXT, ['叠5', true])
      await sleep(500)
      // smallest results limit
      await page.evaluate(`() => {
        const labels = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '优化目标')
        return labels.length
      }`)
      // Start optimization (limit left at default; 1212b1 on sample ≈ 462k perms)
      await page.evaluate(P_CLICK_TEXT, ['启动优化器', true])
      // wait for results: a data row (>= 6 cells) renders in the grid
      await pollUntil('优化结果行出现', async () => ({
        ok: await page.evaluate(`() => [...document.querySelectorAll('[role="row"]')].some((r) => r.querySelectorAll('[role="gridcell"], .ag-cell').length > 5)`),
      }), 300_000, 500)
      await sleep(1500)
      const scrapeRows = () => page.evaluate(`() => {
        const rows = [...document.querySelectorAll('[role="row"]')].filter((r) => r.querySelectorAll('[role="gridcell"], .ag-cell').length > 5)
        return rows.slice(0, 4).map((row) => {
          const out = {}
          for (const c of row.querySelectorAll('[role="gridcell"], .ag-cell')) {
            const col = c.getAttribute('col-id')
            if (col) out[col] = (c.textContent || '').trim()
          }
          return out
        })
      }`)
      await pollUntil('优化结果行出现(≥2 行)', async () => ({
        ok: await page.evaluate(`() => [...document.querySelectorAll('[role="row"]')].filter((r) => r.querySelectorAll('[role="gridcell"], .ag-cell').length > 5).length >= 2`),
      }), 300_000, 500)
      const firstRows = await scrapeRows()
      // select the first RESULT row (the grid's row 0 is the equipped baseline)
      // — AG Grid selection needs a full mouse sequence on the row's first cell
      await page.evaluate(`() => {
        const rows = [...document.querySelectorAll('[role="row"]')].filter((r) => r.querySelectorAll('[role="gridcell"], .ag-cell').length > 5)
        if (rows.length > 1) {
          const cell = rows[1].querySelector('[role="gridcell"], .ag-cell')
          if (cell) {
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
            cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
            cell.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
          }
          return true
        }
        return false
      }`)
      await sleep(800)
      // save the selected row as a build from the optimizer sidebar
      await page.evaluate(P_CLICK_TEXT, ['保存', true])
      await pollUntil('保存配装弹窗', async () => ({ ok: (await page.evaluate(P_MODAL_OPEN)) === true }), 10_000)
      await typeIntoLabelled(page, '配装名称', 'web-opt-build')
      await sleep(300)
      await page.evaluate(P_CLICK_TEXT, ['保存', true, '[role="dialog"]'])
      await sleep(1500)
      let state = await harvest(page)
      if (state == null) {
        await sleep(1500)
        state = await harvest(page)
      }
      return { firstRows, state }
    })

    const mcpRun = await callTool(client, 'optimize', { characterId: '1212b1', formOverrides: { lightConeSuperimposition: 5 } }, { timeout: 300_000 })
    // the web saved whichever result row its grid had selected — mirror by
    // matching that row's relic set in the MCP cache
    const webBuild = buildSummaries(web.state, '1212b1').find((b) => b.name === 'web-opt-build')
    const webEquipKey = [...Object.values(webBuild?.equipped ?? {})].filter(Boolean).sort().join(',')
    const rowKey = (r) => [...Object.values(r.build?.relics ?? {})].map((x) => x?.id).filter(Boolean).sort().join(',')
    const matchIdx = mcpRun.rows.findIndex((r) => rowKey(r) === webEquipKey)
    let mcpBuild = null
    if (matchIdx >= 0) {
      await callTool(client, 'save_build', { characterId: '1212b1', name: 'mcp-opt-build', fromCache: { cacheId: mcpRun.summary.cacheId, rowId: mcpRun.rows[matchIdx].id } })
      const mcpState = await mcpExport()
      mcpBuild = buildSummaries(mcpState, '1212b1').find((b) => b.name === 'mcp-opt-build')
    }
    const strip = (b) => b && { ...b, name: undefined }
    const optOk = webBuild != null && mcpBuild != null && firstDiff(strip(webBuild), strip(mcpBuild)) == null && webBuild.lightConeSuperimposition === 5
    record('characters.builds.save', 2, '优化器来源:保存的表单快照是该次运行实际使用的表单', optOk,
      `web s=${webBuild?.lightConeSuperimposition};选中行在 MCP 结果第 ${matchIdx} 行;${mcpBuild == null ? '未找到对应行' : `差异 ${firstDiff(strip(webBuild), strip(mcpBuild)) ?? '无'}`};网页网格前两行=${JSON.stringify((web.firstRows ?? []).slice(0, 2)).slice(0, 200)}`)
  })

  // ══ F18/F19 scoring weights + resetAll ═══════════════════════════════════
  await guard('F18/F19', async () => {
    await callTool(client, 'load_save', { path: seedAPath })
    const meta = await callTool(client, 'get_scoring_metadata', { characterId: '1212b1' })
    const atkDefault = meta.defaults?.stats?.ATK ?? meta.stats?.ATK
    const web = await browserManager.runTask({ label: 'F18/F19 scoring', seed: readFileSync(seedAPath, 'utf8'), timeoutMs: 420_000 }, async (page) => {
      const shots = {}
      let typed = null
      await bootZh(page, '#characters', '[data-character-id]')
      await sleep(1500)

      await pageStep(shots, 'shots.weights', async () => {
      // weights: ATK → 1
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '评分算法')
      await pollUntil('评分弹窗(属性权重)', async () => ({ ok: (await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '属性权重')`)) === true }), 10_000)
      await sleep(800)
      typed = await typeNumberBeside(page, '攻击力', '1')
      await sleep(600)
      await page.evaluate(P_CLICK_TEXT, ['保存更改', true, '[role="dialog"]'])
      await sleep(1500)
      shots.weights = await harvest(page)
      if (shots.weights?.scoringMetadataOverrides?.['1212b1'] == null) {
        await sleep(2000)
        shots.weights = await harvest(page)
      }

      })
      await pageStep(shots, 'shots.parts', async () => {
      // parts: Body multi-select — remove the 暴击伤害 pill (placeholder 躯干)
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '评分算法')
      await pollUntil('评分弹窗2', async () => ({ ok: (await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '属性权重')`)) === true }), 10_000)
      await sleep(800)
      const pill = await page.evaluate(P_PILL_REMOVE, ['暴击伤害'])
      await sleep(600)
      await page.evaluate(P_CLICK_TEXT, ['保存更改', true, '[role="dialog"]'])
      await sleep(1500)
      shots.parts = await harvest(page)
      if (shots.parts?.scoringMetadataOverrides?.['1212b1']?.parts == null) {
        await sleep(2000)
        shots.parts = await harvest(page)
      }

      })
      await pageStep(shots, 'shots.reset', async () => {
      // reset to default
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '评分算法')
      await pollUntil('评分弹窗3', async () => ({ ok: (await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '属性权重')`)) === true }), 10_000)
      await sleep(600)
      await page.evaluate(P_CLICK_TEXT, ['重置为默认', true, '[role="dialog"]'])
      await sleep(1200)
      shots.reset = await harvest(page)

      })
      await pageStep(shots, 'shots.afterResetAll', async () => {
      // resetAll: put an override back, then 重置所有角色 → confirm 是
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '评分算法')
      await pollUntil('评分弹窗4', async () => ({ ok: (await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '属性权重')`)) === true }), 10_000)
      await sleep(800)
      await typeNumberBeside(page, '击破特攻', '1')
      await sleep(300)
      await page.evaluate(P_CLICK_TEXT, ['保存更改', true, '[role="dialog"]'])
      await sleep(1500)
      shots.beforeResetAll = await harvest(page)
      await openCharacterMenu(page, '1212b1')
      await menuClick(page, '评分算法')
      await pollUntil('评分弹窗5', async () => ({ ok: (await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '属性权重')`)) === true }), 10_000)
      await sleep(600)
        await clickThenConfirm(page, () => page.evaluate(P_CLICK_TEXT, ['重置所有角色', true, '[role="dialog"]']), '是')
      // the reset debounces its save for 5s; harvest with a long window
      let after = null
      for (let i = 0; i < 12 && after == null; i++) {
        after = await page.harvestSaveState()
        if (after == null) {
          shots.resetAllDbg = await page.evaluate(`() => ({ len: (localStorage.getItem('state') || '').length, ready: document.readyState })`)
          await sleep(1000)
        }
      }
      shots.afterResetAll = after
      })
      return { shots, typed }
    })
    if (web.errors && Object.keys(web.errors).length) console.log('[F18/F19 pageStep errors]', JSON.stringify(web.errors))

    // MCP mirrors
    const w1 = await callTool(client, 'set_scoring_override', { characterId: '1212b1', weights: { ATK: 1 }, linkFlatAndPercent: true })
    let mcpState = await mcpExport()
    const webStats = web.shots.weights?.scoringMetadataOverrides?.['1212b1']?.stats ?? null
    const mcpStats = mcpState.scoringMetadataOverrides?.['1212b1']?.stats ?? null
    record('characters.scoring.weights', 1, '只把 ATK 权重改为 1 后,两边存档的 scoringMetadataOverrides 里 ATK 与 ATK% 都是 1',
      web.shots.weights != null && webStats?.ATK === 1 && webStats?.['ATK%'] === 1 && mcpStats?.ATK === 1 && mcpStats?.['ATK%'] === 1 && firstDiff(webStats, mcpStats) == null,
      web.shots.weights == null
        ? `网页步骤失败:${JSON.stringify(web.errors ?? {}).slice(0, 160)}`
        : `web stats=${JSON.stringify(webStats)};mcp stats=${JSON.stringify(mcpStats)}(默认 ATK=${atkDefault})`)

    // mirror the web action: REMOVE 暴击伤害 (CRIT DMG) from the Body candidates
    // (the web pill removal acts on the effective list; default minus CRIT DMG)
    const bodyDefault = (meta.defaults?.parts?.Body ?? meta.parts?.Body ?? []).filter((x) => x !== 'CRIT DMG')
    await callTool(client, 'set_scoring_override', { characterId: '1212b1', parts: { Body: bodyDefault } })
    mcpState = await mcpExport()
    const webParts = web.shots.parts?.scoringMetadataOverrides?.['1212b1']?.parts ?? null
    const mcpParts = mcpState.scoringMetadataOverrides?.['1212b1']?.parts ?? null
    const partsOk = web.shots.parts != null && firstDiff(webParts, mcpParts) == null
    record('characters.scoring.weights', 2, '修改部位主词条候选后两边存档一致,与默认值相同的项被剪掉', partsOk,
      web.shots.parts == null
        ? `网页步骤失败:${JSON.stringify(web.errors ?? {}).slice(0, 160)}`
        : `web parts=${JSON.stringify(webParts)};mcp parts=${JSON.stringify(mcpParts)}`)

    await callTool(client, 'set_scoring_override', { characterId: '1212b1', reset: true })
    mcpState = await mcpExport()
    const resetOk = web.shots.reset != null && web.shots.reset.scoringMetadataOverrides?.['1212b1'] == null && mcpState.scoringMetadataOverrides?.['1212b1'] == null
    record('characters.scoring.weights', 3, '恢复默认后该角色在 scoringMetadataOverrides 里没有任何条目', resetOk,
      web.shots.reset == null
        ? `网页步骤失败:${JSON.stringify(web.errors ?? {}).slice(0, 160)}`
        : `web ${JSON.stringify(web.shots.reset.scoringMetadataOverrides ?? {})};mcp ${JSON.stringify(mcpState.scoringMetadataOverrides ?? {})}`)

    await callTool(client, 'set_scoring_override', { characterId: '1212b1', weights: { 'Break Effect': 1 } })
    const resetAll = await callTool(client, 'set_scoring_override', { resetAll: true })
    mcpState = await mcpExport()
    const resetAllOk = web.shots.afterResetAll != null && Object.keys(web.shots.afterResetAll.scoringMetadataOverrides ?? {}).length === 0
      && Object.keys(mcpState.scoringMetadataOverrides ?? {}).length === 0
      && Object.keys(web.shots.beforeResetAll?.scoringMetadataOverrides ?? {}).length >= 1
    record('characters.scoring.resetAll', 1, '重置后两边存档的 scoringMetadataOverrides 都是空对象', resetAllOk,
      web.shots.afterResetAll == null
        ? `网页步骤失败:${JSON.stringify(web.errors ?? {}).slice(0, 160)};localStorage 探针=${JSON.stringify(web.shots.resetAllDbg ?? null)}`
        : `前置覆盖 web=${Object.keys(web.shots.beforeResetAll?.scoringMetadataOverrides ?? {})};重置后 web=${Object.keys(web.shots.afterResetAll.scoringMetadataOverrides ?? {})} mcp=${Object.keys(mcpState.scoringMetadataOverrides ?? {})}(cleared=${resetAll.clearedCharacters})`)
  })

  // ══ F20 traces ═══════════════════════════════════════════════════════════
  await guard('F20', async () => {
    await callTool(client, 'load_save', { path: seedAPath })
    const detail = await readResource(client, 'game://metadata/characters/1212b1')
    // pick a node with children and a deep leaf under it (prefer a mid-tree node)
    const flat = []
    const walk = (nodes, depth, parent) => {
      for (const n of nodes) {
        flat.push({ id: n.id, stat: n.stat, value: n.value, pre: n.pre ?? null, children: n.children?.length ?? 0, depth })
        if (n.children?.length) walk(n.children, depth + 1, n.id)
      }
    }
    walk(detail.traceTree, 0, null)
    const parentNode = flat.find((n) => n.children > 0 && n.depth >= 1) ?? flat.find((n) => n.children > 0)
    const descendants = (() => {
      const byId = new Map(flat.map((n) => [n.id, n]))
      const out = []
      const stack = [parentNode.id]
      while (stack.length) {
        const cur = byId.get(stack.pop())
        for (const n of flat) if (n.pre === cur.id) { out.push(n.id); stack.push(n.id) }
      }
      return out
    })()
    const deepLeaf = byIdFlat(flat, descendants.find((id) => byIdFlat(flat, id).children === 0) ?? descendants[0])
      ?? flat.filter((n) => n.depth >= 2 && n.children === 0).pop()

    const web = await browserManager.runTask({ label: 'F20 traces', seed: readFileSync(seedAPath, 'utf8'), timeoutMs: 600_000 }, async (page) => {
      const shots = {}
      await bootZh(page, '#main', 'button')
      await sleep(2000)
      // open the traces drawer for the focused optimizer character
      await page.evaluate(P_CLICK_TEXT, ['自定义属性行迹', true])
      await pollUntil('行迹抽屉打开', async () => ({
        ok: await page.evaluate(`() => [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && (e.textContent || '').includes('已激活的属性行迹'))`),
      }), 15_000)
      await sleep(1000)
      // drawer rows in DOM order == DFS pre-order of the tree (all expanded)
      // the traces drawer's own checkboxes (hidden drawer portals shadow the
      // page — scope to the last VISIBLE .mantine-Drawer-body)
      const P_DRAWER_BOXES = `() => {
        const bodies = [...document.querySelectorAll('.mantine-Drawer-body')].filter((e) => e.offsetParent !== null)
        if (!bodies.length) return 0
        return [...bodies[bodies.length - 1].querySelectorAll('input[type="checkbox"]')].filter((e) => e.offsetParent !== null).length
      }`
      const rowCount = await page.evaluate(`() => { const bodies = [...document.querySelectorAll('.mantine-Drawer-body')].filter((e) => e.offsetParent !== null); return bodies.length ? bodies[bodies.length - 1].querySelectorAll('input[type="checkbox"]').length : 0 }`)
      shots.rowCount = rowCount
      // uncheck the chosen parent node: row index = DFS index of parentNode
      await page.evaluate(`(idx) => { const bodies = [...document.querySelectorAll('.mantine-Drawer-body')].filter((e) => e.offsetParent !== null); const boxes = [...bodies[bodies.length - 1].querySelectorAll('input[type="checkbox"]')].filter((e) => e.offsetParent !== null); if (!boxes[idx]) return false; boxes[idx].click(); return true }`, [flat.findIndex((n) => n.id === parentNode.id)])
      await sleep(400)
      await page.evaluate(P_CLICK_TEXT, ['保存更改', true])
      await sleep(1600)
      shots.afterUncheck = await harvest(page)

      // reopen and re-enable a deep leaf
      await page.evaluate(P_CLICK_TEXT, ['自定义属性行迹', true])
      await pollUntil('行迹抽屉2', async () => ({
        ok: (await page.evaluate(P_DRAWER_BOXES)) > 5,
      }), 15_000)
      await sleep(800)
      const deepIdx = flat.findIndex((n) => n.id === deepLeaf.id)
      await page.evaluate(`(idx) => { const bodies = [...document.querySelectorAll('.mantine-Drawer-body')].filter((e) => e.offsetParent !== null); const boxes = [...bodies[bodies.length - 1].querySelectorAll('input[type="checkbox"]')].filter((e) => e.offsetParent !== null); if (!boxes[idx]) return false; boxes[idx].click(); return true }`, [deepIdx])
      await sleep(400)
      await page.evaluate(P_CLICK_TEXT, ['保存更改', true])
      await sleep(1600)
      shots.afterReenable = await harvest(page)

      // tree structure from the drawer: per-row label text in DOM order
      await page.evaluate(P_CLICK_TEXT, ['自定义属性行迹', true])
      await pollUntil('行迹抽屉3', async () => ({
        ok: (await page.evaluate(P_DRAWER_BOXES)) > 5,
      }), 15_000)
      await sleep(800)
      shots.labels = await page.evaluate(`() => {
        const bodies = [...document.querySelectorAll('.mantine-Drawer-body')].filter((e) => e.offsetParent !== null)
        const boxes = [...bodies[bodies.length - 1].querySelectorAll('input[type="checkbox"]')].filter((e) => e.offsetParent !== null)
        return boxes.map((b) => {
          let n = b
          while (n && n.parentElement) {
            n = n.parentElement
            if (n.querySelectorAll('input[type="checkbox"]').length === 1 && (n.innerText || '').trim().length > 0) break
          }
          return (n ? (n.innerText || '') : '').split(String.fromCharCode(10))[0].trim()
        })
      }`)

      // optimizer run with traces deactivated (afterReenable state) → first row stats
      await page.evaluate(P_CLICK_TEXT, ['启动优化器', true])
      await pollUntil('优化结果行出现(traces)', async () => ({
        ok: await page.evaluate(`() => [...document.querySelectorAll('[role="row"]')].filter((r) => r.querySelectorAll('[role="gridcell"], .ag-cell').length > 5).length >= 2`),
      }), 300_000, 500)
      await sleep(1500)
      shots.rowsHead = await page.evaluate(`() => {
        const rows = [...document.querySelectorAll('[role="row"]')].filter((r) => r.querySelectorAll('[role="gridcell"], .ag-cell').length > 5)
        return rows.slice(0, 4).map((row) => {
          const out = {}
          for (const c of row.querySelectorAll('[role="gridcell"], .ag-cell')) {
            const col = c.getAttribute('col-id')
            if (col) out[col] = (c.textContent || '').trim()
          }
          return out
        })
      }`)
      return shots
    })

    // MCP mirrors
    const t1 = await callTool(client, 'set_scoring_override', { characterId: '1212b1', traces: { deactivated: [parentNode.id] } })
    let mcpState = await mcpExport()
    const webOff = web.afterUncheck.scoringMetadataOverrides?.['1212b1']?.traces?.deactivated ?? []
    const expectedOff = [parentNode.id, ...descendants].sort()
    const c1Ok = JSON.stringify([...webOff].sort()) === JSON.stringify(expectedOff)
      && JSON.stringify([...(mcpState.scoringMetadataOverrides?.['1212b1']?.traces?.deactivated ?? [])].sort()) === JSON.stringify(expectedOff)
    record('characters.traces.update', 1, '关闭一个有后代的节点后,deactivated 包含它和全部后代,与网页取消勾选同一节点的结果一致', c1Ok,
      `web ${webOff.length} 项 vs 期望 ${expectedOff.length} 项(${parentNode.id}+${descendants.length} 后代);mcp expanded=${t1.traces?.deactivated?.length} 项`)

    // the web operation is "re-check a deep node" (enables it + ancestors) —
    // the tool's deactivated input is the FINAL off-list, so mirror the same
    // final state: every node except the deep leaf and its ancestor chain
    const ancestorChain = []
    {
      const byId = new Map(flat.map((n) => [n.id, n]))
      let cur = byId.get(deepLeaf.id)
      while (cur) {
        ancestorChain.push(cur.id)
        cur = cur.pre != null ? byId.get(cur.pre) : null
      }
    }
    const enableSet = new Set([deepLeaf.id, ...ancestorChain])
    // mirror the WEB toggle semantics: start from the previous off-list and
    // remove the re-enabled nodes (the tool input is the FINAL off-list)
    const finalOff = [parentNode.id, ...descendants].filter((id) => !enableSet.has(id))
    const t2 = await callTool(client, 'set_scoring_override', { characterId: '1212b1', traces: { deactivated: finalOff } })
    mcpState = await mcpExport()
    const webOff2 = web.afterReenable.scoringMetadataOverrides?.['1212b1']?.traces?.deactivated ?? []
    const mcpOff2 = mcpState.scoringMetadataOverrides?.['1212b1']?.traces?.deactivated ?? []
    const c2Ok = JSON.stringify([...webOff2].sort()) === JSON.stringify([...mcpOff2].sort())
      && !webOff2.includes(deepLeaf.id)
    record('characters.traces.update', 2, '重新启用一个深层节点后,它的全部前置节点一并启用', c2Ok,
      `deep=${deepLeaf.id};web 剩余 ${webOff2.length} 项 mcp ${mcpOff2.length} 项;前置启用=${!webOff2.includes(deepLeaf.id)}`)

    // case3: simulate_build stats vs the web optimizer row0 (same engine, same
    // form, same deactivated traces → deterministic identical rows)
    const mcpRun = await callTool(client, 'optimize', { characterId: '1212b1' }, { timeout: 300_000 })
    const row0Build = mcpRun.rows[0].build?.relics ?? {}
    const relicIds = Object.values(row0Build).map((r) => r?.id).filter(Boolean)
    const sim = await callTool(client, 'simulate_build', { characterId: '1212b1', relicIds }, { timeout: 180_000 })
    const simStats = sim.stats?.basic ?? sim.stats ?? sim.result?.stats ?? {}
    // match the MCP top row against any of the web's first rows (the web grid
    // may prepend the equipped baseline row; percent columns scale ×100 on web)
    const rawKeys = ['ATK', 'DEF', 'HP', 'SPD']
    const pctKeys = ['CR', 'CD', 'EHR', 'RES', 'BE']
    const mcpStats = mcpRun.rows[0].stats ?? {}
    const rowMatches = (webRow, mcpRow) => {
      const stats = mcpRow?.stats ?? {}
      const pairs = []
      for (const k of rawKeys) if (webRow[k] != null && stats[k] != null) pairs.push({ k, web: Number(webRow[k]), mcp: stats[k] })
      for (const k of pctKeys) if (webRow[k] != null && stats[k] != null) pairs.push({ k, web: Number(webRow[k]) / 100, mcp: stats[k] })
      return pairs.length >= 6 && pairs.every((pp) => Math.abs(pp.web - pp.mcp) / Math.max(Math.abs(pp.mcp), 1e-6) <= 0.005) ? pairs : null
    }
    let match = null
    let matchLabel = ''
    for (const webRow of web.rowsHead ?? []) {
      const direct = rowMatches(webRow, mcpRun.rows[0])
      if (direct) { match = direct; matchLabel = 'top'; break }
      const equipped = rowMatches(webRow, mcpRun.equippedRow)
      if (equipped) { match = equipped; matchLabel = 'equippedRow'; break }
      const anyIdx = mcpRun.rows.slice(0, 256).findIndex((r) => rowMatches(webRow, r))
      if (anyIdx >= 0) { match = rowMatches(webRow, mcpRun.rows[anyIdx]); matchLabel = `row[${anyIdx}]`; break }
    }
    const cellsOk = match != null
    const simKeys = Object.keys(simStats)
    record('characters.traces.update', 3, '关闭行迹后 simulate_build 的基础属性与网页优化器里同一角色的数值一致', cellsOk,
      `网页结果行匹配 MCP ${matchLabel || '无'}${match ? `(${match.map((pp) => `${pp.k} ${pp.web}/${pp.mcp.toFixed(4)}`).join(' ')})` : `(网页前 ${(web.rowsHead ?? []).length} 行均不匹配,首行=${JSON.stringify((web.rowsHead ?? [])[0] ?? {}).slice(0, 120)})`};simulate_build stats 键=${simKeys.slice(0, 10).join(',')}`)

    // case4: drawer tree labels vs resource traceTree (DFS order + value formatting)
    const zhStats = {}
    {
      const lines = readFileSync(resolve(mcpDir, '../public/locales/zh_CN/common.yaml'), 'utf8').split(/\r?\n/)
      const inStats = lines.findIndex((l) => /^Stats:/.test(l))
      for (let i = inStats + 1; i < lines.length; i++) {
        if (/^[A-Za-z]/.test(lines[i])) break // next top-level key
        const m = lines[i].match(/^  "?([^":]+)"?:\s*(.+)$/)
        if (m) zhStats[m[1]] = m[2].trim().replace(/^'(.*)'$/, '$1')
      }
    }
    const fmt = (n) => (['HP', 'ATK', 'DEF', 'SPD'].includes(n.stat) ? n.value.toFixed(1) : `${Math.round(n.value * 10000) / 100}%`)
    const expectedLabels = flat.map((n) => `${fmt(n)} - ${zhStats[n.stat] ?? n.stat}`)
    const webLabels = (web.labels ?? []).map((l) => l.split(String.fromCharCode(10))[0].trim())
    const labelMatches = expectedLabels.length === webLabels.length
      && expectedLabels.every((l, i) => webLabels[i] === l)
    record('characters.traces.update', 4, '角色详情资源返回的行迹树节点、前置关系和数值与网页抽屉里显示的树一致',
      labelMatches && web.rowCount === flat.length,
      `节点数 web=${web.rowCount} 资源=${flat.length};标签逐行 ${labelMatches ? '一致' : `首个差异 idx ${expectedLabels.findIndex((l, i) => webLabels[i] !== l)}: 期望「${expectedLabels[expectedLabels.findIndex((l, i) => webLabels[i] !== l)]}」实际「${webLabels[expectedLabels.findIndex((l, i) => webLabels[i] !== l)]}」`}`)
  })

  // ══ F21 panel.switch + F22 grid.density ═════════════════════════════════
  await guard('F21/F22', async () => {
    const pagesRes = await readResource(client, 'site://pages')
    const charPage = pagesRes.pages.find((p) => p.page === 'CHARACTERS')
    const teamsAlias = pagesRes.aliasHashes?.['#teams']
    const web = await browserManager.runTask({ label: 'F21/F22 panels', seed: readFileSync(seedAPath, 'utf8'), timeoutMs: 300_000 }, async (page) => {
      const shots = {}
      await bootZh(page, '#characters', '[data-character-id]')
      await sleep(800)
      shots.charactersPanel = await page.evaluate(`() => ({
        hash: location.hash,
        charVisible: !document.querySelector('#characters-panels-panel-CHARACTERS')?.hidden,
        teamsHidden: document.querySelector('#characters-panels-panel-TEAMS')?.hidden,
        tabCount: document.querySelectorAll('[id^="characters-panels-tab-"]').length,
      })`)
      // switch to the teams panel via the tab button
      await page.evaluate(`() => { const b = document.getElementById('characters-panels-tab-TEAMS'); if (b) b.click(); return !!b }`)
      await sleep(2500)
      shots.teamsPanel = await page.evaluate(`() => ({
        hash: location.hash,
        charHidden: document.querySelector('#characters-panels-panel-CHARACTERS')?.hidden,
        teamsVisible: !document.querySelector('#characters-panels-panel-TEAMS')?.hidden,
        hasAddSlot: [...document.querySelectorAll('[aria-label]')].some((e) => /Add Main DPS|Add character/.test(e.getAttribute('aria-label'))),
      })`)
      // direct hash open of #teams (fresh document)
      await page.goto('#teams', { timeoutMs: 60_000 })
      await sleep(2500)
      shots.teamsHash = await page.evaluate(`() => ({
        hash: location.hash,
        teamsVisible: !document.querySelector('#characters-panels-panel-TEAMS')?.hidden,
      })`)

      // density: back to characters, click 紧凑
      await page.goto('#characters', { timeoutMs: 60_000 })
      await page.waitForSelector('[data-character-id]', { timeoutMs: 30_000 })
      await sleep(800)
      await page.evaluate(P_CLICK_TEXT, ['紧凑', true])
      await sleep(1200)
      let densityState = await harvest(page)
      if (densityState?.savedSession?.global?.characterGridDensity !== 'compact') {
        await page.evaluate(P_CLICK_TEXT, ['紧凑', false])
        await sleep(1500)
        densityState = await harvest(page)
      }
      shots.density = densityState
      // invalid value has no UI surface; try clicking 默认 back for cleanliness
      await page.evaluate(P_CLICK_TEXT, ['默认', true])
      await sleep(600)
      return shots
    })

    record('characters.panel.switch', 1, 'site://pages 把 #characters 与 #teams 列为角色页的两个面板;浏览器运行环境可直接打开其中任一面板',
      charPage?.hash === '#characters' && typeof teamsAlias === 'string' && teamsAlias.length > 0
        && web.charactersPanel.charVisible === true && web.teamsPanel.teamsVisible === true
        && web.teamsPanel.hash === '#teams' && web.teamsHash.teamsVisible === true,
      `site://pages CHARACTERS.hash=${charPage?.hash} alias['#teams']=${teamsAlias};#characters 面板可见=${web.charactersPanel.charVisible};tab 切换→hash=${web.teamsPanel.hash} 面板可见=${web.teamsPanel.teamsVisible};直接打开 #teams 可见=${web.teamsHash.teamsVisible}`)

    await callTool(client, 'load_save', { path: seedAPath })
    await callTool(client, 'update_state', { section: 'session', patch: { characterGridDensity: 'compact' } })
    const mcpState = await mcpExport()
    const webDensity = web.density.savedSession?.global?.characterGridDensity
    const invalid = await toolError(client, 'update_state', { section: 'session', patch: { characterGridDensity: 'bogus' } })
    record('characters.grid.density', 1, '写入 compact 后导出的存档与网页切到紧凑后的存档在该键上一致;非法取值被拒绝',
      webDensity === 'compact' && mcpState.savedSession?.global?.characterGridDensity === 'compact' && invalid != null,
      `web=${webDensity} mcp=${mcpState.savedSession?.global?.characterGridDensity};非法值报错=${invalid != null ? String(invalid).slice(0, 60) : '未拒绝'}`)
  })

  // ══ evidence output ═══════════════════════════════════════════════════════
  const evidence = {
    area: 'characters',
    generatedAt: new Date().toISOString(),
    gitCommit: GIT_COMMIT,
    cases,
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  const byFeature = {}
  for (const c of cases) {
    byFeature[c.feature] ??= { pass: 0, fail: 0 }
    byFeature[c.feature][c.result === 'PASS' ? 'pass' : 'fail']++
  }
  console.log('\n— features —')
  for (const [f, v] of Object.entries(byFeature)) console.log(`  ${f}: ${v.pass} PASS / ${v.fail} FAIL`)
} catch (e) {
  failures++
  console.error('verify-characters: harness error', e)
  console.error(serverStderr.slice(-2000))
  if (cases.length) {
    writeFileSync(evidencePath, `${JSON.stringify({ area: 'characters', generatedAt: new Date().toISOString(), gitCommit: GIT_COMMIT, cases }, null, 2)}\n`)
  }
} finally {
  try { await browserManager.close() } catch { /* already down */ }
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

function firstRowOf(web) {
  return (web?.firstRows ?? [])[0] ?? null
}

function byIdFlat(flat, id) {
  return flat.find((n) => n.id === id)
}

console.log(failures === 0 ? '\nverify-characters: ALL CASES PASSED' : `\nverify-characters: ${failures} CASE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
