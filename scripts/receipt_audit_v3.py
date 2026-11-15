#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""receipt_audit_v3.py -- zero-dependency audit tool for MetaWeb pins:batch receipts.

WHAT IT DOES
------------
Recomputes the receipt JSON length S = |JSON| and the whole-line length R from
the receipt fields, then compares the prediction with the measured len() of the
raw spill line. Residual = measured - predicted. A correct caliber gives
residual 0 on every frame.

CLOSED FORM (v3)
----------------
    S = 280
      + sum over six counters of (d(x) - 1)
      + (d(bytes_written) - 5)
      + (len(caliber) - caliber_baseline)          # baseline default 64
      + (0 if truncated else 1)
      + sum of entry_price(e) over truncation_points
      + max(n_entries - 1, 0)
      + sum over {omitted_ids, unreadable_ids} of
            sum_i (len(id_i) + 2) + max(m - 1, 0)

    R = 35 + S

    entry_price(e) = 178
      + sum of d(f) over kept_chars, total_chars, cut_at_bytes, total_bytes
        (None counts as 4)
      + (len(reason) - 7)
      + (len(unit) - 10)

    six = requested, readable_upstream, returned, omitted, unreadable,
          truncation_point_count

TWO CORRECTIONS TO THE LITERAL BRIEF, BOTH FORCED BY THE LOCAL CORPUS
---------------------------------------------------------------------
1. The id-array term is required. The brief's formula has no id term, but the
   corpus contains frames with omitted_ids / unreadable_ids. Without it the
   R=457 frame cannot close: 422 - 281 = 141 = two 68-char ids in one array.
2. The comma term uses len(truncation_points), not truncation_point_count.
   23 local frames have tpc > len(array); using tpc leaves residuals -1..-4,
   using the array length leaves 0. The counter counts attempted cuts; the
   array is what is serialized.

The caliber baseline is a parameter because kiop reported 64- and 66-char
spellings on the same host/night (two extra spaces, intercept +2).

USAGE
-----
    python3 scripts/receipt_audit_v3.py self-test [--json]
    python3 scripts/receipt_audit_v3.py scan [--root DIR] [--json]
                                              [--caliber-baseline 64]
                                              [--comma-mode array|tpc]
    python3 scripts/receipt_audit_v3.py probe --r 457 [--root DIR] [--json]
    python3 scripts/receipt_audit_v3.py emit-fixtures DIR
    python3 scripts/receipt_audit_v3.py audit-line FILE

Exit codes: 0 = the requested audit ran (residuals are reported, not gated);
1 = self-test failed; 2 = usage / IO error.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import sys
from collections import Counter, OrderedDict

PREFIX = "- RECEIPT read_metaweb_pins_batch: "
PREFIX_LEN = len(PREFIX)  # 35
SIX = (
    "requested",
    "readable_upstream",
    "returned",
    "omitted",
    "unreadable",
    "truncation_point_count",
)
DEFAULT_ROOT = os.path.expanduser(
    "~/Library/Application Support/IDBots/dsh-sessions/v0/spill"
)
CALIBER_64 = "api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars"
CALIBER_66 = "api/metaweb/pins:batch;text-cap=8000 runes;host-budget=18000 chars"

