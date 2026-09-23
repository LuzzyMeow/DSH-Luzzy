// How much would a disk cache of parsed logs save?
//
// The cold pass is ~20 s. Splitting it by phase tells us what a cache can actually remove:
// decompressing + parsing the JSONL is the expensive part, re-bucketing is not. This also
// measures the size of the cached form, which decides whether a disk cache is reasonable.
//
// Usage: node tools/probe-extract-cost.mjs

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'

const PLUGIN_ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '\\'))
const { decompressBuffer, extractLog } = await import(
  `file://${join(PLUGIN_ROOT, 'lib', 'usage-core.mjs').replace(/\\/g, '/')}`
)

const sessionsRoot = join(homedir(), '.dsh', 'sessions')

function collect(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.endsWith('.jsonl.zstd')) found.push(full)
    }
  }
  walk(root, 0)
  return found
}

const files = collect(sessionsRoot)
console.log(`logs: ${files.length}`)

// ---- phase 1: decompress only
let t = Date.now()
let totalJsonl = 0
const texts = []
for (const file of files) {
  try {
    const text = decompressBuffer(readFileSync(file))
    totalJsonl += text.length
    texts.push(text)
  } catch {
    /* unreadable log */
  }
}
const decompressMs = Date.now() - t

// ---- phase 2: parse to attempts
t = Date.now()
const extracts = []
for (const text of texts) extracts.push(extractLog(text))
const parseMs = Date.now() - t

// ---- phase 3: what a cache read costs
t = Date.now()
const serialized = JSON.stringify(extracts)
const serializeMs = Date.now() - t

const cacheDir = mkdtempSync(join(tmpdir(), 'luzzy-cache-'))
const cacheFile = join(cacheDir, 'extract.json')
writeFileSync(cacheFile, serialized)
const cacheBytes = statSync(cacheFile).size

t = Date.now()
const restored = JSON.parse(readFileSync(cacheFile, 'utf8'))
const readMs = Date.now() - t

const attempts = extracts.reduce((sum, e) => sum + e.attempts.length, 0)

console.log()
console.log(`phase 1  decompress zstd -> jsonl : ${decompressMs} ms   (${(totalJsonl / 1024 / 1024).toFixed(1)} MB jsonl)`)
console.log(`phase 2  parse jsonl -> attempts  : ${parseMs} ms   (${attempts} attempts)`)
console.log(`         cold total               : ${decompressMs + parseMs} ms`)
console.log()
console.log(`cache    size on disk             : ${(cacheBytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`         write (serialize)        : ${serializeMs} ms`)
console.log(`         read + parse             : ${readMs} ms   <-- what a warm start would pay`)
console.log(`         restored entries         : ${restored.length}`)
