// M8 full-state sync server (task A): the MCP side of the bidirectional
// bridge defined by mcp/src/bridge/fullSyncProtocol.ts (frozen contract).
//
// One websocket listener (its own port, default 23314; started via
// sync_bridge_start(bidirectional=true) — see domains/bridge.ts) hosts any
// number of web-client sessions speaking the FullSync* message family:
//
//   client → server : hello / op / resource/fetch / resolve
//   server → client : welcome / snapshot / ack / conflict / broadcast /
//                      resync / job / resource/response
//
// Coordination model (protocol header anchors):
//   - runtimeContext.revision is the commit counter. A web op applies inside
//     runtimeContext.withChange('fullSync.op', …) with the baseRevision and
//     save-generation checks INSIDE the scope (dequeue-time, TOCTOU-closed).
//     Any rejection answers with a FullSyncConflict — never silent.
//   - Entity application reuses the exact upstream write chains the MCP tools
//     use (web-edit parity; file:line in each case below).
//   - After a commit (web op or MCP tool) the server diffs
//     lastBroadcastSnapshot → current stores (fullSyncDiff.ts) and broadcasts
//     the entity ops to every session EXCEPT the sessions whose ops were
//     applied since the last broadcast (echo rule 2 of the protocol header).
//     The web side suppresses capture while applying remote writes, so a
//     bounced change never re-sends (echo rule 1).
//   - Commits are broadcast from the in-memory store state — the sync truth —
//     even when the save-file write-back is held by the anti-wipe guard
//     (unlike the one-way archiver bridge, which only ever pushes persisted
//     frames; there every client sees persisted bytes, here every client sees
//     the same live state as the writer).
//   - Resync: a ring buffer (capacity 256) of {revision, saveGeneration, ops}.
//     hello.lastRevision inside the buffer range and the same generation →
//     resync with the missed ops; anything else (restart, load_save
//     saveGeneration bump, too old, client ahead of the server) → full
//     snapshot. A save swap resets the buffer and pushes snapshots to every
//     session — ops from a previous save can never land on the new one.
//   - opId dedupe: per-session FIFO cache (1024); a retried opId re-acks.
//
// stdout carries only MCP frames — every log goes to stderr (console.error is
// shim-redirected).

import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import * as equipmentService from 'lib/services/equipmentService'
import { SaveState } from 'lib/state/saveState'
import { useGlobalStore } from 'lib/stores/app/appStore'
import {
  getCharacterById,
  useCharacterStore,
} from 'lib/stores/character/characterStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { getRelicById } from 'lib/stores/relic/relicStore'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
import { useRelicsTabStore } from 'lib/tabs/tabRelics/useRelicsTabStore'
import type { ShowcaseTabSavedSession } from 'lib/tabs/tabShowcase/showcaseTabTypes'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import {
  readSavedTeams,
  writeSavedTeams,
} from 'lib/tabs/tabTeamShowcase/teamShowcaseController'
import { uuid } from 'lib/utils/miscUtils'
import type { Character } from 'types/character'
import type { CharacterId } from 'types/character'
import type { Relic } from 'types/relic'
import type { UnaugmentedRelic } from 'types/relic'
import type {
  GlobalSavedSession,
  HsrOptimizerSaveFormat,
  TeamShowcaseSavedTeam,
  UserSettings,
} from 'types/store'
import {
  WebSocket,
  WebSocketServer,
} from 'ws'

import { runtimeContext } from '../context'
import { onJobEvent } from '../domains/jobs'
import type { JobRegistryEvent } from '../domains/jobs'
import { readStructuredSnapshot } from '../saveSnapshot'
import { serializeBuild } from '../serializers/builds'
import { diffFullSyncState } from './fullSyncDiff'
import type { FullSyncDiffOp } from './fullSyncDiff'
import { FULL_SYNC_PROTOCOL_VERSION } from './fullSyncProtocol'
import type {
  FullSyncBroadcast,
  FullSyncClientMessage,
  FullSyncConflict,
  FullSyncEntity,
  FullSyncJobEvent,
  FullSyncOp,
  FullSyncResolve,
  FullSyncResourceRequest,
  FullSyncResourceResponse,
  FullSyncResync,
  FullSyncSnapshot,
  FullSyncWelcome,
} from './fullSyncProtocol'

const FULL_SYNC_HOST = '127.0.0.1'
export const FULL_SYNC_DEFAULT_PORT = 23314
/** Committed-op ring buffer: reconnect window servable by resync. */
const HISTORY_CAPACITY = 256
/** Per-session opId dedupe cache (retries beyond this window re-apply). */
const OP_ID_CACHE = 1024
/** resource/fetch row cap (protocol: rows are trimmed, never unbounded). */
const RESOURCE_ROW_LIMIT = 256
/** ws inbound payload cap — entity payloads are small; snapshots are outbound. */
const MAX_INBOUND_BYTES = 16 * 1024 * 1024

const ENTITIES = new Set<FullSyncEntity>([
  'character',
  'relic',
  'team',
  'scoringOverrides',
  'settings',
  'savedSession',
  'showcasePreferences',
  'optimizerMenuState',
  'relicsTab',
])
const ACTIONS = new Set<FullSyncOp['action']>(['upsert', 'delete', 'patch'])
const ID_ENTITIES = new Set<FullSyncEntity>(['character', 'relic', 'team'])

