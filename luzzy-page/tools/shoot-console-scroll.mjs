/**
 * Scroll a page inside the frame and shoot, so sections BELOW the fold can be looked at.
 *
 * A single viewport screenshot only proves the top of a page. The goal centre's six sections run
 * far past 900px, and the acceptance list / task tree / evidence / decisions / history all live
 * down there — "I shot the page" and "I looked at the page" are different claims.
 *
 * Usage: node tools/shoot-console-scroll.mjs [--page goal] [--theme light] [--scroll 900] [--out x.png]
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, sleep } from './acceptance-harness.mjs'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const PAGE = argValue('--page', 'goal')
const THEME = argValue('--theme', 'light')
const SCROLL = Number(argValue('--scroll', '860'))
const HEIGHT = Number(argValue('--height', '900'))
const OUT = argValue('--out', join(PLUGIN_ROOT, 'docs', 'shots', `console-${PAGE}-${THEME}-scrolled.png`))

const hostPath = writeHostPage(frameWithStub(THEME), { width: 1280, height: HEIGHT, theme: THEME, label: 'scroll' })

const launcher = await launchEdge({ headless: true, windowSize: { width: 1280, height: HEIGHT } })
const session = await attach({ port: launcher.port })
const page_ = await session.openTarget(`file:///${hostPath.replace(/\\/g, '/')}`)

try {
  const booted = await page_.waitFor('#frame', { timeoutMs: 15_000 })
  if (!booted) throw new Error('the iframe never appeared')
  await sleep(1500)

  await page_.evaluate(`(${IN_FRAME})((doc) => {
    const b = doc.querySelector('[data-tab="${PAGE}"]');
    if (b) b.click();
  })`)

  // WAIT for the page to paint before scrolling. Applying `scrollTop` in the same evaluation as
  // the click reported `scrolled to 0` with no headings — the tab switch only STARTS a fetch, and
  // `scrollTop = n` on an element with nothing to scroll clamps to 0 silently. The shot then
  // looked like a successful scroll of an empty page.
  let ready = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(250)
    ready = await page_.evaluate(`(${IN_FRAME})((doc) => {
      const content = doc.getElementById('content');
      return { children: content ? content.children.length : -1, frameReady: !!doc.querySelector('[data-tab]') };
    })`)
    if (ready.children > 0) break
  }
  if (ready.children <= 0) {
    throw new Error(`the ${PAGE} page rendered nothing after 6s (frameReady=${ready.frameReady})`)
  }

  const scrolled = await page_.evaluate(`(${IN_FRAME})((doc) => {
    const scroller = doc.querySelector('.scroll');
    const content = doc.getElementById('content');
    scroller.scrollTop = ${SCROLL};
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      headings: [...content.querySelectorAll('h3')].map((h) => h.textContent),
    };
  })`)

  if (scrolled.scrollTop === 0) {
    // A 0 here means the page fits in one screen OR the scroll silently failed, and the two look
    // identical in the PNG — so the numbers get printed either way.
    console.warn(`note: scrollTop is 0 — the page is ${scrolled.scrollHeight}px tall in a ${scrolled.clientHeight}px viewport`)
  }

  await sleep(400)
  writeFileSync(OUT, await page_.screenshot())

  console.log(`page=${PAGE} theme=${THEME} scrolled to ${scrolled.scrollTop} of ${scrolled.scrollHeight} (viewport ${scrolled.clientHeight})`)
  console.log(`sections on this page: ${scrolled.headings.join(' | ')}`)
  console.log(`wrote ${OUT}`)
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}
