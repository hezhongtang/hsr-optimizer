// Browser-parity acceptance verification for the showcase domain
// (mcp/coverage/features/showcase.json, scope=baseline rows).
//
// Method (PROTOCOL.md A): same inputs on both sides —
//   web:   the REAL Showcase (#showcase) tab in the managed headless browser:
//          typing a real UID, the real enka/mihomo proxy fetch, the real
//          avatar row / showcase card / import menu / simulation sidebar;
//   MCP:   fetch_showcase / score_character(source=showcase) /
//          import_showcase / get_state-update_state over stdio;
//   then:  per-case PASS/FAIL into mcp/coverage/evidence/showcase.json.
//
// Real-network cases first probe candidate UIDs through fetch_showcase
// (small timeout, up to 2 attempts each); the winner is used on BOTH sides so
// the comparison is deterministic. If no UID is reachable, the network cases
// are recorded UNPROVEN (external) — never fabricated — while the zero-network
// cases (inline json parsing / dedupe / throttle semantics / state parity)
// still run to completion.
//
// Everything persistent lives in one mkdtempSync temp dir; the managed browser
// is closed in finally; the repo's sample-save.json is read-only.
//
// Usage: node scripts/verify-showcase.mjs [serverEntry]   (default dist/index.js)

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
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const evidencePath = resolve(mcpDir, 'coverage/evidence/showcase.json')

const LONG = { timeout: 240_000 }

// Public showcase UIDs to probe (enka/mihomo-scanned players). The first that
// returns a non-empty profile through fetch_showcase wins; all are retried.
const CANDIDATE_UIDS = ['100159999', '839196736', '618285211', '124600131', '100001426']

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
    script: 'mcp/scripts/verify-showcase.mjs',
  }
  cases.push(entry)
  console.log(`[${result}] ${feature}#${caseNo} — ${entry.detail}`)
  if (result === 'FAIL') failures++
}

// ── SKIP guard ───────────────────────────────────────────────────────────────
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
if (findChrome() == null || findSiteDist() == null) {
  console.log('[SKIP] showcase 验收需要受管浏览器环境(Chrome 与站点 dist/)')
  process.exit(0)
}
const gitCommit = (() => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(mcpDir, '..'), encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
})()

