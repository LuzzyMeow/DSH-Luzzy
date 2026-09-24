/**
 * The `goal_delivery` tool — how the model maintains the plan behind a goal.
 *
 * WHY A SECOND TOOL RATHER THAN MORE PARAMETERS ON `update_goal`
 *
 * `update_goal` belongs to `dsh-tool-goal` and its schema is `additionalProperties: false`
 * at every level, with its arguments validated before its body runs. Adding plan fields to
 * it would mean forking a first-party tool. The alternative — wrapping it through
 * `tools/post-execute` — is no better: post-execute can rewrite a *result*, never the
 * arguments, and `tools/pre-execute` is explicitly forbidden from rewriting `exec.arguments`
 * because that would desync the logged call from the one that ran.
 *
 * So the plan gets its own tool and `update_goal` keeps meaning exactly what it always
 * meant. The two are complements:
 *
 *   `update_goal`     → the runtime goal: objective, phase, round budget (DSH's domain)
 *   `goal_delivery`   → the plan: acceptance, tasks, evidence, focus, next action, blockers
 *
 * That split is also what makes AC-011 structural rather than a promise. There is no
 * parameter anywhere in `goal_delivery` that can change the objective, the scope or a
 * mandatory acceptance criterion: the only ops that touch those are `propose*`, and those
 * write a proposal instead of a value.
 *
 * WHY `action` + `payload` RATHER THAN ONE FLAT PARAMETER SET
 *
 * A single `description`-heavy flat schema would be ~30 optional parameters, and the model
 * would have to read all of them to use any. `action` is an enum, so the model sees the
 * complete list of capabilities in one short field, and `payload` carries exactly the keys
 * the chosen action needs. The cost is that payload keys are validated in the body rather
 * than by the schema — which is why every op returns its own precise error code instead of
 * a generic failure.
 *
 * @module dsh-luzzy-page/goal-tools
 */

import { DELIVERY_OPS, ERROR_CODES, completionGate, summarize } from './goal-domain.mjs'
import { ARTIFACT_RELATIVE_PATH } from './goal-store.mjs'

/** The tool's name. Referenced by the enforcement module and the tests. */
export const TOOL_NAME = 'goal_delivery'

const DESCRIPTION =
  'Maintain the delivery plan behind a long-running goal: acceptance criteria, tasks, evidence, ' +
  'the current focus, the next action, blockers and decisions. Use it after doing real work, so the ' +
  'plan reflects what actually happened. ' +
  'Objective, scope, mandatory acceptance criteria and constraints are NOT writable here — the ' +
  'propose* actions record a change proposal for the user to accept instead. ' +
  'Call get_goal first: its result carries the plan summary, so you can see what needs updating ' +
  'before you write anything. ' +
  'Never invent evidence: an evidence row must describe something you actually ran, read or produced.'

/**
 * The ops the model may call, each with the guidance the model needs to use it correctly.
 *
 * Grouped into one enum string rather than 16 separate tools, because the brief's §63 is
 * right that every extra tool raises the model's selection cost — and these all share one
 * verb ("update the plan").
 */
