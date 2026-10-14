// Tool-list shaping smoke: HSR_MCP_TOOLSETS and HSR_MCP_NO_OUTPUT_SCHEMA.
//
// Each case starts its own server (dist/index.js) over a temp state file:
//
//   1. default — all 64 tools, each with an output schema
//   2. HSR_MCP_NO_OUTPUT_SCHEMA=1 — the same tools, none with an output
//      schema, less than half the size; a call returns the same payload
//   3. HSR_MCP_TOOLSETS=query,scoring — those toolsets plus the always-on
//      ones; a tool outside them is unknown to the server
//   4. HSR_MCP_TOOLSETS=-bridge,-scanner — everything but those two
//   5. HSR_MCP_TOOLSETS=teamAudit with HSR_MCP_NO_OUTPUT_SCHEMA=1 — plan_diff
//      still reads relics and characters through tools this server does not
//      list; the startup log says what was registered
//   6. an unknown toolset, a mix of the two forms, or excluding an always-on
//      toolset stops the server at startup and names what is valid
//
// Usage: node scripts/smoke-toolsets.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
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
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-toolsets-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

const ALWAYS_ON = ['load_save', 'export_save', 'save_status', 'reset_all', 'get_job', 'cancel_job']
const QUERY = ['list_characters', 'get_character', 'get_form', 'default_form', 'permutations', 'list_relics']
const SCORING = ['score_relics', 'dps_score', 'score_character']
const BRIDGE_AND_SCANNER = ['sync_bridge_start', 'sync_bridge_status', 'sync_bridge_stop', 'sync_bridge_push', 'scanner']

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

