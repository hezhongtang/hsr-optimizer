// Managed browser runtime for MCP (M7).
//
// One shared headless Chromium (puppeteer-core + a locally discovered
// executable — we never download a browser) plus a localhost static server for
// the upstream site build. Every task runs in its OWN browser context with a
// pre-seeded localStorage['state'] (the exact string SaveState.save() produces
// on the Node side), so page-local mutations can never leak into another task
// or into the MCP-owned save file. Tasks that need to persist browser-made
// changes harvest the page state explicitly and replay it through
// runtimeContext.withChange on the Node side — the browser never writes the
// save itself.
//
// Ownership: browserManager.ts belongs to M7 agent A. Consumers (render.ts,
// debug.ts, artifacts.ts, optimizer.ts GPU path) must only use the exported
// API below and never import puppeteer types directly.
//
// Lifecycle notes:
//   - ensureLaunched() is idempotent (concurrent calls share one launch) and
//     caches a WebGPU probe performed on the served origin (`/__mcp_probe__`,
//     a static page — no app boot).
//   - close() kills the Chromium process (SIGKILL fallback), waits for exit,
//     closes the static server and removes the temp user-data-dir so no
//     processes or files are left behind.
//   - All failure paths throw Chinese, actionable errors naming the missing
//     capability and the env override that fixes it.

import {
  spawnSync,
} from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import {
  tmpdir,
} from 'node:os'
import {
  dirname,
  join,
} from 'node:path'
import {
  fileURLToPath,
} from 'node:url'
import type { HsrOptimizerSaveFormat } from 'types/store'

import { artifactStoreDir } from './artifactStore'
import type { SiteServerHandle } from './siteServer'
import {
  startSiteServer,
} from './siteServer'

// puppeteer is imported lazily (first ensureLaunched) so the MCP server
// startup path stays light; these type-only imports are erased at build time
// and never leak into the exported surface below (no exported signature
// mentions a puppeteer type).
import type {
  Browser,
  BrowserContext,
  Page,
} from 'puppeteer-core'

/** Mirrors BASE_PATH in src/lib/tabs/navigation/constants.ts — the built
 * index.html references absolute /hsr-optimizer/assets/... resources. */
const SITE_BASE_PATH = '/hsr-optimizer'

const BROWSER_PATH_ENV = 'HSR_MCP_BROWSER_PATH'
const SITE_DIST_ENV = 'HSR_MCP_SITE_DIST'

const DEFAULT_CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  // NOTE: deliberately NO --disable-gpu — WebGPU probing is a first-class
  // capability of this manager (see ensureLaunched).
]

const DEFAULT_TASK_TIMEOUT_MS = 120_000
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const

// ─── capability reporting ────────────────────────────────────────────────────

export interface BrowserExecutableStatus {
  found: boolean
  path: string | null
  source: 'env' | 'platform' | null
  version: string | null
  reason?: string
}

export interface BrowserCapabilities {
  executable: BrowserExecutableStatus
  siteDist: SiteDistStatus
  node: string
  artifactsDir: string
}

export interface SiteDistStatus {
  found: boolean
  path: string | null
  source: 'env' | 'repo' | null
  indexHtml: boolean
  assetsDir: boolean
  localesDir: boolean
  reason?: string
}

export interface WebgpuProbe {
  available: boolean
  softwareAdapter: boolean | null
  vendor: string | null
  architecture: string | null
  device: string | null
  maxBufferMB: number | null
  uniformBufferStandardLayout: boolean
  error?: string
}

export interface BrowserLaunchStatus {
  running: boolean
  chromeVersion: string | null
  serverUrl: string | null
  serverPort: number | null
  webgpu: WebgpuProbe | null
  contextCount: number
}

// ─── task API ────────────────────────────────────────────────────────────────

/**
 * Minimal page surface the task callbacks are allowed to use. Keeps the
 * puppeteer dependency contained in this module (consumers stay type-clean).
 */
