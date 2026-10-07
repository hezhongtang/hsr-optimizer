// CallToolResult helpers shared by all domain modules.
//
// Every tool returns both a short human-readable text summary (`content`) and
// the full machine payload (`structuredContent`) so both classic text-only
// clients and structured-content-aware agents work. No outputSchema is
// declared in M1 — payloads stay flexible while the tool surface settles.
//
// `payload` is constrained to Record<string, unknown> (not `unknown`): the
// SDK's CallToolResult declares structuredContent as a string-keyed record,
// and `unknown` would not be assignable to it (the phase-3 tsgo "signature
// noise" was exactly this — a real mismatch, now fixed at the source).

export function toolResult<T extends Record<string, unknown>>(payload: T, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: payload,
  }
}

/**
 * Image variant for render/export tools (M7): the PNG ships as a native MCP
 * image content block (clients that display images show it inline) while the
 * dual-channel contract stays intact — text summary + structured payload.
 * `data` is base64 without the data: prefix.
 */
export function imageResult<T extends Record<string, unknown>>(
  payload: T,
  summary: string,
  image: { data: string, mimeType: 'image/png' },
) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data: image.data, mimeType: image.mimeType },
    ],
    structuredContent: payload,
  }
}
