// M8 full-state sync client (web ⇄ MCP fullSyncServer, see mcp/src/bridge/fullSyncProtocol.ts).
//
// Opt-in only: unless localStorage['hsr-full-sync-url'] is set (or
// window.__HSR_FULL_SYNC.connect(url) is called), this module stays dormant —
// regular users are never touched. Zero new dependencies: native WebSocket.
//
// Capture  : subscribe the persisted stores (the same sources SaveState.save()
//            serializes, saveState.ts:62-107) → 300ms debounce → SaveState.save()
//            → entity-level diff vs lastSyncedSnapshot → per-entity ops.
// Apply    : server messages replay the SAME upstream actions the web UI uses
//            (equipmentService / characterStore / writeSavedTeams / store setters),
//            wrapped in an applyingRemote flag with content-diff echo suppression.
// Conflicts: never silent — a Mantine confirm modal offers reload (snapshot) or
//            reapply (resend at the fresh revision); tests drive it headlessly
//            via window.__HSR_FULL_SYNC.

import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import {
  DefaultSettingOptions,
  SettingOptions,
} from 'lib/constants/settingsConstants'
import * as equipmentService from 'lib/services/equipmentService'
import * as persistenceService from 'lib/services/persistenceService'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { SaveState } from 'lib/state/saveState'
import {
  savedSessionDefaults,
  useGlobalStore,
} from 'lib/stores/app/appStore'
import { useCharacterStore } from 'lib/stores/character/characterStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
import {
  FULL_SYNC_PROTOCOL_VERSION,
  HSR_FULL_SYNC_CLIENT_KEY,
  HSR_FULL_SYNC_URL_KEY,
} from 'lib/sync/fullSyncTypes'
import type {
  FullSyncClientMessage,
  FullSyncConflict,
  FullSyncConnectionStatus,
  FullSyncEntity,
  FullSyncJobEvent,
  FullSyncOp,
  FullSyncPendingConflict,
  FullSyncResourceRequest,
  FullSyncServerMessage,
  FullSyncSnapshot,
  FullSyncStatus,
  FullSyncWelcome,
} from 'lib/sync/fullSyncTypes'
import { OptimizerMenuIds } from 'lib/tabs/tabOptimizer/optimizerForm/layout/optimizerMenuIds'
import { useRelicsTabStore } from 'lib/tabs/tabRelics/useRelicsTabStore'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import type { ShowcaseTabSavedSession } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import { writeSavedTeams } from 'lib/tabs/tabTeamShowcase/teamShowcaseController'
import type {
  Character,
  CharacterId,
} from 'types/character'
import type {
  ScoringMetadataOverride,
  ShowcasePreferences,
} from 'types/metadata'
import type { Relic } from 'types/relic'
import type {
  GlobalSavedSession,
  HsrOptimizerSaveFormat,
  TeamShowcaseSavedTeam,
  UserSettings,
} from 'types/store'

// ─── Tunables ─────────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
const CAPTURE_DEBOUNCE_MS = 300
const RESOURCE_FETCH_TIMEOUT_MS = 10_000

/** The entity view of the save the client diffs against (all nine protocol entities). */
type SyncedSnapshot = {
  characters: Character[],
  relics: Relic[],
  teams: TeamShowcaseSavedTeam[],
  scoringOverrides: Partial<Record<CharacterId, ScoringMetadataOverride>>,
  settings: UserSettings,
  savedSession: {
    showcaseTab: ShowcaseTabSavedSession,
    global: GlobalSavedSession,
  },
  showcasePreferences: Partial<Record<CharacterId, ShowcasePreferences>>,
  optimizerMenuState: Record<string, boolean>,
  relicsTab: CharacterId[],
}

type BroadcastOp = Omit<FullSyncOp, 'type' | 'sessionId' | 'opId' | 'baseRevision'>

// ─── State ────────────────────────────────────────────────────────────────────

let initialized = false
let socket: WebSocket | null = null
let configuredUrl: string | null = null
let connectionStatus: FullSyncConnectionStatus = 'disconnected'
let intentionalDisconnect = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = RECONNECT_BASE_MS

let sessionId: string | null = null
let lastAppliedRevision: number | null = null
let localSaveGeneration: number | null = null

let applyingRemote = false
let awaitingSnapshot = false
let lastSyncedSnapshot: SyncedSnapshot | null = null
let captureTimer: ReturnType<typeof setTimeout> | null = null

