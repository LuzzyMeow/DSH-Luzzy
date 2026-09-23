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
  addEvidence: 'payload: {summary, kind, detail?, ref?, acceptance?[]} — record one piece of proof (E-nnn). kind is test|command|file|runtime|screenshot|user_confirmation|external.',
  setFocus: 'payload: {focus} — the ONE thing most worth attention right now. Must be specific, not "continue the project".',
  setNext: 'payload: {next[]} — the executable next steps, in order.',
  addBlocker: 'payload: {code, message} — record a real external blocker. code must be lower-kebab-case.',
  resolveBlocker: 'payload: {id} — mark blocker B-nnn resolved.',
  addDecision: 'payload: {decision, reason?, alternatives?, rejectedBecause?} — record a decision (D-nnn) so a later round does not silently reverse it.',
  proposeObjective: 'payload: {objective, reason?, impact?} — propose a change to the objective. Requires user confirmation; never applied directly.',
  proposeAcceptanceChange: 'payload: {id, description, reason?, impact?} — propose a change to an existing criterion text.',
  proposeScope: 'payload: {included?[], excluded?[], reason?, impact?} — propose a change to scope. Requires user confirmation.',
  proposeConstraints: 'payload: {constraints[], reason?, impact?} — propose a change to constraints. Requires user confirmation.',
  withdrawProposal: 'payload: {id} — withdraw your own pending proposal P-nnn.',
  reconcile: 'payload: {goalId, goalRevision, objective?} — adopt the current runtime goal revision as the plan baseline after the goal was edited.',
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
      const result = deps.commit({ paths: deps.paths, sessionId, ctx }, args.action, args.payload ?? {}, { actor: 'agent' })
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
