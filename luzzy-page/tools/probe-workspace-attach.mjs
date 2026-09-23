/**
 * Resolve the current session's directory to its owning workspace, on this machine.
 *
 * A read-only check of the logic the new-session path now uses: read the workspace registry
 * from `~/.dsh/storages/workspace.json`, canonicalize each registered path, and report which
 * one owns the directory the named session lives in.
 *
 * This exists because the failure it investigates was INVISIBLE from the plugin side: the
 * session was created successfully and simply never appeared, because it attached to no
 * workspace. Reading the registry directly is how "is this directory a registered workspace
 * at all?" becomes a fact rather than an assumption.
 *
 * Usage: node tools/probe-workspace-attach.mjs [--cwd <path>]
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

function canonical(path) {
  try {
    return realpathSync.native ? realpathSync.native(path) : realpathSync(path)
  } catch {
    return undefined
  }
}

console.log(`probe-workspace-attach: dsh home ${home}`)

const storagePath = join(home, 'storages', 'workspace.json')
if (!existsSync(storagePath)) {
  console.error(`probe: no workspace registry at ${storagePath}`)
  process.exit(1)
}

const document = JSON.parse(readFileSync(storagePath, 'utf8'))
const global = document.global ?? {}
const workspaceIds = Array.isArray(global.workspaceIds) ? global.workspaceIds : []
// The records live under `tables.workspaces`, keyed by id. An earlier version of this probe
// scanned a top-level `entities`/`data` key that does not exist, so it reported "no path
// record" for every workspace — a probe that cannot see the data is worse than no probe,
// because it looks like an answer.
const table = document.tables?.workspaces ?? {}
console.log(`  registered workspaces: ${workspaceIds.length}`)
console.log(`  records in the table:  ${Object.keys(table).length}`)

const rows = workspaceIds.map((id) => {
  const record = table[id]
  const path = typeof record?.path === 'string' ? record.path : undefined
  return {
    id,
    path,
    title: record?.title,
    canonical: path === undefined ? undefined : canonical(path),
    sessionIds: Array.isArray(record?.sessionIds) ? record.sessionIds : [],
  }
})

for (const row of rows) {
  const mark = row.canonical === undefined ? '✗' : '✓'
  console.log(`  ${mark} ${row.id}  ${row.path ?? '(no path record)'}  [${row.sessionIds.length} sessions]`)
}

const wanted = argValue('--cwd', null)
if (wanted === null) {
  console.log('')
  console.log('  pass --cwd <path> to see which of the above owns it')
} else {
  const target = canonical(wanted)
  console.log('')
  console.log(`  looking for the owner of: ${wanted}`)
  console.log(`  canonical:                ${target ?? 'CANNOT CANONICALIZE (does not exist?)'}`)
  const owner = rows.find((row) => row.canonical !== undefined && row.canonical === target)
  if (owner === undefined) {
    console.log('  → NO workspace owns this directory; a session created here would NOT appear in the sidebar')
  } else {
    console.log(`  → owned by workspace ${owner.id} (${owner.title})`)
    console.log(`    the plugin must send this id as workspaceId for the new session to appear`)
  }
}

// Which sessions are attached to nothing? That is the population the bug created.
//
// Matching is done by ID, so the ids are what matters here — and the id is NOT the filename
// stem for every layout. An earlier version derived ids from filenames and reported 215
// "orphans", nearly all of them artefacts like `session` and `session.v3` from nested
// directories. A wrong number in a diagnostic is worse than no number, so this reports only
// ids that look like real session ids and says how many it could not classify.
const attached = new Set()
for (const row of rows) for (const id of row.sessionIds) attached.add(id)
const archived = new Set(Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [])

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const { readdirSync } = await import('node:fs')
const candidates = []
let unclassified = 0
const walk = (dir, depth) => {
  if (depth > 4) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
    else if (entry.name.endsWith('.jsonl.zstd')) {
      const stem = entry.name.replace(/\.jsonl\.zstd$/, '')
      if (SESSION_ID.test(stem)) candidates.push(stem)
      else unclassified += 1
    }
  }
}
const sessionsDir = join(home, 'sessions')
if (existsSync(sessionsDir)) {
  try {
    walk(sessionsDir, 0)
  } catch {
    // A scan failure must not hide the report above.
  }
}

const orphans = candidates.filter((id) => !attached.has(id) && !archived.has(id))
console.log('')
console.log(`  session files that look like session ids: ${candidates.length}`)
console.log(`  …attached to no workspace and not archived: ${orphans.length}`)
for (const id of orphans) console.log(`    ${id}`)
if (unclassified > 0) console.log(`  (${unclassified} file(s) had a non-id name and were not classified)`)
