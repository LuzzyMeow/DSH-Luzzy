/**
 * Install the LuzzyMode preset into this machine's DSH home.
 *
 * THERE IS ONLY ONE HALF, AND THAT IS THE POINT
 *
 * A preset is a DIRECTORY under `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` +
 * `agent.cordis.yml`, and the roster reads those files directly. A row in that composition
 * may name a file inside the same directory (`./lib/persona.mjs`), which the roster resolves
 * relative to the preset — so the directory is self-sufficient. No profile bundle, no
 * `pnpm install`, no package registration.
 *
 * This was verified against the existing `liangshen` preset on this machine: it uses
 * preset-relative rows (`./minimal-prompt.mjs`, `./tool-catalog.mjs`) and has no
 * `package.json`, no `cordis.patch.yml`, and no entry in the profile's bundle list. Earlier
 * drafts of this preset shipped a bundle half anyway; it was removed once that evidence
 * showed it did nothing except add an install step that could fail.
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE PLUGIN
 *
 * `apply()` runs on every boot, and a plugin that rewrites a directory under the user's DSH
 * home at startup can silently revert a hand-edit. An installer the user runs is the right
 * shape for a change they asked for.
 *
 * WHAT IT WILL NOT DO
 *
 *   * It never overwrites an existing `agents/*.md` or `default.md` — a prompt is the user's
 *     work, and the sub-page is where it changes.
 *   * It never overwrites an existing `agent.cordis.yml` without `--force`, because that file
 *     is where a user would add tool rows.
 *   * It does not touch `settings.yaml` unless asked (see --set-default).
 *
 * Usage:
 *   node tools/install-preset.mjs                     # dry run: say what would change
 *   node tools/install-preset.mjs --apply             # do it
 *   node tools/install-preset.mjs --apply --force     # also replace agent.cordis.yml
 *   node tools/install-preset.mjs --apply --set-default   # also default new sessions to it
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_SOURCE = join(PLUGIN_ROOT, '..', 'luzzy-preset')

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const force = args.includes('--force')
const setDefault = args.includes('--set-default')

/** The preset id, which is also its directory name and the value stored in settings. */
const PRESET_ID = 'luzzy-mode'

function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

const home = resolveDshHome()
const target = join(home, '.agent-presets', PRESET_ID)
// The prompt store. NOT the same tree as the preset: `preset-store.mjs` resolves this as
// `$DSH_HOME/luzzy-preset`, so the installer must use exactly that path or a seeded prompt
// lands where nothing reads it.
const storeDir = join(home, 'luzzy-preset')
const settingsPath = join(home, 'settings.yaml')

console.log(`install-preset: ${apply ? 'APPLY' : 'dry run'}`)
console.log(`  source:      ${PRESET_SOURCE}`)
console.log(`  target:      ${target}`)
console.log(`  prompt store:${storeDir}`)
console.log(`  dsh home:    ${home}`)
console.log('')

if (!existsSync(PRESET_SOURCE)) {
  console.error(`install-preset: the preset source does not exist: ${PRESET_SOURCE}`)
  process.exit(1)
}

// Every file the preset directory needs, and how to treat one that is already there.
// `preserve: true` means "this is the user's content; never replace it".
//
// `lib/preset-store.mjs` ships a SECOND copy of the page plugin's module so the preset
// resolves its dependency without one. The copies are asserted identical by
// `tools/test-preset-parity.mjs`, which is what keeps them from drifting apart on disk.
const FILES = [
  { from: 'preset.yml', to: 'preset.yml', preserve: false },
  { from: 'agent.cordis.yml', to: 'agent.cordis.yml', preserve: false, forceOnly: true },
  { from: 'lib/persona.mjs', to: 'lib/persona.mjs', preserve: false },
  { from: 'lib/preset-store.mjs', to: 'lib/preset-store.mjs', preserve: false },
  { from: 'lib/default-prompt.md', to: 'lib/default-prompt.md', preserve: true },
]

const actions = []
for (const file of FILES) {
  const source = join(PRESET_SOURCE, file.from)
  const destination = join(target, file.to)
  if (!existsSync(source)) {
    actions.push({ kind: 'missing-source', file, source, destination })
    continue
  }
  if (!existsSync(destination)) {
    actions.push({ kind: 'create', file, source, destination })
    continue
  }
  if (file.preserve) {
    actions.push({ kind: 'keep', file, source, destination })
    continue
  }
  if (file.forceOnly && !force) {
    actions.push({ kind: 'keep-forceable', file, source, destination })
    continue
  }
  const same = readFileSync(source, 'utf8') === readFileSync(destination, 'utf8')
  actions.push({ kind: same ? 'identical' : 'replace', file, source, destination })
}

for (const action of actions) {
  const label = {
    create: 'CREATE ',
    replace: 'REPLACE',
    identical: 'same   ',
    keep: 'KEEP   ',
    'keep-forceable': 'KEEP?  ',
    'missing-source': 'MISSING',
  }[action.kind]
  const note = action.kind === 'keep'
    ? '  (yours — never overwritten)'
    : action.kind === 'keep-forceable'
      ? '  (exists; --force would replace it)'
      : ''
  console.log(`  ${label} ${action.file.to}${note}`)
}

