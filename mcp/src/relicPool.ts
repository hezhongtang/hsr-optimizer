// Per-run relic pool restriction for `optimize` and `permutations`.
//
// The upstream form filters apply one rule to every relic: `enhance` is a floor
// for all of them and `weights.minWeightedRolls` a threshold for all of them.
// Neither can say "every levelled relic, plus the +0 relics that are good
// enough", which is the pool a search needs once +0 relics dominate the
// inventory (they are valued with a levelled main stat and their initial
// substats only, so most of them are dead weight in the permutation count).
//
// A pool restriction never touches the loaded save. It resolves to the set of
// excluded +0 relics, and each consumer searches a copy without them:
//   - the estimate swaps the relic store's list for the duration of one
//     synchronous call (withRelicPool), so the upstream counting recipe stays
//     the single source of truth
//   - the CPU driver and the GPU page are handed a pruned save copy (pruneSave)
// The upstream filters still run on top of whatever the pool leaves.
//
// Relic ids are not a safe key on their own: a save can hold the same id twice
// (a stale +0 record next to the levelled one). Exclusion is therefore by store
// object where the store is read, and by "this id AND still +0" on save copies,
// so the levelled twin of an excluded record always stays in the pool.

import { applyFlatStatScaling } from 'lib/relics/scoring/scoringConstants'
import {
  substatMinRolls,
  weightedSubstatMinRolls,
} from 'lib/relics/scoring/substatScoring'
import { getCharacterById } from 'lib/stores/character/characterStore'
import {
  getRelics,
  useRelicStore,
} from 'lib/stores/relic/relicStore'
import type { Form } from 'types/form'
import type { Relic } from 'types/relic'
import { z } from 'zod'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

// Strict: a misspelt key would otherwise mean "no restriction" and, with
// force, a search of the whole inventory.
export const relicPoolSchema = z.strictObject({
  excludeUnleveled: z.boolean().optional().describe('true = +0 遗器全部不进候选池(只搜已强化的遗器)'),
  unleveledMinWeightedRolls: z.number().min(0).optional().describe(
    '+0 遗器的准入门槛:加权强化次数(与 weights.minWeightedRolls 同一口径,按本次表单的权重计)达到该值才进候选池;已强化的遗器不受影响',
  ),
}).describe(
  '本次运行的遗器候选池限制(不改存档,也不改表单):只约束 +0 遗器,已强化(enhance>0)的遗器与角色当前穿戴的遗器始终保留,'
    + '表单自身的过滤条件照常叠加。两个字段二选一;都不给等于不限制',
)

export const relicPoolEchoSchema = z.object({
  excludeUnleveled: z.boolean().optional(),
  unleveledMinWeightedRolls: z.number().optional(),
  unleveledTotal: z.number().int().describe('库存里 +0 遗器的总数'),
  unleveledKept: z.number().int().describe('留在候选池里的 +0 遗器数(含角色当前穿戴的)'),
  excluded: z.number().int().describe('被本次限制排除的遗器数'),
})

export type RelicPoolInput = z.infer<typeof relicPoolSchema>
export type RelicPoolEcho = z.infer<typeof relicPoolEchoSchema>
export type ResolvedRelicPool = {
  /** The excluded store records themselves */
  excludedRelics: Set<Relic>,
  /** Their ids — only meaningful together with "enhance is 0" (see header) */
  excludedIds: Set<string>,
  echo: RelicPoolEcho,
}

const isUnleveled = (relic: { enhance?: number }) => !(relic.enhance! > 0)

// Mirrors relicFilters.ts hasAchievableWeightedSubstat: a relic whose main stat
// blocks every weighted substat cannot meet a threshold and is exempt upstream.
function hasAchievableWeightedSubstat(weights: Record<string, number>, mainStat: string): boolean {
  for (const stat in weights) {
    if (stat === 'minWeightedRolls') continue
    if (weights[stat] > 0 && stat !== mainStat) return true
  }
  return false
}

