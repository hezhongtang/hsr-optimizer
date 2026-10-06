// Headless i18n bootstrap for the MCP server.
//
// The upstream web app initializes the i18next singleton in `src/lib/i18n/i18n.ts`
// with i18next-http-backend (browser fetch of public/locales/...). That module is
// web-entry-only — nothing in the headless engine path imports it (the two
// engine-adjacent importers, `lib/optimization/engine/config/statsConfig.ts` and
// `types/i18next.ts`, use type-only imports that are elided at transpile time).
// Upstream code still reads translations through the SAME singleton —
// `lib/utils/i18nUtils.ts` does `import i18next from 'i18next'` and conditionals
// call `wrappedFixedT(true).get(null, ns, prefix)` — so here we initialize that
// singleton directly with inline `resources` parsed from the repository's YAML
// files, bypassing http-backend entirely.
//
// The init options mirror `src/lib/i18n/i18n.ts` exactly except for the resource
// source (see ensureI18nReady). nsSeparator / keySeparator / plural rules are
// NOT set in either place, so both run on i18next defaults — keys resolve
// identically on web and headless.
//
// THREAD NOTE: every vite entry chunk (index, driverThread, poolWorkerThread,
// scoreRelicsThread) bundles its own copy of i18next, so each entry must call
// ensureI18nReady() — after './shims' and before any upstream lib import that
// can evaluate translated labels.

import i18next from 'i18next'
import type {
  Resource,
  ResourceKey,
  ResourceLanguage,
} from 'i18next'
import yaml from 'js-yaml'
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import {
  basename,
  dirname,
  join,
} from 'node:path'
import { fileURLToPath } from 'node:url'

/** Language the MCP server renders in (upstream conditionals use getFixedT(null, …),
 * i.e. they follow the current language, so this is what their labels resolve to). */
export const MCP_I18N_LANGUAGE = 'zh_CN'

/** Mirrors upstream fallbackLng (src/lib/i18n/i18n.ts) — keys missing from
 * zh_CN fall back to the English bundle, exactly like the web app. */
export const MCP_I18N_FALLBACK_LANGUAGE = 'en_US'

const DEFAULT_LANGUAGES = [MCP_I18N_LANGUAGE, MCP_I18N_FALLBACK_LANGUAGE] as const

// Mirrors upstream defaultNS / fallbackNS (src/lib/i18n/i18n.ts).
const DEFAULT_NS = 'common'
const FALLBACK_NS = ['common', 'gameData']

/** Environment escape hatch: explicit path to a `public/locales`-style directory
 * (containing `<lng>/<ns>.yaml`). Checked before the repository walk. */
const LOCALES_DIR_ENV = 'HSR_MCP_LOCALES_DIR'

const YAML_EXT = '.yaml'

function isLngYamlFile(name: string): boolean {
  return name.endsWith(YAML_EXT) && !name.startsWith('.')
}

/**
 * Build i18next inline `resources` from the repository's locale YAML files.
 *
 * Pure function — only reads files and parses YAML, never touches the i18next
 * singleton. Structure: `resources[lng][ns] = <parsed YAML tree>` where the
 * namespace is the file basename (conditionals.yaml → 'conditionals', matching
 * upstream's hardcoded namespace list).
 */
export function buildI18nResources(localesDir: string, languages: readonly string[] = DEFAULT_LANGUAGES): Resource {
  const resources: Resource = {}
  for (const lng of languages) {
    const lngDir = join(localesDir, lng)
    if (!existsSync(lngDir)) {
      throw new Error(
        `i18n 初始化失败:语言目录不存在:${lngDir}(MCP 构建产物不内嵌翻译,运行期依赖仓库的 public/locales;请检查 HSR_MCP_LOCALES_DIR 或改在完整仓库内运行)`,
      )
    }
    const language: ResourceLanguage = {}
    for (const file of readdirSync(lngDir).filter(isLngYamlFile).sort()) {
      const ns = basename(file, YAML_EXT)
      const path = join(lngDir, file)
      let parsed: unknown
      try {
        parsed = yaml.load(readFileSync(path, 'utf8'))
      } catch (e) {
        throw new Error(`i18n 初始化失败:解析翻译文件出错:${path}:${String(e)}`)
      }
      if (parsed == null) continue // empty file → no bundle for this ns
      if (typeof parsed !== 'object') {
        throw new Error(`i18n 初始化失败:翻译文件顶层不是键值结构:${path}(期望 YAML 映射,实际为 ${typeof parsed})`)
      }
      language[ns] = parsed as ResourceKey
    }
    if (Object.keys(language).length === 0) {
      throw new Error(`i18n 初始化失败:语言目录里没有任何 *.yaml 翻译文件:${lngDir}`)
    }
    resources[lng] = language
  }
  return resources
}

