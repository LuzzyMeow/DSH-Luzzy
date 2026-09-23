// Read the complete list branch: rows building, only filter, and the empty case.
const { readFileSync } = require('node:fs')
const t = readFileSync(
  'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js',
  'utf8',
)
const anchor = t.indexOf('list = [...rows].sort')
if (anchor < 0) {
  console.log('anchor not found')
  process.exit(0)
}
console.log(t.slice(Math.max(0, anchor - 1600), anchor + 900))