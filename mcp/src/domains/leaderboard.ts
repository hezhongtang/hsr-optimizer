// Leaderboard read-only data domain (M6-D1): leaderboard(view=…).
//
// The web's loader (src/lib/tabs/tabLeaderboard/leaderboardDataLoader.ts:48-54)
// resolves `/leaderboard/*.json` against `import.meta.url` — a browser-only
// trick that lands on a nonexistent `file://` path under the headless build —
// and its module-level caches are only fed by that fetch. This mirror keeps the
// FETCH layer (explicit `source`, per-base in-process cache, hard errors on
// failure) but reuses the upstream pure functions for everything derivational:
//   deriveVisibleEntries (board rows/ranks/filter semantics, imported),
//   lookupUserLeaderboardRanks (my_ranks, imported),
//   parseTimelineEventWire/completeTimelineEventIdentity + computeBrowserCandidateId
//   (timeline normalization, imported), getLeaderboardCharacters/
//   getCharacterLeaderboardConfigTypes/isCharacterLeaderboardEnabled (character
//   list grouping, imported), expandCharacter + CharacterConverter (entry card,
//   the same path recomputeDerivedState uses).
//
// view=score (M9-D 本地评分重算) re-scores a published entry with the
// maintainer's own offline function: scoreLeaderboardBuild (the exact call
// src/leaderboard/scoring/scorer.ts:106-114 uses to produce entry.score in the
// first place) over DEFAULT_TEAM metadata + the entry's recorded team and
// deprioritizeBuffs — the same injection the web card applies through
// CharacterPreviewScoringProvider (LeaderboardCharacterPreview.tsx:33-37 →
// applySimulationMetadataOverrides, showcaseDerivedData.ts:178-200). The web
// card itself only displays the RECORDED score; the recompute is the MCP-side
// capability the coverage gap asks for (compare recomputed vs recorded).
//
// Published-source facts (all from leaderboardDataLoader.ts unless noted):
//   - network base = 'https://fribbels.github.io' + BasePath.BETA ('/dreary-
//     quibbles', src/lib/tabs/navigation/constants.ts:8-11) + '/leaderboard'
//     (lines 46-54 — the fixed upstream publish address the site falls back to).
//   - file names: 'leaderboard.json' (line 77) and 'leaderboard-timeline.json'
//     (line 118). Manifest shape = PublicLeaderboardOutputV3
//     ({ generatedAt, characters: { [characterId]: base64-gzip(PublicCharacterData) } }).
//   - upstream download failure surfaces as an EMPTY board in the web
//     (getLeaderboardTopScores catches → {}); the coverage contract for MCP
//     explicitly demands the opposite: fetch/parse failures throw, and only a
//     genuinely empty-after-filter result is a success with total 0.
//
// IS_LOCALHOST divergence note: the node shims pin location.hostname to
// 'localhost' (src/shims.ts), so upstream's IS_LOCALHOST const (browser dev
// bypass of the 150% cutoff, deriveVisibleEntries.ts:53) is TRUE here. The
// published site always applies the cutoff, so every board-derived read in
// this domain re-filters `score >= 1.5` after deriveVisibleEntries — provably
// equivalent to the production path because the cutoff is monotone with the
// score-descending sort (sub-1.5 entries can only ever occupy tail positions
// inside the top-N window, and never change the rank numbers above them).

import i18next from 'i18next'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  configTypeToPublic,
  isLeaderboardConfigType,
  LEADERBOARD_CONFIG_TYPES,
  type LeaderboardConfigType,
  publicToConfigType,
} from 'leaderboard/shared/configTypeMapping'
import {
  LEADERBOARD_FILTER_ALL,
  type LeaderboardEidolonFilter,
} from 'leaderboard/shared/eidolonConfig'
import { expandCharacter } from 'leaderboard/shared/profileCompression'
import { scoreLeaderboardBuild } from 'leaderboard/shared/scoreLeaderboardBuild'
import type {
  PublicCharacterData,
  PublicConfigData,
  PublicLeaderboardEntry,
  PublicTeamMeta,
} from 'leaderboard/shared/types'
import {
  completeTimelineEventIdentity,
  parseTimelineEventWire,
  type RawTimelineEvent,
} from 'leaderboard/timeline/timelineEventValidation'
import {
  TIMELINE_MIN_SCORE,
  TIMELINE_SCHEMA_VERSION,
  type TimelineEvent,
} from 'leaderboard/timeline/timelineTypes'
import { resolveEffectiveDeprioritizeBuffs } from 'lib/characterPreview/showcaseDerivedData'
import { DEFAULT_TEAM } from 'lib/constants/constants'
import { CharacterConverter } from 'lib/importer/characterConverter'
import { SCORING_CONFIG_REGISTRY } from 'lib/scoring/scoringConfig'
import { resolveSimulationMetadata } from 'lib/simulations/orchestrator/runDpsScoreBenchmarkOrchestrator'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { deriveVisibleEntries } from 'lib/tabs/tabLeaderboard/deriveVisibleEntries'
import { computeBrowserCandidateId } from 'lib/tabs/tabLeaderboard/leaderboardBrowserHash'
import {
  getCharacterLeaderboardConfigTypes,
  getLeaderboardCharacters,
  isCharacterLeaderboardEnabled,
} from 'lib/tabs/tabLeaderboard/leaderboardCharacterHelpers'
import type { LeaderboardEntry } from 'lib/tabs/tabLeaderboard/leaderboardTabTypes'
import {
  type LoadedLeaderboardCharacter,
  lookupUserLeaderboardRanks,
} from 'lib/tabs/tabLeaderboard/leaderboardUidLookup'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import { truncate10ths } from 'lib/utils/mathUtils'
import { validateUuid } from 'lib/utils/miscUtils'
import type { CharacterId } from 'types/character'
import type { LightConeId } from 'types/lightCone'
import type { Relic } from 'types/relic'
import { z } from 'zod'
import { ensureI18nReady } from '../i18n/i18nNode'

import { runtimeContext } from '../context'
import { toolResult } from '../toolResult'

// Upstream param types (resolveSimulationMetadata / scoreLeaderboardBuild /
// SimulationMetadata.teammates) are narrower than the converted showcase
// character shape; these casts are exact, matching scoring.ts's convention.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

// ─── data source ─────────────────────────────────────────────────────────────

/** Fixed upstream publish address (leaderboardDataLoader.ts:46-54 beta fallback). */
const NETWORK_BASE_URL = 'https://fribbels.github.io/dreary-quibbles/leaderboard'

/** `auto` resolves this env var to a custom base before falling back to network. */
const SOURCE_ENV_VAR = 'HSR_MCP_LEADERBOARD_URL'

const MANIFEST_FILENAME = 'leaderboard.json'
const TIMELINE_FILENAME = 'leaderboard-timeline.json'

const DEFAULT_TIMEOUT_MS = 15_000

/** Published-site cutoff: only builds scoring >= 150% appear off localhost. */
const PUBLIC_SCORE_CUTOFF = 1.5

/** TimelineFeed.tsx:14 caps the feed at 100 entries. */
const TIMELINE_MAX_FEED = 100

type DataSourceMode = 'auto' | 'network' | 'url'

type ResolvedDataSource = {
  source: 'network' | 'url',
  baseUrl: string,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(
      `排行榜数据源地址无效:「${raw}」——需要 http:// 或 https:// 开头,指向 leaderboard.json 所在目录`
        + `(如 ${NETWORK_BASE_URL} 或自建镜像的 http://host/leaderboard)`,
    )
  }
  return trimmed
}

function resolveDataSource(mode: DataSourceMode, baseUrlParam: string | undefined): ResolvedDataSource {
  if (mode === 'url') {
    if (baseUrlParam == null || baseUrlParam.trim() === '') {
      throw new Error(`source=url 需要同时提供 baseUrl(http/https 数据根地址,指向 leaderboard.json 所在目录;如 ${NETWORK_BASE_URL})`)
    }
    return { source: 'url', baseUrl: normalizeBaseUrl(baseUrlParam) }
  }
  if (mode === 'network') return { source: 'network', baseUrl: NETWORK_BASE_URL }

  const envUrl = process.env[SOURCE_ENV_VAR]
  if (envUrl != null && envUrl.trim() !== '') {
    return { source: 'url', baseUrl: normalizeBaseUrl(envUrl) }
  }
  return { source: 'network', baseUrl: NETWORK_BASE_URL }
}

