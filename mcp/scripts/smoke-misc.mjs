// End-to-end smoke test for the misc tool surface:
//   calculators (warp_plan / calc_aha / calc_ehr) + teams (list_teams /
//   save_team) + sync bridge (sync_bridge_start/status/stop/push) + the M8
//   bidirectional full-sync bridge's tool surface (start/status/stop with
//   bidirectional=true — protocol behavior lives in smoke-m8.mjs, task D).
//
// calculators: deterministic inputs, outputs compared against the upstream
//   formulas re-implemented here from the sources (ahaCalculations.ts:7,
//   ehrCalculations.ts:23, warpCalculatorController.ts:119 — the warp PMF
//   engine mirror parses the real distribution tables out of
//   src/lib/tabs/tabWarp/warpRates.ts) plus closed-form hard-pity cases and
//   same-input-twice determinism.
// teams: fixture save (temp file) with two pre-existing teams (one carrying a
//   benchmarkSnapshot) → list round-trip, create/update, snapshot keep/drop
//   rules, semantic error paths, debounced write-back into the temp save file,
//   export → reload round-trip.
// bridge: sync_bridge_start on a random high port (never 23313) → a ws client
//   (mcp/node_modules ws) receives an InitialScan frame validated field by
//   field against the implementation + recon Q8 and value-zipped against the
//   loaded save → the frame is fed back through import_scanner_json (the real
//   upstream Reliquary parser) as a fidelity cross-check → sync_bridge_push →
//   mutation-driven re-push via the flushSave hook (unequip_character) →
//   DeleteRelics diff on an inventory-shrinking import → reconnect re-push →
//   stop releases the port (reconnect refused).
//
// Everything the server can persist is pointed at a temp directory — the
// repo's sample-save.json is never a write target. No network beyond
// 127.0.0.1 loopback, no git operations.
//
// Usage: node scripts/smoke-misc.mjs [serverEntry]
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
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')
const repoWarpRatesPath = resolve(mcpDir, '../src/lib/tabs/tabWarp/warpRates.ts')
const repoGameDataPath = resolve(mcpDir, '../src/data/game_data.json')

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-misc-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

let failures = 0
let assertions = 0
function check(name, ok, detail = '') {
  assertions++
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

/** Runs a tool expecting an isError result; returns the error text. */
async function toolError(client, name, args) {
  try {
    await callTool(client, name, args)
  } catch (e) {
    return String(e.message)
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ═════════════════════════════════════════════════════════════════════════════
// Upstream formula mirrors — hand-transcribed from src/ for manual cross-check.
// If the server output and these mirrors ever disagree, one of them is wrong.
// ═════════════════════════════════════════════════════════════════════════════

// src/lib/tabs/tabCalculators/ahaCalculations.ts:3-10
const AHA_BASE_SPEED = 80
function ahaMultiplier(rank) {
  return 1 / (5 * Math.pow(2, Math.min(rank, 3)))
}
function mirrorAhaSpeed(speeds) {
  const sorted = [...speeds].sort((a, b) => b - a)
  return sorted.reduce((acc, cur, idx) => acc + cur * ahaMultiplier(idx), AHA_BASE_SPEED)
}

// src/lib/tabs/tabCalculators/ehrCalculations.ts:23-34
function mirrorRequiredEhr(inputs) {
  const { baseChance, effectRes, debuffRes, desiredHitRate } = inputs
  const attempts = Math.max(1, Math.round(inputs.attempts))
  const canCompute = baseChance > 0 && effectRes < 100 && debuffRes < 100
  if (!canCompute) return NaN
  const targetPerAttempt = 1 - Math.pow(1 - desiredHitRate / 100, 1 / attempts)
  const baseMultiplier = (baseChance / 100) * (1 - effectRes / 100) * (1 - debuffRes / 100)
  return Math.max(0, 100 * (targetPerAttempt / baseMultiplier - 1))
}

// Distribution tables parsed straight out of the upstream source file.
const warpRatesSource = readFileSync(repoWarpRatesPath, 'utf8')
function parseDistribution(name) {
  const start = warpRatesSource.indexOf(`export const ${name} = [`)
  if (start === -1) throw new Error(`cannot find ${name} in warpRates.ts`)
  const body = warpRatesSource.slice(start, warpRatesSource.indexOf(']', start))
  const values = [...body.matchAll(/\/\* \d+ \*\/ ([\d.eE+-]+),/g)].map((m) => Number(m[1]))
  if (values.length === 0) throw new Error(`parsed 0 entries for ${name}`)
  return values
}
const CHAR_DIST = parseDistribution('characterDistribution') // 90 entries, [89] = hard pity
const LC_DIST = parseDistribution('lightConeDistribution') // 80 entries, [79] = hard pity

// src/lib/tabs/tabWarp/warpCalculatorTypes.ts:15-18, 75-80
const DIMENSIONS = {
  C: { dist: CHAR_DIST, warpCap: 90, fiftyFifty: 0.5625 },
  LC: { dist: LC_DIST, warpCap: 80, fiftyFifty: 0.78125 },
}
const STARLIGHT_MULTIPLIER = { REFUND_NONE: 0.00, REFUND_LOW: 0.04, REFUND_AVG: 0.075, REFUND_HIGH: 0.11 }
// warpCalculatorController.ts:44-45 generateOptions('4.5', 77, 57, …) / ('4.6', 100, 72, …).
// Key format from warpCalculatorTypes.ts:168 generateOptionKey: `${version}_p${phase}_${type}`
// where the enum interpolates as its NUMERIC value (1=F2P, 2=EXPRESS, 3=BP_EXPRESS).
const INCOME_PASSES = {
  '4.5_p1_1': 57,
  '4.5_p2_1': 20,
  '4.6_p1_1': 72,
  '4.6_p2_1': 28,
}

// warpCalculatorController.ts:337-378 — PMF helpers
function pityAdjustedPmf(distribution, pity, warpCap) {
  const slice = distribution.slice(pity, warpCap)
  const total = slice.reduce((sum, p) => sum + p, 0)
  if (total === 0) return [1]
  return [0, ...slice.map((p) => p / total)]
}
function convolveArrays(a, b) {
  const result = Array.from({ length: a.length + b.length - 1 }, () => 0)
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] += a[i] * b[j]
    }
  }
  return result
}
function milestoneCostPmf(milestoneStartDist, guaranteed, rate, freshStartDist) {
  if (guaranteed) return milestoneStartDist
  const winBranch = milestoneStartDist.map((p) => p * rate)
  const loseBranch = convolveArrays(milestoneStartDist, freshStartDist).map((p) => p * (1 - rate))
  const result = Array.from({ length: Math.max(winBranch.length, loseBranch.length) }, () => 0)
  for (let i = 0; i < winBranch.length; i++) result[i] += winBranch[i]
  for (let i = 0; i < loseBranch.length; i++) result[i] += loseBranch[i]
  return result
}
function milestoneStats(cumulativePmf, budget) {
  const warps = cumulativePmf.reduce((sum, p, k) => sum + k * p, 0)
  let wins = 0
  for (let k = 0; k <= budget && k < cumulativePmf.length; k++) wins += cumulativePmf[k]
  return { warps, wins }
}

// warpCalculatorController.ts:276-310 — ordered pull path for one target
function mirrorMilestonePath(targetEidolon, targetSi, strategy) {
  const path = []
  const hasLightConeTarget = targetSi !== 0
  const s1InsertionAfterEidolon = strategy === 7 ? -1 : Math.min(strategy, Math.max(targetEidolon, 0))
  let insertedS1 = false
  const insertS1 = () => {
    if (!hasLightConeTarget || insertedS1) return
    path.push('LC')
    insertedS1 = true
  }
  if (targetEidolon !== -1) {
    for (let eidolon = 0; eidolon <= targetEidolon; eidolon++) {
      if (s1InsertionAfterEidolon < eidolon) insertS1()
      path.push('C')
      if (s1InsertionAfterEidolon === eidolon) insertS1()
    }
  }
  insertS1()
  for (let superimposition = 2; superimposition <= targetSi; superimposition++) path.push('LC')
  return path
}

