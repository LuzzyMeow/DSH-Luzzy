// Find RAW backticks inside the frame template literal of src/client.js.
//
// The frame document is a JS template literal, so an unescaped backtick anywhere inside it
// (even in a CSS or JS comment) ends the literal early and the rest of the page becomes
// syntax errors. The symptom is a blank frame, and the reported line is far from the real
// mistake — so this reports every offender at once instead of one per build.
//
// Usage: node tools/scan-frame-backticks.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(PLUGIN_ROOT, 'src', 'client.js'), 'utf8')

const BACKTICK = String.fromCharCode(96)
const OPEN = 'return ' + BACKTICK + '<!doctype html>'
// The literal always ends with this, so the TRUE closing delimiter can be located without
// guessing. (Walking to the first unescaped backtick is not enough: a raw backtick INSIDE
// the template would be mistaken for the closer, and the scan would then report success.)
const CLOSE = '</body></html>' + BACKTICK

const start = src.indexOf(OPEN)
if (start < 0) throw new Error('could not find the frame template literal in src/client.js')

const inner = start + OPEN.length

const end = src.indexOf(CLOSE, inner)
if (end < 0) throw new Error('could not find the end of the frame template literal')

const body = src.slice(inner, end)
const offenders = []
let line = src.slice(0, inner).split('\n').length
let escaped = false
for (let i = 0; i < body.length; i += 1) {
  const ch = body[i]
  if (ch === '\n') { line += 1; escaped = false; continue }
  if (escaped) { escaped = false; continue }
  if (ch === '\\') { escaped = true; continue }
  if (ch === BACKTICK) offenders.push({ line, text: body.slice(Math.max(0, i - 45), i + 25) })
}

const endLine = src.slice(0, end).split('\n').length
console.log(`frame template: lines ${src.slice(0, inner).split('\n').length} .. ${endLine}`)
if (offenders.length === 0) {
  console.log(`PASS — no raw backticks inside the frame template`)
} else {
  console.log(`FAIL — ${offenders.length} raw backtick(s) inside the frame template:`)
  for (const o of offenders) console.log(`  line ${o.line}: …${o.text.replace(/\n/g, '⏎')}…`)
  process.exit(1)
}
