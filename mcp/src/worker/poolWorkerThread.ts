// node:worker_threads entry for the shared optimizer pool: gives the upstream
// `lib/worker/baseWorker.ts` the `self` / `postMessage` / `onmessage` it expects.
// Shims must run before the dynamic baseWorker import (console redirect keeps
// worker chatter off the protocol stdout).

import '../shims'

import { parentPort } from 'node:worker_threads'

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any
g.self = g
g.postMessage = (msg: unknown, transfer?: ArrayBuffer[]) => parentPort!.postMessage(msg, transfer as any)
parentPort!.on('message', (data) => g.onmessage?.({ data }))

await import('lib/worker/baseWorker')
