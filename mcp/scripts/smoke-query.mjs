// End-to-end smoke test for the HSR Optimizer MCP server — query domain.
//
// Walks the query tool surface against the sample save (162 relics / 8
// characters), plus one synthetic optimizer-format saved build injected into a
// temp copy of the save (the pristine sample ships zero builds):
//   listTools (query tools present) → load_save → list_characters (8, filters)
//   → get_character (6 equipped relics, builds, scoring metadata)
//   → get_form (normalized form + field sources + legacy keys)
//   → default_form (provided LC + saved-form LC fallback)
//   → permutations (validPermutations === 462672, the foundation-phase optimize
//   measured value — proves the estimate uses the same path as the gate)
//   → permutations with formOverrides → list_relics enhancements (characterId
//   filter + sorting) → web filter parity for both lists: list_characters
//   three-axis filtering (name substring on the zh LongName + path/element
//   multi-select, CharacterGrid.tsx:136-146) and list_relics pill semantics
//   (groups AND / values OR-in, enhance tier x..x+2, subStat AND-across-stats
//   incl. preview substats, initialRolls defaulting to 3, equipped/verified —
//   RelicsGrid.tsx:146-166).
//
// Everything the server can persist is pointed at a temp directory — the
// repo's sample-save.json is never a write target.
//
// Usage: node scripts/smoke-query.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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

