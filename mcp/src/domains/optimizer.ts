// Optimizer domain: the `optimize` and `get_results` tools.
//
// optimize flow (mirrors the web UI's Start button plus MCP-specific guardrails):
//   1. character's saved form → computeLoadForm (merges conditional defaults)
//   2. merge agent `formOverrides` (display fields or get_form's internal fields;
//      nested maps like weights merge by key)
//   3. displayToInternal → internal request + rank + resultsLimit
//   4. permutation estimate via the recalculatePermutations recipe
//      (RelicFilters.getFilteredRelicCounts + set-solver valid count)
//   5. scale gate: > 5e7 valid permutations refuses unless force:true,
//      returning per-part counts and constraint-tightening suggestions
//   6. run in the driver worker with progress notifications (progressToken)
//      and cooperative cancellation (extra.signal → upstream CANCEL);
//      cancelled runs return the top-N rows found so far
//   7. top rows + full per-row 6-relic build details, cached for get_results

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import i18next from 'i18next'
import {
  COMPUTE_ENGINE_CPU,
  COMPUTE_ENGINE_GPU_EXPERIMENTAL,
  COMPUTE_ENGINE_GPU_STABLE,
  Constants,
} from 'lib/constants/constants'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  getCharacterById,
  getCharacters,
  useCharacterStore,
} from 'lib/stores/character/characterStore'
import {
  displayToInternal,
  internalToDisplay,
} from 'lib/stores/optimizerForm/optimizerFormConversions'
import { computeLoadForm } from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import { useOptimizerRequestStore } from 'lib/stores/optimizerForm/useOptimizerRequestStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import {
  detectZeroPermutationCauses,
  detectZeroResultCauses,
  type ZeroPermRootCause,
  ZeroPermRootCauseFixes,
  type ZeroResultRootCause,
  ZeroResultRootCauseFixes,
} from 'lib/tabs/tabOptimizer/suggestionsEngine'
import { z } from 'zod'

import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { browserManager } from '../browser/browserManager'
import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import {
  applyFormOverrides,
  constraintSuggestions,
  estimatePermutations,
  PERMUTATION_GATE,
} from '../permutations'
import {
  isOptimizationRunning,
  type OptimizeRunResult,
  runOptimization,
} from '../runOptimizer'
import { readStructuredSnapshot } from '../saveSnapshot'
import { serializeBuild } from '../serializers/builds'
import { toolResult } from '../toolResult'
import {
  finishJob,
  linkedAbortController,
  registerJob,
  updateJobProgress,
} from './jobs'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

// Upstream keep-limit tiers run 64…65536 (eleven doubling steps, web
// optimizer.form.target); the MCP cap accepts the whole range while keeping
// its own default (50 returned rows) unchanged.
const MAX_RESULTS = 65536
const ROW_STATS_KEYS_TO_SKIP = new Set(['id'])

// outputSchema 形状——以 handler 实际 return 的对象为准(serializeRowStats /
// serializeBuild 的序列化结果)。optimize 有拒绝/完成两种形状:除恒有的 status 外
// 其余字段按分支 .optional()。
const serializedSubstatSchema = z.object({
  stat: z.string(),
  value: z.number(),
  rolls: z.object({ high: z.number(), mid: z.number(), low: z.number() }).optional(),
  addedRolls: z.number().optional(),
})

const serializedRelicSchema = z.object({
  id: z.string(),
  part: z.string(),
  set: z.string(),
  grade: z.number(),
  enhance: z.number(),
  main: z.object({ stat: z.string(), value: z.number() }),
  substats: z.array(serializedSubstatSchema),
  initialRolls: z.number(),
  verified: z.boolean(),
  equippedBy: z.string().optional(),
  weightScore: z.null(),
})

const serializedBuildSchema = z.object({
  relics: z.record(z.string(), serializedRelicSchema),
  conflicts: z.array(z.string()),
})

const optimizerRowSchema = z.object({
  id: z.number(),
  stats: z.record(z.string(), z.number()),
  build: serializedBuildSchema,
})

const optimizeSummarySchema = z.object({
  gridSortColumn: z.string(),
  validPermutations: z.number(),
  naivePermutations: z.number(),
  searched: z.number(),
  durationMs: z.number(),
  cancelled: z.boolean(),
  cacheId: z.string(),
  characterId: z.string(),
  resultsLimit: z.number(),
})

// ─── validate / diagnose / applyFixes (suggestionsEngine reuse) ──────────────
//
// The Start button's non-search paths, headless:
//   validate=true   → validateForm's checks (optimizerFormActions.ts:252) with
//                     the fatal branches reported as errors and the
//                     Message.warning branches as a separate warnings channel
//                     (the update_form precedent) — no search is started
//   diagnose=true   → OptimizerSuggestionsModal's generators as pure reads:
//                     detectZeroPermutationCauses (valid permutations == 0)
//                     + detectZeroResultCauses (filters that could zero the
//                     result rows), each with its ZeroPerm/ZeroResultRootCauseFixes
//                     metadata and an applicable flag
//   applyFixes=true → the fix buttons: each applicable cause's upstream
//                     applyFix() against the character's SAVED form (loaded
//                     into useOptimizerRequestStore the updateCharacter way),
//                     persisted inside withChange('optimize:applyFixes') so a
//                     failure/conflict rolls the whole batch back

const suggestionFixSchema = z.object({
  buttonText: z.string(),
  applicable: z.boolean(),
  note: z.string().optional(),
})

const suggestionSchema = z.object({
  kind: z.enum(['zeroPermutations', 'zeroResults']),
  cause: z.string(),
  description: z.string(),
  fix: suggestionFixSchema,
})

const appliedFixSchema = z.object({
  kind: z.enum(['zeroPermutations', 'zeroResults']),
  cause: z.string(),
  fix: z.string(),
  result: z.string(),
})

/** The fix the web's IMPORT cause wires up is `navigateTo(AppPages.IMPORT)` —
 * a UI navigation with no headless form equivalent. */
const IMPORT_FIX_NOTE = '网页端此修复是跳转到导入页;MCP 侧请先用导入工具写入遗器库存后再重试(修复不可自动应用)'

type SuggestionKind = 'zeroPermutations' | 'zeroResults'

type SuggestionView = {
  kind: SuggestionKind,
  cause: string,
  description: string,
  fix: { buttonText: string, applicable: boolean, note?: string },
}