type FullSyncSession = {
  socket: WebSocket,
  /** Server-issued identity (welcome.sessionId); '' before hello. */
  sessionId: string,
  /** Client's self label from hello (logs only). */
  client: string,
  /** Save generation the client is synced to — ops against anything else conflict. */
  generation: number,
  /** Latest revision this session has been told (welcome/snapshot/resync/broadcast/ack). */
  deliveredRevision: number,
  /** hello seen (ops before hello cannot have a trustworthy generation). */
  helloSeen: boolean,
  /** opId dedupe: FIFO cache. */
  seenOpIds: Set<string>,
  seenOpIdQueue: string[],
}

type ActiveFullSync = {
  port: number,
  server: WebSocketServer,
  sessions: Set<FullSyncSession>,
}

type HistoryEntry = {
  revision: number,
  saveGeneration: number,
  ops: FullSyncDiffOp[],
}

export type FullSyncStatus = {
  running: boolean,
  port: number | null,
  url: string | null,
  sessions: number,
  revision: number,
  saveGeneration: number,
  /** Sessions whose ops were applied since the last broadcast (excluded from it). */
  bufferedOps: number,
  broadcasts: number,
  snapshots: number,
  resyncs: number,
  opsApplied: number,
  conflicts: number,
  jobEvents: number,
}

// ─── module state ────────────────────────────────────────────────────────────

let active: ActiveFullSync | null = null
let sessionSeq = 0
/** Committed-op ring (oldest first); reset on save swaps. */
const history: HistoryEntry[] = []
/**
 * Snapshot the last broadcast/snapshot was computed from — the diff base for
 * the next broadcast. Private clone (structuredClone in snapshotForSync): the
 * live stores alias their values, so an un-cloned base would drift in place.
 */
let lastBroadcastSnapshot: HsrOptimizerSaveFormat | null = null
let lastBroadcastRevision = -1
let lastBroadcastGeneration = -1
/**
 * Sessions whose ops were applied since the last broadcast — excluded from it
 * (protocol echo rule: the source session gets its ack, others the broadcast).
 * Residual race, documented: when a web op and an unrelated MCP write commit
 * inside one debounce window, the source session also misses the MCP part
 * until the next broadcast or a reconnect snapshot — entity-granular per-session
 * diffs would be needed to close that, which the frozen protocol's single
 * broadcast shape does not carry.
 */
const originExcluded = new Set<string>()
// Save-swap deferral: setSave/clearSave run INSIDE a withChange scope whose
// rollback would un-bump the generation — the deferred check compares the
// flagged generation against the live one and skips rolled-back swaps.
let pendingSwapGeneration: number | null = null
let swapTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeJobs: (() => void) | null = null
const stats = {
  broadcasts: 0,
  snapshots: 0,
  resyncs: 0,
  opsApplied: 0,
  conflicts: 0,
  jobEvents: 0,
}
/** Last pushed job signature per id (status+progress) — collapse no-op events. */
const lastJobPush = new Map<string, { status: string, progress: number | undefined }>()

// ─── small helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fullSyncUrl(port: number): string {
  return `ws://${FULL_SYNC_HOST}:${port}/sync`
}

/** Private deep clone of the current store state (see lastBroadcastSnapshot). */
function snapshotForSync(): HsrOptimizerSaveFormat {
  runtimeContext.ensureMetadataReady()
  return structuredClone(readStructuredSnapshot())
}

/** Whole-entity/whole-object deep merge: objects merge recursively, arrays and
 * primitives replace (a full-object patch payload converges to itself). */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value)
  }
  return out as T
}

function sendTo(session: FullSyncSession, message: FullSyncClientMessage): boolean {
  if (session.socket.readyState !== WebSocket.OPEN) return false
  try {
    session.socket.send(JSON.stringify(message), (error) => {
      if (error) console.error(`[fullSync] 发送失败(session ${session.sessionId}): ${String(error)}`)
    })
    return true
  } catch (e) {
    console.error(`[fullSync] 发送异常(session ${session.sessionId}): ${String(e)}`)
    return false
  }
}

function sendConflict(session: FullSyncSession, opId: string, reason: FullSyncConflict['reason']): void {
  stats.conflicts++
  const conflict: FullSyncConflict = {
    type: 'conflict',
    opId,
    serverRevision: runtimeContext.getRevision(),
    reason,
    choices: ['reload', 'reapply'],
  }
  sendTo(session, conflict)
}

function sendSnapshotTo(session: FullSyncSession): void {
  const revision = runtimeContext.getRevision()
  const generation = runtimeContext.getSaveGeneration()
  const snapshot: FullSyncSnapshot = {
    type: 'snapshot',
    sessionId: session.sessionId,
    revision,
    saveGeneration: generation,
    save: snapshotForSync() as unknown as Record<string, unknown>,
  }
  if (sendTo(session, snapshot)) {
    session.generation = generation
    session.deliveredRevision = revision
    stats.snapshots++
  }
}

// ─── op application (upstream write chains, one per entity) ─────────────────

/** Op rejection mapped onto the frozen conflict reasons (never silent). */
class OpRejectedError extends Error {
  constructor(public reason: FullSyncConflict['reason']) {
    super(`fullSync op rejected: ${reason}`)
  }
}

function requireEntityId(op: FullSyncOp): string {
  if (typeof op.id !== 'string' || op.id.length === 0) throw new OpRejectedError('unknown-entity')
  return op.id
}