const ACTION_DESCRIPTIONS = {
  addAcceptance: 'payload: {description, mandatory?} — add one acceptance criterion (AC-nnn). What must be TRUE for this goal to be done.',
  setAcceptanceStatus: 'payload: {id, status, evidence?[]} — set a criterion to pending|in_progress|verified|rejected. verified REQUIRES evidence.',
  addTask: 'payload: {title, acceptance?[], dependsOn?[], status?} — add one task (T-nnn). What you are doing, not what must be true.',
  setTaskStatus: 'payload: {id, status, artifacts?[]} — set a task to pending|ready|in_progress|blocked|completed|verified|cancelled.',
  // 改内容与删：没有这两条，Agent 把标题写歪或把任务拆错之后只能再堆一条新的上去，
  // 让后面读的人自己分辨哪条是对的。「执行途中可调整」要的正是这两个动作。
  setTask: 'payload: {id, title?, acceptance?[], dependsOn?[]} — EDIT an existing task. `acceptance` / `dependsOn` REPLACE the whole list when given (use this to move a task onto a different criterion); omit a field to leave it alone. Prefer this over adding a corrected duplicate.',
  removeTask: 'payload: {id} — DELETE a task that should not exist. Tasks depending on it are detached rather than deleted, and the old title is kept in the change log. Use instead of leaving a stale task around.',
  addEvidence: 'payload: {summary, kind, detail?, ref?, acceptance?[]} — record one piece of proof (E-nnn). kind is test|command|file|runtime|screenshot|user_confirmation|external.',
  setEvidence: 'payload: {id, summary?, kind?, detail?, ref?} — EDIT a recorded piece of evidence in place. Use when the summary or reference was wrong; do NOT add a second row describing the same proof.',
  removeEvidence: 'payload: {id} — DELETE an evidence row. Any criterion pointing at it is detached, so no dangling E-nnn reference is left behind.',
  setFocus: 'payload: {focus} — the ONE thing most worth attention right now. Must be specific, not "continue the project".',
  setGoalSummary: 'payload: {goalSummary} — 概览目标：**这个目标在做什么**，用**一段话**概括（上限 600 字，比预期产出短）。' +
    '它顶掉的是概览卡里那份两万五千字的目标原文 —— 原文一个字都不删，完整的那份在「完整计划」视窗里，' +
    '这一格只决定卡片最上面先给人看哪句话。所以：**别复述原文**、**别写成任务清单**、**别写成结果承诺**' +
    '（那是 setExpectedOutput）。必须是**一段**：用空行分成两段的会被拒。页面按 Markdown 渲染。',
  setExpectedOutput: 'payload: {expectedOutput} — 预期产出：这个目标**做完之后到底会得到什么**，用**一段话**概括。' +
    '它回答「最终交付长什么样」，不回答「接下来做什么」（那是 setNext）——写成品、写用户能拿到的东西，不要写成任务清单。' +
    '必须是**一段**：用空行分成两段的会被拒。目标阶段一变就更新它，否则页面显示的是上一阶段的承诺。' +
    '页面按 Markdown 渲染，可以用 **加粗** 与 `代码`。',
  setNext: 'payload: {next[]} — the executable next steps, in order.',
  addBlocker: 'payload: {code, message} — record a real external blocker. code must be lower-kebab-case.',
  resolveBlocker: 'payload: {id} — mark blocker B-nnn resolved.',
  addDecision: 'payload: {decision, reason?, alternatives?, rejectedBecause?} — record a decision (D-nnn) so a later round does not silently reverse it.',
  proposeObjective: 'payload: {objective, reason?, impact?} — propose a change to the objective. Requires user confirmation; never applied directly. 提完**立刻**用 ask_user_question 把它交给用户选，拿到答案后用 adoptProposal / rejectProposal 落下去。',
  proposeAcceptanceChange: 'payload: {id, description, reason?, impact?} — propose a change to an existing criterion text. 提完立刻用 ask_user_question 交给用户选，拿到答案后落地。',
  proposeScope: 'payload: {included?[], excluded?[], reason?, impact?} — propose a change to scope. Requires user confirmation. 提完立刻用 ask_user_question 交给用户选，拿到答案后落地。',
  proposeConstraints: 'payload: {constraints[], reason?, impact?} — propose a change to constraints. Requires user confirmation. 提完立刻用 ask_user_question 交给用户选，拿到答案后落地。',
  withdrawProposal: 'payload: {id} — withdraw your own pending proposal P-nnn.',
  reconcile: 'payload: {goalId, goalRevision, objective?} — adopt the current runtime goal revision as the plan baseline after the goal was edited.',
  declareNonTask: 'payload: {reason} — declare this session a one-off question or casual exchange, NOT long-running work, so the goal gate stops requiring a goal. Use it for a greeting, an explanation, a quick lookup — things with no acceptance criteria that cannot be "delivered". Say WHY in reason. Do not use it to dodge a real task.',
  // 状态链与技能清单。这两条是**每轮必答**，所以描述的第一句就是「什么时候调」——
  // 模型不会读第二个句子，而这条工具的价值全在它被想起来的那一刻。
  judgeChain: 'payload: {goalMatch, skillCheck} — the per-turn state chain. Call it near the START of EVERY turn, before any work tool: the tool gate refuses work until both answers exist. goalMatch="matched" means this turn advances a long-running goal (a goal must then exist and be complete: objective, acceptance, scope, constraints) — you may still edit the goal mid-flight. goalMatch="none" means this turn is not long-running work and no goal is required. skillCheck="hit" means the skill checklist applies to this turn, which then REQUIRES at least one activateSkill entry (read the full skill first) — skillCheck="none" means it does not apply. Both values are mandatory; "none" is a real answer, not a skip.',
  activateSkill: 'payload: {name, description, purpose, source} — register a skill you have ACTUALLY READ IN FULL for this task. All four fields are required: name is the skill (e.g. luzzy-roster-design), description is what it covers, purpose is what it does FOR THIS TASK, and source is the repo URL or local path so anyone can go read it. Register only skills whose full text you read — an entry you cannot justify is worse than none, and only the name plus the source is injected each turn afterwards.',
  setSkill: 'payload: {id, name?, description?, purpose?, source?} — EDIT an activation entry in place (omitted fields stay). Use when the purpose was worded wrong or the source moved; do not register the same skill twice.',
  removeSkill: 'payload: {id} — DEACTIVATE a skill that turned out not to apply. The activation list is what the user reads, so a stale entry is a false claim about what this task used.',
}

