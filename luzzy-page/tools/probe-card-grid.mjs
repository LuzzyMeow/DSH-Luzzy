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
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH FIXTURE THIS MEASURES — and why that turned out to matter
//
// `--page shot` (the default) measures the page `render-frame-with-data.mjs` renders, i.e. THE ONE
// THE SCREENSHOTS SHOW. `--page harness` measures the smaller acceptance-harness fixture instead.
//
// The distinction is not cosmetic. Until this option existed, the probe used the harness fixture
// (4 cards) while every screenshot came from the render tool's own richer fixture (6 cards) — the
// two are different pages with different content heights, so a geometry assertion could pass here
// while the page a person actually saw was laid out differently. Measuring a stand-in and calling
// it the product is the same class of error as reading a stale cache: the instrument is confident
// and pointed at the wrong thing.
//
// `--page shot` works by screenshotting the render tool's own temp HTML — the exact file the
// screenshots come from — and reading the DOM back out of it via the file:// protocol. It is the
// same page to the byte.

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFrameBuilder } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, AS_DOCUMENT, sleep } from './acceptance-harness.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const argNum = (name, fallback) => Number(arg(name, fallback))
const WIDTH = argNum('--width', 1630)
const HEIGHT = argNum('--height', 984)
const PAGE = arg('--page', 'shot')

