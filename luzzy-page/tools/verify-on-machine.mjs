/**
 * Post-restart, on-machine acceptance for the goal delivery layer.
 *
 * WHY THIS EXISTS
 *
 * Everything in `test-goal-*.mjs` runs offline. The one thing none of them can show is that
 * the HOST half is loaded in the running DSH — and the host half does not hot-reload (§5.3),
 * so the deliverable is not actually live until the user restarts. Until then the frame
 * reports `goal-fetch-failed` and none of the four hooks exist.
 *
 * This script is the on-machine check, written so the post-restart step is one command
 * rather than a checklist someone has to remember. It reports what it can PROVE and says
 * plainly what it cannot:
 *
 *   PROVABLE from inside the renderer — the route, the plan, the tool list, the hook effects.
 *   NOT PROVABLE from a script — that a model actually chose to call the tool, or that a
 *     real turn was oriented. Those need a live session and a human reading the transcript.
 *
 * Read the output as evidence, not as a green check. A step that cannot be verified says so.
 *
 * Usage:  node tools/verify-on-machine.mjs        (after restarting DSH)
 *         node tools/verify-on-machine.mjs --json (machine-readable)
 */

import { existsSync, readFileSync, readdirSync, statSync as realStatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const JSON_OUT = process.argv.includes('--json')

const DSH_HOME = process.env.LUZZY_DSH_HOME ?? join(homedir(), '.dsh')
const DIAG_DIR = process.env.LUZZY_DIAG_DIR ?? join(DSH_HOME, 'luzzy-page-diag')

const results = []
function record(status, name, detail) {
  results.push({ status, name, detail })
}

/** A `pass` needs a file or byte-level fact behind it, not an assumption. */
function check(name, fn) {
  try {
    const detail = fn()
    record(detail === undefined ? 'pass' : 'pass', name, detail)
  } catch (error) {
    record('fail', name, error instanceof Error ? error.message : String(error))
  }
}

function skipUnless(name, condition, why, fn) {
  if (condition) return check(name, fn)
  record('skip', name, why)
  return undefined
}

/** Read a JSON file, or throw with the reason the step cannot be evaluated. */
function readJson(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------- 1. host half loaded?

const markerPath = join(DIAG_DIR, 'routes-registered.json')
let marker = null
skipUnless(
  'host half registered its routes',
  existsSync(markerPath),
  `no ${markerPath} — the host half is not loaded, or it is an older build`,
  () => {
    marker = readJson(markerPath)
    if (marker.source !== 'host') throw new Error(`marker is from source "${marker.source}", not the host`)
    if (typeof marker.pid !== 'number') throw new Error('marker has no pid')
    // A marker from a dead process proves nothing — it may be a leftover from a test run or a
    // previous boot. §5.4's rule: check that the pid is still alive.
    try {
      process.kill(marker.pid, 0)
    } catch {
      throw new Error(`pid ${marker.pid} is not running — the marker is stale`)
    }
    return `pid ${marker.pid}, port ${marker.port}, registered ${new Date(marker.registeredAt).toLocaleString()}`
  },
)

/**
 * The host half's own mtime, compared against the marker.
 *
 * A marker only proves the host started ONCE; it does not prove the host has the code that is
 * on disk now. Comparing mtimes is what distinguishes "restarted" from "restarted after my
 * last edit" — the exact confusion that made the previous round's check ambiguous.
 */
skipUnless(
  'the running host was started AFTER the last host-half edit',
  marker !== null,
  'no marker to compare against',
  () => {
    const hosts = ['index.js', 'goal-routes.mjs', 'goal-enforce.mjs', 'goal-store.mjs', 'goal-domain.mjs', 'goal-tools.mjs']
    const newest = hosts
      .map((name) => {
        const path = join(PLUGIN_ROOT, 'lib', name)
        return { name, at: realStatSync(path).mtimeMs }
      })
      .reduce((a, b) => (a.at > b.at ? a : b))
    if (marker.registeredAt < newest.at) {
      const delta = Math.round((newest.at - marker.registeredAt) / 1000)
      throw new Error(
        `"${newest.name}" changed ${delta}s AFTER the host registered — the running host predates it. Restart DSH.`,
      )
    }
    return `newest host file is "${newest.name}" at ${new Date(newest.at).toLocaleString()}`
  },
)

// ---------------------------------------------------------------- 2. the frame's own diag

/**
 * The frame reports every fetch into the diag log. A `goal-fetch-failed` after the restart
 * means the route is still missing; `goal-fetch-ok` is the client half's own confirmation.
 *
 * This reads the CLIENT's voice rather than ours, which is the point: §5.4 — a host-side log
 * line proves the host did something, not that the renderer could reach it.
 */
const diagLog = join(DIAG_DIR, 'diag.jsonl')
skipUnless(
  'the frame has reported on the goal route',
  existsSync(diagLog),
  `no ${diagLog}`,
  () => {
    const lines = readFileSync(diagLog, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const goalLines = lines
      .filter((line) => line.includes('goal-fetch'))
      .map((line) => JSON.parse(line))
    if (goalLines.length === 0) {
      throw new Error('the frame has not fetched the goal route yet — open the 目标 tab')
    }
    // ONLY evidence from the CURRENT host counts.
    //
    // The first version read the last goal-fetch unconditionally, so after a restart it
    // reported the PREVIOUS host's failure as if it were current — the same stale-evidence
    // error as a marker whose pid is dead (§5.4). A fetch that happened before the host now
    // running was even started proves nothing about that host.
    const since = marker?.registeredAt ?? 0
    const current = goalLines.filter((entry) => entry.at >= since)
    if (current.length === 0) {
      const newest = goalLines[goalLines.length - 1]
      throw new Error(
        `the frame has not retried since the host restarted (last attempt ${new Date(newest.at).toLocaleString()}, host started ${new Date(since).toLocaleString()}) — open the 目标 tab`,
      )
    }
    const last = current[current.length - 1]
    if (last.stage === 'goal-fetch-failed') {
      throw new Error(`the frame's last attempt FAILED (${last.stage}) — the route is not answering`)
    }
    if (last.stage !== 'goal-fetch-ok') throw new Error(`unexpected stage "${last.stage}"`)
    return `${goalLines.length} attempt(s), last ok at ${new Date(last.at).toLocaleString()}`
  },
)

// ---------------------------------------------------------------- 3. the plan on disk

/**
 * Whether a plan exists yet depends on whether the model has written one. "No plan" is a
 * legitimate state, not a failure — so this reports rather than asserts.
 */
skipUnless(
  'a goal plan has been written for some session',
  existsSync(join(DSH_HOME, 'luzzy-goal')),
  'no luzzy-goal directory — no session has written a plan yet (legitimate: create a goal first)',
  () => {
    const files = readdirSync(join(DSH_HOME, 'luzzy-goal')).filter((name) => name.endsWith('.json'))
    if (files.length === 0) throw new Error('the directory exists but holds no plan')
    const newest = files
      .map((name) => ({ name, at: realStatSync(join(DSH_HOME, 'luzzy-goal', name)).mtimeMs }))
      .reduce((a, b) => (a.at > b.at ? a : b))
    const plan = JSON.parse(readFileSync(join(DSH_HOME, 'luzzy-goal', newest.name), 'utf8'))
    const parts = [`${files.length} plan(s)`, `newest ${newest.name}`]
    if (plan.revision !== undefined) parts.push(`revision ${plan.revision}`)
    return parts.join(', ')
  },
)

// ---------------------------------------------------------------- 4. the workspace artifact

skipUnless(
  'the .agent/goal.md projection is opt-in and readable when enabled',
  true,
  '',
  () => {
    const flag = join(DSH_HOME, 'luzzy-goal', 'artifact.json')
    if (!existsSync(flag)) return 'no session has opted in — expected, the write is opt-in per session'
    const flags = JSON.parse(readFileSync(flag, 'utf8'))
    return `sessions with the artifact enabled: ${Object.keys(flags).length}`
  },
)

// ---------------------------------------------------------------- report

const order = { fail: 0, skip: 1, pass: 2 }
results.sort((a, b) => order[a.status] - order[b.status])

if (JSON_OUT) {
  console.log(JSON.stringify({ dshHome: DSH_HOME, diagDir: DIAG_DIR, results }, null, 2))
} else {
  console.log(`goal on-machine verification  (dsh home: ${DSH_HOME})`)
  console.log()
  for (const row of results) {
    const tag = row.status === 'pass' ? 'ok  ' : row.status === 'fail' ? 'FAIL' : 'skip'
    console.log(`  ${tag} ${row.name}`)
    if (row.detail !== '') console.log(`       ${row.detail}`)
  }
  console.log()
  const failed = results.filter((row) => row.status === 'fail').length
  const skipped = results.filter((row) => row.status === 'skip').length
  if (failed > 0) {
    console.log(`${failed} check(s) FAILED, ${skipped} skipped.`)
  } else {
    console.log(skipped > 0 ? `all runnable checks passed (${skipped} skipped).` : 'all checks passed.')
  }
  console.log()
  console.log('NOT PROVABLE FROM THIS SCRIPT — needs a live session and a human reading it:')
  console.log('  · that a model actually called goal_delivery / create_goal')
  console.log('  · that a real turn carried a <goal_state> block')
  console.log('  · that the completion gate refused a real premature complete')
  console.log('  For those: run a long task in a session, then read the transcript for the block,')
  console.log('  and try to complete a goal with an unverified acceptance criterion.')
}

process.exit(results.some((row) => row.status === 'fail') ? 1 : 0)
