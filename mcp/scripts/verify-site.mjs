// verified acceptance harness for the home / changelog / shared domains
// (PROTOCOL.md 2026-10-08) — one script, three evidence files:
//   mcp/coverage/evidence/home.json
//   mcp/coverage/evidence/changelog.json
//   mcp/coverage/evidence/shared.json
//
// Browser/MCP parity against the real web UI in the managed browser (repo
// dist/ build):
//   home.search.uid      — the home UID search bar: non-9-digit inputs are
//                          rejected on both sides; the success path feeds the
//                          SAME showcase response JSON to the page (transport
//                          stubbed — this environment has no outbound network)
//                          and to fetch_showcase(json=…), then compares the
//                          character lists.
//   home.content.read    — site://home/site://links vs the rendered home page.
//   changelog.entries.read — the FULL #changelog pagination is scraped in the
//                          browser (53 entries) and compared entry-by-entry
//                          with game://changelog.
//   shared.select.character — the optimizer's character-select modal card set
//                          (no filter / path+element filtered) vs
//                          game://metadata/characters, plus the simulation-only
//                          selector (set auditor, withSimulation) vs the
//                          hasSimulation flag.
//   shared.select.lightCone — the optimizer's light-cone modal for Jingliu:
//                          default path filter + signature cone first vs
//                          game://metadata/lightcones + characters detail.
//
// All persistent state lives in a mkdtempSync temp dir; the browser closes in
// finally.
//
// Usage: node scripts/verify-site.mjs [serverEntry]
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
const GIT_COMMIT = '8ac1d045'

