// Showcase domain: fetch_showcase + import_showcase — the web UI's Showcase
// (relicScorer) tab over the same upstream pipeline.
//
// fetch_showcase replicates the data core of showcaseApi.submitForm
// (src/lib/tabs/tabShowcase/showcaseApi.ts:66-93) without its UI coupling
// (screen-state transitions, Message notifications, setHashParams, the 10s
// throttle and the 1.5s reveal delay):
//   GET `${API_ENDPOINT}/profile/{uid}` → processMihomoData / processEnkaData
//   picked by `data.source` → CharacterConverter.convert → first-occurrence
//   dedupe by character id (the same avatar can sit in both an assist slot and
//   the showcase roster).
// The converted characters are cached in-process (cacheId is returned) for
// import_showcase. The showcase tab store is NOT touched here — import drives
// it explicitly, so both tools stay independently retryable.
//
// import_showcase feeds the cached characters into the showcase tab store with
// vanilla getState() (setFetchResult + selectCharacter, exactly the state the
// browser flow leaves behind) and then calls the web's own
// showcaseTabController.importShowcaseCharacters — same persistence chain as the
// browser (upsertCharacterFromForm + mergePartialRelics + delayedSave) — followed
// by runtimeContext.markDirty() so the debounced flush persists to the save file.
// The web's Import menu choices collapse into the `mode` parameter:
//   relics    ← 「导入遗器」   (inventory merge only — verified substats overwrite
//                               matched relics, new relics added unequipped)
//   character ← 「导入角色」   (selected character upserted + its relics equipped)
//   all       ← 「导入全部角色」(every showcase character)
// Upstream parity note: the relic merge always covers EVERY showcase character's
// relics regardless of mode; the mode only decides which characters are upserted
// and which of them get relics re-equipped (mergePartialRelics' sourceCharacters).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PartsArray } from 'lib/constants/constants'
import {
  CharacterConverter,
  type UnconvertedCharacter,
} from 'lib/importer/characterConverter'
import {
  findRelicMatch,
  partialHashRelic,
} from 'lib/relics/relicUtils'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  getCharacterById,
  getCharacters,
} from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import {
  processEnkaData,
  processMihomoData,
} from 'lib/tabs/tabShowcase/dataProcessors'
import { importShowcaseCharacters } from 'lib/tabs/tabShowcase/showcaseTabController'
import type { ShowcaseTabCharacter } from 'lib/tabs/tabShowcase/showcaseTabTypes'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import type { CharacterId } from 'types/character'
import type { LightConeId } from 'types/lightCone'
import type { Relic } from 'types/relic'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { toolResult } from '../toolResult'

// Mirrors API_ENDPOINT in src/lib/tabs/tabShowcase/showcaseApi.ts:17 (not exported upstream)
const SHOWCASE_API_ENDPOINT = 'https://9di5b7zvtb.execute-api.us-west-2.amazonaws.com/prod'

const DEFAULT_TIMEOUT_MS = 30_000

const UID_PATTERN = /^\d{9}$/

type ShowcaseSource = 'enka' | 'mihomo'

/**
 * Raw showcase avatar payload as the API ships it. UnconvertedCharacter covers
 * everything the converter reads; `level` (character level) exists on the wire
 * but is dropped by the converter, so the summary reads it from here.
 */
type RawShowcaseCharacter = UnconvertedCharacter & { level?: number }

/** In-process cache of the most recent successful fetch/conversion (import_showcase's default data source). */
type ShowcaseCache = {
  cacheId: string,
  /** null when the cache was filled from inline json instead of a network fetch */
  uid: string | null,
  source: ShowcaseSource,
  fetchedAt: number,
  /** Converted showcase characters — this is what import consumes */
  characters: ShowcaseTabCharacter[],
  /** Raw per-character payloads, index-aligned with `characters` */
  rawCharacters: RawShowcaseCharacter[],
  /** Full raw API response (includeRaw passthrough for fetch_showcase) */
  raw: unknown,
}

let lastFetch: ShowcaseCache | null = null
let cacheCounter = 0

/**
 * remember=true 保留的缓存条目（旧的最先淘汰）。M6-B「缓存读取/选择」：
 * 默认行为不变（进程内只保留最近一次，import_showcase 读 lastFetch），
 * remember 的条目额外按 cacheId 可寻址，供 score_character(source=showcase)
 * 从历史档案里选角色而不必重新拉取。
 */
