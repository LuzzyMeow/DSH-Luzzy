// Measure the rendered type scale and surfaces, from computed styles in a real browser.
//
// This is the falsifiable half of the redesign. The complaint was "观感差" and the diagnosis
// was specific — text too small (12px-dominated), canvas too grey, no coloured accent. Reading
// the CSS back does not answer any of that; only getComputedStyle on a rendered page does.
//
// The probe also reports WHICH selectors own the small text and which media queries are active,
// because both questions came up for real: the histogram said "13px dominates" without saying
// what that 13px was, and a `prefers-contrast: more` fallback (which headless Edge reports as
// active) initially made a correct `.card` rule look like it had not applied at all.
import { loadFrameBuilder } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, sleep } from './acceptance-harness.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback
}
const WIDTH = arg('--width', 1630)
const HEIGHT = arg('--height', 984)

// The frame-side function is built by concatenation, never as a nested template literal: a
// backtick anywhere inside would terminate the outer one (AGENTS.md §5.6 — this file hit it).
const MEASURE = `(doc, win) => {
  const cs = (el) => win.getComputedStyle(el)
  const px = (v) => Math.round(parseFloat(v) * 100) / 100
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  // 1 — every visible text node's font-size, weighted by its character count, so the histogram
  // describes what is actually on screen rather than what the stylesheet declares.
  const sizes = {}
  const small = {}
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    const text = (node.textContent || '').trim()
    if (text.length > 0 && node.parentElement !== null && visible(node.parentElement)) {
      const el = node.parentElement
      const size = px(cs(el).fontSize)
      sizes[size] = (sizes[size] || 0) + text.length
      if (size <= 14) {
        const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : ''
        const key = el.tagName.toLowerCase() + (cls === '' ? '' : '.' + cls)
        if (small[key] === undefined) small[key] = { chars: 0, size: size, sample: text.slice(0, 42) }
        small[key].chars += text.length
      }
    }
    node = walker.nextNode()
  }

  // 2 — which rules actually match the card, and which media queries are live. When an edit to a
  // stylesheet appears to do nothing, another rule is winning, and the computed value cannot say
  // which one.
  const card = doc.querySelector('.card')
  const matched = []
  if (card !== null) {
    for (const sheet of doc.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch (error) { continue }
      for (const rule of rules) {
        if (rule.selectorText === undefined) continue
        try { if (card.matches(rule.selectorText)) matched.push(rule.selectorText) } catch (error) { void error }
      }
    }
  }
  const mqNames = ['(prefers-contrast: more)', '(prefers-contrast: less)', '(prefers-reduced-transparency: reduce)', '(prefers-reduced-motion: reduce)']
  const mq = {}
  for (const name of mqNames) mq[name] = win.matchMedia(name).matches

  // 3 — the surfaces and the faces.
  const body = cs(doc.body)
  const rail = doc.querySelector('.rail')
  const h3 = doc.querySelector('.cardHead h3')
  const link = doc.querySelector('.link, a')
  const root = cs(doc.documentElement)
  return {
    sizes: sizes,
    small: small,
    matched: matched,
    mq: mq,
    cardCount: doc.querySelectorAll('.card').length,
    bodyFont: body.fontFamily,
    bodySize: px(body.fontSize),
    bodyLeading: body.lineHeight,
    canvas: root.getPropertyValue('--lz-bg-layout').trim(),
    container: card === null ? null : cs(card).backgroundColor,
    cardRadius: card === null ? null : px(cs(card).borderTopLeftRadius),
    cardShadow: card === null ? null : cs(card).boxShadow,
    cardFilter: card === null ? null : cs(card).backdropFilter,
    railBg: rail === null ? null : cs(rail).backgroundColor,
    h3Size: h3 === null ? null : px(cs(h3).fontSize),
    accent: root.getPropertyValue('--lz-accent').trim(),
    linkColor: link === null ? null : cs(link).color,
    monoFont: root.getPropertyValue('--lz-mono').trim(),
  }
}`

