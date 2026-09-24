/**
 * Frame integrity gate — the successor to `scan-frame-backticks.mjs`.
 *
 * WHAT CHANGED AND WHY THIS IS STILL A GATE
 *
 * The frame used to sit inside a hand-written JS **template literal** in src/client.js. Any
 * raw backtick in it (even in a comment) ended the literal early, and the only symptom was a
 * blank frame with the reported error nowhere near the mistake. Four separate blank-page
 * incidents came from that. `scan-frame-backticks.mjs` existed to catch it.
 *
 * The v2 build assembles the frame from src/ and embeds it as a JSON **string literal** via
 * `json.dumps`, which escapes backticks, backslashes and `${` mechanically. The hazard class
 * is therefore gone BY CONSTRUCTION — and a gate that only asserts "no raw backticks" would
 * now pass on a file that had quietly regressed to the old, dangerous shape.
 *
 * So this gate asserts the CONSTRUCT, not just the symptom:
 *
 *   1. the frame is embedded as a JSON string literal (not a template literal)
 *   2. no unescaped backtick survives into the frame the browser receives
 *   3. the frame's own script compiles
 *   4. the four content markers were all substituted
 *
 * Any one of those failing is a blank frame waiting to happen.
 *
 * Usage: node tools/scan-frame-backticks.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFrameBuilder, compileFrameScript, PLUGIN_ROOT } from './frame-source.mjs'

const bundle = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1 — the frame must be a JSON string literal, not a template literal.
//
// `FRAME_JSON` is assigned the embedded document. A JSON literal starts with a quote; a
// template literal would start with a backtick. That single character is the whole
// difference between the safe construct and the one that blanked the page four times.
const assignment = /const FRAME_JSON\s*=\s*(")/.exec(bundle)
check(
  'the frame is embedded as a JSON string literal, not a template literal',
  assignment !== null,
  'a template literal here re-introduces the raw-backtick hazard',
)

// 2 — no unescaped backtick inside the document the browser actually receives.
const { srcDoc } = loadFrameBuilder()
const inFrameScript = srcDoc.match(/<script>([\s\S]*?)<\/script>/)
check('the frame has one script block', inFrameScript !== null)

// A backtick in the assembled frame is FINE now (JSON carried it through), so what matters is
// that the count matches what the sources actually contain — i.e. nothing was lost or doubled
// in transit. Compare against the raw sources.
//
// The stylesheet counts too: components.css names `.chartWrap`-style selectors in its own
// comments, and forgetting that produced a two-backtick mismatch that looked like corruption.
const sourceBackticks = (category) => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'manifest.json'), 'utf8'))
  let count = 0
  for (const name of manifest[category]) {
    count += (readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8').match(/`/g) ?? []).length
  }
  return count
}
const expected = sourceBackticks('modules') + sourceBackticks('styles') +
  (readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'frame.html'), 'utf8').match(/`/g) ?? []).length
const frameCount = (srcDoc.match(/`/g) ?? []).length
check(
  'backticks survived the embed byte-for-byte',
  frameCount === expected,
  `sources have ${expected}, frame has ${frameCount} — a lost or doubled backtick means the escaping mangled the document`,
)

// 3 — the frame script compiles. This is the check that actually catches a broken frame.
const compile = compileFrameScript(srcDoc)
check(
  `the frame script compiles (${compile.ok ? `${compile.lines} lines` : compile.error})`,
  compile.ok,
  compile.ok ? '' : compile.context,
)

// 4 — every marker was substituted. A leftover marker is a blank or half-built page.
for (const marker of ['__FRAME_FONTS__', '__MODULES__', '__STYLES__']) {
  check(`marker ${marker} was substituted`, !srcDoc.includes(marker))
}

// 5 — the frame is self-contained: no external request can be made from inside it.
check('no external url in the frame', !/url\((?!data:)/.test(srcDoc), 'the frame is an iframe srcDoc; it cannot fetch anything')

// The property is "every face the frame asks for is INLINED", not "there are exactly four".
//
// This used to read `… === 4`, which was a count of the four subset faces (CJK regular/bold +
// Latin regular/bold). When the CJK half moved to the operating system's own fonts — the
// reference's own stack does exactly that — the count became 3 and this check went red while
// the frame was perfectly self-contained. A hardcoded count encodes the current inventory as
// if it were the requirement.
{
  const faces = srcDoc.match(/@font-face\s*\{[^}]*\}/g) ?? []
  const payloads = faces.filter((block) => /src:\s*url\(data:font\/woff2;base64,/.test(block))
  check('there is at least one inlined face', faces.length > 0, 'the frame declares no font at all')
  check('every declared face is inlined as a data URL', payloads.length === faces.length,
    `${faces.length} face(s) declared, ${payloads.length} inlined — a face without a data URL would be an external request`)
}

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} check(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} frame integrity checks`)
