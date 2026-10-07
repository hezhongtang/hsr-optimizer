// Query domain: structured reads over the loaded inventory and character roster.
//
// Mirrors the web UI's read-only surfaces:
//   - list_characters / get_character  → Characters tab (roster + per-character detail)
//   - get_form                         → the optimizer form a character would load (Start screen input)
//   - default_form                     → a fresh default form without touching any save
//   - permutations                     → the permutation counter shown above the optimizer grid
//   - list_relics                      → inventory browser with structured filters
//
// All tools are read-only: no markDirty, no flushes. Roll info ({high, mid, low},
// addedRolls) is not stored in save files — it is recomputed by
// RelicAugmenter/RollGrader on load, so it is already present on every relic in
// the store by the time we serialize.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { applySpdPreset } from 'lib/conditionals/evaluation/applyPresets'
import { PartsArray } from 'lib/constants/constants'
import { RelicScorer } from 'lib/relics/scoring/relicScorer'
import { generateFullDefaultForm } from 'lib/simulations/utils/benchmarkForm'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  getCharacterById,
  getCharacters,
} from 'lib/stores/character/characterStore'
import { displayToInternal } from 'lib/stores/optimizerForm/optimizerFormConversions'
import {
  createDefaultRatingFilters,
  createDefaultStatFilters,
} from 'lib/stores/optimizerForm/optimizerFormDefaults'
import { computeLoadForm } from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import { useOptimizerRequestStore } from 'lib/stores/optimizerForm/useOptimizerRequestStore'
import {
  getRelicById,
  getRelics,
} from 'lib/stores/relic/relicStore'
import { getScoringMetadata } from 'lib/stores/scoring/scoringStore'
import type {
  Build,
  CharacterId,
} from 'types/character'
import type { LightConeId } from 'types/lightCone'
import type { Relic } from 'types/relic'
import { z } from 'zod'

import { runtimeContext } from '../context'
import {
  applyFormOverrides,
  constraintSuggestions,
  estimatePermutations,
  gateVerdict,
} from '../permutations'
import { serializeRelic } from '../serializers/builds'
import type { SerializedRelic } from '../serializers/builds'
import {
  annotateFormSources,
  serializeSavedBuild,
} from '../serializers/forms'
import { toolResult } from '../toolResult'
import {
  expandComboMatrix,
  spdPresetCatalog,
} from './form'

// expandCombo=true 时附带的连招矩阵形态(与 domains/form.ts 的 SerializedComboMatrix 对应)
const comboMatrixSchema = z.object({
  comboType: z.enum(['simple', 'advanced']),
  preprocessor: z.boolean(),
  version: z.string().nullable(),
  turnAbilities: z.array(z.string()),
  entities: z.array(z.object({
    sourceKey: z.string(),
    role: z.string(),
    characterId: z.string().nullable(),
    name: z.string().nullable(),
    conditionals: z.array(z.object({
      id: z.string(),
      type: z.string(),
      defaultValue: z.union([z.boolean(), z.number()]),
      activations: z.array(z.boolean()).optional(),
      partitions: z.array(z.object({ value: z.number(), activations: z.array(z.boolean()) })).optional(),
    })),
  })),
  displayedSets: z.object({ relics: z.array(z.string()), ornaments: z.array(z.string()) }),
  stateJsonBytes: z.number().int(),
})

// getScoringMetadata simulation fields → scoring config types (mirrors
// lib/scoring/scoringConfig.ts CONFIG_DISPLAY_ORDER without its i18n imports)
const SCORING_CONFIG_FIELDS = [
  ['simulation', 'dps'],
  ['supportSimulation', 'buffer'],
  ['healSimulation', 'heal'],
  ['shieldSimulation', 'shield'],
] as const

// outputSchema 形状——以各 handler 实际 return 的对象为准(serializeRelic /
// serializers/forms.ts 的序列化结果);动态载荷(原始表单、评分元数据映射)用宽松写法。
const serializedSubstatSchema = z.object({
  stat: z.string(),
  value: z.number(),
  rolls: z.object({ high: z.number(), mid: z.number(), low: z.number() }).optional(),
  addedRolls: z.number().optional(),
})

const serializedRelicSchema = z.object({
  id: z.string(),
  part: z.string(),
  set: z.string(),
  grade: z.number(),
  enhance: z.number(),
  main: z.object({ stat: z.string(), value: z.number() }),
  substats: z.array(serializedSubstatSchema),
  initialRolls: z.number(),
  verified: z.boolean(),
  equippedBy: z.string().optional(),
  weightScore: z.null(),
})

