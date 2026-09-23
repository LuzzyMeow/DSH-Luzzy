/* agent-service —— Agent 配置数据层：把 /__luzzy/preset 与运行事实转成视图模型。
 *
 * 页面问的四个问题对应四组真实数据：
 *   Agent 信息      名称 / 角色 / 当前模型   ← 预设名单 + 会话日志的 model/selection
 *   行为策略        目标遵守程度 / 执行方式 / 规划方式  ← goal-enforce 的真实配置值
 *   工具能力        文件操作 / 代码执行 / 目标管理 / 搜索  ← 会话里真实出现过的工具
 *   上下文策略      自动加载目标 / 规则 / 记忆  ← preflight 钩子的真实开关
 *
 * 一条纪律：**行为策略与上下文策略显示的是本插件实际生效的配置值，不是宣传语。**
 * 它们的来源是宿主半 DEFAULT_ENFORCE_OPTIONS 与 installEnforcement 的入参，
 * 由 /__luzzy/goal 的 capabilities 带回。写死的说明文字会与真实行为漂移，
 * 那样这个页面就从「配置面板」变成了「宣传页」。
 */
(function (LZ) {
  'use strict'

  /** 工具能力的分组。与 runtime-service 的工具归类共用同一套语义分组，但呈现角度不同：
   *  那边问「这个会话用了什么」，这边问「这个 Agent 能做什么」。 */
  const CAPABILITY_GROUPS = [
    { key: 'read', label: '文件操作', match: /^(read|glob|grep|list_|write|edit|apply_|patch|multi_edit|create)/i },
    { key: 'exec', label: '代码执行', match: /^(pwsh|bash|shell|exec|run_|node$|python|test_|vitest|jest)/i },
    { key: 'goal', label: '目标管理', match: /^(goal_|update_goal|get_goal|create_goal|todo_)/i },
    { key: 'search', label: '搜索', match: /^(web_|anysearch|search|fetch|http)/i },
    { key: 'agent', label: '任务编排', match: /^(subagent|agent_|task$|delegate|workflow|ralph)/i },
  ]

  /** 按能力分组统计工具。每个分组给出「有哪些工具」与「用过几次」。 */
  function capabilities(toolList) {
    const rows = CAPABILITY_GROUPS.map(function (group) {
      const names = []
      let count = 0
      for (const tool of toolList) {
        if (!group.match.test(tool.name)) continue
        names.push(tool.name)
        count += tool.count
      }
      return { key: group.key, label: group.label, names: names, count: count, available: names.length > 0 }
    })
    // 认不出的工具归到「其他」，保留原名——新工具不该在页面上凭空消失。
    const known = {}
    for (const group of CAPABILITY_GROUPS) known[group.key] = true
    const others = toolList.filter(function (tool) {
      return !CAPABILITY_GROUPS.some(function (group) { return group.match.test(tool.name) })
    })
    if (others.length > 0) {
      rows.push({
        key: 'other',
        label: '其他',
        names: others.map(function (tool) { return tool.name }),
        count: others.reduce(function (sum, tool) { return sum + tool.count }, 0),
        available: true,
      })
    }
    return rows
  }

  /**
   * 行为策略。每一项都来自**真实生效的配置**，而不是说明文字。
   *
   * `enforcement` 是宿主半 installEnforcement 暴露的实时统计；`options` 是它实际启用的开关。
   * 读不到时返回 null 的项，页面显示「未知」而不是一个看起来合理的默认值——
   * 一个编出来的「遵守程度：高」比一句「未知」糟得多。
   */
  function behavior(goalView) {
    if (goalView === null || goalView.capabilities === undefined) {
      return { available: false, items: [] }
    }
    const capabilities = goalView.capabilities
    const enforcement = goalView.enforcement || null

    const items = []
    // 目标遵守程度：完成门是否启用 + 它实际拦下过几次。
    items.push({
      label: '目标遵守程度',
      value: capabilities.goalService === false
        ? '目标服务未挂载——完成门与方向注入都不生效'
        : enforcement === null
          ? '完成门已启用（尚无统计数据）'
          : '完成门已启用，已拦下 ' + enforcement.completionRejected + ' 次过早完成，放行 ' + enforcement.completionAccepted + ' 次',
      ok: capabilities.goalService !== false,
    })
    // 执行方式：对账屏障 + 它 steer 过几次。
    items.push({
      label: '执行方式',
      value: enforcement === null
        ? '对账屏障已启用（尚无统计数据）'
        : '对账屏障已启用，已提示对账 ' + enforcement.reconcileOffered + ' 次' +
          (enforcement.reconcileSkipped > 0 ? '，限流跳过 ' + enforcement.reconcileSkipped + ' 次' : ''),
      ok: true,
    })
    // 规划方式：交付工具是否注册。
    items.push({
      label: '规划方式',
      value: capabilities.tools === true
        ? '交付计划由 goal_delivery 工具维护'
        : '交付计划工具未注册——Agent 无法记录验收标准与证据',
      ok: capabilities.tools === true,
    })
    return { available: true, items: items }
  }

  /**
   * 上下文策略。三项对应四条生命周期钩子里的方向注入那一层。
   *
   * 「自动加载记忆」这一项**如实说本插件不管**：记忆由 MemOS 那条链负责，不在这个插件的
   * 钩子里。写成「已启用」是把别人的能力记在自己账上。
   */
  function context(goalView) {
    const capabilities = goalView === null ? {} : (goalView.capabilities || {})
    const enforcement = goalView === null ? null : goalView.enforcement
    return [
      {
        label: '自动加载目标',
        value: enforcement !== null && enforcement.preflight > 0
          ? '已注入 ' + enforcement.preflight + ' 次方向信息'
          : capabilities.goalService === false ? '目标服务未挂载' : '已启用（本轮尚未注入）',
        ok: capabilities.goalService !== false,
      },
      {
        label: '自动加载规则',
        value: '由 DSH 的 AGENTS.md 机制负责，不经本插件',
        ok: true,
      },
      {
        label: '自动加载记忆',
        value: '由记忆服务负责，不经本插件',
        ok: true,
      },
    ]
  }

  /**
   * 把预设快照与运行事实合成「Agent 配置」的视图模型。
   *
   * @param {object|null} preset  `GET /__luzzy/preset` 的响应
   * @param {object|null} runtime runtime-service 的视图模型
   * @param {object|null} goalView goal-service 的视图模型
   */
  function toView(preset, runtime, goalView) {
    if (preset === null || preset === undefined) {
      return { ok: false, reason: '没有收到 Agent 配置数据。' }
    }

    const agents = (preset.agents || []).map(function (agent) {
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        groupId: agent.groupId,
        order: agent.order,
        active: agent.id === preset.activeAgentId,
      }
    })
    const active = agents.find(function (agent) { return agent.active }) || null

    const model = runtime !== null && runtime.ok === true ? LZ.RuntimeService.modelLabel(runtime.context) : ''
    const groupName = active === null ? '' : (function () {
      const group = (preset.groups || []).find(function (row) { return row.id === active.groupId })
      return group === undefined ? '' : group.name
    })()

    return {
      ok: true,
      revision: preset.revision,
      activeAgentId: preset.activeAgentId || '',
      agents: agents,
      active: active,
      groups: preset.groups || [],
      session: preset.session || null,
      promptBytes: preset.promptBytes,
      promptSource: preset.promptSource || '',
      warnings: preset.warnings || [],
      capabilities: preset.capabilities || {},

      // Agent 信息
      info: [
        { label: '名称', value: active === null ? '未选择' : active.name },
        { label: '分组', value: groupName === '' ? '未分组' : groupName },
        { label: '当前模型', value: model === '' ? '未记录（本会话还没有请求过模型）' : model },
        { label: '提示词', value: preset.promptBytes === undefined
          ? '未读取'
          : LZ.RuntimeService.compact(preset.promptBytes) + ' 字节 · 来源 ' +
            (preset.promptSource === 'agent' ? '该智能体自己的文件' : preset.promptSource === 'builtin' ? '内置默认' : '默认提示词') },
      ],

      behavior: behavior(goalView),
      context: context(goalView),
      toolRows: runtime !== null && runtime.ok === true ? capabilities(runtime.toolList || []) : [],
      runtimeReady: runtime !== null && runtime.ok === true,
    }
  }

  LZ.AgentService = {
    toView: toView,
    capabilities: capabilities,
    behavior: behavior,
    context: context,
    CAPABILITY_GROUPS: CAPABILITY_GROUPS,
  }
})(window.LZ = window.LZ || {})
