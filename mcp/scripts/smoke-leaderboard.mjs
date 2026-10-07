// End-to-end smoke test for the leaderboard read-only data domain (M6-D1).
//
// Zero real-network dependency: a local http server hosts hand-built fixtures
// shaped exactly like the published files (reverse-engineered from the upstream
// parser path — leaderboardDataLoader.ts manifest { generatedAt, characters:
// {id: base64-gzip(PublicCharacterData)} }, PublicCharacterData.configs →
// teams/teamsById/entries with MinifiedCharacter payloads, timeline wire
// events). The server process is booted with HSR_MCP_LEADERBOARD_URL pointing
// at the primary fixture so source=auto exercises env resolution.
//
// Walks every view plus the failure contract:
//   characters  — groups/rank order/score display/public counts, search + tag
//   board       — default config resolution, dedupe, 150% cutoff, top-100 cap,
//                 team & eidolon filters (pre-filter rank numbers), pagination,
//                 Chinese error paths (unknown character/config/team/growing)
//   entry       — on-board rank + AEON, below-cutoff build (rank null, team
//                 board), relic expansion (setCounts, substats), not-found
//   timeline    — new_best delta clamped at 150%, new_character flag, dropped
//                 malformed count, unavailable-with-reason (404 timeline file)
//   my_ranks    — all-teams rank vs team-only rank (top-100 cap pushes the
//                 user's build off the merged board), uid validation errors
//   cache       — one manifest/timeline download per base across all views,
//                 version/fetchedAt stability, per-base isolation
//   failures    — 404 / malformed JSON / corrupt base64 / timeout all throw
//                 Chinese errors (never an empty-board success); an empty
//                 manifest is a legitimate success (zero-data fallback rows)
//   network     — optional one-shot probe of the real upstream address, gated
//                 by SMOKE_LEADERBOARD_NETWORK_PROBE=1 (SKIP, not FAIL, offline)
//
// Usage: node scripts/smoke-leaderboard.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  createHash,
} from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
} from 'node:fs'
import {
  createServer,
} from 'node:http'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')

// ── helpers ──────────────────────────────────────────────────────────────────

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

async function expectToolError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

// Browser-hash parity (leaderboardBrowserHash.ts): uidHash = sha256(uid),
// candidateId = sha256(JSON.stringify(`${uidHash}#${characterId}`)).slice(0, 12).
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const UID = '100010001'
const UID_HASH = sha256(UID)
const candidateOf = (characterId) => sha256(JSON.stringify(`${UID_HASH}#${characterId}`)).slice(0, 12)

// RankListPanel display parity: truncate10ths(score * 100) = floor(x*10)/10.
const disp = (score) => Math.floor(score * 100 * 10) / 10

const FETCHED_AT = Date.UTC(2026, 8, 30) // 2026-09-30, arbitrary fixed epoch

function relic(tid, level, mainAffixId, subs) {
  return { t: tid, v: level, m: mainAffixId, u: subs }
}

// MinifiedCharacter for Acheron: signature light cone 23014 S1, 2 real relics
// (set 101 = Passerby of Wandering Cloud, Head + Hands, real affix ids).
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

function entry(buildId, candidateId, score, minified, teammates, teamId, overrides = {}) {
  return {
    rank: 0, // wire rank is ignored — deriveVisibleEntries recomputes ranks
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

// ── fixture 1: full dataset ─────────────────────────────────────────────────

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
              entry('bld-dup', candidateOf('1308'), 1.30, { a: 1308, r: 0 }, TEAM_A, 'acheron-std'), // same candidate → deduped
            ],
          },
          'acheron-alt': {
            totalEntries: 2,
            entries: [
              entry('bld-mid', 'aaaaaaaaaa02', 1.55, { a: 1308, r: 2, q: { t: 23014, r: 1 } }, TEAM_A, 'acheron-alt'),
              entry('bld-low', 'aaaaaaaaaa01', 1.20, { a: 1308, r: 1, q: { t: 23014, r: 1 } }, TEAM_A, 'acheron-alt'),
            ],
          },
        },
        totalEntries: 5,
      },
    },
  }
}

