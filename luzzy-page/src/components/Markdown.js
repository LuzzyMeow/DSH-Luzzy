/* Markdown —— 渲染器、序列化器与工具栏变换。
 *
 * 这个模块整体从原 src/client.js 原样搬来，一行未改。它承载的行为都是踩出来的，
 * 重写风险极高，且测试直接从产物里按名字抽取这三个函数：
 *
 *   renderMarkdown    帧内没有 markdown 库，语法范围由 README 与提示词的实际用量决定
 *   serializeMarkdown HTML → Markdown 是**唯一会损坏提示词的方向**，所以只在真实编辑时回写；
 *                     契约是结构保真而非字节相同；未知元素降级为文本而不是整块丢弃
 *   applyMarkdownTool 纯函数（value/start/end/id → 新值 + 新选区），因此可以不启浏览器断言。
 *                     三条容易做错的语义：往返（再点一次取消）、空选区（产生一对标记并居中光标）、
 *                     按行前缀（作用于选区触及的每一行，且全都已带该标记时整体取消）
 *
 * 「实时预览」在本插件里是**渲染形态，且渲染面即可编辑面**（contenteditable），
 * 三种模式各只有一个面。切模式只允许绑菜单项——区域自己也带 data-mode，
 * 绑到它就会吞掉每次点击的光标，把插入点永远重置到文档开头。 */
(function (LZ) {
  'use strict'

  const esc = LZ.Format.esc

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  let inCode = false
  let codeLines = []
  // 'ul' | 'ol' | null. A single flag cannot express this: a bullet list followed by an
  // ordered list has to close one tag and open the other, and with a boolean the second
  // <ol> would nest inside the still-open <ul>.
  let listKind = null
  let tableRows = []

  const link = (text, href) => {
    // Already-escaped text and href. Only these schemes may become a real link.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)
    if (scheme === null || !/^(https?|mailto)$/i.test(scheme[1])) return text + ' (' + href + ')'
    return '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + text + '</a>'
  }

  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Strikethrough runs after bold has consumed its pairs, and before italic, so a
      // doubled tilde can never be mistaken for emphasis.
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      // Italic runs after bold has consumed every ** pair, so a single asterisk here is
      // unambiguous. The content must start and end on non-space: without that, ordinary
      // prose like "3 * 4 * 5" would turn into emphasis.
      .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, href) => link(text, href))

  const flushList = () => { if (listKind !== null) { out.push('</' + listKind + '>'); listKind = null } }
  const flushTable = () => {
    if (tableRows.length === 0) return
    const rows = tableRows.filter((r) => !/^\|[\s|:-]+\|$/.test(r))
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    out.push('<table>')
    rows.forEach((r, index) => {
      const tag = index === 0 ? 'th' : 'td'
      out.push('<tr>' + cells(r).map((c) => '<' + tag + '>' + inline(c) + '</' + tag + '>').join('') + '</tr>')
    })
    out.push('</table>')
    tableRows = []
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line)) {
      if (inCode) {
        out.push('<pre><code>' + esc(codeLines.join('\n')) + '</code></pre>')
        codeLines = []
        inCode = false
      } else {
        flushList(); flushTable()
        inCode = true
      }
      i++; continue
    }
    if (inCode) { codeLines.push(line); i++; continue }

    if (/^\|/.test(line)) { flushList(); tableRows.push(line); i++; continue }
    flushTable()

    const h = /^(#{1,6}) (.*)$/.exec(line)
    if (h) {
      flushList()
      // Depth is honoured up to h6 so a real document's structure survives — the toolbar only
      // produces h1-h3, but a prompt written by hand may use deeper levels and flattening
      // them would misreport the document it is meant to preview.
      const n = h[1].length
      out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>')
      i++; continue
    }

    // A task list item is checked BEFORE the plain bullet, because "- [x] text" also matches
    // the bullet pattern. It is its own <li> shape — a box plus the text — rather than a
    // <ul> item with a literal "[x]" left in it.
    const task = /^\s*[-*] \[([ xX])\] (.*)$/.exec(line)
    if (task) {
      if (listKind !== 'ul') { flushList(); out.push('<ul>'); listKind = 'ul' }
      out.push('<li class="mdTask"><span class="mdBox" data-done="' +
        (task[1].toLowerCase() === 'x' ? '1' : '0') + '"></span><span>' + inline(task[2]) + '</span></li>')
      i++; continue
    }

    if (/^\s*[-*] /.test(line)) {
      // Nesting is deliberately NOT attempted: this renderer has one indent level, and a
      // nested item is rendered as a sibling. That is a known, visible ceiling rather than a
      // silent lie — the alternative (guessing depth from leading spaces) needs a real
      // CommonMark parser, which is more than a preview needs.
      if (listKind !== 'ul') { flushList(); out.push('<ul>'); listKind = 'ul' }
      out.push('<li>' + inline(line.replace(/^\s*[-*] /, '')) + '</li>')
      i++; continue
    }
    const ordered = /^\s*(\d+)\. /.exec(line)
    if (ordered) {
      if (listKind !== 'ol') { flushList(); out.push('<ol>'); listKind = 'ol' }
      out.push('<li>' + inline(line.replace(/^\s*\d+\. /, '')) + '</li>')
      i++; continue
    }
    flushList()

    // A blockquote is only the outer '>' level; nested '>>' keeps its extra markers as text,
    // which is truthful — the prompt files use a single level.
    if (/^> ?/.test(line)) {
      out.push('<blockquote>' + inline(line.replace(/^> ?/, '')) + '</blockquote>')
      i++; continue
    }

    if (/^---+$/.test(line)) { out.push('<hr>'); i++; continue }
    if (line.trim() === '') { i++; continue }

    out.push('<p>' + inline(line) + '</p>')
    i++
  }

  if (inCode && codeLines.length) out.push('<pre><code>' + esc(codeLines.join('\n')) + '</code></pre>')
  flushList(); flushTable()
  return '<div class="markdown">' + out.join('') + '</div>'
}

