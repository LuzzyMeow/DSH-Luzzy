/**
 * Assert the enforcement hooks: the completion gate, the `get_goal` augmentation, and the
 * bounded commit barrier.
 *
 * These are the parts that make the plan more than a viewer, so the tests drive the REAL
 * handlers — registered through a stand-in context, then invoked with the exact argument
 * shapes `dsh-tools` and `dsh-agent-loop` pass.
 *
 * WHY THE STAND-IN THROWS
 *
 * The context proxy real cordis installs THROWS for any service name the calling fiber did
 * not declare in `inject`:
 *
 *     cannot get property "goals" without inject
 *
 * and the throw happens while the expression is being evaluated, so `ctx.goals?.get` cannot
 * guard it. A plain object stand-in cannot reproduce that, and a stand-in that is more
 * permissive than the real system is a blind spot that passes while production 500s. So the
 * proxy below throws the same message for the same reason. (This exact mistake once took a
 * whole sub-page down on a real machine while four suites were green.)
 *
 * Run: node tools/test-goal-enforce.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const enforce = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-enforce.mjs')).href)
const domain = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-domain.mjs')).href)
const store = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-store.mjs')).href)
const rosterMod = await import(pathToFileURL(join(HERE, '..', 'lib', 'skill-roster.mjs')).href)

/**
 * The harness's OWN session validator, so message shape is checked against the real rule
 * rather than a restatement of it.
 *
 * This matters more than it looks. Every injected message this plugin produces becomes a
 * durable `user/message` event, and the harness validates ALL of them when it loads the log.
 * A stand-in that merely checks "is there an id field" would agree with whatever this plugin
 * believes the shape is — which is precisely how three sessions ended up unloadable. Using
 * `adoptSessionEvent` means the test fails the moment the real rule and this plugin diverge.
 *
 * Skips (rather than fails) when the DSH checkout is absent, matching how the other suites
 * treat installation paths: a missing app is not a defect in this plugin.
 */
const DSH_APP = process.env.DSH_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app'
let adoptSessionEvent = null
try {
  const session = await import(
    pathToFileURL(join(DSH_APP, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href
  )
  adoptSessionEvent = session.adoptSessionEvent
} catch {
  // Left null; the section below reports the skip explicitly instead of quietly passing.
}

/**
 * Validate one injected message the way the harness does when loading a stored log.
 *
 * @param {object} message - the message as injected.
 * @returns {string|null} the harness's rejection reason, or null when it is accepted.
 */
function storedMessageRejection(message) {
  if (adoptSessionEvent === null) return null
  try {
    // Mirrors `Session.append` for a surface user message, and clones because the harness
    // freezes what it accepts.
    adoptSessionEvent({ type: 'user/message', seq: 1, time: Date.now(), data: structuredClone(message), surfaceOp: 'append' })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
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
  id: 'goal-abc', revision: 3, objective: '把 Dashboard 接入 /api/tasks', phase: 'active',
  activation: 'armed', roundsStarted: 2, maxGoalRounds: 256,
}

const tempRoots = []
function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), 'luzzy-goal-enforce-'))
  tempRoots.push(home)
  return store.storePaths(home)
}

/**
 * A cordis-shaped context stand-in: declared services resolve, undeclared ones THROW.
 *
 * @param {object} services - the services mounted for this test.
 * @param {string[]} declared - names the plugin declared in `inject`.
 */
function fakeCtx(services, declared = ['webServer']) {
  const listeners = new Map()
  const registeredTools = []
  const declaredSet = new Set(declared)
  const ctx = {
    listeners,
    registeredTools,
    on(name, handler, options) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push({ handler, options })
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    get(name) {
      return services[name]
    },
  }
  // The proxy is what actually reproduces cordis: `ctx.<name>` for an undeclared property
  // throws rather than returning undefined.
  return new Proxy(ctx, {
    get(target, property) {
      if (property in target) return target[property]
      if (typeof property !== 'string') return undefined
      if (declaredSet.has(property)) return services[property]
      if (Object.prototype.hasOwnProperty.call(services, property)) {
        throw new Error(`cannot get property "${property}" without inject`)
      }
      throw new Error(`cannot get property "${property}" without inject`)
    },
  })
}

/**
 * Invoke the registered listeners for one event, like the real dispatch does.
 *
 * Two shapes are needed, and they are genuinely different:
 *
 *   * waterfall (`tools/pre-execute`, `tools/post-execute`, `agent/pre-step`) — the handler
 *     receives a `next` thunk as its LAST argument and returns a decision. Downstream
 *     listeners are reached only if a handler calls `next()`, so the harness below passes a
 *     `next` that runs the remaining listeners.
 *   * plain serial (`agent/turn-stopping`) — the handler receives the payload only, and its
 *     return value is discarded by the caller.
 *
 * The dispatch shape is inferred from how many arguments the call site passes, which is
 * unambiguous because each event has a fixed arity:
 *
 *   1 argument  → plain serial (`agent/turn-stopping`). The handler gets the payload and
 *                 its return value is discarded, exactly as the loop discards it.
 *   2 arguments → one-argument waterfall (`tools/pre-execute`): handler(exec, next), the
 *                 second argument being what the innermost `next()` resolves to.
 *   3 arguments → two-argument waterfall (`tools/post-execute`): handler(exec, result, next).
 *                 This one genuinely differs — `post-execute` receives the tool's result as
 *                 well — and getting it wrong passes `next` where `result` belongs, which
 *                 surfaces as "next is not a function" from inside the handler.
 *
 * @param {object} ctx - the stand-in context.
 * @param {string} name - event name.
 * @param {...any} rest - handler arguments, plus the innermost `next()` value when the
 *   event is a waterfall.
 * @returns {Promise<any>} the outermost listener's return value.
 */
async function fire(ctx, name, ...rest) {
  const entries = ctx.listeners.get(name) || []
  if (entries.length === 0) return undefined

  const waterfall = rest.length > 1
  const args = waterfall ? rest.slice(0, -1) : rest
  if (!waterfall) {
    let last
    for (const entry of entries) last = await entry.handler(...args)
    return last
  }

  const downstream = rest[rest.length - 1]
  let index = 0
  const next = async () => {
    if (index >= entries.length) return downstream
    const entry = entries[index]
    index += 1
    return entry.handler(...args, next)
  }
  return next()
}

/** A plan with one verified criterion, so the gate can be driven both ways. */
function verifiedPlan(sessionId) {
  let delivery = domain.emptyDelivery(sessionId)
  for (const [op, payload] of [
    ['addAcceptance', { description: 'loading / empty / error 三态都有' }],
    ['addEvidence', { summary: 'pnpm test passed', kind: 'test', acceptance: ['AC-001'] }],
    ['setAcceptanceStatus', { id: 'AC-001', status: 'verified' }],
    ['reconcile', { goalId: GOAL.id, goalRevision: GOAL.revision }],
  ]) {
    delivery = domain.applyDeliveryOp(delivery, op, payload, { at: AT }).delivery
  }
  return delivery
}

/** An agent stand-in with the public surface the enforcement actually reads. */
function fakeAgent(sessionId, events = []) {
  const steered = []
  return {
    id: sessionId,
    steered,
    status: 'running',
    session: {
      id: sessionId,
      header: { cwd: null },
      snapshotEvents: () => events,
    },
    steer(message) { steered.push(message) },
  }
}

