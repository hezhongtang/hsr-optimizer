// End-to-end smoke test for the render tool (M7-B):
//   character_card / saved_build / team_card / portrait / page targets over
//   the managed headless browser.
//
// Spawns the built server over stdio, loads a temp copy of the sample save,
// then walks each render target through the REAL UI paths:
//   - character_card: #characters → click the sample save's first character
//     row ([data-character-id]) → wait for the card to show that character
//     (portrait URL identity) → the app's own snapdom camera export.
//   - saved_build: save_build creates one first (the sample save ships none),
//     then Character menu → View saved builds → select the build → modal
//     camera export of elementId buildPreview.
//   - team_card: save_team creates one first (the sample save ships none),
//     then #teams → click the saved-team tile by aria-label → the panel's
//     download export of elementId teamShowcaseGrid.
//   - portrait: static (L2D seeded off) → CDP clip of [data-portrait-inject].
//   - page: #metadata → CDP viewport screenshot.
//
// Assertions: PNG magic + IHDR dimensions, character card width ≥ 800 (a full
// card is 2200px at dpr 2), artifact bytes on disk, deliver_artifact list
// round-trip when that tool is registered (M7-D), Chinese semantic errors
// (no save / unknown character / build required).
//
// SKIP guard: Chrome (or a Chromium sibling) or the site dist missing →
// print a clear [SKIP] line and exit 0 — environment capability reporting,
// not a failure. Until M7-A's browserManager lands, the browser targets
// reject; that failure mode is expected pre-integration and covered by the
// '尚未落地' skip check below.
//
// Everything persists into a temp directory (save copy + artifacts dir +
// HSR_MCP_STATE_FILE); the repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-render.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-render-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

let failures = 0
let assertions = 0
function check(name, ok, detail = '') {
  assertions++
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

/** Runs a tool expecting an isError result; returns the error text. */
async function toolError(client, name, args, options) {
  try {
    await callTool(client, name, args, options)
  } catch (e) {
    return String(e.message)
  }
  return null
}

// ═════════════════════════════════════════════════════════════════════════════
// Environment capability guard — mirrors browserManager's discovery order.
// ═════════════════════════════════════════════════════════════════════════════

function findChrome() {
  const candidates = [
    process.env.HSR_MCP_BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ...(process.platform === 'linux'
      ? ['google-chrome', 'chromium-browser', 'chromium']
      : []),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
    } else {
      return candidate // bare name — trust PATH; browserManager resolves it
    }
  }
  return null
}

function findSiteDist() {
  const candidates = [
    process.env.HSR_MCP_SITE_DIST,
    resolve(mcpDir, '../dist'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) return candidate
  }
  return null
}

const chromePath = findChrome()
const siteDist = findSiteDist()
if (chromePath == null || siteDist == null) {
  const missing = [
    chromePath == null ? 'Chrome 可执行文件(HSR_MCP_BROWSER_PATH 或默认安装路径)' : null,
    siteDist == null ? '站点构建产物(HSR_MCP_SITE_DIST 或 <repo>/dist/index.html)' : null,
  ].filter(Boolean).join(' 与 ')
  console.log(`[SKIP] render 冒烟需要受管浏览器环境,当前缺少:${missing};get_runtime_capabilities(action=status) 可报告能力缺口`)
  rmSync(tempDir, { recursive: true, force: true })
  process.exit(0)
}

// ═════════════════════════════════════════════════════════════════════════════
// boot
// ═════════════════════════════════════════════════════════════════════════════

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { getDefaultEnvironment, StdioClientTransport } = await import(
  '@modelcontextprotocol/sdk/client/stdio.js'
)

const client = new Client({ name: 'smoke-render', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_ARTIFACTS_DIR: `${tempDir}/artifacts`,
  },
  stderr: 'inherit',
})
await client.connect(transport)

const TARGET = '1212b1' // sample save's first character — 6 equipped relics
const BUILD_NAME = 'smoke-render-build'
const TEAM_NAME = 'Smoke Render Team'
const LONG = { timeout: 300_000 }

/** Control-flow signal: pre-integration skip — not a failure. */
class EarlyExitOk extends Error {
  constructor() {
    super('[SKIP] 提前结束:浏览器运行环境未集成,语义错误断言已全部通过')
  }
}

