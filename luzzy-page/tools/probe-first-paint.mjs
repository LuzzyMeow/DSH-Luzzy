// End-to-end timing of the path the page actually takes, INCLUDING the startup warmup.
//
// This is the test that answers "why is it so slow": it runs the same sequence the host does
// (apply() schedules a deferred warmup, then the page requests) and prints what the user
// would experience in each case.
//
// Usage: node tools/probe-first-paint.mjs

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUsageAggregator } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs').replace(/\\/g, '/')}`
)

const sessionsRoot = join(homedir(), '.dsh', 'sessions')

// ---------------------------------------------------------------- case A: page opened
// AFTER the warmup finished — the normal case, since the warmup starts 15 s after launch.
{
  const aggregator = createUsageAggregator(sessionsRoot)
  const cancel = aggregator.warm({ delayMs: 50, unit: 'day' })

  const warmStart = Date.now()
  while (aggregator.warmup.ms === null && aggregator.warmup.failed === null) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log(`warmup finished in ${Date.now() - warmStart} ms (state: ${JSON.stringify(aggregator.warmup)})`)

  const t = Date.now()
  await aggregator.aggregateOffThread('day', false)
  const firstPaint = Date.now() - t
  console.log(`A. page opened after warmup  -> ${firstPaint} ms  <-- what the user sees`)
  cancel()
  aggregator.stop()
}

// ---------------------------------------------------------------- case B: page opened
// BEFORE the warmup — it must JOIN the warmup run, not start a second one.
{
  const aggregator = createUsageAggregator(sessionsRoot)
  const cancel = aggregator.warm({ delayMs: 50, unit: 'day' })
  await new Promise((resolve) => setTimeout(resolve, 80)) // warmup is now in flight

  const t = Date.now()
  await aggregator.aggregateOffThread('day', false)
  console.log(`B. page opened during warmup   -> ${Date.now() - t} ms  (joined the warmup)`)
  cancel()
  aggregator.stop()
}

// ---------------------------------------------------------------- case C: no warmup
// (warmup failed, or the page was opened in the first 15 s) — the pre-fix experience.
{
  const aggregator = createUsageAggregator(sessionsRoot)
  const t = Date.now()
  await aggregator.aggregateOffThread('day', false)
  console.log(`C. page opened with NO warmup  -> ${Date.now() - t} ms  (the old cold path)`)
  aggregator.stop()
}