export interface McpBrowserPage {
  /** Navigate to the site root with a hash (e.g. '#characters'). '' = home. */
  goto(page: string, opts?: { timeoutMs?: number }): Promise<void>
  /** Evaluate a function in the page with JSON-serializable args/result. */
  evaluate<T>(fn: string, args?: unknown[]): Promise<T>
  /** Wait until a selector exists in the DOM (visible = non-zero box). */
  waitForSelector(selector: string, opts?: { timeoutMs?: number, visible?: boolean }): Promise<void>
  /** Wait until any of the texts appears in the page body. */
  waitForText(texts: string[], opts?: { timeoutMs?: number }): Promise<void>
  /** Click the first element matching the selector. Throws in Chinese when missing. */
  click(selector: string, opts?: { timeoutMs?: number }): Promise<void>
  /** Type into a focused input. */
  type(text: string): Promise<void>
  /** Press a key (e.g. 'Enter', 'ArrowDown'). */
  press(key: string): Promise<void>
  /** CDP viewport screenshot; clip is in CSS pixels relative to the page. */
  screenshot(opts?: { clip?: { x: number, y: number, width: number, height: number }, omitBackground?: boolean, fullPage?: boolean }): Promise<Uint8Array>
  /**
   * Drive the site's OWN snapdom export and capture the produced PNG —
   * pixel-identical to what the web Copy/Download buttons produce. The export
   * is triggered by clicking the app's real screenshot button: `via` selects
   * the camera (clipboard) or download icon button, `scopeSelector` optionally
   * narrows which button (e.g. a specific modal/sidebar). The blob is captured
   * by an init-script interception of navigator.clipboard.write and
   * URL.createObjectURL. Tabler icon class names (tabler-icon-camera /
   * tabler-icon-download) are the stable locator.
   */
  captureAppExport(
    opts?: { via?: 'camera' | 'download', scopeSelector?: string, timeoutMs?: number },
  ): Promise<Uint8Array>
  /** Set globalThis.CARD_DEBUG post-load and force a re-render tick (hash re-nav). */
  setCardDebug(enabled: boolean): Promise<void>
  /** Read a value previously stashed by page scripts on window.__HSR_MCP_TASK__. */
  taskGlobals(): Promise<Record<string, unknown>>
  /** The page's serialized state: runs __HSR_DEBUG.SaveState.save() and reads localStorage['state']. */
  harvestSaveState(): Promise<HsrOptimizerSaveFormat | null>
}

export interface RunTaskOptions {
  /** Chinese label used in errors/logs (e.g. 'render(character_card)'). */
  label: string
  /** Save seed written into localStorage before any app script runs. */
  seed?: string
  /** Task parameters exposed to the page as window.__HSR_MCP_TASK__. */
  taskGlobals?: Record<string, unknown>
  /** Viewport; the showcase card needs cardTotalW width headroom. */
  viewport?: { width: number, height: number }
  /** Overall task timeout (default 120_000). On timeout the context closes. */
  timeoutMs?: number
  /** Extra Chromium args for this launch (first launch only). */
  launchArgs?: string[]
}

export interface BrowserManager {
  /** Report executables/dist WITHOUT launching anything (cheap, always safe). */
  reportCapabilities(): Promise<{
    executable: BrowserExecutableStatus,
    siteDist: SiteDistStatus,
    node: string,
    artifactsDir: string,
  }>
  /** True when the shared browser is up. */
  isRunning(): boolean
  /** Launch (idempotent) + probe WebGPU. Throws a Chinese capability error when the executable or dist is missing. */
  ensureLaunched(opts?: { launchArgs?: string[] }): Promise<BrowserLaunchStatus>
  /** Snapshot of the running browser (no side effects). */
  status(): BrowserLaunchStatus
  /** Kill the browser + close the static server. Safe when not running. */
  close(): Promise<void>
  /** Run one isolated task; the per-task context is ALWAYS closed in finally. */
  runTask<T>(opts: RunTaskOptions, fn: (page: McpBrowserPage) => Promise<T>): Promise<T>
}

// ─── executable / dist discovery ─────────────────────────────────────────────

