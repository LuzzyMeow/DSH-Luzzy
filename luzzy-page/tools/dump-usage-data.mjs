// Dump the real usage payload to JSON, for the offline preview renderer.
//
// The shape mirrors what GET /__luzzy/usage returns: totals + buckets + models + all three
// trend windows + the month activity strip. One payload — the client picks the window, so
// there are no per-unit variants any more.
//
// Usage: node tools/dump-usage-data.mjs [--out path]

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUsageAggregator } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs').replace(/\\/g, '/')}`
)
const { extractLog, decompressBuffer } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-core.mjs').replace(/\\/g, '/')}`
)
const { windowSeries, monthActivity } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-window.mjs').replace(/\\/g, '/')}`
)

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = outIndex >= 0 ? args[outIndex + 1] : join(tmpdir(), 'luzzy-usage-data.json')

const sessionsRoot = join(homedir(), '.dsh', 'sessions')
const aggregator = createUsageAggregator(sessionsRoot)

// `aggregateOffThread` — the synchronous `aggregate()` this used to call no longer exists.
// Aggregation MUST stay off the main thread (that contract is why the worker exists), and
// it is async.
const payload = await aggregator.aggregateOffThread('day', true)
aggregator.stop()

// The worker already computes `windows` and `activity`. If a payload predates that (or the
// worker is an older build), fall back to computing them here from the raw logs so the
// preview never silently renders an empty chart.
if (!payload.windows || !payload.activity) {
  const { readdirSync, readFileSync } = await import('node:fs')
  const files = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.endsWith('.jsonl.zstd')) files.push(full)
    }
  }
  walk(sessionsRoot, 0)

  const attempts = []
  let skipped = 0
  for (const file of files) {
    try {
      for (const attempt of extractLog(decompressBuffer(readFileSync(file))).attempts) attempts.push(attempt)
    } catch {
      skipped += 1
    }
  }

  const now = new Date()
  const merged = { attempts }
  payload.windows = {
    day: windowSeries(merged, 'day', now),
    week: windowSeries(merged, 'week', now),
    month: windowSeries(merged, 'month', now),
  }
  payload.activity = monthActivity(merged, now)
  console.log(`(computed windows locally: ${files.length} logs, ${skipped} unreadable, ${attempts.length} attempts)`)
}

writeFileSync(out, JSON.stringify(payload), 'utf-8')

const day = payload.windows.day
console.log(`attempts: ${payload.attempts}  sessions: ${payload.sessions}`)
console.log(`totals:   ${payload.totals.totalTokens.toLocaleString()} tokens`)
console.log(`day:      ${day.slots.length} slots, ${day.series.length} models`)
console.log(`week:     ${payload.windows.week.slots.length} slots, ${payload.windows.week.series.length} models`)
console.log(`month:    ${payload.windows.month.slots.length} slots, ${payload.windows.month.series.length} models`)
console.log(`activity: ${payload.activity.days.length} days in ${payload.activity.month}`)
console.log(`wrote:    ${out}`)
