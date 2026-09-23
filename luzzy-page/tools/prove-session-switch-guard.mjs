// Negative control for tools/test-client-session-switch.mjs: copy the plugin to a temp dir,
// put the ORIGINAL buggy ordering back at all five loader sites, and require the test to go
// red. Runs against a copy and never touches the real source.
//
// Usage: node tools/prove-session-switch-guard.mjs

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

const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-switch-proof-'))
try {
  cpSync(PLUGIN_ROOT, sandbox, { recursive: true })

  const appPath = join(sandbox, 'src', 'app', 'app.js')
  const original = readFileSync(appPath, 'utf8')

  // Put back the exact ordering that shipped the bug: the `loading` check first.
  const pattern = /if \(!shouldLoad\(state\.(\w+)Status, force\)\) return Promise\.resolve\(\)/g
  let restored = 0
  const reverted = original.replace(pattern, (_match, name) => {
    restored += 1
    return `if (state.${name}Status === 'loading') return Promise.resolve()\n    if (!force && state.${name}Status === 'ready') return Promise.resolve()`
  })

  check(`reverted all five loader sites (${restored})`, restored === 5, `only ${restored}`)
  check('the source actually changed', reverted !== original)
  writeFileSync(appPath, reverted)

  let output = ''
  let exitedNonZero = false
  try {
    output = execFileSync(process.execPath, [join(sandbox, 'tools', 'test-client-session-switch.mjs')], {
      encoding: 'utf8',
      env: { ...process.env },
    })
  } catch (error) {
    exitedNonZero = true
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const failLines = output.split('\n').filter((line) => line.includes('FAIL'))
  check('the test goes red against the original bug', exitedNonZero, 'it passed against the broken code')
  check(`and names the broken behaviours (${failLines.length} lines)`, failLines.length >= 3, `only ${failLines.length}`)
  for (const line of failLines.slice(0, 6)) console.log(`       ${line.trim()}`)
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
console.log(`PASS — ${checks} assertions (the session-switch guard fails when the bug returns)`)
