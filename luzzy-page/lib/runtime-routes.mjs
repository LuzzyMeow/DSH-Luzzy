/**
 * Read-only runtime facts for the 「执行状态」 and 「系统信息」 pages.
 *
 *   GET /__luzzy/runtime?sessionId=<id>   → turn, tool calls, lifecycle, context, elapsed
 *
 * WHY THIS ROUTE EXISTS
 *
 * The goal snapshot carries the PLAN (acceptance, tasks, evidence) but nothing about what the
 * agent is DOING: which turn it is on, which tools it called, how long it has been running.
 * Those live in the session log as `turn/start`, `turn/end`, `step/start`, `step/end`,
 * `tool/call`, `tool/result`, `request/context`, `compaction/*` — all verified present by
 * `tools/probe-runtime-events.mjs` against this machine's real logs (4618 `tool/call` in a
 * 10-log sample). Nothing is invented here; every field comes from an event that exists.
 *
 * WHY IT IS READ-ONLY AND SEPARATE FROM `/__luzzy/goal`
 *
 * The goal route is a WRITE surface with a compare-and-set policy. Mixing reads of raw log
 * events into it would put a second, much cheaper read path behind a route whose contract is
 * "one mutation, then the whole state back". A separate read-only route keeps the write path
 * single, and keeps this one safe to poll.
 *
 * IT NEVER WRITES THE LOGS. It opens them for reading only, and a log it cannot read is
 * counted as skipped rather than guessed at — same policy as the usage aggregator.
 *
 * @module dsh-luzzy-page/runtime-routes
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decompressBuffer } from './usage-core.mjs'
import { service } from './goal-enforce.mjs'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const SESSION_ID_PATTERN = /^session-[0-9a-fA-F-]{8,}$/

/** How many of the most recently modified logs to read. Enough to cover the live session. */
const MAX_LOGS = 40

/**
 * The context files worth reporting on the 「执行状态」 page.
 *
 * Detection requires TWO conditions together, because one alone produces false positives:
 *   1. the call is a READ-shaped tool (its name starts with read/glob/grep/list…), and
 *   2. the file's name appears in that call's arguments.
 *
 * Condition 1 is not optional. Matching on the arguments alone reported every rule file as
 * "loaded" on this machine, because those names also appear in file CONTENT passed to
 * `write`/`edit` — a document that merely mentions CLAUDE.md is not a session that read it.
 * Verified against the real logs: with the tool filter, only genuinely read files survive.
 */
const RULE_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', '.cursorrules'])
const READ_TOOL = /^(read|glob|grep|list_|ls$|cat$|search|find)/i

function isLocalCaller(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return true
  return LOOPBACK_ADDRESSES.has(address)
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** Collect *.jsonl.zstd under a root, newest mtime first. */
function collectLogs(root, limit) {
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

  const withTime = []
  for (const path of found) {
    try {
      withTime.push({ path, mtimeMs: statSync(path).mtimeMs })
    } catch {
      // A log that vanished between listing and stat is simply not ours to read.
    }
  }
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withTime.slice(0, limit).map((entry) => entry.path)
}

/**
 * Read ONE session log and derive the runtime facts.
 *
 * Every counter is derived from events that were observed; nothing is interpolated.
 * A log that will not inflate is reported as unreadable rather than as zero activity —
 * "I could not read it" and "nothing happened" must never look the same.
 *
 * @param {string} path absolute log path
 * @returns {object|null} the facts, or null when the log cannot be read
 */
export function readRuntimeFromLog(path) {
  let text
  try {
    text = decompressBuffer(readFileSync(path))
  } catch {
    return null
  }

  let openedAt = null
  let endedAt = null
  let currentTurn = 0
  let turnsCompleted = 0
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  let compactions = 0
  let goalChanges = 0
  let lastToolAt = null
  let context = null
  let preset = null
  let sandbox = null
  let approval = null

  /** Tool name → count, and the most recent calls in order. */
  const toolCounts = new Map()
  const recentCalls = []
  /** Context files this session actually referenced in a tool argument. */
  const ruleFiles = new Set()
  /** Turn boundaries, for elapsed time. */
  const turnSpans = []

  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event.data ?? {}
    const at = typeof event.time === 'number' ? event.time : null
    if (at !== null) {
      if (openedAt === null || at < openedAt) openedAt = at
      if (endedAt === null || at > endedAt) endedAt = at
    }

    switch (event.type) {
      case 'session':
        if (typeof event.agentPreset === 'string') preset = event.agentPreset
        break
      case 'turn/start':
        currentTurn = Math.max(currentTurn, Number(data.turn) || 0)
        turnSpans.push({ turn: Number(data.turn) || 0, start: at, end: null })
        break
      case 'turn/end': {
        turnsCompleted += 1
        const span = turnSpans[turnSpans.length - 1]
        if (span !== undefined && span.end === null) span.end = at
        break
      }
      case 'step/start':
        steps += 1
        break
      case 'tool/call': {
        toolCalls += 1
        lastToolAt = at
        const name = typeof data.name === 'string' ? data.name : '未知工具'
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
        // Which context files this session actually pulled in. Requires BOTH a read-shaped
        // tool AND the name in that call's arguments — see the note on RULE_FILES for why
        // the argument match alone over-reports.
        const args = typeof data.arguments === 'string' ? data.arguments : ''
        if (args !== '' && READ_TOOL.test(name)) {
          for (const candidate of RULE_FILES) {
            if (ruleFiles.has(candidate) || !args.includes(candidate)) continue
            ruleFiles.add(candidate)
          }
        }
        // Keep a bounded tail: the page shows recent activity, not a full transcript.
        recentCalls.push({ at, name, turn: Number(data.turn) || 0, step: Number(data.step) || 0, ok: null })
        if (recentCalls.length > 40) recentCalls.shift()
        break
      }
      case 'tool/result': {
        // A tool result carries an `error` field when the call failed.
        if (data.error !== undefined && data.error !== null) toolErrors += 1
        const call = recentCalls[recentCalls.length - 1]
        if (call !== undefined && call.ok === null) call.ok = data.error === undefined || data.error === null
        break
      }
      case 'request/context':
        context = {
          provider: typeof data.provider === 'string' ? data.provider : '',
          model: typeof data.model === 'string' ? data.model : '',
          contextWindow: typeof data.contextWindow === 'number' ? data.contextWindow : null,
        }
        break
      case 'compaction/start':
        compactions += 1
        break
      case 'goal/change':
        goalChanges += 1
        break
      case 'sandbox/mode':
        if (typeof data.mode === 'string') sandbox = data.mode
        break
      case 'approval/policy':
        if (typeof data.policy === 'string') approval = data.policy
        break
      default:
        break
    }
  }

  // Elapsed time is the sum of COMPLETED turn spans plus the open one, not the wall-clock
  // width of the log: a session left open overnight would otherwise report eight hours of
  // work. Only spans with a start contribute.
  let elapsedMs = 0
  for (const span of turnSpans) {
    if (span.start === null) continue
    const end = span.end === null ? endedAt : span.end
    if (end === null || end < span.start) continue
    elapsedMs += end - span.start
  }

  const toolList = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  return {
    openedAt,
    endedAt,
    currentTurn,
    turnsCompleted,
    steps,
    toolCalls,
    toolErrors,
    toolList,
    recentCalls: recentCalls.slice(-20).reverse(),
    ruleFiles: [...ruleFiles],
    compactions,
    goalChanges,
    context,
    preset,
    sandbox,
    approval,
    elapsedMs,
    lastToolAt,
  }
}

