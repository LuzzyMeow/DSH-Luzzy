/**
 * Goal delivery domain — the pure half of the 「目标」 sub-page.
 *
 * This module is a set of functions from values to values. It has no filesystem, no
 * context, no clock of its own and no randomness: every time-dependent and identity-
 * dependent input arrives as an argument. That is what lets the tests assert the exact
 * shape of an integrity failure, a completion refusal or a drift report without a
 * temporary directory or a running harness.
 *
 * WHY A SECOND STATE AT ALL
 *
 * DSH already owns a goal: `ctx.goals` holds one persisted objective per session with a
 * revision, a phase and a round budget. It does not hold acceptance criteria, tasks,
 * evidence, decisions, a current focus or a next action — and those are exactly the things
 * that decide whether "done" is true. So the delivery state is an OVERLAY on top of the
 * runtime goal, never a replacement:
 *
 *   * the objective, phase, revision and round counters ALWAYS come from the runtime
 *     (`dsh-goal` is the authority for them — see the brief's P7);
 *   * the overlay owns only what DSH has no field for;
 *   * the two are joined on read and projected to Markdown and to the page.
 *
 * The overlay therefore stores a MIRROR of the objective, and the mirror is compared
 * against the live value on every read. A difference is not an error to be hidden — it is
 * goal drift, and it is reported as such.
 *
 * THE ERROR-CODE CONTRACT
 *
 * Every failure carries a stable code from `ERROR_CODES`. Callers branch on the code and
 * never on the message, because the message is written for a person and will change.
 *
 * @module dsh-luzzy-page/goal-domain
 */

/** Overlay format version. An unrecognised version is not interpreted at all. */
export const DELIVERY_VERSION = 1

/** Bounds, so a runaway caller cannot make the page unrenderable. */
export const MAX_ACCEPTANCE = 200
export const MAX_TASKS = 500
export const MAX_EVIDENCE = 1000
export const MAX_DECISIONS = 500
export const MAX_BLOCKERS = 200
export const MAX_PROPOSALS = 200
export const MAX_CHANGES = 500
export const MAX_SKILLS = 100
export const MAX_TEXT_CHARS = 2000
export const MAX_FOCUS_CHARS = 400
export const MAX_NEXT_ITEMS = 20

/**
 * 预期产出：**一段话**。
 *
 * 上限按「一段」给，不按「一份文档」给 —— 用户要的是概括。超了就让 Agent 自己去删，
 * 而不是在这里悄悄截断：被截断的摘要会以一个「长度正常」的样子留在页面上，
 * 而它已经不再是被交付的那句话了。
 */
export const MAX_EXPECTED_OUTPUT_CHARS = 1200

/**
 * 概览目标：**一段话**，但比预期产出更短。
 *
 * 它不是「预期产出」的另一个名字，两格回答的是两个问题：
 *   概览目标  这个目标在做什么       —— 抬头的第一句
 *   预期产出  做完之后会得到什么     —— 对结果的承诺
 *
 * 上限给 600 而不是 1200，是因为**概览的意义就在短**：它顶掉的是概览卡里那份两万五千字的
 * 目标原文，如果它自己也写到一千多字，那只是把同一块版面换了个名字。
 * 超长同样是拒绝而不是截断 —— 被截断的概览会以一个「长度正常」的样子留在卡片上。
 */
export const MAX_GOAL_SUMMARY_CHARS = 600

/**
 * 状态链的两次判断的取值。
 *
 * 两条分支就是用户给的那两条：命中（这一轮在推进一个长任务）与未命中（不是）。未命中不是
 * 「跳过流程」——判断本身必须做，只是判断的结果允许本轮不填目标。
 */
export const CHAIN_GOAL_MATCH = Object.freeze(['matched', 'none'])
/** 技能清单的两次判断：命中就要登记激活的技能，未命中就明确说没命中。 */
export const CHAIN_SKILL_CHECK = Object.freeze(['hit', 'none'])

/**
 * Stable machine-routable codes.
 *
 * These are the deliverable's public contract (the brief's §62 list). The `GOAL_`-prefixed
 * members mirror the names the brief asks for; the `DELIVERY_`-prefixed ones are additive
 * and cover conditions specific to the overlay.
 */
export const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'GOAL_NOT_FOUND',
  STALE_REVISION: 'GOAL_STALE_REVISION',
  COMPLETION_REJECTED: 'GOAL_COMPLETION_REJECTED',
  MISSING_ACCEPTANCE: 'GOAL_MISSING_ACCEPTANCE',
  MISSING_EVIDENCE: 'GOAL_MISSING_EVIDENCE',
  SCOPE_VIOLATION: 'GOAL_SCOPE_VIOLATION',
  INVALID_STATE: 'GOAL_INVALID_STATE',
  RECONCILIATION_REQUIRED: 'GOAL_RECONCILIATION_REQUIRED',
  DRIFT_DETECTED: 'GOAL_DRIFT_DETECTED',
  AUTHORITY_REQUIRED: 'GOAL_AUTHORITY_REQUIRED',
  HUMAN_CONFIRMATION_REQUIRED: 'GOAL_HUMAN_CONFIRMATION_REQUIRED',
  RUNTIME_UNAVAILABLE: 'GOAL_RUNTIME_UNAVAILABLE',
})

/** Acceptance-criterion lifecycle. */
export const ACCEPTANCE_STATUSES = Object.freeze(['pending', 'in_progress', 'verified', 'rejected'])
/** Task lifecycle. */
export const TASK_STATUSES = Object.freeze(['pending', 'ready', 'in_progress', 'blocked', 'completed', 'verified', 'cancelled'])
/** Evidence kinds — what sort of proof this is, not where it lives. */
export const EVIDENCE_KINDS = Object.freeze(['test', 'command', 'file', 'runtime', 'screenshot', 'user_confirmation', 'external'])
/** Who caused a change. */
export const ACTORS = Object.freeze(['human', 'agent', 'system'])
/** Proposal lifecycle. `adopted` is the only terminal state a human can produce. */
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'adopted', 'withdrawn', 'superseded'])

/**
 * Fields the agent may write freely, and fields it may only propose.
 *
 * The brief's authority matrix (§65) in one table. `propose` means the write is refused
 * with GOAL_HUMAN_CONFIRMATION_REQUIRED and recorded as a proposal instead — never
 * silently applied, which is what P-11 and AC-011 are about.
 */
export const FIELD_AUTHORITY = Object.freeze({
  objective: 'propose',
  scope: 'propose',
  acceptance: 'propose',
  constraints: 'propose',
  task: 'write',
  evidence: 'write',
  focus: 'write',
  next: 'write',
  blocker: 'write',
  decision: 'write',
  complete: 'gated',
})

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

// ---------------------------------------------------------------- small pure helpers

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed text, or `undefined` when it is not usable. Caps length rather than throwing. */
function text(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function positiveIntegerOrNull(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** A list of deduplicated, trimmed, non-empty strings. */
function stringList(value, max = 50) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const entry of value) {
    const item = text(entry, MAX_TEXT_CHARS)
    if (item === undefined || seen.has(item)) continue
    out.push(item)
    seen.add(item)
    if (out.length >= max) break
  }
  return out
}

