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
import { Stats } from 'lib/constants/constants'
import { toTurnAbility } from 'lib/optimization/rotation/turnAbilityConfig'
import {
  getGameMetadata,
  isPreNovaflare,
} from 'lib/state/gameMetadata'
import { getChangelogContent } from 'lib/tabs/tabChangelog/changelogData'
import { toI18NVisual } from 'lib/utils/displayUtils'
import type { CharacterId } from 'types/character'
import type { LightConeId } from 'types/lightCone'
import type {
  DBMetadataCharacter,
  DBMetadataLightCone,
  DBMetadataSets,
} from 'types/metadata'

import { runtimeContext } from './context'
import { ensureI18nReady } from './i18n/i18nNode'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

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

// ── game://metadata/scoring panel builders (Metadata 页签六个评分面板) ──────

/** SubstatWeightDashboard 的九列:百分比类副词条(固定值不在网页表内)。 */
const WEIGHT_DASHBOARD_STATS = [
  Stats.ATK_P,
  Stats.DEF_P,
  Stats.HP_P,
  Stats.SPD,
  Stats.CR,
  Stats.CD,
  Stats.EHR,
  Stats.RES,
  Stats.BE,
] as const

const LEADERBOARD_CONFIG_SECTIONS = [
  ['dps', 'simulation'],
  ['buffer', 'supportSimulation'],
  ['heal', 'healSimulation'],
  ['shield', 'shieldSimulation'],
] as const

/** optimizerTab/ComboFilter 前缀翻译器(formatComboAction 的 t,离线 zh_CN)。 */
function comboFilterT(): Any {
  ensureI18nReady()
  return i18next.getFixedT(null, 'optimizerTab', 'ComboFilter') as Any
}

function scoringPanelEntryBase(character: DBMetadataCharacter): Record<string, unknown> {
  const t = gameDataT()
  return {
    characterId: character.id,
    name: character.name,
    nameZh: zhText(t, `Characters.${character.id}.Name`),
    path: character.path,
    element: character.element,
    rarity: character.rarity,
  }
}

/**
 * game://metadata/scoring 的载荷:Metadata 页签「Substat weight / Simulation
 * sets / Simulation teams / Simulation combo / Conditional set presets /
 * Leaderboard teams」六个面板的数据聚合。全部读默认 scoringMetadata
 * (getGameMetadata),不掺用户覆盖——单角色生效值走 get_scoring_metadata。
 */
