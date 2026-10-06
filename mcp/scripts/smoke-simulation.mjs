// End-to-end smoke test for the simulation tool surface (simulate_build /
// stat_simulate / analyze_build / benchmark_runs).
//
// Spawns the built server over stdio and walks, against the sample save
// (temp copy, temp localStorage — the repo save is never a write target):
//
//   simulate_build  — 1212b1 current equipment, trace=false: every summary
//                     number finite (no NaN/Infinity — a NaN would arrive as
//                     JSON null and fail the typeof checks), combo registers,
//                     action/rotation damage. trace=true: rotation steps
//                     non-empty, damage splits labelled, per-action buffs
//                     carry BuffSource attribution (buffType/ability), and the
//                     stats reduction keys are the upstream Stats key names.
//   stat_simulate   — 2 hypothetical variants (same sets/mains, one with more
//                     HP% rolls): identical inputs → value-by-value identical
//                     results (determinism), and the higher-HP variant's
//                     damage metric does not decrease (1212b1 is an HP scaler).
//   analyze_build   — old = current equipment, new = character 1102's six
//                     relics: stat-upgrade table non-empty with per-roll
//                     combo/EHP deltas, old-vs-new comparison fields present
//                     and self-consistent.
//   benchmark_runs  — 2 small presets (4pc sets × Rutilant Arena, no SPD
//                     threshold; measured ~1–3s/preset inline, far under the
//                     60s budget — see the assertion note next to the timing
//                     check): per-preset scores incl. perfection, ranking,
//                     progress notifications; then dps_score is called AFTER
//                     benchmark_runs to prove the SEQUENTIAL_BENCHMARKS global
//                     it sets does not break the other inline-benchmark tool.
//
// Usage: node scripts/smoke-simulation.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

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