let hostPath
if (PAGE === 'shot') {
  // Render the real page first, exactly as the screenshot tool does, then point the browser at it.
  execFileSync(process.execPath, [join(import.meta.dirname, 'render-frame-with-data.mjs'), '--tab', 'goal'], {
    stdio: 'ignore',
  })
  hostPath = join(tmpdir(), 'luzzy-frame-goal.html')
  if (!existsSync(hostPath)) throw new Error(`the render tool did not produce ${hostPath}`)
  console.log(`measuring the RENDERED page: ${hostPath}`)
} else {
  const { srcDoc } = loadFrameBuilder()
  hostPath = writeHostPage(frameWithStub('light'), { width: WIDTH, height: HEIGHT, theme: 'light', label: 'card-grid' })
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
  // Two different documents, two different ways in. When measuring the rendered page the frame
  // IS the document, so there is no `#frame` to wait for and `IN_FRAME` would report
  // "no frame document" — which reads as a broken page rather than a mis-aimed loader.
  const access = PAGE === 'shot' ? AS_DOCUMENT : IN_FRAME
  if (PAGE !== 'shot') {
    const ok = await page.waitFor('#frame', { timeoutMs: 15000 })
    if (!ok) throw new Error('the frame never appeared')
  }
  await sleep(2500)

  const measure = await page.evaluate(`(${access})((doc, win) => {
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
      // How many cards sit inside the grid, and how many elements in the column host cards at all.
      // Note: the children count above is the COLUMN child count, which is a different number once
      // the shell packs the cards into a grid — see the note at the assertion.
      //
      // NO backticks and NO apostrophes in these comments. This whole block is a template literal,
      // so a backtick ends it early (the reported error points at the line the template STARTS,
      // nowhere near the mistake), and an apostrophe inside the single-quoted JS below ends a
      // string. Both are AGENTS.md section 5.6, and I hit the backtick one while writing this very
      // comment — which is exactly why the warning exists.
      gridChildren: (() => {
        const g = doc.querySelector('.cardGrid')
        return g === null ? 0 : g.querySelectorAll(':scope > .card').length
      })(),
      columnCardHosts: [...col.children].filter((el) => el.querySelector('.card') !== null).length,
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
    // The cards are the grid's children — not the COLUMN's.
    //
    // This used to read `cardCount === measure.children`, where `children` is the count of
    // `.column`'s direct children. That was true before `packCards()` existed, when every card sat
    // directly in the column. Once the shell began packing them into a `.cardGrid`, the column's
    // children became [btnBar, cardGrid, …state lines] while the cards live one level deeper — so
    // the assertion compared 6 cards against 4 column children and failed on a correct layout.
    check('every card is a direct child of the grid',
      measure.cardCount === measure.gridChildren,
      `${measure.cardCount} cards / ${measure.gridChildren} grid children`)
    check('and the grid is the column\'s only card host',
      measure.columnCardHosts === 1,
      `${measure.columnCardHosts} element(s) in the column contain cards`)

    const heights = measure.cards.map((c) => c.h)
    const spread = heights.length === 0 ? 0 : Math.max(...heights) - Math.min(...heights)
    check('the cards are the same height', spread <= 1, `spread=${spread}px across ${heights.length} cards`)

    // READABILITY — the assertion that would have caught the layout I first shipped.
    //
    // I picked the column minimum by "mean visible fraction", which chose 6 columns of 212px: the
    // highest fraction (77%) and completely unreadable, because a 212px card fits about TEN Chinese
    // characters per line. The fraction was inflated by the layout itself — narrower cards wrap
    // more, so their content grows and the denominator grows with it.
    //
    // This measures characters per line directly, using the card body's own font metrics, so a
    // layout that trades readability for a prettier ratio fails here. 18 is the floor: below that,
    // normal Chinese prose wraps mid-phrase (20-40 chars/line is the ordinary range).
    const perLine = await page.evaluate(`(${access})((doc, win) => {
      const out = []
      for (const body of doc.querySelectorAll('.cardGrid > .card .cardBody')) {
        const cs = win.getComputedStyle(body)
        const probe = doc.createElement('span')
        probe.textContent = '目标看板数据接入状态验证'
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:' + cs.fontSize +
          ';font-family:' + cs.fontFamily + ';font-weight:' + cs.fontWeight
        body.appendChild(probe)
        const textW = probe.getBoundingClientRect().width
        probe.remove()
        const inner = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        out.push(textW === 0 ? 0 : Math.floor(inner / (textW / 12)))
      }
      return out
    })`)
    const worst = perLine.length === 0 ? 0 : Math.min(...perLine)
    check('every card fits at least 18 characters per line', worst >= 18,
      `narrowest card fits ${worst} chars/line (all: ${perLine.join(', ')})`)

    // 4 — each card body owns its own scrolling.
    check('every card body can scroll its own overflow',
      measure.cards.every((c) => c.bodyOverflow === 'auto'),
      measure.cards.map((c) => c.bodyOverflow).join(','))

    // …and PROVE the scroll actually works, with a positive control rather than hoping the
    // fixture is tall enough.
    //
    // This used to read `measure.cards.some((c) => c.bodyScroll > c.bodyClient + 1)` — i.e. it
    // asserted that the CURRENT fixture happened to overflow. That is not a property of the
    // design, it is a property of the sample: the check passed at 1100×800 and failed at
    // 1630×984 purely because the cards got taller, and its own message admitted the problem
    // ("the fixture may be too small to prove the scroll works"). An assertion whose truth
    // depends on how much text the fixture contains cannot distinguish "scrolling is broken"
    // from "there was not enough text today".
    //
    // So: push a deliberately long block into a card body, measure, then remove it. The card
    // must scroll internally AND the page must still not scroll — the two halves of the actual
    // requirement, both of which can now fail.
    const control = await page.evaluate(`(${access})((doc, win) => {
      const body = doc.querySelector('.cardGrid > .card .cardBody')
      if (body === null) return { none: true }
      const filler = doc.createElement('div')
      filler.id = 'probeFiller'
      // Far taller than any viewport, so the body MUST clip and scroll.
      for (let i = 0; i < 120; i += 1) {
        const p = doc.createElement('p')
        p.textContent = '探针填充行 ' + i + ' —— 用来把卡片正文撑到超过卡片高度。'
        filler.appendChild(p)
      }
      body.appendChild(filler)
      const sc = doc.querySelector('.scroll')
      const col = doc.querySelector('.column')
      const out = {
        bodyClient: body.clientHeight,
        bodyScroll: body.scrollHeight,
        bodyOverflow: win.getComputedStyle(body).overflowY,
        pageScroll: sc.scrollHeight,
        pageClient: sc.clientHeight,
        pageOverflow: win.getComputedStyle(sc).overflowY,
        colScrollHeight: col.scrollHeight,
        colClientHeight: col.clientHeight,
      }
      filler.remove()
      return out
    })`)
    if (control.none === true) {
      check('the positive control found a card body to fill', false, 'no .cardGrid > .card .cardBody')
    } else {
      check('POSITIVE CONTROL: a card body given long content really does scroll',
        control.bodyScroll > control.bodyClient + 1 && control.bodyOverflow === 'auto',
        `content ${control.bodyScroll}px in ${control.bodyClient}px, overflow-y=${control.bodyOverflow}`)
      // …and the page still must not grow. This is the half that would break if the card body
      // stopped absorbing the overflow and let it push the column instead.
      check('and the page STILL does not scroll while that card overflows',
        control.pageScroll <= control.pageClient + 1,
        `page ${control.pageScroll}px in ${control.pageClient}px`)
    }
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
