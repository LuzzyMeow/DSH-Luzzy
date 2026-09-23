/* pages/overview.js —— 页面一：总览。
 *
 * 用户打开 Luzzy 第一眼要看到的，是**Agent 当前正在做什么**。
 * 这一页的全部设计目标是一句话：5 秒内能回答
 *
 *   1. Agent 当前目标是什么？    → 目标卡
 *   2. 做到哪一步了？            → 目标卡的完成度 + 验收计数
 *   3. 下一步是什么？            → 当前执行状态卡
 *   4. 为什么这样执行？          → 执行依据卡（范围 / 约束 / 最近决策）
 *   5. 是否已经完成？            → 完成判定（可判定的判据，不是感觉）
 *
 * 所以它的排布是「先结论、后细节」：一句话结论在最上，支撑它的数字在下面。
 * 不做仪表盘式的等宽卡片矩阵——四个等宽方块是「没有判断」的排版，不是信息层级。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc
  const badge = LZ.StatusBadge.badge
  // 目标正文的显示分档在 Format 里——目标中心也用同一份，两页不能各写一遍。
  const objectiveText = LZ.Format.objectiveText

  /* ---------------------------------------------------------------- 目标卡 */

  function goalCard(view) {
    if (view.goal === null) {
      const isUnavailable = view.goalState === 'unavailable'
      return LZ.Card.card({
        title: '当前目标',
        count: isUnavailable ? '读不到运行时目标' : '没有目标',
        body: LZ.EmptyState.empty({
          title: isUnavailable ? '运行时目标读不到' : '这个会话还没有目标',
          body: isUnavailable
            ? '这个会话没有加载在本进程里。在左侧打开它，目标就会出现。'
            : '让 Agent 开始一个长任务，它会建立一个目标；也可以在输入框里直接说「把这件事做成一个目标」。',
          action: LZ.Card.btnBar([{ label: '刷新', id: 'overviewRefresh' }]),
        }),
      })
    }

    const goal = view.goal
    const counts = view.counts

    // 完成度用「已验证 / 总数」而不是百分比：4 / 6 告诉你还差什么，67% 什么都不说。
    const pct = counts.acceptance.total === 0 ? null : counts.acceptance

    const body =
      '<div class="badgeRow">' +
      LZ.StatusBadge.fromStatus(goal.phase) +
      // 健康度只在它与阶段说的**不是同一件事**时才出现。
      //
      // 用户截图里这里并排两个「已完成」：`goal.phase === 'complete'` → 已完成，
      // `health === 'completed'` → 也是已完成。同一个词说两遍，不增加信息，只增加噪音；
      // 更糟的是它让人以为其中一个有额外含义，于是去猜两个的区别。
      // 规则：健康度与阶段档位相同就不画。不同才画——那时它确实是新信息（例如阶段
      // 还在「进行中」而健康度已经「需要注意」）。
      (LZ.StatusBadge.toneOf(view.health) === LZ.StatusBadge.toneOf(goal.phase)
        ? ''
        : LZ.StatusBadge.fromStatus(view.health)) +
      '</div>' +
      objectiveText(goal.objective) +      (pct === null
        ? LZ.EmptyState.line('还没有定义验收标准，所以「完成度」暂时无从计算。')
        : LZ.Progress.bar({
          label: '验收标准',
          done: pct.done,
          total: pct.total,
          tone: pct.done === pct.total ? 'success' : 'waiting',
        })) +
      LZ.Card.metrics([
        { label: '当前阶段', value: goal.phaseLabel },
        { label: '轮次', value: goal.roundsStarted + ' / ' + goal.maxGoalRounds },
        { label: '任务', value: counts.tasks.total === 0 ? '—' : counts.tasks.done + ' / ' + counts.tasks.total },
        { label: '未解决阻塞', value: String(counts.blockers.open) },
      ])

    return LZ.Card.card({
      title: '当前目标',
      count: goal.phaseLabel,
      body: body,
      id: 'overviewGoal',
    })
  }

  /* ---------------------------------------------------------------- 当前执行状态 */

  function statusCard(view) {
    if (view.delivery === null) {
      return LZ.Card.card({
        title: '当前执行状态',
        body: LZ.EmptyState.empty({
          title: '暂无执行信息',
          body: '这个会话还没有留下交付计划。目标建立后，Agent 会把当前焦点与下一步记在这里。',
        }),
      })
    }
    const progress = LZ.GoalService.progressOf(view)
    const body =
      '<div><div class="metricLabel">当前正在处理</div>' +
      '<div class="focusBox" data-empty="' + String(progress.current === '') + '">' +
      esc(progress.current === '' ? '还没有声明当前焦点' : progress.current) + '</div></div>' +
      '<div><div class="metricLabel">下一步</div>' +
      (progress.next === ''
        ? LZ.EmptyState.line('还没有写下下一步。')
        : '<ol class="nextList">' + progress.next.split('；').map(function (item) {
          return '<li>' + esc(item) + '</li>'
        }).join('') + '</ol>') +
      '</div>'
    return LZ.Card.card({ title: '当前执行状态', body: body })
  }

  /* ---------------------------------------------------------------- 完成判定 */

  function doneCard(view) {
    if (view.delivery === null) return ''
    const progress = LZ.GoalService.progressOf(view)
    const counts = view.counts

    const body =
      '<div class="badgeRow">' +
      (progress.done ? badge('success', '可以判定为完成') : badge('waiting', '尚未完成')) +
      '</div>' +
      '<p class="cardSub" style="margin:0">' + esc(progress.doneReason) + '</p>' +
      LZ.Card.metrics([
        { label: '必须的验收标准', value: counts.acceptance.mandatoryDone + ' / ' + counts.acceptance.mandatory },
        { label: '未解决阻塞', value: String(counts.blockers.open) },
      ]) +
      '<p class="note">判定只认可判定的东西：必须满足的验收标准全部已验证，且没有未解决的阻塞。' +
      '「目标本身是否真的达成」是 Agent 的判断，这一页不假装自己做得了那件事。</p>'
    return LZ.Card.card({ title: '是否已经完成', body: body })
  }

  /* ---------------------------------------------------------------- 执行依据 */

  function whyCard(view) {
    if (view.delivery === null) return ''
    const delivery = view.delivery
    const lines = []

    if (delivery.scope.included.length > 0) {
      lines.push('<div><div class="metricLabel">范围</div><ul class="nextList">' +
        delivery.scope.included.map(function (item) { return '<li>' + esc(item) + '</li>' }).join('') + '</ul></div>')
    }
    if (delivery.scope.excluded.length > 0) {
      lines.push('<div><div class="metricLabel">不包含</div><ul class="nextList">' +
        delivery.scope.excluded.map(function (item) { return '<li>' + esc(item) + '</li>' }).join('') + '</ul></div>')
    }
    if (delivery.constraints.length > 0) {
      lines.push('<div><div class="metricLabel">约束</div><ul class="nextList">' +
        delivery.constraints.map(function (item) { return '<li>' + esc(item) + '</li>' }).join('') + '</ul></div>')
    }
    if (delivery.decisions.length > 0) {
      const latest = delivery.decisions[delivery.decisions.length - 1]
      lines.push('<div><div class="metricLabel">最近决策</div>' +
        '<p class="rowText">' + esc(latest.decision) + '</p>' +
        (latest.reason === '' ? '' : '<p class="rowSub">原因：' + esc(latest.reason) + '</p>') +
        '</div>')
    }

    if (lines.length === 0) {
      return LZ.Card.card({
        title: '为什么这样执行',
        body: LZ.EmptyState.empty({
          title: '还没有写下执行依据',
          body: '范围、约束与决策记录都是空的。它们由 Agent 在规划时记录——没有它们，' +
            '这一页只能告诉你「在做什么」，说不出「为什么这样做」。',
        }),
      })
    }
    return LZ.Card.card({ title: '为什么这样执行', body: '<div class="stack">' + lines.join('') + '</div>' })
  }

  /* ---------------------------------------------------------------- 最近动态 */

  function activityCard(view) {
    if (view.delivery === null) {
      return LZ.Card.card({
        title: '最近动态',
        body: LZ.EmptyState.empty({ title: '暂无记录', body: '还没有任何计划变更被记录下来。' }),
      })
    }
    const rows = LZ.GoalService.recentActivity(view, 12)
    return LZ.Card.card({
      title: '最近动态',
      count: view.counts.changes.total + ' 条变更',
      body: LZ.Timeline.timeline(rows.map(function (row) {
        return { time: row.at, text: row.text, sub: row.sub === '' ? row.actor : row.actor + ' · ' + row.sub, state: row.state }
      }), { emptyText: '暂无记录' }),
    })
  }

  /* ---------------------------------------------------------------- 组装 */

  function render(state) {
    if (state.status === 'idle' || state.status === 'loading') {
      return LZ.EmptyState.loading('正在读取 Agent 状态…', state.elapsed)
    }
    const goalState = state.goal
    if (goalState !== null && goalState.status === 'error') {
      return LZ.EmptyState.blocked({
        title: 'Agent 状态读不出来',
        body: '可以从头再读一次。如果一直读不出来，多半是宿主半还需要重启 DSH 才生效。',
        detail: goalState.detail,
        action: LZ.Card.btnBar([{ label: '重试', id: 'overviewRetry' }]),
      })
    }

    const view = goalState === null ? null : goalState.view
    if (view === null || view.ok !== true) {
      const reason = view === null ? '还没有读到目标状态。' : view.reason
      return LZ.EmptyState.blocked({
        title: '目标状态读不出来',
        body: reason || '宿主没有返回目标状态。',
        detail: view === null ? undefined : view.detail,
        action: LZ.Card.btnBar([{ label: '重试', id: 'overviewRetry' }]),
      })
    }

    return [
      goalCard(view),
      '<div class="grid" data-cols="2">' +
        '<div class="stack">' + statusCard(view) + doneCard(view) + '</div>' +
        '<div class="stack">' + whyCard(view) + '</div>' +
        '</div>',
      activityCard(view),
    ].join('')
  }

  LZ.OverviewPage = { render: render }
})(window.LZ = window.LZ || {})
