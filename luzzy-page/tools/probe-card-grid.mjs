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

// 尺寸从命令行来，好按档扫：默认 1100×800（宽档；面板常见的宽度）。
// 面板真实宽度只有 diag 里的 `viewport` 记录说得清，这个探针量的是「这个尺寸下几何对不对」。
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback
}
const WIDTH = arg('--width', 1100)
const HEIGHT = arg('--height', 800)

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
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
      vw: doc.documentElement.dataset.vw,
      vwPx: doc.documentElement.dataset.vwPx,
      docScrollWidth: doc.documentElement.scrollWidth,
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

  console.log(`viewport ${WIDTH}x${HEIGHT}  innerWidth=${measure.innerWidth} innerHeight=${measure.innerHeight}`)
  console.log(`frame reports: data-vw=${measure.vw} (data-vw-px=${measure.vwPx})`)
  console.log(`document.scrollWidth=${measure.docScrollWidth}  scrollHeight=${measure.docScroll}`)
  console.log(`.scroll client=${measure.scrollClient} scroll=${measure.scrollScroll} overflow=${measure.scrollOverflow}`)
  console.log(`.column display=${measure.colDisplay} height=${measure.colHeight} children=${measure.children} rows=${measure.colRows}`)
  console.log(`children: ${measure.childList.join('  ')}`)
  console.log('')
  console.log('cards:')
  for (const c of measure.cards) {
    console.log(`  ${String(c.h).padStart(5)}px  body ${String(c.bodyClient).padStart(5)}/${String(c.bodyScroll).padStart(5)} ${c.bodyOverflow}  ${c.title.slice(0, 26)}`)
  }
  console.log('')

  // 0 — 「实时监测窗口大小」：帧必须**知道**自己多大，而且必须把它说出来。
  //
  // 帧的视口就是那个 iframe 的盒子，宿主设成 100%×100%，所以面板一改大小它就跟着变 —— 检测
  // 不需要额外机制。但「跟着变了」和「看得出来它变了」是两件事：`data-vw` 是后者，而且它
  // 可断言。期望值按同一组断点算出来，不写死 —— 写死的话断点一调，探针就开始撒谎。
  const expectedBand = measure.innerWidth <= 860 ? 'narrow' : (measure.innerWidth < 1240 ? 'mid' : 'wide')
  check('the frame knows its own viewport width',
    measure.vwPx === String(measure.innerWidth), `data-vw-px=${measure.vwPx} innerWidth=${measure.innerWidth}`)
  check('and it publishes which band it is laying out for',
    measure.vw === expectedBand, `data-vw=${measure.vw} expected=${expectedBand}`)
  // 横向溢出是这一轮真正要防的那条：卡片排成网格之后，一条不换行的长 URL 就能把网格顶宽。
  check('and nothing overflows horizontally', measure.docScrollWidth <= measure.innerWidth + 1,
    `scrollWidth=${measure.docScrollWidth} innerWidth=${measure.innerWidth}`)

  // 1 — the page must not scroll. `scrollHeight > clientHeight` on the scroller IS the overflow.
  //
  // 窄档是**故意**滚的（见 layout.css 的响应式一节）：320px 的卡片在窄屏排不成两列，压成一排
  // 小格子叫读不了。所以这一条只在 mid/wide 断，窄档断的是反面 —— 它必须真的允许滚动。
  if (expectedBand === 'narrow') {
    check('narrow: the page is allowed to scroll (the deliberate fallback)',
      measure.scrollOverflow !== 'hidden', `overflow-y=${measure.scrollOverflow}`)
  } else {
    check('the content scroller does not scroll',
      measure.scrollOverflow === 'hidden', `.scroll overflow-y=${measure.scrollOverflow}`)
    check('and nothing overflows it', measure.scrollScroll <= measure.scrollClient + 1,
      `scrollHeight=${measure.scrollScroll} clientHeight=${measure.scrollClient}`)
    check('and the document itself does not grow past the viewport',
      measure.docScroll <= measure.innerHeight + 1, `doc=${measure.docScroll} viewport=${measure.innerHeight}`)
  }

  // 3 — equal heights. The whole point of the request.
  //
  // **只在 mid/wide 断**。窄档是刻意退回的两层滚动（见 layout.css），那里卡片按内容高、彼此
  // 当然不等高 —— 拿宽档的契约去断窄档，得到的不是「窄档坏了」，而是「探针在拿两套设计互相
  // 打分」。窄档断的是它自己的契约：一列、内容高、页面滚。
  if (expectedBand === 'narrow') {
    check('narrow: the cards stack instead of gridding', measure.cardHost === 'flex', measure.cardHost)
    check('narrow: and each card is its own content height, so nothing is cut off',
      new Set(measure.cards.map((c) => c.h)).size > 1,
      '窄档的卡片变成了等高 —— 那是宽档的排法，压成 320px 一列会读不了')
    check('narrow: and the card bodies do NOT scroll (the page does)',
      measure.cards.every((c) => c.bodyScroll <= c.bodyClient + 1),
      '两层滚动同时存在，滚轮滚谁要看指针在哪 —— 正是要避免的那件事')
  } else {
    check('the cards are packed into a grid', measure.cardHost === 'grid',
      `.cardGrid display=${measure.cardHost}`)
    check('and the cards are its direct children', measure.cardCount === measure.children,
      `${measure.cardCount} cards / ${measure.children} children`)

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
  }

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
