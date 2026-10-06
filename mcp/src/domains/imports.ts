// Imports domain: scanner JSON and HoYoLAB battle-record exports.
//
// Mirrors the web app's Import tab (ScannerImportSubmenu): parse the upload
// with the upstream parsers (KelzFormatParser instances for HSR-Scanner /
// Reliquary Archiver / Yas, hoyolabParser for HoYoLAB exports), force imported
// character/light-cone levels to 80 exactly like the confirm step does, then
// persist through persistenceService.mergeRelics + markDirty.
//
// CRITICAL semantic note: upstream mergeRelics is a FULL-INVENTORY REPLACE.
// Its `replacementRelics` list only ever contains relics that appear in the
// imported batch (plus the store entries they hash-match); existing relics NOT
// covered by the import are silently dropped. The web UI gets away with it
// because a scanner export contains the player's entire inventory. For MCP we
// expose two modes:
//   - union (default): wrap the upstream call — bucket the current inventory
//     by relic hash, consume one bucket entry per matching imported relic, and
//     re-attach every uncovered existing relic to the write list, so the
//     upstream replace path receives the true union. A guard rejects the write
//     when the synthesized list is somehow smaller than the inventory.
//   - replace: the raw upstream behavior — inventory becomes the import,
//     uncovered relics are discarded (character-only imports keep the relics).
//
// Hash-match behavior (both modes, decided inside mergeRelics): a matching
// import takes over the store entry's identity; verified imports (reliquary)
// overwrite substats/previewSubstats/augmentedStats and set verified, otherwise
// only equippedBy/ageIndex may change; character equipment and saved-build
// relic id references are re-linked. Import-layer stats (added/updated/skipped)
// replay exactly those rules, so they report what the persisted merge did.

import {
  existsSync,
  readFileSync,
} from 'node:fs'
import {
  isAbsolute,
  resolve,
} from 'node:path'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { hoyolabParser } from 'lib/importer/hoyoLabFormatParser'
import type { HoyolabData } from 'lib/importer/hoyoLabFormatParser'
import {
  KelzScannerConfig,
  ReliquaryArchiverConfig,
  ScannerSourceToParser,
  ValidScannerSources,
  YasScannerConfig,
} from 'lib/importer/importConfig'
import type {
  KelzFormatParser,
  ScannerParserJson,
} from 'lib/importer/kelzFormatParser'
import { hashRelic } from 'lib/relics/relicUtils'
import * as persistenceService from 'lib/services/persistenceService'
import { getCharacterById } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import { isVersionOutdated } from 'lib/utils/miscUtils'
import type { Form } from 'types/form'
import type { Relic } from 'types/relic'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { ensureI18nReady } from '../i18n/i18nNode'
import { toolResult } from '../toolResult'

type MergeMode = 'union' | 'replace'
type ScannerAlias = 'kelz' | 'reliquary' | 'yas'

const SCANNER_ALIAS_TO_SOURCE_STRING: Record<ScannerAlias, string> = {
  kelz: KelzScannerConfig.sourceString,
  reliquary: ReliquaryArchiverConfig.sourceString,
  yas: YasScannerConfig.sourceString,
}

// ─── input loading ─────────────────────────────────────────────

