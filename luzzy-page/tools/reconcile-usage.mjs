// Reconcile the Node aggregator (what the UI will show) against the independent Python
// implementation (tools/aggregate-usage.py). Two implementations written separately
// agreeing to the digit is the evidence that the numbers are right.
//
// IMPORTANT: both sides must read the SAME snapshot. A live session is being appended to
// while this runs (it is the session running the check), and the Python side takes ~15 s,
// so comparing the live directory compares two different moments and always "fails" by
// roughly the tokens produced in between. So: freeze a copy of the logs first, then point
// both implementations at the copy.
//
// Usage:
//   node tools/reconcile-usage.mjs            # compares all four units
//   node tools/reconcile-usage.mjs --unit day
//   node tools/reconcile-usage.mjs --live     # read the live dir (expect drift)

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, mkdtempSync, cpSync } from 'node:fs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUsageAggregator } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs').replace(/\\/g, '/')}`
)

const FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens']

const args = process.argv.slice(2)
const onlyUnit = args.includes('--unit') ? args[args.indexOf('--unit') + 1] : null
const units = onlyUnit ? [onlyUnit] : ['hour', 'day', 'week', 'month']
const useLive = args.includes('--live')

const liveRoot = join(homedir(), '.dsh', 'sessions')
const scratch = mkdtempSync(join(tmpdir(), 'luzzy-reconcile-'))
let sessionsRoot = liveRoot

if (!useLive) {
  // Freeze the corpus so both implementations see byte-identical input.
  sessionsRoot = join(scratch, 'sessions')
  const started = Date.now()
  cpSync(liveRoot, sessionsRoot, { recursive: true })
  console.log(`froze session logs to ${sessionsRoot} in ${Date.now() - started} ms`)
} else {
  console.log('reading the LIVE session directory — expect drift from the active session')
}

const failures = []
const aggregator = createUsageAggregator(sessionsRoot)
console.log(`session logs found: ${aggregator.collectLogs(sessionsRoot).length}`)
console.log()

for (const unit of units) {
  // Node side — the exact code path the HTTP route will call.
  const nodePayload = aggregator.aggregate(unit, true)

  // Python side — written independently, deliberately a second implementation.
  const refPath = join(scratch, `ref-${unit}.json`)
  const t0 = Date.now()
  execFileSync(
    'python',
    [join(PLUGIN_ROOT, 'tools', 'aggregate-usage.py'), '--root', sessionsRoot, '--by', unit, '--json', refPath],
    { stdio: 'pipe' },
  )
  const pythonMs = Date.now() - t0
  const ref = JSON.parse(readFileSync(refPath, 'utf8'))

  let mismatches = 0
  const report = []

  for (const field of FIELDS) {
    const a = nodePayload.totals[field] ?? 0
    const b = ref.totals[field] ?? 0
    const ok = a === b
    if (!ok) mismatches += 1
    report.push(
      `    ${ok ? 'ok  ' : 'FAIL'} ${field.padEnd(18)} node=${String(a).padStart(15)}  python=${String(b).padStart(15)}` +
        (ok ? '' : `  diff=${a - b}`),
    )
  }

  // Bucket-level comparison catches a totals match that hides offsetting errors.
  const nodeBuckets = new Map(nodePayload.buckets.map((b) => [b.key, b.totalTokens]))
  const refBuckets = new Map(Object.entries(ref.byBucket).map(([k, v]) => [k, v.totalTokens ?? 0]))
  const allKeys = new Set([...nodeBuckets.keys(), ...refBuckets.keys()])
  let bucketMismatch = 0
  for (const key of allKeys) {
    if ((nodeBuckets.get(key) ?? 0) !== (refBuckets.get(key) ?? 0)) bucketMismatch += 1
  }
  if (bucketMismatch > 0) mismatches += 1

  console.log(`unit=${unit}  buckets node=${nodeBuckets.size} python=${refBuckets.size}  models=${nodePayload.models.length}`)
  console.log(report.join('\n'))
  console.log(
    `    ${bucketMismatch === 0 ? 'ok  ' : 'FAIL'} per-bucket totalTokens` +
      `  (${allKeys.size} buckets, ${bucketMismatch} mismatched)`,
  )
  console.log(`    python run took ${pythonMs} ms`)

  if (mismatches > 0) failures.push(unit)
  console.log()
}

if (failures.length > 0) {
  console.log(`FAIL — units disagree between implementations: ${failures.join(', ')}`)
  process.exit(1)
}

console.log(`PASS — Node and Python aggregators agree on every field and bucket (${units.join(', ')})`)

