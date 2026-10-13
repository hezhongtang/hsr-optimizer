// Number refresh for a team plan (Mode A of docs/03-增量更新设计.md): asks plan_diff
// which of the plan's earlier audits no longer describe the save, re-runs
// team_audit for those teams only, and rewrites the plan's report. No LLM takes
// part: every number in the report is a field of a stored team_audit result.
// Read-only: the save is copied into a temporary state file per run and never written.
//
// Usage: node scripts/plan-refresh.mjs --plan <plan.json> [options]
//   --plan <file>        the plan (see below)
//   --state-dir <dir>    where the audits and the report are kept
//                        (default: next to the plan, "<plan name>.audits")
//   --save <file>        save file; overrides the plan's "save"
//   --all                re-audit every team, stale or not
//   --only <key,…>       consider only these teams; the others keep their stored audit
//   --dry-run            report which teams are stale and stop: no audit, nothing written
//   --ignore-engine      do not re-audit a team whose only change is the engine build
//                        (every new commit of this repository counts as one)
//   --server <entry>     server entry, relative to mcp/ (default dist/index.js)
//   --verbose            forward server stderr
// Relative paths on the command line resolve against the working directory.
//
// The plan is a JSON file:
//   {
//     "title": "…",                       optional, heads the report
//     "save": "…/fribbels-optimizer-save.json",   optional, relative to the plan file;
//                                         default mcp/profile/fribbels-optimizer-save.json
//     "defaults": { … },                  optional team_audit arguments for every team
//     "teams": [
//       { "key": "dot",                   names the stored audit; letters, digits, . _ -
//         "title": "…",                   optional
//         "characterId": "1307b1",        the audited core
//         "teammates": [{ "characterId": "1005b1" }, …],   as team_audit takes them
//         "audit": { … } }                optional team_audit arguments for this team
//     ]
//   }
// A team is re-audited when it has no stored audit, when its entry in the plan
// changed, or when plan_diff reports its stored audit stale.
//
// Prints a JSON summary on stdout. Exit code: 0 = every considered team is up to
// date (--dry-run always exits 0: read `outcome: "pending"` in the summary), 2 = an audit did not complete (its previous audit is kept),
// 1 = the run itself failed.
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const CALL_TIMEOUT_MS = 30 * 60 * 1000
// plan_diff takes at most this many audits per call.
const PLAN_DIFF_BATCH = 100
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PARTS = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope']
const LISTED_CANDIDATES = 5

function log(...parts) {
  process.stderr.write(`[plan-refresh] ${parts.join(' ')}\n`)
}

