/**
 * Assert the goal delivery domain: the pure layer every other part rests on.
 *
 * Every case here guards a failure that would be SILENT in production — a criterion
 * verified with no evidence, an agent quietly widening the scope, a plan adopted against a
 * goal that has since been rewritten. None of those throw where a person would see them;
 * they show up as a page that says "完成" about something that is not.
 *
 * Run: node tools/test-goal-domain.mjs
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
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
const GOAL = {
  id: 'goal-abc',
  revision: 3,
  objective: '把 Dashboard 接入 /api/tasks',
  phase: 'active',
  activation: 'armed',
  roundsStarted: 2,
  maxGoalRounds: 256,
}

/**
 * Build an overlay through the real ops, so every case exercises the real mutation path.
 *
 * It ends by BINDING the plan to `GOAL`, because that is now a precondition for a plan with
 * content rather than an optional courtesy. The binding used to be an op the model had to
 * remember; a real session ran 205 changes without ever calling it, which silently switched
 * off both `integrity` step 11 and `detectDrift` — the two guards whose whole job is catching
 * a plan that has drifted from its goal.
 *
 * At the domain level there is no `ctx`, so the auto-bind that `commitOp` performs in the
 * running system cannot happen here; this fixture stands in for it. The unbound case is
 * asserted explicitly further down.
 */
function build(steps, bind = true) {
  let delivery = domain.emptyDelivery('sess-1')
  for (const [op, payload] of steps) {
    const result = domain.applyDeliveryOp(delivery, op, payload, { at: AT, actor: 'agent' })
    if (result.delivery === undefined) throw new Error(`step ${op} failed: ${result.error}`)
    delivery = result.delivery
  }
  if (bind && delivery.changes.length > 0) {
    // Bound to GOAL's exact identity, the way commitOp fills it from the live goal.
    delivery.goalId = GOAL.id
    delivery.goalRevision = GOAL.revision
    delivery.objectiveMirror = GOAL.objective
  }
  return delivery
}

const ACCEPTANCE = ['addAcceptance', { description: 'loading / empty / error 三态都有' }]
const ACCEPTANCE2 = ['addAcceptance', { description: '测试通过' }]
const TASK = ['addTask', { title: '接入 /api/tasks', acceptance: ['AC-001'] }]
const EVIDENCE = ['addEvidence', { summary: 'pnpm test passed', kind: 'test', ref: 'pnpm test', acceptance: ['AC-001'] }]

