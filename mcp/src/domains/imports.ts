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
//     when the synthesized list falls short of the inventory by more than the
//     superseded records (see below).
//     When the import also carries characters, those re-attached copies clear
//     equippedBy. mergeRelics asserts character.equipped[part] for every relic
//     that still has a wearer, in list order, and uncovered relics come last —
//     leaving the wearer on would let an old piece take back a slot the import
//     just claimed (a partial scan, a HoYoLAB export). The hash-match branch
//     keeps the store record's wearer, and the upstream cleanup drops it only
//     when an imported piece now occupies that slot. With no characters,
//     mergeRelics never asserts slots, so the store wearer is left as-is.
//   - replace: the raw upstream behavior — inventory becomes the import,
//     uncovered relics are discarded (character-only imports keep the relics).
//
// Hash-match behavior (both modes, decided inside mergeRelics): a matching
// import takes over the store entry's identity; verified imports (reliquary)
// overwrite substats/previewSubstats/augmentedStats and set verified, otherwise
// only equippedBy/ageIndex may change; character equipment and saved-build
// relic id references are re-linked. Import-layer stats (added/updated/skipped)
// replay exactly those rules, so they report what the persisted merge did.
//
// Same-id supersession (union, stable-id sources only): Reliquary Archiver
// reads relic ids from the game's own packets, so an id survives an in-game
// upgrade while the hash does not (+0 three substats → +15 four substats). An
// existing relic carrying an imported relic's id but another hash is then the
// stale state of that same relic: it is superseded, not re-attached — what the
// web's full replace does to it. Without this the inventory ends up with two
// records under one id, relicsById (last write wins) resolves to the stale
// one, and the next upsertRelic / deleteRelic rebuilds the list from
// relicsById and drops the fresh record.
// It is done by folding the imported state into the inventory BEFORE the
// upstream call (the stale record becomes the imported relic, keeping its
// wearer), so mergeRelics — which pairs by hash only, FIFO — meets an ordinary
// hash match and applies its ordinary wearer rule. Merely leaving the stale
// record off the write list is not enough: it would still sit in upstream's
// hash buckets, where a re-attached hash twin consumes it and inherits its id.
// Folded entries are not parked at the front of the bucket. Within each hash
// the store order is aligned to the import order, and an import claims the
// same-id record ahead of any other candidate. Otherwise a twin listed earlier
// in the file (or sitting earlier in the bucket) takes the folded record,
// verified id rewrite swaps the two ids, and equipment plus saved builds follow.
// HSR-Scanner ids are NOT stable (it assigns `relic_1`, `relic_2`, … by scan
// position, per its README), Yas does not emit `_uid` (see below), and
// HoYoLAB ids are fresh uuids — for those sources an equal id proves nothing
// and nothing is folded.
//
// Unstable-id collisions (stableRelicIds=false, both union and replace):
// mergeRelics keeps the inventory id on an unverified hash match and stores
// an unmatched import under its own id. A new piece can therefore land on an
// id another surviving record still holds. relicsById keeps the last write,
// and the next upsertRelic / deleteRelic rebuilds the list from it and drops
// the other relic. Before the write, an unmatched import whose id is missing
// or already taken is copied onto a fresh uuid. Taken ids are the ones this
// write still keeps: an unverified match keeps the inventory id, a verified
// match takes the import id, union keeps every uncovered id, and earlier
// unmatched imports keep theirs. replace does not keep uncovered relics, so
// their ids are free; a clash with a hash-matched survivor is still renamed.
// That is the one divergence from the web's replace path, which would store
// the duplicate and then lose a relic. Hash pairing ignores id, so the
// added/updated/skipped counts do not move.
// Yas (wormtql/yas, yas-starrail/src/export/relic/hsr.rs on main) writes
// `_id: nanoid!()` at serialize time and `set` (English set name), not
// `_uid` / `set_id`. The upstream parser only reads `_uid` and skips an
// unknown `set_id`, so a current Yas file contributes no relics. A relic
// that does parse without `_uid` gets `id: undefined`; every such relic
// would share that one id, and the rename above separates them.
//
// M6-A: planAndRunImport is exported for the live scanner domain (domains/
// scanner.ts) — a scanner InitialScan merges through this same machine (union
// mode), so file imports and live frames share one merge semantics.

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
import {
  getRelics,
  useRelicStore,
} from 'lib/stores/relic/relicStore'
import {
  isVersionOutdated,
  uuid,
} from 'lib/utils/miscUtils'
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
  /** Relic ids identify the same in-game relic across exports (see file header). */
  stableRelicIds: boolean,
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
    stableRelicIds: parser.config.sourceString === ReliquaryArchiverConfig.sourceString,
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
    stableRelicIds: false,
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

