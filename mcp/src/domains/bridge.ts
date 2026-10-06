// Bridge domain: 伪 Reliquary Archiver websocket 服务(「同步桥」)。
//
// 定位(方案 §6.3):仅是「MCP → 网页端」的便利推送通道 —— 把当前已载入的存档
// 伪装成一份 Reliquary Archiver v4 全量扫描结果(InitialScan)推给网页端「导入」页
// 的实时导入功能,让它像连上真扫描器一样把数据吃进来;正式的数据回流路径仍然是
// 网页端导出存档 → load_save。
//
// 协议与上游严格同源(字段语义全部对照 src/lib/importer/kelzFormatParser.tsx):
//   - 帧为 {event, data} JSON 文本;事件联合见 scannerStore.ts:413 ScannerEvent
//   - 网页端客户端(ScannerWebsocketClient.tsx)不发握手:一连上(含断线重连 ——
//     重连会清空其缓冲)就期望服务端立即推 InitialScan,因此每个连接建立时推一次
//     全量;此后每次存档变更(bridgeNotifyChange)向所有在线客户端重推全量 ——
//     幂等全量合并天然规避了增量 UpdateRelics 在线落库只认 5★ 的限制
//   - source 必须是 'reliquary_archiver'、version 必须是 4,否则网页端解析器直接
//     抛错(importConfig.ts ReliquaryArchiverConfig)
//   - 副词条 count/step 是 reliquary 的 speedVerified 口径:count = 词条总 roll 数,
//     step 按 rollCounter(characterConverter.ts:239)编码逆推 = mid + 2 * high。
//     该编码保留 (count, step),网页端按 0.8/0.9/1.0 roll 模型重算的数值与存档一致
//     (validatedRolls 通过);roll 分布存在歧义时其展示的 high/mid/low 拆分取贪心重推
//     —— 与真实扫描器帧的行为一致,不影响数值与优化结果
//   - 在 MCP 侧删除的遗器先发 DeleteRelics(此时网页端仍持有旧清单,删除才能落到
//     其数据库,见 scannerStore.ts:588 handleDeleteRelic)再发 InitialScan
//
// stdout 被 MCP 协议独占:所有日志走 console.error(垫片已重定向到 stderr)。

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  Parts,
  Stats,
} from 'lib/constants/constants'
import type {
  MainStats,
  SubStats,
} from 'lib/constants/constants'
import { ReliquaryArchiverConfig } from 'lib/importer/importConfig'
import type {
  ScannerParserJson,
  V4ParserCharacter,
  V4ParserLightCone,
  V4ParserRelic,
  V4ParserSubstat,
} from 'lib/importer/kelzFormatParser'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import type { CharacterId } from 'types/character'
import type {
  Relic,
  RelicSubstatMetadata,
} from 'types/relic'
import {
  WebSocket,
  WebSocketServer,
} from 'ws'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { toolResult } from '../toolResult'

const BRIDGE_HOST = '127.0.0.1'
const BRIDGE_DEFAULT_PORT = 23313

// 扫描器主词条字符串(非头/手部位)—— kelzFormatParser.tsx:447 mainStatLookup 的反向表。
// 头/手的主词条是固定白值(HP/ATK),网页端按部位推导(parseMainStat),无需查表。
const MAINSTAT_TO_SCANNER_KEY: Partial<Record<MainStats, string>> = {
  [Stats.HP_P]: 'HP',
  [Stats.ATK_P]: 'ATK',
  [Stats.DEF_P]: 'DEF',
  [Stats.SPD]: 'SPD',
  [Stats.CR]: 'CRIT Rate',
  [Stats.CD]: 'CRIT DMG',
  [Stats.EHR]: 'Effect Hit Rate',
  [Stats.BE]: 'Break Effect',
  [Stats.ERR]: 'Energy Regeneration Rate',
  [Stats.OHB]: 'Outgoing Healing Boost',
  [Stats.Physical_DMG]: 'Physical DMG Boost',
  [Stats.Fire_DMG]: 'Fire DMG Boost',
  [Stats.Ice_DMG]: 'Ice DMG Boost',
  [Stats.Lightning_DMG]: 'Lightning DMG Boost',
  [Stats.Wind_DMG]: 'Wind DMG Boost',
  [Stats.Quantum_DMG]: 'Quantum DMG Boost',
  [Stats.Imaginary_DMG]: 'Imaginary DMG Boost',
}