// Mirrors relicFilters.ts computeWeightScore: preview substats count when the
// main-stat upscale level would reveal them.
function weightScore(relic: Relic, weights: Record<string, number>, upgradeLevel: number): number {
  let score = weightedSubstatMinRolls(relic.substats, weights as Any)
  if (upgradeLevel) {
    const previews = relic.previewSubstats ?? []
    for (let i = 0; i < previews.length; i++) {
      if (relic.enhance + 3 * i >= upgradeLevel) break
      score += substatMinRolls(previews[i].stat, previews[i].value || 0) * (weights[previews[i].stat] || 0)
    }
  }
  return score
}

/** Resolve a pool restriction against the live inventory; null when it restricts nothing. */
export function resolveRelicPool(request: Form, pool: RelicPoolInput | undefined): ResolvedRelicPool | null {
  if (!pool) return null
  const { excludeUnleveled, unleveledMinWeightedRolls } = pool
  if (excludeUnleveled === true && unleveledMinWeightedRolls != null) {
    throw new Error('relicPool: excludeUnleveled 与 unleveledMinWeightedRolls 二选一——前者排除全部 +0 遗器,后者按门槛放行其中一部分')
  }
  if (excludeUnleveled !== true && unleveledMinWeightedRolls == null) return null

  const weights: Record<string, number> = { ...(request.weights as Any) }
  applyFlatStatScaling(weights)
  const worn = new Set(Object.values(getCharacterById(request.characterId)?.equipped ?? {}).filter((id) => id != null))
  const relics = getRelics()
  // A worn id can also have a stale +0 record; the levelled record is the worn one.
  const leveledIds = new Set(relics.filter((relic) => !isUnleveled(relic)).map((relic) => relic.id))

  const excludedRelics = new Set<Relic>()
  let unleveledTotal = 0
  for (const relic of relics) {
    if (!isUnleveled(relic)) continue
    unleveledTotal++
    if (worn.has(relic.id) && !leveledIds.has(relic.id)) continue
    const passes = excludeUnleveled !== true
      && (!hasAchievableWeightedSubstat(weights, relic.main.stat)
        || weightScore(relic, weights, request.mainStatUpscaleLevel) >= unleveledMinWeightedRolls!)
    if (!passes) excludedRelics.add(relic)
  }

  return {
    excludedRelics,
    excludedIds: new Set([...excludedRelics].map((relic) => relic.id)),
    echo: {
      ...(excludeUnleveled === true ? { excludeUnleveled: true } : { unleveledMinWeightedRolls }),
      unleveledTotal,
      unleveledKept: unleveledTotal - excludedRelics.size,
      excluded: excludedRelics.size,
    },
  }
}

/**
 * Run a synchronous read of the relic store against the restricted pool. The
 * store's list is swapped and restored inside this one call, so nothing else
 * can observe the restricted list; `fn` must not await.
 */
export function withRelicPool<T>(pool: ResolvedRelicPool | null, fn: () => T): T {
  if (!pool || pool.excludedRelics.size === 0) return fn()
  const relics = getRelics()
  useRelicStore.setState({ relics: relics.filter((relic) => !pool.excludedRelics.has(relic)) })
  try {
    return fn()
  } finally {
    useRelicStore.setState({ relics })
  }
}

/**
 * A save-shaped copy without the excluded relics. Equipped references to them
 * are dropped too, so the copy never points at a relic it does not hold. The
 * input is not modified.
 */
export function pruneSave<T extends { relics?: Any[], characters?: Any[] }>(save: T, pool: ResolvedRelicPool | null): T {
  if (!pool || pool.excludedRelics.size === 0) return save
  const relics = (save.relics ?? []).filter((relic) => !(pool.excludedIds.has(relic.id) && isUnleveled(relic)))
  const kept = new Set(relics.map((relic) => relic.id))
  const gone = (id: unknown) => id != null && !kept.has(id as string)
  return {
    ...save,
    relics,
    characters: (save.characters ?? []).map((character) => {
      const equipped = character.equipped ?? {}
      if (!Object.values(equipped).some(gone)) return character
      return { ...character, equipped: Object.fromEntries(Object.entries(equipped).filter(([, id]) => !gone(id))) }
    }),
  }
}
