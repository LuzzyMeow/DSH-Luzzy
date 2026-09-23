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

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

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
  check('label resolves to LuzzyPage', label === 'LuzzyPage', `got ${JSON.stringify(label)}`)

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
  const bundleText = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')
  const frameStart = bundleText.indexOf('function buildFrameDocument(')
  const frameText = frameStart >= 0 ? bundleText.slice(frameStart) : ''

  check('frame builder found in the bundle', frameStart >= 0)

  // The frame is a template literal; unescape enough to read it as ordinary source.
  const source = frameText.replace(/\\`/g, '`').replace(/\\n/g, '\n').replace(/\\r\\n/g, '\n')

  check('smoothing is monotone (no overshoot)', source.includes('Fritsch') || source.includes('smoothPath'))
  // The signature grew an `animate` flag; assert the shape, not an exact parameter list, so
  // a future added argument does not report a correct build as broken.
  check('chart plots one curve per model', /function trendChart\(series, slots, mode/.test(source))
  check('future slots break the curve', source.includes('typeof v === \'number\' && isFinite(v)'))
  check('window switch does not refetch', !/loadUsage\(state\.window/.test(source))
  check('no hourly window', !source.includes("'hour'"))
  check('activity strip is a month', source.includes('function activityGrid(activity)'))
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
  check(
    'stale payload is reported, not hidden',
    source.includes('usage-payload-stale') && source.includes('宿主半是本插件更新前的版本'),
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
  {
    const tabs = [...new Set(source.match(/data-tab="(\w+)"/g) ?? [])].map((s) => s.slice(10, -1)).sort()
    check('the tab bar offers exactly the known tabs', tabs.join(',') === 'goal,preset,readme,usage', tabs.join(','))
    check('every tab has a renderer dispatch',
      tabs.every((tab) => new RegExp(`state\\.tab === '${tab}'`).test(source) || tab === 'readme'),
      tabs.join(','))
  }
  check('the preset tab exists', source.includes('data-tab="preset"'))
  check('the frame renders the preset page', source.includes('function renderPreset()'))
  check('the preset page is dispatched from render()', /state\.tab === 'preset'[\s\S]{0,40}renderPreset\(\)/.test(source))
  check('the frame reads the preset route', source.includes("'/__luzzy/preset'") || source.includes('/__luzzy/preset'))
  check('the frame posts mutations', source.includes("method: 'POST'"))

  // ---- the 目标 sub-page
  //
  // Same reasoning: the frame is the only place these can be observed, and the failure they
  // guard is silent. A goal tab that renders but reads the wrong route shows an empty page
  // that looks exactly like "you have no goal".
  check('the goal tab exists', source.includes('data-tab="goal"'))
  check('the frame renders the goal page', source.includes('function renderGoal()'))
  check('the goal page is dispatched from render()', /state\.tab === 'goal'[\s\S]{0,40}renderGoal\(\)/.test(source))
  check('the frame reads the goal route', source.includes('/__luzzy/goal'))
  check('the goal tab loads lazily on first visit', /state\.tab === 'goal' && goalStatus === 'idle'[\s\S]{0,30}loadGoal\(/.test(source))
  // The three states the page must never confuse: no goal, an unreadable plan, and a goal
  // this process cannot see. Collapsing them would make the page state a fact about the
  // user's own data that is not true.
  check('the frame distinguishes an unreadable plan from an empty one', source.includes('readError'))
  check('and a service it cannot reach from having no goal', source.includes('goalState'))
  check('the frame renders acceptance criteria', source.includes('goalAcceptanceCard'))
  check('and evidence', source.includes('goalEvidenceCard'))
  check('and the current focus and next action', source.includes('goalFocusCard'))
  check('and pending change proposals', source.includes('goalProposalsCard'))
  check('and goal drift', source.includes('goalDriftCard'))
  // A proposal may only be adopted from the page, so the page must actually offer it.
  check('the page can adopt a proposal', source.includes('adoptProposal'))
  // The artifact write is opt-in, so the page must not enable it by itself.
  check('the artifact write is behind an explicit control', source.includes('goalArtifactOn'))
  // Status must never be colour alone: every chip carries an inline SVG glyph AND a word.
  check('status chips carry a glyph as well as a colour', /function chip\(state, label/.test(source) && source.includes('aria-hidden="true">'))
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
  // deliberately blunt: any occurrence inside the frame template is a regression.
  const nativeDialog = source.match(/(?:window\s*\.\s*)?\b(alert|confirm|prompt)\s*\(/g)
  check(
    'the frame calls no native dialogs',
    nativeDialog === null,
    nativeDialog === null ? '' : `found ${nativeDialog.join(', ')} — these steal window focus and leave it there`,
  )
  check('an in-frame dialog exists', source.includes('function showDialog('))
  check('message / confirm / prompt helpers exist', source.includes('function showMessage(') && source.includes('function showConfirm(') && source.includes('function showPrompt('))
  check('the dialog lives inside the document', source.includes("scrim.className = 'dialogScrim'") && source.includes('document.body.appendChild(scrim)'))
  check('closing a dialog returns focus to the page', source.includes('document.body.focus()'))
  check('the dialog closes on Escape', source.includes("event.key === 'Escape'"))
  check('the dialog closes on the scrim', source.includes('if (event.target === scrim) finish(false)'))
  check('a second dialog supersedes the first', source.includes('if (closeActiveDialog !== null) closeActiveDialog('))
  check('the dialog scrim is themed, not hardcoded', source.includes('.dialogScrim {') && source.includes('--dsw-alias-bg-layer-1'))
  // The new-session button must not fire twice: the diag log showed two sessions created
  // ~5.7 s apart from what the user experienced as one click.
  check('the new-session button is guarded against a double fire', source.includes('newSessionInFlight'))
  check('the discard prompt is awaited, not assumed synchronous', /function confirmDiscard\(\)[\s\S]{0,220}return Promise\.resolve\(true\)/.test(source))

  // ---- creating a session that is actually VISIBLE
  //
  // The first version created the session on the host and it was invisible, for two
  // independent structural reasons: `sessionController.create` attaches a workspace only from
  // `workspaceId` (so a `cwd`-only create belongs to no workspace), and the sidebar renders a
  // BLANK session only while it is the selected one. Selection is client-side state, so only
  // the client half can make a new session appear.
  check('the frame asks its host half to create the session', source.includes("type: 'create-session'"))
  check('the frame waits for the create result', source.includes("data.type !== 'session-created'"))
  check('a create that never answers is reported, not hung', source.includes('preset-new-session-timeout'))
  check('the client half performs the create', source.includes('function createSessionForFrame('))
  check('the client half uses the app session service', source.includes('appSessions'))
  check(
    'the new session is SELECTED, or it stays invisible',
    /sessions\.open\(id\)/.test(source),
    'a blank session is rendered only while it is the current one',
  )
  check('the preset is switched while the session is still empty', source.includes("op: 'switchSession', sessionId"))
  // The workspace must be resolved on the CLIENT, through the app's own workspaces service.
  // Doing it on the host made the entire create path depend on the host bundle being current,
  // and the host does not hot-reload — so the page called an operation the running host had
  // never heard of and got `未知操作 "resolveWorkspace"`.
  check('the workspace is resolved client-side', source.includes('appWorkspaces') && source.includes('workspaceId = owner ? owner.workspaceId : null'))
  check('the workspace list is the app client service', source.includes('ctx.workspaces'))
  check(
    'path matching is case-insensitive',
    source.includes('item.path.toLowerCase() === cwd.toLowerCase()'),
    'Windows spellings differ in case routinely',
  )

  // ---- the two postMessage conversations must not be confused
  //
  // The session listener used to accept ANY host message, so the create reply (which carries
  // no sessionId) was read as "your session is null": the diag log showed the real id flipping
  // to null one millisecond after a create attempt.
  check(
    'only the session answer may set the session id',
    /data\.type !== 'session'\) return[\s\S]{0,200}sessionId = next/.test(source),
    'an untyped listener lets the create reply blank out the session id',
  )
  check('the host half tags its session answer', source.includes("type: 'session', sessionId: currentSessionId"))
  check('the host half tags its create reply', source.includes("type: 'session-created'"))
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

// ---------------------------------------------------------------- report

console.log(notes.join('\n'))
console.log()

if (failures.length > 0) {
  console.log(failures.join('\n'))
  console.log(`\nFAIL — ${failures.length} assertion(s)`)
  process.exit(1)
}

console.log(`PASS — ${notes.length} assertions`)
