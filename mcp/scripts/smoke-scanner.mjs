// End-to-end smoke test for the live scanner client (M6-A) + the
// includeCharacters import option, fully offline.
//
// Spawns the built server over stdio against a FAKE Reliquary Archiver: a
// throwaway node:http + ws WebSocketServer on an ephemeral 127.0.0.1 port that
// pushes scripted event frames (InitialScan / UpdateRelics / UpdateCharacters /
// UpdateLightCones / UpdateMaterials / UpdateGachaFunds / GachaResult /
// DeleteRelics / DeleteLightCones, plus one malformed raw frame). No real
// network is ever touched — the client only ever dials 127.0.0.1.
//
// Asserts, in order:
//   scanner tool registration; status/events before any connection; connect
//   gated on a loaded save; unreachable target → actionable Chinese error;
//   connect via the update_state(section=scanner) websocketUrl default;
//   connect idempotency; InitialScan applied through the union import chain
//   (inventory grows, characters created at level 80 with light cones);
//   UpdateRelics adds/equips a 5★ relic and ignores a 4★ one; UpdateCharacters
//   creates a character (light cone matched through the pushed UpdateLightCones
//   cache); UpdateGachaFunds lands jades=stellar_jade+oner ic_shards in the
//   warp planner request; GachaResult syncs pity/guarantee to the warp draft; a
//   malformed JSON frame logs an error WITHOUT dropping the connection; store
//   deletes flow through DeleteRelics by _uid (non-5★ is a store no-op);
//   status frame stats; status/events are read-only (no revision bump);
//   events pagination + result classification; server-side termination →
//   automatic reconnection (cache reset semantics intact); disconnect
//   idempotency; manual re-connect continues the session.
//   import_scanner_json / import_hoyolab with includeCharacters=false: relics
//   only, characters untouched; default still imports characters.
//
// Everything persists into a temp directory (fresh save copies per phase +
// HSR_MCP_STATE_FILE); the repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-scanner.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import {
  fileURLToPath,
} from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  WebSocket,
  WebSocketServer,
} from 'ws'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const repoGameDataPath = resolve(mcpDir, '../src/data/game_data.json')

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-scanner-`)
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

/** Text of a tool failure, whether it threw (handler error / zod) or came back isError. Null when it did NOT fail. */
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

/** Poll a tool-call predicate until it holds (default 5s / 50ms ticks). */
async function pollUntil(desc, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last.ok) return last
    await sleep(50)
  }
  return last
}

// ── fixture builders (mirrors kelzFormatParser lookups) ─────────────────────

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

/** Store relic → kelz V4ParserRelic with hash-shifting substat overrides. */
function scannerRelicFromStore(relic, uid, substatValueOverrides = {}, overrides = {}) {
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
    ...overrides,
  }
}

/** Live frames must look like a real Reliquary Archiver v4 payload. */
function archiverJson(relics, characters = [], lightCones = [], extra = {}) {
  return {
    source: 'reliquary_archiver',
    build: 'v0.8.0',
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

/** File-import fixtures stay on the HSR-Scanner flavor (source auto-detect path). */
function kelzJson(relics, characters = [], lightCones = []) {
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
  }
}

let copyCounter = 0
/** Fresh pristine copy of the sample save; each phase loads its own so debounced flushes never pollute baselines. */
function freshSavePath() {
  const p = `${tempDir}/save-phase-${++copyCounter}.json`
  copyFileSync(repoSampleSavePath, p)
  return p
}

// Relic #0 of the pristine save: a 5★ Head — the back-conversion target.
const headRelic = pristineSave.relics[0]
if (headRelic.part !== 'Head' || headRelic.grade !== 5) {
  throw new Error(`unexpected sample-save relic[0]: ${headRelic.part}/${headRelic.grade}`)
}

// Characters: released metadata ids that are NOT in the sample save.
const saveCharIds = new Set(pristineSave.characters.map((c) => c.id))
const candidateIds = Object.values(gameData.characters)
  .filter((c) => typeof c.id === 'string' && /^\d{4}$/.test(c.id) && c.unreleased !== true && !saveCharIds.has(c.id))
  .map((c) => c.id)
if (candidateIds.length < 3) throw new Error(`not enough fresh character ids: ${candidateIds.join(',')}`)
const CH_INIT = candidateIds[0]
const CH_UPDATE = candidateIds[1]
const CH_FILE = candidateIds[2]
const LIGHT_CONE_ID = Object.values(gameData.lightCones).find((lc) => lc.unreleased !== true)?.id ?? '20000'

function lightConeFor(characterId, uid, superimposition = 1) {
  return { id: LIGHT_CONE_ID, name: 'smoke lc', level: 5, ascension: 0, superimposition, location: characterId, lock: false, _uid: uid }
}
// ability_version: 0 = explicitly unbuffed (missing value would map to the buffed variant)
const charFixture = (id, eidolon = 0) => ({ id, name: 'smoke char', path: 'The Destruction', level: 1, ascension: 0, eidolon, ability_version: 0 })

// Novel-hash relics: relic[0] with shifted substat values (same part/set/main,
// different substats ⇒ new hash), unique _uids.
const novel = (uid, shift, extra = {}) => scannerRelicFromStore(headRelic, uid, { 0: headRelic.substats[0].value + shift }, extra)

// ── fake Reliquary Archiver (ws server on an ephemeral port) ────────────────

const archiverHttp = createServer()
const archiverWss = new WebSocketServer({ server: archiverHttp })
const archiverClients = new Set()
let archiverFrames = 0
archiverWss.on('connection', (ws) => {
  archiverClients.add(ws)
  ws.on('close', () => archiverClients.delete(ws))
})
await new Promise((resolveListen) => archiverHttp.listen(0, '127.0.0.1', resolveListen))
const archiverPort = archiverHttp.address().port
const archiverUrl = `ws://127.0.0.1:${archiverPort}/ws`

