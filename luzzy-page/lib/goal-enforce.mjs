/**
 * Goal delivery enforcement — the hooks that make the overlay load-bearing.
 *
 * WHAT THIS CAN AND CANNOT DO
 *
 * Two facts from the harness reconnaissance constrain everything here, and both are
 * counter-intuitive enough to write down:
 *
 *   1. **`agent/turn-stopping`'s return value is discarded.** `dsh-agent-loop` calls
 *      `await this.dispatch.serial('agent/turn-stopping', …)` and never assigns the result.
 *      The ONLY way to keep a turn open is to put something in the next-step inbox. So a
 *      "commit barrier" is implemented as a `steer`, not as a return value — a return value
 *      would compile, run, and do nothing.
 *
 *   2. **`agent/inject()` does not wake the driver.** An injected message on an idle agent
 *      waits forever for something else to wake it. So anything that must actually be
 *      noticed uses `steer`.
 *
 * And the one that decides how much can be enforced:
 *
 *   3. **`complete` cannot be intercepted.** It is a tool call whose handler reaches
 *      `ctx.goals.complete()` directly; no waterfall sits between the model and the goal
 *      service. What can be done is to make the *model* unable to declare completion
 *      without passing the gate: `tools/pre-execute` sees `update_goal` BEFORE it runs and
 *      can deny it with the gate's refusal as the reason. That is a real barrier — the call
 *      never reaches the service — and the refusal text lands in the model's context as the
 *      tool's error result.
 *
 * The design choice these three facts produce:
 *
 *   * `tools/pre-execute` → refuse a premature `complete` (a hard, blocking gate).
 *   * `agent/pre-step` → orient the model once per substantive turn, with a COMPACT block.
 *   * `agent/turn-stopping` → if real work happened and the plan did not move, steer once
 *     with a reconciliation request.
 *   * `tools/post-execute` → augment `get_goal` with the plan summary, so orienting takes
 *     one call instead of two.
 *
 * WHY THE PREFLIGHT IS COMPACT RATHER THAN THE ARTIFACT
 *
 * The brief asks for both sides of this and they are easy to conflate:
 *
 *   §10 / §46  — a substantive turn MUST observe the goal state before working.
 *   §82 / §83  — "Do not inject full goal artifact every turn"; keep orientation at "small
 *                fixed overhead", because the point is to give the model the most important
 *                state in the fewest tokens, not to show it more.
 *   §68 (方案 B) — the forbidden thing is dumping the whole Markdown into context every turn.
 *
 * So the preflight injects the SAME compact block `get_goal` gets (~500 bytes: phase,
 * counts, focus, next action, whether completion would pass) and never the artifact. The
 * model can read `goal.md` when it wants the full document; it should not have to pay for it
 * on every turn.
 *
 * WHY IT IS NOT INJECTED ON EVERY TURN
 *
 * The brief's own §13 exempts trivial turns: a turn that does no work needs no orientation
 * re-statement, and repeating it every turn would be exactly the "Agent 注意力浪费" §47
 * warns about. Three conditions must all hold before this fires, and each has a reason:
 *
 *   1. **There is a live goal.** Injecting "no goal" scaffolding into a session that is not
 *      doing long work is pure noise.
 *   2. **The turn is substantive.** Judged by the same `observeTurn` the commit barrier
 *      uses — real mutating tool calls — rather than by a guess about the user's intent.
 *      A conversational turn does not get oriented.
 *   3. **It has not already been oriented recently.** `preflightEverySteps` counts steps
 *      since the last injection, so a long turn that works for ten steps is oriented once,
 *      not ten times.
 *
 * WHY THE STEER IS RATE-LIMITED AND BOUNDED
 *
 * A commit barrier that can steer is a loop risk: each steer opens another step, which can
 * trip the barrier again. Two independent limits prevent that — at most one reconciliation
 * per turn, and at most `maxReconciliations` per session. Both are counted from the session
 * log rather than from memory, so a restart cannot be used to reset the budget.
 *
 * @module dsh-luzzy-page/goal-enforce
 */

import { randomUUID } from 'node:crypto'

import { applyDeliveryOp, completionGate, missingGoalFields, needsReconciliation, nextId, renderCompletionRefusal, summarize } from './goal-domain.mjs'
import { readDeliveryOverlay, writeDeliveryOverlay } from './goal-store.mjs'
import { readRoster } from './skill-roster.mjs'

/** Attribution for everything this plugin injects. NEVER `{kind:'user'}`. */
export const PLUGIN_NAME = 'dsh-luzzy-page'

/**
 * Build one plugin-attributed user-role notice, complete with its message identity.
 *
 * EVERY injected message MUST carry a non-empty string `id`. This is not cosmetic: the
 * harness validates stored events when it loads a session log, and
 *
 *     assertMessageEventShape: `${subject} lacks an identified message`
 *
 * rejects an event whose message has no id. The rejection happens at LOAD time, over the
 * whole log, so ONE id-less message makes the entire session unreadable —
 *
 *     stored session "<id>" is corrupt: ... session event at seq N lacks an identified message
 *
 * and every later turn of that session is lost with it. The id is also load-bearing while
 * running: the inbox keys pending messages by it (`inbox.locate` matches on `message.id`)
 * and uses it to reject duplicates.
 *
 * Core plugins never hit this because they build messages with `createUserMessage()`, which
 * mints `randomUUID()`. Hand-written literals have no such net — which is exactly how this
 * plugin shipped 130 corrupt events across three sessions. Hence one constructor for all
 * three injection sites: a future site cannot forget the id because it does not write the
 * object literal at all.
 *
 * @param {string} text - notice body.
 * @param {string} summary - short label the UI shows instead of the body.
 * @returns {object} a complete, identified user-role plugin message.
 */
function pluginNotice(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    // NOT `{kind:'user'}`: that source clears job wake budgets and resets repeat-reminder
    // chains. This is the plugin talking, so it says so.
    source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary },
  }
}

/**
 * Tools whose success means the workspace or the runtime changed. Used by the
 * reconciliation trigger, which asks "did real work happen", not "did anything happen" —
 * a `read` is not progress.
 */
const MUTATING_TOOLS = new Set([
  'write', 'edit', 'str_replace_editor', 'apply_patch', 'notebook_edit',
  'bash', 'pwsh', 'run_code', 'present',
])

/** Tools this plugin owns in the delivery layer. */
export const DELIVERY_TOOL = 'goal_delivery'

/**
 * Every lifecycle event this layer registers a listener on.
 *
 * Exported so a test can assert the full set is installed and — more importantly — that
 * unloading removes ALL of them. An orphan listener would keep steering turns on behalf of a
 * plugin that is no longer loaded, which is the "orphan continuation" failure the brief's §78
 * matrix names. Keeping the list here means a future hook cannot be added without the unload
 * assertion covering it.
 */
export const HOOK_NAMES = Object.freeze([
  'agent/pre-step',
  'tools/pre-execute',
  'tools/post-execute',
  'agent/turn-stopping',
])

export const DEFAULT_ENFORCE_OPTIONS = Object.freeze({
  /** Whether a premature `complete` is refused. Fail-closed: the gate is the feature. */
  blockCompletion: true,
  /** Whether a substantive turn is oriented with a compact goal block (brief §10 / AC-002). */
  preflight: true,
  /**
   * Steps between two preflight injections inside one turn.
   *
   * `1` would fire on every step of a long turn — the "注意力浪费" §47 warns about. The block
   * is cheap but not free, and a model that just read it three seconds ago does not need it
   * again. `6` is a compromise: on a short turn it fires once at the start; on a long turn it
   * refreshes often enough that a model that has drifted gets pulled back.
   *
   * This is the FLOOR, not the whole policy: `initial`, `onGoalChange` and `afterFailure` in
   * `injectionPolicy` fire regardless of it. A fixed interval alone cannot express "the goal
   * just changed, say so NOW".
   */
  preflightEverySteps: 6,
  /**
   * How many preflights may pass before the objective's FULL text is inlined again.
   *
   * WHY THIS EXISTS — the compact block drifted.
   *
   * Everything above says this block is compact and never the artifact. The code did the
   * opposite: it printed `目标：${JSON.stringify(goal.objective)}` verbatim. Measured on the live
   * session (12.7 MB transcript), that line alone was **25,604 characters**, re-sent on every
   * user turn — 6.8 MB of `<goal_state>` text across the session. That is §68 方案 B, the exact
   * implementation the brief forbids, and the opposite of §82/§83.
   *
   * So the objective's text is now LAZY, and comes back on four triggers rather than never:
   *
   *   1. `isInitial`  — the first preflight of a session: the model has certainly not seen it.
   *   2. `changed`    — the revision moved: what it remembers is now wrong.
   *   3. `compacted`  — a context compaction replaced the history (see `compactionCheckpoint`).
   *   4. this value   — the floor, so a long session cannot drift indefinitely on a summary
   *                     alone. 10 preflights ≈ 10 user turns; a compaction lands in that range.
   *
   * The compact path can never fire WITHOUT a statement of intent: `renderPreflight` forces the
   * full text back whenever both 概览目标 and 预期产出 are empty. "Forgot the goal" is therefore
   * not a state this policy can reach — the worst case is that the model holds a summary instead
   * of the original words, and `get_goal` is one call away.
   */
  preflightFullEvery: 10,
  /**
   * Whether a session with no goal is held at the goal gate before it may act.
   *
   * This is the v2 upgrade: without it the layer only ever ASKS the model to notice the goal
   * (§6's nudge), which is guidance, not a gate. With it, a session that has not yet reached a
   * decision about its goal cannot start changing things.
   */
  sessionGate: true,
  /**
   * Steps before a session with no goal may be asked again for its intent.
   *
   * The v1 behaviour was once per session. That is wrong in the case it matters most: the model
   * declines while it is still gathering context, and the gate then never speaks again, so the
   * session runs to completion with no goal by accident rather than by decision.
   */
  goalReminderEverySteps: 20,
  /** Whether a turn that changed the workspace may be asked to reconcile its plan. */
  reconcile: true,
  /** Whether `get_goal` gains the plan summary. */
  augmentGetGoal: true,
  /** Hard ceiling on reconciliation steers per session. */
  maxReconciliations: 8,
  /** Minimum milliseconds between two reconciliation steers in one session. */
  minReconcileIntervalMs: 60_000,
})

/**
 * Tools the session gate must let through, because they are how a session LEAVES the gate.
 *
 * Everything else waits. The distinction is not "read vs write" — the user asked for a gate
 * that holds ALL work tools — it is "does this tool make progress possible" against "does this
 * tool make changes". A gate that also blocked these would be a deadlock: the model could not
 * create the goal it is being asked for, and could not ask the user the question the gate
 * tells it to ask.
 *
 *   goal_delivery       the goal lifecycle itself (create/update/complete)
 *   get_goal            reading the goal it may already have
 *   ask_user_question   §5's clarification path — the gate's own escape hatch
 *   todo_write          planning, not execution; the brief's §17 treats tasks as the plan
 */
export const GATE_PASS_TOOLS = Object.freeze(
  new Set(['goal_delivery', 'create_goal', 'get_goal', 'update_goal', 'ask_user_question', 'todo_write']),
)

