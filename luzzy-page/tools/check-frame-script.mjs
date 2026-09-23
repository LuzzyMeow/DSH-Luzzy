/**
 * Extract the frame document's script block and parse it.
 *
 * `node --check` on the built bundle does NOT cover the frame: the frame is a plain string
 * inside `buildFrameDocument()`, so a syntax error in it survives the build and only shows
 * up when the document actually runs — as a blank page, since the frame's own error handler
 * cannot report a parse failure in the script that defines it.
 *
 * That exact failure happened once already (an unescaped backtick terminated the template),
 * which is why `tools/scan-frame-backticks.mjs` exists. This is the other half: the scan
 * proves no backtick leaked, and this proves the result is parseable JavaScript. Both are
 * cheap, and a parse error here is reported with a real line number.
 *
 * Usage: node tools/check-frame-script.mjs
 */

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const previewPath = process.argv[2] ?? join(tmpdir(), 'luzzy-frame-preview.html')

let html
try {
  html = readFileSync(previewPath, 'utf8')
} catch (error) {
  console.error(`frame-script: cannot read ${previewPath} — ${error.message}`)
  console.error('frame-script: run tools/render-frame-preview.mjs first')
  process.exit(1)
}

// The frame's script is the one that starts with the 'use strict' pragma; the preview may
// carry other script tags (a shim), so this is matched on content rather than position.
const match = html.match(/<script>\s*\n'use strict'([\s\S]*?)<\/script>/)
if (match === null) {
  console.error('frame-script: no <script> block with a use-strict pragma was found')
  process.exit(1)
}

const code = `'use strict'${match[1]}`
const lineCount = code.split('\n').length

try {
  // `new Function` compiles without executing, which is what a parse check needs: running
  // the frame's script here would fail on `document` before reaching a real error.
  new Function(code)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`frame-script: PARSE FAILED over ${lineCount} lines — ${detail}`)
  // Point at the reported line so the fix does not start with a search.
  const lineMatch = /:(\d+):(\d+)?/.exec(detail)
  if (lineMatch !== null) {
    const line = Number(lineMatch[1])
    const lines = code.split('\n')
    for (let index = Math.max(0, line - 4); index < Math.min(lines.length, line + 3); index += 1) {
      const marker = index + 1 === line ? '>>' : '  '
      console.error(`${marker} ${String(index + 1).padStart(5)}: ${lines[index]}`)
    }
  }
  process.exit(1)
}

console.log(`frame-script: PASS — ${lineCount} lines parse cleanly`)
