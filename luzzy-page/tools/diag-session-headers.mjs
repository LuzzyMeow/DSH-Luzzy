// Diagnose: does every session file's v3 header id match its directory name?
//
// DSH restores a session by reading the first frame's header and requiring `version` + a
// matching `id`. A directory whose name disagrees with the header id cannot be restored —
// which presents as "the session file is corrupt".
//
// Sessions are appended multi-frame zstd: decompressing only the first frame silently
// truncates, so split on the magic bytes 28 B5 2F FD and decompress each frame.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function splitFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  const frames = []
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    frames.push(buf.subarray(starts[k], end))
  }
  return frames
}

const root = join(process.env.USERPROFILE, '.dsh', 'sessions')
const only = process.argv[2] ?? null

let checked = 0
let mismatched = 0
let unreadable = 0

for (const group of readdirSync(root)) {
  const groupPath = join(root, group)
  if (!statSync(groupPath).isDirectory()) continue
  for (const entry of readdirSync(groupPath)) {
    if (!entry.startsWith('session-')) continue
    if (only !== null && !entry.includes(only)) continue
    const dirPath = join(groupPath, entry)
    if (!statSync(dirPath).isDirectory()) continue

    const file = join(dirPath, 'session.v3.jsonl.zstd')
    // Compare the FULL directory name against the FULL header id. The first version of this
    // script stripped the `session-` prefix from the directory but not from the header, so
    // every session reported MISMATCH — an instrument bug that looked exactly like the
    // corruption it was meant to find.
    const dirName = entry
    checked += 1

    let header
    try {
      const buf = readFileSync(file)
      const frames = splitFrames(buf)
      const first = zstdDecompressSync(frames[0]).toString('utf8').split('\n')[0]
      header = JSON.parse(first)
    } catch (error) {
      unreadable += 1
      console.log(`  UNREADABLE ${entry}  ${error.message}`)
      continue
    }

    const headerId = header.id ?? header.sessionId ?? null
    const ok = headerId === dirName
    if (!ok) mismatched += 1
    console.log(
      `  ${ok ? 'ok  ' : 'MISMATCH'} dir=${dirName}  header.id=${String(headerId)}  type=${header.type}  v=${header.version}`,
    )
  }
}

console.log(`\nchecked ${checked} session dir(s): ${mismatched} mismatched, ${unreadable} unreadable`)