// 扫描器副词条字符串 —— kelzFormatParser.tsx:428 substatLookup 的反向表
// (百分比词条带尾下划线:'ATK_' ↔ 'ATK%')。
const SUBSTAT_TO_SCANNER_KEY: Partial<Record<SubStats, string>> = {
  [Stats.ATK]: 'ATK',
  [Stats.HP]: 'HP',
  [Stats.DEF]: 'DEF',
  [Stats.ATK_P]: 'ATK_',
  [Stats.HP_P]: 'HP_',
  [Stats.DEF_P]: 'DEF_',
  [Stats.SPD]: 'SPD',
  [Stats.CR]: 'CRIT Rate_',
  [Stats.CD]: 'CRIT DMG_',
  [Stats.EHR]: 'Effect Hit Rate_',
  [Stats.RES]: 'Effect RES_',
  [Stats.BE]: 'Break Effect_',
}

// 强化版角色 id 形如 `${4位id}b${版本}`(kelzFormatParser.tsx:235 buffedCharacters)。
const BUFFED_ID_PATTERN = /^(\d{4})b(\d+)$/

type InitialScanFrame = {
  frame: ScannerParserJson,
  /** 本帧全部遗器 _uid(删除差量与幂等重推都按它对账) */
  uids: Set<string>,
  bytes: number,
  warnings: string[],
}

type BridgeClient = {
  socket: WebSocket,
  /** 该客户端上一帧收到的遗器 _uid 集合;null = 尚未收到过全量(不做删除差量) */
  lastPushedUids: Set<string> | null,
}

type ActiveBridge = {
  port: number,
  server: WebSocketServer,
  clients: Set<BridgeClient>,
}

let bridge: ActiveBridge | null = null
let pushCount = 0
let lastPushAt: number | null = null
let lastPushBytes = 0
// ageIndex 缺失时兜底的数字 uid(网页端用 parseInt(_uid) 当 ageIndex,uid 必须是数字串);
// 起点远大于任何真实 ageIndex,避免与持久化的 ageIndex 撞号。
const syntheticUidByRelicId = new Map<string, string>()
let nextSyntheticUid = 900_000_001

/**
 * 库存/装备变更通知入口 —— 请集成层在 mcp/src/context.ts 的 flushSave 成功写回后
 * 调用(try/catch 非阻塞)。向所有在线客户端重推全量 InitialScan;未启动或无客户端
 * 时是幂等空操作,绝不抛错。
 */
export function bridgeNotifyChange(): void {
  try {
    if (bridge == null || bridge.clients.size === 0) return
    broadcastFullFrame()
  } catch (e) {
    console.error(`[bridge] 变更推送失败: ${String(e)}`)
  }
}

/**
 * 干净关闭监听(供 server 进程退出钩子接线,参考 mcp/src/index.ts 的退出处理)。
 * 同步尽力而为:先断开全部客户端再关监听。
 */
export function closeBridge(): void {
  const active = bridge
  if (active == null) return
  bridge = null
  for (const client of active.clients) {
    try {
      client.socket.terminate()
    } catch {
      // 已断开的 socket 无需处理
    }
  }
  active.clients.clear()
  try {
    active.server.close(() => {})
  } catch {
    // 监听已关闭时无需处理
  }
  console.error(`[bridge] 同步桥已关闭(端口 ${active.port})`)
}

function bridgeUrl(port: number): string {
  return `ws://${BRIDGE_HOST}:${port}/ws`
}

// ─── 存档 → 扫描器帧序列化 ───────────────────────────────────────────────────

/** 扫描器角色 id + ability_version(网页端按它决定落到强化版还是原版角色)。 */
function scannerCharacterId(id: CharacterId): { id: string, abilityVersion: number } {
  const match = BUFFED_ID_PATTERN.exec(id)
  if (match) return { id: match[1], abilityVersion: Number(match[2]) }
  // 原版角色必须显式 ability_version: 0 —— 缺省时网页端会把存在强化版的角色自动映射到强化版
  // (kelzFormatParser.tsx:248 getMappedCharacterId)
  return { id, abilityVersion: 0 }
}

/** 突破等级仅用于帧形状完整,网页端解析器不读取该字段。 */
function ascensionForLevel(level: number): number {
  return Math.min(6, Math.max(0, Math.floor((level || 1) / 10) - 1))
}

