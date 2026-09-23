/**
 * Web routes for the LuzzyPage 「目标」 sub-page.
 *
 *   GET  /__luzzy/goal?sessionId=<id>   → the whole picture: runtime goal + plan + artifact
 *   POST /__luzzy/goal                  → one mutation, then the whole picture back
 *
 * WHY THIS ROUTE IS THE ONLY PLACE THAT TOUCHES THE WORKSPACE
 *
 * The `goal.md` projection writes into the user's project directory. That is a real side
 * effect on someone's repository, so it is opt-in per session and this file is the only
 * place that can turn it on. The cwd it writes to always comes from the SESSION HEADER —
 * never from the request body. A path supplied by a caller would let a renderer write a
 * file anywhere on disk, which is not a power a renderer should have.
 *
 * WHY THE POST ANSWERS WITH THE WHOLE PICTURE
 *
 * Every mutation changes the plan, its revision, or both — and a mutation is exactly when
 * the client's copy becomes untrustworthy. Returning the full next state means the page
 * never paints a combination that never existed on disk, and a 409 can carry the same
 * snapshot so the losing writer's next move is to show the truth rather than guess at it.
 * Same policy as `preset-routes.mjs`, for the same reason.
 *
 * @module dsh-luzzy-page/goal-routes
 */

import {
  DELIVERY_VERSION,
  ERROR_CODES,
  HEALTH_LABELS,
  HUMAN_OPS,
  applyDeliveryOp,
  applyHumanOp,
  detectDrift,
  emptyDelivery,
  integrity,
  nextId,
  renderGoalMarkdown,
  summarize,
} from './goal-domain.mjs'
import { ARTIFACT_RELATIVE_PATH, readArtifact, readArtifactFlags, readDeliveryOverlay, removeDeliveryOverlay, sessionIdProblem, writeArtifact, writeArtifactFlag, writeDeliveryOverlay } from './goal-store.mjs'
import { DELIVERY_TOOL, agentsWithGoals, liveGoalFor, readCounters, service } from './goal-enforce.mjs'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MAX_BODY_BYTES = 512 * 1024

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

/**
 * Read one JSON body with a hard cap.
 *
 * An oversized request is DRAINED rather than destroyed — destroying the socket mid-upload
 * gives the client an ECONNRESET with no response, so the page would see a network error
 * instead of the 413 that says what went wrong. Same reasoning as `preset-routes.mjs`.
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflowed = false

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (overflowed) {
        resolve({ ok: false, status: 413, error: `请求体过大（上限 ${MAX_BODY_BYTES} 字节）` })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({ ok: true, body: {} })
        return
      }
      try {
        resolve({ ok: true, body: JSON.parse(raw) })
      } catch (error) {
        resolve({ ok: false, status: 400, error: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}` })
      }
    })

    req.on('error', (error) => {
      resolve({ ok: false, status: 400, error: `请求体读取失败：${error instanceof Error ? error.message : String(error)}` })
    })
  })
}

/** The session header's cwd, or null. The ONE source of a workspace path. */
function cwdOf(ctx, sessionId) {
  const sessions = service(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.get !== 'function' || typeof sessionId !== 'string') return null
  try {
    const session = sessions.get(sessionId)
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : null
  } catch {
    return null
  }
}

/**
 * Resolve which goal the page is looking at.
 *
 * Two modes, both explicit:
 *   * `sessionId` given → that session's goal, when it is loaded. When it is NOT loaded the
 *     page is still shown, with the plan and an honest "the runtime goal is unavailable in
 *     this process" — the alternative is to blank the page, which would tell the user their
 *     plan is gone when it is not.
 *   * no `sessionId` → the newest session that actually has a goal. The frame cannot always
 *     learn its session id (it is an `about:srcdoc` document), so this is the fallback that
 *     keeps the page useful in that case rather than showing nothing.
 *
 * @returns {{sessionId: string|null, agent: object|undefined, goal: object|null, goalState: string, goalReason?: string, candidates: Array}}
 */
