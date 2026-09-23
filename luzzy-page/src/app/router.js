/* app/router.js —— 帧内的页面路由。
 *
 * 五个主页面 + 一个次要入口（插件说明）。路由只做三件事：
 *   1. 持有「当前在哪一页」
 *   2. 给出页签的定义（顺序即信息优先级）
 *   3. 把一次渲染分派给对应的页面模块
 *
 * 它**不做数据获取**——那是 app.js 的事。分开是因为它们的失败模式不同：
 * 路由错了是页面不显示，取数错了是页面显示错的内容；混在一起时两者长得一样。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  /**
   * 页签定义。
   *
   * 顺序是有判断的：总览在最前（打开就看到 Agent 在做什么），目标中心紧随
   * （它回答的问题比总览深一层），然后是执行状态、Agent 配置、系统信息。
   * 「预设」是 Agent 配置的编辑面，「插件说明」是次要入口，两者都排在后面。
   *
   * **每个 render 收到的是「为这一页算好的投影」，不是整个应用状态。**
   * 投影由 app.js 的 buildPageState 产出——页面只知道自己要什么，不需要知道
   * 「目标数据存在哪个字段、用哪个 status 表示加载中」。这里传的 `state` 就是那份投影。
   */
  const TABS = [
    { id: 'overview', label: '总览', render: function (view) { return LZ.OverviewPage.render(view) } },
    { id: 'goal', label: '目标中心', render: function (view) { return LZ.GoalPage.render(view) } },
    { id: 'runtime', label: '执行状态', render: function (view) { return LZ.RuntimePage.render(view) } },
    { id: 'agent', label: 'Agent 配置', render: function (view) { return LZ.AgentPage.render(view) } },
    { id: 'system', label: '系统信息', render: function (view) { return LZ.SystemPage.render(view) } },
    // 预设编辑器自己持有全部状态（它是编辑器的局部状态，切页即失是正确的语义），
    // 所以它不需要投影。
    { id: 'preset', label: '预设', render: function () { return LZ.PresetPage.render() } },
    { id: 'readme', label: '插件说明', render: function (view) { return LZ.ReadmePage.render(view) } },
  ]

  const DEFAULT_TAB = 'overview'

  function byId(id) {
    return TABS.find(function (tab) { return tab.id === id }) || null
  }

  function isKnown(id) {
    return byId(id) !== null
  }

  /** 页签栏。`aria-selected` 驱动视觉，`role=tablist` 让屏幕阅读器知道这是一组页签。 */
  function tabBar(current) {
    return '<div class="segment" role="tablist">' + TABS.map(function (tab) {
      return '<button type="button" role="tab" data-tab="' + esc(tab.id) + '" ' +
        'aria-selected="' + String(tab.id === current) + '">' + esc(tab.label) + '</button>'
    }).join('') + '</div>'
  }

  /**
   * 分派渲染。
   *
   * 参数是**这一页的投影**，投影自己带 `tab` 说明它属于哪一页——分派依据不该是一个
   * 与内容分开传的第二个参数，那两样东西可以不一致，而不一致时的症状正是「页面拿到别的
   * 页的数据」（本轮真实发生过：切页时崩溃，因为页面按自己的契约读投影，而投影是另一页的）。
   *
   * 未知页签退回默认页，而不是画一个空白。
   */
  function render(view) {
    const tab = byId(view && view.tab) || byId(DEFAULT_TAB)
    return tab.render(view)
  }

  LZ.Router = { TABS: TABS, DEFAULT_TAB: DEFAULT_TAB, byId: byId, isKnown: isKnown, tabBar: tabBar, render: render }
})(window.LZ = window.LZ || {})
