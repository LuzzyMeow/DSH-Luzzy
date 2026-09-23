// Drive the state-chain ops and the skill activation list through the REAL domain, then render
// the artifact — end to end.
//
// These four are what the user asked for in one message: 「判断是否执行技能清单」 must be a
// recorded judgement, and the activation view must be filled by the Agent with name, description,
// purpose and source. A case statement existing is not the feature: it has to be reachable, it has
// to mutate, it has to leave a change-log row, and it has to reach goal.md.
//
// Usage: node tools/probe-chain-ops.mjs

import {
  applyDeliveryOp,
  DELIVERY_OPS,
  emptyDelivery,
  normalizeDelivery,
  renderGoalMarkdown,
} from '../lib/goal-domain.mjs'

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
const ctx = { at, actor: 'agent' }

console.log('=== 1. the four ops are reachable from the agent surface ===')
for (const op of ['judgeChain', 'activateSkill', 'setSkill', 'removeSkill']) {
  check(`${op} is in DELIVERY_OPS`, DELIVERY_OPS.includes(op))
  const probe = applyDeliveryOp(emptyDelivery('s-chain'), op, {}, ctx)
  // An empty payload may be refused for a MISSING FIELD — the point is that it is not refused
  // for an authority reason. Those are different failures and only the second is a bug.
  check(`${op} is NOT refused for authority`, probe.error === undefined || !/人类|human|authority/i.test(probe.error), probe.error)
}

console.log('')
console.log('=== 2. judgeChain: both answers mandatory, unknown values refused ===')
{
  let d = emptyDelivery('s-chain')
  check('a fresh delivery has NOT judged yet', d.chain.goalMatch === null && d.chain.skillCheck === null)

  // Half an answer is not an answer: the chain has two branches and both are the point.
  const half = applyDeliveryOp(d, 'judgeChain', { goalMatch: 'matched' }, ctx)
  check('half an answer is refused', half.error !== undefined, JSON.stringify(half.delivery?.chain))
  const bogus = applyDeliveryOp(d, 'judgeChain', { goalMatch: 'maybe', skillCheck: 'hit' }, ctx)
  check('an unknown value is refused (not coerced to a default)', bogus.error !== undefined, JSON.stringify(bogus.delivery?.chain))

  const r = applyDeliveryOp(d, 'judgeChain', { goalMatch: 'matched', skillCheck: 'none' }, ctx)
  d = r.delivery
  check('a full answer lands', d.chain.goalMatch === 'matched' && d.chain.skillCheck === 'none', JSON.stringify(d.chain))
  check('and is stamped', d.chain.at === at, String(d.chain.at))
  check('the change log records it', d.changes.some((c) => /judge-chain/.test(c.action) && /goalMatch=matched/.test(c.detail || '')), JSON.stringify(d.changes.map((c) => [c.action, c.detail])))

  // The other branch must be equally expressible — that is the whole design: "none" is an
  // answer, not a skip.
  const none = applyDeliveryOp(d, 'judgeChain', { goalMatch: 'none', skillCheck: 'none' }, ctx).delivery
  check('the second branch is recorded just as plainly', none.chain.goalMatch === 'none', JSON.stringify(none.chain))
}

console.log('')
console.log('=== 3. activateSkill: four fields, all of them required ===')
{
  let d = emptyDelivery('s-skills')
  const full = { name: 'luzzy-roster-design', description: '设计基线五条', purpose: '本次要判断视觉层级', source: 'https://github.com/LuzzyMeow/LuzzyPrompt/tree/main/skills/luzzy-roster-design' }

  for (const field of ['name', 'description', 'purpose', 'source']) {
    const payload = { ...full }
    delete payload[field]
    const r = applyDeliveryOp(d, 'activateSkill', payload, ctx)
    check(`missing ${field} is refused`, r.error !== undefined && r.error.includes(field), r.error)
  }

  const r = applyDeliveryOp(d, 'activateSkill', full, ctx)
  d = r.delivery
  check('a complete entry lands', d.skills.length === 1 && d.skills[0].name === full.name, JSON.stringify(d.skills[0]))
  check('it gets an S-nnn id', /^S-\d{3,}$/.test(d.skills[0].id), d.skills[0].id)
  check('the change log says what it is FOR', d.changes.some((c) => /activate S-/.test(c.action) && /本次要判断视觉层级/.test(c.detail || '')), JSON.stringify(d.changes.map((c) => [c.action, c.detail])))

  const dupe = applyDeliveryOp(d, 'activateSkill', full, ctx)
  check('the same skill cannot be registered twice', dupe.error !== undefined && /已经登记/.test(dupe.error), dupe.error)
}

