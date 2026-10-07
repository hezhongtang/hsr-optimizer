// deliver_artifact tool (M7 agent D owns this file).
// Artifact list/read/copy/share/delete + platform branch reporting.
//
// Artifacts come from the M7 render/export pipeline (render.ts writes them
// via browser/artifactStore.saveArtifact); they are runtime user data under
// HSR_MCP_ARTIFACTS_DIR, never repo content. list/read/delete are pure
// artifactStore operations. copy/share are the web's own delivery branches —
// the same two buttons the site's screenshot panel offers (Copy →
// navigator.clipboard.write(ClipboardItem), share panel → Web Share API) —
// replayed inside the managed headless browser, with the platform conditions
// reported HONESTLY instead of pretending a headless server has a desktop:
//   - copy writes the managed headless Chromium's clipboard. On a desktop
//     Chrome that usually IS the system clipboard; on a server there may be
//     no receiver at all. ok:false + reason comes back when the page context
//     lacks clipboard permission.
//   - share probes navigator.canShare({files}) and then attempts
//     navigator.share — the mobile-web branch. A headless context is expected
//     to report unavailable/NotAllowedError; a real success only happens on a
//     platform with a share sheet.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  deleteArtifact,
  listArtifacts,
  readArtifact,
} from '../browser/artifactStore'
import { browserManager } from '../browser/browserManager'
import { toolResult } from '../toolResult'
import { sniffImageDimensions } from './portrait'

const COPY_SHARE_TIMEOUT_MS = 60_000

/** All existing artifact ids — for the "not found, here is what exists" error. */
function knownArtifactIds(): string[] {
  return listArtifacts().map((meta) => meta.artifactId)
}

function requireArtifact(artifactId: string | undefined): string {
  if (artifactId == null || artifactId === '') {
    throw new Error(`deliver_artifact:该 action 需要 artifactId — 现有产物:${knownArtifactIds().join(', ') || '(无,先用 render 生成)'}`)
  }
  if (readArtifact(artifactId) == null) {
    throw new Error(`deliver_artifact:产物 ${artifactId} 不存在(可能已被删除)— 现有产物:${knownArtifactIds().join(', ') || '(无,先用 render 生成)'}`)
  }
  return artifactId
}

const artifactMetaSchema = z.object({
  artifactId: z.string(),
  file: z.string(),
  bytes: z.number().int(),
  createdAtIso: z.string(),
  label: z.string(),
  format: z.literal('png'),
})

// Page-side scripts for the managed browser. Convention: the string is a
// function expression; browserManager calls it with the args array spread
// (JSON-serializable in/out).
const CLIPBOARD_WRITE_SCRIPT = `async (base64) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: 'image/png' })
  const item = new ClipboardItem({ 'image/png': blob })
  await navigator.clipboard.write([item])
  return { ok: true }
}`

const WEB_SHARE_SCRIPT = `async (base64) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'artifact.png', { type: 'image/png' })
  if (typeof navigator.canShare !== 'function') {
    return { available: false, reason: '该浏览器没有 navigator.canShare(Web Share API 不可用——常见于桌面/无头环境,分享是网页移动端分支)' }
  }
  if (!navigator.canShare({ files: [file] })) {
    return { available: false, reason: 'navigator.canShare({files}) 为 false(当前平台不支持直接分享文件——无头环境预期如此)' }
  }
  // Headless contexts with no share sheet may never settle the share promise
  // (no user gesture to reject it) — race so the branch reports instead of
  // hanging the task.
  const share = navigator.share({ files: [file] }).then(() => ({ shared: true })).catch((e) => ({
    shared: false,
    reason: 'navigator.share 被拒绝:' + ((e && e.message) || String(e)) + '(无头环境通常因缺少用户手势抛 NotAllowedError——这是平台条件,不是产物问题)',
  }))
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ shared: false, reason: 'navigator.share 超过 10 秒未返回(无分享面板的平台的典型表现——无头环境预期如此)' }), 10000))
  const outcome = await Promise.race([share, timeout])
  return { available: true, ...outcome }
}`

const COPY_NOTE = '写入的是受管无头浏览器的剪贴板(桌面 Chrome 通常即系统剪贴板),服务器环境可能无接收方'
const SHARE_NOTE = 'Web Share 是网页移动端分支的平台条件语义:canShare/share 在无头桌面环境预期不可用,只有带分享面板的平台才会真正成功'

