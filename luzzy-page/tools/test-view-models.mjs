// The view-model boundary: pages must render from a view model, never from raw backend fields.
//
// WHY THIS SUITE EXISTS
//
// The v2 refactor's central claim is that `services/` owns all knowledge of what the backend
// looks like, and `pages/` only renders a view model. That claim is what makes the pages
// testable with a hand-written object instead of a faked host response — and it is exactly the
// kind of claim that decays silently, because a page reading `delivery.acceptance[0].mandatory`
// directly still renders fine. Nothing breaks; the boundary just stops existing.
//
// So this asserts the boundary structurally:
//   1. services/ actually produce the view models (called, not just defined)
//   2. pages/ never reach into backend field names
//   3. the pure derivations (task tree, counts, progress) behave — including the edge cases
//      that make them worth having (a dependency cycle must not DELETE a task)
//
// The lifted functions come from the shipped bundle, not a copy. A copy would keep passing
// after the real one changed.
//
// Usage: node tools/test-view-models.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFrameBuilder, PLUGIN_ROOT } from './frame-source.mjs'

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- lift the real code

const { srcDoc } = loadFrameBuilder()
const script = srcDoc.match(/<script>\s*\n'use strict'([\s\S]*?)<\/script>/)[1]

/**
 * Evaluate the frame's module set and return its namespace.
 *
 * A real run of the shipped modules, not a reimplementation: every module gets compiled and
 * called exactly as the browser does. The DOM is stubbed only as far as module-EVALUATION
 * needs — the modules register listeners and read containers at load time, but no page
 * renderer runs here, so the stubs never have to be convincing.
 *
 * The frame script ends with `LZ.App.start()`, which drives the whole app; the slice cuts
 * before it so only the definitions are evaluated.
 */
function loadNamespaces() {
  const noop = () => {}
  const element = () => ({
    innerHTML: '', textContent: '', hidden: true, dataset: {}, style: {},
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    addEventListener: noop, removeEventListener: noop, appendChild: noop, remove: noop,
    querySelector: () => null, querySelectorAll: () => [], focus: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  })
  const stubDocument = {
    getElementById: () => element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: { getAttribute: () => null, setAttribute: noop, classList: { contains: () => false } },
    head: { appendChild: noop },
    body: { focus: noop, appendChild: noop },
    hidden: false,
  }
  const stubWindow = {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    location: { href: 'about:srcdoc' },
  }

  const definitions = script.slice(0, script.indexOf('LZ.App.start()'))
  // `fetch` is stubbed because the modules reference it at call time only; nothing here calls
  // the network, but the identifier must exist for the compiled bodies to be sound.
  const run = new Function(
    'window',
    'document',
    'fetch',
    'setTimeout',
    'setInterval',
    'clearInterval',
    'clearTimeout',
    'AbortController',
    `${definitions}
return window.LZ`,
  )
  return run(stubWindow, stubDocument, () => Promise.reject(new Error('no network in this suite')), noop, noop, noop, noop, class { abort() {} })
}

let LZ = null
let loadError = null
try {
  LZ = loadNamespaces()
} catch (error) {
  loadError = error
}
check('the frame modules evaluate standalone', LZ !== null, loadError === null ? '' : String(loadError && loadError.message))
if (LZ === null) {
  console.log(notes.join('\n'))
  console.log(failures.join('\n'))
  process.exit(1)
}

for (const name of ['GoalService', 'RuntimeService', 'AgentService']) {
  check(`LZ.${name} is present`, LZ[name] !== undefined)
}

// ---------------------------------------------------------------- the boundary

