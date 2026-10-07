// set_portrait tool (M7 agent D owns this file).
// Custom portrait add/reset with upstream showcaseOnEditPortraitOk semantics.
//
// The tool is a literal mirror of the web's portrait save/revert flow
// (src/lib/characterPreview/characterPreviewController.tsx:254-293):
//   set   = showcaseOnEditPortraitOk's 'add' branch   — setCustomPortrait(config)
//           (session-only, mirror of useCharacterPreviewState's useState which
//           upstream never reads back), upsert the character when it is not in
//           the inventory yet (persistenceService.upsertCharacterFromForm —
//           the deliberate side effect of the web flow, kept verbatim), then
//           setCharacter({...char, portrait: config}) and delayedSave (MCP:
//           withChange + markDirty, the debounced flush SaveState.delayedSave
//           maps onto).
//   reset = the 'delete' branch — the character MUST be in the inventory
//           (upstream console.warn('No character selected') + no-op becomes an
//           explicit Chinese error here), portrait=undefined, the character
//           itself is kept, setCustomPortrait(undefined), delayedSave.
// The actual mutation runs through the upstream function itself — only the
// modal-closing callback collapses into a no-op and Message/i18n bootstrap the
// same way domains/showcase.ts does for importShowcaseCharacters.
//
// originalDimensions (CustomImageConfig.originalDimensions) drives the portrait
// object-position math (customPortraitUtils.getCustomPortraitObjectPosition);
// upstream fills it from the browser Image element (editImageUtils.isValidImage*
// → img.naturalWidth/Height). Node has no Image decoder, so we sniff the bytes:
// PNG IHDR / JPEG SOF / WebP VP8|VP8L|VP8X headers, pure Buffer arithmetic with
// zero new dependencies. data: URLs decode in place; http(s) URLs are fetched
// with an 8s timeout. Callers can always bypass sniffing with an explicit
// originalDimensions — and must, for formats the sniffer does not know (GIF,
// AVIF, …) or unreachable hosts.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { showcaseOnEditPortraitOk } from 'lib/characterPreview/characterPreviewController'
import {
  MAX_ZOOM,
  MIN_ZOOM,
} from 'lib/overlays/modals/editImageUtils'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { getCharacterById } from 'lib/stores/character/characterStore'
import type {
  Character,
  CharacterId,
} from 'types/character'
import type {
  CroppedArea,
  CustomImageConfig,
  ImageDimensions,
} from 'types/customImage'
import type { Form } from 'types/form'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { toolResult } from '../toolResult'

// ─── image dimension sniffing (PNG / JPEG / WebP, no dependencies) ───────────

/** Big-endian u32 at `offset`. */
function readU32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 24 | bytes[offset + 1]! << 16 | bytes[offset + 2]! << 8 | bytes[offset + 3]!) >>> 0
}

/** Little-endian u32 at `offset`. */
function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0
}

/** Little-endian u16 at `offset`. */
function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | bytes[offset + 1]! << 8
}

/** Big-endian u16 at `offset`. */
function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! << 8 | bytes[offset + 1]!
}

function sniffPng(bytes: Uint8Array): ImageDimensions | null {
  // 89 50 4E 47 0D 0A 1A 0A + IHDR chunk: length 13 at 8, "IHDR" at 12,
  // width at 16, height at 20 (both big-endian)
  if (bytes.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((b, i) => bytes[i] === b)) return null
  if (readU32BE(bytes, 8) !== 13) return null
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
}

function sniffJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  // Walk the marker segments until a frame header (SOFn). Standalone markers
  // (RSTn/TEM/SOI/EOI) carry no length; DHT/DAC/JPG/composites are skippable
  // segments; everything in 0xC0-0xCF except those is an SOF with the same
  // payload layout: precision(1) height(2) width(2).
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = readU16BE(bytes, offset + 2) // segment length includes itself
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = readU16BE(bytes, offset + 5)
      const width = readU16BE(bytes, offset + 7)
      return { width, height }
    }
    if (marker === 0xd9 || length < 2) return null
    offset += 2 + length
  }
  return null
}

function sniffWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF') return null
  if (String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return null
  const chunk = String.fromCharCode(...bytes.slice(12, 16))
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, then sync code 9D 01 2A, then 14-bit w/h LE
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { width: readU16LE(bytes, 26) & 0x3fff, height: readU16LE(bytes, 28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    // Lossless: signature byte 0x2F, then 14-bit width-1 / 14-bit height-1
    if (bytes[20] !== 0x2f) return null
    const bits = readU32LE(bytes, 21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit LE canvas width-1 at 24, height-1 at 27
    const width = 1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16)
    const height = 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16)
    return { width, height }
  }
  return null
}