/**
 * character upsert — whole-entity replace, the web editor's save semantics.
 * Update path = setCharacter (mcp/src/domains/form.ts:1410 同款); new entity =
 * addCharacter (the importer's add path; setCharacter only maps existing ids).
 * The save shape (form/builds/portrait/equipped) is the store shape — applied
 * as-is, exactly what SaveState.save serializes and load restores.
 */
function applyCharacterUpsert(op: FullSyncOp): void {
  const payload = op.payload
  if (!isRecord(payload)) throw new OpRejectedError('unknown-entity')
  const id = requireEntityId(op)
  if (payload.id !== id) throw new OpRejectedError('unknown-entity')
  if (!isRecord(payload.form)) throw new OpRejectedError('unknown-entity')
  const character = payload as unknown as Character
  const store = useCharacterStore.getState()
  if (getCharacterById(character.id) != null) store.setCharacter(character)
  else store.addCharacter(character)
}

/** character delete — equipmentService.removeCharacter (unequip every relic,
 * then drop the character): the web 删除角色 path, mcp/src/domains/equipment.ts:683 同款. */
function applyCharacterDelete(op: FullSyncOp): void {
  const id = requireEntityId(op)
  if (getCharacterById(id as CharacterId) == null) throw new OpRejectedError('unknown-entity')
  equipmentService.removeCharacter(id as CharacterId)
}

/**
 * relic upsert — save-shaped payload through RelicAugmenter.augment then
 * equipmentService.upsertRelicWithEquipment (add / part-change unequip / equip
 * with the global Replace/Swap setting): the same chain as
 * mcp/src/domains/relics.ts:845 (upsert_relic) and the save-load path
 * processRelics (persistenceService.ts) — augment rebuilds the derived
 * augmentedStats/rolls a save file never persists.
 */
function applyRelicUpsert(op: FullSyncOp): void {
  const payload = op.payload
  if (!isRecord(payload)) throw new OpRejectedError('unknown-entity')
  const id = requireEntityId(op)
  if (payload.id !== id) throw new OpRejectedError('unknown-entity')
  if (!isRecord(payload.main) || typeof payload.part !== 'string' || !Array.isArray(payload.substats)) {
    throw new OpRejectedError('unknown-entity')
  }
  const equippedBy = payload.equippedBy
  if (equippedBy != null && (typeof equippedBy !== 'string' || getCharacterById(equippedBy as CharacterId) == null)) {
    // equipRelic silently drops equipment for unknown owners — reject instead
    // (never silently re-write the client's entity).
    throw new OpRejectedError('unknown-entity')
  }
  const augmented = RelicAugmenter.augment(structuredClone(payload) as unknown as UnaugmentedRelic)
  if (augmented == null) throw new OpRejectedError('unknown-entity')
  augmented.id = id
  equipmentService.upsertRelicWithEquipment(augmented as Relic)
}

/** relic delete — equipmentService.removeRelic + permitEmptySave:
 * mcp/src/domains/relics.ts:917-923 (delete_relics) 同款. */
function applyRelicDelete(op: FullSyncOp): void {
  const id = requireEntityId(op)
  if (getRelicById(id) == null) throw new OpRejectedError('unknown-entity')
  equipmentService.removeRelic(id)
  SaveState.permitEmptySave()
}

/** team upsert — whole-entity replace in the saved-team list via
 * writeSavedTeams (the ONLY storage the web's showcase page uses):
 * mcp/src/domains/teams.ts:417 (save_team) 同款. */
function applyTeamUpsert(op: FullSyncOp): void {
  const payload = op.payload
  if (!isRecord(payload)) throw new OpRejectedError('unknown-entity')
  const id = requireEntityId(op)
  if (payload.id !== id || typeof payload.name !== 'string' || !Array.isArray(payload.characterIds)) {
    throw new OpRejectedError('unknown-entity')
  }
  const teams = readSavedTeams()
  const index = teams.findIndex((team) => team.id === id)
  const team = payload as unknown as TeamShowcaseSavedTeam
  if (index === -1) teams.push(team)
  else teams[index] = team
  writeSavedTeams(teams)
}

/** team delete — filtered writeSavedTeams: mcp/src/domains/teams.ts:561 同款. */
function applyTeamDelete(op: FullSyncOp): void {
  const id = requireEntityId(op)
  const teams = readSavedTeams()
  if (!teams.some((team) => team.id === id)) throw new OpRejectedError('unknown-entity')
  writeSavedTeams(teams.filter((team) => team.id !== id))
}

/** settings patch — setSettings with merged full object:
 * mcp/src/domains/state.ts:831 (update_state settings) 同款. */
function applySettingsPatch(op: FullSyncOp): void {
  if (!isRecord(op.payload)) throw new OpRejectedError('unknown-entity')
  const global = useGlobalStore.getState()
  global.setSettings(deepMerge(global.settings, op.payload) as UserSettings)
}

/**
 * savedSession patch — payload {global?, showcaseTab?} deep-merged into the
 * two host stores: global via useGlobalStore.setSavedSession (whole-object
 * semantics), showcaseTab via useShowcaseTabStore.setSavedSession (merge
 * semantics): mcp/src/domains/state.ts:844-861 同款.
 */
function applySavedSessionPatch(op: FullSyncOp): void {
  if (!isRecord(op.payload)) throw new OpRejectedError('unknown-entity')
  const { global: globalPatch, showcaseTab: showcasePatch } = op.payload as {
    global?: unknown,
    showcaseTab?: unknown,
  }
  if (globalPatch != null) {
    const store = useGlobalStore.getState()
    store.setSavedSession(deepMerge(store.savedSession, globalPatch) as GlobalSavedSession)
  }
  if (showcasePatch != null) {
    const store = useShowcaseTabStore.getState()
    store.setSavedSession(deepMerge(store.savedSession, showcasePatch) as ShowcaseTabSavedSession)
  }
}

