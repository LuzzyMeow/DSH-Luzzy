"""Verify the four delivered screenshots: size, hash, and that they differ.

AGENTS.md 5.7: two screenshots that SHOULD differ and share a hash mean the second was never
verified. That is the check this performs, plus the size assertion the objective names (the panel
is 1630x984; only the README is deliberately taller because it is a long scrollable document).
"""
import hashlib
import os
import sys
from PIL import Image

temp = os.environ.get('TEMP') or os.environ.get('TMP')
names = ['goal', 'system', 'preset', 'readme']

rows = []
for name in names:
    path = os.path.join(temp, f'fin-{name}.png')
    if not os.path.exists(path):
        print(f'  MISSING  {path}')
        sys.exit(1)
    with open(path, 'rb') as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()[:16]
    with Image.open(path) as image:
        size = image.size
    rows.append((name, digest, size))

print(f'{"page":<8} {"sha256[:16]":<18} size')
for name, digest, size in rows:
    print(f'{name:<8} {digest:<18} {size[0]}x{size[1]}')

print()
ok = True
for name, _, size in rows:
    expected = (1630, 2400) if name == 'readme' else (1630, 984)
    if size != expected:
        print(f'  FAIL {name}: {size[0]}x{size[1]}, expected {expected[0]}x{expected[1]}')
        ok = False

digests = [row[1] for row in rows]
if len(set(digests)) != len(digests):
    print('  FAIL duplicate screenshots — 5.7 says a shared hash means one was never verified')
    ok = False

print('PASS — 4 distinct screenshots at the real panel size' if ok else 'FAIL')
sys.exit(0 if ok else 1)
