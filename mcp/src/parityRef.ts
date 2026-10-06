// In-process optimization reference for scripts/parity.mjs (parity harness).
//
// Replays the EXACT request-building recipe of the optimize tool — the
// character's saved form → computeLoadForm → displayToInternal → rank sync,
// with NO formOverrides merge — and feeds it straight to runOptimization,
// bypassing the MCP tool layer entirely. Rows are printed as JSON on stdout
// so the harness can compare them line-by-line against the stdio optimize
// result (firstMismatch style). Any divergence means the wrapper layer
// introduced drift; identical output means the MCP surface is faithful.
//
// Mirrors the optimize tool step-for-step, including runtimeContext.flushSave()
// (the driver reloads the SaveState.save()-reserialized snapshot, not the raw
// file) and resultsLimit (the upstream FixedSizeMinQueue retention size — both
// sides must use the same limit or the retained top-N differs).
//
// Usage: node dist/parityRef.js <save-file> <characterId>

import './shims'

import { readFileSync } from 'node:fs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any
g.__HSR_MCP_DRIVER_URL = new URL('./driverThread.js', import.meta.url).href
g.__HSR_MCP_SCORE_WORKER_URL = new URL('./scoreRelicsThread.js', import.meta.url).href

const RESULTS_LIMIT = 50 // the optimize tool's default

async function main(): Promise<void> {
  const [savePath, characterId] = process.argv.slice(2)
  if (!savePath || !characterId) {
    throw new Error('usage: node dist/parityRef.js <save-file> <characterId>')
  }

  const { Metadata } = await import('lib/state/metadataInitializer')
  const persistenceService = await import('lib/services/persistenceService')
  const { SaveState } = await import('lib/state/saveState')
  const { getCharacterById, getCharacters } = await import('lib/stores/character/characterStore')
  const { computeLoadForm } = await import('lib/stores/optimizerForm/optimizerFormStoreActions')
  const { displayToInternal } = await import('lib/stores/optimizerForm/optimizerFormConversions')
  const { runOptimization } = await import('./runOptimizer')

  Metadata.initialize()

  const data = JSON.parse(readFileSync(savePath, 'utf8'))
  persistenceService.loadSaveData(data, false, false)

  // Mirror runtimeContext.flushSave(): snapshot := SaveState.save() of the
  // loaded stores (what optimize passes to runOptimization).
  const stateString = SaveState.save()
  if (!stateString) throw new Error('SaveState.save() produced no output')
  const snapshot = JSON.parse(stateString)

  // Mirror the optimize tool's request recipe (no formOverrides branch).
  const character = getCharacterById(characterId as any)
  if (!character) throw new Error(`Character ${characterId} not found`)
  const request: any = displayToInternal(computeLoadForm(character.form))
  request.characterId = characterId
  request.rank = getCharacters().findIndex((c: any) => c.id === characterId)
  request.resultsLimit = RESULTS_LIMIT

  const run = await runOptimization(snapshot, request)
  // The cached driver worker keeps the event loop alive (correct for the
  // long-lived server, wrong for a one-shot CLI) — exit explicitly after the
  // JSON has flushed.
  process.stdout.write(
    JSON.stringify({
      rows: run.rows,
      summary: run.summary,
    }),
    'utf8',
    () => process.exit(0),
  )
  setTimeout(() => process.exit(0), 2000).unref()
}

void main().catch((error) => {
  process.stderr.write(`[parityRef] fatal: ${String((error as Error)?.stack ?? error)}\n`)
  process.exitCode = 1
})
