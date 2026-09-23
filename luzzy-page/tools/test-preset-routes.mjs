/**
 * Assert the 「预设」 routes' contract and the session-aware operations.
 *
 * The route layer is where an honest failure becomes an HTTP status, so the cases that
 * matter most are the refusals: a non-loopback caller, a wrong method, an oversized body,
 * a losing revision, and a session that DSH will not let you switch. Each of those has a
 * distinct status on purpose — collapsing them into a generic 500 would leave the page
 * unable to tell "you lost a race" from "this deployment is broken".
 *
 * The routes are driven through a REAL `node:http` server with the plugin's handler
 * mounted, not by calling the handlers directly: the loopback check reads
 * `req.socket.remoteAddress`, which a direct call cannot supply honestly.
 *
 * `LUZZY_DIAG_DIR` and `DSH_HOME` are pointed at temp directories so a test run can never
 * write into the user's real store or diagnostics.
 *
 * Run: node tools/test-preset-routes.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const workspaces = []
const savedHome = process.env.DSH_HOME
const savedDiag = process.env.LUZZY_DIAG_DIR

/**
 * A stand-in for the host context: only the services these routes actually consult.
 *
 * IT THROWS ON UNDECLARED SERVICES, like the real thing. Cordis installs a proxy whose `get`
 * trap raises `cannot get property "agents" without inject` for any name the calling fiber
 * did not declare — so a plugin that reads `ctx.agents` when it only injected `webServer`
 * fails at RUNTIME, on the first request, with a 500.
 *
 * The first version of this fake was a plain object with the services hanging off it, which
 * is exactly why it passed while the real page returned
 * `cannot get property "agents" without inject`. A stub more permissive than the system
 * under test cannot catch the defect it exists for.
 *
 * The declared set mirrors the plugin's own `inject = ['webServer']`.
 */
const DECLARED = new Set(['webServer', 'get', 'effect', 'logger'])

function makeCtx(overrides = {}) {
  const registered = []
  const effects = []
  const agentsById = new Map()
  const provided = {
    agents: { get: (id) => agentsById.get(id) },
    agentPresets: {
      list: () => [],
      composedPreset: () => 'standard',
      select: async () => 'luzzy-mode',
    },
    sessionProjections: { stateOf: () => ({ lastTurn: 0, openTurnStartSeq: null }) },
  }

  const ctx = new Proxy({
    registered,
    effects,
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
    effect(action) {
      const dispose = action()
      effects.push(dispose)
      return dispose
    },
    logger: { info() {}, warn() {} },
    // The documented way to reach an optional service.
    get(name) {
      return provided[name]
    },
    ...overrides,
  }, {
    get(object, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(object, property, receiver)
      if (Object.hasOwn(object, property) || DECLARED.has(property)) return Reflect.get(object, property, receiver)
      // The real error text, so a regression reads the same here as it does in the app.
      throw new Error(`cannot get property "${property}" without inject`)
    },
  })

  ctx.agentsById = agentsById
  ctx.provided = provided
  return ctx
}

async function request(port, { method = 'GET', path = '/__luzzy/preset', body, headers = {} } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }),
      ...headers,
    },
    body: payload,
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text, headers: response.headers }
}