/**
 * Tools the SKILL gate (门 3) must let through, because they are how a skill gets READ.
 *
 * 门 3 的拒绝文本自己就写着「先把那份 skill 的完整正文读一遍，再用 activateSkill 登记」——
 * 而门本身把 `read` / `glob` / `grep` / `skill` 一起拦掉了，于是那句话**无法执行**。
 *
 * 实测死锁（本会话真实发生，不是推演）：答了 `skillCheck: "hit"` 之后连着 4 次调用全被拒，
 * 其中 3 次是 `read`（正是去读它要求的那份正文），1 次是 `skill`。模型唯一的出路是把
 * `skillCheck` 改成 `"none"` —— 也就是**为了让门放行而说一句假话**。一个逼人说假话的门，
 * 比没有门更糟：它把「登记」这个可核对的证据变成了一个必须撒谎才能开始的仪式。
 *
 * 所以这不是把门放宽，是让门的**指令**与门的**执行**不再互相矛盾。放过的只有「读」这一族：
 * 写文件、跑命令、装东西仍然一律等到登记之后。门 3 本身在下一轮照样查 —— 读了不登记，
 * 工具还是拿不到。
 */
export const SKILL_GATE_PASS_TOOLS = Object.freeze(new Set(['read', 'glob', 'grep', 'skill']))

/**
 * Read one optional DSH service.
 *
 * `ctx.get(name)` rather than `ctx.name`: cordis' context proxy THROWS for a name the
 * calling fiber did not declare in `inject`, and the throw happens while the expression is
 * being evaluated — so `typeof ctx.goals?.get === 'function'` cannot guard it. This plugin
 * declares `webServer` and probes everything else, because a deployment without goal tools
 * should still get the page.
 *
 * @param {object} ctx - host context.
 * @param {string} name - service name.
 * @returns {object|undefined} the service, or undefined.
 */
