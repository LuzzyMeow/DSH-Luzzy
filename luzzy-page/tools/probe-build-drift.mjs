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

// The committed artifacts, straight out of git.
//
// TWO halves, and the distinction matters: `lib/client.js` is the built CLIENT bundle (the frame
// the browser receives), while `lib/goal-enforce.mjs` and friends are HOST modules that are not
// built into it at all. A marker for a gate therefore cannot be looked for in the client bundle —
// my first version of this list did exactly that and reported a false NO for three markers that
// were committed and correct.
const committed = execFileSync('git', ['show', 'HEAD:luzzy-page/lib/client.js'], { cwd: join(ROOT, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const committedHost = ['goal-enforce.mjs', 'goal-domain.mjs', 'goal-tools.mjs']
  .map((name) => execFileSync('git', ['show', `HEAD:luzzy-page/lib/${name}`], { cwd: join(ROOT, '..'), encoding: 'utf8' }))
  .join('\n')

console.log('=== does the committed artifact carry this round\'s work? ===')
for (const [label, needle, where] of [
  ['objectiveText (objective renderer)', 'objectiveText', 'client'],
  // 针里不能带引号：帧文档在产物里是 JSON 字符串字面量，属性值写成 data-viewer=\"objective\"，
  // 带引号的针永远搜不到（第一次跑就是这样报了个假 NO）。
  ['the viewer handoff button', 'data-viewer', 'client'],
  ['viewerText (pre-wrap body)', 'viewerText', 'client'],
  ['dialogContent (single scroll layer)', 'dialogContent', 'client'],
  ['white-space: pre-wrap', 'white-space: pre-wrap', 'client'],
  ['readiness (还缺什么)', 'function readiness(', 'client'],
  ['suppressed health badge', 'toneOf(view.health) === LZ.StatusBadge.toneOf(goal.phase)', 'client'],
  ['sessionGeneration (切会话修复)', 'sessionGeneration', 'client'],
  ['shouldLoad (force 修复)', 'function shouldLoad(', 'client'],
  // 状态链与激活技能清单（这一轮）：两边都要带着，否则装上的是上一版。
  ['state chain line', 'data-chain', 'client'],
  ['activation list block', 'goalSkills', 'client'],
  ['chain gate refusal', 'STATE_CHAIN_REQUIRED', 'host'],
  ['skill gate refusal', 'SKILL_LIST_EMPTY', 'host'],
  ['judgeChain op', 'judgeChain', 'host'],
]) {
  const haystack = where === 'host' ? committedHost : committed
  console.log(`  ${haystack.includes(needle) ? 'yes' : 'NO '} ${label}  (${where})`)
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
