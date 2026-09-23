/**
 * Run the frame in a real browser and make it say what happened — on screen.
 *
 * WHY THIS IS NOT A `--dump-dom` PROBE
 *
 * This machine runs Edge elevated, and Edge then de-elevates itself: the process that the
 * launcher starts prints `RunDeElevated: Started process` and exits immediately, with the
 * real work happening in a child. So `--dump-dom` returns ZERO BYTES — every assertion
 * against it fails, including for a page that is working — while `--screenshot` succeeds
 * because the child writes the file. Measured directly before rewriting this tool: three
 * flag variants (`--headless=new`, `--headless=old`, bare `--headless`) all produced 0
 * characters of DOM.
 *
 * So the evidence has to travel through the one channel that works: pixels. This probe
 * injects an overlay into the preview document that captures the frame's own flight
 * recorder, every `fetch` outcome, and any uncaught error, then screenshots it.
 *
 * That keeps the black-box discipline (AGENTS.md §5.4): the frame is a separate document
 * whose exceptions never reach the host, and "blank page" is not a diagnosable symptom on
 * its own. The overlay turns it into one — a thrown error, a rejected fetch, and a render
 * path never reached are different lines here.
 *
 * Usage: node tools/probe-frame-console.mjs [--tab preset] [--dark]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const tab = argValue('--tab', 'preset')
const dark = args.includes('--dark')

const shot = argValue('--shot', join(tmpdir(), `luzzy-probe-${tab}${dark ? '-dark' : ''}.png`))
const page = join(tmpdir(), `luzzy-probe-${tab}${dark ? '-dark' : ''}.html`)

// Build the artifact under test with the project's own renderer, so this probe reports on
// what ships rather than on a reimplementation.
execFileSync(process.execPath, [
  join(PLUGIN_ROOT, 'tools', 'render-frame-with-data.mjs'),
  '--tab', tab,
  ...(dark ? ['--dark'] : []),
  '--out', page,
], { stdio: 'inherit' })

const EDGE = existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'

const html = readFileSync(page, 'utf8')

// Injected immediately BEFORE the frame's own script, so it is installed after the render
// tool's fetch shim (which it wraps) and before any frame code runs.
const overlayScript = `<script>
(function () {
  var lines = [];
  var box = document.createElement('pre');
  box.id = 'probe-overlay';
  box.style.cssText = 'position:fixed;left:0;bottom:0;right:0;max-height:46vh;overflow:auto;' +
    'margin:0;padding:10px 14px;z-index:99999;background:rgba(0,0,0,0.88);color:#7CFC9A;' +
    'font:12px/1.5 Consolas,monospace;white-space:pre-wrap;border-top:2px solid #7CFC9A';
  function paint() { box.textContent = lines.join('\\n'); }
  function add(line) { lines.push(line); paint(); if (lines.length > 120) lines.shift(); }
  window.__probe = add;
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(box); paint(); });

  // The frame reports through fetch('/__luzzy/diag'). Wrapping fetch is how that becomes
  // visible here, and it also records every OTHER request the sub-page makes — which is
  // what separates "the route was never called" from "the route answered with an error".
  var inner = window.fetch;
  window.fetch = function (url, init) {
    var u = String(url);
    var isDiag = u.indexOf('/__luzzy/diag') === 0;
    var label = (init && init.method ? init.method : 'GET') + ' ' + u;
    if (isDiag) {
      try {
        var body = JSON.parse((init && init.body) || '{}');
        add('[report] ' + body.stage + (body.detail ? ' :: ' + JSON.stringify(body.detail).slice(0, 160) : ''));
      } catch (error) { add('[report] (unparsable diag body)'); }
    } else {
      add('[fetch] ' + label);
    }
    return inner.apply(this, arguments).then(function (response) {
      if (!isDiag) add('        -> ' + response.status + (response.ok ? ' ok' : ' FAILED'));
      return response;
    }, function (error) {
      if (!isDiag) add('        -> THREW ' + String(error && error.message || error));
      throw error;
    });
  };

  window.addEventListener('error', function (event) {
    add('!! window error: ' + String(event.message) + ' @' + String(event.lineno) + ':' + String(event.colno));
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    add('!! unhandled rejection: ' + String((reason && reason.message) || reason));
  });

  // The final DOM state, sampled after the frame has had time to finish. Reading it from
  // inside the page sidesteps --dump-dom entirely.
  setTimeout(function () {
    var content = document.getElementById('content');
    var inner2 = content ? content.innerHTML : null;
    add('--- state @' + new Date().toISOString().slice(11, 23) + ' ---');
    add('#content: ' + (inner2 === null ? 'MISSING' : inner2.length + ' bytes'));
    add('preset tab selected: ' + (document.querySelector('[data-tab="preset"][aria-selected="true"]') !== null));
    add('roster rendered: ' + (document.querySelector('.presetLayout') !== null));
    add('textarea rendered: ' + (document.getElementById('presetPrompt') !== null));
    if (inner2 !== null && inner2.length < 400) add('inner: ' + inner2.replace(/\\s+/g, ' ').slice(0, 320));
  }, 2500);

  // ---- DIALOG ROUND TRIP -------------------------------------------------------------
  //
  // Drives the in-frame dialog end to end and checks the two things that were broken:
  // it must appear INSIDE the document, and closing it must leave focus inside the page.
  //
  // The focus assertion is the point. The native dialogs failed precisely because they are
  // OS modals on the parent window: closing one left document.activeElement null inside the
  // frame and the host's composer dead. An in-frame dialog cannot reproduce that, and this
  // probe is what proves it rather than assuming it.
  setTimeout(function () {
    add('--- dialog probe @' + new Date().toISOString().slice(11, 23) + ' ---');

    var addBtn = document.getElementById('presetAddAgent');
    if (addBtn === null) { add('!! no presetAddAgent button to click'); return; }

    addBtn.click();

    setTimeout(function () {
      var scrim = document.querySelector('.dialogScrim');
      var dialog = document.querySelector('.dialog');
      if (scrim === null) { add('!! dialog did not open after clicking 新建智能体'); return; }
      // Inside THIS document, not a parent-window modal. That is the whole fix.
      add('dialog open in-frame: true (in document: ' + document.body.contains(scrim) + ')');
      add('dialog title: ' + (dialog ? String(dialog.querySelector('.dialogTitle').textContent) : '(none)'));
      add('dialog has an input: ' + (dialog && dialog.querySelector('.dialogInput') !== null));
      var focused = document.activeElement;
      add('focus inside the input: ' + (focused && focused.className.indexOf('dialogInput') !== -1));

      // Cancel it, then check focus landed back in the page rather than nowhere.
      var cancel = dialog.querySelector('.btn');
      cancel.click();
      setTimeout(function () {
        add('dialog closed: ' + (document.querySelector('.dialogScrim') === null));
        // A native-dialog bug would leave this null. A non-null element means the page still
        // holds keyboard focus, so the host composer stays usable after the dialog closes.
        add('activeElement after close: ' + (document.activeElement ? document.activeElement.tagName : 'NULL'));
      }, 200);
    }, 300);
  }, 3200);
})();
</script>
`

const marker = "<script>\n'use strict'"
const index = html.indexOf(marker)
if (index === -1) {
  console.error('probe: could not find the frame script to inject before')
  process.exit(1)
}
const instrumented = html.slice(0, index) + overlayScript + html.slice(index)

const dir = mkdtempSync(join(tmpdir(), 'luzzy-probe-'))
const instrumentedPath = join(dir, 'instrumented.html')
writeFileSync(instrumentedPath, instrumented, 'utf8')

try {
  const profile = join(dir, 'profile')
  const run = () => execFileSync(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--virtual-time-budget=9000',
    '--window-size=1200,1400',
    `--screenshot=${shot}`,
    `file:///${instrumentedPath.replace(/\\/g, '/')}`,
  ], { timeout: 90_000, stdio: ['ignore', 'ignore', 'ignore'] })

  try {
    run()
  } catch {
    // Edge exits non-zero when it hands a launch to an instance still shutting down
    // (AGENTS.md §5.16); one retry absorbs it.
    run()
  }

  console.log(`probe: ${tab}${dark ? ' dark' : ''}`)
  console.log(`  instrumented: ${instrumentedPath}`)
  console.log(`  screenshot:   ${shot}`)
  console.log('  read the overlay at the bottom of the image for the frame\'s own trace')
} catch (error) {
  console.error(`probe: screenshot failed — ${error.message}`)
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // best effort
  }
  process.exit(1)
}