// The one seeding decision worth making: an agent called 鹿溪 with no prompt file would fall
// through to the bundled fallback, which looks like the install failed. Copying the existing
// Luzzy preset's persona gives a first run that is actually the prompt the user already has.
//
// THE SEED GOES IN THE STORE, NOT THE PRESET DIRECTORY.
//
// These are two different trees and only one of them is where prompts live:
//
//   ~/.dsh/.agent-presets/luzzy-mode/   the COMPOSITION — read-only machinery, no prompts
//   ~/.dsh/luzzy-preset/agents/<id>.md  the PROMPTS — what `persona.mjs` actually reads
//
// The first version of this script wrote the seed into the preset directory, which is the
// tree that LOOKS like it should hold a persona (the `luzzy` preset keeps `persona.md`
// beside its composition). The result was a silent fall-through: a 120 KB prompt sat on
// disk unread while the session ran on the 239-character emergency text. Nothing errored —
// which is exactly why `test-installed-preset.mjs` now asserts the resolved prompt EQUALS
// the seeded file rather than merely being non-empty.
const seedSource = join(home, '.agent-presets', 'luzzy', 'persona.md')
const seedTarget = join(storeDir, 'agents', 'luzzy.md')
const canSeed = existsSync(seedSource) && !existsSync(seedTarget)
console.log('')
console.log(canSeed
  ? `  SEED    ${seedTarget}  ← ${seedSource}`
  : existsSync(seedTarget)
    ? `  KEEP    ${seedTarget}  (yours — never overwritten)`
    : '  NOTE    no existing luzzy persona to seed from; the sub-page starts empty')

if (!apply) {
  console.log('')
  console.log('install-preset: nothing was written. Re-run with --apply to make these changes.')
  process.exit(0)
}

console.log('')
try {
  mkdirSync(target, { recursive: true })
  for (const action of actions) {
    if (action.kind === 'missing-source') continue
    if (action.kind === 'keep' || action.kind === 'keep-forceable' || action.kind === 'identical') continue
    mkdirSync(dirname(action.destination), { recursive: true })
    copyFileSync(action.source, action.destination)
    console.log(`  wrote ${action.destination}`)
  }

  if (canSeed) {
    mkdirSync(dirname(seedTarget), { recursive: true })
    copyFileSync(seedSource, seedTarget)
    console.log(`  wrote ${seedTarget}`)
  }

  // A settings.json with a roster is what the sub-page renders on first open. The preset
  // itself does not need it — the reader falls back to default.md — but without it the page
  // shows an empty roster and the user has to create the first agent by hand.
  const settingsTarget = join(storeDir, 'settings.json')
  if (!existsSync(settingsTarget)) {
    mkdirSync(dirname(settingsTarget), { recursive: true })
    writeFileSync(settingsTarget, `${JSON.stringify({
      version: 1,
      revision: 1,
      activeAgentId: 'luzzy',
      groups: [{ id: 'default', name: '默认', order: 0 }],
      agents: [{ id: 'luzzy', name: '鹿溪', description: '', groupId: 'default', order: 0 }],
    }, null, 2)}\n`, 'utf8')
    console.log(`  wrote ${settingsTarget}`)
  } else {
    console.log(`  keep  ${settingsTarget} (already exists)`)
  }

  console.log('')
  console.log('install-preset: done.')

  // What remains is deliberately NOT done for the user: making LuzzyMode the default is a
  // global behaviour change, and editing settings.yaml is a write to a file the rest of the
  // app owns. It is reported with the exact patch, not applied.
  const settingsText = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
  const alreadyDefault = /agent-presets:\s*\n\s*default:\s*luzzy-mode\b/.test(settingsText)
  if (alreadyDefault) {
    console.log('  LuzzyMode is already the DEFAULT preset for new sessions.')
  } else if (setDefault) {
    const backup = `${settingsPath}.bak-luzzy-${Date.now()}`
    copyFileSync(settingsPath, backup)
    const patched = /agent-presets:\s*\n(?:[ \t]+.*\n)*?/.test(settingsText)
      ? settingsText.replace(/(agent-presets:\s*\n)(?:[ \t]+.*\n)*/, `$1  default: ${PRESET_ID}\n`)
      : `${settingsText.trimEnd()}\n\nagent-presets:\n  default: ${PRESET_ID}\n`
    writeFileSync(settingsPath, patched, 'utf8')
    console.log(`  set agent-presets.default to ${PRESET_ID} (backup: ${backup})`)
    console.log('  restart DSH for the default to apply to new sessions.')
  } else {
    console.log('')
    console.log('  NEXT: to make LuzzyMode the default for NEW sessions, either')
    console.log(`        re-run with --set-default, or add this to ${settingsPath}:`)
    console.log('')
    console.log(`            agent-presets:\n              default: ${PRESET_ID}`)
    console.log('')
    console.log('        Existing conversations keep their current preset — DSH fixes a')
    console.log('        session\'s preset once it has produced content.')
  }

  console.log('')
  console.log('  RESTART DSH so the roster picks up the new preset directory.')
  console.log('  The page plugin\'s host half also needs that restart — its routes are')
  console.log('  registered at boot, while the client half hot-reloads on its own.')
} catch (error) {
  console.error(`install-preset: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
