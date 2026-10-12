// End-to-end smoke for the M7 debug surface:
//   debug_utility (webgpu_tests / image_center / populate_characters /
//   reset_showcase_colors / export_showcase_colors) + optimize's engine
//   parameter (cpu regression line + gpu path).
//
// Spawns the built server over stdio against a temp copy of the sample save
// (the repo file is never a write target).
//
// SKIP guards (plan requirement — "环境不可用时报告缺失能力"):
//   - Chrome executable or repo dist/ missing → the whole browser section
//     prints [SKIP] with the reason and exits 0 (the Node-side console
//     actions still run — they need no browser).
//   - browserManager still unimplemented (parallel agent A not landed) → the
//     browser sections print [SKIP] on the capability error and exit 0.
//   - No WebGPU adapter → webgpu_tests asserts the Chinese capability report
//     instead of the suite; engine=gpu asserts the capability error shape.
//
// Usage: node scripts/smoke-debug.mjs [serverEntry]

import {
  copyFileSync,
  existsSync,
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

const TARGET = '1212b1' // Jingliu — has a saved form in the sample save

// Browser environment probe (mirrors browserManager's discovery order).
const chromeCandidates = [
  process.env.HSR_MCP_BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean)
const chromeFound = chromeCandidates.some((p) => existsSync(p))
const distFound = existsSync(resolve(mcpDir, '../dist/index.html'))
const browserEnvOk = chromeFound && distFound

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-debug-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(resolve(mcpDir, '../src/data/sample-save.json'), sampleSavePath)

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

async function errorTextOf(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  return result.isError ? (result.content?.[0]?.text ?? '') : null
}

/** Call once; surface EITHER the parsed payload or the isError text — heavy
 * browser actions must never be invoked twice just to inspect both. */
async function callOrError(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) return { error: result.content?.[0]?.text ?? '', payload: null }
  return { error: null, payload: payloadOf(result) }
}

const managerMissing = (text) => /尚未落地|browserManager/.test(text)

