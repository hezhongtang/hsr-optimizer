// Live scanner client domain (M6-A): scanner(action=connect|disconnect|status|events).
//
// The MCP server acts as a Reliquary-Archiver-style WebSocket CLIENT: it
// connects out to a real scanner (ws://…), applies incoming event frames
// through the same import chain the Import tab uses, and exposes the event
// log for inspection. Mirror of src/lib/tabs/tabImport/scannerStore.ts +
// ScannerWebsocketClient.tsx (the web side of that socket), inverted: we
// dial instead of listen.
//
// Event-application semantics (upstream anchors, web parity):
//   - frame envelope {event, data} JSON text — ScannerWebsocketClient.tsx:77
//     onMessage; malformed JSON is logged and skipped WITHOUT disconnecting,
//     unknown event types likewise only log (scannerStore.ts:413 ScannerEvent
//     union is the full allowlist)
//   - the per-connection scanner cache (relics/lightCones/materials/
//     characters/gachaFunds keyed maps + activatedBuffs) lives in the same
//     upstream usePrivateScannerState store the web uses; setConnected(true/
//     false) resets it on every connect/disconnect/reconnect exactly like the
//     web socket lifecycle — DeleteRelics only ever deletes what the CURRENT
//     connection's cache still holds (scannerStore.ts:588 handleDeleteRelic)
//   - UpdateRelics → handleUpdateRelic (scannerStore.ts:500): only 5★ relics
//     reach the store; an existing relic keeps its owner while
//     ingestCharacters is off; ingestOnlyExistingCharacters blanks owners not
//     in the character store
//   - UpdateCharacters → handleUpdateCharacter (scannerStore.ts:545): needs
//     ingest AND ingestCharacters; ingestOnlyExistingCharacters skips unknown
//     characters; a changed buffed-version mapping relocates the old id's
//     relics to the new id
//   - DeleteRelics → handleDeleteRelic: only 5★ relics are removed from the
//     store, keyed by the frame _uid (scanner-parsed relics keep _uid as
//     their store id — kelzFormatParser.tsx:337)
//   - UpdateLightCones / DeleteLightCones / UpdateMaterials: cache-only
//   - GachaResult: ignored by design (M6 acceptance: no gacha-record
//     feature); recorded in the event log as ignored
//   - UpdateGachaFunds: cache +, when ingest AND ingestWarpResources are on
//     (the web broadcast gate is `state.ingest`, the warp sync gate adds
//     ingestWarpResources — ScannerWebsocketClient.tsx:148,
//     useWarpScannerSync.ts:11), jades = stellar_jade + oneric_shards lands
//     in the persisted warp planner request (useWarpScannerSync.ts:16)
//
// Divergence from the raw web path, deliberate and documented in the tool
// description: a live InitialScan is merged through import_scanner_json's
// union machine (planAndRunImport) instead of upstream's bare mergeRelics
// replace — identical outcome for a scanner's full-inventory scan, but a
// partial scan can never wipe relics the MCP save holds and the frame did
// not cover (imports.ts erratum #5). Deletions still flow through explicit
// DeleteRelics frames, exactly like the web.
//
// Writes go through runtimeContext.withChange('scanner:'+frameType, …) with
// markDirty inside — same debounced flush + revision semantics as file
// imports. status/events are read-only and never bump the revision. Setting
// changes via update_state(section=scanner) take effect from the NEXT frame
// on (no re-import replay — the web's setIngest re-ingest branch belongs to
// the store setters, which MCP's update_state deliberately bypasses).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ReliquaryArchiverParser } from 'lib/importer/importConfig'
import type {
  ScannerParserJson,
  V4ParserCharacter,
  V4ParserGachaFunds,
  V4ParserLightCone,
  V4ParserMaterial,
  V4ParserRelic,
} from 'lib/importer/kelzFormatParser'
import { getActivatedBuffs } from 'lib/importer/kelzFormatParser'
import { getCharacterById } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import {
  DEFAULT_WEBSOCKET_URL,
  handleDeleteLightCone,
  handleDeleteRelic,
  handleUpdateCharacter,
  handleUpdateLightCone,
  handleUpdateMaterial,
  handleUpdateRelic,
  useScannerState,
} from 'lib/tabs/tabImport/scannerStore'
import type { ScannerStore } from 'lib/tabs/tabImport/scannerStore'
import { useWarpCalculatorStore } from 'lib/tabs/tabWarp/useWarpCalculatorStore'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { toolResult } from '../toolResult'
import { planAndRunImport } from './imports'

// ─── event log (ring buffer) ─────────────────────────────────────────────────

const EVENT_LOG_CAPACITY = 500
const CONNECT_TIMEOUT_MS = 5000
const RECONNECT_DELAY_MS = 1000
const EVENTS_DEFAULT_LIMIT = 50
const EVENTS_MAX_LIMIT = 500

type FrameLogResult = 'applied' | 'ignored' | 'error' | 'info'

type FrameLogEntry = {
  seq: number,
  at: number,
  /** 帧事件名(InitialScan/UpdateRelics/…),连接生命周期用 connect/disconnect/reconnect,坏帧用 parse_error */
  type: string,
  result: FrameLogResult,
  bytes: number,
  summary: string,
  detail?: Record<string, unknown>,
  error?: string,
}

const eventLog: FrameLogEntry[] = []
let nextLogSeq = 1
let droppedLogEntries = 0

