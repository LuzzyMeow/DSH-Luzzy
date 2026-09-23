// Render the goal page for real, headlessly: load the shipped frame modules, build the SAME
// fixture the screenshot tool uses, run the view-model boundary, then render the page.
//
// This exists because the screenshot came back showing the page's ERROR state and a screenshot
// cannot tell you which line threw. Here the exception surfaces with a stack.
//
// Usage: node tools/probe-goal-page-render.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFrameBuilder, PLUGIN_ROOT } from './frame-source.mjs'
import * as goalDomain from '../lib/goal-domain.mjs'

const { srcDoc } = loadFrameBuilder()
const script = srcDoc.match(/<script>\s*\n'use strict'([\s\S]*?)<\/script>/)[1]
// Everything before `LZ.App.start()`: definitions only.
const definitions = script.slice(0, script.indexOf('LZ.App.start()'))

function element() {
  const noop = () => {}
  return {
    innerHTML: '', textContent: '', hidden: true, dataset: {}, style: {},
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    addEventListener: noop, removeEventListener: noop, appendChild: noop, remove: noop,
    querySelector: () => null, querySelectorAll: () => [], focus: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  }
}
const sandbox = {
  document: {
    getElementById: () => element(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => element(), addEventListener: () => {}, removeEventListener: () => {},
    documentElement: { getAttribute: () => null, setAttribute: () => {}, classList: { contains: () => false } },
    head: { appendChild: () => {} }, body: { focus: () => {}, appendChild: () => {} }, hidden: false,
  },
  window: { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }), location: { href: 'http://localhost/' }, setTimeout: () => 0, clearTimeout: () => {}, fetch: () => Promise.reject(new Error('no fetch here')) },
  navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'node' },
  console,
  localStorage: { getItem: () => null, setItem: () => {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
}

const fn = new Function('window', 'document', 'navigator', 'console', 'setTimeout', 'clearTimeout', 'localStorage', `${definitions}\nreturn window.LZ;`)
const LZ = fn(sandbox.window, sandbox.document, sandbox.navigator, console, sandbox.setTimeout, sandbox.clearTimeout, sandbox.localStorage)
if (LZ === undefined) throw new Error('the frame modules did not register a namespace')

// ---- the same fixture the screenshot tool builds ----
let delivery = goalDomain.emptyDelivery('session-preview-1')
const at = 1_760_000_000_000
const steps = [
  ['addAcceptance', { description: 'loading / empty / error 三种状态都有对应界面' }],
  ['addTask', { title: '接入 /api/tasks 并处理三种状态', acceptance: ['AC-001'] }],
  ['setFocus', { focus: '完成 /api/tasks 接入' }],
  ['judgeChain', { goalMatch: 'matched', skillCheck: 'hit' }],
  ['activateSkill', {
    name: 'luzzy-roster-design',
    description: '设计类基线五条',
    purpose: '本次要判断 Dashboard 的视觉层级',
    source: 'https://github.com/LuzzyMeow/LuzzyPrompt/tree/main/skills/luzzy-roster-design',
  }],
  ['activateSkill', {
    name: 'local-skill',
    description: '本地那份',
    purpose: '验证本地路径不做成链接',
    source: 'C:/skills/local/SKILL.md',
  }],
]
for (const [op, payload] of steps) {
  const result = goalDomain.applyDeliveryOp(delivery, op, payload, { at, actor: 'agent' })
  if (result.delivery === undefined) throw new Error(`fixture step ${op} failed: ${result.error}`)
  delivery = result.delivery
}
const goal = { id: 'goal-preview-1', revision: 7, objective: '把 Settings 页改造成新的 Dashboard', phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 256 }

const view = LZ.GoalService.toView({
  sessionId: 'session-preview-1', goal, goalState: 'ok',
  capabilities: { goalService: true }, artifactPath: '.agent/goal.md',
  delivery, warnings: [],
  summary: goalDomain.summarize(delivery, goal),
  integrity: goalDomain.integrity(delivery, goal),
  drift: goalDomain.detectDrift(delivery, goal),
  artifact: { enabled: true, cwd: 'X', exists: true, path: '.agent/goal.md', bytes: 10, mtime: at, stale: false, text: 'x' },
})
console.log('=== view model ===')
console.log('ok:', view.ok)
console.log('chain:', JSON.stringify(view.delivery.chain))
console.log('skills:', view.delivery.skills.map((row) => `${row.id} ${row.name} link=${row.isLink}`).join(' | '))

console.log('')
console.log('=== the two new blocks ===')
const html = LZ.GoalPage.render({ status: 'ok', tab: 'goal', view, counters: null, enforcement: null, elapsed: 0 })
const chainAt = html.indexOf('data-chain=')
console.log(html.slice(Math.max(0, chainAt - 120), chainAt + 400))
console.log('...')
const skillAt = html.indexOf('goalSkills')
console.log(skillAt < 0 ? 'NO SKILL BLOCK RENDERED' : html.slice(skillAt - 60, skillAt + 900))
console.log('')
console.log('anchor for http source:', html.includes('<a class="link" href="https://github.com/LuzzyMeow'))
console.log('local path NOT an anchor :', html.includes('<code>C:/skills/local/SKILL.md</code>'))