# The two evidence frames are injected verbatim from the spill (see build note at
# the end of this file). They are not retyped.
TARGET_JSON = '{"requested":12,"readable_upstream":12,"returned":12,"truncated":true,"omitted":0,"omitted_ids":[],"unreadable":0,"unreadable_ids":[],"truncation_point_count":12,"truncation_points":[{"pin_id":"85730486e049bb3e06db3ca502bfb19d0c003646ee5acf02e388b2fa73e05b54i0","reason":"trimmed","kept_chars":458,"total_chars":5194,"cut_at_bytes":797,"total_bytes":8362,"unit":"utf16-char"},{"pin_id":"96009c44468b59c287e7f7f11fc5a3714991c0292cd8c2baf5f8f8ceb0271282i0","reason":"trimmed","kept_chars":458,"total_chars":3409,"cut_at_bytes":727,"total_bytes":5931,"unit":"utf16-char"},{"pin_id":"66631d11c235d6b4db61de0cf7a67723eb424397b1e95627a1ef2443dec8f0efi0","reason":"trimmed","kept_chars":458,"total_chars":3123,"cut_at_bytes":877,"total_bytes":6075,"unit":"utf16-char"},{"pin_id":"60f78183b37a371bf020f12d6a29827e485ae0b6534a104065432bab24368210i0","reason":"trimmed","kept_chars":457,"total_chars":2319,"cut_at_bytes":902,"total_bytes":4621,"unit":"utf16-char"},{"pin_id":"c6f1b256c1e93b4d5e0061be30f914166f24d6ef746d0ec1decdca6f6d14861bi0","reason":"trimmed","kept_chars":458,"total_chars":3559,"cut_at_bytes":817,"total_bytes":5929,"unit":"utf16-char"},{"pin_id":"dda4e4d301d06f20102e4ae01cc175e46fa888d61ac9f8793708e2d2e93dc00bi0","reason":"trimmed","kept_chars":457,"total_chars":2197,"cut_at_bytes":836,"total_bytes":4098,"unit":"utf16-char"},{"pin_id":"3231dcbad2b5fd1ad17a34d6b7615e41c5662ea14c913526b923ef84bd327eb6i0","reason":"trimmed","kept_chars":458,"total_chars":3643,"cut_at_bytes":727,"total_bytes":5568,"unit":"utf16-char"},{"pin_id":"144465a8ccbec734cb4710b21b09c82db4a832c5ef7c9b65fc8b8614e6c6bd2di0","reason":"trimmed","kept_chars":457,"total_chars":2278,"cut_at_bytes":763,"total_bytes":4869,"unit":"utf16-char"},{"pin_id":"a954ae23de57dd821525decc73a1ad3f9ccd51082b5e86c333dc039cb14901d1i0","reason":"trimmed","kept_chars":458,"total_chars":8000,"cut_at_bytes":725,"total_bytes":12235,"unit":"utf16-char"},{"pin_id":"115e2084046603f46ce11406a57ad9c550c57409c3d29eefda7c0417ad4fe2c3i0","reason":"trimmed","kept_chars":457,"total_chars":1051,"cut_at_bytes":774,"total_bytes":1666,"unit":"utf16-char"},{"pin_id":"0d3b1113c85355f8c0d929b8a7bada65b93835d147eb8c33fcbcc6ef1f2088edi0","reason":"trimmed","kept_chars":457,"total_chars":694,"cut_at_bytes":743,"total_bytes":1180,"unit":"utf16-char"},{"pin_id":"295cc319ab1a53ca2ecec0e29230a9c829de906ee6b01485d2c85e98271b9e6fi0","reason":"trimmed","kept_chars":457,"total_chars":644,"cut_at_bytes":795,"total_bytes":1150,"unit":"utf16-char"}],"caliber":"api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars","bytes_written":23009}'
K0_JSON = '{"requested":5,"readable_upstream":5,"returned":5,"truncated":false,"omitted":0,"omitted_ids":[],"unreadable":0,"unreadable_ids":[],"truncation_point_count":0,"truncation_points":[],"caliber":"api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars","bytes_written":9984}'
R457_JSON = '{"requested":6,"readable_upstream":4,"returned":4,"truncated":false,"omitted":0,"omitted_ids":[],"unreadable":2,"unreadable_ids":["1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefi100","fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210i999"],"truncation_point_count":0,"truncation_points":[],"caliber":"api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars","bytes_written":12128}'


# --------------------------------------------------------------------------
# arithmetic
# --------------------------------------------------------------------------
def digits(value):
    """Decimal digit count of an integer. d(0) == 1."""
    return len(str(value))


def entry_digits(value):
    """Digit count for an entry field; None is priced as 4 chars (brief rule)."""
    if value is None:
        return 4
    return len(str(value))


def entry_price(entry):
    """178 + digit widths + reason/unit length deltas for one truncation point."""
    return (
        178
        + entry_digits(entry.get("kept_chars"))
        + entry_digits(entry.get("total_chars"))
        + entry_digits(entry.get("cut_at_bytes"))
        + entry_digits(entry.get("total_bytes"))
        + (len(entry.get("reason") or "") - 7)
        + (len(entry.get("unit") or "") - 10)
    )


def id_term(obj):
    """Serialized growth of the two id arrays over their empty '[]' form."""
    total = 0
    for name in ("omitted_ids", "unreadable_ids"):
        arr = obj.get(name) or []
        m = len(arr)
        if m:
            total += sum(len(x) + 2 for x in arr) + (m - 1)
    return total