// ── temp workspace ───────────────────────────────────────────────────────────
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-showcase-`)
const baseSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, baseSavePath)
/** A pristine copy per load — load_save write-backs mutate the loaded file. */
let freshCounter = 0
function freshSeed(sourcePath) {
  freshCounter++
  const copy = `${tempDir}/fresh-${freshCounter}.json`
  copyFileSync(sourcePath, copy)
  return copy
}

// ── MCP client boot ──────────────────────────────────────────────────────────
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { getDefaultEnvironment, StdioClientTransport } = await import(
  '@modelcontextprotocol/sdk/client/stdio.js'
)
const client = new Client({ name: 'verify-showcase', version: '0.0.0' })
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
const { pathToFileURL } = await import('node:url')
const { browserManager } = await import(pathToFileURL(resolve(mcpDir, 'src/browser/browserManager.ts')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pollUntil(desc, fn, timeoutMs = 20_000, tickMs = 200) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
    } catch (e) {
      last = { ok: false, detail: `evaluate: ${String(e.message).slice(0, 80)}` }
    }
    if (last && last.ok) return last
    await sleep(tickMs)
  }
  const detail = last && last.detail !== undefined ? ` — ${String(last.detail)}` : ''
  throw new Error(`等待超时(${timeoutMs}ms):${desc}${detail}`)
}

// ── in-page probes ───────────────────────────────────────────────────────────
const SET_LANG = `() => { try { localStorage.setItem('i18nextLng', 'en_US') } catch {}; window.__sc = 1; location.reload(); return true }`
const RELOAD_DONE = `() => window.__sc === undefined && document.readyState === 'complete' && !!document.querySelector('#root > *')`
const UID_INPUT = `() => {
  // zh placeholder is 账号UID (relicScorerTab.SubmissionBar.Placeholder); match any visible input whose placeholder mentions UID
  const input = Array.from(document.querySelectorAll('input')).find((i) => i.offsetParent !== null && /UID/i.test(i.placeholder || ''))
  if (!input) return false
  input.focus()
  return true
}`
const SUBMIT_CLICK = `() => {
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && ['Submit', '提交'].includes((b.textContent || '').trim()))
  if (!buttons.length) return false
  buttons[0].click()
  return true
}`
const AVATAR_ROW = `() => {
  const card = document.getElementById('relicScorerPreview')
  if (!card) return { ready: false }
  // portrait row sits above the card: avatar imgs whose src carries an id
  const imgs = [...document.querySelectorAll('img')]
    .filter((i) => /character_avatar/.test(i.src || '') && i.closest('div[class*="portraitContainer"]'))
  return {
    ready: imgs.length > 0,
    ids: imgs.map((i) => (i.src.match(/character_avatar\\/([^.]+)\\./) || [])[1] ?? i.src),
  }
}`
const CARD_READY_SC = `(id) => {
  const card = document.getElementById('relicScorerPreview')
  if (!card) return { ok: false }
  const portrait = card.querySelector('[data-portrait-inject]')
  const url = (portrait && (portrait.getAttribute('data-portrait-url') || portrait.src)) || ''
  const imgs = Array.from(card.querySelectorAll('img'))
  const pending = imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).length
  return { ok: url.includes('/' + id + '.') && imgs.length > 0, url }
}`
const CARD_TEXT = `() => { const c = document.getElementById('relicScorerPreview'); return c ? c.innerText : '' }`
const SCORE_HEADER_SC = `() => {
  const c = document.getElementById('relicScorerPreview')
  if (!c) return null
  const m = c.innerText.match(/(\\d+(?:\\.\\d+)?)% · (\\S+)/)
  return m ? { percent: m[1], grade: m[2] } : null
}`
const STAT_ROWS_SC = `() => {
  const card = document.getElementById('relicScorerPreview')
  if (!card) return null
  return Array.from(card.querySelectorAll('div[title]')).map((row) => ({
    text: row.innerText.replace(/\\s+/g, ' ').trim(),
    title: row.getAttribute('title') || '',
  })).filter((r) => /\\d/.test(r.text))
}`
const RELIC_SCORES_SC = `() => {
  const card = document.getElementById('relicScorerPreview')
  if (!card) return null
  return Array.from(card.querySelectorAll('[data-testid="relic-preview"]')).map((r) => {
    const m = r.innerText.match(/(\\d+\\.\\d+)\\s*\\(([^)]+)\\)/)
    return { score: m ? m[1] : null, rating: m ? m[2] : null }
  })
}`
const NOTIFICATION_TEXT = `() => [...document.querySelectorAll('[class*="notification"], .mantine-Notification-root')]
  .filter((n) => n.offsetParent !== null)
  .map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim()).join(' | ')`
const SIDEBAR_OPEN = `() => {
  const flask = [...document.querySelectorAll('button')].find((b) => b.querySelector('svg.tabler-icon-flask') && b.offsetParent !== null)
  if (!flask) return null
  const panel = flask.parentElement.querySelector('div[style*="display"]')
  const presets = [...document.querySelectorAll('img')].filter((i) => /character_avatar/.test(i.src || '') && i.closest('button') && i.offsetParent !== null && i.closest('.simSidebarPanel, [class*="simSidebarPanel"]'))
  return { open: presets.length > 0, presets: presets.length }
}`
const PRESET_IDS = `() => [...document.querySelectorAll('img')]
  .filter((i) => /character_avatar/.test(i.src || '') && i.closest('button') && i.offsetParent !== null && (i.closest('[class*="simSidebarPanel"]') != null))
  .map((i) => (i.src.match(/character_avatar\\/([^.]+)\\./) || [])[1] ?? null)`
const CLICK_PRESET = `(index) => {
  const imgs = [...document.querySelectorAll('img')]
    .filter((i) => /character_avatar/.test(i.src || '') && i.closest('button') && i.offsetParent !== null && (i.closest('[class*="simSidebarPanel"]') != null))
  const target = imgs[index]
  if (!target) return false
  target.closest('button').click()
  return true
}`
const TOGGLE_SIDEBAR = `() => {
  const flask = [...document.querySelectorAll('button')].find((b) => b.querySelector('svg.tabler-icon-flask') && b.offsetParent !== null)
  if (!flask) return false
  flask.click()
  return true
}`
const CLICK_MENU_ITEM = `(text) => {
  const items = [...document.querySelectorAll('[role="menuitem"], .mantine-Menu-item')]
    .filter((i) => i.offsetParent !== null && (i.textContent || '').trim() === text)
  if (!items.length) return false
  items[items.length - 1].click()
  return true
}`
const CLICK_IMPORT_MENU = `() => {
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && (b.textContent || '').trim() === 'Import')
  if (!buttons.length) return false
  buttons[buttons.length - 1].click()
  return true
}`
/** Click `targetValue` in the index-th visible control whose values match. */
const SEGMENT_CLICK_IN = `(values, index, targetValue) => {
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

function parseNumber(text) {
  const raw = String(text).replace(/[,%\s]/g, '')
  if (/K$/i.test(raw)) return Number(raw.replace(/K$/i, '')) * 1000
  return Number(raw)
}
function headerPercentClose(webPercent, mcpPercent) {
  const expected = Math.max(0, mcpPercent * 100)
  return Math.abs(webPercent - expected) <= 0.11
}

/** One browser task on a seed. */
async function runSeedTask(label, seedPath, fn, timeoutMs = 600_000) {
  const seed = readFileSync(seedPath, 'utf8')
  return await browserManager.runTask(
    { label, seed, viewport: { width: 2200, height: 1500 }, timeoutMs },
    async (page) => {
      await page.goto('#showcase', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await page.evaluate(SET_LANG)
      await pollUntil('语言固定后重载完成', async () => ({ ok: await page.evaluate(RELOAD_DONE) }), 30_000)
      await sleep(500)
      return await fn(page)
    },
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE A — zero-network cases: inline json parsing (enka + mihomo) + dedupe
// ═════════════════════════════════════════════════════════════════════════════
await callTool('load_save', { path: freshSeed(baseSavePath) })
const claraMihomo = {
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
// enka shape: avatarDetailList with _assist flags; dedupe happens inside the processor
const seeleEnka = {
  source: 'enka',
  detailInfo: {
    avatarDetailList: [
      {
        avatarId: 1102,
        pos: 1,
        _assist: false,
        level: 80,
        rank: 1,
        equipment: { tid: '24001', level: 80, rank: 1 },
        relicList: [
          { tid: '61111', level: 15, main_affix: { type: 'HPDelta' }, subAffixList: [{ type: 'CriticalDamageBase', cnt: 2, step: 1 }] },
        ],
      },
      {
        avatarId: 1212,
        pos: 0,
        _assist: true,
        level: 80,
        rank: 0,
        equipment: { tid: '23015', level: 80, rank: 1 },
        relicList: [],
      },
    ],
  },
}
// mihomo duplicate fixture: the same avatar in an assist slot AND the roster —
// only the first occurrence may survive conversion
const dupMihomo = {
  source: 'mihomo',
  detailInfo: {
    assistAvatarList: [{ avatarId: 1105, level: 70, rank: 1, equipment: { tid: '21007', level: 70, rank: 1 }, relicList: [] }],
    avatarDetailList: [
      { avatarId: 1105, level: 71, rank: 2, equipment: { tid: '21007', level: 71, rank: 2 }, relicList: [] },
      { avatarId: 1003, level: 80, rank: 0, equipment: { tid: '21006', level: 80, rank: 1 }, relicList: [] },
    ],
  },
}
try {
  const m1 = await callTool('fetch_showcase', { json: claraMihomo })
  const m2 = await callTool('fetch_showcase', { json: seeleEnka })
  const m3 = await callTool('fetch_showcase', { json: dupMihomo })
  const parseOk = m1.status === 'ok' && m1.source === 'mihomo' && m1.characterCount === 1
    && m1.characters[0].characterId === '1107' && m1.characters[0].eidolon === 2
    && m1.characters[0].lightCone?.id === '20000' && m1.characters[0].equippedCount === 6
    && m2.status === 'ok' && m2.source === 'enka' && m2.characterCount === 2
    && m2.characters.some((c) => c.characterId === '1102' && c.lightCone?.id === '24001')
    && m2.characters.some((c) => c.characterId === '1212')
  // dedupe: assist Natasha (1105) listed first, roster copy must be dropped
  const dedupeOk = m3.characterCount === 2
    && m3.characters[0].characterId === '1105' && m3.characters[0].eidolon === 1
    && m3.characters[1].characterId === '1003'
  record('showcase.profile.fetch', 2,
    'enka 与 mihomo 两种来源的样例数据都能解析，重复角色只保留第一次出现的',
    parseOk && dedupeOk ? 'PASS' : 'FAIL',
    `mihomo(克拉拉)解析=${m1.status === 'ok'}(E${m1.characters[0]?.eidolon}/LC${m1.characters[0]?.lightCone?.id}/${m1.characters[0]?.equippedCount}件);enka(希儿+卡芙卡)解析=${m2.status === 'ok'}(${m2.characterCount}角色);mihomo 重复档案去重=${dedupeOk}(1105 保留 assist 位 E1 副本,${m3.characterCount}/3)——网页侧同一条 submitForm/process*Data 转换链经真实 UID 拉取在 case1 端到端复核`)
} catch (e) {
  record('showcase.profile.fetch', 2, 'enka 与 mihomo 两种来源的样例数据都能解析，重复角色只保留第一次出现的', 'FAIL', String(e.message).slice(0, 160))
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE B — real-network cases. Probe UIDs, then drive the REAL showcase tab.
// ═════════════════════════════════════════════════════════════════════════════
let liveUid = null
let liveFetch = null
for (const uid of CANDIDATE_UIDS) {
  for (let attempt = 0; attempt < 2 && liveUid == null; attempt++) {
    try {
      const probe = await callTool('fetch_showcase', { uid, timeoutMs: 45_000 })
      if (probe.status === 'ok' && probe.characterCount > 0) {
        liveUid = uid
        break
      }
      console.log(`  uid ${uid} attempt ${attempt}: ${probe.status}/${probe.error?.type ?? probe.characterCount}`)
    } catch (e) {
      console.log(`  uid ${uid} attempt ${attempt}: ${String(e.message).slice(0, 80)}`)
    }
  }
  if (liveUid != null) break
}

if (liveUid == null) {
  const note = `外网拉取不可达(试过 UID ${CANDIDATE_UIDS.join('/')},各 2 次)——如实记 UNPROVEN(external)`
  record('showcase.profile.fetch', 1, '同一 UID 返回的角色列表与网页端头像行及各张展示卡一致', 'UNPROVEN', note)
  record('showcase.profile.fetch', 3, '连续两次拉取之间不足 10 秒时第二次被拒绝并说明还要等多久', 'UNPROVEN', note)
  record('showcase.profile.fetch', 4, '要求记住 UID 后，导出的存档里 savedSession.showcaseTab.scorerId 等于该 UID', 'UNPROVEN', note)
  record('showcase.card.read', 1, '不导入的情况下，对展示柜里某个角色算出的遗器评分、属性汇总与 DPS 评分，与网页端该角色展示卡上的数值一致', 'UNPROVEN', note)
  record('showcase.card.read', 2, '算完之后存档里的角色与遗器没有任何变化', 'UNPROVEN', note)
  record('showcase.simulate.override', 1, '把展示柜里某个角色换成另一个角色与光锥后，算出的属性汇总、遗器评分与 DPS 评分和网页端替换后的展示卡一致', 'UNPROVEN', note)
  record('showcase.simulate.override', 2, '缺角色或缺光锥时被拒绝，原因与网页端的提示对应', 'UNPROVEN', note)
  record('showcase.simulate.override', 3, '计算不改动存档，也不改动缓存里的原始档案', 'UNPROVEN', note)
  record('showcase.import', 1, '三种 mode 导入后的存档分别与网页端点对应菜单项后的存档一致', 'UNPROVEN', note)
  record('showcase.import', 2, '只导入遗器时没有任何角色的装备发生变化', 'UNPROVEN', note)
  record('showcase.import', 3, '重复导入同一份档案不会产生重复遗器', 'UNPROVEN', note)
  record('showcase.sidebar.toggle', 1, '读到的展开状态与网页端一致；改动后网页端重新打开展示柜页按新状态显示', 'UNPROVEN', note)
} else {
  // ── B1. fetch + remember + throttle + card read + simulate (one session) ──
  const mcpLive = await callTool('fetch_showcase', { uid: liveUid, remember: true, timeoutMs: 60_000 })
  const cacheId = mcpLive.cacheId
  const firstChar = mcpLive.characters[0]
  const mcpScoreShowcase = await callTool(
    'score_character',
    { source: 'showcase', characterId: firstChar.characterId, cacheId },
    LONG,
  )
  const beforeSnap = await snapshot()

  await runSeedTask('verify-showcase(live)', freshSeed(baseSavePath), async (page) => {
    // type the UID, submit, wait for the avatar row (real fetch, real parsing)
    try {
      await pollUntil('UID 输入框聚焦', async () => ({ ok: await page.evaluate(UID_INPUT) }), 15_000)
      await page.type(liveUid)
      await sleep(300)
      await pollUntil('提交按钮可点', async () => ({ ok: await page.evaluate(SUBMIT_CLICK) }), 10_000)
      const row = await pollUntil('头像行渲染(真实拉取)', async () => await page.evaluate(AVATAR_ROW), 90_000, 400)
      const webIds = row.ids
      const mcpIds = mcpLive.characters.map((c) => c.characterId)
      const listOk = JSON.stringify(webIds) === JSON.stringify(mcpIds)

      // first character's card: eidolon / light cone / relic count + DPS score
      await sleep(3000)
      await pollUntil('首位角色卡就绪', async () => await page.evaluate(CARD_READY_SC, [firstChar.characterId]), 60_000)
      const cardText = await page.evaluate(CARD_TEXT)
      const eidolonShown = cardText.includes(`E${firstChar.eidolon}`)
      const lcShown = firstChar.lightCone?.name ? cardText.includes(firstChar.lightCone.name.slice(0, 6)) : true
      const relicsShown = (await page.evaluate(RELIC_SCORES_SC)).length === firstChar.equippedCount
      record('showcase.profile.fetch', 1,
        '同一 UID 返回的角色列表（角色、星魂、光锥、叠影、已装备遗器数）与网页端头像行及各张展示卡一致',
        listOk && eidolonShown && lcShown && relicsShown ? 'PASS' : 'FAIL',
        `UID ${liveUid}(${mcpLive.source}):头像行 ${webIds.length} 人与 MCP ${mcpIds.length} 人逐位相等=${listOk};首卡 E${firstChar.eidolon}=${eidolonShown}/光锥=${lcShown}/遗器 ${firstChar.equippedCount} 件=${relicsShown}`)
    } catch (e) {
      record('showcase.profile.fetch', 1, '同一 UID 返回的角色列表与网页端头像行及各张展示卡一致', 'FAIL', String(e.message).slice(0, 160))
    }

    // throttle: a second manual submit within 10s is refused with a countdown
    try {
      await pollUntil('UID 输入框聚焦(节流)', async () => ({ ok: await page.evaluate(UID_INPUT) }), 10_000)
      await pollUntil('提交按钮可点(节流)', async () => ({ ok: await page.evaluate(SUBMIT_CLICK) }), 10_000)
      const notif = await pollUntil('节流提示出现', async () => {
        const text = await page.evaluate(NOTIFICATION_TEXT)
        return { ok: /seconds before retry/i.test(text), text }
      }, 10_000)
      // MCP side: the same second fetch succeeds — the tool deliberately has
      // no throttle (documented in its description); record the deviation.
      const second = await callTool('fetch_showcase', { uid: liveUid, timeoutMs: 60_000 })
      const mcpRefused = second.status === 'error'
      record('showcase.profile.fetch', 3,
        '连续两次拉取之间不足 10 秒时第二次被拒绝并说明还要等多久',
        mcpRefused ? 'PASS' : 'FAIL',
        `网页第二次提交被拒并提示「${notif.text.slice(0, 50)}」;MCP fetch_showcase 无 10 秒节流(工具描述明示「刷新=对同一 UID 再次调用(没有网页端的 10 秒节流)」)——按验收口径记 FAIL(文档化偏差)`)
    } catch (e) {
      record('showcase.profile.fetch', 3, '连续两次拉取之间不足 10 秒时第二次被拒绝并说明还要等多久', 'FAIL', String(e.message).slice(0, 160))
    }

    // remember: scorerId persisted on the web side; MCP remember=true round trip
    try {
      const harvest = await page.harvestSaveState()
      const webScorerId = harvest?.savedSession?.showcaseTab?.scorerId
      const mcpScorerId = (await snapshot()).savedSession?.showcaseTab?.scorerId
      record('showcase.profile.fetch', 4,
        '要求记住 UID 后，导出的存档里 savedSession.showcaseTab.scorerId 等于该 UID',
        webScorerId === liveUid && mcpScorerId === liveUid ? 'PASS' : 'FAIL',
        `web=${webScorerId}(submitForm setScorerId+delayedSave);mcp=${mcpScorerId}(fetch_showcase remember=true)`)
    } catch (e) {
      record('showcase.profile.fetch', 4, '要求记住 UID 后，导出的存档里 savedSession.showcaseTab.scorerId 等于该 UID', 'FAIL', String(e.message).slice(0, 160))
    }

    // sidebar toggle: read state, flip through the real flask button, persist
    try {
      const state0 = await pollUntil('模拟栏状态可读', async () => await page.evaluate(SIDEBAR_OPEN), 10_000)
      await pollUntil('烧瓶按钮可点', async () => ({ ok: await page.evaluate(TOGGLE_SIDEBAR) }), 10_000)
      await sleep(800)
      const state1 = await page.evaluate(SIDEBAR_OPEN)
      const harvest = await page.harvestSaveState()
      const webFlag = harvest?.savedSession?.showcaseTab?.sidebarOpen

      await callTool('load_save', { path: freshSeed(baseSavePath) })
      const sessionBefore = (await callTool('get_state', { section: 'session' })).session
      const mcpBefore = sessionBefore.savedSession.showcaseTab.sidebarOpen
      await callTool('update_state', { section: 'session', patch: { sidebarOpen: false } })
      const mcpAfter = (await callTool('get_state', { section: 'session' })).session.savedSession.showcaseTab.sidebarOpen

      // the web honors a persisted sidebarOpen=false on a fresh load
      const seed2 = `${tempDir}/sidebar-closed.json`
      const j = JSON.parse(readFileSync(baseSavePath, 'utf8'))
      j.savedSession = { ...(j.savedSession ?? {}), showcaseTab: { ...(j.savedSession?.showcaseTab ?? {}), sidebarOpen: false } }
      writeFileSync(seed2, JSON.stringify(j))
      const closed = await runSeedTask('verify-showcase(sidebar-closed)', seed2, async (page2) => {
        await pollUntil('UID 输入框聚焦(收起态)', async () => ({ ok: await page2.evaluate(UID_INPUT) }), 15_000)
        await page2.type(liveUid)
        await pollUntil('提交按钮可点(收起态)', async () => ({ ok: await page2.evaluate(SUBMIT_CLICK) }), 10_000)
        await pollUntil('头像行渲染(收起态)', async () => await page2.evaluate(AVATAR_ROW), 90_000, 400)
        await sleep(2000)
        return await page2.evaluate(SIDEBAR_OPEN)
      })
      record('showcase.sidebar.toggle', 1,
        '读到的展开状态与网页端一致；改动后网页端重新打开展示柜页按新状态显示',
        state0.open === mcpBefore && state1.open === false && webFlag === false && mcpAfter === false && closed.open === false ? 'PASS' : 'FAIL',
        `默认 web=${state0.open}/mcp=${mcpBefore};网页点烧瓶后=${state1.open}(存档 sidebarOpen=${webFlag});MCP 写 sidebarOpen=false→${mcpAfter};带该存档重开页面模拟栏收起=${closed.open === false}`)
    } catch (e) {
      record('showcase.sidebar.toggle', 1, '读到的展开状态与网页端一致；改动后网页端重新打开展示柜页按新状态显示', 'FAIL', String(e.message).slice(0, 160))
    }

    // reopen the simulation sidebar (later cases click its presets)
    try {
      await pollUntil('烧瓶按钮可点(重开)', async () => ({ ok: await page.evaluate(TOGGLE_SIDEBAR) }), 10_000)
      await sleep(800)
      await pollUntil('模拟栏已重开', async () => ({ ok: (await page.evaluate(SIDEBAR_OPEN)).open === true }), 10_000)
    } catch { /* preset clicks poll on their own */ }

    // UID display switch (preview.customize.display's fourth key — this
    // control only exists on the showcase tab)
    try {
      const before = await page.harvestSaveState()
      const webBefore = before?.savedSession?.global?.showcaseUID
      await pollUntil('Show UID 分段可点', async () => ({ ok: await page.evaluate(SEGMENT_CLICK_IN, [['true', 'false'], 0, 'false']) }), 10_000)
      await sleep(1000)
      const harvest = await page.harvestSaveState()
      const webAfter = harvest?.savedSession?.global?.showcaseUID
      await callTool('load_save', { path: freshSeed(baseSavePath) })
      await callTool('update_state', { section: 'session', patch: { showcaseUID: false } })
      const mcpAfter = (await callTool('get_state', { section: 'session' })).session.savedSession.global.showcaseUID
      record('preview.customize.display', 2,
        '（展示柜页的 UID 开关）改动后两边存档的 savedSession.global.showcaseUID 一致',
        webBefore === true && webAfter === false && mcpAfter === false ? 'PASS' : 'FAIL',
        `web ${webBefore}→${webAfter}(展示柜页 Show UID 控件);mcp=${mcpAfter}——与 verify-preview 的 preview.customize.display#1 三键对拍合并覆盖四个开关`)
    } catch (e) {
      record('preview.customize.display', 2, '（展示柜页的 UID 开关）改动后两边存档的 savedSession.global.showcaseUID 一致', 'FAIL', String(e.message).slice(0, 140))
    }

    // card read: score + stats parity without importing
    try {
      const header = await pollUntil('展示柜卡评分头', async () => await page.evaluate(SCORE_HEADER_SC), 150_000, 400)
      const webPercent = parseNumber(header.percent)
      const rows = await page.evaluate(STAT_ROWS_SC)
      const basic = mcpScoreShowcase.builds.original.stats.basic
      const basicKeys = Object.keys(basic)
      const FLAT = new Set(['HP', 'ATK', 'DEF', 'SPD'])
      let matched = 0
      let compared = 0
      for (const row of rows) {
        if (row.text.startsWith('Combo DMG')) continue
        const label = row.text.replace(/\s*[-\d.,]+K?%?\s*$/, '').trim()
        const key = basicKeys.find((k) => k === label || (label.endsWith('DMG') && k === `${label} Boost`))
        const raw = key != null ? basic[key] : undefined
        if (raw == null) continue
        compared++
        const expected = FLAT.has(label) ? raw : raw * 100
        if (Math.abs(parseNumber(row.title) - expected) <= 0.05) matched++
      }
      const relicsWeb2 = await page.evaluate(RELIC_SCORES_SC)
      const statOk = compared >= 6 && matched === compared
      const scoreOk = headerPercentClose(webPercent, mcpScoreShowcase.percent) && header.grade === mcpScoreShowcase.grade
      record('showcase.card.read', 1,
        '不导入的情况下，对展示柜里某个角色算出的遗器评分、属性汇总与 DPS 评分，与网页端该角色展示卡上的数值一致',
        statOk && scoreOk ? 'PASS' : 'FAIL',
        `${firstChar.characterId}:DPS 评分 web ${webPercent}%·${header.grade} vs mcp ${(mcpScoreShowcase.percent * 100).toFixed(1)}%·${mcpScoreShowcase.grade};面板 ${matched}/${compared} 项一致;逐件遗器评分 ${relicsWeb2.length} 件与导入后 score_relics 对拍见 showcase.import#1 同批数据`)
    } catch (e) {
      record('showcase.card.read', 1, '不导入的情况下，对展示柜里某个角色算出的遗器评分、属性汇总与 DPS 评分与网页一致', 'FAIL', String(e.message).slice(0, 160))
    }

    // card read case 2: scoring never touches the save (web side harvest)
    try {
      const harvest = await page.harvestSaveState()
      const charsSame = JSON.stringify((harvest?.characters ?? []).map((c) => c.id)) === JSON.stringify((beforeSnap.characters ?? []).map((c) => c.id))
      const relicsSame = (harvest?.relics ?? []).length === (beforeSnap.relics ?? []).length
      const mcpAfterScore = await snapshot()
      const mcpSame = JSON.stringify(mcpAfterScore.relics) === JSON.stringify(beforeSnap.relics)
        && JSON.stringify(mcpAfterScore.characters) === JSON.stringify(beforeSnap.characters)
      record('showcase.card.read', 2,
        '算完之后存档里的角色与遗器没有任何变化',
        charsSame && relicsSame && mcpSame ? 'PASS' : 'FAIL',
        `MCP score_character(showcase) 前后存档完全相等=${mcpSame};网页评分渲染后角色列表不变=${charsSame}、遗器数不变=${relicsSame}`)
    } catch (e) {
      record('showcase.card.read', 2, '算完之后存档里的角色与遗器没有任何变化', 'FAIL', String(e.message).slice(0, 160))
    }

    // simulate.override: click the first preset (real sidebar), compare
    try {
      const presets = await pollUntil('预设头像可读', async () => {
        const ids = await page.evaluate(PRESET_IDS)
        return { ok: ids != null && ids.length >= 2, ids }
      }, 10_000)
      const presetId = presets.ids[0]
      // signature light cone from game metadata (the preset ships E0 S1)
      const charsRes = JSON.parse((await client.readResource({ uri: `game://metadata/characters/${presetId}` })).contents[0].text)
      const presetLc = charsRes.signatureLightCone ?? charsRes.character?.signatureLightCone
      const before = parseNumber((await page.evaluate(SCORE_HEADER_SC)).percent)
      await pollUntil('预设头像可点', async () => ({ ok: await page.evaluate(CLICK_PRESET, [0]) }), 10_000)
      await pollUntil('替换后卡就绪', async () => await page.evaluate(CARD_READY_SC, [presetId]), 60_000)
      const header = await pollUntil('替换后评分头', async () => await page.evaluate(SCORE_HEADER_SC), 150_000, 400)
      const webPercent = parseNumber(header.percent)
      const rows = await page.evaluate(STAT_ROWS_SC)

      await callTool('load_save', { path: freshSeed(baseSavePath) })
      await callTool('fetch_showcase', { uid: liveUid, timeoutMs: 60_000 })
      const mcpOverride = await callTool('score_character', {
        source: 'showcase',
        characterId: firstChar.characterId,
        override: { characterId: presetId, lightCone: presetLc },
      }, LONG)
      const basic = mcpOverride.builds.original.stats.basic
      const basicKeys = Object.keys(basic)
      const FLAT = new Set(['HP', 'ATK', 'DEF', 'SPD'])
      let matched = 0
      let compared = 0
      for (const row of rows) {
        if (row.text.startsWith('Combo DMG')) continue
        const label = row.text.replace(/\s*[-\d.,]+K?%?\s*$/, '').trim()
        const key = basicKeys.find((k) => k === label || (label.endsWith('DMG') && k === `${label} Boost`))
        const raw = key != null ? basic[key] : undefined
        if (raw == null) continue
        compared++
        const expected = FLAT.has(label) ? raw : raw * 100
        if (Math.abs(parseNumber(row.title) - expected) <= 0.05) matched++
      }
      const scoreOk = headerPercentClose(webPercent, mcpOverride.percent)
      const statOk = compared >= 6 && matched === compared
      record('showcase.simulate.override', 1,
        '把展示柜里某个角色换成另一个角色与光锥后，算出的属性汇总、遗器评分与 DPS 评分和网页端替换后的展示卡一致',
        scoreOk && statOk ? 'PASS' : 'FAIL',
        `预设 ${presetId}(LC ${presetLc},E0S1):评分 web ${webPercent}% vs mcp ${(mcpOverride.percent * 100).toFixed(1)}%;面板 ${matched}/${compared} 项一致;遗器评分卡上逐件沿用原遗器(与 case card.read#1 同一批)`)
    } catch (e) {
      record('showcase.simulate.override', 1, '替换角色与光锥后属性/评分一致', 'FAIL', String(e.message).slice(0, 160))
    }

    // simulate.override case 2: missing character / light cone rejections
    try {
      let mcpNoLc = null
      try {
        await callTool('score_character', {
          source: 'showcase',
          characterId: firstChar.characterId,
          override: { characterId: '1102' },
        }, LONG)
      } catch (e) {
        mcpNoLc = String(e.message)
      }
      const mcpBadChar = await (async () => {
        try {
          await callTool('score_character', {
            source: 'showcase',
            characterId: firstChar.characterId,
            override: { characterId: 'not-a-character', lightCone: '24001' },
          }, LONG)
          return null
        } catch (e) {
          return String(e.message)
        }
      })()
      // web: the custom (＋) modal refuses to submit without a character —
      // clear the select's CloseButton first, then Save
      await pollUntil('加号预设可点', async () => ({ ok: await page.evaluate(`() => {
        const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && b.querySelector('svg.tabler-icon-plus') && b.closest('[class*="simSidebarPanel"]'))
        if (!buttons.length) return false
        buttons[0].click()
        return true
      }`) }), 10_000)
      await pollUntil('自定义弹窗打开', async () => ({ ok: await page.evaluate(`() => [...document.querySelectorAll('[role="dialog"]')].some((m) => m.offsetParent !== null)`) }), 10_000)
      await sleep(800)
      const cleared = await pollUntil('清空角色选择', async () => ({ ok: await page.evaluate(`() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null)
        const modal = dialogs[dialogs.length - 1]
        if (!modal) return false
        const input = modal.querySelector('input[readonly]')
        if (!input) return false
        const clear = input.parentElement.querySelector('button')
        if (!clear) return false
        clear.click()
        return true
      }`) }), 10_000)
      await sleep(500)
      const webRefused = await pollUntil('网页缺角色提示', async () => {
        const saved = await page.evaluate(`() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null)
          const modal = dialogs[dialogs.length - 1]
          if (!modal) return false
          const save = Array.from(modal.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save')
          if (!save) return false
          save.click()
          return true
        }`)
        if (!saved) return { ok: false }
        const text = await page.evaluate(NOTIFICATION_TEXT)
        return { ok: /select a character/i.test(text), text }
      }, 10_000)
      await page.evaluate(`() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((m) => m.offsetParent !== null)
        const modal = dialogs[dialogs.length - 1]
        if (modal) {
          const cancel = Array.from(modal.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Cancel')
          if (cancel) cancel.click()
        }
        return true
      }`)
      const ok = mcpNoLc != null && mcpBadChar != null && webRefused.ok
      record('showcase.simulate.override', 2,
        '缺角色或缺光锥时被拒绝，原因与网页端的提示对应',
        ok ? 'PASS' : 'FAIL',
        `MCP 缺光锥:「${(mcpNoLc ?? '').slice(0, 60)}」;MCP 未知角色:「${(mcpBadChar ?? '').slice(0, 60)}」;网页自定义弹窗无角色提交被拒(提示含 character)`)
    } catch (e) {
      record('showcase.simulate.override', 2, '缺角色或缺光锥时被拒绝', 'FAIL', String(e.message).slice(0, 160))
    }

    // simulate.override case 3: computation touches neither save nor cache
    try {
      const after = await snapshot()
      const saveSame = JSON.stringify(after.relics) === JSON.stringify(beforeSnap.relics)
        && JSON.stringify(after.characters) === JSON.stringify(beforeSnap.characters)
      await callTool('load_save', { path: freshSeed(baseSavePath) })
      const refetch = await callTool('fetch_showcase', { uid: liveUid, timeoutMs: 60_000 })
      const cacheIntact = refetch.status === 'ok' && refetch.characterCount === mcpLive.characterCount
        && refetch.characters[0].characterId === firstChar.characterId
        && refetch.characters[0].eidolon === firstChar.eidolon
      record('showcase.simulate.override', 3,
        '计算不改动存档，也不改动缓存里的原始档案',
        saveSame && cacheIntact ? 'PASS' : 'FAIL',
        `MCP 覆写评分后存档与评分前完全相等=${saveSame};重新拉取同 UID 档案首角色仍为 ${firstChar.characterId} E${firstChar.eidolon}(覆盖不落缓存)=${cacheIntact}`)
    } catch (e) {
      record('showcase.simulate.override', 3, '计算不改动存档也不改缓存', 'FAIL', String(e.message).slice(0, 160))
    }
  }).catch(async (e) => {
    console.error('PHASE B1 failed:', e)
    for (const [f, c, d] of [
      ['showcase.profile.fetch', 1, '角色列表一致'],
      ['showcase.profile.fetch', 3, '节流'],
      ['showcase.profile.fetch', 4, '记住UID'],
      ['showcase.sidebar.toggle', 1, '模拟栏'],
      ['showcase.card.read', 1, '展示卡评分一致'],
      ['showcase.card.read', 2, '存档不变'],
      ['showcase.simulate.override', 1, '替换一致'],
      ['showcase.simulate.override', 2, '缺角色/光锥被拒'],
      ['showcase.simulate.override', 3, '不改存档/缓存'],
    ]) {
      if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
    }
  })

  // ── B2. import — the real Import menu (three modes + double import) ────────
  await callTool('load_save', { path: freshSeed(baseSavePath) })
  const baseSnap = await snapshot()
  await runSeedTask('verify-showcase(import)', freshSeed(baseSavePath), async (page) => {
    await pollUntil('UID 输入框聚焦(导入)', async () => ({ ok: await page.evaluate(UID_INPUT) }), 15_000)
    await page.type(liveUid)
    await pollUntil('提交按钮可点(导入)', async () => ({ ok: await page.evaluate(SUBMIT_CLICK) }), 10_000)
    await pollUntil('头像行渲染(导入)', async () => await page.evaluate(AVATAR_ROW), 90_000, 400)
    await sleep(2500)
    // capture the web card relic scores BEFORE any import (for card.read#1's
    // relic-score leg — the same data score_relics sees post-import)
    try {
      const relicsWeb = await page.evaluate(RELIC_SCORES_SC)

      // ── mode=character (also feeds card.read#1's relic-score leg) ──
      await pollUntil('Import 菜单可点(char)', async () => ({ ok: await page.evaluate(CLICK_IMPORT_MENU) }), 10_000)
      await sleep(500)
      await pollUntil('导入单角色菜单项可点', async () => ({ ok: await page.evaluate(CLICK_MENU_ITEM, ['Import selected character & all relics into optimizer']) }), 10_000)
      await sleep(2500)
      const webChar = await page.harvestSaveState()

      await callTool('load_save', { path: freshSeed(baseSavePath) })
      await callTool('fetch_showcase', { uid: liveUid, timeoutMs: 60_000 })
      await callTool('import_showcase', { mode: 'character', characterId: firstChar.characterId })
      const mcpChar = await snapshot()
      const charEqual = JSON.stringify(webChar.characters) === JSON.stringify(mcpChar.characters)
        && JSON.stringify(webChar.relics) === JSON.stringify(mcpChar.relics)

      // relic-score leg: the imported copies carry the showcase values and are
      // equipped on the imported character — score_relics mirrors the card
      const scored = await callTool('score_relics', {
        characterId: firstChar.characterId,
        relicFilters: { equippedBy: firstChar.characterId },
        limit: 10,
      }, LONG)
      const partOrder = ['Head', 'Body', 'PlanarSphere', 'Hands', 'Feet', 'LinkRope']
      const byPart = new Map(scored.relics.map((r) => [r.part, r]))
      let scoreMatched = 0
      const scoreDiffs = []
      for (let i = 0; i < Math.min(6, relicsWeb.length); i++) {
        const part = partOrder[i]
        const row = byPart.get(part)
        if (row && relicsWeb[i].score != null && Math.abs(parseNumber(relicsWeb[i].score) - row.current.percentScore) <= 0.06 && relicsWeb[i].rating === row.current.rating) scoreMatched++
        else scoreDiffs.push(`${part}: web=${relicsWeb[i].score}(${relicsWeb[i].rating}) mcp=${row?.current?.percentScore?.toFixed(1)}(${row?.current?.rating})`)
      }
      const cardCase = cases.find((c) => c.feature === 'showcase.card.read' && c.case === 1)
      if (cardCase) {
        const relicLegOk = relicsWeb.length === 6 && scoreMatched === 6
        if (cardCase.result === 'PASS' && !relicLegOk) {
          cardCase.result = 'FAIL'
          failures++
        }
        cardCase.detail += `;逐件遗器分(网页卡脚注 vs 导入副本 score_relics)${scoreMatched}/${relicsWeb.length} 一致${scoreDiffs.length ? '; ' + scoreDiffs.slice(0, 2).join('; ') : ''}`
        console.log(`[updated] showcase.card.read#1 — 遗器分 ${scoreMatched}/${relicsWeb.length}`)
      }

      // ── mode=all ──
      await pollUntil('Import 菜单可点(all)', async () => ({ ok: await page.evaluate(CLICK_IMPORT_MENU) }), 10_000)
      await sleep(500)
      await pollUntil('导入全部菜单项可点', async () => ({ ok: await page.evaluate(CLICK_MENU_ITEM, ['Import all characters & all relics into optimizer']) }), 10_000)
      await sleep(3000)
      const webAll = await page.harvestSaveState()

      await callTool('load_save', { path: freshSeed(baseSavePath) })
      await callTool('fetch_showcase', { uid: liveUid, timeoutMs: 60_000 })
      await callTool('import_showcase', { mode: 'all' })
      const mcpAll = await snapshot()
      const allEqual = JSON.stringify(webAll.characters) === JSON.stringify(mcpAll.characters)
        && JSON.stringify(webAll.relics) === JSON.stringify(mcpAll.relics)
      record('showcase.import', 1,
        '三种 mode 导入后的存档（角色列表、各角色装备、遗器库存）分别与网页端点对应菜单项后的存档一致',
        charEqual && allEqual ? 'PASS' : 'FAIL',
        `mode=character:角色表+遗器库存逐字段相等=${charEqual};mode=all:相等=${allEqual}(web ${webAll.characters?.length} 角色/${webAll.relics?.length} 件 vs mcp ${mcpAll.characters?.length}/${mcpAll.relics?.length});mode=relics 见下`)
    } catch (e) {
      record('showcase.import', 1, '三种 mode 导入后的存档一致', 'FAIL', String(e.message).slice(0, 160))
    }
  }).catch((e) => {
    console.error('PHASE B2(char/all) failed:', e)
    if (!cases.some((x) => x.feature === 'showcase.import' && x.case === 1)) {
      record('showcase.import', 1, '三种 mode 导入后的存档一致', 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
    }
  })

  // ── B3. relics-only mode + double import (fresh seed both sides) ──────────
  await callTool('load_save', { path: freshSeed(baseSavePath) })
  await runSeedTask('verify-showcase(import-relics)', freshSeed(baseSavePath), async (page) => {
    await pollUntil('UID 输入框聚焦(遗器)', async () => ({ ok: await page.evaluate(UID_INPUT) }), 15_000)
    await page.type(liveUid)
    await pollUntil('提交按钮可点(遗器)', async () => ({ ok: await page.evaluate(SUBMIT_CLICK) }), 10_000)
    await pollUntil('头像行渲染(遗器)', async () => await page.evaluate(AVATAR_ROW), 90_000, 400)
    await sleep(2500)

    // case 1 relics leg + case 2: relics-only import, equipment untouched
    try {
      await pollUntil('Import 菜单可点(relics)', async () => ({ ok: await page.evaluate(CLICK_IMPORT_MENU) }), 10_000)
      await sleep(500)
      await pollUntil('导入遗器菜单项可点(relics)', async () => ({ ok: await page.evaluate(CLICK_MENU_ITEM, ['Import relics into optimizer']) }), 10_000)
      await sleep(2500)
      const webRelics = await page.harvestSaveState()

      await callTool('load_save', { path: freshSeed(baseSavePath) })
      await callTool('fetch_showcase', { uid: liveUid, timeoutMs: 60_000 })
      await callTool('import_showcase', { mode: 'relics' })
      const mcpRelicsSnap = await snapshot()
      const relicsEqual = JSON.stringify(webRelics.relics) === JSON.stringify(mcpRelicsSnap.relics)
      const charsEqual = JSON.stringify(webRelics.characters) === JSON.stringify(mcpRelicsSnap.characters)

      const equippedSame = JSON.stringify((webRelics.characters ?? []).map((c) => c.equipped)) === JSON.stringify((baseSnap.characters ?? []).map((c) => c.equipped))
        && JSON.stringify((mcpRelicsSnap.characters ?? []).map((c) => c.equipped)) === JSON.stringify((baseSnap.characters ?? []).map((c) => c.equipped))
      record('showcase.import', 2,
        '只导入遗器时没有任何角色的装备发生变化',
        equippedSame ? 'PASS' : 'FAIL',
        `网页装备位不变=${JSON.stringify((webRelics.characters ?? []).map((c) => c.equipped)) === JSON.stringify((baseSnap.characters ?? []).map((c) => c.equipped))};MCP 装备位不变=${JSON.stringify((mcpRelicsSnap.characters ?? []).map((c) => c.equipped)) === JSON.stringify((baseSnap.characters ?? []).map((c) => c.equipped))}`)

      // fold the relics-mode leg into import#1's verdict
      const case1 = cases.find((c) => c.feature === 'showcase.import' && c.case === 1)
      if (case1) {
        if (case1.result === 'PASS' && !(relicsEqual && charsEqual)) {
          case1.result = 'FAIL'
          failures++
        }
        case1.detail += `;mode=relics:相等=${relicsEqual && charsEqual}(web ${webRelics.relics?.length} 件/mcp ${mcpRelicsSnap.relics?.length} 件)`
        console.log(`[updated] showcase.import#1 — mode=relics 相等=${relicsEqual && charsEqual}`)
      }
    } catch (e) {
      record('showcase.import', 2, '只导入遗器时装备不变', 'FAIL', String(e.message).slice(0, 160))
    }

    // case 3: importing the same archive again adds no duplicates
    try {
      const mcpSnap1 = await snapshot()
      await callTool('import_showcase', { mode: 'relics' })
      const mcpSnap2 = await snapshot()
      const mcpNoDup = mcpSnap2.relics.length === mcpSnap1.relics.length
      await pollUntil('Import 菜单可点(重复)', async () => ({ ok: await page.evaluate(CLICK_IMPORT_MENU) }), 10_000)
      await sleep(500)
      await pollUntil('导入遗器菜单项可点(重复)', async () => ({ ok: await page.evaluate(CLICK_MENU_ITEM, ['Import relics into optimizer']) }), 10_000)
      await sleep(2500)
      const webTwice = await page.harvestSaveState()
      const webNoDup = (webTwice.relics ?? []).every((r, i) => mcpSnap1.relics[i] && mcpSnap1.relics[i].id === r.id)
        && webTwice.relics.length === mcpSnap1.relics.length
      record('showcase.import', 3,
        '重复导入同一份档案不会产生重复遗器',
        webNoDup && mcpNoDup ? 'PASS' : 'FAIL',
        `MCP 二次导入库存不变=${mcpNoDup}(${mcpSnap2.relics.length});网页二次导入后遗器逐件不变=${webNoDup}(${webTwice.relics.length})`)
    } catch (e) {
      record('showcase.import', 3, '重复导入不产生重复遗器', 'FAIL', String(e.message).slice(0, 160))
    }
  }).catch((e) => {
    console.error('PHASE B3 failed:', e)
    for (const [f, c, d] of [
      ['showcase.import', 2, '只导遗器装备不变'],
      ['showcase.import', 3, '重复导入无重复'],
    ]) {
      if (!cases.some((x) => x.feature === f && x.case === c)) record(f, c, d, 'FAIL', `phase error: ${String(e.message).slice(0, 100)}`)
    }
  })
}

// ── write the evidence file ──────────────────────────────────────────────────
const evidence = {
  area: 'showcase',
  generatedAt: new Date().toISOString(),
  gitCommit,
  cases,
}
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n')

// ── teardown ─────────────────────────────────────────────────────────────────
await client.close()
await browserManager.close()
rmSync(tempDir, { recursive: true, force: true })

const passCount = cases.filter((c) => c.result === 'PASS').length
console.log(`\nverify-showcase: ${passCount}/${cases.length} cases PASS (${failures} FAIL)`)
console.log(`evidence: ${evidencePath}`)
process.exit(failures === 0 ? 0 : 1)
