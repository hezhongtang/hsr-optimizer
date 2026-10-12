// End-to-end smoke test for the imports + showcase tool surface.
//
// Spawns the built server over stdio and walks the import happy paths and
// error paths, fully offline:
//   import_scanner_json — union semantics (the erratum #5 core: a 1-relic
//     import into a 162-relic inventory must yield 163, never 1),
//     same-hash skip stats, existingCharactersOnly, level normalization,
//     dryRun (no store write, no disk write), strict-subset union anti-wipe,
//     partial union import equipment (an imported piece wins its slot; a slot
//     the file does not replace keeps the old piece), replace-mode shrink
//     (intentional upstream semantics), same-id supersession for stable-id
//     sources (a Reliquary Archiver relic re-imported after an in-game upgrade
//     keeps one record under its id: wearer + saved-build references, hash
//     twins, pre-existing duplicate ids; HSR-Scanner's positional ids never
//     supersede), parse errors
//     (i18n-localized version mismatch, wrong-tool shape, bad source, args).
//   import_hoyolab — minimal fixture walk-through (union add + character
//     creation + equipment) and a same-hash skip via an owner-matched relic.
//   fetch_showcase — error paths ONLY, never the network: global fetch is
//     stubbed through a --import preload that serves scripted responses for
//     /profile/ URLs (network/timeout/http/invalid_response/unsupported_
//     source/source_mismatch/empty_profile structured Chinese errors) plus
//     the malformed-uid throw path.
//   import_showcase — inline mihomo showcase fixture: relics mode (added
//     stats + prediction cross-check, no character upsert), character mode
//     (re-import updates in place, character created + 6 slots equipped),
//     markDirty debounced persistence to the loaded save file, cacheId
//     mismatch, and argument/conversion error paths.
//
// Everything persists into a temp directory (fresh save copies per phase +
// HSR_MCP_STATE_FILE); the repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-imports.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
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
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const repoGameDataPath = resolve(mcpDir, '../src/data/game_data.json')

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-imports-`)
const pristineSaveText = readFileSync(repoSampleSavePath, 'utf8')
const pristineSave = JSON.parse(pristineSaveText)
const gameData = JSON.parse(readFileSync(repoGameDataPath, 'utf8'))
const setIdByName = Object.fromEntries(gameData.relics.map((r) => [r.name, r.id]))

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

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

/** Text of a tool failure, whether it threw (handler error / zod) or came back isError. null when it did NOT fail. */
async function toolErrorText(client, name, args, options) {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, options)
    if (result.isError) return result.content?.[0]?.text ?? '(isError without text)'
    return null
  } catch (e) {
    return String(e?.message ?? e)
  }
}

async function expectToolError(name, args, pattern, label) {
  const text = await toolErrorText(client, name, args)
  check(
    label,
    text != null && pattern.test(text),
    text == null ? 'tool unexpectedly succeeded' : text.slice(0, 180),
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── fetch stub (offline showcase error paths) ────────────────────────────────
// A --import preload that replaces globalThis.fetch for /profile/ URLs only,
// serving responses scripted per-call through a spec file in the temp dir.
// Nothing in these flows may touch the network.
const specPath = `${tempDir}/fetch-spec.json`
const stubPath = `${tempDir}/stub-fetch.mjs`
function setFetchScenario(spec) {
  writeFileSync(specPath, JSON.stringify(spec))
}
setFetchScenario({ kind: 'ok', body: { source: 'mihomo', detailInfo: {} } })
writeFileSync(
  stubPath,
  `
