/**
 * Assert the LuzzyMode persona row's actual mechanism.
 *
 * This is the test that proves the feature's central claim: a prompt edit reaches the
 * model on the NEXT assembly, with no restart and no re-mount. It does that by standing up
 * a fake `ctx.systemPrompt` that records what the row registers, then driving the recorded
 * variable provider the way the harness's `assemble()` drives it — once per step.
 *
 * Two things are asserted that a "does it register?" test would miss:
 *
 *   * the section TEXT is a constant reference (`{{luzzy_persona}}`), not the prompt. If
 *     the prompt ever ends up in section text, `renderPrompt` will interpolate it and throw
 *     on any `{{` a user wrote.
 *   * the VARIABLE's value equals the current file contents, and changes when the file
 *     changes — in the same process, with no cache reset.
 *
 * Run: node tools/test-preset-persona.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRESET_ROOT = join(HERE, '..', '..', 'luzzy-preset')

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

/** A stand-in for the harness's prompt registry, recording what a row registers. */
function makeFakeCtx() {
  const sections = new Map()
  const variables = new Map()
  const disposers = []
  const orders = {
    DEPLOYMENT_PERSONA_PREFIX: 0,
    DEPLOYMENT_PERSONA_SUFFIX: 10200,
  }
  return {
    sections,
    variables,
    disposers,
    effect(action) {
      const dispose = action()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    systemPrompt: {
      getSectionOrder: (name) => orders[name],
      section(section) {
        sections.set(section.name, section)
        return () => sections.delete(section.name)
      },
      variable(name, provider) {
        variables.set(name, provider)
        return () => variables.delete(name)
      },
    },
  }
}

try {
  console.log('luzzy-preset: the composition names the row that exists')
  {
    const { readFileSync } = await import('node:fs')
    const composition = readFileSync(join(PRESET_ROOT, 'agent.cordis.yml'), 'utf8')
    check('the composition references ./lib/persona.mjs', composition.includes('name: ./lib/persona.mjs'))
    // Assert on ROWS, not on raw text: the header comment deliberately explains why this
    // preset does NOT mount dsh-persona, and a substring check would flag that sentence.
    check(
      'no row mounts dsh-persona',
      !/^\s*name:\s*'@deepseek-ai\/dsh-persona'/m.test(composition),
    )
    check('the persona row carries no inline prefix', !/prefix:\s*>?-\s*\n\s+You are a coding agent/.test(composition))
    check('no absolute path in the composition', !/name: [A-Za-z]:[\\/]/.test(composition))

    const metadata = readFileSync(join(PRESET_ROOT, 'preset.yml'), 'utf8')
    check('preset.yml names the preset', metadata.includes('name: LuzzyMode'))
    check('preset.yml has an order', /^order: \d+/m.test(metadata))

    // The preset directory is self-sufficient BY DESIGN: a row may name a file inside it,
    // and the roster resolves that relative to the preset. There must be no bundle half —
    // no package.json, no cordis.patch.yml — because the existing `liangshen` preset proves
    // one is not needed, and a bundle would add an install step that can fail silently.
    const { readdirSync } = await import('node:fs')
    const entries = readdirSync(PRESET_ROOT)
    check('the preset ships no package.json', !entries.includes('package.json'), entries.join(' '))
    check('the preset ships no cordis.patch.yml', !entries.includes('cordis.patch.yml'), entries.join(' '))
    check('the preset ships the composition, its metadata and lib/', entries.includes('agent.cordis.yml') && entries.includes('preset.yml') && entries.includes('lib'), entries.join(' '))
  }

  console.log('luzzy-preset: the row registers a constant reference plus a live value')
  {
    const home = mkdtempSync(join(tmpdir(), 'luzzy-persona-'))
    workspaces.push(home)
    process.env.DSH_HOME = home

    // The module reads DSH_HOME at apply() time, so the import must come after it is set.
    const mod = await import(`${pathToFileURL(join(PRESET_ROOT, 'lib', 'persona.mjs')).href}?v=${Date.now()}`)
    eq('the plugin names itself', mod.name, 'luzzy-persona')
    check('the row injects systemPrompt', Array.isArray(mod.inject) && mod.inject.includes('systemPrompt'))

    const ctx = makeFakeCtx()
    mod.apply(ctx)

    eq('two sections are registered', ctx.sections.size, 2)
    const prefix = ctx.sections.get('deployment:persona-prefix')
    check('the persona-prefix section exists', prefix !== undefined)
    eq('the suffix section exists', ctx.sections.get('deployment:persona-suffix')?.text, 'Your working directory is {{cwd}}.')
    eq('the persona order matches the registry', prefix.order, 0)
    eq('the suffix order matches the registry', ctx.sections.get('deployment:persona-suffix').order, 10200)

    check('the section text is a constant REFERENCE, not the prompt', prefix.text === '{{luzzy_persona}}', prefix.text.slice(0, 80))
    check('the section text contains no newlines', !prefix.text.includes('\n'))

    eq('exactly one variable is registered', ctx.variables.size, 1)
    const provider = ctx.variables.get('luzzy_persona')
    eq('the variable the section names is the variable registered', typeof provider, 'function')

    console.log('luzzy-preset: the value tracks the file, per read')
    const storeDir = join(home, 'luzzy-preset')
    mkdirSync(join(storeDir, 'agents'), { recursive: true })
    writeFileSync(join(storeDir, 'settings.json'), JSON.stringify({
      version: 1,
      revision: 1,
      activeAgentId: 'luzzy',
      groups: [],
      agents: [{ id: 'luzzy', name: '鹿溪', groupId: null, order: 0 }],
    }), 'utf8')
    writeFileSync(join(storeDir, 'agents', 'luzzy.md'), 'PROMPT-ONE', 'utf8')

    eq('the first assembly reads the agent file', provider({}), 'PROMPT-ONE')

    // Same process, no cache reset, no re-apply: this is the whole feature.
    writeFileSync(join(storeDir, 'agents', 'luzzy.md'), 'PROMPT-TWO', 'utf8')
    eq('the next assembly sees the edit', provider({}), 'PROMPT-TWO')

    // Switching the active agent must change what the SAME provider returns.
    writeFileSync(join(storeDir, 'agents', 'other.md'), 'OTHER-AGENT', 'utf8')
    writeFileSync(join(storeDir, 'settings.json'), JSON.stringify({
      version: 1,
      revision: 2,
      activeAgentId: 'other',
      groups: [],
      agents: [
        { id: 'luzzy', name: '鹿溪', groupId: null, order: 0 },
        { id: 'other', name: 'Other', groupId: null, order: 1 },
      ],
    }), 'utf8')
    eq('switching the active agent switches the prompt', provider({}), 'OTHER-AGENT')

    writeFileSync(join(storeDir, 'settings.json'), JSON.stringify({
      version: 1, revision: 3, activeAgentId: null, groups: [], agents: [],
    }), 'utf8')
    writeFileSync(join(storeDir, 'default.md'), 'DEFAULT-PROMPT', 'utf8')
    eq('clearing the active agent falls back to the default', provider({}), 'DEFAULT-PROMPT')

    console.log('luzzy-preset: a broken store never yields an empty prompt')
    writeFileSync(join(storeDir, 'settings.json'), '{ broken', 'utf8')
    const brokenValue = provider({})
    check('a corrupt settings.json still yields text', typeof brokenValue === 'string' && brokenValue.length > 0)
    eq('it falls back to the default file', brokenValue, 'DEFAULT-PROMPT')

    rmSync(join(storeDir, 'default.md'), { force: true })
    const nothing = provider({})
    check('with nothing readable the bundled fallback is used', nothing.length > 0)
    check('the bundled fallback explains itself', nothing.includes('LuzzyMode'), nothing.slice(0, 60))

    console.log('luzzy-preset: unloading removes both registrations')
    for (const dispose of ctx.disposers) dispose()
    eq('no sections left', ctx.sections.size, 0)
    eq('no variables left', ctx.variables.size, 0)
  }
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
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
  console.log(`preset-persona: ${checks} checks passed`)
  process.exit(0)
}
console.log(`preset-persona: ${failures} of ${checks} checks FAILED`)
process.exit(1)