/**
 * Copy that will not assert a character slot.
 *
 * mergeRelics overwrites `character.equipped[part]` whenever the relic it is
 * looking at still has `equippedBy` and characters were imported. Union puts
 * uncovered inventory relics after the import, so their stored wearer would
 * undo a slot the import just set. Clearing `equippedBy` on a copy (never the
 * store object) skips that assertion. The hash match still returns the store
 * record, which keeps its wearer until the upstream cleanup sees that an
 * imported piece now occupies the slot.
 */
function withoutEquipClaim(relic: Relic): Relic {
  if (relic.equippedBy == null) return relic
  return { ...relic, equippedBy: undefined }
}

export type ImportOutcome = {
  added: number,
  updated: number,
  skipped: number,
  removed: number,
  replacedById: number,
  totalBefore: number,
  totalAfter: number,
  charactersTouched: number,
}

// A relic never changes part, set, rarity or main stat, and its level never
// drops — an existing record failing this is not an earlier state of the
// import, whatever its id says (another account's save, a hand-edited file).
function couldBeEarlierStateOf(existing: Relic, incoming: Relic): boolean {
  return existing.part === incoming.part
    && existing.set === incoming.set
    && existing.grade === incoming.grade
    && existing.main.stat === incoming.main.stat
    && existing.enhance <= incoming.enhance
}

type FoldedInventory = {
  /** What mergeRelics must see as the current inventory. */
  inventory: Relic[],
  /** Inventory entries that are an imported relic's state standing in for its stale record. */
  folded: Set<Relic>,
  /** Existing records replaced or dropped because an imported relic carries their id. */
  superseded: Relic[],
}

/**
 * Same-id supersession for stable-id sources (see file header). Per imported
 * relic, the existing records of its id that could be earlier states of it:
 *   - one already hashes like the import → it stays, the others are stale
 *     duplicates and go (an inventory the pre-fix union left behind);
 *   - none does → the one relicsById resolves to (the last) becomes the
 *     imported state, the others go.
 * The surviving entry keeps the wearer the stale records held, so upstream's
 * hash-match branch decides equipment exactly as for an unchanged relic.
 * Which inventory entry an import consumes is decided later, by
 * alignInventoryToImportOrder — a folded entry must not jump the hash bucket.
 */
