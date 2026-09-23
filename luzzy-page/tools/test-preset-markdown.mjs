// Regression test for the preset sub-page's Markdown toolbar and preview.
//
// WHAT THIS COVERS AND WHY IT NEEDS ITS OWN SUITE
//
// `applyMarkdownTool` is pure — it takes (value, start, end, id) and returns the next value
// plus the next selection — so it can be driven directly instead of through a browser. The
// alternative was asserting through the rig, which costs a real Edge launch and could only
// test the handful of buttons a scenario happens to click.
//
// The functions are LIFTED OUT OF THE BUILT BUNDLE, not reimplemented here. A copy would
// keep passing after the real one changed, which is the failure this suite exists to catch.
//
// The three behaviours asserted hardest are the ones a hand-rolled toolbar usually gets
// wrong: the toggle-off round trip, the empty selection, and line prefixes over a
// multi-line selection.
//
// Usage: node tools/test-preset-markdown.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

const failures = []
const notes = []

function check(label, ok, detail = '') {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

function same(label, actual, expected) {
  return check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// LIFTING THE FUNCTIONS
//
// The bundle inlines the frame document as a template literal, so the functions are not
// directly reachable as source. Rather than un-escaping that literal by hand — a blanket
// `.replace(/\\n/g, '\n')` also rewrites the backslashes INSIDE regex literals in the frame
// script and produces invalid JavaScript — the real `buildFrameDocument()` is called and the
// functions are lifted out of the document it actually produces. That is the same artifact
// the browser receives, so the regexes are the real ones.
const frameStart = bundle.indexOf('function buildFrameDocument(')
if (frameStart < 0) throw new Error('buildFrameDocument not found in the bundle')
let braceDepth = 0
let frameEnd = -1
for (let i = bundle.indexOf('{', frameStart); i < bundle.length; i += 1) {
  if (bundle[i] === '{') braceDepth += 1
  else if (bundle[i] === '}') {
    braceDepth -= 1
    if (braceDepth === 0) { frameEnd = i + 1; break }
  }
}
if (frameEnd < 0) throw new Error('could not find the end of buildFrameDocument')

const buildFrameDocument = new Function(`${bundle.slice(frameStart, frameEnd)}; return buildFrameDocument`)()
const frameHtml = buildFrameDocument('', 'light')

const scriptMatch = frameHtml.match(/<script>\s*\n'use strict'([\s\S]*?)<\/script>/)
if (scriptMatch === null) throw new Error('no use-strict script block in the frame document')
const source = scriptMatch[1]

function lift(name, signature, bindings) {
  const at = source.indexOf(signature)
  if (at < 0) return null
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', at); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) return null
  const fnSource = source.slice(at, end)
  // `name` is the bare identifier to return; `signature` is only used to FIND the function,
  // so it must never be pasted into the return statement (doing that referenced the
  // parameter names as values).
  if (bindings === undefined) return new Function(`${fnSource}; return ${name}`)()
  const names = Object.keys(bindings)
  const values = names.map((key) => bindings[key])
  return new Function(...names, `${fnSource}; return ${name}`)(...values)
}

// esc is a neighbour in the frame script, not a global, so lift it first and hand it to
// renderMarkdown — a lifted function is compiled in its own scope and cannot see the frame's.
const esc = lift('esc', 'function esc(s)')
check('esc found in the frame script', typeof esc === 'function')

const applyMarkdownTool = lift('applyMarkdownTool', 'function applyMarkdownTool(value, start, end, id)')
const renderMarkdown = lift('renderMarkdown', 'function renderMarkdown(src)', { esc })

check('applyMarkdownTool found in the frame script', typeof applyMarkdownTool === 'function')
check('renderMarkdown found in the frame script', typeof renderMarkdown === 'function')
if (typeof applyMarkdownTool !== 'function' || typeof renderMarkdown !== 'function') {
  console.log(notes.concat(failures).join('\n'))
  process.exit(1)
}

// ---------------------------------------------------------------- toolbar

const at = (value, start, end, id) => applyMarkdownTool(value, start, end, id)

// --- bold: wrap, then unwrap
{
  const once = at('hello world', 0, 5, 'bold')
  same('bold wraps the selection', once.value, '**hello** world')
  check('bold keeps the selection on the wrapped text', once.start === 2 && once.end === 7,
    `start=${once.start} end=${once.end}`)
  const twice = at(once.value, once.start, once.end, 'bold')
  same('bold toggles back off', twice.value, 'hello world')
}

// --- bold when the markers are INSIDE the selection (a double-click on **x** selects them)
{
  const off = at('**hello** world', 0, 9, 'bold')
  same('bold unwraps when the markers are selected with the text', off.value, 'hello world')
}

// --- empty selection produces a caret between the markers, not a stray pair
{
  const empty = at('ab', 1, 1, 'bold')
  same('bold on an empty selection inserts an empty pair', empty.value, 'a****b')
  same('the caret lands between the markers', empty.start, 3)
  same('the caret is a collapsed selection', empty.end, 3)
}

// --- italic is distinct from bold: the marker must not be doubled
{
  const ital = at('hi', 0, 2, 'italic')
  same('italic wraps with a single asterisk', ital.value, '*hi*')
}

// --- h1/h2/h3 are three separate buttons now, not one "heading"
{
  const h1 = at('one\ntwo', 0, 7, 'h1')
  same('h1 prefixes the first line', h1.value.split('\n')[0], '# one')
  same('h1 prefixes the line the selection ends on', h1.value.split('\n')[1], '# two')
  same('h2 uses two hashes', at('x', 0, 1, 'h2').value, '## x')
  same('h3 uses three hashes', at('x', 0, 1, 'h3').value, '### x')
  // Switching level must REPLACE the marker, not stack another one on top: going h1 -> h3 on
  // "# x" has to give "### x", never "# ### x".
  same('a heading level replaces the previous level', at('# x', 0, 3, 'h3').value, '### x')
}
{
  const partial = at('keep\nchange\nkeep', 5, 11, 'h2')
  same('lines outside the selection are untouched', partial.value.split('\n')[0], 'keep')
  same('the selected line is prefixed', partial.value.split('\n')[1], '## change')
  same('the trailing line is untouched', partial.value.split('\n')[2], 'keep')
}

// --- strike, task list, code block, table: new in this revision
{
  same('strike wraps with a doubled tilde', at('gone', 0, 4, 'strike').value, '~~gone~~')
  same('strike toggles back off', at('~~gone~~', 0, 8, 'strike').value, 'gone')
  same('task list adds an unchecked box', at('todo', 0, 4, 'task').value, '- [ ] todo')
  same('task list toggles off', at('- [x] todo', 0, 10, 'task').value, 'todo')
  const block = at('code', 0, 4, 'codeblock')
  check('code block puts the fences on their own lines', /\n\n```\ncode\n```\n\n/.test(block.value), JSON.stringify(block.value))
  const table = at('', 0, 0, 'table')
  check('table inserts a usable header row', table.value.includes('| --- | --- |'), JSON.stringify(table.value))
}

// --- clear strips INLINE formatting only; line structure is deliberately preserved
{
  const cleared = at('**bold** and *italic* and ~~gone~~ and `code`', 0, 47, 'clear')
  same('clear removes inline markers', cleared.value, 'bold and italic and gone and code')
}
{
  // The button is labelled "clear INLINE formatting" — stripping a heading would silently
  // destroy document structure the user did not ask to remove.
  const structural = at('## Title\n- a\n1. b\n> q', 0, 20, 'clear')
  same('clear leaves headings and lists alone', structural.value, '## Title\n- a\n1. b\n> q')
}
{
  const prose = at('3 * 4 * 5', 0, 9, 'clear')
  same('clear leaves arithmetic asterisks alone', prose.value, '3 * 4 * 5')
}

// --- link: the caret should land in the URL, so typing continues there
{
  const link = at('site', 0, 4, 'link')
  same('link uses the selection as the label', link.value, '[site](https://)')
  const empty = at('', 0, 0, 'link')
  same('link with no selection supplies placeholder text', empty.value, '[链接文字](https://)')
  check('the caret lands inside the href', empty.value.slice(empty.start, empty.end) === 'https://',
    `selected ${JSON.stringify(empty.value.slice(empty.start, empty.end))}`)
}

// --- clear strips only inline markers, never structural ones
{
  const cleared = at('## Title\n- a\n1. b\n> q', 0, 20, 'clear')
  same('clear leaves structural markers intact', cleared.value, '## Title\n- a\n1. b\n> q')
  const prose = at('3 * 4 * 5', 0, 9, 'clear')
  same('clear leaves arithmetic asterisks alone', prose.value, '3 * 4 * 5')
}

// --- an unknown id must not corrupt the text
{
  const unknown = at('abc', 1, 2, 'nope')
  same('an unknown tool id leaves the value unchanged', unknown.value, 'abc')
}

// ---------------------------------------------------------------- renderer

const render = (src) => renderMarkdown(src).replace(/&amp;/g, '&')

// --- the constructs the real 57 KB prompt file actually uses
check('renderer emits an unordered list', render('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'))
check('renderer emits an ordered list', render('1. a\n2. b').includes('<ol><li>a</li><li>b</li></ol>'))
check('renderer emits a blockquote', render('> quoted').includes('<blockquote>quoted</blockquote>'))
check('renderer emits a heading', render('## Two').includes('<h2>Two</h2>'))
check('renderer emits a table', render('| a | b |\n|---|---|\n| 1 | 2 |').includes('<table>'))
check('renderer emits bold', render('**x**').includes('<strong>x</strong>'))
check('renderer emits italic', render('*x*').includes('<em>x</em>'))
check('renderer emits inline code', render('a `x` b').includes('<code>x</code>'))
check('renderer emits strikethrough', render('~~x~~').includes('<del>x</del>'))
check('renderer emits a task list item', render('- [x] done').includes('data-done="1"'), render('- [x] done'))
check('an unchecked task box is not marked done', render('- [ ] todo').includes('data-done="0"'))
check('renderer honours heading depth past h3', render('#### Four').includes('<h4>Four</h4>'), render('#### Four'))

// --- a bullet list immediately followed by an ordered list must CLOSE the ul first.
// With a single list-open flag the <ol> would nest inside the <ul>.
{
  const html = render('- a\n1. b')
  check('a ul followed by an ol does not nest', html.includes('</ul><ol>'),
    html.slice(0, 120))
}

// --- inline emphasis must not fire on arithmetic
{
  const html = render('3 * 4 * 5')
  check('arithmetic asterisks are not emphasised', !html.includes('<em>'), html.slice(0, 120))
}

// --- XSS: user text must never become markup
{
  const html = render('<img src=x onerror=alert(1)>')
  check('html in the prompt is escaped', html.includes('&lt;img') && !html.includes('<img'),
    html.slice(0, 120))
}
{
  const html = render('<script>alert(1)</script>')
  check('a script tag in the prompt is escaped', !html.includes('<script>'), html.slice(0, 120))
}
{
  // esc() alone would leave this a live javascript: link, so the scheme is checked too.
  const html = render('[x](javascript:alert(1))')
  check('a javascript: link does not become an anchor', !html.includes('<a '), html.slice(0, 160))
}
{
  const html = render('[ok](https://example.com)')
  check('an https link does become an anchor with safe rel', html.includes('rel="noreferrer noopener"'),
    html.slice(0, 160))
}

// --- fenced code is preserved verbatim and not parsed as markup
{
  const html = render('```\n**not bold**\n```')
  check('fenced code keeps its asterisks literal', html.includes('**not bold**') && !html.includes('<strong>'),
    html.slice(0, 140))
}

// --- the renderer must be total: no input should throw
{
  const nasty = ['', '\n\n\n', '>', '-', '|', '***', '[', '`', '#######', '1.', '\u0000', '```\nunclosed']
  let threw = null
  for (const input of nasty) {
    try { renderMarkdown(input) } catch (error) { threw = `${JSON.stringify(input)}: ${error.message}` }
  }
  check('the renderer never throws on degenerate input', threw === null, String(threw))
}

// ---------------------------------------------------------------- the serializer
//
// THIS IS THE RISKY DIRECTION AND THE REASON IT IS TESTED HARDEST.
//
// Rendering Markdown -> HTML can drop nothing a reader needs, so it is safe. Going back —
// edited DOM -> Markdown — CANNOT recover formatting a browser invented, and its output is
// what gets written to the file the model actually reads. A silent loss here would change the
// user's system prompt without telling them.
//
// The contract asserted is NOT byte-identity (a browser cannot promise that: it normalises
// whitespace, and the user may legitimately have edited). It is STRUCTURAL FIDELITY: rendering
// the serialized Markdown must produce the same document again. If it does, the round trip
// lost nothing that matters.
const serializeMarkdown = lift('serializeMarkdown', 'function serializeMarkdown(root)', { esc, renderMarkdown })
check('serializeMarkdown found in the frame script', typeof serializeMarkdown === 'function')

// A tiny DOM is enough: the serializer reads tagName/children/getAttribute/textContent, all of
// which this models. It is deliberately NOT a full DOM implementation — it only has to be a
// faithful enough stand-in for the node shapes renderMarkdown emits, and the fidelity check
// below runs the real renderer on both sides.
function makeElement(tag) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    attributes: {},
    classList: { contains: () => false },
    get textContent() { return el.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join('') },
    get children() { return el.childNodes.filter((n) => n.nodeType === 1) },
    getAttribute: (name) => (name in el.attributes ? el.attributes[name] : null),
    setAttribute: (name, value) => { el.attributes[name] = String(value) },
    querySelector: (sel) => {
      for (const child of el.childNodes) {
        if (child.nodeType !== 1) continue
        if (sel.startsWith('.') && child.attributes.class === sel.slice(1)) return child
        if (child.tagName.toLowerCase() === sel.toLowerCase()) return child
        const deep = child.querySelector(sel)
        if (deep !== null) return deep
      }
      return null
    },
    querySelectorAll: (sel) => {
      const found = []
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue
          if (child.tagName.toLowerCase() === sel.toLowerCase()) found.push(child)
          walk(child)
        }
      }
      walk(el)
      return found
    },
    appendChild: (node) => { el.childNodes.push(node); return node },
    cloneNode: () => el,
  }
  return el
}
const text = (value) => ({ nodeType: 3, nodeValue: value, textContent: value })
const h = (tag, kids, attrs) => {
  const el = makeElement(tag)
  for (const kid of kids || []) el.appendChild(typeof kid === 'string' ? text(kid) : kid)
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v)
  return el
}

