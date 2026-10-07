// Calculators domain: pure calculator widgets from the web UI.
//
//   - warp_plan → 跃迁规划器 tab (#warp): calculateWarps over a WarpRequest
//   - calc_aha  → 计算器 tab (#aha): 阿哈速度计算器 — calculateAhaSpeed
//   - calc_ehr  → 计算器 tab (#ehr): 目标效果命中求解器 — calculateRequiredEhr
//
// All three are pure synchronous upstream functions with no optimizer/save
// coupling, so they run without a loaded save. Input normalization goes
// through the same upstream entry the web uses (normalizeWarpRequest for warp
// budgets; the calculator functions are applied verbatim). The stateful
// touches are all opt-in (M6-C):
//   - warp_plan fromSaved=true replays the warp request persisted inside the
//     loaded save file (load_save restores it into useWarpCalculatorStore
//     exactly like the browser does); save=true writes the request back
//     (saveKey `warpRequest`, the web's SaveState.delayedSave(10s) path);
//     applyPlannerMode=true re-creates the web's simple-mode view target and
//     normalizeTargets=true re-creates the web's target-chaining rules.
//   - calc_aha fromSaved=true / save=true read/write the aha panel draft
//     (saveKey `ahaSpeedTuner`); desiredAha mirrors the panel's reverse solver.
//   - calc_ehr mode=probability|grid are the panel's forward calculator and
//     effect-hit × effect-res grid (session-only inputs, never persisted).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { useAhaTuningStore } from 'lib/stores/ahaTuningStore'
import { getCharacterById } from 'lib/stores/character/characterStore'
import { EHR_TUNING_DEFAULTS } from 'lib/stores/ehrTuningStore'
import {
  AHA_BASE_SPEED,
  calculateAhaSpeed,
  calculateNextTeammateSpeed,
  speedToContributionMultiplier,
} from 'lib/tabs/tabCalculators/ahaCalculations'
import {
  calculateApplicationRate,
  calculatePerAttemptRate,
  calculateRequiredEhr,
} from 'lib/tabs/tabCalculators/ehrCalculations'
import { useWarpCalculatorStore } from 'lib/tabs/tabWarp/useWarpCalculatorStore'
import {
  calculateWarps,
  normalizeWarpRequest,
  WarpIncomeOptions,
} from 'lib/tabs/tabWarp/warpCalculatorController'
import {
  DEFAULT_WARP_TARGET,
  EidolonLevel,
  PlannerMode,
  StarlightRefund,
  SuperimpositionLevel,
  WarpIncomeType,
  type WarpTarget,
  WarpType,
} from 'lib/tabs/tabWarp/warpCalculatorTypes'
import { WARP_DIMENSIONS } from 'lib/tabs/tabWarp/warpDimensions'
import {
  getCharacterEidolonFloor,
  getLightConeSuperimpositionFloor,
} from 'lib/tabs/tabWarp/warpTargetMutations'
import { precisionRound } from 'lib/utils/mathUtils'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { toolResult } from '../toolResult'

// Income options are hand-maintained per game patch (see warpCalculatorController);
// surface them verbatim so agents never have to guess an id that silently filters away.
function incomeOptionSummaries() {
  return WarpIncomeOptions.map((option) => ({
    id: option.id,
    version: option.version,
    phase: option.phase,
    type: WarpIncomeType[option.type],
    passes: option.passes,
  }))
}

function pct(probability: number) {
  return `${(probability * 100).toFixed(1)}%`
}

// ─── EHR grid payload (mirror of ehrViz/EhrGrid.tsx's derived shape) ─────────

type EhrGridCell = {
  effectRes: number,
  rate: number,
  isCurrentColumn: boolean,
}

type EhrGridPayload = {
  windowHalf: number,
  centerEhr: number,
  windowMin: number,
  windowMax: number,
  nearestRes: number,
  effectResSteps: number[],
  rows: Array<{ ehr: number, isCurrentRow: boolean, cells: EhrGridCell[] }>,
}

// ─── warp target normalization (mirror of the web's mutation rules) ─────────
// The web maintains target chains through warpTargetMutations (addCharGoal /
// addLcGoal / addCharAndSignatureGoal → setTargets → reflowTargetChains):
// the owned level is shared by the whole chain, each row's FROM follows the
// previous row's TO, and goals landing at/below their FROM are popped to the
// next level. normalizeTargets=true replays those rules over the caller's raw
// target list. reflowTargetChains itself is not exported upstream, so the
// reflow below mirrors it 1:1 (warpTargetMutations.ts:187-230); the floor
// lookups and the owned-eidolon read reuse the exported upstream functions.

// Mirror of warpTargetMutations.ts:37-42 (getOwnedEidolon, not exported).
function getOwnedEidolon(characterId: string | null): EidolonLevel {
  if (!characterId) return EidolonLevel.NONE
  const form = getCharacterById(characterId as Parameters<typeof getCharacterById>[0])?.form
  if (!form) return EidolonLevel.NONE
  return form.characterEidolon as EidolonLevel
}