const characterSummarySchema = z.object({
  id: z.string(),
  rank: z.number(),
  name: z.string().nullable(),
  path: z.string().nullable(),
  element: z.string().nullable(),
  rarity: z.number().nullable(),
  unreleased: z.boolean(),
  equippedCount: z.number(),
  allSlotsEquipped: z.boolean(),
  savedBuilds: z.number(),
  scoringConfigTypes: z.array(z.string()),
})

const savedBuildTeammateSchema = z.object({
  characterId: z.string().nullable(),
  characterEidolon: z.number(),
  lightCone: z.string().nullable(),
  lightConeSuperimposition: z.number(),
  teamRelicSet: z.string().nullable(),
  teamOrnamentSet: z.string().nullable(),
  characterConditionals: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  lightConeConditionals: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
})

const savedBuildSchema = z.object({
  name: z.string(),
  source: z.string(),
  characterId: z.string(),
  scoringConfigType: z.string().nullable(),
  equipped: z.record(z.string(), z.string()),
  characterEidolon: z.number(),
  lightCone: z.string().nullable(),
  lightConeSuperimposition: z.number(),
  team: z.array(savedBuildTeammateSchema.nullable()),
  characterConditionals: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  lightConeConditionals: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  setConditionals: z.record(z.string(), z.unknown()).optional(),
  combo: z.object({
    type: z.string(),
    turnAbilities: z.array(z.string()),
    preprocessor: z.boolean(),
    deprioritizeBuffs: z.boolean(),
    stateJsonBytes: z.number(),
    stateJsonActions: z.number().nullable(),
  }).optional(),
})

function characterMeta(id: string) {
  return getGameMetadata().characters[id as CharacterId]
}

/** Config types this character has scoring metadata for, e.g. ["dps"]. */
function scoringConfigTypes(id: string): string[] {
  const scoringMetadata = getScoringMetadata(id as CharacterId)
  return SCORING_CONFIG_FIELDS
    .filter(([field]) => scoringMetadata[field] != null)
    .map(([, configType]) => configType)
}

function requireCharacter(characterId: string) {
  const character = getCharacterById(characterId as CharacterId)
  if (!character) {
    throw new Error(`Character ${characterId} not found. Loaded characters: ${getCharacters().map((c) => c.id).join(', ')}`)
  }
  return character
}

function equippedSlotSummary(equipped: Build | undefined) {
  const equippedCount = PartsArray.filter((part) => equipped?.[part] != null).length
  return { equippedCount, allSlotsEquipped: equippedCount === PartsArray.length }
}

function characterSummary(character: { id: CharacterId, equipped?: Build, builds?: unknown[] }, rank: number) {
  const meta = characterMeta(character.id)
  return {
    id: character.id,
    rank,
    name: meta?.name ?? null,
    path: meta?.path ?? null,
    element: meta?.element ?? null,
    rarity: meta?.rarity ?? null,
    unreleased: meta?.unreleased === true,
    ...equippedSlotSummary(character.equipped),
    savedBuilds: character.builds?.length ?? 0,
    scoringConfigTypes: scoringConfigTypes(character.id),
  }
}

