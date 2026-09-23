// One-off: find the first unbalanced delimiter in a JS file, with a scanner that skips
// strings, template literals, comments and regex literals.
//
// A naive brace counter is useless here: the frame code is full of braces inside strings and
// regexes, so it reports nonsense. This one only counts structural delimiters.
//
// Usage: node tools/find-unbalanced.mjs <file>

import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) throw new Error('usage: node tools/find-unbalanced.mjs <file>')
const src = readFileSync(file, 'utf8')
const lines = src.split('\n')

let i = 0
let line = 1
let brace = 0
let paren = 0
let bracket = 0
const braceLines = []

const canStartRegex = (prev) => prev === '' || /[=(,:[!&|?{};+\-*%^~<>]/.test(prev)

while (i < src.length) {
  const c = src[i]
  const n = src[i + 1]

  if (c === '\n') { line += 1; i += 1; continue }

  if (c === '/' && n === '/') {
    while (i < src.length && src[i] !== '\n') i += 1
    continue
  }
  if (c === '/' && n === '*') {
    i += 2
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
      if (src[i] === '\n') line += 1
      i += 1
    }
    i += 2
    continue
  }
  if (c === "'" || c === '"') {
    const quote = c
    i += 1
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') i += 1
      if (src[i] === '\n') line += 1
      i += 1
    }
    i += 1
    continue
  }
  if (c === '`') {
    i += 1
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') i += 1
      if (src[i] === '\n') line += 1
      i += 1
    }
    i += 1
    continue
  }
  if (c === '/') {
    const prev = src.slice(0, i).replace(/\s+$/, '').slice(-1)
    if (canStartRegex(prev)) {
      i += 1
      let inClass = false
      while (i < src.length && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i += 1
        if (src[i] === '[') inClass = true
        if (src[i] === ']') inClass = false
        if (src[i] === '\n') break
        i += 1
      }
      i += 1
      continue
    }
  }

  if (c === '{') { brace += 1; braceLines.push(line) }
  if (c === '}') { brace -= 1; braceLines.pop() }
  if (c === '(') paren += 1
  if (c === ')') {
    paren -= 1
    if (paren < 0) {
      console.log(`PAREN went negative at line ${line}:`)
      console.log(`  ${lines[line - 1]}`)
      break
    }
  }
  if (c === '[') bracket += 1
  if (c === ']') bracket -= 1

  i += 1
}

console.log(`\nfinal: brace=${brace} paren=${paren} bracket=${bracket} lines=${line}/${lines.length}`)
if (brace > 0) {
  console.log(`unclosed braces still open were opened at line(s): ${braceLines.join(', ')}`)
  for (const at of braceLines.slice(-3)) console.log(`  ${at}: ${lines[at - 1]}`)
}
