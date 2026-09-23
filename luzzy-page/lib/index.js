/**
 * LuzzyPage host half.
 *
 *   GET  /__luzzy/usage?unit=day[&refresh=1]   aggregated token usage over session logs
 *   GET  /__luzzy/readme                       this plugin's README.md, as text
 *   POST /__luzzy/diag                         client-side telemetry, appended to a file
 *   GET  /__luzzy/preset?sessionId=<id>        LuzzyMode preset state (see preset-routes.mjs)
 *   POST /__luzzy/preset                       preset mutations, session switch, new session
 *   GET  /__luzzy/goal?sessionId=<id>          runtime goal + delivery plan + artifact state
 *   POST /__luzzy/goal                         plan mutations, artifact projection, proposals
 *
 * The page itself is a browser-side view; these routes exist so the client never has to
 * touch the filesystem, and so usage is aggregated in exactly one place. The client only
 * renders what it is given.
 *
 * The preset routes live in their own modules (`preset-routes.mjs` / `preset-ops.mjs`) and
 * are registered by one `ctx.effect` at the end of `apply()`. They were added without
 * touching the usage or readme paths, which are edited concurrently elsewhere.
 *
 * The goal routes follow the same pattern (`goal-routes.mjs` and friends) and also register
 * from one `ctx.effect` at the end. That feature additionally installs the delivery tool and
 * two lifecycle hooks — see `goal-enforce.mjs` for why those are the shape they are.
 */

import { readFileSync, mkdirSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createUsageAggregator } from './usage-aggregate.mjs'
import { registerPresetRoutes } from './preset-routes.mjs'
import { registerGoalRoutes } from './goal-routes.mjs'
import { registerRuntimeRoutes } from './runtime-routes.mjs'
import { registerDeliveryTool } from './goal-tools.mjs'
import { installEnforcement, readPair, commitOp, service } from './goal-enforce.mjs'
import { ARTIFACT_RELATIVE_PATH, readArtifactFlags, storePaths } from './goal-store.mjs'
import * as goalDomain from './goal-domain.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UNITS = new Set(['hour', 'day', 'week', 'month'])

/**
 * The plugin's own version, read from package.json.
 *
 * Read from the file rather than hard-coded so it cannot drift from what is actually
 * installed — the 「系统信息」 page reports it, and a version string that lies is worse than
 * no version string. A read failure degrades to `unknown`, not to a plausible-looking guess.
 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** DSH home resolution, mirroring @deepseek-ai/dsh-home-paths: $DSH_HOME wins, then ~/.dsh. */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * Where the diagnostics go.
 *
 * `LUZZY_DIAG_DIR` overrides it, and the TESTS set that: they call `apply()` against a
 * throwaway HTTP server, which used to write `routes-registered.json` into the user's real
 * `.dsh/luzzy-page-diag/` with the TEST process's pid and ephemeral port. That file was
 * then read back as if it described the running app — it sent one whole debugging round
 * chasing "the host is on port 50269" when the live host was on 43120. Test runs must not
 * leave evidence in the app's diagnostic directory.
 */
function resolveDiagDir(home) {
  const configured = process.env.LUZZY_DIAG_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(home, 'luzzy-page-diag')
}

/** The flight recorder log. Appended to, and rotated once past the cap. */
const DIAG_LOG = 'diag.jsonl'
const DIAG_LOG_MAX_BYTES = 2 * 1024 * 1024

