/**
 * Negative control for the plan-to-goal BINDING guard: prove the new assertions can fail.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * A real session ran 205 plan changes with `goalId === null` and `reconcile` never called by
 * hand. The console drew that plan as the projection of the live goal, and nothing had ever
 * verified that it was — because both guards written to catch exactly that were shaped to
 * skip on a null id:
 *
 *   integrity()    step 11 compared ids only when `delivery.goalId !== null`
 *   detectDrift()  compared only when the mirror fields were non-null
 *
 * The fix has two halves, and a half-fix is the failure mode worth guarding: reporting an
 * unbound plan without auto-binding it makes every session start red, and auto-binding without
 * reporting it leaves the guard silent for anyone who writes the overlay directly (which the
 * routes and several tools do). So this arm reverts EACH half separately against a copy of the
 * plugin and requires the suite to go red for that half's own reason.
 *
 * It works on a copy in the system temp directory and never touches the real source.
 *
 * Run: node tools/prove-binding.mjs
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-binding-proof-'))
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

/** Run a suite inside the sandbox; return `{output, exitedNonZero}`. */
function runSuite(sandboxRoot, suite) {
  try {
    const output = execFileSync(process.execPath, [join(sandboxRoot, 'tools', suite)], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    return { output, exitedNonZero: false }
  } catch (error) {
    return { output: `${error.stdout ?? ''}${error.stderr ?? ''}`, exitedNonZero: true }
  }
}

/** Copy the plugin, apply one textual reversion, run both suites, restore. */
function arm(name, file, replace, suite, mustContain) {
  console.log(`\n${name}`)
  const root = mkdtempSync(join(tmpdir(), 'luzzy-binding-arm-'))
  try {
    cpSync(PLUGIN_ROOT, join(root, 'plugin'), { recursive: true })
    const target = join(root, 'plugin', file)
    const source = readFileSync(target, 'utf8')
    const [from, to] = replace
    check('the copy contains the code to revert', source.includes(from), `not found in ${file}`)
    writeFileSync(target, source.replace(from, to))

    const { output, exitedNonZero } = runSuite(join(root, 'plugin'), suite)
    check(`the suite goes red (${suite})`, exitedNonZero, 'the suite passed against a reverted plugin')

    const failLines = output.split('\n').filter((line) => line.includes('FAIL'))
    check(`and fails for this defect's own reason (${failLines.length} red)`,
      output.includes(mustContain),
      `looked for ${JSON.stringify(mustContain)}; nothing matched, so it failed for something unrelated`)
    for (const line of failLines.slice(0, 4)) console.log(`       ${line.trim()}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

try {
  // ---- HALF 1: the auto-bind in commitOp ----
  //
  // Reverted by making the bind conditional on something that is never true, which is the
  // precise shape of the old behaviour (the binding was an op the model had to remember).
  arm(
    'arm A — the auto-bind never fires (goalId stays null forever)',
    join('lib', 'goal-enforce.mjs'),
    ["if (result.delivery !== undefined && result.delivery.goalId === null && deps.ctx !== undefined) {",
     "if (false && result.delivery !== undefined && result.delivery.goalId === null && deps.ctx !== undefined) {"],
    'test-goal-binding.mjs',
    'goalId was filled in without the model asking',
  )

  // ---- HALF 2a: integrity stops reporting an unbound plan ----
  arm(
    'arm B — integrity goes quiet about an unbound plan again',
    join('lib', 'goal-domain.mjs'),
    ['if (delivery.goalId === null && hasContent) {',
     'if (false && delivery.goalId === null && hasContent) {'],
    'test-goal-domain.mjs',
    'integrity reports an unbound plan as DRIFT',
  )

  // ---- HALF 2b: detectDrift stops reporting one ----
  arm(
    'arm C — detectDrift goes quiet about an unbound plan again',
    join('lib', 'goal-domain.mjs'),
    ["if (delivery.goalId === null && hasContent) {\n    fields.push('goal')",
     "if (false && delivery.goalId === null && hasContent) {\n    fields.push('goal')"],
    'test-goal-domain.mjs',
    'detectDrift reports an unbound plan too',
  )

  // ---- HALF 2c: the structural bucket collapses back into missing evidence ----
  arm(
    'arm D — structural errors are filed as missing evidence again',
    join('lib', 'goal-domain.mjs'),
    ['else structural.push(`${error.code} ${error.target}: ${error.detail}`)',
     'else missingEvidence.push(`${error.code} ${error.target}: ${error.detail}`)'],
    'test-goal-binding.mjs',
    'and NOT as missing evidence',
  )

  // ---- HALF 2d: the "no opinion when untouched" escape hatch is removed ----
  //
  // The opposite direction, and the one that would make the fix WORSE than the bug: without
  // the content test, every freshly created goal would be reported as drifted, the label
  // would mean nothing, and the real case would hide in the noise all over again.
  arm(
    'arm E — a brand-new plan is reported as drifted (the over-correction)',
    join('lib', 'goal-domain.mjs'),
    ['const hasContent = delivery.changes.length > 0 || delivery.acceptance.length > 0 || delivery.tasks.length > 0\n    if (delivery.goalId === null && hasContent) {',
     'const hasContent = true\n    if (delivery.goalId === null && hasContent) {'],
    'test-goal-domain.mjs',
    'and is still healthy, not alarming',
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (the binding guard fails when either half is reverted)`)
