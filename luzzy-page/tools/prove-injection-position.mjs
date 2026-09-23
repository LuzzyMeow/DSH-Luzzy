// Negative control for the injection POSITION assertions: put the tail-append back and require
// the new position assertions to go red. Without this, "I changed where the notice goes" is a
// claim no test contradicts.
//
// Usage: node tools/prove-injection-position.mjs

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

const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-pos-proof-'))
try {
  cpSync(PLUGIN_ROOT, sandbox, { recursive: true })

  const target = join(sandbox, 'lib', 'goal-enforce.mjs')
  const original = readFileSync(target, 'utf8')

  // Put back exactly what shipped before: append to the tail.
  const insertBlock = original.slice(
    original.indexOf('      const notice = pluginNotice('),
    original.indexOf('    })', original.indexOf('      const notice = pluginNotice(')),
  )
  check('found the insert block to replace', insertBlock.length > 0 && insertBlock.includes('toSpliced'))

  const tailVersion = `      const notice = pluginNotice(text, changed ? '目标已更新' : '目标状态')
      return {
        ...decision,
        messages: [...decision.messages, notice],
      }
`
  const reverted = original.replace(insertBlock, tailVersion)
  check('the mutation applied', reverted !== original, 'matched nothing — this arm would prove nothing')
  writeFileSync(target, reverted)

  let output = ''
  let exitedNonZero = false
  try {
    output = execFileSync(process.execPath, [join(sandbox, 'tools', 'test-goal-enforce.mjs')], {
      encoding: 'utf8',
      env: { ...process.env },
    })
  } catch (error) {
    exitedNonZero = true
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const failLines = output.split('\n').filter((line) => line.includes('FAIL'))
  check('the suite goes red against a tail append', exitedNonZero, 'it passed with the notice back at the tail')
  const positionLines = failLines.filter((line) => /claimed|tail|sits directly/i.test(line))
  check(`and the failures are about POSITION (${positionLines.length})`, positionLines.length >= 2, `only ${positionLines.length}`)
  for (const line of positionLines.slice(0, 4)) console.log(`       ${line.trim()}`)
} finally {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (the position guard fails when the tail append returns)`)
