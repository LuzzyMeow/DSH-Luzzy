/* Format —— 通用格式化与转义。
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
 * 帧脚本由 new Function 编译成经典脚本，ESM 语法在那里直接是语法错误。 */
(function (LZ) {
  'use strict'

  /** Escape HTML. Every value from the host crosses this boundary. */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

  /** Token counts, abbreviated for axis and metric labels. */
function formatTokens(v) {
  if (!isFinite(v) || v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万'
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(Math.round(v))
}
function formatExact(v) { return isFinite(v) ? v.toLocaleString('en-US') : '0' }

  /** Axis ceiling on a fine ladder (1/1.25/1.5/2/2.5/3/4/5/6/8/10 …), not 1-2-5-10. */
function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / magnitude
  const steps = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  for (const step of steps) {
    if (n <= step) return step * magnitude
  }
  return 10 * magnitude
}
  /** Quantise a value into the 0..4 cell ladder used by the activity strip. */
function levelOf(v, max) {
  if (v <= 0) return 0
  if (max <= 0) return 1
  const r = v / max
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4
}

  /**
   * 目标正文：短句强调显示，有结构则给一个**查看器按钮**。
   *
   * 为什么要分档：`objective` 通常是**一句话**（那 `.focusBox` 正合用），但用户可以把整份
   * 方案贴进去 —— 实测几万字。`.focusBox` 是 `font-lg` 的强调块、没有 `pre-wrap`，装一份
   * 文档的结果是几百行被压成一个连续段落，`---`、`§`、列表全糊在一起。**原语用错了**。
   *
   * 而且**不在页面里展开**：展开等于在页面上再套一层滚动框 —— 两层滚动就是用户说的「断层」
   * （滚轮滚谁看指针在哪，内容底部还会被外层容器切断）。所以这里只出一个按钮，点开走
   * `LZ.App.openViewer`：脱离页面流、占一屏、内部只有一层滚动。
   *
   * **已退役（本轮）**：目标正文不再在任何卡片里露面，所以这个渲染器连同它那个按钮一起删了。
   * 它的唯一调用者是「总览」页，而总览页已被删除（它回答的五个问题目标中心逐条都在）。
   * 完整目标一个字都没丢 —— 它在「完整计划」视窗的第 1 节里（`renderGoalMarkdown` 原样输出
   * `runtimeGoal.objective`）。卡片抬头那一格现在放的是 Agent 写的「概览目标」。
   *
   * 因此**「长正文被压成一坨」这个缺陷类已经结构性消失了**：没有任何页面再把原始目标正文
   * 放进 `.focusBox`。守卫这一点的反证臂（`prove-overview-render.mjs` 的 A / B / C 三条）
   * 也随主体一起退役，换成了 `prove-console-shell.mjs` 守着新的结构。
   *
   * @param {string} objective
   * @returns {string}
   */
  function objectiveText(objective) {
    const text = typeof objective === 'string' ? objective : ''
    if (text === '') return '<div class="focusBox" data-empty="true">（没有目标正文）</div>'
    // 判据是**有没有结构**，不是有多长。
    //
    // 第一版只按字数（≤240 就进强调块），探针立刻抓出反例：一段 100 字、**带换行**的目标
    // 照样留在 `.focusBox` 里，而它没有 `pre-wrap` —— 于是 CSS 还是把换行折叠掉，`---` 和
    // 分节标题再次糊成一团。**长度是表象，换行才是那个会坏掉的东西**：一句 200 字的普通话
    // 确实该强调显示，而一份 100 字带结构的东西不该被压成一段。
    const multiline = text.indexOf('\n') !== -1
    if (!multiline && text.length <= 240) return '<div class="focusBox">' + esc(text) + '</div>'

    const breakAt = text.indexOf('\n')
    const head = (breakAt === -1 ? text.slice(0, 240) : text.slice(0, breakAt)).trim()
    return '<div class="focusBox">' + esc(head) + '</div>' +
      LZ.Card.btnBar([{
        label: '查看目标全文（' + text.length + ' 字）',
        variant: 'btnSmall',
        attrs: 'data-viewer="objective" data-viewer-title="目标全文"',
      }])
  }

  /** Series palette. Eight hues, then it cycles. */
const COLORS = ['#4c8dff','#38b26b','#c084fc','#f0a132','#ec5e41','#22b8cf','#8f7bf0','#7f8ea3']

  LZ.Format = {
    esc: esc,
    objectiveText: objectiveText,
    formatTokens: formatTokens,
    formatExact: formatExact,
    niceMax: niceMax,
    levelOf: levelOf,
    COLORS: COLORS,
  }
})(window.LZ = window.LZ || {})
