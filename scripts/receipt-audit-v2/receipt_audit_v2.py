#!/usr/bin/env python3
"""Receipt audit v2 — reproducible character accounting for
``read_metaweb_pins_batch`` receipts.

The audited model is the 265-base form (孙悟空, 2026-10-29) as generalised by
the 2026-11-12 macOS recomputation:

    |JSON| = 265
           + (len(caliber) - 64)
           + sum(digits of the seven counts)
           + (4 if truncated else 5)
           + sum over truncation_points of
                178 + sum(digits of the four numbers)
                    + (len(reason) - 7) + (len(unit) - 10)
           + max(k - 1, 0)                     # k = len(truncation_points)
           + U

    U = sum over EACH id array of
            sum(len(id) + 2) + max(n_array - 1, 0)

The two disputed cells are explicit switchable dimensions:

* id-array commas: per-array (correct) vs merged across both arrays;
* caliber literal: counted as ``len(caliber) - 64`` (correct) vs folded into
  the 265 constant (no term).

Zero dependencies: Python 3.8+ standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime

PREFIX = "- RECEIPT read_metaweb_pins_batch: "
DEFAULT_SPILL = os.path.expanduser(
    "~/Library/Application Support/IDBots/dsh-sessions/v0/spill"
)

BASE = 265
CALIBER_BASE = 64
ENTRY_BASE = 178
REASON_BASE = 7
UNIT_BASE = 10
COUNT_KEYS = (
    "requested",
    "readable_upstream",
    "returned",
    "omitted",
    "unreadable",
    "truncation_point_count",
    "bytes_written",
)
K_BUCKETS = ((0, 0), (1, 3), (4, 6), (7, 9), (10, 12), (13, None))

VARIANTS = (
    ("per_array_caliber", True, True),
    ("per_array_no_caliber", True, False),
    ("merged_caliber", False, True),
    ("merged_no_caliber", False, False),
)


def digits(value):
    """Number of decimal digits of a non-negative integer."""
    return len(str(int(value)))


def number_digits(value):
    """Digits of one entry number; JSON null costs exactly four characters."""
    return 4 if value is None else digits(value)


def ids_cost(arrays, per_array=True):
    """Characters spent by the id arrays, quotes and commas included.

    ``arrays`` is a sequence of id lists.  With ``per_array=True`` every
    non-empty array pays its own ``max(n - 1, 0)`` commas, which is how JSON
    actually serialises two separate arrays.
    """
    groups = list(arrays) if per_array else [sum((list(a) for a in arrays), [])]
    total = 0
    for group in groups:
        if not group:
            continue
        total += sum(len(item) + 2 for item in group)
        total += max(len(group) - 1, 0)
    return total


def entry_cost(point):
    """Characters spent by one truncation_points entry."""
    return (
        ENTRY_BASE
        + number_digits(point["kept_chars"])
        + number_digits(point["total_chars"])
        + number_digits(point["cut_at_bytes"])
        + number_digits(point["total_bytes"])
        + (len(point["reason"]) - REASON_BASE)
        + (len(point["unit"]) - UNIT_BASE)
    )


def predicted_length(obj, per_array=True, caliber=True):
    """Predicted ``len(JSON)`` under one of the four audited calibers."""
    total = BASE
    if caliber:
        total += len(obj.get("caliber", "")) - CALIBER_BASE
    total += sum(digits(obj[key]) for key in COUNT_KEYS)
    total += 4 if obj["truncated"] else 5
    points = obj.get("truncation_points") or []
    total += sum(entry_cost(point) for point in points)
    total += max(len(points) - 1, 0)
    total += ids_cost(
        (obj.get("omitted_ids") or [], obj.get("unreadable_ids") or []),
        per_array=per_array,
    )
    return total


def ledger(obj, per_array=True, caliber=True):
    """Exact per-cell accounting; the cells sum to ``predicted_length``.

    ``fixed`` is the 265 base plus the boolean literal; the other cells are
    the variable parts the model charges explicitly.
    """
    points = obj.get("truncation_points") or []
    cells = {
        "fixed": BASE + (4 if obj["truncated"] else 5),
        "counts": sum(digits(obj[key]) for key in COUNT_KEYS),
        "entries": sum(entry_cost(point) for point in points),
        "k": max(len(points) - 1, 0),
        "ids": ids_cost(
            (obj.get("omitted_ids") or [], obj.get("unreadable_ids") or []),
            per_array=per_array,
        ),
        "caliber": (len(obj.get("caliber", "")) - CALIBER_BASE) if caliber else 0,
    }
    return cells


def parse_line(line):
    """Return ``(obj, body)`` for a matching line, or ``(None, body, error)``.

    Only the exact prefix is accepted; the body keeps its bytes apart from the
    line terminator so its length is the audited quantity.
    """
    body = line.rstrip("\n").rstrip("\r")
    if not body.startswith(PREFIX):
        raise ValueError("line does not start with the receipt prefix")
    payload = body[len(PREFIX):]
    try:
        obj = json.loads(payload)
    except json.JSONDecodeError as exc:
        return None, payload, exc
    if not isinstance(obj, dict):
        return None, payload, ValueError("payload is not a JSON object")
    missing = [key for key in COUNT_KEYS if key not in obj]
    if missing:
        return None, payload, ValueError("missing keys: " + ",".join(missing))
    return obj, payload, None


def residual(obj, body_len, per_array=True, caliber=True):
    return body_len - predicted_length(obj, per_array=per_array, caliber=caliber)


def decompose(obj, body_len, per_array=True, caliber=True):
    """Attribute a frame's residual to the audited cells.

    ``ids`` and ``caliber`` are the signed shifts caused by choosing the
    relaxed variant; ``entries`` and ``counts`` are zero because the model
    charges their measured values exactly.  ``unexplained`` is whatever is
    left over, so a non-zero value means the frame has a shape this auditor
    does not model.
    """
    reference = predicted_length(obj, per_array=True, caliber=True)
    chosen = predicted_length(obj, per_array=per_array, caliber=caliber)
    r = body_len - chosen
    ids_shift = 0
    if not per_array:
        arrays = (obj.get("omitted_ids") or [], obj.get("unreadable_ids") or [])
        ids_shift = ids_cost(arrays, per_array=False) - ids_cost(
            arrays, per_array=True
        )
    caliber_shift = 0
    if not caliber:
        caliber_shift = len(obj.get("caliber", "")) - CALIBER_BASE
    return {
        "residual": r,
        "ids": -ids_shift,
        "entry": 0,
        "caliber": -caliber_shift,
        "counts": 0,
        "unexplained": body_len - reference,
        "reference_residual": body_len - reference,
    }


def count_digits(obj):
    return sum(digits(obj[key]) for key in COUNT_KEYS)


def k_bucket(k):
    for low, high in K_BUCKETS:
        if k >= low and (high is None or k <= high):
            return f"{low}" if high == low else (
                f"{low}+" if high is None else f"{low}-{high}"
            )
    return "?"


def caliber_label(obj):
    literal = obj.get("caliber")
    if not isinstance(literal, str):
        return "<missing>"
    return literal


def parse_as_of(text):
    """Parse an ISO-8601 instant; naive values are taken as local time."""
    value = text.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    stamp = datetime.fromisoformat(value)
    if stamp.tzinfo is None:
        stamp = stamp.astimezone()
    return stamp.timestamp()


def scan(spill_dir, as_of=None, max_failures=20, max_examples=20):
    """Scan every spill file for receipt lines and aggregate the audit."""
    if not os.path.isdir(spill_dir):
        raise SystemExit(f"spill directory not found: {spill_dir}")

    files = 0
    receipt_files = 0
    matched = 0
    parsed = 0
    failures = []
    caliber_literals = Counter()
    caliber_lengths = Counter()
    unique_bodies = set()
    group = defaultdict(lambda: Counter())
    nonzero = {name: [] for name, _, _ in VARIANTS}
    residual_totals = {name: 0 for name, _, _ in VARIANTS}
    zero_counts = {name: 0 for name, _, _ in VARIANTS}
    batch = 0
    single = 0
    mtimes = []

    for root, _dirs, names in os.walk(spill_dir):
        for name in names:
            path = os.path.join(root, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if as_of is not None and stat.st_mtime > as_of:
                continue
            try:
                handle = open(path, "r", encoding="utf-8", errors="replace")
            except OSError:
                continue
            files += 1
            file_has_receipt = False
            with handle:
                for lineno, line in enumerate(handle, 1):
                    if not line.startswith(PREFIX):
                        continue
                    if not file_has_receipt:
                        file_has_receipt = True
                        receipt_files += 1
                        mtimes.append(stat.st_mtime)
                    matched += 1
                    obj, payload, error = parse_line(line)
                    if error is not None:
                        if len(failures) < max_failures:
                            failures.append(
                                {
                                    "file": os.path.relpath(path, spill_dir),
                                    "line": lineno,
                                    "body_len": len(payload),
                                    "error": f"{type(error).__name__}: {error}",
                                }
                            )
                        continue
                    parsed += 1
                    body_len = len(payload)
                    unique_bodies.add(hashlib.sha1(payload.encode("utf-8")).hexdigest())
                    length = len(obj.get("caliber", ""))
                    caliber_lengths[length] += 1
                    caliber_literals[caliber_label(obj)] += 1
                    if length == CALIBER_BASE:
                        batch += 1
                    else:
                        single += 1

                    name = os.path.relpath(path, spill_dir) + f":{lineno}"
                    frame = {
                        "source": name,
                        "body_len": body_len,
                        "k": len(obj.get("truncation_points") or []),
                        "truncated": bool(obj["truncated"]),
                        "count_digits": count_digits(obj),
                        "caliber_len": length,
                    }
                    for variant, per_array, caliber in VARIANTS:
                        r = residual(
                            obj, body_len, per_array=per_array, caliber=caliber
                        )
                        residual_totals[variant] += r
                        if r == 0:
                            zero_counts[variant] += 1
                        elif len(nonzero[variant]) < max_examples:
                            item = dict(frame)
                            item["residual"] = r
                            item.update(
                                decompose(
                                    obj,
                                    body_len,
                                    per_array=per_array,
                                    caliber=caliber,
                                )
                            )
                            nonzero[variant].append(item)
                        elif len(nonzero[variant]) == max_examples:
                            nonzero[variant].append(None)  # marker: more exist

                    key = (
                        "true" if obj["truncated"] else "false",
                        k_bucket(frame["k"]),
                        frame["count_digits"],
                        caliber_label(obj),
                    )
                    bucket = group[key]
                    bucket["frames"] += 1
                    for variant, per_array, caliber in VARIANTS:
                        if (
                            residual(
                                obj,
                                body_len,
                                per_array=per_array,
                                caliber=caliber,
                            )
                            == 0
                        ):
                            bucket[variant] += 1

    more_nonzero = {
        variant: sum(1 for item in items if item is None)
        for variant, items in nonzero.items()
    }
    return {
        "spill_dir": spill_dir,
        "as_of": as_of,
        "files_scanned": files,
        "receipt_files": receipt_files,
        "receipt_lines": matched,
        "parsed": parsed,
        "parse_failed": matched - parsed,
        "unique_bodies": len(unique_bodies),
        "batch_frames": batch,
        "single_frames": single,
        "caliber_literals": dict(caliber_literals),
        "caliber_lengths": dict(caliber_lengths),
        "corpus_mtime_min": min(mtimes) if mtimes else None,
        "corpus_mtime_max": max(mtimes) if mtimes else None,
        "variants": {
            name: {
                "per_array": per_array,
                "caliber": caliber,
                "zero": zero_counts[name],
                "total": parsed,
                "residual_sum": residual_totals[name],
            }
            for name, per_array, caliber in VARIANTS
        },
        "nonzero": {
            variant: [item for item in items if item is not None]
            for variant, items in nonzero.items()
        },
        "nonzero_truncated": {
            variant: more_nonzero[variant] for variant in more_nonzero
        },
        "groups": [{"key": list(key), **dict(bucket)} for key, bucket in sorted(group.items())],
        "failures": failures,
    }


def fixture_check(fixtures_dir):
    """Check every fixture line against ``fixtures/expected.json``."""
    expected_path = os.path.join(fixtures_dir, "expected.json")
    with open(expected_path, "r", encoding="utf-8") as handle:
        expected = json.load(handle)
    results = []
    passed = 0
    for item in expected["fixtures"]:
        path = os.path.join(fixtures_dir, item["file"])
        with open(path, "r", encoding="utf-8") as handle:
            line = handle.readline()
        obj, payload, error = parse_line(line)
        if error is not None:
            results.append({"file": item["file"], "ok": False, "error": str(error)})
            continue
        readings = {}
        ok = True
        for variant, per_array, caliber in VARIANTS:
            got = residual(obj, len(payload), per_array=per_array, caliber=caliber)
            want = item["expected_residual"][variant]
            readings[variant] = got
            ok = ok and got == want
        if obj.get("caliber") != item.get("caliber"):
            ok = False
        if len(payload) != item.get("body_len"):
            ok = False
        if len(obj.get("truncation_points") or []) != item.get("k"):
            ok = False
        checked = {
            "file": item["file"],
            "ok": ok,
            "residuals": readings,
            "expected": item["expected_residual"],
            "body_len": len(payload),
            "k": len(obj.get("truncation_points") or []),
        }
        if ok:
            passed += 1
        results.append(checked)
    return {"total": len(expected["fixtures"]), "passed": passed, "results": results}


def iso(moment):
    return datetime.fromtimestamp(moment).astimezone().isoformat(timespec="seconds")


def print_report(report, max_examples=20):
    print("== corpus ==")
    print(f"spill:            {report['spill_dir']}")
    if report["as_of"] is None:
        print("as_of:            (none: every spill file)")
    else:
        print(f"as_of:            {iso(report['as_of'])} (file mtime cutoff)")
    print(f"files_scanned:    {report['files_scanned']}")
    print(f"receipt_files:    {report['receipt_files']}")
    print(f"receipt_lines:    {report['receipt_lines']}")
    print(f"parsed_ok:        {report['parsed']}")
    print(f"parse_failed:     {report['parse_failed']}")
    print(f"unique_bodies:    {report['unique_bodies']}")
    print(f"batch_frames:     {report['batch_frames']}  (len(caliber)=64)")
    print(f"single_frames:    {report['single_frames']}  (len(caliber)!=64)")
    if report["corpus_mtime_min"] is not None:
        print(
            "corpus_mtime:     "
            f"{iso(report['corpus_mtime_min'])} .. {iso(report['corpus_mtime_max'])}"
        )
    print("caliber_lengths:  " + json.dumps(report["caliber_lengths"], sort_keys=True))

    print()
    print("== four calibers (zero residual / total) ==")
    for name, _per_array, _caliber in VARIANTS:
        row = report["variants"][name]
        print(
            f"  {name:<22} {row['zero']:>6}/{row['total']:<6} "
            f"residual_sum={row['residual_sum']:+d}"
        )

    print()
    print("== nonzero decomposition ==")
    any_nonzero = False
    for name, _per_array, _caliber in VARIANTS:
        items = report["nonzero"][name]
        extra = report["nonzero_truncated"][name]
        if not items and not extra:
            continue
        any_nonzero = True
        print(f"  variant={name}")
        for item in items[:max_examples]:
            print(
                "    {source}  len={body_len} k={k} truncated={truncated} "
                "caliber_len={caliber_len} residual={residual:+d} "
                "ids={ids:+d} entry={entry:+d} caliber={caliber:+d} "
                "counts={counts:+d} unexplained={unexplained:+d}".format(**item)
            )
        if extra:
            print(f"    ... {extra} more nonzero frame(s) not shown")
    if not any_nonzero:
        print("  (none: every parsed frame closes to zero under every caliber)")

    print()
    print("== groups: (truncated, k bucket, count digits, caliber literal) ==")
    print(
        "  frames  "
        + "  ".join(f"{name:>20}" for name, _, _ in VARIANTS)
        + "  truncated  k       digits  caliber"
    )
    for row in report["groups"]:
        truncated, bucket, digits_value, literal = row["key"]
        zeros = "  ".join(
            f"{row.get(name, 0):>20}" for name, _, _ in VARIANTS
        )
        print(
            f"  {row['frames']:>6}  {zeros}  {truncated:<9}  {bucket:<6}  "
            f"{digits_value:<6}  {literal}"
        )

    if report["failures"]:
        print()
        print("== parse failures (first {}) ==".format(len(report["failures"])))
        for failure in report["failures"]:
            print(
                f"  {failure['file']}:{failure['line']}  "
                f"body_len={failure['body_len']}  {failure['error']}"
            )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Reproducible audit of read_metaweb_pins_batch receipts."
    )
    parser.add_argument("--spill", default=DEFAULT_SPILL, help="spill root")
    parser.add_argument(
        "--as-of",
        default=None,
        metavar="ISO8601",
        help="only read spill files with mtime <= this instant "
        "(e.g. 2026-11-12T04:40:00+08:00); a file-level proxy for a corpus snapshot",
    )
    parser.add_argument(
        "--fixtures-check",
        default=None,
        metavar="DIR",
        help="check fixtures/expected.json instead of scanning the corpus",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument(
        "--max-examples",
        type=int,
        default=20,
        help="max nonzero frames shown per variant (default 20)",
    )
    args = parser.parse_args(argv)

    if args.fixtures_check:
        result = fixture_check(args.fixtures_check)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            for item in result["results"]:
                status = "PASS" if item["ok"] else "FAIL"
                print(f"{status}  {item['file']}  {item.get('residuals')}")
            print(f"fixtures: {result['passed']}/{result['total']} passed")
        return 0 if result["passed"] == result["total"] else 1

    as_of = parse_as_of(args.as_of) if args.as_of else None
    report = scan(args.spill, as_of=as_of, max_examples=args.max_examples)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_report(report, max_examples=args.max_examples)
    return 0


if __name__ == "__main__":
    sys.exit(main())
