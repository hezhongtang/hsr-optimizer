// debug_utility tool (M7 agent C owns this file).
//
// Five actions, grouped by where they execute:
//
//   Browser actions (managed browser, per-task isolated context seeded from
//   readStructuredSnapshot — the browser never writes the MCP save):
//     - webgpu_tests: drives the real #webgpu page — clicks its own "Run all
//       WebGPU tests" button (WebgpuTab.tsx:27-51), waits for the button to
//       turn "Tests complete", opens every Accordion item and scrapes the
//       result tables from the DOM. Status icons are the tabler svg class
//       names (tabler-icon-circle-check-filled / circle-x-filled /
//       question-mark) — the same classes WebgpuTab.tsx:151-168 renders.
//     - image_center: drives the real #metadata "Image center editor"
//       (MetadataTab.tsx:70-75 accordion → ImageCenterEditor.tsx) — selects a
//       character / light cone through the page's SearchableCombobox, adjusts
//       the x/y/z (y/s) NumberInputs, clicks the section's own Reset button,
//       reads back the <code> config string the CopyButton copies, and
//       screenshots the preview container via a CDP clip. The page has NO
//       text/JSON paste entry (its Paste button only consumes the page-internal
//       clipboard its own Copy button sets, ImageCenterEditor.tsx:197-213) —
//       pasteConfig is therefore applied through the NumberInput path and
//       reported as such, never faked.
//
//   Node actions (direct upstream dev-utility calls, transactional):
//     - populate_characters: lib/dev/populateAllCharacters.ts (RANDOM relics —
//       flagged in the response), wrapped in withChange + markDirty.
//     - reset_showcase_colors / export_showcase_colors:
//       lib/dev/resetShowcaseColors.ts / exportShowcaseColors.ts.
//
// Page-script style note: McpBrowserPage.evaluate takes a function SOURCE
// string, so the driver below is one real TS function (imageCenterKit) passed
// as fn.toString() with a phase discriminator — it closes over nothing, takes
// everything through the args array, and only uses DOM APIs present in the
// served dist build. The webgpu scraper is a self-contained async function for
// the same reason.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SavedSessionKeys } from 'lib/constants/constantsSession'
import { exportShowcaseColors } from 'lib/dev/exportShowcaseColors'
import { populateAllCharacters } from 'lib/dev/populateAllCharacters'
import { resetShowcaseColors } from 'lib/dev/resetShowcaseColors'
import { useGlobalStore } from 'lib/stores/app/appStore'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import { z } from 'zod'

import { saveArtifact } from '../browser/artifactStore'
import { browserManager } from '../browser/browserManager'
import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { readStructuredSnapshot } from '../saveSnapshot'
import { toolResult } from '../toolResult'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

// ─── shared input shapes ─────────────────────────────────────────────────────

// static/spine/background editors use {x,y,z} (ImageCenter), lightCone uses
// {y,s} (imageOffset). One loose shape keeps the tool call simple; the page
// driver only reads the keys the current mode owns.
const imageCenterParamsSchema = z.object({
  x: z.number().describe('center.x(静态/Spine/背景偏移模式)'),
  y: z.number().describe('center.y 或 offset.y(全模式)'),
  z: z.number().min(0.5).max(3).describe('缩放 z(静态/Spine/背景偏移模式,页面夹取 0.5-3)'),
  s: z.number().min(0.5).max(2).describe('光锥缩放 s(lightCone 模式,页面夹取 0.5-2)'),
}).partial()

const webgpuDeltaRowSchema = z.object({
  stat: z.string(),
  cpu: z.string(),
  gpu: z.string(),
  delta: z.string(),
  precision: z.number(),
  pass: z.boolean(),
})

const webgpuProbeSchema = z.object({
  available: z.boolean().nullable(),
  softwareAdapter: z.boolean().nullable(),
  vendor: z.string().nullable(),
  architecture: z.string().nullable(),
  device: z.string().nullable(),
  maxBufferMB: z.number().nullable(),
  uniformBufferStandardLayout: z.boolean().nullable(),
}).nullable()

// ─── webgpu_tests ────────────────────────────────────────────────────────────

/**
 * Scrape the finished suite from the DOM. The page's Accordion keeps panel
 * content mounted but a never-opened item renders empty, so controls without
 * table rows are clicked first and the open animation is waited out. Row
 * layout mirrors WebgpuTab.tsx:110-147: [icon, Stat, CPU, GPU, Delta,
 * Precision]; the test-level status icon lives in the Accordion control
 * (TestIcon, WebgpuTab.tsx:151-168).
 */