function parseArgs(argv) {
  const args = { server: 'dist/index.js', all: false, dryRun: false, ignoreEngine: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} 缺少取值`)
      return argv[++i]
    }
    if (flag === '--plan') args.plan = resolve(value())
    else if (flag === '--state-dir') args.stateDir = resolve(value())
    else if (flag === '--save') args.save = resolve(value())
    else if (flag === '--only') args.only = value().split(',').filter(Boolean)
    else if (flag === '--server') args.server = value()
    else if (flag === '--all') args.all = true
    else if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--ignore-engine') args.ignoreEngine = true
    else if (flag === '--verbose') args.verbose = true
    else throw new Error(`未知参数 ${flag}(用法见脚本头部注释)`)
  }
  if (!args.plan) throw new Error('缺少 --plan <计划文件>')
  return args
}

const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value)

function loadPlan(args) {
  const plan = JSON.parse(readFileSync(args.plan, 'utf8'))
  if (!isRecord(plan) || !Array.isArray(plan.teams) || plan.teams.length === 0) throw new Error('计划文件需要非空的 teams 数组')
  if (plan.defaults != null && !isRecord(plan.defaults)) throw new Error('计划文件的 defaults 须为对象')
  const seen = new Set()
  for (const team of plan.teams) {
    if (!isRecord(team) || typeof team.key !== 'string' || !KEY_PATTERN.test(team.key)) {
      throw new Error(`队伍 key 须由字母、数字和 . _ - 组成且不以符号开头,实际 ${JSON.stringify(team?.key)}`)
    }
    // Keys become file names; a case-insensitive file system would merge "Dot" and "dot".
    if (seen.has(team.key.toLowerCase())) throw new Error(`队伍 key 重复:${team.key}`)
    seen.add(team.key.toLowerCase())
    if (typeof team.characterId !== 'string' || !team.characterId) throw new Error(`队伍 ${team.key} 缺少 characterId`)
    if (team.audit != null && !isRecord(team.audit)) throw new Error(`队伍 ${team.key} 的 audit 须为对象`)
  }
  for (const key of args.only ?? []) {
    if (!plan.teams.some((team) => team.key === key)) throw new Error(`--only 指定的队伍不在计划里:${key}`)
  }
  const save = args.save
    ?? (typeof plan.save === 'string' ? resolve(dirname(args.plan), plan.save) : resolve(mcpDir, 'profile/fribbels-optimizer-save.json'))
  const stateDir = args.stateDir ?? resolve(dirname(args.plan), `${basename(args.plan).replace(/\.json$/i, '')}.audits`)
  return { plan, save, stateDir }
}

// The team_audit arguments of a team. Stored with the audit: a team whose
// request changed is stale whatever the save looks like.
function requestOf(plan, team) {
  return {
    ...plan.defaults,
    ...team.audit,
    characterId: team.characterId,
    ...(team.teammates != null && { teammates: team.teammates }),
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
const sameRequest = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// The numbers the report compares between two audits of the same team.
function headlineOf(audit) {
  return {
    comboNow: finite(audit.comboNow),
    comboBest: finite(audit.comboBest),
    comboConflictFree: finite(audit.bestConflictFreeRow?.combo),
    scorePercent: finite(audit.score?.percent),
    scoreGrade: typeof audit.score?.grade === 'string' ? audit.score.grade : null,
  }
}

function readState(stateDir, key) {
  const path = resolve(stateDir, `${key}.json`)
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(state?.audit) || !isRecord(state.audit.inventoryFingerprint)) throw new Error(`${path} 不是本脚本写出的审计记录`)
  return state
}

// A run that dies mid-write must not leave a truncated record behind.
function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

// ---- Report ----------------------------------------------------------------

const int = (value) => (finite(value) == null ? '—' : Math.round(value).toLocaleString('en-US'))
const signed = (value) => {
  if (finite(value) == null) return '—'
  const rounded = Math.round(value) || 0
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`
}
const percent = (ratio, digits = 1) => (finite(ratio) == null ? '—' : `${(ratio * 100).toFixed(digits)}%`)
const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
]
const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 16).replace('T', ' ') : '—')

const REASON_TEXT = {
  new: '首次审计',
  planChanged: '计划里的队伍配置变了',
  forced: '--all 强制',
  relicsChanged: '范围内的遗器变了',
  rosterChanged: '成员的星魂/光锥/叠影变了',
  ownershipChanged: '归属规则变了',
  engineChanged: '引擎版本变了',
}
const reasonText = (reasons) => reasons.map((reason) => REASON_TEXT[reason] ?? reason).join('、')

function withDelta(now, before) {
  if (finite(now) == null) return '—'
  if (finite(before) == null || Math.round(now) === Math.round(before)) return int(now)
  return `${int(now)} (${signed(now - before)})`
}

function statusText(entry) {
  if (entry.outcome === 'audited') return `已刷新:${reasonText(entry.reasons)}`
  if (entry.outcome === 'failed') return `刷新失败(${String(entry.failure).replaceAll('\n', ' ')}),${entry.state ? '沿用上次审计' : '尚无审计'}`
  if (entry.outcome === 'pending') return `待刷新:${reasonText(entry.reasons)}`
  if (entry.ignoredReasons.length) return `沿用(忽略:${reasonText(entry.ignoredReasons)})`
  if (entry.planChangedOutOfScope) return '沿用旧配置的审计(计划里这一队已改,不在本次范围)'
  return entry.state ? '沿用' : '尚未审计'
}

function memberText(member, names) {
  const name = names.get(member.characterId)
  const build = member.owned
    ? `E${member.characterEidolon ?? '?'} · 光锥 ${member.lightCone ?? '无'}${member.lightCone ? ` S${member.lightConeSuperimposition ?? '?'}` : ''}`
    : '未持有'
  return `${name ? `${name}(${member.characterId})` : member.characterId} ${build}`
}

function pieceText(relicId, enhance, pieces) {
  const piece = pieces.get(relicId)
  return piece ? `${relicId}(${piece.set} · ${piece.mainStat} · +${piece.enhance})` : `${relicId}${enhance == null ? '' : `(+${enhance})`}`
}