/**
 * Parse the HTML renderMarkdown emits into the stand-in tree.
 *
 * A deliberately small parser: it understands the tags the renderer produces plus
 * self-closing/void elements, and DECODES the entities esc() writes. It is not a general HTML
 * parser and must not be used as one — its only job is to hand the serializer the same node
 * shapes the browser would, so the fidelity check exercises real behaviour.
 */
function buildTree(root, html) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }
  const decode = (s) => s.replace(/&(amp|lt|gt|quot);/g, (m) => entities[m])
  const VOID = new Set(['br', 'hr', 'img'])
  const stack = [root]
  let rest = html

  while (rest !== '') {
    const open = rest.indexOf('<')
    if (open === -1) { stack[stack.length - 1].appendChild(text(decode(rest))); break }
    if (open > 0) { stack[stack.length - 1].appendChild(text(decode(rest.slice(0, open)))); rest = rest.slice(open) }

    const close = rest.indexOf('>')
    if (close === -1) { stack[stack.length - 1].appendChild(text(decode(rest))); break }
    const raw = rest.slice(1, close)
    rest = rest.slice(close + 1)

    if (raw.startsWith('/')) { stack.pop(); continue }

    const space = raw.search(/\s/)
    const tag = (space === -1 ? raw : raw.slice(0, space)).toLowerCase()
    const el = makeElement(tag)
    if (space !== -1) {
      const attrText = raw.slice(space + 1)
      for (const m of attrText.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) el.setAttribute(m[1], decode(m[2]))
    }
    stack[stack.length - 1].appendChild(el)
    if (!VOID.has(tag) && !raw.endsWith('/')) stack.push(el)
  }
  return root
}

