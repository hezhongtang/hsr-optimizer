// Game-metadata MCP resources (plan §3.6) — read-only reference surfaces over
// the same DB metadata the web UI renders: game_data.json assembled by
// Metadata.initialize() (via runtimeContext.ensureMetadataReady), Chinese
// display names / set effect text from the gameData i18n namespace (via the
// i18n foundation's ensureI18nReady — the same i18next singleton upstream
// wrappedFixedT hits), and the Changelog tab content verbatim.
//
// Web parity:
//   - game://metadata/characters        → 角色列表摘要(角色选择器 / Metadata 页签数据底表)
//                                          选择器对拍字段:nameZhLong(弹窗显示/搜索名)、
//                                          hasSimulation(withSimulation 过滤=基准生成器弹窗集合)、
//                                          signatureLightCone(光锥弹窗 signatureId 正查)
//   - game://metadata/characters/{id}   → 单角色详情:80 级基础属性、行迹树、行迹加成汇总
//   - game://metadata/lightcones        → 光锥列表摘要(光锥选择器数据底表)
//   - game://metadata/lightcones/{id}   → 单光锥详情:基础属性 + S1-S5 叠影属性表
//                                          (叠影表归本资源,角色详情不含 —— 光锥数据不拆两处)
//                                          + signatureOf(专属光锥反查)
//   - game://metadata/sets              → 遗器/饰品套装表 + 中文效果文本(套装选择器 / 遗器页签)
//   - game://changelog                  → Changelog 页签原文(上游仅英文,逐字透出)
//
// Volume: list resources carry summaries only; per-entity detail goes through
// URI templates. The SDK (1.32) imposes NO server-side size cap on
// resources/read responses — its only numeric transport default is a 4 MiB
// INBOUND request-body limit for the streamable HTTP transport
// (node_modules/@modelcontextprotocol/sdk/dist/esm/server/requestBody.js:2),
// which constrains neither responses nor stdio — so sizes are self-measured:
// characters 108 × ~200B (selector-parity fields included), light cones
// 170 × ~110B, sets 62 entries ≈ 20KB, changelog 53 entries ≈ 77KB
// serialized JSON (largest single response).
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
import { getCharacterConfig } from 'lib/conditionals/resolver/characterConfigRegistry'
import {
  CURRENT_DATA_VERSION,
  CURRENT_OPTIMIZER_VERSION,
  officialOnly,
  Stats,
} from 'lib/constants/constants'
import {
  KelzScannerConfig,
  ReliquaryArchiverConfig,
} from 'lib/importer/importConfig'
import { toTurnAbility } from 'lib/optimization/rotation/turnAbilityConfig'
import {
  getGameMetadata,
  isPreNovaflare,
} from 'lib/state/gameMetadata'
import {
  AppPages,
  BASE_PATH,
  PageToHash,
} from 'lib/tabs/navigation/constants'
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
    // 角色选择弹窗的显示/搜索名(optionGenerator.ts generateCharacterOptions:
    // label = t(`Characters.{id}.LongName`))——列表层直接给出,不再只留在详情里
    nameZhLong: zhText(t, `Characters.${character.id}.LongName`),
    rarity: character.rarity,
    // Canonical English values — exactly what the MCP filters / upstream data use
    path: character.path,
    element: character.element,
    unreleased: character.unreleased === true,
    preNovaflare: isPreNovaflare(character.id),
    // CharacterSelect 的 withSimulation 过滤(CharacterSelect.tsx:70):基准生成器/
    // 套装基准审计弹窗只列 scoringMetadata.simulation(输出类模拟评分)非空的角色
    hasSimulation: character.scoringMetadata?.simulation != null,
    // 光锥选择弹窗的 signatureId(LightConeSelect.tsx:116-119):getCharacterConfig(id)
    // .defaultLightCone ——该角色的专属光锥(网页端五星专属排在最前并有专属样式)
    signatureLightCone: getCharacterConfig(character.id as CharacterId)?.defaultLightCone ?? null,
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
    // 光锥选择弹窗的 signatureId 同款正查(见 characterSummary 注释)
    signatureLightCone: getCharacterConfig(character.id as CharacterId)?.defaultLightCone ?? null,
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
    // 反查(LightConeSelect 的 signatureId 反向):哪些角色的专属光锥
    // (getCharacterConfig(id).defaultLightCone,五星专属在弹窗里排最前)是这把
    signatureOf: signatureOwners(lightCone.id),
    baseStats: lightCone.stats,
    superimpositions: superimpositionTable(lightCone),
  }
}