// WHAT THE BOUNDARY ACTUALLY IS
//
// My first version of this check listed `delivery.acceptance`, `goal.roundsStarted` and friends
// as "backend fields" and failed both pages — for reading `view.delivery.acceptance`. That is
// wrong: the VIEW MODEL exposes `delivery` and `goal` deliberately, and reading them is exactly
// what the pages are supposed to do. An assertion that cannot tell the raw shape from the
// transformed one reports correct code as broken, and the fix a reader would apply is to make
// the pages worse.
//
// The real boundary is narrower and checkable: a page must never touch the RAW payload or the
// shell's mutable state. Those names appear only on the wire, never on a view model.
const RAW_ONLY = [
  'snapshot.',        // the POST response wrapper
  'payload.',         // the parsed response body
  'readError',        // raw error shape, mapped to {ok:false, reason, detail} by the service
  'LZ.App.state',     // the shell's mutable state — pages get a projection, not the state
  'goalPayload',      // the pre-transform object the shell holds
]
const PAGE_FILES = ['overview', 'goal', 'runtime', 'agent', 'system', 'readme']
for (const page of PAGE_FILES) {
  const text = readFileSync(join(PLUGIN_ROOT, 'src', 'pages', `${page}.js`), 'utf8')
  // Strip comments: the pages' own headers explain the boundary and quote the old field names.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const crossed = RAW_ONLY.filter((field) => code.includes(field))
  check(`pages/${page}.js never touches the raw payload or shell state`, crossed.length === 0, crossed.join(', '))
}

// Every page must be a function of its projection: it receives state and returns markup.
for (const page of PAGE_FILES) {
  const text = readFileSync(join(PLUGIN_ROOT, 'src', 'pages', `${page}.js`), 'utf8')
  check(
    `pages/${page}.js exposes a render(state) entry point`,
    /render:\s*(render|function)|function render\(/.test(text),
  )
}

// The shell is what builds the projections — so the mapping lives THERE, once, not in a page.
const shell = readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'app.js'), 'utf8')
check('the shell projects state for each page', shell.includes('function buildPageState('))
for (const call of ['LZ.GoalService.toView(', 'LZ.RuntimeService.toView(', 'LZ.AgentService.toView(']) {
  check(`the shell calls ${call}`, shell.includes(call))
}

// ---- every field a page renders must have an ASSIGNMENT somewhere
//
// `系统信息` showed 插件版本：未知 for a whole round because `state.version` was read by the
// projection and never written by anything. The route was delivering it on every response and
// the shell dropped it on the floor — a value that exists on the wire, is displayed, and is
// never stored is a silent hole no structural assertion catches, because both halves are
// individually correct.
{
  const readFields = [...shell.matchAll(/state\.([a-zA-Z]+)/g)].map((m) => m[1])
  const writtenFields = new Set([...shell.matchAll(/state\.([a-zA-Z]+)\s*=[^=]/g)].map((m) => m[1]))
  const declaredFields = new Set([
    ...shell.matchAll(/^\s{4}([a-zA-Z]+):/gm),
  ].map((m) => m[1]))
  const neverWritten = [...new Set(readFields)]
    .filter((name) => !writtenFields.has(name) && !declaredFields.has(name))
  check(
    'every state field a projection reads is also assigned',
    neverWritten.length === 0,
    neverWritten.length === 0 ? '' : `read but never written: ${neverWritten.join(', ')} — the page would show a placeholder forever`,
  )
}

// The services ARE where those names belong.
const goalService = readFileSync(join(PLUGIN_ROOT, 'src', 'services', 'goal-service.js'), 'utf8')
check('the goal service reads the backend shape', goalService.includes('delivery.acceptance') && goalService.includes('delivery.tasks'))
check('the service is what builds the view model', goalService.includes('function toView(payload'))

