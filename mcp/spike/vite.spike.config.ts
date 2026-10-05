import { resolve } from 'node:path'
import {
  defineConfig,
  type Plugin,
} from 'vite'

const root = resolve(import.meta.dirname, '../..')

// Swap Vite's browser `?worker` constructor for a node:worker_threads facade.
function nodeWorkerAlias(): Plugin {
  const VIRTUAL = '\0hsr-node-unified-worker'
  return {
    name: 'hsr-node-worker-alias',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('baseWorker.ts?worker')) return VIRTUAL
    },
    load(id) {
      if (id === VIRTUAL) {
        return `export { NodeUnifiedWorker as default } from ${JSON.stringify(resolve(import.meta.dirname, 'nodeWorkerAdapter.ts'))}`
      }
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
    outDir: resolve(import.meta.dirname, '.build'),
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        spike: resolve(import.meta.dirname, 'spike.ts'),
        spikeParallel: resolve(import.meta.dirname, 'spikeParallel.ts'),
        workerThread: resolve(import.meta.dirname, 'workerThread.ts'),
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
})
