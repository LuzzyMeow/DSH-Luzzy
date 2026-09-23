// Simpler: find all occurrences of both method names with context.
const { readFileSync } = require('node:fs')
const t = readFileSync(
  'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js',
  'utf8',
)

function show(name) {
  console.log(`===== ${name} =====`)
  let from = 0
  let count = 0
  for (;;) {
    const i = t.indexOf(name, from)
    if (i < 0) break
    from = i + name.length
    count++
    const before = t.slice(Math.max(0, i - 100), i)
    const after = t.slice(i, i + 240)
    const isDef = /(^|\W)entriesOf\w*\s*\(\s*[a-z]/.test(after) && /=>|function/.test(after)
    console.log(`--- hit ${count} at ${i} ${isDef ? '(def?)' : ''}`)
    console.log(before.replace(/\s+/g, ' '))
    console.log(' >> ' + after.replace(/\s+/g, ' ').slice(0, 220))
    console.log()
    if (count >= 6) break
  }
}

show('entriesOfSlot')
show('entriesOf(')