{
  // Structural fidelity: render(md) -> serialize -> render must equal render(md) again.
  const samples = [
    '# Title\n\nplain paragraph',
    'para with **bold** and *italic* and ~~strike~~',
    'a `code span` inline',
    '- one\n- two\n- three',
    '1. first\n2. second',
    '- [x] done\n- [ ] todo',
    '> a quoted line',
    '## Section\n\n### Deeper\n\n#### Even deeper',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    'see [label](https://example.com/x) here',
    'before\n\n---\n\nafter',
    '```\nfenced **literal**\n```',
    'a **bold** and a [link](https://e.com) and `x` in one line',
  ]
  let mismatch = null
  for (const sample of samples) {
    const first = renderMarkdown(sample)
    // Build a stand-in tree from the real rendered HTML, then serialize and re-render.
    const container = makeElement('div')
    buildTree(container, first)
    const back = serializeMarkdown(container)
    const second = renderMarkdown(back)
    // Compare the *document* both times, ignoring the wrapper div's own attributes.
    const strip = (html) => html.replace(/^<div class="markdown">/, '').replace(/<\/div>$/, '')
    if (strip(first) !== strip(second)) {
      mismatch = { sample: JSON.stringify(sample), md: JSON.stringify(back) }
      break
    }
  }
  check('a document survives render -> serialize -> render unchanged', mismatch === null,
    mismatch === null ? '' : JSON.stringify(mismatch))
}
{
  // The serializer must never invent syntax the source did not have, and never drop text.
  const container = makeElement('div')
  container.appendChild(h('p', ['plain words only']))
  same('a plain paragraph serializes to itself', serializeMarkdown(container).trim(), 'plain words only')
}
{
  // An unknown element must degrade to its text rather than vanishing.
  const container = makeElement('div')
  container.appendChild(h('figure', ['important words']))
  check('an unknown element keeps its text', serializeMarkdown(container).includes('important words'),
    JSON.stringify(serializeMarkdown(container)))
}
{
  // A javascript: href was never a link in the renderer, so the serializer must not invent one.
  const container = makeElement('div')
  container.appendChild(h('p', [h('a', ['x'], { href: 'javascript:alert(1)' })]))
  check('a javascript: href is not serialized as a link', !serializeMarkdown(container).includes(']('),
    JSON.stringify(serializeMarkdown(container)))
}
{
  // A code span containing a backtick needs a longer fence, or it would break out of itself.
  const container = makeElement('div')
  container.appendChild(h('p', [h('code', ['a ' + String.fromCharCode(96) + ' b'])]))
  const out = serializeMarkdown(container)
  check('a code span containing a backtick uses a longer fence', out.includes('``'), JSON.stringify(out))
}
{
  let threw = null
  for (const build of [
    () => { const c = makeElement('div'); return c },
    () => { const c = makeElement('div'); c.appendChild(h('p', [])); return c },
    () => { const c = makeElement('div'); c.appendChild(h('table', [])); return c },
    () => { const c = makeElement('div'); c.appendChild(h('pre', ['unclosed fence'])); return c },
  ]) {
    try { serializeMarkdown(build()) } catch (error) { threw = error.message }
  }
  check('the serializer never throws on degenerate input', threw === null, String(threw))
}

