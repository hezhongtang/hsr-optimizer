// M8 full-state sync: entity-level diff over the save shape (task A).
//
// `diffFullSyncState(oldSave, newSave)` compares two `readStructuredSnapshot()`
// results and produces the entity ops that carry `old` to `new`:
//   - character / relic / team — array collections diffed by id
//     (upsert = whole entity replaced, delete = id gone; the web editor's
//     save semantics ARE whole-entity persistence, so payloads are the full
//     save-shaped entity — identical to what a snapshot delivers, letting the
//     client apply snapshot entities and op entities through one path)
//   - scoringOverrides / settings / savedSession / showcasePreferences /
//     optimizerMenuState / relicsTab — whole-object patches whose payload is
//     the full new value (apply-side deep-merges, so a full value and a partial
//     patch converge to the same result)
//
// The diff key set mirrors the persisted keys of SaveState.save()
// (src/lib/state/saveState.ts:62-107 = mcp/src/saveSnapshot.ts:47-102) for
// exactly the collections the frozen protocol's FullSyncEntity set names.
// Other persisted keys (version / warpRequest / relicLocator / ahaSpeedTuner /
// scannerSettings / completedMigrations / seenFeatures) are server-side
// configuration surfaces with no protocol entity — their changes produce no
// ops, and clients that need them take a snapshot on resync.
//
// Contract: this module is a pure function over plain JSON data. It never
// clones: op payloads ALIAS objects inside `newSave`, so the caller must own
// private snapshots (the server structured-clones before diffing) and must
// keep `newSave` alive as long as it keeps the produced ops (the server stores
// the same snapshot as its lastBroadcastSnapshot, satisfying that).

import type { HsrOptimizerSaveFormat } from 'types/store'
import type { FullSyncEntity } from './fullSyncProtocol'
import type { FullSyncOp } from './fullSyncProtocol'

/** The op shape carried inside broadcast/resync messages (see fullSyncProtocol). */
export type FullSyncDiffOp = Omit<FullSyncOp, 'type' | 'sessionId' | 'opId' | 'baseRevision'>

/**
 * Key-order-insensitive deep equality over plain JSON data. Arrays are
 * order-sensitive (relic substat order and team order are meaningful); object
 * key order is not (an MCP-built {...found, form: {...}} character must not
 * read as different from the web's copy of the same data).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

function entityId(entity: unknown): string | null {
  if (typeof entity !== 'object' || entity === null) return null
  const id = (entity as { id?: unknown }).id
  return typeof id === 'string' ? id : null
}

/** Diff one id-keyed array collection into upsert/delete ops (whole entity). */
function diffCollectionById(
  ops: FullSyncDiffOp[],
  entity: FullSyncEntity,
  before: unknown,
  after: unknown,
): void {
  const beforeList = Array.isArray(before) ? before : []
  const afterList = Array.isArray(after) ? after : []
  const beforeById = new Map<string, unknown>()
  for (const item of beforeList) {
    const id = entityId(item)
    if (id != null) beforeById.set(id, item)
  }
  const afterById = new Map<string, unknown>()
  for (const item of afterList) {
    const id = entityId(item)
    if (id != null) afterById.set(id, item)
  }
  for (const [id, item] of afterById) {
    const previous = beforeById.get(id)
    if (previous === undefined || !deepEqual(previous, item)) {
      ops.push({ entity, action: 'upsert', id, payload: item })
    }
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) ops.push({ entity, action: 'delete', id, payload: null })
  }
}

/** Diff one whole-object patch entity: a single patch op when it changed. */
function diffWholeObject(
  ops: FullSyncDiffOp[],
  entity: FullSyncEntity,
  before: unknown,
  after: unknown,
): void {
  if (!deepEqual(before, after)) {
    ops.push({ entity, action: 'patch', payload: after as unknown })
  }
}

/**
 * Entity ops that carry `oldSave` to `newSave`, in a stable order
 * (collections first, then whole-object patches; within a collection upserts
 * in collection order, then deletes). Both inputs must be private snapshots
 * (see the module header contract).
 */
export function diffFullSyncState(oldSave: HsrOptimizerSaveFormat, newSave: HsrOptimizerSaveFormat): FullSyncDiffOp[] {
  const ops: FullSyncDiffOp[] = []
  diffCollectionById(ops, 'character', oldSave.characters, newSave.characters)
  diffCollectionById(ops, 'relic', oldSave.relics, newSave.relics)
  diffCollectionById(
    ops,
    'team',
    oldSave.savedSession?.global?.teamShowcaseSavedTeams,
    newSave.savedSession?.global?.teamShowcaseSavedTeams,
  )
  diffWholeObject(ops, 'scoringOverrides', oldSave.scoringMetadataOverrides, newSave.scoringMetadataOverrides)
  diffWholeObject(ops, 'settings', oldSave.settings, newSave.settings)
  diffWholeObject(ops, 'savedSession', oldSave.savedSession, newSave.savedSession)
  diffWholeObject(ops, 'showcasePreferences', oldSave.showcasePreferences, newSave.showcasePreferences)
  diffWholeObject(ops, 'optimizerMenuState', oldSave.optimizerMenuState, newSave.optimizerMenuState)
  diffWholeObject(
    ops,
    'relicsTab',
    oldSave.excludedRelicPotentialCharacters,
    newSave.excludedRelicPotentialCharacters,
  )
  return ops
}
