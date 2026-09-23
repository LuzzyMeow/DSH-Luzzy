/**
 * Static chain audit for the 「预设」 sub-page: do the halves actually agree?
 *
 * WHY THIS EXISTS
 *
 * This feature is split across four artifacts that are edited independently and cannot
 * import each other:
 *
 *   src/client.js        the frame document + the client half (both live in this file)
 *   lib/client.js        the BUILT product of the above
 *   lib/preset-ops.mjs   the host operations
 *   lib/preset-routes.mjs the host HTTP surface
 *   luzzy-preset/lib/persona.mjs  the preset row that consumes the store
 *
 * Every one of them can be individually correct while the CHAIN is broken. That is not
 * hypothetical — it is exactly how this feature shipped two real bugs:
 *
 *   * the page called `resolveWorkspace`, an operation that existed only in the HOST bundle,
 *     which does not hot-reload while the client does. Real error:
 *     `未知操作 "resolveWorkspace"`.
 *   * one postMessage channel carried two conversations (the session answer and the create
 *     result) and the receiver dispatched on source alone, so a create reply was read as
 *     "your session is null".
 *
 * Neither was catchable by a unit test of either half, and neither was visible in a
 * screenshot. They are only visible as a DISAGREEMENT between artifacts — which is what
 * this tool measures.
 *
 * WHAT IT IS NOT
 *
 * It does not run anything. It cannot prove a route works; the dynamic rig
 * (review-preset-rig.mjs) does that. This is the fast, cheap net that runs before it.
 *
 * Usage: node tools/review-preset-chain.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_ROOT = join(PLUGIN_ROOT, '..')
const PLACEHOLDER = '/*__FONT_FACE_CSS__*/'

const failures = []
const warnings = []
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}

function warn(label, detail) {
  warnings.push(`${label} — ${detail}`)
  console.log(`  warn ${label} — ${detail}`)
}

function read(rel) {
  return readFileSync(join(PLUGIN_ROOT, rel), 'utf8')
}

/** All matches of a global regex, as plain strings. */
function all(source, regex) {
  const found = []
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
  let m
  while ((m = re.exec(source)) !== null) found.push(m[1] ?? m[0])
  return found
}

const sorted = (list) => [...new Set(list)].sort()

const src = read('src/client.js')
const built = read('lib/client.js')
const ops = read('lib/preset-ops.mjs')
const routes = read('lib/preset-routes.mjs')
const hostIndex = read('lib/index.js')
const persona = readFileSync(join(WORKSPACE_ROOT, 'luzzy-preset', 'lib', 'persona.mjs'), 'utf8')

// ---------------------------------------------------------------- 1. operation coverage

console.log('1. operations: everything the page sends is something the host accepts')

// What the client half and the frame send. Both halves live in src/client.js.
const clientOps = sorted(all(src, /op:\s*'([A-Za-z]+)'/g))

// What the host accepts, from its three dispatch sites. Read from source rather than
// hardcoded, so adding an op to either side without the other is what this catches.
const rosterOps = all(ops, /export const ROSTER_OPS = new Set\(\[([\s\S]*?)\]\)/)
  .flatMap((block) => all(block, /'([A-Za-z]+)'/g))
const mutationOps = all(ops, /if \(op === '([A-Za-z]+)'\)/g)
const routeOps = all(routes, /if \(op === '([A-Za-z]+)'\)/g)
const hostOps = sorted([...rosterOps, ...mutationOps, ...routeOps])

console.log(`       client sends: ${clientOps.join(', ')}`)
console.log(`       host accepts: ${hostOps.join(', ')}`)

const unsupported = clientOps.filter((op) => !hostOps.includes(op))
check(
  'every op the page sends is handled by the host',
  unsupported.length === 0,
  unsupported.length === 0
    ? ''
    : `host would answer 400 未知操作 for: ${unsupported.join(', ')} — this is the exact shape of the resolveWorkspace outage`,
)

// Informational: a host op nothing calls is dead weight, not a bug. Worth saying out loud
// because a dead route reads as "we already handle that" to the next person.
const unused = hostOps.filter((op) => !clientOps.includes(op))
for (const op of unused) {
  if (op === 'resolveWorkspace') {
    warn(
      `host still handles "${op}" but nothing calls it`,
      'the client resolves the workspace itself now (a host route cannot hot-reload). Left in place deliberately; delete it only together with the decision to keep all create logic client-side',
    )
  } else if (op === 'reload') {
    // Not dead: the frame uses it as an explicit refresh path in some states.
    continue
  } else {
    warn(`host handles "${op}" but the page never sends it`, 'unused host surface')
  }
}

