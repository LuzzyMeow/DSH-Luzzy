/* pages/preset.js —— 「预设」编辑器：提示词编辑与智能体名单管理。
 *
 * 这是「Agent 配置」页里的**编辑面**：Agent 配置页回答「这个 Agent 现在是什么样」，
 * 这个页面让它可改。它整体从原 src/client.js 搬来，逻辑一行未改，只做了边界适配
 * （见 tools/extract-preset-module.mjs 打印的替换清单）。
 *
 * 三条它承载的关键行为，都别改坏：
 *
 *  1. **SELECTED 与 ACTIVE 是两件事。** SELECTED 是编辑器在看谁的提示词（本页局部）；
 *     ACTIVE 是模型实际会收到的提示词（存在 store 里、所有会话共享、下一次请求生效）。
 *     把两者混起来显示，用户就会以为自己改了、其实没生效，或者反过来。
 *
 *  2. **每次写入都带 revision。** 宿主的 409 并发检查靠它才不是死代码——
 *     少了它，两个窗口同编一份名单会互相覆盖，输的那次改动**悄悄消失**、全程无错。
 *     所以 revision 在 presetPost 里**集中**附加，不靠每个调用点记得。
 *
 *  3. **删除是移入 archive/，不是抹掉。** 对话框照实这么说。上一版承诺「文件会一起删掉，
 *     不能撤销」，而实现根本不删文件——两个方向同时错。
 *
 * 它自己的状态（presetSnapshot / promptText / selectedAgentId …）留在模块内，
 * 不塞进 app.js 的全局状态：这些是编辑器的局部状态，切页即失是正确的语义。
 */
