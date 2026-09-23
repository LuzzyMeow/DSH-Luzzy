/**
 * Does the 「目标」 tab actually WORK in a real browser, against the real route?
 *
 * WHY THIS EXISTS AND WHAT IT REPLACES
 *
 * Two existing instruments stop short of the claim:
 *
 *   test-goal-routes.mjs      calls the handler directly. Proves the route answers correctly.
 *   probe-frame-console.mjs   runs the frame in a real browser, but with a fetch STUB, and it
 *                             never clicks the 目标 tab, so `loadGoal` is never called.
 *
 * Neither one answers "when a user opens the tab, does the page show what the runtime knows".
 * AGENTS.md §5.29 is explicit that a synthetic stand-in cannot prove a user-facing operation:
 * the earlier 155/155-green device drove `execCommand` into a field a human could not type in.
 * The same shape of false confidence applies here — a stub route proves the RENDERER works, not
 * the WIRING.
 *
 * So this test goes the whole way, with nothing faked:
 *
 *   1. the REAL `registerGoalRoutes` handler, mounted on a REAL http server, backed by a REAL
 *      delivery document written through the REAL store;
 *   2. the REAL built frame document (`lib/client.js`), loaded in a REAL browser;
 *   3. a REAL click on the 目标 tab (Input.dispatchMouseEvent — see §5.29 on hit-testing);
 *   4. assertions on the rendered TEXT, plus the frame's own `goal-fetch-ok` report.
 *
 * The browser is launched with `--remote-debugging-port=0`, which §5.18 records as the one
 * automation channel that works on this machine (`--dump-dom` returns 0 bytes; CDP does not).
 *
 * Usage: node tools/test-goal-live-frame.mjs
 */

import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchEdge, shutdown, attach } from './cdp-driver.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ------------------------------------------------------------------ the real goal state

const store = await import(new URL('../lib/goal-store.mjs', import.meta.url).href)
const domain = await import(new URL('../lib/goal-domain.mjs', import.meta.url).href)
const routes = await import(new URL('../lib/goal-routes.mjs', import.meta.url).href)

const SESSION = 'sess-live-frame'
const AT = Date.now()

// Build a plan by driving the real ops, so the page is fed something the domain actually
// produces rather than a hand-written shape that could drift from it.
let plan = domain.emptyDelivery(SESSION)
const op = (name, payload) => {
  const result = domain.applyDeliveryOp(plan, name, payload, { at: AT, actor: 'agent' })
  if (result.delivery === undefined) throw new Error(`${name} refused: ${JSON.stringify(result.error)}`)
  plan = result.delivery
}

op('addAcceptance', { description: 'LIVE-MARKER 验收项甲', mandatory: true })
op('addAcceptance', { description: 'LIVE-MARKER 验收项乙' })
op('addAcceptance', { description: 'LIVE-MARKER 验收项丙' })
op('addTask', { title: 'LIVE-MARKER 任务一' })
op('setFocus', { focus: 'LIVE-MARKER 当前焦点文案' })

const goal = {
  id: 'goal-live-frame',
  revision: 12,
  objective: 'LIVE-MARKER 目标陈述：验证页面读到的是运行时那一份',
  phase: 'active',
  activation: 'armed',
  roundsStarted: 3,
  maxGoalRounds: 256,
}

// Two of the criteria carry evidence and are verified, so the overview must show a real
// fraction rather than a bare 0/N — a page that only ever renders "0/3" would pass a weaker
// assertion while being unable to distinguish "no work done" from "counters not wired".
plan = domain.applyDeliveryOp(plan, 'addEvidence', {
  summary: 'LIVE-MARKER 证据一',
  kind: 'test',
  acceptance: [plan.acceptance[0].id],
}, { at: AT, actor: 'agent' }).delivery
plan = domain.applyDeliveryOp(plan, 'setAcceptanceStatus', {
  id: plan.acceptance[0].id,
  status: 'verified',
}, { at: AT, actor: 'agent' }).delivery

// ------------------------------------------------------------------ the real route handler

const ctx = {
  // `registerGoalRoutes` reaches for these through `ctx.get`, which returns undefined for
  // anything undeclared — see AGENTS.md §5.21 on why `ctx.<name>` would instead THROW.
  //
  // Three services are needed for the session-scoped path to resolve, and each is load-bearing:
  //   agents.get(id) -> the Agent object, WITHOUT which the route answers "not in this process"
  //   goals.get(agent) -> the runtime goal itself
  //   sessions -> the session record the agent hangs off
  get: (name) => {
    if (name === 'agents') return { get: (id) => (id === SESSION ? agent : undefined), list: () => [agent] }
    if (name === 'goals') return { get: (a) => (a.id === SESSION ? goal : undefined) }
    return undefined
  },
  effect: (fn) => { fn() },
  webServer: {
    register: ({ path, handler }) => { registered.push({ path, handler }); return () => {} },
  },
}
const registered = []

