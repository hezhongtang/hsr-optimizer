// Single-team audit: the orchestration behind the `team_audit` tool.
//
// It composes existing tools and adds no engine logic of its own, so every
// number in its output can be reproduced by calling those tools by hand:
// get_form / get_character / get_scoring_metadata → permutations → optimize →
// simulate_build → score_relics → dps_score. The tools are reached through
// `deps.callTool`, which the server binds to an in-process client (loopback.ts).
//
// Default strategy "tiered" — no set locks, the relic pool is split by enhance:
//   pass 1  every levelled relic, no threshold           → the main list (wearable builds)
//   pass 2  the same plus the +0 relics that clear a gate → "worth levelling" candidates only
// Each pass runs twice: "priority" may take relics from lower-ranked characters
// (the form's own ownership rules), "free" takes nothing another character wears.
// The gate is the lowest +0 weighted-roll threshold whose search fits the time
// budget. Then: zero-cost swaps → farming advice → dps_score → fingerprint.
// "locked" is the earlier strategy: scoring-metadata set locks tightened to a
// permutation target, one search.
//
// Does not edit a form. A save with no pending edits is not rewritten; pending
// edits are flushed before a search, the same way optimize does it. The audit
// does replace the server's latest optimize result (the cache get_results reads).

import { createHash } from 'node:crypto'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

export type TeamAuditTeammate = {
  characterId: string,
  characterEidolon?: number,
  lightCone?: string,
  lightConeSuperimposition?: number,
}

export type TeamAuditArgs = {
  characterId: string,
  teammates?: TeamAuditTeammate[],
  lightConeId?: string,
  eidolon?: number,
  superimposition?: number,
  formOverrides?: Record<string, unknown>,
  strategy?: 'tiered' | 'locked',
  autoTighten?: boolean,
  budgetSeconds: number,
  leveledBudgetSeconds: number,
  candidateRows: number,
  candidateTolerance: number,
  resultsLimit: number,
  enhanceFloor: number,
  targetPermutations?: number,
  engine?: 'auto' | 'cpu' | 'gpu' | 'gpu-experimental',
  crossCheck?: boolean,
}

export type ToolCallOutcome = { isError: boolean, text: string | undefined, data: Any }

export type TeamAuditDeps = {
  /** Calls a registered tool the way a client would; a tool error is an outcome, not an exception. */
  callTool: (name: string, toolArgs: Record<string, unknown>) => Promise<ToolCallOutcome>,
  /** Identifies the engine build the numbers came from. */
  engineFingerprint: () => { gitCommit: string | null, serverBuiltAt: string | null },
  log: (message: string) => void,
}

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
const RELIC_PAGE_SIZE = 500
// Permutations per second assumed before a search has been timed: the slowest
// rates measured per engine, so the first projection errs on the long side.
const ASSUMED_RATE: Record<string, number> = { 'gpu': 5e7, 'gpu-experimental': 5e7, 'cpu': 3e5, 'auto': 3e5 }
// Searches shorter than this say little about throughput.
const WARM_UP_MS = 3000
// +0 admission gates in weighted rolls, strictest first; 0 admits every +0 relic.
const UNLEVELED_GATES = [4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0]
// scoreFormatting.ts RATING_TIERS: one tier per 5% of ideal substats.
const RATING_TIER_PERCENT = 5
// A piece is a farming target below B, or five tiers under the build's best piece.
const WEAK_PIECE_PERCENT = 30
const WEAK_PIECE_GAP_PERCENT = 25
const DEFAULT_TARGET_PERMUTATIONS = 2e7

// A whole-form base carries flat min/max aliases that would shadow the caller's
// display-format stat and rating filters; drop the ones being overridden.
function dropShadowedFilterAliases(base: Any, display: Any) {
  for (const group of ['statFilters', 'ratingFilters']) {
    for (const key of Object.keys(display[group] ?? {})) delete base[key]
  }
}

function countBy<T>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

// Sets the character is wearing right now, in setFilters terms, so a lock keeps
// a 4pc or 2+2 equipped build selectable. Other layouts (2pc + loose pieces,
// split ornaments) cannot be expressed and may fall outside the search.
function equippedSets(equippedSlots: Any) {
  const setOf = (part: string) => equippedSlots?.[part]?.relic?.set
  const pairs = [...countBy(RELIC_PARTS.map(setOf).filter(Boolean))]
    .filter(([, count]) => count >= 2)
  const ornaments = ORNAMENT_PARTS.map(setOf)
  return {
    fourPiece: pairs.filter(([, count]) => count === 4).map(([set]) => set),
    twoPieceCombos: pairs.length === 2 ? [[pairs[0][0], pairs[1][0]]] : [],
    ornaments: ornaments[0] && ornaments[0] === ornaments[1] ? [ornaments[0]] : [],
  }
}

const comboKey = ([a, b]: string[]) => [a, b].sort().join('\u0000')