async function fetchJsonFromSource(baseUrl: string, filename: string, timeoutMs: number): Promise<unknown> {
  const url = `${baseUrl}/${filename}`
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const name = (e as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`排行榜数据拉取超时(${timeoutMs}ms):${url}——可增大 timeoutMs 重试;拉取失败不会以空榜单返回`)
    }
    throw new Error(
      `排行榜数据网络请求失败:${url}(${(e as Error)?.message ?? String(e)})`
        + '——请检查服务器网络出口是否可达该地址,或改用 source=url 指向可达的镜像;拉取失败不会以空榜单返回',
    )
  }
  if (!response.ok) {
    throw new Error(
      `排行榜数据拉取失败:HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}(${url})`
        + '——该数据源没有这份文件或暂时不可用;不会以空榜单返回,可换 source=url 指向其他镜像',
    )
  }
  try {
    return await response.json()
  } catch (e) {
    throw new Error(`排行榜数据不是合法 JSON:${url}(${(e as Error)?.message ?? String(e)})——不会以空榜单返回`)
  }
}

// ─── dataset (manifest + per-character decompression + indexes) ─────────────

type BuildIndexEntry = {
  characterId: CharacterId,
  configType: string,
  teamId: string,
}

type LeaderboardDataset = {
  source: 'network' | 'url',
  baseUrl: string,
  /** Manifest generatedAt when present, else the fetch timestamp (ISO). */
  version: string,
  fetchedAt: number,
  /** The parsed manifest verbatim (render re-serves it to the browser page). */
  rawManifest: Record<string, unknown>,
  characters: Map<CharacterId, PublicCharacterData>,
  topScores: Partial<Record<CharacterId, number>>,
  totalEntries: Partial<Record<CharacterId, number>>,
  buildIndex: Map<string, BuildIndexEntry>,
  /** initializeLeaderboardTab merge: live manifest ids (rarity 5) ∪ metadata fallback ids. */
  mergedCharacterIds: CharacterId[],
}

/** Mirror of decompressCharacterDataAsync (leaderboardDataLoader.ts:132-144) with Chinese errors. */
async function decompressPublicCharacterData(
  compressed: string,
  characterId: string,
  baseUrl: string,
): Promise<PublicCharacterData> {
  let binary: string
  try {
    binary = atob(compressed)
  } catch (e) {
    throw new Error(
      `角色 ${characterId} 的榜单数据不是合法 base64(${(e as Error)?.message ?? String(e)})——数据源 ${baseUrl} 的 ${MANIFEST_FILENAME} 可能损坏`,
    )
  }
  try {
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    const decompressed = new DecompressionStream('gzip')
    const writer = decompressed.writable.getWriter()
    writer.write(bytes)
    writer.close()

    const parsed = await new Response(decompressed.readable).json() as unknown
    if (!isRecord(parsed) || !isRecord(parsed.configs)) {
      throw new Error('解压后的角色数据缺少 configs 对象(期望 PublicCharacterData)')
    }
    return parsed as PublicCharacterData
  } catch (e) {
    throw new Error(
      `角色 ${characterId} 的榜单数据解压/解析失败(${e instanceof Error ? e.message : String(e)})`
        + `——数据源 ${baseUrl} 的 ${MANIFEST_FILENAME} 可能损坏;不会以空榜单返回`,
    )
  }
}

/** Mirror of getPublicEntryCount (leaderboardDataLoader.ts:150-165): unique >=150% candidates, capped at 100. */
function publicEntryCountOf(characterData: PublicCharacterData): number {
  const seen = new Set<string>()
  for (const configData of Object.values(characterData.configs)) {
    if (!configData) continue
    for (const boardData of Object.values(configData.teamsById)) {
      for (const entry of boardData.entries) {
        if (entry.score >= PUBLIC_SCORE_CUTOFF) {
          seen.add(entry.candidateId)
        }
      }
    }
  }
  return Math.min(seen.size, 100)
}

async function buildDataset(resolved: ResolvedDataSource, timeoutMs: number): Promise<LeaderboardDataset> {
  const { baseUrl } = resolved
  const manifest = await fetchJsonFromSource(baseUrl, MANIFEST_FILENAME, timeoutMs)
  if (!isRecord(manifest) || !isRecord(manifest.characters)) {
    throw new Error(
      `排行榜清单结构不符:${baseUrl}/${MANIFEST_FILENAME} 期望 { generatedAt, characters: { [角色id]: base64-gzip } },`
        + `实际缺少 characters 对象(${manifest == null ? String(manifest) : typeof manifest})——不会以空榜单返回`,
    )
  }
  for (const [id, compressed] of Object.entries(manifest.characters)) {
    if (typeof compressed !== 'string') {
      throw new Error(`排行榜清单里角色 ${id} 的数据不是字符串(base64-gzip)——${baseUrl}/${MANIFEST_FILENAME} 结构损坏`)
    }
  }

  const fetchedAt = Date.now()
  const generatedAt = typeof manifest.generatedAt === 'string' ? manifest.generatedAt : null
  const version = generatedAt ?? new Date(fetchedAt).toISOString()

  // Decompress concurrently, then insert in MANIFEST order — the web reads
  // Object.keys(output.characters), and stable sorts downstream must break
  // score ties by manifest order, not by decompression completion order.
  const characters = new Map<CharacterId, PublicCharacterData>()
  const manifestEntries = Object.entries(manifest.characters)
  const decompressed = await Promise.all(
    manifestEntries.map(([id, compressed]) => decompressPublicCharacterData(compressed as string, id, baseUrl)),
  )
  for (const [id, data] of manifestEntries.map(([id], i) => [id, decompressed[i]] as const)) {
    characters.set(id as CharacterId, data)
  }

  // Index loops mirror getLeaderboardTopScores (leaderboardDataLoader.ts:195-248):
  // top score = max entry score across every config/team; totalEntries = the
  // FIRST config's totalEntries (Object.entries order); buildId → board lookup.
  const topScores: Partial<Record<CharacterId, number>> = {}
  const totalEntries: Partial<Record<CharacterId, number>> = {}
  const buildIndex = new Map<string, BuildIndexEntry>()

  for (const [characterId, charData] of characters) {
    let charBestScore = -Infinity
    let charTotalEntries = 0
    let isFirstConfig = true

    for (const [configType, configData] of Object.entries(charData.configs)) {
      if (!configData) continue

      if (isFirstConfig) {
        charTotalEntries = configData.totalEntries
      }

      for (const [teamId, boardData] of Object.entries(configData.teamsById)) {
        for (const entry of boardData.entries) {
          if (entry.score > charBestScore) {
            charBestScore = entry.score
          }
          buildIndex.set(entry.buildId, { characterId, configType, teamId })
        }
      }

      isFirstConfig = false
    }

    if (charBestScore > -Infinity) topScores[characterId] = charBestScore
    if (charTotalEntries > 0) totalEntries[characterId] = charTotalEntries
  }

  // initializeLeaderboardTab merge (leaderboardTabController.ts:295-298).
  const metadata = getGameMetadata()
  const liveIds = [...characters.keys()].filter((id) => metadata.characters[id]?.rarity === 5)
  const fallbackIds = getLeaderboardCharacters()
  const mergedCharacterIds = [...new Set([...liveIds, ...fallbackIds])]

  return {
    source: resolved.source,
    baseUrl,
    version,
    fetchedAt,
    rawManifest: manifest as Record<string, unknown>,
    characters,
    topScores,
    totalEntries,
    buildIndex,
    mergedCharacterIds,
  }
}

const datasetCache = new Map<string, Promise<LeaderboardDataset>>()