/** scoringOverrides patch — setScoringMetadataOverrides(deepMerge(current, payload)):
 * the reset write in mcp/src/domains/equipment.ts:1183 同款 setter. */
function applyScoringOverridesPatch(op: FullSyncOp): void {
  if (!isRecord(op.payload)) throw new OpRejectedError('unknown-entity')
  const store = useScoringStore.getState()
  store.setScoringMetadataOverrides(deepMerge(store.scoringMetadataOverrides as Record<string, unknown>, op.payload))
}

/** showcasePreferences patch — setShowcasePreferences(deepMerge(current, payload)):
 * the whole-object setter behind mcp/src/domains/state.ts showcase 段. */
function applyShowcasePreferencesPatch(op: FullSyncOp): void {
  if (!isRecord(op.payload)) throw new OpRejectedError('unknown-entity')
  const store = useShowcaseTabStore.getState()
  store.setShowcasePreferences(deepMerge(store.showcasePreferences as Record<string, unknown>, op.payload))
}

/** optimizerMenuState patch — setMenuState(deepMerge(current, payload)):
 * mcp/src/domains/state.ts layout 段 同款 setter. */
function applyOptimizerMenuStatePatch(op: FullSyncOp): void {
  if (!isRecord(op.payload)) throw new OpRejectedError('unknown-entity')
  const store = useOptimizerDisplayStore.getState()
  store.setMenuState(deepMerge(store.menuState as Record<string, boolean>, op.payload))
}

/**
 * relicsTab patch — payload is the excludedRelicPotentialCharacters array
 * (the persisted shape of the relicsTab entity; arrays replace, not merge):
 * setExcludedRelicPotentialCharacters = mcp/src/domains/state.ts:966 同款.
 */
function applyRelicsTabPatch(op: FullSyncOp): void {
  const payload = op.payload
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.excludedRelicPotentialCharacters)
    ? payload.excludedRelicPotentialCharacters
    : null
  if (list == null || list.some((id) => typeof id !== 'string')) throw new OpRejectedError('unknown-entity')
  useRelicsTabStore.getState().setExcludedRelicPotentialCharacters(list as CharacterId[])
}

