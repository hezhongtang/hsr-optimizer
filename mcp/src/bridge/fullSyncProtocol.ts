// M8 full-state sync protocol (MCP server ⇄ web client).
//
// The message shapes below are the FROZEN wire contract between
// mcp/src/bridge/fullSyncServer.ts (server) and the web client
// (src/lib/sync/fullStateSyncClient.ts — plain TypeScript re-declaration, no
// cross imports). Changes here must be mirrored on both sides and recorded in
// the contract freeze §9.
//
// Design anchors (全站覆盖计划 §5 M8):
//   - MCP is the coordinator: every committed change bumps runtimeContext
//     revision; clients track the last revision they have applied.
//   - Semantic operations carry sessionId + opId + baseRevision. An op whose
//     baseRevision does not match the server's revision at dequeue time is
//     REJECTED with a conflict message — never silently applied. The client
//     offers the user "reload" (take the server snapshot) or "reapply"
//     (re-send the op against the fresh revision).
//   - Reconnect/resync: the client says hello with its lastRevision; the
//     server replies with buffered ops since that revision, or a full
//     snapshot when the buffer is gone (restart / save switch / too old).
//   - Echo suppression: each side flags entity writes caused by remote
//     application so the capture differ never bounces traffic back.
//   - Save isolation: a load_save on the server invalidates the op buffer
//     (saveGeneration bump) and forces snapshot resync — a client can never
//     apply ops from a previous save onto the new one.

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
