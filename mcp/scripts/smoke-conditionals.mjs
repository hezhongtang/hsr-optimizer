// End-to-end smoke test for the conditionals tool + game-metadata resources.
//
// Spawns the built server (dist/index.js) over stdio with the SDK client and
// walks the read-only introspection surface:
//
//   describe_conditionals:
//     load_save (temp copy of the sample save) → Jingliu 1212b1 off her saved
//     form (e1 / I Shall Be My Own Sword s1): 9 conditionals (7 character +
//     2 light cone), every label a non-empty zh_CN string (proves the headless
//     i18n bundle actually registered — a missing bundle echoes keys / empty
//     strings), slider metadata with concrete min/max/default, LC conditionals
//     in the list, defaultConditionals maps ready for formOverrides, and the
//     resolved block reporting saved-form provenance.
//     → eidolon gating probes: e1Buffs locked at e0 (requiresEidolon 1, not
//     alwaysDisabled), unlocked at e6.
//     → Hyacine 1409 (not in the save): select enums with CJK option labels +
//     the no-save fallback chain (character-default light cone, s1).
//     → path-mismatch cone: empty LC list + a 命途 warning, character side intact.
//     → unknown ids reject.
//
//   resources:
//     resources/list carries the 4 static game:// URIs (and NOT the per-id
//     template instances — they are list: undefined by design), the two URI
//     templates surface via resources/templates/list, and every resource reads
//     back JSON: characters roster with Chinese names, per-id character detail
//     (Lv80 base stats), light cone roster + S1-S5 superimposition table, sets
//     with Chinese 2pc/4pc effect text, changelog entries.
//
// Everything persists into a temp directory (save copy + HSR_MCP_STATE_FILE);
// the repo's sample-save.json is never a write target. No network access.
//
// Usage: node scripts/smoke-conditionals.mjs [serverEntry]
//   serverEntry defaults to ./dist/index.js (resolved against mcp/).

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

const JINGLIU = '1212b1' // sample-save form: e1, light cone 23014 s1
const HYACINE = '1409' // select-enum character, NOT in the sample save
const ABUNDANCE_CONE = '21000' // Post-Op Conversation — wrong path for Jingliu

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-cond-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const hasCJK = (s) => typeof s === 'string' && /[\u4e00-\u9fff]/.test(s)

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

async function readJsonResource(client, uri) {
  const result = await client.readResource({ uri })
  const contents = result.contents ?? []
  if (contents.length !== 1 || contents[0].mimeType !== 'application/json') {
    throw new Error(`resource ${uri}: expected exactly 1 application/json content, got ${contents.length} (${contents[0]?.mimeType})`)
  }
  return JSON.parse(contents[0].text)
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-conditionals', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: { ...getDefaultEnvironment(), HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json` },
  stderr: 'inherit',
})
await client.connect(transport)

