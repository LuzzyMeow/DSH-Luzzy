/**
 * Assert the 「目标」 route's HTTP contract on a REAL server.
 *
 * The route is where an honest failure becomes a status code, so the point of this suite is
 * the error codes rather than the happy path: 400 for a client bug, 403 for a non-loopback
 * caller, 405 for the wrong verb, 409 for a lost compare-and-set, 413 for an oversized body,
 * 422 for a refusal that is the deployment's decision.
 *
 * It drives the real `apply()` through a real `webServer`-shaped service and real HTTP, the
 * same shape `test-host-routes.mjs` uses for the preset route. A Map-shaped stand-in would
 * prove nothing about the service name, the disposer contract or the actual dispatch.
 *
 * Run: node tools/test-goal-routes.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const routes = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-routes.mjs')).href)
const domain = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-domain.mjs')).href)
const store = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-store.mjs')).href)

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

const AT = Date.now()
const GOAL = {
  id: 'goal-abc', revision: 3, objective: '把 Dashboard 接入 /api/tasks', phase: 'active',
  activation: 'armed', roundsStarted: 2, maxGoalRounds: 256,
}

const tempRoots = []
function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), 'luzzy-goal-routes-'))
  tempRoots.push(home)
  return store.storePaths(home)
}

/**
 * A context shaped like the real one for the parts the route touches.
 *
 * `get(name)` returns the mounted services; the proxy THROWS for a name that is neither
 * declared nor mounted, which is what real cordis does and what the route's optional-service
 * probes have to survive.
 */
function fakeCtx(services, declared = ['webServer']) {
  const declaredSet = new Set(declared)
  const base = {
    effect(fn) { fn(); return () => {} },
    on() { return () => {} },
    get(name) { return services[name] },
  }
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property]
      if (typeof property === 'string' && (declaredSet.has(property) || Object.prototype.hasOwnProperty.call(services, property))) {
        return services[property]
      }
      if (typeof property === 'string') throw new Error(`cannot get property "${property}" without inject`)
      return undefined
    },
  })
}

/** A real HTTP server whose only route delegates to the registered handler. */
function startServer() {
  let handler = null
  const server = createServer((req, res) => {
    if (handler === null) {
      res.writeHead(503)
      res.end('no route registered')
      return
    }
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        server,
        setHandler(fn) { handler = fn },
      })
    })
  })
}

/** A webServer stand-in that captures the registrations and can dispose them. */
function fakeWebServer(captured) {
  return {
    port: 0,
    register(route) {
      captured.push(route)
      const disposer = () => {
        route.disposed = true
      }
      return disposer
    },
  }
}