try {
  console.log('goal-domain: ids')
  {
    eq('first id is padded', domain.nextId('AC', []), 'AC-001')
    eq('next follows the highest, not the length', domain.nextId('AC', [{ id: 'AC-001' }, { id: 'AC-005' }]), 'AC-006')
    // Removing AC-002 from three must not hand AC-003's number to the next addition: task
    // and evidence rows reference those numbers.
    eq('a gap is not reused', domain.nextId('AC', [{ id: 'AC-001' }, { id: 'AC-003' }]), 'AC-004')
    eq('non-matching ids are ignored', domain.nextId('T', [{ id: 'AC-009' }]), 'T-001')
  }

  console.log('goal-domain: completion gate refuses what it cannot verify')
  {
    const empty = domain.emptyDelivery('s')
    const gate = domain.completionGate(empty, GOAL)
    eq('no acceptance criteria blocks completion', gate.allowed, false)
    eq('and says which code', gate.code, domain.ERROR_CODES.MISSING_ACCEPTANCE)
    check('the refusal names the missing piece', /验收标准/.test(domain.renderCompletionRefusal(gate)))
  }
  {
    const d = build([ACCEPTANCE, ACCEPTANCE2, TASK, EVIDENCE])
    const gate = domain.completionGate(d, GOAL)
    eq('an unverified criterion blocks completion', gate.allowed, false)
    eq('unverified lists it', gate.unverified.join(','), 'AC-001,AC-002')
    eq('the open task is listed as remaining work', gate.remainingWork.length, 1)
  }
  {
    // The point of the gate: it is not satisfied by the model SAYING it is done. Every
    // mandatory criterion must be verified AND carry evidence.
    //
    // This build has NO evidence linked to AC-001 yet, which is the case the check is
    // about — an earlier version of this test linked the evidence up front and then
    // asserted a refusal, which could never have happened.
    const base = build([ACCEPTANCE, TASK, ['setTaskStatus', { id: 'T-001', status: 'completed' }]])
    const refused = domain.applyDeliveryOp(base, 'setAcceptanceStatus', { id: 'AC-001', status: 'verified' }, { at: AT })
    eq('verifying with nothing behind it is refused', refused.code, domain.ERROR_CODES.MISSING_EVIDENCE)
    const withEvidence = domain.applyDeliveryOp(base, 'addEvidence', { summary: 'pnpm test passed', kind: 'test', acceptance: ['AC-001'] }, { at: AT })
    const good = domain.applyDeliveryOp(withEvidence.delivery, 'setAcceptanceStatus', { id: 'AC-001', status: 'verified' }, { at: AT })
    eq('once evidence is linked, verifying succeeds without repeating it', good.error, undefined)
    const gate = domain.completionGate(good.delivery, GOAL)
    eq('and only then does the gate allow completion', gate.allowed, true)
  }
  {
    const base = build([ACCEPTANCE, EVIDENCE])
    const bogus = domain.applyDeliveryOp(base, 'setAcceptanceStatus', { id: 'AC-001', status: 'verified', evidence: ['E-999'] }, { at: AT })
    // A reference to evidence that does not exist must not satisfy "has evidence".
    eq('referencing a non-existent evidence row is refused', bogus.code, domain.ERROR_CODES.MISSING_EVIDENCE)
  }
  {
    const d = build([ACCEPTANCE, EVIDENCE])
    const optional = domain.applyDeliveryOp(d, 'addAcceptance', { description: '可选的打磨', mandatory: false }, { at: AT })
    const gate = domain.completionGate(optional.delivery, GOAL)
    eq('a non-mandatory criterion is not listed as unverified', gate.unverified.join(','), 'AC-001')
    eq('but the mandatory one still blocks', gate.allowed, false)
    const done = domain.applyDeliveryOp(optional.delivery, 'setAcceptanceStatus', { id: 'AC-001', status: 'verified', evidence: ['E-001'] }, { at: AT })
    eq('once every MANDATORY criterion is verified the gate opens, optional one untouched',
      domain.completionGate(done.delivery, GOAL).allowed, true)
  }
  {
    const d = build([['addBlocker', { code: 'missing-credentials', message: '需要用户提供 API Key' }], ACCEPTANCE, EVIDENCE,
      ['setAcceptanceStatus', { id: 'AC-001', status: 'verified', evidence: ['E-001'] }]])
    const gate = domain.completionGate(d, GOAL)
    eq('an open blocker blocks completion', gate.allowed, false)
    eq('and is reported as a blocker, not as work', gate.blockers.length, 1)
  }

  console.log('goal-domain: authority — the agent proposes, it does not rewrite')
  {
    const d = domain.emptyDelivery('s')
    for (const [op, payload, field] of [
      ['proposeObjective', { objective: '改成别的东西' }, 'objective'],
      ['proposeScope', { included: ['只改 dashboard'] }, 'scope'],
      ['proposeConstraints', { constraints: ['不许新增依赖'] }, 'constraints'],
    ]) {
      const result = domain.applyDeliveryOp(d, op, payload, { at: AT })
      eq(`${op} is refused with a human-confirmation code`, result.code, domain.ERROR_CODES.HUMAN_CONFIRMATION_REQUIRED)
      eq(`${op} records a proposal for field ${field}`, result.proposal.field, field)
      check(`${op} returns the changed document so the proposal is not lost`, result.delivery !== undefined)
      eq(`${op} did not change the field itself`, result.delivery[field] === undefined || result.delivery[field].included === undefined || result.delivery[field].included.length === 0, true)
    }
    // The structural claim: there is no op in the AGENT op list that applies these fields.
    for (const forbidden of ['setScope', 'setObjective', 'setConstraints', 'setAcceptance']) {
      check(`"${forbidden}" is not an agent op`, !domain.DELIVERY_OPS.includes(forbidden))
    }
    check('proposeScope IS an agent op', domain.DELIVERY_OPS.includes('proposeScope'))
    check('adoptProposal is NOT an agent op', !domain.DELIVERY_OPS.includes('adoptProposal'))
    check('adoptProposal is a human op', domain.HUMAN_OPS.includes('adoptProposal'))
  }
  {
    const d = build([ACCEPTANCE])
    const proposed = domain.applyDeliveryOp(d, 'proposeAcceptanceChange', { id: 'AC-001', description: '新的验收文本' }, { at: AT })
    eq('acceptance text change is proposed', proposed.code, domain.ERROR_CODES.HUMAN_CONFIRMATION_REQUIRED)
    eq('the proposal targets the criterion', proposed.proposal.target, 'AC-001')
    const adopted = domain.applyHumanOp(proposed.delivery, 'adoptProposal', { id: proposed.proposal.id }, { at: AT + 1 })
    eq('a human adopting it applies the change', adopted.delivery.acceptance[0].description, '新的验收文本')
    eq('and marks the proposal adopted', adopted.delivery.proposals[0].status, 'adopted')
  }
  {
    const d = domain.emptyDelivery('s')
    const proposed = domain.applyDeliveryOp(d, 'proposeScope', { included: ['a'], excluded: ['b'] }, { at: AT })
    const adopted = domain.applyHumanOp(proposed.delivery, 'adoptProposal', { id: proposed.proposal.id }, { at: AT + 1 })
    eq('adopting a scope proposal applies both halves', adopted.delivery.scope.included.join(','), 'a')
    eq('and the exclusion too', adopted.delivery.scope.excluded.join(','), 'b')
    // The proposal's `current` field is READ BY A PERSON deciding whether to accept. It used
    // to render the data structure ({...}), which made the reader parse JSON to find out what
    // was changing. Whatever the field holds, it must not be a bare JSON dump.
    check('a scope proposal describes the current scope in words, not JSON',
      !proposed.proposal.current.includes('{') && !proposed.proposal.current.includes('"'),
      proposed.proposal.current)
    eq('and says so when there is nothing to describe', proposed.proposal.current, '（未填写）')
    const withScope = domain.applyHumanOp(proposed.delivery, 'adoptProposal', { id: proposed.proposal.id }, { at: AT + 1 }).delivery
    const second = domain.applyDeliveryOp(withScope, 'proposeScope', { included: ['c'] }, { at: AT + 2 })
    check('a populated scope is described by its contents',
      second.proposal.current.includes('包含：a') && second.proposal.current.includes('不包含：b'),
      second.proposal.current)
  }
  {
    const d = domain.emptyDelivery('s')
    const proposed = domain.applyDeliveryOp(d, 'proposeConstraints', { constraints: ['不许新增依赖'] }, { at: AT })
    check('a constraints proposal also avoids a JSON dump',
      !proposed.proposal.current.includes('{') && !proposed.proposal.current.includes('"'),
      proposed.proposal.current)
  }
  {
    const d = build([ACCEPTANCE])
    const verified = domain.applyHumanOp(d, 'setAcceptance', { id: 'AC-001', status: 'verified' }, { at: AT })
    // A human verifying is itself evidence, and must be recorded as such — otherwise the
    // artifact would claim "verified" with zero evidence, the exact state the gate forbids.
    eq('a human verification records user_confirmation evidence', verified.delivery.evidence[0].kind, 'user_confirmation')
    eq('and links it to the criterion', verified.delivery.acceptance[0].evidence.join(','), 'E-001')
    eq('so the gate is satisfied', domain.completionGate(verified.delivery, GOAL).allowed, true)
  }

  console.log('goal-domain: integrity')
  {
    const d = build([ACCEPTANCE, ACCEPTANCE2, ['addTask', { title: 'A' }], ['addTask', { title: 'B', dependsOn: ['T-001'] }]])
    const cyclic = domain.applyDeliveryOp(d, 'addTask', { title: 'C', dependsOn: ['T-003'] }, { at: AT })
    const looped = domain.applyDeliveryOp(cyclic.delivery, 'setTaskStatus', { id: 'T-001', status: 'ready' }, { at: AT })
    // T-001 -> T-003 -> T-002 -> T-001 would make the plan unrunnable, but here only the
    // declared edges exist; the check that matters is the in-progress-on-pending one.
    const broken = domain.integrity(looped.delivery, GOAL)
    // This assertion used to read `… || broken.valid`, which made it PASS whenever the report
    // was clean — i.e. it could not fail for the reason it names. It was written that way
    // because the case above does not actually create an in-progress task depending on a
    // pending one (T-001 is `ready`, not `in_progress`). So the real case is built explicitly
    // here instead of being excused by a disjunction.
    const realCase = structuredClone(looped.delivery)
    realCase.tasks[0].status = 'in_progress' // T-001, which T-002 and T-003 depend on
    realCase.tasks[1].status = 'ready' // T-002 depends on T-001
    const report = domain.integrity(realCase, GOAL)
    check('an in-progress task may not depend on a pending one',
      report.errors.some((e) => e.code === domain.ERROR_CODES.INVALID_STATE && /尚未完成/.test(e.detail)),
      JSON.stringify(report.errors))
  }
  {
    // A cycle, built directly (the ops cannot create one, which is itself the point).
    const d = build([ACCEPTANCE, ['addTask', { title: 'A' }], ['addTask', { title: 'B', dependsOn: ['T-001'] }]])
    const cyclic = domain.applyDeliveryOp(d, 'addTask', { title: 'C', dependsOn: ['T-002'] }, { at: AT }).delivery
    const manual = structuredClone(cyclic)
    manual.tasks[0].dependsOn = ['T-003']
    const report = domain.integrity(manual, GOAL)
    check('a dependency cycle is an error', report.errors.some((e) => e.code === domain.ERROR_CODES.INVALID_STATE && /成环/.test(e.detail)),
      JSON.stringify(report.errors))
  }
  {
    const d = build([ACCEPTANCE])
    const stale = { ...d, goalRevision: 2 }
    const report = domain.integrity(stale, GOAL)
    check('a plan built on an older revision warns for reconciliation',
      report.warnings.some((w) => w.code === domain.ERROR_CODES.RECONCILIATION_REQUIRED && w.target === 'goal'))
    const foreign = { ...d, goalId: 'goal-other', goalRevision: 3 }
    const report2 = domain.integrity(foreign, GOAL)
    check('a plan belonging to another goal is an ERROR, not a warning',
      report2.errors.some((e) => e.code === domain.ERROR_CODES.DRIFT_DETECTED))
    eq('and the whole check fails', report2.valid, false)
  }

  console.log('goal-domain: an UNBOUND plan is not an exempt plan')
  {
    // The real defect, in its real shape. A session ran 205 changes with `goalId === null`
    // and `reconcile` never called once; the console drew that plan as the projection of the
    // live goal, and NOTHING had ever checked that it was. Both guards skipped on null.
    //
    // These assertions pin the fix: a plan with content and no binding must be reported by
    // BOTH the integrity check and the drift check. Reverting either null-guard turns them red.
    const unbound = build([ACCEPTANCE, TASK], false)
    eq('the fixture really is unbound', unbound.goalId, null)
    check('the fixture really has content', unbound.acceptance.length > 0 && unbound.changes.length > 0)

    const report = domain.integrity(unbound, GOAL)
    check('integrity reports an unbound plan as DRIFT, not silence',
      report.errors.some((e) => e.code === domain.ERROR_CODES.DRIFT_DETECTED && e.target === 'goal'),
      JSON.stringify(report.errors))
    eq('and the report is not valid', report.valid, false)

    const drift = domain.detectDrift(unbound, GOAL)
    check('detectDrift reports an unbound plan too',
      drift !== null && drift.fields.includes('goal'), JSON.stringify(drift))
    // Guarded rather than dereferenced directly: when the arm that reverts the fix runs, this
    // line used to throw on `null.before` and abort the whole suite. A crash mid-file hides
    // every assertion AFTER it, so a negative control reported "the suite went red" without
    // ever reaching the assertions it was meant to exercise. A test that dies is not a test
    // that fails.
    eq('with no "before" identity, because there was never one', drift?.before?.goal ?? null, null)
    eq('and the goal it should have been bound to', drift?.after?.goal ?? null, GOAL.id)

    // The original reason for the null guard must survive: a plan nobody has written to has
    // no opinion. Otherwise every goal would be born in drift, and the label would mean
    // nothing — which is how the real defect got to hide in the first place.
    const untouched = domain.emptyDelivery('s')
    eq('an untouched plan still has no opinion', domain.detectDrift(untouched, GOAL), null)
    eq('and is still healthy, not alarming', domain.health(untouched, GOAL), 'healthy')
    check('and integrity is quiet about it',
      domain.integrity(untouched, GOAL).errors.length === 0,
      JSON.stringify(domain.integrity(untouched, GOAL).errors))

    // No runtime goal at all: the whole check has no opinion, bound or not.
    eq('no runtime goal means no drift opinion', domain.detectDrift(unbound, null), null)
  }

  console.log('goal-domain: drift')
  {
    const d = build([ACCEPTANCE])
    eq('an unsynced plan has no opinion, so no drift', domain.detectDrift(domain.emptyDelivery('s'), GOAL), null)
    const synced = domain.applyDeliveryOp(d, 'reconcile', { goalId: GOAL.id, goalRevision: 3, objective: GOAL.objective }, { at: AT }).delivery
    eq('a synced plan does not drift', domain.detectDrift(synced, GOAL), null)
    const edited = { ...GOAL, objective: '完全换了一个目标', revision: 4 }
    const drift = domain.detectDrift(synced, edited)
    check('a rewritten objective IS drift', drift !== null && drift.fields.includes('objective'), JSON.stringify(drift))
    const revised = { ...GOAL, revision: 4 }
    const drift2 = domain.detectDrift(synced, revised)
    check('a new revision is drift', drift2 !== null && drift2.fields.includes('revision'))
  }

  console.log('goal-domain: health is a state, not a score')
  {
    const empty = domain.emptyDelivery('s')
    // A goal with nothing written down yet is NOT in trouble — it is new. If "no scope
    // recorded yet" counted as a problem, every goal would start life labelled 需要注意,
    // which is the fastest way to teach a reader that the label means nothing.
    eq('a brand-new empty plan is healthy, not alarming', domain.health(empty, GOAL), 'healthy')
    // But an empty plan cannot COMPLETE — the gate, not the health label, says so. These
    // are different questions and must not be collapsed.
    eq('and the gate still refuses to let it complete',
      domain.completionGate(empty, GOAL).allowed, false)
    const withBlocker = build([ACCEPTANCE, ['addBlocker', { code: 'no-key', message: '缺 Key' }]])
    eq('an open blocker is blocked', domain.health(withBlocker, GOAL), 'blocked')
    const verified = build([ACCEPTANCE, EVIDENCE, ['setAcceptanceStatus', { id: 'AC-001', status: 'verified', evidence: ['E-001'] }]])
    eq('everything verified is verifying', domain.health(verified, GOAL), 'verifying')
    eq('a complete goal is completed', domain.health(verified, { ...GOAL, phase: 'complete' }), 'completed')
    // A stale-revision warning only fires when the plan RECORDED a revision. A plan that
    // never synced has no opinion, and inventing one for it would label every fresh goal
    // as needing attention. So the case is built by syncing first, then editing the goal.
    const synced = domain.applyDeliveryOp(verified, 'reconcile', { goalId: GOAL.id, goalRevision: 3 }, { at: AT }).delivery
    eq('a synced plan on the current revision is verifying', domain.health(synced, GOAL), 'verifying')
    eq('the same plan against a newer revision needs attention', domain.health(synced, { ...GOAL, revision: 4 }), 'needs-attention')
    eq('a verified plan belonging to ANOTHER goal needs attention',
      domain.health({ ...synced, goalId: 'goal-other' }, GOAL), 'needs-attention')
    for (const state of Object.values({ a: 'healthy', b: 'blocked', c: 'verifying', d: 'completed', e: 'needs-attention' })) {
      check(`health "${state}" has a Chinese label`, typeof domain.HEALTH_LABELS[state] === 'string')
    }
  }

  console.log('goal-domain: normalization drops bad rows with a reason')
  {
    const raw = {
      version: 1,
      revision: 4,
      acceptance: [
        { id: 'AC-001', description: 'good' },
        { id: 'NOT-AN-ID', description: 'bad id' },
        { id: 'AC-001', description: 'duplicate' },
        { id: 'AC-002' },
      ],
      tasks: [{ id: 'T-001', title: 'ok', dependsOn: ['T-999'] }],
      evidence: [{ id: 'E-001', summary: 'ok' }],
      blockers: [{ id: 'B-001', code: 'NotKebab', message: 'x' }],
    }
    const normalized = domain.normalizeDelivery(raw, 's')
    eq('only the valid criterion survives', normalized.delivery.acceptance.length, 1)
    eq('only the valid task survives', normalized.delivery.tasks.length, 1)
    eq('a dangling dependency is dropped', normalized.delivery.tasks[0].dependsOn.length, 0)
    eq('a non-kebab blocker code is dropped', normalized.delivery.blockers.length, 0)
    check('every drop is reported', normalized.warnings.length >= 4, JSON.stringify(normalized.warnings))
  }
  {
    const future = domain.normalizeDelivery({ version: 99 }, 's')
    eq('a future version is refused wholesale', future.ok, false)
    eq('with a stable code', future.code, domain.ERROR_CODES.INVALID_STATE)
    const notObject = domain.normalizeDelivery('nope', 's')
    eq('a non-object is refused', notObject.ok, false)
  }
  {
    // An acceptance row that references missing evidence must lose the reference, or
    // "verified with evidence" could be satisfied by pointing at nothing.
    const raw = {
      version: 1,
      acceptance: [{ id: 'AC-001', description: 'x', status: 'verified', evidence: ['E-404'] }],
    }
    const normalized = domain.normalizeDelivery(raw, 's')
    eq('a dangling evidence reference is dropped', normalized.delivery.acceptance[0].evidence.length, 0)
    check('and reported', normalized.warnings.some((w) => /证据/.test(w)))
  }

  console.log('goal-domain: markdown projection is deterministic and complete')
  {
    const d = build([ACCEPTANCE, ACCEPTANCE2, TASK, EVIDENCE, ['setFocus', { focus: '完成 Dashboard API 接入' }],
      ['setNext', { next: ['接入 /api/tasks', '运行测试'] }], ['addDecision', { decision: '复用现有 Dashboard', reason: '保持 UI 一致' }],
      ['addBlocker', { code: 'need-key', message: '等待用户提供 Key' }]])
    const a = domain.renderGoalMarkdown(d, GOAL, { generatedAt: AT, artifactPath: '.agent/goal.md' })
    const b = domain.renderGoalMarkdown(d, GOAL, { generatedAt: AT, artifactPath: '.agent/goal.md' })
    eq('same state renders byte-identical output', a === b, true)
    for (const heading of ['## 1. 预期目标', '## 2. 验收标准', '## 3. 范围与边界', '## 4. 任务拆解', '## 5. 约束条件',
      '## 6. 当前状态', '## 7. 决策记录', '## 8. 风险与阻塞', '## 9. 产出物', '## 10. 验证与证据',
      '## 11. 当前焦点', '## 12. 下一步行动', '## 13. 变更记录']) {
      check(`section present: ${heading}`, a.includes(heading))
    }
    check('the objective is rendered', a.includes(GOAL.objective))
    check('the focus is rendered', a.includes('完成 Dashboard API 接入'))
    check('evidence is rendered', a.includes('pnpm test passed'))
    check('the blocker is rendered as unresolved', a.includes('等待用户提供 Key') && a.includes('未解决'),
      a.slice(a.indexOf('## 8.'), a.indexOf('## 8.') + 120))
    // A different timestamp must change the document: otherwise the "stale?" comparison
    // in the route would be comparing two renders that always agree.
    const c = domain.renderGoalMarkdown(d, GOAL, { generatedAt: AT + 60_000, artifactPath: '.agent/goal.md' })
    check('a different projection time changes the bytes', a !== c)
    // No runtime goal: the mirror is used and the unavailability is stated.
    const offline = domain.renderGoalMarkdown({ ...d, objectiveMirror: '镜子里的目标' }, null, { generatedAt: AT })
    check('without a runtime goal the mirror is rendered', offline.includes('镜子里的目标'))
    check('and the unavailability is stated', offline.includes('运行时 Goal 不可用'))
  }
  {
    // A markdown-injection hazard: a pipe in a description would break the table, and a
    // newline would break the row entirely.
    const d = build([['addAcceptance', { description: 'a | b\nc' }]])
    const md = domain.renderGoalMarkdown(d, GOAL, { generatedAt: AT })
    check('pipes are escaped in table cells', md.includes('a \\| b'))
    const rowLine = md.split('\n').find((line) => line.startsWith('| AC-001 |'))
    check('and the row stays on one line', rowLine !== undefined && !rowLine.includes('\n'))
  }

  console.log('goal-domain: reconciliation need')
  {
    const d = build([ACCEPTANCE, TASK, ['setTaskStatus', { id: 'T-001', status: 'in_progress' }]])
    const idle = domain.needsReconciliation(d, {})
    check('an in-progress task asks for reconciliation', idle.required)
    const quiet = domain.needsReconciliation(domain.emptyDelivery('s'), {})
    eq('a plan with nothing in it also asks (it has no acceptance)', quiet.required, true)
    const settled = build([ACCEPTANCE, EVIDENCE, ['setAcceptanceStatus', { id: 'AC-001', status: 'verified', evidence: ['E-001'] }],
      ['setFocus', { focus: 'x' }], ['setNext', { next: ['y'] }]])
    eq('a fully settled plan does not', domain.needsReconciliation(settled, {}).required, false)
  }

  console.log('goal-domain: summarize')
  {
    const d = build([ACCEPTANCE, ACCEPTANCE2, TASK, EVIDENCE, ['setAcceptanceStatus', { id: 'AC-001', status: 'verified', evidence: ['E-001'] }]])
    const s = domain.summarize(d, GOAL)
    eq('acceptance total', s.acceptance.total, 2)
    eq('acceptance verified', s.acceptance.verified, 1)
    eq('acceptance pending', s.acceptance.pending, 1)
    eq('tasks total', s.tasks.total, 1)
    eq('evidence total', s.evidence.total, 1)
    eq('health is a state name', typeof s.health, 'string')
  }

  console.log('goal-domain: 预期产出 is agent-written execution state, and must be ONE paragraph')
  {
    const one = '一个能双击打开的看板，loading / empty / error 三种状态都走通，并留下四张截图当证据。'
    const d = build([['setExpectedOutput', { expectedOutput: one }]])
    eq('a one-paragraph 预期产出 lands', d.expectedOutput, one)

    // 「一段话」是用户提的要求，所以**在这里**查它，而不是只在工具描述里写一句「请写成一段」：
    // 模型会写成三段，而页面上那三段的排版看起来还挺好 —— 坏得不像坏的，就没人回来改。
    const two = domain.applyDeliveryOp(domain.emptyDelivery('s'), 'setExpectedOutput',
      { expectedOutput: '第一段。\n\n第二段。' }, { at: AT })
    check('two paragraphs are REFUSED, not silently joined', typeof two.error === 'string')
    check('and the refusal talks about 一段', /一段/.test(String(two.error)))

    // 空字符串不等于「还没写」：它会让页面把「没填」读成「填了」。
    const blank = domain.applyDeliveryOp(domain.emptyDelivery('s'), 'setExpectedOutput',
      { expectedOutput: '   ' }, { at: AT })
    check('blank is refused', typeof blank.error === 'string')

    // 超长是**拒绝**，不是截断：被截断的摘要会以一个「长度正常」的样子留在页面上。
    const long = domain.applyDeliveryOp(domain.emptyDelivery('s'), 'setExpectedOutput',
      { expectedOutput: 'x'.repeat(domain.MAX_EXPECTED_OUTPUT_CHARS + 1) }, { at: AT })
    check('over-length is refused rather than truncated', typeof long.error === 'string')
    const atLimit = domain.applyDeliveryOp(domain.emptyDelivery('s'), 'setExpectedOutput',
      { expectedOutput: 'y'.repeat(domain.MAX_EXPECTED_OUTPUT_CHARS) }, { at: AT })
    eq('exactly at the limit is accepted', atLimit.delivery.expectedOutput.length, domain.MAX_EXPECTED_OUTPUT_CHARS)

    check('it is an agent-writable op', domain.DELIVERY_OPS.includes('setExpectedOutput'))

    // 投影：进 goal.md，挂在第 1 节下面 —— 它不能把后面 12 节的编号整体推一位。
    const md = domain.renderGoalMarkdown(d, GOAL, { generatedAt: AT })
    check('the markdown projection carries it', md.includes('### 预期产出') && md.includes(one))
    check('and the numbered sections keep their numbers',
      md.includes('## 2. 验收标准') && md.includes('## 13. 变更记录'))
    const unwritten = domain.renderGoalMarkdown(domain.emptyDelivery('s'), GOAL, { generatedAt: AT })
    check('an unwritten 预期产出 is stated, not faked', unwritten.includes('（还没有写预期产出）'))

    // 往返：归一化之后它还在，而不是被当成未知字段丢掉。
    const round = domain.normalizeDelivery(JSON.parse(JSON.stringify(d)), 's')
    eq('it survives a store round-trip', round.delivery.expectedOutput, one)
  }

  console.log('goal-domain: unknown ops are refused, never silently ignored')
  {
    const d = domain.emptyDelivery('s')
    const bad = domain.applyDeliveryOp(d, 'definitelyNotAnOp', {}, { at: AT })
    eq('unknown agent op errors', bad.code, domain.ERROR_CODES.INVALID_STATE)
    const badHuman = domain.applyHumanOp(d, 'nope', {}, { at: AT })
    eq('unknown human op errors', badHuman.code, domain.ERROR_CODES.INVALID_STATE)
  }
  {
    // The input must not be mutated: the route reads a document, applies an op and writes
    // the RESULT, so an in-place change would make the compare-and-set meaningless.
    const d = build([ACCEPTANCE])
    const before = JSON.stringify(d)
    domain.applyDeliveryOp(d, 'addTask', { title: 'x' }, { at: AT })
    eq('applyDeliveryOp does not mutate its input', JSON.stringify(d), before)
    domain.applyHumanOp(d, 'removeAcceptance', { id: 'AC-001' }, { at: AT })
    eq('applyHumanOp does not mutate its input', JSON.stringify(d), before)
  }
} finally {
  // nothing to clean up: this suite is pure
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (goal-domain)`)