function suggestionView(kind: SuggestionKind, cause: ZeroPermRootCause | ZeroResultRootCause): SuggestionView {
  ensureI18nReady()
  const t = i18next.getFixedT(null, 'modals') as Any
  const fixes = kind === 'zeroPermutations'
    ? ZeroPermRootCauseFixes[cause as ZeroPermRootCause]
    : ZeroResultRootCauseFixes[cause as ZeroResultRootCause]
  const isImport = cause === 'IMPORT'
  return {
    kind,
    cause: String(cause),
    description: t(fixes.descriptionKey),
    fix: {
      buttonText: t(fixes.buttonTextKey),
      applicable: !isImport,
      ...(isImport ? { note: IMPORT_FIX_NOTE } : {}),
    },
  }
}

/** validateForm's checks with the messages the web toasts (zh_CN bundles):
 * fatal branches → errors (web refuses to start), Message.warning branches →
 * warnings. Fatal errors short-circuit the warnings exactly like upstream. */
function validationMessages(request: Any): { errors: string[], warnings: string[] } {
  ensureI18nReady()
  const t = i18next.getFixedT(null, 'optimizerTab', 'ValidationMessages') as Any
  const errors: string[] = []
  const warnings: string[] = []

  if (!request.lightCone || !request.lightConeSuperimposition) errors.push(t('Error.MissingLightCone'))
  if (!request.characterId || request.characterEidolon == undefined) errors.push(t('Error.MissingCharacter'))
  if (!request.resultsLimit || !request.resultSort) errors.push(t('Error.MissingTarget'))
  if (Object.values(Constants.SubStats).map((stat) => request.weights?.[stat]).filter((x) => !!x).length === 0) {
    errors.push(t('Error.TopPercent'))
  }
  if (errors.length > 0) return { errors, warnings }

  const lcMeta = (getGameMetadata().lightCones as Record<string, Any>)[request.lightCone]
  const charMeta = (getGameMetadata().characters as Record<string, Any>)[request.characterId]
  if (lcMeta?.path != charMeta?.path) warnings.push(t('Warning.PathMismatch'))
  if (charMeta?.scoringMetadata?.simulation && (!request.teammate0?.characterId || !request.teammate1?.characterId || !request.teammate2?.characterId)) {
    warnings.push(t('Warning.MissingTeammates'))
  }
  return { errors, warnings }
}

function serializeRowStats(row: OptimizerDisplayData): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'number' && !ROW_STATS_KEYS_TO_SKIP.has(key)) stats[key] = value
  }
  return stats
}

// ─── engine=gpu / gpu-experimental (M7: the web's real GPU execution path) ──
//
// Where the GPU engine actually runs: NOT in workerPool. The web's optimizer
// branches on savedSession.computeEngine — the CPU branch fans work out over
// workerPool.runTask (src/lib/optimization/optimizer.ts:314-435), while both
// GPU engines call gpuOptimize() directly on the main thread with a live
// GPUDevice (optimizer.ts:283-312 → lib/gpu/webgpuOptimizer.ts:44). The
// WorkerType enum has no GPU kind at all (lib/worker/workerUtils.ts), so
// "submit the request through __HSR_DEBUG.workerPool" would run the CPU worker
// in the browser — NOT the GPU engine. The real GPU path is therefore driven
// exactly like a user does: seed the page with the GPU computeEngine, let
// OptimizerForm boot the character (savedSession.optimizerCharacterId,
// OptimizerForm.tsx:46-49), click the site's own Start button and wait for the
// grid rows the engine produces. The same request is then re-run on the Node
// CPU driver and the two top rows are compared (delta summary).
//
// No progress notifications / cooperative cancellation on this path (the run
// lives inside the managed browser); rows stay DOM-scraped display values and
// are NOT pushed into the get_results cache (that cache holds the CPU driver's
// structured rows).

interface GpuEngineRunOptions {
  request: Any
  state: Any
  characterId: string
  resultsLimit: number
  engine: 'gpu' | 'gpu-experimental'
  validPermutations: number
  naivePermutations: number
}

/** ag-grid DOM scrape of the optimizer results grid. Values are the page's
 * DISPLAY strings (floor + grouping, renderer.tsx) — parsed to numbers for the
 * comparison with a display-floor tolerance in mind. */
const scrapeOptimizerGridRows = (() => {
  const rowEls = Array.from(document.querySelectorAll('[role="row"]')).filter((r) => r.querySelector('[role="gridcell"]'))
  return rowEls.map((r) => ({
    pinned: r.classList.contains('ag-row-pinned') || r.closest('.ag-floating-top') != null,
    cells: Object.fromEntries(
      Array.from(r.querySelectorAll('[role="gridcell"]')).map((c) => [c.getAttribute('col-id') ?? '', (c.textContent ?? '').trim()]),
    ),
  }))
}) as unknown as () => Array<{ pinned: boolean, cells: Record<string, string> }>

