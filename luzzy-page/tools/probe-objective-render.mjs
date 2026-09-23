// What does objectiveText ACTUALLY render for a long objective? Compile it out of the source
// and print the HTML — the decisive check for the fold, without depending on the offline
// harness reaching its goal fixture.
//
// Usage: node tools/probe-objective-render.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'components', 'Format.js')
const source = readFileSync(SRC, 'utf8')

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

// eslint-disable-next-line no-new-func
const objectiveText = new Function(`${lift('esc')}\n${lift('objectiveText')}\nreturn objectiveText;`)()

const short = '把 Settings 页改造成新的 Dashboard'
const long = [
  'DSH Goal 强制驱动与高质量交付系统实施方案',
  '目标读者：实现该功能的 Coding Agent。',
  '',
  '---',
  '0. 执行摘要',
  '需要构建的是 Goal Delivery Control Plane。',
].join('\n')

for (const [label, text] of [['short', short], ['long', long]]) {
  const html = objectiveText(text)
  const folded = html.includes('objectiveRest')
  console.log(`\n=== ${label} (${text.length} chars) — folded=${folded} ===`)
  console.log(html.slice(0, 420))
}

// The decisive property: for a long objective the newlines must SURVIVE into the output as
// real newlines (the CSS then preserves them). If they were collapsed the block reads as one
// paragraph — the exact shape in the user's screenshot.
const longHtml = objectiveText(long)
const innerMatch = longHtml.match(/<div class="objectiveFull">([\s\S]*?)<\/div>/)
console.log('\n=== does the folded body keep the line breaks? ===')
if (innerMatch === null) {
  console.log('  FAIL — no objectiveFull body found')
  process.exit(1)
}
const body = innerMatch[1]
console.log(`  newlines in the folded body: ${(body.match(/\n/g) ?? []).length}`)
console.log(`  contains the --- separator  : ${body.includes('---')}`)
console.log(`  contains section 0 heading  : ${body.includes('0. 执行摘要')}`)
console.log(`  escaped, not raw HTML       : ${!body.includes('<') || body.includes('&lt;')}`)
