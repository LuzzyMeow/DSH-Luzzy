/* pages/agent.js —— 页面四：Agent 配置。
 *
 * 四组信息，每一项都来自真实配置或真实运行事实：
 *
 *   Agent 信息    名称 / 分组 / 当前模型 / 提示词来源
 *   行为策略      目标遵守程度 / 执行方式 / 规划方式
 *   工具能力      按语义分组列出这个 Agent 实际用过与可用的工具
 *   上下文策略    自动加载目标 / 规则 / 记忆
 *
 * **这一页最重要的纪律：不把它写成宣传页。**
 * 「目标遵守程度」不写「高」，写「完成门已启用，已拦下 3 次过早完成」——那是可核对的事实；
 * 「自动加载记忆」不写「已启用」，写「由记忆服务负责，不经本插件」——不把别人的能力
 * 记在自己账上。写死的说明文字一定会与真实行为漂移，那时这一页就从配置面板变成了广告。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc
  const badge = LZ.StatusBadge.badge

  /* ---------------------------------------------------------------- Agent 信息 */

  function infoCard(view) {
    return LZ.Card.card({
      title: 'Agent 信息',
      count: view.active === null ? '未选择' : view.active.id,
      body: LZ.Card.kv(view.info) +
        (view.warnings.length > 0
          ? LZ.Card.callout('warn', view.warnings.join(' '))
          : ''),
      sub: '提示词由本插件的预设存储托管，切换激活智能体会在下一次请求生效——不必新建会话。',
    })
  }

  /* ---------------------------------------------------------------- 行为策略 */

  function behaviorCard(view) {
    if (!view.behavior.available) {
      return LZ.Card.card({
        title: '行为策略',
        body: LZ.EmptyState.empty({
          title: '读不到行为策略',
          body: '目标服务没有挂载，或宿主半还没有重启。策略值来自插件真实生效的配置，读不到时不显示默认值。',
        }),
      })
    }
    const rows = view.behavior.items.map(function (item) {
      return '<li class="row">' +
        '<span class="rowId">' + (item.ok ? badge('success', '已启用') : badge('blocked', '未生效')) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(item.label) + '</p>' +
        '<p class="rowSub">' + esc(item.value) + '</p></div>' +
        '</li>'
    }).join('')
    return LZ.Card.card({
      title: '行为策略',
      count: view.behavior.items.length + ' 项',
      sub: '每一项都来自本插件真实生效的配置与实时统计，不是说明文字。',
      body: '<ul class="rows">' + rows + '</ul>',
    })
  }

  /* ---------------------------------------------------------------- 工具能力 */

  function toolsCard(view) {
    if (!view.runtimeReady) {
      return LZ.Card.card({
        title: '工具能力',
        body: LZ.EmptyState.blocked({
          title: '暂无法列出工具能力',
          body: '工具清单来自会话日志的统计。读不到日志时这一栏是空的——但它不是「没有工具」，那两件事不一样。',
          action: LZ.Card.btnBar([{ label: '重试', id: 'agentRetry' }]),
        }),
      })
    }
    if (view.toolRows.length === 0) {
      return LZ.Card.card({
        title: '工具能力',
        body: LZ.EmptyState.empty({
          title: '暂无工具使用记录',
          body: '这个会话还没有调用过工具，所以列不出实际的工具面。',
        }),
      })
    }
    const rows = view.toolRows.map(function (group) {
      return '<li class="row">' +
        '<span class="rowId">' + (group.available ? badge('success', '可用') : badge('idle', '未见使用')) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(group.label) + '</p>' +
        '<p class="rowSub">' + esc(group.names.join('、')) + ' · 共 ' + group.count + ' 次</p></div>' +
        '</li>'
    }).join('')
    return LZ.Card.card({
      title: '工具能力',
      count: view.toolRows.length + ' 类',
      sub: '按语义归类，来源是这个会话真实的工具调用记录。认不出的工具归到「其他」并保留原名。',
      body: '<ul class="rows">' + rows + '</ul>',
    })
  }

  /* ---------------------------------------------------------------- 上下文策略 */

  function contextCard(view) {
    const rows = view.context.map(function (item) {
      return '<li class="row">' +
        '<span class="rowId">' + (item.ok ? badge('success', '是') : badge('idle', '否')) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(item.label) + '</p>' +
        '<p class="rowSub">' + esc(item.value) + '</p></div>' +
        '</li>'
    }).join('')
    return LZ.Card.card({
      title: '上下文策略',
      count: view.context.length + ' 项',
      body: '<ul class="rows">' + rows + '</ul>',
      sub: '只有「自动加载目标」归本插件管；规则与记忆各自有负责的一方，这里如实标注。',
    })
  }

  /* ---------------------------------------------------------------- 智能体名单 */

  function rosterCard(view) {
    if (view.agents.length === 0) {
      return LZ.Card.card({
        title: '智能体名单',
        body: LZ.EmptyState.empty({
          title: '名单是空的',
          body: '还没有任何智能体。在「预设」入口里新建一个，或从默认提示词开始。',
          action: LZ.Card.btnBar([{ label: '去预设页面', id: 'agentGotoPreset' }]),
        }),
      })
    }
    const rows = view.agents.map(function (agent) {
      return '<li class="row">' +
        '<span class="rowId">' + esc(agent.id) + '</span>' +
        '<div class="rowBody"><p class="rowText">' + esc(agent.name) + '</p>' +
        (agent.description === '' ? '' : '<p class="rowSub">' + esc(agent.description) + '</p>') +
        '</div>' +
        '<div class="rowChips">' + (agent.active ? badge('success', '当前激活') : badge('idle', '未激活')) + '</div>' +
        '</li>'
    }).join('')
    return LZ.Card.card({
      title: '智能体名单',
      count: view.agents.length + ' 个 · 激活 ' + (view.active === null ? '无' : view.active.name),
      body: '<ul class="rows">' + rows + '</ul>' +
        LZ.Card.btnBar([
          { label: '编辑提示词与名单', id: 'agentGotoPreset' },
          { spacer: true },
          { label: '新建 LuzzyMode 会话', id: 'agentNewSession' },
        ]),
      sub: '「当前激活」决定模型实际收到的提示词；切换它对所有会话的下一次请求生效。',
    })
  }

  /* ---------------------------------------------------------------- 组装 */

  function render(state) {
    if (state.status === 'idle' || state.status === 'loading') {
      return LZ.EmptyState.loading('正在读取 Agent 配置…', state.elapsed)
    }
    const view = state.view
    if (view === null || view.ok !== true) {
      const reason = view === null ? '没有收到 Agent 配置数据。' : view.reason
      return LZ.EmptyState.blocked({
        title: 'Agent 配置读不出来',
        body: reason || '宿主没有返回预设状态。',
        detail: state.detail,
        action: LZ.Card.btnBar([{ label: '重试', id: 'agentRetry' }]),
      })
    }

    return [
      infoCard(view),
      '<div class="grid" data-cols="2">' +
        '<div class="stack">' + behaviorCard(view) + contextCard(view) + '</div>' +
        '<div class="stack">' + rosterCard(view) + '</div>' +
        '</div>',
      toolsCard(view),
    ].join('')
  }

  LZ.AgentPage = { render: render }
})(window.LZ = window.LZ || {})
