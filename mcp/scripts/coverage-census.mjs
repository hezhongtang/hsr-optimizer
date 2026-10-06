// Coverage census: a mechanical inventory of the web app's interactive surface,
// used to prove that mcp/coverage/features.json leaves nothing out.
//
// Every non-test source file under src/ is parsed with the TypeScript compiler
// API (syntax only, no type checking) and reduced to five lists:
//   - controls:      JSX elements carrying an on* handler prop or a form binding spread
//   - interactions:  non-JSX interaction points (DOM listeners, drag and drop,
//                    clipboard/share, file inputs, websockets, downloads, ...)
//   - stores:        zustand store definitions with their state keys and actions
//   - actionModules: exported functions of controller / service / action modules
//   - persistence:   SaveState.save() / delayedSave() call sites
//
// The result is written to mcp/coverage/census.json. Every entry carries a
// `key` that ignores line numbers, so re-running after an upstream sync reports
// exactly which controls/actions appeared or vanished.
//
// The committed census omits line numbers on purpose: they change with every
// upstream edit and would bury real drift in noise. Pass --lines for a
// navigable working copy.
//
// Usage: node scripts/coverage-census.mjs                      regenerate coverage/census.json
//        node scripts/coverage-census.mjs --check              compare with the committed file (exit 1 on drift)
//        node scripts/coverage-census.mjs --lines --out <path> working copy with line numbers

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(mcpDir, '..')
const censusPath = resolve(mcpDir, 'coverage/census.json')

// Not part of the website: the leaderboard pipeline and build scripts run in Node.
const EXCLUDED_DIRS = ['src/leaderboard', 'src/scripts', 'src/types', 'src/data', 'src/assets', 'src/style']

const HINT_ATTRIBUTES = new Set(['label', 'title', 'placeholder', 'aria-label', 'tooltip', 'description', 'name', 'value', 'data-testid'])
const TRANSLATE_CALLEE = /^(t|tCommon|i18next\.t|i18n\.t)$/
const STORE_FACTORIES = new Set(['create', 'createStore', 'createTabAwareStore', 'createOverlayStore', 'createWithEqualityFn'])
const ACTION_MODULE = /(Controller|Service|Actions)\.tsx?$/
// Modules that hold business actions but do not follow the naming convention above.
const EXTRA_ACTION_MODULES = new Set([
  'src/lib/state/saveState.ts',
  'src/lib/utils/screenshotUtils.ts',
])
// In the engine, "Actions" means combat actions, not user actions.
const ENGINE_DIRS = ['src/lib/optimization/', 'src/lib/gpu/']
const PERSISTENCE_CALL = /^SaveState\.(save|delayedSave|permitEmptySave|load)$/

