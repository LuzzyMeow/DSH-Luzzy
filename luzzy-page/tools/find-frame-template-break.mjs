// Find the unbalanced template literal the build's guard is complaining about.
//
// The build assembles the frame from src/ and then compiles it; "Unexpected token 'const'" from
// node means a template literal ended EARLY — i.e. some module contains an unescaped backtick
// (or an unbalanced ${...}). This walks each module and reports the backtick/brace balance per
// file, so the culprit is named instead of guessed.
//
// Usage: node tools/find-frame-template-break.mjs [--src <dir>]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const args = process.argv.slice(2)
const srcIndex = args.indexOf('--src')
const SRC = srcIndex >= 0 ? args[srcIndex + 1] : join(PLUGIN_ROOT, 'src')

const manifest = JSON.parse(readFileSync(join(SRC, 'app', 'manifest.json'), 'utf8'))

const BACKTICK = String.fromCharCode(96)

function survey(rel) {
  const text = readFileSync(join(SRC, rel), 'utf8')
  let backticks = 0
  let inTemplate = false
  let templateStart = 0
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const ch of line) {
      if (ch === BACKTICK) {
        backticks += 1
        if (!inTemplate) templateStart = i + 1
        inTemplate = !inTemplate
      }
    }
  })
  return { rel, backticks, odd: backticks % 2 === 1, templateStart, bytes: text.length }
}

console.log('module'.padEnd(34) + 'backticks  odd?')
const suspects = []
for (const rel of [...manifest.styles, ...manifest.modules]) {
  const stat = statSync(join(SRC, rel))
  if (!stat.isFile()) continue
  const info = survey(rel)
  const flag = info.odd ? '  <== ODD (unclosed)' : ''
  console.log(info.rel.padEnd(34) + String(info.backticks).padStart(6) + '     ' + flag)
  if (info.odd) suspects.push(info)
}

console.log('')
if (suspects.length === 0) {
  console.log('no module has an odd backtick count — the break is probably inside src/client.js itself')
} else {
  console.log(`odd-count module(s): ${suspects.map((s) => s.rel).join(', ')}`)
  for (const s of suspects) {
    console.log(`  ${s.rel}: an unclosed template literal opens near line ${s.templateStart}`)
  }
}

// src/client.js holds the OUTER bundle (the frame template itself).
{
  const outer = readFileSync(join(SRC, 'client.js'), 'utf8')
  const lines = outer.split('\n')
  let inTemplate = false
  let opens = []
  lines.forEach((line, i) => {
    for (const ch of line) {
      if (ch === BACKTICK) {
        if (!inTemplate) opens.push(i + 1)
        inTemplate = !inTemplate
      }
    }
  })
  console.log('')
  console.log(`src/client.js: ${opens.length} template literal(s) open at line(s) ${opens.join(', ')}`)
  console.log(`  left open at EOF: ${inTemplate}`)
}
