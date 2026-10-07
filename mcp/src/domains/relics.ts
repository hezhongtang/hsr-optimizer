// Relic inventory CRUD domain (M5): upsert_relic / delete_relics.
//
// Covers the Relic editor's save path (relicModalController → relicStore) and
// the inventory delete path, including equippedBy rewiring, upgrade preview and
// editor defaults. Read-only inventory access stays in query.ts (list_relics).
//
// upsert_relic mirrors the web editor's save chain one-to-one:
//   RelicModalContent.handleOk (computeMainStatDisplayValue → validateRelic →
//   relicsAreDifferent ? verified=false) → RelicsTabController.onRelicModalOk →
//   RelicModalController.onEditOk ({...oldRelic, ...relic}) →
//   equipmentService.upsertRelicWithEquipment (add / part-change unequip /
//   equipRelic with the global Replace/Swap setting).
// Validation errors are thrown as actionable Chinese errors instead of the
// upstream UI toasts (Message.error); every check maps onto a validateRelic
// branch. Normalization is the upstream RelicAugmenter.augment — values are
// never hand-rounded here.
//
// delete_relics mirrors relicsTabController.deleteConfirmed: every selected
// relic goes through equipmentService.removeRelic (unequip the owner's slot,
// then deleteRelic), followed by SaveState.permitEmptySave() so an emptied
// inventory stays saveable (the MCP-side file wipe guard may still hold the
// write-back; export_save persists a deliberate wipe).
//
// ID 口径 matches the existing inventory tools (list_relics / score_relics):
// upstream internal names — part "Head", stats "CRIT DMG", sets
// "Musketeer of Wild Wheat" — the exact strings serializeRelic emits.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import i18next from 'i18next'
import {
  Parts,
  type Parts as PartsType,
  PartsArray,
  PartsMainStats,
  SubStats,
  type SubStats as SubStatsType,
  UnreleasedSets,
} from 'lib/constants/constants'
import { SettingOptions } from 'lib/constants/settingsConstants'
import { buffedCharacters } from 'lib/importer/kelzFormatParser'
import {
  calculateUpgradeValues,
  computeMainStatDisplayValue,
} from 'lib/overlays/modals/relicModal/relicModalController'
import {
  defaultSubstatValues,
  relicsAreDifferent,
} from 'lib/overlays/modals/relicModal/relicModalHelpers'
import type { RelicForm } from 'lib/overlays/modals/relicModal/relicModalTypes'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import { partIsOrnament } from 'lib/relics/relicUtils'
import { RelicScorer } from 'lib/relics/scoring/relicScorer'
import { sortAlphabeticEmojiLast } from 'lib/rendering/displayUtils'
import * as equipmentService from 'lib/services/equipmentService'
import {
  SetsOrnamentsNames,
  SetsRelicsNames,
} from 'lib/sets/setConfigRegistry'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { SaveState } from 'lib/state/saveState'
import { useGlobalStore } from 'lib/stores/app/appStore'
import {
  getCharacterById,
  getCharacters,
} from 'lib/stores/character/characterStore'
import {
  getRelicById,
  getRelics,
} from 'lib/stores/relic/relicStore'
import { useRelicLocatorStore } from 'lib/tabs/tabRelics/RelicLocator'
import type {
  Relic,
  UnaugmentedRelic,
} from 'types/relic'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { serializeRelic } from '../serializers/builds'
import { toolResult } from '../toolResult'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

type RelicMove = {
  relicId: string,
  part: string,
  from: string | null,
  to: string | null,
}

// ─── equipment simulation (dryRun preview + write-path diff) ─────────────────
//
// A read-only mirror of equipmentService's ownership transitions
// (unequipRelic / equipRelic / upsertRelicWithEquipment) over plain maps.
// The write path calls the real upstream service and diffs the store state;
// dryRun runs this simulation so nothing is mutated.

type EquipSim = {
  /** relicId → part (the store view: updated by upserts) */
  parts: Map<string, string>,
  /** relicId → equippedBy (null = in inventory) */
  owners: Map<string, string | null>,
  /** characterId → part → relicId (null = empty slot) */
  slots: Map<string, Map<string, string | null>>,
}

function currentEquipSim(): EquipSim {
  const parts = new Map<string, string>()
  const owners = new Map<string, string | null>()
  for (const relic of getRelics()) {
    parts.set(relic.id, relic.part)
    owners.set(relic.id, relic.equippedBy ?? null)
  }
  const slots = new Map<string, Map<string, string | null>>()
  for (const character of getCharacters()) {
    const slot = new Map<string, string | null>()
    for (const part of PartsArray) slot.set(part, character.equipped?.[part] ?? null)
    slots.set(character.id as string, slot)
  }
  return { parts, owners, slots }
}

function simUnequipRelic(sim: EquipSim, relicId: string): void {
  const part = sim.parts.get(relicId)
  if (part == null) return
  // Defensive scan by slot rather than equippedBy (upstream unequipRelic)
  for (const slot of sim.slots.values()) {
    if (slot.get(part) === relicId) slot.set(part, null)
  }
  sim.owners.set(relicId, null)
}

function simEquipRelic(sim: EquipSim, relicId: string, characterId: string): void {
  const part = sim.parts.get(relicId)
  if (part == null || !sim.slots.has(characterId)) return
  const prevOwnerId = sim.owners.get(relicId) ?? null
  const equippedId = sim.slots.get(characterId)!.get(part) ?? null

  // The occupant of the target slot always drops to inventory first
  if (equippedId != null) simUnequipRelic(sim, equippedId)

  const swap = globalEquippingBehavior() === 'Swap'
  if (prevOwnerId !== characterId && prevOwnerId != null && sim.slots.has(prevOwnerId)) {
    if (equippedId != null && swap) {
      // Swap: the displaced relic moves to the character ours came from
      sim.owners.set(equippedId, prevOwnerId)
      sim.slots.get(prevOwnerId)!.set(part, equippedId)
    } else {
      // Replace: the previous owner's slot is cleared
      sim.slots.get(prevOwnerId)!.set(part, null)
    }
  }

  sim.slots.get(characterId)!.set(part, relicId)
  sim.owners.set(relicId, characterId)
}

