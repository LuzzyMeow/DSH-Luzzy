/* Card —— 卡片、分区标题、指标组、键值行、按钮条。
 *
 * 唯一的卡片生产者。曾经「卡片」在源码里有三种写法（手写 .card、goalSection、metricsCard），
 * 于是同一个东西在三处长得不一样、改一处忘两处。收敛到这里之后，样式只由 components.css
 * 的 .card 决定，这个文件只负责结构。
 *
 * 帧内模块约定：IIFE 挂到 window.LZ 命名空间，不用 import/export 语法——帧脚本由
 * `new Function` 编译成经典脚本，ESM 语法会直接语法错误。见 docs/frontend-v2-migration.md。
 */
(function (LZ) {
  'use strict'

  /** 转义 HTML。所有来自宿主的文本都要过它——那是信任边界。 */
  function esc(value) {
    if (value === null || value === undefined) return ''
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /**
   * 一张卡片。
   *
   * @param {{title?: string, sub?: string, count?: string, actions?: string,
   *          body: string, id?: string}} spec
   * @returns {string} HTML
   */
  function card(spec) {
    const head = spec.title === undefined && spec.count === undefined && spec.actions === undefined
      ? ''
      : '<div class="cardHead">' +
        (spec.title === undefined ? '' : '<h3>' + esc(spec.title) + '</h3>') +
        '<span class="spacer"></span>' +
        (spec.count === undefined ? '' : '<span class="segLabel">' + esc(spec.count) + '</span>') +
        (spec.actions === undefined ? '' : spec.actions) +
        '</div>'
    const sub = spec.sub === undefined ? '' : '<p class="cardSub">' + esc(spec.sub) + '</p>'
    // 正文裹一层 `.cardBody`：这一层是**滚动面**。卡片本体是等高的格子（高度由外层的网格给），
    // 抬头与副标题固定，只有正文滚 —— 所以一张「执行证据」卡片里有 37 条也撑不高它自己。
    return '<section class="card"' + (spec.id ? ' id="' + esc(spec.id) + '"' : '') + '>' +
      head + sub + '<div class="cardBody">' + spec.body + '</div></section>'
  }

  /**
   * 指标组：标签 + 数值。数值用等宽数字，跨卡片对得齐。
   *
   * @param {Array<{label: string, value: string}>} items
   */
  function metrics(items) {
    if (items.length === 0) return ''
    return '<div class="metrics">' + items.map(function (item) {
      return '<div class="metric">' +
        '<span class="metricLabel">' + esc(item.label) + '</span>' +
        '<span class="metricValue">' + (item.raw === true ? item.value : esc(item.value)) + '</span>' +
        '</div>'
    }).join('') + '</div>'
  }

  /**
   * 键值行：用于「Agent 信息」「系统状态」这类事实清单。
   *
   * @param {Array<{label: string, value: string, raw?: boolean}>} items
   */
  function kv(items) {
    if (items.length === 0) return ''
    return '<div class="kv">' + items.map(function (item) {
      return '<div class="kvItem">' +
        '<div class="kvLabel">' + esc(item.label) + '</div>' +
        '<div class="kvValue">' + (item.raw === true ? item.value : esc(item.value)) + '</div>' +
        '</div>'
    }).join('') + '</div>'
  }

  /**
   * 提示块。data-kind 决定左侧色条：info / ok / warn / error。
   *
   * @param {string} kind
   * @param {string} text 已经过 esc 或自建的安全 HTML
   * @param {boolean} [raw] true 表示 text 是可信 HTML（仅用于内部拼接）
   */
  function callout(kind, text, raw) {
    return '<div class="callout" data-kind="' + esc(kind) + '">' + (raw === true ? text : esc(text)) + '</div>'
  }

  /** 按钮条：左对齐的按钮组，中间可放 spacer 把后续项推到右边。 */
  function btnBar(items) {
    if (items.length === 0) return ''
    return '<div class="btnBar">' + items.map(function (item) {
      if (item.spacer === true) return '<span class="spacer"></span>'
      return '<button type="button" class="btn ' + (item.variant ? esc(item.variant) : 'btnSmall') + '"' +
        (item.id ? ' id="' + esc(item.id) + '"' : '') +
        (item.attrs ? ' ' + item.attrs : '') +
        (item.disabled === true ? ' disabled' : '') +
        (item.title ? ' title="' + esc(item.title) + '"' : '') +
        '>' + esc(item.label) + '</button>'
    }).join('') + '</div>'
  }

  /** 加载骨架：形状与最终内容接近，避免加载完成时布局跳动。 */
  function skeleton(width, height) {
    return '<div class="skeleton" style="width:' + esc(width) + ';height:' + esc(height) + '"></div>'
  }

  LZ.Card = {
    esc: esc,
    card: card,
    metrics: metrics,
    kv: kv,
    callout: callout,
    btnBar: btnBar,
    skeleton: skeleton,
  }
})(window.LZ = window.LZ || {})
