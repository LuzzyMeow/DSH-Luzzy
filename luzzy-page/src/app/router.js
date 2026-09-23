/* app/router.js —— 帧内的页面路由与侧边栏导航。
 *
 * 路由只做三件事：
 *   1. 持有「当前在哪一页」
 *   2. 给出导航项的定义（顺序即信息优先级）
 *   3. 把一次渲染分派给对应的页面模块
 *
 * 它**不做数据获取**——那是 app.js 的事。分开是因为它们的失败模式不同：
 * 路由错了是页面不显示，取数错了是页面显示错的内容；混在一起时两者长得一样。
 *
 * 为什么改成侧边栏，以及为什么删掉「总览」
 * ---------------------------------------
 * 两条都是用户明确要求的。它们不只是换位置：
 *
 *   · **侧边栏**：顶部页签是横向排的，页数一多就得横向滚动或缩写标签（原来已经有
 *     `.tabs { overflow-x: auto }` 在给这件事打补丁）。侧边栏纵向排，加一项不影响其余项
 *     的宽度，标签可以留全，也终于有地方放图标。
 *
 *   · **删掉总览**：它回答的五个问题**目标中心全都回答**——阶段、验收计数、当前焦点、
 *     下一步、范围与约束、最近决策、最近动态，逐条都在。留着它就是同一份状态的两个入口，
 *     而两个入口意味着两套排版要各自维护、各自漂移。删掉之后默认落在目标中心。
 *
 * 一处必须保持的东西：**`data-tab` 属性留在导航按钮上**。它是点击的判据，也是所有截图与
 * 验收脚本定位页面的方式（`doc.querySelector('[data-tab="goal"]')`）。把导航换成侧边栏
 * 是外观改动，不该让那些脚本一起失效。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  /**
   * 导航图标：内联 SVG path，不引图标包。
   *
   * 帧是没有 bundler、没有网络的自包含文档，多一个图标依赖就是多一件要养着的东西；
   * 而四个图标各十几个字符，手写更便宜。
   *
   * **四个图标在 18px 下的笔画密度要相当。** 第一版的「目标中心」是两层同心圆（靶心），
   * 语义最准 —— 但它在 18px 下只有两圈细线，看上去像一抹脏印子而不是一个图标，而另外三个
   * 都有横竖笔画、体量明显更重。这不是「好不好看」，是**同一排里四个图标的视觉重量不一致**，
   * 于是第一个读起来像没画出来。所以换成靶心加一个实心中心点：语义不变，密度补齐。
   *
   * 每个导航项都是**图标 + 文字**，不是纯图标按钮：纯图标得靠 aria-label 才有名字，
   * 而有名字不等于**看得懂**。窄屏下文字会藏起来，那时图标才独自承担识别，所以
   * 每个 item 仍然带 aria-label 与 title。
   */
  const ICONS = {
    // 靶心：两圈 + 实心中心。加了中心点才在 18px 下与另外三个同重
    goal: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.6"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
    // 信息：圆圈 + i。i 的两笔单独画，不引字体
    system: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4"/><path d="M12 7.6v.02"/>',
    // 滑块：三横 + 两个旋钮。这是「调校 / 配置」的通用形
    preset: '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>',
    // 文档：折角纸。折角那一笔单独画，否则它读起来像一块砖
    readme: '<path d="M6.5 3h7l4.5 4.5V21h-11.5z"/><path d="M13.5 3v4.5H18"/>',
  }

  /**
   * 导航项定义。
   *
   * 顺序是有判断的：目标中心在最前，因为它是控制台的主场——回答「要完成什么、做到哪、
   * 什么才算完」。系统信息与预设是查证与编辑面，插件说明是次要入口。
   *
   * **每个 render 收到的是「为这一页算好的投影」，不是整个应用状态。**
   * 投影由 app.js 的 buildPageState 产出——页面只知道自己要什么，不需要知道
   * 「目标数据存在哪个字段、用哪个 status 表示加载中」。这里传的 `state` 就是那份投影。
   */
  const TABS = [
    { id: 'goal', label: '目标中心', render: function (view) { return LZ.GoalPage.render(view) } },
    { id: 'system', label: '系统信息', render: function (view) { return LZ.SystemPage.render(view) } },
    // 预设编辑器自己持有全部状态（它是编辑器的局部状态，切页即失是正确的语义），
    // 所以它不需要投影。
    { id: 'preset', label: '预设', render: function () { return LZ.PresetPage.render() } },
    { id: 'readme', label: '插件说明', render: function (view) { return LZ.ReadmePage.render(view) } },
  ]

  /**
   * 默认页。
   *
   * 用户要求「默认跳转目标中心」。这一条与「删掉总览」是同一件事的两半：删掉一个页签
   * 而不改默认值，落在它上面的会话会看到一个**回退到别的页**的界面，而用户以为自己
   * 还在总览。
   */
  const DEFAULT_TAB = 'goal'

  function byId(id) {
    return TABS.find(function (tab) { return tab.id === id }) || null
  }

  function isKnown(id) {
    return byId(id) !== null
  }

  /**
   * 侧边栏。
   *
   * 用 `<nav>` + `aria-current="page"`，不是 `role="tablist"` —— 这是**导航**，
   * 不是同一份内容的分页签。语义选错会让屏幕阅读器把四个页面读成一组可切换的标签页，
   * 而它们各自是独立的页面。
   */
  function tabBar(current) {
    return '<nav class="sidebarNav" aria-label="控制台页面">' + TABS.map(function (tab) {
      const on = tab.id === current
      return '<button type="button" class="navItem" data-tab="' + esc(tab.id) + '" ' +
        'aria-current="' + (on ? 'page' : 'false') + '" ' +
        'title="' + esc(tab.label) + '">' +
        '<svg class="navIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        (ICONS[tab.id] || '') + '</svg>' +
        '<span class="navLabel">' + esc(tab.label) + '</span>' +
        '</button>'
    }).join('') + '</nav>'
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
