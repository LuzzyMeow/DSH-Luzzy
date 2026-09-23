/**
 * One canonical way for tools to obtain the frame document.
 *
 * WHY THIS EXISTS
 *
 * Every gate and several suites need the frame HTML: to parse its script, to lift a function
 * out of it by name, to render it standalone. They used to get it by brace-matching
 * `buildFrameDocument` out of the bundle and un-escaping the template literal it returned.
 *
 * Two things made that fragile, and both bit during the v2 refactor:
 *
 *   * The un-escaping (`.replace(/\\n/g, '\n')`) rewrites backslashes INSIDE regex literals,
 *     so a correct function can come out as invalid JavaScript. That hack is now gone: the
 *     frame is embedded as a JSON string literal, and this module decodes it properly.
 *   * Lifting only `buildFrameDocument` misses the sibling constants it closes over
 *     (`FRAME_JSON`, `FRAME_FONTS_MARKER`), which produced `ReferenceError: FRAME_JSON is not
 *     defined` in two tools.
 *
 * So the extraction lives here, once, and every tool imports it. A tool that reimplements
 * this will drift from the others.
 *
 * HOW IT WORKS
 *
 * The bundle is evaluated in a sandbox with just enough shims to reach module scope, then the
 * real `buildFrameDocument` is called — so what tools see is the exact document the browser
 * receives, produced by the exact shipped code. No reconstruction, no un-escaping.
 *
 * @module tools/frame-source
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Read the frame document straight from the built bundle.
 *
 * WHY THIS EXISTS
 *
 * Five tools used to read a CACHED copy at `<tmp>/luzzy-frame-preview.html`, which only
 * `render-frame-preview.mjs` ever rewrites. Rebuild the client and every screenshot, animation
 * check and stale-payload probe kept silently reading the PREVIOUS build — so a shot could show
 * markup that no longer existed, and the evidence looked fresh (new mtime, new hash) while being
 * stale. That is the same class as AGENTS.md §5.26 (`lib/client.js` is a build artifact): a
 * derived file with no freshness link gets trusted long after it stopped being true.
 *
 * The bundle is the single source, and `loadFrameBuilder()` already reads it through the real
 * component. Going through it means a rebuild is picked up automatically — there is no second
 * copy to forget.
 *
 * @returns {string} the frame document the browser receives.
 */
export function readFrameHtml() {
  return loadFrameBuilder().srcDoc
}

/**
 * Load the built bundle and return its frame builder plus the inlined font CSS.
 *
 * @returns {{buildFrameDocument: (fontCss: string) => string, fontCss: string, frameLength: number}}
 */
export function loadFrameBuilder() {
  const bundlePath = join(PLUGIN_ROOT, 'lib', 'client.js')
  const source = readFileSync(bundlePath, 'utf8')

  let entry = null
  const sandboxWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: {
      load(candidate) {
        entry = candidate
      },
    },
  }
  const sandboxDocument = {
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { getAttribute: () => null, classList: { contains: () => false } },
    createElement: () => ({ dataset: {} }),
    head: { appendChild: () => {} },
  }

  // `react/jsx-runtime` is the only module the bundle requires, and it is required at factory
  // time — a stub is enough, since nothing here renders the component.
  const require = createRequire(import.meta.url)
  const jsxRuntime = (() => {
    try {
      const appRoot = process.env.DSH_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app'
      return require(join(appRoot, 'node_modules/react/jsx-runtime'))
    } catch {
      // The suites that render the component load React for real; the gates only need the
      // frame, so a minimal shape is acceptable here and is never used by them.
      return { jsx: () => ({ type: 'div', props: {} }), jsxs: () => ({ type: 'div', props: {} }) }
    }
  })()

  new Function('window', 'document', source)(sandboxWindow, sandboxDocument)
  if (entry === null) throw new Error('the bundle never called window.__ModuleLoader__.load')

  const mod = entry.factory((spec) => {
    if (spec === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`frame-source: unexpected require("${spec}")`)
  })

  if (typeof mod.apply !== 'function') throw new Error('the bundle exports no apply()')

  // `buildFrameDocument` is not exported, but it IS the function that produced the srcDoc.
  // Reaching it means applying the plugin to a capture context and calling the component with
  // the host's own prop shape, then reading srcDoc off the returned element — the same thing
  // the browser does. This is deliberately end-to-end: it cannot disagree with production.
  const captured = []
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        captured.push({ options, component })
        return () => {}
      },
    },
  })

  const component = captured[0]?.component
  if (component === undefined) throw new Error('the plugin registered no conversation.view entry')

  const props = { viewRequest: null, openView: () => {}, completeViewRequest: () => {} }
  const element = component(props)
  const srcDoc = element?.props?.srcDoc
  if (typeof srcDoc !== 'string' || !srcDoc.startsWith('<!doctype html>')) {
    throw new Error('the component returned no srcDoc document')
  }

  const fontCss = (srcDoc.match(/@font-face\s*\{[\s\S]*?\}/g) ?? []).join('\n')

  return {
    buildFrameDocument: (css) => (css === undefined ? srcDoc : srcDoc.replace(fontCss, css)),
    fontCss,
    frameLength: srcDoc.length,
    srcDoc,
  }
}

