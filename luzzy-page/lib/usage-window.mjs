/**
 * Trend windows for LuzzyPage.
 *
 * The trend chart is not "the last N buckets" — it is a view of the CURRENT natural time
 * unit, so the shape of the chart matches how people talk about usage ("today so far",
 * "this week", "this month"):
 *
 *   day   -> the 24 hours of today
 *   week  -> the 7 days of this natural week (Monday first)
 *   month -> the weeks of this natural month (1–7, 8–14, 15–21, 22–28, 29–end)
 *
 * Two rules that follow from that, and are the whole point of this module:
 *
 *   1. Slots that have NOT HAPPENED YET are reported as `null`, not 0. A future hour is
 *      not "zero usage" — drawing it as 0 would invent a cliff down to the axis that the
 *      user never experienced. The chart stops at the present.
 *   2. Every slot in the window is emitted, not just the ones with data. A day with no
 *      activity is a real 0 in the middle of the series, and the x-axis keeps its shape.
 *
 * Time is local throughout, matching `bucketKey` in usage-core.mjs: the chart has to line
 * up with the user's own clock, not with UTC.
 */

const DAY_MS = 24 * 60 * 60 * 1000

const pad = (value) => String(value).padStart(2, '0')

/** Local yyyy-mm-dd for a Date. */
function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local yyyy-mm-dd for an epoch value. */
function localDateOf(ms) {
  return localDate(new Date(ms))
}

/** Monday-based weekday index: Monday = 0 … Sunday = 6. */
function mondayIndex(date) {
  return (date.getDay() + 6) % 7
}

/**
 * The slots of the current natural day: 24 hours, `00:00` … `23:00`.
 *
 * @param {Date} now
 * @returns {Array<{key: string, label: string, isFuture: boolean}>}
 */
export function daySlots(now) {
  const slots = []
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (let hour = 0; hour < 24; hour += 1) {
    const at = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour)
    slots.push({
      key: `${localDate(at)} ${pad(hour)}:00`,
      label: `${pad(hour)}:00`,
      isFuture: at.getTime() > now.getTime(),
    })
  }
  return slots
}

/**
 * The slots of the current natural week: Monday … Sunday.
 *
 * @param {Date} now
 * @returns {Array<{key: string, label: string, isFuture: boolean}>}
 */
export function weekSlots(now) {
  const slots = []
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayIndex(now))
  for (let offset = 0; offset < 7; offset += 1) {
    const at = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset)
    slots.push({
      key: localDate(at),
      label: `${at.getMonth() + 1}/${at.getDate()}`,
      isFuture: at.getTime() > now.getTime(),
    })
  }
  return slots
}

/**
 * The slots of the current month, as the NATURAL weeks it spans.
 *
 * Natural weeks (Monday–Sunday), NOT 1–7 / 8–14 / … . A week is a calendar unit people
 * actually use, and its edges routinely fall in the neighbouring months: September 2026
 * starts on a Tuesday, so its first week is Mon 8/31 – Sun 9/6 and its last is
 * 9/28 – 10/4. Splitting the month at "the 1st" and "the 7th" would instead produce five
 * invented date ranges matching nothing on a calendar, which is what this replaced.
 *
 * The consequence is deliberate: a slot's usage includes the days it borrows from the
 * adjacent months, because that week really did occur then. Each label carries its date
 * range so the borrowing is visible rather than silently folded in.
 *
 * @param {Date} now
 * @returns {Array<{key: string, label: string, range: string, isFuture: boolean, from: number, to: number}>}
 */
export function monthSlots(now) {
  const year = now.getFullYear()
  const month = now.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  // The Monday on or before the 1st, and the Sunday on or after the last day.
  const firstDay = new Date(year, month, 1)
  const start = new Date(year, month, 1 - mondayIndex(firstDay))
  const lastDay = new Date(year, month, daysInMonth)
  const end = new Date(year, month, daysInMonth + (6 - mondayIndex(lastDay)))

  const slots = []
  let week = 1
  let cursor = start

  while (cursor.getTime() <= end.getTime()) {
    const sunday = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 6)
    slots.push({
      key: `W${week}`,
      label: `第${week}周`,
      // Compact and unambiguous across a month edge: "8.31 - 9.6", "9.28 - 10.4".
      range: `${cursor.getMonth() + 1}.${cursor.getDate()} - ${sunday.getMonth() + 1}.${sunday.getDate()}`,
      isFuture: cursor.getTime() > now.getTime(),
      from: cursor.getTime(),
      // Exclusive end, so consecutive weeks cannot both claim a millisecond exactly on a
      // boundary. Slot assignment is otherwise a plain range test.
      to: new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 1).getTime() - 1,
    })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7)
    week += 1
  }
  return slots
}

/**
 * Build the slot list for one window.
 *
 * @param {'day'|'week'|'month'} window
 * @param {Date} now
 */
export function slotsFor(window, now) {
  if (window === 'day') return daySlots(now)
  if (window === 'week') return weekSlots(now)
  if (window === 'month') return monthSlots(now)
  throw new Error(`unknown window: ${window}`)
}

/**
 * The bucket key an attempt's timestamp falls into, for a given window.
 *
 * Mirrors `bucketKey` for day and week; the month window works in week-of-month, so it is
 * resolved against the slot ranges instead of recomputed here.
 *
 * @param {number} ms
 * @param {'hour'|'day'} unit
 */