export function service(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * Resolve the live goal for one agent, without throwing.
 *
 * Returns a discriminated result rather than `null`, because "there is no goal" and "the
 * goal service is not reachable" must not be collapsed: the first is a normal state the
 * page shows as empty, the second is a failure the page has to name.
 *
 * @param {object} ctx - host context.
 * @param {object} agent - the agent to read for.
 * @returns {{state: 'ok', goal: object|undefined} | {state: 'unavailable', reason: string}}
 */
export function liveGoalFor(ctx, agent) {
  const goals = service(ctx, 'goals')
  if (goals === undefined || typeof goals.get !== 'function') {
    return { state: 'unavailable', reason: '这个部署没有挂载 goal 服务（@deepseek-ai/dsh-goal）' }
  }
  try {
    return { state: 'ok', goal: goals.get(agent) }
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Every agent that currently owns a plan, newest registration first.
 *
 * The `goal` projection has no "which session owns this goal" index, and
 * `ctx.goals.get(agent)` needs an Agent rather than an id — so the registry is the only
 * way to enumerate. `agents.list()` is the documented public call; `roots()` would miss a
 * goal held by a subagent, which is legal.
 *
 * @returns {Array<{agent: object, goal: object}>}
 */
export function agentsWithGoals(ctx) {
  const agents = service(ctx, 'agents')
  if (agents === undefined || typeof agents.list !== 'function') return []
  const out = []
  let list
  try {
    list = agents.list()
  } catch {
    return []
  }
  for (const agent of list) {
    const resolved = liveGoalFor(ctx, agent)
    if (resolved.state === 'ok' && resolved.goal !== undefined) out.push({ agent, goal: resolved.goal })
  }
  return out
}

/** Locate the agent owning a session id, without assuming it is loaded. */
export function agentForSession(ctx, sessionId) {
  const agents = service(ctx, 'agents')
  if (agents === undefined || typeof agents.get !== 'function' || typeof sessionId !== 'string') return undefined
  try {
    return agents.get(sessionId)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- observation bookkeeping

/**
 * Per-session enforcement counters.
 *
 * In memory on purpose. These are rate limits on a live behaviour, not durable facts: after
 * a restart the model has a fresh context and deserves a fresh budget, and persisting the
 * counter would let an old session's mistakes permanently silence the barrier.
 */
const counters = new Map()

function counterFor(sessionId) {
  let entry = counters.get(sessionId)
  if (entry === undefined) {
    entry = {
      reconciliations: 0,
      lastReconcileAt: 0,
      turnsSinceReconcile: 0,
      preflights: 0,
      preflightMisses: 0,
      lastPreflightTurn: -1,
      lastPreflightStep: -999,
      /**
       * v1 rate-limited the no-goal nudge to ONCE PER SESSION. Measured against the case that
       * matters most, that is backwards: a model that declines while still gathering context
       * silences the gate forever, so the session finishes with no goal by accident rather
       * than by decision. Now it re-asks once the session has moved on.
       */
      lastGoalNudgeStep: -999,
      /**
       * How many times this session was asked for its intent. Kept as a COUNT rather than the
       * v1 boolean because the interesting question is not "was it asked" but "was it asked
       * and still ignored" — a session nudged four times with no goal is a session the gate
       * is failing to reach, and a boolean cannot show that.
       *
       * Initialised rather than left undefined so the counters block has a STABLE SHAPE from
       * the first read: `test-goal-routes` pins that shape, and a key that appears only after
       * the first nudge would make "no nudges yet" indistinguishable from "field renamed".
       */
      goalNudgeCount: 0,
      /** Whether the model answered "this is not a task" — the gate's second exit. */
      nonTaskDeclared: false,
      /** Diagnostic only: how many calls the gate refused for this session. */
      gateBlocks: 0,
      /** Step of the injection that last carried a given goal revision. */
      lastInjectedRevision: null,
      lastInjectedStep: -999,
      /** `preflights` count at the injection that last carried the objective's full text. */
      lastFullPreflight: -999,
      /**
       * The compaction checkpoint this session has already reacted to.
       *
       * LATCHED, and that is the whole reason it is stored: after a compaction the checkpoint
       * message STAYS in the transcript — it is what replaced the compacted history. Detecting
       * "a compaction happened" without remembering WHICH one would then be true on every
       * remaining step of the session, and the full objective would come back forever.
       */
      lastCompactionId: null,
      /**
       * 状态链：这一轮答了没有。
       *
       * `chainPending` 是**每轮重新置位**的：用户在下一轮说话时它变 true，成功的 judgeChain
       * 让它变 false。它是运行时事实，所以只在内存里 —— 重启后第一轮重新问一遍是对的，
       * 而把它持久化会让「本轮还没答」变成一个可能来自上周的陈旧标记。
       *
       * `lastUserMessageId` 是「新的一轮」的判据：不靠 step 归零（不同路径下 step 的行为没有
       * 保证），靠**用户那条消息的 id 变了** —— 这是一个确定的事实。
       */
      chainPending: false,
      lastUserMessageId: null,
      chainJudgements: 0,
      chainBlocks: 0,
      skillBlocks: 0,
      /**
       * 模型自己答的那一格 `skillCheck`，以及「这一轮为它问过没有」。
       *
       * 为什么要在这里留一份：`skillCheck` 是**模型的判断**（§39），答 "none" 合法且不花任何
       * 代价 —— 而那正是漏洞的形状。要问一句「你答了没命中，可这一轮改了文件」，就得知道它
       * 答的是什么。值在 `tools/post-execute` 处理 `judgeChain` 成功那一步顺手记下（原文就在
       * 手里），预检那一步直接读这两个字段，**不再去读交付状态**：同一次调用写的值，再读一次
       * 盘只换来一次 IO 和一个不一致窗口。
       *
       * 两者都是**运行时事实**（和 `chainPending` 同一类），所以只在内存里：
       * 一轮答一次，"none" 也只在这**一轮**内值得追问。跨重启丢失是可接受的 —— 那时
       * `chainPending` 也一并回到未答，模型本来就要重答一遍。
       *
       * `skillMissChallenged` 存的是轮次号（不是布尔）：新一轮要能重新问一次，而「第几轮问过」
       * 比「问过没有」多一个信息 —— 它让「上一轮问过」不会被当成「这一轮问过」。
       */
      lastSkillCheck: null,
      skillMissChallenged: null,
      /**
       * 已经把哪几条待确认提案推进对话里了（P-nnn）。
       *
       * 这是**运行时事实**，和 `chainPending` 同一类，所以存在内存里而不是交付状态里：
       * 它回答的是「这一轮我提醒过没有」，不是「用户确认过没有」——后者是 `proposals`
       * 里那条记录的 `pending`，那才是持久状态。
       */
      proposalsSurfacedIds: [],
      /**
       * 技能清单注入到哪一份了（正文摘要），以及已消费的压缩 checkpoint。
       *
       * `lastRosterDigest` 是**去重键**：同一份清单一个会话只注入一次，正文改了就重来。
       * `rosterCompactionId` 是**作废键**：上下文被压缩意味着模型手上那份清单没了，
       * 摘要必须清空让它重来 —— 判据是确定性的（出现新的 compactionId），不是「我觉得忘了」。
       */
      lastRosterDigest: null,
      rosterCompactionId: null,
    }
    counters.set(sessionId, entry)
  }
  return entry
}

/** Test/diagnostic seam: forget one session's counters. */
export function resetCounters(sessionId) {
  if (sessionId === undefined) counters.clear()
  else counters.delete(sessionId)
}

/** Snapshot the counters for one session, for the page's diagnostics section. */
export function readCounters(sessionId) {
  const entry = counterFor(sessionId)
  return { ...entry }
}

// ---------------------------------------------------------------- shared read

/**
 * Read the overlay and the live goal together, in the one order that is safe.
 *
 * @param {object} ctx - host context.
 * @param {string} sessionId - session id.
 * @param {object} paths - store paths.
 * @param {object|undefined} agent - the owning agent, when it is loaded.
 * @returns {{ok: true, delivery: object, goal: object|null, goalState: string, goalReason?: string, warnings: string[], source: string} | {ok: false, code: string, reason: string}}
 */
export function readPair(ctx, sessionId, paths, agent) {
  const read = readDeliveryOverlay(paths, sessionId)
  if (!read.ok) return { ok: false, code: read.code, reason: read.reason }
  const resolved = agent === undefined ? { state: 'unavailable', reason: '会话未在本进程加载' } : liveGoalFor(ctx, agent)
  return {
    ok: true,
    delivery: read.delivery,
    goal: resolved.state === 'ok' ? resolved.goal ?? null : null,
    goalState: resolved.state,
    ...(resolved.state === 'ok' ? {} : { goalReason: resolved.reason }),
    warnings: read.warnings,
    source: read.source,
  }
}

/**
 * Persist one op against the overlay, resolving the actor and the change id.
 *
 * This is the single write path — the route, the tool and the enforcement hooks all come
 * through here, so the compare-and-set policy has exactly one implementation.
 *
 * @param {object} deps - `{paths, sessionId, ctx, agent}`.
 * @param {string} op - the op name.
 * @param {object} payload - the op payload.
 * @param {{actor?: string, expectedRevision?: number}} [options]
 * @returns {{ok: true, delivery: object, created?: string, goal: object|null} | {ok: false, code: string, reason: string, proposal?: object}}
 */
export function commitOp(deps, op, payload, options = {}) {
  const { paths, sessionId } = deps
  const read = readDeliveryOverlay(paths, sessionId)
  if (!read.ok) return { ok: false, code: read.code, reason: read.reason }

  const at = Date.now()
  const result = applyDeliveryOp(read.delivery, op, payload, {
    at,
    actor: options.actor ?? 'agent',
    changeId: nextId('C', read.delivery.changes),
  })

  // The three-way outcome from applyDeliveryOp: applied, refused, or refused-but-proposed.
  // The third carries a changed document that MUST still be written — see its doc comment.
  if (result.error !== undefined && result.delivery === undefined) {
    return { ok: false, code: result.code, reason: result.error }
  }

  const written = writeDeliveryOverlay(paths, sessionId, result.delivery, options.expectedRevision ?? read.delivery.revision)
  if (!written.ok) return { ok: false, code: written.code, reason: written.reason }

  if (result.error !== undefined) {
    return { ok: false, code: result.code, reason: result.error, proposal: result.proposal }
  }
  return { ok: true, delivery: result.delivery, created: result.created }
}

// ---------------------------------------------------------------- layer 2: get_goal

/**
 * The delivery block appended to `get_goal`'s result.
 *
 * Compact by construction (the brief's §82–83): counts, focus, next action and any refusal
 * — not the artifact. A model that wants the full document can read `goal.md`; a model that
 * wants to know where it stands should not have to.
 *
 * @param {object} delivery - normalized overlay.
 * @param {object|null} goal - the live goal.
 * @param {{artifactPath?: string, counters?: object}} [extra]
 * @returns {object} the block.
 */
export function deliverySummary(delivery, goal, extra = {}) {
  const summary = summarize(delivery, goal)
  const gate = completionGate(delivery, goal)
  return {
    health: summary.health,
    acceptance: summary.acceptance,
    tasks: summary.tasks,
    evidence: summary.evidence,
    blockers: summary.blockers,
    proposals: summary.proposals,
    current_focus: delivery.focus === '' ? null : delivery.focus,
    next_action: delivery.next,
    artifact: extra.artifactPath === undefined ? null : { path: extra.artifactPath },
    can_complete: gate.allowed,
    ...(gate.allowed ? {} : { completion_blocked_by: gate.unverified.concat(gate.remainingWork).slice(0, 8) }),
    ...(extra.counters === undefined ? {} : { enforcement: extra.counters }),
  }
}

// ---------------------------------------------------------------- the hooks

/**
 * Render the compact orientation block injected at the start of a turn.
 *
 * Deliberately NOT the artifact, and not even the full `deliverySummary` — this is read by a
 * model that is about to work, so it says only what changes what the model does next: where
 * the goal stands, what it is supposed to be doing, and whether it may declare completion.
 *
 * @param {object} delivery - normalized overlay.
 * @param {object} goal - the live goal view.
 * @param {{artifactPath?: string, changedSinceLastInjection?: boolean}} [meta]
 * @returns {string} a `<goal_state>` block.
 */
export function renderPreflight(delivery, goal, meta = {}) {
  const summary = summarize(delivery, goal)
  const gate = completionGate(delivery, goal)
  const lines = ['<goal_state>']
  if (meta.changedSinceLastInjection === true) {
    // The model has seen an older revision of this goal. Naming that is the difference between
    // "the harness is repeating itself" and "the goal moved under you, re-read it".
    lines.push('（目标自上次下发后已变更——以这一段为准。）')
  }

  // ---- the operative statement, in the model's own words -------------------
  //
  // 概览目标 and 预期产出 are the agent's compression of the objective, and they are what makes
  // the lazy full text safe: they are written against the same acceptance criteria the completion
  // gate enforces, so a summary that drifts is checked by something other than itself.
  const statement = []
  const goalSummary = typeof delivery.goalSummary === 'string' ? delivery.goalSummary.trim() : ''
  const expectedOutput = typeof delivery.expectedOutput === 'string' ? delivery.expectedOutput.trim() : ''
  if (goalSummary !== '') statement.push(`概览目标：${goalSummary}`)
  if (expectedOutput !== '') statement.push(`预期产出：${expectedOutput}`)

  // FAIL-SAFE, and the answer to "what if it forgets the goal": the compact path may only fire
  // when it actually says what the goal is. With neither field filled there is nothing here to
  // orient on, so the original text comes back regardless of the trigger policy. Silence is the
  // one failure mode this block must never have.
  const full = meta.full === true || statement.length === 0
  lines.push(...statement)
  if (statement.length === 0) {
    // Not `meta.full !== true`: the caller already forces the full text in this case, so a note
    // gated on "the caller did not ask for it" is a branch that can never run. The test that
    // caught this is the one asserting the note APPEARS — worth having, because the note is the
    // only thing that tells the model the compact path is waiting on its own input.
    lines.push('（概览目标与预期产出都还没写——没有这两条，这一块就没法说明要交付什么，所以直接给你目标原文。先把它们写上，之后每轮只会下发压缩态。）')
  }

  if (summary.acceptance.total === 0) {
    lines.push('验收标准：还没有定义——没有它，「完成」无法判断。先定验收标准再动手。')
  } else {
    // The LIST, not just the count. 14 criteria measured 559 characters and they are the
    // operational definition of "done" — cheaper per useful token than anything else in here.
    lines.push(`验收标准：${summary.acceptance.verified}/${summary.acceptance.total} 已验证`)
    for (const row of delivery.acceptance.slice(0, 14)) {
      const mark = row.status === 'verified' ? '已验证' : row.status
      const mandatory = row.mandatory === false ? '（非必须）' : ''
      lines.push(`- ${row.id} ${clip(row.description, 90)}（${mark}）${mandatory}`)
    }
    if (delivery.acceptance.length > 14) lines.push(`（还有 ${delivery.acceptance.length - 14} 条）`)
  }

  // Scope and constraints were NOT in this block before, which is the one thing the compaction
  // actually made worse: §11 is "Agent 无法静默扩大 Objective / Scope", and the two fields that
  // say what may not be done were the two fields the model never received.
  const scope = delivery.scope ?? { included: [], excluded: [] }
  if (scope.included.length > 0) lines.push(`范围（包含）：${bulletList(scope.included, 6)}`)
  if (scope.excluded.length > 0) lines.push(`范围（不包含）：${bulletList(scope.excluded, 4)}`)
  if (delivery.constraints.length > 0) lines.push(`已知约束：${bulletList(delivery.constraints, 6)}`)

  lines.push(`阶段：${goal.phase}${goal.phase === 'active' ? `（续行${goal.activation === 'armed' ? '已启用' : '未启用'}）` : ''} · 修订 ${goal.revision} · 轮次 ${goal.roundsStarted}/${goal.maxGoalRounds}`)
  if (summary.tasks.total > 0) {
    lines.push(`任务：${summary.tasks.completed}/${summary.tasks.total} 已完成（进行中 ${summary.tasks.active}）`)
  }
  lines.push(delivery.focus === '' ? '当前焦点：（未设置）' : `当前焦点：${delivery.focus}`)
  if (delivery.next.length > 0) lines.push(`下一步：${delivery.next.slice(0, 3).join(' / ')}`)
  if (summary.blockers.open > 0) {
    const open = delivery.blockers.filter((row) => row.resolvedAt === null).slice(0, 2)
    lines.push(`未解决阻塞：${open.map((row) => `${row.code}（${row.message}）`).join('；')}`)
  }
  if (summary.proposals.pending > 0) {
    lines.push(`待用户确认的变更提案：${summary.proposals.pending} 条——不要自己改目标或范围。`)
  }

  lines.push(
    gate.allowed
      ? '完成门：验收标准已全部满足，可以调用 update_goal(action=complete)。'
      : `完成门：现在还不能标记完成。还差 ${[...gate.unverified, ...gate.remainingWork, ...gate.blockers].slice(0, 5).join('、')}`,
  )
  // One line of instruction, and it points at the tool rather than repeating the rules the
  // system prompt already carries. Repeating policy here would be the token waste §83 is
  // about — and the model already has it.
  lines.push(`做完本轮的工作后用 ${DELIVERY_TOOL} 同步计划；证据必须来自真实跑过的东西。`)
  if (meta.artifactPath !== undefined) lines.push(`完整计划（需要时再读）：${meta.artifactPath}`)

  if (full) {
    // LAST, deliberately. The original is ~25,000 characters; putting it above the operative
    // block would bury 验收标准 / 范围 / 下一步 under it, which is how the block got into the
    // shape this option exists to correct.
    lines.push(`目标原文（这一轮内联，共 ${goal.objective.length} 字）：${JSON.stringify(goal.objective)}`)
  } else {
    lines.push(`目标是压缩态。原文 ${goal.objective.length} 字未内联——需要核对原话时调 get_goal${meta.artifactPath === undefined ? '' : `，或读 ${meta.artifactPath} 的第 1 节`}。`)
  }
  lines.push('</goal_state>')
  return lines.join('\n')
}

/** Truncate one line without ever leaving a dangling half-word feeling like the whole thing. */
function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Render a bounded inline list. Bounded because this block fires on every turn. */
function bulletList(items, max) {
  const shown = items.slice(0, max).map((item) => clip(item, 80))
  if (items.length > max) shown.push(`…还有 ${items.length - max} 项`)
  return shown.join('；')
}

/**
 * Find the newest compaction checkpoint in a message array, or `null`.
 *
 * WHY THIS IS THE RIGHT SIGNAL. A compaction does not just trim the transcript — it REPLACES
 * the compacted history with a checkpoint message, so the model's context genuinely loses what
 * came before. That message is identifiable and DSH stamps it consistently: verified against a
 * real 12.7 MB session transcript, which carried 8 of them, each with exactly
 * `source = { kind: 'plugin', plugin: 'compact', compactionId: <uuid> }`.
 *
 * The id is returned rather than a boolean because the checkpoint PERSISTS: "a compaction
 * happened" stays true for the rest of the session, and a caller that cannot tell one from the
 * next would re-inline the full objective on every step.
 *
 * Best-effort by design. It only ever causes an EXTRA full injection, never a missing one, so a
 * future DSH that renames this source costs the interval fallback and nothing else.
 *
 * @param {Array<{source?: object}>} messages
 * @returns {string|null}
 */
export function compactionCheckpoint(messages) {
  let id = null
  for (const message of Array.isArray(messages) ? messages : []) {
    const source = message?.source
    if (source?.kind === 'plugin' && source?.plugin === 'compact' && typeof source?.compactionId === 'string' && source.compactionId !== '') {
      id = source.compactionId
    }
  }
  return id
}

/**
 * Render the per-turn state chain, plus the skills this turn may rely on.
 *
 * WHY THIS IS SEPARATE FROM `renderPreflight`
 *
 * The goal block is about WHERE the work stands; this one is about the two DECISIONS that have to
 * be made before the work starts. They fire on different schedules: the goal block is adaptive
 * (§83 — it is not worth re-sending an unchanged plan every turn), while the chain block belongs
 * to the turn itself. Bundling them would have forced one schedule onto both.
 *
 * The two branches are the user's: 命中 means this turn advances a long-running goal, 未命中
 * means it does not and no goal is required. 未命中 is an ANSWER, not a skip — which is why the
 * block asks for a value rather than for a goal.
 *
 * The skill half is the other half of the same message: 命中 means the skill checklist applies,
 * and then the activation list must not be empty.
 *
 * WHY THE ROSTER IS INJECTED HERE AND NOT IN THE SYSTEM PROMPT
 *
 * 原来清单正文（§1.1.6 / §1.1.7 / §1.3 / §1.4 / 附录 A，约 21,000 字）常驻系统提示词，
 * **每一次请求都付**。用户的要求是：走到「判断技能清单」这个节点时才注入，正文随注入一起来。
 *
 * 所以这里注入 `skill-roster.mjs` 读出来的那份正文（6,145 字）。它按**摘要**去重：同一份清单
 * 在同一个会话里只注入一次，改了才重来 —— 否则一个长回合会把同一张表塞十几次。
 *
 * 已经登记过的技能只列名字与来源（`delivery.skills`），正文仍然不重复注入：正文是给
 * 「还没读过的那一份」用的。
 *
 * @param {object} delivery - normalized overlay.
 * @param {{owed?: boolean, entry?: object, roster?: string}} [meta] - whether an answer is still
 *   owed this turn, and the roster body to inject (absent = do not inject a roster).
 * @returns {string} a `<state_chain>` block.
 */
export function renderChain(delivery, meta = {}) {
  const skills = Array.isArray(delivery.skills) ? delivery.skills : []
  const chain = delivery.chain ?? { goalMatch: null, skillCheck: null }
  const lines = ['<state_chain>']
  lines.push('【状态链 · 每轮都要走】动手之前先答这两步，答案是工具调用，不是心里想一下：')
  lines.push('① 本轮是不是在推进一个长任务（目标分支）？')
  lines.push('   命中 → 目标必须完整：目标 / 验收标准 / 范围边界 / 已知约束。每轮都会随本块注入；执行途中发现计划不对，**可以改**（' + DELIVERY_TOOL + '）。')
  lines.push('   未命中 → 本轮不要求目标，但这一步照样要答。')
  lines.push('② 本轮要不要按技能清单执行（技能分支）？')
  lines.push('   命中 → **先把那份 skill 的完整正文读一遍**，再用 activateSkill 登记：技能名称 / 技能描述 / 针对本次任务的作用 / 来源（仓库链接或本地路径）。四项缺一不可。')
  lines.push('   未命中 → 本轮不按技能清单。')
  lines.push(`答法：${DELIVERY_TOOL}(action="judgeChain", payload={goalMatch: "matched"|"none", skillCheck: "hit"|"none"})`)
  // An unanswered chain is the ONE thing worth repeating inside the turn: the work tools are
  // actually held until it is answered, so a silent repetition would just look like a stuck turn.
  if (meta.owed === true) {
    lines.push('（本轮还没答 —— 在工作类工具被放行之前必须先答。这两条没有默认值。）')
  }

  // 清单正文：按摘要去重，只在变了或第一次时注入。
  const roster = typeof meta.roster === 'string' ? meta.roster : ''
  if (roster !== '') {
    lines.push('')
    lines.push('【技能清单 · 本机不存在 skill 文件，全部在线读。判类目 → 在线读正文 → activateSkill 登记。】')
    lines.push('')
    lines.push(roster)
    lines.push('')
    lines.push('【技能清单到此为止】')
  }

  if (skills.length > 0) {
    lines.push('')
    lines.push(`【已激活技能 · ${skills.length} 项】这些是**已经读过并登记过**的，本轮不必重读（豁免）；正文仍然不重复注入：`)
    for (const row of skills.slice(0, 8)) {
      lines.push(`- ${row.name} —— ${row.purpose}`)
      lines.push(`  来源：${row.source}`)
    }
    if (skills.length > 8) lines.push(`（还有 ${skills.length - 8} 项，见「技能」页）`)
    // 豁免的两个失效条件都写在这里，因为它们改变的是**这一份列表能不能信**。
    lines.push('一旦对某个技能的用法模糊，**去上面的来源读完整正文**，不要凭印象用。')
    lines.push('豁免失效的两种情形：① **上下文被压缩过** → 内容必然丢失，命中的 skill 必须**重新在线读一遍并重新登记**；② 来源那份**版本已变** → 以在线为准，重读。')
  }
  lines.push('</state_chain>')
  return lines.join('\n')
}

/**
 * Render the refusal the session gate returns when a session tries to act with no goal.
 *
 * This is a TOOL ERROR, not a system-prompt sentence, and that changes what it has to do. The
 * model reads it at the moment it wanted to act, so it must answer "why not", "what now", and
 * — because the gate has two exits and the model cannot see the state machine — "how do I get
 * out". A refusal that only says "blocked" would leave the model looping.
 *
 * @param {string} toolName - the call that was refused.
 * @param {object} entry - this session's counters.
 * @returns {string} refusal reason.
 */
export function renderGateRefusal(toolName, entry) {
  const lines = [
    `GOAL_GATE_REQUIRED: 这个会话还没有目标，所以「${toolName}」暂时不能执行。`,
    '',
    '这不是故障，是启动协议：动手之前先确定要交付什么。**你没有卡住，只需要先做一个选择**：',
    '',
    '1. **这是长期工作** → 先建目标，再动手。用 `create_goal` 写下：',
    '   - 目标、背景与交付结果（要完成什么、为什么做、最终得到什么）',
    '   - **验收标准至少一条**（怎样才算完成——没有它，「完成」无法判断），用 `' +
      DELIVERY_TOOL +
      '(action="addAcceptance")` 记下',
    '   - **范围边界**（不做什么——防止越做越大），用 `proposeScope`',
    '   - 已知约束（不能碰什么、必须用什么），用 `proposeConstraints`',
    '   缺哪项就先用 ask_user_question 问用户，不要自己替他填。',
    '2. **这是一次性问答或闲聊** → 用',
    `   \`${DELIVERY_TOOL}(action="declareNonTask", reason="…")\` 说清楚，然后继续。`,
    '   判据：不需要跨多轮、不需要验收标准、改坏了也无所谓——那就是闲聊。',
    '',
    '「你好」「解释一下 Promise」属于第 2 种，不该建目标；「重构这个项目」「修所有测试」属于第 1 种。',
    '',
    '在做出这个选择之前，只有下面这些还能用：目标工具、ask_user_question、todo_write。',
    '读代码、跑命令、改文件都要等到目标确定之后。',
  ]
  if (entry.gateBlocks >= 4) {
    // Escalation. By the fourth refusal the model is not thinking about the choice — it is
    // retrying the same call. Name that behaviour instead of repeating the same paragraph.
    lines.push('')
    lines.push(
      `（这是本会话第 ${entry.gateBlocks} 次被拦。重复调用同一个工具不会改变结果——` +
        '要么建目标，要么声明这是闲聊。如果判断不了，用 ask_user_question 问用户。）',
    )
  }
  return lines.join('\n')
}

/**
 * Render the refusal for a goal that exists but is not yet answerable.
 *
 * Distinct from `renderGateRefusal` on purpose: "you have no goal" and "your goal cannot say
 * when it is done" are different problems with different fixes, and a model that gets the
 * wrong one will create a second goal instead of filling in the first.
 *
 * @param {string} toolName - the call that was refused.
 * @param {string[]} missing - field names from `missingGoalFields`.
 * @param {object} entry - this session's counters.
 * @returns {string} refusal reason.
 */
export function renderIncompleteGoalRefusal(toolName, missing, entry) {
  const lines = [
    `GOAL_INCOMPLETE: 目标已经建了，但还缺 ${missing.length} 项，「${toolName}」暂时不能执行。`,
    '',
    `缺：${missing.join('、')}`,
    '',
    '先补齐再动手——现在补一句话，事后返工一整轮。',
    '',
    '  · **验收标准**：怎样才算完成？一条也算（`goal_delivery(action="addAcceptance", payload={description})`）。',
    '  · **范围边界**：什么不做？（`proposeScope`，included / excluded 任一非空即可）',
    '  · **已知约束**：不能碰什么、必须用什么？（`proposeConstraints`）',
    '',
    '后两项只能**提议**——范围与约束归用户决定（§24/§65），所以提出去就算你答过了，',
    '**不需要等他批准才继续**。真正没有约束的话，把「无」作为一条记下来，那也是答案。',
    '',
    '拿不准的**用 ask_user_question 问用户，不要自己替他定**——他要的和他想的不一样时，',
    '只有他能回答。',
  ]
  if (entry.gateBlocks >= 4) {
    lines.push('')
    lines.push(
      `（这是本会话第 ${entry.gateBlocks} 次被拦。缺的就是上面那几项，` +
        '重复调用工具不会让它们出现。）',
    )
  }
  return lines.join('\n')
}

/**
 * 状态链的门：本轮还没答那两步判断。
 *
 * 这是**每轮**都会拦一次的门，所以文案的重点不是「你违规了」，而是「这一步怎么做，一次就过」。
 * 一个每轮都会出现的拒绝如果说不清怎么过，就会变成模型每轮撞一次的墙 —— 那比不设门更糟。
 *
 * @param {string} toolName - the call that was refused.
 * @param {object} entry - this session's counters.
 * @returns {string} refusal reason.
 */
export function renderChainGateRefusal(toolName, entry) {
  const lines = [
    `STATE_CHAIN_REQUIRED: 本轮的状态链还没答，「${toolName}」暂时不能用。`,
    '',
    '两步都要答，一次调用答完：',
    '',
    `    ${DELIVERY_TOOL}(action="judgeChain", payload={goalMatch: "matched"|"none", skillCheck: "hit"|"none"})`,
    '',
    '① **goalMatch** — 本轮是不是在推进一个长任务？',
    '   命中 → 目标必须完整（目标 / 验收标准 / 范围 / 已知约束），而且每轮都会被注入回来；',
    '        执行途中发现计划不对，**可以改**：setTask / setFocus / setNext / addEvidence 等。',
    '   未命中 → 本轮不要求目标。这不是跳过，是另一个答案。',
    '',
    '② **skillCheck** — 本轮要不要按技能清单执行？',
    '   命中 → 先把那份 skill 的**完整正文**读一遍，再 activateSkill 登记四项：',
    '        技能名称 / 技能描述 / 针对本次任务的作用 / 来源（仓库链接或本地路径）。',
    '        没登记之前，工作类工具照样不能用 —— 否则「命中了」就只是一句没法核对的话。',
    '   未命中 → 直接答 none。',
    '',
    '答完这一轮就放行；下一轮会再问一次。',
  ]
  if (entry.chainBlocks >= 3) {
    lines.push('')
    lines.push(`（这是本会话第 ${entry.chainBlocks} 次被这一步拦。答它的工具就在上面那一行，别绕。）`)
  }
  return lines.join('\n')
}

/**
 * 待确认提案：把它从「躺在页面上等人去看」推到对话里。
 *
 * 用户的原话是，提案现在是「静默且异步地展示在控制台内」—— 它躺在目标中心等，用户不主动
 * 去看就永远不知道有人在等他拍板。这条提醒要做的是把那个「等」换成一次**当场要答案**。
 *
 * 为什么由宿主发，而不是在 propose 的工具描述里加一句「请记得问用户」：`propose` 那几条
 * 的描述已经那么写了，但描述是 guidance；这里的注入是在**检测到一件已经发生的事实**
 * （交付状态里真的躺着一条 pending 提案）之后说的。前者可以被忽略，后者不行（§67）。
 *
 * 只说一次（`entry.proposalsSurfacedIds`）：每个 step 重说一遍，这句提醒就变成了背景噪音，
 * 而它的全部价值就在于「它跳出来了」这件事。页面上那排按钮保留着当兜底 —— 模型万一没问，
 * 用户还有地方点。
 *
 * @param {Array<object>} rows - 待确认的提案行（原始交付状态里那几条）。
 * @returns {string} the notice block.
 */
export function renderProposalAsk(rows) {
  const lines = [
    '<proposal_ask>',
    `有 ${rows.length} 条变更提案在等你拍板 —— **现在就问，别等**：`,
    '',
  ]
  for (const row of rows) {
    const target = row.target === undefined || row.target === '' ? '' : ` · ${row.target}`
    lines.push(`- ${row.id}｜字段 ${row.field}${target}`)
    lines.push(`  拟改为：${row.proposed}`)
    if (row.current !== undefined && row.current !== '') lines.push(`  当前：${row.current}`)
    if (row.reason !== undefined && row.reason !== '') lines.push(`  原因：${row.reason}`)
  }
  lines.push('')
  lines.push('用 `ask_user_question` 把它交给用户选（它的选项会渲染成按钮，点一下就是答案）。')
  lines.push('拿到答案后**立刻**用 `goal_delivery` 的 `adoptProposal` / `rejectProposal` 落下去 ——')
  lines.push('用户答了而状态没变，等于没问。')
  lines.push('</proposal_ask>')
  return lines.join('\n')
}

/**
 * 技能清单的门：这一轮命中技能清单，但一条激活记录都没有。
 *
 * 单独一条拒绝文案的理由同 `renderIncompleteGoalRefusal`：**「你答了命中但什么都没登记」**和
 * **「你还没答」**是两个不同的问题，给出同一个理由会让模型去改错的地方。
 *
 * @param {string} toolName - the call that was refused.
 * @param {object} entry - this session's counters.
 * @returns {string} refusal reason.
 */
export function renderSkillGateRefusal(toolName, entry) {
  const lines = [
    `SKILL_LIST_EMPTY: 本轮答了「命中技能清单」，但一条激活记录都没有，「${toolName}」暂时不能用。`,
    '',
    '命中的意思是「这一轮要按某份 skill 来做」，那就要说清是哪一份、为什么：',
    '',
    `    ${DELIVERY_TOOL}(action="activateSkill", payload={`,
    '      name:        skill 名称，例如 luzzy-roster-design',
    '      description: 这个 skill 管什么',
    '      purpose:     针对**本次任务**的作用（不是它的简介）',
    '      source:      仓库链接或本地路径，让人能自己去读全文',
    '    })',
    '',
    '四项缺一不可 —— 缺任何一项，这条记录都答不出「为什么这一轮要用它」。',
    '登记的前提是**真的读完了那份 skill 的正文**：填不出来的那条就不要登记。',
    '',
    '**去读正文的工具是放行的**（read / glob / grep / skill）。这道门只为「读了没登记」而关，',
    '不为「还没读」而关 —— 先读，再登记，顺序本来就是这样。',
    '',
    '如果读完之后确认这一轮其实用不上，把 skillCheck 改成 "none" 才是诚实的答法。',
  ]
  if (entry.skillBlocks >= 3) {
    lines.push('')
    lines.push('（反复被这一步拦，通常是因为登记的是「我打算读」而不是读过的东西。）')
  }
  return lines.join('\n')
}

/**
 * The challenge for "answered skill-miss, but this turn changed files".
 *
 * WHY THIS EXISTS. §39 splits the chain's two branches: the harness supplies the deterministic
 * half, the model supplies the judgement. `skillCheck` is a judgement — so answering "none" is
 * legal and, until now, cost nothing at all. That is exactly the hole. Measured in this project's
 * own session: several turns answered "none" while editing this page's own JS, its stylesheet and
 * its app shell — which §1.1.6's own list calls 设计类 / HTML 网页开发 work. Nothing ever noticed,
 * because nothing compared the answer to the turn it was given in.
 *
 * It does NOT close the hole by judging. §38/§39 forbid that: the harness cannot tell a CSS change
 * that IS design work from one that is not, and a deterministic rule that guessed would be wrong
 * exactly where it mattered. So it does the other half of the split — it puts the FACT the model
 * could not have in front of the model ("you wrote these files and said no class applied") and
 * names the two concrete ways to discharge it. `activateSkill` is spelled out because a fix has to
 * be a call the model can actually make; naming the class here would be doing the judging.
 *
 * NOT A GATE. Answering "none" still refuses nothing and holds back no tool. It is a question,
 * asked at most once per turn — which is why it goes through the injection path rather than
 * through `tools/pre-execute`.
 *
 * @param {string[]} files - paths this turn wrote (already de-duplicated and capped).
 * @returns {string} the challenge block.
 */
export function renderSkillMissChallenge(files) {
  const shown = files.map((path) => `    - ${path}`).join('\n')
  return [
    `这一轮技能清单那一格你答的是「没命中」，但同一轮确实写过文件（${files.length} 处）：`,
    '',
    shown,
    '',
    '这两件事同时成立时，二选一，别就这么过去：',
    '',
    '  1. 如果其中某一类对得上，就登记它 —— ' +
      `${DELIVERY_TOOL}(action="activateSkill", payload={name, description, purpose, source})，四项都要写。`,
    '  2. 如果确实哪一类都对不上，就说清为什么：这些改动是「十七类」之外的什么活。',
    '',
    '这不是拒绝：答「没命中」依然合法，也没有任何工具因为这一步被拦住。只是「写过文件」和' +
      '「没命中」摆在一起时，两者里至少有一个值得再看一眼。',
  ].join('\n')
}

/**
 * Read a "this exchange is not a task" declaration out of a `goal_delivery` call.
 *
 * The model supplies the JUDGEMENT (§39) and this reads it out as a fact, so the gate never
 * has to parse prose. It is deliberately narrow: one action name, one required reason. A
 * loose matcher here would let a model escape the gate by accident, and the gate's whole
 * value is that escaping it is a deliberate act.
 *
 * @param {unknown} args - the tool call's arguments.
 * @returns {{reason: string}|null} the declaration, or null when this is not one.
 */
export function readNonTaskDeclaration(args) {
  if (typeof args !== 'object' || args === null) return null
  if (args.action !== 'declareNonTask') return null
  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  if (reason === '') return null
  return { reason }
}

/**
 * Render the "you are doing real work with no goal" nudge (AC-001).
 *
 * Deliberately a QUESTION with a decision procedure, not an instruction to create a goal. §6
 * forbids doing that for ordinary requests, and the harness cannot tell a refactor from an
 * explanation — only the model can. So the harness reports the fact it observed (mutating
 * tools ran) and hands the judgement back.
 *
 * There is also a TOOL for answering it (see `readNonTaskDeclaration`): when the session gate
 * is on, "ignore this" is no longer an option the model can take silently, because the gate
 * will keep refusing its next work tool. The nudge therefore has to name the exit, or the
 * model has a rule it cannot satisfy and no way to say so.
 *
 * @param {{toolCalls: number}} work - what `observeTurn` saw.
 * @param {number} [count] - which reminder this is (1-based). Only changes the wording.
 * @returns {string}
 */
export function renderGoalNudge(work, count = 1) {
  const lines = [
    '<goal_hint>',
    `本次会话已经跑了 ${work.toolCalls} 次工具调用并改动了工作区，但还没有目标。`,
    '如果这是一件需要跨多轮、可恢复、可中断的长期工作，现在建一个目标：调用 create_goal，',
    '并在目标里写清「什么条件满足才算完成」——没有验收标准，完成与否无法判断。',
    '建完目标后用 goal_delivery 记下范围与验收标准。',
    '',
    '如果只是一次性的问答或闲聊，别沉默地忽略这条——用',
    '`goal_delivery(action="declareNonTask", reason="…")` 明确说一句，然后照常继续。',
    '（判据：不需要跨多轮、不需要验收标准、改坏了也无所谓——那就是闲聊。）',
  ]
  if (count > 1) {
    lines.push('')
    lines.push(
      `（这是本会话第 ${count} 次提醒。上一次没有回应，而工作区一直在被改动——` +
        '如果确实没有目标，就用上面那个工具说清楚；有目标就现在建。）',
    )
  }
  lines.push('</goal_hint>')
  return lines.join('\n')
}

// ---------------------------------------------------------------- layer 4: preflight

/**
 * Install the enforcement hooks.
 *
 * Everything is registered through `ctx.on` / `ctx.tools.register`, so unloading the plugin
 * removes it — the same reversibility rule the rest of this plugin follows.
 *
 * @param {object} ctx - host context.
 * @param {object} deps - `{paths, options, artifacts}` where `artifacts` resolves a
 *   session's cwd and projection state.
 * @returns {{stats: () => object}} a live view of what the enforcement did.
 */
export function installEnforcement(ctx, deps) {
  const options = { ...DEFAULT_ENFORCE_OPTIONS, ...(deps.options ?? {}) }
  const { paths } = deps
  const stats = {
    preflight: 0,
    preflightMiss: 0,
    /**
     * 技能清单：注入了几次 / 按摘要跳过了几次 / 读不出来几次。
     *
     * 这三个是**模块级**的，不是每会话的（`entry` 那份是 per-session 的）。第一版写错了位置 ——
     * 加进了 `entry`，于是 `stats.rosterInjected += 1` 在给一个不存在的字段自增，
     * `stats()` 里读到 `undefined`，而测试报的是「清单没注入」。
     * 位置错了不会报错，只会让计数永远是 0/undefined。
     */
    rosterInjected: 0,
    rosterSkipped: 0,
    rosterMiss: 0,
    reconcileOffered: 0,
    reconcileSkipped: 0,
    goalNudged: 0,
    completionRejected: 0,
    completionAccepted: 0,
    driftDetected: 0,
    evidenceMissing: 0,
    revisionConflict: 0,
    /**
     * §86's list stops at "goal.preflight.count / miss". This is the v2 counterpart: how often
     * a session was actually HELD at the gate. A gate whose count is always zero is not a gate.
     */
    gateBlocked: 0,
    /** Sessions that reached the gate and answered "this is not a task". */
    nonTaskDeclared: 0,
    /** Injections that fired because the goal revision moved, not because the interval did. */
    preflightOnChange: 0,
    /**
     * 状态链那两道新门的计数。§87 说的正是这个：**只看「调了几次工具」证明不了系统在转**，
     * 要看的是「判断覆盖率」与「门真的拦下过吗」。一个计数恒为零的门不是门。
     */
    chainBlocked: 0,
    skillBlocked: 0,
    chainJudged: 0,
    /**
     * 「答了没命中、但这一轮确实改了文件」被追问过多少次。
     *
     * 与 `skillBlocked` 是**两件事**，所以是两个计数：那道门数的是「答了命中却不登记」，
     * 这一个数的是「答了没命中却改了文件」。后者不拦任何东西 —— 追问是成本，不是拒绝 ——
     * 所以它唯一的价值就是**让「到底问过没有」变成一个可以看的数字**：恒为零说明这条挑战
     * 从来没触发过，而它本该在每一轮这么答的时候都触发一次。
     */
    skillMissChallenged: 0,
  }

  // ---- layer 4: orient the model before it works ---------------------------
  //
  // The brief is explicit that this is the load-bearing layer (§10: "这是核心"). It is also
  // the one place where the brief asks for two things that look contradictory until you read
  // both: §10/§46 require a substantive turn to OBSERVE the goal state, and §82/§83 require
  // orientation to stay at "small fixed overhead". The reconciliation is that the OBSERVATION
  // is mandatory and cheap — a ~500-byte block — while the ARTIFACT is what must never be
  // dumped every turn (§68 方案 B).
  //
  // §13 settles what "every turn" means: a trivial turn ("继续") must still READ, but need
  // not WRITE. So this fires on every turn that has a live goal, and the COST is controlled
  // by the step interval rather than by skipping turns outright.
  //
  // Failure to read the plan is NOT fatal here. The gate is the fail-closed surface; a
  // preflight that cannot read is recorded as a miss and injection is skipped, because
  // refusing to start a step the model could otherwise do useful work in would be the wrong
  // trade. (Contrast `tools/pre-execute`, where unreadable state MUST refuse.)
  if (options.preflight) {
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      // Same reasoning as the commit barrier: a step on an aborted turn is about to be thrown
      // away, so injecting into it spends tokens on a message nobody will read as intended.
      if (signal?.aborted === true) return decision
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string') return decision

      const entry = counterFor(sessionId)

      // ---- 状态链：每一轮都要走 ----------------------------------------------
      //
      // 「每轮」的判据是**用户那条消息换了**，不是 step 归零 —— step 的行为在不同进入路径下没有
      // 保证，而「用户又说了一句」是一个确定的事实。拿消息 id 当轮次身份是安全的：id 由宿主铸造，
      // 一条没有 id 的消息会把整个会话写坏（§5.31），所以这个字段一定在。
      //
      // **只有「人说的话」才算一轮。** 判据不是「role === 'user'」—— 宿主往对话里插的东西
      // 有一大半也是 user 角色：
      //
      //   source.kind = user              人在键盘上打的                ← 只有这个是「一轮」
      //   source.kind = plugin            本插件自己的注入
      //   source.kind = goal              宿主的 <goal_state> 注入
      //   source.kind = agent-instructions  工作区规范文件的注入
      //   source.kind = session-reference / team-message / tool / model
      //
      // 这是宿主给每条消息盖的来源章（`dsh-session-format` 的 messageSourceValue 逐个校验），
      // 所以按它判是**确定性的**，不是启发式。
      //
      // 原来只排除 `plugin`，于是宿主的每一个 <goal_state> 注入都被认成「用户又说了一句」：
      // 链在同一个回合里自己给自己续期。实测（本会话）：一个回合里连着被拦 5 次，每次都得把
      // 两道分支重答一遍 —— 而那 5 次里人只说了一句话。用户接受的是「每轮答一次」，不是
      // 「每次注入答一次」。
      //
      // 没有 source 的消息**保留成候选**：认不出来的时候宁可多问一次，也不要让门悄悄失效 ——
      // 「门不再触发」是这套设计里唯一在页面上看不出来的失败。
      const turnOwnerId = (() => {
        for (let i = decision.messages.length - 1; i >= 0; i -= 1) {
          const message = decision.messages[i]
          if (message?.role !== 'user') continue
          const kind = message?.source?.kind
          if (kind !== undefined && kind !== 'user') continue
          if (typeof message.id === 'string') return message.id
        }
        return null
      })()
      const newTurn = turnOwnerId !== null && turnOwnerId !== entry.lastUserMessageId
      if (newTurn) {
        entry.lastUserMessageId = turnOwnerId
        // 新的一轮 = 链要重新答一遍。这是「每次对话都要执行状态链」的运行时那一半：
        // 注入负责说，这个标记负责**锁**（门在 tools/pre-execute 里）。
        entry.chainPending = true
        // 上一轮的技能答案与「问过没有」一起作废。不清的话会出现最坏的一种：上一轮答了
        // 没命中，这一轮**还没答**就先被追问一遍 —— 追问的是上一轮的答案，而模型这一轮
        // 什么都没说。清理本身是确定的：`lastSkillCheck` 只在 judgeChain 成功那一步写入，
        // 而这一轮还没答，它就该是空。
        entry.lastSkillCheck = null
        entry.skillMissChallenged = null
      }

      const resolved = liveGoalFor(ctx, agent)
      const hasGoal = resolved.state === 'ok' && resolved.goal !== undefined

      // 没有目标时：仍然要先算「要不要提醒建目标」，但它不再是这条路的分叉点 —— 链在有目标和
      // 没目标两种情况下都要注入（用户的要求：每次对话都走状态链，没命中也要答）。
      let nudge = null
      if (!hasGoal) {
        stats.preflightMiss += 1
        entry.preflightMisses += 1
        // ---- AC-001: a long task should get a goal --------------------------
        //
        // §6 asks the harness to decide whether the request is long-running work; §39 puts
        // "is this a long task?" in the MODEL-JUDGEMENT column instead. The split is: the
        // harness supplies the DETERMINISTIC half of the signal — the session log shows real
        // mutating work — and the model makes the semantic call about whether it is a durable
        // goal.
        //
        // So this does not create a goal. It tells the model that work is happening with no
        // goal attached and asks it to judge. Auto-creating would be worse than useless: §6 is
        // explicit that "你好" and "帮我解释一下 Promise" must NOT get one, and a rule that
        // fires on tool calls alone cannot tell those apart from a refactor.
        //
        // v1 rate-limited this to ONCE PER SESSION, and that was wrong in the case it exists
        // for. A model that declines while it is still gathering context silences the reminder
        // for the rest of the session, so the session ends with no goal by ACCIDENT rather than
        // by decision — and the whole point of AC-001 is that the choice gets made. Now the
        // reminder is per PHASE: it re-asks once the session has moved on, while still not
        // repeating on every step (§83's token discipline).
        // 这一段原来在「没有目标」的分支里直接 return，于是没有目标时链就不会下发 —— 那正好
        // 与用户要的两条分支相反。现在它只决定 remind 的内容，注入统一在下面合成。
        if (step - entry.lastGoalNudgeStep >= options.goalReminderEverySteps) {
          const work = observeTurn(agent)
          if (work.wroteFiles || work.ranCommand) {
            entry.lastGoalNudgeStep = step
            entry.goalNudgeCount = (entry.goalNudgeCount ?? 0) + 1
            stats.goalNudged += 1
            nudge = renderGoalNudge(work, entry.goalNudgeCount)
          }
        }
      }
      // ---- injection policy: WHY to inject, not just how often --------------
      //
      // A fixed interval is the wrong shape for the two cases that matter. It cannot say "the
      // goal just changed, tell the model NOW", and it cannot say "this is the first turn, the
      // model has certainly not seen this goal yet". Both of those want an injection
      // REGARDLESS of the step counter, and both are cheap to detect deterministically:
      //
      //   initial   the session has never been oriented
      //   on-change the goal's revision differs from the one last injected
      //   interval  the fallback, for a long turn that is simply still running
      //
      // §83 still governs: these are reasons to fire, not a licence to fire constantly. The
      // revision case is self-limiting (revisions change when something changed), and the
      // interval case is the throttle the model already had.
      const lastRevision = entry.lastInjectedRevision
      const thisRevision = hasGoal ? resolved.goal.revision : null
      const isInitial = entry.preflights === 0
      const changed = hasGoal && lastRevision !== null && lastRevision !== thisRevision
      const dueByInterval =
        !(entry.lastPreflightTurn === turn && step - entry.lastPreflightStep < options.preflightEverySteps)
      // 新的一轮一定下发目标（用户要的「每轮注入」）；一轮之内的重复仍然交给节流，否则一个长
      // 回合会把同一份计划重复塞十几次，那正是 §83 说的浪费。
      const goalDue = hasGoal && (newTurn || isInitial || changed || dueByInterval)
      // 压缩检测放在这里而不是渲染函数里：它读的是消息数组，而渲染函数只该管排版。返回值是
      // 最新的 checkpoint id —— 「发生过压缩」一旦为真就永远是它自己，所以消费的是一个**新**
      // 的 id，不是「是否存在」（见 `compactionCheckpoint`）。
      const compactionId = compactionCheckpoint(decision.messages)
      // 链该不该说：新一轮要说，本轮还没答（比如刚被门拦下）也要说。
      const chainDue = newTurn || entry.chainPending

      // ---- 技能漏判挑战：这一轮改过文件，却说「没有命中任何技能清单」---------
      //
      // 见 `renderSkillMissChallenge` 的长说明。这里是**触发条件**：本轮答了 none，且本轮确实
      // 写过文件。两件事必须同时成立 —— 只答 none 而没干活（纯问答）不该被追问，改了文件而
      // 没答 none（答了命中、或答了匹配）也不该。
      //
      // 代价纪律（§83）：`observeTurn` 只在「这一轮答过 none」时才调用，而那是一个不常发生的
      // 分支；其余情况下这一步是两次内存读取。也不去读交付状态 —— `lastSkillCheck` 就是同一次
      // judgeChain 写进交付状态的那个值的原文。
      //
      // 一次一轮：`skillMissChallenged` 存轮次号，真的注入了才落（下面 parts 那一段）。所以
      // 「读了一遍但发现不满足」不会被误记成问过 —— 那种情况的意思正是「这一轮还没写过文件」，
      // 而后面的步骤真写了，条件就会再进来一次。
      let skillMiss = null
      if (entry.lastSkillCheck === 'none' && entry.skillMissChallenged !== turn) {
        const work = observeTurn(agent)
        if (work.files.length > 0) skillMiss = work.files
      }

      if (!chainDue && !goalDue && nudge === null && skillMiss === null) return decision

      // 三块（链 / 目标 / 技能）说的是同一份状态，只读一次：读两遍除了多一次 IO，还会在两次读
      // 之间留一个不一致的窗口 —— 而这是每轮都要走的路径。
      let delivery = null
      if (chainDue || goalDue) {
        const read = readDeliveryOverlay(paths, sessionId)
        if (!read.ok) {
          stats.preflightMiss += 1
          entry.preflightMisses += 1
          // 读不出来就不注入。但**不清 chainPending**：「我读不出来」不等于「模型答过了」，
          // 门会继续持有工作类工具，模型只能去解决读不出来的原因。
          if (nudge === null) return decision
        } else {
          delivery = read.delivery
        }
      }

      // ---- 技能清单：按摘要去重，压缩后重来 --------------------------------
      //
      // 清单正文 6,145 字，只在**这个节点**注入（原来它常驻系统提示词，约 21,000 字、每轮都付）。
      //
      // 去重按**摘要**：同一份清单在一个会话里只注入一次，改了才重来 —— 否则一个长回合会把同一张
      // 表塞十几次，那正是 §83 说的浪费。
      //
      // 压缩后摘要要作废：上下文被压缩意味着模型手上那份已经没了，清单必须重来一次。判据是
      // 确定性的 —— 出现一个新的 compaction checkpoint（同一个 `compactionId` 只消费一次）。
      let roster = null
      if (chainDue) {
        const compactionId = compactionCheckpoint(decision.messages)
        if (compactionId !== null && compactionId !== entry.rosterCompactionId) {
          entry.rosterCompactionId = compactionId
          entry.lastRosterDigest = null
        }
        const loaded = readRoster()
        if (loaded.error === null) {
          if (loaded.digest !== entry.lastRosterDigest) {
            roster = loaded.text
            entry.lastRosterDigest = loaded.digest
            stats.rosterInjected += 1
          } else {
            stats.rosterSkipped += 1
          }
        } else {
          // 读不出来就**不注入**，但要让它可见：少一张表不该安静地发生。
          //
          // 这里不调 `report()`：**这个模块从来没有过日志出口**，它把诊断全部放在计数里
          // （`stats` + `entry`，见文件顶部的计数块）。加一个 import 进来的日志函数，会让
          // 这个「只计数」的约定出现第一个例外，而例外一旦有了第二个就没人记得住。
          // 页面的诊断区读 `readCounters()`，`rosterMiss` 在那里看得见。
          stats.rosterMiss += 1
        }
      }

      // ---- 合成一条消息，而不是三条 ------------------------------------------
      //
      // 一次一步里插三条 notice，模型读到的是三段互不相干的独白；合成一条，读到的是一次
      // 「这一轮的处境」。顺序也是有意的：链在前（它决定这一轮怎么开工），目标在中，技能在链
      // 里（`renderChain` 自己带已注册技能的名字与来源），提醒在最后。
      const parts = []
      let summary = '没有目标'
      if (chainDue && delivery !== null) {
        parts.push(renderChain(delivery, { owed: entry.chainPending, roster: roster }))
        summary = '状态链'
      }
      if (goalDue && delivery !== null) {
        entry.lastPreflightTurn = turn
        entry.lastPreflightStep = step
        entry.preflights += 1
        entry.lastInjectedRevision = thisRevision
        stats.preflight += 1
        if (changed) stats.preflightOnChange += 1

        const artifact = deps.artifacts?.describe(sessionId) ?? undefined
        // 全文什么时候回来 —— 四个触发点，见 options.preflightFullEvery。压缩事件在这里消费
        // 并落 `lastCompactionId`：checkpoint 会留在消息里，不记 id 就会每一步都重新内联。
        const compacted = compactionId !== null && compactionId !== entry.lastCompactionId
        if (compacted) entry.lastCompactionId = compactionId
        // 压缩态必须真的说清目标是什么，否则它不比没有好。两个字段都空 → 无条件内联原文，
        // 这是「忘记目标」在本策略下不可达的那一道保险。
        const statementEmpty =
          String(delivery.goalSummary ?? '').trim() === '' && String(delivery.expectedOutput ?? '').trim() === ''
        const fullDue =
          isInitial || changed || compacted || statementEmpty ||
          entry.preflights - entry.lastFullPreflight >= options.preflightFullEvery
        if (fullDue) entry.lastFullPreflight = entry.preflights
        // A revision the model has not seen is the one case where "what changed" is worth the
        // bytes: the block already carries the revision, and saying WHY it is being repeated
        // stops the model from reading a second injection as noise.
        parts.push(
          renderPreflight(delivery, resolved.goal, {
            artifactPath: artifact?.path,
            changedSinceLastInjection: changed,
            full: fullDue,
          }),
        )
        if (summary !== '状态链') summary = changed ? '目标已更新' : '目标状态'
      }
      if (nudge !== null) parts.push(nudge)

      // 技能漏判挑战排在这里（链 / 目标 / 提醒之后，提案之前）。理由只有一条：**摘要那一行
      // 的优先级**。链在的时候摘要是「状态链」，目标在的时候是「目标状态」—— 这两句比「技能
      // 漏判」更能说明这一步为什么有内容，所以挑战放在它们后面，让它的摘要只在**没有别的
      // 理由**时才顶上来。
      if (skillMiss !== null) {
        entry.skillMissChallenged = turn
        stats.skillMissChallenged += 1
        parts.push(renderSkillMissChallenge(skillMiss))
        if (summary === '没有目标') summary = '技能漏判'
      }

      // ---- 待确认提案：推到对话里，而不是躺在页面上等 ------------------------
      //
      // 这里**不需要额外的读取触发**：提案是 `propose*` 写的，而任何一次交付状态写入都会
      // 让 revision 变，于是下一步 `changed` 就为真、`goalDue` 就已经把 delivery 读进来了。
      // 换句话说，代理提完的**下一步**就会看到这一块。
      if (delivery !== null && Array.isArray(delivery.proposals)) {
        const pending = delivery.proposals.filter((row) => row.pending === true)
        const fresh = pending.filter((row) => entry.proposalsSurfacedIds.indexOf(row.id) === -1)
        if (fresh.length > 0) {
          for (const row of fresh) entry.proposalsSurfacedIds.push(row.id)
          parts.push(renderProposalAsk(fresh))
          if (summary === '没有目标') summary = '待确认提案'
        }
      }

      if (parts.length === 0) return decision
      const notice = pluginNotice(parts.join('\n\n'), summary)
      // WHERE the notice goes, and why it is not the tail.
      //
      // This used to append to the end of `decision.messages`. The core's own context-injecting
      // plugin (`dsh-agent-instructions`) does something different and deliberate: it inserts
      // AFTER THE LAST MESSAGE THIS TURN CLAIMED —
      //
      //     const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m))
      //     decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
      //
      // — so the injected block sits immediately after the user message it is orienting, and
      // whatever the loop appended after that (steering messages, other plugins' context) keeps
      // its position. Appending at the tail instead would put this block after those, i.e. it
      // would read as the newest thing in the turn rather than as context for the request.
      //
      // Matching the core is also the KV-friendly choice: the same convention means the same
      // cache prefix shape as the built-in path, instead of a second insertion point that
      // diverges on every turn.
      //
      // `messages` is this step's claimed set (the waterfall's own argument). If nothing matches
      // — a synthetic turn with no claimed user message — fall back to the tail rather than
      // dropping the notice: an orientation that never arrives is worse than one slightly late.
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message))
      const insertedAt = lastClaimedIndex < 0 ? decision.messages.length : lastClaimedIndex + 1
      return {
        ...decision,
        messages: decision.messages.toSpliced(insertedAt, 0, notice),
      }
    })
  }

  // ---- the session gate ----------------------------------------------------
  //
  // THE v2 UPGRADE. Everything above ORIENTS: it tells the model where the goal stands and
  // asks it to notice. That is guidance. This is the part that makes the layer a gate.
  //
  // The placement is the whole design, and it is NOT where the brief's §8 sketch puts it.
  // A `reject` from `agent/pre-step` does not refuse an action — the loop turns it into
  // `turnEnds = {kind:'blocked'}` and ends the TURN before the model ever speaks
  // (`dsh-agent-loop` L937-944). So gating at pre-step gives the user a dead turn instead of
  // the goal interview the brief actually wants. Denying at `tools/pre-execute` instead
  // returns the refusal as that call's error result, and the model keeps talking in the same
  // turn — which is what makes "block the action, allow the conversation" possible at all.
  //
  // A gate is only a gate if it can refuse. The three answers it accepts:
  //   1. the session has a goal                      -> let everything through
  //   2. the model declared this a non-task exchange -> let everything through, and remember
  //   3. anything else                               -> refuse the call, say how to proceed
  //
  // (2) exists because §39 puts "is this a long task?" in the MODEL-JUDGEMENT column, and
  // §6 is explicit that "你好" must not be forced into a goal. The harness contributes the
  // deterministic half: it owns the state machine and the refusal, and it reads the model's
  // answer out of a tool call rather than out of prose (see `declareNonTask`).
  if (options.sessionGate) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind !== 'allow') return decision
      if (exec.agent === undefined) return decision
      const sessionId = exec.agent.session?.id
      if (typeof sessionId !== 'string') return decision
      const entry = counterFor(sessionId)

      // The exits are tools, so they must pass BEFORE the gate can refuse anything — including
      // the refusal's own escape hatch (`ask_user_question`). Refusing those would deadlock:
      // the model could not create the goal it is being asked for.
      if (GATE_PASS_TOOLS.has(exec.name)) {
        // Reading or writing the goal is itself the answer to "does this session have one".
        if (exec.name === 'goal_delivery' || exec.name === 'create_goal') entry.gateSatisfiedAt = Date.now()
        // ...and declaring "this is not a task" is the OTHER answer. It has to be readable
        // from a tool call rather than from prose: a model that says "this is just a chat" in
        // a sentence and then edits a file anyway must still be held, and text matching over
        // free-form reasoning is exactly the fragile judgement §39 hands to the model. An
        // explicit, well-formed call is a deterministic fact the harness can trust.
        if (exec.name === 'goal_delivery' && readNonTaskDeclaration(exec.arguments) !== null) {
          if (!entry.nonTaskDeclared) stats.nonTaskDeclared += 1
          entry.nonTaskDeclared = true
        }
        return decision
      }

      const resolved = liveGoalFor(ctx, exec.agent)
      const read = readDeliveryOverlay(paths, sessionId)

      // ---- 门 1：状态链（每轮一次） -------------------------------------------
      //
      // 这是用户要的第二道门，与目标门长在同一个 seam 上：**必须有这个判断，不然直接锁工具**。
      // 之所以能这么做门，是因为拒绝发生在 tools/pre-execute —— 对话没断，模型收到拒绝后照常
      // 在同一轮里回答并继续（见本节开头关于 pre-step 的说明）。
      //
      // 判据在内存里（`chainPending`，在 pre-step 每轮置位），不读持久状态：**「本轮答没答」是
      // 运行时事实**，存到盘上会变成一个可能来自上周的陈旧标记，而那正是最危险的一类错。
      if (entry.chainPending) {
        stats.chainBlocked += 1
        entry.chainBlocks += 1
        return { kind: 'deny', reason: renderChainGateRefusal(exec.name, entry) }
      }

      if (read.ok) {
        const chain = read.delivery.chain ?? { goalMatch: null, skillCheck: null }

        // ---- 门 2：目标（只在命中分支上） -------------------------------------
        //
        // 两条分支的分岔就在这里：命中 → 目标必须完整；未命中 → 本轮不要求目标。后者是用户
        // 明确要的（「其二分支时允许 Agent 无需强制填写目标」），所以它不是漏洞，是另一半设计。
        if (chain.goalMatch !== 'none') {
          if (resolved.state === 'ok' && resolved.goal !== undefined) {
            // A goal EXISTS — but a goal with no acceptance criteria, no scope and no constraints
            // cannot answer "when is this done", so opening the gate on it would just move the
            // failure later, to the completion gate, after the work is already built. The brief's
            // §20 refuses completion on an empty plan; refusing to START on one is the same check
            // applied where it is still cheap to act on. This is the "必须填补所有缺失项" rule.
            const missing = missingGoalFields(read.delivery)
            if (missing.length === 0) {
              // 目标这一关过了 —— 但不 return，技能那一关还没查（见下）。
            } else {
              stats.gateBlocked += 1
              entry.gateBlocks += 1
              return { kind: 'deny', reason: renderIncompleteGoalRefusal(exec.name, missing, entry) }
            }
          } else if (!entry.nonTaskDeclared) {
            // A session whose goal was deleted mid-flight is back at the gate. That is deliberate:
            // "no goal" is the condition, not "never had one".
            stats.gateBlocked += 1
            entry.gateBlocks += 1
            return { kind: 'deny', reason: renderGateRefusal(exec.name, entry) }
          }
        }

        // ---- 门 3：技能清单（只说「命中」不算） -------------------------------
        //
        // 「必须有这个判断，不然直接锁工具」在这里的下半句是：**判断成命中之后，登记也要真的
        // 发生**。否则 skillCheck="hit" 就是一句无法核对的话，而它的全部价值就在于可核对。
        // 读正文的那一族必须过门 —— 否则「先读再登记」这句话在这道门底下根本做不到。
        // 见 `SKILL_GATE_PASS_TOOLS` 的注释：那是一次实测到的死锁，不是理论风险。
        if (chain.skillCheck === 'hit' && read.delivery.skills.length === 0 && !SKILL_GATE_PASS_TOOLS.has(exec.name)) {
          stats.skillBlocked += 1
          entry.skillBlocks += 1
          return { kind: 'deny', reason: renderSkillGateRefusal(exec.name, entry) }
        }
        return decision
      }

      // 读不出交付状态时不放行：门的价值就在于「我查不到」不能等于「那就上吧」。
      if (entry.nonTaskDeclared) return decision
      stats.gateBlocked += 1
      entry.gateBlocks += 1
      return { kind: 'deny', reason: renderGateRefusal(exec.name, entry) }
    })
  }

  // ---- the completion gate -------------------------------------------------
  //
  // `tools/pre-execute` runs before the tool body, so a denied `complete` never reaches
  // `ctx.goals.complete()`: the goal stays active and the model receives the refusal as the
  // call's error result, which is exactly the "then the Agent continues working" behaviour
  // the brief asks for.
  //
  // Fail-CLOSED. If the overlay cannot be read, completion is refused rather than allowed —
  // the whole point of the gate is that "I could not check" must not mean "go ahead".
  if (options.blockCompletion) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind !== 'allow') return decision
      if (exec.name !== 'update_goal') return decision
      const args = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}
      if (args.action !== 'complete') return decision
      if (exec.agent === undefined) return decision

      const sessionId = exec.agent.session?.id
      const read = readDeliveryOverlay(paths, sessionId)
      if (!read.ok) {
        stats.completionRejected += 1
        return {
          kind: 'deny',
          reason:
            `${read.code}: 交付状态读不出来（${read.reason}），因此无法确认验收标准是否满足，不能标记完成。` +
            '请先用 goal_delivery 检查状态，或向用户说明这一情况。',
        }
      }

      const resolved = liveGoalFor(ctx, exec.agent)
      const goal = resolved.state === 'ok' ? resolved.goal ?? null : null
      const gate = completionGate(read.delivery, goal)
      if (gate.allowed) {
        stats.completionAccepted += 1
        return decision
      }

      stats.completionRejected += 1
      // §86 / §87 name "evidence coverage" as one of the things worth watching, alongside
      // preflight and reconciliation coverage. The gate already computes WHICH criteria lack
      // evidence; counting it turns "completion was refused" into "completion was refused
      // because evidence was missing", which is the actionable half — a refusal caused by an
      // unverified criterion is work in progress, a refusal caused by missing evidence is a
      // process gap.
      if (gate.missingEvidence.length > 0) stats.evidenceMissing += 1
      return { kind: 'deny', reason: renderCompletionRefusal(gate) }
    })
  }

  // ---- 状态链的收尾：答成功了才清「本轮欠答」 ------------------------------
  //
  // 为什么在 post-execute 而不是在门的开头猜参数：门的职责是「答了没有」，而**答成功没有**只有
  // 结果知道。在门里看到 `action === "judgeChain"` 就把标记清掉，会让一次被拒的调用（缺字段、
  // 写盘冲突）也算作答过 —— 于是链门在最重要的情况下自己放开。
  //
  // 状态从工具自己渲染的文本里读（`goal-tools.mjs` 的 render 把 JSON 拼在状态词后面），
  // 先用 JSON 里的 "status"，再退回行首的状态词。两种形状都不认就当成没答过：**保守方向是
  // 保持门关着**，因为门的另一边是「模型可以一边说不清这一轮要干什么一边改文件」。
  const readToolStatus = (parts) => {
    if (!Array.isArray(parts)) return null
    const text = parts.map((part) => (part?.type === 'text' ? part.text : '')).join('').trim()
    if (text === '') return null
    const inJson = text.match(/"status"\s*:\s*"(ok|refused|error)"/)
    if (inJson !== null) return inJson[1]
    const asPrefix = text.match(/^(ok|refused|error)\s*:/)
    return asPrefix === null ? null : asPrefix[1]
  }

  if (options.sessionGate) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== DELIVERY_TOOL) return decision
      if (exec.agent === undefined) return decision
      const sessionId = exec.agent.session?.id
      if (typeof sessionId !== 'string') return decision
      const entry = counterFor(sessionId)
      if (!entry.chainPending) return decision
      const args = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}
      if (args.action !== 'judgeChain') return decision
      if (readToolStatus(decision.content ?? result?.content) !== 'ok') return decision
      entry.chainPending = false
      entry.chainJudgements += 1
      stats.chainJudged += 1
      // 顺手记下模型答的**技能那一格**：预检那一步要据此问一句「你答了没命中，可这一轮改了
      // 文件」。原文就在手里，存一份比让预检再去读一次交付状态便宜，也不会有两次读之间的
      // 不一致窗口。取值只认那两个合法值，其余（字段写错、拼错）一律当没答过 —— 保守方向是
      // **不追问**：追问是成本，不是门。
      const payload = typeof args.payload === 'object' && args.payload !== null ? args.payload : {}
      entry.lastSkillCheck =
        payload.skillCheck === 'hit' || payload.skillCheck === 'none' ? payload.skillCheck : null
      return decision
    })
  }

  // ---- layer 2: augment get_goal -------------------------------------------
  //
  // `content` rather than `value`: replacing the value would re-validate it against
  // `get_goal`'s declared schema, which has `additionalProperties: false` and would reject
  // the extra block. Content replacement has no schema validation by design — the hook is
  // documented as the way to reshape what the model reads.
  if (options.augmentGetGoal) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'get_goal') return decision
      if (exec.agent === undefined) return decision
      if (decision.kind !== 'accept') return decision

      const sessionId = exec.agent.session?.id
      const read = readDeliveryOverlay(paths, sessionId)
      if (!read.ok) return decision

      const resolved = liveGoalFor(ctx, exec.agent)
      const goal = resolved.state === 'ok' ? resolved.goal ?? null : null
      const artifact = deps.artifacts?.describe(sessionId) ?? undefined
      const block = deliverySummary(read.delivery, goal, {
        artifactPath: artifact?.path,
        counters: options.reconcile ? readCounters(sessionId) : undefined,
      })

      const base = decision.content ?? result.content
      const text = base.map((part) => (part.type === 'text' ? part.text : '')).join('')
      let original = null
      try {
        original = JSON.parse(text)
      } catch {
        // Not the compact JSON this tool is known to emit — leave it alone rather than
        // wrapping something we do not understand.
        return decision
      }
      if (typeof original !== 'object' || original === null) return decision

      return {
        kind: 'accept',
        content: [{ type: 'text', text: JSON.stringify({ ...original, delivery: block }) }],
        ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
      }
    })
  }

  // ---- the commit barrier --------------------------------------------------
  //
  // Runs when a turn is about to end. If the round did real work and the plan did not move,
  // the model is asked once — via `steer`, the only mechanism that actually keeps the turn
  // open — to reconcile. Bounded per turn and per session, and it never fires on a turn that
  // produced nothing.
  if (options.reconcile) {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      // A CANCELLED TURN MUST NOT BE ASKED TO RECONCILE.
      //
      // The loop calls `throwIfAborted()` immediately AFTER this dispatch, so a steer issued
      // here during cancellation is not just pointless — it is actively harmful. The abort
      // unwinds, the steered message stays in `next-step`, and it is drained at the next
      // opportunity: the model gets told to go reconcile a turn that was cancelled, and the
      // session has spent one of its eight reconciliations on it. `signal.reason` is the
      // caller's cancel cause; either way, an aborted turn has no progress to reconcile.
      if (signal?.aborted === true) {
        stats.reconcileSkipped += 1
        return
      }
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string') return
      const entry = counterFor(sessionId)

      if (entry.turnsSinceReconcile > 0) {
        // One reconciliation per turn. Without this the steer would open a step, trip the
        // barrier again, and repeat until the session budget ran out — burning rounds on
        // bookkeeping rather than work.
        stats.reconcileSkipped += 1
        entry.turnsSinceReconcile = 0
        return
      }
      if (entry.reconciliations >= options.maxReconciliations) {
        stats.reconcileSkipped += 1
        return
      }
      const now = Date.now()
      if (now - entry.lastReconcileAt < options.minReconcileIntervalMs) {
        stats.reconcileSkipped += 1
        return
      }

      const signals = observeTurn(agent)
      if (!signals.changed) {
        // A turn that only read, answered a question or did nothing is exactly the case the
        // brief says must NOT be forced to rewrite its plan.
        stats.reconcileSkipped += 1
        return
      }

      const read = readDeliveryOverlay(paths, sessionId)
      if (!read.ok) return
      const resolved = liveGoalFor(ctx, agent)
      if (resolved.state !== 'ok' || resolved.goal === undefined) return

      const needed = needsReconciliation(read.delivery, { wroteFiles: signals.wroteFiles, ranCommand: signals.ranCommand, now })
      if (!needed.required) {
        stats.reconcileSkipped += 1
        return
      }

      entry.reconciliations += 1
      entry.lastReconcileAt = now
      entry.turnsSinceReconcile += 1
      stats.reconcileOffered += 1

      const summary = summarize(read.delivery, resolved.goal)
      agent.steer(
        pluginNotice(
          '<goal_reconciliation>\n' +
            `本轮对工作区产生了改动，但目标状态没有相应更新。\n` +
            `当前目标：${JSON.stringify(resolved.goal.objective)}\n` +
            `当前焦点：${read.delivery.focus === '' ? '（未设置）' : read.delivery.focus}\n` +
            `进度：验收 ${summary.acceptance.verified}/${summary.acceptance.total} 已验证；任务 ${summary.tasks.completed}/${summary.tasks.total} 已完成\n\n` +
            '在结束本轮之前，用 goal_delivery 把状态同步过来：更新任务状态、补充证据、必要时改当前焦点与下一步。\n' +
            '如果本轮没有产生值得记录的进展，就不要写任何东西——直接说明结论然后结束。\n' +
            '不要为了通过检查而编造证据：证据必须来自本轮真实跑过的东西。\n' +
            '</goal_reconciliation>',
          '目标状态需要同步',
        ),
      )
    })
  }

  return {
    stats: () => ({ ...stats }),
    options: { ...options },
  }
}

