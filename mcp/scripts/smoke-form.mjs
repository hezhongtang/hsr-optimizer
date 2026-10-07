// M5-B form-domain smoke: update_form + the query/conditionals/simulation
// parameter extensions.
//
// Scenarios (all against the built server, temp-copied sample save):
//   1.  patch weights / main stats / flat filters → get_form round trip
//   2.  character switch via update_form(characterId=…) — the leaving
//       character's form is persisted (switch away & back, fields intact)
//   3.  preset apply (spd preset) → minSpd / resultSort
//   4.  reset filters → filter defaults restored, other fields kept
//   5.  conditionals patch syncs the combo default while preserving per-turn
//       overrides (get_form(expandCombo=true) before/after diff)
//   6.  combo matrix edit round trip (setActivation on a boolean conditional)
//   7.  fromBuild loads a saved build (eidolon max semantics)
//   8.  statSimulations add / duplicate rejection / delete + stat_simulate
//       saved=true and fromRelicIds import
//   9.  unknown patch field → Chinese error listing legal fields; type error
//       for a known field; stale baseRevision conflict leaves state untouched
//  10. warnings channel carries real validateForm output
//  11. default_form(spdPreset) variant + preset catalog; describe_conditionals
//       includeAbilities / includeSets blocks
//
// Usage: node scripts/smoke-form.mjs [serverEntry]

