/**
 * Assert that a plan gets BOUND to its runtime goal without the model having to remember.
 *
 * WHY THIS SUITE EXISTS
 *
 * Found in a real session: 205 plan changes in, `goalId` and `goalRevision` were still null
 * and `reconcile` had never once been called by hand. The console drew that plan as the
 * projection of the live goal for hours, and nothing had ever verified that it was — because
 * both guards that exist to catch exactly this were written to skip on a null id:
 *
 *   integrity()    step 11 compared ids only when `delivery.goalId !== null`
 *   detectDrift()  compared only when the mirror fields were non-null
 *
 * An unbound plan was therefore EXEMPT from drift detection. The fix has two halves and this
 * suite covers both:
 *
 *   1. `commitOp` fills the binding from the live goal on the first plan write (structural —
 *      the harness holds both halves, so the join is not a judgement the model should make).
 *   2. A plan with content and no binding is REPORTED rather than ignored, so the state can
 *      never again be silent. That half lives in test-goal-domain.mjs.
 *
 * The negative controls matter as much as the positive ones: an empty plan must stay quiet
 * (otherwise every goal is born in drift and the label means nothing), and an EXISTING
 * binding must never be overwritten (silently re-pointing a plan at a different goal is the
 * drift a user is supposed to be asked about).
 *
 * Run: node tools/test-goal-binding.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const enforce = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-enforce.mjs')).href)
const store = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-store.mjs')).href)
const domain = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-domain.mjs')).href)

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
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const AT = 1_700_000_000_000
const SESSION = 'sess-bind'
const GOAL = {
  id: 'goal-bind-1',
  revision: 4,
  objective: '把控制台的观感换成 reference 那一套',
  phase: 'active',
  activation: 'armed',
  roundsStarted: 1,
  maxGoalRounds: 256,
}

const roots = []
function freshPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'luzzy-bind-'))
  roots.push(dir)
  return store.storePaths(dir)
}
const agent = { id: 'agent-1', session: { id: SESSION } }

/** A ctx whose goal service answers, in the shape cordis gives (`ctx.get`, never `ctx.x`). */
function fakeCtx(services) {
  return {
    get: (name) => services[name],
    on: () => {},
    effect: (fn) => fn(),
  }
}

