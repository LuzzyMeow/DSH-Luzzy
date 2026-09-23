/**
 * Assert the goal store: compare-and-set, atomic writes, the artifact projection and the
 * opt-in flag.
 *
 * Every case here exists because the failure it guards against is SILENT. A lost update
 * shows up as a plan that quietly reverted; a half-written document often still parses and
 * is believed; an artifact written into the wrong directory is a write into somebody's
 * repository they never asked for. None of those throw where a person would see it.
 *
 * Run: node tools/test-goal-store.mjs
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const store = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-store.mjs')).href)
const domain = await import(pathToFileURL(join(HERE, '..', 'lib', 'goal-domain.mjs')).href)

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

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const AT = 1_700_000_000_000
const GOAL = {
  id: 'goal-abc', revision: 3, objective: '把 Dashboard 接入 /api/tasks', phase: 'active',
  activation: 'armed', roundsStarted: 2, maxGoalRounds: 256,
}

const tempRoots = []
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'luzzy-goal-store-'))
  tempRoots.push(home)
  return home
}

/** A plan built through the real ops, so the store is exercised on real documents. */
function sampleDelivery() {
  let delivery = domain.emptyDelivery('sess-1')
  for (const [op, payload] of [
    ['addAcceptance', { description: 'loading / empty / error 三态都有' }],
    ['addEvidence', { summary: 'pnpm test passed', kind: 'test', ref: 'pnpm test', acceptance: ['AC-001'] }],
    ['setAcceptanceStatus', { id: 'AC-001', status: 'verified' }],
    ['setFocus', { focus: '验证三种状态' }],
  ]) {
    const result = domain.applyDeliveryOp(delivery, op, payload, { at: AT, actor: 'agent' })
    delivery = result.delivery
  }
  return delivery
}