function simUpsertRelicWithEquipment(
  sim: EquipSim,
  spec: { id: string, part: string, equippedBy: string | undefined },
  isNew: boolean,
): void {
  if (isNew) {
    sim.parts.set(spec.id, spec.part)
    sim.owners.set(spec.id, spec.equippedBy ?? null)
    if (spec.equippedBy != null) simEquipRelic(sim, spec.id, spec.equippedBy)
    return
  }
  const partChanged = sim.parts.get(spec.id) !== spec.part
  if (partChanged || spec.equippedBy == null) {
    simUnequipRelic(sim, spec.id)
    sim.parts.set(spec.id, spec.part)
    sim.owners.set(spec.id, spec.equippedBy ?? null)
  }
  if (
    spec.equippedBy != null
    && sim.slots.get(spec.equippedBy)?.get(spec.part) !== spec.id
  ) {
    simEquipRelic(sim, spec.id, spec.equippedBy)
  }
  sim.parts.set(spec.id, spec.part)
  sim.owners.set(spec.id, spec.equippedBy ?? null)
}

function diffOwnerChanges(
  before: { parts: Map<string, string>, owners: Map<string, string | null> },
  after: { parts: Map<string, string>, owners: Map<string, string | null> },
): RelicMove[] {
  const changes: RelicMove[] = []
  const relicIds = new Set([...before.owners.keys(), ...after.owners.keys()])
  for (const relicId of relicIds) {
    const from = before.owners.get(relicId) ?? null
    const to = after.owners.get(relicId) ?? null
    if (from === to) continue
    // A relic absent from `after` was deleted: its ownership ends at null
    changes.push({ relicId, part: after.parts.get(relicId) ?? before.parts.get(relicId) ?? '?', from, to })
  }
  return changes
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function globalEquippingBehavior(): 'Replace' | 'Swap' {
  const setting = useGlobalStore.getState().settings.RelicEquippingBehavior
  return setting === SettingOptions.RelicEquippingBehavior.Swap ? 'Swap' : 'Replace'
}

function requireLoadedCharacter(characterId: string): void {
  if (getCharacterById(characterId as Any) == null) {
    throw new Error(
      `upsert_relic: 装备者 "${characterId}" 不在当前存档的角色列表中 — 已加载角色:${getCharacters().map((c) => c.id).join(', ')}`
        + '(如需新角色请先用 upsert_character 创建,或改传 null 卸下遗器)',
    )
  }
}

/** The editor's set dropdown for a part type: first non-unreleased option
 * (RelicModalContent's relicOptions[0] / planarOptions[0], used by
 * computePartChangeUpdates when the current set's type mismatches). */
function firstSetForPart(part: string): string {
  const names = partIsOrnament(part as PartsType) ? SetsOrnamentsNames : SetsRelicsNames
  return names.find((name) => !UnreleasedSets[name]) ?? names[0]
}

function serializeRelicPayload(relic: Relic) {
  return {
    ...serializeRelic(relic),
    previewSubstats: (relic.previewSubstats ?? []).map((s) => ({ stat: s.stat, value: s.value })),
    ageIndex: relic.ageIndex ?? null,
  }
}

/** Upgrade preview via the editor's own helpers: rebuild the RelicForm the
 * modal would show (defaultSubstatValues) and run calculateUpgradeValues —
 * per substat, the resulting value after adding one low/mid/high roll. */
function upgradePreview(relic: Relic) {
  const form: RelicForm = {
    equippedBy: 'None',
    grade: relic.grade,
    enhance: relic.enhance,
    part: relic.part,
    set: relic.set,
    mainStatType: relic.main.stat,
    mainStatValue: relic.main.value,
    ...defaultSubstatValues(relic),
  }
  const upgrades = calculateUpgradeValues(form)

  const entry = (stat: string, value: number, up: { low?: number | null, mid?: number | null, high?: number | null }) => ({
    stat,
    value,
    low: up.low ?? null,
    mid: up.mid ?? null,
    high: up.high ?? null,
  })
  const substatCount = relic.substats.length
  return {
    // RelicModalContent.plusThree: the editor bumps enhance to the next multiple of 3
    enhanceAfter: Math.floor(Math.min(relic.enhance + 3, 15) / 3) * 3,
    substats: relic.substats.map((s, i) => entry(s.stat, s.value, upgrades[i] ?? {})),
    previewSubstats: (relic.previewSubstats ?? []).map((s, i) => entry(s.stat, s.value, upgrades[substatCount + i] ?? {})),
  }
}

// ─── upsert_relic: validation + build (mirrors validateRelic, thrown errors) ─

type UpsertInput = {
  relicId?: string | undefined,
  part?: PartsType | undefined,
  set?: string | undefined,
  grade?: number | undefined,
  enhance?: number | undefined,
  mainStat?: string | undefined,
  equippedBy?: string | null | undefined,
  substats?: Array<{ stat: string, value: number }> | undefined,
  previewSubstats?: Array<{ stat: string, value: number }> | undefined,
}

function buildRelicFromInput(input: UpsertInput): { relic: Relic, existing: Relic | undefined } {
  const existing = input.relicId != null ? getRelicById(input.relicId) : undefined
  if (input.relicId != null && existing == null) {
    throw new Error(`upsert_relic: 库存中不存在遗器 id "${input.relicId}" — 请先用 list_relics 查询有效遗器 id;新建遗器不要传 relicId`)
  }

  // 部位:新建默认 Head(computeInitialFormValues);编辑不传保持原部位
  const part = input.part ?? existing?.part ?? Parts.Head

  // 主词条:换部位时重置为该部位第一项(computePartChangeUpdates),否则
  // 编辑保持原值 / 新建取 defaultMainStatPerPart(与 PartsMainStats[part][0] 一致)
  let mainStat: string | undefined = input.mainStat ?? existing?.main.stat
  const partChangedByInput = input.part != null && input.part !== existing?.part
  if (mainStat == null || (partChangedByInput && input.mainStat == null)) {
    mainStat = PartsMainStats[part][0]
  }
  const legalMains = PartsMainStats[part] as string[]
  if (!legalMains.includes(mainStat)) {
    throw new Error(
      `upsert_relic: 主词条 "${mainStat}" 不适用于部位 ${part} — 该部位合法主词条:${legalMains.join(', ')}`,
    )
  }

  // 套装:显式传入时校验类型匹配(网页端提交校验);由旧值继承而类型不匹配时
  // 自动换成该部位类型的第一个合法套装(computePartChangeUpdates 的联动)
  let set: string | undefined = input.set ?? existing?.set
  const setNames = new Set<string>([...SetsRelicsNames, ...SetsOrnamentsNames])
  if (set != null && !setNames.has(set)) {
    throw new Error(
      `upsert_relic: 套装 "${set}" 不存在 — 遗器套装(${SetsRelicsNames.length} 个,如 ${SetsRelicsNames.slice(0, 3).join(', ')}…)`
        + `与饰品套装(${SetsOrnamentsNames.length} 个,如 ${SetsOrnamentsNames.slice(0, 3).join(', ')}…)的完整合法名见 game://metadata/sets 资源`,
    )
  }
  const setMatchesPart = partIsOrnament(part)
    ? (SetsOrnamentsNames as string[]).includes(set ?? '')
    : (SetsRelicsNames as string[]).includes(set ?? '')
  if (!setMatchesPart) {
    if (input.set != null) {
      throw new Error(
        partIsOrnament(part)
          ? `upsert_relic: 套装 "${set}" 是遗器套装,不能配在部位 ${part} — 位面球/连结绳只能配饰品套装(合法值见 game://metadata/sets)`
          : `upsert_relic: 套装 "${set}" 是饰品套装,不能配在部位 ${part} — 头/手/躯干/脚只能配遗器套装(合法值见 game://metadata/sets)`,
      )
    }
    if (!partChangedByInput && set != null) {
      // 部位×套装类型错配的存量数据(手工篡改/外部导入产生):网页端编辑器加载
      // 原值、提交时拒绝(SetNotOrnament/SetNotRelic)。自动换套装只发生在输入
      // 改变了部位的联动里(computePartChangeUpdates 仅由 onPartChange 触发),
      // 未触碰部位却静默改套,等于替调用方改了没要求改的数据。
      throw new Error(
        `upsert_relic: 该遗器现有部位 ${part} 与套装 "${set}" 类型不匹配(存量错配数据,网页端编辑器会拒绝保存) — `
          + `请显式传 set 指定${
            partIsOrnament(part) ? `饰品套装(${SetsOrnamentsNames.length} 个合法值)` : `遗器套装(${SetsRelicsNames.length} 个合法值)`
          }(见 game://metadata/sets),或传 part 触发套装联动`,
      )
    }
    set = firstSetForPart(part)
  }
  if (set == null) set = firstSetForPart(part)

  // 星级/强化:新建默认 5★/+15(computeInitialFormValues),编辑不传保持
  const grade = input.grade ?? existing?.grade ?? 5
  const enhance = input.enhance ?? existing?.enhance ?? 15
  if (enhance > grade * 3) {
    throw new Error(`upsert_relic: 强化等级 ${enhance} 超出 ${grade}★ 的上限 ${grade * 3} — enhance 不能超过 星级×3`)
  }

  // 副词条:编辑不传保持原值;网页端表单共 4 个槽位,真词条与预览词条合计 ≤ 4
  const substats = input.substats ?? existing?.substats.map((s) => ({ stat: s.stat, value: s.value })) ?? []
  const previewSubstats = input.previewSubstats
    ?? existing?.previewSubstats?.map((s) => ({ stat: s.stat, value: s.value }))
    ?? []
  if (substats.length + previewSubstats.length > 4) {
    throw new Error(
      `upsert_relic: 副词条共 ${substats.length + previewSubstats.length} 条,超过上限 4 — 副词条与预览副词条合计至多 4 条`,
    )
  }
  const validSubstats = new Set<string>(SubStats)
  const combined = [
    ...substats.map((s) => ({ ...s, isPreview: false })),
    ...previewSubstats.map((s) => ({ ...s, isPreview: true })),
  ]
  for (const { stat } of combined) {
    if (!validSubstats.has(stat)) {
      throw new Error(`upsert_relic: 副词条名 "${stat}" 无效 — 合法副词条:${SubStats.join(', ')}`)
    }
  }
  const statNames = combined.map((s) => s.stat)
  const duplicate = statNames.find((stat, i) => statNames.indexOf(stat) !== i)
  if (duplicate != null) {
    throw new Error(`upsert_relic: 副词条 "${duplicate}" 重复 — 每种副词条只能出现一次(含预览词条)`)
  }
  if (statNames.includes(mainStat)) {
    throw new Error(`upsert_relic: 副词条 "${mainStat}" 与主词条相同 — 副词条不能与主词条重复`)
  }
  for (const { stat, value, isPreview } of combined) {
    if (value >= 1000) {
      throw new Error(`upsert_relic: 副词条 ${stat} 的数值 ${value} 超出范围 — 必须小于 1000${isPreview ? '(预览词条同受此限)' : ''}`)
    }
    if (value < 0) {
      throw new Error(`upsert_relic: 副词条 ${stat} 的数值 ${value} 不能为负`)
    }
    if (value <= 0) {
      // 上游表单把 0 值预览词条当普通词条处理(isPreview=0 为 falsy,
      // SubstatInput.tsx:121),validateRelic 一律按 SubTooSmall 拒绝 — 这里
      // 与上游有效行为一致:预览词条同样必须 > 0。
      throw new Error(
        `upsert_relic: 副词条 ${stat} 的数值 ${value} 无效 — 必须 > 0 且 < 1000${isPreview ? '(预览词条同受此限)' : '(尚未解锁的词条请放入 previewSubstats)'}`,
      )
    }
  }

  // 装备者:null=卸下这件遗器;不传=保持现状(新建=不装备);角色必须在存档中
  let equippedBy: string | undefined
  if (input.equippedBy === null) equippedBy = undefined
  else if (input.equippedBy != null) {
    requireLoadedCharacter(input.equippedBy)
    equippedBy = input.equippedBy
  } else {
    equippedBy = existing?.equippedBy
  }

  // 组装并交上游规范化:主词条数值按星级+强化推出(网页端禁止手填),
  // RelicAugmenter.augment 负责数值修正、id(uuid)、roll 反解与派生字段
  const relic: UnaugmentedRelic = {
    equippedBy: equippedBy as Relic['equippedBy'],
    enhance,
    grade,
    part,
    set: set as Relic['set'],
    main: {
      stat: mainStat as Relic['main']['stat'],
      value: computeMainStatDisplayValue(mainStat as Any, grade, enhance) ?? 0,
    },
    substats: substats.map((s) => ({ stat: s.stat as SubStatsType, value: s.value })),
    previewSubstats: previewSubstats.map((s) => ({ stat: s.stat as SubStatsType, value: s.value })),
  }
  const augmented = RelicAugmenter.augment(relic)
  if (augmented == null) {
    throw new Error('upsert_relic: 遗器规范化失败(主词条缺失)— 请检查 mainStat/part 参数')
  }

  // 内容有变化即失去已校验标记(RelicModalContent.handleOk);
  // 新建遗器必然 verified=false(对照旧遗器为 null)
  if (relicsAreDifferent(existing ?? null, augmented)) {
    augmented.verified = false
  }

  // 编辑时按 onEditOk 语义合并:id 沿用旧值,ageIndex/verified 等未覆盖字段保留
  let finalRelic: Relic = augmented
  if (existing != null) {
    augmented.id = existing.id
    finalRelic = { ...existing, ...augmented } as Relic
  }
  return { relic: finalRelic, existing }
}

// ─── output schemas ──────────────────────────────────────────────────────────

const substatPayloadSchema = z.object({
  stat: z.string(),
  value: z.number(),
  rolls: z.object({ high: z.number(), mid: z.number(), low: z.number() }).optional(),
  addedRolls: z.number().optional(),
})

const relicPayloadSchema = z.object({
  id: z.string(),
  part: z.string(),
  set: z.string(),
  grade: z.number(),
  enhance: z.number(),
  main: z.object({ stat: z.string(), value: z.number() }),
  substats: z.array(substatPayloadSchema),
  previewSubstats: z.array(z.object({ stat: z.string(), value: z.number() })),
  initialRolls: z.number(),
  verified: z.boolean(),
  equippedBy: z.string().optional(),
  ageIndex: z.number().nullable(),
  weightScore: z.null(),
})

const relicMoveSchema = z.object({
  relicId: z.string(),
  part: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
})

const upgradePreviewSchema = z.object({
  enhanceAfter: z.number().int(),
  substats: z.array(z.object({
    stat: z.string(),
    value: z.number(),
    low: z.number().nullable(),
    mid: z.number().nullable(),
    high: z.number().nullable(),
  })),
  previewSubstats: z.array(z.object({
    stat: z.string(),
    value: z.number(),
    low: z.number().nullable(),
    mid: z.number().nullable(),
    high: z.number().nullable(),
  })),
})

const substatInputSchema = z.object({
  stat: z.string().describe('词条名(上游 Stats 名,如 "CRIT DMG"、"SPD",同 list_relics 输出口径)'),
  value: z.number().describe('数值(游戏显示值:百分比词条 3.8 表示 3.8%;必须在 (0,1000) 区间)'),
})

// ─── analyze_relic (read-only insights views) ────────────────────────────────
//
// Three read-only views over one relic, mirroring the Relics tab's bottom dock:
//   view=characters → RelicInsightsPanel (scoreRelicPotential per candidate
//                     character, bestPct-desc sort, 10 percentage buckets)
//   view=location   → RelicLocator (ageIndex-ordered backpack position, with
//                     the part→part+set filter fallback)
//   view=reroll     → RelicRerollModal (same relic parsed twice — original vs
//                     rerolled substats — scored by the owner's weights when
//                     equipped; display-only, nothing is adopted or written)
// Pure computation: never mutates stores, never bumps the revision.

/** Default backpack geometry from the persisted locator store (web: the
 * RelicLocator popover writes these; MCP reads whatever the save restored,
 * falling back to the upstream defaults 9×10). */
function locatorDefaults(): { inventoryWidth: number, rowLimit: number } {
  const state = useRelicLocatorStore.getState()
  return { inventoryWidth: state.inventoryWidth ?? 9, rowLimit: state.rowLimit ?? 10 }
}

type LocatorResult = {
  inventoryWidth: number,
  rowLimit: number,
  equippedBy: string | null,
  ageIndex: number | null,
  ageIndexKnown: boolean,
  newerSamePartCount: number,
  positionIndex: number,
  row: number,
  column: number,
  filters: { part: string, set: string | null },
  needsSetFilter: boolean,
  note: string | undefined,
}

/** RelicLocator's useEffect computation, verbatim: count newer same-part
 * relics (acquisition order = ageIndex), convert to backpack row/column; when
 * the position exceeds rowLimit×inventoryWidth the count switches to
 * part+set (the game needs the set filter applied manually in that case). */
function computeLocator(
  relic: Relic,
  requested: { inventoryWidth?: number | undefined, rowLimit?: number | undefined },
): LocatorResult {
  const defaults = locatorDefaults()
  const inventoryWidth = Math.max(1, requested.inventoryWidth ?? defaults.inventoryWidth)
  const rowLimit = Math.max(1, requested.rowLimit ?? defaults.rowLimit)
  const indexLimit = rowLimit * inventoryWidth

  // The web compares `x.ageIndex! > relic.ageIndex!` — with a null relic
  // ageIndex every comparison is NaN-false, so a relic without acquisition
  // order counts as position 0 (row 1, column 1). Mirror that exactly and
  // flag it, instead of inventing an order for manually added relics.
  const ageIndex = relic.ageIndex ?? null
  const newerRelics = ageIndex == null ? [] : getRelics().filter((x) => (x.ageIndex ?? -1) > ageIndex)

  const newerSamePartCount = newerRelics.filter((x) => relic.part === x.part).length
  let positionIndex: number
  let filterSet: string | null
  if (newerSamePartCount < indexLimit) {
    positionIndex = newerSamePartCount
    filterSet = null
  } else {
    positionIndex = newerRelics.filter((x) => relic.part === x.part && relic.set === x.set).length
    filterSet = relic.set
  }

  const note = ageIndex == null
    ? '这件遗器没有获取顺序(ageIndex 缺失,手工新增的遗器没有游戏内顺序)— 定位按「无更新遗器」口径计算,仅作参考'
    : filterSet != null
    ? `同部位遗器超出 行数上限×背包宽度(${rowLimit}×${inventoryWidth}),已按 部位+套装 筛选后计数 — 游戏内需手动加上套装筛选才能看到该位置`
    : undefined

  return {
    inventoryWidth,
    rowLimit,
    equippedBy: relic.equippedBy ?? null,
    ageIndex,
    ageIndexKnown: ageIndex != null,
    newerSamePartCount,
    positionIndex,
    row: Math.ceil((positionIndex + 1) / inventoryWidth),
    column: positionIndex % inventoryWidth + 1,
    filters: { part: relic.part, set: filterSet },
    needsSetFilter: filterSet != null,
    note,
  }
}

/** RelicInsightsPanel's candidate scoring: potential per character over the
 * requested candidate set, bestPct>0 filter, bestPct-desc sort with the
 * emoji-last alphabetical tiebreak. BucketsPanel.getBucketIndex semantics. */
function computeCharacterInsights(
  relic: Relic,
  requestedCharacterIds: string[] | undefined,
  bucketMode: 'maximum' | 'average',
) {
  const scorer = new RelicScorer()
  const metadataCharacters = getGameMetadata().characters as Record<string, { id: string }>

  let candidates: Array<{ id: string }>
  if (requestedCharacterIds != null) {
    const unknown = requestedCharacterIds.filter((id) => metadataCharacters[id] == null)
    if (unknown.length > 0) {
      throw new Error(
        `analyze_relic: 角色 id ${unknown.map((id) => `"${id}"`).join(', ')} 不在游戏元数据中 — 合法角色 id 见 game://metadata/characters 资源`,
      )
    }
    candidates = requestedCharacterIds.map((id) => ({ id }))
  } else {
    candidates = Object.values(metadataCharacters).map((c) => ({ id: c.id }))
  }

  // buffedCharacters never participate (insights panel filter)
  const buffedIds = new Set<string>(Object.keys(buffedCharacters))
  const skippedBuffed = candidates.filter((c) => buffedIds.has(c.id)).map((c) => c.id)
  const eligible = candidates.filter((c) => !buffedIds.has(c.id))

  ensureI18nReady()
  const t = i18next.getFixedT(null, 'gameData', 'Characters') as Any
  const byName = sortAlphabeticEmojiLast('name')

  const scored = eligible
    .map((candidate) => {
      const potential = scorer.scoreRelicPotential(relic, candidate.id as Any, true)
      return {
        id: candidate.id,
        name: t(`${candidate.id}.Name`) as string,
        owned: getCharacterById(candidate.id as Any) != undefined,
        potential: {
          currentPct: potential.currentPct,
          bestPct: potential.bestPct,
          averagePct: potential.averagePct,
          worstPct: potential.worstPct,
        },
        bestAddedStats: potential.meta?.bestAddedStats ?? [],
        bestUpgradedStats: potential.meta?.bestUpgradedStats ?? [],
      }
    })
    // Web: `.filter((x) => x.score.bestPct > 0)` before sorting
    .filter((entry) => entry.potential.bestPct > 0)
    .sort((a, b) => (a.potential.bestPct === b.potential.bestPct ? byName(a, b) : b.potential.bestPct - a.potential.bestPct))

  const bucketIndexOf = (entry: { potential: { bestPct: number, averagePct: number } }) =>
    Math.min(9, Math.max(0, Math.floor((bucketMode === 'average' ? entry.potential.averagePct : entry.potential.bestPct) / 10)))

  const characters = scored.map((entry) => ({ ...entry, bucketIndex: bucketIndexOf(entry) }))
  const buckets = Array.from({ length: 10 }, (_, index) => ({
    index,
    // Y-axis label of the buckets chart: `${index * 10}%+`
    label: `${index * 10}%+`,
    characterIds: characters.filter((entry) => entry.bucketIndex === index).map((entry) => entry.id),
  }))

  return {
    bucketMode,
    considered: eligible.length,
    characters,
    buckets,
    ...(skippedBuffed.length > 0 ? { skippedBuffedCharacters: skippedBuffed } : {}),
  }
}

/** validate a reroll substat list with the editor's checks (validateRelic
 * branches: valid names, no duplicates, not the main stat, value bounds). */
function validateRerollSubstats(relic: Relic, substats: Array<{ stat: string, value: number }>): void {
  const validSubstats = new Set<string>(SubStats)
  const statNames = substats.map((s) => s.stat)
  for (const stat of statNames) {
    if (!validSubstats.has(stat)) {
      throw new Error(`analyze_relic: 重掷副词条名 "${stat}" 无效 — 合法副词条:${SubStats.join(', ')}`)
    }
  }
  const duplicate = statNames.find((stat, i) => statNames.indexOf(stat) !== i)
  if (duplicate != null) {
    throw new Error(`analyze_relic: 重掷副词条 "${duplicate}" 重复 — 每种副词条只能出现一次`)
  }
  if (statNames.includes(relic.main.stat)) {
    throw new Error(`analyze_relic: 重掷副词条 "${relic.main.stat}" 与主词条相同 — 副词条不能与主词条重复`)
  }
  for (const { stat, value } of substats) {
    if (!(value > 0) || value >= 1000) {
      throw new Error(`analyze_relic: 重掷副词条 ${stat} 的数值 ${value} 无效 — 必须 > 0 且 < 1000(游戏显示值,百分比词条 3.8 表示 3.8%)`)
    }
  }
}

/** RelicRerollModal semantics: the same relic re-parsed with the rerolled
 * substat list (parseRelic → RelicAugmenter.augment chain). Scored with the
 * owner's weights only when the relic has an owner (ScoringType.SUBSTAT_SCORE
 * vs NONE); never adopted — the modal is display-only and so is this view. */
function computeRerollComparison(relic: Relic, rerollSubstats: Array<{ stat: string, value: number }>) {
  validateRerollSubstats(relic, rerollSubstats)

  const unaugmented: UnaugmentedRelic = {
    equippedBy: relic.equippedBy,
    enhance: relic.enhance,
    grade: relic.grade,
    part: relic.part,
    set: relic.set,
    main: { stat: relic.main.stat, value: relic.main.value },
    substats: rerollSubstats.map((s) => ({ stat: s.stat as SubStatsType, value: s.value })),
  }
  const rerolled = RelicAugmenter.augment(unaugmented)
  if (rerolled == null) {
    throw new Error('analyze_relic: 重掷遗器规范化失败 — 请检查 rerollSubstats 参数(词条名与数值)')
  }
  rerolled.id = relic.id

  const scorer = new RelicScorer()
  const owner = relic.equippedBy
  const scoreOf = (candidate: Relic) => {
    if (owner == null) return null
    const scored = scorer.getCurrentRelicScore(candidate, owner as Any)
    return { percentScore: scored.percentScore, rating: scored.rating }
  }

  return {
    equippedBy: owner ?? null,
    scoredByOwner: owner != null,
    original: {
      relic: serializeRelicPayload(relic),
      score: scoreOf(relic),
    },
    rerolled: {
      relic: serializeRelicPayload(rerolled),
      score: scoreOf(rerolled),
    },
  }
}

// ─── analyze_relic output schemas ────────────────────────────────────────────

const potentialSchema = z.object({
  currentPct: z.number(),
  bestPct: z.number(),
  averagePct: z.number(),
  worstPct: z.number(),
})

const insightsCharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  owned: z.boolean(),
  potential: potentialSchema,
  bestAddedStats: z.array(z.string()),
  bestUpgradedStats: z.array(z.string()),
  bucketIndex: z.number().int(),
})

