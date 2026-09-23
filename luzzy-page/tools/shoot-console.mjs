/**
 * Browser acceptance for the Luzzy console: shoot every page and measure it.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SUITES
 *
 * The suites prove structure and behaviour from the built artifact. They cannot prove the page
 * LOOKS right, and on this machine they cannot prove it renders at all — an undefined namespace
 * or a layout that overflows is invisible to a string assertion. This drives a real browser:
 * real layout, real CSS, real rendering.
 *
 * It reports per page:
 *   * a screenshot (so a human can look, which is the point)
 *   * `scrollWidth === innerWidth` — horizontal overflow is the most common real layout defect
 *     in this frame, and it is measurable rather than a matter of taste
 *   * how many cards / badges / timeline rows / tree branches rendered, which distinguishes
 *     "it painted" from "it painted an empty state"
 *   * console errors and uncaught exceptions from inside the frame
 *
 * The fixtures and the route stub live in tools/acceptance-harness.mjs, because the scrolled
 * shooter needs the same ones.
 *
 * Usage: node tools/shoot-console.mjs [--theme light|dark] [--out dir] [--page id] [--width n]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFrameBuilder, compileFrameScript, PLUGIN_ROOT } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, sleep } from './acceptance-harness.mjs'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const THEME = argValue('--theme', 'light')
const OUT_DIR = argValue('--out', join(PLUGIN_ROOT, 'docs', 'shots'))
const ONLY = argValue('--page', null)
/** Real narrow viewports need CDP device metrics: Windows refuses a window below ~492px. */
const WIDTH = Number(argValue('--width', '1280'))
const HEIGHT = Number(argValue('--height', '900'))

mkdirSync(OUT_DIR, { recursive: true })

// The frame must compile before it is worth pointing a browser at it. This repeats the build
// gate on purpose: this tool can be run against a stale artifact.
const { srcDoc } = loadFrameBuilder()
const compile = compileFrameScript(srcDoc)
if (!compile.ok) {
  console.error(`the shipped frame does not compile — nothing to shoot:\n${compile.error}${compile.context}`)
  process.exit(1)
}

const hostPath = writeHostPage(frameWithStub(THEME), { width: WIDTH, height: HEIGHT, theme: THEME, label: 'console' })

const PAGES = [
  { id: 'overview', label: '总览' },
  { id: 'goal', label: '目标中心' },
  { id: 'runtime', label: '执行状态' },
  { id: 'agent', label: 'Agent 配置' },
  { id: 'system', label: '系统信息' },
  { id: 'preset', label: '预设' },
  { id: 'readme', label: '插件说明' },
].filter((page) => ONLY === null || page.id === ONLY)

// The launcher only starts the process; attach() opens the socket and owns openTarget.
const launcher = await launchEdge({ headless: true, windowSize: { width: WIDTH, height: HEIGHT } })
const session = await attach({ port: launcher.port })
const page_ = await session.openTarget(`file:///${hostPath.replace(/\\/g, '/')}`)