const rememberedCaches: ShowcaseCache[] = []
const REMEMBERED_CACHE_LIMIT = 8

function nextCacheId(): string {
  return `showcase-${++cacheCounter}-${Date.now().toString(36)}`
}

/** 按选择键取缓存：cacheId 命中 remembered 列表或最近一次；缺省返回最近一次。 */
export function getShowcaseCache(cacheId?: string): ShowcaseCache | null {
  if (cacheId != null) {
    return rememberedCaches.find((cache) => cache.cacheId === cacheId)
      ?? (lastFetch?.cacheId === cacheId ? lastFetch : null)
  }
  return lastFetch
}

/** 缓存清单（fetch_showcase 的选择键列表）。 */
export function listShowcaseCaches(): Array<{ cacheId: string, uid: string | null, source: ShowcaseSource, fetchedAt: number, characterCount: number }> {
  const latest = lastFetch
  return [
    ...rememberedCaches.map((cache) => ({
      cacheId: cache.cacheId,
      uid: cache.uid,
      source: cache.source,
      fetchedAt: cache.fetchedAt,
      characterCount: cache.characters.length,
    })),
    ...(latest != null && !rememberedCaches.some((cache) => cache.cacheId === latest.cacheId)
      ? [{ cacheId: latest.cacheId, uid: latest.uid, source: latest.source, fetchedAt: latest.fetchedAt, characterCount: latest.characters.length }]
      : []),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type FetchErrorType =
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'unsupported_source'
  | 'source_mismatch'
  | 'empty_profile'

/** Chinese structured error for fetch_showcase failures (payload + summary, no throw). */
function fetchError(uid: string, type: FetchErrorType, message: string, hint?: string) {
  return toolResult(
    { status: 'error', uid, error: { type, message, ...(hint != null ? { hint } : {}) } },
    `拉取展示柜失败(${type}):${message}${hint != null ? `——${hint}` : ''}`,
  )
}

/**
 * The conversion half of showcaseApi.submitForm (showcaseApi.ts:71-93): pick the
 * processor by `data.source`, convert every character, keep the FIRST occurrence
 * of each character id, and renumber `index` sequentially. Also returns the raw
 * payload of each KEPT character so callers can read fields the converter drops
 * (character level, light cone level). Throws on an unrecognized source.
 */
function convertShowcaseResponse(data: Record<string, unknown>): {
  source: ShowcaseSource,
  characters: ShowcaseTabCharacter[],
  rawCharacters: RawShowcaseCharacter[],
} {
  // The upstream param types (dataProcessors.ts) are opaque `{ source: … }`
  // shapes; source has been validated by the caller, so these casts are exact.
  let rawList: UnconvertedCharacter[]
  if (data.source === 'mihomo') {
    rawList = processMihomoData(data as { source: 'mihomo' })
  } else if (data.source === 'enka') {
    rawList = processEnkaData(data as { source: 'enka' })
  } else {
    throw new Error(`不支持的 showcase 数据源:${String(data.source)}(期望 "enka" 或 "mihomo")`)
  }

  const characters: ShowcaseTabCharacter[] = []
  const rawCharacters: RawShowcaseCharacter[] = []
  const seen = new Set<string>()
  for (const raw of rawList) {
    const converted = CharacterConverter.convert(raw)
    if (seen.has(converted.id)) continue
    seen.add(converted.id)
    converted.index = characters.length
    characters.push(converted)
    rawCharacters.push(raw as RawShowcaseCharacter)
  }
  return { source: data.source as ShowcaseSource, characters, rawCharacters }
}

/** Compact per-character summary for fetch_showcase (names via game metadata). */
function characterOverview(converted: ShowcaseTabCharacter, raw: RawShowcaseCharacter | undefined) {
  const characterMeta = getGameMetadata().characters[converted.id as CharacterId]
  const lightConeId = converted.form.lightCone
  const lightConeMeta = lightConeId != null ? getGameMetadata().lightCones[lightConeId as LightConeId] : undefined

  const equippedSlots: Record<string, { set: string, grade: number, enhance: number, mainStat: string, mainValue: number, substatCount: number }> = {}
  let equippedCount = 0
  for (const part of PartsArray) {
    const relic = converted.equipped[part]
    if (!relic) continue
    equippedCount++
    equippedSlots[part] = {
      set: relic.set,
      grade: relic.grade,
      enhance: relic.enhance,
      mainStat: relic.main.stat,
      mainValue: relic.main.value,
      substatCount: relic.substats.length,
    }
  }

  return {
    index: converted.index,
    characterId: converted.id,
    name: characterMeta?.name ?? null,
    path: characterMeta?.path ?? null,
    element: characterMeta?.element ?? null,
    rarity: characterMeta?.rarity ?? null,
    level: raw?.level ?? null,
    eidolon: converted.form.characterEidolon,
    lightCone: lightConeId == null
      ? null
      : {
        id: lightConeId,
        name: lightConeMeta?.name ?? null,
        superimposition: converted.form.lightConeSuperimposition,
        level: raw?.equipment?.level ?? null,
      },
    equippedCount,
    equippedSlots,
  }
}

/**
 * Predict what persistenceService.mergePartialRelics will do with these relics
 * (updated vs added) using the exact helpers and iteration order it uses
 * (partialHashRelic buckets + findRelicMatch, persistenceService.ts:416-450) —
 * upstream returns no stats, it only fires Message notifications.
 */
function predictMergeStats(newRelics: Relic[]) {
  const buckets: Record<string, Relic[]> = {}
  for (const relic of getRelics()) {
    const hash = partialHashRelic(relic)
    ;(buckets[hash] ??= []).push(relic)
  }

  const matchedIds = new Set<string>()
  let updated = 0
  let added = 0
  for (const newRelic of newRelics) {
    const candidates = (buckets[partialHashRelic(newRelic)] ?? []).filter((relic) => !matchedIds.has(relic.id))
    const match = findRelicMatch(newRelic, candidates)
    if (match != null) {
      matchedIds.add(match.id)
      updated++
    } else {
      added++
    }
  }
  return { updated, added }
}

export function registerShowcaseTools(server: McpServer): void {
  // ── fetch_showcase ──────────────────────────────────────────────────────────
  server.registerTool('fetch_showcase', {
    title: '拉取展示柜档案',
    description: '按 UID 拉取玩家展示柜档案——对应网页端 Showcase(展示)页签输入 UID 后点提交:'
      + '调用同一个上游代理端点(/profile/{uid}),按返回数据的 source 字段(enka|mihomo)选择解析器,'
      + '经 CharacterConverter 转换并按角色去重(同一角色可能同时出现在支援位与展示位)。'
      + '本工具只拉取与缓存,不改动存档(remember 除外,见下);返回角色摘要(名称/命途/属性/等级/星魂/光锥/已穿遗器概览),'
      + '成功结果缓存在进程内(返回 cacheId),随后用 import_showcase 导入当前存档、score_character(source=showcase) 直接评分。'
      + '展示柜数据由 enka/mihomo 扫描器维护:从未被扫描的 UID 会得到空档案,游戏内未公开展示信息则查不到。'
      + '超时与 HTTP 错误以结构化中文错误返回(type + message + hint),不会抛异常。'
      + 'uid 与 json 二选一:json 内联传入同一格式的 showcase 响应(零网络,走同一条校验与转换链,适合重放/测试)。'
      + '刷新 = 对同一 UID 再次调用(没有网页端的 10 秒节流)。'
      + 'remember=true 对应网页端「记住上次查询的 UID」:把 UID 写进存档的 savedSession.showcaseTab.scorerId'
      + '(需要已载入存档),同时把这份缓存保留在进程内供后续按 cacheId 选用(否则只保留最近一次);返回的 cached 列表即缓存清单/选择键。',
    inputSchema: {
      uid: z.string().optional().describe('游戏内 UID(仅接受 9 位数字——比网页端更严;与 json 二选一)'),
      json: z.unknown().optional().describe('内联 showcase 原始响应({source:"enka"|"mihomo", detailInfo:{…}});与 uid 二选一,零网络'),
      source: z.enum(['enka', 'mihomo']).optional().describe(
        '期望的数据源;不传则按上游逻辑由响应的 source 字段决定;传入且与实际返回不一致时返回 source_mismatch 结构化错误(该次结果不写缓存)',
      ),
      remember: z.boolean().default(false).describe('记住本次档案:UID 写入存档会话项 + 缓存保留在进程内按 cacheId 可选(默认只保留最近一次)'),
      includeRaw: z.boolean().default(false).describe('返回中附带上游原始 JSON 响应(可能很大,一般仅在排障时开启)'),
      timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_TIMEOUT_MS).describe('网络超时毫秒数(默认 30000)'),
    },
    // 拉取成功与结构化失败两种形状:status/uid 恒有,其余字段按分支 .optional()
    outputSchema: {
      status: z.enum(['ok', 'error']),
      uid: z.string().nullable(),
      dataOrigin: z.enum(['network', 'inline']).optional(),
      remembered: z.boolean().optional(),
      cached: z.array(z.object({
        cacheId: z.string(),
        uid: z.string().nullable(),
        source: z.enum(['enka', 'mihomo']),
        fetchedAt: z.number(),
        characterCount: z.number().int(),
      })).optional(),
      cacheId: z.string().optional(),
      source: z.enum(['enka', 'mihomo']).optional(),
      fetchedAt: z.number().optional(),
      characterCount: z.number().int().optional(),
      characters: z.array(z.object({
        index: z.number().int(),
        characterId: z.string(),
        name: z.string().nullable(),
        path: z.string().nullable(),
        element: z.string().nullable(),
        rarity: z.number().nullable(),
        level: z.number().nullable(),
        eidolon: z.number(),
        lightCone: z.object({
          id: z.string(),
          name: z.string().nullable(),
          superimposition: z.number(),
          level: z.number().nullable(),
        }).nullable(),
        equippedCount: z.number().int(),
        equippedSlots: z.record(
          z.string(),
          z.object({
            set: z.string(),
            grade: z.number(),
            enhance: z.number(),
            mainStat: z.string(),
            mainValue: z.number(),
            substatCount: z.number().int(),
          }),
        ),
      })).optional(),
      raw: z.unknown().optional(),
      error: z.object({
        type: z.enum(['timeout', 'network', 'http', 'invalid_response', 'unsupported_source', 'source_mismatch', 'empty_profile']),
        message: z.string(),
        hint: z.string().optional(),
      }).optional(),
    },
  }, async ({ uid, json, source, remember, includeRaw, timeoutMs }) => {
    runtimeContext.ensureMetadataReady()

    // 载荷归一化:uid(网络)与 json(内联)二选一,同一条 source 校验 + 转换链。
    // 网络路径的数据问题保持结构化错误(不抛异常);内联 json 是调用方自己的
    // 载荷,问题直接抛中文错误(与 import_showcase 的 json 分支一致)。
    let parsed: Record<string, unknown> | undefined
    let trimmed: string | null
    const dataOrigin: 'network' | 'inline' = json != null ? 'inline' : 'network'
    if (json != null) {
      if (uid != null) {
        throw new Error('fetch_showcase:uid 与 json 二选一 — 内联数据不走网络,不需要 UID')
      }
      if (!isRecord(json)) {
        throw new Error('json 必须是 showcase API 响应对象({source, detailInfo})')
      }
      parsed = json
      trimmed = null
    } else {
      if (uid == null) {
        throw new Error('fetch_showcase:请提供 uid(9 位数字)或内联 json 数据(二选一)')
      }
      trimmed = uid.trim()
      if (!UID_PATTERN.test(trimmed)) {
        throw new Error(`无效的 UID:「${trimmed}」——需要 9 位数字(比网页端更严:网页端只校验长度,本工具仅接受 9 位数字)`)
      }
    }

    if (dataOrigin === 'inline') {
      const inline = json as Record<string, unknown>
      if (inline.source !== 'enka' && inline.source !== 'mihomo') {
        throw new Error(`json 的数据源字段必须是 "enka" 或 "mihomo"(实际为 ${String(inline.source)})`)
      }
      if (source != null && inline.source !== source) {
        throw new Error(`期望数据源 ${source},json 实际为 ${inline.source}`)
      }
    }

    if (dataOrigin === 'network') {
      const uidValue = trimmed!
      let response: Response
      try {
        // Same request shape as submitForm: plain GET, no extra headers
        response = await fetch(`${SHOWCASE_API_ENDPOINT}/profile/${uidValue}`, {
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        const name = (e as Error)?.name
        if (name === 'TimeoutError' || name === 'AbortError') {
          return fetchError(uidValue, 'timeout', `请求超过 ${timeoutMs}ms 未完成`, '上游代理冷启动可能较慢,可增大 timeoutMs 后重试')
        }
        return fetchError(uidValue, 'network', `网络请求失败:${(e as Error)?.message ?? String(e)}`, '请检查服务器网络出口能否访问该上游端点(us-west-2)')
      }

      if (!response.ok) {
        const hint = response.status === 404 || response.status === 400
          ? '该 UID 暂无扫描数据:确认 UID 正确、游戏内已公开展示信息,且被 enka/mihomo 至少扫描过一次,稍后重试'
          : '上游服务暂时不可用或限流,请稍后重试'
        return fetchError(uidValue, 'http', `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`, hint)
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (e) {
        return fetchError(uidValue, 'invalid_response', `响应不是合法 JSON:${(e as Error)?.message ?? String(e)}`)
      }
      if (!isRecord(body)) {
        return fetchError(uidValue, 'invalid_response', `响应不是 JSON 对象(实际为 ${body === null ? 'null' : typeof body})`)
      }
      if (body.source !== 'enka' && body.source !== 'mihomo') {
        return fetchError(
          uidValue,
          'unsupported_source',
          `上游返回了未知数据源:${String(body.source)}`,
          '该端点应返回 source 为 "enka" 或 "mihomo" 的数据;持续出现请上报',
        )
      }
      if (source != null && body.source !== source) {
        return fetchError(
          uidValue,
          'source_mismatch',
          `期望数据源 ${source},实际返回 ${body.source}`,
          `去掉 source 参数重试即可使用这份 ${body.source} 数据(不匹配的结果不写缓存)`,
        )
      }
      parsed = body
    }

    // tsgo's definite-assignment analysis can't see through the await-heavy
    // network block above (every path in it either returns or assigns), so
    // narrow explicitly. Genuinely unreachable: inline assigns before the
    // network block, network assigns-or-returns inside it.
    if (parsed == null) {
      throw new Error('fetch_showcase: 内部错误 — inline/network 分支都未解析出响应对象')
    }
    const payload: Record<string, unknown> = parsed

    // A source-validated payload the upstream processors/converter reject (e.g.
    // {source:"mihomo"} without detailInfo — an empty/half-scanned profile) must
    // stay inside the structured-error contract: no bare TypeError may escape.
    let converted: ReturnType<typeof convertShowcaseResponse>
    try {
      converted = convertShowcaseResponse(parsed)
    } catch (e) {
      if (dataOrigin === 'inline') {
        throw new Error(`json 转换失败:${(e as Error).message}`)
      }
      return fetchError(
        trimmed!,
        'invalid_response',
        `数据源 ${String(payload.source)} 的响应结构无法解析:${(e as Error)?.message ?? String(e)}`,
        '空档案或半扫描档案是现实输入:稍后重试,或去掉 source 参数改由响应自证数据源',
      )
    }
    const { source: resolvedSource, characters, rawCharacters } = converted
    if (characters.length === 0) {
      if (dataOrigin === 'inline') {
        throw new Error('json 中没有任何角色(展示柜为空?)')
      }
      return fetchError(trimmed!, 'empty_profile', '档案中没有任何角色', '展示柜为空或该 UID 从未被扫描过;可在游戏内更新展示柜后稍后重试')
    }

    // remember:网页端「记住上次查询的 UID」——savedSession.showcaseTab.scorerId
    // 随存档落盘(initializeShowcaseOnMount 据此自动重拉)。需要已载入存档。
    if (remember === true && dataOrigin === 'network') {
      if (runtimeContext.getSave() == null) {
        throw new Error('fetch_showcase:remember=true 需要已载入存档(记住的 UID 写进存档的 savedSession.showcaseTab.scorerId)——先 load_save,或去掉 remember')
      }
      useShowcaseTabStore.getState().setScorerId(trimmed!)
      runtimeContext.markDirty()
    }

    lastFetch = {
      cacheId: nextCacheId(),
      uid: trimmed,
      source: resolvedSource,
      fetchedAt: Date.now(),
      characters,
      rawCharacters,
      raw: payload,
    }
    if (remember === true) {
      rememberedCaches.push(lastFetch)
      if (rememberedCaches.length > REMEMBERED_CACHE_LIMIT) rememberedCaches.shift()
    }

    const overviews = characters.map((character, i) => characterOverview(character, rawCharacters[i]))
    return toolResult(
      {
        status: 'ok',
        dataOrigin,
        ...(remember === true ? { remembered: true } : {}),
        ...(remember === true ? { cached: listShowcaseCaches() } : {}),
        cacheId: lastFetch.cacheId,
        uid: trimmed,
        source: resolvedSource,
        fetchedAt: lastFetch.fetchedAt,
        characterCount: characters.length,
        characters: overviews,
        ...(includeRaw ? { raw: payload } : {}),
      },
      `已${dataOrigin === 'inline' ? '载入内联' : `拉取 ${trimmed}`}(${resolvedSource})的展示柜:${characters.length} 个角色,`
        + `共装备 ${overviews.reduce((count, c) => count + c.equippedCount, 0)} 件遗器;`
        + `缓存标识 ${lastFetch.cacheId},可用 import_showcase 导入或 score_character(source=showcase) 评分`
        + (remember === true ? '(已记住,可按 cacheId 选用)' : ''),
    )
  })

  // ── import_showcase ─────────────────────────────────────────────────────────
  server.registerTool('import_showcase', {
    title: '导入展示柜数据',
    description: '把展示柜档案导入当前存档——对应网页端 Showcase(展示)页签的「导入」下拉菜单'
      + '(导入遗器/导入角色/导入全部角色)。数据源默认取最近一次 fetch_showcase 的缓存'
      + '(可用 cacheId 校验一致性;仅保留最近一次),或经 json 内联传入同一格式的 showcase 响应(先走同一条转换链)。'
      + '执行网页端同一条导入链(importShowcaseCharacters):character/all 模式先按表单 upsert 角色再合并遗器并重新穿戴,'
      + 'relics 模式只合并遗器(verified 副词条覆盖匹配到的旧遗器、全新遗器入库但不穿戴)。'
      + '与网页端一致:遗器合并始终覆盖档案内全部角色的遗器,mode 只决定 upsert 哪些角色、给哪些角色重新穿戴。'
      + '网页端的菜单选择与确认交互全部收敛为 mode/characterId 参数。导入后标记存档 dirty(防抖写回),返回导入统计。',
    inputSchema: {
      mode: z.enum(['relics', 'character', 'all']).describe('导入范围:relics=仅遗器、character=单个角色(需 characterId)、all=档案内全部角色'),
      characterId: z.string().optional().describe('mode=character 时必填:要导入的角色 id(取 fetch_showcase 返回的 characterId)'),
      cacheId: z.string().optional().describe('校验用的缓存标识(fetch_showcase 返回的 cacheId);不传则直接使用最近一次缓存,不匹配时报错'),
      json: z.unknown().optional().describe('内联 showcase 原始响应({source:"enka"|"mihomo", detailInfo:{…}});传入时忽略缓存,先走同一条转换链并更新缓存'),
    },
    outputSchema: {
      mode: z.enum(['relics', 'character', 'all']),
      dataOrigin: z.enum(['inline', 'cache']),
      cacheId: z.string(),
      source: z.enum(['enka', 'mihomo']),
      uid: z.string().nullable(),
      charactersInShowcase: z.number().int(),
      relicsInShowcase: z.number().int(),
      relics: z.object({
        predictedUpdated: z.number().int(),
        predictedAdded: z.number().int(),
        storeBefore: z.number().int(),
        storeAfter: z.number().int(),
        addedDelta: z.number().int(),
        deltaMatchesPrediction: z.boolean(),
      }),
      importedCharacters: z.array(z.object({
        characterId: z.string(),
        created: z.boolean(),
        equippedCount: z.number().int(),
      })),
      charactersStoreBefore: z.number().int(),
      charactersStoreAfter: z.number().int(),
    },
  }, async ({ mode, characterId, cacheId, json }) => {
    runtimeContext.ensureMetadataReady()
    // importShowcaseCharacters → mergePartialRelics fires Message.success(i18next.t(...));
    // bootstrap the shared singleton so those strings resolve like the web app
    ensureI18nReady()
    runtimeContext.requireSave()

    let targetCharacterId: string | undefined
    if (mode !== 'character') {
      if (characterId != null) {
        throw new Error(`characterId 仅在 mode=character 时使用(当前 mode=${mode})`)
      }
    } else if (characterId == null) {
      throw new Error('mode=character 需要同时传入 characterId(取 fetch_showcase 返回的角色 id)')
    } else {
      targetCharacterId = characterId
    }

    // Data source: inline json wins over the fetch cache
    let cache: ShowcaseCache
    if (json != null) {
      if (!isRecord(json)) {
        throw new Error('json 必须是 showcase API 响应对象({source, detailInfo})')
      }
      let converted: ReturnType<typeof convertShowcaseResponse>
      try {
        converted = convertShowcaseResponse(json)
      } catch (e) {
        throw new Error(`json 转换失败:${(e as Error).message}`)
      }
      if (converted.characters.length === 0) {
        throw new Error('json 中没有任何可导入的角色(展示柜为空?)')
      }
      cache = {
        cacheId: nextCacheId(),
        uid: null,
        source: converted.source,
        fetchedAt: Date.now(),
        characters: converted.characters,
        rawCharacters: converted.rawCharacters,
        raw: json,
      }
      lastFetch = cache
    } else {
      if (lastFetch == null) {
        throw new Error('没有可用的展示柜数据:先调用 fetch_showcase,或通过 json 参数内联传入 showcase 响应')
      }
      if (cacheId != null && lastFetch.cacheId !== cacheId) {
        throw new Error(`cacheId 不匹配:期望 ${cacheId},当前缓存是 ${lastFetch.cacheId}(进程内仅保留最近一次成功拉取)`)
      }
      cache = lastFetch
    }

    const characters = cache.characters
    let selectedIndex = 0
    if (targetCharacterId != null) {
      selectedIndex = characters.findIndex((character) => character.id === targetCharacterId)
      if (selectedIndex === -1) {
        throw new Error(`角色 ${targetCharacterId} 不在这份展示柜档案中;可用角色:${characters.map((character) => character.id).join(', ')}`)
      }
    }

    const relicsToImport = characters.flatMap((character) => Object.values(character.equipped)).filter((relic): relic is Relic => relic != null)
    const predicted = predictMergeStats(relicsToImport)
    const relicsBefore = getRelics().length
    const characterIdsBefore = new Set(getCharacters().map((character) => character.id))

    // Leave the showcase tab store exactly as the browser flow would (characters
    // loaded, requested one selected), then run the web's own import controller
    useShowcaseTabStore.getState().setFetchResult(characters)
    if (targetCharacterId != null) {
      useShowcaseTabStore.getState().selectCharacter(selectedIndex)
    }
    importShowcaseCharacters(mode === 'relics' ? 'relics' : mode === 'character' ? 'singleCharacter' : 'multiCharacter')
    runtimeContext.markDirty()

    const relicsAfter = getRelics().length
    const addedDelta = relicsAfter - relicsBefore
    const importedCharacterIds = mode === 'relics'
      ? []
      : mode === 'all'
      ? characters.map((character) => character.id as string)
      : [targetCharacterId].filter((id): id is string => id != null)
    const importedCharacters = importedCharacterIds.map((id) => {
      const stored = getCharacterById(id as CharacterId)
      return {
        characterId: id,
        created: !characterIdsBefore.has(id as CharacterId),
        equippedCount: stored ? Object.values(stored.equipped).filter((relicId) => relicId != null).length : 0,
      }
    })

    return toolResult(
      {
        mode,
        dataOrigin: json != null ? 'inline' : 'cache',
        cacheId: cache.cacheId,
        source: cache.source,
        uid: cache.uid,
        charactersInShowcase: characters.length,
        relicsInShowcase: relicsToImport.length,
        relics: {
          predictedUpdated: predicted.updated,
          predictedAdded: predicted.added,
          storeBefore: relicsBefore,
          storeAfter: relicsAfter,
          addedDelta,
          deltaMatchesPrediction: addedDelta === predicted.added,
        },
        importedCharacters,
        charactersStoreBefore: characterIdsBefore.size,
        charactersStoreAfter: getCharacters().length,
      },
      `已导入展示柜(模式 ${mode},来源 ${json != null ? '内联 JSON' : `缓存 ${cache.cacheId}`},数据源 ${cache.source}`
        + `${cache.uid != null ? `,UID ${cache.uid}` : ''}):`
        + `遗器预计更新 ${predicted.updated} 件、新增 ${predicted.added} 件(库存 ${relicsBefore} → ${relicsAfter});`
        + (mode === 'relics' ? '未导入角色(仅合并遗器)' : `导入 ${importedCharacters.length} 个角色`),
    )
  })
}
