/**
 * Preset operations for the LuzzyPage 「预设」 sub-page: the host half.
 *
 * The page itself is an iframe with no session context of its own, so every fact it
 * renders comes from here. That is deliberate — the frame stays a renderer, and the one
 * place that knows about DSH services is this module.
 *
 * THREE THINGS THIS MODULE HAS TO GET RIGHT
 *
 *   1. **The switch is real.** Changing the active agent writes the store, and the preset
 *      row re-reads it on the next assembly. Nothing is restarted, no session is touched.
 *      It works mid-conversation because a prompt VARIABLE is not a preset change — the
 *      harness's preset lock (a session that has produced anything cannot switch presets)
 *      does not apply.
 *
 *   2. **The preset switch is NOT always possible, and that is reported, not hidden.** A
 *      session on another preset can only move to LuzzyMode while it is still empty; once
 *      it has produced content, `agent-presets` refuses. The page says so and offers a new
 *      session instead of pretending the click worked.
 *
 *   3. **Optional dependencies degrade, they do not crash.** The DSH services that answer
 *      "which preset is this session on" and "create a session" may be absent in a
 *      different deployment. Without them the prompt editor still works and only the
 *      session-aware buttons go dark, each with its reason stated.
 *
 * @module dsh-luzzy-page/preset-ops
 */

import {
  AGENTS_DIR,
  DEFAULT_PROMPT_FILE,
  EMPTY_FALLBACK_TEXT,
  MAX_PROMPT_BYTES,
  agentPromptPath,
  applyRosterOp,
  archiveAgentPrompt,
  createPromptReader,
  emptyStore,
  readFileSafe,
  readStore,
  resolveDshHome,
  storePaths,
  writePrompt,
  writeStore,
} from './preset-store.mjs'

/** The preset this whole feature exists for. Both the roster id and the display name. */
export const LUZZY_PRESET_ID = 'luzzy-mode'

/**
 * Resolve one optional DSH service.
 *
 * `ctx.get(name)` rather than `ctx.name`, and the difference is not stylistic. Cordis
 * installs a proxy whose `get` trap THROWS for any property the calling fiber did not
 * declare in its `inject`:
 *
 *     cannot get property "agents" without inject
 *
 * This plugin declares only `webServer`, so `ctx.agents`, `ctx.agentPresets` and
 * `ctx.sessionProjections` all throw on access — and a throwing getter cannot be guarded by
 * `typeof ctx.agents?.get === 'function'`, because the throw happens while evaluating the
 * expression. That is exactly how the first real run of this sub-page failed: every request
 * 500'd before the capability checks could run.
 *
 * `ctx.get()` returns `undefined` for a service this deployment does not mount, which is what
 * an optional dependency needs. Declaring them in `inject` would be the other option, but it
 * would make the whole plugin refuse to load when any one is absent — a deployment without
 * `agentPresets` still has a working prompt editor.
 *
 * @param {object} ctx - host context.
 * @param {string} name - service name.
 * @returns {object|undefined} the service, or undefined when it is not provided here.
 */
function service(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    // `get` itself should not throw, but a plugin must not die of a probe.
    return undefined
  }
}

/** Ops a caller may post. Anything else is a 400, never a silent no-op. */
export const ROSTER_OPS = new Set([
  'upsertGroup',
  'removeGroup',
  'reorderGroups',
  'upsertAgent',
  'removeAgent',
  'reorderAgents',
  'setActive',
  'reload',
])

/** @returns a store seeded with one agent and one group, for a first run. */
export function seedStore() {
  return {
    ...emptyStore(),
    groups: [{ id: 'default', name: '默认', order: 0 }],
    agents: [
      { id: 'luzzy', name: '鹿溪', description: '', groupId: 'default', order: 0 },
    ],
    activeAgentId: null,
  }
}

/**
 * Everything the sub-page needs, in one payload.
 *
 * Assembled as one response on purpose: the page renders a consistent picture (roster,
 * active agent, warnings, session facts) and a split into several routes would let it
 * paint a half-updated state that never existed on disk.
 *
 * @param {object} deps - host dependencies.
 * @param {string|null} deps.sessionId - the session the page is looking at, when known.
 * @param {object|null} deps.sessionFacts - resolved preset facts, or null when unknown.
 * @param {string} deps.expectedPrompt - the prompt text the active agent should send.
 * @returns {object} the JSON body.
 */