function buildHuohuoData() {
  // 100 filler entries outrank the user's 1.62 build on the merged heal board,
  // pushing it out of the top-100 — exactly the "only reachable on its own
  // team board" case lookupUserLeaderboardRanks resolves via the team scan.
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

const FIXTURE_1_MANIFEST = {
  generatedAt: '2026-10-01T00:00:00Z',
  characters: {
    1308: gzipB64(buildAcheronData()),
    '1217b1': gzipB64(buildHuohuoData()),
    1102: gzipB64({ configs: {} }), // in the manifest but no boards → 数据不足
  },
}

const FIXTURE_1_TIMELINE = {
  schemaVersion: 2,
  generatedAt: '2026-10-05T12:00:00Z',
  events: [
    {
      type: 'new_best',
      characterId: '1308',
      configType: 'dps',
      candidateId: candidateOf('1308'),
      date: '2026-10-05T10:00:00Z',
      score: 2.05,
      previousScore: 1.2, // below the 150% floor → delta must clamp at 1.5
      rank: 1,
      previousRank: 2,
      buildId: 'bld-top',
    },
    {
      type: 'new_character',
      characterId: '1217b1',
      configType: 'heal',
      candidateId: candidateOf('1217b1'),
      date: '2026-10-04T08:00:00Z',
      score: 1.62,
      rank: 1,
      entryCount: 101,
      buildId: 'bld-heal-user',
    },
    { type: 'new_best', characterId: '1308' }, // malformed → dropped
  ],
}

// ── fixture 2: secondary base (cache isolation + timeline 404) ─────────────

const FIXTURE_2_MANIFEST = {
  generatedAt: '2026-09-01T00:00:00Z',
  characters: {
    1308: gzipB64({
      configs: {
        dps: {
          teams: [{ teamId: 'std', teammates: [{ characterId: '1005' }] }],
          teamsById: {
            std: {
              totalEntries: 1,
              entries: [entry('bld-fx2', 'cccccccccc01', 1.77, { a: 1308, r: 0 }, TEAM_A, 'std')],
            },
          },
          totalEntries: 1,
        },
      },
    }),
  },
}

// ── local fixture http server ───────────────────────────────────────────────

const requestCounts = new Map()
const pendingTimers = new Set()

const fixtureServer = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://fixture.local').pathname
  requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1)

  const send = (status, body, contentType = 'application/json') => {
    res.writeHead(status, { 'content-type': contentType })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  if (pathname.startsWith('/__requests')) {
    const wanted = new URL(req.url ?? '/', 'http://fixture.local').searchParams.get('path') ?? ''
    return send(200, { path: wanted, count: requestCounts.get(wanted) ?? 0 })
  }

  const [prefix, file] = pathname.split('/').filter(Boolean)
  const routes = {
    fx1: {
      'leaderboard.json': () => send(200, FIXTURE_1_MANIFEST),
      'leaderboard-timeline.json': () => send(200, FIXTURE_1_TIMELINE),
    },
    fx2: {
      'leaderboard.json': () => send(200, FIXTURE_2_MANIFEST),
      'leaderboard-timeline.json': () => send(404, { error: 'no timeline here' }),
    },
    empty: {
      'leaderboard.json': () => send(200, { generatedAt: '2026-08-01T00:00:00Z', characters: {} }),
    },
    missing: {
      'leaderboard.json': () => send(404, { error: 'not found' }),
    },
    bad: {
      'leaderboard.json': () => send(200, '{not valid json', 'text/plain'),
    },
    corrupt: {
      'leaderboard.json': () => send(200, { generatedAt: 'x', characters: { 1308: '###not-base64###' } }),
    },
    slow: {
      'leaderboard.json': () => {
        const timer = setTimeout(() => send(200, FIXTURE_1_MANIFEST), 5_000)
        pendingTimers.add(timer)
      },
    },
  }

  const handler = routes[prefix]?.[file]
  if (handler) return handler()
  send(404, { error: `no fixture route for ${pathname}` })
})

