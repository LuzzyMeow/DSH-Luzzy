/* dialog —— 帧内自建对话框，替代原生 alert / confirm / prompt。
 *
 * 为什么必须自建（这是用户报过的一个真 bug 的修复）
 * ------------------------------------------------
 * 原生对话框是 **Electron 窗口的 OS 级模态框**，不是页面里的元素。关掉之后
 * **键盘焦点不会还给 web contents** —— 底部输入框从此点不动，直到用户切走再切回
 * （那一步强制 OS 重新激活窗口）。页面里没有任何办法修，因为焦点从来就不在页面手上。
 *
 * 三条实现纪律：
 *   1. 关闭时显式 document.body.focus()   ← 原生对话框做不到的那一步
 *   2. 同一时刻只留一个对话框，新开的先关旧的（两层遮罩叠着，下层按钮点不到）
 *   3. 每条路径恰好 resolve 一次（确认 / 取消 / Escape / 点遮罩），否则调用方的 .then 永远挂着
 *
 * test-client-load.mjs 有一条**故意做得很粗**的断言：帧模板里出现任何 alert( / confirm( /
 * prompt( 即失败。一次疏忽就会退回这个 bug。 */
(function (LZ) {
  'use strict'

  const esc = LZ.Format.esc

let closeActiveDialog = null

function showDialog(spec) {
  return new Promise(function (resolve) {
    // Supersede any open dialog: two scrims stacked would both be clickable and the lower
    // one's buttons would be unreachable.
    if (closeActiveDialog !== null) closeActiveDialog({ confirmed: false, value: '' })

    const scrim = document.createElement('div')
    scrim.className = 'dialogScrim'
    scrim.setAttribute('role', 'dialog')
    scrim.setAttribute('aria-modal', 'true')

    const box = document.createElement('div')
    box.className = 'dialog'

    const title = document.createElement('h3')
    title.className = 'dialogTitle'
    title.textContent = spec.title
    box.appendChild(title)

    if (spec.body) {
      const body = document.createElement('p')
      body.className = 'dialogBody'
      // Bodies carry file paths and quoted error text, so they are built from a string with
      // one escape hatch for <code>. `esc` everything else.
      body.innerHTML = spec.body
      box.appendChild(body)
    }

    // 可滚动内容区（查看器用）。
    //
    // 为什么放在对话框里而不是页面上再套一个滚动框：嵌套滚动本身就是断层感的来源 ——
    // 页面滚一层、内容再滚一层，滚轮到底该滚谁要看指针在哪。查看器**应该脱离页面流**，
    // 占满一屏、内部只有一层滚动。而帧内早就有了这个对话框原语（纯 DOM、ESC、遮罩、
    // 焦点归位都做过，§5.22 那些坑都填过了），复用它比新造一个查看器窗口更稳。
    //
    // `tall` 交给 CSS 决定高度上限：这里不写死像素，避免窄屏下顶穿。
    if (typeof spec.content === 'string') {
      const content = document.createElement('div')
      content.className = 'dialogContent'
      content.innerHTML = spec.content
      content.setAttribute('tabindex', '0')
      content.setAttribute('aria-label', spec.title)
      box.appendChild(content)
    }

    let input = null
    if (typeof spec.input === 'string') {
      // `lines > 1` gives a textarea. A goal objective is routinely a paragraph, and a
      // single-line input silently swallows the newlines a user types — the text arrives
      // flattened with no indication that anything was lost. Everything downstream (the
      // service, the artifact, the injected block) preserves newlines, so only this widget
      // was ever the bottleneck.
      const lines = Number.isSafeInteger(spec.lines) && spec.lines > 1 ? spec.lines : 1
      input = document.createElement(lines > 1 ? 'textarea' : 'input')
      input.className = 'dialogInput'
      if (lines > 1) {
        input.rows = lines
        // Enter inserts a newline in a textarea; the dialog's own key handler must not treat
        // it as "confirm", or a multi-line objective could never be typed.
        input.setAttribute('data-multiline', 'true')
      }
      input.value = spec.input
      input.setAttribute('aria-label', spec.title)
      box.appendChild(input)
    }

    const actions = document.createElement('div')
    actions.className = 'dialogActions'

    let settled = false
    function finish(confirmed) {
      if (settled) return
      settled = true
      closeActiveDialog = null
      document.removeEventListener('keydown', onKey, true)
      scrim.remove()
      // Returning focus to the frame's body is the whole point: with a native dialog this is
      // exactly the step that could not be done, which left the host's composer dead.
      try {
        if (document.body !== null) document.body.focus()
      } catch (error) {
        /* focus is best-effort */
      }
      resolve({ confirmed: confirmed, value: input !== null ? input.value : '' })
    }

    if (spec.cancelLabel !== null) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'btn'
      cancel.textContent = spec.cancelLabel || '取消'
      cancel.addEventListener('click', function () { finish(false) })
      actions.appendChild(cancel)
    }

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = spec.danger ? 'btn btnPrimary btnDanger' : 'btn btnPrimary'
    confirm.textContent = spec.confirmLabel || '确定'
    confirm.addEventListener('click', function () { finish(true) })
    actions.appendChild(confirm)
    box.appendChild(actions)

    scrim.appendChild(box)

    // A click on the scrim — but not inside the box — dismisses. `mousedown` rather than
    // `click`: a drag that starts inside the textarea and ends on the scrim would otherwise
    // close the dialog and lose the text.
    scrim.addEventListener('mousedown', function (event) {
      if (event.target === scrim) finish(false)
    })

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      } else if (
        event.key === 'Enter' &&
        input !== null &&
        event.target === input &&
        // A multiline input must be able to receive Enter as a newline. Without this the
        // dialog confirmed on the first Enter and the user could never write a second line —
        // and it would look like the textarea simply did not work.
        input.getAttribute('data-multiline') !== 'true'
      ) {
        event.preventDefault()
        finish(true)
      }
    }
    document.addEventListener('keydown', onKey, true)

    closeActiveDialog = finish

    document.body.appendChild(scrim)
    if (input !== null) {
      input.focus()
      input.select()
    } else {
      confirm.focus()
    }
  })
}

function showMessage(title, body) {
  return showDialog({ title: title, body: body || '', cancelLabel: null, confirmLabel: '确定' })
}
function showConfirm(title, body, confirmLabel) {
  return showDialog({ title: title, body: body || '', confirmLabel: confirmLabel || '确定' }).then(function (result) {
    return result.confirmed === true
  })
}
function showPrompt(title, initial, confirmLabel, lines) {
  return showDialog({ title: title, input: initial, confirmLabel: confirmLabel || '确定', lines: lines || 1 }).then(function (result) {
    return result.confirmed ? result.value : null
  })
}
function dialogLine(label, value) {
  return esc(label) + ' <code>' + esc(value) + '</code>'
}

  LZ.Dialog = {
    show: showDialog,
    message: showMessage,
    confirm: showConfirm,
    prompt: showPrompt,
    line: dialogLine,
  }
})(window.LZ = window.LZ || {})