/**
 * What did this turn actually change?
 *
 * Read from the session log rather than from tool hooks, because a turn-stopping listener
 * needs the whole turn's history and the log is the only place that has it. Only successful
 * mutating calls count: a failed `write` changed nothing.
 *
 * `files` is what this turn actually WROTE, in order, de-duplicated, capped. One caller needs it:
 * the skill-miss challenge, whose whole value is showing the model the concrete files it changed
 * while claiming no skill class applied — a generic "you did work" would be something the model
 * already believes. Reads are deliberately not collected: every turn reads files, so a list that
 * included them would be noise, and the challenge would then fire on turns that changed nothing.
 *
 * The path comes out of the call's own arguments, which on a real session log is a JSON STRING —
 * `runtime-routes.mjs` reads `data.arguments` the same way, against this machine's real logs. The
 * field name differs per tool (`write`/`edit` use `file_path`, `str_replace_editor` uses `path`),
 * so it tries the known keys instead of assuming one. A call whose path cannot be read still
 * counts as a write — that is `wroteFiles`' job, and it must not depend on parsing succeeding.
 *
 * @param {object} agent - the live agent.
 * @returns {{changed: boolean, wroteFiles: boolean, ranCommand: boolean, toolCalls: number, files: string[]}}
 */
export function observeTurn(agent) {
  let events
  try {
    events = agent?.session?.snapshotEvents?.()
  } catch {
    events = undefined
  }
  if (!Array.isArray(events)) {
    return { changed: false, wroteFiles: false, ranCommand: false, toolCalls: 0, files: [] }
  }

  // Scan backwards to the last turn boundary rather than tracking state: the log is the
  // authority, and a counter kept across turns would drift after a compaction.
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') {
      start = index
      break
    }
  }

  const failed = new Set()
  let wroteFiles = false
  let ranCommand = false
  let toolCalls = 0
  const files = []
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'tool/result' && event.data?.error !== undefined && typeof event.data?.message?.id === 'string') {
      failed.add(event.data.message.id)
    }
  }
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    toolCalls += 1
    if (typeof event.data?.callId === 'string' && failed.has(event.data.callId)) continue
    const name = event.data?.name
    if (name === 'write' || name === 'edit' || name === 'str_replace_editor') {
      wroteFiles = true
      const target = callTargetPath(event.data)
      if (target !== '' && !files.includes(target) && files.length < MAX_OBSERVED_FILES) files.push(target)
    } else if (name === 'bash' || name === 'pwsh' || name === 'run_code') ranCommand = true
    else if (MUTATING_TOOLS.has(name)) wroteFiles = true
  }

  return { changed: wroteFiles || ranCommand, wroteFiles, ranCommand, toolCalls, files }
}

