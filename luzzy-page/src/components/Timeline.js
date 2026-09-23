/* Timeline —— 时间线。用于「最近动态」「生命周期」「变更记录」。
 *
 * 用 <ol> 而不是一堆 div：它本来就是有序的，屏幕阅读器会念出序号，
 * 而时间线恰恰是「顺序」本身就是信息的地方。
 *
 * 节点形状自己说了一遍状态：已完成填实、未到中空。加上 data-state 的颜色，
 * 于是「颜色 + 形状 + 文字」三者齐备——只看形状也能读。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc
  const toneOf = LZ.StatusBadge.toneOf

  /**
   * 一条时间线。
   *
   * @param {Array<{time?: string, text: string, sub?: string, state?: string,
   *               done?: boolean, raw?: boolean}>} items
   * @param {{emptyText?: string}} [options]
   */
  function timeline(items, options) {
    if (items.length === 0) {
      return LZ.EmptyState.line((options && options.emptyText) || '暂无记录')
    }
    return '<ol class="timeline">' + items.map(function (item) {
      const tone = item.state === undefined ? 'idle' : toneOf(item.state)
      const done = item.done === undefined ? tone === 'success' : item.done === true
      return '<li class="timelineItem" data-state="' + esc(tone) + '" data-done="' + String(done) + '">' +
        '<span class="timelineDot" aria-hidden="true"></span>' +
        '<div class="timelineBody">' +
        '<div class="timelineHead">' +
        (item.time === undefined ? '' : '<span class="timelineTime">' + esc(item.time) + '</span>') +
        '<span class="timelineText">' + (item.raw === true ? item.text : esc(item.text)) + '</span>' +
        '</div>' +
        (item.sub === undefined ? '' : '<div class="timelineSub">' + esc(item.sub) + '</div>') +
        '</div>' +
        '</li>'
    }).join('') + '</ol>'
  }

  /**
   * 生命周期条：横向的一串阶段，当前那一档高亮。
   *
   * 与 timeline 分开，是因为它们的读法不同：timeline 是「什么时候发生了什么」（纵向、带时间），
   * 生命周期是「走到哪一步了」（横向、无时间、有顺序）。用同一个部件画两种读法会两样都别扭。
   *
   * @param {Array<{label: string, done: boolean, active?: boolean}>} steps
   */
  function lifecycle(steps) {
    if (steps.length === 0) return ''
    return '<ol class="timeline">' + steps.map(function (step) {
      const state = step.active === true ? 'running' : step.done === true ? 'success' : 'idle'
      return '<li class="timelineItem" data-state="' + state + '" data-done="' + String(step.done === true) + '">' +
        '<span class="timelineDot" aria-hidden="true"></span>' +
        '<div class="timelineBody"><div class="timelineHead">' +
        '<span class="timelineText">' + esc(step.label) + '</span>' +
        (step.active === true ? '<span class="timelineTime">进行中</span>' : '') +
        '</div></div>' +
        '</li>'
    }).join('') + '</ol>'
  }

  LZ.Timeline = { timeline: timeline, lifecycle: lifecycle }
})(window.LZ = window.LZ || {})