function serializeMarkdown(root) {
  const out = []

  /** Inline content of a node, as Markdown. */
  const inline = (node) => {
    let text = ''
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {                       // text
        // Newlines inside a text node would break block structure, so they become spaces.
        text += child.nodeValue.replace(/\s*\n\s*/g, ' ')
        continue
      }
      if (child.nodeType !== 1) continue                // comments and the like are dropped
      const tag = child.tagName.toLowerCase()
      const inner = inline(child)
      switch (tag) {
        case 'strong': case 'b': text += '**' + inner + '**'; break
        case 'em': case 'i': text += '*' + inner + '*'; break
        case 'del': case 's': case 'strike': text += '~~' + inner + '~~'; break
        case 'code': {
          // A code span containing a backtick needs a longer fence; using the shortest fence
          // that cannot appear inside is what keeps it a single span on the way back.
          const fence = inner.includes('`') ? '``' : '`'
          text += fence + inner + fence
          break
        }
        case 'a': {
          const href = child.getAttribute('href') || ''
          // Only the schemes renderMarkdown turns into links; anything else was never a link,
          // so it stays as its own text and no syntax is invented for it.
          text += /^(https?:|mailto:)/i.test(href) ? '[' + inner + '](' + href + ')' : inner
          break
        }
        case 'br': text += '  \n'; break
        // Anything unknown keeps its text; dropping it would lose the user's words.
        default: text += inner
      }
    }
    return text
  }

  /** One block-level node, appended as Markdown. */
  const block = (node, indent) => {
    const tag = node.tagName.toLowerCase()
    const pad = indent || ''

    if (/^h[1-6]$/.test(tag)) {
      out.push(pad + '#'.repeat(Number(tag[1])) + ' ' + inline(node).trim())
      return
    }
    if (tag === 'p') {
      out.push(pad + inline(node).trim())
      return
    }
    if (tag === 'hr') {
      out.push(pad + '---')
      return
    }
    if (tag === 'pre') {
      // The language marker is not preserved: renderMarkdown does not emit one, so inventing a
      // language here would be a guess written into the user's file.
      const code = node.textContent.replace(/\n$/, '')
      out.push(pad + '```')
      for (const line of code.split('\n')) out.push(line)
      out.push(pad + '```')
      return
    }
    if (tag === 'blockquote') {
      for (const line of blocksOf(node, '')) out.push(pad + '> ' + line)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === 'li')
      items.forEach((li, index) => {
        const box = li.querySelector ? li.querySelector('.mdBox') : null
        const done = box !== null && box.getAttribute('data-done') === '1'
        let marker = tag === 'ol' ? (index + 1) + '. ' : '- '
        if (box !== null) marker += '[' + (done ? 'x' : ' ') + '] '
        // Nested lists are indented under their parent rather than flattened, so a nested
        // structure is not silently lost.
        //
        // The item's own text excludes the nested list, so the inline walker is handed a
        // SHALLOW wrapper object rather than a real element: building one with
        // document.createElement would make this function depend on a DOM that only exists in
        // the browser, and it is lifted out of the bundle and exercised directly by the tests.
        const nested = Array.from(li.children).filter((c) => /^(ul|ol)$/.test(c.tagName.toLowerCase()))
        const own = { childNodes: Array.from(li.childNodes).filter((child) => !nested.includes(child)) }
        out.push(pad + marker + inline(own).trim())
        for (const sub of nested) block(sub, pad + '  ')
      })
      return
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'))
      if (rows.length === 0) return
      const cellsOf = (tr) => Array.from(tr.children).map((c) => inline(c).trim().replace(/\|/g, '\\|'))
      const header = cellsOf(rows[0])
      out.push(pad + '| ' + header.join(' | ') + ' |')
      out.push(pad + '|' + header.map(() => '---').join('|') + '|')
      for (const tr of rows.slice(1)) out.push(pad + '| ' + cellsOf(tr).join(' | ') + ' |')
      return
    }
    // Anything else is not a block this serializer knows; its text is kept as a paragraph so
    // nothing the user wrote can vanish.
    const text = inline(node).trim()
    if (text !== '') out.push(pad + text)
  }

  /**
   * Walk a container's children, returning one Markdown line per block-level child.
   *
   * A container may hold BARE TEXT rather than elements — renderMarkdown puts a blockquote's
   * words directly inside it, with no paragraph wrapper. Returning an empty list for that case
   * silently dropped the text, so the container's own inline content is used as the fallback.
   */
  const blocksOf = (node, indent) => {
    const saved = out.length
    let sawElement = false
    for (const child of node.childNodes) {
      if (child.nodeType === 1) { sawElement = true; block(child, indent) }
      else if (child.nodeType === 3 && child.nodeValue.trim() !== '') {
        out.push((indent || '') + child.nodeValue.trim())
      }
    }
    let produced = out.slice(saved)
    if (!sawElement) {
      const text = inline(node).trim()
      produced = text === '' ? [] : [text]
    }
    out.length = saved
    return produced
  }

  // renderMarkdown wraps its output in a div carrying the markdown class, and the frame injects
  // that into the visual surface — so the element handed to this function holds a wrapper whose
  // children ARE the blocks. Without unwrapping it, the walk hits the wrapper, falls into the
  // unknown-element branch, and flattens the whole document into one line of glued-together
  // text: a heading and the paragraph after it became "Titleplain paragraph". Descending one
  // level when the root has a single container child keeps the walk on real blocks.
  let container = root
  const onlyChild = root.childNodes.length === 1 ? root.childNodes[0] : null
  if (onlyChild !== null && onlyChild.nodeType === 1 && /^(div|section|article)$/i.test(onlyChild.tagName)) {
    container = onlyChild
  }

  for (const child of container.childNodes) {
    if (child.nodeType === 1) block(child, '')
    else if (child.nodeType === 3 && child.nodeValue.trim() !== '') out.push(child.nodeValue.trim())
  }

  // Blocks are separated by exactly one blank line — that is what keeps a heading from being
  // glued onto the paragraph after it, which is how they would otherwise re-render as ONE
  // paragraph and lose the heading entirely.
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trimEnd()
  return text === '' ? '' : text + '\n'
}

