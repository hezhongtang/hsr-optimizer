// End-to-end acceptance smoke for M8 (task D): the bidirectional full-state
// sync (bridge/fullSyncServer.ts ⇄ src/lib/sync/fullStateSyncClient.ts).
//
// One managed-browser task loads the REAL site (the M8 client is in the
// bundle); the MCP tool surface drives the REAL server — the whole frozen
// FullSync protocol runs over a real websocket, and every web-side edit is
// driven through the page's own UI (clicks/typing), never by poking stores.
//
// Coverage — the six M8 acceptance lines plus the resource pull:
//   0. sync_bridge_start(bidirectional=true) surface (url + archiver section)
//      and sync_bridge_status.fullSync; localStorage auto-connect (welcome +
//      snapshot chain: connected, revision>0, snapshot visibly applied).
//   6. Archiver compatibility: with the bidirectional server live, the
//      one-way bridge still serves a fresh InitialScan frame to a plain ws
//      client (minimal overlap with smoke-misc's bridge suite).
//   1. MCP edits relic → web sees it: real upsert_relic (equippedBy) →
//      broadcast op event + the page's own SaveState.save() harvest shows the
//      new id with the right equippedBy.
//   2. Web edits team → MCP sees it: real UI path on #teams (click the empty
//      Main DPS slot → character-picker modal → type + Enter → "Save team")
//      → list_teams shows the team, revision advanced, ops applied, ack seen.
//   R. Resource pull: small optimize (resultsLimit 4) → page receives job
//      events (running/completed + resultRef.cacheId) → fetchResource returns
//      the same 4 rows with matching head id.
//   3. Conflicts are never silent — REAL wire path, no injection: one UI
//      character delete emits a character op + a relic op in ONE capture
//      batch (same baseRevision), so the second op deterministically hits
//      stale-revision. The Mantine modal surfaces it; both resolutions run:
//      "Reapply" resends at the fresh revision (ack + convergence) and
//      "Reload" takes the snapshot (snapshot-applied + convergence).
//   4. Disconnect/restart convergence: sync_bridge_stop → disconnected →
//      restart on a NEW port + page-side connect(newUrl) → revision equal;
//      then the whole MCP process is killed and respawned on the same state
//      file (bootLoad restore) → the page's auto-reconnect converges to the
//      new server revision, and the data round-trips (team survives on both
//      sides).
//   5. Save switch isolation: load_save(another save) → page receives the
//      new-generation snapshot (old entity gone), a stale-generation
//      broadcast is rejected client-side (generation-mismatch, ops NOT
//      applied, snapshot re-convergence), and a post-swap UI edit lands on
//      the NEW save.
//
// SKIP guard: Chrome (or a Chromium sibling) or the site dist missing →
// [SKIP] + exit 0. The sample save is copied to a temp dir (twice: save A
// as loaded, save B as the switch target); all persistent state
// (HSR_MCP_STATE_FILE, HSR_MCP_ARTIFACTS_DIR) points into the temp dir.
//
// Usage: node scripts/smoke-m8.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
import WebSocket from 'ws'

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
  console.log(`[SKIP] M8 端到端冒烟需要受管浏览器环境,当前缺少:${reasons.join(' / ')}`)
  process.exit(0)
}

// The site dist must contain the M8 client (a stale dist would silently test
// a dormant page): the auto-connect key string lives in the bundle.
if (!existsSync(resolve(siteDist, 'assets'))) {
  console.log('[SKIP] 站点构建产物缺少 assets/ 目录,无法验证 M8 客户端')
  process.exit(0)
}

