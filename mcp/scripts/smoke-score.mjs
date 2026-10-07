// End-to-end smoke test for the scoring domain (M6-B): score_character +
// set_scoring_override(configs/resetAll/linkFlatAndPercent) + score_relics
// (scope/rollsSummary) + list_relics(sortBy score columns) +
// fetch_showcase(json/remember) + game://metadata/scoring.
//
// Spawns the built server over stdio and walks:
//   load_save (temp copy)
//   → roster scoring under all four configs (DPS Jingliu / BUFFER Bronya /
//     HEAL Natasha after equipping / SHIELD Gepard after upsert+equip), each
//     gated on get_scoring_metadata's available simulations
//   → ephemeral custom team (teammates=) leaves the save untouched
//     (override identical + revision unchanged — scoring is read-only)
//   → spdBenchmark changes the benchmark speed (and the score)
//   → trace=true returns the per-action buff summary (sources + tags)
//   → source=build scores a saved build (same relics/team ⇒ same percent as
//     the roster run), build's own lightCone/eidolon form snapshot
//   → source=showcase over an INLINE json fixture (zero network): direct
//     score, simulate-override to another character+light cone, and cache
//     selection by cacheId after a second remembered fetch
//   → set_scoring_override: configs editTeammate/syncTeam/deprioritizeBuffs
//     roundtrip (+ the dps-only rejection), resetConfig, linkFlatAndPercent
//     pair propagation (+ conflict rejection), resetAll
//   → score_relics scope=all|custom + rollsSummary; list_relics
//     sortBy=currentScore|potentialBest with scoreBy (+ rejections)
//   → game://metadata/scoring readable with all six sections
//
// Everything persists into a temp directory (save copy + HSR_MCP_STATE_FILE);
// the repo's sample-save.json is never a write target. Zero real network —
// the showcase path uses fetch_showcase's inline json cache.
//
// Usage: node scripts/smoke-score.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  existsSync,
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

const TARGET = '1212b1' // Jingliu — DPS sim, 6 equipped relics
const BUFFER_CHAR = '1101' // Bronya — supportSimulation, 4 equipped relics
const HEALER = '1105' // Natasha — healSimulation, 0 relics in the sample save
const SHIELD_CHAR = '1104' // Gepard — shieldSimulation, not in the sample save
const BRONYA_LC = '23003' // But the Battle Isn't Over (Bronya's signature)
const SEELE = '1102' // showcase override target
const SEELE_LC = '24001' // Seele's light cone in the sample save
const NATASHA_LC = '21007' // Natasha's light cone in the sample save
const PARTS = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope']

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-score-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

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

async function expectToolError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

async function readJsonResource(client, uri) {
  const result = await client.readResource({ uri })
  const contents = result.contents ?? []
  if (contents.length !== 1 || contents[0].mimeType !== 'application/json') {
    throw new Error(`resource ${uri}: expected 1 application/json content, got ${contents.length}`)
  }
  return JSON.parse(contents[0].text)
}

const LONG = { timeout: 180_000 }

function finiteScore(payload) {
  return typeof payload.percent === 'number' && Number.isFinite(payload.percent)
    && typeof payload.grade === 'string' && payload.grade.length > 0
    && typeof payload.scores.original === 'number' && Number.isFinite(payload.scores.original)
}

