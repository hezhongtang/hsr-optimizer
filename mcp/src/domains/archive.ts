// Archive domain: save-file lifecycle.
//
// `load_save` replaces the stores transactionally through the full upstream
// migration chain (bypassing the localStorage SaveState.load path). A failed
// load restores the current memory state, including edits awaiting a flush.
// Mutating tools mark the context dirty; a debounced flush serializes current
// stores with `SaveState.save()` and writes the string back to the save file.

import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import {
  isAbsolute,
  resolve,
} from 'node:path'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import sampleSave from 'data/sample-save.json' with { type: 'json' }
import * as persistenceService from 'lib/services/persistenceService'
import { SaveState } from 'lib/state/saveState'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import type { HsrOptimizerSaveFormat } from 'types/store'
import { z } from 'zod'

import { runtimeContext } from '../context'
import { readStructuredSnapshot } from '../saveSnapshot'
import { replaceSaveStores } from '../saveStores'
import { toolResult } from '../toolResult'

function parseSave(raw: string, origin: string): HsrOptimizerSaveFormat {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Invalid JSON in save data from ${origin}: ${(e as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid save data from ${origin}: expected a JSON object with "relics" and "characters" arrays`)
  }
  const candidate = parsed as Partial<HsrOptimizerSaveFormat>
  if (!Array.isArray(candidate.relics) || !Array.isArray(candidate.characters)) {
    throw new Error(`Invalid save data from ${origin}: missing "relics" or "characters" array (got ${typeof candidate.relics}/${typeof candidate.characters})`)
  }
  return parsed as HsrOptimizerSaveFormat
}

function saveCounts() {
  return {
    relics: getRelics().length,
    characters: getCharacters().length,
    characterIds: getCharacters().map((c) => c.id),
  }
}

/**
 * The export_save write chain, shared with reset_all(persist=true):
 *   - guardrail 1: never write through a symlink (lstat does not follow it);
 *   - guardrail 2: an existing target must look like a save file (both a
 *     relics and a characters array — a deliberately emptied save still
 *     qualifies, a stray ~/.zshrc does not);
 *   - guardrail 3: atomic replace via a sibling temp file.
 * Afterwards the in-memory snapshot future driver runs reload from is
 * refreshed and the loaded path's dirty/blockedWrite markers are cleared
 * (markExportedClean no-ops for a different target).
 */
function persistSaveFile(target: string, stateString: string, origin: string): void {
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`Refusing to export over symlink ${target} — pass the real file path instead`)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (existsSync(target)) {
    parseSave(readFileSync(target, 'utf8'), `${target} (existing file targeted by ${origin})`)
  }
  const tmpPath = `${target}.tmp`
  writeFileSync(tmpPath, stateString)
  renameSync(tmpPath, target)
  const save = runtimeContext.getSave()!
  try {
    save.data = JSON.parse(stateString) as HsrOptimizerSaveFormat
  } catch {
    // Keep the previous snapshot if serialization somehow produced invalid JSON
  }
  runtimeContext.markExportedClean(target)
}

export function registerArchiveTools(server: McpServer): void {
  server.registerTool('load_save', {
    title: '载入存档文件',
    description: '载入一份 fribbels-optimizer-save.json 格式的存档文件,替换服务器当前已加载的全部状态——对应网页端把存档文件导入浏览器/换号载入的动作。'
      + '提供 path(绝对路径,或相对服务器工作目录)、内联 json 或 sample=true(网页端「入门」抽屉「试一试」按钮载入的内置示例存档,'
      + '即仓库 src/data/sample-save.json 的深拷贝,与网页端 GettingStartedDrawer.tryItOutClicked 同一数据源,构建产物内嵌、仓库外安装也可用)三选一,'
      + '完整执行上游迁移链(旧版格式迁移、主词条迁移、配装迁移、装备重互链)。'
      + 'sample=true 会整体替换当前数据(与网页端「试一试」语义一致,网页端须经确认框,MCP 侧由调用方自行确认);'
      + '载入后语义同普通 load_save(示例来源无文件路径,视同内联 JSON,导出需显式 path)。'
      + '载入后即可用 list_relics / optimize 等工具操作这份数据。'
      + '可选 baseRevision 做乐观并发检查(与 update_state 同款):载入前状态已被其他变更改动即报冲突。',
    inputSchema: {
      path: z.string().optional().describe('存档文件路径(fribbels-optimizer-save.json)'),
      json: z.unknown().optional().describe('内联存档对象(与存档文件内容同 schema)'),
      sample: z.boolean().optional().describe('载入网页端「入门」抽屉「试一试」的内置示例存档(与 path/json 互斥,三选一)'),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突(在排队变更全部落地后检查),需重读后重试'),
    },
    outputSchema: {
      loaded: z.boolean(),
      path: z.string().nullable(),
      relics: z.number().int(),
      characters: z.number().int(),
      characterIds: z.array(z.string()),
      // 直读用户存档文件的 version 字段——上游迁移链可能写出任意形状,不收紧
      version: z.unknown(),
      sample: z.boolean().optional().describe('sample=true 载入内置示例存档时为 true(echo)'),
    },
  }, async ({ path, json, sample, baseRevision }) => {
    runtimeContext.ensureMetadataReady()

    // sample=false 与缺省同义(不是来源);path/json/true 的 sample 三者必须恰好一个
    const sources = (path != null ? 1 : 0) + (json != null ? 1 : 0) + (sample === true ? 1 : 0)
    if (sources !== 1) {
      throw new Error(
        `存档来源必须三选一:当前收到 ${sources} 个 — 请只提供 path(存档文件路径)、json(内联存档对象)或 sample=true(内置示例存档)中的一个`,
      )
    }

    let data: HsrOptimizerSaveFormat
    let resolvedPath: string | null = null

    if (path != null) {
      resolvedPath = isAbsolute(path) ? path : resolve(process.cwd(), path)
      if (!existsSync(resolvedPath)) {
        throw new Error(`Save file not found: ${resolvedPath}`)
      }
      data = parseSave(readFileSync(resolvedPath, 'utf8'), resolvedPath)
    } else if (json != null) {
      if (typeof json === 'string') {
        data = parseSave(json, 'inline json string')
      } else if (typeof json === 'object') {
        data = json as HsrOptimizerSaveFormat
        if (!Array.isArray(data.relics) || !Array.isArray(data.characters)) {
          throw new Error('Invalid inline save object: missing "relics" or "characters" array')
        }
      } else {
        throw new Error('json must be a save object or a JSON string')
      }
    } else {
      // 网页端「试一试」:loadSaveData(sample-save.json 深拷贝, autosave=false)
      // (GettingStartedDrawer.tsx tryItOutClicked)——逐字同款深拷贝(也避免
      // 迁移链改动构建产物内嵌的 JSON 模块对象)
      data = JSON.parse(JSON.stringify(sampleSave)) as HsrOptimizerSaveFormat
      if (!Array.isArray(data.relics) || !Array.isArray(data.characters)) {
        throw new Error('Invalid built-in sample save: missing "relics" or "characters" array')
      }
    }

    // loadSaveData mutates its input (migrations, equip re-linking) — keep a pristine clone
    const pristine = structuredClone(data)
    // The migration chain writes partial markers into the stores
    // (completedMigrations / seenFeatures / scoringOverrides) BEFORE it can
    // throw on malformed entries (e.g. a character missing `form` → TypeError
    // in migrateCharacterForm). Left as-is that is a chimera — new-save markers
    // + previous-save inventory — while loadedSave still points at the OLD
    // file, so the next flush would persist the chimera into it. withChange
    // snapshots the current stores (including edits not yet flushed to disk)
    // and on failure restores them plus revision/dirty — no serialization, no
    // save, no runtime ownership change on the rollback path.
    try {
      data = await runtimeContext.withChange('load_save', () => replaceSaveStores(data), baseRevision != null ? { baseRevision } : {})
    } catch (e) {
      // A baseRevision conflict is a CALLER error (their view went stale), not
      // a broken save — surface requireRevision's message (both revisions
      // named) verbatim instead of the migration-failure wrap below.
      if ((e as Error).message.includes('修订号冲突')) throw e
      throw new Error(
        `存档载入失败:迁移链处理该存档时抛错(${(e as Error).message})。`
          + '服务器已恢复载入前的内存状态(含未落盘变更),未写入任何新档状态;'
          + '请检查存档内容(常见原因:characters 条目缺少 form 等必需字段)后重试。',
      )
    }
    // Sync the upstream anti-wipe guard's reference before any mutation can
    // flush: SaveState.save() (src/lib/state/saveState.ts:40-59) compares the
    // current stores against localStorage['state'] and silently returns
    // undefined when a collection would shrink to zero vs. that reference.
    // load_save deliberately bypasses SaveState.load, so without this sync a
    // stale 'state' from the previous save (or an earlier MCP session via the
    // file-backed shim) would block every write-back the moment the newly
    // loaded save has an empty characters or relics set.
    localStorage.setItem('state', JSON.stringify(data))
    runtimeContext.setSave({ path: resolvedPath, data: pristine, loadedAt: Date.now() })

    const counts = saveCounts()
    const fromSample = sample === true
    return toolResult(
      {
        loaded: true,
        path: resolvedPath,
        ...counts,
        version: data.version ?? null,
        ...(fromSample ? { sample: true } : {}),
      },
      `已载入存档:${counts.relics} 件遗器、${counts.characters} 个角色${
        resolvedPath ? `(来自 ${resolvedPath})` : fromSample ? '(内置示例存档,网页端「入门」抽屉「试一试」同源)' : '(内联 JSON)'
      }`,
    )
  })

  server.registerTool('export_save', {
    title: '导出当前状态为存档文件',
    description: '把当前内存状态用上游 SaveState.save() 序列化并写回磁盘——对应网页端设置页的「导出存档」。'
      + '默认写回当前存档的载入路径;内联 JSON 载入的存档必须显式传 path。'
      + '写入带三道护栏:目标已是符号链接时拒绝(防止沿链接覆写任意文件);'
      + '目标文件已存在但不是存档形状(缺 relics/characters 数组)时拒绝(防止覆写 ~/.zshrc 等无关文件,刻意清空的存档仍是合法目标);'
      + '实际写入走同目录临时文件 + 原子 rename,中断不会留下半截文件。'
      + '传 structured=true 时改为只读快照:不写任何文件,直接返回当前内存状态的存档对象(与导出文件逐字段一致,含未落盘变更)——'
      + '适合检查/备份内存态而不落盘,内联 JSON 载入的存档无需 path 也能用。',
    inputSchema: {
      path: z.string().optional().describe('目标文件路径(默认写回载入时的存档路径)'),
      structured: z.boolean().optional().describe(
        'true=只读结构化快照:返回当前内存状态的存档对象(不写任何文件、不触发写回、不变更 revision);'
          + '缺省/false=写盘导出(默认行为)',
      ),
    },
    outputSchema: {
      // Write mode payload fields — optional only because the structured mode
      // returns the snapshot shape below instead (never both in one result).
      exported: z.boolean().optional(),
      path: z.string().optional(),
      bytes: z.number().int().optional(),
      // Structured (read-only) mode payload fields.
      structured: z.boolean().optional(),
      // 直读内存快照整体——快照形状跟上游 SaveState.save() 的序列化走
      // (types/store.ts HsrOptimizerSaveFormat,可选字段随上游版本演化),
      // 这里不收紧,与 load_save 的 version 字段同一处理原则。
      snapshot: z.record(z.string(), z.unknown()).optional(),
      revision: z.number().int().optional(),
      generation: z.number().int().optional(),
      counts: z.object({
        relics: z.number().int(),
        characters: z.number().int(),
      }).optional(),
    },
  }, async ({ path, structured }) => {
    runtimeContext.requireSave()

    // Read-only structured snapshot: must return before ANY file write below.
    // Deliberately does NOT call SaveState.save() — that writes localStorage
    // (shifting the anti-wipe guard's reference), can be blocked by it, and
    // clears the pending-save timer. The snapshot reads the live store values
    // directly (see saveSnapshot.ts), so it reflects unflushed edits and bumps
    // neither revision nor generation.
    if (structured === true) {
      const snapshot = readStructuredSnapshot()
      const counts = {
        relics: snapshot.relics.length,
        characters: snapshot.characters.length,
      }
      return toolResult(
        {
          structured: true,
          snapshot,
          revision: runtimeContext.getRevision(),
          generation: runtimeContext.getSaveGeneration(),
          counts,
        },
        `只读结构化快照:${counts.relics} 件遗器、${counts.characters} 个角色`
          + '(未写入任何文件;含未落盘变更,与 export_save 写盘内容逐字段一致)',
      )
    }

    const target = path != null
      ? (isAbsolute(path) ? path : resolve(process.cwd(), path))
      : runtimeContext.getSave()!.path
    if (!target) {
      throw new Error('No target path: the current save was loaded from inline JSON — pass an explicit path')
    }

    const stateString = SaveState.save()
    if (!stateString) {
      throw new Error('SaveState.save() produced no output')
    }

    persistSaveFile(target, stateString, 'export_save')

    return toolResult(
      { exported: true, path: target, bytes: stateString.length },
      `已导出 ${stateString.length} 字节到 ${target}`,
    )
  })

  server.registerTool('save_status', {
    title: '当前存档状态',
    description: '报告当前已载入存档的概况——对应网页端维护的存档状态:来源路径、遗器/角色数量、未落盘标记(dirty,防抖写回 pending)、'
      + '最近一次 optimize 结果缓存(cacheId / 角色与行数)。'
      + 'revision 是变更修订号,每次已提交的状态变更(写工具、载入/清空存档)递增,只读工具不变——'
      + '读到它后在别处作为 baseRevision 传回即可检测中途插入的变更。'
      + 'generation 是存档世代,每次 load_save/clearSave 递增,优化结果缓存按它判旧。'
      + 'dirty=true 且 blockedWrite 非空表示存在被防擦写护栏拦截的写回:变更仍在内存中未落盘,刻意重置请用 export_save。'
      + 'bootLoaded=true 表示当前存档来自进程启动时的自动恢复(HSR_MCP_STATE_FILE 状态文件里的 state 键,'
      + '镜像网页打开即载入的 SaveState.load(false,false) 链;此时 path 为 null——状态文件后端是真源,与内联 JSON 同形态)。'
      + '设置 HSR_MCP_NO_BOOT_LOAD=1 可关闭该自动恢复。',
    inputSchema: {},
    outputSchema: {
      loaded: z.boolean(),
      path: z.string().nullable(),
      dirty: z.boolean(),
      revision: z.number().int(),
      generation: z.number().int(),
      relics: z.number().int(),
      characters: z.number().int(),
      characterIds: z.array(z.string()),
      bootLoaded: z.boolean().optional().describe('当前存档是否来自进程启动时的自动恢复(状态文件后端;此时 path 为 null)'),
      blockedWrite: z.object({
        at: z.number(),
        reason: z.string(),
      }).nullable(),
      lastOptimize: z.object({
        cacheId: z.string(),
        characterId: z.string(),
        rows: z.number().int(),
        at: z.number(),
      }).nullable(),
    },
  }, async () => {
    const save = runtimeContext.getSave()
    const last = runtimeContext.getLastOptimizeResult()
    const blockedWrite = runtimeContext.getLastBlockedWrite()
    const bootLoaded = runtimeContext.isBootLoaded()
    return toolResult(
      {
        loaded: save != null,
        path: save?.path ?? null,
        dirty: runtimeContext.isDirty(),
        revision: runtimeContext.getRevision(),
        generation: runtimeContext.getSaveGeneration(),
        ...(save ? saveCounts() : { relics: 0, characters: 0, characterIds: [] }),
        bootLoaded,
        blockedWrite,
        lastOptimize: last
          ? {
            cacheId: last.summary.cacheId,
            characterId: last.summary.characterId,
            rows: last.rows.length,
            at: last.at,
          }
          : null,
      },
      save
        ? `存档已载入${
          save.path ? `(来自 ${save.path})` : bootLoaded ? '(进程启动时自动恢复,状态文件后端为真源)' : '(内联 JSON)'
        }:${getRelics().length} 件遗器、${getCharacters().length} 个角色${runtimeContext.isDirty() ? '(有未落盘变更)' : ''}${
          blockedWrite ? `(写回被拦截:${blockedWrite.reason})` : ''
        }`
        : '尚未载入存档',
    )
  })

  server.registerTool('reset_all', {
    title: '重置全部数据',
    description: '清空遗器、角色与设置,恢复默认状态(上游 persistenceService.resetAll)——对应网页端设置页的「清除全部数据」。'
      + '默认只清内存状态:自动写回带擦写保护,不会把磁盘存档的遗器或角色清零(任一关键集合萎缩到零都会被拦截);'
      + '要把刻意的重置持久化到磁盘,随后调用 export_save,或直接传 persist=true。'
      + 'persist=true 镜像网页「清除数据」的自动落盘(上游 resetAll 经 permitEmptySave 放行空保存后 5 秒防抖落盘):'
      + '清除后立即把空状态(保留 seenFeatures 已读特性标记)经与 export_save 相同的写盘链'
      + '(符号链接护栏/存档形状护栏/临时文件原子替换)写回当前存档的载入路径,不等待防抖。'
      + '要求存档从文件路径载入——内联 JSON 或启动自动恢复(bootLoaded)的存档没有落盘目标,会报错说明,请改用 export_save(path=...) 显式指定。'
      + '可选 baseRevision 做乐观并发检查(与 update_state 同款):清除前状态已被其他变更改动即报冲突,存档保持原样。',
    inputSchema: {
      persist: z.boolean().optional().describe(
        'true=清除后立即把空状态写回当前存档的载入路径(镜像网页「清除数据」自动落盘;需文件路径载入的存档);'
          + '缺省/false=只清内存(自动写回被防擦写护栏拦截,磁盘存档保持原样,需另行 export_save)',
      ),
      baseRevision: z.number().int().optional().describe('乐观并发门:调用方读取状态时拿到的修订号;与当前不一致报冲突(在排队变更全部落地后检查),需重读后重试'),
    },
    outputSchema: {
      reset: z.boolean(),
      relics: z.number(),
      characters: z.number(),
      persisted: z.boolean().optional().describe('persist=true 时空状态已写回存档文件'),
      path: z.string().optional().describe('persist=true 时空状态写回的存档文件路径'),
      bytes: z.number().int().optional().describe('persist=true 时写回的字节数'),
    },
  }, async ({ persist, baseRevision }) => {
    runtimeContext.requireSave()
    // Fail fast, before any mutation: persist=true has no target when the save
    // came from inline JSON or the startup boot restore (path=null).
    const target = runtimeContext.getSave()!.path
    if (persist === true && target == null) {
      throw new Error(
        'reset_all(persist=true) 没有可写回的存档路径 — 当前存档来自内联 JSON 或进程启动时的自动恢复,磁盘上没有对应的存档文件。'
          + '请先 load_save(path=...) 从文件载入,或改用 export_save(path=...) 显式指定落盘目标。',
      )
    }
    await runtimeContext.withChange('reset_all', () => {
      persistenceService.resetAll()
      runtimeContext.markDirty()
    }, baseRevision != null ? { baseRevision } : {})

    if (persist === true) {
      // Web semantics: upstream resetAll already permitted the NEXT empty
      // save (persistenceService.ts:230 SaveState.permitEmptySave), but the
      // debounced flush scheduled by markDirty above may have consumed that
      // permit before this point (its file write was held by the wipe guard;
      // only the localStorage anti-wipe reference moved) — re-permit so the
      // serialization below can never be refused. Bytes are written after the
      // transaction committed, via the export_save chain (no wipe guard: the
      // emptying IS the caller's explicit intent, exactly like export_save).
      runtimeContext.cancelPendingFlush()
      SaveState.permitEmptySave()
      const stateString = SaveState.save()
      if (!stateString) {
        throw new Error(
          'reset_all(persist=true): SaveState.save() 拒绝序列化空状态(上游反擦写护栏) — 内存已重置并标记 dirty,'
            + '请改用 export_save(path=...) 把重置结果显式落盘。',
        )
      }
      persistSaveFile(target!, stateString, 'reset_all')
      return toolResult(
        { reset: true, relics: 0, characters: 0, persisted: true, path: target, bytes: stateString.length },
        `重置完成并已把空状态写回 ${target}(${stateString.length} 字节,seenFeatures 保留)——镜像网页「清除数据」的自动落盘`,
      )
    }
    return toolResult({ reset: true, relics: 0, characters: 0 }, '重置完成:遗器与角色已清空')
  })
}
