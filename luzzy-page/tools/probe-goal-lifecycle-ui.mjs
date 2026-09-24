// Drive the goal lifecycle dialog with a REAL mouse and keyboard, inside the frame.
//
// The unit suite proves the route translates ops correctly. This proves the other half: that the
// dialog behaves for a person. Driven by Input.dispatchMouseEvent / dispatchKeyEvent rather than
// element.click(), because the latter bypasses hit testing and would report success on a control
// that is covered or unreachable (AGENTS.md §5.29 — a synthetic insert "passed" on a surface the
// user could not type into).
//
// TWO THINGS THIS PINS THAT A SCREENSHOT CANNOT
//
//   1. Enter must insert a NEWLINE in the objective field. If it confirms instead, a multi-line
//      objective can never be typed, and the textarea simply looks broken.
//   2. Escape must resolve the dialog's promise, so the caller's in-flight latch clears. If it
//      does not, the 建立目标 button is dead for the rest of the session — and nothing throws.
//
// Coordinates come from inside the frame and are then offset by the iframe's own origin, which
// is the pattern review-preset-rig.mjs established.
import { loadFrameBuilder } from './frame-source.mjs'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'
import { frameWithStub, writeHostPage, IN_FRAME, sleep } from './acceptance-harness.mjs'

const WIDTH = 1630
const HEIGHT = 984

const { srcDoc } = loadFrameBuilder()
const hostPath = writeHostPage(frameWithStub('light'), { width: WIDTH, height: HEIGHT, theme: 'light', label: 'lifecycle' })
const launcher = await launchEdge({ headless: true, windowSize: { width: WIDTH, height: HEIGHT } })
const session = await attach({ port: launcher.port })
const page = await session.openTarget(`file:///${hostPath.replace(/\\/g, '/')}`)