function platformExecutableCandidates(): string[] {
  const filter = (paths: Array<string | undefined>) => paths.filter((p): p is string => !!p)
  switch (process.platform) {
    case 'darwin':
      return filter([
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        process.env.HOME && `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ])
    case 'win32':
      return filter([
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ])
    default:
      return []
  }
}

/** PATH lookup for Linux command names (which(1)); returns the first hit. */
function lookupOnPath(names: string[]): string | null {
  for (const name of names) {
    const result = spawnSync('which', [name], { encoding: 'utf8', timeout: 10_000 })
    if (result.status === 0 && typeof result.stdout === 'string') {
      const path = result.stdout.trim()
      if (path.length > 0 && existsSync(path)) return path
    }
  }
  return null
}

const executableVersionCache = new Map<string, string | null>()

function probeBrowserVersion(executable: string): string | null {
  if (executableVersionCache.has(executable)) return executableVersionCache.get(executable) ?? null
  let version: string | null = null
  try {
    if (process.platform === 'win32') {
      // Windows 的 chrome.exe --version 不往 stdout 输出版本,且当浏览器已在运行时
      // 这次调用会被转交给现有实例——在用户桌面上弹出空白标签。改为读 PE 版本资源。
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${executable.replaceAll(`'`, `''`)}').VersionInfo.ProductVersion`],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      )
      if (result.status === 0 && typeof result.stdout === 'string') {
        version = result.stdout.trim() || null
      }
    } else {
      const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000 })
      if (result.status === 0 && typeof result.stdout === 'string') {
        version = result.stdout.trim() || null
      }
    }
  } catch {
    version = null
  }
  executableVersionCache.set(executable, version)
  return version
}

function findBrowserExecutable(): BrowserExecutableStatus {
  const fromEnv = process.env[BROWSER_PATH_ENV]
  if (fromEnv) {
    if (existsSync(fromEnv)) {
      return {
        found: true,
        path: fromEnv,
        source: 'env',
        version: probeBrowserVersion(fromEnv),
      }
    }
    return {
      found: false,
      path: null,
      source: null,
      version: null,
      reason: `环境变量 ${BROWSER_PATH_ENV}=${fromEnv} 指向的文件不存在`,
    }
  }

  const candidates = platformExecutableCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        found: true,
        path: candidate,
        source: 'platform',
        version: probeBrowserVersion(candidate),
      }
    }
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    const onPath = lookupOnPath(['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'])
    if (onPath != null) {
      return { found: true, path: onPath, source: 'platform', version: probeBrowserVersion(onPath) }
    }
  }
  return {
    found: false,
    path: null,
    source: null,
    version: null,
    reason: `未在任何常见位置找到 Chrome/Chromium 可执行文件(已尝试:${candidates.join('; ') || 'PATH 查找 google-chrome/chromium-browser/chromium'})`,
  }
}

function missingBrowserError(status: BrowserExecutableStatus): Error {
  return new Error(
    `浏览器能力缺失:${status.reason ?? '未找到可执行文件'}。`
      + `受管浏览器(render 截图 / WebGPU 探测等)需要本机已安装 Google Chrome。`
      + `请安装 Chrome,或设置环境变量 ${BROWSER_PATH_ENV} 指向浏览器可执行文件的绝对路径后重启 MCP 服务。`
      + `${status.path ? `(本次检查到的不存在路径:${status.path})` : ''}`,
  )
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function siteDistLooksValid(dir: string): boolean {
  return existsSync(join(dir, 'index.html')) && existsSync(join(dir, 'assets'))
}

function findSiteDist(): SiteDistStatus {
  const fromEnv = process.env[SITE_DIST_ENV]
  if (fromEnv) {
    const indexHtml = existsSync(join(fromEnv, 'index.html'))
    const assetsDir = existsSync(join(fromEnv, 'assets'))
    if (indexHtml && assetsDir) {
      return { found: true, path: fromEnv, source: 'env', indexHtml, assetsDir, localesDir: existsSync(join(fromEnv, 'locales')) }
    }
    return {
      found: false,
      path: null,
      source: null,
      indexHtml,
      assetsDir,
      localesDir: existsSync(join(fromEnv, 'locales')),
      reason: `环境变量 ${SITE_DIST_ENV}=${fromEnv} 指向的目录${indexHtml ? '' : ' 缺少 index.html'}${indexHtml && !assetsDir ? ' 缺少 assets/ 子目录' : ''}`,
    }
  }
  // Walk up from this module: mcp/dist → mcp → repo (built) or mcp/src/… → mcp → repo (source mode)
  let dir = moduleDir()
  for (;;) {
    const candidate = join(dir, 'dist')
    if (siteDistLooksValid(candidate)) {
      return {
        found: true,
        path: candidate,
        source: 'repo',
        indexHtml: true,
        assetsDir: true,
        localesDir: existsSync(join(candidate, 'locales')),
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return {
    found: false,
    path: null,
    source: null,
    indexHtml: false,
    assetsDir: false,
    localesDir: false,
    reason: `从模块位置(${moduleDir()})向上未找到含 index.html 与 assets/ 的 dist/ 目录`,
  }
}

function missingDistError(status: SiteDistStatus): Error {
  return new Error(
    `站点构建产物缺失:${status.reason ?? '未找到 dist/'}。`
      + `受管浏览器需要伺服上游站点的生产构建(dist/ 含 index.html、assets/、locales/)。`
      + `请在仓库根目录执行 npm run build 生成 dist/,或设置环境变量 ${SITE_DIST_ENV} 指向已构建的站点目录后重启 MCP 服务。`,
  )
}

// ─── page-side scripts ───────────────────────────────────────────────────────

/**
 * Runs at document creation on EVERY navigation of a task page, before any
 * application script (puppeteer evaluateOnNewDocument):
 *   1. seeds localStorage['state'] with the exact string SaveState.save()
 *      produces on the Node side — the app's SaveState.load(false, false)
 *      startup path reads this key (src/lib/state/saveState.ts);
 *   2. exposes task parameters as window.__HSR_MCP_TASK__;
 *   3. installs the app-export capture hooks: navigator.clipboard.write and
 *      URL.createObjectURL are patched to stash produced PNG bytes as base64
 *      on window.__HSR_MCP_CAPTURE__ (see captureAppExport).
 */
function taskPageInitScript(cfg: { seed: string | null, taskGlobals: Record<string, unknown> }): void {
  const w = window as unknown as Record<string, unknown>
  try {
    if (cfg.seed != null) localStorage.setItem('state', cfg.seed)
    else localStorage.removeItem('state')
  } catch { /* storage unavailable — app falls back to defaults */ }
  w.__HSR_MCP_TASK__ = cfg.taskGlobals ?? {}

  if (w.__HSR_MCP_CAPTURE_HOOKED__) return
  w.__HSR_MCP_CAPTURE_HOOKED__ = true
  w.__HSR_MCP_CAPTURE__ = null
  w.__HSR_MCP_CAPTURE_ERR__ = null

  const toBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }
  const stash = (mime: string, buffer: ArrayBuffer) => {
    ;(window as unknown as Record<string, unknown>).__HSR_MCP_CAPTURE__ = { mime, base64: toBase64(buffer) }
  }

  // screenshotUtils.ts:673 — navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  const clipboard = navigator.clipboard
  if (clipboard != null && typeof clipboard.write === 'function') {
    const originalWrite = clipboard.write.bind(clipboard)
    type ClipboardWriteItems = Parameters<typeof originalWrite>[0]
    clipboard.write = (data: ClipboardWriteItems) => {
      try {
        const item = Array.isArray(data) ? data[0] : data
        Promise.resolve()
          .then(async () => {
            const types = (item as { types: readonly string[] }).types
            const type = types != null && types.length > 0 ? types[0] : 'image/png'
            const blob = await (item as { getType(t: string): Promise<Blob> }).getType(type)
            stash(type, await blob.arrayBuffer())
          })
          .catch((e: unknown) => {
            ;(window as unknown as Record<string, unknown>).__HSR_MCP_CAPTURE_ERR__ = String(e)
          })
      } catch (e) {
        ;(window as unknown as Record<string, unknown>).__HSR_MCP_CAPTURE_ERR__ = String(e)
      }
      return originalWrite(data)
    }
  }

  // screenshotUtils.ts:688 — URL.createObjectURL(blob) + anchor download
  const originalCreateObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (obj: unknown) => {
    try {
      const blob = obj as Blob
      if (blob != null && typeof blob.arrayBuffer === 'function' && String(blob.type).startsWith('image/')) {
        blob
          .arrayBuffer()
          .then((buffer) => stash(blob.type || 'image/png', buffer))
          .catch(() => {/* captured blob lost — export click still proceeds */})
      }
    } catch { /* not a blob — pass through */ }
    return originalCreateObjectURL(obj as Blob | MediaSource)
  }
}

/** In-page WebGPU capability probe (mirrors lib/gpu/webgpuDevice.ts: adapter.info +
 * limits.maxBufferSize + wgslLanguageFeatures('uniform_buffer_standard_layout')). */
const WEBGPU_PROBE_SCRIPT = `
async () => {
  const empty = (error) => ({
    available: false, softwareAdapter: null, vendor: null, architecture: null,
    device: null, maxBufferMB: null, uniformBufferStandardLayout: false, error,
  })
  try {
    if (navigator.gpu == null) return empty('navigator.gpu 不存在(浏览器未暴露 WebGPU)')
    const adapter = await navigator.gpu.requestAdapter()
    if (adapter == null) return empty('requestAdapter() 返回 null(无可用图形适配器)')
    const info = adapter.info ?? {}
    const desc = String(info.vendor ?? '') + ' ' + String(info.architecture ?? '') + ' ' + String(info.device ?? '')
    const lower = desc.toLowerCase()
    const hasAdapterIdentity = desc.trim().length > 0
    const maxBytes = adapter.limits && typeof adapter.limits.maxBufferSize === 'number' ? adapter.limits.maxBufferSize : null
    const features = navigator.gpu.wgslLanguageFeatures
    return {
      available: true,
      softwareAdapter: hasAdapterIdentity ? (lower.includes('swiftshader') || lower.includes('software')) : null,
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      maxBufferMB: maxBytes != null ? maxBytes / (1024 * 1024) : null,
      uniformBufferStandardLayout: features != null && features.has('uniform_buffer_standard_layout'),
    }
  } catch (e) {
    return empty(String(e))
  }
}
`

// ─── task page wrapper ───────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class TaskPage implements McpBrowserPage {
  // NB: no constructor parameter properties — this module must stay loadable
  // by Node's native type stripping (erasable syntax only), which the smoke
  // harness relies on to exercise runTask from source.
  private readonly page: Page
  private readonly serverUrl: string

  constructor(page: Page, serverUrl: string) {
    this.page = page
    this.serverUrl = serverUrl
  }

  private siteUrl(hash: string): string {
    const normalized = hash === '' || hash.startsWith('#') ? hash : `#${hash}`
    return `${this.serverUrl}${SITE_BASE_PATH}${normalized}`
  }

  async goto(hash: string, opts?: { timeoutMs?: number }): Promise<void> {
    await this.page.goto(this.siteUrl(hash), { waitUntil: 'load', timeout: opts?.timeoutMs ?? 60_000 })
  }

  async evaluate<T>(fn: string, args?: unknown[]): Promise<T> {
    const callArgs = (args ?? []).map((a) => JSON.stringify(a === undefined ? null : a)).join(', ')
    try {
      return (await this.page.evaluate(`(${fn})(${callArgs})`)) as T
    } catch (e) {
      const message = String((e as Error)?.message ?? e)
      // Tolerate plain-expression strings (consumer passed `1 + 1` instead of
      // `() => 1 + 1`): the call-shaped form throws "… is not a function".
      if (/is not a function/i.test(message)) {
        return (await this.page.evaluate(fn)) as T
      }
      throw e
    }
  }

  async waitForSelector(selector: string, opts?: { timeoutMs?: number, visible?: boolean }): Promise<void> {
    try {
      await this.page.waitForSelector(selector, {
        timeout: opts?.timeoutMs ?? 30_000,
        visible: opts?.visible ?? false,
      })
    } catch (e) {
      const message = String((e as Error)?.message ?? e)
      throw new Error(`等待选择器超时:${selector}(${opts?.timeoutMs ?? 30_000}ms 内未${opts?.visible ? '可见' : '出现'})。${message}`)
    }
  }

  async waitForText(texts: string[], opts?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const body = await this.evaluate<string>('() => document.body ? document.body.innerText : ""')
      if (texts.some((text) => body.includes(text))) return
      if (Date.now() >= deadline) {
        throw new Error(`等待页面文本超时(${timeoutMs}ms):期望出现 ${texts.map((t) => `"${t}"`).join(' / ')} 之一,当前正文前 300 字:「${body.slice(0, 300)}」`)
      }
      await sleep(150)
    }
  }

  async click(selector: string, opts?: { timeoutMs?: number }): Promise<void> {
    // puppeteer 25's ClickOptions carries no timeout — wait for the target to
    // be visible/clickable first, then click (both under our Chinese error).
    const timeoutMs = opts?.timeoutMs ?? 15_000
    try {
      await this.page.waitForSelector(selector, { timeout: timeoutMs, visible: true })
      await this.page.click(selector)
    } catch (e) {
      const message = String((e as Error)?.message ?? e)
      throw new Error(`点击目标不存在或不可点击:${selector}(${timeoutMs}ms 内未命中)。${message}`)
    }
  }

  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text)
  }

  async press(key: string): Promise<void> {
    // KeyInput is a puppeteer literal union; the contract takes a plain string
    const keyInput = key as Parameters<Page['keyboard']['press']>[0]
    await this.page.keyboard.press(keyInput)
  }

  async screenshot(
    opts?: { clip?: { x: number, y: number, width: number, height: number }, omitBackground?: boolean, fullPage?: boolean },
  ): Promise<Uint8Array> {
    const bytes: Uint8Array = await this.page.screenshot({
      type: 'png',
      clip: opts?.clip,
      omitBackground: opts?.omitBackground ?? false,
      fullPage: opts?.fullPage ?? false,
    })
    return new Uint8Array(bytes)
  }

  async captureAppExport(
    opts?: { via?: 'camera' | 'download', scopeSelector?: string, timeoutMs?: number },
  ): Promise<Uint8Array> {
    const via = opts?.via ?? 'camera'
    const timeoutMs = opts?.timeoutMs ?? 45_000
    const iconClass = via === 'camera' ? 'tabler-icon-camera' : 'tabler-icon-download'
    const scope = opts?.scopeSelector
    const selector = scope != null && scope.length > 0 ? `${scope} button:has(svg.${iconClass})` : `button:has(svg.${iconClass})`

    await this.evaluate('() => { window.__HSR_MCP_CAPTURE__ = null; window.__HSR_MCP_CAPTURE_ERR__ = null; return true }')
    try {
      await this.page.waitForSelector(selector, { timeout: 15_000, visible: true })
      await this.page.click(selector)
    } catch (e) {
      const message = String((e as Error)?.message ?? e)
      throw new Error(
        `未找到应用的截图按钮(svg.${iconClass}${scope ? `,限定范围 ${scope}` : ''})。`
          + `请确认目标界面已渲染出真实截图按钮(相机=剪贴板导出 / 下载=文件导出)。${message}`,
      )
    }

    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = await this.evaluate<{ cap: { base64: string } | null, err: string | null }>(
        '() => ({ cap: window.__HSR_MCP_CAPTURE__ ?? null, err: window.__HSR_MCP_CAPTURE_ERR__ ?? null })',
      )
      if (state.cap?.base64 != null) {
        return new Uint8Array(Buffer.from(state.cap.base64, 'base64'))
      }
      if (state.err != null) {
        throw new Error(`应用导出截图失败(页内捕获钩子):${state.err}`)
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `等待应用导出截图超时(${timeoutMs}ms):已点击 ${iconClass} 按钮但未捕获到图片。`
            + '可能原因:目标元素截图失败(snapdom)或按钮命中了错误目标(试用 scopeSelector 收窄)。',
        )
      }
      await sleep(150)
    }
  }

  async setCardDebug(enabled: boolean): Promise<void> {
    // globalThis.CARD_DEBUG is initialized to false while the app modules load
    // (CharacterPreview.tsx), so the flag must be set post-load and the page
    // re-navigated (hash round-trip) to force a re-render that picks it up.
    await this.evaluate(
      `async (enabled) => {
        globalThis.CARD_DEBUG = enabled
        const start = location.hash
        location.hash = start === '' ? '#changelog' : ''
        await new Promise((r) => setTimeout(r, 200))
        location.hash = start
        await new Promise((r) => setTimeout(r, 200))
        return true
      }`,
      [enabled],
    )
  }

  async taskGlobals(): Promise<Record<string, unknown>> {
    const value = await this.evaluate<Record<string, unknown> | null>('() => window.__HSR_MCP_TASK__ ?? null')
    return value ?? {}
  }

  async harvestSaveState(): Promise<HsrOptimizerSaveFormat | null> {
    const raw = await this.evaluate<string | null>(
      `async () => {
        try { globalThis.__HSR_DEBUG && globalThis.__HSR_DEBUG.SaveState && globalThis.__HSR_DEBUG.SaveState.save() } catch (e) {}
        return localStorage.getItem('state')
      }`,
    )
    if (raw == null || raw.length === 0) return null
    try {
      return JSON.parse(raw) as HsrOptimizerSaveFormat
    } catch {
      return null
    }
  }
}