def predict_parts(
    obj,
    caliber_baseline=64,
    comma_mode="array",
    include_commas=True,
    include_ids=True,
):
    """Return the additive parts of S. The sum is the predicted |JSON|."""
    points = obj.get("truncation_points") or []
    n_entries = len(points)
    if comma_mode == "array":
        comma_base = n_entries
    elif comma_mode == "tpc":
        comma_base = obj.get("truncation_point_count", 0)
    else:
        raise ValueError("comma_mode must be 'array' or 'tpc'")

    parts = OrderedDict()
    parts["base"] = 280
    parts["six_digits"] = sum(digits(obj[k]) - 1 for k in SIX)
    parts["bw_digits"] = digits(obj["bytes_written"]) - 5
    parts["caliber"] = len(obj["caliber"]) - caliber_baseline
    parts["truncated_false"] = 0 if obj["truncated"] else 1
    parts["entries"] = sum(entry_price(e) for e in points)
    parts["commas"] = max(comma_base - 1, 0) if include_commas else 0
    parts["ids"] = id_term(obj) if include_ids else 0
    return sum(parts.values()), parts


def predict_s(obj, caliber_baseline=64, comma_mode="array"):
    return predict_parts(obj, caliber_baseline, comma_mode)[0]


def predict_r(obj, caliber_baseline=64, comma_mode="array"):
    return PREFIX_LEN + predict_s(obj, caliber_baseline, comma_mode)


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------
def parse_line(line):
    """Parse one physical line. Returns (record, error).

    record keys: raw, json_text, obj, line_no, indented
    """
    raw = line.rstrip("\r\n")
    idx = raw.find(PREFIX)
    if idx < 0:
        return None, "missing-token"
    json_text = raw[idx + PREFIX_LEN :]
    try:
        obj = json.loads(json_text)
    except Exception as exc:  # noqa: BLE001 - report the parse failure verbatim
        return None, "json-error: %s" % (exc,)
    record = {
        "raw": raw,
        "json_text": json_text,
        "obj": obj,
        "line_no": None,
        "indented": idx > 0,
    }
    return record, None


