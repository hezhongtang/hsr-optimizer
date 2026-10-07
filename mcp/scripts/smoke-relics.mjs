// End-to-end smoke test for the relic inventory CRUD surface (M5):
// upsert_relic / delete_relics over stdio against the built server.
//
// Walks the Relic editor's save path the web uses:
//   load_save (temp copy) → upsert new relic (editor defaults, normalization)
//   → edit (substats/enhance/main-stat recompute) → optimistic-concurrency reject
//   → equippedBy to an empty character → transfer to an equipped character
//   → part change while equipped (old slot cleared, main stat reset)
//   → equippedBy=null unequip → previewUpgrade (no write) → dryRun (no write)
//   → invalid payloads rejected with actionable Chinese errors
//   → export_save → load back → the new relic persisted
//   → delete an equipped relic (character.equipped cleaned)
//   → delete an unknown id (error, nothing deleted)
//
// Everything persists into a temp directory (save copy + HSR_MCP_STATE_FILE);
// the repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-relics.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

const CHAR_EMPTY = '1105' // Natasha — no equipped relics in the sample save
const CHAR_A = '1212b1' // 6 equipped (Head cd85c14c…, Hands 798657c8…)
const A_ORIGINAL_HEAD = 'cd85c14c-a662-4413-a149-a379e6d538d3'
const A_ORIGINAL_HANDS = '798657c8-5c5c-4b44-9c5f-f5f094414289'

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-relics-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

/** Expect the call to fail; return the error text (null when it unexpectedly succeeded). */
async function errorTextOf(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) return null
  return result.content?.find((c) => c.type === 'text')?.text ?? '(no text)'
}

