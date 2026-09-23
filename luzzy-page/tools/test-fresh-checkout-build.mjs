/**
 * Does a FRESH CHECKOUT build from source?
 *
 * This is the check that was missing. The working tree built fine for a long time while a
 * clone could not, because 21 of the 28 `src/` modules — plus the build script that assembles
 * them — were never committed. Everything looked healthy from the inside.
 *
 * So this does not ask "does the build pass here". It asks the question a stranger would ask:
 * check out HEAD into a scratch directory that contains nothing but what git tracks, and build
 * THERE. Anything the worktree needs but git does not have shows up immediately.
 *
 * Why not `git archive | tar -x`: on this machine that extracted 0 files (see the note in
 * AGENTS.md). `git worktree add --detach` is the mechanism that actually works here.
 *
 * Usage: node tools/test-fresh-checkout-build.mjs [--keep]
 *
 * Exit 0 only if the fresh checkout contains every declared module AND the build succeeds AND
 * the rebuilt bundle matches the committed one except for the embedded font blob (the subsetter
 * is not byte-deterministic — tools/probe-build-drift.mjs documents that separately).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const REPO_ROOT = join(PLUGIN_ROOT, '..')
const KEEP = process.argv.includes('--keep')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'lz-fresh-build-'))
const tree = join(scratch, 'tree')

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', ...options })
}

try {
  git(['worktree', 'add', '--detach', tree, 'HEAD'], { stdio: 'pipe' })
  check('a fresh worktree of HEAD was created', existsSync(join(tree, 'luzzy-page', 'src')))

  const plugin = join(tree, 'luzzy-page')

  // ---- 1. every module the manifest declares must be PRESENT in the checkout -------------
  const manifest = JSON.parse(readFileSync(join(plugin, 'src', 'app', 'manifest.json'), 'utf8'))
  const declared = [...manifest.styles, ...manifest.modules]
  const missing = declared.filter((rel) => !existsSync(join(plugin, 'src', rel)))
  check(`all ${declared.length} declared sources are committed`, missing.length === 0,
    missing.length === 0 ? '' : `missing: ${missing.join(', ')}`)

  // ---- 2. the build script must be the multi-file one -----------------------------------
  // The old 282-line version cannot assemble src/ at all. Checking for the manifest reader is
  // the honest test: a script that does not read the manifest cannot build this project.
  const buildScript = readFileSync(join(plugin, 'tools', 'build-font-css.py'), 'utf8')
  check('the committed build script reads the module manifest',
    buildScript.includes('manifest') && buildScript.includes('read_parts'),
    'this looks like the single-file era script')

  // ---- 3. the build must actually succeed in the checkout -------------------------------
  let buildOutput = ''
  let buildOk = false
  try {
    buildOutput = execFileSync('python', ['tools/build-font-css.py'], { cwd: plugin, encoding: 'utf8' })
    buildOk = true
  } catch (error) {
    buildOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  check('the build succeeds in a fresh checkout', buildOk, buildOutput.trim().split('\n').slice(-2).join(' | '))
  if (buildOk) {
    check('and it reports a compiled frame script', /frame script parses cleanly/.test(buildOutput))
  }

  // ---- 4. the rebuilt bundle must match the committed one, except the font blob ----------
  if (buildOk) {
    const norm = (text) => text.split('\n').map((line) => line.replace(/\r$/, ''))
    const committed = norm(git(['show', 'HEAD:luzzy-page/lib/client.js'], { maxBuffer: 64 * 1024 * 1024 }))
    const rebuilt = norm(readFileSync(join(plugin, 'lib', 'client.js'), 'utf8'))
    const differing = []
    for (let i = 0; i < Math.max(committed.length, rebuilt.length); i += 1) {
      if (committed[i] !== rebuilt[i]) differing.push(i)
    }
    const onlyFontBlob = differing.every((i) => {
      const line = (rebuilt[i] ?? '') + (committed[i] ?? '')
      return line.includes('base64') || line.includes('@font-face')
    })
    check(`the rebuild matches the committed artifact (${differing.length} line(s) differ)`,
      onlyFontBlob,
      onlyFontBlob ? '' : `unexpected drift at line(s) ${differing.slice(0, 3).map((i) => i + 1).join(', ')}`)
  }
} finally {
  if (!KEEP) {
    try { git(['worktree', 'remove', tree, '--force'], { stdio: 'pipe' }) } catch { /* best effort */ }
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  } else {
    console.log(`\n(kept: ${plugin ?? tree})`)
  }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} assertion(s)`)
  process.exit(1)
}
console.log('PASS — a fresh checkout builds from source')