const pendingOps = new Map<string, FullSyncOp>()
const conflicts = new Map<string, FullSyncPendingConflict>()
const jobEvents = new Map<string, FullSyncJobEvent>()

type ResourceWaiter = {
  resolve: (rows: unknown[]) => void,
  reject: (error: Error) => void,
  timer: ReturnType<typeof setTimeout>,
}
const resourceWaiters = new Map<string, ResourceWaiter>()
const listeners = new Map<string, Set<(payload: unknown) => void>>()

// ─── Small utilities ──────────────────────────────────────────────────────────

function newId(): string {
  // crypto.randomUUID is unavailable on insecure (plain http LAN) origins
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function clientId(): string {
  try {
    const existing = localStorage.getItem(HSR_FULL_SYNC_CLIENT_KEY)
    if (existing) return existing
    const created = `web-${newId()}`
    localStorage.setItem(HSR_FULL_SYNC_CLIENT_KEY, created)
    return created
  } catch {
    return 'web-ephemeral'
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

function emit(event: string, payload: unknown): void {
  const set = listeners.get(event)
  if (!set) return
  for (const listener of set) {
    try {
      listener(payload)
    } catch (e) {
      console.error('fullSync listener error', event, e)
    }
  }
}

// ─── Snapshot reading (mirrors SaveState.save() sources, saveState.ts:62-107) ─

function readSyncedSnapshot(): SyncedSnapshot {
  const globalState = useGlobalStore.getState()
  const showcaseTabState = useShowcaseTabStore.getState()

  return {
    characters: useCharacterStore.getState().characters,
    // Same serialization as SaveState.save(): augmentedStats stripped (saveState.ts:73)
    relics: useRelicStore.getState().relics.map(({ augmentedStats, ...rest }) => rest) as Relic[],
    // Teams live in the global savedSession (teamShowcaseController.ts:60-70)
    teams: globalState.savedSession.teamShowcaseSavedTeams,
    // Scoring overrides live in the scoring store (scoringStore.ts:42-46)
    scoringOverrides: useScoringStore.getState().scoringMetadataOverrides,
    settings: globalState.settings,
    savedSession: {
      showcaseTab: showcaseTabState.savedSession,
      global: { ...globalState.savedSession },
    },
    showcasePreferences: showcaseTabState.showcasePreferences,
    optimizerMenuState: useOptimizerDisplayStore.getState().menuState,
    relicsTab: useRelicsTabStore.getState().excludedRelicPotentialCharacters,
  }
}

// ─── Capture: diff snapshots into per-entity ops ──────────────────────────────

function scheduleCapture(): void {
  if (applyingRemote) return
  if (captureTimer) clearTimeout(captureTimer)
  captureTimer = setTimeout(captureNow, CAPTURE_DEBOUNCE_MS)
}

function captureNow(): void {
  captureTimer = null
  if (applyingRemote || awaitingSnapshot) return
  if (connectionStatus !== 'connected' || sessionId == null || lastAppliedRevision == null) return

  // Keep localStorage exactly as fresh as what we diff (SaveState.save also
  // guards against broken empty saves, saveState.ts:39-59)
  SaveState.save()

  const next = readSyncedSnapshot()
  const ops = diffSnapshots(lastSyncedSnapshot, next)
  lastSyncedSnapshot = next

  for (const partial of ops) {
    const op: FullSyncOp = {
      type: 'op',
      sessionId,
      opId: newId(),
      baseRevision: lastAppliedRevision,
      ...partial,
    }
    pendingOps.set(op.opId, op)
    send(op)
  }

  if (ops.length > 0) emit('capture', ops)
}

function diffSnapshots(prev: SyncedSnapshot | null, next: SyncedSnapshot): BroadcastOp[] {
  const ops: BroadcastOp[] = []
  // Entities first (character before relic: equip references resolve in order)
  diffArrayEntity(ops, 'character', prev?.characters ?? [], next.characters, (c) => c.id)
  diffArrayEntity(ops, 'relic', prev?.relics ?? [], next.relics, (r) => r.id)
  diffArrayEntity(ops, 'team', prev?.teams ?? [], next.teams, (t) => t.id)
  // Whole-object patches — savedSession compared with teams normalized out
  // (team membership is expressed as team ops above, not as a session patch)
  diffPatchEntity(ops, 'scoringOverrides', prev?.scoringOverrides ?? {}, next.scoringOverrides)
  diffPatchEntity(ops, 'settings', prev?.settings ?? {}, next.settings)
  diffPatchEntity(ops, 'savedSession', stripTeams(prev?.savedSession), stripTeams(next.savedSession), next.savedSession)
  diffPatchEntity(ops, 'showcasePreferences', prev?.showcasePreferences ?? {}, next.showcasePreferences)
  diffPatchEntity(ops, 'optimizerMenuState', prev?.optimizerMenuState ?? {}, next.optimizerMenuState)
  diffPatchEntity(ops, 'relicsTab', prev?.relicsTab ?? [], next.relicsTab)
  return ops
}

function diffArrayEntity<T>(
  ops: BroadcastOp[],
  entity: FullSyncEntity,
  prev: T[],
  next: T[],
  getId: (item: T) => string,
): void {
  const prevById = new Map(prev.map((item) => [getId(item), item]))
  const nextIds = new Set(next.map(getId))

  for (const [id] of prevById) {
    if (!nextIds.has(id)) ops.push({ entity, action: 'delete', id, payload: null })
  }
  for (const item of next) {
    const id = getId(item)
    const old = prevById.get(id)
    if (!old || stringify(old) !== stringify(item)) {
      ops.push({ entity, action: 'upsert', id, payload: item })
    }
  }
}

function diffPatchEntity<T>(
  ops: BroadcastOp[],
  entity: FullSyncEntity,
  prev: T,
  next: T,
  payloadOverride?: unknown,
): void {
  if (stringify(prev) === stringify(next)) return
  ops.push({ entity, action: 'patch', payload: payloadOverride ?? next })
}

/** savedSession with teamShowcaseSavedTeams normalized out, so team-only edits don't emit session patches. */
function stripTeams(session: SyncedSnapshot['savedSession'] | undefined) {
  if (!session) return undefined
  return {
    showcaseTab: session.showcaseTab,
    global: { ...session.global, teamShowcaseSavedTeams: [] },
  }
}

// ─── Apply: replay the same upstream actions the web UI uses ──────────────────

function applyRemoteOps(ops: BroadcastOp[], revision: number): void {
  applyingRemote = true
  try {
    for (const op of ops) {
      try {
        applyRemoteOp(op)
      } catch (e) {
        console.error('fullSync: failed to apply op', op.entity, op.id, e)
      }
    }
  } finally {
    applyingRemote = false
    SaveState.delayedSave()
    lastAppliedRevision = revision
    // Advance the virtual server state by the applied ops (not by reading the
    // stores) so local edits made while disconnected stay a pending diff and
    // are pushed right after the resync lands
    lastSyncedSnapshot = virtuallyApplyOps(lastSyncedSnapshot, ops) ?? readSyncedSnapshot()
  }
}

function applyRemoteOp(op: BroadcastOp): void {
  const payload = op.payload
  switch (op.entity) {
    case 'character': {
      if (op.action === 'delete') {
        // Same chain as the character grid delete (characterTabController.ts:54-63 → equipmentService.removeCharacter)
        equipmentService.removeCharacter(op.id as CharacterId)
        return
      }
      const character = payload as Character
      const existing = useCharacterStore.getState().charactersById[character.id]
      if (existing) {
        // Same action as editing an existing character (persistenceService.ts:524-529)
        useCharacterStore.getState().setCharacter(character)
      } else {
        // Same action as adding a character (persistenceService.ts:530-539:
        // addCharacter honoring the NewCharacterDefaultRank setting)
        const prepend = useGlobalStore.getState().settings.NewCharacterDefaultRank === SettingOptions.NewCharacterDefaultRank.First
        useCharacterStore.getState().addCharacter(character, prepend)
      }
      return
    }
    case 'relic': {
      if (op.action === 'delete') {
        // Same chain as relic deletion (equipmentService.removeRelic: unequip + deleteRelic)
        equipmentService.removeRelic(op.id!)
        return
      }
      // Same action as relic import/edit (equipmentService.upsertRelicWithEquipment)
      equipmentService.upsertRelicWithEquipment(payload as Relic)
      return
    }
    case 'team': {
      // Same save chain as the team showcase UI (teamShowcaseController.writeSavedTeams)
      const current = useGlobalStore.getState().savedSession.teamShowcaseSavedTeams
      if (op.action === 'delete') {
        writeSavedTeams(current.filter((team) => team.id !== op.id))
      } else {
        const team = payload as TeamShowcaseSavedTeam
        writeSavedTeams([...current.filter((existing) => existing.id !== team.id), team])
      }
      return
    }
    case 'scoringOverrides': {
      useScoringStore.getState().setScoringMetadataOverrides(payload as Partial<Record<CharacterId, ScoringMetadataOverride>>)
      return
    }
    case 'settings': {
      // Same merge semantics as loading a save (persistenceService.ts:182-186)
      useGlobalStore.getState().setSettings({ ...DefaultSettingOptions, ...(payload as UserSettings) })
      return
    }
    case 'savedSession': {
      applySavedSessionPatch(payload)
      return
    }
    case 'showcasePreferences': {
      useShowcaseTabStore.getState().setShowcasePreferences(payload as Partial<Record<CharacterId, ShowcasePreferences>>)
      return
    }
    case 'optimizerMenuState': {
      // Same known-key merge as loading a save (persistenceService.ts:147-155)
      const incoming = payload as Record<string, boolean>
      const menuState = { ...useOptimizerDisplayStore.getState().menuState }
      for (const key of Object.values(OptimizerMenuIds)) {
        if (incoming[key] != null) menuState[key] = incoming[key]
      }
      useOptimizerDisplayStore.getState().setMenuState(menuState)
      return
    }
    case 'relicsTab': {
      useRelicsTabStore.getState().setExcludedRelicPotentialCharacters((payload as CharacterId[]) ?? [])
      return
    }
  }
}

function applySavedSessionPatch(payload: unknown): void {
  const session = (payload ?? {}) as Partial<{ showcaseTab: ShowcaseTabSavedSession, global: GlobalSavedSession }>
  if (session.global) {
    // Same semantics as loading a save (persistenceService.ts:158-167): defaults +
    // session merge, unknown focused character reset to null
    const merged: GlobalSavedSession = { ...savedSessionDefaults, ...session.global }
    if (merged.optimizerCharacterId && !getGameMetadata().characters[merged.optimizerCharacterId]) {
      merged.optimizerCharacterId = null
    }
    useGlobalStore.getState().setSavedSession(merged)
  }
  if (session.showcaseTab) {
    // Same action as the showcase tab session restore (persistenceService.ts:177-179)
    useShowcaseTabStore.getState().setSavedSession(session.showcaseTab)
  }
}

function applySnapshot(snapshot: FullSyncSnapshot): void {
  applyingRemote = true
  try {
    // Mirror the page-load semantics (index.tsx SaveState.load(false, false) → loadSaveData)
    persistenceService.loadSaveData(snapshot.save as unknown as HsrOptimizerSaveFormat, false, false)
    SaveState.delayedSave()
  } catch (e) {
    console.error('fullSync: failed to apply snapshot', e)
  } finally {
    applyingRemote = false
  }
  localSaveGeneration = snapshot.saveGeneration
  lastAppliedRevision = snapshot.revision
  lastSyncedSnapshot = readSyncedSnapshot()
  awaitingSnapshot = false
}

/** Fold a broadcast batch into the virtual server state (no store access — see applyRemoteOps). */
function virtuallyApplyOps(prev: SyncedSnapshot | null, ops: BroadcastOp[]): SyncedSnapshot | null {
  if (prev == null) return null

  let snapshot = prev
  for (const op of ops) {
    const payload = op.payload
    switch (op.entity) {
      case 'character': {
        snapshot = op.action === 'delete'
          ? { ...snapshot, characters: snapshot.characters.filter((c) => c.id !== op.id) }
          : { ...snapshot, characters: upsertById(snapshot.characters, payload as Character, (c) => c.id) }
        break
      }
      case 'relic': {
        snapshot = op.action === 'delete'
          ? { ...snapshot, relics: snapshot.relics.filter((r) => r.id !== op.id) }
          : { ...snapshot, relics: upsertById(snapshot.relics, payload as Relic, (r) => r.id) }
        break
      }
      case 'team': {
        snapshot = op.action === 'delete'
          ? { ...snapshot, teams: snapshot.teams.filter((t) => t.id !== op.id) }
          : { ...snapshot, teams: upsertById(snapshot.teams, payload as TeamShowcaseSavedTeam, (t) => t.id) }
        break
      }
      case 'scoringOverrides':
        snapshot = { ...snapshot, scoringOverrides: payload as SyncedSnapshot['scoringOverrides'] }
        break
      case 'settings':
        snapshot = { ...snapshot, settings: payload as UserSettings }
        break
      case 'savedSession': {
        // Mirror applySavedSessionPatch exactly (defaults merge, optional halves)
        // so the virtual snapshot and the stores can never diverge here
        const incoming = payload as Partial<SyncedSnapshot['savedSession']>
        const nextSession = { ...snapshot.savedSession }
        if (incoming.global) nextSession.global = { ...savedSessionDefaults, ...incoming.global }
        if (incoming.showcaseTab) nextSession.showcaseTab = incoming.showcaseTab
        snapshot = { ...snapshot, savedSession: nextSession, teams: nextSession.global.teamShowcaseSavedTeams }
        break
      }
      case 'showcasePreferences':
        snapshot = { ...snapshot, showcasePreferences: payload as SyncedSnapshot['showcasePreferences'] }
        break
      case 'optimizerMenuState':
        snapshot = { ...snapshot, optimizerMenuState: payload as Record<string, boolean> }
        break
      case 'relicsTab':
        snapshot = { ...snapshot, relicsTab: (payload as CharacterId[]) ?? [] }
        break
    }
  }
  return snapshot
}

function upsertById<T>(items: T[], item: T, getId: (item: T) => string): T[] {
  const id = getId(item)
  const exists = items.some((existing) => getId(existing) === id)
  return exists ? items.map((existing) => (getId(existing) === id ? item : existing)) : [...items, item]
}

// ─── Conflicts ────────────────────────────────────────────────────────────────

function handleConflict(message: FullSyncConflict): void {
  const originalOp = pendingOps.get(message.opId) ?? null
  pendingOps.delete(message.opId)

  const entry: FullSyncPendingConflict = {
    opId: message.opId,
    entity: originalOp?.entity ?? null,
    serverRevision: message.serverRevision,
    reason: message.reason,
    originalOp,
    resolved: false,
    resolution: null,
  }
  conflicts.set(message.opId, entry)
  emit('conflict', entry)
  showConflictModal(entry)
}

function showConflictModal(entry: FullSyncPendingConflict): void {
  // Never silently drop a user edit — force an explicit choice between the
  // server state and the local one (escape/outside-click disabled on purpose)
  modals.openConfirmModal({
    title: 'Full sync conflict',
    children: [
      `The server rejected a local change (${entry.entity ?? 'unknown entity'}${entry.originalOp?.id ? ` ${entry.originalOp.id}` : ''}).`,
      ` Reason: ${entry.reason}. The server moved on to revision ${entry.serverRevision}.`,
      ' Choose "Reload" to take the server snapshot, or "Reapply" to resend the local edit against the new revision.',
    ].join(''),
    labels: { confirm: 'Reload (take snapshot)', cancel: 'Reapply (resend edit)' },
    confirmProps: { color: 'blue' },
    cancelProps: { color: 'grape' },
    closeOnClickOutside: false,
    closeOnEscape: false,
    onConfirm: () => resolveConflict(entry.opId, 'reload'),
    onCancel: () => resolveConflict(entry.opId, 'reapply'),
  })
}

function resolveConflict(opId: string, choice: 'reload' | 'reapply'): void {
  const entry = conflicts.get(opId)
  if (!entry || entry.resolved) return
  entry.resolved = true
  entry.resolution = choice
  emit('conflict-resolved', entry)

  send({ type: 'resolve', opId, choice })

  // Catch the client up to the server's revision before further local edits ship
  lastAppliedRevision = entry.serverRevision

  if (choice === 'reload') {
    // The server answers with a snapshot; suppress captures until it lands so
    // the diverging local state can't produce another stale-revision storm
    awaitingSnapshot = true
    if (connectionStatus !== 'connected') {
      // The resolve was lost with the socket — a null lastRevision in the
      // reconnect hello forces the server to send a full snapshot
      lastAppliedRevision = null
    }
    return
  }

  // reapply: resend the original op (same opId — the server dedupes retries by
  // it) rebased onto the fresh revision
  if (entry.originalOp && connectionStatus === 'connected') {
    const retry: FullSyncOp = { ...entry.originalOp, baseRevision: entry.serverRevision }
    pendingOps.set(retry.opId, retry)
    send(retry)
  }
}

// ─── Job events & resource pulls ──────────────────────────────────────────────

function handleJobEvent(message: FullSyncJobEvent): void {
  jobEvents.set(message.jobId, message)
  emit('job', message)

  const terminal = message.status !== 'running'
  const color = message.status === 'completed'
    ? 'green'
    : message.status === 'failed'
    ? 'red'
    : message.status === 'cancelled'
    ? 'gray'
    : 'blue'
  notifications.show({
    id: `full-sync-job-${message.jobId}`,
    title: `Optimizer job (${message.kind})`,
    message: `${message.jobId}: ${message.status}`
      + `${message.progress != null ? ` — ${Math.round(message.progress * 100)}%` : ''}`
      + `${message.resultRef?.cacheId != null ? ` (result cache: ${message.resultRef.cacheId})` : ''}`,
    color,
    loading: message.status === 'running',
    autoClose: terminal ? 6_000 : false,
  })
}

function fetchResource(
  resource: FullSyncResourceRequest['resource'],
  query: { cacheId?: string, rowIds?: string[], limit?: number } = {},
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const requestId = newId()
    const timer = setTimeout(() => {
      resourceWaiters.delete(requestId)
      reject(new Error(`fullSync resource fetch timed out: ${resource}`))
    }, RESOURCE_FETCH_TIMEOUT_MS)

    resourceWaiters.set(requestId, {
      resolve: (rows) => {
        clearTimeout(timer)
        resolve(rows)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
      timer,
    })

    if (!send({ type: 'resource/fetch', requestId, resource, ...query })) {
      clearTimeout(timer)
      resourceWaiters.delete(requestId)
      reject(new Error('fullSync: not connected'))
    }
  })
}

// ─── Connection lifecycle ─────────────────────────────────────────────────────

function send(message: FullSyncServerMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

function sendHello(
  lastRevision: number | null = lastAppliedRevision,
  saveGeneration: number | null = localSaveGeneration,
): void {
  send({
    type: 'hello',
    protocol: FULL_SYNC_PROTOCOL_VERSION,
    lastRevision,
    saveGeneration,
    client: clientId(),
  })
}

function closeSocket(): void {
  if (!socket) return
  const old = socket
  socket = null
  // Detach handlers so an intentional close never triggers the reconnect path
  old.onclose = null
  old.onerror = null
  old.close()
}

function openSocket(): void {
  if (!configuredUrl || socket) return
  connectionStatus = 'connecting'
  emit('status', connectionStatus)

  let ws: WebSocket
  try {
    ws = new WebSocket(configuredUrl)
  } catch (e) {
    console.error('fullSync: invalid URL', configuredUrl, e)
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    backoffMs = RECONNECT_BASE_MS
    connectionStatus = 'connected'
    emit('status', connectionStatus)
    sendHello()
  }

  ws.onmessage = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data as string) as FullSyncClientMessage
      handleServerMessage(message)
    } catch (e) {
      console.error('fullSync: malformed message', e)
      emit('error', e)
    }
  }

  ws.onclose = () => {
    socket = null
    connectionStatus = 'disconnected'
    pendingOps.clear()
    emit('status', connectionStatus)
    if (!intentionalDisconnect) scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose always follows; nothing to do here
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  const delay = backoffMs
  backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!intentionalDisconnect && configuredUrl) openSocket()
  }, delay)
}

