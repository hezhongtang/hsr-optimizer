// Artifact store for M7 render/export products (complete implementation —
// shared by render.ts (writes) and the deliver_artifact tool (reads)).
//
// Artifacts are runtime user data, never repo content: they live under
// HSR_MCP_ARTIFACTS_DIR (default os.tmpdir()/hsr-mcp-artifacts) and are
// returned inline as MCP image content at render time, so the files are a
// re-read cache rather than the only channel.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ArtifactMeta {
  artifactId: string
  file: string
  bytes: number
  createdAtIso: string
  label: string
  format: 'png'
}

function artifactsDir(): string {
  return process.env.HSR_MCP_ARTIFACTS_DIR ?? join(tmpdir(), 'hsr-mcp-artifacts')
}

export function artifactStoreDir(): string {
  return artifactsDir()
}

function ensureDir(): void {
  if (!existsSync(artifactsDir())) mkdirSync(artifactsDir(), { recursive: true })
}

function metaPath(artifactId: string): string {
  return join(artifactsDir(), `${artifactId}.json`)
}

function pngPath(artifactId: string): string {
  return join(artifactsDir(), `${artifactId}.png`)
}

function loadMeta(artifactId: string): ArtifactMeta | null {
  if (!/^[a-z0-9-]+$/i.test(artifactId)) return null
  const path = metaPath(artifactId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ArtifactMeta
  } catch {
    return null
  }
}

export function saveArtifact(png: Uint8Array, label: string): ArtifactMeta {
  ensureDir()
  const artifactId = `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(pngPath(artifactId), png)
  const meta: ArtifactMeta = {
    artifactId,
    file: pngPath(artifactId),
    bytes: png.byteLength,
    createdAtIso: new Date().toISOString(),
    label,
    format: 'png',
  }
  writeFileSync(metaPath(artifactId), JSON.stringify(meta))
  return meta
}

export function listArtifacts(): ArtifactMeta[] {
  if (!existsSync(artifactsDir())) return []
  return readdirSync(artifactsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadMeta(f.replace(/\.json$/, '')))
    .filter((m): m is ArtifactMeta => m != null)
    .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso))
}

export function readArtifact(artifactId: string): { meta: ArtifactMeta, png: Uint8Array } | null {
  const meta = loadMeta(artifactId)
  if (meta == null) return null
  const path = pngPath(artifactId)
  if (!existsSync(path)) return null
  const data = readFileSync(path)
  return { meta, png: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

export function deleteArtifact(artifactId: string): ArtifactMeta | null {
  const meta = loadMeta(artifactId)
  if (meta == null) return null
  rmSync(pngPath(artifactId), { force: true })
  rmSync(metaPath(artifactId), { force: true })
  return meta
}

export function artifactStats(): { dir: string, count: number, totalBytes: number } {
  const items = listArtifacts()
  return {
    dir: artifactsDir(),
    count: items.length,
    totalBytes: items.reduce((sum, m) => sum + m.bytes, 0),
  }
}