/**
 * Build the whole payload.
 *
 * `sessionId` selects the log; without one, the newest log is used — the frame cannot always
 * learn its own session id (it is an `about:srcdoc` document), and showing the most recent
 * activity beats showing nothing. `sessionId` present but unreadable is reported as such.
 */
export function buildRuntimeSnapshot(deps, sessionId) {
  const { home, pluginVersion } = deps
  const sessionsRoot = join(home, 'sessions')

  const requested = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
  if (requested !== null && !SESSION_ID_PATTERN.test(requested)) {
    return {
      ok: false,
      reason: 'invalid-session-id',
      message: '会话 id 不合法。',
      version: pluginVersion,
    }
  }

  const logs = collectLogs(sessionsRoot, MAX_LOGS)

  // Which log belongs to the requested session? The file path carries the session id.
  let chosen = null
  if (requested !== null) {
    chosen = logs.find((path) => path.includes(requested)) ?? null
    if (chosen === null) {
      return {
        ok: false,
        reason: 'session-log-missing',
        message: '找不到这个会话的日志。它可能还没有产生任何活动，或者日志已被清理。',
        sessionId: requested,
        version: pluginVersion,
      }
    }
  } else {
    // No session asked for: take the newest log that actually reads.
    for (const path of logs) {
      const probe = readRuntimeFromLog(path)
      if (probe !== null) { chosen = path; break }
    }
    if (chosen === null) {
      return {
        ok: false,
        reason: 'no-logs',
        message: logs.length === 0
          ? '本机还没有会话日志。'
          : '本机的会话日志都读不出来（可能正在写入或已损坏）。',
        version: pluginVersion,
      }
    }
  }

  const facts = readRuntimeFromLog(chosen)
  if (facts === null) {
    return {
      ok: false,
      reason: 'log-unreadable',
      message: '这个会话的日志读不出来（可能正在写入，或压缩帧已损坏）。',
      sessionId: requested,
      version: pluginVersion,
    }
  }

  // The session id is recoverable from a `session` event; fall back to the requested one.
  const sessionMatch = /session-[0-9a-fA-F-]{8,}/.exec(chosen)
  const resolvedSessionId = sessionMatch !== null ? sessionMatch[0] : requested

  return {
    ok: true,
    sessionId: resolvedSessionId,
    source: requested === null ? 'latest' : 'session',
    scanned: logs.length,
    version: pluginVersion,
    ...facts,
  }
}

/**
 * Register the route. Called from `apply()` through `ctx.effect`, so unloading removes it.
 */
export function registerRuntimeRoutes(ctx, deps) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/__luzzy/runtime',
        handler: (req, res) => {
          if (!isLocalCaller(req)) {
            sendJson(res, 403, { error: 'luzzy runtime is local-only' })
            return
          }
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: '执行状态读取需要 GET' })
            return
          }
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const snapshot = buildRuntimeSnapshot(deps, url.searchParams.get('sessionId'))
            // A snapshot that could not be built still answers 200 with `ok:false`: this is a
            // read-only diagnostic route, and the page must be able to tell "no data" apart
            // from "route broken". Non-2xx would collapse the two.
            sendJson(res, 200, snapshot)
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'luzzy-page: runtime route',
  )
}

export { service }
