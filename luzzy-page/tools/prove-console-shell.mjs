// The console shell's negative control.
//
// Usage: node tools/prove-console-shell.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// The four requests of this round are all "structure" changes — delete a page, move the nav,
// fold two pages into a third, put a material layer under everything. None of them is visible to
// a unit test that only checks a function returns a string. The failure mode for each one is
// silent:
//
//   * delete the overview but leave the default tab on 'overview' → sessions land on a page that
//     falls back to another one, and the user thinks they are still where they were;
//   * move the nav but keep rendering both nav shapes → the page shows a second, dead control;
//   * fold two pages in by COPYING their renderers → two copies drift, and the copy is the one
//     that goes stale;
//   * add glass without the reduced-transparency branch → the material is unreadable for exactly
//     the people who asked the OS to turn it off.
//
// So each arm below puts ONE defect back into a temp copy and asserts that the suite goes RED and
// NAMES it. An arm that cannot fail is not a test.
//
// It replaces prove-overview-render.mjs, whose subject (the overview page) no longer exists.
// Arms A/B/C of that file guarded two defects that became structurally impossible: the duplicate
// health badge lived in the deleted page, and "the objective collapsed into one blob" cannot
// happen while no page puts the raw objective into a card. `test-client-load.mjs` now carries
// both of those as positive assertions.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

