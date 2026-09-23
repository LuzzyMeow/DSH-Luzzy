// Find session message events that lack an identifying `id`.
//
// WHY: a session failed to load with
//   `session event at seq 25 lacks an identified message`
// and the record at that seq was a `user/message` whose data had no `id`. DSH's restore
// validates that every message event identifies its message; one id-less record makes the
// whole session unreadable.
//
// This scans every session to answer: is it a one-off, or is something writing id-less
// message records into many sessions?
//
// Sessions are appended multi-frame zstd — decompressing only the first frame truncates
// silently — so split on the frame magic and decompress each frame.
//
// Usage: node tools/scan-session-message-ids.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function readRecords(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  const records = []
  let badFrames = 0
  starts.forEach((s, k) => {
    const frame = buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length)
    let text
    try { text = zstdDecompressSync(frame).toString('utf8') } catch { badFrames += 1; return }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try { records.push(JSON.parse(line)) } catch { /* partial */ }
    }
  })
  return { records, badFrames, bytes: buf.length }
}

// Where does the id live? Observed shapes:
//   user/message      -> data is the message itself: { role, content, source, id }
//   assistant/message -> data = { turn, step, message: { role, content, id? } }
function messageId(record) {
  const data = record.data ?? {}
  if (data.id !== undefined) return data.id
  if (data.message !== undefined && data.message.id !== undefined) return data.message.id
  if (data.messageId !== undefined) return data.messageId
  return undefined
}

const root = join(process.env.USERPROFILE, '.dsh', 'sessions')
let sessionsSeen = 0
let sessionsWithBad = 0
let messageRecords = 0
let missingId = 0
const report = []

for (const group of readdirSync(root)) {
  const groupPath = join(root, group)
  if (!statSync(groupPath).isDirectory()) continue
  for (const entry of readdirSync(groupPath)) {
    if (!entry.startsWith('session-')) continue
    const dirPath = join(groupPath, entry)
    if (!statSync(dirPath).isDirectory()) continue

    let file = null
    for (const name of readdirSync(dirPath)) {
      if (name.startsWith('session.v3.jsonl.zstd') || name === 'session.jsonl.zstd') { file = join(dirPath, name); break }
    }
    if (file === null) continue

    let parsed
    try { parsed = readRecords(file) } catch { continue }
    sessionsSeen += 1

    const bad = []
    for (const record of parsed.records) {
      const type = record.type ?? ''
      if (!type.endsWith('/message')) continue
      messageRecords += 1
      if (messageId(record) === undefined) {
        missingId += 1
        bad.push({ seq: record.seq, type, keys: Object.keys(record.data ?? {}).join(',') })
      }
    }
    if (bad.length > 0) {
      sessionsWithBad += 1
      report.push({ entry, file: file.replace(root, ''), frames: parsed.frames ?? '?', bad })
    }
  }
}

console.log(`sessions scanned      : ${sessionsSeen}`)
console.log(`message records       : ${messageRecords}`)
console.log(`lacking an id         : ${missingId}`)
console.log(`sessions affected     : ${sessionsWithBad}\n`)

for (const r of report) {
  console.log(`${r.entry}`)
  console.log(`  file : ${r.file}`)
  console.log(`  bad  : ${r.bad.length}`)
  for (const b of r.bad.slice(0, 6)) console.log(`    seq ${b.seq}  ${b.type}  data keys=[${b.keys}]`)
  if (r.bad.length > 6) console.log(`    … +${r.bad.length - 6} more`)
}
