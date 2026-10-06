// End-to-end smoke test for the imports + showcase tool surface.
//
// Spawns the built server over stdio and walks the import happy paths and
// error paths, fully offline:
//   import_scanner_json — union semantics (the erratum #5 core: a 1-relic
//     import into a 162-relic inventory must yield 163, never 1),
//     same-hash skip stats, existingCharactersOnly, level normalization,
//     dryRun (no store write, no disk write), strict-subset union anti-wipe,
//     replace-mode shrink (intentional upstream semantics), parse errors
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
