// Render the usage page against an OUTDATED host-half payload, to check the page NAMES the
// version mismatch instead of silently showing "今天还没有用量记录".
//
// Why this exists: only the client half hot-reloads, so a rebuilt client running against a
// host half from before the change is the NORMAL state after every edit until DSH restarts.
// The old behaviour turned that into "you have no usage" — a false statement about the
// user's data, produced by a version mismatch. That is the failure this test pins down.
//
// The payload here is the OLD shape on purpose: totals + buckets + models, no `windows`.
//
// Usage:
//   node tools/dump-usage-data.mjs
//   node tools/render-frame-preview.mjs
//   node tools/render-stale-payload.mjs [--dark]

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dark = args.includes('--dark')
const out = join(tmpdir(), `luzzy-stale${dark ? '-dark' : ''}.html`)

const frameHtml = readFileSync(join(tmpdir(), 'luzzy-frame-preview.html'), 'utf8')
const current = JSON.parse(readFileSync(join(tmpdir(), 'luzzy-usage-data.json'), 'utf8'))

// The old shape: strip everything this build added, keep what the old host half returned.
const stale = {
  unit: 'day',
  generatedAt: Date.now(),
  sessions: current.sessions,
  skipped: current.skipped,
  attempts: current.attempts,
  range: current.range,
  totals: current.totals,
  buckets: current.buckets,
  models: current.models,
  modelRoutingCounts: current.modelRoutingCounts,
}
if ('windows' in stale) throw new Error('stale payload must not carry windows')
if ('activity' in stale) throw new Error('stale payload must not carry activity')

const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8')

const shim = `
<script>
(function () {
  var USAGE = ${JSON.stringify(stale)};
  window.fetch = function (url) {
    var u = String(url);
    if (u.indexOf('/__luzzy/usage') === 0) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(USAGE); }, text: function () { return Promise.resolve(''); } });
    }
    if (u.indexOf('/__luzzy/readme') === 0) {
      return Promise.resolve({ ok: true, text: function () { return Promise.resolve(${JSON.stringify(readme)}); }, json: function () { return Promise.resolve({}); } });
    }
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve(''); }, json: function () { return Promise.resolve({}); } });
  };
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      var tab = document.querySelector('[data-tab="usage"]');
      if (tab) tab.click();
    }, 50);
  });
})();
</script>
`

const html = frameHtml
  .replace('<body>', '<body>' + shim)
  .replace(/<html data-theme="[^"]*">/, `<html data-theme="${dark ? 'dark' : 'light'}">`)
  .replace('background: transparent;', `background: ${dark ? '#000' : '#f8f8f8'};`)

writeFileSync(out, html, 'utf8')
console.log(`wrote: ${out} (${(html.length / 1024).toFixed(0)} KB)`)
console.log(`payload keys: ${Object.keys(stale).join(', ')}`)
console.log(`attempts: ${stale.attempts} (present, so the page must NOT claim "no usage")`)
