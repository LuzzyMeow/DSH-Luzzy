/**
 * A dependency-free Chrome DevTools Protocol driver, for real interaction in a real browser.
 *
 * WHY THIS EXISTS AND WHY IT IS HAND-WRITTEN
 *
 * Everything else in this plugin's verification pipeline is a screenshot. A screenshot cannot
 * tell you whether a click did anything, whether the console threw, or whether focus came
 * back to the page — and this feature's three worst bugs were all invisible to pixels:
 * a blank frame from a template-literal error, a dialog that stole window focus, and a
 * session id silently set to null by an untyped message.
 *
 * Three routes to a driven browser were tried on this machine, and only this one works:
 *
 *   * `--dump-dom` returns **0 bytes** always — Edge runs elevated and re-launches itself
 *     de-elevated, so the launcher exits before the DOM is dumped. (This is documented in
 *     AGENTS.md §5.18 as "headless assertions are impossible", which is too strong: the
 *     limitation is that FLAG, not headless mode. `--screenshot` and CDP both work.)
 *   * `agent-browser` (the CLI named in the skill roster) fails to launch Edge here for the
 *     same re-elevation reason: "Chrome exited early (exit code: 0) without writing
 *     DevToolsActivePort". It works against an already-running browser, but its own daemon
 *     then hangs on Windows.
 *   * **A hand-rolled CDP client works**, because `--remote-debugging-port` DOES produce a
 *     DevToolsActivePort file and a live HTTP+WebSocket endpoint. Node 24 ships a built-in
 *     `WebSocket`, so this needs no packages at all.
 *
 * WHAT "REAL INTERACTION" MEANS HERE
 *
 * Clicks go through `Input.dispatchMouseEvent`, not `element.click()`. That distinction is
 * load-bearing: a synthetic `.click()` bypasses hit-testing, pointer-events, and overlays, so
 * it would pass on a button that is covered by an invisible scrim — exactly the class of bug
 * that made a dialog unclickable in the shipped build.
 *
 * @module luzzy-page/tools/cdp-driver
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The Edge that exists on this machine. Chrome is not installed. */
export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Launch Edge with CDP enabled and wait until the endpoint is actually answering.
 *
 * `--remote-debugging-port=0` asks the OS for a free port, which Edge then writes into
 * `DevToolsActivePort` in the profile directory. Reading it back is the only reliable way to
 * learn the port: passing a fixed one risks colliding with a previous run whose browser has
 * not finished exiting, which is the same class of failure documented in shoot.mjs.
 */
export async function launchEdge({ headless = true, windowSize = { width: 1280, height: 1000 }, extraArgs = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'luzzy-cdp-'))
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--window-size=${windowSize.width},${windowSize.height}`,
    // A blank first target. Any real navigation happens through Target.createTarget, so the
    // driver never depends on whatever tab the browser decided to open on its own — that
    // mistake attached to Edge's sync-confirmation dialog once already.
    'about:blank',
    ...extraArgs,
  ]

  const child = spawn(EDGE, args, { stdio: 'ignore', detached: false })

  const portFile = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 30_000
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) {
      try { child.kill() } catch { /* already gone */ }
      rmSync(profile, { recursive: true, force: true })
      throw new Error(`Edge did not write DevToolsActivePort within 30s (profile ${profile})`)
    }
    await sleep(200)
  }

  // The file is two lines: the port, then the browser's WebSocket path. It can exist before
  // it is fully written, so retry the read rather than assuming a complete file.
  let port = null
  for (let attempt = 0; attempt < 25 && port === null; attempt += 1) {
    try {
      const [first] = readFileSync(portFile, 'utf8').split('\n')
      const parsed = Number.parseInt(first.trim(), 10)
      if (Number.isInteger(parsed) && parsed > 0) port = parsed
    } catch {
      // Still being written.
    }
    if (port === null) await sleep(200)
  }
  if (port === null) {
    try { child.kill() } catch { /* already gone */ }
    rmSync(profile, { recursive: true, force: true })
    throw new Error('DevToolsActivePort was written but never became readable')
  }

  // Wait for the HTTP endpoint, not just the file: the port is bound slightly before the
  // server answers, and racing it produces a confusing ECONNREFUSED on the first call.
  let version = null
  const httpDeadline = Date.now() + 20_000
  while (version === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })
      if (response.ok) version = await response.json()
    } catch {
      // Not listening yet.
    }
    if (version === null) {
      if (Date.now() > httpDeadline) {
        try { child.kill() } catch { /* already gone */ }
        rmSync(profile, { recursive: true, force: true })
        throw new Error(`CDP endpoint on ${port} never became reachable`)
      }
      await sleep(200)
    }
  }

  return { child, port, profile, version }
}

/**
 * A CDP session with a small, explicit surface.
 *
 * Attach to the BROWSER endpoint and create a target, rather than picking a page out of
 * `/json/list`. `/json/list` returns whatever Edge opened on its own — which on the first
 * attempt here was `edge://sync-confirmation-dialog/`, and the driver then spent its time
 * querying a page nobody had asked for.
 */