let failures = 0
let checks = 0
function check(label, ok, detail = '') {
  checks += 1
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** Run a function inside the frame document. */
const inFrame = (body) => page.evaluate(`(${IN_FRAME})(${body})`)

/** The iframe's own origin, so frame-local coordinates can become page coordinates. */
async function frameOrigin() {
  return page.evaluate(`(() => {
    const r = document.getElementById('frame').getBoundingClientRect()
    return { x: r.x, y: r.y }
  })()`)
}

/** Real-click the centre of a frame-local selector. */
async function clickInFrame(selector) {
  const point = await inFrame(`(doc) => {
    const el = doc.querySelector(${JSON.stringify(selector)})
    if (el === null) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName }
  }`)
  if (point === null) return null
  const origin = await frameOrigin()
  await page.clickAt(point.x + origin.x, point.y + origin.y)
  return point
}

try {
  const ok = await page.waitFor('#frame', { timeoutMs: 15000 })
  if (!ok) throw new Error('the frame never appeared')
  await sleep(2500)

  console.log('goal-lifecycle-ui: what the overview card offers for an active goal')

  const buttons = await inFrame(`(doc) => [...doc.querySelectorAll('.cardHead .btn')].map((b) => b.textContent.trim() + '#' + (b.id || '-'))`)
  console.log(`  buttons: ${buttons.join(' | ')}`)
  check('the 暂停 control is rendered for an active goal', buttons.some((b) => b.startsWith('暂停')), buttons.join(' | '))
  check('and 标记完成 is NOT offered while the gate would refuse it',
    !buttons.some((b) => b.startsWith('标记完成')), buttons.join(' | '))

  console.log('\ngoal-lifecycle-ui: the objective dialog, driven for real')

  // Open it through the same call the button makes. The button lives in the EMPTY state, which
  // needs a session with no goal; the fixture always answers with one, so the dialog itself is
  // what gets exercised here.
  await inFrame(`(doc, win) => {
    win.__probe = { resolved: 'unset' }
    win.LZ.Dialog.prompt('建立目标', '', '建立', 6).then((value) => { win.__probe.resolved = value })
    return true
  }`)
  await sleep(400)

  const shape = await inFrame(`(doc) => {
    const scrim = doc.querySelector('.dialogScrim')
    if (scrim === null) return { open: false }
    const input = scrim.querySelector('.dialogInput')
    return {
      open: true,
      inDocument: doc.body.contains(scrim),
      tag: input === null ? null : input.tagName.toLowerCase(),
      rows: input === null ? null : input.rows,
      multiline: input === null ? null : input.getAttribute('data-multiline'),
    }
  }`)
  console.log(`  dialog: ${JSON.stringify(shape)}`)
  // A native alert/confirm/prompt is an OS-modal that steals window focus and never returns it
  // (§5.22). Being inside the document is the structural difference.
  check('the dialog is inside the document, not a native OS dialog', shape.open === true && shape.inDocument === true)
  check('the objective field is a textarea', shape.tag === 'textarea', String(shape.tag))
  check('tall enough to see a paragraph', shape.rows >= 3, String(shape.rows))
  check('and it is marked multi-line, so Enter is handled as text', shape.multiline === 'true', String(shape.multiline))

  // Click INTO the field with a real mouse (not focus()), then type two lines.
  const clicked = await clickInFrame('.dialogScrim .dialogInput')
  check('a real click lands on the objective field', clicked !== null && clicked.tag === 'TEXTAREA', JSON.stringify(clicked))
  await sleep(150)

  const caret = await inFrame(`(doc) => doc.activeElement === null ? 'null' : doc.activeElement.tagName`)
  check('and focus followed the click', caret === 'TEXTAREA', String(caret))

  // `page.type(selector, text)` resolves its selector against the TOP-LEVEL document, and the
  // dialog lives inside the iframe, so it cannot find it. The click above already put the caret
  // in the textarea with a real mouse, so these keys go straight to the FOCUSED element — which
  // is also the more honest test: it types where the user's caret is, not where a selector points.
  //
  // One character per event: CDP rejects a multi-character `text` parameter outright.
  const typeRaw = async (text) => {
    for (const char of text) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
    }
  }
  // `code` is the DOM key name (a string); `windowsVirtualKeyCode` is the number.
  //
  // Enter MUST carry `text: '\r'`. Without it CDP performs the key's shortcut action but NOT its
  // default text insertion, so a textarea never receives the newline — and the page gets blamed
  // for the instrument's omission. The control textarea below is what caught this: it proved the
  // dispatch could not break a line ANYWHERE, which means it said nothing about the dialog.
  const pressRaw = async (key, code, vk, text) => {
    const down = { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }
    if (text !== undefined) down.text = text
    await page.send('Input.dispatchKeyEvent', down)
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  }

  await typeRaw('第一行目标')
  await pressRaw('Enter', 'Enter', 13, '\r')
  await typeRaw('第二行目标')
  await sleep(300)

  // ---- CONTROL GROUP -------------------------------------------------------
  //
  // Before concluding anything about the dialog, establish that THIS dispatch can insert a
  // newline at all. A plain textarea with no handlers receives exactly the same events; if it
  // also refuses to break the line, the instrument is at fault and the product says nothing.
  // (AGENTS.md §5.29: without a control group the first instinct is to doubt the工具 instead of
  // the page — and here the suspicion is well founded, because CDP only performs a key's default
  // text action when the event carries `text`.)
  const control = await inFrame(`(doc) => {
    const ta = doc.createElement('textarea')
    ta.id = 'probeControl'
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    doc.body.appendChild(ta)
    ta.focus()
    return doc.activeElement === ta
  }`)
  check('the control textarea exists and is focused', control === true)
  await typeRaw('甲')
  await pressRaw('Enter', 'Enter', 13, '\r')
  await typeRaw('乙')
  await sleep(150)
  const controlValue = await inFrame(`(doc) => {
    const ta = doc.getElementById('probeControl')
    return { value: ta === null ? null : ta.value, stillThere: ta !== null }
  }`)
  console.log(`  control textarea value: ${JSON.stringify(controlValue.value)}`)
  const instrumentCanBreakLines = controlValue.value === '甲\n乙'
  check('CONTROL: the same dispatch DOES insert a newline in a plain textarea',
    instrumentCanBreakLines,
    instrumentCanBreakLines
      ? ''
      : 'the instrument cannot produce a newline at all, so the dialog assertion below proves nothing about the dialog')
  // Clean up and restore focus to the dialog's field, so the assertions below still measure the
  // thing under test.
  await inFrame(`(doc) => {
    const ta = doc.getElementById('probeControl')
    if (ta !== null) ta.remove()
    const field = doc.querySelector('.dialogScrim .dialogInput')
    if (field !== null) field.focus()
    return true
  }`)

  const typed = await inFrame(`(doc) => {
    const input = doc.querySelector('.dialogScrim .dialogInput')
    return { value: input === null ? null : input.value, stillOpen: doc.querySelector('.dialogScrim') !== null }
  }`)
  console.log(`  typed: ${JSON.stringify(typed.value)}`)
  check('Enter did NOT confirm the dialog', typed.stillOpen === true, 'the dialog closed on the first Enter')
  check('both lines are in the field', typed.value === '第一行目标\n第二行目标', JSON.stringify(typed.value))

  console.log('\ngoal-lifecycle-ui: Escape resolves, so the caller is not left latched')

  await pressRaw('Escape', 'Escape', 27)
  await sleep(400)
  const afterEscape = await inFrame(`(doc, win) => ({
    closed: doc.querySelector('.dialogScrim') === null,
    resolved: win.__probe.resolved,
    active: doc.activeElement === null ? 'null' : doc.activeElement.tagName,
  })`)
  check('Escape closes the dialog', afterEscape.closed === true)
  // `null` is the cancel answer. Anything else (notably the literal string 'unset') means the
  // promise never resolved — which is the failure that silently bricks the button.
  check('and resolves with the cancel answer', afterEscape.resolved === null, JSON.stringify(afterEscape.resolved))
  // With a native dialog this is the step that could not be done, leaving the host's composer dead.
  check('focus stays inside the frame', afterEscape.active !== 'null', JSON.stringify(afterEscape.active))
} finally {
  try { await shutdown({ child: launcher?.child, profile: launcher?.profile, session }) } catch (error) { void error }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} check(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} checks (goal lifecycle UI, real mouse and keyboard)`)
