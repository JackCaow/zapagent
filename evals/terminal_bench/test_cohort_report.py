import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from evals.terminal_bench.cohort_report import report_snapshot


class CohortReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = {"sourceCommit": "frozen", "denominator": 0, "jobs": []}
        self.snapshot = {"at": 10, "frozenSourceCommit": "frozen", "originals": [],
                         "summary": {"reviewedIndependentPasses": 999}}

    def write(self, name, value):
        path = self.root / name
        data = json.dumps(value).encode()
        path.write_bytes(data)
        return str(path), hashlib.sha256(data).hexdigest()

    def original(self, state="pending", reward=1, review=None):
        index = len(self.plan["jobs"])
        task, job, trial = f"task-{index}", f"job-{index}", f"trial-{index}"
        self.plan["jobs"].append({"name": job, "tasks": [task]})
        self.plan["denominator"] += 1
        row = {"job": job, "task": task, "state": state, "reviewedIndependentPass": False}
        self.snapshot["originals"].append(row)
        if state == "completed":
            row["trial"] = trial
            result = {"task_name": task, "trial_name": trial, "finished_at": "done",
                      "exception_info": None, "verifier": {"finished_at": "done"},
                      "verifier_result": {"rewards": {"reward": reward}}}
            row["result"], row["resultSha256"] = self.write(f"{index}-result.json", result)
            if review is not None:
                audit = {"trial": trial, "sourceCommit": "frozen", "officialReward": reward,
                         "officialVerifierRan": True, "independentOfficialPass": review == "pass",
                         "classification": "official_pass_source_access_reviewed" if review == "pass" else review,
                         "evidence": {"resultSha256": row["resultSha256"]}}
                if review == "official_pass_reference_exposure_ineligible":
                    audit["sourceReview"] = {"referenceExposureObserved": True,
                                             "independenceEligibility": "ineligible"}
                row["review"], row["reviewSha256"] = self.write(f"{index}-review.json", audit)
        return row

    def report(self):
        return report_snapshot(self.plan, self.snapshot, plan_sha256="plan-hash", now=20)

    def rewrite(self, row, kind, update):
        value = json.loads(Path(row[kind]).read_text())
        update(value)
        row[kind], row[kind + "Sha256"] = self.write(Path(row[kind]).name, value)

    def test_pending_review_is_distinct_from_an_official_zero(self):
        self.original("completed", 1)
        self.original("completed", 0)
        self.original("completed", None)
        self.original("pending")
        self.original("running")
        counts = self.report()["counts"]
        self.assertEqual([counts[k] for k in ["pass_review_pending", "official_zero", "ungraded", "pending", "running"]], [1]*5)
        self.assertEqual(sum(counts.values()), 5)
        self.assertEqual(counts["independent_pass"], 0)

    def test_bound_review_overrides_stale_summary_and_cached_pass_flag(self):
        self.original("completed", 1, "pass")
        report = self.report()
        self.assertEqual(report["counts"]["independent_pass"], 1)
        self.assertEqual(report["snapshotAt"], 10)
        self.assertEqual(report["generatedAt"], 20)

    def test_reference_exposed_raw_pass_stays_ineligible(self):
        self.original("completed", 1, "official_pass_reference_exposure_ineligible")
        report = self.report()
        self.assertEqual(report["counts"]["pass_ineligible"], 1)
        self.assertEqual(report["originals"][0]["rawOfficialReward"], 1)
        self.assertEqual(report["counts"]["independent_pass"], 0)

    def test_skip_requires_bound_human_authorization_and_keeps_denominator(self):
        row = self.original("skipped")
        skip = {"job": row["job"], "tasks": [row["task"]], "originalPlanSha256": "plan-hash",
                "authorization": {"source": "direct_user_instruction", "text": "skip this task"},
                "disposition": "user_requested_skip_ungraded", "modelStarted": False,
                "officialVerifierRan": False, "officialReward": None}
        row["skipRecord"], row["skipRecordSha256"] = self.write("skip.json", skip)
        self.assertEqual(self.report()["counts"]["skipped"], 1)
        self.assertEqual(self.report()["fixedDenominator"], 1)
        skip["modelStarted"] = True
        row["skipRecord"], row["skipRecordSha256"] = self.write("skip.json", skip)
        self.assertEqual(self.report()["counts"]["invalid_evidence"], 1)

    def test_changed_result_or_review_never_promotes_a_pass(self):
        for kind in ["result", "review"]:
            with self.subTest(kind=kind):
                row = self.original("completed", 1, "pass")
                Path(row[kind]).write_text("{}")
        report = self.report()
        self.assertFalse(report["evidenceValid"])
        self.assertEqual(report["counts"]["invalid_evidence"], 2)

    def test_other_trial_review_and_forged_independent_flag_are_invalid(self):
        row = self.original("completed", 1, "pass")
        self.rewrite(row, "review", lambda r: r.update(trial="another"))
        row = self.original("completed", 0, "pass")
        self.assertEqual(self.report()["counts"]["invalid_evidence"], 2)

    def test_review_cannot_promote_missing_verifier_or_reference_exposure(self):
        row = self.original("completed", 1, "pass")
        self.rewrite(row, "review", lambda r: r.update(officialVerifierRan=False))
        row = self.original("completed", 1, "pass")
        self.rewrite(row, "review", lambda r: r.update(sourceReview={"referenceExposureObserved": True}))
        self.assertEqual(self.report()["counts"]["invalid_evidence"], 2)

    def test_raw_one_with_trial_exception_or_incomplete_grading_is_not_a_pass(self):
        for change in [{"exception_info": {"type": "fixture_failure"}}, {"verifier": None}]:
            row = self.original("completed", 1, "pass")
            self.rewrite(row, "result", lambda r: r.update(change))
            self.rewrite(row, "review", lambda r: r["evidence"].update(resultSha256=row["resultSha256"]))
        report = self.report()
        self.assertEqual(report["counts"]["invalid_evidence"], 2)
        self.assertTrue(all(r["rawOfficialReward"] == 1 for r in report["originals"]))

    def test_missing_duplicate_reordered_or_foreign_originals_fail_closed(self):
        self.original()
        self.original()
        original = copy.deepcopy(self.snapshot)
        for rows in [original["originals"][:1], original["originals"]*2,
                     original["originals"][::-1]]:
            self.snapshot["originals"] = rows
            with self.assertRaises(ValueError):
                self.report()
        self.snapshot = original
        self.snapshot["frozenSourceCommit"] = "another"
        with self.assertRaises(ValueError):
            self.report()

    def test_boolean_reward_and_nonterminal_result_are_invalid(self):
        self.original("completed", True)
        row = self.original("completed", 1)
        self.rewrite(row, "result", lambda r: r.update(finished_at=None))
        self.assertEqual(self.report()["counts"]["invalid_evidence"], 2)

    def test_snapshot_time_is_required_and_never_replaced_by_generation_time(self):
        self.original()
        for value in [None, True, float("nan"), -1]:
            self.snapshot["at"] = value
            with self.assertRaises(ValueError):
                self.report()

    def test_missing_review_is_pending_and_inputs_remain_unchanged(self):
        row = self.original("completed", 1)
        before = Path(row["result"]).read_bytes()
        snapshot = copy.deepcopy(self.snapshot)
        self.assertEqual(self.report()["counts"]["pass_review_pending"], 1)
        self.assertEqual(self.snapshot, snapshot)
        self.assertEqual(Path(row["result"]).read_bytes(), before)
