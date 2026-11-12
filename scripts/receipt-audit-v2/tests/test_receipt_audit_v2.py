"""Unit tests for receipt_audit_v2.

Run either way (both are dependency-free):

    python3 -m unittest discover -s tests -v
    pytest -q
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import receipt_audit_v2 as audit  # noqa: E402

FIXTURES = ROOT / "fixtures"


def fixture_line(name):
    with open(FIXTURES / name, "r", encoding="utf-8") as handle:
        return handle.readline()


def expected():
    with open(FIXTURES / "expected.json", "r", encoding="utf-8") as handle:
        return json.load(handle)


def parsed_fixture(name):
    line = fixture_line(name)
    obj, payload, error = audit.parse_line(line)
    assert error is None, error
    return obj, payload


class DigitTests(unittest.TestCase):
    def test_digits(self):
        self.assertEqual(audit.digits(0), 1)
        self.assertEqual(audit.digits(7), 1)
        self.assertEqual(audit.digits(10), 2)
        self.assertEqual(audit.digits(18000), 5)

    def test_null_total_bytes_costs_four(self):
        point = {
            "kept_chars": 1,
            "total_chars": 2,
            "cut_at_bytes": 3,
            "total_bytes": None,
            "reason": "trimmed",
            "unit": "utf16-char",
        }
        self.assertEqual(audit.number_digits(None), 4)
        # 178 + 1+1+1+4 + 0 + 0
        self.assertEqual(audit.entry_cost(point), 185)


class IdsCostTests(unittest.TestCase):
    def test_empty_arrays_cost_nothing(self):
        self.assertEqual(audit.ids_cost(([], [])), 0)
        self.assertEqual(audit.ids_cost(([], []), per_array=False), 0)

    def test_single_array_pays_quotes_and_commas(self):
        ids = ["a" * 66, "b" * 66]
        self.assertEqual(audit.ids_cost((ids, [])), 2 * 68 + 1)

    def test_dual_arrays_pay_own_commas(self):
        omitted = ["a" * 66] * 12
        unreadable = ["b" * 66]
        per_array = audit.ids_cost((omitted, unreadable), per_array=True)
        merged = audit.ids_cost((omitted, unreadable), per_array=False)
        self.assertEqual(per_array, 12 * 68 + 11 + 68)
        self.assertEqual(merged, 13 * 68 + 12)
        self.assertEqual(merged - per_array, 1)


class ParseTests(unittest.TestCase):
    def test_parse_matching_line(self):
        obj, payload, error = audit.parse_line(fixture_line("control_k0.txt"))
        self.assertIsNone(error)
        self.assertEqual(obj["requested"], 2)
        self.assertEqual(len(payload), 281)

    def test_parse_rejects_truncated_json(self):
        line = audit.PREFIX + '{"requested":3,"readable_upstream":3'
        obj, payload, error = audit.parse_line(line)
        self.assertIsNone(obj)
        self.assertIsInstance(error, json.JSONDecodeError)

    def test_parse_rejects_wrong_prefix(self):
        with self.assertRaises(ValueError):
            audit.parse_line("- RECEIPT something_else: {}")


class LedgerTests(unittest.TestCase):
    def test_ledger_cells_sum_to_prediction(self):
        for name in [
            "control_k0.txt",
            "control_k12.txt",
            "discriminating_omitted12_unreadable1.txt",
            "caliber_len66_a.txt",
        ]:
            obj, _payload = parsed_fixture(name)
            for per_array in (True, False):
                for caliber in (True, False):
                    cells = audit.ledger(obj, per_array=per_array, caliber=caliber)
                    self.assertEqual(
                        sum(cells.values()),
                        audit.predicted_length(
                            obj, per_array=per_array, caliber=caliber
                        ),
                        msg=f"{name} per_array={per_array} caliber={caliber}",
                    )

    def test_reference_model_is_byte_exact_on_all_fixtures(self):
        for item in expected()["fixtures"]:
            obj, payload = parsed_fixture(item["file"])
            self.assertEqual(
                audit.predicted_length(obj),
                len(payload),
                msg=item["file"],
            )

    def test_k_zero_has_no_comma_term(self):
        obj, payload = parsed_fixture("control_k0.txt")
        self.assertEqual(audit.ledger(obj)["k"], 0)
        self.assertEqual(audit.predicted_length(obj), len(payload))

    def test_k_comma_term_is_max_zero(self):
        obj = {"truncated": False, "truncation_points": [], "caliber": "x" * 64,
               "requested": 0, "readable_upstream": 0, "returned": 0,
               "omitted": 0, "unreadable": 0, "truncation_point_count": 0,
               "bytes_written": 0, "omitted_ids": [], "unreadable_ids": []}
        self.assertEqual(audit.ledger(obj)["k"], 0)


class DiscriminatingFrameTests(unittest.TestCase):
    NAME = "discriminating_omitted12_unreadable1.txt"

    def test_shape(self):
        obj, _payload = parsed_fixture(self.NAME)
        self.assertEqual(len(obj["omitted_ids"]), 12)
        self.assertEqual(len(obj["unreadable_ids"]), 1)
        self.assertEqual(len(obj["truncation_points"]), 12)

    def test_per_array_closes(self):
        obj, payload = parsed_fixture(self.NAME)
        self.assertEqual(audit.residual(obj, len(payload), per_array=True), 0)

    def test_merged_array_is_minus_one(self):
        obj, payload = parsed_fixture(self.NAME)
        self.assertEqual(audit.residual(obj, len(payload), per_array=False), -1)

    def test_decomposition_lands_in_ids_cell(self):
        obj, payload = parsed_fixture(self.NAME)
        cells = audit.decompose(obj, len(payload), per_array=False, caliber=True)
        self.assertEqual(cells["residual"], -1)
        self.assertEqual(cells["ids"], -1)
        self.assertEqual(cells["entry"], 0)
        self.assertEqual(cells["caliber"], 0)
        self.assertEqual(cells["counts"], 0)
        self.assertEqual(cells["unexplained"], 0)


class CaliberFrameTests(unittest.TestCase):
    NAMES = [f"caliber_len66_{suffix}.txt" for suffix in "abcd"]

    def test_all_four_have_len66(self):
        for name in self.NAMES:
            obj, _payload = parsed_fixture(name)
            self.assertEqual(len(obj["caliber"]), 66)
            self.assertEqual(obj["caliber"].count("8000 runes"), 1)

    def test_zero_with_caliber_term(self):
        for name in self.NAMES:
            obj, payload = parsed_fixture(name)
            self.assertEqual(audit.residual(obj, len(payload), caliber=True), 0)

    def test_plus_two_without_caliber_term(self):
        for name in self.NAMES:
            obj, payload = parsed_fixture(name)
            self.assertEqual(audit.residual(obj, len(payload), caliber=False), 2)

    def test_decomposition_lands_in_caliber_cell(self):
        obj, payload = parsed_fixture(self.NAMES[0])
        cells = audit.decompose(obj, len(payload), per_array=True, caliber=False)
        self.assertEqual(cells["residual"], 2)
        self.assertEqual(cells["caliber"], -2)
        self.assertEqual(cells["ids"], 0)
        self.assertEqual(cells["unexplained"], 0)


class GroupTests(unittest.TestCase):
    def test_k_buckets(self):
        self.assertEqual(audit.k_bucket(0), "0")
        self.assertEqual(audit.k_bucket(1), "1-3")
        self.assertEqual(audit.k_bucket(3), "1-3")
        self.assertEqual(audit.k_bucket(4), "4-6")
        self.assertEqual(audit.k_bucket(6), "4-6")
        self.assertEqual(audit.k_bucket(7), "7-9")
        self.assertEqual(audit.k_bucket(9), "7-9")
        self.assertEqual(audit.k_bucket(10), "10-12")
        self.assertEqual(audit.k_bucket(12), "10-12")
        self.assertEqual(audit.k_bucket(13), "13+")
        self.assertEqual(audit.k_bucket(99), "13+")


class FixtureContractTests(unittest.TestCase):
    def test_expected_json_covers_seven_fixtures(self):
        data = expected()
        self.assertEqual(len(data["fixtures"]), 7)
        for item in data["fixtures"]:
            self.assertTrue((FIXTURES / item["file"]).is_file())
            self.assertTrue(item["source"])
            self.assertEqual(
                set(item["expected_residual"]),
                {name for name, _, _ in audit.VARIANTS},
            )

    def test_fixture_check_passes_all(self):
        result = audit.fixture_check(str(FIXTURES))
        self.assertEqual(result["passed"], result["total"])
        self.assertEqual(result["total"], 7)

    def test_count_digits_match_expected(self):
        for item in expected()["fixtures"]:
            obj, _payload = parsed_fixture(item["file"])
            self.assertEqual(audit.count_digits(obj), item["count_digits"])


class ScanTests(unittest.TestCase):
    def test_as_of_cutoff_excludes_future_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "receipt.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(fixture_line("control_k0.txt"))
            future = time.time() + 3600
            os.utime(path, (future, future))
            before = audit.scan(tmp, as_of=time.time())
            after = audit.scan(tmp, as_of=future + 60)
            self.assertEqual(before["parsed"], 0)
            self.assertEqual(after["parsed"], 1)
            self.assertEqual(after["variants"]["per_array_caliber"]["zero"], 1)

    @unittest.skipUnless(
        os.path.isdir(audit.DEFAULT_SPILL), "local spill corpus not present"
    )
    def test_live_corpus_closes_under_reference_caliber(self):
        report = audit.scan(audit.DEFAULT_SPILL, max_examples=1)
        self.assertGreater(report["parsed"], 0)
        reference = report["variants"]["per_array_caliber"]
        self.assertEqual(reference["zero"], reference["total"])
        self.assertEqual(reference["residual_sum"], 0)
        self.assertEqual(
            report["receipt_lines"], report["parsed"] + report["parse_failed"]
        )
        self.assertEqual(
            report["batch_frames"] + report["single_frames"], report["parsed"]
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
