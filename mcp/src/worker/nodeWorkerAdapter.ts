// Web-Worker-shaped facade over node:worker_threads so the upstream
// `lib/worker/workerPool.ts` (and the score-relics runner) run unchanged in Node.
//
// The worker script URL is resolved at runtime from a global set by the flat
// entry chunks — see src/worker/driverThread.ts (__HSR_MCP_POOL_WORKER_URL)
// and src/index.ts (__HSR_MCP_SCORE_WORKER_URL). Global indirection avoids
// depending on which rollup chunk this module gets inlined into.

import { Worker } from 'node:worker_threads'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (e: any) => void

export class NodeUnifiedWorker {
  private worker: Worker
  private wrapped = new Map<Listener, Listener>()

  constructor(url?: string) {
    // The bundler's `?worker` alias passes the chunk URL explicitly; the
    // `__HSR_MCP_WORKER_URL` global fallback is never set by any entry (each
    // worker entry sets its own __HSR_MCP_*_WORKER_URL). Throw instead of
    // constructing `new Worker(new URL(undefined))` and hanging.
    const resolved = url ?? (globalThis as any).__HSR_MCP_WORKER_URL
    if (typeof resolved !== 'string' || resolved.length === 0) {
      throw new Error(
        'NodeUnifiedWorker: no worker script URL — the ?worker import did not pass one and no '
          + '__HSR_MCP_WORKER_URL global is set (worker entries publish their own '
          + '__HSR_MCP_POOL_WORKER_URL / __HSR_MCP_SCORE_WORKER_URL globals)',
      )
    }
    // Node's Worker accepts URL objects (not file:// href strings)
    this.worker = new Worker(new URL(resolved))
  }

  addEventListener(type: 'message' | 'error', fn: Listener) {
    const w: Listener = type === 'message' ? (data) => fn({ data }) : (err) => fn(err)
    this.wrapped.set(fn, w)
    this.worker.on(type, w)
  }

  removeEventListener(type: 'message' | 'error', fn: Listener) {
    const w = this.wrapped.get(fn)
    if (!w) return
    this.worker.off(type, w)
    this.wrapped.delete(fn)
  }

  postMessage(msg: unknown, transfer?: ArrayBuffer[]) {
    this.worker.postMessage(msg, transfer as any)
  }

  terminate() {
    void this.worker.terminate()
  }
}