let serial = 0
function serverEnv(extra) {
  const dir = `${tempDir}/server-${serial++}`
  return { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${dir}/localstorage.json`, HSR_MCP_ARTIFACTS_DIR: `${dir}/artifacts`, ...extra }
}

async function withServer(extraEnv, body) {
  const client = new Client({ name: 'smoke-toolsets', version: '0.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: mcpDir, env: serverEnv(extraEnv), stderr: 'pipe' })
  let log = ''
  transport.stderr.on('data', (chunk) => {
    log += chunk
  })
  await client.connect(transport)
  try {
    return await body(client, () => log)
  } finally {
    await client.close().catch(() => {})
  }
}

const sameNames = (tools, expected) => JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...expected].sort())

async function loadedCharacters(client) {
  const loaded = await client.callTool({ name: 'load_save', arguments: { path: sampleSavePath } })
  if (loaded.isError) throw new Error(`load_save: ${loaded.content?.[0]?.text}`)
  const listed = await client.callTool({ name: 'list_characters', arguments: {} })
  if (listed.isError) throw new Error(`list_characters: ${listed.content?.[0]?.text}`)
  return listed.structuredContent
}

try {
  // ── 1. default ───────────────────────────────────────────────────────────
  const full = await withServer({}, async (client) => {
    const { tools } = await client.listTools()
    return { tools, chars: JSON.stringify({ tools }).length, characters: await loadedCharacters(client) }
  })
  const allNames = full.tools.map((t) => t.name)
  check(
    'default lists all 64 tools, each with an output schema',
    allNames.length === 64 && full.tools.every((t) => t.outputSchema != null),
    `${allNames.length} tools, ${full.chars} chars`,
  )

  // ── 2. no output schemas ─────────────────────────────────────────────────
  const slim = await withServer({ HSR_MCP_NO_OUTPUT_SCHEMA: '1' }, async (client) => {
    const { tools } = await client.listTools()
    return { tools, chars: JSON.stringify({ tools }).length, characters: await loadedCharacters(client) }
  })
  check(
    'HSR_MCP_NO_OUTPUT_SCHEMA=1 keeps every tool and drops every output schema',
    sameNames(slim.tools, allNames) && slim.tools.every((t) => t.outputSchema === undefined),
    `${slim.tools.length} tools, ${slim.tools.filter((t) => t.outputSchema != null).length} with an output schema`,
  )
  check(
    'descriptions and input schemas are untouched',
    slim.tools.every((t) => {
      const before = full.tools.find((f) => f.name === t.name)
      return before != null && before.description === t.description && JSON.stringify(before.inputSchema) === JSON.stringify(t.inputSchema)
    }),
  )
  check('tools/list is less than half the size', slim.chars < full.chars / 2, `${full.chars} → ${slim.chars} chars`)
  check(
    'a call still returns the same structured payload',
    slim.characters != null && JSON.stringify(slim.characters) === JSON.stringify(full.characters),
    `list_characters: ${JSON.stringify(slim.characters ?? null).length} chars`,
  )

  // ── 3. allow-list ────────────────────────────────────────────────────────
  await withServer({ HSR_MCP_TOOLSETS: 'query, scoring' }, async (client) => {
    const { tools } = await client.listTools()
    check(
      'HSR_MCP_TOOLSETS=query,scoring lists those toolsets plus the always-on ones',
      sameNames(tools, [...ALWAYS_ON, ...QUERY, ...SCORING]),
      tools.map((t) => t.name).join(' '),
    )
    const characters = await loadedCharacters(client)
    check('listed tools work', JSON.stringify(characters) === JSON.stringify(full.characters))
    const outside = await client.callTool({ name: 'optimize', arguments: {} }).then(
      (r) => r,
      (e) => ({ isError: true, content: [{ type: 'text', text: String(e.message) }] }),
    )
    check(
      'a tool outside the selection is unknown to the server',
      outside.isError === true && /not found/i.test(outside.content?.[0]?.text ?? ''),
      String(outside.content?.[0]?.text ?? '').slice(0, 120),
    )
  })

  // ── 4. deny-list ─────────────────────────────────────────────────────────
  await withServer({ HSR_MCP_TOOLSETS: '-bridge,-scanner' }, async (client) => {
    const { tools } = await client.listTools()
    check(
      'HSR_MCP_TOOLSETS=-bridge,-scanner lists everything but those two toolsets',
      sameNames(tools, allNames.filter((name) => !BRIDGE_AND_SCANNER.includes(name))),
      `${tools.length} of ${allNames.length} tools`,
    )
  })

  // ── 5. composing tools reach tools the client cannot see ─────────────────
  await withServer({ HSR_MCP_TOOLSETS: 'teamAudit', HSR_MCP_NO_OUTPUT_SCHEMA: '1' }, async (client, serverLog) => {
    const { tools } = await client.listTools()
    check(
      'HSR_MCP_TOOLSETS=teamAudit with no output schemas lists no query tool',
      sameNames(tools, [...ALWAYS_ON, 'team_audit', 'plan_diff']) && tools.every((t) => t.outputSchema === undefined),
      tools.map((t) => t.name).join(' '),
    )
    const logLine = (serverLog().match(/\[mcp\] tools\/list: .*/) ?? [''])[0]
    check(
      'the startup log names the registered toolsets',
      logLine === '[mcp] tools/list: 3 of 24 toolsets (archive, jobs, teamAudit), output schemas off',
      logLine,
    )
    const loaded = await client.callTool({ name: 'load_save', arguments: { path: sampleSavePath } })
    const scope = { enhanceFloor: 0, grade: 0, relicSets: null, ornaments: null, mains: {} }
    const diff = await client.callTool({
      name: 'plan_diff',
      arguments: { audits: [{ characterId: '1212b1', inventoryFingerprint: { hash: 'stale', scope } }] },
    })
    const audit = diff.structuredContent?.audits?.[0]
    check(
      'plan_diff still reads the inventory through list_relics',
      loaded.isError !== true && diff.isError !== true && audit?.relics?.current?.relicCount > 0 && audit.reasons.includes('relicsChanged'),
      diff.isError ? String(diff.content?.[0]?.text).slice(0, 160) : `current relicCount=${audit?.relics?.current?.relicCount}, reasons=${audit?.reasons}`,
    )
  })

  // ── 6. rejected selections ───────────────────────────────────────────────
  for (
    const [spec, expected] of [
      ['query,nope', /未知的工具集 nope。可用的工具集:archive, .*teams/],
      ['query,-bridge', /不能混用/],
      ['-archive', /archive 始终注册/],
      ['-,-bridge', /- 后面缺工具集名/],
    ]
  ) {
    const run = spawnSync(process.execPath, [serverEntry], {
      cwd: mcpDir,
      env: serverEnv({ HSR_MCP_TOOLSETS: spec }),
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    })
    const message = (run.stderr.match(/\[mcp\] fatal: .*/) ?? [''])[0]
    check(
      `HSR_MCP_TOOLSETS=${spec} stops the server at startup`,
      run.status === 1 && run.signal == null && /HSR_MCP_TOOLSETS/.test(message) && expected.test(run.stderr),
      `exit=${run.status} signal=${run.signal} ${message.slice(0, 200)}`,
    )
  }

  console.log(failures === 0 ? 'smoke-toolsets: ALL CHECKS PASSED' : `smoke-toolsets: ${failures} FAILED`)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