const scrapeWebgpuSuite = (async () => {
  const items = Array.from(document.querySelectorAll('.mantine-Accordion-item'))
  for (const item of items) {
    if (item.querySelectorAll('tbody tr').length === 0) {
      const control = item.querySelector<HTMLElement>('.mantine-Accordion-control')
      control?.click()
    }
  }
  if (items.some((i) => i.querySelectorAll('tbody tr').length === 0)) {
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
  const svgClass = (el: Element | null | undefined) => el?.querySelector('svg')?.getAttribute('class') ?? ''
  return items.map((item) => {
    const control = item.querySelector('.mantine-Accordion-control')
    // The control's FIRST svg is Mantine's chevron — match the status icon by
    // its tabler class specifically (TestIcon's IconCircleCheckFilled /
    // IconCircleXFilled / IconQuestionMark, WebgpuTab.tsx:151-168).
    const controlClass = control
      ?.querySelector('svg[class*="circle-check-filled"], svg[class*="circle-x-filled"], svg[class*="question-mark"]')
      ?.getAttribute('class') ?? svgClass(control)
    const status = controlClass.includes('circle-check-filled')
      ? 'passed'
      : controlClass.includes('circle-x-filled')
      ? 'failed'
      : 'incomplete'
    const rows = Array.from(item.querySelectorAll('tbody tr')).map((tr) => {
      const tds = tr.querySelectorAll('td')
      return {
        stat: (tds[1]?.textContent ?? '').trim(),
        cpu: (tds[2]?.textContent ?? '').trim(),
        gpu: (tds[3]?.textContent ?? '').trim(),
        delta: (tds[4]?.textContent ?? '').trim(),
        precision: Number((tds[5]?.textContent ?? '').trim()) || 0,
        pass: !!tr.querySelector('svg[class*="circle-check-filled"]'),
      }
    })
    return { name: (control?.textContent ?? '').trim(), status, rows }
  })
}) as unknown as () => Promise<Array<{ name: string, status: string, rows: Array<Record<string, unknown>> }>>

/** Snapshot of the page's own run-state markers (button text + data-loading +
 * rendered item count) — polled while the suite executes. */
const webgpuButtonState = (() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '').includes('WebGPU tests') || (b.textContent ?? '').includes('Tests complete'))
  return {
    done: (btn?.textContent ?? '').includes('Tests complete'),
    running: btn?.getAttribute('data-loading') === 'true',
    items: document.querySelectorAll('.mantine-Accordion-item').length,
  }
}) as unknown as () => Record<string, unknown>

async function webgpuTestsAction(filter: string | undefined): Promise<CallToolResult> {
  // Capability gate first: a page without WebGPU gets a Chinese capability
  // report instead of a hang (adapter null → generateAllTests() returns [],
  // the button never completes — WebgpuTab.tsx:27-31 +
  // webgpuTestGenerator.ts:159-162). ensureLaunched probes the shared browser
  // once; the probe IS a page-level navigator.gpu check.
  const launch = await browserManager.ensureLaunched()
  if (launch.webgpu?.available !== true) {
    const reason = launch.webgpu == null
      ? '浏览器管理器未返回 WebGPU 探测结果'
      : launch.webgpu.available === false
      ? `WebGPU 不可用${launch.webgpu.error ? `(${launch.webgpu.error})` : '(requestAdapter 返回 null 或未暴露 navigator.gpu)'}`
      : 'WebGPU 探测结果异常'
    return toolResult(
      {
        action: 'webgpu_tests',
        supported: false,
        total: 0,
        passed: 0,
        failed: 0,
        incomplete: 0,
        tests: [],
        webgpu: launch.webgpu,
        reason,
        hint: '如需确认浏览器运行环境与 WebGPU 探测详情,先调用 get_runtime_capabilities(action=launch)',
      },
      `webgpu_tests:当前浏览器环境无 WebGPU 能力,未执行测试——${reason}。`
        + '可用 get_runtime_capabilities(action=launch) 查看受管浏览器的完整能力报告。',
    )
  }

  const scrape = await browserManager.runTask(
    { label: 'debug_utility(webgpu_tests)', timeoutMs: 900_000 },
    async (page) => {
      await page.goto('#webgpu', { timeoutMs: 60_000 })

      const clicked = await page.evaluate<boolean>(
        `async () => {
          const deadline = Date.now() + 15000
          while (Date.now() < deadline) {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Run all WebGPU tests'))
            if (btn) {
              btn.click()
              return true
            }
            await new Promise((r) => setTimeout(r, 200))
          }
          return false
        }`,
      )
      if (!clicked) {
        throw new Error('webgpu_tests:未在 #webgpu 页面找到「Run all WebGPU tests」按钮——站点构建可能已改版')
      }

      // Poll the page's own state: a generous window for the first item (the
      // first WGSL pipeline compile is slow), then until "Tests complete".
      const deadline = Date.now() + 840_000
      let sawItems = false
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        const state = await page.evaluate<Record<string, unknown>>(webgpuButtonState.toString())
        const items = Number(state['items'] ?? 0)
        if (items > 0) sawItems = true
        if (state['done'] === true) break
        if (!sawItems && items === 0 && state['running'] !== true) {
          throw new Error('webgpu_tests:适配器存在但测试套件未产生任何用例(getWebgpuDevice 请求设备失败)——按无 WebGPU 能力处理')
        }
        if (Date.now() >= deadline) {
          throw new Error('webgpu_tests:测试套件 14 分钟内未完成(全量用例含着色器编译)——可重试或换更快的 GPU 设备')
        }
      }

      return page.evaluate<Array<{ name: string, status: string, rows: Array<Record<string, unknown>> }>>(
        scrapeWebgpuSuite.toString(),
      )
    },
  )

  const tests = scrape
  const counts = { passed: 0, failed: 0, incomplete: 0 }
  for (const t of tests) {
    if (t.status === 'passed') counts.passed++
    else if (t.status === 'failed') counts.failed++
    else counts.incomplete++
  }
  const filtered = filter ? tests.filter((t) => t.name.includes(filter)) : tests
  const webgpu = browserManager.status().webgpu

  return toolResult(
    {
      action: 'webgpu_tests',
      supported: true,
      total: tests.length,
      passed: counts.passed,
      failed: counts.failed,
      incomplete: counts.incomplete,
      totalMatched: filtered.length,
      tests: filtered.map((t) => ({ name: t.name, status: t.status, deltas: t.rows })),
      webgpu,
      note: filter
        ? `filter="${filter}" 只裁剪返回清单;页面始终执行全量 ${tests.length} 条用例(#webgpu 页无按用例选择执行的入口)`
        : `页面执行全量 ${tests.length} 条用例(装饰器套装 + 遗器套装 + E6S5 全角色 + 4★/3★ 光锥,webgpuTestGenerator.ts:159-174)`,
    },
    `webgpu_tests 完成:全量 ${tests.length} 条用例,通过 ${counts.passed} / 失败 ${counts.failed} / 未完成 ${counts.incomplete}`
      + `${filter ? `,filter 命中 ${filtered.length} 条` : ''}`
      + `${webgpu?.softwareAdapter === true ? '(注意:当前为软件适配器,速度不代表真实 GPU)' : ''}`,
  )
}

