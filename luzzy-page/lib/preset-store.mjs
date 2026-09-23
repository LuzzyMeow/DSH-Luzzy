/**
 * Preset store — the on-disk truth behind LuzzyMode's system prompt.
 *
 * The prompt a LuzzyMode session sends is NOT stored in the preset composition. It lives
 * here, as files, and reaches the model through a section whose text is the constant
 * reference `{{luzzy_persona}}` while the value comes from this module's reader. Two
 * consequences, and both are the point:
 *
 *   1. Editing a prompt file changes the NEXT request. No restart, no preset switch, no
 *      new session — `SystemPrompt.assemble()` evaluates the variable provider per step,
 *      so the rendered prompt differs and the agent loop replaces the system node.
 *   2. It sidesteps the harness's preset lock. `agent-presets` fixes a session's preset
 *      once it has produced anything; a value in a prompt section is not a preset change,
 *      so switching the active agent still lands mid-conversation.
 *
 * The value is carried as a prompt VARIABLE rather than as section text on purpose:
 * `renderPrompt` interpolates section text and THROWS on an unknown `{{name}}`, so a user
 * prompt containing its own braces would break every request. Substituted variable values
 * are never re-scanned, which makes arbitrary user text safe.
 *
 * BYTE-IDENTICAL COPY: this file also exists as `luzzy-page/lib/preset-store.mjs`. The
 * preset is copied into `~/.dsh/.agent-presets/<id>/` and can resolve only its own
 * siblings, while the page plugin resolves from the workspace — neither can import the
 * other, so the module is duplicated and `tools/test-preset-parity.mjs` asserts the two
 * copies stay identical. This is the canonical copy; edit it here and re-copy.
 *
 * @module dsh-luzzy-preset/preset-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Directory under DSH home holding the whole store. */
export const STORE_DIR_NAME = 'luzzy-preset'
/** Metadata + agent roster, with the active agent id. */
export const SETTINGS_FILE = 'settings.json'
/** Prompt used when no agent is active, or when the active one has no file. */
export const DEFAULT_PROMPT_FILE = 'default.md'
/** Subdirectory holding one prompt file per agent. */
export const AGENTS_DIR = 'agents'
/** Store format version. An unrecognised version is not interpreted at all. */
export const STORE_VERSION = 1

/**
 * Agent and group ids. The id becomes a file name, so anything that could escape the
 * store directory is refused rather than sanitised — a silently rewritten id would make
 * the page's roster disagree with the disk.
 */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/
export const MAX_ID_CHARS = 48
export const MAX_NAME_CHARS = 80
export const MAX_DESCRIPTION_CHARS = 400
/** A prompt is text; the cap is a typo guard, not a budget. */
export const MAX_PROMPT_BYTES = 1024 * 1024
/** Bounds on roster size, so a runaway caller cannot make the page unrenderable. */
export const MAX_AGENTS = 200
export const MAX_GROUPS = 50

/**
 * The last resort, when neither the store nor either bundled fallback file can be read.
 *
 * It is deliberately non-empty and says what happened. An empty persona is not a smaller
 * prompt — it is a session running with no rules at all, which is the one failure that
 * would be invisible.
 */
export const EMPTY_FALLBACK_TEXT =
  '# LuzzyMode\n\n' +
  '提示词没读到：预设存储、默认提示词文件与包内兜底都不可用。\n' +
  '请在 LuzzyPage 的「预设」子页检查设置，或确认 DSH home 可写。\n'

/** DSH home resolution, mirroring @deepseek-ai/dsh-home-paths: $DSH_HOME wins, then ~/.dsh. */
export function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * Every path the store uses, derived from one home directory.
 * @param {string} home - DSH home.
 * @returns {{home: string, dir: string, settings: string, defaultPrompt: string, agentsDir: string}}
 */
export function storePaths(home) {
  const dir = join(home, STORE_DIR_NAME)
  return {
    home,
    dir,
    settings: join(dir, SETTINGS_FILE),
    defaultPrompt: join(dir, DEFAULT_PROMPT_FILE),
    agentsDir: join(dir, AGENTS_DIR),
  }
}

