// M7-D smoke: set_portrait / deliver_artifact / state sections
// visualDebug + relicsTab.
//
// Node-only sections (always run):
//   set_portrait — add on a character already in the save (portrait lands in
//     character.portrait via export_save(structured) + get_character, sniffed
//     originalDimensions from a 1x1 PNG data URL, artistName echo, no
//     insertion), add on a metadata-only character (inserted via the upstream
//     upsert side effect), reset (character kept, portrait cleared, reset on a
//     missing character errors in Chinese, invalid ids/schemes/crops rejected)
//   visualDebug — get returns the 19 upstream defaults + cardDebug=false;
//     update writes roundtrip, textShadow preset label maps to its CSS value,
//     applyPreset/reset behave, and updates NEVER bump revision (session-only
//     upstream never persists this store); range/enum/unknown-key validation
//   relicsTab — excludedRelicPotentialCharacters roundtrips into
//     export_save(structured).excludedRelicPotentialCharacters (persisted via
//     the save chain), invalid ids rejected; recentRelics read shape (ids +
//     resolved cards) and rejected as an update key
//   deliver_artifact list/read/delete — artifacts pre-seeded into
//     HSR_MCP_ARTIFACTS_DIR in the exact artifactStore file format ({id}.png +
//     {id}.json ArtifactMeta), read sniffs dimensions from the PNG header,
//     missing ids error listing the existing ones
// Browser sections (copy/share) — guarded:
//   the managed browser (browserManager) may not be implemented yet (parallel
//   M7 agent) and Chrome/dist may be absent; either condition prints [SKIP]
//   with the reason and exits 0. When present, copy/share run for real and we
//   only assert the honest-shape contract (ok/available/reason present),
//   because clipboard/share outcomes are platform-conditional by design.
//
// The sample save is copied to a temp dir before load (never load the repo
// file); the artifacts dir points at a temp dir so the run is hermetic.
//
// Usage: node scripts/smoke-portrait.mjs [serverEntry]

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-portrait-`)
const sampleSavePath = `${tempDir}/sample-save.json`
copyFileSync(repoSampleSavePath, sampleSavePath)
const artifactsDir = `${tempDir}/artifacts`

// Canonical 1x1 transparent PNG (valid signature + IHDR, exactly the offsets
// the server-side sniffer reads).
const PNG_1x1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_1x1_BYTES = Buffer.from(PNG_1x1_BASE64, 'base64')
const PNG_DATA_URL = `data:image/png;base64,${PNG_1x1_BASE64}`

let failures = 0
let skips = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function skip(name, reason) {
  console.log(`[SKIP] ${name} — ${reason}`)
  skips++
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

async function toolError(client, name, args) {
  let result
  try {
    result = await client.callTool({ name, arguments: args })
  } catch (e) {
    // SDK-level input-schema rejections (-32602) are legitimate rejections too
    return `MCP error: ${e.message}`
  }
  if (!result.isError) {
    throw new Error(`tool ${name} was expected to fail but succeeded`)
  }
  return result.content?.[0]?.text ?? ''
}

async function getState(client, section) {
  const payload = await callTool(client, 'get_state', { section })
  if (payload.section !== section || payload[section] == null) {
    throw new Error(`get_state(${section}) returned unexpected shape: ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return payload[section]
}

/** Pre-seed an artifact in the exact artifactStore on-disk format. */
function seedArtifact(artifactId, label) {
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(`${artifactsDir}/${artifactId}.png`, PNG_1x1_BYTES)
  writeFileSync(
    `${artifactsDir}/${artifactId}.json`,
    JSON.stringify({
      artifactId,
      file: `${artifactsDir}/${artifactId}.png`,
      bytes: PNG_1x1_BYTES.length,
      createdAtIso: new Date().toISOString(),
      label,
      format: 'png',
    }),
  )
}

// ── boot ─────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'smoke-portrait', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: {
    ...getDefaultEnvironment(),
    HSR_MCP_STATE_FILE: `${tempDir}/localstorage.json`,
    HSR_MCP_ARTIFACTS_DIR: artifactsDir,
  },
})
await client.connect(transport)

