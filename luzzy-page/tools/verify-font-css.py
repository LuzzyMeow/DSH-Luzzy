#!/usr/bin/env python3
"""Verify the built lib/client.js: decode every inlined font and check the subset covers the page copy.

This reads the *generated* artifact, not the build script's own report — the point is
to catch a silent failure (empty subset, wrong face, missing glyph) that the build
would still call a success.

Usage:
    python tools/verify-font-css.py
"""

from __future__ import annotations

import base64
import io
import re
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
CLIENT = PLUGIN_ROOT / "lib" / "client.js"
SRC = PLUGIN_ROOT / "src" / "client.js"

FACE_RE = re.compile(
    r"font-family: '(?P<family>[^']+)';.*?"
    r"font-weight: (?P<weight>\d+);.*?"
    r"src: url\(data:font/woff2;base64,(?P<payload>[A-Za-z0-9+/=]+)\) format\('woff2'\)",
    re.DOTALL,
)

# Faces expected to cover CJK; the Latin faces legitimately have no CJK glyphs.
CJK_FAMILY = "Luzzy PuHuiTi"

failures: list[str] = []
notes: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def load_fonts() -> list[tuple[str, int, object]]:
    from fontTools.ttLib import TTFont

    text = CLIENT.read_text(encoding="utf-8")
    faces = []

    for match in FACE_RE.finditer(text):
        family = match.group("family")
        weight = int(match.group("weight"))
        raw = base64.b64decode(match.group("payload"))

        font = TTFont(io.BytesIO(raw), lazy=True)
        faces.append((family, weight, font))
        notes.append(
            f"decoded {family} {weight}: {len(raw) / 1024:.0f} KB, "
            f"{len(font.getGlyphOrder())} glyphs, flavor={font.flavor}"
        )

    return faces


def page_chars() -> set[str]:
    """Every non-ASCII character the page can render.

    Must match build-font-css.py's scan exactly — the page renders README.md at runtime,
    so a glyph check that only looked at src/ would pass while the README silently fell
    back to the system font.
    """
    found: set[str] = set()
    for path in (SRC, PLUGIN_ROOT / "README.md"):
        if not path.is_file():
            continue
        for char in path.read_text(encoding="utf-8"):
            if ord(char) >= 0x80 and not char.isspace():
                found.add(char)
    return found


def main() -> None:
    if not CLIENT.is_file():
        sys.exit(f"error: {CLIENT} not found — run tools/build-font-css.py first")
    if not SRC.is_file():
        sys.exit(f"error: {SRC} not found")

    faces = load_fonts()
    if len(faces) != 4:
        fail(f"expected 4 @font-face blocks, found {len(faces)}")

    for family, weight, font in faces:
        cmap = font.getBestCmap()
        if not cmap:
            fail(f"{family} {weight}: empty cmap")
            continue

        if family == CJK_FAMILY:
            # CJK faces carry the glyphs the page needs — nothing may be missing.
            missing = sorted(c for c in page_chars() if ord(c) not in cmap)
            if missing:
                fail(
                    f"{family} {weight}: missing {len(missing)} page glyph(s): "
                    f"{''.join(missing[:20])}"
                )
            # Sanity: the subset must be far smaller than the 29,296-glyph source.
            if len(cmap) > 5000:
                fail(f"{family} {weight}: {len(cmap)} glyphs — subset did not apply")
        else:
            if len(cmap) < 100:
                fail(f"{family} {weight}: only {len(cmap)} glyphs — Latin face looks truncated")

    # ASCII coverage is a *stack-level* property, not a per-face one. The CSS stack
    # lists the Latin family first, so ASCII always resolves in Alibaba Sans before
    # the CJK family is reached. The CJK faces therefore carry no ASCII on purpose —
    # their subset holds exactly the page's non-ASCII glyphs. Both Latin weights are
    # checked, since bold ASCII must have a bold home too.
    latin_cmaps = [
        font.getBestCmap() for family, _, font in faces if family != CJK_FAMILY
    ]
    missing_ascii = [
        c
        for c in "Alphabet 0123456789.,·"
        if not all(ord(c) in cmap for cmap in latin_cmaps)
    ]
    if missing_ascii:
        fail(f"ASCII not fully covered by the Latin faces: {''.join(missing_ascii)}")

    print("\n".join(notes))
    print()

    if failures:
        print("FAIL")
        for message in failures:
            print(f"  - {message}")
        sys.exit(1)

    print(f"PASS — {len(faces)} faces inlined, CJK subset covers all {len(page_chars())} page glyphs")


if __name__ == "__main__":
    main()
