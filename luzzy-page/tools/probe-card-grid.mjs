// Measure the card grid, in a real browser.
//
// WHY THIS EXISTS: the requirement is geometric — 「永远只有用户页面大小，不滚动不翻页，等高小卡片，
// 卡片内部可滚」 — and a screenshot cannot answer it. A 1300px-tall capture of a 1300px viewport
// looks identical whether the page fits or overflows past the bottom edge, and "the cards look
// roughly similar" is not a measurement. So this reads the geometry back out of the live DOM:
// does the document scroll, is the column a grid, are the cards the same height, and does each
// card body own its own overflow.
//
// Same reason the sidebar probe exists: 「布局要量不要看」.

import { loadFrameBuilder } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, sleep } from './acceptance-harness.mjs'

const WIDTH = 1100
const HEIGHT = 800

const { srcDoc } = loadFrameBuilder()
const hostPath = writeHostPage(frameWithStub('light'), { width: WIDTH, height: HEIGHT, theme: 'light', label: 'card-grid' })
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

  const measure = await page.evaluate(`(${IN_FRAME})((doc, win) => {
    const sc = doc.querySelector('.scroll');
    const col = doc.querySelector('.column');
    const cs = doc.defaultView.getComputedStyle(col);
    const cards = [...doc.querySelectorAll('.cardGrid > .card, .column > .card')].map((el) => {
      const b = el.getBoundingClientRect();
      const body = el.querySelector('.cardBody');
      const bb = body === null ? null : body.getBoundingClientRect();
      return {
        title: (el.querySelector('h3') || {}).textContent || '(no title)',
        h: Math.round(b.height),
        bodyScroll: body === null ? null : body.scrollHeight,
        bodyClient: body === null ? null : body.clientHeight,
        bodyOverflow: body === null ? 'none' : doc.defaultView.getComputedStyle(body).overflowY,
        bodyRect: bb === null ? null : Math.round(bb.height),
      };
    });
    return {
      innerHeight: win.innerHeight,
      docScroll: doc.documentElement.scrollHeight,
      scrollClient: sc.clientHeight,
      scrollScroll: sc.scrollHeight,
      scrollOverflow: doc.defaultView.getComputedStyle(sc).overflowY,
      colDisplay: cs.display,
      colRows: cs.gridTemplateRows,
      colHeight: Math.round(col.getBoundingClientRect().height),
      children: col.children.length,
      // NO nested template literal here: this whole block is itself inside one, and a backtick
      // terminates it (syntax error at a line that looks fine). Concatenation, not backticks.
      childList: [...col.children].map((el) => el.tagName.toLowerCase() + '.' + (el.className || '-') + '@' + Math.round(el.getBoundingClientRect().height)),
      cardHost: (() => {
        const g = doc.querySelector('.cardGrid')
        return g === null ? null : doc.defaultView.getComputedStyle(g).display
      })(),
      cardCount: cards.length,
      cards,
    };
  })`)

  console.log(`viewport ${WIDTH}x${HEIGHT}  innerHeight=${measure.innerHeight}`)
  console.log(`document.scrollHeight=${measure.docScroll}  .scroll client=${measure.scrollClient} scroll=${measure.scrollScroll} overflow=${measure.scrollOverflow}`)
  console.log(`.column display=${measure.colDisplay} height=${measure.colHeight} children=${measure.children} rows=${measure.colRows}`)
  console.log(`children: ${measure.childList.join('  ')}`)
  console.log('')
  console.log('cards:')
  for (const c of measure.cards) {
    console.log(`  ${String(c.h).padStart(5)}px  body ${String(c.bodyClient).padStart(5)}/${String(c.bodyScroll).padStart(5)} ${c.bodyOverflow}  ${c.title.slice(0, 26)}`)
  }
  console.log('')

  // 1 — the page must not scroll. `scrollHeight > clientHeight` on the scroller IS the overflow.
  check('the content scroller does not scroll',
    measure.scrollOverflow === 'hidden', `.scroll overflow-y=${measure.scrollOverflow}`)
  check('and nothing overflows it', measure.scrollScroll <= measure.scrollClient + 1,
    `scrollHeight=${measure.scrollScroll} clientHeight=${measure.scrollClient}`)
  check('and the document itself does not grow past the viewport',
    measure.docScroll <= measure.innerHeight + 1, `doc=${measure.docScroll} viewport=${measure.innerHeight}`)

  // 2 — the cards are collected into a grid, so the height is divided among FEWER rows.
  //
  // 这条断言原来写的是「.column 是 grid」，而那是我后来放弃的设计：列里混着导航与单行提示，
  // 网格没法让它们按内容高、卡片按 1fr 高（行高属于整行，不属于格子）。现在的契约是
  // 「卡片被外壳收进 .cardGrid」，所以断的是那个容器 —— 断言描述的是一个**契约**，
  // 契约变了它就该跟着变，而不是留着描述一个已经不在的设计。
  check('the cards are packed into a grid', measure.cardHost === 'grid',
    `.cardGrid display=${measure.cardHost}`)
  check('and the cards are its direct children', measure.cardCount === measure.children,
    `${measure.cardCount} cards / ${measure.children} children`)

  // 3 — equal heights. The whole point of the request.
  const heights = measure.cards.map((c) => c.h)
  const spread = heights.length === 0 ? 0 : Math.max(...heights) - Math.min(...heights)
  check('the cards are the same height', spread <= 1, `spread=${spread}px across ${heights.length} cards`)

  // 4 — each card body owns its own scrolling.
  check('every card body can scroll its own overflow',
    measure.cards.every((c) => c.bodyOverflow === 'auto'),
    measure.cards.map((c) => c.bodyOverflow).join(','))
  check('and a card whose content is longer than the card really does scroll',
    measure.cards.some((c) => c.bodyScroll > c.bodyClient + 1),
    'no card overflows — the fixture may be too small to prove the scroll works')
  check('every card actually has a body wrapper',
    measure.cards.every((c) => c.bodyClient !== null),
    'a card without .cardBody cannot scroll: its content just gets clipped')
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}

console.log('')
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks}`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (card grid)`)
