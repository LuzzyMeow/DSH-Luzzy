// Render the iframe document with fake data injected, so the charts can be verified
// visually without DSH. The frame's fetches are shimmed to return real aggregated data.
//
// Usage:
//   node tools/dump-usage-data.mjs
//   node tools/render-frame-preview.mjs --out frame.html
//   node tools/render-frame-with-data.mjs [--tab usage] [--window day|week|month] [--mode line|bar] [--dark] [--shot <png>]
//
// --shot captures the prepared page with a real browser. It lives here rather than as a
// separate tool because the page needs the two-phase click sequence below (a window click
// re-enters the loading state and repaints, so a mode click only lands on the second pass) —
// screenshotting without driving that would capture the default day/line chart every time.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { shoot } from './shoot.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// The goal fixture is built by the real domain, so this tool imports the real module rather
// than reimplementing its ops. A copy would pass while the shipped one drifted.
const goalDomain = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'goal-domain.mjs')).href)
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const tab = argValue('--tab', 'usage')
const windowName = argValue('--window', 'day')
const mode = argValue('--mode', 'line')
const dark = args.includes('--dark')
const out = argValue('--out', join(tmpdir(), `luzzy-frame-${tab}${dark ? '-dark' : ''}.html`))
const shot = argValue('--shot', null)

const frameHtml = readFileSync(join(tmpdir(), 'luzzy-frame-preview.html'), 'utf8')
// The usage payload as the host now returns it: totals + buckets + models + all three
// trend windows + the month activity strip. One payload, no per-unit variants.
const usage = JSON.parse(readFileSync(join(tmpdir(), 'luzzy-usage-data.json'), 'utf8'))
const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8')

// A preset fixture with the shape the host returns, so the sub-page renders its real
// layout rather than an empty state. Two groups and four agents are enough to exercise
// grouping, ordering, the "current" badge, and the session callout — and one agent is
// deliberately left ungrouped, because that column is where a fresh roster starts.
//
// The prompt texts carry REAL newlines (template literals, not escaped sequences): a
// prompt is multi-line by nature, and a fixture full of literal backslash-n would make the
// editor look correct while proving nothing about how it renders actual text.
const promptLuzzy = `# 你是鹿溪

一只猫耳少年。喜欢自称「鹿溪喵」，语气短、软、懒。
`
const promptEngineer = `你是一名资深软件工程师。

改代码前先读相邻代码的命名与模式；跑通测试再报完成。
`
const promptEditor = `你是一名中文文字编辑。删掉不加信息的句子，具体优于抽象。
`
const presetSnapshot = {
  revision: 3,
  settings: { version: 1, activeAgentId: 'luzzy' },
  groups: [
    { id: 'default', name: '默认', order: 0 },
    { id: 'writing', name: '写作', order: 1 },
  ],
  agents: [
    { id: 'luzzy', name: '鹿溪', description: '', groupId: 'default', order: 0, promptText: promptLuzzy },
    { id: 'engineer', name: '工程搭档', description: '', groupId: 'default', order: 1, promptText: promptEngineer },
    { id: 'editor', name: '文字编辑', description: '', groupId: 'writing', order: 2, promptText: promptEditor },
    { id: 'scratch', name: '临时试验', description: '', groupId: null, order: 3, promptText: '' },
  ],
  promptSource: 'agent',
  promptAgentId: 'luzzy',
  promptBytes: Buffer.byteLength(promptLuzzy, 'utf8'),
  promptPreview: promptLuzzy.slice(0, 2000),
  defaultPromptText: '默认提示词：没有激活任何智能体时使用。\n',
  warnings: [],
  capabilities: { sessionPresetSwitch: true, newSession: true, storeDir: 'C:\\Users\\Administrator\\.dsh\\luzzy-preset', presetsAvailable: true },
  session: { sessionId: 'session-preview-1', preset: 'luzzy-mode', known: true, canSwitchToLuzzy: false, reason: null },
}