try {
  const client = new Client({ name: 'smoke-debug', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/state.json` },
    stderr: 'inherit',
  })
  await client.connect(transport)

  const tools = await client.listTools()
  check('tool debug_utility registered', tools.tools.map((t) => t.name).includes('debug_utility'))
  await callTool(client, 'load_save', { path: sampleSavePath })

  // ══ 1. populate_characters (Node side, random products) ═══════════════════
  const charsBefore = (await callTool(client, 'list_characters', {})).characters.length
  const populated = await callTool(client, 'debug_utility', { action: 'populate_characters' })
  check(
    'populate_characters grows the roster with the random flag',
    populated.charactersAfter > populated.charactersBefore
      && populated.charactersAfter >= charsBefore
      && populated.random === true
      && populated.relicsAdded > 0,
    `${populated.charactersBefore} → ${populated.charactersAfter} characters, +${populated.relicsAdded} relics`,
  )
  check('populate_characters bumped the revision (dirty)', populated.dirty === true && populated.revision > 0)

  // ══ 2. reset_showcase_colors / export_showcase_colors (Node side) ════════
  // Seed a showcase preference first (update_state section=showcase writes
  // showcasePreferences — the only MCP write path into that store slice).
  await callTool(client, 'update_state', {
    section: 'showcase',
    patch: { characterId: TARGET, scoringType: 0 },
  })
  const exportedSeeded = await callTool(client, 'debug_utility', { action: 'export_showcase_colors' })
  check(
    'export_showcase_colors returns a sorted id→color map (read-only)',
    typeof exportedSeeded.count === 'number' && exportedSeeded.colors != null
      && Object.entries(exportedSeeded.colors).every(([id, color]) => typeof id === 'string' && typeof color === 'string'),
    `count=${exportedSeeded.count}`,
  )
  const resetColors = await callTool(client, 'debug_utility', { action: 'reset_showcase_colors' })
  check(
    'reset_showcase_colors clears the seeded preference and STANDARD mode',
    resetColors.before.showcasePreferences >= 1
      && resetColors.after.showcasePreferences === 0
      && resetColors.after.standardMode === false
      && resetColors.cleared === true,
    `prefs ${resetColors.before.showcasePreferences} → ${resetColors.after.showcasePreferences}, STANDARD ${resetColors.before.standardMode} → false`,
  )
  check('reset_showcase_colors bumped the revision (dirty)', resetColors.dirty === true && resetColors.revision > 0)
  const revisionAfterReset = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  const exportedClean = await callTool(client, 'debug_utility', { action: 'export_showcase_colors' })
  check(
    'export after reset reports an empty map and stays read-only',
    exportedClean.count === 0 && Object.keys(exportedClean.colors).length === 0
      && (await callTool(client, 'get_state', { section: 'revision' })).revision.revision === revisionAfterReset,
  )

  // populate_characters left a huge random roster — reload the clean sample
  // save so the rest of the smoke runs on deterministic data.
  await callTool(client, 'load_save', { path: sampleSavePath })

  // ══ 3. optimize engine=cpu regression line ═══════════════════════════════
  const cpuRun = await callTool(client, 'optimize', { characterId: TARGET, resultsLimit: 5, engine: 'cpu' }, { timeout: 300_000 })
  check(
    'optimize engine=cpu keeps the existing CPU behavior and echoes the engine',
    cpuRun.status === 'completed' && cpuRun.rows.length === 5 && cpuRun.engine === 'cpu' && cpuRun.actualEngine === 'cpu'
      && cpuRun.summary?.cacheId != null,
    `rows=${cpuRun.rows?.length} actualEngine=${cpuRun.actualEngine}`,
  )
  const autoRun = await callTool(client, 'optimize', { characterId: TARGET, resultsLimit: 5 }, { timeout: 300_000 })
  check(
    'optimize without engine (auto) resolves to the CPU path',
    autoRun.status === 'completed' && autoRun.engine === 'auto' && autoRun.actualEngine === 'cpu',
  )

  // ══ 4. debug_utility webgpu_tests (browser; SKIP when unsupported) ═══════
  if (!browserEnvOk) {
    console.log(`[SKIP] debug_utility webgpu_tests/image_center + optimize engine=gpu — Chrome found=${chromeFound}, dist found=${distFound}`)
  } else {
    // Single invocation — the real path runs the FULL suite (~minutes), so it
    // must never be called twice just to inspect payload vs error.
    const { error: webgpuErr, payload: suite } = await callOrError(
      client,
      'debug_utility',
      { action: 'webgpu_tests', filter: 'Ornament' },
      { timeout: 900_000 },
    )
    if (webgpuErr != null && managerMissing(webgpuErr)) {
      console.log(`[SKIP] debug_utility webgpu_tests — browserManager 未落地(任务 A 集成轮统一跑): ${webgpuErr.slice(0, 90)}`)
    } else if (webgpuErr != null) {
      check('webgpu_tests failure is a Chinese capability/timeout error', /WebGPU|能力|用例/.test(webgpuErr), webgpuErr.slice(0, 90))
    } else if (suite.supported === false) {
      console.log(`[SKIP] webgpu_tests real-path assertions — 受管浏览器无 WebGPU:${suite.reason ?? ''}`)
    } else {
      check(
        'webgpu_tests real path: every case passes with complete delta rows',
        suite.total >= 1
          && suite.passed === suite.total && suite.failed === 0 && suite.incomplete === 0
          && suite.tests.length >= 1 && suite.tests.length <= suite.total
          && suite.tests.every((t) => ['passed', 'failed', 'incomplete'].includes(t.status) && Array.isArray(t.deltas)),
        `total=${suite.total} passed=${suite.passed} failed=${suite.failed} incomplete=${suite.incomplete} matched=${suite.tests.length}`,
      )
      const withDeltas = suite.tests.filter((t) => t.deltas.length > 0)
      check(
        'webgpu_tests delta rows carry stat/cpu/gpu/delta/precision/pass',
        withDeltas.length >= 1 && withDeltas.every((t) =>
          t.deltas.every((d) =>
            typeof d.stat === 'string' && d.stat.length > 0
            && d.cpu.length > 0 && d.gpu.length > 0
            && Number.isFinite(d.precision) && typeof d.pass === 'boolean'
          )
        ),
        `${withDeltas.length} tests with deltas, first row: ${JSON.stringify(withDeltas[0]?.deltas?.[0])}`,
      )
    }
  }

  // ══ 5. debug_utility image_center (browser; SKIP when unsupported) ════════
  if (!browserEnvOk) {
    console.log('[SKIP] image_center — 浏览器环境缺失(见上一条 SKIP 原因)')
  } else {
    const icArgs = { action: 'image_center', mode: 'static', characterId: TARGET, params: { x: 900, y: 1150 }, copyConfig: true }
    const { error: icErr, payload: ic } = await callOrError(client, 'debug_utility', icArgs, { timeout: 300_000 })
    if (icErr != null && managerMissing(icErr)) {
      console.log(`[SKIP] debug_utility image_center — browserManager 未落地(任务 A 集成轮统一跑): ${icErr.slice(0, 90)}`)
    } else if (icErr != null) {
      check('image_center browser failure is a Chinese error', /image_center|浏览器|能力/.test(icErr), icErr.slice(0, 90))
    } else {
      check(
        'image_center applies params through the page inputs',
        ic.mode === 'static' && ic.applied?.x === '900' && ic.applied?.y === '1150',
        `applied=${JSON.stringify(ic.applied)}`,
      )
      check(
        'image_center reads back the CopyButton config string',
        typeof ic.config?.text === 'string' && /imageCenter:\s*\{/.test(ic.config.text),
        ic.config?.text,
      )
      check(
        'image_center produced a preview PNG artifact',
        typeof ic.previewArtifactId === 'string' && ic.previewBytes > 500 && ic.previewClip?.width > 50,
        `artifact=${ic.previewArtifactId} ${ic.previewClip?.width}x${ic.previewClip?.height} ${ic.previewBytes}B`,
      )
      check('image_center reports the paste entry honestly', ic.pasteEntry === false)

      const lcErr = await errorTextOf(client, 'debug_utility', { action: 'image_center', mode: 'lightCone' }, { timeout: 60_000 })
      check('image_center mode=lightCone without lightConeId rejected (Chinese)', lcErr != null && /lightConeId/.test(lcErr), String(lcErr).slice(0, 90))
    }
  }

  // ══ 6. optimize engine=gpu (browser; SKIP when unsupported) ═══════════════
  if (!browserEnvOk) {
    console.log('[SKIP] optimize engine=gpu — 浏览器环境缺失(见上)')
  } else {
    const { error: gpuErr, payload: gpuRun } = await callOrError(
      client,
      'optimize',
      { characterId: TARGET, resultsLimit: 5, engine: 'gpu' },
      { timeout: 600_000 },
    )
    if (gpuErr != null && managerMissing(gpuErr)) {
      console.log(`[SKIP] optimize engine=gpu — browserManager 未落地(任务 A 集成轮统一跑): ${gpuErr.slice(0, 90)}`)
    } else if (gpuErr != null) {
      check(
        'engine=gpu without WebGPU fails with the capability error shape',
        /WebGPU|get_runtime_capabilities|能力/.test(gpuErr) && /engine=cpu/.test(gpuErr),
        gpuErr.slice(0, 90),
      )
    } else {
      check(
        'engine=gpu completes and echoes actualEngine + row count',
        gpuRun.status === 'completed'
          && ['gpu', 'gpu-experimental', 'cpu'].includes(gpuRun.actualEngine)
          && typeof gpuRun.rowCount === 'number',
        `actualEngine=${gpuRun.actualEngine} rowCount=${gpuRun.rowCount}`,
      )
      if (gpuRun.actualEngine === 'gpu' || gpuRun.actualEngine === 'gpu-experimental') {
        check(
          'engine=gpu returns grid rows and the CPU cross-check summary',
          gpuRun.rowCount > 0 && gpuRun.gpuRows?.length === gpuRun.rowCount
            && gpuRun.comparison?.column != null && gpuRun.comparison.cpuRows > 0,
          `column=${gpuRun.comparison?.column} cpuTop=${gpuRun.comparison?.cpuTop} gpuTop=${gpuRun.comparison?.gpuTop}`,
        )
        // Structured rows come from the page's results hook (site dist built
        // with src/lib/sync/optimizerResultsHook.ts); a dist that predates it
        // only has the display rows asserted above.
        if (gpuRun.rows == null) {
          console.log('[SKIP] engine=gpu 结构化结果断言 — 站点 dist 早于结果钩子(仓库根目录 npm run build 后重跑)')
        } else {
          const column = gpuRun.summary.gridSortColumn
          check(
            'engine=gpu returns structured rows with six-relic builds, sorted, matching the CPU builds',
            gpuRun.rows.length === gpuRun.comparison.cpuRows
              && gpuRun.rows.every((row) => Object.keys(row.build.relics).length === 6)
              && gpuRun.rows.every((row, i, all) => i === 0 || all[i - 1].stats[column] >= row.stats[column])
              && gpuRun.comparison.topBuildMatch === true
              && gpuRun.comparison.matchingBuilds >= gpuRun.rows.length - 1,
            `rows=${gpuRun.rows.length} matchingBuilds=${gpuRun.comparison.matchingBuilds} gpuTopExact=${gpuRun.comparison.gpuTopExact}`,
          )
          const cached = await callTool(client, 'get_results', { limit: 1 })
          check(
            'engine=gpu rows are cached for get_results under the returned cacheId',
            gpuRun.summary.cacheId !== '' && cached.cacheId === gpuRun.summary.cacheId && cached.rows[0]?.id === gpuRun.rows[0].id,
            `cacheId=${gpuRun.summary.cacheId}`,
          )
          const unchecked = await callTool(
            client,
            'optimize',
            { characterId: TARGET, resultsLimit: 5, engine: 'gpu', crossCheck: false },
            { timeout: 600_000 },
          )
          check(
            'engine=gpu crossCheck=false skips the CPU pass and returns the same top build',
            unchecked.status === 'completed' && unchecked.comparison == null
              && unchecked.rows?.[0]?.id === gpuRun.rows[0].id
              && unchecked.summary.cacheId !== gpuRun.summary.cacheId,
            `rows=${unchecked.rows?.length} comparison=${unchecked.comparison == null ? 'absent' : 'present'}`,
          )
          // Sorting by an action the character does not have crashes the GPU
          // pipeline at startup on current upstream. The page only toasts and
          // drops its in-progress flag; that must surface as an error, never
          // as a completed run with zero rows.
          const { error: crashErr, payload: crashRun } = await callOrError(
            client,
            'optimize',
            { characterId: TARGET, resultsLimit: 5, engine: 'gpu', crossCheck: false, formOverrides: { resultSort: 'DOT' } },
            { timeout: 600_000 },
          )
          if (crashErr == null) {
            console.log(`[SKIP] engine=gpu 崩溃路径断言 — 该排序在本环境未触发 GPU 崩溃(${crashRun.rows?.length} 行)`)
          } else {
            check(
              'engine=gpu run that crashes in the page fails explicitly (no completed-with-zero-rows)',
              /未跑完本次搜索|未进入优化运行状态/.test(crashErr),
              crashErr.slice(0, 90),
            )
            const afterCrash = await callTool(client, 'get_results', { limit: 1 })
            check('a crashed engine=gpu run leaves the previous result cache in place', afterCrash.cacheId === unchecked.summary.cacheId)
          }
        }
      } else {
        console.log('[SKIP] engine=gpu 对拍断言 — 网页实际引擎为 cpu(设备能力回落),返回含 note 说明')
      }
    }
  }

  await client.close()
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nsmoke-debug: ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nsmoke-debug: ALL CHECKS PASSED (SKIP 网段不计失败)')
