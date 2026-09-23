// One-off: is the overflowing element a genuine defect or the tab bar's intended scroll?
//
// At 420px the tab bar reports overflow. Two very different things look identical in the
// element list:
//   * the SEGMENT overflows its own box but the PAGE does not scroll (contained, fine)
//   * the document actually scrolls sideways (a real defect)
//
// `scrollWidth === innerWidth` on <html> already says the second is not happening, but that is a
// conclusion. This shows the numbers behind it, and confirms the container clips rather than
// pushes — because "the page doesn't scroll" can also be true when something is merely CLIPPED
// out of existence, which is a defect of a different kind.
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, sleep } from './acceptance-harness.mjs'

const hostPath = writeHostPage(frameWithStub('light'), { width: 420, height: 800, theme: 'light', label: 'overflow' })
const launcher = await launchEdge({ headless: true, windowSize: { width: 420, height: 800 } })
const session = await attach({ port: launcher.port })
const page_ = await session.openTarget(`file:///${hostPath.replace(/\\/g, '/')}`)

try {
  await page_.waitFor('#frame', { timeoutMs: 15_000 })
  await sleep(1500)

  const report = await page_.evaluate(`(${IN_FRAME})((doc, win) => {
    const out = { innerWidth: win.innerWidth, htmlScroll: doc.documentElement.scrollWidth, rows: [] };
    const tabbar = doc.querySelector('.tabs');
    const segment = doc.querySelector('.segment');
    const row = (label, el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      out.rows.push({
        label,
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: win.getComputedStyle(el).overflowX,
      });
    };
    row('.tabs (tab bar container)', tabbar);
    row('.segment (inside it)', segment);
    // Can the tab bar actually be scrolled to reach the last tab?
    if (tabbar) {
      const buttons = [...tabbar.querySelectorAll('button')];
      out.tabCount = buttons.length;
      out.lastTabRight = buttons.length ? Math.round(buttons[buttons.length - 1].getBoundingClientRect().right) : 0;
      tabbar.scrollLeft = 9999;
      const last = buttons[buttons.length - 1];
      out.lastTabRightAfterScroll = last ? Math.round(last.getBoundingClientRect().right) : 0;
      out.scrolledTo = tabbar.scrollLeft;
    }
    return out;
  })`)

  console.log(`viewport innerWidth: ${report.innerWidth}`)
  console.log(`document scrollWidth: ${report.htmlScroll}  → ${report.htmlScroll > report.innerWidth ? 'PAGE SCROLLS (defect)' : 'page does not scroll'}`)
  for (const r of report.rows) {
    console.log(`  ${r.label}: left=${r.left} right=${r.right} width=${r.width} scrollW=${r.scrollWidth} clientW=${r.clientWidth} overflow-x=${r.overflowX}`)
  }
  console.log(`tabs: ${report.tabCount}; last tab right before scroll=${report.lastTabRight}, after scrolling to ${report.scrolledTo}px=${report.lastTabRightAfterScroll}`)
  console.log(
    report.lastTabRightAfterScroll <= report.innerWidth
      ? '→ the last tab IS reachable by scrolling the tab bar: contained, intended'
      : '→ the last tab is unreachable: real defect',
  )
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}
