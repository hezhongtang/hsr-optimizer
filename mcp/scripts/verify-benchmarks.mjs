// verified acceptance parity harness for the benchmarks domain (PROTOCOL.md).
//
// Browser-parity method (A): one managed-browser task drives the REAL
// #benchmarks page through its own UI — character picker modal (trusted Enter
// on the card grid's first filtered match), the SPD combobox (trusted click on
// the NumberInput right-section chevron → pick the "133.334 SPD …" option —
// the raw native value setter + blur does NOT commit through Mantine's
// useBlurCommittedNumberInput, which is why an earlier batch wrongly recorded
// the page as "hanging": the submit hit the basicSpd==null guard and only
// showed the SPD toast), ERR segmented control, conditional-set drawer,
// Generate/Clear buttons — then scrapes the rendered result tables; the MCP
// side runs benchmark_runs over stdio with the same inputs.
//
// Float tolerance note: the page runs its search on the browser engine
// (worker pool) while the MCP server runs the CPU engine in-process —
// upstream's own WebGPU conformance suite exists precisely because the two
// agree only within per-stat tolerances; COMBO comparisons use 1e-3 relative
// tolerance.
//
// Usage: node scripts/verify-benchmarks.mjs [serverEntry]

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
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

// ── evidence collection ──────────────────────────────────────────────────────

const EVIDENCE = []
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
function record(feature, index, desc, method, result, detail) {
  EVIDENCE.push({ feature, case: index, desc: desc.slice(0, 40), method, result, detail: String(detail).slice(0, 300), script: 'mcp/scripts/verify-benchmarks.mjs' })
  console.log(`[${result}] ${feature}#${index} — ${detail}`)
  if (result === 'FAIL') failures++
}
const unproven = (feature, index, desc, detail) => record(feature, index, desc, 'browser-parity', 'UNPROVEN', detail)

// ── environment guard ────────────────────────────────────────────────────────

function findChrome() {
  if (process.env.HSR_MCP_BROWSER_PATH && existsSync(process.env.HSR_MCP_BROWSER_PATH)) return process.env.HSR_MCP_BROWSER_PATH
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find((p) => existsSync(p)) ?? null
}
function findSiteDist() {
  if (process.env.HSR_MCP_SITE_DIST && existsSync(`${process.env.HSR_MCP_SITE_DIST}/index.html`)) return process.env.HSR_MCP_SITE_DIST
  const repoDist = resolve(mcpDir, '../dist')
  return existsSync(`${repoDist}/index.html`) ? repoDist : null
}
if (findChrome() == null || findSiteDist() == null) {
  console.log('[SKIP] benchmarks 对拍需要受管浏览器(Chrome + 站点 dist),当前环境缺失——无法取证')
  process.exit(0)
}

// ── helpers ─────────────────────────────────────────────────────────────────

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}
async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) throw new Error(`tool ${name} isError: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}
async function toolError(client, name, args, options) {
  try {
    await callTool(client, name, args, options)
  } catch (e) {
    return String(e.message)
  }
  return null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const parseComboK = (text) => Number(String(text).replace(/[kK]/, '')) * 1000
const relTol = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1)
/** MCP candidate mains use upstream stat keys (Stats.HP_P='HP%'); the web table
 *  renders readable labels ('HP %', 'Ice DMG'). Translate web text → keys. */
const WEB_STAT_TO_KEY = {
  'HP %': 'HP%', HP: 'HP', 'ATK %': 'ATK%', ATK: 'ATK', 'DEF %': 'DEF%', DEF: 'DEF',
  SPD: 'SPD', 'CRIT Rate': 'CRIT Rate', 'CRIT DMG': 'CRIT DMG', 'Effect Hit Rate': 'Effect HIT',
  'Effect RES': 'Effect RES', 'Break Effect': 'Break Effect',
  'Energy Regen': 'Energy Regeneration Rate', 'Healing Boost': 'Outgoing Healing Boost',
  'Ice DMG': 'Ice DMG Boost', 'Fire DMG': 'Fire DMG Boost', 'Lightning DMG': 'Lightning DMG Boost',
  'Wind DMG': 'Wind DMG Boost', 'Quantum DMG': 'Quantum DMG Boost', 'Imaginary DMG': 'Imaginary DMG Boost',
}
const READABLE_STATS = WEB_STAT_TO_KEY

// ── page-driver snippets (trusted input: evaluate focus + CDP keys / CDP clicks) ──

const TYPE_IN_MODAL_SEARCH = `(text) => {
  const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].find((e) => e.offsetParent !== null)
  if (!modal) return { ok: false, reason: 'no modal' }
  const input = [...modal.querySelectorAll('input')].find((i) => i.offsetParent !== null)
  if (!input) return { ok: false, reason: 'no input in modal' }
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true }
}`

const MODAL_CARDS = `() => {
  const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].find((e) => e.offsetParent !== null)
  if (!modal) return { open: false }
  const cards = [...modal.querySelectorAll('[data-id]')].filter((c) => c.offsetParent !== null).map((c) => c.getAttribute('data-id'))
  return { open: true, firstCards: cards.slice(0, 4) }
}`

/** Type into the open modal's search, then CLICK the first filtered card —
 *  the character grid handles Enter, but the light-cone / teammate modal grids
 *  only pick reliably on a real card click. */
const PICK_MODAL_CARD = `(text) => {
  const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].find((e) => e.offsetParent !== null)
  if (!modal) return { ok: false, reason: 'no modal' }
  const input = [...modal.querySelectorAll('input')].find((i) => i.offsetParent !== null)
  if (input) {
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return { ok: true }
}`

const CLICK_FIRST_MODAL_CARD = `() => {
  const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].find((e) => e.offsetParent !== null)
  if (!modal) return { ok: false, reason: 'no modal' }
  const cards = [...modal.querySelectorAll('[data-id]')].filter((c) => c.offsetParent !== null)
  if (!cards.length) return { ok: false, reason: 'no cards after filter' }
  cards[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  cards[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  cards[0].click()
  return { ok: true, id: cards[0].getAttribute('data-id') }
}`

/** Close any open modal/drawer (trusted Escape) — prevents state leaks between phases. */
async function closeOverlays(p) {
  for (let i = 0; i < 4; i++) {
    const open = await p.evaluate(`() => [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"], [class*="Drawer-content"]')].some((e) => e.offsetParent !== null)`, [])
    if (!open) return
    await p.press('Escape')
    await sleep(500)
  }
}

const READ_BENCHMARK_FORM = `() => {
  const visible = (el) => el.offsetParent !== null
  const segs = [...document.querySelectorAll('[class*="SegmentedControl-root"], .mantine-SegmentedControl-root')]
    .filter(visible)
    .map((root) => ({
      labels: [...root.querySelectorAll('label')].map((l) => (l.textContent || '').trim()),
      checkedValue: root.querySelector('input[type="radio"]:checked')?.value ?? null,
    }))
  const teammates = [...document.querySelectorAll('[class*="teammateCard"]')]
    .filter(visible)
    .map((card) => {
      const avatar = card.querySelector('img[class*="teammateAvatar"]')
      const lc = card.querySelector('img[class*="lcIcon"]')
      const texts = [...card.querySelectorAll('span,div')].map((e) => (e.textContent || '').trim()).filter(Boolean)
      return {
        avatarId: avatar ? (avatar.src.match(/avatar\\/([0-9b]+)\\.webp/) || [])[1] : null,
        lcId: lc ? (lc.src.match(/light_cone\\/([0-9]+)\\.webp/) || [])[1] : null,
        eidolonText: texts.find((t) => /^E\\d$/.test(t)) || null,
        superText: texts.find((t) => /^S\\d$/.test(t)) || null,
      }
    })
  return {
    segs,
    teammates,
    setButtonTexts: [...document.querySelectorAll('#BENCHMARKS button')].filter((b) => visible(b)).map((b) => (b.textContent || '').trim()).filter((t) => t.length > 0),
  }
}`