try {
  await callTool(client, 'load_save', { path: sampleSavePath })

  // ── 1. set_portrait(add) on a character already in the save ───────────────
  const characters = await callTool(client, 'list_characters', {})
  const inSaveId = characters.characters[0].id
  const revisionBeforeSet = (await getState(client, 'revision')).revision

  const set1 = await callTool(client, 'set_portrait', {
    characterId: inSaveId,
    action: 'set',
    imageUrl: PNG_DATA_URL,
    artistName: '冒烟画师',
    croppedAreaPixels: { x: 0, y: 0, width: 1, height: 1 },
  })
  check(
    'set_portrait(set) echoes the full CustomImageConfig with sniffed dimensions',
    set1.updated === true
      && set1.portrait.imageUrl === PNG_DATA_URL
      && set1.portrait.originalDimensions.width === 1
      && set1.portrait.originalDimensions.height === 1
      && set1.portrait.artistName === '冒烟画师'
      && set1.portrait.customImageParams.croppedAreaPixels.width === 1
      && set1.portrait.customImageParams.croppedArea.width === 100
      && set1.portrait.cropper.zoom === 1
      && set1.characterInserted === false,
    `dimensions=${set1.portrait?.originalDimensions?.width}x${set1.portrait?.originalDimensions?.height} croppedArea=${set1.portrait?.customImageParams?.croppedArea?.width}`,
  )
  check(
    'set_portrait(set) bumps revision exactly once and reports dirty',
    set1.revision === revisionBeforeSet + 1 && set1.dirty === true,
    `revision=${set1.revision} (before ${revisionBeforeSet})`,
  )

  const detail = await callTool(client, 'get_character', { characterId: inSaveId })
  check('get_character reports hasCustomPortrait=true after set', detail.hasCustomPortrait === true)

  const snapshot1 = await callTool(client, 'export_save', { structured: true })
  const snapChar = snapshot1.snapshot.characters.find((c) => c.id === inSaveId)
  check(
    'export_save(structured) carries the portrait on the character (persisted field)',
    snapChar?.portrait?.imageUrl === PNG_DATA_URL && snapChar?.portrait?.artistName === '冒烟画师',
    `portrait=${snapChar?.portrait ? 'present' : 'missing'}`,
  )

  // ── 2. set_portrait(add) on a metadata-only character → inserted ──────────
  const characterCountBefore = snapshot1.counts.characters
  let metadataOnlyId = null
  const probeCandidates = ['1001', '1002', '1003', '1101', '1209', '1212b1']
  for (const id of probeCandidates) {
    if (!characters.characters.some((c) => c.id === id)) {
      metadataOnlyId = id
      break
    }
  }
  if (metadataOnlyId == null) {
    skip('set_portrait insert-side-effect probe', 'sample save unexpectedly contains every probe character')
  } else {
    const set2 = await callTool(client, 'set_portrait', {
      characterId: metadataOnlyId,
      action: 'set',
      imageUrl: PNG_DATA_URL,
      croppedAreaPixels: { x: 0, y: 0, width: 1, height: 1 },
      originalDimensions: { width: 4, height: 4 },
    })
    check(
      'set_portrait(set) inserts a metadata-only character (upstream upsert side effect)',
      set2.characterInserted === true,
      `id=${metadataOnlyId}`,
    )
    const snapshot2 = await callTool(client, 'export_save', { structured: true })
    check(
      'inserted character lands in the save with the portrait',
      snapshot2.counts.characters === characterCountBefore + 1
        && snapshot2.snapshot.characters.some((c) => c.id === metadataOnlyId && c.portrait != null),
      `characters ${characterCountBefore} → ${snapshot2.counts.characters}`,
    )
    check(
      'explicit originalDimensions override wins over sniffing',
      set2.portrait.originalDimensions.width === 4,
      `width=${set2.portrait.originalDimensions.width}`,
    )
    // reset on the freshly inserted character: kept, portrait cleared
    const reset1 = await callTool(client, 'set_portrait', {
      characterId: metadataOnlyId,
      action: 'reset',
    })
    check(
      'set_portrait(reset) clears the portrait and keeps the character',
      reset1.portrait === null && reset1.showcasePortrait === null && reset1.updated === true,
    )
    const afterReset = await callTool(client, 'get_character', { characterId: metadataOnlyId })
    check('after reset hasCustomPortrait=false but the character remains', afterReset.hasCustomPortrait === false)
  }

  // ── 3. set_portrait error paths ───────────────────────────────────────────
  const badId = await toolError(client, 'set_portrait', {
    characterId: 'not-a-character',
    action: 'reset',
  })
  check('unknown characterId rejected against game metadata', badId.includes('游戏元数据') && badId.includes('not-a-character'), badId.slice(0, 90))

  // The insert probe above may have ADDED a metadata-only character to the
  // inventory, so pick the reset-missing probe from the CURRENT inventory.
  const inventoryNow = (await callTool(client, 'list_characters', {})).characters.map((c) => c.id)
  const stillMissingId = probeCandidates.find((id) => !inventoryNow.includes(id))
  if (stillMissingId == null) {
    skip('reset on a character outside the inventory', 'every probe character is in the inventory after the insert probe')
  } else {
    const resetMissing = await toolError(client, 'set_portrait', {
      characterId: stillMissingId,
      action: 'reset',
    })
    check(
      'reset on a character outside the inventory errors (upstream No-character-selected branch)',
      resetMissing.includes(stillMissingId) && (resetMissing.includes('库存') || resetMissing.includes('存档')),
      resetMissing.slice(0, 90),
    )
  }

  const badScheme = await toolError(client, 'set_portrait', {
    characterId: inSaveId,
    action: 'set',
    imageUrl: 'ftp://example.invalid/x.png',
    croppedAreaPixels: { x: 0, y: 0, width: 1, height: 1 },
  })
  check('imageUrl scheme validated (data:/http(s) only)', badScheme.includes('参数无效') && badScheme.includes('imageUrl'), badScheme.slice(0, 90))

  const badCrop = await toolError(client, 'set_portrait', {
    characterId: inSaveId,
    action: 'set',
    imageUrl: PNG_DATA_URL,
    croppedAreaPixels: { x: -3, y: 0, width: 1, height: 1 },
  })
  // Negative coordinates are caught by the tool's input schema (SDK -32602)
  // before the handler's Chinese validation — both are legitimate rejections.
  check(
    'negative crop coordinates rejected',
    badCrop.includes('croppedAreaPixels') || badCrop.includes('Invalid arguments') || badCrop.includes('参数无效'),
    badCrop.slice(0, 90),
  )

  const badSniff = await toolError(client, 'set_portrait', {
    characterId: inSaveId,
    action: 'set',
    imageUrl: 'data:image/png;base64,AAAA-zzzz-not-an-image',
    croppedAreaPixels: { x: 0, y: 0, width: 1, height: 1 },
  })
  check(
    'undecodable image falls into the actionable sniff error (suggest originalDimensions)',
    badSniff.includes('originalDimensions'),
    badSniff.slice(0, 110),
  )

  // restore the first character's portrait state for later sections
  await callTool(client, 'set_portrait', { characterId: inSaveId, action: 'reset' })

  // ── 4. visualDebug section ────────────────────────────────────────────────
  const visual0 = await getState(client, 'visualDebug')
  const configKeys = [
    'portraitBlur',
    'portraitBrightness',
    'portraitSaturate',
    'portraitContrast',
    'cardBgAlpha',
    'debugMaxC',
    'debugMinC',
    'debugChromaScale',
    'debugTargetL',
    'debugMinL',
    'debugMaxL',
    'blendMode',
    'shadowX',
    'shadowY',
    'shadowBlur',
    'shadowOpacity',
    'insetBlur',
    'insetOpacity',
    'textShadow',
  ]
  check(
    'get_state(visualDebug): 19 upstream default fields + cardDebug=false + preset references',
    configKeys.every((key) => key in visual0.config)
      && visual0.config.portraitBlur === 40
      && visual0.config.blendMode === 'normal'
      && visual0.cardDebug === false
      && Array.isArray(visual0.textShadowPresets) && visual0.textShadowPresets.length >= 8
      && visual0.presets.shine.blendMode === 'screen'
      && visual0.presets.natural.portraitBlur === 46,
    `portraitBlur=${visual0.config.portraitBlur} presets=${visual0.presets.shine.blendMode}/${visual0.presets.natural.portraitBlur}`,
  )

  const revisionBeforeVisual = (await getState(client, 'revision')).revision
  const glowValue = visual0.textShadowPresets.find((preset) => preset.label === 'Glow')?.value
  const visualUpd = await callTool(client, 'update_state', {
    section: 'visualDebug',
    patch: { portraitBlur: 55, blendMode: 'screen', textShadow: 'Glow', cardDebug: true },
  })
  check(
    'update_state(visualDebug) writes fields, maps the textShadow preset label to its CSS value',
    visualUpd.visualDebug.config.portraitBlur === 55
      && visualUpd.visualDebug.config.blendMode === 'screen'
      && visualUpd.visualDebug.config.textShadow === glowValue
      && visualUpd.visualDebug.cardDebug === true,
    `portraitBlur=${visualUpd.visualDebug?.config?.portraitBlur} textShadow mapped=${visualUpd.visualDebug?.config?.textShadow === glowValue}`,
  )
  check(
    'visualDebug update does NOT bump revision (session-only, upstream never persists it)',
    visualUpd.revision === revisionBeforeVisual,
    `revision=${visualUpd.revision} (before ${revisionBeforeVisual})`,
  )

  const presetUpd = await callTool(client, 'update_state', {
    section: 'visualDebug',
    patch: { applyPreset: 'shine' },
  })
  check(
    'applyPreset=shine covers the whole config with the SHINE preset',
    presetUpd.visualDebug.config.portraitBrightness === 0.35
      && presetUpd.visualDebug.config.blendMode === 'screen'
      && presetUpd.visualDebug.config.portraitBlur === 40,
    `brightness=${presetUpd.visualDebug?.config?.portraitBrightness}`,
  )
  check(
    'applyPreset keeps the revision untouched too',
    presetUpd.revision === revisionBeforeVisual,
    `revision=${presetUpd.revision}`,
  )

  const resetUpd = await callTool(client, 'update_state', {
    section: 'visualDebug',
    patch: { reset: true },
  })
  check(
    'reset=true restores the upstream defaults (cardDebug stays session-state)',
    resetUpd.visualDebug.config.portraitBlur === 40 && resetUpd.visualDebug.config.blendMode === 'normal',
  )

  const badAlpha = await toolError(client, 'update_state', {
    section: 'visualDebug',
    patch: { cardBgAlpha: 1.5 },
  })
  check('cardBgAlpha outside 0–1 rejected', badAlpha.includes('cardBgAlpha') && badAlpha.includes('期望'), badAlpha.slice(0, 90))

  const badBlend = await toolError(client, 'update_state', {
    section: 'visualDebug',
    patch: { blendMode: 'multiply' },
  })
  check('blendMode enum validated (screen/normal)', badBlend.includes('blendMode') && badBlend.includes('screen'), badBlend.slice(0, 90))

  const unknownVisual = await toolError(client, 'update_state', {
    section: 'visualDebug',
    patch: { notAField: 1 },
  })
  check(
    'visualDebug unknown key rejected with legal keys listed',
    unknownVisual.includes('notAField') && unknownVisual.includes('portraitBlur'),
    unknownVisual.slice(0, 90),
  )

  // ── 5. relicsTab section ──────────────────────────────────────────────────
  const relics0 = await getState(client, 'relicsTab')
  check(
    'get_state(relicsTab): excluded list + read-only recentRelics projection',
    Array.isArray(relics0.excludedRelicPotentialCharacters)
      && Array.isArray(relics0.recentRelics.ids)
      && Array.isArray(relics0.recentRelics.cards)
      && relics0.recentRelics.cards.every((card) => relics0.recentRelics.ids.includes(card.id)),
    `excluded=${relics0.excludedRelicPotentialCharacters.length} recentIds=${relics0.recentRelics.ids.length} cards=${relics0.recentRelics.cards.length}`,
  )

  const excludedIds = characters.characters.slice(0, 2).map((c) => c.id)
  const relicsUpd = await callTool(client, 'update_state', {
    section: 'relicsTab',
    patch: { excludedRelicPotentialCharacters: excludedIds },
  })
  const relicsEcho = await getState(client, 'relicsTab')
  check(
    'update_state(relicsTab) replaces the excluded list and bumps revision (persisted field)',
    relicsUpd.updated === true
      && JSON.stringify(relicsEcho.excludedRelicPotentialCharacters) === JSON.stringify(excludedIds)
      && relicsUpd.revision > revisionBeforeVisual,
    `excluded=${relicsEcho.excludedRelicPotentialCharacters.join(',')} revision=${relicsUpd.revision}`,
  )
  const snapshot3 = await callTool(client, 'export_save', { structured: true })
  check(
    'excludedRelicPotentialCharacters lands in the save snapshot (save chain parity)',
    JSON.stringify(snapshot3.snapshot.excludedRelicPotentialCharacters) === JSON.stringify(excludedIds),
  )

  const badExclude = await toolError(client, 'update_state', {
    section: 'relicsTab',
    patch: { excludedRelicPotentialCharacters: ['1001', 'not-a-character'] },
  })
  check(
    'excluded list ids validated against game metadata',
    badExclude.includes('not-a-character') && badExclude.includes('游戏元数据'),
    badExclude.slice(0, 90),
  )

  const recentWrite = await toolError(client, 'update_state', {
    section: 'relicsTab',
    patch: { recentRelics: ['abc'] },
  })
  check(
    'recentRelics is read-only (scanner-push driven) — rejected as an update key',
    recentWrite.includes('recentRelics') && recentWrite.includes('excludedRelicPotentialCharacters'),
    recentWrite.slice(0, 90),
  )

  // ── 6. deliver_artifact list/read/delete ──────────────────────────────────
  seedArtifact('art-smoke-alpha', 'smoke alpha')
  seedArtifact('art-smoke-beta', 'smoke beta')

  const list1 = await callTool(client, 'deliver_artifact', { action: 'list' })
  check(
    'deliver_artifact(list) enumerates the seeded artifacts',
    list1.count === 2
      && list1.artifacts.some((m) => m.artifactId === 'art-smoke-alpha')
      && list1.artifacts.some((m) => m.artifactId === 'art-smoke-beta'),
    `count=${list1.count}`,
  )

  const read1 = await callTool(client, 'deliver_artifact', { action: 'read', artifactId: 'art-smoke-alpha' })
  check(
    'deliver_artifact(read) returns meta + sniffed dimensions + base64 content',
    read1.artifact.bytes === PNG_1x1_BYTES.length
      && read1.width === 1 && read1.height === 1
      && Buffer.from(read1.base64, 'base64').equals(PNG_1x1_BYTES),
    `bytes=${read1.artifact?.bytes} ${read1.width}x${read1.height}`,
  )

  const missing = await toolError(client, 'deliver_artifact', { action: 'read', artifactId: 'art-nope' })
  check(
    'unknown artifactId errors and lists the existing ids',
    missing.includes('art-nope') && missing.includes('art-smoke-alpha') && missing.includes('art-smoke-beta'),
    missing.slice(0, 100),
  )

  const del1 = await callTool(client, 'deliver_artifact', { action: 'delete', artifactId: 'art-smoke-beta' })
  const list2 = await callTool(client, 'deliver_artifact', { action: 'list' })
  check(
    'deliver_artifact(delete) removes the artifact from the store',
    del1.deleted.artifactId === 'art-smoke-beta' && list2.count === 1 && list2.artifacts[0].artifactId === 'art-smoke-alpha',
    `count=${list2.count}`,
  )

  // ── 7. deliver_artifact copy/share (browser-gated) ────────────────────────
  const chromePath = process.env.HSR_MCP_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const siteDist = process.env.HSR_MCP_SITE_DIST ?? resolve(mcpDir, '../dist/index.html')
  let browserGate = null
  if (!existsSync(chromePath)) browserGate = `Chrome executable not found at ${chromePath}`
  else if (!existsSync(siteDist)) browserGate = `site dist not found at ${siteDist}`

  if (browserGate != null) {
    skip('deliver_artifact copy/share', browserGate)
  } else {
    // Browser tasks can outlive the SDK's 60s default request timeout (task
    // timeout alone is 60s) — give the calls headroom so the server's own
    // timeout/structured result wins instead of a client-side -32001.
    const browserCallOptions = { timeout: 150_000 }
    // browserManager may still be the M7-A stub — that is a SKIP, not a failure
    let copyPayload = null
    let probeError = null
    try {
      copyPayload = await callTool(client, 'deliver_artifact', { action: 'copy', artifactId: 'art-smoke-alpha' }, browserCallOptions)
    } catch (e) {
      probeError = String(e.message)
    }
    if (probeError != null && probeError.includes('尚未落地')) {
      skip('deliver_artifact copy/share', `browserManager 尚未落地(任务 A 并行中):${probeError.slice(0, 80)}`)
    } else if (probeError != null) {
      check('deliver_artifact(copy) ran against the real browser (unexpected error is a failure)', false, probeError.slice(0, 140))
    } else {
      check(
        'deliver_artifact(copy) reports ok/reason honestly with the platform note',
        typeof copyPayload.ok === 'boolean' && typeof copyPayload.note === 'string' && copyPayload.note.includes('无头浏览器'),
        `ok=${copyPayload.ok} reason=${copyPayload.reason?.slice(0, 60) ?? '-'}`,
      )
      const shareResult = await callTool(client, 'deliver_artifact', { action: 'share', artifactId: 'art-smoke-alpha' }, browserCallOptions)
      check(
        'deliver_artifact(share) reports availability honestly (canShare/share platform branch)',
        typeof shareResult.available === 'boolean' && typeof shareResult.note === 'string',
        `available=${shareResult.available} reason=${shareResult.reason?.slice(0, 60) ?? '-'}`,
      )
    }
  }

  console.log(failures === 0 ? `smoke-portrait: ALL CHECKS PASSED${skips > 0 ? ` (${skips} skipped)` : ''}` : `smoke-portrait: ${failures} FAILED`)
} finally {
  await client.close()
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
