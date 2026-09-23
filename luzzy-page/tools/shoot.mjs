// Shared headless-Edge screenshot step.
//
// Extracted because it has non-obvious requirements that must not drift between callers:
//
//   1. `execFileSync`, never a fire-and-forget spawn. Edge is a GUI executable, so launching
//      it from a shell returns immediately and the PNG is still being written when the next
//      command reads it — that produced a hash for a file that then changed.
//   2. One profile per output file. A shared `--user-data-dir` makes back-to-back runs fail
//      on the profile lock while the previous Edge is still shutting down.
//   3. One retry. Edge exits non-zero when it hands a launch off to an instance that is still
//      exiting, so a screenshot can vanish from a batch while all output still looks fine.
//      The retry absorbs the transient case; comparing hashes across a batch catches the rest.
//
// Usage: shoot({ page: '/abs/path.html', out: '/abs/path.png', height: 1300 })

import { execFileSync } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

export function shoot({ page, out, height = 1300, width = 1200, virtualTimeMs = 6000 }) {
  const profile = join(tmpdir(), `luzzy-shot-profile-${basename(out, extname(out))}`)
  const run = () => execFileSync(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      `--virtual-time-budget=${virtualTimeMs}`,
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      `file:///${page.replace(/\\/g, '/')}`,
    ],
    { timeout: 90_000, stdio: ['ignore', 'ignore', 'ignore'] },
  )

  try {
    run()
    return true
  } catch {
    try {
      run()
      return true
    } catch (error) {
      console.error(`shot FAILED after retry: ${error.message}`)
      return false
    }
  }
}