const insightsViewSchema = z.object({
  bucketMode: z.enum(['maximum', 'average']),
  considered: z.number().int(),
  characters: z.array(insightsCharacterSchema),
  buckets: z.array(z.object({
    index: z.number().int(),
    label: z.string(),
    characterIds: z.array(z.string()),
  })),
  skippedBuffedCharacters: z.array(z.string()).optional(),
})

const locationViewSchema = z.object({
  inventoryWidth: z.number().int(),
  rowLimit: z.number().int(),
  equippedBy: z.string().nullable(),
  ageIndex: z.number().nullable(),
  ageIndexKnown: z.boolean(),
  newerSamePartCount: z.number().int(),
  positionIndex: z.number().int(),
  row: z.number().int(),
  column: z.number().int(),
  filters: z.object({ part: z.string(), set: z.string().nullable() }),
  needsSetFilter: z.boolean(),
  note: z.string().optional(),
})

const rerollViewSchema = z.object({
  equippedBy: z.string().nullable(),
  scoredByOwner: z.boolean(),
  original: z.object({
    relic: relicPayloadSchema,
    score: z.object({ percentScore: z.number(), rating: z.string() }).nullable(),
  }),
  rerolled: z.object({
    relic: relicPayloadSchema,
    score: z.object({ percentScore: z.number(), rating: z.string() }).nullable(),
  }),
})

