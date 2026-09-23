// entriesOf delegates to _core.entries — find that in the slots core: this is the
// DECLARATION table (what inject() contributed), vs entriesOfSlot (registration winners).
const { readFileSync } = require('node:fs')
const t = readFileSync(
  'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js',
  'utf8',
)
let from = 0
for (;;) {
  const i = t.indexOf('entries(', from)
  if (i < 0) break
  from = i + 8
  const after = t.slice(i, i + 320)
  if (/entries\([a-zA-Z]*\)\s*\{/.test(after)) {
    console.log('=== def at', i, '===')
    console.log(t.slice(Math.max(0, i - 220), i + 420).replace(/\n{2,}/g, '\n'))
    console.log('-----')
  }
}