const results = []
try {
  const booted = await page_.waitFor('#frame', { timeoutMs: 15_000 })
  if (!booted) throw new Error('the iframe never appeared')
  await sleep(1500)

  for (const page of PAGES) {
    // Click the tab INSIDE the frame, then wait for the fetch to settle. Reading immediately
    // reports "blank page" for a page that is simply still loading.
    const clicked = await page_.evaluate(`(${IN_FRAME})((doc) => {
      const button = doc.querySelector('[data-tab="${page.id}"]');
      if (!button) return 'no-tab';
      button.click();
      return 'clicked';
    })`)

    // Wait for content rather than sleeping a fixed amount: the fetch is asynchronous, and a
    // fixed delay is a guess that turns into a flaky "blank" report.
    let probe = null
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(250)
      probe = await page_.evaluate(`(${IN_FRAME})((doc, win) => {
        const content = doc.getElementById('content');
        if (!content) return { error: 'the frame has no #content container' };
        const cards = content.querySelectorAll('.card');
        const visible = [...cards].filter((c) => c.offsetParent !== null);
        const root = doc.documentElement;
        // Anything reaching past the viewport, allowing 2px of subpixel rounding.
        const overflowing = [...doc.querySelectorAll('*')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > win.innerWidth + 2 || r.left < -2);
        }).slice(0, 5).map((el) => (typeof el.className === 'string' && el.className) || el.tagName);
        return {
          clicked: ${JSON.stringify(clicked)},
          cards: cards.length,
          visibleCards: visible.length,
          heading: (content.querySelector('h3') || {}).textContent || '',
          text: (content.textContent || '').trim().slice(0, 160),
          contentLength: content.innerHTML.length,
          contentChildren: content.children.length,
          // The full error text when a page failed to render. The on-screen detail is clipped at
          // the container width, so reading it back from the DOM loses the line number — and a
          // line number is the only thing that makes a stack trace useful.
          failure: (content.querySelector('.statusDetail code') || {}).textContent || '',
          scrollWidth: root.scrollWidth,
          innerWidth: win.innerWidth,
          overflowing: overflowing,
          routes: (win.__stubRoutes || []).length,
          emptyStates: content.querySelectorAll('.emptyState').length,
          badges: content.querySelectorAll('.badge').length,
          timelineItems: content.querySelectorAll('.timelineItem').length,
          treeBranches: content.querySelectorAll('details.treeBranch').length,
        };
      })`)
      if (probe.error === undefined && probe.contentChildren > 0) break
    }

    const shot = join(OUT_DIR, `console-${page.id}-${THEME}${WIDTH !== 1280 ? `-${WIDTH}` : ''}.png`)
    writeFileSync(shot, await page_.screenshot())
    results.push({ page: page.id, label: page.label, shot, ...probe })
  }
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}

// ---------------------------------------------------------------- report

// Console output and exceptions from inside the frame's window. The accessors live on the PAGE
// object, and the event buffer goes away with the session, so they are read before teardown.
const consoleMessages = []
const consoleErrors = []

console.log(`theme=${THEME} viewport=${WIDTH}x${HEIGHT}\n`)
let failed = 0
for (const row of results) {
  if (row.error !== undefined) {
    failed += 1
    console.log(`FAIL ${row.label.padEnd(12)} probe could not read the frame: ${row.error}`)
    continue
  }
  const overflow = row.scrollWidth > row.innerWidth + 1
  const blank = row.visibleCards === 0
  const renderedNothing = row.contentChildren === 0
  const bad = overflow || blank || renderedNothing || String(row.text || '').length === 0 || row.clicked === 'no-tab'
  if (bad) failed += 1
  console.log(
    `${bad ? 'FAIL' : 'ok  '} ${row.label.padEnd(12)} cards=${row.visibleCards}/${row.cards} badges=${row.badges} ` +
    `timeline=${row.timelineItems} tree=${row.treeBranches} empty=${row.emptyStates} ` +
    `html=${row.contentLength} children=${row.contentChildren} scrollW=${row.scrollWidth} innerW=${row.innerWidth}`,
  )
  console.log(`      heading: ${JSON.stringify(row.heading)}`)
  console.log(`      ${String(row.text).replace(/\s+/g, ' ').slice(0, 120)}`)
  if (row.failure !== '') {
    console.log(`      RENDER ERROR:\n        ${String(row.failure).split('\n').slice(0, 8).join('\n        ')}`)
  }
  if ((row.overflowing || []).length > 0) console.log(`      OVERFLOWING: ${row.overflowing.join(', ')}`)
  console.log(`      shot: ${row.shot}`)
}

console.log()
console.log(`${results.length - failed} / ${results.length} pages rendered; ${failed} blocking finding(s)`)
console.log('now READ every PNG back — a screenshot nobody looked at is not verification')
if (failed > 0) process.exit(1)