async function runGpuEngineOptimize(opts: GpuEngineRunOptions): Promise<CallToolResult> {
  const upstreamEngine = opts.engine === 'gpu' ? COMPUTE_ENGINE_GPU_STABLE : COMPUTE_ENGINE_GPU_EXPERIMENTAL

  // Capability gate — honest failure beats a faked GPU run.
  const launch = await browserManager.ensureLaunched()
  if (launch.webgpu?.available !== true) {
    throw new Error(
      `optimize(engine=${opts.engine}):受管浏览器无 WebGPU 能力,GPU 引擎不可用`
        + `${launch.webgpu?.error ? `(${launch.webgpu.error})` : '(requestAdapter 返回 null 或未暴露 navigator.gpu)'}。`
        + '请改用 engine=cpu(或默认 auto);如需确认设备能力,先调用 get_runtime_capabilities(action=launch)。'
        + 'GPU 引擎必须在真实浏览器中执行(网页端主线程 WebGPU 路径),本工具绝不假称已用 GPU 执行。',
    )
  }

  const generation = runtimeContext.getSaveGeneration()

  // Same rule as the CPU search path: flush pending mutations first so the
  // browser seed and the CPU comparison leg both see the live inventory (the
  // CPU driver reloads from the snapshot).
  runtimeContext.flushSave()

  // Seed: structured snapshot + GPU engine + the character as the optimizer
  // form's boot character (OptimizerForm.tsx:46-49 boots from
  // savedSession.optimizerCharacterId ?? characters[0]). The merged display
  // state (saved form + formOverrides) is written back into the seeded
  // character's saved form the same way applyFixes persists a live form
  // (displayToInternal merge), so the page runs THIS call's exact form.
  const snapshot = JSON.parse(JSON.stringify(readStructuredSnapshot())) as Any
  snapshot.savedSession.global.computeEngine = upstreamEngine
  snapshot.savedSession.global.optimizerCharacterId = opts.characterId
  const seededChar = (snapshot.characters as Any[])?.find((c) => c?.id === opts.characterId)
  if (seededChar) {
    seededChar.form = {
      ...seededChar.form,
      ...displayToInternal(opts.state),
      resultsLimit: opts.resultsLimit,
    }
  }

  const gpu = await browserManager.runTask(
    { label: `optimize(engine=${opts.engine})`, seed: JSON.stringify(snapshot), timeoutMs: 600_000 },
    async (page) => {
      await page.goto('#main', { timeoutMs: 60_000 })

      // The site's own Start button — located by its bolt icon (locale-free).
      // Tabs stagger-mount (Tabs.tsx:105-108) and the optimizer form boots the
      // character through an effect (OptimizerForm.tsx:46-49); clicking Start
      // before that effect lands fails the page's own validation silently (the
      // button never enters loading). Click-and-verify with retries: a click
      // that produced no loading started no run, so retrying is safe.
      const startAttempt = `async () => {
        const boltButton = () => Array.from(document.querySelectorAll('button'))
          .find((b) => b.querySelector('svg[class*="tabler-icon-bolt-filled"]'))
        const notifications = () => Array.from(document.querySelectorAll('[role="alert"], .mantine-Notification-root'))
          .map((n) => (n.textContent ?? '').trim())
          .filter((t) => t.length > 0)
        for (let attempt = 0; attempt < 5; attempt++) {
          const btn = boltButton()
          if (!btn) return { started: false, reason: '未找到开始按钮(闪电图标)', toasts: [] }
          btn.click()
          const settle = Date.now() + 6000
          while (Date.now() < settle) {
            await new Promise((r) => setTimeout(r, 300))
            if (boltButton()?.getAttribute('data-loading') === 'true') return { started: true, toasts: [] }
          }
        }
        return { started: false, reason: 'Start 后按钮未转为 loading(页面表单校验未通过或 GPU 设备请求失败)', toasts: notifications() }
      }`
      const startResult = await page.evaluate<Record<string, unknown>>(startAttempt)
      if (startResult['started'] !== true) {
        const toasts = Array.isArray(startResult['toasts']) ? (startResult['toasts'] as string[]).join(' | ') : ''
        throw new Error(
          `optimize(engine=gpu):网页端未进入优化运行状态——${String(startResult['reason'])}`
            + `${toasts ? `;页面提示:${toasts}` : ''}`,
        )
      }

      const buttonState = `(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find((b) => b.querySelector('svg[class*="tabler-icon-bolt-filled"]'))
        return { loading: btn?.getAttribute('data-loading') === 'true' }
      })()`

      // startAttempt above already confirmed loading=true — now wait for the
      // run to finish (button leaves loading).
      const startedAt = Date.now()
      const doneDeadline = Date.now() + 540_000
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        const state = await page.evaluate<Record<string, unknown>>(buttonState)
        if (state['loading'] !== true) break
        if (Date.now() >= doneDeadline) {
          throw new Error('optimize(engine=gpu):浏览器内 GPU 优化 9 分钟未完成——可缩小 resultsLimit 或改用 engine=cpu')
        }
      }
      const durationMs = Date.now() - startedAt

      // Which engine did the page ACTUALLY run? Boot-time verifyWebgpuSupport
      // flips the session to CPU when the adapter dies (webgpuDevice.ts:31-40),
      // so trust the harvested save, never the seed.
      const harvested = await page.harvestSaveState()
      const actualEngineValue: string | null = harvested?.savedSession?.global?.computeEngine ?? null

      const rows = await page.evaluate<Array<{ pinned: boolean, cells: Record<string, string> }>>(
        scrapeOptimizerGridRows.toString(),
      )
      return { durationMs, actualEngineValue, rows }
    },
  )

  // Same-request CPU run on the Node driver for the cross-check summary.
  const cpu = await runOptimization(runtimeContext.requireSave().data, opts.request, {})

  if (generation !== runtimeContext.getSaveGeneration()) {
    throw new Error('运行期间 load_save 切换了存档,GPU 对拍结果已丢弃——请对当前存档重新优化')
  }

  const engineEcho = { engine: opts.engine, actualEngine: opts.engine }
  if (gpu.actualEngineValue !== upstreamEngine) {
    // The page fell back to CPU (or flipped the session) — report what ran.
    return toolResult(
      {
        status: 'completed',
        ...engineEcho,
        actualEngine: gpu.actualEngineValue === COMPUTE_ENGINE_CPU ? 'cpu' : engineEcho.actualEngine,
        adapter: launch.webgpu,
        note: `网页实际以 ${
          gpu.actualEngineValue ?? '未知'
        } 引擎完成运行(请求 ${upstreamEngine})——启动时 verifyWebgpuSupport 检测到设备不可用会回落 CPU;结果按实际引擎理解`,
        gpuRows: gpu.rows.filter((r) => !r.pinned).map((r) => ({ cells: r.cells })),
        rowCount: gpu.rows.filter((r) => !r.pinned).length,
        gpuDurationMs: gpu.durationMs,
        comparison: {
          column: cpu.summary.gridSortColumn,
          cpuRows: cpu.rows.length,
          gpuRows: gpu.rows.filter((r) => !r.pinned).length,
          note: '页面引擎与请求不一致,对拍仅供参考',
        },
      },
      `optimize(${opts.characterId}, engine=${opts.engine}) 完成,但网页实际以 ${gpu.actualEngineValue ?? '未知'} 引擎运行(设备不可用回落)——`
        + `GPU 侧 ${gpu.rows.filter((r) => !r.pinned).length} 行,CPU 对拍 ${cpu.rows.length} 行。`,
    )
  }

  const gpuRows = gpu.rows.filter((r) => !r.pinned)
  const equippedCells = gpu.rows.find((r) => r.pinned)?.cells ?? null
  const column = cpu.summary.gridSortColumn
  const parseCell = (cells: Record<string, string> | null | undefined) => {
    const text = cells?.[column]
    if (text == null) return null
    const num = Number(text.replace(/[,\s]/g, ''))
    return Number.isFinite(num) ? num : null
  }
  const cpuTop = cpu.rows[0] != null ? Number((cpu.rows[0] as Any)[column]) : null
  const gpuTop = parseCell(gpuRows[0]?.cells)

  return toolResult(
    {
      status: 'completed',
      ...engineEcho,
      adapter: launch.webgpu,
      gpuRows: gpuRows.map((r) => ({ cells: r.cells })),
      rowCount: gpuRows.length,
      ...(equippedCells ? { equippedRowCells: equippedCells } : {}),
      gpuDurationMs: gpu.durationMs,
      comparison: {
        column,
        ...(cpuTop != null ? { cpuTop } : {}),
        ...(gpuTop != null ? { gpuTop } : {}),
        ...(cpuTop != null && gpuTop != null
          ? { topDelta: cpuTop - gpuTop, topDeltaNote: 'GPU 值取自页面显示口径(向下取整),|topDelta|≤1 视为一致' }
          : {}),
        cpuRows: cpu.rows.length,
        gpuRows: gpuRows.length,
        cpuDurationMs: cpu.summary.durationMs,
      },
      summary: {
        characterId: opts.characterId,
        resultsLimit: opts.resultsLimit,
        validPermutations: opts.validPermutations,
        naivePermutations: opts.naivePermutations,
        searched: opts.validPermutations,
        durationMs: gpu.durationMs,
        cancelled: false,
        gridSortColumn: column,
        cacheId: '',
      },
      note: 'GPU 运行在受管浏览器内执行(网页端主线程 WebGPU 路径,非 workerPool——后者只承载 CPU worker);'
        + '结果为 DOM 抓取的显示口径(取整),未进入 get_results 缓存(其为 CPU 驱动的结构化缓存);'
        + 'CPU 对拍行数/头部值见 comparison',
    },
    `optimize(${opts.characterId}, engine=${opts.engine}) 完成:GPU 引擎 ${gpuRows.length} 行,`
      + `耗时 ${(gpu.durationMs / 1000).toFixed(2)}s`
      + `${cpuTop != null && gpuTop != null ? `,CPU 对拍头部 ${column} ${cpuTop.toLocaleString()} vs ${gpuTop.toLocaleString()}` : ''}`
      + `${launch.webgpu?.softwareAdapter === true ? '(软件适配器)' : ''}。`,
  )
}

