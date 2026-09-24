/**
 * The acceptance harness: real fixtures, a route stub, and a host page that mounts the frame.
 *
 * WHY THIS IS A MODULE AND NOT PART OF THE SHOOTER
 *
 * The shooter needs the fixtures and the stub; the scrolled-section shooter needs the same two.
 * The first version of the second tool scraped `STUB_BODY` out of the first tool's SOURCE with
 * string offsets — which failed silently enough to look like "the frame never booted", sending
 * the investigation to the frame instead of to the scraper. Shared code belongs in a module.
 *
 * THE FIXTURES ARE THE REAL RESPONSE SHAPES, read from `lib/goal-routes.mjs` /
 * `lib/runtime-routes.mjs` / `lib/preset-ops.mjs` / `lib/usage-worker.mjs`. A fixture that does
 * not match the route tests my imagination, not the page — and it fails in the worst direction:
 * it passes while the real page shows an empty state forever.
 *
 * @module tools/acceptance-harness
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFrameBuilder } from './frame-source.mjs'

const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The `/__luzzy/goal` response shape (buildGoalSnapshot in lib/goal-routes.mjs). */
export function goalFixture() {
  return {
    version: 1,
    sessionId: 'session-acceptance',
    goal: {
      id: 'goal-acceptance-0001',
      objective: '把 LuzzyPage 从插件功能展示页升级为中文化智能体控制台',
      phase: 'active',
      revision: 7,
      roundsStarted: 12,
      maxGoalRounds: 40,
      activation: 'armed',
    },
    goalState: 'ok',
    candidates: [],
    capabilities: { goalService: true, agents: true, sessions: true, tools: true, artifact: true },
    artifactPath: '.agent/goal.md',
    healthLabels: { healthy: '正常', 'needs-attention': '需要注意', blocked: '已阻塞', verifying: '待验证', completed: '已完成' },
    toolName: 'goal_delivery',
    delivery: {
      version: 1,
      sessionId: 'session-acceptance',
      revision: 14,
      updatedAt: NOW - 5 * MINUTE,
      goalId: 'goal-acceptance-0001',
      goalRevision: 7,
      objectiveMirror: '把 LuzzyPage 升级为中文化智能体控制台',
      focus: '实现目标中心的六节，并让任务树按依赖展开',
      next: ['补齐执行状态页的真实数据', '跑全量回归', '真浏览器验收五个页面'],
      scope: { included: ['前端五个页面', '只读执行状态路由'], excluded: ['不改 DSH Core', '不改后端 Goal 数据结构'] },
      constraints: ['不引入大型 UI 框架', '页面不得使用英文 UI 文案'],
      acceptance: [
        { id: 'AC-001', description: '五个页面全部中文且有空状态', status: 'verified', mandatory: true, evidence: ['E-001'], verifiedAt: NOW - 2 * HOUR },
        { id: 'AC-002', description: '目标中心含六节', status: 'verified', mandatory: true, evidence: ['E-002'], verifiedAt: NOW - HOUR },
        { id: 'AC-003', description: '执行状态读得到真实轮次', status: 'verified', mandatory: true, evidence: ['E-003'], verifiedAt: NOW - 30 * MINUTE },
        { id: 'AC-004', description: '视图模型边界成立', status: 'in_progress', mandatory: true, evidence: [], verifiedAt: null },
        { id: 'AC-005', description: '明暗两主题都亲眼看过', status: 'pending', mandatory: true, evidence: [], verifiedAt: null },
        { id: 'AC-006', description: '附带优化体验', status: 'pending', mandatory: false, evidence: [], verifiedAt: null },
      ],
      tasks: [
        { id: 'T-001', title: '建立 UI 基础与设计变量', status: 'completed', acceptance: ['AC-002'], dependsOn: [], artifacts: ['src/styles/tokens.css'] },
        { id: 'T-002', title: '重构页面架构', status: 'completed', acceptance: ['AC-001'], dependsOn: ['T-001'], artifacts: ['src/app/router.js'] },
        { id: 'T-003', title: '目标中心六节', status: 'in_progress', acceptance: ['AC-002'], dependsOn: ['T-002'], artifacts: ['src/pages/goal.js'] },
        { id: 'T-004', title: '执行状态页与只读路由', status: 'in_progress', acceptance: ['AC-003'], dependsOn: ['T-002'], artifacts: ['lib/runtime-routes.mjs'] },
        { id: 'T-005', title: '收尾验收', status: 'pending', acceptance: ['AC-005'], dependsOn: ['T-003', 'T-004'], artifacts: [] },
      ],
      evidence: [
        { id: 'E-001', kind: 'file', summary: '五页结构断言通过', detail: 'render-frame-preview', at: NOW - 2 * HOUR, ref: 'tools/render-frame-preview.mjs' },
        { id: 'E-002', kind: 'test', summary: '目标中心六节断言齐全', detail: 'test-client-load', at: NOW - HOUR, ref: 'tools/test-client-load.mjs' },
        { id: 'E-003', kind: 'runtime', summary: '在真实日志上读到 109 次工具调用', detail: '本机 225 个日志抽样', at: NOW - 30 * MINUTE, ref: 'tools/test-runtime-routes.mjs' },
      ],
      decisions: [
        { id: 'D-001', decision: '页面只吃视图模型，不解析后端字段', reason: '页面可对着手写视图模型断言，不必造假的宿主响应', alternatives: '页面直接读后端结构', rejectedBecause: '后端一改字段四个页面都要改', at: NOW - 3 * HOUR },
        { id: 'D-002', decision: '用量图表并入系统信息', reason: '方案要求系统信息含 Token 与工具调用', alternatives: '保留独立的用量页', rejectedBecause: '第六个 tab 会稀释五个主页面', at: NOW - 2 * HOUR },
      ],
      blockers: [
        { id: 'B-001', code: 'host-restart-required', message: '宿主半新增了只读路由，需要重启 DSH 才生效', at: NOW - 40 * MINUTE, resolvedAt: null },
        { id: 'B-002', code: 'font-source-missing', message: '普黑体 TTF 源已从上游消失', at: NOW - 6 * HOUR, resolvedAt: NOW - 5 * HOUR },
      ],
      proposals: [
        { id: 'P-001', field: 'objective', target: '', current: '升级为控制台', proposed: '升级为控制台，并补上移动端布局', value: null, reason: '手机上也该能看', impact: '多一轮验收', requiresHuman: true, status: 'pending', at: NOW - 20 * MINUTE },
      ],
      changes: [
        { id: 'C-006', at: NOW - 4 * MINUTE, actor: 'agent', action: '新增只读路由 /__luzzy/runtime', detail: '读会话日志的真实事件' },
        { id: 'C-005', at: NOW - 25 * MINUTE, actor: 'agent', action: '实现 pages/goal.js 六节', detail: '' },
        { id: 'C-004', at: NOW - 50 * MINUTE, actor: 'human', action: '确认用量并入系统信息', detail: '保留全部图表能力' },
        { id: 'C-003', at: NOW - 2 * HOUR, actor: 'agent', action: '建立 tokens.css 设计变量', detail: '' },
        { id: 'C-002', at: NOW - 3 * HOUR, actor: 'agent', action: '拆分 src/ 为多文件树', detail: '' },
        { id: 'C-001', at: NOW - 4 * HOUR, actor: 'system', action: '建立交付计划', detail: '' },
      ],
    },
    warnings: [],
    readSource: 'file',
    summary: {
      health: 'needs-attention',
      acceptance: { total: 6, verified: 3, rejected: 0, pending: 3, mandatory: 5 },
      tasks: { total: 5, verified: 0, completed: 2, active: 1, ready: 0, blocked: 0, cancelled: 0 },
      evidence: { total: 3 },
      decisions: { total: 2 },
      blockers: { open: 1, total: 2 },
      proposals: { pending: 1 },
      changes: { total: 6 },
    },
    integrity: {
      valid: false,
      errors: [{ code: 'GOAL_MISSING_EVIDENCE', target: 'AC-004', detail: '这条验收标准标为必须，但还没有任何证据' }],
      warnings: [{ code: 'GOAL_DRIFT_DETECTED', target: 'goal', detail: '计划基于修订 6，当前目标是修订 7' }],
    },
    drift: { fields: ['revision'], before: { revision: 6 }, after: { revision: 7 } },
    artifact: { enabled: true, cwd: 'C:\\Work\\demo', exists: true, path: '.agent/goal.md', bytes: 4821, mtime: NOW - 6 * MINUTE, stale: false, text: null },
    enforcement: { preflight: 14, preflightMiss: 1, reconcileOffered: 4, reconcileSkipped: 0, goalNudged: 1, completionRejected: 2, completionAccepted: 1, driftDetected: 1, evidenceMissing: 3, revisionConflict: 0 },
    counters: { reconciliations: 4, lastReconcileAt: NOW - HOUR, turnsSinceReconcile: 2, preflights: 14, preflightMisses: 1, lastPreflightTurn: 11, goalNudged: true, lastPreflightStep: 42 },
  }
}