await new Promise((resolvePromise) => fixtureServer.listen(0, '127.0.0.1', resolvePromise))
const fixturePort = fixtureServer.address().port
const FX1 = `http://127.0.0.1:${fixturePort}/fx1`
const FX2 = `http://127.0.0.1:${fixturePort}/fx2`

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-leaderboard-`)

// ── boot (HSR_MCP_LEADERBOARD_URL → fx1 so source=auto resolves to the fixture) ──

const client = new Client({ name: 'smoke-leaderboard', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_LEADERBOARD_URL: FX1,
  },
  stderr: 'inherit',
})
await client.connect(transport)

const requestCount = async (path) => {
  const response = await fetch(`http://127.0.0.1:${fixturePort}/__requests?path=${encodeURIComponent(path)}`)
  const body = await response.json()
  return body.count
}

try {
  // ── 1. tool surface ────────────────────────────────────────────────────────
  const tools = await client.listTools()
  check('tool leaderboard registered', tools.tools.map((t) => t.name).includes('leaderboard'))

  // ── 2. view=characters (auto source → env → fx1) ───────────────────────────
  const chars = await callTool(client, 'leaderboard', { view: 'characters', limit: 200 })
  check('auto source resolves env fixture', chars.source === 'url' && chars.baseUrl === FX1, `${chars.source} ${chars.baseUrl}`)
  check('version is the manifest generatedAt', chars.version === '2026-10-01T00:00:00Z', chars.version)
  check('fetchedAt is a ms epoch', Number.isFinite(chars.fetchedAt) && chars.fetchedAt > 0)

  const acheronRow = chars.characters.find((c) => c.characterId === '1308')
  const huohuoRow = chars.characters.find((c) => c.characterId === '1217b1')
  const seeleRow = chars.characters.find((c) => c.characterId === '1102')
  check(
    '1308 is an active row with rank 2 (1217b1 tops at 2.62)',
    acheronRow?.group === 'active' && acheronRow?.rank === 2,
    JSON.stringify([huohuoRow?.rank, acheronRow?.rank]),
  )
  check(
    '1217b1 ranks 1 with the filler top score and 101 entries',
    huohuoRow?.rank === 1 && huohuoRow?.topScore === 1.63 + 99 * 0.01 && huohuoRow?.entryCount === 101,
    JSON.stringify({ rank: huohuoRow?.rank, topScore: huohuoRow?.topScore, entryCount: huohuoRow?.entryCount }),
  )
  check('publicEntryCount caps at 100 for 1217b1 (100 fillers + user ≥150%)', huohuoRow?.publicEntryCount === 100, String(huohuoRow?.publicEntryCount))
  check(
    '1308 counts: topScore 2.05, entries 5, public 3',
    acheronRow?.topScore === 2.05 && acheronRow?.entryCount === 5 && acheronRow?.publicEntryCount === 3,
    JSON.stringify({ topScore: acheronRow?.topScore, entryCount: acheronRow?.entryCount, publicEntryCount: acheronRow?.publicEntryCount }),
  )
  check('topScoreDisplay uses truncate10ths (2.05 → 204.9)', acheronRow?.topScoreDisplay === 204.9, String(acheronRow?.topScoreDisplay))
  check('configTypes are public spellings', JSON.stringify(acheronRow?.configTypes) === '["dps"]' && JSON.stringify(huohuoRow?.configTypes) === '["heal"]')
  check(
    'manifest character without boards lands in 数据不足 (rank null)',
    seeleRow?.group === 'insufficient_data' && seeleRow?.rank === null && seeleRow?.entryCount === 0,
    JSON.stringify(seeleRow),
  )
  check(
    'configTypeCounts carry the chip counts',
    (chars.configTypeCounts?.dps ?? 0) >= 1 && (chars.configTypeCounts?.heal ?? 0) >= 1,
    JSON.stringify(chars.configTypeCounts),
  )

  const searched = await callTool(client, 'leaderboard', { view: 'characters', search: 'acheron', limit: 200 })
  check('search "acheron" matches exactly 1308', searched.total === 1 && searched.characters[0]?.characterId === '1308', `${searched.total} rows`)

  const dpsFiltered = await callTool(client, 'leaderboard', { view: 'characters', configType: 'dps', limit: 200 })
  const dpsIds = dpsFiltered.characters.map((c) => c.characterId)
  check('dps tag filter keeps 1308, drops 1217b1/1102', dpsIds.includes('1308') && !dpsIds.includes('1217b1') && !dpsIds.includes('1102'))

  // ── 3. view=board ─────────────────────────────────────────────────────────
  const board = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308' })
  check('default config resolves to dps without request', board.configType === 'dps' && board.configTypeRequested === false)
  check(
    'board rows: top-3 after dedupe + 150% cutoff (dup 1.30 and low 1.20 gone)',
    board.total === 3 && board.rows.map((r) => r.buildId).join() === 'bld-top,bld-e6,bld-mid'
      && board.rows.map((r) => r.rank).join() === '1,2,3',
    JSON.stringify(board.rows.map((r) => [r.rank, r.buildId, r.score])),
  )
  check('board score display parity (2.05 → 204.9)', board.rows[0].scoreDisplay === disp(2.05) && board.rows[0].scoreDisplay === 204.9)
  check(
    'board row shape: eidolon group, light cone, 3 teammates',
    board.rows[0].characterEidolon === 0 && board.rows[0].eidolonGroup === 'e0'
      && board.rows[0].lightCone?.id === '23014' && board.rows[0].lightCone?.superimposition === 1
      && board.rows[0].team.length === 3 && board.rows[0].team[0].characterId === '1005',
  )
  check(
    'teams list mirrors the dropdown (ids + teammate names)',
    board.teams.map((t) => t.teamId).join() === 'acheron-std,acheron-alt'
      && board.teams[0].teammates.length === 3 && typeof board.teams[0].teammates[0].name === 'string',
  )

  const boardE6 = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308', characterEidolon: 'e6' })
  check(
    'eidolon filter keeps pre-filter rank numbers (e6 → rank 2 only)',
    boardE6.total === 1 && boardE6.rows[0].buildId === 'bld-e6' && boardE6.rows[0].rank === 2,
    JSON.stringify(boardE6.rows.map((r) => [r.rank, r.buildId])),
  )

  const boardTeam = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308', teamId: 'acheron-alt' })
  check(
    'team filter re-ranks within the team (1.55 rank 1; 1.20 below cutoff)',
    boardTeam.teamId === 'acheron-alt' && boardTeam.total === 1 && boardTeam.rows[0].buildId === 'bld-mid' && boardTeam.rows[0].rank === 1,
  )

  const boardPaged = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308', offset: 1, limit: 1 })
  check('board pagination slices the filtered rows', boardPaged.total === 3 && boardPaged.rows.length === 1 && boardPaged.rows[0].buildId === 'bld-e6')

  const huohuoBoard = await callTool(client, 'leaderboard', { view: 'board', characterId: '1217b1' })
  check(
    'top-100 cap on the merged board drops the 1.62 build (101 qualified)',
    huohuoBoard.total === 100 && !huohuoBoard.rows.some((r) => r.buildId === 'bld-heal-user'),
  )

  const noConfig = await expectToolError(client, 'leaderboard', { view: 'board', characterId: '1102' })
  check('board of a 数据不足 character errors (Chinese)', noConfig.includes('没有任何可用的评分类型') && noConfig.includes('数据不足'), noConfig.slice(0, 90))
  const unknownChar = await expectToolError(client, 'leaderboard', { view: 'board', characterId: '9999' })
  check(
    'unknown character errors and lists data-bearing ids (Chinese)',
    unknownChar.includes('不在榜单数据') && unknownChar.includes('1308'),
    unknownChar.slice(0, 90),
  )
  const badConfig = await expectToolError(client, 'leaderboard', { view: 'board', characterId: '1308', configType: 'heal' })
  check('unavailable config type errors (Chinese)', badConfig.includes('没有评分类型 heal') && badConfig.includes('dps'), badConfig.slice(0, 90))
  const badTeam = await expectToolError(client, 'leaderboard', { view: 'board', characterId: '1308', teamId: 'zzz' })
  check('unknown team errors listing valid ids (Chinese)', badTeam.includes('队伍编号') && badTeam.includes('acheron-std'), badTeam.slice(0, 90))
  const missingChar = await expectToolError(client, 'leaderboard', { view: 'board' })
  check('board without characterId errors (Chinese)', missingChar.includes('characterId'))

  // ── 4. view=entry ─────────────────────────────────────────────────────────
  const entryTop = await callTool(client, 'leaderboard', { view: 'entry', buildId: 'bld-top' })
  check(
    'entry on the all-teams board: rank 1, AEON, recorded score',
    entryTop.onBoard === true && entryTop.teamScope === 'all' && entryTop.rank === 1 && entryTop.score === 2.05
      && entryTop.scoreDisplay === 204.9 && entryTop.aeon === true,
    JSON.stringify({ rank: entryTop.rank, score: entryTop.score, aeon: entryTop.aeon }),
  )
  check(
    'entry basics: character, config, eidolon, light cone, team',
    entryTop.characterId === '1308' && entryTop.configType === 'dps' && entryTop.characterEidolonNumber === 0
      && entryTop.lightCone?.id === '23014' && entryTop.lightCone?.superimposition === 1 && entryTop.team.length === 3,
  )
  check(
    'entry passes through sim scores, deprioritizeBuffs and fetchedAt',
    entryTop.baselineSimScore === 1000 && entryTop.benchmarkSimScore === 2000 && entryTop.maximumSimScore === 3000
      && entryTop.deprioritizeBuffs === true && entryTop.fetchedAtEpoch === FETCHED_AT,
  )
  check(
    'entry relics expand through CharacterConverter (set 101 x2, SPD substat)',
    Object.keys(entryTop.relics).sort().join() === 'Hands,Head'
      && entryTop.setCounts['Passerby of Wandering Cloud'] === 2
      && entryTop.relics.Head.substats.length === 2 && entryTop.relics.Head.substats[0].stat === 'SPD',
    JSON.stringify({ parts: Object.keys(entryTop.relics), setCounts: entryTop.setCounts }),
  )

  const entryLow = await callTool(client, 'leaderboard', { view: 'entry', buildId: 'bld-low' })
  check(
    'below-cutoff build: data returned, rank null, falls to its scored team board',
    entryLow.onBoard === false && entryLow.rank === null && entryLow.teamScope === 'team' && entryLow.scoredTeamId === 'acheron-alt'
      && entryLow.score === 1.2 && entryLow.aeon === false,
    JSON.stringify({ onBoard: entryLow.onBoard, rank: entryLow.rank, scope: entryLow.teamScope }),
  )

  const entry404 = await expectToolError(client, 'leaderboard', { view: 'entry', buildId: 'no-such-build' })
  check('unknown buildId errors explicitly (Chinese)', entry404.includes('未找到配装编号'), entry404.slice(0, 90))

  // ── 5. view=timeline ──────────────────────────────────────────────────────
  const timeline = await callTool(client, 'leaderboard', { view: 'timeline' })
  check(
    'timeline: 2 valid events, 1 malformed dropped',
    timeline.available === true && timeline.total === 2 && timeline.dropped === 1,
    JSON.stringify({ total: timeline.total, dropped: timeline.dropped }),
  )
  check(
    'new_best delta clamps previousScore at 150% ((2.05-1.5)*100 → 55)',
    timeline.events[0].type === 'new_best' && timeline.events[0].scoreDeltaPercent === 55 && timeline.events[0].previousScore === 1.2,
    JSON.stringify(timeline.events[0]),
  )
  check(
    'new_character flagged with entryCount + buildId for entry.read',
    timeline.events[1].type === 'new_character' && timeline.events[1].isNewCharacter === true && timeline.events[1].entryCount === 101
      && timeline.events[1].buildId === 'bld-heal-user',
  )
  check(
    'timeline rows carry character names and 12-hex candidate ids',
    timeline.events[0].characterName === 'Acheron' && /^[0-9a-f]{12}$/.test(timeline.events[0].candidateId),
  )
  const timelinePaged = await callTool(client, 'leaderboard', { view: 'timeline', offset: 1, limit: 5 })
  check('timeline pagination', timelinePaged.total === 2 && timelinePaged.events.length === 1 && timelinePaged.events[0].type === 'new_character')

  // ── 6. view=my_ranks ──────────────────────────────────────────────────────
  const myRanks = await callTool(client, 'leaderboard', { view: 'my_ranks', uid: UID })
  const rank1308 = myRanks.ranks.find((r) => r.characterId === '1308')
  const rankHuohuo = myRanks.ranks.find((r) => r.characterId === '1217b1')
  check(
    'my_ranks: all-teams rank for 1308',
    rank1308?.isTeamRank === false && rank1308?.teamId === 'all' && rank1308?.rank === 1 && rank1308?.buildId === 'bld-top',
    JSON.stringify(rank1308),
  )
  check(
    'my_ranks: team-only rank for 1217b1 (pushed off the merged top-100)',
    rankHuohuo?.isTeamRank === true && rankHuohuo?.teamId === 'heal-solo' && rankHuohuo?.rank === 1 && rankHuohuo?.buildId === 'bld-heal-user',
    JSON.stringify(rankHuohuo),
  )
  check('my_ranks total', myRanks.total === 2 && myRanks.uid === UID && myRanks.uidSource === 'param')

  const badUid = await expectToolError(client, 'leaderboard', { view: 'my_ranks', uid: '12345' })
  check('invalid uid rejected (Chinese)', badUid.includes('无效的 UID') && badUid.includes('9 位数字'), badUid.slice(0, 90))
  const noUid = await expectToolError(client, 'leaderboard', { view: 'my_ranks' })
  check('missing uid (no showcase memory) rejected (Chinese)', noUid.includes('需要 UID'), noUid.slice(0, 90))

  // ── 7. cache: one download per base, stable version/fetchedAt ─────────────
  check(
    'manifest downloaded exactly once across all fx1 views',
    await requestCount('/fx1/leaderboard.json') === 1,
    `${await requestCount('/fx1/leaderboard.json')} downloads`,
  )
  check('timeline downloaded exactly once', await requestCount('/fx1/leaderboard-timeline.json') === 1)
  const charsAgain = await callTool(client, 'leaderboard', { view: 'characters', limit: 1 })
  check(
    'second characters call reuses cache (same version/fetchedAt, still 1 download)',
    charsAgain.version === chars.version && charsAgain.fetchedAt === chars.fetchedAt && await requestCount('/fx1/leaderboard.json') === 1,
  )

  // ── 8. second base: cache isolation + timeline unavailable ────────────────
  const chars2 = await callTool(client, 'leaderboard', { view: 'characters', source: 'url', baseUrl: `${FX2}/`, limit: 200 })
  check(
    'second base fetched independently (trailing slash normalized)',
    chars2.baseUrl === FX2 && chars2.version === '2026-09-01T00:00:00Z',
    `${chars2.baseUrl} ${chars2.version}`,
  )
  const board2 = await callTool(client, 'leaderboard', { view: 'board', characterId: '1308', source: 'url', baseUrl: FX2 })
  check('second base board works', board2.total === 1 && board2.rows[0].buildId === 'bld-fx2' && board2.rows[0].score === 1.77)
  check('fx1 cache untouched by fx2 calls', await requestCount('/fx1/leaderboard.json') === 1)
  const timeline2 = await callTool(client, 'leaderboard', { view: 'timeline', source: 'url', baseUrl: FX2 })
  check(
    'timeline 404 → available:false with reason, NOT a thrown error',
    timeline2.available === false && typeof timeline2.reason === 'string' && timeline2.reason.includes('不可用')
      && timeline2.events.length === 0 && timeline2.total === 0,
    String(timeline2.reason).slice(0, 90),
  )

  // ── 9. failure contract: never an empty-board success ─────────────────────
  const http404 = await expectToolError(client, 'leaderboard', { view: 'characters', source: 'url', baseUrl: 'http://127.0.0.1:9999/nowhere' })
  check('unreachable base throws Chinese error (not empty board)', http404.includes('失败'), http404.slice(0, 90))
  const missingFile = await expectToolError(client, 'leaderboard', {
    view: 'characters',
    source: 'url',
    baseUrl: `http://127.0.0.1:${fixturePort}/missing`,
  })
  check('HTTP 404 on manifest throws (Chinese)', missingFile.includes('HTTP 404') && missingFile.includes('不会以空榜单'), missingFile.slice(0, 90))
  const badJson = await expectToolError(client, 'leaderboard', {
    view: 'characters',
    source: 'url',
    baseUrl: `http://127.0.0.1:${fixturePort}/bad`,
  })
  check('malformed JSON throws (Chinese)', badJson.includes('不是合法 JSON'), badJson.slice(0, 90))
  const corrupt = await expectToolError(client, 'leaderboard', {
    view: 'characters',
    source: 'url',
    baseUrl: `http://127.0.0.1:${fixturePort}/corrupt`,
  })
  check('corrupt base64 payload throws (Chinese)', corrupt.includes('base64') || corrupt.includes('解压'), corrupt.slice(0, 90))
  const slowStart = Date.now()
  const timeoutErr = await expectToolError(client, 'leaderboard', {
    view: 'characters',
    source: 'url',
    baseUrl: `http://127.0.0.1:${fixturePort}/slow`,
    timeoutMs: 1000,
  })
  check(
    'timeout throws within ~1s (Chinese)',
    timeoutErr.includes('超时') && Date.now() - slowStart < 4000,
    `${Date.now() - slowStart}ms: ${timeoutErr.slice(0, 60)}`,
  )
  const badUrl = await expectToolError(client, 'leaderboard', { view: 'characters', source: 'url', baseUrl: 'ftp://example.com/x' })
  check('non-http baseUrl rejected (Chinese)', badUrl.includes('http'), badUrl.slice(0, 90))

  // A genuinely empty manifest IS a legitimate success — but not "total 0": the
  // web merges metadata fallback characters, so it lists growing-only rows.
  const emptyBoard = await callTool(client, 'leaderboard', {
    view: 'characters',
    source: 'url',
    baseUrl: `http://127.0.0.1:${fixturePort}/empty`,
  })
  check(
    'empty manifest → success, every row zero-data (1308 present via metadata fallback, no scores)',
    emptyBoard.characters.length > 0 && emptyBoard.characters.every((c) => c.entryCount === 0 && c.topScore === 0 && c.publicEntryCount === 0)
      && emptyBoard.characters.some((c) => c.characterId === '1308')
      && emptyBoard.version === '2026-08-01T00:00:00Z',
    `${emptyBoard.characters.length} rows`,
  )
  const emptyBoardChar = await expectToolError(client, 'leaderboard', {
    view: 'board',
    characterId: '1308',
    source: 'url',
    baseUrl: `http://127.0.0.1:${fixturePort}/empty`,
  })
  check('board against an empty dataset errors (Chinese)', emptyBoardChar.includes('不在榜单数据'))

  // ── 10. optional real-network probe (SKIP offline, never FAIL) ────────────
  if (process.env.SMOKE_LEADERBOARD_NETWORK_PROBE === '1') {
    try {
      const probe = await callTool(client, 'leaderboard', { view: 'characters', source: 'network', limit: 5 })
      console.log(`[PASS] network probe: upstream manifest reachable (${probe.characters.length} rows, version ${probe.version})`)
    } catch (e) {
      console.log(`[SKIP] network probe: upstream unreachable in this environment — ${String(e).slice(0, 120)}`)
    }
  } else {
    console.log('[SKIP] network probe not requested (set SMOKE_LEADERBOARD_NETWORK_PROBE=1 to enable)')
  }
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
  for (const timer of pendingTimers) clearTimeout(timer)
  fixtureServer.closeAllConnections()
  await new Promise((resolvePromise) => fixtureServer.close(resolvePromise))
}

console.log(failures === 0 ? '\nsmoke-leaderboard: ALL CHECKS PASSED' : `\nsmoke-leaderboard: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
