// Probe: does GET /__luzzy/goal return a DIFFERENT goal per sessionId?
//
// Symptom being investigated: the user switches sessions and the page keeps showing the
// same goal, even for a session whose agent cannot see that goal.
//
// Two candidate mechanisms, and this distinguishes them:
//   A. the frame keeps asking with the OLD id  -> both requests return the same thing
//   B. the route ignores the id / falls back   -> both requests return the same thing
//      (`resolveTarget` has a "no sessionId -> newest session with a goal" fallback, and a
//       "session not loaded in this process -> show the plan anyway" branch)
//
// Usage: node tools/probe-goal-session-switch.mjs

import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LUZZY_DIAG_DIR = mkdtempSync(join(tmpdir(), 'luzzy-switch-probe-'))

const mod = await import('../lib/index.js')
const store = await import('../lib/goal-store.mjs')

const listeners = new Map()
const provided = {
  agents: { get: () => undefined },
  tools: { registered: [], register(definition) { this.registered.push(definition); return () => {} } },
}
const DECLARED = new Set(['webServer', 'effect', 'get', 'logger', 'on', 'emit', 'waterfall', 'serial'])
const routes = new Map()

const ctx = new Proxy({
  effect: (fn) => fn(),
  on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(handler)
    return () => {}
  },
  webServer: { register(route) { routes.set(route.path, route); return () => {} } },
  get: (name) => provided[name],
}, {
  get(object, property, receiver) {
    if (typeof property === 'symbol') return Reflect.get(object, property, receiver)
    if (Object.hasOwn(object, property) || DECLARED.has(property)) return Reflect.get(object, property, receiver)
    throw new Error(`cannot get property "${property}" without inject`)
  },
})

mod.apply(ctx)

// Two sessions, two DIFFERENT objectives — so "which one came back" is unambiguous.
const home = join(process.env.USERPROFILE, '.dsh')
const paths = store.storePaths(home)
for (const [id, objective] of [['probe-SESSION-A', 'A 的目标：只做前端'], ['probe-SESSION-B', 'B 的目标：只做后端']]) {
  const d = store.readDeliveryOverlay(paths, id)
  if (!d.ok) { console.log(`  cannot read overlay for ${id}: ${d.reason}`); continue }
  const next = { ...d.delivery, objectiveMirror: objective, revision: d.delivery.revision + 1 }
  const w = store.writeDeliveryOverlay(paths, id, next, d.delivery.revision)
  console.log(`  seeded ${id}: ok=${w.ok}`)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = routes.get(url.pathname)
  if (route === undefined) { res.writeHead(404).end('no route'); return }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  for (const id of ['probe-SESSION-A', 'probe-SESSION-B', '']) {
    const url = id === '' ? `${base}/__luzzy/goal` : `${base}/__luzzy/goal?sessionId=${encodeURIComponent(id)}`
    const res = await fetch(url)
    const body = await res.json()
    const which = body?.delivery?.objectiveMirror ?? null
    const target = body?.target?.sessionId ?? body?.sessionId ?? '?'
    console.log(`  ${id === '' ? '(no sessionId)' : id}  -> status=${res.status} target=${target} objective=${JSON.stringify(which)}`)
  }
} finally {
  server.close()
}
