// Shared permutation-estimation recipe — the single source of truth used by
// both the `optimize` scale gate and the `permutations` query tool, so the
// pre-run estimate an agent sees is exactly the estimate the gate checks.
//
//   - applyFormOverrides: merge display-state patches and internal Form aliases
//     onto a display state (nested maps merge key-wise)
//   - estimatePermutations: same recipe as upstream
//     optimizerFormActions.recalculatePermutations
//     (RelicFilters.getFilteredRelicCounts + set-solver valid count)
//   - constraintSuggestions + PERMUTATION_GATE: gate verdict & tightening tips

import {
  CombatBuffs,
  Constants,
  RelicSetFilterOptions,
} from 'lib/constants/constants'
import {
  computeValidPermutationCount,
  generateOrnamentSetSolutions,
  generateRelicSetSolutions,
} from 'lib/optimization/relicSetSolver'
import { RelicFilters } from 'lib/relics/relicFilters'
import {
  createDefaultRatingFilters,
  createDefaultStatFilters,
  createDefaultTeammate,
} from 'lib/stores/optimizerForm/optimizerFormDefaults'
import type { SetFilters } from 'lib/stores/optimizerForm/setFilterTypes'
import { TwoPieceSlotType } from 'lib/stores/optimizerForm/setFilterTypes'
import type { Form } from 'types/form'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

export const PERMUTATION_GATE = 5e7

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STAT_FILTER_KEYS = new Set(Object.keys(createDefaultStatFilters()))
const RATING_FILTER_KEYS = new Set(Object.keys(createDefaultRatingFilters()))
const PERCENTAGE_STAT_KEYS = new Set([
  'minCr',
  'maxCr',
  'minCd',
  'maxCd',
  'minEhr',
  'maxEhr',
  'minRes',
  'maxRes',
  'minBe',
  'maxBe',
  'minErr',
  'maxErr',
])
const PERCENTAGE_BUFF_KEYS = new Set(Object.values(CombatBuffs).filter((buff) => buff.percent).map((buff) => buff.key))
const INTERNAL_ALIAS_KEYS = new Set([
  ...STAT_FILTER_KEYS,
  ...RATING_FILTER_KEYS,
  'teammate0',
  'teammate1',
  'teammate2',
  'relicSets',
  'ornamentSets',
])

function mergePartial(current: Any, patch: Any): Any {
  if (!isPlainObject(current) || !isPlainObject(patch)) return patch
  const merged: Any = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = mergePartial(current[key], value)
  }
  return merged
}

function mergeTeammate(current: Any, patch: unknown): Any {
  if (patch == null) return createDefaultTeammate()
  if (!isPlainObject(patch)) throw new Error('Teammate overrides must be objects or null (to clear a slot)')
  return mergePartial(current ?? createDefaultTeammate(), patch)
}

