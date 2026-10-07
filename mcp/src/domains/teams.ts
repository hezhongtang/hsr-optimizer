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
import {
  getCharacterById,
  getCharacters,
  useCharacterStore,
} from 'lib/stores/character/characterStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import { TEAM_SIZE } from 'lib/tabs/tabTeamShowcase/teamShowcaseConstants'
import {
  ensureRosterCharacters,
  loadSavedTeamSlots,
  readSavedTeams,
  writeSavedTeams,
} from 'lib/tabs/tabTeamShowcase/teamShowcaseController'
import {
  areBenchmarkSnapshotsEqual,
  areTeamSlotsEqual,
  autofillTeamSlots,
  captureTeamBenchmarkSnapshot,
  normalizeTeamSlots,
  sanitizeTeamSlots,
  TeamBenchmarkOverrideStatus,
} from 'lib/tabs/tabTeamShowcase/teamShowcaseModel'
import { resolveCustomAutofillTeammateIds } from 'lib/tabs/tabTeamShowcase/teamShowcaseScoring'
import type { TeamSlots } from 'lib/tabs/tabTeamShowcase/teamShowcaseTypes'
import { uuid } from 'lib/utils/miscUtils'
import type { CharacterId } from 'types/character'
import type {
  TeamShowcaseBenchmarkSnapshot,
  TeamShowcaseSavedTeam,
} from 'types/store'
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

const benchmarkSnapshotSummarySchema = z.object({
  members: z.array(z.object({
    characterId: z.string(),
    name: z.string().nullable(),
    lightCone: z.string(),
    characterEidolon: z.number(),
    lightConeSuperimposition: z.number(),
    teamRelicSet: z.string().nullable(),
    teamOrnamentSet: z.string().nullable(),
  })),
})

