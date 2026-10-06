// Game-metadata MCP resources (plan §3.6) — read-only reference surfaces over
// the same DB metadata the web UI renders: game_data.json assembled by
// Metadata.initialize() (via runtimeContext.ensureMetadataReady), Chinese
// display names / set effect text from the gameData i18n namespace (via the
// i18n foundation's ensureI18nReady — the same i18next singleton upstream
// wrappedFixedT hits), and the Changelog tab content verbatim.
//
// Web parity:
//   - game://metadata/characters        → 角色列表摘要(角色选择器 / Metadata 页签数据底表)
//   - game://metadata/characters/{id}   → 单角色详情:80 级基础属性、行迹树、行迹加成汇总
//   - game://metadata/lightcones        → 光锥列表摘要(光锥选择器数据底表)
//   - game://metadata/lightcones/{id}   → 单光锥详情:基础属性 + S1-S5 叠影属性表
//                                          (叠影表归本资源,角色详情不含 —— 光锥数据不拆两处)
//   - game://metadata/sets              → 遗器/饰品套装表 + 中文效果文本(套装选择器 / 遗器页签)
//   - game://changelog                  → Changelog 页签原文(上游仅英文,逐字透出)
//
// Volume: list resources carry summaries only; per-entity detail goes through
// URI templates. The SDK (1.32) imposes NO server-side size cap on
// resources/read responses — its only numeric transport default is a 4 MiB
// INBOUND request-body limit for the streamable HTTP transport
// (node_modules/@modelcontextprotocol/sdk/dist/esm/server/requestBody.js:2),
// which constrains neither responses nor stdio — so sizes are self-measured:
// characters 108 × ~130B, light cones 170 × ~110B, sets 62 entries ≈ 20KB,
// changelog 53 entries ≈ 77KB serialized JSON (largest single response).
//
// 「行→配装」不另设 resource:optimize/get_results 已随行返回 builds 字段
// (每行 6 槽遗器 id),再设一个 resource 只会复制同一份缓存。
//
// Detail templates register with `list: undefined` (explicitly, as the SDK
// requires): enumerating 108 + 170 per-entity URIs into every resources/list
// would defeat the summary-list volume design — clients discover details via
// resources/templates/list and the id column of the summary resources.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import i18next from 'i18next'
import {
  getGameMetadata,
  isPreNovaflare,
} from 'lib/state/gameMetadata'
import { getChangelogContent } from 'lib/tabs/tabChangelog/changelogData'
import type { CharacterId } from 'types/character'
import type { LightConeId } from 'types/lightCone'
import type {
  DBMetadataCharacter,
  DBMetadataLightCone,
  DBMetadataSets,
} from 'types/metadata'

import { runtimeContext } from './context'
import { ensureI18nReady } from './i18n/i18nNode'

const JSON_MIME_TYPE = 'application/json'

/** gameData namespace translator (zh_CN, upstream parity: same
 * `i18next.getFixedT(null, 'gameData')` call the web UI's set selector uses).
 * English key passthrough is avoided: missing translations resolve to null. */
type GameDataT = (key: string, options?: { defaultValue?: string }) => string

function gameDataT(): GameDataT {
  // Idempotent + synchronous (inline resources) — guards against an entry
  // chunk that forgot to call it during integration wiring.
  ensureI18nReady()
  return i18next.getFixedT(null, 'gameData') as unknown as GameDataT
}

function zhText(t: GameDataT, key: string): string | null {
  const value = t(key, { defaultValue: '' })
  return value.length > 0 ? value : null
}

function jsonResource(uri: string, payload: unknown) {
  return {
    contents: [{
      uri,
      mimeType: JSON_MIME_TYPE,
      text: JSON.stringify(payload),
    }],
  }
}

function requireTemplateId(uri: URL, variable: string | string[] | undefined, kind: '角色' | '光锥'): string {
  if (typeof variable !== 'string' || variable.length === 0) {
    throw new Error(
      `资源 ${uri.toString()} 缺少 ${kind} id 路径参数,正确形态如 ${kind === '角色' ? 'game://metadata/characters/1001' : 'game://metadata/lightcones/20000'}`,
    )
  }
  return variable
}

/** Numeric id order, plain before `b1` upgraded variant (e.g. 1004 < 1004b1 < 1005). */
function characterIdSortKey(id: string): [number, number] {
  const upgraded = id.endsWith('b1')
  return [Number(upgraded ? id.slice(0, -2) : id), upgraded ? 1 : 0]
}

function compareCharacterIds(a: string, b: string): number {
  const [baseA, genA] = characterIdSortKey(a)
  const [baseB, genB] = characterIdSortKey(b)
  return baseA - baseB || genA - genB
}

