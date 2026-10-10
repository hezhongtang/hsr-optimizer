// verified-acceptance parity harness for the WARP domain (protocol 2026-10-08,
// coverage/features/warp.json).
//
// Every scope=baseline acceptance case gets a same-version browser/MCP
// cross-check against the repo-root dist/ build (managed browser, seeded
// localStorage['state'] = temp save copies):
//
//   warp.resources.set  — seeded warpRequest: MCP warp_plan(fromSaved) echo vs
//                         the page's rendered input values; warp_plan(save=true)
//                         → export_save → web loads the file → harvest equality;
//                         unknown income id error (MCP) vs the web's option
//                         table + the load-time normalize-drop rule both sides.
//   warp.plan.simple    — all 8 strategies: MCP milestones vs the page's
//                         simple-mode table rows (label / chance% / ceil warps);
//                         plus a fromSaved replay of a simple-mode save.
//   warp.plan.targets   — the page's OWN UI builds the target list (Add
//                         character and signature / Add character buttons,
//                         card-picker modal, E/S segmented controls, drag
//                         reorder); the harvested warpRequest.targets feed the
//                         MCP call and both milestone tables are compared; the
//                         chaining / owned-eidolon cases compare the harvested
//                         target levels against warp_plan(normalizeTargets=true).
//   warp.results.read   — budget summary (jade/passes/income/starlight=warps)
//                         parsed off the page vs MCP request; per-milestone rows;
//                         pity change moves both sides identically.
//   warp.scanner.sync   — ONE fake Reliquary Archiver ws server on 127.0.0.1;
//                         the MCP scanner tool AND the web page (seeded
//                         scannerSettings.websocketUrl, auto-connect at boot)
//                         both connect and receive the SAME scripted event
//                         frames (UpdateMaterials / UpdateGachaFunds /
//                         GachaResult×2); the resulting warpRequest fields are
//                         compared, then the ingestWarpResources=off variant
//                         proves the same events change nothing on either side.
//
// Everything persistent lives in a mkdtempSync temp dir; the repo sample save
// is never a write target. Browser closed + temp dir removed at exit.
//
// Usage: node scripts/verify-warp.mjs [serverEntry]

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
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocket, WebSocketServer } from 'ws'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const evidencePath = resolve(mcpDir, 'coverage/evidence/warp.json')

const GIT_COMMIT = '8ac1d045'
const GENERATED_AT = new Date().toISOString()

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
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
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
  console.log('[SKIP] warp 对拍需要受管浏览器环境(Chrome + 站点 dist/)')
  process.exit(0)
}

const cases = []
function record(feature, caseNo, desc, method, result, detail) {
  cases.push({
    feature,
    case: caseNo,
    desc: desc.slice(0, 60),
    method,
    result,
    detail: detail.replace(/\s+/g, ' ').slice(0, 240),
    script: 'mcp/scripts/verify-warp.mjs',
  })
  console.log(`[${result}] ${feature} #${caseNo} (${method}) — ${detail.replace(/\s+/g, ' ').slice(0, 220)}`)
}

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-warp-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const closeEnough = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))

// fake Reliquary Archiver (Phase D) — declared here so the finally block can tear it down
let archiverHttp = null
let archiverWss = null
const archiverClients = new Set()