// ---------------------------------------------------------------- toolbar wiring (static)

check('the toolbar is declared as data', bundle.includes('const MD_TOOLS'))
for (const id of ['bold', 'italic', 'strike', 'code', 'clear', 'h1', 'h2', 'h3',
  'bullet', 'ordered', 'task', 'codeblock', 'quote', 'table', 'hr', 'link']) {
  check(`toolbar offers ${id}`, new RegExp(`id: '${id}'`).test(bundle))
}
// Underline is not implementable: Markdown has no syntax for it, and letting raw HTML through
// the renderer is exactly the XSS hole it closes. A button whose output the preview drops is
// worse than no button — so this is an assertion, not a gap.
check('no underline button is offered', !/id: 'underline'/.test(bundle))
check('the toolbar is grouped for the divider rendering', bundle.includes('MD_GROUPS'))
check('every button is rendered from the groups', bundle.includes('.map(function (tool)'))
check('every button carries its tool id', bundle.includes('data-md="'))
check('every button has an accessible name', bundle.includes('aria-label="'))
check('icons are hand-written SVG, not a dependency', bundle.includes('const MD_ICONS'))
check('toolbar buttons keep focus in the textarea', bundle.includes("addEventListener('mousedown'"))
check('toolbar edits go through setRangeText for undo', bundle.includes('setRangeText'))

