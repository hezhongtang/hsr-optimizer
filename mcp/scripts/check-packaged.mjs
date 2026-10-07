// M9 packaged-install check: prove the MCP runs from OUTSIDE the repository in
// a self-contained tree — translations, media, browser resources, GPU and save
// recovery all resolve without the repo.
//
//   node scripts/check-packaged.mjs
//
// Assembly (temp dir, APFS clones where available so the 400MB+ copies are
// cheap): <tmp>/mcp/{dist,package.json,node_modules} + <tmp>/site-dist (the
// built website). The server is then spawned with cwd=<tmp>/empty-cwd and ONLY
// environment variables pointing at the assembled tree:
//   HSR_MCP_SITE_DIST=<tmp>/site-dist   (browser pages + media + fonts)
//   HSR_MCP_LOCALES_DIR=<tmp>/site-dist/locales  (translations)
//   HSR_MCP_STATE_FILE=<tmp>/state.json (localStorage backend)
// Assertions: i18n zh labels resolve, a real browser render works off the
// copied dist (media + fonts), the WebGPU probe reports, and — after a restart
// with a loaded save — the boot-load path restores the save (web parity).

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const mcpRoot = join(here, '..')
const repoRoot = join(mcpRoot, '..')

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

const tmp = join(tmpdir(), `hsr-mcp-packaged-${Date.now()}`)
try {
  // ── assemble the portable tree ────────────────────────────────────────────
  const mcpTree = join(tmp, 'mcp')
  const siteDist = join(tmp, 'site-dist')
  const emptyCwd = join(tmp, 'empty-cwd')
  mkdirSync(emptyCwd, { recursive: true })
  cpSync(join(mcpRoot, 'dist'), join(mcpTree, 'dist'), { recursive: true })
  cpSync(join(mcpRoot, 'node_modules'), join(mcpTree, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  copyFileSync(join(mcpRoot, 'package.json'), join(mcpTree, 'package.json'))
  if (!existsSync(join(repoRoot, 'dist', 'index.html'))) throw new Error('site dist missing — run `npm run build` at the repo root first')
  cpSync(join(repoRoot, 'dist'), siteDist, { recursive: true })
  const entry = join(mcpTree, 'dist', 'index.js')
  if (!existsSync(entry)) throw new Error(`packaged entry missing: ${entry}`)
  const stateFilePath = join(tmp, 'state.json')

  function connect(stateFilePath) {
    const client = new Client({ name: 'check-packaged', version: '0.0.0' })
    return client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        cwd: emptyCwd,
        env: {
          ...process.env,
          HSR_MCP_STATE_FILE: stateFilePath,
          HSR_MCP_SITE_DIST: siteDist,
          HSR_MCP_LOCALES_DIR: join(siteDist, 'locales'),
        },
      }),
    ).then(() => client)
  }

  // ── phase 1: cold start from the empty cwd ────────────────────────────────
  const sampleCopy = join(tmp, 'sample-save.json')
  copyFileSync(join(repoRoot, 'src', 'data', 'sample-save.json'), sampleCopy)

  const client1 = await connect(stateFilePath)
  try {
    const loaded = await callTool(client1, 'load_save', { path: sampleCopy })
    check('packaged save load works', loaded.loaded === true, `relics=${loaded.relics}`)

    // i18n signal: the characters metadata resource carries zh names — it is
    // populated from the locales tree resolved WITHOUT the repo.
    const rosterResource = await client1.readResource({ uri: 'game://metadata/characters' })
    const rosterJson = JSON.parse(rosterResource.contents[0].text ?? '{}')
    const rosterRows = rosterJson.characters ?? rosterJson.rows ?? []
    const zhNamed = Array.isArray(rosterRows) && rosterRows.slice(0, 20).some((c) => /[\u4e00-\u9fff]/.test(c.nameZh ?? ''))
    check(
      'packaged i18n: zh character names resolve without the repo',
      zhNamed,
      JSON.stringify(rosterRows[0] ?? {}).slice(0, 120),
    )

    // Real browser render off the COPIED dist (media, fonts, snapdom chain).
    const caps = await callTool(client1, 'get_runtime_capabilities', { action: 'status' }, { timeout: 60_000 })
    if (!caps.browserReady) {
      skip('packaged browser render + GPU probe', `受管浏览器未就绪(${caps.executable?.found ? 'dist 缺失' : '缺 Chrome'})`)
    } else {
      const launched = await callTool(client1, 'get_runtime_capabilities', { action: 'launch' }, { timeout: 120_000 })
      check(
        'packaged GPU probe from the copied dist',
        launched.webgpu != null && typeof launched.webgpu.available === 'boolean',
        `webgpu=${launched.webgpu?.available} vendor=${launched.webgpu?.vendor ?? '-'}`,
      )
      const saveRoster = await callTool(client1, 'list_characters', { limit: 1 })
      const firstId = (saveRoster.characters ?? saveRoster.rows ?? [])[0]?.id
      if (firstId == null) throw new Error('loaded sample save has no characters to render')
      const rendered = await callTool(client1, 'render', { target: 'character_card', characterId: firstId }, { timeout: 240_000 })
      check(
        'packaged render: card PNG produced from the copied site dist',
        rendered.format === 'png' && rendered.width >= 800 && rendered.bytes > 50_000,
        `${rendered.width}x${rendered.height}, ${rendered.bytes} bytes`,
      )
    }
  } finally {
    await client1.close()
  }

  // ── phase 2: restart — the boot-load path must restore the save ───────────
  await new Promise((r) => setTimeout(r, 800)) // let the debounced flush land
  const client2 = await connect(stateFilePath)
  try {
    const status = await callTool(client2, 'save_status')
    check(
      'packaged boot-load: save auto-restored after restart (web parity)',
      status.loaded === true && (status.relics ?? 0) > 0,
      `loaded=${status.loaded} relics=${status.relics ?? '-'}`,
    )
  } finally {
    await client2.close()
  }
} catch (e) {
  failures++
  console.log(`[FAIL] packaged check harness — ${String(e.message).slice(0, 200)}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(
  failures === 0
    ? `check-packaged: ALL CHECKS PASSED${skips > 0 ? ` (${skips} skipped)` : ''}`
    : `check-packaged: ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