function applyEntityOp(op: FullSyncOp): void {
  switch (op.entity) {
    case 'character':
      if (op.action === 'upsert') applyCharacterUpsert(op)
      else if (op.action === 'delete') applyCharacterDelete(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'relic':
      if (op.action === 'upsert') applyRelicUpsert(op)
      else if (op.action === 'delete') applyRelicDelete(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'team':
      if (op.action === 'upsert') applyTeamUpsert(op)
      else if (op.action === 'delete') applyTeamDelete(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'settings':
      if (op.action === 'patch') applySettingsPatch(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'savedSession':
      if (op.action === 'patch') applySavedSessionPatch(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'scoringOverrides':
      if (op.action === 'patch') applyScoringOverridesPatch(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'showcasePreferences':
      if (op.action === 'patch') applyShowcasePreferencesPatch(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'optimizerMenuState':
      if (op.action === 'patch') applyOptimizerMenuStatePatch(op)
      else throw new OpRejectedError('unknown-entity')
      return
    case 'relicsTab':
      if (op.action === 'patch') applyRelicsTabPatch(op)
      else throw new OpRejectedError('unknown-entity')
      return
  }
}

type OpOutcome =
  | { ok: true, revision: number }
  | { ok: false, reason: FullSyncConflict['reason'] }

/**
 * Apply one client op as a transacted change. Both conflict checks run INSIDE
 * the queued scope (dequeue-time), closing the dispatch-time TOCTOU window —
 * exactly the pattern the MCP write tools use with withChange(baseRevision).
 */
async function applySessionOp(session: FullSyncSession, op: FullSyncOp): Promise<OpOutcome> {
  try {
    await runtimeContext.withChange(`fullSync.op(${op.entity})`, () => {
      // Generation first: ops composed against a previous save (before a
      // load_save swap) must never land on the current one.
      if (session.generation !== runtimeContext.getSaveGeneration()) {
        throw new OpRejectedError('save-generation')
      }
      // baseRevision inside the scope — see withChange's TOCTOU note.
      if (op.baseRevision !== runtimeContext.getRevision()) {
        throw new OpRejectedError('stale-revision')
      }
      applyEntityOp(op)
      runtimeContext.markDirty()
    })
  } catch (e) {
    if (e instanceof OpRejectedError) return { ok: false, reason: e.reason }
    // Unexpected application failure: still a visible rejection (closest frozen
    // reason), with the real error on stderr — never a silent drop.
    console.error(`[fullSync] op 应用异常(${op.entity}/${op.action ?? '?'}): ${String((e as Error)?.message ?? e)}`)
    return { ok: false, reason: 'unknown-entity' }
  }
  stats.opsApplied++
  return { ok: true, revision: runtimeContext.getRevision() }
}

// ─── commit broadcast machinery ──────────────────────────────────────────────

/**
 * Diff lastBroadcastSnapshot → current stores and broadcast the entity ops at
 * the current revision to every session except the origins. Idempotent: a
 * revision already broadcast (or a generation transition, owned by the swap
 * path) is a no-op, so the flush hook and the post-op call can both run.
 */
function broadcastCommittedState(): void {
  const activeNow = active
  if (activeNow == null) return
  const revision = runtimeContext.getRevision()
  const generation = runtimeContext.getSaveGeneration()
  if (generation !== lastBroadcastGeneration) return // save swap path owns this
  if (revision <= lastBroadcastRevision) return
  const snapshot = snapshotForSync()
  const ops = diffFullSyncState(lastBroadcastSnapshot!, snapshot)
  history.push({ revision, saveGeneration: generation, ops })
  if (history.length > HISTORY_CAPACITY) history.splice(0, history.length - HISTORY_CAPACITY)
  const message: FullSyncBroadcast = { type: 'broadcast', revision, saveGeneration: generation, ops }
  for (const session of activeNow.sessions) {
    if (originExcluded.has(session.sessionId)) continue
    if (sendTo(session, message)) session.deliveredRevision = revision
  }
  lastBroadcastSnapshot = snapshot
  lastBroadcastRevision = revision
  stats.broadcasts++
  originExcluded.clear()
}

/**
 * Commit hook for context.flushSave() — additive call site in
 * mcp/src/context.ts (clean-flush path, next to bridgeNotifyChange). Pushes
 * the just-persisted state to the sync clients; a no-op while the full-sync
 * server is not running (the snapshot base then re-initializes at start).
 */
export function fullSyncNotifyCommitted(): void {
  try {
    if (active == null) return
    broadcastCommittedState()
  } catch (e) {
    console.error(`[fullSync] 提交广播失败: ${String(e)}`)
  }
}

/**
 * Save-swap hook for context.setSave()/clearSave() (additive call sites):
 * load_save/reset bump saveGeneration, which invalidates the op buffer and
 * every client's revision base. Deferred one macrotask so a withChange
 * rollback (which restores the generation) cancels the push; then every
 * session receives a fresh snapshot and the ring buffer resets.
 */
export function fullSyncNotifySaveSwapped(): void {
  pendingSwapGeneration = runtimeContext.getSaveGeneration()
  if (swapTimer != null) return
  swapTimer = setTimeout(() => {
    swapTimer = null
    const flagged = pendingSwapGeneration
    pendingSwapGeneration = null
    if (flagged == null || active == null) return
    if (runtimeContext.getSaveGeneration() !== flagged) return // rolled back
    try {
      pushSnapshotToAllSessions()
    } catch (e) {
      console.error(`[fullSync] 换档快照推送失败: ${String(e)}`)
    }
  }, 0)
}

function pushSnapshotToAllSessions(): void {
  const activeNow = active
  if (activeNow == null) return
  // Generation boundary: buffered ops belong to the previous save.
  history.length = 0
  originExcluded.clear()
  for (const session of activeNow.sessions) sendSnapshotTo(session)
  lastBroadcastSnapshot = snapshotForSync()
  lastBroadcastRevision = runtimeContext.getRevision()
  lastBroadcastGeneration = runtimeContext.getSaveGeneration()
  console.error(
    `[fullSync] 存档世代切换 → 已向 ${activeNow.sessions.size} 个会话推送快照`
      + `(revision ${lastBroadcastRevision},generation ${lastBroadcastGeneration})`,
  )
}

// ─── job events (jobs.ts registry hook → FullSyncJobEvent) ───────────────────

function jobProgressNumber(event: JobRegistryEvent): number | undefined {
  const progress = event.progress
  if (progress.totalPermutations != null && progress.totalPermutations > 0 && progress.searched != null) {
    return Math.min(1, Math.max(0, progress.searched / progress.totalPermutations))
  }
  if (progress.totalPresets != null && progress.totalPresets > 0 && progress.completedPresets != null) {
    return Math.min(1, Math.max(0, progress.completedPresets / progress.totalPresets))
  }
  return undefined
}

/** cacheId reference only while the result cache still holds that run. */
function jobResultRef(event: JobRegistryEvent): { cacheId?: string, rows?: number } | undefined {
  if (event.status !== 'completed' || event.kind !== 'optimize') return undefined
  // optimize jobs use the cacheId AS the jobId (the optimizer registers the
  // job under it) and the finishJob summary payload does not repeat it — fall
  // back to the jobId so the ref resolves without touching the caller shape.
  const cacheId = typeof event.summary.cacheId === 'string' ? event.summary.cacheId : event.jobId
  if (typeof cacheId !== 'string') return undefined
  const cached = runtimeContext.getLastOptimizeResult()
  if (cached == null || cached.summary.cacheId !== cacheId) return undefined
  return { cacheId, rows: cached.rows.length }
}

function pushJobEvent(event: JobRegistryEvent): void {
  const activeNow = active
  if (activeNow == null || activeNow.sessions.size === 0) return
  const progress = jobProgressNumber(event)
  const previous = lastJobPush.get(event.jobId)
  if (previous != null && previous.status === event.status && previous.progress === progress) return
  lastJobPush.set(event.jobId, { status: event.status, progress })
  if (lastJobPush.size > 128) {
    const oldest = lastJobPush.keys().next().value
    if (oldest !== undefined) lastJobPush.delete(oldest)
  }
  const resultRef = jobResultRef(event)
  const message: FullSyncJobEvent = {
    type: 'job',
    jobId: event.jobId,
    kind: event.kind,
    status: event.status,
    ...(progress != null ? { progress } : {}),
    ...(resultRef != null ? { resultRef } : {}),
  }
  stats.jobEvents++
  for (const session of activeNow.sessions) sendTo(session, message)
}

function wireJobEvents(): void {
  unsubscribeJobs?.()
  lastJobPush.clear()
  unsubscribeJobs = onJobEvent((event) => {
    try {
      pushJobEvent(event)
    } catch (e) {
      console.error(`[fullSync] 任务事件推送失败: ${String(e)}`)
    }
  })
}

// ─── resource/fetch (optimize results behind a cacheId reference) ────────────

/** Numeric stat projection of a result row — the get_results row shape
 * (mcp/src/domains/optimizer.ts:226 serializeRowStats: numbers, id skipped). */
function serializeRowForResource(row: Record<string, unknown>): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'id' && typeof value === 'number') stats[key] = value
  }
  return stats
}

function handleResourceFetch(session: FullSyncSession, message: FullSyncResourceRequest): void {
  const respond = (ok: boolean, rows?: unknown[], error?: string): void => {
    const response: FullSyncResourceResponse = {
      type: 'resource/response',
      requestId: message.requestId,
      ok,
      ...(rows !== undefined ? { rows } : {}),
      ...(error != null ? { error } : {}),
    }
    sendTo(session, response)
  }
  if (message.resource !== 'optimize-results') {
    respond(false, undefined, `未知资源 "${String(message.resource)}" — 仅支持 optimize-results`)
    return
  }
  const cached = runtimeContext.getLastOptimizeResult()
  if (cached == null) {
    respond(false, undefined, '没有已缓存的优化结果 — 请先在服务器侧运行 optimize')
    return
  }
  if (message.cacheId != null && message.cacheId !== cached.summary.cacheId) {
    respond(false, undefined, `cacheId 不匹配:请求 ${message.cacheId},当前缓存 ${cached.summary.cacheId}`)
    return
  }
  if (cached.generation !== runtimeContext.getSaveGeneration()) {
    respond(false, undefined, '缓存结果属于上一次载入的存档 — 请对当前存档重新运行 optimize(get_results 同款世代门)')
    return
  }
  let entries = cached.rows.map((row, index) => ({ row, build: cached.builds[index] ?? {} }))
  if (message.rowIds != null) {
    const wanted = new Set(message.rowIds.map(String))
    entries = entries.filter(({ row }) => wanted.has(String(row.id)))
    if (entries.length === 0) {
      respond(false, undefined, `rowIds 未命中任何行 — 缓存共 ${cached.rows.length} 行,行 id 见 optimize 返回的 rows[].id`)
      return
    }
  }
  const limit = message.limit != null ? Math.max(1, Math.min(RESOURCE_ROW_LIMIT, Math.floor(message.limit))) : RESOURCE_ROW_LIMIT
  const page = entries.slice(0, limit)
  respond(
    true,
    page.map(({ row, build }) => ({
      id: row.id,
      stats: serializeRowForResource(row as unknown as Record<string, unknown>),
      build: serializeBuild(build, cached.summary.characterId),
    })),
  )
}

// ─── hello / resync ──────────────────────────────────────────────────────────

/** Reconnect catch-up viability: every revision in (lastRevision, current]
 * must still be in the ring buffer AND everything committed must have been
 * broadcast (a pending unbroadcast change means only a snapshot can converge). */
function resyncFromBuffer(lastRevision: number): boolean {
  const currentRevision = runtimeContext.getRevision()
  const currentGeneration = runtimeContext.getSaveGeneration()
  if (lastRevision > currentRevision) return false // client ahead: stale from another life
  if (lastRevision === currentRevision) return true // fully current, nothing to send
  if (currentRevision !== lastBroadcastRevision) return false // pending commit not yet broadcast
  if (currentGeneration !== lastBroadcastGeneration) return false
  if (history.length === 0) return false
  return lastRevision + 1 >= history[0].revision // no gap at the ring's start
}

function handleHello(session: FullSyncSession, message: { client?: unknown, saveGeneration?: unknown, lastRevision?: unknown }): void {
  session.sessionId = `fss-${++sessionSeq}-${uuid().slice(0, 8)}`
  session.client = typeof message.client === 'string' ? message.client : ''
  session.seenOpIds.clear()
  session.seenOpIdQueue.length = 0
  session.helloSeen = true

  const revision = runtimeContext.getRevision()
  const generation = runtimeContext.getSaveGeneration()
  const welcome: FullSyncWelcome = {
    type: 'welcome',
    protocol: FULL_SYNC_PROTOCOL_VERSION,
    sessionId: session.sessionId,
    revision,
    saveGeneration: generation,
  }
  sendTo(session, welcome)

  const lastRevision = typeof message.lastRevision === 'number' && Number.isInteger(message.lastRevision)
    ? message.lastRevision
    : null
  const clientGeneration = typeof message.saveGeneration === 'number' && Number.isInteger(message.saveGeneration)
    ? message.saveGeneration
    : null

  if (lastRevision == null || clientGeneration !== generation || !resyncFromBuffer(lastRevision)) {
    // Fresh client / save swapped / buffer gone (restart) / too old / ahead —
    // the snapshot is the universal convergence point.
    sendSnapshotTo(session)
    return
  }
  if (lastRevision < revision) {
    // Only the entries the client has NOT applied — replaying older ones is
    // idempotent (whole-entity ops) but resurrects deleted entities transiently.
    const ops = history.filter((entry) => entry.revision > lastRevision).flatMap((entry) => entry.ops)
    const resync: FullSyncResync = { type: 'resync', revision, saveGeneration: generation, ops }
    sendTo(session, resync)
    stats.resyncs++
  }
  session.generation = generation
  session.deliveredRevision = revision
  console.error(
    `[fullSync] 会话 ${session.sessionId}(${session.client || 'unnamed'})握手:`
      + `revision ${lastRevision} → ${revision}${lastRevision < revision ? '(resync)' : '(current)'}`,
  )
}

function handleResolve(session: FullSyncSession, message: FullSyncResolve): void {
  if (message.choice === 'reload') {
    console.error(`[fullSync] 会话 ${session.sessionId} 对 op ${message.opId} 选择 reload → 推送快照`)
    sendSnapshotTo(session)
  } else {
    // reapply: the client re-sends the op itself against the fresh revision.
    console.error(`[fullSync] 会话 ${session.sessionId} 对 op ${message.opId} 选择 reapply(等待客户端重发)`)
  }
}

// ─── wire message parsing / dispatch ─────────────────────────────────────────

function parseOp(session: FullSyncSession, raw: Record<string, unknown>): FullSyncOp | null {
  const opId = raw.opId
  if (typeof opId !== 'string' || opId.length === 0) return null
  const baseRevision = raw.baseRevision
  if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision)) return null
  const entity = raw.entity
  if (typeof entity !== 'string' || !ENTITIES.has(entity as FullSyncEntity)) return null
  const action = raw.action
  if (typeof action !== 'string' || !ACTIONS.has(action as FullSyncOp['action'])) return null
  const id = raw.id
  if (ID_ENTITIES.has(entity as FullSyncEntity) && (typeof id !== 'string' || id.length === 0)) return null
  if ((action === 'upsert' || action === 'patch') && raw.payload === undefined) return null
  return {
    type: 'op',
    sessionId: session.sessionId,
    opId,
    baseRevision,
    entity: entity as FullSyncEntity,
    action: action as FullSyncOp['action'],
    ...(id != null ? { id: id as string } : {}),
    payload: raw.payload,
  }
}

function rememberOpId(session: FullSyncSession, opId: string): void {
  session.seenOpIds.add(opId)
  session.seenOpIdQueue.push(opId)
  if (session.seenOpIdQueue.length > OP_ID_CACHE) {
    const evicted = session.seenOpIdQueue.shift()
    if (evicted !== undefined) session.seenOpIds.delete(evicted)
  }
}

async function handleWireMessage(session: FullSyncSession, data: unknown): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(data))
  } catch {
    console.error(`[fullSync] 会话 ${session.sessionId || 'pre-hello'} 发来无法解析的消息,已忽略`)
    return
  }
  if (!isRecord(parsed)) return
  switch (parsed.type) {
    case 'hello': {
      if (parsed.protocol !== FULL_SYNC_PROTOCOL_VERSION) {
        console.error(
          `[fullSync] 客户端协议版本 ${String(parsed.protocol)} 不兼容(本服务 ${FULL_SYNC_PROTOCOL_VERSION})→ 断开`,
        )
        session.socket.close(1002, 'protocol version mismatch')
        return
      }
      handleHello(session, parsed)
      return
    }
    case 'op': {
      if (!session.helloSeen) {
        // No trustworthy generation without a handshake — a visible rejection,
        // never a silent drop.
        sendConflict(session, typeof parsed.opId === 'string' ? parsed.opId : '', 'save-generation')
        return
      }
      const op = parseOp(session, parsed)
      if (op == null) {
        console.error(`[fullSync] 会话 ${session.sessionId} 发来无效 op,已拒收:${JSON.stringify(parsed).slice(0, 200)}`)
        sendConflict(session, typeof parsed.opId === 'string' ? parsed.opId : '', 'unknown-entity')
        return
      }
      if (session.seenOpIds.has(op.opId)) {
        // Retry of an already-applied op: idempotent re-ack at the current revision.
        sendTo(session, { type: 'ack', opId: op.opId, revision: runtimeContext.getRevision() })
        return
      }
      const outcome = await applySessionOp(session, op)
      if (!outcome.ok) {
        sendConflict(session, op.opId, outcome.reason)
        return
      }
      rememberOpId(session, op.opId)
      originExcluded.add(session.sessionId)
      // Persist promptly (the debounced flush would also work; doing it here
      // keeps web edits on disk within the op round-trip) — then broadcast the
      // commit to the other sessions (idempotent: a flush-driven broadcast of
      // the same revision is a no-op). Broadcasts mirror the in-memory truth
      // even when the file write-back is guard-blocked (see file header).
      try {
        runtimeContext.flushSave()
      } catch (e) {
        console.error(`[fullSync] op 提交后的立即落盘失败(等待防抖写回): ${String(e)}`)
      }
      try {
        broadcastCommittedState()
      } catch (e) {
        console.error(`[fullSync] op 提交广播失败: ${String(e)}`)
      }
      sendTo(session, { type: 'ack', opId: op.opId, revision: runtimeContext.getRevision() })
      return
    }
    case 'resolve': {
      if (typeof parsed.opId !== 'string') return
      const choice = parsed.choice === 'reload' ? 'reload' : parsed.choice === 'reapply' ? 'reapply' : null
      if (choice == null) return
      handleResolve(session, { type: 'resolve', opId: parsed.opId, choice })
      return
    }
    case 'resource/fetch': {
      if (typeof parsed.requestId !== 'string') return
      // Unknown resources pass through as-is so handleResourceFetch can answer
      // with a visible ok:false error naming them.
      const resource = parsed.resource === 'optimize-results'
        ? ('optimize-results' as const)
        : String(parsed.resource)
      const request: FullSyncResourceRequest = {
        type: 'resource/fetch',
        requestId: parsed.requestId,
        resource: resource as FullSyncResourceRequest['resource'],
        ...(typeof parsed.cacheId === 'string' ? { cacheId: parsed.cacheId } : {}),
        ...(Array.isArray(parsed.rowIds) ? { rowIds: parsed.rowIds.map(String) } : {}),
        ...(typeof parsed.limit === 'number' && Number.isFinite(parsed.limit) ? { limit: parsed.limit } : {}),
      }
      handleResourceFetch(session, request)
      return
    }
    default:
      console.error(`[fullSync] 会话 ${session.sessionId || 'pre-hello'} 发来未知消息类型 "${String(parsed.type)}",已忽略`)
  }
}