function diagDirFor() {
  return resolveDiagDir(resolveDshHome())
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

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Reject callers that are clearly not local.
 *
 * The platform already gates these routes: the Desktop shell wraps every handler in
 * `permits()`, which admits the Electron renderer (by capability header) and ordinary
 * browsers (by policy). This is a second, narrower check — these payloads describe local
 * activity, so they should not travel.
 *
 * It fails OPEN on an unreadable address. Electron issues these requests through
 * `net.fetch`, which produces a real loopback socket, so the address is normally present;
 * but if that ever changes, an absent address must not lock the page out. The official
 * `dsh-community-market` routes read `req.socket.remoteAddress` the same way (alongside
 * origin and host), which is evidence the field is reliable here rather than a guess.
 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLocalCaller(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return true
  return LOOPBACK_ADDRESSES.has(address)
}

export const name = 'luzzy-page'
export const inject = ['webServer']

export function apply(ctx) {
  const home = resolveDshHome()
  const sessionsRoot = join(home, 'sessions')
  // The parsed-log cache lives next to the diagnostics, under DSH home. It survives
  // restarts, which is the point: without it every launch re-paid ~20 s of decompression
  // for logs that had not changed (see usage-cache.mjs for the measurements).
  const aggregator = createUsageAggregator(sessionsRoot, join(diagDirFor(), 'extract-cache.json'))
  const readmePath = join(PLUGIN_ROOT, 'README.md')

  // Warm the cache in the background so the first visit to the usage page is instant.
  //
  // This is safe where an earlier warmup was NOT, and the difference is worth stating
  // because the old one crashed the app twice:
  //
  //   * The work runs in the WORKER. The old version did a synchronous pass on the host's
  //     main thread, which starved the 30 s profile admission channel and failed host-boot.
  //     Here the main thread only posts a message and waits.
  //   * It is deferred 15 s, so it cannot compete with startup at all.
  //   * It is cancellable through the same ctx.effect that would tear the plugin down.
  //
  // The cost of being wrong is also bounded: a warmup failure is recorded and ignored, and
  // the page falls back to paying the cold cost on first request — which is what it did
  // before this existed.
  ctx.effect(
    () => aggregator.warm({ delayMs: 15_000, unit: 'day' }),
    'luzzy-page: background warmup',
  )

  // Unload must release the worker thread, not leave it running against a dead context.
  ctx.effect(() => () => aggregator.stop(), 'luzzy-page: worker lifecycle')

  // Registration evidence: record the moment the routes are registered, so a blank page
  // splits cleanly into "host half never activated" versus "renderer never asked". The
  // `source` field says which process wrote it — a test run under LUZZY_DIAG_DIR is
  // labelled as such rather than masquerading as the app.
  try {
    const dir = diagDirFor()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'routes-registered.json'),
      JSON.stringify({
        registeredAt: Date.now(),
        pid: process.pid,
        port: ctx.webServer?.port ?? null,
        dshHome: home,
        source: process.env.LUZZY_DIAG_DIR ? 'test' : 'host',
      }),
      'utf8',
    )
  } catch {
    // Non-fatal: diagnostics only.
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/__luzzy/usage',
        handler: async (req, res) => {
          if (!isLocalCaller(req)) {
            sendJson(res, 403, { error: 'luzzy usage is local-only' })
            return
          }
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'usage requires GET' })
            return
          }

          const url = new URL(req.url ?? '/', 'http://localhost')
          const unit = url.searchParams.get('unit') ?? 'day'
          if (!UNITS.has(unit)) {
            sendJson(res, 400, { error: `unit must be one of ${[...UNITS].join(', ')}` })
            return
          }
          const refresh = url.searchParams.get('refresh') === '1'

          // Log the request boundaries. A cold aggregate is ~20 s, so "stuck loading" and
          // "still working" look identical from the page; these two lines make the
          // difference visible from the host side (request arrived / request answered).
          const startedAt = Date.now()
          console.warn(`[luzzy-page] usage request unit=${unit} refresh=${refresh}`)

          try {
            // Runs in a worker thread: the host's main thread never blocks on it. A cold
            // first call takes a while (the client shows a loading state); warm calls hit
            // the 30 s result cache.
            const payload = await aggregator.aggregateOffThread(unit, refresh)
            console.warn(`[luzzy-page] usage answered unit=${unit} in ${Date.now() - startedAt} ms`)
            sendJson(res, 200, payload)
          } catch (error) {
            // Never invent numbers on failure — report the failure instead.
            const detail = error instanceof Error ? error.message : String(error)
            console.warn(`[luzzy-page] usage FAILED unit=${unit} after ${Date.now() - startedAt} ms: ${detail}`)
            sendJson(res, 500, {
              error: 'usage aggregation failed',
              detail,
              sessionsRoot,
            })
          }
        },
      }),
    'luzzy-page: usage route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/__luzzy/diag',
        handler: (req, res) => {
          if (!isLocalCaller(req)) {
            sendJson(res, 403, { error: 'luzzy diag is local-only' })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'diag requires POST' })
            return
          }

          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            // The renderer's flight recorder: a crashed slot entry renders as silence, and
            // a stalled fetch leaves a skeleton up forever, so both the page and its frame
            // report here — where the host can write files. `console.warn` alone is NOT
            // enough: a bare console call does not reach the desktop log set.
            const body = Buffer.concat(chunks).toString('utf8').slice(0, 8000)
            console.warn(`[luzzy-page] renderer: ${body}`)
            try {
              const dir = diagDirFor()
              mkdirSync(dir, { recursive: true })
              const file = join(dir, DIAG_LOG)
              // One append per ping, rotated at the cap: an earlier version wrote a file
              // per ping, which is unusable after a few hundred events.
              try {
                if (statSync(file).size > DIAG_LOG_MAX_BYTES) {
                  renameSync(file, `${file}.1`)
                }
              } catch {
                // No existing log (or unreadable): nothing to rotate.
              }
              appendFileSync(file, `${body}\n`, 'utf8')
            } catch {}
            sendJson(res, 200, { ok: true })
          })
        },
      }),
    'luzzy-page: diag route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/__luzzy/readme',
        handler: (req, res) => {
          if (!isLocalCaller(req)) {
            sendJson(res, 403, { error: 'luzzy readme is local-only' })
            return
          }
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'readme requires GET' })
            return
          }

          try {
            sendText(res, 200, readFileSync(readmePath, 'utf8'), 'text/markdown; charset=utf-8')
          } catch (error) {
            sendText(res, 404, `README unavailable: ${error instanceof Error ? error.message : error}`)
          }
        },
      }),
    'luzzy-page: readme route',
  )

  // The 「预设」 sub-page's routes. Registered last and in their own module so this file's
  // existing paths stay untouched; the handler itself decides GET versus POST.
  registerPresetRoutes(ctx)

  // The 「执行状态」 / 「系统信息」 pages' read-only route.
  //
  // Separate from the goal route on purpose: the goal route is a WRITE surface with a
  // compare-and-set policy, and its contract is "one mutation, then the whole state back".
  // Runtime facts are raw log events — cheaper, safe to poll, and with no write path at all,
  // so they get their own route rather than a second read path behind a write endpoint.
  //
  // This reads the session logs the same way the usage aggregator does (read-only; an
  // unreadable log is reported, never guessed at). It does NOT write anything.
  registerRuntimeRoutes(ctx, {
    home,
    pluginVersion: PLUGIN_VERSION,
  })

  // The 「目标」 sub-page: its route, its tool, and its two lifecycle hooks.
  //
  // All three are optional dependencies. `ctx.get(name)` rather than `ctx.name` is not a
  // style choice — cordis' context proxy THROWS for any service name the calling fiber did
  // not declare in `inject`, and the throw happens while the expression is evaluated, so it
  // cannot be guarded by optional chaining. This plugin declares only `webServer`; probing
  // everything else keeps the deployment matrix open. A build without `dsh-tool-goal` still
  // gets the page, and the page says which half is missing.
  const goalPaths = storePaths(home)
  const goalArtifacts = {
    /**
     * Describe where this session's artifact would go, without touching the disk.
     * @returns {{path: string, enabled: boolean} | undefined}
     */
    describe(sessionId) {
      const flags = readArtifactFlags(goalPaths)
      if (flags.sessions[sessionId] === undefined) return undefined
      return { path: ARTIFACT_RELATIVE_PATH, enabled: true }
    },
  }

  const enforcement = installEnforcement(ctx, {
    paths: goalPaths,
    artifacts: goalArtifacts,
    // All four layers on. `preflight` is the one that satisfies AC-002 — a substantive turn
    // observes the goal state before working — and its cost is bounded by `preflightEverySteps`
    // rather than by skipping turns, because §13 requires the READ on every turn and only
    // exempts the WRITE.
    options: { blockCompletion: true, preflight: true, reconcile: true, augmentGetGoal: true },
  })

  const tool = registerDeliveryTool(ctx, {
    tools: service(ctx, 'tools'),
    paths: goalPaths,
    // The route and the tool share ONE write path, so the compare-and-set policy has a
    // single implementation and a page edit and a model edit cannot both win.
    commit: (deps, op, payload, options) => commitOp(deps, op, payload, options),
    read: ({ sessionId, ctx: hostCtx, agent }) => {
      const pair = readPair(hostCtx, sessionId, goalPaths, agent)
      return pair.ok ? { delivery: pair.delivery, goal: pair.goal } : { delivery: null, goal: null }
    },
  })

  registerGoalRoutes(ctx, {
    paths: goalPaths,
    enforcement,
    toolRegistered: tool.registered,
    // The page may make the same edits the agent may make — plus the human-only ones, which
    // the route keeps in a separate function so no agent path can reach them.
    applyAgentOp: (delivery, op, payload, context) => {
      const read = { ok: true, delivery }
      const { applyDeliveryOp } = goalDomain
      return applyDeliveryOp(read.delivery, op, payload, context)
    },
  })
}