import {
  copyFileSync,
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

const tempDir = mkdtempSync(`${tmpdir}/hsr-mcp-smoke-form-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

const TARGET = '1212b1'
const OTHER = '1101'

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

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(`tool ${name} returned isError: ${result.content?.[0]?.text}`)
  }
  return payloadOf(result)
}

async function expectError(client, name, args, needle, label) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content?.find((c) => c.type === 'text')?.text ?? ''
  const ok = result.isError === true && text.includes(needle)
  check(label, ok, ok ? text.slice(0, 160) : `expected isError containing "${needle}", got: ${result.isError ? text.slice(0, 160) : '(no error)'}`)
  return text
}

async function getForm(client, characterId, expandCombo = false) {
  return callTool(client, 'get_form', { characterId, expandCombo })
}

try {
  const client = new Client({ name: 'smoke-form', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/state.json` },
    stderr: 'inherit',
  })
  await client.connect(transport)

  await callTool(client, 'load_save', { path: sampleSavePath })
  const before = await getForm(client, TARGET)
  const beforeWeights = before.form.weights

  // ── 1. patch → get_form round trip ─────────────────────────────────────
  const patched = await callTool(client, 'update_form', {
    characterId: TARGET,
    patch: {
      weights: { 'ATK%': 0.75, 'minWeightedRolls': 2 },
      mainBody: ['CRIT Rate', 'CRIT DMG'],
      minSpd: 134,
      combatBuffs: { ATK_P: 0.3 },
      enemyCount: 3,
    },
  })
  check('update_form(patch) commits', patched.updated === true && patched.characterId === TARGET, `revision=${patched.revision}`)
  const afterPatch = await getForm(client, TARGET)
  check('weights merged key-wise', afterPatch.form.weights['ATK%'] === 0.75 && afterPatch.form.weights['DEF%'] === beforeWeights['DEF%'])
  check('minWeightedRolls persisted', afterPatch.form.weights.minWeightedRolls === 2)
  check('mainBody replaced', JSON.stringify(afterPatch.form.mainBody) === JSON.stringify(['CRIT Rate', 'CRIT DMG']))
  check('flat minSpd round-trips (internal tolerance)', Math.abs(afterPatch.form.minSpd - 134) < 0.01, `minSpd=${afterPatch.form.minSpd}`)
  check('combatBuffs internal fraction persisted', Math.abs(afterPatch.form.combatBuffs.ATK_P - 0.3) < 1e-9)
  check('enemyCount persisted', afterPatch.form.enemyCount === 3)

  // ── 10a. warnings channel carries real validateForm output ────────────
  check(
    'warnings channel carries real validateForm output',
    Array.isArray(patched.warnings) && patched.warnings.length > 0,
    `warnings=${JSON.stringify(patched.warnings)}`,
  )

  // ── 9a. unknown field → Chinese error + legal field list ───────────────
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      patch: { wieghts: 1 },
    },
    '未知字段',
    'unknown patch field rejected with Chinese error',
  )
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      patch: { characterEidolon: 'six' },
    },
    '值无效',
    'known field with wrong type rejected',
  )
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      patch: { statSim: {} },
    },
    'statSimulations',
    'statSim patch redirected to statSimulations param',
  )

  // ── 2. character switch persists the leaving character's form ──────────
  const switchOut = await callTool(client, 'update_form', { characterId: OTHER })
  check('switch reports the leaving character', switchOut.characterId === OTHER && switchOut.switchedFrom === TARGET)
  const switchBack = await callTool(client, 'update_form', { characterId: TARGET })
  check('switch back lands on target', switchBack.characterId === TARGET && switchBack.switchedFrom === OTHER)
  const afterSwitch = await getForm(client, TARGET)
  check('leaving character form survived the switch', afterSwitch.form.weights['ATK%'] === 0.75 && afterSwitch.form.mainBody[0] === 'CRIT Rate')

  // ── 3. preset ───────────────────────────────────────────────────────────
  const presetRun = await callTool(client, 'update_form', {
    characterId: TARGET,
    preset: { spd: 133.334 },
  })
  const afterPreset = await getForm(client, TARGET)
  check('preset sets minSpd to the tier', Math.abs(afterPreset.form.minSpd - 133.334) < 0.01, `minSpd=${afterPreset.form.minSpd}`)
  check('preset with simulation scoring targets COMBO', afterPreset.form.resultSort === 'COMBO', `resultSort=${afterPreset.form.resultSort}`)
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      preset: { spd: 123.456 },
    },
    '速度档位',
    'off-catalog spd tier rejected',
  )

  // ── 4. reset filters ────────────────────────────────────────────────────
  await callTool(client, 'update_form', {
    characterId: TARGET,
    patch: { enhance: 12, grade: 4, keepCurrentRelics: true },
  })
  const constrained = await getForm(client, TARGET)
  check('filter patch applied before reset', constrained.form.enhance === 12 && constrained.form.grade === 4)
  await callTool(client, 'update_form', { characterId: TARGET, reset: 'filters' })
  const afterReset = await getForm(client, TARGET)
  check('reset restores filter defaults', afterReset.form.enhance === 9 && afterReset.form.grade === 5 && afterReset.form.keepCurrentRelics === false)
  check('reset keeps non-filter fields', afterReset.form.enemyCount === 3 && afterReset.form.resultSort === 'COMBO')

  // ── 6. combo matrix edit round trip ────────────────────────────────────
  await callTool(client, 'update_form', { characterId: TARGET, combo: { comboType: 'advanced' } })
  const matrix1 = (await getForm(client, TARGET, true)).combo
  const charEntity = matrix1.entities.find((e) => e.sourceKey === 'comboCharacter')
  check('expanded combo matrix has the main character entity', charEntity != null && charEntity.conditionals.length > 0)
  const booleanCond = charEntity.conditionals.find((c) => c.type === 'boolean' && c.activations.length > 2)
  check('boolean conditional available for matrix edits', booleanCond != null, `id=${booleanCond?.id}`)
  if (booleanCond) {
    const flipped = !booleanCond.activations[1]
    await callTool(client, 'update_form', {
      characterId: TARGET,
      combo: {
        edits: [
          { kind: 'setActivation', target: 'comboCharacter', id: booleanCond.id, index: 1, value: flipped },
        ],
      },
    })
    const matrix2 = (await getForm(client, TARGET, true)).combo
    const cond2 = matrix2.entities.find((e) => e.sourceKey === 'comboCharacter').conditionals.find((c) => c.id === booleanCond.id)
    check(
      'combo matrix edit round-trips',
      cond2.activations[1] === flipped && cond2.activations[0] === booleanCond.activations[0],
      `activations[1]=${cond2.activations[1]}`,
    )

    // ── 5. conditional patch syncs the combo default, preserves overrides ─
    const newDefault = !cond2.defaultValue
    const condPatch = await callTool(client, 'update_form', {
      characterId: TARGET,
      patch: { characterConditionals: { [booleanCond.id]: newDefault } },
    })
    const matrix3 = (await getForm(client, TARGET, true)).combo
    const cond3 = matrix3.entities.find((e) => e.sourceKey === 'comboCharacter').conditionals.find((c) => c.id === booleanCond.id)
    check('conditional patch syncs combo default slot', cond3.defaultValue === newDefault && cond3.activations[0] === newDefault)
    check('per-turn override preserved by the linkage', cond3.activations[1] === flipped, `activations[1]=${cond3.activations[1]} (expected ${flipped})`)
    void condPatch
  }

  // ── 7. fromBuild ────────────────────────────────────────────────────────
  await callTool(client, 'update_form', { characterId: TARGET, patch: { characterEidolon: 3 } })
  await callTool(client, 'save_build', { characterId: TARGET, name: 'm5-snap' })
  await callTool(client, 'update_form', { characterId: TARGET, patch: { characterEidolon: 0 } })
  const lowered = await getForm(client, TARGET)
  check('eidolon lowered before fromBuild', lowered.form.characterEidolon === 0)
  await callTool(client, 'update_form', { characterId: TARGET, fromBuild: 'm5-snap' })
  const afterBuild = await getForm(client, TARGET)
  check('fromBuild restores the build eidolon (max semantics)', afterBuild.form.characterEidolon === 3)
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      fromBuild: 'no-such-build',
    },
    '没有名为',
    'unknown build name rejected',
  )

  // ── 8. statSimulations + stat_simulate saved / fromRelicIds ────────────
  const simRequest = {
    simRelicSet1: 'Hunter of Glacial Forest',
    simRelicSet2: 'Hunter of Glacial Forest',
    simOrnamentSet: 'Rutilant Arena',
    simBody: 'CRIT DMG',
    simFeet: 'SPD',
    simPlanarSphere: 'Fire DMG Boost',
    simLinkRope: 'ATK%',
    stats: { 'CRIT DMG': 10, 'SPD': 6 },
  }
  const simAdd = await callTool(client, 'update_form', {
    characterId: TARGET,
    statSimulations: { add: [{ name: 'simA', request: simRequest }] },
  })
  check('statSimulations add persists', simAdd.statSimulations.total === 1 && simAdd.statSimulations.simulations[0].name === 'simA')
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      statSimulations: { add: [{ name: 'simA-dup', request: simRequest }] },
    },
    '完全相同',
    'duplicate simulation rejected like the web',
  )
  const savedRun = await callTool(client, 'stat_simulate', { characterId: TARGET, saved: true })
  check('stat_simulate(saved) runs the persisted list', savedRun.source === 'saved' && savedRun.variants.length === 1 && savedRun.variants[0].name === 'simA')
  check('stat_simulate(saved) orders by resultSort', savedRun.orderedByResultSort === true)

  const relics = await callTool(client, 'list_relics', { characterId: TARGET, limit: 6 })
  const importRun = await callTool(client, 'stat_simulate', {
    characterId: TARGET,
    fromRelicIds: relics.relics.map((r) => r.id),
  })
  check(
    'stat_simulate(fromRelicIds) imports and runs',
    importRun.source === 'imported' && importRun.variants.length === 1 && importRun.importedSimulation != null,
  )
  const afterImport = await getForm(client, TARGET)
  check('imported simulation saved to the form', afterImport.form.statSim?.simulations?.length === 2)

  const simDelete = await callTool(client, 'update_form', {
    characterId: TARGET,
    statSimulations: { delete: { keys: [simAdd.statSimulations.simulations[0].key] } },
  })
  check('statSimulations delete removes the entry', simDelete.statSimulations.total === 1)
  await callTool(client, 'update_form', { characterId: TARGET, statSimulations: { deleteAll: true } })
  const afterClear = await getForm(client, TARGET)
  check('statSimulations deleteAll empties the list', (afterClear.form.statSim?.simulations?.length ?? 0) === 0)
  await expectError(client, 'stat_simulate', { characterId: TARGET, saved: true }, '没有已保存的假想配装', 'saved with empty list errors')

  // ── 9b. stale baseRevision conflicts and leaves state untouched ────────
  const revisionNow = (await callTool(client, 'get_state', { section: 'revision' })).revision.revision
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      patch: { enemyCount: 5 },
      baseRevision: revisionNow - 1,
    },
    '修订号冲突',
    'stale baseRevision rejected',
  )
  const afterConflict = await getForm(client, TARGET)
  check('conflicted patch did not apply', afterConflict.form.enemyCount === 3, `enemyCount=${afterConflict.form.enemyCount}`)
  const validRev = await callTool(client, 'update_form', {
    characterId: TARGET,
    patch: { enemyCount: 5 },
    baseRevision: revisionNow,
  })
  check('current baseRevision commits', validRev.revision > revisionNow && (await getForm(client, TARGET)).form.enemyCount === 5)

  // ── 11. default_form(spdPreset) + describe_conditionals extensions ─────
  const spdForm = await callTool(client, 'default_form', { characterId: TARGET, spdPreset: 133.334 })
  check('default_form(spdPreset) applies the tier', Math.abs(spdForm.form.minSpd - 133.334) < 0.01 && spdForm.availableSpdPresets?.length > 0)
  await expectError(client, 'default_form', { characterId: TARGET, spdPreset: 123.456 }, '速度档位', 'off-catalog default_form spdPreset rejected')
  const described = await callTool(client, 'describe_conditionals', {
    characterId: TARGET,
    includeAbilities: true,
    includeSets: true,
  })
  const abilityNames = described.abilities.groups.flatMap((g) => g.options.map((o) => o.name))
  check(
    'describe_conditionals(includeAbilities) lists abilities',
    described.abilities.groups.length > 0 && abilityNames.some((n) => n === 'DEFAULT_SKILL') && abilityNames.some((n) => n === 'DEFAULT_ULT'),
  )
  check(
    'describe_conditionals(includeSets) lists set conditionals',
    described.sets.total > 0 && described.sets.entries.some((e) => e.modifiable && e.options != null),
  )

  // ── 12. statSim list survives switching away from the character (P0 fix) ─
  const simReAdd = await callTool(client, 'update_form', {
    characterId: TARGET,
    statSimulations: { add: [{ name: 'survivor', request: simRequest }] },
  })
  check('sim re-added before the switch-away probe', simReAdd.statSimulations.total === 1)
  await callTool(client, 'update_form', { characterId: OTHER, patch: { enemyCount: 4 } })
  const afterAway = await getForm(client, TARGET)
  check(
    'switching away does NOT wipe the leaving character\'s saved statSim list',
    (afterAway.form.statSim?.simulations?.length ?? 0) === 1 && afterAway.form.statSim.simulations[0].name === 'survivor',
    `simulations=${JSON.stringify(afterAway.form.statSim?.simulations?.map((s) => s.name))}`,
  )
  await callTool(client, 'update_form', { characterId: TARGET, statSimulations: { deleteAll: true } })

  // ── 13. legacy weights key topPercent: warned AND actually dropped ───────
  const legacyWarn = await callTool(client, 'update_form', {
    characterId: TARGET,
    patch: { weights: { 'ATK%': 0.8, 'topPercent': 0.7 } },
  })
  const legacyAfter = await getForm(client, TARGET)
  check(
    'topPercent warned and truly dropped (warning matches behavior)',
    legacyWarn.warnings.some((w) => w.includes('topPercent')) && !('topPercent' in (legacyAfter.form.weights ?? {})),
    `warnings=${JSON.stringify(legacyWarn.warnings)} weightsKeys=${Object.keys(legacyAfter.form.weights ?? {}).join(',')}`,
  )

  // ── 14. combo edits bounds ───────────────────────────────────────────────
  await expectError(
    client,
    'update_form',
    {
      characterId: TARGET,
      combo: { comboType: 'advanced', edits: [{ kind: 'setActivation', target: 'comboCharacter', id: booleanCond?.id ?? 'e1', index: 999, value: true }] },
    },
    '超出技能位范围',
    'combo edit index beyond the matrix width rejected',
  )

  // ── 15. combo: setBooleanDefault / addPartition / deletePartition / sets ──
  if (booleanCond != null) {
    const boolEdit = await callTool(client, 'update_form', {
      characterId: TARGET,
      combo: { edits: [{ kind: 'setBooleanDefault', target: 'comboCharacter', id: booleanCond.id, value: false }] },
    })
    check('setBooleanDefault applied (combo summary echoes edit)', boolEdit.applied.comboEdits === 1 && boolEdit.updated === true)
  }
  const numberCond = charEntity?.conditionals.find((c) => c.type !== 'boolean' && c.partitions && c.partitions.length > 0)
  if (numberCond != null) {
    const added = await callTool(client, 'update_form', {
      characterId: TARGET,
      combo: { edits: [{ kind: 'addPartition', target: 'comboCharacter', id: numberCond.id, value: 3 }] },
    })
    const afterAdd = await getForm(client, TARGET, true)
    const addedCond = afterAdd.combo?.entities.find((e) => e.sourceKey === 'comboCharacter')?.conditionals.find((c) => c.id === numberCond.id)
    check(
      'addPartition grows the partition list',
      (addedCond?.partitions?.length ?? 0) === numberCond.partitions.length + 1,
      `partitions=${addedCond?.partitions?.length}`,
    )
    const removed = await callTool(client, 'update_form', {
      characterId: TARGET,
      combo: { edits: [{ kind: 'deletePartition', target: 'comboCharacter', id: numberCond.id, partitionIndex: addedCond.partitions.length - 1 }] },
    })
    const afterRemove = await getForm(client, TARGET, true)
    const removedCond = afterRemove.combo?.entities.find((e) => e.sourceKey === 'comboCharacter')?.conditionals.find((c) => c.id === numberCond.id)
    check(
      'deletePartition restores the partition count',
      removed.updated === true && (removedCond?.partitions?.length ?? 0) === numberCond.partitions.length,
      `partitions=${removedCond?.partitions?.length}`,
    )
  }
  const setsEdit = await callTool(client, 'update_form', {
    characterId: TARGET,
    combo: { displayedSets: { relics: ['Hunter of Glacial Forest'] } },
  })
  const afterSets = await getForm(client, TARGET, true)
  check(
    'displayedSets round-trips through the drawer state',
    setsEdit.updated === true && afterSets.combo?.displayedSets?.relics?.includes('Hunter of Glacial Forest') === true,
    `relics=${JSON.stringify(afterSets.combo?.displayedSets?.relics)}`,
  )

  // ── 16. statSimulations overwrite + load ────────────────────────────────
  const simSeed2 = await callTool(client, 'update_form', {
    characterId: TARGET,
    statSimulations: { add: [{ name: 'ow1', request: simRequest }] },
  })
  const owKey = simSeed2.statSimulations.simulations[0].key
  const overwritten = await callTool(client, 'update_form', {
    characterId: TARGET,
    statSimulations: { overwrite: { key: owKey, request: { ...simRequest, stats: { ...simRequest.stats, SPD: 10 } } } },
  })
  const afterOw = await getForm(client, TARGET)
  check(
    'statSimulations overwrite replaces in place (total unchanged, new content)',
    overwritten.statSimulations.total === 1 && afterOw.form.statSim.simulations[0].request.stats.SPD === 10,
    `total=${overwritten.statSimulations.total} SPD=${afterOw.form.statSim.simulations[0].request.stats.SPD}`,
  )
  const loaded = await callTool(client, 'update_form', {
    characterId: TARGET,
    statSimulations: { load: { key: afterOw.form.statSim.simulations[0].key } },
  })
  check(
    'statSimulations.load backfills the input area',
    loaded.applied.statSimulations.loadedKey === afterOw.form.statSim.simulations[0].key && loaded.updated === true,
  )

  // ── 17. teammates: roster bring-in + lightCone switch resets LC conditionals ─
  const rosterIn = await callTool(client, 'update_form', {
    characterId: TARGET,
    teammates: [{ characterId: OTHER }],
    syncFromRoster: true,
  })
  const teamAfterIn = await getForm(client, TARGET)
  const lcCondAfterIn = teamAfterIn.form.teammate0?.lightConeConditionals ?? {}
  check(
    'syncFromRoster brings the teammate with her lightCone (23003 seeds postSkillDmgBuff)',
    teamAfterIn.form.teammate0?.lightCone === '23003' && lcCondAfterIn.postSkillDmgBuff === true,
    `lc=${teamAfterIn.form.teammate0?.lightCone} cond=${JSON.stringify(lcCondAfterIn)}`,
  )
  const lcSwitch = await callTool(client, 'update_form', {
    characterId: TARGET,
    teammates: [{ lightCone: '21011' }],
  })
  const teamAfterSwitch = await getForm(client, TARGET)
  const lcCondAfterSwitch = teamAfterSwitch.form.teammate0?.lightConeConditionals ?? {}
  check(
    'teammate lightCone switch resets LC conditionals to the new cone defaults (no stale keys)',
    teamAfterSwitch.form.teammate0?.lightCone === '21011'
      && lcCondAfterSwitch.alliesSameElement === true
      && !('postSkillDmgBuff' in lcCondAfterSwitch),
    `cond=${JSON.stringify(lcCondAfterSwitch)}`,
  )
  const cleared = await callTool(client, 'update_form', {
    characterId: TARGET,
    teammates: [null],
  })
  const teamAfterClear = await getForm(client, TARGET)
  check('teammates slot null clears the slot', cleared.updated === true && (teamAfterClear.form.teammate0?.characterId ?? null) === null)

  // ── 18. statDisplay / memoDisplay patch round trip + enum rejection ──────
  const displayPatch = await callTool(client, 'update_form', {
    characterId: TARGET,
    patch: { statDisplay: 'base', memoDisplay: 'summoner' },
  })
  const displayAfter = await getForm(client, TARGET)
  check(
    'statDisplay/memoDisplay round-trip',
    displayPatch.updated === true && displayAfter.form.statDisplay === 'base' && displayAfter.form.memoDisplay === 'summoner',
    `statDisplay=${displayAfter.form.statDisplay} memoDisplay=${displayAfter.form.memoDisplay}`,
  )
  await expectError(
    client,
    'update_form',
    { characterId: TARGET, patch: { statDisplay: 'both' } },
    'statDisplay',
    'invalid statDisplay enum rejected',
  )
  await callTool(client, 'update_form', { characterId: TARGET, patch: { statDisplay: 'combat', memoDisplay: 'memo' } })

  await client.close()
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nsmoke-form: ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nsmoke-form: ALL CHECKS PASSED')