// ─── the managed browser ─────────────────────────────────────────────────────

class ManagedBrowser implements BrowserManager {
  private browser: Browser | null = null
  private server: SiteServerHandle | null = null
  private userDataDir: string | null = null
  private chromeVersion: string | null = null
  private webgpu: WebgpuProbe | null = null
  private openContexts = 0
  private launchPromise: Promise<BrowserLaunchStatus> | null = null
  private pendingLaunchArgs: string[] | null = null

  async reportCapabilities(): Promise<BrowserCapabilities> {
    return {
      executable: findBrowserExecutable(),
      siteDist: findSiteDist(),
      node: process.versions.node,
      artifactsDir: artifactStoreDir(),
    }
  }

  isRunning(): boolean {
    return this.browser != null && this.browser.connected === true && this.server != null
  }

  status(): BrowserLaunchStatus {
    return {
      running: this.isRunning(),
      chromeVersion: this.chromeVersion,
      serverUrl: this.server?.url ?? null,
      serverPort: this.server?.port ?? null,
      webgpu: this.isRunning() ? this.webgpu : null,
      contextCount: this.openContexts,
    }
  }

  async ensureLaunched(opts?: { launchArgs?: string[] }): Promise<BrowserLaunchStatus> {
    if (this.isRunning()) return this.status()
    if (this.launchPromise != null) return this.launchPromise

    if (opts?.launchArgs != null && this.pendingLaunchArgs == null) {
      this.pendingLaunchArgs = opts.launchArgs
    }
    this.launchPromise = this.doLaunch().then(
      (status) => {
        this.launchPromise = null
        return status
      },
      (error: unknown) => {
        this.launchPromise = null
        // A failed launch must not leave half-open resources behind
        void this.close().catch(() => {})
        throw error
      },
    )
    return this.launchPromise
  }