function loadDataset(resolved: ResolvedDataSource, timeoutMs: number): Promise<LeaderboardDataset> {
  const cached = datasetCache.get(resolved.baseUrl)
  if (cached) return cached
  // Download-once-per-session like upstream cachedPromise; failures evict the
  // entry so a retry can succeed instead of caching the rejection.
  const promise = buildDataset(resolved, timeoutMs).catch((e: unknown) => {
    datasetCache.delete(resolved.baseUrl)
    throw e
  })
  datasetCache.set(resolved.baseUrl, promise)
  return promise
}

// ─── timeline ────────────────────────────────────────────────────────────────

type TimelineState =
  | {
    available: true,
    schemaVersion: number,
    generatedAt: string | null,
    events: TimelineEvent[],
    /** Wire entries dropped by validation (upstream warns + drops; we count). */
    dropped: number,
  }
  | {
    available: false,
    reason: string,
    /** true = 瞬时失败(网络/超时),不缓存,下次调用重试;缺省 = 数据固有不可用,可缓存 */
    transient?: boolean,
  }

async function buildTimelineState(baseUrl: string, timeoutMs: number): Promise<TimelineState> {
  let raw: unknown
  try {
    raw = await fetchJsonFromSource(baseUrl, TIMELINE_FILENAME, timeoutMs)
  } catch (e) {
    // Upstream loadLeaderboardTimeline catches → [] (timeline failure is NOT a
    // board failure); the coverage contract wants an empty list WITH a reason.
    return { available: false, reason: `动态文件不可用:${(e as Error).message}` }
  }
  if (!isRecord(raw)) {
    return { available: false, reason: `动态文件不是 JSON 对象(${TIMELINE_FILENAME})` }
  }

  const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1
  if (schemaVersion < TIMELINE_SCHEMA_VERSION) {
    return { available: false, reason: `动态文件 schemaVersion ${schemaVersion} 低于当前要求的 ${TIMELINE_SCHEMA_VERSION},按过旧处理不显示动态` }
  }
  if (!Array.isArray(raw.events)) {
    return { available: false, reason: '动态文件缺少 events 数组' }
  }

  // Mirror normalizeBrowserTimelineEvent (leaderboardDataLoader.ts:93-114).
  const events: TimelineEvent[] = []
  let dropped = 0
  for (const value of raw.events) {
    const parsed = parseTimelineEventWire(value as RawTimelineEvent)
    if (!parsed) {
      dropped++
      continue
    }
    try {
      const legacyCandidateId = parsed.uidHash == null
        ? undefined
        : await computeBrowserCandidateId(parsed.uidHash, parsed.characterId)
      const completed = completeTimelineEventIdentity(parsed, legacyCandidateId)
      if (!completed) {
        dropped++
        continue
      }
      events.push(completed)
    } catch {
      dropped++
    }
  }
  return {
    available: true,
    schemaVersion,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    events,
    dropped,
  }
}

const timelineCache = new Map<string, Promise<TimelineState>>()