function buildScoringMetadataPanel(): Record<string, unknown> {
  const characters = Object.values(getGameMetadata().characters)
    .filter((character) => character.scoringMetadata != null)
    .sort((a, b) => compareCharacterIds(a.id, b.id))

  const substatWeights: Array<Record<string, unknown>> = []
  const sets: Array<Record<string, unknown>> = []
  const teams: Array<Record<string, unknown>> = []
  const combo: Array<Record<string, unknown>> = []
  const setPresets: Array<Record<string, unknown>> = []
  const t = comboFilterT()

  for (const character of characters) {
    const scoring = character.scoringMetadata
    const base = scoringPanelEntryBase(character)

    // SubstatWeightDashboard:九种百分比类副词条的默认权重
    const weights: Record<string, number> = {}
    for (const stat of WEIGHT_DASHBOARD_STATS) {
      weights[stat] = scoring.stats?.[stat] ?? 0
    }
    substatWeights.push({ ...base, weights })

    const simulation = scoring.simulation
    if (simulation != null) {
      // SimulationEquivalentSetsDashboard:四件套与 2+2 不区分,点亮 = 套装在名单里
      const litCells = new Set<string>()
      for (const allowedSets of simulation.relicSets ?? []) {
        for (const set of allowedSets) litCells.add(set)
      }
      for (const set of simulation.ornamentSets ?? []) litCells.add(set)
      sets.push({
        ...base,
        relicSets: simulation.relicSets ?? [],
        ornamentSets: simulation.ornamentSets ?? [],
        setNames: [...litCells],
      })

      // SimulationTeamDashboard:默认队伍三名队友及光锥
      teams.push({
        ...base,
        teammates: (simulation.teammates ?? []).map((teammate) => ({
          characterId: teammate.characterId,
          lightCone: teammate.lightCone,
          characterEidolon: teammate.characterEidolon,
          lightConeSuperimposition: teammate.lightConeSuperimposition,
          ...(teammate.teamRelicSet != null ? { teamRelicSet: teammate.teamRelicSet } : {}),
          ...(teammate.teamOrnamentSet != null ? { teamOrnamentSet: teammate.teamOrnamentSet } : {}),
        })),
      })

      // SimulationComboDashboard:内部代号 + 可读名称,空行动不显示
      const abilities = (simulation.comboTurnAbilities ?? []).filter((action) => typeof action === 'string' && action.length > 0)
      combo.push({
        ...base,
        comboTurnAbilities: abilities,
        comboNames: abilities.map((action) => toI18NVisual(toTurnAbility(action), t)),
      })
    }

    // ConditionalSetsPresetsDashboard:预设名/套装/预设值(⚪=true,数值型为具体数字)
    const presets = (scoring.presets ?? []).map((preset) => ({
      name: preset.name,
      set: preset.set,
      value: preset.value,
    }))
    if (presets.length > 0) setPresets.push({ ...base, presets })
  }

  // LeaderboardTeamsDashboard:四节按评分类型,只列五星角色,按角色编号排序;
  // 没有专门配置排行榜队伍的角色给默认队伍行(usesDefaultTeam=true,半透明那行)
  const leaderboardTeams: Record<string, Array<Record<string, unknown>>> = {}
  const fiveStars = characters.filter((character) => character.rarity === 5)
  for (const [sectionKey, metadataField] of LEADERBOARD_CONFIG_SECTIONS) {
    const section = fiveStars
      .filter((character) => (character.scoringMetadata as Record<string, unknown>)[metadataField] != null)
      .map((character) => {
        const sim = (character.scoringMetadata as Record<string, Any>)[metadataField]
        const registered = (sim.leaderboardTeams ?? []) as Array<{
          teammates: Array<{ characterId: string, lightCones: string[], teamRelicSet?: string, teamOrnamentSet?: string }>,
          deprioritizeBuffs?: boolean,
        }>
        return {
          ...scoringPanelEntryBase(character),
          usesDefaultTeam: registered.length === 0,
          teams: registered.map((team) => ({
            teammates: team.teammates.map((teammate) => ({
              characterId: teammate.characterId,
              lightCones: [...teammate.lightCones],
              ...(teammate.teamRelicSet != null ? { teamRelicSet: teammate.teamRelicSet } : {}),
              ...(teammate.teamOrnamentSet != null ? { teamOrnamentSet: teammate.teamOrnamentSet } : {}),
            })),
            ...(team.deprioritizeBuffs === true ? { deprioritizeBuffs: true } : {}),
          })),
          defaultTeammates: (sim.teammates ?? []).map((teammate: Any) => teammate.characterId as string),
        }
      })
    if (section.length > 0) leaderboardTeams[sectionKey] = section
  }

  return {
    characterCount: characters.length,
    note: '全部为随版本发布的默认配置(游戏元数据),不反映本地存档的用户覆盖;单角色生效值请用 get_scoring_metadata 工具。'
      + 'sets/teams/combo 各条带 path 字段,按命途过滤即得网页端的九张分表。',
    substatWeights,
    sets,
    teams,
    combo,
    setPresets,
    leaderboardTeams,
  }
}

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

  // -- game://metadata/scoring — Metadata tab scoring dashboards -------------
  server.registerResource('scoring-metadata', 'game://metadata/scoring', {
    title: '评分元数据总表',
    description: '网页端 Metadata 页签六个评分面板的聚合只读表(全部来自随版本发布的默认配置,与本地存档/用户覆盖无关):'
      + 'substatWeights 各角色的默认副词条权重(九种百分比类副词条,固定值不在网页表内);'
      + 'sets 各输出类评分角色的推荐遗器/饰品套装(relicSets 原始名单 + setNames 点亮格子的并集,四件套与 2+2 不区分);'
      + 'teams 各角色的评分默认队伍(三名队友及光锥);'
      + 'combo 各角色的评分默认循环(comboTurnAbilities 内部代号 + comboNames 可读名称,空行动不显示);'
      + 'setPresets 各角色的套装条件预设(预设名/套装/预设值——决定默认表单里相关套装效果按什么状态计算);'
      + 'leaderboardTeams 排行榜参评队伍配置(按 dps/buffer/heal/shield 四节,只列五星角色;'
      + '没有专门配置的角色给 usesDefaultTeam=true 与默认队伍)。'
      + 'sets/teams/combo 三节每条带 path(网页端按命途分成九张表,过滤 path 即得)。'
      + '不载入存档即可读;单角色的用户覆盖后生效值用 get_scoring_metadata。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    runtimeContext.ensureMetadataReady()
    return jsonResource(uri.toString(), buildScoringMetadataPanel())
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
