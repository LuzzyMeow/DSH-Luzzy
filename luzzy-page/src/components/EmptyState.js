/* EmptyState —— 统一空状态。
 *
 * 一条硬规则：**禁止空白页面。**
 *
 * 每一个「没有东西」都必须同时说清三件事：
 *   1. 什么没有（标题）
 *   2. 为什么 / 这意味着什么（正文）
 *   3. 能做什么（动作，可选）
 *
 * 只做到第 1 件就是把用户留在原地。更坏的一种是**把版本不一致说成「你没有数据」**——
 * 这个插件踩过：宿主半是旧版、响应结构对不上时，页面写着「今天还没有用量记录」，
 * 而真实情况是它根本没拿到那份数据。对用户的事实陈述是错的，比空白更糟。
 * 所以这里提供 blocked() 专门表达「读不到」，与 empty() 严格分开。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  /** 空状态的大图标：一个空托盘。中性色，不抢注意力。 */
  const ICON = '<svg class="emptyStateIcon" width="28" height="28" viewBox="0 0 28 28" fill="none" ' +
    'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' +
    '<path d="M3 16h6l1.6 3h6.8L19 16h6"/>' +
    '<path d="M5.4 5h17.2l2.4 11v5.4a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 21.4V16z"/>' +
    '</svg>'

  /**
   * 居中的空状态块。用于整张卡片或整个页面都没有内容时。
   *
   * @param {{title: string, body: string, action?: string}} spec
   */
  function empty(spec) {
    return '<div class="emptyState">' + ICON +
      '<div class="emptyStateTitle">' + esc(spec.title) + '</div>' +
      '<div class="emptyStateBody">' + esc(spec.body) + '</div>' +
      (spec.action === undefined ? '' : '<div class="emptyStateAction">' + spec.action + '</div>') +
      '</div>'
  }

  /**
   * 行内空状态：卡片内的一行提示，不做居中大块。
   *
   * @param {string} text
   */
  function line(text) {
    return '<p class="emptyLine">' + esc(text) + '</p>'
  }

  /**
   * 「读不到」——与「没有」严格分开。
   *
   * 用于宿主半没应答、路由报错、服务没挂载这类情况。它必须**点名是哪一半出了问题**，
   * 因为客户端半热重载、宿主半不重载，新客户端配旧宿主是每次改动后的常态。
   *
   * @param {{title: string, body: string, detail?: string, action?: string}} spec
   */
  function blocked(spec) {
    const detail = spec.detail === undefined
      ? ''
      : '<details class="statusDetail"><summary>诊断细节</summary><code>' + esc(spec.detail) + '</code></details>'
    return '<div class="emptyState">' + ICON +
      '<div class="emptyStateTitle">' + esc(spec.title) + '</div>' +
      '<div class="emptyStateBody">' + esc(spec.body) + '</div>' +
      (spec.action === undefined ? '' : '<div class="emptyStateAction">' + spec.action + '</div>') +
      detail +
      '</div>'
  }

  /**
   * 加载态。带一个已经用了多久的读数——冷启动要读完本机全部会话日志（约 20–30 秒），
   * 没有进度反馈时「卡住」和「在工作」长得一模一样。
   *
   * @param {string} text
   * @param {number} [elapsedSeconds]
   */
  function loading(text, elapsedSeconds) {
    return '<div class="status">' +
      '<span>' + esc(text) + '</span>' +
      (elapsedSeconds === undefined ? '' : '<span class="note" id="elapsed">已用时 ' + esc(String(elapsedSeconds)) + ' 秒</span>') +
      LZ.Card.skeleton('60%', '20px') +
      LZ.Card.skeleton('100%', '160px') +
      '</div>'
  }

  /**
   * 页面级状态块：一句话，可选的「重试」，可选的诊断细节。
   *
   * 从旧版原样搬来（它当时是一个帧内自由函数）。detail 参数的存在有原因：失败态曾经把原始
   * 异常插进句子本身（「用量统计失败 — Cannot read properties of undefined」），那句话对用户
   * 没有任何可行动的信息，还把栈形状的文本漏进界面。家规是每句话都要说下一步做什么；
   * 机器原文仍要能拿到以便报 bug，所以它放在折叠区里，而不是标题上。
   *
   * @param {string} message
   * @param {boolean} [retry] 是否给出重试按钮
   * @param {string} [detail] 诊断细节
   * @param {string} [retryId] 重试按钮的 id（同一页可能有多个状态块）
   */
  function statusBlock(message, retry, detail, retryId) {
    const detailHtml = detail
      ? '<details class="statusDetail"><summary>诊断细节</summary><code>' + esc(String(detail)) + '</code></details>'
      : ''
    return '<div class="status"><span>' + esc(message) + '</span>' +
      (retry === true ? '<button type="button" id="' + esc(retryId === undefined ? 'retry' : retryId) + '">重试</button>' : '') +
      detailHtml + '</div>'
  }

  LZ.EmptyState = {
    empty: empty,
    line: line,
    blocked: blocked,
    loading: loading,
    statusBlock: statusBlock,
    ICON: ICON,
  }
})(window.LZ = window.LZ || {})
