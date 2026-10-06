import { resolve } from 'node:path'
import {
  defineConfig,
  type Plugin,
} from 'vite'

const root = resolve(import.meta.dirname, '..')

// Swap Vite's browser `?worker` constructors for node:worker_threads facades.
// Covers both `?worker` imports in the upstream codebase:
//   - lib/worker/baseWorker.ts?worker     (shared optimizer pool)
//   - lib/worker/scoreRelicsWorker.ts?worker (relic scoring, M2)
// The worker script URLs are resolved at runtime from globals set by the
// flat entry chunks (see src/index.ts and src/worker/driverThread.ts).
function nodeWorkerAlias(): Plugin {
  const BASE_VIRTUAL = '\0hsr-node-unified-worker-base'
  const SCORE_VIRTUAL = '\0hsr-node-unified-worker-score'
  const adapterPath = JSON.stringify(resolve(import.meta.dirname, 'src/worker/nodeWorkerAdapter.ts'))

  const baseModule = `
    import { NodeUnifiedWorker } from ${adapterPath}
    export default class extends NodeUnifiedWorker {
      constructor() {
        super(globalThis.__HSR_MCP_POOL_WORKER_URL)
      }
    }
  `
  const scoreModule = `
    import { NodeUnifiedWorker } from ${adapterPath}
    export default class extends NodeUnifiedWorker {
      constructor() {
        super(globalThis.__HSR_MCP_SCORE_WORKER_URL)
      }
    }
  `

  return {
    name: 'hsr-mcp-node-worker-alias',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('baseWorker.ts?worker')) return BASE_VIRTUAL
      if (source.endsWith('scoreRelicsWorker.ts?worker')) return SCORE_VIRTUAL
    },
    load(id) {
      if (id === BASE_VIRTUAL) return baseModule
      if (id === SCORE_VIRTUAL) return scoreModule
    },
  }
}

export default defineConfig({
  root,
  publicDir: false,
  plugins: [nodeWorkerAlias()],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    ssr: true,
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        driverThread: resolve(import.meta.dirname, 'src/worker/driverThread.ts'),
        poolWorkerThread: resolve(import.meta.dirname, 'src/worker/poolWorkerThread.ts'),
        scoreRelicsThread: resolve(import.meta.dirname, 'src/worker/scoreRelicsThread.ts'),
        parityRef: resolve(import.meta.dirname, 'src/parityRef.ts'),
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
})
