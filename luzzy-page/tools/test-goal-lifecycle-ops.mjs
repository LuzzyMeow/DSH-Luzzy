/**
 * Assert the console can drive the runtime goal's whole lifecycle.
 *
 * THE DEFECT THIS GUARDS
 *
 * The console shipped with 刷新 / 对齐到当前目标 / 写 goal.md and nothing else — no way to bring
 * a goal into existence. So the ONLY route to starting a goal was DSH's built-in `create_goal`
 * tool, and a user watching the chat reasonably concluded the 目标中心 was decorative. A control
 * plane that cannot create the thing it controls is not a control plane.
 *
 * The failure mode worth guarding is not "the button is missing" — it is a route that LOOKS
 * right and does the wrong thing, because this layer sits on top of a state machine it does not
 * own:
 *
 *   * creating when a goal already exists must be refused (the service's GOAL_ALREADY_EXISTS),
 *     not silently replace it;
 *   * a stale ref must be refused (GOAL_STALE_REVISION) so an hour-old tab cannot roll the goal
 *     back; and
 *   * an empty objective must be refused, because a goal with no objective cannot answer "what
 *     counts as done" — the entire reason this system exists.
 *
 * Run: node tools/test-goal-lifecycle-ops.mjs
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const routes = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-routes.mjs')).href)

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

/**
 * A stand-in for `@deepseek-ai/dsh-goal` that enforces the SAME rules the real one does.
 *
 * This matters more than the happy path. A stub that only ever succeeds cannot catch a caller
 * that ignores a refusal — and `test-preset-routes` learned this the hard way (§5.21: a fake
 * more permissive than the real implementation is a false-green zone). So this refuses on
 * exactly the three conditions the real service refuses on, with the same error codes.
 */
function fakeGoals() {
  const state = { goal: undefined, calls: [] }
  const fail = (message, code) => {
    const error = new Error(message)
    error.code = code
    throw error
  }
  const requireRef = (ref) => {
    if (state.goal === undefined) fail('no current goal', 'GOAL_NOT_FOUND')
    if (ref === null || ref.id !== state.goal.id || ref.revision !== state.goal.revision) {
      fail(`stale goal ref; current is ${state.goal.id} revision ${state.goal.revision}`, 'GOAL_STALE_REVISION')
    }
  }
  return {
    state,
    get: () => state.goal,
    create(_agent, request) {
      state.calls.push(['create', request])
      if (typeof request?.objective !== 'string' || request.objective.trim() === '') {
        fail('goal objective must be non-empty', 'GOAL_INVALID_STATE')
      }
      if (state.goal !== undefined && state.goal.phase !== 'complete') {
        fail(`goal "${state.goal.id}" already exists with phase "${state.goal.phase}"`, 'GOAL_ALREADY_EXISTS')
      }
      state.goal = { id: 'goal-new', revision: 1, objective: request.objective, phase: 'active', maxGoalRounds: 256 }
      return { ...state.goal }
    },
    pause(_agent, ref) {
      state.calls.push(['pause', ref])
      requireRef(ref)
      if (state.goal.phase !== 'active') fail(`cannot pause a ${state.goal.phase} goal`, 'GOAL_INVALID_STATE')
      state.goal = { ...state.goal, revision: state.goal.revision + 1, phase: 'paused' }
      return { ...state.goal }
    },
    resume(_agent, ref) {
      state.calls.push(['resume', ref])
      requireRef(ref)
      if (state.goal.phase === 'complete') fail('a completed goal cannot be resumed', 'GOAL_INVALID_STATE')
      state.goal = { ...state.goal, revision: state.goal.revision + 1, phase: 'active' }
      return { ...state.goal }
    },
    complete(_agent, ref) {
      state.calls.push(['complete', ref])
      requireRef(ref)
      if (state.goal.phase === 'complete') fail('already complete', 'GOAL_INVALID_STATE')
      state.goal = { ...state.goal, revision: state.goal.revision + 1, phase: 'complete' }
      return { ...state.goal }
    },
    clear(_agent, ref) {
      state.calls.push(['clear', ref])
      requireRef(ref)
      const tombstone = { id: state.goal.id, revision: state.goal.revision + 1 }
      state.goal = undefined
      return tombstone
    },
  }
}

const AGENT = { id: 'agent-1', session: { id: 'sess-1' } }