// Mirror of warpTargetMutations.ts:187-230 (reflowTargetChains → reflowChain).
function reflowWarpTargetChains(targets: WarpTarget[]): void {
  for (const dimension of [WARP_DIMENSIONS[WarpType.CHARACTER], WARP_DIMENSIONS[WarpType.LIGHTCONE]]) {
    const positionsById = new Map<string, number[]>()
    for (let i = 0; i < targets.length; i++) {
      const id = dimension.getId(targets[i])
      if (!id || dimension.getGoal(targets[i]) === dimension.none) continue
      const positions = positionsById.get(id) ?? []
      positions.push(i)
      positionsById.set(id, positions)
    }

    for (const positions of positionsById.values()) {
      let base = dimension.getCurrent(targets[positions[0]])
      for (const position of positions) {
        base = Math.min(base, dimension.getCurrent(targets[position]))
      }

      const sorted = positions
        .map((position) => targets[position])
        .sort((a, b) => dimension.getGoal(a) - dimension.getGoal(b))

      let previousGoal = base
      const reflowed = sorted.map((target) => {
        const from = previousGoal
        const goal = dimension.getGoal(target) <= from ? Math.min(from + 1, dimension.cap) : dimension.getGoal(target)
        previousGoal = goal
        return dimension.withLevels(target, from, goal)
      })

      positions.forEach((position, i) => {
        targets[position] = reflowed[i]
      })
    }
  }
}

type RawWarpTarget = Partial<WarpTarget> & { characterId?: string | null, lightConeId?: string | null }

/**
 * normalizeTargets=true: replay the web's target-list invariants over the
 * caller's raw targets BEFORE the regular normalizeWarpRequest pass:
 *   - omitted FROM/TO levels default like the web's add buttons — a character
 *     row starts at max(chain floor, the save's owned eidolon) and pulls one
 *     level (addCharGoal), a light-cone row starts at its chain floor and
 *     pulls one superimposition (addLcGoal, no save lookup — same as web);
 *   - rows without ids keep normalizeWarpRequest's defaults (E6S5 from zero);
 *   - both dimensions are then reflowed so same-id chains are head-to-tail.
 */
function normalizeWarpTargets(rawTargets: RawWarpTarget[]): WarpTarget[] {
  const materialized: WarpTarget[] = []
  for (const raw of rawTargets) {
    const index = materialized.length
    const entry = {
      id: raw.id ?? `target-${index + 1}`,
      characterId: raw.characterId ?? null,
      lightConeId: raw.lightConeId ?? null,
    } as WarpTarget

    if (entry.characterId != null) {
      const floor = getCharacterEidolonFloor(materialized, entry.characterId, index)
      const from = raw.currentEidolonLevel ?? Math.max(floor, getOwnedEidolon(entry.characterId))
      entry.currentEidolonLevel = from
      entry.targetEidolonLevel = raw.targetEidolonLevel ?? Math.min(from + 1, EidolonLevel.E6)
    } else {
      entry.currentEidolonLevel = raw.currentEidolonLevel ?? DEFAULT_WARP_TARGET.currentEidolonLevel
      entry.targetEidolonLevel = raw.targetEidolonLevel ?? DEFAULT_WARP_TARGET.targetEidolonLevel
    }

    if (entry.lightConeId != null) {
      const floor = getLightConeSuperimpositionFloor(materialized, entry.lightConeId, index)
      const from = raw.currentSuperimpositionLevel ?? floor
      entry.currentSuperimpositionLevel = from
      entry.targetSuperimpositionLevel = raw.targetSuperimpositionLevel ?? Math.min(from + 1, SuperimpositionLevel.S5)
    } else if (entry.characterId != null) {
      // addCharGoal semantics: a character row created by id alone pulls
      // eidolons only — no implicit S5 light-cone goal like the bare default.
      entry.currentSuperimpositionLevel = raw.currentSuperimpositionLevel ?? DEFAULT_WARP_TARGET.currentSuperimpositionLevel
      entry.targetSuperimpositionLevel = raw.targetSuperimpositionLevel ?? SuperimpositionLevel.NONE
    } else {
      entry.currentSuperimpositionLevel = raw.currentSuperimpositionLevel ?? DEFAULT_WARP_TARGET.currentSuperimpositionLevel
      entry.targetSuperimpositionLevel = raw.targetSuperimpositionLevel ?? DEFAULT_WARP_TARGET.targetSuperimpositionLevel
    }

    materialized.push(entry)
  }
  reflowWarpTargetChains(materialized)
  return materialized
}

// Mirror of WarpCalculatorTab.tsx:60-74: the web's simple-mode view swaps the
// target list for one built-in E6S5-from-zero goal (id 'quick-combined'); the
// strategy setting decides where S1 is inserted along the way.
function quickCombinedTarget(): WarpTarget {
  return {
    ...DEFAULT_WARP_TARGET,
    id: 'quick-combined',
    targetEidolonLevel: EidolonLevel.E6,
    targetSuperimpositionLevel: SuperimpositionLevel.S5,
    currentEidolonLevel: EidolonLevel.NONE,
    currentSuperimpositionLevel: SuperimpositionLevel.NONE,
  }
}

const warpTargetSchema = z.object({
  id: z.string().optional().describe('目标标识(省略时按序自动生成 target-N,仅用于展示/回显)'),
  characterId: z.string().nullable().optional().describe('展示用角色 id(计算本身不使用,传入则校验必须存在于游戏元数据)'),
  lightConeId: z.string().nullable().optional().describe('展示用光锥 id(计算本身不使用,传入则校验必须存在于游戏元数据)'),
  targetEidolonLevel: z.number().int().min(EidolonLevel.NONE).max(EidolonLevel.E6).optional().describe('目标星魂:-1=不抽角色,0=E0…6=E6(默认 6)'),
  targetSuperimpositionLevel: z.number().int().min(SuperimpositionLevel.NONE).max(SuperimpositionLevel.S5).optional().describe(
    '目标叠影:0=不抽光锥,1=S1…5=S5(默认 5)',
  ),
  currentEidolonLevel: z.number().int().min(EidolonLevel.NONE).max(EidolonLevel.E6).optional().describe(
    '已拥有的星魂:-1=未持有(从 E0 起抽),0=已有本体(从 E1 起抽)…',
  ),
  currentSuperimpositionLevel: z.number().int().min(SuperimpositionLevel.NONE).max(SuperimpositionLevel.S5).optional().describe(
    '已拥有的叠影:0=未持有(从 S1 起抽),1=已有 S1(从 S2 起抽)…',
  ),
})

