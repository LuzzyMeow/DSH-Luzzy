// Does the embedded CJK face cover what the console ACTUALLY renders at runtime?
//
// tools/build-font-css.py subsets the CJK face to the non-ASCII characters found under src/
// plus README.md. Everything the console draws from LIVE data — goal objectives, task titles,
// acceptance criteria, evidence lines, prompts, session titles — arrives at runtime and was
// never in that scan.
//
// A glyph the face lacks does not error. The browser falls back per-character, MID-SENTENCE,
// to a system font with different metrics and weight. The only symptom is text that looks
// slightly wrong, which is precisely the complaint this script exists to settle.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const SRC = join(ROOT, 'src')
const SUFFIXES = ['.js', '.css', '.html', '.json']

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// ---- glyph set the build bakes into the face ----
const scanned = walk(SRC).filter((p) => SUFFIXES.some((s) => p.endsWith(s)))
scanned.push(join(ROOT, 'README.md'))
const inFace = new Set()
for (const p of scanned) {
  for (const ch of readFileSync(p, 'utf8')) {
    if (ch.codePointAt(0) >= 0x80 && !/\s/.test(ch)) inFace.add(ch)
  }
}
console.log(`the embedded CJK face carries ${inFace.size} non-ASCII glyphs (subsets from src/ + README.md)`)

// ---- text the console actually draws, taken from the live goal artifact ----
let live = ''
try {
  // The goal artifact as the runtime wrote it, straight out of the session store.
  live = execFileSync('node', [join(ROOT, 'tools', 'aoci-mcp-client.mjs'), '--help'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })
} catch { /* this probe does not need AOCI; fall through to the files below */ }

const candidates = [
  join(ROOT, 'docs', 'STATUS-LuzzyPage工作节点.md'),
  join(ROOT, 'README.md'),
  join(homedir(), '.dsh', 'luzzy-goal'),
]
const runtimeTexts = []
for (const c of candidates) {
  try {
    const st = statSync(c)
    if (st.isDirectory()) {
      for (const f of walk(c)) {
        if (f.endsWith('.md') || f.endsWith('.json')) runtimeTexts.push([f, readFileSync(f, 'utf8')])
      }
    } else {
      runtimeTexts.push([c, readFileSync(c, 'utf8')])
    }
  } catch { /* optional */ }
}

console.log(`\nchecking ${runtimeTexts.length} file(s) of LIVE text the console renders:`)
let worst = null
for (const [file, text] of runtimeTexts) {
  const cjk = [...text].filter((c) => c.codePointAt(0) >= 0x80 && !/\s/.test(c))
  const miss = new Set(cjk.filter((c) => !inFace.has(c)))
  const pct = cjk.length === 0 ? 0 : (miss.size / new Set(cjk).size) * 100
  const label = file.replace(ROOT + '\\', '').replace(homedir(), '~')
  console.log(`  ${label}`)
  console.log(`      ${new Set(cjk).size} distinct non-ASCII, ${miss.size} MISSING (${pct.toFixed(1)}% of distinct glyphs)`)
  if (miss.size > 0 && (worst === null || miss.size > worst.miss.size)) worst = { label, miss }
}

if (worst) {
  console.log(`\nworst: ${worst.label}`)
  const list = [...worst.miss]
  console.log(`  ${list.length} characters fall back to a system font, e.g.`)
  for (let i = 0; i < Math.min(list.length, 120); i += 30) {
    console.log('    ' + list.slice(i, i + 30).join(''))
  }
}
process.exitCode = worst ? 1 : 0