function appendLog(entry: Omit<FrameLogEntry, 'seq' | 'at'>): FrameLogEntry {
  const full: FrameLogEntry = { seq: nextLogSeq++, at: Date.now(), ...entry }
  eventLog.push(full)
  if (eventLog.length > EVENT_LOG_CAPACITY) {
    droppedLogEntries += eventLog.length - EVENT_LOG_CAPACITY
    eventLog.splice(0, eventLog.length - EVENT_LOG_CAPACITY)
  }
  return full
}

// ─── connection + stats state ────────────────────────────────────────────────

type ActiveConnection = {
  url: string,
  socket: WebSocket,
  connectedAt: number,
}

const frameStats = {
  received: 0,
  applied: 0,
  ignored: 0,
  errored: 0,
  bytes: 0,
  reconnects: 0,
}

let connection: ActiveConnection | null = null
/** 非空 = 客户端应保持连接(意外断开后自动重连的目标地址);disconnect 置空 */
let wantedUrl: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** 每次 connect/disconnect 调用自增:作废还在途的旧连接尝试 */
let sessionToken = 0
let lastFrameAt: number | null = null
let lastError: { at: number, message: string } | null = null
/** 帧按到达顺序串行应用(与 withChange 队列一致),日志条目携带每帧的真实结果 */
let framePipeline: Promise<void> = Promise.resolve()

function recordError(message: string): void {
  lastError = { at: Date.now(), message }
}

type ScannerSettings = {
  ingest: boolean,
  ingestCharacters: boolean,
  ingestOnlyExistingCharacters: boolean,
  ingestWarpResources: boolean,
}

function readSettings(): ScannerSettings {
  const state = useScannerState.getState()
  return {
    ingest: state.ingest,
    ingestCharacters: state.ingestCharacters,
    ingestOnlyExistingCharacters: state.ingestOnlyExistingCharacters,
    ingestWarpResources: state.ingestWarpResources,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray<T>(data: unknown, frameType: string): T[] {
  if (!Array.isArray(data)) {
    throw new Error(`${frameType} 帧的 data 必须是数组,实际收到 ${typeof data}`)
  }
  return data as T[]
}

// ─── websocket client ────────────────────────────────────────────────────────

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (e) {
      reject(
        new Error(
          `连接扫描器失败:${url} — ${(e as Error).message}。请检查地址格式(必须以 ws:// 或 wss:// 开头)`,
        ),
      )
      return
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.terminate()
      } catch {
        // 从未打开的 socket 无需处理
      }
      reject(
        new Error(
          `连接扫描器失败:${url} — ${error.message}。请确认扫描器(Reliquary Archiver 等)已在本机运行并监听该地址;`
            + '地址可先用 update_state(section=scanner) 修改 websocketUrl,或给 connect 显式传 url',
        ),
      )
    }
    const timer = setTimeout(() => fail(new Error(`连接超时(${CONNECT_TIMEOUT_MS}ms)`)), CONNECT_TIMEOUT_MS)
    socket.once('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error: Error) => fail(error))
  })
}

function rawFrameToText(data: RawData): { text: string, bytes: number } {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
  return { text: buffer.toString('utf8'), bytes: buffer.byteLength }
}

function adoptSocket(url: string, socket: WebSocket, cause: 'connect' | 'reconnect'): ActiveConnection {
  const active: ActiveConnection = { url, socket, connectedAt: Date.now() }
  connection = active
  // 与网页端 onOpen 一致:置 connected 并清空上一轮连接的扫描缓存
  useScannerState.getState().setConnected(true)

  socket.on('message', (data: RawData) => {
    const { text, bytes } = rawFrameToText(data)
    frameStats.received++
    frameStats.bytes += bytes
    lastFrameAt = Date.now()
    framePipeline = framePipeline.then(() => processFrame(text, bytes)).catch(() => {})
  })

  socket.on('close', () => {
    if (connection !== active) return
    connection = null
    // 与网页端 onClose 一致:断开即清空扫描缓存
    useScannerState.getState().setConnected(false)
    appendLog({
      type: 'disconnect',
      result: 'info',
      bytes: 0,
      summary: `与扫描器的连接已断开(${url})${wantedUrl === url ? ',将自动重连' : ''}`,
    })
    if (wantedUrl === url) scheduleReconnect(url)
  })

  socket.on('error', (error: Error) => {
    recordError(`扫描器连接出错(${url}):${error.message}`)
  })

  appendLog({
    type: cause === 'reconnect' ? 'reconnect' : 'connect',
    result: 'info',
    bytes: 0,
    summary: `${cause === 'reconnect' ? '已重新连接' : '已连接'}扫描器:${url}`,
  })
  return active
}

function clearReconnectTimer(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect(url: string): void {
  frameStats.reconnects++
  const token = sessionToken
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (token !== sessionToken || wantedUrl !== url || connection != null) return
    void openSocket(url).then(
      (socket) => {
        if (token !== sessionToken || wantedUrl !== url || connection != null) {
          try {
            socket.close()
          } catch {
            // 并发调用已接管连接,丢弃该 socket 即可
          }
          return
        }
        adoptSocket(url, socket, 'reconnect')
      },
      (error: Error) => {
        if (token !== sessionToken || wantedUrl !== url) return
        recordError(error.message)
        scheduleReconnect(url)
      },
    )
  }, RECONNECT_DELAY_MS)
}

// ─── frame application (mirrors ScannerWebsocketClient.onMessage) ────────────