/**
 * The pattern that finds the frame's script block, in ONE place.
 *
 * It used to be copy-pasted into eight tools. That is how a pattern drifts: the pragma gained a
 * semicolon (see below) and every copy would have silently stopped matching — returning null,
 * or worse, an empty string that a length check accepts.
 *
 * The `;` after the pragma is REQUIRED, not cosmetic. `'use strict'` with no semicolon followed
 * by a module's `(function (LZ) {` is parsed as CALLING A STRING, because an expression starting
 * with `(` continues the previous line:
 *
 *     TypeError: "use strict" is not a function
 *
 * It is VALID SYNTAX, so no parser or `new Function` reports it, and the frame was blank in a
 * real browser until this was found. `\s*` is what lets this pattern match whether or not the
 * semicolon is present, so the tools keep working either way.
 */
const SCRIPT_BLOCK = /<script>\s*\n'use strict';?([\s\S]*?)<\/script>/

/**
 * The frame's script block, without the surrounding `<script>` tags.
 *
 * Located by its `'use strict'` pragma rather than by position, because a frame may carry more
 * than one script (a test shim, for instance).
 *
 * @param {string} html
 * @returns {string|null}
 */
export function extractFrameScript(html) {
  const match = html.match(SCRIPT_BLOCK)
  return match === null ? null : `'use strict';${match[1]}`
}

/**
 * Compile the frame's script.
 *
 * The frame is a STRING in the bundle, so the outer bundle parsing clean says nothing about
 * it. A syntax error in here survives the build and shows up only as a blank page — and the
 * frame's own error handler cannot report it, because the handler is defined in the same
 * script that failed to parse.
 *
 * @param {string} html
 * @returns {{ok: true, lines: number} | {ok: false, error: string, line?: number, context: string}}
 */
export function compileFrameScript(html) {
  const code = extractFrameScript(html)
  if (code === null) return { ok: false, error: 'no use-strict script block found', context: '' }

  const lines = code.split('\n')
  try {
    // Compiling without executing: running it would fail on `document` before reaching a real
    // error, which is not what a parse check wants.
    new Function(code)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const match = /:(\d+):(\d+)?/.exec(detail)
    const line = match === null ? undefined : Number(match[1])
    let context = ''
    if (line !== undefined) {
      for (let index = Math.max(0, line - 4); index < Math.min(lines.length, line + 3); index += 1) {
        const marker = index + 1 === line ? '>>' : '  '
        context += `\n${marker} ${String(index + 1).padStart(5)}: ${lines[index]}`
      }
    }
    return { ok: false, error: detail, line, context }
  }
  return { ok: true, lines: lines.length }
}

/**
 * Lift a named function out of the frame's script by brace matching.
 *
 * @param {string} html frame document
 * @param {string} name bare identifier to return
 * @param {string} signature text used to FIND the function (never pasted into the return)
 * @param {Record<string, unknown>} [bindings] names a lifted function needs from its neighbours
 */
export function liftFromFrame(html, name, signature, bindings) {
  const script = extractFrameScript(html)
  if (script === null) return null
  const at = script.indexOf(signature)
  if (at < 0) return null
  let depth = 0
  let end = -1
  for (let i = script.indexOf('{', at); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1
    else if (script[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) return null
  const fnSource = script.slice(at, end)
  if (bindings === undefined) return new Function(`${fnSource}; return ${name}`)()
  const names = Object.keys(bindings)
  const values = names.map((key) => bindings[key])
  return new Function(...names, `${fnSource}; return ${name}`)(...values)
}

export { PLUGIN_ROOT, SCRIPT_BLOCK }
