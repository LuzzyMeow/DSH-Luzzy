#!/usr/bin/env python3
"""Build lib/client.js for LuzzyPage: assemble the frame from src/, subset the fonts, inline them.

WHAT THIS DOES
--------------

`src/` is a multi-file tree (styles / components / services / app / pages). The frame document
must be SELF-CONTAINED — it is handed to an iframe as `srcDoc`, so it can make no external
requests, and that means the modules have to be concatenated into one `<script>` rather than
loaded with `import`. This script is that concatenation, plus the font inlining that was
already here.

The output is `src/client.js`'s placeholder expanded: the outer bundle (the DSH slot entry and
the `buildFrameDocument` function) stays hand-written, and everything between
`<style>` and `</script>` comes from files on disk, read in the order `app/manifest.json`
declares.

WHY THE ORDER IS DECLARED AND NOT GLOBBED
-----------------------------------------

Concatentation order decides whether a dependency exists when it is first read. A glob's
order comes from the filesystem, which is not a contract. `manifest.json` makes it explicit,
and this script fails if a dependency would be read before it is defined.

THE ESCAPING IS THE DANGEROUS PART
----------------------------------

The frame document is embedded inside a JS **template literal** in `src/client.js`. Two
sequences in the assembled HTML would terminate or corrupt that literal, and both have
already caused blank pages in this project:

  * a RAW BACKTICK anywhere in the frame (even inside a CSS or JS comment) ends the template
    early. Escaped here as a backslash-backtick.
  * a literal backslash-n written in a JS string inside the frame is consumed by the TEMPLATE
    first, leaving a real newline inside a single-quoted string. Escaped here so it survives.

`${` is escaped too, for the same reason as the backtick: the template would try to
interpolate it.

The build then verifies its own output: the assembled bundle must parse, and the frame's own
script must parse separately (it is a string, so the outer parse does not cover it).

Usage:
    python tools/build-font-css.py                     # build lib/client.js
    python tools/build-font-css.py --dry-run           # report sizes, write nothing
    python tools/build-font-css.py --frames-only       # skip fonts, rebuild the frame only
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC_DIR = PLUGIN_ROOT / "src"
DEFAULT_SRC = PLUGIN_ROOT / "src" / "client.js"
DEFAULT_OUT = PLUGIN_ROOT / "lib" / "client.js"

PLACEHOLDER = "/*__FONT_FACE_CSS__*/"
FRAME_TEMPLATE = PLUGIN_ROOT / "src" / "app" / "frame.html"
MANIFEST = PLUGIN_ROOT / "src" / "app" / "manifest.json"

# ------------------------------------------------------------------ why there is no CJK face
#
# This build used to subset a Chinese face (Alibaba PuHuiTi) down to the non-ASCII characters
# found under src/ plus README.md. That was structurally wrong, and the wrongness was invisible:
#
#   * The console renders text that ARRIVES AT RUNTIME — goal objectives, task titles, evidence
#     lines, prompts, session titles, and the user's own words. None of it is in src/.
#   * A glyph the subset lacks does not error. The browser falls back PER CHARACTER, mid
#     sentence, to a system font with different weight and metrics. Measured on this machine:
#     the live goal artifacts needed up to 81 characters the face did not have (9.5% of their
#     distinct glyphs).
#   * The only symptom is text that "looks slightly wrong", which is unfalsifiable by eye and
#     is exactly the kind of complaint this project keeps having to chase down.
#
# Subsetting a superset is not possible: you cannot know what the user will type. The two real
# options were a full CJK face (~5 MB woff2 → ~6.7 MB base64 inlined into every frame document)
# or the operating system's own CJK font.
#
# The reference design (dsh-thoughtdag) takes the second option, and its authored stack says so
# explicitly: `"Inter Variable", -apple-system, "PingFang SC", "Hiragino Sans GB", "Segoe UI"`.
# It ships Inter for Latin and lets the OS supply CJK. So this is both the faithful choice and
# the correct one, and it removes the fallback hole by construction rather than by enumeration.
#
# Latin is still inlined (Inter Variable, self-contained frame — no external request is allowed).
FAMILY_LATIN = "Inter Variable"
FAMILY_MONO = "JetBrains Mono Variable"

# The CJK half of the stack, in the reference's own order. `PingFang SC` first (macOS),
# `Microsoft YaHei` for Windows, then the generic families so a machine with neither still
# resolves to something CJK-capable rather than to a Latin face with no Han glyphs at all.
CJK_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif'

# Vendored under assets/fonts/ and committed, so the build does not depend on a network fetch
# or on another project's asset tree. Licenses sit beside them (Inter: SIL OFL 1.1).
VENDOR_FONT_DIR = PLUGIN_ROOT / "assets" / "fonts"

# (source filename, css family, weight, subset mode)
#
# Latin + mono only. `whole` = convert to WOFF2 without subsetting; the Latin range is small
# enough that subsetting buys little and risks the same missing-glyph class of bug for text
# the user types in English.
FACES = [
    ("inter-latin-wght-normal.woff2", FAMILY_LATIN, "100 900", "whole"),
    ("inter-latin-ext-wght-normal.woff2", FAMILY_LATIN, "100 900", "whole"),
    ("jetbrains-mono-latin-wght-normal.woff2", FAMILY_MONO, "100 800", "whole"),
]

SCAN_SUFFIXES = (".js", ".css", ".html", ".json")

# Kept for the glyph-coverage probe, which still reports what the frame's own faces cover.
EXTRA_SCAN_FILES = ("README.md",)


# ------------------------------------------------------------------ assembly


def read_manifest() -> dict:
    if not MANIFEST.is_file():
        sys.exit(f"error: manifest not found: {MANIFEST}")
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for key in ("styles", "modules"):
        if not isinstance(data.get(key), list):
            sys.exit(f"error: manifest is missing a `{key}` array")
    return data


def read_parts(src_dir: Path, names: list[str], what: str) -> list[tuple[str, str]]:
    """Read each declared file, failing loudly on a missing one.

    A silently skipped module would show up as `LZ.X is undefined` at run time — inside the
    iframe, where nothing reaches the host console. So a missing file is a build error.
    """
    out: list[tuple[str, str]] = []
    for name in names:
        path = src_dir / name
        if not path.is_file():
            sys.exit(f"error: {what} listed in the manifest does not exist: {name}")
        out.append((name, path.read_text(encoding="utf-8")))
    return out


def assemble_styles(parts: list[tuple[str, str]]) -> str:
    chunks = []
    for name, text in parts:
        if "*/" in text[:400] and "/*" in text[:400]:
            pass  # already carries its own header comment
        chunks.append(f"/* ==== {name} ==== */\n{text}" if not text.lstrip().startswith("/*") else text)
    return "\n".join(chunks)


def assemble_modules(parts: list[tuple[str, str]]) -> str:
    """Concatenate the frame's modules, each terminated so ASI cannot join them.

    THE SEMICOLON IS LOAD-BEARING, and this was found the hard way — by evaluating the shipped
    frame's module set, which threw:

        TypeError: (intermediate value)(intermediate value)(...) is not a function

    Every module is an IIFE that ENDS with `})(window.LZ = window.LZ || {})` and BEGINS with
    `(function (LZ) {`. With nothing between them, JavaScript's automatic semicolon insertion
    does not help: a statement starting with `(` continues the previous expression, so the
    concatenation parses as `(moduleA)(moduleB)` — calling module A's return value with module B
    as its argument. The first module runs, the second throws, and every module after it never
    runs at all.

    It is VALID SYNTAX, so neither `new Function` nor a parser reports it. The only symptom is
    a frame where `LZ.Card` is undefined — and an undefined namespace inside an iframe produces
    no error anywhere the host can see. Exactly the class of failure this build has gates for
    elsewhere, and exactly why the assembled document is evaluated rather than only parsed.

    Terminating each module (and each style block below) removes the hazard structurally.
    """
    chunks = []
    for name, text in parts:
        body = text.rstrip()
        # A trailing semicolon guards the NEXT module's leading `(`. Never doubled: a module
        # that already ends in `;` is left alone, so the emitted source stays unsurprising.
        if not body.endswith(';'):
            body += ';'
        chunks.append(f"/* ==== {name} ==== */\n{body}")
    return "\n".join(chunks)


def escape_for_template(text: str) -> str:
    """Make `text` safe to sit inside a JS template literal.

    NOT used by the current build — the frame is embedded as a JSON string literal instead,
    which is strictly safer. Kept because `verify_frame_script` and future tooling may need to
    reason about the same hazard, and because the history matters: getting this wrong produced
    a blank frame four separate times, and the reported line was never near the real mistake.

    Order matters and is not interchangeable:

      1. backslashes first — otherwise step 2's inserted backslash would itself be doubled.
      2. then backticks and `${`, each getting one backslash.
    """
    text = text.replace("\\", "\\\\")
    text = text.replace("`", "\\`")
    text = text.replace("${", "\\${")
    return text


def build_frame(template: str, styles: str, modules: str) -> str:
    """Substitute the three frame placeholders.

    `__THEME__` is replaced with `light` and the real theme is written onto the frame's root
    attribute at run time (the parent mirrors it). Baking the theme into the string would make
    it change on a theme toggle, and a changing `srcDoc` RELOADS the iframe — which aborted
    in-flight work and produced a page stuck at "正在统计用量…".

    `__FRAME_FONTS__` is deliberately LEFT IN PLACE: `buildFrameDocument()` in the bundle
    substitutes it per call. That function is called exactly once at module load to produce the
    `FRAME_DOCUMENT` constant, and the test suites call it again with their own CSS — keeping
    it a function is what keeps those suites working.

    NO ESCAPING IS APPLIED HERE. The assembled frame is embedded into the bundle as a JSON
    string literal (`json.dumps` at the write step), which escapes every backtick, backslash
    and `${` for us. That is strictly safer than the previous approach, where the frame sat
    inside a hand-written template literal and a stray backtick in a comment silently blanked
    the page four separate times.
    """
    for token in ("__FRAME_FONTS__", "__STYLES__", "__MODULES__", "__THEME__"):
        if token not in template:
            sys.exit(f"error: frame template is missing {token}")
    return (
        template.replace("__THEME__", "light")
        .replace("__STYLES__", styles)
        .replace("__MODULES__", modules)
    )


# ------------------------------------------------------------------ fonts


def collect_chars(src_dir: Path) -> str:
    """Every non-ASCII, non-space character in the page sources and rendered files.

    NO LONGER DRIVES SUBSETTING — nothing is subset any more (see the note at the top of this
    file). It is kept because the build prints it: the count is how you notice that a page's
    Chinese copy changed, and it is the denominator for the coverage probe.
    """
    found: set[str] = set()
    scanned = 0

    targets = [
        path
        for path in sorted(src_dir.rglob("*"))
        if path.is_file() and path.suffix in SCAN_SUFFIXES
    ]

    for extra in EXTRA_SCAN_FILES:
        candidate = PLUGIN_ROOT / extra
        if candidate.is_file():
            targets.append(candidate)

    for path in targets:
        scanned += 1
        for char in path.read_text(encoding="utf-8"):
            if ord(char) >= 0x80 and not char.isspace():
                found.add(char)

    if scanned == 0:
        sys.exit(f"error: nothing to scan under {src_dir}")

    chars = "".join(sorted(found))
    cjk = sum(1 for c in chars if 0x4E00 <= ord(c) <= 0x9FFF)
    print(f"scanned {scanned} file(s) -> {len(chars)} non-ASCII chars ({cjk} CJK)")
    return chars


def build_latin(source: Path, target: Path) -> int:
    """Normalise a face to WOFF2. Returns bytes written.

    The vendored Inter/JetBrains files are ALREADY woff2 (that is how Fontsource ships them),
    so the common path is a byte copy — the point of routing through fontTools is to fail
    loudly if a future source is a TTF, rather than shipping a mislabelled file that the
    browser refuses to parse (which shows up only as "the font silently did not load").
    """
    data = source.read_bytes()
    if data[:4] == b"wOF2":
        target.write_bytes(data)
        return len(data)

    try:
        from fontTools.ttLib import TTFont
    except ImportError:  # pragma: no cover
        sys.exit("error: fontTools not importable; install it with `pip install fonttools brotli`")

    font = TTFont(str(source), lazy=False)
    try:
        font.flavor = "woff2"
        font.save(str(target))
    finally:
        font.close()

    return target.stat().st_size


def font_face_css(font_dir: Path, charset: str, scratch: Path) -> tuple[str, list[tuple[str, int, int]]]:
    """Build every face, return (css, [(label, woff2_bytes, base64_bytes)]).

    `charset` is accepted and ignored: it used to drive the CJK subset. Nothing is subset any
    more — see the note at the top of this file for why subsetting was the wrong shape.
    """
    blocks: list[str] = []
    report: list[tuple[str, int, int]] = []

    for filename, family, weight, mode in FACES:
        source = font_dir / filename
        if not source.is_file():
            sys.exit(
                f"error: missing vendored font {source}\n"
                "       these are committed under assets/fonts/ — restore them rather than\n"
                "       pointing the build at another project's asset tree."
            )

        target = scratch / f"{source.stem}.woff2"
        raw_size = build_latin(source, target)

        payload = base64.b64encode(target.read_bytes()).decode("ascii")
        report.append((f"{family} {weight} ({mode})", raw_size, len(payload)))

        blocks.append(
            "@font-face {\n"
            f"  font-family: '{family}';\n"
            "  font-style: normal;\n"
            f"  font-weight: {weight};\n"
            "  font-display: swap;\n"
            f"  src: url(data:font/woff2;base64,{payload}) format('woff2');\n"
            "}"
        )

    return "\n".join(blocks), report


# ------------------------------------------------------------------ gates


def verify_bundle_parses(out: Path) -> None:
    """Refuse to ship a bundle whose frame template does not parse.

    The frame document is a JS template literal, so a RAW BACKTICK inside it (in a CSS or
    JS comment, say) ends the literal early and the rest of the page becomes syntax errors.
    That happened twice while editing, and the only symptom was a blank frame — no error
    anywhere near the actual mistake.

    `node --check` on the file is not enough on its own because the bundle is a script that
    uses `window`, so it is wrapped in a Function for the parse. Exits non-zero on failure,
    which makes the build itself the gate.
    """
    script = (
        "const fs=require('fs');"
        f"const s=fs.readFileSync({str(out)!r},'utf8');"
        "try{ new Function('window','document',s); }"
        "catch(e){ console.error(e.message); process.exit(1); }"
    )
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        # Plain concatenation, not .format(): the message itself contains {braces} and a
        # backtick escape, and mixing those with format placeholders crashed the reporter
        # instead of reporting.
        node_says = result.stderr.strip()
        sys.exit(
            "error: the built bundle does not parse — "
            + str(out) + " is broken.\n"
            "       Most likely a raw backtick inside the frame template literal\n"
            "       (escape it as \\`), or an unbalanced ${...}.\n"
            "       node says: " + node_says
        )
    print("bundle parses cleanly")


def verify_frame_script(frame_html: str) -> None:
    """Parse the frame's own script.

    THE OUTER PARSE DOES NOT COVER THIS. The frame is a string, so a syntax error inside it
    survives `verify_bundle_parses` and only shows up when the document runs — as a blank
    page, because the frame's own error handler cannot report a parse failure in the script
    that defines it. This is the gate that caught a `SyntaxError @1952:13` once already.
    """
    marker = "<script>\n'use strict'"
    start = frame_html.find(marker)
    if start < 0:
        sys.exit("error: the assembled frame has no use-strict script block")
    end = frame_html.find("</script>", start)
    if end < 0:
        sys.exit("error: the assembled frame's script block is unterminated")
    code = frame_html[start + len("<script>") : end]

    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
        handle.write(code)
        scratch = Path(handle.name)
    try:
        result = subprocess.run(
            ["node", "-e", f"new Function(require('fs').readFileSync({str(scratch)!r},'utf8'))"],
            capture_output=True,
            text=True,
        )
    finally:
        scratch.unlink(missing_ok=True)

    if result.returncode != 0:
        line_match = None
        import re

        line_match = re.search(r":(\d+):(\d+)?", result.stderr)
        context = ""
        if line_match is not None:
            lines = code.split("\n")
            number = int(line_match.group(1))
            for index in range(max(0, number - 3), min(len(lines), number + 2)):
                flag = ">>" if index + 1 == number else "  "
                context += f"\n{flag} {index + 1:5}: {lines[index]}"
        sys.exit(
            "error: the assembled frame script does not parse — the page would be blank.\n"
            "       node says: " + result.stderr.strip() + context
        )
    print(f"frame script parses cleanly ({len(code.splitlines())} lines)")


def verify_frame_modules_evaluate(frame_html: str) -> None:
    """Actually RUN the frame's script — pragma included — and check the namespaces exist.

    Parsing is not enough, and the gap between the two is not theoretical. Three separate
    defects got past a parse-only gate:

      * modules concatenated without terminators, so `(A)(B)` parsed and threw at run time,
        leaving every namespace after the first undefined;
      * `'use strict'` with no semicolon followed by a module's `(function (LZ) {` — an
        expression beginning with `(` CONTINUES the previous line, so this parses as calling a
        string and throws `TypeError: "use strict" is not a function`. It is VALID SYNTAX, so
        nothing to parse reports it. It took a real browser run to find.
      * and the version of this gate that tried to catch the second one SLICED THE PRAGMA OUT
        of the source it evaluated, so it could never have seen it. Carving around the suspect
        code is the same mistake as not testing it.

    So this runs the script EXACTLY as the document presents it, stopping before `LZ.App.start()`
    (which drives the whole app) by truncating at that call rather than by skipping any preamble.
    """
    marker = "LZ.App.start()"
    at = frame_html.find(marker)
    if at < 0:
        sys.exit("error: the assembled frame never calls LZ.App.start()")
    script_open = frame_html.find("<script>")
    if script_open < 0:
        sys.exit("error: the assembled frame has no <script> block")
    # Everything from the opening tag to the start() CALL — pragma, comments and all.
    body = frame_html[script_open + len("<script>") : at]

    harness = """
