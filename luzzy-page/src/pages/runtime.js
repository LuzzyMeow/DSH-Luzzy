/* pages/runtime.js —— 页面三：执行状态。
 *
 * 这一页回答「Agent 是怎么工作的」：当前第几轮、走到生命周期哪一步、调用了哪些工具、
 * 上下文装了什么。
 *
 * 全部数据来自一个只读路由 `/__luzzy/runtime`，而那个路由读的是**真实会话日志**里
 * 确实存在的字段——`tools/probe-runtime-events.mjs` 在本机 225 个日志上核过：
 * turn/start、turn/end、step/start、tool/call、tool/result、request/context、compaction/*。
 *
 * 一条纪律贯穿全页：**没有证据的步骤就是没有发生。**
 * 生命周期里没触发的阶段显示为空圈而不是勾；工具计数读不到时显示「读不到」而不是 0。
 * 把「我没拿到数据」画成「你没有活动」是这一页最容易犯、也最坏的错。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc
  const badge = LZ.StatusBadge.badge

  /* ---------------------------------------------------------------- 当前轮次 */

  function turnCard(view) {
    const body =
      LZ.Card.metrics([
        { label: '当前执行轮次', value: String(view.currentTurn) },
        { label: '已完成轮次', value: String(view.turnsCompleted) },
        { label: '步数', value: String(view.steps) },
        { label: '执行时间', value: view.elapsedLabel },
      ]) +
      LZ.Card.kv([
        { label: '会话', value: view.sessionId === '' ? '未知' : view.sessionId },
        { label: '日志起点', value: view.openedAt === '' ? '未知' : view.openedAt },
        { label: '最后活动', value: view.endedAt === '' ? '未知' : view.endedAt },
        { label: '最近一次工具调用', value: view.lastToolAt === '' ? '还没有调用过工具' : view.lastToolAt },
      ]) +
      (view.source === 'latest'
        ? LZ.Card.callout('warn', '页面没有拿到自己的会话标识，这里显示的是本机最近有活动的那份日志。' +
          '在左侧打开目标会话后回到这里，或刷新页面重试。')
        : '')

    return LZ.Card.card({ title: '当前轮次', count: '第 ' + view.currentTurn + ' 轮', body: body })
  }

  /* ---------------------------------------------------------------- 生命周期 */

  function lifecycleCard(view) {
    const done = view.steps5.filter(function (step) { return step.done }).length
    // 把「哪一步正在走」标出来：第一个未完成的步骤就是当前位置。
    let marked = false
    const steps = view.steps5.map(function (step) {
      if (!step.done && !marked) { marked = true; return { label: step.label, done: false, active: true } }
      return step
    })
    return LZ.Card.card({
      title: '生命周期',
      count: done + ' / ' + steps.length + ' 步',
      sub: '每一步的判据是会话日志里那个事件是否真的出现过，不是推测。',
      body: LZ.Timeline.lifecycle(steps),
    })
  }

  /* ---------------------------------------------------------------- 工具调用 */

  function toolCard(view) {
    if (view.toolCalls === 0) {
      return LZ.Card.card({
        title: '工具调用记录',
        count: '0 次',
        body: LZ.EmptyState.empty({
          title: '暂无工具调用',
          body: '这个会话还没有调用过任何工具。Agent 一旦开始干活，这里会按类别列出它用了什么、用了多少次。',
        }),
      })
    }

    const groups = view.toolGroups.map(function (group) {
      return '<li class="row">' +
        '<span class="rowId">' + esc(String(group.count)) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(group.label) + '</p>' +
        '<p class="rowSub">' + esc(group.names.join('、')) + '</p></div>' +
        '</li>'
    }).join('')

    const recent = view.recentCalls.length === 0 ? '' :
      '<div><div class="metricLabel">最近调用</div>' +
      LZ.Timeline.timeline(view.recentCalls.slice(0, 10).map(function (call) {
        return {
          time: call.at,
          text: call.label + ' · ' + call.name,
          sub: '第 ' + call.turn + ' 轮 第 ' + call.step + ' 步' + (call.ok === false ? ' · 失败' : ''),
          state: call.ok === false ? 'failed' : 'success',
          done: call.ok !== false,
        }
      })) + '</div>'

    return LZ.Card.card({
      title: '工具调用记录',
      count: view.toolCalls + ' 次调用' + (view.toolErrors > 0 ? ' · ' + view.toolErrors + ' 次失败' : ''),
      body: '<ul class="rows">' + groups + '</ul>' + recent,
      sub: '按语义归类。归类后的合计与原始总计数一致——少一个数就是在骗人。',
    })
  }

  /* ---------------------------------------------------------------- 上下文状态 */

  function contextCard(view) {
    const rows = view.contextItems.map(function (item) {
      return '<li class="row">' +
        '<span class="rowId">' + (item.ok ? badge('success', '是') : badge('idle', '否')) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(item.label) + '</p>' +
        '<p class="rowSub">' + esc(item.value) + (item.detail === undefined || item.detail === '' ? '' : ' · ' + esc(item.detail)) + '</p></div>' +
        '</li>'
    }).join('')

    const context = view.context
    const modelFacts = []
    if (context !== null && context !== undefined) {
      if (context.model !== '') modelFacts.push('<code>' + esc(context.model) + '</code>')
      if (context.provider !== '') modelFacts.push('来自 ' + esc(context.provider))
      if (context.contextWindow !== null) {
        modelFacts.push('上下文窗口 ' + LZ.RuntimeService.compact(context.contextWindow) + ' tokens')
      }
    }
    const facts = []
    if (view.preset !== null && view.preset !== undefined) facts.push({ label: '会话预设', value: view.preset })
    if (view.sandbox !== null && view.sandbox !== undefined) facts.push({ label: '沙箱模式', value: view.sandbox })
    if (view.approval !== null && view.approval !== undefined) facts.push({ label: '审批策略', value: view.approval })
    facts.push({ label: '压缩次数', value: view.compactions === 0 ? '未压缩过' : view.compactions + ' 次' })

    return LZ.Card.card({
      title: '上下文状态',
      count: facts.length + ' 项',
      body: '<ul class="rows">' + rows + '</ul>' +
        (modelFacts.length === 0 ? '' : '<p class="cardSub" style="margin:0">当前模型：' + modelFacts.join(' · ') + '</p>') +
        LZ.Card.kv(facts),
      sub: '「历史信息」显示的是压缩次数——压缩发生过恰恰说明历史曾经过载，所以它说「已压缩」而不是「已加载」。',
    })
  }

  /* ---------------------------------------------------------------- 组装 */

  function render(state) {
    if (state.status === 'idle' || state.status === 'loading') {
      return LZ.EmptyState.loading('正在读取执行状态…', state.elapsed)
    }

    const view = state.view
    if (view === null || view.ok !== true) {
      // 「读不到」与「没有活动」必须分开。这里全部走「读不到」那一支，并说明原因——
      // 显示成「暂无执行信息」会让用户以为自己的会话是空的。
      const reason = view === null ? '没有收到执行状态数据。' : view.reason
      return LZ.EmptyState.blocked({
        title: '执行状态读不出来',
        body: reason || '宿主没有返回执行状态。',
        detail: view === null ? undefined : view.code,
        action: LZ.Card.btnBar([{ label: '重试', id: 'runtimeRetry' }]),
      })
    }

    if (view.openedAt === '' && view.toolCalls === 0 && view.steps === 0) {
      return LZ.Card.card({
        title: '执行状态',
        body: LZ.EmptyState.empty({
          title: '暂无执行信息',
          body: '这份日志里没有任何执行事件。可能这个会话刚建立，或者它还没有开始干活。',
          action: LZ.Card.btnBar([{ label: '刷新', id: 'runtimeRetry' }]),
        }),
      })
    }

    return [
      turnCard(view),
      '<div class="grid" data-cols="2">' +
        '<div class="stack">' + lifecycleCard(view) + '</div>' +
        '<div class="stack">' + contextCard(view) + '</div>' +
        '</div>',
      toolCard(view),
    ].join('')
  }

  LZ.RuntimePage = { render: render }
})(window.LZ = window.LZ || {})
