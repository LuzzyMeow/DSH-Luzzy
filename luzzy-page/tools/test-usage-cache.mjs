// Tests for the parsed-log disk cache (lib/usage-cache.mjs).
//
// The cache turns a ~20 s cold start into ~16 ms, which makes it worth having — and worth
// testing carefully, because every failure mode here is SILENT and reports wrong numbers
// rather than an error:
//
//   1. `modelRouting` is a Map. JSON.stringify renders a Map as `{}` with no complaint, so a
//      naively cached entry reads back as a plain object; the worker's iteration over it then
//      throws, the per-file catch counts the log as skipped, and the totals quietly go to 0.
//      This test asserts the round-trip preserves a Map.
//   2. A cache from an older extraction is well-formed but WRONG. Nothing about the file
//      tells you that, so it is versioned.
//   3. A cache that cannot be written must not break anything.
//   4. A corrupt cache must degrade to "cold", never to "wrong".
//
// Usage: node tools/test-usage-cache.mjs

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { loadExtractCache, saveExtractCache, dropExtractCache, entryMatchesFile, CACHE_VERSION } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-cache.mjs').replace(/\\/g, '/')}`
)

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'luzzy-cache-test-'))
const cacheFile = join(scratch, 'extract-cache.json')

/** A stand-in for extractLog's output, WITH a Map — the shape that breaks naive JSON. */
function sampleExtract() {
  return {
    attempts: [
      { time: 1_700_000_000_000, model: 'p/m', sums: { totalTokens: 100, inputTokens: 60, outputTokens: 40 } },
      { time: 1_700_000_060_000, model: 'p/m2', sums: { totalTokens: 250, inputTokens: 200, outputTokens: 50 } },
    ],
    modelRouting: new Map([
      ['p/m', 1],
      ['p/m2', 1],
    ]),
    firstTime: 1_700_000_000_000,
    lastTime: 1_700_000_060_000,
  }
}

// ---------------------------------------------------------------- round trip

{
  const entries = new Map([['/sessions/a.jsonl.zstd', { size: 1234, mtimeMs: 5678, extracted: sampleExtract() }]])
  const saved = saveExtractCache(cacheFile, entries)
  check('cache is written', saved === true)
  check('cache file exists', existsSync(cacheFile))
  notes.push(`       size on disk: ${(readFileSync(cacheFile).length / 1024).toFixed(1)} KB`)

  const loaded = loadExtractCache(cacheFile)
  check('cache reports the current version', loaded.version === CACHE_VERSION, `${loaded.version}`)
  check('cache has the entry', loaded.files.size === 1, `${loaded.files.size}`)

  const entry = loaded.files.get('/sessions/a.jsonl.zstd')
  check('entry keeps size', entry?.size === 1234, `${entry?.size}`)
  check('entry keeps mtime', entry?.mtimeMs === 5678, `${entry?.mtimeMs}`)

  // THE trap: modelRouting must come back as a Map, not a plain object.
  check(
    'modelRouting survives the round trip AS A MAP',
    entry?.extracted.modelRouting instanceof Map,
    `got ${Object.prototype.toString.call(entry?.extracted.modelRouting)} — a plain object here makes the worker skip every file and report zeros`,
  )
  check('modelRouting entries are intact', entry?.extracted.modelRouting.get('p/m') === 1)
  check('attempts are intact', entry?.extracted.attempts.length === 2, `${entry?.extracted.attempts.length}`)
  check('attempt values are intact', entry?.extracted.attempts[1].sums.totalTokens === 250)
  check('time range is intact', entry?.extracted.firstTime === 1_700_000_000_000)

  // And confirm the trap is real, so the assertion above is not paranoia: a Map handed
  // straight to JSON.stringify becomes `{}`, losing every model routing count.
  const mapAsJson = JSON.stringify({ modelRouting: sampleExtract().modelRouting })
  check(
    'a Map would be destroyed by JSON.stringify (why toStorable exists)',
    mapAsJson === '{"modelRouting":{}}',
    `raw form was ${mapAsJson}`,
  )
  // The stored form is the array of entries, which round-trips.
  const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const storedRouting = raw.files['/sessions/a.jsonl.zstd'].extracted.modelRouting
  check(
    'the stored form is an entry array, which round-trips',
    Array.isArray(storedRouting) && storedRouting.length === 2,
    `stored form was ${JSON.stringify(storedRouting)}`,
  )
}

// ---------------------------------------------------------------- version mismatch

{
  const stale = join(scratch, 'stale.json')
  const payload = JSON.parse(readFileSync(cacheFile, 'utf8'))
  payload.version = CACHE_VERSION + 1
  writeFileSync(stale, JSON.stringify(payload), 'utf8')

  const loaded = loadExtractCache(stale)
  check(
    'a cache from another version is ignored (not trusted)',
    loaded.files.size === 0,
    `loaded ${loaded.files.size} entries from a future version`,
  )
}

// ---------------------------------------------------------------- corrupt / missing

{
  const corrupt = join(scratch, 'corrupt.json')
  writeFileSync(corrupt, '{ this is not json', 'utf8')
  check('corrupt cache degrades to empty', loadExtractCache(corrupt).files.size === 0)

  check('missing cache degrades to empty', loadExtractCache(join(scratch, 'nope.json')).files.size === 0)

  const malformed = join(scratch, 'malformed.json')
  writeFileSync(
    malformed,
    JSON.stringify({
      version: CACHE_VERSION,
      files: {
        '/good': { size: 1, mtimeMs: 2, extracted: { attempts: [], modelRouting: [], firstTime: null, lastTime: null } },
        '/bad-shape': { size: 1, mtimeMs: 2, extracted: { nope: true } },
        '/not-an-object': 'hello',
      },
    }),
    'utf8',
  )
  const loaded = loadExtractCache(malformed)
  check('well-formed entries are kept', loaded.files.has('/good'))
  check('malformed entries are dropped', !loaded.files.has('/bad-shape') && !loaded.files.has('/not-an-object'))
  check('only the good entry survives', loaded.files.size === 1, `${loaded.files.size}`)
}

// ---------------------------------------------------------------- unwritable path

{
  // A directory path can never be written as a file — the cache must fail soft.
  const saved = saveExtractCache(scratch, new Map())
  check('an unwritable cache path fails soft (no throw)', saved === false)
}

// ---------------------------------------------------------------- staleness check

{
  const target = join(scratch, 'log.jsonl.zstd')
  writeFileSync(target, 'x'.repeat(100), 'utf8')
  const { statSync } = await import('node:fs')
  const stat = statSync(target)

  check('a matching (size, mtime) is a hit', entryMatchesFile({ size: stat.size, mtimeMs: stat.mtimeMs }, target))
  check('a changed size is a miss', !entryMatchesFile({ size: 999, mtimeMs: stat.mtimeMs }, target))
  check('a changed mtime is a miss', !entryMatchesFile({ size: stat.size, mtimeMs: 1 }, target))
  check('a missing file is a miss', !entryMatchesFile({ size: stat.size, mtimeMs: stat.mtimeMs }, join(scratch, 'gone')))
}

// ---------------------------------------------------------------- drop

{
  dropExtractCache(cacheFile)
  check('drop removes the cache', !existsSync(cacheFile))
  dropExtractCache(cacheFile) // idempotent
  notes.push('  ok   drop is idempotent')
}

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} assertions (parsed-log cache)`)
