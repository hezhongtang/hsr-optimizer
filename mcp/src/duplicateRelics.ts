// Duplicate relic ids in the loaded inventory: detection on every load, repair
// only when a caller asks for it (dedupe_relics).
//
// A save's `relics` array can carry the same id more than once (two records
// of one relic at different enhance levels). The load chain keeps them all:
//   - persistenceService.loadSaveData does not dedupe (web and MCP share it);
//   - relicStore.setRelics stores the array as-is, while buildRelicsById
//     indexes it last-write-wins — the LAST record in array order is the one
//     every id lookup (getRelicById, serializeBuild, equipped baselines)
//     resolves to;
//   - processRelics walks the array backwards, so the last record is also the
//     first to claim its wearer's slot;
//   - the first upsertRelic / batchUpsertRelics / deleteRelic afterwards
//     rebuilds the array from Object.values(relicsById), silently dropping
//     every record the index does not point at (deleting the duplicated id
//     itself drops all of its records).
// Until that collapse every record that passes the form's relic filters is
// its own optimizer candidate, while detail paths only ever see one of them.
// This module reports the condition so load_save / save_status / the boot
// restore can surface it. Loading never repairs: choosing which record to keep
// changes user data, so that happens only through repairDuplicateRelicIds.
//
// In the saves this was found in, the record the upstream collapse keeps (the
// last one) is the STALE one: an earlier scan of the relic at a lower enhance
// level, re-attached behind the current record by a union import. The repair
// therefore keeps the record with the highest enhance level, and only when the
// other records are provably earlier states of the same relic.

import {
  type Parts,
  Stats,
  type SubStats,
  SubStatValues,
} from 'lib/constants/constants'
import {
  getCharacterById,
  useCharacterStore,
} from 'lib/stores/character/characterStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import type { CharacterId } from 'types/character'
import type { Relic } from 'types/relic'

export type DuplicateRelicRecord = {
  /** Position in the in-memory relics array (= the exported save's order) */
  index: number,
  part: string | null,
  set: string | null,
  enhance: number | null,
  equippedBy: string | null,
  /** True for the record relicsById (and so every id lookup) resolves to */
  resolvedById: boolean,
}

export type DuplicateRelicIds = {
  /** Number of ids that appear more than once (the full total) */
  count: number,
  /** Those ids, in first-appearance order — at most REPORTED_IDS of them */
  ids: string[],
  /** Index-aligned with ids */
  entries: Array<{ id: string, records: DuplicateRelicRecord[] }>,
  /** True when count exceeds the listed ids */
  truncated: boolean,
}

// save_status is polled; a save whose whole inventory got duplicated must not
// turn every status call into a megabyte payload.
const REPORTED_IDS = 50

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Scan the live relic store. Ids are compared as strings, the same coercion
 * the store's own index applies to its keys. */
export function findDuplicateRelicIds(): DuplicateRelicIds {
  const { relics, relicsById } = useRelicStore.getState()
  const recordsById = new Map<string, DuplicateRelicRecord[]>()
  relics.forEach((relic, index) => {
    const id = String(relic.id)
    const records = recordsById.get(id) ?? []
    records.push({
      index,
      part: text(relic.part),
      set: text(relic.set),
      enhance: typeof relic.enhance === 'number' ? relic.enhance : null,
      equippedBy: text(relic.equippedBy),
      resolvedById: relicsById[id] === relic,
    })
    recordsById.set(id, records)
  })
  const duplicated = [...recordsById].filter(([, records]) => records.length > 1)
  const entries = duplicated.slice(0, REPORTED_IDS).map(([id, records]) => ({ id, records }))
  return {
    count: duplicated.length,
    ids: entries.map((entry) => entry.id),
    entries,
    truncated: duplicated.length > entries.length,
  }
}

export const NO_DUPLICATE_RELIC_IDS: DuplicateRelicIds = { count: 0, ids: [], entries: [], truncated: false }

