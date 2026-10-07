// Shared runtime context for the MCP server (main thread only).
//
// Owns:
//   - one-time Metadata.initialize()
//   - the currently loaded save (path + snapshot for driver reloads)
//   - dirty tracking with a debounced flush: SaveState.save() string → save file
//   - the most recent optimize result cache (served by get_results)
//   - worker pool sizing (env HSR_MCP_WORKERS, default 6, capped at 10)

import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { Metadata } from 'lib/state/metadataInitializer'
import { SaveState } from 'lib/state/saveState'
import type { OptimizerRequestState } from 'lib/stores/optimizerForm/optimizerFormTypes'
import {
  readFileSync,
  writeFileSync,
} from 'node:fs'
import type { HsrOptimizerSaveFormat } from 'types/store'

import { bridgeNotifyChange } from './domains/bridge'
import {
  captureSaveStores,
  restoreBootSaveStores,
} from './saveStores'
import { requestedPoolSize } from './shims'

export type LoadedSave = {
  /** Absolute path the save was loaded from; null when loaded from inline JSON */
  path: string | null,
  /** Snapshot the driver workers reload from (kept fresh after each flush) */
  data: HsrOptimizerSaveFormat,
  loadedAt: number,
}

/**
 * Last write-back attempt the wipe guard blocked. Cleared by every clean
 * flush (and by loading a new save); surfaced through save_status so a block
 * is visible instead of silently dropping every pending change of a session.
 */
export type BlockedWrite = {
  /** Epoch ms of the blocked flush attempt */
  at: number,
  /** Human-readable summary of why the guard held */
  reason: string,
}

export type OptimizeRunSummary = {
  cacheId: string,
  characterId: string,
  gridSortColumn: string,
  validPermutations: number,
  naivePermutations: number,
  searched: number,
  durationMs: number,
  cancelled: boolean,
  resultsLimit: number,
}

export type CachedOptimizeResult = {
  summary: OptimizeRunSummary,
  rows: OptimizerDisplayData[],
  /** Per-row 6-slot relic ids, index-aligned with rows */
  builds: Array<Partial<Record<string, string | undefined>>>,
  /**
   * Display state the run actually used (saved form → computeLoadForm →
   * applyFormOverrides). `save_build fromCache` snapshots from this, so the
   * persisted build reflects any formOverrides the optimize call merged in.
   */
  displayState: OptimizerRequestState,
  /**
   * Save generation the run executed against (see getSaveGeneration). Cached
   * builds from an earlier `load_save` must never be applied to the current
   * inventory — ids from the previous save may collide with unrelated relics.
   */
  generation: number,
  at: number,
}

const SAVE_FLUSH_DEBOUNCE_MS = 1000

/** Which critical collection a detected wipe would drop. */
type WipeKind = 'relics' | 'characters' | 'both' | 'unparseable'

/**
 * Detect a shrinking write: `stateString` empties a collection (relics or
 * characters, checked independently) while the target file still holds entries
 * for it. A state that empties both counts when either side had data, and
 * unparseable states are treated as wipes so the guard errs on the safe side.
 */
function detectWipe(stateString: string, targetPath: string): WipeKind | null {
  try {
    const next = JSON.parse(stateString) as HsrOptimizerSaveFormat
    const nextRelicsEmpty = (next.relics?.length ?? 0) === 0
    const nextCharactersEmpty = (next.characters?.length ?? 0) === 0
    if (!nextRelicsEmpty && !nextCharactersEmpty) return null
    const existing = JSON.parse(readFileSync(targetPath, 'utf8')) as HsrOptimizerSaveFormat
    const losesRelics = nextRelicsEmpty && (existing.relics?.length ?? 0) > 0
    const losesCharacters = nextCharactersEmpty && (existing.characters?.length ?? 0) > 0
    if (losesRelics && losesCharacters) return 'both'
    if (losesRelics) return 'relics'
    if (losesCharacters) return 'characters'
    return null
  } catch {
    // Unparseable state (or an unreadable target): treat as a wipe attempt and let the guard hold
    return 'unparseable'
  }
}

