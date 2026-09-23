// Drive the window/mode controls in a real browser and screenshot MID-ANIMATION.
//
// The animation is the one requirement a static screenshot cannot prove: by the time a
// normal capture fires, the transition has already finished and the result looks identical
// to no animation at all. So this captures immediately after the click, while the plot is
// still fading in, and ALSO writes a report of the computed style so the effect is
// verifiable as data and not just as a blurry pixel.
//
// Usage:
//   node tools/dump-usage-data.mjs
//   node tools/render-frame-preview.mjs
//   node tools/render-anim-shot.mjs [--from week] [--to month] [--mode bar]

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { readFrameHtml } from './frame-source.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const from = argValue('--from', 'day')
const to = argValue('--to', 'week')
const mode = argValue('--mode', 'line')
const out = join(tmpdir(), `luzzy-anim-${from}-to-${to}.html`)

// Read the frame from the BUNDLE, not a cached temp copy: the cache is only rewritten by
// render-frame-preview.mjs, so after a rebuild it silently serves the previous build's markup
// (§5.26's class of bug, and it made several screenshots stale evidence).
const frameHtml = readFrameHtml()
const usage = JSON.parse(readFileSync(join(tmpdir(), 'luzzy-usage-data.json'), 'utf8'))
const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8')

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

  // Report the animation state into the DOM, so it can be read back with --dump-dom.
  // A screenshot alone cannot prove an animation ran: by the time a capture fires the
  // transition may already be over, and a finished animation is pixel-identical to none.
  window.__writeAnimReport = function (phase) {
    var wrap = document.querySelector('[data-chart]');
    var box = document.createElement('div');
    box.id = 'anim-report';
    if (!wrap) {
      box.textContent = 'PHASE ' + phase + ': no chart wrap';
      document.body.appendChild(box);
      return;
    }
    var cs = getComputedStyle(wrap);
    var path = wrap.querySelector('svg.chart g > path');
    box.textContent = JSON.stringify({
      phase: phase,
      hasAnimateAttr: wrap.hasAttribute('data-animate'),
      wrapAnimation: cs.animationName,
      wrapDuration: cs.animationDuration,
      wrapOpacity: cs.opacity,
      pathAnimation: path ? getComputedStyle(path).animationName : null,
      window: (document.querySelector('[data-window][aria-pressed="true"]') || {}).dataset?.window || null,
      mode: (document.querySelector('[data-mode][aria-pressed="true"]') || {}).dataset?.mode || null,
    });
    document.body.appendChild(box);
  };

  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      var tab = document.querySelector('[data-tab="usage"]');
      if (tab) tab.click();
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        var start = document.querySelector('[data-window="${from}"]');
        if (start) {
          clearInterval(timer);
          // Land on the FROM window first. The first paint must NOT animate.
          start.click();
          setTimeout(function () {
            window.__writeAnimReport('after-first-paint');
            var target = document.querySelector('[data-window="${to}"]');
            if (target) target.click();
            var modeBtn = document.querySelector('[data-mode="${mode}"]');
            if (modeBtn) modeBtn.click();
            // Sample DURING the transition (260ms long).
            setTimeout(function () { window.__writeAnimReport('mid-transition'); }, 90);
            // And after it, to prove the animation is transient rather than permanent.
            setTimeout(function () { window.__writeAnimReport('after-transition'); }, 600);
          }, 150);
        } else if (tries > 400) { clearInterval(timer); }
      }, 25);
    }, 50);
  });
})();
</script>
`

const html = frameHtml
  .replace('<body>', '<body>' + shim)
  .replace('background: transparent;', 'background: #f8f8f8;')

writeFileSync(out, html, 'utf8')
console.log(`transition: ${from} -> ${to}, mode=${mode}`)
console.log(`wrote: ${out}`)
