#!/usr/bin/env python3
"""Build lib/client.js for LuzzyPage: subset the fonts, inline them, expand the placeholder.

Two source fonts, two different treatments:

* CJK (Alibaba PuHuiTi 3.0) — subset to exactly the characters the page uses, which
  are harvested from src/. A 7 MB face drops to tens of KB this way.
* Latin (Alibaba Sans) — kept whole. It is only ~730 glyphs, so conversion alone gets
  it small, and keeping it whole removes any chance of a missing Latin glyph.

The Latin face carries no CJK glyphs at all, so the CSS font stack does the
bilingual split for free: Latin resolves in Alibaba Sans (listed first), everything
else falls through to PuHuiTi. No `unicode-range` is needed, and none is emitted —
it would wrongly exclude CJK punctuation such as U+3001 and U+FF0C.

Usage:
    python tools/build-font-css.py                     # build lib/client.js
    python tools/build-font-css.py --dry-run           # report sizes, write nothing
"""

from __future__ import annotations

import argparse
import base64
import subprocess
import sys
import tempfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FONT_DIR = Path(r"D:\.NekoTool\LuzzyRP\app\src\main\res\font")
# Fallback source for the two CJK faces.
#
# The .ttf faces this build originally used were removed from LuzzyRP's res/font directory
# (only the three Alibaba Sans faces remain there), which broke the build outright — a
# pre-existing failure, not one this file introduced. The same PuHuiTi faces still exist in
# that project as WOFF2 under its asset tree, and `pyftsubset` reads WOFF2 input directly
# (verified), so the build can keep working instead of failing on a file that is no longer
# where it used to be.
#
# TTF is still tried FIRST for every face: it is the higher-fidelity source, and if the
# original files come back the build picks them up again with no change here.
DEFAULT_FALLBACK_FONT_DIR = Path(r"D:\.NekoTool\LuzzyRP\app\src\main\assets\rphub\assets\fonts")
DEFAULT_SRC = PLUGIN_ROOT / "src" / "client.js"
DEFAULT_OUT = PLUGIN_ROOT / "lib" / "client.js"

PLACEHOLDER = "/*__FONT_FACE_CSS__*/"

FAMILY_CJK = "Luzzy PuHuiTi"
FAMILY_LATIN = "Luzzy Sans"

# (source filename, css family, weight, subset mode, fallback filename or None)
#
# The fallback is a different FILE NAME for the same face, not a different face: the PuHuiTi
# numbering is the weight (55 = Regular 400, 85 = Bold 700), so the pairing is exact.
FACES = [
    ("puhuiti_55_regular.ttf", FAMILY_CJK, 400, "subset", "AlibabaPuHuiTi-3-55-Regular.woff2"),
    ("puhuiti_85_bold.ttf", FAMILY_CJK, 700, "subset", "AlibabaPuHuiTi-3-85-Bold.woff2"),
    ("alibaba_sans_regular.ttf", FAMILY_LATIN, 400, "whole", None),
    ("alibaba_sans_bold.ttf", FAMILY_LATIN, 700, "whole", None),
]

SCAN_SUFFIXES = (".js", ".jsx", ".ts", ".tsx")

# README.md is rendered AT RUNTIME inside the page, so its glyphs must be in the subset
# too — otherwise the README silently falls back to the system font. It is not under
# src/, so it is listed explicitly.
EXTRA_SCAN_FILES = ("README.md",)


def collect_chars(src_dir: Path) -> str:
    """Every non-ASCII, non-space character in the page sources and rendered files."""
    found: set[str] = set()
    scanned = 0

    targets = [src_dir] if src_dir.is_file() else [
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


def build_cjk(source: Path, charset: str, target: Path) -> int:
    """Subset a CJK face to `charset` and write WOFF2. Returns bytes written."""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".txt", encoding="utf-8", delete=False
    ) as handle:
        handle.write(charset)
        charset_file = Path(handle.name)

    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "fontTools.subset",
                str(source),
                f"--text-file={charset_file}",
                f"--output-file={target}",
                "--flavor=woff2",
                "--layout-features=kern,liga,clig,calt",
                "--no-hinting",
                "--desubroutinize",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        sys.exit(f"error: pyftsubset failed on {source.name}\n{error.stderr}")
    finally:
        charset_file.unlink(missing_ok=True)

    return target.stat().st_size