/** Reverse displayToInternal's unit conversion and comparison tolerance. */
function internalStatToDisplay(key: string, value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number or null`)
  const isMin = key.startsWith('min')
  if (value === (isMin ? 0 : Constants.MAX_INT)) return undefined
  const isPercent = PERCENTAGE_STAT_KEYS.has(key)
  // Undo the tolerance here so a complete get_form template round-trips rather
  // than widening its bounds again on each use.
  const tolerance = isPercent ? 0.000001 : 0.0001
  const display = value + (isMin ? tolerance : -tolerance)
  return isPercent ? display * 100 : display
}

function internalRelicSetsToDisplay(value: unknown): Pick<SetFilters, 'fourPiece' | 'twoPieceCombos'> {
  if (!Array.isArray(value)) throw new Error('relicSets must be an array of internal set-filter tuples')
  const result: Pick<SetFilters, 'fourPiece' | 'twoPieceCombos'> = { fourPiece: [], twoPieceCombos: [] }
  for (const filter of value) {
    if (!Array.isArray(filter)) throw new Error('Each relicSets filter must be a tuple')
    const [pieces, first, second] = filter
    const any = { type: TwoPieceSlotType.Any } as const
    const set = (name: Any) => ({ type: TwoPieceSlotType.Set, value: name } as const)
    if (pieces === RelicSetFilterOptions.relic4Piece && filter.length === 2 && typeof first === 'string') {
      result.fourPiece.push(first as Any)
    } else if (pieces === RelicSetFilterOptions.relic2Plus2Piece && filter.length === 3 && typeof first === 'string' && typeof second === 'string') {
      result.twoPieceCombos.push({ a: set(first), b: set(second) })
    } else if (pieces === RelicSetFilterOptions.relic2PlusAny && filter.length === 2 && typeof first === 'string') {
      result.twoPieceCombos.push({ a: set(first), b: any })
    } else if (pieces === RelicSetFilterOptions.relic2Plus2Any && filter.length === 1) {
      result.twoPieceCombos.push({ a: any, b: any })
    } else {
      throw new Error(`Unsupported relicSets filter: ${JSON.stringify(filter)}`)
    }
  }
  return result
}

/**
 * Display patches retain their existing units. Flat internal filters, teammate
 * slots and set aliases are also accepted, and take precedence over their
 * display equivalents. For the ambiguous combatBuffs map, explicit format wins;
 * otherwise an internal-only key selects fractions and a display patch selects
 * percentages. Convert only supplied keys so partial patches keep saved values.
 */
export function applyFormOverrides(state: Any, overrides: Record<string, unknown>): void {
  const format = overrides.format
  if (format !== undefined && format !== 'internal' && format !== 'display') {
    throw new Error('formOverrides.format must be "internal" or "display"')
  }
  const internalBuffs = format === 'internal'
    || (format === undefined && Object.keys(overrides).some((key) => INTERNAL_ALIAS_KEYS.has(key) && overrides[key] !== undefined))

  // Validate public field names and identity before applying any patch.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || key === 'format' || INTERNAL_ALIAS_KEYS.has(key)) continue
    if (key === 'resultMinFilter' && value === 0) continue
    if (!Object.hasOwn(state, key)) throw new Error(`Unsupported formOverrides field "${key}"`)
    if (key === 'characterId' && value !== state.characterId) {
      throw new Error('formOverrides.characterId must match the requested character')
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || key === 'format' || INTERNAL_ALIAS_KEYS.has(key)) continue
    // Returned forms contain this runtime-owned default; the optimizer always
    // sets it to zero. Reject a requested non-default rather than discard it.
    if (key === 'resultMinFilter' && value === 0) continue
    if (key === 'teammates') {
      if (!Array.isArray(value) || value.length > 3) throw new Error('teammates must be an array of at most three slots')
      state.teammates = state.teammates.map((mate: Any, index: number) => index < value.length ? mergeTeammate(mate, value[index]) : mate)
    } else if (key === 'combatBuffs') {
      if (!isPlainObject(value)) throw new Error('combatBuffs must be an object')
      const buffs = Object.fromEntries(
        Object.entries(value).map(([buff, amount]) => [
          buff,
          internalBuffs && PERCENTAGE_BUFF_KEYS.has(buff as Any) && typeof amount === 'number' ? amount * 100 : amount,
        ]),
      )
      state.combatBuffs = mergePartial(state.combatBuffs, buffs)
    } else {
      state[key] = mergePartial(state[key], value)
    }
  }

  // Internal aliases win independently of object property insertion order.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    if (STAT_FILTER_KEYS.has(key)) state.statFilters[key] = internalStatToDisplay(key, value)
    else if (RATING_FILTER_KEYS.has(key)) state.ratingFilters[key] = value
    else if (/^teammate[012]$/.test(key)) {
      const index = Number(key.slice(-1))
      state.teammates = [...state.teammates]
      state.teammates[index] = mergeTeammate(state.teammates[index], value)
    }
  }
  if (overrides.relicSets !== undefined) {
    state.setFilters = { ...state.setFilters, ...internalRelicSetsToDisplay(overrides.relicSets) }
  }
  if (overrides.ornamentSets !== undefined) {
    if (!Array.isArray(overrides.ornamentSets)) throw new Error('ornamentSets must be an array')
    state.setFilters = { ...state.setFilters, ornaments: [...overrides.ornamentSets] }
  }
}

export type PermutationEstimate = {
  counts: Record<string, number>,
  preCounts: Record<string, number>,
  validPermutations: number,
  naivePermutations: number,
}

/** Same recipe as upstream optimizerFormActions.recalculatePermutations. */
export function estimatePermutations(request: Form): PermutationEstimate {
  const { counts, preCounts, countsBySet } = RelicFilters.getFilteredRelicCounts(request)
  const validPermutations = computeValidPermutationCount(
    countsBySet,
    generateRelicSetSolutions(request),
    generateOrnamentSetSolutions(request),
  )
  const naivePermutations = counts.Head * counts.Hands * counts.Body * counts.Feet * counts.PlanarSphere * counts.LinkRope
  return { counts, preCounts, validPermutations, naivePermutations }
}

export function constraintSuggestions(request: Form): string[] {
  const tips: string[] = []
  if (!request.relicSets?.length) tips.push('Set relicSets (e.g. a 4pc or 2+2 relic set filter)')
  if (!request.ornamentSets?.length) tips.push('Set ornamentSets (planar ornament set filter)')
  if (!request.mainBody?.length) tips.push('Narrow mainBody (body main stat candidates)')
  if (!request.mainFeet?.length) tips.push('Narrow mainFeet (feet main stat candidates)')
  if (!request.mainPlanarSphere?.length) tips.push('Narrow mainPlanarSphere (sphere main stat candidates)')
  if (!request.mainLinkRope?.length) tips.push('Narrow mainLinkRope (rope main stat candidates)')
  if (!request.weights?.minWeightedRolls) tips.push('Raise weights.minWeightedRolls (weight-score floor prunes relics)')
  if (request.includeEquippedRelics) tips.push('Set includeEquippedRelics=false (drops relics equipped by others)')
  tips.push('Or pass force=true to run anyway — CPU throughput is roughly 1e6 permutations/sec')
  return tips
}

/** Gate verdict the optimize tool would apply to this estimate. */
export function gateVerdict(estimate: PermutationEstimate): {
  gate: number,
  wouldReject: boolean,
  reason: string,
} {
  const wouldReject = estimate.validPermutations > PERMUTATION_GATE
  return {
    gate: PERMUTATION_GATE,
    wouldReject,
    reason: wouldReject
      ? `valid permutations ${estimate.validPermutations.toLocaleString()} exceed the ${PERMUTATION_GATE.toExponential()} gate`
      : `valid permutations ${estimate.validPermutations.toLocaleString()} are within the ${PERMUTATION_GATE.toExponential()} gate`,
  }
}
