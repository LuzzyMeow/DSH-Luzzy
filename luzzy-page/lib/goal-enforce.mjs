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

import { applyDeliveryOp, completionGate, needsReconciliation, nextId, renderCompletionRefusal, summarize } from './goal-domain.mjs'
import { readDeliveryOverlay, writeDeliveryOverlay } from './goal-store.mjs'

/** Attribution for everything this plugin injects. NEVER `{kind:'user'}`. */
export const PLUGIN_NAME = 'dsh-luzzy-page'

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
   * refreshes often enough that a model which has drifted gets pulled back.
   */
  preflightEverySteps: 6,
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
      goalNudged: false,
      lastPreflightStep: -999,
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
 * @param {{artifactPath?: string}} [meta]
 * @returns {string} a `<goal_state>` block.
 */
export function renderPreflight(delivery, goal, meta = {}) {
  const summary = summarize(delivery, goal)
  const gate = completionGate(delivery, goal)
  const lines = ['<goal_state>']
  lines.push(`目标：${JSON.stringify(goal.objective)}`)
  lines.push(`阶段：${goal.phase}${goal.phase === 'active' ? `（续行${goal.activation === 'armed' ? '已启用' : '未启用'}）` : ''} · 修订 ${goal.revision} · 轮次 ${goal.roundsStarted}/${goal.maxGoalRounds}`)

  if (summary.acceptance.total === 0) {
    lines.push('验收标准：还没有定义——没有它，「完成」无法判断。先定验收标准再动手。')
  } else {
    lines.push(`验收标准：${summary.acceptance.verified}/${summary.acceptance.total} 已验证`)
  }
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
  lines.push('</goal_state>')
  return lines.join('\n')
}

/**
 * Render the "you are doing real work with no goal" nudge (AC-001).
 *
 * Deliberately a QUESTION with a decision procedure, not an instruction to create a goal. §6
 * forbids doing that for ordinary requests, and the harness cannot tell a refactor from an
 * explanation — only the model can. So the harness reports the fact it observed (mutating
 * tools ran) and hands the judgement back.
 *
 * @param {{toolCalls: number}} work - what `observeTurn` saw.
 * @returns {string}
 */
export function renderGoalNudge(work) {
  return [
    '<goal_hint>',
    `本次会话已经跑了 ${work.toolCalls} 次工具调用并改动了工作区，但还没有目标。`,
    '如果这是一件需要跨多轮、可恢复、可中断的长期工作，现在建一个目标：调用 create_goal，',
    '并在目标里写清「什么条件满足才算完成」——没有验收标准，完成与否无法判断。',
    '如果只是一次性的问答或小改动，忽略这条，不要建目标。',
    '建完目标后用 goal_delivery 记下范围与验收标准。',
    '</goal_hint>',
  ].join('\n')
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
    reconcileOffered: 0,
    reconcileSkipped: 0,
    goalNudged: 0,
    completionRejected: 0,
    completionAccepted: 0,
    driftDetected: 0,
    evidenceMissing: 0,
    revisionConflict: 0,
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
    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      // Same reasoning as the commit barrier: a step on an aborted turn is about to be thrown
      // away, so injecting into it spends tokens on a message nobody will read as intended.
      if (signal?.aborted === true) return decision
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string') return decision

      const entry = counterFor(sessionId)
      const resolved = liveGoalFor(ctx, agent)

      if (resolved.state !== 'ok' || resolved.goal === undefined) {
        stats.preflightMiss += 1
        entry.preflightMisses += 1
        // ---- AC-001: a long task should get a goal --------------------------
        //
        // §6 asks the harness to decide whether the request is long-running work and create a
        // goal for it, while §39 puts "is this a long task?" in the MODEL-JUDGEMENT column
        // rather than the deterministic one. Those two fit together like this: the harness
        // supplies the DETERMINISTIC half of the signal — the session log shows real mutating
        // work — and the model makes the semantic call about whether it is a durable goal.
        //
        // So this does not create a goal. It tells the model that work is happening with no
        // goal attached and asks it to judge. Auto-creating would be worse than useless: §6 is
        // explicit that "你好" and "帮我解释一下 Promise" must NOT get one, and a rule that
        // fires on tool calls alone cannot tell those apart from a refactor.
        //
        // Rate-limited to ONCE per session. A nudge that repeats every step is the token waste
        // §83 warns about, and a model that declined the first one has its reasons.
        if (entry.goalNudged) return decision
        const work = observeTurn(agent)
        if (!work.wroteFiles && !work.ranCommand) return decision
        entry.goalNudged = true
        stats.goalNudged += 1
        return {
          ...decision,
          messages: [
            ...decision.messages,
            {
              role: 'user',
              content: [{ type: 'text', text: renderGoalNudge(work) }],
              source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: '没有目标' },
            },
          ],
        }
      }
      if (entry.lastPreflightTurn === turn && step - entry.lastPreflightStep < options.preflightEverySteps) {
        // Already oriented this turn, recently enough. This is the token control.
        return decision
      }

      const read = readDeliveryOverlay(paths, sessionId)
      if (!read.ok) {
        stats.preflightMiss += 1
        entry.preflightMisses += 1
        return decision
      }

      entry.lastPreflightTurn = turn
      entry.lastPreflightStep = step
      entry.preflights += 1
      stats.preflight += 1

      const artifact = deps.artifacts?.describe(sessionId) ?? undefined
      const text = renderPreflight(read.delivery, resolved.goal, { artifactPath: artifact?.path })
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            role: 'user',
            content: [{ type: 'text', text }],
            // NOT `{kind:'user'}`: that source clears job wake budgets and resets
            // repeat-reminder chains. This is the plugin talking, so it says so.
            source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: '目标状态' },
          },
        ],
      }
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
      agent.steer({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '<goal_reconciliation>\n' +
              `本轮对工作区产生了改动，但目标状态没有相应更新。\n` +
              `当前目标：${JSON.stringify(resolved.goal.objective)}\n` +
              `当前焦点：${read.delivery.focus === '' ? '（未设置）' : read.delivery.focus}\n` +
              `进度：验收 ${summary.acceptance.verified}/${summary.acceptance.total} 已验证；任务 ${summary.tasks.completed}/${summary.tasks.total} 已完成\n\n` +
              '在结束本轮之前，用 goal_delivery 把状态同步过来：更新任务状态、补充证据、必要时改当前焦点与下一步。\n' +
              '如果本轮没有产生值得记录的进展，就不要写任何东西——直接说明结论然后结束。\n' +
              '不要为了通过检查而编造证据：证据必须来自本轮真实跑过的东西。\n' +
              '</goal_reconciliation>',
          },
        ],
        source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: '目标状态需要同步' },
      })
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
 * @param {object} agent - the live agent.
 * @returns {{changed: boolean, wroteFiles: boolean, ranCommand: boolean, toolCalls: number}}
 */
export function observeTurn(agent) {
  let events
  try {
    events = agent?.session?.snapshotEvents?.()
  } catch {
    events = undefined
  }
  if (!Array.isArray(events)) return { changed: false, wroteFiles: false, ranCommand: false, toolCalls: 0 }

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
    if (name === 'write' || name === 'edit' || name === 'str_replace_editor') wroteFiles = true
    else if (name === 'bash' || name === 'pwsh' || name === 'run_code') ranCommand = true
    else if (MUTATING_TOOLS.has(name)) wroteFiles = true
  }

  return { changed: wroteFiles || ranCommand, wroteFiles, ranCommand, toolCalls }
}