(function (LZ) {
  'use strict'

  const esc = LZ.Format.esc
  const report = LZ.App.report
  const contentNode = LZ.App.content
  const onPresetTab = function () { return LZ.App.state.tab === 'preset' }

  // The toolbar tables moved to the Markdown module, which owns them. They are bound here under
  // their original names rather than rewritten at each call site: this file has thirteen
  // references to them (icon lookup, group iteration, mode filtering), and the local binding
  // keeps the diff to one line instead of thirteen. It is also the safer direction — a missed
  // call site is a ReferenceError at RENDER time, which mounts the page and then throws.
  const MD_ICONS = LZ.Markdown.ICONS
  const MD_GROUPS = LZ.Markdown.GROUPS
  const MD_MODES = LZ.Markdown.MODES
  const MD_TOOLS = LZ.Markdown.TOOLS

let presetSnapshot = null
let presetStatus = 'idle' // idle | loading | ready | error
let presetError = null
let selectedAgentId = null
// The editor's contents. \`promptDirty\` is what makes an unsaved edit visible — silently
// discarding a 100 KB prompt on a tab switch would be the worst behaviour here.
let promptText = ''
let promptDirty = false
let promptExists = true
let promptInherited = false
/**
 * Which of the three display modes the editor is in: 'live' | 'source' | 'reading'.
 *
 * 'live' is the DEFAULT, matching the reference prompt editor's default ('visual'): you type
 * into one surface and see the formatting as you go. There is no side-by-side split — the
 * reference has none, and a split pane halves the width of the thing you are actually writing.
 *
 * This is DISPLAY-ONLY state and must never feed back into promptText: nothing outside the one
 * textarea is editable, and if a rendering wrote back, merely looking at it would rewrite a
 * 57 KB prompt.
 */
let promptMode = 'live'
/** Whether the mode menu is open. Rendering state, kept out of the store. */
let modeMenuOpen = false

/**
 * The toolbar's commands, grouped exactly as the reference editor groups them, and the icons.
 *
 * The icons are raw SVG inner markup written here rather than an icon package: the frame has
 * no React, no bundler and no network, so a dependency would be one more thing to keep alive
 * inside a template literal. They are drawn on a 24x24 grid in the same stroke style the
 * reference uses (2px, round caps) — see the .mdBtn svg rule for the shared attributes.
 *
 * TEXT BUTTONS: headings and the clear-formatting button render a short glyph instead of an
 * icon. "H1" is clearer at 15px than any heading pictogram, and the reference does the same.
 *
 * WHAT IS NOT HERE, AND WHY:
 *   - underline: Markdown has no syntax for it. Emitting HTML would work only if the renderer
 *     allowed raw tags through, which it must not — that is the XSS hole the renderer
 *     deliberately closes. A button whose output the preview drops is worse than no button.
 *   - undo / redo: the textarea's own undo stack already works (toolbar edits go through
 *     setRangeText precisely to keep it intact), so Ctrl+Z and Ctrl+Y do this today. Adding a
 *     second implementation behind a button would be the least valuable thing here to get
 *     wrong.
 */


/** The three display modes. The live one is the default, matching the reference editor. */

/** Flat view of MD_GROUPS, for the wiring and the tests. */

// Session facts, resolved by the host when it knows which session this page belongs to.
let sessionId = null

/**
 * POST one operation, with the revision this page last saw attached automatically.
 *
 * The revision is added HERE rather than at each call site, because a guard each caller has
 * to remember is a guard that is absent exactly where it matters. It was: every roster write
 * (add / rename / delete / reorder / regroup) omitted it, so the host's 409 concurrency
 * check could never fire and two windows editing the same roster would silently clobber each
 * other — the loser's change vanishing with no error anywhere.
 *
 * Operations that do not touch the roster (readPrompt, setPrompt, ensureStore,
 * switchSession, newSession) are not given one. Sending a revision to a route that does
 * not compare it is harmless, but sending it to one that does NOT mutate would start
 * rejecting a pure read after an unrelated write.
 */
const REVISION_GUARDED = { upsertAgent: 1, removeAgent: 1, reorderAgents: 1, upsertGroup: 1, removeGroup: 1, reorderGroups: 1, setActive: 1 }

function presetPost(body) {
  const payload = { ...body }
  if (REVISION_GUARDED[payload.op] === 1 && payload.revision === undefined && presetSnapshot !== null) {
    payload.revision = presetSnapshot.revision
  }
  return fetch('/__luzzy/preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function (r) {
    return r.json().catch(function () { return {} }).then(function (payload) {
      if (r.ok) return payload
      const error = new Error(payload && payload.error ? payload.error : ('HTTP ' + r.status))
      error.status = r.status
      error.payload = payload
      // A conflict means this page's copy of the roster is stale. Adopt the state the host
      // sent back immediately, so the UI stops showing a list that no longer exists — the
      // alternative is the user editing a roster that was already overwritten.
      if (r.status === 409 && payload && payload.snapshot) {
        applySnapshot(payload.snapshot)
        if (onPresetTab()) LZ.App.render()
      }
      throw error
    })
  })
}

function loadPreset() {
  presetStatus = 'loading'
  presetError = null
  report('preset-fetch-start', { sessionId: sessionId })
  const url = '/__luzzy/preset' + (sessionId === null ? '' : '?sessionId=' + encodeURIComponent(sessionId))
  return fetch(url)
    .then(function (r) { return r.ok ? r.json() : r.text().then(function (b) { throw new Error(b) }) })
    .then(function (payload) {
      report('preset-fetch-ok', {
        revision: payload.revision,
        agents: payload.agents ? payload.agents.length : null,
        groups: payload.groups ? payload.groups.length : null,
        promptSource: payload.promptSource,
      })
      applySnapshot(payload)
      presetStatus = 'ready'
      if (onPresetTab()) LZ.App.render()
      return payload
    })
    .catch(function (err) {
      const message = String(err && err.message || err)
      report('preset-fetch-failed', message)
      presetStatus = 'error'
      presetError = message
      if (onPresetTab()) LZ.App.render()
    })
}

/** Take a snapshot as the new truth, keeping the local selection if it still exists. */
function applySnapshot(payload) {
  presetSnapshot = payload
  const agents = payload.agents || []
  if (selectedAgentId !== null && !agents.some(function (a) { return a.id === selectedAgentId })) {
    selectedAgentId = null
  }
  if (selectedAgentId === null && agents.length > 0) {
    // Prefer the active agent, so opening the tab shows what the model is using.
    const active = payload.settings && payload.settings.activeAgentId
    selectedAgentId = active !== null && active !== undefined && agents.some(function (a) { return a.id === active })
      ? active
      : agents[0].id
  }
  if (promptDirty === false) loadPrompt(selectedAgentId)
}

/** Pull one agent's full prompt text into the editor. */
function loadPrompt(agentId) {
  return presetPost({ op: 'readPrompt', agentId: agentId })
    .then(function (payload) {
      promptText = payload.text || ''
      promptDirty = false
      promptExists = payload.exists !== false
      promptInherited = payload.inherited === true
      if (onPresetTab()) LZ.App.render()
    })
    .catch(function (err) {
      report('preset-prompt-failed', String(err && err.message || err))
    })
}

function agentById(id) {
  if (presetSnapshot === null) return null
  return (presetSnapshot.agents || []).find(function (a) { return a.id === id }) || null
}

function groupById(id) {
  if (presetSnapshot === null || id === null || id === undefined) return null
  return (presetSnapshot.groups || []).find(function (g) { return g.id === id }) || null
}

/** The callouts the snapshot asks for: warnings from the store, and session truth. */
function calloutsHtml() {
  const parts = []
  const session = presetSnapshot && presetSnapshot.session
  const caps = (presetSnapshot && presetSnapshot.capabilities) || {}

  if (session !== null && session !== undefined) {
    if (session.known === false) {
      parts.push('<div class="callout">' + esc(session.reason || '没有拿到会话信息。') +
        '（切换智能体仍然有效，它对所有会话生效。）</div>')
    } else if (session.preset === 'luzzy-mode') {
      parts.push('<div class="callout" data-kind="ok">这个会话已经在 <b>LuzzyMode</b> 上。' +
        '切换下方激活的智能体，下一次请求立即生效。</div>')
    } else if (session.canSwitchToLuzzy === true) {
      parts.push('<div class="callout" data-kind="warn">这个会话当前用的是 <b>' +
        esc(session.preset || '其他预设') + '</b>。它还没有产生内容，可以切到 LuzzyMode。</div>')
    } else {
      parts.push('<div class="callout" data-kind="warn">' + esc(session.reason || '这个会话无法切换预设。') +
        '</div>')
    }
  }

  const warnings = (presetSnapshot && presetSnapshot.warnings) || []
  for (const warning of warnings) parts.push('<div class="callout" data-kind="warn">' + esc(warning) + '</div>')

  if (caps.sessionPresetSwitch === false) {
    parts.push('<div class="callout">这个部署没有提供预设服务，因此无法把会话切到 LuzzyMode。提示词编辑仍然可用。</div>')
  }
  return parts.join('')
}

function sessionBlockHtml() {
  const session = presetSnapshot && presetSnapshot.session
  const caps = (presetSnapshot && presetSnapshot.capabilities) || {}
  const buttons = []

  if (session !== null && session !== undefined && session.known !== false && session.preset !== 'luzzy-mode') {
    buttons.push('<button type="button" class="btn" id="presetSwitch"' +
      (session.canSwitchToLuzzy === true ? '' : ' disabled') + '>切到 LuzzyMode</button>')
  }
  if (caps.newSession !== false) {
    buttons.push('<button type="button" class="btn" id="presetNew">新建 LuzzyMode 会话</button>')
  }
  if (buttons.length === 0) return ''

  return '<section class="card"><div class="cardHead"><h3>会话</h3><span class="spacer"></span>' +
    (session !== null && session !== undefined && session.preset
      ? '<span class="sessionPreset">' + esc(session.preset) + '</span>'
      : '<span class="note">' + (sessionId === null ? '未拿到会话标识' : '预设未知') + '</span>') +
    '</div><div class="sessionRow">' + buttons.join('') + '</div></section>'
}

/** Group the roster into its columns: named groups in order, then everything ungrouped. */
function rosterColumns() {
  const groups = (presetSnapshot.groups || []).slice()
  const agents = (presetSnapshot.agents || []).slice()
  const columns = groups.map(function (group) {
    return {
      id: group.id,
      name: group.name,
      agents: agents.filter(function (a) { return a.groupId === group.id }),
    }
  })
  const ungrouped = agents.filter(function (a) {
    return a.groupId === null || a.groupId === undefined || !groups.some(function (g) { return g.id === a.groupId })
  })
  if (ungrouped.length > 0) columns.push({ id: null, name: '未分组', agents: ungrouped })
  return columns
}

function rosterHtml() {
  const active = presetSnapshot.settings && presetSnapshot.settings.activeAgentId
  const columns = rosterColumns()

  if ((presetSnapshot.agents || []).length === 0) {
    return '<p class="note">还没有智能体。点「＋ 智能体」新建一个；不建也可以——「默认提示词」是所有智能体的兜底。</p>'
  }

  const parts = columns.map(function (column) {
    // The group header carries its own delete affordance, and three things about how it is
    // shown were wrong before:
    //
    //   1. It sat in the same row as the group NAME and count, in the same vertical list as the
    //      agents. "默认 1 删" reads as "delete the agent called 默认", not "delete this group".
    //      It now sits at the far end of the row, after the count, so it belongs to the row's
    //      trailing edge rather than to the name.
    //   2. Its label was the bare verb 「删」 — ambiguous on its own, and it collided with the
    //      agent editor's own 「删除」 button at the bottom of the page. The design system's rule
    //      is verb + noun, so the accessible name is 「删除分组 <名>」 and the visible glyph is
    //      an icon; the title carries the consequence.
    //   3. It was permanently red. A destructive colour on every group heading turns the list
    //      into a row of alarms; the danger colour now appears only on hover/focus, where the
    //      action is actually available.
    //
    // Note the ungrouped column (id === null) is a synthetic bucket, not a stored group, so it
    // gets no delete button — there is nothing to delete.
    const head = column.id === null
      ? '<div class="rosterGroupHead"><span class="rosterGroupName">' + esc(column.name) + '</span></div>'
      : '<div class="rosterGroupHead" data-group="' + esc(column.id) + '">' +
        '<span class="rosterGroupName" data-rename="' + esc(column.id) + '" title="点击改名">' + esc(column.name) + '</span>' +
        '<span class="rosterGroupCount">' + column.agents.length + '</span>' +
        '<button type="button" class="rosterGroupDel" data-delgroup="' + esc(column.id) + '"' +
        ' title="删除分组（里面的智能体会移到未分组）"' +
        ' aria-label="删除分组 ' + esc(column.name) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + MD_ICONS.trash + '</svg>' +
        '</button>' +
        '</div>'

    const items = column.agents.map(function (agent) {
      const selected = agent.id === selectedAgentId
      return '<div class="rosterItem" role="option" tabindex="0" draggable="true" ' +
        'data-agent="' + esc(agent.id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
        '<span class="rosterItemHandle" title="拖动排序" aria-hidden="true">' +
        '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
        '<circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/>' +
        '<circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/>' +
        '<circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/>' +
        '</svg></span>' +
        '<span class="rosterItemName" data-pick="' + esc(agent.id) + '">' + esc(agent.name) + '</span>' +
        (agent.id === active ? '<span class="rosterItemActive">当前</span>' : '') +
        '</div>'
    }).join('')

    return '<div class="rosterGroup">' + head + items + '</div>'
  }).join('')

  return '<div class="roster" role="listbox" aria-label="智能体">' + parts + '</div>'
}

function editorHtml() {
  const agent = agentById(selectedAgentId)
  const isDefault = agent === null
  const active = presetSnapshot.settings && presetSnapshot.settings.activeAgentId
  const groups = presetSnapshot.groups || []

  const groupOptions = ['<option value="">未分组</option>'].concat(groups.map(function (group) {
    const selected = agent !== null && agent.groupId === group.id ? ' selected' : ''
    return '<option value="' + esc(group.id) + '"' + selected + '>' + esc(group.name) + '</option>'
  })).join('')

  // One subject per sentence. The four saved-states used to switch between 「改动」, 「提示词」
  // and 「内容」 as if they were different things, so the same slot described a different object
  // depending on which branch fired. All four now speak about the prompt itself, and the
  // longest one is shortened so the slot does not resize on every toggle.
  const stateText = promptDirty
    ? '有未保存的改动'
    : (promptInherited
      ? '沿用默认提示词'
      : (promptExists ? '已保存' : '还没有内容'))

  return '<section class="card"><div class="cardHead">' +
    '<h3>' + (isDefault ? '默认提示词' : '编辑智能体') + '</h3>' +
    '<span class="spacer"></span>' +
    '<span class="saveState" id="presetSaveState" data-kind="' + (promptDirty ? 'dirty' : 'saved') + '">' + esc(stateText) + '</span>' +
    '</div>' +

    (isDefault
      ? '<p class="note">没有激活任何智能体时，模型用的就是这份提示词。</p>'
      : '<div class="fieldRow">' +
        '<div class="field"><label class="fieldLabel" for="presetName">名称</label>' +
        '<input class="input" id="presetName" value="' + esc(agent.name) + '" maxlength="80"></div>' +
        '<div class="field"><label class="fieldLabel" for="presetGroup">分组</label>' +
        '<select class="select" id="presetGroup">' + groupOptions + '</select></div>' +
        '<div class="field"><label class="fieldLabel" for="presetId">id</label>' +
        '<input class="input" id="presetId" value="' + esc(agent.id) + '" readonly></div>' +
        '</div>') +

    '<div class="field"><label class="fieldLabel" for="presetPrompt">System prompt' +
    (promptInherited ? '<span class="note"> · 正在沿用默认提示词</span>' : '') + '</label>' +
    // One bordered box: toolbar, ONE surface, status line.
    //
    // The surface is the RENDERED document, made editable — that is what "live preview" means
    // here: the Markdown markers are gone and you type straight into the formatted result.
    // Source mode swaps in the raw textarea. Exactly one is visible per mode, and the textarea
    // is never removed from the DOM (doing so would throw away its scroll position and undo
    // stack on every mode change).
    '<div class="mdEditor">' +
    markdownToolsHtml() +
    '<div class="mdArea" data-mode="' + esc(promptMode) + '" id="presetArea">' +
    // contenteditable only in live mode; reading mode shows the same markup, immutable.
    // data-empty drives the hint below; it is rendered here and re-synced on every edit, so
    // the hint tracks the document rather than the focus state.
    '<div class="mdVisual" id="presetVisual" data-empty="' + (promptText.trim() === '' ? 'true' : 'false') + '" contenteditable="' +
    (promptMode === 'live' ? 'true' : 'false') + '" role="textbox" aria-multiline="true" ' +
    'aria-label="System prompt（Markdown 渲染视图）">' +
    LZ.Markdown.render(promptText) + '</div>' +
    '<textarea class="mdLayer" id="presetPrompt" spellcheck="false" ' +
    'aria-label="System prompt（源码）" placeholder="在这里写这个智能体的 system prompt…">' +
    esc(promptText) + '</textarea>' +
    '</div>' +
    markdownFootHtml() +
    '</div></div>' +

    // Button hierarchy: exactly one emphasised action per view.
    //
    // 保存 is the only filled button. It used to share the row with a bordered red 删除 of
    // similar weight, and with 已是当前 rendered as a dead button — so the row read as three
    // peer choices when only one of them was the thing to do. Now:
    //   - 保存        filled (the one action)
    //   - 设为当前    bordered (an ordinary action)
    //   - 停用        bordered (ordinary, and reversible)
    //   - 已是当前    a STATE, not a button — it says what is already true, so it is a badge
    //   - 删除        text weight, not a bordered peer; it is destructive but it is not primary
    '<div class="btnRow">' +
    '<button type="button" class="btn btnPrimary" id="presetSave">保存</button>' +
    (isDefault ? '' : (agent.id === active
      ? '<span class="stateBadge" title="这个智能体已经生效">已是当前</span>'
      : '<button type="button" class="btn" id="presetActivate">设为当前（立即生效）</button>')) +
    (isDefault ? '' : '<button type="button" class="btn" id="presetActivateNone"' + (active === null || active === undefined ? ' disabled' : '') + '>停用（回到默认）</button>') +
    '<span class="spacer"></span>' +
    (isDefault ? '' : '<button type="button" class="btn btnText btnDanger" id="presetDelete">删除</button>') +
    '</div>' +
    '</section>'
}

/**
 * The Markdown toolbar: icon buttons in divider-separated groups.
 *
 * Buttons are rendered from MD_GROUPS, so the icon, the accessible name and the
 * "what does this insert" rule cannot drift apart — and so a test can assert the set without
 * depending on rendered markup.
 *
 * Every button carries a title attribute AND an aria-label: an icon alone is not a name, and
 * the title attribute is not exposed to assistive technology consistently.
 */
function markdownToolsHtml() {
  return '<div class="mdBar" role="toolbar" aria-label="Markdown 格式">' +
    MD_GROUPS.map(function (group) {
      return group.map(function (tool) {
        const glyph = tool.text !== undefined
          ? esc(tool.text)
          : '<svg viewBox="0 0 24 24" aria-hidden="true">' + (MD_ICONS[tool.icon] || '') + '</svg>'
        // data-on is written by the renderer from the caret's own line, never speculatively.
        return '<button type="button" class="mdBtn" data-md="' + tool.id + '" data-on="false"' +
          ' title="' + esc(tool.label) + '" aria-label="' + esc(tool.label) + '">' + glyph + '</button>'
      }).join('')
    }).join('<span class="mdDivider" aria-hidden="true"></span>') +
    '</div>'
}

/** The status line: character count on the left, the mode picker on the right. */
function markdownFootHtml() {
  const current = MD_MODES.filter(function (mode) { return mode.id === promptMode })[0] || MD_MODES[0]
  return '<div class="mdFoot">' +
    '<span class="mdFootCount" id="presetCount">字符：' + promptText.length + '</span>' +
    '<span class="spacer"></span>' +
    '<div class="mdMode">' +
    '<button type="button" class="mdModeBtn" id="presetModeBtn" aria-haspopup="menu" aria-expanded="false">' +
    '<span id="presetModeLabel">' + esc(current.label) + '</span>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' + MD_ICONS.chevron + '</svg>' +
    '</button>' +
    '<div class="mdMenu" id="presetModeMenu" role="menu" hidden>' +
    MD_MODES.map(function (mode) {
      return '<button type="button" class="mdMenuItem" role="menuitemradio" data-mode="' + mode.id + '"' +
        ' aria-checked="' + (mode.id === promptMode ? 'true' : 'false') + '">' +
        '<svg class="mdCheck" viewBox="0 0 24 24" aria-hidden="true">' +
        (mode.id === promptMode ? MD_ICONS.check : '') + '</svg>' +
        '<span class="mdMenuItemLabel">' + esc(mode.label) + '</span>' +
        '</button>'
    }).join('') +
    '</div></div></div>'
}

/**
 * Apply one toolbar command to a textarea, returning the next value plus where the caret
 * and selection should land.
 *
 * Kept pure — it takes a value and a range and returns the next ones, touching no DOM — so
 * the wrap / unwrap / line-prefix rules can be asserted directly instead of through a
 * browser. The three cases that are easy to get wrong and are covered here:
 *
 *   1. **Round trip.** Pressing 加粗 on text that is already bold removes the markers. A
 *      toolbar that only adds markers makes bold impossible to undo without hand-editing.
 *   2. **Empty selection.** Wrapping nothing produces four asterisks with the caret in the
 *      middle, not a marker pair the user has to find and split.
 *   3. **Line prefixes** (heading, quote, list) apply to every line the selection touches,
 *      and toggle off if all of them already have it.
 *
 * @param {string} value - current textarea contents.
 * @param {number} start - selection start.
 * @param {number} end - selection end.
 * @param {string} id - one of the ids in MD_TOOLS.
 * @returns {{value: string, start: number, end: number}}
 */



/**
 * Serialize an edited rendered document back to Markdown — the ONE direction that can damage
 * the user's prompt, so it is deliberately conservative.
 *
 * WHY THIS IS THE RISKY HALF
 *
 * Rendering is lossy in one direction only: Markdown -> HTML can drop nothing the reader needs.
 * HTML -> Markdown cannot recover formatting the browser invented. So this serializer:
 *
 *   - reads ONLY the semantic tags renderMarkdown itself emits (p, h1-h6, ul, ol, li, blockquote,
 *     pre, code, strong, em, del, a, hr, table, thead, tbody, tr, th, td, br);
 *   - emits the SAME text for anything else, so an unknown element degrades to its text rather
 *     than disappearing;
 *   - never rewrites the WHOLE document from the DOM unless the rendered surface was actually
 *     edited. The caller keeps the original string and replaces it only on a real edit — that
 *     is what protects constructs this serializer does not model (unusual spacing, tables with
 *     padded separators, anything hand-written) from being normalized the moment someone merely
 *     LOOKS at the visual view.
 *
 * ROUND-TRIP CONTRACT, asserted by tools/test-preset-markdown.mjs: for every Markdown sample in
 * that suite, serialize(render(md)) must produce Markdown that renders back to the same HTML.
 * It does not have to be byte-identical to the input — a browser cannot promise that — but it
 * must not lose content or structure.
 *
 * @param {Node} root - the rendered container.
 * @returns {string} Markdown.
 */


/**
 * Which tool buttons describe the caret's current line, so the toolbar can tint them.
 *
 * This is read from the text rather than tracked as state: the line under the caret IS the
 * fact, and a cached "is bold" flag would drift from it the moment the user typed a marker by
 * hand. Cheap enough to recompute on every caret move — it looks at one line.
 *
 * @param {string} value - textarea contents.
 * @param {number} caret - selection start.
 * @returns {Record<string, boolean>}
 */



function renderPreset() {
  if (presetStatus === 'idle' || presetStatus === 'loading') {
    contentNode().innerHTML = '<div class="status"><span>正在读取预设设置…</span>' +
      '<div class="skeleton" style="width:40%;height:20px"></div>' +
      '<div class="skeleton" style="width:100%;height:200px"></div></div>'
    return
  }
  if (presetStatus === 'error') {
    contentNode().innerHTML = LZ.EmptyState.statusBlock('预设设置读不出来，可以重试。', false, presetError) +
      '<div class="status"><button type="button" id="presetRetry">重试</button></div>'
    const retry = document.getElementById('presetRetry')
    if (retry !== null) retry.addEventListener('click', function () { loadPreset() })
    return
  }

  contentNode().innerHTML =
    calloutsHtml() +
    sessionBlockHtml() +
    '<div class="presetLayout">' +
      '<section class="card"><div class="cardHead"><h3>智能体</h3><span class="spacer"></span>' +
      '<button type="button" class="btn btnSmall" id="presetAddGroup">＋ 分组</button>' +
      '<button type="button" class="btn btnSmall" id="presetAddAgent">＋ 智能体</button>' +
      '</div>' +
      '<button type="button" class="rosterItem" id="pickDefault" aria-selected="' +
      (selectedAgentId === null ? 'true' : 'false') + '">' +
      '<span class="rosterItemName">默认提示词</span>' +
      ((presetSnapshot.settings.activeAgentId === null || presetSnapshot.settings.activeAgentId === undefined)
        ? '<span class="rosterItemActive">当前</span>' : '') +
      '</button>' +
      rosterHtml() +
      '</section>' +
      '<div class="editor">' + editorHtml() + '</div>' +
    '</div>'

  wirePreset()
}

/** Attach the sub-page's listeners. Called after every render of the preset tab. */
function wirePreset() {
  const saveState = document.getElementById('presetSaveState')

  const textarea = document.getElementById('presetPrompt')

  // ---- markdown editor
  //
  // Two surfaces, one string. The visual surface IS the rendered document; the textarea holds
  // the raw Markdown. Whichever one the user is typing into owns the truth, and the other is
  // re-rendered from it on a mode switch — never simultaneously, so they cannot fight.
  //
  // The serializer is the risky direction (see its own note), so the visual surface is only
  // allowed to REPLACE promptText when it was genuinely edited. Merely opening the tab or
  // switching modes never round-trips the document through HTML, which is what protects any
  // construct the serializer does not model.
  const visual = document.getElementById('presetVisual')
  const count = document.getElementById('presetCount')
  const syncCount = function () {
    if (count !== null) count.textContent = '字符：' + promptText.length
  }
  const markDirty = function () {
    promptDirty = true
    if (saveState !== null) { saveState.textContent = '有未保存的改动'; saveState.dataset.kind = 'dirty' }
    syncCount()
  }

  /**
   * Re-render the visual surface from the current Markdown.
   *
   * This is the ONLY place that assigns the rendered HTML, because the empty-state hint has to
   * move in lockstep with it: the hint shows when the document is empty, so every path that
   * redraws the document must also restate whether it is empty. Three call sites used to assign
   * innerHTML directly, and one of them would eventually have forgotten the flag.
   *
   * Declared OUT here rather than inside the conditional below, because the toolbar's handler
   * also redraws the surface and is wired outside that block — a block-scoped version would be
   * invisible there and the guard would silently skip the redraw.
   */
  const syncVisual = function () {
    if (visual === null) return
    visual.innerHTML = LZ.Markdown.render(promptText)
    visual.dataset.empty = promptText.trim() === '' ? 'true' : 'false'
  }

  if (visual !== null && textarea !== null) {
    visual.addEventListener('input', function () {
      // Reading the edited DOM back is the only way to learn what was typed into it, and it is
      // done HERE — on a real edit — rather than on render.
      promptText = LZ.Markdown.serialize(visual)
      // The textarea is what 保存 reads from (and what the rig asserts on), so it has to carry
      // the same string. Writing it here — not in a render — keeps the two surfaces from ever
      // disagreeing about the document.
      textarea.value = promptText
      // Keep the empty-state hint honest without a re-render: after the last character is
      // deleted the hint must come back, and after the first one is typed it must go.
      visual.dataset.empty = promptText.trim() === '' ? 'true' : 'false'
      markDirty()
      syncActive()
    })
    // Pasting arrives as HTML by default, which would smuggle in styling the serializer does
    // not model. Forcing plain text keeps the paste to characters the user can see.
    visual.addEventListener('paste', function (event) {
      const text = (event.clipboardData || window.clipboardData)
      if (text === undefined || text === null) return
      event.preventDefault()
      const plain = text.getData('text/plain')
      if (plain !== '') document.execCommand('insertText', false, plain)
    })
    // The caret can land in a fresh empty block; give it a placeholder so the box does not look
    // broken when the document is empty.
    visual.addEventListener('focus', function () {
      if (visual.textContent.trim() === '' && visual.querySelector('p') === null) {
        visual.innerHTML = '<p><br></p>'
      }
    })
    visual.addEventListener('blur', function () { syncActive() })
  }

  /** Tint the buttons that describe the caret's current line. */
  const activeButtons = Array.prototype.slice.call(document.querySelectorAll('[data-md]'))
  const syncActive = function () {
    if (textarea === null) return
    // In live mode the caret lives in the visual surface, which has no line numbers, so the
    // tint is derived from the Markdown the caret's block corresponds to. In source mode the
    // textarea is the caret's home and its own selection is the truth.
    const on = LZ.Markdown.activeTools(promptText, textarea.selectionStart)
    for (const node of activeButtons) node.dataset.on = on[node.dataset.md] === true ? 'true' : 'false'
  }

  if (textarea !== null) {
    textarea.addEventListener('input', function () {
      promptText = textarea.value
      // The rendered surface is not redrawn on every keystroke in source mode (it is hidden),
      // but the empty flag is cheap and keeps the two surfaces from disagreeing the moment the
      // user switches back to live.
      if (visual !== null) visual.dataset.empty = promptText.trim() === '' ? 'true' : 'false'
      markDirty()
      syncActive()
    })
  }

  document.querySelectorAll('[data-md]').forEach(function (node) {
    // A toolbar button must not steal focus from the textarea: mousedown is what moves it,
    // and losing focus would collapse the selection the command is about to act on.
    node.addEventListener('mousedown', function (event) { event.preventDefault() })
    node.addEventListener('click', function () {
      if (textarea === null) return
      const result = LZ.Markdown.applyTool(textarea.value, textarea.selectionStart, textarea.selectionEnd, node.dataset.md)
      if (typeof textarea.setRangeText === 'function') {
        // Replace the whole value in one undoable edit, then place the caret.
        textarea.focus()
        textarea.setRangeText(result.value, 0, textarea.value.length, 'end')
      } else {
        textarea.value = result.value
        textarea.focus()
      }
      textarea.setSelectionRange(result.start, result.end)
      // Reuse the input handler's bookkeeping so the dirty badge and character count cannot
      // disagree with the textarea's actual contents.
      promptText = textarea.value
      markDirty()
      // The toolbar's transforms are string-based, so they always run against the Markdown and
      // the visual surface is re-rendered from the result. Doing it here — rather than trying to
      // apply rich-text commands to the DOM — is what keeps one authoring path for both modes.
      // The hint flag rides along inside syncVisual, so it cannot fall out of step.
      if (promptMode === 'live') syncVisual()
      syncActive()
      report('preset-md-tool', node.dataset.md)
    })
  })

  // In live mode the preview tracks the text as it is typed. Reading mode and source mode do
  // not need this, so the work is skipped rather than done and thrown away.
  if (textarea !== null) {
    const onCaret = function () { syncActive() }
    textarea.addEventListener('keyup', onCaret)
    textarea.addEventListener('click', onCaret)
    textarea.addEventListener('select', onCaret)
    syncActive()
  }

  // ---- the mode menu
  const modeBtn = document.getElementById('presetModeBtn')
  const modeMenu = document.getElementById('presetModeMenu')
  const closeModeMenu = function () {
    modeMenuOpen = false
    if (modeMenu !== null) modeMenu.hidden = true
    if (modeBtn !== null) modeBtn.setAttribute('aria-expanded', 'false')
  }
  if (modeBtn !== null && modeMenu !== null) {
    modeBtn.addEventListener('click', function (event) {
      event.stopPropagation()
      modeMenuOpen = !modeMenuOpen
      modeMenu.hidden = !modeMenuOpen
      modeBtn.setAttribute('aria-expanded', modeMenuOpen ? 'true' : 'false')
    })
    // A click anywhere else closes it. Registered on the document, removed with the frame's
    // own lifetime — the frame is torn down wholesale, so no explicit teardown is needed.
    document.addEventListener('click', closeModeMenu)
    modeMenu.addEventListener('click', function (event) { event.stopPropagation() })
  }

  // ONLY the menu items may switch modes.
  //
  // The selector here used to be the bare data-mode attribute selector, and the AREA ITSELF
  // carries that same attribute (see the .mdArea element in the editor markup, tagged with the
  // current mode). Selecting the area as well made every click inside the editor bubble up to
  // its own mode handler, which re-rendered the surface and re-focused it — wiping the caret
  // the click had just placed. The symptoms were exactly "typing always lands at the very
  // start" and "no other paragraph can be reached", because the caret was reset to position 0
  // on every click.
  document.querySelectorAll('.mdMenuItem[data-mode]').forEach(function (node) {
    node.addEventListener('click', function () {
      const next = node.dataset.mode
      if (MD_MODES.filter(function (m) { return m.id === next }).length === 0) return
      // The textarea is the source of truth; read it rather than trusting the cached copy.
      if (textarea !== null && textarea.value !== promptText) promptText = textarea.value
      promptMode = next
      // Visibility is carried by the area's data-mode only. Toggling a hidden property as
      // well would be a second source of truth that the next re-render overwrites — the two
      // would eventually disagree and the panes would show both or neither.
      const area = document.getElementById('presetArea')
      if (area !== null) area.dataset.mode = next
      const label = document.getElementById('presetModeLabel')
      const current = MD_MODES.filter(function (m) { return m.id === next })[0]
      if (label !== null && current) label.textContent = current.label
      document.querySelectorAll('.mdMenuItem').forEach(function (item) {
        const isOn = item.dataset.mode === next
        item.setAttribute('aria-checked', isOn ? 'true' : 'false')
        const check = item.querySelector('.mdCheck')
        if (check !== null) check.innerHTML = isOn ? MD_ICONS.check : ''
      })
      // Each mode is refreshed on the way IN, so nothing can show content older than the text
      // it claims to describe.
      if (visual !== null) {
        // Live and reading show the same rendered document; only editability differs. It is
        // re-rendered from promptText on entry, because a source-mode edit may have changed it.
        // syncVisual, not a direct assignment: it also restates the empty-state flag.
        syncVisual()
        visual.setAttribute('contenteditable', next === 'live' ? 'true' : 'false')
      }
      closeModeMenu()
      if (next === 'live' && visual !== null) visual.focus()
      report('preset-md-mode', next)
    })
  })

  const pickDefault = document.getElementById('pickDefault')
  if (pickDefault !== null) {
    pickDefault.addEventListener('click', function () {
      confirmDiscard().then(function (ok) {
        if (!ok) return
        selectedAgentId = null
        loadPrompt(null)
      })
    })
  }
  document.querySelectorAll('[data-pick]').forEach(function (node) {
    node.addEventListener('click', function () {
      const id = node.dataset.pick
      if (id === selectedAgentId) return
      confirmDiscard().then(function (ok) {
        if (!ok) return
        selectedAgentId = id
        loadPrompt(id)
      })
    })
  })

  const save = document.getElementById('presetSave')
  if (save !== null) {
    save.addEventListener('click', function () {
      save.disabled = true
      if (saveState !== null) { saveState.textContent = '正在保存…'; saveState.dataset.kind = '' }
      presetPost({ op: 'setPrompt', agentId: selectedAgentId, text: promptText, sessionId: sessionId })
        .then(function (payload) {
          promptDirty = false
          report('preset-save-ok', { agentId: selectedAgentId, bytes: promptText.length })
          applySnapshot(payload)
          if (onPresetTab()) LZ.App.render()
        })
        .catch(function (err) {
          report('preset-save-failed', String(err && err.message || err))
          if (saveState !== null) {
            saveState.textContent = '保存失败：' + String(err && err.message || err)
            saveState.dataset.kind = 'failed'
          }
          save.disabled = false
        })
    })
  }

  const activate = document.getElementById('presetActivate')
  if (activate !== null) {
    activate.addEventListener('click', function () {
      activate.disabled = true
      presetPost({ op: 'setActive', agentId: selectedAgentId, sessionId: sessionId })
        .then(function (payload) {
          report('preset-switch-ok', { agentId: selectedAgentId })
          applySnapshot(payload)
          if (onPresetTab()) LZ.App.render()
        })
        .catch(function (err) {
          report('preset-switch-failed', String(err && err.message || err))
          LZ.Dialog.message('切换失败', esc(String(err && err.message || err)))
          activate.disabled = false
        })
    })
  }

  const activateNone = document.getElementById('presetActivateNone')
  if (activateNone !== null) {
    activateNone.addEventListener('click', function () {
      activateNone.disabled = true
      presetPost({ op: 'setActive', agentId: null, sessionId: sessionId })
        .then(function (payload) { applySnapshot(payload); if (onPresetTab()) LZ.App.render() })
        .catch(function (err) { LZ.Dialog.message('停用失败', esc(String(err && err.message || err))); activateNone.disabled = false })
    })
  }

  const name = document.getElementById('presetName')
  const group = document.getElementById('presetGroup')
  const applyMeta = function () {
    if (selectedAgentId === null) return
    presetPost({
      op: 'upsertAgent',
      id: selectedAgentId,
      name: name !== null ? name.value : undefined,
      groupId: group !== null ? (group.value === '' ? null : group.value) : undefined,
      sessionId: sessionId,
    })
      .then(function (payload) { applySnapshot(payload); if (onPresetTab()) LZ.App.render() })
      .catch(function (err) { LZ.Dialog.message('保存失败', esc(String(err && err.message || err))) })
  }
  if (name !== null) name.addEventListener('change', applyMeta)
  if (group !== null) group.addEventListener('change', applyMeta)

  const del = document.getElementById('presetDelete')
  if (del !== null) {
    del.addEventListener('click', function () {
      const agent = agentById(selectedAgentId)
      if (agent === null) return
      // Says what actually happens: the row goes, the prompt file is MOVED to archive/ so it
      // is recoverable. The earlier text promised an unrecoverable deletion of a file that
      // was not deleted at all — wrong in both directions at once.
      LZ.Dialog.confirm(
        '删除智能体「' + agent.name + '」？',
        '提示词会移到 store 的 <code>archive/</code> 目录（可以手动找回），不再是激活名单的一部分。',
        '删除',
      ).then(function (confirmed) {
        if (!confirmed) return
        presetPost({ op: 'removeAgent', id: selectedAgentId, sessionId: sessionId })
          .then(function (payload) {
            selectedAgentId = null
            promptDirty = false
            applySnapshot(payload)
            if (onPresetTab()) LZ.App.render()
            const archived = payload && payload.archived
            if (archived && archived.moved === true) {
              LZ.Dialog.message('已删除', LZ.Dialog.line('提示词备份在', archived.to))
            } else if (archived && archived.reason) {
              // The roster write succeeded and the file move did not — report the real state
              // rather than a success the user would discover was false later.
              LZ.Dialog.message('智能体已移除，但提示词文件没能移动', esc(archived.reason))
            }
          })
          .catch(function (err) { LZ.Dialog.message('删除失败', esc(String(err && err.message || err))) })
      })
    })
  }

  const addAgent = document.getElementById('presetAddAgent')
  if (addAgent !== null) {
    addAgent.addEventListener('click', function () {
      LZ.Dialog.prompt('新智能体的名字', '新智能体', '新建').then(function (name) {
        if (name === null) return
        const group = groupById(selectedAgentId === null ? null : (agentById(selectedAgentId) || {}).groupId)
        presetPost({
          op: 'upsertAgent',
          name: name,
          groupId: group === null ? null : group.id,
          sessionId: sessionId,
        })
          .then(function (payload) {
            applySnapshot(payload)
            const created = (payload.agents || []).find(function (a) { return a.name === name })
            if (created) { selectedAgentId = created.id; promptDirty = false; loadPrompt(created.id) }
            if (onPresetTab()) LZ.App.render()
          })
          .catch(function (err) { LZ.Dialog.message('新建失败', esc(String(err && err.message || err))) })
      })
    })
  }

  const addGroup = document.getElementById('presetAddGroup')
  if (addGroup !== null) {
    addGroup.addEventListener('click', function () {
      LZ.Dialog.prompt('新分组的名字', '分组', '新建').then(function (name) {
        if (name === null) return
        presetPost({ op: 'upsertGroup', name: name, sessionId: sessionId })
          .then(function (payload) { applySnapshot(payload); if (onPresetTab()) LZ.App.render() })
          .catch(function (err) { LZ.Dialog.message('新建分组失败', esc(String(err && err.message || err))) })
      })
    })
  }

  document.querySelectorAll('[data-rename]').forEach(function (node) {
    node.addEventListener('click', function () {
      const id = node.dataset.rename
      const group = groupById(id)
      if (group === null) return
      LZ.Dialog.prompt('分组改名', group.name, '保存').then(function (name) {
        if (name === null) return
        presetPost({ op: 'upsertGroup', id: id, name: name, sessionId: sessionId })
          .then(function (payload) { applySnapshot(payload); if (onPresetTab()) LZ.App.render() })
          .catch(function (err) { LZ.Dialog.message('改名失败', esc(String(err && err.message || err))) })
      })
    })
  })

  document.querySelectorAll('[data-delgroup]').forEach(function (node) {
    node.addEventListener('click', function () {
      const id = node.dataset.delgroup
      const group = groupById(id)
      if (group === null) return
      LZ.Dialog.confirm('删除分组「' + group.name + '」？', '里面的智能体会移到未分组，提示词不受影响。', '删除').then(function (confirmed) {
        if (!confirmed) return
        presetPost({ op: 'removeGroup', id: id, sessionId: sessionId })
          .then(function (payload) { applySnapshot(payload); if (onPresetTab()) LZ.App.render() })
          .catch(function (err) { LZ.Dialog.message('删除失败', esc(String(err && err.message || err))) })
      })
    })
  })

  const switchSession = document.getElementById('presetSwitch')
  if (switchSession !== null) {
    switchSession.addEventListener('click', function () {
      switchSession.disabled = true
      presetPost({ op: 'switchSession', sessionId: sessionId })
        .then(function (payload) { applySnapshot(payload); if (onPresetTab()) LZ.App.render() })
        .catch(function (err) {
          report('preset-session-switch-failed', String(err && err.message || err))
          // The host sends the current snapshot with a refusal; take it, so the page shows
          // the real state rather than leaving a dead button.
          if (err.payload && err.payload.snapshot) applySnapshot(err.payload.snapshot)
          LZ.Dialog.message('无法切换预设', esc(String(err && err.message || err)))
          if (onPresetTab()) LZ.App.render()
        })
    })
  }

  const newSession = document.getElementById('presetNew')
  if (newSession !== null) {
    newSession.addEventListener('click', function () {
      // GUARDED AGAINST DOUBLE FIRE. The button is disabled first, but \`disabled\` only stops
      // pointer events once the element is re-rendered OR the click is checked against state
      // — a rapid double click (or a click plus an Enter keypress on the focused button) can
      // reach the handler twice before any render happens. The diag log showed exactly this:
      // two \`preset-new-session-ok\` lines ~5.7 s apart, and two sessions where the user
      // wanted one.
      if (newSessionInFlight) return
      newSessionInFlight = true
      newSession.disabled = true
      createSessionViaHost().then(function (result) {
        if (onPresetTab()) LZ.App.render()
        if (result.ok) {
          LZ.Dialog.message('已新建 LuzzyMode 会话', esc(result.detail))
        } else {
          LZ.Dialog.message('新建会话失败', esc(result.detail))
        }
      }).catch(function (err) {
        if (onPresetTab()) LZ.App.render()
        LZ.Dialog.message('新建会话失败', esc(String(err && err.message || err)))
      }).then(function () {
        newSessionInFlight = false
      })
    })
  }

  wireRosterDrag()
}

/** Guards the new-session button against a double fire. See its handler. */
let newSessionInFlight = false

/**
 * Create a LuzzyMode session by asking the HOST HALF of this plugin to do it.
 *
 * WHY IT IS NOT A FETCH
 *
 * A host route can create a session but cannot make it VISIBLE: a blank session is rendered
 * by the sidebar only while it is the selected one, and selection is client-side state. The
 * client half holds the app's own session service, which attaches the workspace AND selects
 * the session — the same two steps the sidebar's 「新会话」 button takes. The frame is a
 * separate document with no handle on app navigation, so it asks over postMessage and
 * waits for the answer.
 *
 * The timeout exists because a missing reply would otherwise leave the button disabled
 * forever with no explanation. Five seconds is far longer than a local create takes.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function createSessionViaHost() {
  return new Promise(function (resolve) {
    let settled = false
    const finish = function (result) {
      if (settled) return
      settled = true
      window.removeEventListener('message', onReply)
      clearTimeout(timer)
      resolve(result)
    }

    const onReply = function (event) {
      const data = event && event.data
      if (data === null || typeof data !== 'object') return
      if (data.source !== 'luzzy-page-host' || data.type !== 'session-created') return
      report('preset-new-session-result', { ok: data.ok === true, sessionId: data.sessionId, opened: data.opened })
      finish({ ok: data.ok === true, detail: String(data.detail || (data.ok ? '会话已创建。' : '新建会话失败。')) })
    }

    const timer = setTimeout(function () {
      report('preset-new-session-timeout')
      finish({ ok: false, detail: '宿主半没有回应新建会话的请求。可能是插件版本不一致 —— 重启 DSH 后再试。' })
    }, 5000)

    window.addEventListener('message', onReply)
    try {
      if (!window.parent || window.parent === window) {
        finish({ ok: false, detail: '当前页面不在宿主窗口里，无法新建会话。' })
        return
      }
      report('preset-new-session-request', { sessionId: sessionId })
      window.parent.postMessage({ source: 'luzzy-page-frame', type: 'create-session', sessionId: sessionId }, '*')
    } catch (error) {
      finish({ ok: false, detail: String(error && error.message || error) })
    }
  })
}

/** Promise-based discard prompt, so a caller can await the answer. */
function confirmDiscard() {
  if (!promptDirty) return Promise.resolve(true)
  return LZ.Dialog.confirm(
    '提示词有未保存的改动',
    '切走会丢掉这些改动。要放弃它们吗？',
    '放弃改动',
  )
}

/**
 * Drag-to-reorder the roster.
 *
 * Order is persisted as explicit indices for every agent in the list, not as a swap: a
 * swap between two agents in different groups would leave both group memberships stale,
 * and the host's \`reorderAgents\` op takes the whole order anyway.
 *
 * HTML5 drag events are used rather than pointer events because they give keyboard-free
 * dragging for free and need no coordinate math; the drop target is shown with a top/bottom
 * edge marker instead of a gap, which keeps the list from reflowing under the pointer.
 */
function wireRosterDrag() {
  const items = Array.prototype.slice.call(document.querySelectorAll('.rosterItem[draggable]'))
  if (items.length === 0) return
  let draggedId = null

  const clearMarkers = function () {
    items.forEach(function (node) {
      delete node.dataset.dropBefore
      delete node.dataset.dropAfter
    })
  }

  items.forEach(function (node) {
    node.addEventListener('dragstart', function (event) {
      draggedId = node.dataset.agent
      node.dataset.dragging = 'true'
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
        // Firefox refuses to start a drag without data set.
        event.dataTransfer.setData('text/plain', draggedId)
      }
    })
    node.addEventListener('dragend', function () {
      delete node.dataset.dragging
      clearMarkers()
      draggedId = null
    })
    node.addEventListener('dragover', function (event) {
      if (draggedId === null || node.dataset.agent === draggedId) return
      event.preventDefault()
      const box = node.getBoundingClientRect()
      const after = event.clientY > box.top + box.height / 2
      clearMarkers()
      node.dataset[after ? 'dropAfter' : 'dropBefore'] = 'true'
    })
    node.addEventListener('drop', function (event) {
      event.preventDefault()
      const targetId = node.dataset.agent
      const after = node.dataset.dropAfter === 'true'
      clearMarkers()
      if (draggedId === null || targetId === draggedId) return
      reorderRoster(draggedId, targetId, after)
    })
  })
}

/** Move one agent to sit before/after another, then persist the resulting order. */
function reorderRoster(draggedId, targetId, after) {
  const columns = rosterColumns()
  const flat = []
  for (const column of columns) {
    for (const agent of column.agents) flat.push({ id: agent.id, groupId: column.id })
  }
  const from = flat.findIndex(function (entry) { return entry.id === draggedId })
  if (from === -1) return

  const moved = flat.splice(from, 1)[0]
  const targetIndex = flat.findIndex(function (entry) { return entry.id === targetId })
  if (targetIndex === -1) return

  // Dropping across groups adopts the target's group — that is what the gesture means when
  // the pointer crosses a group heading.
  const targetGroup = flat[targetIndex].groupId
  moved.groupId = targetGroup
  flat.splice(after ? targetIndex + 1 : targetIndex, 0, moved)

  presetPost({
    op: 'reorderAgents',
    order: flat.map(function (entry, index) {
      return { id: entry.id, order: index, groupId: entry.groupId }
    }),
    sessionId: sessionId,
  })
    .then(function (payload) { applySnapshot(payload); if (onPresetTab()) LZ.App.render() })
    .catch(function (err) {
      report('preset-reorder-failed', String(err && err.message || err))
      LZ.Dialog.message('排序保存失败', esc(String(err && err.message || err)))
    })
}

  LZ.PresetPage = {
    render: renderPreset,
    ensure: function (force) {
      if (force === true || presetStatus === 'idle') return loadPreset()
      return Promise.resolve()
    },
    status: function () { return presetStatus },
    setSessionId: function (next) {
      const value = typeof next === 'string' && next !== '' ? next : null
      if (value === sessionId) return
      sessionId = value
      // Re-read rather than patch: a stale "cannot switch this session" badge is exactly the
      // kind of wrong statement this page must not show.
      if (onPresetTab()) loadPreset()
    },
    /** Re-render only when this page is the one on screen. */
    refresh: function () { if (onPresetTab()) renderPreset() },
  }
})(window.LZ = window.LZ || {})
