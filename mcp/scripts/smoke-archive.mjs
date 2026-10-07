// Offline end-to-end regressions for transactional save replacement. All save
// files and the localStorage backend are isolated in a temporary directory.
// Usage: node scripts/smoke-archive.mjs [serverEntry]

import {
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
import { isDeepStrictEqual } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const sample = JSON.parse(readFileSync(resolve(mcpDir, '../src/data/sample-save.json'), 'utf8'))
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-archive-`)
const statePath = `${tempDir}/localstorage.json`
const characterId = '1212b1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}

async function expectLoadFailure(json) {
  try {
    const result = await client.callTool({ name: 'load_save', arguments: { json } })
    check('malformed save fails the migration chain', result.isError === true, result.content?.[0]?.text)
  } catch (e) {
    check('malformed save fails the migration chain', /存档载入失败/.test(String(e)))
  }
}

async function exportedState(label) {
  const path = `${tempDir}/${label}.json`
  await callTool('export_save', { path })
  return JSON.parse(readFileSync(path, 'utf8'))
}

function localStorageState() {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).state : undefined
}

const optionalFields = [
  'scoringMetadataOverrides',
  'showcasePreferences',
  'optimizerMenuState',
  'excludedRelicPotentialCharacters',
  'savedSession',
  'settings',
  'warpRequest',
  'relicLocator',
  'ahaSpeedTuner',
  'scannerSettings',
  'completedMigrations',
  'seenFeatures',
]
const malformed = {
  relics: [],
  characters: [{ id: characterId }], // Missing form: throws after markers were applied.
  completedMigrations: { failedLoad: 1 },
  seenFeatures: ['failed-load'],
  scoringMetadataOverrides: { [characterId]: { stats: { ATK: 0.37 } } },
}

const client = new Client({ name: 'smoke-archive', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: statePath },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  await expectLoadFailure(malformed)
  const unloaded = await callTool('save_status')
  check('failed first load leaves the server unloaded and clean', !unloaded.loaded && !unloaded.dirty && unloaded.path === null)
  check('failed first load does not write localStorage', !existsSync(statePath))

  await callTool('load_save', { json: { relics: [], characters: [] } })
  const defaults = await exportedState('defaults')
  check('failed first load markers are absent from the next save', !defaults.completedMigrations.failedLoad && defaults.seenFeatures.length === 0)

  const richSave = {
    ...structuredClone(sample),
    savedSession: {
      global: {
        ...defaults.savedSession.global,
        optimizerCharacterId: characterId,
        sidebarCollapsed: true,
        teamShowcaseSavedTeams: [{ id: 'team-a', name: 'Team A', characterIds: [characterId, null, null, null] }],
      },
      showcaseTab: { scorerId: '123456789', sidebarOpen: false },
    },
    settings: { ...defaults.settings, RelicEquippingBehavior: 'Swap', NewCharacterDefaultRank: 'Last' },
    scoringMetadataOverrides: { [characterId]: { stats: { ATK: 0.37 } } },
    showcasePreferences: { [characterId]: { archiveFixture: true } },
    optimizerMenuState: { ...defaults.optimizerMenuState, 'Character options': false },
    excludedRelicPotentialCharacters: [characterId],
    warpRequest: { ...defaults.warpRequest, passes: 123, jades: 456 },
    relicLocator: { inventoryWidth: 4, rowLimit: 5 },
    ahaSpeedTuner: { teammate0: 201, teammate1: 202, teammate2: 203, teammate3: 204, desiredAha: 205 },
    scannerSettings: {
      ingest: true,
      ingestCharacters: true,
      ingestOnlyExistingCharacters: true,
      ingestWarpResources: true,
      websocketUrl: 'ws://127.0.0.1:54321',
      customUrl: true,
    },
    completedMigrations: { ...sample.completedMigrations, archiveFixture: 17 },
    seenFeatures: ['archive-fixture'],
  }
  const richPath = `${tempDir}/rich-save.json`
  writeFileSync(richPath, JSON.stringify(richSave))
  await callTool('load_save', { path: richPath })
  const richBaseline = await exportedState('rich-baseline')
  // Manual-load security semantics: the rich fixture carries customUrl=true with
  // ws://127.0.0.1:54321 — load_save must NOT re-point the scanner connection
  // (persistenceService.ts:207 restores the url only on autosave loads).
  {
    const scannerState = await callTool('get_state', { section: 'scanner' })
    check(
      'manual load does not apply the save\'s custom scanner url',
      scannerState.scanner.websocketUrl === 'ws://127.0.0.1:23313/ws',
      `websocketUrl=${scannerState.scanner.websocketUrl}`,
    )
  }
  await sleep(400) // Let the intended load/export localStorage update settle.
  const referenceBeforeFailure = localStorageState()
  const fileBeforeMutation = readFileSync(richPath, 'utf8')

  await callTool('upsert_character', { characterId, characterEidolon: 6, characterLevel: 60, lightConeLevel: 40 })
  const dirtyTeam = await callTool('save_team', { name: 'Pending team', characterIds: [characterId] })
  await expectLoadFailure(malformed)

  const rollbackStatus = await callTool('save_status')
  const rollbackCharacter = await callTool('get_character', { characterId })
  const rollbackTeams = await callTool('list_teams')
  check('failed load preserves path and dirty ownership', rollbackStatus.path === richPath && rollbackStatus.dirty)
  check(
    'failed load preserves current character edits without re-running migrations',
    rollbackCharacter.savedForm.characterEidolon === 6
      && rollbackCharacter.savedForm.characterLevel === 60
      && rollbackCharacter.savedForm.lightConeLevel === 40,
  )
  check('failed load preserves an unflushed saved team', rollbackTeams.teams.some((team) => team.id === dirtyTeam.teamId))
  check('snapshot and rollback do not write the loaded save file', readFileSync(richPath, 'utf8') === fileBeforeMutation)
  await sleep(400) // Still inside the 1-second runtime flush window.
  check('snapshot and rollback do not update localStorage', localStorageState() === referenceBeforeFailure)

  const rolledBack = await exportedState('rolled-back')
  for (const key of optionalFields.filter((key) => key !== 'savedSession')) {
    check(`failed load restores ${key}`, isDeepStrictEqual(rolledBack[key], richBaseline[key]))
  }
  check(
    'failed load restores the remaining session settings',
    rolledBack.savedSession.global.sidebarCollapsed
      && rolledBack.savedSession.showcaseTab.scorerId === richBaseline.savedSession.showcaseTab.scorerId,
  )

  await sleep(1_200)
  const persisted = JSON.parse(readFileSync(richPath, 'utf8'))
  check(
    'original pending flush persists restored edits',
    persisted.characters.find((c) => c.id === characterId)?.form.characterEidolon === 6
      && persisted.savedSession.global.teamShowcaseSavedTeams.some((team) => team.id === dirtyTeam.teamId),
  )
  check('successful restored flush clears dirty', !(await callTool('save_status')).dirty)

  // Missing optional fields must reset to account-independent defaults. A file
  // load also must not normalize or rewrite the new source file on its own.
  const minimalPath = `${tempDir}/minimal.json`
  const minimalText = JSON.stringify({ relics: [], characters: [], untouchedTopLevel: 'preserve on load' })
  writeFileSync(minimalPath, minimalText)
  await callTool('load_save', { path: minimalPath })
  check('minimal new save clears old saved teams', (await callTool('list_teams')).total === 0)
  const minimal = await exportedState('minimal-export')
  for (const key of optionalFields) {
    check(`minimal new save resets ${key}`, isDeepStrictEqual(minimal[key], defaults[key]))
  }
  check('loading the new file does not rewrite its source', readFileSync(minimalPath, 'utf8') === minimalText)
  check('new empty-save export is allowed by the synced anti-wipe reference', minimal.relics.length === 0 && minimal.characters.length === 0)

  // Partial nested records use defaults for omitted fields, independently of
  // whatever was in the prior account, while preserving provided values.
  await callTool('load_save', { json: richSave })
  await callTool('load_save', {
    json: {
      relics: [],
      characters: [],
      savedSession: { showcaseTab: { sidebarOpen: false } },
      settings: { RelicEquippingBehavior: 'Swap' },
      optimizerMenuState: { 'Character options': false },
      ahaSpeedTuner: { desiredAha: 170 },
      scannerSettings: { ingest: true, ingestOnlyExistingCharacters: true, customUrl: false },
    },
  })
  const partial = await exportedState('partial-export')
  check('partial session resets missing global session', isDeepStrictEqual(partial.savedSession.global, defaults.savedSession.global))
  check(
    'partial showcase session resets missing scorerId',
    partial.savedSession.showcaseTab.scorerId === defaults.savedSession.showcaseTab.scorerId
      && partial.savedSession.showcaseTab.sidebarOpen === false,
  )
  check(
    'partial settings preserve explicit values and default missing fields',
    isDeepStrictEqual(partial.settings, { ...defaults.settings, RelicEquippingBehavior: 'Swap' }),
  )
  check(
    'partial menu preserves explicit values and defaults missing fields',
    isDeepStrictEqual(partial.optimizerMenuState, { ...defaults.optimizerMenuState, 'Character options': false }),
  )
  check(
    'partial Aha settings preserve explicit values and default missing fields',
    isDeepStrictEqual(partial.ahaSpeedTuner, { ...defaults.ahaSpeedTuner, desiredAha: 170 }),
  )
  check(
    'partial scanner settings preserve values and reset the old custom URL',
    isDeepStrictEqual(partial.scannerSettings, { ...defaults.scannerSettings, ingest: true, ingestOnlyExistingCharacters: true }),
  )

  // loadSaveData's scanner setters used to schedule an unintended 5-second
  // SaveState.save even with autosave=false. The only state write on a load is
  // the immediate anti-wipe reference sync, retaining the input's unknown key.
  await callTool('load_save', { json: { ...richSave, untouchedTopLevel: 'no delayed save' } })
  await sleep(400)
  const referenceAfterLoad = localStorageState()
  await sleep(5_200)
  check('scanner configuration load does not schedule a delayed save', localStorageState() === referenceAfterLoad)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-archive: ALL CHECKS PASSED' : `\nsmoke-archive: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
