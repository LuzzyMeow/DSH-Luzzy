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
import { basename, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

export function shoot({ page, out, height = 1300, width = 1200, virtualTimeMs = 6000 }) {
  // `out` 必须先转成绝对路径。交给 Edge 的相对路径是按**它自己的**工作目录解析的，
  // 而那个目录和调用者的 cwd 不是一回事。实测结果是最坏的那种：函数返回 true、
  // 控制台打印「shot: xxx.png」、**文件根本没落盘**，而且 stdio 被吞掉所以一个字都不报。
  // 属于本文件开头第 1、2 条同一族，一次堵掉。
  const target = resolve(out)
  const profile = join(tmpdir(), `luzzy-shot-profile-${basename(target, extname(target))}`)
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
      `--screenshot=${target}`,
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