check('the host rejects unknown ops loudly', /未知操作/.test(ops), 'applyMutation must not silently ignore an unknown op')

// ---------------------------------------------------------------- 2. revision guard parity

console.log('\n2. concurrency: the ops the host guards are the ops the page stamps')

const guarded = sorted(
  all(src, /const REVISION_GUARDED = \{([\s\S]*?)\}/).flatMap((block) => all(block, /([A-Za-z]+):\s*1/g)),
)
console.log(`       guarded: ${guarded.join(', ')}`)

// The invariant that matters: any op the page sends that the host treats as a roster write
// must carry a revision, or the host's 409 check can never fire and concurrent edits
// clobber silently. (That was a real defect: every roster write omitted it.)
const sendsRosterOp = clientOps.filter((op) => rosterOps.includes(op))
const unguarded = sendsRosterOp.filter((op) => !guarded.includes(op))
check(
  'every roster op the page sends is revision-guarded',
  unguarded.length === 0,
  unguarded.length === 0 ? '' : `unguarded: ${unguarded.join(', ')} — a 409 could never fire for these`,
)

const guardedButUnsent = guarded.filter((op) => !clientOps.includes(op))
if (guardedButUnsent.length > 0) {
  warn(
    `guarded but never sent: ${guardedButUnsent.join(', ')}`,
    'harmless — the revision is simply never attached because the op is never posted',
  )
}

check(
  'the guard is attached centrally, not per call site',
  /REVISION_GUARDED\[payload\.op\] === 1/.test(src),
  'attaching it per call site is how it got missed on five of them',
)

// ---------------------------------------------------------------- 3. postMessage protocol

console.log('\n3. protocol: one channel, every message typed, receiver dispatches on type')

