/**
 * Dynamic end-to-end rig for the 「预设」 sub-page: the REAL frame document talking to the
 * REAL host routes, driven by a REAL browser with REAL input.
 *
 * WHAT IS REAL AND WHAT IS NOT (state this honestly; the value of the rig depends on it)
 *
 *   real   the frame document — extracted from the built bundle, byte-for-byte the one DSH loads
 *   real   the host routes — `apply()` from lib/index.js, mounted on a real node:http server
 *   real   the store — a temp DSH_HOME, so every read and write goes through preset-store.mjs
 *   real   the browser — Edge over CDP; clicks are Input.dispatchMouseEvent, not .click()
 *   real   the same-origin relationship — the frame is served by the SAME server that hosts
 *          /__luzzy/preset, so its fetches are ordinary HTTP against the real handlers
 *
 *   modelled  the DSH shell — a parent window that answers the frame's `want-session` and
 *             `create-session` messages. It is ~30 lines and it is the ONLY stand-in.
 *
 * Why that stand-in is acceptable and not a "more permissive fake": DSH's own services
 * (`agents`, `agentPresets`, `sessionController`) are NOT simulated. They are ABSENT, so
 * `ctx.get()` returns undefined and the page exercises its real no-services branch. A fake
 * that returned richer answers than DSH would be the §5.21 trap; this one models the shell,
 * which is exactly what it is, and nothing more.
 *
 * WHAT THIS RIG DELIBERATELY DOES NOT COVER
 *
 * Session and preset switching (L12 in the plan). `switchSession` needs DSH's live
 * `agentPresets` and its preset lock; `sessions.create` needs the app's client service. Both
 * are absent here by construction, so the rig asserts the page's HONEST DEGRADATION — the
 * capability is reported unavailable and the button explains itself — and the working path is
 * left to real-machine acceptance. Pretending otherwise would be the exact failure mode this
 * whole review is meant to prevent.
 *
 * Usage:
 *   node tools/review-preset-rig.mjs                 # all scenarios
 *   node tools/review-preset-rig.mjs --shot <dir>    # also write screenshots for visual review
 *   node tools/review-preset-rig.mjs --keep-going    # run every scenario, do not stop at the first failure
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

import { launchEdge, attach, shutdown } from './cdp-driver.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const shotDir = argValue('--shot', null)
const keepGoing = args.includes('--keep-going')

// ---------------------------------------------------------------- reporting

const failures = []
const notes = []
let checks = 0
let currentScenario = '(setup)'

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    notes.push(`  ok   ${label}`)
    return true
  }
  failures.push(`[${currentScenario}] ${label}${detail === '' ? '' : ` — ${detail}`}`)
  notes.push(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}

function same(label, actual, expected) {
  return check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ---------------------------------------------------------------- isolated DSH home

// The whole store lives in a temp directory. preset-store resolves DSH home from $DSH_HOME,
// and so does DSH's own dsh-home-paths, so this redirect is the supported mechanism rather
// than a hook invented here. Without it the rig would read AND WRITE the user's real prompts.
const dshHome = mkdtempSync(join(tmpdir(), 'luzzy-rig-home-'))
process.env.DSH_HOME = dshHome
mkdirSync(join(dshHome, 'luzzy-preset', 'agents'), { recursive: true })

const storeDir = join(dshHome, 'luzzy-preset')
const settingsPath = join(storeDir, 'settings.json')
const agentsDir = join(storeDir, 'agents')
const archiveDir = join(storeDir, 'archive')

const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
/**
 * The path of one agent's prompt file, or the default prompt's.
 *
 * `id === null` means the DEFAULT prompt, which lives at `default.md` — not at `null.md`.
 * An earlier version concatenated the id unconditionally, so every default-prompt assertion
 * silently read a file that never existed and reported a loss that had not happened.
 */
const promptFile = (id) => (id === null ? join(storeDir, 'default.md') : join(agentsDir, `${id}.md`))
const readPromptFile = (id) => (existsSync(promptFile(id)) ? readFileSync(promptFile(id), 'utf8') : null)
/**
 * The active agent id as the READER sees it, not as the file spells it.
 *
 * These differ in exactly the case that matters: a store whose `activeAgentId` points at a
 * deleted agent keeps that id in the file, while `readStore` normalizes it to null and records
 * a warning. Asserting on the raw file would miss the normalization entirely.
 */
const readStoreActive = () => store.readStore(storePaths).store.activeAgentId

/** A roster with a group, an ungrouped agent, and real multi-line prompts. */
function seedStore() {
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        version: 1,
        revision: 1,
        activeAgentId: 'luzzy',
        groups: [
          { id: 'default', name: '默认', order: 0 },
          { id: 'writing', name: '写作', order: 1 },
        ],
        agents: [
          { id: 'luzzy', name: '鹿溪', description: '', groupId: 'default', order: 0 },
          { id: 'engineer', name: '工程搭档', description: '', groupId: 'default', order: 1 },
          { id: 'editor', name: '文字编辑', description: '', groupId: 'writing', order: 2 },
          { id: 'scratch', name: '临时试验', description: '', groupId: null, order: 3 },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  // REAL newlines, and one prompt contains text that would break the prompt renderer if it
  // were placed in section TEXT rather than a variable: braces, a backtick, and a dollar.
  writeFileSync(promptFile('luzzy'), '# 你是鹿溪\n\n一只猫耳少年。喜欢自称「鹿溪喵」。\n\n示例：{{cwd}} 与 {{luzzy_persona}} 都应当被原样保留。\n', 'utf8')
  writeFileSync(promptFile('engineer'), '你是一名资深软件工程师。\n\n改代码前先读相邻代码的命名与模式。\n', 'utf8')
  writeFileSync(promptFile('editor'), '你是一名中文文字编辑。删掉不加信息的句子。\n', 'utf8')
  // `scratch` deliberately has NO file: it must render as inheriting the default.
  writeFileSync(join(storeDir, 'default.md'), '默认提示词：没有激活任何智能体时使用。\n', 'utf8')
}

seedStore()

// ---------------------------------------------------------------- the real host routes

// LUZZY_DIAG_DIR keeps apply()'s registration marker out of the user's real diag directory.
// A test process writing there once produced a marker whose pid and port were read as
// evidence about the running app — that misled an entire debugging round.
const diagDir = mkdtempSync(join(tmpdir(), 'luzzy-rig-diag-'))
process.env.LUZZY_DIAG_DIR = diagDir

const plugin = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'index.js')).href)