/** 副词条 → {key, value, count, step};count/step 编码见文件头注释。 */
function scannerSubstat(substat: RelicSubstatMetadata, grade: number): V4ParserSubstat | null {
  const key = SUBSTAT_TO_SCANNER_KEY[substat.stat]
  if (key == null) return null

  const rolls = substat.rolls
  const rawCount = rolls ? rolls.high + rolls.mid + rolls.low : (substat.addedRolls ?? 0) + 1
  const rawStep = rolls ? rolls.mid + 2 * rolls.high : 0

  // 网页端校验(kelzFormatParser.tsx:392):0 < count <= max(1, rarity*2-4) 且
  // 0 <= step <= 2*count,越界会触发「扫描器文件已过时」警告 —— 防御性收敛。
  const count = Math.min(Math.max(Math.round(rawCount), 1), Math.max(1, grade * 2 - 4))
  const step = Math.min(Math.max(Math.round(rawStep), 0), 2 * count)
  return { key, value: substat.value, count, step }
}

function scannerMainstatKey(relic: Relic): string | null {
  if (relic.part === Parts.Head || relic.part === Parts.Hands) return relic.main.stat
  return MAINSTAT_TO_SCANNER_KEY[relic.main.stat] ?? null
}

/** 稳定数字 uid:优先用持久化的 ageIndex,缺失/撞号时按 relic id 兜底生成。 */
function stableRelicUid(relic: Relic, used: Set<string>): string {
  let uid = relic.ageIndex != null && Number.isInteger(relic.ageIndex) && !used.has(String(relic.ageIndex))
    ? String(relic.ageIndex)
    : null
  if (uid == null) {
    let cached = syntheticUidByRelicId.get(relic.id)
    if (cached == null || used.has(cached)) {
      do {
        cached = String(nextSyntheticUid++)
      } while (used.has(cached))
      syntheticUidByRelicId.set(relic.id, cached)
    }
    uid = cached
  }
  used.add(uid)
  return uid
}

/**
 * 把当前 store 状态序列化为一份完整的 reliquary v4 InitialScan。
 * 主词条数值不在帧内 —— 网页端按 部位+稀有度+等级 从词条表重算(readRelicStats)。
 */
function buildInitialScanData(): InitialScanFrame {
  runtimeContext.ensureMetadataReady()
  const metadata = getGameMetadata()

  const setNameToId = new Map<string, string>()
  for (const set of Object.values(metadata.relics.relicSets)) setNameToId.set(set.name, set.id)

  const warnings: string[] = []

  const characters: V4ParserCharacter[] = []
  const lightCones: V4ParserLightCone[] = []
  for (const character of getCharacters()) {
    const form = character.form
    const scannerId = scannerCharacterId(form.characterId)
    const characterMeta = metadata.characters[form.characterId]
    characters.push({
      id: scannerId.id,
      name: characterMeta?.name ?? scannerId.id,
      path: characterMeta?.path ?? '',
      level: form.characterLevel,
      ascension: ascensionForLevel(form.characterLevel),
      eidolon: form.characterEidolon,
      ability_version: scannerId.abilityVersion,
    })

    if (form.lightCone) {
      // 网页端按 location === 角色 id 匹配光锥(readCharacter);location 必须是上面
      // characters[].id 用的扫描器 id(强化版角色的基础 id)。
      const lightConeMeta = metadata.lightCones[form.lightCone]
      lightCones.push({
        id: form.lightCone,
        name: lightConeMeta?.name ?? form.lightCone,
        level: form.lightConeLevel,
        ascension: ascensionForLevel(form.lightConeLevel),
        superimposition: form.lightConeSuperimposition,
        location: scannerId.id,
        lock: false,
        _uid: `${scannerId.id}-lc`,
      })
    }
  }

  const relics: V4ParserRelic[] = []
  const uids = new Set<string>()
  for (const relic of getRelics()) {
    const setId = setNameToId.get(relic.set)
    if (setId == null) {
      warnings.push(`遗器 ${relic.id}:套装 ${relic.set} 不在游戏数据中,已跳过`)
      continue
    }
    const mainstat = scannerMainstatKey(relic)
    if (mainstat == null) {
      warnings.push(`遗器 ${relic.id}:主属性 ${relic.main.stat} 无法映射到扫描器格式,已跳过`)
      continue
    }

    const substats: V4ParserSubstat[] = []
    for (const substat of relic.substats) {
      const mapped = scannerSubstat(substat, relic.grade)
      if (mapped == null) {
        warnings.push(`遗器 ${relic.id}:副词条 ${substat.stat} 无法映射,该词条已跳过`)
        continue
      }
      substats.push(mapped)
    }

    relics.push({
      set_id: setId,
      name: relic.set,
      slot: relic.part,
      rarity: relic.grade,
      level: relic.enhance,
      mainstat,
      substats,
      location: relic.equippedBy ?? '',
      // 优化器存档不追踪遗器锁定/弃置状态,固定 false
      lock: false,
      discard: false,
      _uid: stableRelicUid(relic, uids),
    })
  }

  const frame: ScannerParserJson = {
    source: ReliquaryArchiverConfig.sourceString,
    // build 恰为最新版号,避免网页端的「扫描器版本过时」警告
    build: ReliquaryArchiverConfig.latestBuildVersion,
    version: ReliquaryArchiverConfig.latestOutputVersion,
    // 存档不追踪开拓者信息/抽卡资源:用解析器默认值兜底,跃迁资源与材料恒为空
    metadata: { uid: 0, trailblazer: 'Stelle' },
    gacha: { stellar_jade: 0, oneric_shards: 0 },
    materials: [],
    characters,
    light_cones: lightCones,
    relics,
  }

  if (warnings.length > 0) {
    console.error(`[bridge] 序列化跳过 ${warnings.length} 项: ${warnings.join('; ')}`)
  }

  return { frame, uids, bytes: JSON.stringify(frame).length, warnings }
}