  private async doLaunch(): Promise<BrowserLaunchStatus> {
    const executable = findBrowserExecutable()
    if (!executable.found || executable.path == null) throw missingBrowserError(executable)
    const dist = findSiteDist()
    if (!dist.found || dist.path == null || !dist.indexHtml || !dist.assetsDir) throw missingDistError(dist)

    this.server = await startSiteServer(dist.path)
    this.userDataDir = mkdtempSync(join(tmpdir(), 'hsr-mcp-chrome-'))

    const puppeteer = await import('puppeteer-core')
    this.browser = await puppeteer.default.launch({
      executablePath: executable.path,
      headless: true, // puppeteer 25: true = the new headless mode
      userDataDir: this.userDataDir,
      defaultViewport: null, // viewports are set per task page
      args: [...DEFAULT_CHROME_ARGS, ...(this.pendingLaunchArgs ?? [])],
      protocolTimeout: 180_000,
    })
    this.chromeVersion = await this.browser.version()
    this.webgpu = await this.probeWebgpu()
    return this.status()
  }

  /** WebGPU probe on the served origin (a lightweight static page — no app boot). */
  private async probeWebgpu(): Promise<WebgpuProbe | null> {
    if (this.browser == null || this.server == null) return null
    let context: BrowserContext | null = null
    try {
      context = await this.browser.createBrowserContext()
      const page = await context.newPage()
      await page.goto(`${this.server.url}/__mcp_probe__`, { waitUntil: 'load', timeout: 30_000 })
      return (await page.evaluate(`(${WEBGPU_PROBE_SCRIPT})()`)) as WebgpuProbe
    } catch (e) {
      return {
        available: false,
        softwareAdapter: null,
        vendor: null,
        architecture: null,
        device: null,
        maxBufferMB: null,
        uniformBufferStandardLayout: false,
        error: `WebGPU 探测失败:${String((e as Error)?.message ?? e)}`,
      }
    } finally {
      try {
        await context?.close()
      } catch { /* probe context already gone */ }
    }
  }