try {
  console.log('goal-store: paths')
  {
    const home = freshHome()
    const paths = store.storePaths(home)
    eq('the store lives under DSH home', paths.dir, join(home, 'luzzy-goal'))
    eq('a session file is keyed by session id', store.sessionFile(paths, 'sess-1'), join(home, 'luzzy-goal', 'sess-1.json'))
    eq('the artifact path is relative to a workspace', store.ARTIFACT_RELATIVE_PATH, join('.agent', 'goal.md'))
    eq('DSH_HOME wins when set', store.resolveDshHome({ DSH_HOME: 'D:/dsh' }), 'D:/dsh')
    check('a blank DSH_HOME falls back to ~/.dsh', store.resolveDshHome({ DSH_HOME: '  ' }).endsWith('.dsh'))
  }

  console.log('goal-store: session ids become file names, so they are validated')
  {
    for (const bad of ['', '..', '../escape', 'a/b', 'a\\b', 'x'.repeat(300), null, 42]) {
      check(`refuses ${JSON.stringify(bad)}`, store.sessionIdProblem(bad) !== undefined)
    }
    for (const good of ['sess-1', 'abc.def_ghi', 'ABC123']) {
      eq(`accepts ${JSON.stringify(good)}`, store.sessionIdProblem(good), undefined)
    }
    const paths = store.storePaths(freshHome())
    const refused = store.readDeliveryOverlay(paths, '../escape')
    eq('a traversal id cannot be read', refused.ok, false)
  }

  console.log('goal-store: absent is empty, not an error')
  {
    const paths = store.storePaths(freshHome())
    const read = store.readDeliveryOverlay(paths, 'sess-1')
    eq('reading a session with no file succeeds', read.ok, true)
    eq('and reports itself as absent', read.source, 'absent')
    eq('with an empty plan', read.delivery.acceptance.length, 0)
    eq('and revision zero', read.revision, 0)
  }

  console.log('goal-store: an unreadable document is named, not disguised as empty')
  {
    const paths = store.storePaths(freshHome())
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(store.sessionFile(paths, 'sess-1'), '{ this is not json', 'utf8')
    const read = store.readDeliveryOverlay(paths, 'sess-1')
    // "Your plan could not be read" and "you have no plan" are very different things to
    // tell someone who believes they wrote one.
    eq('unparsable is a failure, not an empty plan', read.ok, false)
    eq('and is labelled as such', read.source, 'unparsable')
    check('the reason names the problem', /解析失败/.test(read.reason))
  }
  {
    const paths = store.storePaths(freshHome())
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(store.sessionFile(paths, 'sess-1'), JSON.stringify({ version: 99 }), 'utf8')
    const read = store.readDeliveryOverlay(paths, 'sess-1')
    eq('a future version is refused wholesale', read.ok, false)
    eq('and is labelled as a version problem', read.source, 'version')
  }

  console.log('goal-store: compare-and-set')
  {
    const paths = store.storePaths(freshHome())
    const first = store.writeDeliveryOverlay(paths, 'sess-1', sampleDelivery(), 0)
    eq('the first write succeeds', first.ok, true)
    eq('and lands at revision 1', first.revision, 1)

    const read = store.readDeliveryOverlay(paths, 'sess-1')
    eq('read back at revision 1', read.revision, 1)

    const second = store.writeDeliveryOverlay(paths, 'sess-1', read.delivery, 1)
    eq('a write against the revision just read succeeds', second.ok, true)
    eq('and advances the revision', second.revision, 2)

    // The whole point: a writer holding an old revision must not overwrite a newer one.
    const stale = store.writeDeliveryOverlay(paths, 'sess-1', read.delivery, 1)
    eq('a write against a STALE revision is refused', stale.ok, false)
    eq('with a stable code', stale.code, domain.ERROR_CODES.STALE_REVISION)
    check('and the current document comes back, so the loser can show the truth', stale.current !== undefined)
    eq('the stored revision was not clobbered', store.readDeliveryOverlay(paths, 'sess-1').revision, 2)
  }

  console.log('goal-store: absent and unreadable are DIFFERENT answers')
  {
    // This distinction was a real defect: every read failure used to collapse to `absent`,
    // so a plan that existed but could not be read was handed to the commit barrier as an
    // EMPTY plan — and the barrier then asked the model to reconcile against a plan it never
    // wrote. The page told the user "you have no plan" about a plan sitting on disk.
    const paths = store.storePaths(freshHome())
    mkdirSync(join(paths.dir, 'sess-dir.json'), { recursive: true })
    const read = store.readDeliveryOverlay(paths, 'sess-dir')
    eq('a directory at the plan path is NOT "absent"', read.ok, false)
    eq('it is named as unreadable', read.source, 'unreadable')
    check('and the reason names the errno', /EISDIR/.test(read.reason), read.reason)
    check('and the reason names the path', read.reason.includes('sess-dir.json'))
    // The counterpart: a genuinely missing file is still a normal first-run state, not a
    // failure. Getting this backwards would make every fresh session look broken.
    const missing = store.readDeliveryOverlay(paths, 'never-written')
    eq('a genuinely missing file is still absent', missing.ok, true)
    eq('with the absent source', missing.source, 'absent')
    eq('and an empty plan at revision 0', missing.revision, 0)
  }

  console.log('goal-store: the written document is a round trip')
  {
    const paths = store.storePaths(freshHome())
    const delivery = sampleDelivery()
    store.writeDeliveryOverlay(paths, 'sess-1', delivery, 0)
    const read = store.readDeliveryOverlay(paths, 'sess-1')
    eq('acceptance survived', read.delivery.acceptance.length, 1)
    eq('its verified state survived', read.delivery.acceptance[0].status, 'verified')
    eq('its evidence link survived', read.delivery.acceptance[0].evidence.join(','), 'E-001')
    eq('the focus survived', read.delivery.focus, '验证三种状态')
    eq('the evidence survived', read.delivery.evidence[0].summary, 'pnpm test passed')
    // JSON on disk, not a JS object with methods — the file must stay hand-readable.
    const raw = readFileSync(store.sessionFile(paths, 'sess-1'), 'utf8')
    check('the file is pretty-printed JSON', raw.includes('\n  "version"'))
    check('and ends with a newline', raw.endsWith('\n'))
  }

  console.log('goal-store: writes are atomic')
  {
    const paths = store.storePaths(freshHome())
    store.writeDeliveryOverlay(paths, 'sess-1', sampleDelivery(), 0)
    const file = store.sessionFile(paths, 'sess-1')
    const before = readFileSync(file, 'utf8')
    const next = { ...sampleDelivery(), focus: '改过的焦点' }
    store.writeDeliveryOverlay(paths, 'sess-1', next, 1)
    check('the replacement is complete', readDeliveryText(file).includes('改过的焦点'))
    // A failed atomic write must leave the ORIGINAL intact rather than a truncated file.
    eq('no temp files are left behind', tempFiles(paths).length, 0, JSON.stringify(tempFiles(paths)))
    check('the original was replaced, not appended', readFileSync(file, 'utf8') !== before)
  }

  console.log('goal-store: artifact is opt-in')
  {
    const paths = store.storePaths(freshHome())
    eq('nothing is enabled to begin with', store.readArtifactFlags(paths).enabled, false)
    store.writeArtifactFlag(paths, 'sess-1', true, 'C:/work/demo')
    eq('enabling is remembered', store.readArtifactFlags(paths).sessions['sess-1'].cwd, 'C:/work/demo')
    store.writeArtifactFlag(paths, 'sess-1', false)
    eq('disabling forgets it', store.readArtifactFlags(paths).sessions['sess-1'], undefined)
  }
  {
    const paths = store.storePaths(freshHome())
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.flags, 'not json at all', 'utf8')
    // An unreadable flag file must mean "not enabled": that direction can only ever cause a
    // missing artifact, never a write into somebody's repository.
    eq('an unreadable flag file means not enabled', store.readArtifactFlags(paths).enabled, false)
  }

  console.log('goal-store: the artifact projection')
  {
    const home = freshHome()
    const paths = store.storePaths(home)
    const cwd = join(home, 'workspace')
    mkdirSync(cwd, { recursive: true })
    const delivery = sampleDelivery()

    const written = store.writeArtifact(cwd, delivery, GOAL, AT)
    eq('the write succeeds', written.ok, true)
    eq('into the documented relative path', written.path, join(cwd, '.agent', 'goal.md'))
    check('and reports a change', written.changed === true)
    check('the file exists', statSync(written.path).size > 0)

    const text = readFileSync(written.path, 'utf8')
    check('it carries the objective', text.includes(GOAL.objective))
    check('it carries the plan', text.includes('loading / empty / error 三态都有'))

    // Writing identical bytes again must be a no-op, or every page load would churn the
    // file's mtime and turn a no-op into a Git diff.
    const again = store.writeArtifact(cwd, delivery, GOAL, AT)
    eq('an unchanged state does not rewrite the file', again.changed, false)
    const stale = store.writeArtifact(cwd, { ...delivery, focus: '新的焦点' }, GOAL, AT)
    eq('a changed state does rewrite it', stale.changed, true)

    const back = store.readArtifact(cwd)
    eq('read-back finds it', back.exists, true)
    check('and returns its text', typeof back.text === 'string' && back.text.includes('新的焦点'))
    check('and its mtime', back.mtime > 0)
  }
  {
    const home = freshHome()
    const cwd = join(home, 'empty-workspace')
    mkdirSync(cwd, { recursive: true })
    const back = store.readArtifact(cwd)
    eq('reading an artifact that was never written reports absent', back.exists, false)
    eq('with no text', back.text, null)
    // No cwd at all: the caller must be told, not given a path relative to the process.
    const noCwd = store.writeArtifact(null, sampleDelivery(), GOAL, AT)
    eq('writing without a workspace is refused', noCwd.ok, false)
    check('and says why', /工作目录/.test(noCwd.reason))
  }

  console.log('goal-store: clearing is explicit and reversible in intent')
  {
    const paths = store.storePaths(freshHome())
    store.writeDeliveryOverlay(paths, 'sess-1', sampleDelivery(), 0)
    eq('the plan exists', store.readDeliveryOverlay(paths, 'sess-1').revision, 1)
    const removed = store.removeDeliveryOverlay(paths, 'sess-1')
    eq('clearing removes it', removed.removed, true)
    eq('and the session reads as empty again', store.readDeliveryOverlay(paths, 'sess-1').source, 'absent')
    eq('clearing again is a no-op, not an error', store.removeDeliveryOverlay(paths, 'sess-1').removed, false)
  }

  console.log('goal-store: listing')
  {
    const paths = store.storePaths(freshHome())
    store.writeDeliveryOverlay(paths, 'sess-a', sampleDelivery(), 0)
    store.writeDeliveryOverlay(paths, 'sess-b', sampleDelivery(), 0)
    store.writeArtifactFlag(paths, 'sess-a', true, 'C:/x')
    const ids = store.listStoredSessions(paths).sort()
    eq('both sessions are listed', ids.join(','), 'sess-a,sess-b')
    check('the flag file is not mistaken for a session', !ids.includes('artifact'))
  }
} finally {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

function readDeliveryText(file) {
  return readFileSync(file, 'utf8')
}

function tempFiles(paths) {
  try {
    return readdirSync(paths.dir).filter((name) => name.endsWith('.tmp'))
  } catch {
    return []
  }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (goal-store)`)
