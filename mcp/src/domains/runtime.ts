// get_runtime_capabilities tool (M7 agent A owns this file).
// Browser lifecycle + environment capability reporting.
//
// Three actions over one shared managed browser (browser/browserManager.ts):
//   - status (default): ZERO side effects — reports whether the Chrome
//     executable and the site build dist exist (no launch), whether the
//     browser is currently running, and the engine situation (saved-session
//     compute engine, the engine this Node process actually runs, browser
//     WebGPU availability when the browser happens to be up).
//   - launch: idempotent ensureLaunched + the full probe surface (Chrome
//     version, site server url/port, WebGPU adapter probe, context count).
//     Throws a Chinese, actionable error when the executable or dist is
//     missing (names the env override that fixes it).
//   - close: kills the browser + site server; render artifacts on disk are
//     NOT touched (they are re-readable via deliver_artifact).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { COMPUTE_ENGINE_CPU } from 'lib/constants/constants'
import { useGlobalStore } from 'lib/stores/app/appStore'
import { z } from 'zod'

import { artifactStats } from '../browser/artifactStore'
import {
  browserManager,
} from '../browser/browserManager'
import { runtimeContext } from '../context'
import { toolResult } from '../toolResult'

const executableOutSchema = z.object({
  found: z.boolean().describe('是否找到可用的浏览器可执行文件'),
  path: z.string().nullable().describe('可执行文件绝对路径(未找到为 null)'),
  source: z.enum(['env', 'platform']).nullable().describe('发现来源:env=HSR_MCP_BROWSER_PATH 指定 / platform=系统常见位置'),
  version: z.string().nullable().describe('`--version` 探测结果(如 "Google Chrome 154.0.8037.98")'),
  reason: z.string().optional().describe('未找到时的原因说明'),
})

const siteDistOutSchema = z.object({
  found: z.boolean().describe('是否找到可伺服的站点构建产物目录'),
  path: z.string().nullable().describe('站点 dist 目录绝对路径(未找到为 null)'),
  source: z.enum(['env', 'repo']).nullable().describe('发现来源:env=HSR_MCP_SITE_DIST 指定 / repo=仓库根 dist/'),
  indexHtml: z.boolean().describe('目录内是否存在 index.html'),
  assetsDir: z.boolean().describe('目录内是否存在 assets/ 子目录'),
  localesDir: z.boolean().describe('目录内是否存在 locales/ 子目录(翻译文件)'),
  reason: z.string().optional().describe('缺失时的原因说明'),
})

const webgpuOutSchema = z.object({
  available: z.boolean().describe('WebGPU 是否可用(navigator.gpu.requestAdapter() 成功)'),
  softwareAdapter: z.boolean().nullable().describe('是否 SwiftShader 等软件适配器(适配器信息为空时为 null)'),
  vendor: z.string().nullable().describe('适配器 vendor(adapter.info.vendor)'),
  architecture: z.string().nullable().describe('适配器架构(adapter.info.architecture)'),
  device: z.string().nullable().describe('适配器设备名(adapter.info.device)'),
  maxBufferMB: z.number().nullable().describe('limits.maxBufferSize 换算的 MB 值'),
  uniformBufferStandardLayout: z.boolean().describe('wgslLanguageFeatures 是否含 uniform_buffer_standard_layout(GPU 引擎的必要特性)'),
  error: z.string().optional().describe('探测失败时的错误说明'),
})

const outputPayloadSchema = z.object({
  action: z.enum(['status', 'launch', 'close']).describe('本次执行的动作'),
  running: z.boolean().describe('受管浏览器当前是否在运行'),
  browserReady: z.boolean().describe('启动前提是否齐备(可执行文件 + index.html + assets/ 均在)'),
  executable: executableOutSchema.describe('浏览器可执行文件探测结果'),
  siteDist: siteDistOutSchema.describe('站点构建产物目录探测结果'),
  node: z.string().describe('Node 运行时版本'),
  artifactsDir: z.string().describe('渲染产物落盘目录(art-*.png + 元数据;close 不清理它)'),
  artifactsCount: z.number().int().describe('产物目录中现有产物条数'),
  chromeVersion: z.string().nullable().describe('运行中的 Chrome 版本(未运行为 null)'),
  serverUrl: z.string().nullable().describe('站点静态伺服地址(未运行为 null)'),
  serverPort: z.number().int().nullable().describe('站点静态伺服端口(未运行为 null)'),
  webgpu: webgpuOutSchema.nullable().describe('WebGPU 探测结果(浏览器未运行时为 null)'),
  contextCount: z.number().int().describe('当前打开的任务浏览器上下文数'),
  engine: z.object({
    savedSessionComputeEngine: z.string().nullable().describe(
      '当前存档 savedSession 里保存的计算引擎偏好(CPU / GPU Stable / GPU Experimental;未载入存档为 null)',
    ),
    nodeComputeEngine: z.string().describe('本 MCP 进程(Node)实际使用的引擎,恒为 CPU'),
    browserWebgpu: z.boolean().nullable().describe('浏览器侧 WebGPU 是否可用(浏览器未运行时为 null)'),
  }).describe('计算引擎三口径:存档偏好 / Node 实际 / 浏览器能力'),
})

