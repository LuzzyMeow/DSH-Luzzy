/* Progress —— 计数、比例条、指标进度。
 *
 * 为什么默认是**计数**而不是百分比
 * ---------------------------------
 * "4 / 6 已验证" 告诉你还差什么；"67%" 什么都不告诉你。一个百分比会对一个谁也
 * 无法测量的东西给出精确感。所以 tally 是默认形态，bar 只在有明确分母且读者需要
 * 「还剩多少」的直觉时使用。
 *
 * 进度值一律来自视图模型，这个文件不做任何统计——统计属于 services/。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  /**
   * 计数形态：`4 / 6`，等宽数字，跨卡片对得齐。
   *
   * @param {number} done
   * @param {number} total
   */
  function tally(done, total) {
    return '<span style="font-variant-numeric:tabular-nums">' + esc(String(done)) + ' / ' + esc(String(total)) + '</span>'
  }

  /**
   * 带比例条的进度。分母为 0 时不画条——0 / 0 画成空条会读成「一个都没做」，
   * 而实际含义是「还没有定义要做几件」。
   *
   * @param {{label: string, done: number, total: number, tone?: string, unit?: string}} spec
   */
  function bar(spec) {
    const total = Number(spec.total)
    const done = Number(spec.done)
    if (!isFinite(total) || total <= 0) {
      return '<div class="progress">' +
        '<div class="progressHead">' +
        '<span class="progressLabel">' + esc(spec.label) + '</span>' +
        '<span class="progressCount">—</span>' +
        '</div>' +
        '</div>'
    }
    const pct = Math.max(0, Math.min(100, (done / total) * 100))
    return '<div class="progress"' + (spec.tone ? ' data-tone="' + esc(spec.tone) + '"' : '') + '>' +
      '<div class="progressHead">' +
      '<span class="progressLabel">' + esc(spec.label) + '</span>' +
      '<span class="progressCount">' + esc(String(done)) + ' / ' + esc(String(total)) +
      (spec.unit ? ' ' + esc(spec.unit) : '') + '</span>' +
      '</div>' +
      '<div class="progressTrack" role="progressbar" aria-valuemin="0" aria-valuemax="' + esc(String(total)) +
      '" aria-valuenow="' + esc(String(done)) + '" aria-label="' + esc(spec.label) + '">' +
      '<div class="progressFill" style="width:' + pct.toFixed(2) + '%"></div>' +
      '</div>' +
      '</div>'
  }

  /** 一组进度条。空数组返回空串。 */
  function bars(specs) {
    if (specs.length === 0) return ''
    return '<div class="stack">' + specs.map(bar).join('') + '</div>'
  }

  LZ.Progress = { tally: tally, bar: bar, bars: bars }
})(window.LZ = window.LZ || {})
