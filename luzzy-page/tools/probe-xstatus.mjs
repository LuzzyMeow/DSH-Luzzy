// Why does the "read but never written" guard still see `xStatus`?
//
// `xStatus` exists ONLY inside a JSDoc comment in src/app/app.js. The guard strips comments
// before scanning, so it should not be visible. Either the stripper is misaligning, or the
// text is reachable some other way. Print the facts instead of guessing.
//
// Usage: node tools/probe-xstatus.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..', 'src', 'app', 'app.js')
const text = readFileSync(APP, 'utf8')

// Same two strips as tools/test-view-models.mjs, in the same order.
const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

console.log(`raw      contains xStatus : ${text.includes('xStatus')}`)
console.log(`stripped contains xStatus : ${stripped.includes('xStatus')}`)

const at = stripped.indexOf('xStatus')
if (at >= 0) {
  console.log('')
  console.log('reachable context:')
  console.log(JSON.stringify(stripped.slice(Math.max(0, at - 200), at + 120)))
}

// Where do block comments *actually* end? A `*/` that appears inside a string literal (or
// inside a URL) closes the non-greedy match early, which would leave the following comment
// body in the stripped text.
const blockStarts = [...text.matchAll(/\/\*/g)].map((m) => m.index)
const blockEnds = [...text.matchAll(/\*\//g)].map((m) => m.index)
console.log('')
console.log(`block-comment starts /* : ${blockStarts.length}`)
console.log(`block-comment ends   */ : ${blockEnds.length}`)
console.log(`balanced: ${blockStarts.length === blockEnds.length}`)

if (blockStarts.length !== blockEnds.length) {
  const line = (index) => text.slice(0, index).split('\n').length
  console.log('')
  console.log('UNBALANCED — locate the stray marker:')
  for (let i = 0; i < Math.max(blockStarts.length, blockEnds.length); i += 1) {
    const s = blockStarts[i]
    const e = blockEnds[i]
    if (s === undefined || e === undefined || e < s) {
      console.log(`  index ${i}: start=${s === undefined ? 'none' : `${s} (L${line(s)})`} end=${e === undefined ? 'none' : `${e} (L${line(e)})`}`)
    }
  }
}

// Show the first few comment spans the stripper would remove, with their line numbers.
console.log('')
console.log('first 3 spans the stripper removes:')
const line = (index) => text.slice(0, index).split('\n').length
const spans = [...text.matchAll(/\/\*[\s\S]*?\*\//g)].slice(0, 3)
for (const span of spans) {
  console.log(`  L${line(span.index)}–L${line(span.index + span[0].length)}  ${JSON.stringify(span[0].slice(0, 60))}`)
}
