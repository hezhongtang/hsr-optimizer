// Public form overrides must agree with an equivalent saved internal Form.
// All persistence targets and fixtures stay in a temporary directory.
// Usage: node scripts/smoke-form-overrides.mjs [serverEntry]
import assert from 'node:assert/strict'
import {
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
const targetId = '1212b1'
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-form-overrides-`)
const sample = JSON.parse(readFileSync(resolve(mcpDir, '../src/data/sample-save.json'), 'utf8'))
const basePath = `${tempDir}/base.json`
writeFileSync(basePath, JSON.stringify(sample))

const client = new Client({ name: 'smoke-form-overrides', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/state.json` },
  stderr: 'inherit',
})

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`)
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text)
}

function comparable(simulation) {
  return {
    stats: simulation.stats,
    actionDamage: simulation.actionDamage,
    rotationDamage: simulation.rotationDamage,
  }
}

// Floating-point percentage round trips may differ at machine precision.
function assertClose(actual, expected, path = '') {
  if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual), `${path}: non-finite ${actual}`)
    assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-10, `${path}: ${actual} != ${expected}`)
  } else if (expected != null && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys`)
    for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${path}.${key}`)
  } else {
    assert.equal(actual, expected, path)
  }
}

async function simulate(formOverrides) {
  return comparable(await call('simulate_build', { characterId: targetId, formOverrides }))
}

async function optimize(formOverrides) {
  return call('optimize', { characterId: targetId, resultsLimit: 1, formOverrides })
}

try {
  await client.connect(transport)
  const unloadedDefault = await call('default_form', { characterId: targetId })
  assert.equal(unloadedDefault.lightConeSource, 'none')
  assert.equal(unloadedDefault.form.minSpd, 0)
  assert.equal(unloadedDefault.form.characterId, targetId)
  assert.ok(unloadedDefault.warnings.length > 0)
  console.log('[PASS] default_form normalizes a character before any save is loaded')
  await call('load_save', { path: basePath })
  const locked = { keepCurrentRelics: true, statFilters: { minSpd: 0 } }
  const baseline = await optimize(locked)
  assert.equal(baseline.status, 'completed')
  assert.equal(baseline.rows.length, 1, 'locked fixture must have a valid build')
  const impossible = await optimize({ ...locked, minSpd: 999 })
  assert.equal(impossible.rows.length, 0, 'flat minSpd:999 must reach the engine')
  const displayImpossible = await optimize({ ...locked, statFilters: { minSpd: 999 } })
  assert.equal(displayImpossible.rows.length, 0)
  console.log('[PASS] flat and display minSpd reject the same impossible build')

  const percent = await optimize({ ...locked, minCd: 9.99 })
  const displayPercent = await optimize({ ...locked, statFilters: { minSpd: 0, minCd: 999 } })
  assert.equal(percent.rows.length, 0, 'internal minCd is a fraction, not a display percentage')
  assert.equal(displayPercent.rows.length, 0)
  const rating = await optimize({ ...locked, minEhp: 1e20 })
  assert.equal(rating.rows.length, 0, 'flat rating filters must reach the engine')
  console.log('[PASS] internal percentage and rating filters reach the engine')

  const form = (await call('get_form', { characterId: targetId })).form
  const before = await simulate()
  assertClose(await simulate(form), before, 'get_form round trip')
  const originalEstimate = await call('permutations', { characterId: targetId })
  const roundTripEstimate = await call('permutations', { characterId: targetId, formOverrides: form })
  assert.equal(roundTripEstimate.validPermutations, originalEstimate.validPermutations)
  console.log('[PASS] complete get_form template preserves simulation and search space')

  const internalSets = {
    relicSets: [['4 Piece', 'Hunter of Glacial Forest']],
    ornamentSets: ['Rutilant Arena'],
  }
  const displaySets = { setFilters: { fourPiece: ['Hunter of Glacial Forest'], ornaments: ['Rutilant Arena'] } }
  const setReference = await call('permutations', { characterId: targetId, formOverrides: displaySets })
  const setAliases = await call('permutations', { characterId: targetId, formOverrides: { ...form, ...internalSets } })
  assert.equal(setAliases.validPermutations, setReference.validPermutations)
  assert.ok(setReference.validPermutations > 0 && setReference.validPermutations < originalEstimate.validPermutations)
  console.log('[PASS] explicit internal set aliases take precedence over template setFilters')

  const donor = sample.characters.find((character) => character.id === '1101')
  const teammate = {
    characterId: donor.id,
    characterEidolon: 2,
    lightCone: donor.form.lightCone,
    lightConeSuperimposition: 1,
    characterConditionals: {
      teamDmgBuff: true,
      skillBuff: true,
      ultBuff: true,
      e2SkillSpdBuff: true,
      teammateCDValue: 2.5,
    },
    lightConeConditionals: { postSkillDmgBuff: true },
  }
  const internalBuffs = { HP_P: 0.25, SPD: 7 }
  const fromAliases = await simulate({ format: 'internal', teammate0: teammate, combatBuffs: internalBuffs })
  const fromDisplay = await simulate({
    format: 'display',
    teammates: [teammate],
    combatBuffs: { HP_P: 25, SPD: 7 },
  })
  assertClose(fromAliases, fromDisplay, 'teammate/percentage aliases')
  assertClose(await simulate({ teammate0: teammate, combatBuffs: internalBuffs }), fromAliases, 'auto internal buff units')
  assertClose(await simulate({ format: 'display', teammate0: teammate, combatBuffs: { HP_P: 25, SPD: 7 } }), fromAliases, 'explicit display buff units')
  assert.notEqual(fromAliases.stats.combo.damage, before.stats.combo.damage, 'fixture must exercise real combat changes')

  // Load the same configuration as a native saved Form: this path uses
  // computeLoadForm rather than applyFormOverrides and is an independent oracle.
  const configuredSave = structuredClone(sample)
  configuredSave.characters.find((character) => character.id === targetId).form = {
    ...form,
    teammate0: teammate,
    combatBuffs: { ...form.combatBuffs, ...internalBuffs },
    minCd: 0.4,
  }
  const configuredPath = `${tempDir}/configured.json`
  writeFileSync(configuredPath, JSON.stringify(configuredSave))
  await call('load_save', { path: configuredPath })
  assertClose(await simulate(), fromAliases, 'saved internal Form reference')
  const configuredForm = (await call('get_form', { characterId: targetId })).form
  assertClose(await simulate(configuredForm), fromAliases, 'nonzero percent get_form round trip')

  // Partial teammate conditionals and buffs keep every other saved field.
  const partial = await simulate({ format: 'internal', teammate0: { characterConditionals: { skillBuff: false } }, combatBuffs: { HP_P: 0.5 } })
  const partialSave = structuredClone(configuredSave)
  const partialForm = partialSave.characters.find((character) => character.id === targetId).form
  partialForm.teammate0.characterConditionals.skillBuff = false
  partialForm.combatBuffs.HP_P = 0.5
  const partialPath = `${tempDir}/partial.json`
  writeFileSync(partialPath, JSON.stringify(partialSave))
  await call('load_save', { path: partialPath })
  assertClose(await simulate(), partial, 'partial nested maps preserve saved teammates/buffs')
  console.log('[PASS] teammate/percentage templates and partial maps match native saved Form simulations')

  await call('load_save', { path: basePath })
  const defaults = (await call('default_form', { characterId: targetId, lightConeId: form.lightCone })).form
  const defaultSimulation = await simulate(defaults)
  const defaultSave = structuredClone(sample)
  defaultSave.characters.find((character) => character.id === targetId).form = structuredClone(defaults)
  const defaultPath = `${tempDir}/default.json`
  writeFileSync(defaultPath, JSON.stringify(defaultSave))
  await call('load_save', { path: defaultPath })
  assertClose(await simulate(), defaultSimulation, 'default_form template')
  console.log('[PASS] complete default_form template matches native saved Form simulation')
  const lockedInventory = { keepCurrentRelics: true, mainBody: [], mainFeet: [], mainPlanarSphere: [], mainLinkRope: [] }
  const nativeDefaultRun = await optimize(lockedInventory)
  assert.equal(nativeDefaultRun.rows.length, 1, 'native default fixture must have a valid unconstrained build')

  // A full default template must also reset old constraints, not act like a
  // partial patch that accidentally keeps an impossible saved speed bound.
  defaultSave.characters.find((character) => character.id === targetId).form.minSpd = 999
  const constrainedPath = `${tempDir}/constrained.json`
  writeFileSync(constrainedPath, JSON.stringify(defaultSave))
  await call('load_save', { path: constrainedPath })
  // Recommended default main stats may exclude this sample's equipped relics;
  // clear those inventory filters to isolate the saved speed constraint.
  assert.equal((await optimize(lockedInventory)).rows.length, 0)
  assert.equal(
    (await optimize({ ...defaults, ...lockedInventory })).rows.length,
    1,
    'default_form template must clear an impossible saved speed constraint',
  )
  console.log('[PASS] complete default_form template clears saved stat constraints')

  const invalidFormat = await client.callTool({ name: 'simulate_build', arguments: { characterId: targetId, formOverrides: { format: 'unknown' } } })
  assert.equal(invalidFormat.isError, true, 'unknown override format must fail visibly')
  for (const invalid of [{ minSppd: 999 }, { toString: true }, { characterId: '1101' }]) {
    const rejected = await client.callTool({ name: 'simulate_build', arguments: { characterId: targetId, formOverrides: invalid } })
    assert.equal(rejected.isError, true, `unsupported/foreign override ${JSON.stringify(invalid)} must fail visibly`)
  }
  console.log('[PASS] invalid override formats, unknown fields and foreign identities are rejected')
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log('\nsmoke-form-overrides: ALL CHECKS PASSED')
