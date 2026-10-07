// End-to-end smoke test for the managed browser runtime (M7 agent A):
//   get_runtime_capabilities (status/launch/close) + a real headless task
//   through browserManager.runTask + the 4 site:// resources.
//
// Flow: capability status (zero side effects, field-complete) → idempotent
//   launch (running, chromeVersion, server url/port, full WebGPU probe
//   fields) → one isolated task (seeded localStorage['state'] verified from
//   inside the page, task globals round-trip, live status during the task,
//   harvestSaveState) → close (browser down, server url gone, context count
//   0, idempotent second close) → no residual Chrome process for our
//   user-data-dir (pgrep) → site://pages / links / home / help/{topic}
//   content checks against the upstream sources.
//
// SKIP guard: when no local Chrome/Chromium executable or no site dist/
// (repo dist/index.html) is present, print [SKIP] with the reason and exit 0
// — per plan, missing capabilities are reported, not failed.
//
// The repo's sample-save.json is copied to a temp dir before use (the seed is
// read from the copy; nothing ever writes the repo file). All persistent
// state (HSR_MCP_STATE_FILE, HSR_MCP_ARTIFACTS_DIR) points into the temp dir.
//
// Usage: node scripts/smoke-browser.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

// ── SKIP guard: mirror browserManager's discovery (env → platform paths) ────
function findChrome() {
  if (process.env.HSR_MCP_BROWSER_PATH && existsSync(process.env.HSR_MCP_BROWSER_PATH)) {
    return process.env.HSR_MCP_BROWSER_PATH
  }
  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    : process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find((p) => existsSync(p)) ?? null
}

function findSiteDist() {
  if (process.env.HSR_MCP_SITE_DIST && existsSync(`${process.env.HSR_MCP_SITE_DIST}/index.html`)) {
    return process.env.HSR_MCP_SITE_DIST
  }
  const repoDist = resolve(mcpDir, '../dist')
  return existsSync(`${repoDist}/index.html`) && existsSync(`${repoDist}/assets`) ? repoDist : null
}

const chromePath = findChrome()
const siteDist = findSiteDist()
if (chromePath == null || siteDist == null) {
  const reasons = []
  if (chromePath == null) reasons.push('本机未找到 Chrome/Chromium 可执行文件(可装 Chrome 或设 HSR_MCP_BROWSER_PATH)')
  if (siteDist == null) reasons.push('未找到站点构建产物 dist/index.html(可在仓库根 npm run build 或设 HSR_MCP_SITE_DIST)')
  console.log(`[SKIP] 浏览器冒烟未执行:${reasons.join(' / ')}`)
  process.exit(0)
}

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-browser-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const seed = readFileSync(sampleSavePath, 'utf8')

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

function jsonOfResource(readResult) {
  const text = readResult.contents?.[0]?.text
  if (text == null) throw new Error('resource response has no text content')
  return JSON.parse(text)
}

const client = new Client({ name: 'smoke-browser', version: '0.0.0' })
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

