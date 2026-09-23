// One-off: every identifier a module references but never defines or binds.
//
// The migration moved free frame functions into namespaced modules. A function that used to see
// `niceMax` as a frame global now has to receive it as a binding — and a missing binding is a
// ReferenceError at RENDER time, not at load time, so the module evaluates fine, the page mounts,
// and then one specific tab throws. That is the worst shape of failure to find by playing.
//
// This walks each module's AST-free approximation: collect declared names and referenced names,
// subtract the JS globals and the LZ namespace, and report the remainder.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './frame-source.mjs'

const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'manifest.json'), 'utf8'))

/** Globals provided by the browser, by the build harness, or by the frame template. */
const GLOBALS = new Set([
  'window', 'document', 'location', 'navigator', 'fetch', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'AbortController', 'MutationObserver', 'Promise', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Math', 'JSON', 'Date', 'Map', 'Set', 'RegExp', 'Error', 'TypeError', 'isFinite',
  'parseInt', 'parseFloat', 'Symbol', 'Infinity', 'NaN', 'undefined', 'globalThis',
  'Element', 'Node', 'HTMLElement', 'Event', 'CustomEvent', 'URL', 'TextEncoder',
])
/** Names each module is EXPECTED to get from the shared namespace. */
const BINDABLE = new Set(['esc', 'formatTokens', 'formatExact', 'niceMax', 'levelOf', 'COLORS',
  'report', 'renderMarkdown', 'serializeMarkdown', 'applyMarkdownTool', 'activeToolsFor',
  'showDialog', 'showMessage', 'showConfirm', 'showPrompt', 'dialogLine', 'closeActiveDialog',
  'content', 'state', 'render', 'sessionId', 'presetStatus', 'presetError', 'presetSnapshot',
  'selectedAgentId', 'promptText', 'promptDirty', 'promptExists', 'promptInherited', 'promptMode',
  'modeMenuOpen', 'MD_ICONS', 'MD_GROUPS', 'MD_MODES', 'MD_TOOLS', 'REVISION_GUARDED', 'LZ',
  'applySnapshot', 'loadPrompt', 'agentById', 'groupById', 'calloutsHtml', 'sessionBlockHtml',
  'rosterColumns', 'rosterHtml', 'editorHtml', 'markdownToolsHtml', 'markdownFootHtml',
  'renderPreset', 'wirePreset', 'presetPost', 'loadPreset', 'reorderRoster', 'wireRosterDrag',
  'confirmDiscard', 'createSessionViaHost', 'newSessionInFlight', 'updateSaveState',
  'onPresetTab', 'contentNode', 'pageContent', 'suggestId', 'seedStore', 'groupAgentsByGroup',
])

let problems = 0
for (const name of manifest.modules) {
  const text = readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8')
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  // Declarations: function f, const/let/var x, function parameters, catch (e), destructuring.
  const declared = new Set()
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/[=\s:]/)[0]
      if (/^[A-Za-z_$][\w$]*$/.test(id)) declared.add(id)
    }
  }
  for (const m of code.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/[=\s:]/)[0]
      if (/^[A-Za-z_$][\w$]*$/.test(id)) declared.add(id)
    }
  }
  for (const m of code.matchAll(/\bcatch\s*\(([A-Za-z_$][\w$]*)\)/g)) declared.add(m[1])
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  // Destructured properties: `const { a, b } = x`
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/[=:\s]/).pop()
      if (/^[A-Za-z_$][\w$]*$/.test(id)) declared.add(id)
    }
  }
  // Object literal keys and property names are not references: `{ esc: esc }`, `.esc`.
  const referenced = new Set()
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?=[({.[])/g)) {
    // A call or a member access — the closest cheap proxy for "used as a value".
    referenced.add(m[1])
  }

  const missing = [...referenced]
    .filter((id) => !declared.has(id) && !GLOBALS.has(id) && !BINDABLE.has(id))
    .sort()
  if (missing.length > 0) {
    problems += 1
    console.log(`${name}: ${missing.join(', ')}`)
  }
}
console.log(problems === 0 ? '\nno unbindable references found' : `\n${problems} module(s) with unresolved references`)
