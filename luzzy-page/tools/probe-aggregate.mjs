// Diagnostic: run the usage aggregator exactly as the host half does, outside DSH.
//
// Why this exists: the usage sub-page stuck at "正在统计用量…". Before touching any
// code, this tells us whether the aggregator itself works — worker starts, logs parse,
// numbers come out — so a failure can be attributed to the worker or to the route.
//
// Usage: node tools/probe-aggregate.mjs [hour|day|week|month]

import { createUsageAggregator } from '../lib/usage-aggregate.mjs'

const unit = process.argv[2] ?? 'day'
const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`
const sessionsRoot = `${home}\\sessions`

console.log('sessionsRoot:', sessionsRoot)
console.log('unit        :', unit)

const aggregator = createUsageAggregator(sessionsRoot)
console.log('workerAlive(before):', aggregator.workerAlive)

const started = Date.now()
try {
  const payload = await aggregator.aggregateOffThread(unit)
  const ms = Date.now() - started
  console.log(`OK in ${ms} ms`)
  console.log('  sessions :', payload.sessions)
  console.log('  skipped  :', payload.skipped)
  console.log('  attempts :', payload.attempts)
  console.log('  buckets  :', payload.buckets.length)
  console.log('  models   :', payload.models.length)
  console.log('  totalTok :', payload.totals.totalTokens)
  console.log('  cacheTok :', payload.totals.cacheReadTokens)
  console.log('  first    :', payload.buckets[0]?.key, '->', payload.buckets.at(-1)?.key)

  const again = Date.now()
  await aggregator.aggregateOffThread(unit)
  console.log(`warm repeat: ${Date.now() - again} ms (cache)`)
} catch (error) {
  console.log(`FAIL after ${Date.now() - started} ms`)
  console.log(error)
} finally {
  aggregator.stop()
}