let metadataReady = false
// Startup restore (global.state.bootLoad) bookkeeping — see maybeBootLoad.
let bootLoadAttempted = false
let bootLoadedFromStateFile = false
let loadedSave: LoadedSave | null = null
let lastOptimize: CachedOptimizeResult | null = null
let dirty = false
let lastBlockedWrite: BlockedWrite | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let runCounter = 0
// Monotonic counter bumped on every setSave: the optimize cache records the
// generation it ran against so fromCache references from a previous save load
// are rejected instead of equipping colliding relic ids from the new save.
let saveGeneration = 0
// Change revision (M4 change coordinator): bumped on every committed state
// change — markDirty (any store mutation heading for a flush), setSave and
// clearSave (save swaps). Read-only tools never bump it, so an agent can read
// it via save_status and pass it back as a baseRevision-style check later.
// Multiple bumps within one tool call are fine: the number identifies state,
// not calls. Rollbacks (withChange) restore it.
let revision = 0
// Serializes withChange bodies: scopes run to completion in submission order,
// so one scope's rollback can never restore stores another concurrent scope
// already mutated. "Submission order" = handler arrival order — for several
// frames written in ONE stdin batch the SDK validates each frame's schema
// asynchronously, so queue order may differ from frame order (final state is
// order-independent thanks to the dequeue-time snapshot; only ordering
// assumptions and baseRevision conflicts are affected — cross-batch order is
// still reliable). Chained promise — never awaited by callers directly.
let changeQueue: Promise<unknown> = Promise.resolve()

/**
 * One-shot startup restore (global.state.bootLoad): mirror the web's boot
 * chain — src/index.tsx:103 `SaveState.load(false, false)` over
 * localStorage['state'] → persistenceService.loadSaveData(parsed,
 * autosave=false, sanitize=false). The localStorage shim's file backend
 * (HSR_MCP_STATE_FILE) makes that key survive process restarts, so a fresh
 * MCP process reopens the previous session's state exactly like reopening
 * the website does.
 *
 * Placement: hung off the FIRST ensureMetadataReady() — the same lazy point
 * the web uses (Metadata.initialize() then SaveState.load), never at import
 * time. In practice the earliest trigger is server construction
 * (server.ts createMcpServer), which runs after the shims and before any
 * request is served, so no handler can observe a half-restored state and no
 * async withChange queue is needed: the synchronous capture/restore below
 * IS the transaction (nothing else can be mid-flight before the first
 * ensureMetadataReady returns).
 *
 * Web-parity details (saveState.ts:136-154):
 *   - no 'state' key → nothing loaded, default empty state stays (web: false);
 *   - broken JSON / a migration throw → caught, stores restored to their
 *     pre-attempt (default) state, server keeps booting (web: console.error
 *     + empty state; the ledger's acceptance "JSON 损坏时保持空状态");
 *   - after a successful restore the runtime save is INLINE-shaped
 *     (path=null — the web has no file concept, its localStorage is the only
 *     truth; here the state-file backend plays that role) and CLEAN
 *     (setSave: dirty=false), like the web right after startup.
 *
 * Escape hatch: HSR_MCP_NO_BOOT_LOAD=1 disables the restore entirely
 * (process starts with default empty stores; documented in the README).
 */
function maybeBootLoad(): void {
  if (bootLoadAttempted) return
  bootLoadAttempted = true
  if (process.env.HSR_MCP_NO_BOOT_LOAD === '1') return
  if (loadedSave != null) return // an explicit load already won the race
  const raw = localStorage.getItem('state')
  if (raw == null) return
  const restoreStores = captureSaveStores()
  try {
    const parsed = JSON.parse(raw) as HsrOptimizerSaveFormat
    const pristine = structuredClone(parsed)
    restoreBootSaveStores(parsed)
    runtimeContext.setSave({ path: null, data: pristine, loadedAt: Date.now() })
    bootLoadedFromStateFile = true
    process.stderr.write(
      `[mcp] bootLoad: restored ${parsed.relics?.length ?? 0} relics / ${parsed.characters?.length ?? 0} characters `
        + 'from the localStorage state backend (HSR_MCP_STATE_FILE) — web startup semantics, inline path\n',
    )
  } catch (e) {
    // SaveState.load parity: a broken state never blocks startup — the stores
    // fall back to their fresh defaults (rollback also drops any migration
    // markers the chain wrote before throwing).
    restoreStores()
    process.stderr.write(`[mcp] bootLoad: restore failed, keeping default empty state: ${String(e)}\n`)
  }
}

