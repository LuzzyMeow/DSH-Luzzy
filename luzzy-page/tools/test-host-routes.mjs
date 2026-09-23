// End-to-end test for the host-half routes, over real HTTP.
//
// Loads lib/index.js, registers its routes on a real node:http server, then issues real
// requests. A mock ctx would not exercise `req.socket.remoteAddress` (the loopback
// guard), URL parsing, or the actual JSON serialization — all of which are load-bearing.
//
// Usage: node tools/test-host-routes.mjs

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This test calls apply(), and apply() writes a registration marker plus a diag log.
// Point them at a throwaway directory: writing into the user's real .dsh/luzzy-page-diag/
// would leave a marker carrying THIS test process's pid and ephemeral port, which then
// reads like evidence about the running app. That mistake already cost one round.
process.env.LUZZY_DIAG_DIR = mkdtempSync(join(tmpdir(), 'luzzy-test-diag-'))

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(`file://${join(PLUGIN_ROOT, 'lib', 'index.js').replace(/\\/g, '/')}`)

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

// Capture the routes the plugin registers.
//
// The context THROWS ON UNDECLARED SERVICES, like cordis does. Reading `ctx.agents` from a
// fiber that only injected `webServer` raises `cannot get property "agents" without inject`,
// and this test exists to run the REAL `apply()` — so a permissive stub here would let
// exactly the defect that broke the preset sub-page in production pass as green.
//
// `on` is part of the CORDIS CONTEXT itself, not a service: every plugin may register a
// listener without declaring anything, and `apply()` now does (the goal feature's two
// lifecycle hooks). So it belongs in the always-available set beside `effect` and `get`.
// The strictness that matters is unchanged — any *service* name still throws unless it is
// declared or provided.
const DECLARED = new Set(['webServer', 'effect', 'get', 'logger', 'on', 'emit', 'waterfall', 'serial'])
const provided = {
  agents: { get: () => undefined },
  // The tool registry, so the goal feature's tool registration is OBSERVABLE. Without it,
  // `registerDeliveryTool` degrades to `{registered:false}` and the assertion below would
  // silently check nothing.
  tools: { registered: [], register(definition) { this.registered.push(definition); return () => {} } },
}
const routes = new Map()
const listeners = new Map()
const ctx = new Proxy({
  effect: (fn) => fn(),
  on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(handler)
    return () => {}
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => {}
    },
  },
  get: (name) => provided[name],
}, {
  get(object, property, receiver) {
    if (typeof property === 'symbol') return Reflect.get(object, property, receiver)
    if (Object.hasOwn(object, property) || DECLARED.has(property)) return Reflect.get(object, property, receiver)
    throw new Error(`cannot get property "${property}" without inject`)
  },
})

check('exports name', mod.name === 'luzzy-page', `got ${mod.name}`)
check('inject declares webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'))

mod.apply(ctx)
check('registered /__luzzy/usage', routes.has('/__luzzy/usage'))
check('registered /__luzzy/readme', routes.has('/__luzzy/readme'))
check('registered /__luzzy/preset', routes.has('/__luzzy/preset'))

// THE GOAL FEATURE'S WIRING, in the only test that runs the real `apply()`.
//
// This block was missing until now. Every other goal suite calls `registerGoalRoutes` /
// `installEnforcement` / `registerDeliveryTool` directly — so they prove those functions work,
// but NOT that `apply()` calls them. A one-line deletion from `lib/index.js` would have left
// the whole feature unregistered with every other assertion still green.
check('registered /__luzzy/goal', routes.has('/__luzzy/goal'))
for (const name of ['agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping']) {
  const installed = listeners.get(name)
  check(`installed the "${name}" hook`, Array.isArray(installed) && installed.length > 0, `count=${installed?.length}`)
}
{
  const names = provided.tools.registered.map((definition) => definition?.name)
  check('registered the goal_delivery tool', names.includes('goal_delivery'), JSON.stringify(names))
  const tool = provided.tools.registered.find((definition) => definition?.name === 'goal_delivery')
  check('and the tool declares its action schema', tool?.parameters?.required?.includes('action') === true, JSON.stringify(tool?.parameters?.required))
}