/**
 * Sniff pixel dimensions out of raw image bytes. Supports PNG (IHDR), JPEG
 * (SOF frame headers, EXIF-safe) and WebP (VP8 / VP8L / VP8X). Returns null
 * for anything else — the caller decides how to surface that.
 */
export function sniffImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes)
}

/** Hard cap for the streamed header fetch: an SOF beyond 256 KiB of EXIF is
 * not a real-world image, and we never want to slurp a 20 MB url just to read
 * 24 bytes. */
const SNIFF_FETCH_CAP_BYTES = 256 * 1024
const SNIFF_FETCH_TIMEOUT_MS = 8_000

async function fetchHeaderBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SNIFF_FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
  }
  if (response.body == null) {
    return new Uint8Array(await response.arrayBuffer())
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < SNIFF_FETCH_CAP_BYTES) {
    const { done, value } = await reader.read()
    if (done || value == null) break
    chunks.push(value)
    total += value.byteLength
  }
  try {
    await reader.cancel()
  } catch {
    // The server may have reset the connection on cancel — the bytes we hold are enough
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.byteLength
  }
  return all
}

/**
 * Resolve originalDimensions for an image url: data: URLs decode in place,
 * http(s) urls are fetched (capped at the first 256 KiB, 8s timeout). Throws a
 * Chinese, actionable error when sniffing fails — the caller's way out is
 * passing an explicit originalDimensions.
 */
export async function sniffImageUrlDimensions(url: string): Promise<ImageDimensions> {
  let bytes: Uint8Array
  if (url.startsWith('data:')) {
    const base64 = url.slice(url.indexOf(',') + 1)
    try {
      bytes = new Uint8Array(Buffer.from(base64, 'base64'))
    } catch (e) {
      throw new Error(`set_portrait:无法解码 data URL 的图像字节(${(e as Error).message})— 请显式传 originalDimensions`)
    }
  } else {
    let fetched: Uint8Array
    try {
      fetched = await fetchHeaderBytes(url)
    } catch (e) {
      const name = (e as Error)?.name
      const cause = name === 'TimeoutError' || name === 'AbortError'
        ? `拉取超过 ${SNIFF_FETCH_TIMEOUT_MS}ms 超时`
        : (e as Error).message ?? String(e)
      throw new Error(`set_portrait:无法拉取 ${url} 的图像字节(${cause})— 请显式传 originalDimensions`)
    }
    bytes = fetched
  }
  const dimensions = sniffImageDimensions(bytes)
  if (dimensions == null || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error(
      'set_portrait:无法从图像字节中识别原始尺寸(嗅探器支持 PNG/JPEG/WebP;其他格式或损坏数据会失败)— 请显式传 originalDimensions',
    )
  }
  return dimensions
}

// ─── session mirror of the showcase-side portrait state ─────────────────────

// Upstream setCustomPortrait is useCharacterPreviewState's useState setter
// (src/lib/characterPreview/useCharacterPreviewState.ts:70) whose value is
// never read back — a browser-session-scoped echo of the last portrait edit.
// MCP keeps the same session-only semantics with a process-local map: it is
// NOT persisted, NOT part of the save, and reset by a matching reset call.
const showcaseCustomPortraits = new Map<string, CustomImageConfig>()

export function getShowcaseCustomPortrait(characterId: string): CustomImageConfig | undefined {
  return showcaseCustomPortraits.get(characterId)
}

// ─── zod shapes ──────────────────────────────────────────────────────────────

const nonNegativeInt = z.number().int().min(0)
const nonNegativeNumber = z.number().min(0).finite()
// 像素矩形是整数;百分比矩形(croppedArea)来自 react-easy-crop,是小数
const croppedAreaPixelsSchema = z.object({
  x: nonNegativeInt,
  y: nonNegativeInt,
  width: nonNegativeInt,
  height: nonNegativeInt,
})
const croppedAreaPercentSchema = z.object({
  x: nonNegativeNumber,
  y: nonNegativeNumber,
  width: nonNegativeNumber,
  height: nonNegativeNumber,
})

const IMAGE_URL_PATTERN = /^(data:image\/[a-z0-9.+-]+;base64,|https?:\/\/)/i

const setPortraitConfigSchema = z.object({
  imageUrl: z.string().min(1).regex(IMAGE_URL_PATTERN, '必须是 data: 图像 URL(base64)或 http(s):// 地址'),
  artistName: z.string().default(''),
  croppedAreaPixels: croppedAreaPixelsSchema,
  croppedArea: croppedAreaPercentSchema.optional(),
  cropper: z.object({
    zoom: z.number().min(MIN_ZOOM).max(MAX_ZOOM),
    crop: z.object({ x: z.number(), y: z.number() }),
  }).default({ zoom: 1, crop: { x: 0, y: 0 } }),
  originalDimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
})