/** Unique id-shaped references, filtered to ones that exist in `known`. */
function refList(value, known) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || seen.has(entry)) continue
    if (known !== undefined && !known.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/**
 * Format one epoch millisecond as `YYYY-MM-DD HH:mm` in UTC.
 *
 * UTC rather than local time on purpose: the rendered artifact must be a deterministic
 * projection of the state, and a local-time format would make the same state render
 * differently on two machines — and differently for the same machine across a DST edge.
 *
 * @param {number} ms - epoch milliseconds.
 * @returns {string} a fixed-width stamp, or `-` when the value is not a usable time.
 */
export function formatStamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '-'
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/** A one-line, single-paragraph escape for Markdown table cells and headings. */
function inline(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

// ---------------------------------------------------------------- identity

/**
 * The next free id in a series.
 *
 * Derived from the highest existing number rather than the array length: removing AC-002
 * from a list of three must not hand AC-003's number to the next addition, because the
 * numbers are referenced from tasks, evidence and the change log.
 *
 * @param {string} prefix - `AC` | `T` | `E` | `D` | `B` | `P` | `C`.
 * @param {Array<{id: string}>} entries - existing rows.
 * @returns {string} e.g. `AC-004`.
 */
export function nextId(prefix, entries) {
  let highest = 0
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  for (const entry of entries) {
    const match = pattern.exec(typeof entry?.id === 'string' ? entry.id : '')
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`
}

// ---------------------------------------------------------------- the empty state

/**
 * A delivery overlay with nothing in it.
 * @param {string} sessionId - owning session.
 * @returns {object} the initial state.
 */
export function emptyDelivery(sessionId) {
  return {
    version: DELIVERY_VERSION,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    goalId: null,
    goalRevision: null,
    objectiveMirror: null,
    scope: { included: [], excluded: [] },
    constraints: [],
    acceptance: [],
    tasks: [],
    evidence: [],
    decisions: [],
    blockers: [],
    proposals: [],
    changes: [],
    focus: '',
    next: [],
    /**
     * 概览目标：Agent 写的一段话，回答「这个目标在做什么」。
     *
     * 与运行时 objective / `objectiveMirror` 的分工：那两者是**权威原文**（真实会话里
     * 两万五千字），这一格是 Agent 对它的**概括**。原文一个字都不删 —— 「完整计划」那个
     * Markdown 视窗仍然渲染 `runtimeGoal.objective` 全文，这一格只决定概览卡上先给人看哪句话。
     *
     * 空字符串 = 还没写。页面照实说「还没有写」，绝不拿原文顶上去：原文一顶上，概览卡就又回到
     * 「塞了两万字」的样子，而那正是用户要改掉的东西。
     */
    goalSummary: '',
    /**
     * 预期产出：这个目标做完之后到底会得到什么，**一段话**概括。
     *
     * 为什么它是独立字段而不是塞进 focus / next：
     *   focus  当前最值得关注的一件事   —— 现在的
     *   next   接下来要做的几步         —— 下一步的
     *   它     最终交付长什么样         —— 做完之后的
     * 「做完了会得到什么」是长任务里最先被问、也最容易在十几轮之后失真的那句话。
     * 它属于 Agent 可写的执行记录（§65 的 Agent 列），不是人类权威字段。
     *
     * 空字符串 = 还没写。页面照实说「还没写」，不拿目标原文来顶替。
     */
    expectedOutput: '',
    /**
     * 状态链：每一轮都要走的那两步判断。
     *
     * `goalMatch` —— 这一轮是否在推进一个长期目标（命中／未命中）
     * `skillCheck` —— 这一轮是否要按技能清单执行（命中／未命中）
     *
     * 存下来不是为了「记着」，是为了**页面能显示它**：看不见的判断等于没有判断，而
     * 「Agent 到底有没有走这两步」正是用户要看的东西。是否“本轮还没判断”是运行时事实
     * （见 goal-enforce 的 chain 计数器），不在这里——这一层是持久状态，不是时钟。
     */
    chain: { goalMatch: null, skillCheck: null, at: 0 },
    /**
     * 激活的技能清单：Agent 实际读完某个 skill 的**完整正文**之后登记的条目。
     *
     * 四个字段全部必填（名称 / 描述 / 本次作用 / 来源），因为缺任何一个这条记录都不能回答
     * 「为什么这一轮要用它」。来源是仓库链接或本地路径——正文不注入，需要细节时照这个去找。
     */
    skills: [],
    revision: 0,
    updatedAt: 0,
  }
}

// ---------------------------------------------------------------- normalisation

/**
 * Interpret one stored overlay.
 *
 * Invalid rows are DROPPED with a reason instead of rejecting the document wholesale, the
 * same policy the preset store uses: one malformed task must not cost the user their whole
 * plan. The warnings are returned so the page can say the drop happened rather than
 * rendering a silently shorter list.
 *
 * A future `version` IS rejected wholesale, because interpreting an unknown format
 * partially would mis-assign acceptance links — and a wrong "this was verified" is worse
 * than a visible "cannot read this".
 *
 * @param {unknown} raw - parsed state.
 * @param {string} sessionId - owning session, used when the document does not carry one.
 * @returns {{ok: true, delivery: object, warnings: string[]} | {ok: false, code: string, reason: string}}
 */
export function normalizeDelivery(raw, sessionId) {
  if (!isRecord(raw)) {
    return { ok: false, code: ERROR_CODES.INVALID_STATE, reason: '交付状态不是一个对象' }
  }
  if (raw.version !== DELIVERY_VERSION) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_STATE,
      reason: `交付状态版本是 ${JSON.stringify(raw.version)}，本插件只认得 ${DELIVERY_VERSION}`,
    }
  }

  const warnings = []
  const delivery = emptyDelivery(typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : sessionId)
  delivery.goalId = text(raw.goalId, 200) ?? null
  delivery.goalRevision = positiveIntegerOrNull(raw.goalRevision)
  delivery.objectiveMirror = text(raw.objectiveMirror) ?? null
  delivery.focus = text(raw.focus, MAX_FOCUS_CHARS) ?? ''
  delivery.next = stringList(raw.next, MAX_NEXT_ITEMS)
  delivery.expectedOutput = text(raw.expectedOutput, MAX_EXPECTED_OUTPUT_CHARS) ?? ''
  delivery.goalSummary = text(raw.goalSummary, MAX_GOAL_SUMMARY_CHARS) ?? ''
  delivery.constraints = stringList(raw.constraints, 50)
  delivery.revision = nonNegativeInteger(raw.revision)
  delivery.updatedAt = nonNegativeInteger(raw.updatedAt)

  const scope = isRecord(raw.scope) ? raw.scope : {}
  delivery.scope = { included: stringList(scope.included, 50), excluded: stringList(scope.excluded, 50) }

  const dropped = (what, detail) => warnings.push(`${what} ${detail}，已跳过`)

  const acceptance = []
  const seenAcceptance = new Set()
  for (const entry of Array.isArray(raw.acceptance) ? raw.acceptance : []) {
    if (!isRecord(entry)) { dropped('有一条验收标准', '不是对象'); continue }
    const id = text(entry.id, 32)
    if (id === undefined || !/^AC-\d{3,}$/.test(id)) { dropped('验收标准', `id ${JSON.stringify(entry.id)} 不合规`); continue }
    if (seenAcceptance.has(id)) { dropped('验收标准', `id "${id}" 重复`); continue }
    const description = text(entry.description)
    if (description === undefined) { dropped(`验收标准 ${id}`, '没有描述'); continue }
    seenAcceptance.add(id)
    acceptance.push({
      id,
      description,
      status: oneOf(entry.status, ACCEPTANCE_STATUSES, 'pending'),
      // Mandatory defaults to TRUE: an acceptance criterion that exists and does not count
      // is not an acceptance criterion. Opting out has to be explicit.
      mandatory: entry.mandatory !== false,
      evidence: refList(entry.evidence, undefined),
      verifiedAt: nonNegativeInteger(entry.verifiedAt) || null,
    })
    if (acceptance.length >= MAX_ACCEPTANCE) break
  }
  delivery.acceptance = acceptance
  const acceptanceIds = new Set(acceptance.map((row) => row.id))

  const tasks = []
  const seenTasks = new Set()
  for (const entry of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!isRecord(entry)) { dropped('有一个任务', '不是对象'); continue }
    const id = text(entry.id, 32)
    if (id === undefined || !/^T-\d{3,}$/.test(id)) { dropped('任务', `id ${JSON.stringify(entry.id)} 不合规`); continue }
    if (seenTasks.has(id)) { dropped('任务', `id "${id}" 重复`); continue }
    const title = text(entry.title)
    if (title === undefined) { dropped(`任务 ${id}`, '没有标题'); continue }
    seenTasks.add(id)
    tasks.push({
      id,
      title,
      status: oneOf(entry.status, TASK_STATUSES, 'pending'),
      // A link to an acceptance criterion that does not exist would render as a phantom
      // reference, so it is resolved here rather than trusted.
      acceptance: refList(entry.acceptance, acceptanceIds),
      dependsOn: refList(entry.dependsOn, undefined),
      artifacts: stringList(entry.artifacts, 20),
    })
    if (tasks.length >= MAX_TASKS) break
  }
  delivery.tasks = tasks
  const taskIds = new Set(tasks.map((row) => row.id))

  // Dependencies are resolved after every task is known, so order in the document cannot
  // silently void a valid edge.
  for (const task of delivery.tasks) {
    const resolved = task.dependsOn.filter((id) => taskIds.has(id) && id !== task.id)
    if (resolved.length !== task.dependsOn.length) {
      const lost = task.dependsOn.length - resolved.length
      warnings.push(`任务 ${task.id} 有 ${lost} 条依赖指向不存在的任务，已丢弃`)
    }
    task.dependsOn = resolved
  }

  const evidence = []
  const seenEvidence = new Set()
  for (const entry of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (!isRecord(entry)) { dropped('有一条证据', '不是对象'); continue }
    const id = text(entry.id, 32)
    if (id === undefined || !/^E-\d{3,}$/.test(id)) { dropped('证据', `id ${JSON.stringify(entry.id)} 不合规`); continue }
    if (seenEvidence.has(id)) { dropped('证据', `id "${id}" 重复`); continue }
    const summary = text(entry.summary)
    if (summary === undefined) { dropped(`证据 ${id}`, '没有说明'); continue }
    seenEvidence.add(id)
    evidence.push({
      id,
      kind: oneOf(entry.kind, EVIDENCE_KINDS, 'external'),
      summary,
      detail: text(entry.detail) ?? '',
      at: nonNegativeInteger(entry.at),
      // Where this evidence lives, if anywhere — a path, a URL or a command.
      ref: text(entry.ref, 500) ?? '',
    })
    if (evidence.length >= MAX_EVIDENCE) break
  }
  delivery.evidence = evidence
  const evidenceIds = new Set(evidence.map((row) => row.id))

  // Acceptance -> evidence is the authoritative link; a dangling one is dropped here so
  // that "verified with evidence" cannot be satisfied by a reference to nothing.
  for (const row of delivery.acceptance) {
    const resolved = row.evidence.filter((id) => evidenceIds.has(id))
    if (resolved.length !== row.evidence.length) {
      warnings.push(`验收标准 ${row.id} 引用了 ${row.evidence.length - resolved.length} 条不存在的证据，已丢弃`)
    }
    row.evidence = resolved
  }

  const decisions = []
  for (const entry of Array.isArray(raw.decisions) ? raw.decisions : []) {
    if (!isRecord(entry)) continue
    const id = text(entry.id, 32)
    const decision = text(entry.decision)
    if (id === undefined || !/^D-\d{3,}$/.test(id) || decision === undefined) continue
    decisions.push({
      id,
      decision,
      reason: text(entry.reason) ?? '',
      alternatives: text(entry.alternatives) ?? '',
      rejectedBecause: text(entry.rejectedBecause) ?? '',
      at: nonNegativeInteger(entry.at),
    })
    if (decisions.length >= MAX_DECISIONS) break
  }
  delivery.decisions = decisions

  const blockers = []
  for (const entry of Array.isArray(raw.blockers) ? raw.blockers : []) {
    if (!isRecord(entry)) continue
    const id = text(entry.id, 32)
    const code = text(entry.code, 64)
    const message = text(entry.message)
    if (id === undefined || !/^B-\d{3,}$/.test(id)) continue
    if (code === undefined || !SLUG.test(code) || message === undefined) continue
    blockers.push({ id, code, message, at: nonNegativeInteger(entry.at), resolvedAt: nonNegativeInteger(entry.resolvedAt) || null })
    if (blockers.length >= MAX_BLOCKERS) break
  }
  delivery.blockers = blockers

  const proposals = []
  for (const entry of Array.isArray(raw.proposals) ? raw.proposals : []) {
    if (!isRecord(entry)) continue
    const id = text(entry.id, 32)
    const field = text(entry.field, 64)
    const proposed = text(entry.proposed)
    if (id === undefined || !/^P-\d{3,}$/.test(id)) continue
    if (field === undefined || proposed === undefined) continue
    proposals.push({
      id,
      field,
      // Which row the proposal targets, when it is about one (an acceptance criterion).
      target: text(entry.target, 32) ?? '',
      current: text(entry.current) ?? '',
      proposed,
      // The machine-usable form, kept alongside the readable one so adopting a proposal
      // does not have to re-parse prose.
      value: entry.value === undefined ? null : entry.value,
      reason: text(entry.reason) ?? '',
      impact: text(entry.impact) ?? '',
      // V1 has no approval UI, so this is always true and always recorded. The field
      // exists so a later approval surface does not have to migrate the document.
      requiresHuman: true,
      status: oneOf(entry.status, PROPOSAL_STATUSES, 'pending'),
      at: nonNegativeInteger(entry.at),
    })
    if (proposals.length >= MAX_PROPOSALS) break
  }
  delivery.proposals = proposals

  const changes = []
  for (const entry of Array.isArray(raw.changes) ? raw.changes : []) {
    if (!isRecord(entry)) continue
    const id = text(entry.id, 32)
    const action = text(entry.action, 200)
    if (id === undefined || !/^C-\d{3,}$/.test(id) || action === undefined) continue
    changes.push({
      id,
      at: nonNegativeInteger(entry.at),
      actor: oneOf(entry.actor, ACTORS, 'system'),
      action,
      detail: text(entry.detail) ?? '',
    })
    if (changes.length >= MAX_CHANGES) break
  }
  delivery.changes = changes

  // 状态链：两个取值各自白名单，认不出来的一律当「还没判断」——这比猜一个值安全，
  // 因为猜错会让页面显示一个 Agent 从没做过的判断。
  const rawChain = isRecord(raw.chain) ? raw.chain : {}
  delivery.chain = {
    goalMatch: oneOf(rawChain.goalMatch, CHAIN_GOAL_MATCH, null),
    skillCheck: oneOf(rawChain.skillCheck, CHAIN_SKILL_CHECK, null),
    at: nonNegativeInteger(rawChain.at),
  }

  const skills = []
  for (const entry of Array.isArray(raw.skills) ? raw.skills : []) {
    if (!isRecord(entry)) continue
    const id = text(entry.id, 32)
    const name = text(entry.name, 200)
    const description = text(entry.description)
    const purpose = text(entry.purpose)
    const source = text(entry.source, 1000)
    // 四个字段一个都不能少：少一个这条记录就答不出「为什么这一轮要用它」，那它就不是
    // 激活记录，只是一行噪音。整条丢掉并留一条 warning，而不是渲染成半条。
    if (id === undefined || !/^S-\d{3,}$/.test(id)) continue
    if (name === undefined || description === undefined || purpose === undefined || source === undefined) continue
    skills.push({ id, name, description, purpose, source, at: nonNegativeInteger(entry.at) })
    if (skills.length >= MAX_SKILLS) break
  }
  delivery.skills = skills

  return { ok: true, delivery, warnings }
}

// ---------------------------------------------------------------- integrity

/**
 * The structural integrity check (the brief's §60).
 *
 * Every check here is decidable from the state itself. Nothing in this function asks
 * whether the objective "is really achieved" — that judgement is the model's, and the
 * brief's §38 is explicit that a deterministic checker must not pretend to make it.
 *
 * @param {object} delivery - normalized overlay.
 * @param {object|null} runtimeGoal - the live goal view, or null when unavailable.
 * @returns {{valid: boolean, errors: Array<{code: string, target: string, detail: string}>, warnings: Array<{code: string, target: string, detail: string}>}}
 */
export function integrity(delivery, runtimeGoal) {
  const errors = []
  const warnings = []
  const fail = (code, target, detail) => errors.push({ code, target, detail })
  const warn = (code, target, detail) => warnings.push({ code, target, detail })

  if (delivery === null || typeof delivery !== 'object') {
    fail(ERROR_CODES.INVALID_STATE, 'delivery', '交付状态缺失')
    return { valid: false, errors, warnings }
  }

  // 1 — objective exists. Sourced from the runtime when it is reachable, because that is
  // the authority; the overlay's mirror is only a fallback for an unloaded session.
  const objective = runtimeGoal !== null && runtimeGoal !== undefined ? runtimeGoal.objective : delivery.objectiveMirror
  if (text(objective) === undefined) {
    fail(ERROR_CODES.MISSING_ACCEPTANCE, 'objective', '目标文本为空')
  }

  // 2 — acceptance exists at all.
  //
  // A WARNING, not an error. Having no criteria yet is what "just started" looks like, and
  // calling it a structural defect would label every fresh goal as broken. It still stops
  // completion — the gate checks it directly, which is where that belongs.
  if (delivery.acceptance.length === 0) {
    warn(ERROR_CODES.MISSING_ACCEPTANCE, 'acceptance', '还没有定义任何验收标准')
  }

  // 3 — scope exists. An empty scope is a warning, not an error: "everything in this
  // repository" is a legitimate answer and cannot be written down usefully.
  if (delivery.scope.included.length === 0 && delivery.scope.excluded.length === 0) {
    warn(ERROR_CODES.SCOPE_VIOLATION, 'scope', '范围与边界未填写')
  }

  // 4 / 5 — current focus and next action.
  if (delivery.focus === '') warn(ERROR_CODES.RECONCILIATION_REQUIRED, 'focus', '当前焦点为空')
  if (delivery.next.length === 0) warn(ERROR_CODES.RECONCILIATION_REQUIRED, 'next', '下一步行动为空')

  // 6 — active tasks are valid: an in-progress task must have a title (guaranteed by
  // normalization) and must not depend on something still pending.
  const byId = new Map(delivery.tasks.map((row) => [row.id, row]))
  for (const task of delivery.tasks) {
    if (task.status !== 'in_progress' && task.status !== 'ready') continue
    for (const dependency of task.dependsOn) {
      const parent = byId.get(dependency)
      if (parent === undefined) continue
      if (parent.status !== 'completed' && parent.status !== 'verified' && parent.status !== 'cancelled') {
        fail(ERROR_CODES.INVALID_STATE, task.id, `依赖 ${dependency} 尚未完成（状态 ${parent.status}）`)
      }
    }
  }

  // 7 — dependencies are valid: a cycle makes the plan unrunnable.
  for (const task of delivery.tasks) {
    const seen = new Set()
    let cursor = task
    while (cursor !== undefined) {
      if (seen.has(cursor.id)) {
        fail(ERROR_CODES.INVALID_STATE, task.id, `任务依赖成环，经过 ${cursor.id}`)
        break
      }
      seen.add(cursor.id)
      cursor = cursor.dependsOn.length > 0 ? byId.get(cursor.dependsOn[0]) : undefined
    }
  }

  // 8 — a completed or verified task must name at least one artifact OR be linked to an
  // acceptance criterion. Without this a task can be ticked off with nothing behind it.
  for (const task of delivery.tasks) {
    if (task.status !== 'completed' && task.status !== 'verified') continue
    if (task.artifacts.length === 0 && task.acceptance.length === 0) {
      warn(ERROR_CODES.MISSING_EVIDENCE, task.id, '已完成但既不产出文件也不关联验收标准')
    }
  }

  // 9 — a verified criterion must have evidence that exists.
  const evidenceById = new Map(delivery.evidence.map((row) => [row.id, row]))
  for (const row of delivery.acceptance) {
    if (row.status !== 'verified') continue
    if (row.evidence.length === 0) {
      fail(ERROR_CODES.MISSING_EVIDENCE, row.id, '已标记验证通过，但没有关联任何证据')
      continue
    }
    const missing = row.evidence.filter((id) => !evidenceById.has(id))
    if (missing.length > 0) fail(ERROR_CODES.MISSING_EVIDENCE, row.id, `证据 ${missing.join(', ')} 不存在`)
    if (row.verifiedAt === null) warn(ERROR_CODES.MISSING_EVIDENCE, row.id, '验证通过但没有验证时间')
  }

  // 10 — no unresolved critical blocker while claiming completion is checked by the gate;
  // here we only assert the blocker records themselves are coherent.
  for (const blocker of delivery.blockers) {
    if (blocker.resolvedAt !== null && blocker.resolvedAt < blocker.at) {
      warn(ERROR_CODES.INVALID_STATE, blocker.id, '解决时间早于发生时间')
    }
  }

  // 11 — revision is current: the overlay must have been synced against the goal revision
  // the runtime currently reports. A mismatch means the plan was written for a different
  // objective and has not been reconciled.
  if (runtimeGoal !== null && runtimeGoal !== undefined) {
    if (delivery.goalId !== null && delivery.goalId !== runtimeGoal.id) {
      fail(ERROR_CODES.DRIFT_DETECTED, 'goal', `交付计划属于 ${delivery.goalId}，当前目标是 ${runtimeGoal.id}`)
    } else if (delivery.goalRevision !== null && delivery.goalRevision !== runtimeGoal.revision) {
      warn(ERROR_CODES.RECONCILIATION_REQUIRED, 'goal', `交付计划基于修订 ${delivery.goalRevision}，当前是 ${runtimeGoal.revision}`)
    }
  }

  // 12 — phase consistency. A complete goal must have no open blocker; that combination
  // cannot both be true.
  if (runtimeGoal !== null && runtimeGoal !== undefined && runtimeGoal.phase === 'complete') {
    const open = delivery.blockers.filter((row) => row.resolvedAt === null)
    if (open.length > 0) fail(ERROR_CODES.INVALID_STATE, 'blockers', `目标已完成但有 ${open.length} 个未解决的阻塞`)
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------- completion gate

/**
 * Decide whether the goal may be marked complete.
 *
 * The gate is deliberately NOT a model: it answers a handful of decidable questions and
 * refuses when any of them is unsatisfied. The one thing it cannot decide — whether the
 * objective is genuinely achieved — stays the model's judgement, and the gate does not
 * pretend otherwise (brief §38).
 *
 * @param {object} delivery - normalized overlay.
 * @param {object|null} runtimeGoal - the live goal view.
 * @returns {{allowed: boolean, code: string|null, unverified: string[], missingEvidence: string[], remainingWork: string[], blockers: string[]}}
 */
export function completionGate(delivery, runtimeGoal) {
  const unverified = []
  const missingEvidence = []
  const remainingWork = []
  const blockers = []

  // Acceptance criteria must EXIST before completion can mean anything. Checked here
  // directly rather than inferred from `integrity`, because `integrity` deliberately treats
  // an empty plan as a warning ("just started") while this gate must treat it as a refusal.
  // The two functions answer different questions and must not share a verdict.
  if (delivery.acceptance.length === 0) {
    remainingWork.push('还没有定义任何验收标准：没有它，「完成」无法判断')
  }

  const structure = integrity(delivery, runtimeGoal)
  for (const error of structure.errors) {
    // Anything structurally broken blocks completion, but it is reported under its own
    // code so the caller can tell "your plan is malformed" from "your plan is unfinished".
    if (error.code === ERROR_CODES.MISSING_EVIDENCE) missingEvidence.push(`${error.target}: ${error.detail}`)
    else missingEvidence.push(`${error.target}: ${error.detail}`)
  }

  for (const row of delivery.acceptance) {
    if (!row.mandatory) continue
    if (row.status === 'verified') continue
    unverified.push(row.id)
    if (row.status === 'rejected') remainingWork.push(`${row.id} 被标记为不满足：${row.description}`)
  }

  for (const task of delivery.tasks) {
    if (task.status === 'cancelled' || task.status === 'completed' || task.status === 'verified') continue
    remainingWork.push(`${task.id}（${task.status}）：${task.title}`)
  }

  for (const blocker of delivery.blockers) {
    if (blocker.resolvedAt === null) blockers.push(`${blocker.id} ${blocker.code}: ${blocker.message}`)
  }

  const allowed = unverified.length === 0 && missingEvidence.length === 0 && remainingWork.length === 0 && blockers.length === 0
  let code = null
  if (!allowed) {
    // The most specific code wins, so a caller acting on the code does the most useful
    // thing first: close the blocker, then get evidence, then finish the work.
    if (blockers.length > 0) code = ERROR_CODES.COMPLETION_REJECTED
    else if (missingEvidence.length > 0) code = ERROR_CODES.MISSING_EVIDENCE
    else if (delivery.acceptance.length === 0) code = ERROR_CODES.MISSING_ACCEPTANCE
    else code = ERROR_CODES.COMPLETION_REJECTED
  }

  return { allowed, code, unverified, missingEvidence, remainingWork, blockers }
}

/**
 * A human- and model-readable refusal, in the shape the brief's §20 asks for.
 * @returns {string} an empty string when the gate allows completion.
 */
export function renderCompletionRefusal(gate) {
  if (gate.allowed) return ''
  const lines = [`${ERROR_CODES.COMPLETION_REJECTED}: 目标还不能标记为完成。`]
  if (gate.unverified.length > 0) lines.push(`Unverified Criteria:\n${gate.unverified.join(', ')}`)
  if (gate.missingEvidence.length > 0) lines.push(`Missing Evidence:\n${gate.missingEvidence.map((line) => `- ${line}`).join('\n')}`)
  if (gate.remainingWork.length > 0) lines.push(`Remaining Work:\n${gate.remainingWork.map((line) => `- ${line}`).join('\n')}`)
  if (gate.blockers.length > 0) lines.push(`Open Blockers:\n${gate.blockers.map((line) => `- ${line}`).join('\n')}`)
  lines.push('补齐之后再次调用 update_goal(action=complete)；如果其中某项确实无法满足，用 goal_delivery 记录阻塞或向用户提出变更。')
  return lines.join('\n\n')
}

// ---------------------------------------------------------------- drift

/**
 * Compare the stable fields against the live goal.
 *
 * Only Stable-layer fields are compared (brief §15). Dynamic fields — task status, focus,
 * next action — change constantly and treating them as drift would fire on every round,
 * which is precisely the noise the brief warns against.
 *
 * @param {object} delivery - normalized overlay.
 * @param {object|null} runtimeGoal - the live goal view.
 * @returns {null | {fields: string[], before: object, after: object}} null when aligned.
 */
export function detectDrift(delivery, runtimeGoal) {
  if (runtimeGoal === null || runtimeGoal === undefined) return null
  const fields = []
  const before = {}
  const after = {}

  if (delivery.goalId !== null && delivery.goalId !== runtimeGoal.id) {
    fields.push('goal')
    before.goal = delivery.goalId
    after.goal = runtimeGoal.id
  }

  // The mirror is only evidence of drift when it was actually recorded. An overlay created
  // before the objective was written down has no opinion and must not be reported as
  // having drifted away from one.
  if (delivery.objectiveMirror !== null && delivery.objectiveMirror !== runtimeGoal.objective) {
    fields.push('objective')
    before.objective = delivery.objectiveMirror
    after.objective = runtimeGoal.objective
  }

  if (runtimeGoal.revision !== delivery.goalRevision && delivery.goalRevision !== null) {
    fields.push('revision')
    before.revision = delivery.goalRevision
    after.revision = runtimeGoal.revision
  }

  if (fields.length === 0) return null
  return { fields, before, after }
}

// ---------------------------------------------------------------- health

/**
 * The discrete health of a goal (brief §36).
 *
 * Deliberately not a score. A number between 0 and 100 would be precise about something
 * nobody can measure, and the brief asks explicitly for states instead.
 *
 * THE PRECEDENCE IS THE DESIGN, so it is spelled out rather than left to the order of the
 * lines below:
 *
 *   1. `completed` — the runtime says so; nothing else can be more true than that.
 *   2. `blocked`   — an unresolved blocker. The most specific actionable state there is.
 *   3. `needs-attention` — structural errors, or a plan written against a goal that has
 *      since been edited. **This outranks `verifying` on purpose**: a fully-verified plan
 *      that belongs to a DIFFERENT objective is not nearly done, it is wrong.
 *   4. `verifying` — every criterion verified; the gate is the only thing left.
 *   5. `healthy`   — in progress with nothing to act on.
 *
 * @returns {'completed'|'blocked'|'needs-attention'|'verifying'|'healthy'}
 */
export function health(delivery, runtimeGoal) {
  if (runtimeGoal !== null && runtimeGoal !== undefined && runtimeGoal.phase === 'complete') return 'completed'
  if (delivery === null || typeof delivery !== 'object') return 'needs-attention'
  if (delivery.blockers.some((row) => row.resolvedAt === null)) return 'blocked'

  const structure = integrity(delivery, runtimeGoal)
  if (structure.errors.length > 0) return 'needs-attention'

  // Only warnings that mean something is actually wrong count here. "Scope not written
  // down" and "focus is empty" are advisory — a brand-new goal has neither and is not in
  // trouble. Evidence promised but absent, or a plan on an older revision, are states
  // someone has to act on.
  const attention = structure.warnings.some(
    (row) =>
      row.code === ERROR_CODES.MISSING_EVIDENCE ||
      (row.code === ERROR_CODES.RECONCILIATION_REQUIRED && row.target === 'goal') ||
      row.code === ERROR_CODES.DRIFT_DETECTED,
  )
  if (attention) return 'needs-attention'

  // Nothing written down yet is "just started", not "in trouble". A goal with no criteria
  // and no tasks has had no plan made for it; that is the state every goal begins in.
  if (delivery.acceptance.length === 0 && delivery.tasks.length === 0) return 'healthy'

  const allVerified = delivery.acceptance.length > 0 && delivery.acceptance.every((row) => row.status === 'verified')
  if (allVerified) return 'verifying'
  return 'healthy'
}

/** Chinese labels for the discrete health states — the page renders those. */
export const HEALTH_LABELS = Object.freeze({
  healthy: '正常',
  'needs-attention': '需要注意',
  blocked: '已阻塞',
  verifying: '待验证',
  completed: '已完成',
})

// ---------------------------------------------------------------- summary

/**
 * The counts the overview card shows.
 *
 * Reported as pairs rather than a percentage: "4 / 6 verified" tells the reader what is
 * left, and "67%" does not (brief §35).
 */
export function summarize(delivery, runtimeGoal) {
  const tasks = delivery.tasks
  const acceptance = delivery.acceptance
  const openBlockers = delivery.blockers.filter((row) => row.resolvedAt === null)
  return {
    health: health(delivery, runtimeGoal),
    acceptance: {
      total: acceptance.length,
      verified: acceptance.filter((row) => row.status === 'verified').length,
      rejected: acceptance.filter((row) => row.status === 'rejected').length,
      pending: acceptance.filter((row) => row.status === 'pending' || row.status === 'in_progress').length,
      mandatory: acceptance.filter((row) => row.mandatory).length,
    },
    tasks: {
      total: tasks.length,
      verified: tasks.filter((row) => row.status === 'verified').length,
      completed: tasks.filter((row) => row.status === 'completed' || row.status === 'verified').length,
      active: tasks.filter((row) => row.status === 'in_progress').length,
      ready: tasks.filter((row) => row.status === 'ready').length,
      blocked: tasks.filter((row) => row.status === 'blocked').length,
      cancelled: tasks.filter((row) => row.status === 'cancelled').length,
    },
    evidence: { total: delivery.evidence.length },
    decisions: { total: delivery.decisions.length },
    blockers: { open: openBlockers.length, total: delivery.blockers.length },
    proposals: { pending: delivery.proposals.filter((row) => row.status === 'pending').length },
    changes: { total: delivery.changes.length },
  }
}

// ---------------------------------------------------------------- reconciliation need

/**
 * Whether this turn's observed activity requires the overlay to be updated (brief §12).
 *
 * The decision is made from evidence the harness can see — a tool call that changed a
 * file, a task claimed as in progress, a blocker recorded — not from the model's opinion
 * that it "made progress", because the model's opinion about its own progress is exactly
 * what the brief says not to trust.
 *
 * @param {object} delivery - normalized overlay.
 * @param {{wroteFiles?: boolean, ranCommand?: boolean, recordedAt?: number, now?: number}} signals
 * @returns {{required: boolean, reasons: string[]}}
 */
export function needsReconciliation(delivery, signals = {}) {
  const reasons = []
  const now = nonNegativeInteger(signals.now)

  if (delivery.acceptance.length === 0) reasons.push('还没有定义验收标准')
  if (delivery.focus === '') reasons.push('当前焦点为空')
  if (delivery.next.length === 0) reasons.push('下一步行动为空')
  if (delivery.tasks.some((row) => row.status === 'in_progress')) reasons.push('有任务处于进行中')
  if (delivery.blockers.some((row) => row.resolvedAt === null)) reasons.push('有未解决的阻塞')

  // Real work happened but the overlay has not moved since. This is the case the brief
  // describes as "产生了实质性进展，但 Goal 没有相应更新".
  if (signals.wroteFiles === true || signals.ranCommand === true) {
    const last = delivery.changes.reduce((max, row) => Math.max(max, row.at), delivery.updatedAt)
    if (now > 0 && last > 0 && now - last > 15 * 60 * 1000) {
      reasons.push('本轮对工作区产生了改动，但交付状态已有 15 分钟没有更新')
    } else if (last === 0) {
      reasons.push('本轮对工作区产生了改动，但交付状态从未记录过变更')
    }
  }

  return { required: reasons.length > 0, reasons }
}

// ---------------------------------------------------------------- mutation

function clampPush(list, max) {
  if (list.length > max) list.length = max
  return list
}

function recordChange(delivery, at, actor, action, detail, id) {
  delivery.changes.push({ id, at, actor: oneOf(actor, ACTORS, 'system'), action: text(action, 200) ?? action, detail: text(detail) ?? '' })
  clampPush(delivery.changes, MAX_CHANGES)
}

function findAcceptance(delivery, id, problems) {
  const row = delivery.acceptance.find((entry) => entry.id === id)
  if (row === undefined) problems.push(`验收标准 ${id} 不存在`)
  return row
}

/**
 * Render a scope as one readable line.
 *
 * The proposal's `current` field is shown to a person, and a proposal about scope used to
 * display `{"included":[],"excluded":[]}` — the shape of the data rather than what it says.
 * A reader deciding whether to accept a change should not have to parse JSON to find out
 * what is being changed.
 */
function describeScope(scope) {
  const parts = []
  if (scope.included.length > 0) parts.push(`包含：${scope.included.join('、')}`)
  if (scope.excluded.length > 0) parts.push(`不包含：${scope.excluded.join('、')}`)
  return parts.length === 0 ? '（未填写）' : parts.join('；')
}

/**
 * Apply one structured mutation to a copy of the overlay.
 *
 * Three possible results, and the third is the one worth reading twice:
 *
 *   1. `{delivery, created?}` — the change was applied. Persist the returned document.
 *   2. `{error, code}` — nothing changed. Refuse and report.
 *   3. `{error, code, proposal, delivery}` — the write hit a human-authority field. **The
 *      delivery IS changed** (the proposal and its change-log entry were recorded), so the
 *      caller must persist it. Returning `error` without the document here would silently
 *      discard the agent's proposal, which is the one outcome that must not happen: the
 *      agent would believe it had asked, and the user would never be told.
 *
 * In all cases the input is not mutated.
 *
 * The `at` and `changeId` inputs are parameters rather than `Date.now()` and an internal
 * counter, so a test can assert the exact resulting document.
 *
 * @param {object} delivery - current normalized overlay.
 * @param {string} op - the operation name.
 * @param {object} payload - operation payload.
 * @param {{at: number, actor?: string, changeId?: string}} context - time, author and a
 *   reserved change-log id (needed because the id must be derived from the pre-state).
 * @returns {{delivery: object, created?: string} | {error: string, code: string, proposal?: object, delivery?: object}}
 */
/**
 * 「一段话」的校验收口 —— 预期产出与概览目标共用同一条规则。
 *
 * 抽出来不是为了少打几行字：**这两格对用户的承诺是同一句话**（「你在这里看到的，是 Agent
 * 写的一段话」）。一旦有一边悄悄放宽 —— 比如只查长度、不查分段 —— 页面上并排的两格就会长得
 * 一样却遵守不同的契约，而那种不一致从界面上看不出来。
 *
 * 判据是**空行**而不是换行：一段话里的软换行仍然是一段，空行才是真的分了段。
 * 超长一律**拒绝**而不是截断：被截断的概览会以一个「长度正常」的样子留在卡片上。
 *
 * @param {unknown} value - 模型给的原文。
 * @param {string} label - 中文名，写进拒绝文案。
 * @param {string} key - payload 字段名，写进拒绝文案（模型要知道该补哪个键）。
 * @param {number} max - 字数上限。
 * @returns {{ok: true, body: string} | {ok: false, error: string, code: string}}
 */
function oneParagraph(value, label, key, max) {
  if (typeof value !== 'string') {
    return { ok: false, error: `缺少${label}（${key}）`, code: ERROR_CODES.INVALID_STATE }
  }
  const body = value.replace(/\r\n/g, '\n').trim()
  if (body === '') {
    return {
      ok: false,
      error: `${label}不能是空的 —— 空字符串不等于「还没想好」，它会让页面把没填读成填了`,
      code: ERROR_CODES.INVALID_STATE,
    }
  }
  if (/\n[ \t]*\n/.test(body)) {
    return {
      ok: false,
      error: `${label}必须是**一段**，这里用空行分成了多段。压成一段再提交 —— `
        + '页面按「一段话」排版这一格，分段会让它变成一篇文章，而它要回答的是一句话的问题。',
      code: ERROR_CODES.INVALID_STATE,
    }
  }
  if (body.length > max) {
    return {
      ok: false,
      error: `${label}有 ${body.length} 字，超过上限 ${max} —— 要的是概括，不是改写。`,
      code: ERROR_CODES.INVALID_STATE,
    }
  }
  return { ok: true, body }
}

export function applyDeliveryOp(delivery, op, payload, context) {
  const at = nonNegativeInteger(context?.at)
  const actor = oneOf(context?.actor, ACTORS, 'agent')
  const next = structuredClone(delivery)
  const input = isRecord(payload) ? payload : {}
  const changeId = typeof context?.changeId === 'string' ? context.changeId : nextId('C', next.changes)
  const problems = []

  const propose = (field, proposed, current, value, target) => {
    const proposal = {
      id: nextId('P', next.proposals),
      field,
      target: typeof target === 'string' ? target : '',
      current: typeof current === 'string' ? current : '',
      proposed: typeof proposed === 'string' ? proposed : JSON.stringify(proposed),
      value: value === undefined ? (typeof proposed === 'string' ? null : proposed) : value,
      reason: text(input.reason) ?? '',
      impact: text(input.impact) ?? '',
      requiresHuman: true,
      status: 'pending',
      at,
    }
    next.proposals.push(proposal)
    clampPush(next.proposals, MAX_PROPOSALS)
    recordChange(next, at, actor, `propose:${field}`, proposal.proposed, changeId)
    next.revision += 1
    next.updatedAt = at
    return {
      error: `${field} 属于人类权威，Agent 不能直接改写。已记录为变更提案 ${proposal.id}，等用户确认。`,
      code: ERROR_CODES.HUMAN_CONFIRMATION_REQUIRED,
      proposal,
      delivery: next,
    }
  }

  switch (op) {
    // ---- acceptance
    case 'addAcceptance': {
      if (next.acceptance.length >= MAX_ACCEPTANCE) return { error: `验收标准数量已达上限 ${MAX_ACCEPTANCE}`, code: ERROR_CODES.INVALID_STATE }
      const description = text(input.description)
      if (description === undefined) return { error: '缺少验收标准描述（description）', code: ERROR_CODES.INVALID_STATE }
      const row = {
        id: nextId('AC', next.acceptance),
        description,
        status: 'pending',
        mandatory: input.mandatory !== false,
        evidence: [],
        verifiedAt: null,
      }
      next.acceptance.push(row)
      recordChange(next, at, actor, `add ${row.id}`, description, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, created: row.id }
    }

    case 'setAcceptanceStatus': {
      const row = findAcceptance(next, text(input.id, 32) ?? '', problems)
      if (row === undefined) return { error: problems.join('；'), code: ERROR_CODES.NOT_FOUND }
      const status = oneOf(input.status, ACCEPTANCE_STATUSES, undefined)
      if (status === undefined) return { error: `status 必须是 ${ACCEPTANCE_STATUSES.join(' / ')}`, code: ERROR_CODES.INVALID_STATE }
      if (status === 'verified') {
        // The only place a criterion becomes verified, so the evidence requirement has
        // exactly one implementation. Verifying by passing an empty list is refused here
        // rather than caught later by the gate, so the model learns immediately.
        const added = stringList(input.evidence, 20)
        const known = new Set(next.evidence.map((entry) => entry.id))
        const unknown = added.filter((id) => !known.has(id))
        if (unknown.length > 0) return { error: `证据 ${unknown.join(', ')} 不存在`, code: ERROR_CODES.MISSING_EVIDENCE }
        row.evidence = [...new Set([...row.evidence, ...added])]
        if (row.evidence.length === 0) {
          return { error: `${row.id} 要标记为 verified，必须先用 addEvidence 记录至少一条证据`, code: ERROR_CODES.MISSING_EVIDENCE }
        }
        row.verifiedAt = at
      } else {
        row.verifiedAt = null
      }
      row.status = status
      recordChange(next, at, actor, `set ${row.id} = ${status}`, addedSafe(input), changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    // ---- tasks
    case 'addTask': {
      if (next.tasks.length >= MAX_TASKS) return { error: `任务数量已达上限 ${MAX_TASKS}`, code: ERROR_CODES.INVALID_STATE }
      const title = text(input.title)
      if (title === undefined) return { error: '缺少任务标题（title）', code: ERROR_CODES.INVALID_STATE }
      const knownAcceptance = new Set(next.acceptance.map((row) => row.id))
      const knownTasks = new Set(next.tasks.map((row) => row.id))
      const row = {
        id: nextId('T', next.tasks),
        title,
        status: oneOf(input.status, TASK_STATUSES, 'pending'),
        acceptance: refList(input.acceptance, knownAcceptance),
        dependsOn: refList(input.dependsOn, knownTasks),
        artifacts: stringList(input.artifacts, 20),
      }
      next.tasks.push(row)
      recordChange(next, at, actor, `add ${row.id}`, title, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, created: row.id }
    }

    // ---- 改内容 / 删（Agent 中途调整计划）
    //
    // 「加」与「改状态」早就有，缺的是**改内容**和**删**。这不是权限问题 —— §65 的 Authority
    // Matrix 里任务状态与证据本来就归 Agent 写；是这两条路从来没实现，于是 Agent 一旦把
    // 任务标题写歪、或把一条证据记错，只能再堆一条新的上去，让后面读的人自己分辨哪条是对的。
    // **能改能删，才叫「执行途中可调整」。**
    //
    // 删是**追加式历史的例外**，所以它记两条：一条 `remove`，一条把删掉的标题留在变更里 ——
    // 否则事后看历史只知道「少了一条 T-003」，不知道它原本是什么。
    case 'setTask': {
      const id = text(input.id, 32) ?? ''
      const row = next.tasks.find((entry) => entry.id === id)
      if (row === undefined) return { error: `任务 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      const title = text(input.title)
      if (title !== undefined) row.title = title
      // 关联可以整体替换（区别于 setTaskStatus 的「追加产出」）：改计划时会想把某个任务
      // 从一条验收标准挪到另一条。显式给了才动，没给就保持原样。
      if (input.acceptance !== undefined) {
        const known = new Set(next.acceptance.map((entry) => entry.id))
        row.acceptance = refList(input.acceptance, known)
      }
      if (input.dependsOn !== undefined) {
        const knownTasks = new Set(next.tasks.map((entry) => entry.id))
        // 不能依赖自己：那会生成一个只有它自己的环，任务树会把它当根节点排出来。
        row.dependsOn = refList(input.dependsOn, knownTasks).filter((dep) => dep !== row.id)
      }
      recordChange(next, at, actor, `edit ${row.id}`, row.title, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'removeTask': {
      const id = text(input.id, 32) ?? ''
      const row = next.tasks.find((entry) => entry.id === id)
      if (row === undefined) return { error: `任务 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      next.tasks = next.tasks.filter((entry) => entry.id !== id)
      // 被别人依赖的任务不能悄悄消失：那会让依赖它的任务指向一个不存在的节点。
      // taskTree 有「依赖项不在本计划里就当根」的兜底，所以不会崩 —— 但那会安静地改变树的形状。
      const orphans = next.tasks.filter((entry) => entry.dependsOn.includes(id))
      for (const entry of orphans) entry.dependsOn = entry.dependsOn.filter((dep) => dep !== id)
      recordChange(next, at, actor, `remove ${id}`, row.title, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, removed: row.id, detached: orphans.map((entry) => entry.id) }
    }

    case 'setEvidence': {
      const id = text(input.id, 32) ?? ''
      const row = next.evidence.find((entry) => entry.id === id)
      if (row === undefined) return { error: `证据 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      const summary = text(input.summary)
      if (summary !== undefined) row.summary = summary
      if (input.kind !== undefined) {
        const kind = oneOf(input.kind, EVIDENCE_KINDS, undefined)
        if (kind === undefined) return { error: `kind 必须是 ${EVIDENCE_KINDS.join(' / ')}`, code: ERROR_CODES.INVALID_STATE }
        row.kind = kind
      }
      if (input.detail !== undefined) row.detail = text(input.detail) ?? ''
      if (input.ref !== undefined) row.ref = text(input.ref, 500) ?? ''
      recordChange(next, at, actor, `edit ${row.id}`, row.summary, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'removeEvidence': {
      const id = text(input.id, 32) ?? ''
      const row = next.evidence.find((entry) => entry.id === id)
      if (row === undefined) return { error: `证据 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      next.evidence = next.evidence.filter((entry) => entry.id !== id)
      // 先把指向它的引用摘干净，再删。留一个悬空的 E-nnn 会让「这条验收标准有什么证据」
      // 指向不存在的记录 —— 那比少一条证据更糟，因为它看起来像有证据。
      const stillReferenced = []
      for (const criterion of next.acceptance) {
        if (criterion.evidence.includes(id)) {
          criterion.evidence = criterion.evidence.filter((entry) => entry !== id)
          stillReferenced.push(criterion.id)
        }
      }
      recordChange(next, at, actor, `remove ${id}`, row.summary, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, removed: row.id, detached: stillReferenced }
    }

    case 'setTaskStatus': {
      const id = text(input.id, 32) ?? ''
      const row = next.tasks.find((entry) => entry.id === id)
      if (row === undefined) return { error: `任务 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      const status = oneOf(input.status, TASK_STATUSES, undefined)
      if (status === undefined) return { error: `status 必须是 ${TASK_STATUSES.join(' / ')}`, code: ERROR_CODES.INVALID_STATE }
      if (status === 'verified' && row.artifacts.length === 0 && row.acceptance.length === 0) {
        return { error: `${row.id} 要标记为 verified，需要先关联验收标准或产出文件`, code: ERROR_CODES.MISSING_EVIDENCE }
      }
      row.status = status
      const added = stringList(input.artifacts, 20)
      if (added.length > 0) row.artifacts = [...new Set([...row.artifacts, ...added])]
      recordChange(next, at, actor, `set ${row.id} = ${status}`, row.title, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    // ---- evidence
    case 'addEvidence': {
      if (next.evidence.length >= MAX_EVIDENCE) return { error: `证据数量已达上限 ${MAX_EVIDENCE}`, code: ERROR_CODES.INVALID_STATE }
      const summary = text(input.summary)
      if (summary === undefined) return { error: '缺少证据说明（summary）', code: ERROR_CODES.INVALID_STATE }
      const row = {
        id: nextId('E', next.evidence),
        kind: oneOf(input.kind, EVIDENCE_KINDS, 'external'),
        summary,
        detail: text(input.detail) ?? '',
        ref: text(input.ref, 500) ?? '',
        at,
      }
      next.evidence.push(row)
      const targets = stringList(input.acceptance, 20).filter((id) => next.acceptance.some((entry) => entry.id === id))
      for (const id of targets) {
        const criterion = next.acceptance.find((entry) => entry.id === id)
        criterion.evidence = [...new Set([...criterion.evidence, row.id])]
      }
      recordChange(next, at, actor, `add ${row.id}`, summary, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, created: row.id }
    }

    // ---- focus / next
    case 'setFocus': {
      const focus = text(input.focus, MAX_FOCUS_CHARS)
      if (focus === undefined) return { error: '缺少当前焦点（focus）', code: ERROR_CODES.INVALID_STATE }
      next.focus = focus
      recordChange(next, at, actor, 'set focus', focus, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'setNext': {
      if (!Array.isArray(input.next)) return { error: 'next 必须是字符串数组', code: ERROR_CODES.INVALID_STATE }
      next.next = stringList(input.next, MAX_NEXT_ITEMS)
      recordChange(next, at, actor, 'set next', next.next.join(' / '), changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'setExpectedOutput': {
      // 「一段话」是用户明确提的要求，所以这里**真的去查它是不是一段**。
      // 只在工具描述里写一句「请写成一段」是不够的：模型会写三段，而页面上那三段的排版
      // 看起来还挺好 —— 坏得不像坏的，就没人会回来改。
      const checked = oneParagraph(input.expectedOutput, '预期产出', 'expectedOutput', MAX_EXPECTED_OUTPUT_CHARS)
      if (!checked.ok) return { error: checked.error, code: checked.code }
      next.expectedOutput = checked.body
      recordChange(next, at, actor, 'set expected output', checked.body, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    // 概览目标：与预期产出共用同一条规则（`oneParagraph`），只是上限更短、位置不同 ——
    // 它在概览卡最上面（抬头一句），预期产出在它下面（对结果的承诺）。
    //
    // 两格都**不是**人类权威字段：它们是 Agent 对同一个目标的两个视角，所以归 Agent 写。
    // 目标原文一个字都不动 —— 完整的那份仍然由「完整计划」视窗承载。
    case 'setGoalSummary': {
      const checked = oneParagraph(input.goalSummary, '概览目标', 'goalSummary', MAX_GOAL_SUMMARY_CHARS)
      if (!checked.ok) return { error: checked.error, code: checked.code }
      next.goalSummary = checked.body
      recordChange(next, at, actor, 'set goal summary', checked.body, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'proposeScope': {
      // Scope is a human-authority field; an agent changing it is the exact behaviour
      // AC-011 forbids. The op is NAMED `proposeScope` rather than `setScope` so the name
      // cannot read as "this one writes", and so a reviewer checking the agent-facing
      // surface sees the proposal in the op list itself.
      const included = stringList(input.included, 50)
      const excluded = stringList(input.excluded, 50)
      if (included.length === 0 && excluded.length === 0) {
        return { error: '范围提案需要至少一条 included 或 excluded', code: ERROR_CODES.INVALID_STATE }
      }
      const value = { included, excluded }
      return propose('scope', `${included.length} 项包含 / ${excluded.length} 项排除`, describeScope(next.scope), value)
    }

    case 'proposeConstraints': {
      const constraints = stringList(input.constraints, 50)
      if (constraints.length === 0) return { error: '约束提案需要至少一条 constraints', code: ERROR_CODES.INVALID_STATE }
      return propose('constraints', constraints.join(' / '), next.constraints.length === 0 ? '（未填写）' : next.constraints.join('、'), constraints)
    }

    // ---- blockers
    case 'addBlocker': {
      const code = text(input.code, 64)
      const message = text(input.message)
      if (code === undefined || !SLUG.test(code)) {
        return { error: 'blocker 需要一个 lower-kebab-case 的 code，例如 missing-credentials', code: ERROR_CODES.INVALID_STATE }
      }
      if (message === undefined) return { error: '缺少阻塞说明（message）', code: ERROR_CODES.INVALID_STATE }
      const row = { id: nextId('B', next.blockers), code, message, at, resolvedAt: null }
      next.blockers.push(row)
      clampPush(next.blockers, MAX_BLOCKERS)
      recordChange(next, at, actor, `blocker ${row.id}`, `${code}: ${message}`, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, created: row.id }
    }

    case 'resolveBlocker': {
      const id = text(input.id, 32) ?? ''
      const row = next.blockers.find((entry) => entry.id === id)
      if (row === undefined) return { error: `阻塞 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      row.resolvedAt = at
      recordChange(next, at, actor, `resolve ${row.id}`, row.message, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    // ---- decisions
    case 'addDecision': {
      if (next.decisions.length >= MAX_DECISIONS) return { error: `决策数量已达上限 ${MAX_DECISIONS}`, code: ERROR_CODES.INVALID_STATE }
      const decision = text(input.decision)
      if (decision === undefined) return { error: '缺少决策内容（decision）', code: ERROR_CODES.INVALID_STATE }
      const row = {
        id: nextId('D', next.decisions),
        decision,
        reason: text(input.reason) ?? '',
        alternatives: text(input.alternatives) ?? '',
        rejectedBecause: text(input.rejectedBecause) ?? '',
        at,
      }
      next.decisions.push(row)
      recordChange(next, at, actor, `decide ${row.id}`, decision, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, created: row.id }
    }

    // ---- proposals
    case 'proposeObjective': {
      return propose('objective', input.objective, next.objectiveMirror ?? '')
    }

    case 'proposeAcceptanceChange': {
      const row = findAcceptance(next, text(input.id, 32) ?? '', problems)
      if (row === undefined) return { error: problems.join('；'), code: ERROR_CODES.NOT_FOUND }
      const description = text(input.description)
      if (description === undefined) return { error: '缺少建议的验收标准文本（description）', code: ERROR_CODES.INVALID_STATE }
      return propose('acceptance', description, row.description, { id: row.id, description }, row.id)
    }

    case 'withdrawProposal': {
      const id = text(input.id, 32) ?? ''
      const row = next.proposals.find((entry) => entry.id === id)
      if (row === undefined) return { error: `提案 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      row.status = 'withdrawn'
      recordChange(next, at, actor, `withdraw ${row.id}`, row.proposed, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    // ---- reconciliation
    case 'reconcile': {
      // Adopts the live goal identity as the new baseline and appends the change. This is
      // the ONLY op that clears a drift report, and it does so explicitly rather than by
      // silently rewriting the mirror.
      const goalId = text(input.goalId, 200)
      const revision = positiveIntegerOrNull(input.goalRevision)
      const objective = text(input.objective)
      const before = next.goalRevision
      next.goalId = goalId ?? next.goalId
      next.goalRevision = revision ?? next.goalRevision
      if (objective !== undefined) next.objectiveMirror = objective
      recordChange(next, at, actor, 'reconcile', `revision ${before} -> ${next.goalRevision}`, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'declareNonTask': {
      // The second exit from the session gate.
      //
      // It records a DECISION rather than a state: "this exchange is not long-running work".
      // It is deliberately an op the model must call with a reason, because the alternative —
      // reading the model's prose and deciding it sounded casual — is exactly the semantic
      // judgement §39 hands to the model and the harness cannot make. Writing it to the
      // change log also means an escaped gate leaves a trace, so a session that dodged a real
      // task can be seen doing it.
      const reason = text(input.reason, 400)
      if (reason === undefined) {
        return { error: 'declareNonTask 需要 payload.reason：说明为什么这不是长期任务。', code: ERROR_CODES.INVALID_STATE }
      }
      recordChange(next, at, actor, 'declare-non-task', reason, changeId)
      next.nonTask = { reason, at }
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    // ---- 状态链：每一轮都要答的两步 ------------------------------------------
    case 'judgeChain': {
      // 为什么是「必须回答」而不是「必须命中」：用户要的两条分支都从**同一个判断**出发。
      // 未命中不是跳过，是另一个答案 —— 它允许本轮不建目标，但判断本身照做，而且留下痕迹。
      // 两个值都走白名单：含糊的字符串会让页面显示一个 Agent 从没做过的判断。
      const goalMatch = oneOf(input.goalMatch, CHAIN_GOAL_MATCH, null)
      const skillCheck = oneOf(input.skillCheck, CHAIN_SKILL_CHECK, null)
      if (goalMatch === null || skillCheck === null) {
        return {
          error: 'judgeChain 需要 payload.goalMatch（matched|none）与 payload.skillCheck（hit|none）两个值都填。',
          code: ERROR_CODES.INVALID_STATE,
        }
      }
      next.chain = { goalMatch, skillCheck, at }
      recordChange(next, at, actor, 'judge-chain', `goalMatch=${goalMatch} skillCheck=${skillCheck}`, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    // ---- 激活技能清单 ---------------------------------------------------------
    case 'activateSkill': {
      if (next.skills.length >= MAX_SKILLS) return { error: `激活技能已达上限 ${MAX_SKILLS}`, code: ERROR_CODES.INVALID_STATE }
      // 四个字段全部必填。这条记录存在的理由是回答「为什么这一轮要用它」，缺任何一半都答不出来
      // —— 那就只是一行噪音，而噪音会让真正读过的那几条显得同样可疑。
      const name = text(input.name, 200)
      const description = text(input.description)
      const purpose = text(input.purpose)
      const source = text(input.source, 1000)
      const missing = []
      if (name === undefined) missing.push('name（技能名称）')
      if (description === undefined) missing.push('description（技能描述）')
      if (purpose === undefined) missing.push('purpose（针对本次任务的作用）')
      if (source === undefined) missing.push('source（仓库链接或本地路径）')
      if (missing.length > 0) {
        return { error: `activateSkill 还缺：${missing.join('、')}`, code: ERROR_CODES.INVALID_STATE }
      }
      if (next.skills.some((row) => row.name === name)) {
        return { error: `技能 ${name} 已经登记过。要改描述或作用用 setSkill，不要登记两条。`, code: ERROR_CODES.INVALID_STATE }
      }
      const row = { id: nextId('S', next.skills), name, description, purpose, source, at }
      next.skills.push(row)
      clampPush(next.skills, MAX_SKILLS)
      recordChange(next, at, actor, `activate ${row.id}`, `${name} —— ${purpose}`, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, created: row.id }
    }

    case 'setSkill': {
      const id = text(input.id, 32) ?? ''
      const row = next.skills.find((entry) => entry.id === id)
      if (row === undefined) return { error: `激活技能 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      const name = text(input.name, 200)
      const description = text(input.description)
      const purpose = text(input.purpose)
      const source = text(input.source, 1000)
      if (name === undefined && description === undefined && purpose === undefined && source === undefined) {
        return { error: 'setSkill 至少要给一个要改的字段', code: ERROR_CODES.INVALID_STATE }
      }
      // 省略的字段保持不变 —— 与 setTask 同一口径：改一个错别字不该逼调用方重述整条。
      if (name !== undefined) {
        if (next.skills.some((entry) => entry.id !== id && entry.name === name)) {
          return { error: `技能 ${name} 已经登记过`, code: ERROR_CODES.INVALID_STATE }
        }
        row.name = name
      }
      if (description !== undefined) row.description = description
      if (purpose !== undefined) row.purpose = purpose
      if (source !== undefined) row.source = source
      recordChange(next, at, actor, `edit ${row.id}`, row.name, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'removeSkill': {
      const id = text(input.id, 32) ?? ''
      const row = next.skills.find((entry) => entry.id === id)
      if (row === undefined) return { error: `激活技能 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      next.skills = next.skills.filter((entry) => entry.id !== id)
      recordChange(next, at, actor, `deactivate ${id}`, row.name, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next, removed: id }
    }

    default:
      return { error: `未知操作 "${op}"`, code: ERROR_CODES.INVALID_STATE }
  }
}

/**
 * Which required parts of a goal plan are still unanswered.
 *
 * WHY THIS IS A GATE AND NOT A WARNING
 *
 * The completion gate can already refuse `complete` when acceptance is empty — but by then the
 * work is DONE, so the refusal is a post-mortem: it says "you built the wrong thing and cannot
 * prove it". The same check at the START is worth far more, because the plan can still change.
 * That is the whole argument for a session gate, applied one level down.
 *
 * WHY A PENDING PROPOSAL COUNTS AS ANSWERED
 *
 * Scope and constraints are `propose*` ops: §24/§65 give the AGENT no authority to set them and
 * require a human to decide. So a version of this function that only looked at the settled
 * value would DEADLOCK — it would demand a non-empty scope while the only way to produce one
 * runs through a user who has not answered yet. The first draft did exactly that, and only the
 * gate's own test caught it.
 *
 * The correct reading of "answered" is therefore: the value is set, OR the agent has asked and
 * the question is with the human. Waiting on a pending proposal is not a gap in the plan — it
 * is the plan working as designed, and the gate must let work continue while it does.
 *
 * Required fields, each because leaving it open makes a later decision impossible rather than
 * merely less tidy:
 *
 *   acceptance  without it "done" is unjudgeable — §16/§20's core claim
 *   scope       without it "done enough" is unjudgeable, and §23 says a scope the user set must
 *               beat the agent's own plan; you cannot honour a boundary you never drew
 *   constraints what the work may not do. "无" is a legitimate ANSWER; the requirement is that
 *               the question was asked, which is why the refusal says so explicitly.
 *
 * 后两格（概览目标、预期产出）用户明确要求「Agent 填写」。**这条要求必须在这里**，不能只写在
 * 工具描述里 —— 已经实测过一次：描述写了、页面也做了，结果预期产出**空着上线**，而页面上看不出
 * 哪里不对（空态是一句真诚的「还没有写」，它不报错）。
 *
 * 它们和上面三条的区别是**能自己补**（不需要人批），所以这条要求是自愈的：拒绝文本点名它，
 * Agent 调一次 setGoalSummary / setExpectedOutput 门就开了。
 *
 * Deliberately NOT required: focus and next (transient working state — §13 says a trivial turn
 * must not be forced to write), tasks (a plan can be one step), decisions and evidence (both
 * accrete during work by nature).
 *
 * @param {object} delivery - normalized overlay.
 * @returns {string[]} human-readable names of the still-unanswered required fields.
 */
export function missingGoalFields(delivery) {
  const pendingField = (name) =>
    (delivery.proposals ?? []).some((row) => row.field === name && row.status === 'pending')

  const missing = []
  if ((delivery.goalSummary ?? '') === '') missing.push('概览目标')
  if ((delivery.expectedOutput ?? '') === '') missing.push('预期产出')
  if ((delivery.acceptance ?? []).length === 0) missing.push('验收标准')

  const scope = delivery.scope ?? {}
  const hasScope = (scope.included?.length ?? 0) + (scope.excluded?.length ?? 0) > 0
  if (!hasScope && !pendingField('scope')) missing.push('范围边界')

  if ((delivery.constraints ?? []).length === 0 && !pendingField('constraints')) missing.push('已知约束')
  return missing
}

/** The set of ops `applyDeliveryOp` understands — the route validates against it. */
export const DELIVERY_OPS = Object.freeze([
  'addAcceptance',
  'setAcceptanceStatus',
  'addTask',
  'setTaskStatus',
  // 改内容 / 删：Agent 与人都能写（§65 里 Task State 与 Evidence 本来就归 Agent）。
  // 加进来是为了让「执行途中调整计划」成立 —— 只能加不能改，写歪一条就只能再堆一条，
  // 后面读的人得自己去分辨哪条是对的。
  'setTask',
  'removeTask',
  'addEvidence',
  'setEvidence',
  'removeEvidence',
  'setFocus',
  'setNext',
  // 预期产出与 focus / next 同类：都是 Agent 写的**执行记录**，不碰目标 / 范围 / 约束 /
  // 必须的验收标准那些人类权威字段（§65 的 Human 列）。所以它进这张表，不进 PROPOSAL_OPS。
  'setExpectedOutput',
  // 概览目标：与预期产出同一类（Agent 写的执行记录，不是人类权威字段），所以进这张表。
  // 它比预期产出更靠前，因为它在卡片最上面 —— 但**顺序由页面决定，这里只登记能力**。
  'setGoalSummary',
  'proposeScope',
  'proposeConstraints',
  'addBlocker',
  'resolveBlocker',
  'addDecision',
  'proposeObjective',
  'proposeAcceptanceChange',
  'withdrawProposal',
  'reconcile',
  'declareNonTask',
  // 状态链与激活技能清单。这两样是**执行记录**，不是人类权威字段 —— 与 Evidence /
  // Decision Log 同一类（§65 的 Agent 列），所以归 Agent 写。页面只投影，不写。
  'judgeChain',
  'activateSkill',
  'setSkill',
  'removeSkill',
])

/**
 * Operations only a human may perform.
 *
 * Kept in a SEPARATE function rather than behind an `if (actor === 'human')` inside
 * `applyDeliveryOp`. That is the whole point: the actor check is then structural — there is
 * no code path from an agent-authored call into these branches, so no future edit can
 * forget the guard. The brief's §24 and AC-011 are about exactly this class of mistake.
 *
 * Reachable only from the page's own POST route, which is the loopback-only, user-driven
 * surface. The model has no tool that calls this.
 */
export const HUMAN_OPS = Object.freeze([
  'adoptProposal',
  'rejectProposal',
  'setAcceptance',
  'addAcceptanceAsHuman',
  'removeAcceptance',
  'setScopeAsHuman',
  'setObjectiveAsHuman',
])

/**
 * Apply one human-authority operation.
 *
 * @param {object} delivery - current normalized overlay.
 * @param {string} op - the op name.
 * @param {object} payload - op payload.
 * @param {{at: number, changeId?: string}} context - time and a reserved change-log id.
 * @returns {{delivery: object, created?: string} | {error: string, code: string}}
 */
export function applyHumanOp(delivery, op, payload, context) {
  const at = nonNegativeInteger(context?.at)
  const next = structuredClone(delivery)
  const input = isRecord(payload) ? payload : {}
  const changeId = typeof context?.changeId === 'string' ? context.changeId : nextId('C', next.changes)
  const actor = 'human'

  switch (op) {
    case 'adoptProposal': {
      const id = text(input.id, 32) ?? ''
      const proposal = next.proposals.find((entry) => entry.id === id)
      if (proposal === undefined) return { error: `提案 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      if (proposal.status !== 'pending') return { error: `提案 ${id} 已经是 ${proposal.status}，不能再次采纳`, code: ERROR_CODES.INVALID_STATE }

      // The edit is applied by field. `objective` and `scope` need no runtime call here:
      // the objective lives in the runtime goal, which this plugin never writes, so
      // adopting an objective proposal only moves the overlay's mirror and records the
      // decision. The user still has to make the runtime change through /goal — and the
      // page says so rather than implying otherwise.
      if (proposal.field === 'scope') {
        const value = proposal.value
        if (isRecord(value)) next.scope = { included: stringList(value.included, 50), excluded: stringList(value.excluded, 50) }
      } else if (proposal.field === 'constraints') {
        next.constraints = Array.isArray(proposal.value) ? stringList(proposal.value, 50) : stringList([proposal.proposed], 50)
      } else if (proposal.field === 'acceptance') {
        const target = text(proposal.target, 32)
        const row = target === undefined ? undefined : next.acceptance.find((entry) => entry.id === target)
        if (row !== undefined && isRecord(proposal.value) && typeof proposal.value.description === 'string') {
          row.description = text(proposal.value.description) ?? row.description
        }
      } else if (proposal.field === 'objective') {
        next.objectiveMirror = text(proposal.proposed) ?? next.objectiveMirror
      }

      proposal.status = 'adopted'
      recordChange(next, at, actor, `adopt ${proposal.id}`, `${proposal.field}: ${proposal.proposed}`, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'rejectProposal': {
      const id = text(input.id, 32) ?? ''
      const proposal = next.proposals.find((entry) => entry.id === id)
      if (proposal === undefined) return { error: `提案 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      proposal.status = 'withdrawn'
      recordChange(next, at, actor, `reject ${proposal.id}`, text(input.reason) ?? '', changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'setAcceptance':
    case 'addAcceptanceAsHuman': {
      const id = text(input.id, 32)
      if (id === undefined) {
        if (next.acceptance.length >= MAX_ACCEPTANCE) return { error: `验收标准数量已达上限 ${MAX_ACCEPTANCE}`, code: ERROR_CODES.INVALID_STATE }
        const description = text(input.description)
        if (description === undefined) return { error: '缺少验收标准描述（description）', code: ERROR_CODES.INVALID_STATE }
        const row = { id: nextId('AC', next.acceptance), description, status: 'pending', mandatory: input.mandatory !== false, evidence: [], verifiedAt: null }
        next.acceptance.push(row)
        recordChange(next, at, actor, `add ${row.id}`, description, changeId)
        next.revision += 1
        next.updatedAt = at
        return { delivery: next, created: row.id }
      }
      const row = next.acceptance.find((entry) => entry.id === id)
      if (row === undefined) return { error: `验收标准 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      const description = text(input.description)
      if (description !== undefined) row.description = description
      if (typeof input.mandatory === 'boolean') row.mandatory = input.mandatory
      // A human may verify without pre-registered evidence: the human IS the evidence, and
      // the route records that as a `user_confirmation` row so the artifact does not end up
      // claiming "verified with no evidence" — the exact state the gate exists to prevent.
      if (input.status !== undefined) {
        const status = oneOf(input.status, ACCEPTANCE_STATUSES, undefined)
        if (status === undefined) return { error: `status 必须是 ${ACCEPTANCE_STATUSES.join(' / ')}`, code: ERROR_CODES.INVALID_STATE }
        if (status === 'verified' && row.evidence.length === 0) {
          const evidence = {
            id: nextId('E', next.evidence),
            kind: 'user_confirmation',
            summary: text(input.note, MAX_TEXT_CHARS) ?? `用户在「目标」页确认 ${row.id} 满足`,
            detail: '',
            ref: '',
            at,
          }
          next.evidence.push(evidence)
          row.evidence = [evidence.id]
        }
        row.status = status
        row.verifiedAt = status === 'verified' ? at : null
      }
      recordChange(next, at, actor, `set ${row.id}`, row.status, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'removeAcceptance': {
      const id = text(input.id, 32) ?? ''
      const row = next.acceptance.find((entry) => entry.id === id)
      if (row === undefined) return { error: `验收标准 ${id} 不存在`, code: ERROR_CODES.NOT_FOUND }
      next.acceptance = next.acceptance.filter((entry) => entry.id !== id)
      for (const task of next.tasks) task.acceptance = task.acceptance.filter((entry) => entry !== id)
      recordChange(next, at, actor, `remove ${id}`, row.description, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'setScopeAsHuman': {
      next.scope = { included: stringList(input.included, 50), excluded: stringList(input.excluded, 50) }
      recordChange(next, at, actor, 'set scope', `${next.scope.included.length} 包含 / ${next.scope.excluded.length} 排除`, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    case 'setObjectiveAsHuman': {
      const objective = text(input.objective)
      if (objective === undefined) return { error: '缺少目标文本（objective）', code: ERROR_CODES.INVALID_STATE }
      next.objectiveMirror = objective
      recordChange(next, at, actor, 'set objective mirror', objective, changeId)
      next.revision += 1
      next.updatedAt = at
      return { delivery: next }
    }

    default:
      return { error: `未知操作 "${op}"`, code: ERROR_CODES.INVALID_STATE }
  }
}

function addedSafe(input) {
  const bits = []
  if (input.evidence !== undefined) bits.push(`evidence=${JSON.stringify(input.evidence)}`)
  if (input.reason !== undefined) bits.push(`reason=${text(input.reason, 200) ?? ''}`)
  return bits.join(' ')
}

// ---------------------------------------------------------------- markdown projection

/**
 * Render the artifact.
 *
 * DETERMINISTIC: the same (delivery, runtimeGoal) pair produces byte-identical output.
 * No `Date.now()` is read — timestamps come from the stored records — so two renders of an
 * unchanged state cannot differ, which is what lets the host half skip the write when the
 * content has not changed (brief §47).
 *
 * The section list is the brief's §14 numbering. It is emitted in full even when a section
 * is empty, because a reader (human or model) should be able to find "## 8. 风险与阻塞"
 * and see that it is empty rather than learn that the heading is sometimes absent.
 *
 * @param {object} delivery - normalized overlay.
 * @param {object|null} runtimeGoal - the live goal view.
 * @param {{generatedAt?: number, artifactPath?: string}} [meta]
 * @returns {string} the Markdown document.
 */
export function renderGoalMarkdown(delivery, runtimeGoal, meta = {}) {
  const live = runtimeGoal !== null && runtimeGoal !== undefined
  const summary = summarize(delivery, runtimeGoal)
  const lines = []

  lines.push('# Goal')
  lines.push('')
  lines.push(`> 本文件由 LuzzyPage 的「目标」页生成，是运行时 Goal 状态的投影。**不要手工编辑**——写入会按运行时状态覆盖。`)
  if (meta.artifactPath !== undefined) lines.push(`> 落点：\`${inline(meta.artifactPath)}\``)
  lines.push('')

  // 1 — objective
  lines.push('## 1. 预期目标')
  lines.push('')
  if (live) {
    lines.push(runtimeGoal.objective)
    lines.push('')
    lines.push(
      `- 状态：${runtimeGoal.phase}` +
      `${runtimeGoal.phase === 'active' ? `（续行 ${runtimeGoal.activation === 'armed' ? '已启用' : '未启用'}）` : ''}`,
    )
    lines.push(`- 修订：${runtimeGoal.revision}`)
    lines.push(`- 轮次：${runtimeGoal.roundsStarted} / ${runtimeGoal.maxGoalRounds}`)
    lines.push(`- goal id：\`${runtimeGoal.id}\``)
    if (runtimeGoal.blockedReason !== undefined) {
      lines.push(`- 运行时阻塞：\`${runtimeGoal.blockedReason.code}\` ${runtimeGoal.blockedReason.message}`)
    }
  } else {
    lines.push(delivery.objectiveMirror ?? '（还没有目标）')
    lines.push('')
    lines.push('- 状态：运行时 Goal 不可用（会话未在本进程加载），以下内容来自本地交付状态。')
  }
  lines.push('')
  lines.push(`- 健康度：${HEALTH_LABELS[summary.health] ?? summary.health}`)
  if (delivery.goalRevision !== null) lines.push(`- 交付计划基于修订：${delivery.goalRevision}`)
  if (meta.generatedAt !== undefined) lines.push(`- 投影时间：${formatStamp(meta.generatedAt)}（UTC）`)
  lines.push('')

  // 1b — 概览目标 + 预期产出。
  //
  // 两格都挂在第 1 节下面、而不是各新开一节再把它后面的 12 节全部往后推一位：编号是给人
  // 指位置用的（「第 5 节看约束」），平移一次，此前所有口头与文字里的指代就全错了。
  // 两个 Agent 写的字段不值得让整份文档的坐标系统动一次。
  //
  // 顺序固定：概览目标在前（抬头一句），预期产出紧跟其后（对结果的承诺）—— 与页面上那两格
  // 的上下关系一致，读者不必在两种顺序之间换算。
  lines.push('### 概览目标')
  lines.push('')
  lines.push(delivery.goalSummary === '' ? '（还没有写概览目标）' : delivery.goalSummary)
  lines.push('')
  lines.push('### 预期产出')
  lines.push('')
  lines.push(delivery.expectedOutput === '' ? '（还没有写预期产出）' : delivery.expectedOutput)
  lines.push('')

  // 2 — acceptance
  lines.push('## 2. 验收标准')
  lines.push('')
  if (delivery.acceptance.length === 0) {
    lines.push('（还没有定义验收标准）')
  } else {
    lines.push('| ID | 验收标准 | 必须 | 状态 | 证据 | 验证时间 |')
    lines.push('|---|---|---|---|---|---|')
    for (const row of delivery.acceptance) {
      lines.push(
        `| ${row.id} | ${inline(row.description)} | ${row.mandatory ? '是' : '否'} | ${row.status} | ` +
        `${row.evidence.length > 0 ? inline(row.evidence.join(', ')) : '-'} | ${row.verifiedAt === null ? '-' : formatStamp(row.verifiedAt)} |`,
      )
    }
  }
  lines.push('')

  // 3 — scope
  lines.push('## 3. 范围与边界')
  lines.push('')
  lines.push('**包含**')
  lines.push('')
  if (delivery.scope.included.length === 0) lines.push('- （未填写）')
  else for (const item of delivery.scope.included) lines.push(`- ${inline(item)}`)
  lines.push('')
  lines.push('**不包含**')
  lines.push('')
  if (delivery.scope.excluded.length === 0) lines.push('- （未填写）')
  else for (const item of delivery.scope.excluded) lines.push(`- ${inline(item)}`)
  lines.push('')

  // 4 — tasks
  lines.push('## 4. 任务拆解')
  lines.push('')
  if (delivery.tasks.length === 0) {
    lines.push('（还没有拆解任务）')
  } else {
    lines.push('| ID | 任务 | 状态 | 关联验收 | 依赖 | 产出 |')
    lines.push('|---|---|---|---|---|---|')
    for (const row of delivery.tasks) {
      lines.push(
        `| ${row.id} | ${inline(row.title)} | ${row.status} | ${row.acceptance.length > 0 ? inline(row.acceptance.join(', ')) : '-'} | ` +
        `${row.dependsOn.length > 0 ? inline(row.dependsOn.join(', ')) : '-'} | ${row.artifacts.length > 0 ? inline(row.artifacts.join(', ')) : '-'} |`,
      )
    }
  }
  lines.push('')

  // 5 — constraints
  lines.push('## 5. 约束条件')
  lines.push('')
  if (delivery.constraints.length === 0) lines.push('（未填写）')
  else for (const item of delivery.constraints) lines.push(`- ${inline(item)}`)
  lines.push('')

  // 6 — current state
  lines.push('## 6. 当前状态')
  lines.push('')
  lines.push(`- 验收标准：${summary.acceptance.verified} / ${summary.acceptance.total} 已验证`)
  lines.push(`- 任务：${summary.tasks.completed} / ${summary.tasks.total} 已完成（进行中 ${summary.tasks.active}）`)
  lines.push(`- 证据：${summary.evidence.total} 条`)
  lines.push(`- 未解决阻塞：${summary.blockers.open}`)
  lines.push(`- 待确认变更提案：${summary.proposals.pending}`)
  lines.push('')

  // 7 — decisions
  lines.push('## 7. 决策记录')
  lines.push('')
  if (delivery.decisions.length === 0) {
    lines.push('（还没有记录决策）')
  } else {
    for (const row of delivery.decisions) {
      lines.push(`### ${row.id}`)
      lines.push('')
      lines.push(`- 决策：${inline(row.decision)}`)
      if (row.reason !== '') lines.push(`- 理由：${inline(row.reason)}`)
      if (row.alternatives !== '') lines.push(`- 备选：${inline(row.alternatives)}`)
      if (row.rejectedBecause !== '') lines.push(`- 未采纳原因：${inline(row.rejectedBecause)}`)
      lines.push(`- 时间：${formatStamp(row.at)}`)
      lines.push('')
    }
    lines.pop()
  }
  lines.push('')

  // 8 — blockers
  lines.push('## 8. 风险与阻塞')
  lines.push('')
  if (delivery.blockers.length === 0) {
    lines.push('（没有阻塞）')
  } else {
    for (const row of delivery.blockers) {
      const state = row.resolvedAt === null ? '**未解决**' : `已解决 ${formatStamp(row.resolvedAt)}`
      lines.push(`- ${row.id} \`${row.code}\` ${inline(row.message)} —— ${state}（${formatStamp(row.at)}）`)
    }
  }
  lines.push('')

  // 9 — artifacts
  lines.push('## 9. 产出物')
  lines.push('')
  const artifacts = []
  for (const task of delivery.tasks) for (const item of task.artifacts) if (!artifacts.includes(item)) artifacts.push(item)
  for (const row of delivery.evidence) if (row.ref !== '' && !artifacts.includes(row.ref)) artifacts.push(row.ref)
  if (artifacts.length === 0) lines.push('（还没有记录产出物）')
  else for (const item of artifacts) lines.push(`- \`${inline(item)}\``)
  lines.push('')

  // 10 — evidence
  lines.push('## 10. 验证与证据')
  lines.push('')
  if (delivery.evidence.length === 0) {
    lines.push('（还没有记录证据）')
  } else {
    for (const row of delivery.evidence) {
      const targets = delivery.acceptance.filter((entry) => entry.evidence.includes(row.id)).map((entry) => entry.id)
      lines.push(`- **${row.id}** \`${row.kind}\` ${inline(row.summary)}`)
      if (row.detail !== '') lines.push(`  - 详情：${inline(row.detail)}`)
      if (row.ref !== '') lines.push(`  - 位置：\`${inline(row.ref)}\``)
      lines.push(`  - 关联：${targets.length > 0 ? targets.join(', ') : '（未关联到验收标准）'} · ${formatStamp(row.at)}`)
    }
  }
  lines.push('')

  // 11 — focus
  lines.push('## 11. 当前焦点')
  lines.push('')
  lines.push(delivery.focus === '' ? '（未填写）' : delivery.focus)
  lines.push('')

  // 12 — next action
  lines.push('## 12. 下一步行动')
  lines.push('')
  if (delivery.next.length === 0) lines.push('（未填写）')
  else delivery.next.forEach((item, index) => lines.push(`${index + 1}. ${inline(item)}`))
  lines.push('')

  // 13 — change log
  lines.push('## 13. 变更记录')
  lines.push('')
  if (delivery.changes.length === 0) {
    lines.push('（还没有变更）')
  } else {
    // Newest last: the log reads as a history, and appending one entry changes only the
    // tail — which keeps a diff of two consecutive projections small.
    for (const row of delivery.changes) {
      lines.push(`- \`${formatStamp(row.at)}\` **${row.actor}** ${inline(row.action)}${row.detail === '' ? '' : ` —— ${inline(row.detail)}`}`)
    }
  }
  lines.push('')

  if (delivery.skills.length > 0 || delivery.chain.goalMatch !== null) {
    lines.push('## 附：状态链与激活技能')
    lines.push('')
    const matchLabel = delivery.chain.goalMatch === 'matched'
      ? '命中（这一轮在推进一个长期目标）'
      : delivery.chain.goalMatch === 'none' ? '未命中（本轮不是长期任务）' : '（还没判断）'
    const skillLabel = delivery.chain.skillCheck === 'hit'
      ? '命中（按技能清单执行）'
      : delivery.chain.skillCheck === 'none' ? '未命中（本轮不按技能清单）' : '（还没判断）'
    lines.push(`- 目标分支：${matchLabel}${delivery.chain.at === 0 ? '' : `（${formatStamp(delivery.chain.at)}）`}`)
    lines.push(`- 技能清单分支：${skillLabel}`)
    lines.push('')
    if (delivery.skills.length === 0) {
      lines.push('（还没有激活任何技能）')
    } else {
      for (const row of delivery.skills) {
        lines.push(`### ${row.id} ${inline(row.name)}`)
        lines.push('')
        lines.push(`- 技能描述：${inline(row.description)}`)
        lines.push(`- 本次任务的作用：${inline(row.purpose)}`)
        lines.push(`- 来源：${inline(row.source)}`)
        lines.push(`- 激活时间：${formatStamp(row.at)}`)
        lines.push('')
      }
      lines.pop()
    }
    lines.push('')
  }

  if (delivery.proposals.filter((row) => row.status === 'pending').length > 0) {
    lines.push('## 附：待确认的变更提案')
    lines.push('')
    for (const row of delivery.proposals) {
      if (row.status !== 'pending') continue
      lines.push(`- **${row.id}** 字段 \`${row.field}\``)
      lines.push(`  - 建议：${inline(row.proposed)}`)
      if (row.current !== '') lines.push(`  - 当前：${inline(row.current)}`)
      if (row.reason !== '') lines.push(`  - 理由：${inline(row.reason)}`)
      if (row.impact !== '') lines.push(`  - 影响：${inline(row.impact)}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