function isLocalesRoot(dir: string): boolean {
  return existsSync(join(dir, MCP_I18N_LANGUAGE, `${DEFAULT_NS}${YAML_EXT}`))
}

/**
 * Locate the repository `public/locales` directory without depending on cwd.
 *
 * Resolution order:
 *   1. HSR_MCP_LOCALES_DIR (explicit override, must be valid)
 *   2. Walk up from this module's own location until a `public/locales` root
 *      is found. Works from every runtime layout because vite SSR bundles keep
 *      `import.meta.url` pointing at the emitted chunk: `mcp/dist/*.js` walks
 *      dist → mcp → repo root, and source-mode runs (mcp/src/i18n) walk the
 *      same chain. The cost is that dist must keep living inside the repo —
 *      build-time self-containment was deliberately traded away (see plan §5.5).
 */
export function resolveLocalesDir(): string {
  const fromEnv = process.env[LOCALES_DIR_ENV]
  if (fromEnv) {
    if (!isLocalesRoot(fromEnv)) {
      throw new Error(`i18n 初始化失败:环境变量 ${LOCALES_DIR_ENV}=${fromEnv} 下找不到 ${MCP_I18N_LANGUAGE}/${DEFAULT_NS}${YAML_EXT},请修正该路径`)
    }
    return fromEnv
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'public', 'locales')
    if (isLocalesRoot(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        `i18n 初始化失败:未能从模块位置(${dir})向上找到 public/locales。MCP 运行期依赖仓库的翻译文件,请通过环境变量 ${LOCALES_DIR_ENV} 指向 locales 目录,或确认在完整仓库内启动(node mcp/dist/index.js)`,
      )
    }
    dir = parent
  }
}

let ensureCompleted = false

/**
 * Idempotently initialize the shared i18next singleton with inline resources.
 *
 * Synchronous by design: i18next runs its init `load()` step synchronously
 * whenever inline `resources` are provided (v26 runtime:
 * `if (this.options.resources || !this.options.initAsync) load()`), so callers
 * in any entry chunk can use t() as soon as this returns, no await needed.
 *
 * Init options mirror `src/lib/i18n/i18n.ts` (defaultNS 'common', fallbackNS
 * ['common','gameData'], load 'currentOnly', fallbackLng, interpolation escaping
 * off, separators/plurals left at i18next defaults). The only deliberate
 * differences, both about the resource source:
 *   - `resources` inline instead of http-backend
 *   - `lng: 'zh_CN'` instead of browser LanguageDetector (the server always
 *     renders Chinese), and `supportedLngs` restricted to the loaded languages
 *     — loading all 9 upstream locales buys nothing for a fixed-language server
 *
 * If the singleton was already initialized by someone else, missing bundles are
 * added via addResourceBundle instead of re-init (i18next forbids re-init).
 */
export function ensureI18nReady(): void {
  if (ensureCompleted) return

  const resources = buildI18nResources(resolveLocalesDir())
  // Union of namespaces across languages; en_US carries 20 files where zh_CN
  // has 18 (leaderboardTab / teamShowcaseTab are not yet translated) — the
  // union reproduces upstream's hardcoded 20-namespace list from the files.
  const namespaces = [...new Set(Object.values(resources).flatMap((language) => Object.keys(language)))].sort()

  if (i18next.isInitialized) {
    for (const [lng, language] of Object.entries(resources)) {
      for (const [ns, bundle] of Object.entries(language)) {
        if (!i18next.hasResourceBundle(lng, ns)) i18next.addResourceBundle(lng, ns, bundle)
      }
    }
    ensureCompleted = true
    return
  }

  void i18next.init({
    resources,
    ns: namespaces,
    defaultNS: DEFAULT_NS,
    fallbackNS: FALLBACK_NS,
    debug: false,
    supportedLngs: Object.keys(resources),
    lng: MCP_I18N_LANGUAGE,
    load: 'currentOnly',
    fallbackLng: MCP_I18N_FALLBACK_LANGUAGE,
    interpolation: {
      escapeValue: false, // upstream parity: labels are consumed as plain strings, not HTML
    },
  })

  if (!i18next.isInitialized) {
    throw new Error('i18n 初始化失败:i18next.init() 未能同步完成(提供 inline resources 时不应发生),请上报 MCP 服务端日志')
  }
  if (!i18next.hasResourceBundle(MCP_I18N_LANGUAGE, DEFAULT_NS)) {
    throw new Error(`i18n 初始化失败:${MCP_I18N_LANGUAGE}/${DEFAULT_NS} 资源包未注册,翻译将回显 key,请检查 public/locales 目录完整性`)
  }
  ensureCompleted = true
}