/** The `/__luzzy/runtime` response shape (buildRuntimeSnapshot in lib/runtime-routes.mjs). */
export function runtimeFixture() {
  return {
    ok: true,
    sessionId: 'session-acceptance',
    source: 'session',
    scanned: 40,
    version: '0.1.0',
    openedAt: NOW - 9 * HOUR,
    endedAt: NOW - MINUTE,
    currentTurn: 12,
    turnsCompleted: 11,
    steps: 184,
    toolCalls: 109,
    toolErrors: 2,
    toolList: [
      { name: 'read', count: 39 },
      { name: 'write', count: 17 },
      { name: 'goal_delivery', count: 15 },
      { name: 'grep', count: 13 },
      { name: 'pwsh', count: 11 },
      { name: 'edit', count: 10 },
      { name: 'glob', count: 2 },
      { name: 'create_goal', count: 1 },
      { name: 'ask_user_question', count: 1 },
    ],
    recentCalls: [
      { at: NOW - MINUTE, name: 'edit', turn: 12, step: 184, ok: true },
      { at: NOW - 3 * MINUTE, name: 'read', turn: 12, step: 183, ok: true },
      { at: NOW - 6 * MINUTE, name: 'pwsh', turn: 12, step: 182, ok: false },
    ],
    ruleFiles: ['AGENTS.md', 'CLAUDE.md'],
    compactions: 3,
    goalChanges: 11,
    context: { provider: 'sta1n', model: 'deepseek-v4.1-flash', contextWindow: 1000000 },
    preset: 'luzzy-mode',
    sandbox: 'danger-full-access',
    approval: 'never',
    elapsedMs: 5_400_000,
    lastToolAt: NOW - MINUTE,
  }
}