// ─── image_center ────────────────────────────────────────────────────────────

type ImageCenterMode = 'static' | 'spine' | 'lightCone' | 'background'

type ImageCenterValues = { x?: number, y?: number, z?: number, s?: number }

interface ImageCenterArgs {
  characterId?: string
  lightConeId?: string
  mode: ImageCenterMode
  params?: ImageCenterValues
  reset?: boolean
  copyConfig?: boolean
  pasteConfig?: ImageCenterValues
}

interface ImageCenterRunResult {
  values: Record<string, string | number | null>
  configText: string
  resetDone: boolean
  pasteApplied: Record<string, number> | null
  notes: string[]
  clip: { x: number, y: number, width: number, height: number }
  media: { imgCount: number, imgsComplete: number, canvasCount: number }
  png: Uint8Array | null
}

/**
 * One page-side driver for every image_center phase. Section anchors
 * (ImageCenterEditor.tsx): static/spine — the <b>Static</b>/<b>Spine</b>
 * labels (:278); lightCone — <b>Light Cone</b> (:386); background — the
 * "Background Center Offset" Text (:837) inside the Full Card Preview editor.
 * Preview containers carry a distinctive computed cursor: 'grab' for the
 * character/full-card containers (:288, :773), 'ns-resize' for the light cone
 * (:439). Combobox options are picked by asset URL (Assets URLs embed the raw
 * id — assets.ts:62-66/88-91), which is locale-independent.
 */