function connect(url?: string): boolean {
  const target = url ?? readStoredUrl()
  if (!target) return false
  configuredUrl = target
  intentionalDisconnect = false
  closeSocket()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  try {
    localStorage.setItem(HSR_FULL_SYNC_URL_KEY, target)
  } catch {
    // storage unavailable — connection still works for this session
  }
  openSocket()
  return true
}

function disconnect(): void {
  intentionalDisconnect = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  backoffMs = RECONNECT_BASE_MS
  closeSocket()
  connectionStatus = 'disconnected'
  pendingOps.clear()
  emit('status', connectionStatus)
}

function readStoredUrl(): string | null {
  try {
    return localStorage.getItem(HSR_FULL_SYNC_URL_KEY)
  } catch {
    return null
  }
}

// ─── Inbound message routing ──────────────────────────────────────────────────

function generationMatches(saveGeneration: number): boolean {
  // Until the first welcome/snapshot adopts a generation, accept anything
  return localSaveGeneration == null || saveGeneration === localSaveGeneration
}

function handleServerMessage(message: FullSyncClientMessage): void {
  emit('message', message)

  switch (message.type) {
    case 'welcome': {
      handleWelcome(message)
      return
    }
    case 'snapshot': {
      applySnapshot(message)
      emit('snapshot-applied', message)
      return
    }
    case 'ack': {
      pendingOps.delete(message.opId)
      lastAppliedRevision = message.revision
      emit('ack', message)
      return
    }
    case 'conflict': {
      handleConflict(message)
      return
    }
    case 'broadcast':
    case 'resync': {
      if (!generationMatches(message.saveGeneration)) {
        // Ops from a previous save must never land on the current one — drop
        // the increment and force a full snapshot resync (hello{lastRevision: null})
        console.warn(
          'fullSync: save generation mismatch, requesting snapshot',
          message.saveGeneration,
          localSaveGeneration,
        )
        awaitingSnapshot = true
        lastAppliedRevision = null
        sendHello(null, message.saveGeneration)
        emit('generation-mismatch', message)
        return
      }
      applyRemoteOps(message.ops, message.revision)
      emit(message.type, message)
      return
    }
    case 'job': {
      handleJobEvent(message)
      return
    }
    case 'resource/response': {
      const waiter = resourceWaiters.get(message.requestId)
      if (!waiter) return
      resourceWaiters.delete(message.requestId)
      if (message.ok) waiter.resolve(message.rows ?? [])
      else waiter.reject(new Error(message.error ?? 'resource fetch failed'))
      emit('resource', message)
      return
    }
  }
}

