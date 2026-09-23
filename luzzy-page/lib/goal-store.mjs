/**
 * Goal delivery store — disk truth for the 「目标」 sub-page's overlay, and the projection
 * that turns a live goal into `.agent/goal.md`.
 *
 * TWO STATES, TWO AUTHORITIES
 *
 * The runtime goal lives in the session log and is owned by `dsh-goal`. This module never
 * writes it. What lives here is the OVERLAY — acceptance criteria, tasks, evidence,
 * decisions, focus, next action — which DSH has no field for. The overlay carries its own
 * `revision` and every mutation must present the revision it read, so two writers cannot
 * silently overwrite each other (the brief's §32 / AC-005).
 *
 * The two are joined on read: `readDeliveryOverlay` returns the overlay, and the caller
 * pairs it with a fresh `ctx.goals.get(agent)`. Nothing in this file caches the runtime
 * goal, because a cached objective is exactly how a page ends up confidently describing a
 * goal that has since been edited.
 *
 * WHY FILES AND NOT A STORAGE DOMAIN
 *
 * `ctx.storageDomain` would be the harness-native home for host-side records, and it is
 * mounted in this deployment. It is not used here because the plugin injects only
 * `webServer`: every other service has to be probed with `ctx.get()`, and an optional
 * dependency that can be absent would make this feature's availability depend on which
 * profile is running. A JSON document under DSH home has neither problem, and it is the
 * pattern `preset-store.mjs` already established and tested in this repository.
 *
 * SESSION-KEYED, DELIBERATELY
 *
 * One document per session. A resumed session finds its plan — that is AC-009. A FORKED
 * session does not inherit one, because `dsh-agent` gives a fork a new session id and the
 * brief's §55 is explicit that a fork must not resurrect a goal on its own.
 *
 * @module dsh-luzzy-page/goal-store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { normalizeDelivery, renderGoalMarkdown } from './goal-domain.mjs'

/** Directory under DSH home holding every session's overlay. */
export const STORE_DIR_NAME = 'luzzy-goal'
/** The artifact written into a workspace, relative to the session's cwd. */
export const ARTIFACT_RELATIVE_PATH = join('.agent', 'goal.md')
/** Opt-in marker: the artifact is only rewritten automatically once this exists. */
export const ARTIFACT_FLAG_FILE = 'artifact.json'

/**
 * A session id becomes a file name, so anything that could escape the store directory is
 * refused rather than sanitised — a silently rewritten id would make the page read one
 * session's plan while claiming to show another's.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/**
 * DSH home resolution, mirroring @deepseek-ai/dsh-home-paths: $DSH_HOME wins, then ~/.dsh.
 * @param {object} [env] - environment to read.
 * @returns {string} the home directory.
 */
export function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * Every path this module uses, derived from one home directory.
 * @param {string} home - DSH home.
 * @returns {{home: string, dir: string, flags: string}} the paths.
 */
export function storePaths(home) {
  const dir = join(home, STORE_DIR_NAME)
  return { home, dir, flags: join(dir, ARTIFACT_FLAG_FILE) }
}

/**
 * One session's overlay path.
 * @param {{dir: string}} paths - store paths.
 * @param {string} sessionId - validated session id.
 * @returns {string} absolute path.
 */
export function sessionFile(paths, sessionId) {
  return join(paths.dir, `${sessionId}.json`)
}

/** @returns the file's text, or `undefined` when absent or unreadable. */
function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Replace a file atomically: a sibling temp file, then one rename.
 *
 * A partially written document is the one corruption the store cannot detect — JSON with a
 * truncated tail often still parses — so the write never happens in place.
 *
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

/**
 * Read one session's overlay.
 *
 * Never throws. An absent, unreadable or unparsable document all resolve to an empty
 * overlay, because "this session has no plan yet" is a normal state the page must render —
 * and it is the state a first long task starts from.
 *
 * The distinction between `absent` and `unparsable` is preserved in `source` so the page
 * can say "there is no plan here" versus "your plan file could not be read", which are
 * very different things to tell someone who believes they wrote one.
 *
 * @param {ReturnType<typeof storePaths>} paths - store paths.
 * @param {string} sessionId - session id.
 * @returns {{ok: true, delivery: object, warnings: string[], source: string, revision: number} | {ok: false, code: string, reason: string, source: string}}
 */