try {
  // ── 1. tool registered ─────────────────────────────────────────────────────
  const tools = await client.listTools()
  check('tool get_runtime_capabilities registered', tools.tools.some((t) => t.name === 'get_runtime_capabilities'))

  // ── 2. status: zero side effects, field-complete ──────────────────────────
  const status = await callTool(client, 'get_runtime_capabilities', {})
  check('status default action', status.action === 'status')
  check('status running=false before launch', status.running === false)
  check('status browserReady=true on this machine', status.browserReady === true)
  check(
    'status executable detected (path + version)',
    status.executable.found === true && typeof status.executable.path === 'string'
      && typeof status.executable.version === 'string' && status.executable.version.length > 0,
    JSON.stringify({ path: status.executable.path, version: status.executable.version }),
  )
  check(
    'status site dist detected (index.html + assets + locales)',
    status.siteDist.found === true && status.siteDist.indexHtml === true && status.siteDist.assetsDir === true
      && status.siteDist.localesDir === true && typeof status.siteDist.path === 'string',
    JSON.stringify({ path: status.siteDist.path, source: status.siteDist.source }),
  )
  check('status node version string', typeof status.node === 'string' && /^\d+\.\d+/.test(status.node), String(status.node))
  check('status artifactsDir is the temp override', status.artifactsDir === `${tempDir}/artifacts`)
  check('status chromeVersion/serverUrl/webgpu null before launch', status.chromeVersion === null && status.serverUrl === null && status.webgpu === null)
  check(
    'status engine triple: savedSession null / node CPU / browser null',
    status.engine.savedSessionComputeEngine === null && status.engine.nodeComputeEngine === 'CPU'
      && status.engine.browserWebgpu === null,
    JSON.stringify(status.engine),
  )

  // ── 3. launch: idempotent, full probe surface ─────────────────────────────
  const launched = await callTool(client, 'get_runtime_capabilities', { action: 'launch' })
  check('launch running=true', launched.running === true)
  check(
    'launch chromeVersion probed',
    typeof launched.chromeVersion === 'string' && launched.chromeVersion.length > 0,
    String(launched.chromeVersion),
  )
  check(
    'launch server url/port on loopback',
    typeof launched.serverUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(launched.serverUrl)
      && typeof launched.serverPort === 'number' && launched.serverPort > 0,
    JSON.stringify({ url: launched.serverUrl, port: launched.serverPort }),
  )
  check('launch contextCount=0 (probe context closed)', launched.contextCount === 0)
  const webgpu = launched.webgpu
  check('launch webgpu probe object present', webgpu != null && typeof webgpu === 'object')
  check(
    'launch webgpu probe field-complete',
    webgpu != null && typeof webgpu.available === 'boolean'
      && (webgpu.softwareAdapter === null || typeof webgpu.softwareAdapter === 'boolean')
      && (webgpu.vendor === null || typeof webgpu.vendor === 'string')
      && (webgpu.architecture === null || typeof webgpu.architecture === 'string')
      && (webgpu.device === null || typeof webgpu.device === 'string')
      && (webgpu.maxBufferMB === null || typeof webgpu.maxBufferMB === 'number')
      && typeof webgpu.uniformBufferStandardLayout === 'boolean',
    JSON.stringify(webgpu),
  )
  check(
    'launch engine.browserWebgpu mirrors the probe',
    launched.engine.browserWebgpu === webgpu?.available,
  )

  const relaunched = await callTool(client, 'get_runtime_capabilities', { action: 'launch' })
  check(
    'launch is idempotent (same server, still running)',
    relaunched.running === true && relaunched.serverPort === launched.serverPort,
    `port ${relaunched.serverPort} vs ${launched.serverPort}`,
  )

  // ── 4. one isolated task: seed verified from inside the page ──────────────
  // runTask is exercised from the SAME source the server bundles: Node 26's
  // native type stripping loads src/browser/browserManager.ts directly (the
  // module is deliberately erasable-syntax only), with a resolve hook that
  // maps its extensionless relative imports onto the .ts files. The tool
  // surface above/below proves the server-side lifecycle; this phase proves
  // the task contract itself (seed injection, task globals, harvest).
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (specifier.startsWith('.') && context.parentURL != null && context.parentURL.endsWith('.ts')) {
          try {
            return nextResolve(`${specifier}.ts`, context)
          } catch { /* fall through to the original error */ }
        }
        throw error
      }
    },
  })
  const { pathToFileURL } = await import('node:url')
  const { browserManager } = await import(pathToFileURL(resolve(mcpDir, 'src/browser/browserManager.ts')).href)

  const marker = `smoke-browser-${Date.now()}`
  const liveStatusDuringTask = { running: null, contextCount: null }
  const result = await browserManager.runTask(
    {
      label: 'smoke(trivial)',
      seed,
      taskGlobals: { marker },
      timeoutMs: 180_000,
    },
    async (page) => {
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      const stateLength = await page.evaluate('() => (localStorage.getItem("state") || "").length')
      const globals = await page.taskGlobals()
      const harvested = await page.harvestSaveState()
      const live = browserManager.status()
      liveStatusDuringTask.running = live.running
      liveStatusDuringTask.contextCount = live.contextCount
      return { stateLength, globals, harvested }
    },
  )
  check('task: seeded localStorage["state"] visible in page', result.stateLength === seed.length, `${result.stateLength} vs seed ${seed.length}`)
  check(
    'task: task globals round-trip',
    result.globals != null && typeof result.globals === 'object' && result.globals.marker === marker,
    JSON.stringify(result.globals),
  )
  check(
    'task: harvestSaveState returns the seeded save (relics array)',
    result.harvested != null && Array.isArray(result.harvested.relics) && result.harvested.relics.length > 0,
    result.harvested != null ? `${result.harvested.relics?.length} relics` : 'null',
  )
  check(
    'task: in-process status live during the task (running + contextCount 1)',
    liveStatusDuringTask.running === true && liveStatusDuringTask.contextCount === 1,
    JSON.stringify(liveStatusDuringTask),
  )
  const inProcessAfter = browserManager.status()
  check('task: context closed after the task (contextCount 0, still running)', inProcessAfter.running === true && inProcessAfter.contextCount === 0)
  await browserManager.close()
  check('task instance: close() stops it (in-process status)', browserManager.isRunning() === false)

  // ── 5. close: browser down, idempotent, no residual process ───────────────
  const closed = await callTool(client, 'get_runtime_capabilities', { action: 'close' })
  check('close running=false', closed.running === false)
  check('close server url/port cleared', closed.serverUrl === null && closed.serverPort === null)
  check('close webgpu cleared', closed.webgpu === null)
  check(
    'close keeps artifacts dir reported',
    closed.artifactsDir === `${tempDir}/artifacts` && typeof closed.artifactsCount === 'number',
  )
  const closedAgain = await callTool(client, 'get_runtime_capabilities', { action: 'close' })
  check('close is idempotent', closedAgain.running === false)

  const finalStatus = await callTool(client, 'get_runtime_capabilities', {})
  check('status after close: running=false, browserReady still true', finalStatus.running === false && finalStatus.browserReady === true)
  check('status after close: engine.browserWebgpu null again', finalStatus.engine.browserWebgpu === null)

  // No residual Chrome processes for our user-data-dir (pgrep exit 1 = none)
  const { spawnSync } = await import('node:child_process')
  const pgrep = spawnSync('pgrep', ['-f', 'hsr-mcp-chrome'], { encoding: 'utf8' })
  check(
    'no residual chrome process after close (pgrep -f hsr-mcp-chrome)',
    pgrep.status === 1,
    `pgrep status=${pgrep.status ?? 'err'} stdout=${String(pgrep.stdout).trim()}`,
  )

  // ── 6. site:// resources ───────────────────────────────────────────────────
  const pagesResource = jsonOfResource(await client.readResource({ uri: 'site://pages' }))
  check(
    'site://pages lists all 13 AppPages entries',
    pagesResource.count === 13 && pagesResource.pages.length === 13,
    String(pagesResource.pages?.length),
  )
  const byPage = new Map(pagesResource.pages.map((p) => [p.page, p]))
  check(
    'site://pages hashes match PageToHash (spot: HOME ""/OPTIMIZER #main/WEBGPU_TEST #webgpu)',
    byPage.get('HOME').hash === '' && byPage.get('OPTIMIZER').hash === '#main' && byPage.get('WEBGPU_TEST').hash === '#webgpu'
      && byPage.get('CALCULATORS').hash === '#aha',
    JSON.stringify({ home: byPage.get('HOME').hash, opt: byPage.get('OPTIMIZER').hash, webgpu: byPage.get('WEBGPU_TEST').hash }),
  )
  check(
    'site://pages zh titles + url form + renderPage fields',
    byPage.get('OPTIMIZER').nameZh === '优化器' && byPage.get('OPTIMIZER').urlForm === '/hsr-optimizer#main'
      && byPage.get('OPTIMIZER').renderPage === 'OPTIMIZER',
    JSON.stringify(byPage.get('OPTIMIZER')),
  )

  const linksResource = jsonOfResource(await client.readResource({ uri: 'site://links' }))
  const flatLinks = linksResource.groups.flatMap((g) => g.links)
  check(
    'site://links community card URLs match HomeTab source',
    flatLinks.some((l) => l.url === 'https://discord.gg/rDmB4Un7qg')
      && flatLinks.some((l) => l.url === 'https://github.com/fribbels/hsr-optimizer')
      && flatLinks.some((l) => l.url === 'https://github.com/users/fribbels/projects/2')
      && flatLinks.some((l) => l.internalHash === '#changelog'),
    JSON.stringify(linksResource.groups[0].links),
  )
  check(
    'site://links sidebar group URLs match MenuDrawer source (ko-fi + leak-free site)',
    flatLinks.some((l) => l.url === 'https://ko-fi.com/fribbels')
      && flatLinks.some((l) => l.url === 'https://starrailoptimizer.github.io/'),
    JSON.stringify(linksResource.groups[1].links),
  )

  const homeResource = jsonOfResource(await client.readResource({ uri: 'site://home' }))
  check(
    'site://home carries optimizer + data versions and 11 non-dev entries',
    typeof homeResource.optimizerVersion === 'string' && homeResource.optimizerVersion.startsWith('v')
      && typeof homeResource.dataVersion === 'string' && homeResource.entries.length === 11,
    JSON.stringify({ v: homeResource.optimizerVersion, d: homeResource.dataVersion, n: homeResource.entries.length }),
  )

  const helpReliquary = jsonOfResource(await client.readResource({ uri: 'site://help/reliquary' }))
  check(
    'site://help/reliquary matches importConfig releases URL + zh title',
    helpReliquary.url === 'https://github.com/IceDynamix/reliquary-archiver/releases/latest'
      && typeof helpReliquary.titleZh === 'string' && helpReliquary.titleZh.includes('Reliquary')
      && Array.isArray(helpReliquary.points) && helpReliquary.points.length > 0,
    JSON.stringify({ url: helpReliquary.url, title: helpReliquary.titleZh }),
  )
  const helpUnknown = await (async () => {
    try {
      await client.readResource({ uri: 'site://help/nope' })
      return null
    } catch (e) {
      return String(e.message)
    }
  })()
  check(
    'site://help/{unknown topic} errors with the topic list',
    helpUnknown != null && helpUnknown.includes('reliquary') && helpUnknown.includes('live-import'),
    String(helpUnknown).slice(0, 120),
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nsmoke-browser: ALL CHECKS PASSED (${assertions} assertions)` : `\nsmoke-browser: ${failures} OF ${assertions} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
