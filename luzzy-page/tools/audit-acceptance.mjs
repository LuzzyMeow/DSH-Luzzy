/**
 * Acceptance audit: check the claims the delivery rests on, from the shipped artifact.
 *
 * Each check here corresponds to one line of the brief that a structural test elsewhere does NOT
 * cover — "no English UI copy", "no invented data", "the design tokens are the ones from the
 * reference system". They are the kind of claim that is easy to assert in a report and never
 * verify, so they are checked here against the built frame.
 *
 * Usage: node tools/audit-acceptance.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadFrameBuilder, PLUGIN_ROOT } from './frame-source.mjs'

const { srcDoc } = loadFrameBuilder()

const failures = []
const notes = []
const check = (label, ok, detail = '') => {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

/** The frame's script, with comments removed, so prose is not mistaken for code. */
const code = srcDoc
  .replace(/<style>[\s\S]*?<\/style>/g, '')
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ---------------------------------------------------------------- 中文 UI 文案

// Every user-visible string. Extracted from the ROUTER's tab table — a bare `label: '…'` also
// matches the 19 markdown-toolbar entries, which are labels but not tabs.
const routerTable = srcDoc.slice(srcDoc.indexOf('const TABS = ['), srcDoc.indexOf('const TABS = [') + 1200)
const tabs = [...routerTable.matchAll(/id: '(\w+)', label: '([^']+)'/g)].map((m) => m[2])
check('all tab labels are Chinese', tabs.every((label) => /[\u4e00-\u9fff]/.test(label)), tabs.join(', '))

// The tab set is the delivered one — asserted as the CURRENT set, not the set from three redesigns
// ago. This read '总览,目标中心,执行状态,Agent 配置,系统信息,预设,插件说明' and had been failing
// for a while before this pass: 总览 was removed by an earlier request and the two folded sections
// (执行状态 / Agent 配置) stopped being tabs when they were merged into 目标中心.
//
// The property worth guarding is that the tab set is EXACTLY the declared list — no orphan tab
// left rendering dead content, no tab silently dropped. Keeping the expected value beside the
// router is what makes drift visible; freezing it forever is what makes the check useless.
const EXPECTED_TABS = ['目标中心', '系统信息', '预设', '插件说明']
check('the tab set is the delivered one', tabs.join(',') === EXPECTED_TABS.join(','),
  `${tabs.join(',')} (expected ${EXPECTED_TABS.join(',')})`)
// …and every declared tab must have a renderer, or it is a tab that opens nothing.
const orphanTabs = tabs.filter((label) => {
  const id = [...routerTable.matchAll(/id: '(\w+)', label: '([^']+)'/g)].find((m) => m[2] === label)?.[1]
  return id !== undefined && !new RegExp(`LZ\\.[A-Za-z]+\\.render\\(`).test(srcDoc.slice(srcDoc.indexOf(`id: '${id}'`), srcDoc.indexOf(`id: '${id}'`) + 200))
})
check('every tab has a renderer', orphanTabs.length === 0, orphanTabs.join(', '))
// The toolbar labels are user-visible too, and must also be Chinese.
const toolbarLabels = [...srcDoc.matchAll(/label: '([^']+)', icon:/g)].map((m) => m[1])
check(
  'the markdown toolbar labels are Chinese',
  toolbarLabels.length > 0 && toolbarLabels.every((label) => /[\u4e00-\u9fff]/.test(label)),
  toolbarLabels.join(','),
)

// Sentence-shaped Latin that WOULD be UI copy. An allowlist entry is a decision, so each is
// written down with its reason. Class-name concatenations ('btn btnPrimary') and DOM exception
// messages ('The operation was aborted.') are not copy — they are code and platform text, and
// the second is compared against, never displayed.
const NOT_USER_COPY = [
  /^(btn|btnPrimary|btnSmall|btnDanger|btnText)\b/,      // button class lists
  /^The operation was aborted\.?$/,                       // the DOMException message compared against
  /^[a-z]+(?: [a-z]+)*$/,                                 // lowercase words: internal keys, not sentences
]