const imageCenterKit = (async (arg: {
  phase: 'select' | 'reset' | 'apply' | 'read' | 'shot',
  mode: string,
  values?: Record<string, number>,
  id?: string,
  assetDir?: string,
  placeholder?: string,
  fullcard?: boolean,
}) => {
  const mode = arg.mode

  const findSection = (): HTMLElement | null => {
    const byClimb = (start: Element): HTMLElement | null => {
      let node: Element | null = start
      for (let i = 0; i < 6 && node; i++) {
        if (node.querySelectorAll('input').length >= 2) return node as HTMLElement
        node = node.parentElement
      }
      return null
    }
    if (mode === 'background') {
      const texts = Array.from(document.querySelectorAll('p, span, div'))
      const anchor = texts.find((el) => (el.textContent ?? '').startsWith('Background Center Offset') && el.children.length === 0)
      return anchor ? byClimb(anchor) : null
    }
    const label = mode === 'lightCone' ? 'Light Cone' : mode === 'static' ? 'Static' : 'Spine'
    const b = Array.from(document.querySelectorAll('b')).find((el) => (el.textContent ?? '').trim() === label)
    return b ? byClimb(b) : null
  }

  const inputByLabel = (section: Element, label: string) =>
    Array.from(section.querySelectorAll('input')).find((input) => {
      if (!input.id) return false
      const labelEl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
      return (labelEl?.textContent ?? '').trim() === label
    }) ?? null

  if (arg.phase === 'select') {
    // Open the SearchableCombobox and pick the option whose asset <img> src
    // matches the id (options are NOT virtualized — all render in the list).
    const fullcardB = Array.from(document.querySelectorAll('b')).find((el) => (el.textContent ?? '').trim() === 'Full Card Preview')
    let targets = Array.from(document.querySelectorAll('button'))
      .filter((b) => (b.textContent ?? '').trim() === arg.placeholder)
    if (arg.fullcard && fullcardB) {
      // Scope to the Full Card Preview editor: climb from its <b> until the
      // container holds a placeholder-matching button, then keep only targets
      // inside it.
      let root: Element | null = fullcardB
      while (root && !Array.from(root.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === arg.placeholder)) {
        root = root.parentElement
      }
      targets = root ? targets.filter((t) => root!.contains(t)) : []
    } else if (fullcardB) {
      targets = targets.filter((t) => !(fullcardB.contains(t) ?? false))
    }
    const target = targets[0] // section-level selector renders before the Full Card Preview one
    if (!target) return { ok: false, reason: `未找到 placeholder="${arg.placeholder}" 的下拉按钮` }
    target.click()
    await new Promise((resolve) => setTimeout(resolve, 350))
    const needle = `/icon/${arg.assetDir}/${arg.id}.webp`
    const options = Array.from(document.querySelectorAll('[role=option]'))
    const option = options.find((el) => {
      const img = el.querySelector('img')
      return img != null && (img.getAttribute('src') ?? '').includes(needle)
    })
    if (!option) return { ok: false, reason: `下拉列表中没有 asset 匹配 ${arg.id} 的选项(共 ${options.length} 项)` }
    option.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    ;(option as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { ok: true, picked: (option.textContent ?? '').trim() }
  }

  if (arg.phase === 'reset') {
    const section = findSection()
    if (!section) return { ok: false, reason: `未找到 ${mode} 编辑区块` }
    const btn = Array.from(section.querySelectorAll('button')).find((el) => (el.textContent ?? '').trim() === 'Reset')
    if (!btn) return { ok: false, reason: '区块内没有 Reset 按钮' }
    btn.click()
    return { ok: true }
  }

  if (arg.phase === 'apply') {
    const section = findSection()
    if (!section) return { ok: false, reason: `未找到 ${mode} 编辑区块` }
    const applied: Record<string, number> = {}
    for (const [label, value] of Object.entries(arg.values ?? {})) {
      const input = inputByLabel(section, label)
      if (!input) continue
      input.focus()
      input.select()
      const typed = document.execCommand('insertText', false, String(value))
      if (!typed) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, String(value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      input.blur() // Mantine NumberInput commits on blur
      applied[label] = value
    }
    return { ok: Object.keys(applied).length > 0, applied }
  }

  if (arg.phase === 'read') {
    const section = findSection()
    if (!section) return { ok: false, reason: `未找到 ${mode} 编辑区块` }
    const valueOf = (label: string) => {
      const input = inputByLabel(section, label)
      return input ? input.value : null
    }
    return {
      ok: true,
      values: { x: valueOf('x'), y: valueOf('y'), z: valueOf('z'), s: valueOf('s') },
      codeText: (section.querySelector('code')?.textContent ?? '').trim(),
      resetFound: Array.from(section.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'Reset'),
    }
  }

  // phase 'shot': scroll the preview container into view and report its clip
  // rect + media readiness.
  const findPreview = (): HTMLElement | null => {
    if (mode === 'background') {
      const b = Array.from(document.querySelectorAll('b')).find((el) => (el.textContent ?? '').trim() === 'Full Card Preview')
      let node: Element | null = b ?? null
      for (let i = 0; i < 8 && node; i++) {
        const hit = Array.from(node.querySelectorAll('div')).find((d) => getComputedStyle(d).cursor === 'grab')
        if (hit) return hit as HTMLElement
        node = node.parentElement
      }
      return null
    }
    const section = findSection()
    if (!section) return null
    const wanted = mode === 'lightCone' ? 'ns-resize' : 'grab'
    for (const div of Array.from(section.querySelectorAll('div'))) {
      const style = getComputedStyle(div)
      if (style.cursor === wanted && style.overflow === 'hidden') return div as HTMLElement
    }
    return null
  }
  const preview = findPreview()
  if (!preview) return { ok: false, reason: '未找到预览容器' }
  preview.scrollIntoView({ block: 'center' })
  const r = preview.getBoundingClientRect()
  const imgs = Array.from(preview.querySelectorAll('img'))
  return {
    ok: true,
    rect: { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) },
    imgCount: imgs.length,
    imgsComplete: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    canvasCount: preview.querySelectorAll('canvas').length,
  }
}) as unknown as (arg: {
  phase: 'select' | 'reset' | 'apply' | 'read' | 'shot',
  mode: string,
  values?: Record<string, number>,
  id?: string,
  assetDir?: string,
  placeholder?: string,
  fullcard?: boolean,
}) => Promise<Record<string, unknown>>

/** Filter a params object down to the keys the mode owns. */
function paramsForMode(mode: ImageCenterMode, p: ImageCenterValues | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  if (!p) return out
  if (mode === 'lightCone') {
    if (p.y != null) out['y'] = p.y
    if (p.s != null) out['s'] = p.s
  } else {
    if (p.x != null) out['x'] = p.x
    if (p.y != null) out['y'] = p.y
    if (p.z != null) out['z'] = p.z
  }
  return out
}

async function imageCenterAction(args: ImageCenterArgs): Promise<CallToolResult> {
  runtimeContext.requireSave()
  const { characterId, lightConeId, mode } = args

  if (mode === 'lightCone' && !lightConeId) {
    throw new Error('debug_utility(image_center):mode=lightCone 需要 lightConeId——光锥编辑区没有默认选中项,不传则没有可操作对象')
  }

  const seed = JSON.stringify(readStructuredSnapshot())
  const kit = imageCenterKit.toString()

  const out: ImageCenterRunResult = await browserManager.runTask(
    { label: `debug_utility(image_center:${mode})`, seed, timeoutMs: 240_000 },
    async (page) => {
      await page.goto('#metadata', { timeoutMs: 60_000 })

      // Open the "Image center editor" accordion (MetadataTab.tsx:70-75 — the
      // panel content only mounts once the item is opened). Tabs stagger-mount
      // (Tabs.tsx:105-108), so the control itself is polled for; the editor is
      // then confirmed through the DOM (a placeholder button), NOT innerText —
      // placeholder spans may be excluded from innerText rendering.
      const openState = await page.evaluate<string>(
        `async () => {
          const findControl = () => Array.from(document.querySelectorAll('button'))
            .find((b) => (b.textContent ?? '').includes('Image center editor'))
          const deadline = Date.now() + 15000
          while (Date.now() < deadline) {
            const control = findControl()
            if (control) {
              control.click()
              const inner = Date.now() + 8000
              while (Date.now() < inner) {
                const mounted = Array.from(document.querySelectorAll('button'))
                  .some((b) => (b.textContent ?? '').trim() === 'Select character')
                if (mounted) return 'opened'
                await new Promise((r) => setTimeout(r, 200))
              }
              return 'clicked-but-editor-missing'
            }
            await new Promise((r) => setTimeout(r, 200))
          }
          return 'no-control'
        }`,
      )
      if (openState === 'no-control') {
        throw new Error('image_center:#metadata 页 15s 内未出现「Image center editor」折叠项——站点构建可能已改版')
      }
      if (openState === 'clicked-but-editor-missing') {
        throw new Error('image_center:已点击折叠项但编辑器 8s 内未挂载(未出现角色下拉)——页面结构可能已改版')
      }

      const notes: string[] = []

      // Character / light cone selection through the page's own comboboxes.
      if (mode === 'lightCone') {
        const picked = await page.evaluate<Record<string, unknown>>(kit, [{
          phase: 'select',
          mode,
          id: lightConeId,
          assetDir: 'light_cone',
          placeholder: 'Select light cone',
        }])
        if (picked['ok'] !== true) throw new Error(`image_center:光锥选择失败——${String(picked['reason'])}`)
      } else if (characterId) {
        const picked = await page.evaluate<Record<string, unknown>>(kit, [{
          phase: 'select',
          mode,
          id: characterId,
          assetDir: 'avatar',
          placeholder: 'Select character',
          fullcard: mode === 'background',
        }])
        if (picked['ok'] !== true) throw new Error(`image_center:角色选择失败——${String(picked['reason'])}`)
      }

      // Wait for the metadata defaults to land in the inputs (useEffect on
      // selection — ImageCenterEditor.tsx:586-597 / 892-899).
      await new Promise((resolve) => setTimeout(resolve, 1_200))

      // Reset first so explicit params win, the order a user would use.
      let resetDone = false
      if (args.reset) {
        const r = await page.evaluate<Record<string, unknown>>(kit, [{ phase: 'reset', mode }])
        if (r['ok'] !== true) notes.push(`Reset 按钮点击失败:${String(r['reason'])}`)
        else resetDone = true
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      const applyValues = paramsForMode(mode, args.params)
      if (Object.keys(applyValues).length > 0) {
        const a = await page.evaluate<Record<string, unknown>>(kit, [{ phase: 'apply', mode, values: applyValues }])
        if (a['ok'] !== true) notes.push(`参数经输入框应用失败:${String(a['reason'])}`)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      // pasteConfig: the page exposes NO text paste entry (its Paste button
      // only consumes the page-internal clipboard, ImageCenterEditor.tsx:197-213)
      // — apply through the NumberInput path and report the situation.
      let pasteApplied: Record<string, number> | null = null
      const pasteValues = paramsForMode(mode, args.pasteConfig)
      if (Object.keys(pasteValues).length > 0) {
        const a = await page.evaluate<Record<string, unknown>>(kit, [{ phase: 'apply', mode, values: pasteValues }])
        if (a['ok'] === true) pasteApplied = (a['applied'] ?? {}) as Record<string, number>
        else notes.push(`pasteConfig 应用失败:${String(a['reason'])}`)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      // CopyButton readback: the <code> string is exactly what Copy copies.
      const read = await page.evaluate<Record<string, unknown>>(kit, [{ phase: 'read', mode }])
      if (read['ok'] !== true) throw new Error(`image_center:未定位到 ${mode} 编辑区块(${String(read['reason'])})`)

      // Give the preview media a moment, then scroll + clip.
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      const shot = await page.evaluate<Record<string, unknown>>(kit, [{ phase: 'shot', mode }])
      const clip = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }
      let png: Uint8Array | null = null
      const media = { imgCount: 0, imgsComplete: 0, canvasCount: 0 }
      if (shot['ok'] === true) {
        const rect = (shot['rect'] ?? {}) as Record<string, number>
        clip.x = Number(rect['x'] ?? 0)
        clip.y = Number(rect['y'] ?? 0)
        clip.width = Number(rect['width'] ?? 0)
        clip.height = Number(rect['height'] ?? 0)
        media.imgCount = Number(shot['imgCount'] ?? 0)
        media.imgsComplete = Number(shot['imgsComplete'] ?? 0)
        media.canvasCount = Number(shot['canvasCount'] ?? 0)
        if (clip.width > 1 && clip.height > 1) png = await page.screenshot({ clip })
      } else {
        notes.push(String(shot['reason']))
      }

      // Final readback AFTER every mutation, so `applied` reflects the page.
      const final = await page.evaluate<Record<string, unknown>>(kit, [{ phase: 'read', mode }])

      return {
        values: (final['values'] ?? {}) as Record<string, string | number | null>,
        configText: String(read['codeText'] ?? ''),
        resetDone,
        pasteApplied,
        notes,
        clip,
        media,
        png,
      }
    },
  )

  const label = `image_center:${mode}${characterId ? `:${characterId}` : ''}${lightConeId ? `:${lightConeId}` : ''}`
  const artifact = out.png && out.png.byteLength > 0 ? saveArtifact(out.png, label) : null

  const payload: Record<string, unknown> = {
    action: 'image_center',
    mode,
    ...(characterId ? { characterId } : {}),
    ...(lightConeId ? { lightConeId } : {}),
    applied: out.values,
    config: {
      text: out.configText,
      note: 'text 即页面 CopyButton 复制的配置串原文(<code> 元素);结构化数值见 applied',
    },
    resetClicked: out.resetDone,
    pasteEntry: false,
    ...(out.pasteApplied
      ? {
        pasteApplied: out.pasteApplied,
        pasteNote: '网页无 JSON 粘贴入口:页面的 Paste 按钮只消费其内部剪贴板(由 Copy 按钮写入),pasteConfig 已按数字输入框路径应用',
      }
      : {}),
    ...(artifact
      ? { previewArtifactId: artifact.artifactId, previewBytes: artifact.bytes, previewClip: out.clip }
      : { previewNote: '预览截图失败:' + (out.notes[0] ?? '未知原因') }),
    ...(out.notes.length > 0 ? { notes: out.notes } : {}),
  }
  const summary = `image_center(${mode}) 完成:配置串 "${out.configText}"`
    + `${artifact ? `,预览 ${out.clip.width}x${out.clip.height}px → ${artifact.artifactId}` : ',无预览截图'}`
    + `${out.pasteApplied ? ';pasteConfig 经输入框应用(网页无 JSON 粘贴入口)' : ''}`

  const result = toolResult(payload, summary)
  // Inline the preview PNG as image content so classic clients see it without
  // a second deliver_artifact call (the render tool's convention).
  if (artifact && out.png) {
    return {
      ...result,
      content: [
        ...result.content,
        { type: 'image' as const, data: Buffer.from(out.png).toString('base64'), mimeType: 'image/png' },
      ],
    }
  }
  return result
}

// ─── Node-side dev utilities ─────────────────────────────────────────────────

async function populateCharactersAction(): Promise<CallToolResult> {
  runtimeContext.ensureMetadataReady()
  runtimeContext.requireSave()
  ensureI18nReady()

  const charsBefore = getCharacters().map((c: Any) => c.id)
  const relicsBefore = getRelics().length

  await runtimeContext.withChange('debug_utility:populate_characters', () => {
    populateAllCharacters()
    runtimeContext.markDirty()
  })

  const charsAfter = getCharacters().map((c: Any) => c.id)
  const relicsAfter = getRelics().length
  const added = charsAfter.filter((id: string) => !charsBefore.includes(id))
  const removed = charsBefore.filter((id: string) => !charsAfter.includes(id))

  return toolResult(
    {
      action: 'populate_characters',
      charactersBefore: charsBefore.length,
      charactersAfter: charsAfter.length,
      addedCharacterIds: added,
      removedCharacterIds: removed,
      relicsAdded: relicsAfter - relicsBefore,
      random: true,
      randomNote: '遗器副词条随机生成(Math.random)——每次调用产物不同,勿当确定输入;重复调用对已有角色只补缺失部位',
      revision: runtimeContext.getRevision(),
      dirty: true,
    },
    `populate_characters 完成:库存角色 ${charsBefore.length} → ${charsAfter.length}(新增 ${added.length}),`
      + `新增遗器 ${relicsAfter - relicsBefore} 件(随机产物)。`,
  )
}

async function resetShowcaseColorsAction(): Promise<CallToolResult> {
  runtimeContext.requireSave()

  const colorKeys = (store: Any) => Object.keys(store.portraitColorByCharacterId ?? {})
  const before = {
    showcasePreferences: Object.keys(useShowcaseTabStore.getState().showcasePreferences ?? {}).length,
    portraitColors: colorKeys(useShowcaseTabStore.getState()).length,
    standardMode: useGlobalStore.getState().savedSession[SavedSessionKeys.showcaseStandardMode],
  }

  await runtimeContext.withChange('debug_utility:reset_showcase_colors', () => {
    resetShowcaseColors()
    runtimeContext.markDirty()
  })

  const after = {
    showcasePreferences: Object.keys(useShowcaseTabStore.getState().showcasePreferences ?? {}).length,
    portraitColors: colorKeys(useShowcaseTabStore.getState()).length,
    standardMode: useGlobalStore.getState().savedSession[SavedSessionKeys.showcaseStandardMode],
  }

  return toolResult(
    {
      action: 'reset_showcase_colors',
      before,
      after,
      cleared: after.showcasePreferences === 0 && after.standardMode === false,
      semantics: '清空 showcasePreferences + 清肖像提取色/色板 + 关闭全局 STANDARD 模式(resetShowcaseColors 本体语义),全部角色回落 AUTO',
      revision: runtimeContext.getRevision(),
      dirty: true,
    },
    `reset_showcase_colors 完成:展示配色偏好 ${before.showcasePreferences} → ${after.showcasePreferences} 条,`
      + `肖像色 ${before.portraitColors} → ${after.portraitColors} 条,STANDARD 模式 ${String(before.standardMode)} → ${String(after.standardMode)}。`,
  )
}

async function exportShowcaseColorsAction(): Promise<CallToolResult> {
  runtimeContext.requireSave()

  const colors = exportShowcaseColors()

  return toolResult(
    {
      action: 'export_showcase_colors',
      count: Object.keys(colors).length,
      colors,
      semantics: 'CUSTOM 手选色优先,缺省角色补自动提取的肖像色(exportShowcaseColors 本体语义),按 characterId 排序',
    },
    `export_showcase_colors 完成:导出 ${Object.keys(colors).length} 个角色的展示色映射(只读,未改动存档)。`,
  )
}

// ─── registration ────────────────────────────────────────────────────────────

export function registerDebugTools(server: McpServer): void {
  server.registerTool('debug_utility', {
    title: '开发者诊断工具集',
    description: '浏览器侧诊断与 Node 侧开发工具的统一入口,action 决定行为:'
      + 'webgpu_tests 在受管浏览器里驱动真实 #webgpu 测试页(点它自己的 Run all 按钮、等 Tests complete、逐条抓取 CPU/GPU 对拍表)'
      + '——页面始终执行全量用例(约 200 条,含着色器编译,可能需要数分钟),filter 只裁剪返回清单;'
      + 'image_center 驱动 #metadata 的图片中心编辑器(选角色/光锥、调 center/zoom、Reset、读回 CopyButton 的配置串)并截取预览区 PNG;'
      + 'populate_characters 直调上游 dev 工具把全角色+光锥+随机遗器灌入当前存档(随机产物,事务化);'
      + 'reset_showcase_colors 清空展示配色定制(事务化);export_showcase_colors 只读导出角色→颜色映射。'
      + '浏览器类 action 需要受管浏览器运行环境(本机 Chrome 与站点构建产物),不可用时返回中文能力错误——'
      + '先用 get_runtime_capabilities(action=launch) 确认。',
    inputSchema: {
      action: z.enum(['webgpu_tests', 'image_center', 'populate_characters', 'reset_showcase_colors', 'export_showcase_colors'])
        .describe(
          '动作:webgpu_tests=WebGPU 回归测试页;image_center=图片中心编辑器;populate_characters=灌入全角色(随机);reset_showcase_colors=清展示配色;export_showcase_colors=导出展示色映射',
        ),
      filter: z.string().optional().describe('webgpu_tests:用例名子串,只裁剪返回的 tests 清单(页面仍执行全量,如 "Ornament" 只看装饰器套装组)'),
      characterId: z.string().optional().describe('image_center:角色 id(static/spine 模式选页首角色下拉,background 模式选 Full Card Preview 的下拉)'),
      lightConeId: z.string().optional().describe('image_center:光锥 id(mode=lightCone 时必传)'),
      mode: z.enum(['static', 'spine', 'lightCone', 'background']).optional().describe(
        'image_center 编辑区块,默认 static:static=静态立绘 center(x/y/z);spine=Spine 动画 center(x/y/z);lightCone=光锥偏移(y/s);background=整卡预览的背景偏移(x/y/z)',
      ),
      params: imageCenterParamsSchema.optional().describe('image_center:经页面数字输入框应用的参数(static/spine/background 用 x/y/z,lightCone 用 y/s)'),
      reset: z.boolean().optional().describe('image_center:先点击该区块的 Reset 按钮(还原元数据默认值)再应用 params'),
      copyConfig: z.boolean().optional().describe('image_center:读回页面 CopyButton 会复制的配置串(config 字段当前无条件附带,此参数为显式意图标记)'),
      pasteConfig: imageCenterParamsSchema.optional().describe(
        'image_center:粘贴配置——网页无 JSON 粘贴入口(Paste 按钮只吃页面内部剪贴板),传此参数时按数字输入框路径应用并在返回中如实说明',
      ),
    },
    outputSchema: {
      action: z.string(),
      // webgpu_tests
      supported: z.boolean().optional().describe('webgpu_tests:页面 WebGPU 能力是否可用(false 时返回能力报告不执行)'),
      total: z.number().int().optional(),
      passed: z.number().int().optional(),
      failed: z.number().int().optional(),
      incomplete: z.number().int().optional(),
      totalMatched: z.number().int().optional(),
      tests: z.array(z.object({
        name: z.string(),
        status: z.enum(['passed', 'failed', 'incomplete']),
        deltas: z.array(webgpuDeltaRowSchema),
      })).optional(),
      webgpu: webgpuProbeSchema.optional(),
      reason: z.string().optional(),
      hint: z.string().optional(),
      note: z.string().optional(),
      // image_center
      mode: z.string().optional(),
      characterId: z.string().optional(),
      lightConeId: z.string().optional(),
      applied: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
      config: z.object({ text: z.string(), note: z.string() }).optional(),
      resetClicked: z.boolean().optional(),
      pasteEntry: z.boolean().optional(),
      pasteApplied: z.record(z.string(), z.number()).optional(),
      pasteNote: z.string().optional(),
      previewArtifactId: z.string().optional(),
      previewBytes: z.number().int().optional(),
      previewClip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      previewNote: z.string().optional(),
      notes: z.array(z.string()).optional(),
      // populate_characters
      charactersBefore: z.number().int().optional(),
      charactersAfter: z.number().int().optional(),
      addedCharacterIds: z.array(z.string()).optional(),
      removedCharacterIds: z.array(z.string()).optional(),
      relicsAdded: z.number().int().optional(),
      random: z.boolean().optional(),
      randomNote: z.string().optional(),
      // reset / export showcase colors
      before: z.record(z.string(), z.unknown()).optional(),
      after: z.record(z.string(), z.unknown()).optional(),
      cleared: z.boolean().optional(),
      semantics: z.string().optional(),
      count: z.number().int().optional(),
      colors: z.record(z.string(), z.string()).optional(),
      // shared
      revision: z.number().int().optional(),
      dirty: z.boolean().optional(),
    },
  }, async (args) => {
    switch (args.action) {
      case 'webgpu_tests':
        return webgpuTestsAction(args.filter)
      case 'image_center':
        return imageCenterAction({
          characterId: args.characterId,
          lightConeId: args.lightConeId,
          mode: args.mode ?? 'static',
          params: args.params,
          reset: args.reset,
          copyConfig: args.copyConfig,
          pasteConfig: args.pasteConfig,
        })
      case 'populate_characters':
        return populateCharactersAction()
      case 'reset_showcase_colors':
        return resetShowcaseColorsAction()
      case 'export_showcase_colors':
        return exportShowcaseColorsAction()
    }
  })
}
