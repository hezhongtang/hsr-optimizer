// node:worker_threads entry for the relic-scoring worker (upstream
// `lib/worker/scoreRelicsWorker.ts`). Reserved for M2: bootstrapped in M1 so
// the `?worker` alias resolves at build time, but NO M1 consumer exists —
// score_relics runs synchronously on the main thread (RelicScorer + scoreTbp,
// ~7ms for 162 relics). When an M2 batch-scoring tool wires this up, point it
// at the __HSR_MCP_SCORE_WORKER_URL global published by src/index.ts.

import '../shims'

import { parentPort } from 'node:worker_threads'

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any
g.self = g
g.postMessage = (msg: unknown, transfer?: ArrayBuffer[]) => parentPort!.postMessage(msg, transfer as any)
parentPort!.on('message', (data) => g.onmessage?.({ data }))

await import('lib/worker/scoreRelicsWorker')
