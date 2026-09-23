/* StatusBadge —— 状态徽标 + 状态词典。
 *
 * 一条不可协商的规则：**颜色永远不单独承载状态。**
 * 每一枚徽标都是「颜色 + 内联 SVG 图标 + 一个词」三者齐备。只说颜色对色盲读者不可读，
 * 而且违反设计规则（Don't signal state with color alone — pair it with an icon or label）。
 *
 * 图标用内联 SVG path 而不是字符（✓ ○ ✗）：帧内的字体子集是按页面文案裁出来的，
 * 一个没被裁进去的字符会**静默回退到系统字体**，字形与其余部分对不上。
 *
 * 六档状态与后端状态的映射集中在 STATUS 表里。它放在这里而不是页面里，是因为
 * 「某个状态该怎么显示」是所有页面共用的知识——曾经三个页面各有一张自己的映射表。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  /** 11×11 视口的图标路径。stroke 用 currentColor，所以颜色由徽标的 state 决定。 */
  const GLYPHS = {
    // 勾
    success: '<path d="M2 5.6 4.2 7.8 9 3"/>',
    // 叉
    failed: '<path d="M3 3 8 8M8 3 3 8"/>',
    // 感叹号
    blocked: '<path d="M5.5 2v4.2"/><circle cx="5.5" cy="8.4" r="0.75" fill="currentColor" stroke="none"/>',
    // 沙漏（等待）
    waiting: '<path d="M3 2h5M3 9h5M3.6 2c0 2 1.9 2.6 1.9 3.5S3.6 7 3.6 9M7.4 2c0 2-1.9 2.6-1.9 3.5S7.4 7 7.4 9"/>',
    // 实心点（执行中，会呼吸）
    running: '<circle cx="5.5" cy="5.5" r="2.4" fill="currentColor" stroke="none"/>',
    // 空心圈（未开始）
    idle: '<circle cx="5.5" cy="5.5" r="2.8"/>',
  }

  /**
   * 一枚徽标。
   *
   * @param {'running'|'success'|'failed'|'waiting'|'blocked'|'idle'} state
   * @param {string} label 中文词，必填——没有词的徽标不许出现在这里
   * @param {string} [title] 悬停说明
   */
  function badge(state, label, title) {
    const key = GLYPHS[state] === undefined ? 'idle' : state
    const pulse = key === 'running' ? ' class="badgePulse"' : ''
    return '<span class="badge" data-state="' + esc(key) + '"' +
      (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + pulse + '>' +
      GLYPHS[key] + '</svg>' +
      '<span>' + esc(label) + '</span>' +
      '</span>'
  }

  /** 一行徽标。空数组返回空串，调用点不必再判一次。 */
  function badgeRow(badges) {
    if (badges.length === 0) return ''
    return '<div class="badgeRow">' + badges.join('') + '</div>'
  }

  /* ---- 状态词典 ----
   *
   * 左：后端或领域层给出的状态字符串。右：[徽标档位, 中文词]。
   *
   * 这里**只做显示映射**，不做任何状态推导——推导属于 services/，因为「这个状态意味着什么」
   * 是数据层的事，页面只负责把它画出来。
   */
  const STATUS = {
    // 验收标准（goal-domain 的 ACCEPTANCE_STATUSES）
    pending: ['idle', '待开始'],
    in_progress: ['running', '进行中'],
    verified: ['success', '已验证'],
    rejected: ['failed', '不满足'],

    // 任务（goal-domain 的 TASK_STATUSES）
    ready: ['waiting', '就绪'],
    blocked: ['blocked', '受阻'],
    completed: ['success', '已完成'],
    cancelled: ['idle', '已取消'],

    // 提案（goal-domain 的 PROPOSAL_STATUSES）
    adopted: ['success', '已采纳'],
    withdrawn: ['idle', '已撤回'],
    superseded: ['idle', '已被取代'],

    // 运行时 goal 的阶段（dsh-goal 的 phase）
    active: ['running', '进行中'],
    paused: ['waiting', '已暂停'],
    complete: ['success', '已完成'],

    // 健康度（goal-domain 的 health()）
    healthy: ['success', '正常'],
    'needs-attention': ['waiting', '需要注意'],
    verifying: ['running', '待验证'],

    // 阻塞 / 决策等
    open: ['blocked', '未解决'],
    resolved: ['success', '已解决'],
    success: ['success', '成功'],
    failed: ['failed', '失败'],
  }

  /** 按状态字符串取徽标；认不出的状态原样显示为 idle，并保留原文——不吞掉未知值。 */
  function fromStatus(status) {
    const entry = STATUS[status]
    if (entry === undefined) return badge('idle', String(status === undefined || status === null ? '未知' : status))
    return badge(entry[0], entry[1])
  }

  /** 该状态映射到哪一档（给 Timeline / Progress 的 data-state 用）。 */
  function toneOf(status) {
    const entry = STATUS[status]
    return entry === undefined ? 'idle' : entry[0]
  }

  /* ---- 验收标准的「勾/圈」形态 ----
   *
   * 方案明确要求验收标准**不要用普通表格**，改成任务状态列表：一行一条，
   * 前面一个字形，扫一眼就看完全部条目。
   */
  function checkMark(status) {
    const tone = toneOf(status)
    const glyph = GLYPHS[tone] === undefined ? GLYPHS.idle : GLYPHS[tone]
    return '<svg class="checkMark" width="13" height="13" viewBox="0 0 11 11" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + glyph + '</svg>'
  }

  LZ.StatusBadge = {
    badge: badge,
    badgeRow: badgeRow,
    fromStatus: fromStatus,
    toneOf: toneOf,
    checkMark: checkMark,
    GLYPHS: GLYPHS,
  }
})(window.LZ = window.LZ || {})
