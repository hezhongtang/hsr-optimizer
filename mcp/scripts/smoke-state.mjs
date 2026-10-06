// M4-B state-domain smoke: get_state / update_state section semantics.
//
// Exercises the state domain end-to-end against the built server
// (dist/index.js):
//   - get_state works from a cold boot (no save) and after a load, for every
//     section: revision counters, settings definitions with derived defaults,
//     persisted session fields + ephemeral block, flags array, scanner fields
//   - update_state(settings) with a valid baseRevision commits the change,
//     bumps revision exactly once, reports dirty, and get_state reflects it
//   - invalid enum values and unknown keys are rejected with actionable
//     messages (allowed values / legal keys listed) without bumping revision
//   - a stale baseRevision conflicts with BOTH revisions named in the message
//     and leaves the state untouched
//   - scanner roundtrip: websocketUrl write flips derived customUrl,
//     customUrl=false resets to the default url, customUrl=true alone errors
//   - flags (whole-array replace) and session writes roundtrip through the
//     upstream store setters
//
// The sample save carries no settings/session/flags/scanner fields, so every
// section starts from upstream defaults after load_save — assertions can pin
// those defaults exactly.
//
// Usage: node scripts/smoke-state.mjs [serverEntry]

import {
  copyFileSync,
  mkdtempSync,
  rmSync,
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

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-state-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

const DEFAULT_WS_URL = 'ws://127.0.0.1:23313/ws'

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

// get_state nests the section payload under its own name; unwrap it once here
async function getState(client, section) {
  const payload = await callTool(client, 'get_state', { section })
  if (payload.section !== section || payload[section] == null) {
    throw new Error(`get_state(${section}) returned unexpected shape: ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return payload[section]
}

async function callToolExpectError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-state', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
  },
})
await client.connect(transport)

try {
  // ── 1. cold boot, then load; get_state per section ───────────────────────
  let revision = await getState(client, 'revision')
  check(
    'cold boot get_state(revision): 0, not loaded, not dirty, no blocked write',
    revision.revision === 0 && revision.loaded === false && revision.path === null && revision.dirty === false && revision.blockedWrite === null,
    `revision=${JSON.stringify(revision)}`,
  )

  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('sample save loaded', loaded.loaded === true, `${loaded.relics} relics / ${loaded.characters} characters`)

  revision = await getState(client, 'revision')
  check(
    'after load get_state(revision): revision=1, generation=1, loaded, clean',
    revision.revision === 1 && revision.generation === 1 && revision.loaded === true && revision.dirty === false,
    `revision=${revision.revision} generation=${revision.generation}`,
  )

  const settings = await getState(client, 'settings')
  const definitionKeys = Object.keys(settings.definitions)
  check(
    'get_state(settings): six definitions, each with enum values, derived default and Chinese label',
    definitionKeys.length === 6
      && definitionKeys.every((key) => {
        const d = settings.definitions[key]
        return d.type === 'enum' && Array.isArray(d.values) && d.values.length >= 2 && d.values.includes(d.default) && typeof d.label === 'string'
      }),
    `keys=${definitionKeys.join(',')}`,
  )
  check(
    'get_state(settings): default RelicEquippingBehavior=Replace and current value equals default',
    settings.definitions.RelicEquippingBehavior.default === 'Replace' && settings.settings.RelicEquippingBehavior === 'Replace',
    `default=${settings.definitions.RelicEquippingBehavior.default} current=${settings.settings.RelicEquippingBehavior}`,
  )

  const session = await getState(client, 'session')
  check(
    'get_state(session): persisted global + showcaseTab fields, defaults and ephemeral block',
    typeof session.savedSession.global.sidebarCollapsed === 'boolean'
      && session.savedSession.global.scoringType === 0
      && session.savedSession.global.computeEngine === 'GPU Stable'
      && typeof session.savedSession.showcaseTab.sidebarOpen === 'boolean'
      && Object.keys(session.defaults).length === 12
      && typeof session.ephemeral.activeKey === 'string',
    `global keys=${Object.keys(session.savedSession.global).length} defaults keys=${Object.keys(session.defaults).length}`,
  )

  const flags = await getState(client, 'flags')
  check(
    'get_state(flags): seenFeatures is an array of strings (empty for the bare sample save)',
    Array.isArray(flags.seenFeatures) && flags.seenFeatures.every((x) => typeof x === 'string') && flags.seenFeatures.length === 0,
    `count=${flags.seenFeatures.length}`,
  )

  const scanner = await getState(client, 'scanner')
  const scannerKeys = ['ingest', 'ingestCharacters', 'ingestOnlyExistingCharacters', 'ingestWarpResources', 'websocketUrl', 'customUrl']
  check(
    'get_state(scanner): six fields present with upstream defaults',
    scannerKeys.every((key) => key in scanner)
      && scanner.ingest === false
      && scanner.websocketUrl === DEFAULT_WS_URL
      && scanner.customUrl === false,
    `websocketUrl=${scanner.websocketUrl} customUrl=${scanner.customUrl}`,
  )

  // ── 2. settings update with a valid baseRevision ─────────────────────────
  const updated = await callTool(client, 'update_state', {
    section: 'settings',
    patch: { RelicEquippingBehavior: 'Swap' },
    baseRevision: 1,
  })
  check(
    'update_state(settings) with valid baseRevision: updated, revision+1, dirty',
    updated.updated === true && updated.section === 'settings' && updated.revision === 2 && updated.dirty === true,
    `revision=${updated.revision} dirty=${updated.dirty}`,
  )
  check(
    'update_state echoes the changed section',
    updated.settings.settings.RelicEquippingBehavior === 'Swap',
    `RelicEquippingBehavior=${updated.settings.settings.RelicEquippingBehavior}`,
  )

  const settingsAfter = await getState(client, 'settings')
  check(
    'get_state(settings) reflects the change; untouched keys keep defaults',
    settingsAfter.settings.RelicEquippingBehavior === 'Swap' && settingsAfter.settings.NewCharacterDefaultRank === 'First',
    `RelicEquippingBehavior=${settingsAfter.settings.RelicEquippingBehavior} NewCharacterDefaultRank=${settingsAfter.settings.NewCharacterDefaultRank}`,
  )

  // ── value validation: invalid enum rejected with allowed values listed ───
  const badValue = await callToolExpectError(client, 'update_state', {
    section: 'settings',
    patch: { RelicEquippingBehavior: 'Nonsense' },
  })
  check(
    'invalid enum value rejected, message names the field, allowed values and the received value',
    badValue.includes('RelicEquippingBehavior') && badValue.includes('Replace') && badValue.includes('Swap') && badValue.includes('Nonsense'),
    badValue.slice(0, 110),
  )

  // ── 3. stale baseRevision conflicts and leaves state untouched ───────────
  revision = await getState(client, 'revision')
  const revBeforeConflict = revision.revision
  check('rejected updates did not bump the revision', revBeforeConflict === 2, `revision=${revBeforeConflict}`)
  const conflict = await callToolExpectError(client, 'update_state', {
    section: 'settings',
    patch: { RelicEquippingBehavior: 'Replace' },
    baseRevision: revBeforeConflict - 1,
  })
  const conflictMatch = conflict.match(/持有 revision (\d+),当前已是 (\d+)/)
  check(
    'stale baseRevision errors with BOTH revisions in the message',
    conflictMatch != null && Number(conflictMatch[1]) === revBeforeConflict - 1 && Number(conflictMatch[2]) === revBeforeConflict,
    conflict.slice(0, 130),
  )
  const settingsAfterConflict = await getState(client, 'settings')
  revision = await getState(client, 'revision')
  check(
    'conflict left the state untouched (value and revision unchanged)',
    settingsAfterConflict.settings.RelicEquippingBehavior === 'Swap' && revision.revision === revBeforeConflict,
    `RelicEquippingBehavior=${settingsAfterConflict.settings.RelicEquippingBehavior} revision=${revision.revision}`,
  )

  // ── 4. unknown key rejected with legal keys listed ───────────────────────
  const unknownKey = await callToolExpectError(client, 'update_state', {
    section: 'settings',
    patch: { NotASetting: 'x' },
  })
  check(
    'unknown key rejected, message lists the offending key and legal keys',
    unknownKey.includes('NotASetting') && unknownKey.includes('RelicEquippingBehavior') && unknownKey.includes('ShowComboDmgWarning'),
    unknownKey.slice(0, 120),
  )

  // ── 5. scanner roundtrip ──────────────────────────────────────────────────
  const customWsUrl = 'ws://127.0.0.1:34567/custom-ws'
  let scannerUpdated = await callTool(client, 'update_state', {
    section: 'scanner',
    patch: { websocketUrl: customWsUrl },
  })
  let scannerEcho = await getState(client, 'scanner')
  check(
    'scanner websocketUrl roundtrip flips the derived customUrl flag',
    scannerUpdated.updated === true && scannerEcho.websocketUrl === customWsUrl && scannerEcho.customUrl === true,
    `websocketUrl=${scannerEcho.websocketUrl} customUrl=${scannerEcho.customUrl}`,
  )

  scannerUpdated = await callTool(client, 'update_state', {
    section: 'scanner',
    patch: { customUrl: false },
  })
  scannerEcho = await getState(client, 'scanner')
  check(
    'scanner customUrl=false resets the url to the default',
    scannerUpdated.updated === true && scannerEcho.websocketUrl === DEFAULT_WS_URL && scannerEcho.customUrl === false,
    `websocketUrl=${scannerEcho.websocketUrl}`,
  )

  const customUrlAlone = await callToolExpectError(client, 'update_state', {
    section: 'scanner',
    patch: { customUrl: true },
  })
  check(
    'scanner customUrl=true without a custom url is rejected',
    customUrlAlone.includes('customUrl') && customUrlAlone.includes(DEFAULT_WS_URL),
    customUrlAlone.slice(0, 110),
  )

  const contradictoryPatch = await callToolExpectError(client, 'update_state', {
    section: 'scanner',
    patch: { websocketUrl: 'ws://127.0.0.1:99998/ws', customUrl: false },
  })
  check(
    'scanner contradictory patch (custom url + customUrl=false) is rejected, not silently reset',
    contradictoryPatch.includes('矛盾'),
    contradictoryPatch.slice(0, 110),
  )

  // ── optimizerCharacterId validated against the CURRENT save, like the load
  // path's normalization (metadata ∩ save); a metadata-only id not in the
  // loaded save must error instead of persisting a dangling reference ──────
  const characters = await callTool(client, 'list_characters', {})
  const inSaveId = characters.characters[0].id
  const sessionWrite = await callTool(client, 'update_state', {
    section: 'session',
    patch: { optimizerCharacterId: inSaveId },
  })
  check('session optimizerCharacterId accepts an id present in the save', sessionWrite.updated === true)
  const danglingId = await callToolExpectError(client, 'update_state', {
    section: 'session',
    patch: { optimizerCharacterId: '1001' },
  })
  check(
    'session optimizerCharacterId rejects a metadata-only id not in the save',
    danglingId.includes('optimizerCharacterId') && danglingId.includes('当前存档'),
    danglingId.slice(0, 110),
  )

  // ── flags + session writes roundtrip through upstream setters ────────────
  const flagsUpdated = await callTool(client, 'update_state', {
    section: 'flags',
    patch: { seenFeatures: ['leaderboard'] },
  })
  const flagsEcho = await getState(client, 'flags')
  check(
    'flags update replaces the whole seenFeatures array',
    flagsUpdated.updated === true && flagsEcho.seenFeatures.length === 1 && flagsEcho.seenFeatures[0] === 'leaderboard',
    `seenFeatures=${JSON.stringify(flagsEcho.seenFeatures)}`,
  )

  const sessionUpdated = await callTool(client, 'update_state', {
    section: 'session',
    patch: { sidebarCollapsed: true },
  })
  const sessionEcho = await getState(client, 'session')
  check(
    'session write roundtrip (global setter), showcaseTab fields untouched',
    sessionUpdated.updated === true
      && sessionEcho.savedSession.global.sidebarCollapsed === true
      && sessionEcho.savedSession.showcaseTab.sidebarOpen === true,
    `sidebarCollapsed=${sessionEcho.savedSession.global.sidebarCollapsed}`,
  )

  const badSessionValue = await callToolExpectError(client, 'update_state', {
    section: 'session',
    patch: { scorerId: 42 },
  })
  check('session value types validated', badSessionValue.includes('scorerId') && badSessionValue.includes('期望'), badSessionValue.slice(0, 110))

  // ── revision accounting: one bump per committed write, none for errors ───
  // load=1, settings=2, scanner url=3, scanner reset=4, flags=5, session=6
  revision = await getState(client, 'revision')
  check(
    'final revision: exactly one bump per committed write (load + 6 writes = 7)',
    revision.revision === 7,
    `revision=${revision.revision}`,
  )

  console.log(failures === 0 ? 'smoke-state: ALL CHECKS PASSED' : `smoke-state: ${failures} FAILED`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