function foldSupersededRecords(existingRelics: Relic[], relics: Relic[]): FoldedInventory {
  const incomingIds = new Set(relics.map((relic) => relic.id))
  const existingById = new Map<string, Relic[]>()
  for (const relic of existingRelics) {
    if (!incomingIds.has(relic.id)) continue
    const sameId = existingById.get(relic.id)
    if (sameId) sameId.push(relic)
    else existingById.set(relic.id, [relic])
  }

  const dropped = new Set<Relic>()
  const rewearing = new Map<Relic, Relic>()
  const superseded: Relic[] = []
  const foldedEntries: Relic[] = []
  for (const incoming of relics) {
    const sameId = existingById.get(incoming.id)?.filter((relic) => couldBeEarlierStateOf(relic, incoming))
    existingById.delete(incoming.id)
    if (sameId == null || sameId.length === 0) continue
    const hash = hashRelic(incoming)
    const current = sameId.find((relic) => hashRelic(relic) === hash)
    const stale = sameId.filter((relic) => relic !== current)
    if (stale.length === 0) continue

    for (const relic of stale) dropped.add(relic)
    superseded.push(...stale)
    const wearer = stale.findLast((relic) => relic.equippedBy != null)?.equippedBy
    if (current == null) {
      foldedEntries.push({ ...incoming, equippedBy: wearer })
    } else if (current.equippedBy == null && wearer != null) {
      rewearing.set(current, { ...current, equippedBy: wearer })
    }
  }

  if (superseded.length === 0) return { inventory: existingRelics, folded: new Set(), superseded }
  const kept = existingRelics.filter((relic) => !dropped.has(relic)).map((relic) => rewearing.get(relic) ?? relic)
  // Folded entries stay with the other records of their hash. Putting them
  // first would let an earlier import of a hash twin consume them.
  return { inventory: [...kept, ...foldedEntries], folded: new Set(foldedEntries), superseded }
}

/**
 * mergeRelics pairs each hash FIFO: the nth import of a hash consumes the nth
 * store entry of that hash. Prefer the entry that already carries the import's
 * id (the folded stand-in, or the record that already hashes like the import),
 * and leave everything else in its original order. Only the order inside a
 * hash changes; other relics keep their slots.
 */
function alignInventoryToImportOrder(inventory: Relic[], imports: Relic[]): Relic[] {
  const byHash = new Map<string, Relic[]>()
  for (const relic of inventory) {
    const hash = hashRelic(relic)
    const list = byHash.get(hash)
    if (list) list.push(relic)
    else byHash.set(hash, [relic])
  }

  const claimed = new Set<Relic>()
  const orderedByHash = new Map<string, Relic[]>()
  const claim = (hash: string, relic: Relic) => {
    claimed.add(relic)
    const ordered = orderedByHash.get(hash)
    if (ordered) ordered.push(relic)
    else orderedByHash.set(hash, [relic])
  }
  for (const incoming of imports) {
    const hash = hashRelic(incoming)
    const candidates = byHash.get(hash)
    if (candidates == null) continue
    const sameId = candidates.find((relic) => !claimed.has(relic) && relic.id === incoming.id)
    const partner = sameId ?? candidates.find((relic) => !claimed.has(relic))
    if (partner == null) continue
    claim(hash, partner)
  }
  for (const [hash, candidates] of byHash) {
    for (const relic of candidates) {
      if (!claimed.has(relic)) claim(hash, relic)
    }
  }

  const cursor = new Map<string, number>()
  return inventory.map((relic) => {
    const hash = hashRelic(relic)
    const ordered = orderedByHash.get(hash)!
    const index = cursor.get(hash) ?? 0
    cursor.set(hash, index + 1)
    return ordered[index]!
  })
}

