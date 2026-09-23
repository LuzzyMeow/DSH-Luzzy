// What does objectiveText ACTUALLY render for a long objective? Compile it out of the source
// and print the HTML — the decisive check for the handoff, without depending on the offline
// harness reaching its goal fixture.
//
// Usage: node tools/probe-objective-render.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src', 'components', 'Format.js')
const source = readFileSync(SRC, 'utf8')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// Lift `esc` and `objectiveText` and compile them together.
function lift(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`cannot find ${name}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced ${name}`)
}

// objectiveText builds its button through LZ.Card.btnBar, so the compiled function needs an LZ.
// The stand-in echoes `attrs` verbatim, exactly like the real one does (Card.js:93 writes
// `item.attrs` straight onto the button) — a stub that swallowed the attrs would make this probe
// structurally unable to see the data-viewer contract, which is the one thing it is here to check.
const buttons = []
const LZ = {
  Card: {
    btnBar: (items) => {
      buttons.push(items[0])
      return `<btnBar class="btnSmall"${items[0].attrs ? ` ${items[0].attrs}` : ''}>${items[0].label}</btnBar>`
    },
  },
}

// eslint-disable-next-line no-new-func
const objectiveText = new Function('LZ', `${lift('esc')}\n${lift('objectiveText')}\nreturn objectiveText;`)(LZ)

const short = '把 Settings 页改造成新的 Dashboard'
const long = [
  'DSH Goal 强制驱动与高质量交付系统实施方案',
  '目标读者：实现该功能的 Coding Agent。',
  '',
  '---',
  '0. 执行摘要',
  '需要构建的是 Goal Delivery Control Plane。',
].join('\n')

const rendered = {}
for (const [label, text] of [['short', short], ['long', long]]) {
  const html = objectiveText(text)
  rendered[label] = html
  console.log(`\n=== ${label} (${text.length} chars) ===`)
  console.log(html.slice(0, 420))
}

console.log('\n=== where does the full text go? ===')
// The decisive property, and the one the user's screenshot was about: the LONG objective must
// NOT be in the page at all. It used to be dropped into an in-page fold — a second scroll box
// inside an already scrolling page, which is exactly the「断层」the screenshot shows.
check('the short objective is rendered in full, in place',
  rendered.short.includes(short) && !rendered.short.includes('data-viewer'))
check('the long objective does NOT put its body in the page',
  !rendered.long.includes('0. 执行摘要') && !rendered.long.includes('需要构建的是'),
  '正文又落回页面里了')
check('it hands off to the viewer instead',
  rendered.long.includes('data-viewer="objective"') && buttons.length === 1)
check('the button says how much is behind it',
  buttons.length === 1 && buttons[0].label.includes(String(long.length)),
  buttons[0] === undefined ? 'no button rendered' : buttons[0].label)
// The emphasis block keeps the FIRST LINE as the summary — not the whole document, and not the
// collapsed whitespace of one either.
const head = rendered.long.match(/<div class="focusBox">([\s\S]*?)<\/div>/)
check('the page keeps only the first line as the summary',
  head !== null && !head[1].includes('\n') && head[1] === long.split('\n')[0],
  head === null ? 'no focusBox' : JSON.stringify(head[1].slice(0, 60)))

// And the other half of the property: wherever the full text IS shown, newlines must survive.
// That is now the viewer — so read the two things that make it true, and print them.
const app = readFileSync(join(ROOT, 'src', 'app', 'app.js'), 'utf8')
const css = readFileSync(join(ROOT, 'src', 'styles', 'components.css'), 'utf8')
console.log('\n=== does the viewer keep the line breaks? ===')
check('the viewer prints the raw text, escaped',
  /kind === 'objective'[\s\S]{0,400}?class="viewerText"/.test(app))
check('and .viewerText preserves whitespace',
  /\.viewerText\s*\{[^}]*white-space:\s*pre-wrap/.test(css))
check('the dialog content owns the only scroll layer',
  /\.dialogContent\s*\{[^}]*overflow-y:\s*auto/.test(css) && /\.dialogContent\s*\{[^}]*min-height:\s*0/.test(css))

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} assertion(s)`)
  process.exit(1)
}
console.log('PASS — long objectives leave the page and reach a single-scroll viewer')
