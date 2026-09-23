// How long does the usage aggregation actually take, cold vs warm?
//
// The page's first view pays a cold pass over every session log. This measures each phase
// separately so the fix targets the right one:
//
//   1. cold           — fresh worker, nothing parsed: decompress + parse every log
//   2. warm worker    — same worker, its per-file extract cache is warm, but the facade's
//                       30 s RESULT cache has expired: re-bucket only
//   3. warm facade    — inside the 30 s result cache: no work at all
//
// Distinguishing 2 from 3 matters: if a re-bucket is also slow, raising the result-cache TTL
// would not help and the answer has to be a startup warmup.
//
// Usage: node tools/probe-warmth.mjs

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUsageAggregator } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs').replace(/\\/g, '/')}`
)

const sessionsRoot = join(homedir(), '.dsh', 'sessions')
const aggregator = createUsageAggregator(sessionsRoot)

const t0 = Date.now()
const cold = await aggregator.aggregateOffThread('day', false)
console.log(`1. cold            ${Date.now() - t0} ms   (${cold.attempts} attempts)`)

const t1 = Date.now()
await aggregator.aggregateOffThread('day', false)
console.log(`2. result cache    ${Date.now() - t1} ms`)

// Bypass the result cache but keep the worker: this is the "30 s elapsed" case.
const t2 = Date.now()
await aggregator.aggregateOffThread('day', true)
console.log(`3. re-bucket only  ${Date.now() - t2} ms   (worker's parse cache warm)`)

aggregator.stop()