try {
  // ── A. tool surface ────────────────────────────────────────────────────────
  const tools = await client.listTools()
  check('tool describe_conditionals registered', tools.tools.map((t) => t.name).includes('describe_conditionals'))

  // ── B. load the sample save (temp copy — the server may write back to it) ──
  const loaded = await callTool(client, 'load_save', { path: sampleSavePath })
  check('load_save relics = 162', loaded.relics === 162, `got ${loaded.relics}`)
  check('load_save characters = 8', loaded.characters === 8, `got ${loaded.characters}`)

  // ── C. describe_conditionals off the saved form (Jingliu e1 / 23014 s1) ───
  const describeStart = Date.now()
  const jingliu = await callTool(client, 'describe_conditionals', { characterId: JINGLIU })
  console.log(`        describe_conditionals took ${Date.now() - describeStart}ms`)
  check(
    'counts: 9 conditionals (7 character + 2 light cone)',
    jingliu.counts.character === 7 && jingliu.counts.lightCone === 2 && jingliu.counts.total === 9,
    `char=${jingliu.counts.character}, lc=${jingliu.counts.lightCone}, total=${jingliu.counts.total}`,
  )
  check(
    'conditionals array agrees with counts',
    Array.isArray(jingliu.conditionals) && jingliu.conditionals.length === jingliu.counts.total,
    `${jingliu.conditionals.length} entries`,
  )
  check(
    'every label is a non-empty CJK string (i18n bundle live, not key echo)',
    jingliu.conditionals.every((c) => hasCJK(c.label) && c.label.length > 0),
    jingliu.conditionals.map((c) => c.label).join(' | '),
  )
  check(
    'every entry carries key/source/type with scopes ⊆ {self, teammate}',
    jingliu.conditionals.every(
      (c) =>
        typeof c.key === 'string' && c.key.length > 0
        && ['character', 'lightCone'].includes(c.source)
        && ['boolean', 'select', 'slider'].includes(c.type)
        && Array.isArray(c.scopes) && c.scopes.length > 0
        && c.scopes.every((s) => s === 'self' || s === 'teammate'),
    ),
  )
  check('conditional keys are unique', new Set(jingliu.conditionals.map((c) => c.key)).size === jingliu.conditionals.length)
  const lightConeItems = jingliu.conditionals.filter((c) => c.source === 'lightCone')
  check('light cone conditionals in the list', lightConeItems.length === 2, lightConeItems.map((c) => `${c.key}(${c.label})`).join(', '))
  const sliders = jingliu.conditionals.filter((c) => c.type === 'slider')
  const enums = jingliu.conditionals.filter((c) => c.options != null)
  check('at least one entry with enum or slider metadata', sliders.length + enums.length >= 1, `${sliders.length} slider(s), ${enums.length} enum(s)`)
  const moonlight = jingliu.conditionals.find((c) => c.key === 'moonlightStacks')
  check(
    'character slider shape: 月色层数 min 0 / max 5 / default 5 / E3 value upgrade',
    moonlight != null && moonlight.type === 'slider' && moonlight.min === 0 && moonlight.max === 5
      && moonlight.defaultValue.self === 5 && moonlight.threshold.eidolonValueUpgrades.includes(3),
    JSON.stringify(moonlight?.threshold),
  )
  const eclipse = jingliu.conditionals.find((c) => c.key === 'eclipseStacks')
  check(
    'light cone slider shape: 月蚀层数 min 0 / max 3 / default 3 / s2-s5 value upgrades',
    eclipse != null && eclipse.source === 'lightCone' && eclipse.type === 'slider' && eclipse.min === 0 && eclipse.max === 3
      && eclipse.defaultValue.self === 3 && eclipse.threshold.superimpositionValueUpgrades.length >= 1,
    `upgrades=${JSON.stringify(eclipse?.threshold?.superimpositionValueUpgrades)}`,
  )
  check(
    'defaultConditionals maps mirror the resolver defaults (formOverrides-ready)',
    jingliu.defaultConditionals?.characterConditionals?.moonlightStacks === 5
      && jingliu.defaultConditionals?.lightConeConditionals?.eclipseStacks === 3,
    JSON.stringify(jingliu.defaultConditionals),
  )
  check(
    'resolved block proves the save form drove eidolon/light cone/superimposition',
    jingliu.resolved.eidolon === 1 && jingliu.resolved.eidolonSource === 'saved-form'
      && jingliu.resolved.lightConeSource === 'saved-form' && jingliu.resolved.superimposition === 1
      && jingliu.resolved.superimpositionSource === 'saved-form',
    JSON.stringify(jingliu.resolved),
  )
  check(
    'header names the character and her light cone',
    jingliu.character.id === JINGLIU && jingliu.character.name === 'Jingliu' && jingliu.lightCone.id === '23014'
      && jingliu.lightCone.pathMismatch === false && jingliu.warnings.length === 0,
  )

  // ── D. eidolon gating probes (explicit eidolon overrides the saved form) ───
  const atE0 = await callTool(client, 'describe_conditionals', { characterId: JINGLIU, eidolon: 0 })
  const e1GateAtE0 = atE0.conditionals.find((c) => c.key === 'e1Buffs')
  check(
    'e0: 1魂增益 locked with requiresEidolon 1 (not alwaysDisabled)',
    e1GateAtE0 != null && e1GateAtE0.disabled === true && e1GateAtE0.threshold.requiresEidolon === 1
      && e1GateAtE0.threshold.alwaysDisabled === false,
    JSON.stringify(e1GateAtE0?.threshold),
  )
  check('e0: resolved honors the explicit eidolon', atE0.resolved.eidolon === 0 && atE0.resolved.eidolonSource === 'provided', JSON.stringify(atE0.resolved))
  const atE6 = await callTool(client, 'describe_conditionals', { characterId: JINGLIU, eidolon: 6 })
  const e1GateAtE6 = atE6.conditionals.find((c) => c.key === 'e1Buffs')
  check(
    'e6: 1魂增益 unlocked, gate still reported',
    e1GateAtE6 != null && e1GateAtE6.disabled === false && e1GateAtE6.threshold.requiresEidolon === 1,
    `disabled=${e1GateAtE6?.disabled}, requiresEidolon=${e1GateAtE6?.threshold?.requiresEidolon}`,
  )

  // ── E. select enums + no-save fallback chain (Hyacine is not in the save) ──
  const hyacine = await callTool(client, 'describe_conditionals', { characterId: HYACINE })
  const hyacineSelects = hyacine.conditionals.filter((c) => c.type === 'select')
  check('Hyacine exposes select enums', hyacineSelects.length >= 2, hyacineSelects.map((c) => c.key).join(', '))
  const healAbility = hyacineSelects.find((c) => c.key === 'healAbility')
  check(
    'healAbility enum: 战技/终结技 options with CJK labels, default = 战技 (value 2)',
    healAbility != null && healAbility.options != null
      && healAbility.options.length === 2
      && healAbility.options.some((o) => o.value === 2 && hasCJK(o.label) && o.label.includes('战技'))
      && healAbility.options.some((o) => o.value === 4 && hasCJK(o.label) && o.label.includes('终结技'))
      && healAbility.defaultValue.self === 2,
    JSON.stringify(healAbility?.options),
  )
  check(
    'no-save fallback chain: character-default light cone + s1 + e0',
    hyacine.resolved.lightConeSource === 'character-default' && hyacine.resolved.superimposition === 1
      && hyacine.resolved.superimpositionSource === 'default' && hyacine.resolved.eidolon === 0
      && hyacine.resolved.eidolonSource === 'default' && hyacine.lightCone.id === '23042' && hyacine.lightCone.pathMismatch === false,
    `resolved=${JSON.stringify(hyacine.resolved)}, lc=${hyacine.lightCone.id}`,
  )
  check(
    'fallback warns about the default light cone',
    hyacine.warnings.some((w) => w.includes('默认光锥')),
    hyacine.warnings.join(' | '),
  )

  // ── F. path-mismatch cone: empty LC list, character side intact ────────────
  const mismatch = await callTool(client, 'describe_conditionals', { characterId: JINGLIU, lightConeId: ABUNDANCE_CONE })
  check(
    'path-mismatch cone yields 0 LC conditionals + a 命途 warning, character side intact',
    mismatch.counts.lightCone === 0 && mismatch.counts.character === 7
      && mismatch.lightCone.pathMismatch === true
      && mismatch.warnings.some((w) => w.includes('命途')),
    `lc=${mismatch.counts.lightCone}, warnings=${mismatch.warnings.length}`,
  )
  check(
    'path-mismatch resolved reports the provided cone',
    mismatch.resolved.lightConeSource === 'provided' && mismatch.lightCone.id === ABUNDANCE_CONE,
  )

  // ── G. unknown ids reject ──────────────────────────────────────────────────
  let unknownCharacterRejected = false
  try {
    await callTool(client, 'describe_conditionals', { characterId: '9999999' })
  } catch {
    unknownCharacterRejected = true
  }
  check('unknown character id rejects', unknownCharacterRejected)
  let unknownConeRejected = false
  try {
    await callTool(client, 'describe_conditionals', { characterId: JINGLIU, lightConeId: '9999999' })
  } catch {
    unknownConeRejected = true
  }
  check('unknown light cone id rejects', unknownConeRejected)

  // ── H. resources/list + templates/list ─────────────────────────────────────
  const list = await client.listResources()
  const listedUris = list.resources.map((r) => r.uri)
  for (const uri of ['game://metadata/characters', 'game://metadata/lightcones', 'game://metadata/sets', 'game://metadata/scoring', 'game://changelog']) {
    check(`resources/list contains ${uri}`, listedUris.includes(uri), listedUris.join(', '))
  }
  check(
    'resources/list stays summary-only (no per-id template instances)',
    listedUris.length === 5 && !listedUris.some((uri) => /\/\d+$/.test(uri)),
    `${listedUris.length} URIs`,
  )
  const templates = await client.listResourceTemplates()
  const templateUris = templates.resourceTemplates.map((r) => r.uriTemplate)
  check(
    'resources/templates/list exposes both detail templates',
    templateUris.includes('game://metadata/characters/{id}') && templateUris.includes('game://metadata/lightcones/{id}'),
    templateUris.join(', '),
  )

  // ── I. resource reads ──────────────────────────────────────────────────────
  const characters = await readJsonResource(client, 'game://metadata/characters')
  check('characters roster is populated (≥ 100)', characters.count >= 100 && characters.characters.length === characters.count, `count=${characters.count}`)
  check(
    'characters roster entries carry the summary shape',
    characters.characters.every((c) =>
      typeof c.id === 'string' && typeof c.name === 'string' && typeof c.rarity === 'number'
      && typeof c.path === 'string' && typeof c.element === 'string' && typeof c.unreleased === 'boolean'
    ),
  )
  const zhNamed = characters.characters.filter((c) => hasCJK(c.nameZh))
  check('characters roster carries Chinese names (≥ 100 of them)', zhNamed.length >= 100, `${zhNamed.length}/${characters.count} with CJK nameZh`)
  const jingliuEntry = characters.characters.find((c) => c.id === JINGLIU)
  check(
    'roster: Jingliu 1212b1 named 镜流 (Destruction/Ice, current-gen)',
    jingliuEntry != null && jingliuEntry.nameZh === '镜流' && jingliuEntry.path === 'Destruction' && jingliuEntry.element === 'Ice'
      && jingliuEntry.preNovaflare === false,
    JSON.stringify(jingliuEntry),
  )
  const march7th = characters.characters.find((c) => c.id === '1001')
  check('roster: 1001 named 三月七', march7th != null && march7th.nameZh === '三月七', JSON.stringify(march7th))

  const charDetail = await readJsonResource(client, `game://metadata/characters/${JINGLIU}`)
  check(
    'character detail: Lv80 base stats (6 keys, concrete values)',
    charDetail.baseStats != null && charDetail.baseStats.HP === 1435.896 && charDetail.baseStats.ATK === 679.14
      && charDetail.baseStats.DEF === 485.1 && charDetail.baseStats.SPD === 96
      && charDetail.baseStats['CRIT Rate'] === 0.05 && charDetail.baseStats['CRIT DMG'] === 0.5,
    JSON.stringify(charDetail.baseStats),
  )
  check(
    'character detail: trace tree + trace totals + zh names',
    Array.isArray(charDetail.traceTree) && charDetail.traceTree.length > 0
      && charDetail.traceTotals != null && typeof charDetail.traceTotals === 'object'
      && charDetail.nameZh === '镜流' && hasCJK(charDetail.longNameZh),
    `traceTree=${charDetail.traceTree?.length} nodes, traceTotals keys=${Object.keys(charDetail.traceTotals ?? {}).length}`,
  )

  const lightCones = await readJsonResource(client, 'game://metadata/lightcones')
  check('light cone roster is populated (≥ 160)', lightCones.count >= 160 && lightCones.lightCones.length === lightCones.count, `count=${lightCones.count}`)
  const zhCones = lightCones.lightCones.filter((lc) => hasCJK(lc.nameZh))
  check('light cone roster carries Chinese names (≥ 150)', zhCones.length >= 150, `${zhCones.length}/${lightCones.count} with CJK nameZh`)

  const lcDetail = await readJsonResource(client, 'game://metadata/lightcones/23014')
  check(
    'light cone detail: S1-S5 superimposition table with concrete CRIT DMG scaling',
    lcDetail.nameZh === '此身为剑' && lcDetail.superimpositions != null
      && Object.keys(lcDetail.superimpositions).join(',') === 'S1,S2,S3,S4,S5'
      && lcDetail.superimpositions.S1['CRIT DMG'] === 0.2 && lcDetail.superimpositions.S5['CRIT DMG'] === 0.32,
    JSON.stringify(lcDetail.superimpositions),
  )
  check(
    'light cone detail: Lv80 base stats',
    lcDetail.baseStats != null && lcDetail.baseStats.HP === 1164.24 && lcDetail.baseStats.ATK === 582.12 && lcDetail.baseStats.DEF === 396.9,
    JSON.stringify(lcDetail.baseStats),
  )

  const sets = await readJsonResource(client, 'game://metadata/sets')
  check('sets table is populated (≥ 60)', sets.count >= 60 && sets.sets.length === sets.count, `count=${sets.count}`)
  check(
    'every set carries a Chinese 2pc effect text',
    sets.sets.every((s) => hasCJK(s.description2pcZh)),
    `${sets.sets.filter((s) => hasCJK(s.description2pcZh)).length}/${sets.sets.length} with CJK 2pc`,
  )
  const passerby = sets.sets.find((s) => s.id === '101')
  check(
    'sets: 101 = 云无留迹的过客, 2pc 治疗量提高10%。',
    passerby != null && passerby.nameZh === '云无留迹的过客' && passerby.description2pcZh === '治疗量提高10%。'
      && hasCJK(passerby.description4pcZh) && typeof passerby.skillsEn === 'string' && passerby.skillsEn.length > 0,
    JSON.stringify(passerby),
  )

  const changelog = await readJsonResource(client, 'game://changelog')
  check(
    'changelog non-empty: entries shaped {title, date, content[]}, first entry carries the data version',
    changelog.count >= 40 && changelog.entries.length === changelog.count
      && changelog.entries.every(
        (e) =>
          typeof e.title === 'string' && typeof e.date === 'string' && Array.isArray(e.content)
          && (e.title.length > 0 || e.date.length > 0),
      )
      && /data version/i.test(changelog.entries[0].title),
    `count=${changelog.count}, first="${changelog.entries[0]?.title}", dates=${changelog.entries.filter((e) => e.date.length > 0).length}`,
  )

  // ── J. unknown template id rejects ─────────────────────────────────────────
  let unknownResourceRejected = false
  try {
    await client.readResource({ uri: 'game://metadata/characters/9999999' })
  } catch {
    unknownResourceRejected = true
  }
  check('unknown character detail URI rejects', unknownResourceRejected)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-conditionals: ALL CHECKS PASSED' : `\nsmoke-conditionals: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
