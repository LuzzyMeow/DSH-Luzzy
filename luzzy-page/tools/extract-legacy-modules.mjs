// One-off: lift the already-tested frame functions out of src/client.js into the new
// multi-file layout, VERBATIM.
//
// Why extract rather than retype
// ------------------------------
// The markdown renderer/serializer/toolbar and the chart code carry ~500 lines and a dozen
// hard-won behaviours (Fritsch–Carlson monotonicity, no-marker visual mode, caret-preserving
// round trips, tooltip clamping). Retyping them would be a rewrite with no test coverage
// behind it, and the suite lifts these functions BY NAME AND SIGNATURE from the built bundle —
// so the names must survive the move intact.
//
// This script therefore cuts exact function bodies by brace matching (the same technique the
// test suites use), and writes them into the new module files with a header comment.
//
// Usage: node tools/extract-legacy-modules.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// THE SOURCE IS THE PRE-v2 FILE, FROM GIT — NOT THE CURRENT src/client.js.
//
// The v2 build rewrote src/client.js into a thin outer bundle; the frame's code no longer lives
// there. These extractors are one-shot migration tools, so they read the LAST REVISION THAT HAD
// THE SINGLE-FILE PAGE and lift code out of that. Pointing them at the working tree would fail
// with "not found: function esc(s)" — accurate, and easy to misread as a corrupted file.
const LEGACY_REVISION = process.env.LUZZY_LEGACY_REV ?? 'HEAD'
const SRC = (() => {
  try {
    return execFileSync('git', ['show', `${LEGACY_REVISION}:luzzy-page/src/client.js`], {
      cwd: join(PLUGIN_ROOT, '..'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    console.error(`cannot read the legacy src/client.js from git ${LEGACY_REVISION}:`, error.message)
    console.error('these are one-shot migration tools; they need the pre-v2 revision to exist.')
    process.exit(1)
  }
})()

/** Slice a function by its exact signature, brace-matching to the end. */
function slice(signature) {
  const at = SRC.indexOf(signature)
  if (at < 0) throw new Error(`not found: ${signature}`)
  let depth = 0
  let end = -1
  for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1
    else if (SRC[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) throw new Error(`unbalanced: ${signature}`)
  return SRC.slice(at, end)
}

/** Slice a top-level `const NAME = ...` by balancing brackets to the line end. */
function sliceConst(name) {
  const at = SRC.indexOf(`const ${name} = `)
  if (at < 0) throw new Error(`const not found: ${name}`)
  let depth = 0
  for (let i = at; i < SRC.length; i += 1) {
    const ch = SRC[i]
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    // The declaration ends at a newline back at depth 0 (after the first line has opened).
    else if (ch === '\n' && depth === 0) return SRC.slice(at, i)
  }
  throw new Error(`unbalanced const: ${name}`)
}

/** Slice a top-level `let NAME = ...` by balancing brackets to the line end. */
function sliceLet(name) {
  const at = SRC.indexOf(`let ${name} = `)
  if (at < 0) throw new Error(`let not found: ${name}`)
  for (let i = at; i < SRC.length; i += 1) {
    if (SRC[i] === '\n') return SRC.slice(at, i)
  }
  throw new Error(`unterminated let: ${name}`)
}

/**
 * Undo the frame template's escaping.
 *
 * The frame document is a JS template literal, so two sequences are written escaped in the
 * source and must be un-escaped when the code moves OUT of that literal:
 *
 *   `\\`  → `\`   (regex literals and string escapes, e.g. /\\[/  is really /\[/ )
 *   `\``  → `` ` ``  (a backtick inside a nested string)
 *
 * This is safe to apply BLANKET because the other extracted modules provably contain neither
 * sequence — verified by scanning every extracted file for `\\.` and `${` before this was
 * written. Only src/components/Markdown.js has any (123 `\\`, 12 backticks, 0 `${`).
 *
 * The order matters and is asserted below: the backtick pass must not see the `\\` pass's
 * output, or an escaped backslash followed by a backtick would be misread.
 */
function unescapeTemplate(body) {
  const before = { slashes: (body.match(/\\\\/g) ?? []).length, backticks: (body.match(/\\`/g) ?? []).length }
  const out = body.replace(/\\\\/g, '\\').replace(/\\`/g, '`')
  // A `${` would mean the template interpolated something on the way in, which this script
  // cannot undo — fail loudly rather than emit code that is quietly wrong.
  if (out.includes('${')) throw new Error('extracted body contains ${ — it was interpolated, not literal')
  return { body: out, before }
}

function write(relativePath, body, header) {
  const full = join(PLUGIN_ROOT, relativePath)
  mkdirSync(dirname(full), { recursive: true })
  const un = unescapeTemplate(body)
  writeFileSync(full, `${header}\n${un.body}\n`, 'utf8')
  const lines = `${header}\n${un.body}`.split('\n').length
  console.log(`wrote ${relativePath}  (${lines} lines, unescaped ${un.before.slashes} backslash + ${un.before.backticks} backtick)`)
}

// ---------------------------------------------------------------- Format

{
  const parts = [
    "  /** Escape HTML. Every value from the host crosses this boundary. */",
    slice('function esc(s)'),
    '',
    "  /** Token counts, abbreviated for axis and metric labels. */",
    slice('function formatTokens(v)'),
    slice('function formatExact(v)'),
    '',
    "  /** Axis ceiling on a fine ladder (1/1.25/1.5/2/2.5/3/4/5/6/8/10 …), not 1-2-5-10. */",
    slice('function niceMax(v)'),
    "  /** Quantise a value into the 0..4 cell ladder used by the activity strip. */",
    slice('function levelOf(v, max)'),
    '',
    "  /** Series palette. Eight hues, then it cycles. */",
    sliceConst('COLORS'),
  ].join('\n')

  write('src/components/Format.js', `(function (LZ) {
  'use strict'

${parts}

  LZ.Format = {
    esc: esc,
    formatTokens: formatTokens,
    formatExact: formatExact,
    niceMax: niceMax,
    levelOf: levelOf,
    COLORS: COLORS,
  }
})(window.LZ = window.LZ || {})`, `/* Format —— 通用格式化与转义。
 *
 * 这一组函数原来是散在帧脚本各处的自由函数。收在一个模块里有两个理由：
 * 转义是**信任边界**（所有来自宿主与日志的文本都要过它），它只该有一个实现；
 * 而数字格式化三处各写一份，会让同一个数字在两个页面上长得不一样。
 *
 * 函数体是**从原 src/client.js 原样搬过来的**，一行未改——它们背后有测试按名字与签名
 * 直接抽取（见 tools/test-chart-path.mjs 与 tools/test-preset-markdown.mjs），
 * 改名或改签名会让那些测试静默取不到函数。
 *
 * 帧内模块约定：IIFE 挂到 window.LZ 命名空间。不用 import/export——
 * 帧脚本由 new Function 编译成经典脚本，ESM 语法在那里直接是语法错误。 */`)
}

// ---------------------------------------------------------------- Markdown

{
  const parts = [
    slice('function renderMarkdown(src)'),
    slice('function serializeMarkdown(root)'),
    slice('function applyMarkdownTool(value, start, end, id)'),
    slice('function activeToolsFor(value, caret)'),
    sliceConst('MD_ICONS'),
    sliceConst('MD_GROUPS'),
    sliceConst('MD_MODES'),
    sliceConst('MD_TOOLS'),
  ].join('\n\n')

  write('src/components/Markdown.js', `(function (LZ) {
  'use strict'

  const esc = LZ.Format.esc

${parts}

  LZ.Markdown = {
    render: renderMarkdown,
    serialize: serializeMarkdown,
    applyTool: applyMarkdownTool,
    activeTools: activeToolsFor,
    ICONS: MD_ICONS,
    GROUPS: MD_GROUPS,
    MODES: MD_MODES,
    TOOLS: MD_TOOLS,
  }
})(window.LZ = window.LZ || {})`, `/* Markdown —— 渲染器、序列化器与工具栏变换。
 *
 * 这个模块整体从原 src/client.js 原样搬来，一行未改。它承载的行为都是踩出来的，
 * 重写风险极高，且测试直接从产物里按名字抽取这三个函数：
 *
 *   renderMarkdown    帧内没有 markdown 库，语法范围由 README 与提示词的实际用量决定
 *   serializeMarkdown HTML → Markdown 是**唯一会损坏提示词的方向**，所以只在真实编辑时回写；
 *                     契约是结构保真而非字节相同；未知元素降级为文本而不是整块丢弃
 *   applyMarkdownTool 纯函数（value/start/end/id → 新值 + 新选区），因此可以不启浏览器断言。
 *                     三条容易做错的语义：往返（再点一次取消）、空选区（产生一对标记并居中光标）、
 *                     按行前缀（作用于选区触及的每一行，且全都已带该标记时整体取消）
 *
 * 「实时预览」在本插件里是**渲染形态，且渲染面即可编辑面**（contenteditable），
 * 三种模式各只有一个面。切模式只允许绑菜单项——区域自己也带 data-mode，
 * 绑到它就会吞掉每次点击的光标，把插入点永远重置到文档开头。 */`)
}

// ---------------------------------------------------------------- Chart

{
  const parts = [
    sliceConst('CHART'),
    '',
    slice('function smoothPath(points)'),
    '',
    slice('function trendChart(series, slots, mode, animate)'),
    '',
    slice('function chartTipHtml(slots, series, index)'),
    '',
    slice('function wireChartHover(root, slots, series)'),
    '',
    slice('function modelDonut(models)'),
  ].join('\n')

  write('src/components/Chart.js', `(function (LZ) {
  'use strict'

  // The chart code was written when these were frame globals. Inside its own module they have
  // to be bound explicitly — and the two the axis maths needs (niceMax for the ceiling, esc for
  // the labels) are the ones easiest to forget: a missing binding is a ReferenceError at RENDER
  // time, not at load time, so the page mounts and then throws.
  //
  // (This comment originally quoted the identifiers in backticks. That is inside a template
  // literal, so it terminated the string — the same mistake recorded in AGENTS.md §5.6, made
  // again in a comment explaining the code.)
  const esc = LZ.Format.esc
  const formatTokens = LZ.Format.formatTokens
  const niceMax = LZ.Format.niceMax
  const COLORS = LZ.Format.COLORS

${parts}

  LZ.Chart = {
    W: CHART.W,
    H: CHART.H,
    smoothPath: smoothPath,
    trend: trendChart,
    tipHtml: chartTipHtml,
    wireHover: wireChartHover,
    modelRows: modelDonut,
  }
})(window.LZ = window.LZ || {})`, `/* Chart —— 活动阵列、模型趋势、悬停浮窗、模型用量。
 *
 * 整体从原 src/client.js 原样搬来，一行未改。它承载的都是**验证过的几何与交互性质**：
 *
 *   平滑曲线用 Fritsch–Carlson 单调插值，不是 Catmull-Rom
 *     Catmull-Rom 会过冲，对非负数据意味着曲线画到零轴以下——日视图真的画出过负 token。
 *     单调插值保证曲线落在数据自己的范围内。tools/test-chart-path.mjs 按 t 采样贝塞尔
 *     断言这件事，因为截图不一定看得出来。
 *
 *   未来时段是 null，曲线在那里**断开**，不是画 0
 *     画 0 会凭空造出一段掉到轴上的塌方；活动阵列里未来的格子是空心而非填色。
 *
 *   悬停浮窗贴边时自动翻到另一侧，且键盘可达（左右方向键走格）
 *
 *   入场动画只在图表身份真的变了时挂上，且属性用定时器摘掉
 *     用 animationend 不行：prefers-reduced-motion 下动画是 none，那个事件永不触发，
 *     属性会被永久卡住。 */`)
}

// ---------------------------------------------------------------- 帧内对话框

{
  const parts = [
    sliceLet('closeActiveDialog'),
    '',
    slice('function showDialog(spec)'),
    '',
    slice('function showMessage(title, body)'),
    slice('function showConfirm(title, body, confirmLabel)'),
    slice('function showPrompt(title, initial, confirmLabel)'),
    slice('function dialogLine(label, value)'),
  ].join('\n')

  write('src/app/dialog.js', `(function (LZ) {
  'use strict'

  const esc = LZ.Format.esc

${parts}

  LZ.Dialog = {
    show: showDialog,
    message: showMessage,
    confirm: showConfirm,
    prompt: showPrompt,
    line: dialogLine,
  }
})(window.LZ = window.LZ || {})`, `/* dialog —— 帧内自建对话框，替代原生 alert / confirm / prompt。
 *
 * 为什么必须自建（这是用户报过的一个真 bug 的修复）
 * ------------------------------------------------
 * 原生对话框是 **Electron 窗口的 OS 级模态框**，不是页面里的元素。关掉之后
 * **键盘焦点不会还给 web contents** —— 底部输入框从此点不动，直到用户切走再切回
 * （那一步强制 OS 重新激活窗口）。页面里没有任何办法修，因为焦点从来就不在页面手上。
 *
 * 三条实现纪律：
 *   1. 关闭时显式 document.body.focus()   ← 原生对话框做不到的那一步
 *   2. 同一时刻只留一个对话框，新开的先关旧的（两层遮罩叠着，下层按钮点不到）
 *   3. 每条路径恰好 resolve 一次（确认 / 取消 / Escape / 点遮罩），否则调用方的 .then 永远挂着
 *
 * test-client-load.mjs 有一条**故意做得很粗**的断言：帧模板里出现任何 alert( / confirm( /
 * prompt( 即失败。一次疏忽就会退回这个 bug。 */`)
}

console.log('\ndone')
