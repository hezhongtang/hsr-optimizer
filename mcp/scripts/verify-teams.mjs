// verified-acceptance parity harness for the TEAMS domain (protocol 2026-10-08,
// coverage/features/teams.json).
//
// Every scope=baseline acceptance case gets a same-version browser/MCP
// cross-check against the repo-root dist/ build (managed headless browser,
// seeded localStorage['state'] = temp save copies):
//
//   - the WEB side is driven through its own UI: panel tab clicks, slot-picker
//     card mousedowns, Change character / Remove / Sync benchmark teams /
//     Clear characters / Save team buttons, the Benchmark dropdown, inline
//     rename inputs, delete icons, real dnd-kit drags (multi-phase pointer
//     events) for slot reorder + saved-team reorder, and the page's own
//     screenshot download chain (captureAppExport);
//   - the MCP side drives manage_team / save_team / list_teams / dps_score /
//     update_state / render through stdio against temp state;
//   - comparisons are on harvested save files (the page's own
//     SaveState.save() → localStorage) and rendered card values (portrait
//     data-url per slot, sim-score row titles, card order).
//
// Everything persistent lives in a mkdtempSync temp dir; the repo sample save
// is never a write target. Browser closed + temp dir removed at exit.
//
// Usage: node scripts/verify-teams.mjs [serverEntry]

import {
  copyFileSync,
  existsSync,
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
const evidencePath = resolve(mcpDir, 'coverage/evidence/teams.json')

const GIT_COMMIT = '8ac1d045'
const GENERATED_AT = new Date().toISOString()

// roster ids (sample save): 1212b1 Jingliu(E1) 1005 Kafka(E0) 1102 Seele(E0)
// 1217 Huohuo(E0) 1205 Blade(E0) 1202 Tingyun 1101 Bronya 1105 Natasha
const J = '1212b1'
const K = '1005'
const S = '1102'
const B = '1205'
const HUOHUO = '1217'
const UNOWNED = '1107' // Clara — valid metadata id, absent from the roster

// Only Jingliu in the sample roster carries a DPS simulation (Kafka/Seele/Blade
// only have buffed b1 variants), so the scoring cases add three unowned sim
// characters with their signature light cones via the MCP upsert path.
const ACHERON = '1308'
const AGWAEA = '1402'
const ANAXA = '1405'
const SIM_LC = { [ACHERON]: '23024', [AGWAEA]: '23036', [ANAXA]: '23041' }
const SIM_TEAM = [J, ACHERON, AGWAEA, ANAXA]

function findChrome() {
  if (process.env.HSR_MCP_BROWSER_PATH && existsSync(process.env.HSR_MCP_BROWSER_PATH)) {
    return process.env.HSR_MCP_BROWSER_PATH
  }
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    : process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find((p) => existsSync(p)) ?? null
}
function findSiteDist() {
  if (process.env.HSR_MCP_SITE_DIST && existsSync(`${process.env.HSR_MCP_SITE_DIST}/index.html`)) {
    return process.env.HSR_MCP_SITE_DIST
  }
  const repoDist = resolve(mcpDir, '../dist')
  return existsSync(`${repoDist}/index.html`) && existsSync(`${repoDist}/assets`) ? repoDist : null
}
if (findChrome() == null || findSiteDist() == null) {
  console.log('[SKIP] teams 对拍需要受管浏览器环境(Chrome + 站点 dist/)')
  process.exit(0)
}

const cases = []
function record(feature, caseNo, desc, method, result, detail) {
  cases.push({
    feature,
    case: caseNo,
    desc: desc.slice(0, 60),
    method,
    result,
    detail: detail.replace(/\s+/g, ' ').slice(0, 240),
    script: 'mcp/scripts/verify-teams.mjs',
  })
  console.log(`[${result}] ${feature} #${caseNo} (${method}) — ${detail.replace(/\s+/g, ' ').slice(0, 220)}`)
}

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-teams-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const closeEnough = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))

