// Verify the runtime route derives real facts from real logs.
//
// The route is only worth building if every field it reports comes from an event that
// actually exists. This runs the real builder against this machine's real session logs and
// prints what it found, then asserts the shape the pages depend on.
//
// It is not a stub test: a fake log would prove the parser handles my own assumptions.
//
// Usage: node tools/test-runtime-routes.mjs

import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// A dynamic import needs a file:// URL on Windows — a bare `C:\...` path is rejected by the
// ESM loader with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const { buildRuntimeSnapshot, readRuntimeFromLog } = await import(
  pathToFileURL(join(PLUGIN_ROOT, 'lib', 'runtime-routes.mjs')).href
)

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const deps = { home, pluginVersion: 'test' }

// ---------------------------------------------------------------- real data

const latest = buildRuntimeSnapshot(deps, null)

check('a snapshot is produced without a session id', latest !== null && typeof latest === 'object')
if (latest.ok === true) {
  notes.push(`  info latest session: ${latest.sessionId}`)
  notes.push(`  info turns=${latest.currentTurn} completed=${latest.turnsCompleted} steps=${latest.steps} tools=${latest.toolCalls}`)
  notes.push(`  info elapsedMs=${latest.elapsedMs} toolKinds=${latest.toolList.length}`)
  check('current turn is a non-negative integer', Number.isInteger(latest.currentTurn) && latest.currentTurn >= 0)
  check('tool calls counted', Number.isInteger(latest.toolCalls) && latest.toolCalls >= 0)
  check('steps counted', Number.isInteger(latest.steps) && latest.steps >= 0)
  check('toolList is an array of {name, count}', Array.isArray(latest.toolList))
  check('recentCalls is newest-first', Array.isArray(latest.recentCalls) &&
    (latest.recentCalls.length < 2 || latest.recentCalls[0].at >= latest.recentCalls[1].at))
  check('elapsed is not negative', Number.isInteger(latest.elapsedMs) && latest.elapsedMs >= 0)
  check('openedAt precedes endedAt', latest.openedAt !== null && latest.endedAt !== null && latest.openedAt <= latest.endedAt)
  check('context carries provider+model when present', latest.context === null ||
    (typeof latest.context.provider === 'string' && typeof latest.context.model === 'string'))
  // Rule-file detection must require a READ-shaped tool AND the name in its arguments.
  // Matching on arguments alone reported every rule file as loaded on this machine, because
  // those names also appear in file CONTENT passed to write/edit.
  check('ruleFiles is an array', Array.isArray(latest.ruleFiles))
  const routeText = readFileSync(join(PLUGIN_ROOT, 'lib', 'runtime-routes.mjs'), 'utf8')
  check('rule detection requires a read-shaped tool', /READ_TOOL\.test\(name\)/.test(routeText) &&
    /const READ_TOOL = /.test(routeText),
    'argument matching alone over-reports: file content mentioning AGENTS.md is not a read')
  // The detection must actually be capable of firing — an always-empty list would make the
  // 「项目规则」 row permanently claim "未见读取记录" on every machine.
  {
    let scanned = 0
    let withRule = 0
    const dir = join(home, 'sessions')
    // Scan a handful of real logs through the real reader to prove the positive case exists.
    const { readdirSync } = await import('node:fs')
    const walkLogs = (root, depth, out) => {
      if (depth > 4) return out
      let entries
      try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
      for (const entry of entries) {
        const full = join(root, entry.name)
        if (entry.isDirectory()) walkLogs(full, depth + 1, out)
        else if (entry.name.endsWith('.jsonl.zstd')) out.push(full)
      }
      return out
    }
    const all = walkLogs(dir, 0, []).slice(0, 40)
    for (const path of all) {
      const facts = readRuntimeFromLog(path)
      if (facts === null) continue
      scanned += 1
      if (facts.ruleFiles.length > 0) withRule += 1
    }
    check('rule detection fires on real logs (not permanently empty)', scanned === 0 || withRule > 0,
      `scanned ${scanned}, with rule reads ${withRule}`)
    notes.push(`  info rule-read logs: ${withRule} / ${scanned} scanned`)
  }
  // The whole point of the route: real numbers, not placeholders.
  if (latest.toolCalls > 0) {
    check('tool counts sum to the total', latest.toolList.reduce((sum, row) => sum + row.count, 0) === latest.toolCalls,
      `${latest.toolList.reduce((s, r) => s + r.count, 0)} vs ${latest.toolCalls}`)
  }
} else {
  notes.push(`  info latest snapshot reported ok:false (${latest.reason}): ${latest.message}`)
}

// ---------------------------------------------------------------- invalid input

const bad = buildRuntimeSnapshot(deps, 'not-a-session-id')
check('an invalid session id is rejected, not guessed at', bad.ok === false && bad.reason === 'invalid-session-id',
  JSON.stringify(bad.reason))

const missing = buildRuntimeSnapshot(deps, 'session-00000000-0000-0000-0000-000000000000')
check('an unknown session is reported as missing, not as zero activity',
  missing.ok === false && missing.reason === 'session-log-missing', JSON.stringify(missing.reason))

// ---------------------------------------------------------------- the route contract

const routeSource = readFileSync(join(PLUGIN_ROOT, 'lib', 'runtime-routes.mjs'), 'utf8')
check('the route is read-only (no write imports)', !/writeFileSync|appendFileSync|rmSync|unlinkSync/.test(routeSource))
check('the route registers an exact path', routeSource.includes("path: '/__luzzy/runtime'"))
check('the route rejects non-GET', routeSource.includes('执行状态读取需要 GET'))
check('the route rejects non-local callers', routeSource.includes('luzzy runtime is local-only'))
check('registration goes through ctx.effect', /ctx\.effect\(\s*\(\)\s*=>\s*ctx\.webServer\.register/.test(routeSource))

// It must be wired into the host half, or the page gets a 404 and reports "no data".
const hostSource = readFileSync(join(PLUGIN_ROOT, 'lib', 'index.js'), 'utf8')
check('the host half registers the runtime route', hostSource.includes('registerRuntimeRoutes'))
check('the host half passes the plugin version', /registerRuntimeRoutes\(ctx,\s*\{/.test(hostSource))

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} assertions (runtime routes, real logs)`)