function swapRows(swaps, pieces, names, withDeltaColumn) {
  return swaps.map((swap) => [
    swap.slot,
    pieceText(swap.addRelicId, swap.addEnhance, pieces),
    swap.removeRelicId ?? '(空)',
    swap.heldBy ? (names.get(swap.heldBy) ? `${names.get(swap.heldBy)}(${swap.heldBy})` : swap.heldBy) : '无人',
    swap.needsLeveling ? '要' : '否',
    ...(withDeltaColumn ? [signed(swap.deltaComboAsIs)] : []),
  ])
}

const wholePercent = (value) => (finite(value) == null ? '—' : `${value.toFixed(0)}%`)

function candidateRows(candidates, names) {
  return candidates.slice(0, LISTED_CANDIDATES).map((candidate) => [
    candidate.slot,
    `${candidate.relicId}(${candidate.set} · ${candidate.mainStat})`,
    candidate.replaces ? `${candidate.replaces.relicId}${candidate.replaces.rating == null ? '' : `(${candidate.replaces.rating})`}` : '—',
    finite(candidate.deltaVsLeveledBestPercent) == null
      ? '—'
      : `${candidate.deltaVsLeveledBestPercent > 0 ? '+' : ''}${candidate.deltaVsLeveledBestPercent.toFixed(2)}%`,
    `${wholePercent(candidate.potentialAveragePercent)} / ${wholePercent(candidate.potentialBestPercent)}`,
    candidate.heldBy ? (names.get(candidate.heldBy) ? `${names.get(candidate.heldBy)}(${candidate.heldBy})` : candidate.heldBy) : '无人',
  ])
}

// The numbers shown for a team belong to the core its stored audit ran for.
const coreOf = (entry) => entry.state?.audit?.characterId ?? entry.team.characterId

function teamSection(entry, names) {
  const { team, state } = entry
  const lines = [`## ${team.title ?? team.key}`, '']
  if (!state) {
    lines.push(`\`${team.key}\` · 核心 ${names.get(team.characterId) ?? team.characterId} · ${statusText(entry)}`, '')
    return lines
  }
  const { audit } = state
  const [core, ...teammates] = audit.roster ?? []
  const pieces = new Map((audit.farmAdvice?.pieces ?? []).map((piece) => [piece.relicId, piece]))
  // The search behind the main ranking: priority when it ran, else free.
  const searched = (audit.passes ?? []).filter((pass) => pass.pass === 'leveled' && pass.durationMs != null && !pass.skipped)
  const mainPass = searched.find((pass) => pass.variant === 'priority') ?? searched[0]
  lines.push(
    `- 标识 \`${team.key}\` · 状态:${statusText(entry)} · 审计于 ${day(state.auditedAt)}`,
    `- 核心:${core ? memberText(core, names) : team.characterId}`,
    `- 队友(${audit.basis?.teammatesSource ?? '?'}):${teammates.length ? teammates.map((member) => memberText(member, names)).join(';') : '未设'}`,
    `- 口径:策略 ${audit.strategy} · 引擎 ${audit.optimize?.actualEngine ?? audit.optimize?.engine ?? '?'} · 主榜单排列数 ${int(audit.permutations?.final)}`
      + `${mainPass ? ` · ${mainPass.exhaustive ? '已穷尽已强化遗器' : '未穷尽(提高了加权强化次数门槛)'}` : ''} · 强化下限 +${audit.basis?.enhanceFloor ?? 0}`,
    `- COMBO:当前 ${int(audit.comboNow)} → 库存最优 ${int(audit.comboBest)}`
      + `${audit.bestConflictFreeRow ? ` · 不占用其他角色遗器时 ${int(audit.bestConflictFreeRow.combo)}` : ''}`,
    '',
  )

  if (audit.zeroCostSwaps?.length) {
    const summary = audit.swapSummary
    lines.push(
      '### 换装清单(当前配装 → 库存最优)',
      '',
      ...(summary
        ? [
          `零成本 ${summary.zeroCostSwaps} 件 · 要从别的角色身上拿 ${summary.contestedSwaps} 件 · 要先强化 ${summary.needsLevelingSwaps} 件。「单换 ΔCOMBO」按遗器现状估值。`,
          '',
        ]
        : []),
      ...table(['部位', '换上', '换下', '现穿戴者', '要先强化', '单换 ΔCOMBO'], swapRows(audit.zeroCostSwaps, pieces, names, true)),
      '',
    )
  } else if (audit.swapSummary) {
    lines.push('当前配装已是库存最优,没有可换的遗器。', '')
  } else if (finite(audit.comboBest) == null) {
    lines.push('搜索没有结果行(属性或评分过滤可能过严),给不出换装建议。', '')
  }

  const free = audit.bestConflictFreeRow
  if (free && !free.isCurrentBuild && free.swaps?.length) {
    lines.push(
      `### 不占用其他角色遗器的最优整套(COMBO ${int(free.combo)},较当前 ${signed(free.deltaVsNow)})`,
      '',
      ...table(['部位', '换上', '换下', '现穿戴者', '要先强化'], swapRows(free.swaps, pieces, names, false)),
      '',
    )
  }

  for (const [variant, label] of [['free', '不占用其他角色'], ['priority', '可取用排名靠后角色的遗器']]) {
    const report = audit.worthLeveling?.variants?.[variant]
    if (!report || report.skipped) continue
    for (const [kind, kindLabel] of [['guaranteed', '保底就超过已强化最优'], ['potential', '有潜力']]) {
      const candidates = report[kind] ?? []
      if (!candidates.length) continue
      lines.push(
        `### 值得强化的 +0 遗器 · ${label} · ${kindLabel}(${candidates.length} 件${candidates.length > LISTED_CANDIDATES ? `,列前 ${LISTED_CANDIDATES}` : ''})`,
        '',
        ...table(['部位', '遗器', '替换', '保底较已强化最优', '潜力 平均/最好', '现穿戴者'], candidateRows(candidates, names)),
        '',
      )
    }
  }

  const targets = audit.farmAdvice?.targets ?? []
  if (targets.length) {
    lines.push(
      '### 刷取目标',
      '',
      ...table(
        ['部位', '来源', '套装', '主词条', '现评级', '预计天数', '原因'],
        targets.map((target) => [
          target.slot,
          target.source,
          target.sets.join(' / '),
          target.mainStats.join(' / '),
          `${target.currentRating}(${target.currentPercent}%)`,
          finite(target.estTbpDays) == null ? '—' : target.estTbpDays.toFixed(1),
          target.reason,
        ]),
      ),
      '',
    )
  }

  if (audit.warnings?.length) lines.push('### 提示', '', ...audit.warnings.map((warning) => `- ${warning}`), '')
  return lines
}