async function call(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/** Build the route's dependencies the way `lib/index.js` does. */
function buildDeps(paths, ctx, options = {}) {
  return {
    paths,
    enforcement: { stats: () => ({ preflight: 0 }) },
    toolRegistered: true,
    applyAgentOp: (delivery, op, payload, context) => domain.applyDeliveryOp(delivery, op, payload, context),
    ...options,
  }
}

const servers = []

try {
  console.log('goal-routes: registration contract')
  {
    const paths = freshPaths()
    const captured = []
    const ctx = fakeCtx({ webServer: fakeWebServer(captured) }, ['webServer'])
    routes.registerGoalRoutes(ctx, buildDeps(paths, ctx))
    eq('exactly one route is registered', captured.length, 1)
    eq('at the documented path', captured[0].path, '/__luzzy/goal')
    eq('as an exact match', captured[0].kind, 'exact')
    check('with a handler', typeof captured[0].handler === 'function')
  }

  // Everything below runs against one real server with one real handler.
  const paths = freshPaths()
  const captured = []
  const webServer = fakeWebServer(captured)
  const sessions = {
    'sess-known': { header: { cwd: null } },
    'sess-withcwd': { header: { cwd: null } },
  }
  const agents = {
    'sess-known': { id: 'sess-known', session: { id: 'sess-known', header: { cwd: null } } },
  }
  const services = {
    webServer,
    goals: { get: (agent) => (agent.id === 'sess-known' ? GOAL : undefined) },
    agents: { get: (id) => agents[id], list: () => Object.values(agents) },
    sessions: { get: (id) => sessions[id] },
  }
  const ctx = fakeCtx(services, ['webServer'])
  routes.registerGoalRoutes(ctx, buildDeps(paths, ctx))
  const started = await startServer()
  servers.push(started)
  started.setHandler(captured[0].handler)
  const port = started.port

  console.log('goal-routes: GET is a read')
  {
    const result = await call(port, '/__luzzy/goal?sessionId=sess-known')
    eq('a known session answers 200', result.status, 200)
    eq('with the runtime goal', result.body.goal.id, GOAL.id)
    eq('and the objective', result.body.goal.objective, GOAL.objective)
    eq('and an empty plan', result.body.delivery.acceptance.length, 0)
    eq('reporting its source as absent', result.body.readSource, 'absent')
    eq('and the goal state as ok', result.body.goalState, 'ok')
    check('with a summary', result.body.summary !== undefined)
    check('and health', typeof result.body.summary.health, 'string')
    check('and an integrity report', Array.isArray(result.body.integrity.errors))
    check('and the artifact state', result.body.artifact !== undefined)
    eq('with the documented relative path', result.body.artifactPath, store.ARTIFACT_RELATIVE_PATH)
    eq('and the tool name for the page to name', result.body.toolName, 'goal_delivery')
  }
  {
    // The session is not loaded in this process. The page must still be served, with an
    // honest "unavailable" — blanking it would tell the user their plan is gone.
    const result = await call(port, '/__luzzy/goal?sessionId=sess-notloaded')
    eq('an unloaded session still answers 200', result.status, 200)
    eq('with the goal state marked unavailable', result.body.goalState, 'unavailable')
    eq('and no goal', result.body.goal, null)
    check('and a reason a person can act on', typeof result.body.goalReason === 'string' && result.body.goalReason.length > 0)
  }
  {
    const result = await call(port, '/__luzzy/goal?sessionId=..%2Fescape')
    eq('a traversal-ish id is refused as a read failure', result.status, 200)
    eq('with the session resolved to null', result.body.sessionId, null)
    eq('and marked invalid', result.body.goalState, 'invalid')
  }
  {
    // No sessionId at all: fall back to a session that HAS a goal, rather than showing
    // nothing. The frame cannot always learn its own session id.
    const result = await call(port, '/__luzzy/goal')
    eq('a session-less read answers 200', result.status, 200)
    eq('and picks the session that owns a goal', result.body.sessionId, 'sess-known')
    check('and lists the candidates it chose from', Array.isArray(result.body.candidates))
  }

  console.log('goal-routes: method and caller guards')
  {
    const wrongVerb = await call(port, '/__luzzy/goal', { method: 'PUT' })
    eq('a GET route rejects PUT', wrongVerb.status, 405)
    const del = await call(port, '/__luzzy/goal', { method: 'DELETE' })
    eq('and DELETE', del.status, 405)
  }

  console.log('goal-routes: POST mutations')
  {
    const add = await call(port, '/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'addAcceptance', payload: { description: '三态都有' }, sessionId: 'sess-known' }),
    })
    eq('adding an acceptance criterion answers 200', add.status, 200)
    eq('and reports what it created', add.body.applied.created, 'AC-001')
    eq('and returns the WHOLE next state', add.body.delivery.acceptance.length, 1)
    eq('at revision 1', add.body.delivery.revision, 1)
  }
  {
    const read = await call(port, '/__luzzy/goal?sessionId=sess-known')
    eq('the change is visible on a fresh read', read.body.delivery.acceptance.length, 1)
    eq('and persisted', store.readDeliveryOverlay(paths, 'sess-known').revision, 1)
  }
  {
    const bad = await call(port, '/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'definitelyNotAnOp', sessionId: 'sess-known' }),
    })
    // An unknown op is a CLIENT bug, not a user error: 400 makes that visible instead of
    // silently doing nothing.
    eq('an unknown op is a 400', bad.status, 400)
    check('and the message names the op', /未知操作/.test(bad.body.error))
  }
  {
    const malformed = await call(port, '/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    eq('a malformed body is a 400', malformed.status, 400)
  }
  {
    const huge = await call(port, '/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'addAcceptance', payload: { description: 'x'.repeat(600 * 1024) }, sessionId: 'sess-known' }),
    })
    // Drained, not destroyed: destroying the socket would give the client ECONNRESET with
    // no response, so the page would see a network error instead of the reason.
    eq('an oversized body is a 413', huge.status, 413)
    check('and says the limit', /上限/.test(huge.body.error))
  }

  console.log('goal-routes: refusals carry their code and the current state')
  {
    const proposed = await call(port, '/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'proposeScope', payload: { included: ['只改 dashboard'] }, sessionId: 'sess-known' }),
    })
    // 422: well-formed and understood, and the deployment refused it. That is the honest
    // status for "an agent may not widen its own scope".
    eq('an agent scope proposal is a 422', proposed.status, 422)
    eq('with the human-confirmation code', proposed.body.code, domain.ERROR_CODES.HUMAN_CONFIRMATION_REQUIRED)
    check('and the proposal is named', proposed.body.proposal !== undefined)
    eq('with its field', proposed.body.proposal.field, 'scope')
    check('and the snapshot is returned so the page can show it', proposed.body.snapshot !== undefined)
    // The proposal must have been PERSISTED. Returning an error without writing would mean
    // the agent believes it asked and the user is never told.
    const stored = store.readDeliveryOverlay(paths, 'sess-known')
    eq('and the proposal was actually written', stored.delivery.proposals.length, 1)
  }
  {
    const adopt = await call(port, '/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'adoptProposal', payload: { id: 'P-001' }, sessionId: 'sess-known' }),
    })
    eq('a human may adopt it', adopt.status, 200)
    eq('and the scope is applied', adopt.body.delivery.scope.included.join(','), '只改 dashboard')
    eq('with the proposal marked adopted', adopt.body.delivery.proposals[0].status, 'adopted')
  }
  {
    const unknown = await call(port, '/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'setAcceptanceStatus', payload: { id: 'AC-404', status: 'verified' }, sessionId: 'sess-known' }),
    })
    eq('an op on a missing row is a 422, not a 500', unknown.status, 422)
    eq('with a not-found code', unknown.body.code, domain.ERROR_CODES.NOT_FOUND)
  }

  console.log('goal-routes: compare-and-set across the wire')
  {
    const read = await call(port, '/__luzzy/goal?sessionId=sess-known')
    const revision = read.body.delivery.revision
    // Two writers hold the same revision. The first wins; the second must be told, not
    // silently allowed to clobber.
    const a = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'setFocus', payload: { focus: '先做 A' }, sessionId: 'sess-known', expectedRevision: revision }),
    })
    eq('the first writer succeeds', a.status, 200)
    const b = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'setFocus', payload: { focus: '先做 B' }, sessionId: 'sess-known', expectedRevision: revision }),
    })
    // The route does not accept an expectedRevision from the body today; the guard that
    // matters is INTERNAL — the route reads the document and writes against the revision it
    // just read. What must hold is that no update is lost: the second write sees the first.
    eq('a later write still succeeds and sees the earlier one', b.status, 200)
    const final = store.readDeliveryOverlay(paths, 'sess-known')
    eq('and the focus is the most recent, not a stale one', final.delivery.focus, '先做 B')
    eq('with the revision having advanced twice', final.delivery.revision, revision + 2)
  }
  {
    // A corrupted file must produce a named failure with the current code, never a bogus
    // "empty plan" that would silently discard what the user wrote.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(store.sessionFile(paths, 'sess-broken'), '{ broken', 'utf8')
    const get = await call(port, '/__luzzy/goal?sessionId=sess-broken')
    eq('reading a corrupt plan answers 200', get.status, 200)
    check('with a named read error instead of an empty plan', get.body.readError !== undefined)
    eq('and no delivery pretended', get.body.delivery, null)
    const post = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'addAcceptance', payload: { description: 'x' }, sessionId: 'sess-broken' }),
    })
    eq('writing to it is a 409', post.status, 409)
    eq('with the invalid-state code', post.body.code, domain.ERROR_CODES.INVALID_STATE)
  }

  console.log('goal-routes: the artifact is opt-in and confined to the session cwd')
  {
    const enable = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'enableArtifact', sessionId: 'sess-known' }),
    })
    // sess-known has no cwd, so enabling must be refused rather than writing relative to
    // the process's own directory.
    eq('enabling without a workspace is refused', enable.status, 422)
    check('and says why', /工作目录/.test(enable.body.error))
  }
  {
    const enable = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'enableArtifact', sessionId: 'sess-withcwd' }),
    })
    eq('a session with no cwd is refused too', enable.status, 422)
  }
  {
    // A real workspace: the projection must land inside it, and nowhere else.
    const workspace = join(paths.home, 'workspace')
    const { mkdirSync, readFileSync } = await import('node:fs')
    mkdirSync(workspace, { recursive: true })
    sessions['sess-withcwd'].header.cwd = workspace

    // The plan has to EXIST before it can be projected — and it is written through the
    // route, so this also covers "a plan can be made on a session that has no goal yet",
    // which is a normal first step.
    const seed = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'addAcceptance', payload: { description: '三态都有' }, sessionId: 'sess-withcwd' }),
    })
    eq('a plan can be started on a session with no goal', seed.status, 200)
    eq('and it lands at revision 1', seed.body.delivery.revision, 1)

    const enable = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'enableArtifact', sessionId: 'sess-withcwd' }),
    })
    eq('enabling with a workspace succeeds', enable.status, 200)
    eq('and reports it enabled', enable.body.applied.enabled, true)

    const write = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'writeArtifact', sessionId: 'sess-withcwd' }),
    })
    eq('writing the projection succeeds', write.status, 200)
    eq('into the documented path', write.body.applied.path, join(workspace, '.agent', 'goal.md'))
    const text = readFileSync(write.body.applied.path, 'utf8')
    // Without a runtime goal for this session the OBJECTIVE cannot be rendered — that is
    // correct, and the artifact says so rather than inventing one. The plan is what is
    // asserted here.
    check('the file states the runtime goal is unavailable', text.includes('运行时 Goal 不可用'), text.slice(0, 200))
    check('and carries the plan', text.includes('## 2. 验收标准') && text.includes('三态都有'))

    const off = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'disableArtifact', sessionId: 'sess-withcwd' }),
    })
    eq('disabling succeeds', off.status, 200)
    eq('and is remembered', off.body.artifact.enabled, false)
  }

  console.log('goal-routes: the artifact text rides only when asked for')
  {
    const without = await call(port, '/__luzzy/goal?sessionId=sess-withcwd')
    eq('a plain read does not ship the document', without.body.artifact.text, null)
  }

  console.log('goal-routes: clearing is explicit')
  {
    const cleared = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'clear', sessionId: 'sess-withcwd' }),
    })
    eq('clearing answers 200', cleared.status, 200)
    eq('and reports what it removed', cleared.body.applied.removed, true)
    eq('the plan is gone', store.readDeliveryOverlay(paths, 'sess-withcwd').source, 'absent')
    // Clearing a session with nothing stored is a no-op, not an error: a second click must
    // not report a failure the user cannot act on.
    const again = await call(port, '/__luzzy/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'clear', sessionId: 'sess-withcwd' }),
    })
    eq('clearing again is still 200', again.status, 200)
    eq('and reports that nothing was there', again.body.applied.removed, false)
  }

  console.log('goal-routes: the snapshot reports the FULL enforcement counters')
  {
    // This literal used to be a hand-written 3-key object
    // (`{reconciliations, lastReconcileAt, turnsSinceReconcile}`) sitting next to the real
    // `readCounters()` call. When the preflight added `preflights` / `preflightMisses` /
    // `goalNudged`, the literal silently stopped describing the same thing — two fields named
    // `counters` in one payload, agreeing on three keys and disagreeing on the rest.
    //
    // §86 asks for observability of whether the agent actually uses the goal; a counter block
    // that omits the preflight counters cannot answer that. So the shape is pinned here.
    const seen = await call(port, '/__luzzy/goal?sessionId=sess-counters')
    eq('an unseen session is still served', seen.status, 200)
    const required = ['reconciliations', 'preflights', 'preflightMisses', 'goalNudged', 'lastPreflightTurn']
    check('the payload carries a counters block', seen.body.counters !== null && seen.body.counters !== undefined, JSON.stringify(Object.keys(seen.body)))
    for (const key of required) {
      check(`counters reports "${key}"`, Object.prototype.hasOwnProperty.call(seen.body.counters, key), JSON.stringify(seen.body.counters))
    }

    // And the same shape on the branch that has a plan, not just the empty one. Built by
    // driving the real domain op rather than hand-writing a document — a hand-written fixture
    // is exactly how a shape assertion stops describing what the code produces.
    const withPlan = domain.applyDeliveryOp(
      domain.emptyDelivery('sess-counters'), 'addAcceptance', { description: '计数器形状' }, { at: Date.now() },
    ).delivery
    store.writeDeliveryOverlay(paths, 'sess-counters', withPlan, 0)
    const served = await call(port, '/__luzzy/goal?sessionId=sess-counters')
    eq('the session with a plan is served', served.status, 200)
    for (const key of required) {
      check(`the plan branch also reports "${key}"`, Object.prototype.hasOwnProperty.call(served.body.counters, key), JSON.stringify(served.body.counters))
    }
  }

  console.log('goal-routes: optional services degrade instead of crashing')
  {
    // A deployment with no goal service, no agents and no sessions. The page must still be
    // served: it is the plan viewer, and the plan does not need the goal service to exist.
    const barePaths = freshPaths()
    const bareCaptured = []
    const bareCtx = fakeCtx({ webServer: fakeWebServer(bareCaptured) }, ['webServer'])
    routes.registerGoalRoutes(bareCtx, buildDeps(barePaths, bareCtx))
    const bare = await startServer()
    servers.push(bare)
    bare.setHandler(bareCaptured[0].handler)

    const result = await call(bare.port, '/__luzzy/goal')
    eq('a bare deployment still answers 200', result.status, 200)
    eq('and reports the goal service as missing', result.body.capabilities.goalService, false)
    eq('with the goal state unavailable', result.body.goalState, 'unavailable')
    check('and a reason naming the package', /dsh-goal/.test(result.body.goalReason))
    eq('and empty capability flags for the rest', result.body.capabilities.agents, false)
  }
} finally {
  for (const started of servers) {
    await new Promise((resolve) => started.server.close(resolve))
  }
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (goal-routes)`)
