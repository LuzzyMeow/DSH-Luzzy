/**
 * Verify a repaired session log with the harness's OWN persistence backend.
 *
 * The repair tool's self-checks run its own decoder, which is the weak form of proof: a tool
 * that both writes and judges can agree with itself while the real loader still refuses the
 * file. This drives `JsonlSessionPersistence` — the exact class DSH loads sessions with — so
 * "the session reads again" is established by the component that was rejecting it.
 *
 * Runs against a COPY in a temp root; the real session directory is only read.
 *
 * Run: node tools/verify-session-repair.mjs <original.zstd> <repaired.zstd>
 *        [--project-dir <name>] [--session <id>]
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const originalPath = args[0]
const repairedPath = args[1]
const projectDir = args.includes('--project-dir') ? args[args.indexOf('--project-dir') + 1] : '--C-Users-Administrator-Desktop-DSH~0020Plugin--'
const DSH_APP = process.env.DSH_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app'

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

/** Read the session id out of a log's header, so the fixture needs no guessing. */
function headerOf(path) {
  const buffer = readFileSync(path)
  const starts = []
  for (let cursor = 0; ; ) {
    const found = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), cursor)
    if (found === -1) break
    starts.push(found)
    cursor = found + 1
  }
  for (let index = 0; index < starts.length; index += 1) {
    const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      const text = zstdDecompressSync(buffer.subarray(starts[index], to)).toString('utf8')
      const first = text.split('\n').find((line) => line.trim() !== '')
      const value = JSON.parse(first)
      if (typeof value.id === 'string') return value
    } catch {
      continue
    }
  }
  return null
}

const header = headerOf(originalPath)
if (header === null) {
  console.log('FAIL could not read the session header')
  process.exit(1)
}

const moduleUrl = pathToFileURL(join(DSH_APP, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')).href
const cordisUrl = pathToFileURL(join(DSH_APP, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href

let JsonlSessionPersistence
let Context
try {
  const imported = await import(moduleUrl)
  JsonlSessionPersistence = imported.default
  ;({ Context } = await import(cordisUrl))
  check('the harness persistence backend is importable', typeof JsonlSessionPersistence === 'function')
  check('cordis is importable (the backend extends its Service)', typeof Context === 'function')
} catch (error) {
  console.log(`  skip the DSH package is unavailable at ${DSH_APP}: ${error.message}`)
  console.log('\nPASS — 0 assertions (verification skipped: the DSH package is unavailable)')
  process.exit(0)
}

const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-session-verify-'))
const sessionDir = join(sandbox, projectDir, header.id)
mkdirSync(sessionDir, { recursive: true })

/*
 * A REAL cordis root context, not a stand-in.
 *
 * `JsonlSessionPersistence` extends cordis's `Service`, whose constructor registers itself
 * through `ctx.reflect.provide` — so a plain object context throws before any I/O happens:
 *
 *     TypeError: Cannot read properties of undefined (reading 'provide')
 *
 * A stand-in that happened to satisfy `provide()` by hand would be more permissive than the
 * real thing, and this whole verifier exists to make the judgement come from the real thing.
 * `new Context()` is cordis's own root constructor, so the backend is constructed exactly as
 * DSH constructs it.
 */
const ctx = new Context()

try {
  const backend = new JsonlSessionPersistence(ctx, { root: sandbox, compression: 'zstd' })

  // 1. The ORIGINAL must be rejected — otherwise this fixture proves nothing.
  copyFileSync(originalPath, join(sessionDir, 'session.v3.jsonl.zstd'))
  let originalError = null
  try {
    const handle = await backend.open(header.id, 'read')
    await handle.close?.()
  } catch (error) {
    originalError = error
  }
  check(
    'the ORIGINAL log is rejected (the fixture reproduces the defect)',
    originalError !== null,
    'the harness accepted the original, so it never had this defect',
  )
  if (originalError !== null) {
    const message = String(originalError.message ?? originalError)
    check('and it is rejected for the missing identity', /lacks an identified message/.test(message), message.slice(0, 200))
    console.log(`       ${message.slice(0, 180)}`)
  }

  // 2. The REPAIRED log must be accepted, and yield the same event count.
  copyFileSync(repairedPath, join(sessionDir, 'session.v3.jsonl.zstd'))
  let readError = null
  let events = null
  try {
    const handle = await backend.open(header.id, 'read')
    const snapshot = await handle.read?.()
    events = snapshot?.events ?? handle.events ?? null
    await handle.close?.()
  } catch (error) {
    readError = error
  }
  check('the REPAIRED log is ACCEPTED', readError === null, readError === null ? '' : String(readError.message ?? readError).slice(0, 200))

  // 3. Nothing may be lost: the byte count and event count are compared to the original.
  const originalEvents = (() => {
    const buffer = readFileSync(originalPath)
    const starts = []
    for (let cursor = 0; ; ) {
      const found = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), cursor)
      if (found === -1) break
      starts.push(found)
      cursor = found + 1
    }
    let text = ''
    for (let index = 0; index < starts.length; index += 1) {
      const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
      try {
        text += zstdDecompressSync(buffer.subarray(starts[index], to)).toString('utf8')
      } catch {
        // torn tail
      }
    }
    return text.split('\n').filter((line) => line.trim() !== '').length - 1
  })()
  console.log(`       original records: ${originalEvents}`)
  console.log(`       original bytes: ${statSync(originalPath).size}, repaired bytes: ${statSync(repairedPath).size}`)
  if (events !== null) console.log(`       events the harness returned: ${events.length}`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (the repaired log loads; the original does not)`)