// ─── server lifecycle ────────────────────────────────────────────────────────

function initializeBroadcastBase(): void {
  lastBroadcastSnapshot = snapshotForSync()
  lastBroadcastRevision = runtimeContext.getRevision()
  lastBroadcastGeneration = runtimeContext.getSaveGeneration()
  history.length = 0
  originExcluded.clear()
}

export function startFullSyncServer(port: number): Promise<ActiveFullSync> {
  return new Promise((resolve, reject) => {
    let listening = false
    const server = new WebSocketServer({ host: FULL_SYNC_HOST, port, maxPayload: MAX_INBOUND_BYTES })
    const started: ActiveFullSync = { port, server, sessions: new Set() }

    server.on('listening', () => {
      listening = true
      active = started
      initializeBroadcastBase()
      wireJobEvents()
      console.error(
        `[fullSync] 全量同步服务已启动:${fullSyncUrl(port)}(监听 ${FULL_SYNC_HOST}:${port},任意路径)`
          + `——初始基线 revision ${lastBroadcastRevision}/generation ${lastBroadcastGeneration}`,
      )
      resolve(started)
    })

    server.on('error', (error) => {
      if (!listening) {
        try {
          server.close(() => {})
        } catch {
          // 从未成功监听,无需处理
        }
        reject(
          new Error(
            `全量同步服务监听 ${FULL_SYNC_HOST}:${port} 失败:${error.message}`
              + '(端口被占用?请换一个端口重试,或先 sync_bridge_stop 停止现有桥)',
          ),
        )
        return
      }
      console.error(`[fullSync] 服务出错,关闭监听: ${String(error)}`)
      closeFullSyncServer()
    })

    server.on('close', () => {
      if (active === started) active = null
    })

    server.on('connection', (socket) => {
      const session: FullSyncSession = {
        socket,
        sessionId: '',
        client: '',
        generation: -1,
        deliveredRevision: -1,
        helloSeen: false,
        seenOpIds: new Set(),
        seenOpIdQueue: [],
      }
      started.sessions.add(session)
      socket.on('message', (data) => {
        void handleWireMessage(session, data).catch((e) => {
          console.error(`[fullSync] 消息处理异常(session ${session.sessionId}): ${String(e)}`)
        })
      })
      socket.on('close', () => {
        started.sessions.delete(session)
        originExcluded.delete(session.sessionId)
      })
      socket.on('error', (error) => console.error(`[fullSync] 会话连接出错: ${String(error)}`))
      console.error(`[fullSync] 网页端已连接(在线 ${started.sessions.size};等待 hello)`)
    })
  })
}

