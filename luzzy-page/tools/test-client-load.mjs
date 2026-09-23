// Load the built client bundle in a Node sandbox and assert its registration contract.
//
// Restarting DSH is the only way to see the tab for real, but almost every way this
// plugin can be wrong shows up here first: a bad bundle path, an `import` that would
// pull a second React, a slot id that collides with chat/trajectory, a component that
// throws when rendered. Run this before restarting, not after.
//
// Usage: node tools/test-client-load.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadFrameBuilder, PLUGIN_ROOT as TOOLS_ROOT } from './frame-source.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// The frame the browser actually receives, produced by the shipped component. Asserted below
// instead of the old un-escaped template slice — see the note at the frame-contracts block.
const { srcDoc: frameHtml } = loadFrameBuilder()

// The OUTER bundle (the client half). It holds the DSH slot registration, the theme/session
// wiring, and `createSessionForFrame` — none of which live inside the frame, because the frame
// cannot navigate the app. Read once here so both halves can be asserted from one file.
const clientHalf = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

const failures = []
const notes = []

function check(label, condition, detail = '') {
  if (condition) {
    notes.push(`  ok   ${label}`)
  } else {
    failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------- sandbox

let loaded = null
let injectedCss = null
let injectedKey = null

globalThis.window = {
  // The page registers global error listeners at apply time (its flight recorder), so the
  // window stub has to carry the event API.
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
}

globalThis.document = {
  querySelector: () => null, // no pre-existing style tag
  querySelectorAll: () => [], // no frames mounted yet
  documentElement: {
    getAttribute: () => null,
    classList: { contains: () => false },
  },
  createElement: () => ({
    dataset: {},
    set textContent(value) {
      injectedCss = value
    },
  }),
  head: {
    appendChild: (el) => {
      injectedKey = el.dataset.pluginCss
    },
  },
}

// The bundle probes for these; a minimal DOM must not break registration.
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}

// The host's static module table; the bundle must require from here, never import.
//
// `react` is loaded for real rather than stubbed, so the component can actually be
// rendered with the real hooks — a stub would hide a bad hook call. `primitives` is
// stubbed because only MarkdownText is used and loading the real one drags in the whole
// editor stack.
//
// DSH_APP defaults to the standard install: requiring it to be set by hand meant this
// test silently failed to resolve React, so it was never actually run.
const appRoot = process.env.DSH_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app'
const React = require(join(appRoot, 'node_modules/react'))
const reactJsxRuntime = require(join(appRoot, 'node_modules/react/jsx-runtime'))

const ALLOWED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const primitivesStub = {
  MarkdownText: ({ text }) => reactJsxRuntime.jsx('div', { 'data-markdown': true, children: text }),
}

const mockRequire = (spec) => {
  if (!ALLOWED.has(spec)) {
    throw new Error(`require("${spec}") is not in the host's static module table`)
  }
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return reactJsxRuntime
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`no stub registered for "${spec}"`)
}

// ---------------------------------------------------------------- load

const source = readFileSync(join(PLUGIN_ROOT, 'lib/client.js'), 'utf8')
// The bundle is a script that calls window.__ModuleLoader__.load; run it as one.
new Function('window', 'document', source)(globalThis.window, globalThis.document)

check('bundle registers with the module loader', loaded !== null)
if (loaded === null) {
  console.log('  FAIL bundle never called window.__ModuleLoader__.load')
  process.exit(1)
}

// The loader's graph row id is the PACKAGE NAME. After the bundle executes it checks
// factories.has(id) with the package name, so a mismatch here fails the whole bundle
// load at startup ("loaded without registering ... via __ModuleLoader__.load").
// This is the exact bug that shipped in the first build — keep this assertion.
const packageName = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'),
).name
check(
  'entry id equals the package name (loader contract)',
  loaded.id === packageName,
  `got ${JSON.stringify(loaded.id)}, expected ${JSON.stringify(packageName)}`,
)
check('factory is a function', typeof loaded.factory === 'function')

const mod = loaded.factory(mockRequire)

check('exports.apply present', typeof mod.apply === 'function')
check('exports.inject is an array', Array.isArray(mod.inject), `got ${JSON.stringify(mod.inject)}`)
// `sessions` and `workspaces` are injected because creating a session the user can SEE
// requires the app's own client services: `sessions.create` attaches the workspace,
// `sessions.open` selects it (a blank session is rendered only while it is the current one),
// and `workspaces` is where the owning workspace id is found. A host route can create a
// session but cannot select one, which is why sessions created there were invisible.
check(
  'inject declares slots + locale + sessions + workspaces',
  Array.isArray(mod.inject) &&
    mod.inject.length === 4 &&
    mod.inject.includes('slots') &&
    mod.inject.includes('locale') &&
    mod.inject.includes('sessions') &&
    mod.inject.includes('workspaces'),
  `got ${JSON.stringify(mod.inject)}`,
)

// ---------------------------------------------------------------- apply

const registered = []
const dicts = []
let effectCount = 0