export function readDeliveryOverlay(paths, sessionId) {
  const problem = sessionIdProblem(sessionId)
  if (problem !== undefined) {
    return { ok: false, code: 'GOAL_INVALID_STATE', reason: problem, source: 'invalid-id' }
  }

  // "NOTHING IS THERE" AND "I CANNOT READ WHAT IS THERE" MUST NOT BE THE SAME ANSWER.
  //
  // This used to read the file with a `try/catch` and treat every failure — including a path
  // that is a directory, or a file locked by another process — as `absent`, i.e. "you have no
  // plan". That is the worst shape of bug this project keeps re-learning: the page then tells
  // the user their plan does not exist when it does, and the commit barrier asks the model to
  // reconcile against an empty plan it never wrote. So existence is now probed FIRST, and a
  // path that exists but cannot be read is a named failure like any other.
  let raw
  try {
    raw = readFileSync(sessionFile(paths, sessionId), 'utf8')
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Genuinely nothing stored for this session — a normal first-run state.
      const normalized = normalizeDelivery({ version: 1, sessionId }, sessionId)
      return { ok: true, delivery: normalized.delivery, warnings: [], source: 'absent', revision: 0 }
    }
    // EISDIR, EACCES, EPERM, EBUSY… something IS there and this process cannot read it.
    return {
      ok: false,
      code: 'GOAL_INVALID_STATE',
      reason: `目标状态文件读不出来（${code ?? 'unknown'}）：${sessionFile(paths, sessionId)}`,
      source: 'unreadable',
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      code: 'GOAL_INVALID_STATE',
      reason: `目标状态文件解析失败：${error instanceof Error ? error.message : String(error)}`,
      source: 'unparsable',
    }
  }

  const normalized = normalizeDelivery(parsed, sessionId)
  if (!normalized.ok) return { ...normalized, source: 'version' }
  return {
    ok: true,
    delivery: normalized.delivery,
    warnings: normalized.warnings,
    source: 'file',
    revision: normalized.delivery.revision,
  }
}

/**
 * Validate a session id before it becomes a path component.
 * @returns {string|undefined} an error message, or undefined when it is usable.
 */
export function sessionIdProblem(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return '缺少会话 id'
  if (!SESSION_ID.test(sessionId)) return `会话 id ${JSON.stringify(sessionId)} 含非法字符`
  return undefined
}

/**
 * Persist one overlay under compare-and-set.
 *
 * The caller must present the revision it read. A mismatch is refused with
 * GOAL_STALE_REVISION and the CURRENT state is returned alongside, so the loser of a race
 * can show the real state instead of guessing at it — the same policy `preset-routes.mjs`
 * applies with its 409.
 *
 * @param {ReturnType<typeof storePaths>} paths - store paths.
 * @param {string} sessionId - session id.
 * @param {object} delivery - the next document.
 * @param {number} expectedRevision - the revision the caller read.
 * @returns {{ok: true, revision: number} | {ok: false, code: string, reason: string, current?: object}}
 */
export function writeDeliveryOverlay(paths, sessionId, delivery, expectedRevision) {
  const problem = sessionIdProblem(sessionId)
  if (problem !== undefined) return { ok: false, code: 'GOAL_INVALID_STATE', reason: problem }

  const existing = readDeliveryOverlay(paths, sessionId)
  if (!existing.ok) return { ok: false, code: existing.code, reason: existing.reason }

  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== existing.revision) {
    return {
      ok: false,
      code: 'GOAL_STALE_REVISION',
      reason: `交付状态已被其他写入者更新：你基于修订 ${expectedRevision}，当前是 ${existing.revision}。请重新读取后再提交。`,
      current: existing.delivery,
    }
  }

  const next = { ...delivery, version: 1, sessionId, revision: existing.revision + 1, updatedAt: delivery.updatedAt || Date.now() }
  writeFileAtomic(sessionFile(paths, sessionId), `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, revision: next.revision }
}

/**
 * Delete one session's overlay.
 *
 * Only ever called for an explicit user request — this is the destructive path and the
 * route asks for confirmation before reaching it.
 *
 * @returns {{removed: boolean}}
 */
export function removeDeliveryOverlay(paths, sessionId) {
  const problem = sessionIdProblem(sessionId)
  if (problem !== undefined) return { removed: false }
  const path = sessionFile(paths, sessionId)
  try {
    if (!existsSync(path)) return { removed: false }
    unlinkSync(path)
    return { removed: true }
  } catch {
    return { removed: false }
  }
}

// ---------------------------------------------------------------- artifact opt-in

/**
 * Whether automatic artifact projection is enabled, and where it was enabled.
 *
 * The workspace write is opt-in and the choice is remembered per session. A feature that
 * starts writing `.agent/goal.md` into someone's repository on its own would be a write
 * into a user's project that they never asked for — §7.1's "先问再做" is exactly about
 * this kind of side effect.
 *
 * @returns {{enabled: boolean, sessions: Record<string, {cwd: string, enabledAt: number}>}}
 */
export function readArtifactFlags(paths) {
  const raw = readFileSafe(paths.flags)
  if (raw === undefined) return { enabled: false, sessions: {} }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { enabled: false, sessions: {} }
    const sessions = typeof parsed.sessions === 'object' && parsed.sessions !== null && !Array.isArray(parsed.sessions) ? parsed.sessions : {}
    const clean = {}
    for (const [id, value] of Object.entries(sessions)) {
      if (SESSION_ID.test(id) && typeof value === 'object' && value !== null && typeof value.cwd === 'string') {
        clean[id] = { cwd: value.cwd, enabledAt: typeof value.enabledAt === 'number' ? value.enabledAt : 0 }
      }
    }
    return { enabled: Object.keys(clean).length > 0, sessions: clean }
  } catch {
    // An unreadable flag file means "not enabled", which is the safe direction: it can
    // only ever cause a missing artifact, never an unwanted write.
    return { enabled: false, sessions: {} }
  }
}

/**
 * Remember (or forget) the artifact choice for one session.
 * @returns {{ok: boolean, enabled: boolean}}
 */
export function writeArtifactFlag(paths, sessionId, enabled, cwd) {
  const problem = sessionIdProblem(sessionId)
  if (problem !== undefined) return { ok: false, enabled: false }
  const flags = readArtifactFlags(paths)
  const sessions = { ...flags.sessions }
  if (enabled) sessions[sessionId] = { cwd: typeof cwd === 'string' ? cwd : '', enabledAt: Date.now() }
  else delete sessions[sessionId]
  try {
    writeFileAtomic(paths.flags, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`)
  } catch {
    return { ok: false, enabled: !enabled }
  }
  return { ok: true, enabled }
}

