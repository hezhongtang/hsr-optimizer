// Team audit domain: one call that answers "how good is this character's build,
// what is the best the inventory allows, and what to do next" (team_audit), and
// one that says which earlier audits a changed save has made stale (plan_diff).
//
// Neither tool has engine logic of its own. team_audit composes the existing
// tools in a fixed order (see ../teamAudit.ts) and reaches them through the
// in-process client (../loopback.ts); plan_diff recomputes the fingerprints an
// audit left behind. Neither edits a form. A save with no pending edits is not
// rewritten; pending edits flush before a search, as they do for optimize.
// team_audit does replace the server's latest optimize result.

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { callToolInProcess } from '../loopback'
import {
  runPlanDiff,
  runTeamAudit,
  type TeamAuditDeps,
} from '../teamAudit'
import { toolResult } from '../toolResult'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

// The web page gives up on a GPU search after this long.
const MAX_BUDGET_SECONDS = 540
const MAX_ROWS = 65536

let engineInfo: { gitCommit: string | null, serverBuiltAt: string | null } | null = null
// The commit and build time of the code that produced the numbers: results of
// different engine builds are not comparable.
function engineFingerprint() {
  if (engineInfo) return engineInfo
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url)
  let gitCommit: string | null = null
  let serverBuiltAt: string | null = null
  try {
    gitCommit = execFileSync('git', ['-C', dirname(entry), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // Not a git checkout: the build time alone still identifies the engine.
  }
  try {
    serverBuiltAt = statSync(entry).mtime.toISOString()
  } catch {
    // An entry that cannot be read leaves the build time unknown.
  }
  engineInfo = { gitCommit, serverBuiltAt }
  return engineInfo
}

function depsFor(extra: Any, label: string): TeamAuditDeps {
  const progressToken = extra._meta?.progressToken
  let step = 0
  const notify = (message: string) => {
    process.stderr.write(`[${label}] ${message}\n`)
    if (progressToken == null) return
    void extra.sendNotification({
      method: 'notifications/progress' as const,
      params: { progressToken, progress: ++step, message },
    } as Any).catch(() => {
      // Transport closing mid-run — progress is best-effort
    })
  }
  return {
    callTool: async (name, toolArgs) => {
      // optimize's own progress stays on the in-process client. An outer client
      // with the SDK's 60s timeout only resets that clock on notifications from
      // THIS call, and a GPU search emits none. A heartbeat inside the default
      // window keeps the outer call alive for the whole search.
      const heartbeat = setInterval(() => notify(`${name} 仍在运行`), 15_000)
      heartbeat.unref()
      try {
        const result = await callToolInProcess(name, toolArgs, { signal: extra.signal })
        // Every composed tool returns structuredContent; the text is its summary or its error.
        return { isError: result.isError, text: result.text, data: result.structuredContent }
      } finally {
        clearInterval(heartbeat)
      }
    },
    engineFingerprint,
    log: notify,
  }
}

const teammateSchema = z.object({
  characterId: z.string().describe('队友角色 id'),
  characterEidolon: z.number().int().min(0).max(6).optional().describe('星魂;缺省取该角色已保存表单的值,未持有时为 0'),
  lightCone: z.string().optional().describe('光锥 id;缺省取该角色已保存表单的光锥,未持有或表单无光锥时必须给'),
  lightConeSuperimposition: z.number().int().min(1).max(5).optional().describe('叠影;缺省取已保存表单的值,否则 1'),
})

const rosterEntrySchema = z.object({
  characterId: z.string(),
  owned: z.boolean().describe('存档里是否有这个角色'),
  characterEidolon: z.number().nullable(),
  lightCone: z.string().nullable(),
  lightConeSuperimposition: z.number().nullable(),
})

const fingerprintSchema = z.object({
  algorithm: z.string().optional(),
  hash: z.string().describe('可能参与本次审计的遗器集合的哈希(id、部位、套装、强化等级、主副词条、穿戴者)'),
  relicCount: z.number().int().optional(),
  scope: z.object({
    enhanceFloor: z.number(),
    grade: z.number(),
    relicSets: z.array(z.string()).nullable().describe('锁定的遗器套装;null 表示未锁'),
    ornaments: z.array(z.string()).nullable().describe('锁定的饰品套装;null 表示未锁'),
    mains: z.record(z.string(), z.array(z.string())).describe('各部位允许的主词条;空数组表示不限'),
  }).describe('这个哈希覆盖的遗器范围;plan_diff 按它在当前库存上重算'),
  savedOwnership: z.object({
    rankFilter: z.boolean(),
    includeEquippedRelics: z.boolean(),
    exclude: z.array(z.string()),
    characterOrder: z.array(z.string()).describe('存档里的角色 id,按排名从高到低'),
  }).optional().describe('审计时存档里的归属规则。排名、排除名单或「是否取用他人遗器」变了,范围内的遗器字节可以一个不变,结论已经过期'),
})

const engineSchema = z.object({
  gitCommit: z.string().nullable().describe('服务端代码所在仓库的提交;不在 git 仓库里时为 null'),
  serverBuiltAt: z.string().nullable().describe('服务端入口的构建时间'),
})

const anyRecord = z.record(z.string(), z.unknown())

export function registerTeamAuditTools(server: McpServer): void {
  server.registerTool('team_audit', {
    title: '单队一键审计',
    description: '对一个角色(可带最多 3 名队友)做一次完整审计,把原本要手工编排的几步合成一次调用,输出可逐项用底层工具复现:'
      + '当前配装的 COMBO(comboNow)、库存能配出的最优(comboBest 与前 N 行)、换装清单(零成本的、要从别的角色身上拿的、要先强化的)、'
      + '完全不占用其他角色遗器时的最优整套、值得强化的 +0 遗器、当前最优配装的短板部位与刷取目标、dps_score 评分,以及供 plan_diff 判断审计是否过期的指纹。'
      + '默认策略 tiered 不锁套装:第一遍穷尽已强化的遗器得到主榜单,第二遍在时间预算内放进尽可能多的 +0 遗器,只用来列「值得强化」的候选——'
      + 'guaranteed 是只换上这一件、按下限估值就已超过已强化最优的,potential 是下限落在容差带内且潜力评分的上限高于被替换件的。'
      + '两遍各出两个口径:priority 可取用排名靠后角色身上的遗器(表单自身的归属规则),free 不占用任何其他角色的遗器。'
      + 'strategy=locked 是按评分元数据锁套装和主词条、把排列数收紧到目标以内后只搜一次的旧策略。'
      + '不写表单。存档没有未落盘的修改时也不改写存档文件;已有未落盘修改时,搜索前会像 optimize 那样把它们写回。会顶掉服务端最近一次 optimize 的结果缓存(get_results 读的那份)。'
      + 'tiered 默认用 GPU 引擎(受管浏览器,需要本机 Chrome 与站点 dist),浏览器环境不齐时自动改用 CPU 并在 warnings 里说明;一次审计通常需要几十秒到两分钟。'
      + '客户端提供 progressToken 时按阶段发送进度通知。',
    inputSchema: {
      characterId: z.string().describe('被审计的角色 id,例如 "1212b1"'),
      teammates: z.array(teammateSchema).max(3).optional().describe(
        '队友(最多 3 名),覆盖已保存表单里的队友;不给时沿用已保存表单的队友。COMBO 对队友极敏感,跨角色或跨队比较前须统一',
      ),
      lightConeId: z.string().optional().describe('只用于已保存表单没有光锥的角色:指定光锥后按默认表单审计。已有光锥的角色要换光锥请走 formOverrides'),
      eidolon: z.number().int().min(0).max(6).optional().describe('与 lightConeId 一起用:星魂'),
      superimposition: z.number().int().min(1).max(5).optional().describe('与 lightConeId 一起用:叠影'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe('追加的表单覆盖(语义同 optimize 的 formOverrides),最后应用'),
      strategy: z.enum(['tiered', 'locked']).optional().describe(
        'tiered(默认)= 按强化等级分两遍搜;locked = 锁套装收紧后搜一次。autoTighten=false 且未指定时为 locked',
      ),
      autoTighten: z.boolean().optional().describe('只对 locked 策略有意义:false 时不收紧,按给定的表单覆盖原样搜一次'),
      budgetSeconds: z.number().min(0).max(MAX_BUDGET_SECONDS).default(60).describe(
        'tiered 第二遍(+0 遗器候选)的搜索时间预算,两个口径合计;预算越大放进来的 +0 遗器越多',
      ),
      leveledBudgetSeconds: z.number().min(0).max(MAX_BUDGET_SECONDS).default(300).describe(
        'tiered 第一遍每次搜索的时间上限;预计超出时提高引擎的加权强化次数门槛,并把该遍标为未穷尽',
      ),
      candidateRows: z.number().int().min(1).max(MAX_ROWS).default(2000).describe('tiered 第二遍为找 +0 候选而扫描的结果行数'),
      candidateTolerance: z.number().min(0).max(1).default(0.05).describe('+0 候选的下限估值最多可以比已强化最优低这么多(比例)仍被列为 potential'),
      resultsLimit: z.number().int().min(1).max(MAX_ROWS).default(50).describe('主榜单保留的行数'),
      enhanceFloor: z.number().int().min(0).max(15).default(0).describe('遗器强化等级下限;大于 0 时不做 +0 候选搜索'),
      targetPermutations: z.number().positive().optional().describe('只对 locked 策略有意义:自动收紧的目标排列数,默认 2e7'),
      engine: z.enum(['auto', 'cpu', 'gpu', 'gpu-experimental']).optional().describe('搜索引擎(语义同 optimize);tiered 默认 gpu,locked 默认 auto'),
      crossCheck: z.boolean().optional().describe('GPU 引擎下是否再用 CPU 搜一遍做对拍;默认不做(要付出整次 CPU 搜索的时间)'),
    },
    outputSchema: {
      tool: z.literal('team_audit'),
      status: z.enum(['completed', 'rejected', 'cancelled']).describe('rejected = 没有可搜索的空间或超出预算,原因见 reason'),
      reason: z.string().optional(),
      diagnosis: z.unknown().optional().describe('rejected 且有效排列为 0 时:optimize 的诊断清单'),
      strategy: z.enum(['tiered', 'locked']),
      characterId: z.string(),
      name: z.string().nullable().describe('元数据里的角色名;当前版本不认识这个 id 时为 null'),
      basis: anyRecord.describe('口径:表单来源、光锥与星魂、队友及其来源、角色排名、是否取用他人遗器、强化下限、主词条估值等级'),
      roster: z.array(rosterEntrySchema).describe('核心与队友在存档里的已保存状态(不受本次覆盖影响),plan_diff 用它判断名单是否变了'),
      engine: engineSchema,
      engineRequested: z.string().optional().describe('tiered:实际请求的搜索引擎'),
      permutations: z.object({
        initial: z.number().describe('不加任何限制时的有效排列数'),
        final: z.number().nullable().describe('主榜单那次搜索的有效排列数'),
        target: z.number().nullable(),
        gate: z.number().nullable(),
      }),
      tightenKnobs: anyRecord.describe('locked:可用的收紧手段'),
      tightenSteps: z.array(anyRecord).describe('locked:评估过的每个收紧组合及其排列数'),
      formOverrides: anyRecord.describe('主榜单那次搜索实际使用的表单覆盖'),
      optimize: anyRecord.optional().describe('主榜单那次搜索的引擎、耗时、已搜索数'),
      comboNow: z.number().nullable().optional().describe('当前配装的 COMBO(主词条按估值等级升满计)'),
      comboBest: z.number().nullable().optional().describe('主榜单榜首的 COMBO'),
      topRows: z.array(anyRecord).optional().describe('主榜单各行:COMBO、六件遗器 id、与其他角色的冲突、未强化到估值等级的部位'),
      zeroCostSwaps: z.array(anyRecord).nullable().optional().describe(
        '当前配装换成榜首行的逐件清单:换上/换下的遗器、现在被谁穿着、是否要先强化、单换这一件的 COMBO 变化(按遗器现状估值)',
      ),
      swapSummary: anyRecord.nullable().optional(),
      bestConflictFreeRow: anyRecord.nullable().optional().describe('不占用其他角色遗器的最优整套'),
      passes: z.array(anyRecord).optional().describe('tiered:每一遍搜索的口径、遗器池限制、排列数、耗时、是否穷尽'),
      worthLeveling: anyRecord.optional().describe('tiered:值得强化的 +0 遗器,按口径分列 guaranteed / potential,附估值口径与扫描覆盖范围'),
      farmAdvice: anyRecord.optional().describe('tiered:主榜单最优配装六件的评级与潜力、短板部位、应刷的套装与主词条、刷到同等水平的预计天数'),
      score: anyRecord.optional().describe('核心的 dps_score(评分队伍口径,与本次审计的队友口径不同)'),
      teammatesScores: z.array(anyRecord).optional(),
      inventoryFingerprint: fingerprintSchema.optional(),
      warnings: z.array(z.string()),
      calls: z.array(z.object({ name: z.string(), ok: z.boolean(), durationMs: z.number() })).describe('依次调用的底层工具'),
      timing: z.record(z.string(), z.number()),
    },
  }, async (args, extra) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const output = await runTeamAudit(args, depsFor(extra, 'team_audit'))
    const combo = (value: number | null | undefined) => (value == null ? '-' : Math.round(value).toLocaleString())
    return toolResult(
      output,
      `${output.name}(${output.characterId})审计${output.status === 'completed' ? '完成' : `未完成(${output.status}:${output.reason ?? ''})`}:`
        + `当前 COMBO ${combo(output.comboNow)},库存最优 ${combo(output.comboBest)}`
        + `${output.bestConflictFreeRow ? `,不占用他人遗器时 ${combo(output.bestConflictFreeRow.combo)}` : ''}`
        + `;${output.warnings.length} 条提示,用时 ${(output.timing.totalMs / 1000).toFixed(1)} 秒`,
    )
  })

  server.registerTool('plan_diff', {
    title: '审计过期判断',
    description: '判断此前的 team_audit 结果是否还对得上当前存档,用来决定哪些队伍需要重新审计。逐条比较三样:'
      + '可能参与那次搜索的遗器集合(按审计留下的范围在当前库存上重算哈希)、核心与队友的星魂/光锥/叠影、归属规则(角色排名顺序、rankFilter、exclude、是否取用他人遗器)、引擎。有 git 提交时比提交,否则比服务端入口的构建时间。'
      + '只比较指纹,不做任何搜索,通常在一秒内返回。把 team_audit 的输出原样放进 audits 即可(只读取 characterId、inventoryFingerprint、roster、engine)。'
      + '遗器范围是按宽口径划的:宁可多报变化,不会漏报。',
    inputSchema: {
      audits: z.array(
        z.object({
          key: z.string().optional().describe('这条审计的标识(例如队伍名);缺省为 "<characterId>#<序号>"'),
          characterId: z.string(),
          inventoryFingerprint: fingerprintSchema,
          roster: z.array(rosterEntrySchema).optional().describe('审计时的名单状态;不给则不比较名单'),
          engine: z.object({ gitCommit: z.string().nullable().optional() }).passthrough().optional(),
        }).passthrough(),
      ).min(1).max(100).describe('此前的 team_audit 输出(可原样传入,多余字段忽略)'),
    },
    outputSchema: {
      engine: engineSchema,
      audits: z.array(z.object({
        key: z.string(),
        characterId: z.string(),
        affected: z.boolean().describe('true = 这条审计已过期,应重新审计'),
        reasons: z.array(z.enum(['relicsChanged', 'rosterChanged', 'ownershipChanged', 'engineChanged'])),
        relics: z.object({
          changed: z.boolean(),
          baseline: z.object({ hash: z.string(), relicCount: z.number().nullable() }),
          current: z.object({ hash: z.string(), relicCount: z.number() }),
        }),
        rosterCompared: z.boolean(),
        rosterChanges: z.array(z.object({
          characterId: z.string(),
          field: z.string(),
          baseline: z.unknown(),
          current: z.unknown(),
        })),
      })),
      affected: z.array(z.string()).describe('已过期的审计的 key'),
      unaffected: z.array(z.string()),
    },
  }, async ({ audits }, extra) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()
    const output = await runPlanDiff({ audits }, depsFor(extra, 'plan_diff'))
    return toolResult(
      output,
      `${output.audits.length} 条审计中 ${output.affected.length} 条已过期`
        + `${output.affected.length ? `:${output.affected.join('、')}` : ''}`,
    )
  })
}
