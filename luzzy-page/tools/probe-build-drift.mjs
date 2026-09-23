// Is the COMMITTED lib/client.js the one carrying this round's fixes, and how much do two
// builds actually differ? The build is not byte-reproducible (the font subsetter is not
// deterministic); this says whether that drift is confined to the embedded font blob.
//
// Usage: node tools/probe-build-drift.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(ROOT, 'lib', 'client.js')

// The committed artifact, straight out of git.
const committed = execFileSync('git', ['show', 'HEAD:luzzy-page/lib/client.js'], { cwd: join(ROOT, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

console.log('=== does the committed artifact carry this round\'s work? ===')
for (const [label, needle] of [
  ['objectiveText (objective renderer)', 'objectiveText'],
  ['the viewer handoff button', 'data-viewer="objective"'],
  ['viewerText (pre-wrap body)', 'viewerText'],
  ['dialogContent (single scroll layer)', 'dialogContent'],
  ['white-space: pre-wrap', 'white-space: pre-wrap'],
  ['readiness (还缺什么)', 'function readiness('],
  ['suppressed health badge', 'toneOf(view.health) === LZ.StatusBadge.toneOf(goal.phase)'],
  ['sessionGeneration (切会话修复)', 'sessionGeneration'],
  ['shouldLoad (force 修复)', 'function shouldLoad('],
]) {
  console.log(`  ${committed.includes(needle) ? 'yes' : 'NO '} ${label}`)
}

// Two fresh builds, compared line by line.
copyFileSync(OUT, join(tmpdir(), 'lz-build-a.js'))
execFileSync('python', [join(HERE, 'build-font-css.py')], { cwd: ROOT, stdio: 'ignore' })

const a = readFileSync(join(tmpdir(), 'lz-build-a.js'), 'utf8').split('\n')
const b = readFileSync(OUT, 'utf8').split('\n')
const differing = []
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) differing.push(i)
}

console.log('')
console.log(`=== two consecutive builds: ${differing.length} differing line(s) of ${b.length} ===`)
// Every differing line should be the font payload. If anything else drifts, the build is
// non-deterministic in a way that could hide a real change.
const onlyFont = differing.every((i) => {
  const line = (b[i] ?? '') + (a[i] ?? '')
  return line.includes('base64') || line.includes('@font-face') || line.includes('src: url(data:font')
})
console.log(`  all differences are the embedded font blob: ${onlyFont}`)
if (!onlyFont) {
  for (const i of differing.slice(0, 3)) {
    console.log(`  line ${i + 1}:`)
    console.log(`    a: ${String(a[i]).slice(0, 120)}`)
    console.log(`    b: ${String(b[i]).slice(0, 120)}`)
  }
}