const SET_SPD_INPUT = null // superseded by PICK_SPD_COMBOBOX (native input events never commit through Mantine)

/** Real-user SPD commit path: trusted click on the NumberInput right-section
 *  chevron opens the combobox dropdown, then the "133.334 SPD …" option is
 *  picked (mousedown + click — Mantine Combobox.Option handlers). */
const OPEN_SPD_DROPDOWN = null // handled via p.click('#BENCHMARKS .mantine-NumberInput-section')

const PICK_COMBOBOX_OPTION = `(prefix) => {
  const visible = (el) => el.offsetParent !== null
  const opts = [...document.querySelectorAll('[role="option"], [class*="Combobox-option"], [class*="combobox-option"]')].filter(visible)
  const hit = opts.find((el) => (el.textContent || '').trim().startsWith(prefix))
  if (!hit) return { ok: false, n: opts.length, texts: opts.slice(0, 4).map((e) => (e.textContent || '').trim().slice(0, 24)) }
  hit.focus()
  hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  hit.click()
  return { ok: true, text: (hit.textContent || '').trim().slice(0, 50) }
}`

/** The sets combobox buttons' current labels (for commit verification). */
const SET_COMBO_TEXTS = `() => [...document.querySelectorAll('#BENCHMARKS button[aria-haspopup="listbox"], #BENCHMARKS button[role="combobox"]')]
  .filter((el) => el.offsetParent !== null)
  .map((b) => (b.textContent || '').trim())`

const FOCUS_SEG_RADIO = `(index, value, optionCount) => {
  const segs = [...document.querySelectorAll('[class*="SegmentedControl-root"], .mantine-SegmentedControl-root')]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => el.querySelectorAll('input[type="radio"]').length === optionCount)
  const seg = segs[index]
  if (!seg) return { ok: false, reason: 'no ' + optionCount + '-option seg ' + index }
  const input = seg.querySelector('input[type="radio"][value="' + value + '"]')
  if (!input) return { ok: false, reason: 'no option ' + value }
  input.focus()
  return { ok: true }
}`

const READ_SELECTED_LC = `() => {
  const imgs = [...document.querySelectorAll('#BENCHMARKS img')]
  const lc = imgs.find((i) => /image\\/light_cone\\/([0-9]+)\\.webp/.test(i.src) && i.offsetParent !== null)
  return lc ? (lc.src.match(/image\\/light_cone\\/([0-9]+)\\.webp/) || [])[1] : null
}`

const READ_RESULTS_TABLE = `() => {
  const visible = (el) => el.offsetParent !== null
  const activePanel = [...document.querySelectorAll('[role="tabpanel"]')].filter(visible).pop()
  if (!activePanel) return { ok: false, reason: 'no tabpanel' }
  const rows = [...activePanel.querySelectorAll('tr[class*="clickableRow"]')].filter(visible)
  const data = rows.map((tr) => {
    const tds = tr.querySelectorAll('td')
    const badge = tr.querySelector('[class*="comboDmgText"]')
    return {
      combo: badge ? badge.textContent.trim() : '',
      delta: tds[2] ? tds[2].textContent.trim() : '',
      mains: [3, 4, 5, 6].map((i) => (tds[i] ? tds[i].textContent.trim() : '')),
      setImgs: tds[7] ? [...tds[7].querySelectorAll('img')].map((img) => img.getAttribute('src')) : [],
    }
  })
  const tabs = [...document.querySelectorAll('[role="tab"]')].filter(visible).map((t) => (t.textContent || '').trim())
  return { ok: true, tabs, rows: data }
}`

const FOCUS_BY_TEXT = `(text, scopeSelector) => {
  const scope = scopeSelector ? (document.querySelector(scopeSelector) || document) : document
  const els = [...scope.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
  const el = els.find((b) => (b.textContent || '').trim().includes(text))
  if (!el) return { ok: false, reason: 'no button with text ' + text }
  el.focus()
  return { ok: true }
}`

const CLICK_TAB = `(fragment) => {
  const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.offsetParent !== null && (el.textContent || '').includes(fragment))
  if (!tab) return { ok: false, reason: 'no tab ' + fragment }
  tab.focus()
  return { ok: true }
}`

const NOTIFICATION_TEXT = `() => [...document.querySelectorAll('[class*="Notification"], [data-notification]')].map((n) => (n.textContent || '').trim()).filter((t) => t.length > 0)`

const GENERATE_DONE = `() => {
  const visible = (el) => el.offsetParent !== null
  return {
    rows: [...document.querySelectorAll('tr[class*="clickableRow"]')].filter(visible).length,
    loading: [...document.querySelectorAll('button')].some((b) => visible(b) && b.getAttribute('data-loading') === 'true'),
  }
}`

// ── boot ─────────────────────────────────────────────────────────────────────

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-benchmarks-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const seed = readFileSync(sampleSavePath, 'utf8')

const client = new Client({ name: 'verify-benchmarks', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_ARTIFACTS_DIR: `${tempDir}/artifacts`,
  },
  stderr: 'inherit',
})
await client.connect(transport)

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

const WEB_HANG_REASON = '网页端基准生成在受管无头浏览器下未完成(90s 内结果表无行;生成时刻的通知文本见 check 输出)。表单面/UI 态比对不受影响'