// ─── websocket 服务与推送 ────────────────────────────────────────────────────

function sendJson(client: BridgeClient, payload: unknown): boolean {
  if (client.socket.readyState !== WebSocket.OPEN) return false
  try {
    client.socket.send(JSON.stringify(payload), (error) => {
      if (error) console.error(`[bridge] 发送失败: ${String(error)}`)
    })
    return true
  } catch (e) {
    console.error(`[bridge] 发送异常: ${String(e)}`)
    return false
  }
}

/** 向单个客户端推全量:先补删除差量(仅对收到过上一帧的客户端),再发 InitialScan。 */
function sendFullFrameToClient(client: BridgeClient, scan: InitialScanFrame): boolean {
  if (client.lastPushedUids != null) {
    const deleted = Array.from(client.lastPushedUids).filter((uid) => !scan.uids.has(uid))
    if (deleted.length > 0) sendJson(client, { event: 'DeleteRelics', data: deleted })
  }
  const sent = sendJson(client, { event: 'InitialScan', data: scan.frame })
  // uids 集合构建后只读,跨客户端共享是安全的
  client.lastPushedUids = scan.uids
  if (sent) {
    pushCount++
    lastPushAt = Date.now()
    lastPushBytes = scan.bytes
  }
  return sent
}

function broadcastFullFrame(): { scan: InitialScanFrame, clients: number, sent: number } {
  const scan = buildInitialScanData()
  const active = bridge
  if (active == null) return { scan, clients: 0, sent: 0 }

  let sent = 0
  for (const client of active.clients) {
    if (sendFullFrameToClient(client, scan)) sent++
  }
  return { scan, clients: active.clients.size, sent }
}

function startBridge(port: number): Promise<ActiveBridge> {
  return new Promise((resolve, reject) => {
    let listening = false
    const server = new WebSocketServer({ host: BRIDGE_HOST, port })
    const active: ActiveBridge = { port, server, clients: new Set() }

    server.on('listening', () => {
      listening = true
      bridge = active
      console.error(`[bridge] 同步桥已启动:${bridgeUrl(port)}(监听 ${BRIDGE_HOST}:${port},任意路径)`)
      resolve(active)
    })

    server.on('error', (error) => {
      if (!listening) {
        try {
          server.close(() => {})
        } catch {
          // 从未成功监听,无需处理
        }
        reject(
          new Error(
            `同步桥监听 ${BRIDGE_HOST}:${port} 失败:${error.message}`
              + `(端口被占用?请检查本机是否正在运行真实的 Reliquary Archiver 或另一个同步桥实例,或换一个端口重试)`,
          ),
        )
        return
      }
      console.error(`[bridge] 服务出错,关闭监听: ${String(error)}`)
      closeBridge()
    })

    server.on('close', () => {
      if (bridge === active) bridge = null
    })

    // 连接只会在 listening 之后到来,这里先行挂上处理器
    server.on('connection', (socket) => {
      const client: BridgeClient = { socket, lastPushedUids: null }
      active.clients.add(client)
      socket.on('close', () => active.clients.delete(client))
      socket.on('error', (error) => console.error(`[bridge] 客户端连接出错: ${String(error)}`))
      console.error(`[bridge] 网页端已连接(在线 ${active.clients.size})`)

      // 客户端不发握手:一连上(含断线重连)就推全量 InitialScan
      try {
        sendFullFrameToClient(client, buildInitialScanData())
      } catch (e) {
        console.error(`[bridge] 连接首次推送失败: ${String(e)}`)
      }
    })
  })
}

