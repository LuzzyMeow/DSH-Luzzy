// What does DSH's skill catalog actually cost per request?
//
// WHY THIS IS WORTH MEASURING
//
// `dsh-tool-skill` renders `<available_skills>` as a USER MESSAGE (not a system section), with
// `catalogDescriptionMaxLength` defaulting to 500 chars of each skill's description. Every skill
// the filesystem provider discovers lands in it: `~/.agents/skills` AND `~/.claude/skills`, both
// included by default (`includeDefaultRoots: true`).
//
// The question I was asked was whether pruning the Luzzy 必读清单 table saves tokens. It is 2922
// chars. This measures the thing sitting next to it, so the answer is grounded in both numbers
// rather than in whichever one I happened to look at first.
//
// It mirrors the module's own logic: parse frontmatter, take `description` whole (the block
// scalar form skills actually use), cap at 500, and render the same `- name: description` shape
// `renderCatalogEntries` produces.
//
// Usage: node tools/measure-skill-catalog.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CAP = 500 // DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
const roots = [
  join(homedir(), '.agents', 'skills'),
  join(homedir(), '.claude', 'skills'),
]

/** Pull `description` out of YAML frontmatter, handling both inline and block scalars. */
function descriptionOf(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (fm === null) return null
  const body = fm[1]
  const at = body.search(/^description:/m)
  if (at === -1) return null
  const lines = body.slice(at).split(/\r?\n/)
  // Inline form: `description: some text`
  const inline = lines[0].replace(/^description:\s*/, '').trim()
  if (inline !== '' && inline !== '>' && inline !== '|' && !inline.startsWith('>') && !inline.startsWith('|')) {
    return inline.replace(/\s+/g, ' ')
  }
  // Block scalar: the indented lines that follow.
  const out = []
  for (const line of lines.slice(1)) {
    if (/^[a-zA-Z_]/.test(line)) break
    out.push(line.trim())
  }
  const joined = out.join(' ').replace(/\s+/g, ' ').trim()
  return joined === '' ? null : joined
}

const seen = new Map()
let total = 0
let truncated = 0
for (const root of roots) {
  if (!existsSync(root)) continue
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(root, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    const desc = descriptionOf(readFileSync(file, 'utf8'))
    if (desc === null) continue
    if (seen.has(entry.name)) continue
    seen.set(entry.name, root)
    const used = Math.min(desc.length, CAP)
    if (desc.length > CAP) truncated += 1
    total += used
  }
}

// Each rendered entry is `- <name>: <description>` plus a newline → ~name length + 4.
const scaffolding = [...seen.keys()].reduce((sum, n) => sum + n.length + 5, 0)
const rendered = total + scaffolding + 300 // + the wrapper lines renderCatalogMessage adds
const tokensLow = Math.round(rendered / 3) // mostly-English estimate
const tokensHigh = Math.round(rendered / 1.7) // CJK-heavy estimate

console.log(`roots scanned          : ${roots.filter(existsSync).join('  |  ')}`)
console.log(`distinct skills        : ${seen.size}   (${truncated} hit the ${CAP}-char cap)`)
console.log(`description chars used : ${total}`)
console.log(`rendered block         : ~${rendered} chars  (adds name + bullet scaffolding)`)
console.log(`estimated tokens       : ~${tokensLow} – ${tokensHigh}`)
console.log('')
console.log('for comparison:')
console.log('  Luzzy §1.1.6 table   : 2,922 chars   (~1.0k – 1.7k tokens)')
console.log('  Luzzy whole §1.1     : 11,562 chars  (~3.9k – 6.8k tokens)')
console.log('')
console.log('the catalog is re-sent whenever the digest changes, and it sits in the prefix of every')
console.log('request after that — so its size is paid on every turn, not once.')
