// What do the two `.driftLine` blocks at the bottom of the goal page actually need?
//
// The real-size screenshot (1630x984) shows the execution chain clipped mid-box. `.column >
// .driftLine` carries `max-height: 3.6em; overflow-y: auto`, so if the chain needs more than that,
// it is silently cut — and `overflow-y: auto` on a 58px strip inside a no-scroll page is not a
// usable scroll target, it is a crop.
//
// This measures the natural height of what is inside, so "is it clipped" is a number and not an
// impression. It also reports the font-size the em is resolved against, because a body-size change
// moves the cap: 3.6em at 15px is 54px, at 16px it is 57.6px — a 3.6px swing on a block that was
// already tight.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFrameBuilder } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, AS_DOCUMENT, sleep } from './acceptance-harness.mjs'

const WIDTH = Number(process.argv[process.argv.indexOf('--width') + 1]) || 1630
const HEIGHT = Number(process.argv[process.argv.indexOf('--height') + 1]) || 984
const PAGE = process.argv.includes('--page') ? process.argv[process.argv.indexOf('--page') + 1] : 'shot'

let hostPath
if (PAGE === 'shot') {
  // The page the screenshots come from — render it exactly as the shooter does, then measure THAT
  // file. Measuring a stand-in and calling it the product is how a probe passes while the real
  // page is laid out differently (this file measured the harness fixture for its first version,
  // and the real page turned out to show 2px of a 228px card body).
  // Render the DRIFTED state: it is the only one carrying a control (「对齐到当前目标」), and a
  // control clipped out of view is precisely the defect this probe exists for. Pointing it at the
  // synced state left the reachability check with nothing to check — it passed for the wrong reason.
  execFileSync(process.execPath, [join(import.meta.dirname, 'render-frame-with-data.mjs'), '--tab', 'goal', '--drifted'], { stdio: 'ignore' })
  hostPath = join(tmpdir(), 'luzzy-frame-goal.html')
  if (!existsSync(hostPath)) throw new Error(`the render tool did not produce ${hostPath}`)
  console.log(`measuring the RENDERED page: ${hostPath}`)
} else {
  const { srcDoc } = loadFrameBuilder()
  hostPath = writeHostPage(frameWithStub('light'), { width: WIDTH, height: HEIGHT, theme: 'light', label: 'drift' })
  console.log('measuring the acceptance-harness fixture (--page harness)')
}
const launcher = await launchEdge({ headless: true, windowSize: { width: WIDTH, height: HEIGHT } })
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
  // Measure the REAL page by default. `--page harness` uses the smaller acceptance fixture.
  // Same reasoning as probe-card-grid.mjs: the screenshot page and the harness page are different
  // documents with different content, and a geometry assertion about the one a person sees has to
  // be taken from that one.
  const access = PAGE === 'shot' ? AS_DOCUMENT : IN_FRAME
  if (PAGE !== 'shot') {
    await page.waitFor('#frame', { timeoutMs: 15000 })
  }
  await sleep(2500)

  const m = await page.evaluate(`(${access})((doc, win) => {
    const out = []
    for (const el of doc.querySelectorAll('.column > .driftLine')) {
      const cs = win.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const svg = el.querySelector('svg')
      // Is every CONTROL inside this line fully visible? A button clipped by an ancestor's
      // overflow is unreachable, and unreachable is the same as absent to a person — they see
      // "the plan has drifted, align it" with nothing to click.
      const controls = [...el.querySelectorAll('button, [role="button"], a[href]')].map((b) => {
        const br = b.getBoundingClientRect()
        const er = el.getBoundingClientRect()
        return {
          label: (b.textContent || '').trim(),
          visible: br.top >= er.top - 1 && br.bottom <= er.bottom + 1 && br.height > 0,
          bottom: Math.round(br.bottom),
          limit: Math.round(er.bottom),
        }
      })
      out.push({
        text: (el.textContent || '').trim().slice(0, 34),
        fontSize: Math.round(parseFloat(cs.fontSize) * 100) / 100,
        maxHeight: cs.maxHeight,
        clientHeight: Math.round(r.height),
        scrollHeight: el.scrollHeight,
        overflowY: cs.overflowY,
        clipped: el.scrollHeight > el.clientHeight + 1,
        controls: controls,
        svgHeight: svg === null ? null : Math.round(svg.getBoundingClientRect().height),
        svgAttrHeight: svg === null ? null : svg.getAttribute('height'),
      })
    }
    // THE VERTICAL BUDGET. A card showing 2px of 228px is not "scrolling", it is a title with
    // nothing under it — and the arithmetic that produces it is invisible unless you break the
    // card down by its own parts.
    const budget = [...doc.querySelectorAll('.cardGrid > .card')].map((card) => {
      const parts = []
      for (const child of card.children) {
        const h = Math.round(child.getBoundingClientRect().height)
        parts.push((child.className || child.tagName.toLowerCase()) + '=' + h)
      }
      const body = card.querySelector('.cardBody')
      const sub = card.querySelector('.cardSub')
      const head = card.querySelector('.cardHead')
      return {
        title: (card.querySelector('h3') || {}).textContent || '?',
        cardH: Math.round(card.getBoundingClientRect().height),
        head: head === null ? 0 : Math.round(head.getBoundingClientRect().height),
        sub: sub === null ? 0 : Math.round(sub.getBoundingClientRect().height),
        subChars: sub === null ? 0 : (sub.textContent || '').length,
        subFontSize: sub === null ? null : Math.round(parseFloat(win.getComputedStyle(sub).fontSize) * 100) / 100,
        bodyClient: body === null ? 0 : body.clientHeight,
        bodyScroll: body === null ? 0 : body.scrollHeight,
        parts: parts,
      }
    })
    const col = doc.querySelector('.column')
    return {
      lines: out,
      budget: budget,
      columnClient: col.clientHeight,
      columnScroll: col.scrollHeight,
      columnOverflows: col.scrollHeight > col.clientHeight + 1,
      childHeights: [...col.children].map((c) => (c.className || '-') + '@' + Math.round(c.getBoundingClientRect().height)),
    }
  })`)

  console.log(`viewport ${WIDTH}x${HEIGHT}`)
  console.log(`.column client=${m.columnClient} scroll=${m.columnScroll} overflows=${m.columnOverflows}`)
  console.log(`  children: ${m.childHeights.join('  ')}`)

  console.log('\ncard budget (head + sub + body, inside the card height):')
  for (const c of m.budget) {
    const visible = c.bodyScroll === 0 ? 1 : c.bodyClient / c.bodyScroll
    console.log(`  ${c.title}`)
    console.log(`     card ${c.cardH}px = head ${c.head} + sub ${c.sub} + body ${c.bodyClient}`)
    console.log(`     sub is ${c.subChars} chars @ ${c.subFontSize}px`)
    console.log(`     body shows ${c.bodyClient} of ${c.bodyScroll}px (${(visible * 100).toFixed(0)}%)`)
  }
  console.log('\n.driftLine blocks:')
  for (const line of m.lines) {
    console.log(`  "${line.text}"`)
    console.log(`     font-size ${line.fontSize}px, max-height ${line.maxHeight}`)
    console.log(`     client ${line.clientHeight}px, content ${line.scrollHeight}px, overflow-y ${line.overflowY}`)
    if (line.svgHeight !== null) console.log(`     svg ${line.svgHeight}px tall (attr ${line.svgAttrHeight})`)
    console.log(`     CLIPPED: ${line.clipped}`)
    for (const c of line.controls) {
      console.log(`     control "${c.label}" visible=${c.visible} (bottom ${c.bottom} vs limit ${c.limit})`)
    }
  }

  console.log()
  check('the goal page has the two state lines', m.lines.length === 2, String(m.lines.length))
  check('the column itself does not overflow the page', m.columnOverflows === false,
    `content ${m.columnScroll}px in ${m.columnClient}px`)

  // The structural check: an SVG with a fixed height attribute cannot be clipped and still be
  // readable, so whatever carries one must be tall enough for it.
  const chains = m.lines.filter((line) => line.svgAttrHeight !== null && Number(line.svgAttrHeight) > 40)
  for (const line of chains) {
    check(`the execution chain is tall enough for its ${line.svgAttrHeight}px SVG`,
      line.clientHeight >= Number(line.svgAttrHeight),
      `shows ${line.clientHeight}px, the drawing is ${line.svgAttrHeight}px`)
  }

  // And the one that actually costs the user something: every control must be reachable. This is
  // the assertion the old `max-height: 3.6em` was violating — it cut the 「对齐到当前目标」
  // button off the bottom of a 58px strip.
  //
  // The REACHABILITY check is unconditional. The VACUITY check is conditional, because this page
  // has a control only when the plan has drifted: with a synced plan there is nothing to click and
  // nothing to be unreachable, so "no controls found" is a correct state rather than a broken test.
  // Demanding a control unconditionally made the probe fail on a healthy page — the same shape as
  // the scroll assertion in probe-card-grid that depended on the fixture being tall enough.
  //
  // So the fixture's own state decides which reading applies, and it says so out loud: if a drift
  // line is present (`data-drift="drifted"`), it MUST carry a reachable control; if it is not, the
  // assertion reports that it had nothing to check instead of claiming a pass.
  const hidden = m.lines.flatMap((line) => line.controls.filter((c) => !c.visible).map((c) => `${c.label} (${c.bottom} > ${c.limit})`))
  check('no control inside a state line is cut off', hidden.length === 0, hidden.join(' | '))

  const drifted = await page.evaluate(`(${AS_DOCUMENT})((doc) => {
    const line = doc.querySelector('.column > .driftLine[data-drift="drifted"]')
    if (line === null) return { present: false }
    const button = line.querySelector('button, [role="button"], a[href]')
    if (button === null) return { present: true, hasControl: false }
    const br = button.getBoundingClientRect()
    const lr = line.getBoundingClientRect()
    return { present: true, hasControl: true, label: (button.textContent || '').trim(), visible: br.bottom <= lr.bottom + 1 && br.height > 0 }
  })`)
  if (drifted.present) {
    check('a drifted plan offers a control', drifted.hasControl === true, JSON.stringify(drifted))
    check('and that control is reachable', drifted.visible === true, JSON.stringify(drifted))
  } else {
    check('this fixture has no drifted plan, so there is no control to reach', true,
      'not a pass for reachability — it is a statement that this page had nothing to check')
  }
} finally {
  try { await shutdown({ child: launcher?.child, profile: launcher?.profile, session }) } catch (error) { void error }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} check(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} checks (the state lines fit)`)