const mockCtx = {
  effect(fn, label) {
    effectCount += 1
    return fn()
  },
  locale: {
    register(ns, dictionaries) {
      dicts.push({ ns, dictionaries })
      return () => {}
    },
    bind(ns) {
      return (key) => {
        const dict = dicts.at(-1)?.dictionaries.zh ?? dictionariesFallback
        return dict[key] ?? key
      }
    },
  },
  slots: {
    inject(name, callback) {
      callback()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}

const dictionariesFallback = {}

mod.apply(mockCtx)

check('styles are injected', injectedCss !== null && injectedCss.length > 0)
check('style tag carries the dedupe key', injectedKey === 'luzzy-page', `got ${JSON.stringify(injectedKey)}`)
// The frame owns the fonts now (they are inlined INTO the frame document), so the plugin's
// own stylesheet must stay small and reference nothing external. The old assertion counted
// @font-face blocks HERE, which was true of the React version and is meaningless now.
check(
  'plugin css references nothing external',
  injectedCss !== null && !/url\((?!data:)/.test(injectedCss),
)
check(
  'plugin css gives the frame a height',
  injectedCss !== null && injectedCss.includes('.luzzy-page-frame') && injectedCss.includes('height'),
)
check('locale dictionaries registered', dicts.length >= 1 && dicts[0].ns === 'luzzy-page')
check('effects are scoped', effectCount >= 1, `saw ${effectCount}`)
check('exactly one view registered', registered.length === 1, `saw ${registered.length}`)

const entry = registered[0]
if (entry) {
  const { options, component } = entry

  check('slot name is conversation.view', options.name === 'conversation.view', `got ${options.name}`)
  check('id does not collide with the shipped views', options.id === 'luzzy-page', `got ${options.id}`)
  check('order sorts after trajectory (10)', options.order > 10, `got ${options.order}`)
  check('locale namespace is set', options.locale === 'luzzy-page', `got ${options.locale}`)
  check('label is a thunk', typeof options.label === 'function')

  const label = options.label()
  // The view's label is the console's name now. The plugin used to present itself as
  // "LuzzyPage" (a page); it is a console, and the tab should say so.
  check('label resolves to the console name', label === 'Luzzy 控制台', `got ${JSON.stringify(label)}`)

  // Structural check with a hook shim, not a render.
  //
  // react-dom is NOT resolvable as a package here — the host inlines ReactDOM into its
  // static module table instead of shipping a directory — so there is no renderer to call.
  // Instead the component body is invoked with hooks stubbed to their first-render values,
  // and the returned element tree is walked. That validates props, nesting and component
  // identity. Hook runtime behaviour (effects, state transitions) cannot be checked
  // headlessly and is covered by the screenshot acceptance step — see README.
  const t = (key) => dicts[0]?.dictionaries.zh[key] ?? key

  check('component is a named top-level function', component?.name === 'LuzzyPage', component?.name)

  // A fresh plugin instance whose `react` is shimmed, so calling the component body works.
  const shimmedReact = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }

  let body = null
  let bodyError = null
  /** Lifted out of the try block so the srcDoc-stability check can render again. */
  let probeComponent = null
  let probeProps = null
  try {
    const shimmedLoad = loaded.factory((spec) => {
      if (spec === 'react') return shimmedReact
      if (spec === 'react/jsx-runtime') return reactJsxRuntime
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(`no stub for ${spec}`)
    })

    // Re-apply on a capturing ctx to get the freshly built component.
    const captured = []
    shimmedLoad.apply({
      effect: (fn) => fn(),
      locale: {
        register: (ns, dictionaries) => {
          dicts.push({ ns, dictionaries })
          return () => {}
        },
        bind: () => (key) => dictionariesFallback.zh?.[key] ?? dicts.at(-1)?.dictionaries.zh[key] ?? key,
      },
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, view) => {
          captured.push({ options, component: view })
          return () => {}
        },
      },
    })

    const view = captured[0]?.component
    check('shimmed instance registers the view', view !== undefined)

    // Call the view with the EXACT props the host passes. The conversation.view render
    // call supplies only viewRequest / openView / completeViewRequest — NO `t`. An earlier
    // version destructured `t` from props, got undefined, threw on the first t(...) call,
    // and React unmounted the whole page — blank view, no error surface. Rendering with the
    // host's real prop shape is what catches that.
    //
    // Declared out here so the srcDoc-stability check below can render a second time.
    probeComponent = view
    probeProps = {
      viewRequest: null,
      openView: () => {},
      completeViewRequest: () => {},
    }
    body = view(probeProps)
  } catch (error) {
    bodyError = error
  }

  // A second call with a `t` prop must ALSO work (backwards compatibility), but the
  // host-shape call above is the one that reflects reality.
  check('component body executes with HOST props (no t injected)', bodyError === null, bodyError?.message)

  if (body !== null) {
    // jsx() produces plain { type, props } objects — walk them directly.
    const collect = (node, out = []) => {
      if (node === null || node === undefined) return out
      if (Array.isArray(node)) {
        node.forEach((child) => collect(child, out))
        return out
      }
      if (typeof node === 'object' && 'type' in node && 'props' in node) {
        out.push(node)
        collect(node.props.children, out)
      }
      return out
    }

    const nodes = collect(body)
    const classes = nodes.flatMap((n) => (n.props.className ? [n.props.className] : []))

    check('tree has nodes', nodes.length > 0, `${nodes.length}`)
    check('root uses the scoped page class', classes.some((c) => c.includes('luzzy-page')))

    // The page is an IFRAME now. Everything that used to live in the React tree (fonts,
    // tab switch, charts, markdown) lives inside the frame document instead, so these
    // assertions moved to render-frame-preview.mjs — asserting them here would be checking
    // an architecture the plugin no longer has.
    const iframes = nodes.filter((n) => n.type === 'iframe')
    check('renders exactly one iframe', iframes.length === 1, `${iframes.length}`)

    if (iframes.length === 1) {
      const props = iframes[0].props
      const doc = typeof props.srcDoc === 'string' ? props.srcDoc : ''

      check('iframe carries a srcDoc document', doc.startsWith('<!doctype html>'))
      check('frame document is self-contained (fonts inlined)', (doc.match(/@font-face/g) ?? []).length === 4)
      check('frame document has no external url', !/url\((?!data:)/.test(doc))
      check('iframe width is 100% (fills the pane)', props.style.width === '100%', JSON.stringify(props.style.width))
      check('iframe has a title for a11y', typeof props.title === 'string' && props.title.length > 0)
      // The frame cannot inherit CSS variables across the document boundary, so it must
      // define the token blocks itself. It always STARTS light; the parent writes the real
      // theme onto its root once the frame loads (see followTheme).
      check('frame document defines the token blocks', doc.includes(":root[data-theme='dark']"))
      check('frame document has a flight recorder', doc.includes('function report(stage, detail)'))

      // THE REGRESSION THAT MADE THE PAGE HANG AT "已用时 45 秒".
      //
      // `srcDoc` used to be rebuilt on every render. React compares it by value, so a new
      // string looked like a new document and RELOADED the iframe — killing the in-flight
      // fetch and restarting the ~20 s cold aggregation from zero, repeatedly. The diag log
      // showed `frame-boot` firing twice and `usage-fetch-start` never completing.
      //
      // Rendering twice must therefore produce a BYTE-IDENTICAL srcDoc. Comparing strings
      // (not object identity) is what catches a rebuild.
      const second = probeComponent === null ? null : probeComponent(probeProps)
      const secondIframes = second === null ? [] : collect(second).filter((n) => n.type === 'iframe')
      const secondDoc = secondIframes.length === 1 ? secondIframes[0].props.srcDoc : null
      check(
        'srcDoc is stable across renders (a changing srcDoc reloads the frame)',
        secondDoc === doc,
        'an unstable srcDoc aborts in-flight work and restarts the cold aggregation',
      )
      check(
        'srcDoc comes from the prebuilt constant (not rebuilt per render)',
        // Assert the actual prop rather than scanning the function text: the function's
        // comment QUOTES the old call to explain the bug, and a naive text scan matched the
        // comment and reported a correct build as broken.
        /\bsrcDoc:\s*FRAME_DOCUMENT\b/.test(readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')),
        'srcDoc must reference the module-level constant, which is built once',
      )
    }

    check('no unresolved i18n key leaked', !JSON.stringify(body).includes('view.luzzy'))
  }
}

// ---------------------------------------------------------------- frame contracts

// The frame document is where the page's own logic lives, so its contracts are asserted
// from the built bundle's template (the frame is vanilla JS, not reachable by export).
//
// An earlier version of this block checked a `bucketLabel(key, unit)` formatter that no
// longer exists: the axis labels now come from the window's own slots (lib/usage-window.mjs),
// which label themselves ("00:00", "9/14", "第3周"). Asserting the removed function would
// have kept a dead check alive and reported a working build as broken.
{
  // The frame now comes from the shipped bundle through the real component — see
  // tools/frame-source.mjs. The previous extraction (brace-match `buildFrameDocument`, then
  // un-escape the template literal) broke in three ways during the v2 refactor: the blanket
  // `.replace(/\\n/g, '\n')` corrupted regex literals, lifting one function missed the
  // constants it closes over, and the un-escaping stopped being valid once the frame became a
  // JSON string literal. One shared extractor is the only shape that stays correct.
  const source = frameHtml

  check('smoothing is monotone (no overshoot)', source.includes('Fritsch') || source.includes('smoothPath'))
  // The signature grew an `animate` flag; assert the shape, not an exact parameter list, so
  // a future added argument does not report a correct build as broken.
  check('chart plots one curve per model', /function trendChart\(series, slots, mode/.test(source))
  check('future slots break the curve', source.includes('typeof v === \'number\' && isFinite(v)'))
  check('window switch does not refetch', !/loadUsage\(state\.window/.test(source))
  check('no hourly window', !source.includes("'hour'"))
  check('activity strip is a month', source.includes('cells') && source.includes('daysInMonth'))
  check('future days are blank', source.includes('cellFuture'))

  // ---- hover tooltip
  check('chart has a hover layer', source.includes('function wireChartHover(') && source.includes('chartHit'))
  check('hover shows per-model values', source.includes('chartTipValue') && source.includes('chartTipRow'))
  check('tooltip placement is clamped', source.includes('offsetWidth') && source.includes('box.width'))
  check('hover is keyboard reachable', source.includes('ArrowLeft'))

  // ---- natural weeks carry their dates
  check('month slots expose a date range', source.includes('chartAxisSub'))

  // ---- interaction animation
  check('window/mode switch animates', source.includes('data-animate') && source.includes('chartIn'))
  check('animation respects reduced motion', source.includes('prefers-reduced-motion: reduce'))
  check('animation fires only on a real change', source.includes('lastChartKey'))

  // A stale host half answers with the pre-change payload shape. The page must NAME that
  // mismatch rather than report "no usage" — the client hot-reloads and the host does not,
  // so this is the normal state right after any edit, and silently blaming the user's data
  // is the bug that motivated this check.
  check('detects a stale host payload', source.includes('windowsMissing'))
  // The message moved into pages/system.js with the trend chart. What must not change is the
  // CLAIM: name the version mismatch rather than reporting "you have no usage".
  check(
    'stale payload is reported, not hidden',
    source.includes('宿主半是本插件更新前的版本') && source.includes('响应结构对不上'),
  )
  check(
    'stale path does not claim there is no usage',
    !/windowsMissing[\s\S]{0,900}还没有可统计的用量记录/.test(source),
  )

  // The inflight cache is keyed by unit. A single unkeyed slot returned the wrong unit's
  // payload when the unit was switched mid-flight — the chart then drew the previous
  // unit's buckets under the new unit's labels, with no error.
  const aggregate = readFileSync(join(PLUGIN_ROOT, 'lib', 'usage-aggregate.mjs'), 'utf8')
  check(
    'usage inflight calls are keyed by unit',
    /inflight\.set\(unit/.test(aggregate) && /inflight\.get\(unit\)/.test(aggregate),
    'an unkeyed inflight slot answers a different unit with the wrong payload',
  )

  // The window logic is pure and has its own suite; this only confirms the host half
  // actually ships it, since a missing import would fail silently as an empty chart.
  // Matched loosely on purpose — asserting exact formatting makes the check fail on a
  // harmless reflow, which is a false alarm rather than a real regression.
  const worker = readFileSync(join(PLUGIN_ROOT, 'lib', 'usage-worker.mjs'), 'utf8')
  check('worker imports the window module', worker.includes("from './usage-window.mjs'"))
  check(
    'worker computes all three windows',
    ['day', 'week', 'month'].every((w) => new RegExp(`${w}:\\s*windowSeries\\(`).test(worker)),
  )
  check('worker returns the windows', /windows,/.test(worker) || /windows:/.test(worker))
  check('worker computes the activity strip', worker.includes('monthActivity('))

  // ---- the tab bar
  //
  // Asserted as a SET rather than a count. A count was right while the bar was fixed at
  // three; it is not an invariant, and a bare count fails on any addition without saying
  // what went missing — the assertion would have to be edited either way and would not
  // notice a tab being REPLACED by another one. The set catches both.
  //
  // 本轮变了三件事，三条都钉在这里：
  //   · 「总览」删掉了（它回答的五个问题目标中心逐条都在），所以它不在表里了；
  //   · 「执行状态」与「Agent 配置」不再是独立页签，折成目标中心的两个分区；
  //   · 默认页从 overview 改成 goal。
  // 后一条是**独立**的一条：删掉一个页签而不改默认值，落在它上面的会话会看到一个
  // 回退到别的页的界面，而用户以为自己还在那一页。
  {
    // Scoped to the ROUTER's tab table. A bare `id: '...', label:` also matches every
    // markdown-toolbar button (id: 'bold', label: '加粗'), which reported 26 "tabs".
    const routerTable = source.slice(source.indexOf('const TABS = ['), source.indexOf('const TABS = [') + 2000)
    const tabs = [...new Set(routerTable.match(/id: '(\w+)', label:/g) ?? [])]
      .map((s) => s.slice(5, s.indexOf("', label")))
      .sort()
    check(
      'the nav offers exactly the known pages',
      tabs.join(',') === 'goal,preset,readme,system',
      tabs.join(','),
    )
    check(
      'every nav entry renders a page module',
      tabs.every((tab) => new RegExp(`LZ\\.[A-Za-z]+Page\\.render`).test(routerTable)),
      tabs.join(','),
    )
    // 默认页必须是目标中心 —— 用户明确要求「默认跳转目标中心」。
    check('the default page is the goal centre', /const DEFAULT_TAB = 'goal'/.test(source))
    // 总览页必须真的不存在了，而不是「还在但不显示」。
    // 留着它的渲染模块等于留着第二套同义排版，而那正是删掉它的理由。
    check('the overview page is gone, not merely unlinked',
      !source.includes('LZ.OverviewPage') && !source.includes('function goalCard('),
      '总览页的渲染模块还在')
  }
  check('the preset tab exists', source.includes("id: 'preset'"))
  check('the frame renders the preset page', source.includes('function renderPreset()'))
  check('the preset editor is reachable from the router', source.includes('LZ.PresetPage.render'))
  check('the frame reads the preset route', source.includes("'/__luzzy/preset'") || source.includes('/__luzzy/preset'))
  check('the frame posts mutations', source.includes("method: 'POST'"))

  // ---- 执行状态与 Agent 配置折进目标中心
  //
  // 这两条钉的是**「调」而不是「抄」**。抄一份渲染器是这次整合里最诱人的做法：它让折叠看起来
  // 完成了，同时造出第二份会漂移的排版 —— 而被抄的那份才是有人维护的那份。所以断言钉在
  // 「目标中心按名字调用另外两个模块的 render」，不是「目标中心里有一套长得像的卡片」。
  check('the goal centre calls the runtime renderer rather than copying it',
    /LZ\.RuntimePage\.render\(/.test(source))
  check('and the agent renderer likewise',
    /LZ\.AgentPage\.render\(/.test(source))
  // 而那两个模块本身必须还在：折叠是「换入口」，不是「删内容」。
  check('and both modules still exist as modules',
    source.includes('LZ.RuntimePage = { render: render }') && source.includes('LZ.AgentPage = { render: render }'))
  // 六个分区必须都在表里 —— 少一个，那一块内容就成了永远打不开的死代码。
  {
    const sections = [...source.matchAll(/\['(\w+)', '(概览|计划|证据|记录|执行|Agent)'\]/g)].map((m) => m[1])
    check('all six goal sections are declared', sections.length === 6, sections.join(','))
    check('and the two folded ones are among them',
      sections.includes('execution') && sections.includes('agent'), sections.join(','))
  }
  // 三份数据各自有 status：用一个总状态会让「执行状态读不到」显示成「目标读不到」——
  // 那是对用户的数据说了一句不真的话。
  check('the goal projection keeps the three data states separate',
    source.includes('runtimeStatus:') && source.includes('presetStatus:') && source.includes('runtimeView:'))

  // ---- 玻璃材质层
  //
  // 视觉的东西大部分只能靠眼睛，但**这三条是结构性的**，所以能断言、也就必须断言。
  {
    const css = readFileSync(join(PLUGIN_ROOT, 'src', 'styles', 'components.css'), 'utf8')
    const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')

    // ① 减少透明度：系统级「别给我半透明」。玻璃界面不认它就是没做无障碍，而这条设置
    //    恰恰是最可能提这个需求的人开着的。
    //
    //    判定写成**带括号的媒体查询**而不是子串匹配：`includes('prefers-reduced-transparency')`
    //    对 `...-transparency: no-preference` 也是真 —— 反证臂 D 就是靠这一点抓出这条断言
    //    当时是假的。值也必须真的是 `reduce`。
    check('the glass honours prefers-reduced-transparency',
      /@media\s*\(prefers-reduced-transparency:\s*reduce\)/.test(cssRules))
    // 而且那一支必须真的**关掉 blur**：只提高不透明度的话，模糊还在，而模糊才是把背景
    // 揉进文字的那一步。
    check('and that branch actually removes the blur',
      /prefers-reduced-transparency:\s*reduce\)[\s\S]{0,600}?backdrop-filter:\s*none/.test(cssRules))
    // ② 更高对比：只提高不透明度不够 —— 玻璃的边界本来就靠一条 6% 的发丝线撑着，
    //    对低视力用户它必须真的看得见，所以这一支要把描边换成实色。
    check('and prefers-contrast gets a real border, not just more opacity',
      /prefers-contrast:\s*more[\s\S]{0,400}?border-color:\s*var\(--lz-border\)/.test(cssRules))
    // ③ 不叠两层玻璃。callout / focusBox 在卡片**内部**，它们自己再 blur 一次就等于
    //    正文压在两层模糊底下 —— 每层都吃掉一点对比度。「一块表面只能有一层。」
    //
    // 三个样式表都要读：玻璃的四层**故意**分布在 layout.css（侧边栏、画布）与
    // components.css（卡片、浮层、通知条）里，各归各的布局层次管。只读一份会漏掉两处，
    // 而漏掉的那种失败方式正好是这条断言要防的（「改了卡片忘了侧栏」）。我第一版只读了
    // components.css，于是它报「只有两层」—— 断言对，读的范围错了。
    const sheets = ['layout.css', 'components.css', 'tokens.css']
      .map((f) => readFileSync(join(PLUGIN_ROOT, 'src', 'styles', f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const blurOwners = [...sheets.matchAll(/([^{}]+)\{[^}]*backdrop-filter:/g)]
      .map((m) => m[1].trim().split(/[\s,]+/).filter((s) => s.startsWith('.')))
      .flat()
    const nested = blurOwners.filter((sel) => /callout|focusBox|proposal|badge|row\b/.test(sel))
    check('no surface nested inside a card grows its own blur', nested.length === 0, nested.join(', '))
    const tiers = [...new Set(blurOwners)]
    check('and the surface tiers that carry it are the outer ones',
      tiers.length >= 4 && tiers.length <= 8, tiers.join(', '))
    // backdrop-filter 不被支持时卡片必须退回实底 —— 否则它只是一块半透明的壳，
    // 文字压在画布色晕上，对比度掉到读不清，而且不报错。
    check('and there is a fallback for engines without backdrop-filter',
      cssRules.includes('@supports not') && /@supports not[\s\S]{0,300}?\.card\s*\{\s*background:\s*var\(--lz-bg-container\)/.test(cssRules))
  }

  // ---- 目标中心
  //
  // Same reasoning: the frame is the only place these can be observed, and the failure they
  // guard is silent. A goal tab that renders but reads the wrong route shows an empty page
  // that looks exactly like "you have no goal".
  //
  // v2 renamed the render helpers (goalAcceptanceCard → acceptanceBlock etc.) and moved the
  // page into its own module. The assertions follow the new names, and the SIX sections the
  // brief requires are asserted by name so a section cannot be dropped unnoticed.
  check('the goal tab exists', source.includes("id: 'goal'"))
  check('the frame renders the goal page', source.includes('LZ.GoalPage.render'))
  check('the goal page reads the goal route', source.includes('/__luzzy/goal'))
  check('the goal page loads on demand', source.includes('loadGoal('))
  // The three states the page must never confuse: no goal, an unreadable plan, and a goal
  // this process cannot see. Collapsing them would make the page state a fact about the
  // user's own data that is not true.
  check('the frame distinguishes an unreadable plan from an empty one', source.includes('readError'))
  check('and a service it cannot reach from having no goal', source.includes('goalState'))
  check('goal centre: overview section', source.includes('function overviewBlock('))
  check('goal centre: acceptance section', source.includes('function acceptanceBlock('))
  check('goal centre: task tree section', source.includes('function taskBlock(') && source.includes('LZ.TreeView.tree('))
  check('goal centre: evidence section', source.includes('function evidenceBlock('))
  check('goal centre: decisions section', source.includes('function decisionBlock('))
  check('goal centre: history section', source.includes('function historyBlock('))
  // Sync state is a LINE now, not a card. It used to be a full-width「目标已变化」card for a
  // one-sentence fact; the line still shows when everything agrees, so "nothing rendered" and
  // "checked and consistent" cannot look the same on the page.
  check('goal centre: sync-state line', source.includes('function driftLine('))
  check('and it renders even when synced', source.includes("data-drift=\"synced\""))
  check('goal centre: artifact projection', source.includes('function artifactBlock('))

  // ------------------------------------------------- 用户截图里报的两个问题
  //
  // ① 顶部并排两个一模一样的「已完成」胶囊 ② 目标正文被压成一大坨。
  // 两条都是**用错原语**，所以断言钉在结构上，不钉在外观上。
  //
  // 本轮这两条**换了守卫对象**，因为承载它们的那一页（总览）被删了：
  //
  //   ① 去重的那段代码随总览页一起消失 —— 不是「不守了」，是那个缺陷的载体不存在了。
  //      现在守住这一点的是「总览页真的没了」（见上面 nav 那一段）。
  //   ② 「目标正文被压成一坨」的成因是 objectiveText 把原始目标正文塞进 .focusBox。
  //      现在**没有任何页面再把原始目标正文铺进卡片**：完整目标只在「完整计划」视窗里，
  //      卡片抬头那一格是 Agent 写的「概览目标」。所以守卫从「那个函数怎么写」改成
  //      「那一格不能顶替」——后者才是这条规则真正的意思。
  {
    const format = readFileSync(join(PLUGIN_ROOT, 'src', 'components', 'Format.js'), 'utf8')
    check('the renderer lives in the shared Format module', format.includes('function objectiveText('))
    // 长正文**不在页面里展开**：展开＝页面里再套一层滚动框，两层滚动就是用户说的「断层」
    // —— 滚轮滚谁看指针在哪，内容底部还会被外层容器切断。所以这里只出一个按钮。
    check('a long objective hands off to the viewer instead of folding in place',
      format.includes('data-viewer="objective"') && !format.includes('<details'),
      '又在页面里套了折叠区')
    // 判据是**有没有结构**，不是有多长。第一版只按字数，探针抓出反例：一段 100 字、带换行的
    // 目标照样留在没有 pre-wrap 的强调块里，CSS 又把换行折叠掉 —— 长度是表象，换行才是会坏的那个。
    check('and the split triggers on structure, not only on length',
      /if \(!multiline && text\.length <= 240\)/.test(format),
      '又只按字数判断了')
    // 按钮要真的点得开：帧里有 openViewer，并且挂在那个已经委托的点击处理上。
    check('the button opens the viewer',
      source.includes('function openViewer(') && source.includes('openViewer: openViewer'))
    check('and the click reaches it through the delegated handler',
      source.includes('node.dataset.viewer !== undefined'))

    // ② 真正的规则：目标正文**不铺进任何卡片**。顶上那一格是 Agent 自己的字段、按 Markdown
    // 渲染，不是把目标正文顶上去充数。
    check('no page spreads the raw objective into a card',
      !source.includes('LZ.Format.objectiveText('),
      '又有页面把目标正文铺进卡片了')
    check('and the goal centre hands the full objective off to the plan viewer instead',
      source.includes('goalSummaryBlock(view)'))
    check('and the summary block renders the Agent\'s own field as Markdown',
      /function goalSummaryBlock\(view\)[\s\S]*?LZ\.Markdown\.render\(text\)/.test(source))
    // 空着就照实说没写。拿目标正文顶替会让页面看起来已经答过了，于是没有人会回来写它 ——
    // 预期产出踩过同一个坑，所以两格写的是同一句话。
    check('and an unwritten summary says so instead of borrowing the objective',
      source.includes('还没有写。这一格要一段话 —— 这个目标在做什么。'))

    const css = readFileSync(join(PLUGIN_ROOT, 'src', 'styles', 'components.css'), 'utf8')
    // pre-wrap 是这条修复的核心：折叠了空白，几百行就糊成一坨。
    check('the viewer body preserves newlines', /\.viewerText\s*\{[^}]*white-space:\s*pre-wrap/.test(css))
    // 一屏里只有一层滚动：内容区自己滚，`min-height: 0` 让它真的收得下去 —— flex 子项的默认值
    // 是 auto，少了这行它只撑高、不收缩，滚动就又跑回外层页面上去了。
    check('and the dialog owns the only scroll layer',
      /\.dialogContent\s*\{[^}]*overflow-y:\s*auto/.test(css) && /\.dialogContent\s*\{[^}]*min-height:\s*0/.test(css),
      '又变成两层滚动了')
    // 页面内那层折叠区的规则必须真的删掉 —— 留着就等于把断层留在 CSS 里等人用回去。
    // 注释先剥掉：文件里**故意**留着一条「这里原本是折叠区」的说明，按整份文本查会读到它自己
    // （和 native-dialog 那条断言同一个形状：断的是规则，不是散文）。
    const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    check('and the in-page fold is gone for good',
      !cssRules.includes('.objectiveFull') && !cssRules.includes('.objectiveRest'))
  }

  // ------------------------------------------------- 状态链与激活技能清单（视图）
  //
  // 用户要的是「每次对话都要执行状态链」+「增加激活技能清单的视图」。这两样都要**看得见**：
  // 一个从不出现的门，和没有门在用户眼里是一样的。
  {
    const css = readFileSync(join(PLUGIN_ROOT, 'src', 'styles', 'components.css'), 'utf8')
    check('the goal page shows the chain judgement', source.includes('function chainLine('))
    check('and the activation list', source.includes('function skillBlock('))
    check('both are actually rendered', /chainLine\(view\),\s*\n\s*skillBlock\(view\),/.test(source))
    // 「还没判断」必须是页面能表达的一个状态 —— 把它画成「未命中」是替 Agent 说一句它没说过的话。
    check('an unjudged chain is shown as pending, not as a branch',
      source.includes("data-chain=") && source.includes("chain.judged ? 'judged' : 'pending'"))

    const goalPage = readFileSync(join(TOOLS_ROOT, 'src', 'pages', 'goal.js'), 'utf8')
    // 四项都要渲染出来 —— 缺哪一项这条记录都答不出「为什么这一轮要用它」。
    for (const field of ['row.name', 'row.description', 'row.purpose', 'row.source']) {
      check(`the activation entry renders ${field}`, goalPage.includes(field), field)
    }
    check('a local path is not turned into a link', goalPage.includes('row.isLink'))
    check('and the link opens outside the frame', /target="_blank" rel="noreferrer noopener"/.test(goalPage))
    // 链接样式必须自己写：浏览器默认的蓝紫在暗色主题下看不清，而看不清＝来源无法核对。
    check('the frame styles anchors it renders', /\.link\s*\{[^}]*color:\s*var\(--lz-accent\)/.test(css))
    // 那个 class 必须真的存在（凭空写的类名不报错，只是不生效 —— §5.5 同型的坑）。
    check('and the class used by the page is the one that exists',
      goalPage.includes('class="link"') && css.includes('.link'))
  }

  // A proposal may only be adopted from the page, so the page must actually offer it.
  check('the page can adopt a proposal', source.includes('adoptProposal'))
  // The artifact write is opt-in, so the page must not enable it by itself.
  check('the artifact write is behind an explicit control', source.includes('goalArtifactOn'))
  // Status must never be colour alone: every badge carries an inline SVG glyph AND a word.
  // The old `chip()` is now the shared StatusBadge component, used by every page.
  check('status badges carry a glyph as well as a colour', /function badge\(state, label/.test(source) && source.includes('aria-hidden="true"'))
  check('the roster is draggable', source.includes('draggable') && source.includes('function wireRosterDrag()'))
  check('a drag persists the whole order', source.includes("op: 'reorderAgents'"))
  check('the active agent is marked apart from the selected one', source.includes('rosterItemActive'))
  check('an unsaved prompt is not discarded silently', source.includes('function confirmDiscard()'))
  check('the preset page reports to the flight recorder', source.includes('preset-fetch-start') && source.includes('preset-save-failed'))
  check('a session that cannot switch is explained', source.includes('canSwitchToLuzzy'))
  // Every roster write must carry the revision, or the host's 409 guard is dead code and two
  // windows editing one roster clobber each other silently. It is attached centrally in
  // presetPost precisely so no call site can forget it.
  check('roster writes carry the revision automatically', /REVISION_GUARDED/.test(source) && /payload\.revision = presetSnapshot\.revision/.test(source))
  check('the guarded ops are the roster mutators', /upsertAgent: 1/.test(source) && /removeAgent: 1/.test(source) && /reorderAgents: 1/.test(source))
  check('a conflict adopts the host state', /r\.status === 409 && payload && payload\.snapshot/.test(source))
  // The delete dialog must describe what actually happens: the file is MOVED to archive/,
  // not deleted. The first version promised an unrecoverable delete of a file that was never
  // touched — wrong in both directions at once.
  check('the delete dialog describes the archive', source.includes('archive/'))
  check('the delete path reports where the file went', source.includes('archived.to'))
  check('a failed archive is reported, not hidden', source.includes('没能移动'))

  // ---- native dialogs are banned from the frame
  //
  // A native alert / confirm / prompt is an OS-level modal on the Electron window, and
  // closing it does NOT return keyboard focus to the web contents. The reported symptom was
  // exact: the modal closes, and then the host composer is dead — clicking it does nothing
  // until the user switches away from DSH and back.
  //
  // Nothing inside the page can fix that, so the page must never call one. This assertion is
  // deliberately blunt: any occurrence inside the frame is a regression.
  //
  // TWO REFINEMENTS, both from false failures rather than false passes:
  //   * COMMENTS ARE STRIPPED. dialog.js quotes the banned calls in the comment that explains
  //     why they are banned; scanning prose reports the documentation as the bug.
  //   * A METHOD CALL IS NOT A GLOBAL CALL. `LZ.Dialog.confirm(` matches a bare \bconfirm\(,
  //     because the boundary sits between `.` and `c`. Requiring no preceding `.` separates
  //     the banned global from the sanctioned replacement — six real call sites were being
  //     reported as violations.
  const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const nativeDialog = codeOnly(source).match(/(?<![\w.$])(?:window\s*\.\s*)?(alert|confirm|prompt)\s*\(/g)
  check(
    'the frame calls no native dialogs',
    nativeDialog === null,
    nativeDialog === null ? '' : `found ${nativeDialog.join(', ')} — these steal window focus and leave it there`,
  )
  check('an in-frame dialog exists', source.includes('function showDialog(spec)'))
  check('message / confirm / prompt helpers exist', source.includes('function showMessage(') && source.includes('function showConfirm(') && source.includes('function showPrompt('))
  check('the dialog lives inside the document', source.includes("scrim.className = 'dialogScrim'") && source.includes('document.body.appendChild(scrim)'))
  check('closing a dialog returns focus to the page', source.includes('document.body.focus()'))
  check('the dialog closes on Escape', source.includes("event.key === 'Escape'"))
  check('the dialog closes on the scrim', source.includes('if (event.target === scrim) finish(false)'))
  check('a second dialog supersedes the first', source.includes('if (closeActiveDialog !== null) closeActiveDialog('))
  // The scrim reads the new token layer; the alias layer mirrors the DSH names it replaced.
  check('the dialog scrim is themed, not hardcoded', source.includes('.dialogScrim {') && source.includes('--lz-bg-elevated'))
  // The new-session button must not fire twice: the diag log showed two sessions created
  // ~5.7 s apart from what the user experienced as one click.
  check('the new-session button is guarded against a double fire', source.includes('createInFlight'))
  check('the discard prompt is awaited, not assumed synchronous', /function confirmDiscard\(\)[\s\S]{0,220}return Promise\.resolve\(true\)/.test(source))

  // ---- creating a session that is actually VISIBLE
  //
  // The first version created the session on the host and it was invisible, for two
  // independent structural reasons: `sessionController.create` attaches a workspace only from
  // `workspaceId` (so a `cwd`-only create belongs to no workspace), and the sidebar renders a
  // BLANK session only while it is the selected one. Selection is client-side state, so only
  // the client half can make a new session appear.
  //
  // THE CLIENT HALF IS A SEPARATE ARTIFACT. `createSessionForFrame` and the workspace
  // resolution live in the OUTER bundle (src/client.js), not in the frame — the frame cannot
  // navigate, so it asks over postMessage. Asserting those against `source` (the frame) found
  // nothing once the frame moved into its own modules, which is exactly why these read
  // `clientHalf` below.
  check('the frame asks its host half to create the session', source.includes("type: 'create-session'"))
  check('the frame waits for the create result', source.includes("data.type !== 'session-created'"))
  check('a create that never answers is reported, not hung', source.includes('session-create-timeout'))
  check('the client half performs the create', clientHalf.includes('function createSessionForFrame('))
  check('the client half uses the app session service', clientHalf.includes('appSessions'))
  check(
    'the new session is SELECTED, or it stays invisible',
    /sessions\.open\(id\)/.test(clientHalf),
    'a blank session is rendered only while it is the current one',
  )
  check('the preset is switched while the session is still empty', clientHalf.includes("op: 'switchSession', sessionId"))
  // The workspace must be resolved on the CLIENT, through the app's own workspaces service.
  // Doing it on the host made the entire create path depend on the host bundle being current,
  // and the host does not hot-reload — so the page called an operation the running host had
  // never heard of and got `未知操作 "resolveWorkspace"`.
  check('the workspace is resolved client-side', clientHalf.includes('appWorkspaces') && clientHalf.includes('workspaceId = owner ? owner.workspaceId : null'))
  check('the workspace list is the app client service', clientHalf.includes('ctx.workspaces'))
  check(
    'path matching is case-insensitive',
    clientHalf.includes('item.path.toLowerCase() === cwd.toLowerCase()'),
    'Windows spellings differ in case routinely',
  )

  // ---- the two postMessage conversations must not be confused
  //
  // The session listener used to accept ANY host message, so the create reply (which carries
  // no sessionId) was read as "your session is null": the diag log showed the real id flipping
  // to null one millisecond after a create attempt.
  check(
    'only the session answer may set the session id',
    // Assert the PROPERTY (the assignment is guarded by the type check), not the old control
    // shape. The frame used an early return and now uses an if-block; asserting `!== 'session'
    // … return` would have failed on a correct rewrite — a false alarm that says nothing about
    // whether the guard is actually there.
    /data\.type === 'session'[\s\S]{0,220}sessionId = next/.test(source) &&
      /data\.type === 'session-created'/.test(source),
    'an untyped listener lets the create reply blank out the session id',
  )
  check('the host half tags its session answer', clientHalf.includes("type: 'session', sessionId: currentSessionId"))
  check('the host half tags its create reply', clientHalf.includes("type: 'session-created'"))
  // The session id cannot come from the URL: this is an about:srcdoc document, so a
  // sessionId in `src` would never be readable. The handshake is the mechanism that works.
  check('the frame asks its parent for the session id', source.includes('want-session'))
  check('the frame accepts the answer', source.includes('luzzy-page-host'))
  check(
    'the session id does not come from the URL',
    !source.includes('location.search'),
    'a srcdoc frame sees the parent app URL, not a plugin-controlled one',
  )

  // The client half must never reach for host React: `conversation.view` has no store and
  // no `t`, and both mistakes here produce a blank page with no console error.
  check('frame defines no React hooks', !/\buseState\(|\buseEffect\(/.test(source))
}

  // ------------------------------------------------- 控制台取数：切页即时、刷新不闪
  //
  // 用户报的原文：「每次进入控制台，或在正在对话时，都要重新读取或强制刷新，改成异步读取刷新…
  // 点进某一个子页面时，当前子页面直接静态不刷新，然后其他子页面在刷新数据…避免用户交互断层」。
  //
  // 缺陷的形状是：定时器每 15 秒调一次 `loadGoal(true)`，而 force 让 loader 把状态打回加载中
  // → 整页翻成骨架。一次「什么都没变」的刷新，用户看到的是一次中断。
  //
  // 这几条断的是一个**顺序**和一组**守卫**：加载态必须先被 `background` 挡住，失败必须先被
  // `background` 挡住，切页必须先画再取。少任何一条，症状都会回来，而且都不会报错。
  {
    // 断在**作者源码**上，不断在构建产物上。
    //
    // 第一版断的是 `lib/client.js`，七条里有七条红 —— 而产品其实是对的：帧文档在那个产物里是
    // 一个 **JSON 字符串字面量**，换行是两字符的 `\n`、非 ASCII 是 `\uXXXX`，于是
    // `\s*` 跨不过它、`includes('下面这份是上一次的快照')` 永远为假。
    // 「量具读错了东西，却报成产品坏了」——和本轮早些时候那次同型，所以这里连判据一起换掉。
    const appSrc = readFileSync(join(PLUGIN_ROOT, 'src', 'app', 'app.js'), 'utf8')

    check('the goal loader takes a background flag', /function loadGoal\(force, quiet\)/.test(appSrc))
    check('and so does the runtime loader', /function loadRuntime\(force, quiet\)/.test(appSrc))
    check('and the preset loader', /function loadPreset\(force, quiet\)/.test(appSrc))

    // 三条一模一样的守卫，每条各自能失效：有数据在屏上时，不把状态打回加载中。
    check('a background reload does not flip the page into loading',
      (appSrc.match(/const background = quiet === true && state\.(goal|runtime|preset)Status === 'ready'/g) || []).length === 3,
      '后台刷新的守卫没了，定时刷新会把整页翻成骨架')

    // 后台失败**不能**拿错误页盖掉屏幕上已经有的数据 —— 那是把「这次没更新成」说成「读不到」。
    check('a failed background reload keeps what is on screen',
      (appSrc.match(/if \(background\) return/g) || []).length >= 3,
      '后台失败会把一屏好好的数据换成错误页')

    // 便宜的三份**一律**走后台模式：定时刷新、顺手补读、手动刷新、重试，一条都不许例外。
    // 用量不在其中 —— 它重，且它的重试本来就在系统信息页里。
    //
    // 先剥注释再查，且这是**必须**的：文件里有一条说明写的就是「原来这里只调 loadGoal(true)…」，
    // 按整份文本查会读到它自己 —— 同 `.objectiveFull` 那条断言的形状：断的是规则，不是散文。
    const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    check('every cheap reload goes through background mode',
      !/load(Goal|Runtime|Preset)\(true\)/.test(appCode),
      '还有 force 调用没走后台模式')

    // 补读别的页时**绝不能**顺手刷用量：那是一次 220 MB 的日志扫描，
    // 而它的症状是「磁盘一直在响」，不是一个看得见的错误。
    const refreshOthersBody = appSrc.slice(appSrc.indexOf('function refreshOthers('), appSrc.indexOf('function refreshOthers(') + 900)
    check('refreshOthers exists', appSrc.includes('function refreshOthers('))
    check('and it never touches the usage scan', !refreshOthersBody.includes('loadUsage'))
    check('and it skips what ensureFor already asked for', refreshOthersBody.includes('ensured.includes('))

    // 切页：先画，再去取。中间不许有任何「先打回加载中」的步骤。
    check('switching a tab paints BEFORE it fetches',
      /state\.rawOpen = false[\s\S]{0,900}?render\(\)[\s\S]{0,600}?ensureFor\(next\)/.test(appSrc),
      '切页的顺序变了，一进去就会先闪一下加载态')
    check('and the switch also tops up the other pages',
      /ensureFor\(next\)[\s\S]{0,600}?refreshOthers\(next\)/.test(appSrc))

    // 快照缓存：只为了第一帧不为空，而且必须按会话分键 —— 拿 A 会话的目标画 B 会话的页面，
    // 是这个插件已经修过一次的事故。
    check('the snapshot cache is keyed by session', /CACHE_PREFIX \+ sessionId \+ ':' \+ name/.test(appSrc))
    check('and it refuses to work without a session',
      /function cacheGet\(name\) \{[\s\S]{0,80}?if \(sessionId === null\) return null/.test(appSrc))
    check('and a broken cache degrades to no-cache, never to a broken page',
      /catch \(error\) \{[\s\S]{0,40}?return null/.test(appSrc) && appSrc.includes('cache-put-failed'))
    check('and the cache is never a second source of truth',
      /不是第二份状态源/.test(appSrc))

    // 旧快照可以显示，但**必须挂标记**。安静地冒充新数据是这个项目最重的一类错误。
    check('the cached paint raises a marker', /state\.showingCache = true/.test(appSrc))
    check('and the marker is a visible banner', appSrc.includes('function staleBanner()'))
    check('and the banner says it is a snapshot, not the current data', appSrc.includes('下面这份是上一次的快照'))
    check('and the banner only shows while the cache is on screen',
      /if \(state\.showingCache !== true\) return ''/.test(appSrc))
    check('and the marker is cleared when this page\'s own loaders land',
      /Promise\.resolve\(ensureFor\(state\.tab\)\)\.then\(function \(\) \{[\s\S]{0,120}?state\.showingCache = false/.test(appSrc))
    check('and the banner is prepended to whatever the page rendered',
      appSrc.includes('staleBanner() + html'))

    // 源码对了不等于产物里有它。构建产物这一层只查 ASCII 的标识符 —— 非 ASCII 在那个文件里
    // 是 `\uXXXX`，查中文只会得到一个假的「没发出去」。
    check('the new code is really in the shipped bundle',
      source.includes('function staleBanner(') && source.includes('staleBar'))

    // 「一块表面只能有一层」：横幅坐在玻璃卡片上面，它自己不能再是一层玻璃。
    const layoutCss = readFileSync(join(PLUGIN_ROOT, 'src', 'styles', 'layout.css'), 'utf8')
    const staleRule = layoutCss.slice(layoutCss.indexOf('.staleBar {'))
    const staleBlock = staleRule.slice(0, staleRule.indexOf('}'))
    check('the banner is styled', staleBlock.length > 0 && staleBlock.includes('--lz-state-waiting'))
    check('and it is NOT a second layer of glass',
      !staleBlock.includes('backdrop-filter') && !staleBlock.includes('background:'),
      '横幅自己成了第二层玻璃，字会沉下去')
  }

  // ------------------------------------------------- 分段控件：CSS 真的存在吗
  //
  // 用户看图问「这里的 CSS 是不是掉了」。查下来是**掉了**：`components.css` 里有
  // 「分段控件」分区标题、有 `.segLabel`，而 `.segment` 一条规则都没有 —— 于是「模型趋势」
  // 右上角那两组按钮一直是一排裸 `<button>`，只有 `aria-pressed` 在 DOM 里变，没人读它。
  //
  // 这条断言不能只写「`.segment` 出现过」：文件名在注释里也会出现（上面那句就是），
  // 所以要断**规则**：`{` 之后必须真的有声明。
  {
    const css = readFileSync(join(PLUGIN_ROOT, 'src', 'styles', 'components.css'), 'utf8')
    const ruleOf = (sel) => {
      const i = css.indexOf(sel + ' {')
      if (i < 0) return ''
      return css.slice(i, css.indexOf('}', i))
    }
    const container = ruleOf('.segment')
    const item = ruleOf('.segment > button')

    check('the segmented control actually has a rule', container.includes('display: inline-flex'))
    check('and it draws its own container', container.includes('border: 1px solid'))
    check('and its items have a rule too', item.includes('background: transparent'))

    // 选中态读的是 `aria-pressed`，不是新增一个类 —— 状态本来就写在 DOM 上（system.js 每次
    // 重画都会更新它），再加一个类就有两份真相，而它们迟早会不一致。
    check('the pressed state is driven by aria-pressed, not a class',
      css.includes(".segment > button[aria-pressed='true']"))
    check('and the pressed item is raised, not tinted with the page accent',
      /\.segment > button\[aria-pressed='true'\] \{[\s\S]{0,220}?box-shadow:/.test(css),
      '选中态改用强调色了：一次点击不该花掉整页的强调色额度')

    // 触屏上点一下会留下粘住的 hover 态，那不表示任何东西。
    check('hover is gated behind a pointer device',
      /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.segment > button:hover/.test(css))

    // 抬头把同一个标题印了两遍：「今天的 24 小时 今天的 24 小时」。
    const system = readFileSync(join(PLUGIN_ROOT, 'src', 'pages', 'system.js'), 'utf8')
    check('the chart card does not print its caption twice',
      !/title: '模型趋势',\s*count: windowCaption/.test(system),
      '抬头又把窗口标题印了一遍')
    check('and the caption still rides with the controls',
      system.includes("'<span class=\"segLabel\">' + esc(windowCaption) + '</span>'"))
  }

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()

if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}

console.log(`PASS — ${notes.length} assertions`)
