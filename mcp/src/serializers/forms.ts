// Form serializers: saved builds and optimizer-form source annotations.
//
// - serializeSavedBuild: agent-friendly summary of a character's saved build
//   (equipped ids, team, conditional snapshots). The only field summarized
//   rather than inlined is `comboStateJson` — its raw body can be large, so we
//   report byte size plus the parsed action count instead.
// - annotateFormSources: marks each field of a normalized internal Form as
//   coming from the character's stored form ('saved') or from defaults
//   ('default'), so agents can tell what a get_form response actually persists
//   versus what normalization layered on top.

import type { Form } from 'types/form'
import {
  BuildSource,
  type SavedBuild,
} from 'types/savedBuild'

export type SerializedSavedBuildTeammate = {
  characterId: string | null,
  characterEidolon: number,
  lightCone: string | null,
  lightConeSuperimposition: number,
  teamRelicSet: string | null,
  teamOrnamentSet: string | null,
  /** Optimizer-source builds snapshot teammate conditionals; character-source builds do not */
  characterConditionals?: Record<string, boolean | number>,
  lightConeConditionals?: Record<string, boolean | number>,
}

export type SerializedSavedBuild = {
  name: string,
  source: BuildSource,
  characterId: string,
  scoringConfigType: string | null,
  /** Slot name → relic id; empty slots are omitted */
  equipped: Partial<Record<string, string>>,
  characterEidolon: number,
  lightCone: string | null,
  lightConeSuperimposition: number,
  team: Array<SerializedSavedBuildTeammate | null>,
  /** Optimizer-source snapshots (absent on character-source builds) */
  characterConditionals?: Record<string, boolean | number>,
  lightConeConditionals?: Record<string, boolean | number>,
  setConditionals?: Record<string, [undefined, boolean | number]>,
  combo?: {
    type: string,
    turnAbilities: string[],
    preprocessor: boolean,
    deprioritizeBuffs: boolean,
    stateJsonBytes: number,
    stateJsonActions: number | null,
  },
}

export function serializeSavedBuild(build: SavedBuild): SerializedSavedBuild {
  const serialized: SerializedSavedBuild = {
    name: build.name,
    source: build.source,
    characterId: build.characterId,
    scoringConfigType: build.scoringConfigType ?? null,
    equipped: Object.fromEntries(
      Object.entries(build.equipped ?? {}).filter((entry): entry is [string, string] => entry[1] != null),
    ),
    characterEidolon: build.characterEidolon,
    lightCone: build.lightCone ?? null,
    lightConeSuperimposition: build.lightConeSuperimposition,
    team: (build.team ?? [null, null, null]).map((teammate) =>
      teammate == null
        ? null
        : {
          characterId: teammate.characterId ?? null,
          characterEidolon: teammate.characterEidolon ?? 0,
          lightCone: teammate.lightCone ?? null,
          lightConeSuperimposition: teammate.lightConeSuperimposition ?? 1,
          teamRelicSet: teammate.teamRelicSet ?? null,
          teamOrnamentSet: teammate.teamOrnamentSet ?? null,
          ...('characterConditionals' in teammate
            ? {
              characterConditionals: teammate.characterConditionals ?? {},
              lightConeConditionals: teammate.lightConeConditionals ?? {},
            }
            : {}),
        }
    ),
  }

  if (build.source === BuildSource.Optimizer) {
    serialized.characterConditionals = build.characterConditionals ?? {}
    serialized.lightConeConditionals = build.lightConeConditionals ?? {}
    serialized.setConditionals = build.setConditionals ?? {}
    serialized.combo = {
      type: build.comboType,
      turnAbilities: build.comboTurnAbilities ?? [],
      preprocessor: build.comboPreprocessor === true,
      deprioritizeBuffs: build.deprioritizeBuffs === true,
      stateJsonBytes: build.comboStateJson?.length ?? 0,
      stateJsonActions: countComboActions(build.comboStateJson),
    }
  }

  return serialized
}

function countComboActions(comboStateJson: string | undefined): number | null {
  if (!comboStateJson) return 0
  try {
    const parsed = JSON.parse(comboStateJson) as { rotationActions?: unknown[] }
    return Array.isArray(parsed.rotationActions) ? parsed.rotationActions.length : null
  } catch {
    return null
  }
}

/** Nested map fields of a Form that get per-key source annotations. */
const NESTED_MAP_KEYS = ['characterConditionals', 'lightConeConditionals', 'setConditionals', 'weights'] as const

export type FormFieldSources = {
  /** Top-level internal-form field → where its value came from */
  fields: Record<string, 'saved' | 'default'>,
  /** Per-key provenance for conditional/weight maps (controller defaults vs saved form) */
  nested: Partial<Record<(typeof NESTED_MAP_KEYS)[number], Record<string, 'saved' | 'default'>>>,
  /** Keys present in the stored form but dropped by normalization (legacy fields) */
  legacyKeysDropped: string[],
}

export type FormSourceAnnotation = FormFieldSources & {
  /** How to read the annotation */
  note: string,
}

export function annotateFormSources(savedForm: Partial<Form> | undefined, normalizedForm: Form): FormSourceAnnotation {
  const saved = (savedForm ?? {}) as Record<string, unknown>
  const normalized = normalizedForm as Record<string, unknown>

  const fields: Record<string, 'saved' | 'default'> = {}
  for (const key of Object.keys(normalized)) {
    fields[key] = key in saved ? 'saved' : 'default'
  }

  const nested: FormFieldSources['nested'] = {}
  for (const mapKey of NESTED_MAP_KEYS) {
    const normalizedMap = normalized[mapKey]
    const savedMap = saved[mapKey]
    if (typeof normalizedMap !== 'object' || normalizedMap === null) continue
    const perKey: Record<string, 'saved' | 'default'> = {}
    for (const subKey of Object.keys(normalizedMap)) {
      perKey[subKey] = savedMap != null && typeof savedMap === 'object' && subKey in savedMap ? 'saved' : 'default'
    }
    nested[mapKey] = perKey
  }

  const legacyKeysDropped = Object.keys(saved).filter((key) => !(key in normalized))

  return {
    fields,
    nested,
    legacyKeysDropped,
    note: 'saved = key present in the character\'s stored form (value survives normalization); '
      + 'default = filled from optimizer defaults / conditional-controller defaults; '
      + 'legacyKeysDropped = stored keys the current normalization no longer emits',
  }
}