const agent = { id: SESSION, session: { id: SESSION, cwd: process.cwd() }, cwd: process.cwd() }
const diagDir = mkdtempSync(join(tmpdir(), 'luzzy-live-frame-diag-'))
// `deps.paths` is the key the route reads (`lib/index.js` passes `paths: goalPaths`), and its
// shape is `storePaths()`'s — `{home, dir, flags}`. Getting this wrong made the FIRST run of
// this test fail with "Cannot read properties of undefined (reading 'dir')", which the page
// honestly surfaced as "目标状态读不出来" — a harness defect that looked like a product defect.
const paths = store.storePaths(diagDir)

// Persist the plan through the real store. Without this the route answers `goalState: 'ok'`
// with a runtime goal but an EMPTY plan, and the page correctly renders 0/0 — a harness gap
// that reads like "the page cannot count", which is exactly the misreading to avoid.
const written = store.writeDeliveryOverlay(paths, SESSION, plan, 0)
check('the plan was persisted through the real store', written.ok === true, JSON.stringify(written))
plan = store.readDeliveryOverlay(paths, SESSION).delivery

routes.registerGoalRoutes(ctx, {
  paths,
  toolRegistered: true,
  applyAgentOp: (delivery, op, payload, context) => domain.applyDeliveryOp(delivery, op, payload, context),
})

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/__luzzy/page-under-test') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(frameDoc)
    return
  }
  if (url.pathname === '/__luzzy/goal') {
    const entry = registered.find((r) => r.path === '/__luzzy/goal')
    if (entry === undefined) {
      res.writeHead(500).end('route not registered')
      return
    }
    entry.handler(req, res)
    return
  }
  if (url.pathname === '/__luzzy/diag') {
    // Keep the frame's own diagnostics, so a failure can be read rather than guessed.
    let body = ''
    req.on('data', (c) => { body += String(c) })
    req.on('end', () => {
      frameDiag.push(body)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
    return
  }
  if (url.pathname === '/__luzzy/usage') {
    // The frame fetches usage on load regardless of tab; answer honestly so a failure here
    // is never mistaken for a goal failure.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      totals: { input: 0, output: 0, cache: 0 },
      buckets: [],
      models: [],
      windows: { day: [], week: [], month: [] },
      activity: [],
    }))
    return
  }
  if (url.pathname === '/__luzzy/preset') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ groups: [], agents: [] }))
    return
  }
  res.writeHead(404).end('not found')
})
const frameDiag = []
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${httpServer.address().port}`

check('the real route is mounted on a real server', registered.some((r) => r.path === '/__luzzy/goal'), origin)

// ------------------------------------------------------------------ the real frame document

// Render the frame with the project's own extractor, so this test reports on the artifact
// that ships. A regex here would be a second implementation of that extraction — which is
// exactly the kind of parallel source that drifts.
const page = join(tmpdir(), 'luzzy-live-frame.html')
const preview = join(tmpdir(), 'luzzy-frame-preview.html')
execFileSync(process.execPath, [
  join(PLUGIN_ROOT, 'tools', 'render-frame-preview.mjs'),
  '--out', preview,
], { stdio: 'inherit' })

const frameDoc = readFileSync(preview, 'utf8')
check('the built bundle yields a frame document', frameDoc.length > 10_000, `${frameDoc.length} bytes`)
writeFileSync(page, frameDoc, 'utf8')

// ------------------------------------------------------------------ real browser, real click

const launched = await launchEdge({ headless: true, windowSize: { width: 1100, height: 1000 } })
let session
try {
  session = await attach({ port: launched.port })
  const page = await session.openTarget('about:blank')
  await page.enable()

  await page.send('Page.navigate', { url: `${origin}/__luzzy/page-under-test` })
  await new Promise((r) => setTimeout(r, 1200))

  const bodyLength = await page.evaluate('document.body.innerHTML.length')
  check('the frame document actually loaded', bodyLength > 1000, `${bodyLength} chars`)

  // The host tells the frame which session it is looking at over `postMessage`
  // (`{source:'luzzy-page-host', type:'session', sessionId}` — client.js:4176). Driving that
  // same public channel is not a stub: it is the real handshake, sent exactly as the host
  // sends it. Without it the frame has no session and legitimately renders "no goal".
  await page.evaluate(`window.postMessage(
    { source: 'luzzy-page-host', type: 'session', sessionId: ${JSON.stringify(SESSION)} },
    '*'
  )`)
  await new Promise((r) => setTimeout(r, 400))

  const tookSession = await page.evaluate(
    `(() => { try { return document.body.innerText.includes('未拿到会话标识') } catch { return null } })()`,
  )
  check('the session handshake was accepted', tookSession === false, 'frame no longer says it lacks a session id')

  // The 目标 tab must exist and be laid out before it can be clicked.
  const hasTab = await page.waitFor('[data-tab="goal"]', { timeoutMs: 5000 })
  check('the 目标 tab is present', hasTab === true)

  // REAL mouse input, hit-tested — §5.29: `el.click()` bypasses hit testing and would report
  // success on a button that something else is covering.
  const at = await page.click('[data-tab="goal"]')
  check('the 目标 tab was clicked with real input', at.x > 0, `at ${Math.round(at.x)},${Math.round(at.y)}`)

  await new Promise((r) => setTimeout(r, 2500))

  const shown = String(await page.evaluate('document.body.innerText') ?? '')

  // --- the assertions that only a real click can earn ---

  check('the frame reported a successful goal fetch', frameDiag.some((d) => d.includes('goal-fetch-ok')),
    `${frameDiag.length} diag report(s)`)

  check('the objective from the runtime goal is on screen', shown.includes('LIVE-MARKER 目标陈述'),
    shown.includes('LIVE-MARKER') ? 'marker found' : 'no marker at all')

  check('the current focus from the plan is on screen', shown.includes('LIVE-MARKER 当前焦点文案'))

  // 验收标准与任务现在住在「计划」分区里 —— 目标中心一次只铺一屏（用户提过「太长」）。
  // 所以这两条断言要先**真的点一下分区**：真鼠标、走命中测试（§5.29）。顺带把「分区切换」
  // 本身也验了：一个只在源码里存在的分区条，和没有分区是同一种结果。
  const planAt = await page.click('[data-goalsection="plan"]')
  check('the 计划 section was clicked with real input', planAt.x > 0,
    `at ${Math.round(planAt.x)},${Math.round(planAt.y)}`)
  await new Promise((r) => setTimeout(r, 400))
  const planned = String(await page.evaluate('document.body.innerText') ?? '')

  check('an acceptance criterion is on screen', planned.includes('LIVE-MARKER 验收项甲'))
  check('a task is on screen', planned.includes('LIVE-MARKER 任务一'))

  // The fraction is the part that distinguishes a live count from a hard-coded shell.
  check('the verified fraction is computed, not hard-coded', shown.includes('1 / 3') || shown.includes('1/3'),
    (shown.match(/[\d]+\s*\/\s*[\d]+/g) ?? []).slice(0, 3).join(' ') || 'no fraction rendered')

  // --- Markdown 预览视窗（用户要的是「可滑动查看完整目标/计划」）-------------------
  //
  // 只有**真的把它点开**才算验过。三条缺一不可：视窗开出来了、内容被当 Markdown 渲染
  // 而不是原样文字、并且它**真的能滚**（「支持滑动查看」就是这最后一条）。
  //
  // 入口按钮长在「概览」卡上，而上面刚切去了「计划」——先切回来。这一句不是仪式：
  // 少了它，`[data-viewer="plan"]` 在文档里根本不存在，而失败信息只会说
  //「element not visible or absent」，读起来像是按钮坏了。
  await page.click('[data-goalsection="overview"]')
  await new Promise((r) => setTimeout(r, 300))

  const viewerAt = await page.click('[data-viewer="plan"]')
  check('the 完整计划 button was clicked with real input', viewerAt.x > 0,
    `at ${Math.round(viewerAt.x)},${Math.round(viewerAt.y)}`)
  await new Promise((r) => setTimeout(r, 1500))

  const dialog = String(await page.evaluate('document.body.innerText') ?? '')
  check('the markdown viewer opened', dialog.includes('完整目标与计划'))

  // 渲染过 vs 原文：渲染器把 `## 1. 预期目标` 变成 <h2>1. 预期目标</h2>，所以页面上不该
  // 再出现井号。井号还在 = 它把 Markdown 当纯文本贴出来了，那正是这一件要避免的结果。
  check('and the plan was RENDERED, not pasted as raw text',
    dialog.includes('1. 预期目标') && !dialog.includes('## 1. 预期目标'))

  const scrollable = await page.evaluate(
    `(() => {
       const el = document.querySelector('.dialogContent')
       if (el === null) return null
       return { overflows: el.scrollHeight > el.clientHeight + 4, height: el.clientHeight, content: el.scrollHeight }
     })()`,
  )
  check('and the viewer content actually scrolls',
    scrollable !== null && scrollable.overflows === true,
    scrollable === null ? 'no .dialogContent' : `${scrollable.content}px in ${scrollable.height}px`)

  check('the page did NOT report the goal as unavailable', !shown.includes('运行时 Goal 不可用'))

  if (failures.length > 0) {
    console.log('\n--- rendered text (first 1200 chars) ---')
    console.log(shown.slice(0, 1200))
    console.log('\n--- frame diag ---')
    for (const d of frameDiag.slice(-8)) console.log(`  ${d.slice(0, 200)}`)
  }
} finally {
  try { await shutdown({ child: launched.child, profile: launched.profile, session }) }
  catch { try { launched.child?.kill() } catch { /* gone */ } }
  httpServer.close()
  try { rmSync(diagDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try { rmSync(page, { force: true }) } catch { /* best effort */ }
  // Deliberately NOT deleting the shared `luzzy-frame-preview.html`.
  //
  // Several sibling tools (`render-frame-with-data.mjs`, `probe-goal-layout.mjs`) read that
  // file as a PRE-REQUISITE rather than regenerating it — deleting it here made both fail with
  // ENOENT, which looks exactly like "the goal layout broke". This test renders it as a side
  // effect; leaving it in place matches what those tools already expect to find.
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL ${f}`)
  process.exit(1)
}