// outputSchema 形状——以 handler 实际 return 的对象为准(normalizeWarpRequest /
// calculateWarps 的输出,EnrichedWarpRequest 与 WarpTargetResult 的上游类型契约)。
const normalizedWarpTargetSchema = z.object({
  id: z.string(),
  characterId: z.string().nullable(),
  lightConeId: z.string().nullable(),
  targetEidolonLevel: z.number(),
  targetSuperimpositionLevel: z.number(),
  currentEidolonLevel: z.number(),
  currentSuperimpositionLevel: z.number(),
})

const warpMilestoneSchema = z.object({ warps: z.number(), wins: z.number() })

const warpRequestSchema = z.object({
  warps: z.number(),
  totalStarlight: z.number(),
  totalPasses: z.number(),
  additionalPasses: z.number(),
  totalJade: z.number(),
  passes: z.number(),
  jades: z.number(),
  income: z.array(z.string()),
  targets: z.array(normalizedWarpTargetSchema),
  plannerMode: z.enum([PlannerMode.SIMPLE, PlannerMode.MULTI]),
  strategy: z.number(),
  starlight: z.enum([StarlightRefund.REFUND_NONE, StarlightRefund.REFUND_LOW, StarlightRefund.REFUND_AVG, StarlightRefund.REFUND_HIGH]),
  pityCharacter: z.number(),
  guaranteedCharacter: z.boolean(),
  pityLightCone: z.number(),
  guaranteedLightCone: z.boolean(),
})

// normalizeWarpRequest 的输出形状(未 enrich:没有 warps/total* 派生字段)——
// warp_plan(save=true) 持久化的是它(setRequest 收到的同款对象),不是计算用的 enriched 副本。
const normalizedWarpRequestSchema = warpRequestSchema.omit({
  warps: true,
  totalStarlight: true,
  totalPasses: true,
  additionalPasses: true,
  totalJade: true,
})