export function buildSnapshot({ store, warnings, revision, prompt, sessionFacts, capabilities }) {
  return {
    revision,
    settings: { version: store.version, activeAgentId: store.activeAgentId },
    groups: store.groups.slice().sort((a, b) => a.order - b.order),
    agents: store.agents.slice().sort((a, b) => a.order - b.order),
    promptSource: prompt.source,
    promptAgentId: prompt.agentId,
    promptBytes: Buffer.byteLength(prompt.text, 'utf8'),
    promptPreview: prompt.text.length > 2000 ? `${prompt.text.slice(0, 2000)}…` : prompt.text,
    warnings,
    capabilities,
    session: sessionFacts,
  }
}

/**
 * Read one session's preset facts.
 *
 * The preset lock is derived from the session's own `turnBoundary` projection, which is
 * exactly what `agent-presets` consults before it allows a switch — reading the same
 * source here means the button's state and the server's decision cannot disagree.
 *
 * @param {object} ctx - host context.
 * @param {string} sessionId - the session to inspect.
 * @returns {{sessionId: string, preset: string|null, canSwitchToLuzzy: boolean, reason: string|null, known: true} | {sessionId: string|null, known: false, reason: string}}
 */
export function readSessionFacts(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { sessionId: null, known: false, preset: null, canSwitchToLuzzy: false, reason: '页面没有拿到会话标识' }
  }

  const agents = service(ctx, 'agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  const session = agent?.session
  const presets = service(ctx, 'agentPresets')
  const preset = typeof presets?.composedPreset === 'function' && agent !== undefined
    ? presets.composedPreset(agent.ctx) ?? null
    : null

  let boundary
  try {
    boundary = service(ctx, 'sessionProjections')?.stateOf?.(session, 'turnBoundary')
  } catch {
    boundary = undefined
  }
  const started = boundary !== undefined && boundary !== null && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)

  if (preset === LUZZY_PRESET_ID) {
    return { sessionId, preset, known: true, canSwitchToLuzzy: false, reason: null }
  }
  if (session === undefined) {
    return {
      sessionId,
      preset,
      known: true,
      canSwitchToLuzzy: false,
      reason: '这个会话当前没有运行中的 agent，无法切换预设',
    }
  }
  if (started) {
    return {
      sessionId,
      preset,
      known: true,
      canSwitchToLuzzy: false,
      reason: '这个会话已经产生过内容，DSH 不允许中途更换预设。提示词切换仍然可用，或新建一个会话。',
    }
  }
  return { sessionId, preset, known: true, canSwitchToLuzzy: true, reason: null }
}

/**
 * Move an empty session onto LuzzyMode.
 *
 * Refuses on a session that has produced anything, with the harness's own reason — the
 * page must never show a success it did not get.
 *
 * @returns {Promise<{ok: true, preset: string} | {ok: false, error: string}>}
 */
