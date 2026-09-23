/**
 * Gate: the frame's own script must compile.
 *
 * WHY THIS IS SEPARATE FROM THE BUILD
 *
 * The frame is a STRING inside the bundle. `node --check` / `new Function` on the bundle
 * therefore says nothing about the frame — a syntax error inside it survives every outer
 * check and appears only as a blank page. And the frame's own `report()` cannot announce it
 * either, because `report` is defined in the same script that failed to parse.
 *
 * That failure has happened here more than once (an unescaped backtick, and separately a
 * literal backslash-n that the outer template consumed). This gate reports the real line
 * number and prints the surrounding source, because the reported position is otherwise
 * nowhere near the mistake.
 *
 * IT COMPILES THE SHIPPED ARTIFACT, NOT A FILE ON DISK
 *
 * An earlier version read a preview HTML written by another tool. It then passed on a stale
 * file while the bundle was broken — evidence that was worse than none, because it looked
 * green. This reads the document out of `lib/client.js`, through the real component, so it
 * cannot disagree with what ships.
 *
 * Usage: node tools/check-frame-script.mjs
 */

import { loadFrameBuilder, compileFrameScript, extractFrameScript } from './frame-source.mjs'

const { srcDoc } = loadFrameBuilder()

const script = extractFrameScript(srcDoc)
if (script === null) {
  console.error('frame-script: no <script> block with a use-strict pragma was found in the built frame')
  process.exit(1)
}

const lineCount = script.split('\n').length
const result = compileFrameScript(srcDoc)

if (!result.ok) {
  console.error(`frame-script: PARSE FAILED over ${lineCount} lines — ${result.error}`)
  if (result.context !== '') console.error(result.context)
  console.error('\nframe-script: the page would render BLANK. Fix the reported line in the module that owns it.')
  process.exit(1)
}

console.log(`frame-script: PASS — ${result.lines} lines parse cleanly (compiled from the shipped bundle)`)
