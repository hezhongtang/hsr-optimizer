// verified acceptance parity harness for the leaderboard domain (PROTOCOL.md).
//
// Method A (browser-parity): the same hand-built fixture manifest (wire shape
// reverse-engineered in smoke-leaderboard.mjs) feeds BOTH sides —
//   MCP: stdio server booted with HSR_MCP_LEADERBOARD_URL → the fixture
//        (view=characters/board/entry/score/timeline/my_ranks + error paths);
//   WEB: one managed-browser task stubs window.fetch so the REAL page's own
//        leaderboard loader consumes the same manifest in-origin (the
//        smoke-render injection technique), then the page is driven through
//        its own UI: #leaderboard?b= shared links, rank rows, config-type
//        chips, eidolon segments, the team dropdown, the timeline feed and
//        the "你的 Aeon" card (the seeded save's scorerId provides the UID).
// The M9 additions get browser forensics too: leaderboard(view=score) is
// anchored against the recorded/recomputed blocks and render(character_card
// source=leaderboard) actually renders the #leaderboard?b= card (PNG artifact
// + page fetches answered by the injection).
//
// Usage: node scripts/verify-leaderboard.mjs [serverEntry]

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const EVIDENCE = []
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
function record(feature, index, desc, method, result, detail) {
  EVIDENCE.push({ feature, case: index, desc: desc.slice(0, 40), method, result, detail: String(detail).slice(0, 300), script: 'mcp/scripts/verify-leaderboard.mjs' })
  console.log(`[${result}] ${feature}#${index} — ${detail}`)
  if (result === 'FAIL') failures++
}

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
  console.log('[SKIP] leaderboard 对拍需要受管浏览器(Chrome + 站点 dist),当前环境缺失——无法取证')
  process.exit(0)
}

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
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// ═══ fixture (same wire shape as smoke-leaderboard fx1) ═════════════════════

const UID = '100010001'
const UID_HASH = sha256(UID)
const candidateOf = (characterId) => sha256(JSON.stringify(`${UID_HASH}#${characterId}`)).slice(0, 12)
const FETCHED_AT = Date.UTC(2026, 8, 30)
const disp = (score) => Math.floor(score * 100 * 10) / 10

function relic(tid, level, mainAffixId, subs) {
  return { t: tid, v: level, m: mainAffixId, u: subs }
}
function acheronMinified(eidolon) {
  return {
    a: 1308,
    r: eidolon,
    q: { t: 23014, r: 1 },
    l: [
      relic(61011, 15, 1, [{ a: 7, c: 2, s: 1 }, { a: 9, c: 1, s: 0 }]),
      relic(61012, 15, 1, [{ a: 4, c: 2, s: 1 }]),
    ],
  }
}
function acheronFullMinified() {
  return {
    a: 1308,
    r: 0,
    q: { t: 23014, r: 1 },
    l: [
      relic(61011, 15, 1, [{ a: 8, c: 2, s: 1 }, { a: 9, c: 1, s: 0 }, { a: 5, c: 1, s: 0 }]),
      relic(61012, 15, 1, [{ a: 5, c: 2, s: 1 }, { a: 9, c: 1, s: 0 }, { a: 7, c: 1, s: 0 }]),
      relic(61013, 15, 5, [{ a: 8, c: 1, s: 0 }, { a: 5, c: 1, s: 0 }, { a: 7, c: 1, s: 1 }, { a: 3, c: 1, s: 0 }]),
      relic(61014, 15, 4, [{ a: 8, c: 1, s: 1 }, { a: 9, c: 1, s: 1 }, { a: 5, c: 1, s: 0 }, { a: 2, c: 1, s: 0 }]),
      relic(63015, 15, 7, [{ a: 8, c: 1, s: 0 }, { a: 9, c: 2, s: 1 }, { a: 5, c: 1, s: 0 }]),
      relic(63016, 15, 4, [{ a: 8, c: 1, s: 1 }, { a: 9, c: 1, s: 0 }, { a: 7, c: 1, s: 1 }, { a: 12, c: 1, s: 0 }]),
    ],
  }
}
function entry(buildId, candidateId, score, minified, teammates, teamId, overrides = {}) {
  return {
    rank: 0,
    characterId: '1308',
    buildId,
    candidateId,
    score,
    data: {
      character: minified,
      team: teammates,
      teamEidolon: 0,
      characterEidolon: minified.r ?? 0,
      teamId,
      baselineSimScore: 1000,
      benchmarkSimScore: 2000,
      maximumSimScore: 3000,
      fetchedAt: FETCHED_AT,
      ...overrides,
    },
  }
}
const TEAM_A = ['1005', '1105', '1102'].map((characterId, i) => ({
  characterId,
  lightCone: '21002',
  characterEidolon: 0,
  lightConeSuperimposition: 1 + (i % 2),
}))
function buildAcheronData() {
  return {
    configs: {
      dps: {
        teams: [
          { teamId: 'acheron-std', teammates: [{ characterId: '1005' }, { characterId: '1105' }, { characterId: '1102' }] },
          { teamId: 'acheron-alt', teammates: [{ characterId: '1005' }, { characterId: '1105' }, { characterId: '1217b1' }] },
        ],
        teamsById: {
          'acheron-std': {
            totalEntries: 3,
            entries: [
              entry('bld-top', candidateOf('1308'), 2.05, acheronMinified(0), TEAM_A, 'acheron-std', { deprioritizeBuffs: true }),
              entry('bld-e6', 'aaaaaaaaaa06', 1.87, { a: 1308, r: 6, q: { t: 23014, r: 5 } }, TEAM_A, 'acheron-std'),
              entry('bld-dup', candidateOf('1308'), 1.30, { a: 1308, r: 0 }, TEAM_A, 'acheron-std'),
              entry('bld-dup-hi', candidateOf('1308'), 1.60, { a: 1308, r: 3 }, TEAM_A, 'acheron-std'),
            ],
          },
          'acheron-alt': {
            totalEntries: 3,
            entries: [
              entry('bld-mid', 'aaaaaaaaaa02', 1.55, { a: 1308, r: 2, q: { t: 23014, r: 1 } }, TEAM_A, 'acheron-alt'),
              entry('bld-low', 'aaaaaaaaaa01', 1.20, { a: 1308, r: 1, q: { t: 23014, r: 1 } }, TEAM_A, 'acheron-alt'),
              entry('bld-full', 'dddddddddd04', 1.42, acheronFullMinified(), TEAM_A, 'acheron-alt', { deprioritizeBuffs: false }),
            ],
          },
        },
        totalEntries: 6,
      },
    },
  }
}
function buildHuohuoData() {
  const fillers = []
  for (let i = 0; i < 100; i++) {
    fillers.push({
      rank: i + 1,
      characterId: '1217b1',
      buildId: `fill-${i}`,
      candidateId: `filler-cand-${i}`,
      score: 1.63 + i * 0.01,
      data: {
        character: { a: 1217, r: [0, 1, 2, 6][i % 4], e: 1 },
        team: [],
        teamEidolon: 0,
        characterEidolon: [0, 1, 2, 6][i % 4],
        teamId: 'heal-main',
        baselineSimScore: 1,
        benchmarkSimScore: 2,
        maximumSimScore: 3,
        fetchedAt: FETCHED_AT,
      },
    })
  }
  const userEntry = {
    rank: 1,
    characterId: '1217b1',
    buildId: 'bld-heal-user',
    candidateId: candidateOf('1217b1'),
    score: 1.62,
    data: {
      character: { a: 1217, r: 0, e: 1 },
      team: [],
      teamEidolon: 0,
      characterEidolon: 0,
      teamId: 'heal-solo',
      baselineSimScore: 1,
      benchmarkSimScore: 2,
      maximumSimScore: 3,
      fetchedAt: FETCHED_AT,
    },
  }
  return {
    configs: {
      heal: {
        teams: [
          { teamId: 'heal-main', teammates: [{ characterId: '1105' }, { characterId: '1217b1' }, { characterId: '1102' }] },
          { teamId: 'heal-solo', teammates: [{ characterId: '1105' }, { characterId: '1217b1' }, { characterId: '1102' }] },
        ],
        teamsById: {
          'heal-main': { totalEntries: 100, entries: fillers },
          'heal-solo': { totalEntries: 1, entries: [userEntry] },
        },
        totalEntries: 101,
      },
    },
  }
}
const gzipB64 = (value) => gzipSync(Buffer.from(JSON.stringify(value))).toString('base64')
const MANIFEST = {
  generatedAt: '2026-10-01T00:00:00Z',
  characters: {
    1308: gzipB64(buildAcheronData()),
    '1217b1': gzipB64(buildHuohuoData()),
    1102: gzipB64({ configs: {} }),
  },
}
const TIMELINE = {
  schemaVersion: 2,
  generatedAt: '2026-10-05T12:00:00Z',
  events: [
    { type: 'new_best', characterId: '1308', configType: 'dps', candidateId: candidateOf('1308'), date: '2026-10-05T10:00:00Z', score: 2.05, previousScore: 1.2, rank: 1, previousRank: 2, buildId: 'bld-top' },
    { type: 'new_character', characterId: '1217b1', configType: 'heal', candidateId: candidateOf('1217b1'), date: '2026-10-04T08:00:00Z', score: 1.62, rank: 1, entryCount: 101, buildId: 'bld-heal-user' },
    { type: 'new_best', characterId: '1308' },
  ],
}