function sameRelicSequence(left: Relic[], right: Relic[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

type HashPairing = {
  incoming: Relic,
  found: Relic | null,
}

function hasUsableId(id: string | undefined): id is string {
  return id != null && id !== ''
}

/** Id mergeRelics will store for a hash match. Unverified keeps the inventory id. */
function storedIdAfterMatch(incoming: Relic, found: Relic): string | undefined {
  return incoming.verified ? incoming.id : found.id
}

/**
 * See the file header. Hash-matched imports are returned unchanged: their id
 * is not what an unverified match stores. Only unmatched imports are renamed,
 * and only when their id is missing or already claimed by a record this write
 * keeps.
 */
function assignUniqueUnstableIds(pairings: HashPairing[], uncovered: Relic[]): Relic[] {
  const occupied = new Set<string>()
  const claim = (id: string | undefined) => {
    if (hasUsableId(id)) occupied.add(id)
  }
  for (const { incoming, found } of pairings) {
    if (found != null) claim(storedIdAfterMatch(incoming, found))
  }
  for (const relic of uncovered) claim(relic.id)

  return pairings.map(({ incoming, found }) => {
    if (found != null) return incoming
    if (hasUsableId(incoming.id) && !occupied.has(incoming.id)) {
      occupied.add(incoming.id)
      return incoming
    }
    let fresh = uuid()
    while (occupied.has(fresh)) fresh = uuid()
    occupied.add(fresh)
    return { ...incoming, id: fresh }
  })
}

/**
 * stableRelicIds: the import's relic ids identify the same in-game relic
 * across exports (Reliquary Archiver files and live frames — which are also
 * always `verified`, so a hash match takes over the imported id).
 */
export function planAndRunImport(
  relics: Relic[],
  characters: Form[],
  merge: MergeMode,
  dryRun: boolean,
  stableRelicIds = false,
): ImportOutcome {
  const existingRelics = getRelics()
  const totalBefore = existingRelics.length
  const charactersImported = characters.length > 0

  // Stable ids only: union folds same-id relics into the inventory first,
  // then lines each hash up with the import so a twin cannot take the folded
  // record's id. replace does not fold. Unstable ids are renamed below, in
  // both modes — that does not change which relics survive a replace.
  const foldedInventory = merge === 'union' && stableRelicIds
    ? foldSupersededRecords(existingRelics, relics)
    : { inventory: existingRelics, folded: new Set<Relic>(), superseded: [] as Relic[] }
  const aligned = merge === 'union' && stableRelicIds
    ? alignInventoryToImportOrder(foldedInventory.inventory, relics)
    : foldedInventory.inventory
  const inventory = sameRelicSequence(aligned, foldedInventory.inventory) ? foldedInventory.inventory : aligned
  const { folded, superseded } = foldedInventory
  const replacedById = superseded.length

  // Bucket the inventory by relic hash (array per hash: identical relics
  // collide legitimately and are consumed one import at a time).
  const buckets = new Map<string, Relic[]>()
  for (const relic of inventory) {
    const hash = hashRelic(relic)
    const bucket = buckets.get(hash)
    if (bucket) bucket.push(relic)
    else buckets.set(hash, [relic])
  }

  const pairings: HashPairing[] = []
  let added = 0
  let updated = 0
  let skipped = 0
  for (const incoming of relics) {
    const hash = hashRelic(incoming)
    const bucket = buckets.get(hash)
    const found = bucket?.shift() ?? null
    if (bucket != null && bucket.length === 0) buckets.delete(hash)
    pairings.push({ incoming, found })
    if (found == null) added++
    // a folded entry is a relic whose stored state this import replaces
    else if (folded.has(found) || importWouldChange(incoming, found, charactersImported)) updated++
    else skipped++
  }

  // union: keep every existing relic the import did not cover, so the upstream
  // full-replace write path receives the true hash-union of both inventories.
  const uncovered: Relic[] = []
  if (merge === 'union') {
    for (const bucket of buckets.values()) uncovered.push(...bucket)
  }

  // See withoutEquipClaim. Order stays [...import, ...uncovered]: moving the
  // uncovered relics forward would change which store record each hash bucket
  // shift() returns, and the added/updated/skipped counts replay that pairing.
  // Renames happen after the counts, on copies, and do not change list length.
  const relicsForWrite = stableRelicIds ? relics : assignUniqueUnstableIds(pairings, uncovered)
  const uncoveredForWrite = charactersImported ? uncovered.map(withoutEquipClaim) : uncovered
  const writeList = merge === 'union' ? [...relicsForWrite, ...uncoveredForWrite] : relicsForWrite

  // Anti-wipe guard at the import layer: a union list can never be shorter
  // than the inventory it is merged into, and that inventory can only be
  // shorter than the store by superseded records whose id is still in it.
  // Anything else means the wrapper logic broke — refuse to hand it to the
  // replacing write path (flushSave guards again).
  if (merge === 'union') {
    const inventoryIds = new Set(inventory.map((relic) => relic.id))
    const orphaned = superseded.filter((relic) => !inventoryIds.has(relic.id)).length
    if (writeList.length < inventory.length || inventory.length + replacedById < totalBefore || orphaned > 0) {
      throw new Error(
        `union 合并防擦写检查失败:合成清单 ${writeList.length} 件、待合并库存 ${inventory.length} 件、同 id 替换 ${replacedById} 件、现有库存 ${totalBefore} 件,`
          + `其中 ${orphaned} 件被替换的旧记录找不到同 id 的继任记录,已拒绝落盘。这不应发生,请把导入文件与该错误一起反馈`,
      )
    }
  }

  if (dryRun) {
    // mergeRelics keeps the old inventory when the import carries no relics
    const totalAfter = relics.length === 0 ? totalBefore : writeList.length
    return {
      added,
      updated,
      skipped,
      removed: Math.max(0, totalBefore - totalAfter),
      replacedById,
      totalBefore,
      totalAfter,
      charactersTouched: characters.length,
    }
  }

  if (inventory === existingRelics) {
    persistenceService.mergeRelics(writeList, characters)
  } else {
    // mergeRelics reads the inventory from the store: put the folded one there
    // first, and take it back out if the merge throws.
    const { relics: relicsBefore, relicsById: relicsByIdBefore } = useRelicStore.getState()
    useRelicStore.getState().setRelics(inventory)
    try {
      persistenceService.mergeRelics(writeList, characters)
    } catch (e) {
      useRelicStore.setState({ relics: relicsBefore, relicsById: relicsByIdBefore })
      throw e
    }
  }
  runtimeContext.markDirty()
  const totalAfter = getRelics().length
  return {
    added,
    updated,
    skipped,
    removed: Math.max(0, totalBefore - totalAfter),
    replacedById,
    totalBefore,
    totalAfter,
    charactersTouched: characters.length,
  }
}

// ─── shared tool body ──────────────────────────────────────────

async function runImportTool(
  parsed: ParsedImport,
  merge: MergeMode,
  existingCharactersOnly: boolean | undefined,
  dryRun: boolean,
  includeCharacters: boolean | undefined,
) {
  runtimeContext.requireSave()

  // includeCharacters=false = 网页确认页「导入遗器」按钮(mergeRelicsConfirmed →
  // mergeRelics(relics, [])):只导入遗器,不新增也不修改角色;hash 命中的库存件
  // 因 charactersImported=false 只可能更新 ageIndex,佩戴者保持不变。
  const relicsOnly = includeCharacters === false
  let characters = relicsOnly ? [] : normalizeImportedCharacters(parsed.characters)
  if (existingCharactersOnly && !relicsOnly) characters = filterExistingCharacters(characters)

  const outcome = planAndRunImport(parsed.relics, characters, merge, dryRun, parsed.stableRelicIds)

  const summary = `${dryRun ? '[dryRun] ' : ''}${merge === 'union' ? '并集合并' : '替换合并'}(${parsed.source})`
    + (relicsOnly ? '[仅遗器]' : '')
    + `:新增 ${outcome.added}、更新 ${outcome.updated}、跳过 ${outcome.skipped}、移除 ${outcome.removed} 件遗器,`
    + (outcome.replacedById > 0 ? `同 id 替换旧记录 ${outcome.replacedById} 件,` : '')
    + `库存 ${outcome.totalBefore} → ${outcome.totalAfter} 件,角色 ${outcome.charactersTouched} 个`
    + (dryRun ? '(未落盘)' : '')
    + (parsed.warnings.length ? `;${parsed.warnings.length} 条警告` : '')

  return toolResult(
    {
      imported: !dryRun,
      dryRun,
      merge,
      source: parsed.source,
      includeCharacters: !relicsOnly,
      added: outcome.added,
      updated: outcome.updated,
      skipped: outcome.skipped,
      removed: outcome.removed,
      replacedById: outcome.replacedById,
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
  includeCharacters: z.boolean(),
  added: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  removed: z.number().int(),
  replacedById: z.number().int(),
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
      + '同 id 替换(仅 merge=union 且来源为 Reliquary Archiver——它的 _uid 取自游戏数据包,跨导出稳定;HSR-Scanner 的 _uid 按扫描位置编号、Yas 导出的是每次重新生成的 _id 且解析器只读 _uid,均不参与):'
      + '库存件与某件导入件 id 相同但 hash 不同,且部位/套装/稀有度/主词条一致、等级不高于导入件时,它是同一件遗器强化/重掷前的旧状态——由导入件覆盖,不与它并存'
      + '(与网页整库替换对这件遗器的结果一致);角色装备与已存配装按 id 引用,自动指向新状态;佩戴者规则与 hash 命中件相同:连同导入角色且导入件带佩戴者时以导入件为准,否则沿用旧记录的佩戴者。'
      + '统计口径:added/updated/skipped 三者之和=导入件数——added=未命中库存的新遗器,updated=命中 hash 且有实质变化或同 id 替换,skipped=命中且无变化;'
      + 'replacedById=因同 id 被导入件覆盖而移出的旧记录数(库存里同一 id 已有多条记录时会一并收敛,此时 removed>0);removed=库存净减少件数。'
      + 'merge=union(默认):保留库存中未被本次导入覆盖的遗器(合成完整并集清单后走上游整库写入;并集清单小于待合并库存、或被替换的旧记录找不到同 id 继任记录时拒绝落盘)。'
      + '连同导入角色时,未覆盖的旧遗器不再用库存里的佩戴者回写槽位:导入件占用的部位以导入件为准,文件没给新件的部位仍穿原来的遗器;不导入角色时不改任何穿戴。'
      + '不稳定 id 不做同 id 替换。未命中 hash、且自带 id 会与落库后仍在的另一条记录重复(或解析后没有 id)时,改赋一个新的 uuid;hash 配对与 added/updated/skipped 不变。'
      + 'merge=union 与 merge=replace 都改号。'
      + 'merge=replace:库存集合与网页端原生行为一致——重置为导入件,未被覆盖的旧遗器会被丢弃(仅角色无遗器的导入除外),不做同 id 替换(replacedById 恒为 0);'
      + '与网页的唯一差别是不稳定 id 的相撞件会改号,避免 relicsById 丢掉其中一件。'
      + 'dryRun=true 只解析并统计,不写入。existingCharactersOnly=true 仅导入库存中已存在的角色(遗器不受影响)。'
      + 'includeCharacters=false 对应网页确认页「导入遗器」按钮:只导入遗器,不新增也不修改角色(默认 true=「导入角色与遗器」,与既有行为一致)。'
      + 'source=auto(默认)按 JSON 的 source 字段判别格式,也接受 hoyolab 形状并提示改用 import_hoyolab。',
    inputSchema: {
      source: z.enum(['auto', 'kelz', 'reliquary', 'yas']).default('auto').describe(
        '扫描器格式:kelz=HSR-Scanner(v4)、reliquary=Reliquary Archiver(v4)、yas=Yas Scanner(v3);auto 按 JSON source 字段判别',
      ),
      path: z.string().optional().describe('扫描器 JSON 文件路径(HSRScanData.json / archiver_output.json / hsr.json)'),
      inline: z.unknown().optional().describe('内联扫描器 JSON(对象或 JSON 字符串,与 path 二选一)'),
      merge: z.enum(['union', 'replace']).default('union').describe(
        '合并模式:union=按 hash 并集保留现有库存(Reliquary Archiver 来源下同 id 的旧记录由导入件覆盖;连同导入角色时,未覆盖的旧遗器不回写槽位,导入件优先);replace=整库替换为导入件',
      ),
      existingCharactersOnly: z.boolean().optional().describe(
        '只导入库存中已存在的角色(与网页端「仅导入现有角色」勾选一致),遗器不受影响;仅在 includeCharacters=true 时有意义',
      ),
      includeCharacters: z.boolean().optional().describe(
        '是否连同导入角色(默认 true=网页「导入角色与遗器」);false=只导入遗器(网页确认页「导入遗器」按钮):角色不新增不修改,hash 命中件的佩戴者也保持不变'
          + '(同 id 替换件同样沿用旧记录的佩戴者)',
      ),
      dryRun: z.boolean().optional().describe('只解析与统计,不落盘'),
    },
    outputSchema: importOutcomeShape,
  }, async ({ source, path, inline, merge, existingCharactersOnly, includeCharacters, dryRun }) => {
    runtimeContext.ensureMetadataReady()
    // Parser errors (source/version mismatch) are localized via i18next —
    // initialize the offline bundle first so they come back in Chinese.
    ensureI18nReady()

    const json = readImportPayload(path, inline, '扫描器 JSON')
    const parsed = parseScannerJson(json, source)
    return runImportTool(parsed, merge, existingCharactersOnly ?? false, dryRun ?? false, includeCharacters)
  })

  server.registerTool('import_hoyolab', {
    title: '导入 Hoyolab 战绩数据',
    description: '导入 HoYoLAB 网页端角色战绩导出的 JSON(含 data.avatar_list)——对应网页端「导入」标签页的 Hoyolab 上传入口与确认页「导入角色与角色遗器」按钮。'
      + '遗器按 hash 与现有库存匹配,合并/替换/dryRun/existingCharactersOnly 语义与 import_scanner_json 完全一致:'
      + 'union(默认)按 hash 并集保留现有库存(并集清单意外小于现有库存时拒绝落盘;连同导入角色时未覆盖的旧遗器不回写槽位,导入件优先,文件没给新件的部位仍穿原来的遗器);replace 整库替换,未被导入件覆盖的旧遗器会被丢弃;'
      + 'hoyolab 导入件未验证,同 hash 库存件只更新佩戴者/顺序,不覆盖副词条。导入角色的等级与光锥等级一律规范化为 80(与网页端一致)。'
      + '统计字段(added/updated/skipped/removed/replacedById)口径同 import_scanner_json;hoyolab 导入件的 id 每次重新生成,不做同 id 替换(replacedById 恒为 0)。'
      + 'includeCharacters=false 对应网页确认页「导入遗器」按钮:只导入遗器,不新增也不修改角色(默认 true,与既有行为一致)。',
    inputSchema: {
      path: z.string().optional().describe('Hoyolab 战绩导出 JSON 文件路径'),
      inline: z.unknown().optional().describe('内联 Hoyolab 导出 JSON(对象或 JSON 字符串,与 path 二选一)'),
      merge: z.enum(['union', 'replace']).default('union').describe(
        '合并模式:union=按 hash 并集保留现有库存(连同导入角色时,未覆盖的旧遗器不回写槽位,导入件优先);replace=整库替换为导入件',
      ),
      existingCharactersOnly: z.boolean().optional().describe('只导入库存中已存在的角色,遗器不受影响;仅在 includeCharacters=true 时有意义'),
      includeCharacters: z.boolean().optional().describe(
        '是否连同导入角色(默认 true=网页「导入角色与角色遗器」);false=只导入遗器(网页确认页「导入遗器」按钮):角色不新增不修改,hash 命中件的佩戴者也保持不变',
      ),
      dryRun: z.boolean().optional().describe('只解析与统计,不落盘'),
    },
    outputSchema: importOutcomeShape,
  }, async ({ path, inline, merge, existingCharactersOnly, includeCharacters, dryRun }) => {
    runtimeContext.ensureMetadataReady()

    const json = readImportPayload(path, inline, 'Hoyolab 战绩导出')
    const parsed = parseHoyolabJson(json)
    return runImportTool(parsed, merge, existingCharactersOnly ?? false, dryRun ?? false, includeCharacters)
  })
}
