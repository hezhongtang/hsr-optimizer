// @vitest-environment jsdom
import { useGlobalStore } from 'lib/stores/app/appStore'
import { AppPages } from 'lib/tabs/navigation/constants'
import { Tabs } from 'lib/tabs/Tabs'
import {
  act,
  type ReactNode,
} from 'react'
import {
  createRoot,
  type Root,
} from 'react-dom/client'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

// ---- Mocks ----

vi.mock('@mantine/core', () => ({ Flex: ({ children }: { children: ReactNode }) => children }))
vi.mock('lib/stores/newFeatureStore', () => ({ markFeatureSeen: vi.fn() }))
vi.mock('lib/worker/workerPool', () => ({ workerPool: { initialize: vi.fn() } }))

vi.mock('lib/tabs/tabBenchmarks/BenchmarksTab', () => ({ BenchmarksTab: () => 'mounted' }))
vi.mock('lib/tabs/tabCalculators/CalculatorsTab', () => ({ CalculatorsTab: () => 'mounted' }))
vi.mock('lib/tabs/tabChangelog/ChangelogTab', () => ({ ChangelogTab: () => 'mounted' }))
vi.mock('lib/tabs/tabCharacters/CharacterTab', () => ({ CharacterTab: () => 'mounted' }))
vi.mock('lib/tabs/tabHome/HomeTab', () => ({ HomeTab: () => 'mounted' }))
vi.mock('lib/tabs/tabImport/ImportTab', () => ({ ImportTab: () => 'mounted' }))
vi.mock('lib/tabs/tabLeaderboard/LeaderboardTab', () => ({ LeaderboardTab: () => 'mounted' }))
vi.mock('lib/tabs/tabOptimizer/OptimizerTab', () => ({ OptimizerTab: () => 'mounted' }))
vi.mock('lib/tabs/tabRelics/RelicsTab', () => ({ RelicsTab: () => 'mounted' }))
vi.mock('lib/tabs/tabShowcase/ShowcaseTab', () => ({ ShowcaseTab: () => 'mounted' }))
vi.mock('lib/tabs/tabWarp/WarpCalculatorTab', () => ({ WarpCalculatorTab: () => 'mounted' }))

// ---- Helpers ----

const STAGGER_MS = 100

// WEBGPU_TEST and METADATA_TEST are dev-only and mount only on navigation
const BACKGROUND_PAGES = Object.values(AppPages)
  .filter((page) => page !== AppPages.WEBGPU_TEST && page !== AppPages.METADATA_TEST)

function mountedPages() {
  return BACKGROUND_PAGES.filter((page) => document.getElementById(page)?.textContent === 'mounted')
}

// ---- Tests ----

describe('Tabs staggered background mount', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('scrollTo', vi.fn())
    useGlobalStore.setState({ activeKey: AppPages.WARP })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root.render(<Tabs />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('mounts only the active tab up front', () => {
    expect(mountedPages()).toEqual([AppPages.WARP])
  })

  it('mounts every tab when each tick renders before the next one fires', () => {
    for (let tick = 0; tick < BACKGROUND_PAGES.length; tick++) {
      act(() => {
        vi.advanceTimersByTime(STAGGER_MS)
      })
    }

    expect(mountedPages()).toEqual(BACKGROUND_PAGES)
  })

  it('mounts every tab when ticks fire while earlier mounts are still pending', () => {
    act(() => {
      vi.advanceTimersByTime(STAGGER_MS * BACKGROUND_PAGES.length)
    })

    expect(mountedPages()).toEqual(BACKGROUND_PAGES)
  })
})
