// Probe: why does the session gate ALLOW a write with no goal when installed by the real
// apply()? The fake-context suite denies it, so either the wiring differs or a precondition
// that the fake satisfies is unmet here.
//
// Usage: node tools/probe-gate-in-real-apply.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LUZZY_DIAG_DIR = mkdtempSync(join(tmpdir(), 'luzzy-gate-probe-'))

const mod = await import('../lib/index.js')

const listeners = new Map()
const provided = {
  agents: { get: () => undefined },
  tools: { registered: [], register(definition) { this.registered.push(definition); return () => {} } },
}
const DECLARED = new Set(['webServer', 'effect', 'get', 'logger', 'on', 'emit', 'waterfall', 'serial'])

const ctx = new Proxy({
  effect: (fn) => fn(),
  on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(handler)
    return () => {}
  },
  webServer: { register: () => () => {} },
  get: (name) => provided[name],
}, {
  get(object, property, receiver) {
    if (typeof property === 'symbol') return Reflect.get(object, property, receiver)
    if (Object.hasOwn(object, property) || DECLARED.has(property)) return Reflect.get(object, property, receiver)
    throw new Error(`cannot get property "${property}" without inject`)
  },
})

mod.apply(ctx)

const preExecute = listeners.get('tools/pre-execute') ?? []
console.log(`pre-execute listeners: ${preExecute.length}`)

const agent = { id: 'probe-sess', session: { id: 'probe-sess', header: { cwd: null }, snapshotEvents: () => [] } }

for (const [index, handler] of preExecute.entries()) {
  const decision = await handler(
    { name: 'write', arguments: { path: 'a.txt' }, agent },
    () => Promise.resolve({ kind: 'allow' }),
  )
  console.log(`  listener[${index}] -> ${JSON.stringify(decision)?.slice(0, 140)}`)
}

// Is the gate even installed? Inspect the enforcement stats the plugin exposes.
const enforce = await import('../lib/goal-enforce.mjs')
console.log('counters for the probe session:', JSON.stringify(enforce.readCounters('probe-sess')))