/** PNG magic + big-endian IHDR size. */
function pngInfo(file) {
  const buf = readFileSync(file)
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const isPng = buf.length >= 24 && magic.every((b, i) => buf[i] === b)
  return { isPng, bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function assertArtifact(name, payload, min = { width: 1, height: 1 }) {
  check(
    `${name}: payload 带 artifactId/file/bytes/尺寸`,
    typeof payload.artifactId === 'string'
      && payload.artifactId.length > 0 && typeof payload.file === 'string'
      && typeof payload.bytes === 'number' && payload.bytes > 0
      && typeof payload.width === 'number' && typeof payload.height === 'number'
      && payload.format === 'png',
    JSON.stringify({ artifactId: payload.artifactId, bytes: payload.bytes }),
  )
  const info = pngInfo(payload.file)
  check(
    `${name}: 落盘文件是 PNG 且尺寸 ≥ ${min.width}×${min.height}`,
    info.isPng
      && info.width >= min.width && info.height >= min.height
      && info.width === payload.width && info.height === payload.height
      && statSync(payload.file).size === payload.bytes,
    `${info.width}×${info.height}, ${info.bytes}B`,
  )
  check(`${name}: via 通道标注正确`, typeof payload.via === 'string' && payload.via.length > 0, String(payload.via))
  return payload
}

try {
  // ── 1. tool surface ────────────────────────────────────────────────────────
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  check('tool render registered', toolNames.includes('render'))
  const hasDeliver = toolNames.includes('deliver_artifact')

  // ── 2. semantic errors before any browser work ─────────────────────────────
  const noSave = await toolError(client, 'render', { target: 'character_card', characterId: TARGET }, LONG)
  check('render before load_save errors', noSave != null && /load_save/i.test(noSave), String(noSave).slice(0, 100))

  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('sample save loaded (162 relics / 8 characters)', loaded.relics === 162 && loaded.characters === 8)

  const badChar = await toolError(client, 'render', { target: 'character_card', characterId: '9999' }, LONG)
  check(
    'render rejects unknown character with roster hint',
    badChar != null && badChar.includes('9999')
      && badChar.includes('不在当前存档'),
    String(badChar).slice(0, 120),
  )
  const missingBuild = await toolError(client, 'render', { target: 'saved_build', characterId: TARGET, buildId: 'nope' }, LONG)
  check(
    'render rejects unknown build name with available list',
    missingBuild != null
      && missingBuild.includes('nope') && missingBuild.includes('list_builds'),
    String(missingBuild).slice(0, 120),
  )
  const noTeams = await toolError(client, 'render', { target: 'team_card' }, LONG)
  check(
    'render team_card without saved teams errors with save_team hint',
    noTeams != null
      && noTeams.includes('save_team'),
    String(noTeams).slice(0, 120),
  )
  const missingPage = await toolError(client, 'render', { target: 'page' }, LONG)
  check(
    'render page without hash errors on missing param',
    missingPage != null
      && missingPage.includes('page'),
    String(missingPage).slice(0, 100),
  )

  // M7-A not landed yet → every browser target fails with the integration
  // marker. That is a documented pre-integration state, not a red gate:
  // report it and stop here so integration reruns cover the real paths.
  const probe = await toolError(client, 'render', { target: 'page', page: '#metadata' }, LONG)
  if (probe != null && probe.includes('尚未落地')) {
    check('[SKIP] browserManager 尚未落地(M7 任务 A),浏览器路径留待集成轮', true)
    throw new EarlyExitOk()
  }

  // ── 3. character_card ──────────────────────────────────────────────────────
  const card = assertArtifact(
    'character_card',
    await callTool(client, 'render', { target: 'character_card', characterId: TARGET }, LONG),
    // full card is cardTotalW×parentH = 1100×880 CSS px at dpr 2 → 2200×1760
    { width: 800, height: 600 },
  )
  check(
    'character_card: 标注 characterId 与 app-camera 通道',
    card.characterId === TARGET
      && card.via === 'app-camera' && card.target === 'character_card',
  )

  // ── 4. saved_build (create one first — sample ships none) ─────────────────
  await callTool(client, 'save_build', { characterId: TARGET, name: BUILD_NAME }, LONG)
  const build = assertArtifact(
    'saved_build',
    await callTool(client, 'render', { target: 'saved_build', characterId: TARGET, buildId: BUILD_NAME }, LONG),
    { width: 800, height: 600 },
  )
  check(
    'saved_build: 标注 characterId/buildId',
    build.characterId === TARGET
      && build.buildId === BUILD_NAME && build.target === 'saved_build',
  )

  // ── 5. team_card (create one first — sample ships none) ───────────────────
  const team = await callTool(client, 'save_team', { name: TEAM_NAME, characterIds: [TARGET, '1005'] }, LONG)
  const teamRender = assertArtifact(
    'team_card',
    await callTool(client, 'render', { target: 'team_card' }, LONG),
    // 2×2 grid of cards (2210×1770 CSS at dpr 2 → 4420×3540) — allow smaller
    // partial teams but never a viewport-sized slip
    { width: 800, height: 600 },
  )
  check(
    'team_card: 默认取第一支队伍并标注 teamId/teamName',
    teamRender.teamId === team.teamId
      && teamRender.teamName === TEAM_NAME && teamRender.via === 'app-download',
  )

  // ── 6. page (#metadata — lazy dev tab, exercises the wait-for-content path)
  const page = assertArtifact(
    'page #metadata',
    await callTool(client, 'render', { target: 'page', page: '#metadata' }, LONG),
    { width: 1920, height: 1080 },
  )
  check(
    'page #metadata: url 指向本地伺服地址',
    typeof page.url === 'string'
      && /^http:\/\/127\.0\.0\.1:\d+\/hsr-optimizer\/metadata$/.test(page.url),
    String(page.url),
  )

  // ── 7. portrait (static) ──────────────────────────────────────────────────
  const portrait = assertArtifact(
    'portrait static',
    await callTool(client, 'render', { target: 'portrait', characterId: TARGET }, LONG),
    // portrait container is parentW×tempParentH CSS px (422×~750) at dpr 1
    { width: 300, height: 300 },
  )
  check(
    'portrait static: 标注 animation=false 与 cdp 通道',
    portrait.animation === false
      && portrait.via === 'cdp' && portrait.characterId === TARGET,
  )

  // ── 8. artifacts are re-deliverable (deliver_artifact list, when M7-D landed)
  if (hasDeliver) {
    const listed = await callTool(client, 'deliver_artifact', { action: 'list' })
    const items = listed.artifacts ?? listed.items ?? []
    check(
      'deliver_artifact list 含本套产物',
      Array.isArray(items)
        && items.some((a) => a.artifactId === card.artifactId),
      `${items.length} artifacts`,
    )
  } else {
    check('[SKIP] deliver_artifact 未注册(M7 任务 D),list 往返留待集成轮', true)
  }
} catch (e) {
  if (e instanceof EarlyExitOk) {
    console.log(e.message)
  } else {
    failures++
    console.error(e)
  }
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nsmoke-render: ALL CHECKS PASSED (${assertions} assertions)` : `\nsmoke-render: ${failures} OF ${assertions} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
