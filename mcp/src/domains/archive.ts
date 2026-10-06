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
import * as persistenceService from 'lib/services/persistenceService'
import { SaveState } from 'lib/state/saveState'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import type { HsrOptimizerSaveFormat } from 'types/store'
import { z } from 'zod'

import { runtimeContext } from '../context'
import {
  captureSaveStores,
  replaceSaveStores,
} from '../saveStores'
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

export function registerArchiveTools(server: McpServer): void {
  server.registerTool('load_save', {
    title: '载入存档文件',
    description: '载入一份 fribbels-optimizer-save.json 格式的存档文件,替换服务器当前已加载的全部状态——对应网页端把存档文件导入浏览器/换号载入的动作。'
      + '提供 path(绝对路径,或相对服务器工作目录)或内联 json 二选一,完整执行上游迁移链(旧版格式迁移、主词条迁移、配装迁移、装备重互链)。'
      + '载入后即可用 list_relics / optimize 等工具操作这份数据。',
    inputSchema: {
      path: z.string().optional().describe('存档文件路径(fribbels-optimizer-save.json)'),
      json: z.unknown().optional().describe('内联存档对象(与存档文件内容同 schema)'),
    },
    outputSchema: {
      loaded: z.boolean(),
      path: z.string().nullable(),
      relics: z.number().int(),
      characters: z.number().int(),
      characterIds: z.array(z.string()),
      // 直读用户存档文件的 version 字段——上游迁移链可能写出任意形状,不收紧
      version: z.unknown(),
    },
  }, async ({ path, json }) => {
    runtimeContext.ensureMetadataReady()

    if ((path == null) === (json == null)) {
      throw new Error('Provide exactly one of: path (file to load) or json (inline save object)')
    }

    let data: HsrOptimizerSaveFormat
    let resolvedPath: string | null = null

    if (path != null) {
      resolvedPath = isAbsolute(path) ? path : resolve(process.cwd(), path)
      if (!existsSync(resolvedPath)) {
        throw new Error(`Save file not found: ${resolvedPath}`)
      }
      data = parseSave(readFileSync(resolvedPath, 'utf8'), resolvedPath)
    } else {
      if (typeof json === 'string') {
        data = parseSave(json, 'inline json string')
      } else if (typeof json === 'object' && json !== null) {
        data = json as HsrOptimizerSaveFormat
        if (!Array.isArray(data.relics) || !Array.isArray(data.characters)) {
          throw new Error('Invalid inline save object: missing "relics" or "characters" array')
        }
      } else {
        throw new Error('json must be a save object or a JSON string')
      }
    }

    // loadSaveData mutates its input (migrations, equip re-linking) — keep a pristine clone
    const pristine = structuredClone(data)
    // The migration chain writes partial markers into the stores
    // (completedMigrations / seenFeatures / scoringOverrides) BEFORE it can
    // throw on malformed entries (e.g. a character missing `form` → TypeError
    // in migrateCharacterForm). Left as-is that is a chimera — new-save markers
    // + previous-save inventory — while loadedSave still points at the OLD
    // file, so the next flush would persist the chimera into it. Snapshot the
    // current stores up front, including edits not yet flushed to disk. Neither
    // snapshot nor rollback serializes, saves, or changes runtime ownership.
    const restoreStores = captureSaveStores()
    try {
      data = replaceSaveStores(data)
    } catch (e) {
      restoreStores()
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
    return toolResult(
      {
        loaded: true,
        path: resolvedPath,
        ...counts,
        version: data.version ?? null,
      },
      `已载入存档:${counts.relics} 件遗器、${counts.characters} 个角色${resolvedPath ? `(来自 ${resolvedPath})` : '(内联 JSON)'}`,
    )
  })

  server.registerTool('export_save', {
    title: '导出当前状态为存档文件',
    description: '把当前内存状态用上游 SaveState.save() 序列化并写回磁盘——对应网页端设置页的「导出存档」。'
      + '默认写回当前存档的载入路径;内联 JSON 载入的存档必须显式传 path。'
      + '写入带三道护栏:目标已是符号链接时拒绝(防止沿链接覆写任意文件);'
      + '目标文件已存在但不是存档形状(缺 relics/characters 数组)时拒绝(防止覆写 ~/.zshrc 等无关文件,刻意清空的存档仍是合法目标);'
      + '实际写入走同目录临时文件 + 原子 rename,中断不会留下半截文件。',
    inputSchema: {
      path: z.string().optional().describe('目标文件路径(默认写回载入时的存档路径)'),
    },
    outputSchema: {
      exported: z.boolean(),
      path: z.string(),
      bytes: z.number().int(),
    },
  }, async ({ path }) => {
    runtimeContext.requireSave()

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

    // Guardrail 1: never write through a symlink — lstat does not follow it
    try {
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(`Refusing to export over symlink ${target} — pass the real file path instead`)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }

    // Guardrail 2: overwriting an existing file requires it to look like a save
    // (both a relics and a characters array) so stray paths like ~/.zshrc are safe
    if (existsSync(target)) {
      parseSave(readFileSync(target, 'utf8'), `${target} (existing file targeted by export_save)`)
    }

    // Guardrail 3: atomic replace via a sibling temp file — an interrupted
    // export can never leave a truncated save behind
    const tmpPath = `${target}.tmp`
    writeFileSync(tmpPath, stateString)
    renameSync(tmpPath, target)

    // Refresh the snapshot future driver runs reload from; keep the loaded path stable
    const save = runtimeContext.getSave()!
    try {
      save.data = JSON.parse(stateString) as HsrOptimizerSaveFormat
    } catch {
      // Keep the previous snapshot if serialization somehow produced invalid JSON
    }

    return toolResult(
      { exported: true, path: target, bytes: stateString.length },
      `已导出 ${stateString.length} 字节到 ${target}`,
    )
  })

  server.registerTool('save_status', {
    title: '当前存档状态',
    description: '报告当前已载入存档的概况——对应网页端维护的存档状态:来源路径、遗器/角色数量、未落盘标记(dirty,防抖写回 pending)、'
      + '最近一次 optimize 结果缓存(cacheId / 角色与行数)。'
      + 'dirty=true 且 blockedWrite 非空表示存在被防擦写护栏拦截的写回:变更仍在内存中未落盘,刻意重置请用 export_save。',
    inputSchema: {},
    outputSchema: {
      loaded: z.boolean(),
      path: z.string().nullable(),
      dirty: z.boolean(),
      relics: z.number().int(),
      characters: z.number().int(),
      characterIds: z.array(z.string()),
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
    return toolResult(
      {
        loaded: save != null,
        path: save?.path ?? null,
        dirty: runtimeContext.isDirty(),
        ...(save ? saveCounts() : { relics: 0, characters: 0, characterIds: [] }),
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
        ? `存档已载入${save.path ? `(来自 ${save.path})` : '(内联 JSON)'}:${getRelics().length} 件遗器、${getCharacters().length} 个角色${
          runtimeContext.isDirty() ? '(有未落盘变更)' : ''
        }${blockedWrite ? `(写回被拦截:${blockedWrite.reason})` : ''}`
        : '尚未载入存档',
    )
  })

  server.registerTool('reset_all', {
    title: '重置全部数据',
    description: '清空遗器、角色与设置,恢复默认状态(上游 persistenceService.resetAll)——对应网页端设置页的「清除全部数据」。'
      + '只清内存状态:自动写回带擦写保护,不会把磁盘存档的遗器或角色清零(任一关键集合萎缩到零都会被拦截);'
      + '要把刻意的重置持久化到磁盘,随后调用 export_save。',
    inputSchema: {},
    outputSchema: {
      reset: z.boolean(),
      relics: z.number(),
      characters: z.number(),
    },
  }, async () => {
    runtimeContext.requireSave()
    persistenceService.resetAll()
    runtimeContext.markDirty()
    return toolResult({ reset: true, relics: 0, characters: 0 }, '重置完成:遗器与角色已清空')
  })
}