function applyMarkdownTool(value, start, end, id) {
  const text = String(value)
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const selected = text.slice(from, to)

  const wrap = function (marker) {
    const len = marker.length
    const before = text.slice(Math.max(0, from - len), from)
    const after = text.slice(to, to + len)
    // Toggle off only when the SAME marker immediately brackets the selection — so bold
    // inside italics unwraps cleanly instead of eating the wrong pair.
    if (before === marker && after === marker) {
      return { value: text.slice(0, from - len) + selected + text.slice(to + len), start: from - len, end: to - len }
    }
    // An already-wrapped selection whose range sits inside the markers also toggles off.
    if (selected.length >= 2 * len && selected.slice(0, len) === marker && selected.slice(-len) === marker) {
      const inner = selected.slice(len, selected.length - len)
      return { value: text.slice(0, from) + inner + text.slice(to), start: from, end: from + inner.length }
    }
    return {
      value: text.slice(0, from) + marker + selected + marker + text.slice(to),
      start: from + len,
      end: to + len,
    }
  }

  const prefixLines = function (prefix, marker) {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1
    const lineEndRaw = text.indexOf('\n', to)
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
    const block = text.slice(lineStart, lineEnd)
    const lines = block.split('\n')
    // The marker is a regex, not a function — it has to be applied with .test(). It is also
    // deliberately non-global: a global regex carries lastIndex between .test() calls and
    // would report alternating results for the same line.
    const allPrefixed = lines.every(function (line) { return marker.test(line) })
    const next = lines.map(function (line) {
      const bare = line.replace(marker, '')
      return allPrefixed ? bare : prefix + bare
    }).join('\n')
    return { value: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length }
  }

  /**
   * Set (or clear) the ATX heading level over the selected lines.
   *
   * Distinct from prefixLines because a heading has a LEVEL, not just a marker: applying it
   * must replace whatever level was there. Treating it as a plain prefix made H3 on "## x"
   * produce "x" — the heading was deleted, which is the opposite of what was asked.
   */
  const setHeading = function (level) {
    const prefix = '#'.repeat(level) + ' '
    const lineStart = text.lastIndexOf('\n', from - 1) + 1
    const lineEndRaw = text.indexOf('\n', to)
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
    const lines = text.slice(lineStart, lineEnd).split('\n')
    // Already this exact level on every touched line -> the press removes it.
    const same = lines.every(function (line) { return line.indexOf(prefix) === 0 })
    const next = lines.map(function (line) {
      const bare = line.replace(/^#{1,6} /, '')
      return same ? bare : prefix + bare
    }).join('\n')
    return { value: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length }
  }

  switch (id) {
    case 'bold': return wrap('**')
    case 'italic': return wrap('*')
    case 'code': return wrap('`')
    case 'strike': return wrap('~~')
    // h1/h2/h3 SET the level rather than toggling. Pressing H3 on "## x" must produce
    // "### x" — the naive toggle (strip any heading, then add) produced "x" instead, silently
    // deleting the heading when the user asked to change its level. Pressing the SAME level
    // again is the only case that removes it, which is what makes it feel like a toggle.
    case 'h1': return setHeading(1)
    case 'h2': return setHeading(2)
    case 'h3': return setHeading(3)
    case 'quote': return prefixLines('> ', /^> ?/)
    case 'bullet': return prefixLines('- ', /^\s*[-*] /)
    case 'ordered': return prefixLines('1. ', /^\s*\d+\. /)
    case 'task': return prefixLines('- [ ] ', /^\s*[-*] \[[ xX]\] /)
    case 'link': {
      const label = selected === '' ? '链接文字' : selected
      const inserted = '[' + label + '](https://)'
      // Caret lands inside the href, so the URL is the next thing typed.
      return { value: text.slice(0, from) + inserted + text.slice(to), start: from + label.length + 3, end: from + inserted.length - 1 }
    }
    case 'hr': {
      const inserted = '\n\n---\n\n'
      return { value: text.slice(0, from) + inserted + text.slice(to), start: from + inserted.length, end: from + inserted.length }
    }
    case 'codeblock': {
      // Fences go on their own lines, so an inline selection becomes a block rather than a
      // run of stray fence characters glued to the surrounding prose.
      const block = '\n\n```\n' + (selected === '' ? '' : selected) + '\n```\n\n'
      const caret = from + 5 + (selected === '' ? 0 : selected.length)
      return { value: text.slice(0, from) + block + text.slice(to), start: caret, end: caret }
    }
    case 'table': {
      // A minimal 2x2 table with the header row already formatted, caret in the first cell.
      const rows = '\n\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n\n'
      const caret = from + 5
      return { value: text.slice(0, from) + rows + text.slice(to), start: caret, end: caret }
    }
    case 'clear': {
      // This button is labelled 清除行内格式 ("clear INLINE formatting"), so it strips inline
      // markers only — bold, italic, strike, inline code. Line-anchored markers (headings,
      // quotes, lists) are structure, not decoration, and are deliberately left alone.
      //
      // An empty selection strips the whole current line, because that is what "clear the
      // formatting here" means when the caret is simply sitting in the text; stripping only
      // the caret's own two characters would do nothing at all.
      const strip = (s) => s
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '$1')
      if (selected !== '') {
        const next = strip(selected)
        return { value: text.slice(0, from) + next + text.slice(to), start: from, end: from + next.length }
      }
      const lineStart = text.lastIndexOf('\n', from - 1) + 1
      const lineEndRaw = text.indexOf('\n', from)
      const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
      const next = strip(text.slice(lineStart, lineEnd))
      return { value: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length }
    }
    default: return { value: text, start: from, end: to }
  }
}

