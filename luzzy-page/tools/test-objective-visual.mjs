// Does the delivered console meet every claim the objective names?
//
// The objective enumerates specific things: a warm-paper neutral with violet accent, a
// 13/14/16/18/24/30 scale with body text 14-16px, 8/12/16 radii, restrained 1px borders with small
// shadows instead of heavy glass, Inter + JetBrains Mono, no CJK subset fallback hole, and
// rendering at 1630x984 actually looked at.
//
// Each line below maps to one of those, is measured rather than read, and CAN fail — that is the
// whole point of collecting them in one place instead of trusting a dozen separate probes that may
// be measuring different documents (which is how this list came to exist: the probes disagreed
// with the screenshots for most of a round).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failures = 0
let checks = 0
function check(label, ok, detail = '') {
  checks += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

console.log('objective: warm paper neutral + violet accent')
{
  const tokens = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
  const value = (name) => (tokens.match(new RegExp(`${name}:\\s*([^;]+)`)) || [])[1]?.trim()
  check('canvas is the warm paper surface', value('--lz-bg-layout') === '#faf9f7', String(value('--lz-bg-layout')))
  check('cards are solid white', value('--lz-bg-container') === '#ffffff', String(value('--lz-bg-container')))
  check('the accent is violet, not near-black', value('--lz-accent') === '#6b5ce7', String(value('--lz-accent')))
  check('the hairline is the reference warm grey', value('--lz-line') === '#e8e5e0', String(value('--lz-line')))
}

console.log('\nobjective: the 13/14/16/18/24/30 scale')
{
  const tokens = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
  const sizes = [...tokens.matchAll(/--lz-font-[a-z0-9]+:\s*(\d+)px/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
  check('the scale is exactly the reference six steps', sizes.join(',') === '13,14,16,18,24,30', sizes.join(','))
  check('no step is duplicated', new Set(sizes).size === sizes.length, sizes.join(','))
  const base = Number((tokens.match(/--lz-font-base:\s*(\d+)px/) || [])[1])
  check('body text is in the 14-16px band the objective names', base >= 14 && base <= 16, `${base}px`)
}

console.log('\nobjective: 8/12/16 radii')
{
  const tokens = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
  const radii = [...tokens.matchAll(/--lz-radius[a-z-]*:\s*(\d+)px/g)].map((m) => Number(m[1]))
  for (const wanted of [8, 12, 16]) check(`the scale includes ${wanted}px`, radii.includes(wanted), radii.join(','))
  check('no radius step is duplicated', new Set(radii).size === radii.length, radii.join(','))
}

console.log('\nobjective: 1px borders and small shadows, NOT heavy glass')
{
  const css = readFileSync(join(ROOT, 'src', 'styles', 'components.css'), 'utf8')
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  check('the card has a 1px hairline border', /\.card\s*\{[^}]*border:\s*1px solid/.test(rules))
  check('the card does NOT blur what is behind it', !/\.card\s*\{[^}]*backdrop-filter/.test(rules),
    'a card with backdrop-filter is the old glass design')
  const cardRule = (rules.match(/\.card\s*\{[^}]*\}/) || [''])[0]
  check('the card shadow is the small step, not the modal one',
    /--lz-shadow-card/.test(cardRule), cardRule.slice(0, 80))
}

console.log('\nobjective: Inter + JetBrains Mono, and no CJK fallback hole')
{
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const tokens = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
  const stack = (tokens.match(/--lz-font-sans:\s*([\s\S]*?);/) || [])[1]?.replace(/\s+/g, ' ').trim()
  check('Inter leads the stack', /^'Inter Variable'/.test(String(stack)), String(stack).slice(0, 60))
  check('a mono face is declared', /JetBrains Mono/.test(tokens))
  check('both faces are inlined into the frame', /Inter Variable/.test(bundle) && /JetBrains Mono Variable/.test(bundle))
  check('the OS supplies CJK', /PingFang SC/.test(String(stack)) && /Microsoft YaHei/.test(String(stack)))
  check('no CJK subset face is inlined (so no glyph can be missing)',
    ![...bundle.matchAll(/@font-face\s*\{[^}]*\}/g)].some((m) => /Luzzy PuHuiTi|PuHuiTi/.test(m[0])))
}

console.log('\nobjective: every sub-page rendered at 1630x984 and looked at')
{
  const result = spawnSync('python', [join(HERE, 'render-all-pages.py')], { cwd: ROOT, encoding: 'utf8' })
  const said = `${result.stdout ?? ''}${result.stderr ?? ''}`
  check('all four pages render, distinct, at the real panel size', /PASS/.test(said),
    said.trim().split('\n').slice(-1)[0])
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} check(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} checks (every claim the objective names)`)