// ─── tool registration ───────────────────────────────────────────────────────

export function registerRelicTools(server: McpServer): void {
  // ── upsert_relic ───────────────────────────────────────────────────────────
  server.registerTool('upsert_relic', {
    title: '新增或编辑遗器',
    description: '对应网页端遗器编辑弹窗的保存(RelicModal→relicStore):不传 relicId 新建、传 relicId 编辑(未提及的字段保持原值)。'
      + '部位/主词条/套装联动与编辑器一致:新建默认 Head/5★/+15/该部位第一个主词条/该部位类型的第一个合法套装;换部位时主词条重置为该部位第一项,继承来的套装类型不匹配时自动换成同类第一项。'
      + '主词条数值由星级+强化自动计算,不接受手填;副词条(含预览词条)合计至多 4 条,不能重复、不能与主词条相同。'
      + 'equippedBy 传角色 id 装备(遵守全局 RelicEquippingBehavior 的 Replace/Swap 语义,处理跨角色转移与目标槽位原遗器)、传 null 逐件卸下、不传保持现状。'
      + '内容有变化的遗器失去已校验标记(verified=false)。previewUpgrade=true 返回每条副词条加一次低/中/高强化后的数值(不写入);dryRun=true 完整演练校验+规范化+装备变更但不落盘。',
    inputSchema: {
      relicId: z.string().optional().describe('要编辑的遗器 id(list_relics 可查);不传 = 新建'),
      part: z.enum([...PartsArray] as [PartsType, ...PartsType[]]).optional().describe(
        '部位:Head | Hands | Body | Feet | PlanarSphere | LinkRope;新建默认 Head,编辑不传保持原部位(换部位会联动重置主词条,必要时切换套装类型)',
      ),
      set: z.string().optional().describe(
        '套装名(上游套装名,如 "Musketeer of Wild Wheat";遗器套装只配 Head/Hands/Body/Feet,饰品套装只配 PlanarSphere/LinkRope)。'
          + '新建不传时默认该部位类型的第一个合法套装;编辑改部位后继承的套装类型不匹配时自动切换',
      ),
      grade: z.number().int().min(2).max(5).optional().describe('星级 2-5;新建默认 5,编辑不传保持'),
      enhance: z.number().int().min(0).max(15).optional().describe('强化等级 0-15(不能超过 星级×3);新建默认 15,编辑不传保持。主词条数值随星级与强化自动推出'),
      mainStat: z.string().optional().describe('主词条名(如 "HP"、"CRIT DMG");不传时新建取该部位默认(第一项)、换部位时重置为第一项,编辑不传保持原值'),
      equippedBy: z.string().nullable().optional().describe('装备者:角色 id=装备到该角色(角色须已在存档中);null=卸下这件遗器;不传=保持现状(新建时不传=不装备)'),
      substats: z.array(substatInputSchema).max(4).optional().describe('副词条列表(至多 4 条,与预览词条合计);不能重复、不能与主词条相同;编辑不传保持原值'),
      previewSubstats: z.array(substatInputSchema).max(4).optional().describe('预览副词条(尚未解锁的词条,网页编辑器的「预览」标记);编辑不传保持原值'),
      previewUpgrade: z.boolean().optional().describe('升级预览:返回每条副词条各加一次低/中/高 roll 后的数值与强化后等级;设置时本调用不写入任何变更'),
      dryRun: z.boolean().optional().describe(
        '演练:完整校验+规范化+计算将发生的装备变更,但不写入库存、不落盘(新建场景返回的 relicId 是本次演练生成的,不会保留到真实写入时)',
      ),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突,需重读后重试'),
    },
    outputSchema: {
      relicId: z.string(),
      created: z.boolean(),
      dryRun: z.boolean(),
      persisted: z.boolean(),
      relic: relicPayloadSchema,
      equippingBehavior: z.object({
        globalSetting: z.enum(['Replace', 'Swap']),
      }),
      changes: z.array(relicMoveSchema),
      revision: z.number().int().optional(),
      dirty: z.boolean().optional(),
      previewUpgrade: upgradePreviewSchema.optional(),
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const { relic, existing } = buildRelicFromInput(input)
    const readOnly = input.dryRun === true || input.previewUpgrade === true

    let changes: RelicMove[]
    if (readOnly) {
      // 演练:在只读快照上模拟 upsertRelicWithEquipment 的装备改写
      const sim = currentEquipSim()
      const beforeParts = new Map(sim.parts)
      const beforeOwners = new Map(sim.owners)
      simUpsertRelicWithEquipment(sim, { id: relic.id, part: relic.part, equippedBy: relic.equippedBy }, existing == null)
      changes = diffOwnerChanges({ parts: beforeParts, owners: beforeOwners }, sim)
    } else {
      const before = currentEquipSim()
      await runtimeContext.withChange('upsert_relic', () => {
        equipmentService.upsertRelicWithEquipment(relic)
        runtimeContext.markDirty()
      }, input.baseRevision != null ? { baseRevision: input.baseRevision } : {})
      const after = currentEquipSim()
      changes = diffOwnerChanges(before, after)
      // 以写回后的库存为准序列化(equippedBy/ageIndex 由装备路径落定)
      const stored = getRelicById(relic.id) ?? relic
      Object.assign(relic, stored)
    }

    const behavior = globalEquippingBehavior()
    const payload: Record<string, unknown> = {
      relicId: relic.id,
      created: existing == null,
      dryRun: readOnly,
      persisted: !readOnly,
      relic: serializeRelicPayload(relic),
      equippingBehavior: { globalSetting: behavior },
      changes,
      ...(readOnly ? {} : { revision: runtimeContext.getRevision(), dirty: true }),
      ...(input.previewUpgrade === true ? { previewUpgrade: upgradePreview(relic) } : {}),
    }

    const summary =
      `${readOnly ? (input.previewUpgrade === true ? '[预览] ' : '[dryRun] ') : ''}${
        existing == null ? '已新建' : '已更新'
      }遗器 ${relic.id}(${relic.part},${relic.set},${relic.grade}★+${relic.enhance},`
      + `主词条 ${relic.main.stat} ${relic.main.value};副词条 ${relic.substats.length} 条${
        relic.previewSubstats?.length ? `+预览 ${relic.previewSubstats.length} 条` : ''
      })`
      + `${relic.equippedBy ? `,装备到 ${relic.equippedBy}` : existing?.equippedBy != null ? ',已卸下' : ''}`
      + `${changes.length ? `;装备变更 ${changes.length} 处(全局行为 ${behavior})` : ''}`
      + `${readOnly ? ',未落盘' : `,revision=${runtimeContext.getRevision()}`}`
    return toolResult(payload, summary)
  })

  // ── delete_relics ──────────────────────────────────────────────────────────
  server.registerTool('delete_relics', {
    title: '删除遗器',
    description: '对应网页端遗器页的「删除遗器」(relicsTabController.deleteConfirmed→equipmentService.removeRelic):'
      + '按 relicId 数组批量删除,已装备的遗器先从装备者槽位卸下(清理 character.equipped 引用)再从库存移除。'
      + '任一 id 不存在即报错且不删除任何遗器;全部成功后返回删除清单、受影响角色与剩余件数。'
      + '删光库存后按网页端语义仍允许保存(permitEmptySave);若 MCP 防擦写护栏拦截了自动写回,可用 export_save 显式持久化。',
    inputSchema: {
      relicIds: z.array(z.string()).min(1).describe('要删除的遗器 id 列表(list_relics 可查;重复 id 会自动去重)'),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突,需重读后重试'),
    },
    outputSchema: {
      deleted: z.array(z.string()),
      remaining: z.number().int(),
      affectedCharacters: z.array(z.object({
        characterId: z.string(),
        clearedSlots: z.array(z.string()),
      })),
      changes: z.array(relicMoveSchema),
      revision: z.number().int(),
      dirty: z.boolean(),
      note: z.string().optional(),
    },
  }, async ({ relicIds, baseRevision }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const ids = [...new Set(relicIds)]
    const missing = ids.filter((id) => getRelicById(id) == null)
    if (missing.length > 0) {
      throw new Error(
        `delete_relics: 库存中不存在遗器 id ${missing.map((id) => `"${id}"`).join(', ')} — 请先用 list_relics 查询有效遗器 id;本次未删除任何遗器`,
      )
    }

    const before = currentEquipSim()
    await runtimeContext.withChange('delete_relics', () => {
      for (const id of ids) {
        equipmentService.removeRelic(id)
      }
      // 网页端 deleteConfirmed 的空库存放行(上游防擦写护栏)
      SaveState.permitEmptySave()
      runtimeContext.markDirty()
    }, baseRevision != null ? { baseRevision } : {})
    const after = currentEquipSim()

    const changes = diffOwnerChanges(before, after)
    const affectedCharacters: Array<{ characterId: string, clearedSlots: string[] }> = []
    for (const [characterId, slot] of after.slots) {
      const beforeSlot = before.slots.get(characterId)
      const clearedSlots = [...slot.keys()].filter((part) => (beforeSlot?.get(part) ?? null) != null && (slot.get(part) ?? null) == null)
      if (clearedSlots.length > 0) affectedCharacters.push({ characterId, clearedSlots })
    }

    const remaining = getRelics().length
    const payload: Record<string, unknown> = {
      deleted: ids,
      remaining,
      affectedCharacters,
      changes,
      revision: runtimeContext.getRevision(),
      dirty: true,
      ...(remaining === 0
        ? { note: '库存已清空;自动写回可能被 MCP 防擦写护栏拦截(save_status.blockedWrite 可见),刻意清空请用 export_save 持久化' }
        : {}),
    }
    return toolResult(
      payload,
      `已删除 ${ids.length} 件遗器${
        affectedCharacters.length
          ? `,清理 ${affectedCharacters.length} 个角色的装备引用(${affectedCharacters.map((c) => `${c.characterId}:${c.clearedSlots.length} 槽`).join(', ')})`
          : ''
      }`
        + `;库存剩余 ${remaining} 件,revision=${runtimeContext.getRevision()}`,
    )
  })

  // ── analyze_relic ──────────────────────────────────────────────────────────
  server.registerTool('analyze_relic', {
    title: '遗器分析(适配角色/背包定位/重掷对比)',
    description: '对单件遗器的三个只读分析视图(纯计算,不写任何状态、不递增 revision):'
      + '① view=characters — 遗器洞察面板(RelicInsightsPanel):在候选角色上逐个计算潜力'
      + '(scoreRelicPotential,与 score_relics 同一条评分管线),去掉最高潜力为 0 的角色后按最高潜力降序'
      + '(并列按名字字母序、表情名靠后),并按 10 个百分比区间(0%+…90%+)分桶;characterIds 可限定候选角色'
      + '(缺省全部已上线角色;强化版角色一律排除)。'
      + '② view=location — 背包定位(RelicLocator):按获取顺序(ageIndex)数出更新的同部位遗器,'
      + '换算成游戏背包第几行第几列;超出 行数上限×背包宽度 时自动改为按 部位+套装 筛选后计数并提示;'
      + 'inventoryWidth/rowLimit 缺省取存档里的定位设置(默认 9×10)。'
      + '③ view=reroll — 重掷前后对比(RelicRerollModal):把同一件遗器按原副词条与重掷副词条'
      + '(rerollSubstats,必填)各解析一份并排对比;遗器有佩戴者时按该角色的副词条权重各算一个当前分,'
      + '没有佩戴者则不给分——只做展示,不采用重掷结果、不写入库存。同参数两次调用结果完全一致。',
    inputSchema: {
      relicId: z.string().describe('遗器 id(list_relics 可查)'),
      view: z.enum(['characters', 'location', 'reroll']).default('characters').describe(
        'characters=适配角色+潜力分桶;location=背包定位;reroll=重掷前后对比',
      ),
      characterIds: z.array(z.string()).optional().describe(
        'characters 视图:限定候选角色 id(缺省全部已上线角色;强化版角色始终排除并在 skippedBuffedCharacters 里说明)',
      ),
      bucketMode: z.enum(['maximum', 'average']).default('maximum').describe(
        'characters 视图:分桶口径——maximum=按最高潜力分桶(默认,分桶图默认档),average=按平均潜力分桶;角色列表始终按最高潜力排序',
      ),
      inventoryWidth: z.number().int().min(1).optional().describe('location 视图:背包宽度(缺省取存档定位设置,默认 9)'),
      rowLimit: z.number().int().min(1).optional().describe('location 视图:行数上限(缺省取存档定位设置,默认 10)'),
      rerollSubstats: z.array(substatInputSchema).max(4).optional().describe(
        'reroll 视图必填:重掷后的副词条列表(至多 4 条;不能重复、不能与主词条相同,数值在 (0,1000) 区间)',
      ),
    },
    outputSchema: {
      relicId: z.string(),
      view: z.enum(['characters', 'location', 'reroll']),
      relic: relicPayloadSchema,
      characters: insightsViewSchema.optional(),
      location: locationViewSchema.optional(),
      reroll: rerollViewSchema.optional(),
      durationMs: z.number(),
    },
  }, async ({ relicId, view, characterIds, bucketMode, inventoryWidth, rowLimit, rerollSubstats }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const relic = getRelicById(relicId)
    if (relic == null) {
      throw new Error(
        `analyze_relic: 库存中不存在遗器 id "${relicId}" — 请先用 list_relics 查询有效遗器 id`,
      )
    }
    if (view === 'reroll' && rerollSubstats == null) {
      throw new Error('analyze_relic: view=reroll 需要 rerollSubstats(重掷后的副词条列表)— 与网页端重掷弹窗的「重掷副词条」同源')
    }

    const started = performance.now()
    const payload: Record<string, unknown> = {
      relicId,
      view,
      relic: serializeRelicPayload(relic),
    }
    let summary = ''

    if (view === 'characters') {
      const insights = computeCharacterInsights(relic, characterIds, bucketMode)
      payload.characters = insights
      const top = insights.characters[0]
      summary = `遗器 ${relicId}(${relic.part},${relic.set})的适配分析:${insights.characters.length}/${insights.considered} 个角色`
        + `(${bucketMode === 'average' ? '平均' : '最高'}潜力分桶)`
        + (top ? `,最适配 ${top.name}(${top.id},最高潜力 ${top.potential.bestPct.toFixed(1)}%)` : ',没有最高潜力 > 0 的角色')
        + (insights.skippedBuffedCharacters?.length ? `;已排除强化版角色 ${insights.skippedBuffedCharacters.length} 名` : '')
    } else if (view === 'location') {
      const location = computeLocator(relic, { inventoryWidth, rowLimit })
      payload.location = location
      summary = `遗器 ${relicId} 的背包定位:第 ${location.row} 行第 ${location.column} 列`
        + `(按${location.needsSetFilter ? ' 部位+套装 ' : '部位'}筛选,背包宽度 ${location.inventoryWidth}、行数上限 ${location.rowLimit})`
        + `${location.equippedBy ? `,当前装备于 ${location.equippedBy}` : ',未装备'}`
        + (location.note ? `;${location.note}` : '')
    } else {
      const reroll = computeRerollComparison(relic, rerollSubstats!)
      payload.reroll = reroll
      summary = `遗器 ${relicId} 的重掷对比:原副词条 ${relic.substats.length} 条 → 重掷 ${rerollSubstats!.length} 条`
        + (reroll.scoredByOwner
          ? `,按佩戴者 ${reroll.equippedBy} 权重评分 ${reroll.original.score?.percentScore.toFixed(1)}% → ${
            reroll.rerolled.score?.percentScore.toFixed(1)
          }%(${reroll.original.score?.rating} → ${reroll.rerolled.score?.rating})`
          : ',遗器无佩戴者——不评分(与网页端重掷弹窗一致)')
        + ';仅对比,不采用重掷结果'
    }

    payload.durationMs = Math.round(performance.now() - started)
    return toolResult(payload, summary)
  })
}
