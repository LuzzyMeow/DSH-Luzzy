/**
 * Screenshot the preset editor's Markdown toolbar and its preview, in both themes.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RIG
 *
 * The rig proves behaviour; it cannot prove the result LOOKS right. The design rule for this
 * workspace is that a visual change is not verified until the rendering has been looked at —
 * so this drives the real frame over CDP and writes real PNGs, which are then read back.
 *
 * The frame is embedded with `srcdoc`, which makes it a SEPARATE DOCUMENT. Everything inside
 * it is therefore reached through `document.getElementById('frame').contentDocument` from the
 * parent — there is no child-frame handle in the driver, and pretending otherwise would mean
 * testing the parent instead of the page under test.
 *
 * Usage:
 *   node tools/shoot-preset-markdown.mjs                 # light + dark, edit + preview
 *   node tools/shoot-preset-markdown.mjs --out <dir>
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { launchEdge, attach, shutdown } from './cdp-driver.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const OUT = outIndex >= 0 ? args[outIndex + 1] : join(PLUGIN_ROOT, 'docs', 'shots')
mkdirSync(OUT, { recursive: true })

const bundle = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8')

// Lift the real frame builder out of the shipped bundle, the same way render-frame-preview
// does — so this renders the artifact that actually ships, not a reimplementation.
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

// One prompt that exercises every toolbar command at once, so a single screenshot shows the
// whole feature instead of needing one shot per button.
const SAMPLE = [
  '## 角色设定',
  '',
  '你是 **鹿溪**，一只 *猫耳少年*。用 `短句` 说话，~~不要客服腔~~。',
  '',
  '- 先接情绪，再解决问题',
  '- 不说教，不空洞夸奖',
  '- [x] 不确定就说不确定',
  '- [ ] 卡住就先问',
  '',
  '1. 读需求',
  '2. 给方案',
  '3. 验证结果',
  '',
  '> 人设可以退到语气里，绝不退到质量里。',
  '',
  '参考 [设计规范](https://example.com/design) 里的排版章节。',
  '',
  '---',
  '',
  '| 场景 | 做法 |',
  '|---|---|',
  '| 闲聊 | 短句为主 |',
  '| 干活 | 结构化输出 |',
].join('\n')

// The frame fetches its routes on boot; without a stub it renders an error state.
//
// This MUST be injected INTO the frame document, not the parent page: an iframe is a separate
// document with its own `window`, so a shim installed on the parent never intercepts the
// frame's fetch calls. (Learned by doing it wrong first — the page then rendered
// "预设读取失败 — Failed to fetch" and the screenshot would have shown only that.)
const SHIM = `<script>
window.fetch = function (url) {
  var u = String(url);
  var body = {};
  if (u.indexOf('/__luzzy/preset') === 0) {
    body = {
      revision: 1,
      settings: { activeAgentId: 'luzzy' },
      groups: [{ id: 'g1', name: '写作', order: 0 }],
      agents: [{ id: 'luzzy', name: '鹿溪', description: '', groupId: 'g1', order: 0 }],
      promptSource: 'agent',
      warnings: [],
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
    e.source.postMessage({ source: 'luzzy-page-host', type: 'session', sessionId: 'session-shot' }, '*');
  }
});
</` + `script>`

/** Put the route stub inside the frame document, ahead of its own script. */
function withShim(doc) {
  const marker = '<meta charset="utf-8">'
  return doc.includes(marker) ? doc.replace(marker, marker + SHIM) : doc
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run an expression inside the FRAME document (the iframe is a separate document). */
const inFrame = `(fn) => {
  const f = document.getElementById('frame');
  return fn(f.contentDocument, f.contentWindow);
}`

const launcher = await launchEdge({ headless: true, windowSize: { width: 1240, height: 1250 } })
// launchEdge only starts the process; attach() opens the socket and owns openTarget.
const session = await attach({ port: launcher.port })
const shots = []
const failures = []

try {
  // One shot per display mode, in both themes. The mode is the feature being verified, so it
  // is driven through the REAL menu rather than by setting the attribute from outside.
  for (const theme of ['light', 'dark']) {
    for (const mode of ['live', 'source', 'reading']) {
      const doc = withShim(buildFrameDocument(fontCss, theme))
      const page = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>html,body{margin:0;background:${theme === 'dark' ? '#000' : '#f8f8f8'}}
iframe{width:100%;height:1250px;border:0;display:block}</style>
</head><body>
<iframe id="frame" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
document.getElementById('frame').srcdoc = ${JSON.stringify(doc).replace(/<\//g, '<\\/')};
</` + `script></body></html>`

      const pagePath = join(tmpdir(), `luzzy-md-shot-${theme}-${mode}-${process.pid}.html`)
      writeFileSync(pagePath, page, 'utf8')

      const page_ = await session.openTarget(`file:///${pagePath.replace(/\\/g, '/')}`)
      // Wait for the frame's own tab bar to exist, which means the document parsed and ran.
      const booted = await page_.waitFor('#frame', { timeoutMs: 15_000 })
      if (!booted) {
        failures.push(`${theme}/${mode}: the iframe never appeared`)
        continue
      }
      await sleep(1500)

      // Switch to the preset tab, then WAIT for the editor to actually render before seeding.
      // Clicking the tab only starts a fetch; the textarea appears after the preset payload
      // resolves, so reading it immediately is a race that reports "no-textarea" on a page
      // that is working correctly.
      await page_.evaluate(`(${inFrame})((d) => {
        const tab = d.querySelector('[data-tab="preset"]');
        if (tab) tab.click();
        return true;
      })`)

      const editorReady = await (async () => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          const present = await page_.evaluate(`(${inFrame})((d) => d.getElementById('presetPrompt') !== null)`)
          if (present === true) return true
          await sleep(200)
        }
        return false
      })()
      if (!editorReady) {
        const why = await page_.evaluate(`(${inFrame})((d) => ((d.getElementById('content') || {}).textContent || '').slice(0, 200))`)
        failures.push(`${theme}/${mode}: the prompt editor never rendered — page said: ${why}`)
        continue
      }

      const seeded = await page_.evaluate(`(${inFrame})((d) => {
        const t = d.getElementById('presetPrompt');
        if (!t) return 'no-textarea';
        t.value = ${JSON.stringify(SAMPLE)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return 'seeded';
      })`)
      if (seeded !== 'seeded') {
        failures.push(`${theme}/${mode}: could not seed the prompt (${seeded})`)
        continue
      }

      // Switch mode through the REAL menu — open it, click the item. Driving the attribute
      // directly would prove nothing about the control that is actually being reviewed.
      const got = await page_.evaluate(`(${inFrame})((d) => {
        const btn = d.getElementById('presetModeBtn');
        if (!btn) return 'no-mode-button';
        btn.click();
        const item = d.querySelector('.mdMenuItem[data-mode=' + JSON.stringify('${mode}') + ']');
        if (!item) return 'no-menu-item';
        item.click();
        return d.getElementById('presetArea').dataset.mode;
      })`)
      if (got !== mode) {
        failures.push(`${theme}/${mode}: the mode menu did not switch the editor (${got})`)
        continue
      }
      await sleep(400)

      // Assert the expected surface is the visible one BEFORE shooting, so a screenshot can
      // never be the only evidence that the right thing was on screen.
      //
      // One surface per mode: live and reading show the same RENDERED document (editable vs
      // not); source shows the raw Markdown.
      const visible = await page_.evaluate(`(${inFrame})((d) => {
        const t = d.getElementById('presetPrompt');
        const v = d.getElementById('presetVisual');
        return {
          mode: d.getElementById('presetArea').dataset.mode,
          textarea: getComputedStyle(t).display !== 'none',
          visual: getComputedStyle(v).display !== 'none',
          editable: v.getAttribute('contenteditable'),
          // The rendered view must show FORMATTING, not markers.
          markers: v.textContent.indexOf('##') !== -1 || v.textContent.indexOf('**') !== -1,
          h2: v.querySelector('h2') !== null,
          strong: v.querySelector('strong') !== null,
          em: v.querySelector('em') !== null,
          li: v.querySelector('li') !== null,
          quote: v.querySelector('blockquote') !== null,
          table: v.querySelector('table') !== null,
          task: v.querySelector('.mdTask') !== null,
          del: v.querySelector('del') !== null,
          toolbarButtons: d.querySelectorAll('[data-md]').length,
          modeLabel: (d.getElementById('presetModeLabel') || {}).textContent,
        };
      })`)

      const wantTextarea = mode === 'source'
      const wantVisual = mode === 'live' || mode === 'reading'
      if (visible.textarea !== wantTextarea || visible.visual !== wantVisual) {
        failures.push(`${theme}/${mode}: wrong surface visible — ${JSON.stringify(visible)}`)
      }
      if (wantVisual) {
        // The whole point: markers gone, formatting real.
        if (visible.markers !== false) {
          failures.push(`${theme}/${mode}: the rendered view still shows markdown markers — ${JSON.stringify(visible)}`)
        }
        for (const [name, present] of [['h2', visible.h2], ['bold', visible.strong], ['italic', visible.em],
          ['list', visible.li], ['quote', visible.quote], ['table', visible.table],
          ['task list', visible.task], ['strike', visible.del]]) {
          if (present !== true) failures.push(`${theme}/${mode}: the rendered view is missing ${name}`)
        }
        const wantEditable = mode === 'live' ? 'true' : 'false'
        if (visible.editable !== wantEditable) {
          failures.push(`${theme}/${mode}: contenteditable is ${visible.editable}, want ${wantEditable}`)
        }
      }
      if (visible.toolbarButtons < 16) {
        failures.push(`${theme}/${mode}: the toolbar is missing buttons — ${JSON.stringify(visible)}`)
      }

      const name = `luzzy-preset-markdown-${theme}-${mode}.png`
      const shotPath = join(OUT, name)
      writeFileSync(shotPath, await page_.screenshot())
      shots.push({ path: shotPath, visible })
      console.log(`wrote ${shotPath}`)
      console.log(`      ${JSON.stringify(visible)}`)

      rmSync(pagePath, { force: true })
    }
  }
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}

console.log(`\n${shots.length} screenshot(s), ${failures.length} failure(s)`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('now READ every PNG back — a screenshot nobody looked at is not verification')
