// Equipment domain: equipping relics, character lifecycle, saved builds and
// per-character scoring overrides — the mutation surface of the web UI.
//
// Every tool maps onto the same upstream code path the browser uses
// (equipmentService / characterStore / buildConverter / scoringStore) and ends
// with runtimeContext.markDirty() so the debounced flush persists the change
// back to the loaded save file.
//
// equip_build honors the global RelicEquippingBehavior setting (Replace/Swap):
//   - Replace: a relic taken from another character leaves that slot empty
//   - Swap:    the displaced relic moves to the character the new relic came from
// (forceSwap=true promotes Replace→Swap for this call; upstream cannot force
// the other direction). The response always states which behavior applied and
// lists every ownership change as structured `changes`.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  resolveShowcaseScoringOrder,
  resolveShowcaseScoringType,
} from 'lib/characterPreview/scoring/showcaseScoringOrder'
import { getCharacterConfig } from 'lib/conditionals/resolver/characterConfigRegistry'
import {
  CUSTOM_TEAM,
  DEFAULT_TEAM,
  MainStatPartsArray,
  SubStats,
} from 'lib/constants/constants'
import { SettingOptions } from 'lib/constants/settingsConstants'
import {
  CONFIG_DISPLAY_ORDER,
  configTypeForScoringType,
  SCORING_CONFIG_REGISTRY,
} from 'lib/scoring/scoringConfig'
import {
  serializeFromCharacterTab,
  serializeFromOptimizer,
} from 'lib/services/buildConverter'
import * as equipmentService from 'lib/services/equipmentService'
import { upsertCharacterFromForm } from 'lib/services/persistenceService'
import {
  resolveSimulationMetadata,
} from 'lib/simulations/orchestrator/runDpsScoreBenchmarkOrchestrator'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { useGlobalStore } from 'lib/stores/app/appStore'
import {
  getCharacterById,
  getCharacters,
  useCharacterStore,
} from 'lib/stores/character/characterStore'
import { displayToInternal } from 'lib/stores/optimizerForm/optimizerFormConversions'
import type { OptimizerRequestState } from 'lib/stores/optimizerForm/optimizerFormTypes'
import { getRelicById } from 'lib/stores/relic/relicStore'
import {
  getDefaultScoringMetadata,
  getScoringMetadata,
  useScoringStore,
} from 'lib/stores/scoring/scoringStore'
import { objectHash } from 'lib/utils/objectUtils'
import type { Character } from 'types/character'
import type { Teammate } from 'types/form'
import type { ScoringConfigType } from 'types/metadata'
import type { SavedBuild } from 'types/savedBuild'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { serializeBuild } from '../serializers/builds'
import { toolResult } from '../toolResult'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

type RelicMove = {
  relicId: string,
  part: string,
  from: string | null,
  to: string | null,
}

type CachedRowRef = { cacheId: string, rowId: number }

// outputSchema 形状——以各 handler 实际 return 的对象为准(equipment 域自带的
// serializeSavedBuild 摘要与 applyEquip 的返回结构)。
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

const serializedBuildSchema = z.object({
  relics: z.record(z.string(), serializedRelicSchema),
  conflicts: z.array(z.string()),
})

const equippingBehaviorSchema = z.object({
  globalSetting: z.enum(['Replace', 'Swap']),
  applied: z.enum(['Replace', 'Swap']),
  forcedSwap: z.boolean(),
})

const relicMoveSchema = z.object({
  relicId: z.string(),
  part: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
})

const equipOutcomeFields = {
  relicEquippingBehavior: equippingBehaviorSchema,
  changes: z.array(relicMoveSchema),
  conflicts: z.array(z.string()),
  skipped: z.array(z.object({ part: z.string(), relicId: z.string() })),
  build: serializedBuildSchema,
}

const savedBuildSummarySchema = z.object({
  name: z.string(),
  source: z.enum(['character', 'optimizer']),
  characterId: z.string(),
  lightCone: z.string().optional(),
  lightConeSuperimposition: z.number(),
  characterEidolon: z.number(),
  scoringConfigType: z.string().optional(),
  equipped: z.record(z.string(), z.string()),
  team: z.array(z.string().nullable()),
})

function requireCharacter(characterId: string): Character {
  const character = getCharacterById(characterId as Any)
  if (!character) {
    throw new Error(`Character ${characterId} not found. Loaded characters: ${getCharacters().map((c) => c.id).join(', ')}`)
  }
  return character
}

function gameCharacterMetadata(characterId: string): unknown {
  return (getGameMetadata().characters as Record<string, unknown>)[characterId]
}

function currentOverride(characterId: string): unknown {
  return (useScoringStore.getState().scoringMetadataOverrides as Record<string, unknown>)[characterId] ?? null
}

