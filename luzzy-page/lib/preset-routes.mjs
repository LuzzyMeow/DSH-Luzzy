/**
 * Web routes for the LuzzyPage 「预设」 sub-page.
 *
 * Two routes, both same-origin and loopback-only, matching how the rest of this plugin
 * talks to the frame: the iframe is a plain document with no session context, so
 * everything it renders is fetched from here.
 *
 *   GET  /__luzzy/preset?sessionId=<id>   → the whole snapshot
 *   POST /__luzzy/preset                  → one mutation, then the whole snapshot back
 *
 * WHY THE POST ANSWERS WITH THE SNAPSHOT
 *
 * Every mutation changes the roster, the revision, or the resolved prompt — usually more
 * than one. Returning the full next state means the page never has to re-fetch and never
 * paints a combination that never existed on disk. A `409` carries the same snapshot for
 * the same reason: the losing writer's next move is to show the current truth, not to
 * guess at it.
 *
 * `isLocalCaller` is re-implemented here rather than imported from `lib/index.js`. That
 * file's `apply()` is the colleague-facing host half and this feature deliberately adds
 * to it without editing it; one shared helper would have meant restructuring it. The
 * logic is four lines and a constant, and the desktop renderer is loopback by
 * construction — but note the deliberate fail-OPEN on an unreadable address, which is
 * this plugin's existing behaviour and is mirrored here rather than changed.
 *
 * @module dsh-luzzy-page/preset-routes
 */

import { LUZZY_PRESET_ID, applyMutation, createLuzzySession, readSnapshot, resolveWorkspaceForSession, switchSessionPreset } from './preset-ops.mjs'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MAX_BODY_BYTES = 2 * 1024 * 1024

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
 * Read and parse a JSON body, with a hard size cap.
 *
 * The cap is enforced as the stream arrives, but an oversized request is DRAINED rather
 * than destroyed. Destroying the socket mid-upload gives the client an ECONNRESET with no
 * response, so the page would see a network error instead of the 413 that says what went
 * wrong — and `req.destroy()` after resolving also trips a libuv assertion at exit when the
 * peer is still writing. So: stop buffering past the cap, keep consuming, and answer at
 * `end` with the real reason. Memory stays bounded at roughly the cap plus one chunk.
 *
 * @returns {Promise<{ok: true, body: unknown} | {ok: false, status: number, error: string}>}
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

/**
 * The `GET` handler: one snapshot, no side effects.
 *
 * `sessionId` is read from the query because the frame cannot know it on its own — see
 * `preset-ops.readSessionFacts`. Omitting it is legal and yields `session: null`, which the
 * page renders as "会话信息不可用" rather than as a session that cannot switch.
 */
async function handleGet(ctx, req, res) {
  if (!isLocalCaller(req)) {
    sendJson(res, 403, { error: 'luzzy preset is local-only' })
    return
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'preset 读取需要 GET' })
    return
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    sendJson(res, 200, readSnapshot(ctx, { sessionId }))
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The `POST` handler: mutations plus the two session actions.
 *
 * `switchSession` and `newSession` are async and go through DSH services; everything else
 * is a synchronous store edit. Both kinds answer with a fresh snapshot so the page has one
 * code path for "after an action".
 */
async function handlePost(ctx, req, res) {
  if (!isLocalCaller(req)) {
    sendJson(res, 403, { error: 'luzzy preset is local-only' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'preset 写入需要 POST' })
    return
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.error })
    return
  }

  const body = typeof parsed.body === 'object' && parsed.body !== null ? parsed.body : {}
  const op = typeof body.op === 'string' ? body.op : ''

  try {
    if (op === 'switchSession') {
      const result = await switchSessionPreset(ctx, body.sessionId)
      if (!result.ok) {
        // 422: the request was well-formed and understood, and the deployment refused it.
        // That is the honest status for "this session has already produced content".
        sendJson(res, 422, { error: result.error, snapshot: readSnapshot(ctx, { sessionId: body.sessionId }) })
        return
      }
      sendJson(res, 200, { ...readSnapshot(ctx, { sessionId: body.sessionId }), applied: { op, preset: result.preset } })
      return
    }

    if (op === 'resolveWorkspace') {
      // The client half needs the workspace id to create a session that is actually VISIBLE.
      // It cannot derive one: a workspace id is not on a session, only the directory is, and
      // the directory must be canonicalized against the registry to match.
      const resolved = await resolveWorkspaceForSession(ctx, body.sessionId)
      sendJson(res, 200, {
        workspaceId: resolved.workspaceId,
        cwd: resolved.cwd,
        reason: resolved.reason,
        preset: LUZZY_PRESET_ID,
      })
      return
    }

    if (op === 'newSession') {
      const result = await createLuzzySession(ctx, body.sessionId)
      if (!result.ok) {
        sendJson(res, 422, { error: result.error, snapshot: readSnapshot(ctx, { sessionId: body.sessionId ?? null }) })
        return
      }
      sendJson(res, 200, {
        ...readSnapshot(ctx, { sessionId: result.sessionId }),
        applied: {
          op,
          sessionId: result.sessionId,
          preset: result.preset,
          // The page must know whether the new session actually entered a workspace: one that
          // did not will not appear in the sidebar, and telling the user to look for it there
          // would send them hunting for something that is not present.
          workspace: result.attachedWorkspace,
          workspaceLookupFailed: result.workspaceLookupFailed,
        },
      })
      return
    }

    const result = applyMutation(ctx, body)
    sendJson(res, result.status, result.body)
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Register both routes.
 *
 * Called from the plugin's `apply()` through `ctx.effect`, so unloading removes them
 * rather than leaving a handler pointing at a dead context.
 *
 * @param {object} ctx - host context carrying `webServer`.
 */
export function registerPresetRoutes(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/__luzzy/preset',
        handler: (req, res) => (req.method === 'POST' ? handlePost(ctx, req, res) : handleGet(ctx, req, res)),
      }),
    'luzzy-page: preset route',
  )
}