// normalizeWarpTarget defaults (warpCalculatorController.ts:74-93 over
// DEFAULT_WARP_TARGET): omitted target levels become E6/S5, omitted current
// levels become the NONE baseline (EidolonLevel.NONE = -1, SuperimpositionLevel.NONE = 0).
function normalizeTargetsForMirror(targets) {
  return targets.map((t) => ({
    targetEidolonLevel: t.targetEidolonLevel ?? 6,
    targetSuperimpositionLevel: t.targetSuperimpositionLevel ?? 5,
    currentEidolonLevel: t.currentEidolonLevel ?? -1,
    currentSuperimpositionLevel: t.currentSuperimpositionLevel ?? 0,
  }))
}

// warpCalculatorController.ts:119-170 + 210-272 — the whole cost engine.
function mirrorCalculateWarps(req) {
  const additionalPasses = req.income.reduce((sum, id) => sum + (INCOME_PASSES[id] ?? 0), 0)
  const initialWarps = Math.floor(req.jades / 160) + req.passes + additionalPasses
  const refundedWarps = Math.floor((STARLIGHT_MULTIPLIER[req.starlight] ?? 0) * initialWarps)
  const warps = initialWarps + refundedWarps

  const freshStartDist = { C: pityAdjustedPmf(CHAR_DIST, 0, 90), LC: pityAdjustedPmf(LC_DIST, 0, 80) }
  let cumulativePmf = [1]
  let hasUsedCharacterStart = false
  let hasUsedLightConeStart = false
  // Per-target milestone records (upstream keeps one Record per target — the
  // same label, e.g. E0S0, can legitimately appear under several targets).
  const perTarget = []

  for (const target of normalizeTargetsForMirror(req.targets)) {
    const startingState = {
      character: {
        pity: hasUsedCharacterStart ? 0 : req.pityCharacter,
        guaranteed: hasUsedCharacterStart ? false : req.guaranteedCharacter,
      },
      lightCone: {
        pity: hasUsedLightConeStart ? 0 : req.pityLightCone,
        guaranteed: hasUsedLightConeStart ? false : req.guaranteedLightCone,
      },
    }

    const path = mirrorMilestonePath(target.targetEidolonLevel, target.targetSuperimpositionLevel, req.strategy)
    let skipCharacters = target.currentEidolonLevel
    let skipLightCones = target.currentSuperimpositionLevel
    let e = target.currentEidolonLevel
    let s = target.currentSuperimpositionLevel
    let assignedCharacterStart = false
    let assignedLightConeStart = false
    const milestones = []
    let targetIndex = -1

    for (const warpType of path) {
      const isCharacter = warpType === 'C'
      if (isCharacter) {
        if (skipCharacters > -1) {
          skipCharacters--
          continue
        }
        e++
      } else {
        if (skipLightCones > 0) {
          skipLightCones--
          continue
        }
        s++
      }
      const isFirstOfType = isCharacter ? !assignedCharacterStart : !assignedLightConeStart
      if (isCharacter) assignedCharacterStart = true
      else assignedLightConeStart = true

      const bannerStart = isCharacter ? startingState.character : startingState.lightCone
      const label = e === -1 ? `S${s}` : target.targetSuperimpositionLevel === 0 ? `E${e}` : `E${e}S${s}`
      milestones.push({
        warpType,
        label,
        pity: isFirstOfType ? bannerStart.pity : 0,
        guaranteed: isFirstOfType ? bannerStart.guaranteed : false,
      })
      const reached = (target.targetEidolonLevel === -1 || e >= target.targetEidolonLevel)
        && (target.targetSuperimpositionLevel === 0 || s >= target.targetSuperimpositionLevel)
      if (targetIndex === -1 && reached) targetIndex = milestones.length - 1
    }
    const truncated = targetIndex === -1 ? milestones : milestones.slice(0, targetIndex + 1)

    const milestoneResults = {}
    const milestoneOrder = []
    for (const milestone of truncated) {
      if (milestone.warpType === 'C') hasUsedCharacterStart = true
      else hasUsedLightConeStart = true
      const dimension = DIMENSIONS[milestone.warpType]
      const milestoneStartDist = pityAdjustedPmf(dimension.dist, milestone.pity, dimension.warpCap)
      const milestoneDist = milestoneCostPmf(
        milestoneStartDist,
        milestone.guaranteed,
        dimension.fiftyFifty,
        freshStartDist[milestone.warpType],
      )
      cumulativePmf = convolveArrays(cumulativePmf, milestoneDist)
      milestoneResults[milestone.label] = milestoneStats(cumulativePmf, warps)
      milestoneOrder.push(milestone.label)
    }
    perTarget.push({ milestoneResults, milestoneOrder })
  }

  return { warps, additionalPasses, targets: perTarget }
}

const closeEnough = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))

// ═════════════════════════════════════════════════════════════════════════════
// boot
// ═════════════════════════════════════════════════════════════════════════════

