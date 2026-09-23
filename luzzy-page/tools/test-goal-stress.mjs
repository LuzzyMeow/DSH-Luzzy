/**
 * Stress and lifecycle tests for the goal delivery layer.
 *
 * WHAT THIS COVERS THAT THE OTHER SUITES DO NOT
 *
 * `test-goal-enforce.mjs` drives each hook with a well-formed payload. This suite drives them
 * with the payloads the harness actually produces at its EDGES — a cancelled turn, a step
 * on an aborted signal, a plan whose revision moved under the hook, a hook that runs twice
 * for the same turn, a hostile session. Those are the states the brief's §78 matrix names,
 * and every one of them is a state where a hook can silently do the wrong thing.
 *
 * What it deliberately does NOT claim: context compaction, session resume and fork need a
 * live DSH session and are not covered here. The suite says so rather than implying
 * coverage it does not have — a test that names a scenario it never exercised is worse than
 * no test, because it retires the question.
 *
 * Run: node tools/test-goal-stress.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const enforce = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-enforce.mjs')).href)
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
  id: 'goal-stress', revision: 5, objective: '把 Dashboard 接入 /api/tasks', phase: 'active',
  activation: 'armed', roundsStarted: 2, maxGoalRounds: 256,
}

const tempRoots = []
function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), 'luzzy-goal-stress-'))
  tempRoots.push(home)
  return store.storePaths(home)
}

function fakeCtx(services, declared = ['webServer']) {
  const declaredSet = new Set(declared)
  const base = {
    listeners: new Map(),
    on(name, handler) {
      if (!base.listeners.has(name)) base.listeners.set(name, [])
      // Bare handlers, matching what `fire` below expects. `test-goal-enforce.mjs` wraps
      // them because it also reads `options`; this suite does not need that.
      base.listeners.get(name).push(handler)
      return () => {}
    },
    effect(fn) { fn(); return () => {} },
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

/** The dispatch shapes, inferred by arity exactly as `test-goal-enforce.mjs` does. */
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

function fakeAgent(sessionId, events = [], overrides = {}) {
  const steered = []
  return {
    id: sessionId,
    steered,
    status: 'running',
    session: { id: sessionId, header: { cwd: null }, snapshotEvents: () => events },
    steer(message) { steered.push(message) },
    ...overrides,
  }
}

/** A plan with one open task, so the commit barrier has something to reconcile. */
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

/** Events describing a turn that really wrote a file. */
const WROTE_A_FILE = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'tool/call', data: { callId: 'c1', name: 'write' } },
  { type: 'tool/result', data: { message: { id: 'c1' } } },
]