function characterSummary(character: DBMetadataCharacter): Record<string, unknown> {
  const t = gameDataT()
  return {
    id: character.id,
    name: character.name,
    nameZh: zhText(t, `Characters.${character.id}.Name`),
    rarity: character.rarity,
    // Canonical English values — exactly what the MCP filters / upstream data use
    path: character.path,
    element: character.element,
    unreleased: character.unreleased === true,
    preNovaflare: isPreNovaflare(character.id),
  }
}

function lightConeSummary(lightCone: DBMetadataLightCone): Record<string, unknown> {
  const t = gameDataT()
  return {
    id: lightCone.id,
    name: lightCone.name,
    nameZh: zhText(t, `Lightcones.${lightCone.id}.Name`),
    rarity: lightCone.rarity,
    path: lightCone.path,
    unreleased: lightCone.unreleased === true,
  }
}

function characterDetail(character: DBMetadataCharacter): Record<string, unknown> {
  const t = gameDataT()
  return {
    id: character.id,
    name: character.name,
    nameZh: zhText(t, `Characters.${character.id}.Name`),
    longNameZh: zhText(t, `Characters.${character.id}.LongName`),
    rarity: character.rarity,
    path: character.path,
    element: character.element,
    unreleased: character.unreleased === true,
    preNovaflare: isPreNovaflare(character.id),
    maxSp: character.max_sp,
    // Lv80 base stats straight from game_data.json (HP/ATK/DEF/SPD/CRIT Rate/CRIT DMG)
    baseStats: character.stats,
    // Aggregated trace bonuses (stat -> total value with full tree activated)
    traceTotals: character.traces,
    // Full trace tree as the Metadata tab renders it: {id, stat, value, pre, children}
    traceTree: character.traceTree,
  }
}

/** S1..S5 → {stat: value}, the readable table Metadata.initialize() converts
 * from raw game_data property names (HPAddedRatio → HP%, …). */
function superimpositionTable(lightCone: DBMetadataLightCone): Record<string, Record<string, number>> {
  const table: Record<string, Record<string, number>> = {}
  for (const [level, stats] of Object.entries(lightCone.superimpositions)) {
    table[`S${level}`] = { ...stats }
  }
  return table
}

function lightConeDetail(lightCone: DBMetadataLightCone): Record<string, unknown> {
  const t = gameDataT()
  return {
    id: lightCone.id,
    name: lightCone.name,
    nameZh: zhText(t, `Lightcones.${lightCone.id}.Name`),
    rarity: lightCone.rarity,
    path: lightCone.path,
    unreleased: lightCone.unreleased === true,
    baseStats: lightCone.stats,
    superimpositions: superimpositionTable(lightCone),
  }
}

/** Sets have no `unreleased` flag in game_data.json (characters/light cones do). */
type SetEntryWithSkills = DBMetadataSets & { skills?: string }

const SETS_EFFECT_TEXT_NOTE = '套装效果文本以 gameData 命名空间翻译(zh_CN)与 game_data.json 结构化条目为准;'
  + '部分 2pc/4pc 效果的实际数值由 TS 条件函数实现,只能经引擎执行获得,不在本文本面 —— 文本中的数字不应视为引擎实现的数值口径。'

function setEntry(set: SetEntryWithSkills): Record<string, unknown> {
  const t = gameDataT()
  return {
    id: set.id,
    name: set.name,
    nameZh: zhText(t, `RelicSets.${set.id}.Name`),
    description2pcZh: zhText(t, `RelicSets.${set.id}.Description2pc`),
    description4pcZh: zhText(t, `RelicSets.${set.id}.Description4pc`),
    // Raw English merged 2pc+4pc text carried by game_data.json relics[].skills
    skillsEn: set.skills ?? null,
  }
}