function resolveTarget(ctx, sessionId) {
  const requested = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
  if (requested !== null) {
    if (sessionIdProblem(requested) !== undefined) {
      return { sessionId: null, agent: undefined, goal: null, goalState: 'invalid', goalReason: '会话 id 含非法字符', candidates: [] }
    }
    const agents = service(ctx, 'agents')
    let agent
    try {
      agent = agents?.get?.(requested)
    } catch {
      agent = undefined
    }
    if (agent === undefined) {
      return { sessionId: requested, agent: undefined, goal: null, goalState: 'unavailable', goalReason: '这个会话不在当前进程里（DSH 重启后需要先打开它）', candidates: [] }
    }
    const resolved = liveGoalFor(ctx, agent)
    return {
      sessionId: requested,
      agent,
      goal: resolved.state === 'ok' ? resolved.goal ?? null : null,
      goalState: resolved.state,
      ...(resolved.state === 'ok' ? {} : { goalReason: resolved.reason }),
      candidates: [],
    }
  }

  const withGoals = agentsWithGoals(ctx)
  if (withGoals.length > 0) {
    // `agents.list()` is registration order, so the LAST entry is the newest.
    const picked = withGoals[withGoals.length - 1]
    return {
      sessionId: picked.agent.session?.id ?? null,
      agent: picked.agent,
      goal: picked.goal,
      goalState: 'ok',
      candidates: withGoals.map((entry) => ({
        sessionId: entry.agent.session?.id ?? '',
        objective: entry.goal.objective,
        phase: entry.goal.phase,
        revision: entry.goal.revision,
      })),
    }
  }

  const goalsService = service(ctx, 'goals')
  return {
    sessionId: null,
    agent: undefined,
    goal: null,
    goalState: goalsService === undefined ? 'unavailable' : 'empty',
    ...(goalsService === undefined ? { goalReason: '这个部署没有挂载 goal 服务（@deepseek-ai/dsh-goal）' } : {}),
    candidates: [],
  }
}

/**
 * Build the whole payload the page renders.
 *
 * Assembled as ONE response on purpose: the page shows a consistent picture — the runtime
 * goal, the plan, its integrity, the artifact's state on disk and the available
 * capabilities — and splitting it into several routes would let it paint a half-updated
 * state that never existed anywhere.
 *
 * @param {object} deps - `{ctx, paths, artifact, enforcement, toolRegistered, sessionId}`.
 * @returns {object} the JSON body.
 */
export function buildGoalSnapshot(deps) {
  const { ctx, paths, sessionId } = deps
  const target = resolveTarget(ctx, sessionId)
  // Only ever a VALIDATED session id. `resolveTarget` reports the requested string back when
  // nothing owns a goal, and that string has not been through `sessionIdProblem` — carrying
  // it further would put an unvalidated value into the response and, on a write, into a path.
  const effectiveSessionId = target.sessionId !== null
    ? target.sessionId
    : (typeof sessionId === 'string' && sessionId !== '' && sessionIdProblem(sessionId) === undefined ? sessionId : null)

  const base = {
    version: DELIVERY_VERSION,
    sessionId: effectiveSessionId,
    goal: target.goal,
    goalState: target.goalState,
    ...(target.goalReason === undefined ? {} : { goalReason: target.goalReason }),
    candidates: target.candidates,
    capabilities: {
      goalService: target.goalState !== 'unavailable',
      agents: service(ctx, 'agents') !== undefined,
      sessions: service(ctx, 'sessions') !== undefined,
      tools: deps.toolRegistered === true,
      artifact: target.goalState === 'ok',
    },
    artifactPath: ARTIFACT_RELATIVE_PATH,
    healthLabels: HEALTH_LABELS,
    toolName: DELIVERY_TOOL,
  }

  if (effectiveSessionId === null) {
    // Nothing to read. This is the "no goal anywhere" state, and it is normal — it is what
    // a first visit looks like before any long task has been started.
    const empty = emptyDelivery('')
    return {
      ...base,
      delivery: empty,
      warnings: [],
      summary: summarize(empty, null),
      integrity: { valid: false, errors: [{ code: ERROR_CODES.NOT_FOUND, target: 'goal', detail: '当前没有目标' }], warnings: [] },
      drift: null,
      artifact: { enabled: false, exists: false, path: null, bytes: 0, mtime: null, stale: false, cwd: null },
      enforcement: deps.enforcement?.stats?.() ?? null,
      counters: readCounters(effectiveSessionId),
    }
  }

  const read = readDeliveryOverlay(paths, effectiveSessionId)
  if (!read.ok) {
    return { ...base, delivery: null, warnings: [], readError: { code: read.code, reason: read.reason, source: read.source } }
  }

  const delivery = read.delivery
  const warnings = [...read.warnings]
  const structure = integrity(delivery, target.goal)
  const drift = detectDrift(delivery, target.goal)
  const cwd = cwdOf(ctx, effectiveSessionId)
  const flags = readArtifactFlags(paths)
  const enabled = flags.sessions[effectiveSessionId] !== undefined
  const onDisk = readArtifact(cwd)

  // Is the file stale? Compare against a render of the CURRENT state with the file's own
  // mtime as the timestamp — so the check answers "would a projection have changed the
  // bytes", not "was it written in the last five minutes". Reported, because a stale
  // artifact is the one failure the raw view exists to expose.
  let stale = false
  if (onDisk.exists) {
    const expected = renderGoalMarkdown(delivery, target.goal, { generatedAt: onDisk.mtime ?? 0, artifactPath: ARTIFACT_RELATIVE_PATH })
    stale = expected !== onDisk.text
  }

  return {
    ...base,
    delivery,
    warnings,
    readSource: read.source,
    summary: summarize(delivery, target.goal),
    integrity: structure,
    drift,
    artifact: {
      enabled,
      cwd,
      exists: onDisk.exists,
      path: onDisk.path,
      bytes: onDisk.bytes,
      mtime: onDisk.mtime,
      stale,
      // The text is only sent when the raw view is actually showing, which the caller
      // signals — otherwise a 40 KB document rode along on every poll.
      text: deps.includeArtifact ? onDisk.text : null,
    },
    enforcement: deps.enforcement?.stats?.() ?? null,
    counters: readCounters(effectiveSessionId),
  }
}

