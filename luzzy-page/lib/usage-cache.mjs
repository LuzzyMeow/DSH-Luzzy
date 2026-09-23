/**
 * Disk cache for parsed session logs.
 *
 * WHY THIS EXISTS
 *
 * The cold pass over the session logs is ~20 s, and almost all of it is decompressing 220 MB
 * of multi-frame zstd into 553 MB of JSONL before parsing it down to ~20k usage attempts.
 * Measured on this machine:
 *
 *   decompress zstd -> jsonl   18,012 ms
 *   parse jsonl -> attempts     2,378 ms
 *   --------------------------------
 *   cold total                 20,390 ms
 *
 * The same attempts serialize to 3.1 MB and read back in 16 ms. So the expensive part is
 * entirely reusable across restarts, which is exactly what a user hits: every DSH launch
 * paid the full 20 s again for data that had not changed.
 *
 * WHAT IS CACHED
 *
 * The extraction result (one entry per attempt: time, model, summed tokens), NOT the raw
 * JSONL — the parsed form is 170x smaller and is all the aggregation needs. The decompress
 * step is never cached, it is simply skipped when a file's extract is already known.
 *
 * VALIDITY
 *
 * Per file, keyed by (size, mtimeMs) — the same test the worker's in-memory cache uses. A
 * log that was appended to has a new size and is re-read; one that has not been touched is
 * reused verbatim. So a restart with a few new sessions re-parses only those few.
 *
 * `CACHE_VERSION` covers the other invalidation axis: the EXTRACTION LOGIC itself. Changing
 * how attempts are parsed or attributed produces stale-but-well-formed entries that the
 * size/mtime check cannot detect, so bump the version whenever usage-core's output changes.
 *
 * Everything here fails soft. A missing, unreadable, corrupt or version-mismatched cache is
 * simply a cold start; it is never allowed to break the plugin or return wrong numbers.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Bump whenever `extractLog` / `SUM_FIELDS` / model attribution changes shape or meaning.
 *
 * 1 — initial
 */
export const CACHE_VERSION = 1

/** Refuse to write a cache larger than this; a pathological sessions dir falls back to cold. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024

/**
 * Convert an extraction result into a JSON-safe form.
 *
 * `modelRouting` is a Map, and `JSON.stringify` renders a Map as `{}` — silently. Reading
 * such a cache back would hand the worker a plain object where it expects a Map, and the
 * `for (const [model, count] of extracted.modelRouting)` loop would throw, get swallowed by
 * the per-file catch, and count the whole file as skipped. Every number would quietly go to
 * zero. So the conversion is explicit here rather than left to JSON.
 *
 * @param {object} extracted
 */
function toStorable(extracted) {
  return {
    attempts: extracted.attempts,
    modelRouting: extracted.modelRouting instanceof Map
      ? [...extracted.modelRouting.entries()]
      : Object.entries(extracted.modelRouting ?? {}),
    firstTime: extracted.firstTime,
    lastTime: extracted.lastTime,
  }
}

/**
 * Convert a stored entry back into the shape the aggregator expects.
 *
 * @param {object} stored
 * @returns {object | null} null if the entry is not usable
 */
function fromStorable(stored) {
  if (stored === null || typeof stored !== 'object') return null
  if (!Array.isArray(stored.attempts)) return null
  if (!Array.isArray(stored.modelRouting)) return null
  return {
    attempts: stored.attempts,
    modelRouting: new Map(stored.modelRouting),
    firstTime: typeof stored.firstTime === 'number' ? stored.firstTime : null,
    lastTime: typeof stored.lastTime === 'number' ? stored.lastTime : null,
  }
}

/**
 * Load the cached extracts.
 *
 * @param {string} cacheFile
 * @returns {{version: number, files: Map<string, {size: number, mtimeMs: number, extracted: object}>}}
 */
export function loadExtractCache(cacheFile) {
  const empty = { version: CACHE_VERSION, files: new Map() }
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return empty
    if (parsed.version !== CACHE_VERSION) return empty
    if (parsed.files === null || typeof parsed.files !== 'object') return empty

    // Drop malformed entries rather than trusting them: a corrupt entry would otherwise
    // surface as wrong numbers, which is far worse than a slow cold start.
    const files = new Map()
    for (const [path, entry] of Object.entries(parsed.files)) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.size !== 'number' || typeof entry.mtimeMs !== 'number') continue
      const extracted = fromStorable(entry.extracted)
      if (extracted === null) continue
      files.set(path, { size: entry.size, mtimeMs: entry.mtimeMs, extracted })
    }
    return { version: CACHE_VERSION, files }
  } catch {
    return empty
  }
}

/**
 * Write the cache, atomically.
 *
 * A temp file plus rename, so an interrupted write cannot leave a half-written cache that
 * the next launch would fail to parse (and a crash mid-write is exactly when the cache
 * matters most — that is the launch after an unclean exit).
 *
 * @param {string} cacheFile
 * @param {Map<string, {size: number, mtimeMs: number, extracted: object}>} entries
 * @returns {boolean} whether it was written
 */
export function saveExtractCache(cacheFile, entries) {
  try {
    const files = {}
    for (const [path, entry] of entries) {
      files[path] = { size: entry.size, mtimeMs: entry.mtimeMs, extracted: toStorable(entry.extracted) }
    }
    const payload = JSON.stringify({ version: CACHE_VERSION, files })
    if (payload.length > MAX_CACHE_BYTES) return false

    mkdirSync(dirname(cacheFile), { recursive: true })
    const temp = `${cacheFile}.${process.pid}.tmp`
    writeFileSync(temp, payload, 'utf8')
    renameSync(temp, cacheFile)
    return true
  } catch {
    // A cache that cannot be written is not an error — the next launch just runs cold.
    return false
  }
}

/**
 * Delete the cache. Used when a caller needs to force a rebuild.
 *
 * @param {string} cacheFile
 */
export function dropExtractCache(cacheFile) {
  try {
    rmSync(cacheFile, { force: true })
  } catch {
    // Nothing to do: absence is the desired state.
  }
}

/**
 * Is a cached entry still valid for the file on disk?
 *
 * @param {{size: number, mtimeMs: number}} entry
 * @param {string} path
 * @returns {boolean}
 */
export function entryMatchesFile(entry, path) {
  try {
    const stat = statSync(path)
    return entry.size === stat.size && entry.mtimeMs === stat.mtimeMs
  } catch {
    return false
  }
}
