// HSR Optimizer MCP server entry (stdio transport).
//
// Ordering rules for this file:
//   1. `./shims` must be the FIRST import — the upstream store layer reads
//      window/location/localStorage/navigator at import time, and every worker
//      thread spawned later inherits nothing (they each apply shims themselves).
//   2. Worker-script URLs are resolved from this entry chunk (entries are
//      emitted flat into dist/) and published as globals for the
//      nodeWorkerAdapter; the globals are read lazily at worker construction,
//      so setting them in the module body is safe.
//   3. stdout carries ONLY MCP protocol frames — all diagnostics go to stderr
//      (enforced in shims for every thread).

import './shims'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// Type-only: erased at build, keeps './context' out of the entry chunk's
// eager imports (shims must stay the first runtime import).
import type { runtimeContext as RuntimeContext } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any
g.__HSR_MCP_DRIVER_URL = new URL('./driverThread.js', import.meta.url).href
g.__HSR_MCP_SCORE_WORKER_URL = new URL('./scoreRelicsThread.js', import.meta.url).href

async function main(): Promise<void> {
  const { createMcpServer } = await import('./server')
  const { runtimeContext } = await import('./context')
  const { flushLocalStorageBackend } = await import('./shims')
  const { terminateDriver } = await import('./runOptimizer')
  const { closeBridge } = await import('./domains/bridge')
  const shutdown = registerShutdownHandlers(runtimeContext, flushLocalStorageBackend, terminateDriver, closeBridge)
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // The SDK's stdio transport only hooks stdin 'data'/'error' — stdin EOF does
  // NOT stop the server by itself, and the driver worker holds the engine heap
  // (~2 GB) alive: a client that simply closes its pipe would leave an orphan
  // process until the client's 2s SIGTERM fallback fires. Treat EOF (and the
  // transport's own close, e.g. a protocol-initiated server.close()) as a
  // clean shutdown with the same flush as the signal handlers.
  // NOTE: assign AFTER server.connect — Protocol.connect overwrites onclose.
  const previousOnclose = transport.onclose
  transport.onclose = () => {
    previousOnclose?.()
    shutdown('stdin close')
  }
  process.stdin.on('end', () => shutdown('stdin end'))
  process.stdin.on('close', () => shutdown('stdin close'))

  process.stderr.write(`[mcp] hsr-optimizer server ready (workers: ${navigator.hardwareConcurrency - 1})\n`)
}

/**
 * SIGINT/SIGTERM and stdin EOF/transport close all funnel into one shutdown:
 * Node skips `process.on('exit')` handlers on signal death and the SDK reacts
 * to neither, so without this the last ≤1s debounced save window would be
 * lost (and an EOF would never stop the process at all). Cancel the pending
 * timer, flush synchronously (save file + localStorage backend), close the
 * sync bridge (disconnect web clients cleanly + shutdown log), terminate the
 * driver worker, then exit. Re-entry (second signal / duplicate close event
 * during the flush) exits immediately.
 */
function registerShutdownHandlers(
  context: typeof RuntimeContext,
  flushLocalStorageBackend: () => void,
  terminateDriver: () => void,
  closeBridge: () => void,
): (reason: string) => void {
  let flushing = false
  const shutdown = (reason: string) => {
    if (flushing) process.exit(0)
    flushing = true
    process.stderr.write(`[mcp] shutting down (${reason})\n`)
    try {
      context.cancelPendingFlush()
      context.flushSave()
      flushLocalStorageBackend()
    } catch (e) {
      process.stderr.write(`[mcp] final flush on ${reason} failed: ${String(e)}\n`)
    }
    closeBridge()
    terminateDriver()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  return shutdown
}

void main().catch((error) => {
  process.stderr.write(`[mcp] fatal: ${String((error as Error)?.stack ?? error)}\n`)
  process.exitCode = 1
})