async function processFrame(text: string, bytes: number): Promise<void> {
  let event: unknown
  try {
    event = JSON.parse(text)
  } catch (e) {
    frameStats.errored++
    const message = (e as Error).message
    recordError(`扫描器帧不是合法 JSON:${message}`)
    appendLog({
      type: 'parse_error',
      result: 'error',
      bytes,
      summary: `帧不是合法 JSON(${message}),已忽略该帧并保持连接`,
      error: message,
    })
    return
  }

  const type = isPlainObject(event) && typeof event['event'] === 'string' ? event['event'] : null
  const data = isPlainObject(event) ? event['data'] : undefined
  if (type == null) {
    frameStats.errored++
    const message = '帧缺少字符串类型的 event 字段'
    recordError(`扫描器帧无法识别:${message}`)
    appendLog({ type: 'unknown', result: 'error', bytes, summary: `${message},已忽略该帧并保持连接`, error: message })
    return
  }

  try {
    switch (type) {
      case 'InitialScan':
        await applyInitialScan(data, bytes)
        return
      case 'UpdateRelics':
        await applyUpdateRelics(data, bytes)
        return
      case 'UpdateCharacters':
        await applyUpdateCharacters(data, bytes)
        return
      case 'DeleteRelics':
        await applyDeleteRelics(data, bytes)
        return
      case 'UpdateLightCones':
        applyCacheOnlyFrame('UpdateLightCones', bytes, (state) => {
          for (const lightCone of asArray<V4ParserLightCone>(data, 'UpdateLightCones')) handleUpdateLightCone(state, lightCone)
        })
        return
      case 'DeleteLightCones':
        applyCacheOnlyFrame('DeleteLightCones', bytes, (state) => {
          for (const uid of asArray<string>(data, 'DeleteLightCones')) handleDeleteLightCone(state, uid)
        })
        return
      case 'UpdateMaterials':
        await applyUpdateMaterials(data, bytes)
        return
      case 'UpdateGachaFunds':
        await applyUpdateGachaFunds(data, bytes)
        return
      case 'GachaResult':
        await applyGachaResult(data, bytes)
        return
      default:
        frameStats.errored++
        recordError(`未知扫描器事件:${type}`)
        appendLog({ type, result: 'error', bytes, summary: `未知事件类型 ${JSON.stringify(type)},只记日志并保持连接(与网页端一致)`, error: `未知事件 ${type}` })
    }
  } catch (e) {
    frameStats.errored++
    const message = e instanceof Error ? e.message : String(e)
    recordError(`应用 ${type} 帧失败:${message}`)
    appendLog({
      type,
      result: 'error',
      bytes,
      summary: `应用 ${type} 帧失败,库存与设置已回滚并保持连接(扫描缓存保留本帧写入——上游同样先写缓存、失败不回撤)`,
      error: message,
    })
  }
}

/** ingest 关闭时所有事件只更新扫描器缓存、不动库存(import.live.events 行 conditions)。 */
function applyCacheOnlyFrame(frameType: string, bytes: number, cacheWrites: (state: ScannerStore) => void): void {
  cacheWrites(useScannerState.getState())
  frameStats.ignored++
  appendLog({
    type: frameType,
    result: 'ignored',
    bytes,
    summary: `${frameType}:仅更新扫描缓存,不落库(网页端同款行为——光锥/材料只用于装备与展示判定)`,
    detail: { persisted: false },
  })
}

async function applyInitialScan(data: unknown, bytes: number): Promise<void> {
  const state = useScannerState.getState()
  const frame = data as ScannerParserJson
  // 网页端 initialScan():先记录完整扫描缓存
  state.updateInitialScan(frame)

  const settings = readSettings()
  if (!settings.ingest) {
    frameStats.ignored++
    appendLog({
      type: 'InitialScan',
      result: 'ignored',
      bytes,
      summary: `完整扫描已记录进缓存(${frame?.relics?.length ?? 0} 件遗器),但 ingest 关闭,未动库存`,
      detail: { persisted: false },
    })
    return
  }

  const detail = await runtimeContext.withChange('scanner:InitialScan', () => {
    // 与 ingestFullScan(scannerStore.ts:433)同序:先更新强化版映射再解析
    state.updateActivatedBuffs(getActivatedBuffs(frame?.characters ?? []))
    const parsed = ReliquaryArchiverParser.parse(frame)

    let characters = parsed.characters
    if (settings.ingestCharacters) {
      // 上游固定行为:实时导入的角色统一按 80 级/光锥 80 级落库
      for (const character of characters) {
        character.characterLevel = 80
        character.lightConeLevel = 80
      }
      if (settings.ingestOnlyExistingCharacters) {
        characters = characters.filter((character) => getCharacterById(character.characterId))
      }
    } else {
      characters = []
    }

    // 与 import_scanner_json 同一条合并链(union 并集,防部分扫描擦库;见文件头
    // divergence 说明)。planAndRunImport 内部完成 mergeRelics + markDirty。
    const outcome = planAndRunImport(parsed.relics, characters, 'union', false)
    return {
      added: outcome.added,
      updated: outcome.updated,
      skipped: outcome.skipped,
      removed: outcome.removed,
      totalBefore: outcome.totalBefore,
      totalAfter: outcome.totalAfter,
      characters: characters.length,
    }
  })

  frameStats.applied++
  appendLog({
    type: 'InitialScan',
    result: 'applied',
    bytes,
    summary: `完整扫描并入(union):新增 ${detail.added}、更新 ${detail.updated}、跳过 ${detail.skipped}、移除 ${detail.removed} 件遗器,`
      + `库存 ${detail.totalBefore} → ${detail.totalAfter},角色 ${detail.characters} 个${settings.ingestCharacters ? '' : '(未导入角色)'}`,
    detail,
  })

  // 上游 ingestFullScan 末尾 emitScannerEvents:把扫描自带的 gacha/materials 再
  // 广播一遍——跃迁同步据此落 星琼/专票(门同 = ingest && ingestWarpResources)。
  if (settings.ingestWarpResources) {
    await syncWarpFundsAndMaterials('InitialScan:warp', bytes)
  }
}

