// Read a DSH session transcript as text, for diagnosis.
//
// Sessions are appended multi-frame zstd. `zstdDecompressSync` on the whole buffer returns
// ONLY the first frame and silently truncates (measured elsewhere in this project: 1.9 MB →
// 222 bytes, no error). So split on the frame magic and decompress each frame.
//
// Usage: node tools/read-session.mjs <session-id-prefix> [--roles user,assistant] [--tail N]

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
  return starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length))
}

const args = process.argv.slice(2)
const prefix = args[0]
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const roles = argValue('--roles', 'user').split(',')
const tail = Number(argValue('--tail', '40'))
const maxChars = Number(argValue('--chars', '700'))

if (prefix === undefined) {
  console.error('usage: node tools/read-session.mjs <session-id-prefix> [--roles user,assistant] [--tail N]')
  process.exit(2)
}

const root = join(process.env.USERPROFILE, '.dsh', 'sessions')
let file = null
for (const group of readdirSync(root)) {
  const groupPath = join(root, group)
  if (!statSync(groupPath).isDirectory()) continue
  for (const entry of readdirSync(groupPath)) {
    if (!entry.includes(prefix) || !entry.startsWith('session-')) continue
    for (const name of ['session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
      const candidate = join(groupPath, entry, name)
      try {
        if (statSync(candidate).isFile()) { file = candidate; break }
      } catch { /* keep looking */ }
    }
    if (file !== null) break
  }
  if (file !== null) break
}
if (file === null) { console.error(`no session matching ${prefix}`); process.exit(2) }
console.log(`reading ${file}`)

const frames = splitFrames(readFileSync(file))
console.log(`frames: ${frames.length}`)

const lines = []
for (const frame of frames) {
  let text
  try { text = zstdDecompressSync(frame).toString('utf8') } catch { continue }
  for (const line of text.split('\n')) if (line.trim() !== '') lines.push(line)
}
console.log(`records: ${lines.length}\n`)

const picked = []
for (const line of lines) {
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  // Session records are typed (`user/message`, `assistant/message`, `tool/call`, …), not
  // role-tagged. The first version of this reader looked only for `role` and therefore
  // matched 0 assistant records — an instrument bug that reads as "the agent said nothing".
  const type = rec.type ?? ''
  const role = type.includes('/') ? type.split('/')[0] : (rec.role ?? rec.message?.role ?? null)
  if (role === null || !roles.includes(role)) continue
  const data = rec.data ?? rec
  // Shape, observed directly rather than guessed:
  //   { type:'assistant/message', seq, time, data:{ turn, step, message:{ role, content:[…] } } }
  //   content blocks are { type:'reasoning'|'text', text }
  const msg = data.message ?? data
  const content = msg.content ?? data.content ?? data.text ?? ''
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('')
  }
  if (text.trim() === '') continue
  picked.push({ role, text })
}

console.log(`matched ${picked.length} record(s) with role in [${roles.join(',')}]\n`)
for (const p of picked.slice(-tail)) {
  console.log(`--- ${p.role} ---`)
  console.log(p.text.length > maxChars ? `${p.text.slice(0, maxChars)}\n   …[+${p.text.length - maxChars} chars]` : p.text)
  console.log()
}