// --- one surface per mode, and it is the RENDERED document
check('the editor is ONE surface, not split panes', !bundle.includes('mdPanePreview'))
check('the rendered surface exists and is the editable one', bundle.includes('id="presetVisual"'))
check('the rendered surface is contenteditable', bundle.includes('contenteditable="'))
check('the rendered surface is rendered from promptText', bundle.includes('renderMarkdown(promptText)'))
check('the serializer is the write-back path', bundle.includes('serializeMarkdown(visual)'))
// The write-back must happen on a real edit only. Re-serializing on render would normalize any
// construct the serializer does not model the moment someone merely looked at the view.
check('the write-back is bound to the input event', bundle.includes("visual.addEventListener('input'"))
check('pastes are forced to plain text', bundle.includes("getData('text/plain')"))
check('exactly one surface per mode is visible', bundle.includes(".mdArea[data-mode='live'] textarea.mdLayer"))
check('source mode shows the raw textarea', bundle.includes(".mdArea[data-mode='source'] .mdVisual"))

// --- the three display modes
for (const mode of ['live', 'source', 'reading']) {
  check(`mode ${mode} exists`, new RegExp(`id: '${mode}'`).test(bundle))
}
check('live preview is the default mode', /let promptMode = 'live'/.test(bundle))
check('the mode menu is rendered from MD_MODES', bundle.includes('MD_MODES.map'))
check('the mode menu marks the current mode for AT', bundle.includes('role="menuitemradio"'))
check('the mode menu opens upward', bundle.includes('bottom: calc(100% + 6px)'))
// Visibility must ride ONE attribute. A hidden property toggled alongside it is a second
// source of truth that the next re-render overwrites, and the two eventually disagree.
check('mode visibility rides the area attribute alone', bundle.includes(".mdArea[data-mode='source'] .mdVisual"))
// Every redraw goes through syncVisual, which is what keeps the empty-state flag in step with
// the document. A direct assignment somewhere else would silently skip that, so the only
// remaining direct assignment must be the one INSIDE syncVisual.
const directVisualWrites = (bundle.match(/visual\.innerHTML = renderMarkdown/g) ?? []).length
check('every surface redraw goes through syncVisual', directVisualWrites === 1,
  `found ${directVisualWrites} direct assignments`)
