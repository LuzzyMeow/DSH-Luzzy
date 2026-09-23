// One-off: show a line range of the assembled frame by the BROWSER's line numbering.
//
// The browser reports positions against the whole DOCUMENT (`about:srcdoc:5311`), while an
// extracted script block starts later — the <head>, the <style> and the opening <script> tag all
// occupy document lines. Reading the extracted script at the browser's line number shows the
// wrong line, and the wrong line looks plausible enough to send you debugging innocent code.
import { loadFrameBuilder } from './frame-source.mjs'

const { srcDoc } = loadFrameBuilder()
const lines = srcDoc.split('\n')

const from = Number(process.argv[2] ?? 5300)
const to = Number(process.argv[3] ?? 5315)

// Where does the script block begin in DOCUMENT coordinates? This offset is what the previous
// version of this tool was missing.
const scriptAt = lines.findIndex((line) => line.trim() === '<script>')
console.log(`(the script block starts at document line ${scriptAt + 1}; line numbers below are document-absolute)\n`)

for (let i = from - 1; i < to && i < lines.length; i += 1) {
  console.log(`${String(i + 1).padStart(5)}: ${lines[i]}`)
}