// Foundation-phase optimize measured this for character 1212b1 with the
// sample save — the permutations tool MUST reproduce it exactly.
const EXPECTED_VALID_PERMUTATIONS = 462672

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-query-`)
const sampleSavePath = `${tempDir}/sample-save.json`

// Copy + inject one optimizer-format saved build on 1212b1 so the builds
// serialization path has real data to chew on (pristine sample has none).
const sampleSave = JSON.parse(readFileSync(repoSampleSavePath, 'utf8'))
const target = sampleSave.characters.find((c) => c.id === '1212b1')
const teammateDonor = sampleSave.characters.find((c) => c.id === '1101')
target.builds = [{
  name: 'smoke-build',
  source: 'optimizer',
  characterId: '1212b1',
  equipped: target.equipped,
  characterEidolon: 1,
  lightCone: '23014',
  lightConeSuperimposition: 1,
  scoringConfigType: 'dps',
  team: [
    {
      characterId: '1101',
      characterEidolon: 0,
      lightCone: teammateDonor.form.lightCone,
      lightConeSuperimposition: 1,
      teamRelicSet: undefined,
      teamOrnamentSet: undefined,
      characterConditionals: { teammateBuff: true },
      lightConeConditionals: {},
    },
    null,
    null,
  ],
  characterConditionals: { talentEnhanced: true },
  lightConeConditionals: {},
  setConditionals: {},
  comboType: 'simple',
  comboStateJson: JSON.stringify({ rotationActions: [{}, {}, {}] }),
  comboPreprocessor: true,
  comboTurnAbilities: ['BASIC'],
  deprioritizeBuffs: false,
}]
writeFileSync(sampleSavePath, JSON.stringify(sampleSave))

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

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-query', version: '0.0.0' })
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
  for (const required of ['list_characters', 'get_character', 'get_form', 'default_form', 'permutations', 'list_relics']) {
    check(`tool ${required} registered`, toolNames.includes(required))
  }

  // 2. load the temp save copy (with the injected build)
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save characters = 8', loaded.characters === 8, `got ${loaded.characters}`)

  // 3. list_characters
  const characters = await callTool(client, 'list_characters', {})
  check('list_characters total = 8', characters.total === 8, `got ${characters.total}`)
  const jingliu = characters.characters.find((c) => c.id === '1212b1')
  check(
    'list_characters has 1212b1 summary',
    jingliu != null && jingliu.rank === 0 && jingliu.name === 'Jingliu' && jingliu.path === 'Destruction'
      && jingliu.element === 'Ice' && jingliu.rarity === 5,
    JSON.stringify(jingliu),
  )
  check(
    'list_characters equipped/builds summary',
    jingliu.equippedCount === 6 && jingliu.allSlotsEquipped === true && jingliu.savedBuilds === 1,
    `equipped=${jingliu?.equippedCount}, builds=${jingliu?.savedBuilds}`,
  )
  check(
    'list_characters scoringConfigTypes includes dps',
    Array.isArray(jingliu.scoringConfigTypes) && jingliu.scoringConfigTypes.includes('dps'),
    JSON.stringify(jingliu?.scoringConfigTypes),
  )

  const destructionOnly = await callTool(client, 'list_characters', { path: 'Destruction' })
  check(
    'list_characters path filter',
    destructionOnly.total > 0 && destructionOnly.total < 8
      && destructionOnly.characters.every((c) => c.path === 'Destruction'),
    `${destructionOnly.total} Destruction characters`,
  )
  const iceOnly = await callTool(client, 'list_characters', { element: 'Ice' })
  check(
    'list_characters element filter',
    iceOnly.total > 0 && iceOnly.characters.every((c) => c.element === 'Ice'),
    `${iceOnly.total} Ice characters`,
  )

  // 3b. web filter-bar parity (CharacterGrid.tsx:136-146): name = case-insensitive
  //     substring on the current-language LongName (server renders zh_CN → 中文
  //     长名, exactly what the web's Chinese UI matches); path/element = OR-in.
  const byZhName = await callTool(client, 'list_characters', { name: '流' })
  check(
    'list_characters name substring matches the zh LongName (流 → 镜流)',
    byZhName.total === 1 && byZhName.characters[0]?.id === '1212b1',
    `${byZhName.total}: ${byZhName.characters.map((c) => c.id).join(',')}`,
  )
  const latinMiss = await callTool(client, 'list_characters', { name: 'Jingliu' })
  check(
    'list_characters name matches the localized LongName only (Latin needle misses, web zh behavior)',
    latinMiss.total === 0,
    `got ${latinMiss.total}`,
  )
  const emptyArrays = await callTool(client, 'list_characters', { path: [], element: [] })
  check(
    'list_characters empty arrays mean no constraint (empty pill selection)',
    emptyArrays.total === 8,
    `got ${emptyArrays.total}`,
  )

  // 3c. multi-select OR-in + the three axes ANDed together
  const twoPaths = ['Destruction', 'Harmony']
  const expectedPaths = characters.characters.filter((c) => twoPaths.includes(c.path))
  const multiPath = await callTool(client, 'list_characters', { path: twoPaths })
  check(
    'list_characters path multi-select OR-in',
    multiPath.total === expectedPaths.length
      && multiPath.characters.every((c) => twoPaths.includes(c.path))
      && expectedPaths.every((e) => multiPath.characters.some((c) => c.id === e.id)),
    `${multiPath.total} of ${characters.total} (${twoPaths.join('/')})`,
  )
  const twoElements = [...new Set(characters.characters.map((c) => c.element))].slice(0, 2)
  const expectedElements = characters.characters.filter((c) => twoElements.includes(c.element))
  const multiElement = await callTool(client, 'list_characters', { element: twoElements })
  check(
    'list_characters element multi-select OR-in',
    multiElement.total === expectedElements.length
      && multiElement.characters.every((c) => twoElements.includes(c.element))
      && expectedElements.every((e) => multiElement.characters.some((c) => c.id === e.id)),
    `${multiElement.total} of ${characters.total} (${twoElements.join('/')})`,
  )
  const kafka = characters.characters.find((c) => c.id === '1005')
  const threeAxes = await callTool(client, 'list_characters', {
    name: '卡芙卡',
    path: [kafka.path, 'Destruction'],
    element: [kafka.element],
  })
  check(
    'list_characters three filter axes AND together (name + path[] + element[])',
    threeAxes.total === 1 && threeAxes.characters[0]?.id === '1005',
    `total=${threeAxes.total}: ${threeAxes.characters.map((c) => c.id).join(',')}`,
  )

  // 4. get_character
  const detail = await callTool(client, 'get_character', { characterId: '1212b1' })
  const slotNames = Object.keys(detail.equippedSlots)
  const equippedIds = slotNames.map((slot) => detail.equippedSlots[slot].equippedId)
  check(
    'get_character has 6 equipped slots',
    slotNames.length === 6 && equippedIds.every((id) => id != null),
    `slots: ${slotNames.join(',')}`,
  )
  check(
    'get_character equipped relics fully serialized',
    slotNames.every((slot) => {
      const entry = detail.equippedSlots[slot]
      return entry.relic != null && entry.relic.id === entry.equippedId
        && entry.relic.equippedBy === '1212b1' && entry.relic.main != null
        && Array.isArray(entry.relic.substats)
        && entry.relic.substats.every((s) => s.rolls != null && s.addedRolls != null)
    }),
  )
  check(
    'get_character builds serialized',
    detail.builds.length === 1 && detail.builds[0].name === 'smoke-build' && detail.builds[0].source === 'optimizer'
      && detail.builds[0].equipped.Head === target.equipped.Head
      && detail.builds[0].team[0].characterId === '1101'
      && detail.builds[0].team[0].characterConditionals.teammateBuff === true
      && detail.builds[0].characterConditionals.talentEnhanced === true
      && detail.builds[0].combo.stateJsonActions === 3
      && detail.builds[0].combo.stateJsonBytes > 0,
    JSON.stringify(detail.builds[0]?.combo),
  )
  check(
    'get_character saved form + scoring metadata',
    detail.savedForm?.characterId === '1212b1'
      && detail.scoringMetadata?.stats != null && detail.scoringMetadata?.parts != null,
  )

  // 5. get_form
  const formResponse = await callTool(client, 'get_form', { characterId: '1212b1' })
  check(
    'get_form characterId matches',
    formResponse.form.characterId === '1212b1' && formResponse.characterId === '1212b1',
  )
  check(
    'get_form carries normalized shape',
    // Legacy saved relicSets/ornamentSets are dropped by upstream normalization
    // (internalFormToState only maps setFilters) — the normalized form carries
    // the default empty set filters, same as what optimize sends.
    formResponse.form.relicSets != null && formResponse.form.setFilters != null
      && formResponse.form.mainBody?.[0] === 'CRIT DMG' && formResponse.form.mainFeet?.[0] === 'SPD'
      && formResponse.form.weights != null && formResponse.form.characterConditionals != null
      && formResponse.form.comboTurnAbilities != null
      // displayToInternal applies a small tolerance to stat filters: 134 → 133.9999
      && formResponse.form.minSpd > 133.99 && formResponse.form.minSpd < 134.0001,
  )
  check(
    'get_form field sources annotate saved vs default',
    formResponse.fieldSources.fields.characterId === 'saved'
      && formResponse.fieldSources.fields.mainBody === 'saved'
      && formResponse.fieldSources.fields.setFilters === 'default'
      && Object.values(formResponse.fieldSources.nested.characterConditionals).some((s) => s === 'saved')
      && formResponse.fieldSources.nested.weights['ATK%'] === 'saved',
  )
  check(
    'get_form flags legacy keys dropped',
    Array.isArray(formResponse.fieldSources.legacyKeysDropped)
      && formResponse.fieldSources.legacyKeysDropped.includes('minCv'),
    JSON.stringify(formResponse.fieldSources.legacyKeysDropped),
  )

  // 6. default_form
  const provided = await callTool(client, 'default_form', {
    characterId: '1212b1',
    lightConeId: '23014',
    eidolon: 1,
    superimposition: 1,
  })
  check(
    'default_form (provided LC) complete',
    provided.lightConeSource === 'provided' && provided.form.lightCone === '23014'
      && provided.form.characterId === '1212b1' && provided.form.characterEidolon === 1
      && Object.keys(provided.form.characterConditionals).length > 0
      && Object.keys(provided.form.lightConeConditionals).length > 0
      && Array.isArray(provided.form.comboTurnAbilities) && provided.form.comboTurnAbilities.length > 0
      && provided.form.weights != null && Array.isArray(provided.form.mainBody) && provided.form.mainBody.length > 0
      && provided.warnings.length === 0,
    `${Object.keys(provided.form.characterConditionals).length} char conditionals, `
      + `${Object.keys(provided.form.lightConeConditionals).length} LC conditionals`,
  )

  const fromSaved = await callTool(client, 'default_form', { characterId: '1212b1' })
  check(
    'default_form falls back to the saved-form light cone',
    fromSaved.lightConeSource === 'saved-form' && fromSaved.lightCone === '23014' && fromSaved.warnings.length === 0,
    `source=${fromSaved.lightConeSource}, lc=${fromSaved.lightCone}`,
  )

  // 7. permutations — must match the foundation-phase optimize measurement
  const estimate = await callTool(client, 'permutations', { characterId: '1212b1' })
  check(
    'permutations validPermutations === 462672 (optimize parity)',
    estimate.validPermutations === EXPECTED_VALID_PERMUTATIONS,
    `got ${estimate.validPermutations}`,
  )
  check(
    'permutations naive = product of part counts',
    estimate.naivePermutations === estimate.partCounts.Head * estimate.partCounts.Hands
        * estimate.partCounts.Body * estimate.partCounts.Feet * estimate.partCounts.PlanarSphere
        * estimate.partCounts.LinkRope,
    `naive=${estimate.naivePermutations}, counts=${JSON.stringify(estimate.partCounts)}`,
  )
  check(
    'permutations gate verdict fields present',
    estimate.gate != null && estimate.gate.gate === 5e7 && estimate.gate.wouldReject === false
      && typeof estimate.gate.reason === 'string' && Array.isArray(estimate.suggestions),
    JSON.stringify(estimate.gate),
  )
  console.log(
    `        permutations for 1212b1: valid=${estimate.validPermutations.toLocaleString()}, `
      + `naive=${estimate.naivePermutations.toLocaleString()}, counts=${JSON.stringify(estimate.partCounts)}`,
  )

  const tightened = await callTool(client, 'permutations', {
    characterId: '1212b1',
    formOverrides: { keepCurrentRelics: true },
  })
  check(
    'permutations honors formOverrides (keepCurrentRelics locks each part to 1 relic)',
    tightened.validPermutations < estimate.validPermutations
      && tightened.partCountsBeforeFilters.Head === estimate.partCountsBeforeFilters.Head
      && Object.values(tightened.partCounts).every((count) => count <= 1),
    `valid=${tightened.validPermutations.toLocaleString()} < ${estimate.validPermutations.toLocaleString()}, `
      + `counts=${JSON.stringify(tightened.partCounts)}`,
  )

  // 8. list_relics enhancements
  const equippedByChar = await callTool(client, 'list_relics', { characterId: '1212b1' })
  check(
    'list_relics characterId filter returns the 6 equipped',
    equippedByChar.total === 6 && equippedByChar.relics.every((r) => r.equippedBy === '1212b1'),
    `total=${equippedByChar.total}`,
  )
  const equippedIdsFromRelics = new Set(equippedByChar.relics.map((r) => r.id))
  check(
    'list_relics characterId filter matches get_character equipped slots',
    equippedIds.every((id) => equippedIdsFromRelics.has(id)),
  )

  // weightScore is optimizer-pipeline-internal: the main thread never computes
  // or refreshes it, and save files may carry stale values persisted by the web
  // app (the sample has 35 such relics) — they must surface as null (never a
  // fake 0, never a stale leak) and the sortBy key is rejected by the schema.
  const weightScoreSample = await callTool(client, 'list_relics', { limit: 500 })
  const staleCount = JSON.parse(readFileSync(repoSampleSavePath, 'utf8')).relics.filter((r) => r.weightScore !== undefined).length
  check(
    'list_relics covers the whole inventory for the weightScore check',
    weightScoreSample.relics.length === 162,
    `${weightScoreSample.relics.length} relics (${staleCount} carry stale weightScore in the file)`,
  )
  check(
    'list_relics weightScore is null on every relic (stale values suppressed)',
    weightScoreSample.relics.every((r) => r.weightScore === null),
    `weightScore values: ${[...new Set(weightScoreSample.relics.map((r) => JSON.stringify(r.weightScore)))].join(',')}`,
  )
  let weightScoreSortRejected = null
  try {
    await callTool(client, 'list_relics', { characterId: '1212b1', sortBy: 'weightScore' })
  } catch (e) {
    weightScoreSortRejected = e
  }
  check(
    'list_relics sortBy weightScore rejected by schema',
    weightScoreSortRejected != null && /weightScore|Invalid/i.test(String(weightScoreSortRejected.message)),
    String(weightScoreSortRejected?.message ?? '(no error)').slice(0, 120),
  )

  const unequippedChar = await callTool(client, 'list_relics', { characterId: '1105' })
  check('list_relics characterId filter with 0 equipped', unequippedChar.total === 0, `total=${unequippedChar.total}`)

  let unknownCharacterError = null
  try {
    await callTool(client, 'list_relics', { characterId: '9999999' })
  } catch (e) {
    unknownCharacterError = e
  }
  check(
    'list_relics unknown characterId errors',
    unknownCharacterError != null && String(unknownCharacterError.message).includes('not found'),
  )

  // 8b. web filter-pill parity (RelicsGrid.tsx:146-166 doesExternalFilterPass):
  //     groups AND, values OR-in; enhance matches tier x..x+2 (pills
  //     +0/+3/…/+15, FilterPillBar.tsx:89); subStat is AND-across-stats and
  //     counts preview substats; initialRolls defaults to 3 when unrecorded.
  //     Expected sets are recomputed from the unfiltered response — the sample
  //     save's serialized output carries every field the filters read.
  const inventory = await callTool(client, 'list_relics', { limit: 500 })
  const idsOf = (result) => [...result.relics.map((r) => r.id)].sort()
  const sameIds = (result, expectedRelics) =>
    result.total === expectedRelics.length
    && JSON.stringify(idsOf(result)) === JSON.stringify([...expectedRelics.map((r) => r.id)].sort())

  const twoParts = ['Head', 'Hands']
  const expectedParts = inventory.relics.filter((r) => twoParts.includes(r.part))
  const partMulti = await callTool(client, 'list_relics', { part: twoParts, limit: 500 })
  check(
    'list_relics part multi-select OR-in',
    sameIds(partMulti, expectedParts) && partMulti.relics.every((r) => twoParts.includes(r.part)),
    `${partMulti.total} of ${inventory.total} (${twoParts.join('/')})`,
  )

  const enhanceTier = await callTool(client, 'list_relics', { enhance: 12, limit: 500 })
  const expectedTier = inventory.relics.filter((r) => r.enhance >= 12 && r.enhance <= 14)
  check(
    'list_relics enhance is tier-matched (12 hits +12..+14), single value form included',
    sameIds(enhanceTier, expectedTier)
      && inventory.relics.some((r) => r.enhance === 13 || r.enhance === 14),
    `${enhanceTier.total} relics (+12..+14; sample has ${inventory.relics.filter((r) => r.enhance > 12 && r.enhance <= 14).length} above +12)`,
  )
  const enhanceMulti = await callTool(client, 'list_relics', { enhance: [0, 9], limit: 500 })
  const expectedTiers = inventory.relics.filter((r) => (r.enhance >= 0 && r.enhance <= 2) || (r.enhance >= 9 && r.enhance <= 11))
  check(
    'list_relics enhance multi-select OR over tiers ([0,9] hits +0..+2 and +9..+11)',
    sameIds(enhanceMulti, expectedTiers),
    `${enhanceMulti.total} relics`,
  )

  // ledger acceptance case: 部位 Head+Hands、强化 12、副词条 CRIT Rate + CRIT DMG
  const substatFilter = ['CRIT Rate', 'CRIT DMG']
  const hasSubstat = (r, stat) => r.substats.some((s) => s.stat === stat) || (r.previewSubstats ?? []).some((s) => s.stat === stat)
  const acceptance = await callTool(client, 'list_relics', {
    part: twoParts,
    enhance: [12],
    subStat: substatFilter,
    limit: 500,
  })
  const expectedAcceptance = inventory.relics.filter((r) =>
    twoParts.includes(r.part)
    && r.enhance >= 12 && r.enhance <= 14
    && substatFilter.every((stat) => hasSubstat(r, stat))
  )
  check(
    'list_relics combined axes match the grid (part OR + enhance tier + subStat AND)',
    sameIds(acceptance, expectedAcceptance),
    `${acceptance.total} relics`,
  )
  const substatOr = await callTool(client, 'list_relics', { subStat: substatFilter[0], limit: 500 })
  const expectedOr = inventory.relics.filter((r) => hasSubstat(r, substatFilter[0]))
  check(
    'list_relics subStat single value still works (preview-inclusive)',
    sameIds(substatOr, expectedOr),
    `${substatOr.total} relics with ${substatFilter[0]}`,
  )

  const gradeMulti = await callTool(client, 'list_relics', { grade: [3, 4], limit: 500 })
  const expectedGrades = inventory.relics.filter((r) => r.grade === 3 || r.grade === 4)
  check('list_relics grade multi-select OR-in', sameIds(gradeMulti, expectedGrades), `${gradeMulti.total} of ${inventory.total}`)

  const setMulti = [...new Set(inventory.relics.map((r) => r.set))].slice(0, 2)
  const expectedSets = inventory.relics.filter((r) => setMulti.includes(r.set))
  const setFilterResult = await callTool(client, 'list_relics', { set: setMulti, limit: 500 })
  check('list_relics set multi-select OR-in', sameIds(setFilterResult, expectedSets), `${setFilterResult.total} of ${inventory.total}`)

  const mainStatMulti = [...new Set(inventory.relics.map((r) => r.main.stat))].slice(0, 2)
  const expectedMains = inventory.relics.filter((r) => mainStatMulti.includes(r.main.stat))
  const mainStatResult = await callTool(client, 'list_relics', { mainStat: mainStatMulti, limit: 500 })
  check('list_relics mainStat multi-select OR-in', sameIds(mainStatResult, expectedMains), `${mainStatResult.total} of ${inventory.total}`)

  // initialRolls: the roll grader fills the value for every relic on load
  // (grade<5 → 0), so the serialized output always carries it — the web's
  // `?? 3` default (RelicsGrid.tsx:152) is defensive parity. Observable
  // behavior: [4] matches exactly the recorded-4 relics, and the low-grade
  // relics (initialRolls=0 after grading) are excluded from [3,4].
  const rolls4 = await callTool(client, 'list_relics', { initialRolls: 4, limit: 500 })
  const expectedRolls4 = inventory.relics.filter((r) => (r.initialRolls ?? 3) === 4)
  const zeroRollsCount = inventory.relics.filter((r) => r.initialRolls === 0).length
  check(
    'list_relics initialRolls=4 matches exactly the recorded-4 relics (ledger acceptance)',
    sameIds(rolls4, expectedRolls4)
      && rolls4.relics.every((r) => r.initialRolls === 4)
      && !rolls4.relics.some((r) => r.initialRolls == null),
    `${rolls4.total} relics with initialRolls=4`,
  )
  const rolls34 = await callTool(client, 'list_relics', { initialRolls: [3, 4], limit: 500 })
  const expectedRolls34 = inventory.relics.filter((r) => [3, 4].includes(r.initialRolls ?? 3))
  check(
    'list_relics initialRolls=[3,4] OR-in excludes the low-grade initialRolls=0 relics',
    sameIds(rolls34, expectedRolls34)
      && rolls34.relics.every((r) => r.initialRolls === 3 || r.initialRolls === 4)
      && zeroRollsCount > 0,
    `${rolls34.total} of ${inventory.total} (${zeroRollsCount} low-grade relics excluded)`,
  )

  // equipped boolean axis (web pill) cross-checked against the equippedBy form
  const equippedTrue = await callTool(client, 'list_relics', { equipped: true, limit: 500 })
  const expectedEquipped = inventory.relics.filter((r) => r.equippedBy != null)
  check(
    'list_relics equipped=true OR-in',
    sameIds(equippedTrue, expectedEquipped) && equippedTrue.relics.every((r) => r.equippedBy != null),
    `${equippedTrue.total} of ${inventory.total}`,
  )
  const unequipped = await callTool(client, 'list_relics', { equipped: [false], limit: 500 })
  const unequippedByForm = await callTool(client, 'list_relics', { equippedBy: 'none', limit: 500 })
  check(
    'list_relics equipped=[false] equals equippedBy="none"',
    JSON.stringify(idsOf(unequipped)) === JSON.stringify(idsOf(unequippedByForm)),
    `${unequipped.total} vs ${unequippedByForm.total}`,
  )

  // verified: sample save is entirely unverified — true-only matches nothing,
  // [true,false] is a no-op like an empty selection
  const verifiedTrue = await callTool(client, 'list_relics', { verified: true, limit: 500 })
  check(
    'list_relics verified=true filters out the unverified sample',
    verifiedTrue.total === 0,
    `got ${verifiedTrue.total}`,
  )
  const verifiedBoth = await callTool(client, 'list_relics', { verified: [true, false], limit: 500 })
  check(
    'list_relics verified=[true,false] keeps everything',
    verifiedBoth.total === inventory.total,
    `${verifiedBoth.total} of ${inventory.total}`,
  )
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-query: ALL CHECKS PASSED' : `\nsmoke-query: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
