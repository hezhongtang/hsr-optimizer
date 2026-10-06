// Teams domain: the data plane of the Teams showcase page (#teams).
//
// The web page's interactions (slot drag-drop, screenshots, benchmark sync)
// stay in the browser — MCP only exposes the persisted slot data:
//   - list_teams → 组队展示页的已保存队伍列表 (readSavedTeams)
//   - save_team  → 已保存队伍的新建/更新 (writeSavedTeams)
//
// Storage is the exact same source the web uses:
// save.savedSession.global.teamShowcaseSavedTeams (useGlobalStore via
// SavedSessionKeys), which load_save restores and SaveState.save serializes
// back — so a team written here shows up on the web page and vice versa.
// This is NOT the per-character saved-build team (Character.builds with
// SavedTeammate slots) — that one is exposed by list_builds/get_character.
//
// Teams may reference characters that are not in the roster: the web restores
// them with a default form when the team is loaded (loadSavedTeamSlots →
// ensureRosterCharacters), so save_team only validates ids against game
// metadata. Benchmark snapshots are dropped when slots change — same rule the
// web applies when a loaded team's slots no longer match (loadSavedTeam).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { getCharacterById } from 'lib/stores/character/characterStore'
import { TEAM_SIZE } from 'lib/tabs/tabTeamShowcase/teamShowcaseConstants'
import {
  readSavedTeams,
  writeSavedTeams,
} from 'lib/tabs/tabTeamShowcase/teamShowcaseController'
import {
  areTeamSlotsEqual,
  normalizeTeamSlots,
} from 'lib/tabs/tabTeamShowcase/teamShowcaseModel'
import type { TeamSlots } from 'lib/tabs/tabTeamShowcase/teamShowcaseTypes'
import { uuid } from 'lib/utils/miscUtils'
import type { CharacterId } from 'types/character'
import type { TeamShowcaseSavedTeam } from 'types/store'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { toolResult } from '../toolResult'

function serializeSlot(id: CharacterId | null) {
  if (id == null) return null
  const meta = getGameMetadata().characters[id]
  return {
    characterId: id,
    name: meta?.name ?? null,
    path: meta?.path ?? null,
    element: meta?.element ?? null,
    rarity: meta?.rarity ?? null,
    inRoster: getCharacterById(id) != null,
  }
}

function serializeTeam(team: TeamShowcaseSavedTeam) {
  const slots = normalizeTeamSlots(team.characterIds)
  return {
    id: team.id,
    name: team.name,
    characterIds: slots,
    slots: slots.map(serializeSlot),
    hasBenchmarkSnapshot: team.benchmarkSnapshot != null,
    benchmarkSnapshot: team.benchmarkSnapshot ?? null,
  }
}

// outputSchema 形状——serializeTeam 的序列化结果(benchmarkSnapshot 为上游
// 捕获的快照对象或 null,内部结构由网页端决定,不收紧)。
const teamSlotSchema = z.object({
  characterId: z.string(),
  name: z.string().nullable(),
  path: z.string().nullable(),
  element: z.string().nullable(),
  rarity: z.number().nullable(),
  inRoster: z.boolean(),
})

const serializedTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  characterIds: z.array(z.string().nullable()),
  slots: z.array(teamSlotSchema.nullable()),
  hasBenchmarkSnapshot: z.boolean(),
  benchmarkSnapshot: z.unknown().nullable(),
})

/**
 * Validate raw slot ids and normalize to exactly TEAM_SIZE entries (null-padded).
 * Rejects unknown ids and duplicates within the team (the web silently nulls
 * duplicates via sanitizeTeamSlots — a write tool should say so instead).
 */
