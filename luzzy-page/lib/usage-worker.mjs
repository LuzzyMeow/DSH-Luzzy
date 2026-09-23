/**
 * Aggregation worker: does every expensive step off the host's main thread.
 *
 * The host's profile admission channel times out RPC calls after 30 s, and a full pass
 * over the session logs is ~20 s of synchronous zstd inflation + JSONL parsing. Running
 * that on the main thread — even in setImmediate chunks — starved the channel and crashed
 * host-boot twice. In this thread it can take as long as it needs.
 *
 * Protocol: postMessage { sessionsRoot, unit, refresh }, reply { payload } or { error }.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'

import { decompressBuffer, extractLog, bucketAttempts, SUM_FIELDS } from './usage-core.mjs'
import { windowSeries, monthActivity } from './usage-window.mjs'
import { loadExtractCache, saveExtractCache, entryMatchesFile } from './usage-cache.mjs'

/** Recursively collect *.jsonl.zstd under a sessions root. */
function collectLogs(root) {
  const found = []

  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.endsWith('.jsonl.zstd')) found.push(full)
    }
  }

  walk(root, 0)
  return found
}

/**
 * Per-file extraction cache.
 *
 * Two layers, because they solve different problems:
 *
 *   * `extractCache` (memory) — the worker is long-lived, so switching the time unit or
 *     refreshing reuses the parsed logs instead of re-reading them.
 *   * `diskCache` — survives a RESTART. Without it every DSH launch re-paid the full ~20 s
 *     decompress+parse for logs that had not changed.
 *
 * Both are keyed by (size, mtimeMs): an appended log is re-read, an untouched one is reused.
 * The disk layer is loaded lazily on first use and written once per aggregation.
 *
 * @type {Map<string, {size: number, mtimeMs: number, extracted: ReturnType<typeof extractLog>}>}
 */
const extractCache = new Map()
/** @type {Map<string, {size: number, mtimeMs: number, extracted: object}> | null} */
let diskCache = null
let diskCachePath = null
/** How many files the cache let us skip on this run — reported back for diagnostics. */
let cacheHits = 0
let cacheMisses = 0

function ensureDiskCache(cacheFile) {
  if (diskCache !== null && diskCachePath === cacheFile) return diskCache
  diskCachePath = cacheFile
  diskCache = cacheFile === null ? new Map() : loadExtractCache(cacheFile).files
  return diskCache
}

function extractAt(path, cacheFile) {
  const stat = statSync(path)
  const cached = extractCache.get(path)
  if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    cacheHits += 1
    return cached.extracted
  }

  // Not in memory: try the disk layer before paying the decompress.
  const disk = ensureDiskCache(cacheFile)
  const onDisk = disk.get(path)
  if (onDisk !== undefined && entryMatchesFile(onDisk, path)) {
    extractCache.set(path, onDisk)
    cacheHits += 1
    return onDisk.extracted
  }

  cacheMisses += 1
  const extracted = extractLog(decompressBuffer(readFileSync(path)))
  const entry = { size: stat.size, mtimeMs: stat.mtimeMs, extracted }
  extractCache.set(path, entry)
  disk.set(path, entry)
  return extracted
}

function aggregate(sessionsRoot, unit, refresh, cacheFile) {
  const logs = collectLogs(sessionsRoot)
  const byBucket = new Map()
  const byModel = new Map()
  const totals = Object.fromEntries(SUM_FIELDS.map((name) => [name, 0]))
  const modelRoutingCounts = new Map()
  /** Union of every attempt across every log, for the window computations. */
  const allAttempts = []
  let attempts = 0
  let sessions = 0
  let skipped = 0
  let firstTime = null
  let lastTime = null

  // Reset the per-run counters so the payload reports THIS run, not a lifetime total.
  cacheHits = 0
  cacheMisses = 0

  const merge = (target, source) => {
    for (const [key, sums] of source) {
      let entry = target.get(key)
      if (entry === undefined) {
        entry = Object.fromEntries(SUM_FIELDS.map((name) => [name, 0]))
        target.set(key, entry)
      }
      for (const field of SUM_FIELDS) entry[field] += sums[field]
    }
  }

  for (const path of logs) {
    let extracted
    try {
      extracted = extractAt(path, cacheFile ?? null)
    } catch {
      skipped += 1
      continue
    }

    sessions += 1
    attempts += extracted.attempts.length

    const bucketed = bucketAttempts(extracted, unit)
    merge(byBucket, bucketed.byBucket)
    merge(byModel, bucketed.byModel)

    for (const attempt of extracted.attempts) allAttempts.push(attempt)

    for (const [model, count] of extracted.modelRouting) {
      modelRoutingCounts.set(model, (modelRoutingCounts.get(model) ?? 0) + count)
    }
    if (extracted.firstTime !== null && (firstTime === null || extracted.firstTime < firstTime)) {
      firstTime = extracted.firstTime
    }
    if (extracted.lastTime !== null && (lastTime === null || extracted.lastTime > lastTime)) {
      lastTime = extracted.lastTime
    }
  }

  for (const sums of byBucket.values()) {
    for (const field of SUM_FIELDS) totals[field] += sums[field]
  }

  // The trend windows are computed on every request, regardless of the requested `unit`.
  // They are cheap once the logs are parsed (the expensive part — decompression and JSONL
  // parsing — is cached per file), and returning all three makes switching the window in
  // the UI instant instead of a refetch that can race.
  const now = new Date()
  const merged = { attempts: allAttempts }
  const windows = {
    day: windowSeries(merged, 'day', now),
    week: windowSeries(merged, 'week', now),
    month: windowSeries(merged, 'month', now),
  }

  // Persist whatever this run parsed, so the NEXT launch skips the decompress entirely.
  // Written after the aggregate so a failure to write cannot affect the numbers, and
  // skipped when nothing changed (all hits) to avoid rewriting a 3 MB file for no reason.
  let cacheSaved = false
  if (cacheFile != null && cacheMisses > 0) {
    cacheSaved = saveExtractCache(cacheFile, ensureDiskCache(cacheFile))
  }

  return {
    unit,
    generatedAt: Date.now(),
    sessions,
    skipped,
    attempts,
    cache: { hits: cacheHits, misses: cacheMisses, saved: cacheSaved },
    range: firstTime === null ? null : { from: firstTime, to: lastTime },
    totals,
    buckets: [...byBucket.entries()]
      .map(([key, sums]) => ({ key, ...sums }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
    models: [...byModel.entries()]
      .map(([key, sums]) => ({ key, ...sums }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    modelRoutingCounts: [...modelRoutingCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    windows,
    activity: monthActivity(merged, now),
  }
}

parentPort.on('message', (message) => {
  const { sessionsRoot, unit, refresh = false, cacheFile = null, requestId } = message ?? {}
  try {
    const payload = aggregate(sessionsRoot, unit, refresh, cacheFile)
    parentPort.postMessage({ requestId, payload })
  } catch (error) {
    parentPort.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})