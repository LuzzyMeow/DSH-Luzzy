// Load lib/client.js the way the real DSH loader does.
//
// The previous version of this test used a mock __ModuleLoader__ that accepted any id,
// so it passed while the shipped bundle was broken — the loader wanted the package
// name and the bundle registered the patch-layer id. This harness implements the
// loader's actual check (factories.has(<graph row id>), row id = package name) so that
// mistake cannot pass again.
//
// Usage: node tools/test-loader-contract.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- the loader, for real

/**
 * Mirrors dsh-client-modules' client half:
 *   register(reg)  -> factories.set(stripClientSuffix(reg.id), reg.factory)
 *   arrive(row)    -> after the bundle runs, factories.has(row.id) must be true,
 *                     where row.id is the package name (the graph row id).
 */
class FakeLoader {
  constructor() {
    this.factories = new Map()
    this.loadedUrls = []
  }

  get registrationTarget() {
    return { mode: 'live' }
  }

  create() {
    return this
  }

  load(registration) {
    const id = registration.id.endsWith('/client')
      ? registration.id.slice(0, -7)
      : registration.id
    if (this.factories.has(id)) {
      throw new Error(`duplicate factory registration for "${registration.id}"`)
    }
    this.factories.set(id, registration.factory)
  }

  /** What arrive() does after the transport resolves. */
  arrive(rowId, url) {
    this.loadedUrls.push(url)
    if (!this.factories.has(rowId)) {
      throw new Error(
        `client-modules: bundle ${url} loaded without registering "${rowId}" via __ModuleLoader__.load`,
      )
    }
  }
}

// ---------------------------------------------------------------- run the bundle

const loader = new FakeLoader()

globalThis.window = { __ModuleLoader__: loader }
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
}

const source = readFileSync(join(PLUGIN_ROOT, 'lib/client.js'), 'utf8')

// The graph row id the host will look up. It is the package name.
const graphRowId = manifest.name
const bundleUrl = `/plugins/??...,${graphRowId}/client.js&rev=<hash>`

let threw = null
try {
  new Function('window', 'document', source)(globalThis.window, globalThis.document)
  loader.arrive(graphRowId, bundleUrl)
} catch (error) {
  threw = error
}

check(
  `bundle registers under the graph row id "${graphRowId}"`,
  threw === null,
  threw?.message,
)

check(
  'the id is NOT the patch-layer id',
  !loader.factories.has('luzzy-page'),
  'the bare patch id must not be used as the module id',
)

check(
  'exactly one factory registered',
  loader.factories.size === 1,
  `saw ${loader.factories.size}: ${[...loader.factories.keys()].join(', ')}`,
)

// The factory must be usable by the host: exports apply/inject, no top-level side
// effects beyond registration.
//
// The allowed specifiers mirror the host's static module table, which is what a client
// bundle may `require` from. Anything else is a real error — a second React from `import`,
// or a dependency that would have to be bundled.
const ALLOWED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const factory = loader.factories.get(graphRowId)
if (factory) {
  const stubs = {
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') },
    '@deepseek-ai/dsh-client-store': {
      // The store's defineStore: actions mutate a draft; init makes the initial state.
      defineStore: (spec) => ({
        init: spec.init,
        actions: spec.actions,
      }),
    },
  }

  const module = factory((spec) => {
    if (!ALLOWED.has(spec)) {
      throw new Error(`require("${spec}") is not in the host's static module table`)
    }
    return stubs[spec] ?? {}
  })
  check('factory returns apply', typeof module.apply === 'function')
  check('factory returns inject', Array.isArray(module.inject))
  check(
    'inject declares slots + locale',
    Array.isArray(module.inject) && module.inject.includes('slots') && module.inject.includes('locale'),
    JSON.stringify(module.inject),
  )
}

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()

if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}

console.log(`PASS — ${notes.length} assertions (loader contract)`)