export async function stopFullSyncServer(): Promise<boolean> {
  const running = active
  if (running == null) return false
  active = null
  for (const session of running.sessions) {
    try {
      session.socket.close(1001, '全量同步服务已停止')
    } catch {
      // 已断开的 socket 无需处理
    }
  }
  running.sessions.clear()
  originExcluded.clear()
  unsubscribeJobs?.()
  unsubscribeJobs = null
  await new Promise<void>((resolve) => running.server.close(() => resolve()))
  console.error(`[fullSync] 全量同步服务已停止(端口 ${running.port})`)
  return true
}

/** Synchronous best-effort close for process-exit hooks (see closeBridge wiring). */
export function closeFullSyncServer(): void {
  const running = active
  if (running == null) return
  active = null
  for (const session of running.sessions) {
    try {
      session.socket.terminate()
    } catch {
      // 已断开的 socket 无需处理
    }
  }
  running.sessions.clear()
  originExcluded.clear()
  if (swapTimer != null) {
    clearTimeout(swapTimer)
    swapTimer = null
  }
  pendingSwapGeneration = null
  unsubscribeJobs?.()
  unsubscribeJobs = null
  try {
    running.server.close(() => {})
  } catch {
    // 监听已关闭时无需处理
  }
  console.error(`[fullSync] 全量同步服务已关闭(端口 ${running.port})`)
}

export function isFullSyncRunning(): boolean {
  return active != null
}

export function getFullSyncStatus(): FullSyncStatus {
  const running = active
  return {
    running: running != null,
    port: running?.port ?? null,
    url: running != null ? fullSyncUrl(running.port) : null,
    sessions: running?.sessions.size ?? 0,
    revision: runtimeContext.getRevision(),
    saveGeneration: runtimeContext.getSaveGeneration(),
    bufferedOps: history.length,
    broadcasts: stats.broadcasts,
    snapshots: stats.snapshots,
    resyncs: stats.resyncs,
    opsApplied: stats.opsApplied,
    conflicts: stats.conflicts,
    jobEvents: stats.jobEvents,
  }
}