async function applyUpdateRelics(data: unknown, bytes: number): Promise<void> {
  const relics = asArray<V4ParserRelic>(data, 'UpdateRelics')
  const state = useScannerState.getState()
  const settings = readSettings()

  if (!settings.ingest) {
    for (const relic of relics) state.updateRelic(relic)
    frameStats.ignored++
    appendLog({
      type: 'UpdateRelics',
      result: 'ignored',
      bytes,
      summary: `收到 ${relics.length} 件遗器更新,但 ingest 关闭,仅记录进扫描缓存`,
      detail: { persisted: false, relics: relics.length },
    })
    return
  }

  const withReroll = relics.filter((relic) => Array.isArray(relic?.reroll_substats) && relic.reroll_substats.length > 0).length
  const detail = await runtimeContext.withChange('scanner:UpdateRelics', () => {
    const storeBefore = getRelics().length
    for (const relic of relics) handleUpdateRelic(state, relic)
    runtimeContext.markDirty()
    return {
      relics: relics.length,
      fiveStar: relics.filter((relic) => relic?.rarity === 5).length,
      withReroll,
      storeBefore,
      storeAfter: getRelics().length,
    }
  })

  frameStats.applied++
  appendLog({
    type: 'UpdateRelics',
    result: 'applied',
    bytes,
    summary: `遗器更新 ${detail.relics} 件(5★ ${detail.fiveStar} 件落库,其余按上游规则忽略;库存 ${detail.storeBefore} → ${detail.storeAfter})`
      + (detail.withReroll > 0 ? `;${detail.withReroll} 件带重掷预览(网页端弹对比窗,MCP 仅记录)` : ''),
    detail,
  })
}

async function applyUpdateCharacters(data: unknown, bytes: number): Promise<void> {
  const characters = asArray<V4ParserCharacter>(data, 'UpdateCharacters')
  const state = useScannerState.getState()
  const settings = readSettings()

  // 上游门槛:UpdateCharacters 需要 ingest 与 ingestCharacters 同时打开
  if (!settings.ingest || !settings.ingestCharacters) {
    for (const character of characters) state.updateCharacter(character)
    frameStats.ignored++
    appendLog({
      type: 'UpdateCharacters',
      result: 'ignored',
      bytes,
      summary: `收到 ${characters.length} 个角色更新,但需要 ingest 与 ingestCharacters 同时开启,仅记录进扫描缓存`,
      detail: { persisted: false, characters: characters.length },
    })
    return
  }

  const detail = await runtimeContext.withChange('scanner:UpdateCharacters', () => {
    for (const character of characters) handleUpdateCharacter(state, character)
    runtimeContext.markDirty()
    return { characters: characters.length }
  })

  frameStats.applied++
  appendLog({
    type: 'UpdateCharacters',
    result: 'applied',
    bytes,
    summary: `角色更新 ${detail.characters} 个(等级/光锥统一 80;ingestOnlyExistingCharacters=${settings.ingestOnlyExistingCharacters})`,
    detail,
  })
}

async function applyDeleteRelics(data: unknown, bytes: number): Promise<void> {
  const uids = asArray<string>(data, 'DeleteRelics')
  const state = useScannerState.getState()
  const settings = readSettings()

  if (!settings.ingest) {
    for (const uid of uids) state.deleteRelic(uid)
    frameStats.ignored++
    appendLog({
      type: 'DeleteRelics',
      result: 'ignored',
      bytes,
      summary: `收到 ${uids.length} 个遗器删除,但 ingest 关闭,仅从扫描缓存移除`,
      detail: { persisted: false, deletions: uids.length },
    })
    return
  }

  const detail = await runtimeContext.withChange('scanner:DeleteRelics', () => {
    const storeBefore = getRelics().length
    for (const uid of uids) handleDeleteRelic(state, uid)
    runtimeContext.markDirty()
    return { deletions: uids.length, storeBefore, storeAfter: getRelics().length }
  })

  frameStats.applied++
  appendLog({
    type: 'DeleteRelics',
    result: 'applied',
    bytes,
    summary: `遗器删除 ${detail.deletions} 个(仅 5★ 且当前连接缓存仍持有的会落库删除;库存 ${detail.storeBefore} → ${detail.storeAfter})`,
    detail,
  })
}

