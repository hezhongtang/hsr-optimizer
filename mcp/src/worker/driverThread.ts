// Driver worker entry: runs the upstream `Optimizer.optimize` orchestration
// inside a worker thread so the MCP main thread stays free to pump protocol
// frames (progress notifications, cancellation) while a search is in flight.
//
// The pool-worker URL global MUST be set before anything imports
// `lib/worker/workerPool` — hence the dynamic import of driverMain below.

import '../shims'

import { parentPort } from 'node:worker_threads'

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any
g.self = g
g.postMessage = (msg: unknown, transfer?: ArrayBuffer[]) => parentPort!.postMessage(msg, transfer as any)
parentPort!.on('message', (data) => g.onmessage?.({ data }))

// Entry chunks are emitted flat into dist/, so sibling resolution is stable.
g.__HSR_MCP_POOL_WORKER_URL = new URL('./poolWorkerThread.js', import.meta.url).href

await import('./driverMain')
