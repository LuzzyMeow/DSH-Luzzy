/**
 * Drive the REAL prompt assembly with the LuzzyMode persona row.
 *
 * WHY THIS EXISTS
 *
 * The entire design of this feature rests on one claim: a user's prompt must reach the model as
 * a prompt VARIABLE, never as section TEXT. `luzzy-preset/lib/persona.mjs` states the reason —
 * section text is re-scanned for `{{...}}` and an unknown reference THROWS, while a variable's
 * value is substituted verbatim and never re-scanned.
 *
 * Until now that claim was supported only by a stub: `test-preset-persona.mjs` drives a fake
 * `ctx.systemPrompt` that records what the row registers. A stub cannot prove a property of the
 * real interpolator — and if the claim were wrong, a user prompt containing `{{...}}` would
 * break every request, which is precisely the kind of failure that is invisible until a user
 * types a brace.
 *
 * So this file imports `@deepseek-ai/dsh-system-prompt` FROM THE DSH INSTALLATION and calls its
 * real exported `renderPrompt` against a real assembly built from the row's registrations.
 *
 * WHAT IS REAL
 *
 *   real   `renderPrompt` and its `interpolate` — the shipped implementation
 *   real   the section names and orders, read from the registry's own constants
 *   real   `persona.mjs` from this repo, mounted with a capturing `systemPrompt` facade
 *   real   the store: a temp DSH_HOME, read through the same module the preset uses
 *
 * WHAT IS MODELLED, AND WHY THAT IS SOUND HERE
 *
 *   `ctx.systemPrompt` is a small facade, because the real service is a cordis Service that
 *   needs a live context. The facade is NOT a looser stand-in: it captures sections and
 *   variables and hands them to the REAL renderer in the same shape `assemble()` produces. The
 *   property under test lives entirely in the renderer, which is the real one.
 *
 * A FALLBACK IS DECLARED, NOT ASSUMED
 *
 * If the package cannot be imported from this installation, this file reports the limitation
 * and exits 0 with a clear note rather than pretending to have verified anything. A silent
 * skip would be worse than a failure, because the suite would look green.
 *
 * Usage: node tools/test-preset-assembly.mjs
 *        DSH_APP="C:\Program Files\DSH Desktop\resources\app" node tools/test-preset-assembly.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_ROOT = join(PLUGIN_ROOT, '..')
const DSH_APP = process.env.DSH_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app'

const failures = []
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

// ---------------------------------------------------------------- the real registry

const promptModuleUrl = pathToFileURL(
  join(DSH_APP, 'node_modules', '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js'),
).href

let prompt
try {
  prompt = await import(promptModuleUrl)
} catch (error) {
  console.log(`  skip could not import the real system-prompt package: ${error.message}`)
  console.log('')
  console.log('PASS — 0 assertions (assembly verification skipped: the DSH package is unavailable)')
  console.log('       the stub-based coverage in test-preset-persona.mjs still applies;')
  console.log('       this suite exists precisely because that stub cannot prove the renderer property')
  process.exit(0)
}

const { renderPrompt } = prompt
check('the real package exports renderPrompt', typeof renderPrompt === 'function')

// ---------------------------------------------------------------- an isolated store

const dshHome = mkdtempSync(join(tmpdir(), 'luzzy-assembly-home-'))
process.env.DSH_HOME = dshHome
const storeDir = join(dshHome, 'luzzy-preset')
mkdirSync(join(storeDir, 'agents'), { recursive: true })

const settingsPath = join(storeDir, 'settings.json')
const writeSettings = (value) => writeFileSync(settingsPath, JSON.stringify(value, null, 2), 'utf8')
const writeAgentPrompt = (id, text) => writeFileSync(join(storeDir, 'agents', `${id}.md`), text, 'utf8')

writeSettings({
  version: 1,
  revision: 1,
  activeAgentId: 'luzzy',
  groups: [{ id: 'default', name: '默认', order: 0 }],
  agents: [
    { id: 'luzzy', name: '鹿溪', description: '', groupId: 'default', order: 0 },
    { id: 'engineer', name: '工程搭档', description: '', groupId: 'default', order: 1 },
  ],
})

const LUZZY_PROMPT = '# 你是鹿溪\n\n一只猫耳少年。\n'
const ENGINEER_PROMPT = '你是一名资深软件工程师。\n'
const HOSTILE_PROMPT = '示例：{{cwd}} 与 {{luzzy_persona}} 与 {{ 未知引用 }} 与 ${not_a_var} 与 `反引号`\n'
writeAgentPrompt('luzzy', LUZZY_PROMPT)
writeAgentPrompt('engineer', ENGINEER_PROMPT)
writeFileSync(join(storeDir, 'default.md'), '默认提示词。\n', 'utf8')

// ---------------------------------------------------------------- mount the real row

/**
 * A capturing facade with the shape the real service presents to a row.
 *
 * `getSectionOrder` returns the REAL registry numbers. They are not exported, but the real
 * service exposes them through this very method — so the numbers are read from a real
 * `SystemPrompt`-shaped surface rather than guessed. Getting them wrong would silently test a
 * different ordering than the one DSH ships.
 *
 * The real table has `DEPLOYMENT_PERSONA_PREFIX: 0` and the suffix at 10200, and
 * `persona.mjs` passes both through `getSectionOrder`. If a future registry renumbers them, the
 * assertion below ("the row's orders match the registry's") is what catches the drift.
 */
