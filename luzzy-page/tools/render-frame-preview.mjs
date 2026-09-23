// Render the frame document standalone and assert it is a valid, self-contained page.
//
// The frame is assembled from src/ by tools/build-font-css.py and shipped inside the bundle
// as a JSON string. This pulls the REAL document out of the built bundle — through the real
// component, via tools/frame-source.mjs — and writes it to disk, so what is inspected here is
// byte-for-byte what the browser receives. Reconstructing it from source would prove nothing
// about the build.
//
// Usage: node tools/render-frame-preview.mjs [--out path]

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadFrameBuilder, compileFrameScript, PLUGIN_ROOT } from './frame-source.mjs'

const { srcDoc: html, fontCss, frameLength } = loadFrameBuilder()

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = outIndex >= 0 ? args[outIndex + 1] : join(tmpdir(), 'luzzy-frame-preview.html')
writeFileSync(out, html, 'utf8')

// Structural assertions: the assembled document must be complete and self-contained.
const checks = [
  ['has doctype', html.startsWith('<!doctype html>')],
  ['has closing html', html.trimEnd().endsWith('</html>')],
  ['has the font faces', (html.match(/@font-face/g) ?? []).length === 4],
  ['has no external url', !/url\((?!data:)/.test(html)],
  ['has the script', html.includes("'use strict'")],
  ['no unresolved font marker', !html.includes('__FRAME_FONTS__')],
  ['no unresolved module marker', !html.includes('__MODULES__')],
  ['no unresolved style marker', !html.includes('__STYLES__')],

  // The frame is a separate document, so it must define the theme tokens itself; without
  // these every var() falls back to a hardcoded light value and dark mode silently breaks.
  ['frame defines the token layer', html.includes('--lz-text:') && html.includes(":root[data-theme='dark']")],
  ['frame defines the DSH token mirror', html.includes('--dsw-alias-label-primary:')],
  ['frame carries a theme attribute', /<html data-theme="(light|dark)">/.test(html)],

  // The black box: the frame must report its own stages, since a crash inside it is silent.
  ['frame has a flight recorder', html.includes('function report(stage, detail)') && html.includes("report('frame-boot'")],

  // ---- the five console pages + the two secondary entries
  ['tab container exists', html.includes('id="tabbar"')],
  ['content container exists', html.includes('id="content"')],
  ['notice container exists', html.includes('id="notice"')],
  ['app boots', html.includes('LZ.App.start()')],
]

for (const page of ['OverviewPage', 'GoalPage', 'RuntimePage', 'AgentPage', 'SystemPage', 'ReadmePage', 'PresetPage']) {
  checks.push([`page ${page} assembled`, html.includes(`LZ.${page} = `)])
}
for (const component of ['Card', 'StatusBadge', 'Progress', 'Timeline', 'TreeView', 'EmptyState', 'Markdown', 'Chart', 'Format']) {
  checks.push([`component ${component} assembled`, html.includes(`LZ.${component} = `)])
}
for (const service of ['GoalService', 'RuntimeService', 'AgentService']) {
  checks.push([`service ${service} assembled`, html.includes(`LZ.${service} = `)])
}

// ---- 目标中心's six required sections
checks.push(['goal: acceptance list', html.includes('function acceptanceBlock(')])
checks.push(['goal: task tree', html.includes('function taskBlock(') && html.includes('LZ.TreeView.tree(')])
checks.push(['goal: evidence', html.includes('function evidenceBlock(')])
checks.push(['goal: decisions', html.includes('function decisionBlock(')])
checks.push(['goal: history', html.includes('function historyBlock(')])
checks.push(['goal: overview', html.includes('function overviewBlock(')])

// ---- behaviour-carrying functions the suites lift by name
for (const signature of [
  'function renderMarkdown(src)',
  'function serializeMarkdown(root)',
  'function applyMarkdownTool(value, start, end, id)',
  'function smoothPath(points)',
  'function niceMax(v)',
  'function trendChart(series, slots, mode',
]) {
  checks.push([`liftable: ${signature}`, html.includes(signature)])
}

// ---- data layer boundaries
checks.push(['goal view model is built in a service', html.includes('LZ.GoalService.toView(')])
checks.push(['pages do not read raw backend fields', !/delivery\.acceptance\s*\.\s*map/.test(html)])

// ---- routes
for (const route of ['readme', 'usage', 'goal', 'preset', 'runtime']) {
  checks.push([`reads /__luzzy/${route}`, html.includes(`'/__luzzy/${route}`)])
}

// ---- the frame must not call native dialogs (they steal window focus and never return it)
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const nativeDialog = stripComments(html).match(/(?<![\w.$])(?:window\s*\.\s*)?(alert|confirm|prompt)\s*\(/g)
checks.push(['no native dialogs in code', nativeDialog === null])
checks.push(['an in-frame dialog exists', html.includes('function showDialog(spec)')])
checks.push(['closing a dialog returns focus to the page', html.includes('document.body.focus()')])

const compile = compileFrameScript(html)
checks.push([`frame script compiles (${compile.ok ? compile.lines + ' lines' : compile.error})`, compile.ok])

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed += 1
}

console.log()
console.log(`document: ${(frameLength / 1024).toFixed(0)} KB  (fonts ${(fontCss.length / 1024).toFixed(0)} KB)`)
console.log(`wrote: ${out}`)
if (failed > 0) {
  console.log(`\nFAIL — ${failed} structural check(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks.length} structural checks`)
