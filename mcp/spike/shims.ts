// Throwaway feasibility spike: minimal browser-global shims, toggled by SPIKE_SHIMS=1.
// Recorded so the real MCP build knows exactly which globals the app touches at import time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

export const shimsEnabled = process.env.SPIKE_SHIMS === '1'

if (shimsEnabled) {
  g.window ??= g
  g.self ??= g
  g.addEventListener ??= () => {}
  g.removeEventListener ??= () => {}
  g.postMessage ??= () => {}
  g.location ??= { hash: '', href: 'http://localhost/', pathname: '/', search: '', origin: 'http://localhost', hostname: 'localhost' }
  g.history ??= { replaceState: () => {}, pushState: () => {} }
  g.scrollTo ??= () => {}
  g.matchMedia ??= () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })
  g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0)
  g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  if (g.localStorage == null) {
    const mem = new Map<string, string>()
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
      },
    })
  }
}
