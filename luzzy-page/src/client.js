// LuzzyPage / Luzzy 控制台 —— 与 DSH 的插槽条目（外层 bundle）。
//
// 这个文件是**手写源**，只承载两件事：
//   1. 与 DSH 的集成：插槽注册、主题跟随、会话握手、样式注入
//   2. 把帧文档交给 iframe
//
// 页面本身（五个页面 + 组件 + 数据层 + 样式）在 src/ 下的多文件树里，由
// tools/build-font-css.py 按 src/app/manifest.json 的顺序拼成帧文档、内联字体、
// 写进 lib/client.js。**改页面不要改这里，改 src/ 下对应的文件。**
//
// WHY THE PAGE LIVES IN AN IFRAME（三代里唯一能用的一代）：
//
//   Attempt 1 — React 组件里 require('react') 后调 hooks：
//     React error #321（Invalid hook call）。宿主渲染器用它**自己 bundle 内联的 React**，
//     而静态模块表里的 react 是另一份，于是 hooks 抛错、SlotErrorBoundary 把整页换成
//     一个空 div —— 没有报错，只有白屏。
//
//   Attempt 2 — hooks-free 组件 + defineStore 的 store share：
//     TypeError: useStore is not a function。conversation.view 条目的 props 里**没有**
//     useStore，那条被许可的状态通道根本到不了。
//
//   Attempt 3 — 本文件。插槽条目渲染**一个 <iframe>**，帧内是自包含文档：
//     自带 CSS、原生 JS、零 React、零 hooks、零框架注入。外层组件是一个纯函数，
//     返回一个元素。宿主 React 的内部结构碰不到它。
//
// 通过 ctx.effect / ctx.slots.inject 注册，卸载时能回滚。