/**
 * Resolve `{cacheId, rowId}` against the latest optimize cache → part→relicId
 * build plus the display state the run actually used (post formOverrides — the
 * snapshot source for save_build). The cache belongs to one character AND one
 * save load: a mismatching `characterId` is rejected so a cached run can never
 * be applied to a different character, and a cache stamped with an earlier
 * save generation (a `load_save` happened since) is rejected so relic ids from
 * the previous inventory are never equipped onto the new one.
 */
function resolveCachedBuild(
  fromCache: CachedRowRef,
  characterId: string,
): {
  build: Partial<Record<string, string | undefined>>,
  displayState: OptimizerRequestState,
  cacheId: string,
} {
  const cached = runtimeContext.getLastOptimizeResult()
  if (!cached) {
    throw new Error('No cached optimize results — run optimize first')
  }
  if (cached.summary.cacheId !== fromCache.cacheId) {
    throw new Error(`Unknown cacheId ${fromCache.cacheId}: the latest optimize run is ${cached.summary.cacheId} (only the most recent run is cached)`)
  }
  if (cached.generation !== runtimeContext.getSaveGeneration()) {
    throw new Error(
      `Cached optimize run ${fromCache.cacheId} belongs to a previous save load (a load_save happened after it) — `
        + 'its relic ids may collide with unrelated relics in the current inventory; re-run optimize first',
    )
  }
  if (cached.summary.characterId !== characterId) {
    throw new Error(
      `Cached optimize run ${fromCache.cacheId} belongs to character ${cached.summary.characterId}, not ${characterId} — re-run optimize for ${characterId} first`,
    )
  }
  const index = cached.rows.findIndex((row) => row.id === fromCache.rowId)
  if (index === -1) {
    throw new Error(`Row id ${fromCache.rowId} not found in ${fromCache.cacheId} (valid row ids: ${cached.rows.slice(0, 5).map((r) => r.id).join(', ')}…)`)
  }
  return { build: cached.builds[index] ?? {}, displayState: cached.displayState, cacheId: cached.summary.cacheId }
}

function globalEquippingBehavior(): 'Replace' | 'Swap' {
  const setting = useGlobalStore.getState().settings.RelicEquippingBehavior
  return setting === SettingOptions.RelicEquippingBehavior.Swap ? 'Swap' : 'Replace'
}

/**
 * Shared equip pipeline for equip_build / equip_saved_build: snapshot ownership,
 * call equipmentService.equipRelicIds (the web's equip path), then narrate every
 * ownership change and return the resulting six-slot build.
 *
 * Relics that no longer resolve in the inventory are SKIPPED, not fatal — the
 * web's equipRelicIds silently drops them (`if (relic)`); here every skipped
 * id is reported back as `skipped: [{part, relicId}]`. Equipping nothing at
 * all (every id missing) is still an error.
 */
function applyEquip(
  characterId: string,
  relicIdsByPart: Partial<Record<string, string | undefined>>,
  forceSwap?: boolean,
) {
  const character = requireCharacter(characterId)

  const requested = Object.entries(relicIdsByPart).filter((entry): entry is [string, string] => entry[1] != null)
  if (requested.length === 0) throw new Error('No relic ids to equip')
  if (requested.length > 6) throw new Error(`Expected at most 6 relic ids, got ${requested.length}`)

  const skipped: Array<{ part: string, relicId: string }> = []
  const relicIds: string[] = []
  const seenParts = new Set<string>()
  for (const [part, relicId] of requested) {
    const relic = getRelicById(relicId)
    if (!relic) {
      skipped.push({ part, relicId })
      continue
    }
    if (seenParts.has(relic.part)) throw new Error(`Two relics for the same part ${relic.part} — pass one relic per slot`)
    seenParts.add(relic.part)
    relicIds.push(relicId)
  }
  if (relicIds.length === 0) {
    throw new Error(
      `None of the requested relics were found in inventory: ${skipped.map((s) => `${s.part}=${s.relicId}`).join(', ')}`,
    )
  }

  // Pre-state: which relic sat in each touched slot, and who owned each involved relic
  const equippedBefore = character.equipped as Record<string, string | undefined>
  const beforeSlotByPart = new Map<string, string | undefined>()
  const beforeOwnerByRelic = new Map<string, string | undefined>()
  for (const part of seenParts) beforeSlotByPart.set(part, equippedBefore[part])
  for (const relicId of relicIds) {
    beforeOwnerByRelic.set(relicId, getRelicById(relicId)!.equippedBy)
    const owner = beforeOwnerByRelic.get(relicId)
    if (owner) {
      const ownerEquipped = (getCharacterById(owner as Any)?.equipped ?? {}) as Record<string, string | undefined>
      const ownerSlotRelic = ownerEquipped[getRelicById(relicId)!.part]
      if (ownerSlotRelic) beforeOwnerByRelic.set(ownerSlotRelic, getRelicById(ownerSlotRelic)?.equippedBy)
    }
  }
  for (const part of seenParts) {
    const slotRelicId = beforeSlotByPart.get(part)
    if (slotRelicId) beforeOwnerByRelic.set(slotRelicId, getRelicById(slotRelicId)?.equippedBy)
  }

  const globalBehavior = globalEquippingBehavior()
  equipmentService.equipRelicIds(relicIds as Any, characterId as Any, forceSwap === true)

  // Post-state: derive the ownership diff
  const changes: RelicMove[] = []
  const after = getCharacterById(characterId as Any)!.equipped as Record<string, string | undefined>
  for (const relicId of relicIds) {
    const relic = getRelicById(relicId)!
    const from = beforeOwnerByRelic.get(relicId) ?? null
    if (from !== characterId) {
      changes.push({ relicId, part: relic.part, from, to: characterId })
    }
  }
  for (const [part, prevRelicId] of beforeSlotByPart.entries()) {
    if (!prevRelicId) continue
    if (after[part] === prevRelicId) continue // same relic re-equipped
    const prevRelic = getRelicById(prevRelicId)
    const to = prevRelic?.equippedBy ?? null
    const from = beforeOwnerByRelic.get(prevRelicId) ?? null
    if (to !== from) changes.push({ relicId: prevRelicId, part, from, to })
  }

  const build = serializeBuild(after, characterId)
  const behavior = forceSwap === true || globalBehavior === 'Swap' ? 'Swap' : 'Replace'
  const conflicts = changes.map((c) =>
    c.to == null
      ? `${c.part}: relic ${c.relicId} unequipped from ${c.from}`
      : `${c.part}: relic ${c.relicId} moved ${c.from ?? 'inventory'} → ${c.to}`
  )

  return { character, globalBehavior, behavior, forceSwap: forceSwap === true, changes, conflicts, build, equipped: after, skipped }
}

