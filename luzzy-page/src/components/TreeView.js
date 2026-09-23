/* TreeView —— 可展开收起的树。用于「任务拆解」。
 *
 * 为什么用原生 <details>/<summary>
 * -------------------------------
 * 它自带键盘可达性（Enter/Space 展开、Tab 进入、屏幕阅读器播报展开态）与无障碍语义。
 * 手搓一个 div 树要把这两样重新实现一遍，而通常实现不全——这正是方案要的「展开/收起」
 * 功能里最容易被漏掉的一半。
 *
 * 层级用嵌套 <ul class="tree">，缩进由 CSS 的 .tree .tree 给。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  const ARROW = '<svg class="treeArrow" width="12" height="12" viewBox="0 0 12 12" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>'

  /**
   * 一个树节点。
   *
   * @param {{id: string, title: string, sub?: string, badges?: string[], done?: boolean,
   *          children?: Array, open?: boolean}} node
   * @param {number} [depth] 仅用于 key 生成，不参与渲染
   */
  function node(spec, depth) {
    const badges = (spec.badges || []).join('')
    const meta = badges === '' ? '' : '<span class="treeMeta">' + badges + '</span>'
    const sub = spec.sub === undefined ? '' : '<div class="treeSub">' + esc(spec.sub) + '</div>'
    const children = spec.children || []
    const rowAttrs = ' data-done="' + String(spec.done === true) + '"'

    if (children.length === 0) {
      return '<li class="treeNode">' +
        '<div class="treeRow"' + rowAttrs + '>' +
        '<span class="treeArrow" aria-hidden="true"></span>' +
        '<span class="treeText">' + esc(spec.title) + '</span>' +
        meta +
        '</div>' + sub +
        '</li>'
    }

    // 展开态默认由数据决定：**只要子树里还有没完成的东西就展开**，全完成才收起。
    //
    // 判据是整棵子树，不只是直接子节点。只看直接子节点时，一条「父已完成、但孙节点还在做」
    // 的链会被判成「都完成了」而收起——于是打开任务树只看到一行，五分之四的计划被藏起来。
    // 这是实测到的：一个 5 节点的链只显示 1 行。
    //
    // 「默认收起」是另一种错法：它同样把进行中的任务树的全部内容藏起来。
    const hasOpenWork = function (nodes) {
      return nodes.some(function (child) {
        return child.done !== true || hasOpenWork(child.children || [])
      })
    }
    const open = spec.open === undefined ? hasOpenWork(children) : spec.open === true
    return '<li class="treeNode">' +
      '<details class="treeBranch"' + (open ? ' open' : '') + '>' +
      '<summary class="treeRow"' + rowAttrs + '>' +
      ARROW +
      '<span class="treeText">' + esc(spec.title) + '</span>' +
      meta +
      '</summary>' +
      sub +
      '<ul class="tree">' + children.map(function (child) { return node(child, (depth || 0) + 1) }).join('') + '</ul>' +
      '</details>' +
      '</li>'
  }

  /**
   * 一棵树。
   *
   * @param {Array} nodes
   * @param {{emptyText?: string}} [options]
   */
  function tree(nodes, options) {
    if (nodes.length === 0) {
      return LZ.EmptyState.line((options && options.emptyText) || '暂无内容')
    }
    return '<ul class="tree">' + nodes.map(function (item) { return node(item, 0) }).join('') + '</ul>'
  }

  LZ.TreeView = { tree: tree, node: node }
})(window.LZ = window.LZ || {})
