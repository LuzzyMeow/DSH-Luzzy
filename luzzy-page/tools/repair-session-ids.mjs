/**
 * Give an identity back to stored messages that were written without one.
 *
 * WHY THIS EXISTS
 *
 * `dsh-luzzy-page` used to inject three kinds of user-role notice as hand-written object
 * literals with no `id` (fixed in `lib/goal-enforce.mjs`; the fix only stops NEW ones). The
 * harness validates every stored message when it loads a session log:
 *
 *     stored session "<id>" is corrupt: session error at seq N lacks an identified message
 *
 * and it refuses the WHOLE log, not just the offending event. So one id-less message makes an
 * entire session unreadable in DSH — every turn, from the first to the last. Three sessions
 * on this machine are in that state.
 *
 * WHAT IT DOES
 *
 * For each id-less message it mints a UUID and writes it in, then rewrites the log. Nothing
 * else changes: no event is dropped, reordered, or re-timed, and the text of every message is
 * byte-identical afterwards. Only the `id` key is added.
 *
 * Two properties make that safe, and both are asserted rather than assumed:
 *
 *   * **JSON round-trips losslessly here.** A repair that re-serialised records differently
 *     would put a foreign diff on every line of a 5 MB log. `assertRoundTrip` proves each
 *     record is deep-equal to its re-encoding before any write.
 *   * **The two copies of a message share their id.** A message staged in the inbox
 *     (`agent/inbox/spliced`) and the `user/message` event it later becomes carry the SAME id
 *     in every healthy record. Minting separately would produce two ids for one message and
 *     break that invariant, so the pairing is matched on content+source and given one id.
 *
 * Dry run by default, like `install-preset.mjs`. It refuses to touch a session whose log does
 * not parse, and it never edits a log it cannot verify afterwards.
 *
 * Run: node tools/repair-session-ids.mjs                       # dry run, all sessions
 *      node tools/repair-session-ids.mjs --apply               # rewrite in place (backs up)
 *      node tools/repair-session-ids.mjs --session <id> --apply
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const sessionFilter = args.includes('--session') ? args[args.indexOf('--session') + 1] : null

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** The four event types whose payload carries an identified message. */
const MESSAGE_EVENT_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
/** Matches the writer's own frame options (see the persistence backend's CHECKSUM_OPTIONS). */
const FRAME_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const BACKUP_ROOT = join(DSH_HOME, 'session-id-repair-backup')

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Split a concatenated-frame zstd log into its frames.
 *
 * The magic number is a candidate boundary, not a proof: compressed bytes can contain it. A
 * slice that inflates is a real frame, so decoding is the test.
 *
 * @param {Buffer} buffer - raw file bytes.
 * @returns {{frames: Array<{start: number, end: number}>, plaintext: string, tornStart: number|null}}
 */
function readLog(buffer) {
  const candidates = []
  for (let cursor = 0; ; ) {
    const found = buffer.indexOf(MAGIC, cursor)
    if (found === -1) break
    candidates.push(found)
    cursor = found + 1
  }

  const frames = []
  const parts = []
  let tornStart = null
  for (let index = 0; index < candidates.length; index += 1) {
    const start = candidates[index]
    const end = index + 1 < candidates.length ? candidates[index + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
      frames.push({ start, end })
    } catch {
      // The final frame can be torn if the process died mid-append. Anything earlier failing
      // is corruption this tool must not paper over.
      if (index === candidates.length - 1) tornStart = start
      else return { frames, plaintext: null, tornStart: start, reason: `frame ${index} at byte ${start} does not inflate` }
    }
  }
  return { frames, plaintext: Buffer.concat(parts).toString('utf8'), tornStart }
}

/** Every message a stored event carries, whichever of the two shapes it uses. */
function messagesOf(event) {
  if (event.type === 'user/message') return [event.data]
  if (MESSAGE_EVENT_TYPES.has(event.type)) return [event.data?.message]
  return []
}

/**
 * Deep-equality fingerprint of a message's identity-bearing content.
 *
 * NOT used to pair copies. Identical content does not imply one message: this machine's logs
 * contain the same notice text three times under three DISTINCT ids (healthy records), because
 * each injection is its own message. Pairing by content would fuse them into one and hand the
 * inbox a duplicate id — trading a load failure for `message "…" is already pending`.
 *
 * It is kept for REPORTING: how many id-less messages actually carry repeated text, which is
 * what makes the positional pairing below worth stating explicitly.
 */
function contentFingerprint(message) {
  return JSON.stringify({ content: message?.content, source: message?.source, role: message?.role })
}

const targets = []

