// Calculators domain: pure calculator widgets from the web UI.
//
//   - warp_plan → 跃迁规划器 tab (#warp): calculateWarps over a WarpRequest
//   - calc_aha  → 计算器 tab (#aha): 阿哈速度计算器 — calculateAhaSpeed
//   - calc_ehr  → 计算器 tab (#ehr): 目标效果命中求解器 — calculateRequiredEhr
//
// All three are pure synchronous upstream functions with no optimizer/save
// coupling, so they run without a loaded save. Input normalization goes
// through the same upstream entry the web uses (normalizeWarpRequest for warp
// budgets; the calculator functions are applied verbatim). The only stateful
// touch is warp_plan's optional fromSaved=true, which replays the warp request
// persisted inside the loaded save file (load_save restores it into
// useWarpCalculatorStore exactly like the browser does).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  AHA_BASE_SPEED,
  calculateAhaSpeed,
  speedToContributionMultiplier,
} from 'lib/tabs/tabCalculators/ahaCalculations'
import { calculateRequiredEhr } from 'lib/tabs/tabCalculators/ehrCalculations'
import { useWarpCalculatorStore } from 'lib/tabs/tabWarp/useWarpCalculatorStore'
import {
  calculateWarps,
  normalizeWarpRequest,
  WarpIncomeOptions,
} from 'lib/tabs/tabWarp/warpCalculatorController'
import {
  EidolonLevel,
  PlannerMode,
  StarlightRefund,
  SuperimpositionLevel,
  WarpIncomeType,
} from 'lib/tabs/tabWarp/warpCalculatorTypes'
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