const sections = new Map()
const variables = new Map()
const effects = []

/**
 * The registry's order values, read from the real module's own source table.
 *
 * The table is module-private, so the values are extracted from the shipped file. This is
 * deliberate: hardcoding them would make the suite agree with itself instead of with DSH, and
 * a renumbering would then go unnoticed.
 */
const registrySource = await (await import('node:fs')).promises.readFile(
  join(DSH_APP, 'node_modules', '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js'),
  'utf8',
)
const orderTable = (() => {
  const at = registrySource.indexOf('const SECTION_ORDERS = {')
  if (at < 0) return null
  const body = registrySource.slice(at, registrySource.indexOf('}', at))
  const table = {}
  for (const match of body.matchAll(/([A-Z_]+):\s*(-?\d+(?:_\d+)*|1e\d+)/g)) {
    table[match[1]] = Number(match[2].replace(/_/g, ''))
  }
  return table
})()

check('the registry\'s section-order table was readable', orderTable !== null && Object.keys(orderTable).length > 3,
  orderTable === null ? 'SECTION_ORDERS not found' : Object.keys(orderTable).join(', '))

const facade = {
  getSectionOrder(name) {
    const value = orderTable?.[name]
    if (value === undefined) throw new Error(`the registry has no order named ${name}`)
    return value
  },
  section(spec) {
    sections.set(spec.name, spec)
    return () => sections.delete(spec.name)
  },
  variable(name, provider) {
    variables.set(name, provider)
    return () => variables.delete(name)
  },
}

const ctx = {
  effect(fn) {
    effects.push(fn())
    return () => {}
  },
  get: () => undefined,
  systemPrompt: facade,
}

const persona = await import(pathToFileURL(join(WORKSPACE_ROOT, 'luzzy-preset', 'lib', 'persona.mjs')).href)
persona.apply(ctx)

check('the row registered its persona section', sections.has(prompt.PERSONA_PREFIX_SECTION),
  [...sections.keys()].join(', '))
check('the row registered its suffix section', sections.has(prompt.PERSONA_SUFFIX_SECTION),
  [...sections.keys()].join(', '))
check('the row registered exactly one variable', variables.size === 1, [...variables.keys()].join(', '))