window.__ModuleLoader__.load({
  // 这个 id 必须等于包名：bundle 执行后加载器会查 factories.has(<包名>)，
  // 而 patch 层的 id（luzzy-page）是另一个命名空间，不能写在这里。
  id: 'dsh-luzzy-page',
  factory: (require) => {
    // 黑匣子：每个阶段分别上报，所以白屏可以从宿主的 diag 目录诊断，而不是靠猜。
    const ping = (stage, detail) => {
      try {
        fetch('/__luzzy/diag', {
          method: 'POST',
          body: JSON.stringify({ stage, detail: detail ?? null, at: Date.now() }),
        }).catch(() => {})
      } catch {}
    }
    ping('bundle-executed')

    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx } = require('react/jsx-runtime')
    ping('requires-ok')

    const NS = 'luzzy-page'

    const zh = {
      'view.luzzy': 'Luzzy 控制台',
      'frame.title': 'Luzzy 控制台',
    }

    const en = {
      'view.luzzy': 'Luzzy Console',
      'frame.title': 'Luzzy Console',
    }

    // ---------------------------------------------------------------- the frame document

    /**
     * 内联的 @font-face 规则。构建脚本把它替换成子集化、base64 编码的字体，
     * 所以帧文档嵌的是同一套字，且不需要任何网络请求。
     */
    const FONT_FACE_CSS = `
/*__FONT_FACE_CSS__*/
`

    /**
     * 构建帧文档。
     *
     * 帧的内容（样式、组件、页面）由构建脚本从 src/ 树拼好，以 JSON 字符串字面量嵌在
     * FRAME_JSON 里。这里只做一件构建做不了的事：把字体 CSS 插进去。
     *
     * **为什么字体不一起烘进字符串**：测试套件会带着自己的字体 CSS 调用这个函数，
     * 而 buildFrameDocument 这个名字与签名被多个测试直接引用。保持它是一个函数，
     * 是让那些套件继续有效的前提。
     *
     * 主题**不进这个字符串**：它写在帧的根属性上（见 followTheme）。字符串里带上主题
     * 会让它随主题切换而变，而变化的 srcDoc 在 React 眼里就是新文档 —— **iframe 会重载**，
     * 正在跑的请求连同进度一起作废（症状是永远停在「正在统计用量…」）。
     *
     * @param {string} fontFaceCss 内联的 @font-face 规则
     * @returns {string} 完整的帧文档
     */
    function buildFrameDocument(fontFaceCss) {
      return FRAME_JSON.replace(FRAME_FONTS_MARKER, fontFaceCss)
    }

    /** 构建脚本用的占位符，与 frame.html 里的名字一致。 */
    const FRAME_FONTS_MARKER = '__FRAME_FONTS__'
    const FRAME_JSON = /*__FRAME_DOCUMENT__*/
    const FRAME_LENGTH = FRAME_JSON.length

    // ---------------------------------------------------------------- the outer component

    /**
     * 当前主题。
     *
     * 帧自己读不到（独立文档），所以由父组件解析并烘焙进它。应用把偏好写在 <html> 上
     * （data-theme 或 class="dark"）；两者都没有时回落到 prefers-color-scheme。
     *
     * @returns {'light'|'dark'}
     */
    function readTheme() {
      try {
        const root = document.documentElement
        if (root !== null && root !== undefined) {
          const declared = root.getAttribute('data-theme')
          if (declared === 'dark' || declared === 'light') return declared
          if (root.classList && root.classList.contains('dark')) return 'dark'
        }
        if (typeof window !== 'undefined' && window.matchMedia) {
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        }
      } catch (error) {
        ping('theme-probe-failed', String(error && error.message))
      }
      return 'light'
    }

    function LuzzyPage(props) {
      try {
        // 记下会话 id，供握手监听器使用。帧启动后才会来问，所以那时值已经在。
        currentSessionId = props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null

        // 只在**首次**渲染上报。这一句在组件体内，每次渲染都 ping 就等于每个重渲染一个
        // ping——宿主 diag 路由一次 ping 写一行，一个会话攒了 384 行。首帧那一行才是有用的证据。
        if (!firstRenderReported) {
          firstRenderReported = true
          ping('luzzy-page-render', { frameBytes: FRAME_LENGTH, session: currentSessionId === null ? 'absent' : 'present' })
        }
        return jsx('iframe', {
          className: 'luzzy-page-frame',
          title: 'Luzzy 控制台',
          // 帧文档构建一次，之后永不重建。
          //
          // 这里曾经是 buildFrameDocument(FONT_CASE_CSS, theme)，每次渲染新建一个 394 KB 的
          // 字符串。React 按值比较 srcDoc，于是每次重渲染都像是新文档并**重载 iframe**，
          // 把帧正在做的事打断、从头再来。
          srcDoc: FRAME_DOCUMENT,
          style: {
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
            background: 'transparent',
          },
        })
      } catch (error) {
        ping('luzzy-page-render-failed', String(error && error.message))
        return jsx('div', {
          style: { padding: '24px', color: '#ec5e41', fontSize: '13px' },
          children: 'Luzzy 控制台渲染失败：' + String(error && error.message),
        })
      }
    }

    // 帧需要占满视口高度；插槽出口是一个 contents-anchor，所以尺寸来自帧本身加这一条规则。
    const FRAME_CSS =
      '.luzzy-page-frame{box-sizing:border-box;width:100%;height:100%;min-height:100%;border:0;display:block;background:transparent}' +
      '.luzzy-page-frame{min-height:calc(100vh - 48px)}'

    // 只在模块加载时构建一次。文档含内联字体，每个渲染、每个主题都完全相同。
    const FRAME_DOCUMENT = buildFrameDocument(FONT_FACE_CSS)

    // 首次渲染时置位，让黑匣子只报一次，而不是每次重渲染都报。
    let firstRenderReported = false

    function injectStyles() {
      if (document.querySelector('style[data-plugin-css="luzzy-page"]') !== null) return
      const style = document.createElement('style')
      style.dataset.pluginCss = 'luzzy-page'
      style.textContent = FRAME_CSS
      document.head.appendChild(style)
    }

    /**
     * 让帧的主题跟上应用的主题。
     *
     * 帧有自己的 :root，所以它继承不到主题变化；父组件把当前值镜像到帧文档的
     * data-theme 属性上。MutationObserver 挂在 <html> 上，切换开关因此无需刷新即可生效，
     * 且和其它一切一样通过 ctx.effect 拆除。
     */
    function followTheme(ctx) {
      const apply = () => {
        const theme = readTheme()
        if (typeof document.querySelectorAll !== 'function') return
        for (const frame of document.querySelectorAll('iframe.luzzy-page-frame')) {
          try {
            const inner = frame.contentDocument
            if (inner && inner.documentElement) inner.documentElement.setAttribute('data-theme', theme)
          } catch (error) {
            // 帧还在加载时跨文档访问可能失败，这不是错误。
          }
        }
      }

      apply()

      // 文档是一个固定字符串，且总是从浅色开始（不能按主题构建，那会重载帧）。所以帧真正
      // 存在之后要主动交给它一次当前主题，否则暗色用户会看到浅色页直到下一次主题切换。
      // `load` 按帧文档触发。
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('load', apply, true) // capture: iframe load 不冒泡
        ctx.effect(() => () => document.removeEventListener('load', apply, true), 'luzzy-page: frame load listener')
      }

      if (typeof MutationObserver === 'function' && document.documentElement) {
        const observer = new MutationObserver(apply)
        try {
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
          ctx.effect(() => () => observer.disconnect(), 'luzzy-page: theme observer')
        } catch (error) {
          ping('theme-observer-failed', String(error && error.message))
        }
      }

      // OS 级偏好，用于应用跟随系统而不是显式选择的情况。
      try {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
          const media = window.matchMedia('(prefers-color-scheme: dark)')
          if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', apply)
            ctx.effect(() => () => media.removeEventListener('change', apply), 'luzzy-page: system theme listener')
          }
        }
      } catch (error) {
        ping('theme-media-failed', String(error && error.message))
      }
    }

    const inject = ['slots', 'locale', 'sessions', 'workspaces']

    /**
     * 应用的会话与工作区服务，供帧使用。
     *
     * 要让用户**看得见**地新建会话，必须用应用自己的会话服务：它挂工作区，然后选中会话，
     * 而空白会话只在它是当前选中的那一个时才渲染。工作区服务在这里是因为「哪个工作区
     * 拥有这个目录」是**客户端**查询 —— 放到宿主上会让整条路径依赖宿主 bundle 是新的，
     * 而宿主不热重载。
     *
     * 帧两样都调不了（它是独立文档，没有客户端导航的句柄），所以它用 postMessage 问，
     * 这些值负责应答。
     *
     * 挂在模块级而不是每帧一份，因为每个应用只有一个客户端服务，所有挂载的 LuzzyPage 共用。
     */
    let appSessions = null
    let appWorkspaces = null

    /**
     * 应答帧的 postMessage 请求。
     *
     * 两类，都是帧自己做不了的事：
     *
     *   1. `want-session` —— 我是哪个会话？帧是 about:srcdoc 文档，window.location 是父
     *      应用的 URL，而 srcDoc 压过 src，所以 URL 里的 sessionId 它读不到。
     *   2. `create-session` —— 建一个新会话。这一步**必须**在客户端做：空白会话只在它是
     *      当前选中项时才由侧栏渲染，所以「建了但不选中」等于建了一个用户看不见的东西。
     *      应用自己的客户端服务两件都做，而只有这一半持有它。
     *
     * 监听器通过 ctx.effect 安装，卸载时移除，而不是留下一个往已销毁上下文里写东西的处理器。
     *
     * 应答发给 event.source（提问的那个窗口），所以不是本插件的帧读不到会话 id，
     * 也不能靠发一条消息驱动创建。
     */
    function followSession(ctx) {
      const onMessage = (event) => {
        const data = event && event.data
        if (data === null || typeof data !== 'object') return
        if (data.source !== 'luzzy-page-frame') return
        const source = event.source
        if (source === null || source === undefined) return

        if (data.type === 'want-session') {
          try {
            source.postMessage({ source: 'luzzy-page-host', type: 'session', sessionId: currentSessionId ?? null }, '*')
          } catch (error) {
            ping('session-handshake-failed', String(error && error.message))
          }
          return
        }

        if (data.type === 'create-session') {
          createSessionForFrame(source, data)
          return
        }
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', onMessage)
        ctx.effect(() => () => window.removeEventListener('message', onMessage), 'luzzy-page: session handshake')
      }
    }

    /**
     * 在客户端建一个会话——那里才能同时把它选中。
     *
     * 这是「新建会话始终无法在 DSH 内显示」的修复。宿主机建出来的会话不可见有两个独立的
     * 结构性原因，缺一个就足以让它隐身：
     *
     *   1. `sessionController.create` **只从 workspaceId 挂工作区**。传 cwd 会建出一个不属于
     *      任何工作区的会话，因此进不了任何工作区的 sessionIds —— 而侧栏是按工作区分组列的。
     *   2. 即便挂上了，侧栏也只在空白会话**是当前选中项**时才渲染它
     *      （`sessionVisible`: `!session.blank || session.id === current`）。新建的会话按定义
     *      就是空白，所以「挂上但不选中」仍然什么都看不到。
     *
     * 应用自己的客户端服务两件都做 —— create 然后 open —— 这正是侧栏那个「新会话」按钮
     * 能工作的原因。在这里跑它不是绕路：那就是 harness 自己的路径，而帧走不了，因为
     * 选中是它没有句柄的客户端状态。
     *
     * 工作区在**这里**解析，不在宿主上
     * ----------------------------------
     * 早先的版本通过宿主路由问 resolveWorkspace。那条路由属于**宿主** bundle，而宿主不热
     * 重载 —— 于是在客户端修好到下次重启 DSH 之间，页面调用了一个运行中的宿主**从没听过**
     * 的操作，拿到「未知操作 "resolveWorkspace"」。这件事完全不需要宿主：客户端自己的
     * workspaces 服务就暴露了每个工作区的 workspaceId 与 path，解析它需要的就这些。
     * 放在这里意味着整条创建路径在同一半里，没有版本偏斜可言。
     *
     * @param {Window} source - 提问的帧，结果回给它
     * @param {object} request - 帧的消息
     */
    function createSessionForFrame(source, request) {
      const reply = (payload) => {
        try {
          source.postMessage({ source: 'luzzy-page-host', type: 'session-created', ...payload }, '*')
        } catch (error) {
          ping('session-create-reply-failed', String(error && error.message))
        }
      }

      const sessions = appSessions
      if (sessions === null || typeof sessions.create !== 'function') {
        ping('session-create-unavailable')
        reply({ ok: false, detail: '这个界面没有把会话服务暴露给插件。请在左侧工作区用「新会话」按钮，再把预设切到 LuzzyMode。' })
        return
      }

      const fromSessionId = typeof request.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : currentSessionId

      // 这个会话的目录归哪个已注册工作区？读客户端自己的清单，它带着每个工作区的 id 与规范路径。
      let cwd = null
      try {
        const summaries = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
        const summary = summaries && fromSessionId !== null ? summaries.byId && summaries.byId[fromSessionId] : null
        cwd = summary && typeof summary.cwd === 'string' ? summary.cwd : null
      } catch (error) {
        ping('session-create-cwd-failed', String(error && error.message))
      }

      let workspaceId = null
      let seen = []
      if (cwd !== null) {
        try {
          const snapshot = appWorkspaces && appWorkspaces.list && typeof appWorkspaces.list.getSnapshot === 'function'
            ? appWorkspaces.list.getSnapshot()
            : null
          const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
          seen = items.map((item) => item.path)
          // 路径按大小写不敏感比较：Windows 的写法经常只差大小写（C:\Users\... vs c:\users\...），
          // 宿主用的是同一套规范化。
          const owner = items.find((item) => typeof item.path === 'string' && item.path.toLowerCase() === cwd.toLowerCase())
          workspaceId = owner ? owner.workspaceId : null
        } catch (error) {
          ping('session-create-workspace-failed', String(error && error.message))
        }
      }

      const createRequest = workspaceId ? { workspaceId } : (cwd ? { cwd } : {})
      ping('session-create-start', JSON.stringify({ workspaceId, cwd, known: seen.length }))

      sessions.create(createRequest).then((created) => {
        const id = typeof created === 'string' ? created : created && (created.sessionId || created.id)
        if (typeof id !== 'string' || id === '') throw new Error('会话创建了，但没拿到它的 id')
        ping('session-create-ok', JSON.stringify({ sessionId: id, workspaceId }))

        // 选中它。少了这一步会话就是空白的，因此不可见。
        let opened = false
        try {
          if (typeof sessions.open === 'function') {
            sessions.open(id)
            opened = true
          }
        } catch (error) {
          ping('session-create-open-failed', String(error && error.message || error))
        }

        // 趁它还是空的时候切到 LuzzyMode —— DSH 只允许在这一个窗口里换会话预设。
        // 这里失败要如实报，不隐藏：会话已经建好且**可见**，只是预设还要再点一下。
        presetPostViaHost(id).then((switched) => {
          if (switched.ok) {
            reply({ ok: true, sessionId: id, opened, detail: opened ? '会话已创建并切换过去。' : '会话已创建，请在左侧会话列表里打开它。' })
          } else {
            reply({
              ok: true,
              sessionId: id,
              opened,
              detail: '会话已创建' + (opened ? '并切换过去' : '') + '，但没能自动切到 LuzzyMode：' + switched.detail +
                '。在「预设」页对新会话点「切到 LuzzyMode」即可。',
            })
          }
        })
      }).catch((error) => {
        const why = String(error && error.message || error)
        ping('session-create-failed', why)
        reply({ ok: false, detail: why })
      })
    }

    /**
     * 请宿主半把一个会话切到 LuzzyMode，并报告结果。
     *
     * 用 fetch 而不是消息，因为这是宿主自己的领域：预设锁是宿主侧的投影，而页面本来就
     * 通过那条路由读它的状态。答复从响应体里读，所以拒绝会带着理由回来。
     *
     * @returns {Promise<{ok: boolean, detail: string}>}
     */
    function presetPostViaHost(sessionId) {
      return fetch('/__luzzy/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'switchSession', sessionId }),
      })
        .then((response) => (response.ok ? response.json() : response.text().then((body) => Promise.reject(new Error(body)))))
        .then(() => ({ ok: true, detail: '' }))
        .catch((error) => ({ ok: false, detail: String(error && error.message || error) }))
    }

    // 插槽条目注入的会话 id。每次渲染都会设置 —— 见 LuzzyPage。
    let currentSessionId = null

    function apply(ctx) {
      injectStyles()
      ping('apply-entered')

      // 应用的会话与工作区服务。抓下来，帧的创建请求要够到它们；在别处建会话不可能让它可见
      // （见 createSessionForFrame）。
      appSessions = ctx.sessions ?? null
      appWorkspaces = ctx.workspaces ?? null
      ping('sessions-service', appSessions === null ? 'absent' : 'present')

      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'luzzy-page: dictionaries')

      followTheme(ctx)
      followSession(ctx)

      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'luzzy-page',
            order: 100,
            label: () => t('view.luzzy'),
            locale: NS,
            // sessionId 不在 conversation.view 默认传的 props 里（那些是 viewRequest /
            // openView / completeViewRequest）。条目级的 inject 就是注册项索取它的方式 ——
            // dsh-client-ui-trajectory 用自己的 view 用的就是这个机制。返回的对象会被展开
            // 进组件的 props，所以下面 props.sessionId 可用。
            inject: (sessionId) => ({ sessionId }),
          },
          LuzzyPage,
        ),
      )
      ping('registered')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