// The goal fixture, built by driving the REAL domain ops rather than hand-writing a
// document. A hand-written fixture drifts from the ops the moment one changes, and it would
// also quietly prove nothing about them.
//
// The shape is what the route returns: the runtime goal, the plan, its integrity report, the
// drift report, the artifact state and the capabilities. It is deliberately a goal with work
// LEFT — a pending criterion, an open task, one open blocker and one pending proposal — so
// the screenshot shows the states that matter rather than an all-green page.
function buildGoalFixture() {
  let delivery = goalDomain.emptyDelivery('session-preview-1')
  const at = 1_760_000_000_000
  const steps = [
    ['addAcceptance', { description: 'loading / empty / error 三种状态都有对应界面' }],
    ['addAcceptance', { description: '接入 /api/tasks 并用真实响应验证' }],
    ['addAcceptance', { description: '窄屏与宽屏都不溢出' }, { mandatory: false }],
    ['addTask', { title: '接入 /api/tasks 并处理三种状态', acceptance: ['AC-001', 'AC-002'] }],
    ['addTask', { title: '补一次窄屏走查', acceptance: ['AC-003'], dependsOn: ['T-001'] }],
    ['addTask', { title: '复用现有 Dashboard 组件', acceptance: ['AC-001'] }],
    ['addEvidence', { summary: 'pnpm test 通过，142 个用例', kind: 'test', ref: 'pnpm test', acceptance: ['AC-001'] }],
    ['addEvidence', { summary: '三态在真浏览器里逐一点过', kind: 'runtime', ref: 'tools/review-dashboard.mjs', acceptance: ['AC-001'] }],
    ['setAcceptanceStatus', { id: 'AC-001', status: 'verified' }],
    ['setTaskStatus', { id: 'T-001', status: 'in_progress' }],
    ['setTaskStatus', { id: 'T-003', status: 'completed' }],
    ['setFocus', { focus: '完成 /api/tasks 接入，并验证 loading / empty / error 三种状态' }],
    ['setNext', { next: ['给 fetch 加超时并在超时时显示 error 态', '用真实工作区跑一次窄屏走查', '把 Dashboard 的截图补进证据'] }],
    ['addDecision', { decision: '复用现有 Dashboard 组件而不是新写一套', reason: '保持项目内的界面一致性', alternatives: '重新设计一版 Dashboard', rejectedBecause: '超出本次范围' }],
    ['addDecision', { decision: '错误态用页面内联提示，不用弹窗', reason: '原生对话框会夺走窗口焦点，关掉之后输入框会失效' }],
    ['addBlocker', { code: 'awaiting-api-fixture', message: '等待确认 /api/tasks 在空数据时返回 [] 还是 404' }],
    ['reconcile', { goalId: 'goal-preview-1', goalRevision: 7, objective: '把 Settings 页改造成新的 Dashboard，并接入 /api/tasks' }],
    ['proposeScope', { included: ['dashboard 页面与它的数据接入'], excluded: ['后端 /api/tasks 本身的实现'], reason: '接口已经存在，本次只做前端接入' }],
    ['addEvidence', { summary: '用户在页面上确认了 loading 态', kind: 'user_confirmation' }],
  ]
  for (const step of steps) {
    const [op, payload, extra] = step
    const result = goalDomain.applyDeliveryOp(delivery, op, { ...payload, ...(extra ?? {}) }, { at, actor: 'agent' })
    if (result.delivery === undefined) throw new Error(`goal fixture step ${op} failed: ${result.error}`)
    delivery = result.delivery
  }
  const goal = {
    id: 'goal-preview-1', revision: 7, objective: '把 Settings 页改造成新的 Dashboard，并接入 /api/tasks',
    phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 256,
  }
  const artifactText = goalDomain.renderGoalMarkdown(delivery, goal, { generatedAt: at, artifactPath: join('.agent', 'goal.md') })
  return {
    version: 1,
    sessionId: 'session-preview-1',
    goal,
    goalState: 'ok',
    candidates: [],
    capabilities: { goalService: true, agents: true, sessions: true, tools: true, artifact: true },
    artifactPath: join('.agent', 'goal.md'),
    healthLabels: goalDomain.HEALTH_LABELS,
    toolName: 'goal_delivery',
    delivery,
    warnings: ['任务 T-004 有 1 条依赖指向不存在的任务，已丢弃'],
    summary: goalDomain.summarize(delivery, goal),
    integrity: goalDomain.integrity(delivery, goal),
    drift: goalDomain.detectDrift(delivery, goal),
    artifact: {
      enabled: true, cwd: 'D:\\.NekoTool\\LuzzyRP', exists: true,
      path: 'D:\\\\.NekoTool\\\\LuzzyRP\\\\.agent\\\\goal.md', bytes: Buffer.byteLength(artifactText, 'utf8'),
      mtime: at, stale: false, text: artifactText,
    },
    enforcement: { preflight: 34, preflightMiss: 2, reconcileOffered: 5, reconcileSkipped: 27, completionRejected: 3, completionAccepted: 0, driftDetected: 1, revisionConflict: 1 },
    counters: { reconciliations: 5, lastReconcileAt: at, turnsSinceReconcile: 0 },
  }
}

