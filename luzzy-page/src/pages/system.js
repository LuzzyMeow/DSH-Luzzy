/* pages/system.js —— 页面五：系统信息。
 *
 * 三块：系统状态（运行 / 版本 / 插件）、使用统计（Token / 工具调用 / 执行时间）、
 * 用量图表（原「用量」子页的活动阵列 + 模型趋势 + 模型用量，整体并入这里，零功能损失）。
 *
 * 关于「版本不一致」这条最要紧的纪律
 * ----------------------------------
 * 客户端半热重载、宿主半不重载——所以「新客户端 + 旧宿主」是每次改动后的**常态**，
 * 不是异常。旧宿主会用**旧结构**应答，缺字段但不报错。
 * 这时画一张空图或写「还没有用量记录」，就把**版本不一致伪装成了「你没有数据」**，
 * 而它对用户的事实陈述是错的。所以这里必须点名是哪一半旧了，并指出要重启 DSH。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc
  const badge = LZ.StatusBadge.badge

  /* ---------------------------------------------------------------- 系统状态 */

  function statusCard(state, runtime) {
    const facts = []
    facts.push({ label: '运行状态', value: state.goalOk ? '正常' : '部分能力不可用' })
    facts.push({ label: '插件版本', value: state.version === '' ? '未知' : state.version })
    facts.push({ label: '插件标识', value: 'dsh-luzzy-page' })

    const capabilities = state.capabilities || {}
    const capRows = [
      { label: '目标服务', ok: capabilities.goalService !== false },
      { label: '会话服务', ok: capabilities.sessions !== false },
      { label: '智能体服务', ok: capabilities.agents !== false },
      { label: '交付计划工具', ok: capabilities.tools === true },
    ].map(function (row) {
      return '<li class="row">' +
        '<span class="rowId">' + (row.ok ? badge('success', '可用') : badge('waiting', '不可用')) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(row.label) + '</p></div>' +
        '</li>'
    }).join('')

    return LZ.Card.card({
      title: '系统状态',
      count: state.goalOk ? '正常' : '部分降级',
      body: LZ.Card.kv(facts) +
        '<div class="metricLabel" style="margin-top:var(--lz-space-sm)">能力探测</div>' +
        '<ul class="rows">' + capRows + '</ul>' +
        (state.goalDetail === null ? '' : LZ.Card.callout('warn', state.goalDetail)),
      sub: '「不可用」不代表坏了——这个插件对可选服务一律探测而非强依赖，缺一个其余照常工作。',
    })
  }

  /* ---------------------------------------------------------------- 使用统计 */

  function usageCard(state, runtime) {
    const totals = state.usageTotals

    // Token 总量与请求次数：来自 /__luzzy/usage，是已经跑通的数据。
    const tokenRows = []
    if (totals === null) {
      tokenRows.push(LZ.EmptyState.line('用量数据还没有读到。'))
    } else {
      const cacheRate = totals.totalTokens > 0 ? (totals.cacheReadTokens / totals.totalTokens) * 100 : 0
      tokenRows.push(LZ.Card.metrics([
        { label: 'Token 总量', value: LZ.RuntimeService.compact(totals.totalTokens) },
        { label: '输入', value: LZ.RuntimeService.compact(totals.inputTokens) },
        { label: '输出', value: LZ.RuntimeService.compact(totals.outputTokens) },
        { label: '缓存命中率', value: cacheRate.toFixed(1) + '%' },
      ]))
    }

    // 工具调用次数与执行时间：来自 /__luzzy/runtime。
    let runtimeRows
    if (runtime === null || runtime.ok !== true) {
      runtimeRows = LZ.EmptyState.blocked({
        title: '执行统计读不出来',
        body: '工具调用次数与执行时间来自会话日志。读不到时这里留空——' +
          '它不等于「没有调用过工具」，那两件事不一样。',
        detail: runtime === null ? undefined : runtime.code,
      })
    } else {
      runtimeRows = LZ.Card.metrics([
        { label: '工具调用次数', value: String(runtime.toolCalls) },
        { label: '执行时间', value: runtime.elapsedLabel },
        { label: '已完成轮次', value: String(runtime.turnsCompleted) },
        { label: '步数', value: String(runtime.steps) },
      ])
    }

    return LZ.Card.card({
      title: '使用统计',
      body: '<div class="stack">' +
        '<div><div class="metricLabel">Token 与请求</div>' + tokenRows.join('') + '</div>' +
        '<div><div class="metricLabel">执行</div>' + runtimeRows + '</div>' +
        '</div>',
      sub: 'Token 来自本机会话日志，按每次请求的最终用量统计（不重复计入流式分片）。',
    })
  }

  /* ---------------------------------------------------------------- 活动阵列 */

  function activityCard(state) {
    const activity = state.activity
    if (activity === null || activity === undefined) return ''
    const cells = activity.days.map(function (day) {
      if (day.isFuture === true) {
        // 未来的日期是**空心虚线格**：占据网格轨道（所以 30 天的月恒有 30 格），
        // 但不填色。它表示「还没到」，不是「用量为零」。
        return '<div class="cell cellFuture" aria-hidden="true"></div>'
      }
      const title = day.date + ' · ' + (day.totalTokens > 0 ? LZ.RuntimeService.compact(day.totalTokens) + ' tokens' : '没有用量')
      return '<div class="cell" data-level="' + LZ.Format.levelOf(day.totalTokens, activity.maxTokens) +
        '" title="' + esc(title) + '"></div>'
    }).join('')

    return LZ.Card.card({
      title: '活动阵列',
      count: activity.month,
      body: '<div class="cells">' + cells + '</div>' +
        '<div class="cellsCaption"><span>已过 ' + activity.pastDays + ' / ' + activity.daysInMonth + ' 天</span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span>深色表示用量更多</span></div>',
      sub: '一个自然月，每格一天。未到的日期留白，不是零用量。',
    })
  }

  /* ---------------------------------------------------------------- 模型趋势 */

  function trendCard(state) {
    // The usage payload is projected by the shell — this page never reads the raw response.
    // `activeWindow` is the already-selected window; `windowsMissing` is the already-evaluated
    // version-mismatch flag.
    if (!state.usageReady) return ''

    // A stale host half answers with the pre-change payload shape, so the window data is
    // absent while the counters are present. That must be NAMED, not drawn as an empty chart:
    // "you have no usage" would be a false statement about the user's own data.
    if (state.windowsMissing) {
      return LZ.Card.card({
        title: '模型趋势',
        count: '宿主半是旧版',
        body: LZ.EmptyState.blocked({
          title: '宿主半是本插件更新前的版本',
          body: '客户端会随文件改动热重载，宿主半不会——它需要重启 DSH 才生效。' +
            '本次已读到 ' + state.usageAttempts + ' 条用量记录，所以不是没有数据，是响应结构对不上。',
          action: LZ.Card.btnBar([{ label: '重试', id: 'systemRetry' }]),
        }),
      })
    }

    const windows = [['day', '日'], ['week', '周'], ['month', '月']]
    const modes = [['line', '折线'], ['bar', '条形']]
    const windowCaption = state.window === 'day' ? '今天的 24 小时'
      : state.window === 'week' ? '本周（周一起）' : '本月各周'

    const active = state.activeWindow
    const hasData = active !== null && active !== undefined && active.series.length > 0

    const controls = '<div class="inlineRow">' +
      '<span class="segLabel">' + esc(windowCaption) + '</span>' +
      '<div class="segment" role="group">' + windows.map(function (pair) {
        return '<button type="button" data-window="' + pair[0] + '" aria-pressed="' + String(state.window === pair[0]) + '">' + pair[1] + '</button>'
      }).join('') + '</div>' +
      '<div class="segment" role="group">' + modes.map(function (pair) {
        return '<button type="button" data-mode="' + pair[0] + '" aria-pressed="' + String(state.mode === pair[0]) + '">' + pair[1] + '</button>'
      }).join('') + '</div>' +
      '</div>'

    return LZ.Card.card({
      title: '模型趋势',
      count: windowCaption,
      actions: controls,
      body: hasData
        ? LZ.Chart.trend(active.series, active.slots, state.mode, state.animateChart)
        : LZ.EmptyState.line('这个' + (state.window === 'day' ? '今天' : state.window === 'week' ? '本周' : '本月') + '还没有用量记录。'),
    })
  }

  /* ---------------------------------------------------------------- 模型用量 */

  function modelCard(state) {
    if (state.usageModels.length === 0) return ''
    return LZ.Card.card({
      title: '模型用量',
      count: state.usageModels.length + ' 个模型',
      body: LZ.Chart.modelRows(state.usageModels),
    })
  }

  /* ---------------------------------------------------------------- 组装 */

  function render(state) {
    const runtime = state.runtimeView
    const parts = [
      statusCard(state, runtime),
      usageCard(state, runtime),
    ]

    // 用量那几张图只有在数据到了之后才画。加载中显示骨架，失败显示具名原因。
    if (state.usageStatus === 'loading' || state.usageStatus === 'idle') {
      parts.push(LZ.Card.card({
        title: '用量图表',
        body: LZ.EmptyState.loading('正在统计用量…', state.elapsed) +
          '<p class="note">首次统计要读完本机全部会话日志，约需 20–30 秒；之后是即时的。</p>',
      }))
      return parts.join('')
    }
    if (state.usageStatus === 'error') {
      parts.push(LZ.Card.card({
        title: '用量图表',
        body: LZ.EmptyState.blocked({
          title: '用量数据读不出来',
          body: '可以从头再读一次。',
          detail: state.usageDetail,
          action: LZ.Card.btnBar([{ label: '重试', id: 'systemRetry' }]),
        }),
      }))
      return parts.join('')
    }
    if (!state.usageReady || state.usageAttempts === 0) {
      parts.push(LZ.Card.card({
        title: '用量图表',
        body: LZ.EmptyState.empty({
          title: '暂无用量记录',
          body: '本机还没有可统计的用量记录。发起一次对话后回到这里，就会有数据。',
        }),
      }))
      return parts.join('')
    }

    parts.push(activityCard(state), trendCard(state), modelCard(state))
    return parts.join('')
  }

  LZ.SystemPage = { render: render }
})(window.LZ = window.LZ || {})
