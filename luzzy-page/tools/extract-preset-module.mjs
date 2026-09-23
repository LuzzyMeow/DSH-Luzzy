// One-off: lift the 「预设」 editor (prompt editing + roster management) into the new layout,
// VERBATIM apart from a short, explicit list of boundary adaptations.
//
// Why extract instead of rewrite
// ------------------------------
// ~1400 lines carrying behaviours that were each paid for with a real bug: the three-mode
// single-face editor, caret-preserving round trips, the archive-not-delete dialog, the
// revision guard that makes the host's 409 concurrency check live, the drag-reorder, the
// in-flight guard on "new session". tools/review-preset-chain.mjs (static cross-artifact
// audit) and tools/review-preset-rig.mjs (150+ dynamic assertions through a real browser)
// both read this code by name. A rewrite would invalidate all of it.
//
// The adaptations are BOUNDARY only — the module now lives in its own IIFE, so names that
// used to be frame globals must be reached through the LZ namespace. Every substitution is
// counted and printed, and the script asserts no unadapted reference survives.
//
// Usage: node tools/extract-preset-module.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// THE SOURCE IS THE PRE-v2 FILE, FROM GIT — NOT THE CURRENT src/client.js.
//
// The v2 build rewrote src/client.js into a thin outer bundle, so the editor is no longer there.
// This is a one-shot migration tool: it reads the last revision that had the single-file page.
// Pointing it at the working tree yields "not found: could not find the frame template literal",
// which reads like corruption rather than like a moved source.
const LEGACY_REVISION = process.env.LUZZY_LEGACY_REV ?? 'HEAD'
const LINES = (() => {
  try {
    const text = execFileSync('git', ['show', `${LEGACY_REVISION}:luzzy-page/src/client.js`], {
      cwd: join(PLUGIN_ROOT, '..'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return text.split('\n')
  } catch (error) {
    console.error(`cannot read the legacy src/client.js from git ${LEGACY_REVISION}:`, error.message)
    console.error('this is a one-shot migration tool; it needs the pre-v2 revision to exist.')
    process.exit(1)
  }
})()

/** 1-based inclusive slice. */
function region(from, to) {
  return LINES.slice(from - 1, to)
}

// Two disjoint regions hold the preset editor; everything between them is the goal page and
// the shared dialog layer, both of which now live in their own modules.
// Both halves must be SPREAD. Writing `[...head, '', body]` leaves the second region as a
// single array element, and joining turns it into a comma-separated string — which parses as
// a stray comma at the seam and produces a file far shorter than the source.
const head = region(1915, 2093)
// 4142, not 4141: the last function in the region closes on 4142, and cutting one line early
// leaves an unclosed brace. The symptom is a SyntaxError at the very END of the generated
// file (on the wrapper's closing paren), which points nowhere near the real seam.
const body = region(2828, 4142)

let code = [...head, '', ...body].join('\n')

// ---------------------------------------------------------------- adaptations

const adaptations = []
/**
 * Substitute only at CALL positions.
 *
 * A bare /name\(/ also matches the DEFINITION (`function name(`), which rewrites it into
 * `function LZ.X.y(` — a syntax error at the seam, far from where the substitution was
 * written. The negative lookbehind for `function ` is what keeps definitions intact.
 */
function substitute(label, pattern, replacement) {
  const before = code
  code = code.replace(pattern, replacement)
  const count = before === code ? 0 : (before.match(pattern) ?? []).length
  adaptations.push({ label, count })
}

const CALL = (name, suffix) =>
  new RegExp(`(?<![\\w$.])(?<!function\\s)${name}\\(${suffix ?? ''}`, 'g')

// --- shared helpers now live in modules
// `esc` and `report` keep their own names (they are bound as locals in the wrapper), so they
// are NOT substituted here. Everything that moved into a namespace IS.
substitute('renderMarkdown → LZ.Markdown.render', CALL('renderMarkdown'), 'LZ.Markdown.render(')
substitute('serializeMarkdown → LZ.Markdown.serialize', CALL('serializeMarkdown'), 'LZ.Markdown.serialize(')
substitute('applyMarkdownTool → LZ.Markdown.applyTool', CALL('applyMarkdownTool'), 'LZ.Markdown.applyTool(')
substitute('activeToolsFor → LZ.Markdown.activeTools', CALL('activeToolsFor'), 'LZ.Markdown.activeTools(')
substitute('showMessage → LZ.Dialog.message', CALL('showMessage'), 'LZ.Dialog.message(')
substitute('showConfirm → LZ.Dialog.confirm', CALL('showConfirm'), 'LZ.Dialog.confirm(')
substitute('showPrompt → LZ.Dialog.prompt', CALL('showPrompt'), 'LZ.Dialog.prompt(')
substitute('dialogLine → LZ.Dialog.line', CALL('dialogLine'), 'LZ.Dialog.line(')
// `statusBlock` was a frame global in the old file and was NOT part of either extracted region;
// it is now a shared component. Without this the preset page throws at RENDER time — the module
// loads fine and only the preset tab breaks, which is the shape of failure that costs the most
// time to find.
substitute('statusBlock → LZ.EmptyState.statusBlock', CALL('statusBlock'), 'LZ.EmptyState.statusBlock(')

// --- frame-level handles now come from the shell
substitute('content → contentNode()', /(?<![\w$.])content\./g, 'contentNode().')
substitute("state.tab === 'preset' → onPresetTab()", /state\.tab === 'preset'/g, 'onPresetTab()')
// `render()` is called as a statement throughout; the lookbehind keeps `function render()`
// and `renderPreset()` untouched.
substitute('render() → LZ.App.render()', /(?<![\w$.])render\(\)/g, 'LZ.App.render()')

// `sessionId` stays a module-local variable; the shell pushes updates into it. That keeps
// this file's many `sessionId: sessionId` call sites untouched.
substitute('askForSession() → shell owns the handshake', /(?<![\w$.])askForSession\(\)/g, 'LZ.App.askForSession()')

// ---------------------------------------------------------------- de-duplication

/**
 * Drop a definition that now lives in another module.
 *
 * The preset region overlaps the markdown region: `applyMarkdownTool`, `serializeMarkdown`,
 * `activeToolsFor` and the `MD_*` toolbar tables sit INSIDE lines 2828–4142, so both files
 * got their own copy. Two copies of a 120-line function is exactly the drift this refactor
 * exists to remove — the next edit would land in one of them.
 *
 * `LZ.Markdown` is the owner, and every call site has already been rewritten to reach it
 * through the namespace, so the local copies are dead weight and are removed here.
 */
function dropDefinition(label, opener, closeBrace) {
  const at = code.indexOf(opener)
  if (at < 0) throw new Error(`drop target not found: ${label} (${opener})`)
  let depth = 0
  let end = -1
  for (let i = code.indexOf('{', at); i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) throw new Error(`unbalanced definition: ${label}`)
  const before = code.length
  code = `${code.slice(0, at)}${code.slice(closeBrace === true ? end : at + opener.length)}`
  adaptations.push({ label, count: before - code.length > 0 ? 1 : 0 })
}

/** Drop a `const NAME = [...]` / `= {...}` table by balancing brackets to the line end. */
function dropConst(label, name) {
  const at = code.indexOf(`const ${name} = `)
  if (at < 0) throw new Error(`drop target not found: ${label} (${name})`)
  let depth = 0
  let end = -1
  for (let i = at; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    else if (ch === '\n' && depth === 0) { end = i; break }
  }
  if (end < 0) throw new Error(`unterminated const: ${label}`)
  const before = code.length
  code = `${code.slice(0, at)}${code.slice(end + 1)}`
  adaptations.push({ label, count: before === code.length ? 0 : 1 })
}

// The three pure functions and four tables moved too. Every call site already reaches them
// through LZ.Markdown; the local copies are removed here.
//
// The docblocks that sat above them are kept: they explain WHY the behaviours are the shape
// they are, and Markdown.js has its own copy of that reasoning. Duplicated prose is harmless
// (it cannot drift into a bug); duplicated code is not.
dropConst('MD_ICONS → Markdown 模块', 'MD_ICONS')
dropConst('MD_GROUPS → Markdown 模块', 'MD_GROUPS')
dropConst('MD_MODES → Markdown 模块', 'MD_MODES')
dropConst('MD_TOOLS → Markdown 模块', 'MD_TOOLS')
dropDefinition('applyMarkdownTool → Markdown 模块', 'function applyMarkdownTool(value, start, end, id) {', true)
dropDefinition('serializeMarkdown → Markdown 模块', 'function serializeMarkdown(root) {', true)
dropDefinition('activeToolsFor → Markdown 模块', 'function activeToolsFor(value, caret) {', true)

// ---------------------------------------------------------------- header

const HEADER = `/* pages/preset.js —— 「预设」编辑器：提示词编辑与智能体名单管理。
 *
 * 这是「Agent 配置」页里的**编辑面**：Agent 配置页回答「这个 Agent 现在是什么样」，
 * 这个页面让它可改。它整体从原 src/client.js 搬来，逻辑一行未改，只做了边界适配
 * （见 tools/extract-preset-module.mjs 打印的替换清单）。
 *
 * 三条它承载的关键行为，都别改坏：
 *
 *  1. **SELECTED 与 ACTIVE 是两件事。** SELECTED 是编辑器在看谁的提示词（本页局部）；
 *     ACTIVE 是模型实际会收到的提示词（存在 store 里、所有会话共享、下一次请求生效）。
 *     把两者混起来显示，用户就会以为自己改了、其实没生效，或者反过来。
 *
 *  2. **每次写入都带 revision。** 宿主的 409 并发检查靠它才不是死代码——
 *     少了它，两个窗口同编一份名单会互相覆盖，输的那次改动**悄悄消失**、全程无错。
 *     所以 revision 在 presetPost 里**集中**附加，不靠每个调用点记得。
 *
 *  3. **删除是移入 archive/，不是抹掉。** 对话框照实这么说。上一版承诺「文件会一起删掉，
 *     不能撤销」，而实现根本不删文件——两个方向同时错。
 *
 * 它自己的状态（presetSnapshot / promptText / selectedAgentId …）留在模块内，
 * 不塞进 app.js 的全局状态：这些是编辑器的局部状态，切页即失是正确的语义。
 */
`

const FOOTER = `
  LZ.PresetPage = {
    render: renderPreset,
    ensure: function (force) {
      if (force === true || presetStatus === 'idle') return loadPreset()
      return Promise.resolve()
    },
    status: function () { return presetStatus },
    setSessionId: function (next) {
      const value = typeof next === 'string' && next !== '' ? next : null
      if (value === sessionId) return
      sessionId = value
      // Re-read rather than patch: a stale "cannot switch this session" badge is exactly the
      // kind of wrong statement this page must not show.
      if (onPresetTab()) loadPreset()
    },
    /** Re-render only when this page is the one on screen. */
    refresh: function () { if (onPresetTab()) renderPreset() },
  }
})(window.LZ = window.LZ || {})`

const WRAPPED = `(function (LZ) {
  'use strict'

  const esc = LZ.Format.esc
  const report = LZ.App.report
  const contentNode = LZ.App.content
  const onPresetTab = function () { return LZ.App.state.tab === 'preset' }

  // The toolbar tables moved to the Markdown module, which owns them. They are bound here under
  // their original names rather than rewritten at each call site: this file has thirteen
  // references to them (icon lookup, group iteration, mode filtering), and the local binding
  // keeps the diff to one line instead of thirteen. It is also the safer direction — a missed
  // call site is a ReferenceError at RENDER time, which mounts the page and then throws.
  const MD_ICONS = LZ.Markdown.ICONS
  const MD_GROUPS = LZ.Markdown.GROUPS
  const MD_MODES = LZ.Markdown.MODES
  const MD_TOOLS = LZ.Markdown.TOOLS

${code}
${FOOTER}
`

// ---------------------------------------------------------------- guards

// Anything still referencing a former frame global would be a silent runtime failure.
const leftovers = []
for (const name of ['showDialog', 'closeActiveDialog', 'goalSnapshot', 'goalStatus', 'loadGoal', 'formatStamp']) {
  if (new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code)) leftovers.push(name)
}
if (leftovers.length > 0) {
  throw new Error(`unadapted references survive: ${leftovers.join(', ')}`)
}

// A dropped region would still parse — it just silently loses the editor. Raw line count is
// not a usable guard (de-duplication legitimately removes ~350 lines), so assert the things
// that would actually go missing: the editor, the roster, the toolbar wiring, the revision
// guard. Each of these disappearing would be a silent feature loss.
const REQUIRED = [
  ['编辑器渲染', 'function editorHtml('],
  ['名单渲染', 'function rosterHtml('],
  ['事件接线', 'function wirePreset('],
  ['页面渲染', 'function renderPreset('],
  ['工具栏接线', 'LZ.Markdown.applyTool'],
  ['修订守卫', 'REVISION_GUARDED'],
  ['拖拽排序', 'function wireRosterDrag('],
  ['归档而非删除', 'archive/'],
  ['双击守卫', 'newSessionInFlight'],
]
const missing = REQUIRED.filter(([, needle]) => !WRAPPED.includes(needle)).map(([label]) => label)
if (missing.length > 0) {
  throw new Error(`preset module lost: ${missing.join(', ')}`)
}

const full = join(PLUGIN_ROOT, 'src', 'pages', 'preset.js')
mkdirSync(dirname(full), { recursive: true })
writeFileSync(full, `${HEADER}${WRAPPED}`, 'utf8')

console.log(`wrote src/pages/preset.js — ${WRAPPED.split('\n').length} lines`)
console.log(`${REQUIRED.length} required features present: ${REQUIRED.map(([l]) => l).join(' / ')}\n`)
console.log('adaptations applied:')
for (const row of adaptations) console.log(`  ${String(row.count).padStart(4)}  ${row.label}`)
console.log(`\n${leftovers.length === 0 ? 'no unadapted frame-global references remain' : 'LEFTOVERS: ' + leftovers.join(', ')}`)
