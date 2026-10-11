// Single-team audit composed from existing MCP tools in ONE server session:
// permutations → auto-tighten → optimize → dps_score → zero-cost swaps → fingerprint.
// Script-stage prototype of the team_audit tool (mcp/docs/03-增量更新设计.md §4.1).
// Read-only: the save is copied into a temporary state file per run and never written.
// Usage: node scripts/team-audit.mjs --character <id> [--teammates a,b,c] [options]
//   --teammates <spec,…>       up to 3 teammates; spec = id[:eN][:lc<lightConeId>][:sN],
//                              missing parts fall back to that character's saved form
//   --light-cone <id>          core light cone, only for characters saved without one
//   --eidolon <n> --superimposition <n>   used together with --light-cone
//   --form-overrides <file>    extra formOverrides (JSON), applied last
//   --no-auto-tighten          run with the base overrides as-is
//   --results-limit <n>        rows to keep (default 50)
//   --enhance-floor <n>        relic enhance floor (default 0)
//   --target-permutations <n>  auto-tighten target (default 2e7)
//   --save <file>              save file, relative to mcp/ (default profile/fribbels-optimizer-save.json)
//   --server <entry>           server entry, relative to mcp/ (default dist/index.js)
//   --out <file>               write the JSON result here instead of stdout
//   --engine <name>            auto (default, CPU) | cpu | gpu | gpu-experimental; the GPU engines
//                              run in the managed browser and return display rows only, so the
//                              audit reports COMBO and the CPU cross-check but skips the swaps
//   --verbose                  forward server stderr
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))

const RELIC_PARTS = ['Head', 'Hands', 'Body', 'Feet']
const ORNAMENT_PARTS = ['PlanarSphere', 'LinkRope']
const PARTS = [...RELIC_PARTS, ...ORNAMENT_PARTS]
const MAIN_FILTER_PARTS = ['Body', 'Feet', 'PlanarSphere', 'LinkRope']
// Internal aliases are applied after their display-format equivalents and win,
// so a whole internal form passed as formOverrides shadows display keys.
const INTERNAL_SET_ALIASES = ['relicSets', 'ornamentSets']
const INTERNAL_TEAMMATE_ALIASES = ['teammate0', 'teammate1', 'teammate2']
// Below this the search space is too thin to beat the equipped build.
const PERMUTATION_FLOOR = 1e5
// The web slider for weights.minWeightedRolls: 0..5 in 0.5 steps.
const MIN_WEIGHTED_ROLLS_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]
const CALL_TIMEOUT_MS = 30 * 60 * 1000
const RELIC_PAGE_SIZE = 500

function log(...parts) {
  process.stderr.write(`[team-audit] ${parts.join(' ')}\n`)
}

function parseArgs(argv) {
  const args = {
    autoTighten: true,
    resultsLimit: 50,
    enhanceFloor: 0,
    targetPermutations: 2e7,
    save: 'profile/fribbels-optimizer-save.json',
    server: 'dist/index.js',
    verbose: false,
  }
  const numeric = (flag, value) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} 需要非负数值,实际 ${value}`)
    return parsed
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} 缺少取值`)
      return argv[++i]
    }
    switch (flag) {
      case '--character':
        args.character = value()
        break
      case '--teammates':
        args.teammates = value()
        break
      case '--light-cone':
        args.lightCone = value()
        break
      case '--eidolon':
        args.eidolon = numeric(flag, value())
        break
      case '--superimposition':
        args.superimposition = numeric(flag, value())
        break
      case '--form-overrides':
        args.formOverrides = value()
        break
      case '--no-auto-tighten':
        args.autoTighten = false
        break
      case '--results-limit':
        args.resultsLimit = numeric(flag, value())
        break
      case '--enhance-floor':
        args.enhanceFloor = numeric(flag, value())
        break
      case '--target-permutations':
        args.targetPermutations = numeric(flag, value())
        break
      case '--save':
        args.save = value()
        break
      case '--server':
        args.server = value()
        break
      case '--out':
        args.out = value()
        break
      case '--engine':
        args.engine = value()
        break
      case '--verbose':
        args.verbose = true
        break
      default:
        throw new Error(`未知参数 ${flag}(用法见脚本头部注释)`)
    }
  }
  if (!args.character) throw new Error('缺少 --character <角色 id>')
  return args
}

