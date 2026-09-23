// Regression test for the session-switch bug the user reported:
//
//   「为什么切换至其他会话 目标始终没有变（视图内仍显示）即使Agent看不到这个不变的目标」
//
// Root cause, in `src/app/app.js`: every loader asked
//
//     if (state.xStatus === 'loading') return Promise.resolve()   // ← BEFORE the force check
//     if (!force && state.xStatus === 'ready') return Promise.resolve()
//
// so `force` was swallowed by the `loading` branch. Switching sessions while a fetch was in
// flight — exactly the moment a reload matters most — returned early and the new session's
// data was never read. A force parameter that does not force looks like "the page didn't
// refresh", which is why it survived inspection for so long.
//
// This test does NOT match source strings for the fix. It EXTRACTS `shouldLoad` and asserts
// its truth table, then RE-EXTRACTS it from a copy that has been put back to the buggy order
// and requires the same assertions to fail. An assertion that cannot fail is not a test
// (§5.29): without the second arm this file would pass against the broken code too.
//
// Usage: node tools/test-client-session-switch.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..', 'src', 'app', 'app.js')

const failures = []
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures.push(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Pull a top-level `function <name>(...) { ... }` out of the source by brace matching.
 *
 * Brace matching rather than a regex body: the function contains nested blocks and a nested
 * template, so a lazy `.*?}` would stop at the first inner brace and test a truncated body.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string|null}
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Compile the extracted `shouldLoad` and return it as a callable.
 *
 * @param {string} source
 * @returns {((status: string, force: boolean) => boolean)|null}
 */
function compileShouldLoad(source) {
  const body = extractFunction(source, 'shouldLoad')
  if (body === null) return null
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return shouldLoad;`)()
}

const real = readFileSync(APP, 'utf8')
const shouldLoad = compileShouldLoad(real)
check('extracted shouldLoad from the real source', typeof shouldLoad === 'function', 'extraction failed — the test would be vacuous')

if (typeof shouldLoad === 'function') {
  // THE TWO CASES THE BUG BROKE. Both must be true, and the first is the exact scenario the
  // user hit: a fetch is in flight and the session changes underneath it.
  check('force wins over an in-flight load', shouldLoad('loading', true) === true, `got ${shouldLoad('loading', true)}`)
  check('force re-reads after a successful load', shouldLoad('ready', true) === true, `got ${shouldLoad('ready', true)}`)

  // The non-forced cases must still de-duplicate, or every tab switch would re-fetch.
  check('a ready page is not re-read without force', shouldLoad('ready', false) === false)
  check('an in-flight load is not doubled without force', shouldLoad('loading', false) === false)

  // And an unloaded page must load, in every non-ready state.
  for (const status of ['idle', 'error']) {
    check(`a page in "${status}" loads without force`, shouldLoad(status, false) === true, `got ${shouldLoad(status, false)}`)
  }
}

// ---- The rest of the fix: the page must know a session changed, and ignore stale answers ----
{
  const sessionHandler = real.slice(real.indexOf("if (data.type === 'session')"))
  check('the session handler advances the generation', sessionHandler.includes('sessionGeneration += 1'))
  check('and drops the previous session\'s data', sessionHandler.includes('state.goal = null') && sessionHandler.includes('state.runtime = null'))
  check('and reloads whatever the current tab needs', sessionHandler.includes('ensureFor(state.tab)'))

  // A late response from the old session must be discarded, not written over the new one.
  check('loadGoal compares the generation before writing state',
    /if \(generation !== sessionGeneration\)/.test(real), 'no supersede guard found')

  // Every loader must go through the shared decision, or one of them keeps the old bug.
  for (const name of ['goal', 'runtime', 'preset', 'usage', 'readme']) {
    check(`load${name[0].toUpperCase()}${name.slice(1)} uses shouldLoad`, new RegExp(`shouldLoad\\(state\\.${name}Status, force\\)`).test(real))
  }
  check('no loader still has the old two-line order',
    !/=== 'loading'\) return Promise\.resolve\(\)\s*\n\s*if \(!force &&/.test(real),
    'the buggy ordering is back in at least one loader')
}

// ---- Negative control: put the ordering back and require the SAME assertions to fail -------
{
  const buggy = real.replace(
    'if (force) return true\n    return status !== \'ready\' && status !== \'loading\'',
    "if (status === 'loading') return false\n    if (!force && status === 'ready') return false\n    return status !== 'ready' && status !== 'loading'",
  )
  check('the negative-control patch actually applied', buggy !== real, 'the mutation matched nothing, so this arm proves nothing')

  const broken = compileShouldLoad(buggy)
  const stillPasses = typeof broken === 'function'
    && broken('loading', true) === true
    && broken('ready', true) === true

  check('a reintroduced bug FAILS these assertions', !stillPasses,
    'the assertions passed against the broken ordering — they cannot detect this defect')
}

if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (session switch: force wins, stale answers dropped)`)
