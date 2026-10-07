// render tool (M7 agent B owns this file).
// character_card / saved_build / team_card / portrait / page targets.
//
// Render is READ-ONLY against the save: every task runs in an isolated
// browser context seeded with a copy of the current snapshot
// (readStructuredSnapshot()), page-local UI mutations never reach the Node
// stores, and nothing is harvested back — the only output is a PNG artifact.
//
// UI-driving evidence (file:line as of this writing):
//   - character rows carry data-character-id / data-selected
//     (src/lib/tabs/tabCharacters/CharacterGrid.tsx:330-340); clicking a row
//     sets the focus character (handleRowClick, CharacterGrid.tsx:192-195).
//   - the right-hand card mounts CharacterPreview with id='characterTabPreview'
//     (src/lib/tabs/tabCharacters/CharactersPanelContent.tsx:111-117) and the
//     card element itself is <div id={id} className='characterPreview'>
//     (src/lib/characterPreview/CharacterPreview.tsx:548-550).
//   - the card screenshot buttons (IconCamera/IconDownload) live in
//     ShowcaseCustomizationSidebar's ScreenshotPanel
//     (src/lib/characterPreview/customization/ShowcaseCustomizationSidebar.tsx:128-155)
//     and drive screenshotElementById(id, action) — snapdom, dpr 2
//     (src/lib/utils/screenshotUtils.ts:577+).
//   - saved builds open from the Character menu → 'View saved builds'
//     (src/lib/tabs/tabCharacters/CharacterMenu.tsx:133-136, items listed
//     :146-217 — viewBuilds is the 7th menu item); the modal screenshot
//     buttons target elementId 'buildPreview'
//     (src/lib/overlays/modals/BuildsModal.tsx:92, 194-202, 220).
//   - teams live under #teams (src/lib/tabs/tabCharacters/characterPanels.ts),
//     saved team tiles are UnstyledButton[aria-label=team.name]
//     (src/lib/tabs/tabTeamShowcase/savedTeams/SavedTeamsList.tsx:243-247)
//     with data-active on the tile (:181), the grid is
//     id='teamShowcaseGrid' (teamShowcaseConstants.ts:11) and the Download
//     screenshot button is in SavedTeamsActions
//     (src/lib/tabs/tabTeamShowcase/savedTeams/SavedTeamsActions.tsx:49-59).
//   - every page hash maps to a persistent wrapper div with id=<AppPages key>
//     whose display toggles (src/lib/tabs/Tabs.tsx:236) — hash→page via
//     HashToPage (src/lib/tabs/navigation/constants.ts:74-78).
//   - the portrait container carries data-portrait-inject + positioning
//     data attrs; L2D renders [data-portrait-spine] (spine canvas) and the
//     static portrait renders [data-portrait-foreground]
//     (src/lib/characterPreview/card/ShowcasePortrait.tsx:106-158). The L2D
//     switch is the GLOBAL savedSession.showcaseL2D key
//     (ShowcaseCustomizationSidebar.tsx:488-500 → SavedSessionKeys.showcaseL2D,
//     default true per appStore.ts:24) — the render task seeds it into the
//     page-local state copy instead of clicking the segmented control.
//     useSpine requires spine data + no custom portrait
//     (ShowcasePortrait.tsx:107-108); the spine canvas drops its blur filter
//     once the skeleton is ready (LoadingBlurredSpine.tsx:49-66 → filter
//     'none' + 1000ms transition).
//
// character_card source=leaderboard (M9-D): renders the upstream leaderboard
// entry card by driving the page EXACTLY like a shared link — boot at HOME,
// install an in-page leaderboard data serve, then navigate to
// '#leaderboard?b=<buildId>' whose b param the leaderboard tab consumes
// (initializeLeaderboardTab → selectLeaderboardBuild,
// leaderboardTabController.ts:315-319). The manifest comes from the Node
// side's own dataset download (same chain as the leaderboard tool) and is
// answered to the page's fetch as a same-origin Response — a URL redirect to
// a mirror would be cross-origin (upstream never fetches cross-origin) and
// would need CORS headers no static mirror ships. The card mounts as
// CharacterPreview(id='leaderboard-<characterId>', source=LEADERBOARD)
// (LeaderboardCharacterPreview.tsx:44-49), so every LEADERBOARD condition is
// enforced by the real page for free: forced DEFAULT portrait
// (CharacterPreview.tsx:400-403), no custom-portrait palette worker
// (:443-444 — AUTO color falls back to the character config color), and no
// customization sidebar / screenshot buttons / UID affordances
// (ShowcaseCustomizationSidebar.tsx:103 returns null for LEADERBOARD). That
// last fact is also why capture uses a CDP element clip instead of
// captureAppExport: the upstream leaderboard card has no snapdom button
// (documented divergence; same channel as the portrait target).
// Divergence note 2: the card's SCORE is the leaderboard's RECORDED value
// (CharacterPreviewScoringProvider injection, LeaderboardCharacterPreview.tsx:
// 33-37) — the page never recomputes it locally, and neither does this render.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { getCharacters } from 'lib/stores/character/characterStore'
import { HashToPage } from 'lib/tabs/navigation/constants'
import { readSavedTeams } from 'lib/tabs/tabTeamShowcase/teamShowcaseController'
import type { Character } from 'types/character'
import { z } from 'zod'

import { saveArtifact } from '../browser/artifactStore'
import { browserManager } from '../browser/browserManager'
import type { McpBrowserPage } from '../browser/browserManager'
import { runtimeContext } from '../context'
import { readStructuredSnapshot } from '../saveSnapshot'
import { imageResult } from '../toolResult'
import { resolveLeaderboardEntryTarget } from './leaderboard'