/**
 * Resolve the scoring config type + teammates the web's character-tab
 * "Save build" picks (buildService.saveBuild's non-optimizer branch):
 * showcase scoring order over the character's available simulation configs,
 * first available entry wins — NOT a hardcoded DPS. All functions in the
 * chain are pure (no UI store): the showcase tab's stored scoring preference
 * is UI state the MCP surface does not carry, so a fresh-session default
 * (scoringOrder[0]) applies.
 */
function resolveCharacterTabScoring(character: Character): {
  configType: ScoringConfigType | undefined,
  teammates: Teammate[] | undefined,
} {
  const characterId = character.id as Any
  const scoringMetadata = getScoringMetadata(characterId)
  const availableSimulationConfigs: Partial<Record<ScoringConfigType, unknown>> = {}
  for (const configType of CONFIG_DISPLAY_ORDER) {
    const metadataField = SCORING_CONFIG_REGISTRY[configType].metadataField
    if (scoringMetadata[metadataField] != null) availableSimulationConfigs[configType] = scoringMetadata[metadataField]
  }
  const scoringOrder = resolveShowcaseScoringOrder(
    getCharacterConfig(characterId)?.display.showcaseScoringOrder,
    availableSimulationConfigs,
  )
  const effectiveScoringType = resolveShowcaseScoringType(undefined, scoringOrder)
  const configType = configTypeForScoringType(effectiveScoringType)
  if (configType == null) {
    // e.g. SUBSTAT_SCORE first (Aventurine): the web saves no scoringConfigType
    return { configType: undefined, teammates: undefined }
  }

  const metadataField = SCORING_CONFIG_REGISTRY[configType].metadataField
  const sim = resolveSimulationMetadata(character, configType, resolveTeamSelection(character, metadataField))
  return { configType, teammates: sim?.teammates as Teammate[] | undefined }
}

/**
 * handleTeamSelection (characterPreviewController) with no stored showcase
 * preference: the effective selection is Custom exactly when the character's
 * effective scoring metadata carries teammates differing from the game
 * defaults, else Default (default team's teammates win, upstream semantics).
 */
function resolveTeamSelection(character: Character, metadataField: string): typeof DEFAULT_TEAM | typeof CUSTOM_TEAM {
  const defaults = (getGameMetadata().characters as Record<string, Any>)[character.id]?.scoringMetadata
  const effective = getScoringMetadata(character.id as Any)
  const field = metadataField as 'simulation' | 'supportSimulation' | 'healSimulation' | 'shieldSimulation'
  if (
    defaults?.[field]
    && effective[field]?.teammates
    && objectHash(effective[field].teammates) !== objectHash(defaults[field].teammates)
  ) {
    return CUSTOM_TEAM
  }
  return DEFAULT_TEAM
}

function serializeSavedBuild(build: SavedBuild) {
  return {
    name: build.name,
    source: build.source,
    characterId: build.characterId,
    lightCone: build.lightCone,
    lightConeSuperimposition: build.lightConeSuperimposition,
    characterEidolon: build.characterEidolon,
    ...(build.scoringConfigType != null ? { scoringConfigType: build.scoringConfigType } : {}),
    // Upstream keeps empty slots as equipped[part] = undefined with the key
    // retained (equipmentService unequip/Replace semantics, spread as-is by
    // buildConverter) — z.record(z.string(), z.string()) rejects undefined
    // values, so empty slots are dropped here (same filter as
    // serializers/forms.ts serializeSavedBuild).
    equipped: Object.fromEntries(
      Object.entries(build.equipped ?? {}).filter((entry): entry is [string, string] => entry[1] != null),
    ),
    team: build.team.map((t) => t?.characterId ?? null),
  }
}

