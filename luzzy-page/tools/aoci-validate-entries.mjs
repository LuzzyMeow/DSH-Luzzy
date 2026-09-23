// Validate authored Entries against the machine's own field budgets.
//
// WHY THIS EXISTS: the pipeline returns ONE finding at a time for a length violation, so a
// batch of 20 can take 20 round trips to converge. The limits are published in the Guide's
// budget block, so they can be checked locally before spending a submission on them.
//
//   S budget (tokens = UTF-8 bytes / 3):  C1-4 ≤ 40, C5-7 ≤ 80, C8 ≤ 140, C9 ≤ 200
//   R budget:                            C1-4 ≤ 50, C5-7 ≤ 90, C8 ≤ 140, C9 ≤ 180
//   S runes:                             200 hard cap, every importance
//
// Usage: node tools/aoci-validate-entries.mjs <entries.json>
import { readFileSync } from 'node:fs'

const file = process.argv[2]
// Strip a UTF-8 BOM before parsing. Windows tooling (PowerShell's Set-Content, notably)
// writes one by default, and `JSON.parse` rejects it with a message that points at column 1
// and says nothing about the BOM — so the failure looks like a corrupted file rather than an
// encoding detail.
const authored = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))

// The A-layer and B-module dictionaries, read from Meta (docs are not authoritative; the
// machine dictionary is, and these are its published members).
const A_LAYERS = new Set('C E A D K M P I R L F O T S X Z'.split(' '))
const B_MODULES = new Set('G U B D I N M S C O R P W A H L V Q E Z'.split(' '))

const S_MAX_TOKENS = [[1, 4, 40], [5, 7, 80], [8, 8, 140], [9, 9, 200]]
const R_MAX_TOKENS = [[1, 4, 50], [5, 7, 90], [8, 8, 140], [9, 9, 180]]

const budgetFor = (table, c) => {
  for (const [lo, hi, max] of table) if (c >= lo && c <= hi) return max
  return null
}

let problems = 0
for (const [path, line] of Object.entries(authored)) {
  const issue = (why) => {
    problems += 1
    console.log(`  FAIL ${path}: ${why}`)
  }

  if (line.includes('\n')) { issue('the Entry spans multiple lines'); continue }

  const tagMatch = /^[^\[]+\[([A-Z0-9]+)\]:/.exec(line)
  if (tagMatch === null) { issue('no [TAG]: at the start'); continue }
  const tag = tagMatch[1]

  // compact A+B+C+[D]+E
  const parsed = /^([A-Z])([A-Z])(\d)(?:-([A-Z]+))?([A-Z]+)$/.exec(tag)
  if (parsed === null) { issue(`tag ${tag} is not compact A+B+C+[D]+E`); continue }
  const [, a, b, cText, , e] = parsed
  const c = Number(cText)

  if (!A_LAYERS.has(a)) issue(`tag ${tag}: A=${a} not in the dictionary`)
  if (!B_MODULES.has(b)) issue(`tag ${tag}: B=${b} not in the dictionary`)
  for (const letter of e) if (!'LMST'.includes(letter)) issue(`tag ${tag}: E=${e} has an unknown scale letter ${letter}`)

  // field structure and order
  const frasMatch = / \| R:(.*?) \| A:(.*?) \| S:(.*)$/.exec(line)
  if (frasMatch === null) { issue('F/R/A/S are not in canonical order'); continue }
  const [, r, aField, s] = frasMatch
  if (r.trim() === '') issue('R is empty (use - )')
  if (aField.trim() === '') issue('A is empty (use - )')
  if (s.trim() === '') issue('S is empty (use - )')

  const tokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
  const sTokens = tokens(s)
  const sMax = budgetFor(S_MAX_TOKENS, c)
  if (sMax !== null && sTokens > sMax) issue(`S is ${sTokens} tokens, over the C${c} cap of ${sMax}`)
  if ([...s].length > 200) issue(`S is ${[...s].length} runes, over the hard cap of 200`)

  const rTokens = tokens(r)
  const rMax = budgetFor(R_MAX_TOKENS, c)
  if (rMax !== null && rTokens > rMax) issue(`R is ${rTokens} tokens, over the C${c} cap of ${rMax}`)
}

console.log('')
if (problems === 0) {
  console.log(`aoci-entries: ${Object.keys(authored).length} entries pass the local field budgets`)
} else {
  console.log(`aoci-entries: ${problems} problem(s) across ${Object.keys(authored).length} entries`)
  process.exit(1)
}