function parseJsonText(text: string, origin: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${origin} 不是合法 JSON:${(e as Error).message}`)
  }
}

function readImportPayload(path: string | undefined, inline: unknown, kind: string): unknown {
  if ((path == null) === (inline == null)) {
    throw new Error(`path 与 inline 必须二选一:提供${kind}的文件路径,或直接内联其 JSON 内容`)
  }
  if (path != null) {
    const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path)
    if (!existsSync(resolved)) {
      throw new Error(`导入文件不存在:${resolved}`)
    }
    return parseJsonText(readFileSync(resolved, 'utf8'), resolved)
  }
  if (typeof inline === 'string') return parseJsonText(inline, 'inline JSON 字符串')
  if (typeof inline === 'object' && inline !== null) return inline
  throw new Error('inline 必须是 JSON 对象或 JSON 字符串')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeHoyolabExport(json: unknown): boolean {
  return isPlainObject(json) && isPlainObject(json.data) && Array.isArray(json.data.avatar_list)
}

// ─── parsing (upstream parsers, web-UI parity) ─────────────────

type ParsedImport = {
  source: string,
  relics: Relic[],
  characters: Form[],
  metadata: Record<string, unknown>,
  warnings: string[],
}

function parseScannerJson(json: unknown, source: ScannerAlias | 'auto'): ParsedImport {
  if (!isPlainObject(json)) {
    throw new Error('扫描器 JSON 必须是一个 JSON 对象(HSRScanData.json / archiver_output.json / hsr.json 的顶层内容)')
  }
  if (looksLikeHoyolabExport(json)) {
    throw new Error('检测到的是 Hoyolab 战绩导出(含 data.avatar_list),请改用 import_hoyolab 工具导入')
  }

  // Pre-flight only what upstream parse() would crash on instead of erroring
  // (it dereferences json.metadata directly and maps relics/characters).
  if (json.metadata == null || typeof json.metadata !== 'object') {
    throw new Error('扫描器 JSON 缺少 metadata 对象(uid/trailblazer 等字段所在),请确认文件来自扫描器导出且未被删改')
  }
  if (json.relics != null && !Array.isArray(json.relics)) {
    throw new Error('扫描器 JSON 的 relics 字段必须是数组')
  }
  if (json.characters != null && !Array.isArray(json.characters)) {
    throw new Error('扫描器 JSON 的 characters 字段必须是数组')
  }

  const parser = source === 'auto' ? autoDetectScannerParser(json) : ScannerSourceToParser[SCANNER_ALIAS_TO_SOURCE_STRING[source]]

  let parsed
  try {
    // Upstream parse() strictly validates source string and output version,
    // throwing localized (zh_CN) errors from the importSaveTab namespace.
    parsed = parser.parse(json as unknown as ScannerParserJson)
  } catch (e) {
    if (e instanceof Error && e.message) throw e
    throw new Error(`解析扫描器 JSON 失败:${String(e)}`)
  }

  const warnings: string[] = []
  const buildVersion = (typeof json.build === 'string' && json.build) || 'v0.0.0'
  if (isVersionOutdated(buildVersion, parser.config.latestBuildVersion)) {
    warnings.push(
      `扫描器版本 ${buildVersion} 已过时(最新 ${parser.config.latestBuildVersion}),可能导致导入数据不正确${
        parser.config.releases ? `,请从 ${parser.config.releases} 更新` : ''
      }`,
    )
  }
  if (parser.badRollInfo) {
    warnings.push('扫描器数据包含无效的副词条 roll 信息(计数/步进缺失或越界),相关遗器按未验证数值导入')
  }

  return {
    source: parser.config.sourceString,
    relics: parsed.relics,
    characters: parsed.characters,
    metadata: {
      scanner: parser.config.name,
      source: parser.config.sourceString,
      build: typeof json.build === 'string' ? json.build : null,
      version: json.version ?? null,
      uid: (json.metadata as { uid?: unknown }).uid ?? null,
      trailblazer: parsed.metadata.trailblazer,
      currentTrailblazerPath: parsed.metadata.current_trailblazer_path,
    },
    warnings,
  }
}

function autoDetectScannerParser(json: Record<string, unknown>): KelzFormatParser {
  if (typeof json.source === 'string' && (ValidScannerSources as string[]).includes(json.source)) {
    return ScannerSourceToParser[json.source]
  }
  throw new Error(
    `无法识别的扫描器 JSON:source=${JSON.stringify(json.source) ?? '缺失'}。支持 HSR-Scanner(v4)/ reliquary_archiver(v4)/ yas-scanner(v3);`
      + '若文件确属其一请检查内容是否完整,或显式传 source 指定解析器',
  )
}

function parseHoyolabJson(json: unknown): ParsedImport {
  if (isPlainObject(json) && typeof json.source === 'string') {
    throw new Error(`检测到的是扫描器导出(source=${json.source}),请改用 import_scanner_json 工具导入`)
  }
  if (!looksLikeHoyolabExport(json)) {
    throw new Error('不是 Hoyolab 战绩导出格式:缺少 data.avatar_list 数组(内容应来自 HoYoLAB 网页端角色战绩页的导出)')
  }

  let out
  try {
    out = hoyolabParser(json as unknown as HoyolabData)
  } catch (e) {
    throw new Error(`解析 Hoyolab 数据失败:${e instanceof Error ? e.message : String(e)}(请确认导出来自 HoYoLAB 战绩页且结构未被删改)`)
  }

  return {
    source: 'hoyolab',
    relics: out.relics as unknown as Relic[],
    characters: out.characters as unknown as Form[],
    metadata: {
      trailblazer: out.metadata.trailblazer,
      currentTrailblazerPath: out.metadata.current_trailblazer_path,
    },
    warnings: [],
  }
}

// The web confirm step forces character/light-cone levels to 80 before merging
// (ScannerImportSubmenu mergeCharactersConfirmed), same for the scanner store's
// full-scan ingest — imported forms are always normalized to optimizer defaults.
function normalizeImportedCharacters(characters: Form[]): Form[] {
  for (const character of characters) {
    character.characterLevel = 80
    character.lightConeLevel = 80
  }
  return characters
}

// Upstream semantics (scannerStore existingCharactersOnly / web checkbox
// "only import existing characters"): filter the imported character forms to
// those already in the store. Relics are NOT affected by this option.
function filterExistingCharacters(characters: Form[]): Form[] {
  return characters.filter((character) => getCharacterById(character.characterId))
}

// ─── merge planning + persistence ──────────────────────────────

function substatListEquals(a: Relic['substats'], b: Relic['substats']): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].stat !== b[i].stat || a[i].value !== b[i].value) return false
  }
  return true
}

// AugmentedStats is a flat record (stat name → number, plus mainStat/mainValue);
// the merge copies it verbatim by reference, so exact key/value equality is the
// right oracle. Tolerates undefined like the previewSubstats comparison above.
function augmentedStatsEquals(a: Relic['augmentedStats'] | undefined, b: Relic['augmentedStats'] | undefined): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key as keyof typeof a] !== b[key as keyof typeof b]) return false
  }
  return true
}

/**
 * Would the upstream mergeRelics hash-match branch actually change the stored
 * relic? Replays its rules: verified imports overwrite
 * substats/previewSubstats/augmentedStats and take over the id (re-linking
 * equipment/build references); otherwise only equippedBy (when characters are
 * imported) and ageIndex can change.
 */
function importWouldChange(incoming: Relic, found: Relic, charactersImported: boolean): boolean {
  if (incoming.verified) {
    if (found.verified !== true) return true
    if (found.id !== incoming.id) return true
    if (!substatListEquals(incoming.substats, found.substats)) return true
    if (!substatListEquals(incoming.previewSubstats ?? [], found.previewSubstats ?? [])) return true
    if (!augmentedStatsEquals(incoming.augmentedStats, found.augmentedStats)) return true
  }
  if (charactersImported && incoming.equippedBy != null && incoming.equippedBy !== found.equippedBy) return true
  if (incoming.ageIndex !== undefined && found.ageIndex !== incoming.ageIndex) return true
  return false
}

type ImportOutcome = {
  added: number,
  updated: number,
  skipped: number,
  removed: number,
  totalBefore: number,
  totalAfter: number,
  charactersTouched: number,
}

function planAndRunImport(relics: Relic[], characters: Form[], merge: MergeMode, dryRun: boolean): ImportOutcome {
  const existingRelics = getRelics()
  const totalBefore = existingRelics.length
  const charactersImported = characters.length > 0

  // Bucket the current inventory by relic hash (array per hash: identical
  // relics collide legitimately and are consumed one import at a time).
  const buckets = new Map<string, Relic[]>()
  for (const relic of existingRelics) {
    const hash = hashRelic(relic)
    const bucket = buckets.get(hash)
    if (bucket) bucket.push(relic)
    else buckets.set(hash, [relic])
  }

  let added = 0
  let updated = 0
  let skipped = 0
  for (const incoming of relics) {
    const hash = hashRelic(incoming)
    const bucket = buckets.get(hash)
    const found = bucket?.shift()
    if (bucket != null && bucket.length === 0) buckets.delete(hash)
    if (found == null) added++
    else if (importWouldChange(incoming, found, charactersImported)) updated++
    else skipped++
  }

  // union: keep every existing relic the import did not cover, so the upstream
  // full-replace write path receives the true hash-union of both inventories.
  const uncovered: Relic[] = []
  if (merge === 'union') {
    for (const bucket of buckets.values()) uncovered.push(...bucket)
  }

  const writeList = merge === 'union' ? [...relics, ...uncovered] : relics

  // Anti-wipe guard at the import layer: a union list can never shrink the
  // inventory, so a smaller synthesized list means the wrapper logic broke —
  // refuse to hand it to the replacing write path (flushSave guards again).
  if (merge === 'union' && writeList.length < totalBefore) {
    throw new Error(
      `union 合并防擦写检查失败:合成清单 ${writeList.length} 件小于现有库存 ${totalBefore} 件,已拒绝落盘。这不应发生,请把导入文件与该错误一起反馈`,
    )
  }

  if (dryRun) {
    // mergeRelics keeps the old inventory when the import carries no relics
    const totalAfter = relics.length === 0 ? totalBefore : writeList.length
    return { added, updated, skipped, removed: Math.max(0, totalBefore - totalAfter), totalBefore, totalAfter, charactersTouched: characters.length }
  }

  persistenceService.mergeRelics(writeList, characters)
  runtimeContext.markDirty()
  const totalAfter = getRelics().length
  return { added, updated, skipped, removed: Math.max(0, totalBefore - totalAfter), totalBefore, totalAfter, charactersTouched: characters.length }
}

// ─── shared tool body ──────────────────────────────────────────

async function runImportTool(
  parsed: ParsedImport,
  merge: MergeMode,
  existingCharactersOnly: boolean | undefined,
  dryRun: boolean,
) {
  runtimeContext.requireSave()

  let characters = normalizeImportedCharacters(parsed.characters)
  if (existingCharactersOnly) characters = filterExistingCharacters(characters)

  const outcome = planAndRunImport(parsed.relics, characters, merge, dryRun)

  const summary = `${dryRun ? '[dryRun] ' : ''}${merge === 'union' ? '并集合并' : '替换合并'}(${parsed.source}):`
    + `新增 ${outcome.added}、更新 ${outcome.updated}、跳过 ${outcome.skipped}、移除 ${outcome.removed} 件遗器,`
    + `库存 ${outcome.totalBefore} → ${outcome.totalAfter} 件,角色 ${outcome.charactersTouched} 个`
    + (dryRun ? '(未落盘)' : '')
    + (parsed.warnings.length ? `;${parsed.warnings.length} 条警告` : '')

  return toolResult(
    {
      imported: !dryRun,
      dryRun,
      merge,
      source: parsed.source,
      added: outcome.added,
      updated: outcome.updated,
      skipped: outcome.skipped,
      removed: outcome.removed,
      totalBefore: outcome.totalBefore,
      totalAfter: outcome.totalAfter,
      charactersTouched: outcome.charactersTouched,
      metadata: parsed.metadata,
      warnings: parsed.warnings,
    },
    summary,
  )
}

// ─── tool registration ─────────────────────────────────────────

// runImportTool 的返回形状——两个导入工具共用(metadata 为解析器拼装的自由对象,不收紧)
const importOutcomeShape = {
  imported: z.boolean(),
  dryRun: z.boolean(),
  merge: z.enum(['union', 'replace']),
  source: z.string(),
  added: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  removed: z.number().int(),
  totalBefore: z.number().int(),
  totalAfter: z.number().int(),
  charactersTouched: z.number().int(),
  metadata: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
}

export function registerImportTools(server: McpServer): void {
  server.registerTool('import_scanner_json', {
    title: '导入扫描器 JSON',
    description: '导入扫描器导出的 JSON(HSR-Scanner / Reliquary Archiver / Yas)——对应网页端「导入」标签页的扫描器文件上传入口与确认页「导入角色与遗器」按钮。'
      + '按遗器 hash(部位/套装/稀有度/等级/主词条/副词条归一值)与现有库存匹配:导入件已验证(reliquary)时覆盖同 hash 库存件的副词条并置 verified,否则仅更新佩戴者/顺序;未命中 hash 的作为新遗器加入,并同步角色装备与已存配装的遗器引用。'
      + 'merge=union(默认):保留库存中未被本次导入覆盖的遗器(合成完整并集清单后走上游整库写入;并集清单意外小于现有库存时拒绝落盘);'
      + 'merge=replace:与网页端原生行为完全一致——库存重置为导入件,未被覆盖的旧遗器会被丢弃(仅角色无遗器的导入除外)。'
      + 'dryRun=true 只解析并统计,不写入。existingCharactersOnly=true 仅导入库存中已存在的角色(遗器不受影响)。'
      + 'source=auto(默认)按 JSON 的 source 字段判别格式,也接受 hoyolab 形状并提示改用 import_hoyolab。',
    inputSchema: {
      source: z.enum(['auto', 'kelz', 'reliquary', 'yas']).default('auto').describe(
        '扫描器格式:kelz=HSR-Scanner(v4)、reliquary=Reliquary Archiver(v4)、yas=Yas Scanner(v3);auto 按 JSON source 字段判别',
      ),
      path: z.string().optional().describe('扫描器 JSON 文件路径(HSRScanData.json / archiver_output.json / hsr.json)'),
      inline: z.unknown().optional().describe('内联扫描器 JSON(对象或 JSON 字符串,与 path 二选一)'),
      merge: z.enum(['union', 'replace']).default('union').describe('合并模式:union=按 hash 并集保留现有库存;replace=整库替换为导入件'),
      existingCharactersOnly: z.boolean().optional().describe('只导入库存中已存在的角色(与网页端「仅导入现有角色」勾选一致),遗器不受影响'),
      dryRun: z.boolean().optional().describe('只解析与统计,不落盘'),
    },
    outputSchema: importOutcomeShape,
  }, async ({ source, path, inline, merge, existingCharactersOnly, dryRun }) => {
    runtimeContext.ensureMetadataReady()
    // Parser errors (source/version mismatch) are localized via i18next —
    // initialize the offline bundle first so they come back in Chinese.
    ensureI18nReady()

    const json = readImportPayload(path, inline, '扫描器 JSON')
    const parsed = parseScannerJson(json, source)
    return runImportTool(parsed, merge, existingCharactersOnly ?? false, dryRun ?? false)
  })

  server.registerTool('import_hoyolab', {
    title: '导入 Hoyolab 战绩数据',
    description: '导入 HoYoLAB 网页端角色战绩导出的 JSON(含 data.avatar_list)——对应网页端「导入」标签页的 Hoyolab 上传入口与确认页「导入角色与角色遗器」按钮。'
      + '遗器按 hash 与现有库存匹配,合并/替换/dryRun/existingCharactersOnly 语义与 import_scanner_json 完全一致:'
      + 'union(默认)按 hash 并集保留现有库存(并集清单意外小于现有库存时拒绝落盘);replace 整库替换,未被导入件覆盖的旧遗器会被丢弃;'
      + 'hoyolab 导入件未验证,同 hash 库存件只更新佩戴者/顺序,不覆盖副词条。导入角色的等级与光锥等级一律规范化为 80(与网页端一致)。',
    inputSchema: {
      path: z.string().optional().describe('Hoyolab 战绩导出 JSON 文件路径'),
      inline: z.unknown().optional().describe('内联 Hoyolab 导出 JSON(对象或 JSON 字符串,与 path 二选一)'),
      merge: z.enum(['union', 'replace']).default('union').describe('合并模式:union=按 hash 并集保留现有库存;replace=整库替换为导入件'),
      existingCharactersOnly: z.boolean().optional().describe('只导入库存中已存在的角色,遗器不受影响'),
      dryRun: z.boolean().optional().describe('只解析与统计,不落盘'),
    },
    outputSchema: importOutcomeShape,
  }, async ({ path, inline, merge, existingCharactersOnly, dryRun }) => {
    runtimeContext.ensureMetadataReady()

    const json = readImportPayload(path, inline, 'Hoyolab 战绩导出')
    const parsed = parseHoyolabJson(json)
    return runImportTool(parsed, merge, existingCharactersOnly ?? false, dryRun ?? false)
  })
}
