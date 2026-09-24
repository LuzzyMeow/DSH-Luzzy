/* goal-service —— 目标数据层：把后端载荷转成**视图模型**。
 *
 * 这一层存在的唯一理由
 * --------------------
 * 页面不许直接解析后端字段。曾经 `renderGoal()` 直接读 `snapshot.delivery.acceptance[].status`
 * 之类的原始结构，于是后端一改字段，四个页面全都要跟着改；也没法对页面做替换测试。
 *
 * 现在的分工是硬的：
 *   services/  知道后端长什么样（字段名、状态枚举、引用关系、时间戳格式）
 *   pages/     只知道视图模型长什么样（标题、状态、进度、列表、时间线）
 *
 * 于是页面可以对着一个手写的视图模型渲染并断言，不必造一份假的宿主响应。
 *
 * **状态映射也算数据层的事**：「pending 意味着什么」是语义，不是排版。
 * 页面只拿到 `state: 'idle' | 'running' | …` 与已经算好的 `label`。
 *
 * 关于 goal.md
 * ------------
 * 这里**不解析 markdown**。`goal.md` 是投影（由宿主半用确定性渲染器写出），
 * 页面只把它的原文当**文本**展示在折叠区里，不从中提取任何字段——
 * 「展示层与解析层分开」这条纪律的意义在于：markdown 的排版变化不该能改变页面上的数字。
 */
