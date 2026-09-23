// One-off probe: the exact shape of the events the 「执行状态」 and 「系统信息」 pages need.
//
// Those two pages report the current turn, tool calls, lifecycle stages, context loading and
// elapsed time. Each of those either has a real field behind it or it does not ship — so this
// dumps the real payloads first. Run before writing the route, not after.
//
// Usage: node tools/probe-runtime-events.mjs [maxLogs]

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decompressBuffer } from '../lib/usage-core.mjs'

const MAX = Number(process.argv[2] ?? 6)
const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')

const WANTED = [
  'request/context',
  'turn/start',
  'turn/end',
  'tool/call',
  'tool/result',
  'goal/change',
  'model/selection',
  'agent-preset/selected',
  'compaction/start',
  'compaction/end',
  'session',
  'session/title',
  'command/run',
  'command/done',
  'step/start',
  'step/end',
  'approval/policy',
  'sandbox/mode',
]

function collect(dir, depth, out) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, depth + 1, out)
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(full)
  }
}

const logs = []
collect(root, 0, logs)
logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const seen = new Map()
const counts = new Map()
const keysByType = new Map()

for (const path of logs.slice(0, MAX)) {
  let text
  try {
    text = decompressBuffer(readFileSync(path))
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = String(event.type ?? '(none)')
    if (!WANTED.includes(type)) continue
    counts.set(type, (counts.get(type) ?? 0) + 1)
    const topKeys = Object.keys(event).sort().join(',')
    if (!keysByType.has(type)) keysByType.set(type, new Set())
    keysByType.get(type).add(topKeys)
    const dataKeys = Object.keys(event.data ?? {}).sort().join(',')
    if (!keysByType.has(`${type}#data`)) keysByType.set(`${type}#data`, new Set())
    keysByType.get(`${type}#data`).add(dataKeys)
    // Keep the first FULL sample per type — the first is usually the richest.
    if (!seen.has(type)) seen.set(type, JSON.stringify(event))
  }
}

console.log(`scanned up to ${MAX} log(s) of ${logs.length}\n`)

for (const type of WANTED) {
  if (!seen.has(type)) {
    console.log(`--- ${type}: NOT PRESENT\n`)
    continue
  }
  console.log(`--- ${type}  (seen ${counts.get(type)}x)`)
  console.log(`    envelope keys: ${[...keysByType.get(type)].join(' | ')}`)
  console.log(`    data keys:     ${[...(keysByType.get(`${type}#data`) ?? [])].join(' | ')}`)
  const full = seen.get(type)
  console.log(`    sample: ${full.length > 1400 ? full.slice(0, 1400) + ' …TRUNCATED' : full}`)
  console.log()
}
