// M8 full-state sync protocol — web-side declaration.
//
// These types are a plain re-declaration of the FROZEN wire contract defined in
// mcp/src/bridge/fullSyncProtocol.ts (the web client must not import across the
// mcp/ boundary). Any change to the shapes below must be mirrored in the
// protocol file and recorded in the contract freeze §9.

export const FULL_SYNC_PROTOCOL_VERSION = 1

/** Entity collections mirrored between server and web client. */
export type FullSyncEntity =
  | 'character' // upsert/delete by id (form, builds, portrait ride along)
  | 'relic' // upsert/delete by id (equipment transfer semantics per payload)
  | 'team' // upsert/delete by teamId
  | 'scoringOverrides' // whole-object patch (set_scoring_override domain shape)
  | 'settings' // whole-object patch (useGlobalStore.settings)
  | 'savedSession' // whole-object patch (global + showcaseTab sessions)
  | 'showcasePreferences' // whole-object patch (per-character preferences)
  | 'optimizerMenuState' // whole-object patch (section folding)
  | 'relicsTab' // whole-object patch (excludedRelicPotentialCharacters)

export interface FullSyncOp {
  type: 'op'
  sessionId: string
  /** Client-generated unique id; the server dedupes retries by it. */
  opId: string
  /** Revision the client had applied when it produced the edit. */
  baseRevision: number
  entity: FullSyncEntity
  action: 'upsert' | 'delete' | 'patch'
  /** Entity id for character/relic/team; absent for whole-object patches. */
  id?: string
  payload: unknown
}

export interface FullSyncSnapshot {
  type: 'snapshot'
  sessionId: string
  revision: number
  saveGeneration: number
  /** The exact object SaveState.save() serializes (readStructuredSnapshot shape). */
  save: Record<string, unknown>
}

export interface FullSyncAck {
  type: 'ack'
  opId: string
  revision: number
}

export interface FullSyncConflict {
  type: 'conflict'
  opId: string
  serverRevision: number
  /** Server-side entity state AFTER the conflicting client op was rejected. */
  reason: 'stale-revision' | 'save-generation' | 'unknown-entity'
  /** Offered resolutions: reload = apply snapshot, reapply = resend at fresh revision. */
  choices: ['reload', 'reapply']
}

/** Server → client broadcast of a committed change (any origin except the client itself). */
export interface FullSyncBroadcast {
  type: 'broadcast'
  revision: number
  saveGeneration: number
  ops: Array<Omit<FullSyncOp, 'type' | 'sessionId' | 'opId' | 'baseRevision'>>
}

/** Reconnect catch-up: the ops the client missed, in commit order. */
export interface FullSyncResync {
  type: 'resync'
  revision: number
  saveGeneration: number
  ops: Array<Omit<FullSyncOp, 'type' | 'sessionId' | 'opId' | 'baseRevision'>>
}

/** First message from the client on (re)connect. */
export interface FullSyncHello {
  type: 'hello'
  protocol: number
  lastRevision: number | null
  saveGeneration: number | null
  /** Client identity for logs/acks; the server issues the authoritative sessionId. */
  client: string
}

export interface FullSyncWelcome {
  type: 'welcome'
  protocol: number
  sessionId: string
  revision: number
  saveGeneration: number
}

/** Optimizer job lifecycle (server → client); result bodies stay behind resource fetch. */
export interface FullSyncJobEvent {
  type: 'job'
  jobId: string
  kind: 'optimize' | 'benchmark_runs'
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  progress?: number
  /** Reference for resource/fetch — never inline large result bodies. */
  resultRef?: { cacheId?: string, rows?: number }
}

/** Client pull for a big payload it was only given a reference to. */
export interface FullSyncResourceRequest {
  type: 'resource/fetch'
  requestId: string
  resource: 'optimize-results'
  cacheId?: string
  rowIds?: string[]
  limit?: number
}

export interface FullSyncResourceResponse {
  type: 'resource/response'
  requestId: string
  ok: boolean
  rows?: unknown[]
  error?: string
}

/** Client's explicit conflict resolution choice. */
export interface FullSyncResolve {
  type: 'resolve'
  opId: string
  choice: 'reload' | 'reapply'
}

export type FullSyncServerMessage = FullSyncHello | FullSyncOp | FullSyncResourceRequest | FullSyncResolve
export type FullSyncClientMessage =
  | FullSyncWelcome
  | FullSyncSnapshot
  | FullSyncAck
  | FullSyncConflict
  | FullSyncBroadcast
  | FullSyncResync
  | FullSyncJobEvent
  | FullSyncResourceResponse

// ─── Web-client-only surface (not part of the wire contract) ─────────────────

/** localStorage key holding the ws:// URL the client auto-connects to at startup. */
export const HSR_FULL_SYNC_URL_KEY = 'hsr-full-sync-url'

/** localStorage key persisting a stable client identity across reloads (logs/acks only). */
export const HSR_FULL_SYNC_CLIENT_KEY = 'hsr-full-sync-client-id'

export type FullSyncConnectionStatus = 'disconnected' | 'connecting' | 'connected'

/** One unresolved (or resolved-but-kept-for-assertion) conflict, exposed for tests. */
export interface FullSyncPendingConflict {
  opId: string
  entity: FullSyncEntity | null
  serverRevision: number
  reason: FullSyncConflict['reason']
  /** The rejected op, retained so "reapply" can resend it at a fresh revision. */
  originalOp: FullSyncOp | null
  resolved: boolean
  resolution: 'reload' | 'reapply' | null
}

export interface FullSyncStatus {
  status: FullSyncConnectionStatus
  url: string | null
  sessionId: string | null
  revision: number | null
  saveGeneration: number | null
  backoffMs: number
  pendingConflicts: FullSyncPendingConflict[]
}

export interface FullSyncResourceQuery {
  cacheId?: string
  rowIds?: string[]
  limit?: number
}

/**
 * Test/console hook mounted at window.__HSR_FULL_SYNC (independent of
 * window.__HSR_DEBUG — index.tsx does not touch that literal).
 *
 * `event(name, payload)` dispatches to `on(name, listener)` subscribers; the
 * reserved name 'server-message' additionally routes the payload through the
 * real inbound-message handler, letting headless tests simulate the server.
 */
export interface HsrFullSyncApi {
  connect: (url?: string) => boolean
  disconnect: () => void
  status: () => FullSyncStatus
  on: (event: string, listener: (payload: unknown) => void) => () => void
  event: (name: string, payload?: unknown) => void
  fetchResource: (resource: FullSyncResourceRequest['resource'], query?: FullSyncResourceQuery) => Promise<unknown[]>
  resolveConflict: (opId: string, choice: 'reload' | 'reapply') => void
  pendingConflicts: () => FullSyncPendingConflict[]
}