const { srcDoc } = loadFrameBuilder()
const hostPath = writeHostPage(frameWithStub('light'), { width: WIDTH, height: HEIGHT, theme: 'light', label: 'type-scale' })
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
  const ok = await page.waitFor('#frame', { timeoutMs: 15000 })
  if (!ok) throw new Error('the frame never appeared')
  await sleep(2500)

  const m = await page.evaluate(`(${IN_FRAME})(${MEASURE})`)

  console.log(`viewport ${WIDTH}x${HEIGHT}`)
  console.log(`  body font-family : ${m.bodyFont}`)
  console.log(`  body font-size   : ${m.bodySize}px / line-height ${m.bodyLeading}`)
  console.log(`  --lz-accent      : ${m.accent}`)
  console.log(`  canvas token     : ${m.canvas}`)
  console.log(`  card background  : ${m.container}`)
  console.log(`  card radius      : ${m.cardRadius}px`)
  console.log(`  card shadow      : ${m.cardShadow}`)
  console.log(`  card backdrop    : ${m.cardFilter}`)

  const total = Object.values(m.sizes).reduce((a, b) => a + b, 0)
  console.log('\n  rendered text by font-size (characters):')
  const entries = Object.entries(m.sizes).map(([size, chars]) => [Number(size), chars]).sort((a, b) => a[0] - b[0])
  for (const [size, chars] of entries) {
    const pct = ((chars / total) * 100).toFixed(1)
    console.log(`    ${String(size).padStart(6)}px  ${String(chars).padStart(6)}  ${pct.padStart(5)}%  ${'#'.repeat(Math.round((chars / total) * 50))}`)
  }

  console.log('\n  which selectors own the small text:')
  for (const [key, info] of Object.entries(m.small).sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(`    ${String(info.chars).padStart(5)} chars @ ${info.size}px  ${key}  ${JSON.stringify(info.sample)}`)
  }

  console.log(`\n  cards on the page: ${m.cardCount}`)
  console.log(`  rules matching .card: ${m.matched.join(' | ') || '(none)'}`)
  console.log(`  active media queries: ${Object.entries(m.mq).filter((pair) => pair[1]).map((pair) => pair[0]).join(' ') || '(none)'}`)

  console.log()
  // AC-016 — the type scale. The old page was 12px-dominated; body copy must now be at least 15.
  check('body text is at least 15px', m.bodySize >= 15, `${m.bodySize}px`)
  check('body line-height is 1.6-ish, not cramped', parseFloat(m.bodyLeading) / m.bodySize > 1.5,
    `${m.bodyLeading} for ${m.bodySize}px`)
  const dominant = entries.slice().sort((a, b) => b[1] - a[1])[0]
  check('text is NOT dominated by the 13px token', dominant[0] > 13,
    `the most-rendered size is ${dominant[0]}px (${dominant[1]} chars)`)
  check('a heading reaches 18px or more', m.h3Size !== null && m.h3Size >= 18, `${m.h3Size}px`)

  // AC-015 — palette and surfaces, measured rather than read.
  check('canvas token is the warm paper surface', m.canvas === '#faf9f7', m.canvas)
  check('cards are solid white, not glass', m.container === 'rgb(255, 255, 255)', String(m.container))
  check('cards do NOT carry a backdrop blur', m.cardFilter === 'none' || m.cardFilter === '', String(m.cardFilter))
  check('accent is the violet, not near-black', m.accent === '#6b5ce7', m.accent)
  check('card radius is one of the reference steps', [8, 12, 16].includes(m.cardRadius), `${m.cardRadius}px`)
  check('body font leads with Inter', /Inter Variable/.test(m.bodyFont), m.bodyFont)
  check('a mono face is declared for code', /JetBrains Mono/.test(m.monoFont), m.monoFont)
} finally {
  // `shutdown` takes ONE object, not positional arguments. Calling it the other way threw
  // inside the finally block, which swallowed the real problem and left the browser and its
  // profile behind — the probe printed all its results and then hung for two minutes.
  try { await shutdown({ child: launcher?.child, profile: launcher?.profile, session }) } catch (error) { void error }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} check(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} checks (type scale and surfaces, measured in a real browser)`)
