// verified-acceptance parity harness for the CALCULATORS domain (protocol
// 2026-10-08, coverage/features/calculators.json).
//
// Every scope=baseline acceptance case gets a same-version browser/MCP
// cross-check:
//   - MCP side: stdio server (temp state file, temp artifacts dir), the
//     calculators tools (calc_aha / calc_ehr / warp_plan-free) + the
//     site://pages resource.
//   - Web side: the managed browser (browserManager, the same source the
//     server bundles) loads the repo-root dist/ build, seeded with save
//     copies; values are READ FROM THE RENDERED PAGE (MathML formula text,
//     solver outputs, EHR grid cells, panel headers) and inputs are driven
//     through the page's own widgets (native setter + input/blur events on
//     Mantine NumberInputs, real dropdown clicks on Mantine Selects, real
//     panel-tab clicks).
//
// Cases covered (feature.case):
//   calculators.panel.switch 1-2, calculators.aha.form 1-2,
//   calculators.aha.compute 1-3, calculators.aha.solve 1-3,
//   calculators.ehr.probability 1-3, calculators.ehr.grid 1-3,
//   calculators.ehr.solve 1-3.
//
// Everything persistent lives in a mkdtempSync temp dir (save copies +
// HSR_MCP_STATE_FILE + HSR_MCP_ARTIFACTS_DIR); the repo sample save is never
// a write target. The browser is closed and the temp dir removed at exit.
//
// Usage: node scripts/verify-calculators.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

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
const evidencePath = resolve(mcpDir, 'coverage/evidence/calculators.json')

const GIT_COMMIT = '8ac1d045'
const GENERATED_AT = new Date().toISOString()

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
const chromePath = findChrome()
const siteDist = findSiteDist()
if (chromePath == null || siteDist == null) {
  const reasons = []
  if (chromePath == null) reasons.push('本机未找到 Chrome/Chromium 可执行文件')
  if (siteDist == null) reasons.push('未找到站点构建产物 dist/index.html')
  console.log(`[SKIP] calculators 对拍需要受管浏览器环境,当前缺少:${reasons.join(' / ')}`)
  process.exit(0)
}

// ── case recorder ────────────────────────────────────────────────────────────
const cases = []
function record(feature, caseNo, desc, method, result, detail) {
  cases.push({
    feature,
    case: caseNo,
    desc: desc.slice(0, 60),
    method,
    result,
    detail: detail.replace(/\s+/g, ' ').slice(0, 220),
    script: 'mcp/scripts/verify-calculators.mjs',
  })
  console.log(`[${result}] ${feature} #${caseNo} (${method}) — ${detail.replace(/\s+/g, ' ').slice(0, 200)}`)
}

// ── temp workspace ───────────────────────────────────────────────────────────
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-calculators-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── MCP client ───────────────────────────────────────────────────────────────
const client = new Client({ name: 'verify-calculators', version: '0.0.0' })
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

// ── managed browser (the same module the server bundles) ────────────────────
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

// ═══ page-side read/write helpers ═══════════════════════════════════════════

/** Save-file seed for a browser task: sample + overrides. */
function seedSave(overrides, warpRequest, ahaSpeedTuner) {
  const data = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  Object.assign(data, overrides)
  if (warpRequest) data.warpRequest = warpRequest
  if (ahaSpeedTuner) data.ahaSpeedTuner = ahaSpeedTuner
  return JSON.stringify(data)
}

const PAGE_BOOT = async (page, hash, seed) => {
  await page.goto(hash, { timeoutMs: 90_000 })
  await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
  await sleep(2500)
}

/** The AHA panel's 5 inputs in DOM order (teammate0-3 + solver) + formula. */
const READ_AHA = `() => {
  const inputs = [...document.querySelectorAll('#CALCULATORS input')].filter((el) => el.offsetParent !== null)
  const formulas = [...document.querySelectorAll('#CALCULATORS math')].filter((m) => m.offsetParent !== null)
    .map((m) => m.textContent)
  const rowMetas = [...document.querySelectorAll('#CALCULATORS .rowMeta, #CALCULATORS [class*=rowMeta]')].length
  return { inputs: inputs.map((el) => el.value), formulas }
}`

/** Solver output block: header label + value span (works for AHA and EHR). */
const READ_SOLVER = `(marker) => {
  const headers = [...document.querySelectorAll('#CALCULATORS h1, #CALCULATORS h2, #CALCULATORS h3, #CALCULATORS h4, #CALCULATORS h5, #CALCULATORS h6, #CALCULATORS [class*=headerText], #CALCULATORS b')]
    .filter((e) => e.offsetParent !== null && e.textContent.includes(marker))
  const scope = headers[0]?.parentElement
  if (!scope) return null
  const span = scope.querySelector('span')
  return { label: headers[0].textContent.trim(), value: span ? span.textContent.trim() : '' }
}`

/** EHR forward formulas: per-attempt + cumulative text. */
const READ_EHR_FORMULAS = `() => [...document.querySelectorAll('#CALCULATORS math')].filter((m) => m.offsetParent !== null).map((m) => m.textContent)`

