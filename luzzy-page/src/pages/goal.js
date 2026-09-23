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
          : '让 Agent 开始一个长任务，它会建立一个目标；你也可以在输入框里直接说「把这件事做成一个目标」。'
      const actions = LZ.Card.btnBar([{ label: '刷新', id: 'goalRefresh' }])
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

    const objective = LZ.Format.objectiveText(goal.objective)

    const meta = LZ.Card.kv([
      { label: '当前阶段', value: goal.phaseLabel },
      { label: '修订', value: 'r' + goal.revision },
      { label: '轮次', value: goal.roundsStarted + ' / ' + goal.maxGoalRounds },
      { label: '完成度', value: view.counts.acceptance.done + ' / ' + view.counts.acceptance.total + ' 条验收标准已验证' },
    ])

    const blocked = goal.blockedReason === null ? '' : LZ.Card.callout('error',
      goal.blockedReason.code + ' —— ' + goal.blockedReason.message)

    return LZ.Card.card({
      title: '目标概览',
      count: goal.phaseLabel,
      body: head + objective + meta + blocked +
        LZ.Card.btnBar([
          { label: '刷新', id: 'goalRefresh' },
          { spacer: true },
          { label: '查看 goal.md', id: 'goalRawToggle', attrs: 'aria-expanded="' + String(LZ.App.isRawOpen()) + '"' },
        ]),
    })
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
      title: '变更提案',
      count: pending.length + ' 项待确认',
      sub: 'Agent 不能自己改目标、范围、约束和必须满足的验收标准——它只能提出来，由你决定。',
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
      sub: '这三项没齐之前，Agent 的工具调用会被拒——不是故障，是启动协议。' +
        '「等你确认」的算已经答过，它不会卡在那里等你。',
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

    const parts = [
      overviewBlock(view),
      readinessBlock(view),
      driftLine(view),
      proposalsBlock(view),
      focusBlock(view),
      '<div class="grid" data-cols="2">' +
        '<div class="stack">' + acceptanceBlock(view) + taskBlock(view) + '</div>' +
        '<div class="stack">' + evidenceBlock(view) + '</div>' +
        '</div>',
      decisionBlock(view),
      historyBlock(view),
      '<div class="grid" data-cols="2">' +
        '<div class="stack">' + blockersBlock(view) + scopeBlock(view) + '</div>' +
        '<div class="stack">' + integrityBlock(view) + '</div>' +
        '</div>',
      artifactBlock(view),
      rawBlock(view),
      (view.warnings.length > 0
        ? LZ.Card.card({
          title: '读取提示',
          count: view.warnings.length + ' 条',
          body: '<ul class="nextList">' + view.warnings.map(function (warning) {
            return '<li>' + esc(warning) + '</li>'
          }).join('') + '</ul>',
        })
        : ''),
    ]
    return parts.join('')
  }

  LZ.GoalPage = { render: render }
})(window.LZ = window.LZ || {})