// ---------------------------------------------------------------- readiness
//
// 「还缺什么」is a display of the Authority Matrix's outcome, not a second authority. The one
// thing it MUST agree with is the gate: a pending proposal counts as answered (that is why the
// gate opens on `proposeScope` alone), so readiness must call that "ready" too. If these two
// ever disagree the page says "you can start" while the harness refuses every tool.
{
  // Compile the pure function out of the frame bundle, the same way the pages are loaded.
  const readiness = (() => {
    const start = goalService.indexOf('function readiness(view)')
    const open = goalService.indexOf('{', start)
    let depth = 0
    for (let i = open; i < goalService.length; i += 1) {
      if (goalService[i] === '{') depth += 1
      else if (goalService[i] === '}') {
        depth -= 1
        if (depth === 0) {
          // eslint-disable-next-line no-new-func
          return new Function(`${goalService.slice(start, i + 1)}; return readiness;`)()
        }
      }
    }
    return null
  })()
  check('extracted readiness', typeof readiness === 'function', 'extraction failed — the assertions below would be vacuous')

  if (typeof readiness === 'function') {
    const empty = { acceptance: [], scope: { included: [], excluded: [] }, constraints: [], proposals: [] }
    const r0 = readiness(empty)
    check('nothing filled → all three missing', r0.missing.length === 3, JSON.stringify(r0.missing))
    check('and it is not ready', r0.ready === false)

    const withAcceptance = readiness({ ...empty, acceptance: [{ id: 'AC-1' }] })
    check('one acceptance is enough for that field', !withAcceptance.missing.includes('验收标准'), JSON.stringify(withAcceptance.missing))
    check('but the other two still block', withAcceptance.missing.length === 2)

    // THE DECISIVE CASE: a pending proposal on scope must count as answered.
    const proposed = readiness({
      ...empty,
      proposals: [{ id: 'P-1', field: 'scope', status: 'pending', proposed: '1 项包含 / 0 项排除', pending: true }],
    })
    check('a pending scope proposal is NOT counted as missing', !proposed.missing.includes('范围边界'), JSON.stringify(proposed.missing))
    check('and it is reported as "waiting for you"', proposed.fields.find((f) => f.name === '范围边界').state === 'proposed',
      JSON.stringify(proposed.fields.find((f) => f.name === '范围边界')))
    check('and it still counts toward readiness (the gate opens on it)', proposed.missing.length === 2, JSON.stringify(proposed.missing))

    // An ADOPTED proposal is settled, not pending — it must not read as "still waiting".
    const adopted = readiness({
      ...empty,
      proposals: [{ id: 'P-1', field: 'scope', status: 'adopted', proposed: 'x', pending: false }],
    })
    check('an adopted proposal is no longer pending', adopted.fields.find((f) => f.name === '范围边界').state === 'missing',
      JSON.stringify(adopted.fields.find((f) => f.name === '范围边界')))

    // Everything settled → ready, and no field left unsaid.
    const full = readiness({
      acceptance: [{ id: 'AC-1' }],
      scope: { included: ['a'], excluded: [] },
      constraints: ['无'],
      proposals: [],
    })
    check('everything filled → ready', full.ready === true, JSON.stringify(full.missing))
    check('and every field is settled', full.fields.every((f) => f.state === 'settled'))

    // 负向控制：把「待批算答过」这条去掉，上面那条断言必须失效。
    const strict = (view) => {
      const missing = []
      if (view.acceptance.length === 0) missing.push('验收标准')
      if (view.scope.included.length + view.scope.excluded.length === 0) missing.push('范围边界')
      if (view.constraints.length === 0) missing.push('已知约束')
      return { missing, ready: missing.length === 0 }
    }
    const strictResult = strict({ ...empty, proposals: [{ id: 'P-1', field: 'scope', status: 'pending', pending: true }] })
    check('the naive version (ignoring proposals) reports 3 missing, so the assertion above can fail',
      strictResult.missing.length === 3 && proposed.missing.length === 2,
      `naive=${strictResult.missing.length} real=${proposed.missing.length}`)
  }
}

// ---------------------------------------------------------------- task tree

const { taskTree } = LZ.GoalService

{
  const tasks = [
    { id: 'T-001', title: 'A', status: 'completed', dependsOn: [], acceptance: [], artifacts: [], done: true },
    { id: 'T-002', title: 'B', status: 'pending', dependsOn: ['T-001'], acceptance: [], artifacts: [], done: false },
    { id: 'T-003', title: 'C', status: 'pending', dependsOn: ['T-002'], acceptance: [], artifacts: [], done: false },
  ]
  const tree = taskTree(tasks)
  check('a dependency chain nests', tree.length === 1 && tree[0].id === 'T-001')
  check('the chain is two deep', tree[0].children.length === 1 && tree[0].children[0].children.length === 1)
}

{
  // THE PROPERTY THAT MATTERS: a cycle must not delete a node. A tree that drops tasks is
  // worse than one that is merely flat — the user cannot see the work exists at all.
  const cyclic = [
    { id: 'T-001', title: 'A', status: 'pending', dependsOn: ['T-002'], acceptance: [], artifacts: [], done: false },
    { id: 'T-002', title: 'B', status: 'pending', dependsOn: ['T-001'], acceptance: [], artifacts: [], done: false },
  ]
  const tree = taskTree(cyclic)
  const seen = []
  const walk = (nodes) => nodes.forEach((node) => { seen.push(node.id); walk(node.children || []) })
  walk(tree)
  check('a dependency cycle does not delete a task', seen.length === 2, seen.join(', '))
}