const LISTED_IDS = 20

/** `id(+15/+0)` pairs for the one-line warnings, capped so a badly damaged
 * save cannot flood a summary line. */
export function describeDuplicateRelicIds(duplicates: DuplicateRelicIds): string {
  const listed = duplicates.entries.slice(0, LISTED_IDS).map((entry) => `${entry.id}(${entry.records.map((record) => `+${record.enhance ?? '?'}`).join('/')})`)
  const rest = duplicates.count - listed.length
  return listed.join(', ') + (rest > 0 ? ` …+${rest}` : '')
}

/** A record's substat as stored, so a preview can be checked by eye */
type RecordSubstat = { stat: string, value: number }

export type DuplicateRelicRepair = {
  /** Ids collapsed to one record each */
  merged: Array<{
    id: string,
    part: string,
    set: string,
    kept: { index: number, enhance: number, substats: RecordSubstat[] },
    dropped: Array<{ index: number, enhance: number, equippedBy: string | null, substats: RecordSubstat[] }>,
    /** Who wears the relic afterwards */
    equippedBy: string | null,
    /** Characters whose slot pointed at this id and is now empty */
    unequipped: string[],
  }>,
  /** Ids left as they are, with every record still in the inventory */
  skipped: Array<{ id: string, reason: 'differentRelics', records: Array<{ index: number, part: string, set: string, enhance: number }> }>,
}

const SUBSTAT_EPSILON = 1e-6

const ENHANCES_PER_STEP = 3
const SPD_ROUNDING = 1
const ROLL_WINDOW_ROOM = 0.02

// Unverified records carry SPD rounded down to a whole number, so two records of
// one relic can disagree by up to one point there.
const slack = (stat: string) => (stat === Stats.SPD ? SPD_ROUNDING : SUBSTAT_EPSILON)

// A relic only ever gains: its part, set, rarity and main stat are fixed, and
// each enhance step either adds a substat or raises one. `earlier` can be a
// past state of `later` only if nothing it has is missing or larger there and
// the steps between the two levels pay for everything that differs.
//
// 5-star records also carry solved roll counts. There the counts have to add up
// to exactly those steps, and each substat has to have grown by what its extra
// rolls can give: nothing without a roll, between the low and the high roll with.
//
// Passing is necessary, not sufficient: two different relics that share an id
// can still line up this way, which is why the tool has a preview.
function isEarlierStateOf(earlier: Relic, later: Relic): boolean {
  if (earlier.part !== later.part || earlier.set !== later.set || earlier.grade !== later.grade) return false
  if (earlier.main?.stat !== later.main?.stat) return false
  const steps = Math.floor(later.enhance / ENHANCES_PER_STEP) - Math.floor(earlier.enhance / ENHANCES_PER_STEP)
  const added = later.substats.length - earlier.substats.length
  if (steps < 0 || added < 0) return false

  const solved = later.grade === 5 && [...earlier.substats, ...later.substats].every((substat) => substat.addedRolls != null)
  let raised = 0
  for (const substat of earlier.substats) {
    const grown = later.substats.find((candidate) => candidate.stat === substat.stat)
    if (grown == null) return false
    const gain = grown.value - substat.value
    const tolerance = slack(substat.stat)
    if (gain < -tolerance) return false
    if (gain > tolerance) raised++
    if (!solved) continue
    const rolls = grown.addedRolls! - substat.addedRolls!
    const roll = SubStatValues[substat.stat as SubStats]?.[5]
    if (rolls < 0 || roll == null) return false
    // Saves round substat values, so the window gets a little room: far less than the gap between roll sizes.
    const room = Math.max(tolerance, roll.high * ROLL_WINDOW_ROOM)
    if (gain < rolls * roll.low - room || gain > rolls * roll.high + room) return false
  }
  if (added + raised > steps) return false
  if (!solved) return true

  const rollsOf = (relic: Relic) => relic.substats.reduce((sum, substat) => sum + substat.addedRolls!, 0)
  return added + rollsOf(later) - rollsOf(earlier) === steps
}

