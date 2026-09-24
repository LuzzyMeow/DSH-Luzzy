// Does anything the console renders fall back to a font we did not intend?
//
// HISTORY, because the answer changed shape.
//
// This probe used to compute the CJK subset the build baked into the frame and diff it against live
// text — and it found real gaps (up to 81 characters, 9.5% of a goal file's distinct glyphs). That
// was the right check for that design. Subsetting was then removed entirely: the frame ships Latin
// (Inter + JetBrains Mono) and CJK comes from the OPERATING SYSTEM, which is what the reference
// does (`"Inter Variable", -apple-system, "PingFang SC", "Hiragino Sans GB", "Segoe UI"`).
//
// So "which glyphs are in the face" is no longer a question that can have a bad answer — there is
// no subset to be incomplete. Checking live text against a subset that no longer exists would
// report phantom gaps forever, which is worse than no check: it would train a reader to ignore it.
//
// The invariant that DOES still matter, and that this now asserts:
//
//   1. the frame declares NO CJK subset face (so no glyph can be missing from one), and
//   2. the font stack names real OS CJK families, in an order that ends somewhere CJK-capable —
//      a stack that forgot them would fall back to a Latin-only face and render 豆腐.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')

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

// The shipped frame bundle, which is where the @font-face rules and the stack end up.
const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

console.log('1. the frame declares no CJK subset face')

// Every inlined face must be a Latin/mono face. A CJK face in here would mean subsetting came back
// — and with it, the possibility of a character the subset happens not to contain.
const faces = [...bundle.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0])
check('the frame declares at least one face', faces.length > 0, String(faces.length))
const families = faces.map((block) => (block.match(/font-family:\s*'([^']+)'/) || [])[1]).filter(Boolean)
console.log(`     families: ${[...new Set(families)].join(', ')}`)
check('every inlined face is Latin or mono, not CJK',
  families.every((name) => /Inter|JetBrains/.test(name)),
  families.join(', '))
check('no face is described as a subset',
  !/subset/i.test(bundle.slice(0, 4000)),
  'the build banner still mentions subsetting')

console.log('\n2. the font stack names OS CJK families')

// The stack is written across two lines in tokens.css, so it must be read from the SOURCE with
// the newline folded out — matching one line in the bundle truncates it and then reports the
// truncation as a missing family. (First version did exactly that: it "found" no Windows family
// and no trailing generic in a stack that has both.)
const tokensSource = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
const stack = (tokensSource.match(/--lz-font-sans:\s*([\s\S]*?);/) || [])[1]
console.log(`     --lz-font-sans: ${stack === undefined ? '(not found)' : stack.replace(/\s+/g, ' ').trim()}`)
check('the stack is defined where the frame reads it', bundle.includes('PingFang SC') && bundle.includes('Microsoft YaHei'),
  'the built bundle does not carry the CJK families')
if (stack !== undefined) {
  const flat = stack.replace(/\s+/g, ' ').trim()
  // The reference's own order: Inter first, then the OS families.
  check('it leads with Inter (Latin from a real webfont)', /^'Inter Variable'/.test(flat), flat)
  check('it names a macOS CJK family', /PingFang SC|Hiragino Sans GB/.test(flat), flat)
  check('it names a Windows CJK family', /Microsoft YaHei|Segoe UI/.test(flat), flat)
  // `sans-serif` last is what saves a machine with none of the named families.
  check('it ends with the generic family, so a machine without any named CJK face still resolves',
    /sans-serif$/.test(flat), flat)
}

console.log('\n3. no shipped source still references the removed faces')
const stale = []
for (const name of readdirSync(join(ROOT, 'src', 'styles'))) {
  const path = join(ROOT, 'src', 'styles', name)
  if (!statSync(path).isFile()) continue
  // Comments are allowed to discuss the history — only real declarations count.
  const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  if (/Luzzy Sans|Luzzy PuHuiTi/.test(css)) stale.push(name)
}
check('no stylesheet still asks for the deleted families', stale.length === 0, stale.join(', '))

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} check(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} checks (no reachable font fallback hole)`)
