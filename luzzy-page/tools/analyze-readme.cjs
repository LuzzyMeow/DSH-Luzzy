// What markdown features does README.md use? This sets the scope for the iframe's
// in-page renderer (no library is available inside the iframe either).
const { readFileSync } = require('node:fs')
const t = readFileSync('README.md', 'utf8')
const count = (re) => (t.match(re) ?? []).length

console.log('README.md markdown surface:')
console.log('  headings      ', count(/^#{1,6} /gm))
console.log('  code fences   ', count(/^```/gm))
console.log('  table rows    ', count(/^\|/gm))
console.log('  list items    ', count(/^\s*[-*] /gm))
console.log('  bold          ', count(/\*\*[^*]+\*\*/g))
console.log('  inline code   ', count(/`[^`]+`/g))
console.log('  links         ', count(/\[[^\]]+\]\([^)]+\)/g))
console.log('  blockquotes   ', count(/^> /gm))
console.log('  hr            ', count(/^---$/gm))
console.log('  total lines   ', t.split('\n').length)