const substatsOf = (relic: Relic): RecordSubstat[] => relic.substats.map((substat) => ({ stat: substat.stat, value: substat.value }))

/**
 * Collapse every duplicated id whose records are states of one relic to its
 * highest-enhance record; ids whose records are different relics are skipped.
 *
 * The kept record is worn by whoever wears it now, else by the wearer of a
 * dropped record: a slot that shows this relic keeps showing it, with the
 * current stats. When two characters' slots point at the id only one can keep
 * it, and the other slot is emptied.
 *
 * `apply=false` computes the same report and changes nothing.
 */
export function repairDuplicateRelicIds(apply: boolean): DuplicateRelicRepair {
  const { relics, relicsById } = useRelicStore.getState()
  const { characters } = useCharacterStore.getState()
  const indexOf = new Map(relics.map((relic, index) => [relic, index]))
  const recordsById = new Map<string, Relic[]>()
  for (const relic of relics) {
    const id = String(relic.id)
    recordsById.set(id, [...(recordsById.get(id) ?? []), relic])
  }

  const repair: DuplicateRelicRepair = { merged: [], skipped: [] }
  const dropped = new Set<Relic>()
  const rewritten = new Map<Relic, Relic>()
  const clearedSlots = new Map<CharacterId, Parts[]>()
  for (const [id, records] of recordsById) {
    if (records.length < 2) continue
    // On a tie the record id lookups resolve to wins: what the upstream collapse would keep.
    const kept = records.reduce((best, record) => (
      record.enhance > best.enhance || (record.enhance === best.enhance && relicsById[id] === record) ? record : best
    ))
    const others = records.filter((record) => record !== kept)
    if (!others.every((record) => isEarlierStateOf(record, kept))) {
      repair.skipped.push({
        id,
        reason: 'differentRelics',
        records: records.map((record) => ({ index: indexOf.get(record)!, part: record.part, set: record.set, enhance: record.enhance })),
      })
      continue
    }
    const holders = characters.filter((character) => String(character.equipped?.[kept.part]) === id).map((character) => character.id)
    // A record's wearer counts only while that character's slot still points here.
    // When no record names any of them, the first holder keeps the relic rather than every slot being emptied.
    const wearer = [kept, ...others].map((record) => record.equippedBy).find((owner) => owner != null && holders.includes(owner)) ?? holders[0] ?? null
    const unequipped = holders.filter((holder) => holder !== wearer)
    for (const record of others) dropped.add(record)
    if (kept.equippedBy !== (wearer ?? undefined)) rewritten.set(kept, { ...kept, equippedBy: wearer ?? undefined })
    for (const holder of unequipped) clearedSlots.set(holder, [...(clearedSlots.get(holder) ?? []), kept.part])
    repair.merged.push({
      id,
      part: kept.part,
      set: kept.set,
      kept: { index: indexOf.get(kept)!, enhance: kept.enhance, substats: substatsOf(kept) },
      dropped: others.map((record) => ({
        index: indexOf.get(record)!,
        enhance: record.enhance,
        equippedBy: text(record.equippedBy),
        substats: substatsOf(record),
      })),
      equippedBy: wearer,
      unequipped,
    })
  }

  if (apply && repair.merged.length > 0) {
    useRelicStore.getState().setRelics(relics.filter((relic) => !dropped.has(relic)).map((relic) => rewritten.get(relic) ?? relic))
    for (const [characterId, parts] of clearedSlots) {
      const character = getCharacterById(characterId)
      if (character == null) continue
      const equipped = { ...character.equipped }
      for (const part of parts) equipped[part] = undefined
      useCharacterStore.getState().setCharacter({ ...character, equipped })
    }
  }
  return repair
}
