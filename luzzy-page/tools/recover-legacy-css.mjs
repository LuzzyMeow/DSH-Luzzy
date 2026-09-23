// One-off: recover the stylesheet rules the v2 migration dropped.
//
// WHAT WENT WRONG
//
// The v2 refactor split the frame's single inline <style> block into three files
// (tokens / layout / components) and rewrote them against the new --lz-* token layer. The
// rewrite covered the NEW pages, and quietly left behind the CSS the OLD pages still use:
// the whole preset editor (md* / roster*), the chart chrome (chartDot / chartHits / donut*),
// and a few shared bits (nextList / proposal / saveState / field*).
//
// A missing selector is SILENT — no error, the page just renders unstyled. Only a class-usage
// diff catches it, which is what tools/probe-unstyled-classes.mjs does.
//
// This script takes the ORIGINAL rule text verbatim from git HEAD and appends the missing
// rules, so the recovered styles are exactly the ones that shipped rather than a retyped
// approximation.
//
// Usage: node tools/recover-legacy-css.mjs [--apply]

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './frame-source.mjs'

const apply = process.argv.includes('--apply')

// ---- the original stylesheet, from the last commit that had the single-file page
let original = ''
try {
  original = execFileSync('git', ['show', 'HEAD:luzzy-page/src/client.js'], {
    cwd: join(PLUGIN_ROOT, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (error) {
  console.error('cannot read the previous src/client.js from git:', error.message)
  process.exit(1)
}

const styleStart = original.indexOf('<style>')
const styleEnd = original.indexOf('</style>')
if (styleStart < 0 || styleEnd < 0) {
  console.error('the previous revision has no <style> block')
  process.exit(1)
}
const originalCss = original.slice(styleStart + '<style>'.length, styleEnd)

// ---- what the three new stylesheets define
const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'manifest.json'), 'utf8'))
let currentCss = ''
for (const name of manifest.styles) currentCss += readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8')

// ---- which classes the frame markup uses
const frame = readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'frame.html'), 'utf8')
let modules = ''
for (const name of manifest.modules) modules += readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8')
const corpus = frame + modules

const used = new Set()
for (const m of corpus.matchAll(/class="([^"']+)"/g)) {
  for (const name of m[1].split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(name)) used.add(name)
}

const missing = [...used].filter((name) => !currentCss.includes('.' + name)).sort()

// ---- pull the matching rules out of the original stylesheet
//
// A rule is "matching" when its selector mentions a missing class. Comments that sit directly
// above a kept rule are kept too, because they explain WHY the rule is shaped that way and
// that reasoning is the expensive part to reconstruct.
function rulesFor(names) {
  const out = []
  const wanted = new Set(names)
  // Walk the CSS as: [leading comments][selector block][declarations]
  const ruleRe = /(\/\*[\s\S]*?\*\/\s*)?([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = ruleRe.exec(originalCss)) !== null) {
    const comment = match[1] ?? ''
    const selector = match[2].trim()
    const body = match[3]
    if (selector.startsWith('@')) continue
    const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
    if (classes.length === 0) continue
    if (!classes.some((name) => wanted.has(name))) continue
    out.push(`${comment}${selector} {${body}}`)
  }
  return out
}

const recovered = rulesFor(missing)

// De-duplicate rules that differ only in whitespace.
const seen = new Set()
const unique = recovered.filter((rule) => {
  const key = rule.replace(/\s+/g, ' ').trim()
  if (seen.has(key)) return false
  seen.add(key)
  return true
})

console.log(`classes used by the markup:      ${used.size}`)
console.log(`classes defined by the new CSS:  ${used.size - missing.length}`)
console.log(`classes MISSING a definition:    ${missing.length}`)
if (missing.length > 0) console.log(`  ${missing.join(', ')}`)
console.log(`rules recovered from git HEAD:   ${unique.length}`)

if (!apply) {
  console.log('\n(dry run — pass --apply to append them to src/styles/components.css)')
  process.exit(0)
}

const HEADER = `

/* ============================================================ 从旧版恢复的规则
 *
 * 这些规则由 tools/recover-legacy-css.mjs **从 git HEAD 的原始样式表原样取出**，不是重写的。
 *
 * 来历：v2 重构把帧的单一样式块拆成 tokens / layout / components 三份，并按新的 --lz-*
 * token 层重写了它们。重写覆盖了**新页面**，却悄悄漏掉了**旧页面仍在用的部分**——
 * 整个预设编辑器（md* / roster*）、图表部件（chartDot / chartHits / donut*）、
 * 以及若干共用件（nextList / proposal / saveState / field*）。
 *
 * 少一条选择器是**静默**的：不报错，页面只是没样式。只有类名使用差分能发现它，
 * 那正是 tools/probe-unstyled-classes.mjs 在做的事。
 *
 * 取值暂留旧 token：这段代码的正确性靠「与原版逐字相同」来保证，改写取值会引入没人验过的
 * 视觉变化。等它们被新页面取代时再逐条迁移。
 */

`

const target = join(PLUGIN_ROOT, 'src', 'styles', 'components.css')
const existing = readFileSync(target, 'utf8')
if (existing.includes('从旧版恢复的规则')) {
  console.log('\nsrc/styles/components.css already carries recovered rules — nothing written')
  process.exit(0)
}
writeFileSync(target, existing + HEADER + unique.join('\n\n') + '\n', 'utf8')
console.log(`\nwrote ${target}`)