function handleWelcome(message: FullSyncWelcome): void {
  if (message.protocol !== FULL_SYNC_PROTOCOL_VERSION) {
    console.error('fullSync: protocol version mismatch', message.protocol)
    emit('error', new Error(`protocol mismatch: server ${message.protocol}, client ${FULL_SYNC_PROTOCOL_VERSION}`))
  }
  sessionId = message.sessionId
  lastAppliedRevision = message.revision
  localSaveGeneration = message.saveGeneration
  // A reconnect always delivers welcome before any catch-up traffic — a
  // snapshot awaited from a previous connection is superseded by the resync
  // that follows this welcome
  awaitingSnapshot = false
  // Fresh connection with no diffed baseline yet: adopt the local state so the
  // client never floods the server with its whole world as ops — the server
  // snapshot (if the server has no buffer for us) refreshes it right after
  if (lastSyncedSnapshot == null) lastSyncedSnapshot = readSyncedSnapshot()
  emit('welcome', message)
}

// ─── Public surface ───────────────────────────────────────────────────────────

function status(): FullSyncStatus {
  return {
    status: connectionStatus,
    url: configuredUrl,
    sessionId,
    revision: lastAppliedRevision,
    saveGeneration: localSaveGeneration,
    backoffMs,
    pendingConflicts: [...conflicts.values()].filter((entry) => !entry.resolved),
  }
}