  async close(): Promise<void> {
    this.launchPromise = null
    this.pendingLaunchArgs = null

    const browser = this.browser
    this.browser = null
    if (browser != null) {
      try {
        await browser.close()
      } catch {
        // browser.close() hung or the pipe is dead — kill the process directly
        const process_ = typeof browser.process === 'function' ? browser.process() : null
        if (process_ != null && process_.exitCode == null && !process_.killed) {
          process_.kill('SIGKILL')
          await new Promise<void>((resolvePromise) => {
            process_.once('exit', () => resolvePromise())
            setTimeout(resolvePromise, 5_000)
          })
        }
      }
    }

    const server = this.server
    this.server = null
    if (server != null) {
      try {
        await server.close()
      } catch { /* listener already gone */ }
    }

    const userDataDir = this.userDataDir
    this.userDataDir = null
    this.chromeVersion = null
    this.webgpu = null
    this.openContexts = 0
    if (userDataDir != null) {
      // Chrome may release profile files a beat after exit — best-effort retry
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(userDataDir, { recursive: true, force: true })
          break
        } catch {
          await sleep(300)
        }
      }
    }
  }

  async runTask<T>(opts: RunTaskOptions, fn: (page: McpBrowserPage) => Promise<T>): Promise<T> {
    await this.ensureLaunched({ launchArgs: opts.launchArgs })
    const browser = this.browser
    const server = this.server
    if (browser == null || server == null) {
      throw new Error(`任务 ${opts.label}:受管浏览器在启动后意外不可用,请重试 launch`)
    }

    const context = await browser.createBrowserContext()
    this.openContexts++
    try {
      // Deliberately NOT granting clipboard permissions. Empirically verified
      // on Chrome 154 headless (localhost secure context, real PNG): a CDP
      // clipboard-read/clipboard-write grant switches Chrome onto a
      // permission-check path that headless DENIES — navigator.clipboard.write
      // then fails with NotAllowedError, while WITHOUT the grant the same
      // write succeeds (the capture hooks and deliver_artifact(copy) both
      // rely on it). Do not re-add the grant without re-running that
      // experiment.

      const page = await context.newPage()
      const viewport = opts.viewport ?? DEFAULT_VIEWPORT
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
      await page.evaluateOnNewDocument(taskPageInitScript, {
        seed: opts.seed ?? null,
        taskGlobals: opts.taskGlobals ?? {},
      })

      const timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`任务 ${opts.label} 超时(${timeoutMs}ms),浏览器上下文已关闭。请缩小任务范围或提高 timeoutMs。`)),
          timeoutMs,
        )
      })
      const taskPromise = fn(new TaskPage(page, server.url))
      // The losing promise of the race may reject later (context closed under
      // it) — swallow that so it never surfaces as an unhandled rejection.
      taskPromise.catch(() => {})
      try {
        return await Promise.race([taskPromise, timeoutPromise])
      } finally {
        clearTimeout(timer)
      }
    } finally {
      this.openContexts--
      try {
        await context.close()
      } catch { /* context already torn down by the timeout path */ }
    }
  }
}

export const browserManager: BrowserManager = new ManagedBrowser()