/** EHR grid: rows [ehr%, 9 cells] + current-row (EHR guide span) + current column (RES marker). */
const READ_EHR_GRID = `() => {
  const rowDivs = [...document.querySelectorAll('#CALCULATORS div')].filter((d) =>
    (d.children.length === 10 || d.children.length === 11)
    && (d.children[0].style.width === '36px' || d.children[1]?.style.width === '36px'))
  const rows = []
  let resGuideIndex = null
  for (const r of rowDivs) {
    const offset = r.children[0].style.width === '36px' ? 0 : 1
    const kids = [...r.children].slice(offset)
    const label = parseInt(kids[0].textContent, 10)
    if (Number.isNaN(label)) {
      // header row: children are [emptyLabel, ...9 col headers]; the current column carries a RES marker
      const idx = kids.findIndex((c, i) => i >= 1 && c.textContent.includes('RES'))
      if (idx >= 1) resGuideIndex = idx - 1
      continue
    }
    rows.push({
      ehr: label,
      cells: kids.slice(1).map((c) => parseInt(c.textContent, 10)),
      isCurrentRow: [...r.querySelectorAll('span')].some((s) => s.textContent === 'EHR'),
    })
  }
  return { rows, resGuideIndex }
}`

/** Set a Mantine NumberInput by its current value → returns the new value. */
const SET_NUMBER_INPUT = `(fromValue, toValue) => {
  const el = [...document.querySelectorAll('#CALCULATORS input')].filter((x) => x.offsetParent !== null && x.value === fromValue)[0]
  if (!el) return null
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, String(toValue))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('blur', { bubbles: true }))
  return el.value
}`

/** Click a visible Mantine Select (by current input value) then a dropdown option by exact text. */
const CLICK_SELECT_OPTION = `(currentValue, optionText) => {
  const sel = [...document.querySelectorAll('#CALCULATORS input')].filter((x) => x.offsetParent !== null && x.value === currentValue)[0]
  if (!sel) return 'select-not-found:' + currentValue
  sel.click()
  return 'clicked'
}`
const CLICK_OPEN_OPTION = `(optionText) => {
  const opts = [...document.querySelectorAll('[role=option]')].filter((o) => o.offsetParent !== null)
  const hit = opts.find((o) => o.textContent.trim() === optionText)
  if (!hit) return 'option-not-found:' + optionText + '/' + opts.map((o) => o.textContent.trim()).slice(0, 8).join('|')
  hit.click()
  return 'picked'
}`

/** Panel tab buttons on the calculators page (Mantine Tabs). */
const CLICK_CALC_TAB = `(label) => {
  const tabs = [...document.querySelectorAll('#CALCULATORS [role=tab]')]
  const hit = tabs.find((b) => b.offsetParent !== null && (b.textContent || '').includes(label))
  if (!hit) return false
  hit.click()
  return true
}`
const CALC_PANEL_TITLES = `() => [...document.querySelectorAll('#CALCULATORS div')]
  .filter((e) => e.className && String(e.className).includes('sectionTitle') && e.offsetParent !== null)
  .map((e) => e.textContent.trim())`

/** Harvest the page's own SaveState.save() → parsed save object. */
const HARVEST = `() => {
  window.__HSR_DEBUG.SaveState.save()
  return JSON.parse(localStorage.getItem('state') || '{}')
}`

const closeEnough = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))

