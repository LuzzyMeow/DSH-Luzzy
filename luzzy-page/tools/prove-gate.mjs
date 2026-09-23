/**
 * Negative control for the SESSION GATE: prove the gate assertions can fail.
 *
 * The identity guard already has one (`prove-guard.mjs`), for the same reason: an assertion
 * that cannot fail is not a test. The session gate is the v2 layer and it is the one place
 * where being wrong is WORST — a gate that silently stops gating looks exactly like a gate
 * that has nothing to do, and every other suite stays green either way.
 *
 * So this runs the enforce suite AND the runtime-acceptance block against a deliberately
 * weakened copy, and requires BOTH to go red. It works on a copy in the system temp directory
 * and never touches the real source.
 *
 * Two arms, because they can fail independently:
 *
 *   armA  `sessionGate: true` replaced by `false`   -> the feature is off (a config regression)
 *   armB  the deny turned into an allow             -> the gate runs but never refuses
 *                                                      (the "vacuous gate" this exists for)
 *
 * Usage: node tools/prove-gate.mjs
 */

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

/** Run one suite inside a sandbox and report whether it went red and why. */
function runSuite(sandbox, suite) {
  try {
    const output = execFileSync(process.execPath, [join(sandbox, 'tools', suite)], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    return { exitedNonZero: false, output }
  } catch (error) {
    return { exitedNonZero: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/**
 * Build a sandbox whose source has been mutated by `mutate`.
 *
 * @param {string} label - for the log.
 * @param {(source: string) => string} mutate - rewrites the plugin source.
 * @returns {string} sandbox root.
 */
function sandboxWith(label, mutate) {
  const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-gate-proof-'))
  cpSync(PLUGIN_ROOT, sandbox, { recursive: true })
  const target = join(sandbox, 'lib', 'goal-enforce.mjs')
  const source = readFileSync(target, 'utf8')
  const mutated = mutate(source)
  if (mutated === source) {
    failures += 1
    console.log(`  FAIL arm ${label}: the mutation matched nothing, so this arm tests nothing`)
  }
  writeFileSync(target, mutated)
  return sandbox
}

const sandboxes = []
try {
  // ---- arm A: the feature is simply off ------------------------------------------
  const DEFAULT_LINE = "  sessionGate: true,"
  {
    const sandbox = sandboxWith('A', (s) => s.replace(DEFAULT_LINE, '  sessionGate: false,'))
    sandboxes.push(sandbox)
    const enforce = runSuite(sandbox, 'test-goal-enforce.mjs')
    const accept = runSuite(sandbox, 'test-host-routes.mjs')
    check('A: the enforce suite goes red when the gate is off', enforce.exitedNonZero, 'it passed with sessionGate disabled')
    check('A: the runtime-acceptance block goes red too', accept.exitedNonZero, 'it passed with sessionGate disabled')
    const gateFailures = enforce.output.split('\n').filter((l) => l.includes('FAIL') && /gate|refus|held|proposal/i.test(l))
    check(`A: and it fails FOR THE GATE (${gateFailures.length} lines)`, gateFailures.length >= 3, `only ${gateFailures.length}`)
    for (const line of gateFailures.slice(0, 5)) console.log(`       ${line.trim()}`)
  }

  // ---- arm B: the gate runs but never refuses ------------------------------------
  //
  // This is the subtle one. A vacuous gate still installs, still counts, still injects — so
  // only an assertion that requires a DENY can catch it.
  {
    const sandbox = sandboxWith('B', (s) => {
      const start = s.indexOf('      stats.gateBlocked += 1\n      entry.gateBlocks += 1\n      return { kind: \'deny\', reason: renderGateRefusal(exec.name, entry) }')
      if (start < 0) return s
      return s.replace(
        "      return { kind: 'deny', reason: renderGateRefusal(exec.name, entry) }",
        '      return decision',
      )
    })
    sandboxes.push(sandbox)
    const enforce = runSuite(sandbox, 'test-goal-enforce.mjs')
    const accept = runSuite(sandbox, 'test-host-routes.mjs')
    check('B: a gate that never refuses fails the enforce suite', enforce.exitedNonZero, 'it passed with the deny removed')
    check('B: and fails the runtime-acceptance block', accept.exitedNonZero, 'it passed with the deny removed')
    const heldLines = accept.output.split('\n').filter((l) => l.includes('FAIL') && /held|is a read/i.test(l))
    check(`B: and the failure is about being HELD (${heldLines.length} lines)`, heldLines.length >= 2, `only ${heldLines.length}`)
    for (const line of heldLines.slice(0, 4)) console.log(`       ${line.trim()}`)
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
console.log(`PASS — ${checks} assertions (the session gate fails when it should)`)