// The single-quote-to-single-quote match must not CROSS a quote boundary.
//
// The pattern used to be /'([A-Za-z][A-Za-z ,.'-]{18,})'/g, and its character class contains both
// the single quote and the comma — so a match could OPEN on one string literal and CLOSE on a later
// one, without ever having to close on the quote it opened. Every hit it produced was of that shape:
//
//     ["slots', 'locale', 'sessions', 'workspaces', 'agents"]
//     ["Inter Variable', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB"]
//
// Those are a service-name array and the font stack — code and a CSS value, not copy. The check was
// therefore red for reasons no user could ever see, while a REAL sentence would have been
// indistinguishable from them.
//
// The fix is to exclude the quote from the body of the match, so it must run from an opening quote
// to the NEXT one. It stays deliberately loose about what a sentence is — that judgement is the
// allowlist's job — but it no longer invents sentences out of adjacent string literals.
const latinSentences = [...code.matchAll(/'([A-Za-z][A-Za-z ,.-]{18,})'/g)]
  .map((m) => m[1].trim())
  .filter((text) => text.split(/\s+/).length >= 3)
  .filter((text) => !NOT_USER_COPY.some((pattern) => pattern.test(text)))
check(
  'no English sentences in user-visible copy',
  latinSentences.length === 0,
  latinSentences.slice(0, 3).join(' | '),
)

// ---------------------------------------------------------------- 无假数据

