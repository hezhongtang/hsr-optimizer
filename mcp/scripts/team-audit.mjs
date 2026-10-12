// Command-line front end of the team_audit tool: starts the server on a private
// copy of the save, calls the tool once and prints its structured result.
// The audit itself lives in the server (mcp/src/teamAudit.ts); see the tool's
// description for what each part of the result means.
// Read-only: the save is copied into a temporary state file per run and never written.
//
// Usage: node scripts/team-audit.mjs --character <id> [--teammates a,b,c] [options]
//   --strategy <name>          tiered (default) | locked
//   --budget-seconds <n>       tiered pass 2: total search time for both variants (default 60)
//   --leveled-budget-seconds <n>  tiered pass 1: per search; above it the engine's weighted-roll
//                              floor is raised and the pass is reported as not exhaustive (default 300)
//   --candidate-rows <n>       tiered pass 2: rows scanned for +0 candidates (default 2000)
//   --candidate-tolerance <f>  tiered: a +0 candidate may trail the levelled best by this
//                              fraction and still be listed for its potential (default 0.05)
//   --teammates <spec,…>       up to 3 teammates; spec = id[:eN][:lc<lightConeId>][:sN],
//                              missing parts fall back to that character's saved form
//   --light-cone <id>          core light cone, only for characters saved without one
//   --eidolon <n> --superimposition <n>   used together with --light-cone
//   --form-overrides <file>    extra formOverrides (JSON), applied last
//   --no-auto-tighten          locked strategy without tightening: one search of the base overrides as-is
//   --results-limit <n>        rows to keep (default 50)
//   --enhance-floor <n>        relic enhance floor (default 0)
//   --target-permutations <n>  locked strategy: auto-tighten target (default 2e7)
//   --save <file>              save file, relative to mcp/ (default profile/fribbels-optimizer-save.json)
//   --server <entry>           server entry, relative to mcp/ (default dist/index.js)
//   --out <file>               write the JSON result here instead of stdout
//   --engine <name>            auto | cpu | gpu | gpu-experimental; default gpu for tiered (its
//                              search spaces assume GPU throughput), auto (CPU) for locked. The GPU
//                              engines run in the managed browser against the site dist (npm run build)
//   --cross-check              with a GPU engine: also run the search on the CPU and report the
//                              comparison (off by default, it costs the whole CPU search)
//   --verbose                  forward server stderr
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
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

function log(...parts) {
  process.stderr.write(`[team-audit] ${parts.join(' ')}\n`)
}

// Only flags that were given are sent: the defaults are the tool's.
function parseArgs(argv) {
  const args = { tool: {}, save: 'profile/fribbels-optimizer-save.json', server: 'dist/index.js', verbose: false }
  const numeric = (flag, value) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} 需要非负数值,实际 ${value}`)
    return parsed
  }
  const toolNumbers = {
    '--eidolon': 'eidolon',
    '--superimposition': 'superimposition',
    '--budget-seconds': 'budgetSeconds',
    '--leveled-budget-seconds': 'leveledBudgetSeconds',
    '--candidate-rows': 'candidateRows',
    '--candidate-tolerance': 'candidateTolerance',
    '--results-limit': 'resultsLimit',
    '--enhance-floor': 'enhanceFloor',
    '--target-permutations': 'targetPermutations',
  }
  const toolStrings = { '--character': 'characterId', '--light-cone': 'lightConeId', '--strategy': 'strategy', '--engine': 'engine' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} 缺少取值`)
      return argv[++i]
    }
    if (toolNumbers[flag]) args.tool[toolNumbers[flag]] = numeric(flag, value())
    else if (toolStrings[flag]) args.tool[toolStrings[flag]] = value()
    else if (flag === '--teammates') args.tool.teammates = value().split(',').filter(Boolean).map(parseTeammateSpec)
    else if (flag === '--form-overrides') args.tool.formOverrides = JSON.parse(readFileSync(resolve(value()), 'utf8'))
    else if (flag === '--no-auto-tighten') args.tool.autoTighten = false
    else if (flag === '--cross-check') args.tool.crossCheck = true
    else if (flag === '--save') args.save = value()
    else if (flag === '--server') args.server = value()
    else if (flag === '--out') args.out = value()
    else if (flag === '--verbose') args.verbose = true
    else throw new Error(`未知参数 ${flag}(用法见脚本头部注释)`)
  }
  if (!args.tool.characterId) throw new Error('缺少 --character <角色 id>')
  return args
}

// spec = id[:eN][:lc<lightConeId>][:sN]
function parseTeammateSpec(spec) {
  const [characterId, ...rest] = spec.split(':')
  const teammate = { characterId }
  for (const token of rest) {
    const eidolon = /^e(\d)$/i.exec(token)
    const superimposition = /^s(\d)$/i.exec(token)
    const lightCone = /^lc(\w+)$/i.exec(token)
    if (eidolon) teammate.characterEidolon = Number(eidolon[1])
    else if (superimposition) teammate.lightConeSuperimposition = Number(superimposition[1])
    else if (lightCone) teammate.lightCone = lightCone[1]
    else throw new Error(`队友写法 "${spec}" 中无法识别 "${token}"(格式 id[:eN][:lc<光锥id>][:sN])`)
  }
  return teammate
}

async function main(args) {
  const client = new Client({ name: 'team-audit', version: '0.0.0' })
  // The server reads and writes its localStorage file backend; seeding a private
  // copy keeps the real save untouched.
  const tempDir = mkdtempSync(`${tmpdir()}/hsr-team-audit-`)
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

  try {
    writeFileSync(statePath, JSON.stringify({ state: readFileSync(resolve(mcpDir, args.save), 'utf8') }))
    await client.connect(transport)
    // The pipe must be drained or a chatty server blocks on a full buffer.
    transport.stderr?.on('data', (chunk) => {
      if (args.verbose) process.stderr.write(chunk)
    })
    const result = await client.callTool({ name: 'team_audit', arguments: args.tool }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      onprogress: (progress) => {
        if (progress.message) log(progress.message)
      },
    })
    if (result.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? 'team_audit 返回错误但没有内容')
    return result.structuredContent
  } finally {
    await client.close().catch(() => {})
    removeTempDir()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

try {
  const args = parseArgs(process.argv.slice(2))
  const result = await main(args)
  const json = JSON.stringify(result, null, 2)
  if (args.out) {
    writeFileSync(resolve(args.out), json)
    log(`结果已写入 ${resolve(args.out)}`)
  } else {
    process.stdout.write(`${json}\n`)
  }
  log(`status=${result.status} comboNow=${result.comboNow ?? '-'} comboBest=${result.comboBest ?? '-'} total=${result.timing.totalMs}ms`)
  process.exitCode = result.status === 'completed' ? 0 : 2
} catch (error) {
  log(`失败:${error.message}`)
  process.exitCode = 1
}