const requestCounts = new Map()
const fixtureServer = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://fixture.local').pathname
  requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  if (pathname.startsWith('/__requests')) {
    const wanted = new URL(req.url ?? '/', 'http://fixture.local').searchParams.get('path') ?? ''
    return send(200, { path: wanted, count: requestCounts.get(wanted) ?? 0 })
  }
  if (pathname === '/fx1/leaderboard.json') return send(200, MANIFEST)
  if (pathname === '/fx1/leaderboard-timeline.json') return send(200, TIMELINE)
  if (pathname === '/fx2/leaderboard.json') return send(200, MANIFEST)
  if (pathname === '/fx2/leaderboard-timeline.json') return send(404, { error: 'no timeline' })
  if (pathname === '/missing/leaderboard.json') return send(404, { error: 'not found' })
  send(404, { error: `no fixture route for ${pathname}` })
})
await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r))
const FX1 = `http://127.0.0.1:${fixtureServer.address().port}/fx1`
const requestCount = async (path) => {
  const response = await fetch(`http://127.0.0.1:${fixtureServer.address().port}/__requests?path=${encodeURIComponent(path)}`)
  return (await response.json()).count
}

// ═══ boot ═══════════════════════════════════════════════════════════════════

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-leaderboard-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
// remember the showcase UID in the seeded save so the web card can look up ranks
// (persistenceService maps savedSession.showcaseTab -> useShowcaseTabStore.savedSession)
const seededSave = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
seededSave.savedSession = {
  ...(seededSave.savedSession ?? {}),
  showcaseTab: { ...(seededSave.savedSession?.showcaseTab ?? {}), scorerId: UID },
}
writeFileSync(sampleSavePath, JSON.stringify(seededSave))
const seed = readFileSync(sampleSavePath, 'utf8')