/** The `/__luzzy/preset` response shape (buildSnapshot in lib/preset-ops.mjs). */
export function presetFixture() {
  return {
    revision: 5,
    settings: { version: 3, activeAgentId: 'luzzy' },
    groups: [{ id: 'g1', name: '写作', order: 0 }, { id: 'g2', name: '工程', order: 1 }],
    agents: [
      { id: 'luzzy', name: '鹿溪', description: '猫耳少年 · 资深工程搭档', groupId: 'g1', order: 0 },
      { id: 'reviewer', name: '审阅者', description: '', groupId: 'g2', order: 1 },
    ],
    promptSource: 'agent',
    promptAgentId: 'luzzy',
    promptBytes: 57_200,
    session: { sessionId: 'session-acceptance', preset: 'luzzy-mode', known: true, canSwitchToLuzzy: false, reason: null },
    warnings: [],
    capabilities: { sessionPresetSwitch: true, newSession: true, storeDir: 'C:\\Users\\demo\\.dsh\\luzzy-preset', presetsAvailable: true },
  }
}

/** The `/__luzzy/usage` response shape (aggregate in lib/usage-worker.mjs). */
export function usageFixture() {
  const slot = (label) => ({ key: label, label, isFuture: false })
  const hours = Array.from({ length: 24 }, (_, i) => ({ key: `${i}`, label: `${String(i).padStart(2, '0')}:00`, isFuture: i > 14 }))
  const series = [
    { key: 'sta1n/deepseek-v4.1-flash', values: hours.map((_, i) => (i > 14 ? null : Math.round(Math.abs(Math.sin(i / 3)) * 3.2e8))), windowTotal: 2_400_000_000 },
    { key: 'xiaomi/mimo-v2.6-pro', values: hours.map((_, i) => (i > 14 ? null : Math.round(Math.abs(Math.cos(i / 4)) * 1.1e8))), windowTotal: 900_000_000 },
  ]
  const days = Array.from({ length: 30 }, (_, i) => ({
    key: `2026-09-${String(i + 1).padStart(2, '0')}`,
    tokens: i > 22 ? 0 : Math.round(Math.abs(Math.sin(i)) * 4e8),
    isFuture: i > 22,
  }))
  return {
    unit: 'day',
    generatedAt: NOW,
    sessions: 225,
    skipped: 0,
    attempts: 20085,
    cache: { hits: 200, misses: 25, saved: true },
    range: { from: NOW - 30 * 24 * HOUR, to: NOW },
    totals: { totalTokens: 6_627_259_780, cacheReadTokens: 4_800_000_000, inputTokens: 5_900_000_000, outputTokens: 727_259_780 },
    buckets: [],
    models: [
      { key: 'sta1n/deepseek-v4.1-flash', totalTokens: 4_200_000_000 },
      { key: 'xiaomi/mimo-v2.6-pro', totalTokens: 1_600_000_000 },
      { key: 'local/ollama-qwen', totalTokens: 827_259_780 },
    ],
    modelRoutingCounts: [],
    windows: {
      day: { series, slots: hours, windowTotal: 3_300_000_000, label: '今天', caption: '今天的 24 小时' },
      week: { series: series.map((s) => ({ ...s, values: s.values.slice(0, 7) })), slots: ['9/21', '9/22', '9/23', '9/24', '9/25', '9/26', '9/27'].map(slot), windowTotal: 5_100_000_000 },
      month: {
        series,
        slots: ['第1周', '第2周', '第3周', '第4周'].map((label, i) => ({ key: label, label, range: `9.${1 + i * 7} - 9.${7 + i * 7}`, isFuture: false })),
        windowTotal: 8_900_000_000,
      },
    },
    activity: { month: '2026-09', daysInMonth: 30, today: 23, days },
  }
}