export function registerArtifactTools(server: McpServer): void {
  server.registerTool('deliver_artifact', {
    title: '交付渲染产物',
    description: '管理并交付 render 生成的 PNG 产物(list/read/copy/share/delete 五个动作)。'
      + '产物是运行期用户数据,存放在受管产物目录(HSR_MCP_ARTIFACTS_DIR,默认系统临时目录 hsr-mcp-artifacts),'
      + 'list 按创建时间列出现有产物;read 返回字节大小、像素尺寸(PNG 头嗅探)与 base64 内容(同时以 MCP image 内容块返回);'
      + 'delete 删除产物文件与元数据。'
      + 'copy 在受管无头浏览器里回放网页端「复制」按钮的同一条链(ClipboardItem + navigator.clipboard.write),'
      + '写入的是无头浏览器的剪贴板——桌面 Chrome 通常即系统剪贴板,服务器环境可能无接收方,权限不足时如实返回 ok:false 与原因;'
      + 'share 是网页端移动端分享分支(Web Share API:先探 navigator.canShare({files}) 再尝试 navigator.share),'
      + '无头环境预期 NotAllowedError/不可用,返回 available:false 与原因,真实成功只在带分享面板的平台出现。'
      + 'copy/share 需要浏览器运行环境(本机 Chrome 与站点构建产物);环境缺失时返回中文能力错误。'
      + 'artifactId 不存在时报错并列出现有 id。',
    inputSchema: {
      action: z.enum(['list', 'read', 'copy', 'share', 'delete']).describe(
        'list=列出现有产物;read=读取产物内容(尺寸+base64+图像块);copy=写入受管浏览器剪贴板;share=尝试 Web Share;delete=删除产物',
      ),
      artifactId: z.string().optional().describe('产物 id(render 返回的 artifactId);read/copy/share/delete 必填'),
    },
    outputSchema: {
      action: z.enum(['list', 'read', 'copy', 'share', 'delete']),
      // list
      artifacts: z.array(artifactMetaSchema).optional().describe('现有产物清单(action=list)'),
      count: z.number().int().optional().describe('产物数量(action=list)'),
      // read
      artifact: artifactMetaSchema.optional().describe('产物元数据(action=read/copy/share/delete)'),
      width: z.number().int().nullable().optional().describe('像素宽(PNG 头嗅探;嗅探失败为 null)(action=read)'),
      height: z.number().int().nullable().optional().describe('像素高(PNG 头嗅探;嗅探失败为 null)(action=read)'),
      base64: z.string().optional().describe('PNG 字节的 base64(action=read)'),
      // copy
      ok: z.boolean().optional().describe('剪贴板写入是否成功(action=copy)'),
      // share
      available: z.boolean().optional().describe('navigator.canShare 是否可用(action=share)'),
      shared: z.boolean().optional().describe('navigator.share 是否真正成功(action=share)'),
      reason: z.string().optional().describe('失败/不可用原因(copy=clipboard 失败原因;share=canShare 或 share 的原因)'),
      // both
      note: z.string().optional().describe('平台条件说明(action=copy/share)'),
      // delete
      deleted: artifactMetaSchema.optional().describe('被删除的产物元数据(action=delete)'),
    },
  }, async ({ action, artifactId }) => {
    if (action === 'list') {
      const artifacts = listArtifacts()
      return toolResult(
        { action, artifacts, count: artifacts.length },
        `现有 ${artifacts.length} 个产物${
          artifacts.length > 0 ? `:${artifacts.map((m) => m.artifactId).slice(0, 5).join(', ')}${artifacts.length > 5 ? ' …' : ''}` : '(先用 render 生成)'
        }`,
      )
    }

    const id = requireArtifact(artifactId)

    if (action === 'delete') {
      const deleted = deleteArtifact(id)
      return toolResult(
        { action, deleted },
        `已删除产物 ${id}${deleted != null ? `(${deleted.bytes} 字节,${deleted.label})` : ''}`,
      )
    }

    const { meta, png } = readArtifact(id)!
    const base64 = Buffer.from(png).toString('base64')

    if (action === 'read') {
      const dimensions = sniffImageDimensions(png)
      const summary = `产物 ${id}:${meta.bytes} 字节,${dimensions != null ? `${dimensions.width}x${dimensions.height}px` : '尺寸嗅探失败'},${meta.label}`
      // Not toolResult(): the payload also ships the PNG as an MCP image
      // content block, and the helper's return type narrows content to text.
      return {
        content: [
          { type: 'text' as const, text: summary },
          { type: 'image' as const, data: base64, mimeType: 'image/png' },
        ],
        structuredContent: {
          action,
          artifact: meta,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          base64,
        },
      }
    }

    if (action === 'copy') {
      let ok = false
      let reason: string | undefined
      try {
        const clipboardResult = await browserManager.runTask(
          { label: 'deliver_artifact(copy)', timeoutMs: COPY_SHARE_TIMEOUT_MS },
          async (page) => {
            await page.goto('')
            return await page.evaluate<{ ok: boolean }>(CLIPBOARD_WRITE_SCRIPT, [base64])
          },
        )
        ok = clipboardResult.ok
      } catch (e) {
        ok = false
        reason = (e as Error).message ?? String(e)
      }
      return toolResult(
        {
          action,
          artifact: meta,
          ok,
          ...(reason != null || !ok ? { reason: reason ?? 'navigator.clipboard.write 未返回成功' } : {}),
          note: COPY_NOTE,
        },
        ok
          ? `已把产物 ${id} 写入受管无头浏览器的剪贴板(${meta.bytes} 字节)——${COPY_NOTE}`
          : `产物 ${id} 写入剪贴板失败:${reason ?? 'navigator.clipboard.write 未返回成功'}——${COPY_NOTE}`,
      )
    }

    // action === 'share'
    let payload: { available: boolean, shared?: boolean, reason?: string }
    try {
      payload = await browserManager.runTask(
        { label: 'deliver_artifact(share)', timeoutMs: COPY_SHARE_TIMEOUT_MS },
        async (page) => {
          await page.goto('')
          return await page.evaluate<{ available: boolean, shared?: boolean, reason?: string }>(WEB_SHARE_SCRIPT, [base64])
        },
      )
    } catch (e) {
      payload = { available: false, reason: (e as Error).message ?? String(e) }
    }
    return toolResult(
      {
        action,
        artifact: meta,
        available: payload.available,
        ...(payload.shared != null ? { shared: payload.shared } : {}),
        ...(payload.reason != null ? { reason: payload.reason } : {}),
        note: SHARE_NOTE,
      },
      payload.shared === true
        ? `产物 ${id} 已通过 Web Share 分享——${SHARE_NOTE}`
        : `产物 ${id} 的 Web Share 不可用:${payload.reason ?? '未知原因'}——${SHARE_NOTE}`,
    )
  })
}