/** lightConeId → 以它为专属光锥的角色 id(编号序,换代变体按 plain-then-b1)。 */
function signatureOwners(lightConeId: string): string[] {
  const characters = getGameMetadata().characters as Record<string, DBMetadataCharacter>
  return Object.keys(characters)
    .filter((id) => getCharacterConfig(id as CharacterId)?.defaultLightCone === lightConeId)
    .sort(compareCharacterIds)
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
      + '每个角色的 id、中文名与中文长名(gameData 翻译,缺译为 null;长名即角色选择弹窗的显示/搜索名)、'
      + '英文名、稀有度、命途/属性(规范英文值,与工具过滤参数一致)、unreleased 标记、'
      + 'preNovaflare(已出 b1 换代升级版的旧角色)、hasSimulation(是否有输出类模拟评分配置——'
      + '基准生成器/套装基准审计的角色选择弹窗只列 true 的角色)、signatureLightCone(该角色的专属光锥 id,'
      + '即光锥选择弹窗里五星专属排最前的那把;无则为 null)。'
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
        + '中文名/长名、signatureLightCone(专属光锥 id,光锥选择弹窗的 signatureId 同款)。'
        + '光锥叠影表不在角色详情里,读 game://metadata/lightcones/{id}。',
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
        + '(Metadata.initialize 转换后的可读属性名口径)、命途、稀有度、unreleased 标记、中文名、'
        + 'signatureOf(以这把为专属光锥的角色 id 反查,光锥选择弹窗 signatureId 的反向)。',
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

  // -- site:// resources (M7 任务 A,站点导航/外链/能力面) -------------------
  registerSiteResources(server)
}

// ═══ site:// resources (M7 agent A) ═════════════════════════════════════════
//
// 站点自身的导航与外链面——内容全部从上游真实来源核对:
//   - site://pages        → 页面清单(AppPages/PageToHash 13 页,hash 路由)
//   - site://links        → 首页社区卡 + 侧边栏链接组的真实外链 URL
//   - site://home         → 首页能力摘要(优化器版本 / 游戏数据版本 / 入口)
//   - site://help/{topic} → 导入页帮助主题(扫描器下载/评分器/HoyoLab/实时导入)

/** 任意命名空间的 zh 翻译器(zh→en 回退,与网页端一致)。命名空间是运行期
 * 字符串,i18next 的字面量联合类型在这里放不开,按工厂签名放行。 */
type FixedTFactory = (lng: null, ns: string) => unknown

function fixedT(namespace: string): GameDataT {
  ensureI18nReady()
  return (i18next.getFixedT as FixedTFactory)(null, namespace) as GameDataT
}

