/**
 * Verify the INSTALLED preset row loads from where it actually lives.
 *
 * `test-preset-persona.mjs` drives the row in the repo, where the source tree is present.
 * This one imports the copy under `$DSH_HOME/.agent-presets/<id>/` — the location that
 * matters — and asserts three things that only fail THERE:
 *
 *   1. the row's relative import (`./preset-store.mjs`) resolves from the installed path
 *   2. it registers its sections and variable against a fake prompt registry
 *   3. it reads the seeded prompt for the agent the installer activated
 *
 * WHY THIS IS WORTH A SEPARATE CHECK
 *
 * A preset that fails to mount is not a degraded preset — `dsh-agent-presets` throws
 * `agent-preset/invalid` and the SESSION fails to compose. If such a preset is also the
 * settings default, every new conversation breaks. So the preset's loadability is verified
 * before anything depends on it, not after a restart reveals it.
 *
 * Skips cleanly when the preset is not installed, so it stays usable in a fresh checkout.
 *
 * Run: node tools/test-installed-preset.mjs
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  // Details are truncated HARD. A prompt is 120 KB by nature, and echoing one into a
  // failure message buries every other assertion in the run — which is how this file
  // flooded the terminal the first time it was used.
  const clipped = typeof detail === 'string' && detail.length > 160 ? `${detail.slice(0, 160)}… (${detail.length} chars)` : detail
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${clipped === '' ? '' : ` — ${clipped}`}`)
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `got ${typeof actual === 'string' ? `${actual.length} chars` : JSON.stringify(actual)}, want ${typeof expected === 'string' ? `${expected.length} chars` : JSON.stringify(expected)}`)
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const presetId = 'luzzy-mode'
const installed = join(home, '.agent-presets', presetId)

if (!existsSync(installed)) {
  console.log(`installed-preset: skipped — ${installed} does not exist`)
  console.log('installed-preset: run tools/install-preset.mjs --apply first')
  process.exit(0)
}

console.log(`installed-preset: ${installed}`)

/** A stand-in for the prompt registry, recording registrations. */
function makeFakeCtx() {
  const sections = new Map()
  const variables = new Map()
  const orders = { DEPLOYMENT_PERSONA_PREFIX: 0, DEPLOYMENT_PERSONA_SUFFIX: 10200 }
  return {
    sections,
    variables,
    effect(action) {
      return action()
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
  console.log('installed-preset: files')
  for (const relative of ['preset.yml', 'agent.cordis.yml', 'lib/persona.mjs', 'lib/preset-store.mjs', 'lib/default-prompt.md']) {
    check(`${relative} is installed`, existsSync(join(installed, relative)))
  }

  console.log('installed-preset: the row loads from its installed location')
  const rowUrl = pathToFileURL(join(installed, 'lib', 'persona.mjs')).href
  let mod
  try {
    // A cache-busting query, so a repeated run in one process re-evaluates the file.
    mod = await import(`${rowUrl}?v=${Date.now()}`)
  } catch (error) {
    check('the installed row imports', false, error instanceof Error ? error.message : String(error))
    throw error
  }
  check('the installed row imports (relative ./preset-store.mjs resolved)', typeof mod.apply === 'function')
  eq('the row names itself', mod.name, 'luzzy-persona')
  check('the row injects systemPrompt', Array.isArray(mod.inject) && mod.inject.includes('systemPrompt'))

  console.log('installed-preset: registration')
  const ctx = makeFakeCtx()
  mod.apply(ctx)
  eq('two sections register', ctx.sections.size, 2)
  eq('the persona section uses the variable reference', ctx.sections.get('deployment:persona-prefix')?.text, '{{luzzy_persona}}')
  eq('the suffix keeps the workspace line', ctx.sections.get('deployment:persona-suffix')?.text, 'Your working directory is {{cwd}}.')
  eq('one variable registers', ctx.variables.size, 1)

  const provider = ctx.variables.get('luzzy_persona')
  check('the variable provider is a function', typeof provider === 'function')
  const value = provider({})
  check('the provider returns a non-empty prompt', typeof value === 'string' && value.trim() !== '', String(value).slice(0, 80))
  check('the prompt is not the emergency fallback', !value.includes('提示词没读到'), value.slice(0, 120))

  console.log('installed-preset: the seeded prompt is the one that gets sent')
  // The prompt lives in the STORE, not beside the composition. Asserting the resolved value
  // EQUALS this file (not merely that it is non-empty) is what caught the installer writing
  // the seed into the preset directory: a 120 KB prompt sat unread while sessions ran on the
  // 239-character emergency text, with nothing reporting a problem.
  const storeDir = join(home, 'luzzy-preset')
  const seeded = join(storeDir, 'agents', 'luzzy.md')
  if (existsSync(seeded)) {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(seeded, 'utf8')
    eq('the active agent resolves to the seeded file byte for byte', value, text)
    check('the seeded prompt is substantial', text.length > 1000, `${text.length} chars`)
  } else {
    check(`the store holds the seeded prompt at ${seeded}`, false, 'the installer must seed the STORE, not the preset directory')
  }

  console.log('installed-preset: the preset directory holds no stray prompt copy')
  {
    // A prompt inside the preset directory is the wrong-tree mistake. It costs nothing to
    // detect and it is invisible otherwise: the file is simply never read.
    const stray = join(installed, 'agents')
    check('no agents/ directory inside the preset', !existsSync(stray), `${stray} exists — prompts belong in the store`)
  }

  console.log('installed-preset: the store module copy matches the repo copy')
  {
    const repoStore = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'preset-store.mjs')
    const installedStore = join(installed, 'lib', 'preset-store.mjs')
    if (existsSync(installedStore)) {
      const { readFileSync } = await import('node:fs')
      const { createHash } = await import('node:crypto')
      const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
      const a = hash(repoStore)
      const b = hash(installedStore)
      check(
        'the installed store copy is not stale',
        a === b,
        `repo ${a.slice(0, 12)}… vs installed ${b.slice(0, 12)}… — re-run tools/install-preset.mjs --apply`,
      )
    }
  }

  console.log('installed-preset: the composition stays portable')
  {
    const { readFileSync } = await import('node:fs')
    const composition = readFileSync(join(installed, 'agent.cordis.yml'), 'utf8')
    check('no absolute path in the composition', !/name: [A-Za-z]:[\\/]/.test(composition))
    check('no developer-machine path anywhere', !/Desktop|DSH Plugin/.test(composition))
    check('the persona row points at the installed sibling', composition.includes('name: ./lib/persona.mjs'))
  }
} catch (error) {
  console.error(`installed-preset: aborted — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

console.log('')
if (failures === 0) {
  console.log(`installed-preset: ${checks} checks passed`)
  process.exit(0)
}
console.log(`installed-preset: ${failures} of ${checks} checks FAILED`)
process.exit(1)
