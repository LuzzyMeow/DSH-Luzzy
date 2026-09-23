// Drive the four NEW ops through the REAL domain, then render the artifact — end to end.
//
// The ops are only real if they (a) are reachable from the agent's op list, (b) actually mutate,
// (c) record a change, and (d) come out in goal.md. This checks all four rather than assuming
// "the case statement exists" means "the feature works".
//
// Usage: node tools/probe-edit-ops.mjs

import { applyDeliveryOp, DELIVERY_OPS, emptyDelivery, renderGoalMarkdown } from '../lib/goal-domain.mjs'

let failures = 0
function check(label, ok, detail = '') {
  if (!ok) {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  } else {
    console.log(`  ok   ${label}`)
  }
}

const at = 1_700_000_000_000
const ctx = { at: at, changeId: 'C-1' }

console.log('=== 1. the four ops are reachable from the agent surface ===')
for (const op of ['setTask', 'removeTask', 'setEvidence', 'removeEvidence']) {
  check(`${op} is in DELIVERY_OPS`, DELIVERY_OPS.includes(op))
  // And the actor guard must let an AGENT through — these are agent-authority fields (§65).
  const base = emptyDelivery('sess-edit')
  base.tasks.push({ id: 'T-001', title: '旧标题', status: 'pending', acceptance: [], dependsOn: [], artifacts: [] })
  const probe = applyDeliveryOp(base, op, { id: 'T-001' }, { ...ctx, actor: 'agent' })
  check(`${op} is NOT refused for actor=agent`, probe.error === undefined || !/人类|human/i.test(probe.error || ''), probe.error)
}

console.log('')
console.log('=== 2. setTask actually edits, and leaves untouched fields alone ===')
{
  let d = emptyDelivery('sess-edit')
  d.tasks.push({ id: 'T-001', title: '旧标题', status: 'pending', acceptance: ['AC-1'], dependsOn: [], artifacts: ['a.md'] })
  d.acceptance.push({ id: 'AC-1', description: 'x', mandatory: true, status: 'pending', evidence: [] })
  d.acceptance.push({ id: 'AC-2', description: 'y', mandatory: false, status: 'pending', evidence: [] })
  const before = d.revision

  const r1 = applyDeliveryOp(d, 'setTask', { id: 'T-001', title: '新标题' }, ctx)
  check('setTask returns a delivery', r1.delivery !== undefined, r1.error)
  d = r1.delivery
  check('the title changed', d.tasks[0].title === '新标题', d.tasks[0].title)
  check('omitted acceptance is UNCHANGED', JSON.stringify(d.tasks[0].acceptance) === '["AC-1"]', JSON.stringify(d.tasks[0].acceptance))
  check('omitted artifacts are UNCHANGED', JSON.stringify(d.tasks[0].artifacts) === '["a.md"]', JSON.stringify(d.tasks[0].artifacts))
  check('revision moved', d.revision === before + 1, `${before} -> ${d.revision}`)
  check('a change was recorded', d.changes.some((c) => /edit T-001/.test(c.action)), JSON.stringify(d.changes.map((c) => c.action)))

  // Replacement semantics: give acceptance explicitly and it REPLACES (that is the point).
  d = applyDeliveryOp(d, 'setTask', { id: 'T-001', acceptance: ['AC-2'] }, ctx).delivery
  check('given acceptance REPLACES the list', JSON.stringify(d.tasks[0].acceptance) === '["AC-2"]', JSON.stringify(d.tasks[0].acceptance))

  // Self-dependency would make a one-node cycle; it must be filtered.
  d = applyDeliveryOp(d, 'setTask', { id: 'T-001', dependsOn: ['T-001'] }, ctx).delivery
  check('a task cannot depend on itself', d.tasks[0].dependsOn.length === 0, JSON.stringify(d.tasks[0].dependsOn))
}

