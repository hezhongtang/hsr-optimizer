// M4-B unified job-management smoke: get_job / cancel_job lifecycle over the
// job registry the optimizer and simulation domains register their runs in.
//
// Against the built server (dist/index.js) with the sample save (temp copy,
// temp localStorage — the repo save is never a write target):
//
//   1. cold registry lists empty (get_job, no args)
//   2. small optimize → job observed running while the search runs, then
//      completed; jobId === the run's cacheId; detail carries timings + summary
//   3. long optimize on a 12x-cloned inventory (smoke.mjs's clone recipe) →
//      cancel_job mid-run → the ORIGINAL optimize call resolves with
//      status 'cancelled' (partial rows kept, not an error) and the job
//      settles as cancelled
//   4. benchmark_runs (1 small preset) → a batch-level job appears and
//      completes with completedPresets/totalPresets progress
//   5. get_job with an unknown id errors; cancel_job on a finished job returns
//      its terminal status instead of erroring; cancel_job unknown id errors
//   6. job tools are read-only: revision unchanged across get_job/cancel_job
//
// Usage: node scripts/smoke-jobs.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
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

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-jobs-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

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

async function callToolExpectError(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the get_job list until a job matching predicate appears (or timeout). */
async function pollJobList(client, predicate, timeoutMs, pollMs = 30) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await callTool(client, 'get_job', {})
    const hit = (list.jobs ?? []).find(predicate)
    if (hit) return hit
    await sleep(pollMs)
  }
  return null
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-jobs', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
})
await client.connect(transport)

