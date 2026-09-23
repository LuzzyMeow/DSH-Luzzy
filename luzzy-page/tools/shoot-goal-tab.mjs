/**
 * Screenshot the 「目标」 sub-page in both themes and at a real narrow width.
 *
 * WHY THIS DRIVES THE BROWSER INSTEAD OF USING --screenshot
 *
 * `--window-size` cannot produce a narrow viewport on this machine: Windows enforces a
 * minimum window width, so asking for 420px yields a page laid out at 492px and a PNG
 * CROPPED to 420px. The result looks exactly like content running off the right edge when
 * nothing overflows at all. Measured directly:
 *
 *     --window-size=420,900  =>  innerWidth 492, outerWidth 516
 *
 * That false signal cost a round of "the narrow layout is broken".
 * Emulation.setDeviceMetricsOverride through CDP sets the layout viewport for real, so the
 * image matches what a narrow window would actually show. The browser is launched once and
 * reused for every variant, which also avoids the per-launch flakiness noted in shoot.mjs.
 *
 * SHA-256 IS PART OF THE ACCEPTANCE. Two renders that SHOULD differ and come out identical
 * mean the variant never took effect — this project has been bitten by that twice. So the
 * hashes are printed and compared, not just the images written.
 *
 * Usage: node tools/shoot-goal-tab.mjs [--out-dir docs/shots]
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { attach, launchEdge, shutdown } from './cdp-driver.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const outDir = argValue('--out-dir', join(PLUGIN_ROOT, 'docs', 'shots'))
mkdirSync(outDir, { recursive: true })

const variants = [
  { name: 'goal-tab-light', dark: false, width: 1280, height: 2400 },
  { name: 'goal-tab-dark', dark: true, width: 1280, height: 2400 },
  // 420 is the width the design asks about. It is a REAL 420 here.
  { name: 'goal-tab-narrow-light', dark: false, width: 420, height: 3200 },
]

/** Build the page with the project's own renderer: a copy here would prove nothing. */
function buildPage(name, dark) {
  const page = join(tmpdir(), `luzzy-${name}.html`)
  execFileSync(process.execPath, [
    join(PLUGIN_ROOT, 'tools', 'render-frame-with-data.mjs'),
    '--tab', 'goal',
    ...(dark ? ['--dark'] : []),
    '--out', page,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  return page
}

const launched = await launchEdge({ headless: true, windowSize: { width: 1280, height: 1000 } })
let session = null
const results = []
let bad = 0

try {
  session = await attach({ port: launched.port })

  for (const variant of variants) {
    const page = buildPage(variant.name, variant.dark)
    const target = await session.openTarget(`file:///${page.replace(/\\/g, '/')}`)
    await target.enable()

    // The layout viewport, for real — see the header.
    await target.send('Emulation.setDeviceMetricsOverride', {
      width: variant.width,
      height: variant.height,
      deviceScaleFactor: 1,
      mobile: false,
    })

    if (!await target.waitFor('#goalRefresh', { timeoutMs: 20_000 })) {
      console.error(`  FAIL ${variant.name}: the goal page never rendered`)
      bad += 1
      continue
    }
    // Let the last paint land before capturing.
    await target.evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)))')

    const measured = await target.evaluate('({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })')
    const png = await target.screenshot()
    const shot = join(outDir, `${variant.name}.png`)
    writeFileSync(shot, png)

    const sha = createHash('sha256').update(png).digest('hex')
    results.push({ ...variant, shot, bytes: png.length, sha, measured })
    console.log(`${variant.name.padEnd(24)} viewport=${measured.innerWidth} scrollWidth=${measured.scrollWidth}  ${(png.length / 1024).toFixed(0)} KB  ${sha.slice(0, 16)}`)
    if (measured.innerWidth !== variant.width) {
      console.log(`  FAIL the viewport is not the requested width (${measured.innerWidth} != ${variant.width})`)
      bad += 1
    }
    if (measured.scrollWidth > measured.innerWidth + 1) {
      console.log(`  FAIL the page scrolls horizontally (${measured.scrollWidth} > ${measured.innerWidth})`)
      bad += 1
    }
  }
} catch (error) {
  console.error(`shoot failed: ${error.message}`)
  bad += 1
} finally {
  await shutdown({ child: launched.child, profile: launched.profile, session })
}

// The two themes must differ. Identical bytes would mean the dark token block never applied,
// and the frame would look light in dark mode with nothing reporting a problem.
const light = results.find((r) => r.name === 'goal-tab-light')
const dark = results.find((r) => r.name === 'goal-tab-dark')
const narrow = results.find((r) => r.name === 'goal-tab-narrow-light')

const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    bad += 1
    console.log(`  FAIL ${label} — ${detail}`)
  }
}

console.log()
check('the light and dark renders differ', light !== undefined && dark !== undefined && light.sha !== dark.sha,
  light && dark ? `both ${light.sha.slice(0, 16)}` : 'a render is missing')
check('the narrow render differs from the wide one', light !== undefined && narrow !== undefined && light.sha !== narrow.sha,
  'identical bytes mean the width never took effect')
check('every variant produced a real image', results.length === variants.length && results.every((r) => r.bytes > 20_000),
  results.map((r) => `${r.name}=${r.bytes}`).join(' '))

if (bad > 0) {
  console.log(`\nFAIL — ${bad} problem(s)`)
  process.exit(1)
}
console.log(`\nPASS — ${results.length} renders, all distinct (goal tab visual acceptance)`)