const noop = () => {};
const el = () => ({ innerHTML:'', textContent:'', hidden:true, dataset:{}, style:{},
  setAttribute:noop, getAttribute:()=>null, removeAttribute:noop, addEventListener:noop,
  removeEventListener:noop, appendChild:noop, remove:noop, querySelector:()=>null,
  querySelectorAll:()=>[], focus:noop,
  classList:{add:noop,remove:noop,toggle:noop,contains:()=>false} });
const document = { getElementById:()=>el(), querySelector:()=>null, querySelectorAll:()=>[],
  createElement:()=>el(), addEventListener:noop, removeEventListener:noop,
  documentElement:{getAttribute:()=>null,setAttribute:noop,classList:{contains:()=>false}},
  head:{appendChild:noop}, body:{focus:noop,appendChild:noop}, hidden:false };
const window = { addEventListener:noop, removeEventListener:noop,
  matchMedia:()=>({matches:false,addEventListener:noop,removeEventListener:noop}),
  location:{href:'about:srcdoc'} };
const fetch = () => Promise.reject(new Error('no network in the build gate'));
class AbortController { abort() {} }
"""
    # The pragma must be the FIRST thing the harness sees, exactly as the browser sees it —
    # that is precisely what the previous version got wrong by slicing it off.
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
        handle.write(f"{harness}\n{body}\nmodule.exports = Object.keys(window.LZ);\n")
        scratch = Path(handle.name)

    try:
        result = subprocess.run(
            ["node", "-e", f"process.stdout.write(JSON.stringify(require({str(scratch)!r})))"],
            capture_output=True,
            text=True,
        )
    finally:
        scratch.unlink(missing_ok=True)

    if result.returncode != 0:
        # Report the ERROR, not the first stderr line: node prints the offending file path
        # first, so taking line 0 yields a temp path and nothing diagnostic.
        lines = [line for line in result.stderr.strip().splitlines() if line.strip() != '']
        detail = "\n".join(lines[:14]) if lines else "(no stderr)"
        sys.exit(
            "error: the assembled frame's script does not EVALUATE — the page would be blank.\n"
            "       (parsing clean is not enough; this actually runs it)\n"
            "       node says:\n" + "\n".join("         " + line for line in detail.splitlines())
        )

    try:
        namespaces = json.loads(result.stdout)
    except json.JSONDecodeError:
        sys.exit(f"error: could not read the namespace list back: {result.stdout!r}")

    if len(namespaces) < 15:
        sys.exit(f"error: only {len(namespaces)} namespaces were defined — a module did not run: {namespaces}")
    print(f"frame script RUNS ({len(namespaces)} namespaces: {', '.join(sorted(namespaces))})")


def verify_module_order(manifest: dict, modules: list[tuple[str, str]]) -> None:
    """Every `LZ.X` read AT MODULE-EVALUATION TIME must come after the module that defines it.

    Order is what a hand-written manifest can get wrong silently: a top-level `const x =
    LZ.Card.card` that runs before Card.js yields `undefined` and throws inside the iframe,
    where nothing surfaces in the host console.

    DEPTH IS WHAT MAKES THIS USEFUL, not a plain text scan. A read inside a function body
    (`render: function () { return LZ.GoalPage.render(state) }`) is evaluated when that
    function is CALLED, long after every module has loaded — so it is not a dependency at all.
    Flagging those would reject a correct manifest, and a checker that cries wolf gets
    disabled. The module's own IIFE is depth 1, so only depth-1 reads are checked.
    """
    defined: dict[str, str] = {}
    for name, text in modules:
        for line in text.split("\n"):
            marker = line.strip()
            if marker.startswith("LZ.") and " = {" in marker:
                defined[marker.split(" = {")[0].strip()[3:]] = name

    def top_level_reads(text: str) -> set[str]:
        """Namespace keys read while the module body evaluates (IIFE depth 1)."""
        found: set[str] = set()
        depth = 0
        index = 0
        while index < len(text):
            char = text[index]
            if char == "{":
                depth += 1
                index += 1
                continue
            if char == "}":
                depth -= 1
                index += 1
                continue
            if char == "\n":
                index += 1
                continue
            # Skip comments and strings so their braces do not shift the depth, and so a
            # `LZ.Foo` mentioned in prose is not mistaken for a read.
            if text.startswith("//", index):
                index = text.find("\n", index)
                if index < 0:
                    break
                continue
            if text.startswith("/*", index):
                end = text.find("*/", index + 2)
                index = len(text) if end < 0 else end + 2
                continue
            if char in "'\"`":
                quote = char
                index += 1
                while index < len(text) and text[index] != quote:
                    if text[index] == "\\":
                        index += 1
                    index += 1
                index += 1
                continue
            if depth == 1 and text.startswith("LZ.", index):
                rest = text[index + 3 :]
                key = ""
                for ch in rest:
                    if ch.isalnum() or ch == "_":
                        key += ch
                    else:
                        break
                after = rest[len(key) :].lstrip()
                # `LZ.X = { ... }` is this module DECLARING X, not reading it. Counting an
                # assignment as a read reported every module as depending on itself.
                is_write = after.startswith("=") and not after.startswith("==")
                if key and not is_write:
                    found.add(key)
                index += 3 + len(key)
                continue
            index += 1
        return found

    problems: list[str] = []
    available: set[str] = set()
    for name, text in modules:
        for key in sorted(top_level_reads(text)):
            if key in defined and key not in available:
                problems.append(f"{name} reads LZ.{key} at load time, before {defined[key]} defines it")
        # This module's own exports become available only after it has evaluated.
        for line in text.split("\n"):
            marker = line.strip()
            if marker.startswith("LZ.") and " = {" in marker:
                available.add(marker.split(" = {")[0].strip()[3:])

    if problems:
        sys.exit("error: manifest order would leave a dependency undefined:\n  " + "\n  ".join(problems))
    print(f"module order verified ({len(modules)} modules, {len(defined)} namespaces)")


# ------------------------------------------------------------------ main


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC, help="the outer bundle template")
    parser.add_argument("--src-dir", type=Path, default=DEFAULT_SRC_DIR, help="the module tree")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="generated client.js")
    parser.add_argument("--font-dir", type=Path, default=VENDOR_FONT_DIR,
                        help="directory holding the vendored Inter / JetBrains Mono faces")
    parser.add_argument("--dry-run", action="store_true", help="report sizes without writing")
    parser.add_argument("--frames-only", action="store_true",
                        help="rebuild the frame with an empty font block (fast frame iteration)")
    args = parser.parse_args()

    if not args.src.is_file():
        sys.exit(f"error: source file not found: {args.src}")
    if not FRAME_TEMPLATE.is_file():
        sys.exit(f"error: frame template not found: {FRAME_TEMPLATE}")

    manifest = read_manifest()
    style_parts = read_parts(args.src_dir, manifest["styles"], "style")
    module_parts = read_parts(args.src_dir, manifest["modules"], "module")
    verify_module_order(manifest, module_parts)

    styles = assemble_styles(style_parts)
    modules = assemble_modules(module_parts)
    frame = build_frame(FRAME_TEMPLATE.read_text(encoding="utf-8"), styles, modules)
    verify_frame_script(frame)
    # Parsing is not running. See the docstring: this caught a concatenation bug that parsed
    # perfectly and left every namespace after the first undefined.
    verify_frame_modules_evaluate(frame)

    template = args.src.read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        sys.exit(f"error: {args.src} does not contain the placeholder {PLACEHOLDER}")

    if args.frames_only:
        css = "/* fonts omitted: --frames-only */"
        report: list[tuple[str, int, int]] = []
    else:
        if not args.font_dir.is_dir():
            sys.exit(f"error: vendored font dir not found: {args.font_dir}")
        # Printed for visibility only — this no longer decides what goes in the face.
        collect_chars(args.src_dir)
        with tempfile.TemporaryDirectory() as scratch:
            css, report = font_face_css(args.font_dir, "", Path(scratch))

        print()
        print(f"{'face':<34}{'woff2':>10}{'base64':>12}")
        for label, raw_size, encoded in report:
            print(f"{label:<34}{raw_size / 1024:>9.0f}K{encoded / 1024:>11.0f}K")
        total_raw = sum(r for _, r, _ in report)
        total_enc = sum(e for _, _, e in report)
        print(f"{'total':<34}{total_raw / 1024:>9.0f}K{total_enc / 1024:>11.0f}K")

    # The frame is a real string rather than a template literal, so it is embedded as a JSON
    # string literal. That sidesteps the backtick / `${` class of bug entirely for the
    # ASSEMBLED part — but the outer bundle still has to parse, which is what the gate below
    # checks.
    #
    # The substitution happens INSIDE the bundle's `buildFrameDocument()`, per call, because
    # the test suites call that function directly with their own font CSS.
    frame_literal = json.dumps(frame)

    if args.dry_run:
        print(f"\nframe: {len(frame) / 1024:.0f} KB ({len(styles) / 1024:.0f} KB css, {len(modules) / 1024:.0f} KB js)")
        print("\ndry run — nothing written")
        return

    if "/*__FRAME_DOCUMENT__*/" not in template:
        sys.exit(f"error: {args.src} does not contain the /*__FRAME_DOCUMENT__*/ placeholder")

    banner = (
        "// GENERATED by tools/build-font-css.py — do not edit by hand.\n"
        "// Source of truth: src/ (assembled in the order src/app/manifest.json declares).\n"
        "// Fonts: Inter Variable + JetBrains Mono Variable (Latin/mono, inlined whole).\n"
        "// CJK comes from the operating system — see the note at the top of the build script.\n"
    )
    body = template.replace(PLACEHOLDER, css).replace("/*__FRAME_DOCUMENT__*/", frame_literal)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(banner + body, encoding="utf-8")
    print(f"\nwrote {args.out} ({args.out.stat().st_size / 1024:.0f} KB)")

    # Gate the build on the artifact actually being loadable, and on the FRAME's script
    # parsing — the outer parse cannot see inside the frame string.
    verify_bundle_parses(args.out)
    verify_frame_script(frame)


if __name__ == "__main__":
    main()