export function registerGameResources(server: McpServer): void {
  // -- game://metadata/characters — roster summary -------------------------
  server.registerResource('characters-metadata', 'game://metadata/characters', {
    title: '角色元数据(列表)',
    description: '全角色列表摘要——对应网页端优化起始页角色选择器 / Metadata 页签的数据底表:'
      + '每个角色的 id、中文名(gameData 翻译,缺译为 null)、英文名、稀有度、命途/属性(规范英文值,与工具过滤参数一致)、'
      + 'unreleased 标记、preNovaflare(已出 b1 换代升级版的旧角色)。'
      + '单角色详情(基础属性/行迹树)读 URI 模板 game://metadata/characters/{id}。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    runtimeContext.ensureMetadataReady()
    // Widen the literal-union key type (CharacterId) so sorted string ids can index
    const characters = getGameMetadata().characters as Record<string, DBMetadataCharacter>
    const ids = Object.keys(characters).sort(compareCharacterIds)
    return jsonResource(uri.toString(), {
      count: ids.length,
      characters: ids.map((id) => characterSummary(characters[id])),
    })
  })

  // -- game://metadata/characters/{id} — per-character detail ---------------
  server.registerResource(
    'character-metadata-detail',
    new ResourceTemplate('game://metadata/characters/{id}', {
      // Explicitly unlisted: 108 detail URIs would flood every resources/list
      list: undefined,
    }),
    {
      title: '角色元数据(详情)',
      description: '单角色详情——对应网页端 Metadata 页签的角色条目:80 级基础属性(HP/ATK/DEF/SPD/暴击率/暴击伤害)、'
        + '行迹树完整结构(id/stat/value/pre/children)、行迹加成汇总(满行迹合计)、max_sp、unreleased 与 preNovaflare 标记、'
        + '中文名/长名。光锥叠影表不在角色详情里,读 game://metadata/lightcones/{id}。',
      mimeType: JSON_MIME_TYPE,
    },
    (uri, variables) => {
      runtimeContext.ensureMetadataReady()
      const id = requireTemplateId(uri, variables.id, '角色')
      const character = getGameMetadata().characters[id as CharacterId]
      if (!character) {
        throw new Error(`未知角色 id:${id}。可读 game://metadata/characters 获取全部有效 id(含 1004b1 等 b1 换代变体)`)
      }
      return jsonResource(uri.toString(), characterDetail(character))
    },
  )

  // -- game://metadata/lightcones — light cone summary ----------------------
  server.registerResource('lightcones-metadata', 'game://metadata/lightcones', {
    title: '光锥元数据(列表)',
    description: '全光锥列表摘要——对应网页端光锥选择器的数据底表:每张光锥的 id、中文名(gameData 翻译,缺译为 null)、'
      + '英文名、稀有度、命途、unreleased 标记。单光锥详情(基础属性/S1-S5 叠影表)读 URI 模板 game://metadata/lightcones/{id}。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    runtimeContext.ensureMetadataReady()
    // Widen the literal-union key type (LightConeId) so sorted string ids can index
    const lightCones = getGameMetadata().lightCones as Record<string, DBMetadataLightCone>
    const ids = Object.keys(lightCones).sort((a, b) => Number(a) - Number(b))
    return jsonResource(uri.toString(), {
      count: ids.length,
      lightCones: ids.map((id) => lightConeSummary(lightCones[id])),
    })
  })

  // -- game://metadata/lightcones/{id} — per-light-cone detail --------------
  server.registerResource(
    'light-cone-metadata-detail',
    new ResourceTemplate('game://metadata/lightcones/{id}', {
      list: undefined,
    }),
    {
      title: '光锥元数据(详情)',
      description: '单光锥详情——对应网页端光锥详情数据:基础属性(80 级 HP/ATK/DEF)、S1-S5 叠影属性表'
        + '(Metadata.initialize 转换后的可读属性名口径)、命途、稀有度、unreleased 标记、中文名。',
      mimeType: JSON_MIME_TYPE,
    },
    (uri, variables) => {
      runtimeContext.ensureMetadataReady()
      const id = requireTemplateId(uri, variables.id, '光锥')
      const lightCone = getGameMetadata().lightCones[id as LightConeId]
      if (!lightCone) {
        throw new Error(`未知光锥 id:${id}。可读 game://metadata/lightcones 获取全部有效 id`)
      }
      return jsonResource(uri.toString(), lightConeDetail(lightCone))
    },
  )

  // -- game://metadata/sets — relic/ornament set table ----------------------
  server.registerResource('sets-metadata', 'game://metadata/sets', {
    title: '遗器套装元数据',
    description: '全部遗器/饰品套装表(62 项)——对应网页端优化器套装选择器与遗器页签的套装效果:'
      + '每套的 id、中文名、2pc/4pc 中文效果文本(gameData 翻译)、game_data.json 携带的英文合并文本。'
      + '口径说明:效果文本以翻译与结构化条目为准,由 TS 条件函数实现的实际数值只能经引擎执行获得(见响应内 note 字段)。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    runtimeContext.ensureMetadataReady()
    const relicSets = getGameMetadata().relics.relicSets as Record<string, SetEntryWithSkills>
    const ids = Object.keys(relicSets).sort((a, b) => Number(a) - Number(b))
    return jsonResource(uri.toString(), {
      count: ids.length,
      note: SETS_EFFECT_TEXT_NOTE,
      sets: ids.map((id) => setEntry(relicSets[id])),
    })
  })

  // -- game://changelog — Changelog tab, verbatim ---------------------------
  server.registerResource('changelog', 'game://changelog', {
    title: '更新日志',
    description: '网页端 Changelog 页签的更新日志原文(上游仅提供英文,含个别图片资源文件名条目;'
      + '首条为当前数据版本号)。全量 53 期,约 77KB JSON。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    const entries = getChangelogContent()
    return jsonResource(uri.toString(), {
      count: entries.length,
      entries,
    })
  })
}