// site://pages — AppPages 全 13 页(src/lib/tabs/Tabs.tsx:49-63 TAB_COMPONENTS
// 同序);hash 取自 PageToHash(constants.ts:55-72),标题取自 sidebar 命名空间
// (侧边栏 MenuDrawer.tsx:261-293 的同一批 key)。
const SITE_PAGE_ORDER: Array<{ page: AppPages, titleKey: string | null, devOnly?: boolean, note?: string }> = [
  { page: AppPages.HOME, titleKey: 'Links.Home' },
  { page: AppPages.OPTIMIZER, titleKey: 'Optimization.Optimizer' },
  { page: AppPages.CHARACTERS, titleKey: 'Optimization.Characters' },
  { page: AppPages.RELICS, titleKey: 'Optimization.Relics' },
  { page: AppPages.IMPORT, titleKey: 'Optimization.Import' },
  { page: AppPages.SHOWCASE, titleKey: 'Tools.Showcase' },
  { page: AppPages.WARP, titleKey: 'Tools.WarpPlanner' },
  { page: AppPages.BENCHMARKS, titleKey: 'Tools.Benchmarks' },
  { page: AppPages.CALCULATORS, titleKey: 'Tools.Calculators', note: '双面板同页切换:#aha(AHA 速度调优)与 #ehr(效果命中计算器)' },
  { page: AppPages.LEADERBOARD, titleKey: 'Tools.Leaderboards', note: 'zh 翻译缺失,回退英文标题(网页端同行为)' },
  { page: AppPages.CHANGELOG, titleKey: 'Links.Changelog' },
  { page: AppPages.WEBGPU_TEST, titleKey: null, devOnly: true, note: '开发测试页:逐项跑 WebGPU 能力测试(无侧边栏入口)' },
  { page: AppPages.METADATA_TEST, titleKey: null, devOnly: true, note: '开发测试页:元数据/图片中心编辑器(无侧边栏入口)' },
]

// site://links — 真实 URL 逐条核对自上游源码(勿凭记忆改):
//   社区卡 HomeTab.tsx:275-308,侧边栏链接组 MenuDrawer.tsx:294-299,
//   页眉 LayoutHeader.tsx:68,Hero API 链接 HomeTab.tsx:122,贡献者 HomeTab.tsx:328-330。
const SITE_LINK_GROUPS: Array<{
  group: string,
  links: Array<{ key: string, labelZh: string | null, url: string | null, internalHash?: string, note?: string }>,
}> = [
  {
    group: '首页社区卡(HomeTab CommunitySection)',
    links: [
      { key: 'discord', labelZh: 'Discord', url: 'https://discord.gg/rDmB4Un7qg' },
      { key: 'github', labelZh: 'GitHub', url: 'https://github.com/fribbels/hsr-optimizer' },
      { key: 'roadmap', labelZh: 'Roadmap', url: 'https://github.com/users/fribbels/projects/2' },
      { key: 'changelog', labelZh: '更新日志', url: null, internalHash: '#changelog', note: '站内页,非外链' },
    ],
  },
  {
    group: '侧边栏链接组(MenuDrawer Links)',
    links: [
      { key: 'kofi', labelZh: 'Ko-fi', url: 'https://ko-fi.com/fribbels' },
      { key: 'discord', labelZh: 'Discord', url: 'https://discord.gg/rDmB4Un7qg' },
      { key: 'github', labelZh: 'GitHub', url: 'https://github.com/fribbels/hsr-optimizer' },
      {
        key: officialOnly ? 'beta-site' : 'official-site',
        labelZh: officialOnly ? '测试服内容' : '无爆料',
        url: officialOnly ? 'https://fribbels.github.io/hsr-optimizer/' : 'https://starrailoptimizer.github.io/',
        note: `按上游 officialOnly=${String(officialOnly)} 常量(constants.ts:446)取当前生效的一条`,
      },
    ],
  },
  {
    group: '页眉与首页其他外链',
    links: [
      { key: 'header-discord', labelZh: 'Discord(页眉图标)', url: 'https://discord.gg/rDmB4Un7qg' },
      { key: 'enka', labelZh: 'Enka.Network(UID 搜索条 API 说明)', url: 'https://enka.network/?hsr' },
      {
        key: 'contributors',
        labelZh: '贡献者页面',
        url: 'https://github.com/fribbels/hsr-optimizer/graphs/contributors',
        note: '首页贡献者图片来自 contrib.rocks(https://contrib.rocks/image?repo=fribbels/hsr-optimizer&columns=10&anon=1)',
      },
    ],
  },
]

