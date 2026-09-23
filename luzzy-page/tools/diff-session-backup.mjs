// Compare a session backup against its live file.
//
// WHY: a repair that rewrites a session file can silently DROP records. Size alone does not
// prove that (zstd frames compress differently), so count records and compare the set of
// event `seq` numbers.
//
// Sessions are appended multi-frame zstd; decompressing only the first frame truncates
// silently, so split on the frame magic 28 B5 2F FD and decompress each frame.
//
// Usage: node tools/diff-session-backup.mjs <session-id-prefix>

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
  const frames = starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length))
  const records = []
  const badFrames = []
  frames.forEach((frame, index) => {
    let text
    try { text = zstdDecompressSync(frame).toString('utf8') } catch (error) {
      badFrames.push({ index, error: error.message })
      return
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try { records.push(JSON.parse(line)) } catch { /* partial tail line */ }
    }
  })
  return { frames: frames.length, records, badFrames, bytes: buf.length }
}

const prefix = process.argv[2]
if (prefix === undefined) { console.error('usage: node tools/diff-session-backup.mjs <session-prefix>'); process.exit(2) }

const home = process.env.USERPROFILE
const liveRoot = join(home, '.dsh', 'sessions')
const backupRoot = join(home, '.dsh', 'session-id-repair-backup')

function locate(root, wantDir) {
  for (const group of readdirSync(root)) {
    const groupPath = join(root, group)
    if (!statSync(groupPath).isDirectory()) continue
    for (const entry of readdirSync(groupPath)) {
      if (!entry.startsWith('session-') || !entry.includes(prefix)) continue
      if (wantDir !== null && entry !== wantDir) continue
      const dirPath = join(groupPath, entry)
      for (const name of readdirSync(dirPath)) {
        if (name.startsWith('session.v3.jsonl.zstd')) return join(dirPath, name)
      }
    }
  }
  return null
}

const liveFile = locate(liveRoot, null)
const backupFile = locate(backupRoot, null)
if (liveFile === null) { console.error(`no live session matching ${prefix}`); process.exit(2) }
if (backupFile === null) { console.error(`no BACKUP for ${prefix}`); process.exit(2) }

const live = readRecords(liveFile)
const backup = readRecords(backupFile)

console.log(`live  : ${liveFile}\n        ${live.records.length} records, ${live.frames} frames, ${(live.bytes / 1024).toFixed(1)} KB`)
console.log(`backup: ${backupFile}\n        ${backup.records.length} records, ${backup.frames} frames, ${(backup.bytes / 1024).toFixed(1)} KB`)
if (live.badFrames.length > 0) console.log(`live bad frames: ${JSON.stringify(live.badFrames)}`)
if (backup.badFrames.length > 0) console.log(`backup bad frames: ${JSON.stringify(backup.badFrames)}`)

const liveSeqs = new Set(live.records.map((r) => r.seq).filter((s) => s !== undefined))
const backupSeqs = new Set(backup.records.map((r) => r.seq).filter((s) => s !== undefined))

const lost = [...backupSeqs].filter((s) => !liveSeqs.has(s)).sort((a, b) => a - b)
const added = [...liveSeqs].filter((s) => !backupSeqs.has(s)).sort((a, b) => a - b)

console.log(`\nseq range  live ${Math.min(...liveSeqs)}..${Math.max(...liveSeqs)}   backup ${Math.min(...backupSeqs)}..${Math.max(...backupSeqs)}`)
console.log(`LOST in live (present in backup, missing now): ${lost.length}`)
if (lost.length > 0) console.log(`  ${lost.slice(0, 40).join(', ')}${lost.length > 40 ? ' …' : ''}`)
console.log(`NEW in live: ${added.length}`)
if (added.length > 0) console.log(`  ${added.slice(0, 40).join(', ')}${added.length > 40 ? ' …' : ''}`)

// What did the record that failed validation look like?
for (const seq of [25]) {
  const b = backup.records.find((r) => r.seq === seq)
  const l = live.records.find((r) => r.seq === seq)
  console.log(`\n--- seq ${seq} ---`)
  console.log(`  backup: ${b === undefined ? 'ABSENT' : `${b.type} keys=${Object.keys(b.data ?? {}).join(',')}`}`)
  console.log(`  live  : ${l === undefined ? 'ABSENT' : `${l.type} keys=${Object.keys(l.data ?? {}).join(',')}`}`)
}
