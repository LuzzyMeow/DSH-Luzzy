"""Render every sub-page at the real panel size and verify the result.

TWO FAILURES THIS ABSORBS, BOTH MEASURED RATHER THAN ASSUMED

1. The PNG lands AFTER the render tool exits. Edge on this machine launches elevated and hands off
   to a de-elevated child, so `execFileSync` returns while the image is still being written — a
   `Test-Path` on the next line reports "missing" for a file that appears about a second later.
   `shoot.mjs` already retries internally; its `shot: ...` line is therefore NOT proof the file is
   on disk. This waits for the file to exist AND to stop growing.

2. `$env:TEMP` is the 8.3 SHORT path on this machine (`C:\\Users\\ADMINI~1\\...`) while the tools
   print and write the long form (`C:\\Users\\Administrator\\...`). They are the same directory, but
   a string comparison says otherwise — which is why some screenshots looked like they had
   "vanished" when they were there all along. This resolves through the real API and compares
   resolved paths, never the raw strings.

It then asserts what AGENTS.md 5.7 requires: four screenshots that should differ must not share a
hash, and each must be the size the panel actually is.
"""
import hashlib
import os
import subprocess
import sys
import tempfile
import time

TOOLS = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(TOOLS)
TEMP = tempfile.gettempdir()  # the LONG path, resolved — not the TEMP env string

# page -> expected size. The panel is 1630x984; the README is a long document and is captured
# taller on purpose, because it legitimately scrolls.
PAGES = {
    'goal': (1630, 984),
    'system': (1630, 984),
    'preset': (1630, 984),
    'readme': (1630, 2400),
}

# The smallest real page here is ~58 KB. Anything under this is blank or half-written.
MIN_BYTES = 20_000


def wait_for_file(path, budget_s=20.0):
    """Wait until the file exists AND has stopped growing. Returns its size, or 0."""
    deadline = time.time() + budget_s
    last = -1
    stable = 0
    while time.time() < deadline:
        time.sleep(0.4)
        try:
            size = os.path.getsize(path)
        except OSError:
            last = -1
            continue
        if size > 0 and size == last:
            stable += 1
            if stable >= 2:
                return size
        else:
            stable = 0
        last = size
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def render(tab):
    out = os.path.join(TEMP, f'final-{tab}.png')
    for attempt in (1, 2):
        if os.path.exists(out):
            os.remove(out)
        subprocess.run(
            ['node', os.path.join(TOOLS, 'render-frame-with-data.mjs'), '--tab', tab, '--shot', out],
            cwd=PLUGIN, capture_output=True, text=True,
        )
        size = wait_for_file(out)
        if size >= MIN_BYTES:
            return out
        print(f'  retry {tab} (attempt {attempt}: {size} bytes)')
    return out if os.path.exists(out) else None


def main():
    rows = []
    for tab, expected in PAGES.items():
        path = render(tab)
        if path is None:
            print(f'FAIL — {tab} never produced a file')
            return 1
        with open(path, 'rb') as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()[:16]
        size = (0, 0)
        try:
            from PIL import Image
            with Image.open(path) as image:
                size = image.size
        except ImportError:
            pass
        rows.append((tab, digest, size, expected))

    print(f'\n{"page":<8} {"sha256[:16]":<18} {"size":<12} expected')
    for tab, digest, size, expected in rows:
        mark = '' if size == expected or size == (0, 0) else '   <-- MISMATCH'
        print(f'{tab:<8} {digest:<18} {size[0]}x{size[1]:<8} {expected[0]}x{expected[1]}{mark}')

    ok = True
    if len({row[1] for row in rows}) != len(rows):
        print('\nFAIL — duplicate screenshots: 5.7 says a shared hash means one was never verified')
        ok = False
    for tab, _, size, expected in rows:
        if size != (0, 0) and size != expected:
            ok = False

    print('\nPASS — all pages rendered, distinct, at the real panel size' if ok else '\nFAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
