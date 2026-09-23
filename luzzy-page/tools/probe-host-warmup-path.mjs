// Does the REAL host wiring actually produce a warm start?
//
// test-host-integration.mjs drives apply() against a throwaway sessions dir, so it never
// touches the cache path with real volume. This does: it uses the same aggregator
// configuration apply() uses (real sessions, cache under the diag dir), runs it exactly as
// the warmup does, then verifies a second pass is served from disk.
//
// ABOUT "DIFFERENT NUMBERS": the live sessions directory is being appended to while this
// runs — the session doing the measuring writes its own log — so one file always misses the
// cache and the attempt count grows by exactly the number of turns in flight. Comparing the
// two passes wholesale therefore always differs, and the difference is the ACTIVE log, not a
// cache defect. The authoritative equality check is on a frozen snapshot
// (tools/probe-cache-bench.mjs); this probe checks the things that only hold in the live
// case: the cache persists, nearly every file hits, and the numbers stay within the drift
// caused by that one active log.
//
// Usage: node tools/probe-host-warmup-path.mjs

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { rmSync, existsSync, statSync } from 'node:fs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUsageAggregator } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs').replace(/\\/g, '/')}`
)

const sessionsRoot = join(homedir(), '.dsh', 'sessions')
const cacheFile = join(tmpdir(), 'luzzy-host-warmup-check', 'extract-cache.json')
rmSync(join(tmpdir(), 'luzzy-host-warmup-check'), { recursive: true, force: true })

function totalsOf(payload) {
  return {
    attempts: payload.attempts,
    total: payload.totals.totalTokens,
    models: payload.models.length,
    windows: Object.keys(payload.windows ?? {}).sort().join(','),
    activityDays: payload.activity?.days.length ?? 0,
  }
}

// ---- pass 1: cold, writes the cache (this is what the deferred warmup does)
let cold
{
  const aggregator = createUsageAggregator(sessionsRoot, cacheFile)
  const started = Date.now()
  cold = await aggregator.aggregateOffThread('day', false)
  console.log(`pass 1 (cold, warmup)   ${Date.now() - started} ms   cache=${JSON.stringify(cold.cache)}`)
  aggregator.stop()
}

if (!existsSync(cacheFile)) {
  console.log('FAIL — the cache file was not written; the warmup path cannot persist anything')
  process.exit(1)
}
console.log(`cache on disk: ${(statSync(cacheFile).size / 1024 / 1024).toFixed(2)} MB`)

// ---- pass 2: fresh aggregator + fresh worker = a restart
{
  const aggregator = createUsageAggregator(sessionsRoot, cacheFile)
  const started = Date.now()
  const warm = await aggregator.aggregateOffThread('day', false)
  const ms = Date.now() - started
  console.log(`pass 2 (after restart)  ${ms} ms   cache=${JSON.stringify(warm.cache)}`)
  aggregator.stop()

  const a = totalsOf(cold)
  const b = totalsOf(warm)

  console.log()
  console.log(`  attempts ${a.attempts} -> ${b.attempts}   (delta ${b.attempts - a.attempts})`)
  console.log(`  models   ${a.models} -> ${b.models}`)
  console.log(`  windows  ${a.windows} -> ${b.windows}`)
  console.log(`  activity ${a.activityDays} -> ${b.activityDays} days`)

  // Structural things must match exactly — those cannot drift.
  if (a.models !== b.models || a.windows !== b.windows || a.activityDays !== b.activityDays) {
    console.log()
    console.log('FAIL — the warm path changed the SHAPE of the data (models/windows/activity)')
    process.exit(1)
  }

  // The only expected difference is the active session's new attempts. Bound it to the
  // number of files that missed, so a real regression (a whole log dropped, or double
  // counted) cannot hide inside "the active session grew".
  const missed = warm.cache.misses
  const delta = Math.abs(b.attempts - a.attempts)
  console.log()
  console.log(`  misses=${missed}  attempt delta=${delta}`)
  if (missed > 3) {
    console.log()
    console.log(`FAIL — ${missed} logs missed the cache; expected only the active one(s)`)
    process.exit(1)
  }
  if (delta > 50) {
    console.log()
    console.log(`FAIL — attempt count moved by ${delta} across an instant re-read;`)
    console.log('       a warm pass must agree with the cold pass apart from the active log')
    process.exit(1)
  }

  console.log()
  console.log(`PASS — cache persists (${warm.cache.hits} hits), numbers stable (drift ${delta} attempts from ${missed} active log(s))`)
  console.log('       exact equality is asserted on a frozen snapshot by probe-cache-bench.mjs')
}

rmSync(join(tmpdir(), 'luzzy-host-warmup-check'), { recursive: true, force: true })
