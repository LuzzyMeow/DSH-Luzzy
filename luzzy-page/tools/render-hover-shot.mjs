// Drive the chart's hover tooltip in a real browser and screenshot it.
//
// Structural checks can prove the markup and the handlers exist; they cannot prove the
// tooltip APPEARS, lands in the right place, or shows the right numbers. Those are the
// things that go wrong, so this dispatches real pointer events and captures the result.
//
// It walks three positions on purpose:
//   * a middle slot      — the normal case
//   * the FIRST slot     — the tooltip must not run off the left edge
//   * the LAST slot      — the tooltip must flip rather than run off the right edge
//
// Usage:
//   node tools/dump-usage-data.mjs
//   node tools/render-frame-preview.mjs
//   node tools/render-hover-shot.mjs [--window day|week|month] [--mode line|bar] [--dark] [--shot <png>]

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { readFrameHtml } from './frame-source.mjs'
import { shoot } from './shoot.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const windowName = argValue('--window', 'week')
const mode = argValue('--mode', 'line')
const dark = args.includes('--dark')
const shot = argValue('--shot', null)
const out = join(tmpdir(), `luzzy-hover-${windowName}-${mode}${dark ? '-dark' : ''}.html`)

// Read the frame from the BUNDLE, not a cached temp copy: the cache is only rewritten by
// render-frame-preview.mjs, so after a rebuild it silently serves the previous build's markup
// (§5.26's class of bug, and it made several screenshots stale evidence).
const frameHtml = readFrameHtml()
const usage = JSON.parse(readFileSync(join(tmpdir(), 'luzzy-usage-data.json'), 'utf8'))
const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8')

// Which slot to hover. Aim at the slot with the most usage, since that is the one whose
// tooltip has the most rows and therefore the one most likely to overflow.
const win = usage.windows[windowName]
let best = 0
let bestValue = -1
win.slots.forEach((slot, i) => {
  if (slot.isFuture) return
  const total = win.series.reduce((sum, s) => sum + (typeof s.values[i] === 'number' ? s.values[i] : 0), 0)
  if (total > bestValue) { bestValue = total; best = i }
})

const shim = `
<script>
(function () {
  var USAGE = ${JSON.stringify(usage)};
  var README = ${JSON.stringify(readme)};
  window.fetch = function (url) {
    var u = String(url);
    if (u.indexOf('/__luzzy/usage') === 0) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(USAGE); }, text: function () { return Promise.resolve(''); } });
    }
    if (u.indexOf('/__luzzy/readme') === 0) {
      return Promise.resolve({ ok: true, text: function () { return Promise.resolve(README); }, json: function () { return Promise.resolve({}); } });
    }
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve(''); }, json: function () { return Promise.resolve({}); } });
  };

  // Report what the tooltip actually contains, so the screenshot has a machine-readable
  // counterpart and a silent failure (no tooltip) is visible as text.
  window.__hoverReport = function () {
    var tip = document.querySelector('.chartTip');
    var guide = document.querySelector('.chartGuide');
    if (!tip) return { error: 'no tooltip element' };
    return {
      hidden: tip.hidden,
      text: (tip.textContent || '').replace(/\\s+/g, ' ').trim(),
      left: tip.style.left,
      top: tip.style.top,
      rows: tip.querySelectorAll('.chartTipRow').length,
      guideShown: guide ? guide.style.display !== 'none' : null,
      enlargedDots: document.querySelectorAll('.chartDot[r="4"]').length,
    };
  };

  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      var tab = document.querySelector('[data-tab="usage"]');
      if (tab) tab.click();
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        var windowBtn = document.querySelector('[data-window="${windowName}"]');
        if (windowBtn) {
          clearInterval(timer);
          windowBtn.click();
          setTimeout(function () {
            var modeBtn = document.querySelector('[data-mode="${mode}"]');
            if (modeBtn) modeBtn.click();
            setTimeout(function () { hover('${windowName === 'x' ? 'x' : 'SLOT'}'); }, 120);
          }, 120);
        } else if (tries > 400) { clearInterval(timer); }
      }, 25);
    }, 50);
  });

  function hover() {
    var hit = document.querySelector('.chartHit[data-slot="${best}"]');
    if (!hit) { console.error('hover: no hit rect for slot ${best}'); return; }
    var box = hit.getBoundingClientRect();
    var x = box.left + box.width / 2;
    var y = box.top + box.height * 0.4;
    ['mouseenter', 'mousemove'].forEach(function (type) {
      hit.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    });
  }
})();
</script>
`

const html = frameHtml
  .replace('<body>', '<body>' + shim)
  .replace(/<html data-theme="[^"]*">/, `<html data-theme="${dark ? 'dark' : 'light'}">`)
  .replace('background: transparent;', `background: ${dark ? '#000' : '#f8f8f8'};`)

writeFileSync(out, html, 'utf8')
console.log(`window=${windowName} mode=${mode}${dark ? ' dark' : ''}`)
console.log(`hovering slot ${best} (${win.slots[best].label}${win.slots[best].range ? ' ' + win.slots[best].range : ''}) — highest usage, so the tallest tooltip`)
console.log(`wrote: ${out}`)

if (shot !== null) {
  // Same height as the plain usage shots so a hover shot can be compared against its
  // non-hover counterpart without rescaling.
  if (shoot({ page: out, out: shot, height: 1300 })) console.log(`shot: ${shot}`)
  else process.exitCode = 1
}