const INTERACTION_PATTERNS = [
  // Literal event names and identifier/constant event names are separate patterns so a
  // line never double-counts; drag engines register with imported constants (slotDrag.ts).
  ['dom-listener', /\baddEventListener\(\s*['"`]([\w:-]+)/],
  ['dom-listener', /\baddEventListener\(\s*[A-Za-z_$][\w$.]*\s*,/],
  ['dnd', /\b(useSortable|useDraggable|useDroppable)\(|<(DndContext|SortableContext|DragOverlay)\b/],
  ['clipboard-share', /navigator\.(clipboard|share|canShare)|\bClipboardItem\b/],
  ['window-open', /\bwindow\.open\(/],
  ['file-input', /type=['"]file['"]|<(FileButton|FileInput|Dropzone)\b|\bFileReader\b|showOpenFilePicker|showSaveFilePicker/],
  ['download', /URL\.createObjectURL|\.download\s*=|\bsaveAs\(|\bdownload=/],
  // The scanner socket is a partysocket hook, not a bare constructor.
  ['websocket', /\bnew WebSocket\(|\buseWebSocket\(/],
  ['network', /\bfetch\(/],
  ['storage', /\b(localStorage|sessionStorage)\.(getItem|setItem|removeItem|clear)\(/],
  ['navigation', /window\.location\.(hash|href|search)\s*=|history\.(pushState|replaceState)\(|\bnavigateTo\(/],
  ['grid', /<AgGridReact\b/],
  ['external-link', /href=\{?['"`]https?:/],
  ['canvas-media', /\.toBlob\(|\.toDataURL\(|\btoPng\(|\btoCanvas\(|\bOffscreenCanvas\b|\bcreateImageBitmap\(/],
  ['webgpu', /navigator\.gpu\b|\brequestAdapter\(/],
  ['worker', /\bnew Worker\(|\?worker['"]/],
  // Direct store writes that bypass a named store action
  ['store-set-state', /\buse[A-Za-z]+(Store|State)\.setState\(/],
]

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(repoRoot, full)
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(rel)) listSourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

function compact(text, max = 160) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
}

/** Name a function-like node carries through its declaration site, if any. */
function nameOfFunction(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText()
  if (!isFunctionLike(node)) return null
  if (ts.isFunctionExpression(node) && node.name) return node.name.text
  let parent = node.parent
  // Unwrap memo(...), forwardRef(...), useCallback(...) and friends
  while (parent && (ts.isCallExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) parent = parent.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText()
  return null
}

/** [outermost, ..., nearest] named function scopes around a node. */
function scopeChain(node) {
  const names = []
  for (let current = node.parent; current; current = current.parent) {
    const name = nameOfFunction(current)
    if (name) names.unshift(name)
  }
  return names
}

function collectStrings(node, sf, out, limit) {
  if (out.length >= limit) return
  if (ts.isJsxText(node)) {
    const text = compact(node.getText(sf), 80)
    if (/[\p{L}\p{N}]/u.test(text) && !out.includes(text)) out.push(text)
  } else if (ts.isCallExpression(node)) {
    const first = node.arguments[0]
    if (TRANSLATE_CALLEE.test(node.expression.getText(sf)) && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
      const key = `t:${first.text}`
      if (!out.includes(key)) out.push(key)
    }
  }
  ts.forEachChild(node, (child) => collectStrings(child, sf, out, limit))
}

function describeControl(node, sf) {
  const handlers = {}
  const hints = []
  let bind = null
  for (const attribute of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      const text = attribute.expression.getText(sf)
      if (/getInputProps|\.register\(/.test(text)) bind = compact(text, 100)
      continue
    }
    const name = attribute.name.getText(sf)
    const initializer = attribute.initializer
    if (/^on[A-Z]/.test(name)) {
      const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer
      handlers[name] = expression ? compact(expression.getText(sf)) : 'true'
    } else if (HINT_ATTRIBUTES.has(name) && initializer) {
      if (ts.isStringLiteral(initializer)) {
        hints.push(`${name}=${compact(initializer.text, 80)}`)
      } else {
        const before = hints.length
        collectStrings(initializer, sf, hints, 6)
        const text = initializer.getText(sf)
        if (hints.length === before && text.length <= 48) hints.push(`${name}=${text}`)
      }
    }
  }
  if (Object.keys(handlers).length === 0 && bind == null) return null
  if (ts.isJsxOpeningElement(node)) {
    for (const child of node.parent.children) collectStrings(child, sf, hints, 6)
  }
  return { handlers, bind, hints }
}

function objectReturnedBy(fn) {
  if (!fn.body) return null
  const unwrap = (expression) => {
    let current = expression
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
    return ts.isObjectLiteralExpression(current) ? current : null
  }
  if (!ts.isBlock(fn.body)) return unwrap(fn.body)
  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      const object = unwrap(statement.expression)
      if (object) return object
    }
  }
  return null
}

function findCreatorObject(node) {
  let found = null
  const walk = (current) => {
    if (found) return
    if (isFunctionLike(current)) {
      const object = objectReturnedBy(current)
      if (object) {
        found = object
        return
      }
    }
    ts.forEachChild(current, walk)
  }
  walk(node)
  return found
}

/** Top-level object literals of a file, by the name of the const or function that yields them. */
function collectLocalObjects(sf) {
  const locals = new Map()
  const unwrap = (expression) => {
    let current = expression
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
    return current
  }
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const object = objectReturnedBy(statement)
      if (object) locals.set(statement.name.text, object)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        const initializer = unwrap(declaration.initializer)
        const object = ts.isObjectLiteralExpression(initializer) ? initializer : isFunctionLike(initializer) ? objectReturnedBy(initializer) : null
        if (object) locals.set(declaration.name.text, object)
      }
    }
  }
  return locals
}

function describeMembers(object, sf, locals = new Map()) {
  const state = []
  const actions = []
  const spreads = []
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      // `...initialState` / `...createDefaults()` defined in the same file: inline its members
      const target = ts.isCallExpression(property.expression) ? property.expression.expression : property.expression
      const local = ts.isIdentifier(target) ? locals.get(target.text) : undefined
      if (local && local !== object) {
        const inner = describeMembers(local, sf, locals)
        state.push(...inner.state)
        actions.push(...inner.actions)
        spreads.push(...inner.spreads)
      } else {
        spreads.push(compact(property.expression.getText(sf), 80))
      }
    } else if (ts.isMethodDeclaration(property)) actions.push(property.name.getText(sf))
    else if (ts.isPropertyAssignment(property)) (isFunctionLike(property.initializer) ? actions : state).push(property.name.getText(sf))
    else if (ts.isShorthandPropertyAssignment(property)) state.push(property.name.text)
  }
  return { state, actions, spreads }
}

function calleeBaseName(expression) {
  let current = expression
  while (ts.isCallExpression(current)) current = current.expression
  if (ts.isIdentifier(current)) return current.text
  if (ts.isPropertyAccessExpression(current)) return current.name.text
  return null
}

function isExported(statement) {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/** Exported callables of an action module: functions, object-of-functions members, factory members. */
function describeExports(sf) {
  const names = []
  const addFunction = (name, fn) => {
    names.push(name)
    const object = objectReturnedBy(fn)
    if (object) { for (const action of describeMembers(object, sf).actions) names.push(`${name}().${action}`) }
  }
  for (const statement of sf.statements) {
    if (!isExported(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      addFunction(statement.name.text, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        let initializer = declaration.initializer
        while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
          initializer = initializer.expression
        }
        if (isFunctionLike(initializer)) {
          addFunction(declaration.name.text, initializer)
        } else if (ts.isObjectLiteralExpression(initializer)) {
          for (const action of describeMembers(initializer, sf).actions) names.push(`${declaration.name.text}.${action}`)
        }
      }
    }
  }
  return names
}

function scanFile(file, census) {
  const text = readFileSync(join(repoRoot, file), 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const importsStoreFactory = /from 'zustand|createTabAwareStore|createOverlayStore/.test(text)
  const ordinals = new Map()
  const nextOrdinal = (base) => {
    const count = (ordinals.get(base) ?? 0) + 1
    ordinals.set(base, count)
    return count
  }

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const control = describeControl(node, sf)
      if (control) {
        const chain = scopeChain(node)
        const owner = chain[0] ?? '(module)'
        const scope = chain[chain.length - 1] ?? '(module)'
        const tag = node.tagName.getText(sf)
        const base = `${file}#${owner}#${tag}#${Object.keys(control.handlers).join(',') || 'bind'}`
        census.controls.push({
          key: `${base}#${nextOrdinal(base)}`,
          file,
          line: lineOf(sf, node),
          owner,
          scope,
          tag,
          handlers: control.handlers,
          ...(control.bind ? { bind: control.bind } : {}),
          hints: control.hints,
        })
      }
    } else if (ts.isCallExpression(node) && PERSISTENCE_CALL.test(node.expression.getText(sf))) {
      const chain = scopeChain(node)
      const scope = chain[chain.length - 1] ?? '(module)'
      const call = node.expression.getText(sf)
      const base = `${file}#${scope}#${call}`
      census.persistence.push({ key: `${base}#${nextOrdinal(base)}`, file, line: lineOf(sf, node), scope, call })
    } else if (
      importsStoreFactory && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && STORE_FACTORIES.has(calleeBaseName(node.initializer) ?? '')
    ) {
      const object = findCreatorObject(node.initializer)
      if (object) {
        census.stores.push({
          key: `${file}#${node.name.text}`,
          file,
          line: lineOf(sf, node),
          store: node.name.text,
          ...describeMembers(object, sf, collectLocalObjects(sf)),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const isEngine = ENGINE_DIRS.some((dir) => file.startsWith(dir))
  if (file.startsWith('src/lib/') && !isEngine && (ACTION_MODULE.test(file) || EXTRA_ACTION_MODULES.has(file))) {
    census.actionModules.push({ key: file, file, exports: describeExports(sf) })
  }

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    for (const [kind, pattern] of INTERACTION_PATTERNS) {
      if (!pattern.test(line)) continue
      const base = `${file}#${kind}`
      census.interactions.push({ key: `${base}#${nextOrdinal(base)}`, file, line: index + 1, kind, text: compact(line, 140) })
    }
  }
}

function buildCensus({ lines = false } = {}) {
  const files = listSourceFiles(join(repoRoot, 'src')).sort()
  const census = { controls: [], interactions: [], stores: [], actionModules: [], persistence: [] }
  for (const file of files) scanFile(file, census)
  if (!lines) {
    for (const section of Object.values(census)) for (const entry of section) delete entry.line
  }

  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim()
  return {
    schema: 1,
    source: {
      // Tree hash of src/ at HEAD: identifies the scanned source independent of unrelated commits
      srcTree: git('rev-parse', 'HEAD:src'),
      dirty: git('status', '--porcelain', '--', 'src') !== '',
      files: files.length,
    },
    totals: {
      controls: census.controls.length,
      interactions: census.interactions.length,
      stores: census.stores.length,
      storeActions: census.stores.reduce((sum, store) => sum + store.actions.length, 0),
      actionModules: census.actionModules.length,
      actionExports: census.actionModules.reduce((sum, module) => sum + module.exports.length, 0),
      persistence: census.persistence.length,
    },
    ...census,
  }
}

/** Line-independent identity of everything the census tracks, for drift detection. */
export function censusKeys(census) {
  const keys = new Set()
  for (const section of ['controls', 'interactions', 'persistence']) {
    for (const entry of census[section]) keys.add(`${section}:${entry.key}`)
  }
  for (const store of census.stores) {
    for (const action of store.actions) keys.add(`storeAction:${store.key}.${action}`)
    for (const key of store.state) keys.add(`storeState:${store.key}.${key}`)
  }
  for (const module of census.actionModules) {
    for (const name of module.exports) keys.add(`export:${module.key}#${name}`)
  }
  return keys
}

export { buildCensus, censusPath }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf('--out')
  const outPath = outIndex === -1 ? censusPath : resolve(process.argv[outIndex + 1])
  const census = buildCensus({ lines: process.argv.includes('--lines') })
  if (process.argv.includes('--check')) {
    if (!existsSync(censusPath)) {
      console.error(`census: ${relative(repoRoot, censusPath)} is missing — run without --check first`)
      process.exit(1)
    }
    const committed = censusKeys(JSON.parse(readFileSync(censusPath, 'utf8')))
    const current = censusKeys(census)
    const added = [...current].filter((key) => !committed.has(key)).sort()
    const removed = [...committed].filter((key) => !current.has(key)).sort()
    for (const key of added) console.log(`+ ${key}`)
    for (const key of removed) console.log(`- ${key}`)
    if (added.length + removed.length > 0) {
      console.error(
        `census: drift against the committed census — ${added.length} added, ${removed.length} removed. Triage them into features.json, then regenerate.`,
      )
      process.exit(1)
    }
    console.log(`census: no drift (${current.size} tracked entries)`)
  } else {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(census, null, 2)}\n`)
    console.log(`census: wrote ${relative(repoRoot, outPath)}`)
    console.log(JSON.stringify({ source: census.source, totals: census.totals }, null, 2))
  }
}