// Serve them for real.
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = routes.get(url.pathname)
  if (route === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(error))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

async function get(path) {
  const response = await fetch(`${base}${path}`)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: response.status, contentType: response.headers.get('content-type'), text, json }
}

try {
  // ---- readme route
  const readme = await get('/__luzzy/readme')
  check('readme responds 200', readme.status === 200, `got ${readme.status}`)
  check(
    'readme is markdown',
    (readme.contentType ?? '').includes('text/markdown'),
    `got ${readme.contentType}`,
  )
  check('readme has content', readme.text.length > 500, `${readme.text.length} bytes`)
  check('readme looks like our README', readme.text.startsWith('# LuzzyPage'), readme.text.slice(0, 40))

  // ---- usage route. Cold runs happen inside the worker thread, so each unit pays the
  // full read cost once; that is ~20 s per unit on this machine and expected.
  for (const unit of ['day', 'week']) {
    const started = Date.now()
    const usage = await get(`/__luzzy/usage?unit=${unit}`)
    const elapsed = Date.now() - started

    check(`usage ${unit}: 200`, usage.status === 200, `got ${usage.status}`)
    if (usage.json === null) {
      failures.push(`  FAIL usage ${unit}: body was not JSON`)
      continue
    }

    const { totals, buckets, models, sessions, attempts } = usage.json
    check(`usage ${unit}: has totals`, typeof totals === 'object' && totals !== null)
    check(`usage ${unit}: totalTokens > 0`, (totals?.totalTokens ?? 0) > 0, `got ${totals?.totalTokens}`)
    check(`usage ${unit}: buckets non-empty`, Array.isArray(buckets) && buckets.length > 0, `${buckets?.length}`)
    check(`usage ${unit}: models non-empty`, Array.isArray(models) && models.length > 0, `${models?.length}`)
    check(`usage ${unit}: sessions reported`, sessions > 0, `${sessions}`)
    check(`usage ${unit}: attempts reported`, attempts > 0, `${attempts}`)
    notes.push(
      `       ${unit}: ${buckets.length} buckets, ${models.length} models, ` +
        `total=${totals.totalTokens.toLocaleString()}, ${elapsed} ms`,
    )
  }

  // ---- second call must hit the cache and be fast
  const t0 = Date.now()
  await get('/__luzzy/usage?unit=day')
  const cachedMs = Date.now() - t0
  check('cached call is fast (<1000ms)', cachedMs < 1000, `took ${cachedMs} ms`)
  notes.push(`       cached day call: ${cachedMs} ms`)

  // ---- bad unit is rejected, not silently defaulted
  const bad = await get('/__luzzy/usage?unit=fortnight')
  check('bad unit → 400', bad.status === 400, `got ${bad.status}`)

  // ---- wrong method is rejected
  const post = await fetch(`${base}/__luzzy/usage`, { method: 'POST' })
  check('POST → 405', post.status === 405, `got ${post.status}`)
  await post.text()

  // ---- the preset route answers through the REAL plugin, on a context that throws for
  // undeclared services. This is the regression that broke the sub-page in production:
  // `readSnapshot` reached for `ctx.agentPresets` and every request 500'd with
  // `cannot get property "agentPresets" without inject`.
  const preset = await fetch(`${base}/__luzzy/preset?sessionId=probe-session`)
  const presetBody = await preset.text()
  check('GET /__luzzy/preset → 200', preset.status === 200, `got ${preset.status}: ${presetBody.slice(0, 200)}`)
  let presetJson
  try {
    presetJson = JSON.parse(presetBody)
  } catch {
    presetJson = undefined
  }
  check('preset route returned JSON', presetJson !== undefined, presetBody.slice(0, 200))
  check('preset payload carries a revision', typeof presetJson?.revision === 'number', JSON.stringify(presetJson?.revision))
  check('preset payload carries the roster', Array.isArray(presetJson?.agents), typeof presetJson?.agents)
  check(
    'missing session services degrade instead of throwing',
    presetJson?.capabilities?.sessionPresetSwitch === false,
    JSON.stringify(presetJson?.capabilities),
  )

  // ---- RUNTIME ACCEPTANCE: the session gate, through the REAL apply() --------------
  //
  // Every other gate assertion runs against a hand-built ctx in test-goal-enforce.mjs. That
  // proves the gate FUNCTION works; it cannot prove the gate is what `apply()` actually
  // installed, with the real wiring and the real hook order. This block drives the listeners
  // that `apply()` registered, over a real session id and real files, and asks the three
  // questions a user would: does work get held before a goal exists, does a chat get through,
  // and does work get released once the plan can answer "when is it done".
  //
  // The hook is a cordis waterfall: `(exec, next)`. `next()` is the rest of the chain, so
  // driving it with a terminal `{kind:'allow'}` reproduces what the tool layer would see.
  {
    // CORDIS WATERFALL SEMANTICS, which the first draft of this block got wrong.
    //
    // These listeners form a chain: each `next()` runs the rest. A `deny` does NOT stop the
    // chain — the tool layer reads the LAST decision. So driving every listener and keeping
    // the final value is correct, but the earlier draft drove them with `next()` resolving to
    // `{kind:'allow'}`, which meant a later listener's allow overwrote the gate's deny and the
    // probe reported "not held" while the gate had in fact denied.
    //
    // The real chain is the plugin's own two listeners, and the second one (the completion
    // gate) passes non-`update_goal` calls straight through. What the user experiences is the
    // TOOL LAYER's combined view, so this reproduces that: run the chain, and if ANY listener
    // denied, the call is denied.
    const chain = async (name, agent) => {
      const seen = []
      let decision = { kind: 'allow' }
      for (const handler of listeners.get('tools/pre-execute') ?? []) {
        decision = await handler({ name, arguments: {}, agent }, () => Promise.resolve(decision))
        seen.push(decision?.kind)
      }
      const denied = seen.includes('deny')
      return { decision, seen, denied }
    }
    const sessionOf = (id) => ({ id, session: { id, header: { cwd: null }, snapshotEvents: () => [] } })

    // 1. A fresh session with no goal: work is held.
    const held = await chain('write', sessionOf('accept-no-goal'))
    check('acceptance: a write with no goal is held', held.denied, JSON.stringify(held.seen))
    const refusal = (listeners.get('tools/pre-execute') ?? [])
    const firstDecision = await refusal[0](
      { name: 'write', arguments: {}, agent: sessionOf('accept-no-goal-2') },
      () => Promise.resolve({ kind: 'allow' }),
    )
    check('acceptance: and the refusal is the gate one', /GOAL_GATE_REQUIRED/.test(firstDecision?.reason ?? ''), (firstDecision?.reason ?? '').slice(0, 60))

    // A READ is held too (the strict setting), asserted here because this is the only place
    // the REAL chain runs — a fake could disagree with the shipped wiring.
    const heldRead = await chain('read', sessionOf('accept-no-goal'))
    check('acceptance: and so is a read', heldRead.denied, JSON.stringify(heldRead.seen))

    // 2. The exits work through the real chain, or the gate would be unescapable.
    const viaGoal = await chain('goal_delivery', sessionOf('accept-no-goal'))
    check('acceptance: goal_delivery passes', !viaGoal.denied, JSON.stringify(viaGoal.seen))
    const viaAsk = await chain('ask_user_question', sessionOf('accept-no-goal'))
    check('acceptance: ask_user_question passes', !viaAsk.denied, JSON.stringify(viaAsk.seen))

    // 3. The chat exit: declare, then the same write is released.
    const chatAgent = sessionOf('accept-chat')
    // Drive the declaration through the real listener set, so the state it records is the one
    // the shipped code records.
    for (const handler of listeners.get('tools/pre-execute') ?? []) {
      await handler(
        { name: 'goal_delivery', arguments: { action: 'declareNonTask', reason: '用户在打招呼' }, agent: chatAgent },
        () => Promise.resolve({ kind: 'allow' }),
      )
    }
    const afterDeclare = await chain('write', chatAgent)
    check('acceptance: after declaring "not a task", work is released', !afterDeclare.denied, JSON.stringify(afterDeclare.seen))

    notes.push('       acceptance: gate exercised through the real apply() wiring')
  }
} finally {
  server.close()
}

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} assertions (host routes, real HTTP)`)
process.exit(0)
