/**
 * Measure the 「目标」 page's layout against real viewports, in a real browser.
 *
 * WHY MEASURE INSTEAD OF LOOK AT
 *
 * A screenshot showed content running past the right edge at 420px wide. "Looks clipped" is
 * not something to fix by eye — the questions are *what* overflows, *by how much*, and
 * *whether the document itself scrolls horizontally*. Those have answers, and the answers
 * decide whether there is a bug at all: a horizontal scrollbar caused by one long code
 * snippet is a different problem from a card whose fixed width exceeds the viewport.
 *
 * This uses the CDP driver rather than a screenshot because the numbers come back as values.
 * Pixel evidence is for judging polish; these are the facts that decide correctness.
 *
 * Usage: node tools/probe-goal-layout.mjs
 */

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { attach, launchEdge, shutdown } from './cdp-driver.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const page = join(tmpdir(), 'luzzy-goal-layout.html')
execFileSync(process.execPath, [
  join(PLUGIN_ROOT, 'tools', 'render-frame-with-data.mjs'),
  '--tab', 'goal',
  '--out', page,
], { stdio: ['ignore', 'ignore', 'inherit'] })

// 420 is the narrow case that looked wrong; 1280 is the wide case the page targets.
const VIEWPORTS = [
  { label: 'narrow', width: 420, height: 900 },
  { label: 'compact', width: 720, height: 900 },
  { label: 'wide', width: 1280, height: 1000 },
]

/**
 * The measurement, as one expression.
 *
 * `scrollWidth > clientWidth` on the document is the real horizontal-overflow signal. The
 * per-element list says who caused it, and it deliberately ignores elements that are
 * legitimately wider than their container and scroll internally (`overflow-x: auto` on
 * `pre`) — those are meant to scroll, and reporting them would bury the actual defect.
 */
const MEASURE = `(() => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('.column *, .topbar *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    // An element that scrolls its own overflow is not the page's overflow.
    const style = getComputedStyle(el);
    if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
    const right = r.right;
    const over = Math.round(right - vw);
    if (over > 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 40),
        right: Math.round(right),
        over,
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  // The grid is what should collapse; report which column count it resolved to.
  const grid = document.querySelector('.goalGrid');
  const cols = grid === null ? null : getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  // Chips must carry a word, never colour alone.
  const chips = [...document.querySelectorAll('.chip')];
  const namelessChips = chips.filter((c) => (c.textContent || '').trim() === '').length;
  const chipsWithGlyph = chips.filter((c) => c.querySelector('svg') !== null).length;
  return {
    viewport: vw,
    docScrollWidth: doc.scrollWidth,
    horizontalOverflow: doc.scrollWidth > vw + 1,
    bodyScrollWidth: document.body.scrollWidth,
    gridColumns: cols,
    chips: chips.length,
    namelessChips,
    chipsWithGlyph,
    offenders: offenders.slice(0, 8),
    offenderCount: offenders.length,
  };
})()`

const launched = await launchEdge({ headless: true, windowSize: { width: 1280, height: 1000 } })
// `session` is the TOP-LEVEL connection, not the per-target page handle: `shutdown` calls
// `Browser.close` on it, and the page handle does not carry that method.
let session = null
let bad = 0

try {
  session = await attach({ port: launched.port })
  const target = await session.openTarget(`file:///${page.replace(/\\/g, '/')}`)
  await target.enable()

  for (const viewport of VIEWPORTS) {
    // Resize through the protocol, not by launching a browser per size: a real layout at a
    // real width, with the same page state, so the numbers are comparable.
    await target.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const found = await target.waitFor('#goalRefresh', { timeoutMs: 15_000 })
    if (!found) {
      console.error(`  FAIL ${viewport.label}: the goal page never rendered`)
      bad += 1
      continue
    }
    // One frame to settle after the resize before measuring.
    await target.evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)))')

    const m = await target.evaluate(MEASURE)
    const label = `${viewport.label} (${m.viewport}px)`
    const ok = !m.horizontalOverflow && m.offenderCount === 0
    if (!ok) bad += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: scrollWidth=${m.docScrollWidth} overflow=${m.horizontalOverflow} offenders=${m.offenderCount} gridCols=${m.gridColumns} chips=${m.chips} glyphs=${m.chipsWithGlyph} nameless=${m.namelessChips}`)
    for (const o of m.offenders) {
      console.log(`       over by ${o.over}px: <${o.tag} class="${o.cls}"> "${o.text}"`)
    }
    if (m.chips > 0 && m.chipsWithGlyph !== m.chips) {
      console.log(`       chips without a glyph: ${m.chips - m.chipsWithGlyph}`)
      bad += 1
    }
  }
} catch (error) {
  console.error(`probe failed: ${error.message}`)
  bad += 1
} finally {
  // Teardown must go through the protocol: the spawned process is not the one holding the
  // profile, so killing it leaks a real browser (measured: 21 processes once).
  await shutdown({ child: launched.child, profile: launched.profile, session })
}

console.log()
if (bad > 0) {
  console.log(`FAIL — ${bad} layout problem(s) (goal tab)`)
  process.exit(1)
}
console.log('PASS — no horizontal overflow at any viewport (goal tab)')