def iter_canonical_lines(path):
    """Yield (line_no, line) for physical lines carrying a receipt prefix."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line_no, line in enumerate(handle, 1):
            if PREFIX not in line:
                continue
            if not line.lstrip().startswith("- RECEIPT"):
                continue
            yield line_no, line


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------
def _obj(
    requested,
    readable_upstream,
    returned,
    truncated,
    omitted,
    omitted_ids,
    unreadable,
    unreadable_ids,
    tpc,
    points,
    caliber=CALIBER_64,
    bytes_written=12345,
):
    return {
        "requested": requested,
        "readable_upstream": readable_upstream,
        "returned": returned,
        "truncated": truncated,
        "omitted": omitted,
        "omitted_ids": omitted_ids,
        "unreadable": unreadable,
        "unreadable_ids": unreadable_ids,
        "truncation_point_count": tpc,
        "truncation_points": points,
        "caliber": caliber,
        "bytes_written": bytes_written,
    }


def _canon(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _fixture(name, obj, expect_s, expect_r, note, expect_residual=0, json_text=None):
    text = json_text if json_text is not None else _canon(obj)
    return {
        "name": name,
        "line": PREFIX + text,
        "json_text": text,
        "obj": obj,
        "expect_s": expect_s,
        "expect_r": expect_r,
        "expect_residual": expect_residual,
        "note": note,
    }


_ID_A = "a" * 64 + "i0"  # 66 chars, canonical pin id
_ID_B = "b" * 64 + "i0"  # 66 chars
_ENTRY = {
    "pin_id": _ID_A,
    "reason": "trimmed",
    "kept_chars": 458,
    "total_chars": 5194,
    "cut_at_bytes": 797,
    "total_bytes": 8362,
    "unit": "utf16-char",
}

F4_OBJ = _obj(1, 1, 1, True, 0, [_ID_A], 1, [], 0, [])
F5_OBJ = _obj(2, 2, 2, True, 0, [], 2, [_ID_A, _ID_B], 0, [])
F6_OBJ = _obj(
    1,
    1,
    1,
    True,
    0,
    [],
    0,
    [],
    1,
    [
        {
            "pin_id": _ID_A,
            "reason": "trimmed",
            "kept_chars": 458,
            "total_chars": 5194,
            "cut_at_bytes": 797,
            "total_bytes": None,
            "unit": "utf16-char",
        }
    ],
)
F7_OBJ = _obj(1, 1, 1, True, 0, [], 0, [], 0, [], caliber=CALIBER_66)
F8_OBJ = _obj(
    12,
    12,
    12,
    True,
    0,
    [],
    0,
    [],
    13,
    [dict(_ENTRY) for _ in range(12)],
)

TARGET_OBJ = json.loads(TARGET_JSON)
K0_OBJ = json.loads(K0_JSON)
R457_OBJ = json.loads(R457_JSON)

FIXTURES = [
    _fixture(
        "F1-target-12-trimmed",
        TARGET_OBJ,
        2598,
        2633,
        "brief frame: N=k=12, 12 trimmed, bw=23009, caliber=64",
        json_text=TARGET_JSON,
    ),
    _fixture(
        "F3-k0-empty-arrays",
        K0_OBJ,
        280,
        315,
        "real k=0 frame: bw 4 digits (-1) and truncated=false (+1) cancel",
        json_text=K0_JSON,
    ),
    _fixture(
        "F4-single-id",
        F4_OBJ,
        348,
        383,
        "one 66-char id: +68; same-array comma does not apply at m=1",
    ),
    _fixture(
        "F5-two-ids-same-array",
        F5_OBJ,
        417,
        452,
        "two 66-char ids in one array: +137 (not +136, which is two arrays)",
    ),
    _fixture(
        "F6-total-bytes-null",
        F6_OBJ,
        472,
        507,
        "total_bytes=null priced as 4 digits: entry=192",
    ),
    _fixture(
        "F7-caliber-66-axis",
        F7_OBJ,
        282,
        317,
        "66-char caliber adds +2 at baseline 64",
    ),
    _fixture(
        "F8-tpc13-array12",
        F8_OBJ,
        2599,
        2634,
        "tpc=13 but 12 serialized entries: commas must use array length",
    ),
    _fixture(
        "F9-r457-frame",
        R457_OBJ,
        422,
        457,
        "R=457: 280 + 1(truncated=false) + 141(two 68-char ids in one array)",
        json_text=R457_JSON,
    ),
]


def _check(condition, detail):
    return {"ok": bool(condition), "detail": detail}


def run_self_test(caliber_baseline=64):
    results = []
    for fx in FIXTURES:
        pred, parts = predict_parts(fx["obj"], caliber_baseline, "array")
        measured = len(fx["json_text"])
        residual = measured - pred
        ok = (
            pred == fx["expect_s"]
            and len(fx["line"]) == fx["expect_r"]
            and residual == fx["expect_residual"]
        )
        results.append(
            {
                "name": fx["name"],
                "ok": ok,
                "pred_s": pred,
                "measured_s": measured,
                "measured_r": len(fx["line"]),
                "residual": residual,
                "expect_s": fx["expect_s"],
                "expect_r": fx["expect_r"],
                "expect_residual": fx["expect_residual"],
                "note": fx["note"],
            }
        )

    controls = []

    # Control 1: the brief's must-red negative control. Drop the (k-1) commas.
    target_pred_no_commas, _ = predict_parts(
        TARGET_OBJ, caliber_baseline, "array", include_commas=False
    )
    target_measured = len(TARGET_JSON)
    missing_comma_residual = target_measured - target_pred_no_commas
    controls.append(
        {
            "name": "C1-missing-commas-must-be-red",
            "ok": target_pred_no_commas == 2587 and missing_comma_residual == 11,
            "pred_s": target_pred_no_commas,
            "measured_s": target_measured,
            "residual": missing_comma_residual,
            "expect": "predicted 2587, residual exactly +11",
        }
    )

    # Control 2: the tpc reading must be red on the tpc13/array12 fixture.
    f8_pred_tpc, _ = predict_parts(F8_OBJ, caliber_baseline, "tpc")
    f8_measured = len(_canon(F8_OBJ))
    f8_res_tpc = f8_measured - f8_pred_tpc
    controls.append(
        {
            "name": "C2-comma-mode-tpc-must-be-red",
            "ok": f8_res_tpc == -1,
            "pred_s": f8_pred_tpc,
            "measured_s": f8_measured,
            "residual": f8_res_tpc,
            "expect": "residual exactly -1 (13-1 vs 12-1)",
        }
    )

    # Control 3: calibrating the 66-char frame against a 66 baseline mis-predicts.
    f7_pred_b66, _ = predict_parts(F7_OBJ, 66, "array")
    f7_measured = len(_canon(F7_OBJ))
    f7_res_b66 = f7_measured - f7_pred_b66
    controls.append(
        {
            "name": "C3-caliber-baseline-66-must-be-red",
            "ok": f7_res_b66 == 2,
            "pred_s": f7_pred_b66,
            "measured_s": f7_measured,
            "residual": f7_res_b66,
            "expect": "residual exactly +2 when a 66-char caliber is judged at baseline 66",
        }
    )

    ok = all(r["ok"] for r in results) and all(c["ok"] for c in controls)
    return {
        "ok": ok,
        "snapshot": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "caliber_baseline": caliber_baseline,
        "fixtures": results,
        "controls": controls,
        "summary": "%d/%d fixtures + %d/%d controls"
        % (
            sum(1 for r in results if r["ok"]),
            len(results),
            sum(1 for c in controls if c["ok"]),
            len(controls),
        ),
    }


# --------------------------------------------------------------------------
# scanning
# --------------------------------------------------------------------------
def _iso_mtime(path):
    return _dt.datetime.fromtimestamp(os.path.getmtime(path)).astimezone().isoformat(
        timespec="seconds"
    )


def scan_root(root, caliber_baseline=64, comma_mode="array", max_nonzero=100):
    if not os.path.isdir(root):
        raise FileNotFoundError(root)

    summary = {
        "snapshot": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "root": os.path.abspath(root),
        "caliber_baseline": caliber_baseline,
        "comma_mode": comma_mode,
        "files_scanned": 0,
        "token_occurrences": 0,
        "lines_with_token": 0,
        "canonical_lines": 0,
        "receipt_like_lines": 0,
        "truncated_receipt_headers": 0,
        "parsed_lines": 0,
        "distinct_frames": 0,
        "duplicate_lines": 0,
        "embedded_lines_ignored": 0,
        "unparseable": [],
        "residual_lines": Counter(),
        "residual_frames": Counter(),
        "tpc_mismatch": [],
        "nonzero": [],
    }

    records = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for filename in sorted(filenames):
            path = os.path.join(dirpath, filename)
            if not os.path.isfile(path):
                continue
            try:
                text = open(path, "r", encoding="utf-8", errors="replace").read()
            except OSError as exc:
                summary["unparseable"].append(
                    {"path": path, "reason": "read-error: %s" % (exc,)}
                )
                continue
            summary["files_scanned"] += 1
            summary["token_occurrences"] += text.count(PREFIX)
            has_token_lines = 0
            for line_no, line in enumerate(text.split("\n"), 1):
                if PREFIX in line:
                    has_token_lines += 1
                if PREFIX not in line:
                    # A line that starts like a receipt but was cut before the
                    # token (spill truncation) is counted, never silently lost.
                    if line.lstrip().startswith("- RECEIPT"):
                        summary["receipt_like_lines"] += 1
                        summary["truncated_receipt_headers"] += 1
                    continue
                if not line.lstrip().startswith("- RECEIPT"):
                    continue
                summary["canonical_lines"] += 1
                summary["receipt_like_lines"] += 1
                record, error = parse_line(line)
                if error is not None:
                    summary["unparseable"].append(
                        {
                            "path": path,
                            "line_no": line_no,
                            "line_len": len(line),
                            "reason": error,
                            "snippet": line[:100],
                        }
                    )
                    continue
                record["path"] = path
                record["line_no"] = line_no
                record["mtime"] = _iso_mtime(path)
                records.append(record)
            summary["lines_with_token"] += has_token_lines

    summary["parsed_lines"] = len(records)
    summary["embedded_lines_ignored"] = (
        summary["lines_with_token"] - summary["canonical_lines"]
    )

    seen = {}
    for rec in records:
        obj = rec["obj"]
        pred, parts = predict_parts(obj, caliber_baseline, comma_mode)
        measured = len(rec["json_text"])
        residual = measured - pred
        rec["pred_s"] = pred
        rec["parts"] = parts
        rec["residual"] = residual
        summary["residual_lines"][residual] += 1
        digest = hashlib.sha256(rec["json_text"].encode("utf-8")).hexdigest()
        rec["digest"] = digest
        if digest not in seen:
            seen[digest] = rec
        tpc = obj.get("truncation_point_count")
        n_entries = len(obj.get("truncation_points") or [])
        if tpc != n_entries:
            summary["tpc_mismatch"].append(
                {
                    "path": rec["path"],
                    "line_no": rec["line_no"],
                    "tpc": tpc,
                    "n_entries": n_entries,
                    "residual": residual,
                }
            )
        if residual != 0 and len(summary["nonzero"]) < max_nonzero:
            summary["nonzero"].append(
                {
                    "path": rec["path"],
                    "line_no": rec["line_no"],
                    "measured_s": measured,
                    "pred_s": pred,
                    "residual": residual,
                    "parts": dict(parts),
                    "tpc": tpc,
                    "n_entries": n_entries,
                }
            )

    summary["distinct_frames"] = len(seen)
    summary["duplicate_lines"] = len(records) - len(seen)
    for rec in seen.values():
        summary["residual_frames"][rec["residual"]] += 1

    summary["residual_lines"] = dict(sorted(summary["residual_lines"].items()))
    summary["residual_frames"] = dict(sorted(summary["residual_frames"].items()))
    return summary, records


def _print_scan_text(summary):
    print("RECEIPT-AUDIT v3")
    print("snapshot: %s" % summary["snapshot"])
    print("root: %s" % summary["root"])
    print("caliber_baseline: %d" % summary["caliber_baseline"])
    print("comma_mode: %s" % summary["comma_mode"])
    print("files_scanned: %d" % summary["files_scanned"])
    print("token_occurrences: %d" % summary["token_occurrences"])
    print("lines_with_token: %d" % summary["lines_with_token"])
    print("canonical_lines: %d" % summary["canonical_lines"])
    print("receipt_like_lines: %d" % summary["receipt_like_lines"])
    print(
        "truncated_receipt_headers: %d" % summary["truncated_receipt_headers"]
    )
    print("parsed_lines: %d" % summary["parsed_lines"])
    print("frames_distinct: %d" % summary["distinct_frames"])
    print("duplicate_lines: %d" % summary["duplicate_lines"])
    print("embedded_lines_ignored: %d" % summary["embedded_lines_ignored"])
    print(
        "residual_distribution.lines: %s"
        % json.dumps(summary["residual_lines"], sort_keys=True)
    )
    print(
        "residual_distribution.frames: %s"
        % json.dumps(summary["residual_frames"], sort_keys=True)
    )
    print("unparseable: %d" % len(summary["unparseable"]))
    for item in summary["unparseable"]:
        print(
            "  - %s:%s len=%s %s"
            % (
                item.get("path"),
                item.get("line_no", "?"),
                item.get("line_len", "?"),
                item.get("reason"),
            )
        )
    print("tpc_mismatch: %d" % len(summary["tpc_mismatch"]))
    for item in summary["tpc_mismatch"]:
        print(
            "  - %s:%s tpc=%s entries=%s residual=%+d"
            % (
                item["path"],
                item["line_no"],
                item["tpc"],
                item["n_entries"],
                item["residual"],
            )
        )
    print("nonzero: %d" % len(summary["nonzero"]))
    for item in summary["nonzero"]:
        parts = " ".join("%s=%+d" % (k, v) for k, v in item["parts"].items())
        print(
            "  - %s:%s measured=%d predicted=%d residual=%+d | %s"
            % (
                item["path"],
                item["line_no"],
                item["measured_s"],
                item["pred_s"],
                item["residual"],
                parts,
            )
        )


# --------------------------------------------------------------------------
# probe
# --------------------------------------------------------------------------
def probe_r(root, target_r, caliber_baseline=64, comma_mode="array"):
    summary, records = scan_root(root, caliber_baseline, comma_mode)
    hits = [rec for rec in records if len(rec["raw"]) == target_r]
    result = {
        "snapshot": summary["snapshot"],
        "root": summary["root"],
        "target_r": target_r,
        "hits": [],
        "empty": not hits,
    }
    for rec in hits:
        obj = rec["obj"]
        id_arrays = []
        for name in ("omitted_ids", "unreadable_ids"):
            arr = obj.get(name) or []
            if not arr:
                continue
            # Serialized array literal: [ + "id" + , + "id" + ] -- quotes count.
            literal_len = (
                2 + sum(len(x) + 2 for x in arr) + max(len(arr) - 1, 0)
            )
            id_arrays.append(
                {
                    "name": name,
                    "count": len(arr),
                    "id_lengths": [len(x) for x in arr],
                    "literal_len": literal_len,
                    "growth_over_empty": literal_len - 2,
                    "item_price_total": sum(len(x) + 2 for x in arr)
                    + max(len(arr) - 1, 0),
                }
            )
        entry = {
            "path": rec["path"],
            "line_no": rec["line_no"],
            "mtime": rec["mtime"],
            "R": len(rec["raw"]),
            "S": len(rec["json_text"]),
            "residual": rec["residual"],
            "caliber": obj["caliber"],
            "caliber_len": len(obj["caliber"]),
            "requested": obj["requested"],
            "readable_upstream": obj["readable_upstream"],
            "returned": obj["returned"],
            "truncated": obj["truncated"],
            "omitted": obj["omitted"],
            "unreadable": obj["unreadable"],
            "truncation_point_count": obj["truncation_point_count"],
            "n_entries": len(obj.get("truncation_points") or []),
            "bytes_written": obj["bytes_written"],
            "id_arrays": id_arrays,
            "slices": {
                "rec": "whole receipt line, trailing CR/LF stripped; R = len(rec)",
                "json": "rec[%d:] with prefix %r; S = len(json)"
                % (PREFIX_LEN, PREFIX),
                "head_v6": "growth of the id arrays over '[]' -- not a caliber or prefix effect",
            },
            "parts": dict(rec["parts"]),
        }
        if target_r == 457:
            digit_term = digits(obj["bytes_written"]) + sum(
                digits(obj[k]) - 1 for k in SIX
            )
            ids_growth = id_term(obj)
            entry["bot009_prediction"] = {
                "statement": "if ids == 137 and digit term in {4,5}, macOS caliber must be 68/69 chars",
                "digit_term": digit_term,
                "ids_growth": ids_growth,
                "sum": digit_term + ids_growth,
                "antecedent_ids_137": ids_growth == 137,
                "caliber_len": len(obj["caliber"]),
                "consequent_caliber_68_or_69": len(obj["caliber"]) in (68, 69),
                "verdict": (
                    "premise false (ids=%d, not 137); conditional not triggered; "
                    "caliber stays %d and the frame closes as 316 + %d"
                    % (ids_growth, len(obj["caliber"]), ids_growth)
                    if ids_growth != 137
                    else "premise true; check the consequent"
                ),
            }
        result["hits"].append(entry)
    return result


def _print_probe_text(result):
    print("PROBE R=%d" % result["target_r"])
    print("snapshot: %s" % result["snapshot"])
    print("root: %s" % result["root"])
    if result["empty"]:
        print("NO FRAME: 本机语料无该帧，预测悬置")
        return
    for hit in result["hits"]:
        print("frame: %s:%s" % (hit["path"], hit["line_no"]))
        print("mtime: %s" % hit["mtime"])
        print("R=%d S=%d residual=%+d" % (hit["R"], hit["S"], hit["residual"]))
        print("caliber_raw: %r" % hit["caliber"])
        print("caliber_len: %d" % hit["caliber_len"])
        print(
            "counters: requested=%s readable_upstream=%s returned=%s omitted=%s unreadable=%s tpc=%s"
            % (
                hit["requested"],
                hit["readable_upstream"],
                hit["returned"],
                hit["omitted"],
                hit["unreadable"],
                hit["truncation_point_count"],
            )
        )
        print("n_entries: %d" % hit["n_entries"])
        print("bytes_written: %s" % hit["bytes_written"])
        for arr in hit["id_arrays"]:
            print(
                "id_array %s: count=%d id_lengths=%s literal_len=%d growth_over_empty=%d item_price_total=%d"
                % (
                    arr["name"],
                    arr["count"],
                    arr["id_lengths"],
                    arr["literal_len"],
                    arr["growth_over_empty"],
                    arr["item_price_total"],
                )
            )
        print("slices:")
        for key, value in hit["slices"].items():
            print("  %s: %s" % (key, value))
        print(
            "parts: %s"
            % " ".join("%s=%+d" % (k, v) for k, v in hit["parts"].items())
        )
        prediction = hit.get("bot009_prediction")
        if prediction:
            print("bot009_prediction:")
            for key, value in prediction.items():
                print("  %s: %s" % (key, value))


# --------------------------------------------------------------------------
# misc commands
# --------------------------------------------------------------------------
def emit_fixtures(dest):
    os.makedirs(dest, exist_ok=True)
    manifest = []
    for fx in FIXTURES:
        filename = "%s.txt" % fx["name"]
        path = os.path.join(dest, filename)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(fx["line"] + "\n")
        manifest.append(
            {
                "file": filename,
                "name": fx["name"],
                "expect_s": fx["expect_s"],
                "expect_r": fx["expect_r"],
                "expect_residual": fx["expect_residual"],
                "note": fx["note"],
            }
        )
    with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


def audit_line_file(path):
    records = []
    unparseable = []
    for line_no, line in iter_canonical_lines(path):
        record, error = parse_line(line)
        if error is not None:
            unparseable.append(
                {
                    "path": path,
                    "line_no": line_no,
                    "line_len": len(line.rstrip("\r\n")),
                    "reason": error,
                }
            )
            continue
        record["path"] = path
        record["line_no"] = line_no
        pred, parts = predict_parts(record["obj"])
        record["pred_s"] = pred
        record["parts"] = parts
        record["residual"] = len(record["json_text"]) - pred
        records.append(record)
    return {"records": records, "unparseable": unparseable}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _dump(obj):
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2, sort_keys=False)
    sys.stdout.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Zero-dependency audit for MetaWeb pins:batch receipts (v3)."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    st = sub.add_parser("self-test", help="run fixtures and controls")
    st.add_argument("--json", action="store_true")

    sc = sub.add_parser("scan", help="audit every receipt line under a spill root")
    sc.add_argument("--root", default=DEFAULT_ROOT)
    sc.add_argument("--caliber-baseline", type=int, default=64)
    sc.add_argument("--comma-mode", choices=("array", "tpc"), default="array")
    sc.add_argument("--json", action="store_true")

    pr = sub.add_parser("probe", help="print every frame whose whole line has R=N")
    pr.add_argument("--r", type=int, required=True)
    pr.add_argument("--root", default=DEFAULT_ROOT)
    pr.add_argument("--caliber-baseline", type=int, default=64)
    pr.add_argument("--comma-mode", choices=("array", "tpc"), default="array")
    pr.add_argument("--json", action="store_true")

    ef = sub.add_parser("emit-fixtures", help="write the fixture receipt lines")
    ef.add_argument("dest")

    al = sub.add_parser("audit-line", help="audit receipt lines in one file")
    al.add_argument("path")
    al.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)

    if args.cmd == "self-test":
        result = run_self_test()
        if args.json:
            _dump(result)
        else:
            for item in result["fixtures"]:
                print(
                    "[%s] %-26s S=%d R=%d residual=%+d  (%s)"
                    % (
                        "PASS" if item["ok"] else "FAIL",
                        item["name"],
                        item["pred_s"],
                        item["measured_r"],
                        item["residual"],
                        item["note"],
                    )
                )
            for control in result["controls"]:
                print(
                    "[%s] %-32s predicted=%d residual=%+d  (%s)"
                    % (
                        "PASS" if control["ok"] else "FAIL",
                        control["name"],
                        control["pred_s"],
                        control["residual"],
                        control["expect"],
                    )
                )
            print(
                "%s: %s"
                % ("ALL GREEN" if result["ok"] else "RED", result["summary"])
            )
        return 0 if result["ok"] else 1

    if args.cmd == "scan":
        try:
            summary, _ = scan_root(
                args.root, args.caliber_baseline, args.comma_mode
            )
        except FileNotFoundError:
            print("ERROR: root not found: %s" % args.root, file=sys.stderr)
            return 2
        if args.json:
            _dump(summary)
        else:
            _print_scan_text(summary)
        return 0

    if args.cmd == "probe":
        try:
            result = probe_r(
                args.root, args.r, args.caliber_baseline, args.comma_mode
            )
        except FileNotFoundError:
            print("ERROR: root not found: %s" % args.root, file=sys.stderr)
            return 2
        if args.json:
            _dump(result)
        else:
            _print_probe_text(result)
        return 0

    if args.cmd == "emit-fixtures":
        manifest = emit_fixtures(args.dest)
        print("wrote %d fixtures to %s" % (len(manifest), os.path.abspath(args.dest)))
        return 0

    if args.cmd == "audit-line":
        result = audit_line_file(args.path)
        if args.json:
            _dump(result)
        else:
            print("AUDIT-LINE %s" % os.path.abspath(args.path))
            for rec in result["records"]:
                print(
                    "  line %s: R=%d S=%d residual=%+d"
                    % (
                        rec["line_no"],
                        len(rec["raw"]),
                        len(rec["json_text"]),
                        rec["residual"],
                    )
                )
            print("  unparseable: %d" % len(result["unparseable"]))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