console.log('')
console.log('=== 3. removeTask detaches dependents instead of orphaning them ===')
{
  let d = emptyDelivery('sess-rm')
  d.tasks.push({ id: 'T-001', title: '被依赖的', status: 'pending', acceptance: [], dependsOn: [], artifacts: [] })
  d.tasks.push({ id: 'T-002', title: '依赖者', status: 'pending', acceptance: [], dependsOn: ['T-001'], artifacts: [] })
  const r = applyDeliveryOp(d, 'removeTask', { id: 'T-001' }, ctx)
  d = r.delivery
  check('removeTask returns a delivery', d !== undefined, r.error)
  check('the task is gone', !d.tasks.some((t) => t.id === 'T-001'))
  check('the dependent survives', d.tasks.some((t) => t.id === 'T-002'))
  check('and is detached from the removed id', d.tasks[0].dependsOn.length === 0, JSON.stringify(d.tasks[0].dependsOn))
  check('the removal is reported', (r.detached || []).includes('T-002'), JSON.stringify(r.detached))
  // The old title must survive in the log — otherwise history just says "one fewer task".
  // NOTE: `recordChange(delivery, at, actor, action, detail, id)` — the payload field is
  // `detail`, not `summary`. The first version of this probe asserted on `.summary`, which
  // never exists, so it reported a defect that was actually in the assertion.
  check('the change log keeps the OLD title', d.changes.some((c) => /remove T-001/.test(c.action) && /被依赖的/.test(c.detail || '')), JSON.stringify(d.changes.map((c) => [c.action, c.detail])))
}

console.log('')
console.log('=== 4. setEvidence / removeEvidence, and NO dangling reference ===')
{
  let d = emptyDelivery('sess-ev')
  d.acceptance.push({ id: 'AC-1', description: 'x', mandatory: true, status: 'pending', evidence: [] })
  d = applyDeliveryOp(d, 'addEvidence', { summary: '旧说明', kind: 'test', acceptance: ['AC-1'] }, ctx).delivery
  const evId = d.evidence[0].id
  check('evidence linked to the criterion', d.acceptance[0].evidence.includes(evId), JSON.stringify(d.acceptance[0].evidence))

  d = applyDeliveryOp(d, 'setEvidence', { id: evId, summary: '新说明' }, ctx).delivery
  check('setEvidence edits in place (same id)', d.evidence[0].id === evId && d.evidence[0].summary === '新说明', JSON.stringify(d.evidence[0]))
  check('kind is preserved when omitted', d.evidence[0].kind === 'test', d.evidence[0].kind)

  const bad = applyDeliveryOp(d, 'setEvidence', { id: evId, kind: '不存在' }, ctx)
  check('an invalid kind is refused, not silently defaulted', bad.error !== undefined, JSON.stringify(bad.delivery?.evidence?.[0]?.kind))

  const removed = applyDeliveryOp(d, 'removeEvidence', { id: evId }, ctx)
  d = removed.delivery
  check('the evidence row is gone', !d.evidence.some((e) => e.id === evId))
  // THE point of the detach: no criterion may still point at a deleted E-nnn.
  const dangling = d.acceptance.flatMap((c) => c.evidence).filter((id) => !d.evidence.some((e) => e.id === id))
  check('no dangling reference is left behind', dangling.length === 0, JSON.stringify(danglingsOr(dangling)))
  check('and the detach is reported', (removed.detached || []).includes('AC-1'), JSON.stringify(removed.detached))
}

function danglingsOr(x) { return x }

console.log('')
console.log('=== 5. the changes reach goal.md ===')
{
  let d = emptyDelivery('sess-art')
  d.tasks.push({ id: 'T-001', title: '旧标题', status: 'pending', acceptance: [], dependsOn: [], artifacts: [] })
  d = applyDeliveryOp(d, 'setTask', { id: 'T-001', title: '改过的标题' }, ctx).delivery
  const md = renderGoalMarkdown(d, { id: 'g', revision: 1, objective: '目标', phase: 'active', maxGoalRounds: 256 }, { generatedAt: at, artifactPath: '.agent/goal.md' })
  check('goal.md shows the NEW title in the task list', md.includes('改过的标题'), '（改完没进产物，产物就与状态漂了）')
  check('goal.md change log records the edit', /edit T-001/.test(md))
  check('and it does NOT still claim the old title as current', !/^\s*-\s*\[ \]\s*旧标题/m.test(md))
}

console.log('')
if (failures > 0) {
  console.log(`FAIL — ${failures} assertion(s)`)
  process.exit(1)
}
console.log('PASS — the four edit ops work end to end')
