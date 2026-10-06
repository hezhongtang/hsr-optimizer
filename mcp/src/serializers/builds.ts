// Build serializers: optimizer row → the 6 concrete relics behind it.
//
// Row ids are mixed-radix packed permutation indices (slot base order
// h, g, b, f, p, l) over the filtered per-part relic lists — the driver
// decodes them via the upstream `OptimizerTabController.calculateRelicIdsFromId`
// (same code path the web UI's equip button uses), and this module hydrates
// each id against the relic store into an agent-friendly summary.

import type { Parts } from 'lib/constants/constants'
import { getRelicById } from 'lib/stores/relic/relicStore'
import type {
  Relic,
  RelicSubstatMetadata,
} from 'types/relic'

export type SerializedSubstat = {
  stat: string,
  value: number,
  rolls?: { high: number, mid: number, low: number },
  addedRolls?: number,
}

export type SerializedRelic = {
  id: string,
  part: string,
  set: string,
  grade: number,
  enhance: number,
  main: { stat: string, value: number },
  substats: SerializedSubstat[],
  initialRolls: number,
  verified: boolean,
  equippedBy: string | undefined,
  /**
   * Always null on this surface. Weighted score is computed only inside the
   * optimization pipeline (RelicFilters.calculateWeightScore on CLONED relics)
   * — the main thread never computes or refreshes it. Save files may carry
   * stale weightScore values persisted by the web app (sample-save: 35/162
   * relics); they reflect no current character's weights, so they are not
   * exposed. For per-character scoring use the score_relics tool.
   */
  weightScore: number | null,
}

export type SerializedBuild = {
  /** Slot name → relic summary; missing slots mean the id no longer resolves */
  relics: Partial<Record<Parts, SerializedRelic>>,
  /** Human-readable conflicts, e.g. "Feet is equipped by 1005" */
  conflicts: string[],
}

export function serializeRelic(relic: Relic): SerializedRelic {
  return {
    id: relic.id,
    part: relic.part,
    set: relic.set,
    grade: relic.grade,
    enhance: relic.enhance,
    main: { stat: relic.main.stat, value: relic.main.value },
    substats: relic.substats.map(serializeSubstat),
    initialRolls: relic.initialRolls,
    verified: relic.verified === true,
    equippedBy: relic.equippedBy,
    // Deliberately constant: see the type doc above (stale persisted values
    // from the save file are suppressed, and no fake 0 is invented)
    weightScore: null,
  }
}

function serializeSubstat(substat: RelicSubstatMetadata): SerializedSubstat {
  return {
    stat: substat.stat,
    value: substat.value,
    ...(substat.rolls ? { rolls: substat.rolls } : {}),
    ...(substat.addedRolls != null ? { addedRolls: substat.addedRolls } : {}),
  }
}

/**
 * Hydrate a row's 6 relic ids (as decoded by the driver) into full summaries.
 * `characterId` drives the equipped-conflict hints: relics worn by someone
 * else are legal in optimizer results (equipped-filter settings) but the
 * agent should know equipping this build will take them off that character.
 */
export function serializeBuild(
  relicIdsByPart: Partial<Record<string, string | undefined>>,
  characterId: string,
): SerializedBuild {
  const relics: Partial<Record<Parts, SerializedRelic>> = {}
  const conflicts: string[] = []

  for (const [part, relicId] of Object.entries(relicIdsByPart)) {
    if (!relicId) continue
    const relic = getRelicById(relicId)
    if (!relic) {
      conflicts.push(`${part}: relic ${relicId} not found in inventory`)
      continue
    }
    relics[part as Parts] = serializeRelic(relic)
    if (relic.equippedBy && relic.equippedBy !== characterId) {
      conflicts.push(`${part} is currently equipped by ${relic.equippedBy}`)
    }
  }

  return { relics, conflicts }
}