let failures = 0
let checks = 0
function check(label, ok, detail = '') {
  checks += 1
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/**
 * Rebuild the sandbox's bundle, then run the shell suite in it.
 *
 * THE REBUILD IS NOT OPTIONAL, and getting this wrong is why the first version of this file
 * reported 8 false failures. `test-client-load.mjs` reads the BUILT bundle (`lib/client.js`),
 * because that is what actually ships — but every arm below mutates `src/`. Without a rebuild
 * the suite ran against the unmodified artifact and passed, so each arm looked like "the
 * assertion cannot fail" when the truth was "the mutation never reached the thing being read".
 *
 * That is the §5.26 trap in a new costume: `lib/client.js` is a build artifact, and a test that
 * reads it is testing the LAST build, not the source in front of it. ~6 s per arm, five arms.
 */
function runSuite(sandbox, { rebuild = true } = {}) {
  try {
    if (rebuild) {
      execFileSync('python', [join(sandbox, 'tools', 'build-font-css.py')], { encoding: 'utf8', stdio: 'pipe' })
    }
    execFileSync(process.execPath, [join(sandbox, 'tools', 'test-client-load.mjs')], { encoding: 'utf8', env: { ...process.env } })
    return { exitedNonZero: false, lines: [], raw: '' }
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { exitedNonZero: true, lines: output.split('\n').filter((l) => l.includes('FAIL')), raw: output }
  }
}

/** Fresh copy of the plugin, so a mutation cannot leak into the next arm or the real tree. */
function sandboxFor(name) {
  const sandbox = mkdtempSync(join(tmpdir(), `luzzy-${name}-`))
  cpSync(PLUGIN_ROOT, sandbox, { recursive: true })
  return sandbox
}

const sandboxes = []
try {
  // ---- arm A: the default page points at the page that no longer exists ----------
  {
    const sandbox = sandboxFor('default-tab')
    sandboxes.push(sandbox)
    const file = join(sandbox, 'src', 'app', 'router.js')
    const source = readFileSync(file, 'utf8')
    const mutated = source.replace("const DEFAULT_TAB = 'goal'", "const DEFAULT_TAB = 'overview'")
    check('A: the mutation applied', mutated !== source, 'matched nothing')
    writeFileSync(file, mutated)

    const result = runSuite(sandbox)
    check('A: the suite goes red when the default page is the deleted one', result.exitedNonZero,
      'it passed while pointing the default at a page that is gone')
    check('A: and names it', result.lines.some((l) => /default page is the goal centre/.test(l)), result.lines.join(' | '))
    for (const line of result.lines.slice(0, 2)) console.log(`       ${line.trim()}`)
  }

  // ---- arm B: the overview page comes back ---------------------------------------
  {
    const sandbox = sandboxFor('overview-back')
    sandboxes.push(sandbox)
    const file = join(sandbox, 'src', 'app', 'router.js')
    const source = readFileSync(file, 'utf8')
    // Put the entry back. The renderer is NOT restored — that is the point: the assertion must
    // catch "the page is reachable again", not merely "the module exists".
    const mutated = source.replace(
      "    { id: 'goal', label: '目标中心'",
      "    { id: 'overview', label: '总览', render: function (view) { return LZ.OverviewPage.render(view) } },\n    { id: 'goal', label: '目标中心'",
    )
    check('B: the mutation applied', mutated !== source, 'matched nothing')
    writeFileSync(file, mutated)

    const result = runSuite(sandbox)
    check('B: the suite goes red when the deleted page is reachable again', result.exitedNonZero,
      'it passed with a second entry to the same facts')
    check('B: and names the nav set', result.lines.some((l) => /nav offers exactly the known pages/.test(l)), result.lines.join(' | '))
    for (const line of result.lines.slice(0, 2)) console.log(`       ${line.trim()}`)
  }

  // ---- arm C: the two absorbed pages get COPIED instead of called ----------------
  //
  // This is the arm that matters most, because copying is the tempting move: it makes the fold
  // look finished while creating a second copy that will drift. The assertion is that the goal
  // page CALLS the other two renderers by name.
  //
  // The mutation is a bare RENAME of the member being called (`render` → `renderCopy`), not a
  // rewrite of the call. My first version spliced in a substitute body with a non-greedy regex
  // and it cut mid-expression — the sandbox then failed to BUILD, so the suite exited non-zero
  // with zero FAIL lines. The arm read as "the assertion cannot fail" when the truth was "the
  // mutation never compiled". A rename cannot do that: it is valid JavaScript by construction,
  // and it is exactly the shape a copy-paste rewrite leaves behind (a private copy, no call).
  {
    const sandbox = sandboxFor('copied-renderers')
    sandboxes.push(sandbox)
    const file = join(sandbox, 'src', 'pages', 'goal.js')
    const source = readFileSync(file, 'utf8')
    const mutated = source
      .replace(/LZ\.RuntimePage\.render\(/g, 'LZ.RuntimePage.renderCopy(')
      .replace(/LZ\.AgentPage\.render\(/g, 'LZ.AgentPage.renderCopy(')
    check('C: the mutation applied', mutated !== source && !mutated.includes('LZ.RuntimePage.render('), 'matched nothing')
    writeFileSync(file, mutated)

    const result = runSuite(sandbox)
    check('C: the suite goes red when the fold copies instead of calling', result.exitedNonZero,
      'it passed with the two pages no longer delegating')
    check('C: and it is an assertion failure, not a build crash',
      result.lines.length > 0,
      `no FAIL lines at all — the sandbox most likely failed to build. raw: ${result.raw.slice(-500)}`)
    for (const line of result.lines.slice(0, 3)) console.log(`       ${line.trim()}`)
  }

  // ---- arm D: glass with no reduced-transparency branch --------------------------
  //
  // `backdrop-filter` on a translucent surface is the one material that is actively hostile to
  // a user who asked the OS for less transparency. Renaming the media query's VALUE to
  // `no-preference` is the realistic slip: it still reads as "we handle reduced transparency",
  // and a substring check would happily pass it.
  {
    const sandbox = sandboxFor('glass-a11y')
    sandboxes.push(sandbox)
    const file = join(sandbox, 'src', 'styles', 'components.css')
    const source = readFileSync(file, 'utf8')
    const mutated = source.replace(
      '@media (prefers-reduced-transparency: reduce) {',
      '@media (prefers-reduced-transparency: no-preference) {',
    )
    check('D: the mutation applied', mutated !== source, 'matched nothing')
    writeFileSync(file, mutated)

    const result = runSuite(sandbox)
    check('D: the suite goes red without the reduced-transparency branch', result.exitedNonZero,
      'it passed with the material unreadable under reduce-transparency')
    check('D: and names it', result.lines.some((l) => /reduced-transparency/.test(l)), result.lines.join(' | '))
    for (const line of result.lines.slice(0, 3)) console.log(`       ${line.trim()}`)
  }

  // ---- arm E: glass that stacks on glass ----------------------------------------
  //
  // "Never stack a light translucent surface on another — legibility collapses." The callouts sit
  // INSIDE cards, so if one of them grows its own backdrop-filter the text sits under two blur
  // layers. Cheap to do by accident, invisible in review.
  {
    const sandbox = sandboxFor('stacked-glass')
    sandboxes.push(sandbox)
    const file = join(sandbox, 'src', 'styles', 'components.css')
    const source = readFileSync(file, 'utf8')
    const mutated = source.replace(
      '.callout {\n  padding: var(--lz-space-sm);',
      '.callout {\n  backdrop-filter: blur(var(--lz-glass-blur));\n  padding: var(--lz-space-sm);',
    )
    check('E: the mutation applied', mutated !== source, 'matched nothing')
    writeFileSync(file, mutated)

    const result = runSuite(sandbox)
    check('E: the suite goes red when a nested surface adds its own blur', result.exitedNonZero,
      'it passed with two translucent layers stacked')
    check('E: and names it', result.lines.some((l) => /stack|nested|blur/i.test(l)), result.lines.join(' | '))
    for (const line of result.lines.slice(0, 2)) console.log(`       ${line.trim()}`)
  }
} finally {
  for (const sandbox of sandboxes) {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // best effort — a leftover temp dir is not worth failing the run over
    }
  }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (every shell defect goes red when reintroduced)`)
