/* runtime-service —— 执行状态数据层：把 /__luzzy/runtime 的载荷转成视图模型。
 *
 * 页面只吃视图模型。这里负责把后端字段翻成中文、把工具名归成「读取文件 / 修改代码 /
 * 执行命令 / 测试」四类可读的语义，并把生命周期推导出来——那三件事都是数据层的知识。
 *
 * 一条纪律：**「读不到」与「没有活动」必须分开表达。**
 * 后端给 `ok: false` 时返回一个具名的原因，页面据此显示「读不到 + 为什么」，
 * 绝不显示成「暂无执行信息」——后者是对用户数据的不实陈述。
 */
(function (LZ) {
  'use strict'

  /**
   * 工具名的语义归类。
   *
   * 归类是**显示层**的知识，不是后端契约：工具名会随部署变化，认不出的归到「其他工具」
   * 并保留原名——不吞掉未知值，否则新工具会在页面上凭空消失。
   *
   * 归类顺序有意义：先判更具体的（测试），再判更宽的（文件/命令）。
   */
  const TOOL_CATEGORIES = [
    { key: 'test', label: '测试', match: /^(test_|vitest|jest|playwright|cypress|pytest)/i },
    { key: 'read', label: '读取文件', match: /^(read|glob|grep|list_|ls$|cat$|search)/i },
    { key: 'write', label: '修改代码', match: /^(write|edit|apply_|patch|multi_edit|create)/i },
    { key: 'exec', label: '执行命令', match: /^(pwsh|bash|shell|exec|run_|command|node$|python)/i },
    { key: 'net', label: '联网检索', match: /^(web_|fetch|http|anysearch|search_)/i },
    { key: 'agent', label: '子代理', match: /^(subagent|agent_|task$|delegate)/i },
    { key: 'goal', label: '目标管理', match: /^(goal_|update_goal|get_goal|create_goal)/i },
  ]

  /** 认不出的工具保留原名，归到「其他工具」。 */
  function categorize(name) {
    for (const category of TOOL_CATEGORIES) {
      if (category.match.test(name)) return category
    }
    return { key: 'other', label: '其他工具', match: null }
  }

  /** 把工具计数按语义归类汇总。归类后的合计必须等于原始总计数——少一个数就是在骗人。 */
  function toolGroups(toolList) {
    const byKey = {}
    let total = 0
    for (const row of toolList) {
      const category = categorize(row.name)
      if (byKey[category.key] === undefined) {
        byKey[category.key] = { key: category.key, label: category.label, count: 0, names: [] }
      }
      byKey[category.key].count += row.count
      byKey[category.key].names.push(row.name)
      total += row.count
    }
    const groups = Object.keys(byKey).map(function (key) { return byKey[key] })
    groups.sort(function (a, b) { return b.count - a.count })
    return { groups: groups, total: total }
  }

  /** 毫秒 → 「1 小时 23 分」这样的可读时长。用于执行时间。 */
  function duration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—'
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return seconds + ' 秒'
    const minutes = Math.floor(seconds / 60)
    const restSeconds = seconds % 60
    if (minutes < 60) return restSeconds === 0 ? minutes + ' 分钟' : minutes + ' 分 ' + restSeconds + ' 秒'
    const hours = Math.floor(minutes / 60)
    const restMinutes = minutes % 60
    return restMinutes === 0 ? hours + ' 小时' : hours + ' 小时 ' + restMinutes + ' 分'
  }

  /** 大数缩写：1.2 亿 / 3.4 万。 */
  function compact(value) {
    if (typeof value !== 'number' || !isFinite(value) || value === 0) return '0'
    const abs = Math.abs(value)
    if (abs >= 1e8) return (value / 1e8).toFixed(2) + ' 亿'
    if (abs >= 1e4) return (value / 1e4).toFixed(1) + ' 万'
    if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'k'
    return String(Math.round(value))
  }

  /**
   * 生命周期五步。
   *
   * 这五步对应 DSH 一轮真实经历的阶段，判据是**事件是否出现过**，不是猜测：
   *   读取目标   ← 有 goal 或已在工作区活动
   *   分析任务   ← 有 step/start
   *   调用工具   ← 有 tool/call
   *   更新状态   ← 有 goal/change（计划被改动过）
   *   完成交付检查 ← 有 turnsCompleted（一轮走完）
   *
   * 没有证据的步骤是 `done: false`，不是 `done: true`——把没发生的说成发生了，
   * 这张图的全部价值就没了。
   */
  function lifecycle(view) {
    const steps = [
      { key: 'orient', label: '读取目标', done: view.goalLinked === true || view.steps > 0 },
      { key: 'plan', label: '分析任务', done: view.steps > 0 },
      { key: 'act', label: '调用工具', done: view.toolCalls > 0 },
      { key: 'update', label: '更新状态', done: view.goalChanges > 0 },
      { key: 'commit', label: '完成交付检查', done: view.turnsCompleted > 0 },
    ]
    return steps
  }

  /**
   * 上下文状态。
   *
   * 三项的判据都来自真实事件：
   *   当前目标   ← 会话日志里有 goal/change
   *   项目规则   ← 会话读过的文件里出现过 AGENTS.md / CLAUDE.md
   *   历史信息   ← 有过 compaction（说明上下文被压缩过，即曾经装不下）
   *
   * 第三项是**反向**的：compaction 发生过恰恰说明历史信息曾经过载。
   * 所以它标「已压缩」而不是「已加载」——两者的含义不同，不能混。
   */
  function contextItems(view) {
    return [
      { label: '当前目标', value: view.goalChanges > 0 ? '已加载' : '未加载', ok: view.goalChanges > 0 },
      { label: '项目规则', value: view.ruleFiles.length > 0 ? '已读取' : '未见读取记录', ok: view.ruleFiles.length > 0, detail: view.ruleFiles.join('、') },
      { label: '历史信息', value: view.compactions > 0 ? '已压缩 ' + view.compactions + ' 次' : '未压缩', ok: true },
    ]
  }

  /**
   * 把 /__luzzy/runtime 的载荷转成视图模型。
   *
   * @param {object} payload
   * @returns {object}
   */
  function toView(payload) {
    if (payload === null || payload === undefined) {
      return { ok: false, reason: '没有收到执行状态数据。' }
    }
    if (payload.ok !== true) {
      // Each reason gets its own sentence, because they call for different actions.
      const reasons = {
        'invalid-session-id': '会话 id 不合法——这是页面这边的 bug，不是你的数据有问题。',
        'session-log-missing': '找不到这个会话的日志。它可能还没有产生任何活动，或日志已被清理。',
        'log-unreadable': '这个会话的日志读不出来。它可能正在写入，或压缩帧已损坏。',
        'no-logs': '本机还没有会话日志。',
      }
      return {
        ok: false,
        reason: reasons[payload.reason] || payload.message || '执行状态读不出来。',
        code: payload.reason || 'unknown',
      }
    }

    const recentCalls = (payload.recentCalls || []).map(function (call) {
      const category = categorize(call.name)
      return {
        name: call.name,
        label: category.label,
        at: LZ.GoalService.stamp(call.at),
        turn: call.turn,
        step: call.step,
        ok: call.ok,
        done: call.ok === true,
      }
    })

    // 规则文件是被读过的文件里出现过的。后端从**工具调用的 arguments** 里检出，
    // 那是这个事实唯一存在的地方——只看工具名分不出「读了 AGENTS.md」和「读了别的文件」。
    const ruleFiles = (payload.ruleFiles || []).slice()

    const groups = toolGroups(payload.toolList || [])

    const view = {
      ok: true,
      sessionId: payload.sessionId || '',
      source: payload.source,
      scanned: payload.scanned,
      version: payload.version,

      currentTurn: payload.currentTurn,
      turnsCompleted: payload.turnsCompleted,
      steps: payload.steps,

      toolCalls: payload.toolCalls,
      toolErrors: payload.toolErrors,
      toolGroups: groups.groups,
      toolTotal: groups.total,
      recentCalls: recentCalls,

      compactions: payload.compactions,
      goalChanges: payload.goalChanges,
      goalLinked: payload.goalChanges > 0,
      context: payload.context,
      preset: payload.preset,
      sandbox: payload.sandbox,
      approval: payload.approval,

      elapsedMs: payload.elapsedMs,
      elapsedLabel: duration(payload.elapsedMs),
      lastToolAt: payload.lastToolAt === null ? '' : LZ.GoalService.stamp(payload.lastToolAt, payload.endedAt),

      openedAt: payload.openedAt === null ? '' : LZ.GoalService.stamp(payload.openedAt),
      endedAt: payload.endedAt === null ? '' : LZ.GoalService.stamp(payload.endedAt),

      ruleFiles: ruleFiles,
    }
    view.steps5 = lifecycle(view)
    view.contextItems = contextItems(view)
    return view
  }

  /** 当前模型的可读标识：`provider/model`。两者都没有时返回空串，不编一个。 */
  function modelLabel(context) {
    if (context === null || context === undefined) return ''
    const provider = typeof context.provider === 'string' ? context.provider : ''
    const model = typeof context.model === 'string' ? context.model : ''
    if (provider === '' && model === '') return ''
    if (provider === '') return model
    return provider + ' / ' + model
  }

  LZ.RuntimeService = {
    toView: toView,
    categorize: categorize,
    toolGroups: toolGroups,
    lifecycle: lifecycle,
    contextItems: contextItems,
    duration: duration,
    compact: compact,
    modelLabel: modelLabel,
    TOOL_CATEGORIES: TOOL_CATEGORIES,
  }
})(window.LZ = window.LZ || {})
