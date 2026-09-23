// Does the parsed-log cache actually make a RESTART fast, and stay correct?
//
// Two aggregators are built back to back against the SAME cache file with NO shared state —
// which is exactly what a DSH restart looks like: a fresh process, a fresh worker, and
// whatever the previous run left on disk.
//
// The second run must be (a) fast and (b) produce identical numbers. A cache that is fast
// but wrong is worse than no cache at all, so both are asserted.
//
// THE LOGS ARE FROZEN FIRST. The live sessions directory is being appended to while this
// runs — the session doing the measuring is itself writing a log — so comparing live against
// live can never be identical, and the difference would be a moving target rather than a
// cache bug. The first version of this test compared live runs and reported a mismatch that
// was nothing but one extra attempt from the active session. Copying the logs costs a few
// seconds and makes the comparison meaningful.
//
// Usage: node tools/probe-cache-bench.mjs

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUsageAggregator } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs').replace(/\\/g, '/')}`
)

const liveRoot = join(homedir(), '.dsh', 'sessions')
const frozenRoot = join(tmpdir(), 'luzzy-cache-bench-sessions')
const cacheFile = join(tmpdir(), 'luzzy-cache-bench.json')

rmSync(frozenRoot, { recursive: true, force: true })
rmSync(cacheFile, { force: true })
mkdirSync(frozenRoot, { recursive: true })
for (const entry of readdirSync(liveRoot, { withFileTypes: true })) {
  cpSync(join(liveRoot, entry.name), join(frozenRoot, entry.name), { recursive: true })
}
console.log(`frozen a snapshot of the logs at ${frozenRoot}`)

/**
 * Compare the parts the page depends on.
 *
 * `generatedAt` and each window's `to` are WALL-CLOCK stamps taken when the run computed
 * them, so two runs seconds apart always differ there. They are timestamps, not cached data,
 * and comparing them made this test fail on a correct cache. Everything derived from the
 * logs is kept.
 */
function fingerprint(payload) {
  const { generatedAt, ...rest } = payload
  const windows = {}
  for (const [name, win] of Object.entries(rest.windows ?? {})) {
    const { to, ...winRest } = win
    windows[name] = winRest
  }
  return JSON.stringify({
    attempts: rest.attempts,
    sessions: rest.sessions,
    skipped: rest.skipped,
    totals: rest.totals,
    buckets: rest.buckets,
    models: rest.models,
    activity: rest.activity,
    windows,
  })
}

const runs = []
for (const label of ['1. no cache (cold)', '2. after restart (cached)']) {
  const aggregator = createUsageAggregator(frozenRoot, cacheFile)
  const started = Date.now()
  const payload = await aggregator.aggregateOffThread('day', false)
  const ms = Date.now() - started
  aggregator.stop()
  runs.push({ label, ms, payload })
  console.log(`${label.padEnd(26)} ${String(ms).padStart(6)} ms   cache=${JSON.stringify(payload.cache)}`)
}

const [cold, cached] = runs
console.log()
console.log(`attempts: ${cold.payload.attempts} -> ${cached.payload.attempts}`)
console.log(`totals  : ${cold.payload.totals.totalTokens} -> ${cached.payload.totals.totalTokens}`)

// Every file must have been served from the cache: a frozen snapshot cannot change, so a
// miss would mean the staleness key is too strict (and the cache would rarely help in use).
if (cached.payload.cache.misses !== 0) {
  console.log()
  console.log(`FAIL — ${cached.payload.cache.misses} file(s) missed on a frozen snapshot;`)
  console.log('       the (size, mtime) key is rejecting files that did not change.')
  process.exit(1)
}

const same = fingerprint(cold.payload) === fingerprint(cached.payload)
if (!same) {
  console.log()
  console.log('FAIL — the cached run produced DIFFERENT numbers than the cold run.')
  console.log('       A cache that is fast but wrong is worse than no cache.')
  const a = fingerprint(cold.payload)
  const b = fingerprint(cached.payload)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      console.log(`       first difference at char ${i}:`)
      console.log(`         cold  : …${a.slice(Math.max(0, i - 60), i + 60)}…`)
      console.log(`         cached: …${b.slice(Math.max(0, i - 60), i + 60)}…`)
      break
    }
  }
  process.exit(1)
}

const speedup = (cold.ms / Math.max(cached.ms, 1)).toFixed(0)
console.log()
console.log(`PASS — identical results on a frozen snapshot, ${speedup}x faster on a restart`)
rmSync(frozenRoot, { recursive: true, force: true })
rmSync(cacheFile, { force: true })