/** Push one frame (object → JSON, string → raw text for the malformed case). */
function push(payload) {
  archiverFrames++
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  for (const ws of archiverClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text)
  }
}
const frame = (event, data) => push({ event, data })

// A port that is now closed (for the unreachable-target error path).
const ghostHttp = createServer()
await new Promise((resolveListen) => ghostHttp.listen(0, '127.0.0.1', resolveListen))
const ghostPort = ghostHttp.address().port
await new Promise((resolveClose) => ghostHttp.close(resolveClose))

// ── boot the MCP server ──────────────────────────────────────────────────────

const client = new Client({ name: 'smoke-scanner', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

async function relicsTotal() {
  return (await callTool(client, 'list_relics', { limit: 1 })).total
}

try {
  // 1. tool surface
  const tools = await client.listTools()
  check('tool scanner registered', tools.tools.map((t) => t.name).includes('scanner'))

  // 2. pre-connection status/events (read-only, no save needed)
  const coldStatus = await callTool(client, 'scanner', { action: 'status' })
  check(
    'status before any connection: disconnected, no url, no save',
    coldStatus.connected === false && coldStatus.url === null && coldStatus.reconnecting === false && coldStatus.saveLoaded === false,
    JSON.stringify({ connected: coldStatus.connected, url: coldStatus.url, saveLoaded: coldStatus.saveLoaded }),
  )
  const coldEvents = await callTool(client, 'scanner', { action: 'events' })
  check('events before any connection: empty log', coldEvents.total === 0 && coldEvents.entries.length === 0, `total=${coldEvents.total}`)

  // 3. connect is gated on a loaded save
  await expectToolError('scanner', { action: 'connect', url: archiverUrl }, /No save loaded/, 'connect refuses before load_save')

  // 4. load a save copy, then hit an unreachable target
  const phase1 = freshSavePath()
  const loaded = await callTool(client, 'load_save', { path: phase1 })
  check('phase 1 baseline: 162 relics / 8 characters', loaded.relics === 162 && loaded.characters === 8, `${loaded.relics}/${loaded.characters}`)
  await expectToolError(
    'scanner',
    { action: 'connect', url: `ws://127.0.0.1:${ghostPort}/ws` },
    /连接扫描器失败/,
    'unreachable target returns the actionable Chinese connection error',
  )
  const afterGhost = await callTool(client, 'scanner', { action: 'status' })
  check(
    'failed connect leaves no reconnect loop',
    afterGhost.connected === false && afterGhost.reconnecting === false,
    `reconnecting=${afterGhost.reconnecting}`,
  )

  // 5. configure the scanner settings + default url, then connect WITHOUT url
  await callTool(client, 'update_state', {
    section: 'scanner',
    patch: { ingest: true, ingestCharacters: true, ingestWarpResources: true, websocketUrl: archiverUrl },
  })
  const connected1 = await callTool(client, 'scanner', { action: 'connect' })
  check(
    'connect (no url) uses the update_state(section=scanner) websocketUrl',
    connected1.connected === true && connected1.alreadyConnected === false && connected1.url === archiverUrl,
    `url=${connected1.url}, note=${connected1.note ?? '(none)'}`,
  )
  const again = await callTool(client, 'scanner', { action: 'connect' })
  check(
    'connect is idempotent on the same url (alreadyConnected)',
    again.connected === true && again.alreadyConnected === true,
    `alreadyConnected=${again.alreadyConnected}`,
  )

  // 6. InitialScan → union import chain (162 + 2 novel = 164) + character at 80
  frame('InitialScan', archiverJson([novel('9001', 10), novel('9002', 20)], [charFixture(CH_INIT)], [lightConeFor(CH_INIT, 'lc-init', 2)]))
  const scanWait = await pollUntil('initial scan applied', async () => ({ ok: await relicsTotal() === 164, total: await relicsTotal() }))
  check('InitialScan applied through the union chain: 162 → 164', scanWait.ok, `total=${scanWait.total}`)
  const initChar = await callTool(client, 'get_character', { characterId: CH_INIT })
  check(
    'InitialScan character created at level 80 with its light cone',
    initChar.savedForm?.characterLevel === 80 && initChar.savedForm?.lightConeLevel === 80 && initChar.savedForm?.lightCone === LIGHT_CONE_ID
      && initChar.savedForm?.lightConeSuperimposition === 2,
    `level=${initChar.savedForm?.characterLevel}, lc=${initChar.savedForm?.lightCone} s${initChar.savedForm?.lightConeSuperimposition}`,
  )
  // recentRelics after a scan = last 6 scan relics, newest first (scannerStore:250-253)
  const recentAfterScan = (await callTool(client, 'get_state', { section: 'relicsTab' })).relicsTab.recentRelics
  check(
    'recentRelics after InitialScan: scan tail reversed (9002 head), cards resolve to inventory',
    recentAfterScan.ids[0] === '9002' && recentAfterScan.ids[1] === '9001'
      && recentAfterScan.cards[0]?.id === '9002' && recentAfterScan.cards[0]?.equippedBy == null,
    JSON.stringify(recentAfterScan.ids.slice(0, 3)),
  )

  // 7. UpdateRelics → 5★ added + equipped
  frame('UpdateRelics', [novel('9003', 30, { location: CH_INIT })])
  await pollUntil('update relics applied', async () => ({ ok: await relicsTotal() === 165, total: await relicsTotal() }))
  check('UpdateRelics adds the 5★ relic: 164 → 165', await relicsTotal() === 165, `total=${await relicsTotal()}`)
  const owner = await callTool(client, 'get_character', { characterId: CH_INIT })
  check(
    'UpdateRelics equips the relic on its location character',
    owner.equippedSlots?.Head?.equippedId != null,
    `Head=${owner.equippedSlots?.Head?.equippedId}`,
  )
  // A novel relic via UpdateRelics is PREPENDED to recentRelics (scannerStore:295-301)
  const recentAfterUpdate = (await callTool(client, 'get_state', { section: 'relicsTab' })).relicsTab.recentRelics
  check(
    'recentRelics after UpdateRelics: new uid prepended, equippedBy follows the location',
    recentAfterUpdate.ids[0] === '9003' && recentAfterUpdate.cards[0]?.equippedBy === CH_INIT,
    JSON.stringify(recentAfterUpdate.ids.slice(0, 3)),
  )

  // 8. UpdateRelics with a 4★ relic → store untouched
  frame('UpdateRelics', [novel('9004', 40, { rarity: 4, level: 12 })])
  await sleep(300)
  check('non-5★ UpdateRelics leaves the inventory unchanged (165)', await relicsTotal() === 165, `total=${await relicsTotal()}`)

  // 9. UpdateLightCones (cache-only) + UpdateCharacters → character created
  frame('UpdateLightCones', [lightConeFor(CH_UPDATE, 'lc-update', 1)])
  frame('UpdateCharacters', [charFixture(CH_UPDATE, 4)])
  await pollUntil('update character applied', async () => {
    const absent = await toolErrorText(client, 'get_character', { characterId: CH_UPDATE })
    return { ok: absent == null, absent: absent != null }
  })
  const updateChar = await callTool(client, 'get_character', { characterId: CH_UPDATE })
  check(
    'UpdateCharacters creates the character (raw level kept, light cone via the pushed UpdateLightCones cache)',
    updateChar.savedForm?.characterLevel === 1 && updateChar.savedForm?.lightCone === LIGHT_CONE_ID && updateChar.savedForm?.characterEidolon === 4,
    `level=${updateChar.savedForm?.characterLevel} (incremental path keeps raw level — level || 80), lc=${updateChar.savedForm?.lightCone}, e${updateChar.savedForm?.characterEidolon}`,
  )

  // 10. UpdateMaterials + UpdateGachaFunds → warp draft jades AND passes
  // (useWarpScannerSync.ts:16-24: jades = 星琼+梦华; passes = 专票 + floor(未熄星芒/20))
  frame('UpdateMaterials', [{ id: '102', name: 'Special Pass', count: 5 }, { id: '252', name: 'Undying Starlight', count: 37 }])
  frame('UpdateGachaFunds', { stellar_jade: 1600, oneric_shards: 320 })
  const warpWait = await pollUntil('gacha funds applied', async () => {
    const plan = await callTool(client, 'warp_plan', { fromSaved: true })
    return { ok: plan.request?.jades === 1920 && plan.request?.passes === 6, jades: plan.request?.jades, passes: plan.request?.passes }
  })
  check(
    'warp sync: jades = 1600+320 and passes = 5 + floor(37/20) = 6 (useWarpScannerSync formulas)',
    warpWait.ok,
    `jades=${warpWait.jades}, passes=${warpWait.passes}`,
  )

  // 11. GachaResult → pull history never lands; pity/guarantee sync to the warp draft
  frame('GachaResult', {
    banner_id: 1,
    banner_type: 'Character',
    pity_4: { kind: 'AddPity', amount: 1 },
    pity_5: { kind: 'AddPity', amount: 3 },
    pull_results: [],
  })
  await sleep(300)
  let afterGacha = await callTool(client, 'warp_plan', { fromSaved: true })
  check(
    'GachaResult AddPity accumulates pityCharacter (history itself never lands)',
    afterGacha.request?.pityCharacter === 3 && afterGacha.request?.guaranteedCharacter === false,
    `pity=${afterGacha.request?.pityCharacter}`,
  )
  frame('GachaResult', {
    banner_id: 1,
    banner_type: 'LightCone',
    pity_4: { kind: 'AddPity', amount: 1 },
    pity_5: { kind: 'ResetPity', amount: 20, set_guarantee: true },
    pull_results: [],
  })
  await sleep(300)
  afterGacha = await callTool(client, 'warp_plan', { fromSaved: true })
  check(
    'GachaResult ResetPity on the light-cone banner sets pity + guarantee',
    afterGacha.request?.pityLightCone === 20 && afterGacha.request?.guaranteedLightCone === true && afterGacha.request?.pityCharacter === 3,
    `lcPity=${afterGacha.request?.pityLightCone}, guaranteed=${afterGacha.request?.guaranteedLightCone}, charPity=${afterGacha.request?.pityCharacter}`,
  )

  // 12. malformed frame → logged, connection survives (next frame still applies)
  push('{not valid json')
  frame('UpdateRelics', [novel('9005', 50)])
  const malformedWait = await pollUntil('post-malformed frame applied', async () => ({ ok: await relicsTotal() === 166, total: await relicsTotal() }))

  check('malformed JSON frame does NOT disconnect: next frame still applies (165 → 166)', malformedWait.ok, `total=${malformedWait.total}`)

  // 13. DeleteRelics by _uid → store delete; non-5★ uid → store no-op
  frame('DeleteRelics', ['9005'])
  await pollUntil('delete applied', async () => ({ ok: await relicsTotal() === 165, total: await relicsTotal() }))
  check('DeleteRelics removes the 5★ relic by _uid: 166 → 165', await relicsTotal() === 165, `total=${await relicsTotal()}`)
  frame('DeleteRelics', ['9004'])
  await sleep(300)
  check('DeleteRelics of a non-5★ uid is a store no-op (165)', await relicsTotal() === 165, `total=${await relicsTotal()}`)
  frame('DeleteLightCones', ['lc-update'])

  // 14. status snapshot — frames pushed so far: InitialScan, UR(5★), UR(4★),
  // ULC, UC, UM, UGF, GachaResult×2, malformed, UR(9005), DR(9005), DR(9004), DLC = 14.
  // The DLC frame is the only one without its own settle below — poll for its
  // cache effect before reading the counters (ws delivery vs the stdio status
  // call is otherwise a race; flaky ~50% before this fix).
  const dlcSettled = await pollUntil('delete-light-cone frame settled', async () => {
    const probe = await callTool(client, 'scanner', { action: 'status' })
    return { ok: probe.scannerCache?.lightCones === 1 && probe.frames?.received === 14, received: probe.frames?.received, lcs: probe.scannerCache?.lightCones }
  })
  check(
    'DeleteLightCones settled (cache 2 → 1) before the frame-stat assertions',
    dlcSettled.ok,
    `received=${dlcSettled.received}, lightCones=${dlcSettled.lcs}`,
  )
  const status = await callTool(client, 'scanner', { action: 'status' })
  check(
    'status: connected, url, and cumulative frame stats',
    status.connected === true && status.url === archiverUrl && status.frames.received === 14 && status.frames.applied === 12
      && status.frames.ignored === 2 && status.frames.errored === 1 && status.reconnects === 0 && status.uptimeMs >= 0,
    JSON.stringify({ received: status.frames?.received, applied: status.frames?.applied, ignored: status.frames?.ignored, errored: status.frames?.errored }),
  )
  check(
    'status: scanner cache snapshot + settings echo',
    status.scannerCache.relics === 3 && status.scannerCache.lightCones === 1 && status.scannerCache.characters === 2
      && status.scannerCache.materials === 2 && status.scannerCache.gachaFunds === true && status.settings.ingest === true
      && status.settings.ingestWarpResources === true,
    JSON.stringify(status.scannerCache),
  )

  // 15. status/events are read-only (revision must not move)
  const revBefore = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  await callTool(client, 'scanner', { action: 'status' })
  await callTool(client, 'scanner', { action: 'events' })
  const revAfter = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  check('status/events do not bump the revision', revBefore === revAfter, `${revBefore} → ${revAfter}`)

  // 16. events log contents + pagination
  const events = await callTool(client, 'scanner', { action: 'events' })
  const byType = (type) => events.entries.filter((e) => e.type === type)
  const gachaEntry = byType('GachaResult')[0]
  check(
    'events: GachaResult recorded as applied-for-warp (history never lands)',
    gachaEntry?.result === 'applied' && /垫抽|必中/.test(gachaEntry?.summary ?? ''),
    JSON.stringify(gachaEntry)?.slice(0, 120),
  )
  const parseErrorEntry = byType('parse_error')[0]
  check(
    'events: malformed frame recorded as an error entry',
    parseErrorEntry?.result === 'error' && typeof parseErrorEntry.error === 'string',
    JSON.stringify(parseErrorEntry)?.slice(0, 120),
  )
  check(
    'events: every event kind is represented with a Chinese summary',
    [
      'InitialScan',
      'UpdateRelics',
      'UpdateCharacters',
      'UpdateLightCones',
      'UpdateMaterials',
      'UpdateGachaFunds',
      'DeleteRelics',
      'DeleteLightCones',
      'GachaResult',
      'parse_error',
    ]
      .every((type) => byType(type).length > 0 && byType(type).every((e) => /[\u4e00-\u9fff]/.test(e.summary))),
    `types=${events.entries.map((e) => e.type).join(',')}`,
  )
  const seqs = events.entries.map((e) => e.seq)
  check('events: entries are seq-monotonic', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(','))
  const paged = await callTool(client, 'scanner', { action: 'events', offset: events.total - 2, limit: 10 })
  check(
    'events: offset/limit pagination returns the tail',
    paged.entries.length === 2 && paged.entries[0].seq === seqs[seqs.length - 2],
    `got ${paged.entries.length}`,
  )

  // 19b. settings replay (web setter semantics, scannerStore.ts:164-228):
  // a scan pushed while ingest is OFF stays cache-only; flipping ingest ON while
  // connected must re-run the full import from the cached scan, and flipping
  // ingestWarpResources ON must re-emit the resources into the warp draft.
  const totalBeforeReplay = await relicsTotal()
  const jadesBeforeReplay = (await callTool(client, 'warp_plan', { fromSaved: true })).request?.jades
  await callTool(client, 'update_state', { section: 'scanner', patch: { ingest: false } })
  frame('UpdateRelics', [novel('9008', 80)])
  await sleep(300)
  check('scan pushed while ingest is OFF stays cache-only', await relicsTotal() === totalBeforeReplay, `total=${await relicsTotal()}`)
  await callTool(client, 'update_state', { section: 'scanner', patch: { ingest: true } })
  const replayed = await pollUntil('ingest flip replayed the cached scan', async () => ({
    ok: await relicsTotal() === totalBeforeReplay + 1,
    total: await relicsTotal(),
  }))
  check('flipping ingest ON while connected replays the cached scan (reimport)', replayed.ok, `total=${replayed.total}`)
  await callTool(client, 'update_state', { section: 'scanner', patch: { ingestWarpResources: false } })
  await callTool(client, 'update_state', { section: 'scanner', patch: { ingestWarpResources: true } })
  const jadesAfterReEmit = (await callTool(client, 'warp_plan', { fromSaved: true })).request?.jades
  check(
    'flipping ingestWarpResources ON re-emits the cached resources (warp-re-emit)',
    jadesAfterReEmit === 1920 && jadesBeforeReplay === 1920,
    `jades ${jadesBeforeReplay} → ${jadesAfterReEmit}`,
  )

  // 17. unexpected server-side termination → automatic reconnection
  for (const ws of archiverClients) ws.terminate()
  const reconnected = await pollUntil('auto-reconnect', async () => {
    const s = await callTool(client, 'scanner', { action: 'status' })
    return { ok: s.connected === true, connected: s.connected, reconnects: s.reconnects }
  }, 8000)
  check(
    'server-side termination: client reports reconnected automatically',
    reconnected.ok,
    `connected=${reconnected.connected}, reconnects=${reconnected.reconnects}`,
  )
  check('reconnect attempt was counted', reconnected.reconnects >= 1, `reconnects=${reconnected.reconnects}`)
  frame('UpdateRelics', [novel('9006', 60)])
  const postReconnect = await pollUntil('post-reconnect frame applied', async () => ({ ok: await relicsTotal() === 167, total: await relicsTotal() }))
  check('frames keep applying after the automatic reconnect (165 → 166)', postReconnect.ok, `total=${postReconnect.total}`)

  // 18. disconnect idempotency
  const disconnect1 = await callTool(client, 'scanner', { action: 'disconnect' })
  const statusAfterDisconnect = await callTool(client, 'scanner', { action: 'status' })
  check(
    'disconnect closes the connection and stops auto-reconnect',
    disconnect1.connected === false && disconnect1.wasConnected === true && statusAfterDisconnect.connected === false
      && statusAfterDisconnect.reconnecting === false,
    `wasConnected=${disconnect1.wasConnected}, reconnecting=${statusAfterDisconnect.reconnecting}`,
  )
  const disconnect2 = await callTool(client, 'scanner', { action: 'disconnect' })
  check(
    'disconnect is idempotent when not connected',
    disconnect2.connected === false && disconnect2.wasConnected === false,
    `wasConnected=${disconnect2.wasConnected}`,
  )

  // 19. manual re-connect continues the session
  const reconnected2 = await callTool(client, 'scanner', { action: 'connect' })
  check('manual re-connect after disconnect succeeds', reconnected2.connected === true && reconnected2.alreadyConnected === false, `url=${reconnected2.url}`)
  frame('UpdateRelics', [novel('9007', 70)])
  const finalRelics = await pollUntil('final frame applied', async () => ({ ok: await relicsTotal() === 168, total: await relicsTotal() }))
  check('session continues after the manual re-connect (167 → 168)', finalRelics.ok, `total=${finalRelics.total}`)

  // 20. persisted: the live writes flushed into the loaded save file copy
  await sleep(1800)
  const flushed1 = JSON.parse(readFileSync(phase1, 'utf8'))
  check('live-scanner writes persisted to the loaded save copy (168 relics)', flushed1.relics.length === 168, `${flushed1.relics.length} relics on disk`)

  // 21. param misuse errors
  await expectToolError('scanner', { action: 'status', url: archiverUrl }, /不适用于该 action/, 'status rejects the connect-only url param')
  await expectToolError('scanner', { action: 'connect', offset: 0 }, /不适用于该 action/, 'connect rejects the events-only offset param')

  // ══ includeCharacters=false (file imports, relics-only web parity) ═════════

  // 22. import_scanner_json includeCharacters=false
  const phase2 = freshSavePath()
  await callTool(client, 'load_save', { path: phase2 })
  const relicsOnly = await callTool(client, 'import_scanner_json', {
    inline: kelzJson([novel('9100', 80)], [charFixture(CH_FILE)], [lightConeFor(CH_FILE, 'lc-file')]),
    includeCharacters: false,
  })
  check(
    'import_scanner_json(includeCharacters=false): relics only — 1 added, 0 characters touched',
    relicsOnly.includeCharacters === false && relicsOnly.charactersTouched === 0 && relicsOnly.added === 1 && relicsOnly.totalAfter === 163,
    `chars=${relicsOnly.charactersTouched}, ${relicsOnly.totalBefore} → ${relicsOnly.totalAfter}`,
  )
  const fileCharAbsent = await toolErrorText(client, 'get_character', { characterId: CH_FILE })
  check('import_scanner_json(includeCharacters=false) does not create the character', fileCharAbsent != null, String(fileCharAbsent).slice(0, 100))

  // 23. import_hoyolab includeCharacters=false
  const hoyolabFixture = {
    data: {
      avatar_list: [{
        id: Number(CH_FILE),
        level: 76,
        name: 'relics-only',
        rank: 0,
        equip: { id: 20000, level: 80, rank: 1, rarity: 5 },
        relics: [{
          id: 61153, // set 115 — absent from the sample save
          level: 15,
          pos: 3,
          rarity: 5,
          main_property: { property_type: 53, value: '64.8', times: 0 },
          properties: [
            { property_type: 33, value: '11.7%', times: 2, is_preview: false },
            { property_type: 51, value: '25', times: 2, is_preview: false },
          ],
        }],
        ornaments: [],
        ranks: Array.from({ length: 6 }, (_, i) => ({ id: Number(`${CH_FILE}0${i + 1}`), pos: i + 1, name: 'e', icon: '', desc: '', is_unlocked: false })),
      }],
    },
  }
  const hlRelicsOnly = await callTool(client, 'import_hoyolab', { inline: hoyolabFixture, includeCharacters: false })
  check(
    'import_hoyolab(includeCharacters=false): the fixture relic added, 0 characters touched',
    hlRelicsOnly.includeCharacters === false && hlRelicsOnly.charactersTouched === 0 && hlRelicsOnly.added === 1
      && hlRelicsOnly.totalAfter === hlRelicsOnly.totalBefore + 1,
    `chars=${hlRelicsOnly.charactersTouched}, ${hlRelicsOnly.totalBefore} → ${hlRelicsOnly.totalAfter}`,
  )
  const hlCharAbsent = await toolErrorText(client, 'get_character', { characterId: CH_FILE })
  check('import_hoyolab(includeCharacters=false) still does not create the character', hlCharAbsent != null, String(hlCharAbsent).slice(0, 100))

  // 24. default (no includeCharacters) keeps the existing behavior
  const hlWithChars = await callTool(client, 'import_hoyolab', { inline: hoyolabFixture })
  check(
    'import_hoyolab default still imports characters (character upserted, relic merged)',
    hlWithChars.includeCharacters === true && hlWithChars.charactersTouched === 1 && hlWithChars.added === 0
      && (hlWithChars.skipped ?? 0) + (hlWithChars.updated ?? 0) === 1,
    `chars=${hlWithChars.charactersTouched}, added=${hlWithChars.added}, skipped=${hlWithChars.skipped}, updated=${hlWithChars.updated}`,
  )
  const hlChar = await callTool(client, 'get_character', { characterId: CH_FILE })
  check('default hoyolab import creates the character at level 80', hlChar.savedForm?.characterLevel === 80, `level=${hlChar.savedForm?.characterLevel}`)
} finally {
  await client.close()
  for (const ws of archiverClients) {
    try {
      ws.terminate()
    } catch {
      // already gone
    }
  }
  await new Promise((resolveClose) => archiverHttp.close(() => resolveClose()))
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-scanner: ALL CHECKS PASSED' : `\nsmoke-scanner: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