try {
  console.log('goal-lifecycle-ops: create')

  {
    const goals = fakeGoals()
    const result = routes.applyGoalLifecycle(goals, AGENT, null, 'goalCreate', { objective: '把目标中心做出来' })
    eq('create succeeds with an objective', result.ok, true)
    eq('and the service received it', result.goal.objective, '把目标中心做出来')
    eq('and the goal is active', result.goal.phase, 'active')
  }
  {
    const goals = fakeGoals()
    const result = routes.applyGoalLifecycle(goals, AGENT, null, 'goalCreate', { objective: '   ' })
    eq('create REFUSES a blank objective', result.ok, false)
    eq('with a code the page can branch on', result.code, 'GOAL_INVALID_STATE')
    eq('and it never reached the service', goals.state.calls.length, 0)
    check('and the refusal says why in Chinese', /objective/.test(result.error), result.error)
  }
  {
    const goals = fakeGoals()
    goals.state.goal = { id: 'goal-live', revision: 3, objective: '旧目标', phase: 'active', maxGoalRounds: 256 }
    const result = routes.applyGoalLifecycle(goals, AGENT, goals.state.goal, 'goalCreate', { objective: '新目标' })
    eq('creating over a live goal is REFUSED, not a silent replace', result.ok, false)
    eq('and the service code is passed through', result.code, 'GOAL_ALREADY_EXISTS')
    eq('and the live goal is untouched', goals.state.goal.objective, '旧目标')
  }

  console.log('\ngoal-lifecycle-ops: pause / resume / complete')

  {
    const goals = fakeGoals()
    goals.state.goal = { id: 'goal-1', revision: 4, objective: 'A', phase: 'active', maxGoalRounds: 256 }
    const paused = routes.applyGoalLifecycle(goals, AGENT, goals.state.goal, 'goalPause', {})
    eq('pause moves to paused', paused.goal.phase, 'paused')
    // The ref must be the revision the caller READ (4), not the one the service returns (5).
    eq('and it was called with the revision the page read', goals.state.calls[0][1].revision, 4)

    const resumed = routes.applyGoalLifecycle(goals, AGENT, goals.state.goal, 'goalResume', {})
    eq('resume brings it back to active', resumed.goal.phase, 'active')

    const done = routes.applyGoalLifecycle(goals, AGENT, goals.state.goal, 'goalComplete', {})
    eq('complete moves to complete', done.goal.phase, 'complete')
  }
  {
    const goals = fakeGoals()
    goals.state.goal = { id: 'goal-1', revision: 4, objective: 'A', phase: 'complete', maxGoalRounds: 256 }
    const result = routes.applyGoalLifecycle(goals, AGENT, goals.state.goal, 'goalResume', {})
    eq('a COMPLETED goal cannot be resumed', result.ok, false)
    eq('and that is reported as a 422, not a 500', result.status, 422)
  }

  console.log('\ngoal-lifecycle-ops: a stale tab cannot roll the goal back')

  {
    const goals = fakeGoals()
    goals.state.goal = { id: 'goal-1', revision: 9, objective: 'A', phase: 'active', maxGoalRounds: 256 }
    // The page last read revision 5; the goal has since moved to 9. The route reads the live
    // goal itself, so a stale TAB cannot supply a stale ref — this asserts the ref really does
    // come from the live view rather than from the request body.
    const stale = { id: 'goal-1', revision: 5, objective: 'A', phase: 'active', maxGoalRounds: 256 }
    const result = routes.applyGoalLifecycle(goals, AGENT, stale, 'goalPause', {})
    eq('a stale ref is REFUSED', result.ok, false)
    eq('with GOAL_STALE_REVISION', result.code, 'GOAL_STALE_REVISION')
    // 409 so the page reloads instead of retrying the same losing write.
    eq('and as a 409', result.status, 409)
    eq('and the goal did not move', goals.state.goal.phase, 'active')
  }

  console.log('\ngoal-lifecycle-ops: clear, and unknown ops')

  {
    const goals = fakeGoals()
    goals.state.goal = { id: 'goal-1', revision: 2, objective: 'A', phase: 'active', maxGoalRounds: 256 }
    const result = routes.applyGoalLifecycle(goals, AGENT, goals.state.goal, 'goalClear', {})
    eq('clear succeeds', result.ok, true)
    // `clear` returns a tombstone ref, NOT a view — there is no goal afterwards, and pretending
    // otherwise would have the page render a goal that no longer exists.
    eq('and returns a tombstone, not a view', result.goal.cleared.id, 'goal-1')
    eq('and the goal is gone', goals.state.goal, undefined)
  }
  {
    const goals = fakeGoals()
    const result = routes.applyGoalLifecycle(goals, AGENT, null, 'goalNonsense', {})
    eq('an unknown op is refused', result.ok, false)
    eq('as a 400 (a client bug, not a user error)', result.status, 400)
    eq('and nothing was called', goals.state.calls.length, 0)
  }

  console.log('\ngoal-lifecycle-ops: a service bug is a 500, not a refusal')

  {
    // A thrown error with NO code is not a GoalError — it is a real bug, and reporting it as a
    // 422 would make it look like a normal refusal the model should adapt to.
    const goals = {
      create() { throw new TypeError('cannot read properties of undefined') },
    }
    const result = routes.applyGoalLifecycle(goals, AGENT, null, 'goalCreate', { objective: 'A' })
    eq('a codeless throw is a 500', result.status, 500)
    check('and the message is preserved', /cannot read properties/.test(result.error), result.error)
  }
} finally {
  /* nothing to clean up: no files, no processes */
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (goal lifecycle ops)`)