{
  // A dependency on a task that is not in the plan (dropped during normalisation) must not
  // make its dependent vanish.
  const orphan = [
    { id: 'T-001', title: 'A', status: 'pending', dependsOn: ['T-999'], acceptance: [], artifacts: [], done: false },
  ]
  const tree = taskTree(orphan)
  check('a dangling dependency still renders its task', tree.length === 1 && tree[0].id === 'T-001')
}

check('an empty plan yields an empty tree', taskTree([]).length === 0)

// ---------------------------------------------------------------- counts

{
  const view = {
    acceptance: [
      { id: 'AC-001', status: 'verified', mandatory: true, done: true },
      { id: 'AC-002', status: 'pending', mandatory: true, done: false },
      { id: 'AC-003', status: 'pending', mandatory: false, done: false },
    ],
    tasks: [
      { id: 'T-001', status: 'completed', done: true },
      { id: 'T-002', status: 'in_progress', done: false },
    ],
    evidence: [{ id: 'E-001' }],
    decisions: [],
    blockers: [{ id: 'B-001', open: true }, { id: 'B-002', open: false }],
    proposals: [{ id: 'P-001', pending: true }],
    changes: [],
  }
  const counts = LZ.GoalService.counts(view)
  check('acceptance counts split mandatory from total', counts.acceptance.total === 3 && counts.acceptance.mandatory === 2 && counts.acceptance.done === 1)
  check('mandatory progress is counted separately', counts.acceptance.mandatoryDone === 1)
  check('tasks count completed', counts.tasks.total === 2 && counts.tasks.done === 1)
  check('blockers count only the open ones', counts.blockers.total === 2 && counts.blockers.open === 1)
  check('pending proposals are counted', counts.proposals.pending === 1)
}

// ---------------------------------------------------------------- progress: the five questions

{
  const base = {
    ok: true,
    goal: { phase: 'active' },
    delivery: {
      focus: '把目标中心的六节做完',
      next: ['补测试', '跑回归'],
      scope: { included: ['前端'], excluded: ['后端'] },
      constraints: ['不改 DSH Core'],
      acceptance: [],
      tasks: [],
      evidence: [],
      decisions: [{ id: 'D-001', decision: '用视图模型隔离', reason: '可替换测试' }],
      blockers: [],
      proposals: [],
      changes: [],
    },
    counts: {
      acceptance: { total: 2, done: 1, mandatory: 2, mandatoryDone: 1 },
      tasks: { total: 1, done: 0, active: 0 },
      evidence: { total: 0 },
      decisions: { total: 1 },
      blockers: { total: 0, open: 0 },
      changes: { total: 0 },
      proposals: { pending: 0 },
    },
  }

  const progress = LZ.GoalService.progressOf(base)
  check('it names what is being worked on', progress.current === '把目标中心的六节做完')
  check('it names the next action', progress.next === '补测试；跑回归')
  check('it answers "why this way" from scope and decisions', progress.why.includes('范围：前端') && progress.why.includes('最近决策：用视图模型隔离'))
  check('it refuses to call it done while a mandatory criterion is open', progress.done === false)
  check('and it says WHY it is not done', progress.doneReason.includes('还差 1 条必须的验收标准'))

  // All mandatory verified and nothing blocking → completable.
  const completable = JSON.parse(JSON.stringify(base))
  completable.counts.acceptance.mandatoryDone = 2
  completable.counts.acceptance.done = 2
  const done = LZ.GoalService.progressOf(completable)
  check('it can declare the plan complete', done.done === true)
  check('and explains the judgement', done.doneReason.includes('全部已验证'))

  // An open blocker blocks completion even when everything else is verified.
  const blocked = JSON.parse(JSON.stringify(completable))
  blocked.counts.blockers = { total: 1, open: 1 }
  check('an open blocker prevents completion', LZ.GoalService.progressOf(blocked).done === false)

  // No mandatory criteria at all → cannot be judged, and it must SAY so rather than guess.
  const nothing = JSON.parse(JSON.stringify(base))
  nothing.counts.acceptance = { total: 0, done: 0, mandatory: 0, mandatoryDone: 0 }
  const empty = LZ.GoalService.progressOf(nothing)
  check('with no mandatory criteria it says completion is undecidable', empty.done === false && empty.doneReason.includes('无从判定'))
}

