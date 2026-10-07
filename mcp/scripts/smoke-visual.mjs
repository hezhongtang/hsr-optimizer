// M9 visual regression: render a fixed character card from the sample save and
// compare it against a committed baseline PNG (mcp/coverage/baselines/).
//
//   node scripts/smoke-visual.mjs                    # compare against baseline
//   node scripts/smoke-visual.mjs --update-baseline  # regenerate the baseline
//
// The comparison decodes both PNGs with a minimal in-file decoder (8-bit RGBA,
// non-interlaced, all five row filters) and asserts:
//   - identical dimensions
//   - mean per-channel abs diff <= MEAN_TOLERANCE
//   - share of "hot" pixels (any channel diff > HOT_PIXEL_DELTA) <= HOT_RATIO
// The baseline is machine/Chrome pinned (font rasterization): on hosts with a
// different Chrome or without one this suite [SKIP]s with the reason. Gross
// mismatches fail with a diff summary so the change is visible, not silent.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

const here = import.meta.dirname
const mcpRoot = join(here, '..')
const repoRoot = resolve(mcpRoot, '..')
const baselinePath = join(mcpRoot, 'coverage', 'baselines', 'character-card-sample.png')
const updateBaseline = process.argv.includes('--update-baseline')

import { resolve } from 'node:path'

// ── tolerances ───────────────────────────────────────────────────────────────
const MEAN_TOLERANCE = 2.0
const HOT_PIXEL_DELTA = 24
const HOT_RATIO_TOLERANCE = 0.02

let failures = 0
let skips = 0
function check(name, ok, detail) {
  if (ok) console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(name, reason) {
  skips++
  console.log(`[SKIP] ${name} — ${reason}`)
}

// ── minimal PNG decoder (8-bit, non-interlaced; filters 0-4) ─────────────────
function decodePng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error('not a PNG (bad signature)')
  }
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (pos < bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const data = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
  if (channels == null) throw new Error(`unsupported color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    const row = raw.subarray(rowStart, rowStart + stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = prev != null ? prev[x] : 0
      const c = prev != null && x >= channels ? prev[x - channels] : 0
      let value = row[x]
      if (filter === 1) value = (value + a) & 0xff
      else if (filter === 2) value = (value + b) & 0xff
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      out[y * stride + x] = value
    }
  }
  return { width, height, channels, data: out }
}

function diffPngs(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { dimsMismatch: true, w: `${a.width}x${a.height} vs ${b.width}x${b.height}` }
  }
  const pixels = a.width * a.height
  let sumDiff = 0
  let hot = 0
  for (let i = 0; i < pixels; i++) {
    let pixelDiff = 0
    let pixelHot = false
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i * a.channels + c] - b.data[i * b.channels + c])
      pixelDiff += d
      if (d > HOT_PIXEL_DELTA) pixelHot = true
    }
    sumDiff += pixelDiff / 3
    if (pixelHot) hot++
  }
  return { dimsMismatch: false, mean: sumDiff / pixels, hotRatio: hot / pixels, hotPixels: hot, pixels }
}

// ── harness ──────────────────────────────────────────────────────────────────
function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}

const tempDir = join(tmpdir(), `hsr-mcp-visual-${Date.now()}`)
mkdirSync(tempDir, { recursive: true })
const stateFile = join(tempDir, 'localstorage.json')

const client = new Client({ name: 'smoke-visual', version: '0.0.0' })
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(mcpRoot, 'dist', 'index.js')],
      cwd: mcpRoot,
      env: { ...process.env, HSR_MCP_STATE_FILE: stateFile },
    }),
  )

  // Skip when the managed browser cannot run at all — visual parity needs it.
  let browserGate = null
  try {
    const caps = await callTool(client, 'get_runtime_capabilities', { action: 'status' })
    if (!caps.browserReady) browserGate = `受管浏览器未就绪(executable.found=${caps.executable?.found}, dist=${caps.siteDist?.found})`
  } catch (e) {
    browserGate = `能力探测失败:${String(e.message).slice(0, 80)}`
  }

  if (browserGate != null) {
    skip('visual regression', browserGate)
  } else {
    const sampleCopy = join(tempDir, 'sample-save.json')
    copyFileSync(join(repoRoot, 'src', 'data', 'sample-save.json'), sampleCopy)
    await callTool(client, 'load_save', { path: sampleCopy })

    const roster = await callTool(client, 'list_characters', { limit: 1 })
    const characterId = roster.characters?.[0]?.id ?? roster.rows?.[0]?.id
    if (characterId == null) throw new Error('sample save has no characters to render')

    const rendered = await callTool(client, 'render', { target: 'character_card', characterId }, { timeout: 180_000 })
    const artifactId = rendered.artifactId
    if (artifactId == null) throw new Error(`render returned no artifactId: ${JSON.stringify(rendered).slice(0, 200)}`)
    const png = readFileSync(join(rendered.file))

    if (updateBaseline || !existsSync(baselinePath)) {
      mkdirSync(join(mcpRoot, 'coverage', 'baselines'), { recursive: true })
      writeFileSync(baselinePath, png)
      console.log(
        `[BASELINE] ${
          updateBaseline ? 'regenerated' : 'created'
        } ${baselinePath} (${png.length} bytes, ${rendered.width}x${rendered.height}, character ${characterId})`,
      )
      check(
        'baseline written and decodes',
        (() => {
          decodePng(png)
          return true
        })(),
        `${rendered.width}x${rendered.height}`,
      )
    } else {
      const baseline = decodePng(readFileSync(baselinePath))
      const current = decodePng(png)
      const diff = diffPngs(baseline, current)
      if (diff.dimsMismatch) {
        check('visual baseline dimensions match', false, diff.w)
      } else {
        check(
          `visual regression: mean diff ${diff.mean.toFixed(3)} <= ${MEAN_TOLERANCE}`,
          diff.mean <= MEAN_TOLERANCE,
          `mean=${diff.mean.toFixed(3)} hot=${diff.hotPixels}/${diff.pixels} (${(diff.hotRatio * 100).toFixed(2)}%)`,
        )
        check(
          `visual regression: hot pixels ${(diff.hotRatio * 100).toFixed(2)}% <= ${(HOT_RATIO_TOLERANCE * 100).toFixed(1)}%`,
          diff.hotRatio <= HOT_RATIO_TOLERANCE,
          `delta>${HOT_PIXEL_DELTA} on ${diff.hotPixels} pixels`,
        )
      }
    }
  }
} catch (e) {
  failures++
  console.log(`[FAIL] visual regression harness — ${String(e.message).slice(0, 200)}`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(
  failures === 0
    ? `smoke-visual: ${updateBaseline ? 'BASELINE UPDATED' : 'ALL CHECKS PASSED'}${skips > 0 ? ` (${skips} skipped)` : ''}`
    : `smoke-visual: ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