try {
  // ═══ MCP-side reference values (also the warp-free pure calls) ═══════════
  const ahaCompute = await callTool('calc_aha', { speeds: [160, 120, 100] })
  const ahaShuffled = await callTool('calc_aha', { speeds: [100, 160, 120] })
  const ahaEmpty = await callTool('calc_aha', { speeds: [] })
  const ehrProb1 = await callTool('calc_ehr', {
    mode: 'probability', effectRes: 40, debuffRes: 0, baseChance: 100, attempts: 1, effectHitRate: 50, desiredHitRate: 100,
  })
  const ehrProb3 = await callTool('calc_ehr', {
    mode: 'probability', effectRes: 40, debuffRes: 0, baseChance: 100, attempts: 3, effectHitRate: 50, desiredHitRate: 100,
  })
  const ehrClamp = await callTool('calc_ehr', {
    mode: 'probability', effectRes: 40, debuffRes: 0, baseChance: 100, attempts: 1, effectHitRate: 250, desiredHitRate: 100,
  })
  const ehrGridDefault = await callTool('calc_ehr', {
    mode: 'grid', effectRes: 40, debuffRes: 0, baseChance: 100, attempts: 1, effectHitRate: 50, desiredHitRate: 100,
  })
  const ehrSolve25 = await callTool('calc_ehr', {
    effectRes: 20, debuffRes: 0, baseChance: 100, attempts: 1, desiredHitRate: 100,
  })
  const ehrSolve24 = await callTool('calc_ehr', {
    effectRes: 20, debuffRes: 0, baseChance: 100, attempts: 2.4, desiredHitRate: 100,
  })
  const ehrSolve2 = await callTool('calc_ehr', {
    effectRes: 20, debuffRes: 0, baseChance: 100, attempts: 2, desiredHitRate: 100,
  })
  const ehrUnreachable = await callTool('calc_ehr', {
    effectRes: 20, debuffRes: 100, baseChance: 100, attempts: 1, desiredHitRate: 50,
  })

  // site://pages resource (panel.switch case 1)
  const pagesResource = payloadOfJson(await client.readResource({ uri: 'site://pages' }))
  function payloadOfJson(readResult) {
    return JSON.parse(readResult.contents[0].text)
  }
  const calcPage = pagesResource.pages.find((p) => p.page === 'CALCULATORS')

  // ═══ browser session ═════════════════════════════════════════════════════
  const ahaSeed = seedSave({}, undefined, { teammate0: 160, teammate1: 120, teammate2: 100, teammate3: '', desiredAha: '' })
  const solveSeed = seedSave({}, undefined, { teammate0: 180, teammate1: 135, teammate2: '', teammate3: '', desiredAha: 135 })
  const noSlotsSeed = seedSave({}, undefined, { teammate0: 180, teammate1: 135, teammate2: 160, teammate3: 150, desiredAha: 135 })
  const metSeed = seedSave({}, undefined, { teammate0: 180, teammate1: 135, teammate2: '', teammate3: '', desiredAha: 129 })

  await browserManager.runTask({ label: 'verify(calculators)', seed: ahaSeed, timeoutMs: 600_000 }, async (page) => {
    // ── panel.switch #2 (+#1 browser half): #ehr hash opens the EHR panel ──
    await PAGE_BOOT(page, '#ehr', ahaSeed)
    const hashPanelTitles = await page.evaluate(CALC_PANEL_TITLES)
    const hashShowsEhr = hashPanelTitles.some((t) => t.includes('Debuff Application Calculator'))
      && !hashPanelTitles.some((t) => t.includes('Aha Speed Calculator'))
    // now the real UI path: click the Aha Speed tab, then the Effect Hit Rate tab
    await page.evaluate(CLICK_CALC_TAB, ['Aha Speed'])
    await sleep(700)
    const ahaTitles = await page.evaluate(CALC_PANEL_TITLES)
    const tabAhaOk = ahaTitles.some((t) => t.includes('Aha Speed Calculator'))
      && !ahaTitles.some((t) => t.includes('Debuff Application Calculator'))
    await page.evaluate(CLICK_CALC_TAB, ['Effect Hit Rate'])
    await sleep(700)
    const backToEhrTitles = await page.evaluate(CALC_PANEL_TITLES)
    const tabEhrOk = backToEhrTitles.some((t) => t.includes('Debuff Application Calculator'))
      && !backToEhrTitles.some((t) => t.includes('Aha Speed Calculator'))
    record(
      'calculators.panel.switch', 2,
      '浏览器运行环境按 #ehr 打开后显示的是效果命中面板，与网页端点击该页签的结果一致',
      'browser-parity',
      hashShowsEhr && tabAhaOk && tabEhrOk ? 'PASS' : 'FAIL',
      `#ehr hash→EHR面板:${hashShowsEhr};点击页签切AHA:${tabAhaOk};再点击切回EHR:${tabEhrOk};titles=${JSON.stringify(backToEhrTitles.slice(0, 3))}`,
    )

    // panel.switch case 1 — site://pages content (MCP half)
    const note = calcPage?.note ?? ''
    const aliasEhr = pagesResource.aliasHashes?.['#ehr'] ?? ''
    const resourceText = JSON.stringify(pagesResource)
    const listsHashes = calcPage?.hash === '#aha' && note.includes('#aha') && note.includes('#ehr')
    const namesTools = /calc_aha/.test(resourceText) && /calc_ehr/.test(resourceText)
    record(
      'calculators.panel.switch', 1,
      'site://pages 在计算器页下列出两个子面板，hash 分别是 #aha 与 #ehr，并指明对应的工具是 calc_aha 与 calc_ehr',
      'browser-parity',
      listsHashes && namesTools ? 'PASS' : 'FAIL',
      `site://pages 顶层键=[${Object.keys(pagesResource).join(',')}];CALCULATORS.hash=${calcPage?.hash},note含#aha/#ehr:${note.includes('#aha') && note.includes('#ehr')};资源全文指明 calc_aha/calc_ehr:${namesTools}(实测未提及工具名 — 清单描述超出资源实际内容)`,
    )

    // ── aha.compute #1: contributions 32/12/5 + ahaSpeed 129 from the panel ─
    await page.evaluate(`() => { location.hash = '#aha'; return true }`)
    await sleep(1500)
    const ahaRead = await page.evaluate(READ_AHA)
    const formulaText = ahaRead.formulas.find((f) => f.includes('Aha Speed')) ?? ''
    const webAhaSpeed = parseFloat((formulaText.match(/=([\d.]+)SPD/) ?? [])[1] ?? 'NaN')
    const rowContributions = await page.evaluate(`() => {
      const metas = [...document.querySelectorAll('#CALCULATORS div')]
        .filter((d) => d.className && String(d.className).includes('rowMeta') && d.offsetParent !== null)
      const out = []
      for (const m of metas) {
        let row = m.parentElement
        while (row && !(String(row.className || '').match(/integratedRow(?!s)/))) row = row.parentElement
        if (!row) continue
        if (String(row.className).includes('baseRow')) continue // the constant 80 row
        out.push(m.textContent.trim())
      }
      return out
    }`)
    const contribNumbers = rowContributions.map((t) => parseFloat(t.replace('+', ''))).filter((n) => !Number.isNaN(n))
    const mcpContribs = ahaCompute.contributions.map((c) => c.contribution)
    const contribOk = contribNumbers.length === 3
      && contribNumbers.every((v, i) => closeEnough(v, mcpContribs[i]))
      && closeEnough(contribNumbers[0], 32) && closeEnough(contribNumbers[1], 12) && closeEnough(contribNumbers[2], 5)
    record(
      'calculators.aha.compute', 1,
      '队友速度 160、120、100 时阿哈速度为 129，各名次的贡献为 32、12、5，与网页端贡献条一致',
      'browser-parity',
      closeEnough(webAhaSpeed, ahaCompute.ahaSpeed) && closeEnough(webAhaSpeed, 129) && contribOk ? 'PASS' : 'FAIL',
      `网页公式=${webAhaSpeed}(期望129) vs MCP calc_aha=${ahaCompute.ahaSpeed};网页贡献条=[${contribNumbers.join(',')}] vs MCP=[${mcpContribs.map((v) => v.toFixed(1)).join(',')}] (32/12/5)`,
    )

    // aha.compute #2: shuffled input order → same result (web re-ranks by speed)
    const setSlot = await page.evaluate(`(values) => {
      const inputs = [...document.querySelectorAll('#CALCULATORS input')].filter((el) => el.offsetParent !== null).slice(0, 4)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      inputs.forEach((el, i) => {
        setter.call(el, String(values[i]))
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('blur', { bubbles: true }))
      })
      return inputs.map((el) => el.value)
    }`, [[100, 160, 120, '']])
    await sleep(900)
    const shuffledRead = await page.evaluate(READ_AHA)
    const webShuffledSpeed = parseFloat((shuffledRead.formulas.find((f) => f.includes('Aha Speed')) ?? '').match(/=([\d.]+)SPD/)?.[1] ?? 'NaN')
    record(
      'calculators.aha.compute', 2,
      '传入顺序打乱后结果不变',
      'browser-parity',
      closeEnough(webShuffledSpeed, ahaShuffled.ahaSpeed) && closeEnough(webShuffledSpeed, ahaCompute.ahaSpeed) ? 'PASS' : 'FAIL',
      `网页槽位序 [100,160,120,空] 显示 ${webShuffledSpeed};MCP calc_aha([100,160,120])=${ahaShuffled.ahaSpeed} = MCP([160,120,100])=${ahaCompute.ahaSpeed}`,
    )

    // aha.compute #3: all slots cleared → base 80
    await page.evaluate(`(values) => {
      const inputs = [...document.querySelectorAll('#CALCULATORS input')].filter((el) => el.offsetParent !== null).slice(0, 4)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      inputs.forEach((el) => {
        setter.call(el, '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('blur', { bubbles: true }))
      })
      return true
    }`, [[]])
    await sleep(900)
    const emptyRead = await page.evaluate(READ_AHA)
    const webEmptySpeed = parseFloat((emptyRead.formulas.find((f) => f.includes('Aha Speed')) ?? '').match(/=([\d.]+)SPD/)?.[1] ?? 'NaN')
    record(
      'calculators.aha.compute', 3,
      '不传队友时返回基础值 80',
      'browser-parity',
      closeEnough(webEmptySpeed, 80) && ahaEmpty.ahaSpeed === 80 ? 'PASS' : 'FAIL',
      `四格全空后网页公式=${webEmptySpeed};MCP calc_aha([]).ahaSpeed=${ahaEmpty.ahaSpeed}`,
    )
  })

  // ── aha.form #2: MCP save → export → web loads → panel shows the values ──
  await callTool('load_save', { path: sampleSavePath })
  const savedAha = await callTool('calc_aha', { speeds: [170, 150, 140, 130], desiredAha: 140, save: true })
  const exportPath = `${tempDir}/aha-written.json`
  await callTool('export_save', { path: exportPath })
  const ahaWrittenSeed = readFileSync(exportPath, 'utf8')

  // ── aha.form #1: web-seeded draft → MCP fromSaved ─────────────────────────
  const fromSavedSeed = seedSave({}, undefined, { teammate0: 165, teammate1: 145, teammate2: '', teammate3: '', desiredAha: 130 })
  const fromSavedSavePath = `${tempDir}/aha-fromsaved.json`
  writeFileSync(fromSavedSavePath, fromSavedSeed)
  await callTool('load_save', { path: fromSavedSavePath })
  const fromSaved = await callTool('calc_aha', { fromSaved: true })

  // aha.solve cases via seeded drafts (the solver input lives in the same persisted form)
  const solveSave = `${tempDir}/aha-solve.json`
  writeFileSync(solveSave, solveSeed)
  await callTool('load_save', { path: solveSave })
  const solve110 = await callTool('calc_aha', { fromSaved: true })

  const noSlotsPath = `${tempDir}/aha-noslots.json`
  writeFileSync(noSlotsPath, noSlotsSeed)
  await callTool('load_save', { path: noSlotsPath })
  const solveNoSlots = await callTool('calc_aha', { fromSaved: true })

  const metPath = `${tempDir}/aha-met.json`
  writeFileSync(metPath, metSeed)
  await callTool('load_save', { path: metPath })
  const solveMet = await callTool('calc_aha', { fromSaved: true })

  // one more browser session reading the solve outputs + the written draft
  await browserManager.runTask({ label: 'verify(calculators-2)', seed: solveSeed, timeoutMs: 600_000 }, async (page) => {
    await PAGE_BOOT(page, '#aha', solveSeed)

    // aha.solve #1: 180/135 target 135 → 3rd teammate 110
    const solverHeaders = await page.evaluate(`() => [...document.querySelectorAll('#CALCULATORS h1,h2,h3,h4,h5,h6,[class*=headerText]')]
      .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).slice(-4)`)
    const webSolveValue = parseFloat(await page.evaluate(`() => {
      const outBlocks = [...document.querySelectorAll('#CALCULATORS div')]
        .filter((d) => d.className && String(d.className).includes('reverseOutput'))
      return outBlocks.length ? outBlocks[0].querySelector('span')?.textContent ?? '' : ''
    }`))
    record(
      'calculators.aha.solve', 1,
      '已有队友 180 与 135、目标 135 时返回第三名队友需要 110 速度，与网页端求解器显示的一致',
      'browser-parity',
      solverHeaders.some((h) => h.includes("3rd Teammate's SPD")) && closeEnough(webSolveValue, 110)
        && solve110.solve.status === 'solved' && closeEnough(solve110.solve.requiredSpeed, 110) ? 'PASS' : 'FAIL',
      `网页求解器标题=${JSON.stringify(solverHeaders)} 值=${webSolveValue};MCP calc_aha(fromSaved)=${JSON.stringify(solve110.solve)}`,
    )

    // aha.solve #2: four filled slots → No slots open (seeded draft, same as the MCP side)
  })

  await browserManager.runTask({ label: 'verify(calculators-2b)', seed: noSlotsSeed, timeoutMs: 600_000 }, async (page) => {
    await PAGE_BOOT(page, '#aha', noSlotsSeed)
    const fullHeaders = await page.evaluate(`() => [...document.querySelectorAll('#CALCULATORS h1,h2,h3,h4,h5,h6,[class*=headerText]')]
      .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).slice(-4)`)
    const fullValue = await page.evaluate(`() => {
      const outBlocks = [...document.querySelectorAll('#CALCULATORS div')]
        .filter((d) => d.className && String(d.className).includes('reverseOutput'))
      return outBlocks.length ? outBlocks[0].querySelector('span')?.textContent ?? '' : ''
    }`)
    record(
      'calculators.aha.solve', 2,
      '已填满四名队友时明确返回没有空位，而不是给出一个数',
      'browser-parity',
      fullHeaders.some((h) => h.includes('No slots open')) && (fullValue === '' || fullValue == null)
        && solveNoSlots.solve.status === 'noSlots' && solveNoSlots.solve.requiredSpeed === null ? 'PASS' : 'FAIL',
      `四格填满(180/135/160/150)后网页标题=${JSON.stringify(fullHeaders)} 值="${fullValue}";MCP=${JSON.stringify(solveNoSlots.solve)}`,
    )
  })

  await browserManager.runTask({ label: 'verify(calculators-2c)', seed: metSeed, timeoutMs: 600_000 }, async (page) => {
    await PAGE_BOOT(page, '#aha', metSeed)
    // aha.solve #3: already met (seeded target 129 ≤ current 129.5) — no typing needed
    const metHeaders = await page.evaluate(`() => [...document.querySelectorAll('#CALCULATORS h1,h2,h3,h4,h5,h6,[class*=headerText]')]
      .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).slice(-4)`)
    const metValue = parseFloat(await page.evaluate(`() => {
      const outBlocks = [...document.querySelectorAll('#CALCULATORS div')]
        .filter((d) => d.className && String(d.className).includes('reverseOutput'))
      return (outBlocks.length ? outBlocks[0].querySelector('span')?.textContent ?? '' : '').replace('−', '-')
    }`))
    record(
      'calculators.aha.solve', 3,
      '当前阿哈速度已经不低于目标时标明已满足，数值与网页端一致',
      'browser-parity',
      metHeaders.some((h) => h.includes('SPD target already reached'))
        && solveMet.solve.status === 'alreadyMet' && closeEnough(metValue, solveMet.solve.requiredSpeed) ? 'PASS' : 'FAIL',
      `底稿目标129(当前129.5) 网页标题=${JSON.stringify(metHeaders)} 值=${metValue};MCP=${JSON.stringify(solveMet.solve)}`,
    )
  })

  // ── third browser session: the MCP-written draft + EHR panel ──────────────
  await browserManager.runTask({ label: 'verify(calculators-3)', seed: ahaWrittenSeed, timeoutMs: 600_000 }, async (page) => {
    await PAGE_BOOT(page, '#aha', ahaWrittenSeed)
    const ahaInputs = await page.evaluate(`() => [...document.querySelectorAll('#CALCULATORS input')]
      .filter((el) => el.offsetParent !== null).map((el) => el.value)`)
    const draft = savedAha.draft ?? {}
    const webValues = ahaInputs.slice(0, 5).map((v) => (v === '' ? '' : parseFloat(v)))
    const mcpValues = [draft.teammate0, draft.teammate1, draft.teammate2, draft.teammate3, draft.desiredAha]
    const draftOk = webValues.length === 5 && webValues.every((v, i) => v === mcpValues[i])
    record(
      'calculators.aha.form', 2,
      '写回四个队友速度和目标值后导出存档，网页端载入后面板里显示的就是这组数值',
      'browser-parity',
      draftOk ? 'PASS' : 'FAIL',
      `MCP calc_aha(save=true) 后 export_save → 网页载入:面板输入=[${webValues.join(',')}] vs 写回底稿=[${mcpValues.join(',')}]`,
    )

    // aha.form #1: web-seeded draft → MCP fromSaved agrees with the panel
    const fromSavedInputs = await page.evaluate(HARVEST)
    void fromSavedInputs
  })

  await browserManager.runTask({ label: 'verify(calculators-4)', seed: fromSavedSeed, timeoutMs: 600_000 }, async (page) => {
    await PAGE_BOOT(page, '#aha', fromSavedSeed)
    const inputs = await page.evaluate(`() => [...document.querySelectorAll('#CALCULATORS input')]
      .filter((el) => el.offsetParent !== null).map((el) => el.value)`)
    const formula = await page.evaluate(`() => [...document.querySelectorAll('#CALCULATORS math')]
      .filter((m) => m.offsetParent !== null).map((m) => m.textContent).find((f) => f.includes('Aha Speed')) ?? ''`)
    const webSpeed = parseFloat(formula.match(/=([\d.]+)SPD/)?.[1] ?? 'NaN')
    // MCP side already computed above: fromSaved.ahaSpeed
    const webValues = inputs.slice(0, 5).map((v) => (v === '' ? '' : parseFloat(v)))
    const draftOk = webValues[0] === 165 && webValues[1] === 145 && webValues[2] === '' && webValues[3] === ''
    record(
      'calculators.aha.form', 1,
      '载入网页端导出的存档后，按存档取值计算得到的阿哈速度与网页端打开该面板时显示的一致',
      'browser-parity',
      draftOk && closeEnough(webSpeed, fromSaved.ahaSpeed) ? 'PASS' : 'FAIL',
      `存档底稿(165/145) 网页面板显示=${webSpeed} vs MCP calc_aha(fromSaved)=${fromSaved.ahaSpeed};面板输入=${JSON.stringify(webValues)}`,
    )

    // ═══ EHR panel ═══
    await page.evaluate(`() => { location.hash = '#ehr'; return true }`)
    await sleep(1500)

    // ehr.probability #1: 50/100/40/0/1 → 90
    const ehrFormulas = await page.evaluate(READ_EHR_FORMULAS)
    const prob1Text = ehrFormulas.filter((f) => f.includes('chance')).join(' | ')
    const web90 = parseFloat(prob1Text.match(/([\d.]+)%chance/)?.[1] ?? 'NaN')
    record(
      'calculators.ehr.probability', 1,
      '效果命中 50、基础概率 100、效果抵抗 40、减益抵抗 0、施加 1 次时返回 90，与网页端公式一行的结果一致',
      'browser-parity',
      closeEnough(web90, 90) && closeEnough(ehrProb1.applicationPercent, 90) ? 'PASS' : 'FAIL',
      `网页公式行="${prob1Text}" vs MCP calc_ehr(probability)=perAttempt ${ehrProb1.perAttemptPercent}%/累计 ${ehrProb1.applicationPercent}%`,
    )

    // ehr.probability #3: clamped display when the raw rate exceeds 100
    await page.evaluate(SET_NUMBER_INPUT, ['50%', '250%'])
    await sleep(900)
    const clampFormulas = await page.evaluate(READ_EHR_FORMULAS)
    const clampText = clampFormulas.filter((f) => f.includes('chance')).join(' | ')
    const webClamped = parseFloat(clampText.match(/([\d.]+)%chance/)?.[1] ?? 'NaN')
    record(
      'calculators.ehr.probability', 3,
      '计算结果超过 100 时返回 100',
      'browser-parity',
      closeEnough(webClamped, 100) && closeEnough(ehrClamp.applicationPercent, 100) && ehrClamp.perAttemptProbability > 1 ? 'PASS' : 'FAIL',
      `效果命中 250% 后网页显示="${clampText.slice(0, 60)}";MCP perAttempt原始=${ehrClamp.perAttemptProbability.toFixed(3)}(>1) 显示钳制=${ehrClamp.applicationPercent}`,
    )
    await page.evaluate(SET_NUMBER_INPUT, ['250%', '50%'])
    await sleep(600)

    // ehr.probability #2: attempts 3 → per-attempt + cumulative
    await page.evaluate(SET_NUMBER_INPUT, ['1', '3'])
    await sleep(900)
    const att3Formulas = await page.evaluate(READ_EHR_FORMULAS)
    const att3Text = att3Formulas.filter((f) => f.includes('chance')).join(' | ')
    const perM = att3Text.match(/([\d.]+)%chancePer attempt/)
    const overM = att3Text.match(/([\d.]+)%chanceOver 3 attempts/)
    const webPer = perM ? parseFloat(perM[1]) : NaN
    const webOver = overM ? parseFloat(overM[1]) : NaN
    record(
      'calculators.ehr.probability', 2,
      '施加次数改为 3 时同时返回单次概率和三次内至少成功一次的概率，与网页端两个数值一致',
      'browser-parity',
      closeEnough(webPer, 90) && closeEnough(webOver, 99.9)
        && closeEnough(ehrProb3.perAttemptPercent, 90) && closeEnough(ehrProb3.applicationPercent, 99.9) ? 'PASS' : 'FAIL',
      `网页="${att3Text}" (90/99.9);MCP=单次${ehrProb3.perAttemptPercent}%/累计${ehrProb3.applicationPercent}%`,
    )

    // ehr.grid #1: default range 50 → 21 rows 100→0, every cell
    await page.evaluate(SET_NUMBER_INPUT, ['3', '1'])
    await sleep(900)
    const gridWeb = await page.evaluate(READ_EHR_GRID)
    const gridMcp = ehrGridDefault.grid
    const rowsOk = gridWeb.rows.length === 21 && gridMcp.rows.length === 21
      && gridWeb.rows[0].ehr === 100 && gridWeb.rows[20].ehr === 0
    let cellMismatch = null
    if (rowsOk) {
      for (let r = 0; r < 21 && !cellMismatch; r++) {
        for (let c = 0; c < 9; c++) {
          if (gridWeb.rows[r].cells[c] !== gridMcp.rows[r].cells[c].rate) {
            cellMismatch = `cell[${r}][${c}] web=${gridWeb.rows[r].cells[c]} mcp=${gridMcp.rows[r].cells[c].rate}`
            break
          }
        }
      }
    }
    record(
      'calculators.ehr.grid', 1,
      '默认输入、范围 50 时返回 21 行乘 9 列，行从 100 降到 0，各格数值与网页端表格逐格一致',
      'browser-parity',
      rowsOk && cellMismatch == null ? 'PASS' : 'FAIL',
      `网页 ${gridWeb.rows.length} 行(${gridWeb.rows[0]?.ehr}→${gridWeb.rows[20]?.ehr}) × 9 列 vs MCP ${gridMcp.rows.length} 行(${gridMcp.windowMax}→${gridMcp.windowMin});逐格比对${cellMismatch ?? '全部一致'}`,
    )

    // ehr.grid #2: EHR 52 → center row 50 + current-column marker on 40
    await page.evaluate(SET_NUMBER_INPUT, ['50%', '52%'])
    await sleep(900)
    const grid52 = await page.evaluate(READ_EHR_GRID)
    const currentRow = grid52.rows.find((r) => r.isCurrentRow)
    record(
      'calculators.ehr.grid', 2,
      '效果命中 52 时中心行是 50，效果抵抗 40 所在列被标为当前列',
      'browser-parity',
      currentRow?.ehr === 50 && grid52.resGuideIndex === 4 && ehrGridDefault.grid.centerEhr === 50 && ehrGridDefault.grid.nearestRes === 40 ? 'PASS' : 'FAIL',
      `EHR 52 后网页当前行=${currentRow?.ehr}(带EHR标线),当前列下标=${grid52.resGuideIndex}(第${(grid52.resGuideIndex ?? -1) + 1}列=40%);MCP mode=grid centerEhr=50 nearestRes=40`,
    )
    await page.evaluate(SET_NUMBER_INPUT, ['52%', '50%'])
    await sleep(600)

    // ehr.grid #3: range 10 → center ±2 rows only
    const rangeClicked = await page.evaluate(CLICK_SELECT_OPTION, ['± 50% EHR', ''])
    const picked10 = await page.evaluate(CLICK_OPEN_OPTION, ['± 10% EHR'])
    await sleep(900)
    const grid10 = await page.evaluate(READ_EHR_GRID)
    const grid10Mcp = await callTool('calc_ehr', {
      mode: 'grid', effectRes: 40, debuffRes: 0, baseChance: 100, attempts: 1, effectHitRate: 50, desiredHitRate: 100, windowHalf: 10,
    })
    const range10Ok = grid10.rows.length === 5 && grid10.rows[0].ehr === 60 && grid10.rows[4].ehr === 40
      && grid10Mcp.grid.rows.length === 5 && grid10Mcp.grid.windowMin === 40 && grid10Mcp.grid.windowMax === 60
    record(
      'calculators.ehr.grid', 3,
      '范围改为 10 时只返回中心行上下各两档',
      'browser-parity',
      range10Ok && rangeClicked === 'clicked' && picked10 === 'picked' ? 'PASS' : 'FAIL',
      `网页范围10后 ${grid10.rows.length} 行(${grid10.rows.map((r) => r.ehr).join(',')});MCP windowHalf=10 → ${grid10Mcp.grid.rows.length} 行(${grid10Mcp.grid.windowMax}→${grid10Mcp.grid.windowMin});交互=${rangeClicked}/${picked10}`,
    )

    // ehr.solve #1: res 20 → 25 (switch the effect-res select to 20%)
    const resClicked = await page.evaluate(CLICK_SELECT_OPTION, ['40%', ''])
    const resPicked = await page.evaluate(CLICK_OPEN_OPTION, ['20%'])
    await sleep(900)
    const ehrSolveWeb = await page.evaluate(READ_SOLVER, ['Required EHR'])
    const webRequired = parseFloat((ehrSolveWeb?.value ?? '').replace('%', ''))
    record(
      'calculators.ehr.solve', 1,
      '效果抵抗 20、基础概率 100、施加 1 次、目标 100 时返回 25，与网页端求解器一致',
      'browser-parity',
      resClicked === 'clicked' && resPicked === 'picked' && closeEnough(webRequired, 25) && closeEnough(ehrSolve25.requiredEhr, 25) ? 'PASS' : 'FAIL',
      `网页求解器="${ehrSolveWeb?.value}"(下拉切到20%:${resPicked});MCP calc_ehr=${ehrSolve25.requiredEhr}`,
    )

    // ehr.solve #2: attempts 2.4 ≡ 2
    await page.evaluate(SET_NUMBER_INPUT, ['1', '2.4'])
    await sleep(900)
    const solve24 = await page.evaluate(READ_SOLVER, ['Required EHR'])
    const web24 = parseFloat((solve24?.value ?? '').replace('%', ''))
    await page.evaluate(SET_NUMBER_INPUT, ['2.4', '2'])
    await sleep(900)
    const solve2 = await page.evaluate(READ_SOLVER, ['Required EHR'])
    const web2 = parseFloat((solve2?.value ?? '').replace('%', ''))
    record(
      'calculators.ehr.solve', 2,
      '施加次数 2.4 与 2 的结果相同',
      'browser-parity',
      closeEnough(web24, web2) && closeEnough(ehrSolve24.requiredEhr, ehrSolve2.requiredEhr)
        && ehrSolve24.attemptsUsed === 2 ? 'PASS' : 'FAIL',
      `网页 attempts=2.4→${web24}% vs =2→${web2}%;MCP 2.4→${ehrSolve24.requiredEhr}(attemptsUsed=${ehrSolve24.attemptsUsed}) vs 2→${ehrSolve2.requiredEhr}`,
    )

    // ehr.solve #3: debuffRes 100 → unreachable with reason, not 0
    const drClicked = await page.evaluate(CLICK_SELECT_OPTION, ['0%', ''])
    const drPicked = await page.evaluate(CLICK_OPEN_OPTION, ['100%'])
    await sleep(900)
    const solveUnreachable = await page.evaluate(READ_SOLVER, ['Required EHR'])
    const webUnreachable = solveUnreachable?.value ?? '(missing)'
    record(
      'calculators.ehr.solve', 3,
      '减益抵抗 100 时返回不可达和原因，而不是 0',
      'browser-parity',
      drClicked === 'clicked' && drPicked === 'picked' && webUnreachable.trim() === ''
        && ehrUnreachable.achievable === false && ehrUnreachable.requiredEhr === null
        && ehrUnreachable.reasons.some((r) => r.includes('减益抵抗')) ? 'PASS' : 'FAIL',
      `网页减益抵抗100%后求解器值="${webUnreachable}"(空,非0);MCP achievable=false requiredEhr=null reasons=${JSON.stringify(ehrUnreachable.reasons)}`,
    )
  })
} catch (e) {
  console.error('verify-calculators: harness error', e)
  process.exitCode = 1
} finally {
  try {
    await client.close()
  } catch { /* already closed */ }
  try {
    await browserManager.close()
  } catch { /* browser already down */ }
  rmSync(tempDir, { recursive: true, force: true })
}

// ── evidence file ────────────────────────────────────────────────────────────
writeFileSync(evidencePath, JSON.stringify({
  area: 'calculators',
  generatedAt: GENERATED_AT,
  gitCommit: GIT_COMMIT,
  cases,
}, null, 2) + '\n')

const failed = cases.filter((c) => c.result !== 'PASS').length
console.log(failed === 0 ? `\nverify-calculators: ALL ${cases.length} CASES PASSED` : `\nverify-calculators: ${failed} OF ${cases.length} CASES FAILED/UNPROVEN`)
process.exit(failed === 0 ? 0 : 1)