export function registerRuntimeTools(server: McpServer): void {
  server.registerTool('get_runtime_capabilities', {
    title: '运行环境能力与浏览器生命周期',
    description: '受管浏览器(网页端站点的本地无头实例)的能力查询与生命周期管理。'
      + 'action=status(默认,零副作用):报告 Chrome 可执行文件与站点构建产物是否就绪、浏览器是否在跑、'
      + '引擎三口径(存档 computeEngine 偏好 / Node 实际引擎 / 浏览器 WebGPU 可用性,未启动时为 null)——'
      + '在 launch 前调用可预判 render 等浏览器工具是否可用。'
      + 'action=launch:幂等启动受管浏览器(本机 Chrome + 伺服 dist/ 构建产物)并完整探测'
      + '(Chrome 版本、伺服地址、WebGPU 适配器 vendor/架构/设备/maxBufferSize/uniform 布局特性、SwiftShader 软件适配器判定);'
      + '可执行文件或构建产物缺失时报中文错误并给出修复方式(安装 Chrome 或设 HSR_MCP_BROWSER_PATH;仓库根 npm run build 或设 HSR_MCP_SITE_DIST)。'
      + 'action=close:关闭浏览器进程与站点伺服(幂等),已生成的渲染产物文件保留在 artifactsDir,可继续用 deliver_artifact 读取。',
    inputSchema: {
      action: z.enum(['status', 'launch', 'close']).default('status')
        .describe('动作:status=零副作用查询(默认) / launch=幂等启动+完整探测 / close=关闭浏览器与伺服(产物保留)'),
    },
    outputSchema: outputPayloadSchema,
  }, async ({ action }): Promise<CallToolResult> => {
    const capabilities = await browserManager.reportCapabilities()
    const stats = artifactStats()

    if (action === 'launch') {
      const launched = await browserManager.ensureLaunched()
      return toolResult(
        {
          action: 'launch',
          running: launched.running,
          browserReady: capabilities.executable.found && capabilities.siteDist.indexHtml && capabilities.siteDist.assetsDir,
          executable: capabilities.executable,
          siteDist: capabilities.siteDist,
          node: capabilities.node,
          artifactsDir: capabilities.artifactsDir,
          artifactsCount: stats.count,
          chromeVersion: launched.chromeVersion,
          serverUrl: launched.serverUrl,
          serverPort: launched.serverPort,
          webgpu: launched.webgpu,
          contextCount: launched.contextCount,
          engine: engineSection(launched.webgpu),
        },
        launchSummary(launched.running, launched.chromeVersion, launched.webgpu),
      )
    }

    if (action === 'close') {
      await browserManager.close()
      const after = browserManager.status()
      return toolResult(
        {
          action: 'close',
          running: after.running,
          browserReady: capabilities.executable.found && capabilities.siteDist.indexHtml && capabilities.siteDist.assetsDir,
          executable: capabilities.executable,
          siteDist: capabilities.siteDist,
          node: capabilities.node,
          artifactsDir: capabilities.artifactsDir,
          artifactsCount: stats.count,
          chromeVersion: after.chromeVersion,
          serverUrl: after.serverUrl,
          serverPort: after.serverPort,
          webgpu: after.webgpu,
          contextCount: after.contextCount,
          engine: engineSection(after.webgpu),
        },
        `浏览器已关闭(站点伺服一并停止);${stats.count} 个渲染产物保留在 ${capabilities.artifactsDir}`,
      )
    }

    const status = browserManager.status()
    return toolResult(
      {
        action: 'status',
        running: status.running,
        browserReady: capabilities.executable.found && capabilities.siteDist.indexHtml && capabilities.siteDist.assetsDir,
        executable: capabilities.executable,
        siteDist: capabilities.siteDist,
        node: capabilities.node,
        artifactsDir: capabilities.artifactsDir,
        artifactsCount: stats.count,
        chromeVersion: status.chromeVersion,
        serverUrl: status.serverUrl,
        serverPort: status.serverPort,
        webgpu: status.webgpu,
        contextCount: status.contextCount,
        engine: engineSection(status.webgpu),
      },
      statusSummary(capabilities.executable.found, capabilities.siteDist.found, status.running),
    )
  })
}

/**
 * Engine triple: what the loaded save PREFERS (savedSession.computeEngine,
 * upstream key), what this Node process ACTUALLY runs (always the CPU engine
 * — the optimizer engine in-process is CPU-only), and whether the browser
 * side COULD run WebGPU (null when the managed browser is not running —
 * status is zero-side-effect, it never launches just to probe).
 */
function engineSection(browserWebgpu: { available: boolean } | null): {
  savedSessionComputeEngine: string | null,
  nodeComputeEngine: string,
  browserWebgpu: boolean | null,
} {
  const saveLoaded = runtimeContext.getSave() != null
  const savedEngine = saveLoaded ? useGlobalStore.getState().savedSession.computeEngine : null
  return {
    savedSessionComputeEngine: savedEngine ?? null,
    nodeComputeEngine: COMPUTE_ENGINE_CPU,
    browserWebgpu: browserWebgpu != null ? browserWebgpu.available : null,
  }
}

function statusSummary(browserFound: boolean, distFound: boolean, running: boolean): string {
  const bits: string[] = []
  bits.push(browserFound ? 'Chrome 已就绪' : 'Chrome 缺失(装 Chrome 或设 HSR_MCP_BROWSER_PATH)')
  bits.push(distFound ? '站点构建产物已就绪' : '构建产物缺失(仓库根 npm run build 或设 HSR_MCP_SITE_DIST)')
  bits.push(running ? '浏览器运行中' : '浏览器未启动')
  return bits.join(' / ')
}

function launchSummary(running: boolean, chromeVersion: string | null, webgpu: { available: boolean, softwareAdapter: boolean | null } | null): string {
  if (!running) return '浏览器启动失败,请查看错误信息'
  const webgpuText = webgpu == null
    ? 'WebGPU 未探测'
    : webgpu.available
    ? `WebGPU 可用${webgpu.softwareAdapter === true ? '(软件适配器)' : ''}`
    : 'WebGPU 不可用(GPU 优化走不了浏览器路径)'
  return `浏览器已启动:${chromeVersion ?? '未知版本'},${webgpuText}`
}