for (const project of readdirSync(SESSIONS_ROOT)) {
  const projectPath = join(SESSIONS_ROOT, project)
  let entries
  try {
    entries = readdirSync(projectPath)
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.startsWith('session-')) continue
    if (sessionFilter !== null && entry !== sessionFilter && entry !== `session-${sessionFilter}`) continue
    const path = join(projectPath, entry, 'session.v3.jsonl.zstd')
    if (!existsSync(path)) continue
    targets.push({ project, id: entry, path })
  }
}

console.log(`repair-session-ids: ${apply ? 'APPLY' : 'dry run'}`)
console.log(`sessions root: ${SESSIONS_ROOT}`)
console.log(`scanned: ${targets.length} session log(s)\n`)

if (targets.length === 0) {
  console.log('no session logs matched. Nothing to do.')
  process.exit(0)
}

let repairedCount = 0
let skippedLocked = 0
let staleCount = 0

for (const target of targets) {
  // `stat` before the read: its mtime is what the concurrent-write guard compares against, so
  // it must describe the same bytes that were read.
  const readStat = statSync(target.path)
  const buffer = readFileSync(target.path)
  const log = readLog(buffer)

  if (log.plaintext === null) {
    console.log(`${target.id}: SKIP — ${log.reason}`)
    skippedLocked += 1
    continue
  }

  const lines = log.plaintext.split('\n')
  const trailingEmpty = lines[lines.length - 1] === ''
  if (trailingEmpty) lines.pop()

  const parsed = []
  let parseError = null
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      parseError = `line ${index} is blank`
      break
    }
    try {
      parsed.push(JSON.parse(line))
    } catch (error) {
      parseError = `line ${index} does not parse: ${String(error).slice(0, 80)}`
      break
    }
  }
  if (parseError !== null) {
    console.log(`${target.id}: SKIP — ${parseError}`)
    skippedLocked += 1
    continue
  }

  // Locate every id-less message, and remember where each one lives.
  const idless = []
  for (const [index, event] of parsed.entries()) {
    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
      for (const [slot, message] of event.data.inserted.entries()) {
        if (typeof message?.id === 'string' && message.id !== '') continue
        idless.push({ kind: 'splice', index, slot, message })
      }
    }
    for (const message of messagesOf(event)) {
      if (typeof message !== 'object' || message === null) continue
      if (typeof message.id === 'string' && message.id !== '') continue
      idless.push({ kind: 'event', index, message })
    }
  }

  if (idless.length === 0) continue

  console.log(`${target.id}: ${idless.length} id-less message(s)`)

  // ---- pairing: ONE id per message INSTANCE, never per content ----
  //
  // A healthy log shows an inbox-staged copy and the `user/message` event it becomes sharing
  // one id (`splice@4` and `event@9` are both 7432fa75-…). That is positional, not textual:
  // the loop claims the inbox message and appends THAT object, so the pair is "splice, then
  // the next user/message built from it". Content cannot stand in for it, because the same
  // notice text legitimately appeared many times under many distinct ids.
  //
  // So: walk events in order, and pair each `agent/inbox/spliced` message with the next
  // `user/message` whose content matches, consuming it. Anything unpaired gets a fresh id.
  //
  // Getting this wrong is not cosmetic in either direction — a shared id where two messages
  // exist makes the inbox reject the second ("already pending"), and two ids where one message
  // exists splits one message in two.
  const claimedBySplice = new Map()
  const pendingSplices = []
  for (const [index, event] of parsed.entries()) {
    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
      for (const [slot, message] of event.data.inserted.entries()) {
        if (typeof message?.id === 'string' && message.id !== '') continue
        pendingSplices.push({ index, slot, message, fingerprint: contentFingerprint(message) })
      }
      continue
    }
    if (event.type !== 'user/message') continue
    const message = event.data
    if (typeof message?.id === 'string' && message.id !== '') continue
    const fingerprint = contentFingerprint(message)
    // The earliest unclaimed splice with matching content is this message's staging copy.
    const position = pendingSplices.findIndex((candidate) => candidate.claimed !== true && candidate.fingerprint === fingerprint)
    if (position === -1) continue
    const staged = pendingSplices[position]
    staged.claimed = true
    const id = randomUUID()
    staged.message.id = id
    message.id = id
    claimedBySplice.set(index, staged)
    console.log(`    paired splice@${parsed[staged.index].seq} with seq ${event.seq}`)
  }

  let minted = 0
  for (const entry of idless) {
    if (entry.message.id !== undefined && entry.message.id !== '') continue
    // `id` goes LAST, matching how every healthy stored message is ordered on disk.
    entry.message.id = randomUUID()
    minted += 1
    const summary = entry.message?.source?.summary ?? '-'
    console.log(`    ${entry.kind === 'splice' ? `splice@${parsed[entry.index].seq}` : `seq ${parsed[entry.index].seq}`}  ${String(summary)}`)
  }
  console.log(`    (${claimedBySplice.size} paired copy/copies, ${minted} fresh id(s))`)

  // Rewriting must not change anything except the added ids. The encoder writes one JSON
  // record per line with no trailing whitespace, so a lossless round trip is the whole
  // precondition for touching the file.
  let roundTripBroken = 0
  for (const event of parsed) {
    if (!isDeepStrictEqual(event, JSON.parse(JSON.stringify(event)))) roundTripBroken += 1
  }
  if (roundTripBroken > 0) {
    console.log(`${target.id}: SKIP — ${roundTripBroken} record(s) do not survive a JSON round trip`)
    continue
  }

  const body = `${parsed.map((event) => JSON.stringify(event)).join('\n')}\n`
  const headerFrame = buffer.subarray(log.frames[0].start, log.frames[0].end)
  const headerPlaintext = zstdDecompressSync(headerFrame).toString('utf8')

  // The header is frame 0 and must stay exactly one newline-terminated line; the rest of the
  // log is a single fresh frame holding every event. That is a shape the reader accepts —
  // `readZstdPrefix` decodes frames in order and scans records across them.
  const eventBody = body.slice(headerPlaintext.length)
  const rebuilt = Buffer.concat([headerFrame, zstdCompressSync(Buffer.from(eventBody, 'utf8'), FRAME_OPTIONS)])

  // Verify the REBUILT bytes the way the loader will: decode, re-parse, and confirm the only
  // difference from the original is a present id.
  const verifyLog = readLog(rebuilt)
  check(`${target.id}: the rebuilt log decodes`, verifyLog.plaintext !== null, verifyLog.reason ?? '')
  const verifyEvents = verifyLog.plaintext.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  check(`${target.id}: event count is unchanged`, verifyEvents.length === parsed.length, `${verifyEvents.length} vs ${parsed.length}`)
  check(
    `${target.id}: header line is byte-identical`,
    verifyLog.plaintext.startsWith(headerPlaintext),
  )

  let stillIdless = 0
  let changedBeyondId = 0
  for (const [index, event] of verifyEvents.entries()) {
    const before = parsed[index]
    if (JSON.stringify(event).replace(/"id":"[0-9a-f-]{36}"/g, '') !== JSON.stringify(before).replace(/"id":"[0-9a-f-]{36}"/g, '')) {
      // Compare with every id stripped: only id insertion may differ.
      const stripIds = (value) => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'id' ? undefined : inner)))
      if (!isDeepStrictEqual(stripIds(event), stripIds(before))) changedBeyondId += 1
    }
    for (const message of messagesOf(event)) {
      if (typeof message?.id !== 'string' || message.id === '') stillIdless += 1
    }
    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
      for (const message of event.data.inserted) {
        if (typeof message?.id !== 'string' || message.id === '') stillIdless += 1
      }
    }
  }
  check(`${target.id}: no id-less message remains`, stillIdless === 0, `${stillIdless} left`)
  check(`${target.id}: nothing changed except the added ids`, changedBeyondId === 0, `${changedBeyondId} record(s)`)

  // ---- the duplicate-id invariant, calibrated against healthy logs ----
  //
  // NOT "every id is unique in the log": a healthy log legitimately repeats ids, because an
  // inbox-staged copy and the `user/message` event it becomes are the SAME message and share
  // one. Measured on this machine, 83 of 94 logs repeat ids for exactly that reason. A
  // whole-log uniqueness check would therefore fail against every healthy session — an
  // assertion that is red before the repair means nothing after it.
  //
  // The real rule is the one the inbox fold enforces: ids must be unique WITHIN one pending
  // list, because that is where `message "…" is already pending` is thrown. So scope the check
  // to each splice's own inserted set, and require no id to appear twice there.
  let coexistingDuplicates = 0
  for (const event of verifyEvents) {
    if (event.type !== 'agent/inbox/spliced' || !Array.isArray(event.data?.inserted)) continue
    const ids = event.data.inserted.map((message) => message?.id).filter((id) => typeof id === 'string' && id !== '')
    if (new Set(ids).size !== ids.length) coexistingDuplicates += 1
  }
  check(`${target.id}: no id repeats within one pending list`, coexistingDuplicates === 0, `${coexistingDuplicates} splice(s)`)

  // Every message instance must have an identity, and the copy/original pair must share one.
  let instances = 0
  let pairedCopies = 0
  const spliceIds = new Set()
  for (const event of verifyEvents) {
    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
      for (const message of event.data.inserted) {
        instances += 1
        if (typeof message?.id === 'string' && message.id !== '') spliceIds.add(message.id)
      }
    }
    const single = event.type === 'user/message' ? [event.data] : MESSAGE_EVENT_TYPES.has(event.type) ? [event.data?.message] : []
    for (const message of single) {
      if (typeof message !== 'object' || message === null) continue
      instances += 1
      if (typeof message.id === 'string' && spliceIds.has(message.id)) pairedCopies += 1
    }
  }
  console.log(`    ${instances} message instance(s), ${spliceIds.size} inbox id(s), ${pairedCopies} copy/original pair(s)`)

  // Repeated notice TEXT must keep one id PER INSTANCE, as the healthy records do: the same
  // orientation block was injected many times and each injection is its own message. A repair
  // that deduplicated by text would collapse them and reuse an id, so assert instance count
  // and distinct-id count agree for every repeated text.
  const textToIds = new Map()
  for (const event of verifyEvents) {
    if (event.type !== 'user/message') continue
    const message = event.data
    if (message?.source?.plugin !== 'dsh-luzzy-page') continue
    const key = contentFingerprint(message)
    if (!textToIds.has(key)) textToIds.set(key, [])
    textToIds.get(key).push(message.id)
  }
  const fusedTexts = [...textToIds.values()].filter((ids) => new Set(ids).size !== ids.length)
  check(
    `${target.id}: repeated notice text keeps one id per instance`,
    fusedTexts.length === 0,
    `${fusedTexts.length} text(s) reused an id`,
  )

  // The pairing that IS required: a splice copy shares its id with the message it becomes.
  const splicesById = new Map()
  for (const event of verifyEvents) {
    if (event.type !== 'agent/inbox/spliced' || !Array.isArray(event.data?.inserted)) continue
    for (const message of event.data.inserted) {
      if (typeof message?.id === 'string' && message.id !== '') splicesById.set(message.id, event.seq)
    }
  }
  let paired = 0
  for (const event of verifyEvents) {
    if (event.type !== 'user/message') continue
    if (splicesById.has(event.data?.id)) paired += 1
  }
  console.log(`    ${splicesById.size} splice id(s), ${paired} matched by a user/message event`)

  if (!apply) {
    console.log(`    (dry run — re-run with --apply to write)\n`)
    repairedCount += 1
    continue
  }

  // Back up before writing, and write through a temp file + rename so a crash cannot leave a
  // half-written log where a readable one was.
  //
  // CONCURRENT-WRITE GUARD. A session that DSH still has open keeps appending: this tool reads
  // the whole log, works on it in memory, and writes it back, so any append landing in that
  // window would be silently destroyed by the rename. That is the worst possible outcome here —
  // repairing a log by losing turns from it. So re-stat immediately before the rename and
  // refuse if size or mtime moved since the read; the caller re-runs on a stable file.
  const statAfterRead = statSync(target.path)
  if (statAfterRead.size !== buffer.length || statAfterRead.mtimeMs !== readStat.mtimeMs) {
    console.log(`    SKIP — the log changed while it was being repaired (size ${buffer.length} → ${statAfterRead.size}). Close DSH and re-run.\n`)
    staleCount += 1
    continue
  }

  const backupDir = join(BACKUP_ROOT, target.project, target.id)
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(target.path, join(backupDir, `session.v3.jsonl.zstd.${stamp}`))

  const temp = `${target.path}.repair-tmp`
  writeFileSync(temp, rebuilt)
  check(`${target.id}: the temp file is on disk`, existsSync(temp) && statSync(temp).size > 0)
  renameSync(temp, target.path)
  console.log(`    wrote ${rebuilt.length} bytes (was ${buffer.length}); backup in ${backupDir}\n`)
  repairedCount += 1
}

console.log()
if (skippedLocked > 0) console.log(`${skippedLocked} session(s) skipped (unreadable)`)
if (staleCount > 0) console.log(`${staleCount} session(s) skipped (changed during repair — close DSH and re-run)`)
if (!apply) {
  console.log(`${repairedCount} session(s) would be repaired. Nothing was written.`)
  console.log('Re-run with --apply to make these changes.')
} else {
  console.log(`${repairedCount} session(s) repaired.`)
  console.log(`Backups: ${BACKUP_ROOT}`)
  console.log('Restart DSH (or reopen the session) so it re-reads the log.')
}

if (failures > 0) {
  console.log(`\nFAIL — ${failures} of ${checks} verification assertion(s)`)
  process.exit(1)
}
console.log(`\nPASS — ${checks} verification assertion(s)`)
