// Conditionals domain: introspection over a character's conditional definitions.
//
// Mirrors the web UI's Optimizer tab conditional panels — the switch / slider /
// select gear shown when a character is selected ("Character passives" and the
// light cone effect block). Every field is read from the exact resolver pair
// the optimizer itself uses (CharacterConditionalsResolver /
// LightConeConditionalsResolver with withContent=true), so Chinese labels and
// descriptions come from the same zh_CN conditionals.yaml bundle the web page
// renders (booted headlessly via ensureI18nReady). Read-only: nothing here
// touches forms, stores or the save.
//
// Eidolon / superimposition gates are not stored anywhere upstream — they are
// probed by re-running the resolvers across e0-e6 / s1-s5 and diffing each
// item: `disabled` transitions become unlock gates (requiresEidolon /
// requiresSuperimposition), label/description/min/max/options/default
// signature changes become value-upgrade levels (E3/E5 ability upgrades, per-
// superimposition scalings). A handful of legacy files (e.g. Pearl.ts) hardcode
// English text outside i18n — they are passed through verbatim, same as web.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CharacterConditionalsResolver } from 'lib/conditionals/resolver/characterConditionalsResolver'
import { getCharacterConfig } from 'lib/conditionals/resolver/characterConfigRegistry'
import { LightConeConditionalsResolver } from 'lib/conditionals/resolver/lightConeConditionalsResolver'
import { generateConditionalResolverMetadata } from 'lib/optimization/combo/comboInitializers'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { getCharacterById } from 'lib/stores/character/characterStore'
import type { CharacterId } from 'types/character'
import type {
  ConditionalsController,
  ConditionalValueMap,
  ContentItem,
} from 'types/conditionals'
import type { LightConeId } from 'types/lightCone'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { toolResult } from '../toolResult'

const EIDOLON_PROBE_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const
const SUPERIMPOSITION_PROBE_LEVELS = [1, 2, 3, 4, 5] as const

// outputSchema 形状——与本文件 SerializedConditional 的序列化结果一一对应。
const conditionalDefaultValueSchema = z.union([z.number(), z.boolean(), z.null()])

