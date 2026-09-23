// Assert the client bundle contains NO React hooks from a second React instance.
// React error #321 (invalid hook call) blanked the page; this is its regression test.
const { readFileSync } = require('node:fs')

// Strip comments so documentation mentioning the rule doesn't false-positive.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/^\s*\/\/.*$/gm, '') // line comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // inline comments (not inside URLs)
}

const src = stripComments(readFileSync('src/client.js', 'utf8'))
const lib = stripComments(readFileSync('lib/client.js', 'utf8'))

const hookNames = ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef']
let failures = 0

for (const [label, text] of [['src', src], ['lib', lib]]) {
  for (const hook of hookNames) {
    const count = (text.match(new RegExp(`\\b${hook}\\b`, 'g')) ?? []).length
    if (count > 0) {
      console.log(`FAIL ${label}: ${hook} x${count} — no second-React hooks are allowed`)
      failures++
    }
  }
  const requireReact = text.includes("require('react')")
  if (requireReact) {
    console.log(`FAIL ${label}: require('react') present — it is a second instance`)
    failures++
  }
}

// useStore must be PRESENT: it is the store share prop, the renderer's own React hook,
// which is legal inside the renderer's tree — the one sanctioned state channel.
// The iframe architecture removed the need for ANY framework state channel: the frame
// hosts its own document and its own state. So assert the opposite of what the previous
// architecture required — no store share at all, and a frame-hosted page.
for (const [label, text] of [['src', src], ['lib', lib]]) {
  const storeShare = (text.match(/\buseStore\b/g) ?? []).length
  if (storeShare > 0) {
    console.log(`FAIL ${label}: useStore present — the iframe architecture needs no store`)
    failures++
  }
  if (!text.includes('srcDoc')) {
    console.log(`FAIL ${label}: no srcDoc — the page must render its own frame`)
    failures++
  }
}

if (failures === 0) {
  console.log('PASS — no second-React hooks, no require("react"), page is frame-hosted')
} else {
  process.exit(1)
}