// Independent tightening knobs derived from scoring metadata. A knob only exists
// where the effective form has no filter of its own and the caller set none.
function buildKnobs({ form, scoring, equipped, userOverrides }: Any) {
  const knobs: Any[] = []
  const simulation = scoring.simulations?.dps ?? Object.values(scoring.simulations ?? {})[0]
  const userSet = (key: string) => Object.hasOwn(userOverrides, key)

  const mains: Any = {}
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

  const pairs = (simulation?.relicSets ?? []).filter((entry: string[]) => entry.length === 2)
  const fourPiece = [...new Set([...pairs.filter(([a, b]: string[]) => a === b).map(([a]: string[]) => a), ...current.fourPiece])]
  const combos = new Map()
  for (const pair of [...pairs.filter(([a, b]: string[]) => a !== b), ...current.twoPieceCombos]) combos.set(comboKey(pair), pair)
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
function applyKnobs({ base, formSetFilters }: Any, knobs: Any[], minWeightedRolls: number | null) {
  const overrides = structuredClone(base)
  const setFilters: Any = {}
  for (const knob of knobs) {
    Object.assign(overrides, knob.overrides)
    Object.assign(setFilters, knob.setFilters)
  }
  if (Object.keys(setFilters).length) overrides.setFilters = { ...formSetFilters, ...setFilters }
  if (minWeightedRolls != null) overrides.weights = { ...overrides.weights, minWeightedRolls }
  return overrides
}

function subsetsOf<T>(items: T[]): T[][] {
  const subsets: T[][] = []
  for (let mask = 0; mask < (1 << items.length); mask++) {
    subsets.push(items.filter((_, index) => mask & (1 << index)))
  }
  return subsets
}

// Picks the least restrictive overrides whose search space fits the target.
// Every evaluated candidate is recorded so the trajectory is reproducible.
async function tighten({ base, formSetFilters, knobs, target, currentMinWeightedRolls, estimate }: Any) {
  const steps: Any[] = []
  let gate: number = Infinity
  const evaluate = async (subset: Any[], minWeightedRolls: number | null = null) => {
    const overrides = applyKnobs({ base, formSetFilters }, subset, minWeightedRolls)
    const estimated = await estimate(overrides)
    gate = estimated.gate.gate
    const step = { knobs: subset.map((knob: Any) => knob.name), minWeightedRolls, permutations: estimated.validPermutations, overrides }
    steps.push(step)
    return step
  }
  const widest = (candidates: Any[]) =>
    candidates.reduce((best: Any, step: Any) => (
      step.permutations > best.permutations || (step.permutations === best.permutations && step.knobs.length < best.knobs.length) ? step : best
    ))
  const done = (chosen: Any, warning?: string) => ({ chosen, steps, gate, warning })
  const thinWarning = (step: Any) => `只能收紧到 ${step.permutations} 排列(低于 ${PERMUTATION_FLOOR}),结果可能搜不到优于现装的解`

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
  const subset = knobs.filter((knob: Any) => smallestAbove.knobs.includes(knob.name))
  const floors = MIN_WEIGHTED_ROLLS_STEPS.filter((value) => value > currentMinWeightedRolls)
  let found: Any = null
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
function fingerprintInventory(relics: Any[], { characterId, form, overrides }: Any) {
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

  return hashInventoryScope(relics, characterId, scope)
}

// Ownership rules live on the save, not in the relic bytes. Another character
// moving up the rank list, or exclude / includeEquippedRelics flipping, leaves
// the relic hash unchanged and still makes the old comboBest illegal.
function savedOwnershipOf(form: Any, characters: { id: string, rank: number }[]) {
  const characterOrder = [...characters]
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((character) => character.id)
  return {
    rankFilter: form?.rankFilter === true,
    includeEquippedRelics: form?.includeEquippedRelics === true,
    exclude: [...(form?.exclude ?? [])].map(String).sort(),
    characterOrder,
  }
}

function sameOwnership(before: Any, now: Any) {
  return before.rankFilter === now.rankFilter
    && before.includeEquippedRelics === now.includeEquippedRelics
    && JSON.stringify(before.exclude) === JSON.stringify(now.exclude)
    && JSON.stringify(before.characterOrder) === JSON.stringify(now.characterOrder)
}

// A packaged entry has no git commit. The build time is then the only thing
// that distinguishes two engines; when both sides have a commit, a rebuild of
// the same commit is the same engine.
function engineDiffers(
  baseline: { gitCommit?: string | null, serverBuiltAt?: string | null } | undefined,
  current: { gitCommit: string | null, serverBuiltAt: string | null },
) {
  const baselineCommit = baseline?.gitCommit ?? null
  const currentCommit = current.gitCommit
  if (baselineCommit != null && currentCommit != null) return baselineCommit !== currentCommit
  const baselineStamp = baselineCommit ?? baseline?.serverBuiltAt ?? null
  const currentStamp = currentCommit ?? current.serverBuiltAt
  return baselineStamp != null && currentStamp != null && baselineStamp !== currentStamp
}

// The pool a scope describes, hashed. plan_diff recomputes this from a stored
// scope alone, so everything the pool depends on has to be in the scope.
function hashInventoryScope(relics: Any[], characterId: string, scope: Any) {
  const pool = relics.filter((relic) => {
    if (relic.equippedBy === characterId) return true
    if (relic.enhance < scope.enhanceFloor || (relic.grade && relic.grade < scope.grade)) return false
    const locked = RELIC_PARTS.includes(relic.part) ? scope.relicSets : scope.ornaments
    if (locked && !locked.includes(relic.set)) return false
    const allowed = scope.mains?.[relic.part]
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
      relic.substats.map((substat: Any) => [substat.stat, substat.value]),
      // Unrevealed substats count: the engine merges them into the search.
      (relic.previewSubstats ?? []).map((substat: Any) => [substat.stat, substat.value]),
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

type Call = (name: string, toolArgs?: Record<string, unknown>) => Promise<Any>

async function loadAllCharacters(call: Call): Promise<{ id: string, rank: number }[]> {
  const characters: { id: string, rank: number }[] = []
  for (let offset = 0;; offset += 200) {
    const page = await call('list_characters', { offset, limit: 200 })
    characters.push(...page.characters.map((character: Any) => ({ id: character.id, rank: character.rank })))
    if (characters.length >= page.total || page.characters.length === 0) break
  }
  return characters
}

async function loadAllRelics(call: Call): Promise<Any[]> {
  const relics: Any[] = []
  for (let offset = 0;; offset += RELIC_PAGE_SIZE) {
    const page = await call('list_relics', { offset, limit: RELIC_PAGE_SIZE })
    relics.push(...page.relics)
    if (relics.length >= page.total || page.relics.length === 0) break
  }
  return relics
}

// What a member's saved form says about their build, whatever an audit overrode:
// the part of the roster a team's numbers depend on.
const ROSTER_FIELDS = ['owned', 'characterEidolon', 'lightCone', 'lightConeSuperimposition'] as const
// Ids the search will use. A formOverrides.teammates entry is merged onto the
// saved slot: a patch without characterId keeps the saved teammate, and null
// clears the slot. The patch array alone would drop that saved id.
function teammateIds(savedForm: Any, applied: Any): string[] {
  const savedSlots = INTERNAL_TEAMMATE_ALIASES.map((alias) => savedForm?.[alias] ?? null)
  const patches = Array.isArray(applied?.teammates) ? applied.teammates : null
  return savedSlots.flatMap((saved, index) => {
    if (!patches || index >= patches.length) return saved?.characterId ? [saved.characterId] : []
    const patch = patches[index]
    if (patch == null) return []
    const id = patch.characterId ?? saved?.characterId
    return id ? [id] : []
  })
}

function rosterEntryOf(characterId: string, savedForm: Any) {
  return {
    characterId,
    owned: savedForm != null,
    characterEidolon: savedForm?.characterEidolon ?? null,
    lightCone: savedForm?.lightCone ?? null,
    lightConeSuperimposition: savedForm?.lightConeSuperimposition ?? null,
  }
}

const relicIdsOf = (build: Any) => Object.fromEntries(PARTS.map((part) => [part, build.relics[part]?.id ?? null]))

export async function runTeamAudit(args: TeamAuditArgs, deps: TeamAuditDeps): Promise<Any> {
  const characterId = args.characterId
  const userOverrides: Any = args.formOverrides ?? {}
  // Turning auto-tightening off only means something for the locked strategy.
  const autoTighten = args.autoTighten !== false
  const strategy = args.strategy ?? (autoTighten ? 'tiered' : 'locked')
  const warnings: string[] = []
  const calls: Any[] = []
  const timing: Record<string, number> = {}
  const startedAt = Date.now()
  const log = (...parts: unknown[]) => deps.log(parts.join(' '))

  // Returns { ok, data } or { ok: false, error }: several steps treat a tool
  // error as a recordable outcome rather than a failure of the audit.
  async function tryCall(name: string, toolArgs: Record<string, unknown> = {}): Promise<Any> {
    const callStartedAt = Date.now()
    const result = await deps.callTool(name, toolArgs)
    calls.push({ name, ok: !result.isError, durationMs: Date.now() - callStartedAt })
    if (result.isError) return { ok: false, error: result.text ?? 'tool returned isError without content' }
    return { ok: true, data: result.data }
  }
  async function call(name: string, toolArgs: Record<string, unknown> = {}): Promise<Any> {
    const result = await tryCall(name, toolArgs)
    if (!result.ok) throw new Error(`${name}: ${result.error}`)
    return result.data
  }
  async function timed<T>(key: string, task: () => Promise<T>): Promise<T> {
    const taskStartedAt = Date.now()
    try {
      return await task()
    } finally {
      timing[`${key}Ms`] = Date.now() - taskStartedAt
    }
  }

  // ── 1. Form basis ────────────────────────────────────────────────────────
  const saved = await call('get_form', { characterId })
  const character = await call('get_character', { characterId })
  const scoring = await call('get_scoring_metadata', { characterId })

  let form = saved.form
  let formSource = 'saved-form'
  const base: Any = {}
  if (!form.lightCone) {
    if (!args.lightConeId) throw new Error(`角色 ${characterId} 的已保存表单没有光锥,须用 lightConeId 指定`)
    const defaults = await call('default_form', {
      characterId,
      lightConeId: args.lightConeId,
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
  } else if (args.lightConeId || args.eidolon != null || args.superimposition != null) {
    throw new Error(
      `角色 ${characterId} 的已保存表单已有光锥 ${form.lightCone};lightConeId/eidolon/superimposition 只用于无光锥角色,换光锥请走 formOverrides`,
    )
  }
  if (form.resultSort !== 'COMBO') warnings.push(`已保存表单按 ${form.resultSort} 排序,审计强制改按 COMBO 排序`)
  base.enhance = args.enhanceFloor
  base.resultSort = 'COMBO'

  if (args.teammates?.length) {
    const specs = args.teammates
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
        throw new Error(`队友 ${spec.characterId} ${owned.ok ? '的已保存表单没有光锥' : '未持有'},须在 teammates 里显式给 lightCone`)
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
  } else if (args.teammates?.length) {
    teammatesSource = 'argument'
  } else if (savedTeammates) {
    teammatesSource = 'saved-form'
  } else {
    warnings.push('未设队友:COMBO 对队友口径极敏感(实测可差 4 倍),跨角色/跨队对比前须用 teammates 统一口径')
  }
  if (savedTeammates && teammatesSource !== 'saved-form') {
    warnings.push('已保存表单带队友:覆盖的队友是按键合并到原槽位上的,原队友的套装与条件设置可能残留,影响口径')
  }

  // ── 2. Permutations and auto-tightening ──────────────────────────────────
  const tiered = strategy === 'tiered'
  if (tiered && args.targetPermutations != null) warnings.push('targetPermutations 只对 locked 策略生效,tiered 策略不锁套装也不收紧,已忽略')
  const estimate = (formOverrides: Any, relicPool?: Any) => call('permutations', { characterId, formOverrides, ...(relicPool && { relicPool }) })
  // The tiered strategy locks nothing: this step only sizes the unrestricted space.
  const tightenTarget = !tiered && autoTighten ? (args.targetPermutations ?? DEFAULT_TARGET_PERMUTATIONS) : Infinity
  const knobs = !tiered && autoTighten ? buildKnobs({ form, scoring, equipped: character.equippedSlots, userOverrides }) : []
  const tightening = await timed('permutations', () =>
    tighten({
      base,
      formSetFilters: form.setFilters,
      knobs,
      // Without auto-tightening the base overrides run as-is, whatever their size.
      target: tightenTarget,
      currentMinWeightedRolls: { ...form.weights, ...userOverrides.weights }.minWeightedRolls ?? 0,
      estimate,
    }))
  if (tightening.warning) warnings.push(tightening.warning)
  const initialPermutations = tightening.steps[0].permutations
  const chosen = tightening.chosen
  const formOverrides = chosen?.overrides ?? base

  const effective = { ...form, ...formOverrides }
  const memberIds: string[] = Array.isArray(base.teammates)
    ? teammateIds(saved.form, base)
    : INTERNAL_TEAMMATE_ALIASES.map((alias) => ({ ...form, ...base })[alias]?.characterId).filter(Boolean)
  const roster = [rosterEntryOf(characterId, saved.form)]
  for (const id of memberIds) roster.push(rosterEntryOf(id, (await tryCall('get_form', { characterId: id })).data?.form))
  // The engine values every main stat as if levelled to this, whatever the relic's enhance.
  const upscaleLevel = effective.mainStatUpscaleLevel ?? 15
  const output: Any = {
    tool: 'team_audit',
    status: 'completed',
    strategy,
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
    roster,
    engine: deps.engineFingerprint(),
    permutations: {
      initial: initialPermutations,
      final: chosen?.permutations ?? null,
      target: Number.isFinite(tightenTarget) ? tightenTarget : null,
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
  const finish = (status: string, extra: Any = {}) => {
    timing.totalMs = Date.now() - startedAt
    return { ...output, status, ...extra, warnings, calls, timing }
  }

  // dps_score rates the equipped build against the scoring team, which is a
  // different baseline from the audit teammates above.
  const scoreOf = async (id: string) => {
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
  let inventory: Any[] | null = null
  const loadRelics = async () => (inventory ??= await loadAllRelics(call))
  const addFingerprint = (overrides: Any) =>
    timed('fingerprint', async () => {
      const fingerprint: Any = fingerprintInventory(await loadRelics(), { characterId, form, overrides })
      fingerprint.savedOwnership = savedOwnershipOf(saved.form, await loadAllCharacters(call))
      output.inventoryFingerprint = fingerprint
    })

  const warnOnce = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message)
  }
  // A save can hold one relic id twice: the levelled record and a stale copy
  // from before it was levelled. Result rows look relics up by id and may be
  // handed the stale copy, so for those ids the highest enhance on record is
  // taken. Has to run before any row is read.
  let duplicateIds = new Set<string>()
  const enhanceOfDuplicate = new Map<string, number>()
  const loadDuplicates = async () => {
    const relics = await loadRelics()
    const idCounts = countBy(relics.map((relic: Any) => relic.id))
    duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id))
    for (const relic of relics) {
      if (duplicateIds.has(relic.id)) enhanceOfDuplicate.set(relic.id, Math.max(relic.enhance, enhanceOfDuplicate.get(relic.id) ?? 0))
    }
    if (duplicateIds.size) {
      warnings.push(
        `存档里有 ${duplicateIds.size} 个遗器 id 重复出现(同一 id 两条记录,强化等级不同):这些遗器的强化等级按较高的那条记录展示,`
          + '但当前配装的基线(comboNow)与含这些遗器的结果行可能是按陈旧记录算的;它们不会被列为待强化候选。建议在网页端清理重复记录后重新导出存档',
      )
    }
  }
  const enhanceOf = (relic: Any) => enhanceOfDuplicate.get(relic.id) ?? relic.enhance

  const currentIds = Object.fromEntries(PARTS.map((part) => [part, character.equippedSlots[part]?.equippedId ?? null]))
  const unleveledOf = (row: Any) => PARTS.filter((part) => row.build.relics[part] && enhanceOf(row.build.relics[part]) < upscaleLevel)
  const delta = (after: number | null, before: number | null) => (after != null && before != null ? after - before : null)
  const swapsOf = (row: Any) =>
    PARTS
      .filter((part) => row.build.relics[part] && row.build.relics[part].id !== currentIds[part])
      .map((part) => {
        const relic = row.build.relics[part]
        const heldBy = relic.equippedBy && relic.equippedBy !== characterId ? relic.equippedBy : null
        const needsLeveling = enhanceOf(relic) < upscaleLevel
        return {
          slot: part,
          addRelicId: relic.id,
          addEnhance: enhanceOf(relic),
          removeRelicId: currentIds[part],
          heldBy,
          needsLeveling,
          zeroCost: heldBy == null && !needsLeveling,
        }
      })
  const topRowsOf = (rows: Any[]) =>
    rows.map((row) => ({
      id: row.id,
      combo: row.stats.COMBO,
      relicIds: relicIdsOf(row.build),
      conflicts: row.build.conflicts ?? [],
      unleveled: unleveledOf(row),
    }))

  // Zero-cost swaps. Two valuations meet here and must not be subtracted from
  // each other: result rows (comboNow/comboBest) value relics with main stats
  // levelled to mainStatUpscaleLevel, while simulate_build uses each relic as
  // it is now. Everything suffixed AsIs comes from simulate_build.
  // cacheId has to be the server's latest search: fromCache replays its form.
  const addSwaps = ({ topRow, cacheId, comboNow, freeRow }: Any) =>
    timed('swaps', async () => {
      const simulate = async (relicIds: Any): Promise<number | null> => {
        const simulated = await tryCall('simulate_build', {
          characterId,
          relicIds: Object.values(relicIds).filter(Boolean),
          fromCache: { cacheId },
        })
        return simulated.ok ? simulated.data.stats.combo?.damage ?? null : null
      }

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
      if (topRow && unleveledOf(topRow).length) {
        warnings.push(`榜首行含未强化到 +${upscaleLevel} 的遗器:comboBest 按主词条升满估值,换上后须先强化才能达到`)
      }
    })

  // ── Tiered strategy ──────────────────────────────────────────────────────
  const runTiered = async () => {
    let engine = args.engine ?? 'gpu'
    if (!args.engine) {
      // Zero side effects: reports whether Chrome and the site dist exist, launches nothing.
      const capabilities = await tryCall('get_runtime_capabilities', {})
      if (capabilities.ok && !capabilities.data.browserReady) {
        engine = 'cpu'
        warnings.push(
          '受管浏览器环境不齐(缺 Chrome 或站点 dist),默认的 GPU 引擎不可用,已改用 CPU 引擎:搜索慢两个数量级,第一遍可能无法穷尽(在仓库根目录 npm run build 后可恢复 GPU)',
        )
      }
    }
    const gpuEngine = engine === 'gpu' || engine === 'gpu-experimental'
    const leveledBudgetMs = args.leveledBudgetSeconds * 1000
    const tolerance = args.candidateTolerance
    output.engineRequested = engine

    // Search time is projected from the searches already timed in this run:
    // throughput differs by more than an order of magnitude between characters.
    const runs: { permutations: number, searchMs: number, wallMs: number }[] = []
    const projectMs = (permutations: number) => {
      if (!runs.length) return (permutations / ASSUMED_RATE[engine]) * 1000
      const largest = runs.reduce((best, run) => (run.permutations > best.permutations ? run : best))
      const average = largest.permutations / largest.searchMs
      // A short search is mostly warm-up; the slope between two searches of
      // clearly different size is the better rate, capped against noise.
      const smaller = runs
        .filter((run) => run.permutations * 2 <= largest.permutations && run.searchMs < largest.searchMs)
        .reduce<(typeof runs)[number] | null>((best, run) => (!best || run.permutations > best.permutations ? run : best), null)
      const slope = smaller ? (largest.permutations - smaller.permutations) / (largest.searchMs - smaller.searchMs) : average
      let rate = Math.min(Math.max(slope, average), average * 10)
      // A search this short is mostly fixed start-up cost and understates the
      // throughput by orders of magnitude; the assumed rate is the slowest measured.
      if (largest.searchMs < WARM_UP_MS) rate = Math.max(rate, ASSUMED_RATE[engine] / 1000)
      return (largest.wallMs - largest.searchMs) + permutations / rate
    }
    let halt: { status: 'cancelled' | 'rejected', reason: string } | null = null
    const search = async (formOverrides: Any, relicPool: Any, resultsLimit: number) => {
      const searchStartedAt = Date.now()
      const optimized = await call('optimize', {
        characterId,
        formOverrides,
        resultsLimit,
        force: true,
        relicPool,
        engine,
        ...(gpuEngine && { crossCheck: args.crossCheck === true }),
      })
      const wallMs = Date.now() - searchStartedAt
      // A cancelled or rejected search is the audit's own status. Throwing here
      // would drop the passes already recorded and surface a bare tool error.
      if (optimized.status === 'cancelled') {
        halt = { status: 'cancelled', reason: optimized.reason ?? '搜索已取消' }
        return null
      }
      if (optimized.status !== 'completed') {
        halt = { status: 'rejected', reason: optimized.reason ?? `optimize 返回 ${optimized.status}` }
        return null
      }
      if (!optimized.rows) {
        halt = {
          status: 'rejected',
          reason: '站点 dist 早于结果钩子,GPU 引擎拿不到结构化结果——在仓库根目录 npm run build 后重试,或改用 engine=cpu',
        }
        return null
      }
      if (gpuEngine && optimized.actualEngine !== engine) {
        warnOnce(`请求的是 ${engine} 引擎,网页实际以 ${optimized.actualEngine} 引擎完成(设备不可用时会回落),结果按实际引擎理解`)
      }
      const searchMs = Math.max(optimized.gpuDurationMs ?? optimized.summary.durationMs, 1)
      runs.push({ permutations: optimized.summary.validPermutations, searchMs, wallMs })
      return { optimized, wallMs, searchMs }
    }

    const variants = effective.includeEquippedRelics === false ? ['free'] : ['free', 'priority']
    let mainVariant = variants.at(-1)!
    const overridesOf = (variant: string, minWeightedRolls: number | null) => {
      const overrides = structuredClone(base)
      if (variant === 'free') overrides.includeEquippedRelics = false
      if (minWeightedRolls != null) overrides.weights = { ...overrides.weights, minWeightedRolls }
      return overrides
    }
    const currentFloor = { ...form.weights, ...userOverrides.weights }.minWeightedRolls ?? 0
    const passes: Any[] = []
    const describePasses = () => passes.map(({ rows, optimized, formOverrides: _formOverrides, ...pass }) => ({ ...pass, rowCount: rows?.length ?? 0 }))
    const finishHalted = async () => {
      if (!halt) return null
      await addFingerprint(output.formOverrides)
      return finish(halt.status, { reason: halt.reason, passes: describePasses() })
    }

    // ── Pass 1: every levelled relic ───────────────────────────────────────
    const leveled: Any = {}
    await timed('leveled', async () => {
      for (const variant of variants) {
        const relicPool = { excludeUnleveled: true }
        let minWeightedRolls = null
        let estimated = await estimate(overridesOf(variant, null), relicPool)
        for (const floor of MIN_WEIGHTED_ROLLS_STEPS.filter((value) => value > currentFloor)) {
          if (projectMs(estimated.validPermutations) <= leveledBudgetMs) break
          minWeightedRolls = floor
          estimated = await estimate(overridesOf(variant, floor), relicPool)
        }
        const pass: Any = {
          pass: 'leveled',
          variant,
          relicPool,
          minWeightedRolls,
          exhaustive: minWeightedRolls == null,
          permutations: estimated.validPermutations,
          formOverrides: overridesOf(variant, minWeightedRolls),
        }
        passes.push(pass)
        leveled[variant] = pass
        if (estimated.validPermutations === 0) continue
        if (projectMs(estimated.validPermutations) > leveledBudgetMs) {
          pass.skipped = `预计 ${Math.round(projectMs(estimated.validPermutations) / 1000)} 秒,超出第一遍预算 ${args.leveledBudgetSeconds} 秒`
          continue
        }
        if (minWeightedRolls != null) {
          warnings.push(
            `${variant} 口径的已强化遗器未能穷尽:为了在 ${args.leveledBudgetSeconds} 秒内跑完,把引擎的加权强化次数门槛提到了 ${minWeightedRolls}(可换 GPU 引擎或调高 leveledBudgetSeconds)`,
          )
        }
        log(`第一遍 ${variant}: ${estimated.validPermutations.toLocaleString('en-US')} 排列`)
        const found = await search(pass.formOverrides, relicPool, args.resultsLimit)
        if (!found) return
        const { optimized, wallMs, searchMs } = found
        Object.assign(pass, {
          durationMs: searchMs,
          wallMs,
          rows: optimized.rows,
          optimized,
          comboBest: optimized.rows[0]?.stats.COMBO ?? null,
        })
      }
    })
    const haltedAfterLevelled = await finishHalted()
    if (haltedAfterLevelled) return haltedAfterLevelled

    // The free search is still the server's latest when the priority one never ran.
    if (mainVariant !== 'free' && !leveled[mainVariant].optimized && leveled.free?.optimized) {
      warnings.push(`priority 口径未能搜索(${leveled[mainVariant].skipped}),主榜单改用 free 口径(不占用其他角色的遗器)`)
      mainVariant = 'free'
    }
    const main = leveled[mainVariant]
    output.formOverrides = main.formOverrides
    output.permutations.final = main.permutations
    if (!main.optimized) {
      const diagnosis = main.permutations === 0
        ? await tryCall('optimize', { characterId, formOverrides: main.formOverrides, relicPool: main.relicPool, diagnose: true })
        : null
      await addFingerprint(main.formOverrides)
      return finish('rejected', {
        reason: main.permutations === 0 ? '只用已强化遗器时有效排列为 0' : main.skipped,
        diagnosis: diagnosis?.data?.diagnosis ?? null,
        passes: describePasses(),
      })
    }

    await loadDuplicates()
    const summary = main.optimized.summary
    if (summary.gridSortColumn !== 'COMBO') warnings.push(`结果按 ${summary.gridSortColumn} 排序而非 COMBO,comboBest 取自首行`)
    const topRow = main.rows[0] ?? null
    const comboNow = main.optimized.equippedRow?.stats.COMBO ?? leveled.free?.optimized?.equippedRow?.stats.COMBO ?? null
    if (!main.rows.length) warnings.push('搜索完成但没有结果行:属性/评分过滤条件可能过严')
    if (comboNow == null) warnings.push('引擎未返回当前装备的基线行(极快或被取消的运行会这样),comboNow 为空')
    if (comboNow != null && main.comboBest != null && comboNow > main.comboBest) {
      warnings.push('当前装备的 COMBO 高于主榜单榜首:当前配装不在这一遍的搜索范围内(主榜单未穷尽时被门槛筛掉,或被表单自身的过滤条件排除),并非引擎错误')
    }
    Object.assign(output, {
      optimize: {
        engine: main.optimized.engine,
        actualEngine: main.optimized.actualEngine,
        searched: summary.searched,
        durationMs: summary.durationMs,
        cancelled: summary.cancelled,
        sortColumn: summary.gridSortColumn,
        ...(main.optimized.adapter && { adapter: main.optimized.adapter }),
        ...(main.optimized.comparison && { comparison: main.optimized.comparison }),
      },
      comboNow,
      comboBest: main.comboBest,
      topRows: topRowsOf(main.rows),
    })

    // The main search is still the server's latest here, as fromCache needs.
    const freeRow = leveled.free?.rows?.[0] ?? null
    await addSwaps({ topRow, cacheId: summary.cacheId, comboNow, freeRow })
    if (!freeRow) warnings.push('不占用其他角色的遗器时没有可行的整套配装(已强化遗器范围内)')

    // ── Relic scores: rating and potential against this character ──────────
    const scores = new Map<string, Any>()
    await timed('relicScores', async () => {
      for (let offset = 0;; offset += RELIC_PAGE_SIZE) {
        const page = await call('score_relics', { characterId, includeEstTbp: false, offset, limit: RELIC_PAGE_SIZE })
        for (const relic of page.relics) {
          const known = scores.get(relic.id)
          if (!known || relic.enhance > known.enhance) scores.set(relic.id, relic)
        }
        if (offset + page.relics.length >= page.total || page.relics.length === 0) break
      }
    })
    const scoreOfRelic = (relic: Any) => {
      const scored = scores.get(relic.id)
      return {
        relicId: relic.id,
        set: relic.set,
        mainStat: relic.main.stat,
        enhance: enhanceOf(relic),
        rating: scored?.current?.rating ?? null,
        percentScore: scored?.current?.percentScore ?? null,
        potentialNowPercent: scored?.potential?.currentPct ?? null,
        potentialAveragePercent: scored?.potential?.averagePct ?? null,
        potentialBestPercent: scored?.potential?.bestPct ?? null,
      }
    }

    // ── Pass 2: +0 relics worth levelling ──────────────────────────────────
    // A row with a +0 relic is valued with that relic's main stat levelled and
    // its substats as they are now, which is the floor of what it becomes.
    const worthLeveling: Any = {
      valuation: '含 +0 遗器的组合按「主词条升满、副词条取当前初始值」估值,是强化后的下限;强化只会加属性',
      classification: 'guaranteed = 只换上这一件 +0 遗器,保底 COMBO 就已超过已强化最优;potential = 保底落在容差带内,且潜力评分的上限高于被替换的那件;'
        + 'bestWithUnleveled = 把 +0 遗器算进来后的最优整套(可能要同时强化多件)',
      tolerance,
      candidateRows: args.candidateRows,
      budgetSeconds: args.budgetSeconds,
      variants: {},
    }
    const candidatesOf = (variant: string, rows: Any[]) => {
      const best = leveled[variant].comboBest
      const empty = { leveledBest: best, rowsScanned: rows.length, bandCovered: true, guaranteed: [], potential: [], withoutUpside: 0, unscored: 0 }
      if (!(best > 0)) return { ...empty, skipped: '已强化最优的 COMBO 不是正数,无从比较' }
      const incumbents = leveled[variant].rows[0].build.relics
      const cutoff = best * (1 - tolerance)
      const freshOf = (row: Any) =>
        PARTS.filter((part) => {
          const relic = row.build.relics[part]
          return relic && relic.enhance === 0 && relic.id !== currentIds[part] && !duplicateIds.has(relic.id)
        })
      // Per +0 relic: the best row where it is the only +0 piece, and the
      // best row it appears in at all. Only the first isolates what levelling
      // it is worth: in a row shared with a stronger +0 piece the gain is not its own.
      const seen = new Map<string, Any>()
      for (const row of rows) {
        if (row.stats.COMBO < cutoff) break
        const fresh = freshOf(row)
        for (const part of fresh) {
          const id = row.build.relics[part].id
          const entry = seen.get(id) ?? { part }
          entry.anyRow ??= { row, fresh }
          if (fresh.length === 1) entry.soloRow ??= { row, fresh }
          seen.set(id, entry)
        }
      }
      const guaranteed: Any[] = []
      const potential: Any[] = []
      let withoutUpside = 0
      let unscored = 0
      for (const { part, soloRow, anyRow } of seen.values()) {
        const { row, fresh } = soloRow ?? anyRow
        const relic = row.build.relics[part]
        const incumbent = incumbents[part] ? scoreOfRelic(incumbents[part]) : null
        const scored = scoreOfRelic(relic)
        const entry = {
          slot: part,
          ...scored,
          substats: relic.substats.map((substat: Any) => ({ stat: substat.stat, value: substat.value })),
          heldBy: relic.equippedBy && relic.equippedBy !== characterId ? relic.equippedBy : null,
          // false: within the scanned rows it only shows up next to other +0 pieces, so the figures are the combination's.
          standalone: soloRow != null,
          floorCombo: row.stats.COMBO,
          deltaVsLeveledBest: row.stats.COMBO - best,
          deltaVsLeveledBestPercent: ((row.stats.COMBO - best) / best) * 100,
          replaces: incumbent,
          build: relicIdsOf(row.build),
          alsoUnleveled: fresh.filter((other: string) => other !== part),
          conflicts: row.build.conflicts ?? [],
        }
        if (soloRow && row.stats.COMBO > best) guaranteed.push(entry)
        else if (scored.potentialBestPercent == null) unscored++
        // Within the tolerance band a relic is worth a look only if its best
        // case ends above the piece it would replace.
        else if (scored.potentialBestPercent > (incumbent?.potentialNowPercent ?? 0)) potential.push(entry)
        else withoutUpside++
      }
      guaranteed.sort((a, b) => b.floorCombo - a.floorCombo)
      potential.sort((a, b) => (b.potentialAveragePercent ?? 0) - (a.potentialAveragePercent ?? 0))
      const lowest = rows.at(-1)?.stats.COMBO ?? null
      // The best build once +0 relics count, which may need several of them levelled together.
      const top = rows[0] && rows[0].stats.COMBO > best && freshOf(rows[0]).length
        ? {
          floorCombo: rows[0].stats.COMBO,
          deltaVsLeveledBestPercent: ((rows[0].stats.COMBO - best) / best) * 100,
          unleveled: freshOf(rows[0]),
          build: relicIdsOf(rows[0].build),
          conflicts: rows[0].build.conflicts ?? [],
        }
        : null
      return {
        ...empty,
        // False when the scanned rows end above the tolerance cutoff: candidates further down were not seen.
        bandCovered: rows.length < args.candidateRows || (lowest != null && lowest < cutoff),
        lowestScannedPercent: lowest != null ? ((lowest - best) / best) * 100 : null,
        bestWithUnleveled: top,
        guaranteed,
        potential,
        withoutUpside,
        unscored,
      }
    }

    const enhanceFloor = effective.enhance ?? 0
    if (enhanceFloor > 0) {
      worthLeveling.skipped = `强化等级下限为 ${enhanceFloor},+0 遗器不在范围内`
    } else {
      await timed('candidates', async () => {
        let remainingMs = args.budgetSeconds * 1000
        for (const [index, variant] of variants.entries()) {
          const reference = leveled[variant]
          if (!reference.rows?.length) {
            worthLeveling.variants[variant] = { skipped: '该口径第一遍没有结果,无从比较' }
            continue
          }
          // The cheaper "free" variant goes first on an even share; whatever it leaves is carried over.
          const budgetMs = remainingMs / (variants.length - index)
          const overrides = reference.formOverrides
          const steps: Any[] = []
          for (const gate of UNLEVELED_GATES) {
            const relicPool = { unleveledMinWeightedRolls: gate }
            const estimated = await estimate(overrides, relicPool)
            const previous = steps.at(-1)?.permutations ?? reference.permutations
            // A gate that admits nothing new repeats a search already done.
            if (estimated.validPermutations > previous) {
              steps.push({ gate, relicPool, permutations: estimated.validPermutations, unleveledKept: estimated.relicPool?.unleveledKept ?? null })
            }
          }
          let usedMs = 0
          let ran: Any = null
          let ranIndex = -1
          for (;;) {
            let next = -1
            for (let i = steps.length - 1; i > ranIndex; i--) {
              if (projectMs(steps[i].permutations) <= budgetMs - usedMs) {
                next = i
                break
              }
            }
            if (next < 0) break
            const step = steps[next]
            log(`第二遍 ${variant}: 门槛 ${step.gate},${step.permutations.toLocaleString('en-US')} 排列`)
            const found = await search(overrides, step.relicPool, args.candidateRows)
            if (!found) return
            const { optimized, wallMs, searchMs } = found
            Object.assign(step, { ran: true, durationMs: searchMs, wallMs })
            usedMs += wallMs
            ran = { step, optimized }
            ranIndex = next
          }
          remainingMs -= usedMs
          const report: Any = {
            budgetMs: Math.round(budgetMs),
            usedMs,
            gate: ran?.step.gate ?? null,
            unleveledAdmitted: ran?.step.unleveledKept ?? 0,
            steps: steps.map(({ relicPool: _relicPool, ...step }) => step),
          }
          if (ran) {
            passes.push({
              pass: 'candidates',
              variant,
              relicPool: ran.step.relicPool,
              minWeightedRolls: reference.minWeightedRolls,
              exhaustive: ran.step.gate === 0 && reference.exhaustive,
              permutations: ran.step.permutations,
              durationMs: ran.step.durationMs,
              wallMs: ran.step.wallMs,
              rows: ran.optimized.rows,
              comboBest: ran.optimized.rows[0]?.stats.COMBO ?? null,
            })
            Object.assign(report, candidatesOf(variant, ran.optimized.rows))
            if (!report.bandCovered) {
              warnings.push(
                `${variant} 口径的待强化候选只覆盖到距最优 ${report.lowestScannedPercent.toFixed(2)}% 处(扫描 ${report.rowsScanned} 行),`
                  + `不足 ${(tolerance * 100).toFixed(0)}% 的容差范围,更靠后的候选未列出(可调高 candidateRows)`,
              )
            }
          } else if (steps.length) {
            report.skipped = `预算内最严的门槛 ${steps[0].gate} 也跑不完(预计 ${Math.round(projectMs(steps[0].permutations) / 1000)} 秒)`
            warnings.push(`${variant} 口径未做 +0 遗器候选搜索:${report.skipped},可调高 budgetSeconds`)
          } else {
            report.skipped = '没有 +0 遗器能通过表单自身的过滤条件'
          }
          worthLeveling.variants[variant] = report
        }
      })
    }
    output.worthLeveling = worthLeveling
    const haltedAfterCandidates = await finishHalted()
    if (haltedAfterCandidates) return haltedAfterCandidates

    // ── Farming advice: weak pieces of the main list's best build ──────────
    if (topRow) {
      await timed('farmAdvice', async () => {
        const simulation = scoring.simulations?.dps ?? Object.values(scoring.simulations ?? {})[0]
        const setCounts = countBy(PARTS.map((part) => topRow.build.relics[part]?.set).filter(Boolean))
        const pieces: Any[] = []
        for (const part of PARTS) {
          const relic = topRow.build.relics[part]
          if (!relic) continue
          const count = setCounts.get(relic.set) ?? 0
          const piece: Any = {
            slot: part,
            ...scoreOfRelic(relic),
            setBonusActive: count >= 2,
            // With three of a set two remain after a swap; with two or four a bonus is lost.
            setLocked: count === 2 || count === 4,
          }
          // Stamina days to farm a piece at least this good: the lower, the cheaper to beat.
          const scored = await tryCall('score_relics', {
            characterId,
            relicFilters: { part, set: relic.set, mainStat: relic.main.stat, enhance: enhanceOf(relic) },
            includeEstTbp: true,
            limit: RELIC_PAGE_SIZE,
          })
          const days = scored.ok
            ? scored.data.relics.filter((entry: Any) => entry.id === relic.id).map((entry: Any) => entry.estTbpDays).find((value: Any) => value != null)
            : null
          pieces.push({ ...piece, estTbpDays: days ?? null })
        }
        const rated = pieces.filter((piece) => piece.percentScore != null)
        const bestPercent = Math.max(...rated.map((piece) => piece.percentScore))
        for (const piece of pieces) {
          const reasons: string[] = []
          if (piece.percentScore != null && piece.percentScore < WEAK_PIECE_PERCENT) reasons.push('评级低于 B')
          if (piece.percentScore != null && bestPercent - piece.percentScore >= WEAK_PIECE_GAP_PERCENT) {
            reasons.push(`比这套里最好的一件低 ${Math.floor((bestPercent - piece.percentScore) / RATING_TIER_PERCENT)} 档`)
          }
          piece.weak = reasons.length > 0
          if (reasons.length) piece.weakReason = reasons.join(',')
        }
        const recommendedRelicSets = [...new Set((simulation?.relicSets ?? []).flat())]
        const recommendedOrnaments = [...new Set(simulation?.ornamentSets ?? [])]
        output.farmAdvice = {
          build: `${mainVariant} 口径下只用已强化遗器的最优配装(主榜单第 1 行)`,
          ratingScale: '评级每档 5%:F / D / C / B / A / S / SS / SSS / WTF 各带 + 号,共 18 档;评分只看副词条,主词条不对时为 ?',
          pieces,
          targets: pieces
            .filter((piece: Any) => piece.weak)
            .sort((a, b) => a.percentScore - b.percentScore)
            .map((piece) => {
              const ornament = ORNAMENT_PARTS.includes(piece.slot)
              const recommended = ornament ? recommendedOrnaments : recommendedRelicSets
              return {
                slot: piece.slot,
                source: ornament ? '位面饰品(模拟宇宙/差分宇宙)' : '隧洞遗器(侵蚀隧洞)',
                // A replacement that would break a set bonus has to stay in that set;
                // a loose piece's own set is no reason to farm it.
                sets: piece.setLocked || !recommended.length ? [piece.set] : recommended,
                keepsSetBonus: piece.setLocked,
                mainStats: [...new Set([piece.mainStat, ...(scoring.parts?.[piece.slot] ?? [])])],
                currentRating: piece.rating,
                currentPercent: piece.percentScore,
                estTbpDays: piece.estTbpDays,
                reason: piece.weakReason,
              }
            }),
        }
      })
    }

    output.passes = describePasses()
    await addScores()
    await addFingerprint(main.formOverrides)
    return finish('completed')
  }

  if (tiered) return await runTiered()

  if (!chosen || chosen.permutations === 0) {
    const diagnosis = await tryCall('optimize', { characterId, formOverrides, diagnose: true })
    await addFingerprint(formOverrides)
    return finish('rejected', {
      reason: chosen ? '有效排列为 0' : `无法把有效排列收紧到闸门 ${tightening.gate} 以内`,
      diagnosis: diagnosis.data?.diagnosis ?? null,
    })
  }

  // ── 3. Search (locked strategy) ──────────────────────────────────────────
  log(`optimize: ${chosen.permutations.toLocaleString('en-US')} 排列(初始 ${initialPermutations.toLocaleString('en-US')})`)
  const gpuEngine = args.engine === 'gpu' || args.engine === 'gpu-experimental'
  const optimized = await timed('optimize', () =>
    call('optimize', {
      characterId,
      formOverrides,
      resultsLimit: args.resultsLimit,
      ...(args.engine && { engine: args.engine }),
      ...(gpuEngine && { crossCheck: args.crossCheck === true }),
    }))
  if (optimized.status !== 'completed' && optimized.status !== 'cancelled') {
    return finish('rejected', { reason: optimized.reason ?? `optimize 返回 ${optimized.status}` })
  }

  // A GPU run normally returns the same structured rows as a CPU run. Against
  // a site dist built before the results hook it only has the page grid's
  // display strings, without relic builds and outside the result cache, so
  // COMBO can be reported but swaps cannot be derived from them.
  if (optimized.gpuRows && !optimized.rows) {
    const comboOf = (cells: Any) => {
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
      topRows: optimized.gpuRows.map((row: Any) => ({ combo: comboOf(row.cells) })),
      zeroCostSwaps: null,
      swapSummary: null,
      bestConflictFreeRow: null,
    })
    warnings.push(
      '站点 dist 早于结果钩子:GPU 引擎只返回了网页网格的显示值(取整),不含遗器明细也不进结果缓存,换装分析已跳过——在仓库根目录 npm run build 后重试,或改用默认 CPU 引擎',
    )
    await addScores()
    await addFingerprint(formOverrides)
    return finish('completed')
  }
  await loadDuplicates()
  const rows = optimized.rows ?? []
  const summary = optimized.summary
  if (summary.gridSortColumn !== 'COMBO') warnings.push(`结果按 ${summary.gridSortColumn} 排序而非 COMBO,comboBest 取自首行`)
  const topRow = rows[0] ?? null
  const comboNow = optimized.equippedRow?.stats.COMBO ?? null
  const comboBest = topRow?.stats.COMBO ?? null
  if (gpuEngine && optimized.actualEngine !== args.engine) {
    warnings.push(`请求的是 ${args.engine} 引擎,网页实际以 ${optimized.actualEngine} 引擎完成(设备不可用时会回落),结果按实际引擎理解`)
  }
  if (!rows.length) warnings.push('搜索完成但没有结果行:属性/评分过滤条件可能过严')
  if (!optimized.equippedRow) warnings.push('引擎未返回当前装备的基线行(极快或被取消的运行会这样),comboNow 为空')
  if (comboNow != null && comboBest != null && comboNow > comboBest) {
    warnings.push('当前装备的 COMBO 高于榜首行:当前配装不在本次搜索范围内(套装或主词条被过滤条件排除),并非引擎错误')
  }
  Object.assign(output, {
    optimize: {
      ...(optimized.engine && { engine: optimized.engine }),
      actualEngine: optimized.actualEngine,
      searched: summary.searched,
      durationMs: summary.durationMs,
      cancelled: summary.cancelled,
      sortColumn: summary.gridSortColumn,
      ...(optimized.adapter && { adapter: optimized.adapter }),
      ...(optimized.comparison && { comparison: optimized.comparison }),
      ...(optimized.note && { note: optimized.note }),
    },
    comboNow,
    comboBest,
    topRows: topRowsOf(rows),
  })

  await addScores()

  const freeRow = rows.find((row: Any) => !(row.build.conflicts?.length)) ?? null
  await addSwaps({ topRow, cacheId: summary.cacheId, comboNow, freeRow })
  if (!freeRow && rows.length) warnings.push(`前 ${rows.length} 行都要占用其他角色的遗器,未找到零成本整套配装`)

  await addFingerprint(formOverrides)

  return finish(summary.cancelled ? 'cancelled' : 'completed')
}

export type PlanDiffArgs = {
  /** Earlier team_audit outputs, or the parts of them listed here */
  audits: {
    key?: string,
    characterId: string,
    inventoryFingerprint: { hash: string, relicCount?: number, scope: Any, savedOwnership?: Any },
    roster?: Any[],
    engine?: { gitCommit?: string | null },
  }[],
}

// Which earlier audits no longer describe the save: the relics their search
// could draw on changed, a member's eidolon or light cone changed, or the
// engine build did. Compares fingerprints only and searches nothing.
export async function runPlanDiff(args: PlanDiffArgs, deps: TeamAuditDeps): Promise<Any> {
  const tryCall = (name: string, toolArgs: Record<string, unknown> = {}) => deps.callTool(name, toolArgs)
  const call: Call = async (name, toolArgs = {}) => {
    const result = await tryCall(name, toolArgs)
    if (result.isError) throw new Error(`${name}: ${result.text}`)
    return result.data
  }
  const relics = await loadAllRelics(call)
  const characters = await loadAllCharacters(call)
  const engine = deps.engineFingerprint()
  const savedForms = new Map<string, Promise<Any>>()
  const savedFormOf = (id: string) => {
    if (!savedForms.has(id)) {
      savedForms.set(id, tryCall('get_form', { characterId: id }).then((result) => (result.isError ? null : result.data.form)))
    }
    return savedForms.get(id)!
  }
  const members = new Map<string, Promise<ReturnType<typeof rosterEntryOf>>>()
  const memberNow = (id: string) => {
    if (!members.has(id)) {
      members.set(
        id,
        tryCall('get_form', { characterId: id }).then((result) => rosterEntryOf(id, result.isError ? null : result.data.form)),
      )
    }
    return members.get(id)!
  }

  const audits = []
  for (const [index, baseline] of args.audits.entries()) {
    const current = hashInventoryScope(relics, baseline.characterId, baseline.inventoryFingerprint.scope)
    const relicsChanged = current.hash !== baseline.inventoryFingerprint.hash
    const rosterChanges = []
    for (const before of baseline.roster ?? []) {
      const now = await memberNow(before.characterId)
      for (const field of ROSTER_FIELDS) {
        if ((before[field] ?? null) !== now[field]) {
          rosterChanges.push({ characterId: before.characterId, field, baseline: before[field] ?? null, current: now[field] })
        }
      }
    }
    const ownershipChanged = baseline.inventoryFingerprint.savedOwnership != null
      && !sameOwnership(baseline.inventoryFingerprint.savedOwnership, savedOwnershipOf(await savedFormOf(baseline.characterId), characters))
    const engineChanged = engineDiffers(baseline.engine, engine)
    const reasons = [
      ...(relicsChanged ? ['relicsChanged'] : []),
      ...(rosterChanges.length ? ['rosterChanged'] : []),
      ...(ownershipChanged ? ['ownershipChanged'] : []),
      ...(engineChanged ? ['engineChanged'] : []),
    ]
    audits.push({
      key: baseline.key ?? `${baseline.characterId}#${index}`,
      characterId: baseline.characterId,
      affected: reasons.length > 0,
      reasons,
      relics: {
        changed: relicsChanged,
        baseline: { hash: baseline.inventoryFingerprint.hash, relicCount: baseline.inventoryFingerprint.relicCount ?? null },
        current: { hash: current.hash, relicCount: current.relicCount },
      },
      // Without a baseline roster nothing about the members was compared.
      rosterCompared: baseline.roster != null,
      rosterChanges,
    })
  }
  return {
    engine,
    audits,
    affected: audits.filter((audit) => audit.affected).map((audit) => audit.key),
    unaffected: audits.filter((audit) => !audit.affected).map((audit) => audit.key),
  }
}