export async function switchSessionPreset(ctx, sessionId) {
  const facts = readSessionFacts(ctx, sessionId)
  if (facts.known === false) return { ok: false, error: facts.reason }
  if (facts.preset === LUZZY_PRESET_ID) return { ok: true, preset: LUZZY_PRESET_ID }
  if (!facts.canSwitchToLuzzy) return { ok: false, error: facts.reason ?? '无法切换这个会话的预设' }

  const agent = service(ctx, 'agents')?.get?.(sessionId)
  if (agent === undefined) return { ok: false, error: '找不到这个会话的 agent' }
  const presets = service(ctx, 'agentPresets')
  if (typeof presets?.select !== 'function') return { ok: false, error: '本部署的预设服务不可用，无法切换' }

  try {
    const preset = await presets.select(agent, LUZZY_PRESET_ID)
    return { ok: true, preset }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the workspace that owns a session's directory.
 *
 * Exported because the CLIENT half needs it: the app's own client `sessions` service can
 * create AND select a session (`ctx.sessions.create({workspaceId})` then
 * `ctx.sessions.open(id)`), and doing it there is the only way the new session becomes
 * visible. A blank session is shown by the sidebar ONLY while it is the selected one, and
 * the frame has no access to app navigation — so a host route that merely creates the
 * session produces something the user cannot see. That was the reported bug.
 *
 * @param {object} ctx - host context.
 * @param {string} sessionId - the session whose directory to resolve.
 * @returns {Promise<{workspaceId: string|null, cwd: string|null, reason: string|null}>}
 */
export async function resolveWorkspaceForSession(ctx, sessionId) {
  const source = typeof sessionId === 'string' && sessionId !== ''
    ? service(ctx, 'agents')?.get?.(sessionId)
    : undefined
  const cwd = source?.session?.header?.cwd ?? null

  if (typeof cwd !== 'string' || cwd === '') {
    return { workspaceId: null, cwd: null, reason: '这个会话没有记录工作目录' }
  }
  const registry = service(ctx, 'workspaceRegistry')
  if (typeof registry?.resolveByPath !== 'function') {
    return { workspaceId: null, cwd, reason: '本部署的工作区服务不可用' }
  }
  try {
    const workspace = await registry.resolveByPath(cwd)
    if (workspace === undefined) return { workspaceId: null, cwd, reason: null }
    return { workspaceId: workspace.id ?? null, cwd, reason: null }
  } catch (error) {
    // `resolveByPath` rejects when the path is gone from disk. Not fatal, but reported.
    return { workspaceId: null, cwd, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Create a new session on LuzzyMode, in the workspace the user is looking at.
 *
 * WHY IT GOES THROUGH `sessionController` RATHER THAN `ctx.agents.create`
 *
 * `AgentRegistry.create` is the low-level factory: it takes a caller-supplied `sessionId`
 * and a `setup` callback, and does NOT resolve a preset. Calling it from here would publish
 * an agent that never joins a preset — the roster logs exactly that as "published without
 * joining an agent preset; its tools, prompt sections, and skill catalog resolve against the
 * empty global layer". `sessionController.create` is the supported entry point: it mints the
 * id, resolves the preset, and attaches the workspace.
 *
 * IT MUST PASS `workspaceId`, NOT `cwd` — the bug this fixes
 *
 * `sessionController.create` resolves a workspace ONLY from `workspaceId`:
 *
 *     if (request.workspaceId !== void 0) workspace = ctx.workspaceRegistry.get(request.workspaceId)
 *     ...
 *     if (workspace !== void 0) await workspace.attachSession(sessionId)
 *
 * Passing `cwd` produces a perfectly valid session that is attached to NOTHING — it never
 * enters any workspace's `sessionIds`, and the sidebar lists sessions by workspace, so the
 * user saw a success dialog and no session. `cwd` and `workspaceId` are mutually exclusive
 * in that request, so exactly one is ever sent.
 *
 * The source session's own `cwd` is resolved to its owning workspace through
 * `resolveByPath`, which canonicalizes (trailing slashes, `..`, symlinks) and matches the
 * same canon the attach-time check uses. When no workspace owns that directory — an
 * unregistered folder — there is nothing to attach to, and the honest move is to create the
 * session in that directory anyway and SAY it is not in a workspace, rather than fail or
 * silently drop it into a different one.
 *
 * @returns {Promise<{ok: true, sessionId: string, preset: string|null, attachedWorkspace: string|null}
 *   | {ok: false, error: string}>}
 */
export async function createLuzzySession(ctx, fromSessionId) {
  const controller = service(ctx, 'sessionController')
  if (typeof controller?.create !== 'function') {
    return { ok: false, error: '本部署的会话控制器不可用，无法新建会话' }
  }

  const resolved = await resolveWorkspaceForSession(ctx, fromSessionId)
  const workspaceId = resolved.workspaceId ?? undefined
  const cwd = resolved.cwd ?? undefined

  try {
    const created = await controller.create({
      ...(workspaceId === undefined ? (cwd === undefined ? {} : { cwd }) : { workspaceId }),
      agentPreset: LUZZY_PRESET_ID,
    })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, error: '会话创建了，但没拿到它的 id' }
    }
    return {
      ok: true,
      sessionId,
      preset: created?.agentPreset ?? null,
      attachedWorkspace: workspaceId ?? null,
      workspaceLookupFailed: resolved.reason,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The whole read path behind `GET /__luzzy/preset`.
 *
 * @param {object} ctx - host context.
 * @param {{sessionId?: string|null}} query - parsed query.
 * @returns {object} the snapshot body.
 */
export function readSnapshot(ctx, query = {}) {
  const paths = storePaths(resolveDshHome())
  const { store, warnings, source } = readStore(paths)
  const prompt = createPromptReader(paths, { builtinFallbackPath: null }).read()
  // A present-but-empty query parameter means "not supplied" — `?sessionId=` is how a
  // template with an unset variable renders, and treating it as a real id would make the
  // page show "cannot switch this session" for a session that does not exist.
  const sessionId = typeof query.sessionId === 'string' && query.sessionId !== '' ? query.sessionId : null
  const sessionFacts = sessionId === null ? null : readSessionFacts(ctx, sessionId)

  return buildSnapshot({
    store,
    revision: store.revision,
    // One warning per real condition, and never a claim the roster below contradicts. The
    // earlier text said "已用一份默认名单起步" while the list rendered empty — the store had no
    // agents, because `readSnapshot` does NOT seed (only `ensureStore` does). Telling the user
    // a default roster exists when it does not is the kind of wrong statement they cannot
    // check against the screen in front of them.
    warnings: source === 'absent'
      ? ['还没有设置文件。名单是空的 —— 点「＋ 智能体」新建一个，或从「默认提示词」开始。']
      : warnings,
    prompt,
    sessionFacts,
    capabilities: {
      sessionPresetSwitch: typeof service(ctx, 'agentPresets')?.select === 'function',
      newSession: typeof service(ctx, 'sessionController')?.create === 'function',
      storeDir: paths.dir,
      presetsAvailable: typeof service(ctx, 'agentPresets')?.list === 'function',
    },
  })
}

/**
 * Create the store directory and a starting roster, without ever overwriting what is
 * already there.
 *
 * Seeding is what makes the first run coherent. Without it the reader falls through to the
 * bundled fallback, and the sub-page shows a prompt the user never wrote — which reads as
 * "my settings were thrown away" rather than "nothing has been set up yet".
 *
 * Three separate decisions, each guarded on its own condition:
 *
 *   * no settings.json            → write a seeded roster
 *   * settings.json but no agents → seed the roster into it, keeping its groups
 *   * `default.md` absent or empty→ write it from the caller's `seededText`
 *
 * The last one only fires on an absent-or-empty file. Seeding is a convenience, not a
 * migration: a `default.md` the user wrote is never replaced by a suggestion.
 *
 * @param {ReturnType<typeof storePaths>} paths - store paths.
 * @param {string} [seededText] - text for a first `default.md`, if there is none.
 * @returns {{created: boolean, seededPrompt: boolean}}
 */
export function ensureStore(paths, seededText) {
  let created = false
  let seededPrompt = false

  if (readStore(paths).source === 'absent') {
    writeStore(paths, seedStore())
    created = true
  } else if (readStore(paths).store.agents.length === 0) {
    const current = readStore(paths).store
    writeStore(paths, { ...current, groups: current.groups.length > 0 ? current.groups : seedStore().groups, agents: seedStore().agents })
    created = true
  }

  if (typeof seededText === 'string' && seededText.trim() !== '') {
    const existing = readFileSafe(paths.defaultPrompt)
    if (existing === undefined || existing.trim() === '') {
      writePrompt(paths, null, seededText)
      seededPrompt = true
    }
  }

  return { created, seededPrompt }
}

/**
 * Handle one mutation from the page.
 *
 * Order is fixed and load-bearing: apply to a copy, validate, persist the store, then
 * write the prompt file. A prompt write is the expensive, user-visible half; committing
 * the roster first means a failure in the second half is reported as "saved the roster,
 * failed to write the prompt" rather than losing both.
 *
 * @param {object} ctx - host context.
 * @param {object} body - parsed request body.
 * @returns {{status: number, body: object}}
 */
export function applyMutation(ctx, body) {
  const paths = storePaths(resolveDshHome())
  const input = typeof body === 'object' && body !== null ? body : {}
  const op = typeof input.op === 'string' ? input.op : ''

  if (op === 'reload') return { status: 200, body: readSnapshot(ctx, { sessionId: input.sessionId ?? null }) }

  if (op === 'setPrompt') {
    const agentId = input.agentId === null || input.agentId === undefined ? null : String(input.agentId)
    if (typeof input.text !== 'string') return { status: 400, body: { error: 'text 必须是字符串' } }
    const bytes = Buffer.byteLength(input.text, 'utf8')
    if (bytes > MAX_PROMPT_BYTES) {
      return { status: 400, body: { error: `提示词过大（${bytes} 字节，上限 ${MAX_PROMPT_BYTES}）` } }
    }
    const { store } = readStore(paths)
    if (agentId !== null && !store.agents.some((agent) => agent.id === agentId)) {
      return { status: 400, body: { error: `智能体 "${agentId}" 不存在` } }
    }
    try {
      writePrompt(paths, agentId, input.text)
    } catch (error) {
      return { status: 500, body: { error: `提示词写入失败：${error instanceof Error ? error.message : String(error)}` } }
    }
    return { status: 200, body: { ...readSnapshot(ctx, { sessionId: input.sessionId ?? null }), saved: { agentId, bytes } } }
  }

  if (op === 'readPrompt') {
    // The roster snapshot carries only a preview of the ACTIVE prompt. The editor needs the
    // whole text of whichever agent is selected, which may be neither active nor small —
    // and sending every agent's prompt in the roster would make one list request as large
    // as the sum of all of them.
    const agentId = input.agentId === null || input.agentId === undefined ? null : String(input.agentId)
    const { store } = readStore(paths)
    if (agentId !== null && !store.agents.some((agent) => agent.id === agentId)) {
      return { status: 400, body: { error: `智能体 "${agentId}" 不存在` } }
    }
    const path = agentId === null ? paths.defaultPrompt : agentPromptPath(paths, agentId)
    const text = readFileSafe(path)
    const isDefault = agentId === null
    // A missing agent file is not an error: the agent simply inherits the default, and the
    // editor shows that by pre-filling with what would actually be sent.
    const fallback = isDefault ? '' : readFileSafe(paths.defaultPrompt) ?? ''
    return {
      status: 200,
      body: {
        agentId,
        text: text ?? fallback,
        exists: text !== undefined,
        inherited: text === undefined && !isDefault,
        bytes: Buffer.byteLength(text ?? fallback, 'utf8'),
        maxBytes: MAX_PROMPT_BYTES,
      },
    }
  }

  if (op === 'ensureStore') {
    try {
      ensureStore(paths, typeof input.defaultPrompt === 'string' ? input.defaultPrompt : undefined)
    } catch (error) {
      return { status: 500, body: { error: `初始化失败：${error instanceof Error ? error.message : String(error)}` } }
    }
    return { status: 200, body: readSnapshot(ctx, { sessionId: input.sessionId ?? null }) }
  }

  if (op === '') return { status: 400, body: { error: '缺少 op：请求体里要写明要做哪一件事' } }

  if (!ROSTER_OPS.has(op)) return { status: 400, body: { error: `未知操作 ${JSON.stringify(op)}` } }

  const { store, warnings } = readStore(paths)
  if (typeof input.revision === 'number' && input.revision !== store.revision) {
    return {
      status: 409,
      body: {
        error: '名单已被别处修改，请刷新后重试',
        expected: input.revision,
        actual: store.revision,
        snapshot: readSnapshot(ctx, { sessionId: input.sessionId ?? null }),
      },
    }
  }

  const result = applyRosterOp(store, op, input)
  if (result.error !== undefined) return { status: 400, body: { error: result.error, warnings } }

  try {
    writeStore(paths, result.store)
  } catch (error) {
    return { status: 500, body: { error: `保存失败：${error instanceof Error ? error.message : String(error)}` } }
  }

  // Removing an agent must also move its prompt file. The roster write above already
  // succeeded, so a failure here is reported as a partial result rather than a failed
  // delete: the agent IS gone, and pretending otherwise would be the worse lie.
  let archived = null
  if (op === 'removeAgent' && typeof result.removed === 'string') {
    archived = archiveAgentPrompt(paths, result.removed)
  }

  return {
    status: 200,
    body: {
      ...readSnapshot(ctx, { sessionId: input.sessionId ?? null }),
      warnings: [...warnings, ...readStore(paths).warnings],
      ...(archived === null ? {} : { archived }),
    },
  }
}

export { AGENTS_DIR, DEFAULT_PROMPT_FILE, EMPTY_FALLBACK_TEXT, resolveDshHome, storePaths }