async function stopBridge(): Promise<boolean> {
  const active = bridge
  if (active == null) return false
  bridge = null
  for (const client of active.clients) {
    try {
      client.socket.close(1001, '同步桥已停止')
    } catch {
      // 已断开的 socket 无需处理
    }
  }
  active.clients.clear()
  await new Promise<void>((resolve) => active.server.close(() => resolve()))
  console.error(`[bridge] 同步桥已停止(端口 ${active.port})`)
  return true
}

// ─── 工具注册 ────────────────────────────────────────────────────────────────

const START_GUIDE = '使用步骤:①先 load_save 载入存档;②调用本工具启动监听;'
  + '③在网页端「导入」页 →「实时导入控制」打开开关 —— 必开「启用实时导入(推荐)」,'
  + '要同步角色及其配装再开「启用角色已装备遗器和光锥的更新」,按需开「仅更新已有角色」;'
  + '「启用跃迁资源导入」对本桥无意义(桥不推送星琼/材料),可保持关闭。'
  + '高级设置中的 Websocket 地址保持默认 ws://127.0.0.1:23313/ws 即可(本服务接受任意路径)。'

const BEHAVIOR_NOTES = '行为:网页端一连上立即收到全量 InitialScan(断线重连同样重发);'
  + '此后每次存档变更自动向所有在线客户端重推全量(幂等合并,天然规避网页端增量落库只认 5★ 的限制);'
  + '在 MCP 侧删除的遗器会以 DeleteRelics 事件先于全量帧同步删除。'
  + '注意:①网页端开启角色更新开关后,会把导入的角色统一按 80 级/光锥 80 级落库(上游 scannerStore 的固定行为),'
  + '桥按存档原等级发送、最终以 80 级为准;②优化器不追踪遗器锁定状态,帧内 lock 恒为 false;'
  + '③正式的数据回流路径仍是网页端导出存档 → load_save,本桥仅为单向便利推送。'

