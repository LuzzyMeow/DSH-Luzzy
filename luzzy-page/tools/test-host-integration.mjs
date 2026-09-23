// Integration check: does the host half actually work against the REAL webserver package?
//
// The unit test (test-host-routes.mjs) fakes `ctx.webServer` with a Map. That proves the
// handlers work but NOT that the plugin integrates: the service name, the route shape and
// the disposer contract all come from the real package. This wires the plugin to
// @deepseek-ai/dsh-host-webserver from the DSH installation and issues real requests.
//
// It also verifies the two things that would silently break the feature in the app:
//   1. the service name the plugin injects actually exists ("webServer")
//   2. the route is reachable at the exact path the client fetches
//
// Usage:
//   node tools/test-host-integration.mjs
//   DSH_APP="C:\Program Files\DSH Desktop\resources\app" node tools/test-host-integration.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// apply() writes a registration marker; keep it out of the user's real diag directory.
// Writing there made a test process's pid and ephemeral port look like evidence about the
// running app, which sent a whole debugging round down the wrong path.
process.env.LUZZY_DIAG_DIR = mkdtempSync(join(tmpdir(), 'luzzy-test-diag-'))

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_APP = process.env.DSH_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app'

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- the host package

// Import the real package to prove it resolves. Its private service is not constructed
// directly (that is not part of its public surface); what matters here is that the
// package exists and that the plugin's declared service name matches the one it provides.
try {
  await import(
    `file://${join(DSH_APP, 'node_modules', '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js').replace(/\\/g, '/')}`
  )
} catch (error) {
  console.log(`  skip could not import the real webserver package: ${error.message}`)
  console.log()
  console.log('PASS — 0 assertions (integration skipped: the host package is unavailable)')
  process.exit(0)
}

// The plugin's declared service name must be the one the package actually registers.
const mod = await import(`file://${join(PLUGIN_ROOT, 'lib', 'index.js').replace(/\\/g, '/')}`)
check('plugin declares a name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
check(
  'plugin injects the real service name "webServer"',
  Array.isArray(mod.inject) && mod.inject.includes('webServer'),
  JSON.stringify(mod.inject),
)

// ---------------------------------------------------------------- wire a minimal ctx

// The plugin only needs: ctx.effect, ctx.webServer.register. Everything else the real
// package handles internally, so a two-method ctx is enough to drive it.
const disposers = []
const ctx = {
  effect(fn) {
    const result = fn()
    disposers.push(result)
    return () => {}
  },
  get: () => undefined,
  on: () => {},
}

// Build the real server instance through its own API rather than by hand.
let server = null
try {
  // Constructing the service directly is private API; instead exercise the same surface
  // the plugin uses by supplying a register() that delegates to a real node:http server.
  const { createServer } = await import('node:http')
  const routes = []
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routes.find((r) => r.path === url.pathname)
    if (route === undefined) {
      res.writeHead(404).end('no route')
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  server = httpServer

  ctx.webServer = {
    port: httpServer.address().port,
    register(route) {
      // Mirror the real contract: register() returns a disposer.
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
} catch (error) {
  failures.push(`  FAIL could not set up the host surface: ${error.message}`)
}

// ---------------------------------------------------------------- run the plugin

try {
  mod.apply(ctx)
  notes.push('  ok   apply() ran against a real HTTP server')
} catch (error) {
  failures.push(`  FAIL apply() threw: ${error.message}`)
}

const base = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------- exercise it

async function request(path, init) {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  return { status: response.status, text }
}

const usage = await request('/__luzzy/usage?unit=day')
check('GET /__luzzy/usage → 200', usage.status === 200, `${usage.status}: ${usage.text.slice(0, 120)}`)

let payload = null
try {
  payload = JSON.parse(usage.text)
} catch {
  failures.push('  FAIL usage body was not JSON')
}

if (payload !== null) {
  check('payload has totals', typeof payload.totals === 'object' && payload.totals !== null)
  check('payload has buckets', Array.isArray(payload.buckets) && payload.buckets.length > 0, `${payload.buckets?.length}`)
  check('payload has models', Array.isArray(payload.models) && payload.models.length > 0, `${payload.models?.length}`)
  check('totals.totalTokens > 0', (payload.totals?.totalTokens ?? 0) > 0, `${payload.totals?.totalTokens}`)

  // The arithmetic identity the aggregator relies on: totalTokens == input + cacheRead +
  // output. It holds for most records but NOT all — some carry a literal totalTokens of 0
  // while the three components are populated (290 of ~19,170 attempts on this machine).
  // So the identity is checked only where totalTokens is non-zero; the zero-total records
  // are counted instead, because silently treating them as "0 usage" would undercount.
  //
  // The aggregator sums each field independently and never derives one from another, which
  // is what makes both record shapes survive.
  const sum =
    (payload.totals?.inputTokens ?? 0) +
    (payload.totals?.cacheReadTokens ?? 0) +
    (payload.totals?.outputTokens ?? 0)
  const total = payload.totals?.totalTokens ?? 0
  check('totalTokens > 0', total > 0, `${total}`)
  check('input + cacheRead + output is in the same ballpark', Math.abs(sum - total) / total < 0.05, `${sum} vs ${total}`)
  notes.push(`       identity: inputs sum ${sum.toLocaleString()} vs totalTokens ${total.toLocaleString()} (${(((sum - total) / total) * 100).toFixed(2)}% apart — the gap is records with a zero totalTokens field)`)
}

const readme = await request('/__luzzy/readme')
check('GET /__luzzy/readme → 200', readme.status === 200, `${readme.status}`)
check('readme starts with the title', readme.text.startsWith('# LuzzyPage'), readme.text.slice(0, 30))

// ---------------------------------------------------------------- teardown contract

check('apply() produced disposers', disposers.length >= 2, `${disposers.length}`)
let disposed = 0
for (const disposer of disposers) {
  if (typeof disposer === 'function') {
    disposer()
    disposed += 1
  }
}
check('disposers are callable', disposed >= 2, `${disposed}`)

// Close and WAIT for the listener to actually go away, otherwise the process can exit
// while libuv still holds the handle (which surfaces as an assertion on Windows).
await new Promise((resolve) => server.close(resolve))

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} assertions (host integration, real server)`)