const serializedConditionalSchema = z.object({
  key: z.string(),
  source: z.enum(['character', 'lightCone']),
  scopes: z.array(z.enum(['self', 'teammate'])),
  label: z.string(),
  type: z.enum(['boolean', 'select', 'slider']),
  description: z.string(),
  defaultValue: z.object({
    self: conditionalDefaultValueSchema,
    teammate: conditionalDefaultValueSchema,
  }),
  disabled: z.boolean(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  percent: z.boolean().nullable(),
  options: z.array(z.object({ value: z.number(), label: z.string(), display: z.string() })).nullable(),
  threshold: z.object({
    requiresEidolon: z.number().nullable(),
    eidolonValueUpgrades: z.array(z.number()),
    requiresSuperimposition: z.number().nullable(),
    superimpositionValueUpgrades: z.array(z.number()),
    alwaysDisabled: z.boolean(),
  }),
})

type ConditionalSource = 'character' | 'lightCone'
type ConditionalScope = 'self' | 'teammate'
type ConditionalType = 'boolean' | 'select' | 'slider'

/** Everything one resolver pair snapshot exposes, flattened per conditional key. */
type ControllerSnapshot = {
  items: Map<string, { self?: ContentItem, teammate?: ContentItem }>,
  defaults: ConditionalValueMap,
  teammateDefaults: ConditionalValueMap,
}

type SerializedConditional = {
  key: string,
  source: ConditionalSource,
  scopes: ConditionalScope[],
  label: string,
  type: ConditionalType,
  description: string,
  defaultValue: { self: number | boolean | null, teammate: number | boolean | null },
  /** Locked at the requested eidolon/superimposition (e.g. E1 conditional at e0). */
  disabled: boolean,
  min: number | null,
  max: number | null,
  percent: boolean | null,
  options: Array<{ value: number, label: string, display: string }> | null,
  threshold: {
    /** Minimum eidolon unlocking the conditional (null = available from e0 / not applicable). */
    requiresEidolon: number | null,
    /** Eidolon levels where the item's values/description change (E3/E5 upgrades etc). */
    eidolonValueUpgrades: number[],
    /** Minimum superimposition unlocking the conditional (null = available from s1 / not applicable). */
    requiresSuperimposition: number | null,
    /** Superimposition levels where the item's values/description change. */
    superimpositionValueUpgrades: number[],
    /** Disabled at every probed level (upstream hard-disables the item). */
    alwaysDisabled: boolean,
  },
}

function snapshotController(controller: ConditionalsController): ControllerSnapshot {
  const items = new Map<string, { self?: ContentItem, teammate?: ContentItem }>()
  for (const item of controller.content()) {
    const entry = items.get(item.id) ?? {}
    entry.self = item
    items.set(item.id, entry)
  }
  for (const item of controller.teammateContent?.() ?? []) {
    const entry = items.get(item.id) ?? {}
    entry.teammate = item
    items.set(item.id, entry)
  }
  return {
    items,
    defaults: controller.defaults?.() ?? {},
    teammateDefaults: controller.teammateDefaults?.() ?? {},
  }
}

function defaultValueOf(map: ConditionalValueMap, key: string): number | boolean | null {
  return map[key] ?? null
}

function isDisabled(entry: { self?: ContentItem, teammate?: ContentItem } | undefined): boolean {
  if (entry == null) return true // key absent at a probe level counts as locked there
  if (entry.self != null) return entry.self.disabled === true
  return entry.teammate?.disabled === true
}

/** Value signature used to detect eidolon/superimposition-driven changes.
 * Deliberately excludes `disabled` — unlock gates are detected separately. */
function itemSignature(item: ContentItem, value: number | boolean | null): string {
  return JSON.stringify([
    item.formItem,
    item.text,
    item.content,
    item.formItem === 'slider' ? [item.min, item.max, item.percent ?? null] : null,
    item.formItem === 'select' ? (item.options ?? []).map((option) => [option.value, option.display, option.label]) : null,
    value,
  ])
}

function snapshotSignature(snapshot: ControllerSnapshot, key: string): string {
  const entry = snapshot.items.get(key)
  if (entry == null) return '~absent~'
  return JSON.stringify([
    entry.self != null ? itemSignature(entry.self, defaultValueOf(snapshot.defaults, key)) : null,
    entry.teammate != null ? itemSignature(entry.teammate, defaultValueOf(snapshot.teammateDefaults, key)) : null,
  ])
}

/**
 * Merge a level-probed resolver (e0-e6 for characters, s1-s5 for light cones)
 * into serialized conditional records rendered at `requestedLevel`.
 */
function serializeProbedConditionals(source: ConditionalSource, probe: Map<number, ControllerSnapshot>, requestedLevel: number): SerializedConditional[] {
  const levels = [...probe.keys()].sort((a, b) => a - b)
  const requested = probe.get(requestedLevel) ?? probe.get(levels[levels.length - 1])!
  const firstLevel = levels[0]
  const output: SerializedConditional[] = []

  for (const [key, entry] of requested.items) {
    const item = entry.self ?? entry.teammate!

    let unlock: number | null = null
    let everEnabled = false
    for (const level of levels) {
      if (!isDisabled(probe.get(level)!.items.get(key))) {
        everEnabled = true
        if (unlock == null) unlock = level
      }
    }
    const gate = unlock != null && unlock > firstLevel ? unlock : null

    const upgrades: number[] = []
    for (let i = 1; i < levels.length; i++) {
      if (snapshotSignature(probe.get(levels[i - 1])!, key) !== snapshotSignature(probe.get(levels[i])!, key)) {
        upgrades.push(levels[i])
      }
    }

    const scopes: ConditionalScope[] = []
    if (entry.self != null) scopes.push('self')
    if (entry.teammate != null) scopes.push('teammate')

    output.push({
      key,
      source,
      scopes,
      label: item.text,
      type: item.formItem === 'switch' ? 'boolean' : item.formItem,
      description: item.content,
      defaultValue: {
        self: entry.self != null ? defaultValueOf(requested.defaults, key) : null,
        teammate: entry.teammate != null ? defaultValueOf(requested.teammateDefaults, key) : null,
      },
      disabled: isDisabled(entry),
      min: item.formItem === 'slider' ? item.min : null,
      max: item.formItem === 'slider' ? item.max : null,
      percent: item.formItem === 'slider' ? item.percent ?? null : null,
      options: item.formItem === 'select'
        ? (item.options ?? []).map((option) => ({ value: option.value, label: option.label, display: option.display }))
        : null,
      threshold: {
        requiresEidolon: source === 'character' ? gate : null,
        eidolonValueUpgrades: source === 'character' ? upgrades : [],
        requiresSuperimposition: source === 'lightCone' ? gate : null,
        superimpositionValueUpgrades: source === 'lightCone' ? upgrades : [],
        alwaysDisabled: !everEnabled,
      },
    })
  }

  return output
}

export function registerConditionalsTools(server: McpServer): void {
  server.registerTool('describe_conditionals', {
    title: '条件定义查询',
    description: '列出一名角色(及其光锥)的全部条件开关定义——对应网页端 Optimizer 页签选中角色后中间的「角色被动/光锥效果」条件面板:'
      + '每条含 key、中文标签与描述、类型(boolean/select/slider)、默认值、select 枚举选项(值+标签)、'
      + '星魂/叠影门槛(requiresEidolon/requiresSuperimposition 为解锁所需最低档,eidolonValueUpgrades/superimpositionValueUpgrades 为数值随档位变化的档)'
      + '与来源(角色技能/光锥)。数据与标签和网页端完全同源(条件 resolver withContent=true + zh_CN conditionals.yaml)。'
      + 'lightConeId/superimposition 缺省依次回退:存档表单中该角色的当前光锥与叠影 → 角色配置默认光锥(叠影 1);'
      + 'eidolon 缺省取存档表单星魂,无存档为 0。不需要先 load_save。'
      + '光锥命途与角色不符时按网页端行为返回空光锥条件并附警告。'
      + '改条件值请把 key/value 写进 optimize 的 formOverrides.characterConditionals / lightConeConditionals(参考返回的 defaultConditionals)。',
    inputSchema: {
      characterId: z.string().describe('Character id, e.g. "1212b1" (any character in game metadata, save not required)'),
      eidolon: z.number().int().min(0).max(6).optional().describe(
        'Character eidolon the values/gates are rendered at; defaults to the character\'s saved-form eidolon, else 0',
      ),
      lightConeId: z.string().optional().describe(
        'Light cone id; defaults to the character\'s saved-form light cone, else the character config\'s default light cone',
      ),
      superimposition: z.number().int().min(1).max(5).optional().describe(
        'Light cone superimposition; defaults to the saved-form superimposition when the light cone comes from the save, else 1',
      ),
    },
    outputSchema: {
      character: z.object({
        id: z.string(),
        name: z.string(),
        path: z.string(),
        element: z.string(),
      }),
      lightCone: z.object({
        id: z.string(),
        name: z.string().nullable(),
        path: z.string().nullable(),
        pathMismatch: z.boolean(),
      }),
      resolved: z.object({
        eidolon: z.number(),
        eidolonSource: z.enum(['provided', 'saved-form', 'default']),
        superimposition: z.number(),
        superimpositionSource: z.enum(['provided', 'saved-form', 'default']),
        lightConeSource: z.enum(['provided', 'saved-form', 'character-default']),
      }),
      conditionals: z.array(serializedConditionalSchema),
      counts: z.object({
        character: z.number().int(),
        lightCone: z.number().int(),
        total: z.number().int(),
      }),
      defaultConditionals: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.boolean()]))),
      warnings: z.array(z.string()),
      notes: z.array(z.string()),
    },
  }, async ({ characterId, eidolon: eidolonInput, lightConeId, superimposition: superimpositionInput }) => {
    // Labels are translated inside the resolver calls — i18next must be ready
    // before any withContent=true invocation (idempotent; no-op when the entry
    // chunk already booted it).
    ensureI18nReady()
    runtimeContext.ensureMetadataReady()

    const dbMetadata = getGameMetadata()
    const characterMeta = dbMetadata.characters[characterId as CharacterId]
    if (!characterMeta) {
      throw new Error(`未知角色 id ${characterId}——不在游戏元数据中;请核对 list_characters 返回的 id(带 b1 后缀为升级前身版本)`)
    }
    if (!getCharacterConfig(characterId as CharacterId)) {
      throw new Error(`角色 ${characterId}(${characterMeta.name})没有条件定义配置(可能未实装),无法查询条件`)
    }

    const savedForm = getCharacterById(characterId as CharacterId)?.form

    const eidolon = eidolonInput ?? savedForm?.characterEidolon ?? 0
    const eidolonSource: 'provided' | 'saved-form' | 'default' = eidolonInput != null
      ? 'provided'
      : savedForm?.characterEidolon != null
      ? 'saved-form'
      : 'default'

    const warnings: string[] = []
    let lightCone: string
    let lightConeSource: 'provided' | 'saved-form' | 'character-default'
    if (lightConeId != null) {
      if (!(lightConeId in dbMetadata.lightCones)) {
        throw new Error(`未知光锥 id ${lightConeId}——不在游戏元数据中`)
      }
      lightCone = lightConeId
      lightConeSource = 'provided'
    } else if (savedForm?.lightCone != null) {
      lightCone = savedForm.lightCone
      lightConeSource = 'saved-form'
    } else {
      lightCone = getCharacterConfig(characterId as CharacterId)!.defaultLightCone
      lightConeSource = 'character-default'
      warnings.push(
        `未指定 lightConeId 且存档中没有该角色的表单——已回退到角色配置的默认光锥 ${lightCone}(${
          dbMetadata.lightCones[lightCone as LightConeId]?.name ?? '?'
        }),叠影按 1 处理`,
      )
    }

    // The saved superimposition only pairs with the saved cone; any other
    // resolved cone falls back to s1 so a stale level never leaks across cones.
    const superimposition = superimpositionInput
      ?? (savedForm?.lightCone === lightCone ? savedForm?.lightConeSuperimposition : undefined)
      ?? 1
    const superimpositionSource: 'provided' | 'saved-form' | 'default' = superimpositionInput != null
      ? 'provided'
      : savedForm?.lightCone === lightCone && savedForm?.lightConeSuperimposition != null
      ? 'saved-form'
      : 'default'

    const lightConeMeta = dbMetadata.lightCones[lightCone as LightConeId]
    const pathMismatch = lightConeMeta?.path != null && lightConeMeta.path !== characterMeta.path

    // Same request shape the optimizer builds (generateConditionalResolverMetadata):
    // fills path/lightConePath/element from game metadata.
    const request = generateConditionalResolverMetadata(
      {
        characterId: characterId as CharacterId,
        characterEidolon: eidolon,
        lightCone: lightCone as LightConeId,
        lightConeSuperimposition: superimposition,
      },
      dbMetadata,
    )

    const characterProbe = new Map<number, ControllerSnapshot>()
    for (const level of EIDOLON_PROBE_LEVELS) {
      characterProbe.set(
        level,
        snapshotController(CharacterConditionalsResolver.get({ characterId: characterId as CharacterId, characterEidolon: level }, true)),
      )
    }

    let lightConeConditionals: SerializedConditional[] = []
    const lightConeProbe = new Map<number, ControllerSnapshot>()
    if (pathMismatch) {
      warnings.push(
        `光锥 ${lightCone}(${lightConeMeta?.name ?? '?'})命途 ${lightConeMeta?.path} 与角色 ${characterMeta.name} 命途 ${characterMeta.path} 不符——`
          + '网页端会禁用该光锥的全部效果,此处光锥条件为空(与优化器行为一致)',
      )
    } else {
      for (const level of SUPERIMPOSITION_PROBE_LEVELS) {
        lightConeProbe.set(level, snapshotController(LightConeConditionalsResolver.get({ ...request, lightConeSuperimposition: level }, true)))
      }
      lightConeConditionals = serializeProbedConditionals('lightCone', lightConeProbe, superimposition)
      if (lightConeConditionals.length === 0) {
        warnings.push(`光锥 ${lightCone}(${lightConeMeta?.name ?? '?'})没有条件定义(部分光锥无条件效果,与网页端一致)`)
      }
    }

    const characterConditionals = serializeProbedConditionals('character', characterProbe, eidolon)
    const requestedCharacter = characterProbe.get(eidolon)!
    const requestedLightCone = lightConeProbe.get(superimposition)

    const gated = characterConditionals.filter((item) => item.threshold.requiresEidolon != null || item.disabled).length
      + lightConeConditionals.filter((item) => item.threshold.requiresSuperimposition != null || item.disabled).length

    return toolResult(
      {
        character: {
          id: characterId,
          name: characterMeta.name,
          path: characterMeta.path,
          element: characterMeta.element,
        },
        lightCone: {
          id: lightCone,
          name: lightConeMeta?.name ?? null,
          path: lightConeMeta?.path ?? null,
          pathMismatch,
        },
        resolved: {
          eidolon,
          eidolonSource,
          superimposition,
          superimpositionSource,
          lightConeSource,
        },
        conditionals: [...characterConditionals, ...lightConeConditionals],
        counts: {
          character: characterConditionals.length,
          lightCone: lightConeConditionals.length,
          total: characterConditionals.length + lightConeConditionals.length,
        },
        /** Ready-to-use default maps for optimize formOverrides
         * (formOverrides.characterConditionals / lightConeConditionals). */
        defaultConditionals: {
          characterConditionals: requestedCharacter.defaults,
          lightConeConditionals: requestedLightCone?.defaults ?? {},
          ...(Object.keys(requestedCharacter.teammateDefaults).length > 0 ? { teammateCharacterConditionals: requestedCharacter.teammateDefaults } : {}),
          ...(requestedLightCone && Object.keys(requestedLightCone.teammateDefaults).length > 0
            ? { teammateLightConeConditionals: requestedLightCone.teammateDefaults }
            : {}),
        },
        warnings,
        notes: [
          '条件面板同源:数据取自优化器实际使用的条件 resolver(withContent=true),中文标签/描述与网页端同一翻译源(zh_CN conditionals.yaml);个别旧文件(如 Pearl)上游硬编码英文,原样透出',
          'scopes=队友 表示该条件在「该角色作为队友」时生效(队友面板),defaultValue.teammate 为队友视角默认值;来源 source=角色技能(character)/光锥(lightCone)',
          'threshold.requiresEidolon/requiresSuperimposition=解锁所需最低星魂/叠影(由各档位 disabled 状态探测);eidolonValueUpgrades/superimpositionValueUpgrades=描述或数值发生变化的档位(如 E3/E5 技能升级)',
          '改条件值:把 key → value(type=boolean 填布尔,slider 填 min..max 内数值,select 填 options 里的 value)写进 optimize 的 formOverrides.characterConditionals / formOverrides.lightConeConditionals',
        ],
      },
      `${characterMeta.name}(${characterId}):${characterConditionals.length} 项角色条件 + ${lightConeConditionals.length} 项光锥条件`
        + `(e${eidolon},光锥 ${lightConeMeta?.name ?? lightCone} s${superimposition});`
        + `${gated} 项有星魂/叠影门槛或当前档位下禁用`,
    )
  })
}