try {
  console.log('goal-enforce: the service probe survives a throwing context')
  {
    const ctx = fakeCtx({}, ['webServer'])
    // The whole reason `service()` exists: a bare `ctx.goals` would throw here.
    let threw = null
    try {
      void ctx.goals
    } catch (error) {
      threw = error
    }
    check('the stand-in really does throw for an undeclared service', threw !== null, 'the proxy is too permissive')
    eq('service() returns undefined instead of throwing', enforce.service(ctx, 'goals'), undefined)
    const resolved = enforce.liveGoalFor(ctx, fakeAgent('s1'))
    eq('liveGoalFor reports the service as unavailable', resolved.state, 'unavailable')
    check('and names the missing package', /dsh-goal/.test(resolved.reason))
  }
  {
    const goals = { get: () => GOAL }
    const ctx = fakeCtx({ goals }, ['webServer'])
    const resolved = enforce.liveGoalFor(ctx, fakeAgent('s1'))
    eq('a mounted goal service resolves', resolved.state, 'ok')
    eq('and returns the view', resolved.goal.id, GOAL.id)
  }
  {
    // A goal read that throws is a READ FAILURE, not "no goal". Collapsing them would let
    // the page say "you have no goal" when the truth is "we could not look".
    const goals = { get: () => { throw new Error('goal replay failed at session event 41') } }
    const ctx = fakeCtx({ goals }, ['webServer'])
    const resolved = enforce.liveGoalFor(ctx, fakeAgent('s1'))
    eq('a throwing read is reported as unavailable', resolved.state, 'unavailable')
    check('and carries the real reason', /replay failed/.test(resolved.reason))
  }

  console.log('goal-enforce: preflight orients the model without dumping the artifact')

  /** A plan with the fields a preflight block reads. */
  function orientablePlan(sessionId) {
    let delivery = domain.emptyDelivery(sessionId)
    for (const [op, payload] of [
      ['addAcceptance', { description: 'loading / empty / error 三态都有' }],
      ['addTask', { title: '接入 /api/tasks' }],
      ['setFocus', { focus: '完成 API 接入并验证三态' }],
      ['setNext', { next: ['接入 /api/tasks', '运行测试'] }],
      ['reconcile', { goalId: GOAL.id, goalRevision: GOAL.revision }],
    ]) {
      delivery = domain.applyDeliveryOp(delivery, op, payload, { at: AT }).delivery
    }
    return delivery
  }

  {
    const paths = freshPaths()
    const sessionId = 'sess-preflight'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })

    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })

    eq('the step still enters', decision.kind, 'enter')
    eq('and exactly one message was appended', decision.messages.length, 1)
    const injected = decision.messages[0]
    const text = injected.content[0].text
    check('the block is marked as goal state', text.startsWith('<goal_state>') && text.endsWith('</goal_state>'))
    check('it carries the objective', text.includes(GOAL.objective))
    check('it carries the acceptance tally', /验收标准：0\/1/.test(text), text)
    check('it carries the current focus', text.includes('完成 API 接入并验证三态'))
    check('it carries the next action', text.includes('接入 /api/tasks'))
    check('it states whether completion would pass', text.includes('完成门：现在还不能标记完成'))
    check('it names the tool that writes the plan', text.includes('goal_delivery'))
    // Attribution: a plugin message must never be stamped as the user.
    eq('it is attributed to the plugin, never the user', injected.source.kind, 'plugin')
    eq('with the plugin name', injected.source.plugin, 'dsh-luzzy-page')
    // §82/§83: orientation is a COMPACT block, never the artifact.
    const bytes = Buffer.byteLength(text, 'utf8')
    check(`the block stays compact (${bytes} bytes)`, bytes < 900, `${bytes} bytes`)
    check('and it is NOT the markdown artifact', !text.includes('## 1. 预期目标') && !text.includes('## 13. 变更记录'))
    eq('the preflight was counted', enforcement.stats().preflight, 1)
    enforce.resetCounters()
  }
  {
    // WHERE the notice lands, not just that it exists.
    //
    // The block used to be appended to the tail. The core's own context injector
    // (`dsh-agent-instructions`) inserts AFTER THE LAST CLAIMED MESSAGE instead, so the
    // orientation reads as context for *this* user message and anything the loop appended
    // afterwards keeps its place. Every other assertion in this file fires with empty
    // `messages` arrays, so position was simply untested — the change could have been a no-op
    // or a tail append and everything else would still pass.
    const paths = freshPaths()
    const sessionId = 'sess-preflight-position'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })

    // A turn where the loop has ALREADY appended something after the claimed user message.
    // This is the shape the core's findLastIndex logic exists to handle.
    const claimed = { role: 'user', content: '把这个项目改造成……', id: 'claimed-1' }
    const appendedByLoop = { role: 'user', content: '（循环自己追加的）', id: 'appended-1' }
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages: [claimed], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [claimed, appendedByLoop] })

    eq('the step enters', decision.kind, 'enter')
    eq('three messages now (claimed + injected + appended)', decision.messages.length, 3)
    // The decisive assertion: the notice is index 1 — right after the claimed message — and the
    // loop's own message moved to the end.
    //
    // 标记变了：状态链现在是同一条 notice 的**开头**。合成一条是有意的 —— 一段步里插三条
    // notice，模型读到的就是三段互不相干的独白；合成一条读到的才是「这一轮的处境」。所以这里
    // 断的不是「开头是 goal_state」，而是「开头是链、链里带着目标块、而且只有一条」。
    const injectedText = String(decision.messages[1]?.content?.[0]?.text ?? '')
    check('the notice sits directly after the claimed message', injectedText.startsWith('<state_chain>'))
    check('the goal block rides in the SAME notice', injectedText.includes('<goal_state>'))
    // 我们自己的注入靠 `source.kind === 'plugin'` 认（它带 id，所以不能用「没有 id」当特征 ——
    // 那是这条断言的第一版，报了个假失败）。
    eq('and it is ONE notice, not two', decision.messages.filter((m) => m.source?.kind === 'plugin').length, 1)
    eq('the loop\'s own message keeps its content', decision.messages[2]?.id, 'appended-1')
    eq('and the claimed message is untouched at the front', decision.messages[0]?.id, 'claimed-1')
    // Negative control inside the same test: a tail append would put the notice at index 2.
    check('it is NOT at the tail', !String(decision.messages[2]?.content?.[0]?.text ?? '').startsWith('<state_chain>'),
      JSON.stringify(decision.messages.map((m) => m.id ?? 'notice')))
    enforce.resetCounters()
  }
  {
    // A synthetic turn with nothing claimed must still get the notice — degraded to the tail
    // rather than dropped. An orientation that never arrives is worse than a late one.
    const paths = freshPaths()
    const sessionId = 'sess-preflight-noclaim'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })

    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })

    eq('a turn with nothing claimed still gets the notice', decision.messages.length, 1)
    check('and it is the goal block', decision.messages[0].content[0].text.startsWith('<goal_state>'))
    enforce.resetCounters()
  }
  {
    // §13: a trivial turn still READS. There is no "skip because nothing happened" branch —
    // the control is the step interval, not a judgement about the user's request.
    const paths = freshPaths()
    const sessionId = 'sess-trivial'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId, []), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    eq('a turn that has produced nothing is still oriented', decision.messages.length, 1)
    eq('and counted', enforcement.stats().preflight, 1)
    enforce.resetCounters()
  }
  {
    // The step interval is the token control: a long turn must not re-inject every step.
    const paths = freshPaths()
    const sessionId = 'sess-interval'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { preflightEverySteps: 6 } })
    const agent = fakeAgent(sessionId)
    let injections = 0
    for (let step = 1; step <= 12; step += 1) {
      const decision = await fire(ctx, 'agent/pre-step',
        { agent, messages: [], turn: 1, step, signal: {} },
        { kind: 'enter', messages: [] })
      injections += decision.messages.length
    }
    check(`a 12-step turn injects a bounded number of times (${injections})`, injections >= 1 && injections <= 3, `injections=${injections}`)
    check('and not once per step', injections < 12)
    enforce.resetCounters()
  }
  {
    // No live goal → nothing to orient. §6 forbids creating a goal for ordinary requests,
    // and injecting "you have no goal" into every conversation is pure noise.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-nogoal'), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    eq('a session with no goal is not oriented', decision.messages.length, 0)
    eq('and the miss is counted', enforcement.stats().preflightMiss, 1)
    enforce.resetCounters()
  }
  {
    // An unreadable plan is a MISS, not a refusal: the gate is the fail-closed surface, and
    // blocking a step the model could otherwise work in would be the wrong trade.
    const paths = freshPaths()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(store.sessionFile(paths, 'sess-broken-pre'), '{ broken', 'utf8')
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-broken-pre'), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    eq('an unreadable plan does not block the step', decision.kind, 'enter')
    eq('and nothing is injected', decision.messages.length, 0)
    eq('but the miss is recorded', enforcement.stats().preflightMiss, 1)
    enforce.resetCounters()
  }
  {
    // A downstream listener already rejected the step: injecting into a rejected decision
    // would be incoherent, and the brief's pre-step contract has no messages on `reject`.
    const paths = freshPaths()
    const sessionId = 'sess-reject'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'reject' })
    eq('a rejected step is passed through unchanged', decision.kind, 'reject')
    eq('with nothing injected', decision.messages, undefined)
    enforce.resetCounters()
  }
  {
    // The injected block must survive a real round trip through the JSON the session log
    // stores: a message carrying a non-serializable value fails at the append site.
    const paths = freshPaths()
    const sessionId = 'sess-serial'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    const roundTripped = JSON.parse(JSON.stringify(decision.messages[0]))
    eq('the message survives JSON serialization', roundTripped.content[0].text, decision.messages[0].content[0].text)
    eq('and keeps its source', roundTripped.source.kind, 'plugin')
    enforce.resetCounters()
  }
  {
    // With the preflight off, no listener is installed at all.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { preflight: false } })
    eq('with the preflight off nothing is installed', (ctx.listeners.get('agent/pre-step') || []).length, 0)
    enforce.resetCounters()
  }
  {
    // The renderer itself, driven directly: a goal with everything verified must say so.
    const ready = verifiedPlan('sess-ready')
    const text = enforce.renderPreflight(ready, GOAL, { artifactPath: '.agent/goal.md' })
    check('a satisfied plan reports completion is possible', text.includes('可以调用 update_goal(action=complete)'), text)
    check('and points at the artifact only as a pointer', text.includes('完整计划（需要时再读）：.agent/goal.md'))
  }
  {
    // No acceptance criteria: the block must say that FIRST, because it is the thing that
    // makes "done" undecidable.
    const bare = domain.emptyDelivery('sess-bare')
    const text = enforce.renderPreflight(bare, GOAL, {})
    check('an undefined acceptance set is called out', text.includes('还没有定义'), text)
    check('and the gate refuses', text.includes('不能标记完成'))
  }
  {
    // Open blockers and pending proposals must both reach the block — they change what the
    // model should do next, which is the whole test for whether a line belongs here.
    let plan = orientablePlan('sess-attn')
    plan = domain.applyDeliveryOp(plan, 'addBlocker', { code: 'awaiting-api', message: '等确认空数据返回码' }, { at: AT }).delivery
    plan = domain.applyDeliveryOp(plan, 'proposeScope', { included: ['dashboard'] }, { at: AT }).delivery
    const text = enforce.renderPreflight(plan, GOAL, {})
    check('an open blocker is named', text.includes('awaiting-api'))
    check('a pending proposal warns against self-approval', text.includes('不要自己改目标或范围'))
  }

  console.log('goal-enforce: a long task with no goal gets nudged, a chat does not (AC-001)')

  /** A real event log describing a turn that wrote a file. */
  const WROTE = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId: 'c1', name: 'write' } },
    { type: 'tool/result', data: { message: { id: 'c1' } } },
  ]
  /** A real event log describing a turn that only read things. */
  const READ_ONLY = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    { type: 'tool/result', data: { message: { id: 'c1' } } },
  ]

  {
    // The nudge does NOT create a goal. §6 forbids that for ordinary requests, and the
    // harness cannot tell a refactor from "帮我解释一下 Promise" — only the model can.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-nudge', WROTE), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    eq('real work with no goal is nudged', decision.messages.length, 1)
    const text = decision.messages[0].content[0].text
    check('the nudge names create_goal', text.includes('create_goal'))
    check('and asks for acceptance criteria', text.includes('验收标准'))
    check('and explicitly permits ignoring it', text.includes('忽略这条'))
    // The distinction that matters: it reports an OBSERVATION, it does not assert intent.
    check('it reports what was observed', text.includes('工具调用'))
    eq('it is attributed to the plugin', decision.messages[0].source.kind, 'plugin')
    eq('and counted', enforcement.stats().goalNudged, 1)
    enforce.resetCounters()
  }
  {
    // THE most important assertion here: an ordinary conversation must not be nudged into
    // creating a goal. §6 names this failure directly.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-chat', READ_ONLY), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    eq('a read-only turn is never nudged', decision.messages.length, 0)
    eq('and nothing is counted', enforcement.stats().goalNudged, 0)
    enforce.resetCounters()
  }
  {
    // A turn that has not called any tool yet (the very first step of a conversation) must
    // not be nudged either — there is nothing observed to report.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-empty', []), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    eq('a turn with no tool calls is never nudged', decision.messages.length, 0)
    enforce.resetCounters()
  }
  {
    // Once per session. A nudge that repeats every step is the token waste §83 warns about,
    // and a model that declined the first one has its reasons.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent('sess-once', WROTE)
    let nudges = 0
    for (let turn = 1; turn <= 8; turn += 1) {
      const decision = await fire(ctx, 'agent/pre-step',
        { agent, messages: [], turn, step: 1, signal: {} }, { kind: 'enter', messages: [] })
      nudges += decision.messages.length
    }
    eq('eight turns produce exactly one nudge', nudges, 1)
    eq('and the counter agrees', enforcement.stats().goalNudged, 1)
    enforce.resetCounters()
  }
  {
    // A session that DOES have a goal must never be nudged — it is already oriented.
    const paths = freshPaths()
    const sessionId = 'sess-has-goal'
    store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId, WROTE), messages: [], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [] })
    eq('a session with a goal is oriented, not nudged', decision.messages.length, 1)
    check('and the message is the goal state, not the hint', decision.messages[0].content[0].text.startsWith('<goal_state>'))
    eq('no nudge counted', enforcement.stats().goalNudged, 0)
    enforce.resetCounters()
  }
  {
    // With the preflight off the nudge is off too — it is part of the same layer.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { preflight: false } })
    eq('preflight off means no listeners at all', (ctx.listeners.get('agent/pre-step') || []).length, 0)
    enforce.resetCounters()
  }
  {
    // The renderer itself, driven directly.
    const text = enforce.renderGoalNudge({ toolCalls: 7 })
    check('the nudge reports the real tool count', text.includes('7'))
    check('and is a hint, not an order', !/你必须|立即/.test(text))
  }

  console.log('goal-enforce: every injected message carries an identity the harness accepts')
  {
    // REGRESSION GUARD for a real, shipped defect: the three injected messages were hand-written
    // object literals with no `id`. The harness mints ids only inside `createUserMessage()`, so
    // nothing caught it at runtime — the log was written happily and then refused at LOAD time:
    //
    //   stored session "…" is corrupt: session event at seq N lacks an identified message
    //
    // One id-less event makes the WHOLE session unreadable, so this was not a cosmetic gap: it
    // silently cost 130 events across three sessions, and every later turn of those sessions
    // with them. The assertion below therefore runs on the REAL validator, and drives all three
    // injection sites rather than the helper, because the defect was exactly "a site forgot".
    if (adoptSessionEvent === null) {
      console.log(`  skip the harness validator is unavailable at ${DSH_APP}`)
    } else {
      check('the harness validator is wired up', typeof adoptSessionEvent === 'function')

      /** Assert one injected message is identified and accepted by the harness's own rule. */
      const accepted = (label, message) => {
        check(`${label}: carries a non-empty id`, typeof message.id === 'string' && message.id !== '')
        const rejection = storedMessageRejection(message)
        check(`${label}: the harness accepts it as a stored event`, rejection === null, rejection ?? '')
      }

      // Site 1 — the goal-state orientation block (`agent/pre-step`).
      {
        const paths = freshPaths()
        const sessionId = 'sess-ident-preflight'
        store.writeDeliveryOverlay(paths, sessionId, orientablePlan(sessionId), 0)
        const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
        enforce.resetCounters()
        enforce.installEnforcement(ctx, { paths, options: {} })
        const decision = await fire(ctx, 'agent/pre-step',
          { agent: fakeAgent(sessionId), messages: [], turn: 1, step: 1, signal: {} },
          { kind: 'enter', messages: [] })
        eq('the preflight injected one message', decision.messages.length, 1)
        accepted('goal state', decision.messages[0])
        enforce.resetCounters()
      }

      // Site 2 — the no-goal nudge (`agent/pre-step`, different branch).
      {
        const paths = freshPaths()
        const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
        enforce.resetCounters()
        enforce.installEnforcement(ctx, { paths, options: {} })
        const decision = await fire(ctx, 'agent/pre-step',
          { agent: fakeAgent('sess-ident-nudge', WROTE), messages: [], turn: 1, step: 1, signal: {} },
          { kind: 'enter', messages: [] })
        eq('the nudge injected one message', decision.messages.length, 1)
        accepted('goal hint', decision.messages[0])
        enforce.resetCounters()
      }

      // Site 3 — the reconciliation steer (`agent/turn-stopping`).
      {
        const paths = freshPaths()
        const sessionId = 'sess-ident-steer'
        // A plan that genuinely requires reconciliation: an `in_progress` task is one of
        // `needsReconciliation`'s reasons, so the barrier actually fires. A plan that needed
        // nothing would leave `steered` empty and assert nothing.
        let plan = domain.emptyDelivery(sessionId)
        plan = domain.applyDeliveryOp(plan, 'addAcceptance', { description: '三态都有' }, { at: AT }).delivery
        plan = domain.applyDeliveryOp(plan, 'addTask', { title: '接 API' }, { at: AT }).delivery
        plan = domain.applyDeliveryOp(plan, 'setTaskStatus', { id: 'T-001', status: 'in_progress' }, { at: AT }).delivery
        store.writeDeliveryOverlay(paths, sessionId, plan, 0)
        const agent = fakeAgent(sessionId, WROTE)
        const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
        enforce.resetCounters()
        enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
        await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
        eq('the barrier steered once', agent.steered.length, 1)
        accepted('reconciliation request', agent.steered[0])
      }

      // Two messages from the same site must not share an identity — the inbox rejects
      // duplicates by id, so a fixed id would trade a load failure for a runtime crash.
      {
        const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
        const paths = freshPaths()
        enforce.resetCounters()
        enforce.installEnforcement(ctx, { paths, options: {} })
        const first = await fire(ctx, 'agent/pre-step',
          { agent: fakeAgent('sess-ident-a', WROTE), messages: [], turn: 1, step: 1, signal: {} },
          { kind: 'enter', messages: [] })
        const second = await fire(ctx, 'agent/pre-step',
          { agent: fakeAgent('sess-ident-b', WROTE), messages: [], turn: 1, step: 1, signal: {} },
          { kind: 'enter', messages: [] })
        check('two injected messages have different ids', first.messages[0].id !== second.messages[0].id)
        enforce.resetCounters()
      }

      // Negative control: the guard must actually be able to fail. Without this, a validator
      // that accepted everything would make every assertion above vacuous.
      {
        const idless = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'dsh-luzzy-page', form: 'notice', summary: 's' } }
        const rejection = storedMessageRejection(idless)
        check('the guard rejects an id-less message (negative control)', rejection !== null, 'the validator accepted a message with no id')
        check('and names the real reason', rejection !== null && /lacks an identified message/.test(rejection), String(rejection))
      }
    }
  }

  console.log('goal-enforce: a refusal names WHY (evidence coverage, §86/§87)')

  {
    // "Completion was refused" and "completion was refused because evidence was missing" are
    // different facts with different fixes — one is work in progress, the other is a process
    // gap. §86/§87 name evidence coverage as one of the five things worth watching, so the
    // counter has to distinguish them rather than lumping every refusal together.
    const paths = freshPaths()
    const sessionId = 'sess-evidence'
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })

    // A plan whose only criterion is unverified: refused, but NOT for missing evidence.
    let plan = domain.emptyDelivery(sessionId)
    plan = domain.applyDeliveryOp(plan, 'addAcceptance', { description: '还没有验证' }, { at: AT }).delivery
    store.writeDeliveryOverlay(paths, sessionId, plan, 0)
    await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent(sessionId) },
      { kind: 'allow' })
    eq('an unverified criterion is refused', enforcement.stats().completionRejected, 1)
    eq('but it is not counted as missing evidence', enforcement.stats().evidenceMissing, 0)
    enforce.resetCounters()
  }
  {
    // Now the shape that IS a process gap: the criterion is marked verified but carries no
    // evidence. The domain refuses that mutation outright (GOAL_MISSING_EVIDENCE), so the
    // state can only be reached by writing the document directly — which is exactly why the
    // gate must ALSO check it rather than trusting the mutation path.
    const paths = freshPaths()
    const sessionId = 'sess-no-evidence'
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })

    const plan = domain.emptyDelivery(sessionId)
    plan.acceptance.push({ id: 'AC-001', description: '声称已验证', status: 'verified', mandatory: true, evidence: [], verifiedAt: AT })
    store.writeDeliveryOverlay(paths, sessionId, plan, 0)

    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent(sessionId) },
      { kind: 'allow' })
    eq('a verified-without-evidence criterion still refuses completion', decision.kind, 'deny')
    eq('and it IS counted as missing evidence', enforcement.stats().evidenceMissing, 1)
    eq('alongside the refusal', enforcement.stats().completionRejected, 1)
    check('the refusal names the criterion', decision.reason.includes('AC-001'), decision.reason)
    enforce.resetCounters()
  }
  {
    // A satisfied plan increments neither counter.
    const paths = freshPaths()
    const sessionId = 'sess-satisfied'
    store.writeDeliveryOverlay(paths, sessionId, verifiedPlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent(sessionId) },
      { kind: 'allow' })
    eq('a satisfied plan is allowed', decision.kind, 'allow')
    eq('and accepted', enforcement.stats().completionAccepted, 1)
    eq('with no refusal counted', enforcement.stats().completionRejected, 0)
    eq('and no evidence gap', enforcement.stats().evidenceMissing, 0)
    enforce.resetCounters()
  }
  {
    // §87's point: the counters are the answer to "is the agent actually using the goal".
    // Assert the whole set exists, so a future metric cannot be silently dropped.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const observed = enforcement.stats()
    const required = [
      'preflight', 'preflightMiss', 'reconcileOffered', 'reconcileSkipped', 'goalNudged',
      'completionRejected', 'completionAccepted', 'evidenceMissing', 'revisionConflict', 'driftDetected',
    ]
    for (const key of required) {
      check(`stats exposes "${key}"`, Object.prototype.hasOwnProperty.call(observed, key), JSON.stringify(observed))
    }
    enforce.resetCounters()
  }

  console.log('goal-enforce: the completion gate blocks the CALL, not just the report')
  {
    const paths = freshPaths()
    const sessionId = 'sess-refuse'
    // A plan that is NOT finished: one criterion, no evidence, still pending.
    let plan = domain.emptyDelivery(sessionId)
    plan = domain.applyDeliveryOp(plan, 'addAcceptance', { description: '三态都有' }, { at: AT }).delivery
    plan = domain.applyDeliveryOp(plan, 'addTask', { title: '接 API' }, { at: AT }).delivery
    store.writeDeliveryOverlay(paths, sessionId, plan, 0)

    const agent = fakeAgent(sessionId)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })

    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete', goal_id: GOAL.id, revision: GOAL.revision }, agent }, { kind: 'allow' })

    eq('a premature complete is DENIED', decision.kind, 'deny')
    check('and the reason names the code', decision.reason.includes('GOAL_COMPLETION_REJECTED'), decision.reason)
    check('and lists the unverified criterion', decision.reason.includes('AC-001'))
    check('and lists the remaining work', decision.reason.includes('T-001'))
    check('and tells the model what to do next', /补齐之后再次调用/.test(decision.reason))
  }
  {
    const paths = freshPaths()
    const sessionId = 'sess-allow'
    store.writeDeliveryOverlay(paths, sessionId, verifiedPlan(sessionId), 0)
    const agent = fakeAgent(sessionId)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })

    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete', goal_id: GOAL.id, revision: GOAL.revision }, agent }, { kind: 'allow' })

    eq('a satisfied goal is allowed through', decision.kind, 'allow')
    eq('and the gate counted the acceptance', enforcement.stats().completionAccepted, 1)
  }
  {
    // Every other action must pass untouched. A gate that also blocked `edit` would break
    // the very tool the model needs to fix an unfinished plan.
    const paths = freshPaths()
    const sessionId = 'sess-other'
    store.writeDeliveryOverlay(paths, sessionId, domain.emptyDelivery(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    for (const action of ['edit', 'pause', 'resume', 'blocked']) {
      const decision = await fire(ctx, 'tools/pre-execute',
        { name: 'update_goal', arguments: { action }, agent: fakeAgent(sessionId) }, { kind: 'allow' })
      eq(`action "${action}" is not gated`, decision.kind, 'allow')
    }
    for (const name of ['get_goal', 'goal_delivery', 'create_goal']) {
      const decision = await fire(ctx, 'tools/pre-execute',
        { name, arguments: {}, agent: fakeAgent(sessionId) }, { kind: 'allow' })
      eq(`tool "${name}" is not gated`, decision.kind, 'allow')
    }
  }
  {
    // FAIL CLOSED. If the plan cannot be read, completion must be refused — "I could not
    // check" must never mean "go ahead", which is the entire reason the gate exists.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    // No overlay was ever written for this session, so `readDeliveryOverlay` returns an
    // empty plan — which the gate refuses. To test the UNREADABLE path, corrupt the file.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(store.sessionFile(paths, 'sess-broken'), '{ broken', 'utf8')

    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent('sess-broken') }, { kind: 'allow' })
    eq('an unreadable plan refuses completion', decision.kind, 'deny')
    check('and says the state could not be read', /读不出来/.test(decision.reason), decision.reason)
    eq('and counted the refusal', enforcement.stats().completionRejected, 1)
  }
  {
    // A downstream listener already denied the call: the gate must not override it.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent('s1') }, { kind: 'deny', reason: 'sandbox says no' })
    eq('an existing denial is passed through unchanged', decision.kind, 'deny')
    eq('and its reason is preserved', decision.reason, 'sandbox says no')
  }
  {
    // The block is switchable. With it off, no gate listener is installed at all — the
    // cheapest correct behaviour, and it means a deployment that does not want the gate pays
    // nothing for it. Asserting on the listener set rather than on a decision, because with
    // the gate off there IS no decision to inspect.
    const paths = freshPaths()
    const withGate = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(withGate, { paths, options: {} })
    // TWO registrants now: the completion gate and the session gate. Both are on by default,
    // and the count is the cheap way to prove neither silently failed to install.
    eq('with the gates on, both pre-execute listeners are installed',
      (withGate.listeners.get('tools/pre-execute') || []).length, 2)

    const withoutGate = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    // Both switches off. `blockCompletion` governs the completion gate; `sessionGate` governs
    // the v2 session gate. Naming both is the point — the old assertion said "the gate", and
    // there is now more than one.
    enforce.installEnforcement(withoutGate, { paths, options: { blockCompletion: false, sessionGate: false } })
    eq('with both gates off, nothing is installed', (withoutGate.listeners.get('tools/pre-execute') || []).length, 0)
    const decision = await fire(withoutGate, 'tools/pre-execute',
      { name: 'update_goal', arguments: { action: 'complete' }, agent: fakeAgent('s1') }, { kind: 'allow' })
    eq('so a complete passes straight through', decision, undefined)
  }

  console.log('goal-enforce: get_goal gains the plan without losing the goal')
  {
    const paths = freshPaths()
    const sessionId = 'sess-augment'
    store.writeDeliveryOverlay(paths, sessionId, verifiedPlan(sessionId), 0)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })

    const original = { goal: { id: GOAL.id, revision: GOAL.revision, objective: GOAL.objective, phase: 'active' }, activation: 'armed' }
    const decision = await fire(ctx, 'tools/post-execute',
      { name: 'get_goal', arguments: {}, agent: fakeAgent(sessionId) },
      { isError: false, content: [{ type: 'text', text: JSON.stringify(original) }] },
      { kind: 'accept' })

    eq('the result is still an accept', decision.kind, 'accept')
    const text = decision.content.map((part) => part.text).join('')
    const parsed = JSON.parse(text)
    eq('the original goal block is preserved', parsed.goal.id, GOAL.id)
    eq('the activation is preserved', parsed.activation, 'armed')
    check('and a delivery block was added', parsed.delivery !== undefined)
    eq('carrying the acceptance tally', parsed.delivery.acceptance.verified, 1)
    eq('and the health state', typeof parsed.delivery.health, 'string')
    eq('and whether completion would pass', parsed.delivery.can_complete, true)
  }
  {
    // Content the hook does not understand must be left ALONE. Wrapping arbitrary text
    // would corrupt a tool result the model is relying on.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const decision = await fire(ctx, 'tools/post-execute',
      { name: 'get_goal', arguments: {}, agent: fakeAgent('s1') },
      { isError: false, content: [{ type: 'text', text: 'this is not json' }] },
      { kind: 'accept' })
    eq('unparsable content is not rewritten', Object.hasOwn(decision, 'content'), false)
  }
  {
    // Other tools and agent-less calls must be untouched.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const other = await fire(ctx, 'tools/post-execute',
      { name: 'read', arguments: {}, agent: fakeAgent('s1') },
      { isError: false, content: [{ type: 'text', text: 'file body' }] },
      { kind: 'accept' })
    eq('another tool is not touched', Object.hasOwn(other, 'content'), false)
    const agentless = await fire(ctx, 'tools/post-execute',
      { name: 'get_goal', arguments: {} },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ goal: null }) }] },
      { kind: 'accept' })
    eq('an agent-less call is not touched', Object.hasOwn(agentless, 'content'), false)
  }

  console.log('goal-enforce: the commit barrier steers, because a return value cannot')
  {
    // This is the fact the whole design turns on: `dsh-agent-loop` DISCARDS the return value
    // of `agent/turn-stopping`, so the only way to keep a turn open is to put something in
    // the next-step inbox. The assertion is therefore on `steer` having been called.
    const paths = freshPaths()
    const sessionId = 'sess-steer'
    let plan = domain.emptyDelivery(sessionId)
    plan = domain.applyDeliveryOp(plan, 'addAcceptance', { description: '三态都有' }, { at: AT }).delivery
    plan = domain.applyDeliveryOp(plan, 'addTask', { title: '接 API' }, { at: AT }).delivery
    plan = domain.applyDeliveryOp(plan, 'setTaskStatus', { id: 'T-001', status: 'in_progress' }, { at: AT }).delivery
    store.writeDeliveryOverlay(paths, sessionId, plan, 0)

    // The agent's turn wrote a file, so real work happened.
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'write' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
    ]
    const agent = fakeAgent(sessionId, events)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })

    await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
    eq('a turn that changed the workspace is asked to reconcile', agent.steered.length, 1)
    eq('via steer, the only mechanism that opens a step', typeof agent.steered[0].content[0].text, 'string')
    const message = agent.steered[0]
    check('the request names the goal', message.content[0].text.includes(GOAL.objective))
    check('and carries the reconciliation marker', message.content[0].text.includes('<goal_reconciliation>'))
    check('and tells the model not to invent evidence', /不要为了通过检查而编造证据/.test(message.content[0].text))
    // Attribution: a plugin message must NEVER be stamped as the user. A `{kind:'user'}`
    // source clears job wake budgets and resets repeat-reminder chains.
    eq('and is attributed to the plugin, never to the user', message.source.kind, 'plugin')
    eq('with the plugin name', message.source.plugin, 'dsh-luzzy-page')
    eq('the barrier counted an offer', enforcement.stats().reconcileOffered, 1)
  }
  {
    // A turn that only READ did no work, and must not be asked to rewrite its plan. This is
    // the trivial-turn exemption.
    const paths = freshPaths()
    const sessionId = 'sess-readonly'
    store.writeDeliveryOverlay(paths, sessionId, verifiedPlan(sessionId), 0)
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'read' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
    ]
    const agent = fakeAgent(sessionId, events)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
    await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
    eq('a read-only turn is not asked to reconcile', agent.steered.length, 0)
    check('and the skip is counted', enforcement.stats().reconcileSkipped >= 1)
  }
  {
    // A FAILED write changed nothing, so it is not progress.
    const paths = freshPaths()
    const sessionId = 'sess-failed'
    store.writeDeliveryOverlay(paths, sessionId, verifiedPlan(sessionId), 0)
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'write' } },
      { type: 'tool/result', data: { error: { name: 'X', code: 'E' }, message: { id: 'c1' } } },
    ]
    const agent = fakeAgent(sessionId, events)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0 } })
    await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
    eq('a failed write is not progress', agent.steered.length, 0)
  }
  {
    // One steer per turn, and a hard per-session ceiling. Without the first the steer would
    // open a step that trips the barrier again, burning rounds on bookkeeping.
    const paths = freshPaths()
    const sessionId = 'sess-bounded'
    let plan = domain.emptyDelivery(sessionId)
    plan = domain.applyDeliveryOp(plan, 'addTask', { title: 'work', status: 'in_progress' }, { at: AT }).delivery
    store.writeDeliveryOverlay(paths, sessionId, plan, 0)
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'write' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
    ]
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { minReconcileIntervalMs: 0, maxReconciliations: 2 } })
    for (let turn = 1; turn <= 6; turn += 1) {
      const agent = fakeAgent(sessionId, events)
      await fire(ctx, 'agent/turn-stopping', { agent, turn, signal: {} })
      // Each iteration is a NEW turn but the same session, so the session ceiling applies.
    }
    const offered = enforcement.stats().reconcileOffered
    check('the session ceiling is respected', offered <= 2, `offered ${offered}`)
    check('and the barrier reports how often it declined', enforcement.stats().reconcileSkipped > 0)
  }
  {
    // With the barrier off entirely, nothing is ever steered.
    const paths = freshPaths()
    const sessionId = 'sess-off'
    store.writeDeliveryOverlay(paths, sessionId, verifiedPlan(sessionId), 0)
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'write' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
    ]
    const agent = fakeAgent(sessionId, events)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: { reconcile: false } })
    await fire(ctx, 'agent/turn-stopping', { agent, turn: 1, signal: {} })
    eq('with the barrier off nothing is steered', agent.steered.length, 0)
  }

  console.log('goal-enforce: turn observation reads the log, not a counter')
  {
    // Events before the last turn/start must not count: a counter kept across turns would
    // drift after a compaction, and the log is the authority.
    const events = [
      { type: 'tool/call', data: { callId: 'old', name: 'write' } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    ]
    const observed = enforce.observeTurn(fakeAgent('s', events))
    eq('an earlier turn\'s write is not counted', observed.wroteFiles, false)
    eq('and the read-only turn is not progress', observed.changed, false)
    eq('but the call is still counted', observed.toolCalls, 1)
  }
  {
    const observed = enforce.observeTurn({ session: { snapshotEvents: () => { throw new Error('gone') } } })
    eq('a broken session read degrades to "no change"', observed.changed, false)
    const missing = enforce.observeTurn({})
    eq('a missing session degrades too', observed.changed, false)
  }
  {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
      { type: 'tool/call', data: { callId: 'c2', name: 'edit' } },
      { type: 'tool/result', data: { message: { id: 'c2' } } },
    ]
    const observed = enforce.observeTurn(fakeAgent('s', events))
    eq('a command is recognised', observed.ranCommand, true)
    eq('and an edit', observed.wroteFiles, true)
    eq('with both calls counted', observed.toolCalls, 2)
  }

  console.log('goal-enforce: delivery summary is compact and honest')
  {
    const sessionId = 'sess-summary'
    const plan = verifiedPlan(sessionId)
    const block = enforce.deliverySummary(plan, GOAL, { artifactPath: '.agent/goal.md' })
    eq('it reports a health state', typeof block.health, 'string')
    eq('it reports the tally', block.acceptance.verified, 1)
    check('it states whether completion is possible', typeof block.can_complete, 'boolean')
    eq('it names the artifact when one is enabled', block.artifact.path, '.agent/goal.md')
    // Compactness is a requirement, not a nicety: this rides on EVERY get_goal call.
    const bytes = Buffer.byteLength(JSON.stringify(block))
    check(`the block stays small (${bytes} bytes)`, bytes < 600, `${bytes} bytes`)
    check('and carries no full document', block.acceptance.total !== undefined && block.acceptance.evidence === undefined)
  }
  {
    const sessionId = 'sess-summary2'
    let plan = domain.emptyDelivery(sessionId)
    plan = domain.applyDeliveryOp(plan, 'addAcceptance', { description: 'x' }, { at: AT }).delivery
    const block = enforce.deliverySummary(plan, GOAL, {})
    eq('an unfinished plan reports completion as blocked', block.can_complete, false)
    check('and says why', Array.isArray(block.completion_blocked_by) && block.completion_blocked_by.length > 0)
    eq('with no artifact, the field is null rather than absent', block.artifact, null)
  }

  // ---------------------------------------------------------------- the session gate (v2)
  //
  // The gate is the difference between "the harness asks the model to notice the goal" and
  // "the harness does not let a session act until it has decided what the goal is". These
  // assertions exist to prove it REFUSES, because a gate that never refuses is just the
  // guidance layer with more code.
  console.log('goal-enforce: the session gate holds a session with no goal')
  {
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent('sess-gate')

    const write = await fire(ctx, 'tools/pre-execute',
      { name: 'write', arguments: { path: 'a.txt' }, agent }, { kind: 'allow' })
    eq('a write with no goal is refused', write.kind, 'deny')
    check('and the refusal names the gate', /GOAL_GATE_REQUIRED/.test(write.reason), write.reason)
    check('and tells the model how to leave it', /create_goal/.test(write.reason), write.reason)
    check('and names the other exit', /闲聊/.test(write.reason), write.reason)
    eq('and is counted', enforcement.stats().gateBlocked, 1)

    // A READ is refused too. Asserting on `read` on purpose: the softer design would have let
    // it through, so this is the assertion that breaks if someone quietly reverts to
    // allow-read — which is exactly why the user's choice is pinned in a test.
    const read = await fire(ctx, 'tools/pre-execute',
      { name: 'read', arguments: { path: 'a.txt' }, agent }, { kind: 'allow' })
    eq('and so is a read — the gate is not read/write-aware', read.kind, 'deny')

    // The exits must pass, or the model can never satisfy the gate holding it.
    for (const name of ['goal_delivery', 'create_goal', 'get_goal', 'ask_user_question', 'todo_write']) {
      const passed = await fire(ctx, 'tools/pre-execute', { name, arguments: {}, agent }, { kind: 'allow' })
      eq(`${name} passes through the gate`, passed.kind, 'allow')
    }
  }
  {
    // The second exit: the model declares this is not a task.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent('sess-nontask')
    const attempt = () => fire(ctx, 'tools/pre-execute', { name: 'write', arguments: {}, agent }, { kind: 'allow' })

    eq('a work tool starts refused', (await attempt()).kind, 'deny')

    // A reasonless declaration does NOT open the gate. This keeps the exit a deliberate act
    // rather than something a malformed call can stumble through.
    const empty = await fire(ctx, 'tools/pre-execute',
      { name: 'goal_delivery', arguments: { action: 'declareNonTask' }, agent }, { kind: 'allow' })
    eq('a reasonless declaration still passes (it is an exit tool)', empty.kind, 'allow')
    eq('but it did not open the gate', (await attempt()).kind, 'deny')

    const declared = await fire(ctx, 'tools/pre-execute',
      { name: 'goal_delivery', arguments: { action: 'declareNonTask', reason: '用户在打招呼' }, agent }, { kind: 'allow' })
    eq('a proper declaration passes', declared.kind, 'allow')
    eq('and opens the gate', (await attempt()).kind, 'allow')
    eq('and is counted', enforcement.stats().nonTaskDeclared, 1)
  }
  {
    // The third state: a goal EXISTS but cannot answer "when is this done". Opening the gate
    // here would only move the failure to the completion gate, after the work is built.
    const paths = freshPaths()
    const sessionId = 'sess-incomplete'
    const seeded = store.writeDeliveryOverlay(paths, sessionId, domain.emptyDelivery(sessionId), null)
    eq('the empty-plan fixture landed', seeded.ok, true)
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const attempt = () => fire(ctx, 'tools/pre-execute',
      { name: 'write', arguments: {}, agent: fakeAgent(sessionId) }, { kind: 'allow' })

    const blocked = await attempt()
    eq('an empty goal is refused', blocked.kind, 'deny')
    // Read the reason through a guard rather than straight off `blocked`. When the gate is
    // broken, `blocked` is an allow and has no `reason`; accessing it throws, which CRASHES
    // the suite and skips every assertion after this one. A crash and a clean failure both go
    // red, but only the clean failure says which behaviour broke — and while proving the
    // negative control (tools/prove-gate.mjs) that difference is the whole readout.
    const blockedReason = typeof blocked.reason === 'string' ? blocked.reason : ''
    check('and the refusal is the INCOMPLETE one, not the missing one',
      /GOAL_INCOMPLETE/.test(blockedReason), blockedReason)
    for (const field of ['概览目标', '预期产出', '验收标准', '范围边界', '已知约束']) {
      check(`and names the missing field "${field}"`, blockedReason.includes(field), blockedReason)
    }

    // Fill them the way the AGENT actually can, and the same call goes through. Scope and
    // constraints are `propose*` ops — §24/§65 give the agent no authority to set them — so
    // this is also the assertion that the gate is not a DEADLOCK: "asked, and waiting on the
    // human" has to count as an answer. The first draft demanded a settled value and hung
    // right here, which is exactly the failure this assertion exists to keep caught.
    //
    // NOTE the writes are CAS-guarded (`expectedRevision`): passing 0 twice silently REFUSED
    // the second write and the fixture never reached the state under test. Each write's
    // result is checked now, because a helper that fails quietly is how a test starts
    // describing something other than what it claims.
    let d = domain.emptyDelivery(sessionId)
    // 概览目标与预期产出是**最先要求的两项**（用户要求「Agent 填写」，所以宿主真的要求它们）。
    // 它们和下面两条不同：不需要人批，Agent 一次 setGoalSummary / setExpectedOutput 就补齐 ——
    // 所以它们写在这里，而不是「再等一个提案」。
    //
    // 两格都要写：它们回答的是**两个**问题（这个目标在做什么 / 做完会得到什么），所以
    // 写了一个不会把另一个也带过 —— 那正是这段 fixture 现在要一起钉住的东西。
    d = domain.applyDeliveryOp(d, 'setGoalSummary', { goalSummary: '把首页做出来，三种状态都走通。' }, { at: Date.now() }).delivery
    d = domain.applyDeliveryOp(d, 'setExpectedOutput', { expectedOutput: '一个能打开的首页，三种状态都走通。' }, { at: Date.now() }).delivery
    d = domain.applyDeliveryOp(d, 'addAcceptance', { description: '首页可访问', mandatory: true }, { at: Date.now() }).delivery
    d = domain.applyDeliveryOp(d, 'proposeScope', { excluded: ['不做设置页'] }, { at: Date.now() }).delivery
    const firstWrite = store.writeDeliveryOverlay(paths, sessionId, d, seeded.revision)
    eq('the fixture write landed', firstWrite.ok, true)
    eq('a scope proposal alone is not yet enough', (await attempt()).kind, 'deny')

    d = domain.applyDeliveryOp(d, 'proposeConstraints', { constraints: ['不改 DSH Core'] }, { at: Date.now() }).delivery
    const secondWrite = store.writeDeliveryOverlay(paths, sessionId, d, firstWrite.revision)
    eq('the second fixture write landed too', secondWrite.ok, true)
    eq('but proposals for both open the gate WITHOUT waiting for approval', (await attempt()).kind, 'allow')
  }
  {
    // With the session gate OFF, a goal-less session acts freely — the switch is honest.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { sessionGate: false } })
    eq('with the session gate off, a goal-less write proceeds',
      (await fire(ctx, 'tools/pre-execute', { name: 'write', arguments: {}, agent: fakeAgent('s-off') }, { kind: 'allow' })).kind, 'allow')
    eq('and nothing was counted', enforcement.stats().gateBlocked, 0)
  }

  // ---------------------------------------------------------------- 状态链（两道新门）
  //
  // 用户要的是「每次对话都要执行状态链」，而且「必须有这个判断，不然直接锁工具」。这两条断言
  // 必须证明的是**门真的会拦、拦完能过、下一轮还会再拦一次** —— 缺任何一半都不是那条需求：
  //   只拦不放过 = 死锁；只过不拦 = 又回到了「提示词里写一句」。
  console.log('goal-enforce: the state chain gate holds the turn until both branches are answered')
  /**
   * 答一次链，并**同时**落盘 —— 因为真实的 judgeChain 会做这两件事。
   *
   * 第一版只清了内存标记，于是门里读到的 `chain.goalMatch` 还是 null，我把它读成了产品 bug；
   * 其实是装置少做了一半。**替身比真货少做一半和比真货宽松一样有害**：前者让正确的代码看起来
   * 是坏的，后者让坏的代码看起来是对的。所以这里用「读-改-写 + CAS」照抄真实路径。
   */
  function chainHarness(paths, sessionId) {
    let revision = null
    const persist = (mutate) => {
      const read = store.readDeliveryOverlay(paths, sessionId)
      const base = read.ok ? read.delivery : domain.emptyDelivery(sessionId)
      const written = store.writeDeliveryOverlay(paths, sessionId, mutate(base), revision)
      if (written.ok) revision = written.revision
      return written
    }
    return { persist }
  }
  {
    const paths = freshPaths()
    const sessionId = 'sess-chain-gate'
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent(sessionId)
    const chain = chainHarness(paths, sessionId)
    const attempt = () => fire(ctx, 'tools/pre-execute', { name: 'write', arguments: {}, agent }, { kind: 'allow' })

    // 一轮的开始 = 一条新的用户消息。链在这一刻被置位。
    const openTurn = (messageId, step = 1, extra = []) => {
      const claimed = { role: 'user', id: messageId, content: '继续' }
      return fire(ctx, 'agent/pre-step',
        { agent, messages: [claimed], turn: 1, step, signal: {} },
        { kind: 'enter', messages: [claimed, ...extra] })
    }
    // 工具自己渲染的形状：状态词 + JSON（见 goal-tools.mjs 的 render）。
    const judge = (payload, status = 'ok') => fire(ctx, 'tools/post-execute',
      { name: 'goal_delivery', arguments: { action: 'judgeChain', ...payload }, agent },
      { isError: false, content: [{ type: 'text', text: `${status}: x\n${JSON.stringify({ status, action: 'judgeChain' })}` }] },
      { kind: 'accept' })
    const answered = (payload) => {
      const written = chain.persist((d) => domain.applyDeliveryOp(d, 'judgeChain', payload, { at: Date.now() }).delivery)
      eq('the judgement fixture landed', written.ok, true)
      return judge(payload)
    }

    const notice = await openTurn('msg-1')
    check('the state chain rides in the turn notice', String(notice.messages[1]?.content?.[0]?.text ?? '').includes('<state_chain>'))
    eq('and a new user message armed the gate', enforce.readCounters(sessionId).chainPending, true)

    const held = await attempt()
    eq('a work tool is refused before the chain is answered', held.kind, 'deny')
    const heldReason = typeof held.reason === 'string' ? held.reason : ''
    check('and the refusal names the gate', /STATE_CHAIN_REQUIRED/.test(heldReason), heldReason)
    check('and names the call that answers it', /judgeChain/.test(heldReason), heldReason)
    check('and spells out both branches', /goalMatch/.test(heldReason) && /skillCheck/.test(heldReason), heldReason)
    eq('and is counted', enforcement.stats().chainBlocked, 1)

    // 答了但**没答成**的调用不算答过：状态从工具自己的结果里读，保守方向是保持门关着。
    await judge({ goalMatch: 'none', skillCheck: 'none' }, 'error')
    eq('a FAILED judgement does not open the gate', enforce.readCounters(sessionId).chainPending, true)
    eq('so the work tool is still refused', (await attempt()).kind, 'deny')

    await answered({ goalMatch: 'none', skillCheck: 'none' })
    eq('a successful judgement clears it', enforce.readCounters(sessionId).chainPending, false)
    eq('and the work tool passes', (await attempt()).kind, 'allow')

    // 同一个用户消息的后续 step 不是新的一轮 —— 否则一步没答完就又置位，门会自己续期。
    await openTurn('msg-1', 2)
    eq('re-entering the SAME user message does not re-arm', enforce.readCounters(sessionId).chainPending, false)

    // 而且**我们自己的注入不能算新一轮**：它也是 user 角色（source.kind === plugin）。
    // 这条是那个过滤器的反证 —— 去掉过滤，链会在每个 step 自己重新置位。
    const pluginNotice = { role: 'user', id: 'notice-1', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'x' }] }
    await fire(ctx, 'agent/pre-step', { agent, messages: [], turn: 1, step: 3, signal: {} },
      { kind: 'enter', messages: [{ role: 'user', id: 'msg-1', content: '继续' }, pluginNotice] })
    eq('and our own injected notice is not mistaken for a new turn', enforce.readCounters(sessionId).chainPending, false)

    // 宿主的 `<goal_state>` 注入**同样是 user 角色，而且每轮都插**。它必须不算新一轮。
    //
    // 这条是**实测出来的**：本会话一个回合里连着被拦 5 次，每次都得把两道分支重答一遍，
    // 而人只说了一句话。根因就是原来的过滤器只认 `kind === 'plugin'`，于是宿主的目标状态
    // 注入每来一次就被读成「用户又说了一句」，链在同一个回合里自己给自己续期。
    //
    // 来源章是宿主逐个校验的字段（`dsh-session-format` 的 messageSourceValue 里 user /
    // plugin / model / tool / agent-instructions / session-reference 各有各的校验），
    // 所以按 `source.kind` 判是**确定性的**，不是启发式。
    const goalState = {
      role: 'user', id: 'gs-1', source: { kind: 'goal' },
      content: [{ type: 'text', text: '<goal_state>{}</goal_state>' }],
    }
    await fire(ctx, 'agent/pre-step', { agent, messages: [], turn: 1, step: 4, signal: {} },
      { kind: 'enter', messages: [{ role: 'user', id: 'msg-1', content: '继续' }, goalState] })
    eq('and the harness goal-state injection is not a new turn either',
      enforce.readCounters(sessionId).chainPending, false)

    // 工作区规范文件的注入是同一个形状（`agent-instructions`），一起钉住 —— 少钉一个，
    // 下一个「宿主又加了一种注入」就会以同样的方式把门变成每步一次。
    const instructions = {
      role: 'user', id: 'ai-1', source: { kind: 'agent-instructions' },
      content: [{ type: 'text', text: '# AGENTS.md' }],
    }
    await fire(ctx, 'agent/pre-step', { agent, messages: [], turn: 1, step: 5, signal: {} },
      { kind: 'enter', messages: [{ role: 'user', id: 'msg-1', content: '继续' }, instructions] })
    eq('and neither is a workspace-instruction injection',
      enforce.readCounters(sessionId).chainPending, false)

    await openTurn('msg-2', 4)
    eq('a NEW user message re-arms it', enforce.readCounters(sessionId).chainPending, true)
    eq('and the gate holds the next turn too', (await attempt()).kind, 'deny')
  }
  {
    // 两条分支：命中 → 目标必须完整；未命中 → 本轮不要求目标。这是同一个判断的两个答案，
    // 不是「有门」和「没门」。
    const paths = freshPaths()
    const sessionId = 'sess-branches'
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent(sessionId)
    const chain = chainHarness(paths, sessionId)
    const attempt = () => fire(ctx, 'tools/pre-execute', { name: 'write', arguments: {}, agent }, { kind: 'allow' })
    const openTurn = (messageId) => {
      const claimed = { role: 'user', id: messageId, content: '继续' }
      return fire(ctx, 'agent/pre-step', { agent, messages: [claimed], turn: 1, step: 1, signal: {} },
        { kind: 'enter', messages: [claimed] })
    }
    const judge = (payload) => {
      chain.persist((d) => domain.applyDeliveryOp(d, 'judgeChain', payload, { at: Date.now() }).delivery)
      return fire(ctx, 'tools/post-execute',
        { name: 'goal_delivery', arguments: { action: 'judgeChain', ...payload }, agent },
        { isError: false, content: [{ type: 'text', text: 'ok: x\n{"status":"ok"}' }] },
        { kind: 'accept' })
    }

    await openTurn('b-1')
    await judge({ goalMatch: 'matched', skillCheck: 'none' })
    const matched = await attempt()
    eq('branch 1 (命中) still requires a goal', matched.kind, 'deny')
    check('and says it is the goal gate, not the chain gate',
      /GOAL_GATE_REQUIRED/.test(typeof matched.reason === 'string' ? matched.reason : ''), typeof matched.reason === 'string' ? matched.reason : '')

    await openTurn('b-2')
    await judge({ goalMatch: 'none', skillCheck: 'none' })
    eq('branch 2 (未命中) lets the same call through with no goal', (await attempt()).kind, 'allow')
  }
  {
    // 技能门：「命中」之后登记也要真的发生，否则那句话没法核对。
    const paths = freshPaths()
    const sessionId = 'sess-skill-gate'
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent(sessionId)
    const chain = chainHarness(paths, sessionId)
    const attempt = () => fire(ctx, 'tools/pre-execute', { name: 'write', arguments: {}, agent }, { kind: 'allow' })
    const claimed = { role: 'user', id: 's-1', content: '按技能清单做' }
    await fire(ctx, 'agent/pre-step', { agent, messages: [claimed], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [claimed] })
    chain.persist((d) => domain.applyDeliveryOp(d, 'judgeChain', { goalMatch: 'none', skillCheck: 'hit' }, { at: Date.now() }).delivery)
    await fire(ctx, 'tools/post-execute',
      { name: 'goal_delivery', arguments: { action: 'judgeChain' }, agent },
      { isError: false, content: [{ type: 'text', text: 'ok: x\n{"status":"ok"}' }] },
      { kind: 'accept' })

    const skillHeld = await attempt()
    eq('命中技能清单但不登记，仍被拦住', skillHeld.kind, 'deny')
    const skillReason = typeof skillHeld.reason === 'string' ? skillHeld.reason : ''
    check('and the refusal is the SKILL one, not the chain one', /SKILL_LIST_EMPTY/.test(skillReason), skillReason)
    check('and it names the four required fields',
      ['name', 'description', 'purpose', 'source'].every((field) => skillReason.includes(field)), skillReason)
    eq('and it is counted separately', enforcement.stats().skillBlocked, 1)

    // 出口工具必须能过 —— 否则「先读完整正文再登记」这句要求在门后没有执行路径。
    const exit = await fire(ctx, 'tools/pre-execute',
      { name: 'goal_delivery', arguments: { action: 'activateSkill' }, agent }, { kind: 'allow' })
    eq('activateSkill passes through the gate', exit.kind, 'allow')

    // 读正文的那一族也必须能过 —— 这是**实测出来的死锁**，不是理论风险。
    //
    // 门 3 自己的拒绝文本写着「先把那份 skill 的完整正文读一遍，再用 activateSkill 登记」，
    // 而门本身把 read / glob / grep / skill 拦掉了，于是那句话在门后没有执行路径。本会话的
    // 真实记录：答了 skillCheck="hit" 之后连着 4 次调用被拒，其中 3 次是 `read`（正是去读
    // 它要求的那份正文），1 次是 `skill`。模型唯一的出路是把 skillCheck 改成 "none" ——
    // 也就是**为了让门放行而说一句假话**。
    //
    // 所以这三条断言钉住的是「门的指令与门的执行不互相矛盾」：读的过，写的不过。
    eq('read passes through the skill gate', (await fire(ctx, 'tools/pre-execute',
      { name: 'read', arguments: { file_path: 'x' }, agent }, { kind: 'allow' })).kind, 'allow')
    eq('and so does the skill loader itself', (await fire(ctx, 'tools/pre-execute',
      { name: 'skill', arguments: { name: 'x' }, agent }, { kind: 'allow' })).kind, 'allow')
    eq('but an ordinary work tool is still held', (await attempt()).kind, 'deny')

    // 登记之后放行（走真实的状态写入，而不是把门短路）。
    const written = chain.persist((d) => domain.applyDeliveryOp(d, 'activateSkill',
      { name: 'luzzy-roster-design', description: '设计基线', purpose: '本次要判断视觉层级', source: 'https://example.invalid/skills/x' },
      { at: Date.now() }).delivery)
    eq('the activation fixture landed', written.ok, true)
    eq('and then the work tool passes', (await attempt()).kind, 'allow')

    // ---- 待确认提案：宿主把它推进对话（用户第 5 件的宿主那一半）-------------
    //
    // 「静默且异步地展示在控制台内」的反面就是这段文本：宿主**检测到一件已经发生的事实**
    // （交付状态里真躺着一条 pending 提案），然后要求模型当场用 ask_user_question 把选项
    // 渲染出来。它和工具描述里那句「请记得问用户」的区别就在这里 —— 那是 guidance，
    // 这条是在事实之后说的。
    const ask = enforce.renderProposalAsk([
      { id: 'P-001', field: 'scope', target: '', proposed: '1 项包含 / 1 项排除', current: '（未填写）', reason: '接口已存在' },
    ])
    check('the proposal ask names the proposal', ask.includes('P-001'))
    check('and states what it would become', ask.includes('1 项包含 / 1 项排除'))
    check('and points at the tool that turns it into buttons', ask.includes('ask_user_question'))
    check('and tells the model to write the answer back',
      ask.includes('adoptProposal') && ask.includes('rejectProposal'))
    check('and says an answer that changes nothing is not an answer', ask.includes('等于没问'))
  }
  {
    // 读不出交付状态时，链门仍然持有工具：「我读不出来」不等于「模型答过了」。
    const paths = freshPaths()
    const sessionId = 'sess-chain-unreadable'
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const agent = fakeAgent(sessionId)
    const claimed = { role: 'user', id: 'u-1', content: '继续' }
    await fire(ctx, 'agent/pre-step', { agent, messages: [claimed], turn: 1, step: 1, signal: {} },
      { kind: 'enter', messages: [claimed] })
    // 目录要先存在：这条断言测的是「文件坏了」，不是「目录没有」（后者是另一条路径）。
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(join(paths.dir, `${sessionId}.json`), '{ 这不是 JSON')

    const held = await fire(ctx, 'tools/pre-execute', { name: 'write', arguments: {}, agent }, { kind: 'allow' })
    eq('an unreadable overlay does NOT open the chain gate', held.kind, 'deny')
    check('and the refusal is still the chain one',
      /STATE_CHAIN_REQUIRED/.test(typeof held.reason === 'string' ? held.reason : ''),
      typeof held.reason === 'string' ? held.reason : '')
  }

  console.log('goal-enforce: the reminder is per-phase, not once-per-session')
  {
    // v1 silenced the no-goal reminder after the first one, so a model that declined while
    // still reading context never heard about it again — and the session ended with no goal
    // by accident rather than by decision. This proves it comes back.
    const paths = freshPaths()
    const ctx = fakeCtx({ goals: { get: () => undefined } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: { sessionGate: false } })
    const work = [
      { type: 'tool/call', data: { callId: 'c1', name: 'write' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
    ]
    const step = (turn, s) => fire(ctx, 'agent/pre-step',
      { agent: fakeAgent('sess-remind', work), turn, step: s, signal: undefined },
      () => Promise.resolve({ kind: 'enter', messages: [] }), { kind: 'enter', messages: [] })

    const first = await step(1, 1)
    eq('the first substantive step is nudged', (first.messages || []).length, 1)
    check('and it names the exit tool', /declareNonTask/.test(first.messages[0].content[0].text), first.messages[0].content[0].text)

    eq('it does not repeat inside the interval', ((await step(2, 5)).messages || []).length, 0)

    const later = await step(3, 25)
    eq('but it DOES come back after the interval', (later.messages || []).length, 1)
    check('and the second one escalates', /第 2 次提醒/.test(later.messages[0].content[0].text), later.messages[0].content[0].text)
    eq('and both are counted', enforcement.stats().goalNudged, 2)
  }

  console.log('goal-enforce: injection fires on reason, not only on the interval')
  {
    const paths = freshPaths()
    const sessionId = 'sess-adaptive'
    store.writeDeliveryOverlay(paths, sessionId, domain.emptyDelivery(sessionId), 0)
    let goal = { ...GOAL, revision: 1 }
    const ctx = fakeCtx({ goals: { get: () => goal } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const step = (turn, s) => fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), turn, step: s, signal: undefined },
      () => Promise.resolve({ kind: 'enter', messages: [] }), { kind: 'enter', messages: [] })

    eq('the first orientation always fires', ((await step(1, 1)).messages || []).length, 1)
    eq('and the interval throttles the next one', ((await step(1, 3)).messages || []).length, 0)

    // The goal moves. The next step must say so even though the interval has not elapsed —
    // this is the assertion a fixed-interval design cannot satisfy.
    goal = { ...goal, revision: 2 }
    const onChange = await step(1, 4)
    eq('a revision change injects immediately', (onChange.messages || []).length, 1)
    check('and the block says the goal moved', /已变更/.test(onChange.messages[0].content[0].text), onChange.messages[0].content[0].text)
    eq('and it is labelled as a change', onChange.messages[0].source.summary, '目标已更新')
    eq('and counted as a change-driven injection', enforcement.stats().preflightOnChange, 1)

    eq('but an unchanged revision does not repeat', ((await step(1, 5)).messages || []).length, 0)
  }

  console.log('goal-enforce: the preflight is COMPACT, and the objective comes back on triggers')
  {
    // WHY THIS SECTION EXISTS. `renderPreflight` used to print `目标：${JSON.stringify(goal.objective)}`
    // unconditionally. Measured on the live session: 25,604 characters, re-sent every user turn.
    // Every assertion above still passed after that was written, because they only ever looked at
    // the block's first line and its labels — so the block could be any size and stay "green".
    // These four claims are the ones that were missing, and each one can fail on its own:
    //
    //   1. the compact form really is small, and it names what the goal IS;
    //   2. the objective's原文 is absent from the routine turn;
    //   3. it comes back on a revision change and after a detected compaction;
    //   4. the compact form can never fire when it has nothing to say (the fail-safe).
    const objective = `# 目标原文 ${'这一段很长，长到每轮重发就是在烧上下文。'.repeat(80)}`
    const paths = freshPaths()
    const sessionId = 'sess-compact'
    let delivery = domain.emptyDelivery(sessionId)
    delivery = domain.applyDeliveryOp(delivery, 'setGoalSummary', { goalSummary: '把目标中心做出来。' }, { at: 1 }).delivery
    delivery = domain.applyDeliveryOp(delivery, 'setExpectedOutput', { expectedOutput: '一个能看的目标页。' }, { at: 1 }).delivery
    store.writeDeliveryOverlay(paths, sessionId, delivery, 0)

    let goal = { ...GOAL, objective, revision: 1 }
    const ctx = fakeCtx({ goals: { get: () => goal } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(ctx, { paths, options: {} })
    const step = (turn, s, messages = []) => fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages, turn, step: s, signal: undefined },
      () => Promise.resolve({ kind: 'enter', messages }), { kind: 'enter', messages })
    // Read the notice by its MARKER, not by index 0: with a compaction checkpoint in the array
    // the notice is spliced in AFTER the last claimed message, so it lands at index 1. Assuming
    // index 0 read the checkpoint's own text and reported a product failure that was not one.
    const textOf = (result) => (result.messages ?? [])
      .map((m) => m?.content?.[0]?.text ?? '')
      .find((t) => t.startsWith('<goal_state>')) ?? ''

    const first = textOf(await step(1, 1))
    check('the first orientation of a session DOES carry the objective原文',
      first.includes('这一段很长，长到每轮重发就是在烧上下文'), first.slice(0, 200))
    check('and it says how big that text is', /共 \d+ 字/.test(first), first.slice(-200))

    // Turn two: the model has just been told the goal. This is the turn that used to cost 25 kB.
    const second = textOf(await step(2, 1))
    check('a later turn does NOT re-send the objective原文',
      second !== '' && !second.includes('这一段很长，长到每轮重发就是在烧上下文'), second.slice(0, 200))
    check('but it DOES say what the goal is', second.includes('概览目标：把目标中心做出来。'), second)
    check('and what the turn is supposed to produce', second.includes('预期产出：一个能看的目标页。'), second)
    check('and it points at where the original words live', second.includes('get_goal'), second.slice(-200))
    check('and the block is an order of magnitude smaller than the原文',
      second.length < objective.length / 5, `${second.length} vs ${objective.length}`)

    // The two triggers that must not be lost by trimming. Without these the policy is just
    // "never send it", which is the failure mode the user asked about by name.
    goal = { ...goal, revision: 2 }
    const onChange = textOf(await step(3, 1))
    check('a revision change brings the原文 back',
      onChange.includes('这一段很长，长到每轮重发就是在烧上下文'), onChange.slice(0, 200))

    const checkpoint = { role: 'user', id: 'cp-1', content: '（压缩后的历史）', source: { kind: 'plugin', plugin: 'compact', compactionId: 'cp-abc' } }
    const afterCompaction = textOf(await step(4, 1, [checkpoint]))
    check('a detected context compaction brings the原文 back',
      afterCompaction.includes('这一段很长，长到每轮重发就是在烧上下文'), afterCompaction.slice(0, 200))

    // THE LATCH. The checkpoint stays in the transcript forever, so "a compaction happened" is
    // true for the rest of the session — a detector that forgot WHICH one would re-inline the
    // full objective on every remaining step, which is the bug this test exists to prevent.
    const afterLatch = textOf(await step(5, 1, [checkpoint]))
    check('but the SAME checkpoint does not fire it a second time',
      afterLatch !== '' && !afterLatch.includes('这一段很长，长到每轮重发就是在烧上下文'), afterLatch.slice(0, 200))

    // FAIL-SAFE. Nothing to say about the goal → the original comes back regardless of schedule.
    // This is what makes "the agent forgot the goal" unreachable: the compact form may only fire
    // when it actually states one.
    const bareId = 'sess-compact-bare'
    store.writeDeliveryOverlay(paths, bareId, domain.emptyDelivery(bareId), 0)
    const bareGoal = { ...GOAL, objective, revision: 1 }
    const bareCtx = fakeCtx({ goals: { get: () => bareGoal } }, ['webServer'])
    enforce.resetCounters()
    enforce.installEnforcement(bareCtx, { paths, options: {} })
    const bareStep = (turn, s) => fire(bareCtx, 'agent/pre-step',
      { agent: fakeAgent(bareId), turn, step: s, signal: undefined },
      () => Promise.resolve({ kind: 'enter', messages: [] }), { kind: 'enter', messages: [] })
    await bareStep(1, 1)
    const bareSecond = (await bareStep(2, 1)).messages?.[0]?.content?.[0]?.text ?? ''
    check('with 概览目标 and 预期产出 both empty, every turn still carries the原文',
      bareSecond.includes('这一段很长，长到每轮重发就是在烧上下文'), bareSecond.slice(0, 200))
    check('and it says WHY it is repeating itself', bareSecond.includes('都还没写'), bareSecond.slice(0, 200))
  }

  console.log('goal-enforce: compaction detection reads the checkpoint DSH actually writes')
  {
    // Shape verified against a real 12.7 MB session transcript, which carried 8 checkpoints,
    // each with exactly `source = { kind:'plugin', plugin:'compact', compactionId:<uuid> }`.
    eq('no checkpoint → null', enforce.compactionCheckpoint([{ role: 'user' }, { role: 'assistant' }]), null)
    eq('a plugin message that is not compact → null',
      enforce.compactionCheckpoint([{ source: { kind: 'plugin', plugin: 'dsh-luzzy-page' } }]), null)
    eq('a compact source with no id → null',
      enforce.compactionCheckpoint([{ source: { kind: 'plugin', plugin: 'compact' } }]), null)
    eq('the real shape → the id',
      enforce.compactionCheckpoint([{ source: { kind: 'plugin', plugin: 'compact', compactionId: 'x-1' } }]), 'x-1')
    eq('the NEWEST one wins (they accumulate)',
      enforce.compactionCheckpoint([
        { source: { kind: 'plugin', plugin: 'compact', compactionId: 'old' } },
        { source: { kind: 'plugin', plugin: 'compact', compactionId: 'new' } },
      ]), 'new')
    eq('a non-array is not a crash', enforce.compactionCheckpoint(undefined), null)
  }
  console.log('goal-enforce: the skill roster is injected at the node, once, and again after compaction')
{
  // 用户的方案：技能清单不再常驻系统提示词，而是在「判断技能清单」这个节点注入正文。所以这
  // 一节断的是**注入时机** —— 而时机错了只有两种表现，两种都不报错：注入太多次（白烧 token），
  // 或压缩后不补（模型手上那份没了却不知道）。
  const paths = freshPaths()
  const sessionId = 'sess-roster'
  store.writeDeliveryOverlay(paths, sessionId, domain.emptyDelivery(sessionId), 0)
  const goal = { ...GOAL, objective: '清单注入用目标', revision: 1 }
  const ctx = fakeCtx({ goals: { get: () => goal } }, ['webServer'])
  enforce.resetCounters()
  const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
  // 每一轮都必须带一条 role:'user' 的消息 —— 「新的一轮」判据是**用户消息的 id 变了**
  // （`turnOwnerId`），而链只在 newTurn 时注入。第一版这里传空数组，于是 chainDue 永远 false，
  // 15 条断言全红，报出来像「清单没注入」。**量具错了，看着像产品坏了** —— 这个形状本轮第三次。
  const step = (turn, s, extra = []) => {
    const mine = { role: 'user', id: 'u-' + turn, content: [{ type: 'text', text: '继续' }] }
    const messages = [mine, ...extra]
    return fire(ctx, 'agent/pre-step',
      { agent: fakeAgent(sessionId), messages, turn, step: s, signal: undefined },
      () => Promise.resolve({ kind: 'enter', messages }), { kind: 'enter', messages })
  }
  const chainOf = (result) => (result.messages ?? [])
    .map((m) => m?.content?.[0]?.text ?? '')
    .find((t) => t.startsWith('<state_chain>')) ?? ''

  // 第一轮：节点到了，清单必须跟着注入**正文** —— 不是「有这一节」。
  const first = chainOf(await step(1, 1))
  check('the first chain carries the roster body', first.includes('luzzy-roster-backend/SKILL.md'), first.slice(0, 260))
  check('and it carries the AnySearch usage the roster is read with',
    first.includes('get_sub_domains') && first.includes('anysearch_cli.py'), '清单没带工具用法')
  check('and it says this machine has no skill files', first.includes('本机没有 skill 文件'), '没写清新方案的前提')
  check('and it states the exemption', first.includes('豁免'), '没写豁免规则')
  check('and it states that compaction voids the exemption',
    first.includes('compaction checkpoint'), '没写压缩后重读')
  check('and the roster is bracketed so its end is unambiguous',
    first.includes('【技能清单到此为止】'))
  eq('and it is counted as one injection', enforcement.stats().rosterInjected, 1)

  // 第二轮：同一份清单不重复注入。摘要去重的全部意义就在这里。
  const second = chainOf(await step(2, 1))
  check('a second turn does NOT re-inject the same roster',
    second !== '' && !second.includes('luzzy-roster-backend/SKILL.md'), second.slice(0, 240))
  eq('and it is counted as a skip', enforcement.stats().rosterSkipped, 1)
  eq('and the injection count did not move', enforcement.stats().rosterInjected, 1)

  // 压缩之后：豁免作废，清单必须回来。判据是新的 compactionId，不是「我觉得忘了」。
  const cp1 = { role: 'user', id: 'cp-1', content: '（压缩后的历史）', source: { kind: 'plugin', plugin: 'compact', compactionId: 'cp-1' } }
  const afterCompaction = chainOf(await step(3, 1, [cp1]))
  check('a compaction brings the roster back', afterCompaction.includes('luzzy-roster-backend/SKILL.md'),
    afterCompaction.slice(0, 240))
  eq('and it is counted as a second injection', enforcement.stats().rosterInjected, 2)

  // 闩锁：同一个 checkpoint 会一直留在消息里，不该每轮都重来一次 —— 那等于没做去重。
  const afterLatch = chainOf(await step(4, 1, [cp1]))
  check('but the SAME checkpoint does not fire it twice',
    afterLatch !== '' && !afterLatch.includes('luzzy-roster-backend/SKILL.md'), afterLatch.slice(0, 240))

  // 一个新 checkpoint（第二次压缩）→ 再注入一次。
  const cp2 = { role: 'user', id: 'cp-2', content: '（又压缩了一次）', source: { kind: 'plugin', plugin: 'compact', compactionId: 'cp-2' } }
  const afterSecondCompaction = chainOf(await step(5, 1, [cp1, cp2]))
  check('a NEW checkpoint fires it again', afterSecondCompaction.includes('luzzy-roster-backend/SKILL.md'),
    afterSecondCompaction.slice(0, 240))
  eq('so three injections total', enforcement.stats().rosterInjected, 3)
}

console.log('goal-enforce: the roster module slices the file, and fails soft')
{
  // 切片器的两条性质：切对了范围，以及读不到时**不抛**。
  // 「不抛」是硬要求：清单一读不出来就应该降级成「本轮不注入」，而不是让整个预检挂掉 ——
  // 状态链还在、门还在，少的只是一张表。
  eq('extract returns empty when the start marker is missing', rosterMod.extractRoster('no markers here'), '')
  eq('extract returns empty when the end marker is missing', rosterMod.extractRoster('===BEGIN===\nbody'), '')
  eq('extract returns empty when they are inverted', rosterMod.extractRoster('===END===\nbody\n===BEGIN==='), '')
  eq('extract slices between the markers and trims',
    rosterMod.extractRoster('junk\n===BEGIN===\n  body  \n===END===\nmore junk'), 'body')

  const loaded = rosterMod.readRoster()
  eq('the real roster file loads', loaded.error, null)
  check('and it is a real body, not a stub', loaded.text.length > 3000, `${loaded.text.length} chars`)
  check('and it does NOT contain the markers themselves',
    !loaded.text.includes('===BEGIN===') && !loaded.text.includes('===END==='),
    '标记被切进正文了 —— 说明说明段里写了标记字面量，切片器从那里开始切')
  check('and the digest is stable across reads', rosterMod.readRoster().digest === loaded.digest)
  check('and it names the repo root readers must fetch from',
    loaded.text.includes('raw.githubusercontent.com/LuzzyMeow/DSH-Luzzy'))
}

console.log('goal-enforce: turn observation reports WHICH files changed')
  {
    // `files` exists for one caller: the skill-miss challenge has to show the model the concrete
    // files it changed. The path comes out of the call's own arguments — a JSON STRING on this
    // machine's real logs (`runtime-routes.mjs` reads it the same way), an already-parsed object
    // in a fixture — and the field name differs per tool.
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'write', arguments: '{"file_path":"luzzy-page/src/pages/goal.js","content":"x"}' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
      { type: 'tool/call', data: { callId: 'c2', name: 'edit', arguments: '{"file_path":"luzzy-page/src/app/app.js","old_string":"a","new_string":"b"}' } },
      { type: 'tool/result', data: { message: { id: 'c2' } } },
      // `str_replace_editor` names it `path`, not `file_path`.
      { type: 'tool/call', data: { callId: 'c3', name: 'str_replace_editor', arguments: { path: 'luzzy-page/src/styles/components.css' } } },
      { type: 'tool/result', data: { message: { id: 'c3' } } },
      // The same file twice is ONE entry: repeats say "many edits", not "many files".
      { type: 'tool/call', data: { callId: 'c4', name: 'edit', arguments: '{"file_path":"luzzy-page/src/app/app.js"}' } },
      { type: 'tool/result', data: { message: { id: 'c4' } } },
    ]
    const observed = enforce.observeTurn(fakeAgent('sess-files', events))
    eq('the changed files are reported', observed.files.length, 3)
    eq('in write order, de-duplicated',
      observed.files.join(' | '),
      'luzzy-page/src/pages/goal.js | luzzy-page/src/app/app.js | luzzy-page/src/styles/components.css')

    // THE NEGATIVE CONTROL, and the one that matters: reads must not count. Every turn reads
    // files, so a list that included them would be noise — and the challenge would then fire on
    // turns that changed nothing, which is the fastest way to turn a question into a lecture.
    const readsOnly = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'r1', name: 'read', arguments: '{"file_path":"luzzy-page/src/pages/goal.js"}' } },
      { type: 'tool/result', data: { message: { id: 'r1' } } },
      { type: 'tool/call', data: { callId: 'r2', name: 'grep', arguments: '{"path":"luzzy-page/src"}' } },
      { type: 'tool/result', data: { message: { id: 'r2' } } },
    ]
    eq('a read-only turn reports NO files',
      enforce.observeTurn(fakeAgent('sess-reads', readsOnly)).files.length, 0)

    // A FAILED write changed nothing, so it names nothing either.
    const failedWrite = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'f1', name: 'write', arguments: '{"file_path":"x"}' } },
      { type: 'tool/result', data: { error: { name: 'X', code: 'E' }, message: { id: 'f1' } } },
    ]
    eq('a FAILED write contributes no path',
      enforce.observeTurn(fakeAgent('sess-failed-write', failedWrite)).files.length, 0)

    // An unreadable path must not lose the WRITE. The two facts are independent, and the
    // trigger only depends on the second one — a parse failure that also dropped `wroteFiles`
    // would make the challenge silently depend on how a tool spells its arguments.
    const unparsable = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'u1', name: 'write', arguments: 'not json' } },
      { type: 'tool/result', data: { message: { id: 'u1' } } },
    ]
    const odd = enforce.observeTurn(fakeAgent('sess-odd', unparsable))
    eq('an unparsable call still counts as a write', odd.wroteFiles, true)
    eq('but contributes no name', odd.files.length, 0)

    // Capped: past eight the block stops being "this turn's work" and starts being a diff
    // summary (§83).
    const many = [{ type: 'turn/start', data: { turn: 1 } }]
    for (let n = 0; n < 12; n += 1) {
      many.push({ type: 'tool/call', data: { callId: `m${n}`, name: 'write', arguments: `{"file_path":"f${n}.js"}` } })
      many.push({ type: 'tool/result', data: { message: { id: `m${n}` } } })
    }
    eq('the list is capped at 8', enforce.observeTurn(fakeAgent('sess-many', many)).files.length, 8)
  }

  console.log('goal-enforce: the skill-miss challenge states the fact, not a verdict')
  {
    const block = enforce.renderSkillMissChallenge([
      'luzzy-page/src/pages/goal.js',
      'luzzy-page/src/styles/components.css',
    ])
    check('it names the files it is asking about',
      block.includes('luzzy-page/src/pages/goal.js') && block.includes('luzzy-page/src/styles/components.css'))
    check('and calls activateSkill by name', block.includes('activateSkill'))
    check('and spells out the four fields that registration needs',
      ['name', 'description', 'purpose', 'source'].every((field) => block.includes(field)), block)
    check('and offers the second exit: say why no class applies', block.includes('都对不上'))
    check('and states that it is not a refusal', block.includes('这不是拒绝'))

    // THE assertion this renderer exists for. §39 puts "which category is this?" in the MODEL's
    // column, so a block that answered it would be the harness judging its own question — and it
    // would be wrong exactly where the judgement was hard, which is the only place it matters.
    const verdicts = ['设计类', '网页开发', 'HTML 开发', '应该命中', '显然', '属于']
    const said = verdicts.filter((word) => block.includes(word))
    check(`and does NOT name a category for the model (said: ${said.join('/') || 'nothing'})`, said.length === 0, block)
  }

  console.log('goal-enforce: answering skill-miss while writing files gets asked ONCE')
  {
    // The measured hole this closes: several turns in this project's own session answered
    // skillCheck="none" while editing this page's JS and CSS, which §1.1.6's own list calls
    // 设计类 / HTML 网页开发 work. Nothing noticed, because nothing compared the answer to the
    // turn it was given in. This asks — once — and does not judge.
    const paths = freshPaths()
    const sessionId = 'sess-skill-miss'
    const ctx = fakeCtx({ goals: { get: () => GOAL } }, ['webServer'])
    enforce.resetCounters()
    const enforcement = enforce.installEnforcement(ctx, { paths, options: {} })
    const chain = chainHarness(paths, sessionId)
    // This turn really did change the workspace.
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'edit', arguments: '{"file_path":"luzzy-page/src/pages/goal.js","old_string":"a","new_string":"b"}' } },
      { type: 'tool/result', data: { message: { id: 'c1' } } },
    ]
    const agent = fakeAgent(sessionId, events)
    // `decision.messages` is the whole claimed set with the notice spliced in, so counting it
    // would count the user's own message too. Count only OUR messages — the ones stamped
    // `source.kind === 'plugin'` — and read the text off that one.
    const notices = (decision) => (decision.messages ?? []).filter((message) => message?.source?.kind === 'plugin')
    const noticeText = (decision) => String(notices(decision)[0]?.content?.[0]?.text ?? '')
    const openTurn = (messageId, turn, step) => {
      const claimed = { role: 'user', id: messageId, content: '接着做' }
      return fire(ctx, 'agent/pre-step', { agent, messages: [claimed], turn, step, signal: {} },
        { kind: 'enter', messages: [claimed] })
    }
    // The REAL argument shape is `{action, payload:{…}}` — `goal-tools.mjs` commits the op with
    // `args.payload ?? {}` (L233), and that is the object the tool's own schema declares. The
    // older helpers in this file spread the payload flat, which is enough for the GATE (it only
    // reads `args.action`) but not for post-execute, which reads the answer itself.
    const judge = (payload) => {
      chain.persist((d) => domain.applyDeliveryOp(d, 'judgeChain', payload, { at: Date.now() }).delivery)
      return fire(ctx, 'tools/post-execute',
        { name: 'goal_delivery', arguments: { action: 'judgeChain', payload }, agent },
        { isError: false, content: [{ type: 'text', text: 'ok: x\n{"status":"ok"}' }] },
        { kind: 'accept' })
    }
    // 一个只属于这条挑战的说法。不能用「没命中」当标记：链自己就会把这一格的状态写出来，
    // 于是「链的通知里带了这句话」会被读成「挑战注入了」。
    const MARK = '二选一'

    await openTurn('sm-1', 1, 1)
    // …and the model answers that no skill class applies. That answer is knowable only at the
    // moment the call SUCCEEDS, which is why post-execute records it there and not here.
    await judge({ goalMatch: 'none', skillCheck: 'none' })
    eq('post-execute records the chain answer it just saw',
      enforce.readCounters(sessionId).lastSkillCheck, 'none')

    const challenged = await openTurn('sm-1', 1, 2)
    const text = noticeText(challenged)
    eq('the skill-miss challenge is injected on the next step', notices(challenged).length, 1)
    check(`and the challenge is a question of the two ways out (${MARK})`, text.includes(MARK), text)
    check('and the challenge names the path the turn changed', text.includes('luzzy-page/src/pages/goal.js'), text)
    check('and the challenge points at activateSkill', text.includes('activateSkill'), text)
    eq('and the challenge is counted once', enforcement.stats().skillMissChallenged, 1)

    const again = await openTurn('sm-1', 1, 3)
    eq('the same turn is never asked the challenge twice', notices(again).length, 0)

    // A NEW turn asks again — and, just as important, does NOT ask before the model has spoken
    // in it. Without the turn-boundary reset, last turn's answer would be challenged in a turn
    // whose chain answer does not exist yet.
    const nextTurn = await openTurn('sm-2', 2, 1)
    check('a new turn does NOT carry last turn\'s answer forward', !noticeText(nextTurn).includes(MARK), noticeText(nextTurn))
    await judge({ goalMatch: 'none', skillCheck: 'none' })
    const secondAsk = await openTurn('sm-2', 2, 2)
    check('a new turn asks the challenge again', noticeText(secondAsk).includes(MARK), noticeText(secondAsk))
    eq('and the challenge counter says two', enforcement.stats().skillMissChallenged, 2)
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
console.log(`PASS — ${checks} assertions (goal-enforce)`)
