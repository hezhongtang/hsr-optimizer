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
//   - showcase color/colorMode writes mirror editShowcasePreferences: color
//     pairs with colorMode=CUSTOM, colorMode links the global
//     showcaseStandardMode flag, mixed patches shallow-merge, and the
//     hex/enum/no-payload/default-color guards reject with named expectations
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

  // ── layout section (optimizer.layout.sections): persisted menuState ──────
  const layoutBefore = await getState(client, 'layout')
  check(
    'get_state(layout): menuState + upstream defaults (statSim collapsed, rest open)',
    layoutBefore.menuState['Character custom stats simulation'] === false
      && layoutBefore.defaults['Character options'] === true
      && Object.keys(layoutBefore.defaults).length === 5,
    JSON.stringify(layoutBefore.menuState),
  )
  const layoutUpdated = await callTool(client, 'update_state', {
    section: 'layout',
    patch: { menuState: { 'Teammates': false, 'Character options': true } },
  })
  check(
    'update_state(layout): partial fold merges over current, echo returns full map',
    layoutUpdated.updated === true && layoutUpdated.layout.menuState.Teammates === false,
    JSON.stringify(layoutUpdated.layout?.menuState),
  )
  const layoutAfter = await getState(client, 'layout')
  check(
    'get_state(layout) after write: Teammates folded, untouched keys preserved',
    layoutAfter.menuState.Teammates === false && layoutAfter.menuState['Relic & stat filters'] === true,
    JSON.stringify(layoutAfter.menuState),
  )
  const badLayoutKey = await callToolExpectError(client, 'update_state', {
    section: 'layout',
    patch: { menuState: { 'No such section': true } },
  })
  check(
    'update_state(layout): unknown section ids rejected in Chinese',
    badLayoutKey.includes('Character options') && badLayoutKey.includes('值无效'),
    badLayoutKey.slice(0, 110),
  )

  // ── showcase color/colorMode writes (preview.customize.color) ────────────
  // 逐字镜像 editShowcasePreferences:网页取色器落色总是成对传 { color,
  // colorMode: CUSTOM }(onColorChangeEnd),colorMode 非 null 时联动全局
  // showcaseStandardMode(= 是否 STANDARD)。示例存档不带 showcasePreferences,
  // 首写后该角色的偏好应恰好是 { color, colorMode } 两键。
  const colorEcho = await callTool(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: inSaveId, color: '#ff8800' },
  })
  check(
    'showcase color-only write links colorMode=CUSTOM (web picker pairing), preference is exactly { color, colorMode }',
    colorEcho.updated === true
      && colorEcho.showcase.preferences[inSaveId]?.color === '#ff8800'
      && colorEcho.showcase.preferences[inSaveId]?.colorMode === 'CUSTOM'
      && Object.keys(colorEcho.showcase.preferences[inSaveId]).length === 2,
    JSON.stringify(colorEcho.showcase.preferences[inSaveId]),
  )
  let sessionAfterColor = await getState(client, 'session')
  check(
    'showcase color write (implicit CUSTOM) flips global showcaseStandardMode to false',
    sessionAfterColor.savedSession.global.showcaseStandardMode === false,
    `showcaseStandardMode=${sessionAfterColor.savedSession.global.showcaseStandardMode}`,
  )

  const standardEcho = await callTool(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: inSaveId, colorMode: 'STANDARD' },
  })
  sessionAfterColor = await getState(client, 'session')
  check(
    'showcase colorMode=STANDARD flips global showcaseStandardMode to true (web linkage)',
    standardEcho.updated === true && sessionAfterColor.savedSession.global.showcaseStandardMode === true,
    `showcaseStandardMode=${sessionAfterColor.savedSession.global.showcaseStandardMode}`,
  )

  const mixedEcho = await callTool(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: inSaveId, colorMode: 'AUTO', scoringType: 1 },
  })
  check(
    'showcase mixed write (colorMode + scoringType) shallow-merges, stored color preserved',
    mixedEcho.showcase.preferences[inSaveId]?.color === '#ff8800'
      && mixedEcho.showcase.preferences[inSaveId]?.colorMode === 'AUTO'
      && mixedEcho.showcase.preferences[inSaveId]?.scoringType === 1,
    JSON.stringify(mixedEcho.showcase.preferences[inSaveId]),
  )
  const showcaseRead = await getState(client, 'showcase')
  check(
    'get_state(showcase) returns the full preference records (color + colorMode + scoringType)',
    showcaseRead.preferences[inSaveId]?.color === '#ff8800' && showcaseRead.count === 1,
    `count=${showcaseRead.count}`,
  )

  const badColor = await callToolExpectError(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: inSaveId, color: 'orange' },
  })
  check(
    'showcase color rejects non-hex strings, expected format named in the message',
    badColor.includes('hex') && badColor.includes('color'),
    badColor.slice(0, 110),
  )
  const badMode = await callToolExpectError(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: inSaveId, colorMode: 'BLUE' },
  })
  check(
    'showcase colorMode rejects values outside the enum (AUTO/CUSTOM/STANDARD listed)',
    badMode.includes('AUTO') && badMode.includes('CUSTOM') && badMode.includes('STANDARD'),
    badMode.slice(0, 110),
  )
  const idOnly = await callToolExpectError(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: inSaveId },
  })
  check(
    'showcase patch with characterId only is rejected (a writable field is required)',
    idOnly.includes('scoringType') && idOnly.includes('colorMode'),
    idOnly.slice(0, 110),
  )
  const defaultColor = await callToolExpectError(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: inSaveId, color: '#2473e1' },
  })
  check(
    'showcase color equal to the upstream default #2473e1 is a picker no-op on the web — MCP names it instead',
    defaultColor.includes('#2473e1') && defaultColor.includes('AUTO'),
    defaultColor.slice(0, 110),
  )

  // ── revision accounting: one bump per committed write, none for errors ───
  // load=1, settings=2, scanner url=3, scanner reset=4, session optimizer=5,
  // flags=6, session sidebar=7, layout=8, showcase color=9, STANDARD=10, mixed=11
  revision = await getState(client, 'revision')
  check(
    'final revision: exactly one bump per committed write (load + 10 writes = 11)',
    revision.revision === 11,
    `revision=${revision.revision}`,
  )

  console.log(failures === 0 ? 'smoke-state: ALL CHECKS PASSED' : `smoke-state: ${failures} FAILED`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