(function (LZ) {
  'use strict'

  /** 证据类型的显示名。后端给的是 kind 枚举，页面要的是词。 */
  const EVIDENCE_KIND_LABEL = {
    test: '测试',
    command: '命令',
    file: '文件',
    runtime: '运行结果',
    screenshot: '截图',
    user_confirmation: '用户确认',
    external: '外部来源',
  }

  /** 变更来源的显示名。 */
  const ACTOR_LABEL = { human: '用户', agent: 'Agent', system: '系统' }

  const HEALTH_LABEL = {
    healthy: '正常',
    'needs-attention': '需要注意',
    blocked: '已阻塞',
    verifying: '待验证',
    completed: '已完成',
  }

  /**
   * 状态链两条分支的显示名。
   *
   * 「还没判断」不是一个错误状态 —— 新一轮刚开头时它就是 null。把它显示成「未命中」是在替
   * Agent 说一句它没说过的话。
   */
  const CHAIN_GOAL_LABEL = { matched: '命中（在推进一个长期目标）', none: '未命中（本轮不是长期任务）' }
  const CHAIN_SKILL_LABEL = { hit: '命中（按技能清单执行）', none: '未命中（本轮不按技能清单）' }

  /** 把毫秒时间戳格式化成可读的时间。
   *
   * 显示口径是**本地时间**：日志里是毫秒，用户看的是墙上时钟。
   * 同一天只显示时分，否则带日期——时间线上混着好几天时，光有时分会读错。 */
  function stamp(ms, now) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return ''
    const at = new Date(ms)
    const today = new Date(now === undefined ? Date.now() : now)
    const pad = function (value) { return String(value).padStart(2, '0') }
    const time = pad(at.getHours()) + ':' + pad(at.getMinutes())
    const sameDay = at.getFullYear() === today.getFullYear() &&
      at.getMonth() === today.getMonth() &&
      at.getDate() === today.getDate()
    if (sameDay) return time
    return (at.getMonth() + 1) + '/' + at.getDate() + ' ' + time
  }

  /** 只取日期部分，用于历史记录这类密集列表。 */
  function dayStamp(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return ''
    const at = new Date(ms)
    const pad = function (value) { return String(value).padStart(2, '0') }
    return (at.getMonth() + 1) + '/' + at.getDate() + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
  }

  /**
   * 把一份交付计划转成视图模型。
   *
   * @param {object} delivery 后端 `snapshot.delivery`
   * @returns {object} 视图模型
   */
  function deliveryToView(delivery, now) {
    const acceptance = (delivery.acceptance || []).map(function (row) {
      return {
        id: row.id,
        description: row.description,
        status: row.status,
        state: LZ.StatusBadge.toneOf(row.status),
        mandatory: row.mandatory === true,
        evidence: (row.evidence || []).slice(),
        verifiedAt: row.verifiedAt === null ? '' : stamp(row.verifiedAt, now),
        done: row.status === 'verified',
      }
    })

    const tasks = (delivery.tasks || []).map(function (row) {
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        state: LZ.StatusBadge.toneOf(row.status),
        acceptance: (row.acceptance || []).slice(),
        dependsOn: (row.dependsOn || []).slice(),
        artifacts: (row.artifacts || []).slice(),
        done: row.status === 'completed' || row.status === 'verified',
      }
    })

    const evidence = (delivery.evidence || []).map(function (row) {
      return {
        id: row.id,
        kind: row.kind,
        kindLabel: EVIDENCE_KIND_LABEL[row.kind] || row.kind,
        summary: row.summary,
        detail: row.detail,
        ref: row.ref,
        at: stamp(row.at, now),
      }
    })

    const decisions = (delivery.decisions || []).map(function (row) {
      return {
        id: row.id,
        decision: row.decision,
        reason: row.reason,
        alternatives: row.alternatives,
        rejectedBecause: row.rejectedBecause,
        at: stamp(row.at, now),
      }
    })

    const blockers = (delivery.blockers || []).map(function (row) {
      return {
        id: row.id,
        code: row.code,
        message: row.message,
        at: stamp(row.at, now),
        resolvedAt: row.resolvedAt === null ? '' : stamp(row.resolvedAt, now),
        open: row.resolvedAt === null,
      }
    })

    const proposals = (delivery.proposals || []).map(function (row) {
      return {
        id: row.id,
        field: row.field,
        target: row.target,
        current: row.current,
        proposed: row.proposed,
        reason: row.reason,
        impact: row.impact,
        status: row.status,
        pending: row.status === 'pending',
      }
    })

    const changes = (delivery.changes || []).map(function (row) {
      return {
        id: row.id,
        at: stamp(row.at, now),
        actor: row.actor,
        actorLabel: ACTOR_LABEL[row.actor] || row.actor,
        action: row.action,
        detail: row.detail,
      }
    })

    const chain = delivery.chain || { goalMatch: null, skillCheck: null, at: 0 }
    const skills = (delivery.skills || []).map(function (row) {
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        purpose: row.purpose,
        source: row.source,
        // 只有 http(s) 才当链接。本地路径做成链接，点下去是「找不到文件」——那看起来像
        // 页面坏了，而实际是它本来就不是一个网址。
        isLink: /^https?:\/\//.test(row.source),
        at: row.at === 0 ? '' : stamp(row.at, now),
      }
    })

    return {
      objectiveMirror: delivery.objectiveMirror || '',
      focus: delivery.focus || '',
      next: (delivery.next || []).slice(),
      // 预期产出：Agent 写的「做完会得到什么」，一段话。
      //
      // 原样透传，不在这里补任何默认文案 —— 「还没写」是一个事实，页面要能把它说成事实。
      // 拿 target 的 objective 来顶替是最容易顺手做、也最坏的一种「补」：它会让页面看起来
      // 已经填过了，而 Agent 从来没有回答过这个问题。
      expectedOutput: delivery.expectedOutput || '',
      // 概览目标：Agent 写的「这个目标在做什么」，一段话，比预期产出短。
      //
      // 它与预期产出是**两个问题**（抬头一句 vs 对结果的承诺），所以是两个字段而不是一个的两种
      // 措辞。同样原样透传：空就让它空着，页面负责说「还没有写」，这里不替它补。
      goalSummary: delivery.goalSummary || '',
      // 状态链的两条分支：这里只投影**事实**（Agent 答过什么、什么时候答的），
      // 页面负责把它说成中文。判断本身归 Agent，这一层不替它补默认值。
      chain: {
        goalMatch: chain.goalMatch === undefined ? null : chain.goalMatch,
        goalLabel: CHAIN_GOAL_LABEL[chain.goalMatch] || '还没判断',
        skillCheck: chain.skillCheck === undefined ? null : chain.skillCheck,
        skillLabel: CHAIN_SKILL_LABEL[chain.skillCheck] || '还没判断',
        judged: chain.goalMatch !== undefined && chain.goalMatch !== null &&
          chain.skillCheck !== undefined && chain.skillCheck !== null,
        at: chain.at === undefined || chain.at === 0 ? '' : stamp(chain.at, now),
      },
      skills: skills,
      scope: {
        included: (delivery.scope && delivery.scope.included) || [],
        excluded: (delivery.scope && delivery.scope.excluded) || [],
      },
      constraints: (delivery.constraints || []).slice(),
      acceptance: acceptance,
      tasks: tasks,
      evidence: evidence,
      decisions: decisions,
      blockers: blockers,
      proposals: proposals,
      changes: changes,
      revision: delivery.revision,
    }
  }

  /**
   * 「还缺什么」——每个必填项现在的状态。
   *
   * 这是**显示**，不是第二套权限。谁能写、写了算不算数，全部由 goal-domain 的
   * Authority Matrix 决定；这里只把它的结果说出来。之前考虑过引入
   * draft/proposed/confirmed/executable 四态状态机，**决定不做**：那会变成与
   * Authority Matrix 平行的第二套规则，而两套规则迟早会不一致（一处放行、一处拒绝），
   * 用户看到的就是「页面说可以，工具说不行」。真正缺的只是**把那套规则的结果显示出来**。
   *
   * 三种状态，对应三种不同的事实：
   *   missing    —— 还没有（Agent 能直接补）
   *   proposed   —— 提了，等你确认（Agent 已经答过；pending 提案算已答，见 missingGoalFields）
   *   settled    —— 有了
   *
   * 纯函数，输入是已经算好的 view，不读盘、不看时间——所以可以直接断言。
   *
   * @param {{acceptance: Array, scope: object, constraints: Array, proposals: Array}} view
   * @returns {{fields: Array<{name: string, state: string, detail: string, how: string}>, missing: string[], ready: boolean}}
   */
  function readiness(view) {
    const pending = view.proposals.filter(function (row) { return row.pending })
    const pendingFor = function (field) {
      const row = pending.filter(function (p) { return p.field === field })
      return row.length === 0 ? null : row[0]
    }
    const scopeCount = view.scope.included.length + view.scope.excluded.length

    const fields = []

    // 概览目标与预期产出：都是 Agent 直接写，**没有「等你确认」这一态** —— 它们不需要人批，
    // 不写就是没写。这也是它们必须与另外三格并列显示的原因：它们是 Agent 自己的责任，
    // 不能藏在别处。
    //
    // 两格相邻且顺序固定（概览目标在前）—— 因为它们在卡片上就是上下相邻的两格，而
    // 「还缺什么」这张表是照着卡片读的。顺序反了会让人以为这是两个不同的地方。
    const summary = view.goalSummary || ''
    fields.push({
      name: '概览目标',
      state: summary === '' ? 'missing' : 'settled',
      detail: summary === '' ? '' : summary.slice(0, 40) + (summary.length > 40 ? '…' : ''),
      how: 'setGoalSummary',
    })

    const expected = view.expectedOutput || ''
    fields.push({
      name: '预期产出',
      state: expected === '' ? 'missing' : 'settled',
      detail: expected === '' ? '' : expected.slice(0, 40) + (expected.length > 40 ? '…' : ''),
      how: 'setExpectedOutput',
    })

    // 验收标准：Agent 可直接写，所以 missing 时给的指引是「加一条」。
    const acceptanceProposal = pendingFor('acceptance')
    fields.push({
      name: '验收标准',
      state: view.acceptance.length > 0 ? 'settled' : (acceptanceProposal === null ? 'missing' : 'proposed'),
      detail: view.acceptance.length > 0 ? view.acceptance.length + ' 条' : (acceptanceProposal === null ? '' : acceptanceProposal.proposed),
      how: 'addAcceptance',
    })

    // 范围与约束：人类权威，Agent 只能提。所以 missing 时给的指引是「提一个」。
    const scopeProposal = pendingFor('scope')
    fields.push({
      name: '范围边界',
      state: scopeCount > 0 ? 'settled' : (scopeProposal === null ? 'missing' : 'proposed'),
      detail: scopeCount > 0 ? scopeCount + ' 条' : (scopeProposal === null ? '' : scopeProposal.proposed),
      how: 'proposeScope',
    })

    const constraintProposal = pendingFor('constraints')
    fields.push({
      name: '已知约束',
      state: view.constraints.length > 0 ? 'settled' : (constraintProposal === null ? 'missing' : 'proposed'),
      detail: view.constraints.length > 0 ? view.constraints.length + ' 条' : (constraintProposal === null ? '' : constraintProposal.proposed),
      how: 'proposeConstraints',
    })

    const missing = fields.filter(function (row) { return row.state === 'missing' }).map(function (row) { return row.name })
    // `proposed` 也算答过了——这正是门放行的条件。所以 readiness 说的「齐了」与门的
    // 「可以干活了」必须是同一个判断，否则页面和门会给出相反的答案。
    const ready = missing.length === 0
    return { fields: fields, missing: missing, ready: ready }
  }

  /**
   * 计数汇总。数字在这里算一次，页面只是显示——两处各算一次必然会漂。 */
  function counts(view) {
    const verified = view.acceptance.filter(function (row) { return row.done }).length
    const mandatory = view.acceptance.filter(function (row) { return row.mandatory })
    const mandatoryVerified = mandatory.filter(function (row) { return row.done }).length
    const tasksDone = view.tasks.filter(function (row) { return row.done }).length
    return {
      acceptance: { total: view.acceptance.length, done: verified, mandatory: mandatory.length, mandatoryDone: mandatoryVerified },
      tasks: { total: view.tasks.length, done: tasksDone, active: view.tasks.filter(function (r) { return r.status === 'in_progress' }).length },
      evidence: { total: view.evidence.length },
      decisions: { total: view.decisions.length },
      blockers: { total: view.blockers.length, open: view.blockers.filter(function (r) { return r.open }).length },
      changes: { total: view.changes.length },
      proposals: { pending: view.proposals.filter(function (r) { return r.pending }).length },
    }
  }

  /**
   * 任务树：由 tasks 的 dependsOn 与 acceptance 引用关系推导出来。
   *
   * 推导规则（**纯函数**，可单独断言）：
   *   1. 有依赖的任务挂到它的依赖项下面（一个依赖项多个孩子）。
   *   2. 依赖项本身不在本计划里（已被丢弃）→ 当根节点，否则整棵子树会消失。
   *   3. 相互依赖（环）→ 都当根节点。宁可排成两行，也不能让节点在渲染里消失。
   *   4. 无依赖的一律是根节点。
   *
   * 「不丢节点」是这里唯一不可让步的性质：树是给用户看全貌的，
   * 一个因为数据有环就消失的任务，用户永远不知道它存在。
   *
   * @param {Array} tasks 视图模型的任务
   * @returns {Array} 树节点
   */
  function taskTree(tasks) {
    const byId = {}
    for (const task of tasks) byId[task.id] = task

    // 每个任务的父节点：取第一条有效依赖。
    const parentOf = {}
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (byId[dep] === undefined || dep === task.id) continue
        parentOf[task.id] = dep
        break
      }
    }

    // 拆环：沿父链上溯，若回到自己就把这条边丢掉。这样保证结果是森林，
    // 且每个被丢边的节点仍然留在树里（变成根）。
    for (const task of tasks) {
      let cursor = parentOf[task.id]
      const seen = { [task.id]: true }
      while (cursor !== undefined) {
        if (seen[cursor] === true) { delete parentOf[task.id]; break }
        seen[cursor] = true
        cursor = parentOf[cursor]
      }
    }

    const childrenOf = {}
    for (const task of tasks) {
      const parent = parentOf[task.id]
      if (parent === undefined) continue
      if (childrenOf[parent] === undefined) childrenOf[parent] = []
      childrenOf[parent].push(task.id)
    }

    const build = function (id) {
      const task = byId[id]
      const kids = (childrenOf[id] || []).map(build)
      const sub = []
      if (task.acceptance.length > 0) sub.push('服务 ' + task.acceptance.join('、'))
      if (task.dependsOn.length > 0) sub.push('依赖 ' + task.dependsOn.join('、'))
      if (task.artifacts.length > 0) sub.push('产出 ' + task.artifacts.join('、'))
      return {
        id: task.id,
        title: task.title,
        sub: sub.length > 0 ? sub.join(' · ') : undefined,
        badges: [LZ.StatusBadge.fromStatus(task.status)],
        done: task.done,
        children: kids,
      }
    }

    return tasks.filter(function (task) { return parentOf[task.id] === undefined }).map(function (task) { return build(task.id) })
  }

  /**
   * 把 `GET /__luzzy/goal` 的整个响应转成页面的视图模型。
   *
   * 三种「没有目标」必须分开，因为它们要求用户做的事完全不同：
   *   - `empty`       这个会话确实没有目标 → 告诉用户怎么开始
   *   - `unavailable` 目标存在但本进程看不到（DSH 重启后没打开过这个会话）→ 告诉用户去打开它
   *   - `invalid`     会话 id 不合法 → 客户端 bug，说实话
   * 把它们读成同一句话，就是对着用户的数据说了一句不真的话。
   *
   * @param {object} payload 后端响应
   * @returns {object} 视图模型
   */
  function toView(payload, now) {
    if (payload === null || payload === undefined) {
      return { ok: false, reason: '没有收到目标数据' }
    }

    // 计划文件读不出来是**独立的一档**：文件在，但内容坏了。把它说成「没有计划」
    // 是对用户数据的不实陈述，所以它单独返回一个原因。
    if (payload.readError !== undefined && payload.readError !== null) {
      return {
        ok: false,
        reason: '这个会话的目标状态文件读不出来。',
        detail: payload.readError.reason || '',
        goal: null,
        sessionId: payload.sessionId || '',
      }
    }

    const delivery = payload.delivery === null || payload.delivery === undefined ? null : deliveryToView(payload.delivery, now)
    const runtime = payload.goal === null || payload.goal === undefined ? null : payload.goal
    const view = {
      ok: true,
      sessionId: payload.sessionId || '',
      goalState: payload.goalState || 'empty',
      goalReason: payload.goalReason || '',
      capabilities: payload.capabilities || {},
      warnings: payload.warnings || [],

      // 运行时目标（DSH 拥有，页面从不写它）
      goal: runtime === null ? null : {
        id: runtime.id,
        objective: runtime.objective,
        phase: runtime.phase,
        phaseLabel: runtime.phase === 'active' ? '进行中' : runtime.phase === 'paused' ? '已暂停' : runtime.phase === 'complete' ? '已完成' : runtime.phase === 'blocked' ? '已阻塞' : runtime.phase,
        state: LZ.StatusBadge.toneOf(runtime.phase),
        activation: runtime.activation,
        revision: runtime.revision,
        roundsStarted: runtime.roundsStarted,
        maxGoalRounds: runtime.maxGoalRounds,
        blockedReason: runtime.blockedReason === undefined ? null : runtime.blockedReason,
      },
      delivery: delivery,
      counts: delivery === null ? null : counts(delivery),
      tree: delivery === null ? [] : taskTree(delivery.tasks),
      integrity: payload.integrity || null,
      drift: payload.drift || null,
      // 还缺什么。null 交付（读不出来）时也给 null，而不是一个「什么都缺」的空壳——
      // 「读不到」与「没有」是两件事，页面必须能分开（同 readError / goalState 的处理）。
      readiness: delivery === null ? null : readiness(delivery),
      artifact: payload.artifact || null,
      artifactPath: payload.artifactPath || '',
      health: payload.summary ? payload.summary.health : 'needs-attention',
      healthLabel: payload.summary ? (HEALTH_LABEL[payload.summary.health] || payload.summary.health) : '未知',
      healthState: payload.summary ? LZ.StatusBadge.toneOf(payload.summary.health) : 'idle',
      // 完成门是否放行。页面用它决定「标记完成」按钮出不出现 —— 一个必然被拒的按钮会教用户
      // 把这道门当成噪音，而这道门是整个系统的重点。缺字段时按 false：不确定就不给按钮。
      completionAllowed: payload.summary ? payload.summary.can_complete === true : false,
      completionBlockedBy: payload.summary && Array.isArray(payload.summary.completion_blocked_by)
        ? payload.summary.completion_blocked_by
        : [],
      counters: payload.counters || null,
      enforcement: payload.enforcement || null,
    }
    return view
  }

  /**
   * 「Agent 做到哪一步、下一步是什么、是否已经完成」——总览页与目标中心都要回答。
   *
   * 这段推导放在数据层而不是页面里，因为它必须**只写一遍**：
   * 两个页面对同一个目标给出不同答案，比任何一处布局问题都严重。
   *
   * @param {object} view goal-service 的视图模型
   * @returns {{now: string, next: string, done: boolean, doneReason: string, why: string}}
   */
  function progressOf(view) {
    if (view === null || view.ok !== true || view.delivery === null) {
      return { now: '', next: '', done: false, doneReason: '', why: '' }
    }
    const delivery = view.delivery
    const c = view.counts

    // 「正在处理什么」：焦点是权威（那是 Agent 自己声明当前唯一该关注的事）；
    // 没有焦点时退回第一条进行中的任务，那是最接近的具体活动。
    let current = delivery.focus
    if (current === '' ) {
      const active = delivery.tasks.filter(function (row) { return row.status === 'in_progress' })
      current = active.length > 0 ? active[0].id + ' ' + active[0].title : ''
    }

    const next = delivery.next.length > 0 ? delivery.next.join('；') : ''

    // 「是否已经完成」：只认可判定的东西——必须的验收标准全部 verified。
    // 目标的 phase 是运行时状态，可能与计划不同步，所以它不单独构成"完成"的证据。
    const mandatoryOk = c.acceptance.mandatory > 0 && c.acceptance.mandatoryDone === c.acceptance.mandatory
    const blockersOpen = c.blockers.open
    const done = view.goal !== null && view.goal.phase === 'complete'
    let doneReason = ''
    if (done) {
      doneReason = '运行时目标已标记完成。'
    } else if (mandatoryOk && blockersOpen === 0) {
      doneReason = '必须的验收标准全部已验证，且没有未解决的阻塞——可以申请完成了。'
    } else if (blockersOpen > 0) {
      doneReason = '还有 ' + blockersOpen + ' 项阻塞未解决。'
    } else if (c.acceptance.mandatory === 0) {
      doneReason = '还没有必须满足的验收标准，所以「做完了」还无从判定。'
    } else {
      doneReason = '还差 ' + (c.acceptance.mandatory - c.acceptance.mandatoryDone) + ' 条必须的验收标准未验证。'
    }

    // 「为什么这样执行」：把范围与约束、以及最近的决策串成一句可读的说明。
    const why = []
    if (delivery.scope.included.length > 0) why.push('范围：' + delivery.scope.included.join('、'))
    if (delivery.scope.excluded.length > 0) why.push('不包含：' + delivery.scope.excluded.join('、'))
    if (delivery.constraints.length > 0) why.push('约束：' + delivery.constraints.join('、'))
    if (delivery.decisions.length > 0) {
      const latest = delivery.decisions[delivery.decisions.length - 1]
      why.push('最近决策：' + latest.decision + (latest.reason === '' ? '' : '（' + latest.reason + '）'))
    }

    return {
      current: current,
      next: next,
      done: done || (mandatoryOk && blockersOpen === 0),
      doneReason: doneReason,
      why: why.join('；'),
    }
  }

  /** 最近动态：把 changes 与 blockers 合成一条时间线，按时间倒序。 */
  function recentActivity(view, limit) {
    if (view === null || view.delivery === null) return []
    const rows = []
    for (const change of view.delivery.changes) {
      rows.push({ at: change.at, sortKey: change.id, text: change.action, sub: change.detail, actor: change.actorLabel, state: change.actor === 'human' ? 'running' : 'idle' })
    }
    for (const blocker of view.delivery.blockers) {
      rows.push({ at: blocker.at, sortKey: blocker.id, text: '记录阻塞 ' + blocker.code, sub: blocker.message, actor: '系统', state: blocker.open ? 'blocked' : 'success' })
    }
    rows.reverse()
    return rows.slice(0, limit === undefined ? 12 : limit)
  }

  LZ.GoalService = {
    toView: toView,
    deliveryToView: deliveryToView,
    counts: counts,
    readiness: readiness,
    taskTree: taskTree,
    progressOf: progressOf,
    recentActivity: recentActivity,
    stamp: stamp,
    dayStamp: dayStamp,
    EVIDENCE_KIND_LABEL: EVIDENCE_KIND_LABEL,
    ACTOR_LABEL: ACTOR_LABEL,
    HEALTH_LABEL: HEALTH_LABEL,
  }
})(window.LZ = window.LZ || {})