/**
 * How many paths the observation carries. A cap rather than a filter: the challenge needs to be
 * recognisable as "this turn's work", and eight paths already say that. Past it the list would
 * grow into a diff summary, which is not what the block is for (§83: small fixed overhead).
 */
const MAX_OBSERVED_FILES = 8

/**
 * Argument keys that name a file, most specific first. Not a guess: `write` and `edit` take
 * `file_path`, `str_replace_editor` takes `path`. The rest are the obvious spellings a tool of
 * this family could use, and a key that matches nothing simply yields no name — the write is
 * still counted.
 */
const FILE_ARG_KEYS = Object.freeze(['file_path', 'path', 'file', 'filename', 'target_file', 'notebook_path'])

/**
 * The file a tool call names, or '' when this call does not name one.
 *
 * Reads the arguments defensively in both shapes — a JSON string (what the session log holds) and
 * an already-parsed object (what a test fixture tends to hold). A parse failure is NOT an error
 * here: it degrades to "this call named no file", which the caller already has to handle.
 *
 * @param {object} data - a `tool/call` event's payload.
 * @returns {string} the path, or ''.
 */
function callTargetPath(data) {
  const raw = data?.arguments
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return ''
    }
  }
  if (typeof args !== 'object' || args === null) return ''
  for (const key of FILE_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}