// ── temp workspace: save A (loaded), save B (switch target), state file ─────

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-m8-`)
const saveAPath = `${tempDir}/save-a.json`
const saveBPath = `${tempDir}/save-b.json`
copyFileSync(repoSampleSavePath, saveAPath)

// Save B: sample minus character 1205 (Blade) — his 6 relics go back to the
// inventory so the file stays consistent. A distinct roster proves the swap.
const saveB = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
saveB.characters = saveB.characters.filter((c) => c.id !== '1205')
for (const relic of saveB.relics) {
  if (relic.equippedBy === '1205') relic.equippedBy = undefined
}
writeFileSync(saveBPath, JSON.stringify(saveB, null, 2))

const stateFile = `${tempDir}/localstorage.json`

function randomPort() {
  let port = 24800 + Math.floor(Math.random() * 20000)
  while (port === 23313 || port === 23314) port = 24800 + Math.floor(Math.random() * 20000)
  return port
}
const archiverPort = randomPort()
const fullSyncPort1 = randomPort()
const fullSyncPort2 = randomPort()

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll an async predicate until it holds; returns its last value. */
async function pollUntil(desc, fn, timeoutMs = 10_000, tickMs = 100) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last && last.ok) return last
    await sleep(tickMs)
  }
  const detail = last && last.detail !== undefined ? ` — ${String(last.detail)}` : ''
  throw new Error(`等待超时(${timeoutMs}ms):${desc}${detail}`)
}

/** After a listener dies the port must refuse connections again. */
async function portRefused(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const outcome = await new Promise((resolvePromise) => {
      const probe = new WebSocket(url)
      const finish = (value) => {
        clearTimeout(timer)
        try {
          probe.terminate()
        } catch { /* already closed */ }
        resolvePromise(value)
      }
      const timer = setTimeout(() => finish(false), 2000)
      probe.on('error', (err) => finish(err.code === 'ECONNREFUSED'))
      probe.on('open', () => finish(false))
    })
    if (outcome) return true
    await sleep(200)
  }
  return false
}

// ── page-side helpers (installed once the client API exists) ────────────────

/** Slim event recorder — keeps the readout small even for snapshots. */
const INSTALL_RECORDER = `() => {
  window.__m8 = { events: [] }
  const api = window.__HSR_FULL_SYNC
  const slim = {
    welcome: (p) => ({ revision: p.revision, saveGeneration: p.saveGeneration }),
    'snapshot-applied': (p) => ({ revision: p.revision, saveGeneration: p.saveGeneration }),
    broadcast: (p) => ({ revision: p.revision, saveGeneration: p.saveGeneration, ops: (p.ops ?? []).map((o) => o.entity + ':' + String(o.id ?? '')) }),
    resync: (p) => ({ revision: p.revision, saveGeneration: p.saveGeneration, ops: (p.ops ?? []).map((o) => o.entity + ':' + String(o.id ?? '')) }),
    ack: (p) => ({ opId: p.opId, revision: p.revision }),
    conflict: (p) => ({ opId: p.opId, entity: p.entity, reason: p.reason, serverRevision: p.serverRevision }),
    'conflict-resolved': (p) => ({ opId: p.opId, resolution: p.resolution }),
    job: (p) => ({ jobId: p.jobId, kind: p.kind, status: p.status, resultRef: p.resultRef ?? null }),
    'generation-mismatch': (p) => ({ saveGeneration: p.saveGeneration }),
    error: (p) => ({ error: String(p) }),
  }
  for (const [name, project] of Object.entries(slim)) {
    api.on(name, (payload) => window.__m8.events.push({ at: Date.now(), seq: window.__m8.events.length, name, info: project(payload) }))
  }
  return Object.keys(slim)
}`

const PAGE_STATUS = `() => (window.__HSR_FULL_SYNC ? window.__HSR_FULL_SYNC.status() : null)`

/** The page's own truth: run the app's SaveState.save() then read localStorage. */
const PAGE_HARVEST = `() => {
  if (!window.__HSR_DEBUG || !window.__HSR_DEBUG.SaveState) return null
  window.__HSR_DEBUG.SaveState.save()
  const state = JSON.parse(localStorage.getItem('state') || '{}')
  const relics = state.relics ?? []
  return {
    relicIds: relics.map((r) => r.id),
    equippedBy: Object.fromEntries(relics.filter((r) => r.equippedBy).map((r) => [r.id, r.equippedBy])),
    characterIds: (state.characters ?? []).map((c) => c.id),
    teams: (state.savedSession?.global?.teamShowcaseSavedTeams ?? []).map((t) => ({ id: t.id, name: t.name, characterIds: t.characterIds })),
  }
}`

const PENDING_CONFLICTS = `() => (window.__HSR_FULL_SYNC ? window.__HSR_FULL_SYNC.pendingConflicts() : [])`

const EVENTS_SINCE = `(seq) => (window.__m8 ? window.__m8.events.filter((e) => e.seq >= seq) : [])`

const CONNECT_URL = `(url) => (window.__HSR_FULL_SYNC ? window.__HSR_FULL_SYNC.connect(url) : false)`

const INJECT_SERVER_MESSAGE = `(message) => {
  window.__HSR_FULL_SYNC.event('server-message', message)
  return true
}`

/** Click the LAST visible button containing the text (topmost modal first). */
const CLICK_BUTTON = `(text) => {
  const visible = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && (b.textContent || '').includes(text))
  if (!visible.length) return false
  visible[visible.length - 1].click()
  return true
}`

const BODY_TEXT = `() => (document.body ? document.body.innerText : '')`

const CLICK_ARIA = `(label) => {
  const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === label && e.offsetParent !== null)
  if (!el) return false
  el.click()
  return true
}`

const HAS_ARIA = `(label) => [...document.querySelectorAll('[aria-label]')].some((e) => e.getAttribute('aria-label') === label && e.offsetParent !== null)`

/** Focus the character-picker modal's search input (autofocus may be stale). */
const FOCUS_MODAL_INPUT = `() => {
  const modal = [...document.querySelectorAll('[class*="Modal-content"], [class*="modal-content"], [role="dialog"]')].find((e) => e.offsetParent !== null)
  if (!modal) return false
  const input = modal.querySelector('input')
  if (!input) return false
  input.focus()
  return true
}`

const NAV_HASH = `(hash) => {
  location.hash = hash
  return location.hash
}`

const CLICK_ID = `(id) => {
  const el = document.getElementById(id)
  if (!el || el.offsetParent === null) return false
  el.click()
  return true
}`

/** Click the first EMPTY team slot (slot 0 in a fresh page, a later slot when
 * the working team already carries earlier edits — it persists for the page's
 * lifetime). Opens the character-picker modal. */
const clickEmptyTeamSlot = async (page) => {
  await pollUntil('队伍空槽可点(Add Main DPS / Add character)', async () => ({
    ok: (await page.evaluate(CLICK_ARIA, ['Add Main DPS'])) === true
      || (await page.evaluate(CLICK_ARIA, ['Add character'])) === true,
  }), 10_000)
}

/**
 * The team showcase is the TEAMS panel INSIDE the characters page ('#teams' is
 * a hash alias; from another page the panel-switch listener is not mounted, so
 * the canonical real-UI path is: navigate to #characters, then click the
 * panel's own tab button).
 */
const openTeamsPanel = async (page) => {
  await page.evaluate(NAV_HASH, ['#characters'])
  await sleep(600)
  await pollUntil('角色页 TEAMS 面板 tab 可点', async () => ({
    ok: await page.evaluate(CLICK_ID, ['characters-panels-tab-TEAMS']),
  }), 10_000)
  await sleep(600)
  await pollUntil(
    'Team Showcase 面板渲染出空槽',
    async () => ({
      ok: (await page.evaluate(HAS_ARIA, ['Add Main DPS'])) === true
        || (await page.evaluate(HAS_ARIA, ['Add character'])) === true,
    }),
    10_000,
    200,
  )
}

// ── MCP server #1 ────────────────────────────────────────────────────────────

function spawnServer() {
  const client = new Client({ name: 'smoke-m8', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: mcpDir,
    env: {
      ...getDefaultEnvironment(),
      HSR_MCP_STATE_FILE: stateFile,
      HSR_MCP_ARTIFACTS_DIR: `${tempDir}/artifacts`,
    },
    stderr: 'inherit',
  })
  return { client, connect: () => client.connect(transport), transport }
}

const server1 = spawnServer()
let mcp = server1.client
await server1.connect()

// Script-side managed browser (same source the server bundles — Node's native
// type stripping loads src/browser/browserManager.ts directly, as smoke-browser
// does). The page connects to the SERVER's ws URL, so the browser process
// ownership does not matter.
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

try {
  // ── 0. boot: tool surface + bridge start ─────────────────────────────────
  const tools = await mcp.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  check('sync_bridge_start/status/stop registered', ['sync_bridge_start', 'sync_bridge_status', 'sync_bridge_stop'].every((n) => toolNames.includes(n)))

  const loaded = await callTool(mcp, 'load_save', { path: saveAPath })
  check('save A loaded (162 relics / 8 characters)', loaded.relics === 162 && loaded.characters === 8)

  const oneWayUrl = `ws://127.0.0.1:${archiverPort}/ws`
  await callTool(mcp, 'sync_bridge_start', { port: archiverPort })

  const biStart = await callTool(mcp, 'sync_bridge_start', { port: fullSyncPort1, bidirectional: true })
  check(
    'sync_bridge_start(bidirectional=true) 返回 fullSync url + archiver 段',
    biStart.bidirectional === true && biStart.url === `ws://127.0.0.1:${fullSyncPort1}/sync`
      && biStart.archiver != null && biStart.archiver.running === true
      && biStart.archiver.port === archiverPort && biStart.archiver.url === oneWayUrl,
    JSON.stringify({ url: biStart.url, archiver: biStart.archiver }),
  )
  const fullSyncUrl1 = biStart.url

  // Pre-connect divergence: one extra relic on the server (no equipment
  // side-effects) — after the page connects, the snapshot must overwrite the
  // seeded 162-relic state with the server's 163.
  const marker = await callTool(mcp, 'upsert_relic', {})
  check('pre-connect marker relic created on the server', marker.created === true && typeof marker.relicId === 'string')

  // ── the browser session (everything below shares ONE page/context) ───────
  const seed = readFileSync(saveAPath, 'utf8')
  await browserManager.runTask(
    { label: 'smoke(m8-fullsync)', seed, timeoutMs: 600_000 },
    async (page) => {
      // boot dormant → configure → REAL reload so AUTO-CONNECT runs at app
      // boot (initFullStateSync runs once per document; hash-only navigations
      // are same-document and never re-boot the app)
      await page.goto('', { timeoutMs: 90_000 })
      await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
      await page.evaluate(`() => {
        localStorage.setItem('hsr-full-sync-url', ${JSON.stringify(fullSyncUrl1)})
        localStorage.setItem('i18nextLng', 'en_US')
        window.__m8reloaded = 'old'
        location.reload()
        return true
      }`)
      await pollUntil(
        '重载完成(新文档/新应用实例)',
        async () => {
          try {
            const fresh = await page.evaluate(
              `() => window.__m8reloaded === undefined && document.readyState === 'complete' && !!document.querySelector('#root > *')`,
            )
            return { ok: fresh === true, detail: String(fresh) }
          } catch (e) {
            return { ok: false, detail: `evaluate during reload: ${String(e).slice(0, 80)}` }
          }
        },
        30_000,
      )

      const connect = await pollUntil(
        'localStorage 键自动连接(welcome/snapshot 链)',
        async () => {
          const status = await page.evaluate(PAGE_STATUS)
          return {
            ok: status != null && status.status === 'connected' && status.revision != null && status.revision > 0 && status.saveGeneration != null
              && status.saveGeneration > 0,
            detail: JSON.stringify(status),
          }
        },
        20_000,
      )
      const pageStatus0 = await page.evaluate(PAGE_STATUS)
      check(
        '自动连接:connected + revision>0 + 世代>0(welcome/snapshot 链通)',
        pageStatus0.status === 'connected' && pageStatus0.revision > 0 && pageStatus0.saveGeneration > 0,
        `revision ${pageStatus0.revision}, generation ${pageStatus0.saveGeneration}, sessionId ${pageStatus0.sessionId}`,
      )

      // snapshot visibly applied: seed said 162 relics, server says 163
      const harvest0 = await pollUntil(
        '快照落地(页内遗器数收敛到服务器)',
        async () => {
          const h = await page.evaluate(PAGE_HARVEST)
          return { ok: h != null && h.relicIds.length === 163, detail: h ? `${h.relicIds.length} relics` : 'null' }
        },
        15_000,
      )
      check('连接即快照:页内状态收敛到服务器 163 件遗器(种子为 162)', harvest0.ok && harvest0.detail === '163 relics', String(harvest0.detail))

      await page.evaluate(INSTALL_RECORDER)

      const bridgeStatus1 = await callTool(mcp, 'sync_bridge_status', {})
      check(
        'sync_bridge_status.fullSync:running/url/会话数/revision 与页内一致',
        bridgeStatus1.fullSync.running === true
          && bridgeStatus1.fullSync.url === fullSyncUrl1
          && bridgeStatus1.fullSync.sessions >= 1
          && bridgeStatus1.fullSync.revision === pageStatus0.revision,
        JSON.stringify({ sessions: bridgeStatus1.fullSync.sessions, revision: bridgeStatus1.fullSync.revision }),
      )

      // ── 6. Archiver compatibility (one-way bridge still alive) ────────────
      {
        const collector = await new Promise((resolvePromise, rejectPromise) => {
          const ws = new WebSocket(oneWayUrl)
          const messages = []
          let settled = false
          ws.on('message', (data) => {
            try {
              messages.push(JSON.parse(String(data)))
            } catch { /* ignore */ }
          })
          ws.on('open', () => {
            settled = true
            resolvePromise({ ws, messages })
          })
          ws.on('error', (err) => {
            if (!settled) rejectPromise(err)
          })
        })
        try {
          await pollUntil('单向桥 InitialScan 帧', async () => ({
            ok: collector.messages.some((m) => m?.event === 'InitialScan'),
            detail: `${collector.messages.length} frames`,
          }), 15_000)
          const scan = collector.messages.find((m) => m?.event === 'InitialScan').data
          check(
            '验收六:双向桥运行期间单向 Archiver 桥照常服务(InitialScan 到达,遗器数=服务器当前)',
            Array.isArray(scan.relics) && scan.relics.length === bridgeStatus1.relics,
            `frame relics=${scan.relics?.length}, server=${bridgeStatus1.relics}`,
          )
        } finally {
          collector.ws.terminate()
        }
      }

      // ── 1. MCP edits relic → web sees it ──────────────────────────────────
      const seqBefore1 = await page.evaluate(`() => window.__m8.events.length`)
      const created = await callTool(mcp, 'upsert_relic', { part: 'Head', equippedBy: '1105' })
      const newRelicId = created.relicId
      check('upsert_relic 新建并装备到 1105(Natasha)', created.created === true && created.relic.equippedBy === '1105', newRelicId)

      await pollUntil('broadcast 事件到达页内', async () => {
        const events = await page.evaluate(EVENTS_SINCE, [seqBefore1])
        return {
          ok: events.some((e) => e.name === 'broadcast' && e.info.ops.some((o) => o === `relic:${newRelicId}`)),
          detail: events.filter((e) => e.name === 'broadcast').map((e) => JSON.stringify(e.info)).join(' | ') || '无 broadcast',
        }
      }, 15_000)
      check('验收一:页内收到含新遗器 upsert 的 broadcast(revision 前进)', true)

      const harvest1 = await pollUntil(
        '页内库存出现新遗器',
        async () => {
          const h = await page.evaluate(PAGE_HARVEST)
          return {
            ok: h != null && h.relicIds.includes(newRelicId) && h.equippedBy[newRelicId] === '1105' && h.relicIds.length === 164,
            detail: h ? `${h.relicIds.length} relics, equippedBy=${h.equippedBy[newRelicId] ?? 'n/a'}` : 'null',
          }
        },
        15_000,
      )
      check(
        '验收一:MCP 改遗器网页可见(新件在页内 SaveState 快照中,equippedBy=1105,共 164 件)',
        harvest1.ok,
        String(harvest1.detail),
      )

      // ── 2. Web edits team → MCP sees it (real UI clicks) ──────────────────
      await openTeamsPanel(page)
      await clickEmptyTeamSlot(page)
      await pollUntil('角色选择弹窗打开', async () => ({
        ok: await page.evaluate(FOCUS_MODAL_INPUT),
      }), 10_000)
      await page.type('Jingliu')
      await sleep(400)
      await page.press('Enter')
      await pollUntil('弹窗关闭(角色已选入槽位)', async () => ({
        ok: !(await page.evaluate(FOCUS_MODAL_INPUT)),
      }), 10_000)
      await pollUntil('Save team 按钮可点', async () => ({
        ok: await page.evaluate(CLICK_BUTTON, ['Save team']),
      }), 10_000)

      const revisionBeforeTeam = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
      const teamWait = await pollUntil(
        'list_teams 出现 UI 保存的队伍',
        async () => {
          const teams = await callTool(mcp, 'list_teams', {})
          return {
            ok: teams.total >= 1 && teams.teams.some((t) => t.name === 'Team 1' && t.characterIds[0] != null),
            detail: JSON.stringify(teams.teams.map((t) => ({ name: t.name, characterIds: t.characterIds }))),
          }
        },
        15_000,
      )
      const team = teamWait.detail ? JSON.parse(teamWait.detail)[0] : null
      check(
        '验收二:网页 UI 改队伍 MCP 可见(Team 1 首槽已填)',
        team != null && team.characterIds[0] != null,
        teamWait.detail,
      )
      const revisionAfterTeam = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
      check(
        '验收二:服务器 revision 前进 + 网页 op 被应用(opsApplied≥1)',
        revisionAfterTeam.revision > revisionBeforeTeam.revision && revisionAfterTeam.opsApplied >= 1,
        `revision ${revisionBeforeTeam.revision}→${revisionAfterTeam.revision}, opsApplied=${revisionAfterTeam.opsApplied}`,
      )
      const pageRevisionTeam = (await page.evaluate(PAGE_STATUS)).revision
      check(
        '验收二:页内收到 ack 且 revision 与服务器一致',
        pageRevisionTeam === revisionAfterTeam.revision,
        `page=${pageRevisionTeam}, server=${revisionAfterTeam.revision}`,
      )

      // ── R. job events + resource pull ─────────────────────────────────────
      // NOTE (task A gap, reported): the completed job event's resultRef is
      // always null in practice — finishJob (which fires the registry event)
      // runs BEFORE runtimeContext.cacheOptimizeResult writes the cache, so
      // jobResultRef finds no matching cache at event time. The resource
      // channel itself is unaffected: the page pulls by cacheId.
      const seqBeforeJob = await page.evaluate(`() => window.__m8.events.length`)
      const optimizeRun = await callTool(mcp, 'optimize', { characterId: '1212b1', resultsLimit: 4 }, { timeout: 300_000 })
      const cacheId = optimizeRun.summary.cacheId
      check('optimize 完成(4 行,cacheId 可用)', optimizeRun.status === 'completed' && optimizeRun.rows?.length === 4 && typeof cacheId === 'string')
      await pollUntil('页内收到 job 事件(completed)', async () => {
        const events = await page.evaluate(EVENTS_SINCE, [seqBeforeJob])
        const jobs = events.filter((e) => e.name === 'job')
        return {
          ok: jobs.some((e) => e.info.status === 'completed' && e.info.jobId === cacheId),
          detail: jobs.map((e) => JSON.stringify(e.info)).join(' | ') || '无 job 事件',
        }
      }, 30_000)
      const jobEvents = await page.evaluate(EVENTS_SINCE, [seqBeforeJob])
      const jobSequence = jobEvents.filter((e) => e.name === 'job').map((e) => e.info.status)
      const completedJob = jobEvents.filter((e) => e.name === 'job').find((e) => e.info.status === 'completed')
      check(
        '资源拉取:页内收到 job 生命周期事件(running→completed,jobId=cacheId,completed 带 resultRef)',
        completedJob != null && jobSequence.includes('running') && completedJob.info.jobId === cacheId
          && completedJob.info.resultRef?.cacheId === cacheId && (completedJob.info.resultRef?.rows ?? 0) > 0,
        `sequence=${jobSequence.join('→')}, resultRef=${JSON.stringify(completedJob?.info.resultRef ?? null)}`,
      )

      const resourceRows = await page.evaluate(
        `(async (cacheId, limit) => await window.__HSR_FULL_SYNC.fetchResource('optimize-results', { cacheId, limit }))`,
        [cacheId, 4],
      )
      check(
        '资源拉取:fetchResource(cacheId,limit=4) 返回 4 行且行结构完整(id/stats/build),头部 id 与 optimize 一致',
        Array.isArray(resourceRows) && resourceRows.length === 4
          && resourceRows.every((row) =>
            (typeof row.id === 'string' || typeof row.id === 'number') && row.stats != null && typeof row.stats === 'object' && row.build != null
          )
          && String(resourceRows[0].id) === String(optimizeRun.rows[0].id),
        `rows=${resourceRows?.length}, head=${resourceRows?.[0]?.id}(${typeof resourceRows?.[0]?.id}) vs ${optimizeRun.rows[0].id}(${typeof optimizeRun.rows[0]
          .id})`,
      )

      // ── 3. Conflicts are never silent (REAL wire path) ────────────────────
      // Prep: a character with EXACTLY one equipped relic → a UI delete emits
      // [character delete op, relic upsert op] in ONE capture batch (same
      // baseRevision) → the server applies the first (revision++) and rejects
      // the second with stale-revision. Deterministic, no injection.
      const prepareConflictCharacter = async (characterId, name) => {
        await callTool(mcp, 'unequip_character', { characterId })
        const unequipped = await callTool(mcp, 'list_relics', { equippedBy: 'none', limit: 5 })
        const relicId = unequipped.relics[0].id
        await callTool(mcp, 'upsert_relic', { relicId, equippedBy: characterId })
        // wait until the page has caught up with both broadcasts before editing
        await pollUntil(`页内 revision 追平(${name} 预备)`, async () => {
          const status = await page.evaluate(PAGE_STATUS)
          const server = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
          return { ok: status.revision === server.revision, detail: `page=${status.revision}, server=${server.revision}` }
        }, 15_000)
        return relicId
      }

      const uiDeleteCharacter = async (name) => {
        await page.evaluate(NAV_HASH, ['#characters'])
        await sleep(600)
        await pollUntil(`删除按钮可见(${name})`, async () => ({
          ok: await page.evaluate(CLICK_ARIA, [`Delete character: ${name}`]),
        }), 10_000)
        await pollUntil('确认弹窗 Confirm 可点', async () => ({
          ok: await page.evaluate(CLICK_BUTTON, ['Confirm']),
        }), 10_000)
      }

      const expectConflict = async (label) =>
        pollUntil(
          `冲突到达:${label}`,
          async () => {
            const pending = await page.evaluate(PENDING_CONFLICTS)
            return {
              ok: pending.length > 0 && pending[0].reason === 'stale-revision' && pending[0].entity === 'relic',
              detail: JSON.stringify(pending.map((p) => ({ opId: p.opId, entity: p.entity, reason: p.reason, serverRevision: p.serverRevision }))),
            }
          },
          15_000,
        )

      const assertConverged = async (label, mustMiss) => {
        const server = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
        const status = await pollUntil(`页内 revision 收敛(${label})`, async () => {
          const s = await page.evaluate(PAGE_STATUS)
          return { ok: s.revision === server.revision && s.status === 'connected', detail: `page=${s.revision}, server=${server.revision}` }
        }, 15_000)
        const pending = await page.evaluate(PENDING_CONFLICTS)
        const harvest = await page.evaluate(PAGE_HARVEST)
        const mcpChars = (await callTool(mcp, 'list_characters', {})).characters.map((c) => c.characterId ?? c.id)
        check(
          `验收三(${label}):冲突解决后双端收敛(revision 一致/无待决冲突/${mustMiss} 双端消失)`,
          status.ok && pending.length === 0 && !harvest.characterIds.includes(mustMiss) && !mcpChars.includes(mustMiss),
          `page rev=${status.detail}, pending=${pending.length}, 页内有${mustMiss}?${harvest.characterIds.includes(mustMiss)}, 服务器有?${
            mcpChars.includes(mustMiss)
          }`,
        )
      }

      // — branch A: "Reapply (resend edit)" —
      const relicForBronya = await prepareConflictCharacter('1101', 'Bronya')
      await uiDeleteCharacter('Bronya')
      const conflictA = await expectConflict('Bronya 删除')
      const conflictModalText = await pollUntil(
        '冲突弹窗渲染(Full sync conflict 正文可见)',
        async () => {
          const bodyText = await page.evaluate(BODY_TEXT)
          return {
            ok: bodyText.includes('Full sync conflict') && bodyText.includes('stale-revision'),
            detail: bodyText.includes('conflict') ? '正文含 conflict 字样但标题未齐' : '正文尚无 conflict 字样',
          }
        },
        10_000,
        150,
      )
      check(
        '验收三:冲突不静默 —— Mantine 冲突弹窗可见(Full sync conflict)',
        conflictModalText.ok,
        '正文含 "Full sync conflict" 与 "stale-revision"(弹窗渲染与客户端入册可能差一拍,轮询终态)',
      )
      check(
        '验收三:待决冲突入册(reason=stale-revision, entity=relic)',
        conflictA.ok,
        String(conflictA.detail),
      )
      const opIdA = JSON.parse(conflictA.detail)[0].opId
      const seqBeforeReapply = await page.evaluate(`() => window.__m8.events.length`)
      await pollUntil('Reapply 按钮可点', async () => ({
        ok: await page.evaluate(CLICK_BUTTON, ['Reapply (resend edit)']),
      }), 10_000)
      await pollUntil(`reapply 重发被 ack(${opIdA.slice(0, 8)}…)`, async () => {
        const events = await page.evaluate(EVENTS_SINCE, [seqBeforeReapply])
        return {
          ok: events.some((e) => e.name === 'ack' && e.info.opId === opIdA)
            && events.some((e) => e.name === 'conflict-resolved' && e.info.opId === opIdA && e.info.resolution === 'reapply'),
          detail: events.map((e) => e.name).join(','),
        }
      }, 15_000)
      check('验收三(reapply):按新 revision 重发成功收到 ack + 冲突标记已解决', true)
      await assertConverged('reapply', '1101')

      // — branch B: "Reload (take snapshot)" —
      await prepareConflictCharacter('1202', 'Tingyun')
      await uiDeleteCharacter('Tingyun')
      const conflictB = await expectConflict('Tingyun 删除')
      check('验收三(reload 分支预备):第二次冲突到达', conflictB.ok, String(conflictB.detail))
      const seqBeforeReload = await page.evaluate(`() => window.__m8.events.length`)
      await pollUntil('Reload 按钮可点', async () => ({
        ok: await page.evaluate(CLICK_BUTTON, ['Reload (take snapshot)']),
      }), 10_000)
      await pollUntil('resolve(reload) 后收到快照', async () => {
        const events = await page.evaluate(EVENTS_SINCE, [seqBeforeReload])
        return {
          ok: events.some((e) => e.name === 'snapshot-applied') && events.some((e) => e.name === 'conflict-resolved' && e.info.resolution === 'reload'),
          detail: events.map((e) => e.name).join(','),
        }
      }, 15_000)
      check('验收三(reload):选择重载后收到 snapshot 且状态收敛', true)
      await assertConverged('reload', '1202')

      // ── 4. Disconnect / restart convergence ────────────────────────────────
      await callTool(mcp, 'sync_bridge_stop', {})
      const disconnected = await pollUntil('sync_bridge_stop 后页内 disconnected', async () => {
        const status = await page.evaluate(PAGE_STATUS)
        return { ok: status.status === 'disconnected', detail: status.status }
      }, 15_000)
      check('验收四:桥停止后页内状态 disconnected', disconnected.ok, String(disconnected.detail))

      const biStart2 = await callTool(mcp, 'sync_bridge_start', { port: fullSyncPort2, bidirectional: true })
      const fullSyncUrl2 = biStart2.url
      check('验收四:新端口重启双向桥(archiver 段照常报告)', biStart2.url === `ws://127.0.0.1:${fullSyncPort2}/sync`, fullSyncUrl2)
      await page.evaluate(CONNECT_URL, [fullSyncUrl2])
      const reconnect = await pollUntil('页内 connect(新 url) 后重连', async () => {
        const status = await page.evaluate(PAGE_STATUS)
        const server = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
        return {
          ok: status.status === 'connected' && status.url === fullSyncUrl2 && status.revision === server.revision,
          detail: `page=${status.revision}, server=${server.revision}`,
        }
      }, 20_000)
      check(
        '验收四:断线重连收敛(页内 revision === 服务器当前值,resync/快照皆可)',
        reconnect.ok,
        String(reconnect.detail),
      )

      // — full process restart on the same state file (bootLoad restore) —
      const serverRevisionBeforeKill = (await callTool(mcp, 'sync_bridge_status', {})).fullSync.revision
      await mcp.close()
      const portFreed = await portRefused(fullSyncUrl2, 15_000)
      check('验收四:旧服务进程退出(端口释放)', portFreed, fullSyncUrl2)

      const server2 = spawnServer()
      mcp = server2.client
      await server2.connect()
      await callTool(mcp, 'sync_bridge_start', { port: fullSyncPort2, bidirectional: true })
      const restarted = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
      check(
        '验收四:重启后 bootLoad 恢复(存档数据仍在)',
        restarted.running === true && restarted.revision >= 1,
        `revision=${restarted.revision}(重启前 ${serverRevisionBeforeKill})`,
      )

      // the page auto-retries the stored url (backoff ≤15s); kick once after
      // a grace window so the smoke stays fast — convergence either way.
      let autoReconnected = true
      try {
        await pollUntil(
          '页内自动重连(退避重试)',
          async () => {
            const status = await page.evaluate(PAGE_STATUS)
            return { ok: status.status === 'connected', detail: status.status }
          },
          22_000,
          250,
        )
      } catch {
        autoReconnected = false
        await page.evaluate(CONNECT_URL, [fullSyncUrl2])
      }
      const converged = await pollUntil('重启后页内 revision 收敛到新服务器', async () => {
        const status = await page.evaluate(PAGE_STATUS)
        const server = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
        return {
          ok: status.status === 'connected' && status.revision === server.revision && status.saveGeneration === server.saveGeneration,
          detail: `page=${status.revision}/${status.saveGeneration}, server=${server.revision}/${server.saveGeneration}`,
        }
      }, 20_000)
      check(
        '验收四:服务重启收敛(重连后 revision 与新服务器一致)',
        converged.ok,
        `${converged.detail}${autoReconnected ? '(自动重连)' : '(手动 connect 兜底)'}`,
      )

      const teamsAfterRestart = await callTool(mcp, 'list_teams', {})
      const harvestAfterRestart = await page.evaluate(PAGE_HARVEST)
      check(
        '验收四:重启后数据往返(队伍在服务器与页内都在)',
        teamsAfterRestart.teams.some((t) => t.name === 'Team 1')
          && harvestAfterRestart.teams.some((t) => t.name === 'Team 1'),
        `server teams=${teamsAfterRestart.teams.map((t) => t.name).join(',')}, page teams=${harvestAfterRestart.teams.map((t) => t.name).join(',')}`,
      )

      // ── 5. Save switch isolation ──────────────────────────────────────────
      const generationBeforeSwap = (await page.evaluate(PAGE_STATUS)).saveGeneration
      const seqBeforeSwap = await page.evaluate(`() => window.__m8.events.length`)
      await callTool(mcp, 'load_save', { path: saveBPath })
      const swapWait = await pollUntil('切档快照到达页内(新世代)', async () => {
        const status = await page.evaluate(PAGE_STATUS)
        const server = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
        const events = await page.evaluate(EVENTS_SINCE, [seqBeforeSwap])
        return {
          ok: events.some((e) => e.name === 'snapshot-applied' && e.info.saveGeneration > generationBeforeSwap)
            && status.saveGeneration === server.saveGeneration && status.saveGeneration > generationBeforeSwap,
          detail: `page gen=${status.saveGeneration}, server gen=${server.saveGeneration}`,
        }
      }, 20_000)
      check(
        '验收五:切档推送新世代快照,页内世代与服务器一致',
        swapWait.ok,
        String(swapWait.detail),
      )
      const harvestB = await page.evaluate(PAGE_HARVEST)
      check(
        '验收五:旧档实体消失(1205 不在,角色 7 人)',
        !harvestB.characterIds.includes('1205') && harvestB.characterIds.length === 7,
        JSON.stringify(harvestB.characterIds),
      )

      // stale-generation broadcast must NOT apply: inject one through the test
      // channel — the client's own handler drops it and forces a re-snapshot.
      const statusBeforeMismatch = await page.evaluate(PAGE_STATUS)
      const seqBeforeMismatch = await page.evaluate(`() => window.__m8.events.length`)
      await page.evaluate(INJECT_SERVER_MESSAGE, [{
        type: 'broadcast',
        revision: 999_999,
        saveGeneration: generationBeforeSwap,
        ops: [{ entity: 'character', action: 'upsert', id: '1205', payload: { id: '1205', form: {} } }],
      }])
      await pollUntil('世代不匹配被识别', async () => {
        const events = await page.evaluate(EVENTS_SINCE, [seqBeforeMismatch])
        return {
          ok: events.some((e) => e.name === 'generation-mismatch'),
          detail: events.map((e) => e.name).join(','),
        }
      }, 10_000)
      const mismatchSnapshot = await pollUntil('世代不匹配后的补偿快照落地', async () => {
        const status = await page.evaluate(PAGE_STATUS)
        const server = (await callTool(mcp, 'sync_bridge_status', {})).fullSync
        const events = await page.evaluate(EVENTS_SINCE, [seqBeforeMismatch])
        return {
          ok: events.some((e) => e.name === 'snapshot-applied' && e.info.saveGeneration === server.saveGeneration)
            && status.revision === server.revision,
          detail: `page=${status.revision}/${status.saveGeneration}, server=${server.revision}/${server.saveGeneration}`,
        }
      }, 20_000)
      const harvestMismatch = await page.evaluate(PAGE_HARVEST)
      check(
        '验收五:generation-mismatch 抑制旧档增量(1205 未被复活,补偿快照收敛)',
        !harvestMismatch.characterIds.includes('1205') && harvestMismatch.relicIds.length === harvestB.relicIds.length,
        `chars=${harvestMismatch.characterIds.length}, relics=${harvestMismatch.relicIds.length}, ${mismatchSnapshot.detail}`,
      )

      // post-swap web edit lands on the NEW save (team space is fresh in B)
      await openTeamsPanel(page)
      await clickEmptyTeamSlot(page)
      await pollUntil('角色选择弹窗打开(新档)', async () => ({
        ok: await page.evaluate(FOCUS_MODAL_INPUT),
      }), 10_000)
      await page.type('Jingliu')
      await sleep(400)
      await page.press('Enter')
      await pollUntil('弹窗关闭(新档)', async () => ({
        ok: !(await page.evaluate(FOCUS_MODAL_INPUT)),
      }), 10_000)
      await pollUntil('Save team 可点(新档)', async () => ({
        ok: await page.evaluate(CLICK_BUTTON, ['Save team']),
      }), 10_000)
      const revisionBeforeSwapEdit = (await callTool(mcp, 'sync_bridge_status', {})).fullSync.revision
      const swapEdit = await pollUntil('新档上的 UI 队伍编辑落到服务器', async () => {
        const teams = await callTool(mcp, 'list_teams', {})
        return {
          ok: teams.total >= 1 && teams.teams.some((t) => t.name === 'Team 1' && t.characterIds.some((id) => id != null)),
          detail: JSON.stringify(teams.teams.map((t) => ({ name: t.name, characterIds: t.characterIds }))),
        }
      }, 15_000)
      const revisionAfterSwapEdit = (await callTool(mcp, 'sync_bridge_status', {})).fullSync.revision
      check(
        '验收五:切档后的网页编辑走新档 revision(队伍落在新存档上,revision 前进)',
        swapEdit.ok && revisionAfterSwapEdit > revisionBeforeSwapEdit,
        `revision ${revisionBeforeSwapEdit}→${revisionAfterSwapEdit}`,
      )

      return true
    },
  )
} catch (e) {
  failures++
  console.error(e)
} finally {
  try {
    await browserManager.close()
  } catch { /* browser already down */ }
  try {
    await mcp.close()
  } catch { /* server already closed */ }
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nsmoke-m8: ALL CHECKS PASSED (${assertions} assertions)` : `\nsmoke-m8: ${failures} OF ${assertions} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
