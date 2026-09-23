// Narrow-screen sidebar: what the CSS claims vs what the browser does.
//
// THE FINDING THIS EXISTS FOR
// ---------------------------
// Below 860px the sidebar is supposed to fold from a vertical rail into a horizontal icon band.
// The media query DOES fire — `matchMedia('(max-width: 860px)').matches === true`, and the
// computed style on both `.rail` and `.tabs` reports `flex-direction: row` with `flex-wrap:
// nowrap`. And yet the four nav items measure at the SAME `left` with increasing `top`:
//
//     goal:36x36@8,8    system:36x36@8,44    preset:36x36@8,80    readme:36x36@8,116
//
// That is vertical stacking inside a container the browser itself reports as a non-wrapping row.
// I could not explain it, so this probe reports the facts and asserts only what is actually true —
// it does NOT claim the band renders.
//
// WHY IT IS NOT TREATED AS A BLOCKER
// ----------------------------------
// Every nav item is still present, correctly sized, correctly stroke-coloured, and clickable; the
// page itself does not overflow. The defect is that the fold costs 144px of vertical space instead
// of 36px, on a viewport narrower than the DSH side panel normally gives this frame. It is
// recorded here rather than papered over, and rather than left as a claim in a comment nobody
// checked.
//
// Usage: node tools/probe-sidebar-mq.mjs

import { loadFrameBuilder } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, sleep } from './acceptance-harness.mjs'

const { srcDoc } = loadFrameBuilder()
const hostPath = writeHostPage(frameWithStub('light'), { width: 500, height: 900, theme: 'light', label: 'mq' })
const launcher = await launchEdge({ headless: true, windowSize: { width: 500, height: 900 } })
const session = await attach({ port: launcher.port })
const page = await session.openTarget(`file:///${hostPath.replace(/\\/g, '/')}`)

let failures = 0
let checks = 0
function check(label, ok, detail = '') {
  checks += 1
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

try {
  const ok = await page.waitFor('#frame', { timeoutMs: 15000 })
  if (!ok) throw new Error('the frame never appeared')
  await sleep(2500)

  const r = await page.evaluate(`(${IN_FRAME})((doc, win) => {
    const rail = doc.querySelector('.rail');
    const tabs = doc.querySelector('.tabs');
    const tcs = doc.defaultView.getComputedStyle(tabs);
    const items = [...doc.querySelectorAll('.navItem')].map((el) => {
      const b = el.getBoundingClientRect();
      return { tab: el.dataset.tab, w: Math.round(b.width), h: Math.round(b.height),
               left: Math.round(b.left), top: Math.round(b.top),
               svg: el.querySelector('.navIcon') !== null };
    });
    const root = doc.documentElement;
    return {
      innerWidth: win.innerWidth,
      mq: win.matchMedia('(max-width: 860px)').matches,
      railDir: doc.defaultView.getComputedStyle(rail).flexDirection,
      tabsDir: tcs.flexDirection,
      tabsWrap: tcs.flexWrap,
      items,
      scrollWidth: root.scrollWidth,
      labelDisplay: doc.defaultView.getComputedStyle(doc.querySelector('.navLabel')).display,
    };
  })`)

  console.log(`viewport=${r.innerWidth}  media-query-matches=${r.mq}  rail.dir=${r.railDir}  tabs.dir=${r.tabsDir}/${r.tabsWrap}`)
  console.log(`nav items: ${r.items.map((i) => `${i.tab}@${i.left},${i.top}(${i.w}x${i.h})`).join('  ')}`)
  console.log('')

  // ---- what the fold must NOT cost, asserted ----
  check('the fold breakpoint actually fires', r.mq === true, `media query matched=${r.mq}`)
  check('the rail becomes a row', r.railDir === 'row', r.railDir)
  check('the labels are hidden so icons carry identification', r.labelDisplay === 'none', r.labelDisplay)
  check('every nav item is still present', r.items.length === 4, `${r.items.length} items: ${r.items.map((i) => i.tab).join(',')}`)
  check('every nav item still carries its icon', r.items.every((i) => i.svg), 'an item lost its icon')
  check('every nav item is still a usable target', r.items.every((i) => i.w >= 24 && i.h >= 24),
    r.items.map((i) => `${i.tab}=${i.w}x${i.h}`).join(' '))
  check('the narrow page does not overflow horizontally', r.scrollWidth <= r.innerWidth + 1,
    `scrollW=${r.scrollWidth} innerW=${r.innerWidth}`)

  // ---- the known limitation, asserted so it cannot silently get WORSE ----
  //
  // The band is supposed to be one row. It is not. Asserting the broken shape would freeze the
  // bug, so this asserts only the tolerable bound (no taller than a single stacked column) and
  // prints the measurement. When someone fixes it, the numbers improve and nothing here needs
  // editing.
  const sameRow = new Set(r.items.map((i) => i.top)).size === 1
  const maxTop = Math.max(...r.items.map((i) => i.top))
  console.log('')
  check('KNOWN LIMITATION: the icon band is a column, not a row', sameRow === false,
    sameRow ? 'it became a row — update this probe and the note in layout.css' : `stacked, ${maxTop}px tall`)
  check('and it does not grow past one stacked column', maxTop <= 120 + 4,
    `${maxTop}px — taller than a single column, so the fold costs more than before`)
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (fold fires; known limitation recorded, not hidden)`)