export function registerCalculatorsTools(server: McpServer): void {
  // ── warp_plan ───────────────────────────────────────────────────────────────
  server.registerTool('warp_plan', {
    title: '跃迁规划计算',
    description: '对应网页端「跃迁规划器」页签(#warp):输入现有星琼/星轨专票、版本收入与保底状态,'
      + '计算达成每个里程碑(E0S1、E1S1、…、E6S5)的期望抽数与成功概率,与网页端同一 calculateWarps 路径。'
      + '纯计算:默认不写存档、不需要已载入存档;fromSaved=true 时改用存档里保存的跃迁规划器请求作为底稿'
      + '(load_save 时随存档恢复,同网页端),此时必须先 load_save,其余传入字段覆盖底稿对应项。'
      + '收入选项 income 必须传返回体 incomeOptions / 报错信息里存在的 id(格式 `${版本}_p${半版本}_${档位数字}`,'
      + '档位 1=F2P/2=EXPRESS/3=BP_EXPRESS,如 4.5_p1_1;选项表随游戏版本手工维护),无效 id 会报错而不是被静默过滤。'
      + '默认(不传 applyPlannerMode)始终按传入 targets 计算,plannerMode 仅原样透传;'
      + 'applyPlannerMode=true 时按网页端「简单/多目标」模式语义计算:生效 plannerMode=simple(默认)时忽略 targets,'
      + '改用从零抽到 E6S5 的内置目标(id quick-combined),strategy 决定 S1 光锥插在哪一步——与网页端简单模式结果表同口径。'
      + 'normalizeTargets=true 时对传入 targets 复刻网页端目标编排的自动规则:同一角色/光锥的多个目标首尾相接'
      + '(后一行的起点接前一行的终点,已有等级为整条链共用),只给 characterId 的新目标起点取存档里该角色的星魂并默认+1,'
      + '只给 lightConeId 的新目标默认+1 叠影,目标等级落到起点或以下时自动顶到下一级(镜像上游 warpTargetMutations)。'
      + 'save=true 时把本次参与计算前的规范化请求写回存档的 warpRequest 键(网页端 onValuesChange → delayedSave 同一落点),需先 load_save。'
      + 'milestoneResults 的键是里程碑标签(E0S1/E1S1/E6S5 或仅 S1/E0),warps 为到该里程碑的累计期望抽数,'
      + 'wins 为预算内达成的概率(0-1)。全部省略时返回默认请求(预算 0 抽)的结果,可用作查看收入选项。',
    inputSchema: {
      fromSaved: z.boolean().optional().describe('使用已载入存档中保存的跃迁规划请求作为底稿(需先 load_save)'),
      save: z.boolean().optional().describe(
        '把本次的规范化请求(含 targets/plannerMode/strategy 与资源字段,不含 applyPlannerMode 的临时替换目标)写回存档的 warpRequest 键,'
          + '网页端打开跃迁规划器即见同值(需先 load_save;对应网页端每次改动后的 delayedSave 落盘)',
      ),
      applyPlannerMode: z.boolean().optional().describe(
        '按网页端规划模式语义计算:true 时若生效 plannerMode=simple(默认)则忽略 targets,改用从零到 E6S5 的内置快速目标;false/缺省按传入 targets 计算',
      ),
      normalizeTargets: z.boolean().optional().describe(
        'true 时对传入 targets 复刻网页端目标编排规则(同一角色/光锥目标首尾相接、新增角色目标从存档星魂起算默认+1、越级目标自动顶到下一级);'
          + '缺省时 targets 按调用方给出的最终形态直接使用',
      ),
      jades: z.number().min(0).optional().describe('当前星琼数量(160 星琼 = 1 抽)'),
      passes: z.number().min(0).optional().describe('当前星轨专票数量'),
      income: z.array(z.string()).optional().describe(
        '勾选的版本收入选项 id 列表(合法值见返回体 incomeOptions;每个版本分上下半(p1/p2)与三档:F2P/EXPRESS/BP_EXPRESS)',
      ),
      targets: z.array(warpTargetSchema).optional().describe('抽取目标列表(按数组顺序依次消耗预算,后者继承前者的保底进度)'),
      plannerMode: z.enum([PlannerMode.SIMPLE, PlannerMode.MULTI]).optional().describe(
        '规划模式:simple=简单(applyPlannerMode=true 时启用内置 E6S5 快速目标)/multi=多目标(默认 simple,与上游 DEFAULT_WARP_REQUEST 一致)',
      ),
      strategy: z.number().int().min(0).max(7).optional().describe('光锥插入策略:0-6 = 先把角色抽到该星魂等级再抽 S1 光锥;7 = 先抽 S1 光锥再补星魂(默认 0)'),
      starlight: z.enum([StarlightRefund.REFUND_NONE, StarlightRefund.REFUND_LOW, StarlightRefund.REFUND_AVG, StarlightRefund.REFUND_HIGH]).optional().describe(
        '星芒返利档位:无返利/低(4%)/平均(7.5%)/高(11%),按初始抽数折算额外专票(默认平均)',
      ),
      pityCharacter: z.number().int().min(0).max(89).optional().describe('角色池当前垫抽数(0-89,硬保底 90)'),
      guaranteedCharacter: z.boolean().optional().describe('角色池下一个五星是否大保底(必中当期)'),
      pityLightCone: z.number().int().min(0).max(79).optional().describe('光锥池当前垫抽数(0-79,硬保底 80)'),
      guaranteedLightCone: z.boolean().optional().describe('光锥池下一个五星是否大保底(必中当期)'),
    },
    outputSchema: {
      totalWarps: z.number(),
      incomeOptions: z.array(z.object({
        id: z.string(),
        version: z.string(),
        phase: z.number(),
        type: z.string(),
        passes: z.number(),
      })),
      request: warpRequestSchema,
      targetResults: z.array(z.object({
        target: normalizedWarpTargetSchema,
        milestoneResults: z.record(z.string(), warpMilestoneSchema),
        milestones: z.array(z.object({ label: z.string(), warps: z.number(), wins: z.number() })),
        finalMilestone: z.object({ label: z.string(), warps: z.number(), wins: z.number() }).nullable(),
      })),
      plannerModeApplied: z.boolean().optional().describe(
        '本次计算是否套用了网页端简单模式的内置 E6S5 快速目标(仅 applyPlannerMode=true 且生效模式为 simple 时为 true)',
      ),
      saved: z.boolean().optional().describe('save=true 时为 true:规范化请求已写回存档 warpRequest 键并标记待防抖落盘'),
      savedRequest: normalizedWarpRequestSchema.optional().describe('save=true 时实际持久化的规范化请求(不含简单模式的临时目标替换)'),
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()
    if (input.fromSaved === true || input.save === true) runtimeContext.requireSave()

    // Upstream normalizeWarpRequest silently drops income ids that are not in the
    // (per-patch, hand-maintained) WarpIncomeOptions table — reject them loudly instead.
    if (input.income != null) {
      const valid = new Set(WarpIncomeOptions.map((option) => option.id))
      const unknown = input.income.filter((id) => !valid.has(id))
      if (unknown.length > 0) {
        throw new Error(
          `未知的收入选项 id:${unknown.join(', ')}。合法 id(随游戏版本手工维护,当前 ${[...new Set(WarpIncomeOptions.map((o) => o.version))].join('/')}):`
            + `${WarpIncomeOptions.map((option) => `${option.id}(${option.passes}抽)`).join(', ')}`,
        )
      }
    }

    // Informational-only ids: the math never reads them, but a typo here would
    // silently persist into the echoed request — validate against game metadata.
    if (input.targets != null) {
      const characters = getGameMetadata().characters
      const lightCones = getGameMetadata().lightCones
      for (const target of input.targets) {
        if (target.characterId != null && !(target.characterId in characters)) {
          throw new Error(`targets 中未知角色 id:${target.characterId}(计算不使用该字段,但传入就必须是合法角色 id)`)
        }
        if (target.lightConeId != null && !(target.lightConeId in lightCones)) {
          throw new Error(`targets 中未知光锥 id:${target.lightConeId}(计算不使用该字段,但传入就必须是合法光锥 id)`)
        }
      }
    }

    const provided: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (key !== 'fromSaved' && key !== 'save' && key !== 'applyPlannerMode' && key !== 'normalizeTargets' && value !== undefined) {
        provided[key] = value
      }
    }
    if (input.normalizeTargets === true && input.targets != null) {
      provided.targets = normalizeWarpTargets(input.targets as RawWarpTarget[])
    }
    const raw = input.fromSaved === true
      ? { ...useWarpCalculatorStore.getState().request, ...provided }
      : provided

    const request = normalizeWarpRequest(raw)

    // Web simple-mode view (WarpCalculatorTab): the substitution is a VIEW-time
    // input to calculateWarps — the persisted request keeps the real targets.
    const plannerModeApplied = input.applyPlannerMode === true && request.plannerMode === PlannerMode.SIMPLE
    const result = calculateWarps(plannerModeApplied ? { ...request, targets: [quickCombinedTarget()] } : request)

    if (input.save === true) {
      await runtimeContext.withChange('warp_plan', () => {
        useWarpCalculatorStore.getState().setRequest(request)
        runtimeContext.markDirty()
      })
    }

    const targetSummaries = result.targetResults.map((targetResult) => {
      const milestones = Object.entries(targetResult.milestoneResults).map(([label, milestone]) => ({
        label,
        warps: milestone.warps,
        wins: milestone.wins,
      }))
      const final = milestones[milestones.length - 1]
      return {
        target: targetResult.target,
        milestoneResults: targetResult.milestoneResults,
        milestones,
        finalMilestone: final ?? null,
      }
    })

    return toolResult(
      {
        totalWarps: result.request.warps,
        incomeOptions: incomeOptionSummaries(),
        request: result.request,
        targetResults: targetSummaries,
        ...(plannerModeApplied ? { plannerModeApplied: true } : {}),
        ...(input.save === true ? { saved: true, savedRequest: request } : {}),
      },
      result.targetResults.length === 0
        ? `预算 ${result.request.warps} 抽(未提供目标,仅计算预算);收入选项当前 ${[...new Set(WarpIncomeOptions.map((o) => o.version))].join('/')}`
        : `预算 ${result.request.warps} 抽;${
          targetSummaries
            .map((t) =>
              `目标 ${t.target.id}${
                t.finalMilestone
                  ? ` 至 ${t.finalMilestone.label}:期望 ${t.finalMilestone.warps.toFixed(1)} 抽/概率 ${pct(t.finalMilestone.wins)}`
                  : '(无里程碑)'
              }`
            )
            .join(';')
        }${plannerModeApplied ? ';已按简单模式使用内置 E6S5 快速目标(quick-combined)' : ''}${input.save === true ? ';请求已写回存档 warpRequest' : ''}`,
    )
  })

  // ── calc_aha ────────────────────────────────────────────────────────────────
  server.registerTool('calc_aha', {
    title: '阿哈速度计算',
    description: '对应网页端「计算器」页签的阿哈速度计算器(#aha,calculateAhaSpeed 同源):'
      + '输入队友战斗速度,计算阿哈提供的速度 = 基速 80 + 队友贡献。队友按速度降序排名,'
      + '贡献系数第 1/2/3/4+ 名分别为 1/5、1/10、1/20、1/40(超过 4 名一律按 1/40)。'
      + '内部自动降序,无需按顺序传入;空数组返回基速 80。'
      + 'fromSaved=true 时改用存档里保存的阿哈面板底稿(ahaSpeedTuner 键,load_save 时随存档恢复,同网页端)作为速度来源,'
      + '显式传入的 speeds 覆盖底稿;save=true 时把本次输入写回该底稿(网页端填面板输入框后 delayedSave 的同一落点),两者都需先 load_save。'
      + 'desiredAha 给出时附带反解(calculateNextTeammateSpeed 同源):在已填队友基础上,再加一名队友至少需要多少速度才能达到目标阿哈速度;'
      + '四格已满时返回 noSlots(网页端显示「所有槽位均已占用」),当前已达标时返回 alreadyMet,其余返回 solved 及所需速度'
      + '(可为小数/负值,原样给出;网页端把绝对值小于 0.0005 的结果显示为 0)。纯计算默认不读写存档。',
    inputSchema: {
      speeds: z.array(z.number()).optional().describe(
        '队友战斗速度数组(网页端为 4 个槽位,空槽不传;内部自动降序)。缺省时需 fromSaved=true 从存档底稿取值',
      ),
      fromSaved: z.boolean().optional().describe('使用已载入存档中保存的阿哈面板底稿(ahaSpeedTuner)作为速度来源(需先 load_save;显式 speeds 优先)'),
      save: z.boolean().optional().describe(
        '把本次输入(速度按传入顺序写入 teammate0-3 槽位,空槽清空;desiredAha 未提供时保留底稿现值)写回存档 ahaSpeedTuner 键(需先 load_save)',
      ),
      desiredAha: z.number().optional().describe(
        '反解目标阿哈速度:给出时返回再加一名队友所需的最小速度(网页端「目标速度求解器」);'
          + 'fromSaved=true 时可省略——改用底稿里保存的目标值(网页端求解器输入与速度同存在一张持久表单里)',
      ),
    },
    outputSchema: {
      speeds: z.array(z.number()),
      baseSpeed: z.number(),
      contributions: z.array(z.object({
        rank: z.number().int(),
        speed: z.number(),
        multiplier: z.number(),
        contribution: z.number(),
      })),
      ahaSpeed: z.number(),
      solve: z.object({
        status: z.enum(['solved', 'alreadyMet', 'noSlots']),
        requiredSpeed: z.number().nullable(),
        targetAhaSpeed: z.number(),
        nextTeammatePosition: z.number().int(),
      }).optional().describe('desiredAha 反解结果(网页端「目标速度求解器」一节)'),
      draft: z.object({
        teammate0: z.union([z.number(), z.literal('')]),
        teammate1: z.union([z.number(), z.literal('')]),
        teammate2: z.union([z.number(), z.literal('')]),
        teammate3: z.union([z.number(), z.literal('')]),
        desiredAha: z.union([z.number(), z.literal('')]),
      }).optional().describe('存档中的阿哈面板底稿原值(fromSaved=true 或 save=true 时返回)'),
    },
  }, async (input) => {
    if (input.fromSaved === true || input.save === true) runtimeContext.requireSave()

    if (input.speeds == null && input.fromSaved !== true) {
      throw new Error('calc_aha: 缺少队友速度 — 请传 speeds 数组,或用 fromSaved=true 使用已载入存档的阿哈面板底稿(需先 load_save)')
    }

    const draft = useAhaTuningStore.getState()
    const speeds = input.speeds ?? [draft.teammate0, draft.teammate1, draft.teammate2, draft.teammate3]
      .filter((speed): speed is number => speed !== '')

    if (input.save === true) {
      if (speeds.length > 4) {
        throw new Error(`calc_aha(save=true): 队友速度最多 4 名(网页端只有 4 个槽位),实际收到 ${speeds.length} 名 — 请只保留前 4 名`)
      }
      const negative = speeds.filter((speed) => speed < 0)
      if (negative.length > 0) {
        throw new Error(`calc_aha(save=true): 队友速度不能为负(网页端输入框下限 0) — 含负值 ${negative.join(', ')}`)
      }
    }

    const ahaSpeed = calculateAhaSpeed(speeds)
    const sorted = [...speeds].sort((a, b) => b - a)
    const contributions = sorted.map((speed, rank) => ({
      rank: rank + 1,
      speed,
      multiplier: speedToContributionMultiplier(rank),
      contribution: speed * speedToContributionMultiplier(rank),
    }))

    // Reverse solve — mirrors AhaPanel/AhaPanelContent: 4 filled slots → no
    // result; current speed already ≥ target → alreadyMet (the web still shows
    // the computed value in that case, possibly 0 or negative). The target comes
    // from the call, falling back to the persisted draft when reading the draft
    // (the solver input lives in the same saved form on the web).
    const desiredAha = input.desiredAha
      ?? (input.fromSaved === true && typeof draft.desiredAha === 'number' ? draft.desiredAha : undefined)
    let solve: {
      status: 'solved' | 'alreadyMet' | 'noSlots',
      requiredSpeed: number | null,
      targetAhaSpeed: number,
      nextTeammatePosition: number,
    } | undefined
    if (desiredAha != null) {
      const noSlots = speeds.length >= 4
      solve = {
        status: noSlots ? 'noSlots' : ahaSpeed >= desiredAha ? 'alreadyMet' : 'solved',
        requiredSpeed: noSlots ? null : calculateNextTeammateSpeed(desiredAha, speeds),
        targetAhaSpeed: desiredAha,
        nextTeammatePosition: speeds.length + 1,
      }
    }

    let savedDraft: typeof draft | undefined
    if (input.save === true) {
      const next = {
        teammate0: speeds[0] ?? '',
        teammate1: speeds[1] ?? '',
        teammate2: speeds[2] ?? '',
        teammate3: speeds[3] ?? '',
        // desiredAha not provided → keep the draft's current value (the web
        // solver input lives in the same persisted form)
        desiredAha: input.desiredAha ?? draft.desiredAha,
      }
      await runtimeContext.withChange('calc_aha', () => {
        useAhaTuningStore.setState(next)
        runtimeContext.markDirty()
      })
      savedDraft = next
    } else if (input.fromSaved === true) {
      savedDraft = draft
    }

    return toolResult(
      {
        speeds,
        baseSpeed: AHA_BASE_SPEED,
        contributions,
        ahaSpeed,
        ...(solve != null ? { solve } : {}),
        ...(savedDraft != null ? { draft: savedDraft } : {}),
      },
      `阿哈速度 = ${ahaSpeed}(基速 ${AHA_BASE_SPEED} + ${contributions.map((c) => c.contribution.toFixed(2)).join(' + ')})`
        + (solve != null
          ? solve.status === 'noSlots'
            ? ';目标速度求解:所有槽位均已占用,没有空位'
            : solve.status === 'alreadyMet'
            ? `;目标速度求解:已达到目标速度 ${solve.targetAhaSpeed}(参考值 ${solve.requiredSpeed?.toFixed(2) ?? '-'})`
            : `;目标速度求解:第 ${solve.nextTeammatePosition} 名队友至少需要 ${solve.requiredSpeed?.toFixed(2)} 速度达到 ${solve.targetAhaSpeed}`
          : '')
        + (input.save === true ? ';输入已写回存档 ahaSpeedTuner' : ''),
    )
  })

  // ── calc_ehr ────────────────────────────────────────────────────────────────
  server.registerTool('calc_ehr', {
    title: '所需效果命中计算',
    description: '对应网页端「计算器」页签的减益施加计算器/目标效果命中求解器(#ehr,calculateRequiredEhr 同源),三种模式:'
      + '[默认反解] 给定敌方抗性与减益基础概率、施加次数和目标施加概率,反解所需的效果命中(%),使得 attempts 次内至少命中一次的概率达到 desiredHitRate。'
      + '全部输入均为百分数(如 120 表示 120%)。attempts 会被四舍五入取整且最小按 1 计。'
      + '不可达情形(基础概率 ≤ 0、敌方效果抵抗 = 100% 或减益抵抗 = 100%)上游返回 NaN,此处返回 achievable=false 与原因,requiredEhr 为 null(不是 0)。'
      + '返回 0 表示无需额外效果命中即可达标(上游对负需求钳到 0)。'
      + '[mode=probability] 网页端「减益施加计算器」的正向计算(calculatePerAttemptRate/calculateApplicationRate 同源):'
      + '给定 effectHitRate 算单次施加概率与 attempts 次内至少命中一次的累计概率,perAttempt/applicationProbability 为 0-1 口径,'
      + '同名 Percent 字段是网页端显示的 0-100 百分数(钳到 0-100,如 90 表示 90%)。'
      + '[mode=grid] 网页端公式下方的「效果命中 × 效果抵抗」对照表(EhrGrid 同源):行 = 以当前效果命中向下取到 5 的倍数为中心、'
      + '上下各展 windowHalf(10-100,10 的倍数,默认 50;下界不低于 0,步长 5),列 = 效果抵抗 0-80 每 10 一档,'
      + '每格为该组合下的施加概率(整数百分数,与网页端逐格一致);当前效果命中所在行与最接近当前效果抵抗的列带标记。'
      + '两种正向模式下 desiredHitRate 可省略(按面板默认 100 回显,反解块仍一并返回——网页端两块面板同屏共用同一组输入);'
      + 'effectHitRate 缺省按面板默认 50(反解模式仍不使用该值)。'
      + 'EHR 输入只在本次会话里保留,不写进存档(纯计算,不读写存档)。',
    inputSchema: {
      mode: z.enum(['solve', 'probability', 'grid']).optional().describe(
        '计算模式:solve=反解所需效果命中(默认);probability=给定效果命中算单次/累计施加概率;grid=效果命中×效果抵抗对照表',
      ),
      effectRes: z.number().min(0).describe('敌方效果抵抗(%)(grid 模式下用于标记最接近的当前列)'),
      debuffRes: z.number().min(0).describe('敌方减益抵抗(%)'),
      baseChance: z.number().min(0).describe('减益基础概率(%)(角色技能/光锥文案上的概率)'),
      attempts: z.number().positive().describe('施加次数(四舍五入取整,最小按 1)'),
      desiredHitRate: z.number().min(0).max(100).optional().describe(
        '目标施加概率(%):attempts 次内至少命中一次的目标概率(反解使用;probability/grid 模式可省略,按面板默认 100 回显)',
      ),
      effectHitRate: z.number().optional().describe(
        '效果命中(%):probability/grid 模式的核心输入(缺省按面板默认 50);solve 模式不使用(仅上游类型携带)',
      ),
      windowHalf: z.number().int().min(10).max(100).optional().describe(
        'grid 模式的「范围」:中心行上下各展开的效果命中幅度,10-100 且为 10 的倍数(默认 50,即 ±50%)',
      ),
    },
    // 可达/不可达两种形状:reasons/note 按分支 .optional();probability/grid 附加块同理
    outputSchema: {
      mode: z.enum(['solve', 'probability', 'grid']).optional().describe('本次使用的计算模式(echo)'),
      requiredEhr: z.number().nullable(),
      achievable: z.boolean(),
      reasons: z.array(z.string()).optional(),
      attemptsUsed: z.number().int(),
      inputs: z.object({
        effectRes: z.number(),
        debuffRes: z.number(),
        baseChance: z.number(),
        attempts: z.number(),
        desiredHitRate: z.number(),
      }),
      note: z.string().optional(),
      effectHitRate: z.number().optional().describe('probability/grid 模式实际使用的效果命中(%)(echo,含缺省补齐的面板默认值)'),
      perAttemptProbability: z.number().optional().describe('单次施加命中概率,0-1 口径(calculatePerAttemptRate 原始值,可能 >1)'),
      perAttemptPercent: z.number().optional().describe('单次施加命中概率,百分数 0-100(网页端「每次施加」显示值,钳到 0-100)'),
      applicationProbability: z.number().optional().describe('attempts 次内至少命中一次的概率,0-1 口径(calculateApplicationRate/100 原始值)'),
      applicationPercent: z.number().optional().describe('attempts 次内至少命中一次的概率,百分数 0-100(网页端主显示值,钳到 0-100)'),
      grid: z.object({
        windowHalf: z.number().int(),
        centerEhr: z.number().int().describe('中心行 = 当前效果命中向下取到 5 的倍数'),
        windowMin: z.number().int(),
        windowMax: z.number().int(),
        nearestRes: z.number().int().describe('最接近当前敌方效果抵抗的列(0-80 的 10 的倍数)'),
        effectResSteps: z.array(z.number().int()).describe('列序列(0-80 步长 10)'),
        rows: z.array(z.object({
          ehr: z.number().int(),
          isCurrentRow: z.boolean(),
          cells: z.array(z.object({
            effectRes: z.number().int(),
            rate: z.number().int().describe('该组合下的施加概率,整数百分数 0-100(与网页端表格逐格一致)'),
            isCurrentColumn: z.boolean(),
          })),
        })).describe('行从最高效果命中向最低排列(网页端自上而下)'),
      }).optional().describe('mode=grid 的对照表(EhrGrid 同源)'),
    },
  }, (input) => {
    const {
      effectRes,
      debuffRes,
      baseChance,
      attempts,
      effectHitRate: effectHitRateParam,
      windowHalf,
    } = input
    const mode = input.mode ?? 'solve'
    // 面板默认(EhrPanel 的 useEhrTuningStore 初值):desiredHitRate 100 / effectHitRate 50。
    // desiredHitRate 缺省取 100 —— 反解块在所有模式下都一并返回(网页端求解器与计算器同屏共用输入)。
    const desiredHitRate = input.desiredHitRate ?? EHR_TUNING_DEFAULTS.desiredHitRate
    const effectHitRate = effectHitRateParam ?? EHR_TUNING_DEFAULTS.effectHitRate

    if (windowHalf != null && windowHalf % 10 !== 0) {
      throw new Error(
        `calc_ehr: 字段 windowHalf 的值 ${windowHalf} 无效 — 「范围」只能是 10 的倍数(10/20/30/40/50/60/70/80/90/100),与网页端「网格范围」下拉一致`,
      )
    }

    const attemptsUsed = Math.max(1, Math.round(attempts))
    const requiredEhr = calculateRequiredEhr({
      effectRes,
      debuffRes,
      effectHitRate,
      baseChance,
      attempts,
      desiredHitRate,
    })

    // Forward block (probability + grid) — the panel's calculator section.
    const perAttempt = calculatePerAttemptRate({ effectRes, debuffRes, effectHitRate, baseChance, attempts })
    const application = calculateApplicationRate({ effectRes, debuffRes, effectHitRate, baseChance, attempts }) / 100
    const clampPercent = (value: number) => Math.min(100, Math.max(0, value))

    // Grid block — EhrGrid.tsx: snapped center row, ±windowHalf at step 5
    // (floored at 0), columns 0-80 step 10, integer-percent cells.
    let grid: EhrGridPayload | undefined
    if (mode === 'grid') {
      const half = windowHalf ?? 50
      const steps = [0, 10, 20, 30, 40, 50, 60, 70, 80]
      const centerEhr = Math.floor(effectHitRate / 5) * 5
      const windowMin = Math.max(0, centerEhr - half)
      const windowMax = centerEhr + half
      const nearestRes = steps.reduce((p, c) => Math.abs(c - effectRes) < Math.abs(p - effectRes) ? c : p)
      const rows: EhrGridPayload['rows'] = []
      for (let ehr = windowMax; ehr >= windowMin; ehr -= 5) {
        rows.push({
          ehr,
          isCurrentRow: ehr === centerEhr,
          cells: steps.map((res) => ({
            effectRes: res,
            rate: Math.round(precisionRound(clampPercent(calculateApplicationRate({
              baseChance,
              effectHitRate: ehr,
              effectRes: res,
              debuffRes,
              attempts,
            })))),
            isCurrentColumn: res === nearestRes,
          })),
        })
      }
      grid = { windowHalf: half, centerEhr, windowMin, windowMax, nearestRes, effectResSteps: steps, rows }
    }

    const forward = mode === 'solve'
      ? {}
      : {
        effectHitRate,
        perAttemptProbability: perAttempt,
        perAttemptPercent: clampPercent(perAttempt * 100),
        applicationProbability: application,
        applicationPercent: clampPercent(application * 100),
      }

    if (Number.isNaN(requiredEhr)) {
      const reasons: string[] = []
      if (baseChance <= 0) reasons.push('减益基础概率 ≤ 0')
      if (effectRes >= 100) reasons.push('敌方效果抵抗 = 100%')
      if (debuffRes >= 100) reasons.push('敌方减益抵抗 = 100%')
      return toolResult(
        {
          mode,
          requiredEhr: null,
          achievable: false,
          reasons,
          attemptsUsed,
          inputs: { effectRes, debuffRes, baseChance, attempts, desiredHitRate },
          ...forward,
          ...(grid != null ? { grid } : {}),
        },
        `目标不可达:${reasons.join('、') || '当前输入在数学上不可达'}——无论堆多少效果命中都无法达到 ${desiredHitRate}%`
          + (mode === 'probability' ? `；正向计算:单次 ${clampPercent(perAttempt * 100).toFixed(2)}%/累计 ${clampPercent(application * 100).toFixed(2)}%` : '')
          + (mode === 'grid' ? `;对照表 ${grid?.rows.length} 行 × ${grid?.effectResSteps.length} 列` : ''),
      )
    }

    return toolResult(
      {
        mode,
        requiredEhr,
        achievable: true,
        attemptsUsed,
        inputs: { effectRes, debuffRes, baseChance, attempts, desiredHitRate },
        ...(requiredEhr === 0 ? { note: '所需效果命中为 0:不堆效果命中(或当前面板已达标)即可达到目标概率(上游对负需求钳到 0)' } : {}),
        ...forward,
        ...(grid != null ? { grid } : {}),
      },
      mode === 'probability'
        ? `施加概率:单次 ${clampPercent(perAttempt * 100).toFixed(2)}%,${attemptsUsed} 次内至少一次 ${clampPercent(application * 100).toFixed(2)}%`
          + `(反解:达到 ${desiredHitRate}% 需要效果命中 ${requiredEhr.toFixed(2)}%)`
        : mode === 'grid'
        ? `对照表:${grid?.rows.length} 行(效果命中 ${grid?.windowMax} → ${grid?.windowMin})× ${grid?.effectResSteps.length} 列(效果抵抗 0-80),`
          + `当前格(效果命中 ${grid?.centerEhr} × 抵抗 ${grid?.nearestRes})施加概率 ${
            grid?.rows.find((row) => row.isCurrentRow)?.cells.find((cell) => cell.isCurrentColumn)?.rate ?? '-'
          }%`
        : `需要效果命中 ${requiredEhr.toFixed(2)}%(${attemptsUsed} 次施加内至少命中一次的概率达到 ${desiredHitRate}%)`,
    )
  })
}