export function registerEquipmentTools(server: McpServer): void {
  // ── equip_build ────────────────────────────────────────────────────────────
  server.registerTool('equip_build', {
    title: '装备一套遗器',
    description: '对应网页端优化结果页的「装备」按钮与角色页的遗器装备操作。把一套遗器装备到角色上,来源二选一:'
      + '`relicIds`(最多 6 个遗器 id,每部件一个)或 `fromCache`(取最近一次 optimize 缓存的某行,传 optimize 返回的 cacheId 与目标行的 row id;'
      + '缓存归属角色必须与 characterId 一致、且不得跨 load_save 使用,否则报错)。'
      + 'fromCache 分支装备前会把该次运行实际使用的表单(已合并 formOverrides)回写为角色表单——与网页端装备按钮的行为一致;'
      + 'relicIds 分支不改动角色表单。请求中库存里已不存在的遗器会被跳过并在返回的 skipped 列表列出(全部缺失才报错)。'
      + '遵守全局设置 RelicEquippingBehavior:Replace(原持有者的槽位被清空)或 Swap(被换下的遗器转给原持有者),'
      + '可用 forceSwap=true 在本次调用强制开启 Swap。返回装备后六槽遗器详情、实际生效的装备行为、每次所有权变动的 conflicts 描述、以及被跳过的缺失遗器。',
    inputSchema: {
      characterId: z.string().describe('目标角色 id,如 "1212b1"'),
      relicIds: z.array(z.string()).min(1).max(6).optional().describe('按部件给出的遗器 id 列表(与 fromCache 二选一)'),
      fromCache: z.object({
        cacheId: z.string().describe('optimize 返回的 cacheId'),
        rowId: z.number().describe('目标行的 row id(optimize 返回行中的 id 字段)'),
      }).optional().describe('从最近一次 optimize 缓存取某行的配装(与 relicIds 二选一)'),
      forceSwap: z.boolean().optional().describe('本次调用强制使用 Swap 行为(被换下的遗器转给原持有者)'),
    },
    outputSchema: {
      characterId: z.string(),
      ...equipOutcomeFields,
    },
  }, async ({ characterId, relicIds, fromCache, forceSwap }): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    if ((relicIds == null) === (fromCache == null)) {
      throw new Error('Provide exactly one of: relicIds (explicit relic ids) or fromCache (a cached optimize row)')
    }

    let buildByPart: Partial<Record<string, string | undefined>>
    if (relicIds != null) {
      // Explicit relic ids: pure inventory operation, the character form is
      // untouched (web relic-grid semantics).
      buildByPart = {}
      for (const relicId of relicIds) {
        const relic = getRelicById(relicId)
        if (!relic) throw new Error(`Relic ${relicId} not found in inventory`)
        buildByPart[relic.part] = relicId
      }
    } else {
      const cached = resolveCachedBuild(fromCache!, characterId)
      buildByPart = cached.build
      // The web's equip button persists the optimizer form before equipping
      // (optimizerFormActions.equipClicked → upsertCharacterFromForm(getForm())).
      // Mirror it with the run's cached display state (post formOverrides), so
      // the stored character form matches what was actually optimized — a
      // changed light cone / eidolon / superimposition survives the equip.
      upsertCharacterFromForm(displayToInternal(cached.displayState) as Any)
    }

    const outcome = applyEquip(characterId, buildByPart, forceSwap)
    runtimeContext.markDirty()

    return toolResult(
      {
        characterId,
        relicEquippingBehavior: {
          globalSetting: outcome.globalBehavior,
          applied: outcome.behavior,
          forcedSwap: outcome.forceSwap,
        },
        changes: outcome.changes,
        conflicts: outcome.conflicts,
        skipped: outcome.skipped,
        build: outcome.build,
      },
      `已为 ${characterId} 装备 ${Object.values(outcome.equipped).filter(Boolean).length}/6 槽位 `
        + `(行为 ${outcome.behavior}${outcome.conflicts.length ? `,${outcome.conflicts.length} 处所有权变更` : ''})`
        + (outcome.skipped.length > 0
          ? `;跳过 ${outcome.skipped.length} 件库存中不存在的遗器(${outcome.skipped.map((s) => `${s.part}=${s.relicId}`).join(', ')})`
          : ''),
    )
  })

  // ── unequip_character ──────────────────────────────────────────────────────
  server.registerTool('unequip_character', {
    title: '卸下角色全部遗器',
    description: '对应网页端角色菜单的「卸下全部遗器」(equipmentService.unequipCharacter):清空角色六槽,'
      + '所有遗器回到库存。返回被卸下的遗器 id 列表。',
    inputSchema: {
      characterId: z.string(),
    },
    outputSchema: {
      characterId: z.string(),
      unequipped: z.array(z.string()),
      clearedSlots: z.number().int(),
    },
  }, async ({ characterId }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const character = requireCharacter(characterId)

    const equippedIds = Object.values(character.equipped).filter((id): id is string => id != null)
    equipmentService.unequipCharacter(characterId as Any)
    runtimeContext.markDirty()

    return toolResult(
      {
        characterId,
        unequipped: equippedIds,
        clearedSlots: equippedIds.length,
      },
      `已从 ${characterId} 卸下 ${equippedIds.length} 件遗器`,
    )
  })

  // ── switch_relics ──────────────────────────────────────────────────────────
  server.registerTool('switch_relics', {
    title: '交换两角色的遗器',
    description: '对应网页端角色菜单的「交换遗器」(equipmentService.switchRelics):把两个角色身上的遗器整套互换。'
      + '返回交换后双方的六槽遗器。',
    inputSchema: {
      characterIdA: z.string(),
      characterIdB: z.string(),
    },
    outputSchema: {
      characterIdA: z.string(),
      characterIdB: z.string(),
      buildA: serializedBuildSchema,
      buildB: serializedBuildSchema,
    },
  }, async ({ characterIdA, characterIdB }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    if (characterIdA === characterIdB) throw new Error('Pick two different characters')
    requireCharacter(characterIdA)
    requireCharacter(characterIdB)

    equipmentService.switchRelics(characterIdA as Any, characterIdB as Any)
    runtimeContext.markDirty()

    const a = getCharacterById(characterIdA as Any)!
    const b = getCharacterById(characterIdB as Any)!
    return toolResult(
      {
        characterIdA,
        characterIdB,
        buildA: serializeBuild(a.equipped as Any, characterIdA),
        buildB: serializeBuild(b.equipped as Any, characterIdB),
      },
      `已交换 ${characterIdA} 与 ${characterIdB} 的遗器`,
    )
  })

  // ── upsert_character ───────────────────────────────────────────────────────
  server.registerTool('upsert_character', {
    title: '新建或更新角色',
    description: '对应网页端「添加角色」与角色编辑弹窗(persistenceService.upsertCharacterFromForm):'
      + '角色不存在时按上游默认链路新建(默认表单+评分权重,空装备);已存在时浅合并传入的字段。'
      + '可修改光锥/叠影/星魂/等级。新建角色的插入位置遵守全局 NewCharacterDefaultRank 设置。',
    inputSchema: {
      characterId: z.string().describe('角色 id(必须存在于游戏元数据),如 "1212b1"'),
      lightCone: z.string().optional().describe('光锥 id'),
      lightConeLevel: z.number().int().min(1).max(80).optional(),
      lightConeSuperimposition: z.number().int().min(1).max(5).optional().describe('光锥叠影 1-5'),
      characterEidolon: z.number().int().min(0).max(6).optional().describe('星魂 0-6'),
      characterLevel: z.number().int().min(1).max(80).optional(),
    },
    outputSchema: {
      characterId: z.string(),
      created: z.boolean(),
      rank: z.number(),
      form: z.object({
        lightCone: z.string().optional(),
        lightConeLevel: z.number().optional(),
        lightConeSuperimposition: z.number().optional(),
        characterEidolon: z.number().optional(),
        characterLevel: z.number().optional(),
      }),
      equippedCount: z.number().int(),
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const { characterId } = input
    if (gameCharacterMetadata(characterId) == null) {
      throw new Error(`Unknown character id ${characterId} (not present in game metadata)`)
    }
    if (input.lightCone != null && !(getGameMetadata().lightCones as Record<string, unknown>)[input.lightCone]) {
      throw new Error(`Unknown light cone id ${input.lightCone}`)
    }

    const existed = getCharacterById(characterId as Any) != null
    const patch: Record<string, unknown> = { characterId }
    if (input.lightCone != null) patch.lightCone = input.lightCone
    if (input.lightConeLevel != null) patch.lightConeLevel = input.lightConeLevel
    if (input.lightConeSuperimposition != null) patch.lightConeSuperimposition = input.lightConeSuperimposition
    if (input.characterEidolon != null) patch.characterEidolon = input.characterEidolon
    if (input.characterLevel != null) patch.characterLevel = input.characterLevel

    const character = upsertCharacterFromForm(patch as Any)
    runtimeContext.markDirty()

    return toolResult(
      {
        characterId,
        created: !existed,
        rank: getCharacters().findIndex((c) => c.id === characterId),
        form: {
          lightCone: character.form.lightCone,
          lightConeLevel: character.form.lightConeLevel,
          lightConeSuperimposition: character.form.lightConeSuperimposition,
          characterEidolon: character.form.characterEidolon,
          characterLevel: character.form.characterLevel,
        },
        equippedCount: Object.values(character.equipped).filter(Boolean).length,
      },
      `${
        existed ? '已更新' : '已新建'
      }角色 ${characterId}(光锥 ${character.form.lightCone},e${character.form.characterEidolon},s${character.form.lightConeSuperimposition})`,
    )
  })

  // ── delete_character ───────────────────────────────────────────────────────
  server.registerTool('delete_character', {
    title: '删除角色',
    description: '对应网页端角色菜单的「删除角色」(equipmentService.removeCharacter):先卸下其全部遗器再从列表移除,'
      + '遗器保留在库存中。',
    inputSchema: {
      characterId: z.string(),
    },
    outputSchema: {
      deleted: z.string(),
      freedRelics: z.number().int(),
      remainingCharacters: z.array(z.string()),
    },
  }, async ({ characterId }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const character = requireCharacter(characterId)

    const equippedIds = Object.values(character.equipped).filter((id): id is string => id != null)
    equipmentService.removeCharacter(characterId as Any)
    runtimeContext.markDirty()

    return toolResult(
      {
        deleted: characterId,
        freedRelics: equippedIds.length,
        remainingCharacters: getCharacters().map((c) => c.id),
      },
      `已删除角色 ${characterId};${equippedIds.length} 件遗器回到库存`,
    )
  })

  // ── set_character_rank ─────────────────────────────────────────────────────
  server.registerTool('set_character_rank', {
    title: '调整角色优先级',
    description: '对应网页端角色列表的拖拽排序(characterStore.insertCharacter 语义):把角色移动到指定位置。'
      + 'index 传 -1 表示移到末尾。角色顺序即优先级,影响优化器的 rank 过滤(只搜索排序不低于当前角色的遗器归属)。',
    inputSchema: {
      characterId: z.string(),
      index: z.number().int().min(-1).describe('目标位置(0 起);-1 表示移到末尾'),
    },
    outputSchema: {
      characterId: z.string(),
      index: z.number().int(),
      order: z.array(z.string()),
    },
  }, async ({ characterId, index }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    requireCharacter(characterId)

    const ids = getCharacters().map((c) => c.id as string)
    if (index > ids.length) {
      throw new Error(`index ${index} out of range (0..${ids.length - 1}, or -1 for the end)`)
    }

    useCharacterStore.getState().insertCharacter(characterId as Any, index)
    runtimeContext.markDirty()

    const order = getCharacters().map((c) => c.id)
    return toolResult(
      {
        characterId,
        index: order.indexOf(characterId as Any),
        order,
      },
      `已把 ${characterId} 移到第 ${order.indexOf(characterId as Any)} 位(共 ${order.length} 个角色)`,
    )
  })

  // ── save_build ─────────────────────────────────────────────────────────────
  server.registerTool('save_build', {
    title: '保存配装方案',
    description: '对应网页端角色页的「保存配装」:默认保存角色当前装备(Character 来源),评分配置按角色可用的模拟配置解析'
      + '(奶妈/辅助存 Heal/Support 对应值,与网页端 showcase 评分顺序一致,而非固定 DPS);'
      + '传 fromCache 时保存最近一次 optimize 的某行(Optimizer 来源,连同表单快照——快照取该次运行实际使用的表单,'
      + '即已合并 formOverrides 后的版本;缓存归属角色必须与 characterId 一致且不得跨 load_save 使用,否则报错)。'
      + '重名时默认报错,传 overwrite=true 覆盖。',
    inputSchema: {
      characterId: z.string(),
      name: z.string().min(1).describe('配装名(同角色内唯一)'),
      fromCache: z.object({
        cacheId: z.string(),
        rowId: z.number(),
      }).optional().describe('保存最近一次 optimize 的某行(默认保存当前装备)'),
      overwrite: z.boolean().optional().describe('同名配装是否覆盖'),
    },
    outputSchema: {
      characterId: z.string(),
      saved: savedBuildSummarySchema,
      totalBuilds: z.number().int(),
      overwrote: z.boolean(),
    },
  }, async ({ characterId, name, fromCache, overwrite }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const character = requireCharacter(characterId)

    let build: SavedBuild
    if (fromCache != null) {
      const { build: equipped, displayState } = resolveCachedBuild(fromCache, characterId)
      // Snapshot the display state the run actually used — the cached
      // post-formOverrides state, not the character's stored form — so the saved
      // build matches what was optimized (changed light cone / eidolon / teammates / filters).
      build = serializeFromOptimizer(
        name,
        characterId as Any,
        displayState as Any,
        equipped as Any,
      )
    } else {
      // Mirror buildService.saveBuild's character-tab branch: the scoring
      // config is resolved from the character's available simulation configs
      // (showcase order, e.g. healers → HEAL, not a hardcoded DPS), and the
      // teammates snapshot follows that config's default (or overridden) team.
      const { configType, teammates } = resolveCharacterTabScoring(character)
      build = serializeFromCharacterTab(
        name,
        character,
        teammates,
        configType,
      )
    }

    const builds = [...(character.builds ?? [])]
    const idx = builds.findIndex((x) => x.name === name)
    if (idx !== -1 && !overwrite) {
      throw new Error(`Build "${name}" already exists for ${characterId} — pass overwrite=true to replace it`)
    }
    if (idx !== -1) builds[idx] = build
    else builds.push(build)

    useCharacterStore.getState().setCharacter({ ...character, builds })
    runtimeContext.markDirty()

    return toolResult(
      {
        characterId,
        saved: serializeSavedBuild(build),
        totalBuilds: builds.length,
        overwrote: idx !== -1,
      },
      `已保存配装「${name}」(来源 ${build.source})到 ${characterId};现存 ${builds.length} 个配装`,
    )
  })

  // ── list_builds ────────────────────────────────────────────────────────────
  server.registerTool('list_builds', {
    title: '列出已保存配装',
    description: '对应网页端角色页的已保存配装列表:查看一个角色(或全部角色)的配装名、来源(角色页/优化器)、'
      + '六槽遗器 id、光锥/星魂快照与队伍成员。',
    inputSchema: {
      characterId: z.string().optional().describe('不传则返回全部角色'),
    },
    outputSchema: {
      total: z.number().int(),
      builds: z.array(savedBuildSummarySchema),
    },
  }, async ({ characterId }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const characters = characterId != null ? [requireCharacter(characterId)] : getCharacters()
    const entries = characters.flatMap((c) => (c.builds ?? []).map(serializeSavedBuild))
    return toolResult(
      {
        total: entries.length,
        builds: entries,
      },
      `${entries.length} 个已保存配装${characterId != null ? `(角色 ${characterId})` : '(全部角色)'}`,
    )
  })

  // ── delete_build ───────────────────────────────────────────────────────────
  server.registerTool('delete_build', {
    title: '删除已保存配装',
    description: '对应网页端角色页配装卡片的删除按钮(buildService.deleteBuild)。',
    inputSchema: {
      characterId: z.string(),
      name: z.string(),
    },
    outputSchema: {
      characterId: z.string(),
      deleted: z.string(),
      remaining: z.number().int(),
    },
  }, async ({ characterId, name }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const character = requireCharacter(characterId)

    const builds = character.builds ?? []
    if (!builds.some((x) => x.name === name)) {
      throw new Error(`Build "${name}" not found for ${characterId}. Saved: ${builds.map((b) => b.name).join(', ') || '(none)'}`)
    }

    useCharacterStore.getState().setCharacter({
      ...character,
      builds: builds.filter((x) => x.name !== name),
    })
    runtimeContext.markDirty()

    return toolResult(
      {
        characterId,
        deleted: name,
        remaining: builds.length - 1,
      },
      `已从 ${characterId} 删除配装「${name}」`,
    )
  })

  // ── equip_saved_build ──────────────────────────────────────────────────────
  server.registerTool('equip_saved_build', {
    title: '装备已保存配装',
    description: '对应网页端角色页配装卡片的「装备」按钮(buildService.equipBuildRelics):把已保存配装的六槽遗器'
      + '装备到该角色。装备行为与 equip_build 相同(遵守全局 Replace/Swap 设置)。',
    inputSchema: {
      characterId: z.string(),
      buildName: z.string(),
    },
    outputSchema: {
      characterId: z.string(),
      buildName: z.string(),
      ...equipOutcomeFields,
    },
  }, async ({ characterId, buildName }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const character = requireCharacter(characterId)

    const build = (character.builds ?? []).find((x) => x.name === buildName)
    if (!build) {
      throw new Error(`Build "${buildName}" not found for ${characterId}. Saved: ${(character.builds ?? []).map((b) => b.name).join(', ') || '(none)'}`)
    }

    const outcome = applyEquip(characterId, build.equipped)
    runtimeContext.markDirty()

    return toolResult(
      {
        characterId,
        buildName,
        relicEquippingBehavior: {
          globalSetting: outcome.globalBehavior,
          applied: outcome.behavior,
          forcedSwap: outcome.forceSwap,
        },
        changes: outcome.changes,
        conflicts: outcome.conflicts,
        skipped: outcome.skipped,
        build: outcome.build,
      },
      `已把配装「${buildName}」装备到 ${characterId}(行为 ${outcome.behavior})`
        + (outcome.skipped.length > 0
          ? `;跳过 ${outcome.skipped.length} 件库存中不存在的遗器(${outcome.skipped.map((s) => `${s.part}=${s.relicId}`).join(', ')})`
          : ''),
    )
  })

  // ── get_scoring_metadata ───────────────────────────────────────────────────
  server.registerTool('get_scoring_metadata', {
    title: '查询角色评分元数据',
    description: '对应网页端评分设置面板(scoringStore.getScoringMetadata 合并链):返回角色生效的评分配置'
      + '(副词条权重 stats、主词条候选 parts、四类模拟评分配置)及其来源——默认值、用户覆盖 delta、合并后的有效值。',
    inputSchema: {
      characterId: z.string(),
    },
    outputSchema: {
      characterId: z.string(),
      modified: z.boolean(),
      stats: z.record(z.string(), z.number()),
      parts: z.record(z.string(), z.array(z.string())),
      // 用户覆盖 delta——scoringStore 原样对象或 null,形状由上游决定,不收紧
      override: z.unknown(),
      defaults: z.object({
        stats: z.record(z.string(), z.number()),
        parts: z.record(z.string(), z.array(z.string())),
      }),
      simulations: z.record(z.string(), z.unknown()),
    },
  }, async ({ characterId }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    if (gameCharacterMetadata(characterId) == null) {
      throw new Error(`Unknown character id ${characterId} (not present in game metadata)`)
    }

    const effective = getScoringMetadata(characterId as Any)
    const defaults = getDefaultScoringMetadata(characterId as Any)
    const override = currentOverride(characterId)

    const simulations: Record<string, unknown> = {}
    const simulationFields = [
      ['dps', 'simulation'],
      ['support', 'supportSimulation'],
      ['heal', 'healSimulation'],
      ['shield', 'shieldSimulation'],
    ] as const
    for (const [key, field] of simulationFields) {
      if (effective[field] != null) simulations[key] = effective[field]
    }

    return toolResult(
      {
        characterId,
        modified: effective.modified === true,
        stats: effective.stats,
        parts: effective.parts,
        override,
        defaults: { stats: defaults.stats, parts: defaults.parts },
        simulations,
      },
      `${characterId} 的评分元数据${effective.modified === true ? '(已修改)' : ''}: `
        + `${Object.keys(simulations).length} 个模拟配置,覆盖 ${override ? '存在' : '无'}`,
    )
  })

  // ── set_scoring_override ───────────────────────────────────────────────────
  server.registerTool('set_scoring_override', {
    title: '设置角色评分覆盖',
    description: '对应网页端评分设置面板的保存(scoringStore.updateCharacterOverrides 的 delta 合并语义):'
      + '`weights` 只覆盖传入的副词条权重(其余保持),`parts` 只覆盖传入部件的主词条候选;与默认值相同的项会被剪掉。'
      + '`reset=true` 清空该角色全部覆盖恢复默认。影响 stat 评分与遗器潜力计算。',
    inputSchema: {
      characterId: z.string(),
      weights: z.record(z.string(), z.number().min(0).max(1)).optional().describe('副词条权重 delta,键为副词条名(如 "CRIT DMG"、"SPD"),值 0-1'),
      parts: z.record(z.string(), z.array(z.string())).optional().describe('主词条候选 delta,键为 Body/Feet/PlanarSphere/LinkRope'),
      reset: z.boolean().optional().describe('清空该角色全部评分覆盖,恢复默认'),
    },
    outputSchema: {
      characterId: z.string(),
      reset: z.boolean(),
      stats: z.record(z.string(), z.number()),
      parts: z.record(z.string(), z.array(z.string())),
      modified: z.boolean(),
      override: z.unknown(),
    },
  }, async ({ characterId, weights, parts, reset }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    if (gameCharacterMetadata(characterId) == null) {
      throw new Error(`Unknown character id ${characterId} (not present in game metadata)`)
    }
    if (reset !== true && weights == null && parts == null) {
      throw new Error('Provide at least one of: weights, parts, or reset=true')
    }

    if (weights != null) {
      const valid = new Set<string>(SubStats)
      const unknown = Object.keys(weights).filter((k) => !valid.has(k))
      if (unknown.length) {
        throw new Error(`Unknown weight stat(s): ${unknown.join(', ')}. Valid: ${SubStats.join(', ')}`)
      }
    }
    if (parts != null) {
      const valid = new Set<string>(MainStatPartsArray)
      const unknown = Object.keys(parts).filter((k) => !valid.has(k))
      if (unknown.length) {
        throw new Error(`Unknown part(s): ${unknown.join(', ')}. Valid: ${MainStatPartsArray.join(', ')}`)
      }
    }

    if (reset === true) {
      useScoringStore.getState().clearCharacterOverrides(characterId as Any)
    } else {
      useScoringStore.getState().updateCharacterOverrides(characterId as Any, {
        ...(weights != null ? { stats: weights as Any } : {}),
        ...(parts != null ? { parts: parts as Any } : {}),
      })
    }
    runtimeContext.markDirty()

    const effective = getScoringMetadata(characterId as Any)
    const override = currentOverride(characterId)
    return toolResult(
      {
        characterId,
        reset: reset === true,
        stats: effective.stats,
        parts: effective.parts,
        modified: effective.modified === true,
        override,
      },
      `${reset === true ? '已清空' : '已更新'} ${characterId} 的评分覆盖 `
        + `(modified=${effective.modified === true},覆盖 ${override ? '存在' : '无'})`,
    )
  })
}
