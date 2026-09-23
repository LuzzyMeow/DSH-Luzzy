// Regression tests for the trend windows (lib/usage-window.mjs).
//
// The window logic is where the "natural time unit" rules live, and all three of them are
// easy to get subtly wrong in ways a screenshot will not catch:
//
//   1. Future slots must be `null`, not 0 — drawing them as 0 invents a collapse to the
//      axis for time that has not happened.
//   2. Every slot in the window must be emitted, so a quiet day is a real 0 in the middle
//      of the series and the x-axis keeps its shape.
//   3. The window is a NATURAL unit (today / this week / this month), not "the last N
//      buckets" — so the slot boundaries depend on the calendar, not on the data.
//
// `now` is injected everywhere for exactly this reason: these are calendar assertions and
// they must not depend on when the test runs.
//
// Usage: node tools/test-usage-window.mjs

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { daySlots, weekSlots, monthSlots, windowSeries, monthActivity } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-window.mjs').replace(/\\/g, '/')}`
)

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

/** An attempt at a local wall-clock time, which is what the buckets work in. */
function attempt(year, month, day, hour, minute, tokens, model = 'm/a') {
  return {
    time: new Date(year, month - 1, day, hour ?? 0, minute ?? 0).getTime(),
    model,
    sums: { totalTokens: tokens, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
  }
}

// ---------------------------------------------------------------- day slots

{
  // 2026-09-20 is a Sunday; 15:00 local.
  const now = new Date(2026, 8, 20, 15, 0, 0)
  const slots = daySlots(now)

  check('day: 24 slots', slots.length === 24, `${slots.length}`)
  check('day: first slot is 00:00', slots[0].label === '00:00', slots[0].label)
  check('day: last slot is 23:00', slots[23].label === '23:00', slots[23].label)
  check('day: keys carry the date', slots[0].key === '2026-09-20 00:00', slots[0].key)

  // 15:00 is the current hour: it has begun, so it is not future. 16:00 has not.
  check('day: the current hour is not future', slots[15].isFuture === false)
  check('day: the next hour is future', slots[16].isFuture === true)
  check('day: 23:00 is future', slots[23].isFuture === true)
  notes.push(`       day slots: ${slots.filter((s) => !s.isFuture).length} elapsed / ${slots.filter((s) => s.isFuture).length} future`)
}

// ---------------------------------------------------------------- week slots

{
  // Sunday 2026-09-20 -> the natural week started Monday 2026-09-14.
  const now = new Date(2026, 8, 20, 15, 0, 0)
  const slots = weekSlots(now)

  check('week: 7 slots', slots.length === 7, `${slots.length}`)
  check('week: starts Monday the 14th', slots[0].key === '2026-09-14', slots[0].key)
  check('week: ends Sunday the 20th', slots[6].key === '2026-09-20', slots[6].key)
  check('week: today is not future', slots[6].isFuture === false)
  check('week: labels are month/day', slots[0].label === '9/14', slots[0].label)

  // A Monday must be its own week's first day, not the previous week's last.
  const monday = weekSlots(new Date(2026, 8, 14, 9, 0, 0))
  check('week: Monday starts its own week', monday[0].key === '2026-09-14', monday[0].key)
  check('week: Monday has no future weekday before it', monday.slice(1).every((s) => s.isFuture))

  // By the end of Sunday every day of the week has begun, so nothing in the window is
  // future — a past day with no usage is a real 0, not a blank.
  const sunday = weekSlots(new Date(2026, 8, 20, 23, 0, 0))
  check('week: Sunday closes the week', sunday[6].key === '2026-09-20')
  check('week: by Sunday nothing is future', sunday.every((s) => !s.isFuture))
}

// ---------------------------------------------------------------- month slots

{
  // September 2026 starts on a Tuesday and ends on a Wednesday, so its NATURAL weeks run
  // Mon 8/31 -> Sun 9/6 through Mon 9/28 -> Sun 10/4. Five slots, and the first and last
  // each borrow days from a neighbouring month.
  const now = new Date(2026, 8, 20, 15, 0, 0)
  const slots = monthSlots(now)

  check('month: 5 natural weeks for September 2026', slots.length === 5, `${slots.length}`)
  check('month: labels are 第N周', slots[0].label === '第1周', slots[0].label)

  // Every slot is a Monday..Sunday week, not an invented 1-7 / 8-14 range.
  for (const slot of slots) {
    const from = new Date(slot.from)
    const to = new Date(slot.to)
    if (from.getDay() !== 1) check(`month: ${slot.label} starts on Monday`, false, `day ${from.getDay()}`)
    if (to.getDay() !== 0) check(`month: ${slot.label} ends on Sunday`, false, `day ${to.getDay()}`)
  }
  notes.push('  ok   month: every slot is a Monday..Sunday week')

  // The first week starts in AUGUST and the last ends in OCTOBER.
  const firstFrom = new Date(slots[0].from)
  check('month: week 1 begins 8/31 (borrows from August)',
    firstFrom.getMonth() === 7 && firstFrom.getDate() === 31,
    `${firstFrom.getMonth() + 1}/${firstFrom.getDate()}`)
  const lastTo = new Date(slots[4].to)
  check('month: week 5 ends 10/4 (borrows from October)',
    lastTo.getMonth() === 9 && lastTo.getDate() === 4,
    `${lastTo.getMonth() + 1}/${lastTo.getDate()}`)

  // The label carries the range, formatted so a cross-month week is unambiguous.
  check('month: week 1 range is 8.31 - 9.6', slots[0].range === '8.31 - 9.6', slots[0].range)
  check('month: week 5 range is 9.28 - 10.4', slots[4].range === '9.28 - 10.4', slots[4].range)

  check('month: the current week is not future', slots[2].isFuture === false)
  check('month: the last week is future', slots[4].isFuture === true)

  // Weeks must tile without gaps or overlap: each starts the day after the previous ended.
  let tiled = true
  for (let i = 1; i < slots.length; i += 1) {
    const prevEnd = new Date(slots[i - 1].to)
    const nextStart = new Date(slots[i].from)
    const expected = new Date(prevEnd.getFullYear(), prevEnd.getMonth(), prevEnd.getDate() + 1)
    if (expected.getTime() !== nextStart.getTime()) tiled = false
  }
  check('month: weeks tile with no gap or overlap', tiled)

  // A month that STARTS on a Monday borrows nothing from the previous month.
  // June 2026 starts on a Monday.
  const june = monthSlots(new Date(2026, 5, 15, 12, 0, 0))
  check('month: June 2026 starts on its own 1st', new Date(june[0].from).getDate() === 1,
    `${new Date(june[0].from).getMonth() + 1}/${new Date(june[0].from).getDate()}`)

  // February 2026 starts on a Sunday, so it needs a leading August..January week.
  const feb = monthSlots(new Date(2026, 1, 10, 12, 0, 0))
  check('month: February 2026 spans 5 natural weeks', feb.length === 5, `${feb.length}`)
  check('month: its week 1 starts in January', new Date(feb[0].from).getMonth() === 0,
    `${new Date(feb[0].from).getMonth() + 1}/${new Date(feb[0].from).getDate()}`)
  notes.push(`       February 2026: ${feb.map((s) => s.range).join(' | ')}`)
}

// ---------------------------------------------------------------- series

{
  const now = new Date(2026, 8, 20, 15, 0, 0)
  const attempts = [
    attempt(2026, 9, 20, 10, 0, 100, 'alpha'),
    attempt(2026, 9, 20, 10, 30, 50, 'beta'),
    attempt(2026, 9, 20, 14, 0, 200, 'alpha'),
    // Yesterday: inside the week window, not inside the day window.
    attempt(2026, 9, 19, 22, 0, 400, 'alpha'),
    // Last month: inside no window here.
    attempt(2026, 8, 1, 12, 0, 900, 'gamma'),
  ]

  const day = windowSeries({ attempts }, 'day', now)
  check('day series: only today\'s models', day.series.every((s) => s.key !== 'gamma'))
  check('day series: two models', day.series.length === 2, `${day.series.length}`)
  check('day series: ordered by window total', day.series[0].key === 'alpha', day.series.map((s) => s.key).join(','))

  const alphaDay = day.series.find((s) => s.key === 'alpha')
  const slot10 = day.slots.findIndex((s) => s.label === '10:00')
  const slot14 = day.slots.findIndex((s) => s.label === '14:00')
  check('day series: 10:00 has 100', alphaDay.values[slot10] === 100, `${alphaDay.values[slot10]}`)
  check('day series: 14:00 has 200', alphaDay.values[slot14] === 200, `${alphaDay.values[slot14]}`)
  check('day series: a quiet hour is 0, not null', alphaDay.values[11] === 0, `${alphaDay.values[11]}`)
  // 16:00 onward has not happened.
  check('day series: future hours are null', alphaDay.values[16] === null, `${alphaDay.values[16]}`)
  check('day series: the last slot is null', alphaDay.values[23] === null)
  check('day series: window total excludes future', alphaDay.windowTotal === 300, `${alphaDay.windowTotal}`)

  const week = windowSeries({ attempts }, 'week', now)
  const alphaWeek = week.series.find((s) => s.key === 'alpha')
  check('week series: includes yesterday', alphaWeek.windowTotal === 300 + 400, `${alphaWeek.windowTotal}`)
  check('week series: excludes last month', week.series.every((s) => s.key !== 'gamma'))

  const month = windowSeries({ attempts }, 'month', now)
  const alphaMonth = month.series.find((s) => s.key === 'alpha')
  check('month series: sums the whole month', alphaMonth.windowTotal === 300 + 400, `${alphaMonth.windowTotal}`)
  const week3 = month.slots.findIndex((s) => s.label === '第3周')
  check('month series: the 20th lands in week 3', alphaMonth.values[week3] === 300 + 400, `${alphaMonth.values[week3]}`)

  // `null` must break the curve, so the count of non-null values equals elapsed slots.
  const elapsed = day.slots.filter((s) => !s.isFuture).length
  check(
    'day series: non-null values equal elapsed slots',
    alphaDay.values.filter((v) => v !== null).length === elapsed,
    `${alphaDay.values.filter((v) => v !== null).length} vs ${elapsed}`,
  )
}

// ---------------------------------------------------------------- activity

{
  const now = new Date(2026, 8, 20, 15, 0, 0)
  const attempts = [attempt(2026, 9, 3, 12, 0, 10), attempt(2026, 9, 20, 12, 0, 20), attempt(2026, 8, 31, 12, 0, 99)]
  const activity = monthActivity({ attempts }, now)

  check('activity: one cell per day of the month', activity.days.length === 30, `${activity.days.length}`)
  check('activity: month is 2026-09', activity.month === '2026-09', activity.month)
  check('activity: day 3 has its tokens', activity.days[2].tokens === 10, `${activity.days[2].tokens}`)
  check('activity: day 20 has its tokens', activity.days[19].tokens === 20, `${activity.days[19].tokens}`)
  check('activity: last month is excluded', activity.days.every((d) => d.tokens !== 99))
  check('activity: days 1-20 are not future', activity.days.slice(0, 20).every((d) => !d.isFuture))
  check('activity: days 21-30 are future', activity.days.slice(20).every((d) => d.isFuture))
  check('activity: a future day has zero tokens and is flagged', activity.days[25].tokens === 0 && activity.days[25].isFuture)
}

// ---------------------------------------------------------------- series cap

{
  const now = new Date(2026, 8, 20, 15, 0, 0)

  // 12 models in the current month: more than the chart will draw as separate curves.
  const attempts = []
  for (let i = 0; i < 12; i += 1) {
    attempts.push(attempt(2026, 9, 20, 10, 0, (i + 1) * 100, `model-${String(i).padStart(2, '0')}`))
  }

  const month = windowSeries({ attempts }, 'month', now)
  check('cap: series are capped', month.series.length <= 8, `${month.series.length}`)
  check('cap: grouped count is reported', month.grouped === 12 - 7, `${month.grouped}`)

  // The important property: grouping must SUM the tail, not discard it. If the tail were
  // dropped the chart would silently understate the month.
  const drawn = month.series.reduce((sum, s) => sum + s.windowTotal, 0)
  const expected = attempts.reduce((sum, a) => sum + a.sums.totalTokens, 0)
  check('cap: grouped series still add up to the true total', drawn === expected, `${drawn} vs ${expected}`)

  // And the head keeps the biggest contributors, in order.
  check('cap: biggest model is drawn first', month.series[0].key === 'model-11', month.series[0].key)
  check('cap: grouped entry is last', month.series[7].key.startsWith('其他模型'), month.series[7].key)

  // Under the cap, nothing is grouped and the labels are the real model names.
  const few = windowSeries({ attempts: attempts.slice(0, 5) }, 'month', now)
  check('cap: under the cap nothing is grouped', few.grouped === 0, `${few.grouped}`)
  check('cap: under the cap all models are drawn', few.series.length === 5, `${few.series.length}`)
}

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} assertions (trend windows)`)
