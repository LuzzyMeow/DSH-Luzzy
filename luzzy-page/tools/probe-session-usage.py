"""Inspect real DSH session logs: what usage fields actually exist, and can they be aggregated.

The usage page must report correct numbers, so this establishes the data contract by
reading the real zstd-compressed logs rather than assuming a shape. Read-only: it never
writes into the session store.

Usage:
    python tools/probe-session-usage.py                 # shape + aggregate over all sessions
    python tools/probe-session-usage.py --samples 3     # also dump sample usage events
    python tools/probe-session-usage.py --max-files 40  # limit how many logs to read
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

DEFAULT_ROOT = pathlib.Path.home() / ".dsh" / "sessions"

# Fields worth summing across sessions; discovered empirically, kept explicit so an
# unexpected shape shows up as a missing key rather than a silent zero.
USAGE_FIELDS = (
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "uncachedInputTokens",
)


def iter_events(path: pathlib.Path):
    import zstandard

    with open(path, "rb") as handle:
        raw = zstandard.ZstdDecompressor().stream_reader(handle).read()
    for line in raw.decode("utf-8", errors="replace").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def event_type(event: dict) -> str:
    return event.get("type") or (event.get("event") or {}).get("type") or "?"


def find_usage(obj, path=""):
    """Yield (path, dict) for every usage-shaped object found anywhere in the event."""
    if isinstance(obj, dict):
        keys = set(obj)
        if keys & set(USAGE_FIELDS):
            yield path, obj
        for key, value in obj.items():
            yield from find_usage(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            yield from find_usage(value, f"{path}[{index}]")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=DEFAULT_ROOT)
    parser.add_argument("--max-files", type=int, default=0, help="0 = all")
    parser.add_argument("--samples", type=int, default=2, help="usage events to print")
    args = parser.parse_args()

    if not args.root.is_dir():
        sys.exit(f"error: session root not found: {args.root}")

    logs = sorted(args.root.rglob("*.jsonl.zstd"), key=lambda p: p.stat().st_mtime, reverse=True)
    if args.max_files:
        logs = logs[: args.max_files]
    if not logs:
        sys.exit(f"error: no *.jsonl.zstd under {args.root}")

    print(f"sessions: {len(logs)} logs under {args.root}")
    print(f"newest:   {logs[0].parent.name}  ({logs[0].stat().st_size // 1024} KB)")
    print()

    types = Counter()
    usage_paths = Counter()
    field_counts = Counter()
    totals = defaultdict(int)
    models = Counter()
    per_session = defaultdict(lambda: defaultdict(int))
    timestamps = []
    shown = 0
    bad = 0

    for log in logs:
        try:
            events = list(iter_events(log))
        except Exception as error:  # noqa: BLE001 — report and continue
            bad += 1
            print(f"  ! {log.parent.name}: {error}")
            continue

        session_id = log.parent.name
        for event in events:
            types[event_type(event)] += 1

            stamp = event.get("time") or (event.get("event") or {}).get("time")
            if isinstance(stamp, (int, float)):
                timestamps.append(stamp)

            # Model routing, to confirm per-model aggregation is possible.
            for key in ("model", "modelId"):
                found = event.get(key) or (event.get("event") or {}).get(key)
                if isinstance(found, str):
                    models[found] += 1

            for path, usage in find_usage(event):
                usage_paths[path] += 1
                for field in USAGE_FIELDS:
                    if field in usage and isinstance(usage[field], (int, float)):
                        field_counts[field] += 1
                        totals[field] += usage[field]
                        per_session[session_id][field] += usage[field]

                if shown < args.samples:
                    shown += 1
                    print(f"--- sample usage event #{shown}  [{session_id}]  path: {path or '(root)'}")
                    print(json.dumps(usage, ensure_ascii=False, indent=2)[:900])
                    print()

    print(f"unreadable logs: {bad}")
    print()
    print("event types (top 20):")
    for name, count in types.most_common(20):
        print(f"  {count:>7}  {name}")

    print()
    print("usage object paths found:")
    for path, count in usage_paths.most_common(12):
        print(f"  {count:>7}  {path or '(root)'}")

    print()
    print("usage fields present (count) and summed across all sessions:")
    for field in USAGE_FIELDS:
        count = field_counts.get(field, 0)
        print(f"  {field:<22} {count:>7} events   total = {totals.get(field, 0):,}")

    print()
    print(f"models seen in events (top 12 of {len(models)}):")
    for name, count in models.most_common(12):
        print(f"  {count:>7}  {name}")

    if timestamps:
        lo, hi = min(timestamps), max(timestamps)
        fmt = lambda t: datetime.fromtimestamp(t / 1000 if t > 1e11 else t, tz=timezone.utc).isoformat()
        print()
        print(f"time range in logs: {fmt(lo)} .. {fmt(hi)}")
        print(f"  (raw min={lo}, max={hi} — confirms the unit before bucketing by hour/day/week/month)")

    print()
    print(f"sessions contributing usage: {len(per_session)}")
    top = sorted(per_session.items(), key=lambda kv: kv[1].get("totalTokens", 0), reverse=True)[:5]
    for session_id, sums in top:
        print(f"  {session_id[:44]:<46} total={sums.get('totalTokens', 0):,}")


if __name__ == "__main__":
    main()