// spec = id[:eN][:lc<lightConeId>][:sN]
function parseTeammateSpec(spec) {
  const [characterId, ...rest] = spec.split(':')
  const teammate = { characterId }
  for (const token of rest) {
    const eidolon = /^e(\d)$/i.exec(token)
    const superimposition = /^s(\d)$/i.exec(token)
    const lightCone = /^lc(\w+)$/i.exec(token)
    if (eidolon) teammate.characterEidolon = Number(eidolon[1])
    else if (superimposition) teammate.lightConeSuperimposition = Number(superimposition[1])
    else if (lightCone) teammate.lightCone = lightCone[1]
    else throw new Error(`队友写法 "${spec}" 中无法识别 "${token}"(格式 id[:eN][:lc<光锥id>][:sN])`)
  }
  return teammate
}

// A whole-form base carries flat min/max aliases that would shadow the caller's
// display-format stat and rating filters; drop the ones being overridden.
function dropShadowedFilterAliases(base, display) {
  for (const group of ['statFilters', 'ratingFilters']) {
    for (const key of Object.keys(display[group] ?? {})) delete base[key]
  }
}

function countBy(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

// Sets the character is wearing right now, in setFilters terms, so a lock keeps
// a 4pc or 2+2 equipped build selectable. Other layouts (2pc + loose pieces,
// split ornaments) cannot be expressed and may fall outside the search.
function equippedSets(equippedSlots) {
  const setOf = (part) => equippedSlots?.[part]?.relic?.set
  const pairs = [...countBy(RELIC_PARTS.map(setOf).filter(Boolean))]
    .filter(([, count]) => count >= 2)
  const ornaments = ORNAMENT_PARTS.map(setOf)
  return {
    fourPiece: pairs.filter(([, count]) => count === 4).map(([set]) => set),
    twoPieceCombos: pairs.length === 2 ? [[pairs[0][0], pairs[1][0]]] : [],
    ornaments: ornaments[0] && ornaments[0] === ornaments[1] ? [ornaments[0]] : [],
  }
}

const comboKey = ([a, b]) => [a, b].sort().join('\u0000')

// Independent tightening knobs derived from scoring metadata. A knob only exists
// where the effective form has no filter of its own and the caller set none.
function buildKnobs({ form, scoring, equipped, userOverrides }) {
  const knobs = []
  const simulation = scoring.simulations?.dps ?? Object.values(scoring.simulations ?? {})[0]
  const userSet = (key) => Object.hasOwn(userOverrides, key)

  const mains = {}
  for (const part of MAIN_FILTER_PARTS) {
    const key = `main${part}`
    const candidates = scoring.parts?.[part] ?? []
    if (!userSet(key) && !(form[key]?.length) && candidates.length) mains[key] = candidates
  }
  if (Object.keys(mains).length) knobs.push({ name: 'mains', overrides: mains })

  const formSets = form.setFilters ?? {}
  const setsFree = !userSet('setFilters') && !INTERNAL_SET_ALIASES.some(userSet)
  const current = equippedSets(equipped)

  const ornaments = [...new Set([...(simulation?.ornamentSets ?? []), ...current.ornaments])]
  if (setsFree && !(formSets.ornaments?.length) && !(form.ornamentSets?.length) && simulation?.ornamentSets?.length) {
    knobs.push({ name: 'ornaments', setFilters: { ornaments } })
  }

  const pairs = (simulation?.relicSets ?? []).filter((entry) => entry.length === 2)
  const fourPiece = [...new Set([...pairs.filter(([a, b]) => a === b).map(([a]) => a), ...current.fourPiece])]
  const combos = new Map()
  for (const pair of [...pairs.filter(([a, b]) => a !== b), ...current.twoPieceCombos]) combos.set(comboKey(pair), pair)
  const formRelicsFree = !(formSets.fourPiece?.length) && !(formSets.twoPieceCombos?.length) && !(form.relicSets?.length)
  if (setsFree && formRelicsFree && pairs.length) {
    knobs.push({
      name: 'relicSets',
      setFilters: {
        fourPiece,
        twoPieceCombos: [...combos.values()].map(([a, b]) => ({ a: { type: 'Set', value: a }, b: { type: 'Set', value: b } })),
      },
    })
  }
  return knobs
}

// Sends setFilters as one complete object: the form's own filters plus the
// knobs', so the result does not depend on how the server merges partial ones.
function applyKnobs({ base, formSetFilters }, knobs, minWeightedRolls) {
  const overrides = structuredClone(base)
  const setFilters = {}
  for (const knob of knobs) {
    Object.assign(overrides, knob.overrides)
    Object.assign(setFilters, knob.setFilters)
  }
  if (Object.keys(setFilters).length) overrides.setFilters = { ...formSetFilters, ...setFilters }
  if (minWeightedRolls != null) overrides.weights = { ...overrides.weights, minWeightedRolls }
  return overrides
}

function subsetsOf(items) {
  const subsets = []
  for (let mask = 0; mask < (1 << items.length); mask++) {
    subsets.push(items.filter((_, index) => mask & (1 << index)))
  }
  return subsets
}

// Picks the least restrictive overrides whose search space fits the target.
// Every evaluated candidate is recorded so the trajectory is reproducible.
async function tighten({ base, formSetFilters, knobs, target, currentMinWeightedRolls, estimate }) {
  const steps = []
  let gate = null
  const evaluate = async (subset, minWeightedRolls = null) => {
    const overrides = applyKnobs({ base, formSetFilters }, subset, minWeightedRolls)
    const estimated = await estimate(overrides)
    gate = estimated.gate.gate
    const step = { knobs: subset.map((knob) => knob.name), minWeightedRolls, permutations: estimated.validPermutations, overrides }
    steps.push(step)
    return step
  }
  const widest = (candidates) =>
    candidates.reduce((best, step) => (
      step.permutations > best.permutations || (step.permutations === best.permutations && step.knobs.length < best.knobs.length) ? step : best
    ))
  const done = (chosen, warning) => ({ chosen, steps, gate, warning })
  const thinWarning = (step) => `只能收紧到 ${step.permutations} 排列(低于 ${PERMUTATION_FLOOR}),结果可能搜不到优于现装的解`

  const initial = await evaluate([])
  if (initial.permutations <= target) return done(initial)

  const candidates = [initial]
  for (const subset of subsetsOf(knobs).slice(1)) candidates.push(await evaluate(subset))

  const fitting = candidates.filter((step) => step.permutations >= PERMUTATION_FLOOR && step.permutations <= target)
  if (fitting.length) return done(widest(fitting))

  // Nothing lands in the band: take the smallest space still above the target
  // and raise the weighted-roll floor until it fits.
  const above = candidates.filter((step) => step.permutations > target)
  const smallestAbove = above.reduce((best, step) => (step.permutations < best.permutations ? step : best))
  const subset = knobs.filter((knob) => smallestAbove.knobs.includes(knob.name))
  const floors = MIN_WEIGHTED_ROLLS_STEPS.filter((value) => value > currentMinWeightedRolls)
  let found = null
  for (let low = 0, high = floors.length - 1; low <= high;) {
    const middle = (low + high) >> 1
    const step = await evaluate(subset, floors[middle])
    if (step.permutations <= target) {
      found = step
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  if (found && found.permutations >= PERMUTATION_FLOOR) return done(found)

  // A slow but complete search beats a thin one.
  if (smallestAbove.permutations <= gate) {
    return done(smallestAbove, `未能收紧到 ${target.toExponential(0)} 以内,按 ${smallestAbove.permutations.toExponential(2)} 排列在闸门内直接搜索(较慢)`)
  }
  if (found && found.permutations > 0) return done(found, thinWarning(found))
  const thin = candidates.filter((step) => step.permutations > 0 && step.permutations < PERMUTATION_FLOOR)
  if (thin.length) {
    const chosen = widest(thin)
    return done(chosen, thinWarning(chosen))
  }
  return done(null)
}

// Relics that can take part in this audit: the candidate pool before the
// engine's ownership filters, plus whatever the character wears (the equipped
// baseline ignores the filters). A change here means the audit may be stale.
// Where a lock cannot be derived the pool is left wide: over-reporting a change
// is harmless, missing one is not.
function fingerprintInventory(relics, { characterId, form, overrides }) {
  const effective = { ...form, ...overrides }
  const setFilters = { ...form.setFilters, ...overrides.setFilters }
  const fourPiece = setFilters.fourPiece ?? []
  const lockedRelicSets = !Object.hasOwn(overrides, 'relicSets') && fourPiece.length && !(setFilters.twoPieceCombos?.length)
    ? fourPiece
    : null
  const lockedOrnaments = !Object.hasOwn(overrides, 'ornamentSets') && setFilters.ornaments?.length ? setFilters.ornaments : null
  const mains = Object.fromEntries(MAIN_FILTER_PARTS.map((part) => [part, effective[`main${part}`] ?? []]))
  const scope = {
    enhanceFloor: effective.enhance ?? 0,
    grade: effective.grade ?? 0,
    relicSets: lockedRelicSets,
    ornaments: lockedOrnaments,
    mains,
  }

  const pool = relics.filter((relic) => {
    if (relic.equippedBy === characterId) return true
    if (relic.enhance < scope.enhanceFloor || (relic.grade && relic.grade < scope.grade)) return false
    const locked = RELIC_PARTS.includes(relic.part) ? lockedRelicSets : lockedOrnaments
    if (locked && !locked.includes(relic.set)) return false
    const allowed = mains[relic.part]
    return !allowed?.length || allowed.includes(relic.main.stat)
  })
  const rows = pool
    .map((relic) => [
      relic.id,
      relic.part,
      relic.set,
      relic.grade,
      relic.enhance,
      relic.main.stat,
      relic.main.value,
      relic.substats.map((substat) => [substat.stat, substat.value]),
      // Unrevealed substats count: the engine merges them into the search.
      (relic.previewSubstats ?? []).map((substat) => [substat.stat, substat.value]),
      relic.equippedBy ?? null,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return {
    algorithm: 'sha256',
    hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    relicCount: rows.length,
    scope,
  }
}

function engineFingerprint(serverEntry) {
  let gitCommit = null
  try {
    gitCommit = execFileSync('git', ['-C', mcpDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // Not a git checkout: the build time alone still identifies the engine.
  }
  return { gitCommit, serverBuiltAt: statSync(serverEntry).mtime.toISOString() }
}

const relicIdsOf = (build) => Object.fromEntries(PARTS.map((part) => [part, build.relics[part]?.id ?? null]))

async function main(args) {
  const characterId = args.character
  const serverEntry = resolve(mcpDir, args.server)
  const savePath = resolve(mcpDir, args.save)
  const userOverrides = args.formOverrides ? JSON.parse(readFileSync(resolve(args.formOverrides), 'utf8')) : {}
  const warnings = []
  const calls = []
  const timing = {}
  const startedAt = Date.now()

  const client = new Client({ name: 'team-audit', version: '0.0.0' })
  // The server reads and writes its localStorage file backend; seeding a private
  // copy keeps the real save untouched.
  const tempDir = mkdtempSync(`${tmpdir()}/hsr-team-audit-`)
  const statePath = `${tempDir}/state.json`
  const removeTempDir = () => rmSync(tempDir, { recursive: true, force: true })
  // A signal skips the finally block, and the state file is a full copy of the
  // save. The server flushes that file as it exits, so it has to be gone first.
  const onSignal = () => {
    client.close().catch(() => {}).finally(() => {
      removeTempDir()
      process.exit(1)
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: statePath },
    stderr: 'pipe',
    // Long result tables exceed the default buffer.
    maxBufferSize: 128 * 1024 * 1024,
  })

  // Returns { ok, data } or { ok: false, error }: several steps treat a tool
  // error as a recordable outcome rather than a failure of the audit.
  async function tryCall(name, toolArgs = {}) {
    const callStartedAt = Date.now()
    const result = await client.callTool({ name, arguments: toolArgs }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    })
    const durationMs = Date.now() - callStartedAt
    const text = result.content?.find((item) => item.type === 'text')?.text
    calls.push({ name, ok: !result.isError, durationMs })
    if (result.isError) return { ok: false, error: text ?? 'tool returned isError without content' }
    return { ok: true, data: result.structuredContent ?? JSON.parse(text) }
  }
  async function call(name, toolArgs = {}) {
    const result = await tryCall(name, toolArgs)
    if (!result.ok) throw new Error(`${name}: ${result.error}`)
    return result.data
  }
  async function timed(key, task) {
    const taskStartedAt = Date.now()
    try {
      return await task()
    } finally {
      timing[`${key}Ms`] = Date.now() - taskStartedAt
    }
  }

  try {
    writeFileSync(statePath, JSON.stringify({ state: readFileSync(savePath, 'utf8') }))
    await timed('connect', () => client.connect(transport))
    // The pipe must be drained or a chatty server blocks on a full buffer.
    transport.stderr?.on('data', (chunk) => {
      if (args.verbose) process.stderr.write(chunk)
    })

    // ── 1. Form basis ────────────────────────────────────────────────────────
    const saved = await call('get_form', { characterId })
    const character = await call('get_character', { characterId })
    const scoring = await call('get_scoring_metadata', { characterId })

    let form = saved.form
    let formSource = 'saved-form'
    const base = {}
    if (!form.lightCone) {
      if (!args.lightCone) throw new Error(`角色 ${characterId} 的已保存表单没有光锥,须用 --light-cone <光锥 id> 指定`)
      const defaults = await call('default_form', {
        characterId,
        lightConeId: args.lightCone,
        eidolon: args.eidolon ?? form.characterEidolon ?? 0,
        superimposition: args.superimposition ?? 1,
      })
      warnings.push(...defaults.warnings)
      form = defaults.form
      formSource = 'default-form'
      Object.assign(base, form)
      // These aliases hold nothing but defaults here, yet would override the
      // set filters and teammates sent in display format.
      for (const alias of [...INTERNAL_SET_ALIASES, ...INTERNAL_TEAMMATE_ALIASES]) delete base[alias]
    } else if (args.lightCone || args.eidolon != null || args.superimposition != null) {
      throw new Error(
        `角色 ${characterId} 的已保存表单已有光锥 ${form.lightCone};--light-cone/--eidolon/--superimposition 只用于无光锥角色,换光锥请走 --form-overrides`,
      )
    }
    if (form.resultSort !== 'COMBO') warnings.push(`已保存表单按 ${form.resultSort} 排序,审计强制改按 COMBO 排序`)
    base.enhance = args.enhanceFloor
    base.resultSort = 'COMBO'

    if (args.teammates) {
      const specs = args.teammates.split(',').filter(Boolean).map(parseTeammateSpec)
      if (specs.length > 3) throw new Error(`最多 3 名队友,实际 ${specs.length}`)
      base.teammates = []
      for (const spec of specs) {
        const owned = await tryCall('get_form', { characterId: spec.characterId })
        const teammate = {
          characterId: spec.characterId,
          characterEidolon: spec.characterEidolon ?? owned.data?.form.characterEidolon ?? 0,
          lightCone: spec.lightCone ?? owned.data?.form.lightCone,
          lightConeSuperimposition: spec.lightConeSuperimposition ?? owned.data?.form.lightConeSuperimposition ?? 1,
        }
        if (!teammate.lightCone) {
          throw new Error(`队友 ${spec.characterId} ${owned.ok ? '的已保存表单没有光锥' : '未持有'},须显式给光锥:${spec.characterId}:e0:lc<光锥id>:s1`)
        }
        base.teammates.push(teammate)
      }
      // null clears a slot; an omitted one would keep the saved form's teammate.
      while (base.teammates.length < 3) base.teammates.push(null)
    }
    dropShadowedFilterAliases(base, userOverrides)
    Object.assign(base, userOverrides)

    const savedTeammates = INTERNAL_TEAMMATE_ALIASES.some((alias) => saved.form[alias]?.characterId)
    let teammatesSource = 'none'
    if (Object.hasOwn(userOverrides, 'teammates') || INTERNAL_TEAMMATE_ALIASES.some((alias) => Object.hasOwn(userOverrides, alias))) {
      teammatesSource = 'form-overrides'
    } else if (args.teammates) {
      teammatesSource = 'cli'
    } else if (savedTeammates) {
      teammatesSource = 'saved-form'
    } else {
      warnings.push('未设队友:COMBO 对队友口径极敏感(实测可差 4 倍),跨角色/跨队对比前须用 --teammates 统一口径')
    }
    if (savedTeammates && teammatesSource !== 'saved-form') {
      warnings.push('已保存表单带队友:覆盖的队友是按键合并到原槽位上的,原队友的套装与条件设置可能残留,影响口径')
    }

    // ── 2. Permutations and auto-tightening ──────────────────────────────────
    const estimate = (formOverrides) => call('permutations', { characterId, formOverrides })
    const knobs = args.autoTighten ? buildKnobs({ form, scoring, equipped: character.equippedSlots, userOverrides }) : []
    const tightening = await timed('permutations', () =>
      tighten({
        base,
        formSetFilters: form.setFilters,
        knobs,
        // Without auto-tightening the base overrides run as-is, whatever their size.
        target: args.autoTighten ? args.targetPermutations : Infinity,
        currentMinWeightedRolls: { ...form.weights, ...userOverrides.weights }.minWeightedRolls ?? 0,
        estimate,
      }))
    if (tightening.warning) warnings.push(tightening.warning)
    const initialPermutations = tightening.steps[0].permutations
    const chosen = tightening.chosen
    const formOverrides = chosen?.overrides ?? base

    const effective = { ...form, ...formOverrides }
    // The engine values every main stat as if levelled to this, whatever the relic's enhance.
    const upscaleLevel = effective.mainStatUpscaleLevel ?? 15
    const output = {
      tool: 'team-audit',
      status: 'completed',
      characterId,
      name: character.character.name,
      basis: {
        formSource,
        lightCone: effective.lightCone,
        characterEidolon: effective.characterEidolon,
        lightConeSuperimposition: effective.lightConeSuperimposition,
        teammatesSource,
        teammates: base.teammates ?? null,
        rank: saved.rank,
        rankFilter: effective.rankFilter,
        includeEquippedRelics: effective.includeEquippedRelics,
        enhanceFloor: effective.enhance,
        mainStatUpscaleLevel: upscaleLevel,
      },
      engine: engineFingerprint(serverEntry),
      permutations: {
        initial: initialPermutations,
        final: chosen?.permutations ?? null,
        target: args.autoTighten ? args.targetPermutations : null,
        gate: tightening.gate,
      },
      tightenKnobs: Object.fromEntries(knobs.map(({ name, ...change }) => [name, change.overrides ?? change.setFilters])),
      tightenSteps: tightening.steps.map((step) => ({
        knobs: step.knobs,
        minWeightedRolls: step.minWeightedRolls,
        permutations: step.permutations,
        chosen: step === chosen,
      })),
      formOverrides,
    }
    const finish = (status, extra = {}) => {
      timing.totalMs = Date.now() - startedAt
      return { ...output, status, ...extra, warnings, calls, timing }
    }

    if (!chosen || chosen.permutations === 0) {
      const diagnosis = await tryCall('optimize', { characterId, formOverrides, diagnose: true })
      return finish('rejected', {
        reason: chosen ? '有效排列为 0' : `无法把有效排列收紧到闸门 ${tightening.gate} 以内`,
        diagnosis: diagnosis.data?.diagnosis ?? null,
      })
    }

    // dps_score rates the equipped build against the scoring team, which is a
    // different baseline from the audit teammates above.
    const scoreOf = async (id) => {
      const scored = await tryCall('dps_score', { characterId: id, team: 'default' })
      if (!scored.ok) return { characterId: id, error: scored.error }
      const { percent, grade, scores, upgrades } = scored.data
      return { characterId: id, team: scored.data.team, percent, grade, scores, upgrades }
    }
    const addScores = () =>
      timed('score', async () => {
        output.score = await scoreOf(characterId)
        output.teammatesScores = []
        for (const teammate of (base.teammates ?? []).filter(Boolean)) output.teammatesScores.push(await scoreOf(teammate.characterId))
      })
    const addFingerprint = () =>
      timed('fingerprint', async () => {
        const relics = []
        for (let offset = 0;; offset += RELIC_PAGE_SIZE) {
          const page = await call('list_relics', { offset, limit: RELIC_PAGE_SIZE })
          relics.push(...page.relics)
          if (relics.length >= page.total || page.relics.length === 0) break
        }
        output.inventoryFingerprint = fingerprintInventory(relics, { characterId, form, overrides: formOverrides })
      })

    // ── 3. Search ────────────────────────────────────────────────────────────
    log(`optimize: ${chosen.permutations.toLocaleString('en-US')} 排列(初始 ${initialPermutations.toLocaleString('en-US')})`)
    const optimized = await timed('optimize', () =>
      call('optimize', {
        characterId,
        formOverrides,
        resultsLimit: args.resultsLimit,
        ...(args.engine && { engine: args.engine }),
      }))
    if (optimized.status !== 'completed' && optimized.status !== 'cancelled') {
      return finish('rejected', { reason: optimized.reason ?? `optimize 返回 ${optimized.status}` })
    }

    // The GPU engines run in the managed browser: their rows are the page grid's
    // display strings, without relic builds and outside the result cache, so
    // COMBO can be reported but swaps cannot be derived from them.
    if (optimized.gpuRows) {
      const comboOf = (cells) => {
        const parsed = Number(cells?.COMBO?.replace(/[,\s]/g, ''))
        return cells?.COMBO && Number.isFinite(parsed) ? parsed : null
      }
      Object.assign(output, {
        optimize: {
          engine: optimized.engine,
          actualEngine: optimized.actualEngine,
          durationMs: optimized.gpuDurationMs,
          adapter: optimized.adapter,
          comparison: optimized.comparison,
          note: optimized.note,
        },
        comboNow: comboOf(optimized.equippedRowCells),
        comboBest: comboOf(optimized.gpuRows[0]?.cells),
        topRows: optimized.gpuRows.map((row) => ({ combo: comboOf(row.cells) })),
        zeroCostSwaps: null,
        swapSummary: null,
        bestConflictFreeRow: null,
      })
      warnings.push('GPU 引擎的结果行是网页网格的显示值(取整),不含遗器明细也不进结果缓存:换装分析已跳过,需要换装清单请用默认 CPU 引擎')
      await addScores()
      await addFingerprint()
      return finish('completed')
    }
    const rows = optimized.rows ?? []
    const summary = optimized.summary
    if (summary.gridSortColumn !== 'COMBO') warnings.push(`结果按 ${summary.gridSortColumn} 排序而非 COMBO,comboBest 取自首行`)
    const topRow = rows[0] ?? null
    const comboNow = optimized.equippedRow?.stats.COMBO ?? null
    const comboBest = topRow?.stats.COMBO ?? null
    if (!rows.length) warnings.push('搜索完成但没有结果行:属性/评分过滤条件可能过严')
    if (!optimized.equippedRow) warnings.push('引擎未返回当前装备的基线行(极快或被取消的运行会这样),comboNow 为空')
    const unleveledOf = (row) => PARTS.filter((part) => row.build.relics[part] && row.build.relics[part].enhance < upscaleLevel)
    if (comboNow != null && comboBest != null && comboNow > comboBest) {
      warnings.push('当前装备的 COMBO 高于榜首行:当前配装不在本次搜索范围内(套装或主词条被过滤条件排除),并非引擎错误')
    }
    Object.assign(output, {
      optimize: {
        actualEngine: optimized.actualEngine,
        searched: summary.searched,
        durationMs: summary.durationMs,
        cancelled: summary.cancelled,
        sortColumn: summary.gridSortColumn,
      },
      comboNow,
      comboBest,
      topRows: rows.map((row) => ({
        id: row.id,
        combo: row.stats.COMBO,
        relicIds: relicIdsOf(row.build),
        conflicts: row.build.conflicts ?? [],
        unleveled: unleveledOf(row),
      })),
    })

    await addScores()

    // ── 5. Zero-cost swaps ───────────────────────────────────────────────────
    // Two valuations meet here and must not be subtracted from each other:
    // result rows (comboNow/comboBest) value relics with main stats levelled to
    // mainStatUpscaleLevel, while simulate_build uses each relic as it is now.
    // Everything suffixed AsIs comes from simulate_build.
    await timed('swaps', async () => {
      const currentIds = Object.fromEntries(PARTS.map((part) => [part, character.equippedSlots[part]?.equippedId ?? null]))
      // fromCache replays the exact form the search used.
      const simulate = async (relicIds) => {
        const simulated = await tryCall('simulate_build', {
          characterId,
          relicIds: Object.values(relicIds).filter(Boolean),
          fromCache: { cacheId: summary.cacheId },
        })
        return simulated.ok ? simulated.data.stats.combo?.damage ?? null : null
      }
      const swapsOf = (row) =>
        PARTS
          .filter((part) => row.build.relics[part] && row.build.relics[part].id !== currentIds[part])
          .map((part) => {
            const relic = row.build.relics[part]
            const heldBy = relic.equippedBy && relic.equippedBy !== characterId ? relic.equippedBy : null
            const needsLeveling = relic.enhance < upscaleLevel
            return {
              slot: part,
              addRelicId: relic.id,
              addEnhance: relic.enhance,
              removeRelicId: currentIds[part],
              heldBy,
              needsLeveling,
              zeroCost: heldBy == null && !needsLeveling,
            }
          })
      const delta = (after, before) => (after != null && before != null ? after - before : null)

      const comboNowAsIs = await simulate(currentIds)
      output.zeroCostSwaps = []
      output.swapSummary = null
      if (topRow) {
        const swaps = swapsOf(topRow)
        for (const swap of swaps) {
          const combo = await simulate({ ...currentIds, [swap.slot]: swap.addRelicId })
          output.zeroCostSwaps.push({ ...swap, deltaComboAsIs: delta(combo, comboNowAsIs) })
        }
        const free = swaps.filter((swap) => swap.zeroCost)
        const freeIds = { ...currentIds, ...Object.fromEntries(free.map((swap) => [swap.slot, swap.addRelicId])) }
        const afterFree = free.length ? await simulate(freeIds) : comboNowAsIs
        output.swapSummary = {
          comboNowAsIs,
          zeroCostSwaps: free.length,
          contestedSwaps: swaps.filter((swap) => swap.heldBy != null).length,
          needsLevelingSwaps: swaps.filter((swap) => swap.needsLeveling).length,
          comboAfterZeroCostSwapsAsIs: afterFree,
          deltaAfterZeroCostSwapsAsIs: delta(afterFree, comboNowAsIs),
        }
      }
      // The best row that takes nothing from another character is a complete
      // build the engine already scored, so its COMBO needs no re-simulation.
      const freeRow = rows.find((row) => !(row.build.conflicts?.length))
      const freeSwaps = freeRow ? swapsOf(freeRow) : []
      output.bestConflictFreeRow = freeRow
        ? {
          id: freeRow.id,
          combo: freeRow.stats.COMBO,
          // Rows carry float32 COMBO, so the equipped build compared with itself is not exactly 0.
          isCurrentBuild: freeSwaps.length === 0,
          deltaVsNow: freeSwaps.length ? delta(freeRow.stats.COMBO, comboNow) : 0,
          unleveled: unleveledOf(freeRow),
          swaps: freeSwaps,
        }
        : null
      if (!freeRow && rows.length) warnings.push(`前 ${rows.length} 行都要占用其他角色的遗器,未找到零成本整套配装`)
      if (topRow && unleveledOf(topRow).length) {
        warnings.push(`榜首行含未强化到 +${upscaleLevel} 的遗器:comboBest 按主词条升满估值,换上后须先强化才能达到`)
      }
    })

    await addFingerprint()

    return finish(summary.cancelled ? 'cancelled' : 'completed')
  } finally {
    await client.close().catch(() => {})
    removeTempDir()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

try {
  const args = parseArgs(process.argv.slice(2))
  const result = await main(args)
  const json = JSON.stringify(result, null, 2)
  if (args.out) {
    writeFileSync(resolve(args.out), json)
    log(`结果已写入 ${resolve(args.out)}`)
  } else {
    process.stdout.write(`${json}\n`)
  }
  log(`status=${result.status} comboNow=${result.comboNow ?? '-'} comboBest=${result.comboBest ?? '-'} total=${result.timing.totalMs}ms`)
  process.exitCode = result.status === 'completed' ? 0 : 2
} catch (error) {
  log(`失败:${error.message}`)
  process.exitCode = 1
}