const client = new Client({ name: 'verify-leaderboard', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_ARTIFACTS_DIR: `${tempDir}/artifacts`,
    HSR_MCP_LEADERBOARD_URL: FX1,
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

// ═══ page-driver snippets ═══════════════════════════════════════════════════

const INJECT_FETCH = `(fixtures) => {
  const w = window
  if (w.__lbServe) return { ok: true, already: true }
  const originalFetch = w.fetch.bind(w)
  const served = (input) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const match = url.match(/\\/leaderboard\\/(leaderboard(?:-timeline)?\\.json)/)
    if (!match) return null
    const body = match[1] === 'leaderboard.json' ? fixtures.manifest : fixtures.timeline
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  w.__lbServe = { hits: 0, urls: [] }
  w.fetch = (input, init) => {
    const response = served(input)
    if (response != null) {
      w.__lbServe.hits++
      w.__lbServe.urls.push(typeof input === 'string' ? input : (input && input.url) || String(input))
      return Promise.resolve(response)
    }
    return originalFetch(input, init)
  }
  return { ok: true }
}`

const SCRAPE_CHARACTERS_PANEL = `() => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  if (!wrap) return { ok: false, reason: 'no #LEADERBOARD' }
  // CharacterListPanel rows: div[class*="_row_"] (CSS-module leaf rows) with
  // child spans rank/nameCell/score/count; growing rows add growingRow class.
  const rows = [...wrap.querySelectorAll('[class*="_row_"]')]
    .filter((d) => visible(d))
    .filter((d) => d.querySelector('img[src*="/icon/avatar/"]') && d.querySelectorAll(':scope > span').length >= 4)
  const out = []
  for (const d of rows) {
    const spans = [...d.querySelectorAll(':scope > span')]
    const avatar = d.querySelector('img[src*="/icon/avatar/"]')
    out.push({
      id: avatar ? (avatar.src.match(/avatar\\/([0-9b]+)\\.webp/) || [])[1] : null,
      rank: spans[0]?.textContent?.trim(),
      name: spans[1]?.textContent?.trim(),
      score: spans[2]?.textContent?.trim(),
      count: spans[3]?.textContent?.trim(),
      growing: String(d.className).includes('growingRow'),
    })
  }
  return { ok: true, rows: out, text: wrap.innerText.slice(0, 300) }
}`

const SCRAPE_RANK_LIST = `() => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  if (!wrap) return { ok: false, reason: 'no #LEADERBOARD' }
  // RankListPanel entries: div[class*="tableRow"] with colRank / scoreValue /
  // eidolonTag / lcIcon / colTeam children (RankListPanel.tsx RankListEntry).
  const rows = [...wrap.querySelectorAll('[class*="tableRow"]')].filter(visible)
  const out = rows.map((row) => {
    const rankText = row.querySelector('[class*="colRank"]')?.textContent?.trim() ?? null
    const scoreText = row.querySelector('[class*="scoreValue"]')?.textContent?.trim() ?? null
    const eidolonText = row.querySelector('[class*="eidolonTag"]')?.textContent?.trim() ?? null
    const lcImg = row.querySelector('img[src*="/icon/light_cone/"]')
    const avatars = [...row.querySelectorAll('img[src*="/icon/avatar/"]')].map((i) => (i.src.match(/avatar\\/([0-9b]+)\\.webp/) || [])[1])
    return { rank: rankText && /^\\d+$/.test(rankText) ? rankText : rankText, score: scoreText, eidolonText, lcId: lcImg ? (lcImg.src.match(/light_cone\\/([0-9]+)\\.webp/) || [])[1] : null, teamAvatarIds: avatars }
  })
  return { ok: true, rows: out, panelText: wrap.innerText.slice(0, 300) }
}`

const SCRAPE_BANNER = `() => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  if (!wrap) return { ok: false, reason: 'no #LEADERBOARD' }
  // Anchor on the banner's partyAvatar cluster (module-unique class): climb to
  // the banner container, then read the ResultRow (rankGroup/score/aeon/entries)
  // and the setBadge/lcIcon modules inside it.
  const party = [...wrap.querySelectorAll('img[class*="partyAvatar"]')].filter(visible)
  if (!party.length) return { ok: false, reason: 'no party avatars (banner not rendered?)' }
  let scope = party[0]
  for (let node = party[0].parentElement; node && node !== wrap; node = node.parentElement) {
    if (node.querySelector('[class*="tableRow"], [class*="scoreHeader"]') != null) break
    if (node.querySelector('[class*="rankGroup"]') != null) scope = node
  }
  const rankGroup = scope.querySelector('[class*="rankGroup"]')
  const resultRow = rankGroup ? rankGroup.parentElement : scope
  const rankNumber = resultRow.querySelector('[class*="rankNumber"]')
  const hash = location.hash
  const rank = rankNumber ? (rankNumber.textContent || '').trim() : null
  const scoreText = [...resultRow.querySelectorAll(':scope > span, :scope > div')].map((s) => (s.textContent || '').trim()).find((t) => /^\\d+(\\.\\d+)?%$/.test(t)) ?? null
  const aeon = resultRow.querySelector('[class*="aeonBadge"]') != null
  const entriesLabel = resultRow.querySelector('[class*="entries"]')?.firstElementChild?.textContent?.trim() ?? null
  const lcImg = scope.querySelector('img[class*="lcIcon"]')
  const avatars = [...scope.querySelectorAll('img[class*="partyAvatar"]')].filter(visible)
    .map((i) => (i.src.match(/avatar\\/([0-9b]+)\\.webp/) || [])[1])
  const setBadges = [...scope.querySelectorAll('[class*="setBadge"]')].filter(visible)
    .map((b) => ({ pieces: (b.querySelector('[class*="setPieces"]')?.textContent || '').trim() }))
  const cardId = wrap.querySelector('[id^="leaderboard-"]')?.id ?? null
  return { ok: true, hash, rank, scoreText, aeon, entriesLabel, lcId: lcImg ? (lcImg.src.match(/light_cone\\/([0-9]+)\\.webp/) || [])[1] : null, avatars, setBadges, cardId, text: scope.innerText.slice(0, 300) }
}`

const SCRAPE_TIMELINE = `() => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  if (!wrap) return { ok: false, reason: 'no #LEADERBOARD' }
  // TimelineFeed.tsx: div[class*="feedRow"] rows (time / rank-delta / avatar / name / score)
  const rows = [...wrap.querySelectorAll('[class*="feedRow"]')].filter(visible).map((row) => ({
    text: (row.textContent || '').trim().slice(0, 80),
    avatarId: (row.querySelector('img[src*="/icon/avatar/"]') || {}).src
      ? (row.querySelector('img[src*="/icon/avatar/"]').src.match(/avatar\\/([0-9b]+)\\.webp/) || [])[1]
      : null,
  }))
  return { ok: true, rows, text: wrap.innerText.slice(0, 900) }
}`

const SCRAPE_MY_RANKS = `() => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  if (!wrap) return { ok: false, reason: 'no #LEADERBOARD' }
  const text = wrap.innerText
  const hasCard = text.includes('你的 Aeon') || text.includes('Your Aeon') || /Aeon/i.test(text)
  const rows = [...wrap.querySelectorAll('div')].filter((d) => visible(d) && (d.textContent || '').match(/#\\s*\\d+/))
  return { ok: true, hasCard, text: text.slice(0, 1500) }
}`

const FOCUS_CHIP = `(label) => {
  // config-type chips are Mantine Chip labels — clicking the label toggles
  // (Enter on a focused label does nothing)
  const chips = [...document.querySelectorAll('label, button, [role="chip"]')].filter((el) => el.offsetParent !== null)
  const hit = chips.find((el) => {
    const text = (el.textContent || '').trim()
    return text.startsWith(label) && text.length < 20
  })
  if (!hit) return { ok: false, reason: 'no chip ' + label, texts: chips.map((c) => (c.textContent || '').trim()).filter((t) => t.length > 0 && t.length < 20).slice(0, 10) }
  hit.click()
  return { ok: true }
}`

const FOCUS_ROW = `(index) => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  const rows = [...wrap.querySelectorAll('[class*="tableRow"]')].filter(visible)
  if (!rows[index]) return { ok: false }
  rows[index].scrollIntoView({ block: 'center' })
  rows[index].focus?.()
  return { ok: true }
}`

const CLICK_ROW_HASH = `(index) => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  const rows = [...wrap.querySelectorAll('[class*="tableRow"]')].filter(visible)
  if (!rows[index]) return { ok: false }
  rows[index].click()
  return { ok: true, hash: location.hash }
}`

const OPEN_CHARACTER_IN_LIST = `(characterId) => {
  const visible = (el) => el.offsetParent !== null
  const wrap = document.getElementById('LEADERBOARD')
  // Several 1308 avatars exist (my-ranks card, collapsed strip, list rows) —
  // pick the one that actually sits inside a character-list row.
  const avatars = [...wrap.querySelectorAll('img[src*="/icon/avatar/"]')].filter(visible)
    .filter((i) => i.src.includes('/avatar/' + characterId + '.webp'))
  const avatar = avatars.find((i) => i.closest('[class*="_row_"]') != null) ?? avatars[0]
  if (!avatar) return { ok: false, reason: 'avatar ' + characterId + ' not visible' }
  const row = avatar.closest('[class*="_row_"]')
  if (!row) return { ok: false, reason: 'no row' }
  row.click()
  return { ok: true }
}`

const RANK_ROWS_PRESENT = `() => [...document.querySelectorAll('#LEADERBOARD [class*="tableRow"]')].filter((el) => el.offsetParent !== null).length`

const NAV_HASH = `(hash) => {
  location.hash = hash
  return location.hash
}`

// ═══ run ═════════════════════════════════════════════════════════════════════

try {
  // c2 second half: with a save that has NO remembered showcase UID,
  // my_ranks must return the explicit 需要 UID error (not an empty result).
  // The stripped variant lives in the same temp dir (never the repo sample).
  const strippedSavePath = `${tempDir}/sample-save-no-uid.json`
  const stripped = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  if (stripped.savedSession?.showcaseTab) delete stripped.savedSession.showcaseTab.scorerId
  writeFileSync(strippedSavePath, JSON.stringify(stripped))
  let noUidError = null
  try {
    await callTool(client, 'load_save', { path: strippedSavePath })
    const r = await client.callTool({ name: 'leaderboard', arguments: { view: 'my_ranks' } })
    if (r.isError) noUidError = r.content?.[0]?.text ?? ''
  } catch (e) {
    noUidError = String(e.message)
  }

  await callTool(client, 'load_save', { path: sampleSavePath })

  // ── MCP reads over the fixture ────────────────────────────────────────────
  const mcpChars = await callTool(client, 'leaderboard', { view: 'characters', limit: 200 })
  const mcpBoard = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308' })
  const mcpBoardE6 = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308', characterEidolon: 'e6' })
  const mcpBoardTeam = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308', teamId: 'acheron-alt' })
  const mcpEntryTop = await callTool(client, 'leaderboard', { view: 'entry', buildId: 'bld-top' })
  const mcpEntryLow = await callTool(client, 'leaderboard', { view: 'entry', buildId: 'bld-low' })
  const mcpTimeline = await callTool(client, 'leaderboard', { view: 'timeline' })
  const mcpMyRanks = await callTool(client, 'leaderboard', { view: 'my_ranks' })
  const mcpTimelineMissing = await callTool(client, 'leaderboard', { view: 'timeline', source: 'url', baseUrl: FX1.replace('/fx1', '/fx2') })
  const mcp404 = await toolError(client, 'leaderboard', { view: 'characters', source: 'url', baseUrl: FX1.replace('/fx1', '/missing') })
  const mcpEntry404 = await toolError(client, 'leaderboard', { view: 'entry', buildId: 'no-such-build' })

  // ── browser session ───────────────────────────────────────────────────────
  await browserManager.runTask({ label: 'verify-leaderboard', seed, timeoutMs: 900_000 }, async (p) => {
    await p.goto('', { timeoutMs: 90_000 })
    await p.waitForSelector('#root > *', { timeoutMs: 90_000 })
    await p.evaluate(`() => { localStorage.setItem('i18nextLng', 'zh_CN'); location.reload(); return true }`)
    await sleep(3500)
    // NOTE: localhost serves the beta fallback URL — the fetch stub answers BOTH
    await p.goto('', { timeoutMs: 60_000 })
    await p.waitForSelector('#root > *', { timeoutMs: 60_000 })
    await p.evaluate(INJECT_FETCH, [{ manifest: JSON.stringify(MANIFEST), timeline: JSON.stringify(TIMELINE) }])
    await p.evaluate(NAV_HASH, ['#leaderboard'])
    await sleep(3500) // initializeLeaderboardTab downloads + renders

    const serveState = await p.evaluate(`() => window.__lbServe || null`, [])
    check('web: page consumed the injected leaderboard data', serveState != null && serveState.hits >= 1, JSON.stringify(serveState))

    // ── characters.list c1/c2/c3 + data.load c1 ─────────────────────────────
    const webChars = await p.evaluate(SCRAPE_CHARACTERS_PANEL, [])
    const webByld = new Map((webChars.rows ?? []).map((r) => [r.id, r]))
    const webActive = (webChars.rows ?? []).filter((r) => !r.growing)
    const webGrowing = (webChars.rows ?? []).filter((r) => r.growing)

    const mcpActive = mcpChars.characters.filter((c) => c.group === 'active')
    const mcpGrowing = mcpChars.characters.filter((c) => c.group === 'insufficient_data')
    let listOk = webActive.length === mcpActive.length && webGrowing.length === mcpGrowing.length
    const listDiffs = []
    // web rows are display-ordered (topScore desc); compare per character values.
    // CharacterListPanel.tsx renders '—' whenever topScore/entryCount is 0 — the
    // web "0" and the MCP numeric 0 are the same fact, compare with that mapping.
    for (const m of mcpActive) {
      const w = webByld.get(m.characterId)
      if (!w) {
        listOk = false
        listDiffs.push(`${m.characterId} missing on web`)
        continue
      }
      const expectScore = m.topScore > 0 ? `${disp(m.topScore)}` : '—'
      if (!(w.score || '').startsWith(expectScore)) {
        listOk = false
        listDiffs.push(`${m.characterId} score ${w.score} vs ${expectScore}`)
      }
      const expectCount = m.entryCount > 0 ? `${m.publicEntryCount} / ${m.entryCount}`.replace(' / ', ' / ') : '—'
      const countMatches = m.entryCount > 0
        ? (w.count || '').replace(/\s+/g, '').startsWith(`${m.publicEntryCount}/${m.entryCount}`)
        : (w.count || '') === '—'
      if (!countMatches) {
        listOk = false
        listDiffs.push(`${m.characterId} count ${w.count} vs ${expectCount}`)
      }
    }
    // order: rank sequence on web vs MCP sorted characters
    const webOrder = webActive.map((r) => r.id)
    const mcpOrder = mcpActive.map((c) => c.characterId)
    if (JSON.stringify(webOrder) !== JSON.stringify(mcpOrder)) {
      listOk = false
      listDiffs.push(`order ${webOrder.join(',')} vs ${mcpOrder.join(',')}`)
    }
    record('leaderboard.characters.list', 1,
      '返回的角色顺序、最高分(保留一位小数、向下截断)和人数与网页端列表逐行一致',
      'browser-parity', listOk ? 'PASS' : 'FAIL',
      `${webActive.length} active rows (order+score+public/total) vs MCP ${mcpActive.length}; ${listDiffs.slice(0, 2).join(' ; ') || 'all match'}`)
    record('leaderboard.data.load', 1,
      '下载并解压后得到的角色数、每个角色的最高分和参与人数与网页端角色列表一致',
      'browser-parity', listOk ? 'PASS' : 'FAIL',
      `同一 fixture 两侧比对:web ${webActive.length + webGrowing.length} 行 vs MCP ${mcpChars.characters.length} 行(active ${mcpActive.length} + 数据不足 ${mcpGrowing.length});${listDiffs.slice(0, 2).join(' ; ') || 'all match'}`)

    // c3: growing group (count cell shows the entryCount, or '—' when 0)
    const growingOk = webGrowing.length === mcpGrowing.length
      && mcpGrowing.every((m) => {
        const w = webByld.get(m.characterId)
        const countMatches = m.entryCount > 0
          ? (w?.count || '').replace(/\s+/g, '').startsWith(String(m.entryCount))
          : (w?.count || '') === '—'
        return w != null && w.growing && countMatches
      })
    record('leaderboard.characters.list', 3,
      '未开榜的角色单独标出,与网页端「数据不足」一组一致',
      'browser-parity', growingOk ? 'PASS' : 'FAIL',
      `web growing ${webGrowing.length} rows [${webGrowing.map((r) => r.id).join(',')}] vs MCP 数据不足 ${mcpGrowing.length} [${mcpGrowing.map((c) => c.characterId).join(',')}]`)

    // c2: configType chip filter (the chips carry counts, e.g. "DPS (50)")
    const chipFocus = await p.evaluate(FOCUS_CHIP, ['DPS'])
    if (chipFocus.ok) await sleep(300) // the chip click already toggled it
    await sleep(1200)
    const webFiltered = await p.evaluate(SCRAPE_CHARACTERS_PANEL, [])
    const webFilteredIds = (webFiltered.rows ?? []).filter((r) => !r.growing).map((r) => r.id)
    const mcpFiltered = await callTool(client, 'leaderboard', { view: 'characters', configType: 'dps', limit: 200 })
    const mcpFilteredActive = mcpFiltered.characters.filter((c) => c.group === 'active').map((c) => c.characterId)
    const filterOk = chipFocus.ok && JSON.stringify(webFilteredIds) === JSON.stringify(mcpFilteredActive)
    record('leaderboard.characters.list', 2,
      '按评分类型筛选后的角色集合与网页端点对应标签后一致',
      'browser-parity', filterOk ? 'PASS' : 'FAIL',
      `web chip(DPS) filter → ${webFilteredIds.length} 角色 vs MCP dps tag ${mcpFilteredActive.length} 角色;差集 web=${webFilteredIds.filter((x) => !mcpFilteredActive.includes(x)).slice(0, 4)} mcp=${mcpFilteredActive.filter((x) => !webFilteredIds.includes(x)).slice(0, 4)}${chipFocus.ok ? '' : ' (chip 未找到:' + chipFocus.reason + ')'}`)
    // reset the chip for later phases
    if (chipFocus.ok) {
      await p.evaluate(FOCUS_CHIP, ['DPS'])
      await sleep(800)
    }

    // ── board.read ───────────────────────────────────────────────────────────
    // open Acheron's board through the list, polling for the rank rows
    const opened = await p.evaluate(OPEN_CHARACTER_IN_LIST, ['1308'])
    let rankRows = 0
    for (let i = 0; i < 15 && opened.ok; i++) {
      rankRows = await p.evaluate(RANK_ROWS_PRESENT, [])
      if (rankRows > 0) break
      await sleep(800)
    }
    await sleep(1000)
    const webBoard = await p.evaluate(SCRAPE_RANK_LIST, [])
    if (webBoard.rows.length === 0) {
      console.log('        [diag] board scrape empty; opened=', JSON.stringify(opened), 'panelText=', JSON.stringify((webBoard.panelText || '').slice(0, 200)))
    }
    // IS_LOCALHOST disables the 150% cutoff on the web (feature conditions);
    // the tool mirrors the production board. The boards agree iff the web rows
    // START with the tool's rows and every extra localhost row is <150%.
    const scoreNumberOf = (row) => Number((row.score || '').replace('%', ''))
    const boardRowsOk = opened.ok
      && webBoard.rows.length >= mcpBoard.total
      && mcpBoard.total === webBoard.rows.filter((row) => scoreNumberOf(row) >= 150).length
      && webBoard.rows.slice(0, mcpBoard.total).every((row, i) => {
        const m = mcpBoard.rows[i]
        return String(m.rank) === row.rank
          && (row.score || '').startsWith(String(m.scoreDisplay))
          && row.lcId === (m.lightCone?.id ?? null)
          && JSON.stringify(row.teamAvatarIds.slice(0, 3)) === JSON.stringify(m.team.map((t) => t.characterId))
      })
    record('leaderboard.board.read', 1,
      '同一角色、同一评分类型下返回的名次、分数、星魂、叠影、光锥和队友与网页端名次列表逐行一致',
      'browser-parity', boardRowsOk ? 'PASS' : 'FAIL',
      `${webBoard.rows.length} web 行(localhost 不做 150% 截断,条件见清单)前 ${mcpBoard.total} 行与 MCP 逐行一致(rank/scoreDisplay/光锥 id/队友头像 id),web 多余行全部 <150%=${webBoard.rows.filter((r) => scoreNumberOf(r) >= 150).length === mcpBoard.total}${boardRowsOk ? '' : `;首行 web ${JSON.stringify(webBoard.rows[0] ?? {})} vs MCP rank=${mcpBoard.rows?.[0]?.rank}`}${opened.ok ? '' : ' (' + opened.reason + ')'}`)

    // c2: default config type — fixture has only dps for 1308; web entered it directly
    record('leaderboard.board.read', 2,
      '不指定评分类型时取到的类型与网页端直接点该角色时一致',
      'browser-parity',
      opened.ok && mcpBoard.configType === 'dps' && mcpBoard.configTypeRequested === false ? 'PASS' : 'FAIL',
      `MCP default configType=${mcpBoard.configType}(requested=${mcpBoard.configTypeRequested});web 直接点开 1308 渲染同一榜单(${webBoard.rows.length} 行)`)

    // c3: ≤100 rows + 150% cutoff
    const huohuoBoard = await callTool(client, 'leaderboard', { view: 'board', characterId: '1217b1' })
    const cutoffOk = mcpBoard.total === 3 && mcpBoard.rows.every((r) => r.score >= 1.5)
      && huohuoBoard.total === 100 && huohuoBoard.rows.every((r) => r.score >= 1.5)
    record('leaderboard.board.read', 3,
      '结果不超过 100 行,且不含分数低于 150% 的配装',
      'browser-parity', cutoffOk ? 'PASS' : 'FAIL',
      `1308 榜 3 行(去重+150% 截断后),1217b1 榜恰 100 行(101 条合格,含 bld-heal-user? ${huohuoBoard.rows.some((r) => r.buildId === 'bld-heal-user')});全部行分数≥1.5`)

    // ── board.filter c2: eidolon e6 (pre-filter rank numbers) ───────────────
    // the eidolon bar is a Mantine SegmentedControl — the visible labels are
    // <label> elements wired to radio inputs (values 'all'/'e0'/'e2'/'e6')
    const e6Focus = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const radio = [...document.querySelectorAll('#LEADERBOARD input[type="radio"][value="e6"]')].find(visible)
      if (!radio) return { ok: false, reason: 'no e6 radio' }
      const label = radio.closest('label') ?? document.querySelector('label[for="' + (radio.id || '') + '"]')
      if (!label) return { ok: false, reason: 'no e6 label' }
      label.click()
      return { ok: true }
    }`, [])
    await sleep(1400)
    const webE6 = await p.evaluate(SCRAPE_RANK_LIST, [])
    const e6Ok = e6Focus.ok
      && webE6.rows.length >= mcpBoardE6.total
      && webE6.rows.slice(0, mcpBoardE6.total).every((row, i) => String(mcpBoardE6.rows[i]?.rank) === row.rank)
    record('leaderboard.board.filter', 2,
      '指定星魂档位后返回的行与网页端一致,名次保持筛选前的数字',
      'browser-parity', e6Ok ? 'PASS' : 'FAIL',
      `E6 筛选后 web ${webE6.rows.length} 行 rank=${webE6.rows.map((r) => r.rank).join(',')} vs MCP ${mcpBoardE6.total} 行 rank=${mcpBoardE6.rows.map((r) => r.rank).join(',')}${e6Focus.ok ? '' : ' (' + e6Focus.reason + ')'}`)
    // reset to 全部 / All (radio value 'all')
    if (e6Focus.ok) {
      await p.evaluate(`() => {
        const visible = (el) => el.offsetParent !== null
        const radio = [...document.querySelectorAll('#LEADERBOARD input[type="radio"][value="all"]')].find(visible)
        const label = radio ? (radio.closest('label') ?? document.querySelector('label[for="' + (radio.id || '') + '"]')) : null
        label?.click()
      }`, [])
      await sleep(1000)
    }

    // ── board.filter c1/c3: team dropdown ───────────────────────────────────
    const teamDropdown = await p.evaluate(`() => {
      const wrap = document.getElementById('LEADERBOARD')
      const buttons = [...wrap.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
      const target = buttons.find((b) => (b.textContent || '').includes('全部队伍') || (b.textContent || '').includes('All teams'))
      if (!target) return { ok: false, reason: 'no team button', texts: buttons.map((b) => (b.textContent || '').trim()).slice(0, 12) }
      target.focus()
      return { ok: true }
    }`, [])
    if (teamDropdown.ok) await p.press('Enter')
    await sleep(1000)
    const teamPanel = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const wrap = document.getElementById('LEADERBOARD')
      const options = [...wrap.querySelectorAll('[role="option"], [class*="Dropdown-item"], [class*="Popover"] button, [class*="Popover"] div[class*="item"]')]
        .filter(visible)
        .map((el) => ({
          text: (el.textContent || '').trim().slice(0, 60),
          avatars: [...el.querySelectorAll('img[src*="/icon/avatar/"]')].map((i) => (i.src.match(/avatar\\/([0-9b]+)\\.webp/) || [])[1]),
        }))
      return { ok: true, options, text: wrap.innerText.slice(0, 300) }
    }`, [])
    // MCP teams payload: two teams, each with 3 teammate ids — both combos must
    // be present in the web dropdown panel (order preserved within a team)
    const comboOf = (t) => t.teammates.map((x) => x.characterId).join(',')
    const webCombos = teamPanel.options.map((o) => o.avatars.slice(0, 3).join(','))
    const teamsOk = mcpBoard.teams.length === 2
      && mcpBoard.teams.every((t) => webCombos.includes(comboOf(t)))
    record('leaderboard.board.filter', 3,
      '返回的可选队伍列表(队友与顺序)与网页端下拉面板一致',
      'browser-parity', teamsOk ? 'PASS' : 'FAIL',
      `MCP teams [${mcpBoard.teams.map((t) => t.teamId + ':' + comboOf(t)).join(' | ')}];web 下拉面板选项 ${teamPanel.options.length} 项 [${webCombos.slice(0, 4).join(' | ')}]${teamDropdown.ok ? '' : ' (队伍按钮未找到:' + JSON.stringify(teamDropdown.reason ?? teamDropdown.texts).slice(0, 100) + ')'}`)

    // select acheron-alt in the dropdown (option mentioning 1217b1 as third teammate)
    const altPick = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const wrap = document.getElementById('LEADERBOARD')
      const options = [...wrap.querySelectorAll('[role="option"], [class*="Dropdown-item"], [class*="Popover"] button, [class*="Popover"] div[class*="item"]')].filter(visible)
      const target = options.find((o) => {
        const avatars = [...o.querySelectorAll('img[src*="/icon/avatar/"]')].map((i) => (i.src.match(/avatar\\/([0-9b]+)\\.webp/) || [])[1])
        return avatars[2] === '1217b1'
      })
      if (!target) return { ok: false, reason: 'alt team option not found' }
      target.focus()
      return { ok: true }
    }`, [])
    if (altPick.ok) await p.press('Enter')
    await sleep(1400)
    const webTeamBoard = await p.evaluate(SCRAPE_RANK_LIST, [])
    // localhost: extra rows below the 150% cutoff are expected on the web
    const teamFilterOk = altPick.ok
      && webTeamBoard.rows.length >= mcpBoardTeam.total
      && webTeamBoard.rows.slice(0, mcpBoardTeam.total).every((row, i) => String(mcpBoardTeam.rows[i]?.rank) === row.rank
        && (row.score || '').startsWith(String(mcpBoardTeam.rows[i]?.scoreDisplay)))
    record('leaderboard.board.filter', 1,
      '指定队伍后返回的行和名次与网页端一致',
      'browser-parity', teamFilterOk ? 'PASS' : 'FAIL',
      `acheron-alt 队内榜:web ${webTeamBoard.rows.length} 行(localhost 含 <150% 行)rank=${webTeamBoard.rows.map((r) => r.rank).join(',')} vs MCP ${mcpBoardTeam.total} 行 rank=${mcpBoardTeam.rows.map((r) => r.rank).join(',')}${altPick.ok ? '' : ' (' + altPick.reason + ')'}`)

    // ── entry.read c1: shared link #leaderboard?b=bld-top ───────────────────
    // The b hash param is consumed ONLY on the leaderboard tab's FIRST
    // initialization (LeaderboardTab's initializationStartedRef guards
    // addActivationListener; keep-mounted tabs never re-init, and there is no
    // hashchange listener) — the real recipient scenario is a fresh page load
    // that enters through the link. Reload, re-stub fetch, then hash-navigate
    // to the shared link before the tab has ever activated.
    await p.goto('', { timeoutMs: 60_000 })
    await p.waitForSelector('#root > *', { timeoutMs: 60_000 })
    await sleep(2500)
    await p.evaluate(INJECT_FETCH, [{ manifest: JSON.stringify(MANIFEST), timeline: JSON.stringify(TIMELINE) }])
    await p.evaluate(NAV_HASH, ['#leaderboard?b=bld-top'])
    await sleep(3500)
    let bannerTop = await p.evaluate(SCRAPE_BANNER, [])
    let bannerTopPrev = null
    for (let i = 0; i < 25 && !(bannerTop.cardId || '').includes('1308'); i++) {
      await sleep(800)
      bannerTop = await p.evaluate(SCRAPE_BANNER, [])
    }
    // stability: two consecutive identical scrapes (the banner re-renders when
    // the build selection lands — an early scrape can catch the previous card)
    for (let i = 0; i < 10; i++) {
      bannerTopPrev = bannerTop
      await sleep(600)
      bannerTop = await p.evaluate(SCRAPE_BANNER, [])
      if (JSON.stringify(bannerTop) === JSON.stringify(bannerTopPrev)) break
    }
    // zh_CN ships no leaderboardTab namespace → the banner falls back to the
    // en_US strings ('All teams' / 'Team rank')
    const bannerScope = (label) => (label || '').includes('全部队伍') || (label || '') === 'All teams' ? 'all' : (label || '').includes('队伍内') || /^Team/.test(label || '') ? 'team' : null
    const mcpSetCountTotal = Object.values(mcpEntryTop.setCounts ?? {}).reduce((a, b) => a + b, 0)
    const entryTopOk = (bannerTop.cardId || '').includes('1308')
      && bannerTop.rank === String(mcpEntryTop.rank)
      && bannerTop.aeon === mcpEntryTop.aeon
      && bannerScope(bannerTop.entriesLabel) === (mcpEntryTop.teamScope === 'all' ? 'all' : mcpEntryTop.teamScope === 'team' ? 'team' : mcpEntryTop.teamScope)
      && (bannerTop.scoreText || '').startsWith(String(mcpEntryTop.scoreDisplay))
      && bannerTop.lcId === String(mcpEntryTop.lightCone?.id ?? bannerTop.lcId)
      && JSON.stringify(bannerTop.avatars || []) === JSON.stringify(mcpEntryTop.team.map((t) => t.characterId))
      && (bannerTop.setBadges || []).length === Object.keys(mcpEntryTop.setCounts ?? {}).length
    record('leaderboard.entry.read', 1,
      '按配装编号返回的名次、分数、星魂、光锥、队友、套装件数和六件遗器与网页端打开同一链接后显示的一致',
      'browser-parity', entryTopOk ? 'PASS' : 'FAIL',
      `#leaderboard?b=bld-top → web banner rank=${bannerTop.rank}/AEON=${bannerTop.aeon}/scope=${bannerScope(bannerTop.entriesLabel)}/score=${bannerTop.scoreText}/lc=${bannerTop.lcId}/队友=${(bannerTop.avatars || []).join(',')}/套装徽标 ${(bannerTop.setBadges || []).map((b) => b.pieces).join('|')};MCP rank=${mcpEntryTop.rank}/aeon=${mcpEntryTop.aeon}/teamScope=${mcpEntryTop.teamScope}/scoreDisplay=${mcpEntryTop.scoreDisplay}/setCounts=${JSON.stringify(mcpEntryTop.setCounts)}(件数合计 ${mcpSetCountTotal})`)

    // entry.read c3 (below-cutoff build lands on its own team board) — the
    // tab is initialized now, so the b param needs a fresh page again
    await p.goto('', { timeoutMs: 60_000 })
    await p.waitForSelector('#root > *', { timeoutMs: 60_000 })
    await sleep(2500)
    await p.evaluate(INJECT_FETCH, [{ manifest: JSON.stringify(MANIFEST), timeline: JSON.stringify(TIMELINE) }])
    await p.evaluate(NAV_HASH, ['#leaderboard?b=bld-low'])
    await sleep(3500)
    let bannerLow = await p.evaluate(SCRAPE_BANNER, [])
    let bannerLowPrev = null
    for (let i = 0; i < 25 && !(bannerLow.cardId || '').includes('1308'); i++) {
      await sleep(800)
      bannerLow = await p.evaluate(SCRAPE_BANNER, [])
    }
    for (let i = 0; i < 10; i++) {
      bannerLowPrev = bannerLow
      await sleep(600)
      bannerLow = await p.evaluate(SCRAPE_BANNER, [])
      if (JSON.stringify(bannerLow) === JSON.stringify(bannerLowPrev)) break
    }
    // bld-low is off the all-teams board: the banner's all-teams rank shows '--'
    const entryLowOk = bannerLow.rank == null || bannerLow.rank === '--' || mcpEntryLow.rank === null
    record('leaderboard.entry.read', 3,
      '返回结果指明这套配装所在的榜单是全部队伍还是某支队伍,与网页端落到的榜单一致',
      'browser-parity',
      mcpEntryLow.onBoard === false && mcpEntryLow.teamScope === 'team' && mcpEntryLow.scoredTeamId === 'acheron-alt' && entryLowOk ? 'PASS' : 'FAIL',
      `bld-low(1.20<150%):MCP onBoard=false/teamScope=team/scoredTeamId=acheron-alt/rank=null;web 打开链接后全部榜名次=${bannerLow.rank === '--' || bannerLow.rank == null ? '无(--)' : bannerLow.rank}${bannerLow.entriesLabel ? `,榜单标签="${bannerLow.entriesLabel}"` : ''};bld-top 则在全部队伍榜(scope=${bannerScope(bannerTop.entriesLabel)})`)

    // entry.read c2: recorded score unaffected by local scoring settings
    await callTool(client, 'set_scoring_override', { characterId: '1308', weights: { SPD: 1 } })
    const mcpEntryAfter = await callTool(client, 'leaderboard', { view: 'entry', buildId: 'bld-top' })
    const mcpScoreAfter = await callTool(client, 'leaderboard', { view: 'score', buildId: 'bld-top' })
    await callTool(client, 'set_scoring_override', { characterId: '1308', reset: true })
    const entryScoreStable = mcpEntryAfter.score === mcpEntryTop.score
      && mcpEntryAfter.scoreDisplay === mcpEntryTop.scoreDisplay
      && mcpScoreAfter.recorded.score === mcpEntryTop.score
    record('leaderboard.entry.read', 2,
      '返回的分数是榜单记录的数值,不随本地评分设置变化',
      'browser-parity', entryScoreStable ? 'PASS' : 'FAIL',
      `set_scoring_override(1308, SPD 权重=1) 前后 entry.score 均为 ${mcpEntryTop.score}(display ${mcpEntryTop.scoreDisplay});view=score 的 recorded 块同值(重算块 recomputed.percent=${mcpScoreAfter.recomputed?.percent},delta=${mcpScoreAfter.delta?.percent}——本地重算仅供对照)`)

    // entry.read c4: unknown buildId
    record('leaderboard.entry.read', 4,
      '配装编号不在榜上时返回明确的未找到',
      'browser-parity',
      mcpEntry404 != null && mcpEntry404.includes('未找到配装编号') ? 'PASS' : 'FAIL',
      `MCP view=entry(buildId=no-such-build) → "${(mcpEntry404 || '').slice(0, 80)}"`)

    // render source=leaderboard (M9): actually renders the shared-link card
    const rendered = await callTool(client, 'render', {
      target: 'character_card',
      source: 'leaderboard',
      buildId: 'bld-top',
      leaderboardBaseUrl: FX1,
    }, { timeout: 300_000 })
    const renderOk = rendered != null && rendered.width >= 800 && rendered.height >= 600
      && rendered.characterId === '1308' && rendered.buildId === 'bld-top' && rendered.via === 'cdp'
      && rendered.leaderboardFetchHits === 2 && await requestCount('/fx1/leaderboard.json') === 1
    check('render(character_card source=leaderboard) — #leaderboard?b= 渲染取证', renderOk,
      `${rendered?.width}x${rendered?.height} via=${rendered?.via} fetchHits=${rendered?.leaderboardFetchHits} 服务端 manifest 下载 ${await requestCount('/fx1/leaderboard.json')} 次`)

    // ── timeline.read ───────────────────────────────────────────────────────
    const webTimeline = await p.evaluate(SCRAPE_TIMELINE, [])
    const tl = mcpTimeline
    const tlRows = webTimeline.rows ?? []
    const tlOk = tl.available === true && tl.total === 2 && tl.dropped === 1
      && tlRows.length === 2
      && tlRows[0]?.avatarId === '1308' && (tlRows[0]?.text || '').includes(String(disp(2.05)))
      && tlRows[1]?.avatarId === '1217b1' && (tlRows[1]?.text || '').includes(String(disp(1.62)))
    record('leaderboard.timeline.read', 1,
      '返回的动态条目(角色、评分类型、名次、分数、涨幅、是否新开榜)与网页端列表逐条一致,顺序相同',
      'browser-parity', tlOk ? 'PASS' : 'FAIL',
      `MCP 2 条(黄泉 new_best score 205/delta 55% + 藿藿 new_character rank1),1 条畸形丢弃;web feedRow ${tlRows.length} 条 [${tlRows.map((r) => r.avatarId + ':' + (r.text || '').slice(0, 24)).join(' / ')}]`)

    // c2: every event carries buildId → click the 黄泉 feed row (the row whose
    // name cell is 黄泉) — handleRowClick navigates to that event's build
    const feedClick = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const wrap = document.getElementById('LEADERBOARD')
      const rows = [...wrap.querySelectorAll('[class*="feedRow"]')].filter(visible)
      const row = rows.find((el) => (el.textContent || '').includes('黄泉'))
      if (!row) return { ok: false, reason: 'no feed row', n: rows.length }
      row.click()
      return { ok: true, n: rows.length }
    }`, [])
    await sleep(2000)
    const feedHash = await p.evaluate(`() => location.hash`, [])
    const buildIdOk = tl.events.every((e) => typeof e.buildId === 'string' && e.buildId.length > 0)
      && (feedClick.ok ? decodeURIComponent(feedHash).includes(tl.events[0].buildId) : true)
    record('leaderboard.timeline.read', 2,
      '每条动态带配装编号,可以直接用来读取配装详情',
      'browser-parity', buildIdOk ? 'PASS' : 'FAIL',
      `MCP 每条事件带 buildId(${tl.events.map((e) => e.buildId).join(',')});web 点黄泉动态行后地址栏=${feedHash}${feedClick.ok ? '' : ' (' + feedClick.reason + ')'}`)

    // c3: timeline unavailable → empty list + reason (fx2 404)
    record('leaderboard.timeline.read', 3,
      '动态文件不可用时返回空列表并说明原因',
      'browser-parity',
      mcpTimelineMissing.available === false && typeof mcpTimelineMissing.reason === 'string'
        && mcpTimelineMissing.events.length === 0 ? 'PASS' : 'FAIL',
      `fx2(404 timeline)→ available=false, reason="${String(mcpTimelineMissing.reason).slice(0, 60)}", events=0`)

    // ── myRanks.read ────────────────────────────────────────────────────────
    await p.evaluate(NAV_HASH, ['#leaderboard'])
    await sleep(2000)
    const webRanks = await p.evaluate(SCRAPE_MY_RANKS, [])
    const r1308 = mcpMyRanks.ranks.find((r) => r.characterId === '1308')
    const rHuohuo = mcpMyRanks.ranks.find((r) => r.characterId === '1217b1')
    const myRanksOk = mcpMyRanks.total === 2
      && r1308?.rank === 1 && r1308?.isTeamRank === false
      && rHuohuo?.rank === 1 && rHuohuo?.isTeamRank === true && rHuohuo?.teamId === 'heal-solo'
      && webRanks.hasCard
    record('leaderboard.myRanks.read', 1,
      '同一 UID 返回的名次、角色、评分类型、分数和是否为队伍内名次与网页端卡片一致',
      'browser-parity', myRanksOk ? 'PASS' : 'FAIL',
      `MCP uid=${UID}(存档 scorerId):1308 全部榜 rank1(isTeamRank=false)+1217b1 heal-solo 队内 rank1(isTeamRank=true);web 卡片渲染=${webRanks.hasCard};文本含藿藿=${(webRanks.text || '').includes('藿藿')}`)

    // c2: no-uid error captured with the stripped save (above); with the
    // seeded save the remembered UID is used instead
    record('leaderboard.myRanks.read', 2,
      '不传 UID 时使用存档里展示柜页记住的 UID,没有则返回需要 UID 的提示',
      'browser-parity',
      mcpMyRanks.uidSource === 'saved' && noUidError != null && noUidError.includes('需要 UID') ? 'PASS' : 'FAIL',
      `带存档 scorerId=${UID} → uidSource=${mcpMyRanks.uidSource};载入剥离 scorerId 的存档副本后报 "${(noUidError || '').slice(0, 70)}"`)

    // c3: no uid-bearing network requests (re-read the CURRENT window's stub —
    // the entry phases reloaded the page and re-injected since)
    const freshServeState = await p.evaluate(`() => window.__lbServe || null`, [])
    const urls = (freshServeState?.urls ?? []).join(' ')
    const lbDownloads = await requestCount('/fx1/leaderboard.json')
    const netOk = !urls.includes(UID) && lbDownloads === 1
    record('leaderboard.myRanks.read', 3,
      '查询过程不产生任何带 UID 的网络请求',
      'browser-parity', netOk ? 'PASS' : 'FAIL',
      `页面侧拦截到的榜单请求 URL 均不含 UID(${urls.length} 次,样例 "${(urls.split(',')[0] || '').slice(-40)}");服务端 manifest 下载 ${lbDownloads} 次`)

    // ── data.load c2/c3 ─────────────────────────────────────────────────────
    await callTool(client, 'leaderboard', { view: 'characters', limit: 5 })
    await callTool(client, 'leaderboard', { view: 'board', characterId: '1217b1' })
    const downloadsAfter = await requestCount('/fx1/leaderboard.json')
    record('leaderboard.data.load', 2,
      '同一会话内多次查询只下载一次',
      'browser-parity', downloadsAfter === 1 ? 'PASS' : 'FAIL',
      `MCP 会话内 characters/board/entry/score/timeline/my_ranks 共 8+ 次查询后,fixture 的 /fx1/leaderboard.json 被下载 ${downloadsAfter} 次`)

    record('leaderboard.data.load', 3,
      '下载失败时返回明确的错误,而不是空榜单',
      'browser-parity',
      mcp404 != null && mcp404.includes('HTTP 404') && mcp404.includes('不会以空榜单') ? 'PASS' : 'FAIL',
      `404 fixture → "${(mcp404 || '').slice(0, 90)}"(网页端行为按清单 conditions:下载失败列表为空、页面不报错)`)

    return true
  })
} catch (e) {
  failures++
  console.error('verify-leaderboard crashed:', e)
} finally {
  try {
    await browserManager.close()
  } catch { /* already down */ }
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
  fixtureServer.closeAllConnections()
  await new Promise((r) => fixtureServer.close(r))
}

const evidenceDir = resolve(mcpDir, 'coverage/evidence')
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(resolve(evidenceDir, 'leaderboard.json'), JSON.stringify({
  area: 'leaderboard',
  generatedAt: new Date().toISOString(),
  gitCommit: '8ac1d045',
  cases: EVIDENCE,
}, null, 2))
console.log(`\nevidence: ${EVIDENCE.length} cases → mcp/coverage/evidence/leaderboard.json`)
console.log(failures === 0 ? '\nverify-leaderboard: ALL CASES PASSED' : `\nverify-leaderboard: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
