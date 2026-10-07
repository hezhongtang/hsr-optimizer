// Localhost static server for the upstream site build (M7 agent A owns this
// file). The server serves the production dist/ directory — the same
// artifacts the website ships — so fonts, locales, portraits and spine assets
// resolve exactly like the deployed site and the whole folder can be moved
// out of the repo (HSR_MCP_SITE_DIST).
//
// Routing mirrors the deployed GitHub Pages layout: the site is built with
// BASE_PATH '/hsr-optimizer' (dist/index.html references absolute
// /hsr-optimizer/assets/...), so the prefix is stripped when mapping URLs to
// disk. Anything that is not an existing file falls back to index.html — the
// app is a hash router (src/lib/tabs/navigation/useHashNavigation.ts), every
// page is '#hash' on the same document, exactly like Pages' 404-fallback.
//
// `GET /__mcp_probe__` is a tiny built-in HTML page (no app boot) used by the
// browser manager's WebGPU probe: navigator.gpu needs a secure same-origin
// document, and 127.0.0.1 is a trustworthy origin — but loading the real app
// for a capability probe would boot workers for nothing.

import { createReadStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { statSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { extname } from 'node:path'
import { join } from 'node:path'
import { normalize } from 'node:path'
import { sep } from 'node:path'

export interface SiteServerHandle {
  url: string
  port: number
  close(): Promise<void>
}

/** Mirrors BASE_PATH in src/lib/tabs/navigation/constants.ts (kept local so
 * this module stays import-free of upstream app code). */
const BASE_PATH = '/hsr-optimizer'

const PROBE_PATH = '/__mcp_probe__'

const PROBE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>mcp-probe</title></head><body>mcp probe</body></html>'

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  // spine assets (dist/assets/*.skel + *.atlas) — byte-exact delivery matters
  '.skel': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
}

function fail(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(message)
}

/**
 * URL → on-disk path inside `distDir`, or null for "serve index.html".
 * Decodes percent-escapes BEFORE segment checks so `%2e%2e%2f` cannot sneak
 * past, rejects NUL/backslashes, and re-verifies the resolved path stays
 * inside distDir (belt and braces on top of the segment check).
 */
function resolveFile(distDir: string, rawPathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPathname)
  } catch {
    return null // malformed escape → SPA fallback (no info leak)
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null

  let pathname = decoded
  if (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)) {
    pathname = pathname.slice(BASE_PATH.length) || '/'
  }
  // Reject traversal before normalize can reinterpret it
  const segments = pathname.split('/')
  if (segments.some((s) => s === '..' || s === '.')) return null

  const relative = normalize(pathname).replace(/^[./\\]+/, '')
  const candidate = relative === '' ? distDir : join(distDir, relative)
  if (candidate !== distDir && !candidate.startsWith(distDir + sep)) return null

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  // Existing SPA route (no extension, or an extension-less app route):
  // hash-router fallback to the document, like Pages' 404 page.
  if (extname(pathname) === '') return join(distDir, 'index.html')
  return null
}

function serveFile(res: ServerResponse, filePath: string): void {
  const type = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  createReadStream(filePath)
    .on('error', () => {
      // Stream died mid-response (file removed between stat and read) — the
      // status line is already gone; end the body so the socket unwinds.
      res.end()
    })
    .pipe(res)
}

function handle(distDir: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, 'method not allowed')
    return
  }
  let pathname: string
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    fail(res, 400, 'bad request')
    return
  }
  if (pathname === PROBE_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : PROBE_HTML)
    return
  }
  const filePath = resolveFile(distDir, pathname)
  if (filePath == null) {
    fail(res, 404, `not found: ${pathname}`)
    return
  }
  if (req.method === 'HEAD') {
    const size = statSync(filePath).size
    res.writeHead(200, {
      'Content-Type': MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'no-store',
    })
    res.end()
    return
  }
  serveFile(res, filePath)
}

export async function startSiteServer(distDir: string): Promise<SiteServerHandle> {
  const indexHtml = join(distDir, 'index.html')
  if (!existsSync(indexHtml)) {
    throw new Error(`站点目录缺少 index.html:${distDir}`)
  }

  const server: Server = createServer((req, res) => {
    try {
      handle(distDir, req, res)
    } catch (e) {
      fail(res, 500, `site server error: ${String(e)}`)
    }
  })
  // Errors on the socket itself (client reset mid-download) must not kill us
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })

  const address = server.address()
  if (address == null || typeof address === 'string') {
    server.close()
    throw new Error('站点伺服未能获取监听端口(意外的 address 类型)')
  }
  const port = address.port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise())
        server.closeAllConnections()
      }),
  }
}