const TARGET = '1212b1' // Jingliu (b1) — 6 equipped relics, HP-scaling DPS, has simulation scoring metadata
const DONOR = '1102' // 6 equipped relics → the analyze_build candidate build

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-sim-`)
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

// Upstream src/lib/constants/constants.ts `Stats` values (the game stat key
// names the serializers must reuse) — 23 keys.
const STATS_KEYS = [
  'ATK%',
  'ATK',
  'Break Effect',
  'CRIT DMG',
  'CRIT Rate',
  'DEF%',
  'DEF',
  'Effect Hit Rate',
  'Energy Regeneration Rate',
  'Fire DMG Boost',
  'HP%',
  'HP',
  'Ice DMG Boost',
  'Imaginary DMG Boost',
  'Lightning DMG Boost',
  'Outgoing Healing Boost',
  'Physical DMG Boost',
  'Quantum DMG Boost',
  'Effect RES',
  'SPD%',
  'SPD',
  'Wind DMG Boost',
  'Elation',
]
// Non-Stats keys toBasicStatsObject() legitimately adds alongside them.
const BASIC_EXTRA_KEYS = ['ELEMENTAL_DMG', 'relicSetIndex', 'ornamentSetIndex']
// Upstream BUFF_TYPE enum (src/lib/optimization/buffSource.ts).
const BUFF_TYPES = ['PRIMARY', 'CHARACTER', 'LIGHTCONE', 'SETS', 'BASIC_STATS', 'COMBAT_STATS', 'NONE']
// Upstream SubStats values (src/lib/constants/constants.ts).
const SUBSTAT_KEYS = [
  'ATK%',
  'ATK',
  'HP%',
  'HP',
  'DEF%',
  'DEF',
  'SPD',
  'CRIT Rate',
  'CRIT DMG',
  'Effect Hit Rate',
  'Effect RES',
  'Break Effect',
]
// Upstream PartsMainStats vocabulary (src/lib/constants/constants.ts) — legal
// main stats per part; the benchmark search picks among these freely.
const PART_MAINS = {
  body: ['HP%', 'ATK%', 'DEF%', 'CRIT Rate', 'CRIT DMG', 'Outgoing Healing Boost', 'Effect Hit Rate'],
  feet: ['HP%', 'ATK%', 'DEF%', 'SPD'],
  planarSphere: [
    'HP%',
    'ATK%',
    'DEF%',
    'Physical DMG Boost',
    'Fire DMG Boost',
    'Ice DMG Boost',
    'Lightning DMG Boost',
    'Wind DMG Boost',
    'Quantum DMG Boost',
    'Imaginary DMG Boost',
  ],
  linkRope: ['HP%', 'ATK%', 'DEF%', 'Break Effect', 'Energy Regeneration Rate'],
}

/** Walk a value; return [] when every number found is finite, else the offending paths. */
function nonFinitePaths(value, path = '$', acc = []) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) acc.push(path)
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinitePaths(v, `${path}[${i}]`, acc))
  } else if (value != null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nonFinitePaths(v, `${path}.${k}`, acc)
  } else if (value === undefined) {
    acc.push(`${path}(undefined)`)
  }
  return acc
}

/** Structural deep-equal (key-order independent); returns mismatching paths. */
function diffPaths(a, b, path = '$', acc = []) {
  if (a === b) return acc
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return acc
    acc.push(`${path}: ${a} !== ${b}`)
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) acc.push(`${path}.length: ${a.length} !== ${b.length}`)
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) diffPaths(a[i], b[i], `${path}[${i}]`, acc)
  } else if (a != null && b != null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    for (const k of ka) if (!(k in b)) acc.push(`${path}.${k}: only in first`)
    for (const k of kb) if (!(k in a)) acc.push(`${path}.${k}: only in second`)
    for (const k of ka) if (k in b) diffPaths(a[k], b[k], `${path}.${k}`, acc)
  } else {
    acc.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
  }
  return acc
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-simulation', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  // 1. tool surface + fixture
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  for (const name of ['simulate_build', 'stat_simulate', 'analyze_build', 'benchmark_runs']) {
    check(`tool ${name} registered`, toolNames.includes(name))
  }
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save relics = 162 / characters = 8', loaded.relics === 162 && loaded.characters === 8, `${loaded.relics}/${loaded.characters}`)

  // ══ 2. simulate_build ══════════════════════════════════════════════════════
  // 2a. trace=false — current equipment
  const simStart = Date.now()
  const summary = await callTool(client, 'simulate_build', { characterId: TARGET }, { timeout: 120_000 })
  console.log(`        simulate_build(trace=false) took ${Date.now() - simStart}ms`)
  check(
    'simulate_build defaults to the equipped build (6 relics, fromEquipped)',
    summary.build.fromEquipped === true && summary.build.relicCount === 6 && Object.keys(summary.build.relicIds).length === 6,
    `relicCount=${summary.build.relicCount}`,
  )
  check('simulate_build echoes trace=false', summary.trace === false)

  // 汇总数值全为有限数:NaN 在 JSON 序列化后会变 null,typeof 检查一并拦住
  const summaryBad = nonFinitePaths({ stats: summary.stats, actionDamage: summary.actionDamage, rotationDamage: summary.rotationDamage })
  check(
    'simulate_build trace=false: stats/actionDamage/rotationDamage contain only finite numbers (no NaN/Infinity/null)',
    summaryBad.length === 0,
    summaryBad.slice(0, 5).join(', '),
  )
  const basicKeys = Object.keys(summary.stats.basic)
  check(
    'simulate_build basic-stats keys are exactly the upstream Stats names + engine extras',
    basicKeys.every((k) => STATS_KEYS.includes(k) || BASIC_EXTRA_KEYS.includes(k))
      && STATS_KEYS.every((k) => basicKeys.includes(k)),
    `${basicKeys.length} keys, missing: ${STATS_KEYS.filter((k) => !basicKeys.includes(k)).join(',') || 'none'}`,
  )
  check(
    'simulate_build basic carries set indices (relicSetIndex/ornamentSetIndex ≥ 0)',
    Number.isInteger(summary.stats.basic.relicSetIndex) && summary.stats.basic.relicSetIndex >= 0
      && Number.isInteger(summary.stats.basic.ornamentSetIndex) && summary.stats.basic.ornamentSetIndex >= 0,
    `relic=${summary.stats.basic.relicSetIndex}, ornament=${summary.stats.basic.ornamentSetIndex}`,
  )
  const computedKeys = Object.keys(summary.stats.computed)
  check(
    'simulate_build computed-stats keys reuse the upstream Stats names (ATK/HP/DEF/SPD/CRIT Rate/CRIT DMG present)',
    ['ATK', 'HP', 'DEF', 'SPD', 'CRIT Rate', 'CRIT DMG'].every((k) => computedKeys.includes(k)),
    `${computedKeys.length} computed keys`,
  )
  check(
    'simulate_build combo registers finite; COMBO damage positive for a DPS',
    typeof summary.stats.combo?.damage === 'number' && summary.stats.combo.damage > 0
      && ['heal', 'shield', 'buff'].every((k) => typeof summary.stats.combo[k] === 'number'),
    `COMBO=${summary.stats.combo?.damage?.toLocaleString()}, heal=${summary.stats.combo?.heal}`,
  )
  const actionKeys = Object.keys(summary.actionDamage ?? {})
  check(
    'simulate_build trace=false returns per-ability damage totals (non-empty, ≥ 0)',
    actionKeys.length >= 1 && actionKeys.every((k) => typeof summary.actionDamage[k] === 'number' && summary.actionDamage[k] >= 0),
    `${actionKeys.join(',')}: ${actionKeys.map((k) => Math.round(summary.actionDamage[k])).join('/')}`,
  )
  const rotation = summary.rotationDamage ?? []
  const rotationSum = rotation.reduce((s, step) => s + step.damage, 0)
  check(
    'simulate_build trace=false rotation steps shaped and sum > 0',
    rotation.length >= 1
      && rotation.every((s) =>
        typeof s.actionType === 'string' && s.actionType.length > 0
        && typeof s.actionName === 'string' && typeof s.damage === 'number' && s.damage >= 0
      )
      && rotationSum > 0,
    `${rotation.length} steps, sum=${Math.round(rotationSum)}`,
  )

  // 2b. trace=true — damage splits + buff snapshots with source attribution
  const traceStart = Date.now()
  const traced = await callTool(client, 'simulate_build', { characterId: TARGET, trace: true }, { timeout: 120_000 })
  console.log(`        simulate_build(trace=true) took ${Date.now() - traceStart}ms`)
  check('simulate_build echoes trace=true', traced.trace === true)
  const tracedBad = nonFinitePaths({
    stats: traced.stats,
    actionDamage: traced.actionDamage,
    rotationDamage: traced.rotationDamage,
    damageSplits: traced.damageSplits,
  })
  check('simulate_build trace=true numbers all finite', tracedBad.length === 0, tracedBad.slice(0, 5).join(', '))
  check(
    'simulate_build trace=true rotation damage steps non-empty',
    Array.isArray(traced.rotationDamage) && traced.rotationDamage.length >= 1,
    `${traced.rotationDamage?.length} steps`,
  )
  const byAbility = traced.damageSplits?.byAbility ?? []
  check(
    'simulate_build trace=true damage splits: per-ability entries with labelled segments',
    byAbility.length >= 1
      && byAbility.every(
        (entry) =>
          typeof entry.name === 'string' && entry.name.length > 0
          && typeof entry.total === 'number'
          && entry.segments.length >= 1
          && entry.segments.every(
            (seg) =>
              typeof seg.label === 'string' && seg.label.length > 0
              && typeof seg.damage === 'number' && Number.isInteger(seg.hitIndex),
          ),
      )
      && byAbility.some((entry) => entry.total > 0),
    `${byAbility.length} abilities: ${byAbility.slice(0, 4).map((e) => e.name).join(', ')}`,
  )
  const splitSumsOk = byAbility.every(
    (entry) => Math.abs(entry.segments.reduce((s, seg) => s + seg.damage, 0) - entry.total) <= 1e-6 * Math.max(1, entry.total),
  )
  check('simulate_build damage-split totals equal the sum of their segments', splitSumsOk)
  check(
    'simulate_build rotation-mode damage splits present alongside byAbility',
    Array.isArray(traced.damageSplits?.rotation) && traced.damageSplits.rotation.length >= 1,
    `${traced.damageSplits?.rotation?.length} rotation entries`,
  )

  // Buff 归因:每条 buff 必须带 BuffSource(id/label/ability/buffType)
  const byAction = traced.buffs?.byAction ?? {}
  const buffActions = Object.keys(byAction)
  const allBuffs = []
  for (const action of buffActions) {
    allBuffs.push(...(byAction[action].buffs ?? []), ...(byAction[action].buffsMemo ?? []))
  }
  for (const step of traced.buffs?.rotationSteps ?? []) {
    allBuffs.push(...(step.buffs ?? []), ...(step.buffsMemo ?? []))
  }
  allBuffs.push(...(traced.buffs?.basic ?? []))
  const missingSource = allBuffs.filter(
    (b) =>
      b?.source == null
      || ['id', 'label', 'ability', 'buffType'].some((k) => typeof b.source[k] !== 'string' || b.source[k].length === 0),
  )
  check(
    'simulate_build buffs: every entry (byAction + rotationSteps + basic) carries full source attribution',
    allBuffs.length >= 1 && missingSource.length === 0,
    `${allBuffs.length} buffs, ${missingSource.length} without source`,
  )
  const badBuffTypes = [...new Set(allBuffs.map((b) => b.source.buffType))].filter((t) => !BUFF_TYPES.includes(t))
  check(
    'simulate_build buff sources classify into upstream BUFF_TYPE values, incl. the character\'s own kit (CHARACTER — precomputed buffs must survive the trace merge)',
    badBuffTypes.length === 0 && allBuffs.some((b) => b.source.buffType === 'CHARACTER'),
    `types: ${[...new Set(allBuffs.map((b) => b.source.buffType))].join(',')}`,
  )
  // 实际口径:Buff.stat 是引擎内部键名(AKey/BasicKey 词表,如 CR/CD/BOOST/
  // ICE_DMG_BOOST),不是展示名——上游 Buff 即此形状,序列化器原样透传。
  check(
    'simulate_build buff stat names use the engine key vocabulary (AKey/BasicKey ids, e.g. CR/CD/BOOST)',
    allBuffs.every((b) => typeof b.stat === 'string' && /^[A-Z][A-Z0-9_]*$/.test(b.stat))
      && allBuffs.some((b) => b.stat === 'CR' || b.stat === 'CD'),
    `e.g. ${[...new Set(allBuffs.map((b) => b.stat))].slice(0, 8).join(', ')}`,
  )
  check(
    'simulate_build trace=true basic-stat trace non-empty (relic/set basic buffs captured)',
    (traced.buffs?.basic ?? []).length >= 1,
    `${traced.buffs?.basic?.length} basic buffs`,
  )
  check(
    'simulate_build entities section empty for a single-entity character (no memo spawns)',
    Array.isArray(traced.stats.entities) && traced.stats.entities.length === 0,
    `${traced.stats.entities?.length} entities`,
  )

  // ══ 3. stat_simulate ════════════════════════════════════════════════════════
  const statSimArgs = {
    characterId: TARGET,
    simulations: [
      {
        name: 'baseline',
        simRelicSet1: 'Scholar Lost in Erudition',
        simRelicSet2: 'Scholar Lost in Erudition',
        simOrnamentSet: 'Rutilant Arena',
        simBody: 'CRIT DMG',
        simFeet: 'SPD',
        simPlanarSphere: 'Ice DMG Boost',
        simLinkRope: 'ATK%',
        stats: { 'HP%': 4, 'CRIT Rate': 4, 'CRIT DMG': 4, 'SPD': 4 },
      },
      {
        name: 'high-hp',
        simRelicSet1: 'Scholar Lost in Erudition',
        simRelicSet2: 'Scholar Lost in Erudition',
        simOrnamentSet: 'Rutilant Arena',
        simBody: 'CRIT DMG',
        simFeet: 'SPD',
        simPlanarSphere: 'Ice DMG Boost',
        simLinkRope: 'ATK%',
        // Same crit/SPD rolls, 12 extra HP% rolls. Direction semantics:
        // 1212b1 (Jingliu B1) is an HP scaler — every damaging hit is
        // .hpScaling(...) in JingliuB1.ts — so more HP% at fixed crit/SPD must
        // strictly raise COMBO damage (only the stat-independent BREAK portion
        // stays constant).
        stats: { 'HP%': 16, 'CRIT Rate': 4, 'CRIT DMG': 4, 'SPD': 4 },
      },
    ],
  }
  const statRun1 = await callTool(client, 'stat_simulate', statSimArgs, { timeout: 300_000 })
  const statRun2 = await callTool(client, 'stat_simulate', statSimArgs, { timeout: 300_000 })
  console.log(`        stat_simulate: ${statRun1.durationMs}ms / ${statRun2.durationMs}ms for 2 variants`)

  check(
    'stat_simulate echoes params + upstream-named request fields',
    statRun1.params.quality === 1 && statRun1.params.speedRollValue === 2.6
      && statRun1.variants[0].request.relicSet1 === 'Scholar Lost in Erudition'
      && statRun1.variants[0].request.ornamentSet === 'Rutilant Arena'
      && statRun1.variants[0].request.body === 'CRIT DMG'
      && statRun1.variants[0].request.stats['HP%'] === 4,
    `quality=${statRun1.params.quality}, spdRoll=${statRun1.params.speedRollValue}`,
  )
  const simBadNumbers = nonFinitePaths({ variants: statRun1.variants, ranking: statRun1.ranking })
  check('stat_simulate variant/ranking numbers all finite', simBadNumbers.length === 0, simBadNumbers.slice(0, 5).join(', '))
  const detDiff = diffPaths(statRun1.variants, statRun2.variants)
  check(
    'stat_simulate deterministic: identical inputs → value-by-value identical variants',
    detDiff.length === 0,
    detDiff.slice(0, 5).join('; ') || 'exact match',
  )
  const rankDiff = diffPaths(statRun1.ranking, statRun2.ranking)
  check('stat_simulate deterministic: ranking identical too', rankDiff.length === 0, rankDiff.slice(0, 3).join('; '))

  const [vBase, vHigh] = statRun1.variants
  check(
    'stat_simulate higher-HP% variant has strictly higher panel HP (same crit/SPD rolls)',
    typeof vBase.stats.basic.HP === 'number' && typeof vHigh.stats.basic.HP === 'number' && vHigh.stats.basic.HP > vBase.stats.basic.HP,
    `${Math.round(vBase.stats.basic.HP)} → ${Math.round(vHigh.stats.basic.HP)}`,
  )
  check(
    'stat_simulate higher-HP variant COMBO damage strictly increases (1212b1 is an HP scaler: all hits .hpScaling)',
    typeof vBase.simScore === 'number' && vHigh.simScore > vBase.simScore && vHigh.stats.combo.damage > vBase.stats.combo.damage,
    `simScore ${Math.round(vBase.simScore)} → ${Math.round(vHigh.simScore)}, COMBO ${Math.round(vBase.stats.combo.damage)} → ${
      Math.round(vHigh.stats.combo.damage)
    }`,
  )
  check(
    'stat_simulate deltas: baseline vs itself is 0, high-hp strictly positive',
    vBase.deltaVsBaseline.simScore === 0 && vHigh.deltaVsBaseline.simScore > 0 && vHigh.deltaVsBaseline.pct > 0,
    `delta=${Math.round(vHigh.deltaVsBaseline.simScore)} (+${vHigh.deltaVsBaseline.pct.toFixed(1)}%)`,
  )
  check(
    'stat_simulate ranking puts high-hp first, sorted descending',
    statRun1.ranking[0].index === 1 && statRun1.ranking[0].name === 'high-hp'
      && statRun1.ranking[0].simScore >= statRun1.ranking[1].simScore,
    JSON.stringify(statRun1.ranking),
  )
  check(
    'stat_simulate variants carry rotation damage + upstream Stats-named basic keys',
    vBase.rotationDamage.length >= 1 && STATS_KEYS.every((k) => k in vBase.stats.basic),
    `${vBase.rotationDamage.length} rotation steps`,
  )

  // ══ 4. analyze_build ═══════════════════════════════════════════════════════
  const donorRelics = await callTool(client, 'list_relics', { equippedBy: DONOR, limit: 500 })
  const donorByPart = donorRelics.relics.map((r) => r.part).sort()
  check(
    `analyze_build fixture: ${DONOR} has a complete 6-part build to use as the candidate`,
    donorRelics.relics.length === 6 && new Set(donorByPart).size === 6,
    donorByPart.join(','),
  )
  const newRelicIds = donorRelics.relics.map((r) => r.id)
  // The sample-save form carries no teammates, and upstream
  // computeTeammateOrnamentUpgrades skips missing teammates entirely — feed one
  // teammate (1102 with her own light cone) through formOverrides so the
  // teammate-ornament upgrade table is actually computed.
  const analysisStart = Date.now()
  const analysis = await callTool(client, 'analyze_build', {
    characterId: TARGET,
    newRelicIds,
    formOverrides: {
      teammates: [{ characterId: DONOR, characterEidolon: 0, lightCone: '24001', lightConeSuperimposition: 5 }, {}, {}],
    },
  }, { timeout: 300_000 })
  console.log(`        analyze_build took ${Date.now() - analysisStart}ms`)
  check(
    'analyze_build build bookkeeping: old = equipped (6), new = explicit ids (6)',
    analysis.builds.old.fromEquipped === true && analysis.builds.old.relicCount === 6
      && analysis.builds.new.fromEquipped === false && analysis.builds.new.relicCount === 6
      && Object.values(analysis.builds.new.relicIds).every((id) => newRelicIds.includes(id)),
  )

  // 新旧对比字段存在且自洽
  check(
    'analyze_build old-vs-new comparison fields present (combo old/new objects + finite delta)',
    typeof analysis.combo.old?.damage === 'number' && typeof analysis.combo.new?.damage === 'number'
      && typeof analysis.combo.damageDelta === 'number' && Number.isFinite(analysis.combo.damageDelta)
      && analysis.stats.old != null && analysis.stats.new != null,
    `old=${Math.round(analysis.combo.old?.damage)} new=${Math.round(analysis.combo.new?.damage)} delta=${Math.round(analysis.combo.damageDelta)}`,
  )
  check(
    'analyze_build damageDelta is exactly new − old',
    analysis.combo.damageDelta === analysis.combo.new.damage - analysis.combo.old.damage,
  )
  const deltaBad = nonFinitePaths({ delta: analysis.actionDamage?.delta })
  check(
    'analyze_build per-ability damage deltas present and finite',
    Object.keys(analysis.actionDamage?.delta ?? {}).length >= 1 && deltaBad.length === 0,
    `${Object.keys(analysis.actionDamage?.delta ?? {}).length} abilities`,
  )

  // 升级表:calculateStatUpgrades 对全部 12 个上游副词条各 +1 roll
  const upgrades = analysis.statUpgrades ?? []
  const upgradeStats = upgrades.map((u) => u.stat)
  check(
    'analyze_build stat-upgrade table non-empty, one entry per upstream SubStat, distinct',
    upgrades.length >= 1
      && new Set(upgradeStats).size === upgradeStats.length
      && upgradeStats.every((s) => SUBSTAT_KEYS.includes(s)),
    `${upgrades.length} entries: ${upgradeStats.join(',')}`,
  )
  check(
    'analyze_build stat upgrades carry rollsAfter ≥ 1 and finite combo/EHP deltas',
    upgrades.every(
      (u) =>
        typeof u.rollsAfter === 'number' && u.rollsAfter >= 1
        && typeof u.combo?.delta === 'number' && Number.isFinite(u.combo.delta)
        && typeof u.ehp?.delta === 'number' && Number.isFinite(u.ehp.delta),
    ),
  )
  check(
    'analyze_build at least one substat roll raises COMBO (HP-scaler: HP% roll) and one raises EHP (HP/DEF roll)',
    upgrades.some((u) => u.combo.delta > 0) && upgrades.some((u) => u.ehp.delta > 0),
    `best combo +${Math.round(Math.max(...upgrades.map((u) => u.combo.delta)))}, best ehp +${Math.round(Math.max(...upgrades.map((u) => u.ehp.delta)))}`,
  )
  const comboDeltas = upgrades.map((u) => u.combo.delta)
  check(
    'analyze_build stat upgrades sorted by combo delta descending',
    comboDeltas.every((d, i) => i === 0 || comboDeltas[i - 1] >= d),
  )
  const teammateUpgrades = analysis.teammateOrnamentUpgrades ?? []
  check(
    'analyze_build teammate ornament upgrades non-empty (rows reference the configured teammate, finite scores)',
    teammateUpgrades.length >= 1
      && teammateUpgrades.every(
        (u) =>
          Array.isArray(u.teammates) && u.teammates.length >= 1 && u.teammates.length <= 3
          && u.teammates.every((id) => id === DONOR)
          && Array.isArray(u.set) && u.set.length >= 1 && u.set.every((s) => typeof s === 'string' && s.length > 0)
          && typeof u.simScore === 'number' && Number.isFinite(u.simScore)
          && (u.oldSet === null || typeof u.oldSet === 'string'),
      ),
    `${teammateUpgrades.length} rows, sets: ${teammateUpgrades.slice(0, 3).map((u) => u.set.join('+')).join(' | ')}`,
  )
  check(
    'analyze_build damage splits exist for BOTH old and new builds',
    (analysis.damageSplits?.old?.byAbility ?? []).length >= 1
      && (analysis.damageSplits?.new?.byAbility ?? []).length >= 1
      && analysis.damageSplits.new.byAbility.some((e) => e.total > 0),
    `old ${analysis.damageSplits?.old?.byAbility?.length} / new ${analysis.damageSplits?.new?.byAbility?.length} abilities`,
  )

  // ══ 5. benchmark_runs ══════════════════════════════════════════════════════
  // 小预设:两个 4pc 候选 × Rutilant Arena、不限速(内联实测秒级,远低于 60s
  // 预算;若上游变慢,断言里的时长检查会先红)。
  const progressEvents = []
  const benchStart = Date.now()
  const bench = await callTool(
    client,
    'benchmark_runs',
    {
      characterId: TARGET,
      presets: [
        { relicSet1: 'Scholar Lost in Erudition', relicSet2: 'Scholar Lost in Erudition', ornamentSet: 'Rutilant Arena', spdThreshold: 0 },
        { relicSet1: 'Genius of Brilliant Stars', relicSet2: 'Genius of Brilliant Stars', ornamentSet: 'Rutilant Arena', spdThreshold: 0 },
      ],
    },
    { timeout: 300_000, resetTimeoutOnProgress: true, onprogress: (p) => progressEvents.push(p) },
  )
  const benchWall = Date.now() - benchStart
  console.log(`        benchmark_runs: ${benchWall}ms wall for ${bench.presets?.length} presets`)
  check('benchmark_runs completed without cancellation', bench.cancelled === false, `cancelled=${bench.cancelled}, ${benchWall}ms wall`)
  check(
    'benchmark_runs sent progress notifications (one per preset)',
    progressEvents.length >= 2 && progressEvents.every((p) => typeof p.progress === 'number' && p.total === 2),
    `${progressEvents.length} event(s)`,
  )
  check(
    'benchmark_runs both presets completed (small presets, each well under the 60s budget)',
    bench.presets.length === 2 && bench.presets.every((p) => p.status === 'completed' && p.durationMs < 60_000),
    bench.presets.map((p) => `${p.status}/${p.durationMs}ms`).join(' '),
  )
  for (const preset of bench.presets) {
    check(
      `benchmark_runs preset #${preset.index} scores: finite benchmark/perfection + 4-part score set with maximum ≥ benchmark`,
      typeof preset.benchmarkScore === 'number' && preset.benchmarkScore > 0
        && typeof preset.perfectionScore === 'number' && preset.perfectionScore >= 0
        && ['original', 'baseline', 'benchmark', 'maximum'].every((k) => typeof preset.scores?.[k] === 'number' && Number.isFinite(preset.scores[k]))
        && preset.scores.maximum >= preset.scores.benchmark,
      `bench=${Math.round(preset.benchmarkScore)}, perfect=${Math.round(preset.perfectionScore)}, max=${Math.round(preset.scores?.maximum)}`,
    )
  }
  const preset0 = bench.presets[0]
  check(
    'benchmark_runs echoes the requested preset (sets/ornament/spd)',
    preset0.preset.relicSet1 === 'Scholar Lost in Erudition' && preset0.preset.relicSet2 === 'Scholar Lost in Erudition'
      && preset0.preset.ornamentSet === 'Rutilant Arena' && preset0.preset.spdThreshold === 0,
    JSON.stringify(preset0.preset),
  )
  check(
    'benchmark_runs bestBuild echoes the winning SimulationRequest shape (preset sets + legal per-part mains + finite stat rolls)',
    preset0.bestBuild != null && preset0.bestBuild.relicSet1 === 'Scholar Lost in Erudition'
      && PART_MAINS.body.includes(preset0.bestBuild.body)
      && PART_MAINS.feet.includes(preset0.bestBuild.feet)
      && PART_MAINS.planarSphere.includes(preset0.bestBuild.planarSphere)
      && PART_MAINS.linkRope.includes(preset0.bestBuild.linkRope)
      && Object.values(preset0.bestBuild.stats).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    `body=${preset0.bestBuild?.body} feet=${preset0.bestBuild?.feet} rope=${preset0.bestBuild?.linkRope}, ${
      Object.keys(preset0.bestBuild?.stats ?? {}).length
    } stats`,
  )
  check(
    'benchmark_runs exposes candidate search results (count + top list capped at 5)',
    typeof preset0.candidateCount === 'number' && preset0.candidateCount >= 1
      && Array.isArray(preset0.topCandidates) && preset0.topCandidates.length >= 1 && preset0.topCandidates.length <= 5
      && preset0.topCandidates.every((c) => typeof c.simScore === 'number' && Number.isFinite(c.simScore) && c.simScore >= 0),
    `${preset0.candidateCount} candidates, top ${preset0.topCandidates?.length}`,
  )
  check(
    // benchmarkBasicSpdTarget is the effective SPD target as a NUMBER (the
    // orchestrator flag resolves it to a concrete speed even when the preset
    // asked for "no threshold").
    'benchmark_runs reports SPD context (originalSpd > 0, spdBenchmark ≥ 0, numeric spd target ≥ 0)',
    typeof preset0.originalSpd === 'number' && preset0.originalSpd > 0
      && typeof preset0.spdBenchmark === 'number' && preset0.spdBenchmark >= 0
      && typeof preset0.benchmarkBasicSpdTarget === 'number' && preset0.benchmarkBasicSpdTarget >= 0,
    `originalSpd=${preset0.originalSpd}, spdBenchmark=${preset0.spdBenchmark}, target=${preset0.benchmarkBasicSpdTarget}`,
  )
  check(
    'benchmark_runs ranking covers both presets, descending, top at 0% delta',
    bench.ranking.length === 2
      && bench.ranking[0].benchmarkScore >= bench.ranking[1].benchmarkScore
      && bench.ranking[0].deltaPercentVsTop === 0 && bench.ranking[1].deltaPercentVsTop <= 0
      && bench.presets[bench.ranking[0].index].rank === 1,
    JSON.stringify(bench.ranking.map((r) => ({ i: r.index, s: Math.round(r.benchmarkScore), d: r.deltaPercentVsTop.toFixed(1) }))),
  )

  // SEQUENTIAL_BENCHMARKS 全局置位的跨工具影响:benchmark_runs 之后 dps_score
  // (同样走内联基准链)必须仍然可用。
  const dpsAfter = await callTool(client, 'dps_score', { characterId: TARGET, team: 'default' }, { timeout: 120_000 })
  check(
    'after benchmark_runs set SEQUENTIAL_BENCHMARKS, dps_score still works (finite percent 0–2 + grade + 4 scores)',
    typeof dpsAfter.percent === 'number' && dpsAfter.percent >= 0 && dpsAfter.percent <= 2
      && typeof dpsAfter.grade === 'string' && dpsAfter.grade.length > 0
      && [dpsAfter.scores?.original, dpsAfter.scores?.baseline, dpsAfter.scores?.benchmark, dpsAfter.scores?.maximum]
        .every((v) => typeof v === 'number' && Number.isFinite(v)),
    `${(dpsAfter.percent * 100).toFixed(1)}% ${dpsAfter.grade}`,
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-simulation: ALL CHECKS PASSED' : `\nsmoke-simulation: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
