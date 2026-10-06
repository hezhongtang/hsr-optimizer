// Browser-global shims required to run the upstream optimizer codebase headless in Node.
//
// ORDERING CONTRACT: this module must be imported FIRST in every entry chunk
// (main thread and every worker thread) before any upstream `lib/*` import.
// Two of the shims are order-sensitive:
//   - `navigator.hardwareConcurrency` is read once by `lib/worker/workerPool.ts`
//     in its singleton constructor, which runs at first import of that module.
//   - `document` / `window` / `location` are read at import time by the store layer.
//
// stdout is reserved exclusively for MCP protocol frames (stdio transport);
// all console output is redirected to stderr in every thread.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  join,
} from 'node:path'
import { format } from 'node:util'
import {
  isMainThread,
} from 'node:worker_threads'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any
const g = globalThis as Any

// ─── console → stderr (stdout belongs to the MCP protocol) ──────────────────
function redirectConsoleToStderr(): void {
  const write = (...args: unknown[]) => process.stderr.write(format(...args) + '\n')
  // Only console.log / console.info / console.debug default to stdout; rebind
  // everything so upstream chatter can never corrupt protocol frames.
  console.log = write
  console.info = write
  console.debug = write
  console.warn = write
  console.error = write
}
redirectConsoleToStderr()

// ─── localStorage: in-memory map with a debounced JSON file backend ─────────
// The upstream save pipeline (SaveState.save) persists through localStorage.
// Backing it with a file means the MCP process restarts with the same state.
const STATE_FILE = process.env.HSR_MCP_STATE_FILE
  ?? join(process.env.HSR_MCP_HOME ?? join(process.env.HOME ?? '~', '.hsr-optimizer-mcp'), 'localstorage.json')

class FileBackedLocalStorage {
  private mem = new Map<string, string>()
  private loaded = false
  private everWritten = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(STATE_FILE)) {
        const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, string>
        for (const [k, v] of Object.entries(parsed)) this.mem.set(k, v)
      }
    } catch (e) {
      process.stderr.write(`[mcp] failed to read localstorage backend ${STATE_FILE}: ${String(e)}\n`)
    }
  }

  private scheduleFlush(): void {
    this.everWritten = true
    if (this.flushTimer != null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 300)
  }

  flush(): void {
    // Defensive: a thread (or process) that never wrote anything and has an
    // empty view must not clobber the shared backend file with `{}`
    if (!this.everWritten && this.mem.size === 0) return
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true })
      writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(this.mem)))
    } catch (e) {
      process.stderr.write(`[mcp] failed to write localstorage backend ${STATE_FILE}: ${String(e)}\n`)
    }
  }

  getItem(key: string): string | null {
    this.ensureLoaded()
    return this.mem.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.ensureLoaded()
    this.mem.set(key, String(value))
    this.scheduleFlush()
  }

  removeItem(key: string): void {
    this.ensureLoaded()
    this.mem.delete(key)
    this.scheduleFlush()
  }

  clear(): void {
    this.ensureLoaded()
    this.mem.clear()
    this.scheduleFlush()
  }
}

const localStorageShim = new FileBackedLocalStorage()

/** Synchronously persist the localStorage backend — called by the main-thread
 * exit/signal handlers after a final flushSave(). */
export function flushLocalStorageBackend(): void {
  localStorageShim.flush()
}

// Exit hook: MAIN THREAD ONLY. Every thread that imports this module gets its
// own in-memory map over the same HSR_MCP_STATE_FILE; a worker flushing on
// exit would clobber the file with its (stale or empty) view — e.g. the pool
// workers reaped after 30s idle. Workers persist nothing; their parent owns
// the backend.
if (isMainThread) {
  process.on('exit', () => localStorageShim.flush())
}

// ─── worker pool sizing ──────────────────────────────────────────────────────
// `lib/worker/workerPool.ts` computes its pool as
//   min(10, max(1, (navigator.hardwareConcurrency || 4) - 1))
// so advertise poolSize + 1 to land on the requested size.
const DEFAULT_WORKERS = 6
const MAX_WORKERS = 10

export function requestedPoolSize(): number {
  const parsed = Number(process.env.HSR_MCP_WORKERS)
  const workers = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WORKERS
  return Math.min(MAX_WORKERS, Math.max(1, workers))
}

export const shimsApplied = true

function applyShims(): void {
  g.window ??= g
  g.self ??= g
  g.addEventListener ??= () => {}
  g.removeEventListener ??= () => {}
  g.postMessage ??= () => {}
  g.location ??= {
    hash: '',
    href: 'http://localhost/',
    pathname: '/',
    search: '',
    origin: 'http://localhost',
    hostname: 'localhost',
  }
  g.history ??= { replaceState: () => {}, pushState: () => {} }
  g.scrollTo ??= () => {}
  g.matchMedia ??= () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })
  g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0)
  g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)

  // Minimal document: Optimizer.optimize → OptimizerTabController.scrollToGrid()
  // calls document.getElementById and bails when it gets null back.
  g.document ??= { getElementById: () => null }

  // Node ≥26 exposes a stub localStorage getter that warns when read — replace
  // it wholesale (never read the existing value) so upstream never sees the stub.
  try {
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      value: localStorageShim,
    })
  } catch {
    // Non-configurable native storage — leave whatever environment provided
  }

  // Node ≥21 ships a read-only global navigator; shadow hardwareConcurrency in
  // place so the upstream pool sizing picks up the configured worker count.
  const hardwareConcurrency = Math.min(MAX_WORKERS + 1, requestedPoolSize() + 1)
  try {
    Object.defineProperty(g.navigator, 'hardwareConcurrency', {
      configurable: true,
      get: () => hardwareConcurrency,
    })
  } catch {
    g.navigator = { hardwareConcurrency }
  }
}

applyShims()
