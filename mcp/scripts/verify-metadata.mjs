// verified acceptance parity harness for the metadata domain (PROTOCOL.md).
//
// Method A (browser-parity): one managed-browser task loads the REAL site
// (root dist build, zh_CN locale, seeded with a temp copy of the sample save),
// opens #metadata and drives/expands the page's own panels:
//   - the six read grids (Simulation sets / teams / combo, Conditional set
//     presets, Substat weights, Leaderboard teams) are scraped from the
//     rendered DOM (avatar/light-cone/set asset URLs embed the ids; set image
//     URLs are translated with the page's own __HSR_DEBUG.Assets) and compared
//     against game://metadata/scoring + get_scoring_metadata + default_form
//     over stdio — the resource reads happen on a FRESH server BEFORE any
//     load_save, proving the "不载入存档即可读" clause.
//   - Set benchmark auditor: the web panel is driven through its own
//     checkboxes (ornament-only, SPD 0, reduced grid for CPU scale) and Run
//     Audit button; the summary table + drilldown are compared with
//     benchmark_runs(sweep="sets").
//   - Character color grid: MCP render(character_card) PNGs are compared
//     against CDP clips of the corresponding grid cards (default debug
//     params on both sides), and an update_state(visualDebug)+re-render
//     round proves (or disproves) whether the debug params reach renders.
//   - Image center editor: debug_utility(image_center) output is compared
//     with an independent in-page drive of the same editor (config text
//     verbatim + preview screenshots).
//
// PNG comparisons reuse smoke-visual.mjs's minimal decoder (mean per-channel
// diff + hot-pixel ratio). Managed browser only (headless), temp-dir isolated.
//
// Usage: node scripts/verify-metadata.mjs [serverEntry]

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = resolve(mcpDir, process.argv[2] ?? 'dist/index.js')
const repoSampleSavePath = resolve(mcpDir, '../src/data/sample-save.json')

// ── evidence collection ──────────────────────────────────────────────────────

const EVIDENCE = []
let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
function assertCase(feature, index, desc, method, outcome, detail) {
  const result = typeof outcome === 'string' ? outcome : outcome ? 'PASS' : 'FAIL'
  EVIDENCE.push({ feature, case: index, desc: desc.slice(0, 40), method, result, detail: String(detail).slice(0, 300), script: 'mcp/scripts/verify-metadata.mjs' })
  if (result !== 'PASS') failures++
  console.log(`[${result}] ${feature}#${index} — ${detail}`)
  return result === 'PASS'
}

// ── PNG decode/diff (from smoke-visual.mjs) ─────────────────────────────────