/**
 * `GET` — one snapshot, no side effects other than the optional projection refresh.
 */
async function handleGet(ctx, req, res, deps) {
  if (!isLocalCaller(req)) {
    sendJson(res, 403, { error: 'luzzy goal is local-only' })
    return
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: '目标读取需要 GET' })
    return
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    const includeArtifact = url.searchParams.get('artifact') === '1'
    const snapshot = buildGoalSnapshot({ ...deps, ctx, sessionId, includeArtifact })

    // Refresh the projection when it is enabled and the page asked for it. A GET that
    // writes by default would be a surprise; `artifact=1` is the page explicitly asking.
    if (includeArtifact && snapshot.artifact.enabled && snapshot.artifact.cwd !== null && snapshot.delivery !== null) {
      const written = writeArtifact(snapshot.artifact.cwd, snapshot.delivery, snapshot.goal, Date.now())
      if (written.ok) {
        snapshot.artifact.exists = true
        snapshot.artifact.bytes = written.bytes
        snapshot.artifact.stale = false
        snapshot.artifact.refreshed = written.changed
        if (includeArtifact) {
          const onDisk = readArtifact(snapshot.artifact.cwd)
          snapshot.artifact.text = onDisk.text
          snapshot.artifact.mtime = onDisk.mtime
        }
      } else {
        snapshot.artifact.writeError = written.reason
      }
    }
    sendJson(res, 200, snapshot)
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * `POST` — one mutation, then the whole picture back.
 *
 * The op set splits in two, and the split is the security boundary:
 *   * `HUMAN_OPS` — reachable ONLY here, from the loopback-only page route.
 *   * the agent ops — reachable here too (the page is a user surface and a user may edit
 *     the plan directly), but ALSO from the `goal_delivery` tool.
 *
 * Both paths converge on the same compare-and-set write, so a page edit and a model edit
 * cannot both win.
 */