check('live mode is the default and is editable', /let promptMode = 'live'/.test(bundle))

// --- the caret-driven active tint
check('the active set is read from the caret line', bundle.includes('function activeToolsFor'))
check('an active button is tinted', bundle.includes("[data-on='true']"))
// The tint must never be set speculatively at render time: it reports what the text IS.
check('buttons render as inactive by default', bundle.includes('data-on="false"'))

// --- the design system's scales (see the design review: these had drifted badly)
//
// WHY THESE ARE ASSERTIONS AND NOT TASTE
//
// DESIGN.md fixes the body scale at 12 / 14 / 16 (there is no 13px step), the radius ladder at
// 4 / 6 / 8 / 12 (+ 999 for pills), and spacing to a 4px base. The frame had drifted to 14 type
// sizes, 8 radii and 16 spacing values — not by anyone deciding to, but one rule at a time.
// "Looks slightly off" is the symptom of exactly that drift, and it is invisible in review.
// So the scales are pinned here: a future edit that reaches for 13px or a 10px radius fails
// this suite and has to argue for itself.
//
// 1px/2px spacing and 40px padding stay allowed on purpose: the first is reserved for hairlines
// and optical tightening (the toolbar's and the menu's internal gaps), the second is a
// wide-breakpoint page inset rather than a component gap.
const ALLOWED_TYPE = new Set([12, 14, 16, 20, 24])
const ALLOWED_RADIUS = new Set([4, 6, 8, 12, 999])
const ALLOWED_SPACING = new Set([0, 1, 2, 4, 8, 12, 16, 20, 24, 32, 40])