const goalSnapshot = buildGoalFixture()

// Inject: a fetch shim before the frame script, and start on the requested tab.
//
// The theme is NOT injected as a :root override any more — the frame ships its own token
// blocks and switches on the html data-theme attribute, so the preview drives that same
// attribute. Overriding :root here would have tested a mechanism the real page never uses.
const shim = `
<script>
(function () {
  var USAGE = ${JSON.stringify(usage)};
  var README = ${JSON.stringify(readme)};
  var PRESET = ${JSON.stringify(presetSnapshot)};
  var GOAL = ${JSON.stringify(goalSnapshot)};
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (url, init) {
    var u = String(url);
    if (u.indexOf('/__luzzy/usage') === 0) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(USAGE); }, text: function () { return Promise.resolve(''); } });
    }
    if (u.indexOf('/__luzzy/readme') === 0) {
      return Promise.resolve({ ok: true, text: function () { return Promise.resolve(README); }, json: function () { return Promise.resolve({}); } });
    }
    if (u.indexOf('/__luzzy/goal') === 0) {
      // The real route answers a mutation with the WHOLE next state, so the fixture does
      // too rather than pretending the route returns something smaller.
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(GOAL); }, text: function () { return Promise.resolve(''); } });
    }
    if (u.indexOf('/__luzzy/preset') === 0) {
      // The frame's only POST is readPrompt, which asks for one agent's full text. The
      // snapshot carries a preview, so the shim answers from the same fixture rather than
      // pretending the route has more than it does.
      var body = {};
      try { body = JSON.parse((init && init.body) || '{}'); } catch (error) { body = {}; }
      if (body.op === 'readPrompt') {
        var agentId = body.agentId === undefined ? null : body.agentId;
        var found = null;
        var list = PRESET.agents || [];
        for (var i = 0; i < list.length; i++) if (list[i].id === agentId) found = list[i];
        var text = agentId === null ? (PRESET.defaultPromptText || '') : (found ? (found.promptText || '') : '');
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ agentId: agentId, text: text, exists: text !== '', inherited: false, bytes: text.length, maxBytes: 1048576 }); }, text: function () { return Promise.resolve(''); } });
      }
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(PRESET); }, text: function () { return Promise.resolve(''); } });
    }
    // The frame's flight recorder posts to /__luzzy/diag; there is no host here.
    if (u.indexOf('/__luzzy/diag') === 0) {
      return Promise.resolve({ ok: true, text: function () { return Promise.resolve(''); }, json: function () { return Promise.resolve({}); } });
    }
    return nativeFetch ? nativeFetch(url, init) : Promise.reject(new Error('no fetch'));
  };

  // The frame asks its parent for the session id at boot; here the "parent" is the page
  // itself, so the answer is posted back to make the session-aware half of the sub-page
  // render instead of sitting at "会话标识未知".
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (data && data.source === 'luzzy-page-frame' && data.type === 'want-session') {
      window.postMessage({ source: 'luzzy-page-host', sessionId: PRESET.session && PRESET.session.sessionId ? PRESET.session.sessionId : null }, '*');
    }
  });

  // Drive the page: switch to the requested tab, then to the requested time unit.
  //
  // Clicking the tab alone is NOT enough to exercise a unit — the frame always starts on
  // Drive the page: switch to the requested tab, then to the requested window and mode.
  //
  // Clicking the tab alone is NOT enough to exercise either control — the frame always
  // starts on day + line and only changes when its own buttons are clicked. An earlier
  // version did exactly that, and --unit hour produced a screenshot byte-identical to the
  // day one, so the acceptance proved nothing.
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      var tabBtn = document.querySelector('[data-tab="${tab}"]');
      if (tabBtn) tabBtn.click();

      // Both controls only exist once the usage payload has rendered, so wait for each.
      //
      // This shim is a NODE template literal, so anything in braces is interpolated here
      // and anything in backticks ends the string. The comment therefore avoids both: the
      // variable below must be named windowName, because using the name of the browser
      // global would throw a ReferenceError in Node (surfacing only as a tool crash).
      var wantedWindow = '${windowName}';
      var wantedMode = '${mode}';

      function waitFor(selector, onFound) {
        var tries = 0;
        var timer = setInterval(function () {
          tries += 1;
          var el = document.querySelector(selector);
          if (el) {
            clearInterval(timer);
            onFound(el);
          } else if (tries > 600) {
            clearInterval(timer);
            console.error('preview: never found ' + selector);
          }
        }, 25);
      }

      // The preset tab has no window/mode controls; waiting for them there would spin until
      // the 15 s timeout and then report a "never found" error for controls that are simply
      // not part of that page.
      if ('${tab}' === 'preset' || '${tab}' === 'readme') return;
      waitFor('[data-window="' + wantedWindow + '"]', function (windowBtn) {
        windowBtn.click();
        // Switching the window re-renders in place (no refetch, no skeleton), but the mode
        // buttons are re-created by that render, so they are looked up afresh.
        waitFor('[data-mode="' + wantedMode + '"]', function (modeBtn) {
          modeBtn.click();
        });
      });
    }, 50);
  });
})();
</script>
`

// Insert the shim right after <body> so it precedes the frame's own script, and set the
// theme the way the real parent does.
const withShim = frameHtml
  .replace('<body>', '<body>' + shim)
  .replace(/<html data-theme="[^"]*">/, `<html data-theme="${dark ? 'dark' : 'light'}">`)
  // A page background for the screenshot to sit on, standing in for the app shell.
  .replace('background: transparent;', `background: ${dark ? '#000' : '#f8f8f8'};`)
writeFileSync(out, withShim, 'utf8')

console.log(`tab=${tab} window=${windowName} mode=${mode}${dark ? ' dark' : ''}`)
console.log(`windows: ${usage.windows ? Object.keys(usage.windows).join(', ') : '(none)'}`)
console.log(`wrote: ${out} (${(withShim.length / 1024).toFixed(0)} KB)`)

if (shot !== null) {
  // Sized to the content. A taller window does not show more — it just pads the image with
  // dead space that then has to be scrolled past to read the evidence. The retry and
  // per-output profile live in shoot.mjs; see the notes there for why each is required.
  const height = tab === 'readme' ? 2400 : 1300
  if (shoot({ page: out, out: shot, height })) console.log(`shot: ${shot}`)
  else process.exitCode = 1
}