/**
 * One agent's prompt path. The caller must have validated the id: this only joins.
 * @param {{agentsDir: string}} paths - store paths.
 * @param {string} agentId - validated agent id.
 * @returns {string} absolute path of the agent's prompt file.
 */
export function agentPromptPath(paths, agentId) {
  return join(paths.agentsDir, `${agentId}.md`)
}

/** @returns the file's text, or `undefined` when it is absent or unreadable. */
export function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** A store with nothing in it. Also the shape a caller may spread into a patch. */
export function emptyStore() {
  return { version: STORE_VERSION, revision: 0, activeAgentId: null, groups: [], agents: [] }
}

function optionalText(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

// ---------------------------------------------------------------- reading

/**
 * Interpret one parsed `settings.json`.
 *
 * Invalid rows are DROPPED with a reason rather than rejected wholesale: a single bad
 * agent should not take the user's whole roster down with it. The returned warnings are
 * what makes the drop honest — the page renders them instead of pretending the roster is
 * complete.
 *
 * @param {unknown} raw - parsed JSON.
 * @returns {{ok: true, store: object, warnings: string[]} | {ok: false, reason: string}}
 */
export function parseSettings(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'settings.json 不是一个对象' }
  }
  if (raw.version !== STORE_VERSION) {
    // A future format is not guessed at: interpreting it partially would silently
    // mis-assign prompts, and falling back to the bundled default is recoverable.
    return { ok: false, reason: `settings.json 版本是 ${JSON.stringify(raw.version)}，本插件只认得 ${STORE_VERSION}` }
  }

  const warnings = []
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : []
  const rawAgents = Array.isArray(raw.agents) ? raw.agents : []

  const groups = []
  const seenGroups = new Set()
  for (const entry of rawGroups) {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push('有一个分组不是对象，已跳过')
      continue
    }
    const id = optionalText(entry.id, MAX_ID_CHARS)
    if (id === undefined || !SLUG.test(id)) {
      warnings.push(`分组 id ${JSON.stringify(entry.id)} 不合规，已跳过`)
      continue
    }
    if (seenGroups.has(id)) {
      warnings.push(`分组 id "${id}" 重复，已跳过重复项`)
      continue
    }
    seenGroups.add(id)
    groups.push({ id, name: optionalText(entry.name, MAX_NAME_CHARS) ?? id, order: positiveInteger(entry.order) })
  }

  const agents = []
  const seenAgents = new Set()
  for (const entry of rawAgents) {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push('有一个智能体不是对象，已跳过')
      continue
    }
    const id = optionalText(entry.id, MAX_ID_CHARS)
    if (id === undefined || !SLUG.test(id)) {
      warnings.push(`智能体 id ${JSON.stringify(entry.id)} 不合规，已跳过（id 只能是小写字母、数字与连字符）`)
      continue
    }
    if (seenAgents.has(id)) {
      warnings.push(`智能体 id "${id}" 重复，已跳过重复项`)
      continue
    }
    seenAgents.add(id)
    const groupId = optionalText(entry.groupId, MAX_ID_CHARS)
    agents.push({
      id,
      name: optionalText(entry.name, MAX_NAME_CHARS) ?? id,
      description: optionalText(entry.description, MAX_DESCRIPTION_CHARS) ?? '',
      // A group the store does not define would render as a phantom column, so the
      // reference is resolved here rather than trusted.
      groupId: groupId !== undefined && seenGroups.has(groupId) ? groupId : null,
      order: positiveInteger(entry.order),
    })
  }

  const activeRaw = optionalText(raw.activeAgentId, MAX_ID_CHARS)
  const activeAgentId = activeRaw !== undefined && seenAgents.has(activeRaw) ? activeRaw : null
  if (activeRaw !== undefined && activeAgentId === null) {
    warnings.push(`激活的智能体 "${activeRaw}" 不在名单里，已回退到默认提示词`)
  }

  return {
    ok: true,
    store: { version: STORE_VERSION, revision: positiveInteger(raw.revision), activeAgentId, groups, agents },
    warnings,
  }
}

