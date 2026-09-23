/**
 * Lifecycle tests against a REAL DSH Session.
 *
 * WHY THIS EXISTS SEPARATELY FROM test-goal-stress.mjs
 *
 * The stress suite drives the hooks with synthetic payloads. That proves the hook logic, but
 * it cannot prove anything about how the layer behaves against the harness's own session
 * object — and the four claims in the brief that were still unverified (§53 compaction, §54
 * resume, §55 fork, plugin unload) are exactly claims about the session boundary.
 *
 * So this suite constructs a real `Session` from `@deepseek-ai/dsh-session`, appends real
 * events to it through the real `append`, and drives the hooks against it. Where a claim
 * cannot be exercised without a running agent loop, the suite says so instead of inventing a
 * stand-in that would pass regardless.
 *
 * WHAT THE CLAIMS ACTUALLY REDUCE TO
 *
 * The overlay is keyed by SESSION ID and nothing else: `luzzy-goal/<sessionId>.json`. No
 * delivery code path reads the transcript except `observeTurn`, which scans the log for the
 * current turn's tool calls. So:
 *
 *   * compaction (§53) — the transcript is rewritten but the session id is not, so the plan
 *     survives; what must be checked is that `observeTurn` still finds turn boundaries in a
 *     log that has been through compaction.
 *   * resume (§54)   — same session id, same file. Survives.
 *   * fork (§55)     — a new session id means a new file, so a fork does NOT inherit a plan.
 *     That is the brief's requirement, and it must be true rather than merely intended.
 *   * unload         — every hook is registered through `ctx.on`, so disposal removes them.
 *
 * Run: node tools/test-goal-lifecycle.mjs
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

const enforce = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'goal-enforce.mjs')).href)
const domain = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'goal-domain.mjs')).href)
const store = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'goal-store.mjs')).href)

/**
 * Load the harness's own `Session` from the DSH installation.
 *
 * The package is not a dependency of this plugin (the plugin is loaded INTO the harness, it
 * does not import from it), so it is resolved from the install path the harness exposes.
 * If it cannot be found the suite reports that rather than silently skipping, because a
 * quietly-skipped lifecycle suite is how "we never tested resume" becomes "resume is fine".
 */
const DSH_APP = 'C:/Program Files/DSH Desktop/resources/app'
function loadSession() {
  const require = createRequire(join(DSH_APP, 'package.json'))
  return require('@deepseek-ai/dsh-session')
}

let Session
let sessionModuleError = null
try {
  sessionModuleError = null
  ;({ Session } = loadSession())
} catch (error) {
  sessionModuleError = error instanceof Error ? error.message : String(error)
}

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
  id: 'goal-lifecycle', revision: 4, objective: '把 Dashboard 接入 /api/tasks', phase: 'active',
  activation: 'armed', roundsStarted: 1, maxGoalRounds: 256,
}

const tempRoots = []
function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), 'luzzy-goal-lifecycle-'))
  tempRoots.push(home)
  return store.storePaths(home)
}

function fakeCtx(services, declared = ['webServer']) {
  const declaredSet = new Set(declared)
  const disposers = []
  const base = {
    listeners: new Map(),
    disposed: false,
    on(name, handler) {
      if (!base.listeners.has(name)) base.listeners.set(name, [])
      base.listeners.get(name).push(handler)
      const off = () => {
        const list = base.listeners.get(name) || []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
      disposers.push(off)
      return off
    },
    effect(fn) {
      const cleanup = fn()
      const off = typeof cleanup === 'function' ? cleanup : () => {}
      disposers.push(off)
      return off
    },
    /** Simulate plugin unload: every registration made through `on`/`effect` is undone. */
    disposeAll() {
      base.disposed = true
      for (const off of disposers.splice(0)) off()
    },
    get(name) { return services[name] },
  }
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property]
      if (typeof property !== 'string') return undefined
      if (declaredSet.has(property) || Object.prototype.hasOwnProperty.call(services, property)) return services[property]
      throw new Error(`cannot get property "${property}" without inject`)
    },
  })
}

async function fire(ctx, name, ...rest) {
  const entries = ctx.listeners.get(name) || []
  if (entries.length === 0) return undefined
  const waterfall = rest.length > 1
  const args = waterfall ? rest.slice(0, -1) : rest
  if (!waterfall) {
    let last
    for (const handler of entries) last = await handler(...args)
    return last
  }
  const downstream = rest[rest.length - 1]
  let index = 0
  const next = async () => {
    if (index >= entries.length) return downstream
    const handler = entries[index]
    index += 1
    return handler(...args, next)
  }
  return next()
}