async function relicById(client, id) {
  const relics = await callTool(client, 'list_relics', { limit: 500 })
  return relics.relics.find((r) => r.id === id) ?? null
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-relics', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  // 1. tool surface
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t) => t.name)
  check('tool upsert_relic registered', toolNames.includes('upsert_relic'))
  check('tool delete_relics registered', toolNames.includes('delete_relics'))

  // 2. load sample save (temp copy — write-backs target it)
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save relics = 162', loaded.relics === 162, `got ${loaded.relics}`)

  // 3. upsert a new relic — editor defaults for part/set/main stat (web
  //    computeInitialFormValues: Head / 5★ / +15 / first main of the part),
  //    normalization by RelicAugmenter (main value derived, rolls resolved)
  const created = await callTool(client, 'upsert_relic', {
    substats: [
      { stat: 'CRIT DMG', value: 6.4 },
      { stat: 'SPD', value: 5.1 },
      { stat: 'ATK%', value: 9.4 },
    ],
    previewSubstats: [{ stat: 'Effect Hit Rate', value: 3.4 }],
  })
  const relicId = created.relicId
  check('upsert_relic creates (created=true, persisted=true)', created.created === true && created.persisted === true)
  check('upsert_relic default part = Head', created.relic.part === 'Head', created.relic.part)
  check('upsert_relic default grade/enhance = 5★/+15', created.relic.grade === 5 && created.relic.enhance === 15)
  check('upsert_relic default main stat = HP', created.relic.main.stat === 'HP', created.relic.main.stat)
  check(
    'upsert_relic main value derived from grade+enhance (705.6 for HP head +15, RelicRollFixer metadata口径 — the web stores the same)',
    Math.abs(created.relic.main.value - 705.6) < 0.01,
    `main.value=${created.relic.main.value}`,
  )
  check('upsert_relic default set resolved', typeof created.relic.set === 'string' && created.relic.set.length > 0, created.relic.set)
  check('upsert_relic new relic verified=false', created.relic.verified === false)
  check(
    'upsert_relic substats normalized with rolls',
    created.relic.substats.length === 3
      && created.relic.substats.every((s) => s.rolls != null && typeof s.addedRolls === 'number'),
  )
  check(
    'upsert_relic previewSubstats stored separately',
    created.relic.previewSubstats?.length === 1
      && created.relic.previewSubstats[0].stat === 'Effect Hit Rate',
    JSON.stringify(created.relic.previewSubstats),
  )
  check(
    'upsert_relic initialRolls computed by the roll grader',
    typeof created.relic.initialRolls === 'number' && created.relic.initialRolls >= 0,
    `initialRolls=${created.relic.initialRolls} (roll-grader derived — value realism decides, upstream semantics)`,
  )
  check('upsert_relic starts unequipped', created.relic.equippedBy === undefined)
  const listed = await relicById(client, relicId)
  check('list_relics sees the new relic (total 163)', listed != null && (await callTool(client, 'list_relics', { limit: 1 })).total === 163)

  // 4. edit: change enhance + replace substats; main value follows enhance;
  //    unspecified equippedBy keeps "unequipped"
  const edited = await callTool(client, 'upsert_relic', {
    relicId,
    enhance: 9,
    substats: [
      { stat: 'CRIT DMG', value: 12.9 },
      { stat: 'SPD', value: 5.1 },
      { stat: 'ATK%', value: 9.4 },
      { stat: 'Effect Hit Rate', value: 3.4 },
    ],
    previewSubstats: [],
  })
  check('upsert_relic edit (created=false, id stable)', edited.created === false && edited.relicId === relicId)
  check('upsert_relic edit updates substats (preview cleared by [])', edited.relic.substats.length === 4 && edited.relic.previewSubstats.length === 0)
  const mainAt15 = created.relic.main.value
  check(
    'upsert_relic edit recomputes main value from enhance (705.6 → 468.5184 at +9)',
    edited.relic.enhance === 9 && edited.relic.main.value < mainAt15 && Math.abs(edited.relic.main.value - 468.5184) < 0.01,
    `main.value ${mainAt15} → ${edited.relic.main.value}`,
  )
  check('upsert_relic edit keeps verified=false after content change', edited.relic.verified === false)

  // 5. optimistic concurrency: a stale baseRevision must be rejected inside
  //    the change scope and roll back (enhance stays 9)
  const revisionState = await callTool(client, 'get_state', { section: 'revision' })
  const staleRevision = revisionState.revision.revision - 1
  const conflictText = await errorTextOf(client, 'upsert_relic', { relicId, enhance: 12, baseRevision: staleRevision })
  check(
    'upsert_relic rejects a stale baseRevision (修订号冲突)',
    conflictText != null && conflictText.includes('修订号冲突'),
    String(conflictText).slice(0, 120),
  )
  check('conflicting edit rolled back (enhance still 9)', (await relicById(client, relicId)).enhance === 9)

  // 6. equip to the empty character (no displaced relic; owner change only)
  const equippedEmpty = await callTool(client, 'upsert_relic', { relicId, equippedBy: CHAR_EMPTY })
  check('equippedBy equips (relic.equippedBy set)', equippedEmpty.relic.equippedBy === CHAR_EMPTY)
  check(
    'equippedBy narrates the move null → character',
    equippedEmpty.changes.length === 1 && equippedEmpty.changes[0].from === null && equippedEmpty.changes[0].to === CHAR_EMPTY,
    JSON.stringify(equippedEmpty.changes),
  )
  const charEmptyAfter = await callTool(client, 'get_character', { characterId: CHAR_EMPTY })
  check('character.equipped now points at the relic (Head)', charEmptyAfter.equippedSlots.Head.equippedId === relicId)

  // 7. transfer to an equipped character: global Replace behavior — the
  //    character's old Head relic drops to inventory, the old owner's slot is
  //    cleared (upsertRelicWithEquipment → equipRelic path)
  const transferred = await callTool(client, 'upsert_relic', { relicId, equippedBy: CHAR_A })
  const transferMove = transferred.changes.find((c) => c.relicId === relicId)
  check(
    'transfer narrates owner change CHAR_EMPTY → CHAR_A',
    transferMove?.from === CHAR_EMPTY && transferMove?.to === CHAR_A,
    JSON.stringify(transferred.changes),
  )
  check(
    'transfer reports the global Replace setting',
    transferred.equippingBehavior.globalSetting === 'Replace',
    JSON.stringify(transferred.equippingBehavior),
  )
  const charEmptyAfterTransfer = await callTool(client, 'get_character', { characterId: CHAR_EMPTY })
  const charAAfterTransfer = await callTool(client, 'get_character', { characterId: CHAR_A })
  check('previous owner slot cleared', charEmptyAfterTransfer.equippedSlots.Head.equippedId === null)
  check('new owner Head slot = relic', charAAfterTransfer.equippedSlots.Head.equippedId === relicId)
  const displaced = await relicById(client, A_ORIGINAL_HEAD)
  check('displaced Head relic returned to inventory (Replace)', displaced != null && displaced.equippedBy === undefined, `equippedBy=${displaced?.equippedBy}`)

  // 8. part change while equipped (web: partChanged → unequip old slot, then
  //    re-equip): owner keeps the relic, the OLD slot is cleared, the Hands
  //    occupant is displaced, and the main stat resets to the new part's first
  //    option (computePartChangeUpdates)
  const partChanged = await callTool(client, 'upsert_relic', { relicId, part: 'Hands' })
  check(
    'part change resets main stat to Hands default (ATK)',
    partChanged.relic.part === 'Hands' && partChanged.relic.main.stat === 'ATK',
    `${partChanged.relic.part}/${partChanged.relic.main.stat}`,
  )
  check('part change keeps the owner (equippedBy untouched)', partChanged.relic.equippedBy === CHAR_A)
  const charAAfterPart = await callTool(client, 'get_character', { characterId: CHAR_A })
  check('old Head slot cleared after part change', charAAfterPart.equippedSlots.Head.equippedId === null)
  check('new Hands slot = relic', charAAfterPart.equippedSlots.Hands.equippedId === relicId)
  const oldHands = await relicById(client, A_ORIGINAL_HANDS)
  check('previous Hands occupant returned to inventory', oldHands != null && oldHands.equippedBy === undefined)

  // 9. equippedBy=null unequips this relic only
  const unequipped = await callTool(client, 'upsert_relic', { relicId, equippedBy: null })
  check('equippedBy=null unequips', unequipped.relic.equippedBy === undefined)
  check(
    'unequip narrates owner → null',
    unequipped.changes.some((c) => c.relicId === relicId && c.from === CHAR_A && c.to === null),
    JSON.stringify(unequipped.changes),
  )
  const charAAfterUnequip = await callTool(client, 'get_character', { characterId: CHAR_A })
  check('character Hands slot cleared', charAAfterUnequip.equippedSlots.Hands.equippedId === null)

  // 10. upgrade preview: per-substat low/mid/high values for one added roll,
  //     enhance bumps to the next multiple of 3 — and NOTHING is written
  const preview = await callTool(client, 'upsert_relic', { relicId, previewUpgrade: true })
  check('previewUpgrade does not persist (persisted=false, dryRun=true)', preview.persisted === false && preview.dryRun === true)
  check(
    'previewUpgrade enhanceAfter = next multiple of 3 (9 → 12)',
    preview.previewUpgrade?.enhanceAfter === 12,
    `enhanceAfter=${preview.previewUpgrade?.enhanceAfter}`,
  )
  check(
    'previewUpgrade returns low/mid/high above the current value for every substat',
    preview.previewUpgrade?.substats?.length === 4
      && preview.previewUpgrade.substats.every((s) => [s.low, s.mid, s.high].every((v) => typeof v === 'number' && v > s.value)),
    JSON.stringify(preview.previewUpgrade?.substats?.map((s) => [s.stat, s.low, s.mid, s.high])),
  )
  const afterPreview = await relicById(client, relicId)
  check('inventory unchanged after preview (enhance still 9)', afterPreview.enhance === 9 && afterPreview.equippedBy === undefined)

  // 11. dryRun: full validation + equipment-change preview without writing
  const dry = await callTool(client, 'upsert_relic', { relicId, equippedBy: CHAR_EMPTY, dryRun: true })
  check('dryRun does not persist', dry.persisted === false)
  check(
    'dryRun predicts the equip change without applying it',
    dry.changes.length === 1 && dry.changes[0].relicId === relicId && dry.changes[0].to === CHAR_EMPTY,
    JSON.stringify(dry.changes),
  )
  check('inventory still unequipped after dryRun', (await relicById(client, relicId)).equippedBy === undefined)

  // 12. invalid payloads → actionable Chinese errors, nothing written
  const errors = [
    {
      label: 'substat duplicating the main stat',
      args: { relicId, substats: [{ stat: 'ATK', value: 20 }] },
      pattern: /与主词条相同/,
    },
    {
      label: 'substats + previews exceeding 4 slots',
      args: {
        relicId,
        substats: [
          { stat: 'CRIT DMG', value: 6.4 },
          { stat: 'SPD', value: 5.1 },
          { stat: 'ATK%', value: 9.4 },
        ],
        previewSubstats: [
          { stat: 'Effect Hit Rate', value: 3.4 },
          { stat: 'Break Effect', value: 5.1 },
        ],
      },
      pattern: /超过上限 4/,
    },
    {
      label: 'enhance above the grade cap',
      args: { relicId, grade: 3, enhance: 15 },
      pattern: /星级×3/,
    },
    {
      label: 'unknown substat name',
      args: { relicId, substats: [{ stat: 'Crit Dmg', value: 6.4 }] },
      pattern: /副词条名 .* 无效/,
    },
    {
      label: 'ornament set on a relic part',
      args: { relicId, set: 'Space Sealing Station' },
      pattern: /饰品套装/,
    },
    {
      label: 'equippedBy not in the save',
      args: { relicId, equippedBy: '9999' },
      pattern: /不在当前存档的角色列表中/,
    },
    {
      label: 'editing an unknown relic id',
      args: { relicId: 'no-such-relic', enhance: 3 },
      pattern: /库存中不存在遗器 id/,
    },
  ]
  for (const { label, args, pattern } of errors) {
    const text = await errorTextOf(client, 'upsert_relic', args)
    check(`rejects: ${label}`, text != null && pattern.test(text), String(text).slice(0, 140))
  }
  const afterErrors = await relicById(client, relicId)
  check(
    'rejected edits wrote nothing (enhance 9, 4 substats, unequipped)',
    afterErrors.enhance === 9 && afterErrors.substats.length === 4 && afterErrors.equippedBy === undefined,
  )

  // 13. persistence: export → reload keeps the new relic
  const exportPath = `${tempDir}/exported-save.json`
  const exported = await callTool(client, 'export_save', { path: exportPath })
  check('export_save wrote a file', existsSync(exportPath) && exported.bytes > 0, `${exported.bytes} bytes`)
  await callTool(client, 'load_save', { path: exportPath })
  const reloaded = await relicById(client, relicId)
  check(
    'reloaded save keeps the new relic (Hands/+9/4 substats/unequipped)',
    reloaded != null && reloaded.part === 'Hands' && reloaded.enhance === 9 && reloaded.substats.length === 4 && reloaded.equippedBy === undefined,
    reloaded == null ? 'relic missing' : `${reloaded.part} +${reloaded.enhance}, ${reloaded.substats.length} substats`,
  )

  // 14. delete an equipped relic: character.equipped reference cleaned
  await callTool(client, 'upsert_relic', { relicId, equippedBy: CHAR_EMPTY })
  const equippedForDelete = await relicById(client, relicId)
  check('relic re-equipped for the delete test', equippedForDelete.equippedBy === CHAR_EMPTY)
  const deleted = await callTool(client, 'delete_relics', { relicIds: [relicId] })
  check('delete_relics returns the deleted list', deleted.deleted.length === 1 && deleted.deleted[0] === relicId)
  check(
    'delete_relics reports the affected character + cleared slot',
    deleted.affectedCharacters.length === 1
      && deleted.affectedCharacters[0].characterId === CHAR_EMPTY
      && deleted.affectedCharacters[0].clearedSlots.includes('Hands'),
    JSON.stringify(deleted.affectedCharacters),
  )
  check(
    'delete_relics narrates the unequip (owner → null)',
    deleted.changes.some((c) => c.relicId === relicId && c.from === CHAR_EMPTY && c.to === null),
    JSON.stringify(deleted.changes),
  )
  check('inventory back to 162 relics', deleted.remaining === 162 && (await relicById(client, relicId)) === null)
  const charEmptyAfterDelete = await callTool(client, 'get_character', { characterId: CHAR_EMPTY })
  check('character.equipped reference cleaned by delete', charEmptyAfterDelete.equippedSlots.Hands.equippedId === null)

  // 15. deleting an unknown id errors and deletes nothing
  const deleteError = await errorTextOf(client, 'delete_relics', { relicIds: ['no-such-relic'] })
  check(
    'delete_relics rejects unknown ids with a Chinese error',
    deleteError != null && deleteError.includes('不存在') && deleteError.includes('未删除任何遗器'),
    String(deleteError).slice(0, 140),
  )
  const finalCount = await callTool(client, 'list_relics', { limit: 1 })
  check('failed delete left the inventory untouched (162)', finalCount.total === 162)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-relics: ALL CHECKS PASSED' : `\nsmoke-relics: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