/**
 * Read the store. Never throws: an absent, unreadable, unparsable or future-versioned
 * document all resolve to an empty store plus a warning, so a caller always has something
 * well-shaped to render.
 *
 * @param {ReturnType<typeof storePaths>} paths - store paths.
 * @returns {{store: object, warnings: string[], source: 'file'|'absent'|'unparsable'|'version'}}
 */
export function readStore(paths) {
  const raw = readFileSafe(paths.settings)
  if (raw === undefined) return { store: emptyStore(), warnings: [], source: 'absent' }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      store: emptyStore(),
      warnings: [`settings.json 解析失败：${error instanceof Error ? error.message : String(error)}`],
      source: 'unparsable',
    }
  }

  const result = parseSettings(parsed)
  if (!result.ok) return { store: emptyStore(), warnings: [result.reason], source: 'version' }
  return { store: result.store, warnings: result.warnings, source: 'file' }
}

// ---------------------------------------------------------------- writing

/**
 * Replace a file atomically: a sibling temp file, then one rename.
 *
 * A partially written settings.json is the one corruption the store cannot detect — it
 * parses as JSON often enough to be believed — so the write never happens in place.
 * @param {string} path - destination.
 * @param {string} contents - full next contents.
 */
export function writeFileAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, contents, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may not exist; the original error is the one that matters.
    }
    throw error
  }
}

/** Persist one store document, bumping its revision. @returns the written revision. */
export function writeStore(paths, store) {
  const next = { ...store, version: STORE_VERSION, revision: positiveInteger(store.revision) + 1 }
  writeFileAtomic(paths.settings, `${JSON.stringify(next, null, 2)}\n`)
  return next.revision
}