// mihomo inline showcase fixture: avatar 1107 (Clara) + 6 relics + LC 20000
// (same shape as smoke-imports.mjs's zero-network fixture)
const showcaseClaraJson = {
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

// second remembered fixture: 1-relic Natasha — used to prove cache selection
// by cacheId still reaches the OLDER (Clara) archive after a newer fetch
const showcaseNatashaJson = {
  source: 'mihomo',
  detailInfo: {
    avatarDetailList: [{
      avatarId: 1105,
      level: 70,
      rank: 0,
      equipment: { tid: '21007', level: 70, rank: 1 },
      relicList: [
        { tid: '61151', level: 12, main_affix: { type: 'HPDelta' }, subAffixList: [{ type: 'HPAddedRatio', cnt: 2, step: 1 }] },
      ],
    }],
  },
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-score', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  // ── 1. tool surface ────────────────────────────────────────────────────────
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  check('tool score_character registered', toolNames.includes('score_character'))

  // ── 2. load sample save (temp copy — write-backs target it) ───────────────
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save characters = 8', loaded.characters === 8, `got ${loaded.characters}`)

  // ── 3. roster scoring under all four configs ──────────────────────────────
  // DPS: Jingliu as-is
  const jingliuMeta = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check('Jingliu has a dps simulation config', jingliuMeta.simulations?.dps != null, JSON.stringify(Object.keys(jingliuMeta.simulations ?? {})))
  const revisionBefore = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  const dpsRun = await callTool(client, 'score_character', { source: 'roster', characterId: TARGET }, LONG)
  check(
    'roster auto-config picks dps and returns a finite score + grade',
    dpsRun.configType === 'dps' && dpsRun.source === 'roster' && finiteScore(dpsRun),
    `config=${dpsRun.configType} percent=${dpsRun.percent?.toFixed(3)} grade=${dpsRun.grade}`,
  )
  check(
    'dps run carries the four build details (original/baseline/benchmark/maximum)',
    ['original', 'baseline', 'benchmark', 'maximum'].every((k) =>
      dpsRun.builds?.[k] != null && dpsRun.builds[k].stats != null && typeof dpsRun.builds[k].simScore === 'number'
    ),
    `scores ${JSON.stringify(dpsRun.scores)}`,
  )
  check(
    'dps run exposes upgrade tables (DPS-only surface)',
    Array.isArray(dpsRun.upgrades.substats) && Array.isArray(dpsRun.upgrades.sets) && Array.isArray(dpsRun.upgrades.mains),
    `substats=${dpsRun.upgrades.substats.length} sets=${dpsRun.upgrades.sets.length}`,
  )
  const revisionAfterDps = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  check('scoring is read-only (revision unchanged)', revisionAfterDps === revisionBefore, `${revisionBefore} → ${revisionAfterDps}`)

  // BUFFER: Bronya as-is (4 relics ≥ 1)
  const bronyaMeta = await callTool(client, 'get_scoring_metadata', { characterId: BUFFER_CHAR })
  check('Bronya has a buffer simulation config', bronyaMeta.simulations?.support != null, JSON.stringify(Object.keys(bronyaMeta.simulations ?? {})))
  const bufferRun = await callTool(client, 'score_character', { source: 'roster', characterId: BUFFER_CHAR, config: 'buffer' }, LONG)
  check(
    'buffer config scores Bronya (finite score + grade, no upgrade tables)',
    bufferRun.configType === 'buffer' && finiteScore(bufferRun) && bufferRun.upgrades.substats.length === 0,
    `percent=${bufferRun.percent?.toFixed(3)} grade=${bufferRun.grade}`,
  )

  // HEAL: Natasha has 0 relics in the sample save — equip six unequipped ones first
  const natashaMeta = await callTool(client, 'get_scoring_metadata', { characterId: HEALER })
  check('Natasha has a heal simulation config', natashaMeta.simulations?.heal != null, JSON.stringify(Object.keys(natashaMeta.simulations ?? {})))
  const relicIdsForNatasha = []
  for (const part of PARTS) {
    const found = await callTool(client, 'list_relics', { equippedBy: 'none', part, limit: 1 })
    relicIdsForNatasha.push(found.relics[0].id)
  }
  await callTool(client, 'equip_build', { characterId: HEALER, relicIds: relicIdsForNatasha })
  const healRun = await callTool(client, 'score_character', { source: 'roster', characterId: HEALER, config: 'heal' }, LONG)
  check(
    'heal config scores Natasha after equipping (finite score + grade)',
    healRun.configType === 'heal' && finiteScore(healRun) && healRun.relics.equipped === 6,
    `percent=${healRun.percent?.toFixed(3)} grade=${healRun.grade}`,
  )

  // SHIELD: Gepard is not in the sample save — upsert + equip
  const gepardMeta = await callTool(client, 'get_scoring_metadata', { characterId: SHIELD_CHAR })
  check('Gepard has a shield simulation config', gepardMeta.simulations?.shield != null, JSON.stringify(Object.keys(gepardMeta.simulations ?? {})))
  await callTool(client, 'upsert_character', { characterId: SHIELD_CHAR, lightCone: NATASHA_LC })
  await callTool(client, 'equip_build', { characterId: SHIELD_CHAR, relicIds: relicIdsForNatasha })
  const shieldRun = await callTool(client, 'score_character', { source: 'roster', characterId: SHIELD_CHAR, config: 'shield' }, LONG)
  check(
    'shield config scores Gepard after upsert+equip (finite score + grade)',
    shieldRun.configType === 'shield' && finiteScore(shieldRun),
    `percent=${shieldRun.percent?.toFixed(3)} grade=${shieldRun.grade}`,
  )

  // unavailable config → actionable Chinese error listing what IS available
  const noHealErr = await expectToolError(client, 'score_character', { source: 'roster', characterId: TARGET, config: 'heal' })
  check(
    'heal config on a DPS-only character is rejected (Chinese, lists available)',
    noHealErr.includes('没有') && noHealErr.includes('dps'),
    noHealErr.slice(0, 90),
  )

  // ── 3b. dps_score: baseline + team benchmark snapshot override ────────────
  // teams.cards.read (M9): the Teams showcase page's synced-benchmark cards
  // score each member against the saved team's benchmarkSnapshot — slot 0 as
  // main DPS (deprioritizeBuffs=false), the rest as sub DPS (true). Same
  // upstream gate: resolveTeamBenchmarkOverrides only engages when all four
  // slots match the snapshot members.
  const dpsToolRun = await callTool(client, 'dps_score', { characterId: TARGET }, LONG)
  check(
    'dps_score default run: finite score + team echo, no snapshot block',
    dpsToolRun.team === 'default' && finiteScore(dpsToolRun) && dpsToolRun.snapshot === undefined,
    `percent=${dpsToolRun.percent?.toFixed(4)} grade=${dpsToolRun.grade}`,
  )
  // Second DPS-sim character: the sample save's only simulation character is
  // Jingliu — upsert Himeko 1003 (has `simulation`) and equip six unequipped
  // relics so dps_score's build gate passes for her too.
  const SECOND_DPS = '1003' // Himeko — simulation() in her scoring config
  const KAFKA_LC = '21022' // light cone carried by roster Kafka (form value only)
  await callTool(client, 'upsert_character', { characterId: SECOND_DPS, lightCone: KAFKA_LC })
  const relicIdsForSecondDps = []
  for (const part of PARTS) {
    const found = await callTool(client, 'list_relics', { equippedBy: 'none', part, limit: 1 })
    relicIdsForSecondDps.push(found.relics[0].id)
  }
  await callTool(client, 'equip_build', { characterId: SECOND_DPS, relicIds: relicIdsForSecondDps })
  const snapshotTeam = await callTool(client, 'save_team', {
    name: 'smoke-dps-snapshot',
    characterIds: [TARGET, SECOND_DPS, BUFFER_CHAR, HEALER],
    benchmarkSnapshot: true,
  })
  check(
    'save_team captured a 4-member benchmark snapshot for the scoring team',
    snapshotTeam.benchmarkSnapshotAttached === true && snapshotTeam.snapshot?.members?.length === 4,
    JSON.stringify(snapshotTeam.snapshot?.members?.map((m) => m.characterId)),
  )
  const mainRun = await callTool(client, 'dps_score', { characterId: TARGET, team: 'snapshot', snapshotTeamId: snapshotTeam.teamId }, LONG)
  check(
    'team=snapshot scores the slot-0 member as mainDps with snapshot teammates',
    mainRun.team === 'snapshot' && mainRun.snapshot?.teamId === snapshotTeam.teamId
      && mainRun.snapshot?.slotIndex === 0 && mainRun.snapshot?.role === 'mainDps'
      && mainRun.snapshot?.deprioritizeBuffs === false
      && JSON.stringify(mainRun.snapshot?.teammates) === JSON.stringify([SECOND_DPS, BUFFER_CHAR, HEALER])
      && finiteScore(mainRun),
    `snapshot=${JSON.stringify(mainRun.snapshot)}`,
  )
  check(
    'snapshot team changes the score vs the default team',
    Math.abs(mainRun.percent - dpsToolRun.percent) > 1e-9,
    `default ${dpsToolRun.percent.toFixed(4)} vs snapshot ${mainRun.percent.toFixed(4)}`,
  )
  const subRun = await callTool(client, 'dps_score', { characterId: SECOND_DPS, team: 'snapshot', snapshotTeamId: snapshotTeam.teamId }, LONG)
  check(
    'slot-1 member scores as subDps (deprioritizeBuffs=true, teammates exclude self)',
    subRun.snapshot?.slotIndex === 1 && subRun.snapshot?.role === 'subDps'
      && subRun.snapshot?.deprioritizeBuffs === true
      && JSON.stringify(subRun.snapshot?.teammates) === JSON.stringify([TARGET, BUFFER_CHAR, HEALER])
      && finiteScore(subRun),
    `snapshot=${JSON.stringify(subRun.snapshot)}`,
  )
  // Same character, promoted to slot 0 of a second team → flips to mainDps
  const snapshotTeam2 = await callTool(client, 'save_team', {
    name: 'smoke-dps-snapshot-2',
    characterIds: [SECOND_DPS, TARGET, BUFFER_CHAR, HEALER],
    benchmarkSnapshot: true,
  })
  const himekoMainRun = await callTool(client, 'dps_score', { characterId: SECOND_DPS, team: 'snapshot', snapshotTeamId: snapshotTeam2.teamId }, LONG)
  check(
    'same character in slot 0 flips to mainDps and the buff priority drives the score',
    himekoMainRun.snapshot?.role === 'mainDps' && himekoMainRun.snapshot?.deprioritizeBuffs === false
      && Math.abs(himekoMainRun.percent - subRun.percent) > 1e-9,
    `sub ${subRun.percent.toFixed(4)} vs main ${himekoMainRun.percent.toFixed(4)}`,
  )
  const noSnapshotTeam = await callTool(client, 'save_team', { name: 'smoke-dps-nosnap', characterIds: [TARGET, BUFFER_CHAR, HEALER, SEELE] })
  check(
    'no-snapshot team saved without benchmarkSnapshot',
    noSnapshotTeam.benchmarkSnapshotAttached === false && noSnapshotTeam.created === true,
    noSnapshotTeam.teamId,
  )
  const missingSnapshotErr = await expectToolError(client, 'dps_score', { characterId: TARGET, team: 'snapshot', snapshotTeamId: noSnapshotTeam.teamId })
  check('snapshot scoring on a team without a snapshot rejected (Chinese)', missingSnapshotErr.includes('基准快照'), missingSnapshotErr.slice(0, 90))
  const missingSnapshotTeamIdErr = await expectToolError(client, 'dps_score', { characterId: TARGET, team: 'snapshot' })
  check('team=snapshot without snapshotTeamId rejected (Chinese)', missingSnapshotTeamIdErr.includes('snapshotTeamId'), missingSnapshotTeamIdErr.slice(0, 90))
  const notMemberErr = await expectToolError(client, 'dps_score', { characterId: SEELE, team: 'snapshot', snapshotTeamId: snapshotTeam.teamId })
  check('character outside the snapshot team rejected (Chinese)', notMemberErr.includes('不在队伍'), notMemberErr.slice(0, 90))
  const unknownTeamErr = await expectToolError(client, 'dps_score', { characterId: TARGET, team: 'snapshot', snapshotTeamId: 'no-such-team' })
  check('unknown snapshotTeamId rejected (Chinese)', unknownTeamErr.includes('不存在'), unknownTeamErr.slice(0, 90))

  // ── 4. ephemeral custom team: no save mutation ─────────────────────────────
  const metaBeforeTeam = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  const revisionBeforeTeam = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  const ephemeralRun = await callTool(client, 'score_character', {
    source: 'roster',
    characterId: TARGET,
    teammates: [
      { characterId: BUFFER_CHAR, lightCone: BRONYA_LC },
      { characterId: HEALER, lightCone: NATASHA_LC },
      { characterId: SEELE, lightCone: SEELE_LC },
    ],
  }, LONG)
  const metaAfterTeam = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  const revisionAfterTeam = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  check(
    'ephemeral team scores with the given teammates and never touches the save',
    ephemeralRun.teamResolution === 'ephemeral'
      && JSON.stringify(ephemeralRun.teammates) === JSON.stringify([BUFFER_CHAR, HEALER, SEELE])
      && JSON.stringify(metaAfterTeam.override) === JSON.stringify(metaBeforeTeam.override)
      && revisionAfterTeam === revisionBeforeTeam,
    `team=${JSON.stringify(ephemeralRun.teammates)} override unchanged=${JSON.stringify(metaAfterTeam.override) === JSON.stringify(metaBeforeTeam.override)}`,
  )
  check(
    'ephemeral team changes the score vs the default team',
    Math.abs(ephemeralRun.percent - dpsRun.percent) > 1e-9,
    `default ${dpsRun.percent.toFixed(4)} vs ephemeral ${ephemeralRun.percent.toFixed(4)}`,
  )
  const badTeammateErr = await expectToolError(client, 'score_character', {
    source: 'roster',
    characterId: TARGET,
    teammates: [{ characterId: 'not-a-character', lightCone: BRONYA_LC }],
  })
  check('ephemeral teammate with unknown character rejected (Chinese)', badTeammateErr.includes('不存在'), badTeammateErr.slice(0, 90))

  // ── 5. spdBenchmark: temporary benchmark speed ─────────────────────────────
  // Upstream clamps the benchmark speed to min(input, current SPD) — a value
  // ABOVE the character's own speed is a no-op (benchmarkBasicSpdTarget uses
  // Math.min, benchmarkSimulationOrchestrator.ts applyBasicSpeedTargetFlag).
  // 100 sits well below Jingliu's speed, drops the benchmark build's turns and
  // must move the percent.
  const spdRun = await callTool(client, 'score_character', { source: 'roster', characterId: TARGET, spdBenchmark: 100 }, LONG)
  check(
    'spdBenchmark engages a non-null benchmark speed and a finite score',
    spdRun.spdBenchmark != null && finiteScore(spdRun),
    `benchmarkSpd=${spdRun.spdBenchmark} (default run: ${dpsRun.benchmarkSpd})`,
  )
  check(
    'spdBenchmark changes the scoring outcome',
    Math.abs(spdRun.percent - dpsRun.percent) > 1e-9,
    `default ${dpsRun.percent.toFixed(4)} vs spd ${spdRun.percent.toFixed(4)}`,
  )

  // ── 6. trace=true: per-action buff summary ────────────────────────────────
  const traceRun = await callTool(client, 'score_character', { source: 'roster', characterId: TARGET, trace: true }, LONG)
  const buffActions = Object.keys(traceRun.buffs?.byAction ?? {})
  const firstActionBuffs = buffActions.length ? traceRun.buffs.byAction[buffActions[0]].buffs : []
  check(
    'trace=true returns the per-action buff summary with source attribution',
    buffActions.length > 0 && firstActionBuffs.length > 0
      && firstActionBuffs.every((buff) => buff.source && typeof buff.source.buffType === 'string' && typeof buff.value === 'number'),
    `${buffActions.length} actions, first action ${buffActions[0]} has ${firstActionBuffs.length} buffs`,
  )
  check('trace rotation steps are present', Array.isArray(traceRun.buffs.rotationSteps), `${traceRun.buffs.rotationSteps?.length ?? 0} steps`)

  // ── 7. source=build: saved build preview ──────────────────────────────────
  const savedBuild = await callTool(client, 'save_build', { characterId: TARGET, name: 'smoke-score-build' })
  check('save_build captured a dps scoringConfigType + 3 teammates', savedBuild.saved.scoringConfigType === 'dps' && savedBuild.saved.team.length === 3)
  const buildRun = await callTool(client, 'score_character', { source: 'build', characterId: TARGET, buildName: 'smoke-score-build' }, LONG)
  check(
    'source=build scores the saved build (build team + build scoring type)',
    buildRun.source === 'build' && buildRun.teamResolution === 'build' && buildRun.configType === 'dps' && finiteScore(buildRun),
    `percent=${buildRun.percent?.toFixed(4)}`,
  )
  check(
    'same relics + same default team ⇒ build score equals the roster score',
    Math.abs(buildRun.percent - dpsRun.percent) < 1e-6,
    `roster ${dpsRun.percent.toFixed(6)} vs build ${buildRun.percent.toFixed(6)}`,
  )
  const missingBuildErr = await expectToolError(client, 'score_character', { source: 'build', characterId: TARGET, buildName: 'no-such-build' })
  check('unknown buildName rejected (Chinese, lists saved)', missingBuildErr.includes('没有配装'), missingBuildErr.slice(0, 90))

  // ── 8. source=showcase: inline fixture, zero network ──────────────────────
  const claraFetch = await callTool(client, 'fetch_showcase', { json: showcaseClaraJson, remember: true })
  check(
    'fetch_showcase(json) fills the cache offline with a selection key',
    claraFetch.status === 'ok' && claraFetch.dataOrigin === 'inline' && claraFetch.characterCount === 1 && Array.isArray(claraFetch.cached)
      && claraFetch.cached.length === 1,
    `cacheId=${claraFetch.cacheId}`,
  )
  const natashaFetch = await callTool(client, 'fetch_showcase', { json: showcaseNatashaJson, remember: true })
  check('second remembered fetch keeps both caches selectable', natashaFetch.cached.length === 2, `${natashaFetch.cached.length} cached`)
  const showcaseRun = await callTool(client, 'score_character', { source: 'showcase', characterId: '1107', cacheId: claraFetch.cacheId }, LONG)
  check(
    'source=showcase scores the unimported Clara from the selected (older) cache',
    showcaseRun.source === 'showcase' && showcaseRun.characterId === '1107' && showcaseRun.configType === 'dps' && finiteScore(showcaseRun),
    `percent=${showcaseRun.percent?.toFixed(3)} grade=${showcaseRun.grade}`,
  )
  const rosterHasNoClara = await expectToolError(client, 'get_character', { characterId: '1107' })
  check('showcase scoring never imports (Clara still absent from the roster)', rosterHasNoClara != null)
  const nonSimOverrideErr = await expectToolError(client, 'score_character', {
    source: 'showcase',
    characterId: '1107',
    cacheId: claraFetch.cacheId,
    override: { characterId: SEELE, lightCone: SEELE_LC },
  })
  check(
    'overriding to a character with no simulation config errors (Chinese, points at score_relics)',
    nonSimOverrideErr.includes('score_relics'),
    nonSimOverrideErr.slice(0, 100),
  )
  const overrideRun = await callTool(client, 'score_character', {
    source: 'showcase',
    characterId: '1107',
    cacheId: claraFetch.cacheId,
    override: { characterId: TARGET, lightCone: '23014' },
  }, LONG)
  check(
    'showcase override swaps the scored character+light cone, relics kept',
    overrideRun.scoredCharacterId === TARGET && overrideRun.showcaseOverride?.lightCone === '23014' && finiteScore(overrideRun),
    `scored=${overrideRun.scoredCharacterId} percent=${overrideRun.percent.toFixed(3)}`,
  )
  check(
    'override produces a different score than the original character on the same relics',
    Math.abs(overrideRun.percent - showcaseRun.percent) > 1e-9,
    `${showcaseRun.percent.toFixed(4)} vs ${overrideRun.percent.toFixed(4)}`,
  )
  const badOverrideErr = await expectToolError(client, 'score_character', {
    source: 'showcase',
    characterId: '1107',
    override: { characterId: SEELE },
  })
  check(
    'override without a light cone rejected (Chinese)',
    badOverrideErr.includes('lightCone') || badOverrideErr.includes('光锥'),
    badOverrideErr.slice(0, 90),
  )
  const missingCacheErr = await expectToolError(client, 'score_character', { source: 'showcase', characterId: '1107', cacheId: 'showcase-nope-1' })
  check('unknown cacheId rejected (Chinese, points at cached list)', missingCacheErr.includes('缓存'), missingCacheErr.slice(0, 90))

  // ── 9. set_scoring_override: configs / linkFlatAndPercent / resetAll ──────
  // 9a. editTeammate roundtrip
  const edited = await callTool(client, 'set_scoring_override', {
    characterId: TARGET,
    configs: { configType: 'dps', editTeammate: { index: 1, characterId: BUFFER_CHAR, lightCone: BRONYA_LC } },
  })
  check(
    'configs.editTeammate writes the DPS custom team (slot 1) and flips to Custom',
    edited.configs?.configType === 'dps' && edited.configs.teammates[1] === BUFFER_CHAR && edited.configs.sessionTeamPreference === 'Custom',
    JSON.stringify(edited.configs?.teammates),
  )
  const metaEdited = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check(
    'override.simulation.teammates persists the edit',
    metaEdited.override?.simulation?.teammates?.[1]?.characterId === BUFFER_CHAR,
    JSON.stringify(metaEdited.override?.simulation?.teammates?.map((t) => t.characterId)),
  )
  const autoCustomRun = await callTool(client, 'score_character', { source: 'roster', characterId: TARGET }, LONG)
  check(
    'team=auto now resolves the custom team (web handleTeamSelection semantics)',
    autoCustomRun.team === 'custom' && autoCustomRun.teammates[1] === BUFFER_CHAR,
    `team=${autoCustomRun.team} teammates=${JSON.stringify(autoCustomRun.teammates)}`,
  )
  const defaultRun = await callTool(client, 'score_character', { source: 'roster', characterId: TARGET, team: 'default' }, LONG)
  check(
    'team=default forces the official team back',
    defaultRun.team === 'default' && Math.abs(defaultRun.percent - dpsRun.percent) < 1e-6,
    `percent=${defaultRun.percent.toFixed(4)}`,
  )

  // 9b. syncTeam: adopt roster eidolon/light cones for matching teammates
  const synced = await callTool(client, 'set_scoring_override', { characterId: TARGET, configs: { syncTeam: true } })
  check(
    'configs.syncTeam keeps the team and reports Custom',
    synced.configs?.changed?.includes('syncTeam') === true && synced.configs.teammates.length === 3,
    JSON.stringify(synced.configs),
  )
  // Verify the synced VALUES per the acceptance case: each matching teammate's
  // eidolon / light cone / superimposition adopts that character's roster form.
  const syncedMeta = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  const syncedValues = syncedMeta.override?.simulation?.teammates ?? []
  const rosterMatches = await Promise.all(syncedValues.map(async (teammate) => {
    if (teammate?.characterId == null) return true
    // Teammates absent from the roster keep their stored values (acceptance
    // semantics) — nothing to verify against; only roster-present ones sync.
    const rosterResult = await client.callTool({ name: 'get_character', arguments: { characterId: teammate.characterId } })
    if (rosterResult.isError) return true
    const roster = rosterResult.structuredContent ?? JSON.parse(rosterResult.content.find((c) => c.type === 'text').text)
    const form = roster.savedForm ?? roster.form
    if (form == null) return true
    if ((teammate.characterEidolon ?? 0) !== (form.characterEidolon ?? 0)) return false
    if (teammate.lightCone != null && teammate.lightCone !== form.lightCone) return false
    if (teammate.lightCone != null && (teammate.lightConeSuperimposition ?? 1) !== (form.lightConeSuperimposition ?? 1)) return false
    return true
  }))
  check(
    'syncTeam adopts each matching teammate roster eidolon/light cone/superimposition',
    syncedValues.length === 3 && rosterMatches.every(Boolean),
    JSON.stringify(syncedValues.map((t) => [t?.characterId, t?.characterEidolon ?? 0, t?.lightCone, t?.lightConeSuperimposition ?? 1])),
  )

  // 9c. buffPriority (deprioritizeBuffs) roundtrip + dps-only rejection
  const prio = await callTool(client, 'set_scoring_override', { characterId: TARGET, configs: { configType: 'dps', deprioritizeBuffs: true } })
  check('configs.deprioritizeBuffs writes true into the DPS override', prio.configs?.deprioritizeBuffs === true, JSON.stringify(prio.configs))
  const prioRun = await callTool(client, 'score_character', { source: 'roster', characterId: TARGET }, LONG)
  check('score_character reports the effective deprioritizeBuffs=true', prioRun.deprioritizeBuffs === true, `effective=${prioRun.deprioritizeBuffs}`)
  const prioExplicitRun = await callTool(client, 'score_character', { source: 'roster', characterId: TARGET, deprioritizeBuffs: false }, LONG)
  check(
    'explicit deprioritizeBuffs=false overrides the stored value for the run',
    prioExplicitRun.deprioritizeBuffs === false && Math.abs(prioExplicitRun.percent - prioRun.percent) > 1e-9,
    `stored true → run false, ${prioRun.percent.toFixed(4)} vs ${prioExplicitRun.percent.toFixed(4)}`,
  )
  const prioWrongConfigErr = await expectToolError(client, 'set_scoring_override', {
    characterId: TARGET,
    configs: { configType: 'buffer', deprioritizeBuffs: true },
  })
  check(
    'deprioritizeBuffs on a non-dps config rejected (Chinese)',
    prioWrongConfigErr.includes('只属于 DPS') || prioWrongConfigErr.includes('没有 buffer'),
    prioWrongConfigErr.slice(0, 90),
  )

  // 9d. resetConfig clears ONLY the dps segment
  const weightsKept = await callTool(client, 'set_scoring_override', { characterId: TARGET, weights: { 'Effect Hit Rate': 0.5 } })
  check('plain weights write still works alongside config segments', weightsKept.modified === true)
  const resetConfig = await callTool(client, 'set_scoring_override', { characterId: TARGET, configs: { configType: 'dps', resetConfig: true } })
  check(
    'configs.resetConfig clears the segment and returns to Default',
    resetConfig.configs?.changed?.includes('resetConfig') === true && resetConfig.configs.sessionTeamPreference === 'Default',
  )
  const metaAfterResetConfig = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check(
    'resetConfig drops simulation overrides but keeps stat weights (web parity)',
    metaAfterResetConfig.override?.simulation == null && metaAfterResetConfig.override?.stats != null,
    JSON.stringify(Object.keys(metaAfterResetConfig.override ?? {})),
  )

  // 9e. linkFlatAndPercent pair propagation + conflict rejection
  const linked = await callTool(client, 'set_scoring_override', { characterId: TARGET, weights: { ATK: 1 }, linkFlatAndPercent: true })
  check(
    'linkFlatAndPercent writes ATK and ATK% with the same value',
    linked.stats?.ATK === 1 && linked.stats?.['ATK%'] === 1,
    `ATK=${linked.stats?.ATK} ATK%=${linked.stats?.['ATK%']}`,
  )
  const linkConflict = await expectToolError(client, 'set_scoring_override', {
    characterId: TARGET,
    weights: { 'ATK': 1, 'ATK%': 0.5 },
    linkFlatAndPercent: true,
  })
  check('conflicting flat/percent pair rejected (Chinese)', linkConflict.includes('不能不同'), linkConflict.slice(0, 90))

  // 9f. resetAll wipes every character's overrides (destructive, exclusive)
  const beforeResetAll = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  const resetAllResult = await callTool(client, 'set_scoring_override', { resetAll: true })
  check(
    'resetAll reports the cleared character count and leaves no overrides',
    resetAllResult.resetAll === true && typeof resetAllResult.clearedCharacters === 'number' && resetAllResult.clearedCharacters >= 1,
    `cleared=${resetAllResult.clearedCharacters}`,
  )
  const afterResetAll = await callTool(client, 'get_scoring_metadata', { characterId: TARGET })
  check(
    'resetAll really cleared the touched character',
    afterResetAll.override == null && afterResetAll.modified === false,
    `override=${JSON.stringify(afterResetAll.override)}`,
  )
  const resetAllConflict = await expectToolError(client, 'set_scoring_override', { resetAll: true, characterId: TARGET })
  check('resetAll rejects characterId (mutual exclusion, Chinese)', resetAllConflict.includes('互斥'), resetAllConflict.slice(0, 90))

  // ── 10. score_relics scope / rollsSummary ─────────────────────────────────
  const selectedScore = await callTool(client, 'score_relics', { characterId: TARGET, relicFilters: { grade: 5 }, limit: 5 })
  check(
    'scope=selected keeps the per-character columns',
    selectedScore.scope === 'selected'
      && selectedScore.relics.every((relic) => relic.current != null && relic.potential != null && relic.rangePotential == null),
    `${selectedScore.relics.length} relics`,
  )
  const allScope = await callTool(client, 'score_relics', { characterId: TARGET, scope: 'all', relicFilters: { grade: 5 }, limit: 3 }, LONG)
  check(
    'scope=all adds the all-characters range potential with attribution',
    allScope.relics.every((relic) => relic.rangePotential != null && relic.rangePotential.bestCharacterId.length > 0 && relic.rangePotential.bestPct > 0),
    allScope.relics.map((relic) => `${relic.id}:${relic.rangePotential?.bestPct?.toFixed(1)}(${relic.rangePotential?.bestCharacterId})`).join(' '),
  )
  const customScope = await callTool(client, 'score_relics', {
    characterId: TARGET,
    scope: 'custom',
    excludeCharacters: [TARGET],
    relicFilters: { grade: 5 },
    limit: 3,
  }, LONG)
  check(
    'scope=custom excludes characters and echoes the exclusion list',
    customScope.excludeCharacters?.[0] === TARGET
      && customScope.relics.every((relic) => relic.rangePotential != null && relic.rangePotential.bestCharacterId !== TARGET),
    customScope.relics.map((relic) => relic.rangePotential?.bestCharacterId).join(','),
  )
  const badExcludeErr = await expectToolError(client, 'score_relics', { scope: 'custom', excludeCharacters: ['not-a-character'], limit: 1 })
  check('scope=custom with unknown exclusion rejected (Chinese)', badExcludeErr.includes('未知角色'), badExcludeErr.slice(0, 90))
  const rolls = await callTool(client, 'score_relics', { characterId: TARGET, relicFilters: { grade: 5 }, rollsSummary: true, limit: 5 })
  check(
    'rollsSummary adds per-relic roll distribution and page totals',
    rolls.relics.every((relic) =>
      relic.rollsSummary != null && typeof relic.rollsSummary.high === 'number'
      && relic.rollsSummary.total === relic.rollsSummary.high + relic.rollsSummary.mid + relic.rollsSummary.low
    )
      && rolls.rollsTotals != null && rolls.rollsTotals.relicCount === rolls.relics.length && typeof rolls.rollsTotals.weightedRolls === 'number',
    `totals=${JSON.stringify(rolls.rollsTotals)}`,
  )

  // ── 11. list_relics sortBy score columns ──────────────────────────────────
  const scoreSorted = await callTool(client, 'list_relics', { sortBy: 'currentScore', scoreBy: TARGET, limit: 20 })
  const scoredLookup = new Map(
    (await callTool(client, 'score_relics', { characterId: TARGET, limit: 500 })).relics.map((relic) => [relic.id, relic.current?.percentScore]),
  )
  const sortedScores = scoreSorted.relics.map((relic) => scoredLookup.get(relic.id))
  check(
    'sortBy=currentScore orders by the focus character score (desc default)',
    scoreSorted.sort?.by === 'currentScore' && scoreSorted.sort.scoreBy === TARGET
      && sortedScores.every((score, i) => score != null && (i === 0 || sortedScores[i - 1] >= score)),
    `first=${sortedScores[0]?.toFixed(1)} last=${sortedScores[sortedScores.length - 1]?.toFixed(1)}`,
  )
  const potentialSorted = await callTool(client, 'list_relics', { sortBy: 'potentialBest', scoreBy: TARGET, sortDir: 'asc', limit: 5 })
  check('sortBy=potentialBest asc works', potentialSorted.sort?.dir === 'asc' && potentialSorted.relics.length === 5)
  const missingScoreByErr = await expectToolError(client, 'list_relics', { sortBy: 'currentScore' })
  check('score sortBy without scoreBy rejected (Chinese)', missingScoreByErr.includes('scoreBy'), missingScoreByErr.slice(0, 90))
  const intrinsicSort = await callTool(client, 'list_relics', { sortBy: 'substatCount', limit: 10 })
  check(
    'sortBy=substatCount sorts intrinsically',
    intrinsicSort.relics.every((relic, i) => i === 0 || intrinsicSort.relics[i - 1].substats.length >= relic.substats.length),
    intrinsicSort.relics.map((relic) => relic.substats.length).join(','),
  )

  // ── 12. game://metadata/scoring resource ──────────────────────────────────
  const scoringPanel = await readJsonResource(client, 'game://metadata/scoring')
  const sections = ['substatWeights', 'sets', 'teams', 'combo', 'setPresets']
  const leaderboardGrouped = scoringPanel.leaderboardTeams ?? {}
  check(
    'game://metadata/scoring carries all six dashboard sections',
    sections.every((section) => Array.isArray(scoringPanel[section]) && scoringPanel[section].length > 0)
      && Object.keys(leaderboardGrouped).length > 0
      && Object.values(leaderboardGrouped).every((entries) => Array.isArray(entries) && entries.length > 0),
    [
      ...sections.map((section) => `${section}=${scoringPanel[section]?.length ?? 0}`),
      `leaderboardTeams=${Object.values(leaderboardGrouped).map((entries) => entries.length).join('+')}`,
    ].join(' '),
  )
  const jingliuWeights = scoringPanel.substatWeights.find((entry) => entry.characterId === TARGET)
  check(
    'substatWeights has the nine percent columns for Jingliu',
    jingliuWeights != null && Object.keys(jingliuWeights.weights).length === 9,
    JSON.stringify(jingliuWeights?.weights),
  )
  const jingliuTeam = scoringPanel.teams.find((entry) => entry.characterId === TARGET)
  check(
    'teams lists the default 3 teammates with light cones',
    jingliuTeam?.teammates?.length === 3 && jingliuTeam.teammates.every((teammate) => teammate.characterId != null && teammate.lightCone != null),
    JSON.stringify(jingliuTeam?.teammates?.map((teammate) => teammate.characterId)),
  )
  const jingliuCombo = scoringPanel.combo.find((entry) => entry.characterId === TARGET)
  check(
    'combo carries internal codes and readable zh names',
    jingliuCombo?.comboTurnAbilities?.length > 0
      && jingliuCombo.comboNames.length === jingliuCombo.comboTurnAbilities.length
      // toI18NVisual renders '' for null-turn placeholders (displayUtils.ts:25)
      // — web parity means the same blanks, so require real labels only where
      // the ability is a real action code.
      && jingliuCombo.comboNames.some((name) => name.length > 0)
      && jingliuCombo.comboTurnAbilities.some((action) => /^(DEFAULT_)?(BASIC|SKILL|ULT)/.test(action))
      && jingliuCombo.comboNames.filter((name) => name.length > 0).length
        === jingliuCombo.comboTurnAbilities.filter((action) => !/^(NULL|NONE)/i.test(action)).length,
    jingliuCombo?.comboNames?.slice(0, 4).join(' - '),
  )
  const leaderboardSections = Object.keys(scoringPanel.leaderboardTeams)
  check(
    'leaderboardTeams is split by scoring config and only 5★ characters',
    leaderboardSections.includes('dps') && leaderboardSections.every((section) => scoringPanel.leaderboardTeams[section].every((entry) => entry.rarity === 5)),
    leaderboardSections.join(','),
  )
  check(
    'sets carries the recommended sets + lit-cell union',
    scoringPanel.sets.every((entry) => Array.isArray(entry.relicSets) && entry.setNames.length > 0),
    `${scoringPanel.sets.length} characters with sim configs`,
  )

  // ── 13. persistence sanity: the temp save survived the write-backs ────────
  check('temp save file still exists after dirty flushes', existsSync(sampleSavePath))
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-score: ALL CHECKS PASSED' : `\nsmoke-score: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