function renderReport({ plan, save, entries, names, engine, generatedAt, dryRun }) {
  const refreshed = entries.filter((entry) => entry.outcome === 'audited').length
  const failed = entries.filter((entry) => entry.outcome === 'failed').length
  const lines = [
    `# ${plan.title ?? '配队方案'} · 数字刷新`,
    '',
    `> 由 \`plan-refresh\` 生成于 ${day(generatedAt)}(UTC),请勿手改:下次刷新会整份重写。`,
    `> 存档 \`${save}\` · 引擎 ${engine ? `${engine.gitCommit?.slice(0, 8) ?? '非 git 构建'}(构建于 ${day(engine.serverBuiltAt)})` : '未知'}`,
    `> 本次${dryRun ? '只检查未刷新' : `刷新 ${refreshed} 队${failed ? `、失败 ${failed} 队` : ''}`},共 ${entries.length} 队。`
    + '括号里是与该队上一次审计的差值。COMBO 是单角色连招伤害,对队友口径极敏感:同一队前后可比,跨队不可比。',
    '',
    '## 总览',
    '',
    ...table(
      ['队伍', '核心', '当前 COMBO', '库存最优', '可提升', '不占用他人遗器', '评分', '审计时间', '状态'],
      entries.map((entry) => {
        const now = entry.state ? headlineOf(entry.state.audit) : {}
        const before = entry.state?.previous ?? {}
        const headroom = finite(now.comboNow) != null && finite(now.comboBest) != null && now.comboNow > 0
          ? `${((now.comboBest / now.comboNow - 1) * 100).toFixed(1)}%`
          : '—'
        return [
          entry.team.title ?? entry.team.key,
          names.get(coreOf(entry)) ?? coreOf(entry),
          withDelta(now.comboNow, before.comboNow),
          withDelta(now.comboBest, before.comboBest),
          headroom,
          withDelta(now.comboConflictFree, before.comboConflictFree),
          finite(now.scorePercent) == null ? '—' : `${percent(now.scorePercent)} ${now.scoreGrade ?? ''}`.trim(),
          day(entry.state?.auditedAt),
          statusText(entry),
        ]
      }),
    ),
    '',
  ]
  for (const entry of entries) lines.push(...teamSection(entry, names))
  return `${lines.join('\n').trimEnd()}\n\n${contentsMark(plan, entries)}\n`
}

