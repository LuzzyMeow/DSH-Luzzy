// Prove the concurrent-write guard fires.
//
// The guard exists so a repair can never silently destroy turns that a still-open session
// appended during the read → write window. It is timing-dependent, so this test manufactures
// the race: while the repair tool works on a big log, a background writer keeps appending
// valid zstd frames to it. If the guard works, the tool refuses and says so.
//
// A guard that never fires is indistinguishable from no guard, which is why this is worth the
// trouble of building the race rather than reasoning about it.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, constants } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = join(HERE, 'repair-session-ids.mjs')
const PROJECT = '--C-Users-Administrator-Desktop-DSH~0020Plugin--'
const SESSION = 'session-3c5ab27f-7664-4b53-b34d-60b60811ec06'
const SOURCE = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions', PROJECT, SESSION, 'session.v3.jsonl.zstd')

const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-guard-race-'))
const dir = join(sandbox, 'sessions', PROJECT, SESSION)
mkdirSync(dir, { recursive: true })
const target = join(dir, 'session.v3.jsonl.zstd')
copyFileSync(SOURCE, target)
const originalSize = readFileSync(target).length

// A valid, independently decodable frame carrying one benign event — the same shape DSH
// appends, so the guard is racing a realistic writer rather than corrupting the file.
const appendedFrame = zstdCompressSync(
  Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 999999, time: Date.now(), data: { turn: 1 } })}\n`, 'utf8'),
  { params: { [constants.ZSTD_c_checksumFlag]: 1 } },
)

let appended = 0
const appender = setInterval(() => {
  try {
    writeFileSync(target, appendedFrame, { flag: 'a' })
    appended += 1
  } catch {
    // the repair's rename may swap the file out from under us; that is the race, not a fault
  }
}, 1)

/*
 * `spawn`, NOT `execFileSync`.
 *
 * The first version of this test used `execFileSync`, which blocks the event loop — so the
 * appender above never ran once and the test reported "0 frames appended, inconclusive".
 * A synchronous child makes the race impossible to stage, which is precisely the race the
 * guard exists for.
 */
const child = spawn(process.execPath, [TOOL, '--apply'], {
  env: { ...process.env, DSH_HOME: sandbox },
})

let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

await new Promise((resolve) => {
  child.on('close', resolve)
})
clearInterval(appender)

const refused = /changed while it was being repaired|Close DSH and re-run/.test(output)
const wrote = /wrote \d+ bytes/.test(output)

console.log(`appended ${appended} frame(s) during the run`)
console.log(`repair wrote the file: ${wrote}`)
console.log(`the guard refused:     ${refused}`)
for (const line of output.split('\n').filter((l) => /SKIP|changed while|repaired/.test(l))) console.log(`   ${line.trim()}`)

// Two acceptable outcomes: the guard fired (append landed in the window), or no append landed
// in the window and the repair legitimately completed. What is NOT acceptable is writing while
// appends were landing — i.e. `wrote` being true with a large append count and no refusal.
const guardFired = refused
const raceMissed = appended === 0

rmSync(sandbox, { recursive: true, force: true })

if (guardFired) {
  console.log('\nPASS — the guard refused to overwrite a log that changed mid-repair')
  process.exit(0)
}
if (raceMissed) {
  console.log('\nINCONCLUSIVE — no append landed in the window; widen the log or re-run')
  process.exit(2)
}
console.log(`\nFAIL — ${appended} append(s) landed yet the repair still wrote (no guard)`)
process.exit(1)