// site://help/{topic} — 导入页(ScannerImportSubmenu.tsx)帮助链接的真实清单。
// URL 直接取自上游常量(ReliquaryArchiverConfig/KelzScannerConfig,importConfig.ts)
// 或源码字面量(文件:行标注);描述文本取 importSaveTab 命名空间翻译。
const SITE_HELP_TOPICS: Array<{
  topic: string,
  url: string | null,
  internalHash?: string,
  titleKey: string,
  bullets: string[],
  source: string,
}> = [
  {
    topic: 'reliquary',
    url: ReliquaryArchiverConfig.releases,
    titleKey: 'Import.Stage1.ReliquaryDesc.Title',
    bullets: ['Import.Stage1.ReliquaryDesc.l1', 'Import.Stage1.ReliquaryDesc.l2', 'Import.Stage1.ReliquaryDesc.l3'],
    source: 'ReliquaryArchiverConfig.releases(importConfig.ts:31);描述块 ReliquaryDescription.tsx',
  },
  {
    topic: 'kelz',
    url: KelzScannerConfig.releases,
    titleKey: 'Import.Stage1.KelzDesc.Title',
    bullets: ['Import.Stage1.KelzDesc.l1', 'Import.Stage1.KelzDesc.l2'],
    source: 'KelzScannerConfig.releases(importConfig.ts:19)',
  },
  {
    topic: 'scorer',
    url: null,
    internalHash: '#showcase',
    titleKey: 'Import.Stage1.ScorerDesc.Title',
    bullets: ['Import.Stage1.ScorerDesc.l1', 'Import.Stage1.ScorerDesc.l2'],
    source: 'ScannerImportSubmenu.tsx:240(站内跳转展示页,非外链)',
  },
  {
    topic: 'hoyolab',
    url: 'https://github.com/fribbels/hsr-optimizer/discussions/403',
    titleKey: 'Import.Stage1.HoyolabDesc.Title',
    bullets: ['Import.Stage1.HoyolabDesc.l1', 'Import.Stage1.HoyolabDesc.l2'],
    source: 'ScannerImportSubmenu.tsx:252',
  },
  {
    topic: 'live-import',
    url: 'https://github.com/fribbels/hsr-optimizer/blob/main/docs/guides/en/live-import.md',
    titleKey: 'Import.LiveImport.Title',
    bullets: ['Import.LiveImport.Description.l1', 'Import.LiveImport.Description.l2'],
    source: 'ScannerImportSubmenu.tsx:332',
  },
]

