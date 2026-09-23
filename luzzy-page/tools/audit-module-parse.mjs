// Why does the FROM-SOURCE build pass in my working tree but fail in a fresh checkout?
//
// Same src/client.js hash on both sides (verified), so the difference must be in one of the
// module files that a fresh checkout now HAS and my working tree also has — i.e. one of the 21
// that were just committed. The build concatenates them into one classic script; if one module
// is not valid classic-script source, the assembled frame will not compile.
//
// This compiles EVERY module on its own, exactly as the frame's new Function would see it, and
// names the ones that fail. Guessing here costs more than measuring.
//
// Usage: node tools/audit-module-parse.mjs [--src <dir>]

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const srcIndex = args.indexOf('--src')
const PLUGIN_ROOT = join(HERE, '..')
const SRC = srcIndex >= 0 ? args[srcIndex + 1] : join(PLUGIN_ROOT, 'src')

const manifest = JSON.parse(readFileSync(join(SRC, 'app', 'manifest.json'), 'utf8'))

// The frame script is compiled as a CLASSIC script (no ESM). `new Function` is the same
// environment: top-level `return` is illegal, `import` is illegal, etc.
function compiles(text) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(text)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

let broken = 0
console.log('=== each module compiled on its own (classic script) ===')
for (const rel of manifest.modules) {
  const text = readFileSync(join(SRC, rel), 'utf8')
  const err = compiles(text)
  if (err === null) {
    console.log(`  ok   ${rel}`)
  } else {
    broken += 1
    console.log(`  FAIL ${rel} — ${err}`)
  }
}

console.log('')
console.log('=== the assembled frame script (the real thing) ===')
const parts = manifest.modules.map((rel) => readFileSync(join(SRC, rel), 'utf8'))
const assembled = parts.join('\n')
const assembledErr = compiles(assembled)
if (assembledErr === null) {
  console.log('  ok   the concatenation compiles')
} else {
  broken += 1
  console.log(`  FAIL the concatenation — ${assembledErr}`)
  // Bisect: find the first prefix that fails, which names the module that breaks it.
  let lo = 0
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('\n')
    if (compiles(prefix) !== null) {
      console.log(`  the first ${i} modules fail together; the last added one is ${manifest.modules[i - 1]}`)
      lo = i
      break
    }
  }
  if (lo === 0) console.log('  every prefix compiles — the failure needs a later module')
}

console.log('')
console.log(broken === 0 ? 'PASS — every module and the concatenation compile' : `FAIL — ${broken} problem(s)`)
process.exit(broken === 0 ? 0 : 1)
