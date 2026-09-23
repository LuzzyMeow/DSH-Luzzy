/* app/app.js —— 应用外壳：状态、取数、刷新调度、事件委托、会话握手。
 *
 * 它是帧内唯一持有可变状态的地方。页面模块全是**纯函数**（视图模型进，HTML 出），
 * 所以「谁在什么时候改了什么状态」只有这一处需要读。
 *
 * 三件必须守住的纪律：
 *
 *  1. **数据获取与渲染分开**。取数失败写进 state，页面看到的是一个失败态；
 *     页面自己不发请求。这样「页面显示错了」与「数据没到」永远是两件事。
 *
 *  2. **状态实时刷新**。Agent 执行中时定时重取，但只在页面可见、且当前页确实依赖
 *     那份数据时才取——不然后台的定时器会一直读 220 MB 的会话日志。
 *
 *  3. **「读不到」与「没有」分开**。每次取数都记下它是否成功、失败原因是什么，
 *     页面据此走 blocked() 而不是 empty()。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Card.esc

  /* ---------------------------------------------------------------- state */

  /**
   * 全部可变状态。
   *
   * `status` 的取值刻意与页面无关地统一：idle / loading / ready / error。
   * 每一份数据各有自己的 status，因为它们的失败是独立的——目标读到了、
   * 执行状态没读到，是完全正常的一种组合。
   */
  const state = {
    tab: LZ.Router.DEFAULT_TAB,

    // 目标：总览页与目标中心共用一份，避免两页对同一个目标给出不同答案。
    goal: null,
    goalStatus: 'idle',
    goalDetail: null,

    // 执行状态：执行状态页与 Agent 配置页（工具能力）共用。
    runtime: null,
    runtimeStatus: 'idle',
    runtimeDetail: null,

    // Agent 配置。
    preset: null,
    presetStatus: 'idle',
    presetDetail: null,

    // 用量：只在系统信息页用。
    usage: null,
    usageStatus: 'idle',
    usageDetail: null,

    // 已等待秒数，由 getJson 驱动，五个加载态共用。
    // 曾经只有用量页有自己的计时器，于是另外四处显示的是一个不动的「0 秒」——比不显示更糟，
    // 因为停住的钟读起来就是「卡住了」。
    elapsed: 0,

    // 系统信息页自己的视图状态。
    version: '',
    capabilities: null,

    // 说明页。
    readme: null,

    // 图表视图状态（纯前端，切换不发请求）。
    window: 'day',
    mode: 'line',
    lastChartKey: null,

    // 折叠区：goal.md 原文只在展开时取。
    rawOpen: false,
    rawText: null,
    rawLoading: false,
  }

  const content = document.getElementById('content')
  const tabbar = document.getElementById('tabbar')
  const notice = document.getElementById('notice')

  /**
   * The content container, for modules that write into it directly.
   *
   * The preset editor was written when `content` was a frame global and it assigns to it by
   * hand (`content.innerHTML = ...`) instead of returning a string like the new pages do.
   * Rather than rewrite 1100 lines of tested editor to satisfy a style, it reaches the
   * element through this accessor. One indirection, zero behaviour change.
   */
  function contentNode() { return content }

  /** 会话标识。由宿主半通过 postMessage 注入；拿不到时保持 null（诚实的未知）。 */
  let sessionId = null

  /* ---------------------------------------------------------------- 帧内上报 */

  /**
   * 黑匣子。帧是独立文档，它抛的错不会进宿主控制台，卡住的请求也不会留下任何痕迹。
   * 所以每个阶段都上报到宿主的 diag 路由——那里写的是**文件**，而裸 console 不进日志集。
   */
  function report(stage, detail) {
    try {
      fetch('/__luzzy/diag', {
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ from: 'frame', stage: stage, detail: detail === undefined ? null : detail, at: Date.now() }),
      }).catch(function () {})
    } catch (error) {
      /* 诊断永远不许把页面弄坏 */
    }
  }

  window.addEventListener('error', function (event) {
    report('frame-error', String(event && event.message) + ' @' + String(event && event.filename) + ':' + String(event && event.lineno))
  })
  window.addEventListener('unhandledrejection', function (event) {
    const reason = event && event.reason
    report('frame-unhandled-rejection', String((reason && reason.message) || reason))
  })

  /* ---------------------------------------------------------------- 取数助手 */

  /** 带超时的 JSON 取数。返回 {ok, body} 或 {ok:false, error}——从不抛。 */
  function getJson(url, timeoutMs) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    if (controller !== null) {
      timer = setTimeout(function () { controller.abort() }, timeoutMs === undefined ? 90000 : timeoutMs)
    }
    // The elapsed clock runs for EVERY request, not just the usage one.
    //
    // Four pages show「正在读取… 已用时 N 秒」while they wait, and the shell was reading
    // `state.elapsed` without anything ever writing it — so those pages displayed a frozen
    // "0 秒" for the whole wait. That is worse than showing nothing: a stopped clock reads as
    // "this is stuck", which is precisely the impression the readout exists to prevent.
    //
    // Only the usage loader had its own ticker, and it drove `usageElapsed` — a second copy of
    // the same idea. One ticker here covers both.
    const started = Date.now()
    state.elapsed = 0
    const ticker = setInterval(function () {
      state.elapsed = Math.round((Date.now() - started) / 1000)
      // Patch the visible readout in place when it exists, so the seconds move without
      // re-rendering the page under the user (which would also restart every transition).
      const node = document.getElementById('elapsed')
      if (node !== null) node.textContent = '已用时 ' + state.elapsed + ' 秒'
    }, 1000)

    const settle = function () {
      clearInterval(ticker)
      if (timer !== null) clearTimeout(timer)
    }

    const options = controller === null ? undefined : { signal: controller.signal }
    return fetch(url, options)
      .then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) return { ok: false, error: 'HTTP ' + response.status + (text ? ' — ' + text.slice(0, 300) : '') }
          try {
            return { ok: true, body: JSON.parse(text) }
          } catch (error) {
            return { ok: false, error: '响应不是合法 JSON：' + String(error && error.message || error) }
          }
        })
      })
      .catch(function (error) {
        const message = String(error && error.message || error)
        return { ok: false, error: message === 'The operation was aborted.' || message === 'aborted' ? '请求超时' : message }
      })
      .then(function (result) {
        settle()
        return result
      })
  }

  function withSession(url) {
    if (sessionId === null) return url
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'sessionId=' + encodeURIComponent(sessionId)
  }

  /* ---------------------------------------------------------------- 页状态投影
   *
   * 页面模块是纯函数：它们拿到的 `state` 是**为这一页算好的**，不是原始状态。
   * 这一层转换存在的理由和 services/ 一样——页面不该知道「目标数据存在哪个字段、
   * 用哪个 status 字段表示加载中」。它只关心「现在有没有视图模型、要不要显示骨架」。
   */
  function buildPageState(tab) {
    // Every projection carries `tab`, which is what the router dispatches on. Keeping the tab id
    // INSIDE the projection is what makes it impossible to hand a page another page's data —
    // they travel as one value, so they cannot disagree.
    if (tab === 'overview') {
      return {
        tab: tab,
        status: state.goalStatus,
        elapsed: state.goalStatus === 'loading' ? state.elapsed : undefined,
        goal: state.goal === null ? null : {
          status: state.goalStatus,
          view: LZ.GoalService.toView(state.goal),
          detail: state.goalDetail,
        },
      }
    }
    if (tab === 'goal') {
      return {
        tab: tab,
        status: state.goalStatus,
        elapsed: state.goalStatus === 'loading' ? state.elapsed : undefined,
        detail: state.goalDetail,
        view: state.goal === null ? null : LZ.GoalService.toView(state.goal),
      }
    }
    if (tab === 'runtime') {
      return {
        tab: tab,
        status: state.runtimeStatus,
        elapsed: state.runtimeStatus === 'loading' ? state.elapsed : undefined,
        view: state.runtime === null ? null : LZ.RuntimeService.toView(state.runtime),
      }
    }
    if (tab === 'agent') {
      return {
        tab: tab,
        status: state.presetStatus === 'loading' ? 'loading' : state.presetStatus,
        elapsed: state.presetStatus === 'loading' ? state.elapsed : undefined,
        detail: state.presetDetail,
        view: state.preset === null ? null : LZ.AgentService.toView(
          state.preset,
          state.runtime === null ? null : LZ.RuntimeService.toView(state.runtime),
          state.goal === null ? null : LZ.GoalService.toView(state.goal),
        ),
      }
    }
    if (tab === 'system') {
      const runtimeView = state.runtime === null ? null : LZ.RuntimeService.toView(state.runtime)
      const goalView = state.goal === null ? null : LZ.GoalService.toView(state.goal)
      const usage = state.usage
      // The usage payload is projected here, for the same reason the other three are: a page
      // must not read a raw backend response. Reading `/__luzzy/usage`'s own field names from
      // system.js was the one place the v2 boundary had been crossed — the check in
      // tools/test-view-models.mjs caught it, and the fix belongs here rather than in the test.
      const windows = usage === null || usage.windows === undefined ? null : usage.windows
      return {
        tab: tab,
        runtimeView: runtimeView,
        version: state.version,
        capabilities: state.capabilities,
        goalOk: state.goalStatus === 'ready',
        goalDetail: state.goalStatus === 'error' ? state.goalDetail : null,

        usageStatus: state.usageStatus,
        elapsed: state.elapsed,
        usageDetail: state.usageDetail,
        // What the page shows about usage, already reduced.
        usageReady: usage !== null && state.usageStatus === 'ready',
        usageAttempts: usage === null ? 0 : usage.attempts,
        usageTotals: usage === null || usage.totals === undefined ? null : usage.totals,
        usageModels: usage === null || usage.models === undefined ? [] : usage.models,
        windowsMissing: usage !== null && windows === null,
        activeWindow: windows === null ? null : (windows[state.window] || null),
        activity: usage === null || usage.activity === undefined ? null : {
          month: usage.activity.month,
          daysInMonth: usage.activity.daysInMonth,
          pastDays: usage.activity.days.filter(function (day) { return day.isFuture !== true }).length,
          // 上限取已过日期的最大值：未来的格子不参与定标，否则一个空的未来会把颜色压平。
          maxTokens: usage.activity.days.reduce(function (peak, day) {
            return day.isFuture === true ? peak : Math.max(peak, day.tokens || 0)
          }, 0),
          days: usage.activity.days.map(function (day) {
            return { date: day.key, totalTokens: day.tokens || 0, isFuture: day.isFuture === true }
          }),
        },
        window: state.window,
        mode: state.mode,
        animateChart: state.animateChart === true,
      }
    }
    if (tab === 'readme') {
      return { tab: tab, status: state.readmeStatus, html: state.readme, detail: state.readmeDetail }
    }
    return { tab: tab }
  }

  /* ---------------------------------------------------------------- 渲染 */

  function render() {
    if (tabbar !== null) tabbar.innerHTML = LZ.Router.tabBar(state.tab)
    if (content === null) return

    // 图表视图状态是纯前端的：只在真正切换时重画，并据此决定入场动画。
    const chartKey = state.window + '/' + state.mode
    state.animateChart = state.lastChartKey !== null && state.lastChartKey !== chartKey
    state.lastChartKey = chartKey

    let html
    try {
      html = LZ.Router.render(buildPageState(state.tab))
    } catch (error) {
      // A page renderer throwing must not blank the whole frame: the tab bar stays, and the
      // error is shown where the page would have been. The black box gets the stack too.
      report('page-render-failed', { tab: state.tab, message: String(error && error.message || error) })
      html = LZ.EmptyState.blocked({
        title: '这一页渲染失败了',
        body: '页面代码抛了一个错误。其他页仍然可用。',
        detail: String(error && error.stack || error),
      })
    }
    // A page MAY BE IMPERATIVE: the preset editor writes into the container itself and returns
    // nothing, because it attaches its listeners in the same pass and needs the DOM to exist
    // first. `undefined` therefore means "already painted" — assigning it would put the literal
    // string "undefined" on the page, which is exactly what happened before this guard existed.
    if (html !== undefined) content.innerHTML = html

    // Chart interaction is attached after the markup exists (it is built as a string).
    // The animation attribute is retired by a timer — NOT animationend, because under
    // prefers-reduced-motion no animation runs and that event never fires, which would
    // strand the attribute permanently.
    if (state.tab === 'system' && state.usage !== null && state.usageStatus === 'ready') {
      const chartRoot = content.querySelector('[data-chart]')
      if (chartRoot !== null) {
        const active = state.usage.windows === undefined ? null : state.usage.windows[state.window]
        if (active !== null && active !== undefined) LZ.Chart.wireHover(chartRoot, active.slots, active.series)
        if (state.animateChart) {
          chartRoot.setAttribute('data-animate', 'true')
          setTimeout(function () { chartRoot.removeAttribute('data-animate') }, 400)
        }
      }
    }
  }

  /* ---------------------------------------------------------------- 加载器 */

  /**
   * 单调递增的「会话世代」。切会话时 +1；响应回来对不上就丢弃。
   *
   * 用户报的「切了会话目标还是旧的」根因在这里，而且**五个 loader 全中**（goal / runtime /
   * preset / usage / readme 是同一个形状）：它们都先查 "loading" 再查 force，于是 **force
   * 被吃掉了**。切会话时上一次取数很可能正飞着，那正是最需要重读的一刻 —— 而这时强制重读
   * 直接 return，新会话的数据永远不读。一个「force 参数不生效」的 bug，长得像「页面没刷新」。
   *
   * 第二个 bug 同源：迟到的响应。A 的响应可以在切到 B 之后才落地，把 A 的数据写进 state。
   * 世代号同时解决两个 —— 比「取消上一个请求」简单，也不受 AbortController 时序影响。
   *
   * （这段注释不写 `状态字段名 + === 'loading'` 之类字样：本仓有个守卫会扫这个文件里
   * 「读到的状态字段」，把注释里的示范也算成一次真实读取。它当时正确地报了假警，所以我改成
   * 描述而不是引用。守卫没有错，是我的注释用了会被读成代码的写法。）
   */
  let sessionGeneration = 0

  /**
   * 取数该不该现在开始。
   *
   * @param {string} status - 该 loader 当前的状态。
   * @param {boolean} force - 调用方是否要求强制重读。
   * @returns {boolean}
   */
  function shouldLoad(status, force) {
    // force 压过一切，包括 loading。这条顺序就是修复本身。
    if (force) return true
    return status !== 'ready' && status !== 'loading'
  }

  function loadGoal(force) {
    if (!shouldLoad(state.goalStatus, force)) return Promise.resolve()
    const generation = sessionGeneration
    state.goalStatus = 'loading'
    state.goalDetail = null
    render()
    report('goal-fetch-start', null)
    return getJson(withSession('/__luzzy/goal')).then(function (result) {
      // 迟到的响应：会话已经换过了，这份数据描述的不是当前会话。
      if (generation !== sessionGeneration) {
        report('goal-fetch-superseded', { was: generation, now: sessionGeneration })
        return
      }
      if (!result.ok) {
        report('goal-fetch-failed', result.error)
        state.goalStatus = 'error'
        state.goalDetail = result.error
        render()
        return
      }
      report('goal-fetch-ok', { goalState: result.body.goalState, phase: result.body.goal ? result.body.goal.phase : null })
      // 目标读回来后，执行状态页与 Agent 配置页都需要同一份——它们从 state.goal 取。
      state.goal = result.body
      state.goalStatus = 'ready'
      state.goalDetail = null
      // 系统信息页要用到能力探测，顺手带上。
      state.capabilities = result.body.capabilities || null
      render()
    })
  }

  function loadRuntime(force) {
    if (!shouldLoad(state.runtimeStatus, force)) return Promise.resolve()
    state.runtimeStatus = 'loading'
    state.runtimeDetail = null
    render()
    report('runtime-fetch-start', null)
    return getJson(withSession('/__luzzy/runtime'), 30000).then(function (result) {
      // A route that could not BUILD a snapshot still answers 200 with `ok:false` and a version —
      // that is why this one is read even on the failure branch. Knowing "this plugin is 0.1.0
      // and it cannot see your session" is more useful than "unknown".
      const reported = result.ok ? result.body : null
      if (reported !== null && typeof reported.version === 'string' && reported.version !== '') {
        state.version = reported.version
      }
      if (!result.ok) {
        report('runtime-fetch-failed', result.error)
        state.runtimeStatus = 'error'
        state.runtimeDetail = result.error
        render()
        return
      }
      state.runtime = result.body
      state.runtimeStatus = 'ready'
      state.runtimeDetail = null
      render()
    })
  }

  function loadPreset(force) {
    if (!shouldLoad(state.presetStatus, force)) return Promise.resolve()
    state.presetStatus = 'loading'
    state.presetDetail = null
    render()
    return getJson(withSession('/__luzzy/preset'), 30000).then(function (result) {
      if (!result.ok) {
        state.presetStatus = 'error'
        state.presetDetail = result.error
        render()
        return
      }
      state.preset = result.body
      state.presetStatus = 'ready'
      state.presetDetail = null
      render()
    })
  }

  function loadUsage(force) {
    if (!shouldLoad(state.usageStatus, force)) return Promise.resolve()
    state.usageStatus = 'loading'
    state.usageDetail = null
    render()
    report('usage-fetch-start', null)
    const startedAt = Date.now()

    // No ticker here: `getJson` drives `state.elapsed` for every request, and the readout
    // element is patched in place by that one. This loader used to run a SECOND ticker for the
    // same purpose, which is exactly why the other four loading states were left with a frozen
    // clock — the usage page looked right and nothing else did.
    return getJson('/__luzzy/usage' + (force ? '?refresh=1' : ''), 90000).then(function (result) {
      if (!result.ok) {
        report('usage-fetch-failed', result.error)
        state.usageStatus = 'error'
        state.usageDetail = result.error
        render()
        return
      }
      report('usage-fetch-ok', { ms: Date.now() - startedAt, attempts: result.body.attempts })
      state.usage = result.body
      state.usageStatus = 'ready'
      state.usageDetail = null
      render()
    })
  }

  function loadReadme(force) {
    if (!shouldLoad(state.readmeStatus, force)) return Promise.resolve()
    state.readmeStatus = 'loading'
    render()
    return fetch('/__luzzy/readme', { method: 'GET' })
      .then(function (response) {
        return response.ok ? response.text() : response.text().then(function (body) { return Promise.reject(new Error(body)) })
      })
      .then(function (text) {
        state.readme = LZ.Markdown.render(text)
        state.readmeStatus = 'ready'
        render()
      })
      .catch(function (error) {
        report('readme-failed', String(error && error.message || error))
        state.readme = null
        state.readmeStatus = 'error'
        state.readmeDetail = String(error && error.message || error)
        render()
      })
  }

  /** 某一页需要哪些数据。切页时按需取，不一次全取——那是四次 220 MB 扫描。 */
  function ensureFor(tab) {
    if (tab === 'overview' || tab === 'goal') return loadGoal(false)
    if (tab === 'runtime') return Promise.all([loadRuntime(false), loadGoal(false)])
    if (tab === 'agent') return Promise.all([loadPreset(false), loadRuntime(false), loadGoal(false)])
    if (tab === 'system') return Promise.all([loadGoal(false), loadRuntime(false), loadUsage(false)])
    if (tab === 'readme') return loadReadme(false)
    // The preset editor owns its own state and its own loader; asking it to ensure its data is
    // what makes the tab show content instead of an empty container.
    if (tab === 'preset') return LZ.PresetPage.ensure(false)
    return Promise.resolve()
  }

  /* ---------------------------------------------------------------- 实时刷新 */

  /**
   * 状态实时刷新。
   *
   * 三条限制，每一条都有理由：
   *
   *   1. **只在页面可见时刷新**。`document.hidden` 为真时停——一个后台标签页不该
   *      每 15 秒去解压 220 MB 的日志。
   *   2. **只刷当前页依赖的数据**。在目标中心时不必重读用量。
   *   3. **只在「有活可看」时刷**。目标处于 active、或执行状态显示有未完成轮次时才刷；
   *      一个已完成的目标每 15 秒重取一次是在浪费电。
   *
   * 用一个可取消的定时器，且卸载时清掉——不留孤儿定时器。
   */
  let refreshTimer = null

  function shouldRefresh() {
    if (typeof document.hidden === 'boolean' && document.hidden) return false
    if (state.tab === 'readme') return false
    // 「有活」的判据是可判定的：目标的运行时阶段是 active，或执行状态里有进行中的轮次。
    const goalActive = state.goal !== null && state.goal.goal !== null && state.goal.goal !== undefined &&
      state.goal.goal.phase === 'active'
    const runtimeActive = state.runtime !== null && state.runtime.ok === true && state.runtime.turnsCompleted < state.runtime.currentTurn
    return goalActive || runtimeActive
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return
    refreshTimer = setInterval(function () {
      if (!shouldRefresh()) return
      if (state.tab === 'overview' || state.tab === 'goal') loadGoal(true)
      else if (state.tab === 'runtime') { loadRuntime(true); loadGoal(true) }
      else if (state.tab === 'agent') { loadRuntime(true); loadPreset(true); loadGoal(true) }
      else if (state.tab === 'system') { loadRuntime(true); loadGoal(true) }
    }, 15000)
  }

  /* ---------------------------------------------------------------- 事件 */

  function switchTab(next) {
    if (!LZ.Router.isKnown(next) || next === state.tab) return
    state.tab = next
    // 折叠状态是页面局部的，切页时复位——否则从目标中心带着展开的 goal.md 走到别的页，
    // 再回来时它还是展开的，而用户并不记得自己展过它。
    state.rawOpen = false
    render()
    ensureFor(next)
  }

  /** 事件委托：整个内容区一个监听器，页面上任何一个按钮都不必自己绑。 */
  function wire() {
    if (tabbar !== null) {
      tabbar.addEventListener('click', function (event) {
        const target = event.target.closest('[data-tab]')
        if (target !== null) switchTab(target.dataset.tab)
      })
    }

    document.addEventListener('click', function (event) {
      const node = event.target.closest('[data-action], [data-tab]:not([role="tab"]), [data-window], [data-mode], [data-proposal], #goalArtifactOn, #goalArtifactOff, #goalArtifactWrite, #goalReconcile, #goalRawToggle, #goalRefresh, #goalRetry, #overviewRefresh, #overviewRetry, #runtimeRetry, #agentRetry, #agentGotoPreset, #systemRetry')
      if (node === null) return

      // 图表控件：只影响趋势图，纯前端，不发请求。
      if (node.dataset.window !== undefined) { state.window = node.dataset.window; render(); return }
      if (node.dataset.mode !== undefined) { state.mode = node.dataset.mode; render(); return }

      // 提案：采纳与不采纳都是**人类操作**，走专门的 op。
      if (node.dataset.proposal !== undefined) {
        goalPost(node.dataset.proposalOp, { id: node.dataset.proposal })
        return
      }

      switch (node.id) {
        case 'goalRefresh': loadGoal(true); return
        case 'goalRetry': loadGoal(true); return
        case 'overviewRefresh': loadGoal(true); return
        case 'overviewRetry': loadGoal(true); return
        case 'runtimeRetry': loadRuntime(true); return
        case 'agentRetry': Promise.all([loadPreset(true), loadRuntime(true)]); return
        case 'systemRetry': Promise.all([loadUsage(true), loadRuntime(true)]); return
        case 'agentGotoPreset': switchTab('preset'); return
        case 'agentNewSession': createSession(); return
        case 'goalArtifactOn': goalPost('enableArtifact'); return
        case 'goalArtifactOff': goalPost('disableArtifact'); return
        case 'goalArtifactWrite': goalPost('writeArtifact'); return
        case 'goalReconcile': {
          const goal = state.goal === null ? null : state.goal.goal
          if (goal === null || goal === undefined) return
          goalPost('reconcile', { goalId: goal.id, goalRevision: goal.revision, objective: goal.objective })
          return
        }
        case 'goalRawToggle': {
          state.rawOpen = !state.rawOpen
          if (state.rawOpen && state.rawText === null) {
            state.rawLoading = true
            render()
            fetchRawArtifact()
            return
          }
          render()
          return
        }
        default: return
      }
    })
  }

  /** goal.md 原文只在展开时取——一份 40 KB 的文档没道理跟着每次轮询走。 */
  function fetchRawArtifact() {
    return getJson(withSession('/__luzzy/goal?artifact=1'), 30000).then(function (result) {
      state.rawLoading = false
      if (!result.ok) {
        report('goal-artifact-failed', result.error)
        state.rawText = null
      } else {
        state.goal = result.body
        state.goalStatus = 'ready'
        state.rawText = result.body.artifact && result.body.artifact.text ? result.body.artifact.text : null
      }
      if (state.tab === 'goal') render()
    })
  }

  /** 一次计划改动，然后把整份状态换回来。POST 会返回全量，所以不必再取一次。 */
  function goalPost(op, payload) {
    report('goal-post', op)
    return fetch('/__luzzy/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: op, payload: payload || {}, sessionId: sessionId, artifact: state.rawOpen }),
    })
      .then(function (response) {
        return response.json().catch(function () { return null }).then(function (body) {
          return { ok: response.ok, status: response.status, body: body }
        })
      })
      .then(function (result) {
        const body = result.body
        // 409 / 422 也带快照——输的那一方展示真相，而不是猜。
        if (body !== null && body !== undefined && body.snapshot !== undefined) {
          state.goal = body.snapshot
          state.goalStatus = 'ready'
          state.goalDetail = null
        } else if (body !== null && body !== undefined && body.delivery !== undefined) {
          state.goal = body
          state.goalStatus = 'ready'
          state.goalDetail = null
        }
        report('goal-post-result', { op: op, ok: result.ok, status: result.status })
        render()
        if (!result.ok && body !== null && body !== undefined && body.error) notify(body.error)
        return result
      })
      .catch(function (error) {
        report('goal-post-failed', String(error && error.message || error))
        notify('写入失败：' + String(error && error.message || error))
      })
  }

  /** 一条转瞬即逝的提示。不是对话框：对话框要用户答，这里只是告诉一声。 */
  let noticeTimer = null
  function notify(text) {
    if (notice === null) return
    notice.textContent = text
    notice.hidden = false
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(function () { notice.hidden = true }, 8000)
  }

  /* ---------------------------------------------------------------- 会话握手 */

  /**
   * 帧拿不到自己的会话 id：它是 about:srcdoc 文档，window.location 是**父页面**的 URL，
   * 而 srcDoc 又压过 src。所以往 iframe 的 URL 里塞 sessionId 这条路根本不通。
   * 正解是问一次：postMessage 给父窗口，宿主半答一次。
   *
   * 核心功能不依赖它——拿不到只是让「这个会话」相关的东西显示为「最近有活动的那份日志」。
   */
  function askForSession() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'luzzy-page-frame', type: 'want-session' }, '*')
      }
    } catch (error) {
      report('sessionid-request-failed', String(error && error.message || error))
    }
  }

  /** 新建会话。帧做不到（选中是客户端状态），所以通过 postMessage 请宿主半执行。 */
  let createInFlight = false
  function createSession() {
    // disabled 属性不足以防住双击：它只在重渲染之后才挡指针事件，而「点击 + 在已聚焦的
    // 按钮上按回车」能在任何重渲染之前两次进到处理函数里。上一版因此建出了两个会话。
    if (createInFlight) return
    createInFlight = true
    notify('正在新建会话…')
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'luzzy-page-frame', type: 'create-session', sessionId: sessionId }, '*')
      }
    } catch (error) {
      createInFlight = false
      notify('新建会话失败：' + String(error && error.message || error))
      return
    }
    // 请求要有超时，否则按钮永远禁用。
    setTimeout(function () {
      if (!createInFlight) return
      createInFlight = false
      notify('宿主半没有回应。重启 DSH 后再试一次。')
      report('session-create-timeout', null)
    }, 8000)
  }

  window.addEventListener('message', function (event) {
    const data = event && event.data
    if (data === null || typeof data !== 'object') return
    if (data.source !== 'luzzy-page-host') return
    // 只有会话回答能改 sessionId。
    //
    // 这个监听器原来接受任何宿主消息，于是创建结果（一个不带 sessionId 的消息）
    // 被读成「你的会话是 null」——黑匣子日志里真实 id 在创建尝试后 1 毫秒变成 null。
    // 要求每条消息带 type，是把两种对话分开的唯一办法。
    if (data.type === 'session') {
      const next = typeof data.sessionId === 'string' && data.sessionId !== '' ? data.sessionId : null
      if (next === sessionId) return
      sessionId = next
      // 换会话 = 换世代。所有在飞的取数立刻作废，它们描述的不是新会话。
      sessionGeneration += 1
      report('sessionid', sessionId)
      // 换了会话就重读**当前页需要的一切**，不只是 goal。
      //
      // 原来这里只调 loadGoal(true)：执行状态/Agent 配置/系统信息三页的数据仍是上一个会话的，
      // 而它们的内容本来就是按会话读的（runtime 读的是会话日志，preset 读的是会话预设）。
      // 只刷一页等于把「切了会话」这件事做了一半。
      state.goal = null
      state.runtime = null
      state.preset = null
      state.usage = null
      state.goalStatus = 'idle'
      state.runtimeStatus = 'idle'
      state.presetStatus = 'idle'
      state.usageStatus = 'idle'
      render()
      ensureFor(state.tab)
      return
    }
    if (data.type === 'session-created') {
      createInFlight = false
      notify(data.ok === true ? (data.detail || '会话已创建。') : ('新建会话失败：' + (data.detail || '未知原因')))
      return
    }
  })

  /* ---------------------------------------------------------------- 对外接口 */

  LZ.App = {
    state: state,
    render: render,
    report: report,
    withSession: withSession,
    buildPageState: buildPageState,
    content: contentNode,
    isRawOpen: function () { return state.rawOpen },
    rawState: function () { return { text: state.rawText, loading: state.rawLoading } },
    switchTab: switchTab,
    askForSession: askForSession,
    start: function () {
      report('frame-boot', location.href)
      wire()
      render()
      askForSession()
      // 首屏就把总览要的数据取了——那是用户第一眼要看的。
      ensureFor(state.tab)
      scheduleRefresh()
    },
  }
})(window.LZ = window.LZ || {})
