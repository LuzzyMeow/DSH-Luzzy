// Verify the chart's change animation ACTUALLY runs in a browser, and that it is transient.
//
// Why a dedicated harness: an animation is invisible to a static screenshot. By the time a
// capture fires the transition is usually over, and a finished animation is pixel-identical
// to no animation at all — so "I saw it move" is not evidence.
//
// HOW THE RESULT IS READ BACK
//
// `--dump-dom` returns nothing in this environment (the same stdio boundary that breaks
// other captured output), so the page paints its own report LARGE on top of everything and
// the harness screenshots that. The values are then read from the image — which is a
// deliberate choice, not a workaround: it is the same evidence a human would use.
//
// Expected:
//   after-first-paint : NO animation   (the first render must not animate)
//   mid-transition    : chartIn running, on both the wrap and the plot paths
//   after-transition  : NO animation   (it is an entrance, not a permanent state)
//
// Usage: node tools/test-animation.mjs [as-is|reduce|motion]
//
// THREE ARMS, because the motion preference cannot simply be "set" here:
//
//   as-is   No motion flag. Headless Edge reports whatever it reports — record it, and judge
//           the result against that reported value rather than against a fixed expectation.
//   reduce  `--force-prefers-reduced-motion` (the switch takes NO value — passing one is
//           ignored and the switch still forces reduce, which is how a run labelled
//           "no-preference" once silently repeated the reduce arm and produced an identical
//           screenshot). Proves the media query drops the animation.
//   motion  The `@media (prefers-reduced-motion: reduce)` blocks are stripped from a copy of
//           the frame, so the animation rule itself is exercised. This is the only arm that
//           can prove the animation WORKS, because headless offers no way to request
//           no-preference. Exactly one variable is removed, and the removed blocks are a
//           separate feature (the accessibility override), not the animation under test.
//
// A run is only evidence if its reported preference matches the arm's intent. Compare the
// screenshots' hashes across arms first: identical hashes mean the variable never varied.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const ARM = ['reduce', 'motion'].includes(process.argv[2]) ? process.argv[2] : 'as-is'

/** Remove every `@media (prefers-reduced-motion: reduce) { ... }` block, balancing braces. */
function stripReducedMotionBlocks(css) {
  const MARKER = '@media (prefers-reduced-motion: reduce)'
  let out = css
  for (;;) {
    const at = out.indexOf(MARKER)
    if (at === -1) return out
    const open = out.indexOf('{', at)
    if (open === -1) return out
    let depth = 0
    let end = open
    for (; end < out.length; end += 1) {
      if (out[end] === '{') depth += 1
      else if (out[end] === '}') { depth -= 1; if (depth === 0) break }
    }
    out = out.slice(0, at) + out.slice(end + 1)
  }
}

function armPage(html) {
  return ARM === 'motion' ? stripReducedMotionBlocks(html) : html
}

const frameHtml = readFileSync(join(tmpdir(), 'luzzy-frame-preview.html'), 'utf8')
const usage = JSON.parse(readFileSync(join(tmpdir(), 'luzzy-usage-data.json'), 'utf8'))
const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8')

const shim = `
<script>
(function () {
  var USAGE = ${JSON.stringify(usage)};
  var README = ${JSON.stringify(readme)};
  var samples = [];
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

  // The reduced-motion preference is the single most likely reason a correct animation reads
  // as "none": headless browsers are free to report reduce, and the CSS honours it. Record it
  // next to every sample so the two can never be confused again.
  var reduces = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function probe(phase) {
    var wrap = document.querySelector('[data-chart]');
    if (!wrap) { samples.push(phase + ': ERROR no wrap'); return; }
    var cs = getComputedStyle(wrap);
    var path = wrap.querySelector('svg.chart g > path');
    samples.push(
      phase + ' | attr=' + wrap.hasAttribute('data-animate') +
      ' | wrap=' + cs.animationName +
      ' | path=' + (path ? getComputedStyle(path).animationName : 'n/a') +
      ' | opacity=' + cs.opacity +
      ' | anims=' + wrap.getAnimations().length
    );
  }

  function paint() {
    var box = document.createElement('pre');
    box.id = 'anim-report';
    box.textContent = 'ANIMATION REPORT\\n' +
      'prefers-reduced-motion:reduce = ' + reduces + '\\n' + samples.join('\\n');
    document.body.appendChild(box);
  }

  function refresh() {
    var box = document.getElementById('anim-report');
    if (box) box.textContent = 'ANIMATION REPORT\\n' +
      'prefers-reduced-motion:reduce = ' + reduces + '\\n' + samples.join('\\n');
  }

  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      var tab = document.querySelector('[data-tab="usage"]');
      if (tab) tab.click();
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        var start = document.querySelector('[data-window="day"]');
        if (start) {
          clearInterval(timer);
          start.click();
          setTimeout(function () {
            probe('after-first-paint');
            var target = document.querySelector('[data-window="week"]');
            if (target) target.click();
            // Sample DURING the 260ms transition.
            setTimeout(function () { probe('mid-transition'); paint(); }, 80);
            // And after it, to prove the animation is an entrance, not a permanent state.
            setTimeout(function () {
              samples.push('---');
              probe('after-transition');
              refresh();
            }, 800);
          }, 200);
        } else if (tries > 400) { clearInterval(timer); }
      }, 25);
    }, 50);
  });
})();
</script>

<style>
#anim-report {
  position: fixed; inset: 0; z-index: 2147483647; margin: 0;
  padding: 28px 32px; background: #ffffff; color: #111111;
  font: 700 22px/1.7 ui-monospace, Consolas, monospace; white-space: pre-wrap;
  border: 6px solid #ec5e41;
}
</style>
`

const suffix = ARM
const page = join(tmpdir(), `luzzy-anim-check-${suffix}.html`)
const shot = join(tmpdir(), `luzzy-anim-report-${suffix}.png`)
writeFileSync(
  page,
  armPage(frameHtml)
    .replace('<body>', '<body>' + shim)
    .replace('background: transparent;', 'background: #f8f8f8;'),
  'utf8',
)

const profile = join(tmpdir(), `luzzy-anim-profile-${suffix}`)
try {
  execFileSync(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      // The switch takes no value; its mere presence forces reduce. See the arm notes above.
      ...(ARM === 'reduce' ? ['--force-prefers-reduced-motion'] : []),
      // Long enough for the after-transition sample (800ms) to be recorded and painted.
      '--virtual-time-budget=2000',
      '--window-size=1100,420',
      `--screenshot=${shot}`,
      `file:///${page.replace(/\\/g, '/')}`,
    ],
    { timeout: 90_000, stdio: ['ignore', 'ignore', 'ignore'] },
  )
} catch (error) {
  console.log('  skip could not run Edge:', error.message)
  console.log()
  console.log('SKIP — animation check needs a browser')
  process.exit(0)
}

console.log(`arm: ${ARM}`)
console.log(`report screenshot: ${shot}`)
console.log()
console.log('Read that image. The report states the preference it observed — judge the samples')
console.log('against THAT value, not against a fixed expectation:')
console.log()
console.log('  preference reduce  -> animation MUST be none in every phase (the media query wins)')
console.log('  preference normal  -> mid-transition MUST be chartIn with anims=1')
console.log('                        after-transition MUST be attr=false (the entrance is transient)')
console.log()
console.log(`so this arm should show: ${ARM === 'reduce' ? 'every phase none' : ARM === 'motion' ? 'the chartIn row mid-transition' : 'whichever matches the preference it reports'}`)