export function registerOptimizerTools(server: McpServer): void {
  /** Loads the character's SAVED form into the request store the updateCharacter
   * way so the upstream fix actions operate on the persisted form (formOverrides
   * are per-run parameters and deliberately excluded). Returns the internal
   * request used for the before-estimate. Call inside a withChange scope. */
  function loadSavedFormIntoRequestStore(character: Any, characterId: string, resultsLimit: number): Any {
    useOptimizerRequestStore.getState().loadForm(character.form)
    // The PRIORITY fix moves focusCharacterId to the top — point it at the
    // character being fixed (web: the focused char).
    useOptimizerDisplayStore.getState().setFocusCharacterId(characterId as Any)
    const savedRequest: Any = displayToInternal(useOptimizerRequestStore.getState())
    savedRequest.characterId = characterId
    savedRequest.rank = getCharacters().findIndex((c: Any) => c.id === characterId)
    savedRequest.resultsLimit = resultsLimit
    return savedRequest
  }

  server.registerTool('optimize', {
    title: '执行遗器优化搜索',
    description: '为单个角色执行遗器优化搜索——对应网页端 Optimizer 页签的「开始优化」按钮(同一台上游引擎,CPU 多线程版,'
      + '结果与网页端一致)。从角色已保存表单出发,可合并 formOverrides:支持显示表单的 statFilters/ratingFilters/setFilters/teammates,'
      + '以及 get_form/default_form 返回的内部字段 minSpd 等 min/max、relicSets/ornamentSets、teammate0/1/2。'
      + '含内部专有字段的完整表单自动按内部格式识别;仅覆盖 combatBuffs 等两种格式共有字段时可用 format:"internal" 显式选择内部格式。'
      + '显示格式 combatBuffs 百分数字段使用百分数(如 50 表示 50%);内部格式使用小数(0.5)。weights 与条件等嵌套对象按键合并,其余字段整体替换。'
      + '有效排列超过 5e7 时默认拒绝(CPU 引擎约 1e6 排列/秒;网页端默认 WebGPU 更快,结果相同),可用 force=true 强制运行。'
      + '客户端提供 progressToken 时发送进度通知;取消会保留已搜索到的结果。运行期间 load_save 切档时丢弃该次结果并报错,须对当前存档重新优化。'
      + '返回前 resultsLimit 行(每行附 6 件遗器配装明细),'
      + '并附 equippedRow(角色当前已装备 6 件遗器的基线行,含属性与配装明细;极快/被取消的运行可能为 null),结果缓存供 get_results 翻页。'
      + '三个不启动搜索的模式(互斥,一次至多传一个):validate=true 只跑网页端「开始」前的表单校验'
      + '(致命问题进 errors、非致命警告进 warnings,均不落盘);diagnose=true 做零排列/零结果诊断'
      + '(复用 suggestionsEngine 的原因检测,返回建议清单含可应用标记,只读);'
      + 'applyFixes=true 应用可应用的修复到角色已保存表单(withChange 事务,可回滚;baseRevision 冲突时报错且不落地),'
      + '返回应用结果与修复前后的排列数对比。resultsLimit 上限 65536(网页端保留条数的最大档)。'
      + 'engine 可选引擎(默认 auto):auto/cpu=Node 侧 CPU 驱动(与网页 CPU 引擎同一台上游引擎,行为不变);'
      + 'gpu/gpu-experimental=受管浏览器里的网页端真实 WebGPU 引擎(点网页自己的开始按钮、抓结果网格,同请求 CPU 对拍报 delta;需要本机 Chrome 与 WebGPU,缺能力时返回明确中文错误)。',
    inputSchema: {
      characterId: z.string().describe('角色 id,如 "1212b1"(可用 id 见 load_save 返回的 characterIds)'),
      formOverrides: z.record(z.string(), z.unknown()).optional().describe(
        '部分覆盖,支持显示表单与 get_form/default_form 内部字段。内部专有字段自动识别;共有字段可加 format:"internal"。'
          + '显示格式 combatBuffs 百分数字段用百分数,内部格式用小数。weights/条件/队友等嵌套对象按键合并;其余字段整体替换。'
          + 'validate/diagnose 模式同样合并;applyFixes 模式忽略覆盖(修复只作用于角色已保存表单)。',
      ),
      resultsLimit: z.number().int().min(1).max(MAX_RESULTS).default(50).describe(
        '保留并返回的前 N 行(1-65536;网页端「保留条数」下拉为 64-65536 的 11 个翻倍档)',
      ),
      force: z.boolean().default(false).describe('跳过 5e7 有效排列规模闸门'),
      validate: z.boolean().default(false).describe(
        '只跑表单校验不启动搜索:致命问题(缺光锥/缺角色/缺优化目标/权重全 0)进 errors,非致命警告(命途不符/队友未填满)进 warnings;与 diagnose/applyFixes 互斥',
      ),
      diagnose: z.boolean().default(false).describe(
        '零排列/零结果诊断(只读):有效排列为 0 时列出零排列原因,并始终列出可能清空结果行的上下限过滤;每条附修复按钮文案与可应用标记;与 validate/applyFixes 互斥',
      ),
      applyFixes: z.boolean().default(false).describe(
        '应用诊断出的可应用修复到角色已保存表单(主词条清空/套装筛选清空/关闭保留当前遗器/角色移到首位/清空排除/启用已装备遗器/权重门槛归零/上下限清除/切回战斗属性视图),'
          + 'withChange 事务化并可传 baseRevision;返回应用清单与修复前后排列数对比;与 validate/diagnose 互斥',
      ),
      baseRevision: z.number().int().optional().describe(
        '乐观并发门(applyFixes=true 时生效):调用方读取状态时拿到的修订号;与当前不一致报冲突,修复不落地,需重读后重试',
      ),
      engine: z.enum(['auto', 'cpu', 'gpu', 'gpu-experimental']).optional().describe(
        '计算引擎,默认 auto:引擎选择只影响搜索执行方式,结果语义一致。'
          + 'auto/cpu=Node 侧 CPU 多线程驱动(与既有行为完全一致);'
          + 'gpu/gpu-experimental=网页端真实 WebGPU 引擎(GPU Stable/GPU Experimental),'
          + '在受管浏览器里点网页自己的开始按钮执行并抓取结果网格,同请求再跑一次 CPU 对拍报头部值差;'
          + '设备无 WebGPU 时返回明确的中文能力错误(绝不假称已用 GPU 执行);'
          + 'GPU 路径无进度通知与协作取消,结果不进入 get_results 缓存',
      ),
    },
    outputSchema: {
      status: z.enum(['rejected', 'completed', 'cancelled', 'validated', 'diagnosed', 'fixed']),
      engine: z.enum(['auto', 'cpu', 'gpu', 'gpu-experimental']).optional()
        .describe('本次调用请求的计算引擎(auto=未传时的默认)'),
      actualEngine: z.enum(['cpu', 'gpu', 'gpu-experimental']).optional()
        .describe('实际执行引擎:CPU 路径恒为 cpu;GPU 路径以页面运行结束时存档里的引擎值为准(设备不可用时网页会回落 cpu)'),
      adapter: z.object({
        available: z.boolean().nullable(),
        softwareAdapter: z.boolean().nullable(),
        vendor: z.string().nullable(),
        architecture: z.string().nullable(),
        device: z.string().nullable(),
        maxBufferMB: z.number().nullable(),
        uniformBufferStandardLayout: z.boolean().nullable(),
      }).nullable().optional().describe('engine=gpu 路径的 WebGPU 适配器摘要'),
      gpuRows: z.array(z.object({ cells: z.record(z.string(), z.string()) })).optional()
        .describe('engine=gpu:从网页结果网格抓取的行(显示口径字符串值,colId→文本)'),
      rowCount: z.number().int().optional().describe('engine=gpu:非置顶结果行数'),
      equippedRowCells: z.record(z.string(), z.string()).nullable().optional()
        .describe('engine=gpu:置顶的已装备基线行(显示口径;无则为 null/缺省)'),
      gpuDurationMs: z.number().optional().describe('engine=gpu:浏览器内 GPU 运行耗时(毫秒)'),
      comparison: z.object({
        column: z.string(),
        cpuTop: z.number().optional(),
        gpuTop: z.number().optional(),
        topDelta: z.number().optional(),
        topDeltaNote: z.string().optional(),
        cpuRows: z.number().int(),
        gpuRows: z.number().int(),
        cpuDurationMs: z.number().optional(),
        note: z.string().optional(),
      }).optional().describe('engine=gpu:同一请求 CPU 驱动对拍(头部值/行数)'),
      reason: z.string().optional(),
      note: z.string().optional().describe('fixed 模式:无修复时的说明(表单保持原样)'),
      valid: z.boolean().optional().describe('validate 模式:是否通过全部致命校验'),
      errors: z.array(z.string()).optional().describe('validate 模式:致命问题清单(网页端会拒绝开始的原因)'),
      warnings: z.array(z.string()).optional().describe('非致命警告清单(网页端仅提示,不阻止运行)'),
      suggestions: z.array(z.string()).optional(),
      diagnosis: z.array(suggestionSchema).optional().describe('diagnose/applyFixes 模式:建议清单(含可应用标记)'),
      applied: z.array(appliedFixSchema).optional().describe('applyFixes 模式:已应用的修复及结果文案'),
      permutations: z.object({
        before: z.number(),
        after: z.number(),
        naiveBefore: z.number(),
        naiveAfter: z.number(),
        partCountsAfter: z.record(z.string(), z.number()),
        partCountsBeforeFiltersAfter: z.record(z.string(), z.number()),
      }).optional().describe('applyFixes 模式:修复前后的有效排列数对比'),
      validPermutations: z.number().optional(),
      naivePermutations: z.number().optional(),
      partCounts: z.record(z.string(), z.number()).optional(),
      partCountsBeforeFilters: z.record(z.string(), z.number()).optional(),
      constraintSuggestions: z.array(z.string()).optional(),
      rows: z.array(optimizerRowSchema).optional(),
      equippedRow: z.object({
        stats: z.record(z.string(), z.number()),
        build: serializedBuildSchema,
      }).nullable().optional(),
      summary: optimizeSummarySchema.optional(),
      revision: z.number().int().optional(),
      dirty: z.boolean().optional(),
    },
  }, async (
    { characterId, formOverrides, resultsLimit, force, validate, diagnose, applyFixes, baseRevision, engine },
    extra,
  ): Promise<CallToolResult> => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    // engine resolution: auto ≡ cpu — the pre-existing Node path, untouched.
    const engineRequested = engine ?? 'auto'
    const useGpuEngine = engineRequested === 'gpu' || engineRequested === 'gpu-experimental'
    const engineEcho = { engine: engineRequested, actualEngine: useGpuEngine ? engineRequested as 'gpu' | 'gpu-experimental' : 'cpu' as const }

    const character = getCharacterById(characterId as Any)
    if (!character) {
      throw new Error(`Character ${characterId} not found. Loaded characters: ${getCharacters().map((c) => c.id).join(', ')}`)
    }

    const selectedModes = [validate === true, diagnose === true, applyFixes === true].filter((x) => x).length
    if (selectedModes > 1) {
      throw new Error('optimize: validate / diagnose / applyFixes 互斥 — 一次调用至多传一个;applyFixes 本身会附带完整诊断清单')
    }

    if (validate !== true && applyFixes !== true && isOptimizationRunning()) {
      throw new Error('Another optimization is already running — wait for it or cancel it first')
    }

    const state = computeLoadForm(character.form)
    if (formOverrides) applyFormOverrides(state, formOverrides)

    const request: Any = displayToInternal(state)
    request.characterId = characterId
    request.rank = getCharacters().findIndex((c: Any) => c.id === characterId)
    request.resultsLimit = resultsLimit

    const estimate = estimatePermutations(request)

    // ── validate: the Start button's pre-flight checks, no search ────────────
    if (validate === true) {
      const { errors, warnings } = validationMessages(request)
      return toolResult(
        {
          status: 'validated',
          ...engineEcho,
          valid: errors.length === 0,
          errors,
          warnings,
          validPermutations: estimate.validPermutations,
          naivePermutations: estimate.naivePermutations,
        },
        `表单校验完成(${characterId}):${errors.length === 0 ? '通过' : `${errors.length} 项致命问题(网页端会拒绝开始)`}`
          + `${warnings.length > 0 ? `,${warnings.length} 条非致命警告` : ''};未启动搜索`
          + `——有效排列约 ${estimate.validPermutations.toLocaleString()}`,
      )
    }

    // ── diagnose: OptimizerSuggestionsModal's detectors, read-only ───────────
    if (diagnose === true) {
      // detectZeroResultCauses reads the request store's statDisplay for the
      // STAT_VIEW cause — sync it to the diagnosed form so the verdict matches
      // what a run with this exact form would trigger (updateCharacter recipe).
      useOptimizerRequestStore.getState().setStatDisplay(state.statDisplay ?? 'combat')

      const zeroPerm = estimate.validPermutations === 0 ? detectZeroPermutationCauses(request) : []
      const zeroResult = detectZeroResultCauses(request)
      const diagnosis = [
        ...zeroPerm.map((cause) => suggestionView('zeroPermutations', cause)),
        ...zeroResult.map((cause) => suggestionView('zeroResults', cause)),
      ]
      return toolResult(
        {
          status: 'diagnosed',
          ...engineEcho,
          validPermutations: estimate.validPermutations,
          naivePermutations: estimate.naivePermutations,
          partCounts: estimate.counts,
          partCountsBeforeFilters: estimate.preCounts,
          diagnosis,
        },
        `诊断完成(${characterId}):有效排列 ${estimate.validPermutations.toLocaleString()}`
          + `${zeroPerm.length > 0 ? `,检出 ${zeroPerm.length} 条零排列原因` : '(非零排列)'}`
          + `;可能清空结果行的过滤 ${zeroResult.length} 条;共 ${diagnosis.length} 条建议,未启动搜索`,
      )
    }

    // ── applyFixes: the fix buttons against the character's SAVED form ───────
    if (applyFixes === true) {
      // Diagnosis runs on a THROWAWAY probe state — the live request store is
      // only loaded inside the withChange below, so a baseRevision conflict or
      // a failed fix rolls that load back with everything else (it used to
      // leak past the transaction boundary). formOverrides are per-run
      // parameters and deliberately excluded — applyFixes never writes a form
      // the agent did not save.
      // internalToDisplay mirrors loadForm's conversion wholesale — applyFormOverrides
      // would reject display-only keys saved forms legitimately carry (minCv…).
      const probeState = { ...useOptimizerRequestStore.getState(), ...internalToDisplay(character.form as Any) } as Any
      const savedRequest: Any = displayToInternal(probeState)
      savedRequest.characterId = characterId
      savedRequest.rank = getCharacters().findIndex((c: Any) => c.id === characterId)
      savedRequest.resultsLimit = resultsLimit
      const before = estimatePermutations(savedRequest)
      const permCauses = before.validPermutations === 0 ? detectZeroPermutationCauses(savedRequest) : []
      const resultCauses = detectZeroResultCauses(savedRequest)
      const diagnosis = [
        ...permCauses.map((cause) => suggestionView('zeroPermutations', cause)),
        ...resultCauses.map((cause) => suggestionView('zeroResults', cause)),
      ]

      const applicable = diagnosis.filter((s) => s.fix.applicable)
      const applied: Array<{ kind: SuggestionKind, cause: string, fix: string, result: string }> = []

      if (diagnosis.length === 0) {
        return toolResult(
          {
            status: 'fixed',
            ...engineEcho,
            diagnosis,
            applied,
            permutations: {
              before: before.validPermutations,
              after: before.validPermutations,
              naiveBefore: before.naivePermutations,
              naiveAfter: before.naivePermutations,
              partCountsAfter: before.counts,
              partCountsBeforeFiltersAfter: before.preCounts,
            },
            revision: runtimeContext.getRevision(),
            dirty: runtimeContext.isDirty(),
            note: '未检测到零排列/零结果原因,没有应用任何修复(表单保持原样)',
          },
          `applyFixes(${characterId}):没有可修复的原因——有效排列 ${before.validPermutations.toLocaleString()},可能清空结果的过滤 0 条;未做任何改动`,
        )
      }

      ensureI18nReady()
      const t = i18next.getFixedT(null, 'modals') as Any

      await runtimeContext.withChange('optimize:applyFixes', () => {
        // Inside the scope: the request-store load below mutates live stores —
        // capturing it in the dequeue-time snapshot means a baseRevision
        // conflict or a failed fix rolls the loaded form back with everything
        // else (it used to leak past the transaction boundary).
        const savedFormState = loadSavedFormIntoRequestStore(character, characterId, resultsLimit)

        for (const suggestion of applicable) {
          // The exact fix the web's modal button runs — store actions over the
          // request store loaded with this character's saved form above.
          const fixes = suggestion.kind === 'zeroPermutations'
            ? ZeroPermRootCauseFixes[suggestion.cause as ZeroPermRootCause]
            : ZeroResultRootCauseFixes[suggestion.cause as ZeroResultRootCause]
          fixes.applyFix()
          applied.push({
            kind: suggestion.kind,
            cause: suggestion.cause,
            fix: suggestion.fix.buttonText,
            result: t(fixes.successMessageKey),
          })
        }
        // Persist the fixed live form (syncFormToCharacterStore's merge shape):
        // display state → internal form, merged over the character's saved form.
        const finalForm = displayToInternal(useOptimizerRequestStore.getState())
        const found = getCharacterById(characterId as Any)!
        useCharacterStore.getState().setCharacter({ ...found, form: { ...found.form, ...finalForm } })
        runtimeContext.markDirty()
      }, baseRevision != null ? { baseRevision } : {})

      const afterRequest: Any = displayToInternal(useOptimizerRequestStore.getState())
      afterRequest.characterId = characterId
      afterRequest.rank = getCharacters().findIndex((c: Any) => c.id === characterId)
      const after = estimatePermutations(afterRequest)

      return toolResult(
        {
          status: 'fixed',
          ...engineEcho,
          diagnosis,
          applied,
          permutations: {
            before: before.validPermutations,
            after: after.validPermutations,
            naiveBefore: before.naivePermutations,
            naiveAfter: after.naivePermutations,
            partCountsAfter: after.counts,
            partCountsBeforeFiltersAfter: after.preCounts,
          },
          revision: runtimeContext.getRevision(),
          dirty: true,
        },
        `已应用 ${applied.length}/${diagnosis.length} 条修复(${applied.map((a) => a.cause).join(', ') || '无'}):`
          + `有效排列 ${before.validPermutations.toLocaleString()} → ${after.validPermutations.toLocaleString()}`
          + `${after.validPermutations > before.validPermutations ? '(已回升)' : ''}`
          + `${diagnosis.some((s) => !s.fix.applicable) ? `;${diagnosis.length - applicable.length} 条不可自动应用(见 diagnosis)` : ''}`
          + `,revision=${runtimeContext.getRevision()}`,
      )
    }

    if (estimate.validPermutations > PERMUTATION_GATE && !force) {
      return toolResult(
        {
          status: 'rejected',
          ...engineEcho,
          reason: `有效排列 ${estimate.validPermutations.toLocaleString()} 超过 ${PERMUTATION_GATE.toExponential()} 闸门`,
          validPermutations: estimate.validPermutations,
          naivePermutations: estimate.naivePermutations,
          partCounts: estimate.counts,
          partCountsBeforeFilters: estimate.preCounts,
          suggestions: constraintSuggestions(request),
        },
        `已拒绝:约 ${estimate.validPermutations.toExponential(2)} 有效排列超过 5e7 闸门。`
          + '请收紧约束(见 suggestions)或用 force:true 重试。',
      )
    }

    // ── engine=gpu / gpu-experimental: the web's real GPU execution path ────
    // Gate semantics are shared with the CPU path above (same valid-permutation
    // ceiling, same force override); the GPU run additionally needs the managed
    // browser with WebGPU and runs an equal CPU pass for the delta summary.
    if (useGpuEngine) {
      return runGpuEngineOptimize({
        request,
        state,
        characterId,
        resultsLimit,
        engine: engineRequested as 'gpu' | 'gpu-experimental',
        validPermutations: estimate.validPermutations,
        naivePermutations: estimate.naivePermutations,
      })
    }

    // Job registry (M4-B): the run's cacheId doubles as its jobId. cancel_job
    // aborts the linked controller — the exact cooperative-cancel path a
    // request-signal cancellation takes (runOptimization forwards it to the
    // driver as CANCEL; partial results are kept, never thrown away).
    const cacheId = runtimeContext.nextCacheId()
    const cancelController = linkedAbortController(extra.signal)

    // Progress: the job registry is always updated (get_job reads it);
    // notifications go out only when the client sent a progressToken
    const progressToken = (extra._meta as Any)?.progressToken
    const onProgress = (p: {
      searched: number,
      total: number,
      results: number,
      ratePerSec: number,
    }) => {
      updateJobProgress(cacheId, {
        searched: p.searched,
        totalPermutations: p.total,
        results: p.results,
        ratePerSec: p.ratePerSec,
      })
      if (progressToken == null) return
      void extra.sendNotification({
        method: 'notifications/progress' as const,
        params: {
          progressToken,
          progress: p.searched,
          ...(p.total > 0 ? { total: p.total } : {}),
          message: `searched ${p.searched.toLocaleString()} permutations, ${p.results} results, ${p.ratePerSec.toLocaleString()}/s`,
        },
      } as Any).catch(() => {
        // Transport closing mid-run — progress is best-effort
      })
    }

    // Force-flush pending mutations into the snapshot the driver reloads from,
    // so a run can never search a stale inventory (matters once equip tools land).
    // Before registerJob on purpose: flushSave can throw (e.g. EACCES on the
    // save file) and a job registered earlier would stay running forever.
    runtimeContext.flushSave()

    registerJob(cacheId, 'optimize', {
      cancel: () => cancelController.abort(),
      summary: { characterId, resultsLimit, validPermutations: estimate.validPermutations },
    })

    const generation = runtimeContext.getSaveGeneration()
    let run: OptimizeRunResult
    try {
      run = await runOptimization(runtimeContext.requireSave().data, request, {
        onProgress,
        signal: cancelController.signal,
      })
    } catch (e) {
      finishJob(cacheId, 'failed', { error: String((e as Error)?.message ?? e) })
      throw e
    }

    // load_save remains available while the driver searches its own snapshot.
    // Discard that snapshot's results before caching or hydrating relic ids:
    // the new inventory may contain different relics with the same ids.
    if (generation !== runtimeContext.getSaveGeneration()) {
      finishJob(cacheId, 'failed', { error: '运行期间 load_save 切换了存档,结果已丢弃——请对当前存档重新优化' })
      throw new Error('A load_save changed the save while optimization was running — results were discarded; re-run optimize for the current save')
    }

    // Cache BEFORE finishJob: the completion event fans out to job listeners
    // (jobs registry → full-sync job events with resultRef), and the ref is
    // only meaningful once getLastOptimizeResult() holds THIS run. The old
    // order left resultRef permanently null (finishJob fired first, the cache
    // still held the previous run — or nothing).
    runtimeContext.cacheOptimizeResult({
      summary: {
        cacheId,
        characterId,
        gridSortColumn: run.summary.gridSortColumn,
        validPermutations: run.summary.validPermutations,
        naivePermutations: run.summary.naivePermutations,
        searched: run.summary.searched,
        durationMs: run.summary.durationMs,
        cancelled: run.summary.cancelled,
        resultsLimit,
      },
      rows: run.rows,
      builds: run.builds,
      displayState: state,
      generation,
      at: Date.now(),
    })

    finishJob(cacheId, run.summary.cancelled ? 'cancelled' : 'completed', {
      searched: run.summary.searched,
      durationMs: run.summary.durationMs,
      rows: run.rows.length,
    })

    const rows = run.rows.map((row, index) => ({
      id: row.id,
      stats: serializeRowStats(row),
      build: serializeBuild(run.builds[index] ?? {}, characterId),
    }))

    // Baseline row for the character's currently equipped 6 relics (the web UI's
    // pinned top row). The driver computes it during the run; null when the run
    // finished before the baseline simulation landed (very fast / cancelled runs).
    const equippedRow = run.equippedRow != null
      ? {
        stats: run.equippedRow.stats,
        build: serializeBuild(run.equippedRow.build, characterId),
      }
      : null

    return toolResult(
      {
        status: run.summary.cancelled ? 'cancelled' : 'completed',
        ...engineEcho,
        rows,
        equippedRow,
        summary: {
          ...run.summary,
          cacheId,
          characterId,
          resultsLimit,
        },
      },
      `${run.summary.cancelled ? '已取消' : '已完成'} ${characterId} 的优化:`
        + `${rows.length} 行,在 ${(run.summary.durationMs / 1000).toFixed(2)}s 内搜索了 ${run.summary.searched.toLocaleString()} / `
        + `${run.summary.validPermutations.toLocaleString()} 个有效排列(cacheId ${cacheId})`,
    )
  })

  server.registerTool('get_results', {
    title: '翻页读取最近一次优化结果',
    description: '从最近一次 optimize 的缓存结果翻页读取——对应网页端优化结果网格的排序与筛选:'
      + 'offset/limit 分页,可按任意数值列(如 COMBO、EHP、xSPD)重新排序,支持数值列 min/max 过滤。'
      + '每行保留完整属性块与 6 件遗器配装明细;响应附 summary(该次运行的 cancelled/searched/validPermutations/'
      + 'characterId/gridSortColumn/resultsLimit 等,取消语义以此为准)。缓存所属存档必须仍是当前存档;load_save 后须重新运行 optimize。'
      + 'rowIds:按行 id 直接选中若干行返回完整明细(网页端「固定到顶部」对比行的取数口径)——不受当前排序与筛选影响,'
      + '与 offset/limit/sortBy/filters 互斥;不存在的行 id 报错并列出有效 id 示例。',
    inputSchema: {
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(50),
      sortBy: z.string().optional().describe('排序用的数值列名,如 "COMBO"(默认保持优化器输出顺序)'),
      sortDir: z.enum(['asc', 'desc']).default('desc'),
      filters: z.array(z.object({
        column: z.string().describe('数值列名,如 "COMBO"、"EHP"、"xSPD"、"WEIGHT"'),
        min: z.number().optional(),
        max: z.number().optional(),
      })).optional().describe('保留所有列出列都落在 [min, max] 区间内的行'),
      rowIds: z.array(z.number().int()).min(1).max(MAX_RESULTS).optional().describe(
        '按行 id 选中返回(optimize 返回行中的 id 字段);设置时忽略分页/排序/筛选;不存在的行 id 报错',
      ),
    },
    outputSchema: {
      cacheId: z.string(),
      characterId: z.string(),
      summary: optimizeSummarySchema,
      total: z.number().int(),
      offset: z.number().int(),
      limit: z.number().int(),
      sort: z.object({ by: z.string(), dir: z.enum(['asc', 'desc']) }).nullable(),
      rows: z.array(optimizerRowSchema),
    },
  }, async ({ offset, limit, sortBy, sortDir, filters, rowIds }) => {
    const cached = runtimeContext.getLastOptimizeResult()
    if (!cached) {
      throw new Error('No cached optimize results — run optimize first')
    }
    if (cached.generation !== runtimeContext.getSaveGeneration()) {
      throw new Error('Cached optimize results belong to a previous save load — re-run optimize for the current save before reading results')
    }

    // Pinned-row selection (optimizer.results.pin): exact ids straight out of
    // the cache, immune to any sort/filter the caller applies elsewhere.
    if (rowIds != null) {
      const ids = [...new Set(rowIds)]
      const selected = ids.map((id) => {
        const index = cached.rows.findIndex((row) => row.id === id)
        if (index === -1) {
          throw new Error(
            `get_results: 结果缓存 ${cached.summary.cacheId} 中不存在行 id ${id} — 共 ${cached.rows.length} 行,`
              + `有效 id 示例: ${cached.rows.slice(0, 5).map((row) => row.id).join(', ')}${cached.rows.length > 5 ? '…' : ''}`
              + '(行 id 见 optimize 返回的 rows[].id,按当前排序翻页可核对)',
          )
        }
        return { row: cached.rows[index], build: cached.builds[index] ?? {} }
      })
      return toolResult(
        {
          cacheId: cached.summary.cacheId,
          characterId: cached.summary.characterId,
          summary: { ...cached.summary },
          total: cached.rows.length,
          offset: 0,
          limit: ids.length,
          sort: null,
          rows: selected.map(({ row, build }) => ({
            id: row.id,
            stats: serializeRowStats(row),
            build: serializeBuild(build, cached.summary.characterId),
          })),
        },
        `按行 id 从缓存 ${cached.summary.cacheId} 选中 ${selected.length}/${cached.rows.length} 行(不受排序与筛选影响)`,
      )
    }

    let entries = cached.rows.map((row, index) => ({ row, build: cached.builds[index] ?? {} }))

    if (filters?.length) {
      entries = entries.filter(({ row }) =>
        filters.every((f) => {
          const value = (row as Any)[f.column]
          if (typeof value !== 'number') {
            throw new Error(`Unknown or non-numeric result column "${f.column}"`)
          }
          if (f.min != null && value < f.min) return false
          if (f.max != null && value > f.max) return false
          return true
        })
      )
    }

    if (sortBy != null) {
      const sample = (entries[0]?.row as Any)?.[sortBy]
      if (typeof sample !== 'number') {
        throw new Error(`Unknown or non-numeric sort column "${sortBy}"`)
      }
      entries.sort((a, b) =>
        sortDir === 'asc'
          ? (a.row as Any)[sortBy] - (b.row as Any)[sortBy]
          : (b.row as Any)[sortBy] - (a.row as Any)[sortBy]
      )
    }

    const page = entries.slice(offset, offset + limit)
    return toolResult(
      {
        cacheId: cached.summary.cacheId,
        characterId: cached.summary.characterId,
        summary: { ...cached.summary },
        total: entries.length,
        offset,
        limit,
        sort: sortBy != null ? { by: sortBy, dir: sortDir } : null,
        rows: page.map(({ row, build }) => ({
          id: row.id,
          stats: serializeRowStats(row),
          build: serializeBuild(build, cached.summary.characterId),
        })),
      },
      `返回 ${cached.summary.cacheId} 缓存中 ${entries.length} 行里的 ${page.length} 行${cached.summary.cancelled ? '(该次运行已被取消,结果为部分保留)' : ''}`,
    )
  })
}