export const runtimeContext = {
  workerCount: requestedPoolSize(),

  /** Idempotent one-time game metadata initialization. */
  ensureMetadataReady(): void {
    if (metadataReady) return
    Metadata.initialize()
    metadataReady = true
    maybeBootLoad()
  },

  /** True when the current save was auto-restored at startup from the
   * localStorage state backend (global.state.bootLoad), not load_save. */
  isBootLoaded(): boolean {
    return bootLoadedFromStateFile
  },

  setSave(save: LoadedSave): void {
    // A pending debounce belongs to the PREVIOUS save: letting it fire after
    // the swap would write the freshly loaded (normalized) state back out
    // unrequested — stripping unknown top-level keys from the new save's file.
    runtimeContext.cancelPendingFlush()
    loadedSave = save
    dirty = false
    lastBlockedWrite = null
    saveGeneration++
    revision++
  },

  /** Drop the loaded save entirely (load_save rollback with no previous save). */
  clearSave(): void {
    runtimeContext.cancelPendingFlush()
    loadedSave = null
    dirty = false
    lastBlockedWrite = null
    saveGeneration++
    revision++
  },

  /** Generation of the currently loaded save; caches stamped with an older
   * generation belong to a previous `load_save` and are stale. */
  getSaveGeneration(): number {
    return saveGeneration
  },

  /** Current change revision — see the module-level `revision` comment. */
  getRevision(): number {
    return revision
  },

  /**
   * Optimistic-concurrency gate for future write tools: rejects when the
   * caller's view of the state (the revision it read before composing its
   * change) is no longer current. Surface as a tool error; the message carries
   * both revisions so the agent can re-read and reapply.
   */
  requireRevision(base: number, label: string): void {
    if (base !== revision) {
      throw new Error(
        `${label}:修订号冲突——调用方持有 revision ${base},当前已是 ${revision};`
          + '两者之间发生过其他变更。请重新读取状态,在最新 revision 上重放你的变更。',
      )
    }
  },

  getSave(): LoadedSave | null {
    return loadedSave
  },

  requireSave(): LoadedSave {
    if (!loadedSave) {
      throw new Error('No save loaded — call load_save with a file path or inline JSON first')
    }
    return loadedSave
  },

  markDirty(): void {
    revision++
    runtimeContext.scheduleDirtyFlush()
  },

  /** After export_save atomically wrote the loaded path, memory and file agree:
   * clear the pending-dirty/blockedWrite markers so save_status stops reporting
   * "changes not persisted" for state that was just deliberately persisted.
   * Exports to a different path leave the markers alone (the loaded file is
   * still stale). Mirrors the clean-flush reset in flushSave(). */
  markExportedClean(target: string): void {
    if (loadedSave?.path !== target) return
    dirty = false
    lastBlockedWrite = null
  },

  /** dirty=true + debounced flush, without a revision bump (internal: the
   * bump belongs to the mutation, withChange rollback re-schedules a pending
   * flush for already-counted changes without counting them twice). */
  scheduleDirtyFlush(): void {
    dirty = true
    if (flushTimer != null) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      try {
        runtimeContext.flushSave()
      } catch (e) {
        process.stderr.write(`[mcp] save flush failed: ${String(e)}\n`)
      }
    }, SAVE_FLUSH_DEBOUNCE_MS)
  },

  /** Cancel a pending debounced flush — for callers about to flush synchronously. */
  cancelPendingFlush(): void {
    if (flushTimer != null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  },

  /**
   * Transacted, serialized mutation scope (M4 change coordinator).
   *
   * Snapshots every persisted store via captureSaveStores() when the scope is
   * DEQUEUED for execution — never at submission time: two writes submitted in
   * the same stdin batch must not let the second scope's rollback restore a
   * snapshot taken before the first scope committed. If the body throws, the
   * stores, revision, dirty flag, blockedWrite marker, save generation and
   * loaded-save pointer are restored to their pre-scope values and the error
   * propagates — a failed multi-step operation leaves no chimera behind.
   *
   * Scope rules:
   *   - the body must not call other MCP tools or enqueue nested withChange
   *     scopes (the queue would deadlock);
   *   - the body must stay synchronous (no awaits past its first statement):
   *     an async body lets the debounced flush fire mid-scope and persist
   *     intermediate bytes that cannot be rolled back;
   *   - the body should not flushSave() — bytes already written cannot be
   *     rolled back; persist after the scope returns;
   *   - successful changes bump revision themselves via markDirty/setSave
   *     inside the body (this wrapper only counts, never commits);
   *   - pass baseRevision to enforce optimistic concurrency INSIDE the scope
   *     (after all earlier-queued changes landed), closing the dispatch-time
   *     TOCTOU window.
   */
  async withChange<T>(label: string, body: () => Promise<T> | T, options: { baseRevision?: number } = {}): Promise<T> {
    const run = () => {
      // Captured at dequeue time: after every previously submitted scope has
      // settled, before this body runs.
      const restoreStores = captureSaveStores()
      const revisionBefore = revision
      const dirtyBefore = dirty
      const blockedBefore = lastBlockedWrite
      const generationBefore = saveGeneration
      const loadedSaveBefore = loadedSave
      const promise = (async () => {
        if (options.baseRevision != null) {
          runtimeContext.requireRevision(options.baseRevision, label)
        }
        try {
          return await body()
        } catch (e) {
          restoreStores()
          runtimeContext.cancelPendingFlush()
          revision = revisionBefore
          lastBlockedWrite = blockedBefore
          saveGeneration = generationBefore
          loadedSave = loadedSaveBefore
          if (dirtyBefore) runtimeContext.scheduleDirtyFlush()
          else dirty = false
          process.stderr.write(`[mcp] change "${label}" rolled back: ${(e as Error).message}\n`)
          throw e
        }
      })()
      return promise
    }
    const queued = changeQueue.then(run, run)
    changeQueue = queued.catch(() => {})
    return queued
  },

  /**
   * Serialize current stores via SaveState.save(), refresh the in-memory snapshot,
   * and write the string back to the loaded save path (when there is one).
   *
   * Guarded like upstream SaveState.save: a flush that would shrink a non-empty
   * save file to an empty relics or characters set (e.g. a stray reset followed
   * by a character-only write) is blocked. Use export_save to persist a
   * deliberate wipe.
   *
   * A blocked flush (either guard) is NOT a successful one: dirty stays true so
   * save_status keeps reporting pending changes (a later flush/export_save can
   * still persist them), the block is recorded in lastBlockedWrite and surfaced
   * via save_status + stderr, and the sync bridge is NOT notified — clients
   * must never receive an un-persisted state as scanner frames. Only a clean
   * flush clears dirty, resets lastBlockedWrite and pushes the bridge.
   *
   * SaveState.save() returning undefined means the upstream anti-wipe guard
   * itself refused to serialize (the stores would empty a collection its
   * localStorage['state'] reference still holds).
   */
  flushSave(): { bytes: number, path: string | null, blockedWipe: boolean } {
    const stateString = SaveState.save()
    if (stateString == null) {
      process.stderr.write(
        '[mcp] blocked write-back: upstream SaveState.save() refused to serialize the state '
          + '(anti-wipe guard: the current stores hold an empty relics/characters set the persisted '
          + 'state reference does not — use export_save to persist a deliberate reset; changes stay '
          + 'in memory and marked dirty)\n',
      )
      lastBlockedWrite = {
        at: Date.now(),
        reason: '上游 SaveState.save() 拒绝序列化(反擦写护栏:stores 侧集合清空会丢失持久化引用中的数据;刻意重置请用 export_save)',
      }
      // dirty intentionally stays true — the changes exist only in memory
      return { bytes: 0, path: null, blockedWipe: true }
    }
    let path: string | null = null
    let blockedWipe = false
    if (loadedSave?.path) {
      const wipe = detectWipe(stateString, loadedSave.path)
      if (wipe != null) {
        blockedWipe = true
        const what = wipe === 'unparseable'
          ? 'an unparseable state'
          : `an empty ${wipe === 'both' ? 'relics+characters' : wipe} set`
        process.stderr.write(
          `[mcp] blocked write-back: refusing to overwrite save file ${loadedSave.path} with ${what} `
            + `while the file still holds data (use export_save to persist a deliberate reset)\n`,
        )
        const reasonWhat = wipe === 'unparseable'
          ? '无法解析的状态'
          : `空的${wipe === 'both' ? '遗器+角色' : wipe === 'relics' ? '遗器' : '角色'}集合`
        lastBlockedWrite = {
          at: Date.now(),
          reason: `防擦写护栏拦截:拒绝用${reasonWhat}覆写仍持有数据的存档文件 ${loadedSave.path}(刻意重置请用 export_save)`,
        }
      } else {
        writeFileSync(loadedSave.path, stateString)
        path = loadedSave.path
      }
    }
    try {
      loadedSave = {
        path: loadedSave?.path ?? null,
        data: JSON.parse(stateString) as HsrOptimizerSaveFormat,
        loadedAt: loadedSave?.loadedAt ?? Date.now(),
      }
    } catch {
      // Keep the previous snapshot if serialization somehow produced invalid JSON
    }
    if (blockedWipe) {
      // The changes still exist only in memory: keep them marked dirty so
      // save_status keeps reporting pending changes, and do NOT push the
      // un-persisted state to bridge clients.
      return { bytes: 0, path, blockedWipe }
    }
    dirty = false
    lastBlockedWrite = null
    // Sync-bridge change hook (only after a clean flush): re-push the full
    // scanner frame to any connected web clients. Idempotent no-op when the
    // bridge is not running; never lets a push failure break the flush itself.
    try {
      bridgeNotifyChange()
    } catch (e) {
      console.error(`[mcp] bridge change notify failed: ${String(e)}`)
    }
    return { bytes: stateString.length, path, blockedWipe }
  },

  getLastBlockedWrite(): BlockedWrite | null {
    return lastBlockedWrite
  },

  isDirty(): boolean {
    return dirty
  },

  nextCacheId(): string {
    return `opt-${++runCounter}-${Date.now().toString(36)}`
  },

  cacheOptimizeResult(result: CachedOptimizeResult): void {
    lastOptimize = result
  },

  getLastOptimizeResult(): CachedOptimizeResult | null {
    return lastOptimize
  },
}