async function applyUpdateGachaFunds(data: unknown, bytes: number): Promise<void> {
  const funds = data as V4ParserGachaFunds
  if (
    !isPlainObject(funds)
    || typeof funds.stellar_jade !== 'number'
    || !Number.isFinite(funds.stellar_jade)
    || typeof funds.oneric_shards !== 'number'
    || !Number.isFinite(funds.oneric_shards)
  ) {
    throw new Error('UpdateGachaFunds 帧的 data 必须含数值型 stellar_jade 与 oneric_shards 字段')
  }
  const jades = funds.stellar_jade + funds.oneric_shards

  // 网页端:先更新缓存(updateGachaFunds 无条件执行)
  useScannerState.getState().updateGachaFunds(funds)

  const settings = readSettings()
  // 网页端门槛:事件广播需要 ingest,跃迁同步再要求 ingestWarpResources
  if (!settings.ingest || !settings.ingestWarpResources) {
    frameStats.ignored++
    appendLog({
      type: 'UpdateGachaFunds',
      result: 'ignored',
      bytes,
      summary: `跃迁资源(${funds.stellar_jade} 星琼 + ${funds.oneric_shards} 古老梦华)已记录进缓存;`
        + '需要 ingest 与 ingestWarpResources 同时开启才会写入跃迁规划底稿',
      detail: { persisted: false, jades },
    })
    return
  }

  await runtimeContext.withChange('scanner:UpdateGachaFunds', () => {
    // useWarpScannerSync.ts:16 同款口径:星琼数 = 星琼 + 古老梦华
    const store = useWarpCalculatorStore.getState()
    store.setRequest({ ...store.request, jades })
    runtimeContext.markDirty()
  })

  frameStats.applied++
  appendLog({
    type: 'UpdateGachaFunds',
    result: 'applied',
    bytes,
    summary: `跃迁资源同步:星琼 = ${funds.stellar_jade} + ${funds.oneric_shards} = ${jades},已写入跃迁规划底稿(ingestWarpResources 开启)`,
    detail: { jades },
  })
}

// ─── warp planner sync (useWarpScannerSync.ts 的无头对应物) ──────────────────
// 网页端跃迁页挂载时经 scannerChannel 消费三类事件;MCP 在帧到达时直接把同一套
// 公式落进跃迁底稿(门 = ingest && ingestWarpResources,与上游两级门一致)。
// 专票折算读扫描缓存(materials 由 UpdateMaterials/InitialScan 先写)。

type WirePityUpdate = { kind: 'AddPity' | 'ResetPity', amount: number, set_guarantee?: boolean }
type WireGachaResult = {
  banner_type: 'Character' | 'LightCone' | 'Standard',
  pity_5: WirePityUpdate,
}

function warpGatesOpen(): boolean {
  const settings = readSettings()
  return settings.ingest && settings.ingestWarpResources
}

/** 从扫描缓存把 星琼+梦华 与 专票+星芒折算 写进跃迁底稿(useWarpScannerSync 同款公式) */
async function syncWarpFundsAndMaterials(label: string, bytes: number): Promise<void> {
  const cache = useScannerState.getState()
  const funds = cache.gachaFunds
  const specialPasses = cache.materials['102'] ?? { id: '102', name: '', count: 0 }
  const undyingStarlight = cache.materials['252'] ?? { id: '252', name: '', count: 0 }
  const jades = funds ? funds.stellar_jade + funds.oneric_shards : null
  const passes = specialPasses.count + Math.floor(undyingStarlight.count / 20)

  await runtimeContext.withChange(`scanner:${label}`, () => {
    const store = useWarpCalculatorStore.getState()
    store.setRequest({ ...store.request, ...(jades != null ? { jades } : {}), passes })
    runtimeContext.markDirty()
  })

  frameStats.applied++
  appendLog({
    type: 'UpdateMaterials',
    result: 'applied',
    bytes,
    summary: `跃迁资源同步:专票 = 专票 ${specialPasses.count} + floor(未熄星芒 ${undyingStarlight.count} / 20) = ${passes}`
      + (jades != null ? `,星琼 ${jades}` : '')
      + ',已写入跃迁规划底稿(ingestWarpResources 开启)',
    detail: { passes, jades },
  })
}

/** UpdateMaterials 帧:缓存必写(上游折算从缓存读),门开后折算进跃迁底稿 */
async function applyUpdateMaterials(data: unknown, bytes: number): Promise<void> {
  const materials = asArray<V4ParserMaterial>(data, 'UpdateMaterials')
  const state = useScannerState.getState()
  for (const material of materials) handleUpdateMaterial(state, material)

  if (!warpGatesOpen()) {
    frameStats.ignored++
    appendLog({
      type: 'UpdateMaterials',
      result: 'ignored',
      bytes,
      summary: `材料更新 ${materials.length} 项已记录进扫描缓存;需要 ingest 与 ingestWarpResources 同时开启才会折算进跃迁规划底稿`,
      detail: { persisted: false, materials: materials.length },
    })
    return
  }
  await syncWarpFundsAndMaterials('UpdateMaterials', bytes)
}

/** GachaResult 帧:缓存与库存都不动(上游 ScannerWebsocketClient.tsx:94 同款);门开后仅同步垫抽/必中到跃迁底稿 */
async function applyGachaResult(data: unknown, bytes: number): Promise<void> {
  const result = data as WireGachaResult
  if (
    !isPlainObject(result)
    || (result.banner_type !== 'Character' && result.banner_type !== 'LightCone')
    || !isPlainObject(result.pity_5)
  ) {
    frameStats.errored++
    const message = 'GachaResult 帧的 data 必须含 banner_type("Character"|"LightCone")与 pity_5 {kind, amount}'
    recordError(`扫描器帧无法识别:${message}`)
    appendLog({ type: 'GachaResult', result: 'error', bytes, summary: `${message},已忽略该帧并保持连接`, error: message })
    return
  }
  if (!warpGatesOpen()) {
    frameStats.ignored++
    appendLog({
      type: 'GachaResult',
      result: 'ignored',
      bytes,
      summary: '抽卡结果帧:抽卡历史本身不落库(网页端同样不存,ScannerWebsocketClient.tsx:94);'
        + '需要 ingest 与 ingestWarpResources 同时开启才会把垫抽/必中同步进跃迁底稿',
    })
    return
  }

  const pity = result.pity_5
  const field = result.banner_type === 'Character' ? 'pityCharacter' : 'pityLightCone'
  const guaranteeField = result.banner_type === 'Character' ? 'guaranteedCharacter' : 'guaranteedLightCone'

  await runtimeContext.withChange('scanner:GachaResult', () => {
    const store = useWarpCalculatorStore.getState()
    const patch: Record<string, number | boolean> = {}
    if (pity.kind === 'ResetPity') {
      patch[field] = pity.amount
      patch[guaranteeField] = pity.set_guarantee === true
    } else {
      patch[field] = (store.request[field] ?? 0) + pity.amount
    }
    store.setRequest({ ...store.request, ...patch })
    runtimeContext.markDirty()
  })

  frameStats.applied++
  appendLog({
    type: 'GachaResult',
    result: 'applied',
    bytes,
    summary: `抽卡结果(${result.banner_type} 池,${pity.kind} ${pity.amount})已同步垫抽/必中到跃迁底稿;抽卡历史本身不落库(网页端同样)`,
    detail: { bannerType: result.banner_type, kind: pity.kind, amount: pity.amount },
  })
}

