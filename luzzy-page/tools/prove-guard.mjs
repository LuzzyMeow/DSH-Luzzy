/**
 * Negative control for the injected-message identity guard: prove the new assertions can fail.
 *
 * The rule this repo learned the hard way is that an assertion which cannot fail is not a
 * test — and the identity guard is exactly the kind that rots into a tautology if the
 * validator and the plugin drift together. So this runs the goal-enforce suite against a
 * deliberately broken COPY of the plugin and requires it to go red.
 *
 * It works on a copy in the system temp directory and never touches the real source: a
 * verification tool that can corrupt the thing it verifies is worse than no tool.
 *
 * Run: node tools/prove-guard.mjs
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

/** The exact defect this guard exists for: the constructor emits no message identity. */
const ID_LINE = '    id: randomUUID(),\n'

const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-guard-proof-'))
let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

try {
  cpSync(PLUGIN_ROOT, sandbox, { recursive: true })
  const copiedLib = join(sandbox, 'lib', 'goal-enforce.mjs')
  const source = readFileSync(copiedLib, 'utf8')

  check('the copy contains the identity line to remove', source.includes(ID_LINE))
  writeFileSync(copiedLib, source.replace(ID_LINE, ''))

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

  check('the suite goes red when the id is removed', exitedNonZero, 'the suite passed against a broken plugin')
  check(`several identity assertions fail (${failLines.length})`, failLines.length >= 4, `only ${failLines.length} failed`)

  // The decisive one: the guard must fail for the harness's reason, not some unrelated crash.
  check(
    "the failure names the harness's own reason",
    output.includes('lacks an identified message'),
    'the suite failed for an unrelated reason, so it proves nothing about this defect',
  )

  for (const line of failLines.slice(0, 8)) console.log(`       ${line.trim()}`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (the identity guard fails when the id is missing)`)