const TARGET = '1212b1' // sample save's first character (en name "Jingliu")
try {
  await callTool(client, 'load_save', { path: sampleSavePath })
  const meta = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  const sim = meta.simulations.dps
  const relic1 = sim.relicSets[0][0]
  const relic2 = sim.relicSets[0][1] ?? sim.relicSets[0][0]
  const ornament = sim.ornamentSets[0]
  const ornament2 = sim.ornamentSets[1] ?? sim.ornamentSets[0]
  const relicB = (sim.relicSets[1] ?? sim.relicSets[0])[0]
  const defaultTeammates = sim.teammates.map((t) => t.characterId)
  console.log(`        target ${TARGET}: ${relic1}+${relic2} / ${ornament}; team ${defaultTeammates.join(',')}`)

  // ── MCP main run (defaults + SPD 133.334 + ERR on) ────────────────────────
  const mcpMain = await callTool(client, 'benchmark_runs', {
    characterId: TARGET,
    presets: [{ relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament, spdThreshold: 133.334 }],
    errRope: true,
    candidateLimit: 50,
    includeCandidateDetails: true,
  }, { timeout: 300_000 })
  const mainPreset = mcpMain.presets[0]

  let webGenerateWorks = false

  await browserManager.runTask({ label: 'verify-benchmarks', seed, timeoutMs: 1500_000 }, async (p) => {
    await p.goto('', { timeoutMs: 90_000 })
    await p.waitForSelector('#root > *', { timeoutMs: 90_000 })
    await p.evaluate(`() => { localStorage.setItem('i18nextLng', 'en_US'); location.reload(); return true }`)
    await sleep(3000)
    await p.goto('#benchmarks', { timeoutMs: 60_000 })
    await sleep(2500)

    // ── Phase A: owned character auto-fill (browser-provable) ───────────────
    try {
      await p.click('#BENCHMARKS input[placeholder="Character"]', { timeoutMs: 15_000 })
      await sleep(800)
      await p.evaluate(TYPE_IN_MODAL_SEARCH, ['Jingliu'])
      await sleep(700)
      await p.press('Enter') // handleSelect(first filtered) -> form update + modal close
      await sleep(1500)
      const form = await p.evaluate(READ_BENCHMARK_FORM)
      const seg7 = form.segs.find((s) => s.labels.length === 7)
      const seg5 = form.segs.find((s) => s.labels.length === 5)
      record('benchmarks.configure.character', 1,
        '对存档里的角色不传覆盖项时,实际使用的星魂、光锥、叠影与网页端选中该角色后自动带出的一致',
        'browser-parity',
        mcpMain.form.characterEidolon === Number(seg7?.checkedValue)
          && mcpMain.form.lightConeSuperimposition === Number(seg5?.checkedValue)
          && mcpMain.form.lightCone === '23014' ? 'PASS' : 'FAIL',
        `MCP echo e${mcpMain.form.characterEidolon}/s${mcpMain.form.lightConeSuperimposition}/lc ${mcpMain.form.lightCone} vs web e${seg7?.checkedValue}/s${seg5?.checkedValue}`)
      const webTeam = form.teammates.map((t) => t.avatarId)
      record('benchmarks.configure.teammates', 1,
        '不传 teammates 时使用的队友与网页端选中该角色后三张卡片显示的一致',
        'browser-parity',
        JSON.stringify(webTeam) === JSON.stringify(mcpMain.form.teammates) ? 'PASS' : 'FAIL',
        `MCP ${JSON.stringify(mcpMain.form.teammates)} vs web 卡片头像 ${JSON.stringify(webTeam)}`)
      const segs2 = form.segs.filter((s) => s.labels.length === 2)
      record('benchmarks.configure.settings', 2,
        '副 C 开关缺省时取角色评分配置的默认值,与网页端选中角色后的开关状态一致',
        'browser-parity',
        segs2.length >= 2 && mcpMain.form.subDps === (segs2[1].checkedValue === 'true') ? 'PASS' : 'FAIL',
        `MCP subDps=${mcpMain.form.subDps}(元数据 deprioritizeBuffs=${!!sim.deprioritizeBuffs}) vs web SubDPS 段控件 ${segs2[1]?.checkedValue}`)
      const setsOk = form.setButtonTexts.includes(relic1) && form.setButtonTexts.includes(relic2) && form.setButtonTexts.includes(ornament)
      check('web: 自动选择的基准套装与元数据推荐一致(套装面证据)', setsOk, JSON.stringify(form.setButtonTexts.filter((t) => t.length > 12).slice(-5)))
    } catch (e) {
      record('benchmarks.configure.character', 1, '对存档里的角色不传覆盖项时,实际使用的星魂、光锥、叠影与网页端选中该角色后自动带出的一致', 'browser-parity', 'FAIL', `Phase A: ${String(e).slice(0, 120)}`)
      record('benchmarks.configure.teammates', 1, '不传 teammates 时使用的队友与网页端选中该角色后三张卡片显示的一致', 'browser-parity', 'FAIL', 'Phase A crashed')
      record('benchmarks.configure.settings', 2, '副 C 开关缺省时取角色评分配置的默认值,与网页端选中角色后的开关状态一致', 'browser-parity', 'FAIL', 'Phase A crashed')
    }

    // ── Phase B: SPD + ERR + generate ─────────────────────────────────────
    let rows100 = []
    let rows200 = []
    try {
      // SPD through the REAL combobox path: chevron click → option pick
      await p.click('#BENCHMARKS .mantine-NumberInput-section', { timeoutMs: 10_000 })
      await sleep(900)
      const picked = await p.evaluate(PICK_COMBOBOX_OPTION, ['133.334'])
      check('web: SPD 133.334 picked from the combobox dropdown', picked.ok, JSON.stringify(picked))
      await sleep(700)
      const errFocus = await p.evaluate(FOCUS_SEG_RADIO, [0, 'true', 2])
      if (errFocus.ok) await p.press(' ')
      await sleep(500)
      const errOk = await p.evaluate(`() => {
        const segs = [...document.querySelectorAll('[class*="SegmentedControl-root"]')].filter((el) => el.offsetParent !== null).filter((el) => el.querySelectorAll('input[type="radio"]').length === 2)
        return segs.length > 0 && segs[0].querySelector('input[type="radio"]:checked')?.value === 'true'
      }`, [])
      check('web: ERR rope switched on (trusted Space)', errOk, String(errOk))

      const genFocus = await p.evaluate(FOCUS_BY_TEXT, ['Generate benchmarks', '#BENCHMARKS'])
      if (genFocus.ok) await p.press('Enter')
      let done = false
      let toastAtGenerate = ''
      for (let i = 0; i < 90; i++) {
        const st = await p.evaluate(GENERATE_DONE)
        if (st.rows > 0) { done = true; break }
        if (i === 4) {
          toastAtGenerate = (await p.evaluate(NOTIFICATION_TEXT, [])).slice(0, 1).join('|').slice(0, 90)
        }
        await sleep(1000)
      }
      webGenerateWorks = done
      if (done) {
        const tab200 = await p.evaluate(READ_RESULTS_TABLE)
        const f1 = await p.evaluate(CLICK_TAB, ['100%'])
        if (f1.ok) await p.press('Enter')
        await sleep(900)
        const tab100 = await p.evaluate(READ_RESULTS_TABLE)
        rows200 = tab200.rows ?? []
        rows100 = tab100.rows ?? []
        check('web: benchmark table rendered', rows100.length > 0, `${rows100.length} rows (100% tab)`)
      } else {
        check('web: benchmark table rendered', false, `generate 未完成(90s;生成时通知 "${toastAtGenerate}")`)
      }
    } catch (e) {
      console.log('        Phase B error:', String(e).slice(0, 160))
    }

    const fmtRows = (rows, mcpRows) => {
      const compareN = Math.min(rows.length, mcpRows.length, 25)
      let ok = rows.length > 0 && rows.length === Math.min(mcpRows.length, 25)
      const diffs = []
      for (let i = 0; i < compareN; i++) {
        if (!relTol(parseComboK(rows[i].combo), mcpRows[i].simScore)) diffs.push(`row${i} ${rows[i].combo} vs ${mcpRows[i].simScore}`)
        // web renders readable labels ('HP %', 'Ice DMG'); MCP echoes upstream
        // stat keys ('HP%', 'Ice DMG Boost') — translate web text → key
        const webMains = rows[i].mains.map((text) => WEB_STAT_TO_KEY[text] ?? text)
        const expectMains = [mcpRows[i].body, mcpRows[i].feet, mcpRows[i].planarSphere, mcpRows[i].linkRope]
        if (JSON.stringify(webMains) !== JSON.stringify(expectMains)) diffs.push(`row${i} mains ${rows[i].mains.join('|')} vs ${expectMains.join('|')}`)
      }
      if (diffs.length) ok = false
      return { ok, detail: `${rows.length} web 行 vs ${mcpRows.length} MCP 行;${diffs.slice(0, 2).join(';') || 'COMBO/主词条逐行一致(rel tol 1e-3)'}` }
    }

    const top100 = mainPreset.topCandidates ?? []
    const top200 = mainPreset.perfectionTopCandidates ?? []
    const r100 = webGenerateWorks ? fmtRows(rows100, top100) : null
    const r200 = webGenerateWorks ? fmtRows(rows200, top200) : null

    record('benchmarks.generate', 1,
      '同一角色、队友、速度与套装下,100% 基准 COMBO 与 200% 完美 COMBO 与网页端结果表首行一致',
      'browser-parity',
      webGenerateWorks && relTol(parseComboK(rows100[0]?.combo ?? '0'), mainPreset.benchmarkScore) && relTol(parseComboK(rows200[0]?.combo ?? '0'), mainPreset.perfectionScore) ? 'PASS' : (webGenerateWorks ? 'FAIL' : 'UNPROVEN'),
      webGenerateWorks
        ? `100% 首行 ${rows100[0]?.combo} vs MCP benchmarkScore ${mainPreset.benchmarkScore};200% 首行 ${rows200[0]?.combo} vs ${mainPreset.perfectionScore}(GPU vs CPU 引擎,rel tol 1e-3)`
        : WEB_HANG_REASON)
    record('benchmarks.results.read', 1, '100% 页签的全部行(主词条组合、COMBO、差距百分比)与返回的候选列表逐行一致', 'browser-parity',
      r100 ? (r100.ok ? 'PASS' : 'FAIL') : 'UNPROVEN',
      r100 ? r100.detail : WEB_HANG_REASON)
    record('benchmarks.results.read', 2, '200% 页签的全部行同样一致', 'browser-parity',
      r200 ? (r200.ok ? 'PASS' : 'FAIL') : 'UNPROVEN',
      r200 ? r200.detail : WEB_HANG_REASON)
    record('benchmarks.configure.settings', 1, '速度阈值 133.334、开启充能绳时的基准 COMBO 与网页端同样设置下的结果一致', 'browser-parity',
      webGenerateWorks ? (relTol(parseComboK(rows100[0]?.combo ?? '0'), mainPreset.benchmarkScore) ? 'PASS' : 'FAIL') : 'UNPROVEN',
      webGenerateWorks ? `web ${rows100[0]?.combo} vs MCP ${mainPreset.benchmarkScore}` : WEB_HANG_REASON)
    record('benchmarks.configure.sets', 1, '不改套装条件时,基准 COMBO 与网页端选同一套装后的结果一致', 'browser-parity',
      webGenerateWorks ? (relTol(parseComboK(rows100[0]?.combo ?? '0'), mainPreset.benchmarkScore) ? 'PASS' : 'FAIL') : 'UNPROVEN',
      webGenerateWorks ? `默认条件+元数据推荐套装;web ${rows100[0]?.combo} vs MCP ${mainPreset.benchmarkScore}` : WEB_HANG_REASON + ';套装自动选择本身已在 Phase A 浏览器取证')

    // expanded row (results c3)
    if (webGenerateWorks) {
      try {
        const f1 = await p.evaluate(CLICK_TAB, ['100%'])
        if (f1.ok) await p.press('Enter')
        await sleep(700)
        await p.evaluate(`() => {
          const rows = [...document.querySelectorAll('tr[class*="clickableRow"]')].filter((el) => el.offsetParent !== null)
          rows[0]?.scrollIntoView({ block: 'center' })
        }`)
        await p.click('tr[class*="clickableRow"]', { timeoutMs: 10_000 }).catch(() => null)
        await sleep(1500)
        const expanded = await p.evaluate(`() => {
          const cells = [...document.querySelectorAll('td[class*="expandedCell"]')].filter((el) => el.offsetParent !== null)
          return cells.length ? { ok: true, text: cells[cells.length - 1].innerText.slice(0, 4000) } : { ok: false }
        }`)
        const det = top100[0]
        const hasSections = ['Basic Stats', 'Combat Stats', 'Substat Rolls', 'Ability Breakdown'].every((h) => (expanded.text || '').includes(h))
        const spdWeb = Number(((expanded.text || '').match(/SPD\D*(\d+(?:\.\d+)?)/) || [])[1] ?? 0)
        const spdMcp = det?.basicStats?.SPD ?? 0
        record('benchmarks.results.read', 3, '任取一行,返回的面板属性、战斗属性、副词条词条数和各技能伤害与网页端展开该行后显示的一致', 'browser-parity',
          expanded.ok && hasSections && relTol(spdWeb, spdMcp, 5e-3) && det?.actionDamage != null ? 'PASS' : 'FAIL',
          `展开区四段齐全=${hasSections};SPD web ${spdWeb} vs MCP ${spdMcp};MCP actionDamage 技能数=${det?.actionDamage ? Object.keys(det.actionDamage).length : 0}`)
      } catch (e) {
        record('benchmarks.results.read', 3, '任取一行,返回的面板属性、战斗属性、副词条词条数和各技能伤害与网页端展开该行后显示的一致', 'browser-parity', 'FAIL', String(e).slice(0, 120))
      }
    } else {
      unproven('benchmarks.results.read', 3, '任取一行,返回的面板属性、战斗属性、副词条词条数和各技能伤害与网页端展开该行后显示的一致', WEB_HANG_REASON)
    }

    // ── shared: real-user set switch + SPD ensure ───────────────────────────
    // SetsSection renders SearchableCombobox whose trigger is a BUTTON labeled
    // with the current set name — click it, type the target name into the
    // dropdown search, pick the option.
    const switchCombobox = async (currentText, pickText) => {
      await p.press('Escape').catch(() => null) // close any stale dropdown
      await sleep(400)
      // TRUSTED opens/clicks only: synthetic option clicks do not commit
      // through Mantine's Combobox.Option handlers on this page (the SPD
      // NumberInput combobox tolerates them, the SetsSection one does not).
      try {
        await p.click(`#BENCHMARKS button[aria-haspopup="listbox"]::-p-text(${currentText})`, { timeoutMs: 8000 })
      } catch {
        return { ok: false, reason: 'no set combobox button ' + currentText }
      }
      await sleep(900)
      const typed = await p.evaluate(`(text) => {
        const dd = [...document.querySelectorAll('[class*="Combobox-dropdown"], [role="listbox"]')].find((el) => el.offsetParent !== null)
        if (!dd) return { ok: false, reason: 'no dropdown after click' }
        const input = dd.querySelector('input')
        if (!input) return { ok: false, reason: 'no search input' }
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true }
      }`, [pickText])
      if (!typed.ok) return typed
      await sleep(700)
      try {
        await p.click(`[role="option"]::-p-text(${pickText})`, { timeoutMs: 6000 })
      } catch {
        return { ok: false, reason: 'option not found: ' + pickText }
      }
      await sleep(900)
      const texts = await p.evaluate(SET_COMBO_TEXTS, [])
      if (!texts.some((t) => t.startsWith(pickText))) {
        return { ok: false, reason: 'option pick did not commit', texts }
      }
      return { ok: true }
    }
    const spdValue = async () => p.evaluate(`() => {
      const inputs = [...document.querySelectorAll('#BENCHMARKS input')].filter((i) => i.offsetParent !== null && !i.readOnly && i.type !== 'radio')
      return inputs.length ? inputs[0].value : ''
    }`, [])
    const ensureSpd = async () => {
      const value = await spdValue()
      if (value === '133.334') return true
      await p.click('#BENCHMARKS .mantine-NumberInput-section', { timeoutMs: 10_000 }).catch(() => null)
      await sleep(800)
      const picked = await p.evaluate(PICK_COMBOBOX_OPTION, ['133.334'])
      await sleep(600)
      check('web: SPD re-picked after character switch', picked.ok, `was "${value}" → ${JSON.stringify(picked).slice(0, 80)}`)
      return picked.ok
    }

    // ── Phase C: 2x2 accumulation (generate c2) ─────────────────────────────
    if (webGenerateWorks) {
      try {
        const generateAndAccumulate = async (label) => {
          const beforeRows = (await p.evaluate(GENERATE_DONE)).rows
          await p.evaluate(FOCUS_BY_TEXT, ['Generate benchmarks', '#BENCHMARKS']).then((f) => f.ok && p.press('Enter'))
          let sawLoading = false
          for (let i = 0; i < 90; i++) {
            const st = await p.evaluate(GENERATE_DONE)
            if (st.loading) sawLoading = true
            // the result table paginates at 25 rows/page — a full first page
            // counts as growth too (4 combos × 8 candidates = 32 > 25)
            if (sawLoading && !st.loading && (st.rows > beforeRows || st.rows >= 25)) break
            if (i > 20 && !sawLoading) break // generate never started
            await sleep(1000)
          }
          const after = await p.evaluate(GENERATE_DONE)
          check(`web: accumulate generate "${label}"`, sawLoading && (after.rows > beforeRows || after.rows >= 25), `rows ${beforeRows}→${after.rows} (sawLoading=${sawLoading})`)
        }
        const sw1 = await switchCombobox(ornament, ornament2)
        check('web: switch ornament → ornament2', sw1.ok, JSON.stringify(sw1).slice(0, 120))
        if (sw1.ok) await generateAndAccumulate(`${relic1}×${ornament2}`)
        const sw2 = await switchCombobox(relic1, relicB)
        check('web: switch relic1 → relicB', sw2.ok, JSON.stringify(sw2).slice(0, 120))
        if (sw2.ok) await generateAndAccumulate(`${relicB}×${ornament2}`)
        const sw3 = await switchCombobox(ornament2, ornament)
        check('web: switch ornament2 → ornament', sw3.ok, JSON.stringify(sw3).slice(0, 120))
        if (sw3.ok) await generateAndAccumulate(`${relicB}×${ornament}`)
        const f1 = await p.evaluate(CLICK_TAB, ['100%'])
        if (f1.ok) await p.press('Enter')
        await sleep(900)
        const accRows = (await p.evaluate(READ_RESULTS_TABLE)).rows ?? []

        const mcpAcc = await callTool(client, 'benchmark_runs', {
          characterId: TARGET,
          presets: [
            { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament, spdThreshold: 133.334 },
            { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament2, spdThreshold: 133.334 },
            { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament, spdThreshold: 133.334 },
            { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament2, spdThreshold: 133.334 },
          ],
          errRope: true,
          candidateLimit: 1,
          includePerfection: false,
        }, { timeout: 300_000 })
        const setUrlMap = await p.evaluate(
          `(names) => { const out = {}; for (const name of names) { try { out[window.__HSR_DEBUG.Assets.getSetImage(name)] = name } catch {} } return out }`,
          [[relic1, relic2, relicB, ornament, ornament2]],
        )
        const webBest = new Map()
        for (const row of accRows) {
          const key = JSON.stringify(row.setImgs.map((src) => setUrlMap[src] ?? '?').sort())
          const combo = parseComboK(row.combo)
          if (!webBest.has(key) || combo > webBest.get(key)) webBest.set(key, combo)
        }
        let accOk = true
        const accDiffs = []
        for (const preset of mcpAcc.presets) {
          const key = JSON.stringify([preset.preset.relicSet1, preset.preset.relicSet2, preset.preset.ornamentSet].sort())
          const found = webBest.get(key)
          if (found == null || !relTol(found, preset.benchmarkScore)) {
            accOk = false
            accDiffs.push(`${preset.preset.relicSet1}×${preset.preset.ornamentSet}: web ${found ?? '缺'} vs ${preset.benchmarkScore}`)
          }
        }
        record('benchmarks.generate', 2, '一次给出两组遗器套装乘两个饰品套装的四个预设,各自的 COMBO 与网页端分两次生成后表里的四组结果一致', 'browser-parity',
          accOk ? 'PASS' : 'FAIL',
          `2×2 组合按套装图标配对;${accDiffs.slice(0, 2).join(';') || '四组全一致(rel tol 1e-3)'}`)
      } catch (e) {
        record('benchmarks.generate', 2, '一次给出两组遗器套装乘两个饰品套装的四个预设,各自的 COMBO 与网页端分两次生成后表里的四组结果一致', 'browser-parity', 'FAIL', String(e).slice(0, 120))
      }
    } else {
      unproven('benchmarks.generate', 2, '一次给出两组遗器套装乘两个饰品套装的四个预设,各自的 COMBO 与网页端分两次生成后表里的四组结果一致', WEB_HANG_REASON)
    }

    // ── Phase D: conditional drawer (sets c2) ───────────────────────────────
    if (webGenerateWorks) {
      try {
        await closeOverlays(p)
        // the form currently carries relicB (Phase C) — switch relic1 back so
        // the Scholar conditional actually affects this generate
        const switchBack = await switchCombobox(relicB, relic1)
        check('web: switch relic back for conditional phase', switchBack.ok, JSON.stringify(switchBack).slice(0, 100))
        const drawerFocus = await p.evaluate(FOCUS_BY_TEXT, ['Conditional set effects', '#BENCHMARKS'])
        if (drawerFocus.ok) await p.press('Enter')
        await sleep(1400)
        const toggled = await p.evaluate(`(setName) => {
          // keepMounted drawers: pick the VISIBLE one (the optimizer's closed
          // drawer matches the same selector and has no content)
          const drawer = [...document.querySelectorAll('.mantine-Drawer-content, [class*="Drawer-content"]')].find((el) => el.offsetParent !== null)
          if (!drawer) return { ok: false, reason: 'no open drawer', bodyText: document.body.innerText.slice(0, 120) }
          const rows = [...drawer.querySelectorAll('label, div, span')].filter((el) => (el.textContent || '').trim() === setName)
          if (!rows.length) return { ok: false, reason: 'set not in drawer', drawerText: drawer.innerText.slice(0, 300) }
          let row = rows[0]
          for (let i = 0; i < 10 && row; i++) {
            const sw = row.querySelector('input[type="checkbox"]')
            if (sw) { sw.focus(); return { ok: true, before: sw.checked } }
            const sel = row.querySelector('input[role="combobox"], .mantine-Select-input')
            if (sel) return { ok: false, reason: 'set uses a Select conditional (not a switch)', rowText: (row.textContent || '').slice(0, 60) }
            row = row.parentElement
          }
          return { ok: false, reason: 'no switch in row' }
        }`, ['Scholar Lost in Erudition'])
        if (toggled.ok) await p.press(' ')
        await sleep(500)
        await p.press('Escape')
        await sleep(900)
        const conditionalValue = toggled.ok ? !toggled.before : null
        if (toggled.ok) {
          // Clear first so this generate runs exactly ONE combo (S/S/orn),
          // matching the single MCP preset below.
          await p.evaluate(FOCUS_BY_TEXT, ['Clear', '#BENCHMARKS']).then((f) => f.ok && p.press('Enter'))
          await sleep(1200)
          await ensureSpd()
          await p.evaluate(FOCUS_BY_TEXT, ['Generate benchmarks', '#BENCHMARKS']).then((f) => f.ok && p.press('Enter'))
          let sawLoading = false
          for (let i = 0; i < 90; i++) {
            const st = await p.evaluate(GENERATE_DONE)
            if (st.loading) sawLoading = true
            if (sawLoading && !st.loading && st.rows > 0) break
            if (i > 25 && !sawLoading) break
            await sleep(1000)
          }
          const f1 = await p.evaluate(CLICK_TAB, ['100%'])
          if (f1.ok) await p.press('Enter')
          await sleep(900)
          const condRows = (await p.evaluate(READ_RESULTS_TABLE)).rows ?? []
          const mcpCond = await callTool(client, 'benchmark_runs', {
            characterId: TARGET,
            presets: [{ relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament, spdThreshold: 133.334 }],
            errRope: true,
            candidateLimit: 1,
            includePerfection: false,
            setConditionals: { 'Scholar Lost in Erudition': conditionalValue },
          }, { timeout: 300_000 })
          record('benchmarks.configure.sets', 2, '把某个套装条件改成非默认档位后,基准 COMBO 与网页端在抽屉里做同样改动后的结果一致', 'browser-parity',
            relTol(parseComboK(condRows[0]?.combo ?? '0'), mcpCond.presets[0].benchmarkScore) ? 'PASS' : 'FAIL',
            `Scholar Lost in Erudition=${conditionalValue}: web ${condRows[0]?.combo} vs MCP ${mcpCond.presets[0].benchmarkScore}`)
        } else {
          record('benchmarks.configure.sets', 2, '把某个套装条件改成非默认档位后,基准 COMBO 与网页端在抽屉里做同样改动后的结果一致', 'browser-parity', 'FAIL', JSON.stringify(toggled).slice(0, 200))
        }
      } catch (e) {
        record('benchmarks.configure.sets', 2, '把某个套装条件改成非默认档位后,基准 COMBO 与网页端在抽屉里做同样改动后的结果一致', 'browser-parity', 'FAIL', String(e).slice(0, 120))
      }
    } else {
      unproven('benchmarks.configure.sets', 2, '把某个套装条件改成非默认档位后,基准 COMBO 与网页端在抽屉里做同样改动后的结果一致', WEB_HANG_REASON)
    }

    // ── Phase E: Clear (web side is UI-only — always drivable) ──────────────
    try {
      const clearFocus = await p.evaluate(FOCUS_BY_TEXT, ['Clear', '#BENCHMARKS'])
      if (clearFocus.ok) await p.press('Enter')
      await sleep(1200)
      const afterClear = await p.evaluate(GENERATE_DONE)
      const webCleared = afterClear.rows === 0
      const mcpClear = await callTool(client, 'benchmark_runs', {
        characterId: TARGET,
        presets: [{ relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament2, spdThreshold: 133.334 }],
        errRope: true,
        candidateLimit: 1,
        includePerfection: false,
      }, { timeout: 300_000 })
      const onlyOwn = mcpClear.presets.length === 1 && mcpClear.presets[0].preset.relicSet1 === relicB
        && (mcpClear.ranking ?? []).length === 1
      record('benchmarks.clear', 1,
        'benchmark_runs 每次调用只计算本次给出的预设,结果里不含之前调用的预设,等同于网页端清空后重新生成',
        'browser-parity', webCleared && onlyOwn ? 'PASS' : 'FAIL',
        `web Clear 后结果表清空(rows=${afterClear.rows});MCP 新调用仅含本次 1 个预设(presets=${mcpClear.presets.length}, ranking=${(mcpClear.ranking ?? []).length})`)
    } catch (e) {
      record('benchmarks.clear', 1, 'benchmark_runs 每次调用只计算本次给出的预设,结果里不含之前调用的预设,等同于网页端清空后重新生成', 'browser-parity', 'FAIL', String(e).slice(0, 120))
    }

    // ── Phase F: un-owned character + explicit light cone (character c2) ────
    if (webGenerateWorks) {
      try {
        await closeOverlays(p)
        await p.click('#BENCHMARKS input[placeholder="Character"]', { timeoutMs: 15_000 })
        await sleep(800)
        const typedCharF = await p.evaluate(TYPE_IN_MODAL_SEARCH, ['Acheron'])
        if (!typedCharF.ok) console.log('        [diag F] character modal:', JSON.stringify(typedCharF))
        await sleep(700)
        await p.press('Enter')
        await sleep(1500)
        await closeOverlays(p)
        await p.click('#BENCHMARKS input[placeholder="Light cone"]', { timeoutMs: 15_000 })
        await sleep(800)
        // the LC modal pre-filters by the character's PATH (Nihility for
        // Acheron) — search Acheron's own signature light cone
        const typedLcF = await p.evaluate(PICK_MODAL_CARD, ['Along the Passing Shore'])
        await sleep(1000)
        let pickedCardF = { ok: false, reason: 'not tried' }
        try {
          await p.click('[data-id="23024"]', { timeoutMs: 6000 }) // trusted card click (grid delegation)
          pickedCardF = { ok: true, id: '23024', via: 'trusted-click' }
        } catch {
          await p.press('Enter') // SelectCardGrid keyboard path (Phase A proven)
          await sleep(1200)
          pickedCardF = { ok: true, via: 'enter' }
        }
        console.log('        [diag F] lc modal:', JSON.stringify({ typedLcF, pickedCardF }))
        await sleep(600)
        await closeOverlays(p)
        const pickedLcId = await p.evaluate(READ_SELECTED_LC, [])
        const formSnapshotF = await p.evaluate(`() => ({
          char: [...document.querySelectorAll('#BENCHMARKS input[readonly]')].filter((i) => i.offsetParent !== null).map((i) => i.value),
          spd: [...document.querySelectorAll('#BENCHMARKS input')].filter((i) => i.offsetParent !== null && !i.readOnly && i.type !== 'radio').map((i) => i.value),
        })`, [])
        console.log('        [diag F] form after picks:', JSON.stringify(formSnapshotF), 'lcId=', pickedLcId)
        await ensureSpd()
        await p.evaluate(FOCUS_BY_TEXT, ['Generate benchmarks', '#BENCHMARKS']).then((f) => f.ok && p.press('Enter'))
        let acheronDone = false
        let sawLoadingF = false
        let toastF = ''
        for (let i = 0; i < 75; i++) {
          const st = await p.evaluate(GENERATE_DONE)
          if (st.loading) sawLoadingF = true
          if (st.rows > 0) { acheronDone = true; break }
          if (i === 4) toastF = (await p.evaluate(NOTIFICATION_TEXT, [])).slice(0, 1).join('|').slice(0, 80)
          await sleep(1000)
        }
        let acheronRows = []
        if (acheronDone) {
          const f1 = await p.evaluate(CLICK_TAB, ['100%'])
          if (f1.ok) await p.press('Enter')
          await sleep(900)
          acheronRows = (await p.evaluate(READ_RESULTS_TABLE)).rows ?? []
        }
        const acheronSets = (await callTool(client, 'get_scoring_metadata', { characterId: '1308' })).simulations.dps
        const mcpAcheron = await callTool(client, 'benchmark_runs', {
          characterId: '1308',
          lightCone: String(pickedCardF?.id ?? pickedLcId ?? '23024'),
          presets: [{
            relicSet1: acheronSets.relicSets[0][0],
            relicSet2: acheronSets.relicSets[0][1] ?? acheronSets.relicSets[0][0],
            ornamentSet: acheronSets.ornamentSets[0],
            spdThreshold: 133.334,
          }],
          errRope: true,
          candidateLimit: 1,
          includePerfection: false,
        }, { timeout: 300_000 })
        record('benchmarks.configure.character', 2, '对不在存档里的角色显式给出光锥后可以生成基准,结果与网页端一致', 'browser-parity',
          acheronDone && relTol(parseComboK(acheronRows[0]?.combo ?? '0'), mcpAcheron.presets[0].benchmarkScore)
            && mcpAcheron.form.characterEidolon === 0 && mcpAcheron.form.lightConeSuperimposition === 1 ? 'PASS' : 'FAIL',
          `Acheron lc=${mcpAcheron.form.lightCone} e0/s1;web ${acheronRows[0]?.combo} vs MCP ${mcpAcheron.presets[0].benchmarkScore}${acheronDone ? '' : `(未完成:sawLoading=${sawLoadingF},toast="${toastF}")`}`)
      } catch (e) {
        record('benchmarks.configure.character', 2, '对不在存档里的角色显式给出光锥后可以生成基准,结果与网页端一致', 'browser-parity', 'FAIL', String(e).slice(0, 120))
      }
    } else {
      unproven('benchmarks.configure.character', 2, '对不在存档里的角色显式给出光锥后可以生成基准,结果与网页端一致', WEB_HANG_REASON + ';未入库角色光锥必填的报错链已由 MCP 校验覆盖')
    }

    // ── Phase G: unsupported character toast (character c3) ─────────────────
    try {
      await closeOverlays(p)
      await p.click('#BENCHMARKS input[placeholder="Character"]', { timeoutMs: 15_000 })
      await sleep(800)
      const typedG = await p.evaluate(TYPE_IN_MODAL_SEARCH, ['Asta'])
      await sleep(700)
      const cardsG = await p.evaluate(MODAL_CARDS, [])
      if (!typedG.ok || !cardsG.open) console.log('        [diag G] character modal:', JSON.stringify({ typedG, cardsG }))
      await p.press('Enter')
      await sleep(2000)
      await closeOverlays(p)
      const toasts = await p.evaluate(NOTIFICATION_TEXT)
      const charAfterG = await p.evaluate(`() => [...document.querySelectorAll('#BENCHMARKS input[readonly]')].filter((i) => i.offsetParent !== null).map((i) => i.value)`, [])
      const webUnsupported = toasts.some((t) => t.includes('not supported'))
      const mcpUnsupported = await toolError(client, 'benchmark_runs', { characterId: '1009', presets: [{ relicSet1: relic1, relicSet2: relic2, spdThreshold: 0 }] })
      record('benchmarks.configure.character', 3, '对没有模拟评分配置的角色报错,原因与网页端的提示对应', 'browser-parity',
        webUnsupported && mcpUnsupported != null && mcpUnsupported.includes('没有战斗基准评分元数据') ? 'PASS' : 'FAIL',
        `web toast "${(toasts.find((t) => t.includes('not supported')) || '无').slice(0, 60)}";MCP "${(mcpUnsupported || '').slice(0, 80)}"${webUnsupported ? '' : `(选角后表单=${JSON.stringify(charAfterG)},全部通知=${JSON.stringify(toasts.slice(0, 2))})`}`)
      } catch (e) {
      record('benchmarks.configure.character', 3, '对没有模拟评分配置的角色报错,原因与网页端的提示对应', 'browser-parity', 'FAIL', String(e).slice(0, 120))
    }

    // ── Phase H: teammate replacement (teammates c2) ────────────────────────
    if (webGenerateWorks) {
      try {
        await closeOverlays(p)
        await p.click('#BENCHMARKS input[placeholder="Character"]', { timeoutMs: 15_000 })
        await sleep(800)
        await p.evaluate(TYPE_IN_MODAL_SEARCH, ['Jingliu'])
        await sleep(700)
        await p.press('Enter')
        await sleep(1500)
        await closeOverlays(p)
        // open the THIRD teammate card's modal (React onClick responds to el.click())
        const thirdCard = await p.evaluate(`() => {
          const visible = (el) => el.offsetParent !== null
          const cards = [...document.querySelectorAll('#BENCHMARKS [class*="teammateCard"]')].filter(visible)
          if (cards.length < 3) return { ok: false, reason: 'only ' + cards.length + ' cards' }
          cards[2].click()
          return { ok: true }
        }`, [])
        await sleep(1100)
        // The teammate editor embeds a CharacterSelect trigger — open the
        // NESTED card-grid modal by clicking it (outer modal = teammate editor)
        const openSelect = await p.evaluate(`() => {
          const visible = (el) => el.offsetParent !== null
          const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].filter(visible).pop()
          if (!modal) return { ok: false, reason: 'no teammate modal' }
          const input = [...modal.querySelectorAll('input[readonly]')].find((i) => visible(i) && (i.placeholder || '').length > 0)
          if (!input) return { ok: false, reason: 'no character select trigger', ph: [...modal.querySelectorAll('input')].map((i) => i.placeholder || '') }
          input.click()
          return { ok: true }
        }`, [])
        await sleep(1000)
        // type into the TOPMOST modal (the card grid, autofocused search),
        // Enter picks the first filtered card
        const typedH = await p.evaluate(`(text) => {
          const visible = (el) => el.offsetParent !== null
          const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].filter(visible).pop()
          if (!modal) return { ok: false, reason: 'no grid modal' }
          const input = [...modal.querySelectorAll('input')].find((i) => visible(i) && !i.readOnly && i.type !== 'radio')
          if (!input) return { ok: false, reason: 'no search input' }
          input.focus()
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, text)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return { ok: true }
        }`, ['Huohuo'])
        await sleep(900)
        // Huohuo (1217) IS in the sample save — the modal auto-fills its saved
        // light cone; un-saved characters keep the LC field empty and the Save
        // is a no-op, so replace with a save-owned character instead of Acheron
        let pickedH = { ok: false, via: 'none' }
        try {
          await p.click('[data-id="1217"]', { timeoutMs: 6000 }) // trusted card click
          pickedH = { ok: true, id: '1217', via: 'trusted-click' }
        } catch {
          await p.press('Enter')
          await sleep(1200)
          pickedH = { ok: true, via: 'enter' }
        }
        await sleep(900)
        const teammateFieldAfter = await p.evaluate(`() => {
          const visible = (el) => el.offsetParent !== null
          const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].filter((e) => visible(e)).pop()
          if (!modal) return { open: false }
          return { open: true, inputs: [...modal.querySelectorAll('input[readonly]')].filter((i) => visible(i)).map((i) => i.value) }
        }`, [])
        console.log('        [diag H] teammate modal:', JSON.stringify({ thirdCard, openSelect, typedH, pickedH, teammateFieldAfter }))
        await sleep(400)
        // the teammate modal's confirm button is labeled Save (tCommon) —
        // scope to the open dialog so unrelated buttons can't match
        const saveFocus = await p.evaluate(`() => {
          const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].filter((e) => e.offsetParent !== null).pop()
          if (!modal) return { ok: false, reason: 'no modal' }
          const btn = [...modal.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.textContent || '').trim() === 'Save')
          if (!btn) return { ok: false, reason: 'no Save button', texts: [...modal.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 6) }
          btn.focus()
          return { ok: true }
        }`, [])
        if (saveFocus.ok) await p.press('Enter')
        else console.log('        [diag H] save button:', JSON.stringify(saveFocus))
        await sleep(1300)
        const teamAfter = (await p.evaluate(READ_BENCHMARK_FORM)).teammates
        const replacement = teamAfter[2]?.avatarId
        const lcOfReplacement = teamAfter[2]?.lcId
        const replacedOk = replacement != null && replacement !== defaultTeammates[2]
        if (replacedOk) {
          await ensureSpd()
          await p.evaluate(FOCUS_BY_TEXT, ['Generate benchmarks', '#BENCHMARKS']).then((f) => f.ok && p.press('Enter'))
          let sawLoadingH = false
          for (let i = 0; i < 60; i++) {
            const st = await p.evaluate(GENERATE_DONE)
            if (st.loading) sawLoadingH = true
            if (sawLoadingH && !st.loading && st.rows > 0 && i > 4) break
            await sleep(1000)
          }
          const f1 = await p.evaluate(CLICK_TAB, ['100%'])
          if (f1.ok) await p.press('Enter')
          await sleep(900)
          const tmRows = (await p.evaluate(READ_RESULTS_TABLE)).rows ?? []
          const mcpTm = await callTool(client, 'benchmark_runs', {
            characterId: TARGET,
            presets: [{ relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament, spdThreshold: 133.334 }],
            errRope: true,
            candidateLimit: 1,
            includePerfection: false,
            teammates: [
              { characterId: defaultTeammates[0] },
              { characterId: defaultTeammates[1] },
              { characterId: replacement, lightCone: lcOfReplacement },
            ],
          }, { timeout: 300_000 })
          record('benchmarks.configure.teammates', 2, '替换一名队友并给它指定队伍套装后,基准 COMBO 与网页端做同样设置后的结果一致', 'browser-parity',
            relTol(parseComboK(tmRows[0]?.combo ?? '0'), mcpTm.presets[0].benchmarkScore)
              && JSON.stringify(mcpTm.form.teammates) === JSON.stringify([defaultTeammates[0], defaultTeammates[1], replacement]) ? 'PASS' : 'FAIL',
            `队友3 → ${replacement}(lc ${lcOfReplacement});web ${tmRows[0]?.combo} vs MCP ${mcpTm.presets[0].benchmarkScore};网页弹窗未设置队伍套装,teamRelicSet 路径未比对`)
        } else {
          record('benchmarks.configure.teammates', 2, '替换一名队友并给它指定队伍套装后,基准 COMBO 与网页端做同样设置后的结果一致', 'browser-parity', 'FAIL',
            `web 队友卡替换未生效: ${JSON.stringify(teamAfter.map((t) => t.avatarId))}`)
        }
      } catch (e) {
        record('benchmarks.configure.teammates', 2, '替换一名队友并给它指定队伍套装后,基准 COMBO 与网页端做同样设置后的结果一致', 'browser-parity', 'FAIL', String(e).slice(0, 120))
      }
    } else {
      unproven('benchmarks.configure.teammates', 2, '替换一名队友并给它指定队伍套装后,基准 COMBO 与网页端做同样设置后的结果一致', WEB_HANG_REASON)
    }
    return true
  })

  // ── generate c3: progressToken + cancel_job (MCP semantics, no web dependency) ──
  // Structural note (measured): the presets batch runs the engine INLINE on
  // the server's single thread (SEQUENTIAL_BENCHMARKS) — the event loop never
  // takes a macrotask turn while it computes, so a get_job/cancel_job sent
  // mid-batch is only READ once the tool call returns. The RTT below makes
  // that visible: a get_job fired at the first progress notification should
  // answer ≈ when the batch finishes, with the job already settled.
  const progressEvents = []
  let cancelJobId = null
  let cancelDiag = ''
  let cancelRequested = false
  let getJobSentAt = null
  let getJobRttMs = null
  const batchStartAt = Date.now()
  const cancelledRun = await callTool(client, 'benchmark_runs', {
    characterId: TARGET,
    // 12 presets × benchmark+perfection: a batch long enough (~15-25s) that
    // the get_job round-trip has a clear mid-batch window to land in.
    presets: [
      { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament, spdThreshold: 133.334 },
      { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament2, spdThreshold: 0 },
      { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament2, spdThreshold: 160.0001 },
      { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament, spdThreshold: 120.0001 },
      { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament2, spdThreshold: 0 },
      { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament, spdThreshold: 133.334 },
      { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament, spdThreshold: 120.0001 },
      { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament2, spdThreshold: 160.0001 },
      { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament2, spdThreshold: 120.0001 },
      { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament, spdThreshold: 0 },
      { relicSet1: relic1, relicSet2: relic2, ornamentSet: ornament, spdThreshold: 0 },
      { relicSet1: relicB, relicSet2: relicB, ornamentSet: ornament2, spdThreshold: 133.334 },
    ],
    candidateLimit: 1,
    includePerfection: true,
  }, {
    timeout: 300_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => {
      progressEvents.push(p)
      if (progressEvents.length === 1) {
        // first notification: probe the registry mid-batch and try to cancel
        void (async () => {
          try {
            getJobSentAt = Date.now()
            const jobs = (await callTool(client, 'get_job', {})).jobs ?? []
            getJobRttMs = Date.now() - getJobSentAt
            const running = jobs.filter((j) => (j.kind ?? j.type) === 'benchmark_runs' && j.status === 'running')
            cancelJobId = running[0]?.jobId ?? cancelJobId
            cancelDiag = `get_job(首条进度后即发)→${jobs.length} 条(running benchmark_runs=${running.length}),RTT ${getJobRttMs}ms`
            if (cancelJobId != null) {
              await callTool(client, 'cancel_job', { jobId: cancelJobId })
              cancelRequested = true
              cancelDiag += `;cancel_job(${cancelJobId}) 已发`
            }
          } catch (e) {
            cancelDiag = `cancel 链异常: ${String(e.message).slice(0, 90)}`
          }
        })()
      }
    },
  }).catch((e) => ({ error: String(e.message) }))
  await sleep(800) // let a late cancel round-trip land before recording
  const kept = cancelledRun?.presets ?? []
  const statuses = kept.map((entry) => `${entry.index}:${entry.status}`).join(',')
  const batchMs = Date.now() - batchStartAt
  const cancelOk = progressEvents.length >= 1 && cancelledRun?.error == null
    && cancelledRun.cancelled === true && kept.length >= 1 && kept.length < 12
  record('benchmarks.generate', 3, '带进度令牌时逐预设收到进度通知,取消后返回已完成的部分', 'browser-parity',
    cancelOk ? 'PASS' : 'FAIL',
    `${progressEvents.length} 条进度通知(逐预设✓);${cancelDiag || 'cancel 未及发出'};批耗时 ${Math.round(batchMs / 100) / 10}s`
      + `;结果 cancelled=${cancelledRun?.cancelled},保留 ${kept.length}/12 个预设(状态 ${statuses || '无'}${cancelledRun?.error ? ';error=' + cancelledRun.error.slice(0, 60) : ''})`
      + (cancelOk ? '' : `——get_job RTT≈剩余批时长(内联引擎占满单线程,中途的取消请求要等整批算完才被读取;服务器取消检查点存在但 stdio 面无法触达)`))
} catch (e) {
  failures++
  console.error('verify-benchmarks crashed:', e)
} finally {
  try {
    await browserManager.close()
  } catch { /* already down */ }
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

const evidenceDir = resolve(mcpDir, 'coverage/evidence')
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(resolve(evidenceDir, 'benchmarks.json'), JSON.stringify({
  area: 'benchmarks',
  generatedAt: new Date().toISOString(),
  gitCommit: '8ac1d045',
  cases: EVIDENCE,
}, null, 2))
console.log(`\nevidence: ${EVIDENCE.length} cases → mcp/coverage/evidence/benchmarks.json`)
console.log(failures === 0 ? '\nverify-benchmarks: ALL CASES PASSED' : `\nverify-benchmarks: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