import { readFileSync } from 'node:fs'
const realFetch = globalThis.fetch.bind(globalThis)
const specPath = ${JSON.stringify(specPath)}
globalThis.fetch = (url, init = {}) => {
  if (!String(url).includes('/profile/')) return realFetch(url, init)
  let spec
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'))
  } catch (e) {
    return Promise.reject(new TypeError('smoke fetch stub: unreadable spec: ' + e.message))
  }
  if (spec.kind === 'network') return Promise.reject(new TypeError('fetch failed (stubbed offline)'))
  if (spec.kind === 'timeout') {
    return new Promise((res, rej) => {
      const timer = setTimeout(
        () => res(new Response(JSON.stringify({ source: 'mihomo', detailInfo: {} }), { status: 200, headers: { 'content-type': 'application/json' } })),
        spec.ms ?? 60000,
      )
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        rej(init.signal.reason ?? new Error('aborted'))
      })
    })
  }
  const status = spec.status ?? 200
  const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body ?? {})
  return Promise.resolve(new Response(body, { status, headers: { 'content-type': spec.contentType ?? 'application/json' } }))
}
`,
)

// ── fixture builders ─────────────────────────────────────────────────────────

// Stat-name maps mirroring the upstream lookups (kelzFormatParser.tsx:428-465,
// hoyoLabFormatParser.tsx:232-254). Used to back-convert store relics into
// parser-input fixtures whose hashRelic() matches the stored original.
const SUBSTAT_KEY = {
  'ATK': 'ATK',
  'HP': 'HP',
  'DEF': 'DEF',
  'ATK%': 'ATK_',
  'HP%': 'HP_',
  'DEF%': 'DEF_',
  'SPD': 'SPD',
  'CRIT Rate': 'CRIT Rate_',
  'CRIT DMG': 'CRIT DMG_',
  'Effect Hit Rate': 'Effect Hit Rate_',
  'Effect RES': 'Effect RES_',
  'Break Effect': 'Break Effect_',
}
const MAINSTAT_KEY = {
  'HP%': 'HP',
  'ATK%': 'ATK',
  'DEF%': 'DEF',
  'SPD': 'SPD',
  'CRIT Rate': 'CRIT Rate',
  'CRIT DMG': 'CRIT DMG',
  'Effect Hit Rate': 'Effect Hit Rate',
  'Break Effect': 'Break Effect',
  'Energy Regeneration Rate': 'Energy Regeneration Rate',
  'Outgoing Healing Boost': 'Outgoing Healing Boost',
  'Physical DMG Boost': 'Physical DMG Boost',
  'Fire DMG Boost': 'Fire DMG Boost',
  'Ice DMG Boost': 'Ice DMG Boost',
  'Lightning DMG Boost': 'Lightning DMG Boost',
  'Wind DMG Boost': 'Wind DMG Boost',
  'Quantum DMG Boost': 'Quantum DMG Boost',
  'Imaginary DMG Boost': 'Imaginary DMG Boost',
}
const HL_STAT = {
  'HP': 27,
  'HP%': 32,
  'ATK': 29,
  'ATK%': 33,
  'DEF': 31,
  'DEF%': 34,
  'SPD': 51,
  'CRIT Rate': 52,
  'CRIT DMG': 53,
  'Effect Hit Rate': 56,
  'Effect RES': 57,
  'Break Effect': 59,
  'Energy Regeneration Rate': 54,
  'Outgoing Healing Boost': 55,
}
const FLAT_STATS = new Set(['HP', 'ATK', 'DEF', 'SPD'])

/** Store relic → kelz V4ParserRelic. `uid` becomes ageIndex (parseInt), so pass the store index for hash-stable relics. */
function scannerRelicFromStore(relic, uid, substatValueOverrides = {}) {
  const mainstat = relic.part === 'Head' ? 'HP' : relic.part === 'Hands' ? 'ATK' : MAINSTAT_KEY[relic.main.stat]
  if (mainstat == null) throw new Error(`no mainstat mapping for ${relic.part}/${relic.main.stat}`)
  const substats = relic.substats.map((s, i) => {
    const key = SUBSTAT_KEY[s.stat]
    if (key == null) throw new Error(`no substat mapping for ${s.stat}`)
    return { key, value: substatValueOverrides[i] ?? s.value }
  })
  return {
    set_id: setIdByName[relic.set],
    name: 'smoke relic',
    slot: relic.part,
    rarity: relic.grade,
    level: relic.enhance,
    mainstat,
    substats,
    location: '',
    lock: false,
    discard: false,
    _uid: uid,
  }
}

function scannerJson(relics, characters = [], lightCones = [], extra = {}) {
  return {
    source: 'HSR-Scanner',
    build: 'v1.2.0',
    version: 4,
    metadata: { uid: 100000001, trailblazer: 'Stelle' },
    gacha: { stellar_jade: 0, oneric_shards: 0 },
    materials: [],
    characters,
    light_cones: lightCones,
    relics,
    ...extra,
  }
}

function fixtureFile(name, json) {
  const p = `${tempDir}/${name}`
  writeFileSync(p, JSON.stringify(json))
  return p
}

let copyCounter = 0
/** Fresh pristine copy of the sample save; each phase loads its own so debounced flushes never pollute baselines. */
function freshSavePath() {
  const p = `${tempDir}/save-phase-${++copyCounter}.json`
  copyFileSync(repoSampleSavePath, p)
  return p
}

// Relic #0 of the pristine save: a 5★ Head (main HP) — the simplest faithful
// back-conversion target (Head mainstat is forced to HP by the parser).
const headRelic = pristineSave.relics[0]
if (headRelic.part !== 'Head' || headRelic.grade !== 5) {
  throw new Error(`unexpected sample-save relic[0]: ${headRelic.part}/${headRelic.grade}`)
}
// A Head owned by a plain (non-trailblazer, non-buffed) character, for the
// hoyolab owner-matched skip.
const ownedHead = pristineSave.relics.find(
  (r) => r.part === 'Head' && r.equippedBy != null && /^\d{4}$/.test(String(r.equippedBy)),
)
if (ownedHead == null) throw new Error('no owned Head in sample save')

// Novel-hash relic: relic[0] with the first substat value shifted far off any
// stored roll grid — same part/set/main, different substat values ⇒ new hash.
const novelSubstats = { 0: headRelic.substats[0].value + 10 }
const novelScannerRelic = scannerRelicFromStore(headRelic, '900', novelSubstats)

// Same-id supersession fixtures: one physical relic (a Reliquary Archiver
// _uid, read from the game's packets) before and after an in-game upgrade —
// the level and substats change, so the hash changes, while the id stays.
const SUBS_PLUS0 = [{ key: 'ATK', value: 19 }, { key: 'CRIT Rate_', value: 2.9 }, { key: 'CRIT DMG_', value: 5.8 }]
const SUBS_PLUS15 = [{ key: 'ATK', value: 19 }, { key: 'CRIT Rate_', value: 8.7 }, { key: 'CRIT DMG_', value: 17.4 }, { key: 'SPD', value: 2 }]
const SUBS_PLUS15_REROLLED = [{ key: 'ATK', value: 19 }, { key: 'CRIT Rate_', value: 5.8 }, { key: 'CRIT DMG_', value: 23.2 }, { key: 'SPD', value: 2 }]
const SUBS_PLUS15_REROLLED_AGAIN = [{ key: 'ATK', value: 19 }, { key: 'CRIT Rate_', value: 11.6 }, { key: 'CRIT DMG_', value: 11.6 }, { key: 'SPD', value: 2 }]
const SUBS_UNRELATED = [{ key: 'HP_', value: 3.8 }, { key: 'DEF', value: 21 }, { key: 'Effect RES_', value: 4.3 }]
function uidRelic(uid, level, substats, { location = '', slot = 'Head' } = {}) {
  return {
    set_id: setIdByName[headRelic.set],
    name: 'smoke same-id relic',
    slot,
    rarity: 5,
    level,
    mainstat: slot === 'Hands' ? 'ATK' : 'HP',
    substats,
    location,
    lock: false,
    discard: false,
    _uid: uid,
  }
}
/** Reliquary Archiver export: verified relics (substats carry roll info) with stable ids. */
function archiverJson(relics, characters = []) {
  return {
    ...scannerJson(relics.map((relic) => ({ ...relic, substats: relic.substats.map((substat) => ({ ...substat, count: 1, step: 0 })) })), characters),
    source: 'reliquary_archiver',
    build: 'v0.8.0',
  }
}
const archiverCharacter = (id) => ({ id, name: 'smoke character', path: 'The Harmony', level: 1, ascension: 0, eidolon: 0, ability_version: 0 })

const CHAR_LIGHT_CONES = [
  { id: '20000', name: 'smoke lc', level: 1, ascension: 0, superimposition: 1, location: '1005', lock: false, discard: false, _uid: 'lc-1005' },
  { id: '20000', name: 'smoke lc', level: 1, ascension: 0, superimposition: 2, location: '1107', lock: false, discard: false, _uid: 'lc-1107' },
]
// ability_version: 0 = explicitly unbuffed — without it, upstream
// getMappedCharacterId assumes the BUFFED variant (1005 → 1005b1) and the
// existingCharactersOnly filter would (correctly) drop it as unknown.
const CH_EXISTING = { id: '1005', name: 'Natasha', path: 'The Abundance', level: 1, ascension: 0, eidolon: 0, ability_version: 0 }
const CH_NEW = { id: '1107', name: 'Clara', path: 'The Destruction', level: 1, ascension: 0, eidolon: 3, ability_version: 0 }

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-imports', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(stubPath).href, serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

const HAS_CHINESE = /[\u4e00-\u9fff]/

try {
  // 1. tool surface
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  for (const required of ['import_scanner_json', 'import_hoyolab', 'fetch_showcase', 'import_showcase']) {
    check(`tool ${required} registered`, toolNames.includes(required))
  }

  // ══ fetch_showcase: offline error paths (before any load_save — the tool
  // must not require a save, and must never reach the real network: the stub
  // intercepts every /profile/ request) ═════════════════════════════════════
  await expectToolError(
    'fetch_showcase',
    { uid: '12345678' },
    /无效的 UID.*9 位数字/s,
    'fetch_showcase rejects an 8-digit uid with the Chinese validation error',
  )
  await expectToolError('fetch_showcase', { uid: 'abcdefghi' }, /无效的 UID/, 'fetch_showcase rejects a non-numeric uid')

  async function fetchErrorCase(label, scenario, args, expectedType, messagePattern) {
    setFetchScenario(scenario)
    const payload = await callTool(client, 'fetch_showcase', { uid: '100000001', ...args })
    const err = payload?.error
    const message = err?.message ?? ''
    const hint = err?.hint ?? null
    check(
      label,
      payload?.status === 'error' && err?.type === expectedType && messagePattern.test(message)
        // structured Chinese error: the message itself is Chinese, or (http
        // branch) the actionable guidance lives in the hint by design
        && (HAS_CHINESE.test(message) || (hint != null && HAS_CHINESE.test(hint))),
      `type=${err?.type}, message=${message.slice(0, 120)}, hint=${String(hint).slice(0, 60)}`,
    )
  }
  await fetchErrorCase('fetch_showcase network failure → structured error', { kind: 'network' }, {}, 'network', /网络请求失败/)
  await fetchErrorCase(
    'fetch_showcase timeout → structured error',
    { kind: 'timeout', ms: 8000 },
    { timeoutMs: 1000 },
    'timeout',
    /1000ms/,
  )
  await fetchErrorCase('fetch_showcase HTTP 404 → structured error', { status: 404 }, {}, 'http', /HTTP 404/)
  await fetchErrorCase(
    'fetch_showcase non-JSON body → structured error',
    { body: 'not-json{', contentType: 'text/html' },
    {},
    'invalid_response',
    /不是合法 JSON/,
  )
  // source is valid but the payload is malformed (no detailInfo) — the upstream
  // processor dereferences detailInfo.assistAvatarList and would throw a bare
  // English TypeError; the contract promises a structured error, never a throw.
  await fetchErrorCase(
    'fetch_showcase source-valid malformed payload → structured error (no bare TypeError)',
    { body: { source: 'mihomo' } },
    {},
    'invalid_response',
    /无法解析/,
  )
  await fetchErrorCase(
    'fetch_showcase unknown upstream source → structured error',
    { body: { source: 'yas' } },
    {},
    'unsupported_source',
    /yas/,
  )
  await fetchErrorCase(
    'fetch_showcase source mismatch → structured error (no throw)',
    { body: { source: 'mihomo', detailInfo: {} } },
    { source: 'enka' },
    'source_mismatch',
    /enka.*mihomo|期望数据源/,
  )
  await fetchErrorCase(
    'fetch_showcase empty profile → structured error',
    { body: { source: 'mihomo', detailInfo: {} } },
    {},
    'empty_profile',
    /没有任何角色/,
  )

  // ══ import_scanner_json ═══════════════════════════════════════════════════

  // 2. requires a loaded save
  await expectToolError(
    'import_scanner_json',
    { path: fixtureFile('no-save.json', scannerJson([novelScannerRelic])) },
    /No save loaded/,
    'import_scanner_json refuses to import before load_save',
  )

  // 3. union semantics — THE erratum #5 core assertion: importing one new
  // relic into the 162-relic sample inventory must yield 163, never 1.
  const phase1 = freshSavePath()
  const loaded1 = await callTool(client, 'load_save', { path: phase1 })
  check('phase 1 baseline: 162 relics / 8 characters', loaded1.relics === 162 && loaded1.characters === 8, `${loaded1.relics}/${loaded1.characters}`)
  const novelFixture = fixtureFile('kelz-novel.json', scannerJson([novelScannerRelic]))
  const imported = await callTool(client, 'import_scanner_json', { path: novelFixture })
  check(
    'scanner import (union): exactly 1 added, 0 updated, 0 skipped, 0 removed',
    imported.added === 1 && imported.updated === 0 && imported.skipped === 0 && imported.removed === 0,
    `added=${imported.added}, updated=${imported.updated}, skipped=${imported.skipped}, removed=${imported.removed}`,
  )
  check(
    'ERRATUM #5 CORE: union import 162 → 163 (never collapses to the import size)',
    imported.merge === 'union' && imported.imported === true && imported.totalBefore === 162 && imported.totalAfter === 163,
    `${imported.totalBefore} → ${imported.totalAfter} (merge=${imported.merge})`,
  )
  check(
    'scanner import reports source metadata',
    imported.source === 'HSR-Scanner' && imported.metadata?.scanner === 'HSR-Scanner' && imported.metadata?.version === 4,
    JSON.stringify(imported.metadata),
  )
  check('scanner import shows no warnings on a current build', imported.warnings.length === 0, JSON.stringify(imported.warnings))
  const afterNovel = await callTool(client, 'list_relics', { limit: 1 })
  check('store inventory is 163 after the union import', afterNovel.total === 163, `total=${afterNovel.total}`)
  await sleep(1800) // markDirty → 1s debounced flush
  const flushed1 = JSON.parse(readFileSync(phase1, 'utf8'))
  check('import persisted to the loaded save file (163 relics on disk)', flushed1.relics.length === 163, `${flushed1.relics.length} relics on disk`)

  // 4. same-hash skip — a faithful back-conversion of store relic #0 (its
  // array index doubles as _uid so ageIndex matches; no characters imported)
  const phase2 = freshSavePath()
  await callTool(client, 'load_save', { path: phase2 })
  const twinFixture = fixtureFile('kelz-twin.json', scannerJson([scannerRelicFromStore(headRelic, '0')]))
  const skippedImport = await callTool(client, 'import_scanner_json', { path: twinFixture })
  check(
    'same-hash relic import: skipped=1, added=0, updated=0',
    skippedImport.skipped === 1 && skippedImport.added === 0 && skippedImport.updated === 0,
    `added=${skippedImport.added}, updated=${skippedImport.updated}, skipped=${skippedImport.skipped}`,
  )
  check(
    'same-hash relic import keeps the inventory at 162',
    skippedImport.totalBefore === 162 && skippedImport.totalAfter === 162,
    `${skippedImport.totalBefore} → ${skippedImport.totalAfter}`,
  )
  const afterSkip = await callTool(client, 'list_relics', { limit: 1 })
  check('store inventory still 162 after the no-op import', afterSkip.total === 162, `total=${afterSkip.total}`)

  // 5. existingCharactersOnly + level normalization
  const phase3 = freshSavePath()
  await callTool(client, 'load_save', { path: phase3 })
  const charsFixture = { chars: scannerJson([], [CH_EXISTING, CH_NEW], CHAR_LIGHT_CONES) }
  const existingOnly = await callTool(client, 'import_scanner_json', {
    path: fixtureFile('kelz-chars.json', charsFixture.chars),
    existingCharactersOnly: true,
  })
  check(
    'existingCharactersOnly: only the 1 known character touched',
    existingOnly.charactersTouched === 1 && existingOnly.totalAfter === 162,
    `charactersTouched=${existingOnly.charactersTouched}, relics ${existingOnly.totalBefore} → ${existingOnly.totalAfter}`,
  )
  const newCharAbsent = await toolErrorText(client, 'get_character', { characterId: '1107' })
  check('existingCharactersOnly keeps the unknown character out of the store', newCharAbsent != null, String(newCharAbsent).slice(0, 100))

  const bothChars = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([], [CH_EXISTING, CH_NEW], CHAR_LIGHT_CONES),
  })
  check(
    'default import (inline json path) touches both characters',
    bothChars.charactersTouched === 2 && bothChars.imported === true,
    `charactersTouched=${bothChars.charactersTouched}`,
  )
  const newChar = await callTool(client, 'get_character', { characterId: '1107' })
  check(
    'imported character created with levels normalized to 80 (fixture had level 1)',
    newChar.savedForm?.characterLevel === 80 && newChar.savedForm?.lightConeLevel === 80,
    `characterLevel=${newChar.savedForm?.characterLevel}, lightConeLevel=${newChar.savedForm?.lightConeLevel}`,
  )
  check(
    'light cone attached from the light_cones array (s2 from the fixture)',
    newChar.savedForm?.lightCone === '20000' && newChar.savedForm?.lightConeSuperimposition === 2 && newChar.savedForm?.characterEidolon === 3,
    `lightCone=${newChar.savedForm?.lightCone} s${newChar.savedForm?.lightConeSuperimposition} e${newChar.savedForm?.characterEidolon}`,
  )

  // 6. dryRun — stats only, no store write, no disk write
  const phase4 = freshSavePath()
  await callTool(client, 'load_save', { path: phase4 })
  const dry = await callTool(client, 'import_scanner_json', { path: novelFixture, dryRun: true })
  check(
    'dryRun reports the predicted outcome without importing',
    dry.dryRun === true && dry.imported === false && dry.added === 1 && dry.totalBefore === 162 && dry.totalAfter === 163,
    `dryRun=${dry.dryRun}, imported=${dry.imported}, ${dry.totalBefore} → ${dry.totalAfter}`,
  )
  const afterDry = await callTool(client, 'list_relics', { limit: 1 })
  check('dryRun leaves the store at 162', afterDry.total === 162, `total=${afterDry.total}`)
  await sleep(1600)
  const diskAfterDry = JSON.parse(readFileSync(phase4, 'utf8'))
  check('dryRun never flushed to the save file (still 162 on disk)', diskAfterDry.relics.length === 162, `${diskAfterDry.relics.length} relics on disk`)

  // 7. anti-wipe: a strict-subset import (1 hash-matching relic out of 162)
  // under union must NOT collapse the inventory — the naive upstream replace
  // semantics would leave exactly 1 relic behind.
  const subset = await callTool(client, 'import_scanner_json', { path: twinFixture })
  check(
    'ANTI-WIPE: strict-subset union import keeps all 162 relics (not 1), removed=0',
    subset.totalBefore === 162 && subset.totalAfter === 162 && subset.removed === 0 && subset.skipped === 1,
    `${subset.totalBefore} → ${subset.totalAfter}, removed=${subset.removed}`,
  )
  // replace mode is the documented intentional shrink (upstream web parity)
  const replaced = await callTool(client, 'import_scanner_json', { path: twinFixture, merge: 'replace' })
  check(
    'replace mode intentionally resets the inventory to the import (1 relic, 161 removed)',
    replaced.merge === 'replace' && replaced.totalAfter === 1 && replaced.removed === 161,
    `${replaced.totalBefore} → ${replaced.totalAfter}, removed=${replaced.removed}`,
  )
  const afterReplace = await callTool(client, 'list_relics', { limit: 500 })
  check(
    'store holds exactly the 1 imported relic after replace',
    afterReplace.total === 1 && afterReplace.relics[0].set === headRelic.set && afterReplace.relics[0].part === 'Head',
    `${afterReplace.total}: ${afterReplace.relics[0]?.set}/${afterReplace.relics[0]?.part}`,
  )

  // 7b. Partial union import must not let an uncovered old piece take back a
  // slot the import just claimed. mergeRelics asserts character.equipped[part]
  // for every relic that still carries equippedBy, and union appends uncovered
  // inventory relics after the import — so the old Head used to overwrite the
  // new one, and the trailing cleanup then unequipped the import.
  const incomingHead = {
    ...scannerRelicFromStore(headRelic, '888001', novelSubstats),
    location: '1005',
  }
  const handsTemplate = pristineSave.relics.find((r) => r.part === 'Hands' && r.grade === 5)
  if (handsTemplate == null) throw new Error('no 5★ Hands in sample save')
  const incomingHands = {
    ...scannerRelicFromStore(handsTemplate, '888002', { 0: handsTemplate.substats[0].value + 10 }),
    location: '1005',
  }
  const otherHead = pristineSave.characters.find((c) => c.id === '1212b1')
  if (otherHead?.equipped?.Head == null) throw new Error('sample save 1212b1 has no Head')

  async function relicById(id) {
    const listed = await callTool(client, 'list_relics', { limit: 500 })
    return listed.relics.find((r) => r.id === id)
  }

  const phaseEquip = freshSavePath()
  await callTool(client, 'load_save', { path: phaseEquip })
  const beforeEquip = await callTool(client, 'get_character', { characterId: '1005' })
  const oldHeadId = beforeEquip.equippedSlots?.Head?.equippedId
  const oldHandsId = beforeEquip.equippedSlots?.Hands?.equippedId
  if (oldHeadId == null || oldHandsId == null) throw new Error(`1005 is missing Head/Hands: ${oldHeadId}/${oldHandsId}`)
  const equippedHead = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([incomingHead], [CH_EXISTING]),
  })
  const afterHead = await callTool(client, 'get_character', { characterId: '1005' })
  const importedHead = await relicById('888001')
  const displacedHead = await relicById(oldHeadId)
  const keptHands = await relicById(oldHandsId)
  const untouchedOther = await callTool(client, 'get_character', { characterId: '1212b1' })
  check(
    'partial union: imported Head wins the slot (888001 worn by 1005, inventory 163)',
    equippedHead.added === 1
      && equippedHead.totalBefore === 162
      && equippedHead.totalAfter === 163
      && afterHead.equippedSlots?.Head?.equippedId === '888001'
      && importedHead?.equippedBy === '1005',
    `added=${equippedHead.added} ${equippedHead.totalBefore}→${equippedHead.totalAfter} head=${afterHead.equippedSlots?.Head?.equippedId} equippedBy=${importedHead?.equippedBy}`,
  )
  check(
    'partial union: the old Head is unequipped, and a slot the file did not replace stays worn',
    displacedHead?.equippedBy == null
      && afterHead.equippedSlots?.Hands?.equippedId === oldHandsId
      && keptHands?.equippedBy === '1005'
      && untouchedOther.equippedSlots?.Head?.equippedId === otherHead.equipped.Head,
    `oldHead.equippedBy=${displacedHead?.equippedBy} hands=${afterHead.equippedSlots?.Hands?.equippedId} otherHead=${untouchedOther.equippedSlots?.Head?.equippedId}`,
  )

  // The file replaces Hands only, so the previously worn Head must stay.
  const phaseSlot = freshSavePath()
  await callTool(client, 'load_save', { path: phaseSlot })
  const beforeSlot = await callTool(client, 'get_character', { characterId: '1005' })
  const keptHeadId = beforeSlot.equippedSlots?.Head?.equippedId
  const replacedHandsId = beforeSlot.equippedSlots?.Hands?.equippedId
  const equippedHands = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([incomingHands], [CH_EXISTING]),
  })
  const afterHands = await callTool(client, 'get_character', { characterId: '1005' })
  const importedHandsRelic = await relicById('888002')
  const stillWornHead = await relicById(keptHeadId)
  const displacedHands = await relicById(replacedHandsId)
  check(
    'partial union: a slot the file does not replace keeps the old piece',
    equippedHands.added === 1
      && afterHands.equippedSlots?.Head?.equippedId === keptHeadId
      && stillWornHead?.equippedBy === '1005'
      && afterHands.equippedSlots?.Hands?.equippedId === '888002'
      && importedHandsRelic?.equippedBy === '1005'
      && displacedHands?.equippedBy == null,
    `head=${afterHands.equippedSlots?.Head?.equippedId} headBy=${stillWornHead?.equippedBy} hands=${afterHands.equippedSlots?.Hands?.equippedId} oldHandsBy=${displacedHands?.equippedBy}`,
  )

  // No characters in the merge: uncovered relics must not be stripped, and the
  // new piece must not be worn (upstream only asserts slots when characters
  // were imported).
  const phaseRelicsOnly = freshSavePath()
  await callTool(client, 'load_save', { path: phaseRelicsOnly })
  const beforeRelicsOnly = await callTool(client, 'get_character', { characterId: '1005' })
  const relicsOnlyImport = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([incomingHead], [CH_EXISTING]),
    includeCharacters: false,
  })
  const afterRelicsOnly = await callTool(client, 'get_character', { characterId: '1005' })
  const unwornImport = await relicById('888001')
  check(
    'includeCharacters=false union does not move existing equipment',
    relicsOnlyImport.added === 1
      && relicsOnlyImport.charactersTouched === 0
      && afterRelicsOnly.equippedSlots?.Head?.equippedId === beforeRelicsOnly.equippedSlots?.Head?.equippedId
      && unwornImport?.equippedBy == null,
    `touched=${relicsOnlyImport.charactersTouched} head=${afterRelicsOnly.equippedSlots?.Head?.equippedId} importBy=${unwornImport?.equippedBy}`,
  )

  // 7b. same-id supersession — a Reliquary Archiver relic keeps its id across
  // an in-game upgrade while its hash changes. The re-import must replace the
  // stale record, not sit next to it: two records under one id make
  // relicsById resolve to the stale one and the next relic write drops the
  // fresh one.
  async function inventory() {
    const { snapshot } = await callTool(client, 'export_save', { structured: true })
    const counts = new Map()
    for (const relic of snapshot.relics) counts.set(relic.id, (counts.get(relic.id) ?? 0) + 1)
    return {
      total: snapshot.relics.length,
      duplicateIds: [...counts].filter(([, n]) => n > 1).map(([id]) => id),
      relics: snapshot.relics,
      records: (id) => snapshot.relics.filter((relic) => relic.id === id),
      character: (id) => snapshot.characters.find((character) => character.id === id),
    }
  }
  const describeRecords = (records) =>
    JSON.stringify(records.map((r) => ({ enhance: r.enhance, substats: r.substats.length, equippedBy: r.equippedBy ?? null })))
  const sameIdStats = (r) =>
    `added=${r.added}, updated=${r.updated}, skipped=${r.skipped}, removed=${r.removed}, replacedById=${r.replacedById}, ${r.totalBefore} → ${r.totalAfter}`
  const buildHead = (inv) => inv.character('1105')?.builds?.find((build) => build.name === 'smoke-same-id')?.equipped?.Head
  const hasEffectRes = (relic) => relic.substats.some((substat) => substat.stat === 'Effect RES')
  const idsOf = (inv) => new Set(inv.relics.map((relic) => relic.id))
  // Sample saves already contain Effect RES. Identify relics this import added by id, not by substat.
  const arrivedSince = (beforeIds, inv) => inv.relics.filter((relic) => !beforeIds.has(relic.id))

  await callTool(client, 'load_save', { path: freshSavePath() })
  const beforeUpgrade = await callTool(client, 'import_scanner_json', { inline: archiverJson([uidRelic('777001', 0, SUBS_PLUS0)]) })
  check(
    'same-id: the +0 relic is a plain verified add (162 → 163, no warnings)',
    beforeUpgrade.source === 'reliquary_archiver' && beforeUpgrade.added === 1 && beforeUpgrade.replacedById === 0 && beforeUpgrade.totalAfter === 163
      && beforeUpgrade.warnings.length === 0,
    `source=${beforeUpgrade.source}, ${sameIdStats(beforeUpgrade)}, warnings=${JSON.stringify(beforeUpgrade.warnings)}`,
  )
  const upgradeFixture = archiverJson([uidRelic('777001', 15, SUBS_PLUS15)])
  const upgradeDry = await callTool(client, 'import_scanner_json', { inline: upgradeFixture, dryRun: true })
  check(
    'same-id dryRun: the upgraded relic is predicted as 1 updated / 0 added, inventory stays 163',
    upgradeDry.added === 0 && upgradeDry.updated === 1 && upgradeDry.skipped === 0 && upgradeDry.replacedById === 1
      && upgradeDry.removed === 0 && upgradeDry.totalBefore === 163 && upgradeDry.totalAfter === 163,
    sameIdStats(upgradeDry),
  )
  const afterUpgradeDry = await inventory()
  check(
    'same-id dryRun leaves the +0 record untouched',
    afterUpgradeDry.total === 163 && afterUpgradeDry.records('777001').length === 1 && afterUpgradeDry.records('777001')[0].enhance === 0,
    `total=${afterUpgradeDry.total}, ${describeRecords(afterUpgradeDry.records('777001'))}`,
  )
  const upgraded = await callTool(client, 'import_scanner_json', { inline: upgradeFixture })
  check(
    'SAME-ID CORE: re-importing the upgraded relic reports 1 updated / 0 added and keeps 163 (never 164)',
    upgraded.merge === 'union' && upgraded.added === 0 && upgraded.updated === 1 && upgraded.skipped === 0 && upgraded.replacedById === 1
      && upgraded.removed === 0 && upgraded.totalBefore === 163 && upgraded.totalAfter === 163,
    sameIdStats(upgraded),
  )
  const afterUpgrade = await inventory()
  check(
    'same-id: no relic id appears twice after the re-import',
    afterUpgrade.duplicateIds.length === 0,
    `duplicate ids: ${afterUpgrade.duplicateIds.join(',') || 'none'}`,
  )
  check(
    'same-id: the surviving record is the +15 four-substat one',
    afterUpgrade.total === 163 && afterUpgrade.records('777001').length === 1 && afterUpgrade.records('777001')[0].enhance === 15
      && afterUpgrade.records('777001')[0].substats.length === 4 && afterUpgrade.records('777001')[0].verified === true,
    `total=${afterUpgrade.total}, ${describeRecords(afterUpgrade.records('777001'))}`,
  )

  // The union result for that id must be what upstream's own full replace
  // (merge=replace = the raw web path, untouched by this rule) leaves behind
  // for the same two imports.
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', { inline: archiverJson([uidRelic('777001', 0, SUBS_PLUS0)]) })
  const upgradedByReplace = await callTool(client, 'import_scanner_json', { inline: upgradeFixture, merge: 'replace' })
  const afterReplaceUpgrade = await inventory()
  check(
    'same-id under replace: the raw upstream path is unchanged (hash-only stats, no supersession, inventory resets to the import)',
    upgradedByReplace.added === 1 && upgradedByReplace.updated === 0 && upgradedByReplace.replacedById === 0 && upgradedByReplace.totalAfter === 1,
    sameIdStats(upgradedByReplace),
  )
  check(
    'same-id: the union record is field-for-field the record upstream replace produces',
    afterReplaceUpgrade.records('777001').length === 1
      && JSON.stringify(afterReplaceUpgrade.records('777001')[0]) === JSON.stringify(afterUpgrade.records('777001')[0]),
    `replace=${describeRecords(afterReplaceUpgrade.records('777001'))}, union=${describeRecords(afterUpgrade.records('777001'))}`,
  )

  // 7c. wearer + saved-build references across a same-id replacement follow
  // the hash-match rule: the import's wearer wins only when characters are
  // imported AND the file names one; otherwise the optimizer's own equipment
  // survives. 1105 and 1202 have no Head in the sample save.
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', { inline: archiverJson([uidRelic('777002', 0, SUBS_PLUS0)]) })
  await callTool(client, 'equip_build', { characterId: '1105', relicIds: ['777002'] })
  await callTool(client, 'save_build', { characterId: '1105', name: 'smoke-same-id' })
  const wornUpgrade = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777002', 15, SUBS_PLUS15)]),
    includeCharacters: false,
  })
  const afterWornUpgrade = await inventory()
  check(
    'same-id relics-only: the worn relic is replaced in place (1 updated, 163, no duplicate id)',
    wornUpgrade.updated === 1 && wornUpgrade.added === 0 && wornUpgrade.totalAfter === 163 && afterWornUpgrade.duplicateIds.length === 0
      && afterWornUpgrade.records('777002').length === 1 && afterWornUpgrade.records('777002')[0].enhance === 15,
    `${sameIdStats(wornUpgrade)}; ${describeRecords(afterWornUpgrade.records('777002'))}`,
  )
  check(
    'same-id relics-only: the wearer keeps the relic (equippedBy + character slot both intact)',
    afterWornUpgrade.records('777002')[0]?.equippedBy === '1105' && afterWornUpgrade.character('1105')?.equipped?.Head === '777002',
    `equippedBy=${afterWornUpgrade.records('777002')[0]?.equippedBy}, 1105.Head=${afterWornUpgrade.character('1105')?.equipped?.Head}`,
  )
  check(
    'same-id relics-only: the saved build still references the relic id',
    buildHead(afterWornUpgrade) === '777002',
    `build Head=${buildHead(afterWornUpgrade)}`,
  )
  const unequippedInGame = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777002', 15, SUBS_PLUS15_REROLLED)], [archiverCharacter('1105')]),
  })
  const afterUnequippedInGame = await inventory()
  check(
    'same-id with characters, file names no wearer: replaced, the optimizer wearer stays (hash-match rule)',
    unequippedInGame.updated === 1 && unequippedInGame.charactersTouched === 1 && afterUnequippedInGame.duplicateIds.length === 0
      && afterUnequippedInGame.records('777002').length === 1 && afterUnequippedInGame.records('777002')[0].equippedBy === '1105'
      && afterUnequippedInGame.character('1105')?.equipped?.Head === '777002',
    `${sameIdStats(unequippedInGame)}; ${describeRecords(afterUnequippedInGame.records('777002'))}, 1105.Head=${
      afterUnequippedInGame.character('1105')?.equipped?.Head
    }`,
  )
  const movedUpgrade = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777002', 15, SUBS_PLUS15_REROLLED_AGAIN, { location: '1202' })], [archiverCharacter('1202')]),
  })
  const afterMoved = await inventory()
  check(
    'same-id with characters: replaced again (1 updated, 163, no duplicate id)',
    movedUpgrade.updated === 1 && movedUpgrade.added === 0 && movedUpgrade.totalAfter === 163 && afterMoved.duplicateIds.length === 0
      && afterMoved.records('777002').length === 1,
    `${sameIdStats(movedUpgrade)}; ${describeRecords(afterMoved.records('777002'))}`,
  )
  check(
    'same-id with characters: the wearer named by the file takes the relic and the old slot is released',
    afterMoved.records('777002')[0]?.equippedBy === '1202' && afterMoved.character('1202')?.equipped?.Head === '777002'
      && afterMoved.character('1105')?.equipped?.Head == null,
    `equippedBy=${afterMoved.records('777002')[0]?.equippedBy}, 1202.Head=${afterMoved.character('1202')?.equipped?.Head}, 1105.Head=${
      afterMoved.character('1105')?.equipped?.Head
    }`,
  )
  check('same-id with characters: the saved build still references the relic id', buildHead(afterMoved) === '777002', `build Head=${buildHead(afterMoved)}`)

  // 7d. hash twins. mergeRelics pairs by hash only, so (a) a re-attached twin
  // (777102) must not consume the stale 777101 record and take over its id,
  // and (b) an upgraded relic (777103) that now hashes like another stored
  // relic (777104) must not swallow that relic.
  await callTool(client, 'load_save', { path: freshSavePath() })
  const twins = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777101', 0, SUBS_PLUS0), uidRelic('777102', 0, SUBS_PLUS0)]),
  })
  const twinUpgrade = await callTool(client, 'import_scanner_json', { inline: archiverJson([uidRelic('777101', 15, SUBS_PLUS15)]) })
  const afterTwinUpgrade = await inventory()
  check(
    'same-id with a hash twin of the stale record: 1 updated, inventory stays 164',
    twins.added === 2 && twinUpgrade.updated === 1 && twinUpgrade.added === 0 && twinUpgrade.replacedById === 1 && twinUpgrade.totalAfter === 164,
    sameIdStats(twinUpgrade),
  )
  check(
    'same-id with a hash twin of the stale record: the upgraded relic and its untouched twin each keep their own id',
    afterTwinUpgrade.duplicateIds.length === 0 && afterTwinUpgrade.records('777101').length === 1 && afterTwinUpgrade.records('777101')[0].enhance === 15
      && afterTwinUpgrade.records('777102').length === 1 && afterTwinUpgrade.records('777102')[0].enhance === 0,
    `duplicate ids: ${afterTwinUpgrade.duplicateIds.join(',') || 'none'}; 777101=${describeRecords(afterTwinUpgrade.records('777101'))}, 777102=${
      describeRecords(afterTwinUpgrade.records('777102'))
    }`,
  )
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777103', 0, SUBS_PLUS0), uidRelic('777104', 15, SUBS_PLUS15)]),
  })
  await callTool(client, 'equip_build', { characterId: '1105', relicIds: ['777103'] })
  await callTool(client, 'save_build', { characterId: '1105', name: 'smoke-same-id' })
  const twinOfNewState = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777103', 15, SUBS_PLUS15)]),
    includeCharacters: false,
  })
  const afterTwinOfNewState = await inventory()
  check(
    'same-id upgraded into the hash of another stored relic: 1 updated, nothing removed (164 → 164)',
    twinOfNewState.updated === 1 && twinOfNewState.added === 0 && twinOfNewState.removed === 0 && twinOfNewState.replacedById === 1
      && twinOfNewState.totalAfter === 164,
    sameIdStats(twinOfNewState),
  )
  check(
    'same-id upgraded into the hash of another stored relic: both ids survive once, wearer and saved build stay on the upgraded one',
    afterTwinOfNewState.duplicateIds.length === 0 && afterTwinOfNewState.records('777103').length === 1
      && afterTwinOfNewState.records('777103')[0].enhance === 15 && afterTwinOfNewState.records('777103')[0].equippedBy === '1105'
      && afterTwinOfNewState.records('777104').length === 1 && afterTwinOfNewState.records('777104')[0].equippedBy == null
      && afterTwinOfNewState.character('1105')?.equipped?.Head === '777103' && buildHead(afterTwinOfNewState) === '777103',
    `777103=${describeRecords(afterTwinOfNewState.records('777103'))}, 777104=${describeRecords(afterTwinOfNewState.records('777104'))}, 1105.Head=${
      afterTwinOfNewState.character('1105')?.equipped?.Head
    }, build Head=${buildHead(afterTwinOfNewState)}`,
  )

  // 7d2. The twin is stored first, and the full file lists it before the relic
  // being upgraded. Hash FIFO must still give each import its own id: a folded
  // stand-in at the front of the bucket would be consumed by the twin, and the
  // verified id rewrite would swap wearers and saved builds.
  const buildHeadNamed = (inv, characterId, name) => inv.character(characterId)?.builds?.find((build) => build.name === name)?.equipped?.Head
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777105', 15, SUBS_PLUS15), uidRelic('777106', 0, SUBS_PLUS0)]),
  })
  await callTool(client, 'equip_build', { characterId: '1202', relicIds: ['777105'] })
  await callTool(client, 'save_build', { characterId: '1202', name: 'smoke-same-id-twin' })
  await callTool(client, 'equip_build', { characterId: '1105', relicIds: ['777106'] })
  await callTool(client, 'save_build', { characterId: '1105', name: 'smoke-same-id' })
  const aheadInFile = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777105', 15, SUBS_PLUS15), uidRelic('777106', 15, SUBS_PLUS15)]),
    includeCharacters: false,
  })
  const afterAheadInFile = await inventory()
  check(
    'same-id reimport with the hash twin listed first: both ids, wearers and saved builds stay put',
    aheadInFile.updated === 1 && aheadInFile.added === 0 && aheadInFile.skipped === 1 && aheadInFile.replacedById === 1 && aheadInFile.removed === 0
      && aheadInFile.totalAfter === 164 && afterAheadInFile.duplicateIds.length === 0
      && afterAheadInFile.records('777106').length === 1 && afterAheadInFile.records('777106')[0].enhance === 15
      && afterAheadInFile.records('777106')[0].equippedBy === '1105'
      && afterAheadInFile.records('777105').length === 1 && afterAheadInFile.records('777105')[0].enhance === 15
      && afterAheadInFile.records('777105')[0].equippedBy === '1202'
      && afterAheadInFile.character('1105')?.equipped?.Head === '777106'
      && afterAheadInFile.character('1202')?.equipped?.Head === '777105'
      && buildHead(afterAheadInFile) === '777106'
      && buildHeadNamed(afterAheadInFile, '1202', 'smoke-same-id-twin') === '777105',
    `${sameIdStats(aheadInFile)}; 777105=${describeRecords(afterAheadInFile.records('777105'))}, 777106=${
      describeRecords(afterAheadInFile.records('777106'))
    }, 1105.Head=${afterAheadInFile.character('1105')?.equipped?.Head}, 1202.Head=${afterAheadInFile.character('1202')?.equipped?.Head}, builds=${
      buildHead(afterAheadInFile)
    }/${buildHeadNamed(afterAheadInFile, '1202', 'smoke-same-id-twin')}`,
  )

  // The new-hash record already exists and sits behind its twin, with a stale
  // same-id duplicate after it. Re-importing only that id must consume the
  // same-id record, not the earlier twin (current != null, so nothing is
  // moved to the front of the bucket).
  const behindSeedPath = freshSavePath()
  await callTool(client, 'load_save', { path: behindSeedPath })
  await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777107', 15, SUBS_PLUS15), uidRelic('777108', 15, SUBS_PLUS15)]),
  })
  await callTool(client, 'equip_build', { characterId: '1202', relicIds: ['777107'] })
  await callTool(client, 'equip_build', { characterId: '1105', relicIds: ['777108'] })
  await callTool(client, 'save_build', { characterId: '1105', name: 'smoke-same-id' })
  await sleep(1800)
  const behindSave = JSON.parse(readFileSync(behindSeedPath, 'utf8'))
  const currentRecord = behindSave.relics.find((relic) => relic.id === '777108')
  behindSave.relics.push({
    ...currentRecord,
    enhance: 0,
    main: { ...currentRecord.main, value: 112.896 },
    substats: currentRecord.substats.slice(0, 3).map((substat) => ({ ...substat, value: substat.stat === 'ATK' ? 16 : substat.value })),
    equippedBy: undefined,
  })
  const behindPath = fixtureFile('save-twin-before-same-id.json', behindSave)
  await callTool(client, 'load_save', { path: behindPath })
  const behindTwin = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777108', 15, SUBS_PLUS15)]),
    includeCharacters: false,
  })
  const afterBehindTwin = await inventory()
  check(
    'same-id record behind its hash twin: the import keeps both ids and does not steal the twin',
    behindTwin.added === 0 && behindTwin.replacedById === 1 && behindTwin.removed === 1 && behindTwin.totalBefore === 165 && behindTwin.totalAfter === 164
      && afterBehindTwin.duplicateIds.length === 0
      && afterBehindTwin.records('777108').length === 1 && afterBehindTwin.records('777108')[0].enhance === 15
      && afterBehindTwin.records('777108')[0].equippedBy === '1105'
      && afterBehindTwin.records('777107').length === 1 && afterBehindTwin.records('777107')[0].enhance === 15
      && afterBehindTwin.records('777107')[0].equippedBy === '1202'
      && afterBehindTwin.character('1105')?.equipped?.Head === '777108'
      && afterBehindTwin.character('1202')?.equipped?.Head === '777107'
      && buildHead(afterBehindTwin) === '777108',
    `${sameIdStats(behindTwin)}; 777107=${describeRecords(afterBehindTwin.records('777107'))}, 777108=${
      describeRecords(afterBehindTwin.records('777108'))
    }, 1105.Head=${afterBehindTwin.character('1105')?.equipped?.Head}, 1202.Head=${afterBehindTwin.character('1202')?.equipped?.Head}, build Head=${
      buildHead(afterBehindTwin)
    }`,
  )

  // 7e. an inventory that already holds two records under one id (what the
  // pre-fix union left behind): the next import carrying that id hash-matches
  // the fresh record and supersedes the stale one, so the inventory shrinks by
  // one — the anti-wipe guard must allow exactly that. The stale record is
  // the one relicsById resolved to, so its wearer moves to the survivor.
  const dupSeedPath = freshSavePath()
  await callTool(client, 'load_save', { path: dupSeedPath })
  await callTool(client, 'import_scanner_json', { inline: archiverJson([uidRelic('777201', 15, SUBS_PLUS15)]) })
  await sleep(1800) // markDirty → 1s debounced flush
  const dupSave = JSON.parse(readFileSync(dupSeedPath, 'utf8'))
  const freshRecord = dupSave.relics.find((relic) => relic.id === '777201')
  dupSave.relics.push({
    ...freshRecord,
    enhance: 0,
    main: { ...freshRecord.main, value: 112.896 },
    substats: freshRecord.substats.slice(0, 3).map((substat) => ({ ...substat, value: substat.stat === 'ATK' ? 16 : substat.value })),
    equippedBy: '1105',
  })
  const dupSavePath = fixtureFile('save-duplicate-id.json', dupSave)
  await callTool(client, 'load_save', { path: dupSavePath })
  const seededDup = await inventory()
  check(
    'pre-existing duplicate id fixture: 164 records, id 777201 twice (+15 first, +0 last and worn by 1105)',
    seededDup.total === 164 && seededDup.duplicateIds.join(',') === '777201' && seededDup.records('777201').map((r) => r.enhance).join(',') === '15,0'
      && seededDup.records('777201')[1].equippedBy === '1105' && seededDup.character('1105')?.equipped?.Head === '777201',
    `total=${seededDup.total}, duplicate ids: ${seededDup.duplicateIds.join(',') || 'none'}, ${describeRecords(seededDup.records('777201'))}, 1105.Head=${
      seededDup.character('1105')?.equipped?.Head
    }`,
  )
  const collapse = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777201', 15, SUBS_PLUS15)]),
    includeCharacters: false,
  })
  const afterCollapse = await inventory()
  check(
    'pre-existing duplicate id: the hash-matching import supersedes the stale record (replacedById=1, removed=1, 164 → 163)',
    collapse.added === 0 && collapse.updated + collapse.skipped === 1 && collapse.replacedById === 1 && collapse.removed === 1
      && collapse.totalBefore === 164 && collapse.totalAfter === 163,
    sameIdStats(collapse),
  )
  check(
    'pre-existing duplicate id: one +15 record left, still worn by 1105, every other relic kept',
    afterCollapse.total === 163 && afterCollapse.duplicateIds.length === 0 && afterCollapse.records('777201').length === 1
      && afterCollapse.records('777201')[0].enhance === 15 && afterCollapse.records('777201')[0].equippedBy === '1105'
      && afterCollapse.character('1105')?.equipped?.Head === '777201',
    `total=${afterCollapse.total}, ${describeRecords(afterCollapse.records('777201'))}, 1105.Head=${afterCollapse.character('1105')?.equipped?.Head}`,
  )

  // 7f. where an equal id proves nothing, nothing may be superseded:
  // HSR-Scanner numbers relics by scan position (`relic_1`, `relic_2`, …), so
  // the same _uid in two exports is usually two different relics; and even a
  // stable id cannot make a Hands piece the earlier state of a Head.
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', { inline: scannerJson([uidRelic('relic_1', 15, SUBS_PLUS15)]) })
  await callTool(client, 'equip_build', { characterId: '1105', relicIds: ['relic_1'] })
  await callTool(client, 'save_build', { characterId: '1105', name: 'smoke-same-id' })
  const beforePositionalIds = idsOf(await inventory())
  const positionalClash = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([uidRelic('relic_1', 15, SUBS_UNRELATED)]),
    includeCharacters: false,
  })
  const afterPositionalClash = await inventory()
  const renamedClash = arrivedSince(beforePositionalIds, afterPositionalClash)
  check(
    'HSR-Scanner positional id clash: the import is a plain add, no record is superseded',
    positionalClash.source === 'HSR-Scanner' && positionalClash.added === 1 && positionalClash.updated === 0 && positionalClash.replacedById === 0
      && positionalClash.removed === 0 && positionalClash.totalAfter === 164,
    sameIdStats(positionalClash),
  )
  check(
    'HSR-Scanner positional id clash: old relic_1 stays worn, the new relic is renamed, no duplicate id',
    afterPositionalClash.total === 164
      && afterPositionalClash.duplicateIds.length === 0
      && afterPositionalClash.records('relic_1').length === 1
      && afterPositionalClash.records('relic_1')[0].substats.some((substat) => substat.stat === 'CRIT DMG')
      && afterPositionalClash.records('relic_1')[0].equippedBy === '1105'
      && buildHead(afterPositionalClash) === 'relic_1'
      && renamedClash.length === 1
      && renamedClash[0].id !== 'relic_1'
      && renamedClash[0].id.length > 0
      && hasEffectRes(renamedClash[0]),
    `total=${afterPositionalClash.total}, duplicate=${afterPositionalClash.duplicateIds.join(',') || 'none'}, relic_1=${
      describeRecords(afterPositionalClash.records('relic_1'))
    }, new=${renamedClash.map((relic) => relic.id).join(',')}, build=${buildHead(afterPositionalClash)}`,
  )

  // A later full scan inserts a relic at the front, so every positional _uid
  // shifts. The pieces that hash-match keep the ids they were stored under;
  // the new piece must not take relic_1 as well.
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', {
    inline: scannerJson([
      uidRelic('relic_1', 15, SUBS_PLUS15),
      uidRelic('relic_2', 15, SUBS_PLUS15_REROLLED, { slot: 'Hands' }),
    ]),
  })
  await callTool(client, 'equip_build', { characterId: '1105', relicIds: ['relic_1'] })
  await callTool(client, 'save_build', { characterId: '1105', name: 'smoke-same-id' })
  const beforeShiftIds = idsOf(await inventory())
  const shifted = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([
      uidRelic('relic_1', 15, SUBS_UNRELATED),
      uidRelic('relic_2', 15, SUBS_PLUS15),
      uidRelic('relic_3', 15, SUBS_PLUS15_REROLLED, { slot: 'Hands' }),
    ]),
    includeCharacters: false,
  })
  const afterShift = await inventory()
  const shiftedNew = arrivedSince(beforeShiftIds, afterShift)
  check(
    'HSR-Scanner shifted rescan: 165 relics, A stays relic_1 and worn, no duplicate id',
    shifted.added === 1 && shifted.updated + shifted.skipped === 2 && shifted.replacedById === 0 && shifted.totalAfter === 165
      && afterShift.duplicateIds.length === 0
      && afterShift.records('relic_1').length === 1
      && afterShift.records('relic_1')[0].equippedBy === '1105'
      && afterShift.records('relic_1')[0].part === 'Head'
      && afterShift.records('relic_2').length === 1
      && afterShift.records('relic_2')[0].part === 'Hands'
      && buildHead(afterShift) === 'relic_1'
      && shiftedNew.length === 1
      && !['relic_1', 'relic_2', 'relic_3'].includes(shiftedNew[0].id)
      && hasEffectRes(shiftedNew[0]),
    `${sameIdStats(shifted)}; new=${shiftedNew.map((relic) => relic.id).join(',')}, build=${buildHead(afterShift)}`,
  )
  const shiftedReplace = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([
      uidRelic('relic_1', 15, SUBS_UNRELATED),
      uidRelic('relic_2', 15, SUBS_PLUS15),
      uidRelic('relic_3', 15, SUBS_PLUS15_REROLLED, { slot: 'Hands' }),
    ]),
    merge: 'replace',
    includeCharacters: false,
  })
  const afterShiftReplace = await inventory()
  const replacedNew = afterShiftReplace.relics.filter((relic) => relic.substats.some((substat) => substat.stat === 'Effect RES'))
  check(
    'HSR-Scanner shifted rescan under replace: 3 relics, A keeps relic_1, the new piece is renamed',
    shiftedReplace.replacedById === 0 && shiftedReplace.totalAfter === 3
      && afterShiftReplace.total === 3
      && afterShiftReplace.duplicateIds.length === 0
      && afterShiftReplace.records('relic_1').length === 1
      && afterShiftReplace.records('relic_1')[0].substats.some((substat) => substat.stat === 'CRIT DMG')
      && afterShiftReplace.records('relic_2').length === 1
      && replacedNew.length === 1
      && !['relic_1', 'relic_2', 'relic_3'].includes(replacedNew[0].id),
    `${sameIdStats(shiftedReplace)}; ids=${afterShiftReplace.relics.map((relic) => relic.id).join(',')}`,
  )

  // The case above re-imports a piece that union already renamed. This one
  // starts from positional ids, so replace itself has to rename the clash.
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', {
    inline: scannerJson([
      uidRelic('relic_1', 15, SUBS_PLUS15),
      uidRelic('relic_2', 15, SUBS_PLUS15_REROLLED, { slot: 'Hands' }),
    ]),
  })
  await callTool(client, 'equip_build', { characterId: '1105', relicIds: ['relic_1'] })
  await callTool(client, 'save_build', { characterId: '1105', name: 'smoke-same-id' })
  const beforeReplaceClashIds = idsOf(await inventory())
  const replaceClash = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([
      uidRelic('relic_1', 15, SUBS_UNRELATED),
      uidRelic('relic_2', 15, SUBS_PLUS15),
      uidRelic('relic_3', 15, SUBS_PLUS15_REROLLED, { slot: 'Hands' }),
    ]),
    merge: 'replace',
    includeCharacters: false,
  })
  const afterReplaceClash = await inventory()
  const replaceClashNew = arrivedSince(beforeReplaceClashIds, afterReplaceClash)
  check(
    'HSR-Scanner shifted replace from positional ids: A keeps relic_1 and stays worn, the new piece is renamed',
    replaceClash.replacedById === 0 && replaceClash.totalAfter === 3
      && afterReplaceClash.total === 3
      && afterReplaceClash.duplicateIds.length === 0
      && afterReplaceClash.records('relic_1').length === 1
      && afterReplaceClash.records('relic_1')[0].part === 'Head'
      && afterReplaceClash.records('relic_1')[0].equippedBy === '1105'
      && afterReplaceClash.records('relic_1')[0].substats.some((substat) => substat.stat === 'CRIT DMG')
      && afterReplaceClash.records('relic_2').length === 1
      && afterReplaceClash.records('relic_2')[0].part === 'Hands'
      && buildHead(afterReplaceClash) === 'relic_1'
      && replaceClashNew.length === 1
      && !['relic_1', 'relic_2', 'relic_3'].includes(replaceClashNew[0].id)
      && hasEffectRes(replaceClashNew[0]),
    `${sameIdStats(replaceClash)}; new=${replaceClashNew.map((relic) => relic.id).join(',')}, build=${buildHead(afterReplaceClash)}`,
  )

  // Two new relics in one file share a positional id. The first keeps it.
  await callTool(client, 'load_save', { path: freshSavePath() })
  const beforeSharedIds = idsOf(await inventory())
  const sharedUid = await callTool(client, 'import_scanner_json', {
    inline: scannerJson([
      uidRelic('relic_9', 15, SUBS_PLUS15),
      uidRelic('relic_9', 15, SUBS_UNRELATED, { slot: 'Hands' }),
    ]),
  })
  const afterSharedUid = await inventory()
  const sharedAdded = arrivedSince(beforeSharedIds, afterSharedUid)
  const sharedRenamed = sharedAdded.filter((relic) => relic.id !== 'relic_9')
  check(
    'HSR-Scanner file with two relic_9s: both land, only one keeps that id',
    sharedUid.added === 2 && sharedUid.totalAfter === 164
      && afterSharedUid.duplicateIds.length === 0
      && afterSharedUid.records('relic_9').length === 1
      && sharedAdded.length === 2
      && sharedRenamed.length === 1
      && sharedRenamed[0].id.length > 0
      && hasEffectRes(sharedRenamed[0]),
    `${sameIdStats(sharedUid)}; relic_9=${afterSharedUid.records('relic_9').length}, other=${sharedRenamed.map((relic) => relic.id).join(',')}`,
  )

  // Yas writes `_id` (a fresh nanoid) and not `_uid`. The upstream parser
  // reads `_uid`, so these relics parse with no id and must not share one.
  await callTool(client, 'load_save', { path: freshSavePath() })
  const beforeYasIds = idsOf(await inventory())
  const dropUid = (relic) => {
    const copy = { ...relic }
    delete copy._uid
    return copy
  }
  const yasMissingUid = await callTool(client, 'import_scanner_json', {
    inline: {
      ...scannerJson([
        dropUid(uidRelic('ignored', 15, SUBS_PLUS15)),
        dropUid(uidRelic('ignored', 15, SUBS_UNRELATED, { slot: 'Hands' })),
      ]),
      source: 'yas-scanner',
      build: 'v0.1.21',
      version: 3,
    },
  })
  const afterYas = await inventory()
  const yasAdded = afterYas.relics.filter((relic) => !beforeYasIds.has(relic.id))
  check(
    'Yas relics without _uid: both are stored, under two distinct ids',
    yasMissingUid.source === 'yas-scanner' && yasMissingUid.added === 2 && yasMissingUid.replacedById === 0
      && yasMissingUid.totalAfter === 164
      && afterYas.duplicateIds.length === 0
      && yasAdded.length === 2
      && new Set(yasAdded.map((relic) => relic.id)).size === 2
      && yasAdded.every((relic) => typeof relic.id === 'string' && relic.id.length > 0),
    `${sameIdStats(yasMissingUid)}; added ids=${yasAdded.map((relic) => relic.id).join(',')}`,
  )
  await callTool(client, 'load_save', { path: freshSavePath() })
  await callTool(client, 'import_scanner_json', { inline: archiverJson([uidRelic('777301', 0, SUBS_PLUS0)]) })
  const otherPiece = await callTool(client, 'import_scanner_json', {
    inline: archiverJson([uidRelic('777301', 15, SUBS_PLUS15, { slot: 'Hands' })]),
  })
  const afterOtherPiece = await inventory()
  check(
    'stable id but a different piece (Head vs Hands): not an earlier state, nothing superseded',
    otherPiece.added === 1 && otherPiece.replacedById === 0 && otherPiece.totalAfter === 164
      && afterOtherPiece.records('777301').map((r) => r.part).sort().join(',') === 'Hands,Head',
    `${sameIdStats(otherPiece)}; parts=${afterOtherPiece.records('777301').map((r) => r.part).join(',')}`,
  )

  // 8. parse/argument error paths (Chinese where the web app is Chinese)
  await expectToolError(
    'import_scanner_json',
    { inline: { data: { avatar_list: [] } } },
    /Hoyolab.*import_hoyolab|import_hoyolab/,
    'scanner tool rejects a hoyolab-shaped payload and points at import_hoyolab',
  )
  await expectToolError(
    'import_hoyolab',
    { inline: scannerJson([]) },
    /import_scanner_json/,
    'hoyolab tool rejects a scanner payload and points at import_scanner_json',
  )
  await expectToolError(
    'import_scanner_json',
    { inline: scannerJson([], [], [], { source: 'foo-scanner' }) },
    /无法识别的扫描器/,
    'unknown scanner source string is rejected',
  )
  await expectToolError(
    'import_scanner_json',
    { inline: scannerJson([novelScannerRelic], [], [], { version: 3 }) },
    /版本不匹配/,
    'version mismatch surfaces the i18n-localized parser error (not a raw key)',
  )
  await expectToolError(
    'import_scanner_json',
    { path: novelFixture, inline: scannerJson([]) },
    /二选一/,
    'path and inline are mutually exclusive',
  )
  await expectToolError('import_scanner_json', { path: `${tempDir}/does-not-exist.json` }, /不存在/, 'missing file is rejected')
  await expectToolError('import_scanner_json', {}, /二选一/, 'neither path nor inline is rejected')

  // ══ import_hoyolab ═════════════════════════════════════════════════════════

  // 9. minimal fixture walk-through — Clara (not in the sample save) with a
  // body (set 115, absent from the save) and a link rope (set 311, absent)
  const phase5 = freshSavePath()
  await callTool(client, 'load_save', { path: phase5 })
  const hoyolabMinimal = {
    data: {
      avatar_list: [{
        id: 1107,
        level: 76,
        name: 'Clara',
        rank: 0,
        equip: { id: 20000, level: 80, rank: 1, rarity: 5 },
        relics: [{
          id: 61153, // substring(1,4) = '115' — set absent from the sample save
          level: 15,
          pos: 3,
          rarity: 5,
          main_property: { property_type: 53, value: '64.8', times: 0 },
          properties: [
            { property_type: 33, value: '11.7%', times: 2, is_preview: false },
            { property_type: 51, value: '25', times: 2, is_preview: false },
          ],
        }],
        ornaments: [{
          id: 63116, // substring(1,4) = '311' — ornament set absent from the save
          level: 15,
          pos: 6,
          rarity: 5,
          main_property: { property_type: 54, value: '55.1%', times: 0 },
          properties: [{ property_type: 29, value: '38.1', times: 2, is_preview: false }],
        }],
        ranks: Array.from({ length: 6 }, (_, i) => ({ id: 110701 + i, pos: i + 1, name: 'e', icon: '', desc: '', is_unlocked: false })),
      }],
    },
  }
  const hlFixture = fixtureFile('hoyolab-min.json', hoyolabMinimal)
  const hlImport = await callTool(client, 'import_hoyolab', { path: hlFixture })
  check(
    'hoyolab import (union): 2 relics added, character created',
    hlImport.source === 'hoyolab' && hlImport.added === 2 && hlImport.updated === 0 && hlImport.skipped === 0 && hlImport.charactersTouched === 1,
    `added=${hlImport.added}, updated=${hlImport.updated}, skipped=${hlImport.skipped}, chars=${hlImport.charactersTouched}`,
  )
  check('hoyolab union grows 162 → 164', hlImport.totalBefore === 162 && hlImport.totalAfter === 164, `${hlImport.totalBefore} → ${hlImport.totalAfter}`)
  const hlChar = await callTool(client, 'get_character', { characterId: '1107' })
  check(
    'hoyolab character created with level normalized 80 (fixture 76) and its light cone',
    hlChar.savedForm?.characterLevel === 80 && hlChar.savedForm?.lightCone === '20000' && hlChar.savedForm?.lightConeSuperimposition === 1,
    `level=${hlChar.savedForm?.characterLevel}, lc=${hlChar.savedForm?.lightCone} s${hlChar.savedForm?.lightConeSuperimposition}`,
  )
  check(
    'hoyolab relics land equipped on the imported character (Body + LinkRope slots)',
    hlChar.equippedSlots?.Body?.equippedId != null && hlChar.equippedSlots?.LinkRope?.equippedId != null && hlChar.equippedSlots?.Head?.equippedId == null,
    `Body=${hlChar.equippedSlots?.Body?.equippedId != null}, Rope=${hlChar.equippedSlots?.LinkRope?.equippedId != null}`,
  )

  // 10. hoyolab same-hash skip — a Head owned in the store, re-imported ON its
  // current owner (avatar id = owner) so equippedBy is unchanged; hoyolab
  // relics are unverified and carry no ageIndex ⇒ a true no-op (skipped).
  const owner = String(ownedHead.equippedBy)
  const hlSkip = {
    data: {
      avatar_list: [{
        id: Number(owner),
        level: 60,
        name: 'owner',
        rank: 0,
        equip: { id: 20000, level: 80, rank: 1, rarity: 5 },
        relics: [{
          id: Number(`6${setIdByName[ownedHead.set]}11`),
          level: ownedHead.enhance,
          pos: 1,
          rarity: ownedHead.grade,
          main_property: { property_type: HL_STAT[ownedHead.main.stat], value: String(ownedHead.main.value), times: 0 },
          properties: ownedHead.substats.map((s) => ({
            property_type: HL_STAT[s.stat],
            value: FLAT_STATS.has(s.stat) ? String(s.value) : `${s.value}%`,
            times: 0,
            is_preview: false,
          })),
        }],
        ornaments: [],
        ranks: Array.from({ length: 6 }, (_, i) => ({ id: Number(`${owner}0${i + 1}`), pos: i + 1, name: 'e', icon: '', desc: '', is_unlocked: false })),
      }],
    },
  }
  const hlSkipImport = await callTool(client, 'import_hoyolab', { inline: hlSkip })
  check(
    'hoyolab owner-matched same-hash relic: skipped=1, added=0',
    hlSkipImport.skipped === 1 && hlSkipImport.added === 0 && hlSkipImport.updated === 0,
    `added=${hlSkipImport.added}, updated=${hlSkipImport.updated}, skipped=${hlSkipImport.skipped}`,
  )
  check('hoyolab skip keeps the inventory at 164', hlSkipImport.totalAfter === 164, `${hlSkipImport.totalBefore} → ${hlSkipImport.totalAfter}`)
  await expectToolError('import_hoyolab', { inline: { foo: 1 } }, /avatar_list/, 'hoyolab tool rejects a junk payload with the format error')

  // ══ import_showcase ════════════════════════════════════════════════════════

  // 11. argument/cache/conversion error paths — run BEFORE any successful
  // fetch/import so the in-process cache is still empty
  const phase6 = freshSavePath()
  await callTool(client, 'load_save', { path: phase6 })
  await expectToolError(
    'import_showcase',
    { mode: 'relics' },
    /fetch_showcase|可用的展示柜/,
    'import_showcase without cache or json errors (no fetch happened this session)',
  )
  await expectToolError('import_showcase', { mode: 'character' }, /characterId/, 'mode=character without characterId is rejected')
  await expectToolError('import_showcase', { mode: 'relics', characterId: '1107' }, /仅在 mode=character/, 'characterId is rejected outside mode=character')
  await expectToolError(
    'import_showcase',
    { mode: 'relics', json: { source: 'yas', detailInfo: {} } },
    /不支持的 showcase 数据源/,
    'inline json with an unknown source is rejected (Chinese conversion error)',
  )
  await expectToolError(
    'import_showcase',
    { mode: 'relics', json: { source: 'mihomo', detailInfo: { avatarDetailList: [] } } },
    /没有任何可导入的角色/,
    'inline json with an empty showcase is rejected',
  )

  // 12. relics mode — Clara with 6 relics in sets absent from the save
  // (cavern 115 / ornament 311) ⇒ deterministic all-added prediction
  const showcaseJson = {
    source: 'mihomo',
    detailInfo: {
      avatarDetailList: [{
        avatarId: 1107,
        level: 79,
        rank: 2,
        equipment: { tid: '20000', level: 80, rank: 1 },
        relicList: [
          {
            tid: '61151',
            level: 15,
            main_affix: { type: 'HPDelta' },
            subAffixList: [{ type: 'AttackAddedRatio', cnt: 2, step: 1 }, { type: 'CriticalDamageBase', cnt: 2, step: 0 }],
          },
          {
            tid: '61152',
            level: 15,
            main_affix: { type: 'AttackDelta' },
            subAffixList: [{ type: 'HPAddedRatio', cnt: 2, step: 1 }, { type: 'SpeedDelta', cnt: 1, step: 0 }],
          },
          {
            tid: '61153',
            level: 15,
            main_affix: { type: 'CriticalDamageBase' },
            subAffixList: [{ type: 'AttackAddedRatio', cnt: 3, step: 2 }, { type: 'StatusResistanceBase', cnt: 1, step: 0 }],
          },
          {
            tid: '61154',
            level: 15,
            main_affix: { type: 'SpeedDelta' },
            subAffixList: [{ type: 'HPAddedRatio', cnt: 2, step: 0 }, { type: 'BreakDamageAddedRatioBase', cnt: 2, step: 1 }],
          },
          {
            tid: '63115',
            level: 15,
            main_affix: { type: 'FireAddedRatio' },
            subAffixList: [{ type: 'AttackAddedRatio', cnt: 2, step: 1 }, { type: 'CriticalChanceBase', cnt: 1, step: 0 }],
          },
          {
            tid: '63116',
            level: 15,
            main_affix: { type: 'SPRatioBase' },
            subAffixList: [{ type: 'AttackDelta', cnt: 2, step: 1 }, { type: 'HPDelta', cnt: 2, step: 0 }],
          },
        ],
      }],
    },
  }
  const relicsImport = await callTool(client, 'import_showcase', { mode: 'relics', json: showcaseJson })
  check(
    'showcase relics mode: 6 predicted-added relics all land (prediction cross-checked)',
    relicsImport.relics?.predictedAdded === 6 && relicsImport.relics?.predictedUpdated === 0
      && relicsImport.relics?.addedDelta === 6 && relicsImport.relics?.deltaMatchesPrediction === true,
    JSON.stringify(relicsImport.relics),
  )
  check(
    'showcase relics mode: store 162 → 168',
    relicsImport.relics?.storeBefore === 162 && relicsImport.relics?.storeAfter === 168,
    `${relicsImport.relics?.storeBefore} → ${relicsImport.relics?.storeAfter}`,
  )
  check(
    'showcase relics mode imports no characters',
    relicsImport.mode === 'relics' && relicsImport.dataOrigin === 'inline' && relicsImport.source === 'mihomo'
      && relicsImport.charactersStoreBefore === 8 && relicsImport.charactersStoreAfter === 8 && relicsImport.importedCharacters.length === 0,
    `chars ${relicsImport.charactersStoreBefore} → ${relicsImport.charactersStoreAfter}, imported=${relicsImport.importedCharacters.length}`,
  )
  const showcaseCharAbsent = await toolErrorText(client, 'get_character', { characterId: '1107' })
  check('relics mode does not create the showcase character', showcaseCharAbsent != null, String(showcaseCharAbsent).slice(0, 80))
  const ashblazing = await callTool(client, 'list_relics', { set: 'The Ashblazing Grand Duke', limit: 10 })
  const ashblazingUnequipped = await callTool(client, 'list_relics', { set: 'The Ashblazing Grand Duke', equippedBy: 'none', limit: 10 })
  check(
    'relics-mode additions are unequipped (web parity: mergePartialRelics adds with equippedBy undefined)',
    ashblazing.total === 4 && ashblazingUnequipped.total === 4 && ashblazing.relics.every((r) => r.equippedBy == null),
    `${ashblazing.total} Ashblazing relics, ${ashblazingUnequipped.total} unequipped`,
  )

  // 13. character mode — same inline json: relics now exist ⇒ all matched and
  // updated in place (added=0), character created and equipped
  const charImport = await callTool(client, 'import_showcase', { mode: 'character', characterId: '1107', json: showcaseJson })
  check(
    'showcase character mode: re-import updates the 6 existing relics in place (added=0)',
    charImport.relics?.predictedUpdated === 6 && charImport.relics?.predictedAdded === 0 && charImport.relics?.deltaMatchesPrediction === true,
    JSON.stringify(charImport.relics),
  )
  check(
    'showcase character mode keeps the store at 168',
    charImport.relics?.storeBefore === 168 && charImport.relics?.storeAfter === 168,
    `${charImport.relics?.storeBefore} → ${charImport.relics?.storeAfter}`,
  )
  check(
    'showcase character mode creates the character with all 6 slots equipped',
    charImport.importedCharacters?.length === 1 && charImport.importedCharacters[0].characterId === '1107'
      && charImport.importedCharacters[0].created === true && charImport.importedCharacters[0].equippedCount === 6
      && charImport.charactersStoreAfter === 9,
    JSON.stringify(charImport.importedCharacters),
  )
  const showcaseChar = await callTool(client, 'get_character', { characterId: '1107' })
  const equippedParts = Object.entries(showcaseChar.equippedSlots ?? {}).filter(([, slot]) => slot?.equippedId != null).map(([part]) => part)
  check(
    'get_character confirms all 6 showcase slots equipped on 1107',
    equippedParts.length === 6 && showcaseChar.savedForm?.lightCone === '20000' && showcaseChar.savedForm?.characterEidolon === 2,
    `slots: ${equippedParts.sort().join(',')}, lc=${showcaseChar.savedForm?.lightCone}, e${showcaseChar.savedForm?.characterEidolon}`,
  )

  // 14. markDirty → debounced flush persists the showcase import to the save file
  await sleep(1800)
  const flushed6 = JSON.parse(readFileSync(phase6, 'utf8'))
  check(
    'showcase imports persisted to the loaded save file (168 relics, character present)',
    flushed6.relics.length === 168 && flushed6.characters.some((c) => c.id === '1107'),
    `${flushed6.relics.length} relics, has 1107=${flushed6.characters.some((c) => c.id === '1107')}`,
  )

  // 15. cacheId consistency check (cache is now populated by the inline import)
  await expectToolError(
    'import_showcase',
    { mode: 'relics', cacheId: 'showcase-bogus-1' },
    /cacheId 不匹配/,
    'import_showcase rejects a mismatched cacheId',
  )
  const cacheImport = await callTool(client, 'import_showcase', { mode: 'relics' })
  check(
    'import_showcase runs from the last cache without a cacheId',
    cacheImport.dataOrigin === 'cache' && cacheImport.mode === 'relics' && cacheImport.relics?.predictedUpdated === 6,
    `origin=${cacheImport.dataOrigin}, predictedUpdated=${cacheImport.relics?.predictedUpdated}`,
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-imports: ALL CHECKS PASSED' : `\nsmoke-imports: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