export function registerQueryTools(server: McpServer): void {
  server.registerTool('list_characters', {
    title: '角色列表',
    description: '角色卡列表摘要——对应网页端 Characters(角色)页签:每个已加载角色的 id、名称、命途/属性/稀有度、'
      + '优先级 rank(列表位置,越小越优先)、装备概要(六槽已装数)、已保存配装数、可用评分配置类型(dps/buffer/heal/shield)。'
      + '支持按 path(命途,如 Destruction)与 element(属性,如 Ice)过滤,offset/limit 分页。',
    inputSchema: {
      path: z.string().optional().describe('Filter by path, e.g. "Destruction", "Harmony"'),
      element: z.string().optional().describe('Filter by element, e.g. "Ice", "Fire"'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    },
    outputSchema: {
      total: z.number().int(),
      offset: z.number().int(),
      limit: z.number().int(),
      characters: z.array(characterSummarySchema),
    },
  }, async ({ path, element, offset, limit }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const all = getCharacters()
    const matched = all
      .map((character, rank) => ({ character, rank }))
      .filter(({ character }) => {
        const meta = characterMeta(character.id)
        if (path != null && meta?.path !== path) return false
        if (element != null && meta?.element !== element) return false
        return true
      })

    const page = matched.slice(offset, offset + limit)
    return toolResult(
      {
        total: matched.length,
        offset,
        limit,
        characters: page.map(({ character, rank }) => characterSummary(character, rank)),
      },
      `${matched.length} 个角色匹配${path ? `(命途=${path})` : ''}${element ? `(属性=${element})` : ''}; `
        + `返回第 ${offset} 位起的 ${page.length} 个`,
    )
  })

  server.registerTool('get_character', {
    title: '角色详情',
    description: '单个角色的深度信息——对应网页端角色页签点开一个角色:六槽装备遗器明细(含词条与 roll 反解)、'
      + '存档中保存的原始优化表单(savedForm,原样)、已保存配装列表(名字+来源+条件快照摘要)、'
      + '以及生效评分元数据(权重/部件主词条/simulation 配置,含用户覆盖)。要规范化后的运行表单请用 get_form。',
    inputSchema: {
      characterId: z.string().describe('Character id, e.g. "1212b1" (see list_characters)'),
    },
    outputSchema: {
      character: characterSummarySchema,
      equippedSlots: z.record(
        z.string(),
        z.object({
          equippedId: z.string().nullable(),
          relic: serializedRelicSchema.nullable(),
          warning: z.string().optional(),
        }),
      ),
      savedForm: z.record(z.string(), z.unknown()).nullable(),
      hasCustomPortrait: z.boolean(),
      builds: z.array(savedBuildSchema),
      scoringMetadata: z.record(z.string(), z.unknown()),
    },
  }, async ({ characterId }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = requireCharacter(characterId)
    const rank = getCharacters().findIndex((c) => c.id === characterId)

    const equippedSlots: Record<string, { equippedId: string | null, relic: SerializedRelic | null, warning?: string }> = {}
    for (const part of PartsArray) {
      const equippedId = character.equipped?.[part] ?? null
      if (equippedId == null) {
        equippedSlots[part] = { equippedId: null, relic: null }
        continue
      }
      const relic = getRelicById(equippedId)
      equippedSlots[part] = relic == null
        ? { equippedId, relic: null, warning: `relic ${equippedId} not found in inventory (stale save?)` }
        : { equippedId, relic: serializeRelic(relic) }
    }

    return toolResult(
      {
        character: characterSummary(character, rank),
        equippedSlots,
        savedForm: character.form ?? null,
        hasCustomPortrait: character.portrait != null,
        builds: (character.builds ?? []).map(serializeSavedBuild),
        scoringMetadata: getScoringMetadata(character.id),
      },
      `${characterId}(${characterMeta(characterId)?.name ?? '?'}): `
        + `已装备 ${equippedSlotSummary(character.equipped).equippedCount}/6 槽位, `
        + `${character.builds?.length ?? 0} 个已保存配装`,
    )
  })

  server.registerTool('get_form', {
    title: '规范化优化表单',
    description: '返回角色规范化后的内部优化表单——与 optimize 实际使用的请求完全同一条路径'
      + '(存档表单 → computeLoadForm 合并条件默认值 → displayToInternal),是构造 formOverrides 的样板。'
      + '内部 minCr/minCd 等与 combatBuffs 百分比使用小数(0.5=50%);部分覆盖可显式加 format:"internal"。'
      + 'fieldSources 标注每个字段来自角色已保存表单(saved)还是默认值(default),legacyKeysDropped 列出被规范化丢弃的旧字段。'
      + '对应网页端选中角色后 Optimizer 页签加载出的表单。'
      + 'expandCombo=true 额外把 comboStateJson 展开成连招抽屉的「条件 × 技能」矩阵'
      + '(每个条件在每个技能位上的勾选与分段取值,含主角色/队友/光锥/套装各实体;update_form(combo.edits) 用同一套 target+id 定位)。',
    inputSchema: {
      characterId: z.string().describe('Character id, e.g. "1212b1"'),
      expandCombo: z.boolean().default(false).describe(
        '是否把连招状态展开为矩阵形态(网页端连招抽屉打开时显示的内容;默认 false 保持原样只给 comboStateJson 字符串)',
      ),
    },
    outputSchema: {
      characterId: z.string(),
      rank: z.number(),
      form: z.record(z.string(), z.unknown()),
      fieldSources: z.object({
        fields: z.record(z.string(), z.enum(['saved', 'default'])),
        nested: z.record(z.string(), z.record(z.string(), z.enum(['saved', 'default']))),
        legacyKeysDropped: z.array(z.string()),
        note: z.string(),
      }),
      notes: z.array(z.string()),
      combo: comboMatrixSchema.optional(),
    },
  }, async ({ characterId, expandCombo }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = requireCharacter(characterId)
    const rank = getCharacters().findIndex((c) => c.id === characterId)

    const state = computeLoadForm(character.form)
    const form = displayToInternal(state)
    // Mirror optimize's per-run overrides: rank is always synced to the live
    // roster position; resultsLimit is set per run (default 50), not from the form.
    form.rank = rank
    const fieldSources = annotateFormSources(character.form, form)

    const payload: Record<string, unknown> = {
      characterId,
      rank,
      form,
      fieldSources,
      notes: [
        'Same path optimize uses: computeLoadForm(character.form) → displayToInternal; form.rank is already synced to the live roster position (optimize re-sets it every run)',
        'optimize overrides resultsLimit per run (default 50); the form value here is the stored form default (1024 when unset)',
        'Pass this form or partial internal fields via formOverrides: flat min/max filters, teammate0/1/2 and relicSets/ornamentSets are supported; internal aliases take precedence over their display equivalents',
        'Flat percentage filters use fractions (minCr:0.5 means 50%); nested statFilters use display percentages (minCr:50 means 50%)',
        'combatBuffs percentages use fractions when format:"internal" or an internal-only key is present; otherwise display percentages. Set format:"display" to force display buff units',
        'Nested objects and teammate slots merge partial keys; arrays replace, null clears a teammate slot. characterId must match the target; rank/resultsLimit/resultMinFilter are controlled by optimize',
      ],
    }
    let summary = `${characterId} 的规范化表单:${Object.keys(form).length} 个字段 `
      + `(${Object.values(fieldSources.fields).filter((source) => source === 'saved').length} 个来自已保存表单)`

    if (expandCombo) {
      const matrix = expandComboMatrix(form)
      payload.combo = matrix
      summary += `;连招矩阵 ${matrix.entities.length} 个实体 / ${matrix.turnAbilities.length} 个技能位`
    }

    return toolResult(payload, summary)
  })

  server.registerTool('default_form', {
    title: '默认优化表单',
    description: '为任意角色生成一份全新默认表单(generateFullDefaultForm,即网页端“基准评分/默认条件”的表单构造):'
      + '条件默认值取自角色/光锥条件控制器,连招取评分元数据 simulation 配置。不依赖已加载存档——'
      + 'agent 未 load_save 也能起步;lightConeId 省略时依次回退:角色已保存表单的光锥(若有存档)→ 无光锥(光锥条件为空,附警告)。'
      + '返回值经过与 get_form 相同的规范化,可直接作 formOverrides 样板;百分比为内部小数,部分 combatBuffs 覆盖加 format:"internal"。'
      + 'spdPreset 提供速度预设变体(网页端「推荐预设」按钮族):在默认表单上套用 applySpdPreset——'
      + '条件恢复默认、套用评分元数据推荐筛选与主词条、按档位设最低速度(0=不限速,对应主按钮),'
      + '角色有模拟评分配置时优化目标为 COMBO;可用档位以返回的 availableSpdPresets 为准(与网页端下拉一致)。',
    inputSchema: {
      characterId: z.string().describe('Character id, e.g. "1212b1" (any character in game metadata, save not required)'),
      lightConeId: z.string().optional().describe('Light cone id; defaults to the character\'s saved-form light cone when a save is loaded'),
      eidolon: z.number().int().min(0).max(6).default(0).describe('Character eidolon (default 0)'),
      superimposition: z.number().int().min(1).max(5).default(1).describe('Light cone superimposition (default 1)'),
      spdPreset: z.number().min(0).optional().describe(
        '速度档位(推荐预设的最低速度,0=不限速/主按钮;合法值见不传时无需关心,传非法值会报错并列出全部档位,如 120.000 / 133.334 / 160.000)',
      ),
    },
    outputSchema: {
      characterId: z.string(),
      lightCone: z.string().nullable(),
      lightConeSource: z.enum(['provided', 'saved-form', 'none']),
      characterEidolon: z.number(),
      lightConeSuperimposition: z.number(),
      form: z.record(z.string(), z.unknown()),
      warnings: z.array(z.string()),
      appliedSpdPreset: z.number().optional(),
      availableSpdPresets: z.array(z.object({
        key: z.string(),
        label: z.string(),
        value: z.number(),
        category: z.string(),
      })).optional(),
    },
  }, async ({ characterId, lightConeId, eidolon, superimposition, spdPreset }) => {
    runtimeContext.ensureMetadataReady()

    const meta = characterMeta(characterId)
    if (!meta) {
      throw new Error(`Unknown characterId ${characterId} — not present in game metadata`)
    }

    const catalog = spdPreset != null ? spdPresetCatalog() : null
    if (spdPreset != null && catalog != null && !catalog.values.includes(spdPreset)) {
      throw new Error(`default_form: spdPreset 的值 ${spdPreset} 不是推荐预设的速度档位 — 可选: ${catalog.values.join(', ')}`)
    }

    const warnings: string[] = []
    let lightCone: string | undefined = lightConeId
    let lightConeSource: 'provided' | 'saved-form' | 'none'

    if (lightCone != null) {
      if (!(lightCone in getGameMetadata().lightCones)) {
        throw new Error(`Unknown lightConeId ${lightCone} — not present in game metadata`)
      }
      lightConeSource = 'provided'
    } else {
      const character = getCharacterById(characterId as CharacterId)
      lightCone = character?.form?.lightCone
      if (lightCone != null) {
        lightConeSource = 'saved-form'
      } else {
        lightConeSource = 'none'
        warnings.push(
          'No lightConeId provided and no loaded save carries a form for this character — '
            + 'light cone conditionals are empty; pass lightConeId for a complete default form',
        )
      }
    }

    const generatedForm = generateFullDefaultForm(
      characterId as CharacterId,
      lightCone as LightConeId,
      eidolon,
      superimposition,
    )
    let state = computeLoadForm(generatedForm)
    if (spdPreset != null) {
      // 网页端「推荐预设」按钮的等价路径:把默认表单载入请求存储后套用
      // applySpdPreset(条件恢复默认 → 评分元数据推荐 → 最低速度按档位)。
      // 请求存储在此仅作草稿,读回后无持久化副作用。
      useOptimizerRequestStore.getState().loadForm(generatedForm)
      applySpdPreset(spdPreset, characterId as CharacterId)
      state = { ...useOptimizerRequestStore.getState() }
    }
    // computeLoadForm JSON-clones maps, dropping undefined bounds. Restore the
    // complete default maps so this full template explicitly clears saved filters.
    state.statFilters = { ...createDefaultStatFilters(), ...state.statFilters }
    state.ratingFilters = { ...createDefaultRatingFilters(), ...state.ratingFilters }
    const form = displayToInternal(state)

    const payload: Record<string, unknown> = {
      characterId,
      lightCone: lightCone ?? null,
      lightConeSource,
      characterEidolon: eidolon,
      lightConeSuperimposition: superimposition,
      form,
      warnings,
    }
    if (spdPreset != null) {
      payload.appliedSpdPreset = spdPreset
      payload.availableSpdPresets = catalog!.presets
    }

    return toolResult(
      payload,
      `${characterId}(${meta.name})的默认表单,光锥 ${lightCone ?? '无'}(${lightConeSource}),`
        + `e${eidolon}/s${superimposition}`
        + (spdPreset != null ? `,已套用推荐预设 spd=${spdPreset}` : ''),
    )
  })

  server.registerTool('permutations', {
    title: '搜索空间估算',
    description: '优化前的搜索空间估算——对应网页端优化器网格上方“排列数”计数,与 optimize 的规模闸门用同一条估算路径: '
      + '各部件过滤后数量(含过滤前总量)、validPermutations(套装约束下的有效排列)、naivePermutations(槽位乘积)、'
      + '闸门判定(有效排列 > 5e7 时 optimize 默认拒绝)与收紧建议。可选 formOverrides(语义与 optimize 相同)。不执行搜索。',
    inputSchema: {
      characterId: z.string().describe('Character id, e.g. "1212b1"'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(
        'Partial overrides: display statFilters/ratingFilters/setFilters/teammates or internal get_form/default_form fields. '
          + 'Internal aliases win over display equivalents; nested objects/teammate slots merge. '
          + 'Flat percentage filters use fractions, nested statFilters use percentages. '
          + 'format:"internal"/"display" selects combatBuffs units; absent format, internal-only keys select fractions, otherwise percentages',
      ),
    },
    outputSchema: {
      characterId: z.string(),
      partCounts: z.record(z.string(), z.number()),
      partCountsBeforeFilters: z.record(z.string(), z.number()),
      validPermutations: z.number(),
      naivePermutations: z.number(),
      gate: z.object({ gate: z.number(), wouldReject: z.boolean(), reason: z.string() }),
      suggestions: z.array(z.string()),
    },
  }, async ({ characterId, formOverrides }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const character = requireCharacter(characterId)
    const rank = getCharacters().findIndex((c) => c.id === characterId)

    // Same request-building recipe as optimize (without running anything):
    // computeLoadForm → formOverrides merge → displayToInternal → rank sync
    const state = computeLoadForm(character.form)
    if (formOverrides) applyFormOverrides(state, formOverrides)
    const request = displayToInternal(state)
    request.characterId = characterId as CharacterId
    request.rank = rank

    const estimate = estimatePermutations(request)

    return toolResult(
      {
        characterId,
        partCounts: estimate.counts,
        partCountsBeforeFilters: estimate.preCounts,
        validPermutations: estimate.validPermutations,
        naivePermutations: estimate.naivePermutations,
        gate: gateVerdict(estimate),
        suggestions: constraintSuggestions(request),
      },
      `${characterId}:${estimate.validPermutations.toLocaleString()} 个有效排列 `
        + `(朴素乘积 ${estimate.naivePermutations.toLocaleString()});optimize 将`
        + `${estimate.validPermutations > 5e7 ? '拒绝(除非 force=true)' : '接受'}(闸门 5e7)`,
    )
  })

  server.registerTool('list_relics', {
    title: '遗器库存筛选',
    description: '遗器库存列表与结构化筛选——对应网页端遗器(Inventory)页签的主表格:主词条、副词条'
      + '(含 roll 反解 high/mid/low 与 addedRolls)、套装、部件、强化等级、星级、归属。'
      + '输出中的 weightScore 恒为 null:加权分仅在优化管线内部计算,主线程不维护;'
      + '存档文件可能残留网页端历史保存的 weightScore(不代表任何当前角色),不予透出。需要按角色打分用 score_relics。'
      + '所有筛选条件为 AND 组合;可按 characterId 只看某角色装备的 6 件;'
      + 'sortBy 排序对应表格列头点击(enhance/grade/initialRolls/substatCount,以及评分列 currentScore/potentialBest——后者需 scoreBy 指定评分角色),offset/limit 分页。',
    inputSchema: {
      part: z.string().optional().describe('Filter by part: Head | Hands | Body | Feet | PlanarSphere | LinkRope'),
      set: z.string().optional().describe('Filter by set name, e.g. "Hunter of Glacial Forest"'),
      mainStat: z.string().optional().describe('Filter by main stat name, e.g. "CRIT DMG"'),
      subStat: z.string().optional().describe('Keep relics having this substat, e.g. "SPD"'),
      enhance: z.number().int().min(0).max(15).optional().describe('Exact enhance level match'),
      grade: z.number().int().min(2).max(5).optional().describe('Exact grade (rarity) match'),
      equippedBy: z.string().optional().describe('Character id the relic is equipped by, or "none" for unequipped'),
      characterId: z.string().optional().describe('Only relics equipped by this character (its up-to-6 slots); errors if the character is not loaded'),
      verified: z.boolean().optional().describe('Filter by scanner-verified flag'),
      sortBy: z.enum(['enhance', 'grade', 'initialRolls', 'substatCount', 'currentScore', 'potentialBest']).optional().describe(
        'Sort the filtered list before paging, like clicking a relics-grid column header: '
          + 'enhance/grade/initialRolls/substatCount are intrinsic; currentScore(当前分)/potentialBest(最高潜力) '
          + 'are the selected-character score columns and require scoreBy (any character in game metadata, 不限已拥有——遗器页左上角的评分角色)。'
          + 'weightScore is optimizer-pipeline-internal and always null here — not sortable; per-relic score payloads use score_relics',
      ),
      scoreBy: z.string().optional().describe('Score focus character id for sortBy=currentScore|potentialBest (relics 页的评分角色,任意角色,不限已拥有)'),
      sortDir: z.enum(['asc', 'desc']).default('desc'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    outputSchema: {
      total: z.number().int(),
      offset: z.number().int(),
      limit: z.number().int(),
      sort: z.object({
        by: z.enum(['enhance', 'grade', 'initialRolls', 'substatCount', 'currentScore', 'potentialBest']),
        dir: z.enum(['asc', 'desc']),
        scoreBy: z.string().optional(),
      }).optional(),
      relics: z.array(serializedRelicSchema),
    },
  }, async (input) => {
    runtimeContext.requireSave()

    const SCORE_SORT_KEYS = ['currentScore', 'potentialBest'] as const
    if (input.sortBy != null && (SCORE_SORT_KEYS as readonly string[]).includes(input.sortBy)) {
      if (input.scoreBy == null) {
        throw new Error(
          `list_relics:sortBy=${input.sortBy} 是评分列,需要同时传 scoreBy(评分基准角色 id,任意角色不限已拥有)——或改用 enhance/grade/initialRolls/substatCount`,
        )
      }
      if (characterMeta(input.scoreBy) == null) {
        throw new Error(`list_relics:scoreBy 的角色 id ${input.scoreBy} 不在游戏元数据中`)
      }
    } else if (input.scoreBy != null) {
      throw new Error('list_relics:scoreBy 只在 sortBy=currentScore|potentialBest 时使用——请同时传对应的 sortBy')
    }

    let characterRelicIds: Set<string> | null = null
    if (input.characterId != null) {
      const character = requireCharacter(input.characterId)
      characterRelicIds = new Set(
        Object.values(character.equipped ?? {}).filter((id): id is string => id != null),
      )
    }

    const equippedFilter = input.equippedBy
    const matches = getRelics().filter((relic: Relic) => {
      if (characterRelicIds != null && !characterRelicIds.has(relic.id)) return false
      if (input.part != null && relic.part !== input.part) return false
      if (input.set != null && relic.set !== input.set) return false
      if (input.mainStat != null && relic.main.stat !== input.mainStat) return false
      if (input.subStat != null && !relic.substats.some((s) => s.stat === input.subStat)) return false
      if (input.enhance != null && relic.enhance !== input.enhance) return false
      if (input.grade != null && relic.grade !== input.grade) return false
      if (equippedFilter != null) {
        const isEquipped = relic.equippedBy != null
        if (equippedFilter === 'none' ? isEquipped : relic.equippedBy !== equippedFilter) return false
      }
      if (input.verified != null && (relic.verified === true) !== input.verified) return false
      return true
    })

    if (input.sortBy != null) {
      const sortBy = input.sortBy
      const dir = input.sortDir === 'asc' ? 1 : -1
      if (sortBy === 'currentScore' || sortBy === 'potentialBest') {
        // 遗器页表格的评分列排序:同一 RelicScorer 对过滤后的全部遗器打分(同步,快)
        const scorer = new RelicScorer()
        const scoreOf = (relic: Relic) =>
          sortBy === 'currentScore'
            ? scorer.getCurrentRelicScore(relic, input.scoreBy as never).percentScore
            : scorer.scoreRelicPotential(relic, input.scoreBy as never).bestPct
        matches.sort((a, b) => (scoreOf(a) - scoreOf(b)) * dir)
      } else if (sortBy === 'substatCount') {
        matches.sort((a, b) => (a.substats.length - b.substats.length) * dir)
      } else if (sortBy === 'initialRolls') {
        matches.sort((a, b) => ((a.initialRolls ?? 3) - (b.initialRolls ?? 3)) * dir)
      } else {
        matches.sort((a, b) => (a[sortBy] - b[sortBy]) * dir)
      }
    }

    const page = matches.slice(input.offset, input.offset + input.limit)
    return toolResult(
      {
        total: matches.length,
        offset: input.offset,
        limit: input.limit,
        ...(input.sortBy != null
          ? { sort: { by: input.sortBy, dir: input.sortDir, ...(input.scoreBy != null ? { scoreBy: input.scoreBy } : {}) } }
          : {}),
        relics: page.map(serializeRelic),
      },
      `${matches.length} 件遗器匹配${input.characterId ? `(角色 ${input.characterId})` : ''}`
        + `${
          input.sortBy != null
            ? `,按 ${input.sortBy} ${input.sortDir === 'asc' ? '升' : '降'}序${input.scoreBy != null ? `(评分角色 ${input.scoreBy})` : ''}`
            : ''
        }; `
        + `返回第 ${input.offset} 件起的 ${page.length} 件`,
    )
  })
}