/**
 * The route stub body, as raw JavaScript.
 *
 * NOT wrapped in `<script>` tags, and NOT placed by string surgery on another file. Both were
 * mistakes: a stub carrying its own `</script>` inside the frame's script block terminates it,
 * turning every later module into HTML text.
 */
export const STUB_BODY = `(function () {
  var GOAL = ${JSON.stringify(goalFixture())};
  var RUNTIME = ${JSON.stringify(runtimeFixture())};
  var PRESET = ${JSON.stringify(presetFixture())};
  var USAGE = ${JSON.stringify(usageFixture())};
  window.__stubRoutes = [];
  window.fetch = function (url) {
    var u = String(url);
    window.__stubRoutes.push(u);
    if (u.indexOf('/__luzzy/diag') === 0) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); }, text: function () { return Promise.resolve(''); } });
    }
    var body = null;
    if (u.indexOf('/__luzzy/goal') === 0) body = GOAL;
    else if (u.indexOf('/__luzzy/runtime') === 0) body = RUNTIME;
    else if (u.indexOf('/__luzzy/preset') === 0) body = PRESET;
    else if (u.indexOf('/__luzzy/usage') === 0) body = USAGE;
    else if (u.indexOf('/__luzzy/readme') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('# Luzzy 控制台\\n\\n这是插件说明。\\n\\n- 五个页面\\n- 一个次要入口\\n'); }, json: function () { return Promise.resolve({}); } });
    }
    if (body === null) {
      return Promise.resolve({ ok: false, status: 404, text: function () { return Promise.resolve('not stubbed: ' + u); }, json: function () { return Promise.reject(new Error('not stubbed: ' + u)); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); }, text: function () { return Promise.resolve(JSON.stringify(body)); } });
  };
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'want-session' && e.source) {
      e.source.postMessage({ source: 'luzzy-page-host', type: 'session', sessionId: 'session-acceptance' }, '*');
    }
  });
})();`

/**
 * The frame document with the stub inserted, and the theme set.
 *
 * The stub lands BETWEEN the modules and `LZ.App.start()`. That placement is unambiguous — the
 * modules each end with `})();` and `start()` is its own statement, so the stub cannot join to
 * either neighbour — while still running before the first fetch.
 */
export function frameWithStub(theme) {
  const { srcDoc } = loadFrameBuilder()
  const themed = srcDoc.replace('<html data-theme="light">', `<html data-theme="${theme}">`)
  if (!themed.includes(`data-theme="${theme}"`)) throw new Error('could not set the frame theme')
  const marker = '\nLZ.App.start()'
  if (!themed.includes(marker)) throw new Error('the frame never calls LZ.App.start() — nothing to inject before')
  return themed.replace(marker, `\n${STUB_BODY}\nLZ.App.start()`)
}

/**
 * Write a host page that mounts the frame in an iframe and return its path.
 *
 * `srcdoc` is assigned from script rather than written as an attribute: JSON-escaping is exact,
 * whereas hand-rolled HTML-attribute escaping is where a quote inside the document silently
 * truncates it.
 */
export function writeHostPage(doc, { width, height, theme, label }) {
  const host = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${theme === 'dark' ? '#000' : '#fff'}}
iframe{border:0;width:100%;height:${height}px;display:block}
</style></head><body>
<iframe id="frame" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
document.getElementById('frame').srcdoc = ${JSON.stringify(doc).replace(/<\//g, '<\\/')};
</` + `script></body></html>`
  const path = join(tmpdir(), `luzzy-acceptance-${label}-${theme}-${width}-${process.pid}.html`)
  writeFileSync(path, host, 'utf8')
  return path
}

/**
 * A helper that runs a function inside the FRAME document.
 *
 * Passed to `page.evaluate` as `(${inFrame})((doc, win) => …)`. The iframe is a separate document
 * with its own `window`, so the parent's document cannot reach its nodes.
 */
export const IN_FRAME = `(fn) => {
  const f = document.getElementById('frame');
  if (!f || !f.contentDocument) return { error: 'no frame document' };
  return fn(f.contentDocument, f.contentWindow);
}`

/**
 * The same helper for when the frame document IS the page.
 *
 * `render-frame-with-data.mjs` writes the frame's own HTML to a temp file, so pointing a browser
 * at that file gives a document with no `#frame` iframe inside it. Measuring THAT is the point:
 * it is the exact page the screenshots come from, byte for byte. `IN_FRAME` would return
 * `{error: 'no frame document'}` there, which reads as "the page is broken" rather than "you
 * aimed the loader at the wrong document".
 */
export const AS_DOCUMENT = `(fn) => fn(document, window)`

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