function activeToolsFor(value, caret) {
  const text = String(value)
  const at = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const lineEndRaw = text.indexOf('\n', at)
  const line = text.slice(lineStart, lineEndRaw === -1 ? text.length : lineEndRaw)
  const heading = /^(#{1,6}) /.exec(line)
  return {
    bold: /\*\*[^*\n]+\*\*/.test(line),
    italic: /(^|[^*])\*[^*\n]+\*(?!\*)/.test(line),
    strike: /~~[^~\n]+~~/.test(line),
    code: /`[^`\n]+`/.test(line),
    h1: heading !== null && heading[1].length === 1,
    h2: heading !== null && heading[1].length === 2,
    h3: heading !== null && heading[1].length === 3,
    quote: /^> ?/.test(line),
    bullet: /^\s*[-*] \[[ xX]\] /.test(line) ? false : /^\s*[-*] /.test(line),
    ordered: /^\s*\d+\. /.test(line),
    task: /^\s*[-*] \[[ xX]\] /.test(line),
  }
}

const MD_ICONS = {
  bold: '<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M15 5H9"/><path d="M15 19H9"/><path d="M13.5 5 10 19"/>',
  strike: '<path d="M4 12h16"/><path d="M16.5 7.5A4 4 0 0 0 13 5h-2.2a3 3 0 0 0-1.1 5.8"/><path d="M7.6 16.5A4 4 0 0 0 11 19h2.2a3 3 0 0 0 1.1-5.8"/>',
  code: '<path d="m9 5-5 7 5 7"/><path d="m15 5 5 7-5 7"/>',
  bullet: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  ordered: '<path d="M10 6h10"/><path d="M10 12h10"/><path d="M10 18h10"/><path d="M4 4.4h1.4V9"/><path d="M3.4 12.1h2.5L3.6 15h2.5"/><path d="M3.4 17.5h2.3c.7 0 1 .9.4 1.4l-2.4 1.6h2.5"/>',
  task: '<path d="M11 6h10"/><path d="M11 12h10"/><path d="M11 18h10"/><path d="m2.6 6 1.7 1.7L8 4.3"/><rect x="2.5" y="15.6" width="5.4" height="5.4" rx="1.3"/>',
  codeblock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 10-2 2 2 2"/><path d="m14 14 2-2-2-2"/>',
  quote: '<path d="M6 5v14"/><path d="M11 8h9"/><path d="M11 12h9"/><path d="M11 16h6"/>',
  table: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 10h18"/><path d="M9.5 10v9.5"/>',
  link: '<path d="M9.5 14.5a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M14.5 9.5a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1"/>',
  rule: '<path d="M4 12h16"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 6.5"/>',
  // Used by the group header's delete affordance. Same stroke language as the toolbar icons
  // (24x24 viewBox, no fill, round caps come from the CSS): lid, body, and the two lid ticks.
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12"/><path d="M10.5 11v6"/><path d="M13.5 11v6"/>',
}

const MD_GROUPS = [
  [
    { id: 'bold', label: '加粗', icon: 'bold' },
    { id: 'italic', label: '斜体', icon: 'italic' },
    { id: 'strike', label: '删除线', icon: 'strike' },
  ],
  [
    { id: 'code', label: '行内代码', icon: 'code' },
    { id: 'clear', label: '清除行内格式', text: 'T' },
  ],
  [
    { id: 'h1', label: '一级标题', text: 'H1' },
    { id: 'h2', label: '二级标题', text: 'H2' },
    { id: 'h3', label: '三级标题', text: 'H3' },
  ],
  [
    { id: 'bullet', label: '无序列表', icon: 'bullet' },
    { id: 'ordered', label: '有序列表', icon: 'ordered' },
    { id: 'task', label: '任务列表', icon: 'task' },
  ],
  [
    { id: 'codeblock', label: '代码块', icon: 'codeblock' },
    { id: 'quote', label: '引用', icon: 'quote' },
  ],
  [
    { id: 'table', label: '插入表格', icon: 'table' },
    { id: 'hr', label: '插入分割线', icon: 'rule' },
  ],
  [{ id: 'link', label: '插入链接', icon: 'link' }],
]

const MD_MODES = [
  { id: 'live', label: '实时预览' },
  { id: 'source', label: '源码模式' },
  { id: 'reading', label: '阅读模式' },
]

const MD_TOOLS = MD_GROUPS.reduce(function (all, group) { return all.concat(group) }, [])

  LZ.Markdown = {
    render: renderMarkdown,
    serialize: serializeMarkdown,
    applyTool: applyMarkdownTool,
    activeTools: activeToolsFor,
    ICONS: MD_ICONS,
    GROUPS: MD_GROUPS,
    MODES: MD_MODES,
    TOOLS: MD_TOOLS,
  }
})(window.LZ = window.LZ || {})