async function handlePost(ctx, req, res, deps) {
  if (!isLocalCaller(req)) {
    sendJson(res, 403, { error: 'luzzy goal is local-only' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '目标写入需要 POST' })
    return
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.error })
    return
  }

  const body = typeof parsed.body === 'object' && parsed.body !== null ? parsed.body : {}
  const op = typeof body.op === 'string' ? body.op : ''
  const snapshotOf = () => buildGoalSnapshot({ ...deps, ctx, sessionId: body.sessionId, includeArtifact: body.artifact === true })

  try {
    // ---- artifact opt-in / opt-out
    if (op === 'enableArtifact' || op === 'disableArtifact') {
      const target = resolveTarget(ctx, body.sessionId)
      const sessionId = target.sessionId
      if (sessionId === null) {
        sendJson(res, 422, { error: '没有可用的会话，无法确定 goal.md 的落点', snapshot: snapshotOf() })
        return
      }
      const cwd = cwdOf(ctx, sessionId)
      if (op === 'enableArtifact' && cwd === null) {
        sendJson(res, 422, { error: '这个会话没有工作目录，无法确定 goal.md 的落点', snapshot: snapshotOf() })
        return
      }
      const written = writeArtifactFlag(deps.paths, sessionId, op === 'enableArtifact', cwd)
      if (!written.ok) {
        sendJson(res, 500, { error: '写入目标页设置失败，请确认 DSH home 可写', snapshot: snapshotOf() })
        return
      }
      sendJson(res, 200, { ...snapshotOf(), applied: { op, enabled: written.enabled } })
      return
    }

    // ---- clear the whole plan (destructive; the page confirms first)
    if (op === 'clear') {
      const target = resolveTarget(ctx, body.sessionId)
      const sessionId = target.sessionId
      if (sessionId === null) {
        sendJson(res, 422, { error: '没有可用的会话', snapshot: snapshotOf() })
        return
      }
      const removed = removeDeliveryOverlay(deps.paths, sessionId)
      sendJson(res, 200, { ...snapshotOf(), applied: { op, removed: removed.removed } })
      return
    }

    // ---- projection refresh
    if (op === 'writeArtifact') {
      const target = resolveTarget(ctx, body.sessionId)
      const sessionId = target.sessionId
      if (sessionId === null) {
        sendJson(res, 422, { error: '没有可用的会话', snapshot: snapshotOf() })
        return
      }
      const read = readDeliveryOverlay(deps.paths, sessionId)
      if (!read.ok) {
        sendJson(res, 409, { error: read.reason, code: read.code, snapshot: snapshotOf() })
        return
      }
      const cwd = cwdOf(ctx, sessionId)
      const written = writeArtifact(cwd, read.delivery, target.goal, Date.now())
      if (!written.ok) {
        sendJson(res, 422, { error: `goal.md 写入失败：${written.reason}`, snapshot: snapshotOf() })
        return
      }
      sendJson(res, 200, { ...snapshotOf(), applied: { op, path: written.path, bytes: written.bytes, changed: written.changed } })
      return
    }

    // ---- plan mutations
    const target = resolveTarget(ctx, body.sessionId)
    const sessionId = target.sessionId
    if (sessionId === null) {
      sendJson(res, 422, { error: '没有可用的会话可以写入', snapshot: snapshotOf() })
      return
    }

    const read = readDeliveryOverlay(deps.paths, sessionId)
    if (!read.ok) {
      sendJson(res, 409, { error: read.reason, code: read.code, snapshot: snapshotOf() })
      return
    }

    const context = { at: Date.now(), changeId: nextId('C', read.delivery.changes) }
    const result = HUMAN_OPS.includes(op)
      ? applyHumanOp(read.delivery, op, body.payload ?? {}, context)
      : deps.applyAgentOp(read.delivery, op, body.payload ?? {}, context)

    if (result.error !== undefined && result.delivery === undefined) {
      // `unknown op` is a client bug, not a user error: 400 makes that visible instead of
      // silently doing nothing.
      const status = result.code === ERROR_CODES.INVALID_STATE && /^未知操作/.test(result.error) ? 400 : 422
      sendJson(res, status, { error: result.error, code: result.code, snapshot: snapshotOf() })
      return
    }

    const written = writeDeliveryOverlay(deps.paths, sessionId, result.delivery, read.delivery.revision)
    if (!written.ok) {
      // 409 with the current snapshot: the loser of a race shows the real state.
      sendJson(res, 409, { error: written.reason, code: written.code, snapshot: snapshotOf() })
      return
    }

    if (result.error !== undefined) {
      // A refusal that still recorded a proposal. 422 with the proposal named, so the page
      // can show the user "the agent asked for this".
      sendJson(res, 422, { error: result.error, code: result.code, proposal: result.proposal, snapshot: snapshotOf() })
      return
    }

    sendJson(res, 200, { ...snapshotOf(), applied: { op, created: result.created ?? null } })
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Register the route.
 *
 * Called from the plugin's `apply()` through `ctx.effect`, so unloading removes it rather
 * than leaving a handler pointing at a dead context.
 *
 * @param {object} ctx - host context.
 * @param {object} deps - `{paths, enforcement, toolRegistered, applyAgentOp}`.
 */
export function registerGoalRoutes(ctx, deps) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/__luzzy/goal',
        handler: (req, res) => (req.method === 'POST' ? handlePost(ctx, req, res, deps) : handleGet(ctx, req, res, deps)),
      }),
    'luzzy-page: goal route',
  )
}