// A real HTTP server, and a webServer facade with the same contract the host provides:
// `register()` mounts a route and returns a disposer.
const routes = []
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((entry) => entry.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

const disposers = []
const ctx = {
  effect(fn) {
    disposers.push(fn())
    return () => {}
  },
  get: () => undefined,
  on: () => {},
  webServer: {
    port,
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  },
}

// ---------------------------------------------------------------- the frame document

// Extract buildFrameDocument from the BUILT bundle, so the document under test is the exact
// one shipped — not a copy that can drift. The bundle uses CRLF, so pair backticks rather
// than matching newlines.
const bundle = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

function templateAfter(marker) {
  const start = bundle.indexOf(marker)
  if (start < 0) return ''
  const open = bundle.indexOf('`', start)
  if (open < 0) return ''
  const close = bundle.indexOf('`', open + 1)
  if (close < 0) return ''
  return bundle.slice(open + 1, close)
}

const fontCss = templateAfter('const FONT_FACE_CSS')
if (fontCss.trim() === '') throw new Error('could not extract FONT_FACE_CSS from the built bundle')

const fnStart = bundle.indexOf('function buildFrameDocument(')
if (fnStart < 0) throw new Error('buildFrameDocument not found in the built bundle')
let depth = 0
let fnEnd = -1
for (let i = bundle.indexOf('{', fnStart); i < bundle.length; i += 1) {
  if (bundle[i] === '{') depth += 1
  else if (bundle[i] === '}') {
    depth -= 1
    if (depth === 0) { fnEnd = i + 1; break }
  }
}
if (fnEnd < 0) throw new Error('could not find the end of buildFrameDocument')
const buildFrameDocument = new Function(`${bundle.slice(fnStart, fnEnd)}; return buildFrameDocument`)()
const FRAME_HTML = buildFrameDocument(fontCss)

// ---------------------------------------------------------------- the harness page

/**
 * The modelled DSH shell.
 *
 * It hosts the real frame in an iframe and answers the two messages the frame sends. Session
 * handling is intentionally minimal: it reports a fixed session id, and for a create request
 * it reports that the app service is unavailable — which is the truth in this deployment.
 * Everything the assertions touch is inside the frame or inside the host route.
 *
 * THE `</script>` PROBLEM
 *
 * The frame document is ~497 KB of HTML and it contains a literal `</script>` of its own. It
 * is embedded here as a JSON string inside a `<script>` tag, and the HTML parser ends that
 * script at the FIRST `</script>` it sees — inside a JavaScript string literal or not. The
 * parser has no idea it is looking at a string; that is HTML lexing, not JS.
 *
 * Measured consequence of getting this wrong: the harness script terminated mid-literal, the
 * iframe's `srcdoc` was never assigned, and the rig reported "the frame document booted:
 * false" with no error anywhere — the exact silent-blank-page family this review exists to
 * catch, reproduced inside the review tooling.
 *
 * The fix is the standard one: escape the slash so the parser cannot recognise the sequence,
 * while the JS string still evaluates to the original characters.
 */
const escapeForScriptTag = (text) => text.replace(/<\//g, '<\\/')

/**
 * Every `/__luzzy/*` request the frame made, in order.
 *
 * Recorded server-side rather than read out of the page: it is the only view that cannot be
 * wrong about what was actually asked for, and several assertions are about the REQUEST (which
 * session id it carried) rather than the response.
 */
const observedRequests = []

const HARNESS_HTML = `<!doctype html>
<html data-theme="light">
<head><meta charset="utf-8"><title>preset rig</title>
<style>
  html, body { margin: 0; height: 100%; background: #f8f8f8; }
  iframe { border: 0; width: 100%; height: 100vh; display: block; }
</style>
</head>
<body>
<iframe id="frame" title="LuzzyPage 预设审查"></iframe>
<script>
(function () {
  var FRAME_HTML = ${escapeForScriptTag(JSON.stringify(FRAME_HTML))};
  var frame = document.getElementById('frame');
  // Recorded so a scenario can assert the frame really asked, rather than assuming it did.
  window.__rigMessages = [];
  frame.srcdoc = FRAME_HTML;

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== 'luzzy-page-frame') return;
    var source = event.source;
    if (!source) return;
    window.__rigMessages.push({ type: data.type, at: Date.now() });

    if (data.type === 'want-session') {
      source.postMessage({ source: 'luzzy-page-host', type: 'session', sessionId: 'session-rig-1' }, '*');
      return;
    }
    if (data.type === 'create-session') {
      // The app's session service is not present in this deployment. Say so, in the same
      // shape the real client half uses, so the frame renders its real degraded message.
      source.postMessage({
        source: 'luzzy-page-host',
        type: 'session-created',
        ok: false,
        detail: '审查装置里没有 DSH 的会话服务（真机上这一步走 sessions.create + open）。'
      }, '*');
      return;
    }
  });
})();
</script>
</body>
</html>`

// A harness that serves each navigation to the SAME origin as the routes, so the frame's
// relative fetches land on the real handlers.
const serverWithHarness = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // Every request the frame makes is recorded on the page, so a scenario can assert WHAT was
  // asked for (a session id, an op) rather than only what came back. Serving this list through
  // a global avoids guessing at internal state.
  if (url.pathname === '/rig-requests') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(observedRequests))
    return
  }
  // The browser requests /favicon.ico on its own. Answering it keeps the console genuinely
  // clean, which is the point of the console assertion — filtering the 404 away would hide
  // the difference between "nothing went wrong" and "we tuned the noise out".
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end()
    return
  }
  if (url.pathname === '/' || url.pathname === '/rig.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(HARNESS_HTML)
    return
  }
  if (url.pathname.startsWith('/__luzzy/')) {
    observedRequests.push(`${req.method} ${req.url}`)
  }
  const route = routes.find((entry) => entry.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(String(error))
  })
})

// ---------------------------------------------------------------- run

let launcher = null
let session = null
let page = null

/** Screenshots written for visual review, with their hashes, to prove they differ. */
const shots = []
async function shot(name) {
  if (shotDir === null || page === null) return
  mkdirSync(shotDir, { recursive: true })
  const png = await page.screenshot()
  const file = join(shotDir, `${name}.png`)
  writeFileSync(file, png)
  shots.push({ name, file, sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length })
  notes.push(`  shot ${name} (${(png.length / 1024).toFixed(0)} KB)`)
}

/** Read the store through the module the preset uses — the same code path as production. */
const store = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'preset-store.mjs')).href)
const storePaths = store.storePaths(dshHome)
/** What the model would actually be sent, resolved by the SAME reader the preset row uses. */
const resolvedPrompt = () => store.createPromptReader(storePaths, { builtinFallbackPath: null }).read()

