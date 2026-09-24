/* pages/goal.js —— 页面二：目标中心（最高优先级页面）。
 *
 * 回答长任务里必须能回答的六个问题，自上而下就是页面顺序：
 *
 *   目标概览    我要完成什么、做到哪一步
 *   验收标准    什么条件满足才算完成（任务状态列表，不是表格）
 *   任务拆解    这件事被拆成了什么（可展开收起的树）
 *   执行证据    凭什么说做到了
 *   决策记录    为什么这样做
 *   历史版本    一路上变过什么
 *
 * 这个文件**只吃视图模型**。它不认识 `delivery.acceptance[].mandatory` 这类后端字段，
 * 也不做任何状态推导——那些都在 services/goal-service.js。所以这个页面可以用一个手写的
 * 视图模型对象直接渲染并断言，不必造一份假的宿主响应。
 *
 * 页面**从不写运行时 goal**。目标、范围、约束、必须的验收标准属于人类权威：Agent 只能
 * 提议，页面给「采纳 / 不采纳」按钮。这是设计里最要紧的一条，所以在 UI 上也看得见。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc
  const badge = LZ.StatusBadge.badge

  /**
   * 目标中心的六个分区。顺序即阅读顺序：现在怎么样 → 要做什么 → 凭什么 → 一路上变过什么 →
   * 谁在做 → 怎么做的。
   *
   * 「执行」与「Agent」两个分区是**执行状态页与 Agent 配置页折进来的**。它们原本是两个独立
   * 页签，内容原样搬过来（同一批渲染函数，没有重写）——删掉的只是入口，不是内容：
   *
   *   执行   当前第几轮、生命周期走到哪、调用了哪些工具、上下文装了什么
   *   Agent  这个 Agent 是谁、行为策略、工具能力、上下文策略、名单
   *
   * 为什么排在这四段之后而不是前面：前四段回答的是**这一个目标**的问题，它们才是这一页的
   * 主场；执行与 Agent 回答的是**谁在做、怎么做的**，是支撑性的，放在后面。
   */
  const GOAL_SECTIONS = [
    ['overview', '概览'],
    ['plan', '计划'],
    ['evidence', '证据'],
    ['record', '记录'],
    ['execution', '执行'],
    ['agent', 'Agent'],
  ]

  /* ---------------------------------------------------------------- 预期产出 */

  /**
   * 预期产出：这个目标做完之后**到底会得到什么**，一段话。
   *
   * 位置在目标正文下面、同一张卡片里，而不是另开一张卡：
   *   1. 「我要完成什么」和「做完会得到什么」本来是同一个句子的两半，拆成两张卡会让人以为
   *      它们是两件事；
   *   2. 这一页已经太长（用户直接提过），再加一张整宽卡片是最差的加法。
   *
   * 没写就**照实说没写**，绝不拿目标正文来顶上 —— 那一格是 Agent 对结果的承诺，
   * 而「它还没有回答这个问题」本身就是用户要看到的信息。补一句默认文案会让页面看起来
   * 已经答过了，于是没有人会回来写它。
   *
   * 内容按 Markdown 渲染（`LZ.Markdown.render` 先转义再解析，只放行 http/mailto 链接，
   * 所以这里可以放心当 HTML 用）。超过一段话该有的长度时，正文留在卡片里、另给一个
   * 视窗入口 —— 它已经不像「一段话」了，页面不该跟着它一起变长。
   */
  function expectedOutputBlock(view) {
    if (view.delivery === null || view.delivery === undefined) return ''
    const text = view.delivery.expectedOutput || ''
    const heading = '<div class="metricLabel">预期产出</div>'
    if (text === '') {
      return heading +
        '<p class="rowSub">还没有写。这一格要一段话 —— 这个目标做完之后会得到什么。</p>'
    }
    const body = LZ.Markdown.render(text)
    if (text.length <= 240) return heading + body
    return heading + body +
      LZ.Card.btnBar([{ label: '在视窗里读', attrs: 'data-viewer="expected" data-viewer-title="预期产出"' }])
  }

  /**
   * 概览目标：卡片最上面那一格，Agent 写的「这个目标在做什么」，一段话。
   *
   * 它**顶掉**的是原来那份目标全文引用块。原文一个字都没删 —— 完整的那份在「完整计划」
   * 视窗的第 1 节里，而这一格回答的是另一个问题：先给我一句话，让我知道这东西在干什么。
   *
   * 三处刻意的选择：
   *   1. 与 `expectedOutputBlock` 同一套皮（`.metricLabel` + Markdown 输出），因为它们是上下
   *      相邻的两格，长得不一样会让人以为其中一个不属于这里；
   *   2. 上限 600 字、由 domain 硬拒（超了不截断），所以**不给视窗入口** —— 它按定义就是一段
   *      能当场读完的话，再套一层视窗只是把「读完它」变成一次点击；
   *   3. 没写就照实说没写，**不拿目标原文顶上** —— 那一格是 Agent 的回答，拿正文顶替会让页面
   *      看起来已经答过了，于是没有人会回来写它（预期产出踩过同一个坑）。
   */
  function goalSummaryBlock(view) {
    if (view.delivery === null || view.delivery === undefined) return ''
    const text = view.delivery.goalSummary || ''
    const heading = '<div class="metricLabel">概览目标</div>'
    if (text === '') {
      return heading +
        '<p class="rowSub">还没有写。这一格要一段话 —— 这个目标在做什么。</p>'
    }
    return heading + LZ.Markdown.render(text)
  }

  /* ---------------------------------------------------------------- 目标概览 */

  function overviewBlock(view) {
    if (view.goal === null) {
      // 三种「没有目标」要求用户做的事完全不同，所以它们必须长得不一样。
      const isUnavailable = view.goalState === 'unavailable'
      const isInvalid = view.goalState === 'invalid'
      const title = isInvalid ? '会话标识不合法' : isUnavailable ? '运行时目标读不到' : '这个会话还没有目标'
      const body = isInvalid
        ? '页面拿到的会话标识不合法，这是页面这边的 bug，不是你的数据有问题。'
        : isUnavailable
          ? '这个会话没有加载在本进程里，所以读不到它的运行时目标。在左侧打开这个会话后回到这里，目标就会出现。下面的计划是这个会话上次留下的记录。'
          : '这里还没有目标。长任务需要一个目标才有「什么时候算完成」可言 —— 你可以直接在这里建一个，也可以让 Agent 在对话里建。'
      // 「建目标」是这一页**唯一**能把目标带进存在的入口，所以它在这里，而不是只让用户去
      // 对话里求 Agent。以前没有这个按钮，于是唯一的路是 DSH 内置的 create_goal 工具 —— 控制台
      // 就成了一个看板，而不是控制面。
      const actions = LZ.Card.btnBar([
        { label: '建立目标', variant: 'btnSmall btnPrimary', id: 'goalCreate' },
        { label: '刷新', id: 'goalRefresh' },
      ])
      return LZ.Card.card({
        title: '目标概览',
        count: '没有运行时目标',
        body: LZ.EmptyState.empty({ title: title, body: body, action: actions }) +
          (view.goalReason === '' ? '' : LZ.Card.callout('warn', view.goalReason)),
      })
    }

    const goal = view.goal
    const progress = LZ.GoalService.progressOf(view)

    const head =
      '<div class="badgeRow">' +
      LZ.StatusBadge.fromStatus(goal.phase) +
      badge(goal.activation === 'armed' ? 'running' : 'idle', goal.activation === 'armed' ? '续行已启用' : '续行未启用') +
      LZ.StatusBadge.fromStatus(view.health) +
      '</div>'

    // 卡片最上面是**概览目标**（Agent 写的一段话），它顶掉的是原来那份目标全文引用块。
    // 原文一个字都没删：完整的那份在「完整计划」视窗的第 1 节里，那里是「看全文」该去的地方，
    // 而这张卡是抬头看一眼。
    const summary = goalSummaryBlock(view)
    const expected = expectedOutputBlock(view)

    // 卡片头**不再重复阶段**。
    //
    // 截图里「进行中」出现过三次：卡片头的 count、徽标行里的阶段徽标、以及 kv 的「当前阶段」。
    // 同一个词说三遍只增加噪音，还让人去找它们之间的差别（用户早前的截图投诉过同一类：
    // 并排两个一模一样的胶囊）。阶段留在徽标上——它带图标与颜色，是三者里唯一多给了信息的那个。
    const meta = LZ.Card.kv([
      { label: '修订', value: 'r' + goal.revision },
      { label: '轮次', value: goal.roundsStarted + ' / ' + goal.maxGoalRounds },
      { label: '完成度', value: view.counts.acceptance.done + ' / ' + view.counts.acceptance.total + ' 条验收标准已验证' },
    ])

    const blocked = goal.blockedReason === null ? '' : LZ.Card.callout('error',
      goal.blockedReason.code + ' —— ' + goal.blockedReason.message)

    return LZ.Card.card({
      title: '目标概览',
      // 这三个动作搬到了**抬头**。
      //
      // 它们原来是正文的最后一行。正文现在是一个可滚动的面（卡片等高之后必然如此），而
      // 「完整计划」是这张卡的主入口 —— 一个要滚到底才看得见的入口，等于没有入口。
      // 这不是推测，是真鼠标点出来的：`test-goal-live-frame` 用
      // `Input.dispatchMouseEvent` 点 `[data-viewer="plan"]`，视窗没打开，因为那个坐标上
      // 现在盖着卡片本身（命中测试落到卡片，不是按钮）。
      //
      // 顺带把那个 `{ spacer: true }` 去掉了：抬头本来就有自己的 `.spacer`，再来一个会把
      // 按钮推到中间。动作属于抬头，正文属于内容。
      actions: LZ.Card.btnBar([
        // 生命周期按钮按**当前阶段**给，不给全部四个。
        //
        // 四个都摆出来会让用户去试哪个能用（点「恢复」而目标是 active 时只会拿到一个拒绝），
        // 而阶段机的规则属于 @deepseek-ai/dsh-goal，页面不该在按钮可见性上再写一遍它的判断。
        // 折中是：每个阶段只显示确定合法的那一个，非法组合根本不出现，因此也点不出错误。
        ...lifecycleButtons(goal, view),
        { label: '刷新', id: 'goalRefresh' },
        { label: '完整计划', attrs: 'data-viewer="plan" data-viewer-title="完整目标与计划"' },
        { label: '查看 goal.md', id: 'goalRawToggle', attrs: 'aria-expanded="' + String(LZ.App.isRawOpen()) + '"' },
      ]),
      body: head + summary + expected + meta + blocked,
    })
  }

  /**
   * The lifecycle control for the goal's current phase.
   *
   * One button, chosen by phase — see the note at the call site for why not all four.
   * `complete` is only offered when the completion gate would actually allow it: the gate is
   * the whole point of this system, and a button that is guaranteed to be refused teaches the
   * user that the gate is noise.
   */
  function lifecycleButtons(goal, view) {
    if (goal === null || goal === undefined) return [{ label: '建立目标', variant: 'btnSmall btnPrimary', id: 'goalCreate' }]
    switch (goal.phase) {
      case 'active':
        return [
          { label: '暂停', id: 'goalPause' },
          ...(view.completionAllowed === true
            ? [{ label: '标记完成', variant: 'btnSmall btnPrimary', id: 'goalComplete' }]
            : []),
        ]
      case 'paused':
      case 'blocked':
        return [{ label: '恢复', variant: 'btnSmall btnPrimary', id: 'goalResume' }]
      case 'complete':
        // A completed goal cannot be resumed (the service refuses it) — it must be cleared or
        // replaced. Saying so is more useful than a disabled button nobody can explain.
        return [{ label: '新建目标（替换已完成的）', id: 'goalCreate' }]
      default:
        return []
    }
  }

  /* ---------------------------------------------------------------- 当前执行状态 */

  function focusBlock(view) {
    if (view.delivery === null) return ''
    const progress = LZ.GoalService.progressOf(view)
    const body =
      '<div class="stack">' +
      '<div><div class="metricLabel">当前正在处理</div>' +
      '<div class="focusBox" data-empty="' + String(progress.current === '') + '">' +
      esc(progress.current === '' ? '还没有声明当前焦点' : progress.current) + '</div></div>' +
      '<div><div class="metricLabel">下一步</div>' +
      (progress.next === '' ? LZ.EmptyState.line('还没有写下下一步。') :
        '<ol class="nextList">' + progress.next.split('；').map(function (item) {
          return '<li>' + esc(item) + '</li>'
        }).join('') + '</ol>') +
      '</div>' +
      '<div><div class="metricLabel">是否已经完成</div>' +
      LZ.Card.callout(progress.done ? 'ok' : 'warn', progress.doneReason) +
      '</div>' +
      (progress.why === '' ? '' :
        '<div><div class="metricLabel">为什么这样执行</div>' +
        '<p class="cardSub" style="margin:0">' + esc(progress.why) + '</p></div>') +
      '</div>'
    return LZ.Card.card({ title: '当前执行状态', body: body })
  }

  /* ---------------------------------------------------------------- 验收标准 */

  function acceptanceBlock(view) {
    if (view.delivery === null) return ''
    const rows = view.delivery.acceptance
    const counts = view.counts.acceptance

    if (rows.length === 0) {
      return LZ.Card.card({
        title: '验收标准',
        count: '0 条',
        body: LZ.EmptyState.empty({
          title: '还没有定义验收标准',
          body: '没有它，「做完了」就只是一句话。验收标准由 Agent 通过 goal_delivery 工具记录，' +
            '也可以由你在对话里直接要求它记下来。',
        }),
      })
    }

    // 任务状态列表，不是普通表格：一行一条，前面一个勾/圈，扫一眼读完。
    const body = '<ul class="checkList">' + rows.map(function (row) {
      const sub = []
      if (row.evidence.length > 0) sub.push('证据 ' + row.evidence.join('、'))
      if (row.verifiedAt !== '') sub.push('验证于 ' + row.verifiedAt)
      return '<li class="checkItem" data-state="' + esc(row.state) + '">' +
        LZ.StatusBadge.checkMark(row.status) +
        '<div class="checkText">' +
        '<p class="rowText">' + esc(row.description) + '</p>' +
        (sub.length === 0 ? '' : '<p class="rowSub">' + esc(sub.join(' · ')) + '</p>') +
        '</div>' +
        '<div class="rowChips">' +
        (row.mandatory ? badge('waiting', '必须') : badge('idle', '可选')) +
        '</div>' +
        '</li>'
    }).join('') + '</ul>'

    const mandatoryLeft = counts.mandatory - counts.mandatoryDone
    const caption = mandatoryLeft > 0
      ? '必须的还差 ' + mandatoryLeft + ' 条'
      : counts.mandatory === 0 ? '没有标记为必须的条目' : '必须的全部已验证'

    return LZ.Card.card({
      title: '验收标准',
      count: counts.done + ' / ' + counts.total + ' 已验证 · ' + caption,
      // 进度条只在有明确分母时画。0 条时不画——一条空进度条会读成「一个都没做」，
      // 而真实含义是「还没有定义要做几件」。
      body: (counts.total === 0 ? '' : LZ.Progress.bar({
        label: '已验证比例',
        done: counts.done,
        total: counts.total,
        tone: mandatoryLeft === 0 ? 'success' : 'waiting',
      })) + body,
    })
  }

  /* ---------------------------------------------------------------- 任务拆解（树） */

  function taskBlock(view) {
    if (view.delivery === null) return ''
    const counts = view.counts.tasks
    return LZ.Card.card({
      id: 'goalTasks',
      title: '任务拆解',
      count: counts.total === 0 ? '0 个任务' : counts.done + ' / ' + counts.total + ' 已完成',
      sub: counts.total === 0 ? undefined : '按依赖关系排成树。点标题可展开收起。',
      body: LZ.TreeView.tree(view.tree, { emptyText: '还没有拆解任务。' }),
    })
  }

  /* ---------------------------------------------------------------- 执行证据 */

  function evidenceBlock(view) {
    if (view.delivery === null) return ''
    const rows = view.delivery.evidence
    if (rows.length === 0) {
      return LZ.Card.card({
        title: '执行证据',
        count: '0 条',
        body: LZ.EmptyState.empty({
          title: '还没有记录证据',
          body: '完成状态要靠证据支撑，而不是靠声明。测试结果、文件改动、运行输出都可以作为证据记录。',
        }),
      })
    }

    const body = '<ul class="rows">' + rows.map(function (row) {
      // 这条证据支撑了哪几条验收标准——由 goal-service 的视图模型给出反查结果。
      const targets = view.delivery.acceptance.filter(function (row2) {
        return row2.evidence.indexOf(row.id) !== -1
      }).map(function (row2) { return row2.id })
      const sub = []
      if (row.detail !== '') sub.push(row.detail)
      if (row.ref !== '') sub.push(row.ref)
      sub.push(targets.length > 0 ? '支撑 ' + targets.join('、') : '未关联到验收标准')
      return '<li class="row">' +
        '<span class="rowId">' + esc(row.id) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(row.summary) + '</p>' +
        '<p class="rowSub">' + esc(sub.join(' · ')) + '</p></div>' +
        '<div class="rowChips">' + badge('idle', row.kindLabel) +
        (row.at === '' ? '' : '<span class="segLabel">' + esc(row.at) + '</span>') +
        '</div></li>'
    }).join('') + '</ul>'
    return LZ.Card.card({ title: '执行证据', count: rows.length + ' 条', body: body })
  }

  /* ---------------------------------------------------------------- 决策记录 */

  function decisionBlock(view) {
    if (view.delivery === null || view.delivery.decisions.length === 0) return ''
    const body = '<ul class="rows">' + view.delivery.decisions.map(function (row) {
      const sub = []
      if (row.reason !== '') sub.push('原因：' + row.reason)
      if (row.alternatives !== '') sub.push('备选：' + row.alternatives)
      if (row.rejectedBecause !== '') sub.push('未采纳原因：' + row.rejectedBecause)
      return '<li class="row">' +
        '<span class="rowId">' + esc(row.id) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(row.decision) + '</p>' +
        (sub.length === 0 ? '' : '<p class="rowSub">' + esc(sub.join('；')) + '</p>') +
        '</div>' +
        (row.at === '' ? '' : '<div class="rowChips"><span class="segLabel">' + esc(row.at) + '</span></div>') +
        '</li>'
    }).join('') + '</ul>'
    return LZ.Card.card({ title: '决策记录', count: view.delivery.decisions.length + ' 条', body: body })
  }

  /* ---------------------------------------------------------------- 历史版本 */

  function historyBlock(view) {
    if (view.delivery === null || view.delivery.changes.length === 0) return ''
    const rows = view.delivery.changes.slice(-60).reverse()
    return LZ.Card.card({
      id: 'goalHistory',
      title: '历史版本',
      count: view.delivery.changes.length + ' 条变更' + (rows.length < view.delivery.changes.length ? '（显示最近 ' + rows.length + ' 条）' : ''),
      body: LZ.Timeline.timeline(rows.map(function (row) {
        return {
          time: row.at,
          text: row.action,
          sub: row.detail === '' ? row.actorLabel : row.actorLabel + ' · ' + row.detail,
          state: row.actor === 'human' ? 'running' : row.actor === 'agent' ? 'idle' : 'idle',
        }
      })),
    })
  }

  /* ---------------------------------------------------------------- 风险、范围、完整性 */

  function blockersBlock(view) {
    if (view.delivery === null || view.delivery.blockers.length === 0) return ''
    const open = view.delivery.blockers.filter(function (row) { return row.open }).length
    const body = '<ul class="rows">' + view.delivery.blockers.map(function (row) {
      const sub = [row.code]
      if (row.at !== '') sub.push('记录于 ' + row.at)
      if (row.resolvedAt !== '') sub.push('解决于 ' + row.resolvedAt)
      return '<li class="row">' +
        '<span class="rowId">' + esc(row.id) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(row.message) + '</p>' +
        '<p class="rowSub">' + esc(sub.join(' · ')) + '</p></div>' +
        '<div class="rowChips">' + LZ.StatusBadge.fromStatus(row.open ? 'open' : 'resolved') + '</div>' +
        '</li>'
    }).join('') + '</ul>'
    return LZ.Card.card({ title: '风险与阻塞', count: open + ' 项未解决', body: body })
  }

  function scopeBlock(view) {
    if (view.delivery === null) return ''
    const scope = view.delivery.scope
    const list = function (items, emptyText) {
      if (items.length === 0) return LZ.EmptyState.line(emptyText)
      return '<ul class="nextList">' + items.map(function (item) { return '<li>' + esc(item) + '</li>' }).join('') + '</ul>'
    }
    const body =
      '<div class="stack">' +
      '<div><div class="metricLabel">包含</div>' + list(scope.included, '还没有写下范围。') + '</div>' +
      '<div><div class="metricLabel">不包含</div>' + list(scope.excluded, '还没有写下不做什么——范围蔓延通常就出在这里。') + '</div>' +
      '<div><div class="metricLabel">约束条件</div>' + list(view.delivery.constraints, '还没有写下约束。') + '</div>' +
      '</div>'
    return LZ.Card.card({ title: '范围与约束', body: body })
  }

  function proposalsBlock(view) {
    if (view.delivery === null) return ''
    const pending = view.delivery.proposals.filter(function (row) { return row.pending })
    if (pending.length === 0) return ''
    const body = pending.map(function (row) {
      return '<div class="proposal">' +
        '<div class="inlineRow">' + badge('waiting', '待确认') +
        '<span class="rowId">' + esc(row.id) + '</span>' +
        '<span class="segLabel">字段 ' + esc(row.field) + (row.target === '' ? '' : ' · ' + esc(row.target)) + '</span>' +
        '</div>' +
        '<p class="rowText">' + esc(row.proposed) + '</p>' +
        (row.current === '' ? '' : '<p class="rowSub">当前：' + esc(row.current) + '</p>') +
        (row.reason === '' ? '' : '<p class="rowSub">原因：' + esc(row.reason) + '</p>') +
        (row.impact === '' ? '' : '<p class="rowSub">影响：' + esc(row.impact) + '</p>') +
        LZ.Card.btnBar([
          { label: '采纳', variant: 'btnSmall btnPrimary', attrs: 'data-proposal="' + esc(row.id) + '" data-proposal-op="adoptProposal"' },
          { label: '不采纳', variant: 'btnSmall', attrs: 'data-proposal="' + esc(row.id) + '" data-proposal-op="rejectProposal"' },
        ]) +
        '</div>'
    }).join('')
    return LZ.Card.card({
      id: 'goalProposals',
      title: '变更提案',
      count: pending.length + ' 项待确认',
      // 这一句是这次改动里最要紧的：**主通道换了**。
      //
      // 用户的原话是「静默且异步地展示在控制台内」—— 提案躺在这里等，他不主动翻就永远
      // 不知道有人在等他拍板。现在 Agent 会在对话里就地问（宿主一旦检测到 pending 提案，
      // 就会要求它调 ask_user_question，而那个工具的选项会渲染成按钮），这里降级成兜底。
      //
      // 兜底**不删**：模型可能没问、用户可能划过去了。删掉它等于把「采纳」这条人类权威
      // 通道挂在一个可能不发生的动作上 —— 而 §65 说采纳是人类独有的权力，那它就不该有单点。
      sub: 'Agent 会在对话里就地问你（主通道）。这一份是兜底：万一它没问，或你翻过去了，直接在这里点。',
      body: body,
    })
  }

  /**
   * 还缺什么：三个必填项各自的状态。
   *
   * 门（`tools/pre-execute`）在必填项没齐时拒掉一切工具；这一块是**把那件事说出来**，
   * 让人在页面上看到「为什么动不了、要补哪一项」。三态各有各的意思：
   * 还没有 / 提了等你确认 / 有了——把「提了等你确认」画成「缺」是最容易犯的错，
   * 那会让用户以为 Agent 没干活，而实际上它在等他。
   */
  function readinessBlock(view) {
    const readiness = view.readiness
    if (readiness === null || readiness === undefined) return ''
    // 齐了就一行都不要——页面已经够长，而「没事」不需要版面。
    if (readiness.ready && readiness.fields.every(function (row) { return row.state === 'settled' })) return ''

    const labels = { missing: '还没有', proposed: '等你确认', settled: '有了' }
    const tones = { missing: 'blocked', proposed: 'waiting', settled: 'success' }
    const body = readiness.fields.map(function (row) {
      return '<div class="inlineRow">' + badge(tones[row.state], labels[row.state]) +
        '<span class="rowId">' + esc(row.name) + '</span>' +
        (row.detail === '' ? '' : '<span class="segLabel">' + esc(row.detail) + '</span>') +
        '</div>'
    }).join('')

    return LZ.Card.card({
      title: '还缺什么',
      count: readiness.missing.length === 0 ? '齐了，可以动手' : readiness.missing.length + ' 项还没有',
      sub: '这几项没齐之前，Agent 的工具调用会被拒——不是故障，是启动协议。' +
        '「等你确认」的算已经答过，它不会卡在那里等你。' +
        '「概览目标」和「预期产出」是仅有的两格不需要你批的：Agent 自己写一段话就完了 ——' +
        ' 但它们不写就一直缺着。',
      body: body,
    })
  }

  /**
   * 状态链：本轮的两条分支各答了什么。
   *
   * 为什么值得一行版面：用户要的是「每次对话都要执行状态链（动态追踪 Agent 进度）」，而
   * 「有没有真的在走」是这条需求里唯一可核对的部分。看不见的判断等于没有判断 —— 一个从不
   * 出现在页面上的门，和没有门在用户眼里是一样的。
   *
   * 「还没判断」照实说。新一轮刚开头时它就是 null，把它画成「未命中」是在替 Agent 说一句
   * 它没说过的话。
   */
  function chainLine(view) {
    const chain = view.delivery.chain
    if (chain === null || chain === undefined) return ''

    // 括号里那截是解释，塞进格子会撑破 —— 标题取短的，完整的一句挂到 SVG 的 title 上。
    const short = function (label) { return String(label === undefined ? '' : label).split('（')[0] }
    const tone = function (value) {
      if (value === 'matched' || value === 'hit') return 'success'
      if (value === 'none') return 'idle'
      return 'waiting'
    }

    // 第三个格子的状态：**按 host 的门序推**（链 → 目标 → 技能），判据全部来自宿主已经算好的
    // 投影 —— chain.judged 是状态链自己的字段，view.readiness 是「还缺什么」用的同一个
    // （host 的 missingGoalFields），技能的登记数来自 delivery.skills。
    //
    // 这一层**不发明规则**（§P8：GUI 只是投影）。顺序尤其不能自己排：图上写「放行」而工具
    // 那边被拒，用户就没有可信的东西可看了。查不出来就说「等」，绝不猜一个好看的颜色。
    const skills = view.delivery.skills || []
    const readiness = view.readiness
    const tool = (function () {
      if (!chain.judged) return { state: 'waiting', text: '等状态链' }
      if (readiness !== null && readiness !== undefined && readiness.ready !== true) {
        const n = (readiness.missing || []).length
        return { state: 'blocked', text: '拦住 · 目标缺 ' + n + ' 项' }
      }
      if (chain.skillCheck === 'hit' && skills.length === 0) return { state: 'blocked', text: '拦住 · 技能未登记' }
      return { state: 'success', text: '放行' }
    })()

    const node = function (x, index, title, state, text, full) {
      return '<g class="chainNode" data-state="' + state + '">' +
        '<title>' + esc(full) + '</title>' +
        '<rect class="chainBox" x="' + x + '" y="8" width="212" height="60" rx="8"/>' +
        '<circle class="chainDot" cx="' + (x + 20) + '" cy="28" r="5"/>' +
        '<text class="chainLabel" x="' + (x + 34) + '" y="33">' + esc(index + ' ' + title) + '</text>' +
        '<text class="chainValue" x="' + (x + 20) + '" y="54">' + esc(text) + '</text>' +
        '</g>'
    }
    const arrow = function (x) {
      return '<line class="chainEdge" x1="' + x + '" y1="38" x2="' + (x + 28) + '" y2="38"/>' +
        '<path class="chainHead" d="M' + (x + 28) + ' 38 l-7 -4 v8 z"/>'
    }

    const label = '执行链：目标分支 ' + chain.goalLabel + '；技能分支 ' + chain.skillLabel + '；工具' + tool.text
    const svg =
      '<svg class="chainSvg" viewBox="0 0 720 76" width="100%" height="76" role="img" ' +
      'aria-label="' + esc(label) + '">' +
      node(0, '①', '目标分支', tone(chain.goalMatch), short(chain.goalLabel), chain.goalLabel) +
      arrow(212) +
      node(254, '②', '技能分支', tone(chain.skillCheck), short(chain.skillLabel), chain.skillLabel) +
      arrow(466) +
      node(508, '③', '工具放行', tool.state, tool.text, '按 host 的门序：状态链 → 目标 → 技能') +
      '</svg>'

    return '<div class="driftLine" data-chain="' + (chain.judged ? 'judged' : 'pending') + '">' +
      svg +
      '<p class="rowSub" style="margin:var(--lz-space-xxs) 0 0">' +
      (chain.at === '' ? '本轮还没判断' : '判断于 ' + esc(chain.at)) +
      '</p>' +
      '</div>'
  }

  /**
   * 激活技能清单：Agent 读完某份 skill 的**完整正文**之后登记的那几条。
   *
   * 四项都是必填（名称 / 描述 / 本次作用 / 来源），因为缺任何一项，这条记录都答不出
   * 「为什么这一轮要用它」。渲染时也照这四项来：把「本次任务的作用」和「技能描述」分开显示，
   * 是因为它们回答的是两个问题 —— 一个是它是什么，一个是它在这里做什么。
   */
  function skillBlock(view) {
    const skills = view.delivery.skills || []
    const hit = view.delivery.chain !== null && view.delivery.chain !== undefined && view.delivery.chain.skillCheck === 'hit'
    if (skills.length === 0 && !hit) return ''

    const body = skills.length === 0
      ? '<p class="rowSub">本轮答了「命中技能清单」，但还没有登记任何技能。' +
        '登记之前，Agent 的工作类工具会被拒 —— 这一条是核对用的，所以它不能只是一句话。</p>'
      : '<ul class="rows">' + skills.map(function (row) {
        return '<li class="row">' +
          '<span class="rowId">' + esc(row.id) + '</span>' +
          '<div class="rowBody">' +
            '<p class="rowText">' + esc(row.name) + '</p>' +
            '<p class="rowSub">' + esc(row.description) + '</p>' +
            '<p class="rowText">本次作用：' + esc(row.purpose) + '</p>' +
            '<p class="rowSub">' + (row.isLink
              ? '<a class="link" href="' + esc(row.source) + '" target="_blank" rel="noreferrer noopener">' + esc(row.source) + '</a>'
              : '<code>' + esc(row.source) + '</code>') +
              (row.at === '' ? '' : ' · ' + esc(row.at)) + '</p>' +
          '</div>' +
          '</li>'
      }).join('') + '</ul>'

    return LZ.Card.card({
      id: 'goalSkills',
      title: '激活技能清单',
      count: skills.length === 0 ? '一条都没有' : skills.length + ' 项',
      sub: '由 Agent 实际读完某份 skill 的完整正文后填写。每轮只注入技能名称与来源，正文不注入 ——' +
        '所以来源要能让人自己去读全文。',
      body: body,
    })
  }

  function integrityBlock(view) {
    const integrity = view.integrity
    if (integrity === null || integrity === undefined) return ''
    const errors = integrity.errors || []
    const warnings = integrity.warnings || []
    if (errors.length === 0 && warnings.length === 0) {
      return LZ.Card.card({
        id: 'goalIntegrity',
        title: '完整性检查',
        count: '通过',
        body: '<p class="cardSub" style="margin:0">目标、验收标准、任务依赖与证据引用都成立。</p>',
      })
    }
    const render = function (rows, state, label) {
      return '<ul class="rows">' + rows.map(function (row) {
        return '<li class="row">' +
          '<span class="rowId">' + esc(String(row.code).replace(/^GOAL_/, '')) + '</span>' +
          '<div class="rowBody"><p class="rowText">' + esc(row.detail) + '</p>' +
          '<p class="rowSub">对象 ' + esc(row.target) + '</p></div>' +
          '<div class="rowChips">' + badge(state, label) + '</div></li>'
      }).join('') + '</ul>'
    }
    return LZ.Card.card({
      id: 'goalIntegrity',
      title: '完整性检查',
      count: errors.length + ' 项需修复 · ' + warnings.length + ' 项提示',
      body: (errors.length > 0 ? render(errors, 'blocked', '需修复') : '') +
        (warnings.length > 0 ? render(warnings, 'waiting', '提示') : ''),
    })
  }

  /**
   * 同步状态：计划与当前目标是否还一致。
   *
   * 原来这里是一张整宽卡片，标题「目标已变化」，副标题三行、正文两行加一个按钮——
   * 占掉的版面比它承载的信息多得多。而它想说的只有一句话：**这份计划是在目标还是另一个
   * 样子的时候写的**。所以它现在是一行。
   *
   * 降级不等于藏起来（§35 的离散状态）：不一致**必须**看得见，只是不该用一整张卡片去喊。
   * 只有「需要对账」那一种带动作——因为只有它需要用户做决定。
   */
  function driftLine(view) {
    const drift = view.drift
    // 一致时也给一行。原来一致就什么都不显示，于是「没看见」与「一致」在页面上长得一样——
    // 而这两件事对用户的意义完全不同（一个是「没问题」，一个是「没检查」）。
    if (drift === null || drift === undefined) {
      return '<p class="driftLine" data-drift="synced">' +
        LZ.StatusBadge.fromStatus('success') + '<span>计划与当前目标一致</span></p>'
    }
    const fields = Array.isArray(drift.fields) ? drift.fields.join('、') : ''
    const before = drift.before.objective === undefined ? '修订 ' + drift.before.revision : String(drift.before.objective).slice(0, 100)
    const after = drift.after.objective === undefined ? '修订 ' + drift.after.revision : String(drift.after.objective).slice(0, 100)
    return '<div class="driftLine" data-drift="drifted">' +
      '<p class="driftText">' + LZ.StatusBadge.fromStatus('waiting') +
      '<span>计划写在目标还是另一个样子的时候（' + esc(fields) + ' 变了）——先对账再往下做。</span></p>' +
      '<p class="rowSub">原：' + esc(before) + '<br>现：' + esc(after) + '</p>' +
      LZ.Card.btnBar([{ label: '对齐到当前目标', variant: 'btnSmall btnPrimary', id: 'goalReconcile' }]) +
      '</div>'
  }

  /** goal.md 投影：开关、立即写入、与状态是否一致。 */
  function artifactBlock(view) {
    const artifact = view.artifact
    if (artifact === null || artifact === undefined) return ''
    const head = artifact.enabled
      ? LZ.StatusBadge.fromStatus(artifact.stale ? 'blocked' : 'success')
      : badge('idle', '未开启')

    if (!artifact.enabled) {
      return LZ.Card.card({
        title: 'goal.md 投影',
        count: '未开启',
        body: LZ.EmptyState.empty({
          title: '还没有把这个目标写成文件',
          body: '开启后，每次打开这一页都会把当前目标与计划写成 ' + view.artifactPath +
            '，放在这个会话的工作目录里。它是一份可读、可提交、可 review 的投影——' +
            '运行时状态仍然是唯一权威，这个文件只是它的渲染结果。',
          action: LZ.Card.btnBar([
            { label: '落点：' + (artifact.cwd === null ? '未知（会话没有工作目录）' : artifact.cwd), variant: 'btnText', disabled: true },
            { label: '在项目里写 goal.md', variant: 'btnSmall btnPrimary', id: 'goalArtifactOn' },
          ]),
        }),
      })
    }

    const lines = []
    lines.push('<p class="cardSub" style="margin:0">' + (artifact.exists
      ? '文件在 ' + esc(artifact.path || view.artifactPath) + '，' + artifact.bytes + ' 字节' +
        (artifact.mtime === null ? '' : '，最后写入 ' + LZ.GoalService.stamp(artifact.mtime))
      : '还没有写入过。' + esc(String(artifact.path || view.artifactPath)) + ' 会在下次刷新时建立。') + '</p>')
    if (artifact.stale) {
      lines.push(LZ.Card.callout('warn', '文件内容与当前状态不一致——多半是状态在上次写入之后又改过。刷新即可重新投影。'))
    }
    lines.push(LZ.Card.btnBar([
      { label: '立即写入', id: 'goalArtifactWrite' },
      { spacer: true },
      { label: '关闭', variant: 'btnSmall btnDanger', id: 'goalArtifactOff' },
    ]))
    return LZ.Card.card({ title: 'goal.md 投影', count: artifact.stale ? '与状态不一致' : '与状态一致', body: head + lines.join('') })
  }

  /** goal.md 原文：折叠区，只在展开时取。 */
  function rawBlock(view) {
    if (!LZ.App.isRawOpen()) return ''
    const state = LZ.App.rawState()
    const body = state.loading
      ? LZ.Card.skeleton('100%', '200px')
      : state.text === null
        ? LZ.EmptyState.line('还没有 goal.md。先在上面开启，或点「立即写入」。')
        : '<pre class="rawView">' + esc(state.text) + '</pre>'
    return LZ.Card.card({
      title: 'goal.md 原文',
      count: '只在展开时读取',
      sub: '这是一份只读投影，不是权威状态——改它不会改变目标。',
      body: body,
    })
  }

  /* ---------------------------------------------------------------- 折进来的两页 */

  /**
   * 执行状态：当前轮次、生命周期、工具调用、上下文。
   *
   * **渲染函数是从 `pages/runtime.js` 原样调的**，不是抄了一份。这一条是这次整合里最要紧的
   * 决定：抄一份意味着两处排版要各自维护，而它们迟早会漂成两个样子；调同一个函数则
   * 「删掉入口」与「内容还在」是同一份代码保证的。
   *
   * 状态与失败**各自分开**：执行状态读不到时只说执行状态读不到，上面那几张目标卡片照常显示。
   * 用一个总状态表示会让「日志读不出来」显示成「目标读不出来」——那是对用户数据的错误陈述。
   */
  function executionSection(state) {
    return LZ.RuntimePage.render({
      tab: 'runtime',
      status: state.runtimeStatus,
      elapsed: state.runtimeStatus === 'loading' ? state.elapsed : undefined,
      detail: state.runtimeDetail,
      view: state.runtimeView,
    })
  }

  /** Agent 配置：身份、行为策略、工具能力、上下文策略、名单。同上，调原函数。 */
  function agentSection(state) {
    return LZ.AgentPage.render({
      tab: 'agent',
      // 这一页的加载态跟随 preset：名单与提示词来自预设存储。
      status: state.presetStatus === 'loading' ? 'loading' : state.presetStatus,
      elapsed: state.presetStatus === 'loading' ? state.elapsed : undefined,
      detail: state.presetDetail,
      view: state.presetView,
    })
  }

  /* ---------------------------------------------------------------- 组装 */

  /**
   * 渲染整个目标中心。
   *
   * 顺序即优先级：概览 → 当前状态 → 需要用户决定的事（提案 / 漂移）→ 验收 → 任务 →
   * 证据 → 决策 → 历史 → 风险 → 范围 → 完整性 → 产物 → 原文。
   * 「需要用户决定」排在验收之前，因为一个待确认的提案会改变验收标准本身。
   */
  function render(state) {
    if (state.status === 'idle' || state.status === 'loading') {
      return LZ.EmptyState.loading('正在读取目标状态…', state.elapsed)
    }
    if (state.status === 'error') {
      return LZ.EmptyState.blocked({
        title: '目标状态读不出来',
        body: '可以从头再读一次。如果一直读不出来，多半是宿主半还需要重启 DSH 才生效。',
        detail: state.detail,
        action: LZ.Card.btnBar([{ label: '重试', id: 'goalRetry' }]),
      })
    }

    const view = state.view
    if (view === null) return LZ.EmptyState.blocked({ title: '目标状态为空', body: '宿主没有返回任何内容。' })

    if (view.ok !== true) {
      // 「计划文件坏了」与「没有计划」是两件事，页面必须说出是哪一件。
      return LZ.EmptyState.blocked({
        title: '目标状态读不出来',
        body: view.reason || '目标状态读不出来。',
        detail: view.detail,
        action: LZ.Card.btnBar([{ label: '重试', id: 'goalRetry' }]),
      })
    }

    // 分区。这一页原来一次铺十几张卡，用户直接提过「太长」——而长的代价是**找不到东西**：
    // 想知道「下一步是什么」要滚过验收标准、任务树、证据、决策、历史……
    //
    // 分成四段之后，一屏只回答一类问题：
    //   概览  现在什么状态、为什么动不了
    //   计划  要做成什么、被拆成了什么
    //   证据  凭什么说做到了
    //   记录  一路上变过什么
    //
    // 默认停在「概览」：那是打开这一页最常问的问题。分区的状态存在 app 的 state 里，
    // 因为页面每次数据回来都会重渲染 —— 存在 DOM 上会在第一次轮询之后丢掉。
    const section = LZ.App.goalSection()
    const groups = {
      overview: [
        overviewBlock(view),
        readinessBlock(view),
        driftLine(view),
        chainLine(view),
        skillBlock(view),
        proposalsBlock(view),
        focusBlock(view),
      ],
      plan: [
        '<div class="grid" data-cols="2">' +
          '<div class="stack">' + acceptanceBlock(view) + taskBlock(view) + '</div>' +
          '<div class="stack">' + scopeBlock(view) + '</div>' +
          '</div>',
      ],
      evidence: [
        evidenceBlock(view),
        decisionBlock(view),
        blockersBlock(view),
        integrityBlock(view),
      ],
      record: [
        historyBlock(view),
        artifactBlock(view),
        rawBlock(view),
      ],
      // 折进来的两页。它们吃的是**同一份投影**（state），不是 view——目标中心的 view 是
      // 目标的视图模型，而执行状态与 Agent 配置各有自己的视图模型。硬把它们塞进一个 view
      // 会让三个领域的状态混成一个形状，那正是 services/ 分层要避免的。
      execution: [executionSection(state)],
      agent: [agentSection(state)],
    }

    // 分区条。复用按钮组，不新造控件 —— 一个页面里出现第二种「切换」的视觉语言，
    // 读的人就得先学会两套规则。
    //
    // 六个分区用胶囊条仍然放得下（窄屏会折行，见 .btnBar 的 flex-wrap），所以这次没有
    // 为了多两格去换控件。
    const nav = LZ.Card.btnBar(GOAL_SECTIONS.map(function (pair) {
      return {
        label: pair[1],
        variant: pair[0] === section ? 'btnSmall btnPrimary' : 'btnSmall',
        attrs: 'data-goalsection="' + pair[0] + '" aria-pressed="' + String(pair[0] === section) + '"',
      }
    }))

    const body = (groups[section] === undefined ? groups.overview : groups[section]).join('')
    const warnings = view.warnings.length > 0
      ? LZ.Card.card({
        title: '读取提示',
        count: view.warnings.length + ' 条',
        body: '<ul class="nextList">' + view.warnings.map(function (warning) {
          return '<li>' + esc(warning) + '</li>'
        }).join('') + '</ul>',
      })
      : ''

    return nav + body + warnings
  }

  LZ.GoalPage = { render: render }
})(window.LZ = window.LZ || {})