const workingTeamSchema = z.object({
  characterIds: z.array(z.string().nullable()),
  slots: z.array(teamSlotSchema.nullable()),
  hasBenchmarkSnapshot: z.boolean(),
  activeSavedTeamId: z.string().nullable(),
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

// ── working team ─────────────────────────────────────────────────────────────
//
// The web's "current team being edited" is component state inside useTeamShowcase
// (ephemeral: lost on reload, never persisted). The MCP server keeps the exact
// same shape module-side, reset whenever the save generation changes (the
// reload analog). Every read sanitizes slots against the current roster —
// mirroring the hook's roster-change effect, where a deleted character's slot
// auto-clears and that sanitization drops the working benchmark snapshot
// (setWorkingTeam returns `{ slots }` without it).
//
// Snapshot-drop semantics copied from useTeamShowcase:
//   - setSlot that CHANGES slots drops the snapshot (`{ slots: filled }`);
//     a no-op pick keeps it
//   - reorderSlots KEEPS the snapshot (`{ ...current, slots: next }`)
//   - clearTeam drops it

type WorkingTeam = {
  slots: TeamSlots,
  benchmarkSnapshot?: TeamShowcaseBenchmarkSnapshot,
  selectedSavedTeamId: string | null,
}

let workingTeamByGeneration: { generation: number, team: WorkingTeam } | null = null

function readWorkingTeam(): WorkingTeam {
  const generation = runtimeContext.getSaveGeneration()
  if (workingTeamByGeneration == null || workingTeamByGeneration.generation !== generation) {
    workingTeamByGeneration = {
      generation,
      team: { slots: normalizeTeamSlots([]), selectedSavedTeamId: null },
    }
  }
  const team = workingTeamByGeneration.team
  const sanitized = sanitizeTeamSlots(team.slots, useCharacterStore.getState().charactersById)
  if (!areTeamSlotsEqual(team.slots, sanitized)) {
    team.slots = sanitized
    team.benchmarkSnapshot = undefined
  }
  return team
}

/**
 * useSavedTeams' activeSavedTeamId: the saved team the working team currently
 * corresponds to (slots AND benchmark snapshot both equal) — selected team if
 * it still matches, else the unique match, else null. sync_benchmarks writes
 * its snapshot into this team when there is one.
 */
function resolveActiveSavedTeamId(team: WorkingTeam): string | null {
  const matches = readSavedTeams().filter((saved) =>
    areTeamSlotsEqual(saved.characterIds, team.slots)
    && areBenchmarkSnapshotsEqual(saved.benchmarkSnapshot, team.benchmarkSnapshot)
  )
  if (team.selectedSavedTeamId != null && matches.some((saved) => saved.id === team.selectedSavedTeamId)) {
    return team.selectedSavedTeamId
  }
  return matches.length === 1 ? matches[0].id : null
}

function serializeWorkingTeam(team: WorkingTeam) {
  return {
    characterIds: team.slots,
    slots: team.slots.map(serializeSlot),
    hasBenchmarkSnapshot: team.benchmarkSnapshot != null,
    activeSavedTeamId: resolveActiveSavedTeamId(team),
  }
}

function serializeSnapshot(snapshot: TeamShowcaseBenchmarkSnapshot) {
  return {
    members: snapshot.members.map((member) => ({
      characterId: member.characterId,
      name: getGameMetadata().characters[member.characterId]?.name ?? null,
      lightCone: member.lightCone,
      characterEidolon: member.characterEidolon,
      lightConeSuperimposition: member.lightConeSuperimposition,
      teamRelicSet: member.teamRelicSet ?? null,
      teamOrnamentSet: member.teamOrnamentSet ?? null,
    })),
  }
}

/**
 * captureTeamBenchmarkSnapshot over working/saved slots: requires all four
 * slots filled with roster characters (INCOMPLETE → error, the web disables
 * the button) and every member's form carrying a light cone
 * (MISSING_LIGHT_CONE → error, the web toasts NoSelectedLightCone).
 */
function captureSnapshotForSlots(slots: TeamSlots): TeamShowcaseBenchmarkSnapshot {
  const charactersById = useCharacterStore.getState().charactersById
  const characters = slots.map((id) => (id != null ? charactersById[id] ?? null : null))
  const missingSlot = characters.findIndex((character) => character == null)
  if (missingSlot !== -1) {
    throw new Error(`同步基准要求四个槽位都有角色 — 第 ${missingSlot + 1} 个槽位为空或不在角色列表中`)
  }
  const result = captureTeamBenchmarkSnapshot(characters, useRelicStore.getState().relicsById)
  if (result.status === TeamBenchmarkOverrideStatus.MISSING_LIGHT_CONE) {
    const missing = characters
      .filter((character) => character!.form.lightCone == null)
      .map((character) => `${character!.id}(${getGameMetadata().characters[character!.id]?.name ?? character!.id})`)
    throw new Error(`以下队伍成员未装备光锥,无法同步基准:${missing.join('、')}。请先为它们设置光锥再同步`)
  }
  if (result.status !== TeamBenchmarkOverrideStatus.READY || result.snapshot == null) {
    throw new Error('同步基准要求四个槽位都有角色(当前队伍不满员)')
  }
  return result.snapshot
}

function findSavedTeam(teamId: string): TeamShowcaseSavedTeam {
  const teams = readSavedTeams()
  const team = teams.find((candidate) => candidate.id === teamId)
  if (!team) {
    throw new Error(`队伍 ${teamId} 不存在。现有队伍:${teams.map((t) => `${t.id}(「${t.name}」)`).join('、') || '(无)'}`)
  }
  return team
}

function requireMetadataCharacter(id: string): void {
  if (!(id in getGameMetadata().characters)) {
    throw new Error(`未知角色 id:${id}。槽位只接受游戏元数据中存在的角色 id(未拥有的角色会自动按默认表单补进角色列表)`)
  }
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
      + '更新时若槽位发生变化,原基准快照会被丢弃(与网页端加载时槽位不匹配即弃快照的规则一致),槽位不变则保留。'
      + '允许保存与现有队伍完全相同的阵容(网页端保存按钮此时禁用)——重复队伍会让「活动队伍」解析产生歧义,'
      + '后续 manage_team(action=sync_benchmarks) 将不写入任何队伍;更新既有队伍请传 teamId。',
    inputSchema: {
      teamId: z.string().optional().describe('要更新的队伍 id(list_teams 可查;不传则新建)'),
      name: z.string().optional().describe('队伍名(新建时必填;更新时省略则保留原名)'),
      characterIds: z.array(z.string().nullable()).min(1).max(TEAM_SIZE).optional().describe('4 个槽位的角色 id,null 为空槽;不足 4 个自动尾部补 null'),
      benchmarkSnapshot: z.boolean().optional().describe(
        '保存时是否附带基准快照(true=按角色列表当前状态现场捕获各成员的光锥/星魂/叠影与遗器/饰品套装推断,'
          + '与网页端「同步基准队伍」同一捕获路径;要求四个槽位都有角色且都已装备光锥,缺失角色会先按默认表单补进列表。默认不带快照)',
      ),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突,需重读后重试'),
    },
    outputSchema: {
      teamId: z.string(),
      created: z.boolean(),
      team: serializedTeamSchema,
      totalTeams: z.number().int(),
      benchmarkSnapshotAttached: z.boolean(),
      snapshot: benchmarkSnapshotSummarySchema.optional(),
    },
  }, async ({ teamId, name, characterIds, benchmarkSnapshot, baseRevision }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    // 静态参数预检(作用域外:纯输入校验,不触碰任何状态)
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

    // 整个「补员 → 快照捕获 → 写队伍表」链在同一个事务里:快照捕获对缺光锥/
    // 缺槽位的成员抛错时,ensureRosterCharacters 已经补进的角色必须被回滚收
    // 回,否则幽灵角色会脱离 revision/dirty 追踪、随下一次任意写操作的防抖
    // 落盘静默写进存档文件(captureSaveStores 覆盖 character store)。
    const outcome = await runtimeContext.withChange('save_team', () => {
      const teams = readSavedTeams()
      const teamsBeforeJson = JSON.stringify(teams)

      // benchmarkSnapshot=true captures a fresh snapshot from the current roster
      // state (the same path the web's 同步基准队伍 button takes) and attaches
      // it to the saved team — the web can only save a team that already carries
      // a synced snapshot; MCP composes both steps. Members missing from the
      // roster join it first with a default form (ensureRosterCharacters, the
      // same restore the web's load/compose path uses).
      let snapshot: TeamShowcaseBenchmarkSnapshot | undefined
      let rosterAdded: string[] = []
      if (benchmarkSnapshot === true) {
        if (updating && teams.findIndex((candidate) => candidate.id === teamId) === -1) {
          throw new Error(`队伍 ${teamId} 不存在。现有队伍:${teams.map((t) => `${t.id}(「${t.name}」)`).join('、') || '(无)'}`)
        }
        const targetSlots = slots ?? normalizeTeamSlots(teams.find((candidate) => candidate.id === teamId)!.characterIds)
        if (targetSlots.every((id) => id == null)) {
          throw new Error('附带基准快照要求四个槽位都有角色(当前队伍全空)')
        }
        // 未拥有角色按默认表单补进列表后必然没有光锥,快照捕获注定失败 — 先行
        // 报错,避免「调用失败却补进了角色」的中间态(事务兜底之外的显式化)。
        const owned = new Set(getCharacters().map((character) => character.id as string))
        const unowned = [...new Set(targetSlots.filter((id) => id != null && !owned.has(id as string)).map((id) => id as string))]
        if (unowned.length > 0) {
          throw new Error(
            `基准快照要求所有成员已装备光锥,但以下角色还不在角色列表中(补进列表的默认表单不带光锥):${
              unowned.map((id) => `${id}(${getGameMetadata().characters[id as CharacterId]?.name ?? id})`).join('、')
            } — 请先 manage_team(action=load) 载入该队伍(会补进角色),为成员装备光锥后再带基准快照保存,或不带 benchmarkSnapshot 保存`,
          )
        }
        const rosterBefore = new Set(getCharacters().map((character) => character.id as string))
        ensureRosterCharacters(targetSlots)
        rosterAdded = getCharacters().map((c) => c.id as string).filter((id) => !rosterBefore.has(id))
        snapshot = captureSnapshotForSlots(targetSlots)
      }

      let team: TeamShowcaseSavedTeam
      if (updating) {
        const index = teams.findIndex((candidate) => candidate.id === teamId)
        if (index === -1) {
          throw new Error(`队伍 ${teamId} 不存在。现有队伍:${teams.map((t) => `${t.id}(「${t.name}」)`).join('、') || '(无)'}`)
        }
        const existing = teams[index]
        const nextSlots = slots ?? normalizeTeamSlots(existing.characterIds)
        // Snapshot follows the web's load rule: keep it only when the slots it
        // was captured against are unchanged — unless benchmarkSnapshot=true just
        // captured a fresh one, which wins.
        const keepSnapshot = areTeamSlotsEqual(nextSlots, existing.characterIds) ? existing.benchmarkSnapshot : undefined
        const finalSnapshot = snapshot ?? keepSnapshot
        team = {
          id: existing.id,
          name: trimmedName ?? existing.name,
          characterIds: nextSlots,
          ...(finalSnapshot != null ? { benchmarkSnapshot: finalSnapshot } : {}),
        }
        teams[index] = team
      } else {
        team = {
          id: uuid(),
          name: trimmedName!,
          characterIds: slots!,
          ...(snapshot != null ? { benchmarkSnapshot: snapshot } : {}),
        }
        teams.push(team)
      }

      writeSavedTeams(teams)
      // 内容零变化(重命名回原名/同槽同快照)时不递增 revision、不标脏 —
      // 上游 writeSavedTeams 对相等表跳过写入,no-op 调用不应让持有
      // baseRevision 的调用方收到伪冲突。
      if (JSON.stringify(teams) !== teamsBeforeJson || rosterAdded.length > 0) {
        runtimeContext.markDirty()
      }

      // Mirror of useSavedTeams.saveCurrentTeam selecting the team it just saved:
      // a saved team identical to the working team (slots + snapshot) becomes the
      // active one, so a later manage_team sync_benchmarks writes into it.
      const working = readWorkingTeam()
      if (
        areTeamSlotsEqual(team.characterIds, working.slots)
        && areBenchmarkSnapshotsEqual(team.benchmarkSnapshot, working.benchmarkSnapshot)
      ) {
        working.selectedSavedTeamId = team.id
      }

      return { team, totalTeams: teams.length, created: !updating, rosterAdded }
    }, baseRevision != null ? { baseRevision } : {})

    const { team, totalTeams, created, rosterAdded } = outcome
    const serialized = serializeTeam(team)
    return toolResult(
      {
        teamId: team.id,
        created,
        team: serialized,
        totalTeams,
        benchmarkSnapshotAttached: team.benchmarkSnapshot != null,
        ...(team.benchmarkSnapshot != null ? { snapshot: serializeSnapshot(team.benchmarkSnapshot) } : {}),
      },
      `${updating ? '已更新' : '已新建'}队伍「${team.name}」(${team.id}):`
        + `${serialized.slots.map((slot) => slot?.name ?? '空槽').join(' / ')};现存 ${totalTeams} 支队伍`
        + `${team.benchmarkSnapshot != null ? ',附带基准快照' : ''}`
        + `${rosterAdded.length > 0 ? `;已把 ${rosterAdded.join('、')} 按默认表单补进角色列表` : ''}`,
    )
  })

  // ── manage_team ─────────────────────────────────────────────────────────────
  const MANAGE_ACTIONS = ['get', 'load', 'delete', 'move', 'compose', 'sync_benchmarks'] as const
  const COMPOSE_OPS = ['set_slot', 'reorder', 'clear'] as const

  server.registerTool('manage_team', {
    title: '管理组队展示队伍',
    description: '组队展示页(#teams)队伍操作的合并式工具,action 枚举切子操作(每个 action 对应网页端一个入口,行为逐行对齐 useTeamShowcase / useSavedTeams):'
      + '`get`:读取当前工作队伍(网页端正在编辑的四槽队伍,会话内存态,不落盘;角色被删除的槽位自动清空);'
      + '`load`:把一支已保存队伍载入工作区并把缺失角色按默认表单补进角色列表(槽位与网页一致;补完后仍无效的槽位被清空且不带入基准快照);'
      + '`delete`:删除一支已保存队伍(破坏性,需显式 teamId;不影响工作队伍);'
      + '`move`:重排已保存队伍顺序(from/to 下标,其余顺延);'
      + '`compose`:工作队伍编排——`set_slot`(设槽,null=移除;同一角色已在别槽时那个槽被清空;空队伍填第 0 槽会按该角色的自定义评分队伍用已拥有角色自动补满其余槽位,与网页选人一致;选未拥有的角色会先按默认表单补进列表)、`reorder`(长度 4 的排列整队重排,保留已同步基准)、`clear`(清空四槽并丢弃基准快照);'
      + '`sync_benchmarks`:为当前工作队伍捕获基准快照(四名成员的光锥/星魂/叠影与按已装备遗器推断的队伍遗器 4 件+饰品 2 件套装);要求四槽满员且都装光锥;工作队伍对应某支已保存队伍时快照同时写进该队伍并落盘,否则只存在于工作状态。'
      + '所有变更走事务协调器(支持可选 baseRevision 乐观并发检查)。',
    inputSchema: {
      action: z.enum(MANAGE_ACTIONS).describe('要执行的队伍操作'),
      teamId: z.string().optional().describe('队伍 id(action=load/delete 必填;list_teams 可查)'),
      from: z.number().int().min(0).optional().describe('action=move:要移动的队伍当前下标(0 起)'),
      to: z.number().int().min(0).optional().describe('action=move:目标下标(其余队伍顺延)'),
      op: z.enum(COMPOSE_OPS).optional().describe('action=compose 的子操作:set_slot=设槽/reorder=整队重排/clear=清空'),
      index: z.number().int().min(0).max(TEAM_SIZE - 1).optional().describe('op=set_slot 的槽位下标 0-3(第 0 槽在基准评分中按主 C 计)'),
      characterId: z.string().nullable().optional().describe(
        'op=set_slot 的角色 id(必须存在于游戏元数据,不要求已拥有——未拥有会按默认表单补进列表;null=移除该槽角色)',
      ),
      order: z.array(z.number().int().min(0).max(TEAM_SIZE - 1)).length(TEAM_SIZE).optional().describe(
        'op=reorder:长度 4 的源下标排列,新位置 i 放原 order[i] 槽位的角色(如 [2,0,1,3] 把原第 3 槽换到首位)',
      ),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突,需重读后重试'),
    },
    outputSchema: {
      action: z.enum(MANAGE_ACTIONS),
      workingTeam: workingTeamSchema,
      teamId: z.string().optional(),
      team: serializedTeamSchema.optional(),
      rosterAdded: z.array(z.string()).optional(),
      deletedTeamId: z.string().optional(),
      deletedTeamName: z.string().optional(),
      remainingTeamIds: z.array(z.string()).optional(),
      remainingTeamNames: z.array(z.string()).optional(),
      teamOrder: z.array(z.string()).optional(),
      op: z.enum(COMPOSE_OPS).optional(),
      autofilled: z.array(z.string()).optional(),
      snapshot: benchmarkSnapshotSummarySchema.optional(),
      savedTeamId: z.string().nullable().optional(),
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    const { action, teamId, from, to, op, index, characterId, order, baseRevision } = input
    const changeOptions = baseRevision != null ? { baseRevision } : {}

    // ── get: read-only peek at the working team ──────────────────────────────
    if (action === 'get') {
      const working = readWorkingTeam()
      return toolResult(
        { action, workingTeam: serializeWorkingTeam(working) },
        `当前工作队伍:${working.slots.map((id) => (id != null ? getGameMetadata().characters[id]?.name ?? id : '空槽')).join(' / ')}`
          + `${working.benchmarkSnapshot != null ? '(已同步基准)' : ''}`,
      )
    }

    if (action === 'load') {
      if (teamId == null) throw new Error('manage_team(action=load):必须提供 teamId — 可先用 list_teams 查询现有队伍')
      const outcome = await runtimeContext.withChange('manage_team:load', () => {
        // 队伍表在作用域内重读:同一批次里先提交的 delete/save_team 可能已经
        // 改变了队伍表,入队前的快照读会拿到陈旧引用。
        const saved = findSavedTeam(teamId)
        const rosterBefore = new Set(getCharacters().map((c) => c.id as string))
        // loadSavedTeamSlots restores missing roster characters (default form,
        // NewCharacterDefaultRank position, delayedSave) then sanitizes; the
        // snapshot only survives when the sanitized slots still match.
        const loadedSlots = loadSavedTeamSlots(saved.characterIds)
        const working = readWorkingTeam()
        working.slots = loadedSlots
        working.selectedSavedTeamId = saved.id
        working.benchmarkSnapshot = areTeamSlotsEqual(loadedSlots, saved.characterIds)
          ? saved.benchmarkSnapshot
          : undefined
        // roster 差值在 body 内取(前后各一次):外部快照在并发交错下会误判
        const rosterAdded = getCharacters().map((c) => c.id as string).filter((id) => !rosterBefore.has(id))
        if (rosterAdded.length > 0) runtimeContext.markDirty()
        return { saved, rosterAdded, working: serializeWorkingTeam(readWorkingTeam()) }
      }, changeOptions)
      const { saved, rosterAdded } = outcome
      const working = readWorkingTeam()
      return toolResult(
        {
          action,
          teamId,
          team: serializeTeam(saved),
          rosterAdded,
          workingTeam: outcome.working,
        },
        `已载入队伍「${saved.name}」到工作区:${working.slots.map((id) => (id != null ? getGameMetadata().characters[id]?.name ?? id : '空槽')).join(' / ')}`
          + `${working.benchmarkSnapshot != null ? '(带入基准快照)' : ''}`
          + `${rosterAdded.length > 0 ? `;已把 ${rosterAdded.join('、')} 按默认表单补进角色列表` : ''}`,
      )
    }

    if (action === 'delete') {
      if (teamId == null) throw new Error('manage_team(action=delete):必须提供 teamId — 可先用 list_teams 查询现有队伍')
      const outcome = await runtimeContext.withChange('manage_team:delete', () => {
        const saved = findSavedTeam(teamId)
        writeSavedTeams(readSavedTeams().filter((candidate) => candidate.id !== teamId))
        const working = readWorkingTeam()
        if (working.selectedSavedTeamId === teamId) working.selectedSavedTeamId = null
        runtimeContext.markDirty()
        return { deletedName: saved.name }
      }, changeOptions)
      const remaining = readSavedTeams()
      return toolResult(
        {
          action,
          teamId,
          deletedTeamId: teamId,
          deletedTeamName: outcome.deletedName,
          remainingTeamIds: remaining.map((t) => t.id),
          remainingTeamNames: remaining.map((t) => t.name),
          workingTeam: serializeWorkingTeam(readWorkingTeam()),
        },
        `已删除队伍「${outcome.deletedName}」(${teamId});剩余 ${remaining.length} 支`,
      )
    }

    if (action === 'move') {
      if (from == null || to == null) throw new Error('manage_team(action=move):必须同时提供 from 与 to 下标')
      let order_: string[] = []
      let names: string[] = []
      await runtimeContext.withChange('manage_team:move', () => {
        // 越界与同位检查在作用域内做:入队前读的队伍表在同批 delete 后会失真,
        // 越界 splice 会取出 undefined 并让上游 areSavedTeamsEqual 抛 TypeError
        const current = readSavedTeams()
        const outOfRange = [from, to].filter((i) => i >= current.length)
        if (outOfRange.length > 0) {
          throw new Error(`manage_team(action=move):下标越界 — 现有 ${current.length} 支队伍,合法下标 0..${current.length - 1},收到 from=${from}, to=${to}`)
        }
        if (from === to) throw new Error('manage_team(action=move):from 与 to 相同,无需移动')
        const next = [...current]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        writeSavedTeams(next)
        runtimeContext.markDirty()
        order_ = next.map((t) => t.id)
        names = next.map((t) => t.name)
      }, changeOptions)
      return toolResult(
        {
          action,
          teamOrder: order_,
          remainingTeamNames: names,
          workingTeam: serializeWorkingTeam(readWorkingTeam()),
        },
        `已把队伍「${names[to]}」移到第 ${to + 1} 位;当前顺序:${names.map((n) => `「${n}」`).join('、')}`,
      )
    }

    if (action === 'compose') {
      if (op == null) throw new Error('manage_team(action=compose):必须提供 op(set_slot / reorder / clear)')

      if (op === 'set_slot') {
        if (index == null || characterId === undefined) {
          throw new Error('manage_team(compose set_slot):必须同时提供 index(0-3)与 characterId(null=移除该槽角色)')
        }
        if (characterId != null) requireMetadataCharacter(characterId)
        let rosterAddedByScope: string[] = []
        let autofilled: string[] = []
        await runtimeContext.withChange('manage_team:compose:set_slot', () => {
          // useTeamShowcase.setSlot: an unowned pick joins the roster first;
          // another slot holding the same character is emptied; filling slot 0
          // of an EMPTY team autofills the rest from the character's first
          // Custom benchmark team (owned characters only); any slot change
          // drops the working benchmark snapshot.
          const rosterBefore = new Set(getCharacters().map((c) => c.id as string))
          if (characterId != null) ensureRosterCharacters([characterId as CharacterId])
          rosterAddedByScope = getCharacters().map((c) => c.id as string).filter((id) => !rosterBefore.has(id))
          const charactersById = useCharacterStore.getState().charactersById
          const selectedCharacter = characterId != null ? charactersById[characterId as CharacterId] : undefined
          const customTeammateIds = selectedCharacter
            ? resolveCustomAutofillTeammateIds(
              selectedCharacter,
              useShowcaseTabStore.getState().showcaseTeamPreferenceByConfig[selectedCharacter.id] ?? {},
            )
            : []
          const working = readWorkingTeam()
          const currentSlots = sanitizeTeamSlots(working.slots, charactersById)
          const next = currentSlots.map((existing, i) => {
            if (i === index) return characterId
            // The same character can't fill two slots
            return characterId != null && existing === characterId ? null : existing
          }) as TeamSlots
          const wasEmpty = currentSlots.every((existing) => existing == null)
          const filled = characterId != null && wasEmpty && index === 0
            ? autofillTeamSlots(next, characterId as CharacterId, new Set(getCharacters().map((c) => c.id)), customTeammateIds)
            : next
          if (!areTeamSlotsEqual(currentSlots, filled)) {
            working.slots = filled
            working.benchmarkSnapshot = undefined
            autofilled = filled.filter((id, i) => id != null && currentSlots[i] !== id && id !== characterId) as string[]
          }
          if (rosterAddedByScope.length > 0) runtimeContext.markDirty()
        }, changeOptions)
        const rosterAdded = rosterAddedByScope
        const working = readWorkingTeam()
        const summarySlots = working.slots.map((id) => (id != null ? getGameMetadata().characters[id]?.name ?? id : '空槽')).join(' / ')
        return toolResult(
          {
            action,
            op,
            rosterAdded,
            autofilled,
            workingTeam: serializeWorkingTeam(working),
          },
          `已设置工作队伍第 ${index} 槽为 ${
            characterId == null ? '空' : `${characterId}(${getGameMetadata().characters[characterId as CharacterId]?.name ?? characterId})`
          }:`
            + `${summarySlots}`
            + `${autofilled.length > 0 ? `;自动补队:${autofilled.join('、')}` : ''}`
            + `${rosterAdded.length > 0 ? `;已把 ${rosterAdded.join('、')} 按默认表单补进角色列表` : ''}`,
        )
      }

      if (op === 'reorder') {
        if (order == null) throw new Error('manage_team(compose reorder):必须提供 order(长度 4 的源下标排列)')
        if (new Set(order).size !== TEAM_SIZE) {
          throw new Error(`manage_team(compose reorder):order 必须是 0..${TEAM_SIZE - 1} 的一个排列(每个源槽位取一次),收到 [${order.join(', ')}]`)
        }
        await runtimeContext.withChange('manage_team:compose:reorder', () => {
          // reorderSlots keeps the working benchmark snapshot (order carries
          // meaning: slot 0 scores as main DPS, the rest as sub DPS).
          const working = readWorkingTeam()
          const next = normalizeTeamSlots(order.map((source) => working.slots[source] ?? null))
          if (!areTeamSlotsEqual(working.slots, next)) working.slots = next
        }, changeOptions)
        const working = readWorkingTeam()
        return toolResult(
          {
            action,
            op,
            workingTeam: serializeWorkingTeam(working),
          },
          `已重排工作队伍:${working.slots.map((id) => (id != null ? getGameMetadata().characters[id]?.name ?? id : '空槽')).join(' / ')}`,
        )
      }

      // op === 'clear'
      await runtimeContext.withChange('manage_team:compose:clear', () => {
        // clearTeam empties every slot and discards the synced snapshot; a
        // no-op when the team is already empty without a snapshot.
        const working = readWorkingTeam()
        const emptySlots = normalizeTeamSlots([])
        if (working.benchmarkSnapshot != null || !areTeamSlotsEqual(working.slots, emptySlots)) {
          working.slots = emptySlots
          working.benchmarkSnapshot = undefined
        }
      }, changeOptions)
      const working = readWorkingTeam()
      return toolResult(
        {
          action,
          op,
          workingTeam: serializeWorkingTeam(working),
        },
        '已清空工作队伍(基准快照已丢弃);已保存队伍不受影响',
      )
    }

    // action === 'sync_benchmarks'
    const syncResult = await runtimeContext.withChange('manage_team:sync_benchmarks', () => {
      const working = readWorkingTeam()
      const snapshot = captureSnapshotForSlots(working.slots)
      // applyBenchmarkSnapshot: the active saved team is resolved against the
      // CURRENT working state (before the new snapshot lands); when there is
      // one, the snapshot is written into it and debounced-saved, otherwise it
      // lives in working state only.
      const activeSavedTeamId = resolveActiveSavedTeamId(working)
      if (!areBenchmarkSnapshotsEqual(working.benchmarkSnapshot, snapshot)) {
        working.benchmarkSnapshot = snapshot
      }
      if (activeSavedTeamId != null) {
        writeSavedTeams(readSavedTeams().map((candidate) => candidate.id === activeSavedTeamId ? { ...candidate, benchmarkSnapshot: snapshot } : candidate))
        runtimeContext.markDirty()
      }
      return { snapshotSummary: serializeSnapshot(snapshot), savedTeamId: activeSavedTeamId }
    }, changeOptions)
    const working = readWorkingTeam()
    return toolResult(
      {
        action,
        snapshot: syncResult.snapshotSummary,
        savedTeamId: syncResult.savedTeamId,
        workingTeam: serializeWorkingTeam(working),
      },
      `已同步基准队伍,捕获 ${syncResult.snapshotSummary.members.length} 名成员快照`
        + `${syncResult.savedTeamId != null ? `,并写入已保存队伍 ${syncResult.savedTeamId}` : '(当前队伍没有对应的已保存队伍,快照仅存在于工作状态)'}`,
    )
  })
}