function registerSiteResources(server: McpServer): void {
  const sidebar = fixedT('sidebar')

  // -- site://pages — 页面清单(hash 路由) ----------------------------------
  server.registerResource('site-pages', 'site://pages', {
    title: '站点页面清单',
    description: '网页端全部 13 个页面的路由清单(AppPages 全集,来源 src/lib/tabs/navigation/constants.ts '
      + 'PageToHash;与 Tabs.tsx 挂载顺序一致):每页的 page 枚举值(render 工具 page 参数即用此值)、'
      + 'hash 路由(浏览器任务里 goto 传这个 hash)、中文标题(sidebar 命名空间翻译,zh 缺译回退英文)、'
      + '别名 hash 与开发测试页标记。给人用的 URL 形态:部署地址 + ' + BASE_PATH + ' + hash,'
      + '如 https://fribbels.github.io/hsr-optimizer#main。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    const pages = SITE_PAGE_ORDER.map(({ page, titleKey, devOnly, note }) => {
      const hash = PageToHash[page]
      return {
        page,
        hash,
        nameZh: titleKey != null ? zhText(sidebar, titleKey) : null,
        renderPage: page,
        urlForm: `${BASE_PATH}${hash}`,
        devOnly: devOnly === true,
        ...(note != null ? { note } : {}),
      }
    })
    return jsonResource(uri.toString(), {
      count: pages.length,
      basePath: BASE_PATH,
      aliasHashes: {
        '#ehr': 'CALCULATORS 同页第二面板(效果命中计算器)',
        '#teams': 'CHARACTERS 页的队伍展示锚点(HashToPage 归一到角色页)',
      },
      note: 'MCP 浏览器任务用 hash 列 goto;render 工具的 page 参数用 page 列(值相同)。',
      pages,
    })
  })

  // -- site://links — 站点外链 -----------------------------------------------
  server.registerResource('site-links', 'site://links', {
    title: '站点外链清单',
    description: '首页社区卡、侧边栏链接组、页眉与 UID 搜索条等处出现的全部真实外链 URL'
      + '(逐条核对自 HomeTab.tsx / MenuDrawer.tsx / LayoutHeader.tsx 源码,响应内注明出处);'
      + '站内跳转(changelog 卡、评分器入口)以 internalHash 标注而非外链。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    const groups = SITE_LINK_GROUPS.map((group) => ({
      group: group.group,
      links: group.links,
    }))
    return jsonResource(uri.toString(), {
      count: groups.reduce((sum, g) => sum + g.links.length, 0),
      groups,
    })
  })

  // -- site://home — 首页能力清单 --------------------------------------------
  server.registerResource('site-home', 'site://home', {
    title: '首页能力摘要',
    description: '网页端首页(能力总览)的元信息:优化器版本与游戏数据版本(取自上游 constants,'
      + '与更新日志首条一致)、全部页面能力入口摘要(一页一行)、以及 MCP 侧浏览器能力'
      + '(render 截图等)的就绪查询方式(get_runtime_capabilities action=status)。',
    mimeType: JSON_MIME_TYPE,
  }, (uri) => {
    return jsonResource(uri.toString(), {
      optimizerVersion: CURRENT_OPTIMIZER_VERSION,
      dataVersion: CURRENT_DATA_VERSION,
      titleZh: 'Fribbels 星穹铁道优化器',
      entries: SITE_PAGE_ORDER
        .filter(({ devOnly }) => devOnly !== true)
        .map(({ page, titleKey }) => ({
          page,
          hash: PageToHash[page],
          nameZh: titleKey != null ? zhText(sidebar, titleKey) : null,
        })),
      mcpBrowserNote: '渲染/截图等浏览器能力用 get_runtime_capabilities(action=status)查询就绪状态;site://pages 给全部页面路由。',
    })
  })

  // -- site://help/{topic} — 导入帮助主题 ------------------------------------
  server.registerResource(
    'site-help-topic',
    new ResourceTemplate('site://help/{topic}', {
      list: undefined,
    }),
    {
      title: '导入帮助主题',
      description: '网页端「导入 / 保存」页帮助区的主题清单与真实链接:'
        + 'reliquary(IceDynamix Reliquary Archiver,推荐)/ kelz(Kel-Z HSR Scanner)/'
        + ' scorer(遗器评分器,站内展示页)/ hoyolab(HoyoLab 导入步骤)/ live-import(实时导入指南)。'
        + '每条带 URL(或站内 hash)、中文标题与要点(上游 importSaveTab 翻译)及源码出处。',
      mimeType: JSON_MIME_TYPE,
    },
    (uri, variables) => {
      const topic = typeof variables.topic === 'string' ? variables.topic : ''
      const entry = SITE_HELP_TOPICS.find((t) => t.topic === topic)
      if (entry == null) {
        throw new Error(
          `未知的帮助主题:${topic || '(空)'}。可用主题:${SITE_HELP_TOPICS.map((t) => t.topic).join(' / ')}`,
        )
      }
      const t = fixedT('importSaveTab')
      return jsonResource(uri.toString(), {
        topic: entry.topic,
        titleZh: zhText(t, entry.titleKey),
        url: entry.url,
        ...(entry.internalHash != null ? { internalHash: entry.internalHash } : {}),
        points: entry.bullets.map((key) => zhText(t, key)).filter((v): v is string => v != null),
        source: entry.source,
        allTopics: SITE_HELP_TOPICS.map((x) => x.topic),
      })
    },
  )
}
