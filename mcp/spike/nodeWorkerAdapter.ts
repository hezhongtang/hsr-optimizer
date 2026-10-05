// Throwaway spike: Web Worker-shaped facade over node:worker_threads, so upstream workerPool.ts runs unchanged in Node.
import { Worker } from 'node:worker_threads'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (e: any) => void

export class NodeUnifiedWorker {
  private worker: Worker
  private wrapped = new Map<Listener, Listener>()

  constructor() {
    this.worker = new Worker(new URL((globalThis as any).__HSR_MCP_WORKER_URL))
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