/** Mount the plugin's routes on a real loopback server. */
async function withServer(ctx, run) {
  const { registerPresetRoutes } = await import(pathToFileURL(join(LIB, 'preset-routes.mjs')).href)
  registerPresetRoutes(ctx)
  const route = ctx.registered.find((entry) => entry.path === '/__luzzy/preset')
  if (route === undefined) throw new Error('the preset route was never registered')

  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

try {
  const home = mkdtempSync(join(tmpdir(), 'luzzy-routes-home-'))
  const diag = mkdtempSync(join(tmpdir(), 'luzzy-routes-diag-'))
  workspaces.push(home, diag)
  process.env.DSH_HOME = home
  process.env.LUZZY_DIAG_DIR = diag

  console.log('preset-routes: registration')
  {
    const ctx = makeCtx()
    const { registerPresetRoutes } = await import(pathToFileURL(join(LIB, 'preset-routes.mjs')).href)
    registerPresetRoutes(ctx)
    eq('one route is registered', ctx.registered.length, 1)
    eq('on the preset path', ctx.registered[0].path, '/__luzzy/preset')
    eq('as an exact route', ctx.registered[0].kind, 'exact')
    check('registration is wrapped in ctx.effect', ctx.effects.length === 1)
  }

  console.log('preset-routes: GET on an empty store')
  await withServer(makeCtx(), async (port) => {
    const first = await request(port)
    eq('200', first.status, 200)
    check('the body is JSON', first.json !== undefined, first.text.slice(0, 120))
    eq('an empty store reports revision 0', first.json.revision, 0)
    eq('no agents yet', first.json.agents.length, 0)
    eq('no active agent', first.json.settings.activeAgentId, null)
    eq('no session without a sessionId', first.json.session, null)
    // The first on-screen version said "已用一份默认名单起步" directly above an empty list.
    // `readSnapshot` never seeds — only `ensureStore` does — so that claim was false, and
    // false in a way the user could watch contradict itself on one screen.
    check('the first run is explained', first.json.warnings.some((w) => w.includes('还没有设置文件')))
    check('no warning claims a seeded roster', !first.json.warnings.some((w) => w.includes('默认名单')), JSON.stringify(first.json.warnings))
    check('the warning says the roster is empty', first.json.warnings.some((w) => w.includes('空')), JSON.stringify(first.json.warnings))
    check('the store dir is reported', typeof first.json.capabilities.storeDir === 'string')
    check('responses are not cached', first.headers.get('cache-control') === 'no-store')
    check('a byte count is given for the prompt', typeof first.json.promptBytes === 'number')
  })

  console.log('preset-routes: method and path discipline')
  await withServer(makeCtx(), async (port) => {
    const put = await request(port, { method: 'PUT', body: {} })
    eq('PUT is refused', put.status, 405)
    check('the 405 says which method is wanted', put.json.error.includes('GET') || put.json.error.includes('POST'), put.json.error)

    const head = await request(port, { method: 'DELETE' })
    eq('DELETE is refused', head.status, 405)

    const get = await request(port, { path: '/__luzzy/preset?sessionId=' })
    // An empty sessionId is "unknown", not "session ''".
    eq('a blank sessionId is treated as absent', get.status, 200)
    eq('and yields no session facts', get.json.session, null)
  })

  console.log('preset-routes: POST validation')
  await withServer(makeCtx(), async (port) => {
    const notJson = await request(port, { method: 'POST', body: '{ not json' })
    eq('malformed JSON is a 400', notJson.status, 400)
    check('and says so', notJson.json.error.includes('JSON'), notJson.json.error)

    const noOp = await request(port, { method: 'POST', body: {} })
    eq('a missing op is a 400', noOp.status, 400)
    check('and says the op is missing', noOp.json.error.includes('op'), noOp.json.error)

    const unknownOp = await request(port, { method: 'POST', body: { op: 'deleteEverything' } })
    eq('an unknown op is a 400', unknownOp.status, 400)
    check('and echoes it', unknownOp.json.error.includes('deleteEverything'), unknownOp.json.error)

    const emptyBody = await request(port, { method: 'POST', body: '' })
    eq('an empty body is read as {} and refused', emptyBody.status, 400)
    check('an empty body reports the missing op', emptyBody.json.error.includes('op'), emptyBody.json.error)

    const tooBig = await request(port, { method: 'POST', body: { op: 'setPrompt', text: 'x'.repeat(3 * 1024 * 1024) } })
    // 413 and not a reset socket: the handler drains the oversized request so the client
    // can read the reason. A destroyed socket surfaces here as a thrown fetch.
    eq('an oversized body is a 413', tooBig.status, 413)
    check('and states the limit', tooBig.json.error.includes('过大'), tooBig.json.error)
  })

  console.log('preset-routes: the roster round-trips')
  await withServer(makeCtx(), async (port) => {
    const seeded = await request(port, { method: 'POST', body: { op: 'ensureStore', defaultPrompt: 'DEFAULT-TEXT' } })
    eq('ensureStore succeeds', seeded.status, 200)
    check('a default agent was seeded', seeded.json.agents.length >= 1, JSON.stringify(seeded.json.agents))
    check('a default prompt was seeded', seeded.json.promptBytes > 0)
    eq('the seeded prompt is the default file', seeded.json.promptSource, 'default')

    const first = seeded.json.revision
    const added = await request(port, { method: 'POST', body: { op: 'upsertAgent', name: 'Second Agent', revision: first } })
    eq('adding an agent succeeds', added.status, 200)
    eq('the roster grew', added.json.agents.length, seeded.json.agents.length + 1)
    check('the revision advanced', added.json.revision > first, `${first} → ${added.json.revision}`)

    const stale = await request(port, { method: 'POST', body: { op: 'upsertAgent', name: 'Losing Writer', revision: first } })
    eq('a stale revision is a 409', stale.status, 409)
    check('the conflict reports both revisions', stale.json.expected === first && typeof stale.json.actual === 'number')
    check('the conflict carries the current state', stale.json.snapshot !== undefined)
    eq('the losing write did not land', stale.json.snapshot.agents.length, added.json.agents.length)

    const badId = await request(port, { method: 'POST', body: { op: 'upsertAgent', id: '../escape' } })
    eq('a path-escaping id is a 400', badId.status, 400)
    check('and explains the rule', badId.json.error.includes('小写字母'), badId.json.error)

    const newId = added.json.agents.find((a) => a.name === 'Second Agent').id
    const prompt = await request(port, { method: 'POST', body: { op: 'setPrompt', agentId: newId, text: 'SECOND-PROMPT' } })
    eq('saving a prompt succeeds', prompt.status, 200)
    check('the byte count is reported', prompt.json.saved.bytes === Buffer.byteLength('SECOND-PROMPT'))

    const activated = await request(port, { method: 'POST', body: { op: 'setActive', agentId: newId } })
    eq('activating succeeds', activated.status, 200)
    eq('the active agent is reported', activated.json.settings.activeAgentId, newId)

    const reload = await request(port, { method: 'POST', body: { op: 'reload' } })
    eq('reload succeeds', reload.status, 200)
    eq('reload preserved the active agent', reload.json.settings.activeAgentId, newId)

    const missingAgent = await request(port, { method: 'POST', body: { op: 'setPrompt', agentId: 'ghost', text: 'x' } })
    eq('a prompt for an unknown agent is a 400', missingAgent.status, 400)

    const removed = await request(port, { method: 'POST', body: { op: 'removeAgent', id: newId } })
    eq('removing succeeds', removed.status, 200)
    eq('removing the active agent clears it', removed.json.settings.activeAgentId, null)
  })

  console.log('preset-routes: deleting an agent moves its prompt out of the live roster')
  {
    // The prompt file must leave `agents/`, or the freed id is a trap: `suggestId` only
    // checks ids present in the roster, so the next agent deriving the same id would silently
    // inherit a deleted agent's prompt.
    const ctx = makeCtx()
    await withServer(ctx, async (port) => {
      const seeded = await request(port, { method: 'POST', body: { op: 'ensureStore', defaultPrompt: 'D' } })
      const created = await request(port, { method: 'POST', body: { op: 'upsertAgent', name: 'Doomed' } })
      const id = created.json.agents.find((a) => a.name === 'Doomed').id
      const saved = await request(port, { method: 'POST', body: { op: 'setPrompt', agentId: id, text: 'DOOMED-PROMPT-CONTENT' } })
      eq('the prompt was saved', saved.status, 200)
      check('the seeded roster is not empty', seeded.json.agents.length >= 1)

      const gone = await request(port, { method: 'POST', body: { op: 'removeAgent', id } })
      eq('removing succeeds', gone.status, 200)
      check('the archive result is reported', gone.json.archived !== undefined, JSON.stringify(gone.json.archived))
      eq('the prompt was moved', gone.json.archived.moved, true)
      check('the destination is reported', typeof gone.json.archived.to === 'string' && gone.json.archived.to.includes('archive'))

      const { existsSync, readFileSync } = await import('node:fs')
      check('the file left agents/', !existsSync(join(home, 'luzzy-preset', 'agents', `${id}.md`)))
      check('the file is recoverable in archive/', existsSync(gone.json.archived.to))
      eq('and its content survived the move', readFileSync(gone.json.archived.to, 'utf8'), 'DOOMED-PROMPT-CONTENT')

      // Re-creating the same id must NOT pick the old prompt back up.
      const again = await request(port, { method: 'POST', body: { op: 'upsertAgent', id, name: 'Fresh' } })
      eq('the id can be reused', again.status, 200)
      const readBack = await request(port, { method: 'POST', body: { op: 'readPrompt', agentId: id } })
      check('the reused id does not inherit the old prompt', readBack.json.text !== 'DOOMED-PROMPT-CONTENT', readBack.json.text)
      eq('and is reported as having no file of its own', readBack.json.exists, false)
    })
  }

  console.log('preset-routes: session facts come from the projection')
  {
    const ctx = makeCtx()
    ctx.agentsById.set('empty-1', { session: { header: { cwd: 'C:/work' } }, ctx: {} })
    await withServer(ctx, async (port) => {
      const facts = await request(port, { path: '/__luzzy/preset?sessionId=empty-1' })
      eq('200', facts.status, 200)
      check('session facts are present', facts.json.session !== null)
      eq('the preset is reported', facts.json.session.preset, 'standard')
      eq('an empty session may switch', facts.json.session.canSwitchToLuzzy, true)
      eq('with no reason attached', facts.json.session.reason, null)

      const unknown = await request(port, { path: '/__luzzy/preset?sessionId=nope' })
      eq('an unknown session still answers', unknown.status, 200)
      eq('as a live session with no agent', unknown.json.session.canSwitchToLuzzy, false)
      check('and states the reason', unknown.json.session.reason.includes('agent'), unknown.json.session.reason)
    })
  }

  console.log('preset-routes: a working session cannot be switched, and says why')
  {
    const ctx = makeCtx()
    ctx.provided.sessionProjections.stateOf = () => ({ lastTurn: 3, openTurnStartSeq: null })
    ctx.agentsById.set('busy-1', { session: { header: { cwd: 'C:/work' } }, ctx: {} })
    await withServer(ctx, async (port) => {
      const facts = await request(port, { path: '/__luzzy/preset?sessionId=busy-1' })
      eq('the session is reported', facts.json.session.canSwitchToLuzzy, false)
      check('the reason mentions content', facts.json.session.reason.includes('内容'), facts.json.session.reason)

      const attempt = await request(port, { method: 'POST', body: { op: 'switchSession', sessionId: 'busy-1' } })
      eq('the switch is refused with 422', attempt.status, 422)
      check('the refusal carries the current state', attempt.json.snapshot !== undefined)
    })
  }

  console.log('preset-routes: a session already on LuzzyMode is a no-op success')
  {
    const ctx = makeCtx()
    ctx.provided.agentPresets.composedPreset = () => 'luzzy-mode'
    ctx.agentsById.set('already-1', { session: { header: { cwd: 'C:/work' } }, ctx: {} })
    await withServer(ctx, async (port) => {
      const switched = await request(port, { method: 'POST', body: { op: 'switchSession', sessionId: 'already-1' } })
      eq('200', switched.status, 200)
      eq('the preset is echoed', switched.json.applied.preset, 'luzzy-mode')
    })
  }

  console.log('preset-routes: session actions degrade honestly when a service is missing')
  {
    // The service is absent from the deployment entirely, which is what `ctx.get` reports as
    // undefined — not a present service missing one method.
    const ctx = makeCtx()
    delete ctx.provided.agentPresets
    await withServer(ctx, async (port) => {
      const snapshot = await request(port)
      eq('the capability is reported as unavailable', snapshot.json.capabilities.sessionPresetSwitch, false)

      const attempt = await request(port, { method: 'POST', body: { op: 'switchSession', sessionId: 'x' } })
      check('the switch fails rather than pretending', attempt.status === 422 || attempt.status === 400, String(attempt.status))
    })

    const noController = makeCtx()
    await withServer(noController, async (port) => {
      const attempt = await request(port, { method: 'POST', body: { op: 'newSession' } })
      eq('a missing session controller is a 422', attempt.status, 422)
      check('and names the missing capability', attempt.json.error.includes('会话'), attempt.json.error)
    })

    // The prompt editor must keep working with NO session services at all — that is the
    // reason these are reached through ctx.get instead of being declared in `inject`.
    const bare = makeCtx()
    delete bare.provided.agents
    delete bare.provided.agentPresets
    delete bare.provided.sessionProjections
    await withServer(bare, async (port) => {
      const snapshot = await request(port)
      eq('the roster still loads without session services', snapshot.status, 200)
      eq('the roster is present', Array.isArray(snapshot.json.agents), true)

      const save = await request(port, { method: 'POST', body: { op: 'ensureStore', defaultPrompt: 'BARE' } })
      eq('writing still works without session services', save.status, 200)
      check('and the prompt landed', save.json.promptBytes > 0)
    })
  }

  console.log('preset-routes: a new session attaches to the workspace that owns the directory')
  {
    const created = []
    const ctx = makeCtx()
    // Provided through `get`, because that is how the plugin reaches an optional service.
    // Hanging it off the context object would test a path the plugin never uses.
    ctx.provided.sessionController = {
      async create(request) {
        created.push(request)
        return { sessionId: 'session-new-1', agentPreset: 'luzzy-mode' }
      },
    }
    // The workspace registry is what turns a directory into an attachable workspace id.
    ctx.provided.workspaceRegistry = {
      resolveByPath: async (path) => (path === 'C:/the/workspace' ? { id: 'ws-1' } : undefined),
    }
    ctx.agentsById.set('source-1', { session: { header: { cwd: 'C:/the/workspace' } }, ctx: {} })

    await withServer(ctx, async (port) => {
      const attempt = await request(port, { method: 'POST', body: { op: 'newSession', sessionId: 'source-1' } })
      eq('200', attempt.status, 200)
      eq('the new session id is returned', attempt.json.applied.sessionId, 'session-new-1')
      eq('it was created on LuzzyMode', created[0].agentPreset, 'luzzy-mode')

      // THE REGRESSION: `sessionController.create` attaches a workspace ONLY from
      // `workspaceId`. Passing `cwd` produced a valid session that belonged to no workspace,
      // so the sidebar — which groups sessions by workspace — never showed it. The user saw
      // a success dialog and no session.
      eq('the owning workspace id is sent', created[0].workspaceId, 'ws-1')
      check(
        'cwd is NOT sent alongside workspaceId (they are mutually exclusive)',
        created[0].cwd === undefined,
        `cwd=${JSON.stringify(created[0].cwd)} would make the request fail or skip the attach`,
      )
      eq('the attachment is reported back', attempt.json.applied.workspace, 'ws-1')
    })
  }

  console.log('preset-routes: an unregistered directory is reported, not papered over')
  {
    const created = []
    const ctx = makeCtx()
    ctx.provided.sessionController = {
      async create(request) {
        created.push(request)
        return { sessionId: 'session-outside-1', agentPreset: 'luzzy-mode' }
      },
    }
    // No workspace owns this directory.
    ctx.provided.workspaceRegistry = { resolveByPath: async () => undefined }
    ctx.agentsById.set('source-2', { session: { header: { cwd: 'C:/not/a/workspace' } }, ctx: {} })

    await withServer(ctx, async (port) => {
      const attempt = await request(port, { method: 'POST', body: { op: 'newSession', sessionId: 'source-2' } })
      eq('the session is still created', attempt.status, 200)
      // Falls back to cwd so the session at least lands in the right directory…
      eq('cwd is used when nothing owns it', created[0].cwd, 'C:/not/a/workspace')
      // …and the page is told, because this session will NOT be in the sidebar.
      eq('no workspace is claimed', attempt.json.applied.workspace, null)
    })
  }

  console.log('preset-routes: a missing directory is reported without losing the session')
  {
    const created = []
    const ctx = makeCtx()
    ctx.provided.sessionController = {
      async create(request) {
        created.push(request)
        return { sessionId: 'session-gone-1', agentPreset: 'luzzy-mode' }
      },
    }
    // `resolveByPath` rejects when the path does not exist on disk.
    ctx.provided.workspaceRegistry = {
      resolveByPath: async () => { throw new Error('ENOENT: no such file or directory') },
    }
    ctx.agentsById.set('source-3', { session: { header: { cwd: 'C:/deleted/folder' } }, ctx: {} })

    await withServer(ctx, async (port) => {
      const attempt = await request(port, { method: 'POST', body: { op: 'newSession', sessionId: 'source-3' } })
      eq('a vanished directory does not fail the create', attempt.status, 200)
      eq('the failure is carried to the page', typeof attempt.json.applied.workspaceLookupFailed, 'string')
      eq('no workspace is claimed', attempt.json.applied.workspace, null)
    })
  }
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedDiag === undefined) delete process.env.LUZZY_DIAG_DIR
  else process.env.LUZZY_DIAG_DIR = savedDiag
  for (const workspace of workspaces) {
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
}

console.log('')
if (failures === 0) {
  console.log(`preset-routes: ${checks} checks passed`)
  process.exit(0)
}
console.log(`preset-routes: ${failures} of ${checks} checks FAILED`)
process.exit(1)
