/**
 * Assert the two copies of `preset-store.mjs` are byte-identical and behave identically.
 *
 * The module is duplicated on purpose — see its header. `luzzy-preset/lib/` is the copy
 * that ships as the DSH preset and is resolvable only from its own directory; the
 * `luzzy-page/lib/` copy is what the sub-page's host half imports. Neither can import the
 * other, and a drifting copy is the failure mode you cannot see: the page would edit a
 * store the preset reads with different rules, and the prompt would differ from the one
 * displayed.
 *
 * A byte comparison is the strong check, but it is also the brittle one — reformatting one
 * file without semantic change would fail it. So both are asserted:
 *
 *   1. bytes are identical (the intended state)
 *   2. the exported behaviour matches on the same fixture (the property that matters if
 *      someone ever needs the copies to differ deliberately)
 *
 * Run: node tools/test-preset-parity.mjs
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRESET_COPY = join(HERE, '..', '..', 'luzzy-preset', 'lib', 'preset-store.mjs')
const PAGE_COPY = join(HERE, '..', 'lib', 'preset-store.mjs')

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

const workspaces = []

try {
  console.log('preset-store parity: bytes')
  const presetBytes = readFileSync(PRESET_COPY)
  const pageBytes = readFileSync(PAGE_COPY)
  const presetHash = createHash('sha256').update(presetBytes).digest('hex')
  const pageHash = createHash('sha256').update(pageBytes).digest('hex')

  check(`preset copy sha256 ${presetHash.slice(0, 12)}…`, presetBytes.length > 0)
  check(
    'the two copies are byte-identical',
    presetHash === pageHash,
    `preset ${presetHash.slice(0, 12)}… (${presetBytes.length} B) vs page ${pageHash.slice(0, 12)}… (${pageBytes.length} B)`,
  )

  console.log('preset-store parity: behaviour on one fixture')
  const preset = await import(pathToFileURL(PRESET_COPY).href)
  const page = await import(pathToFileURL(PAGE_COPY).href)

  const exportedPreset = Object.keys(preset).sort()
  const exportedPage = Object.keys(page).sort()
  check('the two modules export the same names', exportedPreset.join() === exportedPage.join(), exportedPreset.join() + ' vs ' + exportedPage.join())

  const constants = ['STORE_VERSION', 'STORE_DIR_NAME', 'SETTINGS_FILE', 'DEFAULT_PROMPT_FILE', 'AGENTS_DIR', 'MAX_PROMPT_BYTES', 'EMPTY_FALLBACK_TEXT']
  for (const name of constants) {
    check(`${name} matches`, Object.is(preset[name], page[name]), `${JSON.stringify(preset[name])} vs ${JSON.stringify(page[name])}`)
  }

  const home = mkdtempSync(join(tmpdir(), 'luzzy-parity-'))
  workspaces.push(home)
  const storeDir = join(home, 'luzzy-preset')
  mkdirSync(join(storeDir, 'agents'), { recursive: true })
  writeFileSync(join(storeDir, 'settings.json'), JSON.stringify({
    version: 1,
    revision: 5,
    activeAgentId: 'a',
    groups: [{ id: 'g', name: 'G', order: 0 }, { id: 'BAD', order: 1 }],
    agents: [
      { id: 'a', name: 'A', groupId: 'g', order: 0 },
      { id: 'b', name: 'B', groupId: 'nope', order: 1 },
      { id: 'BAD ID', order: 2 },
    ],
  }, null, 2), 'utf8')
  writeFileSync(join(storeDir, 'agents', 'a.md'), 'PROMPT-A', 'utf8')
  writeFileSync(join(storeDir, 'default.md'), 'DEFAULT', 'utf8')

  const readPreset = preset.readStore(preset.storePaths(home))
  const readPage = page.readStore(page.storePaths(home))
  check('readStore agrees on the roster', JSON.stringify(readPreset.store) === JSON.stringify(readPage.store))
  check('readStore agrees on the warnings', JSON.stringify(readPreset.warnings) === JSON.stringify(readPage.warnings))
  check('readStore agrees on the source', readPreset.source === readPage.source)

  const promptPreset = preset.createPromptReader(preset.storePaths(home), { builtinFallbackPath: null }).read()
  const promptPage = page.createPromptReader(page.storePaths(home), { builtinFallbackPath: null }).read()
  check('the resolved prompt agrees', promptPreset.text === promptPage.text && promptPreset.source === promptPage.source)

  const ops = [
    ['upsertAgent', { name: 'New One', groupId: 'g' }],
    ['upsertAgent', { id: 'a', name: 'Renamed' }],
    ['upsertGroup', { id: 'g2', name: 'G2' }],
    ['removeGroup', { id: 'g' }],
    ['removeAgent', { id: 'b' }],
    ['setActive', { agentId: null }],
    ['setActive', { agentId: 'a' }],
    ['reorderAgents', { order: [{ id: 'a', order: 3, groupId: 'g2' }] }],
    ['reorderGroups', { order: [{ id: 'g2', order: 9 }] }],
    ['nonsense', {}],
  ]
  for (const [op, payload] of ops) {
    const left = preset.applyRosterOp(readPreset.store, op, payload)
    const right = page.applyRosterOp(readPage.store, op, payload)
    check(`${op} agrees`, JSON.stringify(left) === JSON.stringify(right), `${JSON.stringify(left)} vs ${JSON.stringify(right)}`)
  }

  const suggestions = ['luzzy', '鹿溪', '', 'a'.repeat(200), '!!!']
  for (const name of suggestions) {
    check(`suggestId(${JSON.stringify(name.slice(0, 12))}) agrees`, preset.suggestId(name, ['agent-1']) === page.suggestId(name, ['agent-1']))
  }
} finally {
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
  console.log(`preset-parity: ${checks} checks passed`)
  process.exit(0)
}
console.log(`preset-parity: ${failures} of ${checks} checks FAILED`)
process.exit(1)
