// Read the list-kind rendering branch of the renderer: conversation.view is a LIST slot,
// and its branch (with the `only` filter) has never been read. Reading it is how we find
// out why a registered, selected entry renders nothing.
const { readFileSync } = require('node:fs')
const t = readFileSync(
  'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js',
  'utf8',
)

let index = t.indexOf('spec.kind === "list"')
if (index < 0) index = t.indexOf("spec.kind === 'list'")
if (index < 0) {
  console.log('list branch not found; kinds present:')
  const kinds = [...t.matchAll(/spec\.kind === "([a-z]+)"/g)].map((m) => m[1])
  console.log([...new Set(kinds)].join(', '))
  process.exit(0)
}
console.log(t.slice(index, index + 1900))