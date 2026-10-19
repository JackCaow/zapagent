import unittest
from evals.terminal_bench.artifact_scope import plan_file_captures


def pair(path=(), call_id="same-id", filename="shared.txt", ok=True):
    prefix = "subagent_" if path else ""
    scope = {"path": list(path)} if path else {}
    return [{"type": prefix + "tool_use", "id": call_id, "name": "write_file", "args": {"path": filename}, **scope},
            {"type": prefix + "tool_result", "id": call_id, "name": "write_file", "ok": ok, **scope}]


class ArtifactScopeTests(unittest.TestCase):
    def test_same_id_and_basename_in_different_agents_never_collapse(self):
        events = pair() + pair(("child",)) + pair(("child", "nested"))
        rows = plan_file_captures(events, root_workspace="/app", workspaces={
            ("child",): "/private/child", ("child", "nested"): "/private/nested"})
        self.assertEqual([r["candidatePath"] for r in rows], ["/app/shared.txt", "/private/child/shared.txt", "/private/nested/shared.txt"])
        self.assertEqual([r["agentPath"] for r in rows], [[], ["child"], ["child", "nested"]])

    def test_unknown_child_workspace_never_falls_back_even_for_absolute_path(self):
        rows = plan_file_captures(pair() + pair(("child",)) + pair(("other",), filename="/app/shared.txt"), root_workspace="/app")
        self.assertEqual([r["status"] for r in rows], ["capture_candidate", "workspace_unproven", "workspace_unproven"])
        self.assertNotIn("candidatePath", rows[1])
        self.assertNotIn("candidatePath", rows[2])

    def test_success_from_other_scope_cannot_settle_a_failed_or_pending_call(self):
        events = pair(ok=False) + pair(("child",))[:-1]
        rows = plan_file_captures(events, root_workspace="/app")
        self.assertEqual([r["status"] for r in rows], ["unsuccessful_call", "unsettled_call"])

    def test_duplicate_calls_or_results_are_ambiguous(self):
        for events in [pair() + pair(filename="other.txt"), pair() + pair()[-1:]]:
            rows = plan_file_captures(events, root_workspace="/app")
            self.assertTrue(all(r["status"] == "ambiguous_tool_identity" for r in rows))

    def test_results_must_follow_the_matching_named_call(self):
        events = pair(); events[-1]["name"] = "edit_file"
        self.assertEqual(plan_file_captures(events, root_workspace="/app")[0]["status"], "mismatched_result")
        events = pair()[::-1]
        self.assertEqual(plan_file_captures(events, root_workspace="/app")[0]["status"], "mismatched_result")

    def test_paths_are_lexically_bounded_to_the_observed_workspace(self):
        for filename in ["../secret", "/app-other/file", "/app/../secret", "/app"]:
            self.assertEqual(plan_file_captures(pair(filename=filename), root_workspace="/app")[0]["status"], "outside_workspace_skipped")
        row = plan_file_captures(pair(filename="sub/../file"), root_workspace="/app/")[0]
        self.assertEqual(row["candidatePath"], "/app/file")
        self.assertNotIn("resolvedPath", row)

    def test_invalid_nested_scope_is_never_treated_as_a_root_call(self):
        for path in [None, "child", [], [1], [""]]:
            events = pair(("child",)); events[0]["path"] = path
            self.assertEqual(plan_file_captures(events, root_workspace="/app")[0]["status"], "invalid_call_identity")

    def test_bad_bindings_fail_and_bad_paths_do_not_become_candidates(self):
        for root in [None, "relative", "/app\0"]:
            with self.assertRaises(ValueError): plan_file_captures([], root_workspace=root)
        for workspaces in [{(): "/app"}, {"child": "/app"}, {("child",): "relative"}]:
            with self.assertRaises(ValueError): plan_file_captures([], root_workspace="/app", workspaces=workspaces)
        for filename in [None, "", "/app/\0"]:
            self.assertEqual(plan_file_captures(pair(filename=filename), root_workspace="/app")[0]["status"], "invalid_requested_path")

    def test_only_explicit_true_and_file_tools_qualify(self):
        events = pair(ok=1)
        self.assertEqual(plan_file_captures(events, root_workspace="/app")[0]["status"], "unsuccessful_call")
        events = pair(); events[0]["name"] = "bash"
        self.assertEqual(plan_file_captures(events, root_workspace="/app"), [])


if __name__ == "__main__": unittest.main()
