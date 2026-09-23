// Regression test for the trend chart's smoothing (smoothPath) and its scale (niceMax).
//
// The curve is generated as SVG path data, so the thing worth asserting is not the string
// but its GEOMETRY: a smoothed line through non-negative token counts must never be drawn
// below zero. The first implementation used Catmull-Rom, which overshoots — the day window
// showed the curve dipping under the axis between two positive hours, i.e. drawing negative
// tokens. That is invisible in a totals comparison and only shows up on screen, so it needs
// a numeric check.
//
// The Bézier control points are read back out of the generated path and sampled.
//
// Usage: node tools/test-chart-path.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

// The bundle inlines the frame document as a template literal, so unescape it back to
// ordinary source before lifting the functions out.
const frameStart = bundle.indexOf('function buildFrameDocument(')
if (frameStart < 0) throw new Error('buildFrameDocument not found in the bundle')
const frameText = bundle.slice(frameStart)
const source = frameText.replace(/\\`/g, '`').replace(/\\n/g, '\n').replace(/\\r\\n/g, '\n')

function lift(name, signature) {
  const at = source.indexOf(signature)
  if (at < 0) return null
  // Brace-match from the function's opening brace.
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', at); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) return null
  return new Function(`${source.slice(at, end)}; return ${name}`)()
}

const smoothPath = lift('smoothPath', 'function smoothPath(points)')
const niceMax = lift('niceMax', 'function niceMax(v)')
// `fmt` is a local dependency of the frame's formatter; stub it for the lift.
check('smoothPath found in the bundle', smoothPath !== null)
check('niceMax found in the bundle', niceMax !== null)
if (smoothPath === null || niceMax === null) {
  console.log(notes.join('\n'))
  console.log(failures.join('\n'))
  process.exit(1)
}

/** Sample a cubic Bézier at t. */
function bezier(p0, c1, c2, p1, t) {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p1
}

/**
 * Walk the generated path and return every sampled point.
 * The path is "M x,y C c1x,c1y c2x,c2y x,y C …" — all cubic segments.
 */
function samplePath(d) {
  const tokens = d.match(/[MC]|-?\d+(?:\.\d+)?/g) ?? []
  const points = []
  let i = 0
  let cursor = null

  while (i < tokens.length) {
    const command = tokens[i]
    if (command === 'M' || command === 'C') {
      i += 1
      if (command === 'M') {
        cursor = { x: Number(tokens[i]), y: Number(tokens[i + 1]) }
        i += 2
        points.push(cursor)
      } else {
        const c1 = { x: Number(tokens[i]), y: Number(tokens[i + 1]) }
        const c2 = { x: Number(tokens[i + 2]), y: Number(tokens[i + 3]) }
        const end = { x: Number(tokens[i + 4]), y: Number(tokens[i + 5]) }
        i += 6
        for (let step = 0; step <= 40; step += 1) {
          const t = step / 40
          points.push({
            x: bezier(cursor.x, c1.x, c2.x, end.x, t),
            y: bezier(cursor.y, c1.y, c2.y, end.y, t),
          })
        }
        cursor = end
      }
    } else {
      i += 1
    }
  }
  return points
}

// ---------------------------------------------------------------- no overshoot

{
  // A shape that made Catmull-Rom dip below the axis: a tall spike with flat zero runs
  // either side. In screen coordinates y grows downward, so the plot floor is the LARGEST
  // y. "Below the axis" means a sampled y greater than both its neighbours' floor.
  const floor = 100
  const points = [
    { x: 0, y: floor },
    { x: 10, y: floor },
    { x: 20, y: 10 },   // spike up
    { x: 30, y: floor },
    { x: 40, y: floor },
    { x: 50, y: 60 },
    { x: 60, y: floor },
  ]
  const samples = samplePath(smoothPath(points))

  const lowest = Math.max(...samples.map((p) => p.y))
  check('curve never goes below the axis', lowest <= floor + 0.01, `max y ${lowest.toFixed(2)} > floor ${floor}`)
  notes.push(`       spike: max y ${lowest.toFixed(2)} (floor ${floor})`)

  const highest = Math.min(...samples.map((p) => p.y))
  check('curve never goes above the data maximum', highest >= 10 - 0.01, `min y ${highest.toFixed(2)} < peak 10`)
}

{
  // A monotone rise must stay monotone — no wiggle backwards between points.
  const points = [
    { x: 0, y: 100 },
    { x: 10, y: 90 },
    { x: 20, y: 70 },
    { x: 30, y: 40 },
    { x: 40, y: 10 },
  ]
  const samples = samplePath(smoothPath(points))
  let monotone = true
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].y > samples[i - 1].y + 0.01) { monotone = false; break }
  }
  check('a monotone rise stays monotone', monotone)
}

{
  // Alternating peaks/troughs: every extremum is a data point, so nothing spikes past them.
  const points = [
    { x: 0, y: 50 },
    { x: 10, y: 100 },
    { x: 20, y: 50 },
    { x: 30, y: 100 },
    { x: 40, y: 50 },
  ]
  const samples = samplePath(smoothPath(points))
  const lowest = Math.max(...samples.map((p) => p.y))
  const highest = Math.min(...samples.map((p) => p.y))
  check('alternating data stays in range (floor)', lowest <= 100 + 0.01, `${lowest.toFixed(2)}`)
  check('alternating data stays in range (ceiling)', highest >= 50 - 0.01, `${highest.toFixed(2)}`)
}

// ---------------------------------------------------------------- degenerate input

{
  check('empty input yields an empty path', smoothPath([]) === '')
  const single = smoothPath([{ x: 5, y: 7 }])
  check('a single point is a move', single === 'M5.0,7.0', single)
  const pair = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }])
  check('two points are a straight line', pair.startsWith('M') && pair.includes('L'), pair)
}

// ---------------------------------------------------------------- axis scale

{
  check('niceMax(0) is 1 (never a zero-height plot)', niceMax(0) === 1)
  check('niceMax rounds up', niceMax(108_000_000) > 108_000_000, `${niceMax(108_000_000)}`)
  // The regression that motivated the fine ladder: 1.08e8 must not jump to 2e8.
  check('niceMax does not waste half the plot', niceMax(108_000_000) <= 150_000_000, `${niceMax(108_000_000)}`)
  check('niceMax of an exact power stays put', niceMax(100) === 100, `${niceMax(100)}`)
}

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} assertions (chart path geometry)`)
