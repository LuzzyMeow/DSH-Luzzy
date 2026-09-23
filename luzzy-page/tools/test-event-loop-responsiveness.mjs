// Verify the aggregator NEVER blocks the host's main thread for long.
//
// This is the regression test for the crash: an earlier version ran the whole aggregation
// synchronously (directly, and from a startup warmup), which held the main thread for ~20 s
// of zstd inflation and starved the profile admission channel's 30 s RPC window. host-boot
// then failed after ~123 s and DSH would not start.
//
// Two paths are measured, and the SECOND is the one that matters most now:
//
//   1. a cold request  — the call the route handler makes
//   2. the background WARMUP — the call `apply()` schedules at startup. A warmup reintroduces
//      exactly the shape of the original crash (heavy work around boot), so it gets the same
//      budget as a request: if it ever blocks the loop, the app will not start again.
//
// Usage: node tools/test-event-loop-responsiveness.mjs

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUsageAggregator } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs').replace(/\\/g, '/')}`
)

const SESSIONS = join(homedir(), '.dsh', 'sessions')
const LIMIT_MS = 1000 // a single event-loop stall above this is a failure

/** Sample the event loop continuously while `work` runs; return the worst gap seen. */
async function measureStall(work) {
  let worst = 0
  let active = true
  const sampler = (async () => {
    let previous = Date.now()
    while (active) {
      await new Promise((resolve) => setImmediate(resolve))
      const now = Date.now()
      if (now - previous > worst) worst = now - previous
      previous = now
    }
  })()
  let result
  let error
  try {
    result = await work()
  } catch (thrown) {
    error = thrown
  } finally {
    active = false
    await sampler
  }
  if (error !== undefined) throw error
  return { result, worst }
}

const failures = []
const notes = []

// ---------------------------------------------------------------- (1) a cold request

{
  const aggregator = createUsageAggregator(SESSIONS)
  console.log(`session logs root: ${SESSIONS}`)
  console.log(`budget: no single event-loop stall above ${LIMIT_MS} ms`)
  console.log()

  const started = Date.now()
  const { result: payload, worst } = await measureStall(() => aggregator.aggregateOffThread('day', true))
  const elapsed = Date.now() - started

  console.log(`cold request: ${elapsed} ms (${payload.attempts} attempts, ${payload.buckets.length} buckets)`)
  console.log(`             worst event-loop stall: ${worst} ms`)
  if (worst > LIMIT_MS) {
    failures.push(`cold request stalled the loop for ${worst} ms (> ${LIMIT_MS} ms budget)`)
  } else {
    notes.push(`  ok   cold request keeps the loop responsive (worst ${worst} ms)`)
  }

  // The payload shape the client now depends on.
  if (payload.windows === undefined) {
    failures.push('cold request payload has no `windows` — the client cannot draw the trend chart')
  } else {
    notes.push('  ok   cold request returns the trend windows')
  }
  if (payload.activity === undefined) {
    failures.push('cold request payload has no `activity` — the client cannot draw the strip')
  } else {
    notes.push('  ok   cold request returns the activity strip')
  }

  // A warm call must not touch the worker at all.
  const warmStart = Date.now()
  await aggregator.aggregateOffThread('day', false)
  const warmMs = Date.now() - warmStart
  console.log(`warm call:    ${warmMs} ms`)
  if (warmMs > 500) {
    failures.push(`warm call took ${warmMs} ms; the result cache is not working`)
  } else {
    notes.push(`  ok   warm call is served from the result cache (${warmMs} ms)`)
  }

  aggregator.stop()
}

// ---------------------------------------------------------------- (2) the startup warmup

{
  const aggregator = createUsageAggregator(SESSIONS)

  // A short delay so the test does not sit for the production 15 s.
  const cancel = aggregator.warm({ delayMs: 50, unit: 'day' })

  const { worst } = await measureStall(async () => {
    // Wait for the warmup to finish, bounded so a hang fails instead of blocking forever.
    const deadline = Date.now() + 90_000
    while (aggregator.warmup.ms === null && aggregator.warmup.failed === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })

  const state = aggregator.warmup
  console.log()
  console.log(`warmup:       ${state.ms === null ? `failed: ${state.failed}` : `${state.ms} ms`}`)
  console.log(`             worst event-loop stall: ${worst} ms`)

  if (worst > LIMIT_MS) {
    // This is the crash shape. Say so plainly, because a future edit that moves the warmup
    // onto the main thread would otherwise look like a harmless change.
    failures.push(
      `the startup warmup stalled the loop for ${worst} ms — this is the shape that made DSH ` +
        'unable to start twice (see AGENTS.md §5.2)',
    )
  } else {
    notes.push(`  ok   startup warmup keeps the loop responsive (worst ${worst} ms)`)
  }

  if (state.failed !== null) {
    failures.push(`warmup failed: ${state.failed}`)
  } else if (state.ms === null) {
    failures.push('warmup never finished')
  } else {
    notes.push(`  ok   startup warmup completes (${state.ms} ms)`)
  }

  // Cancelling must be safe — apply() cancels through ctx.effect on unload.
  cancel()
  cancel() // idempotent
  notes.push('  ok   warmup cancel is callable and idempotent')

  aggregator.stop()
}

// Also check the ordering contract: warm() must NOT run before its delay, since the whole
// safety argument rests on it being deferred past startup.
{
  const aggregator = createUsageAggregator(SESSIONS)
  aggregator.warm({ delayMs: 5_000, unit: 'day' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const tooEarly = aggregator.warmup.startedAt !== null
  if (tooEarly) {
    failures.push('warmup started before its delay elapsed — it must not compete with startup')
  } else {
    notes.push('  ok   warmup is deferred, not run at once')
  }
  aggregator.stop()
}

// ---------------------------------------------------------------- report

console.log()
console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.map((f) => `  FAIL ${f}`).join('\n'))
  console.log(`\nFAIL — ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('PASS — aggregation and warmup keep the event loop responsive')
process.exit(0)