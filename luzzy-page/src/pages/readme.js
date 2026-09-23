/* pages/readme.js —— 插件说明。一个**次要入口**，不是第六个功能区。
 *
 * 它原来叫「说明」，而且是默认页——打开 Luzzy 第一眼看到的是插件自己的 README，
 * 而不是 Agent 在做什么。现在默认页是「总览」，这一页挪到最后。
 *
 * 内容与渲染都没变：README.md 由宿主半读出来，帧用同一个渲染器渲染。
 * 它同时是**字体子集的取样源**——改它的文案会让 lib/client.js 里的子集过时，
 * 必须重跑构建（见 docs/frontend-v2-migration.md）。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  function render(state) {
    if (state.status === 'idle' || state.status === 'loading') {
      return LZ.Card.card({
        title: '插件说明',
        body: LZ.EmptyState.loading('正在读取说明文档…') ||
          '<div class="status"><span>正在读取说明文档…</span>' +
          LZ.Card.skeleton('60%', '20px') + LZ.Card.skeleton('100%', '160px') + '</div>',
      })
    }
    if (state.status === 'error' || state.html === null) {
      return LZ.Card.card({
        title: '插件说明',
        body: LZ.EmptyState.blocked({
          title: '说明文档读不出来',
          body: '文档由宿主半从插件目录读取。读不到时这里留空，而不是显示一份旧副本。',
          detail: state.detail,
        }),
      })
    }
    // 正文给一个可读的行宽（.prose 的 max-width），卡片本身仍与上下邻居对齐。
    return LZ.Card.card({ title: '插件说明', body: '<div class="prose">' + state.html + '</div>' })
  }

  LZ.ReadmePage = { render: render }
})(window.LZ = window.LZ || {})