console.log('')
console.log('=== 4. setSkill edits in place; removeSkill takes it back ===')
{
  let d = emptyDelivery('s-skills2')
  d = applyDeliveryOp(d, 'activateSkill', { name: 'a-skill', description: 'd', purpose: 'p', source: 's' }, ctx).delivery
  const id = d.skills[0].id

  const r = applyDeliveryOp(d, 'setSkill', { id, purpose: '改过的作用' }, ctx)
  d = r.delivery
  check('setSkill edits the purpose', d.skills[0].purpose === '改过的作用', d.skills[0].purpose)
  check('omitted fields are UNCHANGED', d.skills[0].description === 'd' && d.skills[0].source === 's', JSON.stringify(d.skills[0]))
  check('the id is stable (an edit is not a new entry)', d.skills.length === 1 && d.skills[0].id === id)

  const empty = applyDeliveryOp(d, 'setSkill', { id }, ctx)
  check('setSkill with nothing to change is refused', empty.error !== undefined, empty.error)

  const gone = applyDeliveryOp(d, 'removeSkill', { id }, ctx)
  d = gone.delivery
  check('removeSkill empties the list', d.skills.length === 0, JSON.stringify(d.skills))
  check('and reports what left', gone.removed === id, String(gone.removed))
  check('a stale id is a NOT_FOUND, not a silent no-op', applyDeliveryOp(d, 'removeSkill', { id }, ctx).error !== undefined)
}

console.log('')
console.log('=== 5. an incomplete entry never survives a reload ===')
{
  // The four fields are the reason the entry exists. If one goes missing on disk, rendering a
  // half entry would put a claim on the page the Agent never made — so the row is dropped.
  const raw = emptyDelivery('s-normalize')
  raw.skills.push({ id: 'S-001', name: 'ok', description: 'd', purpose: 'p', source: 's', at })
  raw.skills.push({ id: 'S-002', name: 'no-source', description: 'd', purpose: 'p', at })
  raw.chain = { goalMatch: 'matched', skillCheck: 'hit', at }
  const normalized = normalizeDelivery(raw, 's-normalize')
  check('normalize succeeds', normalized.ok === true, normalized.code)
  check('the complete entry survives', normalized.delivery.skills.length === 1 && normalized.delivery.skills[0].id === 'S-001', JSON.stringify(normalized.delivery.skills.map((s) => s.id)))
  check('the chain survives too', normalized.delivery.chain.goalMatch === 'matched' && normalized.delivery.chain.skillCheck === 'hit', JSON.stringify(normalized.delivery.chain))

  const broken = normalizeDelivery({ ...emptyDelivery('s-n'), chain: { goalMatch: 'maybe', skillCheck: 7 } }, 's-n')
  check('a garbled chain reads as "not judged", not as some value', broken.delivery.chain.goalMatch === null && broken.delivery.chain.skillCheck === null, JSON.stringify(broken.delivery.chain))
}

console.log('')
console.log('=== 6. the view and the artifact get the same facts ===')
{
  let d = emptyDelivery('s-art')
  d = applyDeliveryOp(d, 'judgeChain', { goalMatch: 'matched', skillCheck: 'hit' }, ctx).delivery
  d = applyDeliveryOp(d, 'activateSkill', { name: 'luzzy-roster-html', description: 'HTML 七条取四', purpose: '本次要写单文件页面', source: 'https://github.com/LuzzyMeow/LuzzyPrompt/tree/main/skills/luzzy-roster-html' }, ctx).delivery
  const md = renderGoalMarkdown(d, { id: 'g', revision: 1, objective: '目标', phase: 'active', maxGoalRounds: 256 }, { generatedAt: at, artifactPath: '.agent/goal.md' })
  check('goal.md carries the chain branch', md.includes('目标分支：命中'), '（判断没进产物）')
  check('goal.md carries the skill list', md.includes('## 附：状态链与激活技能') && md.includes('luzzy-roster-html'))
  check('with all four fields readable', md.includes('HTML 七条取四') && md.includes('本次要写单文件页面') && md.includes('skills/luzzy-roster-html'))
}

console.log('')
if (failures > 0) {
  console.log(`FAIL — ${failures} assertion(s)`)
  process.exit(1)
}
console.log('PASS — the state chain and the activation list work end to end')
