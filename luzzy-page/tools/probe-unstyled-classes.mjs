// One-off: which CSS classes does the frame's markup use, and which are actually styled?
//
// The v2 refactor moved the frame's CSS out of one inline <style> block into three files.
// Anything the markup uses but the stylesheets do not define renders unstyled — and that is
// SILENT: no error, just a page that looks wrong. This diff is what turned up 53 classes the
// refactor had dropped (recovered by tools/recover-legacy-css.mjs).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './frame-source.mjs'

const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'manifest.json'), 'utf8'))

let corpus = readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'frame.html'), 'utf8')
for (const name of manifest.modules) corpus += readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8')

let css = ''
for (const name of manifest.styles) css += readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8')

const used = new Set()
// Static class attributes only. Concatenated expressions ('class="btn ' + item.variant + '"')
// are skipped deliberately: their fragments are not literal class names, and treating them as
// such reports `(item.variant` and `:` as "unstyled classes" — false positives that bury the
// real findings.
for (const m of corpus.matchAll(/class="([^"'`+]+)"/g)) {
  for (const name of m[1].split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(name)) used.add(name)
}
for (const m of corpus.matchAll(/classList\.(?:add|toggle|remove)\('([\w-]+)'/g)) used.add(m[1])
for (const m of corpus.matchAll(/className = '([\w-]+(?: [\w-]+)*)'/g)) {
  for (const name of m[1].split(/\s+/)) if (name) used.add(name)
}

// A class with no rule is only a problem if it is not a bare structural hook. `chartHits` is a
// <g> wrapper that the ORIGINAL stylesheet did not style either, so it is allowlisted WITH its
// reason rather than silently ignored — an allowlist entry should say why it is safe.
const NO_STYLE_BY_DESIGN = new Map([
  ['chartHits', 'a bare <g> grouping element; the original stylesheet did not style it either'],
])

const unstyled = [...used]
  .filter((name) => !css.includes('.' + name))
  .filter((name) => !NO_STYLE_BY_DESIGN.has(name))
  .sort()

console.log(`classes used in markup: ${used.size}`)
console.log(`unstyled: ${unstyled.length}`)
for (const name of unstyled) console.log('  ' + name)
if (unstyled.length > 0) process.exit(1)
console.log('PASS — every class used by the markup has a rule')