try {
  // ── 1. cold registry lists empty ─────────────────────────────────────────
  const emptyList = await callTool(client, 'get_job', {})
  check(
    'get_job (no args) lists a cold registry as empty',
    emptyList.mode === 'list' && emptyList.total === 0 && emptyList.jobs.length === 0,
    `mode=${emptyList.mode} total=${emptyList.total}`,
  )

  // ── 2. small optimize lifecycle: running → completed ────────────────────
  await callTool(client, 'load_save', { path: sampleSavePath })

  const optimizePromise = callTool(client, 'optimize', { characterId: '1212b1', resultsLimit: 5 }, { timeout: 300_000 })
  const optimizeJob = await pollJobList(client, (j) => j.kind === 'optimize' && j.status === 'running', 120_000, 25)
  check(
    'small optimize observed as a running job mid-run',
    optimizeJob != null,
    optimizeJob ? `jobId=${optimizeJob.jobId}` : 'never observed running (run too fast?)',
  )

  if (optimizeJob) {
    const liveDetail = await callTool(client, 'get_job', { jobId: optimizeJob.jobId })
    check(
      'running job detail: status running, cancellable, no endedAt/duration',
      liveDetail.mode === 'detail' && liveDetail.job.status === 'running'
        && liveDetail.job.cancellable === true && liveDetail.job.endedAt == null && liveDetail.job.durationMs == null,
      `status=${liveDetail.job?.status} cancellable=${liveDetail.job?.cancellable}`,
    )
  }

  const optimized = await optimizePromise
  check(
    'small optimize completed with rows',
    optimized.status === 'completed' && optimized.rows.length >= 1,
    `status=${optimized.status}, ${optimized.rows?.length} rows`,
  )
  check(
    'optimize jobId === returned cacheId',
    optimizeJob != null && optimized.summary.cacheId === optimizeJob.jobId,
    `jobId=${optimizeJob?.jobId} cacheId=${optimized.summary.cacheId}`,
  )

  const doneDetail = await callTool(client, 'get_job', { jobId: optimized.summary.cacheId })
  check(
    'completed job detail: ended timings + summary references',
    doneDetail.mode === 'detail' && doneDetail.job.status === 'completed' && doneDetail.job.endedAt != null
      && typeof doneDetail.job.durationMs === 'number' && doneDetail.job.cancellable === false
      && doneDetail.job.summary.searched === optimized.summary.searched
      && doneDetail.job.summary.characterId === '1212b1',
    `status=${doneDetail.job?.status} durationMs=${doneDetail.job?.durationMs} searched=${doneDetail.job?.summary?.searched}`,
  )

  // ── 3. long run on a 12x-cloned inventory + cancel_job ──────────────────
  const sampleSave = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  const cloned = {
    ...sampleSave,
    relics: [],
  }
  for (let k = 0; k < 12; k++) {
    for (const r of sampleSave.relics) {
      cloned.relics.push({ ...r, id: `${r.id}#${k}`, equippedBy: k === 0 ? r.equippedBy : undefined })
    }
  }
  await callTool(client, 'load_save', { json: cloned })

  let longRunError = null
  const longRunPromise = callTool(
    client,
    'optimize',
    { characterId: '1212b1', force: true, resultsLimit: 50 },
    { timeout: 600_000 },
  ).catch((e) => {
    longRunError = e
    return null
  })

  const firstJobId = optimized.summary.cacheId
  const longJob = await pollJobList(client, (j) => j.kind === 'optimize' && j.status === 'running' && j.jobId !== firstJobId, 120_000, 40)
  check('long run observed as a new running job', longJob != null, longJob ? `jobId=${longJob.jobId}` : 'never observed')

  if (longJob) {
    // Wait for real search progress so the cancel lands mid-search, not at boot
    let sawSearched = false
    const progressDeadline = Date.now() + 120_000
    while (Date.now() < progressDeadline) {
      const detail = await callTool(client, 'get_job', { jobId: longJob.jobId })
      if ((detail.job.progress.searched ?? 0) > 0) {
        sawSearched = true
        break
      }
      await sleep(60)
    }
    check('long run reports searched progress via get_job', sawSearched, sawSearched ? 'searched > 0' : 'no progress observed')

    const cancelRes = await callTool(client, 'cancel_job', { jobId: longJob.jobId })
    check(
      'cancel_job on a running job acknowledges the request',
      cancelRes.cancelRequested === true && cancelRes.jobStatus === 'running' && cancelRes.kind === 'optimize',
      `cancelRequested=${cancelRes.cancelRequested} jobStatus=${cancelRes.jobStatus}`,
    )
  }

  const cancelledRun = await longRunPromise
  check(
    'cancelled optimize call resolves (no throw) with status cancelled',
    longRunError === null && cancelledRun != null && cancelledRun.status === 'cancelled',
    longRunError ? `threw: ${longRunError.message}` : `status=${cancelledRun?.status}`,
  )
  check(
    'cancelled run keeps partial rows and its cacheId === jobId',
    cancelledRun != null && cancelledRun.summary.cancelled === true && Array.isArray(cancelledRun.rows)
      && longJob != null && cancelledRun.summary.cacheId === longJob.jobId,
    `rows=${cancelledRun?.rows?.length} cacheId=${cancelledRun?.summary?.cacheId}`,
  )

  if (longJob) {
    const cancelledDetail = await callTool(client, 'get_job', { jobId: longJob.jobId })
    check(
      'job detail settles as cancelled with timings, hook dropped',
      cancelledDetail.job.status === 'cancelled' && cancelledDetail.job.endedAt != null
        && cancelledDetail.job.cancellable === false,
      `status=${cancelledDetail.job.status}`,
    )
  }

  // ── 4. benchmark_runs registers a batch-level job ───────────────────────
  await callTool(client, 'load_save', { path: sampleSavePath })
  const benchPromise = callTool(
    client,
    'benchmark_runs',
    {
      characterId: '1212b1',
      presets: [
        { relicSet1: 'Scholar Lost in Erudition', relicSet2: 'Scholar Lost in Erudition', ornamentSet: 'Rutilant Arena', spdThreshold: 0 },
      ],
    },
    { timeout: 300_000 },
  )

  const benchJob = await pollJobList(client, (j) => j.kind === 'benchmark_runs', 120_000, 25)
  const bench = await benchPromise
  check(
    'benchmark_runs completed one preset',
    bench.cancelled === false && bench.presets.length === 1 && bench.presets[0].status === 'completed',
    `cancelled=${bench.cancelled}, ${bench.presets?.map((p) => `${p.status}/${p.durationMs}ms`).join(' ')}`,
  )
  check(
    'benchmark job appeared in the registry',
    benchJob != null,
    benchJob ? `jobId=${benchJob.jobId} (observed ${benchJob.status})` : 'never observed',
  )

  // ── 4b. a throwing PRE-registration guard must not leave a zombie job ────
  // A character with no light cone makes benchmark_runs throw BEFORE the job
  // is registered (the guard was deliberately moved ahead of registerJob);
  // with the old ordering this left a forever-running record.
  {
    // Strip the light cone off one character via upsert_character's patch path
    const lightConeStripped = await callToolExpectError(client, 'benchmark_runs', {
      characterId: '1212b1',
      presets: [
        { relicSet1: 'Scholar Lost in Erudition', relicSet2: 'Scholar Lost in Erudition', ornamentSet: 'Rutilant Arena', spdThreshold: 0 },
      ],
      lightCone: '',
    })
    check(
      'benchmark_runs with an empty lightCone override errors cleanly',
      lightConeStripped.includes('光锥'),
      lightConeStripped.slice(0, 90),
    )
    const jobsList = await callTool(client, 'get_job', {})
    const zombie = jobsList.jobs.find((j) => j.status === 'running' && j.kind === 'benchmark_runs')
    check(
      'a pre-registration throw leaves no running benchmark zombie',
      zombie == null,
      zombie ? `zombie jobId=${zombie.jobId}` : `registry: ${jobsList.jobs.map((j) => `${j.jobId}:${j.status}`).join(', ')}`,
    )
  }

  if (benchJob) {
    const benchDetail = await callTool(client, 'get_job', { jobId: benchJob.jobId })
    check(
      'benchmark job completes with per-batch progress and preset summary',
      benchDetail.job.status === 'completed'
        && benchDetail.job.progress.completedPresets === 1 && benchDetail.job.progress.totalPresets === 1
        && benchDetail.job.summary.characterId === '1212b1' && Array.isArray(benchDetail.job.summary.presets)
        && benchDetail.job.summary.presets.length === 1,
      `status=${benchDetail.job.status} progress=${JSON.stringify(benchDetail.job.progress)}`,
    )
  }

  // ── 5. unknown ids and ended-job cancel semantics ────────────────────────
  const unknownGet = await callToolExpectError(client, 'get_job', { jobId: 'opt-999-nonexistent' })
  check(
    'get_job unknown id errors with an actionable Chinese message',
    unknownGet.includes('未知任务') && unknownGet.includes('get_job'),
    unknownGet.slice(0, 90),
  )
  const unknownCancel = await callToolExpectError(client, 'cancel_job', { jobId: 'bench-999-nonexistent' })
  check('cancel_job unknown id errors', unknownCancel.includes('未知任务'), unknownCancel.slice(0, 90))

  const cancelEnded = await callTool(client, 'cancel_job', { jobId: optimized.summary.cacheId })
  check(
    'cancel_job on a completed job returns its status (no error)',
    cancelEnded.cancelRequested === false && cancelEnded.jobStatus === 'completed',
    `jobStatus=${cancelEnded.jobStatus} cancelRequested=${cancelEnded.cancelRequested}`,
  )

  // ── 6. job tools are read-only: revision untouched ──────────────────────
  const beforeStatus = await callTool(client, 'save_status', {})
  await callTool(client, 'get_job', {})
  await callTool(client, 'get_job', { jobId: longJob?.jobId ?? optimized.summary.cacheId })
  if (longJob) await callTool(client, 'cancel_job', { jobId: longJob.jobId }) // already cancelled → status return
  const afterStatus = await callTool(client, 'save_status', {})
  check(
    'job tools are read-only: revision and generation unchanged',
    beforeStatus.revision === afterStatus.revision && beforeStatus.generation === afterStatus.generation,
    `revision ${beforeStatus.revision} → ${afterStatus.revision}, generation ${beforeStatus.generation} → ${afterStatus.generation}`,
  )

  console.log(failures === 0 ? 'smoke-jobs: ALL CHECKS PASSED' : `smoke-jobs: ${failures} FAILED`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