// Numbers that would be invented rather than derived. The pattern is a percentage that is a
// LITERAL in rendered markup — `skeleton('60%', '20px')` is a width, and `toFixed(1) + '%'` is a
// computed rate, so the check looks for a percentage in a TEXT position instead.
const suspicious = []
for (const match of code.matchAll(/['"](\d{1,3})%['"]/g)) {
  const value = Number(match[1])
  const around = code.slice(Math.max(0, match.index - 70), match.index + 40)
  // A skeleton width, a CSS length, or a computed rate is not a statistic.
  if (/skeleton|toFixed|width|height|share|rate|left|top|max-width/i.test(around)) continue
  // A percentage inside a sentence is a claim about the world.
  if (/[\u4e00-\u9fff]/.test(around)) suspicious.push(`${value}% in: ${around.trim().slice(-40)}`)
}
check('no hardcoded statistics in the UI code', suspicious.length === 0, suspicious.slice(0, 3).join(' | '))

// Fake logos, fake screenshots, fake dashboards: none of these should exist as assets.
const assetFiles = readdirSync(join(PLUGIN_ROOT, 'src'), { recursive: true })
  .filter((name) => /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(String(name)))
check('no image assets are bundled into the frame', assetFiles.length === 0, assetFiles.join(', '))
check('the frame makes no external request', !/url\((?!data:)/.test(srcDoc))
// TODO markers, and lorem placeholders. `todo_`/`update_goal` are TOOL NAMES inside a regex —
// matching them as a code smell reported the tool catalogue as unfinished work.
const todoHits = [...code.matchAll(/\bTODO\b|\bFIXME\b|lorem ipsum|占位符待填/gi)]
  .filter((match) => {
    const around = code.slice(Math.max(0, match.index - 30), match.index + 20)
    return !/goal_|update_goal|get_goal|create_goal|todo\//i.test(around)
  })
check('no placeholder text or TODO markers', todoHits.length === 0, todoHits.slice(0, 3).map((m) => m[0]).join(', '))

// ---------------------------------------------------------------- 设计系统

const tokens = readFileSync(join(PLUGIN_ROOT, 'src', 'styles', 'tokens.css'), 'utf8')

// The reference system's semantic token NAMES, not its values (DESIGN.md is explicit that
// components must read tokens by name — the values are the user's to theme).
const REQUIRED_TOKENS = [
  'colorText', 'colorTextSecondary', 'colorTextTertiary', 'colorBgLayout', 'colorBgContainer',
  'colorBorderSecondary', 'colorSuccess', 'colorWarning', 'colorError', 'colorInfo',
]
// Mapped to the --lz-* names this frame uses for them.
const TOKEN_MAP = {
  colorText: '--lz-text:', colorTextSecondary: '--lz-text-secondary:',
  colorTextTertiary: '--lz-text-tertiary:', colorBgLayout: '--lz-bg-layout:',
  colorBgContainer: '--lz-bg-container:', colorBorderSecondary: '--lz-border-secondary:',
  colorSuccess: '--lz-state-success:', colorWarning: '--lz-state-waiting:',
  colorError: '--lz-state-failed:', colorInfo: '--lz-state-running:',
}
const missingTokens = REQUIRED_TOKENS.filter((name) => !tokens.includes(TOKEN_MAP[name]))
check('the design tokens cover the reference system\'s semantics', missingTokens.length === 0, missingTokens.join(', '))

check('both themes are defined', tokens.includes(":root[data-theme='dark']"))
check('the DSH token mirror is present', tokens.includes('--dsw-alias-label-primary:'))

// Six states, as required.
for (const state of ['running', 'success', 'failed', 'waiting', 'blocked', 'idle']) {
  check(`state token: ${state}`, tokens.includes(`--lz-state-${state}:`))
}

// Spacing is a 4px ladder, and the only off-ladder values are the documented exceptions.
const spacings = [...tokens.matchAll(/--lz-space-[a-z]+:\s*(\d+)px/g)].map((m) => Number(m[1]))
check('spacing is the 4px ladder', spacings.every((value) => value % 4 === 0), spacings.join(', '))
check('spacing covers the six required steps', [4, 8, 12, 16, 24, 32].every((step) => spacings.includes(step)), spacings.join(', '))

// Type scale: the six steps the reference actually ships, and nothing between them.
//
// This used to be the frozen list [12, 14, 16, 20, 24] — the OLD scale. When the console moved to
// the reference's own scale, the values changed and this went red while the design was correct: a
// hardcoded inventory is not a property, it is a snapshot of one Tuesday.
//
// The property that DOES matter, and that the old list was standing in for, is that the steps are
// DISTINCT and ORDERED. A duplicated step is a real defect: `--lz-font-xs: 13px` next to
// `--lz-font-sm: 13px` makes "which one should this be" an arbitrary choice, and I shipped exactly
// that in the first pass. So the assertion is uniqueness + ascending order, plus the exact set the
// reference defines — read from ITS bundle, not invented.
const typeSizes = [...tokens.matchAll(/--lz-font-[a-z0-9]+:\s*(\d+)px/g)].map((m) => Number(m[1]))
const REFERENCE_SCALE = [13, 14, 16, 18, 24, 30]
check(
  'the type scale is the reference\'s own six steps',
  typeSizes.slice().sort((a, b) => a - b).join(',') === REFERENCE_SCALE.join(','),
  `${typeSizes.join(', ')} (expected ${REFERENCE_SCALE.join(', ')})`,
)
check(
  'and every step is distinct — no two tokens sharing a size',
  new Set(typeSizes).size === typeSizes.length,
  typeSizes.join(', '),
)

// Radius: 4/6/8/12/16, plus the fully-round pill (999) that DESIGN.md reserves for pills, avatars
// and circular icon buttons. Two scales, both intentional.
//
// Same lesson as the type scale: this was the frozen list [4, 6, 8, 12, 999] and went red when the
// card radius moved to the reference's 16px `rounded-2xl` step. 16 is not drift — it is the step
// the reference uses for exactly this surface.
const radii = [...tokens.matchAll(/--lz-radius[a-z-]*:\s*(\d+)px/g)].map((m) => Number(m[1]))
check(
  'the radius scale is the documented set',
  radii.every((value) => [4, 6, 8, 12, 16, 999].includes(value)),
  radii.join(', '),
)
check(
  'and every radius step is distinct',
  new Set(radii).size === radii.length,
  radii.join(', '),
)
check('the fully-round radius is reserved for pills', tokens.includes('--lz-radius-pill: 999px'))

// No component may define its own values — everything reads a token.
//
// A `var(--token, #fallback)` is NOT a hardcoded colour: the fallback only applies if the token
// is missing, and the token IS defined in tokens.css. Getting this check right took two tries:
// the first looked for `var(` in the text BEFORE the match, but by then the window has already
// passed the closing paren, so it flagged 40-odd correct declarations. The reliable test is to
// scan backward for an UNCLOSED `var(` — i.e. count parens between the two.
const stylesheets = ['layout.css', 'components.css']
const hardcoded = []
for (const name of stylesheets) {
  const css = readFileSync(join(PLUGIN_ROOT, 'src', 'styles', name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const before = css.slice(Math.max(0, match.index - 120), match.index)
    if (/color-mix|srgb/.test(before)) continue
    // Walk back to the nearest `var(` and check whether its paren is still open at this point.
    const open = before.lastIndexOf('var(')
    if (open >= 0) {
      const tail = before.slice(open + 4)
      let depth = 1
      for (const ch of tail) {
        if (ch === '(') depth += 1
        else if (ch === ')') depth -= 1
      }
      if (depth > 0) continue // inside an unclosed var() → a fallback, not a value
    }
    hardcoded.push(`${name}: ${match[0]} in ${before.trim().slice(-34)}`)
  }
}
check('no component hardcodes a colour outside a token fallback', hardcoded.length === 0, hardcoded.slice(0, 5).join(' | '))

// ---------------------------------------------------------------- 状态可读性

// "Don't signal state with color alone" — every badge must carry a glyph and a word.
const badgeSource = readFileSync(join(PLUGIN_ROOT, 'src', 'components', 'StatusBadge.js'), 'utf8')
check('badges carry an inline glyph', badgeSource.includes('<svg') && badgeSource.includes('aria-hidden="true"'))
check('badges carry a word', /function badge\(state, label/.test(badgeSource))
check('the status dictionary is in the component, not a page', badgeSource.includes('const STATUS = {'))
check('unknown statuses are shown, not swallowed', badgeSource.includes('String(status'))

// ---------------------------------------------------------------- 禁止事项

// "Do not modify DSH Core" — verified from git, not asserted. Nothing outside this plugin's own
// directory may have been touched by this work.
{
  const { execFileSync } = await import('node:child_process')
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: join(PLUGIN_ROOT, '..'), encoding: 'utf8' })
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '')
  const outside = changed.filter((path) =>
    !path.startsWith('luzzy-page/') && !path.startsWith('docs/') && path !== 'docs')
  check('nothing outside this plugin and docs/ was modified', outside.length === 0, outside.join(', '))
}

// "Do not remove the iframe isolation" — the architecture is still srcDoc in an iframe.
check('the frame is still a self-contained srcDoc document',
  srcDoc.startsWith('<!doctype html>') && srcDoc.trimEnd().endsWith('</html>'))
check('the outer component still renders exactly one iframe',
  readFileSync(join(PLUGIN_ROOT, 'src', 'client.js'), 'utf8').includes("jsx('iframe'"))

// "Do not introduce a large UI framework" — the frame is vanilla JS.
check('no UI framework is bundled into the frame', !/\breact\b|\bvue\b|svelte|angular|jquery/i.test(code))

// "Do not change the backend Goal data structure" — the goal module's field names are untouched.
{
  const { execFileSync } = await import('node:child_process')
  const diff = execFileSync('git', ['diff', '--stat', '--', 'luzzy-page/lib/goal-domain.mjs'], {
    cwd: join(PLUGIN_ROOT, '..'), encoding: 'utf8',
  })
  check('goal-domain.mjs is unchanged (the Goal data structure)', diff.trim() === '', diff.trim())
  const storeDiff = execFileSync('git', ['diff', '--stat', '--', 'luzzy-page/lib/goal-store.mjs'], {
    cwd: join(PLUGIN_ROOT, '..'), encoding: 'utf8',
  })
  check('goal-store.mjs is unchanged', storeDiff.trim() === '', storeDiff.trim())
  const routesDiff = execFileSync('git', ['diff', '--stat', '--', 'luzzy-page/lib/goal-routes.mjs'], {
    cwd: join(PLUGIN_ROOT, '..'), encoding: 'utf8',
  })
  check('goal-routes.mjs is unchanged (the existing route contract)', routesDiff.trim() === '', routesDiff.trim())
}

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} check(s)`)
  process.exit(1)
}
console.log(`PASS — ${notes.length} acceptance checks`)