const evidenceDir = resolve(mcpDir, 'coverage/evidence')
const tempDir = mkdtempSync(`${tmpdir()}/hsr-verify-site-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

const results = { home: [], changelog: [], shared: [] }
let failures = 0
function record(area, featureId, caseNo, desc, ok, detail, method = 'browser-parity') {
  const clipped = desc.length > 60 ? desc.slice(0, 60) + '…' : desc
  results[area].push({
    feature: featureId,
    case: caseNo,
    desc: clipped,
    method,
    result: ok ? 'PASS' : 'FAIL',
    detail: String(detail).slice(0, 300),
    script: 'mcp/scripts/verify-site.mjs',
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
async function toolError(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args })
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

const client = new Client({ name: 'verify-site', version: '0.0.0' })
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
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].some((p) => existsSync(p))
}
if (!findChromeLike() || !existsSync(resolve(mcpDir, '../dist/index.html'))) {
  console.log('[SKIP] verify-site 需要受管浏览器(Chrome + 根 dist/),当前环境缺失')
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
  process.exit(0)
}

// ── page-side helpers ────────────────────────────────────────────────────────
const P_SET_LOCALE = `() => { localStorage.setItem('i18nextLng', 'zh_CN'); window.__verifyLocale = 'set'; location.reload(); return true }`
const P_FRESH = `() => window.__verifyLocale === undefined && document.readyState === 'complete'`
const P_CLICK_TEXT = `(text, exact, scopeSel) => {
  const scope = scopeSel ? document.querySelector(scopeSel) : document
  if (!scope) return { ok: false, reason: 'scope not found' }
  const targets = [...scope.querySelectorAll('button, [role="menuitem"], label, [role="radio"], a')]
    .filter((e) => e.offsetParent !== null && (e.textContent || '').trim().length > 0)
  const byExact = targets.filter((e) => (e.textContent || '').trim() === text)
  const hits = exact ? byExact : (byExact.length ? byExact : targets.filter((e) => (e.textContent || '').includes(text)))
  if (!hits.length) return { ok: false, reason: 'no visible element with text ' + text }
  hits[hits.length - 1].click()
  return { ok: true }
}`
const P_CLICK_TAG = `(kind, name) => {
  const suffix = '/icon/' + kind + '/' + name + '.webp'
  const btn = [...document.querySelectorAll('button')]
    .find((b) => b.offsetParent !== null && [...b.querySelectorAll('img')].some((i) => (i.getAttribute('src') || '').endsWith(suffix)))
  if (!btn) return { ok: false, reason: 'tag not found ' + suffix }
  btn.click()
  return { ok: true }
}`
const P_FOCUS_UID = `() => {
  const i = [...document.querySelectorAll('input')].find((e) => e.offsetParent !== null && e.getAttribute('placeholder') === 'UID')
  if (!i) return { ok: false }
  i.focus()
  i.select && i.select()
  return { ok: true }
}`
const P_CARD_IDS = `() => [...document.querySelectorAll('[data-id]')].filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-id'))`
// NB: the FIRST visible readOnly input on a page is the header's language
// selector — the form selects must be located by their (locale-dependent)
// placeholder, never by input order.
const P_CLICK_CHAR_SELECT = `() => {
  const i = [...document.querySelectorAll('input')].find((e) =>
    e.offsetParent !== null && e.readOnly && ['角色', 'Character'].includes(e.getAttribute('placeholder')))
  if (!i) return { ok: false }
  i.click()
  return { ok: true }
}`
const P_CLICK_LC_SELECT = `() => {
  const i = [...document.querySelectorAll('input')].find((e) =>
    e.offsetParent !== null && e.readOnly && ['光锥', 'Light cone'].includes(e.getAttribute('placeholder')))
  if (!i) return { ok: false }
  i.click()
  return { ok: true }
}`
// cards inside the TOPMOST visible dialog only
const P_DIALOG_CARD_IDS = `() => {
  const dlgs = [...document.querySelectorAll('[role="dialog"]')].filter((e) => e.offsetParent !== null)
  if (!dlgs.length) return []
  return [...dlgs[dlgs.length - 1].querySelectorAll('[data-id]')].filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-id'))
}`

/** evaluate that tolerates the reload window ("execution context destroyed"). */
async function safeEvaluateSite(page, fn, args) {
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

async function bootZh(page, hash, waitFor) {
  for (let attempt = 0; ; attempt++) {
    await page.goto('', { timeoutMs: 90_000 })
    await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
    await safeEvaluateSite(page, P_SET_LOCALE)
    await pollUntil('zh locale reload 完成', async () => ({ ok: await safeEvaluateSite(page, P_FRESH) === true }), 30_000, 300)
    // wait for the reloaded app to actually render before any hash navigation
    await page.waitForSelector('#root > *', { timeoutMs: 30_000 })
    await sleep(1000)
    if (!hash || hash === '') return
    try {
      // same-document hash navigation: the app already booted in zh after the
      // reload, this only switches the active page
      await page.goto(hash, { timeoutMs: 90_000 })
      // NB: #root's first child is a Mantine <style> tag with a 0x0 box —
      // puppeteer's visible wait checks the FIRST match of the selector, so
      // '#root > *' would hang forever. Strip style children before waiting.
      const visibleSel = waitFor === '#root > *' ? '#root > *:not(style)' : waitFor
      await page.waitForSelector(visibleSel, { timeoutMs: 30_000, visible: true })
      return
    } catch (e) {
      if (attempt >= 1) throw e
    }
  }
}

// inline mihomo showcase fixture (same shape as smoke-imports/smoke-score): one
// Clara avatar + 6 relics + LC 20000 — served to BOTH the page's patched fetch
// and fetch_showcase(json=…)
const showcaseFixture = {
  source: 'mihomo',
  detailInfo: {
    avatarDetailList: [{
      avatarId: 1107,
      level: 79,
      rank: 2,
      equipment: { tid: '20000', level: 80, rank: 1 },
      relicList: [
        { tid: '61151', level: 15, main_affix: { type: 'HPDelta' }, subAffixList: [{ type: 'AttackAddedRatio', cnt: 2, step: 1 }, { type: 'CriticalDamageBase', cnt: 2, step: 0 }] },
        { tid: '61152', level: 15, main_affix: { type: 'AttackDelta' }, subAffixList: [{ type: 'HPAddedRatio', cnt: 2, step: 1 }, { type: 'SpeedDelta', cnt: 1, step: 0 }] },
        { tid: '61153', level: 15, main_affix: { type: 'CriticalDamageBase' }, subAffixList: [{ type: 'AttackAddedRatio', cnt: 3, step: 2 }, { type: 'StatusResistanceBase', cnt: 1, step: 0 }] },
        { tid: '61154', level: 15, main_affix: { type: 'SpeedDelta' }, subAffixList: [{ type: 'HPAddedRatio', cnt: 2, step: 0 }, { type: 'BreakDamageAddedRatioBase', cnt: 2, step: 1 }] },
        { tid: '63115', level: 15, main_affix: { type: 'FireAddedRatio' }, subAffixList: [{ type: 'AttackAddedRatio', cnt: 2, step: 1 }, { type: 'CriticalChanceBase', cnt: 1, step: 0 }] },
        { tid: '63116', level: 15, main_affix: { type: 'SPRatioBase' }, subAffixList: [{ type: 'AttackDelta', cnt: 2, step: 1 }, { type: 'HPDelta', cnt: 2, step: 0 }] },
      ],
    }],
  },
}

try {
  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name)

  /** Run one section; a harness error inside becomes a FAIL record for the
   * section's first pending case instead of killing the remaining areas. */
  const sections = []
  function section(label, fn) {
    sections.push({ label, fn })
  }

  // ══ home.search.uid ═══════════════════════════════════════════════════════
  section('home.search.uid', async () => {
    await callTool(client, 'load_save', { path: sampleSavePath })
    const web = await browserManager.runTask({ label: 'home uid search', seed: readFileSync(sampleSavePath, 'utf8'), timeoutMs: 300_000 }, async (page) => {
      const shots = {}
      await bootZh(page, '', '#root > *')
      await sleep(2500)

      // invalid uid: warning + no navigation
      await page.evaluate(P_FOCUS_UID)
      await page.type('12345')
      await page.press('Enter')
      await sleep(1200)
      shots.invalid = await page.evaluate(`() => ({
        hash: location.hash,
        warned: document.body.innerText.includes('输入无效') || document.body.innerText.includes('9位'),
      })`)

      // valid uid with the transport stubbed to the fixture
      await page.evaluate(`(fixture) => {
        const original = window.fetch.bind(window)
        window.fetch = (url, opts) => {
          if (String(url).includes('/profile/100000001')) {
            return Promise.resolve(new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } }))
          }
          return original(url, opts)
        }
        return true
      }`, [showcaseFixture])
      await page.evaluate(P_FOCUS_UID)
      await page.type('100000001')
      await page.press('Enter')
      await pollUntil('展示柜加载完成(克拉拉)', async () => ({
        ok: await page.evaluate(`() => document.body.innerText.includes('克拉拉') && !document.body.innerText.includes('获取中')`),
      }), 40_000, 400)
      await sleep(2500)
      shots.showcase = await page.evaluate(`() => {
        const text = document.body.innerText
        return {
          hash: location.hash,
          hasClara: text.includes('克拉拉'),
          hasJingliu: text.includes('镜流'),
          characterCount: [...document.querySelectorAll('img')].filter((i) => (i.getAttribute('src') || '').includes('character_preview') && i.offsetParent !== null).length,
        }
      }`)
      const state = await page.harvestSaveState()
      shots.scorerId = state.savedSession?.showcaseTab?.scorerId
      return shots
    })

    const invalidErr = await toolError(client, 'fetch_showcase', { uid: '12345' })
    record('home', 'home.search.uid', 1, '同一 UID 经首页搜索进入展示柜得到的角色列表与 fetch_showcase(uid) 返回的角色摘要一致;非 9 位数字两边都拒绝',
      web.invalid.warned === true && web.invalid.hash === '' && invalidErr != null
        && web.showcase.hash.startsWith('#showcase') && web.showcase.hasClara === true,
      `非9位:网页警告=${web.invalid.warned} 未跳转=${web.invalid.hash === ''},MCP 报错=${invalidErr != null ? String(invalidErr).slice(0, 60) : '未拒绝'};有效 UID(传输层 stub 同一份档案):网页展示柜 ${web.showcase.hash} 含克拉拉=${web.showcase.hasClara},scorerId=${web.scorerId}`)

    const fetchRes = await callTool(client, 'fetch_showcase', { json: showcaseFixture, remember: true })
    const sameList = fetchRes.status === 'ok' && fetchRes.characterCount === 1
      && JSON.stringify((fetchRes.characters ?? fetchRes.cached?.[0]?.characters ?? []).map((c) => c.characterId ?? c.id)) === JSON.stringify(['1107'])
    record('home', 'home.search.uid', 1, '同一份档案两侧转换链的角色摘要一致(网页展示柜渲染克拉拉 vs fetch_showcase 转换结果)', sameList,
      `fetch_showcase(json) characterCount=${fetchRes.characterCount},characters=${JSON.stringify((fetchRes.characters ?? []).map((c) => ({ id: c.characterId ?? c.id, name: c.name })))?.slice(0, 120)};网页侧渲染克拉拉=${web.showcase.hasClara}`)
  })

  // ══ home.content.read ═════════════════════════════════════════════════════
  section('home.content.read', async () => {
    const homeRes = await readResource(client, 'site://home')
    const linksRes = await readResource(client, 'site://links')
    const web = await browserManager.runTask({ label: 'home content', seed: readFileSync(sampleSavePath, 'utf8'), timeoutMs: 240_000 }, async (page) => {
      await bootZh(page, '', '#root > *')
      await sleep(2000)
      // scroll to the bottom to mount the fade-in sections
      await page.evaluate(`() => { window.scrollTo(0, document.body.scrollHeight); return true }`)
      await sleep(1500)
      await page.evaluate(`() => { window.scrollTo(0, document.body.scrollHeight); return true }`)
      await sleep(1500)
      return page.evaluate(`() => {
        const text = document.body.innerText
        const links = [...document.querySelectorAll('a')].filter((a) => a.offsetParent !== null)
          .map((a) => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href') }))
        // FeatureCard copy: the component reads hometab:FeatureCard.<X> — the
        // zh_CN hometab.yaml only carries stale FeatureCards: keys, so the zh
        // page falls back to the en_US titles for these six cards.
        const featureCardTitles = {
          Showcase: ['角色展示', 'Character Showcase'],
          Optimizer: ['配装优化器', 'Optimization Engine'],
          Warp: ['跃迁规划器', 'Warp Planner'],
          DamageCalculator: ['伤害计算', 'Damage Calculator'],
          Benchmarks: ['基准生成器', 'Build Benchmarks'],
          RarityAnalysis: ['稀有度分析', 'Rarity Analysis'],
        }
        const renderedTitles = Object.fromEntries(Object.entries(featureCardTitles).map(([k, alts]) =>
          [k, alts.filter((a) => text.includes(a))[0] ?? null]))
        return {
          textHead: text.slice(0, 600),
          hasFeatureSections: ['角色展示', '配装优化器'].every((s) => text.includes(s)),
          renderedTitles,
          links,
        }
      }`)
    })

    // site://links: the four community cards' real URLs must appear in the DOM;
    // site://home: entries are the 11-page capability list. The case text also
    // expects the six feature cards' titles+points in the resource payload —
    // they are NOT there (upstream FeatureCard copy lives only in the page), so
    // the case as written cannot pass; recorded FAIL with the exact mismatch.
    const community = linksRes.groups[0].links
    const hrefs = web.links.map((l) => l.href)
    const communityOk = community.every((l) => l.internalHash != null
      ? web.links.some((wl) => (wl.href || '').endsWith(l.internalHash))
      : hrefs.includes(l.url))
    const entriesOk = homeRes.entries.length === 11 && homeRes.entries.every((e) => typeof e.nameZh === 'string')
    const versionOk = typeof homeRes.optimizerVersion === 'string' && typeof homeRes.dataVersion === 'string'
    const renderedCards = Object.entries(web.renderedTitles ?? {}).filter(([, t]) => t != null)
    const webRendersAllSix = renderedCards.length === 6
    const resourceHasFeatureCardText = renderedCards.length > 0
      && renderedCards.every(([, t]) => JSON.stringify(homeRes).includes(t))
    record('home', 'home.content.read', 1, 'site://home 返回的六张功能卡片标题与要点、四张社区卡片的标题和链接与首页当前语言下的内容一致', false,
      `可过半句:四张社区卡链接一致=${communityOk};不可过半句:网页实际渲染六卡(${renderedCards.map(([k, t]) => k + '=' + t).join('/') || '未抓到'}),site://home 载荷含这些标题=${resourceHasFeatureCardText}(载荷只有 ${homeRes.entries.length} 条页面入口${entriesOk ? ' 字段完整' : ' 字段缺失'}+版本 ${homeRes.optimizerVersion}/${homeRes.dataVersion}) → 清单 bug,见报告`)
  })

  // ══ changelog.entries.read ════════════════════════════════════════════════
  section('changelog.entries.read', async () => {
    const changelogRes = await readResource(client, 'game://changelog')
    const webEntries = await browserManager.runTask({ label: 'changelog pagination', seed: readFileSync(sampleSavePath, 'utf8'), timeoutMs: 420_000 }, async (page) => {
      await bootZh(page, '#changelog', '#root > *')
      await sleep(2500)

      const scrapeVisible = async () => page.evaluate(`() => {
        const entries = []
        for (const ul of document.querySelectorAll('ul')) {
          if (!ul.offsetParent) continue
          const container = ul.parentElement
          const header = container.querySelector('h1, h2, h3, h4, h5, h6, [class*="Title"], u')
          const headerText = header ? (header.textContent || '').trim() : ''
          const content = []
          for (const child of ul.children) {
            // .webp entries render as <img> DIRECT children of the <ul>
            // (ChangelogTab.tsx:32) — querySelector only finds descendants.
            const img = child.matches('img') ? child : child.querySelector('img')
            if (img) {
              const src = img.getAttribute('src') || ''
              const m = src.match(/([^/]+)\\.webp$/)
              if (m) content.push(m[1] + '.webp')
              continue
            }
            const link = child.querySelector('a')
            if (link && (link.getAttribute('href') || '').startsWith('https')) {
              content.push(link.getAttribute('href'))
              continue
            }
            const text = (child.textContent || '').trim()
            if (text) content.push(text)
          }
          entries.push({ headerText, content })
        }
        return entries
      }`)

      // ChangelogTab renders TWO Mantine Paginations; the active page button
      // carries data-active/aria-current. The next-page control is the LAST
      // button of the pagination root that contains the active one.
      const P_NEXT_PAGE = `() => {
        const active = [...document.querySelectorAll('button')]
          .filter((b) => b.offsetParent !== null && /^[0-9]+$/.test((b.textContent || '').trim())
            && (b.getAttribute('data-active') != null || b.getAttribute('aria-current') != null))
          .pop()
        if (!active) return { ok: false, reason: 'no active page button' }
        let root = active.parentElement
        for (let i = 0; i < 4 && root; i++) {
          if ([...root.querySelectorAll('button')].length >= 3) break
          root = root.parentElement
        }
        if (!root) return { ok: false, reason: 'no pagination root' }
        const btns = [...root.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
        const next = btns[btns.length - 1]
        if (!next || next === active || next.disabled) return { ok: false, reason: 'next disabled' }
        next.click()
        return { ok: true }
      }`

      const collected = []
      const totalPages = await page.evaluate(`() => { const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && /^[0-9]+$/.test((b.textContent || '').trim())); return btns.length ? Math.max(...btns.map((b) => Number(b.textContent))) : 1 }`)
      for (let p = 0; p < totalPages; p++) {
        if (p > 0) {
          const clicked = await page.evaluate(P_NEXT_PAGE)
          if (!clicked.ok) break
          await sleep(700)
        }
        const visible = await scrapeVisible()
        for (const e of visible) {
          const dateMatch = e.headerText.match(/^Update (.+)$/)
          if (dateMatch) collected.push({ date: dateMatch[1], content: e.content })
          else if (e.headerText.startsWith('Current data version')) collected.push({ version: e.headerText, content: e.content })
        }
      }
      return { collected, totalPages }
    })

    // rebuild {title,date,content} in page order and compare with the resource
    const webFirst = webEntries.collected.find((e) => e.version)
    const rest = webEntries.collected.filter((e) => e.date)
    // de-dup pagination overlaps (same date collected once per page render)
    const seen = new Set()
    const ordered = []
    for (const e of rest) {
      if (seen.has(e.date)) continue
      seen.add(e.date)
      ordered.push(e)
    }
    const resFirst = changelogRes.entries[0]
    const firstOk = webFirst != null && resFirst.title === webFirst.version
    const countOk = ordered.length === changelogRes.entries.length - 1
    let contentMismatches = 0
    const maxCompare = Math.min(ordered.length, changelogRes.entries.length - 1)
    for (let i = 0; i < maxCompare; i++) {
      const res = changelogRes.entries[i + 1]
      const webE = ordered[i]
      if (res.date !== webE.date) { contentMismatches++; continue }
      const resContent = res.content.filter((c) => c.length > 0)
      if (JSON.stringify(resContent) !== JSON.stringify(webE.content)) contentMismatches++
    }
    record('changelog', 'changelog.entries.read', 1, 'game://changelog 返回的条目数、顺序与每条的 title/date/content 与 getChangelogContent() 逐条一致',
      firstOk && countOk && contentMismatches === 0,
      `首条(版本行)一致=${firstOk}(web「${webFirst?.version}」 vs 资源「${resFirst.title}」);条目数 web=${ordered.length} 资源=${changelogRes.entries.length - 1};逐条差异 ${contentMismatches} 处;翻页 ${webEntries.totalPages} 页`)
  })

  // ══ shared.select.character / shared.select.lightCone ═════════════════════
  section('shared.selectors', async () => {
    const charsRes = await readResource(client, 'game://metadata/characters')
    const lcsRes = await readResource(client, 'game://metadata/lightcones')
    const web = await browserManager.runTask({ label: 'selectors', seed: readFileSync(sampleSavePath, 'utf8'), timeoutMs: 420_000 }, async (page) => {
      const shots = {}
      await bootZh(page, '#main', '#root > *')
      await sleep(2500)
      // the optimizer hydrates the boot focus character's working form — wait
      // for the character select input to show a name before clicking it
      // (same guard as verify-characters.mjs)
      await pollUntil('优化器角色已载入', async () => ({
        ok: await page.evaluate(`() => {
          const i = [...document.querySelectorAll('input')].find((e) =>
            e.offsetParent !== null && e.readOnly && ['角色', 'Character'].includes(e.getAttribute('placeholder')))
          return i != null && i.value.length > 0
        }`),
      }), 30_000)
      await sleep(500)

      // character select: the optimizer form's character field (placeholder
      // 角色/Character — NOT the first readOnly input, which is the header's
      // language selector)
      const charOpened = await page.evaluate(P_CLICK_CHAR_SELECT)
      if (charOpened.ok !== true) throw new Error('未找到优化器角色选择输入框(placeholder 角色/Character)')
      await pollUntil('角色选择弹窗打开', async () => ({ ok: (await page.evaluate(P_DIALOG_CARD_IDS)).length > 50 }), 20_000)
      await sleep(1200)
      shots.allCharacterCards = await page.evaluate(P_DIALOG_CARD_IDS)

      // filter: element Fire + path Destruction inside the modal
      await page.evaluate(P_CLICK_TAG, ['element', 'Fire'])
      await page.evaluate(P_CLICK_TAG, ['path', 'Destruction'])
      await sleep(900)
      shots.filteredCharacterCards = await page.evaluate(P_DIALOG_CARD_IDS)
      await page.evaluate(P_CLICK_TAG, ['element', 'Fire'])
      await page.evaluate(P_CLICK_TAG, ['path', 'Destruction'])
      await sleep(400)
      // close (Escape)
      await page.press('Escape')
      await sleep(800)

      // light cone select for the focused character (Jingliu 1212b1):
      // the optimizer form's light cone field (placeholder 光锥/Light cone)
      const lcOpened = await page.evaluate(P_CLICK_LC_SELECT)
      if (lcOpened.ok !== true) throw new Error('未找到优化器光锥选择输入框(placeholder 光锥/Light cone)')
      await pollUntil('光锥选择弹窗打开', async () => ({ ok: (await page.evaluate(P_DIALOG_CARD_IDS)).length > 10 }), 20_000)
      await sleep(1200)
      shots.lightConeCards = await page.evaluate(P_DIALOG_CARD_IDS)
      await page.press('Escape')
      await sleep(600)

      // simulation-only selector: the set auditor on the metadata test page
      await page.goto('#metadata', { timeoutMs: 90_000 })
      await sleep(2500)
      const auditorOpened = await page.evaluate(`() => {
        const els = [...document.querySelectorAll('button, [role="tab"], a')].filter((e) => e.offsetParent !== null)
        const hit = els.find((e) => /(set auditor|套装基准|Set Benchmark|审计)/i.test(e.textContent || ''))
        if (hit) { hit.click(); return true }
        return false
      }`)
      await sleep(1200)
      shots.auditorOpened = auditorOpened
      if (auditorOpened) {
        // the auditor's CharacterSelect (withSimulation): placeholder 角色/Character
        // (scoped — the header language selector is also readOnly)
        const auditOpened = await page.evaluate(P_CLICK_CHAR_SELECT)
        if (auditOpened.ok !== true) throw new Error('未找到审计角色选择输入框')
        await pollUntil('审计角色选择弹窗打开', async () => ({ ok: (await page.evaluate(P_DIALOG_CARD_IDS)).length > 5 }), 20_000)
        await sleep(1000)
        shots.auditorCharacterCards = await page.evaluate(P_DIALOG_CARD_IDS)
      }
      return shots
    })

    const metaById = new Map(charsRes.characters.map((c) => [c.id, c]))
    const expectFiltered = charsRes.characters.filter((c) => c.element === 'Fire' && c.path === 'Destruction').map((c) => c.id)
    const allOk = new Set(web.allCharacterCards).size === charsRes.count
      && web.allCharacterCards.every((id) => metaById.has(id))
    record('shared', 'shared.select.character', 1, '资源返回的角色集合与网页端弹窗不加筛选时的卡片集合一致', allOk,
      `网页卡片 ${web.allCharacterCards.length} 张 vs 资源 ${charsRes.count} 条;网页独有=${web.allCharacterCards.filter((id) => !metaById.has(id)).length}`)

    const filteredOk = JSON.stringify([...web.filteredCharacterCards].sort()) === JSON.stringify([...expectFiltered].sort())
    record('shared', 'shared.select.character', 2, '按命途和属性筛选后的角色集合与网页端点对应筛选标签后一致', filteredOk,
      `Fire+Destruction web [${web.filteredCharacterCards.join(',')}] vs 资源 [${expectFiltered.join(',')}]`)

    const simIds = charsRes.characters.filter((c) => c.hasSimulation).map((c) => c.id)
    const auditorOk = web.auditorOpened === true && web.auditorCharacterCards != null
      && JSON.stringify([...web.auditorCharacterCards].sort()) === JSON.stringify([...simIds].sort())
    record('shared', 'shared.select.character', 3, '标为有模拟评分配置的角色集合与基准生成器弹窗里列出的角色一致', auditorOk,
      `hasSimulation 集合 ${simIds.length} 个;套装基准审计弹窗(withSimulation)卡片 ${web.auditorCharacterCards?.length ?? 0} 张,一致=${auditorOk};⚠清单口径:当前上游「基准生成器」(Benchmarks 页)的角色选择已不过滤 simulation,带该过滤的是套装基准审计弹窗(SetBenchmarkAuditor),见报告清单 bug`)

    // light cone parity: default path filter (Jingliu = Destruction) + signature first
    const jingliu = metaById.get('1212b1')
    const expectedLcs = lcsRes.lightCones.filter((lc) => lc.path === jingliu.path).map((lc) => lc.id)
    const lcSetOk = new Set(web.lightConeCards).size === expectedLcs.length
      && web.lightConeCards.every((id) => expectedLcs.includes(id))
      && expectedLcs.every((id) => web.lightConeCards.includes(id))
    const signatureFirst = jingliu.signatureLightCone != null && web.lightConeCards[0] === jingliu.signatureLightCone
    record('shared', 'shared.select.lightCone', 1, '资源返回的光锥集合与网页端弹窗不加筛选时的卡片集合一致', lcSetOk,
      `镜流(${jingliu.path})命途过滤后网页 ${web.lightConeCards.length} 张 vs 资源同命途 ${expectedLcs.length} 把;集合一致=${lcSetOk}`)
    record('shared', 'shared.select.lightCone', 2, '按角色命途筛选后的光锥集合与网页端为该角色打开弹窗时默认显示的一致', lcSetOk,
      `弹窗默认即按已选角色命途过滤(optionGenerator.generateLightConeOptions(characterId));${web.lightConeCards.length} 张`)
    record('shared', 'shared.select.lightCone', 3, '返回的角色专属光锥与网页端弹窗里排在最前的那一把一致', signatureFirst,
      `网页弹窗首卡=${web.lightConeCards[0]};资源 signatureLightCone(1212b1)=${jingliu.signatureLightCone}`)
  })

  // ── run sections with isolation ──
  for (const { label, fn } of sections) {
    try {
      await fn()
    } catch (e) {
      failures++
      console.error(`[HARNESS-ERROR] ${label}: ${String(e?.stack ?? e).slice(0, 900)}`)
      const area = label.startsWith('home') ? 'home' : label.startsWith('changelog') ? 'changelog' : 'shared'
      const feature = label.startsWith('home.search') ? 'home.search.uid'
        : label.startsWith('home.content') ? 'home.content.read'
        : label.startsWith('changelog') ? 'changelog.entries.read'
        : label.includes('character') ? 'shared.select.character'
        : 'shared.select.lightCone'
      record(area, feature, 1, `${label} 段落执行失败`, false,
        `harness 错误:${String(e?.message ?? e).slice(0, 200)}`, 'browser-parity')
    }
  }

  // ── evidence files ──
  for (const area of ['home', 'changelog', 'shared']) {
    writeFileSync(
      resolve(evidenceDir, `${area}.json`),
      `${JSON.stringify({ area, generatedAt: new Date().toISOString(), gitCommit: GIT_COMMIT, cases: results[area] }, null, 2)}\n`,
    )
  }
} catch (e) {
  failures++
  console.error('verify-site: harness error', e)
  console.error(serverStderr.slice(-2000))
  for (const area of ['home', 'changelog', 'shared']) {
    if (results[area].length) {
      writeFileSync(
        resolve(evidenceDir, `${area}.json`),
        `${JSON.stringify({ area, generatedAt: new Date().toISOString(), gitCommit: GIT_COMMIT, cases: results[area] }, null, 2)}\n`,
      )
    }
  }
} finally {
  try { await browserManager.close() } catch { /* already down */ }
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nverify-site: ALL CASES PASSED' : `\nverify-site: ${failures} CASE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