/** Percent crop rectangle, derived exactly like react-easy-crop reports it:
 * pixel rect / original dimensions * 100. `override` wins when provided. */
function deriveCroppedArea(
  pixels: CroppedArea,
  original: ImageDimensions,
  override: CroppedArea | undefined,
): CroppedArea {
  if (override != null) return override
  if (original.width <= 0 || original.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  return {
    x: pixels.x / original.width * 100,
    y: pixels.y / original.height * 100,
    width: pixels.width / original.width * 100,
    height: pixels.height / original.height * 100,
  }
}

// ─── tool registration ───────────────────────────────────────────────────────

const portraitConfigSchema = z.object({
  imageUrl: z.string(),
  originalDimensions: z.object({ width: z.number().int(), height: z.number().int() }),
  customImageParams: z.object({
    croppedArea: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
    croppedAreaPixels: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  }),
  cropper: z.object({
    zoom: z.number(),
    crop: z.object({ x: z.number(), y: z.number() }),
  }),
  artistName: z.string(),
})

export function registerPortraitTools(server: McpServer): void {
  server.registerTool('set_portrait', {
    title: '设置自定义肖像',
    description: '为角色设置/重置自定义肖像——对应网页端角色展示卡「编辑肖像」弹窗确认后的保存动作,'
      + '执行上游同一条保存链(showcaseOnEditPortraitOk):肖像写入存档的 character.portrait(CustomImageConfig),'
      + '角色不在库存时按上游语义自动补入角色(upsertCharacterFromForm,仅含 characterId 的默认角色);'
      + '重置则要求角色已在库存,清除 portrait 但保留角色本身。showcase 侧的会话肖像(setCustomPortrait)'
      + '上游为不落盘的 React state,本工具同样只保留进程内会话镜像、不写存档。'
      + 'action=set 需要图像 URL(data: base64 或 http(s)://)与裁剪参数 croppedAreaPixels(像素矩形),'
      + 'originalDimensions 缺省时自动嗅探(PNG/JPEG/WebP 文件头;http(s) 地址拉取字节,8 秒超时),'
      + '嗅探失败或格式不受支持时请显式传 originalDimensions。'
      + 'cropper.zoom 范围与网页端一致(1–5)。变更经事务协调器提交:成功后标记 dirty、revision 递增,'
      + '由防抖写回落盘(网页端的 SaveState.delayedSave 同一落点)。',
    inputSchema: {
      characterId: z.string().min(1).describe('角色 id(必须存在于游戏元数据,如 "1212b1";set 时角色不必已在存档中——会像网页端一样自动补入)'),
      action: z.enum(['set', 'reset']).describe('set=保存自定义肖像(上游 add 分支);reset=恢复默认肖像(上游 delete 分支,角色保留、portrait 清空)'),
      imageUrl: z.string().optional().describe('action=set 必填:图像地址,data: 图像 URL(base64)或 http(s):// 链接(对应网页端 URL/上传两种来源的最终 imageUrl)'),
      artistName: z.string().optional().describe('action=set 可选:画师署名,写入配置并展示在卡面上;缺省为空字符串'),
      croppedAreaPixels: croppedAreaPixelsSchema.optional().describe(
        'action=set 必填:裁剪区域的像素矩形 {x,y,width,height}(react-easy-crop 的同名输出,相对原图左上角,数值非负)',
      ),
      croppedArea: croppedAreaPercentSchema.optional().describe(
        '裁剪区域的百分比矩形(react-easy-crop 的同名输出,可为小数);缺省由 croppedAreaPixels / originalDimensions 派生',
      ),
      cropper: z.object({
        zoom: z.number().min(MIN_ZOOM).max(MAX_ZOOM),
        crop: z.object({ x: z.number(), y: z.number() }),
      }).optional().describe(`裁剪器状态;缺省为 {zoom:1, crop:{x:0,y:0}}(zoom 范围 ${MIN_ZOOM}–${MAX_ZOOM},与网页端裁剪器一致)`),
      originalDimensions: z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }).optional().describe('原图像素尺寸的显式覆盖;缺省时从图像字节嗅探(PNG/JPEG/WebP),非受支持格式或拉取失败时必须显式传入'),
      baseRevision: z.number().int().optional().describe('乐观并发门:与当前修订号不一致时报冲突(消息含两个修订号),需重读状态后重试'),
    },
    outputSchema: {
      updated: z.boolean(),
      action: z.enum(['set', 'reset']),
      characterId: z.string(),
      characterInserted: z.boolean().describe('角色此前不在库存、本次按上游语义自动补入(set 时可能为 true;reset 恒 false)'),
      portrait: portraitConfigSchema.nullable().describe('set=写入的完整 CustomImageConfig;reset=null(portrait 已清空)'),
      showcasePortrait: portraitConfigSchema.nullable().describe('showcase 侧会话肖像镜像(上游 setCustomPortrait,不落盘;reset 后为 null)'),
      revision: z.number().int(),
      dirty: z.boolean(),
    },
  }, async (params) => {
    const { characterId, action } = params
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    // 与 state.ts showcase 段同一校验口径:角色必须在游戏元数据中
    if (!getGameMetadata().characters[characterId as CharacterId]) {
      throw new Error(
        `set_portrait: 字段 characterId 的值 "${characterId}" 不在游戏元数据中 — 请使用有效的角色 id`,
      )
    }

    // Showcase-side Message.success goes through i18next like the web app
    ensureI18nReady()

    let config: CustomImageConfig | undefined
    let characterInserted = false

    if (action === 'set') {
      // 缺参的中文提示先于 zod 通用 issue(可操作性优先)
      if (params.imageUrl == null || params.croppedAreaPixels == null) {
        throw new Error('set_portrait:action=set 必须同时提供 imageUrl 与 croppedAreaPixels(裁剪像素矩形)')
      }
      const parsed = setPortraitConfigSchema.safeParse({
        imageUrl: params.imageUrl,
        artistName: params.artistName ?? '',
        croppedAreaPixels: params.croppedAreaPixels,
        croppedArea: params.croppedArea,
        cropper: params.cropper,
        originalDimensions: params.originalDimensions,
      })
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}:${issue.message}`)
          .join('; ')
        throw new Error(`set_portrait:action=set 的参数无效 — ${issues}`)
      }
      const p = parsed.data

      // Dimension resolution happens BEFORE the transaction: the sniff is
      // async (data URL decode / http fetch) and withChange bodies must stay
      // synchronous.
      const originalDimensions = p.originalDimensions ?? await sniffImageUrlDimensions(p.imageUrl)

      config = {
        imageUrl: p.imageUrl,
        originalDimensions,
        customImageParams: {
          croppedArea: deriveCroppedArea(p.croppedAreaPixels, originalDimensions, p.croppedArea),
          croppedAreaPixels: p.croppedAreaPixels,
        },
        cropper: p.cropper,
        artistName: p.artistName,
      }
      characterInserted = getCharacterById(characterId as CharacterId) == null
    } else {
      // reset 镜像上游 delete 分支的前置:'No character selected'(网页端仅
      // console.warn 后跳过;MCP 侧显式报中文错误,不静默成功)
      if (getCharacterById(characterId as CharacterId) == null) {
        throw new Error(
          `set_portrait:action=reset 要求角色 ${characterId} 已在存档库存中(上游语义:未选中角色时不执行恢复)— 请先确认角色 id,或用 set_portrait(action=set) 补入`,
        )
      }
    }

    // The real upstream flow (characterPreviewController.tsx:254-293): store
    // writes + Message + delayedSave all inside; the modal-close callback is
    // the only UI concern we collapse into a no-op. markDirty replaces the
    // save scheduling the MCP flush owns.
    await runtimeContext.withChange('set_portrait', () => {
      showcaseOnEditPortraitOk(
        { id: characterId } as Character, // upstream only reads character.id
        { type: action === 'set' ? 'add' : 'delete', config: config ?? ({} as CustomImageConfig) },
        (c) => {
          if (c == null) showcaseCustomPortraits.delete(characterId)
          else showcaseCustomPortraits.set(characterId, c)
        },
        () => {}, // setEditPortraitModalOpen — modal UI, no MCP counterpart
      )
      runtimeContext.markDirty()
    }, params.baseRevision != null ? { baseRevision: params.baseRevision } : {})

    const revision = runtimeContext.getRevision()
    return toolResult(
      {
        updated: true,
        action,
        characterId,
        characterInserted,
        portrait: config ?? null,
        showcasePortrait: getShowcaseCustomPortrait(characterId) ?? null,
        revision,
        dirty: true,
      },
      action === 'set'
        ? `已为 ${characterId} 保存自定义肖像${characterInserted ? '(角色此前不在库存,已按上游语义自动补入)' : ''},`
          + `原图 ${config!.originalDimensions.width}x${config!.originalDimensions.height}`
          + `${config!.artistName ? `,画师 ${config!.artistName}` : ''},revision=${revision}`
        : `已恢复 ${characterId} 的默认肖像(portrait 已清空,角色保留),revision=${revision}`,
    )
  })
}
