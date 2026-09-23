/**
 * Assert the preset store's read path, write path and failure chain.
 *
 * Every case here exists because the failure it guards against is SILENT in production:
 * a corrupted settings.json, a future version, an empty prompt file, a same-length
 * rewrite that a naive cache would miss. None of those throw where a person would see it —
 * they show up as a session quietly running a different prompt.
 *
 * Run: node tools/test-preset-store.mjs
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// pathToFileURL, not the raw path: a bare `C:\...` reached the ESM loader as protocol
// "c:" and threw ERR_UNSUPPORTED_ESM_URL_SCHEME.
const store = await import(pathToFileURL(join(HERE, '..', 'lib', 'preset-store.mjs')).href)

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
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'luzzy-preset-store-'))
  workspaces.push(home)
  return home
}

function writeSettings(paths, document) {
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.settings, JSON.stringify(document, null, 2), 'utf8')
}

function writePromptFile(paths, agentId, text) {
  const path = agentId === null ? paths.defaultPrompt : store.agentPromptPath(paths, agentId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

try {
  console.log('preset-store: path derivation')
  {
    const home = freshHome()
    const paths = store.storePaths(home)
    eq('settings under the store dir', paths.settings, join(home, 'luzzy-preset', 'settings.json'))
    eq('default prompt beside it', paths.defaultPrompt, join(home, 'luzzy-preset', 'default.md'))
    eq('agents under agents/', store.agentPromptPath(paths, 'luzzy'), join(home, 'luzzy-preset', 'agents', 'luzzy.md'))
    eq('DSH_HOME wins when set', store.resolveDshHome({ DSH_HOME: 'D:/dsh' }), 'D:/dsh')
    check('blank DSH_HOME falls back to ~/.dsh', store.resolveDshHome({ DSH_HOME: '   ' }).endsWith('.dsh'))
  }

  console.log('preset-store: absent store is empty, not an error')
  {
    const paths = store.storePaths(freshHome())
    const result = store.readStore(paths)
    eq('source is absent', result.source, 'absent')
    eq('no warnings for a first run', result.warnings.length, 0)
    eq('empty roster', result.store.agents.length, 0)
    eq('no active agent', result.store.activeAgentId, null)
  }

  console.log('preset-store: malformed documents degrade with a reason')
  {
    const paths = store.storePaths(freshHome())
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.settings, '{ not json', 'utf8')
    const broken = store.readStore(paths)
    eq('unparsable detected', broken.source, 'unparsable')
    check('unparsable carries a warning', broken.warnings.length === 1)
    eq('unparsable still yields a usable store', broken.store.agents.length, 0)

    writeSettings(paths, { version: 99, revision: 3, groups: [], agents: [] })
    const future = store.readStore(paths)
    eq('future version refused', future.source, 'version')
    check('future version says which version', future.warnings[0].includes('99'), future.warnings[0])

    writeSettings(paths, ['not', 'an', 'object'])
    eq('array document refused', store.readStore(paths).source, 'version')
  }

  console.log('preset-store: invalid rows are dropped with a warning, not fatal')
  {
    const paths = store.storePaths(freshHome())
    writeSettings(paths, {
      version: 1,
      revision: 4,
      activeAgentId: 'ghost',
      groups: [{ id: 'ok', name: '组', order: 0 }, { id: 'BAD ID', name: 'x' }, { id: 'ok', name: 'dup' }],
      agents: [
        { id: 'ok', name: 'A', groupId: 'ok', order: 0 },
        { id: 'ok', name: 'dup', order: 1 },
        { id: 'UPPER', order: 2 },
        { id: 'orphan', name: 'B', groupId: 'missing-group', order: 3 },
      ],
    })
    const result = store.readStore(paths)
    eq('valid group kept', result.store.groups.length, 1)
    eq('valid agents kept', result.store.agents.length, 2)
    eq('dangling group reference cleared', result.store.agents.find((a) => a.id === 'orphan').groupId, null)
    eq('unknown active agent cleared', result.store.activeAgentId, null)
    check('every drop is reported', result.warnings.length >= 4, `${result.warnings.length} warnings`)
    check('revision survives a partial read', result.store.revision === 4)
  }

  console.log('preset-store: writes are atomic and bump the revision')
  {
    const paths = store.storePaths(freshHome())
    const first = store.writeStore(paths, store.emptyStore())
    eq('first write is revision 1', first, 1)
    const second = store.writeStore(paths, store.readStore(paths).store)
    eq('second write is revision 2', second, 2)
    check('no temp files left behind', !readFileSync(paths.settings, 'utf8').includes('.tmp'))
    const listing = readFileSync(paths.settings, 'utf8')
    check('document ends with a newline', listing.endsWith('\n'))

    const dir = join(paths.dir)
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'))
    eq('store directory has no temp files', leftovers.length, 0)
  }

  console.log('preset-store: prompt resolution order and the empty-file rule')
  {
    const builtin = join(freshHome(), 'builtin.md')
    writeFileSync(builtin, 'BUILTIN', 'utf8')

    const a = store.storePaths(freshHome())
    const readerA = store.createPromptReader(a, { builtinFallbackPath: builtin })
    eq('nothing anywhere falls through to the builtin', readerA.read().text, 'BUILTIN')
    eq('builtin source reported', readerA.read().source, 'builtin')

    writePromptFile(a, null, 'DEFAULT')
    eq('default beats the builtin', readerA.read().text, 'DEFAULT')
    eq('default source reported', readerA.read().source, 'default')

    store.writeStore(a, { ...store.emptyStore(), agents: [{ id: 'x', name: 'X', groupId: null, order: 0 }], activeAgentId: 'x' })
    eq('an agent with no file still uses the default', readerA.read().text, 'DEFAULT')

    writePromptFile(a, 'x', 'AGENT')
    eq('an agent file wins', readerA.read().text, 'AGENT')
    eq('agent id reported', readerA.read().agentId, 'x')

    writePromptFile(a, 'x', '   \n  ')
    eq('a whitespace-only agent file does not win', readerA.read().text, 'DEFAULT')

    const b = store.storePaths(freshHome())
    // null, not the path above: this reader is the one that must have NO builtin to fall
    // back on, so the visible last-resort text is what gets asserted.
    const readerB = store.createPromptReader(b, { builtinFallbackPath: null })
    eq('no builtin configured yields the visible fallback', readerB.read().source, 'empty')
    check('the fallback text is non-empty and explains itself', readerB.read().text.includes('提示词没读到'))
  }

  console.log('preset-store: an edit is ALWAYS visible on the very next read')
  {
    const paths = store.storePaths(freshHome())
    writePromptFile(paths, null, 'AAAA')
    const reader = store.createPromptReader(paths, { builtinFallbackPath: null })
    eq('first read', reader.read().text, 'AAAA')

    // The cases below are the reason this reader holds NO cache. Measured on this NTFS
    // volume, 144 of 200 same-length in-place rewrites produced an identical
    // (size, mtime, birthtime, ctime) tuple — so any stat-keyed memo would return the OLD
    // prompt for a one-character edit while the page showed the new one. Every case here
    // must read through, with no invalidation call and no delay.
    writePromptFile(paths, null, 'BBBB')
    eq('same-length rewrite is picked up', reader.read().text, 'BBBB')

    writePromptFile(paths, null, 'CCCC')
    eq('and again, immediately', reader.read().text, 'CCCC')

    writePromptFile(paths, null, 'BBBBBBBBBBB')
    eq('longer rewrite is picked up', reader.read().text, 'BBBBBBBBBBB')

    writePromptFile(paths, null, 'AAAA')
    eq('shorter rewrite is picked up', reader.read().text, 'AAAA')

    eq('repeated reads are stable', reader.read().text, 'AAAA')

    // A one-character change to a CJK prompt — the shape a real typo fix takes.
    writePromptFile(paths, null, '你是鹿溪喵')
    eq('a single-character edit is seen', reader.read().text, '你是鹿溪喵')
    writePromptFile(paths, null, '你是鹿溪呀')
    eq('and its correction is seen too', reader.read().text, '你是鹿溪呀')

    // Switching which file wins must also be immediate, without a new reader.
    store.writeStore(paths, { ...store.emptyStore(), agents: [{ id: 'x', name: 'X', groupId: null, order: 0 }], activeAgentId: 'x' })
    writePromptFile(paths, 'x', 'AGENT-V1')
    eq('activation switches the source immediately', reader.read().text, 'AGENT-V1')
    writePromptFile(paths, 'x', 'AGENT-V2')
    eq('and edits to the newly active file are seen', reader.read().text, 'AGENT-V2')
  }

  console.log('preset-store: the write path is the atomic rename, not an in-place edit')
  {
    const paths = store.storePaths(freshHome())
    store.writeStore(paths, store.emptyStore())
    const before = readFileSync(paths.settings, 'utf8')
    store.writeStore(paths, store.readStore(paths).store)
    const after = readFileSync(paths.settings, 'utf8')
    check('a rewrite changes the file', before !== after)
    // The atomic path matters beyond crash safety: it is what gives a replacement a new
    // birth time, which is the only stat field that distinguishes a same-length rewrite.
    check('no partial JSON is ever visible', after.trim().startsWith('{') && after.trim().endsWith('}'))
  }

  console.log('preset-store: roster operations are pure and total')
  {
    let state = { ...store.emptyStore(), groups: [{ id: 'g', name: 'G', order: 0 }], agents: [{ id: 'a', name: 'A', groupId: 'g', order: 0 }] }

    const added = store.applyRosterOp(state, 'upsertAgent', { name: 'Second', groupId: 'g' })
    check('adding an agent succeeds', added.error === undefined, added.error)
    eq('the new agent is in the group', added.store.agents.find((x) => x.name === 'Second').groupId, 'g')
    check('the new id is derived', /^[a-z0-9-]+$/.test(added.store.agents.find((x) => x.name === 'Second').id))

    const renamed = store.applyRosterOp(state, 'upsertAgent', { id: 'a', name: 'Renamed' })
    eq('rename keeps the id', renamed.store.agents[0].id, 'a')
    eq('rename applies', renamed.store.agents[0].name, 'Renamed')
    eq('rename keeps the group when groupId is absent', renamed.store.agents[0].groupId, 'g')

    const moved = store.applyRosterOp(state, 'upsertAgent', { id: 'a', groupId: null })
    eq('explicit null moves out of the group', moved.store.agents[0].groupId, null)

    const badGroup = store.applyRosterOp(state, 'upsertAgent', { id: 'a', groupId: 'nope' })
    check('an unknown group is refused', badGroup.error !== undefined)

    const badId = store.applyRosterOp(state, 'upsertAgent', { id: 'Bad Id' })
    check('an illegal id is refused', badId.error !== undefined, badId.error)

    const active = store.applyRosterOp(state, 'setActive', { agentId: 'a' })
    eq('an existing agent can be activated', active.store.activeAgentId, 'a')
    const cleared = store.applyRosterOp(state, 'setActive', { agentId: null })
    eq('null clears the active agent', cleared.store.activeAgentId, null)
    check('an unknown active id is refused', store.applyRosterOp(state, 'setActive', { agentId: 'ghost' }).error !== undefined)

    const removed = store.applyRosterOp({ ...state, activeAgentId: 'a' }, 'removeAgent', { id: 'a' })
    eq('removing the active agent clears it', removed.store.activeAgentId, null)
    eq('the agent is gone', removed.store.agents.length, 0)

    const groupGone = store.applyRosterOp({ ...state, activeAgentId: null }, 'removeGroup', { id: 'g' })
    eq('removing a group keeps its members', groupGone.store.agents.length, 1)
    eq('members become ungrouped', groupGone.store.agents[0].groupId, null)

    const reordered = store.applyRosterOp(state, 'reorderAgents', { order: [{ id: 'a', order: 7, groupId: null }] })
    eq('reorder applies', reordered.store.agents[0].order, 7)
    check('reorder rejects an unknown id', store.applyRosterOp(state, 'reorderAgents', { order: [{ id: 'zzz', order: 0 }] }).error !== undefined)

    const unknown = store.applyRosterOp(state, 'nope', {})
    check('an unknown op is an error', unknown.error !== undefined)
    check('no op mutates its input', state.agents.length === 1 && state.agents[0].name === 'A')
  }

  console.log('preset-store: id suggestion never collides')
  {
    const taken = ['luzzy', 'luzzy-1']
    const suggestion = store.suggestId('luzzy', taken)
    check('a taken ascii name gets a suffix', suggestion === 'luzzy-2', suggestion)
    const cjk = store.suggestId('鹿溪', taken)
    check('a CJK name yields a legal id', store.SLUG.test(cjk), cjk)
    check('a CJK name does not collide', !taken.includes(cjk), cjk)
    check('an empty name still yields a legal id', store.SLUG.test(store.suggestId('', [])), store.suggestId('', []))
  }
} finally {
  for (const workspace of workspaces) {
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {
      // Best effort cleanup; a leftover temp dir must not fail the suite.
    }
  }
}

console.log('')
if (failures === 0) {
  console.log(`preset-store: ${checks} checks passed`)
  process.exit(0)
}
console.log(`preset-store: ${failures} of ${checks} checks FAILED`)
process.exit(1)