function loadTimelineState(baseUrl: string, timeoutMs: number): Promise<TimelineState> {
  const cached = timelineCache.get(baseUrl)
  if (cached) return cached
  const promise = buildTimelineState(baseUrl, timeoutMs)
    .catch((e: unknown): TimelineState => ({
      available: false,
      reason: `动态文件不可用:${(e as Error).message}`,
      // transient failure (network/timeout): evict so the next call retries —
      // upstream resets cachedTimelinePromise on failure (leaderboardDataLoader.ts:124-127)
      transient: true,
    }))
    .then((state) => {
      if (!state.available && state.transient === true) timelineCache.delete(baseUrl)
      return state
    })
  timelineCache.set(baseUrl, promise)
  return promise
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function characterNameOf(characterId: string): string | null {
  // 网页端角色面板按当前语言的名字做包含匹配(CharacterListPanel.tsx:130)。
  // MCP 固定 zh_CN 渲染:优先 gameData 命名空间的 zh 名(与 game://metadata
  // 资源同款 translator),缺失时回落元数据英文名。
  const zh = zhNameOf(characterId)
  return zh ?? getGameMetadata().characters[characterId as CharacterId]?.name ?? null
}

function zhNameOf(characterId: string): string | null {
  try {
    ensureI18nReady()
    const value = (i18next.getFixedT(null, 'gameData') as (key: string, options?: { defaultValue?: string }) => string)(
      `Characters.${characterId}.Name`,
      { defaultValue: '' },
    )
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function lightConeNameOf(lightConeId: string | null): string | null {
  if (lightConeId == null) return null
  return getGameMetadata().lightCones[lightConeId as LightConeId]?.name ?? null
}

/** RankListPanel display: truncate10ths(score * 100) (RankListPanel.tsx:49,71). */
function scoreDisplayOf(score: number): number {
  return truncate10ths(score * 100)
}

type TeammatePayload = {
  characterId: string,
  name: string | null,
  lightCone: string | null,
  lightConeName: string | null,
  characterEidolon: number,
  lightConeSuperimposition: number,
}

function serializeTeammates(entry: LeaderboardEntry): TeammatePayload[] {
  return entry.team.map((t) => ({
    characterId: t.characterId as string,
    name: characterNameOf(t.characterId as string),
    lightCone: t.lightCone as string,
    lightConeName: lightConeNameOf(t.lightCone as string),
    characterEidolon: t.characterEidolon,
    lightConeSuperimposition: t.lightConeSuperimposition,
  }))
}

type LeaderboardRelicPayload = {
  part: string,
  set: string,
  grade: number,
  enhance: number,
  main: { stat: string, value: number },
  substats: Array<{ stat: string, value: number, rolls?: { high: number, mid: number, low: number }, addedRolls?: number }>,
  verified: boolean,
}

/**
 * Entry-card relics run the same expansion as the web preview
 * (recomputeDerivedState: expandCharacter → CharacterConverter.convert), but
 * converted relics carry no id/initialRolls — serialize the fields that exist.
 */
function serializeLeaderboardRelic(relic: Relic): LeaderboardRelicPayload {
  return {
    part: relic.part,
    set: relic.set,
    grade: relic.grade,
    enhance: relic.enhance,
    main: { stat: relic.main.stat, value: relic.main.value },
    substats: relic.substats.map((s) => ({
      stat: s.stat,
      value: s.value,
      ...(s.rolls != null ? { rolls: s.rolls } : {}),
      ...(s.addedRolls != null ? { addedRolls: s.addedRolls } : {}),
    })),
    verified: relic.verified === true,
  }
}

/**
 * deriveVisibleEntries + the published-site 150% cutoff. The node shims make
 * upstream's IS_LOCALHOST true (see module header); the monotone-score argument
 * makes this post-filter exactly the production board.
 */
function derivePublicBoardEntries(input: {
  characterData: PublicCharacterData | null,
  activeConfigType: LeaderboardConfigType | null,
  activeTeamId: string,
  filterCharacterEidolon: LeaderboardEidolonFilter,
}): LeaderboardEntry[] {
  return deriveVisibleEntries(input).filter((entry) => entry.score >= PUBLIC_SCORE_CUTOFF)
}

function requireCharacterData(dataset: LeaderboardDataset, characterId: string): PublicCharacterData {
  const characterData = dataset.characters.get(characterId as CharacterId)
  if (characterData == null) {
    const withData = [...dataset.characters.keys()].filter((id) => dataset.topScores[id] != null || (dataset.totalEntries[id] ?? 0) > 0)
    const preview = withData.slice(0, 12).join(', ')
    throw new Error(
      `角色 ${characterId} 不在榜单数据中(未开榜或该数据源没有它的数据;版本 ${dataset.version})`
        + `——当前有数据的角色共 ${withData.length} 个${preview ? `:${preview}${withData.length > 12 ? ' …' : ''}` : ''}`,
    )
  }
  return characterData
}

/** selectLeaderboardCharacter's config resolution (leaderboardTabController.ts:177-179,139-147). */
function resolveBoardConfigTypes(characterId: string, characterData: PublicCharacterData): LeaderboardConfigType[] {
  const validConfigs = new Set(getCharacterLeaderboardConfigTypes(characterId as CharacterId).map(configTypeToPublic))
  return Object.keys(characterData.configs)
    .filter(isLeaderboardConfigType)
    .filter((ct) => validConfigs.has(ct))
}

/** The wire entry behind a buildId — the source of truth for entry/score reads. */
type ResolvedLeaderboardWireEntry = {
  dataset: LeaderboardDataset,
  match: BuildIndexEntry,
  wireEntry: PublicLeaderboardEntry,
}

async function resolveLeaderboardWireEntry(
  resolved: ResolvedDataSource,
  buildId: string,
  timeoutMs: number,
): Promise<ResolvedLeaderboardWireEntry> {
  const dataset = await loadDataset(resolved, timeoutMs)

  const match = dataset.buildIndex.get(buildId)
  if (match == null) {
    throw new Error(
      `未找到配装编号 ${buildId}——它不在当前榜单数据(版本 ${dataset.version})的索引中;`
        + '链接指向的配装可能已落榜,或数据源版本较旧',
    )
  }

  const characterData = dataset.characters.get(match.characterId)
  if (characterData == null) {
    throw new Error(`配装 ${buildId} 的角色 ${match.characterId} 数据缺失——数据源 ${dataset.baseUrl} 索引与数据不一致`)
  }

  const wireEntry = (characterData.configs as Record<string, PublicConfigData | undefined>)[match.configType]
    ?.teamsById[match.teamId]?.entries.find((e) => e.buildId === buildId) ?? null
  if (wireEntry == null) {
    throw new Error(`配装 ${buildId} 在角色 ${match.characterId} 的 ${match.configType}/${match.teamId} 榜单数据中找不到条目——数据源索引与条目不一致`)
  }

  return { dataset, match, wireEntry }
}

/**
 * Shared entry anchor for other domains (render's character_card
 * source=leaderboard): resolves buildId → character/card identity through the
 * same dataset chain the leaderboard tool uses. `baseUrl` follows the tool's
 * source=model semantics: given → url mode; absent → auto (env var, then the
 * fixed upstream publish address).
 */
export async function resolveLeaderboardEntryTarget(input: {
  buildId: string,
  baseUrl?: string,
  timeoutMs?: number,
}): Promise<{
  source: 'network' | 'url',
  baseUrl: string,
  version: string,
  buildId: string,
  characterId: string,
  characterName: string | null,
  configType: string,
  /** Parsed manifest verbatim — render re-serves it to the page's own loader. */
  rawManifest: Record<string, unknown>,
}> {
  runtimeContext.ensureMetadataReady()
  const mode: DataSourceMode = input.baseUrl != null && input.baseUrl.trim() !== '' ? 'url' : 'auto'
  const resolved = resolveDataSource(mode, input.baseUrl)
  const { dataset, match } = await resolveLeaderboardWireEntry(resolved, input.buildId, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return {
    source: dataset.source,
    baseUrl: dataset.baseUrl,
    version: dataset.version,
    buildId: input.buildId,
    characterId: match.characterId as string,
    characterName: characterNameOf(match.characterId as string),
    configType: match.configType,
    rawManifest: dataset.rawManifest,
  }
}

// ─── output schema ───────────────────────────────────────────────────────────

const relicPayloadSchema = z.object({
  part: z.string(),
  set: z.string(),
  grade: z.number(),
  enhance: z.number(),
  main: z.object({ stat: z.string(), value: z.number() }),
  substats: z.array(z.object({
    stat: z.string(),
    value: z.number(),
    rolls: z.object({ high: z.number(), mid: z.number(), low: z.number() }).optional(),
    addedRolls: z.number().optional(),
  })),
  verified: z.boolean(),
})

const teammatePayloadSchema = z.object({
  characterId: z.string(),
  name: z.string().nullable(),
  lightCone: z.string().nullable(),
  lightConeName: z.string().nullable(),
  characterEidolon: z.number().int(),
  lightConeSuperimposition: z.number().int(),
})

// ─── registration ────────────────────────────────────────────────────────────

export function registerLeaderboardTools(server: McpServer): void {
  server.registerTool('leaderboard', {
    title: '排行榜只读查询',
    description: '排行榜(Leaderboard)页签的只读数据层——单工具 + view 枚举覆盖五个入口:'
      + 'characters=上榜角色清单(最高分/参与人数/公开展示人数,「数据不足」组单独标出,支持 search 与评分类型标签);'
      + 'board=某角色某评分类型的榜单行(名次/分数/星魂/光锥/队友,队伍与星魂档位过滤,与网页端同一条 deriveVisibleEntries 排名链);'
      + 'entry=按配装编号取上榜配装详情(名次/记录分数/AEON 标记/星魂光锥/队友/套装件数/六件遗器,遗器走 expandCharacter→CharacterConverter 同网页角色卡);'
      + 'score=对榜单配装本地重算评分(scoreLeaderboardBuild——维护者产出榜单分数用的同一函数,默认配置+参评队伍,并与榜单记录分数对比偏差);'
      + 'timeline=排行榜最近动态(涨幅按 150% 起算,畸形条目丢弃并计数);'
      + 'my_ranks=按 9 位 UID 查自己各榜名次(UID 仅本地哈希比对,不产生任何带 UID 的网络请求)。'
      + '数据源用 source 显式指定:auto=HSR_MCP_LEADERBOARD_URL 环境变量(缺省回落 network)、network=上游固定发布地址、'
      + 'url=baseUrl 指向自定义镜像;榜单数据进程内只拉取一次并透出 source/version/fetchedAt。'
      + '拉取/解压/解析失败一律返回中文错误而不是空榜单;只有真实「过滤后为空」才是 total=0 的成功。'
      + '动态文件不可用时 timeline 返回空列表并说明原因(与网页端一致,不算失败)。',
    inputSchema: {
      view: z.enum(['characters', 'board', 'entry', 'score', 'timeline', 'my_ranks']).describe(
        '查询入口:characters=角色清单、board=某角色的榜单、entry=单条配装详情、score=配装本地评分重算、timeline=最近动态、my_ranks=按 UID 查名次',
      ),
      source: z.enum(['auto', 'network', 'url']).default('auto').describe(
        `数据来源:auto=读环境变量 ${SOURCE_ENV_VAR}(未设置时等同 network)、network=上游固定发布地址(${NETWORK_BASE_URL})、url=使用 baseUrl 参数`,
      ),
      baseUrl: z.string().optional().describe('source=url 时的数据根地址(http/https,指向 leaderboard.json 所在目录;末尾斜杠可有可无)'),
      timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_TIMEOUT_MS).describe(
        `单文件拉取超时毫秒数(默认 ${DEFAULT_TIMEOUT_MS};仅对该数据源的首次拉取生效)`,
      ),
      search: z.string().optional().describe(
        'view=characters:不区分大小写的包含匹配——角色名取当前渲染语言(MCP 为中文,与网页端同语匹配)外加 characterId 域(id 命中是 MCP 的显式补充)',
      ),
      configType: z.enum(LEADERBOARD_CONFIG_TYPES).optional().describe(
        '评分类型(public 口径:dps/support/heal/shield):view=characters 作标签过滤;view=board 指定榜单类型(缺省取该角色有数据的第一个,顺序 dps>support>heal>shield)',
      ),
      characterId: z.string().optional().describe('view=board 必填:角色 id(必须是榜单数据里有数据的角色,先用 view=characters 查)'),
      teamId: z.string().optional().describe('view=board:队伍编号过滤,缺省 all=全部队伍合并榜(名次为总名次);指定队伍时名次为队内名次(与网页端队伍下拉一致)'),
      characterEidolon: z.enum(['all', 'e0', 'e1', 'e2', 'e6']).optional().describe(
        'view=board:星魂档位过滤(按「不低于」归档:3-5 魂归入 e2;all=不过滤)。名次保持过滤前的总名次,行数可能不连续——与网页端一致',
      ),
      buildId: z.string().optional().describe(
        'view=entry/view=score 必填:配装编号(网页端链接里的 b 参数;score 对它本地重算评分,与记录分数对比)',
      ),
      uid: z.string().optional().describe('view=my_ranks:9 位数字 UID;缺省用存档里展示柜页记住的 UID(没有则报错)'),
      offset: z.number().int().min(0).default(0).describe('分页偏移(对 characters/board/timeline/my_ranks 的行列表生效)'),
      limit: z.number().int().min(1).max(200).default(100).describe('分页每页行数(默认 100)'),
    },
    outputSchema: {
      view: z.enum(['characters', 'board', 'entry', 'score', 'timeline', 'my_ranks']),
      source: z.enum(['network', 'url']),
      baseUrl: z.string(),
      version: z.string(),
      fetchedAt: z.number(),
      // characters
      characters: z.array(z.object({
        rank: z.number().int().nullable(),
        group: z.enum(['active', 'insufficient_data']),
        characterId: z.string(),
        name: z.string().nullable(),
        leaderboardEnabled: z.boolean(),
        topScore: z.number(),
        topScoreDisplay: z.number(),
        entryCount: z.number().int(),
        publicEntryCount: z.number().int(),
        configTypes: z.array(z.string()),
      })).optional(),
      totalActive: z.number().int().optional(),
      totalInsufficientData: z.number().int().optional(),
      configTypeCounts: z.record(z.string(), z.number().int()).optional(),
      // board
      characterId: z.string().optional(),
      characterName: z.string().nullable().optional(),
      configType: z.string().optional(),
      configTypeRequested: z.boolean().optional(),
      teamId: z.string().optional(),
      characterEidolon: z.string().optional(),
      teams: z.array(z.object({
        teamId: z.string(),
        teammates: z.array(z.object({ characterId: z.string(), name: z.string().nullable() })),
      })).optional(),
      boardTotalEntries: z.number().int().optional(),
      scoreCutoff: z.number().optional(),
      rows: z.array(z.object({
        rank: z.number().int(),
        score: z.number(),
        scoreDisplay: z.number(),
        buildId: z.string(),
        characterEidolon: z.number().int(),
        eidolonGroup: z.string(),
        lightCone: z.object({ id: z.string(), name: z.string().nullable(), superimposition: z.number().int() }).nullable(),
        team: z.array(teammatePayloadSchema),
      })).optional(),
      total: z.number().int().optional(),
      offset: z.number().int().optional(),
      limit: z.number().int().optional(),
      // entry
      buildId: z.string().optional(),
      onBoard: z.boolean().optional(),
      teamScope: z.enum(['all', 'team']).optional(),
      scoredTeamId: z.string().optional(),
      rank: z.number().int().nullable().optional(),
      score: z.number().optional(),
      scoreDisplay: z.number().optional(),
      aeon: z.boolean().optional(),
      characterEidolonNumber: z.number().int().optional(),
      eidolonGroup: z.string().nullable().optional(),
      lightCone: z.object({ id: z.string(), name: z.string().nullable(), superimposition: z.number().int() }).nullable().optional(),
      team: z.array(teammatePayloadSchema).optional(),
      deprioritizeBuffs: z.boolean().optional(),
      fetchedAtEpoch: z.number().optional(),
      fetchedAtIso: z.string().optional(),
      baselineSimScore: z.number().optional(),
      benchmarkSimScore: z.number().optional(),
      maximumSimScore: z.number().optional(),
      setCounts: z.record(z.string(), z.number().int()).optional(),
      relics: z.record(z.string(), relicPayloadSchema).optional(),
      // score (view=score)
      scoredConfigType: z.string().optional(),
      recorded: z.object({
        score: z.number(),
        scoreDisplay: z.number(),
        aeon: z.boolean(),
        baselineSimScore: z.number(),
        benchmarkSimScore: z.number(),
        maximumSimScore: z.number(),
      }).optional(),
      recomputed: z.object({
        percent: z.number(),
        percentDisplay: z.number(),
        originalSimScore: z.number(),
        baselineSimScore: z.number(),
        benchmarkSimScore: z.number(),
        maximumSimScore: z.number(),
        originalSpd: z.number(),
        simulationFlags: z.object({
          overcapCritRate: z.boolean(),
          simPoetActive: z.boolean(),
          characterPoetActive: z.boolean(),
          forceErrRope: z.boolean(),
          benchmarkBasicSpdTarget: z.number(),
          benchmarkBasicResTarget: z.number(),
        }),
      }).optional(),
      delta: z.object({ percent: z.number(), percentDisplay: z.number() }).optional(),
      relicsEquipped: z.number().int().optional(),
      relicsVerified: z.boolean().optional(),
      durationMs: z.number().optional(),
      // timeline
      available: z.boolean().optional(),
      reason: z.string().optional(),
      schemaVersion: z.number().int().optional(),
      generatedAt: z.string().nullable().optional(),
      dropped: z.number().int().optional(),
      events: z.array(z.object({
        type: z.string(),
        characterId: z.string(),
        characterName: z.string().nullable(),
        configType: z.string(),
        rank: z.number().int(),
        score: z.number(),
        scoreDisplay: z.number(),
        previousScore: z.number().optional(),
        previousRank: z.number().optional(),
        scoreDeltaPercent: z.number().optional(),
        entryCount: z.number().int().optional(),
        isNewCharacter: z.boolean(),
        buildId: z.string(),
        candidateId: z.string(),
        date: z.string(),
      })).optional(),
      // my_ranks
      uid: z.string().optional(),
      uidSource: z.enum(['param', 'saved']).optional(),
      ranks: z.array(z.object({
        characterId: z.string(),
        characterName: z.string().nullable(),
        configType: z.string(),
        teamId: z.string(),
        isTeamRank: z.boolean(),
        rank: z.number().int(),
        score: z.number(),
        scoreDisplay: z.number(),
        buildId: z.string(),
      })).optional(),
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()

    const resolved = resolveDataSource(input.source, input.baseUrl)

    switch (input.view) {
      case 'characters':
        return await charactersView(resolved, input)
      case 'board':
        return await boardView(resolved, input)
      case 'entry':
        return await entryView(resolved, input)
      case 'score':
        return await scoreView(resolved, input)
      case 'timeline':
        return await timelineView(resolved, input)
      case 'my_ranks':
        return await myRanksView(resolved, input)
    }
  })

  // ── view=characters ─────────────────────────────────────────────────────────

  async function charactersView(resolved: ResolvedDataSource, input: {
    search?: string,
    configType?: LeaderboardConfigType,
    offset: number,
    limit: number,
    timeoutMs: number,
  }) {
    const dataset = await loadDataset(resolved, input.timeoutMs)

    // Chip counts (CharacterListPanel.tsx:108-113): over the merged list, pre-search.
    const configTypeCounts: Record<string, number> = {}
    for (const configType of LEADERBOARD_CONFIG_TYPES) {
      const scoringType = publicToConfigType(configType)
      const count = dataset.mergedCharacterIds
        .filter((id) => getCharacterLeaderboardConfigTypes(id).includes(scoringType))
        .length
      if (count > 0) configTypeCounts[configType] = count
    }

    const wanted = input.configType != null ? publicToConfigType(input.configType) : null
    const normalizedSearch = input.search?.trim().toLowerCase() ?? ''

    const rows = dataset.mergedCharacterIds
      .filter((id) => wanted == null || getCharacterLeaderboardConfigTypes(id).includes(wanted))
      .map((id) => {
        const characterData = dataset.characters.get(id) ?? null
        return {
          rank: null as number | null,
          group: isCharacterLeaderboardEnabled(id) ? 'active' as const : 'insufficient_data' as const,
          leaderboardEnabled: isCharacterLeaderboardEnabled(id),
          characterId: id as string,
          name: characterNameOf(id),
          topScore: dataset.topScores[id] ?? 0,
          topScoreDisplay: scoreDisplayOf(dataset.topScores[id] ?? 0),
          entryCount: dataset.totalEntries[id] ?? 0,
          publicEntryCount: characterData != null ? publicEntryCountOf(characterData) : 0,
          configTypes: getCharacterLeaderboardConfigTypes(id).map(configTypeToPublic),
        }
      })
      .filter((row) => normalizedSearch === '' || `${row.name ?? ''}${row.characterId}`.toLowerCase().includes(normalizedSearch))

    // Active sorted by topScore desc; growing («数据不足») by entryCount desc
    // (CharacterListPanel.tsx:138-152). Rank numbers belong to the active group.
    const active = rows.filter((row) => row.group === 'active').sort((a, b) => b.topScore - a.topScore)
    const growing = rows.filter((row) => row.group !== 'active').sort((a, b) => b.entryCount - a.entryCount)
    for (const [index, row] of active.entries()) row.rank = index + 1

    const combined = [...active, ...growing]
    const page = combined.slice(input.offset, input.offset + input.limit)

    return toolResult(
      {
        view: 'characters' as const,
        source: dataset.source,
        baseUrl: dataset.baseUrl,
        version: dataset.version,
        fetchedAt: dataset.fetchedAt,
        characters: page,
        total: combined.length,
        totalActive: active.length,
        totalInsufficientData: growing.length,
        configTypeCounts,
        offset: input.offset,
        limit: input.limit,
      },
      `上榜角色:${active.length} 个已开榜、${growing.length} 个数据不足`
        + `${input.configType != null ? `(标签 ${input.configType})` : ''}${normalizedSearch !== '' ? `(搜索「${input.search?.trim()}」)` : ''};`
        + `返回第 ${input.offset + 1} 起的 ${page.length} 个;数据源 ${dataset.baseUrl}(版本 ${dataset.version})`,
    )
  }

  // ── view=board ──────────────────────────────────────────────────────────────

  async function boardView(resolved: ResolvedDataSource, input: {
    characterId?: string,
    configType?: LeaderboardConfigType,
    teamId?: string,
    characterEidolon?: string,
    offset: number,
    limit: number,
    timeoutMs: number,
  }) {
    if (input.characterId == null || input.characterId.trim() === '') {
      throw new Error('view=board 需要 characterId(用 view=characters 先列出有榜单数据的角色)')
    }
    const characterId = input.characterId.trim()
    const dataset = await loadDataset(resolved, input.timeoutMs)
    const characterData = requireCharacterData(dataset, characterId)

    const configTypes = resolveBoardConfigTypes(characterId, characterData)
    if (configTypes.length === 0) {
      throw new Error(
        `角色 ${characterId}(${characterNameOf(characterId) ?? '?'})没有任何可用的评分类型榜单`
          + `——该角色没有任何可用评分类型的榜单数据;数据中出现过的配置键:${Object.keys(characterData.configs).join(', ') || '(空)'}`,
      )
    }
    let activeConfigType: LeaderboardConfigType | null = null
    if (input.configType != null) {
      if (!configTypes.includes(input.configType)) {
        throw new Error(`角色 ${characterId} 没有评分类型 ${input.configType} 的榜单——可用类型:${configTypes.join(', ')}`)
      }
      activeConfigType = input.configType
    } else {
      activeConfigType = LEADERBOARD_CONFIG_TYPES.find((c) => configTypes.includes(c)) ?? null
    }
    if (activeConfigType == null) {
      throw new Error(`角色 ${characterId} 的评分类型解析失败——可用类型:${configTypes.join(', ')}`)
    }

    const configData = characterData.configs[activeConfigType] ?? null
    if (configData == null) {
      throw new Error(`角色 ${characterId} 的 ${activeConfigType} 榜单数据不完整(配置键存在但内容为空)——数据源 ${dataset.baseUrl} 可能损坏`)
    }
    const teams: PublicTeamMeta[] = configData.teams
    const teamIds = teams.map((t) => t.teamId)

    if (input.teamId != null && input.teamId !== LEADERBOARD_FILTER_ALL && !teamIds.includes(input.teamId)) {
      throw new Error(
        `队伍编号 ${input.teamId} 不在角色 ${characterId} 的 ${activeConfigType} 榜单队伍中`
          + `——可用:${[LEADERBOARD_FILTER_ALL, ...teamIds].join(', ')}`,
      )
    }
    const activeTeamId = input.teamId ?? LEADERBOARD_FILTER_ALL
    const filterCharacterEidolon = (input.characterEidolon ?? LEADERBOARD_FILTER_ALL) as LeaderboardEidolonFilter

    const entries = derivePublicBoardEntries({
      characterData,
      activeConfigType,
      activeTeamId,
      filterCharacterEidolon,
    })
    const page = entries.slice(input.offset, input.offset + input.limit)

    const rows = page.map((entry) => {
      const lightConeId = entry.minifiedCharacter.q?.t != null ? String(entry.minifiedCharacter.q.t) : null
      return {
        rank: entry.rank,
        score: entry.score,
        scoreDisplay: scoreDisplayOf(entry.score),
        buildId: entry.buildId,
        characterEidolon: entry.characterEidolon,
        eidolonGroup: entry.eidolonGroup,
        lightCone: lightConeId == null
          ? null
          : {
            id: lightConeId,
            name: lightConeNameOf(lightConeId),
            superimposition: entry.minifiedCharacter.q?.r ?? 1,
          },
        team: serializeTeammates(entry),
      }
    })

    return toolResult(
      {
        view: 'board' as const,
        source: dataset.source,
        baseUrl: dataset.baseUrl,
        version: dataset.version,
        fetchedAt: dataset.fetchedAt,
        characterId,
        characterName: characterNameOf(characterId),
        configType: activeConfigType,
        configTypeRequested: input.configType != null,
        teamId: activeTeamId,
        characterEidolon: filterCharacterEidolon,
        teams: teams.map((t) => ({
          teamId: t.teamId,
          teammates: t.teammates.map((m) => ({ characterId: m.characterId, name: characterNameOf(m.characterId) })),
        })),
        boardTotalEntries: configData.totalEntries,
        scoreCutoff: PUBLIC_SCORE_CUTOFF,
        rows,
        total: entries.length,
        offset: input.offset,
        limit: input.limit,
      },
      `${characterNameOf(characterId) ?? characterId} 的 ${activeConfigType} 榜单`
        + `(队伍 ${activeTeamId},星魂 ${filterCharacterEidolon}):${entries.length} 行,`
        + `返回第 ${input.offset + 1} 起的 ${rows.length} 行;分数不低于 ${PUBLIC_SCORE_CUTOFF * 100}%;数据源版本 ${dataset.version}`,
    )
  }

  // ── view=entry ──────────────────────────────────────────────────────────────

  async function entryView(resolved: ResolvedDataSource, input: {
    buildId?: string,
    timeoutMs: number,
  }) {
    if (input.buildId == null || input.buildId.trim() === '') {
      throw new Error('view=entry 需要 buildId(配装编号,即网页端链接里的 b 参数;可从 view=board 行或 timeline 事件取得)')
    }
    const buildId = input.buildId.trim()
    const { dataset, match, wireEntry } = await resolveLeaderboardWireEntry(resolved, buildId, input.timeoutMs)
    const characterData = dataset.characters.get(match.characterId)
    if (characterData == null) {
      throw new Error(`配装 ${buildId} 的角色 ${match.characterId} 数据缺失——数据源 ${dataset.baseUrl} 索引与数据不一致`)
    }

    // resolveBoardTeamId parity (leaderboardTabController.ts:220-234): a build
    // reachable on the all-teams board belongs there; otherwise it only exists
    // on the team board it was scored on.
    const activeConfigType = isLeaderboardConfigType(match.configType) ? match.configType : null
    const allTeamsBoard = activeConfigType != null
      ? derivePublicBoardEntries({
        characterData,
        activeConfigType,
        activeTeamId: LEADERBOARD_FILTER_ALL,
        filterCharacterEidolon: LEADERBOARD_FILTER_ALL,
      })
      : []
    const boardTeamId = allTeamsBoard.some((entry) => entry.buildId === buildId) ? LEADERBOARD_FILTER_ALL : match.teamId
    const board = activeConfigType != null
      ? derivePublicBoardEntries({
        characterData,
        activeConfigType,
        activeTeamId: boardTeamId,
        filterCharacterEidolon: LEADERBOARD_FILTER_ALL,
      })
      : []
    const visible = board.find((entry) => entry.buildId === buildId) ?? null

    // The wire entry (from resolveLeaderboardWireEntry) is the source of truth
    // for recorded data; off-board builds (below the 150% cutoff or past top-N)
    // still return it with rank null — the web shows the board without
    // selecting the build in that case.
    const minified = wireEntry.data.character
    const characterEidolon = minified.r ?? 0
    const lightConeId = minified.q?.t != null ? String(minified.q.t) : null

    // Same expansion as recomputeDerivedState (leaderboardTabController.ts:79-83).
    const converted = CharacterConverter.convert(expandCharacter(minified))
    const relics: Record<string, LeaderboardRelicPayload> = {}
    const setCounts: Record<string, number> = {}
    for (const [part, relic] of Object.entries(converted.equipped)) {
      if (relic == null) continue
      relics[part] = serializeLeaderboardRelic(relic)
      setCounts[relic.set] = (setCounts[relic.set] ?? 0) + 1
    }

    const teammates: TeammatePayload[] = wireEntry.data.team.map((t) => ({
      characterId: t.characterId,
      name: characterNameOf(t.characterId),
      lightCone: t.lightCone,
      lightConeName: lightConeNameOf(t.lightCone),
      characterEidolon: t.characterEidolon,
      lightConeSuperimposition: t.lightConeSuperimposition,
    }))

    return toolResult(
      {
        view: 'entry' as const,
        source: dataset.source,
        baseUrl: dataset.baseUrl,
        version: dataset.version,
        fetchedAt: dataset.fetchedAt,
        buildId,
        characterId: match.characterId as string,
        characterName: characterNameOf(match.characterId as string),
        configType: match.configType,
        onBoard: visible != null,
        teamScope: boardTeamId === LEADERBOARD_FILTER_ALL ? 'all' as const : 'team' as const,
        scoredTeamId: match.teamId,
        rank: visible?.rank ?? null,
        score: wireEntry.score,
        scoreDisplay: scoreDisplayOf(wireEntry.score),
        aeon: wireEntry.score >= PUBLIC_SCORE_CUTOFF,
        characterEidolonNumber: characterEidolon,
        eidolonGroup: visible?.eidolonGroup ?? null,
        lightCone: lightConeId == null
          ? null
          : { id: lightConeId, name: lightConeNameOf(lightConeId), superimposition: minified.q?.r ?? 1 },
        team: teammates,
        deprioritizeBuffs: wireEntry.data.deprioritizeBuffs === true,
        fetchedAtEpoch: wireEntry.data.fetchedAt,
        fetchedAtIso: Number.isFinite(wireEntry.data.fetchedAt)
          ? new Date(wireEntry.data.fetchedAt).toISOString()
          : null,
        baselineSimScore: wireEntry.data.baselineSimScore,
        benchmarkSimScore: wireEntry.data.benchmarkSimScore,
        maximumSimScore: wireEntry.data.maximumSimScore,
        setCounts,
        relics,
      },
      `配装 ${buildId}(${characterNameOf(match.characterId as string) ?? match.characterId},${match.configType}):`
        + `${visible != null ? `第 ${visible.rank} 名(` : '('}${boardTeamId === LEADERBOARD_FILTER_ALL ? '全部队伍榜' : `队伍 ${match.teamId} 榜`},`
        + `分数 ${scoreDisplayOf(wireEntry.score)}${wireEntry.score >= PUBLIC_SCORE_CUTOFF ? ',AEON' : ''},`
        + `e${characterEidolon},遗器 ${Object.keys(relics).length} 件${visible == null ? ';低于展示门槛,不在当前榜单行内' : ''}`,
    )
  }

  // ── view=score ──────────────────────────────────────────────────────────────

  async function scoreView(resolved: ResolvedDataSource, input: {
    buildId?: string,
    timeoutMs: number,
  }) {
    if (input.buildId == null || input.buildId.trim() === '') {
      throw new Error('view=score 需要 buildId(配装编号;先用 view=board 或 view=entry 取得)')
    }
    const buildId = input.buildId.trim()
    const { dataset, match, wireEntry } = await resolveLeaderboardWireEntry(resolved, buildId, input.timeoutMs)

    if (!isLeaderboardConfigType(match.configType)) {
      throw new Error(
        `配装 ${buildId} 的评分类型 ${match.configType} 不是公开榜单类型(dps/support/heal/shield)——无法本地重算`,
      )
    }

    // Same expansion as recomputeDerivedState (leaderboardTabController.ts:79-83).
    const converted = CharacterConverter.convert(expandCharacter(wireEntry.data.character))
    const relicsList = Object.values(converted.equipped).filter((relic): relic is Relic => relic != null)
    if (relicsList.length === 0) {
      throw new Error(
        `配装 ${buildId}(角色 ${match.characterId})没有任何遗器——本地评分重算至少需要一件遗器`
          + '(压缩数据里没有遗器,或全部无法转换)',
      )
    }

    // LeaderboardCharacterPreview.tsx:35: publicToConfigType(activeConfigType).
    const configType = publicToConfigType(match.configType)
    // buildScoringPlan (scorer.ts:307) resolves DEFAULT_TEAM first; the web card
    // does the same through resolveShowcaseScoringData (showcaseDerivedData.ts:148).
    const sim = resolveSimulationMetadata(converted as Any, configType, DEFAULT_TEAM)
    if (!sim) {
      throw new Error(
        `角色 ${match.characterId} 没有 ${configType} 的评分元数据(游戏元数据缺该配置)——无法本地重算;`
          + '可能是元数据版本不含该评分类型,可换其他配装重试',
      )
    }

    // The web card's injectedOverride (applySimulationMetadataOverrides,
    // showcaseDerivedData.ts:185-199): the entry's scoring team replaces the
    // default team; deprioritizeBuffs uses the recorded value, falling back to
    // the effective resolution for configs that support it.
    sim.teammates = wireEntry.data.team.map((teammate) => ({
      characterId: teammate.characterId,
      lightCone: teammate.lightCone,
      characterEidolon: teammate.characterEidolon,
      lightConeSuperimposition: teammate.lightConeSuperimposition,
    })) as Any
    let deprioritizeBuffs: boolean | null = null
    const recordedDeprioritizeBuffs = wireEntry.data.deprioritizeBuffs
    if (typeof recordedDeprioritizeBuffs === 'boolean') {
      sim.deprioritizeBuffs = recordedDeprioritizeBuffs
      deprioritizeBuffs = recordedDeprioritizeBuffs
    } else if (SCORING_CONFIG_REGISTRY[configType].supportsDeprioritizeBuffs) {
      const effective = resolveEffectiveDeprioritizeBuffs(converted.id as Any, sim as Any)
      if (effective != null) {
        sim.deprioritizeBuffs = effective
        deprioritizeBuffs = effective
      }
    } // The maintainer's pipeline forces the inline search
    // (leaderboardPipeline.ts:283-288); scoring.ts does the same for the MCP.

    ;(globalThis as Any).SEQUENTIAL_BENCHMARKS = true

    const started = performance.now()
    const result = await scoreLeaderboardBuild({
      character: converted as Any,
      configType,
      simulationMetadata: sim,
      singleRelicByPart: converted.equipped as Any,
      showcaseTemporaryOptions: {},
      // scorer.ts:113 — the leaderboard pipeline never computes upgrade tables.
      scoreOnly: true,
    })
    const durationMs = Math.round(performance.now() - started)
    if (result == null || !Number.isFinite(result.percent)) {
      throw new Error(
        `配装 ${buildId}(角色 ${match.characterId},${configType})的本地评分计算失败——`
          + '模拟配置可能不完整;可换其他配装,或用 view=entry 读取榜单记录的分数',
      )
    }

    const recordedScore = wireEntry.score
    const verified = relicsList.length === 6 && relicsList.every((relic) => relic.verified === true)
    const percentDisplay = scoreDisplayOf(result.percent)
    const deltaPercent = result.percent - recordedScore

    return toolResult(
      {
        view: 'score' as const,
        source: dataset.source,
        baseUrl: dataset.baseUrl,
        version: dataset.version,
        fetchedAt: dataset.fetchedAt,
        buildId,
        characterId: match.characterId as string,
        characterName: characterNameOf(match.characterId as string),
        configType: match.configType,
        scoredConfigType: String(configType),
        recorded: {
          score: recordedScore,
          scoreDisplay: scoreDisplayOf(recordedScore),
          aeon: recordedScore >= PUBLIC_SCORE_CUTOFF,
          baselineSimScore: wireEntry.data.baselineSimScore,
          benchmarkSimScore: wireEntry.data.benchmarkSimScore,
          maximumSimScore: wireEntry.data.maximumSimScore,
        },
        recomputed: {
          percent: result.percent,
          percentDisplay,
          originalSimScore: result.originalSimScore,
          baselineSimScore: result.baselineSimScore,
          benchmarkSimScore: result.benchmarkSimScore,
          maximumSimScore: result.maximumSimScore,
          originalSpd: result.originalSpd,
          simulationFlags: { ...result.simulationFlags },
        },
        delta: {
          percent: deltaPercent,
          percentDisplay: scoreDisplayOf(deltaPercent),
        },
        team: wireEntry.data.team.map((t) => ({
          characterId: t.characterId,
          name: characterNameOf(t.characterId),
          lightCone: t.lightCone,
          lightConeName: lightConeNameOf(t.lightCone),
          characterEidolon: t.characterEidolon,
          lightConeSuperimposition: t.lightConeSuperimposition,
        })),
        deprioritizeBuffs,
        relicsEquipped: relicsList.length,
        relicsVerified: verified,
        durationMs,
      },
      `配装 ${buildId}(${characterNameOf(match.characterId as string) ?? match.characterId},${match.configType})本地重算:`
        + `${percentDisplay}%(${String(configType)},基准搜索内联),对比榜单记录 ${scoreDisplayOf(recordedScore)}%`
        + `(偏差 ${scoreDisplayOf(deltaPercent)} 百分点);`
        + `参评队伍 ${wireEntry.data.team.map((t) => t.characterId).join(', ') || '(无)'},遗器 ${relicsList.length} 件,耗时 ${durationMs}ms`,
    )
  }

  // ── view=timeline ───────────────────────────────────────────────────────────

  async function timelineView(resolved: ResolvedDataSource, input: {
    offset: number,
    limit: number,
    timeoutMs: number,
  }) {
    const state = await loadTimelineState(resolved.baseUrl, input.timeoutMs)

    if (!state.available) {
      return toolResult(
        {
          view: 'timeline' as const,
          source: resolved.source,
          baseUrl: resolved.baseUrl,
          version: 'unavailable',
          fetchedAt: Date.now(),
          available: false,
          reason: state.reason,
          events: [],
          total: 0,
          offset: input.offset,
          limit: input.limit,
        },
        `排行榜动态暂不可用:${state.reason}(与网页端一致,动态失败不影响榜单数据)`,
      )
    }

    const feed = state.events.slice(0, TIMELINE_MAX_FEED)
    const page = feed.slice(input.offset, input.offset + input.limit)
    const events = page.map((event) => {
      const base = {
        type: event.type as string,
        characterId: event.characterId as string,
        characterName: characterNameOf(event.characterId as string),
        configType: event.configType,
        rank: event.rank,
        score: event.score,
        scoreDisplay: scoreDisplayOf(event.score),
        isNewCharacter: event.type === 'new_character',
        buildId: event.buildId,
        candidateId: event.candidateId,
        date: event.date,
      }
      if (event.type === 'new_best') {
        // TimelineFeed.tsx:37-44: delta measured from max(previousScore, 150%).
        const clampedPrevious = Math.max(event.previousScore, TIMELINE_MIN_SCORE)
        return {
          ...base,
          previousScore: event.previousScore,
          previousRank: event.previousRank,
          // TimelineFeed.tsx:41-43 renders percentageToLocaleString(delta, 1)
          // — the delta ROUNDS to one decimal (unlike the score display, which
          // floors via truncate10ths).
          scoreDeltaPercent: Math.round((event.score - clampedPrevious) * 100 * 10) / 10,
        }
      }
      return { ...base, entryCount: event.entryCount }
    })

    return toolResult(
      {
        view: 'timeline' as const,
        source: resolved.source,
        baseUrl: resolved.baseUrl,
        version: state.generatedAt ?? `fetched-${new Date().toISOString()}`,
        fetchedAt: Date.now(),
        available: true,
        schemaVersion: state.schemaVersion,
        generatedAt: state.generatedAt,
        dropped: state.dropped,
        events,
        total: feed.length,
        offset: input.offset,
        limit: input.limit,
      },
      `排行榜动态:${feed.length} 条(丢弃畸形 ${state.dropped} 条),返回第 ${input.offset + 1} 起的 ${events.length} 条;`
        + `数据源 ${resolved.baseUrl}`,
    )
  }

  // ── view=my_ranks ───────────────────────────────────────────────────────────

  async function myRanksView(resolved: ResolvedDataSource, input: {
    uid?: string,
    offset: number,
    limit: number,
    timeoutMs: number,
  }) {
    let uid = input.uid?.trim() ?? ''
    let uidSource: 'param' | 'saved'
    if (uid === '') {
      // LeaderboardUserRanksCard reads the showcase tab's remembered UID.
      const scorerId = useShowcaseTabStore.getState().savedSession.scorerId
      if (scorerId == null || scorerId.trim() === '') {
        throw new Error(
          '需要 UID:view=my_ranks 未传 uid,且当前会话的展示柜页也没有记住的 UID'
            + '——显式传入 9 位数字 uid,或先 load_save 一个含展示柜 UID 的存档',
        )
      }
      uid = scorerId
      uidSource = 'saved'
    } else {
      uidSource = 'param'
    }

    const validUid = validateUuid(uid)
    if (validUid == null) {
      throw new Error(`无效的 UID:「${uid}」——需要 9 位数字(与网页端「你的 Aeon」卡片一致)`)
    }

    const dataset = await loadDataset(resolved, input.timeoutMs)
    // The web iterates availableCharacters (rarity-5 merged set, LeaderboardUserRanksCard.tsx:83-91)
    const loadedCharacters: LoadedLeaderboardCharacter[] = dataset.mergedCharacterIds
      .map((characterId) => ({ characterId, characterData: dataset.characters.get(characterId) }))
      .filter((entry): entry is LoadedLeaderboardCharacter => entry.characterData != null)
    if (loadedCharacters.length === 0) {
      throw new Error(`榜单数据不可用(版本 ${dataset.version} 没有任何角色数据)——无法按 UID 查询名次`)
    }

    // The lookup itself is pure local hashing + in-memory matching
    // (lookupUserLeaderboardRanks); the only network request was the anonymous
    // manifest download, which never carries the UID.
    const matches = (await lookupUserLeaderboardRanks(validUid, loadedCharacters))
      .filter((rank) => rank.score >= PUBLIC_SCORE_CUTOFF)

    const page = matches.slice(input.offset, input.offset + input.limit)
    const ranks = page.map((rank) => ({
      characterId: rank.characterId as string,
      characterName: characterNameOf(rank.characterId as string),
      configType: rank.configType,
      teamId: rank.teamId,
      isTeamRank: rank.teamId !== LEADERBOARD_FILTER_ALL,
      rank: rank.rank,
      score: rank.score,
      scoreDisplay: scoreDisplayOf(rank.score),
      buildId: rank.buildId,
    }))

    return toolResult(
      {
        view: 'my_ranks' as const,
        source: dataset.source,
        baseUrl: dataset.baseUrl,
        version: dataset.version,
        fetchedAt: dataset.fetchedAt,
        uid: validUid,
        uidSource,
        ranks,
        total: matches.length,
        offset: input.offset,
        limit: input.limit,
      },
      `UID ${validUid}(来源${uidSource === 'param' ? '参数' : '存档展示柜'})的上榜配装:${matches.length} 条`
        + `${matches.length > 0 ? `,最好名次 #${matches[0].rank}` : ''};查询仅在本地对榜单数据哈希比对,UID 不随任何网络请求发出`,
    )
  }
}