function on(event: string, listener: (payload: unknown) => void): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(listener)
  return () => set.delete(listener)
}

function event(name: string, payload?: unknown): void {
  // Reserved channel: route a synthetic message through the real handler so
  // headless tests can drive conflict/snapshot flows without a server
  if (name === 'server-message') {
    handleServerMessage(payload as FullSyncClientMessage)
    return
  }
  emit(name, payload)
}

/**
 * Mount the full-state sync client. Reads localStorage['hsr-full-sync-url'] and
 * auto-connects only when a URL was explicitly configured (never by default).
 */
export function initFullStateSync(): void {
  if (initialized) return
  initialized = true

  // Capture subscriptions — the persisted stores from saveState.ts:62-107.
  // Teams ride in useGlobalStore.savedSession (writeSavedTeams chain) and
  // scoring overrides in useScoringStore, so both true hosts are covered.
  useCharacterStore.subscribe(scheduleCapture)
  useRelicStore.subscribe(scheduleCapture)
  useGlobalStore.subscribe(scheduleCapture)
  useShowcaseTabStore.subscribe(scheduleCapture)
  useScoringStore.subscribe(scheduleCapture)
  useOptimizerDisplayStore.subscribe(scheduleCapture)
  useRelicsTabStore.subscribe(scheduleCapture)

  window.__HSR_FULL_SYNC = {
    connect,
    disconnect,
    status,
    on,
    event,
    fetchResource,
    resolveConflict,
    pendingConflicts: () => status().pendingConflicts,
  }

  const storedUrl = readStoredUrl()
  if (storedUrl) connect(storedUrl)
}
