// Duplicate relic ids in the loaded inventory — detection only, never repair.
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
// restore can surface it; choosing which record to keep changes user data and
// is left to the caller.

import { useRelicStore } from 'lib/stores/relic/relicStore'

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