try {
  console.log('goal-stress: a cancelled turn is never asked to reconcile')

  {
    // The loop calls `throwIfAborted()` right after the barrier dispatch. A steer issued
    // here during cancellation stays in next-step, gets drained later, and burns one of the
    // session's eight reconciliations on a turn the user cancelled.
    const paths = freshPaths()
    const sessionId = 'sess-cancel'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const agent = fakeAgent(sessionId, WROTE_A_FILE)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })

    await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: true } })

    eq('an aborted turn is not steered', agent.steered.length, 0)
    eq('and no reconciliation was spent', enforcement.stats().reconcileOffered, 0)
    check('but the skip is counted', enforcement.stats().reconcileSkipped >= 1)
    enforce.resetCounters()
  }
  {
    // A LIVE signal must still work — the guard must not disable the barrier.
    const paths = freshPaths()
    const sessionId = 'sess-live'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const agent = fakeAgent(sessionId, WROTE_A_FILE)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
    await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
    eq('a live turn is still steered', agent.steered.length, 1)
    enforce.resetCounters()
  }
  {
    // A step on an aborted turn must not be injected into either.
    const paths = freshPaths()
    const sessionId = 'sess-step-abort'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages: [], turn: 1, step: 1, signal: { aborted: true } },
      { kind: 'enter', messages: [] })
    eq('an aborted step is not injected into', decision.messages.length, 0)
    // NOT counted as a miss. `preflightMiss` means "we tried to orient and could not read the
    // state" — a failure worth watching. An aborted step is a deliberate skip, and folding
    // the two together would make the metric unable to tell a broken plan from a cancel.
    eq('and it is not counted as a failure', enforcement.stats().preflightMiss, 0)
    eq('nor as a successful preflight', enforcement.stats().preflight, 0)
    enforce.resetCounters()
  }

  console.log('goal-stress: hostile and degenerate session shapes')

  {
    // A plan file that is a directory, or otherwise unreadable, must not throw out of a hook.
    // A hook that throws during turn-stopping takes the whole turn down.
    //
    // This case found a REAL defect when it was written: `readDeliveryOverlay` used to treat
    // every read failure as `absent` — "you have no plan" — so an unreadable plan was handed
    // to the barrier as an EMPTY one, and the barrier then asked the model to reconcile
    // against a plan it never wrote. It now distinguishes ENOENT (absent) from everything
    // else (unreadable), and this assertion pins that: nothing is steered, because there is
    // no readable plan to reconcile against.
    const paths = freshPaths()
    mkdirSync(join(paths.dir, 'sess-dir.json'), { recursive: true })
    const agent = fakeAgent('sess-dir', WROTE_A_FILE)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
    let threw = null
    try {
      await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
    } catch (error) {
      threw = error
    }
    eq('an unreadable plan never throws out of the barrier', threw, null)
    eq('and nothing is steered against a plan nobody can read', agent.steered.length, 0)
    enforce.resetCounters()
  }
  {
    // A session whose snapshotEvents throws: the barrier must degrade, not propagate.
    const paths = freshPaths()
    const sessionId = 'sess-throwing-events'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const agent = fakeAgent(sessionId)
    agent.session.snapshotEvents = () => { throw new Error('log gone') }
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
    let threw = null
    try {
      await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
    } catch (error) {
      threw = error
    }
    eq('a throwing session read never throws out of the barrier', threw, null)
    eq('and nothing is steered', agent.steered.length, 0)
    enforce.resetCounters()
  }
  {
    // The goal service throws DURING the barrier (replay failure). Same requirement.
    const paths = freshPaths()
    const sessionId = 'sess-goal-throws'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const agent = fakeAgent(sessionId, WROTE_A_FILE)
    const ctx = fakeCtx({ goals: { get: () => { throw new Error('goal replay failed') } } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
    let threw = null
    try {
      await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
    } catch (error) {
      threw = error
    }
    eq('a throwing goal read never throws out of the barrier', threw, null)
    enforce.resetCounters()
  }
  {
    // A delegation to a subagent: `exec.agent` may be absent on tool hooks. The gate must
    // pass the call through rather than crashing on a missing agent.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' } }, { kind: 'allow' })
    eq('an agent-less complete is not gated (it cannot own a plan)', decision.kind, 'allow')
    enforce.resetCounters()
  }

  console.log('goal-stress: repeated and interleaved turns')

  {
    // Two turns in a row each get their own preflight — the per-turn guard must reset on a
    // new turn, or a long session would be oriented exactly once, ever.
    const paths = freshPaths()
    const sessionId = 'sess-two-turns'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent(sessionId)
    const first = await fire(ctx, 'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: {} }, { kind: 'enter', messages: [] })
    const second = await fire(ctx, 'agent/pre-step',
      { agent, messages: [], turn: 2, step: 1, signal: {} }, { kind: 'enter', messages: [] })
    eq('turn 1 is oriented', first.messages.length, 1)
    eq('turn 2 is oriented again', second.messages.length, 1)
    eq('and the counter agrees', enforcement.stats().preflight, 2)
    enforce.resetCounters()
  }
  {
    // Two sessions must not share counters: session A's preflight must not suppress B's.
    const paths = freshPaths()
    store.writeDeliveryOverlay(paths, 'sess-a', workingPlan('sess-a'), 0)
    store.writeDeliveryOverlay(paths, 'sess-b', workingPlan('sess-b'), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const a = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-a'), messages: [], turn: 1, step: 1, signal: {} }, { kind: 'enter', messages: [] })
    const b = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-b'), messages: [], turn: 1, step: 1, signal: {} }, { kind: 'enter', messages: [] })
    eq('session A is oriented', a.messages.length, 1)
    eq('session B is oriented independently', b.messages.length, 1)
    eq('both counted', enforcement.stats().preflight, 2)
    enforce.resetCounters()
  }
  {
    // The per-session reconciliation ceiling holds across MANY turns, not just a few.
    const paths = freshPaths()
    const sessionId = 'sess-ceiling'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0, maxReconciliations: 3 } })
    let steers = 0
    for (let turn = 1; turn <= 30; turn += 1) {
      const agent = fakeAgent(sessionId, WROTE_A_FILE)
      await fire(ctx, 'agent/turn-stopping', { agent, turn, signal: {} })
      steers += agent.steered.length
    }
    eq('the ceiling holds over 30 turns', steers, 3)
    eq('and the offers match the steers', enforcement.stats().reconcileOffered, 3)
    enforce.resetCounters()
  }

  console.log('goal-stress: revision races across the hooks')

  {
    // The plan is rewritten UNDER the barrier between turns. The barrier must read the
    // CURRENT overlay rather than a cached one — otherwise it would ask the model to
    // reconcile against a plan that no longer exists.
    const paths = freshPaths()
    const sessionId = 'sess-race'
    const stale = workingPlan(sessionId)
    store.writeDeliveryOverlay(paths, sessionId, stale, 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
    await fire(ctx, 'agent/turn-stopping', { agent: fakeAgent(sessionId, WROTE_A_FILE), turn: 1, signal: {} })

    // A concurrent writer settles the plan (all criteria verified) before the next turn.
    let settled = store.readDeliveryOverlay(paths, sessionId).delivery
    settled = domain.applyDeliveryOp(settled, 'addEvidence', { summary: 'pnpm test', kind: 'test' }, { at: AT }).delivery
    settled = domain.applyDeliveryOp(settled, 'setAcceptanceStatus', { id: 'AC-001', status: 'verified', evidence: ['E-001'] }, { at: AT }).delivery
    settled = domain.applyDeliveryOp(settled, 'setTaskStatus', { id: 'T-001', status: 'completed' }, { at: AT }).delivery
    store.writeDeliveryOverlay(paths, sessionId, settled, 1)

    const agent2 = fakeAgent(sessionId, WROTE_A_FILE)
    await fire(ctx, 'agent/turn-stopping', { agent: agent2, turn: 2, signal: {} })
    // The plan now has focus and next action still set and nothing outstanding, so the
    // second turn is NOT asked to reconcile — the barrier saw the NEW plan.
    eq('the barrier read the current plan, not a cached one', agent2.steered.length, 0)
    enforce.resetCounters()
  }
  {
    // A stale expected revision is refused rather than silently applied — the CAS contract
    // the route depends on must also hold when the caller is a hook path.
    const paths = freshPaths()
    const sessionId = 'sess-cas'
    store.writeDeliveryOverlay(paths, sessionId, workingPlan(sessionId), 0)
    const first = store.readDeliveryOverlay(paths, sessionId)
    store.writeDeliveryOverlay(paths, sessionId, first.delivery, 1)
    const loser = store.writeDeliveryOverlay(paths, sessionId, { ...first.delivery, focus: 'stale write' }, 1)
    eq('a stale-revision write is refused', loser.ok, false)
    eq('with the stable code', loser.code, domain.ERROR_CODES.STALE_REVISION)
    check('and the current document comes back', loser.current !== undefined)
    eq('the stored focus was not clobbered', store.readDeliveryOverlay(paths, sessionId).delivery.focus, '接入 API')
  }

  console.log('goal-stress: drift and re-alignment (AC-010)')

  {
    // The user edits the goal (a new revision and a rewritten objective) while a plan is in
    // flight. The layer must DETECT it, and the plan must not claim alignment.
    const paths = freshPaths()
    const sessionId = 'sess-drift'
    let plan = workingPlan(sessionId)
    plan = domain.applyDeliveryOp(plan, 'reconcile', { goalId: GOAL.id, goalRevision: GOAL.revision, objective: GOAL.objective }, { at: AT }).delivery
    store.writeDeliveryOverlay(paths, sessionId, plan, 0)

    const edited = { ...GOAL, revision: GOAL.revision + 1, objective: '改成修 Settings 页的 bug' }
    const drift = domain.detectDrift(store.readDeliveryOverlay(paths, sessionId).delivery, edited)
    check('a rewritten objective is detected as drift', drift !== null && drift.fields.includes('objective'), JSON.stringify(drift))
    // The preflight must say the plan is out of step rather than reporting a stale tally as
    // if it were current. It reads the NEW goal, so the objective shown is the new one.
    const text = enforce.renderPreflight(store.readDeliveryOverlay(paths, sessionId).delivery, edited, {})
    check('the orientation shows the CURRENT objective', text.includes('改成修 Settings 页的 bug'), text)
  }
  {
    // Re-aligning to the new revision clears the drift, and the preflight then reflects it.
    const paths = freshPaths()
    const sessionId = 'sess-realign'
    let plan = workingPlan(sessionId)
    plan = domain.applyDeliveryOp(plan, 'reconcile', { goalId: GOAL.id, goalRevision: GOAL.revision, objective: GOAL.objective }, { at: AT }).delivery
    store.writeDeliveryOverlay(paths, sessionId, plan, 0)
    const edited = { ...GOAL, revision: GOAL.revision + 1, objective: '改成修 Settings 页的 bug' }
    const align = domain.applyDeliveryOp(store.readDeliveryOverlay(paths, sessionId).delivery, 'reconcile',
      { goalId: edited.id, goalRevision: edited.revision, objective: edited.objective }, { at: AT })
    eq('re-aligning is accepted', align.error, undefined)
    eq('and the drift is gone', domain.detectDrift(align.delivery, edited), null)
  }

  console.log('goal-stress: the completion gate under a hostile goal service')

  {
    // Fail-closed, exhaustively: every way the read can fail must REFUSE completion rather
    // than allow it. This is the brief's §85 and it is the one invariant where "I could not
    // check" must never mean "go ahead".
    const cases = [
      ['an unreadable plan file', (paths, sessionId) => {
        mkdirSync(join(paths.dir, `${sessionId}.json`), { recursive: true })
      }],
      ['a future-versioned plan file', (paths, sessionId) => {
        mkdirSync(paths.dir, { recursive: true })
        writeFileSync(store.sessionFile(paths, sessionId), JSON.stringify({ version: 99 }), 'utf8')
      }],
      ['a malformed plan file', (paths, sessionId) => {
        mkdirSync(paths.dir, { recursive: true })
        writeFileSync(store.sessionFile(paths, sessionId), 'not json', 'utf8')
      }],
    ]
    for (const [label, prepare] of cases) {
      const paths = freshPaths()
      const sessionId = `sess-failclosed-${label.length}`
      prepare(paths, sessionId)
      const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
      enforce.resetCounters()
      enforce.installEnforcement(ctx, { paths, options: {} })
      const decision = await fire(ctx, 'tools/pre-execute',
        { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent(sessionId) },
        { kind: 'allow' })
      eq(`${label} → completion refused`, decision.kind, 'deny')
      enforce.resetCounters()
    }
  }
  {
    // An empty plan is not "readable and therefore fine": it has no acceptance criteria, so
    // the gate must refuse it too. A missing plan is the most likely shape of a mistake.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent('sess-empty') },
      { kind: 'allow' })
    eq('a plan with no acceptance criteria refuses completion', decision.kind, 'deny')
    check('and the reason says acceptance is missing', /验收标准/.test(decision.reason), decision.reason)
    eq('and it was counted as a rejection', enforcement.stats().completionRejected, 1)
    enforce.resetCounters()
  }

  console.log('goal-stress: explicit non-coverage (stated, not implied)')

  {
    // These are named so the suite cannot be read as covering them. Compaction, resume, fork
    // and unload moved to `test-goal-lifecycle.mjs` once a real Session turned out to be
    // constructible; what remains genuinely needs a mounted round driver.
    const notCovered = ['round-driver integration (AC-012)']
    console.log(`  skip ${notCovered.join(' · ')} — needs a live DSH session with the driver mounted; see STATUS §二十二`)
    check('the gap is stated rather than silently omitted', notCovered.length === 1)
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
console.log(`PASS — ${checks} assertions (goal-stress)`)