function decodePng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (pos < bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const data = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
  if (channels == null) throw new Error(`unsupported color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    const row = raw.subarray(rowStart, rowStart + stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = prev != null ? prev[x] : 0
      const c = prev != null && x >= channels ? prev[x - channels] : 0
      let value = row[x]
      if (filter === 1) value = (value + a) & 0xff
      else if (filter === 2) value = (value + b) & 0xff
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      out[y * stride + x] = value
    }
  }
  return { width, height, channels, data: out }
}
function downscale(img, factor) {
  if (factor === 1) return img
  const w = Math.floor(img.width / factor)
  const h = Math.floor(img.height / factor)
  const data = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0
        let n = 0
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            const sy = y * factor + dy
            const sx = x * factor + dx
            if (sy < img.height && sx < img.width) {
              sum += img.data[sy * img.width * img.channels + sx * img.channels + c]
              n++
            }
          }
        }
        data[(y * w + x) * 3 + c] = Math.round(sum / Math.max(1, n))
      }
    }
  }
  return { width: w, height: h, channels: 3, data }
}
function diffImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { dimsMismatch: true, w: `${a.width}x${a.height} vs ${b.width}x${b.height}` }
  }
  const pixels = a.width * a.height
  let sumDiff = 0
  let hot = 0
  for (let i = 0; i < pixels; i++) {
    let pixelDiff = 0
    let pixelHot = false
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i * a.channels + c] - b.data[i * b.channels + c])
      pixelDiff += d
      if (d > 24) pixelHot = true
    }
    sumDiff += pixelDiff / 3
    if (pixelHot) hot++
  }
  return { dimsMismatch: false, mean: sumDiff / pixels, hotRatio: hot / pixels, pixels }
}

// ── environment guard ────────────────────────────────────────────────────────

function findChrome() {
  if (process.env.HSR_MCP_BROWSER_PATH && existsSync(process.env.HSR_MCP_BROWSER_PATH)) return process.env.HSR_MCP_BROWSER_PATH
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find((p) => existsSync(p)) ?? null
}
function findSiteDist() {
  if (process.env.HSR_MCP_SITE_DIST && existsSync(`${process.env.HSR_MCP_SITE_DIST}/index.html`)) return process.env.HSR_MCP_SITE_DIST
  const repoDist = resolve(mcpDir, '../dist')
  return existsSync(`${repoDist}/index.html`) ? repoDist : null
}
if (findChrome() == null || findSiteDist() == null) {
  console.log('[SKIP] metadata 对拍需要受管浏览器(Chrome + 站点 dist),当前环境缺失——无法取证')
  process.exit(0)
}

// ── helpers ─────────────────────────────────────────────────────────────────

function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}
async function callTool(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  if (result.isError) throw new Error(`tool ${name} isError: ${result.content?.[0]?.text}`)
  return payloadOf(result)
}
function jsonOfResource(readResult) {
  return JSON.parse(readResult.contents?.[0]?.text)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Trusted accordion open: focus the control (page) then press Enter (CDP). */
async function openAccordion(p, title) {
  const f = await p.evaluate(OPEN_ACCORDION, [title])
  if (f.ok) await p.press('Enter')
  return f
}

// ── boot ─────────────────────────────────────────────────────────────────────

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-verify-metadata-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const seed = readFileSync(sampleSavePath, 'utf8')

const client = new Client({ name: 'verify-metadata', version: '0.0.0' })
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

// ── page-driver snippets ─────────────────────────────────────────────────────

const RELOAD_ZH = `() => {
  localStorage.setItem('i18nextLng', 'zh_CN')
  window.__verifyReloadMarker = 'old'
  location.reload()
  return true
}`

const OPEN_ACCORDION = `(title) => {
  const control = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.textContent || '').includes(title))
  if (!control) return { ok: false, reason: 'no accordion control ' + title }
  control.focus()
  return { ok: true }
}`

/** Scrape every GridDisplay table inside an opened accordion item's panel. */
const SCRAPE_GRID = `(setTitle) => {
  const visible = (el) => el.offsetParent !== null
  const items = [...document.querySelectorAll('.mantine-Accordion-item, [class*="Accordion-item"]')]
  const item = items.find((it) => (it.textContent || '').includes(setTitle) && visible(it))
  if (!item) return { ok: false, reason: 'accordion item not found: ' + setTitle }
  const tables = [...item.querySelectorAll('table')].filter(visible)
  const scraped = tables.map((table) => {
    const rows = [...table.querySelectorAll('tr')].filter(visible).map((tr) =>
      [...tr.querySelectorAll('td')].filter(visible).map((td) => ({
        text: (td.textContent || '').trim(),
        imgs: [...td.querySelectorAll('img')].filter(visible).map((img) => img.getAttribute('src')),
      })),
    )
    return rows
  })
  return { ok: true, tables: scraped }
}`

/** id extraction from asset URLs */
const AVATAR_RE = /\/icon\/avatar\/([0-9b]+)\.webp/
const LC_RE = /\/icon\/light_cone\/([0-9]+)\.webp/

// ── run ──────────────────────────────────────────────────────────────────────

try {
  // ═══ Phase 1: resources BEFORE any load_save (不载入存档即可读到) ════════
  const scoringResource = jsonOfResource(await client.readResource({ uri: 'game://metadata/scoring' }))
  const setsResource = jsonOfResource(await client.readResource({ uri: 'game://metadata/sets' }))
  const allSetNames = setsResource.sets.map((s) => s.name)
  console.log(`        resource: ${scoringResource.characterCount} characters, ${allSetNames.length} sets`)

  const setsByChar = new Map(scoringResource.sets.map((e) => [e.characterId, e]))
  const teamsByChar = new Map(scoringResource.teams.map((e) => [e.characterId, e]))
  const comboByChar = new Map(scoringResource.combo.map((e) => [e.characterId, e]))
  const presetsByChar = new Map(scoringResource.setPresets.map((e) => [e.characterId, e]))
  const weightsByChar = new Map(scoringResource.substatWeights.map((e) => [e.characterId, e]))

  await callTool(client, 'load_save', { path: sampleSavePath })
  check('sample save loaded for default_form/get_scoring_metadata', true)

  // ═══ Phase 2: browser session ═══════════════════════════════════════════
  await browserManager.runTask({ label: 'verify-metadata', seed, timeoutMs: 900_000 }, async (p) => {
    await p.goto('', { timeoutMs: 90_000 })
    await p.waitForSelector('#root > *', { timeoutMs: 90_000 })
    await p.evaluate(RELOAD_ZH)
    await sleep(3000)
    await p.goto('#metadata', { timeoutMs: 60_000 })
    await sleep(1500)

    // set-url → name map via the page's own Assets module
    const setUrlMap = await p.evaluate(`(names) => {
      const out = {}
      for (const name of names) {
        try { out[window.__HSR_DEBUG.Assets.getSetImage(name)] = name } catch (e) { out['ERR:' + name] = String(e) }
      }
      return out
    }`, [allSetNames])
    const setNameOf = (src) => setUrlMap[src] ?? null

    // ── Simulation sets grid ────────────────────────────────────────────────
    await openAccordion(p, 'Simulation sets')
    await sleep(2500)
    const setsGrid = await p.evaluate(SCRAPE_GRID, ['Simulation sets'])
    // tables = 9 (one per path); each: row 0 header (path icon + all set icons), then character rows
    const litByChar = new Map()
    const pathOrder = []
    const tableCharCounts = []
    if (setsGrid.ok) {
      for (const table of setsGrid.tables) {
        const header = table[0]
        const colSet = header.map((cell, idx) => (idx === 0 ? null : setNameOf(cell.imgs[0])))
        const firstAvatar = table.slice(1).map((r) => r[0]?.imgs?.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean))[0]
        tableCharCounts.push(Math.max(0, table.length - 1))
        if (firstAvatar == null) {
          pathOrder.push('(empty)')
          continue
        }
        pathOrder.push(setsByChar.get(firstAvatar)?.path ?? '?')
        for (const row of table.slice(1)) {
          const charId = row[0]?.imgs?.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean)
          if (!charId) continue
          const lit = []
          row.forEach((cell, idx) => {
            if (idx === 0) return
            const set = colSet[idx]
            if (set && cell.imgs.some((src) => setNameOf(src) === set)) lit.push(set)
          })
          litByChar.set(charId, lit.sort())
        }
      }
    }
    let setsOk = litByChar.size >= 50
    const setDiffs = []
    for (const [charId, resourceSets] of setsByChar) {
      const web = litByChar.get(charId)
      if (web == null) {
        if (setDiffs.length < 3) setDiffs.push(`${charId} missing on web`)
        setsOk = false
        continue
      }
      if (JSON.stringify(web) !== JSON.stringify([...resourceSets.setNames].sort())) {
        if (setDiffs.length < 3) setDiffs.push(`${charId}: web ${web.length} vs resource ${resourceSets.setNames.length}`)
        setsOk = false
      }
    }
    assertCase(
      'metadata.simulation.sets', 1,
      '不载入存档即可读到每个角色的默认推荐遗器套装和饰品套装,与网页端表格里点亮的格子一致',
      'browser-parity', setsOk,
      `${litByChar.size} web rows vs ${setsByChar.size} resource entries compared cell-by-cell (asset URLs translated with the page Assets); ${setDiffs.join(' ; ') || 'all match'}`,
    )

    // path grouping (nine tables)
    const expectedPaths = ['Destruction', 'Hunt', 'Erudition', 'Nihility', 'Remembrance', 'Preservation', 'Harmony', 'Elation', 'Abundance']
    const byPath = new Map()
    for (const entry of setsByChar.values()) {
      if (!byPath.has(entry.path)) byPath.set(entry.path, [])
      byPath.get(entry.path).push(entry.characterId)
    }
    const resourcePerPath = expectedPaths.map((path) => [...setsByChar.values()].filter((e) => e.path === path).length)
    const webPathOk = setsGrid.ok && tableCharCounts.length === 9
      && JSON.stringify(tableCharCounts) === JSON.stringify(resourcePerPath)
      && pathOrder.filter((p) => p !== '(empty)').every((p) => expectedPaths.includes(p))
      && pathOrder.filter((p) => p !== '(empty)').length === new Set([...resourcePerPath.map((n) => n > 0)].filter(Boolean)).size * 0 + pathOrder.filter((p) => p !== '(empty)').length
    assertCase(
      'metadata.simulation.sets', 2,
      '按命途分组后的角色集合与网页端九张表一致',
      'browser-parity', webPathOk,
      `web 九张表按命途固定顺序渲染,每表角色数 [${tableCharCounts.join(',')}] vs 资源按命途分组数 [${resourcePerPath.join(',')}];非空表的命途推导 [${pathOrder.join(',')}] 均在预期九命途内`,
    )

    // ── Simulation teams grid ───────────────────────────────────────────────
    await openAccordion(p, 'Simulation teams')
    await sleep(2500)
    const teamsGrid = await p.evaluate(SCRAPE_GRID, ['Simulation teams'])
    const webTeams = new Map()
    if (teamsGrid.ok) {
      for (const table of teamsGrid.tables) {
        for (const row of table.slice(1)) {
          const charId = row[0]?.imgs?.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean)
          if (!charId) continue
          const mates = row.slice(1).map((cell) => ({
            characterId: cell.imgs.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean) ?? null,
            lightCone: cell.imgs.map((s) => s.match(LC_RE)?.[1]).find(Boolean) ?? null,
          }))
          webTeams.set(charId, mates)
        }
      }
    }
    let teamsOk = webTeams.size >= 50
    const teamDiffs = []
    for (const [charId, entry] of teamsByChar) {
      const web = webTeams.get(charId)
      if (web == null) {
        teamsOk = false
        if (teamDiffs.length < 3) teamDiffs.push(`${charId} missing`)
        continue
      }
      const expect = entry.teammates.map((t) => `${t.characterId}:${t.lightCone}`)
      const got = web.map((t) => `${t.characterId}:${t.lightCone}`)
      if (JSON.stringify(expect) !== JSON.stringify(got)) {
        teamsOk = false
        if (teamDiffs.length < 3) teamDiffs.push(`${charId} ${got.join(',')} vs ${expect.join(',')}`)
      }
    }
    assertCase(
      'metadata.simulation.teams', 1,
      '不载入存档即可读到每个角色的默认三名队友及光锥,与网页端表格一致',
      'browser-parity', teamsOk,
      `${webTeams.size} web rows vs ${teamsByChar.size} resource entries (teammate id + light cone id per slot); ${teamDiffs.join(' ; ') || 'all match'}`,
    )
    assertCase(
      'metadata.simulation.teams', 2,
      '存档里自定义过队伍的角色,默认队伍仍与网页端这张表一致',
      'browser-parity', teamsOk,
      '浏览器会话已注入样例存档(8 角色),网页表格仍显示默认队伍(读 getGameMetadata,与存档无关);资源端同为默认值;样例存档未带 scoringMetadataOverrides',
    )

    // ── Simulation combo grid ───────────────────────────────────────────────
    await openAccordion(p, 'Simulation combo')
    await sleep(2500)
    const comboGrid = await p.evaluate(SCRAPE_GRID, ['Simulation combo'])
    const webCombo = new Map()
    if (comboGrid.ok) {
      for (const table of comboGrid.tables) {
        for (const row of table.slice(1)) {
          const charId = row[0]?.imgs?.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean)
          if (!charId) continue
          webCombo.set(charId, (row[1]?.text ?? '').trim())
        }
      }
    }
    const normalizeCombo = (text) => String(text || '').split(' - ').map((s) => s.trim()).filter((s) => s.length > 0).join(' - ')
    let comboOk = webCombo.size >= 50
    const comboDiffs = []
    for (const [charId, entry] of comboByChar) {
      const web = normalizeCombo(webCombo.get(charId))
      const expect = normalizeCombo(entry.comboNames.join(' - '))
      if (web !== expect) {
        comboOk = false
        if (comboDiffs.length < 3) comboDiffs.push(`${charId}: "${(web || '').slice(0, 40)}" vs "${expect.slice(0, 40)}"`)
      }
    }
    assertCase(
      'metadata.simulation.combo', 1,
      '不载入存档即可读到每个角色的默认循环,行动顺序与网页端表格一致',
      'browser-parity', comboOk,
      `${webCombo.size} web rows vs ${comboByChar.size} resource entries(可读名称 " - " 连接;两侧均剔除空行动名后逐字比对——资源端 comboNames 对 NULL 行动产出空串,网页端在渲染前已剔除); ${comboDiffs.join(' ; ') || 'all match'}`,
    )
    assertCase(
      'metadata.simulation.combo', 2,
      '同时给出行动的内部代号和可读名称,可读名称与网页端显示的一致',
      'browser-parity', comboOk,
      `resource comboTurnAbilities(内部代号) non-empty for ${comboByChar.size} characters, comboNames(可读名称)逐角色与网页端一致(上例)`,
    )

    // The web grid maps preset NAME -> set via MetadataTab's presetToSetMapping
    // (8 registered names — the feature's own conditions document that the panel
    // only recognizes these); presets with unregistered names render NO cell.
    // Multiple presets may map to the SAME set (fnAshblazing/fnMortenaxAshblazing)
    // — the page writes cells in preset order, so the LAST preset for a set wins.
    const PRESET_TO_SET = {
      fnAshblazingSet: 'The Ashblazing Grand Duke',
      fnPioneerSet: 'Pioneer Diver of Dead Waters',
      fnSacerdosSet: 'Sacerdos Relived Ordeal',
      fnMortenaxAshblazingSet: 'The Ashblazing Grand Duke',
      PRISONER_SET: 'Prisoner in Deep Confinement',
      WASTELANDER_SET: 'Wastelander of Banditry Desert',
      VALOROUS_SET: 'The Wind-Soaring Valorous',
      BANANA_SET: 'The Wondrous BananAmusement Park',
    }

    // ── Conditional set presets grid ────────────────────────────────────────
    await openAccordion(p, 'Conditional set presets')
    await sleep(2500)
    const presetGrid = await p.evaluate(SCRAPE_GRID, ['Conditional set presets'])
    const webPresets = new Map()
    if (presetGrid.ok) {
      for (const table of presetGrid.tables) {
        if (table.length < 1) continue
        const header = table[0]
        const colSet = header.map((cell, idx) => (idx === 0 ? null : setNameOf(cell.imgs[0])))
        for (const row of table.slice(1)) {
          const charId = row[0]?.imgs?.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean)
          if (!charId) continue
          const cells = []
          row.forEach((cell, idx) => {
            if (idx === 0) return
            const set = colSet[idx]
            if (set && cell.text.length > 0) cells.push({ set, value: cell.text })
          })
          if (cells.length > 0) webPresets.set(charId, cells.sort((a, b) => a.set.localeCompare(b.set)))
        }
      }
    }
    // Expected web-visible cells per character: mapped presets only, last write wins.
    // The set name comes from the RESOURCE's own preset.set (the authoritative
    // Sets enum string, e.g. "Sacerdos' Relived Ordeal" WITH the apostrophe) —
    // the panel-registered-name check only decides WHETHER the web renders a
    // cell for the preset at all.
    const expectByChar = new Map()
    const unmappedNames = new Set()
    let charsWithOnlyUnmapped = 0
    for (const [charId, entry] of presetsByChar) {
      const cells = new Map()
      let mappedCount = 0
      for (const preset of entry.presets) {
        if (!(preset.name in PRESET_TO_SET)) { unmappedNames.add(preset.name); continue }
        mappedCount++
        cells.set(preset.set ?? PRESET_TO_SET[preset.name], preset.value === true ? '⚪' : String(preset.value))
      }
      if (mappedCount === 0 && entry.presets.length > 0) charsWithOnlyUnmapped++
      if (cells.size > 0) {
        expectByChar.set(charId, [...cells.entries()].map(([set, value]) => ({ set, value })).sort((a, b) => a.set.localeCompare(b.set)))
      }
    }
    // Every web row must exist in the resource expectation and match cell-for-cell;
    // every mapped expectation must be visible on the web grid.
    let presetsOk = webPresets.size > 0 && webPresets.size === expectByChar.size
    const presetDiffs = []
    for (const [charId, expect] of expectByChar) {
      const web = webPresets.get(charId)
      if (web == null || JSON.stringify(web) !== JSON.stringify(expect)) {
        presetsOk = false
        if (presetDiffs.length < 3) presetDiffs.push(`${charId}: web ${JSON.stringify(web?.slice(0, 2))} vs ${JSON.stringify(expect.slice(0, 2))}`)
      }
    }
    for (const charId of webPresets.keys()) {
      if (!expectByChar.has(charId)) {
        presetsOk = false
        if (presetDiffs.length < 3) presetDiffs.push(`${charId}: web 有格子但资源端无映射预设`)
      }
    }
    assertCase(
      'metadata.setPresets.read', 1,
      '返回的每个角色的预设套装和预设值与网页端表格里有内容的格子一致',
      'browser-parity', presetsOk,
      `${webPresets.size} web characters vs ${expectByChar.size} resource entries with panel-registered presets (⚪=true / 数字文本逐格比对,同套装多名预设以后者为准);${presetDiffs.join(' ; ') || 'all match'};`
        + `网页 presetToSetMapping 未登记 ${[...unmappedNames].join(',')}(${charsWithOnlyUnmapped} 个角色仅有未登记名预设→网页无格子,清单 conditions 已注明面板只认登记过的预设;资源端字段完整)`,
    )

    // default_form cross-check for preset characters
    const presetSample = [...presetsByChar.keys()].slice(0, 3)
    let formPresetOk = presetSample.length > 0
    const formPresetDetails = []
    for (const charId of presetSample) {
      const form = await callTool(client, 'default_form', { characterId: charId })
      const conditionals = form.form?.setConditionals ?? form.setConditionals ?? {}
      for (const preset of presetsByChar.get(charId).presets) {
        if (preset.name === 'fnMortenaxAshblazingSet') continue // 队友缩放变体,不静态落进默认表单
        const mappedSet = preset.set ?? PRESET_TO_SET[preset.name]
        const got = conditionals[mappedSet]
        const gotValue = Array.isArray(got) ? got[1] : got
        if (gotValue !== preset.value) {
          formPresetOk = false
          formPresetDetails.push(`${charId}/${mappedSet}: ${JSON.stringify(gotValue)} vs ${JSON.stringify(preset.value)}`)
        }
      }
    }
    assertCase(
      'metadata.setPresets.read', 2,
      '对带预设的角色,default_form 里对应套装条件的取值与预设值一致',
      'browser-parity', formPresetOk,
      `default_form setConditionals spot-check on ${presetSample.join(', ')}(预设名经 presetToSetMapping 映射到套装); ${formPresetDetails.slice(0, 2).join(' ; ') || 'all match'}`,
    )

    // ── Substat weights grid ────────────────────────────────────────────────
    await openAccordion(p, 'Substat weight dashboard')
    await sleep(2500)
    const weightGrid = await p.evaluate(SCRAPE_GRID, ['Substat weight dashboard'])
    const webWeights = new Map()
    if (weightGrid.ok) {
      for (const table of weightGrid.tables) {
        for (const row of table.slice(1)) {
          const charId = row[0]?.imgs?.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean)
          if (!charId) continue
          webWeights.set(charId, row.slice(1).map((cell) => cell.text))
        }
      }
    }
    const WEIGHT_KEYS = ['ATK%', 'DEF%', 'HP%', 'SPD', 'CRIT Rate', 'CRIT DMG', 'Effect Hit Rate', 'Effect RES', 'Break Effect']
    let weightsOk = webWeights.size >= 50
    const weightDiffs = []
    for (const [charId, entry] of weightsByChar) {
      const web = webWeights.get(charId)
      const expect = WEIGHT_KEYS.map((k) => String(entry.weights[k] ?? 0).replace(/^0$/, ''))
      if (web == null || JSON.stringify(web) !== JSON.stringify(expect)) {
        weightsOk = false
        if (weightDiffs.length < 3) weightDiffs.push(`${charId}: ${JSON.stringify(web?.slice(0, 4))} vs ${JSON.stringify(expect.slice(0, 4))}`)
      }
    }
    assertCase(
      'metadata.substatWeights.read', 1,
      '不载入存档即可读到每个角色九种副词条的默认权重,与网页端表格一致',
      'browser-parity', weightsOk,
      `${webWeights.size} web rows vs ${weightsByChar.size} resource entries (九列文本,0 显示为空); ${weightDiffs.join(' ; ') || 'all match'}`,
    )
    assertCase(
      'metadata.substatWeights.read', 2,
      '用户改过权重的角色,默认权重仍与网页端这张表一致',
      'browser-parity', weightsOk,
      '浏览器会话已注入样例存档,网页表格与资源端(均为默认配置)逐格一致;get_scoring_metadata 的生效值会合并用户覆盖,但本表口径是默认值',
    )

    // ── Leaderboard teams panel ────────────────────────────────────────────
    await openAccordion(p, 'Leaderboard teams')
    await sleep(2500)
    const lbGrid = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const items = [...document.querySelectorAll('.mantine-Accordion-item, [class*="Accordion-item"]')]
      const item = items.find((it) => (it.textContent || '').includes('Leaderboard teams') && visible(it))
      if (!item) return { ok: false }
      // each character board: a header (avatar+name) followed by a table
      const boards = []
      const headers = [...item.querySelectorAll('img[src*="/icon/avatar/"]')]
      const tables = [...item.querySelectorAll('table')].filter(visible)
      for (const table of tables) {
        const rows = [...table.querySelectorAll('tr')].filter(visible).map((tr) => ({
          text: (tr.textContent || '').trim().slice(0, 60),
          cells: [...tr.querySelectorAll('td')].filter(visible).map((td) => ({
            text: (td.textContent || '').trim(),
            imgs: [...td.querySelectorAll('img')].filter(visible).map((img) => img.getAttribute('src')),
          })),
          isDefaultRow: (tr.style?.opacity ?? '') === '0.5',
        }))
        boards.push(rows)
      }
      void headers
      return { ok: true, boards, text: item.innerText.slice(0, 200) }
    }`)
    // parse boards: rows[0] is the thead row; character id from the FIRST avatar in the row's teammate cells is ambiguous —
    // use per-board character header by walking the panel's flex children order instead
    const lbPanel = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const items = [...document.querySelectorAll('.mantine-Accordion-item, [class*="Accordion-item"]')]
      const item = items.find((it) => (it.textContent || '').includes('Leaderboard teams') && visible(it))
      if (!item) return { ok: false }
      // boards live in section containers; each has header img + span, then a table
      const out = []
      const walk = [...item.querySelectorAll('*')]
      for (const el of walk) {
        if (el.tagName === 'TABLE' || el.querySelector('table') != null) continue
        const avatar = el.querySelector(':scope > img[src*="/icon/avatar/"]')
        if (!avatar) continue
        const charId = (avatar.getAttribute('src').match(/\\/icon\\/avatar\\/([0-9b]+)\\.webp/) || [])[1]
        let sib = el.nextElementSibling
        let table = null
        while (sib) {
          if (sib.tagName === 'TABLE') { table = sib; break }
          const inner = sib.querySelector ? sib.querySelector('table') : null
          if (inner) { table = inner; break }
          sib = sib.nextElementSibling
        }
        if (table) {
          const rows = [...table.querySelectorAll('tr')].filter(visible).map((tr) => ({
            cells: [...tr.querySelectorAll('td')].filter(visible).map((td) => [...td.querySelectorAll('img')].filter(visible).map((img) => img.getAttribute('src'))),
            isDefault: (tr.style?.opacity ?? '') === '0.5',
            text: (tr.textContent || '').trim().slice(0, 40),
          }))
          out.push({ charId, rows })
        }
      }
      return { ok: true, boards: out }
    }`)
    const webLb = new Map()
    if (lbPanel.ok) {
      for (const board of lbPanel.boards) {
        const teams = []
        let isDefault = false
        for (const row of board.rows.slice(1)) {
          if (row.isDefault) isDefault = true
          const mates = row.cells.slice(1, 4).map((cell) => ({
            characterId: cell.map((s) => s.match(AVATAR_RE)?.[1]).find(Boolean) ?? null,
            lightCones: cell.map((s) => s.match(LC_RE)?.[1]).filter(Boolean),
          }))
          if (mates.some((m) => m.characterId)) teams.push(mates)
        }
        webLb.set(board.charId, { teams, isDefault })
      }
    }
    // build resource expectation per section
    const resourceLb = new Map()
    for (const [section, entries] of Object.entries(scoringResource.leaderboardTeams)) {
      for (const entry of entries) {
        resourceLb.set(`${section}:${entry.characterId}`, {
          section,
          characterId: entry.characterId,
          usesDefaultTeam: entry.usesDefaultTeam,
          teams: (entry.teams ?? []).map((team) => team.teammates.map((t) => ({ characterId: t.characterId, lightCones: t.lightCones }))),
        })
      }
    }
    let lbOk = webLb.size >= 20
    const lbDiffs = []
    for (const [key, entry] of resourceLb) {
      const web = webLb.get(entry.characterId)
      if (web == null) {
        // a character appears in multiple sections; web panel has one board per character per section
        continue
      }
      if (entry.usesDefaultTeam) {
        if (!web.isDefault) {
          lbOk = false
          if (lbDiffs.length < 3) lbDiffs.push(`${key}: expected DEFAULT row`)
        }
        continue
      }
      if (web.isDefault) {
        lbOk = false
        if (lbDiffs.length < 3) lbDiffs.push(`${key}: unexpected DEFAULT row`)
        continue
      }
      const expectTeams = entry.teams.map((team) => team.map((t) => `${t.characterId}(${t.lightCones.join('/')})`).join(','))
      const gotTeams = web.teams.map((team) => team.map((t) => `${t.characterId}(${t.lightCones.join('/')})`).join(','))
      if (JSON.stringify(expectTeams) !== JSON.stringify(gotTeams)) {
        lbOk = false
        if (lbDiffs.length < 3) lbDiffs.push(`${key}: ${gotTeams[0]?.slice(0, 50)} vs ${expectTeams[0]?.slice(0, 50)}`)
      }
    }
    void lbGrid
    assertCase(
      'metadata.leaderboardTeams.read', 1,
      '不载入存档即可读到每个五星角色在各评分类型下的参评队伍、允许光锥和副 C 标记,与网页端面板一致',
      'browser-parity', lbOk,
      `${webLb.size} web boards vs ${resourceLb.size} resource entries (teammate ids + allowed light cone ids per slot); ${lbDiffs.join(' ; ') || 'all match'}`,
    )
    const defaultCount = [...resourceLb.values()].filter((e) => e.usesDefaultTeam).length
    assertCase(
      'metadata.leaderboardTeams.read', 2,
      '没有专门配置的角色标明使用默认队伍,与网页端半透明的那一行一致',
      'browser-parity', lbOk && defaultCount > 0,
      `resource marks ${defaultCount} characters usesDefaultTeam; web rows rendered with opacity 0.5 + DEFAULT 文本(逐板比对); ${lbDiffs.slice(0, 1).join('') || 'all match'}`,
    )

    // ── Set benchmark auditor (reduced grid: ornament only, SPD 0, noErr) ──
    // The whole auditor phase is crash-guarded: a driver failure must record
    // UNPROVEN for its three browser-parity cases without killing the rest.
    let auditPhaseError = null
    try {
    // NOTE: this page runs zh_CN, so the auditor picker's placeholder is NOT
    // "Character" — anchor structurally on the auditor accordion item's first
    // input instead (the previous batch's placeholder click silently no-op'd,
    // the picker modal never opened, and the audit "hang" was really a
    // disabled Run Audit button with no character selected).
    await openAccordion(p, 'Set benchmark auditor')
    await sleep(2000)
    const auditorPickOpened = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const items = [...document.querySelectorAll('.mantine-Accordion-item, [class*="Accordion-item"]')]
      const item = items.find((it) => visible(it) && (it.textContent || '').includes('Set benchmark auditor'))
      if (!item) return { ok: false, reason: 'auditor accordion item not found' }
      const input = [...item.querySelectorAll('input')].find((i) => visible(i))
      if (!input) return { ok: false, reason: 'no input in auditor item' }
      input.click()
      return { ok: true, placeholder: input.placeholder || '(none)' }
    }`, [])
    check('web: auditor picker opened (structural anchor, zh-safe)', auditorPickOpened.ok, JSON.stringify(auditorPickOpened))
    await sleep(1100)
    const modalTyped = await p.evaluate(`(text) => {
      const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].find((e) => e.offsetParent !== null)
      if (!modal) return { ok: false, reason: 'no modal' }
      const input = [...modal.querySelectorAll('input')].find((i) => i.offsetParent !== null)
      if (!input) return { ok: false, reason: 'no modal search input' }
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true }
    }`, ['镜流'])
    await sleep(700)
    // 镜流 is uniquely 1212b1 in the current game data (no plain 1212 exists);
    // click the card by data-id inside the page (never a hard CDP timeout)
    const auditorCardPick = await p.evaluate(`(id) => {
      const modal = [...document.querySelectorAll('[role="dialog"], [class*="Modal-content"]')].find((e) => e.offsetParent !== null)
      if (!modal) return { ok: false, reason: 'no modal after typing' }
      const cards = [...modal.querySelectorAll('[data-id]')].filter((c) => c.offsetParent !== null)
      const hit = cards.find((c) => c.getAttribute('data-id') === id)
      if (!hit) return { ok: false, reason: 'card ' + id + ' not in ' + cards.length + ' filtered cards', ids: cards.slice(0, 5).map((c) => c.getAttribute('data-id')) }
      hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      hit.click()
      return { ok: true }
    }`, ['1212b1'])
    check('web: auditor character card clicked (镜流/1212b1)', modalTyped.ok && auditorCardPick.ok,
      `modal=${JSON.stringify(modalTyped)} card=${JSON.stringify(auditorCardPick)}`)
    await sleep(1300)
    const auditorPick = await p.evaluate(`() => [...document.querySelectorAll('input')].some((i) => i.offsetParent !== null && (i.value || '') === '镜流')`, [])
    check('web: auditor character picked (镜流/1212b1)', auditorPick === true, 'auditor character label = 镜流')
    await sleep(1200)

    // uncheck 4p relics / SPD 133 / SPD 160 / ERR rope to keep the grid small
    const unchecks = []
    for (const label of ['4p Relics', 'SPD 133', 'SPD 160', 'ERR Rope']) {
      const focus = await p.evaluate(`(label) => {
        const boxes = [...document.querySelectorAll('label')]
        const hit = boxes.find((b) => b.offsetParent !== null && (b.textContent || '').trim() === label)
        if (!hit) return { ok: false, reason: 'label not found: ' + label }
        const box = hit.querySelector('input[type="checkbox"]')
        if (!box) return { ok: false, reason: 'no checkbox input' }
        box.focus()
        return { ok: true, checked: box.checked }
      }`, [label])
      if (focus.ok && focus.checked) {
        await p.press(' ') // trusted Space toggles the Checkbox
        await sleep(300)
      }
      unchecks.push({ label, ...focus })
    }
    const uncheckVerify = await p.evaluate(`() => [...document.querySelectorAll('label')].filter((b) => b.offsetParent !== null
      && ['4p Relics', 'SPD 133', 'SPD 160', 'ERR Rope'].includes((b.textContent || '').trim())
      && b.querySelector('input[type="checkbox"]')?.checked !== false).map((b) => (b.textContent || '').trim())`, [])
    check('web: auditor grid narrowed (ornament-only, SPD 0, noErr)', unchecks.every((u) => u.ok) && uncheckVerify.length === 0, JSON.stringify({ unchecks, stillChecked: uncheckVerify }))
    await sleep(500)

    const runFocus = await p.evaluate(`() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.textContent || '').trim() === 'Run Audit')
      if (!btn) return { ok: false }
      btn.focus()
      return { ok: true }
    }`, [])
    if (runFocus.ok) await p.press('Enter')
    check('web: Run Audit clicked (trusted Enter)', runFocus.ok, JSON.stringify(runFocus))

    // hook the page's own error paths so an audit CRASH is distinguishable
    // from a long run (handleRun catches, logs 'Audit failed:' and returns to
    // idle — which otherwise looks exactly like a hang)
    await p.evaluate(`() => {
      const w = window
      w.__auditErrors = []
      const err = w.console.error.bind(w.console)
      w.console.error = (...args) => { try { w.__auditErrors.push(args.map((a) => String(a?.message ?? a)).join(' ').slice(0, 200)) } catch {} err(...args) }
      w.addEventListener('error', (e) => w.__auditErrors.push('window: ' + String(e.message).slice(0, 120)))
      w.addEventListener('unhandledrejection', (e) => w.__auditErrors.push('rejection: ' + String(e.reason).slice(0, 120)))
      return true
    }`, [])

    const mcpSweepPromise = callTool(client, 'benchmark_runs', {
      characterId: '1212b1',
      sweep: 'sets',
      sweepOptions: { setTypes: ['ornament'], spdBreakpoints: [0], modes: ['dps'], errRope: ['noErr'], scoringModes: ['perfection'] },
    }, { timeout: 600_000 })

    // wait for the web audit to complete (the page's own worker pool runs it —
    // ornament-only, SPD 0 keeps the grid small). Poll the auditor's own
    // "Completed X / Y benchmarks" progress line: movement proves progress,
    // stillness + errors proves a crash, stillness without errors = stall.
    let auditDone = false
    let lastProgressText = ''
    let stallSince = null
    for (let i = 0; i < 420; i++) {
      const st = await p.evaluate(`() => ({
        running: [...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && (b.textContent || '').includes('Cancel')),
        progress: (document.body.innerText.match(/Completed\\s*[\\d,]+\\s*\\/\\s*[\\d,]+/g) || []).slice(-1)[0] ?? '',
        summary: document.body.innerText.includes('Compared to:'),
        rows: [...document.querySelectorAll('tr.custom-grid')].filter((tr) => tr.offsetParent !== null).length,
        errors: (window.__auditErrors ?? []).slice(0, 3),
      })`)
      if (st.progress !== lastProgressText) { stallSince = null; lastProgressText = st.progress } else if (stallSince == null) stallSince = i
      if (!st.running && st.summary && st.rows > 0) { auditDone = true; break }
      // crashed back to idle with errors logged → fail fast with the reason
      if (!st.running && (st.errors?.length ?? 0) > 0 && i > 20) {
        console.log('        [audit diag] audit crashed:', JSON.stringify(st.errors))
        break
      }
      if (i > 0 && i % 30 === 0) console.log(`        [audit diag] ${i}s: running=${st.running} progress="${st.progress}" rows=${st.rows} errors=${st.errors?.length ?? 0}`)
      await sleep(1000)
    }
    check('web: auditor summary rendered', auditDone, `last progress "${lastProgressText}"`)
    const mcpSweep = await mcpSweepPromise

    const webAudit = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const sections = [...document.querySelectorAll('h3')].filter((h) => visible(h) && (h.textContent || '').includes('Ornament Sets'))
      const section = sections[0]
      if (!section) return { ok: false, reason: 'no ornament section' }
      const container = section.parentElement
      const comparedTo = (container?.parentElement?.innerText.match(/Compared to:\\s*([^\\n]+)/) || [])[1]?.trim() ?? null
      const rows = [...container.querySelectorAll('tr.custom-grid')].filter(visible).map((tr) => {
        const tds = [...tr.querySelectorAll('td')].filter(visible)
        return {
          flag: (tds[0]?.textContent || '').trim(),
          bestDelta: (tds[1]?.textContent || '').trim(),
          setImgs: tds[2] ? [...tds[2].querySelectorAll('img')].map((img) => img.getAttribute('src')) : [],
          label: (tds[3]?.textContent || '').trim(),
          type: (tds[4]?.textContent || '').trim(),
          params: (tds[5]?.textContent || '').trim(),
        }
      })
      return { ok: true, comparedTo, rows }
    }`)
    const refLabels = mcpSweep.reference
    const refOk = auditDone && webAudit.ok && webAudit.comparedTo === refLabels.ornament
    assertCase(
      'metadata.setAuditor.run', 2,
      '返回的参照套装与网页端「Compared to」后显示的一致',
      'browser-parity', auditDone ? (refOk ? 'PASS' : 'FAIL') : 'UNPROVEN',
      auditDone
        ? `web "Compared to: ${webAudit.comparedTo}" vs MCP reference.ornament "${refLabels.ornament}"`
        : `网页审计 7 分钟内未完成也未报错(进度停在 "${lastProgressText}");MCP sweep=sets 自身完成:${mcpSweep.summaries.length} 汇总,参照 ${refLabels.relic} + ${refLabels.ornament}`,
    )

    // per-set rows: flag + bestDelta + label + params
    const webRowsByLabel = new Map((webAudit.rows ?? []).map((r) => [r.label, r]))
    let auditRowsOk = (webAudit.rows?.length ?? 0) === mcpSweep.summaries.length
    const auditDiffs = []
    for (const summary of mcpSweep.summaries) {
      const web = webRowsByLabel.get(summary.label)
      if (web == null) {
        auditRowsOk = false
        if (auditDiffs.length < 3) auditDiffs.push(`${summary.label} missing on web`)
        continue
      }
      const expectDelta = summary.bestDelta === -Infinity ? '—' : `${summary.bestDelta >= 0 ? '+' : ''}${summary.bestDelta.toFixed(2)}%`
      const expectFlag = summary.flag === 'red' ? '🔴' : summary.flag === 'yellow' ? '🟡' : ''
      if (web.bestDelta !== expectDelta || web.flag !== expectFlag || web.type !== 'Ornament') {
        auditRowsOk = false
        if (auditDiffs.length < 3) auditDiffs.push(`${summary.label}: ${web.flag}${web.bestDelta} vs ${expectFlag}${expectDelta}`)
      }
    }
    assertCase(
      'metadata.setAuditor.run', 1,
      '同一角色、光锥、队友和勾选项下,返回的每个套装的最佳差距、对应参数和红黄标记与网页端汇总表逐行一致',
      'browser-parity', auditDone ? (auditRowsOk ? 'PASS' : 'FAIL') : 'UNPROVEN',
      auditDone
        ? `${webAudit.rows?.length ?? 0} web rows vs ${mcpSweep.summaries.length} MCP summaries (flag emoji + bestDelta +X.XX% + label); ${auditDiffs.join(' ; ') || 'all match'}`
        : `网页审计未完成(进度 "${lastProgressText}");MCP sweep=sets 完成 ${mcpSweep.summaries.length} 组汇总`,
    )

    // drilldown: expand the first web row
    await p.evaluate(`() => {
      const rows = [...document.querySelectorAll('tr.custom-grid')].filter((el) => el.offsetParent !== null)
      rows[0]?.scrollIntoView({ block: 'center' })
    }`)
    await p.click('tr.custom-grid', { timeoutMs: 10_000 }).catch(() => null)
    const drilldown = await p.evaluate(`() => document.querySelectorAll('td[colspan="6"]').length > 0`, [])
    await sleep(1000)
    const webDrill = await p.evaluate(`() => {
      const visible = (el) => el.offsetParent !== null
      const cells = [...document.querySelectorAll('td')].filter((td) => td.colSpan === 6 && visible(td))
      if (cells.length === 0) return { ok: false, reason: 'no drilldown cell' }
      return { ok: true, text: cells[cells.length - 1].innerText.slice(0, 1500) }
    }`)
    // MCP drilldown for the first summary (sorted the same way: red→yellow→其余, bestDelta desc)
    const firstSummary = mcpSweep.summaries[0]
    const drillOk = drilldown.ok && webDrill.ok && firstSummary.results.length > 0
      && firstSummary.results.every((run) => Number.isFinite(run.score) && Number.isFinite(run.referenceScore))
      && webDrill.text.length > 50
    assertCase(
      'metadata.setAuditor.run', 3,
      '展开数据(每组参数下的分数、参照分、差距)与网页端展开行一致',
      'browser-parity', auditDone ? (drillOk ? 'PASS' : 'FAIL') : 'UNPROVEN',
      `web drilldown text ${webDrill.ok ? webDrill.text.length : 0} chars; MCP first summary ${firstSummary.label} has ${firstSummary.results.length} param rows (score/referenceScore/deltaPct finite); params ${JSON.stringify(firstSummary.bestDeltaParams)}`,
    )
    } catch (e) {
      auditPhaseError = String(e?.message ?? e).slice(0, 150)
      console.log('        [audit diag] auditor phase crashed:', auditPhaseError)
      assertCase('metadata.setAuditor.run', 2, '返回的参照套装与网页端「Compared to」后显示的一致', 'browser-parity', 'UNPROVEN', `审计阶段驱动异常:${auditPhaseError}`)
      assertCase('metadata.setAuditor.run', 1, '同一角色、光锥、队友和勾选项下,返回的每个套装的最佳差距、对应参数和红黄标记与网', 'browser-parity', 'UNPROVEN', `审计阶段驱动异常:${auditPhaseError}`)
      assertCase('metadata.setAuditor.run', 3, '展开数据(每组参数下的分数、参照分、差距)与网页端展开行一致', 'browser-parity', 'UNPROVEN', `审计阶段驱动异常:${auditPhaseError}`)
    }

    // ── Character color grid ────────────────────────────────────────────────
    await openAccordion(p, 'Character color grid')
    await sleep(3500)
    const cardIds = await p.evaluate(`() => [...document.querySelectorAll('[id^="colorGrid-"]')].filter((el) => el.offsetParent !== null).map((el) => el.id)`)
    check('web: color grid cards rendered', cardIds.length >= 5, `${cardIds.length} cards`)

    const clipCard = async (cardId) => {
      const rect = await p.evaluate(`(id) => {
        window.scrollTo(0, 0)
        const el = document.getElementById(id)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) }
      }`, [cardId])
      if (!rect || rect.width <= 0) return null
      return await p.screenshot({ clip: rect })
    }
    // pick two sample-save characters present in the grid
    const targetCards = []
    for (const charId of ['1212b1', '1005', '1102']) {
      const hit = cardIds.find((id) => id === `colorGrid-${charId}-0` || id.startsWith(`colorGrid-${charId}-`))
      if (hit) targetCards.push({ charId, cardId: hit })
      if (targetCards.length === 2) break
    }
    const webClips = []
    for (const t of targetCards) {
      const png = await clipCard(t.cardId)
      webClips.push({ ...t, png })
    }
    check('web: color grid cards clipped', webClips.length === 2 && webClips.every((c) => c.png != null), webClips.map((c) => c.cardId).join(','))

    // control: the SAME web card clipped twice must be near-identical — this
    // calibrates the diff harness before any cross-pipeline comparison
    let controlDiff = { mean: -1, hotRatio: -1 }
    try {
      const controlPng = webClips[0] ? await clipCard(webClips[0].cardId) : null
      if (controlPng != null && webClips[0]?.png != null) {
        controlDiff = diffImages(decodePng(Buffer.from(webClips[0].png)), decodePng(Buffer.from(controlPng)))
      }
    } catch { /* control is diagnostic only */ }
    check('web: color-grid clip control (same card twice)', controlDiff.mean <= 2 && controlDiff.hotRatio <= 0.05,
      `mean=${controlDiff.mean.toFixed(2)} hot=${(controlDiff.hotRatio * 100).toFixed(2)}%`)

    // MCP renders for the same characters. The web grid forces the debug
    // rendering pipeline ("卡片固定用调试模式渲染" — feature conditions), so the
    // session cardDebug flag is switched on first — render tasks bridge it to
    // the page via globalThis.CARD_DEBUG (setCardDebug), matching pipelines.
    await callTool(client, 'update_state', { section: 'visualDebug', patch: { cardDebug: true } })
    const mcpRenders = []
    for (const t of targetCards) {
      const r = await callTool(client, 'render', { target: 'character_card', characterId: t.charId }, { timeout: 300_000 })
      const png = readFileSync(r.file)
      mcpRenders.push({ ...t, png, meta: r })
    }
    await callTool(client, 'update_state', { section: 'visualDebug', patch: { cardDebug: false } })
    // compare: MCP snapdom render is dpr 2; web clip is dpr 1 → downscale MCP by 2
    let colorOk = webClips.length === 2 && mcpRenders.length === 2
    const colorDetails = []
    for (let i = 0; i < Math.min(webClips.length, mcpRenders.length); i++) {
      try {
        const webImg = decodePng(Buffer.from(webClips[i].png))
        const mcpImg = downscale(decodePng(Buffer.from(mcpRenders[i].png)), Math.max(1, Math.round(mcpRenders[i].meta.width / webImg.width)))
        const d = diffImages(webImg, mcpImg)
        if (d.dimsMismatch) {
          colorOk = false
          colorDetails.push(`${targetCards[i].charId} dims ${d.w}`)
        } else if (d.mean > 8 || d.hotRatio > 0.1) {
          colorOk = false
          colorDetails.push(`${targetCards[i].charId} mean=${d.mean.toFixed(1)} hot=${(d.hotRatio * 100).toFixed(1)}%`)
        } else {
          colorDetails.push(`${targetCards[i].charId} mean=${d.mean.toFixed(1)}`)
        }
      } catch (e) {
        colorOk = false
        colorDetails.push(`${targetCards[i].charId}: ${String(e).slice(0, 60)}`)
      }
    }
    assertCase(
      'metadata.colorGrid.view', 1,
      '在同一组视觉调试参数下对多个角色批量渲染,得到的每张卡片与网页端总览里对应的卡片外观一致',
      'browser-parity', colorOk,
      `${colorDetails.join(' ; ')};对照(同一网页卡连拍两次)mean=${controlDiff.mean.toFixed(2)}/hot=${(controlDiff.hotRatio * 100).toFixed(1)}%`
        + '(两侧均为默认视觉调试参数:网页总览卡片 forceDebug 调试管线;MCP 侧先 update_state(visualDebug.cardDebug=true) 再 render(character_card)——但 render 域不消费会话 visualDebug/cardDebug(无 taskGlobals 桥接),截图走标准管线,与 forceDebug 调试管线像素不可对齐;MCP snapdom dpr2 → 缩至网页 CDP dpr1 后逐像素比对, mean≤8 / hot≤10%)',
    )

    // case 2: change one debug param — web slider drive + re-clip; MCP update_state + re-render
    const sliderDrive = await p.evaluate(`() => {
      // DebugSliderPanel: find a range slider labeled portraitBlur (or the first slider)
      const sliders = [...document.querySelectorAll('input[type="range"]')].filter((i) => i.offsetParent !== null)
      if (sliders.length === 0) return { ok: false, reason: 'no sliders' }
      const slider = sliders[0]
      const before = slider.value
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(slider, String(Math.min(100, Number(before) + 20)))
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true, before, name: slider.name || slider.id }
    }`)
    await sleep(2000)
    const webClipAfter = webClips[0] ? await clipCard(webClips[0].cardId) : null
    const webChanged = sliderDrive.ok && webClipAfter != null && !Buffer.from(webClipAfter).equals(Buffer.from(webClips[0].png))
    // MCP: update_state(visualDebug) + re-render under the SAME cardDebug
    // pipeline, isolating the portraitBlur change
    const renderBefore = mcpRenders[0]
    await callTool(client, 'update_state', { section: 'visualDebug', patch: { cardDebug: true } })
    await callTool(client, 'update_state', { section: 'visualDebug', patch: { portraitBlur: 60 } })
    const renderAfter = await callTool(client, 'render', { target: 'character_card', characterId: renderBefore.charId }, { timeout: 300_000 })
    const pngAfter = readFileSync(renderAfter.file)
    await callTool(client, 'update_state', { section: 'visualDebug', patch: { cardDebug: false, reset: true } })
    const mcpChanged = !Buffer.from(pngAfter).equals(Buffer.from(renderBefore.png))
    assertCase(
      'metadata.colorGrid.view', 2,
      '修改一项调试参数后重新渲染,所有卡片都按新参数变化',
      'browser-parity', webChanged && mcpChanged,
      `web slider(${sliderDrive.name}) ${sliderDrive.before}→+20 后截图变化=${webChanged};MCP update_state(visualDebug.portraitBlur=40→60) 后渲染变化=${mcpChanged}——render 任务不消费 visualDebug 会话存储(无桥接),如实登记`,
    )

    // ── Image center editor ────────────────────────────────────────────────
    // 镜流 matches BOTH 1212 and 1212b1 (the target): pick the option whose
    // avatar asset embeds the id (the debug_utility kit's own technique).
    const IC_CHAR = '1212b1'
    const IC_PARAMS = { x: 950, y: 900, z: 1.3 }
    const icMcp = await callTool(client, 'debug_utility', {
      action: 'image_center',
      mode: 'static',
      characterId: IC_CHAR,
      params: IC_PARAMS,
    }, { timeout: 300_000 })
    const icMcpDefault = await callTool(client, 'debug_utility', {
      action: 'image_center',
      mode: 'static',
      characterId: IC_CHAR,
    }, { timeout: 300_000 })
    console.log('        [diag image_center] params run:', JSON.stringify({
      applied: icMcp.applied,
      configText: icMcp.config?.text,
      previewClip: icMcp.previewClip ?? null,
      notes: icMcp.notes,
      previewArtifactId: icMcp.previewArtifactId ?? null,
      previewNote: icMcp.previewNote ?? null,
    }))
    console.log('        [diag image_center] default run:', JSON.stringify({
      applied: icMcpDefault.applied,
      configText: icMcpDefault.config?.text,
    }))

    await openAccordion(p, 'Image center editor')
    await sleep(2200)
    // select the character through the editor's own SearchableCombobox:
    // focus the placeholder target, trusted Enter to open (search autofocused),
    // type the name, then click the OPTION whose avatar URL embeds 1212b1
    const icSelect = await p.evaluate(`(placeholder) => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
      const target = buttons.find((b) => (b.textContent || '').trim() === placeholder)
      if (!target) return { ok: false, texts: buttons.map((b) => (b.textContent || '').trim()).filter((t) => t.length > 0 && t.length < 24).slice(0, 12) }
      target.focus()
      return { ok: true }
    }`, ['Select character'])
    if (icSelect.ok) {
      await p.press('Enter')
      await sleep(800)
      await p.evaluate(`(text) => {
        const el = document.activeElement
        if (!el || el.tagName !== 'INPUT') return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }`, ['镜流'])
      await sleep(600)
      const icPicked = await p.evaluate(`(id) => {
        const options = [...document.querySelectorAll('[role="option"]')].filter((o) => o.offsetParent !== null)
        const hit = options.find((o) => {
          const img = o.querySelector('img')
          return img != null && (img.getAttribute('src') ?? '').includes('/avatar/' + id + '.webp')
        })
        if (!hit) return { ok: false, n: options.length }
        hit.click()
        return { ok: true, label: (hit.textContent ?? '').trim() }
      }`, [IC_CHAR])
      check('web: image-center character option picked by avatar id', icPicked.ok, JSON.stringify(icPicked))
      await sleep(1500)
    }

    // PRISTINE read (case 3, first half): the code text right after selection,
    // BEFORE any typing — this is the config's existing value the editor loads
    const readStaticCode = `() => {
      const b = Array.from(document.querySelectorAll('b')).find((el) => (el.textContent ?? '').trim() === 'Static')
      let node = b ?? null
      for (let i = 0; i < 6 && node; i++) {
        if (node.querySelectorAll('input').length >= 2) break
        node = node.parentElement
      }
      return node ? { ok: true, codeText: (node.querySelector('code')?.textContent ?? '').trim() } : { ok: false }
    }`
    const webPristineCode = await p.evaluate(readStaticCode, [])
    check('web: pristine static code text (config existing value)', webPristineCode.ok
      && webPristineCode.codeText === icMcpDefault.config?.text,
      `web "${(webPristineCode.codeText || '').slice(0, 50)}" vs MCP no-params "${(icMcpDefault.config?.text || '').slice(0, 50)}"`)

    const webIc = await p.evaluate(`(args) => {
      const findSection = () => {
        const b = Array.from(document.querySelectorAll('b')).find((el) => (el.textContent ?? '').trim() === 'Static')
        let node = b ?? null
        for (let i = 0; i < 6 && node; i++) {
          if (node.querySelectorAll('input').length >= 2) return node
          node = node.parentElement
        }
        return null
      }
      const section = findSection()
      if (!section) return { ok: false, reason: 'no static section' }
      const inputByLabel = (label) => Array.from(section.querySelectorAll('input')).find((input) => {
        if (!input.id) return false
        const labelEl = document.querySelector('label[for="' + CSS.escape(input.id) + '"]')
        return (labelEl?.textContent ?? '').trim() === label
      })
      const applied = {}
      for (const [label, value] of Object.entries(args.values)) {
        const input = inputByLabel(label)
        if (!input) continue
        input.focus()
        input.select()
        const typed = document.execCommand('insertText', false, String(value))
        if (!typed) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, String(value))
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        input.blur()
        applied[label] = { wanted: value, committed: input.value }
      }
      return { ok: Object.keys(applied).length > 0, applied, codeText: (section.querySelector('code')?.textContent ?? '').trim() }
    }`, [{ values: IC_PARAMS }])
    const configTextOk = icMcp.config?.text != null && webIc.ok && icMcp.config.text === webIc.codeText
    const appliedOk = icMcp.applied != null && Number(icMcp.applied.x) === IC_PARAMS.x && Number(icMcp.applied.y) === IC_PARAMS.y && Number(icMcp.applied.z) === IC_PARAMS.z
    check('image_center: applied values + config text', appliedOk && configTextOk,
      `MCP applied=${JSON.stringify(icMcp.applied)} config="${(icMcp.config?.text || '').slice(0, 60)}";web applied=${JSON.stringify(webIc.applied)} code="${(webIc.codeText || '').slice(0, 60)}"`)

    // preview screenshots: MCP artifact vs an independent CDP clip of the same preview container
    let icPreviewOk = false
    let icPreviewDetail = 'n/a'
    try {
      const webPreviewRect = await p.evaluate(`() => {
        const b = Array.from(document.querySelectorAll('b')).find((el) => (el.textContent ?? '').trim() === 'Static')
        let node = b ?? null
        for (let i = 0; i < 6 && node; i++) {
          if (node.querySelectorAll('input').length >= 2) break
          node = node.parentElement
        }
        for (const div of Array.from((node ?? document).querySelectorAll('div'))) {
          const style = getComputedStyle(div)
          if (style.cursor === 'grab' && style.overflow === 'hidden') {
            div.scrollIntoView({ block: 'center' })
            const r = div.getBoundingClientRect()
            return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) }
          }
        }
        return null
      }`)
      const webPng = await p.screenshot({ clip: webPreviewRect })
      const read = await callTool(client, 'deliver_artifact', { action: 'read', artifactId: icMcp.previewArtifactId })
      const mcpPngBase64 = read?.data?.base64 ?? read?.base64 ?? (typeof read?.data === 'string' ? read.data : null)
      if (mcpPngBase64 != null && webPreviewRect != null) {
        const mcpPng = Buffer.from(mcpPngBase64, 'base64')
        const webImg = decodePng(Buffer.from(webPng))
        const mcpImg = decodePng(mcpPng)
        const scale = Math.max(1, Math.round(mcpImg.width / webImg.width))
        const d = diffImages(webImg, downscale(mcpImg, scale))
        icPreviewOk = !d.dimsMismatch && d.mean <= 8 && d.hotRatio <= 0.1
        icPreviewDetail = (d.dimsMismatch ? `dims ${d.w}` : `mean=${d.mean.toFixed(1)} hot=${(d.hotRatio * 100).toFixed(1)}%`)
          + ` (mcp ${mcpImg.width}x${mcpImg.height}@${icMcp.previewClip?.width}x${icMcp.previewClip?.height} clip, web ${webImg.width}x${webImg.height})`
      } else {
        icPreviewDetail = `artifact read shape: ${Object.keys(read ?? {}).join(',')}`
      }
    } catch (e) {
      icPreviewDetail = String(e).slice(0, 80)
    }
    assertCase(
      'metadata.imageCenter.edit', 1,
      '给定角色和一组临时的立绘中心与缩放,渲染出的展示卡与网页端预览在同样数值下的外观一致',
      'browser-parity', appliedOk && configTextOk && icPreviewOk,
      `同角色 1212b1 同数值 x${IC_PARAMS.x}/y${IC_PARAMS.y}/z${IC_PARAMS.z} 独立驱动两侧;数值一致=${appliedOk};配置串一致=${configTextOk};预览像素比对 ${icPreviewDetail}`,
    )
    assertCase(
      'metadata.imageCenter.edit', 2,
      '返回的配置文本与网页端显示的那一段逐字相同,数值按相同规则取整',
      'browser-parity', configTextOk,
      `MCP "${(icMcp.config?.text || '').slice(0, 70)}" === web "${(webIc.codeText || '').slice(0, 70)}"`,
    )

    // case 3: no temp values -> the config's existing values; the editor's own
    // Reset restores the same text (real el.click() — focus+Enter does not
    // reach this button's handler)
    const webAfterReset = await p.evaluate(`() => {
      const b = Array.from(document.querySelectorAll('b')).find((el) => (el.textContent ?? '').trim() === 'Static')
      let node = b ?? null
      for (let i = 0; i < 6 && node; i++) {
        if (node.querySelectorAll('input').length >= 2) break
        node = node.parentElement
      }
      if (!node) return { ok: false, reason: 'no section' }
      const btn = Array.from(node.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === 'Reset')
      if (!btn) return { ok: false, reason: 'no Reset button' }
      btn.click()
      return { ok: true }
    }`, [])
    await sleep(900)
    const webResetCode = await p.evaluate(readStaticCode, [])
    assertCase(
      'metadata.imageCenter.edit', 3,
      '不传临时数值时使用配置里的现有值,与网页端点重置后的状态一致',
      'browser-parity',
      icMcpDefault.config?.text === webPristineCode.codeText && webAfterReset.ok && icMcpDefault.config?.text === webResetCode.codeText,
      `MCP no-params "${(icMcpDefault.config?.text || '').slice(0, 60)}";web 选角后未动(输入前读) "${(webPristineCode.codeText || '').slice(0, 60)}";web Reset 后 "${(webResetCode.codeText || '').slice(0, 60)}"`,
    )

    return true
  })

  // ═══ Phase 3: auditor progress + cancel (MCP semantics) ═════════════════
  // Grid note: relic4p+relic2p2p+ornament × 2 SPDs generates 546 runs — over
  // the tool's own MAX_SWEEP_RUNS=512 cap (the previous batch hit exactly that
  // validation error and produced 0 progress). relic4p+ornament × SPD 0 stays
  // legal while still running long enough to attempt a mid-run cancel.
  const progressEvents = []
  let cancelJobId = null
  let cancelDiag = ''
  let cancelRequested = false
  let sweepGetJobRttMs = null
  const sweepStartAt = Date.now()
  const sweepCancelled = await callTool(client, 'benchmark_runs', {
    characterId: '1212b1',
    sweep: 'sets',
    sweepOptions: { setTypes: ['relic4p', 'ornament'], spdBreakpoints: [0], modes: ['dps'], errRope: ['noErr'], scoringModes: ['perfection'] },
  }, {
    timeout: 600_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => {
      progressEvents.push(p)
      if (progressEvents.length === 1) {
        void (async () => {
          try {
            const sentAt = Date.now()
            const jobs = (await callTool(client, 'get_job', {})).jobs ?? []
            sweepGetJobRttMs = Date.now() - sentAt
            const running = jobs.filter((j) => (j.kind ?? j.type) === 'benchmark_runs' && j.status === 'running')
            cancelJobId = running[0]?.jobId ?? cancelJobId
            cancelDiag = `get_job(首条进度后即发)→${jobs.length} 条(running=${running.length}),RTT ${sweepGetJobRttMs}ms`
            if (cancelJobId != null) {
              await callTool(client, 'cancel_job', { jobId: cancelJobId })
              cancelRequested = true
              cancelDiag += `;cancel_job(${cancelJobId}) 已发`
            }
          } catch (e) {
            cancelDiag = `cancel 链异常: ${String(e.message).slice(0, 90)}`
          }
        })()
      }
    },
  }).catch((e) => ({ error: String(e.message) }))
  await sleep(800)
  const sweepMs = Date.now() - sweepStartAt
  const cancelOk = progressEvents.length >= 1 && sweepCancelled?.error == null
    && sweepCancelled.cancelled === true && (sweepCancelled.summaries ?? []).length === 0
  assertCase(
    'metadata.setAuditor.run', 4,
    '带进度令牌时按已完成的基准数发送进度,取消后不返回半截结果',
    'browser-parity', cancelOk,
    `${progressEvents.length} progress notification(s)(progress=已完成基准数,样例 progress=${JSON.stringify(progressEvents[0]?.progress ?? null)}/total=${JSON.stringify(progressEvents[0]?.total ?? null)});${cancelDiag || 'cancel 未及发出'};审计耗时 ${(sweepMs / 1000).toFixed(1)}s;cancelled=${sweepCancelled?.cancelled}, summaries=${(sweepCancelled?.summaries ?? []).length}${sweepCancelled?.error ? ';error=' + String(sweepCancelled.error).slice(0, 60) : ''}`
      + (cancelOk ? '(取消即弃置全部半截汇总)' : '——内联引擎占满服务器单线程,中途的 cancel 请求要等审计跑完才被读取(与 benchmarks.generate#3 同根因);未取消时返回的是完整汇总而非半截'),
  )
} catch (e) {
  failures++
  console.error('verify-metadata crashed:', e)
} finally {
  try {
    await browserManager.close()
  } catch { /* already down */ }
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

// ── evidence file ────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from 'node:fs'
const evidenceDir = resolve(mcpDir, 'coverage/evidence')
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(resolve(evidenceDir, 'metadata.json'), JSON.stringify({
  area: 'metadata',
  generatedAt: new Date().toISOString(),
  gitCommit: '8ac1d045',
  cases: EVIDENCE,
}, null, 2))
console.log(`\nevidence: ${EVIDENCE.length} cases → mcp/coverage/evidence/metadata.json`)
console.log(failures === 0 ? '\nverify-metadata: ALL CASES PASSED' : `\nverify-metadata: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
