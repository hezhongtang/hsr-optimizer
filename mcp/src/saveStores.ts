// Save-file loads are transactions over the current stores. Reading a snapshot
// must not call SaveState.save(): that updates localStorage and can be blocked
// by the anti-wipe guard while valid edits are still waiting for a flush.

import {
  OpenCloseIDs,
  setClose,
  setOpen,
} from 'lib/hooks/useOpenClose'
import * as persistenceService from 'lib/services/persistenceService'
import { useAhaTuningStore } from 'lib/stores/ahaTuningStore'
import { useGlobalStore } from 'lib/stores/app/appStore'
import { useCharacterStore } from 'lib/stores/character/characterStore'
import { useNewFeatureStore } from 'lib/stores/newFeatureStore'
import { useOptimizerRequestStore } from 'lib/stores/optimizerForm/useOptimizerRequestStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
import { useCharacterTabStore } from 'lib/tabs/tabCharacters/useCharacterTabStore'
import { useScannerState } from 'lib/tabs/tabImport/scannerStore'
import { useRelicLocatorStore } from 'lib/tabs/tabRelics/RelicLocator'
import { useRelicsTabStore } from 'lib/tabs/tabRelics/useRelicsTabStore'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import { useWarpCalculatorStore } from 'lib/tabs/tabWarp/useWarpCalculatorStore'
import type { HsrOptimizerSaveFormat } from 'types/store'
import type { StoreApi } from 'zustand/vanilla'

type StateAccess<T> = Pick<StoreApi<T>, 'getState' | 'getInitialState' | 'setState'>

function pickFields<T, K extends keyof T>(state: T, keys: readonly K[]): Partial<T> {
  const result: Partial<T> = {}
  for (const key of keys) result[key] = state[key]
  return result
}

function captureFields<T, K extends keyof T>(store: StateAccess<T>, keys: readonly K[]): () => void {
  const snapshot = structuredClone(pickFields(store.getState(), keys))
  return () => store.setState(snapshot)
}

function resetFields<T, K extends keyof T>(store: StateAccess<T>, keys: readonly K[]): void {
  store.setState(structuredClone(pickFields(store.getInitialState(), keys)))
}

const globalFields = ['completedMigrations', 'savedSession', 'settings', 'version'] as const
const showcaseFields = ['showcasePreferences', 'savedSession'] as const
const ahaFields = ['teammate0', 'teammate1', 'teammate2', 'teammate3', 'desiredAha'] as const
const scannerFields = ['ingest', 'ingestCharacters', 'ingestOnlyExistingCharacters', 'ingestWarpResources', 'websocketUrl'] as const

function syncSidebar(): void {
  if (useGlobalStore.getState().savedSession.sidebarCollapsed) {
    setClose(OpenCloseIDs.MENU_SIDEBAR)
  } else {
    setOpen(OpenCloseIDs.MENU_SIDEBAR)
  }
}

/** Capture every field loadSaveData can replace, including inventory indices
 * and dependent focus/rank state. Direct restoration avoids re-running
 * migrations over the user's current edits. Runtime path/dirty/debounce/cache
 * state is untouched until the load succeeds. */
export function captureSaveStores(): () => void {
  const restore = [
    captureFields(useRelicStore, ['relics', 'relicsById']),
    captureFields(useCharacterStore, ['characters', 'charactersById']),
    captureFields(useGlobalStore, globalFields),
    captureFields(useShowcaseTabStore, showcaseFields),
    captureFields(useOptimizerDisplayStore, ['menuState']),
    captureFields(useAhaTuningStore, ahaFields),
    captureFields(useScannerState, scannerFields),
    captureFields(useScoringStore, ['scoringMetadataOverrides', 'scoringVersion']),
    captureFields(useNewFeatureStore, ['seenFeatures']),
    captureFields(useWarpCalculatorStore, ['request']),
    captureFields(useRelicsTabStore, ['excludedRelicPotentialCharacters']),
    captureFields(useRelicLocatorStore, ['inventoryWidth', 'rowLimit']),
    captureFields(useCharacterTabStore, ['focusCharacter']),
    // Restored last because the character-store subscription can update rank.
    captureFields(useOptimizerRequestStore, ['rank']),
  ]
  return () => {
    for (const restoreFields of restore) restoreFields()
    syncSidebar()
  }
}

/** Replace a save rather than importing its optional fields over the previous
 * account. Defaults come from the upstream stores and explicit values still
 * pass through the entire upstream migration chain. */
export function replaceSaveStores(data: HsrOptimizerSaveFormat): HsrOptimizerSaveFormat {
  resetFields(useGlobalStore, globalFields)
  resetFields(useShowcaseTabStore, showcaseFields)
  resetFields(useOptimizerDisplayStore, ['menuState'])
  resetFields(useAhaTuningStore, ahaFields)
  resetFields(useScannerState, scannerFields)

  // Scanner action setters schedule SaveState.delayedSave even when the load's
  // autosave argument is false. Apply these configuration fields directly so
  // loading a file neither saves it implicitly nor ingests old scanner data.
  const { scannerSettings, ...migrationData } = data
  // sanitize=true = the web's MANUAL load semantics (LoadDataSubmenu.tsx:161):
  // an autosave restore would re-point the scanner websocket at whatever url
  // the (possibly untrusted) save carries — persistenceService.ts:207 only
  // restores the url when !sanitize, and MCP's load_save is the manual path.
  persistenceService.loadSaveData(migrationData, false, true)
  if (scannerSettings) {
    const defaults = useScannerState.getInitialState()
    useScannerState.setState({
      ingest: scannerSettings.ingest ?? defaults.ingest,
      ingestCharacters: scannerSettings.ingestCharacters ?? defaults.ingestCharacters,
      ingestOnlyExistingCharacters: scannerSettings.ingestOnlyExistingCharacters ?? defaults.ingestOnlyExistingCharacters,
      ingestWarpResources: scannerSettings.ingestWarpResources ?? defaults.ingestWarpResources,
      // Manual-load security semantics: never re-point the scanner connection
      // from save data (the save's customUrl is echoed in load_save's return
      // for transparency, but not applied).
      websocketUrl: defaults.websocketUrl,
    })
  }
  syncSidebar()
  return { ...migrationData, ...(scannerSettings ? { scannerSettings } : {}) }
}
