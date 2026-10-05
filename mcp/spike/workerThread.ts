// Throwaway spike: worker_threads entry that gives upstream baseWorker.ts the `self` it expects.
import { parentPort } from 'node:worker_threads'

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any
g.self = g
g.postMessage = (msg: unknown, transfer?: ArrayBuffer[]) => parentPort!.postMessage(msg, transfer as any)
parentPort!.on('message', (data) => g.onmessage?.({ data }))

await import('lib/worker/baseWorker')
