// The real decision: many narrow cards in one row, or fewer wide cards in two rows?
//
// "Mean visible fraction" is NOT the right metric on its own, and using it alone would pick the
// worst layout. Here is why: narrower cards wrap MORE, so their content gets TALLER — the fraction
// is measured against a number the layout itself inflated. Two configs need comparing on things
// that do not feed back into each other:
//
//   * characters per line  — readability, and independent of the vertical budget
//   * visible CONTENT height (px, absolute) — what a reader can actually read at once
//
// At 1350px of column width the two candidates are:
//   6 columns x 1 row  -> 212px cards, ~622px tall
//   3 columns x 2 rows -> 439px cards, ~303px tall
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { AS_DOCUMENT, sleep } from './acceptance-harness.mjs'

execFileSync(process.execPath, [join(import.meta.dirname, 'render-frame-with-data.mjs'), '--tab', 'goal'], { stdio: 'ignore' })
const hostPath = join(tmpdir(), 'luzzy-frame-goal.html')
if (!existsSync(hostPath)) throw new Error('no page')

const launcher = await launchEdge({ headless: true, windowSize: { width: 1630, height: 984 } })
const session = await attach({ port: launcher.port })
const page = await session.openTarget(`file:///${hostPath.replace(/\\/g, '/')}`)

async function measure(minPx) {
  return page.evaluate(`(${AS_DOCUMENT})((doc, win) => {
    let style = doc.getElementById('probeOverride')
    if (style === null) { style = doc.createElement('style'); style.id = 'probeOverride'; doc.head.appendChild(style) }
    style.textContent = '.cardGrid{grid-template-columns:repeat(auto-fit,minmax(' + ${JSON.stringify(String(minPx))} + 'px,1fr))!important}'

    const grid = doc.querySelector('.cardGrid')
    const cols = win.getComputedStyle(grid).gridTemplateColumns.split(' ').filter((s) => s.endsWith('px')).length
    const cards = [...grid.querySelectorAll(':scope > .card')]
    const rows = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size

    let totalVisible = 0
    let totalContent = 0
    let charsPerLine = 0
    for (const card of cards) {
      const body = card.querySelector('.cardBody')
      if (body === null) continue
      const cs = win.getComputedStyle(body)
      const probe = doc.createElement('span')
      probe.textContent = '目标看板数据接入状态验证'
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:' + cs.fontSize +
        ';font-family:' + cs.fontFamily + ';font-weight:' + cs.fontWeight
      body.appendChild(probe)
      const textW = probe.getBoundingClientRect().width
      probe.remove()
      const innerW = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      charsPerLine = Math.max(charsPerLine, textW === 0 ? 0 : Math.floor(innerW / (textW / 12)))
      totalVisible += body.clientHeight
      totalContent += body.scrollHeight
    }
    return {
      cols: cols,
      rows: rows,
      cardW: Math.round(cards[0].getBoundingClientRect().width),
      cardH: Math.round(cards[0].getBoundingClientRect().height),
      charsPerLine: charsPerLine,
      totalVisible: totalVisible,
      totalContent: totalContent,
    }
  })`)
}

try {
  await sleep(2500)
  console.log('min    cols rows  cardW  cardH  chars/line  visible px  content px  visible%')
  for (const min of [200, 260, 300, 340, 380, 440]) {
    const m = await measure(min)
    const pct = m.totalContent === 0 ? 100 : (m.totalVisible / m.totalContent) * 100
    console.log(
      `${String(min).padStart(4)}   ${String(m.cols).padStart(4)} ${String(m.rows).padStart(4)}  ` +
      `${String(m.cardW).padStart(5)}  ${String(m.cardH).padStart(5)}  ${String(m.charsPerLine).padStart(10)}  ` +
      `${String(m.totalVisible).padStart(10)}  ${String(m.totalContent).padStart(10)}  ${pct.toFixed(0).padStart(7)}%`,
    )
  }
} finally {
  try { await shutdown({ child: launcher?.child, profile: launcher?.profile, session }) } catch (error) { void error }
}
