#!/usr/bin/env python3
"""Render an offline harness for the inlined fonts, so the typeface can be checked without DSH.

Reads the *generated* lib/client.js — the real @font-face CSS with the real base64
payloads — and writes a standalone HTML file containing two blocks of identical text:
one in the system font (control) and one in the page's actual classes and font stack.
Screenshot both and the difference is the proof.

Usage:
    python tools/render-font-proof.py            # writes into the system temp dir
    python tools/render-font-proof.py --out proof.html
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
CLIENT = PLUGIN_ROOT / "lib" / "client.js"

# The host supplies these; the harness feeds plausible values so the page CSS parses
# the same way it will inside DSH.
HOST_TOKENS = """
  --dsw-font-family: system-ui, sans-serif;
  --dsw-alias-label-primary: #080808;
  --dsw-alias-label-secondary: #666666;
  --dsw-alias-label-tertiary: #999999;
  --dsw-alias-label-caption: #999999;
  --dsw-alias-border-l2: #eeeeee;
  --dsw-alias-bg-base: #ffffff;
  --dsh-content-font-size: 14px;
  --dsh-content-font-size-secondary: 13px;
  --dsh-chat-content-width: 748px;
  --dsh-composer-side-clearance: 0px;
"""

SAMPLES = [
    ("常规 400", 400, "阿里巴巴普惠体 · 鹿溪在这里"),
    ("粗体 700", 700, "阿里巴巴普惠体 · 鹿溪在这里"),
    ("常规 400", 400, "Alibaba Sans · The quick brown fox"),
    ("粗体 700", 700, "Alibaba Sans · The quick brown fox"),
    ("标点", 400, "，。、！？：；「」（）——"),
    ("数字", 400, "0123456789 · 1,234.56 · 2026-09-19"),
]


def extract(text: str) -> tuple[list[str], str]:
    faces = re.findall(r"@font-face \{.*?\n\}", text, re.DOTALL)
    match = re.search(r"const PAGE_CSS = `\n(.*?)\n`", text, re.DOTALL)
    return faces, (match.group(1) if match else "")


def build_html(faces: list[str], page_css: str) -> str:
    control_rows = "\n".join(
        f'  <p style="font-weight:{w}">{text}</p>' for _, w, text in SAMPLES
    )
    page_rows = "\n".join(
        f'      <div class="luzzy-page__specimenRow">'
        f'<dt class="luzzy-page__specimenLabel">{label}</dt>'
        f'<dd class="luzzy-page__specimenText" data-weight="{w}">{text}</dd></div>'
        for label, w, text in SAMPLES
    )

    return f"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>LuzzyPage font proof</title>
<style>
{chr(10).join(faces)}

:root {{{HOST_TOKENS}}}

body {{ margin: 0; background: #f8f8f8; }}

.control {{
  padding: 24px;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5714;
  border-bottom: 2px dashed #ccc;
}}
.control h2 {{ font-size: 14px; margin: 0 0 10px; color: #666; }}

#font-report {{
  margin: 0;
  padding: 16px 24px;
  background: #111;
  color: #4ade80;
  font: 20px/1.5 ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
}}

{page_css}
</style></head>
<body>
<pre id="font-report">measuring…</pre>

<div class="control">
  <h2>对照组 · 系统默认字体（不是普惠体）</h2>
{control_rows}
</div>

<div class="luzzy-page">
  <div class="luzzy-page__column">
    <header class="luzzy-page__header">
      <h1 class="luzzy-page__title">LuzzyPage</h1>
      <p class="luzzy-page__lede">与「对话」「轨迹」并列的第三个视图。</p>
    </header>
    <section class="luzzy-page__card">
      <h2 class="luzzy-page__sectionTitle">字体</h2>
      <p class="luzzy-page__note">中文使用阿里巴巴普惠体，西文使用 Alibaba Sans。四款字重已内联，不请求外部资源。</p>
      <dl class="luzzy-page__specimen">
{page_rows}
      </dl>
    </section>
  </div>
</div>

<script>
(async () => {{
  const lines = [];

  // 1. Wait for every inlined face to finish loading.
  try {{
    await document.fonts.ready;
  }} catch (e) {{
    lines.push('document.fonts.ready threw: ' + e);
  }}

  // 2. What actually got registered, and is it usable?
  const registered = [...document.fonts].map(
    (f) => `${{f.family}} ${{f.weight}} ${{f.status}}`
  );
  lines.push('registered faces:');
  registered.forEach((r) => lines.push('  ' + r));

  for (const [family, weight] of [
    ['Luzzy PuHuiTi', '400'],
    ['Luzzy PuHuiTi', '700'],
    ['Luzzy Sans', '400'],
    ['Luzzy Sans', '700'],
  ]) {{
    const ok = document.fonts.check(`${{weight}} 16px "${{family}}"`);
    lines.push(`check ${{family}} ${{weight}}: ${{ok ? 'USABLE' : 'NOT USABLE'}}`);
  }}

  // 3. Objective measurement: canvas width of the same glyphs per family.
  //    If the CJK face did not take effect these widths would equal the fallback's.
  const measure = (family, weight, text) => {{
    const c = document.createElement('canvas').getContext('2d');
    c.font = `${{weight}} 100px ${{family}}`;
    return Math.round(c.measureText(text) * 1 === undefined ? 0 : c.measureText(text).width);
  }};

  const CJK = '阿里巴巴普惠体鹿溪';
  const LATIN = 'AlibabaSans';
  const PUNCT = '，。、！？';

  lines.push('');
  lines.push('canvas widths at 100px (px):');
  for (const w of ['400', '700']) {{
    const cjkPu = measure('"Luzzy PuHuiTi"', w, CJK);
    const cjkSys = measure('system-ui, sans-serif', w, CJK);
    const latSans = measure('"Luzzy Sans"', w, LATIN);
    const latSys = measure('system-ui, sans-serif', w, LATIN);
    const pctPu = measure('"Luzzy PuHuiTi"', w, PUNCT);
    const pctSys = measure('system-ui, sans-serif', w, PUNCT);
    lines.push(`  w${{w}} CJK   PuHuiTi=${{cjkPu}}  system=${{cjkSys}}  ${{cjkPu !== cjkSys ? 'DIFFERENT ✓' : 'IDENTICAL ✗'}}`);
    lines.push(`  w${{w}} Latin Sans=${{latSans}}  system=${{latSys}}  ${{latSans !== latSys ? 'DIFFERENT ✓' : 'IDENTICAL ✗'}}`);
    lines.push(`  w${{w}} Punct PuHuiTi=${{pctPu}}  system=${{pctSys}}  ${{pctPu !== pctSys ? 'DIFFERENT ✓' : 'IDENTICAL ✗'}}`);
  }}

  // 4. Computed style of the rendered element, to confirm the stack resolved.
  const el = document.querySelector('.luzzy-page__specimenText');
  if (el) {{
    const cs = getComputedStyle(el);
    lines.push('');
    lines.push('rendered element computed font-family:');
    lines.push('  ' + cs.fontFamily);
    lines.push('  font-size: ' + cs.fontSize + ', weight: ' + cs.fontWeight);
  }}

  // 5. Did the CJK subset cover our glyphs? Measure a character we did NOT include.
  const missing = measure('"Luzzy PuHuiTi"', '400', '鑫');
  lines.push('');
  lines.push(`out-of-subset glyph 鑫 (expected to fall back): ${{missing}}px`);

  document.getElementById('font-report').textContent = lines.join('\\n');
  document.title = 'DONE';
}})();
</script>
</body></html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    if not CLIENT.is_file():
        sys.exit(f"error: {CLIENT} not found — run tools/build-font-css.py first")

    faces, page_css = extract(CLIENT.read_text(encoding="utf-8"))
    if len(faces) != 4:
        sys.exit(f"error: expected 4 @font-face blocks in {CLIENT.name}, found {len(faces)}")
    if not page_css:
        sys.exit("error: could not extract PAGE_CSS from the bundle")

    out = args.out or Path(tempfile.gettempdir()) / "luzzy-font-proof.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_html(faces, page_css), encoding="utf-8")

    print(f"faces:    {len(faces)}")
    print(f"page css: {len(page_css)} chars")
    print(f"wrote:    {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