/**
 * update_state(section=scanner) 打开开关时的网页重放语义(scannerStore.ts:164-228):
 * 已连接且相应门打开时,setIngest/setIngestCharacters/setIngestOnlyExistingCharacters
 * 用 buildFullScanData() 重放一次完整导入;setIngestWarpResources 重发资源事件
 * (等价于从缓存再同步一次跃迁底稿)。MCP 在开关从关到开时执行同一套重放。
 */
export async function replayScannerSettings(changedKeys: string[]): Promise<string[]> {
  const state = useScannerState.getState()
  if (!state.connected) return []
  const replayed: string[] = []

  const fullScan = state.buildFullScanData()
  const wantsReimport = changedKeys.some((key) => ['ingest', 'ingestCharacters', 'ingestOnlyExistingCharacters'].includes(key))
  if (wantsReimport && state.ingest && fullScan && fullScan.relics.length > 0 && (changedKeys.includes('ingest') || state.ingestCharacters)) {
    await applyInitialScan(fullScan, JSON.stringify(fullScan).length)
    replayed.push('reimport')
  }

  if (changedKeys.includes('ingestWarpResources') && state.ingest && state.ingestWarpResources) {
    await syncWarpFundsAndMaterials('setIngestWarpResources:re-emit', 0)
    replayed.push('warp-re-emit')
  }
  return replayed
}

// ─── tool actions ────────────────────────────────────────────────────────────

async function doConnect(urlParam: string | undefined) {
  runtimeContext.ensureMetadataReady()
  runtimeContext.requireSave()
  ensureI18nReady()

  const url = urlParam ?? useScannerState.getState().websocketUrl
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error(
      `scanner(action=connect):无效的 websocket 地址 ${JSON.stringify(url)} — 必须以 ws:// 或 wss:// 开头`
        + `(默认地址取 update_state(section=scanner) 的 websocketUrl,当前默认 ${DEFAULT_WEBSOCKET_URL})`,
    )
  }

  const token = ++sessionToken
  clearReconnectTimer()

  // 幂等语义:已连接同一地址 → 直接返回;已连接其他地址 → 切换到新地址
  if (connection?.url === url) {
    wantedUrl = url
    return toolResult(
      {
        action: 'connect' as const,
        connected: true,
        alreadyConnected: true,
        urlSwitched: false,
        url,
        connectedAt: connection.connectedAt,
      },
      `已连接到 ${url}(幂等:此前就在该地址上,未重连)`,
    )
  }

  let urlSwitched = false
  if (connection != null) {
    urlSwitched = true
    const previous = connection
    connection = null
    wantedUrl = null
    try {
      previous.socket.close(1000, '切换到新地址')
    } catch {
      // 已断开的 socket 无需处理
    }
    useScannerState.getState().setConnected(false)
    appendLog({ type: 'disconnect', result: 'info', bytes: 0, summary: `客户端主动断开 ${previous.url}(切换到 ${url})` })
  }

  wantedUrl = url
  let socket: WebSocket
  try {
    socket = await openSocket(url)
  } catch (e) {
    if (token === sessionToken) wantedUrl = null
    throw e
  }
  if (token !== sessionToken) {
    // 并发的 connect/disconnect 已接管:丢弃本次结果,交由后到者定夺
    try {
      socket.close()
    } catch {
      // 无需处理
    }
    throw new Error('scanner(action=connect):并发的 connect/disconnect 调用取消了本次连接,请重试')
  }
  const active = adoptSocket(url, socket, 'connect')

  return toolResult(
    {
      action: 'connect' as const,
      connected: true,
      alreadyConnected: false,
      urlSwitched,
      url,
      connectedAt: active.connectedAt,
      note: urlParam == null ? `未传 url,使用 update_state(section=scanner) 配置的 websocketUrl` : undefined,
    },
    `已连接扫描器:${url}${urlSwitched ? `(已从旧地址切换)` : ''} —— 事件帧将按当前 scanner 设置(ingest=${readSettings().ingest ? '开' : '关'})应用`,
  )
}