const frameToHost = sorted(
  all(src, /postMessage\(\{\s*source:\s*'luzzy-page-frame',\s*type:\s*'([a-z-]+)'/g),
)
const hostToFrame = sorted(
  all(src, /postMessage\(\{\s*source:\s*'luzzy-page-host',\s*type:\s*'([a-z-]+)'/g),
)
const dispatched = sorted([...all(src, /data\.type === '([a-z-]+)'/g), ...all(src, /data\.type !== '([a-z-]+)'/g)])

console.log(`       frame -> host: ${frameToHost.join(', ')}`)
console.log(`       host -> frame: ${hostToFrame.join(', ')}`)
console.log(`       dispatched on: ${dispatched.join(', ')}`)

check('the frame sends at least the session handshake and the create request', frameToHost.length >= 2, frameToHost.join(', '))
check('the host answers both', hostToFrame.includes('session') && hostToFrame.includes('session-created'), hostToFrame.join(', '))

const undelivered = [...frameToHost, ...hostToFrame].filter((type) => !dispatched.includes(type))
check(
  'every message type is dispatched on somewhere',
  undelivered.length === 0,
  undelivered.length === 0 ? '' : `sent but never matched: ${undelivered.join(', ')}`,
)

// The specific lesson: the session id may only be written by the session ANSWER. Accepting
// any host message let a create reply (which carries no sessionId) be read as null.
check(
  'only the session answer may change the session id',
  /if \(data\.type !== 'session'\) return/.test(src),
  'without this, a session-created reply is read as "your session is null"',
)
check(
  'the create result is awaited by its own type',
  /data\.type !== 'session-created'/.test(src),
  'the frame must not treat any host message as the create result',
)
check(
  'the host listener filters on the frame source before trusting anything',
  /data\.source !== 'luzzy-page-frame'/.test(src),
)

// ---------------------------------------------------------------- 4. route paths

console.log('\n4. routes: every path the page fetches is registered by the host')

const fetched = sorted(all(src, /'(\/__luzzy\/[a-z]+)'/g))
const registered = sorted([
  ...all(hostIndex, /path:\s*'(\/__luzzy\/[a-z]+)'/g),
  ...all(routes, /path:\s*'(\/__luzzy\/[a-z]+)'/g),
])
console.log(`       fetched:    ${fetched.join(', ')}`)
console.log(`       registered: ${registered.join(', ')}`)

const unrouted = fetched.filter((path) => !registered.includes(path))
check(
  'every fetched path is registered',
  unrouted.length === 0,
  unrouted.length === 0 ? '' : `no handler for: ${unrouted.join(', ')}`,
)

// ---------------------------------------------------------------- 5. snapshot fields

console.log('\n5. payload: every field the page reads is one the host produces')

const produced = sorted([
  ...all(ops, /buildSnapshot\(\{([\s\S]*?)\n\}\)/).flatMap((block) => all(block, /^\s{4}([A-Za-z]+)[,:]/gm)),
  ...all(ops, /^\s{4}([A-Za-z]+):/gm),
])
// Fields the routes add on top of the snapshot (applied / saved / archived) or that the
// readPrompt reply carries. Scanned as object keys in the host sources.
const extra = sorted([...all(routes, /^\s{6}([A-Za-z]+):/gm), ...all(ops, /^\s{6}([A-Za-z]+):/gm)])
const hostFields = sorted([...produced, ...extra])

const consumed = sorted([
  ...all(src, /presetSnapshot\.([A-Za-z]+)/g),
  ...all(src, /presetSnapshot && presetSnapshot\.([A-Za-z]+)/g),
  ...all(src, /payload\.([A-Za-z]+)/g),
])
console.log(`       consumed: ${consumed.join(', ')}`)

// Only assert on the snapshot fields — `payload` is also used for the readPrompt reply and
// the error body, whose shapes are checked by the host route suite.
const snapshotConsumed = sorted(all(src, /presetSnapshot\.([A-Za-z]+)/g))
const missing = snapshotConsumed.filter((field) => !hostFields.includes(field))
check(
  'every snapshot field the page reads is produced by the host',
  missing.length === 0,
  missing.length === 0
    ? ''
    : `page would render undefined for: ${missing.join(', ')} — the host stopped sending these`,
)

// ---------------------------------------------------------------- 6. preset variable wiring

console.log('\n6. preset: the section references the variable the row registers')

const registeredVar = all(persona, /const PERSONA_VARIABLE = '([a-z0-9_]+)'/g)

// The section text is written as an interpolated template (`{{${PERSONA_VARIABLE}}}`), so a
// plain {{name}} pattern finds nothing and would report a failure against correct code —
// which it did, on this check's first run. Resolve the constant first, then look for BOTH
// spellings: the interpolated one that is actually used, and a literal one in case someone
// inlines the name later.
const resolvedVar = registeredVar.length === 1 ? registeredVar[0] : null
const referencedVars = sorted([
  ...(resolvedVar === null ? [] : all(persona, /text: `\{\{\$\{PERSONA_VARIABLE\}\}\}`/g).map(() => resolvedVar)),
  ...all(persona, /text: `\{\{([a-z0-9_]+)\}\}`/g),
  ...all(persona, /text: '\{\{([a-z0-9_]+)\}\}'/g),
])
console.log(`       registered: ${registeredVar.join(', ')}`)
console.log(`       referenced: ${referencedVars.join(', ')}`)

check('the row registers exactly one persona variable', registeredVar.length === 1, registeredVar.join(', '))
check(
  'the section references exactly that variable',
  resolvedVar !== null && referencedVars.length === 1 && referencedVars[0] === resolvedVar,
  `registered ${registeredVar.join(',') || '(none)'} but referenced ${referencedVars.join(',') || '(none)'} — assembly would throw on an unknown reference`,
)

// The load-bearing property: the section text is ONLY the reference. If the prompt itself
// were placed here it would be re-scanned by renderPrompt, and a single stray {{...}} inside
// a user's prompt would throw on every request. Measured on the trimmed text so indentation
// and a trailing newline do not count as "carrying content".
const personaSectionTexts = all(persona, /PERSONA_PREFIX_SECTION,[\s\S]*?text:\s*(`[^`]*`|'[^']*')/)
const prefixText = personaSectionTexts.length === 1 ? personaSectionTexts[0].slice(1, -1) : null
check(
  'the persona section text is a constant reference, not the prompt itself',
  prefixText !== null && prefixText.trim() === '{{${PERSONA_VARIABLE}}}',
  prefixText === null
    ? 'could not locate the persona-prefix section text'
    : `section text is ${JSON.stringify(prefixText)} — section text IS re-scanned, so user text here turns a stray brace into a failed request`,
)
check(
  'the persona section text carries no newlines',
  prefixText !== null && !prefixText.includes('\n'),
  'a multi-line section text is a sign the prompt was moved in here instead of its variable',
)

// The variable name the preset uses must match what the section names, and the section name
// must still be the deployment persona one — otherwise the row does not shadow it.
check(
  'the row still targets the deployment persona section',
  /deployment:persona-prefix/.test(persona) && /getSectionOrder\('DEPLOYMENT_PERSONA_PREFIX'\)/.test(persona),
  'a different section name would leave the shipped persona in place and stack on top of it',
)

// ---------------------------------------------------------------- 7. artifact freshness

console.log('\n7. build: lib/client.js is the current product of src/client.js')

const idx = src.indexOf(PLACEHOLDER)
if (!check('the source carries the font placeholder', idx >= 0, PLACEHOLDER)) {
  // Nothing further can be checked without the anchor.
} else {
  const head = src.slice(0, idx)
  const tail = src.slice(idx + PLACEHOLDER.length)
  const at = built.indexOf(head)

  check('the build contains the source verbatim up to the placeholder', at >= 0, 'lib/client.js does not contain the current src/client.js')
  check('the build ends with the source verbatim after the placeholder', built.endsWith(tail), 'the tail of the source is missing from the build')

  if (at >= 0 && built.endsWith(tail)) {
    const injected = built.slice(at + head.length, built.length - tail.length)
    check('the placeholder was expanded with the fonts', injected.includes('@font-face'), `${injected.length} bytes injected`)
    check(
      'the build is not stale',
      true,
      '',
    )
    if (injected.length < 1000) {
      warn('the injected font CSS is suspiciously small', `${injected.length} bytes — did the subset step run?`)
    }
  } else {
    // This is the failure that matters most: the running app loads lib/client.js, so an
    // unbuilt src change means the code being reviewed is not the code being executed.
    failures.push('the build is stale — run: python tools/build-font-css.py')
    console.log('  FAIL the build is stale — run: python tools/build-font-css.py')
    checks += 1
  }
}

// ---------------------------------------------------------------- 8. installed preset

console.log('\n8. install: the preset in DSH home matches this repo')

const { existsSync } = await import('node:fs')
const os = await import('node:os')
const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const presetDir = join(dshHome, '.agent-presets', 'luzzy-mode')

if (!existsSync(presetDir)) {
  warn('the preset is not installed', `expected at ${presetDir} — run: node tools/install-preset.mjs --apply`)
} else {
  const { createHash } = await import('node:crypto')
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const pairs = [
    ['preset.yml', join(WORKSPACE_ROOT, 'luzzy-preset', 'preset.yml'), join(presetDir, 'preset.yml')],
    ['agent.cordis.yml', join(WORKSPACE_ROOT, 'luzzy-preset', 'agent.cordis.yml'), join(presetDir, 'agent.cordis.yml')],
    ['lib/persona.mjs', join(WORKSPACE_ROOT, 'luzzy-preset', 'lib', 'persona.mjs'), join(presetDir, 'lib', 'persona.mjs')],
    ['lib/preset-store.mjs', join(WORKSPACE_ROOT, 'luzzy-preset', 'lib', 'preset-store.mjs'), join(presetDir, 'lib', 'preset-store.mjs')],
  ]
  let drifted = 0
  for (const [label, repoPath, installedPath] of pairs) {
    if (!existsSync(installedPath)) {
      drifted += 1
      console.log(`  FAIL ${label} is missing from the installed preset`)
      failures.push(`${label} missing from the installed preset`)
      checks += 1
      continue
    }
    if (hash(repoPath) !== hash(installedPath)) {
      drifted += 1
      console.log(`  FAIL ${label} differs from the repo copy`)
      failures.push(`${label} differs from the installed preset copy`)
      checks += 1
    } else {
      console.log(`  ok   ${label} identical`)
      checks += 1
    }
  }
  if (drifted > 0) {
    console.log('       re-install with: node tools/install-preset.mjs --apply')
  }
  // The persona row resolves its store from DSH home, so the installed copy must not carry
  // its own agents/ directory — that was a real defect where the seed was written into the
  // preset instead of the store and the reader silently fell back to 239 characters.
  check(
    'the installed preset holds no agents/ directory',
    !existsSync(join(presetDir, 'agents')),
    'prompts belong to the STORE, not the preset — a preset-local copy means the reader reads something else',
  )
}

// ---------------------------------------------------------------- report

console.log('')
console.log(`chain audit: ${checks - failures.length} of ${checks} checks passed`)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  - ${w}`)
}
if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('PASS — the halves agree')