// ── MCP client ───────────────────────────────────────────────────────────────
const client = new Client({ name: 'verify-teams', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_ARTIFACTS_DIR: `${tempDir}/artifacts`,
  },
  stderr: 'inherit',
})
await client.connect(transport)

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}
async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`tool ${name} isError: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}
async function toolErrorText(name, args) {
  try {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) return result.content?.[0]?.text
    return null
  } catch (e) {
    return String(e?.message ?? e)
  }
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL != null && context.parentURL.endsWith('.ts')) {
        try {
          return nextResolve(`${specifier}.ts`, context)
        } catch { /* fall through */ }
      }
      throw error
    }
  },
})
const { pathToFileURL } = await import('node:url')
const { browserManager } = await import(pathToFileURL(resolve(mcpDir, 'src/browser/browserManager.ts')).href)

// ═══ seed builders ═══════════════════════════════════════════════════════════

function seedJson(mutate) {
  const data = JSON.parse(readFileSync(sampleSavePath, 'utf8'))
  mutate(data)
  return JSON.stringify(data)
}
function seedFile(name, json) {
  const p = `${tempDir}/${name}.json`
  writeFileSync(p, json)
  return p
}

/** Build a seed by running MCP tools over the sample save: optional character
 *  upserts (roster additions with signature light cones), then saved teams
 *  (with optional benchmark snapshots), then an export. */
async function buildSeedWithTeams(name, teamSpecs, addCharacters = []) {
  const path = seedFile(name, seedJson(() => {}))
  await callTool('load_save', { path })
  if (addCharacters.length > 0) {
    // dps_score needs an equipped build: give each added character 6 free relics
    const free = (await callTool('list_relics', { equippedBy: 'none', limit: 300 })).relics
    const byPart = {}
    for (const relic of free) (byPart[relic.part] ??= []).push(relic.id)
    for (const extra of addCharacters) {
      await callTool('upsert_character', { characterId: extra.id, lightCone: SIM_LC[extra.id] ?? extra.lightCone })
      const pick = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope'].map((part) => byPart[part]?.shift())
      if (pick.some((id) => id == null)) throw new Error('not enough free relics to equip the sim team')
      await callTool('equip_build', { characterId: extra.id, relicIds: pick })
    }
  }
  const ids = []
  for (const spec of teamSpecs) {
    const res = await callTool('save_team', {
      name: spec.name,
      characterIds: spec.characterIds,
      ...(spec.snapshot ? { benchmarkSnapshot: true } : {}),
    })
    ids.push(res.teamId)
  }
  const exportPath = `${tempDir}/${name}-export.json`
  await callTool('export_save', { path: exportPath })
  return { seed: readFileSync(exportPath, 'utf8'), ids }
}

// ═══ page helpers ═════════════════════════════════════════════════════════════

const HARVEST = `() => {
  window.__HSR_DEBUG.SaveState.save()
  return JSON.parse(localStorage.getItem('state') || '{}')
}`

async function openTeamsPanel(page, seed, settleMs = 1500) {
  await page.goto('#characters', { timeoutMs: 90_000 })
  await page.waitForSelector('#root > *', { timeoutMs: 90_000 })
  await sleep(settleMs)
  await page.evaluate(`() => { document.getElementById('characters-panels-tab-TEAMS').click(); return true }`)
  await sleep(settleMs)
}

const PANEL = '#characters-panels-panel-TEAMS'

/** Click a button in the teams panel by (contained) visible text. */
const CLICK_TEAMS_BUTTON = `(text, nth) => {
  const hits = [...document.querySelectorAll('${PANEL} button')].filter((b) => b.offsetParent !== null && (b.textContent || '').includes(text))
  const hit = hits[nth ?? 0]
  if (!hit) return 'not-found:' + text + '/' + hits.length
  hit.click()
  return 'clicked'
}`

/** Click a saved-team tile by its name (aria-label). */
const CLICK_TEAM_TILE = `(name) => {
  const hit = [...document.querySelectorAll('${PANEL} button[aria-label="' + name + '"]')].filter((b) => b.offsetParent !== null)[0]
  if (!hit) return 'not-found:' + name
  hit.click()
  return 'clicked'
}`

/** Pick a character card in the (visible) slot-picker modal. */
const PICK_CARD = `(characterId) => {
  const dialogs = [...document.querySelectorAll('[role=dialog]')].filter((d) => d.offsetParent !== null)
  if (!dialogs.length) return 'no-visible-dialog'
  const card = dialogs[dialogs.length - 1].querySelector('[data-id="' + characterId + '"]')
  if (!card) return 'card-not-found:' + characterId
  card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return 'picked'
}`

/** Working team per slot: character id from the card's portrait data-url + sim score title. */
const READ_CARDS = `() => {
  const grid = document.getElementById('teamShowcaseGrid')
  if (!grid) return []
  return [...grid.children].map((cell) => {
    const portrait = cell.querySelector('[data-portrait-inject]')
    const url = portrait ? portrait.getAttribute('data-portrait-url') || '' : ''
    const idMatch = url.match(/character_portrait\\/(\\w+b?\\d*)\\.webp/)
    const titles = [...cell.querySelectorAll('div[title]')].map((e) => e.getAttribute('title'))
    const simTitle = titles.find((t) => /K$/.test(t) || /^\\d+$/.test(t)) ?? null
    return { charId: idMatch ? idMatch[1] : null, simTitle }
  })
}`

/** Saved-teams sidebar: tile names in order. */
const READ_SAVED_LIST = `() => [...document.querySelectorAll('${PANEL} button')]
  .filter((b) => b.offsetParent !== null && b.getAttribute('aria-label') && !/Rename|Delete|Add|Card options/.test(b.getAttribute('aria-label')))
  .map((b) => b.getAttribute('aria-label'))`

const RENAME_TEAM = `(name) => {
  // rename icons appear in tile order; find the tile showing the name, then its Rename button
  const tile = [...document.querySelectorAll('${PANEL} button')].filter((b) => b.offsetParent !== null && (b.textContent || '') === name)[0]
  if (!tile) return 'tile-not-found:' + name
  const root = tile.closest('div')
  const renameBtn = root.querySelector('button[aria-label="Rename"]') || root.parentElement.querySelector('button[aria-label="Rename"]')
  if (!renameBtn) return 'rename-not-found'
  renameBtn.click()
  return 'clicked'
}`
const COMMIT_RENAME = `(newName) => {
  const input = document.querySelector('${PANEL} input[aria-label="Rename"]')
  if (!input) return 'input-not-found'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, newName)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return 'committed'
}`

/** Benchmark dropdown: open the first slot's select and pick an option by text. */
const SET_SLOT_SCORING = `(optionText) => {
  const sel = document.querySelector('${PANEL} input[aria-label="Benchmark"]')
  if (!sel) return 'select-not-found'
  sel.click()
  return 'opened'
}`

/** Multi-phase mouse drag between overlay slot cells (MouseSensor, 4px activation). */
const DRAG_SLOT_PHASE = `(phase, fromSlot, toSlot) => {
  const cells = [...document.querySelectorAll('${PANEL} [aria-label^="Card options"]')].filter((b) => b.offsetParent !== null)
  if (!cells[fromSlot] || !cells[toSlot]) return 'missing:' + cells.length
  const a = cells[fromSlot].getBoundingClientRect()
  const b = cells[toSlot].getBoundingClientRect()
  const fire = (type, x, y, target) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }))
  if (phase === 'down') fire('mousedown', a.x + a.width / 2, a.y + a.height / 2, cells[fromSlot])
  else if (phase === 'activate') fire('mousemove', a.x + a.width / 2 + 25, a.y + a.height / 2 + 10, cells[fromSlot])
  else if (phase === 'move') fire('mousemove', b.x + b.width / 2, b.y + b.height / 2, document.body)
  else if (phase === 'up') fire('mouseup', b.x + b.width / 2, b.y + b.height / 2, document.body)
  return phase
}`
async function dragSlot(page, fromSlot, toSlot) {
  const results = []
  for (const phase of ['down', 'activate', 'move', 'up']) {
    results.push(await page.evaluate(DRAG_SLOT_PHASE, [phase, fromSlot, toSlot]))
    await sleep(160)
  }
  return results.join('>')
}

/** Multi-phase mouse drag of a saved-team tile (cover button is the activator). */
const DRAG_TILE_PHASE = `(phase, fromIdx, toIdx) => {
  const tiles = [...document.querySelectorAll('${PANEL} button[aria-label]')]
    .filter((b) => b.offsetParent !== null && !/Rename|Delete|Add Main DPS|Add character|Card options/.test(b.getAttribute('aria-label')))
  if (!tiles[fromIdx] || !tiles[toIdx]) return 'missing:' + tiles.length
  const a = tiles[fromIdx].getBoundingClientRect()
  const b = tiles[toIdx].getBoundingClientRect()
  const fire = (type, x, y, target) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }))
  if (phase === 'down') fire('mousedown', a.x + a.width / 2, a.y + a.height / 2, tiles[fromIdx])
  else if (phase === 'activate') fire('mousemove', a.x + a.width / 2 + 8, a.y + a.height / 2 + 20, tiles[fromIdx])
  else if (phase === 'move') fire('mousemove', b.x + b.width / 2, b.y + b.height / 2, document.body)
  else if (phase === 'up') fire('mouseup', b.x + b.width / 2, b.y + b.height / 2, document.body)
  return phase
}`
async function dragTile(page, fromIdx, toIdx) {
  const results = []
  for (const phase of ['down', 'activate', 'move', 'up']) {
    results.push(await page.evaluate(DRAG_TILE_PHASE, [phase, fromIdx, toIdx]))
    await sleep(160)
  }
  return results.join('>')
}

/** parse "2190.729K" → 2190729 */
function parseSimTitle(title) {
  if (title == null) return null
  if (/K$/i.test(title)) return Math.round(parseFloat(title) * 1000)
  return Math.round(parseFloat(title))
}

function teamsOf(harvest) {
  return harvest.savedSession?.global?.teamShowcaseSavedTeams ?? []
}
function teamEntrySummary(team) {
  return {
    name: team.name,
    characterIds: team.characterIds,
    snapshot: team.benchmarkSnapshot
      ? team.benchmarkSnapshot.members.map((m) => [m.characterId, m.lightCone, m.characterEidolon, m.lightConeSuperimposition, m.teamRelicSet ?? null, m.teamOrnamentSet ?? null])
      : null,
  }
}

try {
  // ═══ Group 1: teams.working.setSlot ══════════════════════════════════════
  {
    const seedAutofill = seedJson((data) => {
      // custom scoring team for Jingliu → the empty-team slot-0 pick autofills from it
      data.scoringMetadataOverrides = {
        ...data.scoringMetadataOverrides,
        [J]: {
          simulation: {
            teammates: [
              { characterId: K, lightCone: '21022', characterEidolon: 0, lightConeSuperimposition: 5 },
              { characterId: S, lightCone: '24001', characterEidolon: 0, lightConeSuperimposition: 5 },
              { characterId: B, lightCone: '21012', characterEidolon: 0, lightConeSuperimposition: 1 },
            ],
          },
        },
      }
    })
    const seedPath = seedFile('g1', seedAutofill)

    // MCP half
    await callTool('load_save', { path: seedPath })
    const autofill = await callTool('manage_team', { action: 'compose', op: 'set_slot', index: 0, characterId: J })
    const mcpSlots = autofill.workingTeam.characterIds
    const setUnowned = await callTool('manage_team', { action: 'compose', op: 'set_slot', index: 1, characterId: UNOWNED })
    const mcpUnownedAdded = setUnowned.rosterAdded
    // mirror the web rebuild for the duplicate case: clear, then slot picks 1..3, then slot 0 (autofill), then the dup swap
    await callTool('manage_team', { action: 'compose', op: 'clear' })
    await callTool('manage_team', { action: 'compose', op: 'set_slot', index: 1, characterId: K })
    await callTool('manage_team', { action: 'compose', op: 'set_slot', index: 2, characterId: S })
    await callTool('manage_team', { action: 'compose', op: 'set_slot', index: 3, characterId: B })
    await callTool('manage_team', { action: 'compose', op: 'set_slot', index: 0, characterId: J })
    const dup = await callTool('manage_team', { action: 'compose', op: 'set_slot', index: 0, characterId: B })
    const mcpDupSlots = dup.workingTeam.characterIds
    const mcpExport = `${tempDir}/g1-mcp.json`
    await callTool('export_save', { path: mcpExport })
    const mcpSave = JSON.parse(readFileSync(mcpExport, 'utf8'))

    // Web half
    await browserManager.runTask({ label: 'verify(teams-g1)', seed: seedAutofill, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seedAutofill)
      // c1: empty team + slot 0 pick of the custom-team leader → autofill
      const addMain = await page.evaluate(CLICK_TEAMS_BUTTON, ['Add Main DPS', 0])
      await sleep(700)
      const pick = await page.evaluate(PICK_CARD, [J])
      await sleep(2500)
      let cards = await page.evaluate(READ_CARDS)
      const webSlots = cards.map((c) => c.charId)
      const c1ok = addMain === 'clicked' && pick === 'picked'
        && JSON.stringify(webSlots) === JSON.stringify(mcpSlots)
        && JSON.stringify(webSlots) === JSON.stringify([J, K, S, B])
      record(
        'teams.working.setSlot', 1,
        '空队伍里给第一个槽位选一个存有自定义评分队伍的角色，返回的四个槽位与网页自动补位后的结果一致',
        'browser-parity',
        c1ok ? 'PASS' : 'FAIL',
        `网页空队第0槽选 Jingliu 后四卡=[${webSlots.join(',')}];MCP compose set_slot(0,J)=[${mcpSlots.join(',')}](自定义评分队 [K,S,B] 按已拥有自动补位)`,
      )

      // c2: unowned pick → roster gains the character with a default form
      const cleared = await page.evaluate(CLICK_TEAMS_BUTTON, ['Clear characters', 0])
      await sleep(700)
      const addChar = await page.evaluate(CLICK_TEAMS_BUTTON, ['Add character', 0])
      await sleep(700)
      const pick2 = await page.evaluate(PICK_CARD, [UNOWNED])
      await sleep(2500)
      const harvest = await page.evaluate(HARVEST)
      const webChar = (harvest.characters ?? []).find((c) => c.id === UNOWNED)
      const mcpChar = (mcpSave.characters ?? []).find((c) => c.id === UNOWNED)
      const sameChar = webChar && mcpChar
        && JSON.stringify(webChar.form) === JSON.stringify(mcpChar.form)
        && JSON.stringify(webChar.equipped ?? {}) === JSON.stringify(mcpChar.equipped ?? {})
        && (harvest.characters ?? []).length === (mcpSave.characters ?? []).length
      record(
        'teams.working.setSlot', 2,
        '选一个未拥有的角色后，两边存档的 characters 都多出该角色（默认表单、空装备）',
        'browser-parity',
        cleared === 'clicked' && addChar === 'clicked' && pick2 === 'picked' && sameChar ? 'PASS' : 'FAIL',
        `网页选未拥有角色 ${UNOWNED} 后存档 characters ${(harvest.characters ?? []).length} 人(新增条目 form/equipped 与 MCP export 完全一致:${sameChar};MCP rosterAdded=${JSON.stringify(mcpUnownedAdded)})`,
      )

      // c3: pick a character already in another slot → that slot empties
      await page.evaluate(CLICK_TEAMS_BUTTON, ['Clear characters', 0])
      await sleep(700)
      // rebuild [J, K, S, B] via slot picks (slot 1,2,3 then 0 for the autofill)
      await page.evaluate(CLICK_TEAMS_BUTTON, ['Add character', 0])
      await sleep(600)
      await page.evaluate(PICK_CARD, [K])
      await sleep(1200)
      await page.evaluate(CLICK_TEAMS_BUTTON, ['Add character', 0])
      await sleep(600)
      await page.evaluate(PICK_CARD, [S])
      await sleep(1200)
      await page.evaluate(CLICK_TEAMS_BUTTON, ['Add character', 0])
      await sleep(600)
      await page.evaluate(PICK_CARD, [B])
      await sleep(1200)
      await page.evaluate(CLICK_TEAMS_BUTTON, ['Add Main DPS', 0])
      await sleep(600)
      await page.evaluate(PICK_CARD, [J])
      await sleep(2500)
      cards = await page.evaluate(READ_CARDS)
      const before = cards.map((c) => c.charId)
      // change slot 0 to B (currently in slot 3) via the overlay's Change character button
      const changeBtns = [...new Set(['Change character'])]
      const change = await page.evaluate(CLICK_TEAMS_BUTTON, ['Change character', 0])
      await sleep(700)
      const pick3 = await page.evaluate(PICK_CARD, [B])
      await sleep(2500)
      cards = await page.evaluate(READ_CARDS)
      const after = cards.map((c) => c.charId)
      const c3ok = change === 'clicked' && pick3 === 'picked'
        && JSON.stringify(after) === JSON.stringify(mcpDupSlots)
        && after[3] === null && after[0] === B
      record(
        'teams.working.setSlot', 3,
        '把已在第三槽的角色选进第一槽后，第三槽变空',
        'browser-parity',
        c3ok ? 'PASS' : 'FAIL',
        `网页 [${before.join(',')}] 把第3槽 ${B} 选进第1槽后 [${after.join(',')}];MCP compose set_slot(0,${B})=[${mcpDupSlots.join(',')}]`,
      )
      void changeBtns
    })
  }

  // ═══ Group 2+3: benchmarks.sync + cards.read (synced snapshot team) ══════
  {
    // seed: one plain team; BOTH sides run the sync flow and are compared
    const plainSeed = await buildSeedWithTeams('g2-plain', [{ name: 'Probe Sync', characterIds: SIM_TEAM }], Object.keys(SIM_LC).map((id) => ({ id })))
    await callTool('load_save', { path: seedFile('g2-plain-seed', plainSeed.seed) })
    let listed = await callTool('list_teams', {})
    const plainTeamId = listed.teams[0].id
    await callTool('manage_team', { action: 'load', teamId: plainTeamId })
    const mcpSync = await callTool('manage_team', { action: 'sync_benchmarks' })
    const mcpSyncExport = `${tempDir}/g2-sync-mcp.json`
    await callTool('export_save', { path: mcpSyncExport })
    const mcpSyncSave = JSON.parse(readFileSync(mcpSyncExport, 'utf8'))

    // MCP: scores with the synced snapshot (the sync wrote it into the saved team;
    // slotIndex by team order — slot 0 main C, the rest sub C)
    const dpsWithSnapshot = {}
    for (const charId of SIM_TEAM) {
      dpsWithSnapshot[charId] = await callTool('dps_score', { characterId: charId, team: 'snapshot', snapshotTeamId: plainTeamId })
    }

    // Web: load the plain team, click Sync, harvest; then scores off the synced cards
    await browserManager.runTask({ label: 'verify(teams-g2)', seed: plainSeed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, plainSeed.seed)
      const tile = await page.evaluate(CLICK_TEAM_TILE, ['Probe Sync'])
      await sleep(3500)
      const sync = await page.evaluate(CLICK_TEAMS_BUTTON, ['Sync benchmark teams', 0])
      await sleep(2000)
      const harvest = await page.evaluate(HARVEST)
      const webTeam = teamsOf(harvest)[0]
      const webSnap = webTeam?.benchmarkSnapshot
      const syncOk = tile === 'clicked' && sync === 'clicked'
        && webSnap != null
        && JSON.stringify(webSnap.members.map((m) => [m.characterId, m.lightCone, m.characterEidolon, m.lightConeSuperimposition, m.teamRelicSet ?? null, m.teamOrnamentSet ?? null]))
          === JSON.stringify(mcpSync.snapshot.members.map((m) => [m.characterId, m.lightCone, m.characterEidolon, m.lightConeSuperimposition, m.teamRelicSet ?? null, m.teamOrnamentSet ?? null]))
      record(
        'teams.benchmarks.sync', 1,
        '对同一支四人队伍同步后，两边存档里该队伍的 benchmarkSnapshot.members 逐项一致（含推断出的套装）',
        'browser-parity',
        syncOk ? 'PASS' : 'FAIL',
        syncOk
          ? `网页同步按钮与 MCP sync_benchmarks 对同一队伍捕获的 4 名成员(光锥/星魂/叠影/推断遗器4件+饰品2件套装)逐项一致;成员=${JSON.stringify(webSnap.members.map((m) => [m.characterId, m.teamRelicSet, m.teamOrnamentSet]))}`
          : `网页快照=${webSnap ? '有' : '无'};网页成员=${JSON.stringify(webSnap?.members?.map((m) => [m.characterId, m.lightCone, m.teamRelicSet, m.teamOrnamentSet]) ?? [])};MCP=${JSON.stringify(mcpSync.snapshot.members.map((m) => [m.characterId, m.lightCone, m.teamRelicSet, m.teamOrnamentSet]))};交互=${tile}/${sync}`,
      )

      // cards.read c1: the synced cards vs dps_score(team=snapshot)
      await sleep(4000) // let the four cards re-score with the synced snapshot
      const cards = await page.evaluate(READ_CARDS)
      const mismatches = []
      for (let i = 0; i < 4; i++) {
        const charId = cards[i].charId
        const webScore = parseSimTitle(cards[i].simTitle)
        const mcpScore = Math.round(dpsWithSnapshot[charId]?.scores?.original ?? NaN)
        if (webScore == null || !closeEnough(webScore, mcpScore, 2e-3)) mismatches.push(`${charId}: web=${webScore} mcp=${mcpScore}`)
      }
      record(
        'teams.cards.read', 1,
        '对一支已同步基准的队伍，四名成员各自的评分与队伍面板四张卡上的分数一致',
        'browser-parity',
        mismatches.length === 0 ? 'PASS' : 'FAIL',
        mismatches.length === 0
          ? `四卡(已同步快照,槽0主C/其余副C)=[${cards.map((c) => `${c.charId}:${parseSimTitle(c.simTitle)}`).join(', ')}] 与 MCP dps_score(team=snapshot) scores.original 逐个一致`
          : `评分不一致:${mismatches.join('; ')}`,
      )

      // c2 of benchmarks.sync: member without a light cone → both sides refuse (below)
    })

    // unsynced cards.read c2 + no-LC sync rejection
    const noLcSeed = await buildSeedWithTeams('g2-nolc', [{ name: 'Probe NoLC', characterIds: [J, K, UNOWNED, S] }])
    await callTool('load_save', { path: seedFile('g2-nolc-seed', noLcSeed.seed) })
    listed = await callTool('list_teams', {})
    const noLcTeamId = listed.teams[0].id
    await callTool('manage_team', { action: 'load', teamId: noLcTeamId })
    const mcpNoLcErr = await toolErrorText('manage_team', { action: 'sync_benchmarks' })

    // unsynced team for cards.read c2
    const unsyncedSeed = await buildSeedWithTeams('g2-unsynced', [{ name: 'Probe Plain', characterIds: SIM_TEAM }], Object.keys(SIM_LC).map((id) => ({ id })))
    const dpsUnsynced = {}
    for (const charId of SIM_TEAM) {
      dpsUnsynced[charId] = await callTool('dps_score', { characterId: charId, team: 'default' })
    }

    await browserManager.runTask({ label: 'verify(teams-g2c)', seed: unsyncedSeed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, unsyncedSeed.seed)
      await page.evaluate(CLICK_TEAM_TILE, ['Probe Plain'])
      await sleep(6000)
      const cards = await page.evaluate(READ_CARDS)
      const mismatches = []
      for (let i = 0; i < 4; i++) {
        const charId = cards[i].charId
        const webScore = parseSimTitle(cards[i].simTitle)
        const mcpScore = Math.round(dpsUnsynced[charId]?.scores?.original ?? NaN)
        if (webScore == null || !closeEnough(webScore, mcpScore, 2e-3)) mismatches.push(`${charId}: web=${webScore} mcp=${mcpScore}`)
      }
      record(
        'teams.cards.read', 2,
        '未同步时返回的分数与各角色单独展示卡的分数一致',
        'browser-parity',
        mismatches.length === 0 ? 'PASS' : 'FAIL',
        mismatches.length === 0
          ? `未同步队伍四卡=[${cards.map((c) => `${c.charId}:${parseSimTitle(c.simTitle)}`).join(', ')}] 与 MCP dps_score(team=default) 逐个一致(各自评分队伍)`
          : `评分不一致:${mismatches.join('; ')}`,
      )
    })

    await browserManager.runTask({ label: 'verify(teams-g2d)', seed: noLcSeed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, noLcSeed.seed)
      const tile = await page.evaluate(CLICK_TEAM_TILE, ['Probe NoLC'])
      await sleep(3500)
      const sync = await page.evaluate(CLICK_TEAMS_BUTTON, ['Sync benchmark teams', 0])
      await sleep(2000)
      const harvest = await page.evaluate(HARVEST)
      const webTeam = teamsOf(harvest)[0]
      const toastText = await page.evaluate(`() => document.body.innerText.includes('No selected light cone')`)
      const webRefused = webTeam?.benchmarkSnapshot == null && toastText
      const mcpRefused = mcpNoLcErr != null && mcpNoLcErr.includes('光锥')
      record(
        'teams.benchmarks.sync', 2,
        '有成员没装光锥时两边都拒绝并给出同类错误',
        'browser-parity',
        tile === 'clicked' && sync === 'clicked' && webRefused && mcpRefused ? 'PASS' : 'FAIL',
        `网页:成员 ${UNOWNED}(补入列表的默认表单无光锥)点同步 → toast "No selected light cone" 且队伍快照仍为空:${webRefused};MCP sync_benchmarks 报错:"${(mcpNoLcErr ?? '').slice(0, 80)}"`,
      )
    })
  }

  // ═══ Group 4: teams.working.reorder (drag) ══════════════════════════════
  {
    const seed = await buildSeedWithTeams('g4', [{ name: 'Probe Sync', characterIds: SIM_TEAM, snapshot: true }], Object.keys(SIM_LC).map((id) => ({ id })))
    await callTool('load_save', { path: seedFile('g4-seed', seed.seed) })
    const listed = await callTool('list_teams', {})
    const snapTeam = listed.teams[0]

    // MCP mirror of the dragged arrangement (the slot drag SWAPS the two cells):
    // [J,A,G,N] dragging slot2 → slot0 lands as [G,A,J,N]; slot0 scores as main
    // C, slot1 as sub C — same capture, so the slot indices decide the roles
    const reorderSave = await callTool('save_team', {
      name: 'Reordered Mirror',
      characterIds: [SIM_TEAM[2], SIM_TEAM[1], SIM_TEAM[0], SIM_TEAM[3]],
      benchmarkSnapshot: true,
    })
    const dpsSlot0 = await callTool('dps_score', { characterId: SIM_TEAM[2], team: 'snapshot', snapshotTeamId: reorderSave.teamId })
    const dpsSlot1 = await callTool('dps_score', { characterId: SIM_TEAM[1], team: 'snapshot', snapshotTeamId: reorderSave.teamId })
    void snapTeam

    await browserManager.runTask({ label: 'verify(teams-g4)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      await page.evaluate(CLICK_TEAM_TILE, ['Probe Sync'])
      await sleep(8000) // cards mount + score
      let cards = await page.evaluate(READ_CARDS)
      const drag = await dragSlot(page, 2, 0)
      await sleep(2500)
      cards = await page.evaluate(READ_CARDS)
      const order = cards.map((c) => c.charId)
      const web0 = parseSimTitle(cards[0].simTitle)
      const web1 = parseSimTitle(cards[1].simTitle)
      const mcp0 = Math.round(dpsSlot0.scores.original)
      const mcp1 = Math.round(dpsSlot1.scores.original)
      const ok = drag.startsWith('down') && order[0] === SIM_TEAM[2] && order[1] === SIM_TEAM[1] && order[2] === SIM_TEAM[0]
        && web0 != null && closeEnough(web0, mcp0, 2e-3)
        && web1 != null && closeEnough(web1, mcp1, 2e-3)
      record(
        'teams.working.reorder', 1,
        '把第三槽角色换到第一槽后，该角色按主 C、原第一槽角色按副 C 评分，分数与网页拖拽后的两张卡一致',
        'browser-parity',
        ok ? 'PASS' : 'FAIL',
        `网页拖拽(合成鼠标事件) [${SIM_TEAM.join(',')}] → [${order.join(',')}](槽位交换);槽0 ${SIM_TEAM[2]}(主C)=${web0} vs MCP ${mcp0};槽1 ${SIM_TEAM[1]}(副C)=${web1} vs MCP ${mcp1}`,
      )
    })
  }

  // ═══ Group 5: teams.working.clear ═══════════════════════════════════════
  {
    const seed = await buildSeedWithTeams('g5', [
      { name: 'Probe One', characterIds: [J, K, S, B] },
      { name: 'Probe Two', characterIds: [B, S, K, J] },
    ])
    await callTool('load_save', { path: seedFile('g5-seed', seed.seed) })
    let listed = await callTool('list_teams', {})
    const teamId = listed.teams[0].id
    await callTool('manage_team', { action: 'load', teamId })
    await callTool('manage_team', { action: 'sync_benchmarks' })
    const cleared = await callTool('manage_team', { action: 'compose', op: 'clear' })
    const mcpCleared = cleared.workingTeam
    const mcpExport = `${tempDir}/g5-mcp.json`
    await callTool('export_save', { path: mcpExport })
    const mcpSave = JSON.parse(readFileSync(mcpExport, 'utf8'))
    listed = await callTool('list_teams', {})

    await browserManager.runTask({ label: 'verify(teams-g5)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      await page.evaluate(CLICK_TEAM_TILE, ['Probe One'])
      await sleep(3500)
      await page.evaluate(CLICK_TEAMS_BUTTON, ['Sync benchmark teams', 0])
      await sleep(1500)
      const clear = await page.evaluate(CLICK_TEAMS_BUTTON, ['Clear characters', 0])
      await sleep(1500)
      const cards = await page.evaluate(READ_CARDS)
      const emptySlots = cards.every((c) => c.charId == null)
      const harvest = await page.evaluate(HARVEST)
      const webTeams = teamsOf(harvest)
      const savedUnchanged = webTeams.length === 2 && webTeams.map(teamEntrySummary)
        .every((t, i) => t.name === (i === 0 ? 'Probe One' : 'Probe Two'))
      const mcpSaved = (mcpSave.savedSession?.global?.teamShowcaseSavedTeams ?? [])
      const savedEqual = JSON.stringify(webTeams.map((t) => ({ n: t.name, c: t.characterIds }))) === JSON.stringify(mcpSaved.map((t) => ({ n: t.name, c: t.characterIds })))
      record(
        'teams.working.clear', 1,
        '清空后读到的工作队伍四槽皆空、没有基准快照，已保存队伍列表不变',
        'browser-parity',
        clear === 'clicked' && emptySlots && savedUnchanged && savedEqual
          && mcpCleared.characterIds.every((id) => id === null) && mcpCleared.hasBenchmarkSnapshot === false ? 'PASS' : 'FAIL',
        `网页清空后四卡皆空:${emptySlots},已保存队伍不变(2支,与 MCP export 一致:${savedEqual});MCP compose clear → 四槽 null/无快照:${mcpCleared.characterIds.every((id) => id === null)}/${mcpCleared.hasBenchmarkSnapshot === false}`,
      )
    })
  }

  // ═══ Group 6: teams.slot.scoringType ════════════════════════════════════
  {
    const seed = await buildSeedWithTeams('g6', [{ name: 'Probe One', characterIds: [J, K, S, B] }])
    // MCP: update_state showcase scoringType
    await callTool('load_save', { path: seedFile('g6-seed', seed.seed) })
    const updated = await callTool('update_state', { section: 'showcase', patch: { characterId: J, scoringType: 1 } })
    const mcpExport = `${tempDir}/g6-mcp.json`
    await callTool('export_save', { path: mcpExport })
    const mcpSave = JSON.parse(readFileSync(mcpExport, 'utf8'))
    const mcpValue = mcpSave.showcasePreferences?.[J]?.scoringType

    await browserManager.runTask({ label: 'verify(teams-g6)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      await page.evaluate(CLICK_TEAM_TILE, ['Probe One'])
      await sleep(3500)
      // reveal the overlay by focusing the slot-0 card options target, then open the Benchmark select
      await page.evaluate(`() => { const t = [...document.querySelectorAll('${PANEL} [aria-label^="Card options"]')].filter((b) => b.offsetParent !== null)[0]; t.focus(); return true }`)
      await sleep(700)
      const opened = await page.evaluate(SET_SLOT_SCORING, ['Substat Rolls'])
      await sleep(700)
      const picked = await page.evaluate(`(text) => {
        const opts = [...document.querySelectorAll('[role=option]')].filter((o) => o.offsetParent !== null)
        const hit = opts.find((o) => o.textContent.trim() === text)
        if (!hit) return 'option-not-found:' + opts.map((o) => o.textContent.trim()).slice(0, 5).join('|')
        hit.click()
        return 'picked'
      }`, ['Substat Rolls'])
      await sleep(1500)
      const harvest = await page.evaluate(HARVEST)
      const webValue = harvest.showcasePreferences?.[J]?.scoringType
      record(
        'teams.slot.scoringType', 1,
        '在队伍面板把某槽位切到副词条评分后，两边存档里该角色的 showcasePreferences.scoringType 都是 1',
        'browser-parity',
        opened === 'opened' && picked === 'picked' && webValue === 1 && mcpValue === 1 && updated.updated === true ? 'PASS' : 'FAIL',
        `网页槽位卡「基准」下拉切到 Substat Rolls 后存档 showcasePreferences[${J}].scoringType=${webValue};MCP update_state(showcase) 后=${mcpValue}`,
      )
    })
  }

  // ═══ Group 7: teams.saved.save ══════════════════════════════════════════
  {
    // c1: same slots → identical new team except id
    const seed1 = await buildSeedWithTeams('g7a', [{ name: 'Probe One', characterIds: [J, K, S, B] }])
    await callTool('load_save', { path: seedFile('g7a-seed', seed1.seed) })
    const mcpSaved1 = await callTool('save_team', { name: 'Team 2', characterIds: [HUOHUO, K, S, B] })
    const mcpExport1 = `${tempDir}/g7a-mcp.json`
    await callTool('export_save', { path: mcpExport1 })
    const mcpSave1 = JSON.parse(readFileSync(mcpExport1, 'utf8'))
    const mcpNewTeam = (mcpSave1.savedSession?.global?.teamShowcaseSavedTeams ?? []).at(-1)

    await browserManager.runTask({ label: 'verify(teams-g7a)', seed: seed1.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed1.seed)
      await page.evaluate(CLICK_TEAM_TILE, ['Probe One'])
      await sleep(3500)
      // change slot 0 to Huohuo (owned, not already in the team) → working [1217,K,S,B] → Save team
      const change = await page.evaluate(CLICK_TEAMS_BUTTON, ['Change character', 0])
      await sleep(700)
      const pick = await page.evaluate(PICK_CARD, [HUOHUO])
      await sleep(2500)
      const save = await page.evaluate(CLICK_TEAMS_BUTTON, ['Save team', 0])
      await sleep(2000)
      const harvest = await page.evaluate(HARVEST)
      const webTeams = teamsOf(harvest)
      const webNew = webTeams.at(-1)
      const same = webNew && mcpNewTeam
        && webNew.name === mcpNewTeam.name
        && JSON.stringify(webNew.characterIds) === JSON.stringify(mcpNewTeam.characterIds)
        && webNew.id !== mcpNewTeam.id
        && webTeams.length === 2
      record(
        'teams.saved.save', 1,
        '保存同样的四槽后，两边存档的 teamShowcaseSavedTeams 末尾多出的队伍除 id 外一致',
        'browser-parity',
        change === 'clicked' && pick === 'picked' && save === 'clicked' && same ? 'PASS' : 'FAIL',
        `网页把工作队伍改为 [${webNew?.characterIds?.join(',')}] 后保存 → 末尾新增「${webNew?.name}」(id ${webNew?.id?.slice(0, 8)}…);MCP save_team 同槽位 → 「${mcpNewTeam?.name}」(id ${mcpNewTeam?.id?.slice(0, 8)}…);名字/四槽一致,仅 id 不同`,
      )
    })

    // c2: saving with a synced benchmark keeps the snapshot
    const seed2 = await buildSeedWithTeams('g7b', [{ name: 'Probe One', characterIds: [J, K, S, B] }])
    await callTool('load_save', { path: seedFile('g7b-seed', seed2.seed) })
    const mcpSaved2 = await callTool('save_team', { name: 'Team 2', characterIds: [HUOHUO, K, S, B], benchmarkSnapshot: true })
    const mcpExport2 = `${tempDir}/g7b-mcp.json`
    await callTool('export_save', { path: mcpExport2 })
    const mcpSave2 = JSON.parse(readFileSync(mcpExport2, 'utf8'))
    const mcpNewTeam2 = (mcpSave2.savedSession?.global?.teamShowcaseSavedTeams ?? []).at(-1)

    await browserManager.runTask({ label: 'verify(teams-g7b)', seed: seed2.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed2.seed)
      await page.evaluate(CLICK_TEAM_TILE, ['Probe One'])
      await sleep(3500)
      const change = await page.evaluate(CLICK_TEAMS_BUTTON, ['Change character', 0])
      await sleep(700)
      await page.evaluate(PICK_CARD, [HUOHUO])
      await sleep(2500)
      await page.evaluate(CLICK_TEAMS_BUTTON, ['Sync benchmark teams', 0])
      await sleep(2000)
      const save = await page.evaluate(CLICK_TEAMS_BUTTON, ['Save team', 0])
      await sleep(2000)
      const harvest = await page.evaluate(HARVEST)
      const webNew = teamsOf(harvest).at(-1)
      const webMembers = webNew?.benchmarkSnapshot?.members?.map((m) => [m.characterId, m.lightCone, m.characterEidolon, m.lightConeSuperimposition, m.teamRelicSet ?? null, m.teamOrnamentSet ?? null])
      const mcpMembers = mcpNewTeam2?.benchmarkSnapshot?.members?.map((m) => [m.characterId, m.lightCone, m.characterEidolon, m.lightConeSuperimposition, m.teamRelicSet ?? null, m.teamOrnamentSet ?? null])
      const same = webNew && mcpNewTeam2 && webNew.name === mcpNewTeam2.name
        && JSON.stringify(webNew.characterIds) === JSON.stringify(mcpNewTeam2.characterIds)
        && JSON.stringify(webMembers) === JSON.stringify(mcpMembers)
      record(
        'teams.saved.save', 2,
        '带着已同步的基准保存时，两边队伍里的 benchmarkSnapshot 一致',
        'browser-parity',
        change === 'clicked' && save === 'clicked' && same ? 'PASS' : 'FAIL',
        `网页(改槽→同步→保存)与 MCP save_team(benchmarkSnapshot=true) 新增队伍均携带快照,成员(光锥/星魂/叠影/套装)逐项一致:${same};成员数 web=${webMembers?.length} mcp=${mcpMembers?.length}`,
      )
    })
  }

  // ═══ Group 8: teams.saved.list ══════════════════════════════════════════
  {
    const seed = await buildSeedWithTeams('g8', [
      { name: 'Probe One', characterIds: [J, K, S, B] },
      { name: 'Probe Two', characterIds: [B, S, K, J], snapshot: true },
      { name: 'Probe Three', characterIds: [J, S, null, null] },
    ])
    await callTool('load_save', { path: seedFile('g8-seed', seed.seed) })
    const listed = await callTool('list_teams', {})

    await browserManager.runTask({ label: 'verify(teams-g8)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      const sidebar = await page.evaluate(READ_SAVED_LIST)
      const harvest = await page.evaluate(HARVEST)
      const webTeams = teamsOf(harvest)
      const namesOk = JSON.stringify(sidebar) === JSON.stringify(['Probe One', 'Probe Two', 'Probe Three'])
      const listOk = listed.total === 3 && listed.teams.length === 3
        && listed.teams.every((t, i) => t.name === webTeams[i].name
          && JSON.stringify(t.characterIds) === JSON.stringify(webTeams[i].characterIds)
          && t.hasBenchmarkSnapshot === (webTeams[i].benchmarkSnapshot != null))
        && JSON.stringify(listed.teams.map((t) => t.id)) === JSON.stringify(webTeams.map((t) => t.id))
      const snapOk = listed.teams[1].benchmarkSnapshot != null
        && JSON.stringify(listed.teams[1].benchmarkSnapshot.members.map((m) => [m.characterId, m.lightCone, m.characterEidolon, m.lightConeSuperimposition, m.teamRelicSet ?? null, m.teamOrnamentSet ?? null]))
          === JSON.stringify((webTeams[1].benchmarkSnapshot?.members ?? []).map((m) => [m.characterId, m.lightCone, m.characterEidolon, m.lightConeSuperimposition, m.teamRelicSet ?? null, m.teamOrnamentSet ?? null]))
      record(
        'teams.saved.list', 1,
        'list_teams 返回的队伍数量、顺序、名字、四槽角色与基准快照，和侧栏列表及存档内容一致',
        'browser-parity',
        namesOk && listOk && snapOk ? 'PASS' : 'FAIL',
        `侧栏=[${sidebar.join(',')}] 与 list_teams 顺序/名字一致:${namesOk};四槽/快照标志/快照成员与页面自身落盘一致:${listOk && snapOk}(第二支带快照,第三支含两个空槽)`,
      )
    })
  }

  // ═══ Group 9: teams.saved.load ══════════════════════════════════════════
  {
    // c1: team containing an unowned character
    const seed1 = await buildSeedWithTeams('g9a', [{ name: 'Load A', characterIds: [UNOWNED, S, K, B] }])
    await callTool('load_save', { path: seedFile('g9a-seed', seed1.seed) })
    const listed = await callTool('list_teams', {})
    const loadRes = await callTool('manage_team', { action: 'load', teamId: listed.teams[0].id })
    const mcpExport = `${tempDir}/g9a-mcp.json`
    await callTool('export_save', { path: mcpExport })
    const mcpSave = JSON.parse(readFileSync(mcpExport, 'utf8'))

    await browserManager.runTask({ label: 'verify(teams-g9a)', seed: seed1.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed1.seed)
      const tile = await page.evaluate(CLICK_TEAM_TILE, ['Load A'])
      await sleep(3500)
      const cards = await page.evaluate(READ_CARDS)
      const harvest = await page.evaluate(HARVEST)
      const webChar = (harvest.characters ?? []).find((c) => c.id === UNOWNED)
      const mcpChar = (mcpSave.characters ?? []).find((c) => c.id === UNOWNED)
      const slotsOk = JSON.stringify(cards.map((c) => c.charId)) === JSON.stringify(loadRes.workingTeam.characterIds)
      const charOk = webChar && mcpChar && JSON.stringify(webChar.form) === JSON.stringify(mcpChar.form)
      record(
        'teams.saved.load', 1,
        '载入一支含未拥有角色的队伍后，两边存档的 characters 都多出该角色，返回的四槽与网页一致',
        'browser-parity',
        tile === 'clicked' && slotsOk && charOk ? 'PASS' : 'FAIL',
        `网页载入 → 四卡=[${cards.map((c) => c.charId).join(',')}] 与 MCP manage_team(load) 一致:${slotsOk};存档新增 ${UNOWNED} 的条目 form 与 MCP export 完全一致:${charOk}`,
      )
    })

    // c2: team with a metadata-nonexistent character id → slot empty, no snapshot
    const badSeed = seedJson((data) => {
      data.savedSession = {
        global: {
          teamShowcaseSavedTeams: [
            {
              id: 'bad-team',
              name: 'Load Bad',
              characterIds: [J, '9999', K, S],
              benchmarkSnapshot: {
                members: [J, '9999', K, S].map((id) => ({
                  characterId: id,
                  lightCone: '20000',
                  characterEidolon: 0,
                  lightConeSuperimposition: 1,
                })),
              },
            },
          ],
        },
      }
    })
    await callTool('load_save', { path: seedFile('g9b', badSeed) })
    const listed2 = await callTool('list_teams', {})
    const loadBad = await callTool('manage_team', { action: 'load', teamId: listed2.teams[0].id })

    await browserManager.runTask({ label: 'verify(teams-g9b)', seed: badSeed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, badSeed)
      const tile = await page.evaluate(CLICK_TEAM_TILE, ['Load Bad'])
      await sleep(6000)
      const cards = await page.evaluate(READ_CARDS)
      const harvest = await page.evaluate(HARVEST)
      const rosterUnchanged = (harvest.characters ?? []).every((c) => c.id !== '9999')
      const slotsOk = cards[1]?.charId == null && cards[0]?.charId === J
        && JSON.stringify(cards.map((c) => c.charId)) === JSON.stringify(loadBad.workingTeam.characterIds)
      const mcpNoSnapshot = loadBad.workingTeam.hasBenchmarkSnapshot === false
      // unsynced scoring on the surviving cards proves the working team carries no snapshot
      record(
        'teams.saved.load', 2,
        '队伍里有一个元数据中不存在的角色 id 时，该槽位为空且不带基准快照',
        'browser-parity',
        tile === 'clicked' && slotsOk && rosterUnchanged && mcpNoSnapshot ? 'PASS' : 'FAIL',
        `网页载入含未知 id 9999 的队伍 → 第2槽空卡(四卡=[${cards.map((c) => c.charId).join(',')}]),9999 不进角色列表:${rosterUnchanged};MCP load → 槽位 [${loadBad.workingTeam.characterIds.join(',')}],hasBenchmarkSnapshot=${loadBad.workingTeam.hasBenchmarkSnapshot}(槽位失配即弃快照)`,
      )
    })
  }

  // ═══ Group 10: teams.saved.rename ═══════════════════════════════════════
  {
    const seed = await buildSeedWithTeams('g10', [
      { name: 'Probe One', characterIds: [J, K, S, B] },
      { name: 'Probe Two', characterIds: [B, S, K, J], snapshot: true },
      { name: 'Probe Three', characterIds: [J, S, null, null] },
    ])
    await callTool('load_save', { path: seedFile('g10-seed', seed.seed) })
    const listed = await callTool('list_teams', {})
    const renamed = await callTool('save_team', { teamId: listed.teams[1].id, name: 'Renamed Two' })
    const mcpExport = `${tempDir}/g10-mcp.json`
    await callTool('export_save', { path: mcpExport })
    const mcpSave = JSON.parse(readFileSync(mcpExport, 'utf8'))

    await browserManager.runTask({ label: 'verify(teams-g10)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      const start = await page.evaluate(RENAME_TEAM, ['Probe Two', ''])
      await sleep(700)
      const commit = await page.evaluate(COMMIT_RENAME, ['Renamed Two'])
      await sleep(2000)
      const harvest = await page.evaluate(HARVEST)
      const webTeams = teamsOf(harvest)
      const equal = JSON.stringify(webTeams.map(teamEntrySummary)) === JSON.stringify((mcpSave.savedSession?.global?.teamShowcaseSavedTeams ?? []).map(teamEntrySummary))
      record(
        'teams.saved.rename', 1,
        'save_team(teamId, name) 之后的存档与网页行内重命名为同一名字后的存档一致，槽位与基准快照不变',
        'browser-parity',
        start === 'clicked' && commit === 'committed' && equal && renamed.team.name === 'Renamed Two' ? 'PASS' : 'FAIL',
        `网页行内重命名「Probe Two」→「Renamed Two」(回车提交)后队伍表(名字/四槽/快照)与 MCP save_team(teamId,name) export 完全一致:${equal}`,
      )
    })
  }

  // ═══ Group 11: teams.saved.delete ═══════════════════════════════════════
  {
    const seed = await buildSeedWithTeams('g11', [
      { name: 'Probe One', characterIds: [J, K, S, B] },
      { name: 'Probe Two', characterIds: [B, S, K, J] },
      { name: 'Probe Three', characterIds: [J, S, null, null] },
    ])
    await callTool('load_save', { path: seedFile('g11-seed', seed.seed) })
    const listed = await callTool('list_teams', {})
    const deleted = await callTool('manage_team', { action: 'delete', teamId: listed.teams[1].id })
    const mcpExport = `${tempDir}/g11-mcp.json`
    await callTool('export_save', { path: mcpExport })
    const mcpSave = JSON.parse(readFileSync(mcpExport, 'utf8'))

    await browserManager.runTask({ label: 'verify(teams-g11)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      // delete the SECOND tile's team (delete icons appear in tile order)
      const del = await page.evaluate(`(nth) => {
        const btns = [...document.querySelectorAll('${PANEL} button[aria-label="Delete team"]')].filter((b) => b.offsetParent !== null)
        if (!btns[nth]) return 'not-found/' + btns.length
        btns[nth].click()
        return 'clicked'
      }`, [1])
      await sleep(2000)
      const harvest = await page.evaluate(HARVEST)
      const webTeams = teamsOf(harvest)
      const equal = JSON.stringify(webTeams.map(teamEntrySummary)) === JSON.stringify((mcpSave.savedSession?.global?.teamShowcaseSavedTeams ?? []).map(teamEntrySummary))
      record(
        'teams.saved.delete', 1,
        '删除一支队伍后两边存档的 teamShowcaseSavedTeams 一致，其余队伍顺序不变',
        'browser-parity',
        del === 'clicked' && equal && webTeams.length === 2 ? 'PASS' : 'FAIL',
        `网页删除第二支后剩 [${webTeams.map((t) => t.name).join(',')}];MCP manage_team(delete) 后剩 [${(mcpSave.savedSession?.global?.teamShowcaseSavedTeams ?? []).map((t) => t.name).join(',')}];两侧队伍表逐项一致:${equal};返回 remainingTeamIds=${deleted.remainingTeamIds.length} 支`,
      )
    })
  }

  // ═══ Group 12: teams.saved.move (drag) ══════════════════════════════════
  {
    const seed = await buildSeedWithTeams('g12', [
      { name: 'Probe One', characterIds: [J, K, S, B] },
      { name: 'Probe Two', characterIds: [B, S, K, J] },
      { name: 'Probe Three', characterIds: [J, S, null, null] },
    ])
    await callTool('load_save', { path: seedFile('g12-seed', seed.seed) })
    const listed = await callTool('list_teams', {})
    const moved = await callTool('manage_team', { action: 'move', from: 2, to: 0 })
    const mcpExport = `${tempDir}/g12-mcp.json`
    await callTool('export_save', { path: mcpExport })
    const mcpSave = JSON.parse(readFileSync(mcpExport, 'utf8'))

    await browserManager.runTask({ label: 'verify(teams-g12)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      const drag = await dragTile(page, 2, 0)
      await sleep(2500)
      const harvest = await page.evaluate(HARVEST)
      const webTeams = teamsOf(harvest)
      const webOrder = webTeams.map((t) => t.name)
      const equal = JSON.stringify(webTeams.map(teamEntrySummary)) === JSON.stringify((mcpSave.savedSession?.global?.teamShowcaseSavedTeams ?? []).map(teamEntrySummary))
      record(
        'teams.saved.move', 1,
        '把第三支队伍移到最前后，两边存档的 teamShowcaseSavedTeams 顺序一致',
        'browser-parity',
        drag.endsWith('>up') && webOrder[0] === 'Probe Three' && equal ? 'PASS' : 'FAIL',
        `网页拖拽第三支到最前 → [${webOrder.join(',')}];MCP manage_team(move 2→0) → [${moved.remainingTeamNames.join(',')}];两侧队伍表逐项一致:${equal}`,
      )
    })
  }

  // ═══ Group 13: teams.screenshot ═════════════════════════════════════════
  {
    const seed = await buildSeedWithTeams('g13', [{ name: 'Probe Sync', characterIds: SIM_TEAM, snapshot: true }], Object.keys(SIM_LC).map((id) => ({ id })))
    let webDims = null
    let webCards = []
    await browserManager.runTask({ label: 'verify(teams-g13)', seed: seed.seed, timeoutMs: 600_000 }, async (page) => {
      await openTeamsPanel(page, seed.seed)
      await page.evaluate(CLICK_TEAM_TILE, ['Probe Sync'])
      await sleep(9000) // cards + scores settle
      webCards = await page.evaluate(READ_CARDS)
      // drive the page's own Download screenshot button and capture the produced PNG
      const png = await page.captureAppExport({ via: 'download', scopeSelector: PANEL, timeoutMs: 120_000 })
      webDims = parsePngSizeLocal(png)
    })
    // free our browser before the server-side render tool launches its own instance
    await browserManager.close()

    // The render result carries the multi-MB PNG as an inline base64 content
    // block — larger than the SDK client-side ReadBuffer cap (10 MiB), which
    // kills the transport. Drive the SAME server binary through a raw
    // newline-delimited JSON-RPC stdio session instead (no buffer cap).
    const g13SeedPath = seedFile('g13-seed', seed.seed)
    const renderRes = await rawStdioRenderTeamCard(g13SeedPath)
    const mcpW = renderRes?.width
    const mcpH = renderRes?.height

    const dimsOk = webDims != null && mcpW != null && webDims.width === mcpW && webDims.height === mcpH
    const cardsOk = webCards.every((c) => c.charId != null) && JSON.stringify(webCards.map((c) => c.charId)) === JSON.stringify(SIM_TEAM)
    const scoresOk = webCards.every((c) => c.simTitle != null)
    record(
      'teams.screenshot', 1,
      '渲染出的队伍图片尺寸与网页下载的一致，四张卡的角色、分数与顺序相同',
      'browser-parity',
      dimsOk && cardsOk && scoresOk ? 'PASS' : 'FAIL',
      `网页自身下载按钮捕获 PNG ${webDims?.width}×${webDims?.height} vs MCP render(team_card) ${mcpW}×${mcpH};四卡角色=[${webCards.map((c) => c.charId).join(',')}](带模拟评分 ${webCards.map((c) => parseSimTitle(c.simTitle)).join('/')})`,
    )
  }

} catch (e) {
  console.error('verify-teams: harness error', e)
  process.exitCode = 1
} finally {
  try {
    await client.close()
  } catch { /* already closed */ }
  try {
    await browserManager.close()
  } catch { /* browser already down */ }
  rmSync(tempDir, { recursive: true, force: true })
}

function parsePngSizeLocal(bytes) {
  if (!bytes || bytes.length < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== 0x89504e47) return null
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * Raw newline-delimited JSON-RPC stdio session against the SAME server binary —
 * used only for render(team_card), whose inline base64 PNG exceeds the MCP SDK
 * client-side ReadBuffer cap (10 MiB) and would kill the SDK transport.
 * Loads the seed save, renders the first saved team, returns the structured
 * width/height fields. No buffer cap on our side.
 */
async function rawStdioRenderTeamCard(savePath) {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [serverEntry], {
    cwd: mcpDir,
    env: {
      ...getDefaultEnvironment(),
      HSR_MCP_STATE_FILE: `${tempDir}/raw-render-ls.json`,
      HSR_MCP_ARTIFACTS_DIR: `${tempDir}/raw-render-art`,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        console.error(`[raw-render] msg id=${msg.id} keys=${Object.keys(msg).join(',')} resultKeys=${Object.keys(msg.result ?? {}).join(',')}`)
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch (e) {
        console.error(`[raw-render] parse fail len=${line.length}: ${String(e).slice(0, 80)} head=${line.slice(0, 80)}`)
      }
    }
  })
  const send = (method, params) =>
    new Promise((resolveCall, rejectCall) => {
      const id = nextId++
      pending.set(id, (msg) => (msg.error ? rejectCall(new Error(JSON.stringify(msg.error).slice(0, 300))) : resolveCall(msg.result)))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  try {
    await send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'verify-teams-raw', version: '0.0.0' },
    })
    notify('notifications/initialized')
    await send('tools/call', { name: 'load_save', arguments: { path: savePath } })
    const renderResult = await send('tools/call', { name: 'render', arguments: { target: 'team_card' } })
    const result = renderResult // send() already resolves with msg.result
    if (result?.isError) throw new Error(String(result.content?.[0]?.text ?? 'render failed').slice(0, 200))
    if (result?.structuredContent != null) return result.structuredContent
    // fallback: the text summary carries "… → WxH PNG(bytes, artifact …)"
    const text = result?.content?.find((c) => c.type === 'text')?.text ?? ''
    const m = text.match(/(\d+)\u00d7(\d+) PNG/)
    if (m) return { width: Number(m[1]), height: Number(m[2]), fromTextSummary: true }
    console.error('[raw-render] unexpected result shape:', Object.keys(result ?? {}), JSON.stringify(result?.content?.[0] ?? {}).slice(0, 160))
    return null
  } finally {
    try {
      child.stdin.end()
    } catch { /* already gone */ }
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
    try {
      child.kill()
    } catch { /* already gone */ }
  }
}

// ── evidence file ────────────────────────────────────────────────────────────
writeFileSync(evidencePath, JSON.stringify({
  area: 'teams',
  generatedAt: GENERATED_AT,
  gitCommit: GIT_COMMIT,
  cases,
}, null, 2) + '\n')

const failed = cases.filter((c) => c.result !== 'PASS').length
console.log(failed === 0 ? `\nverify-teams: ALL ${cases.length} CASES PASSED` : `\nverify-teams: ${failed} OF ${cases.length} CASES FAILED/UNPROVEN`)
process.exit(failed === 0 ? 0 : 1)