function validateSlots(characterIds: Array<string | null>): TeamSlots {
  const metadata = getGameMetadata().characters
  const unknown: string[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  for (const id of characterIds) {
    if (id == null) continue
    if (!(id in metadata)) unknown.push(id)
    else if (seen.has(id)) duplicates.push(id)
    else seen.add(id)
  }
  if (unknown.length > 0) {
    throw new Error(`未知角色 id:${unknown.join(', ')}。队伍槽位只接受游戏元数据中存在的角色 id(不需要该角色已在存档中——网页端加载队伍时会自动补进角色列表)`)
  }
  if (duplicates.length > 0) {
    throw new Error(`队伍内角色重复:${duplicates.join(', ')}。同一队伍的槽位不允许重复角色`)
  }
  const slots = normalizeTeamSlots(characterIds as TeamSlots)
  if (slots.every((id) => id == null)) {
    throw new Error('至少需要一个角色才能保存队伍(网页端对全空队伍不保存)')
  }
  return slots
}

export function registerTeamsTools(server: McpServer): void {
  // ── list_teams ──────────────────────────────────────────────────────────────
  server.registerTool('list_teams', {
    title: '列出已保存队伍',
    description: '对应网页端「组队展示」页签(#teams)的已保存队伍列表(readSavedTeams 同源,存于存档 savedSession.global.teamShowcaseSavedTeams):'
      + '每支队伍的 id、名称、4 个槽位详情(角色 id/名称/命途/属性/稀有度/是否在当前角色列表中)与基准快照(benchmarkSnapshot,'
      + '同步基准评分时捕获的各成员光锥/星魂/套装快照)。只读,不改存档。',
    inputSchema: {},
    outputSchema: {
      total: z.number().int(),
      teams: z.array(serializedTeamSchema),
    },
  }, async () => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const teams = readSavedTeams()
    return toolResult(
      {
        total: teams.length,
        teams: teams.map(serializeTeam),
      },
      `${teams.length} 支已保存队伍${teams.length > 0 ? `:${teams.map((team) => `「${team.name}」`).join('、')}` : ''}`,
    )
  })

  // ── save_team ───────────────────────────────────────────────────────────────
  server.registerTool('save_team', {
    title: '保存组队展示队伍',
    description: '对应网页端「组队展示」页签(#teams)已保存队伍的写入(writeSavedTeams 同一存储,与网页端完全同源)。'
      + '不传 teamId 时新建队伍并生成新 id;传 teamId 时原地更新该队伍(name 与 characterIds 至少提供其一)。'
      + '槽位规则:characterIds 为 1-4 个槽位(null=空槽,不足 4 个自动尾部补 null);非空 id 必须存在于游戏元数据'
      + '(不要求已在角色列表中——网页端加载该队伍时会自动把缺失角色补进列表);同一队伍内不允许重复角色;全空不允许保存。'
      + '更新时若槽位发生变化,原基准快照会被丢弃(与网页端加载时槽位不匹配即弃快照的规则一致),槽位不变则保留。',
    inputSchema: {
      teamId: z.string().optional().describe('要更新的队伍 id(list_teams 可查;不传则新建)'),
      name: z.string().optional().describe('队伍名(新建时必填;更新时省略则保留原名)'),
      characterIds: z.array(z.string().nullable()).min(1).max(TEAM_SIZE).optional().describe('4 个槽位的角色 id,null 为空槽;不足 4 个自动尾部补 null'),
    },
    outputSchema: {
      teamId: z.string(),
      created: z.boolean(),
      team: serializedTeamSchema,
      totalTeams: z.number().int(),
    },
  }, async ({ teamId, name, characterIds }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const teams = readSavedTeams()
    const trimmedName = name?.trim()
    const updating = teamId != null

    if (trimmedName === '') throw new Error('队伍名不能为空')
    if (updating) {
      if (trimmedName == null && characterIds == null) throw new Error('更新队伍至少提供 name 或 characterIds 之一')
    } else {
      if (trimmedName == null) throw new Error('新建队伍必须提供非空 name')
      if (characterIds == null) throw new Error('新建队伍必须提供 characterIds')
    }

    const slots = characterIds != null ? validateSlots(characterIds) : null

    let team: TeamShowcaseSavedTeam
    if (updating) {
      const index = teams.findIndex((candidate) => candidate.id === teamId)
      if (index === -1) {
        throw new Error(`队伍 ${teamId} 不存在。现有队伍:${teams.map((t) => `${t.id}(「${t.name}」)`).join('、') || '(无)'}`)
      }
      const existing = teams[index]
      const nextSlots = slots ?? normalizeTeamSlots(existing.characterIds)
      // Snapshot follows the web's load rule: keep it only when the slots it
      // was captured against are unchanged.
      const keepSnapshot = areTeamSlotsEqual(nextSlots, existing.characterIds) ? existing.benchmarkSnapshot : undefined
      team = {
        id: existing.id,
        name: trimmedName ?? existing.name,
        characterIds: nextSlots,
        ...(keepSnapshot != null ? { benchmarkSnapshot: keepSnapshot } : {}),
      }
      teams[index] = team
    } else {
      team = {
        id: uuid(),
        name: trimmedName!,
        characterIds: slots!,
      }
      teams.push(team)
    }

    writeSavedTeams(teams)
    runtimeContext.markDirty()

    const serialized = serializeTeam(team)
    return toolResult(
      {
        teamId: team.id,
        created: !updating,
        team: serialized,
        totalTeams: teams.length,
      },
      `${updating ? '已更新' : '已新建'}队伍「${team.name}」(${team.id}):`
        + `${serialized.slots.map((slot) => slot?.name ?? '空槽').join(' / ')};现存 ${teams.length} 支队伍`,
    )
  })
}