// ---------------------------------------------------------------- artifact projection

/**
 * Write the `.agent/goal.md` projection into a workspace.
 *
 * `cwd` is the SESSION's working directory, taken from the session header by the caller —
 * never from a request body. A path supplied by a caller would let the page write a file
 * anywhere on disk, which is not a power a renderer should have.
 *
 * @param {string} cwd - absolute workspace directory.
 * @param {object} delivery - normalized overlay.
 * @param {object|null} runtimeGoal - the live goal view.
 * @param {number} now - epoch ms, supplied so the projection stays deterministic.
 * @returns {{ok: true, path: string, bytes: number, changed: boolean} | {ok: false, reason: string}}
 */
export function writeArtifact(cwd, delivery, runtimeGoal, now) {
  if (typeof cwd !== 'string' || cwd === '') return { ok: false, reason: '这个会话没有工作目录，无法确定 goal.md 的落点' }
  const absolute = resolve(cwd)
  const path = join(absolute, ARTIFACT_RELATIVE_PATH)
  const markdown = renderGoalMarkdown(delivery, runtimeGoal, { generatedAt: now, artifactPath: ARTIFACT_RELATIVE_PATH })
  try {
    // Only rewrite when the bytes actually differ. Writing an identical file would churn
    // its mtime on every page load, which turns a no-op into a Git diff and makes the
    // artifact's own history useless (brief §47).
    const previous = readFileSafe(path)
    if (previous === markdown) return { ok: true, path, bytes: Buffer.byteLength(markdown, 'utf8'), changed: false }
    writeFileAtomic(path, markdown)
    return { ok: true, path, bytes: Buffer.byteLength(markdown, 'utf8'), changed: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read the artifact back, for the page's raw view.
 *
 * Reading the file rather than re-rendering is the point: the raw view must show what is
 * actually on disk, or it would be unable to reveal the one failure this view exists to
 * expose — that the file is stale relative to the state.
 *
 * @returns {{exists: boolean, path: string|null, text: string|null, bytes: number, mtime: number|null}}
 */
export function readArtifact(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return { exists: false, path: null, text: null, bytes: 0, mtime: null }
  const path = join(resolve(cwd), ARTIFACT_RELATIVE_PATH)
  try {
    const stat = statSync(path)
    const text = readFileSync(path, 'utf8')
    return { exists: true, path, text, bytes: stat.size, mtime: stat.mtimeMs }
  } catch {
    return { exists: false, path, text: null, bytes: 0, mtime: null }
  }
}

/**
 * List every session that has a stored overlay. Diagnostics only.
 * @returns {string[]} session ids.
 */
export function listStoredSessions(paths) {
  try {
    return readdirSync(paths.dir)
      .filter((name) => name.endsWith('.json') && name !== ARTIFACT_FLAG_FILE)
      .map((name) => name.slice(0, -5))
      .filter((id) => SESSION_ID.test(id))
  } catch {
    return []
  }
}
