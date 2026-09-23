// Does the page's 采纳 button actually work? I claimed last round that it had no backend,
// then found `adoptProposal` INSIDE `HUMAN_OPS` — read one block too early. Verify by driving
// the real route over HTTP instead of reading code again (§5.27: "做不到" is a hypothesis).
//
// Usage: node tools/probe-proposal-adopt.mjs

import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LUZZY_DIAG_DIR = mkdtempSync(join(tmpdir(), 'luzzy-adopt-probe-'))

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

const SESSION = 'probe-adopt-session'
const paths = store.storePaths(join(process.env.USERPROFILE, '.dsh'))

// Seed a pending scope proposal the way the AGENT does, so the fixture matches reality.
const seed = store.readDeliveryOverlay(paths, SESSION)
if (!seed.ok) {
  console.log(`  cannot read overlay: ${seed.reason}`)
  process.exit(1)
}
const seeded = store.writeDeliveryOverlay(paths, SESSION, {
  ...seed.delivery,
  proposals: [{
    id: 'P-900',
    field: 'scope',
    status: 'pending',
    // The shape `proposeScope` actually stores. The first version of this probe wrote only
    // `proposed` and then read `scope.included` — which stayed empty because adopt applies
    // `proposal.value`, not `proposal.proposed`. The probe was wrong, not the feature.
    value: { included: ['probe-included'], excluded: ['probe-excluded'] },
    proposed: '1 项包含 / 1 项排除',
    before: '（未填写）',
    reason: 'probe',
    impact: 'none',
    at: Date.now(),
  }],
  revision: seed.delivery.revision + 1,
}, seed.delivery.revision)
console.log(`  seeded a pending proposal: ok=${seeded.ok}`)

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
  for (const op of ['adoptProposal', 'rejectProposal']) {
    const body = { op, payload: { id: 'P-900' }, sessionId: SESSION }
    const res = await fetch(`${base}/__luzzy/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    const proposal = (json.snapshot?.delivery?.proposals ?? json.delivery?.proposals ?? [])
      .find((p) => p.id === 'P-900')
    console.log(`  ${op.padEnd(15)} status=${res.status} applied=${JSON.stringify(json.applied ?? null)} error=${JSON.stringify(json.error ?? null)}`)
    console.log(`  ${''.padEnd(15)} proposal status now = ${proposal === undefined ? '(gone)' : proposal.status}`)
  }

  // And the scope should now be settled if adopt worked.
  const after = store.readDeliveryOverlay(paths, SESSION)
  if (after.ok) {
    console.log(`  scope.included = ${JSON.stringify(after.delivery.scope.included)}`)
    console.log(`  proposals left = ${after.delivery.proposals.length}`)
  }
} finally {
  server.close()
}
