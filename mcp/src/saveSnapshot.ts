// Read-only structured save snapshot (M4-B).
//
// `readStructuredSnapshot()` builds the exact object `SaveState.save()`
// (src/lib/state/saveState.ts:62-107) would serialize, straight from the
// current store values, WITHOUT any of its side effects. It never calls
// SaveState.save() itself: that writes localStorage['state'] (the very
// reference the anti-wipe guard at saveState.ts:40-59 compares against, so a
// "read" through it would silently change later guard semantics), can refuse
// to serialize and return undefined while valid edits still wait for a flush,
// and clears the pending-save timeout. See also saveStores.ts' header for the
// same rule on the load path.
//
// MAINTENANCE CONTRACT: this mapping mirrors the serialization block of
// SaveState.save() field by field — when upstream adds/renames a field there,
// mirror it here in the same key order and update the line references.
// scripts/smoke-snapshot.mjs deep-equals this snapshot against a real
// export_save file to keep the two honest.

import { CURRENT_OPTIMIZER_VERSION } from 'lib/constants/constants'
import { useAhaTuningStore } from 'lib/stores/ahaTuningStore'
import { useGlobalStore } from 'lib/stores/app/appStore'
import { getCharacters } from 'lib/stores/character/characterStore'
import { useNewFeatureStore } from 'lib/stores/newFeatureStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
// Upstream imports the scanner state from ScannerWebsocketClient, which merely
// re-exports scannerStore (a .tsx React entry the MCP build does not use —
// same choice as saveStores.ts).
import {
  DEFAULT_WEBSOCKET_URL,
  useScannerState,
} from 'lib/tabs/tabImport/scannerStore'
import { useRelicLocatorStore } from 'lib/tabs/tabRelics/RelicLocator'
import { useRelicsTabStore } from 'lib/tabs/tabRelics/useRelicsTabStore'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import { useWarpCalculatorStore } from 'lib/tabs/tabWarp/useWarpCalculatorStore'
import type { Relic } from 'types/relic'
import type { HsrOptimizerSaveFormat } from 'types/store'

/** Serialize the current stores into the save format — a pure read.
 *
 * Returns the same object (same fields, same key order) SaveState.save()
 * produces, including unflushed edits: it reads the live store values, not the
 * persisted file or localStorage. No localStorage write, no guard-reference
 * update, no flush scheduling, no revision bump. */
export function readStructuredSnapshot(): HsrOptimizerSaveFormat {
  const characters = getCharacters() // saveState.ts:36
  const relics = getRelics() // saveState.ts:37
  // NOTE: the anti-wipe guard (saveState.ts:40-59) is deliberately NOT
  // evaluated here — a snapshot is a read, never a gate.

  const globalState = useGlobalStore.getState() // saveState.ts:62
  const relicsTabState = useRelicsTabStore.getState() // saveState.ts:63
  const showcaseTabSession = useShowcaseTabStore.getState().savedSession // saveState.ts:64
  const globalSession = globalState.savedSession // saveState.ts:65
  const relicLocatorSession = useRelicLocatorStore.getState() // saveState.ts:66
  const ahaSpeedTunerSession = useAhaTuningStore.getState() // saveState.ts:67

  const warpCalculatorTabState = useWarpCalculatorStore.getState() // saveState.ts:69
  const scannerState = useScannerState.getState() // saveState.ts:70

  const state: HsrOptimizerSaveFormat = {
    // Strip the optimizer-only augmentedStats before persisting — saveState.ts:73
    relics: relics.map(({ augmentedStats, ...rest }) => rest) as Relic[],
    characters: characters, // saveState.ts:74 (by reference, like upstream)
    scoringMetadataOverrides: useScoringStore.getState().scoringMetadataOverrides, // saveState.ts:75
    showcasePreferences: useShowcaseTabStore.getState().showcasePreferences, // saveState.ts:76
    optimizerMenuState: useOptimizerDisplayStore.getState().menuState, // saveState.ts:77
    excludedRelicPotentialCharacters: relicsTabState.excludedRelicPotentialCharacters, // saveState.ts:78
    savedSession: { // saveState.ts:79-82
      showcaseTab: showcaseTabSession,
      global: globalSession,
    },
    settings: globalState.settings, // saveState.ts:83
    version: CURRENT_OPTIMIZER_VERSION, // saveState.ts:84
    warpRequest: warpCalculatorTabState.request, // saveState.ts:85
    relicLocator: { // saveState.ts:86-89
      inventoryWidth: relicLocatorSession.inventoryWidth,
      rowLimit: relicLocatorSession.rowLimit,
    },
    ahaSpeedTuner: { // saveState.ts:90-96
      teammate0: ahaSpeedTunerSession.teammate0,
      teammate1: ahaSpeedTunerSession.teammate1,
      teammate2: ahaSpeedTunerSession.teammate2,
      teammate3: ahaSpeedTunerSession.teammate3,
      desiredAha: ahaSpeedTunerSession.desiredAha,
    },
    scannerSettings: { // saveState.ts:97-104
      ingest: scannerState.ingest,
      ingestCharacters: scannerState.ingestCharacters,
      ingestOnlyExistingCharacters: scannerState.ingestOnlyExistingCharacters,
      ingestWarpResources: scannerState.ingestWarpResources,
      websocketUrl: scannerState.websocketUrl,
      customUrl: scannerState.websocketUrl !== DEFAULT_WEBSOCKET_URL,
    },
    completedMigrations: globalState.completedMigrations, // saveState.ts:105
    seenFeatures: Array.from(useNewFeatureStore.getState().seenFeatures), // saveState.ts:106
  }

  return state
}