export function registerCalculatorsTools(server: McpServer): void {
  // ── warp_plan ───────────────────────────────────────────────────────────────
  server.registerTool('warp_plan', {
    title: '跃迁规划计算',
    description: '对应网页端「跃迁规划器」页签(#warp):输入现有星琼/星轨专票、版本收入与保底状态,'
      + '计算达成每个里程碑(E0S1、E1S1、…、E6S5)的期望抽数与成功概率,与网页端同一 calculateWarps 路径。'
      + '纯计算:不写存档、默认不需要已载入存档;fromSaved=true 时改用存档里保存的跃迁规划器请求作为底稿'
      + '(load_save 时随存档恢复,同网页端),此时必须先 load_save,其余传入字段覆盖底稿对应项。'
      + '收入选项 income 必须传返回体 incomeOptions / 报错信息里存在的 id(格式 `${版本}_p${半版本}_${档位数字}`,'
      + '档位 1=F2P/2=EXPRESS/3=BP_EXPRESS,如 4.5_p1_1;选项表随游戏版本手工维护),无效 id 会报错而不是被静默过滤。'
      + '注意 plannerMode 仅原样透传——网页端 simple 模式会强制改用 E6S5 快速目标,本工具始终按传入 targets 计算。'
      + 'milestoneResults 的键是里程碑标签(E0S1/E1S1/E6S5 或仅 S1/E0),warps 为到该里程碑的累计期望抽数,'
      + 'wins 为预算内达成的概率(0-1)。全部省略时返回默认请求(预算 0 抽)的结果,可用作查看收入选项。',
    inputSchema: {
      fromSaved: z.boolean().optional().describe('使用已载入存档中保存的跃迁规划请求作为底稿(需先 load_save)'),
      jades: z.number().min(0).optional().describe('当前星琼数量(160 星琼 = 1 抽)'),
      passes: z.number().min(0).optional().describe('当前星轨专票数量'),
      income: z.array(z.string()).optional().describe(
        '勾选的版本收入选项 id 列表(合法值见返回体 incomeOptions;每个版本分上下半(p1/p2)与三档:F2P/EXPRESS/BP_EXPRESS)',
      ),
      targets: z.array(warpTargetSchema).optional().describe('抽取目标列表(按数组顺序依次消耗预算,后者继承前者的保底进度)'),
      plannerMode: z.enum([PlannerMode.SIMPLE, PlannerMode.MULTI]).optional().describe('规划模式(仅透传回显,不影响本工具的计算)'),
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
    },
  }, async (input) => {
    runtimeContext.ensureMetadataReady()
    if (input.fromSaved === true) runtimeContext.requireSave()

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
      if (key !== 'fromSaved' && value !== undefined) provided[key] = value
    }
    const raw = input.fromSaved === true
      ? { ...useWarpCalculatorStore.getState().request, ...provided }
      : provided

    const request = normalizeWarpRequest(raw)
    const result = calculateWarps(request)

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
        }`,
    )
  })

  // ── calc_aha ────────────────────────────────────────────────────────────────
  server.registerTool('calc_aha', {
    title: '阿哈速度计算',
    description: '对应网页端「计算器」页签的阿哈速度计算器(#aha,calculateAhaSpeed 同源):'
      + '输入队友战斗速度,计算阿哈提供的速度 = 基速 80 + 队友贡献。队友按速度降序排名,'
      + '贡献系数第 1/2/3/4+ 名分别为 1/5、1/10、1/20、1/40(超过 4 名一律按 1/40)。'
      + '内部自动降序,无需按顺序传入;空数组返回基速 80。纯计算,不读写存档。',
    inputSchema: {
      speeds: z.array(z.number()).describe('队友战斗速度数组(网页端为 4 个槽位,空槽不传;内部自动降序)'),
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
    },
  }, async ({ speeds }) => {
    const ahaSpeed = calculateAhaSpeed(speeds)
    const sorted = [...speeds].sort((a, b) => b - a)
    const contributions = sorted.map((speed, rank) => ({
      rank: rank + 1,
      speed,
      multiplier: speedToContributionMultiplier(rank),
      contribution: speed * speedToContributionMultiplier(rank),
    }))

    return toolResult(
      {
        speeds,
        baseSpeed: AHA_BASE_SPEED,
        contributions,
        ahaSpeed,
      },
      `阿哈速度 = ${ahaSpeed}(基速 ${AHA_BASE_SPEED} + ${contributions.map((c) => c.contribution.toFixed(2)).join(' + ')})`,
    )
  })

  // ── calc_ehr ────────────────────────────────────────────────────────────────
  server.registerTool('calc_ehr', {
    title: '所需效果命中计算',
    description: '对应网页端「计算器」页签的减益施加计算器/目标效果命中求解器(#ehr,calculateRequiredEhr 同源):'
      + '给定敌方抗性与减益基础概率、施加次数和目标施加概率,反解所需的效果命中(%),使得 attempts 次内至少命中一次的概率达到 desiredHitRate。'
      + '全部输入均为百分数(如 120 表示 120%)。attempts 会被四舍五入取整且最小按 1 计。'
      + '不可达情形(基础概率 ≤ 0、敌方效果抵抗 = 100% 或减益抵抗 = 100%)上游返回 NaN,此处返回 achievable=false 与原因,requiredEhr 为 null(不是 0)。'
      + '返回 0 表示无需额外效果命中即可达标(上游对负需求钳到 0)。'
      + 'effectHitRate 是上游输入类型 EhrCalcInputs 的字段,但该求解不使用它(只影响网页端「每次施加/累计施加」面板),可不传。纯计算,不读写存档。',
    inputSchema: {
      effectRes: z.number().min(0).describe('敌方效果抵抗(%)'),
      debuffRes: z.number().min(0).describe('敌方减益抵抗(%)'),
      baseChance: z.number().min(0).describe('减益基础概率(%)(角色技能/光锥文案上的概率)'),
      attempts: z.number().positive().describe('施加次数(四舍五入取整,最小按 1)'),
      desiredHitRate: z.number().min(0).max(100).describe('目标施加概率(%):attempts 次内至少命中一次的目标概率'),
      effectHitRate: z.number().optional().describe('效果命中(%):上游类型携带但本求解不使用,可不传'),
    },
    // 可达/不可达两种形状:reasons/note 按分支 .optional()
    outputSchema: {
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
    },
  }, ({ effectRes, debuffRes, baseChance, attempts, desiredHitRate, effectHitRate }) => {
    const attemptsUsed = Math.max(1, Math.round(attempts))
    const requiredEhr = calculateRequiredEhr({
      effectRes,
      debuffRes,
      effectHitRate: effectHitRate ?? 0,
      baseChance,
      attempts,
      desiredHitRate,
    })

    if (Number.isNaN(requiredEhr)) {
      const reasons: string[] = []
      if (baseChance <= 0) reasons.push('减益基础概率 ≤ 0')
      if (effectRes >= 100) reasons.push('敌方效果抵抗 = 100%')
      if (debuffRes >= 100) reasons.push('敌方减益抵抗 = 100%')
      return toolResult(
        {
          requiredEhr: null,
          achievable: false,
          reasons,
          attemptsUsed,
          inputs: { effectRes, debuffRes, baseChance, attempts, desiredHitRate },
        },
        `目标不可达:${reasons.join('、') || '当前输入在数学上不可达'}——无论堆多少效果命中都无法达到 ${desiredHitRate}%`,
      )
    }

    return toolResult(
      {
        requiredEhr,
        achievable: true,
        attemptsUsed,
        inputs: { effectRes, debuffRes, baseChance, attempts, desiredHitRate },
        ...(requiredEhr === 0 ? { note: '所需效果命中为 0:不堆效果命中(或当前面板已达标)即可达到目标概率(上游对负需求钳到 0)' } : {}),
      },
      `需要效果命中 ${requiredEhr.toFixed(2)}%(${attemptsUsed} 次施加内至少命中一次的概率达到 ${desiredHitRate}%)`,
    )
  })
}
