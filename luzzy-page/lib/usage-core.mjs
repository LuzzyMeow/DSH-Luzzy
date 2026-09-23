/**
 * Pure aggregation core, shared by the host half and its worker thread.
 *
 * Kept free of anything that binds it to a particular thread: no worker_threads, no
 * caches, no I/O beyond the buffer handed in. The worker runs it off the host's main
 * thread; the tests run it directly.
 *
 * The numbers must be right, and getting them right means respecting one contract that
 * is easy to miss: every settled attempt records its usage TWICE — once as
 * `assistant/message.data.usage` and once inside `data.stream[N].chunk.usage`. The
 * harness's own token-meter treats the final sample as REPLACING the streamed one.
 * Summing both inflates totals by ~1.64x on this machine's real data.
 *
 * Attribution rules, all verified against real logs:
 *   - usage   : assistant/message -> data.usage, falling back to the last stream chunk
 *   - model   : the nearest preceding request/header (data.header.config.provider/model)
 *   - time    : the event's own `time`, a millisecond epoch
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** Fields summed across attempts. Fields absent from this machine's data are omitted. */
export const SUM_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens']

/**
 * Decompress a DSH session log.
 *
 * These files are an APPEND log: every write appends an independent zstd frame, so a
 * single log holds many frames back to back (the 1.9 MB sample holds 21). Neither
 * stock helper handles that on its own:
 *
 *   * `zstdDecompressSync` stops at the end of the first frame and silently returns a
 *     truncated result — 222 bytes out of 1.9 MB, which is how a whole aggregate came
 *     out as zeros with no error at all.
 *   * a streaming decompressor reads the first frame then aborts with
 *     "Unknown frame descriptor" on the next frame's leading bytes.
 *
 * So split the buffer on the zstd magic number and inflate each frame separately. The
 * magic value 0x28B52FFD is the frame header per RFC 8878 and is not content-dependent.
 *
 * @param {Buffer} buffer raw file contents
 * @returns {string}
 */
export function decompressBuffer(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

  const starts = []
  let cursor = 0
  for (;;) {
    const found = buffer.indexOf(MAGIC, cursor)
    if (found === -1) break
    starts.push(found)
    cursor = found + 1
  }
  if (starts.length === 0) throw new Error('no zstd frame in buffer')

  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(from, to)))
    } catch {
      // A frame that will not inflate is skipped rather than failing the whole log: a
      // log can be truncated mid-append if the process was killed.
    }
  }

  return Buffer.concat(parts).toString('utf8')
}

/**
 * Extract every usage attempt from one decompressed log, UNIT-INDEPENDENTLY.
 *
 * Splitting this from bucketing is what makes unit switching cheap: decompressing and
 * parsing all logs is the expensive part, while re-bucketing extracted attempts costs
 * milliseconds.
 *
 * @param {string} text decompressed JSONL
 */
export function extractLog(text) {
  /** @type {Array<{time: number|null, model: string, sums: Record<string, number>}>} */
  const attempts = []
  const modelRouting = new Map()
  let currentModel = 'unknown'
  let firstTime = null
  let lastTime = null

  for (const line of text.split('\n')) {
    if (line === '') continue

    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    const type = event.type
    const data = event.data ?? {}

    if (type === 'request/header') {
      const config = data.header?.config
      if (config !== undefined) {
        currentModel = `${config.provider ?? '?'}/${config.model ?? '?'}`
        modelRouting.set(currentModel, (modelRouting.get(currentModel) ?? 0) + 1)
      }
      continue
    }

    if (type !== 'assistant/message') continue

    const time = typeof event.time === 'number' ? event.time : null
    if (time !== null) {
      if (firstTime === null || time < firstTime) firstTime = time
      if (lastTime === null || time > lastTime) lastTime = time
    }

    // Exactly one usage sample per attempt: the settled sample replaces the streamed one.
    let usage = data.usage
    if (usage === undefined || usage === null) {
      const stream = Array.isArray(data.stream) ? data.stream : []
      for (let index = stream.length - 1; index >= 0; index -= 1) {
        const candidate = stream[index]?.chunk?.usage
        if (candidate !== undefined && candidate !== null) {
          usage = candidate
          break
        }
      }
    }
    if (usage === undefined || usage === null) continue

    const sums = {}
    let any = false
    for (const field of SUM_FIELDS) {
      const value = usage[field]
      if (typeof value === 'number' && Number.isFinite(value)) {
        sums[field] = value
        any = true
      }
    }
    if (!any) continue

    attempts.push({ time, model: currentModel, sums })
  }

  return { attempts, modelRouting, firstTime, lastTime }
}

/**
 * @param {number} ms epoch milliseconds
 * @param {'hour'|'day'|'week'|'month'} unit
 * @returns {string} bucket key, in local time so the chart matches the user's clock
 */
export function bucketKey(ms, unit) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())

  if (unit === 'hour') return `${year}-${month}-${day} ${pad(date.getHours())}:00`
  if (unit === 'day') return `${year}-${month}-${day}`
  if (unit === 'month') return `${year}-${month}`

  if (unit === 'week') {
    // ISO week, computed in local time.
    const target = new Date(year, date.getMonth(), date.getDate())
    const dayNumber = (target.getDay() + 6) % 7
    target.setDate(target.getDate() - dayNumber + 3)
    const firstThursday = new Date(target.getFullYear(), 0, 4)
    const firstDayNumber = (firstThursday.getDay() + 6) % 7
    firstThursday.setDate(firstThursday.getDate() - firstDayNumber + 3)
    const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000))
    return `${target.getFullYear()}-W${pad(week)}`
  }

  throw new Error(`unknown unit: ${unit}`)
}

/**
 * Group extracted attempts by time bucket and by model.
 *
 * Also builds the model × bucket matrix. The trend chart plots one curve per model over a
 * single window (today's hours, this week's days, this month's weeks), which needs each
 * model's value *per bucket* — the two flat maps below cannot express that.
 *
 * @param {ReturnType<typeof extractLog>} extracted
 * @param {'hour'|'day'|'week'|'month'} unit
 */
export function bucketAttempts(extracted, unit) {
  const byBucket = new Map()
  const byModel = new Map()
  /** @type {Map<string, Map<string, Record<string, number>>>} model -> bucket -> sums */
  const byModelBucket = new Map()

  const add = (map, key, sums) => {
    let entry = map.get(key)
    if (entry === undefined) {
      entry = Object.fromEntries(SUM_FIELDS.map((name) => [name, 0]))
      map.set(key, entry)
    }
    for (const field of SUM_FIELDS) {
      if (sums[field] !== undefined) entry[field] += sums[field]
    }
  }

  for (const attempt of extracted.attempts) {
    const bucket = attempt.time === null ? 'unknown' : bucketKey(attempt.time, unit)
    add(byBucket, bucket, attempt.sums)
    add(byModel, attempt.model, attempt.sums)

    let perBucket = byModelBucket.get(attempt.model)
    if (perBucket === undefined) {
      perBucket = new Map()
      byModelBucket.set(attempt.model, perBucket)
    }
    add(perBucket, bucket, attempt.sums)
  }

  return { byBucket, byModel, byModelBucket }
}