// ─── target / page tables ────────────────────────────────────────────────────

const RENDER_TARGETS = ['character_card', 'saved_build', 'team_card', 'portrait', 'page'] as const
type RenderTarget = (typeof RENDER_TARGETS)[number]

// PageToHash's value set plus the #ehr calculator panel hash
// (HashToPage also maps #ehr → CALCULATORS, constants.ts:74-78). #teams is
// deliberately absent — it is the teams sub-panel of #characters and is
// driven by target=team_card.
const PAGE_HASHES = [
  '',
  '#main',
  '#characters',
  '#relics',
  '#import',
  '#changelog',
  '#showcase',
  '#leaderboard',
  '#benchmarks',
  '#aha',
  '#ehr',
  '#warp',
  '#webgpu',
  '#metadata',
] as const
type PageHash = (typeof PAGE_HASHES)[number]

/** Wrapper div id = AppPages key (Tabs.tsx:236), resolved through HashToPage. */
function pageDivId(hash: string): string | null {
  const page = (HashToPage as Record<string, string | undefined>)[hash]
  return page ?? null
}

// ─── small helpers ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** PNG signature + IHDR size (bytes 16-23, big-endian) — fails loudly in Chinese. */
function parsePngSize(png: Uint8Array, label: string): { width: number, height: number } {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.byteLength < 24 || magic.some((b, i) => png[i] !== b)) {
    throw new Error(`${label}:捕获结果不是有效的 PNG(前 8 字节魔数不符,实际 ${png.byteLength} 字节)`)
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * User-facing page URL (http://127.0.0.1:<port>/hsr-optimizer/<hash>). The
 * site build hard-codes BASE_PATH '/hsr-optimizer'
 * (src/lib/tabs/navigation/constants.ts:8-14 — dist/index.html references
 * /hsr-optimizer/assets/...), so the static server must serve the dist tree
 * under that prefix. Defensive join: never double the base path.
 */
function publicPageUrl(serverUrl: string | null, hash: string): string | null {
  if (!serverUrl) return null
  const base = serverUrl.replace(/\/+$/, '')
  const withBase = base.endsWith('/hsr-optimizer') ? base : `${base}/hsr-optimizer`
  return `${withBase}/${hash.replace(/^#/, '')}`
}

interface PollOptions {
  timeoutMs: number
  label: string
}

/** Any in-page probe shape: a boolean ok plus free diagnostics. */
type ProbeResult = { ok: boolean, [key: string]: unknown }

/** Poll an evaluate probe ({ ok: boolean, ... }) until ok or the Chinese timeout fires. */
async function pollUntil(
  page: McpBrowserPage,
  fn: string,
  args: unknown[],
  opts: PollOptions,
): Promise<ProbeResult> {
  const deadline = Date.now() + opts.timeoutMs
  let last: ProbeResult | null = null
  while (Date.now() < deadline) {
    last = await page.evaluate<ProbeResult>(fn, args)
    if (last != null && last.ok) return last
    await sleep(150)
  }
  const diag = last == null ? '页面无返回' : JSON.stringify({ ...last, ok: undefined })
  throw new Error(`${opts.label}:等待超时(${opts.timeoutMs}ms)——${diag}`)
}

/**
 * Seed string for the browser context: the current snapshot verbatim, except
 * the page-local showcaseL2D copy (global savedSession key, the very switch
 * the sidebar's Animations control writes — ShowcaseCustomizationSidebar.tsx:
 * 488-500) pinned so portrait rendering is deterministic. The change never
 * leaves the throwaway browser context.
 */
function buildSeed(l2d?: boolean): string {
  const snapshot = JSON.parse(JSON.stringify(readStructuredSnapshot())) as {
    savedSession?: { global?: Record<string, unknown> },
  }
  if (l2d != null && snapshot.savedSession?.global != null) {
    snapshot.savedSession.global.showcaseL2D = l2d
  }
  return JSON.stringify(snapshot)
}

/** Wrap runTask errors with the render label + launch guidance when relevant. */
async function runRenderTask<T>(
  label: string,
  opts: { l2d?: boolean, timeoutMs?: number },
  fn: (page: McpBrowserPage) => Promise<T>,
): Promise<T> {
  try {
    return await browserManager.runTask(
      {
        label,
        seed: buildSeed(opts.l2d),
        viewport: { width: 1920, height: 1080 },
        timeoutMs: opts.timeoutMs,
      },
      fn,
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/尚未落地/.test(message)) {
      throw new Error(`${label}:浏览器运行环境尚未落地(M7 任务 A 的 browserManager 未实现),集成后重试`)
    }
    if (/未启动|未运行|executable|dist|launch|浏览器/i.test(message) && !message.includes('get_runtime_capabilities')) {
      throw new Error(
        `${label}:${message};受管浏览器可能未启动——请先调用 get_runtime_capabilities(action=launch) 启动并确认能力`,
      )
    }
    throw new Error(`${label}:${message}`)
  }
}

// ─── in-page probes (serialized as evaluate strings) ─────────────────────────

// Character card readiness: the preview card exists, its portrait container
// carries THIS character's default portrait URL (data-portrait-url ends with
// /image/character_portrait/<id>.webp — ShowcasePortrait.tsx:110-121), and
// every img inside has decoded. Survives React transitions because the old
// character's portrait URL can never match the requested id.
const CARD_READY_PROBE = `(cardId, characterId) => {
  const card = document.getElementById(cardId)
  if (!card) return { ok: false, reason: '预览卡元素不存在', imgs: 0, pending: -1 }
  const portrait = card.querySelector('[data-portrait-inject]')
  const portraitUrl = portrait ? portrait.getAttribute('data-portrait-url') || '' : ''
  const identityOk = portraitUrl.includes('/' + characterId + '.webp')
  const imgs = Array.from(card.querySelectorAll('img'))
  const pending = imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).length
  return { ok: identityOk && imgs.length > 0 && pending === 0, imgs: imgs.length, pending, identityOk, portraitUrl }
}`

// Generic img-set readiness inside a root element. Pages without any <img>
// (e.g. text-only tabs) are vacuously ready.
const IMGS_READY_PROBE = `(selector) => {
  const root = document.querySelector(selector)
  if (!root) return { ok: false, reason: '元素不存在', imgs: 0, pending: -1 }
  const imgs = Array.from(root.querySelectorAll('img'))
  const pending = imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).length
  return { ok: pending === 0, imgs: imgs.length, pending }
}`

// Page-tab readiness: the persistent wrapper div (id=<AppPages key>) is
// visible and has mounted content (childElementCount > 0 — the lazy
// #webgpu/#metadata tabs render null until their chunk loads). The ACTIVE
// wrapper renders display:'contents' (Tabs.tsx:236) — it has no box of its
// own, so visibility is measured on its first element child instead.
const PAGE_READY_PROBE = `(divId) => {
  const div = document.getElementById(divId)
  if (!div) return { ok: false, reason: '页面容器不存在', children: -1 }
  const style = window.getComputedStyle(div)
  if (style.display === 'none') return { ok: false, visible: false, children: div.childElementCount }
  const measure = style.display === 'contents' ? div.firstElementChild : div
  const box = measure ? measure.getBoundingClientRect() : null
  const visible = box != null && box.width > 0 && box.height > 0
  const children = div.childElementCount
  return { ok: visible && children > 0, visible, children }
}`

// Click the first element inside scope whose normalized text matches any of
// the given strings (multi-locale), optionally exact. Returns what happened.
const CLICK_BY_TEXT_PROBE = `(scopeSelector, texts, exact, tag) => {
  const scope = document.querySelector(scopeSelector)
  if (!scope) return { ok: false, reason: '范围元素不存在: ' + scopeSelector }
  const wanted = texts.map((t) => t.replace(/\\s+/g, ' ').trim().toLowerCase())
  const candidates = tag === '*' ? Array.from(scope.querySelectorAll('*')) : Array.from(scope.querySelectorAll(tag))
  const hit = candidates.find((el) => {
    const own = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()
    if (!own) return false
    return exact ? wanted.includes(own) : wanted.some((w) => own.includes(w))
  })
  if (!hit) return { ok: false, reason: '未找到匹配元素:' + texts.join('/') + '(候选 ' + candidates.filter((c) => c.textContent && c.textContent.trim()).length + ' 个)' }
  hit.click()
  return { ok: true, text: (hit.textContent || '').trim().slice(0, 60) }
}`

// Click the nth saved-team tile whose aria-label equals the team name
// (SavedTeamsList.tsx:243-247); tiles appear in readSavedTeams order.
const CLICK_TEAM_TILE_PROBE = `(panelSelector, name, occurrence) => {
  const panel = document.querySelector(panelSelector)
  if (!panel) return { ok: false, reason: '组队面板不存在' }
  const tiles = Array.from(panel.querySelectorAll('[aria-label]'))
    .filter((el) => el.getAttribute('aria-label') === name)
  const tile = tiles[occurrence] || tiles[0]
  if (!tile) return { ok: false, reason: '未找到名为「' + name + '」的队伍磁贴(现有 ' + panel.querySelectorAll('[aria-label]').length + ' 个可点击元素)' }
  tile.click()
  return { ok: true, tiles: tiles.length }
}`

// Saved-team activation: the tile with data-active='true' (SavedTeamsList.tsx:
// 181) plus the full-res grid present.
const TEAM_ACTIVE_PROBE = `(panelSelector) => {
  const panel = document.querySelector(panelSelector)
  const active = panel ? panel.querySelector('[data-active="true"]') : null
  const grid = document.getElementById('teamShowcaseGrid')
  const gridImgs = grid ? Array.from(grid.querySelectorAll('img')) : []
  const pending = gridImgs.filter((i) => !(i.complete && i.naturalWidth > 0)).length
  return { ok: active != null && grid != null && gridImgs.length > 0 && pending === 0, active: active != null, grid: grid != null, imgs: gridImgs.length, pending }
}`

// Build card selection inside the modal: the BuildCard whose HeaderText
// renders exactly the build name (BuildsModal.tsx:336-345). The selected card
// gets inline backgroundColor var(--layer-3) (:338). The dialog is located
// from #buildPreview itself — document.querySelector('[role=dialog]') would
// hit the optimizer tab's keep-mounted FormSetConditionals Drawer
// (FormSetConditionals.tsx:187-196) which precedes the characters tab in DOM
// order (Tabs.tsx TAB_COMPONENTS order).
const BUILD_CARD_PROBE = `(buildName, click) => {
  const preview = document.getElementById('buildPreview')
  const dialog = preview ? preview.closest('[role="dialog"]') : null
  if (!dialog) return { ok: false, selected: undefined, reason: '配装弹窗未打开(#buildPreview 不在 dialog 内)' }
  const headers = Array.from(dialog.querySelectorAll('div')).filter((el) => {
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    return text === buildName
  })
  if (headers.length === 0) return { ok: false, selected: undefined, reason: '弹窗内没有名为「' + buildName + '」的配装(卡片文本:' + dialog.textContent.slice(0, 120) + ')' }
  const header = headers[0]
  // HeaderText <div> → Mantine Flex <div> → BuildCard <div> (BuildsModal.tsx:336-345)
  const card = header.parentElement && header.parentElement.parentElement ? header.parentElement.parentElement : header
  if (click) header.click()
  const selected = (card.getAttribute('style') || '').includes('layer-3')
  return { ok: selected, selected, clicked: click }
}`

// Portrait geometry: boundingClientRect of the card's portrait container after
// forcing scroll origin to (0,0) so viewport coords == page coords for the CDP
// clip.
const PORTRAIT_RECT_PROBE = `(cardId, selector) => {
  window.scrollTo(0, 0)
  const card = document.getElementById(cardId)
  const el = card ? card.querySelector(selector) : null
  if (!el) return { ok: false, reason: '肖像容器不存在(' + selector + ')' }
  const rect = el.getBoundingClientRect()
  return { ok: rect.width > 0 && rect.height > 0, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}`

// L2D readiness: spine canvas mounted (data-portrait-spine wrapper,
// ShowcasePortrait.tsx:135) and its blur filter dropped ('none') —
// LoadingBlurredSpine clears the filter once the skeleton renders.
const SPINE_READY_PROBE = `(cardId) => {
  const card = document.getElementById(cardId)
  const wrapper = card ? card.querySelector('[data-portrait-spine]') : null
  const canvas = wrapper ? wrapper.querySelector('canvas') : null
  if (!canvas) return { ok: false, reason: 'spine 画布未出现(该角色可能无 spine 数据、设有自定义肖像或被 disableSpine)', filter: null }
  const filter = canvas.style.filter || ''
  return { ok: filter === 'none', filter }
}`

// Serve the leaderboard downloads IN-PAGE from the manifest the Node side
// already downloaded through the same dataset chain. Matches BOTH URLs the
// site's loader can produce (leaderboardDataLoader.ts:48-71): the
// root-relative build path (/hsr-optimizer/leaderboard/…) and the localhost
// beta fallback (https://fribbels.github.io/dreary-quibbles/…) — a redirect to
// an external mirror would be cross-origin (upstream never fetches
// cross-origin), so the manifest is answered with a same-origin Response
// instead. The timeline is served as a schema-too-old stub — the upstream
// loader treats that as "no timeline" (leaderboardDataLoader.ts:120), which
// the card never reads. The hit counter proves the page consumed the injected
// data (and never touched the network for it).
const LEADERBOARD_FETCH_SERVE_PROBE = `(manifest) => {
  const w = window
  if (w.__HSR_MCP_LB_SERVE__) return { ok: true, already: true, hits: w.__HSR_MCP_LB_SERVE__.hits }
  const originalFetch = w.fetch.bind(w)
  const stubTimeline = JSON.stringify({ schemaVersion: 0, events: [] })
  const served = (input) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const match = url.match(/\\/leaderboard\\/(leaderboard(?:-timeline)?\\.json)/)
    if (!match) return null
    return new Response(match[1] === 'leaderboard.json' ? JSON.stringify(manifest) : stubTimeline, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  w.__HSR_MCP_LB_SERVE__ = { hits: 0 }
  w.fetch = (input, init) => {
    const response = served(input)
    if (response != null) {
      w.__HSR_MCP_LB_SERVE__.hits++
      return Promise.resolve(response)
    }
    return originalFetch(input, init)
  }
  return { ok: true, hits: 0 }
}`

// Element geometry by id (CDP clip coordinates, scroll pinned to 0,0).
const ELEMENT_RECT_PROBE = `(elementId) => {
  window.scrollTo(0, 0)
  const el = document.getElementById(elementId)
  if (!el) return { ok: false, reason: '元素不存在:' + elementId }
  const rect = el.getBoundingClientRect()
  return { ok: rect.width > 0 && rect.height > 0, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}`

// ─── per-target drivers ──────────────────────────────────────────────────────

function requireCharacterNodeSide(characterId: string, label: string): Character {
  const character = getCharacters().find((c) => c.id === characterId)
  if (!character) {
    const roster = getCharacters().map((c) => c.id).join(', ')
    throw new Error(`${label}:角色 ${characterId} 不在当前存档角色列表中(现有:${roster || '空'})`)
  }
  return character
}

/** #characters → click the row → wait for the card to show THIS character. */
async function selectCharacterOnCharactersTab(
  page: McpBrowserPage,
  characterId: string,
  label: string,
  timeoutMs: number,
): Promise<void> {
  await page.goto('#characters')
  await page.waitForSelector('#characters-panels-panel-CHARACTERS', { timeoutMs, visible: true })
  const rowSelector = `[data-character-id="${characterId}"]`
  await page.waitForSelector(rowSelector, { timeoutMs, visible: true })
  await page.click(rowSelector, { timeoutMs })
  await page.waitForSelector(`${rowSelector}[data-selected="true"]`, { timeoutMs })
  await pollUntil(page, CARD_READY_PROBE, ['characterTabPreview', characterId], {
    timeoutMs,
    label: `${label}:角色展示卡未就绪`,
  })
}

async function renderCharacterCard(characterId: string): Promise<Uint8Array> {
  return await runRenderTask(`render(character_card ${characterId})`, {}, async (page) => {
    await selectCharacterOnCharactersTab(page, characterId, 'character_card', 30_000)
    // ScreenshotPanel's camera button (clipboard branch), scoped to the
    // characters panel so hidden tabs' buttons can never be picked.
    return await page.captureAppExport({
      via: 'camera',
      scopeSelector: '#characters-panels-panel-CHARACTERS',
      timeoutMs: 60_000,
    })
  })
}

/**
 * Leaderboard entry card over the shared-link path (see the module header):
 * boot at HOME (the leaderboard tab stagger-mounts 7th, Tabs.tsx MOUNT_PRIORITY
 * :67-79 — comfortably after the in-page data serve below), then navigate to
 * '#leaderboard?b=<buildId>' and wait for the real LEADERBOARD-source card.
 * The page's own loader consumes the manifest the Node side downloaded, so no
 * leaderboard traffic ever leaves the page (mirrors stay usable even without
 * CORS). Capture is a CDP clip because upstream ships no screenshot button for
 * this card (ShowcaseCustomizationSidebar.tsx:103).
 */
async function renderLeaderboardCard(input: {
  buildId: string,
  characterId: string,
  rawManifest: Record<string, unknown>,
}): Promise<{ png: Uint8Array, fetchHits: number | null }> {
  const { buildId, characterId, rawManifest } = input
  return await runRenderTask(`render(character_card leaderboard ${buildId})`, { timeoutMs: 240_000 }, async (page) => {
    await page.goto('')
    // Console error tally for the timeout diagnostics (page 'error' +
    // 'unhandledrejection' events, plus rejected fetch URLs).
    await page.evaluate(
      `() => {
      const w = window
      w.__HSR_MCP_PAGE_ERRORS__ = []
      w.addEventListener('error', (e) => w.__HSR_MCP_PAGE_ERRORS__.push(String((e && e.message) || e)))
      w.addEventListener('unhandledrejection', (e) => w.__HSR_MCP_PAGE_ERRORS__.push('unhandled: ' + String((e && e.reason) || e)))
      return true
    }`,
      [],
    )
    await page.evaluate(LEADERBOARD_FETCH_SERVE_PROBE, [rawManifest])
    // Shared-link navigation: initializeLeaderboardTab consumes the b param
    // after the (served) download resolves (leaderboardTabController.ts:315-319).
    await page.evaluate('(hash) => { location.hash = hash; return true }', [
      `#leaderboard?b=${encodeURIComponent(buildId)}`,
    ])

    // LeaderboardCharacterPreview.tsx:46 — id={'leaderboard-<characterId>'}. The
    // pre-selection placeholder has NO id, so this selector implies real data.
    const cardId = `leaderboard-${characterId}`
    try {
      await page.waitForSelector(`#${cssEscapeId(cardId)}`, { timeoutMs: 60_000, visible: true })
    } catch (e) {
      // Diagnostics: which stage stalled (no leaderboard page / no data / no selection).
      const diag = await page.evaluate<Record<string, unknown>>(
        `(id) => {
          const wrapper = document.getElementById('LEADERBOARD')
          return {
            hash: location.hash,
            wrapper: wrapper != null,
            wrapperDisplay: wrapper ? getComputedStyle(wrapper).display : null,
            card: document.getElementById(id) != null,
            serve: window.__HSR_MCP_LB_SERVE__ ?? null,
            pageErrors: (window.__HSR_MCP_PAGE_ERRORS__ ?? []).slice(0, 5),
            body: document.body ? document.body.innerText.slice(0, 160) : '',
          }
        }`,
        [cardId],
      ).catch(() => null)
      throw new Error(
        `render(character_card leaderboard):等待 #${cardId} 超时——页面诊断:${JSON.stringify(diag)};`
          + '配装可能已落榜,或榜单数据(经注入)在该页面无法解析',
      )
    }
    await pollUntil(page, CARD_READY_PROBE, [cardId, characterId], {
      timeoutMs: 60_000,
      label: `render(character_card leaderboard):配装 ${buildId} 的榜单角色卡未就绪(配装可能已落榜,或榜单数据不可达)`,
    })
    await sleep(500) // injected-score row + rank banner settle

    let fetchHits: number | null = null
    {
      const hits = await page.evaluate<number>(
        '() => (window.__HSR_MCP_LB_SERVE__ ?? { hits: 0 }).hits',
        [],
      )
      fetchHits = Number(hits) || 0
    }

    const rect = await pollUntil(page, ELEMENT_RECT_PROBE, [cardId], {
      timeoutMs: 10_000,
      label: 'render(character_card leaderboard):角色卡几何信息不可用',
    })
    const clip = {
      x: Math.max(0, Math.floor(Number(rect.x))),
      y: Math.max(0, Math.floor(Number(rect.y))),
      width: Math.max(1, Math.ceil(Number(rect.width))),
      height: Math.max(1, Math.ceil(Number(rect.height))),
    }
    return { png: await page.screenshot({ clip }), fetchHits }
  })
}

async function renderSavedBuild(characterId: string, buildName: string): Promise<Uint8Array> {
  return await runRenderTask(`render(saved_build ${characterId}/${buildName})`, { timeoutMs: 180_000 }, async (page) => {
    await selectCharacterOnCharactersTab(page, characterId, 'saved_build', 30_000)

    // Open the Character menu (Mantine Menu.Target button) and click
    // 'View saved builds' — the 7th menu item (CharacterMenu.tsx:146-217).
    const menuClick = await page.evaluate<{ ok: boolean, reason?: string }>(CLICK_BY_TEXT_PROBE, [
      '#characters-panels-panel-CHARACTERS',
      ['Character menu', '角色菜单'],
      false,
      'button',
    ])
    if (!menuClick.ok) throw new Error(`saved_build:无法打开角色菜单——${menuClick.reason}`)
    await page.waitForSelector('[role="menuitem"]', { timeoutMs: 10_000 })
    const itemClick = await page.evaluate<{ ok: boolean, reason?: string }>(CLICK_BY_TEXT_PROBE, [
      'body',
      ['View saved builds', '查看已保存配装'],
      false,
      '[role="menuitem"]',
    ])
    if (!itemClick.ok) {
      throw new Error(`saved_build:菜单里找不到「View saved builds/查看已保存配装」——${itemClick.reason}`)
    }

    // Modal opened → wait for the preview card to show this character.
    await page.waitForSelector('#buildPreview', { timeoutMs: 20_000, visible: true })
    await pollUntil(page, CARD_READY_PROBE, ['buildPreview', characterId], {
      timeoutMs: 30_000,
      label: 'saved_build:配装预览卡未就绪',
    })

    // Select the requested build if it is not the auto-selected first one
    // (BuildsModal.tsx:97-101 auto-selects builds[0]).
    const selected = await page.evaluate<{ ok: boolean, selected?: boolean, reason?: string }>(BUILD_CARD_PROBE, [
      buildName,
      false,
    ])
    if (!selected.ok) {
      if (selected.selected === undefined && selected.reason) throw new Error(`saved_build:${selected.reason}`)
      await page.evaluate(BUILD_CARD_PROBE, [buildName, true])
      await pollUntil(page, BUILD_CARD_PROBE, [buildName, false], {
        timeoutMs: 10_000,
        label: `saved_build:配装「${buildName}」选中态未确认`,
      })
    }

    // Modal footer camera button (BuildsModal.tsx:194-202). Scoped via
    // :has(#buildPreview): a bare [role=dialog] scope would first match the
    // optimizer tab's keep-mounted set-conditionals Drawer (hidden, earlier in
    // DOM order) and never find the button. NOTE: Mantine renders the dialog
    // as <section role=dialog> (ModalBaseContent component: "section") — no
    // div qualifier in the selector.
    return await page.captureAppExport({
      via: 'camera',
      scopeSelector: '[role="dialog"]:has(#buildPreview)',
      timeoutMs: 60_000,
    })
  })
}

async function renderTeamCard(teamId: string | null): Promise<{ png: Uint8Array, teamId: string, teamName: string }> {
  const teams = readSavedTeams()
  if (teams.length === 0) {
    throw new Error('team_card:当前存档没有已保存队伍——请先用 save_team 保存一支队伍再渲染')
  }
  const team = teamId != null ? teams.find((t) => t.id === teamId) : teams[0]
  if (!team) {
    const known = teams.map((t) => `${t.id}(${t.name})`).join(', ')
    throw new Error(`team_card:队伍 id ${teamId} 不存在(现有:${known})`)
  }
  const occurrence = teams.filter((t) => t.name === team.name).findIndex((t) => t.id === team.id)

  const png = await runRenderTask(`render(team_card ${team.name})`, { timeoutMs: 240_000 }, async (page) => {
    await page.goto('#teams')
    const panel = '#characters-panels-panel-TEAMS'
    await page.waitForSelector(panel, { timeoutMs: 30_000, visible: true })
    const tileClick = await page.evaluate<{ ok: boolean, reason?: string }>(CLICK_TEAM_TILE_PROBE, [
      panel,
      team.name,
      occurrence,
    ])
    if (!tileClick.ok) throw new Error(`team_card:${tileClick.reason}`)
    await pollUntil(page, TEAM_ACTIVE_PROBE, [panel], {
      timeoutMs: 60_000,
      label: 'team_card:队伍卡片网格未就绪',
    })
    // SavedTeamsActions' Download button (download branch), scoped to the teams panel.
    return await page.captureAppExport({
      via: 'download',
      scopeSelector: panel,
      timeoutMs: 90_000,
    })
  })
  return { png, teamId: team.id, teamName: team.name }
}

async function renderPage(
  hash: string,
  fullPage: boolean,
): Promise<{ png: Uint8Array, url: string | null }> {
  const divId = pageDivId(hash)
  if (divId == null) {
    throw new Error(`render(page):hash ${hash} 没有对应的页面容器(HashToPage 未收录)`)
  }
  const png = await runRenderTask(`render(page ${hash || 'HOME'})`, {}, async (page) => {
    await page.goto(hash)
    await pollUntil(page, PAGE_READY_PROBE, [divId], {
      timeoutMs: 30_000,
      label: `render(page ${hash}):页面容器 #${divId} 未就绪`,
    })
    await pollUntil(page, IMGS_READY_PROBE, [`#${cssEscapeId(divId)}`], {
      timeoutMs: 30_000,
      label: `render(page ${hash}):页面图片未加载完成`,
    })
    await sleep(400) // post-layout settle (lazy chunk paint, scrollbars)
    return await page.screenshot(fullPage ? { fullPage: true } : {})
  })
  return { png, url: publicPageUrl(browserManager.status().serverUrl, hash) }
}

/** #id selector escaping for the AppPages ids (safe chars, defensive anyway). */
function cssEscapeId(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, '\\$1')
}

async function renderPortrait(
  characterId: string,
  animation: boolean,
): Promise<Uint8Array> {
  const png = await runRenderTask(
    `render(portrait ${characterId}${animation ? ' L2D' : ''})`,
    { l2d: animation, timeoutMs: 180_000 },
    async (page) => {
      await selectCharacterOnCharactersTab(page, characterId, 'portrait', 30_000)

      if (animation) {
        await pollUntil(page, SPINE_READY_PROBE, ['characterTabPreview'], {
          timeoutMs: 45_000,
          label: `render(portrait):角色 ${characterId} 的 L2D 肖像未就绪`,
        })
        // blur-out transition is 1000ms (LoadingBlurredSpine.tsx:11-13)
        await sleep(1200)
      } else {
        await pollUntil(page, IMGS_READY_PROBE, [
          '#characterTabPreview [data-portrait-inject]',
        ], {
          timeoutMs: 30_000,
          label: 'render(portrait):静态肖像图片未加载完成',
        })
      }

      const rect = await pollUntil(page, PORTRAIT_RECT_PROBE, [
        'characterTabPreview',
        '[data-portrait-inject]',
      ], {
        timeoutMs: 10_000,
        label: 'render(portrait):肖像容器几何信息不可用',
      })
      // CDP clip, CSS px relative to the page (scroll pinned to 0,0 by the probe)
      const clip = {
        x: Math.max(0, Math.floor(Number(rect.x))),
        y: Math.max(0, Math.floor(Number(rect.y))),
        width: Math.max(1, Math.ceil(Number(rect.width))),
        height: Math.max(1, Math.ceil(Number(rect.height))),
      }
      return await page.screenshot({ clip })
    },
  )
  return png
}

// ─── tool registration ───────────────────────────────────────────────────────

export function registerRenderTools(server: McpServer): void {
  server.registerTool('render', {
    title: '渲染页面产物为 PNG',
    description: '在受管无头浏览器里渲染站点页面并返回 PNG 截图(像素级对齐网页端自己的导出按钮):'
      + 'target=character_card 角色展示卡(网页端角色页相机按钮的 snapdom 导出;source=leaderboard 时改为渲染榜单配装卡——'
      + '走 #leaderboard?b= 共享链接路径,上游只读卡语义:强制默认肖像/AUTO 配色/无 UID,分数用榜单记录值;'
      + '上游该卡没有截图按钮,以 CDP 元素截图捕获);'
      + 'target=saved_build 已保存配装预览(角色菜单→查看已保存配装弹窗,elementId buildPreview);'
      + 'target=team_card 组队展示整队卡(#teams 子页签,SavedTeamsActions 的下载按钮,elementId teamShowcaseGrid);'
      + 'target=portrait 角色肖像(静态图或 L2D spine 画布——spine 因 preserveDrawingBuffer:false 必须 CDP 截屏);'
      + 'target=page 任意页面 hash 的 CDP 页面截图(可整页)。'
      + '渲染是只读操作:种子取当前存档快照写入一次性浏览器上下文,绝不回写存档。'
      + '浏览器未启动时会报错并提示先调 get_runtime_capabilities(action=launch)。'
      + '产物同时以内嵌 MCP image 块返回,并落盘 artifact(可供 deliver_artifact 二次分发)。',
    inputSchema: {
      target: z.enum(RENDER_TARGETS).describe(
        '渲染目标:character_card=角色展示卡,saved_build=已保存配装卡,team_card=组队展示整队卡,portrait=角色肖像,page=页面截图',
      ),
      source: z.enum(['save', 'leaderboard']).default('save').describe(
        'character_card 的数据来源:save=存档内角色(默认,现有行为,需 characterId)/'
          + 'leaderboard=榜单配装(需 buildId;受管页面打开 #leaderboard?b= 链接渲染上游同款只读卡)',
      ),
      characterId: z.string().optional().describe('character_card(source=save)/saved_build/portrait 必填:角色 id(如 1212b1,list_characters 可查)'),
      buildId: z.string().optional().describe(
        'saved_build 必填:配装名(同角色内唯一,list_builds 的 name);character_card(source=leaderboard) 必填:榜单配装编号(leaderboard 工具 view=board/entry 的 buildId)',
      ),
      leaderboardBaseUrl: z.string().optional().describe(
        'source=leaderboard 的数据源(http/https,指向 leaderboard.json 所在目录,同 leaderboard 工具 source=url 的 baseUrl);'
          + '缺省读环境变量 HSR_MCP_LEADERBOARD_URL、再缺省用上游固定发布地址。数据由服务端下载后注入页面(页面自身不发起榜单网络请求,镜像无需 CORS)',
      ),
      teamId: z.string().optional().describe('team_card 可选:已保存队伍 id(list_teams 可查);缺省取第一支'),
      animation: z.boolean().optional().describe('portrait 专用:true=L2D 动态肖像(spine 画布,需角色有 spine 数据且无自定义肖像),缺省 false=静态肖像'),
      page: z.enum(PAGE_HASHES).describe(
        'page 必填:页面 hash——空串=首页,#main=优化器,#characters=角色,#relics=遗器,#import=导入,#changelog=更新日志,'
          + '#showcase=展示,#leaderboard=排行榜,#benchmarks=基准,#aha/#ehr=计算器,#warp=跃迁,#webgpu=WebGPU 测试,#metadata=元数据测试',
      ).optional(),
      fullPage: z.boolean().optional().describe('page 专用:true=整页截图(含滚动区),缺省 false=仅视口'),
    },
    outputSchema: {
      target: z.enum(RENDER_TARGETS),
      artifactId: z.string(),
      file: z.string(),
      bytes: z.number().int(),
      createdAtIso: z.string(),
      label: z.string(),
      format: z.literal('png'),
      width: z.number().int(),
      height: z.number().int(),
      characterId: z.string().optional(),
      buildId: z.string().optional(),
      source: z.enum(['save', 'leaderboard']).optional(),
      leaderboardBaseUrl: z.string().optional(),
      leaderboardFetchHits: z.number().int().nullable().optional().describe(
        'source=leaderboard 时:页面内由注入数据应答的榜单拉取次数(manifest+动态,0 说明页面没消费注入数据,应视为异常)',
      ),
      teamId: z.string().optional(),
      teamName: z.string().optional(),
      animation: z.boolean().optional(),
      page: z.string().optional(),
      fullPage: z.boolean().optional(),
      url: z.string().nullable().optional().describe('page 专用:可交给用户的页面地址(http://127.0.0.1:<port>/hsr-optimizer/<hash>)'),
      via: z.string().describe('捕获通道:app-camera/app-download=应用自身 snapdom 导出按钮,cdp=浏览器截屏'),
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const { target } = input

    if (input.source === 'leaderboard' && target !== 'character_card') {
      throw new Error(`render(${target}):source=leaderboard 只属于 target=character_card(榜单配装卡)——其余 target 请勿传 source`)
    }

    let png: Uint8Array
    let label: string
    let via: string
    const extra: Record<string, unknown> = {}

    if (target === 'character_card') {
      if (input.source === 'leaderboard') {
        const buildId = requireField(input.buildId, 'buildId', 'character_card(source=leaderboard)')
        // Node-side buildId validation + manifest download through the same
        // dataset chain the leaderboard tool uses (Chinese not-found error
        // instead of a page wait timeout). The manifest is then re-served to
        // the page in-origin — no leaderboard traffic ever leaves the page.
        const entry = await resolveLeaderboardEntryTarget({
          buildId,
          baseUrl: input.leaderboardBaseUrl != null && input.leaderboardBaseUrl.trim() !== ''
            ? input.leaderboardBaseUrl.trim()
            : undefined,
        })
        const rendered = await renderLeaderboardCard({
          buildId,
          characterId: entry.characterId,
          rawManifest: entry.rawManifest,
        })
        png = rendered.png
        label = `character_card-leaderboard-${entry.characterId}-${buildId}`
        via = 'cdp'
        Object.assign(extra, {
          source: 'leaderboard' as const,
          characterId: entry.characterId,
          buildId,
          leaderboardBaseUrl: entry.baseUrl,
          leaderboardFetchHits: rendered.fetchHits,
        })
      } else {
        const characterId = requireField(input.characterId, 'characterId', target)
        requireCharacterNodeSide(characterId, 'render(character_card)')
        png = await renderCharacterCard(characterId)
        label = `character_card-${characterId}`
        via = 'app-camera'
        Object.assign(extra, { characterId })
      }
    } else if (target === 'saved_build') {
      const characterId = requireField(input.characterId, 'characterId', target)
      const buildId = requireField(input.buildId, 'buildId', target)
      const character = requireCharacterNodeSide(characterId, 'render(saved_build)')
      const builds = character.builds ?? []
      if (!builds.some((b) => b.name === buildId)) {
        throw new Error(
          `render(saved_build):角色 ${characterId} 没有名为「${buildId}」的配装(现有:${builds.map((b) => b.name).join(', ') || '无'};list_builds 可查)`,
        )
      }
      png = await renderSavedBuild(characterId, buildId)
      label = `saved_build-${characterId}-${buildId}`
      via = 'app-camera'
      Object.assign(extra, { characterId, buildId })
    } else if (target === 'team_card') {
      const result = await renderTeamCard(input.teamId ?? null)
      png = result.png
      label = `team_card-${result.teamName}`
      via = 'app-download'
      Object.assign(extra, { teamId: result.teamId, teamName: result.teamName })
    } else if (target === 'portrait') {
      const characterId = requireField(input.characterId, 'characterId', target)
      requireCharacterNodeSide(characterId, 'render(portrait)')
      const animation = input.animation ?? false
      png = await renderPortrait(characterId, animation)
      label = `portrait-${characterId}${animation ? '-l2d' : ''}`
      via = 'cdp'
      Object.assign(extra, { characterId, animation })
    } else {
      const pageHash = requireField(input.page, 'page', target)
      const fullPage = input.fullPage ?? false
      const result = await renderPage(pageHash, fullPage)
      png = result.png
      label = `page-${pageHash || 'HOME'}${fullPage ? '-full' : ''}`
      via = 'cdp'
      Object.assign(extra, { page: pageHash, fullPage, url: result.url })
    }

    const size = parsePngSize(png, `render(${target})`)
    const meta = saveArtifact(png, label)
    const payload: Record<string, unknown> = {
      target,
      artifactId: meta.artifactId,
      file: meta.file,
      bytes: meta.bytes,
      createdAtIso: meta.createdAtIso,
      label: meta.label,
      format: 'png',
      width: size.width,
      height: size.height,
      via,
      ...extra,
    }

    const name = characterNameForSummary(extra)
    const summary = target === 'page'
      ? `已渲染页面 ${extra.page || '(首页)'}${
        extra.fullPage ? '(整页)' : ''
      } → ${size.width}×${size.height} PNG(${meta.bytes} 字节,artifact ${meta.artifactId})${extra.url ? `;页面地址 ${extra.url}` : ''}`
      : `已渲染 ${target}${name ? ` ${name}` : ''} → ${size.width}×${size.height} PNG(${meta.bytes} 字节,artifact ${meta.artifactId})`

    return imageResult(
      payload,
      summary,
      { data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64'), mimeType: 'image/png' },
    )
  })
}

function requireField<T>(value: T | undefined, field: string, target: RenderTarget | string): T {
  // NOTE: only null/undefined are "missing" — page='' is the legitimate HOME
  // hash and must not be rejected here.
  if (value == null) {
    throw new Error(`render(${target}):缺少必填参数 ${field}(target=${target} 需要它;各 target 的必填组合见工具描述)`)
  }
  return value
}

function characterNameForSummary(extra: Record<string, unknown>): string {
  const characterId = extra.characterId as string | undefined
  if (characterId != null) {
    const meta = (getGameMetadata().characters as Record<string, { name?: string } | undefined>)[characterId]
    const suffix = extra.buildId != null
      ? ` 配装「${String(extra.buildId)}」`
      : extra.animation === true
      ? ' L2D 肖像'
      : extra.animation === false
      ? ' 静态肖像'
      : ''
    return `${meta?.name ?? characterId}${suffix}`
  }
  if (extra.teamName != null) return `队伍「${String(extra.teamName)}」`
  return ''
}