function keyForTime(ms, unit) {
  const date = new Date(ms)
  if (unit === 'hour') return `${localDate(date)} ${pad(date.getHours())}:00`
  return localDate(date)
}

/**
 * How many curves the chart will draw before grouping the rest.
 *
 * Eight is where a multi-series line chart stops being readable — beyond that the curves
 * cross each other faster than the eye can follow a colour, and the legend stops fitting on
 * one row. This machine's month window reaches 16 models, so the cap is load-bearing, not
 * theoretical.
 */
const MAX_SERIES = 8

/**
 * Build the per-model series for one window.
 *
 * Only models that actually appear inside the window are returned — a model used last
 * month would otherwise add a legend entry and a flat line at zero for a window it has
 * nothing to do with, which is noise. Models are ordered by their total inside the window,
 * so the biggest contributor is drawn first.
 *
 * Beyond `MAX_SERIES` the tail is summed into one "其他模型" series rather than dropped:
 * the totals then still add up to the window total, and no usage silently disappears from
 * the chart.
 *
 * @param {ReturnType<import('./usage-core.mjs').extractLog>} extracted
 * @param {'day'|'week'|'month'} window
 * @param {Date} now
 * @returns {{window: string, from: number|null, to: number|null, slots: object[], series: object[], grouped: number}}
 */
export function windowSeries(extracted, window, now) {
  const slots = slotsFor(window, now)
  const slotIndex = new Map(slots.map((slot, index) => [slot.key, index]))
  const isMonth = window === 'month'

  /** @type {Map<string, number[]>} model -> per-slot totals */
  const perModel = new Map()

  for (const attempt of extracted.attempts) {
    if (attempt.time === null) continue

    let index = -1
    if (isMonth) {
      // Assign by range: the month window's slots are date ranges, not a single key.
      index = slots.findIndex((slot) => attempt.time >= slot.from && attempt.time <= slot.to)
    } else {
      const key = keyForTime(attempt.time, window === 'day' ? 'hour' : 'day')
      const found = slotIndex.get(key)
      index = found === undefined ? -1 : found
    }
    if (index === -1) continue

    let values = perModel.get(attempt.model)
    if (values === undefined) {
      values = new Array(slots.length).fill(0)
      perModel.set(attempt.model, values)
    }
    const total = attempt.sums.totalTokens
    if (typeof total === 'number' && Number.isFinite(total)) values[index] += total
  }

  const ranked = [...perModel.entries()]
    .map(([key, values]) => ({ key, values }))
    .sort((a, b) => sumValues(b.values) - sumValues(a.values))

  let series = ranked
  let grouped = 0
  if (ranked.length > MAX_SERIES) {
    const head = ranked.slice(0, MAX_SERIES - 1)
    const tail = ranked.slice(MAX_SERIES - 1)
    grouped = tail.length
    const merged = new Array(slots.length).fill(0)
    for (const item of tail) {
      for (let i = 0; i < merged.length; i += 1) merged[i] += item.values[i]
    }
    series = [...head, { key: `其他模型（${grouped} 个）`, values: merged }]
  }

  return {
    window,
    // `range` is carried through for the month window, whose labels name a date span that
    // may cross a month edge; the other windows have no equivalent.
    slots: slots.map(({ key, label, range, isFuture }) => ({
      key,
      label,
      ...(range === undefined ? {} : { range }),
      isFuture,
    })),
    series: series.map(({ key, values }) => ({
      key,
      // A future slot stays null so the curve stops there; see the module comment.
      values: values.map((value, index) => (slots[index].isFuture ? null : value)),
      windowTotal: sumValues(values, slots),
    })),
    grouped,
    from: slots[0] && slots[0].from !== undefined ? slots[0].from : null,
    to: now.getTime(),
  }
}

/** Sum a per-slot array, skipping future slots when `slots` is supplied. */
function sumValues(values, slots) {
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    if (slots !== undefined && slots[i].isFuture) continue
    sum += values[i]
  }
  return sum
}

/**
 * The activity strip: one cell per day of the current natural month.
 *
 * Days that have not arrived yet are marked `isFuture` so the client can leave them blank
 * rather than paint them as a zero-usage day.
 *
 * @param {ReturnType<import('./usage-core.mjs').extractLog>} extracted
 * @param {Date} now
 */
export function monthActivity(extracted, now) {
  const year = now.getFullYear()
  const month = now.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const todayKey = localDate(now)

  /** @type {Map<string, number>} date -> tokens */
  const perDay = new Map()
  /** @type {Set<string>} dates that have any attempt at all, for the tooltip */
  const touched = new Set()

  for (const attempt of extracted.attempts) {
    if (attempt.time === null) continue
    const key = localDateOf(attempt.time)
    if (!key.startsWith(`${year}-${pad(month + 1)}`)) continue
    const total = attempt.sums.totalTokens
    perDay.set(key, (perDay.get(key) ?? 0) + (typeof total === 'number' && Number.isFinite(total) ? total : 0))
    touched.add(key)
  }

  const days = []
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${pad(month + 1)}-${pad(day)}`
    days.push({
      key,
      day,
      tokens: perDay.get(key) ?? 0,
      isFuture: key > todayKey,
    })
  }

  return { month: `${year}-${pad(month + 1)}`, daysInMonth, today: now.getDate(), days }
}

export { DAY_MS }