// ---------------------------------------------------------------- three "no goal" states

{
  // The three states must not collapse: they call for different user actions.
  const readError = LZ.GoalService.toView({ sessionId: 'session-a', readError: { code: 'X', reason: '坏文件' } })
  check('an unreadable plan is not reported as "no goal"', readError.ok === false && readError.reason.includes('读不出来'))

  const unavailable = LZ.GoalService.toView({ sessionId: 'session-a', goal: null, goalState: 'unavailable', delivery: null, artifact: {}, artifactPath: '', integrity: null, drift: null })
  check('an unavailable runtime goal keeps its own state', unavailable.ok === true && unavailable.goalState === 'unavailable')

  const empty = LZ.GoalService.toView({ sessionId: 'session-a', goal: null, goalState: 'empty', delivery: null, artifact: {}, artifactPath: '', integrity: null, drift: null })
  check('an empty session keeps its own state', empty.ok === true && empty.goalState === 'empty')
}

// ---------------------------------------------------------------- runtime view model

{
  const tools = [
    { name: 'read', count: 5 },
    { name: 'write', count: 3 },
    { name: 'pwsh', count: 2 },
    { name: 'totally_unknown_tool', count: 1 },
  ]
  const groups = LZ.RuntimeService.toolGroups(tools)
  check('tool grouping sums to the input total', groups.total === 11, String(groups.total))
  check('reads and writes are separate categories', groups.groups.some((g) => g.key === 'read') && groups.groups.some((g) => g.key === 'write'))
  check('an unknown tool is kept, not dropped', groups.groups.some((g) => g.key === 'other' && g.names.includes('totally_unknown_tool')))

  check('elapsed formats as seconds', LZ.RuntimeService.duration(45_000) === '45 秒')
  check('elapsed formats as minutes', LZ.RuntimeService.duration(90_000).includes('分'))
  check('elapsed formats as hours', LZ.RuntimeService.duration(3_700_000).includes('小时'))
  check('no elapsed reads as a dash, not zero', LZ.RuntimeService.duration(0) === '—')

  // A route failure must produce a named reason, not an empty state.
  const failed = LZ.RuntimeService.toView({ ok: false, reason: 'session-log-missing' })
  check('a missing log is named, not shown as "no activity"', failed.ok === false && failed.reason.includes('找不到'))
  const unreadable = LZ.RuntimeService.toView({ ok: false, reason: 'log-unreadable' })
  check('an unreadable log says so', unreadable.reason.includes('读不出来'))
}

// ---------------------------------------------------------------- agent view model

{
  const preset = {
    revision: 3,
    activeAgentId: 'luzzy',
    agents: [{ id: 'luzzy', name: '鹿溪', description: '', groupId: 'default', order: 0 }],
    groups: [{ id: 'default', name: '默认', order: 0 }],
    promptBytes: 1234,
    promptSource: 'agent',
    capabilities: { goalService: true, tools: true, sessions: true, agents: true },
  }
  const goalView = {
    capabilities: { goalService: true, tools: true },
    enforcement: { completionRejected: 2, completionAccepted: 1, reconcileOffered: 3, reconcileSkipped: 0, preflight: 4 },
  }
  const runtimeView = { ok: true, context: { provider: 'sta1n', model: 'deepseek-v4.1-flash' }, toolList: [{ name: 'read', count: 4 }, { name: 'pwsh', count: 1 }] }
  const view = LZ.AgentService.toView(preset, runtimeView, goalView)

  check('agent info names the active agent', view.info.some((row) => row.label === '名称' && row.value === '鹿溪'))
  check('agent info reports the real model', view.info.some((row) => row.label === '当前模型' && row.value.includes('deepseek')))
  check('behaviour strategy quotes the real enforcement counters',
    view.behavior.items.some((row) => row.value.includes('已拦下 2 次过早完成')))
  check('context policy credits the right owner for memory',
    view.context.some((row) => row.label === '自动加载记忆' && row.value.includes('不经本插件')))

  // With no goal view the behaviour rows must not invent values.
  const bare = LZ.AgentService.toView({ agents: [], groups: [], capabilities: {} }, null, null)
  check('behaviour is marked unavailable rather than defaulted', bare.behavior.available === false)
}

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} assertions (view models)`)