def build_latin(source: Path, target: Path) -> int:
    """Convert a Latin face to WOFF2 whole — no subsetting. Returns bytes written."""
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


def font_face_css(font_dir: Path, charset: str, scratch: Path, fallback_dir: Path | None = None) -> tuple[str, list[tuple[str, int, int]]]:
    """Build every face, return (css, [(label, woff2_bytes, base64_bytes)])."""
    blocks: list[str] = []
    report: list[tuple[str, int, int]] = []

    for filename, family, weight, mode, fallback_name in FACES:
        source = font_dir / filename
        if not source.is_file() and fallback_name is not None and fallback_dir is not None:
            candidate = fallback_dir / fallback_name
            if candidate.is_file():
                print(f"note: {filename} is absent; using {fallback_name} from the fallback dir")
                source = candidate
        if not source.is_file():
            sys.exit(f"error: missing source font {font_dir / filename}")

        target = scratch / f"{source.stem}.woff2"
        raw_size = (
            build_cjk(source, charset, target)
            if mode == "subset"
            else build_latin(source, target)
        )

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
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        # Plain concatenation, not .format(): the message itself contains {braces} and a
        # backtick escape, and mixing those with format placeholders crashed the reporter
        # instead of reporting (which then looked like a build failure when the write had
        # in fact succeeded).
        node_says = result.stderr.strip()
        sys.exit(
            "error: the built bundle does not parse — "
            + str(out) + " is broken.\n"
            "       Most likely a raw backtick inside the frame template literal\n"
            "       (escape it as \\`), or an unbalanced ${...}.\n"
            "       node says: " + node_says
        )
    print("bundle parses cleanly")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC, help="source client.js to scan and expand")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="generated client.js")
    parser.add_argument("--font-dir", type=Path, default=DEFAULT_FONT_DIR)
    parser.add_argument("--fallback-font-dir", type=Path, default=DEFAULT_FALLBACK_FONT_DIR,
                        help="where to look for a face the primary dir no longer has")
    parser.add_argument("--dry-run", action="store_true", help="report sizes without writing")
    args = parser.parse_args()

    if not args.src.is_file():
        sys.exit(f"error: source file not found: {args.src}")
    if not args.font_dir.is_dir():
        sys.exit(f"error: font dir not found: {args.font_dir}")

    template = args.src.read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        sys.exit(f"error: {args.src} does not contain the placeholder {PLACEHOLDER}")

    charset = collect_chars(args.src)
    if not charset:
        sys.exit("error: no non-ASCII characters found; nothing to subset")

    with tempfile.TemporaryDirectory() as scratch:
        css, report = font_face_css(args.font_dir, charset, Path(scratch), args.fallback_font_dir)

    print()
    print(f"{'face':<34}{'woff2':>10}{'base64':>12}")
    for label, raw_size, encoded in report:
        print(f"{label:<34}{raw_size / 1024:>9.0f}K{encoded / 1024:>11.0f}K")
    total_raw = sum(r for _, r, _ in report)
    total_enc = sum(e for _, _, e in report)
    print(f"{'total':<34}{total_raw / 1024:>9.0f}K{total_enc / 1024:>11.0f}K")

    if args.dry_run:
        print("\ndry run — nothing written")
        return

    banner = (
        "// GENERATED by tools/build-font-css.py — do not edit by hand.\n"
        "// Source of truth: src/client.js. Re-run the build script after changing page copy.\n"
        "// Fonts: Alibaba PuHuiTi 3.0 (CJK, subset to page copy) + Alibaba Sans (Latin, whole).\n"
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(banner + template.replace(PLACEHOLDER, css), encoding="utf-8")
    print(f"\nwrote {args.out} ({args.out.stat().st_size / 1024:.0f} KB)")

    # Gate the build on the artifact actually being loadable.
    verify_bundle_parses(args.out)


if __name__ == "__main__":
    main()