// ── MCP client ───────────────────────────────────────────────────────────────
const client = new Client({ name: 'verify-warp', version: '0.0.0' })
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

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}
async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`tool ${name} isError: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}
async function toolErrorText(name, args) {
  try {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) return result.content?.[0]?.text
    return null
  } catch (e) {
    return String(e?.message ?? e)
  }
}

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

// ═══ page helpers ═════════════════════════════════════════════════════════════

function seedSave({ warpRequest, scannerSettings }) {
  const data = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  if (warpRequest) data.warpRequest = warpRequest
  if (scannerSettings) data.scannerSettings = scannerSettings
  return JSON.stringify(data)
}
function seedFile(name, seedJson) {
  const p = `${tempDir}/${name}.json`
  writeFileSync(p, seedJson)
  return p
}

const HARVEST = `() => {
  window.__HSR_DEBUG.SaveState.save()
  return JSON.parse(localStorage.getItem('state') || '{}')
}`

/** Visible text inputs of the settings panel, hidden-host selects excluded:
 *  [0]=jades [1]=passes [2]=starlight label [3]=income [4]=pityCharacter [5]=pityLightCone ([6]=strategy label in simple mode) */
const READ_WARP_FIELDS = `() => [...document.querySelectorAll('#WARP input')]
  .filter((el) => {
    if (el.type !== 'text' || el.offsetParent === null) return false
    let node = el.parentElement
    while (node && node !== document.body) {
      if (node.style && node.style.width === '0px') return false
      node = node.parentElement
    }
    return true
  })
  .map((el) => el.value)`

const SET_WARP_INDEX = `(index, toValue) => {
  const fields = [...document.querySelectorAll('#WARP input')]
    .filter((el) => {
      if (el.type !== 'text' || el.offsetParent === null) return false
      let node = el.parentElement
      while (node && node !== document.body) {
        if (node.style && node.style.width === '0px') return false
        node = node.parentElement
      }
      return true
    })
  const el = fields[index]
  if (!el) return 'missing:' + index + '/' + fields.length
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, String(toValue))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('blur', { bubbles: true }))
  return el.value
}`

const SET_WARP_INPUT = `(fromValue, toValue) => {
  const el = [...document.querySelectorAll('#WARP input')].filter((x) => x.offsetParent !== null && x.value === fromValue)[0]
  if (!el) return null
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, String(toValue))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('blur', { bubbles: true }))
  return el.value
}`

const CLICK_WARP_SELECT = `(currentValue) => {
  const el = [...document.querySelectorAll('#WARP input')].filter((x) => x.offsetParent !== null && x.value === currentValue)[0]
  if (!el) return 'not-found:' + currentValue
  el.click()
  return 'clicked'
}`
const CLICK_OPEN_OPTION = `(optionText) => {
  const opts = [...document.querySelectorAll('[role=option]')].filter((o) => o.offsetParent !== null)
  const hit = opts.find((o) => o.textContent.trim() === optionText)
  if (!hit) return 'option-not-found:' + optionText
  hit.click()
  return 'picked'
}`

const CLICK_RADIO = `(value) => {
  const el = [...document.querySelectorAll('#WARP input[type=radio]')].find((x) => x.value === value)
  if (!el) return false
  el.click()
  return true
}`

/** Summary divider label: "8000 + 20 + 85 + 280 = 204" */
const READ_SUMMARY = `() => {
  const labels = [...document.querySelectorAll('#WARP .mantine-Divider-label')]
  return labels.map((l) => l.innerText.replace(/\\n/g, ' ').trim())
}`

/** All milestone rows on the page: [label, chance%, ceilWarps]; grouped per table. */
const READ_WARP_TABLES = `() => [...document.querySelectorAll('#WARP table')].map((table) => {
  const rows = [...table.querySelectorAll('tbody tr')]
    .map((tr) => [...tr.children].map((td) => td.innerText.trim()))
    .filter((cells) => cells.length === 3 && /^\\d+(\\.\\d+)?%$/.test(cells[1] ?? '') && /^\\d+$/.test((cells[2] ?? '').replace(/[^\\d]/g, '')))
    .map((cells) => ({ label: cells[0].replace(/\\s+/g, ''), chance: parseFloat(cells[1]), warps: parseInt(cells[2].replace(/[^\\d]/g, ''), 10) }))
  return rows
}).filter((rows) => rows.length > 0)`

/** Click a card in the (visible) character-picker modal by data-id (mousedown selects). */
const PICK_CARD = `(characterId) => {
  const dialogs = [...document.querySelectorAll('[role=dialog]')].filter((d) => d.offsetParent !== null)
  if (!dialogs.length) return 'no-visible-dialog'
  const card = dialogs[dialogs.length - 1].querySelector('[data-id="' + characterId + '"]')
  if (!card) return 'card-not-found:' + characterId
  card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return 'picked'
}`

/** Click a button anywhere on #warp by its visible text. */
const CLICK_WARP_BUTTON = `(text) => {
  const hit = [...document.querySelectorAll('#WARP button')].find((b) => b.offsetParent !== null && (b.textContent || '').trim() === text)
  if (!hit) return false
  hit.click()
  return true
}`

/** Click a segmented-control option (label) inside the nth target row's From/To control. */
const CLICK_TARGET_SEGMENT = `(targetIndex, which, optionText) => {
  const tables = [...document.querySelectorAll('#WARP table')]
  const table = tables[targetIndex]
  if (!table) return 'table-not-found:' + targetIndex
  const segs = [...table.querySelectorAll('.mantine-SegmentedControl-root')]
  // [0] = From, [1] = To
  const seg = segs[which === 'from' ? 0 : 1]
  if (!seg) return 'seg-not-found'
  const label = [...seg.querySelectorAll('label')].find((l) => l.textContent.trim() === optionText)
  if (!label) return 'label-not-found:' + optionText + '/' + [...seg.querySelectorAll('label')].map((l) => l.textContent.trim()).join('|')
  label.click()
  return 'clicked'
}`

/** dnd-kit's PointerSensor only attaches its document move/up listeners after the
 *  pointerdown task completes, so each phase of the drag runs as its own page task. */
const DRAG_PHASE = `(phase, fromHandleIdx, toRowIdx) => {
  const handles = [...document.querySelectorAll('#WARP [class*=dragHandle]')].filter((h) => h.offsetParent !== null)
  const rows = [...document.querySelectorAll('#WARP table')].filter((t) => t.querySelector('[class*=dragHandle]'))
  if (!handles[fromHandleIdx] || !rows[toRowIdx]) return 'missing:' + handles.length + '/' + rows.length
  const a = handles[fromHandleIdx].getBoundingClientRect()
  const b = rows[toRowIdx].getBoundingClientRect()
  const fire = (type, x, y, target) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }))
  if (phase === 'down') fire('pointerdown', a.x + 5, a.y + 5, handles[fromHandleIdx])
  else if (phase === 'activate') fire('pointermove', a.x + 25, a.y + 8, handles[fromHandleIdx])
  else if (phase === 'move') fire('pointermove', b.x + 60, b.y + b.height / 2, document.body)
  else if (phase === 'up') fire('pointerup', b.x + 60, b.y + b.height / 2, document.body)
  return phase
}`
async function dragTargetRow(page, fromHandleIdx, toRowIdx) {
  const phases = ['down', 'activate', 'move', 'up']
  const results = []
  for (const phase of phases) {
    results.push(await page.evaluate(DRAG_PHASE, [phase, fromHandleIdx, toRowIdx]))
    await sleep(150)
  }
  return results.join('>')
}

async function bootPage(page, hash, seed, settleMs = 2500) {
  await page.goto(hash, { timeoutMs: 90_000 })
  await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
  await sleep(settleMs)
}

// milestone comparison: web rows [label, chance%, ceil] vs MCP milestones [{label, warps, wins}]
function compareMilestones(webRows, mcpMilestones) {
  if (webRows.length !== mcpMilestones.length) {
    return `row count web=${webRows.length} mcp=${mcpMilestones.length}`
  }
  for (let i = 0; i < webRows.length; i++) {
    const w = webRows[i]
    const m = mcpMilestones[i]
    if (w.label.replace(/\s+/g, '') !== m.label) return `row${i} label ${w.label} vs ${m.label}`
    if (!closeEnough(w.chance, Math.round(m.wins * 1000) / 10, 0.051)) {
      return `row${i}(${m.label}) chance web=${w.chance} vs mcp=${(m.wins * 100).toFixed(1)}`
    }
    if (w.warps !== Math.ceil(m.warps)) return `row${i}(${m.label}) warps web=${w.warps} vs mcp=ceil(${m.warps.toFixed(2)})`
  }
  return null
}

try {
  // ═══ fixture saves ════════════════════════════════════════════════════════
  const R1 = {
    passes: 20, jades: 8000, income: ['4.6_p1_1'], targets: [], plannerMode: 'multi',
    strategy: 3, starlight: 'REFUND_HIGH', pityCharacter: 10, guaranteedCharacter: true,
    pityLightCone: 5, guaranteedLightCone: false,
  }
  const simpleSeed = {
    passes: 0, jades: 64000, income: [], targets: [], plannerMode: 'simple',
    strategy: 0, starlight: 'REFUND_NONE', pityCharacter: 0, guaranteedCharacter: false,
    pityLightCone: 0, guaranteedLightCone: false,
  }
  const multiSeed = {
    passes: 0, jades: 80000, income: [], targets: [], plannerMode: 'multi',
    strategy: 0, starlight: 'REFUND_NONE', pityCharacter: 0, guaranteedCharacter: false,
    pityLightCone: 0, guaranteedLightCone: false,
  }
  const scannerBase = {
    passes: 7, jades: 1000, income: [], targets: [], plannerMode: 'simple',
    strategy: 0, starlight: 'REFUND_NONE', pityCharacter: 5, guaranteedCharacter: false,
    pityLightCone: 0, guaranteedLightCone: false,
  }

  // ═══ Phase A: resources.set — seeded request vs the page inputs ══════════
  const r1Path = seedFile('r1', seedSave({ warpRequest: R1 }))
  await callTool('load_save', { path: r1Path })
  const fromSavedEcho = await callTool('warp_plan', { fromSaved: true })

  // resources.set case 3 (MCP half): unknown income id error with the legal table
  const badIncomeErr = await toolErrorText('warp_plan', { income: ['9.9_p9_1'] })

  // resources.set case 2 (MCP half): save=true roundtrip
  const written = await callTool('warp_plan', {
    jades: 32000, passes: 9, income: ['4.5_p1_1'], starlight: 'REFUND_LOW',
    pityCharacter: 33, guaranteedCharacter: false, pityLightCone: 11, guaranteedLightCone: true,
    plannerMode: 'multi', strategy: 5, save: true,
    targets: [{ characterId: '1005', targetEidolonLevel: 2, currentEidolonLevel: 0 }],
  })
  const writtenExport = `${tempDir}/written.json`
  await callTool('export_save', { path: writtenExport })
  const writtenSave = JSON.parse(readFileSync(writtenExport, 'utf8'))

  await browserManager.runTask({ label: 'verify(warp-A)', seed: seedSave({ warpRequest: R1 }), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', seedSave({ warpRequest: R1 }))
    const fields = await page.evaluate(READ_WARP_FIELDS)
    // [0]=jades [1]=passes [2]=starlight label [3]=income [4]=pityChar [5]=pityLC
    const webJades = parseFloat(fields[0])
    const webPasses = parseFloat(fields[1])
    const starlightLabel = fields[2] ?? ''
    const webPityChar = parseFloat(fields[4])
    const webPityLc = parseFloat(fields[5])
    const summary = await page.evaluate(READ_SUMMARY)
    const req = fromSavedEcho.request
    const inputOk = webJades === req.jades && webPasses === req.passes && webPityChar === req.pityCharacter
      && webPityLc === req.pityLightCone && starlightLabel.includes('11%')
    // guaranteed state: radios report the checked sides
    const guaranteed = await page.evaluate(`() => {
      const checked = [...document.querySelectorAll('#WARP input[type=radio]:checked')].map((x) => x.value)
      return { checkedCount: checked.length, trueCount: checked.filter((v) => v === 'true').length }
    }`)
    const summaryText = summary.join(' ')
    // 8000 jade (=50) + 20 passes + 72 income = 142; REFUND_HIGH floor(0.11*142)=15 passes → 300 starlight → 157
    const summaryOk = summaryText.includes('8,000') && summaryText.includes('20') && summaryText.includes('72') && summaryText.includes('157')
    const echoBudgetOk = fromSavedEcho.totalWarps === 157 && req.totalStarlight === 300 && req.additionalPasses === 72
    record(
      'warp.resources.set', 1,
      'fromSaved 读出的请求与网页端打开页面时各输入框显示的值一致',
      'browser-parity',
      inputOk && summaryOk && echoBudgetOk ? 'PASS' : 'FAIL',
      `网页输入 jades=${webJades}/passes=${webPasses}/垫抽=${webPityChar},${webPityLc}/返利标签="${starlightLabel}" vs MCP fromSaved jades=${req.jades}/passes=${req.passes}/pity=${req.pityCharacter},${req.pityLightCone}/${req.starlight};摘要"${summaryText}"(8000+20+72+15=157);guaranteed勾选=${JSON.stringify(guaranteed)}`,
    )

    // income pills: seeded 4.6_p1_1 selected on the page; unknown id dropped at load
    const pills = await page.evaluate(`() => [...document.querySelectorAll('#WARP .mantine-Pill-root, #WARP [class*=pill]')]
      .filter((p) => p.offsetParent !== null).map((p) => p.textContent.trim()).slice(0, 6)`)
    record(
      'warp.resources.set', 3,
      '传入不存在的收入选项 id 时报错并列出合法 id',
      'browser-parity',
      badIncomeErr != null && badIncomeErr.includes('9.9_p9_1') && badIncomeErr.includes('未知的收入选项')
        && badIncomeErr.includes('4.5_p1_1') && badIncomeErr.includes('4.6_p2_1') ? 'PASS' : 'FAIL',
      `MCP warp_plan(income=['9.9_p9_1']) 报错含该 id 与合法表:${(badIncomeErr ?? '').slice(0, 90)};合法 id 表与网页端收入选项同源(WarpIncomeOptions);网页已选收入=[${pills.join(',')}]`,
    )
  })

  // resources.set case 2 — web loads the MCP-written export
  await browserManager.runTask({ label: 'verify(warp-A2)', seed: readFileSync(writtenExport, 'utf8'), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', readFileSync(writtenExport, 'utf8'))
    const harvest = await page.evaluate(HARVEST)
    const webReq = harvest.warpRequest
    const savedReq = written.savedRequest
    const equal = ['passes', 'jades', 'income', 'plannerMode', 'strategy', 'starlight', 'pityCharacter', 'guaranteedCharacter', 'pityLightCone', 'guaranteedLightCone']
      .every((k) => JSON.stringify(webReq?.[k]) === JSON.stringify(savedReq?.[k]))
      && JSON.stringify(webReq?.targets) === JSON.stringify(savedReq?.targets)
    record(
      'warp.resources.set', 2,
      '要求保存后，导出的存档里 warpRequest 与网页端填同样数值后的内容一致',
      'browser-parity',
      equal && JSON.stringify(writtenSave.warpRequest) === JSON.stringify(savedReq) ? 'PASS' : 'FAIL',
      `MCP warp_plan(save=true) → export_save → 网页载入后页面自身 SaveState 落盘的 warpRequest 与 MCP 持久化请求逐字段一致:${equal};webTargets=${JSON.stringify(webReq?.targets?.map((t) => [t.characterId, t.currentEidolonLevel, t.targetEidolonLevel]))}`,
    )
  })

  // ═══ Phase B: plan.simple — 8 strategies + fromSaved replay ══════════════
  const strategyRuns = {}
  for (let s = 0; s <= 7; s++) {
    strategyRuns[s] = await callTool('warp_plan', {
      jades: 64000, starlight: 'REFUND_NONE', strategy: s, applyPlannerMode: true,
    })
  }
  // the fromSaved replay must run against the SAME simple-mode save the page loads
  const simplePath = seedFile('simple', seedSave({ warpRequest: simpleSeed }))
  await callTool('load_save', { path: simplePath })
  const simpleSaveEcho = await callTool('warp_plan', { fromSaved: true, applyPlannerMode: true })

  await browserManager.runTask({ label: 'verify(warp-B)', seed: seedSave({ warpRequest: simpleSeed }), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', seedSave({ warpRequest: simpleSeed }))
    let allOk = true
    const perStrategy = []
    for (let s = 0; s <= 7; s++) {
      const strategyName = s === 7 ? 'S1 first' : `E${s} first`
      // the select shows the strategy for value 0 as 'E0 first' etc; switch by dropdown
      const currentLabel = (await page.evaluate(READ_WARP_FIELDS)).find((v) => /first/.test(v))
      if (currentLabel !== strategyName) {
        await page.evaluate(CLICK_WARP_SELECT, [currentLabel])
        await sleep(400)
        const pick = await page.evaluate(CLICK_OPEN_OPTION, [strategyName])
        if (pick !== 'picked') {
          allOk = false
          perStrategy.push(`s${s}:${pick}`)
          continue
        }
      }
      await sleep(600)
      const tables = await page.evaluate(READ_WARP_TABLES)
      const webRows = tables.flat()
      const mismatch = compareMilestones(webRows, strategyRuns[s].targetResults[0].milestones)
      if (mismatch != null) {
        allOk = false
        perStrategy.push(`s${s}:${mismatch}`)
      } else {
        perStrategy.push(`s${s}:${webRows.length}行`)
      }
    }
    record(
      'warp.plan.simple', 1,
      '八种策略下各里程碑的期望抽数与达成概率，与网页端简单模式结果表逐行一致',
      'browser-parity',
      allOk ? 'PASS' : 'FAIL',
      `8 策略逐行比对(标签/概率%/期望抽数 ceil):${perStrategy.join('; ')};示例 strategy0 E6S5=${strategyRuns[0].targetResults[0].milestones.at(-1).warps.toFixed(1)}抽`,
    )

    // switch back to the seeded strategy (E0 first) before the fromSaved comparison
    const currentLabel = (await page.evaluate(READ_WARP_FIELDS)).find((v) => /first/.test(v))
    if (currentLabel !== 'E0 first') {
      await page.evaluate(CLICK_WARP_SELECT, [currentLabel])
      await sleep(400)
      await page.evaluate(CLICK_OPEN_OPTION, ['E0 first'])
      await sleep(700)
    }

    // plan.simple case 2: the save itself is simple mode (seeded) — page table vs fromSaved replay
    const tablesSimple = await page.evaluate(READ_WARP_TABLES)
    const webRows = tablesSimple.flat()
    const mismatch = compareMilestones(webRows, simpleSaveEcho.targetResults[0].milestones)
    record(
      'warp.plan.simple', 2,
      '对一份处于简单模式的存档按网页端口径计算，结果与页面显示一致',
      'browser-parity',
      mismatch == null ? 'PASS' : 'FAIL',
      mismatch ?? `简单模式存档(fromSaved+applyPlannerMode,预算 ${simpleSaveEcho.totalWarps} 抽)与页面表格 ${webRows.length} 行逐行一致`,
    )

    // ═══ Phase B2: results.read — pity/guarantee sensitivity ══════════════
    const tables0 = await page.evaluate(READ_WARP_TABLES)
    const row0 = tables0.flat()[0]
    const setPity = await page.evaluate(SET_WARP_INDEX, [4, '89']) // pityCharacter
    await sleep(700)
    const tables89 = await page.evaluate(READ_WARP_TABLES)
    const row89 = tables89.flat()[0]
    const mcpPity0 = await callTool('warp_plan', { jades: 64000, starlight: 'REFUND_NONE', strategy: 0, applyPlannerMode: true, pityCharacter: 0 })
    const mcpPity89 = await callTool('warp_plan', { jades: 64000, starlight: 'REFUND_NONE', strategy: 0, applyPlannerMode: true, pityCharacter: 89 })
    const m0 = mcpPity0.targetResults[0].milestones[0]
    const m89 = mcpPity89.targetResults[0].milestones[0]
    const pityOk = setPity === '89' && compareMilestones(tables0.flat(), mcpPity0.targetResults[0].milestones) == null
      && compareMilestones(tables89.flat(), mcpPity89.targetResults[0].milestones) == null
      && m0.warps > m89.warps
    record(
      'warp.results.read', 3,
      '已垫抽数与必中状态变化后，结果与网页端同步变化',
      'browser-parity',
      pityOk ? 'PASS' : 'FAIL',
      `垫抽 0→89(输入位4="${setPity}"):网页 E0S0 行 ${row0?.chance}%/${row0?.warps}抽 → ${row89?.chance}%/${row89?.warps}抽;MCP ${m0.warps.toFixed(2)}抽(${(m0.wins * 100).toFixed(1)}%) → ${m89.warps.toFixed(2)}抽(${(m89.wins * 100).toFixed(1)}%),期望抽数同步下降`,
    )
  })

  // ═══ Phase C: plan.targets — the web UI builds the target list ═══════════
  // NOTE: the picker only lists premium characters (isPremiumCharacter) — Kafka
  // (1005) and most of the sample roster carry a b1 variant and are excluded,
  // so the target cases use Acheron (1308, unowned) and Jingliu (1212b1, owned E1).
  // addCharGoal produces ONE character row; addCharAndSignatureGoal produces TWO
  // rows (character goal + signature light-cone goal), matching the web UI.

  // — C-a: chaining — add the same character twice, no manual level edits —
  await browserManager.runTask({ label: 'verify(warp-Ca)', seed: seedSave({ warpRequest: multiSeed }), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', seedSave({ warpRequest: multiSeed }))
    await page.evaluate(CLICK_WARP_BUTTON, ['Add character'])
    await sleep(700)
    const pick1 = await page.evaluate(PICK_CARD, ['1308'])
    await sleep(1200)
    await page.evaluate(CLICK_WARP_BUTTON, ['Add character'])
    await sleep(700)
    const pick2 = await page.evaluate(PICK_CARD, ['1308'])
    await sleep(1200)
    const h2 = await page.evaluate(HARVEST)
    const t2 = h2.warpRequest.targets
    const normRun = await callTool('warp_plan', {
      jades: 80000, starlight: 'REFUND_NONE', plannerMode: 'multi', normalizeTargets: true,
      targets: [{ characterId: '1308' }, { characterId: '1308' }],
    })
    const normTargets = normRun.request.targets.map((t) => [t.currentEidolonLevel, t.targetEidolonLevel, t.currentSuperimpositionLevel, t.targetSuperimpositionLevel])
    const webTargets = t2.map((t) => [t.currentEidolonLevel, t.targetEidolonLevel, t.currentSuperimpositionLevel, t.targetSuperimpositionLevel])
    const chainOk = t2.length === 2 && pick1 === 'picked' && pick2 === 'picked'
      && JSON.stringify(webTargets) === JSON.stringify(normTargets)
      && webTargets[0][0] === -1 && webTargets[0][1] === 0 && webTargets[1][0] === 0 && webTargets[1][1] === 1
    record(
      'warp.plan.targets', 2,
      '同一角色先后两个目标交给工具规范化后，起止等级与网页端自动接续后的结果一致',
      'browser-parity',
      chainOk ? 'PASS' : 'FAIL',
      `网页两次「添加角色」(Acheron)自动接续 targets 等级[当前E,目标E,当前S,目标S]=${JSON.stringify(webTargets)};MCP normalizeTargets([{1308},{1308}])=${JSON.stringify(normTargets)}(首尾相接 E-1→E0 接 E0→E1)`,
    )
  })

  // — C-b: char+signature with To→E2, owned-eidolon start, drag reorder —
  await browserManager.runTask({ label: 'verify(warp-Cb)', seed: seedSave({ warpRequest: multiSeed }), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', seedSave({ warpRequest: multiSeed }))

    // — case 1: Acheron (1308, unowned) + signature light cone, To → E2 —
    const add1 = await page.evaluate(CLICK_WARP_BUTTON, ['Add character and signature'])
    await sleep(700)
    const pick1 = await page.evaluate(PICK_CARD, ['1308'])
    await sleep(1200)
    const seg = await page.evaluate(CLICK_TARGET_SEGMENT, [0, 'to', 'E2'])
    await sleep(900)
    const h1 = await page.evaluate(HARVEST)
    const t1 = h1.warpRequest.targets
    const tables1 = await page.evaluate(READ_WARP_TABLES)
    const plan1 = await callTool('warp_plan', {
      jades: 80000, starlight: 'REFUND_NONE', plannerMode: 'multi', targets: t1,
    })
    const mismatch1 = tables1.length === t1.length && t1.length === 2
      ? tables1.map((rows, i) => compareMilestones(rows, plan1.targetResults[i].milestones)).find((m) => m != null) ?? null
      : `rows web-tables=${tables1.length} targets=${t1.length} mcp=${plan1.targetResults.length}`
    record(
      'warp.plan.targets', 1,
      '给出「某角色 E0 到 E2，再加其专属光锥 S1」的目标串，各里程碑的期望抽数与达成概率与网页端同样编排后的表格一致',
      'browser-parity',
      add1 === true && pick1 === 'picked' && seg === 'clicked' && mismatch1 == null ? 'PASS' : 'FAIL',
      mismatch1 ?? `网页「角色+专属光锥」编排(Acheron:角色行 E${t1[0].currentEidolonLevel}→E${t1[0].targetEidolonLevel} + 光锥行 S${t1[1].currentSuperimpositionLevel}→S${t1[1].targetSuperimpositionLevel})两个目标表格与 MCP warp_plan(同 targets)逐行一致(${tables1.map((r) => r.length + '行').join('+')})`,
    )

    // — case 3: Jingliu (1212b1, owned E1) by id alone → start = owned eidolon —
    const add3 = await page.evaluate(CLICK_WARP_BUTTON, ['Add character'])
    await sleep(700)
    const pick3 = await page.evaluate(PICK_CARD, ['1212b1'])
    await sleep(1200)
    const h3 = await page.evaluate(HARVEST)
    const t3Row = h3.warpRequest.targets.at(-1)
    const ownedRun = await callTool('warp_plan', {
      jades: 80000, starlight: 'REFUND_NONE', plannerMode: 'multi', normalizeTargets: true,
      targets: [{ characterId: '1212b1' }],
    })
    const ownedRow = ownedRun.request.targets[0]
    const jingliuSave = h3.characters.find((c) => c.id === '1212b1')
    const ownedOk = t3Row?.currentEidolonLevel === 1 && ownedRow.currentEidolonLevel === 1
      && jingliuSave?.form?.characterEidolon === 1
    record(
      'warp.plan.targets', 3,
      '只给角色 id 新增目标时，起点等于存档里该角色的星魂',
      'browser-parity',
      pick3 === 'picked' && ownedOk ? 'PASS' : 'FAIL',
      `网页新增 Jingliu 目标起点 E${t3Row?.currentEidolonLevel}(→E${t3Row?.targetEidolonLevel});MCP normalizeTargets 起点 E${ownedRow.currentEidolonLevel}(→E${ownedRow.targetEidolonLevel});存档该角色星魂 E${jingliuSave?.form?.characterEidolon}`,
    )

    // — case 4: reorder via drag (last row → top) —
    const beforeDrag = await page.evaluate(HARVEST)
    const orderBefore = beforeDrag.warpRequest.targets.map((t) => t.characterId ?? t.lightConeId)
    const dragResult = await dragTargetRow(page, 2, 0)
    await sleep(1500)
    const afterDrag = await page.evaluate(HARVEST)
    const orderAfter = afterDrag.warpRequest.targets.map((t) => t.characterId ?? t.lightConeId)
    const dragged = orderAfter.length === 3 && orderAfter[0] === orderBefore[2] && orderAfter[1] === orderBefore[0] && orderAfter[2] === orderBefore[1]
    const tables4 = await page.evaluate(READ_WARP_TABLES)
    const plan4 = await callTool('warp_plan', {
      jades: 80000, starlight: 'REFUND_NONE', plannerMode: 'multi', targets: afterDrag.warpRequest.targets,
    })
    const mismatch4 = dragged
      ? tables4.map((rows, i) => compareMilestones(rows, plan4.targetResults[i]?.milestones ?? [])).find((m) => m != null) ?? null
      : 'drag did not land'
    record(
      'warp.plan.targets', 4,
      '交换两个目标的顺序后，结果与网页端拖动后的表格一致',
      'browser-parity',
      dragged && mismatch4 == null ? 'PASS' : 'FAIL',
      dragged
        ? `拖拽重排 [${orderBefore.join(',')}] → [${orderAfter.join(',')}],网页各目标表格与 MCP warp_plan(同序 targets)逐行一致(${mismatch4 ?? 'ok'})`
        : `拖拽未生效(${dragResult});顺序保持 [${orderAfter.join(',')}] — 合成指针事件未触发 dnd-kit,需人工复核拖拽路径`,
    )
  })

  // ═══ Phase C2: results.read #1/#2 on the multi table ═════════════════════
  await browserManager.runTask({ label: 'verify(warp-C2)', seed: seedSave({ warpRequest: multiSeed }), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', seedSave({ warpRequest: multiSeed }))
    // jades 32000 (=200) + passes 9 = 209; starlight 4% refund → floor(0.04*209) = 8 passes → 160 starlight → 217
    const setJades = await page.evaluate(SET_WARP_INDEX, [0, '32000'])
    await sleep(500)
    const setPasses = await page.evaluate(SET_WARP_INDEX, [1, '9'])
    await sleep(500)
    await page.evaluate(CLICK_WARP_SELECT, ['None'])
    await sleep(400)
    const pickRefund = await page.evaluate(CLICK_OPEN_OPTION, ['4% refund (Low)'])
    await sleep(900)
    const summary = (await page.evaluate(READ_SUMMARY)).join(' ')
    const mcpBudget = await callTool('warp_plan', {
      jades: 32000, passes: 9, income: [], starlight: 'REFUND_LOW', plannerMode: 'multi',
    })
    const summaryOk = pickRefund === 'picked' && setJades === '32000' && setPasses === '9'
      && summary.includes('32,000') && summary.includes('9') && summary.includes('160') && summary.includes('217')
    record(
      'warp.results.read', 1,
      '同一请求下总抽数、星芒返利折算的额外专票与网页端摘要一致',
      'browser-parity',
      summaryOk && mcpBudget.totalWarps === 217 && mcpBudget.request.totalStarlight === 160 ? 'PASS' : 'FAIL',
      `网页摘要"${summary}"(32000玉+9票,4%返利 floor(8.36)=8 张=160 星芒 → 217);MCP 同请求 totalWarps=${mcpBudget.totalWarps} totalStarlight=${mcpBudget.request.totalStarlight}`,
    )

    // per-target rows: build one char+signature target on the web, compare every milestone row
    await page.evaluate(CLICK_WARP_BUTTON, ['Add character and signature'])
    await sleep(700)
    await page.evaluate(PICK_CARD, ['1308'])
    await sleep(1400)
    const tables = await page.evaluate(READ_WARP_TABLES)
    const harvest = await page.evaluate(HARVEST)
    const plan = await callTool('warp_plan', {
      jades: 32000, passes: 9, income: [], starlight: 'REFUND_LOW', plannerMode: 'multi', targets: harvest.warpRequest.targets,
    })
    const rowMismatch = tables.length === harvest.warpRequest.targets.length && harvest.warpRequest.targets.length === 2
      ? tables.map((rows, i) => compareMilestones(rows, plan.targetResults[i].milestones)).find((m) => m != null) ?? null
      : `rows web-tables=${tables.length} targets=${harvest.warpRequest.targets.length}`
    record(
      'warp.results.read', 2,
      '每个目标每个里程碑的期望抽数与达成概率与网页端结果表逐行一致',
      'browser-parity',
      rowMismatch == null ? 'PASS' : 'FAIL',
      rowMismatch == null
        ? `网页两个目标表格(${tables.map((r) => r.length + '行').join('+')})与 MCP 逐行一致(首表首行 ${tables[0][0].label} ${tables[0][0].chance}%/${tables[0][0].warps}抽)`
        : `比对失败:${rowMismatch}`,
    )
  })

  // ═══ Phase D: scanner sync — one fake archiver, both sides connected ═════
  archiverHttp = createServer()
  archiverWss = new WebSocketServer({ server: archiverHttp })
  archiverWss.on('connection', (ws) => {
    archiverClients.add(ws)
    ws.on('close', () => archiverClients.delete(ws))
  })
  await new Promise((res) => archiverHttp.listen(0, '127.0.0.1', res))
  const archiverPort = archiverHttp.address().port
  const archiverUrl = `ws://127.0.0.1:${archiverPort}/ws`
  const push = (event, data) => {
    const text = JSON.stringify({ event, data })
    for (const ws of archiverClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    }
  }

  // MCP side connects explicitly (its load_save does not auto-connect)
  const scannerSavePath = seedFile('scanner-on', seedSave({
    warpRequest: scannerBase,
    scannerSettings: {
      ingest: true, ingestCharacters: false, ingestOnlyExistingCharacters: false,
      ingestWarpResources: true, websocketUrl: archiverUrl, customUrl: true,
    },
  }))
  await callTool('load_save', { path: scannerSavePath })
  await callTool('update_state', { section: 'scanner', patch: { ingest: true, ingestWarpResources: true, websocketUrl: archiverUrl } })
  const connected = await callTool('scanner', { action: 'connect', url: archiverUrl })
  if (connected.connected !== true) throw new Error('MCP scanner connect failed')

  // web side: seeded scannerSettings auto-connects at boot (SaveState.load(false,false) keeps customUrl)
  const scannerEvents = [
    ['UpdateMaterials', [{ id: '102', name: 'Special Pass', count: 5 }, { id: '252', name: 'Undying Starlight', count: 37 }]],
    ['UpdateGachaFunds', { stellar_jade: 1600, oneric_shards: 320 }],
    ['GachaResult', {
      banner_id: 1, banner_type: 'Character', pity_4: { kind: 'AddPity', amount: 1 },
      pity_5: { kind: 'AddPity', amount: 3 }, pull_results: [],
    }],
    ['GachaResult', {
      banner_id: 11, banner_type: 'LightCone', pity_4: { kind: 'AddPity', amount: 1 },
      pity_5: { kind: 'ResetPity', amount: 20, set_guarantee: true }, pull_results: [],
    }],
  ]

  await browserManager.runTask({ label: 'verify(warp-D)', seed: readFileSync(scannerSavePath, 'utf8'), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', readFileSync(scannerSavePath, 'utf8'), 5000)
    // wait until both clients (MCP + page) are connected to the fake archiver
    const deadline = Date.now() + 30_000
    while (archiverClients.size < 2 && Date.now() < deadline) await sleep(300)
    const bothConnected = archiverClients.size >= 2

    for (const [event, data] of scannerEvents) {
      push(event, data)
      await sleep(350)
    }
    await sleep(1500)

    const harvest = await page.evaluate(HARVEST)
    const webReq = harvest.warpRequest
    const mcpReq = (await callTool('warp_plan', { fromSaved: true })).request
    const fields = ['jades', 'passes', 'pityCharacter', 'guaranteedCharacter', 'pityLightCone', 'guaranteedLightCone']
    const diffs = fields.filter((k) => JSON.stringify(webReq?.[k]) !== JSON.stringify(mcpReq[k]))
    const expected = { jades: 1920, passes: 6, pityCharacter: 8, pityLightCone: 20, guaranteedLightCone: true, guaranteedCharacter: false }
    const expectedOk = fields.every((k) => JSON.stringify(mcpReq[k]) === JSON.stringify(expected[k]))
    record(
      'warp.scanner.sync', 1,
      '回放一段含资源更新与抽卡结果的扫描器事件后，存档里 warpRequest 的星琼、专票、两个卡池的已垫抽数与必中状态与网页端回放同一段事件后一致',
      'browser-parity',
      bothConnected && diffs.length === 0 && expectedOk ? 'PASS' : 'FAIL',
      `同一假 Archiver 同时连接两侧(${archiverClients.size} 客户端),回放 4 帧后网页 warpRequest=${JSON.stringify(fields.map((k) => webReq?.[k]))} vs MCP=${JSON.stringify(fields.map((k) => mcpReq[k]))};期望=${JSON.stringify([1920, 6, 8, false, 20, true])}(星琼=1600+320,专票=5+floor(37/20),角色垫抽 5+3,光锥重置 20+必中)`,
    )
  })

  // — case 2: ingestWarpResources OFF → the same events change nothing on either side —
  const scannerOffPath = seedFile('scanner-off', seedSave({
    warpRequest: scannerBase,
    scannerSettings: {
      ingest: true, ingestCharacters: false, ingestOnlyExistingCharacters: false,
      ingestWarpResources: false, websocketUrl: archiverUrl, customUrl: true,
    },
  }))
  await callTool('update_state', { section: 'scanner', patch: { ingestWarpResources: false } })
  const mcpBefore2 = (await callTool('warp_plan', { fromSaved: true })).request
  await browserManager.runTask({ label: 'verify(warp-D2)', seed: readFileSync(scannerOffPath, 'utf8'), timeoutMs: 600_000 }, async (page) => {
    await bootPage(page, '#warp', readFileSync(scannerOffPath, 'utf8'), 5000)
    const deadline = Date.now() + 30_000
    while (archiverClients.size < 2 && Date.now() < deadline) await sleep(300)
    const webBefore2 = await page.evaluate(HARVEST)

    push('UpdateGachaFunds', { stellar_jade: 9999, oneric_shards: 0 })
    push('UpdateMaterials', [{ id: '102', name: 'Special Pass', count: 100 }, { id: '252', name: 'Undying Starlight', count: 500 }])
    push('GachaResult', {
      banner_id: 1, banner_type: 'Character', pity_4: { kind: 'AddPity', amount: 1 },
      pity_5: { kind: 'AddPity', amount: 10 }, pull_results: [],
    })
    await sleep(2000)

    const webAfter2 = await page.evaluate(HARVEST)
    const mcpAfter2 = (await callTool('warp_plan', { fromSaved: true })).request
    const fields2 = ['jades', 'passes', 'pityCharacter', 'guaranteedCharacter', 'pityLightCone', 'guaranteedLightCone']
    const webUnchanged = fields2.every((k) => JSON.stringify(webAfter2.warpRequest?.[k]) === JSON.stringify(webBefore2.warpRequest?.[k]))
    const mcpUnchanged = fields2.every((k) => JSON.stringify(mcpAfter2[k]) === JSON.stringify(mcpBefore2[k]))
    record(
      'warp.scanner.sync', 2,
      'ingestWarpResources 关闭时同样的事件不改动 warpRequest',
      'browser-parity',
      webUnchanged && mcpUnchanged ? 'PASS' : 'FAIL',
      `关闭(网页经存档 scannerSettings.ingestWarpResources=false / MCP update_state(section=scanner))后回放资源帧与抽卡帧:网页 warpRequest 不变:${webUnchanged}(jades=${webAfter2.warpRequest?.jades},pity=${webAfter2.warpRequest?.pityCharacter});MCP 不变:${mcpUnchanged}(jades=${mcpAfter2.jades},pity=${mcpAfter2.pityCharacter})`,
    )
  })
  // restore the MCP-side flag for cleanliness
  await callTool('update_state', { section: 'scanner', patch: { ingestWarpResources: true } })
} catch (e) {
  console.error('verify-warp: harness error', e)
  process.exitCode = 1
} finally {
  try {
    await client.close()
  } catch { /* already closed */ }
  try {
    await browserManager.close()
  } catch { /* browser already down */ }
  try {
    for (const ws of archiverClients) ws.terminate()
    if (archiverHttp) await new Promise((res) => archiverHttp.close(() => res()))
  } catch { /* archiver already down */ }
  rmSync(tempDir, { recursive: true, force: true })
}

// ── evidence file ────────────────────────────────────────────────────────────
writeFileSync(evidencePath, JSON.stringify({
  area: 'warp',
  generatedAt: GENERATED_AT,
  gitCommit: GIT_COMMIT,
  cases,
}, null, 2) + '\n')

const failed = cases.filter((c) => c.result !== 'PASS').length
console.log(failed === 0 ? `\nverify-warp: ALL ${cases.length} CASES PASSED` : `\nverify-warp: ${failed} OF ${cases.length} CASES FAILED/UNPROVEN`)
process.exit(failed === 0 ? 0 : 1)