export const ACTIONS = Object.freeze(Object.keys(ACTION_DESCRIPTIONS))

/**
 * The tool's output schema.
 *
 * Deliberately flat and closed: `additionalProperties: false` everywhere means a bug in
 * this file cannot leak an unexpected shape to the model, and the model cannot mis-read a
 * success as a failure. The `status` enum is the contract the model branches on.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'action', 'message'],
  properties: {
    status: { type: 'string', enum: ['ok', 'refused', 'error'] },
    action: { type: 'string' },
    message: { type: 'string' },
    created: { type: 'string' },
    code: { type: 'string' },
    proposal: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'field', 'proposed'],
      properties: {
        id: { type: 'string' },
        field: { type: 'string' },
        proposed: { type: 'string' },
      },
    },
    progress: {
      type: 'object',
      additionalProperties: false,
      required: ['acceptance', 'tasks'],
      properties: {
        acceptance: { type: 'string' },
        tasks: { type: 'string' },
        focus: { type: 'string' },
        next_action: { type: 'array', items: { type: 'string' } },
        can_complete: { type: 'boolean' },
      },
    },
  },
}

/**
 * Turn one op result into the tool's canonical value.
 *
 * The `progress` block is appended to EVERY answer, success or refusal — a model that was
 * just told "no" needs to know what is still outstanding just as much as one that was told
 * "yes", and making it call `get_goal` again to find out would cost a round.
 */
function toValue(action, result, delivery, goal) {
  if (result.ok) {
    const summary = summarize(delivery, goal)
    const gate = completionGate(delivery, goal)
    return {
      status: 'ok',
      action,
      message: result.created === undefined ? `${action} 已应用。` : `${action} 已应用，新建 ${result.created}。`,
      ...result.created === undefined ? {} : { created: result.created },
      progress: {
        acceptance: `${summary.acceptance.verified} / ${summary.acceptance.total} 已验证`,
        tasks: `${summary.tasks.completed} / ${summary.tasks.total} 已完成`,
        focus: delivery.focus,
        next_action: delivery.next,
        can_complete: gate.allowed,
      },
    }
  }
  return {
    status: result.proposal !== undefined ? 'refused' : 'error',
    action,
    message: result.reason,
    code: result.code,
    ...result.proposal === undefined
      ? {}
      : { proposal: { id: result.proposal.id, field: result.proposal.field, proposed: result.proposal.proposed } },
  }
}

/** Render the value as the model-visible text: compact JSON, plus the status word up front. */
function render(_args, value) {
  return [{ type: 'text', text: `${value.status}: ${value.message}\n${JSON.stringify(value)}` }]
}

/**
 * Register the tool.
 *
 * Optional by construction: if `ctx.tools` is absent the plugin still serves the page, and
 * the page says the tool is missing rather than pretending the model can drive the plan.
 *
 * @param {object} ctx - host context.
 * @param {object} deps - `{paths, artifacts, commit}` — `commit` is the shared write path
 *   from the enforcement module, so the compare-and-set policy has one implementation.
 * @returns {{registered: boolean}}
 */
export function registerDeliveryTool(ctx, deps) {
  const tools = deps.tools
  if (tools === undefined || typeof tools.register !== 'function') return { registered: false }

  tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: Object.entries(ACTION_DESCRIPTIONS).map(([name, help]) => `${name} — ${help}`).join('\n'),
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'Arguments for the chosen action. See the action descriptions for the keys each one takes.',
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        // Not a refusal of the plan — a refusal of the call. Every plan is per-session, and
        // a call with no session has nothing to write to.
        return Promise.resolve({
          status: 'error',
          action: args.action,
          message: 'goal_delivery 需要一个属于某个会话的调用方。',
          code: ERROR_CODES.INVALID_STATE,
        })
      }
      const sessionId = agent.session?.id
      // `agent` is passed so the commit path can bind the plan to the runtime goal without
      // having to look the session up again (it already holds the live agent right here).
      const result = deps.commit({ paths: deps.paths, sessionId, ctx, agent }, args.action, args.payload ?? {}, { actor: 'agent' })
      if (!result.ok) {
        // A refused proposal still wrote its proposal record — re-read so the progress and
        // proposal blocks describe the state that is actually on disk.
        const current = deps.read({ sessionId, ctx, agent })
        return Promise.resolve(toValue(args.action, result, current.delivery, current.goal))
      }
      const current = deps.read({ sessionId, ctx, agent })
      return Promise.resolve(toValue(args.action, result, current.delivery, current.goal))
    },
    presentCall(args) {
      return { card: 'generic', title: `Goal delivery: ${args.action}`, kind: 'other', rawInput: args.payload }
    },
  })

  return { registered: true }
}

/** The artifact path shown on the page's raw view — re-exported so the client half agrees. */
export { ARTIFACT_RELATIVE_PATH }
