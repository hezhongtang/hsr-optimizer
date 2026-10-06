// Stats serializers: reduce the engine's array-backed stat containers into
// JSON-safe named-number objects for the simulation domain.
//
// The engine keeps everything in flat Float64Array / Float32Array buffers:
//   - ComputedStatsContainer.a  (Float64Array) — action-level combat stats per
//     entity, then hit stats, then [action|hit|global] registers
//   - ComputedStatsContainer.c.a (BasicStatsArray, Float32Array) — basic stats
//
// Reduction rules (mirroring the web UI's own reducers —
// ComputedStatsContainer.toComputedStatsObject / toBasicStatsObject):
//   - every buffer entry is flattened into a named numeric object; keys reuse
//     the upstream Stats keys where a mapping exists ('HP%', 'CRIT Rate',
//     'Fire DMG Boost'…) and the upstream AKey names otherwise ('BOOST',
//     'VULNERABILITY', 'CR_BOOST'…)
//   - values are copied verbatim — NO rounding anywhere, matching the engine's
//     Float32/Float64 precision conventions (same as the web grid)
//   - global registers (COMBO_DMG/HEAL/SHIELD/BUFF) are included only when the
//     container actually initialized them (simulateBuild always does;
//     fromArrays()-built containers do not)
//
// Buffs traced with trace=true carry a BuffSource ({id, label, ability,
// buffType}) that attributes each buff to 角色/光锥/套装/行迹 — exposed as-is,
// with damageTags/outputTags additionally decoded to readable names.

import type { Buff } from 'lib/optimization/basicStatsArray'
import { toBasicStatsObject } from 'lib/optimization/basicStatsArray'
import {
  AKeyNames,
  GlobalRegister,
} from 'lib/optimization/engine/config/keys'
import {
  DamageTag,
  OutputTag,
} from 'lib/optimization/engine/config/tag'
import type { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import type {
  ActionDamage,
  RotationDamageStep,
} from 'lib/simulations/statSimulationTypes'
import type { DamageSplitEntry } from 'lib/tabs/tabOptimizer/analysis/damageSplitsExtractor'

// --- Tag decoding (numeric bitmasks → stable flag names) ---

const DAMAGE_FLAG_NAMES: Array<[number, string]> = Object.entries(DamageTag)
  .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
  .map(([name, value]) => [value, name])

const OUTPUT_FLAG_NAMES: Array<[number, string]> = Object.entries(OutputTag)
  .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
  .map(([name, value]) => [value, name])

function decodeFlags(mask: number, flags: Array<[number, string]>): string | undefined {
  const parts: string[] = []
  for (const [value, name] of flags) {
    if (mask & value) parts.push(name)
  }
  return parts.length ? parts.join(' | ') : undefined
}

// --- Buffs ---

export type SerializedBuffSource = {
  /** Upstream source id — character id, light cone id, set key or 'NONE' */
  id: string,
  /** Upstream composite label, e.g. "1212_E2" or "21003_LC" */
  label: string,
  /** 归因能力:Basic/Skill/Ult/Talent/Trace(行迹)/E1..E6/LC/SETS… */
  ability: string,
  /** 归因大类:CHARACTER(角色)/LIGHTCONE(光锥)/SETS(套装)/NONE… */
  buffType: string,
}

export type SerializedBuff = {
  stat: string,
  value: number,
  memo: boolean,
  source: SerializedBuffSource,
  damageTags?: number,
  /** damageTags decoded to names, e.g. "SKILL | ULT" */
  damageTagsLabel?: string,
  /** outputTags decoded to names, e.g. "DAMAGE" */
  outputTagsLabel?: string,
}

export function serializeBuff(buff: Buff): SerializedBuff {
  const damageTagsLabel = buff.damageTags != null ? decodeFlags(buff.damageTags, DAMAGE_FLAG_NAMES) : undefined
  const outputTagsLabel = buff.outputTags != null ? decodeFlags(buff.outputTags, OUTPUT_FLAG_NAMES) : undefined
  return {
    stat: buff.stat,
    value: buff.value,
    memo: buff.memo ?? false,
    source: {
      id: String(buff.source.id),
      label: String(buff.source.label),
      ability: String(buff.source.ability),
      buffType: String(buff.source.buffType),
    },
    ...(buff.damageTags != null ? { damageTags: buff.damageTags } : {}),
    ...(damageTagsLabel != null ? { damageTagsLabel } : {}),
    ...(outputTagsLabel != null ? { outputTagsLabel } : {}),
  }
}

// --- Rotation damage steps / action damage ---

export type SerializedRotationDamageStep = {
  actionType: string,
  actionName: string,
  damage: number,
  /** Upstream AKeyValue index of the buff stat the action scales on, when set */
  buffStat?: number,
}

export function serializeRotationDamageStep(step: RotationDamageStep): SerializedRotationDamageStep {
  return {
    actionType: step.actionType,
    actionName: step.actionName,
    damage: step.damage,
    ...(step.buffStat != null ? { buffStat: step.buffStat } : {}),
  }
}

/** Shallow JSON copy of the per-ability damage totals (BASIC/SKILL/ULT/…). */
export function serializeActionDamage(actionDamage: ActionDamage): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(actionDamage)) {
    if (typeof value === 'number') out[key] = value
  }
  return out
}

