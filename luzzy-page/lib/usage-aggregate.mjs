/**
 * Usage aggregation facade for the host half of LuzzyPage.
 *
 * The heavy work runs in a worker thread (see usage-worker.mjs + usage-core.mjs). The
 * main thread never blocks on it — this is a crash contract, not a performance nicety.
 *
 * CRITICAL — why the work MUST run off the host's main thread:
 *
 * The Desktop host process runs a profile admission channel whose RPC calls time out
 * after 30 s (HostRpc, timeoutMs = 3e4). A full pass over all session logs is ~20 s of
 * synchronous zstd inflation + JSONL parsing. An earlier version ran that pass on the
 * main thread — first from a startup warmup, then in "cooperative" setImmediate chunks —
 * and BOTH crashed host-boot, because chunked work still stalled the loop for ~6 s at a
 * time. The admission channel starved and boot failed after ~123 s, twice.
 *
 * So: the routes call `aggregateOffThread()`. A long-lived worker owns the per-file
 * extraction cache (which is also what makes unit switches cheap), the main thread holds
 * only a small result cache, and there is deliberately NO warmup at startup.
 */

import { Worker } from 'node:worker_threads'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'usage-worker.mjs')

/**
 * How long a built payload stays usable.
 *
 * Was 30 s, which is shorter than the time a user typically spends looking at the page —
 * so returning to the usage tab after reading the README paid the re-bucket cost again.
 * The re-bucket itself is only ~320 ms once the worker has parsed the logs, so this is a
 * minor cost either way; 5 minutes matches how long a "what did I use" question stays
 * relevant, and an explicit refresh (`?refresh=1`) still bypasses it.
 */
const RESULT_TTL_MS = 5 * 60_000

/**
 * Build the aggregator.
 *
 * @param {string} sessionsRoot
 * @param {string | null} cacheFile where to keep the parsed-log cache across restarts, or
 *   null to disable it (tests do this: a cache that leaked between cases would make them
 *   depend on each other, and a stale one would hide a parsing regression)
 */
export function createUsageAggregator(sessionsRoot, cacheFile = null) {
  /** @type {Worker | null} lazily started, reused for every call */
  let worker = null
  let workerStopped = false
  let requestId = 0
  /** @type {Map<number, {resolve: (v: object) => void, reject: (e: Error) => void}>} */
  const pending = new Map()

  /** @type {Map<string, {builtAt: number, payload: object}>} */
  const resultCache = new Map()
  /**
   * In-flight calls keyed by unit, so concurrent requests for the SAME unit share one
   * worker run while requests for DIFFERENT units each get their own answer.
   *
   * This was a single unkeyed slot before, despite a comment claiming otherwise: loading
   * `day` and then switching to `hour` before the first call settled returned the `day`
   * payload for the `hour` request — the chart was then rendered with the wrong unit and
   * mislabelled buckets, silently.
   *
   * @type {Map<string, Promise<object>>}
   */
  const inflight = new Map()

  /** Warmup bookkeeping, surfaced so diagnostics can tell "warmed" from "not yet". */
  let warmupStartedAt = 0
  let warmupMs = null
  /** @type {string | null} */
  let warmupFailed = null

  function ensureWorker() {
    if (worker !== null) return worker
    worker = new Worker(new URL('./usage-worker.mjs', import.meta.url))
    worker.unref()
    worker.on('message', (message) => {
      const waiter = pending.get(message?.requestId)
      if (waiter === undefined) return
      pending.delete(message.requestId)
      if (message.error !== undefined) waiter.reject(new Error(message.error))
      else waiter.resolve(message.payload)
    })
    worker.on('error', (error) => {
      // Fail every waiter; a later call starts a fresh worker.
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
      worker = null
    })
    worker.on('exit', () => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error('usage worker exited before replying'))
      }
      pending.clear()
    })
    return worker
  }

  /**
   * Aggregate off the main thread. Cold calls take as long as they take (the page shows a
   * loading state); warm calls return from the result cache without touching the worker.
   *
   * @param {'hour'|'day'|'week'|'month'} unit
   * @param {boolean} refresh ignore the result cache
   * @returns {Promise<object>}
   */
  function aggregateOffThread(unit, refresh = false) {
    if (!refresh) {
      const cached = resultCache.get(unit)
      if (cached !== undefined && Date.now() - cached.builtAt < RESULT_TTL_MS) {
        return Promise.resolve(cached.payload)
      }
    }

    // The same unit is already running: await that run instead of racing a second one.
    // This also covers a warmup pass, so opening the page during warmup joins it rather
    // than queueing a duplicate read of the same logs.
    // A DIFFERENT unit must NOT be answered from here — see the `inflight` comment.
    const running = inflight.get(unit)
    if (running !== undefined) return running

    const call = new Promise((resolve, reject) => {
      const id = ++requestId
      try {
        ensureWorker().postMessage({ sessionsRoot, unit, refresh, cacheFile, requestId: id })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      pending.set(id, {
        resolve: (payload) => {
          resultCache.set(unit, { builtAt: Date.now(), payload })
          resolve(payload)
        },
        reject,
      })
    })

    inflight.set(unit, call)
    return call.finally(() => {
      if (inflight.get(unit) === call) inflight.delete(unit)
    })
  }

  /**
   * Read the logs ahead of time, so the first visit to the usage page is instant.
   *
   * The cold pass is ~20 s of decompression and JSONL parsing, and the page currently pays
   * that while the user stares at a skeleton. Warming it up in advance removes the wait
   * entirely.
   *
   * TWO things make this safe, and both are why an earlier warmup crashed the app:
   *
   *   1. The work runs in the WORKER, never on the host's main thread. The old warmup did a
   *      synchronous pass on the main thread, starved the 30 s profile admission channel,
   *      and failed `host-boot`. Here the main thread only posts a message.
   *   2. It is DEFERRED well past startup, so it does not compete with boot at all.
   *
   * Failure is swallowed: a warmup that cannot run must never affect the app, and the page
   * still works by paying the cold cost on first request.
   *
   * @param {{delayMs?: number, unit?: 'hour'|'day'|'week'|'month'}} [options]
   * @returns {() => void} cancel
   */
  function warm({ delayMs = 15_000, unit = 'day' } = {}) {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      // Only warm if nothing has asked for data yet — a real request always wins.
      if (inflight.has(unit)) return
      const cached = resultCache.get(unit)
      if (cached !== undefined && Date.now() - cached.builtAt < RESULT_TTL_MS) return

      warmupStartedAt = Date.now()
      aggregateOffThread(unit, false)
        .then(() => {
          warmupMs = Date.now() - warmupStartedAt
          warmupFailed = null
        })
        .catch((error) => {
          warmupFailed = error instanceof Error ? error.message : String(error)
        })
    }, delayMs)
    // Do not hold the event loop open for a warmup.
    if (typeof timer.unref === 'function') timer.unref()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }

  /**
   * Stop the worker. Called through ctx.effect, so plugin unload releases the thread.
   */
  function stop() {
    workerStopped = true
    if (worker !== null) {
      const current = worker
      worker = null
      for (const waiter of pending.values()) {
        waiter.reject(new Error('luzzy usage aggregator stopped'))
      }
      pending.clear()
      current.terminate()
    }
  }

  return {
    aggregateOffThread,
    warm,
    stop,
    get workerAlive() { return worker !== null && !workerStopped },
    /** Warmup state, for diagnostics: null until it finishes, then how long it took. */
    get warmup() {
      return { startedAt: warmupStartedAt || null, ms: warmupMs, failed: warmupFailed }
    },
  }
}