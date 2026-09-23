// Extract the frame document the plugin builds and render it standalone, to prove the
// template escaping produced a valid, self-contained HTML document.
//
// The iframe document is built inside a template literal, so backticks and escapes are
// easy to get subtly wrong — and the failure only shows up as a blank frame. This pulls
// the real function out of the built bundle and runs it.
//
// Usage: node tools/render-frame-preview.mjs [--out path]

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

// Pull the two real pieces out of the shipped bundle: the font CSS and the frame builder.
// The bundle uses CRLF line endings, so pair backticks instead of matching newlines.
function templateAfter(marker) {
  const start = bundle.indexOf(marker)
  if (start < 0) return ''
  const open = bundle.indexOf('`', start)
  if (open < 0) return ''
  const close = bundle.indexOf('`', open + 1)
  if (close < 0) return ''
  return bundle.slice(open + 1, close)
}

const fontCss = templateAfter('const FONT_FACE_CSS')
if (fontCss.trim() === '') throw new Error('could not extract FONT_FACE_CSS from the bundle')

const fnStart = bundle.indexOf('function buildFrameDocument(')
if (fnStart < 0) throw new Error('buildFrameDocument not found in the bundle')
// Brace-match to the end of the function.
let depth = 0
let end = -1
for (let i = bundle.indexOf('{', fnStart); i < bundle.length; i += 1) {
  if (bundle[i] === '{') depth += 1
  else if (bundle[i] === '}') {
    depth -= 1
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
if (end < 0) throw new Error('could not find the end of buildFrameDocument')

const fnSource = bundle.slice(fnStart, end)
const buildFrameDocument = new Function(`${fnSource}; return buildFrameDocument`)()

const html = buildFrameDocument(fontCss)

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = outIndex >= 0 ? args[outIndex + 1] : join(tmpdir(), 'luzzy-frame-preview.html')
writeFileSync(out, html, 'utf8')

// Structural assertions: the escaped template must have produced a real document.
const checks = [
  ['has doctype', html.startsWith('<!doctype html>')],
  ['has closing html', html.trimEnd().endsWith('</html>')],
  ['has the font faces', (html.match(/@font-face/g) ?? []).length === 4],
  ['has the tab bar', html.includes('data-tab="readme"') && html.includes('data-tab="usage"')],
  ['has the script', html.includes("'use strict'")],
  ['markdown: backtick regex survived', html.includes('replace(/`([^`]+)`/g')],
  ['markdown: newline split survived', html.includes("split('\\n')")],
  ['has fetch to readme', html.includes("fetch('/__luzzy/readme')")],
  // The usage fetch carries no unit any more: one payload returns every window, and the
  // window is switched client-side.
  ['has fetch to usage', html.includes("'/__luzzy/usage'") && !html.includes("usage?unit=")],
  ['no unresolved placeholder', !html.includes('__FONT_FACE_CSS__')],
  // The frame is a separate document, so it must define the theme tokens itself; without
  // these every var(--dsw-*) would fall back to a hardcoded light value.
  ['frame defines theme tokens', html.includes('--dsw-alias-label-primary:') && html.includes(":root[data-theme='dark']")],
  ['frame carries a theme attribute', /<html data-theme="(light|dark)">/.test(html)],
  // The black box: the frame must report its own stages, since a crash inside it is silent.
  ['frame has a flight recorder', html.includes('function report(stage, detail)') && html.includes("report('frame-boot'")],
  ['usage fetch has an abort timeout', html.includes('AbortController') && html.includes('90000')],
  // The trend chart is a multi-series smooth curve over a natural window.
  ['trend chart uses smoothing', html.includes('function smoothPath(')],
  ['trend chart plots per model', /function trendChart\(series, slots, mode/.test(html)],
  ['future slots are blank, not zero', html.includes('isFuture') && html.includes('cellFuture')],
  ['series cap is labelled', html.includes('其他模型')],
  // There must be no hourly window option: the window is a natural unit.
  ['no hourly window option', !html.includes("'hour'")],
  // The buttons are built from a data array at render time, so assert the array's contents
  // rather than a rendered attribute that never appears in the source text.
  ['windows are day/week/month', /\[\['day',\s*'日'\],\s*\['week',\s*'周'\],\s*\['month',\s*'月'\]\]/.test(html)],

  // ---- hover tooltip
  ['chart has a hover layer', html.includes('function wireChartHover(') && html.includes('class="chartHit"')],
  ['tooltip markup exists', html.includes('class="chartTip"') && html.includes('chartTipHtml')],
  ['hover shows per-model values', html.includes('chartTipRow') && html.includes('chartTipValue')],
  ['tooltip is clamped into the plot', html.includes('offsetWidth') && html.includes('box.width')],
  ['hover is keyboard reachable', html.includes("event.key !== 'ArrowLeft'")],
  ['hit rects receive the pointer', html.includes('.chartHit { pointer-events: all')],

  // ---- natural weeks carry their date range
  ['month slots carry a date range', html.includes('chartAxisSub') && html.includes('range')],

  // ---- interaction animation
  ['window/mode switch animates', html.includes('data-animate') && html.includes('@keyframes chartIn')],
  ['animation is dropped under reduced motion', html.includes('prefers-reduced-motion: reduce')],
  ['animation only fires on a real change', html.includes('lastChartKey') && html.includes('animateChart')],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed += 1
}

console.log()
console.log(`document size: ${(html.length / 1024).toFixed(0)} KB`)
console.log(`wrote: ${out}`)
if (failed > 0) {
  console.log(`\nFAIL — ${failed} structural check(s)`)
  process.exit(1)
}
console.log('PASS — frame document is structurally complete')