/** Write one prompt file (the default, or one agent's). Returns the bytes written. */
export function writePrompt(paths, agentId, text) {
  const path = agentId === null ? paths.defaultPrompt : agentPromptPath(paths, agentId)
  writeFileAtomic(path, text)
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Move a removed agent's prompt out of the live roster.
 *
 * MOVED, NOT DELETED, and the destination is reported. A prompt is the user's own writing —
 * deleting 120 KB of it because they tidied a list is not a thing to do silently, and §7.6's
 * rule is reversible-first. It lands in `<store>/archive/<id>.<timestamp>.md`, out of
 * `agents/` so the id is genuinely free again.
 *
 * The move is what stops the id-reuse hazard `removeAgent` documents: leaving the file in
 * place would let a later agent that derives the same id inherit this prompt.
 *
 * @param {ReturnType<typeof storePaths>} paths - store paths.
 * @param {string} agentId - the removed agent's id.
 * @returns {{moved: true, to: string} | {moved: false, reason: string}}
 */
export function archiveAgentPrompt(paths, agentId) {
  const from = agentPromptPath(paths, agentId)
  if (!existsSync(from)) return { moved: false, reason: '这个智能体还没有自己的提示词文件' }
  const dir = join(paths.dir, 'archive')
  try {
    mkdirSync(dir, { recursive: true })
    // A timestamp alone is not enough: two removals in the same millisecond would collide,
    // and on Windows a rename onto an existing file throws.
    let to = join(dir, `${agentId}.${Date.now()}.md`)
    for (let attempt = 1; existsSync(to) && attempt < 100; attempt += 1) {
      to = join(dir, `${agentId}.${Date.now()}.${attempt}.md`)
    }
    renameSync(from, to)
    return { moved: true, to }
  } catch (error) {
    return { moved: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------- pure roster operations
//
// Every operation below is a pure function from (store, payload) to a result. Keeping them
// free of the filesystem is what lets the tests assert the exact shape of a roster change
// without a temp directory, and lets the route decide when to persist.

/** @returns {number} the next free order value in a list. */
function nextOrder(entries) {
  let max = -1
  for (const entry of entries) if (entry.order > max) max = entry.order
  return max + 1
}

/**
 * Validate an id supplied by a caller.
 * @returns {string|undefined} an error message, or undefined when the id is usable.
 */
export function idProblem(id, what = 'id') {
  if (typeof id !== 'string' || id === '') return `${what} 不能为空`
  if (id.length > MAX_ID_CHARS) return `${what} 不能超过 ${MAX_ID_CHARS} 个字符`
  if (!SLUG.test(id)) return `${what} 只能包含小写字母、数字与连字符，且以字母或数字开头`
  return undefined
}

/**
 * Derive a free id from a display name.
 *
 * A CJK name has no ASCII form to transliterate, so it falls through to a counter rather
 * than to a lossy guess. The result is always a legal id, and never collides with an
 * existing one.
 * @param {string} name - the display name.
 * @param {Iterable<string>} taken - ids already in use.
 * @returns {string} a free id.
 */
export function suggestId(name, taken) {
  const used = new Set(taken)
  const ascii = typeof name === 'string' ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : ''
  if (ascii !== '' && SLUG.test(ascii) && ascii.length <= MAX_ID_CHARS && !used.has(ascii)) return ascii
  const stem = ascii !== '' && SLUG.test(ascii) ? ascii.slice(0, MAX_ID_CHARS - 4).replace(/-+$/, '') : 'agent'
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${stem}-${index}`
    if (!used.has(candidate)) return candidate
  }
  return `agent-${Date.now()}`
}

function upsertGroup(store, payload) {
  const input = typeof payload === 'object' && payload !== null ? payload : {}
  const explicitId = optionalText(input.id, MAX_ID_CHARS)
  const id = explicitId ?? suggestId(optionalText(input.name, MAX_NAME_CHARS) ?? '', store.groups.map((group) => group.id))
  const problem = idProblem(id, '分组 id')
  if (problem !== undefined) return { error: problem }
  if (explicitId === undefined && store.groups.length >= MAX_GROUPS) return { error: `分组数量已达上限 ${MAX_GROUPS}` }

  const name = optionalText(input.name, MAX_NAME_CHARS) ?? id
  const groups = store.groups.slice()
  const index = groups.findIndex((group) => group.id === id)
  if (index === -1) groups.push({ id, name, order: nextOrder(groups) })
  else groups[index] = { ...groups[index], name }
  return { store: { ...store, groups } }
}

function removeGroup(store, payload) {
  const id = optionalText(payload?.id, MAX_ID_CHARS)
  if (id === undefined) return { error: '缺少分组 id' }
  if (!store.groups.some((group) => group.id === id)) return { error: `分组 "${id}" 不存在` }
  return {
    store: {
      ...store,
      groups: store.groups.filter((group) => group.id !== id),
      // Members are moved to the ungrouped bucket rather than deleted: removing a folder
      // must not throw away the prompts filed inside it.
      agents: store.agents.map((agent) => (agent.groupId === id ? { ...agent, groupId: null } : agent)),
    },
  }
}

function reorderGroups(store, payload) {
  const order = Array.isArray(payload?.order) ? payload.order : []
  if (order.length === 0) return { error: '缺少排序数据' }
  const byId = new Map(store.groups.map((group) => [group.id, group]))
  for (const entry of order) {
    const id = optionalText(entry?.id, MAX_ID_CHARS)
    if (id === undefined || !byId.has(id)) return { error: `排序里出现未知分组 ${JSON.stringify(entry?.id)}` }
    byId.set(id, { ...byId.get(id), order: positiveInteger(entry.order) })
  }
  return { store: { ...store, groups: store.groups.map((group) => byId.get(group.id)) } }
}

function upsertAgent(store, payload) {
  const input = typeof payload === 'object' && payload !== null ? payload : {}
  const explicitId = optionalText(input.id, MAX_ID_CHARS)
  const id = explicitId ?? suggestId(optionalText(input.name, MAX_NAME_CHARS) ?? '', store.agents.map((agent) => agent.id))
  const problem = idProblem(id, '智能体 id')
  if (problem !== undefined) return { error: problem }
  if (explicitId === undefined && store.agents.length >= MAX_AGENTS) return { error: `智能体数量已达上限 ${MAX_AGENTS}` }

  const groupId = optionalText(input.groupId, MAX_ID_CHARS)
  if (groupId !== undefined && !store.groups.some((group) => group.id === groupId)) {
    return { error: `分组 "${groupId}" 不存在` }
  }

  const agents = store.agents.slice()
  const index = agents.findIndex((agent) => agent.id === id)
  const created = index === -1
  if (created) {
    agents.push({
      id,
      name: optionalText(input.name, MAX_NAME_CHARS) ?? id,
      description: optionalText(input.description, MAX_DESCRIPTION_CHARS) ?? '',
      groupId: groupId ?? null,
      order: nextOrder(agents),
    })
  } else {
    agents[index] = {
      ...agents[index],
      name: optionalText(input.name, MAX_NAME_CHARS) ?? agents[index].name,
      description: optionalText(input.description, MAX_DESCRIPTION_CHARS) ?? agents[index].description,
      // An explicit null moves the agent out of its group; an absent field leaves it.
      groupId: 'groupId' in input ? groupId ?? null : agents[index].groupId,
    }
  }
  return { store: { ...store, agents }, created, id }
}

/**
 * Remove one agent from the roster.
 *
 * The pure part only: this drops the row and reports which id went away. Moving the prompt
 * FILE is the caller's job, because that is a filesystem operation and this function is kept
 * free of I/O so its exact shape can be asserted without a temp directory.
 *
 * The caller must move the file, not ignore it. A freed id is immediately reusable —
 * `suggestId` checks only the ids currently in the roster — so an orphaned
 * `agents/<id>.md` would be silently inherited by the next agent that derives the same id.
 * The new agent would come up carrying a stranger's prompt, which reads as the editor
 * "remembering" something the user never typed.
 */
function removeAgent(store, payload) {
  const id = optionalText(payload?.id, MAX_ID_CHARS)
  if (id === undefined) return { error: '缺少智能体 id' }
  if (!store.agents.some((agent) => agent.id === id)) return { error: `智能体 "${id}" 不存在` }
  return {
    store: {
      ...store,
      agents: store.agents.filter((agent) => agent.id !== id),
      // Deleting the active agent leaves the default prompt in charge, which is a
      // defined state — an id pointing at nothing would silently fall back anyway.
      activeAgentId: store.activeAgentId === id ? null : store.activeAgentId,
    },
    removed: id,
  }
}

function reorderAgents(store, payload) {
  const order = Array.isArray(payload?.order) ? payload.order : []
  if (order.length === 0) return { error: '缺少排序数据' }
  const byId = new Map(store.agents.map((agent) => [agent.id, agent]))
  for (const entry of order) {
    const id = optionalText(entry?.id, MAX_ID_CHARS)
    if (id === undefined || !byId.has(id)) return { error: `排序里出现未知智能体 ${JSON.stringify(entry?.id)}` }
    const groupId = optionalText(entry?.groupId, MAX_ID_CHARS)
    if (groupId !== undefined && !store.groups.some((group) => group.id === groupId)) {
      return { error: `排序里的分组 "${groupId}" 不存在` }
    }
    byId.set(id, {
      ...byId.get(id),
      order: positiveInteger(entry.order),
      groupId: 'groupId' in entry ? groupId ?? null : byId.get(id).groupId,
    })
  }
  return { store: { ...store, agents: store.agents.map((agent) => byId.get(agent.id)) } }
}

function setActive(store, payload) {
  if (!('agentId' in (payload ?? {}))) return { error: '缺少 agentId（想回退到默认提示词就传 null）' }
  const raw = payload.agentId
  if (raw === null) return { store: { ...store, activeAgentId: null }, activeAgentId: null }
  const id = optionalText(raw, MAX_ID_CHARS)
  if (id === undefined) return { error: 'agentId 必须是 id 或 null' }
  if (!store.agents.some((agent) => agent.id === id)) return { error: `智能体 "${id}" 不存在` }
  return { store: { ...store, activeAgentId: id }, activeAgentId: id }
}

/**
 * Apply one roster operation to a store, without touching the filesystem.
 *
 * The route persists what comes back; the tests assert it directly. Every op returns
 * either `{store}` or `{error}`, never both, so a caller cannot persist a half-applied
 * change by mistake.
 *
 * @param {object} store - current store.
 * @param {string} op - one of the documented operation names.
 * @param {object} payload - operation payload.
 * @returns {{store?: object, error?: string, created?: boolean, id?: string, removed?: string, activeAgentId?: string|null}}
 */
export function applyRosterOp(store, op, payload) {
  switch (op) {
    case 'upsertGroup': return upsertGroup(store, payload)
    case 'removeGroup': return removeGroup(store, payload)
    case 'reorderGroups': return reorderGroups(store, payload)
    case 'upsertAgent': return upsertAgent(store, payload)
    case 'removeAgent': return removeAgent(store, payload)
    case 'reorderAgents': return reorderAgents(store, payload)
    case 'setActive': return setActive(store, payload)
    default: return { error: `未知操作 "${op}"` }
  }
}

// ---------------------------------------------------------------- prompt resolution

/**
 * A reader that resolves the text LuzzyMode should send right now.
 *
 * Resolution order — an agent prompt, the store's default, then the bundled fallback:
 *
 *   1. `agents/<activeAgentId>.md`
 *   2. `default.md`
 *   3. the caller's `builtinFallbackPath` (the package's own copy)
 *
 * An EMPTY file does not win its turn: it is skipped like a missing one, because an empty
 * system prompt is the failure mode that would show up as "the model suddenly ignores the
 * rules" with nothing on disk to explain it.
 *
 * WHY THERE IS NO CACHE
 *
 * This used to memoize on `(size, mtimeMs, birthtimeMs)` and was removed after measuring
 * the filesystem: on this NTFS volume, **144 of 200 same-length in-place rewrites produced
 * a completely identical stat tuple** — same size, same mtime, same birth time, same ctime.
 * A one-character edit to a prompt (`"猫"` → `"狗"`, or any typo fix) is exactly that shape,
 * so the cache would have handed the model the OLD prompt while the page showed the new one,
 * with nothing anywhere reporting a problem. Timestamp resolution (~1 ms here, and far
 * coarser on other filesystems) is not a foundation a correctness-critical read belongs on.
 *
 * The cost of dropping it is one `readFileSync` per assembly. The prompt is bounded by
 * `MAX_PROMPT_BYTES` and is read once per model step, not per token — and a correct read of
 * a small file is not the expensive part of a request by any measure. Paying it is the
 * whole trade: correctness over microseconds.
 *
 * BYTE-IDENTICAL COPIES: this file is duplicated as `luzzy-page/lib/preset-store.mjs`;
 * `tools/test-preset-parity.mjs` asserts the two stay equal.
 *
 * @param {ReturnType<typeof storePaths>} paths - store paths.
 * @param {{builtinFallbackPath?: string}} [options] - last-resort file, if the package ships one.
 * @returns {{read: () => {text: string, source: string, agentId: string|null, warnings: string[]}}}
 */
export function createPromptReader(paths, options = {}) {
  const builtinFallbackPath = options.builtinFallbackPath

  function read() {
    const storeRead = readStore(paths)
    const store = storeRead.store

    const candidates = []
    if (store.activeAgentId !== null) {
      candidates.push({ source: 'agent', agentId: store.activeAgentId, path: agentPromptPath(paths, store.activeAgentId) })
    }
    candidates.push({ source: 'default', agentId: null, path: paths.defaultPrompt })
    if (typeof builtinFallbackPath === 'string' && builtinFallbackPath !== '') {
      candidates.push({ source: 'builtin', agentId: null, path: builtinFallbackPath })
    }

    for (const candidate of candidates) {
      const contents = readFileSafe(candidate.path)
      if (typeof contents !== 'string' || contents.trim() === '') continue
      return { text: contents, source: candidate.source, agentId: candidate.agentId, warnings: storeRead.warnings }
    }

    return {
      text: EMPTY_FALLBACK_TEXT,
      source: 'empty',
      agentId: null,
      warnings: [...storeRead.warnings, '没有读到任何提示词文件，已使用内置兜底文本'],
    }
  }

  return { read }
}