export async function attach({ port }) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json()
  const socket = new WebSocket(version.webSocketDebuggerUrl)

  let nextId = 0
  const pending = new Map()
  /** Every protocol event, in arrival order. Read by callers; never cleared silently. */
  const events = []
  /** Rejections for in-flight calls, filled when the socket dies. */
  let closedReason = null

  socket.addEventListener('message', (message) => {
    const parsed = JSON.parse(message.data)
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      const { resolve, reject } = pending.get(parsed.id)
      pending.delete(parsed.id)
      if (parsed.error) reject(new Error(`${parsed.error.message}${parsed.error.data ? ` (${parsed.error.data})` : ''}`))
      else resolve(parsed.result)
      return
    }
    if (parsed.method) events.push(parsed)
  })

  socket.addEventListener('close', () => {
    closedReason = 'the CDP socket closed'
    for (const { reject } of pending.values()) reject(new Error(closedReason))
    pending.clear()
  })

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error(`could not open a CDP socket on ${port}`)), { once: true })
  })

  /**
   * One protocol call. Every call is bounded: an unbounded await on a dead renderer is how a
   * diagnostic script hangs forever instead of reporting.
   */
  function send(method, params = {}, sessionId, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (closedReason !== null) {
        reject(new Error(closedReason))
        return
      }
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /**
   * Open a URL in its own target and return a handle bound to that target.
   *
   * `flatten: true` puts this session's messages on the same socket, addressed by sessionId,
   * which keeps one connection for everything.
   */
  async function openTarget(url) {
    const { targetId } = await send('Target.createTarget', { url })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

    const page = {
      targetId,
      sessionId,
      send: (method, params, options) => send(method, params, sessionId, options),

      async enable() {
        await send('Page.enable', {}, sessionId)
        await send('Runtime.enable', {}, sessionId)
        await send('Log.enable', {}, sessionId)
      },

      /** Evaluate and return the value; throws the page's own error if it threw. */
      async evaluate(expression, { awaitPromise = true } = {}) {
        const result = await send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise },
          sessionId,
        )
        if (result.exceptionDetails) {
          const description = result.exceptionDetails.exception?.description
            ?? result.exceptionDetails.text
            ?? 'evaluate threw'
          throw new Error(`page threw: ${description}`)
        }
        return result.result?.value
      },

      /** Wait for a CSS selector to exist, by polling. Returns false on timeout. */
      async waitFor(selector, { timeoutMs = 10_000, pollMs = 100 } = {}) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const found = await page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
          if (found === true) return true
          await sleep(pollMs)
        }
        return false
      },

      /** Centre point of an element, in CSS pixels — what Input.dispatchMouseEvent wants. */
      async centreOf(selector) {
        const box = await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
        })()`)
        if (box === null) throw new Error(`element not visible or absent: ${selector}`)
        return box
      },

      /**
       * A real mouse click at the element's centre.
       *
       * Deliberately NOT `element.click()`. Hit-testing is the point: if a scrim covers the
       * button, the coordinates land on the scrim and the page does not react — which is the
       * truth about what a user would experience.
       */
      async click(selector, { button = 'left' } = {}) {
        const { x, y } = await page.centreOf(selector)
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }, sessionId)
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }, sessionId)
        return { x, y }
      },

      /** Click raw coordinates — for asserting that something is or is not covered. */
      async clickAt(x, y) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
      },

      /** Focus an element and type into it with real key events. */
      async type(selector, text) {
        await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('no element ' + ${JSON.stringify(selector)});
          el.focus();
        })()`)
        for (const char of text) {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char }, sessionId)
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char }, sessionId)
        }
      },

      /** Replace a field's value and fire `input`, so framework listeners see the change. */
      async setValue(selector, value) {
        await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('no element ' + ${JSON.stringify(selector)});
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`)
      },

      /** One key press by name, e.g. Escape, Enter, ArrowLeft. */
      async press(key) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCodeFor(key) }, sessionId)
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCodeFor(key) }, sessionId)
      },

      /** What the element under these coordinates actually is — for hit-testing assertions. */
      async elementAt(x, y) {
        return page.evaluate(`(() => {
          const el = document.elementFromPoint(${x}, ${y});
          if (!el) return null;
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            id: el.id || '',
            text: (el.textContent || '').trim().slice(0, 60)
          };
        })()`)
      },

      /** Screenshot as a PNG Buffer. Used for visual acceptance and for hash comparisons. */
      async screenshot() {
        const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId, { timeoutMs: 30_000 })
        return Buffer.from(data, 'base64')
      },

      /** Console messages, in order. */
      consoleMessages() {
        return events
          .filter((event) => event.method === 'Runtime.consoleAPICalled')
          .map((event) => ({
            type: event.params.type,
            text: event.params.args
              .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type))
              .join(' '),
          }))
      },

      /** Uncaught exceptions and log entries of level error. */
      errors() {
        const fromRuntime = events
          .filter((event) => event.method === 'Runtime.exceptionThrown')
          .map((event) => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
        const fromLog = events
          .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
          .map((event) => event.params.entry.text)
        return [...fromRuntime, ...fromLog]
      },
    }

    await page.enable()
    return page
  }

  return {
    socket,
    send,
    openTarget,
    events,
    /** Close the socket. Does not stop the browser — call the launcher's teardown for that. */
    close() {
      try { socket.close() } catch { /* already closed */ }
    },
  }
}

/**
 * Tear a browser down and remove its profile.
 *
 * THREE WRONG WAYS, AND WHY
 *
 *   1. **`child.kill()` on the spawned process does nothing useful.** On this machine Edge
 *      runs elevated and hands off: the process `spawn` returns exits almost immediately
 *      (that is the same behaviour that makes `--dump-dom` return 0 bytes and makes
 *      `agent-browser` report "Chrome exited early without writing DevToolsActivePort"). So
 *      the browser that actually owns the profile is a DIFFERENT pid, and killing the
 *      launcher's pid is a no-op. Measured: 21 Edge processes survived, across two runs.
 *
 *   2. **Guarding on `child.exitCode === null` skips the kill entirely.** Because the
 *      launcher has already exited, that condition is false and the whole branch is bypassed
 *      — the first version of this function did exactly that and leaked every run.
 *
 *   3. **Killing only the browser process leaves the children holding handles.** Even when
 *      the root is killed, the GPU / renderer / crashpad children keep the profile directory
 *      locked, so `rmSync` fails with EBUSY. The whole tree has to go.
 *
 * The reliable route is `Browser.close` over CDP — the browser shuts down itself and its
 * children, with no process enumeration and no assumptions about pids. If that does not
 * clear the profile, a profile-scoped tree kill follows; the `--user-data-dir` is unique per
 * run, so matching on it can only ever hit this run's processes.
 *
 * Teardown never throws: a failure here would mask the result the caller actually came for.
 *
 * @returns {Promise<{closed: 'cdp' | 'force' | 'none', profileRemoved: boolean}>}
 */
export async function shutdown({ child, profile, session }) {
  let closed = 'none'

  // 1. Ask the browser to close itself. This is the only step that needs the live socket.
  if (session !== undefined && session !== null) {
    try {
      await session.send('Browser.close', {}, undefined, { timeoutMs: 5000 })
      closed = 'cdp'
    } catch {
      // The socket may already be gone, or the call may be refused during teardown.
    }
  }

  /** Give the profile a chance to become deletable. */
  const tryRemove = async (budgetMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (profile === undefined || profile === null) return true
      try {
        rmSync(profile, { recursive: true, force: true })
        return true
      } catch {
        await sleep(400)
      }
    }
    return profile === undefined || profile === null || !existsSync(profile)
  }

  if (await tryRemove(6000)) {
    return { closed, profileRemoved: true }
  }

  // 2. Still there: kill every process carrying this run's profile path, tree-wise.
  if (process.platform === 'win32' && typeof profile === 'string') {
    closed = closed === 'none' ? 'force' : closed
    const escaped = profile.replace(/'/g, "''")
    const script = [
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"`,
      `| Where-Object { $_.CommandLine -like '*${escaped}*' }`,
      `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ].join(' ')
    try {
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 20_000 })
    } catch {
      // Best effort only.
    }
  }

  // 3. Last resort: the signal path, in case the launcher is a real long-lived process
  //    somewhere else (non-Windows, or a future Edge that stops handing off).
  if (child && child.exitCode === null) {
    try { child.kill() } catch { /* already gone */ }
    const deadline = Date.now() + 5000
    while (child.exitCode === null && Date.now() < deadline) await sleep(150)
    if (child.exitCode === null) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }

  if (await tryRemove(10_000)) {
    return { closed, profileRemoved: true }
  }

  // Non-fatal: the temp directory is the OS's to reclaim. Say so rather than throwing during
  // teardown, which would mask whatever the test actually found.
  console.log(`  note: could not remove ${profile} (still locked) — safe to delete later`)
  return { closed, profileRemoved: false }
}

/** Windows virtual key codes for the keys this suite presses. */
function keyCodeFor(key) {
  const table = { Escape: 27, Enter: 13, Tab: 9, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Backspace: 8 }
  return table[key] ?? 0
}