// The orders the row asked for must be the registry's own. If the registry ever renumbers, the
// row would silently stop shadowing the deployment persona, and this is what would catch it.
check('the persona-prefix order matches the registry',
  sections.get(prompt.PERSONA_PREFIX_SECTION).order === orderTable.DEPLOYMENT_PERSONA_PREFIX,
  `${sections.get(prompt.PERSONA_PREFIX_SECTION).order} vs ${orderTable.DEPLOYMENT_PERSONA_PREFIX}`)
check('the persona-suffix order matches the registry',
  sections.get(prompt.PERSONA_SUFFIX_SECTION).order === orderTable.DEPLOYMENT_PERSONA_SUFFIX,
  `${sections.get(prompt.PERSONA_SUFFIX_SECTION).order} vs ${orderTable.DEPLOYMENT_PERSONA_SUFFIX}`)
check('the prefix sorts before the suffix',
  sections.get(prompt.PERSONA_PREFIX_SECTION).order < sections.get(prompt.PERSONA_SUFFIX_SECTION).order)

// ---------------------------------------------------------------- build a real assembly

/**
 * Assemble the way the registry does, then render with the REAL renderer.
 *
 * The assembly shape is `{sections, variables}` — `renderPrompt` reads exactly those two, which
 * is what makes driving it directly meaningful rather than a reimplementation.
 */
function render({ cwd = 'C:\\Users\\Administrator\\Desktop\\DSH Plugin' } = {}) {
  const resolved = {}
  for (const [name, provider] of variables) resolved[name] = provider()
  const list = [...sections.values()].sort((a, b) => a.order - b.order)
  // Section text may be a function in the real registry; resolve it the same way.
  const materialised = list.map((section) => ({
    name: section.name,
    text: typeof section.text === 'function' ? section.text() : section.text,
  }))
  return renderPrompt({ sections: materialised, variables: { ...resolved, cwd } })
}

// ---------------------------------------------------------------- the property under test

console.log('')
console.log('the load-bearing property: a user prompt travels as a VARIABLE, never as section text')

const rendered = render()
check('the rendered prompt contains the active agent\'s text', rendered.includes('# 你是鹿溪'),
  JSON.stringify(rendered.slice(0, 80)))
check('the rendered prompt does NOT contain the section reference literally', !rendered.includes('{{luzzy_persona}}'),
  'an unsubstituted reference means the variable was never resolved')
check('the section text itself is still the constant reference',
  sections.get('deployment:persona-prefix').text === '{{luzzy_persona}}',
  String(sections.get('deployment:persona-prefix').text))
check('the rendered prompt contains the workspace line', /Your working directory is C:\\Users/.test(rendered),
  JSON.stringify(rendered.slice(-120)))

// THE decisive case: text that would throw if it were section text.
console.log('')
console.log('a prompt containing prompt syntax, which would THROW if it were section text')

writeAgentPrompt('luzzy', HOSTILE_PROMPT)
const hostileRendered = render()
check('a prompt with {{braces}} renders without throwing', typeof hostileRendered === 'string')
check('the hostile prompt text survives into the rendered output verbatim',
  hostileRendered.includes(HOSTILE_PROMPT.trimEnd()),
  JSON.stringify(hostileRendered.slice(0, 160)))
check('the inner reference was NOT substituted or stripped',
  hostileRendered.includes('{{luzzy_persona}}') && hostileRendered.includes('{{cwd}}'),
  'a nested reference being substituted would mean the value is re-scanned')

// Now prove the contrast: put the SAME text where section text lives, and show it throws.
// This is the negative half of the claim — without it, "renders fine" could just mean the
// renderer is permissive about everything.
//
// The real interpolator has TWO distinct rejection paths, and the hostile text happens to hit
// the first one. Asserting only one class would leave the other unproven, so both are checked
// explicitly with text aimed at each:
//
//   malformed — `{{ 未知引用 }}` (spaces, non-ASCII) fails VARIABLE_NAME before lookup
//   unknown   — `{{well_formed_but_absent}}` passes the name check and fails the lookup
function renderAsSectionText(text) {
  const original = { ...sections.get('deployment:persona-prefix') }
  sections.set('deployment:persona-prefix', { ...original, text })
  try {
    render()
    return null
  } catch (error) {
    return error
  } finally {
    sections.set('deployment:persona-prefix', original)
  }
}