// --- Damage splits (per-action damage-type breakdown) ---

export type SerializedDamageSplitSegment = {
  damageType: number,
  label: string,
  damage: number,
  hitIndex: number,
}

export type SerializedDamageSplitEntry = {
  name: string,
  total: number,
  segments: SerializedDamageSplitSegment[],
}

export function serializeDamageSplits(entries: DamageSplitEntry[]): SerializedDamageSplitEntry[] {
  return entries.map((entry) => ({
    name: entry.name,
    total: entry.total,
    segments: entry.segments.map((segment) => ({
      damageType: segment.damageType,
      label: segment.label,
      damage: segment.damage,
      hitIndex: segment.hitIndex,
    })),
  }))
}

// --- ComputedStatsContainer ---

export type SerializedComboRegisters = {
  damage: number,
  heal: number,
  shield: number,
  buff: number,
}

export type SerializedEntityStats = {
  name: string,
  memosprite: boolean,
  /** Action-level stats keyed by upstream AKey names */
  stats: Record<string, number>,
}

export type SerializedComputedStats = {
  /** Entity 0 (self) action-level combat stats — upstream Stats keys where mapped, AKey keys otherwise */
  computed: Record<string, number>,
  /** Basic (panel) stats incl. relicSetIndex/ornamentSetIndex — upstream Stats keys */
  basic: Record<string, number>,
  /** Global registers; present only when the container initialized them */
  combo?: SerializedComboRegisters,
  /** Per-entity action stats (AKey keys); single-entity containers omit this */
  entities: SerializedEntityStats[],
}

/**
 * Flatten a ComputedStatsContainer into named numeric objects. Values are the
 * raw engine floats — no rounding (Float32 basic stats keep their engine
 * precision, Float64 combat stats theirs).
 */
export function serializeComputedStats(x: ComputedStatsContainer): SerializedComputedStats {
  const basic: Record<string, number> = {}
  // BasicStatsObject also declares non-numeric members (e.g. `sets`) that
  // toBasicStatsObject never populates — keep the numeric entries only.
  for (const [key, value] of Object.entries(toBasicStatsObject(x.c.a))) {
    if (typeof value === 'number') basic[key] = value
  }

  const result: SerializedComputedStats = {
    computed: x.toComputedStatsObject() as Record<string, number>,
    basic,
    entities: [],
  }

  // Global registers live behind a private offset that only
  // initializeArrays()/clone() set — fromArrays()-built containers never have it.
  const registersOffset = (x as unknown as { registersOffset?: number }).registersOffset
  if (typeof registersOffset === 'number') {
    result.combo = {
      damage: x.getGlobalRegisterValue(GlobalRegister.COMBO_DMG),
      heal: x.getGlobalRegisterValue(GlobalRegister.COMBO_HEAL),
      shield: x.getGlobalRegisterValue(GlobalRegister.COMBO_SHIELD),
      buff: x.getGlobalRegisterValue(GlobalRegister.COMBO_BUFF),
    }
  }

  const config = x.config
  if (config != null && config.entitiesLength > 1) {
    for (let entityIndex = 0; entityIndex < config.entitiesLength; entityIndex++) {
      const entity = config.entitiesArray[entityIndex]
      const base = entityIndex * config.entityStride
      const stats: Record<string, number> = {}
      for (let key = 0; key < AKeyNames.length; key++) {
        stats[AKeyNames[key]] = x.a[base + key]
      }
      result.entities.push({ name: entity.name, memosprite: !!entity.memosprite, stats })
    }
  }

  return result
}
