// Negative control for the two defects the user's screenshot exposed:
//   A. two identical「已完成」badges side by side (phase + health saying the same word)
//   B. the objective dumped into a one-sentence emphasis block, collapsing to a wall of text
//
// Both were "wrong primitive", so the assertions are structural. Prove they can fail by putting
// each defect back in a temp copy.
//
// Usage: node tools/prove-overview-render.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

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

function runSuite(sandbox) {
  try {
    execFileSync(process.execPath, [join(sandbox, 'tools', 'test-client-load.mjs')], { encoding: 'utf8', env: { ...process.env } })
    return { exitedNonZero: false, output: '' }
  } catch (error) {
    return { exitedNonZero: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const sandboxes = []
try {
  // ---- arm A: both badges again ------------------------------------------------
  {
    const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-badge-proof-'))
    cpSync(PLUGIN_ROOT, sandbox, { recursive: true })
    sandboxes.push(sandbox)
    const file = join(sandbox, 'src', 'pages', 'overview.js')
    const source = readFileSync(file, 'utf8')
    const deduped = source.slice(
      source.indexOf('      // 健康度只在它与阶段说的'),
      source.indexOf('      objectiveText(goal.objective)'),
    )
    const naive = "      LZ.StatusBadge.fromStatus(goal.phase) +\n      LZ.StatusBadge.fromStatus(view.health) +\n      '</div>' +\n"
    const mutated = source.replace(deduped, naive)
    check('A: the mutation applied', mutated !== source, 'matched nothing')
    writeFileSync(file, mutated)

    const result = runSuite(sandbox)
    const lines = result.output.split('\n').filter((l) => l.includes('FAIL'))
    check('A: the suite goes red with both badges back', result.exitedNonZero, 'it passed with the duplicate badge')
    check(`A: and names the redundant badge (${lines.length})`, lines.some((l) => /redundant health badge/.test(l)), lines.join(' | '))
    for (const line of lines.slice(0, 3)) console.log(`       ${line.trim()}`)
  }

  // ---- arm B: the wall of text again -------------------------------------------
  {
    const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-focus-proof-'))
    cpSync(PLUGIN_ROOT, sandbox, { recursive: true })
    sandboxes.push(sandbox)
    // Drop pre-wrap from the viewer: this is the single property that turned hundreds of lines
    // into one blob. It moved from the page to the viewer, so the arm moved with it.
    const css = join(sandbox, 'src', 'styles', 'components.css')
    const source = readFileSync(css, 'utf8')
    const mutated = source.replace(/(\.viewerText\s*\{[^}]*?)white-space:\s*pre-wrap;/, '$1')
    check('B: the mutation applied', mutated !== source, 'matched nothing')
    writeFileSync(css, mutated)

    const result = runSuite(sandbox)
    const lines = result.output.split('\n').filter((l) => l.includes('FAIL'))
    check('B: the suite goes red without pre-wrap', result.exitedNonZero, 'it passed with the collapse back')
    check(`B: and names the newline fix (${lines.length})`, lines.some((l) => /preserves newlines/.test(l)), lines.join(' | '))
    for (const line of lines.slice(0, 3)) console.log(`       ${line.trim()}`)
  }

  // ---- arm C: the in-page fold again -------------------------------------------
  {
    const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-fold-proof-'))
    cpSync(PLUGIN_ROOT, sandbox, { recursive: true })
    sandboxes.push(sandbox)
    // Put the nested scroll box back: the long objective expands inside the page instead of
    // handing off. This is the defect the second screenshot showed, and it has THREE symptoms
    // asserted separately — the fold itself, the missing handoff, and the resurrected CSS rule.
    const format = join(sandbox, 'src', 'components', 'Format.js')
    const source = readFileSync(format, 'utf8')
    const mutated = source
      .replace("data-viewer=\"objective\" data-viewer-title=\"目标全文\"", '')
      .replace("'<div class=\"focusBox\">' + esc(head) + '</div>' +", "'<div class=\"focusBox\">' + esc(text) + '</div><details class=\"objectiveRest\"><div class=\"objectiveFull\">' + esc(text) + '</div></details>' +")
    check('C: the mutation applied', mutated !== source && !mutated.includes('data-viewer'), 'matched nothing')
    writeFileSync(format, mutated)
    const cssFile = join(sandbox, 'src', 'styles', 'components.css')
    const css = readFileSync(cssFile, 'utf8')
    writeFileSync(cssFile, css + '\n.objectiveFull {\n  max-height: 22rem;\n  overflow-y: auto;\n  white-space: pre-wrap;\n}\n')

    const result = runSuite(sandbox)
    const lines = result.output.split('\n').filter((l) => l.includes('FAIL'))
    check('C: the suite goes red with the in-page fold back', result.exitedNonZero, 'it passed with the nested scroll box')
    check(`C: and names the handoff (${lines.length})`, lines.some((l) => /hands off to the viewer/.test(l)), lines.join(' | '))
    check('C: and the resurrected rule', lines.some((l) => /in-page fold is gone/.test(l)), lines.join(' | '))
    for (const line of lines.slice(0, 4)) console.log(`       ${line.trim()}`)
  }
} finally {
  for (const sandbox of sandboxes) {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (both screenshot defects fail when reintroduced)`)
