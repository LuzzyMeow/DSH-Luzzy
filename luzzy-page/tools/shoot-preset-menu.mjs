/**
 * Screenshot the mode menu while it is OPEN, in both themes.
 *
 * The menu is the one part of this feature that is never on screen in the other shots, so
 * without this it would be the only piece shipped on code inspection alone. It is also the
 * element most likely to be clipped: it opens upward and is anchored to the bottom edge of a
 * bordered box inside a scrolling column.
 *
 * Usage: node tools/shoot-preset-menu.mjs [--out <dir>]
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const OUT = outIndex >= 0 ? args[outIndex + 1] : tmpdir()
mkdirSync(OUT, { recursive: true })

const bundle = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

function braceSlice(text, startIndex) {
  let depth = 0
  for (let i = text.indexOf('{', startIndex); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(startIndex, i + 1)
    }
  }
  return ''
}
function templateAfter(marker) {
  const start = bundle.indexOf(marker)
  const open = bundle.indexOf('`', start)
  const close = bundle.indexOf('`', open + 1)
  return bundle.slice(open + 1, close)
}

const fontCss = templateAfter('const FONT_FACE_CSS')
const fnAt = bundle.indexOf('function buildFrameDocument(')
const buildFrameDocument = new Function(`${braceSlice(bundle, fnAt)}; return buildFrameDocument`)()

// The shim must go INSIDE the frame document: an iframe is a separate document with its own
// window, so installing this on the parent would never intercept the frame's fetch calls.
const SHIM = `<script>
window.fetch = function (url) {
  var u = String(url);
  var body = {};
  if (u.indexOf('/__luzzy/preset') === 0) {
    body = {
      revision: 1, settings: { activeAgentId: 'luzzy' },
      groups: [{ id: 'g1', name: '写作', order: 0 }],
      agents: [{ id: 'luzzy', name: '鹿溪', description: '', groupId: 'g1', order: 0 }],
      promptSource: 'agent', warnings: [],
      session: { known: true, preset: 'luzzy-mode', canSwitchToLuzzy: true },
      capabilities: { newSession: true, sessionPresetSwitch: true }
    };
  } else if (u.indexOf('/__luzzy/usage') === 0) {
    body = { generatedAt: Date.now(), total: {}, windows: {} };
  } else if (u.indexOf('/__luzzy/readme') === 0) {
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('# 说明'); } });
  }
  return Promise.resolve({
    ok: true,
    json: function () { return Promise.resolve(body); },
    text: function () { return Promise.resolve(''); }
  });
};
window.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d && d.type === 'want-session' && e.source) {
    e.source.postMessage({ source: 'luzzy-page-host', type: 'session', sessionId: 's' }, '*');
  }
});
</` + `script>`

const SAMPLE = [
  '## 角色设定',
  '',
  '你是 **鹿溪**，一只 *猫耳少年*。',
  '',
  '- [x] 不确定就说不确定',
].join('\n')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const inFrame = `(fn) => {
  const f = document.getElementById('frame');
  return fn(f.contentDocument, f.contentWindow);
}`

const launcher = await launchEdge({ headless: true, windowSize: { width: 1240, height: 1250 } })
const session = await attach({ port: launcher.port })
const failures = []

try {
  for (const theme of ['light', 'dark']) {
    let doc = buildFrameDocument(fontCss, theme)
    const marker = '<meta charset="utf-8">'
    doc = doc.replace(marker, marker + SHIM)

    const page = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>html,body{margin:0;background:${theme === 'dark' ? '#000' : '#f8f8f8'}}
iframe{width:100%;height:1250px;border:0;display:block}</style>
</head><body>
<iframe id="frame" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
document.getElementById('frame').srcdoc = ${JSON.stringify(doc).replace(/<\//g, '<\\/')};
</` + `script></body></html>`

    const pagePath = join(tmpdir(), `luzzy-menu-${theme}-${process.pid}.html`)
    writeFileSync(pagePath, page, 'utf8')
    const page_ = await session.openTarget(`file:///${pagePath.replace(/\\/g, '/')}`)
    await page_.waitFor('#frame', { timeoutMs: 15_000 })
    await sleep(1500)

    await page_.evaluate(`(${inFrame})((d) => { const t = d.querySelector('[data-tab="preset"]'); if (t) t.click(); return true })`)
    const ready = await (async () => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (await page_.evaluate(`(${inFrame})((d) => d.getElementById('presetPrompt') !== null)`)) return true
        await sleep(200)
      }
      return false
    })()
    if (!ready) { failures.push(`${theme}: editor never rendered`); continue }

    await page_.evaluate(`(${inFrame})((d) => {
      const t = d.getElementById('presetPrompt');
      t.value = ${JSON.stringify(SAMPLE)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
      d.getElementById('presetModeBtn').click();
      return true;
    })`)
    await sleep(400)

    const state = await page_.evaluate(`(${inFrame})((d) => {
      const menu = d.getElementById('presetModeMenu');
      const r = menu.getBoundingClientRect();
      return {
        open: menu.hidden === false,
        items: menu.querySelectorAll('.mdMenuItem').length,
        checked: menu.querySelectorAll('.mdMenuItem[aria-checked="true"]').length,
        // The menu must be inside the viewport: it opens upward from a box near the bottom of
        // a long page, which is exactly where a mispositioned menu gets clipped.
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        inViewport: r.top >= 0 && r.bottom <= d.documentElement.clientHeight,
      };
    })`)
    if (state.open !== true) failures.push(`${theme}: the menu did not open — ${JSON.stringify(state)}`)
    if (state.items !== 3) failures.push(`${theme}: expected 3 modes, saw ${state.items}`)
    if (state.checked !== 1) failures.push(`${theme}: expected exactly one checked mode, saw ${state.checked}`)
    if (state.inViewport !== true) failures.push(`${theme}: the menu is outside the viewport — ${JSON.stringify(state)}`)

    const shotPath = join(OUT, `luzzy-preset-menu-${theme}.png`)
    writeFileSync(shotPath, await page_.screenshot())
    console.log(`wrote ${shotPath}`)
    console.log(`      ${JSON.stringify(state)}`)
    rmSync(pagePath, { force: true })
  }
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}

console.log(`\n${failures.length} failure(s)`)
for (const f of failures) console.log(`  FAIL ${f}`)
if (failures.length > 0) process.exit(1)
console.log('now READ the PNGs back')
