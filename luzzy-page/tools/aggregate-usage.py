"""Aggregate token usage with the SAME replace semantics the harness itself uses.

The naive approach — sum every usage object you find — double counts. Each settled
attempt records its usage twice:

  * `.data.stream[N].chunk.usage` inside the assistant message's stream array
  * `.data.usage`                on the assistant message itself

`dsh-token-meter`'s contract says the final assistant sample *replaces* the streaming
usage for the same attempt. So the correct aggregation is: prefer `.data.usage` when
present, and only fall back to stream chunks when it is absent.

This script computes both ways side by side so the discrepancy is visible rather than
assumed, and attributes every attempt to the model from the governing `request/header`.

Usage:
    python tools/aggregate-usage.py --by day
    python tools/aggregate-usage.py --by hour --json out.json
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import defaultdict
from datetime import datetime, timezone

DEFAULT_ROOT = pathlib.Path.home() / ".dsh" / "sessions"
FIELDS = ("inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "reasoningTokens")


def iter_events(path: pathlib.Path):
    import zstandard

    with open(path, "rb") as handle:
        raw = zstandard.ZstdDecompressor().stream_reader(handle).read()
    for line in raw.decode("utf-8", errors="replace").split("\n"):
        if line.strip():
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def bucket_key(ms: int, unit: str) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone()
    if unit == "hour":
        return dt.strftime("%Y-%m-%d %H:00")
    if unit == "day":
        return dt.strftime("%Y-%m-%d")
    if unit == "week":
        iso = dt.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if unit == "month":
        return dt.strftime("%Y-%m")
    raise ValueError(unit)


def collect(log: pathlib.Path, unit: str):
    """Return (correct, naive, per_model) aggregates for one session log."""
    correct = defaultdict(lambda: defaultdict(int))
    naive = defaultdict(lambda: defaultdict(int))
    per_model = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    model_counts = defaultdict(int)

    current_model = "unknown"
    session_id = log.parent.name

    for event in iter_events(log):
        event_name = event.get("type")
        data = event.get("data") or {}
        time_ms = event.get("time") or 0

        if event_name == "request/header":
            config = (data.get("header") or {}).get("config") or {}
            provider = config.get("provider") or "?"
            model = config.get("model") or "?"
            current_model = f"{provider}/{model}"
            model_counts[current_model] += 1
            continue

        if event_name != "assistant/message":
            continue

        final = data.get("usage")
        stream = data.get("stream") or []
        stream_usages = [
            entry.get("chunk", {}).get("usage")
            for entry in stream
            if isinstance(entry, dict) and isinstance(entry.get("chunk"), dict)
        ]
        stream_usages = [u for u in stream_usages if isinstance(u, dict)]

        bucket = bucket_key(time_ms, unit)

        # Naive: everything that looks like usage.
        for usage in ([final] if isinstance(final, dict) else []) + stream_usages:
            for field in FIELDS:
                value = usage.get(field)
                if isinstance(value, (int, float)):
                    naive[bucket][field] += value

        # Correct: the settled sample replaces the streamed one for this attempt.
        chosen = final if isinstance(final, dict) else (stream_usages[-1] if stream_usages else None)
        if chosen is not None:
            for field in FIELDS:
                value = chosen.get(field)
                if isinstance(value, (int, float)):
                    correct[bucket][field] += value
                    per_model[current_model][bucket][field] += value

    return session_id, correct, naive, per_model, model_counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=DEFAULT_ROOT)
    parser.add_argument("--by", choices=("hour", "day", "week", "month"), default="day")
    parser.add_argument("--json", type=pathlib.Path, default=None)
    args = parser.parse_args()

    logs = sorted(args.root.rglob("*.jsonl.zstd"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not logs:
        sys.exit(f"error: no session logs under {args.root}")

    total_correct = defaultdict(int)
    total_naive = defaultdict(int)
    by_bucket = defaultdict(lambda: defaultdict(int))
    by_model = defaultdict(lambda: defaultdict(int))
    models_seen = defaultdict(int)
    sessions = 0

    for log in logs:
        try:
            _sid, correct, naive, per_model, model_counts = collect(log, args.by)
        except Exception as error:  # noqa: BLE001
            print(f"  ! {log.parent.name}: {error}")
            continue
        sessions += 1
        for bucket, sums in correct.items():
            for field, value in sums.items():
                by_bucket[bucket][field] += value
                total_correct[field] += value
        for bucket, sums in naive.items():
            for field, value in sums.items():
                total_naive[field] += value
        for model, buckets in per_model.items():
            for bucket, sums in buckets.items():
                for field, value in sums.items():
                    by_model[model][field] += value
        for model, count in model_counts.items():
            models_seen[model] += count

    print(f"sessions read: {sessions} / {len(logs)}   bucket: {args.by}")
    print()
    print("total across all sessions — correct vs naive (double-counting)口径:")
    print(f"  {'field':<18}{'correct':>18}{'naive':>18}{'ratio':>9}")
    for field in FIELDS:
        c = total_correct.get(field, 0)
        n = total_naive.get(field, 0)
        ratio = f"{n / c:.2f}x" if c else "-"
        print(f"  {field:<18}{c:>18,}{n:>18,}{ratio:>9}")

    print()
    print(f"by {args.by} (correct口径), top 12 most recent buckets:")
    for bucket in sorted(by_bucket, reverse=True)[:12]:
        sums = by_bucket[bucket]
        print(
            f"  {bucket:<16} total={sums.get('totalTokens', 0):>14,}"
            f"  in={sums.get('inputTokens', 0):>12,}"
            f"  cache={sums.get('cacheReadTokens', 0):>13,}"
            f"  out={sums.get('outputTokens', 0):>10,}"
        )

    print()
    print(f"by model (correct口径), {len(by_model)} models:")
    ranked = sorted(by_model.items(), key=lambda kv: kv[1].get("totalTokens", 0), reverse=True)
    grand = total_correct.get("totalTokens", 0) or 1
    for model, sums in ranked:
        total = sums.get("totalTokens", 0)
        print(
            f"  {model:<40} total={total:>14,}  {total / grand * 100:>5.1f}%"
            f"  out={sums.get('outputTokens', 0):>10,}"
        )

    print()
    print("model routing events seen (request/header count):")
    for model, count in sorted(models_seen.items(), key=lambda kv: -kv[1])[:10]:
        print(f"  {count:>6}  {model}")

    if args.json:
        payload = {
            "unit": args.by,
            "totals": dict(total_correct),
            "totals_naive": dict(total_naive),
            "byBucket": {k: dict(v) for k, v in by_bucket.items()},
            "byModel": {k: dict(v) for k, v in by_model.items()},
        }
        args.json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