function workingPlan(sessionId) {
  let delivery = domain.emptyDelivery(sessionId)
  for (const [op, payload] of [
    ['addAcceptance', { description: '三态都有' }],
    ['addTask', { title: '接入 API', status: 'in_progress' }],
    ['setFocus', { focus: '接入 API' }],
    ['setNext', { next: ['跑测试'] }],
  ]) {
    delivery = domain.applyDeliveryOp(delivery, op, payload, { at: AT }).delivery
  }
  return delivery
}

/** An agent wrapping a REAL Session. */
function agentFor(session) {
  const steered = []
  return {
    id: session.id,
    steered,
    status: 'running',
    session,
    steer(message) { steered.push(message) },
  }
}

try {
  if (sessionModuleError !== null) {
    console.log('goal-lifecycle: the harness Session could not be loaded')
    check('the real Session module loads from the DSH install', false, sessionModuleError)
  } else {
    console.log('goal-lifecycle: a real Session carries goal-eligible turns')

    {
      // §53 compaction. The transcript is rewritten; the SESSION ID is not. Because the
      // overlay is keyed by id alone, the plan survives — and the one thing that could
      // break is `observeTurn`, which scans the log for the current turn's tool calls.
      const paths = freshPaths()
      const session = new Session('sess-compaction')
      // A turn that wrote a file, recorded through the real append.
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 1, message: { id: 'c1' } }, { surfaceOp: 'append' })

      const agent = agentFor(session)
      const observed = enforce.observeTurn(agent)
      eq('a real log yields the write as progress', observed.wroteFiles, true)

      // Now the log goes through a real compaction: the harness appends compaction events
      // and a surface replacement that shadows the earlier prefix for DERIVATION. The raw
      // log keeps every event, which is exactly why the scan must still work.
      session.append('compaction/start', {})
      session.append('compaction/summary', { summary: '前文摘要', shadowedSeqs: [0, 1, 2] })
      session.append('compaction/end', {})

      const afterCompaction = enforce.observeTurn(agent)
      eq('turn boundaries are still found after compaction', afterCompaction.wroteFiles, true)
      eq('and the call is still counted', afterCompaction.toolCalls, 1)

      // The overlay itself is untouched by any of this: it never lived in the transcript.
      store.writeDeliveryOverlay(paths, session.id, workingPlan(session.id), 0)
      session.append('compaction/start', {})
      session.append('compaction/end', {})
      const after = store.readDeliveryOverlay(paths, session.id)
      eq('the plan survives compaction', after.ok, true)
      eq('at the same revision', after.revision, 1)
      eq('with its content intact', after.delivery.focus, '接入 API')
    }
    {
      // §54 resume: a resumed session is the SAME session id, so it reads the same file.
      // The claim is that nothing about the restore path can move the plan.
      const paths = freshPaths()
      const session = new Session('sess-resume')
      store.writeDeliveryOverlay(paths, session.id, workingPlan(session.id), 0)
      store.writeDeliveryOverlay(paths, session.id, { ...workingPlan(session.id), focus: '第二次写入' }, 1)

      // The harness resumes by re-materializing the same id with its stored events.
      const restored = new Session(
        'sess-resume',
        session.snapshotEvents(),
        session.header,
        'restored',
        0,
      )
      eq('the restored session keeps its id', restored.id, session.id)
      const read = store.readDeliveryOverlay(paths, restored.id)
      eq('and therefore its plan', read.ok, true)
      eq('at the latest revision', read.revision, 2)
      eq('with the latest content', read.delivery.focus, '第二次写入')
    }
    {
      // §55 fork: the harness gives a fork a NEW session id. A plan must not follow it —
      // the brief is explicit that a fork must not resurrect a goal on its own.
      const paths = freshPaths()
      const parent = new Session('sess-parent')
      store.writeDeliveryOverlay(paths, parent.id, workingPlan(parent.id), 0)
      eq('the parent has a plan', store.readDeliveryOverlay(paths, parent.id).revision, 1)

      const child = new Session(
        'sess-fork-child',
        parent.snapshotEvents(),
        { ...parent.header, id: 'sess-fork-child', parentSession: parent.id, isSeeded: true },
        'restored',
        parent.snapshotEvents().length,
      )
      check('the fork really does get a different id', child.id !== parent.id)
      const childRead = store.readDeliveryOverlay(paths, child.id)
      eq('the fork has NO inherited plan', childRead.revision, 0)
      eq('and reads as absent, not as an error', childRead.source, 'absent')
      // The parent's plan is untouched by the fork.
      eq('the parent keeps its plan', store.readDeliveryOverlay(paths, parent.id).revision, 1)
    }
    {
      // The commit barrier against a real Session, driven end to end.
      const paths = freshPaths()
      const session = new Session('sess-real-barrier')
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 1, message: { id: 'c1' } }, { surfaceOp: 'append' })
      store.writeDeliveryOverlay(paths, session.id, workingPlan(session.id), 0)

      const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
      enforce.resetCounters()
      const enforcement = enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
      const agent = agentFor(session)
      await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
      eq('a real turn that edited a file is asked to reconcile', agent.steered.length, 1)
      eq('and the count agrees', enforcement.stats().reconcileOffered, 1)
      enforce.resetCounters()
    }
    {
      // The preflight against a real Session: it must carry the session id through and
      // inject exactly one message.
      const paths = freshPaths()
      const session = new Session('sess-real-preflight')
      store.writeDeliveryOverlay(paths, session.id, workingPlan(session.id), 0)
      const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
      enforce.resetCounters()
      enforce.installEnforcement(ctx, { paths, options: {} })
      const decision = await fire(ctx, 'agent/pre-step',
        { agent: agentFor(session), messages: [], turn: 1, step: 1, signal: {} },
        { kind: 'enter', messages: [] })
      eq('a real session is oriented', decision.messages.length, 1)
      check('and the block names the real objective', decision.messages[0].content[0].text.includes(GOAL.objective))
      enforce.resetCounters()
    }
    {
      // Plugin unload: every hook was registered through `ctx.on`, so disposal must remove
      // them. The failure this guards is an orphan continuation — hooks firing after unload,
      // steering turns on behalf of a plugin that is no longer loaded.
      const paths = freshPaths()
      const session = new Session('sess-unload')
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 1, message: { id: 'c1' } }, { surfaceOp: 'append' })
      store.writeDeliveryOverlay(paths, session.id, workingPlan(session.id), 0)
      const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
      enforce.resetCounters()
      enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
      eq('four hooks are installed', enforce.HOOK_NAMES.filter((n) => (ctx.listeners.get(n) || []).length > 0).length, 4)

      ctx.disposeAll()
      for (const name of enforce.HOOK_NAMES) {
        eq(`"${name}" has no listener after unload`, (ctx.listeners.get(name) || []).length, 0)
      }

      // And driving the events afterwards must do nothing at all. With every hook removed
      // there is no listener left to build a decision, so `fire` returns undefined — which
      // is itself the strongest form of "nothing happened".
      const agent = agentFor(session)
      await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
      const decision = await fire(ctx, 'agent/pre-step',
        { agent, messages: [], turn: 2, step: 1, signal: {} }, { kind: 'enter', messages: [] })
      eq('no steer after unload', agent.steered.length, 0)
      eq('no listener builds a decision after unload', decision, undefined)
      eq('and nothing is counted', enforce.readCounters(session.id).reconciliations, 0)
      enforce.resetCounters()
    }
    {
      // AC-012, upgraded from a source grep to a RUNTIME fact.
      //
      // The round driver and this layer both listen on `agent/pre-step`, so "no duplicated
      // responsibility" has to be shown in the dispatch chain, not by grepping our source.
      // `dsh-goal-round-driver`'s handler is `isGoalRoundSource(source)` → `next()`. The
      // source predicate is `source.kind === "goal" && source.round > 0`, so a message this
      // layer injects (`kind: 'plugin'`) passes straight through it.
      //
      // This models that handler's contract faithfully — including the pass-through — and
      // asserts the two coexist without either eating the other's message.
      const paths = freshPaths()
      const session = new Session('sess-two-handlers')
      store.writeDeliveryOverlay(paths, session.id, workingPlan(session.id), 0)

      /** The round driver's pre-step contract, reduced to what matters for coexistence. */
      const isGoalRoundSource = (source) => source?.kind === 'goal' && source.round > 0
      const roundDriverStepped = []

      const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
      enforce.resetCounters()
      const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })

      // ORDERING IS THE WHOLE TEST. A cordis waterfall runs listeners in registration order,
      // so the plugin (registered first) is the OUTER handler and the driver sits at its
      // `next()` — the inner one. That is the arrangement in which the plugin can do damage:
      // it receives the driver's verdict as the return of `next()` and must pass it through.
      //
      // (The opposite arrangement — driver outer — never lets the plugin run at all during a
      // goal round, so nothing could go wrong and nothing would be tested. The first version
      // of this block got that backwards and asserted something vacuously true.)
      const roundDriver = async ({ messages }, next) => {
        const submitted = messages.find((message) => isGoalRoundSource(message.source))
        if (submitted === undefined) return next()
        roundDriverStepped.push(submitted)
        // A valid reservation would proceed; this stand-in has none, so it rejects — and the
        // plugin must not paint over that.
        return { kind: 'reject' }
      }
      ctx.listeners.get('agent/pre-step').push(roundDriver)

      // The terminal value: what the chain returns when nobody rejects.
      const terminal = { kind: 'enter', messages: [] }

      // --- Case 1: an ordinary step. The driver passes through; the plugin orients. ---
      const ordinary = await fire(ctx, 'agent/pre-step',
        { agent: agentFor(session), messages: [], turn: 1, step: 1, signal: {} }, terminal)
      eq('the driver did not step in for an ordinary turn', roundDriverStepped.length, 0)
      eq('and the plugin still oriented', ordinary.messages.length, 1)
      eq('with a plugin-sourced message', ordinary.messages[0].source.kind, 'plugin')
      check('which the driver would ignore', !isGoalRoundSource(ordinary.messages[0].source))

      // --- Case 2: a goal-round message. The driver owns it and rejects; the plugin ran
      // BEFORE it (outer) and MUST pass that verdict through untouched. ---
      const roundMessage = {
        id: 'round-1',
        role: 'user',
        content: [{ type: 'text', text: '继续' }],
        source: { kind: 'goal', goalId: GOAL.id, revision: GOAL.revision, round: 3 },
      }
      const before = enforcement.stats().preflight
      const roundDecision = await fire(ctx, 'agent/pre-step',
        { agent: agentFor(session), messages: [roundMessage], turn: 2, step: 1, signal: {} }, terminal)
      eq('the driver DID claim the goal-round message', roundDriverStepped.length, 1)
      eq('and its verdict survives the plugin', roundDecision.kind, 'reject')
      // The real assertion: the plugin did not convert the rejection into an injection.
      eq('the rejection carries no injected messages', roundDecision.messages, undefined)
      eq('and the plugin did not spend a preflight on it', enforcement.stats().preflight, before)
      enforce.resetCounters()
    }
    {
      // The same claim from the other side: this layer's messages carry a source the round
      // driver ignores, and this layer never produces a `goal`-source message. Asserted on
      // the real emitted source objects rather than on the source text.
      const paths = freshPaths()
      const session = new Session('sess-source-kinds')
      store.writeDeliveryOverlay(paths, session.id, workingPlan(session.id), 0)
      const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
      enforce.resetCounters()
      enforce.installEnforcement(ctx, { paths, options: {} })
      const oriented = await fire(ctx, 'agent/pre-step',
        { agent: agentFor(session), messages: [], turn: 1, step: 1, signal: {} },
        { kind: 'enter', messages: [] })
      const steered = agentFor(session)
      await fire(ctx, 'agent/turn-stopping',
        { agent: { ...steered, session }, turn: 1, signal: {} })

      const emitted = [oriented.messages[0].source]
      for (const source of emitted) {
        eq(`the emitted source kind is not "goal"`, source.kind === 'goal', false)
        eq('it is plugin', source.kind, 'plugin')
      }
      check('the layer emitted exactly one pre-step message', oriented.messages.length === 1)
      enforce.resetCounters()
    }
    {
      // AC-012: the delivery layer must not duplicate the round driver's job. The driver
      // decides WHETHER to continue by queueing follow-ups; this layer must never do that.
      // Asserted against the source rather than by running a driver, because the claim is
      // about what the layer CAN do, and a runtime test could only ever show one path.
      const { readFileSync } = await import('node:fs')
      const sources = ['goal-enforce.mjs', 'goal-routes.mjs', 'goal-tools.mjs', 'goal-store.mjs', 'goal-domain.mjs']
        .map((name) => readFileSync(join(PLUGIN_ROOT, 'lib', name), 'utf8'))
        .join('\n')
      check('the delivery layer never calls followup', !/\.followup\s*\(/.test(sources))
      check('and never calls runMaintenance', !/\.runMaintenance\s*\(/.test(sources))
      check('and never appends goal-round messages itself', !/source:\s*\{\s*kind:\s*'goal'/.test(sources))
      // It DOES steer — that is its job (the commit barrier) — and the distinction is the
      // point: steering keeps the current turn working, followup starts a new one.
      check('but it does steer, which is its own job', /\.steer\s*\(/.test(sources))
    }
  }
} finally {
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
console.log(`PASS — ${checks} assertions (goal-lifecycle)`)