async function doDisconnect() {
  ++sessionToken
  clearReconnectTimer()

  const active = connection
  const wasReconnecting = active == null && wantedUrl != null
  wantedUrl = null

  if (active != null) {
    connection = null
    try {
      active.socket.close(1000, '客户端主动断开')
    } catch {
      // 已断开的 socket 无需处理
    }
    useScannerState.getState().setConnected(false)
    appendLog({ type: 'disconnect', result: 'info', bytes: 0, summary: `客户端主动断开:${active.url}(自动重连已停用)` })
  } else if (wasReconnecting) {
    appendLog({ type: 'disconnect', result: 'info', bytes: 0, summary: '已取消自动重连' })
  }

  return toolResult(
    {
      action: 'disconnect' as const,
      connected: false,
      wasConnected: active != null,
      cancelledReconnect: wasReconnecting,
    },
    active != null
      ? `已断开扫描器连接(${active.url}),自动重连已停用`
      : wasReconnecting
      ? '本就未连接(幂等):已取消挂起的自动重连'
      : '本就未连接(幂等)',
  )
}

function doStatus() {
  const active = connection
  const settings = readSettings()
  const scannerState = useScannerState.getState()
  const save = runtimeContext.getSave()

  return toolResult(
    {
      action: 'status' as const,
      connected: active != null,
      reconnecting: active == null && wantedUrl != null,
      url: active?.url ?? null,
      configuredUrl: scannerState.websocketUrl,
      defaultWebsocketUrl: DEFAULT_WEBSOCKET_URL,
      connectedAt: active?.connectedAt ?? null,
      uptimeMs: active != null ? Date.now() - active.connectedAt : null,
      reconnects: frameStats.reconnects,
      saveLoaded: save != null,
      savePath: save?.path ?? null,
      settings,
      frames: {
        received: frameStats.received,
        applied: frameStats.applied,
        ignored: frameStats.ignored,
        errored: frameStats.errored,
      },
      bytesReceived: frameStats.bytes,
      lastFrameAt,
      lastError,
      scannerCache: {
        relics: Object.keys(scannerState.relics).length,
        lightCones: Object.keys(scannerState.lightCones).length,
        characters: Object.keys(scannerState.characters).length,
        materials: Object.keys(scannerState.materials).length,
        gachaFunds: scannerState.gachaFunds != null,
      },
      eventLog: {
        size: eventLog.length,
        capacity: EVENT_LOG_CAPACITY,
        dropped: droppedLogEntries,
      },
    },
    active
      ? `扫描器已连接(${active.url},在线 ${Math.round((Date.now() - active.connectedAt) / 1000)} 秒):`
        + `累计接收 ${frameStats.received} 帧(应用 ${frameStats.applied}、忽略 ${frameStats.ignored}、出错 ${frameStats.errored}),`
        + `当前设置 ingest=${settings.ingest},ingestCharacters=${settings.ingestCharacters}`
      : wantedUrl != null
      ? `扫描器未连接,正在自动重连 ${wantedUrl}(每 ${RECONNECT_DELAY_MS}ms 一次,累计重连 ${frameStats.reconnects} 次)`
      : '扫描器未连接(调用 scanner(action=connect) 连接;默认地址取 update_state(section=scanner) 的 websocketUrl)',
  )
}

function doEvents(offsetInput: number | undefined, limitInput: number | undefined) {
  const offset = offsetInput ?? 0
  const limit = limitInput ?? EVENTS_DEFAULT_LIMIT
  if (offset > eventLog.length) {
    throw new Error(
      `scanner(action=events):offset ${offset} 超出日志范围 —— 当前日志共 ${eventLog.length} 条(最早 seq=${eventLog[0]?.seq ?? '无'}),`
        + '环形缓冲只保留最近的事件,更早的可能已被淘汰',
    )
  }
  const entries = eventLog.slice(offset, offset + limit)
  const counts: Record<string, number> = { applied: 0, ignored: 0, error: 0, info: 0 }
  for (const entry of eventLog) counts[entry.result] = (counts[entry.result] ?? 0) + 1

  return toolResult(
    {
      action: 'events' as const,
      offset,
      limit,
      total: eventLog.length,
      dropped: droppedLogEntries,
      counts,
      entries: entries.map((entry) => ({
        seq: entry.seq,
        at: entry.at,
        type: entry.type,
        result: entry.result,
        bytes: entry.bytes,
        summary: entry.summary,
        ...(entry.detail != null ? { detail: entry.detail } : {}),
        ...(entry.error != null ? { error: entry.error } : {}),
      })),
    },
    `事件日志 ${entries.length}/${eventLog.length} 条(offset=${offset},limit=${limit};`
      + `累计已淘汰 ${droppedLogEntries} 条):应用 ${counts.applied ?? 0}、忽略 ${counts.ignored ?? 0}、错误 ${counts.error ?? 0}、连接事件 ${counts.info ?? 0}`,
  )
}

// ─── tool registration ───────────────────────────────────────────────────────

const ACTIONS = ['connect', 'disconnect', 'status', 'events'] as const
type ScannerAction = (typeof ACTIONS)[number]

const ACTION_PARAM_ALLOWLIST: Record<ScannerAction, ReadonlySet<string>> = {
  connect: new Set(['url']),
  disconnect: new Set([]),
  status: new Set([]),
  events: new Set(['offset', 'limit']),
}

const frameLogEntrySchema = z.object({
  seq: z.number().int(),
  at: z.number().int(),
  type: z.string(),
  result: z.enum(['applied', 'ignored', 'error', 'info']),
  bytes: z.number().int(),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
})

