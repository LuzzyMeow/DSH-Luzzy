/**
 * Visual audit shooter: every sub-page (说明 / 用量 / 预设), both themes.
 *
 * WHY A SEPARATE SCRIPT FROM shoot-preset-markdown
 *
 * That one exists to verify the EDITOR's modes. This one exists to audit the WHOLE surface for
 * the design review — it needs all three tabs, and it needs real data in the usage page, because
 * an empty chart tells you nothing about the chart's design. The usage payload here is shaped
 * like the real route's (same field names) so the page renders as a user would see it.
 *
 * Everything is reached through the frame's own document: the frame is a separate document
 * (srcdoc), so a shim installed on the parent never intercepts its fetch calls.
 *
 * Usage: node tools/shoot-visual-audit.mjs [--out <dir>]
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

function braceSlice(text, startIndex) {
  let depth = 0
  for (let i = text.indexOf('{', startIndex); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(startIndex, i + 1) }
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

const SAMPLE_PROMPT = [
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

// A usage payload shaped like the REAL route's (field names read off the renderer: `attempts`,
// `totals.totalTokens` / `cacheReadTokens`, and `windows.<unit>.{slots,series}`). My first
// version invented `points` and the page correctly reported a crash — the stub was wrong, not
// the page, and an audit must render the real layout to audit anything at all.
function usageWindow(unit, slotCount, label) {
  const slots = []
  const now = Date.now()
  const stepMs = unit === 'day' ? 3600 * 1000 : unit === 'week' ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000
  for (let i = slotCount - 1; i >= 0; i -= 1) slots.push({ at: now - i * stepMs, label: '' })
  const series = [
    {
      key: 'deepseek-v4-pro',
      values: slots.map((_, i) => Math.round(300_000 + 620_000 * Math.abs(Math.sin(i / 3)))),
    },
    {
      key: 'deepseek-v4-flash',
      values: slots.map((_, i) => Math.round(120_000 + 260_000 * Math.abs(Math.cos(i / 4)))),
    },
  ]
  return { unit: unit, label: label, slots: slots, series: series }
}

const usagePayload = {
  generatedAt: Date.now(),
  attempts: 21,
  skipped: 0,
  totals: {
    totalTokens: 10_512_400,
    inputTokens: 8_400_000,
    outputTokens: 2_112_400,
    cacheReadTokens: 5_240_000,
    calls: 412,
  },
  models: [
    { key: 'deepseek-v4-pro', totalTokens: 6_712_400, calls: 250 },
    { key: 'deepseek-v4-flash', totalTokens: 3_800_000, calls: 162 },
  ],
  windows: {
    day: usageWindow('day', 24, '今天的 24 小时'),
    week: usageWindow('week', 7, '本周（周一起）'),
    month: usageWindow('month', 4, '本月各周'),
  },
}

const SHIM = `<script>
window.fetch = function (url) {
  var u = String(url);
  var body = {};
  if (u.indexOf('/__luzzy/preset') === 0) {
    body = {
      revision: 1,
      settings: { activeAgentId: 'luzzy' },
      groups: [
        { id: 'g1', name: '写作', order: 0 },
        { id: 'g2', name: '工程', order: 1 },
        { id: 'g3', name: '研究', order: 2 }
      ],
      agents: [
        { id: 'luzzy', name: '鹿溪', description: '', groupId: 'g1', order: 0 },
        { id: 'editor', name: '文字编辑', description: '', groupId: 'g1', order: 1 },
        { id: 'engineer', name: '工程搭档', description: '', groupId: 'g2', order: 2 },
        { id: 'researcher', name: '研究员', description: '', groupId: 'g3', order: 3 },
        { id: 'scratch', name: '临时试验', description: '', groupId: null, order: 4 }
      ],
      promptSource: 'agent',
      warnings: [],
      session: { known: true, preset: 'luzzy-mode', canSwitchToLuzzy: true },
      capabilities: { newSession: true, sessionPresetSwitch: true }
    };
  } else if (u.indexOf('/__luzzy/usage') === 0) {
    body = ${JSON.stringify(usagePayload)};
  } else if (u.indexOf('/__luzzy/readme') === 0) {
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve(${JSON.stringify('# 鹿溪 · LuzzyPage\n\n这是配套说明文档的渲染示例。\n\n## 三个子页\n\n- **说明** — 项目的说明与使用方法\n- **用量** — token 用量的可视统计\n- **预设** — 智能体与 system prompt 编辑器\n\n> 提示词文本支持 Markdown 渲染与实时编辑。')}); } });
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
    e.source.postMessage({ source: 'luzzy-page-host', type: 'session', sessionId: 'audit' }, '*');
  }
});
</` + `script>`

function withShim(doc) {
  const marker = '<meta charset="utf-8">'
  return doc.includes(marker) ? doc.replace(marker, marker + SHIM) : doc
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const inFrame = `(fn) => { const f = document.getElementById('frame'); return fn(f.contentDocument, f.contentWindow); }`

const launcher = await launchEdge({ headless: true, windowSize: { width: 1440, height: 1250 } })
const session = await attach({ port: launcher.port })
const shots = []
const failures = []

try {
  for (const theme of ['light', 'dark']) {
    for (const tab of ['readme', 'usage', 'preset']) {
      const doc = withShim(buildFrameDocument(fontCss, theme))
      const page = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>html,body{margin:0;background:${theme === 'dark' ? '#000' : '#f8f8f8'}}
iframe{width:100%;height:1250px;border:0;display:block}</style>
</head><body>
<iframe id="frame" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
document.getElementById('frame').srcdoc = ${JSON.stringify(doc).replace(/<\//g, '<\\/')};
</` + `script></body></html>`

      const pagePath = join(tmpdir(), `luzzy-audit-${theme}-${tab}-${process.pid}.html`)
      writeFileSync(pagePath, page, 'utf8')

      const page_ = await session.openTarget(`file:///${pagePath.replace(/\\/g, '/')}`)
      if (!(await page_.waitFor('#frame', { timeoutMs: 15_000 }))) {
        failures.push(`${theme}/${tab}: iframe never appeared`)
        continue
      }
      await sleep(1400)

      // Switch to the tab with a REAL click on the real tab button.
      const point = await page_.evaluate(`(${inFrame})((d) => {
        const t = d.querySelector('[data-tab="${tab}"]');
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })`)
      if (point === null) { failures.push(`${theme}/${tab}: no tab button`); continue }
      await page_.clickAt(point.x, point.y)
      await sleep(2200)

      const shotName = `audit-${theme}-${tab}`
      const png = await page_.screenshot()
      const file = join(OUT, `${shotName}.png`)
      writeFileSync(file, png)
      shots.push({ file, bytes: png.length })
      console.log(`wrote ${file}`)
      rmSync(pagePath, { force: true })
    }
  }
} finally {
  await shutdown({ child: launcher.child, profile: launcher.profile, session })
}

console.log(`\n${shots.length} screenshot(s), ${failures.length} failure(s)`)
for (const f of failures) console.log(`  FAIL ${f}`)