const malformedThrow = renderAsSectionText(HOSTILE_PROMPT)
check('the SAME text as SECTION text throws on a malformed reference', malformedThrow !== null,
  'if this did not throw, the variable-vs-section distinction would not be load-bearing and the row\'s design rationale would be wrong')
check('the malformed-reference throw names the offending text',
  malformedThrow !== null && /malformed prompt variable reference/.test(malformedThrow.message),
  malformedThrow === null ? '' : malformedThrow.message.slice(0, 160))

const unknownThrow = renderAsSectionText('正文 {{well_formed_but_absent}}\n')
check('a well-formed but UNREGISTERED reference as section text also throws',
  unknownThrow !== null, 'this is the exact case a user typing {{something}} would hit')
check('the unknown-reference throw lists what IS registered',
  unknownThrow !== null && /unknown prompt variable/.test(unknownThrow.message)
  && /registered variables/.test(unknownThrow.message),
  unknownThrow === null ? '' : unknownThrow.message.slice(0, 160))

// And the same well-formed unknown reference is harmless inside a VARIABLE value — the whole
// reason the user's prompt is not section text.
writeAgentPrompt('luzzy', '正文 {{well_formed_but_absent}}\n')
const harmless = render()
check('the same unregistered reference inside a prompt VARIABLE is harmless',
  typeof harmless === 'string' && harmless.includes('{{well_formed_but_absent}}'),
  'the value must be substituted verbatim and never re-scanned')

console.log('')
console.log('the switch takes effect on the NEXT render, with no remount')

writeAgentPrompt('luzzy', LUZZY_PROMPT)
const before = render()
check('the first render uses the agent that was active', before.includes('# 你是鹿溪'))

// Change the active agent in the store, exactly as the sub-page does.
writeSettings({
  version: 1,
  revision: 2,
  activeAgentId: 'engineer',
  groups: [{ id: 'default', name: '默认', order: 0 }],
  agents: [
    { id: 'luzzy', name: '鹿溪', description: '', groupId: 'default', order: 0 },
    { id: 'engineer', name: '工程搭档', description: '', groupId: 'default', order: 1 },
  ],
})

const after = render()
check('the next render picks up the newly active agent without a remount',
  after.includes('你是一名资深软件工程师'), JSON.stringify(after.slice(0, 80)))
check('the previously active agent\'s text is gone from the render',
  !after.includes('# 你是鹿溪'))
check('nothing was re-registered to achieve that', sections.size === 2 && variables.size === 1,
  `sections=${sections.size} variables=${variables.size}`)

console.log('')
console.log('the reader degrades rather than throwing')

writeSettings({ version: 1, revision: 3, activeAgentId: 'ghost', groups: [], agents: [] })
let dangling = null
try {
  dangling = render()
} catch (error) {
  dangling = { error: error.message }
}
check('a store with no agents still renders', typeof dangling === 'string',
  typeof dangling === 'string' ? '' : dangling.error)
check('the fallback text appears in the output',
  typeof dangling === 'string' && dangling.includes('默认提示词'),
  typeof dangling === 'string' ? JSON.stringify(dangling.slice(0, 120)) : '')

// ---------------------------------------------------------------- teardown

for (const dispose of effects) {
  try { if (typeof dispose === 'function') dispose() } catch { /* best effort */ }
}
check('every registration was disposed', sections.size === 0 && variables.size === 0,
  `sections=${sections.size} variables=${variables.size}`)

try { rmSync(dshHome, { recursive: true, force: true }) } catch { /* OS reclaims it */ }

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
  console.log(`\npreset assembly: ${checks - failures.length} of ${checks} checks passed`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (real renderPrompt, real persona row, real store)`)