const client = new Client({ name: 'smoke-misc', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

// Bridge frame key mirrors — bridge.ts MAINSTAT/SUBSTAT reverse tables
// (themselves the inverse of kelzFormatParser.tsx mainStatLookup/substatLookup).
const MAINSTAT_TO_SCANNER_KEY = {
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
const SUBSTAT_TO_SCANNER_KEY = {
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

// game_data.json relic sets: name → id (bridge resolves set names back to ids)
const gameData = JSON.parse(readFileSync(repoGameDataPath, 'utf8'))
const relicSetNameToId = new Map(gameData.relics.map((set) => [set.name, String(set.id)]))

function randomPort() {
  let port = 21000 + Math.floor(Math.random() * 30000)
  while (port === 23313) port = 21000 + Math.floor(Math.random() * 30000)
  return port
}

/** Connect a ws client and start collecting frames; resolves once open. */
function connectCollector(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url)
    const messages = []
    let settled = false
    ws.on('message', (data) => {
      const raw = String(data)
      try {
        messages.push({ at: Date.now(), index: messages.length, frame: JSON.parse(raw) })
      } catch (e) {
        messages.push({ at: Date.now(), index: messages.length, parseError: String(e), raw })
      }
    })
    ws.on('open', () => {
      settled = true
      resolvePromise({ ws, messages })
    })
    ws.on('error', (err) => {
      if (!settled) rejectPromise(err)
    })
  })
}

async function waitForFrame(messages, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = messages.find(predicate)
    if (hit) return hit
    await sleep(100)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for frame: ${label} (have ${messages.length} messages: ${
      messages.map((m) => m.frame?.event ?? `unparsed(${m.parseError})`).join(', ')
    })`,
  )
}

/** After sync_bridge_stop the listener must be gone: connect attempts fail. */
async function portRefused(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const outcome = await new Promise((resolvePromise) => {
      const probe = new WebSocket(url)
      const finish = (value) => {
        clearTimeout(timer)
        try {
          probe.terminate()
        } catch { /* already closed */ }
        resolvePromise(value)
      }
      const timer = setTimeout(() => finish({ refused: false, reason: 'timeout — still something listening' }), 2500)
      probe.on('error', (err) => finish({ refused: err.code === 'ECONNREFUSED', code: err.code, reason: err.message }))
      probe.on('open', () => finish({ refused: false, reason: 'connection unexpectedly accepted' }))
    })
    if (outcome.refused) return outcome
    await sleep(200)
  }
  return { refused: false, reason: `port still not refusing after ${timeoutMs}ms` }
}

try {
  // ── 1. tool surface ────────────────────────────────────────────────────────
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  for (
    const required of [
      'warp_plan',
      'calc_aha',
      'calc_ehr',
      'list_teams',
      'save_team',
      'sync_bridge_start',
      'sync_bridge_status',
      'sync_bridge_stop',
      'sync_bridge_push',
    ]
  ) {
    check(`tool ${required} registered`, toolNames.includes(required))
  }

  // ── 2. calculators — pure, no save loaded yet ─────────────────────────────
  // 2.1 calc_aha against the upstream formula + closed form
  const ahaSpeeds = [160, 120, 100]
  const aha1 = await callTool(client, 'calc_aha', { speeds: ahaSpeeds })
  const ahaExpected = mirrorAhaSpeed(ahaSpeeds)
  check('calc_aha matches upstream formula', closeEnough(aha1.ahaSpeed, ahaExpected), `${aha1.ahaSpeed} vs mirror ${ahaExpected}`)
  check('calc_aha closed form = 129 (80 + 32 + 12 + 5)', closeEnough(aha1.ahaSpeed, 129), `${aha1.ahaSpeed}`)
  check('calc_aha baseSpeed = 80', aha1.baseSpeed === 80)
  check(
    'calc_aha contributions rank-ordered with 1/5, 1/10, 1/20 multipliers',
    aha1.contributions.length === 3
      && aha1.contributions[0].rank === 1 && aha1.contributions[0].speed === 160 && closeEnough(aha1.contributions[0].multiplier, 0.2)
      && aha1.contributions[1].rank === 2 && aha1.contributions[1].speed === 120 && closeEnough(aha1.contributions[1].multiplier, 0.1)
      && aha1.contributions[2].rank === 3 && aha1.contributions[2].speed === 100 && closeEnough(aha1.contributions[2].multiplier, 0.05)
      && aha1.contributions.every((c) => closeEnough(c.contribution, c.speed * c.multiplier)),
    JSON.stringify(aha1.contributions),
  )
  const ahaUnsorted = await callTool(client, 'calc_aha', { speeds: [100, 160, 120] })
  check('calc_aha sorts internally (input order irrelevant)', ahaUnsorted.ahaSpeed === aha1.ahaSpeed, `${ahaUnsorted.ahaSpeed}`)
  const ahaEmpty = await callTool(client, 'calc_aha', { speeds: [] })
  check('calc_aha empty team = base 80', ahaEmpty.ahaSpeed === 80 && ahaEmpty.contributions.length === 0)
  const ahaFive = await callTool(client, 'calc_aha', { speeds: [100, 100, 100, 100, 100] })
  check(
    'calc_aha rank capped at 4+ (all 1/40): 80 + 100×(1/5+1/10+1/20+1/40+1/40) = 120',
    closeEnough(ahaFive.ahaSpeed, 120) && closeEnough(ahaFive.contributions[4].multiplier, 1 / 40),
    `${ahaFive.ahaSpeed}`,
  )
  const ahaAgain = await callTool(client, 'calc_aha', { speeds: ahaSpeeds })
  check('calc_aha deterministic (same input twice)', JSON.stringify(ahaAgain) === JSON.stringify(aha1))

  // 2.2 calc_ehr
  const ehr1 = await callTool(client, 'calc_ehr', { effectRes: 20, debuffRes: 0, baseChance: 100, attempts: 1, desiredHitRate: 100 })
  check(
    'calc_ehr exact: 20% res, 100% base, 1 attempt, want 100% → 25% EHR',
    ehr1.achievable === true && closeEnough(ehr1.requiredEhr, 25) && ehr1.attemptsUsed === 1,
    `requiredEhr=${ehr1.requiredEhr}`,
  )
  const ehrInputs = { effectRes: 0, debuffRes: 25, baseChance: 65, attempts: 2.4, desiredHitRate: 99 }
  const ehr2 = await callTool(client, 'calc_ehr', ehrInputs)
  check(
    'calc_ehr matches upstream formula incl. attempts rounding (2.4 → 2)',
    ehr2.attemptsUsed === 2 && closeEnough(ehr2.requiredEhr, mirrorRequiredEhr({ ...ehrInputs, attempts: 2 })),
    `${ehr2.requiredEhr} vs mirror ${mirrorRequiredEhr({ ...ehrInputs, attempts: 2 })}`,
  )
  const ehr3 = await callTool(client, 'calc_ehr', { ...ehrInputs, attempts: 2 })
  check('calc_ehr attempts=2.4 equals attempts=2', ehr3.requiredEhr === ehr2.requiredEhr)
  const ehr4 = await callTool(client, 'calc_ehr', { ...ehrInputs, attempts: 0.4 })
  check(
    'calc_ehr attempts=0.4 clamps to 1 attempt',
    ehr4.attemptsUsed === 1 && closeEnough(ehr4.requiredEhr, mirrorRequiredEhr({ ...ehrInputs, attempts: 1 })),
    `attemptsUsed=${ehr4.attemptsUsed}, ${ehr4.requiredEhr}`,
  )
  const ehrClamp = await callTool(client, 'calc_ehr', { effectRes: 20, debuffRes: 0, baseChance: 100, attempts: 1, desiredHitRate: 75 })
  check(
    'calc_ehr negative need clamps to 0 with note',
    ehrClamp.requiredEhr === 0 && ehrClamp.achievable === true && typeof ehrClamp.note === 'string',
    JSON.stringify(ehrClamp),
  )
  const ehrBlind = await callTool(client, 'calc_ehr', { effectRes: 0, debuffRes: 0, baseChance: 65, attempts: 1, desiredHitRate: 100, effectHitRate: 120 })
  check(
    'calc_ehr ignores effectHitRate (solver input only)',
    // ehr1 used effectRes: 20 (→25%); this call uses effectRes: 0 (→53.85%) —
    // the oracle is the mirror formula on THIS call's inputs, not ehr1's value.
    closeEnough(ehrBlind.requiredEhr, mirrorRequiredEhr({ effectRes: 0, debuffRes: 0, baseChance: 65, attempts: 1, desiredHitRate: 100 })),
    `${ehrBlind.requiredEhr}`,
  )
  const ehrBase0 = await callTool(client, 'calc_ehr', { effectRes: 20, debuffRes: 0, baseChance: 0, attempts: 1, desiredHitRate: 50 })
  check(
    'calc_ehr baseChance 0 → achievable=false, null not 0',
    ehrBase0.achievable === false && ehrBase0.requiredEhr === null && ehrBase0.reasons.some((r) => r.includes('基础概率')),
    JSON.stringify(ehrBase0.reasons),
  )
  const ehrRes100 = await callTool(client, 'calc_ehr', { effectRes: 20, debuffRes: 100, baseChance: 100, attempts: 1, desiredHitRate: 50 })
  check(
    'calc_ehr debuffRes 100% → achievable=false',
    ehrRes100.achievable === false && ehrRes100.requiredEhr === null,
  )
  const ehrBoth = await callTool(client, 'calc_ehr', { effectRes: 20, debuffRes: 100, baseChance: 0, attempts: 1, desiredHitRate: 50 })
  check('calc_ehr collects all blocking reasons (2)', ehrBoth.achievable === false && ehrBoth.reasons.length === 2, JSON.stringify(ehrBoth.reasons))
  const ehrAgain = await callTool(client, 'calc_ehr', { effectRes: 20, debuffRes: 0, baseChance: 100, attempts: 1, desiredHitRate: 100 })
  check('calc_ehr deterministic', JSON.stringify(ehrAgain) === JSON.stringify(ehr1))

  // 2.3 warp_plan — invalid income rejected loudly
  const badIncome = await toolError(client, 'warp_plan', { income: ['4.9_p1_1'] })
  check(
    'warp_plan rejects unknown income id with the legal table',
    badIncome != null && badIncome.includes('4.9_p1_1') && badIncome.includes('未知的收入选项') && badIncome.includes('4.5_p1_1'),
    String(badIncome).slice(0, 120),
  )
  const badTargetChar = await toolError(client, 'warp_plan', { targets: [{ characterId: '9999' }] })
  check(
    'warp_plan rejects unknown characterId in targets',
    badTargetChar != null && badTargetChar.includes('9999') && badTargetChar.includes('未知角色'),
    String(badTargetChar).slice(0, 120),
  )

  // 2.4 warp_plan budget arithmetic (enrichWarpRequest: floor(jades/160)+passes+income, starlight refund)
  const noSaveYet = await toolError(client, 'warp_plan', { fromSaved: true })
  check('warp_plan fromSave=true before load_save errors', noSaveYet != null && /load_save/.test(noSaveYet), String(noSaveYet).slice(0, 100))

  const budgetReq = { jades: 16000, passes: 5, income: ['4.5_p1_1', '4.6_p2_1'] } // +57+28 = +85
  const budget = await callTool(client, 'warp_plan', budgetReq) // starlight default REFUND_AVG
  // initial = 100 + 5 + 85 = 190; refund = floor(0.075×190) = 14 → 204
  check(
    'warp_plan budget math: 190 initial + 14 avg-refund = 204 warps',
    budget.totalWarps === 204 && budget.request.warps === 204 && budget.request.totalPasses === 90
      && budget.request.additionalPasses === 85 && budget.request.totalStarlight === 280,
    `warps=${budget.request.warps}, totalPasses=${budget.request.totalPasses}, additionalPasses=${budget.request.additionalPasses}, totalStarlight=${budget.request.totalStarlight}`,
  )
  const budgetNone = await callTool(client, 'warp_plan', { ...budgetReq, starlight: 'REFUND_NONE' })
  check('warp_plan REFUND_NONE → no refund (190)', budgetNone.totalWarps === 190 && budgetNone.request.totalStarlight === 0)
  check(
    'warp_plan incomeOptions surface current patch window (4.5/4.6) with source-true passes',
    budget.incomeOptions.length >= 12
      && budget.incomeOptions.some((o) => o.id === '4.5_p1_1' && o.passes === 57 && o.type === 'F2P' && o.version === '4.5' && o.phase === 1)
      && budget.incomeOptions.some((o) => o.id === '4.6_p2_1' && o.passes === 28),
    `${budget.incomeOptions.length} options`,
  )

  // 2.5 warp_plan hard-pity point masses: pity 89 char + pity 79 LC, both guaranteed → costs exactly 1+1
  const pityReq = {
    jades: 320, // 2 pulls, REFUND_NONE → budget 2
    starlight: 'REFUND_NONE',
    pityCharacter: 89,
    guaranteedCharacter: true,
    pityLightCone: 79,
    guaranteedLightCone: true,
    targets: [{ targetEidolonLevel: 0, targetSuperimpositionLevel: 1 }],
  }
  const pityRun = await callTool(client, 'warp_plan', pityReq)
  const pityTarget = pityRun.targetResults[0]
  check(
    'warp_plan hard pity: milestone costs are exactly 1 then 2 warps',
    pityRun.totalWarps === 2
      && pityTarget.milestoneResults['E0S0'] != null && closeEnough(pityTarget.milestoneResults['E0S0'].warps, 1)
      && pityTarget.milestoneResults['E0S1'] != null && closeEnough(pityTarget.milestoneResults['E0S1'].warps, 2),
    JSON.stringify(pityTarget.milestoneResults),
  )
  check(
    'warp_plan hard pity: both milestones hit within a 2-pull budget',
    closeEnough(pityTarget.milestoneResults['E0S0'].wins, 1) && closeEnough(pityTarget.milestoneResults['E0S1'].wins, 1),
  )
  const pityBroke = await callTool(client, 'warp_plan', { ...pityReq, jades: 0 })
  const brokeTarget = pityBroke.targetResults[0]
  check(
    'warp_plan zero budget: same expected warps, win probability 0',
    pityBroke.totalWarps === 0 && closeEnough(brokeTarget.milestoneResults['E0S0'].warps, 1)
      && closeEnough(brokeTarget.milestoneResults['E0S1'].warps, 2)
      && brokeTarget.milestoneResults['E0S0'].wins === 0 && brokeTarget.milestoneResults['E0S1'].wins === 0,
    JSON.stringify(brokeTarget.milestoneResults),
  )

  // 2.6 warp_plan full PMF engine parity — non-trivial case (strategy S1-last,
  // two targets sharing pity state) against the mirror over the real tables.
  const parityReq = {
    jades: 48000, // 300 pulls
    passes: 7,
    income: ['4.6_p1_1'], // +72 → 379 initial; REFUND_AVG floor(28.425)=28 → 407 budget
    starlight: 'REFUND_AVG',
    pityCharacter: 10,
    pityLightCone: 5,
    strategy: 3, // E3 → S1 pulled only after E3 (target only reaches E2, so S1 lands last)
    targets: [
      { id: 't1', characterId: '1212', targetEidolonLevel: 2, targetSuperimpositionLevel: 2 },
      { id: 't2', targetEidolonLevel: 0 }, // second target: character pool pity resets to 0
    ],
  }
  const parityRun = await callTool(client, 'warp_plan', parityReq)
  const mirrorRun = mirrorCalculateWarps({
    jades: parityReq.jades,
    passes: parityReq.passes,
    income: parityReq.income,
    starlight: 'REFUND_AVG',
    pityCharacter: 10,
    guaranteedCharacter: false,
    pityLightCone: 5,
    guaranteedLightCone: false,
    strategy: 3,
    targets: parityReq.targets,
  })
  check(
    'warp_plan budget parity with mirror (407 warps)',
    parityRun.totalWarps === mirrorRun.warps && parityRun.totalWarps === 407,
    `${parityRun.totalWarps} vs mirror ${mirrorRun.warps}`,
  )
  check('warp_plan returns one result per target', parityRun.targetResults.length === 2 && parityRun.targetResults[0].target.id === 't1')
  const parityLabels = parityRun.targetResults.flatMap((t) => t.milestones.map((m) => m.label))
  const mirrorLabels = mirrorRun.targets.flatMap((t) => t.milestoneOrder)
  check(
    'warp_plan milestone labels match mirror (strategy-3 path, incl. defaulted S5 on t2)',
    JSON.stringify(parityLabels) === JSON.stringify(mirrorLabels),
    `${parityLabels.join(',')} vs ${mirrorLabels.join(',')}`,
  )
  const allMilestonesMatch = parityRun.targetResults.every((t, i) =>
    t.milestones.every((m) => {
      const expected = mirrorRun.targets[i]?.milestoneResults[m.label]
      return expected != null && closeEnough(m.warps, expected.warps) && closeEnough(m.wins, expected.wins)
    })
  )
  check(
    'warp_plan every milestone {warps, wins} matches the mirror PMF engine',
    allMilestonesMatch,
    parityRun.targetResults.map((t, i) => t.milestones.map((m) => `${m.label}:${m.warps.toFixed(2)}/${m.wins.toFixed(4)}`).join(' ')).join(' | '),
  )
  const parityAgain = await callTool(client, 'warp_plan', parityReq)
  check('warp_plan deterministic (same input twice)', JSON.stringify(parityAgain) === JSON.stringify(parityRun))

  // ── 3. teams ───────────────────────────────────────────────────────────────
  const noSaveTeams = await toolError(client, 'list_teams', {})
  check('list_teams before load_save errors', noSaveTeams != null && /load_save/.test(noSaveTeams), String(noSaveTeams).slice(0, 100))

  // fixture save: sample + two pre-existing teams (one carrying a benchmarkSnapshot) + a persisted warpRequest
  const teamsSaveData = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
  teamsSaveData.savedSession = {
    global: {
      teamShowcaseSavedTeams: [
        {
          id: 'fixture-drop',
          name: 'Fixture Drop',
          characterIds: ['1105', '1005', null, null],
          benchmarkSnapshot: { members: [{ characterId: '1105', characterEidolon: 0, lightCone: '21007', lightConeSuperimposition: 1 }] },
        },
        {
          id: 'fixture-keep',
          name: 'Fixture Keep',
          characterIds: ['1102', null, null, null],
          benchmarkSnapshot: { members: [{ characterId: '1102', characterEidolon: 0, lightCone: '24001', lightConeSuperimposition: 1 }] },
        },
      ],
    },
  }
  teamsSaveData.warpRequest = { jades: 8000, passes: 20, income: ['4.6_p1_1'] }
  const teamsSavePath = `${tempDir}/teams-save.json`
  writeFileSync(teamsSavePath, JSON.stringify(teamsSaveData))
  const teamsLoaded = await callTool(client, 'load_save', { path: teamsSavePath })
  check('teams fixture save loaded (162 relics / 8 characters)', teamsLoaded.relics === 162 && teamsLoaded.characters === 8)

  const initialTeams = await callTool(client, 'list_teams', {})
  check(
    'list_teams returns both fixture teams with snapshot flags',
    initialTeams.total === 2
      && initialTeams.teams.some((t) => t.id === 'fixture-drop' && t.hasBenchmarkSnapshot === true && t.name === 'Fixture Drop')
      && initialTeams.teams.some((t) => t.id === 'fixture-keep' && t.hasBenchmarkSnapshot === true),
    JSON.stringify(initialTeams.teams.map((t) => `${t.id}:${t.hasBenchmarkSnapshot}`)),
  )
  const dropTeam = initialTeams.teams.find((t) => t.id === 'fixture-drop')
  check(
    'list_teams slot detail: characterIds padded to 4, roster membership correct',
    JSON.stringify(dropTeam.characterIds) === JSON.stringify(['1105', '1005', null, null])
      && dropTeam.slots[0].characterId === '1105' && dropTeam.slots[0].inRoster === true
      && dropTeam.slots[1].characterId === '1005' && dropTeam.slots[1].inRoster === true
      && dropTeam.slots[2] === null,
    JSON.stringify(dropTeam.slots.map((s) => s?.characterId ?? null)),
  )

  // 3.2 warp_plan fromSaved replays the request persisted inside the save
  const fromSaved = await callTool(client, 'warp_plan', { fromSaved: true })
  // 8000 jades → 50, +20 passes, +72 income = 142 initial; REFUND_AVG floor(10.65)=10 → 152
  check(
    'warp_plan fromSaved replays persisted warpRequest (142 initial + 10 refund = 152)',
    fromSaved.totalWarps === 152 && fromSaved.request.jades === 8000 && fromSaved.request.passes === 20
      && JSON.stringify(fromSaved.request.income) === JSON.stringify(['4.6_p1_1']),
    `warps=${fromSaved.request.warps}, jades=${fromSaved.request.jades}`,
  )
  const fromSavedOverride = await callTool(client, 'warp_plan', { fromSaved: true, passes: 0 })
  // 50 + 0 + 72 = 122 initial; refund floor(9.15)=9 → 131
  check(
    'warp_plan fromSaved fields override the base request',
    fromSavedOverride.totalWarps === 131 && fromSavedOverride.request.passes === 0 && fromSavedOverride.request.jades === 8000,
    `warps=${fromSavedOverride.request.warps}`,
  )

  // 3.3 save_team create with two characters (one not in roster)
  const createdTeam = await callTool(client, 'save_team', { name: '  Smoke Team  ', characterIds: ['1212', '1105'] })
  check(
    'save_team creates: name trimmed, ids null-padded, created=true',
    createdTeam.created === true && createdTeam.team.name === 'Smoke Team'
      && JSON.stringify(createdTeam.team.characterIds) === JSON.stringify(['1212', '1105', null, null])
      && typeof createdTeam.teamId === 'string' && createdTeam.teamId.length > 0
      && createdTeam.totalTeams === 3,
    JSON.stringify(createdTeam.team.characterIds),
  )
  const createdSlots = createdTeam.team.slots
  check(
    'save_team slot metadata: 1212 (base id, not in roster) vs 1105 (in roster)',
    createdSlots[0].characterId === '1212' && createdSlots[0].inRoster === false && typeof createdSlots[0].name === 'string'
      && createdSlots[1].characterId === '1105' && createdSlots[1].inRoster === true,
    JSON.stringify(createdSlots.map((s) => ({ id: s?.characterId, inRoster: s?.inRoster }))),
  )

  // 3.4 list round-trip
  const afterCreate = await callTool(client, 'list_teams', {})
  const roundTripped = afterCreate.teams.find((t) => t.id === createdTeam.teamId)
  check(
    'list_teams round-trips the saved team (name + ids)',
    afterCreate.total === 3 && roundTripped != null && roundTripped.name === 'Smoke Team'
      && JSON.stringify(roundTripped.characterIds) === JSON.stringify(['1212', '1105', null, null])
      && roundTripped.hasBenchmarkSnapshot === false,
  )

  // 3.5 update: rename only (slots untouched)
  const renamed = await callTool(client, 'save_team', { teamId: createdTeam.teamId, name: 'Smoke Team v2' })
  check(
    'save_team rename keeps slots',
    renamed.created === false && renamed.team.name === 'Smoke Team v2'
      && JSON.stringify(renamed.team.characterIds) === JSON.stringify(['1212', '1105', null, null]),
    JSON.stringify(renamed.team.characterIds),
  )

  // 3.6 snapshot rules: unchanged slots keep the snapshot, changed slots drop it
  const kept = await callTool(client, 'save_team', { teamId: 'fixture-keep', name: 'Fixture Keep Renamed' })
  check(
    'save_team name-only update keeps benchmarkSnapshot',
    kept.team.hasBenchmarkSnapshot === true && kept.team.benchmarkSnapshot?.members?.length === 1 && kept.team.name === 'Fixture Keep Renamed',
  )
  const dropped = await callTool(client, 'save_team', { teamId: 'fixture-drop', characterIds: ['1105', '1212'] })
  check(
    'save_team slot change drops benchmarkSnapshot (web load rule)',
    dropped.team.hasBenchmarkSnapshot === false && dropped.team.benchmarkSnapshot === null
      && JSON.stringify(dropped.team.characterIds) === JSON.stringify(['1105', '1212', null, null]),
  )

  // 3.7 semantic error paths
  const errUnknown = await toolError(client, 'save_team', { name: 'X', characterIds: ['9999'] })
  check('save_team rejects unknown character id', errUnknown != null && errUnknown.includes('未知角色'), String(errUnknown).slice(0, 100))
  const errDup = await toolError(client, 'save_team', { name: 'X', characterIds: ['1105', '1105'] })
  check('save_team rejects duplicate character in slots', errDup != null && errDup.includes('重复'), String(errDup).slice(0, 100))
  const errEmpty = await toolError(client, 'save_team', { name: 'X', characterIds: [null, null, null, null] })
  check('save_team rejects all-empty slots', errEmpty != null && errEmpty.includes('至少需要一个角色'), String(errEmpty).slice(0, 100))
  const errNoName = await toolError(client, 'save_team', { characterIds: ['1105'] })
  check('save_team create requires a name', errNoName != null && errNoName.includes('name'), String(errNoName).slice(0, 100))
  const errNoTeam = await toolError(client, 'save_team', { teamId: 'does-not-exist', name: 'X' })
  check('save_team rejects unknown teamId', errNoTeam != null && errNoTeam.includes('不存在'), String(errNoTeam).slice(0, 100))
  const errNothing = await toolError(client, 'save_team', { teamId: 'fixture-keep' })
  check('save_team update requires name or characterIds', errNothing != null && errNothing.includes('至少提供'), String(errNothing).slice(0, 100))

  // 3.8 persistence: debounced write-back puts the teams into the temp save file
  await sleep(1800) // markDirty debounce is 1000ms
  const persistedTeamsSave = JSON.parse(readFileSync(teamsSavePath, 'utf8'))
  const persistedTeams = persistedTeamsSave.savedSession?.global?.teamShowcaseSavedTeams ?? []
  check(
    'teams persisted into the loaded save file (3 teams, smoke team intact)',
    persistedTeams.length === 3
      && persistedTeams.some((t) => t.name === 'Smoke Team v2' && JSON.stringify(t.characterIds) === JSON.stringify(['1212', '1105', null, null]))
      && persistedTeams.some((t) => t.id === 'fixture-drop' && t.benchmarkSnapshot === undefined),
    `${persistedTeams.length} teams on disk: ${persistedTeams.map((t) => t.name).join(',')}`,
  )

  // 3.9 export → reload round-trip
  const teamsExportPath = `${tempDir}/teams-export.json`
  await callTool(client, 'export_save', { path: teamsExportPath })
  await callTool(client, 'load_save', { path: teamsExportPath })
  const reloadedTeams = await callTool(client, 'list_teams', {})
  check(
    'export → reload keeps all teams byte-identical (ids, names, slots, snapshots)',
    reloadedTeams.total === 3
      && reloadedTeams.teams.some((t) =>
        t.id === createdTeam.teamId && t.name === 'Smoke Team v2' && JSON.stringify(t.characterIds) === JSON.stringify(['1212', '1105', null, null])
      )
      && reloadedTeams.teams.some((t) => t.id === 'fixture-keep' && t.hasBenchmarkSnapshot === true)
      && reloadedTeams.teams.some((t) => t.id === 'fixture-drop' && t.hasBenchmarkSnapshot === false),
    JSON.stringify(reloadedTeams.teams.map((t) => `${t.id}:${t.name}:${t.hasBenchmarkSnapshot}`)),
  )

  // ── 4. sync bridge ─────────────────────────────────────────────────────────
  await callTool(client, 'load_save', { path: sampleSavePath })
  const sampleSave = JSON.parse(readFileSync(sampleSavePath, 'utf8'))

  const pushNotRunning = await toolError(client, 'sync_bridge_push', {})
  check('sync_bridge_push before start errors', pushNotRunning != null && pushNotRunning.includes('同步桥未启动'), String(pushNotRunning).slice(0, 80))
  const statusIdle = await callTool(client, 'sync_bridge_status', {})
  check(
    'sync_bridge_status idle: not running, save loaded',
    statusIdle.running === false && statusIdle.port === null && statusIdle.saveLoaded === true && statusIdle.relics === 162,
  )

  const port = randomPort()
  const bridgeUrl = `ws://127.0.0.1:${port}/ws`
  const started = await callTool(client, 'sync_bridge_start', { port })
  check(
    'sync_bridge_start on a random high port',
    started.running === true && started.alreadyRunning === false && started.port === port && started.url === bridgeUrl && started.relics === 162
      && started.characters === 8,
    JSON.stringify({ port: started.port, url: started.url }),
  )
  // (randomPort() itself excludes 23313 via its retry loop — nothing to assert here.)
  const restartSame = await callTool(client, 'sync_bridge_start', { port })
  check('sync_bridge_start same port is idempotent', restartSame.alreadyRunning === true && restartSame.port === port)

  // connect a client → InitialScan must arrive immediately (no handshake)
  const collector = await connectCollector(bridgeUrl)
  try {
    const first = await waitForFrame(collector.messages, (m) => m.frame?.event === 'InitialScan', 15000, 'InitialScan on connect')
    const scan1 = first.frame.data
    check('InitialScan arrives on connect without any handshake', first.frame.event === 'InitialScan' && scan1 != null)

    // — frame shape: strictly per implementation + recon Q8 —
    check(
      'frame identity: source=reliquary_archiver, version=4, build=v0.8.0',
      scan1.source === 'reliquary_archiver' && scan1.version === 4 && scan1.build === 'v0.8.0',
      JSON.stringify({ source: scan1.source, version: scan1.version, build: scan1.build }),
    )
    check(
      'frame metadata/gacha/materials placeholders',
      scan1.metadata.uid === 0 && scan1.metadata.trailblazer === 'Stelle'
        && scan1.gacha.stellar_jade === 0 && scan1.gacha.oneric_shards === 0 && Array.isArray(scan1.materials) && scan1.materials.length === 0,
    )

    // characters: full save roster, buffed ids stripped + ability_version set
    const frameCharIds = scan1.characters.map((c) => c.id)
    const expectedCharIds = sampleSave.characters.map((c) => c.id.replace(/b\d+$/, ''))
    check(
      'frame characters = roster with buffed ids stripped (8)',
      scan1.characters.length === 8 && JSON.stringify([...frameCharIds].sort()) === JSON.stringify([...expectedCharIds].sort()),
      `${frameCharIds.join(',')} vs ${expectedCharIds.join(',')}`,
    )
    const charKeysOk = scan1.characters.every((c) =>
      JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['ability_version', 'ascension', 'eidolon', 'id', 'level', 'name', 'path'])
    )
    check('frame characters carry exactly {id,name,path,level,ascension,eidolon,ability_version}', charKeysOk)
    const jingliu = scan1.characters.find((c) => c.id === '1212')
    const natasha = scan1.characters.find((c) => c.id === '1105')
    check(
      'frame character levels/eidolons from the save; buffed char gets ability_version=1',
      jingliu != null && jingliu.ability_version === 1 && jingliu.level === 80 && jingliu.eidolon === 1
        && natasha != null && natasha.ability_version === 0 && natasha.eidolon === 6,
      JSON.stringify({
        jingliu: jingliu && { av: jingliu.ability_version, e: jingliu.eidolon },
        natasha: natasha && { av: natasha.ability_version, e: natasha.eidolon },
      }),
    )

    // light cones: every one located at its (stripped) character id
    check(
      'frame light_cones: 8, lock=false, located at stripped character ids',
      scan1.light_cones.length === 8
        && scan1.light_cones.every((lc) => lc.lock === false && frameCharIds.includes(lc.location) && typeof lc._uid === 'string')
        && scan1.light_cones.some((lc) => lc.location === '1212' && lc.id === '23014' && lc._uid === '1212-lc'),
      scan1.light_cones.map((lc) => `${lc.id}@${lc.location}`).join(','),
    )

    // relics: value-zip against the save file (store order is load order)
    const frameRelics = scan1.relics
    check('frame relics count = 162', frameRelics.length === 162, String(frameRelics.length))
    const relicKeysExact = frameRelics.every((r) =>
      JSON.stringify(Object.keys(r).sort())
        === JSON.stringify(['_uid', 'discard', 'level', 'location', 'lock', 'mainstat', 'name', 'rarity', 'set_id', 'slot', 'substats'])
    )
    check('frame relics carry exactly the 11 scanner keys', relicKeysExact)
    const uids = new Set(frameRelics.map((r) => r._uid))
    check('frame relic _uids unique', uids.size === 162 && frameRelics.every((r) => /^\d+$/.test(r._uid)))

    let zipMismatch = null
    let substatBoundsOk = true
    for (let i = 0; i < frameRelics.length; i++) {
      const f = frameRelics[i]
      const s = sampleSave.relics[i]
      const locationOk = f.location === (s.equippedBy ?? '')
      const identityOk = f.slot === s.part && f.rarity === s.grade && f.level === s.enhance && f.name === s.set && f.set_id === relicSetNameToId.get(s.set)
      const expectedMain = s.part === 'Head' || s.part === 'Hands' ? s.main.stat : MAINSTAT_TO_SCANNER_KEY[s.main.stat]
      const mainOk = f.mainstat === expectedMain
      const subCountOk = f.substats.length === s.substats.length
      let subOk = subCountOk
      if (subCountOk) {
        for (let j = 0; j < f.substats.length; j++) {
          const fs = f.substats[j]
          const ss = s.substats[j]
          const keyOk = fs.key === SUBSTAT_TO_SCANNER_KEY[ss.stat]
          // The store normalizes loaded substat values through augment() →
          // precisionRound(value, 5) (relicAugmenter.ts:39, mathUtils.ts); the
          // frame carries store values, so mirror that rounding here.
          const expectedValue = Math.round(ss.value * 1e5) / 1e5
          const valueOk = Math.abs(fs.value - expectedValue) <= 1e-9
          const subKeys = JSON.stringify(Object.keys(fs).sort()) === JSON.stringify(['count', 'key', 'step', 'value'])
          const maxCount = Math.max(1, f.rarity * 2 - 4)
          const boundsOk = Number.isInteger(fs.count) && fs.count >= 1 && fs.count <= maxCount && Number.isInteger(fs.step) && fs.step >= 0
            && fs.step <= 2 * fs.count
          if (!boundsOk) substatBoundsOk = false
          if (!keyOk || !valueOk || !subKeys || !boundsOk) {
            subOk = false
            zipMismatch = zipMismatch ?? `relic[${i}].substats[${j}] ${ss.stat}→${fs.key} value ${ss.value}→${fs.value}`
            break
          }
        }
      }
      if (!locationOk || !identityOk || !mainOk || !subOk) {
        zipMismatch = zipMismatch
          ?? `relic[${i}] ${s.id}: slot ${f.slot}/${s.part} rarity ${f.rarity}/${s.grade} level ${f.level}/${s.enhance} main ${f.mainstat}/${expectedMain} set ${f.set_id}/${
            relicSetNameToId.get(s.set)
          } loc ${f.location}/${s.equippedBy ?? ''} sub ${subOk}`
        break
      }
    }
    check(
      'frame relic values zip-identical to the save (slot/rarity/level/set/mainstat/location/substats)',
      zipMismatch == null,
      String(zipMismatch).slice(0, 200),
    )
    check(
      'frame substat count/step within parser bounds (0 < count ≤ rarity·2−4, 0 ≤ step ≤ 2·count)',
      substatBoundsOk,
    )
    const equipped1212b1 = frameRelics.filter((r) => r.location === '1212b1').length
    check('frame keeps full buffed id on relic location (1212b1 → 6 relics, matches game data)', equipped1212b1 === 6, String(equipped1212b1))

    // — fidelity: feed the frame back through the real upstream parser (dryRun) —
    const dryRun = await callTool(client, 'import_scanner_json', { inline: scan1, source: 'reliquary', dryRun: true, merge: 'union' })
    check(
      'frame parses as genuine reliquary_archiver v4 (upstream parser, dryRun)',
      dryRun.dryRun === true && dryRun.imported === false && dryRun.metadata.source === 'reliquary_archiver'
        && dryRun.metadata.scanner === 'Reliquary Archiver',
      JSON.stringify(dryRun.metadata),
    )
    check(
      'frame hash-matches the entire inventory: 0 added / 0 removed / 162 kept',
      dryRun.added === 0 && dryRun.removed === 0 && dryRun.totalBefore === 162 && dryRun.totalAfter === 162 && dryRun.updated + dryRun.skipped === 162,
      JSON.stringify({
        added: dryRun.added,
        updated: dryRun.updated,
        skipped: dryRun.skipped,
        removed: dryRun.removed,
        totalBefore: dryRun.totalBefore,
        totalAfter: dryRun.totalAfter,
      }),
    )
    check(
      'frame triggers no parser warnings (roll info valid, build not outdated)',
      Array.isArray(dryRun.warnings) && dryRun.warnings.length === 0,
      dryRun.warnings.join(' | ').slice(0, 160),
    )

    // — explicit push re-broadcasts the full frame —
    const scansBeforePush = collector.messages.filter((m) => m.frame?.event === 'InitialScan').length
    const pushed = await callTool(client, 'sync_bridge_push', {})
    const second = await waitForFrame(
      collector.messages,
      (m) => m.frame?.event === 'InitialScan' && m.index > first.index,
      15000,
      'InitialScan after sync_bridge_push',
    )
    check(
      'sync_bridge_push re-broadcasts the full frame to the connected client',
      pushed.pushed === true && pushed.clients === 1 && pushed.sent === 1 && pushed.relics === 162 && pushed.bytes > 0
        && collector.messages.filter((m) => m.frame?.event === 'InitialScan').length === scansBeforePush + 1,
      JSON.stringify({ clients: pushed.clients, sent: pushed.sent, bytes: pushed.bytes }),
    )
    const uidSetsEqual = second.frame.data.relics.every((r) => uids.has(r._uid)) && second.frame.data.relics.length === 162
    check('re-pushed frame keeps stable _uid set', uidSetsEqual)
    const statusLive = await callTool(client, 'sync_bridge_status', {})
    check(
      'sync_bridge_status live: running, 1 client, push counters',
      statusLive.running === true && statusLive.port === port && statusLive.clients === 1 && statusLive.pushes >= 2
        && statusLive.lastPushBytes === pushed.bytes,
      JSON.stringify({ clients: statusLive.clients, pushes: statusLive.pushes, lastPushBytes: statusLive.lastPushBytes }),
    )

    // — mutation-driven re-push through the flushSave hook (context.ts) —
    const scansBeforeMutation = collector.messages.filter((m) => m.frame?.event === 'InitialScan').length
    const unequipped = await callTool(client, 'unequip_character', { characterId: '1101' })
    const mutationScan = await waitForFrame(
      collector.messages,
      (m) =>
        m.frame?.event === 'InitialScan'
        && collector.messages.filter((x, k) => k <= m.index && x.frame?.event === 'InitialScan').length === scansBeforeMutation + 1,
      15000,
      'InitialScan after unequip flush',
    )
    const freedRelics = mutationScan.frame.data.relics.filter((r) => r.location === '' && frameRelics.find((f) => f._uid === r._uid)?.location === '1101')
    check(
      'unequip → debounced flushSave → automatic re-push (flushSave hook wired)',
      unequipped.clearedSlots === 4 && mutationScan.frame.data.relics.filter((r) => r.location === '1101').length === 0 && freedRelics.length === 4,
      `cleared ${unequipped.clearedSlots}, freed in frame ${freedRelics.length}`,
    )

    // — DeleteRelics diff: replace-import without one relic shrinks the inventory —
    const removedUid = frameRelics[161]._uid
    const scanMinusOne = JSON.parse(JSON.stringify(scan1))
    scanMinusOne.relics = scanMinusOne.relics.filter((r) => r._uid !== removedUid)
    const replaced = await callTool(client, 'import_scanner_json', { inline: scanMinusOne, source: 'reliquary', merge: 'replace' })
    const deleteFrame = await waitForFrame(collector.messages, (m) => m.frame?.event === 'DeleteRelics', 15000, 'DeleteRelics after shrinking import')
    const scanAfterDelete = await waitForFrame(
      collector.messages,
      (m) => m.frame?.event === 'InitialScan' && m.index > deleteFrame.index,
      15000,
      'InitialScan following DeleteRelics',
    )
    check(
      'shrinking import → DeleteRelics frame carries exactly the removed _uid',
      Array.isArray(deleteFrame.frame.data) && deleteFrame.frame.data.length === 1 && deleteFrame.frame.data[0] === removedUid,
      JSON.stringify(deleteFrame.frame.data),
    )
    check(
      'DeleteRelics is followed by a 161-relic InitialScan without the removed uid',
      replaced.imported === true && replaced.totalAfter === 161 && scanAfterDelete.frame.data.relics.length === 161
        && !scanAfterDelete.frame.data.relics.some((r) => r._uid === removedUid)
        && scanAfterDelete.frame.data.relics.every((r) => r._uid === removedUid || uids.has(r._uid)),
      `${scanAfterDelete.frame.data.relics.length} relics`,
    )

    // — reconnect: fresh connection immediately gets the current full state —
    const reconnect = await connectCollector(bridgeUrl)
    try {
      const reconnectScan = await waitForFrame(reconnect.messages, (m) => m.frame?.event === 'InitialScan', 15000, 'InitialScan on reconnect')
      check(
        'reconnect immediately re-receives the full current state (161 relics)',
        reconnect.messages[0].index === 0 && reconnectScan.frame.data.relics.length === 161 && reconnectScan.frame.data.source === 'reliquary_archiver',
      )
    } finally {
      reconnect.ws.close()
    }

    // — stop releases the port —
    const stopped = await callTool(client, 'sync_bridge_stop', {})
    const refusal = await portRefused(bridgeUrl)
    check(
      'sync_bridge_stop closes the listener — reconnect refused (ECONNREFUSED)',
      stopped.stopped === true && stopped.wasRunning === true && stopped.running === false && refusal.refused,
      refusal.refused ? `code ${refusal.code}` : refusal.reason,
    )
    const statusStopped = await callTool(client, 'sync_bridge_status', {})
    check('sync_bridge_status after stop: not running', statusStopped.running === false && statusStopped.port === null)
    const pushAfterStop = await toolError(client, 'sync_bridge_push', {})
    check('sync_bridge_push after stop errors again', pushAfterStop != null && pushAfterStop.includes('同步桥未启动'))
    const stoppedAgain = await callTool(client, 'sync_bridge_stop', {})
    check('sync_bridge_stop is idempotent (wasRunning=false)', stoppedAgain.stopped === true && stoppedAgain.wasRunning === false)

    // — restart path: fresh start, then port switch while running —
    const port2 = randomPort()
    const started2 = await callTool(client, 'sync_bridge_start', { port: port2 })
    check('sync_bridge_start works again after stop (fresh)', started2.running === true && started2.alreadyRunning === false && started2.port === port2)
    const port3 = randomPort()
    const started3 = await callTool(client, 'sync_bridge_start', { port: port3 })
    check('sync_bridge_start on a different port restarts the listener', started3.running === true && started3.restarted === true && started3.port === port3)
    const finalStop = await callTool(client, 'sync_bridge_stop', {})
    const refusal3 = await portRefused(`ws://127.0.0.1:${port3}/ws`)
    check('final stop releases the switched port too', finalStop.wasRunning === true && refusal3.refused)

    // ── 4b. full sync bridge — M8 tool surface only ──────────────────────────
    // Protocol-level behavior (hello/welcome/snapshot/ops/conflicts/resync) is
    // exercised end-to-end by scripts/smoke-m8.mjs (task D) against the real
    // web client; here we only pin the tool registration surface: the
    // bidirectional listener lifecycle, its status section, coexistence with
    // the one-way bridge, and stop-all semantics.
    const fsPort = randomPort()
    const fsUrl = `ws://127.0.0.1:${fsPort}/sync`
    const fsStarted = await callTool(client, 'sync_bridge_start', { port: fsPort, bidirectional: true })
    check(
      'sync_bridge_start bidirectional starts the full sync server',
      // 161 relics: the shrinking import earlier in this section dropped one
      // from the sample save's 162
      fsStarted.running === true && fsStarted.alreadyRunning === false && fsStarted.bidirectional === true
        && fsStarted.port === fsPort && fsStarted.url === fsUrl && fsStarted.clients === 0
        && fsStarted.relics === 161 && fsStarted.characters === 8,
      JSON.stringify({ port: fsStarted.port, url: fsStarted.url, relics: fsStarted.relics, characters: fsStarted.characters }),
    )
    check(
      'bidirectional start reports the one-way bridge as not running',
      fsStarted.archiver != null && fsStarted.archiver.running === false && fsStarted.archiver.port === null,
      JSON.stringify(fsStarted.archiver),
    )
    const fsAgain = await callTool(client, 'sync_bridge_start', { port: fsPort, bidirectional: true })
    check(
      'sync_bridge_start bidirectional same port is idempotent',
      fsAgain.alreadyRunning === true && fsAgain.bidirectional === true && fsAgain.port === fsPort,
    )
    const fsStatus = await callTool(client, 'sync_bridge_status', {})
    check(
      'sync_bridge_status carries a live fullSync section',
      fsStatus.fullSync != null && fsStatus.fullSync.running === true && fsStatus.fullSync.port === fsPort
        && fsStatus.fullSync.url === fsUrl && fsStatus.fullSync.sessions === 0
        && Number.isInteger(fsStatus.fullSync.revision) && fsStatus.fullSync.revision >= 1
        && Number.isInteger(fsStatus.fullSync.saveGeneration) && fsStatus.fullSync.saveGeneration >= 1
        && fsStatus.fullSync.bufferedOps === 0,
      JSON.stringify(fsStatus.fullSync),
    )
    check(
      'sync_bridge_status one-way section unchanged while full sync runs',
      fsStatus.running === false && fsStatus.port === null && fsStatus.saveLoaded === true,
    )
    const fsPort2 = randomPort()
    const fsRestarted = await callTool(client, 'sync_bridge_start', { port: fsPort2, bidirectional: true })
    check(
      'sync_bridge_start bidirectional on a different port restarts the full sync server',
      fsRestarted.running === true && fsRestarted.restarted === true && fsRestarted.bidirectional === true && fsRestarted.port === fsPort2,
    )
    const fsRefused = await portRefused(fsUrl)
    check('switching the full sync port releases the old listener', fsRefused.refused, fsRefused.refused ? `code ${fsRefused.code}` : fsRefused.reason)

    // coexistence: the one-way archiver bridge runs on its own port next to the
    // full sync server, and its start result keeps the original shape (no
    // bidirectional marker)
    const port4 = randomPort()
    const started4 = await callTool(client, 'sync_bridge_start', { port: port4 })
    check(
      'one-way bridge starts in parallel with the full sync server (original shape)',
      started4.running === true && started4.alreadyRunning === false && started4.port === port4
        && started4.url === `ws://127.0.0.1:${port4}/ws` && started4.bidirectional === undefined,
    )
    const dualStatus = await callTool(client, 'sync_bridge_status', {})
    check(
      'status shows both bridges live',
      dualStatus.running === true && dualStatus.port === port4 && dualStatus.fullSync.running === true && dualStatus.fullSync.port === fsPort2,
    )
    const stopAll = await callTool(client, 'sync_bridge_stop', {})
    const fsRefused2 = await portRefused(`ws://127.0.0.1:${fsPort2}/sync`)
    const archRefused = await portRefused(`ws://127.0.0.1:${port4}/ws`)
    check(
      'sync_bridge_stop stops both bridges and releases both ports',
      stopAll.stopped === true && stopAll.wasRunning === true
        && stopAll.fullSyncStopped === true && stopAll.fullSyncWasRunning === true
        && fsRefused2.refused && archRefused.refused,
      `fullSync ${fsRefused2.refused ? 'refused' : fsRefused2.reason}; archiver ${archRefused.refused ? 'refused' : archRefused.reason}`,
    )
    const idleStatus = await callTool(client, 'sync_bridge_status', {})
    check(
      'status idle again after stop-all (both sections down)',
      idleStatus.running === false && idleStatus.port === null && idleStatus.fullSync.running === false && idleStatus.fullSync.port === null,
    )
  } finally {
    try {
      collector.ws.close()
    } catch { /* already closed */ }
  }
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nsmoke-misc: ALL CHECKS PASSED (${assertions} assertions)` : `\nsmoke-misc: ${failures} OF ${assertions} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