try {
  plugin.apply(ctx)
  notes.push(`  ok   apply() mounted ${routes.length} real routes`)
  notes.push(`       store: ${storeDir}`)

  // Close the throwaway listener; the harness server below is the one the browser talks to.
  await new Promise((resolve) => server.close(resolve))

  await new Promise((resolve) => serverWithHarness.listen(port, '127.0.0.1', resolve))

  launcher = await launchEdge({ windowSize: { width: 1280, height: 1100 } })
  session = await attach({ port: launcher.port })
  page = await session.openTarget(`${origin}/rig.html`)

  check('the rig page loaded', (await page.evaluate('location.pathname')) === '/rig.html')

  // The frame is a separate document; drive it through its own frame context.
  async function frameEval(expression) {
    const frameHandle = 'document.getElementById("frame")'
    return page.evaluate(`(() => {
      const f = ${frameHandle};
      if (!f || !f.contentWindow) throw new Error('no frame');
      return f.contentWindow.eval(${JSON.stringify(expression)});
    })()`)
  }

  /**
   * Click something inside the frame with a real mouse event.
   *
   * MEASURE IMMEDIATELY, THEN CLICK — the ordering is the whole point.
   *
   * Every roster mutation re-renders the list, so rows shift and any rectangle captured
   * earlier is stale. An early version of this rig measured the frame offset once and reused
   * it: after a delete shifted the rows up, the "click engineer" coordinates landed on a
   * different agent. The failure was silent and looked like a product bug — the assertions
   * said "the selection did not take", when in truth the rig had clicked something else.
   *
   * So each click re-measures, and then VERIFIES that the coordinates that were clicked
   * actually belong to the intended element. A rig that cannot tell whether its own click
   * landed is worse than no rig.
   */
  async function clickInFrame(selector, { settleMs = 250 } = {}) {
    await page.evaluate(`(() => {
      const d = document.getElementById('frame').contentDocument;
      const el = d.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('not present in frame: ' + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center' });
    })()`)
    // Let any layout work triggered by scrollIntoView / a pending re-render finish.
    await new Promise((resolve) => setTimeout(resolve, settleMs))

    const geometry = await page.evaluate(`(() => {
      const f = document.getElementById('frame');
      const fr = f.getBoundingClientRect();
      const el = f.contentDocument.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { fx: fr.x, fy: fr.y, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`)
    if (geometry === null) throw new Error(`cannot click a zero-size or absent element: ${selector}`)

    const pageX = geometry.fx + geometry.x
    const pageY = geometry.fy + geometry.y

    // WHAT IS AT THESE COORDINATES — measured BEFORE the click, not after.
    //
    // The order is load-bearing. Checking afterwards is inherently racy: a button that opens a
    // dialog is, by definition, covered by that dialog the moment it works. Verifying after
    // the fact therefore reported "the click did not land on #presetDelete" precisely because
    // it HAD worked. Measuring first answers the question actually being asked — "is the thing
    // I am about to click the topmost element here?" — and is stable.
    const landedOn = await page.evaluate(`(() => {
      const f = document.getElementById('frame');
      const fr = f.getBoundingClientRect();
      const el = f.contentDocument.elementFromPoint(${pageX} - fr.x, ${pageY} - fr.y);
      if (!el) return null;
      return {
        matches: el.matches(${JSON.stringify(selector)}) || el.closest(${JSON.stringify(selector)}) !== null,
        tag: el.tagName,
        blockedByDialog: el.closest('.dialogScrim') !== null,
        text: (el.textContent || '').trim().slice(0, 30),
      };
    })()`)

    await page.clickAt(pageX, pageY)
    return landedOn
  }

  /**
   * Click something in the frame that must be unobstructed, and fail if it was not.
   *
   * Use this when a missed click would invalidate the scenario (a selection that has to land,
   * a button that has to be pressed). Use `clickInFrame` when the click is expected to be
   * intercepted — clicking a roster row while a discard dialog is open, for instance.
   */
  async function clickInFrameUnobstructed(selector, options) {
    const landedOn = await clickInFrame(selector, options)
    check(`the click on ${selector} landed on it, unobstructed`,
      landedOn !== null && landedOn.matches === true, JSON.stringify(landedOn))
    return landedOn
  }

  /** Answer whatever dialog is currently open, by its primary button, with a real click. */
  async function confirmDialog() {
    const target = await waitInFrame(`(() => {
      const scrim = document.querySelector('.dialogScrim');
      if (!scrim) return null;
      const buttons = Array.from(scrim.querySelectorAll('.dialogActions button'));
      const last = buttons[buttons.length - 1];
      if (!last) return null;
      const r = last.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (last.textContent || '').trim() };
    })()`, { timeoutMs: 5000 })
    if (target === null) return null
    const offset = await page.evaluate(`(() => {
      const r = document.getElementById('frame').getBoundingClientRect();
      return { x: r.x, y: r.y };
    })()`)
    await page.clickAt(target.x + offset.x, target.y + offset.y)
    return target
  }

  /** Wait for an arbitrary predicate evaluated inside the frame. */
  async function waitInFrame(expression, { timeoutMs = 8000, pollMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await frameEval(expression)
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    return null
  }

  /**
   * Reload the harness page and return once the frame has fetched the preset again.
   *
   * Scenarios that mutate the roster must not inherit each other's state. Without this, a
   * delete in one scenario left the next one clicking coordinates that had moved — the kind
   * of cross-contamination that makes a suite pass for the wrong reason.
   */
  async function reloadRig() {
    await page.send('Page.reload', { ignoreCache: false })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await page.evaluate(`(async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const f = document.getElementById('frame');
        try {
          if (f && f.contentDocument && f.contentDocument.querySelector('[data-tab="preset"]')) return true;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 150));
      }
      return false;
    })()`)
    await frameEval(`document.querySelector('[data-tab="preset"]').click()`)
    await waitInFrame(`document.querySelectorAll('.rosterItem').length > 0`, { timeoutMs: 15000 })
    // One extra beat so the first render's listeners are attached before anything is clicked.
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  // Wait until the frame has rendered its roster — i.e. its fetch to the real route landed.
  const frameReady = await page.evaluate(`(async () => {
    const f = document.getElementById('frame');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const d = f.contentDocument;
        if (d && d.querySelector('[data-tab="preset"]')) return true;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 150));
    }
    return false;
  })()`)
  check('the frame document booted', frameReady === true)

  // ---- scenario S1: the preset tab renders the real roster from disk

  currentScenario = 'S1 render'
  await frameEval(`document.querySelector('[data-tab="preset"]').click()`)
  const rosterRendered = await page.evaluate(`(async () => {
    const f = document.getElementById('frame');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const rows = f.contentDocument.querySelectorAll('.rosterItem');
      if (rows.length > 0) return rows.length;
      await new Promise(r => setTimeout(r, 150));
    }
    return 0;
  })()`)
  check('the roster rendered agent rows', rosterRendered > 0, `saw ${rosterRendered}`)

  // The roster must show what is ON DISK. A page that renders its own placeholder copy would
  // pass a "did something appear" check while lying about the store.
  const rosterText = await page.evaluate(`document.getElementById('frame').contentDocument.body.innerText`)
  for (const name of ['鹿溪', '工程搭档', '文字编辑', '临时试验']) {
    check(`the roster shows the on-disk agent ${name}`, rosterText.includes(name))
  }
  check('the roster groups are shown', rosterText.includes('默认') && rosterText.includes('写作'))

  // The "current" badge must mark the agent the STORE says is active — asserted against the
  // file, not against the page's own rendering.
  const badge = await page.evaluate(`(() => {
    const d = document.getElementById('frame').contentDocument;
    const marked = d.querySelector('.rosterItem .rosterItemActive');
    if (!marked) return null;
    const row = marked.closest('.rosterItem');
    return row ? row.getAttribute('data-agent') : null;
  })()`)
  same('the 当前 badge marks the store\'s active agent', badge, readSettings().activeAgentId)

  await shot('01-preset-tab')

  // ---- scenario S2: selecting an agent loads its FULL prompt from disk

  currentScenario = 'S2 load prompt'
  // The row's clickable label is `[data-pick]`; clicking the row itself does nothing.
  await clickInFrameUnobstructed('.rosterItem[data-agent="engineer"] [data-pick]')

  const loaded = await waitInFrame(`(() => {
    const ta = document.getElementById('presetPrompt');
    return ta && ta.value.includes('资深软件工程师') ? ta.value : null;
  })()`)
  check('the editor loaded that agent\'s prompt text', typeof loaded === 'string' && loaded.includes('资深软件工程师'),
    JSON.stringify(loaded)?.slice(0, 90))
  check('the loaded text is exactly what is on disk', loaded === readPromptFile('engineer'),
    loaded === readPromptFile('engineer') ? '' : 'the editor text differs from the file on disk')
  check('the roster marks the clicked agent as selected',
    (await frameEval(`(document.querySelector('.rosterItem[data-agent="engineer"]') || {}).getAttribute && document.querySelector('.rosterItem[data-agent="engineer"]').getAttribute('aria-selected')`)) === 'true')

  await shot('02-agent-selected')

  // ---- scenario S3: editing and saving really writes the file

  currentScenario = 'S3 save'
  const NEW_TEXT = '你是一名资深软件工程师。\n\n改代码前先读相邻代码的命名与模式；跑通测试再报完成。\n\n（审查装置写入）\n'
  // Type into the real textarea: focus it and dispatch a real `input` event with the new
  // value, which is what the page's own listener consumes.
  await page.evaluate(`(() => {
    const d = document.getElementById('frame').contentDocument;
    const ta = d.getElementById('presetPrompt');
    ta.focus();
    ta.value = ${JSON.stringify(NEW_TEXT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const dirtyState = await page.evaluate(`(() => {
    const s = document.getElementById('frame').contentDocument.getElementById('presetSaveState');
    return s ? s.textContent : null;
  })()`)
  check('the page marks the edit as unsaved before saving', dirtyState === '有未保存的改动', String(dirtyState))

  await clickInFrameUnobstructed('#presetSave')

  // Poll the FILE, not the UI: the assertion that matters is that disk changed.
  let diskWrote = false
  for (let attempt = 0; attempt < 60 && !diskWrote; attempt += 1) {
    if (readPromptFile('engineer') === NEW_TEXT) diskWrote = true
    else await new Promise((r) => setTimeout(r, 200))
  }
  check('saving wrote the new text to disk', diskWrote,
    `file is ${JSON.stringify((readPromptFile('engineer') ?? '').slice(0, 60))}`)
  // The button is re-enabled by the SUCCESS path — after `applySnapshot` and a re-render. The
  // check has to wait for that, because reading it immediately after the disk write catches
  // the page mid-flight and would report a stuck button that is not stuck.
  const saveReEnabled = await waitInFrame(
    `document.getElementById('presetSave') && document.getElementById('presetSave').disabled === false`,
    { timeoutMs: 5000 },
  )
  check('the save control is re-enabled after a successful save', saveReEnabled === true,
    'a permanently disabled save button would make the editor one-shot')
  check('the saved state is shown as saved, not as dirty',
    (await waitInFrame(`(document.getElementById('presetSaveState') || {}).textContent === '已保存'`, { timeoutMs: 4000 })) === true,
    `state reads ${JSON.stringify(await frameEval(`(document.getElementById('presetSaveState') || {}).textContent`))}`)

  await shot('03-saved')

  // ---- scenario S4: an unsaved edit is not discarded silently

  currentScenario = 'S4 unsaved guard'
  await page.evaluate(`(() => {
    const d = document.getElementById('frame').contentDocument;
    const ta = d.getElementById('presetPrompt');
    ta.value = ta.value + '\\n改动但未保存\\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  // Click a DIFFERENT agent's label; the page must ask before throwing the edit away.
  await clickInFrame('.rosterItem[data-agent="editor"] [data-pick]')

  const dialogAppeared = await page.evaluate(`(async () => {
    const d = document.getElementById('frame').contentDocument;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const scrim = d.querySelector('.dialogScrim');
      if (scrim) return { present: true, text: (scrim.textContent || '').trim().slice(0, 120) };
      await new Promise(r => setTimeout(r, 120));
    }
    return { present: false, text: '' };
  })()`)
  check('switching away from an unsaved edit raises a dialog', dialogAppeared.present === true, JSON.stringify(dialogAppeared))
  check('the dialog mentions the unsaved change', /未保存|放弃/.test(dialogAppeared.text), JSON.stringify(dialogAppeared.text))
  check('the dialog is inside the frame document, not a native modal',
    await page.evaluate(`!!document.getElementById('frame').contentDocument.querySelector('.dialogScrim')`),
    'a native confirm() would be an OS modal and would not appear in the document at all')
  check('the dialog superseded nothing — exactly one scrim is present',
    (await frameEval(`document.querySelectorAll('.dialogScrim').length`)) === 1,
    'two stacked scrims would make the lower one unreachable')

  await shot('04-unsaved-dialog')

  // Escape must close it and return focus to the page — the entire point of the in-frame
  // dialog (a native one leaves keyboard focus with the OS and kills the composer).
  //
  // The handler is a DOCUMENT-level keydown listener with capture, and it reads `event.key`.
  // Dispatching on the document is what proves the listener is registered where the page says
  // it is.
  currentScenario = 'S4b escape closes'
  await frameEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  const closed = await waitInFrame(`!document.querySelector('.dialogScrim')`, { timeoutMs: 4000 })
  check('Escape closes the dialog', closed === true)
  // Focus must come back to the frame's own document. With a native dialog the analogous
  // element is NULL and the host's composer stays dead — that was the reported bug.
  const activeTag = await frameEval(`document.activeElement ? document.activeElement.tagName : 'NULL'`)
  check('focus is returned to the frame body after closing', activeTag === 'BODY', `activeElement is ${activeTag}`)

  // Escape means CANCEL: the edit must survive. If Escape silently discarded, a user could
  // lose a long prompt by pressing the key they expected to be safe.
  const afterEscape = await page.evaluate(`(() => {
    const d = document.getElementById('frame').contentDocument;
    const ta = d.getElementById('presetPrompt');
    return { text: ta ? ta.value : null, state: (d.getElementById('presetSaveState') || {}).textContent };
  })()`)
  check('Escape cancels the discard, so the edit is still there',
    typeof afterEscape.text === 'string' && afterEscape.text.includes('改动但未保存'),
    JSON.stringify(afterEscape.text?.slice(-30)))
  check('the page still marks the edit as unsaved after cancelling',
    afterEscape.state === '有未保存的改动', String(afterEscape.state))
  check('cancelling did not switch the selection away',
    (await frameEval(`document.querySelector('.rosterItem[data-agent="engineer"]').getAttribute('aria-selected')`)) === 'true',
    'a cancelled switch must leave the original selection in place')

  // ---- scenario S4c: confirming the discard really does switch, and discards

  currentScenario = 'S4c confirm discard'
  await clickInFrame('.rosterItem[data-agent="editor"] [data-pick]')
  const discardDialog = await page.evaluate(`(async () => {
    const d = document.getElementById('frame').contentDocument;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const scrim = d.querySelector('.dialogScrim');
      if (scrim) {
        const buttons = Array.from(scrim.querySelectorAll('.dialogActions button'));
        const last = buttons[buttons.length - 1];
        const r = last.getBoundingClientRect();
        return { present: true, x: r.x + r.width / 2, y: r.y + r.height / 2, label: (last.textContent || '').trim() };
      }
      await new Promise(r => setTimeout(r, 120));
    }
    return { present: false };
  })()`)
  check('the discard dialog reappears on a second switch attempt', discardDialog.present === true)
  check('the confirm button is labelled for discarding, not for a generic OK',
    /放弃/.test(discardDialog.label ?? ''), String(discardDialog.label))

  // Real click on the dialog's confirm button.
  {
    const frameOffsetNow = await page.evaluate(`(() => {
      const r = document.getElementById('frame').getBoundingClientRect();
      return { x: r.x, y: r.y };
    })()`)
    await page.clickAt(discardDialog.x + frameOffsetNow.x, discardDialog.y + frameOffsetNow.y)
  }

  const switched = await waitInFrame(`(() => {
    const row = document.querySelector('.rosterItem[data-agent="editor"]');
    const ta = document.getElementById('presetPrompt');
    return row && row.getAttribute('aria-selected') === 'true' && ta && ta.value.includes('中文文字编辑')
      ? { selected: true, text: ta.value } : null;
  })()`)
  check('confirming the discard performs the switch', switched !== null && switched.selected === true)
  check('the discarded edit is gone and the new agent\'s text is loaded',
    switched !== null && switched.text === readPromptFile('editor'),
    JSON.stringify(switched?.text?.slice(0, 50)))

  await shot('05-discard-confirmed')

  // ---- scenario S5: activating an agent writes activeAgentId to disk

  currentScenario = 'S5 activate'
  // Fresh page: the selection starts at the store's active agent, so this scenario is not
  // reading a selection left behind by S4c.
  await reloadRig()
  await clickInFrameUnobstructed('.rosterItem[data-agent="editor"] [data-pick]')
  // Wait for the selection to actually take before reading it. The click resolves as soon as
  // the mouse events are dispatched; the page's own handler then does async work.
  const editorSelectedNow = await waitInFrame(
    `document.querySelector('.rosterItem[data-agent="editor"]').getAttribute('aria-selected') === 'true'`,
    { timeoutMs: 5000 },
  )
  check('the editor agent is the selected one', editorSelectedNow === true,
    'a stale selection here would make the activation below act on the wrong agent')
  check('activation starts from a different agent',
    readSettings().activeAgentId !== 'editor', `already ${JSON.stringify(readSettings().activeAgentId)}`)

  await clickInFrameUnobstructed('#presetActivate')

  let activeChanged = false
  for (let attempt = 0; attempt < 50 && !activeChanged; attempt += 1) {
    if (readSettings().activeAgentId === 'editor') activeChanged = true
    else await new Promise((r) => setTimeout(r, 200))
  }
  check('activating an agent wrote activeAgentId to disk', activeChanged,
    `settings says ${JSON.stringify(readSettings().activeAgentId)}`)

  // The badge is read from the re-rendered DOM, after the mutation has settled.
  //
  // WAIT FOR THE WANTED VALUE, NOT FOR "SOMETHING IS THERE". The predicate must compare against
  // 'editor' and return a BOOLEAN. An earlier version returned the agent id, which is a truthy
  // string even when it is the OLD id — so `waitInFrame` succeeded on its first poll against
  // the pre-render DOM and the rig then reported a product bug that did not exist.
  const badgeIsEditor = await waitInFrame(
    `(() => {
      const marked = document.querySelector('.rosterItem .rosterItemActive');
      const row = marked && marked.closest('.rosterItem');
      return (row ? row.getAttribute('data-agent') : null) === 'editor';
    })()`,
    { timeoutMs: 6000 },
  )
  const badgeNow = await frameEval(`(() => {
    const marked = document.querySelector('.rosterItem .rosterItemActive');
    const row = marked && marked.closest('.rosterItem');
    return row ? row.getAttribute('data-agent') : null;
  })()`)
  check('the roster now marks the editor as 当前', badgeIsEditor === true, `badge is on ${badgeNow}`)
  // Exactly one row may be marked, and it must be the active agent from the store.
  check('exactly one roster row carries the 当前 badge',
    (await frameEval(`document.querySelectorAll('.rosterItem .rosterItemActive').length`)) === 1,
    'two badges would make "which agent is active" ambiguous on screen')
  check('the badge agrees with the store, not just with the click',
    badgeNow === readStoreActive(), `badge ${JSON.stringify(badgeNow)} vs store ${JSON.stringify(readStoreActive())}`)

  // ---- scenario S6: THE POINT OF THE FEATURE — the prompt the model would receive changed

  currentScenario = 'S6 prompt follows active agent'
  const resolved = resolvedPrompt()
  const expected = readPromptFile('editor')
  check('the resolved prompt is the newly activated agent\'s text', resolved.text === expected,
    resolved.text === expected ? '' : `reader gave ${JSON.stringify(resolved.text.slice(0, 60))}`)
  check('the resolved prompt is not the previously active agent\'s text',
    resolved.text !== readPromptFile('luzzy'),
    'the switch did not take effect — this is the feature failing')

  await shot('05-activated')

  // ---- scenario S7: deleting archives the prompt instead of losing it

  currentScenario = 'S7 delete archives'
  await reloadRig()
  // Use an agent that HAS a prompt file, so the archive path is actually exercised. An agent
  // without one would prove nothing about archiving.
  check('the editor agent has a prompt file to archive', readPromptFile('editor') !== null)

  await clickInFrameUnobstructed('.rosterItem[data-agent="editor"] [data-pick]')
  const deleteReady = await waitInFrame(`!!document.getElementById('presetDelete')`, { timeoutMs: 6000 })
  check('a delete control exists for a non-default agent', deleteReady === true)

  // `#presetDelete` is expected to be hit by the DIALOG's scrim is NOT the case here: this is
  // the click that OPENS the dialog, so nothing should be over it.
  await clickInFrameUnobstructed('#presetDelete')

  // The confirmation must be answered through the real DOM, and it must promise the archive
  // rather than an unrecoverable delete — the earlier wording was wrong in both directions at
  // once (it promised deletion of a file that was never deleted).
  const deleteDialog = await waitInFrame(`(() => {
    const scrim = document.querySelector('.dialogScrim');
    return scrim ? { present: true, text: (scrim.textContent || '').trim() } : null;
  })()`, { timeoutMs: 5000 })
  check('deleting raises a confirmation', deleteDialog !== null && deleteDialog.present === true,
    JSON.stringify(deleteDialog?.text?.slice(0, 100)))
  check('the confirmation describes archiving, not an unrecoverable delete',
    /archive/.test(deleteDialog?.text ?? ''), JSON.stringify(deleteDialog?.text?.slice(0, 140)))

  await shot('06-delete-dialog')

  // Confirm with a real click on the dialog's primary button (the last one in the actions row).
  const confirmBox = await page.evaluate(`(() => {
    const d = document.getElementById('frame').contentDocument;
    const scrim = d.querySelector('.dialogScrim');
    const buttons = Array.from(scrim.querySelectorAll('.dialogActions button'));
    const ok = buttons[buttons.length - 1];
    const r = ok.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (ok.textContent || '').trim() };
  })()`)
  const frameOffsetNow = await page.evaluate(`(() => {
    const r = document.getElementById('frame').getBoundingClientRect();
    return { x: r.x, y: r.y };
  })()`)
  await page.clickAt(confirmBox.x + frameOffsetNow.x, confirmBox.y + frameOffsetNow.y)

  let goneFromRoster = false
  for (let attempt = 0; attempt < 60 && !goneFromRoster; attempt += 1) {
    if (!readSettings().agents.some((agent) => agent.id === 'editor')) goneFromRoster = true
    else await new Promise((r) => setTimeout(r, 200))
  }
  check('the agent was removed from the roster', goneFromRoster,
    `roster still has ${readSettings().agents.map((a) => a.id).join(',')}`)

  // The prompt must be MOVED, not destroyed: it has to reappear under archive/ with its text
  // intact. This is the assertion behind the dialog's promise.
  let archivedText = null
  for (let attempt = 0; attempt < 40 && archivedText === null; attempt += 1) {
    if (existsSync(archiveDir)) {
      for (const file of readdirSync(archiveDir)) {
        const body = readFileSync(join(archiveDir, file), 'utf8')
        if (body.includes('中文文字编辑')) archivedText = { file, body }
      }
    }
    if (archivedText === null) await new Promise((r) => setTimeout(r, 200))
  }
  check('the removed agent\'s prompt was archived, not destroyed', archivedText !== null,
    `archive dir ${existsSync(archiveDir) ? readdirSync(archiveDir).join(',') : '(absent)'}`)
  check('the archived prompt still has its text', archivedText !== null && archivedText.body.includes('中文文字编辑'),
    archivedText === null ? '' : archivedText.body.slice(0, 60))
  check('the agent\'s live prompt file is gone', readPromptFile('editor') === null)

  // Deleting the ACTIVE agent leaves `activeAgentId` pointing at an id that no longer exists.
  // The reader must fall back to the default AND say so — a silent fallback would send a
  // different prompt than the page claims, which is the worst kind of wrong here.
  if (readSettings().activeAgentId === 'editor') {
    const dangling = resolvedPrompt()
    check('deleting the active agent falls back to the default prompt',
      dangling.source === 'default', `source is ${dangling.source}`)
    check('the fallback is reported as a warning, not applied silently',
      dangling.warnings.some((warning) => /不在名单里/.test(warning)), JSON.stringify(dangling.warnings))
    const afterRead = readStoreActive()
    check('the store no longer advertises the deleted agent as active',
      afterRead === null, `activeAgentId is ${JSON.stringify(afterRead)}`)
  } else {
    check('the default prompt survived the delete', readPromptFile(null) !== null)
  }

  await shot('07-after-delete')

  // ---- scenario S8: no native dialogs anywhere in the frame document

  currentScenario = 'S8 no native dialogs'
  // Assert structurally, on the document the browser actually holds. This is what makes the
  // behaviour impossible rather than merely unobserved in the scenarios above.
  const nativeCallSites = await page.evaluate(`(function () {
    const html = document.getElementById('frame').srcdoc || '';
    const found = [];
    const re = /(^|[^.\\w$])(alert|confirm|prompt)\\s*\\(/g;
    let m;
    while ((m = re.exec(html)) !== null) found.push(m[2]);
    return found;
  })()`)
  same('the frame document contains no native dialog call site', JSON.stringify(nativeCallSites), '[]')

  // ---- scenario S9: the page degrades honestly when DSH services are absent

  currentScenario = 'S9 honest degradation'
  await reloadRig()
  const degradation = await frameEval(`document.body.innerText`)
  // `ctx.get()` returns undefined for agents/agentPresets/sessionController here, so the
  // snapshot reports those capabilities false. The page must SAY the switch is unavailable
  // rather than render a working-looking button that cannot work.
  check('the page explains that the session preset switch is unavailable',
    /无法|不可用|不能/.test(degradation),
    `the page never says the switch cannot work: ${JSON.stringify(degradation.slice(0, 160))}`)
  check('the page does not claim a session preset switch it cannot perform',
    !/已切到 LuzzyMode/.test(degradation))
  check('the page says the prompt editor still works despite that',
    /提示词/.test(degradation), 'a dead end with no alternative is a worse answer than a partial one')

  await shot('08-degraded')

  // ---- scenario S10: hostile prompt text survives the round trip

  currentScenario = 'S10 hostile prompt text'
  // Every character class that would break a naive prompt pipeline: a prompt reference, a
  // template interpolation, a backtick, an escaped newline, and real newlines.
  const HOSTILE = '包含 {{未知引用}} 与 ${not_a_var} 与 `反引号` 与 \\n 字面量\n第二行\n'

  await clickInFrameUnobstructed('.rosterItem[data-agent="engineer"] [data-pick]')
  const loadedEngineer = await waitInFrame(`(() => {
    const ta = document.getElementById('presetPrompt');
    return ta && ta.value.includes('资深软件工程师') ? ta.value : null;
  })()`, { timeoutMs: 6000 })
  check('the engineer agent is selected before the hostile edit', loadedEngineer !== null,
    'the selection did not take, so the save below would target the wrong agent')

  await page.evaluate(`(() => {
    const d = document.getElementById('frame').contentDocument;
    const ta = d.getElementById('presetPrompt');
    ta.focus();
    ta.value = ${JSON.stringify(HOSTILE)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await clickInFrameUnobstructed('#presetSave')

  let hostileSaved = false
  for (let attempt = 0; attempt < 60 && !hostileSaved; attempt += 1) {
    if (readPromptFile('engineer') === HOSTILE) hostileSaved = true
    else await new Promise((r) => setTimeout(r, 200))
  }
  check('a prompt containing prompt-syntax characters is stored verbatim', hostileSaved,
    `file is ${JSON.stringify((readPromptFile('engineer') ?? '').slice(0, 70))}`)

  // And the reader must hand it back unchanged — no escaping, no truncation, no re-scan.
  //
  // WHICH AGENT'S PROMPT THE READER RESOLVES depends on `activeAgentId`, which S5 set to the
  // editor. Reading "the active prompt" and comparing it to engineer.md would therefore fail
  // on correct behaviour. So the assertion activates the engineer first — which also makes it
  // a stronger test: the hostile text has to travel through BOTH the store and the reader that
  // the preset row uses.
  await clickInFrameUnobstructed('.rosterItem[data-agent="engineer"] [data-pick]')
  await clickInFrameUnobstructed('#presetActivate')
  let engineerActive = false
  for (let attempt = 0; attempt < 30 && !engineerActive; attempt += 1) {
    if (readStoreActive() === 'engineer') engineerActive = true
    else await new Promise((r) => setTimeout(r, 200))
  }
  check('the engineer agent could be activated before reading its prompt', engineerActive === true,
    `activeAgentId is ${JSON.stringify(readStoreActive())}`)

  const hostileResolved = resolvedPrompt()
  check('the reader returns hostile text byte-for-byte', hostileResolved.text === readPromptFile('engineer'),
    `reader ${JSON.stringify(hostileResolved.text.slice(0, 70))}`)
  check('the reader reports it came from an agent file, not a fallback',
    hostileResolved.source === 'agent', `source is ${hostileResolved.source}`)
  check('the reader raised no warning about the hostile text',
    Array.isArray(hostileResolved.warnings) && hostileResolved.warnings.length === 0,
    JSON.stringify(hostileResolved.warnings))

  // The page must render it back into the editor without losing anything either.
  const hostileRendered = await waitInFrame(`(() => {
    const ta = document.getElementById('presetPrompt');
    return ta && ta.value.includes('{{未知引用}}') ? ta.value : null;
  })()`, { timeoutMs: 5000 })
  same('the editor still holds the hostile text after saving', hostileRendered, HOSTILE)

  await shot('09-hostile-text')

  // ---- scenario S12: the new-session button, and the deployment without session services

  // WHY THIS SCENARIO EXISTS, AND WHAT IT CAN HONESTLY ASSERT HERE
  //
  // The button is rendered only when the snapshot reports `capabilities.newSession !== false`
  // (src/client.js `sessionBlockHtml`), and this rig's deployment has NO session service — so
  // the button is CORRECTLY ABSENT and there is nothing to click. Pretending to drive it would
  // be the worst thing this file could do.
  //
  // Two things are therefore asserted instead, and both are real:
  //   * the button is absent BECAUSE the capability is absent, together with the page saying so
  //   * no create-session request is ever sent when there is nothing that could serve it
  //
  // The click path itself (`newSessionInFlight`, the create handshake, the typed reply) is
  // covered where it can actually run: the static chain audit checks the message contract, and
  // real-machine acceptance is the only place a real create can happen. That gap is stated in
  // the report rather than papered over.
  currentScenario = 'S12 no session service'
  await reloadRig()

  const capabilityState = await frameEval(`(() => {
    const button = document.getElementById('presetSwitch');
    return {
      hasNew: !!document.getElementById('presetNew'),
      hasSwitch: button !== null,
      switchDisabled: button ? button.disabled === true : null,
      switchLabel: button ? (button.textContent || '').trim() : null,
      body: document.body.innerText.slice(0, 500),
    };
  })()`)
  check('the new-session button is withheld when the deployment cannot create sessions',
    capabilityState.hasNew === false,
    'rendering it would offer an action that cannot work')

  // The SWITCH button has a DIFFERENT condition and is genuinely present here — this was
  // checked against the snapshot rather than guessed:
  //   `sessionBlockHtml` renders it when the session is known and its preset differs from
  //   LuzzyMode. The shell reports a session with `preset: null`, which differs, so the button
  //   renders — and `readSessionFacts` then reports `canSwitchToLuzzy: false`, so it renders
  //   DISABLED with a stated reason. That is the correct behaviour: the action is visible and
  //   explained, rather than silently missing.
  check('the switch button is rendered for a session that is not yet on LuzzyMode',
    capabilityState.hasSwitch === true)
  check('the switch button is disabled, because this deployment cannot switch it',
    capabilityState.switchDisabled === true,
    `disabled=${JSON.stringify(capabilityState.switchDisabled)}`)
  check('the page states WHY the switch is unavailable',
    /没有运行中的 agent|无法切换|没有提供预设服务/.test(capabilityState.body),
    `the page gives no reason: ${JSON.stringify(capabilityState.body.slice(0, 200))}`)
  check('a disabled switch button still says what it would do',
    capabilityState.switchLabel !== null && /LuzzyMode/.test(capabilityState.switchLabel),
    JSON.stringify(capabilityState.switchLabel))

  const createsBefore = await page.evaluate(`(window.__rigMessages || []).filter(m => m.type === 'create-session').length`)
  same('no create-session request is sent when no service can serve it', createsBefore, 0)

  // ---- scenario S13: the session handshake, and that a create reply cannot clobber the id

  // The bug this guards against: the frame accepted ANY message from the host half as its
  // session answer, so the reply to a create request (which carries no sessionId) was read as
  // "your session is null". The page then fetched state for a session that does not exist.
  //
  // This is the scenario that closes the hole found by fault injection: a patch removing the
  // `data.type !== 'session'` guard used to pass the entire rig, because nothing exercised the
  // message channel after the handshake.
  currentScenario = 'S13 session handshake'
  const handshakeCount = await page.evaluate(`(window.__rigMessages || []).filter(m => m.type === 'want-session').length`)
  check('the frame asked the shell for its session id', handshakeCount >= 1,
    `saw ${handshakeCount} want-session message(s)`)

  // Deliver a host message of a DIFFERENT type carrying no sessionId — the exact shape of the
  // create reply that used to null the id.
  await frameEval(`window.dispatchEvent(new MessageEvent('message', {
    data: { source: 'luzzy-page-host', type: 'session-created', ok: true },
    source: window.parent
  }))`)

  // Then ask the shell for a FRESH session answer and confirm the frame still uses the real id.
  // If the unrelated message had been adopted as the answer, the id would now be null.
  await page.evaluate(`(() => {
    const f = document.getElementById('frame');
    f.contentWindow.postMessage({ source: 'luzzy-page-frame', type: 'want-session' }, '*');
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 800))

  const presetRequests = await page.evaluate(`fetch('/rig-requests').then(r => r.json())`)
  const presetGets = presetRequests.filter((entry) => entry.startsWith('GET /__luzzy/preset'))
  const presetPuts = presetRequests.filter((entry) => entry.startsWith('POST /__luzzy/preset'))
  // Only GETs carry the session in the URL; the POSTs carry it in the body. Checking the POST
  // URLs for a sessionId was wrong and reported the nulling-bug signature against a page that
  // did not have it.
  check('every preset GET carried the real session id',
    presetGets.length > 0 && presetGets.every((entry) => entry.includes('sessionId=session-rig-1')),
    `GETs seen: ${JSON.stringify(presetGets)}`)
  check('no preset GET was made without a session id',
    presetGets.filter((entry) => !entry.includes('sessionId=')).length === 0,
    'an unparameterised preset GET is the signature of the nulling bug')
  check('the page made at least one preset POST while working', presetPuts.length > 0,
    'no POST would mean the editor never asked for or wrote a prompt')

  // And the reload after the hostile message must still work — proving the id survived.
  await reloadRig()
  check('the page still renders its roster after an unrelated host message',
    (await waitInFrame(`document.querySelectorAll('.rosterItem').length > 0`, { timeoutMs: 10000 })) === true,
    'the nulling bug left the page fetching state for a session that does not exist')

  // ---- scenario S14: the Markdown toolbar and the preview, driven by real clicks
  //
  // The static suite proves the transform functions are correct in isolation; this proves the
  // BUTTONS are wired to them and that the preview actually renders into the DOM. Those are
  // different failures: a toolbar can have perfect logic and a broken click handler, which is
  // exactly what a static assertion cannot see.
  currentScenario = 'S14 markdown toolbar'
  await reloadRig()
  await clickInFrameUnobstructed('.rosterItem[data-agent="engineer"] [data-pick]')
  await waitInFrame(`document.getElementById('presetPrompt') !== null`, { timeoutMs: 10000 })

  check('the markdown toolbar is rendered', (await frameEval(`document.querySelectorAll('[data-md]').length`)) >= 16,
    `saw ${await frameEval(`document.querySelectorAll('[data-md]').length`)} buttons`)
  check('the toolbar groups are divided', (await frameEval(`document.querySelectorAll('.mdDivider').length`)) >= 6)
  check('every toolbar button is an icon or a short text glyph',
    (await frameEval(`Array.from(document.querySelectorAll('[data-md]')).every(function (b) { return b.querySelector('svg') !== null || (b.textContent || '').trim().length <= 3 })`)) === true)
  check('every toolbar button has an accessible name',
    (await frameEval(`Array.from(document.querySelectorAll('[data-md]')).every(function (b) { return (b.getAttribute('aria-label') || '').length > 0 })`)) === true)
  check('the mode picker is rendered', (await frameEval(`document.getElementById('presetModeBtn') !== null`)) === true)
  check('the editor starts in LIVE preview by default',
    (await frameEval(`document.getElementById('presetArea').dataset.mode`)) === 'live')
  // ONE surface, not two: the reference prompt editor has no split view.
  check('there is exactly one writing surface',
    (await frameEval(`document.querySelectorAll('#presetArea textarea').length`)) === 1,
    `saw ${await frameEval(`document.querySelectorAll('#presetArea textarea').length`)} textarea(s)`)

  // ---- live mode IS the rendered document, and it is editable
  //
  // This is the whole point of the mode: the Markdown markers are gone, the formatting is real,
  // and the caret goes into that formatted view rather than into raw text.
  check('live mode shows the rendered surface',
    (await frameEval(`getComputedStyle(document.getElementById('presetVisual')).display`)) !== 'none')
  check('live mode hides the raw textarea',
    (await frameEval(`getComputedStyle(document.getElementById('presetPrompt')).display`)) === 'none')
  check('the rendered surface is editable in live mode',
    (await frameEval(`document.getElementById('presetVisual').getAttribute('contenteditable')`)) === 'true')

  // The rendered-content checks live BELOW, after the rich sample is seeded: asserting that a
  // table renders against a store whose prompt is a single plain line would fail for a reason
  // that has nothing to do with the code under test.
  check('the live view carries no raw markdown markers',
    (await frameEval(`document.getElementById('presetVisual').textContent.indexOf('**') === -1`)) === true,
    'markers must be gone in the rendered view, not merely dimmed')

  // ---- the toolbar, driven in SOURCE mode
  //
  // The toolbar's transforms are string operations, so they act on the textarea — which is the
  // visible surface in source mode. Driving them from live mode would test a button against a
  // hidden element; the live-mode path (type into the rendered view, write back to Markdown) is
  // covered separately below, which is where that behaviour actually belongs.
  await clickInFrameUnobstructed('#presetModeBtn')
  await clickInFrameUnobstructed('.mdMenuItem[data-mode="source"]')

  await frameEval(`(() => {
    const t = document.getElementById('presetPrompt');
    t.value = 'hello world';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.focus();
    t.setSelectionRange(0, 5);
    return true;
  })()`)
  await clickInFrameUnobstructed('[data-md="bold"]')
  const bolded = await frameEval(`document.getElementById('presetPrompt').value`)
  check('clicking 加粗 wraps the selected text', bolded === '**hello** world', JSON.stringify(bolded))
  check('the toolbar click keeps focus in the textarea',
    (await frameEval(`document.activeElement && document.activeElement.id`)) === 'presetPrompt',
    `activeElement is ${await frameEval(`document.activeElement && document.activeElement.id`)}`)
  check('the toolbar marks the prompt dirty',
    (await frameEval(`document.getElementById('presetSaveState').dataset.kind`)) === 'dirty')

  // Press it again on the same selection: the round trip must undo it.
  await clickInFrameUnobstructed('[data-md="bold"]')
  check('clicking 加粗 again removes the markers',
    (await frameEval(`document.getElementById('presetPrompt').value`)) === 'hello world',
    JSON.stringify(await frameEval(`document.getElementById('presetPrompt').value`)))

  // A heading level, applied through the real button.
  await frameEval(`(() => {
    const t = document.getElementById('presetPrompt');
    t.value = 'Title';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.focus();
    t.setSelectionRange(0, 5);
    return true;
  })()`)
  await clickInFrameUnobstructed('[data-md="h2"]')
  check('clicking H2 prefixes the line',
    (await frameEval(`document.getElementById('presetPrompt').value`)) === '## Title',
    JSON.stringify(await frameEval(`document.getElementById('presetPrompt').value`)))
  // Changing LEVEL must replace the marker, not remove the heading. The naive toggle made
  // this delete the heading instead, which is the opposite of what the button says.
  await clickInFrameUnobstructed('[data-md="h3"]')
  check('clicking H3 changes the level instead of clearing it',
    (await frameEval(`document.getElementById('presetPrompt').value`)) === '### Title',
    JSON.stringify(await frameEval(`document.getElementById('presetPrompt').value`)))

  // The active tint is read from the caret's line, so it must light up on real state.
  check('the H3 button reports itself active on a level-3 heading',
    (await frameEval(`document.querySelector('[data-md="h3"]').dataset.on`)) === 'true')
  check('the H2 button reports itself inactive on a level-3 heading',
    (await frameEval(`document.querySelector('[data-md="h2"]').dataset.on`)) === 'false')

  // ---- typing INTO the rendered view writes back to the Markdown
  //
  // THE RISKY DIRECTION, driven for real: the user types into the formatted document and the
  // Markdown that the model will receive has to gain that text. A silent loss here would change
  // the system prompt without telling anyone.
  await frameEval(`(() => {
    const t = document.getElementById('presetPrompt');
    // Several PARAGRAPHS, because the regression this scenario guards is precisely about
    // reaching the paragraph you click on. One short paragraph would hide it. Bold and italic
    // ride inside a paragraph rather than occupying their own block, so both are covered.
    t.value = '## Heading\\n\\n第一段 paragraph one.\\n\\n**bold** and *italic*\\n\\n第三段 paragraph three.\\n\\n- one\\n\\n> quote';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  // Enter live mode so the visual surface is re-rendered from that Markdown.
  await clickInFrameUnobstructed('#presetModeBtn')
  await clickInFrameUnobstructed('.mdMenuItem[data-mode="live"]')
  check('entering live mode re-rendered the document from the Markdown',
    (await frameEval(`document.getElementById('presetVisual').querySelector('h2') !== null`)) === true)

  // NOW the rich constructs are in the document, so they can be asserted.
  const rendered = await frameEval(`(() => {
    const v = document.getElementById('presetVisual');
    return {
      markers: v.textContent.indexOf('##') !== -1 || v.textContent.indexOf('**') !== -1,
      strong: v.querySelector('strong') !== null,
      em: v.querySelector('em') !== null,
      li: v.querySelector('li') !== null,
      quote: v.querySelector('blockquote') !== null,
    };
  })()`)
  check('the rendered view has NO markdown markers in its text', rendered.markers === false,
    'markers must be gone, not merely dimmed — that is what makes it a rendered view')
  check('the rendered view shows real bold', rendered.strong === true)
  check('the rendered view shows real italic', rendered.em === true)
  check('the rendered view shows a real list', rendered.li === true)
  check('the rendered view shows a real quote', rendered.quote === true)

  // ---- REAL input: a real click places the caret, real keys type into it.
  //
  // THIS REPLACES A SYNTHETIC INSERT, AND THAT REPLACEMENT IS THE POINT.
  //
  // The previous version focused the surface, built a Range programmatically, and inserted with
  // `execCommand`. It passed — while the editor was in fact UNUSABLE: a real click on any block
  // bubbled to the area's own mode handler, which re-rendered and re-focused the surface and
  // reset the caret to position 0. The user found it ("输入时始终顶格 无法编辑其他段落") and this
  // rig had reported 150/150 green. A synthetic insert can succeed inside a surface no user can
  // actually type in, so it proves nothing about editing. Only real input counts.
  //
  // The click is dispatched at coordinates and hit-tested, because that is what a mouse does —
  // and the caret's POSITION is asserted, not merely that a character arrived somewhere.

  const beforeClick = await frameEval(`(() => {
    const v = document.getElementById('presetVisual');
    const ps = Array.from(v.querySelectorAll('p'));
    return { paragraphs: ps.length, texts: ps.map((p) => p.textContent) };
  })()`)
  check('the rendered view has paragraphs to click into', beforeClick.paragraphs >= 2,
    JSON.stringify(beforeClick))

  // Click the SECOND paragraph's own body, past its first characters, so a caret anywhere else
  // is detectable rather than accidentally matching.
  const paragraphPoint = await frameEval(`(() => {
    const v = document.getElementById('presetVisual');
    const p = v.querySelectorAll('p')[1];
    const r = p.getBoundingClientRect();
    const x = r.x + 40, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x: x, y: y, hitTag: hit ? hit.tagName : null, inside: hit ? (v.contains(hit) || hit === v) : false };
  })()`)
  check('the click point lands on the paragraph itself', paragraphPoint.hitTag === 'P' && paragraphPoint.inside === true,
    JSON.stringify(paragraphPoint))

  const frameOrigin = await page.evaluate(`(() => {
    const r = document.getElementById('frame').getBoundingClientRect();
    return { x: r.x, y: r.y };
  })()`)
  await page.clickAt(paragraphPoint.x + frameOrigin.x, paragraphPoint.y + frameOrigin.y)
  await new Promise((resolve) => setTimeout(resolve, 300))

  const caretAfterClick = await frameEval(`(() => {
    const v = document.getElementById('presetVisual');
    const sel = document.defaultView.getSelection();
    const anchor = sel ? sel.anchorNode : null;
    const ps = Array.from(v.querySelectorAll('p'));
    let node = anchor, index = null;
    while (node && node !== v) { if (ps.indexOf(node) >= 0) { index = ps.indexOf(node); break } node = node.parentNode }
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    let fromStart = null;
    if (r) { r.selectNodeContents(v); r.setEnd(sel.anchorNode, sel.anchorOffset); fromStart = r.toString().length }
    return { paragraphIndex: index, charsBefore: fromStart,
             anchorText: anchor ? String(anchor.nodeValue || '').slice(0, 20) : null };
  })()`)
  // THE REGRESSION THIS EXISTS FOR: the click must put the caret in the paragraph that was
  // clicked, at a position inside it — not at the start of the document.
  check('the click places the caret in the paragraph that was clicked',
    caretAfterClick.paragraphIndex === 1, JSON.stringify(caretAfterClick))
  check('the caret is NOT forced back to the very start',
    typeof caretAfterClick.charsBefore === 'number' && caretAfterClick.charsBefore > 0,
    `chars before caret: ${caretAfterClick.charsBefore}`)

  // Real keystrokes, dispatched to the frame's session, with NO focus() call in between:
  // calling focus would destroy the very caret this scenario is measuring.
  for (const char of 'XY') {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
  await new Promise((resolve) => setTimeout(resolve, 400))

  const afterTyping = await frameEval(`(() => {
    const v = document.getElementById('presetVisual');
    return Array.from(v.querySelectorAll('p')).map((p) => p.textContent);
  })()`)
  // Typed text must land in the paragraph that was clicked — the user's exact complaint.
  check('typed text lands in the clicked paragraph, not the first block',
    typeof afterTyping[1] === 'string' && afterTyping[1].includes('XY'),
    JSON.stringify(afterTyping))

  // And a second click must MOVE the caret to another paragraph.
  const secondPoint = await frameEval(`(() => {
    const v = document.getElementById('presetVisual');
    const ps = Array.from(v.querySelectorAll('p'));
    const p = ps[2];
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  })()`)
  if (secondPoint !== null) {
    await page.clickAt(secondPoint.x + frameOrigin.x, secondPoint.y + frameOrigin.y)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const caretAfterSecond = await frameEval(`(() => {
      const v = document.getElementById('presetVisual');
      const sel = document.defaultView.getSelection();
      const anchor = sel ? sel.anchorNode : null;
      const ps = Array.from(v.querySelectorAll('p'));
      let node = anchor, index = null;
      while (node && node !== v) { if (ps.indexOf(node) >= 0) { index = ps.indexOf(node); break } node = node.parentNode }
      return index;
    })()`)
    check('a second click moves the caret to another paragraph', caretAfterSecond === 2,
      `caret paragraph index: ${caretAfterSecond}`)
  }

  const writtenBack = await frameEval(`(() => ({
    text: document.getElementById('presetPrompt').value,
    dirty: document.getElementById('presetSaveState').dataset.kind,
  }))()`)
  // The textarea is the record of what will be saved, so the typed characters must be in it,
  // and the structure around them must survive the round trip.
  check('typing in the rendered view reaches the Markdown', writtenBack.text.includes('XY'),
    JSON.stringify(writtenBack.text.slice(0, 200)))
  check('the typed edit marks the prompt dirty', writtenBack.dirty === 'dirty', String(writtenBack.dirty))
  check('the heading survived the write-back', writtenBack.text.includes('## Heading'),
    JSON.stringify(writtenBack.text.slice(0, 200)))
  check('the bold survived the write-back', writtenBack.text.includes('**bold**'),
    JSON.stringify(writtenBack.text.slice(0, 200)))
  check('the quote survived the write-back', writtenBack.text.includes('> quote'),
    JSON.stringify(writtenBack.text.slice(0, 200)))

  check('the character count is shown in the status line',
    (await frameEval(`document.getElementById('presetCount').textContent`)).startsWith('字符：'))

  // ---- the mode menu
  await clickInFrameUnobstructed('#presetModeBtn')
  check('the mode menu opens',
    (await frameEval(`document.getElementById('presetModeMenu').hidden`)) === false)
  check('the menu reports the current mode to assistive tech',
    (await frameEval(`document.querySelector('.mdMenuItem[data-mode="live"]').getAttribute('aria-checked')`)) === 'true')

  await clickInFrameUnobstructed('.mdMenuItem[data-mode="source"]')
  check('choosing source mode switches the area',
    (await frameEval(`document.getElementById('presetArea').dataset.mode`)) === 'source')
  check('source mode hides the rendered surface',
    (await frameEval(`getComputedStyle(document.getElementById('presetVisual')).display`)) === 'none')
  check('source mode shows the raw Markdown',
    (await frameEval(`getComputedStyle(document.getElementById('presetPrompt')).display`)) !== 'none')
  check('source mode shows the markers', (await frameEval(`document.getElementById('presetPrompt').value`)).includes('##'))
  check('the mode label follows the choice',
    (await frameEval(`document.getElementById('presetModeLabel').textContent`)) === '源码模式')
  check('the menu closes after a choice',
    (await frameEval(`document.getElementById('presetModeMenu').hidden`)) === true)

  await clickInFrameUnobstructed('#presetModeBtn')
  await clickInFrameUnobstructed('.mdMenuItem[data-mode="reading"]')
  check('reading mode hides the writing surface',
    (await frameEval(`getComputedStyle(document.getElementById('presetPrompt')).display`)) === 'none')
  check('reading mode shows the rendered document',
    (await frameEval(`getComputedStyle(document.getElementById('presetVisual')).display`)) !== 'none')
  check('reading mode makes the document immutable',
    (await frameEval(`document.getElementById('presetVisual').getAttribute('contenteditable')`)) === 'false')

  // The write-back is asserted STRUCTURALLY, on every block kind in the sample — this is the
  // direction that can lose content, and a lost block would otherwise only show up as a
  // strangely short prompt on the next run.
  const afterEdit = await frameEval(`document.getElementById('presetPrompt').value`)
  check('the write-back kept the heading marker', afterEdit.includes('## Heading'), JSON.stringify(afterEdit))
  check('the write-back kept bold', afterEdit.includes('**bold**'), JSON.stringify(afterEdit))
  check('the write-back kept italic', afterEdit.includes('*italic*'), JSON.stringify(afterEdit))
  check('the write-back kept the list item', afterEdit.includes('- one'), JSON.stringify(afterEdit))
  check('the write-back kept the blockquote', afterEdit.includes('> quote'), JSON.stringify(afterEdit))
  // Six blocks in, six blocks out: heading, three paragraphs, a list item, a quote. The count is
  // asserted because a DROPPED block is otherwise invisible — the prompt would simply be
  // shorter, and nothing would say so.
  //
  // The count is taken INSIDE the frame and returned as a number: writing the split in the
  // evaluate string would have to survive this file's own escaping, and a mis-escaped newline
  // makes the assertion silently wrong rather than failing loudly.
  const writtenBlocks = await frameEval(`document.getElementById('presetPrompt').value
    .split(String.fromCharCode(10)).filter(function (l) { return l.trim() !== '' }).length`)
  check('the write-back kept every block', writtenBlocks === 6,
    `${writtenBlocks} blocks: ${JSON.stringify(afterEdit)}`)

  const previewHtml = await frameEval(`document.getElementById('presetVisual').innerHTML`)
  check('the rendered document shows a heading', previewHtml.includes('<h2>Heading</h2>'), previewHtml.slice(0, 200))
  check('the rendered document shows bold', previewHtml.includes('<strong>bold</strong>'))
  check('the rendered document shows italic', previewHtml.includes('<em>italic</em>'))
  check('the rendered document shows a list', previewHtml.includes('<li>one</li>'))
  // Reading mode renders the same document but must not accept edits — that is the difference
  // between reading and live, and the only difference.
  check('the rendered document contains no editable control',
    (await frameEval(`document.querySelectorAll('#presetVisual textarea, #presetVisual input').length`)) === 0)
  check('the text survived the mode round trip',
    (await frameEval(`document.getElementById('presetPrompt').value`)).includes('## Heading'))

  // A fresh load must start in live mode. This is why visibility rides the area's data-mode
  // rather than a hidden attribute toggled after render: the two would drift on re-render.
  await reloadRig()
  check('after a reload the editor is back in LIVE mode by default',
    (await frameEval(`document.getElementById('presetArea').dataset.mode`)) === 'live')

  // ---- scenario S11: no uncaught errors anywhere in the run

  currentScenario = 'S11 console clean'
  // No filtering: the rig serves /favicon.ico so there is no browser-generated 404 to excuse.
  // Any error here is a real fault in the code under test.
  const pageErrors = page.errors()
  const consoleErrors = page.consoleMessages()
    .filter((message) => message.type === 'error')
    .map((message) => message.text)

  check('no uncaught page errors during the whole run', pageErrors.length === 0,
    JSON.stringify(pageErrors).slice(0, 400))
  check('no console errors during the whole run', consoleErrors.length === 0,
    JSON.stringify(consoleErrors).slice(0, 400))

  // "No errors" must not be the result of the page never running. The frame reports its own
  // stages to /__luzzy/diag; assert those reports actually happened, so a silent no-op cannot
  // masquerade as a clean run. (`diag.jsonl` is written by the real host route.)
  const diagLines = existsSync(join(diagDir, 'diag.jsonl'))
    ? readFileSync(join(diagDir, 'diag.jsonl'), 'utf8').trim().split('\n').filter((line) => line !== '')
    : []
  const stages = new Set(diagLines.map((line) => { try { return JSON.parse(line).stage } catch { return null } }))
  check('the frame reported its own boot and a successful preset fetch',
    stages.has('frame-boot') && stages.has('preset-fetch-ok'),
    `stages seen: ${[...stages].filter(Boolean).sort().join(', ') || '(none)'}`)
} catch (error) {
  failures.push(`[${currentScenario}] rig threw: ${error.message}`)
  console.log(`!! rig threw during ${currentScenario}: ${error.stack ?? error.message}`)
} finally {
  // Teardown in the reverse order of construction, and never throwing: an error here would
  // hide the rig's actual findings.
  if (launcher !== null) {
    const result = await shutdown({ child: launcher.child, profile: launcher.profile, session })
    notes.push(`       browser closed via ${result.closed}; profile removed: ${result.profileRemoved}`)
  }
  try { await new Promise((resolve) => serverWithHarness.close(resolve)) } catch { /* already closed */ }
  for (const dispose of disposers) {
    try { if (typeof dispose === 'function') dispose() } catch { /* best effort */ }
  }

  // The temp DSH home is removed on success. On failure it is kept and its path printed,
  // because the store is usually the evidence for whatever went wrong.
  const failed = failures.length > 0
  if (!failed) {
    try { rmSync(dshHome, { recursive: true, force: true }) } catch { /* OS reclaims it */ }
    try { rmSync(diagDir, { recursive: true, force: true }) } catch { /* OS reclaims it */ }
  }
}

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log('')

if (shots.length > 0) {
  console.log('screenshots:')
  for (const entry of shots) console.log(`  ${entry.name.padEnd(22)} ${entry.sha256.slice(0, 16)}  ${entry.bytes} B  ${entry.file}`)
  const distinct = new Set(shots.map((entry) => entry.sha256))
  console.log(`  ${shots.length} shot(s), ${distinct.size} distinct`)
  if (distinct.size !== shots.length) {
    console.log('  WARNING — identical screenshots mean the interactions did not change the page (AGENTS.md §5.7)')
  }
  console.log('')
}

console.log(`preset rig: ${checks - failures.length} of ${checks} checks passed`)
if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
  console.log(`\nthe temp store was kept for inspection: ${dshHome}`)
  process.exit(1)
}
console.log('PASS — the preset sub-page works end to end against the real routes')
console.log(`  store used: ${dshHome} (removed)`)

// `keepGoing` is accepted for symmetry with the other suites; this rig runs every scenario
// regardless, so its only effect is to suppress the throw-on-first-failure habit.
void keepGoing