try {
  console.log('goal-binding: the first plan write binds itself to the live goal')

  {
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL }, agents: { get: () => agent } })
    store.writeDeliveryOverlay(paths, SESSION, domain.emptyDelivery(SESSION), 0)

    const result = enforce.commitOp(
      { paths, sessionId: SESSION, ctx, agent },
      'addAcceptance',
      { description: '暖纸底色对得上' },
      { actor: 'agent' },
    )
    eq('the write succeeded', result.ok, true)

    const read = store.readDeliveryOverlay(paths, SESSION)
    eq('goalId was filled in without the model asking', read.delivery.goalId, GOAL.id)
    eq('and the revision it was bound at', read.delivery.goalRevision, GOAL.revision)
    eq('and the objective mirror, which is what makes an EDIT detectable', read.delivery.objectiveMirror, GOAL.objective)

    check('the binding is recorded in the change log',
      read.delivery.changes.some((c) => c.action === 'reconcile'),
      JSON.stringify(read.delivery.changes.map((c) => c.action)))
    check('and it is credited to the harness, not to the model',
      read.delivery.changes.find((c) => c.action === 'reconcile')?.actor === 'system',
      JSON.stringify(read.delivery.changes.find((c) => c.action === 'reconcile')))

    // The point of binding: the guards now have an opinion.
    eq('drift detection is no longer blind', domain.detectDrift(read.delivery, GOAL), null)
    eq('and integrity passes', domain.integrity(read.delivery, GOAL).errors.length, 0)

    // ...and they can still fail, which is what makes the line above mean something.
    const edited = { ...GOAL, objective: '换成完全不同的目标', revision: 5 }
    const drift = domain.detectDrift(read.delivery, edited)
    check('a rewritten objective IS now detected', drift !== null && drift.fields.includes('objective'), JSON.stringify(drift))
  }

  console.log('goal-binding: a SECOND write does not re-bind (that would hide real drift)')

  {
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL }, agents: { get: () => agent } })
    store.writeDeliveryOverlay(paths, SESSION, domain.emptyDelivery(SESSION), 0)

    enforce.commitOp({ paths, sessionId: SESSION, ctx, agent }, 'addAcceptance', { description: 'A' }, { actor: 'agent' })
    const afterFirst = store.readDeliveryOverlay(paths, SESSION).delivery

    // The goal moves to a different identity. The plan must KEEP pointing at the old one, so
    // that the mismatch is visible and the user gets asked — not silently adopted.
    const other = { ...GOAL, id: 'goal-bind-OTHER', revision: 9 }
    enforce.commitOp(
      { paths, sessionId: SESSION, ctx: fakeCtx({ goals: { get: () => other }, agents: { get: () => agent } }), agent },
      'addTask',
      { title: 'B' },
      { actor: 'agent' },
    )
    const afterSecond = store.readDeliveryOverlay(paths, SESSION).delivery

    eq('the binding still points at the original goal', afterSecond.goalId, GOAL.id)
    eq('and the revision was not silently adopted either', afterSecond.goalRevision, afterFirst.goalRevision)
    const report = domain.integrity(afterSecond, other)
    check('so the mismatch IS reported', report.errors.some((e) => e.code === domain.ERROR_CODES.DRIFT_DETECTED),
      JSON.stringify(report.errors))
  }

  console.log('goal-binding: refusing to bind when the session is not loaded')

  {
    const paths = freshPaths()
    // No agent and no registry entry: the runtime goal genuinely cannot be read. Writing a
    // plan is still correct (it is the user's data) — but the binding must stay null and say
    // why, rather than inventing an identity.
    const ctx = fakeCtx({ goals: { get: () => GOAL }, agents: { get: () => undefined } })
    store.writeDeliveryOverlay(paths, SESSION, domain.emptyDelivery(SESSION), 0)
    enforce.commitOp({ paths, sessionId: SESSION, ctx }, 'addAcceptance', { description: 'A' }, { actor: 'agent' })

    const read = store.readDeliveryOverlay(paths, SESSION)
    eq('the plan was still written', read.delivery.acceptance.length, 1)
    eq('but it is honestly unbound', read.delivery.goalId, null)
    check('and it says why', typeof read.delivery.unboundReason === 'string' && read.delivery.unboundReason.includes('未在本进程加载'),
      String(read.delivery.unboundReason))
    // Unbound WITH content is no longer silent — this is the half that catches the real case.
    const drift = domain.detectDrift(read.delivery, GOAL)
    check('and the unbound state is now visible rather than silent', drift !== null, JSON.stringify(drift))
  }

  console.log('goal-binding: an untouched plan is still allowed to have no opinion')

  {
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL }, agents: { get: () => agent } })
    const empty = domain.emptyDelivery(SESSION)
    store.writeDeliveryOverlay(paths, SESSION, empty, 0)
    const read = store.readDeliveryOverlay(paths, SESSION)

    eq('an empty plan is not in drift', domain.detectDrift(read.delivery, GOAL), null)
    eq('and is healthy, not alarming', domain.health(read.delivery, GOAL), 'healthy')
    eq('and integrity is quiet', domain.integrity(read.delivery, GOAL).errors.length, 0)
  }

  console.log('goal-binding: a structural error is not filed as missing evidence')

  {
    // `completionGate` used to have `if (code === MISSING_EVIDENCE) push(missing) else
    // push(missing)` — both branches identical, so EVERY structural error was reported as a
    // missing-evidence gap. An unbound plan therefore produced "Missing Evidence: goal: 交付
    // 计划还没有绑定…", a false statement that sends the reader hunting for evidence.
    //
    // The fixture carries NO evidence gap on purpose (a verified criterion WITH evidence), so
    // the only thing left to report is the structural one. An earlier version of this case had
    // a criterion with no evidence at all, which put a genuine gap in `missingEvidence` and
    // made the "not filed as missing evidence" assertion fail for the wrong reason.
    const unbound = domain.emptyDelivery('s')
    unbound.acceptance.push({
      id: 'AC-001', description: 'A', status: 'verified', mandatory: true,
      evidence: ['E-001'], verifiedAt: AT,
    })
    unbound.evidence.push({ id: 'E-001', summary: 'npm test', kind: 'test', detail: '', ref: '', acceptance: ['AC-001'], at: AT })
    unbound.changes.push({ id: 'C-001', at: AT, actor: 'agent', action: 'x', detail: '' })

    const gate = domain.completionGate(unbound, GOAL)
    eq('the gate refuses', gate.allowed, false)
    check('the plan problem is named as structural', gate.structural.length > 0, JSON.stringify(gate.structural))
    eq('and NOT as missing evidence', gate.missingEvidence.length, 0)
    eq('with the INVALID_STATE code, not MISSING_EVIDENCE', gate.code, domain.ERROR_CODES.INVALID_STATE)
    const text = domain.renderCompletionRefusal(gate)
    check('and the refusal text says Plan Problem, not Missing Evidence',
      /Plan Problem/.test(text) && !/Missing Evidence/.test(text), text)
  }
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (goal-binding)`)
