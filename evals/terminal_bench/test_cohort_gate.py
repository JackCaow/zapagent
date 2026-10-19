import json
import tempfile
import unittest
from pathlib import Path

from evals.terminal_bench.cohort_gate import inspect_completed_job


class CohortGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def trial(self, task="fixture", suffix="one", **changes):
        name = f"{task}__{suffix}"
        path = self.root / name / "result.json"
        path.parent.mkdir()
        data = {"task_name": task, "trial_name": name,
                "finished_at": "2026-10-16T00:00:00Z", "exception_info": None,
                "verifier_result": {"rewards": {"reward": 1}},
                "verifier": {"finished_at": "2026-10-16T00:00:00Z"}, **changes}
        path.write_text(json.dumps(data))
        return path

    def inspect(self, tasks=None, exit_code=0):
        return inspect_completed_job(self.root, tasks or ["fixture"], exit_code)

    def test_official_failure_continues_without_reward_rewriting(self):
        path = self.trial(verifier_result={"rewards": {"reward": 0}})
        before = path.read_bytes()
        report = self.inspect()
        self.assertTrue(report["continueAllowed"])
        self.assertEqual(report["trials"][0]["officialReward"], 0)
        self.assertEqual(before, path.read_bytes())

    def test_zero_harbor_exit_does_not_hide_trial_exception(self):
        self.trial(exception_info={"exception_type": "RuntimeError"},
                   verifier=None, verifier_result=None)
        report = self.inspect()
        self.assertFalse(report["continueAllowed"])
        self.assertIn("trial_execution_exception", report["stopReasons"])
        self.assertIsNone(report["trials"][0]["officialReward"])

    def test_original_must_exist_exactly_once(self):
        self.assertFalse(self.inspect()["continueAllowed"])
        self.trial()
        self.assertFalse(self.inspect(["fixture", "missing"])["continueAllowed"])
        self.trial(suffix="replacement")
        self.assertIn("missing_or_duplicate_originals", self.inspect()["stopReasons"])

    def test_unexpected_trial_and_missing_result_stop(self):
        self.trial()
        (self.root / "other__unfinished").mkdir()
        self.assertIn("missing_or_invalid_result", self.inspect()["stopReasons"])

    def test_identity_mismatch_stops(self):
        self.trial(trial_name="different__one")
        self.assertIn("unexpected_trial_identity", self.inspect()["stopReasons"])

    def test_nonterminal_or_failed_process_stops(self):
        self.trial()
        self.assertFalse(self.inspect(exit_code=1)["continueAllowed"])
        with self.assertRaises(ValueError):
            self.inspect(exit_code=None)

    def test_incomplete_phases_and_invalid_rewards_stop(self):
        for field, value in [("finished_at", None), ("verifier", None),
                             ("verifier_result", {"rewards": {"reward": True}}),
                             ("verifier_result", {"rewards": {"reward": float("nan")}})]:
            with self.subTest(field=field, value=value):
                path = self.trial(**{field: value})
                self.assertFalse(self.inspect()["continueAllowed"])
                path.unlink()
                path.parent.rmdir()

    def test_missing_exception_status_and_malformed_results_stop(self):
        path = self.trial()
        data = json.loads(path.read_text())
        del data["exception_info"]
        path.write_text(json.dumps(data))
        self.assertFalse(self.inspect()["continueAllowed"])
        for value in ["null", "{invalid", "[]"]:
            path.write_text(value)
            self.assertFalse(self.inspect()["continueAllowed"])

    def test_all_originals_present_can_continue(self):
        self.trial()
        self.trial(task="second")
        self.assertTrue(self.inspect(["fixture", "second"])["continueAllowed"])


if __name__ == "__main__":
    unittest.main()