// What the report was rendered from: the plan's titles and order, and which
// audit of each team. A report whose mark differs no longer matches the records.
function contentsMark(plan, entries) {
  // A failure or an out-of-scope plan change is part of what the report says about a team.
  const flag = (entry) => (entry.outcome === 'failed' ? 'failed' : entry.planChangedOutOfScope ? 'planChanged' : null)
  const contents = [plan.title ?? null, ...entries.map((entry) => [entry.team.key, entry.team.title ?? null, entry.state?.auditedAt ?? null, flag(entry)])]
  return `<!-- plan-refresh:${createHash('sha1').update(JSON.stringify(contents)).digest('hex').slice(0, 16)} -->`
}

// ---- Run -------------------------------------------------------------------

async function main(args) {
  const { plan, save, stateDir } = loadPlan(args)
  const entries = plan.teams.map((team) => {
    const considered = !args.only || args.only.includes(team.key)
    let state = null
    try {
      state = readState(stateDir, team.key)
    } catch (error) {
      // A record this run would overwrite has to be one of ours; one it only reports can be left out.
      if (considered) throw error
      log(`${team.key} 的审计记录读不出来,报告里按尚未审计处理:${error.message}`)
    }
    return {
      team,
      request: requestOf(plan, team),
      state,
      considered,
      // The stored audit answers an older version of this team's plan entry, and this run leaves it alone.
      planChangedOutOfScope: !considered && state != null && !sameRequest(state.request, requestOf(plan, team)),
      reasons: [],
      ignoredReasons: [],
      outcome: 'kept',
      failure: null,
    }
  })

  const client = new Client({ name: 'plan-refresh', version: '0.0.0' })
  // The server reads and writes its localStorage file backend; seeding a private
  // copy keeps the real save untouched.
  const tempDir = mkdtempSync(`${tmpdir()}/hsr-plan-refresh-`)
  const statePath = `${tempDir}/state.json`
  const removeTempDir = () => rmSync(tempDir, { recursive: true, force: true })
  // A signal skips the finally block, and the state file is a full copy of the
  // save. The server flushes that file as it exits, so it has to be gone first.
  const onSignal = () => {
    client.close().catch(() => {}).finally(() => {
      removeTempDir()
      process.exit(1)
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(mcpDir, args.server)],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: statePath },
    stderr: 'pipe',
    // Long result tables exceed the default buffer.
    maxBufferSize: 128 * 1024 * 1024,
  })
  const call = async (name, toolArgs = {}, onprogress) => {
    const result = await client.callTool({ name, arguments: toolArgs }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      ...(onprogress && { onprogress }),
    })
    if (result.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? `${name} 返回错误但没有内容`)
    return result.structuredContent
  }

  try {
    writeFileSync(statePath, JSON.stringify({ state: readFileSync(save, 'utf8') }))
    await client.connect(transport)
    // The pipe must be drained or a chatty server blocks on a full buffer.
    transport.stderr?.on('data', (chunk) => {
      if (args.verbose) process.stderr.write(chunk)
    })

    const names = new Map()
    for (let offset = 0;; offset += 200) {
      const page = await call('list_characters', { offset, limit: 200 })
      for (const character of page.characters) if (character.name) names.set(character.id, character.name)
      if (names.size >= page.total || page.characters.length < 200) break
    }

    // Stored audits whose request still matches go to plan_diff; the rest are
    // stale without asking.
    const comparable = []
    for (const entry of entries.filter((item) => item.considered)) {
      if (!entry.state) entry.reasons = ['new']
      else if (!sameRequest(entry.state.request, entry.request)) entry.reasons = ['planChanged']
      else comparable.push(entry)
    }
    let engine = null
    for (let start = 0; start < comparable.length; start += PLAN_DIFF_BATCH) {
      const batch = comparable.slice(start, start + PLAN_DIFF_BATCH)
      const diff = await call('plan_diff', {
        audits: batch.map((entry) => ({
          key: entry.team.key,
          characterId: entry.state.audit.characterId,
          inventoryFingerprint: entry.state.audit.inventoryFingerprint,
          roster: entry.state.audit.roster,
          engine: entry.state.audit.engine,
        })),
      })
      engine = diff.engine
      for (const result of diff.audits) {
        const entry = batch.find((item) => item.team.key === result.key)
        const engineOnly = args.ignoreEngine && result.reasons.length === 1 && result.reasons[0] === 'engineChanged'
        if (engineOnly) entry.ignoredReasons = result.reasons
        else entry.reasons = result.reasons
      }
    }
    for (const entry of entries) {
      if (entry.considered && args.all && entry.reasons.length === 0) entry.reasons = ['forced']
      if (entry.reasons.length) entry.outcome = 'pending'
    }

    const pending = entries.filter((entry) => entry.outcome === 'pending')
    log(`${entries.length} 队中 ${pending.length} 队需要刷新${pending.length ? `:${pending.map((entry) => entry.team.key).join('、')}` : ''}`)

    if (!args.dryRun) {
      if (pending.length) mkdirSync(stateDir, { recursive: true })
      for (const entry of pending) {
        log(`审计 ${entry.team.key}(${reasonText(entry.reasons)})`)
        let audit
        try {
          audit = await call('team_audit', entry.request, (progress) => {
            if (progress.message) log(`  ${entry.team.key}: ${progress.message}`)
          })
        } catch (error) {
          entry.outcome = 'failed'
          entry.failure = error.message
          log(`  ${entry.team.key} 失败:${error.message}`)
          continue
        }
        engine = audit.engine ?? engine
        if (audit.status !== 'completed') {
          entry.outcome = 'failed'
          entry.failure = `${audit.status}${audit.reason ? `:${audit.reason}` : ''}`
          log(`  ${entry.team.key} 未完成:${entry.failure}`)
          continue
        }
        entry.state = {
          key: entry.team.key,
          request: entry.request,
          auditedAt: new Date().toISOString(),
          // What the report's deltas are measured against.
          previous: entry.state ? { auditedAt: entry.state.auditedAt, ...headlineOf(entry.state.audit) } : null,
          audit,
        }
        writeAtomic(resolve(stateDir, `${entry.team.key}.json`), JSON.stringify(entry.state, null, 2))
        entry.outcome = 'audited'
        log(`  ${entry.team.key} 完成:当前 ${int(audit.comboNow)},库存最优 ${int(audit.comboBest)},用时 ${(audit.timing.totalMs / 1000).toFixed(1)} 秒`)
      }
    }

    const reportPath = resolve(stateDir, 'report.md')
    // A run that audited nothing leaves the report as it is, so its timestamp
    // keeps saying when the numbers last moved — unless the report no longer
    // matches the plan and the records (a renamed or dropped team, a run that
    // died between writing a record and writing the report).
    const upToDate = existsSync(reportPath) && readFileSync(reportPath, 'utf8').trimEnd().endsWith(contentsMark(plan, entries))
    const rewrite = !args.dryRun && (entries.some((entry) => entry.outcome !== 'kept') || !upToDate)
    if (rewrite && entries.some((entry) => entry.state)) {
      mkdirSync(stateDir, { recursive: true })
      writeAtomic(reportPath, renderReport({ plan, save, entries, names, engine, generatedAt: new Date().toISOString(), dryRun: false }))
    }

    return {
      plan: args.plan,
      save,
      stateDir,
      report: existsSync(reportPath) ? reportPath : null,
      reportRewritten: rewrite && entries.some((entry) => entry.state),
      dryRun: args.dryRun,
      engine,
      teams: entries.map((entry) => ({
        key: entry.team.key,
        characterId: entry.team.characterId,
        considered: entry.considered,
        outcome: entry.outcome,
        reasons: entry.reasons,
        ignoredReasons: entry.ignoredReasons,
        ...(entry.failure && { failure: entry.failure }),
        auditedAt: entry.state?.auditedAt ?? null,
        ...(entry.state ? headlineOf(entry.state.audit) : {}),
        previous: entry.state?.previous ?? null,
      })),
    }
  } finally {
    await client.close().catch(() => {})
    removeTempDir()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

try {
  const summary = await main(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  const count = (outcome) => summary.teams.filter((team) => team.outcome === outcome).length
  log(
    `已刷新 ${count('audited')} · 沿用 ${count('kept')} · 待刷新 ${count('pending')} · 失败 ${count('failed')}${
      summary.report ? ` · 报告 ${summary.report}` : ''
    }`,
  )
  process.exitCode = count('failed') > 0 ? 2 : 0
} catch (error) {
  log(`失败:${error.message}`)
  process.exitCode = 1
}