export function registerBridgeTools(server: McpServer): void {
  server.registerTool('sync_bridge_start', {
    title: '启动同步桥(推送存档到网页端)',
    description: '启动伪 Reliquary Archiver websocket 服务(默认端口 23313,仅监听 127.0.0.1),'
      + '把 MCP 当前载入的存档推送给网页端「导入」页的实时导入(扫描器联动)功能 —— 方向为 MCP→网页 单向便利推送。'
      + START_GUIDE + BEHAVIOR_NOTES,
    inputSchema: {
      port: z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT).describe('监听端口,默认 23313(网页端默认 Websocket 地址指向它)'),
    },
    // 已在运行(幂等返回)与本次启动两种形状:restarted 仅新启动分支携带
    outputSchema: {
      running: z.boolean(),
      alreadyRunning: z.boolean(),
      restarted: z.boolean().optional(),
      port: z.number().int(),
      url: z.string(),
      clients: z.number().int(),
      relics: z.number().int(),
      characters: z.number().int(),
    },
  }, async ({ port }) => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    let restarted = false
    if (bridge != null) {
      if (bridge.port === port) {
        return toolResult(
          {
            running: true,
            alreadyRunning: true,
            port,
            url: bridgeUrl(port),
            clients: bridge.clients.size,
            relics: getRelics().length,
            characters: getCharacters().length,
          },
          `同步桥已在端口 ${port} 运行(在线客户端 ${bridge.clients.size} 个),无需重复启动`,
        )
      }
      await stopBridge()
      restarted = true
    }

    await startBridge(port)

    return toolResult(
      {
        running: true,
        alreadyRunning: false,
        restarted,
        port,
        url: bridgeUrl(port),
        clients: 0,
        relics: getRelics().length,
        characters: getCharacters().length,
      },
      `同步桥已启动:${bridgeUrl(port)} —— 请在网页端「导入」页打开「实时导入控制」的开关(至少开启「启用实时导入」),网页端连接后即收到全量数据`,
    )
  })

  server.registerTool('sync_bridge_status', {
    title: '同步桥状态',
    description: '报告同步桥(伪 Reliquary Archiver websocket 服务)的运行状况:监听端口与地址、'
      + '在线网页端客户端数、累计/最近一次全量推送统计、当前可推送的遗器与角色数量。',
    inputSchema: {},
    outputSchema: {
      running: z.boolean(),
      port: z.number().int().nullable(),
      url: z.string().nullable(),
      clients: z.number().int(),
      pushes: z.number().int(),
      lastPushAt: z.number().nullable(),
      lastPushBytes: z.number().int(),
      saveLoaded: z.boolean(),
      savePath: z.string().nullable(),
      relics: z.number().int(),
      characters: z.number().int(),
    },
  }, async () => {
    const active = bridge
    const save = runtimeContext.getSave()
    return toolResult(
      {
        running: active != null,
        port: active?.port ?? null,
        url: active ? bridgeUrl(active.port) : null,
        clients: active?.clients.size ?? 0,
        pushes: pushCount,
        lastPushAt,
        lastPushBytes,
        saveLoaded: save != null,
        savePath: save?.path ?? null,
        relics: getRelics().length,
        characters: getCharacters().length,
      },
      active
        ? `同步桥运行中(${
          bridgeUrl(active.port)
        }):在线客户端 ${active.clients.size} 个,已推送 ${pushCount} 次,待推遗器 ${getRelics().length} 件、角色 ${getCharacters().length} 个`
        : '同步桥未启动(调用 sync_bridge_start 启动)',
    )
  })

  server.registerTool('sync_bridge_stop', {
    title: '停止同步桥',
    description: '停止伪 Reliquary Archiver websocket 服务并断开所有网页端客户端 —— 对应网页端断开实时导入连接的反向操作。'
      + '未启动时调用是幂等空操作。停止后网页端的「实时导入」会显示已断开。',
    inputSchema: {},
    outputSchema: {
      stopped: z.boolean(),
      wasRunning: z.boolean(),
      running: z.boolean(),
    },
  }, async () => {
    const stopped = await stopBridge()
    return toolResult(
      { stopped: true, wasRunning: stopped, running: false },
      stopped ? '同步桥已停止,所有客户端已断开' : '同步桥本就未启动(幂等)',
    )
  })

  server.registerTool('sync_bridge_push', {
    title: '手动推送全量数据',
    description: '立即把当前存档全量重推给所有在线网页端客户端(InitialScan),不等待下一次存档变更 —— '
      + '对应网页端实时导入收到一份新的完整扫描。变更驱动的自动推送由存档写回触发;本工具用于手动校准/补推。'
      + '未启动同步桥或无在线客户端时仍会完成一次序列化(顺带校验帧),并在结果里说明送达情况。',
    inputSchema: {},
    outputSchema: {
      pushed: z.boolean(),
      clients: z.number().int(),
      sent: z.number().int(),
      bytes: z.number().int(),
      relics: z.number().int(),
      characters: z.number().int(),
      lightCones: z.number().int(),
      skippedItems: z.number().int(),
      warnings: z.array(z.string()),
    },
  }, async () => {
    runtimeContext.ensureMetadataReady()
    runtimeContext.requireSave()

    if (bridge == null) {
      throw new Error('同步桥未启动 —— 请先调用 sync_bridge_start')
    }

    const { scan, clients, sent } = broadcastFullFrame()
    const skipped = scan.warnings.length
    return toolResult(
      {
        pushed: true,
        clients,
        sent,
        bytes: scan.bytes,
        relics: scan.frame.relics.length,
        characters: scan.frame.characters.length,
        lightCones: scan.frame.light_cones.length,
        skippedItems: skipped,
        warnings: scan.warnings,
      },
      `已向 ${sent}/${clients} 个在线客户端推送全量(遗器 ${scan.frame.relics.length} 件、角色 ${scan.frame.characters.length} 个,${scan.bytes} 字节)`
        + (clients === 0 ? ' —— 当前无在线客户端,请确认网页端「实时导入」开关已打开' : '')
        + (skipped > 0 ? `;${skipped} 项因无法映射被跳过(详见 warnings)` : ''),
    )
  })
}