export function registerScannerTools(server: McpServer): void {
  server.registerTool('scanner', {
    title: '实时扫描器客户端',
    description: '作为 websocket 客户端连接真实扫描器(Reliquary Archiver 等),把推送的事件帧按网页端「导入」页同一条导入链应用进当前存档 —— '
      + '对应网页端「实时导入控制」的客户端一侧(方向与 sync_bridge_* 相反:这里是 MCP 主动连出去当客户端)。'
      + 'action=connect:连接(默认地址取 update_state(section=scanner) 的 websocketUrl,默认 ws://127.0.0.1:23313/ws;也可显式传 url);'
      + '幂等语义:已连接同一地址时直接返回 alreadyConnected=true,已连接其他地址时切换到新地址;地址不可达时返回明确的中文失败原因。'
      + '意外断开后每秒自动重连(disconnect 后停止);连接/断开会像网页端一样清空扫描缓存,因此重连后 DeleteRelics 只对新一轮缓存里的遗器生效。'
      + 'action=disconnect:主动断开,未连接时幂等(同时取消挂起的自动重连)。'
      + 'action=status:连接状态/地址/在线时长/累计帧统计(接收/应用/忽略/出错)/最近错误/扫描缓存概况(只读,不递增 revision)。'
      + 'action=events(offset,limit):查询事件日志环形缓冲(上限 500 条,含帧类型/时间/应用结果摘要;连接生命周期也记入)。'
      + '事件应用语义(受 update_state(section=scanner) 的四个 ingest 开关控制,改动从下一帧起生效、不回放):'
      + 'InitialScan 按 import_scanner_json 的 union 并集链整库并入(角色等级统一 80,ingestCharacters 关闭时不导入角色);'
      + 'UpdateRelics 仅 5★ 落库,已有遗器在 ingestCharacters 关闭时保留原佩戴者;UpdateCharacters 需 ingest 与 ingestCharacters 同开;'
      + 'DeleteRelics 仅删除 5★ 且以帧内 _uid 定位;UpdateLightCones/UpdateMaterials 只进扫描缓存;'
      + 'UpdateGachaFunds 在 ingest 与 ingestWarpResources 同开时把 星琼+古老梦华 写入跃迁规划底稿;'
      + 'GachaResult 按设计忽略(MCP 不记录抽卡历史);畸形 JSON 帧只记日志、不断连接。'
      + '写帧经事务协调器提交(标签 scanner:帧类型):成功递增 revision、1 秒防抖落盘,失败整体回滚且保持连接。connect 需先 load_save。',
    inputSchema: {
      action: z.enum(ACTIONS).describe('connect=连接扫描器,disconnect=断开,status=查连接与统计,events=查事件日志'),
      url: z.string().min(1).optional().describe(
        '仅 action=connect:目标 websocket 地址(如 ws://127.0.0.1:23313/ws);缺省用 update_state(section=scanner) 配置的 websocketUrl',
      ),
      offset: z.number().int().min(0).optional().describe('仅 action=events:日志起始下标(按时间升序,默认 0)'),
      limit: z.number().int().min(1).max(EVENTS_MAX_LIMIT).optional().describe('仅 action=events:返回条数上限(默认 50,最大 500)'),
    },
    outputSchema: {
      action: z.enum(ACTIONS),
      // connect / disconnect / status / events 各分支字段(只出现对应分支的子集)
      connected: z.boolean().optional(),
      alreadyConnected: z.boolean().optional(),
      urlSwitched: z.boolean().optional(),
      wasConnected: z.boolean().optional(),
      cancelledReconnect: z.boolean().optional(),
      note: z.string().optional(),
      url: z.string().nullable().optional(),
      configuredUrl: z.string().optional(),
      defaultWebsocketUrl: z.string().optional(),
      connectedAt: z.number().int().nullable().optional(),
      uptimeMs: z.number().int().nullable().optional(),
      reconnecting: z.boolean().optional(),
      reconnects: z.number().int().optional(),
      saveLoaded: z.boolean().optional(),
      savePath: z.string().nullable().optional(),
      settings: z.object({
        ingest: z.boolean(),
        ingestCharacters: z.boolean(),
        ingestOnlyExistingCharacters: z.boolean(),
        ingestWarpResources: z.boolean(),
      }).optional(),
      frames: z.object({
        received: z.number().int(),
        applied: z.number().int(),
        ignored: z.number().int(),
        errored: z.number().int(),
      }).optional(),
      bytesReceived: z.number().int().optional(),
      lastFrameAt: z.number().int().nullable().optional(),
      lastError: z.object({
        at: z.number().int(),
        message: z.string(),
      }).nullable().optional(),
      scannerCache: z.object({
        relics: z.number().int(),
        lightCones: z.number().int(),
        characters: z.number().int(),
        materials: z.number().int(),
        gachaFunds: z.boolean(),
      }).optional(),
      eventLog: z.object({
        size: z.number().int(),
        capacity: z.number().int(),
        dropped: z.number().int(),
      }).optional(),
      offset: z.number().int().optional(),
      limit: z.number().int().optional(),
      total: z.number().int().optional(),
      dropped: z.number().int().optional(),
      counts: z.record(z.string(), z.number().int()).optional(),
      entries: z.array(frameLogEntrySchema).optional(),
    },
  }, async (input) => {
    const action: ScannerAction = input.action
    const allowed = ACTION_PARAM_ALLOWLIST[action]
    const extraParams = Object.keys(input).filter((key) => key !== 'action' && !allowed.has(key))
    if (extraParams.length > 0) {
      throw new Error(
        `scanner(action=${action}):参数 ${extraParams.map((key) => `"${key}"`).join(', ')} 不适用于该 action —— `
          + `action=${action} 只接受:${['action', ...allowed].join(' / ')}`,
      )
    }

    switch (action) {
      case 'connect':
        return doConnect(input.url)
      case 'disconnect':
        return doDisconnect()
      case 'status':
        return doStatus()
      case 'events':
        return doEvents(input.offset, input.limit)
    }
  })
}
