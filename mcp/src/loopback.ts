// In-process tool calls for tools that compose other tools (team_audit).
//
// A composing tool reaches its building blocks the way a client would: through
// a second server instance on an in-memory transport. Both instances share
// this process's stores, caches and workers, so the peer sees exactly the
// loaded save, and each call passes the same input validation and defaults and
// returns the same structured payload as a call from outside. Nothing else in
// the server depends on the instance a tool was registered on.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// A search of a large space runs for minutes; progress resets the clock.
const CALL_TIMEOUT_MS = 30 * 60 * 1000

export type InProcessToolResult = {
  isError: boolean,
  /** The text summary, which carries the message of a tool error */
  text: string | undefined,
  structuredContent: Record<string, unknown> | undefined,
}

let createPeer: (() => McpServer) | null = null
let connecting: Promise<Client> | null = null

/** Called once by the server assembly; the peer is only built on first use. */
export function setLoopbackServerFactory(factory: () => McpServer): void {
  createPeer = factory
}

function connect(): Promise<Client> {
  connecting ??= (async () => {
    if (!createPeer) throw new Error('loopback: 服务端尚未登记实例工厂(setLoopbackServerFactory)')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'hsr-optimizer-loopback', version: '0.0.0' })
    await createPeer().connect(serverTransport)
    await client.connect(clientTransport)
    return client
  })()
  // A failed connection must not be cached.
  connecting.catch(() => {
    connecting = null
  })
  return connecting
}

export async function callToolInProcess(
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<InProcessToolResult> {
  const client = await connect()
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
    resetTimeoutOnProgress: true,
    // The token this adds is what makes the callee send the progress that resets the timeout.
    onprogress: () => {},
    signal: options.signal,
  })
  const content = result.content as { type: string, text?: string }[] | undefined
  return {
    isError: result.isError === true,
    text: content?.find((item) => item.type === 'text')?.text,
    // The in-memory transport hands over the callee's own objects. A copy through JSON is what
    // a client on a real transport receives, and keeps the callee's caches out of the caller's reach.
    structuredContent: result.structuredContent == null ? undefined : JSON.parse(JSON.stringify(result.structuredContent)),
  }
}