function valuesOf(re) {
  const found = new Set()
  for (const m of bundle.matchAll(re)) found.add(Number(m[1]))
  return [...found].sort((a, b) => a - b)
}

const typeSizes = valuesOf(/font-size:\s*([\d.]+)px/g)
const offType = typeSizes.filter((v) => !ALLOWED_TYPE.has(v))
check('the type scale stays on 12/14/16/20/24', offType.length === 0,
  `off-scale sizes: ${offType.join(', ')}`)

const radii = valuesOf(/border-radius:\s*([\d.]+)px/g)
const offRadius = radii.filter((v) => !ALLOWED_RADIUS.has(v))
check('the radius ladder stays on 4/6/8/12/999', offRadius.length === 0,
  `off-scale radii: ${offRadius.join(', ')}`)

const spacing = valuesOf(/(?:padding|gap|margin)(?:-top|-bottom|-left|-right)?:\s*(\d+)px/g)
const offSpacing = spacing.filter((v) => !ALLOWED_SPACING.has(v))
check('spacing stays on the 4px base scale', offSpacing.length === 0,
  `off-scale spacing: ${offSpacing.join(', ')}`)

// The decorative background was a hard-coded violet radial glow. Three separate rules forbade
// it (semantic tokens only, no AI-violet default, and no ornament that cannot justify itself),
// so its absence is asserted rather than left to review.
check('the decorative radial glow is gone', !bundle.includes('radial-gradient'))

// The empty-editor hint rides generated content, NOT an element. A real placeholder node would
// be picked up by serializeMarkdown and could be written into the user's prompt; CSS content is
// not in the DOM at all, so that class of bug cannot happen.
check('the empty hint is generated content, not an element',
  bundle.includes("mdVisual[data-empty='true']::before"))
check('the empty hint is driven by a flag the renderer maintains', bundle.includes('data-empty="'))

// The group delete affordance must stay reachable without a hover, and named with a verb.
check('group delete is named with verb + noun', bundle.includes('aria-label="删除分组 '))
check('group delete is not permanently visible', bundle.includes('.rosterGroupDel {'))
check('group delete is revealed on hover and focus', bundle.includes('.rosterGroupHead:hover .rosterGroupDel'))

// A failure message must be a sentence a person can act on, with the machine text behind a
// disclosure rather than in the headline.
check('failures read as plain sentences', bundle.includes('用量数据读不出来'))
check('machine detail is disclosed, not headlined', bundle.includes('statusDetail'))

console.log(notes.join('\n'))
if (failures.length > 0) {
  console.log('\n' + failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} check(s)`)
  process.exit(1)
}
console.log(`\nPASS — ${notes.length} checks (markdown toolbar + preview)`)
