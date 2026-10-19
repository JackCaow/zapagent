"""Regression coverage for Terminal-Bench adapter outcome semantics."""

from __future__ import annotations

import asyncio
import json
import shlex
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from evals.terminal_bench.zap_agent import (
    ZapAgent, INDEPENDENT_EVALUATION_INSTRUCTION, _evaluation_integrity_audit, _result_source_policy_audit,
)


class _Environment:
    def __init__(self, result: SimpleNamespace) -> None:
        self.result = result
        self.calls: list[dict[str, object]] = []

    async def exec(self, **kwargs: object) -> SimpleNamespace:
        self.calls.append(dict(kwargs))
        return self.result


def _agent() -> ZapAgent:
    agent = object.__new__(ZapAgent)
    agent.result_schema = "legacy"
    agent.max_turns = 40
    agent.outer_timeout_sec = 900
    agent.finalize_reserve_sec = 60
    return agent


class ZapAgentOutcomeTests(unittest.TestCase):
    def test_soft_stop_remains_gradeable_and_records_metadata(self) -> None:
        final = {
            "type": "result",
            "text": "done", "sessionId": "thread",
            "ok": False,
            "error": "maximum step budget reached",
            "stopReason": "max_steps",
            "turns": 40,
            "toolCalls": [{"name": "bash"}],
            "usage": {
                "inputTokens": 10,
                "cacheReadInputTokens": 90,
                "cacheCreationInputTokens": 5,
                "outputTokens": 12,
            },
        }
        environment = _Environment(
            SimpleNamespace(return_code=0, stdout=json.dumps(final), stderr="")
        )
        context = SimpleNamespace(
            n_input_tokens=None,
            n_cache_tokens=None,
            n_output_tokens=None,
            metadata=None,
        )

        asyncio.run(_agent().run("solve the task", environment, context))

        self.assertEqual(context.n_input_tokens, 105)
        self.assertEqual(context.n_cache_tokens, 90)
        self.assertEqual(context.n_output_tokens, 12)
        self.assertEqual(context.metadata["stopReason"], "max_steps")
        self.assertFalse(context.metadata["agentOk"])
        self.assertEqual(context.metadata["agentError"], "maximum step budget reached")
        command = str(environment.calls[0]["command"])
        args = shlex.split(command)
        self.assertEqual(args[args.index("--system-prompt-append") + 1], INDEPENDENT_EVALUATION_INSTRUCTION)
        self.assertIn("--timeout-ms 840000", command)
        self.assertEqual(environment.calls[0]["env"]["ZAPCODE_DISABLE_BACKGROUND_TASKS"], "0")
        self.assertEqual(context.metadata["evaluationIntegrity"]["status"], "not_detected_review_required")

    def test_rejects_a_finalize_reserve_that_consumes_the_outer_deadline(self) -> None:
        with TemporaryDirectory() as logs_dir, self.assertRaisesRegex(
            ValueError, "smaller than outer_timeout_sec"
        ):
            ZapAgent(
                logs_dir=Path(logs_dir),
                binary_path=__file__,
                config_path=__file__,
                outer_timeout_sec=60,
                finalize_reserve_sec=60,
            )

    def test_legacy_binary_detection_is_read_only_and_does_not_rerun_model(self):
        for help_text, supported in [("headless --print", False), ("headless --result-schema", True)]:
            agent = _agent()
            environment = _Environment(SimpleNamespace(return_code=0, stdout=help_text, stderr=""))
            asyncio.run(agent._probe_legacy_binary(environment))
            self.assertEqual(agent._supports_result_schema, supported)
            self.assertEqual(len(environment.calls), 1)
            self.assertIn("--help-headless", str(environment.calls[0]["command"]))

    def test_transport_failure_is_still_an_adapter_failure(self) -> None:
        final = {"type": "result", "ok": False, "text": "", "sessionId": "thread", "turns": 1, "usage": {"inputTokens": 0, "outputTokens": 0}, "toolCalls": [], "stopReason": "permission_denied"}
        environment = _Environment(
            SimpleNamespace(return_code=4, stdout=json.dumps(final), stderr="permission denied")
        )
        context = SimpleNamespace(
            n_input_tokens=None,
            n_cache_tokens=None,
            n_output_tokens=None,
            metadata=None,
        )

        with self.assertRaisesRegex(RuntimeError, "Zap exited with code 4"):
            asyncio.run(_agent().run("solve the task", environment, context))


class OutcomeV1ValidationTests(unittest.TestCase):
    @staticmethod
    def final(status="finished", reason="end_turn"):
        return {"type": "result", "schema": "zap.outcome", "schemaVersion": 1,
                "threadId": "thread", "sessionId": "thread", "turnId": "turn", "runId": "run", "attemptId": "run",
                "startedAt": 1, "endedAt": 2, "turns": 1, "usage": {"inputTokens": 0, "outputTokens": 0}, "toolCalls": [],
                "ok": status == "finished", "text": "done", "stopReason": reason,
                "execution": {"attemptId": "run", "status": status, "stopReason": reason, "finalResponse": "done", "unresolvedActions": []},
                "acceptance": {"attemptId": "run", "status": "unverified", "code": "NO_ACCEPTANCE_SPEC", "checks": []},
                "workflow": {"attemptId": "run", "status": "not_requested", "controlRevision": 0, "code": "WORKFLOW_NOT_CONFIGURED"}}

    def test_background_receipts_remain_gradeable_and_are_validated(self):
        for disposition in ("stopped", "host_owned"):
            final = self.final()
            final["execution"]["backgroundTasks"] = [{"taskId": "task-1", "disposition": disposition}]
            self.run_final(final)
        final = self.final()
        final["execution"]["backgroundTasks"] = [{"taskId": "task-1", "disposition": "forgotten"}]
        with self.assertRaisesRegex(RuntimeError, "background task"):
            self.run_final(final)

    def run_final(self, final, code=0, duplicate=False):
        agent = _agent()
        agent.result_schema = "outcome-v1"
        output = json.dumps(final)
        environment = _Environment(SimpleNamespace(return_code=code, stdout=output + ("\n" + output if duplicate else ""), stderr=""))
        context = SimpleNamespace(n_input_tokens=None, n_cache_tokens=None, n_output_tokens=None, metadata=None)
        asyncio.run(agent.run("solve", environment, context))
        self.assertIn("--result-schema outcome-v1", str(environment.calls[0]["command"]))
        return context

    def test_finished_and_all_soft_limits_continue_verifier(self):
        for status, reason in [("finished", "end_turn")] + [("limited", reason) for reason in ["max_steps", "max_tokens", "budget", "timeout", "max_repeat"]]:
            with self.subTest(reason=reason):
                context = self.run_final(self.final(status, reason))
                self.assertEqual(context.metadata["execution"]["status"], status)
                self.assertEqual(context.metadata["processExitCode"], 0)
                self.assertEqual(context.metadata["acceptance"]["status"], "unverified")

    def test_execution_failures_and_exit_conflicts_are_rejected(self):
        for status, reason, code in [("failed", "error", 1), ("blocked", "permission_denied", 4), ("blocked", "input_required", 7), ("cancelled", "aborted", 130), ("finished", "end_turn", 1), ("limited", "budget", 1)]:
            with self.subTest(status=status, code=code), self.assertRaises(RuntimeError):
                self.run_final(self.final(status, reason), code)

    def test_duplicate_unknown_schema_and_identity_conflict_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "duplicate"):
            self.run_final(self.final(), duplicate=True)
        for key, value in [("schema", "unknown"), ("schemaVersion", 99), ("attemptId", "other"), ("sessionId", "other"), ("ok", False), ("stopReason", "error")]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.run_final({**self.final(), key: value})
        final = self.final()
        final["acceptance"]["attemptId"] = "other"
        with self.assertRaisesRegex(RuntimeError, "identity"):
            self.run_final(final)

    def test_legacy_incomplete_is_gradeable_only_with_matching_completion_and_exit(self):
        from evals.terminal_bench.zap_agent import _validate_final_result
        final = {"type": "result", "ok": False, "text": "", "sessionId": "thread", "turns": 1, "usage": {"inputTokens": 0, "outputTokens": 0}, "toolCalls": [], "stopReason": "incomplete", "completion": {"status": "incomplete"}}
        _validate_final_result(final, 1, "legacy")
        for code in [0, 4, 130]:
            with self.assertRaises(RuntimeError):
                _validate_final_result(final, code, "legacy")
        with self.assertRaises(RuntimeError):
            _validate_final_result({**final, "schema": "unknown"}, 1, "legacy")


class ModelSelectionTests(unittest.TestCase):
    def config(self, directory):
        path = Path(directory) / "owner.json"
        path.write_text(json.dumps({"active": {"providerId": "one", "model": "model-a"},
            "providers": [{"id": "one", "models": ["model-a", "model-b"], "apiKey": "fixture-one"},
                          {"id": "two", "models": ["model-c"], "apiKey": "fixture-two"}]}))
        return path

    def test_explicit_model_is_applied_without_mutating_owner_or_copying_other_credentials(self):
        from evals.terminal_bench.zap_agent import _write_minimal_eval_config
        with TemporaryDirectory() as directory:
            source = self.config(directory)
            original = source.read_bytes()
            output = _write_minimal_eval_config(source, "model-b")
            try:
                actual = json.loads(output.read_text())
                self.assertEqual(actual["active"], {"providerId": "one", "model": "model-b"})
                self.assertEqual([p["id"] for p in actual["providers"]], ["one"])
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                self.assertEqual(source.read_bytes(), original)
            finally:
                output.unlink()

    def test_profile_requires_explicit_evaluation_selection(self):
        from evals.terminal_bench.zap_agent import _write_minimal_eval_config
        with TemporaryDirectory() as directory:
            source = self.config(directory)
            owner = json.loads(source.read_text())
            owner.update(promptProfile="concise", customSystemPrompt="private instructions")
            source.write_text(json.dumps(owner))
            original = source.read_bytes()
            for selected in [None, "standard", "concise"]:
                output = _write_minimal_eval_config(source, "model-b", selected)
                try:
                    actual = json.loads(output.read_text())
                    self.assertEqual(actual.get("promptProfile"), selected)
                    self.assertNotIn("customSystemPrompt", actual)
                    self.assertEqual(len(actual["providers"]), 1)
                    self.assertEqual(actual["active"]["model"], "model-b")
                    self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(source.read_bytes(), original)
                finally:
                    output.unlink()
            with self.assertRaisesRegex(ValueError, "prompt_profile"):
                _write_minimal_eval_config(source, "model-b", "unknown")

    def test_setup_uploads_requested_model_and_removes_temporary_config(self):
        class Environment(_Environment):
            default_user = None

            async def upload_file(self, source, destination):
                if str(destination).endswith("/config.json"):
                    self.uploaded_path = Path(source)
                    self.uploaded_config = json.loads(Path(source).read_text())

        with TemporaryDirectory() as directory:
            source = self.config(directory)
            environment = Environment(SimpleNamespace(return_code=0, stdout="", stderr=""))
            agent = ZapAgent(logs_dir=Path(directory), model_name="model-b",
                             binary_path=__file__, config_path=str(source), prompt_profile="concise")
            asyncio.run(agent.setup(environment))
            self.assertEqual(environment.uploaded_config["active"]["model"], "model-b")
            self.assertEqual(environment.uploaded_config["promptProfile"], "concise")
            self.assertFalse(environment.uploaded_path.exists())
            self.assertEqual(json.loads(source.read_text())["active"]["model"], "model-a")

    def test_malformed_model_catalog_cannot_match_a_substring(self):
        from evals.terminal_bench.zap_agent import _write_minimal_eval_config
        with TemporaryDirectory() as directory:
            source = self.config(directory)
            config = json.loads(source.read_text())
            for models in ["model-a,model-b", None, {"model-b": True}]:
                config["providers"][0]["models"] = models
                source.write_text(json.dumps(config))
                with self.subTest(models=models), self.assertRaisesRegex(ValueError, "active provider"):
                    _write_minimal_eval_config(source, "model-b")

    def test_omitted_model_preserves_active_model(self):
        from evals.terminal_bench.zap_agent import _write_minimal_eval_config
        with TemporaryDirectory() as directory:
            output = _write_minimal_eval_config(self.config(directory))
            try:
                self.assertEqual(json.loads(output.read_text())["active"]["model"], "model-a")
            finally:
                output.unlink()

    def test_unknown_or_other_provider_model_is_rejected_instead_of_silent_fallback(self):
        from evals.terminal_bench.zap_agent import _write_minimal_eval_config
        with TemporaryDirectory() as directory:
            source = self.config(directory)
            for model in ["model-c", "missing", "vendor/model-b"]:
                with self.subTest(model=model), self.assertRaisesRegex(ValueError, "active provider"):
                    _write_minimal_eval_config(source, model)

    def test_empty_model_is_rejected(self):
        from evals.terminal_bench.zap_agent import _write_minimal_eval_config
        with TemporaryDirectory() as directory:
            source = self.config(directory)
            for model in ["", " "]:
                with self.subTest(model=model), self.assertRaisesRegex(ValueError, "non-empty"):
                    _write_minimal_eval_config(source, model)


class EvaluationIntegrityTests(unittest.TestCase):
    @staticmethod
    def stream(*events):
        return "\n".join(json.dumps(event) for event in events)

    def test_nested_reference_access_is_screened_with_scope(self):
        stream = self.stream(
            {"type": "tool_use", "name": "http_fetch", "id": "shared", "args": {"url": "https://docs.python.org/3/"}},
            {"type": "subagent_tool_use", "path": ["child", "grandchild"], "name": "http_fetch", "id": "shared",
             "args": {"url": "https://example.org/terminal-bench/tasks/arbitrary-task/solution"}},
            {"type": "subagent_tool_result", "path": ["child", "grandchild"], "name": "http_fetch", "id": "shared",
             "ok": True, "preview": "https://example.org/terminal-bench/tasks/arbitrary-task/solution"},
        )
        audit = _evaluation_integrity_audit(stream)
        self.assertEqual(audit["status"], "reference_source_detected")
        self.assertEqual(audit["networkToolCalls"], 2)
        self.assertEqual(len(audit["findings"]), 2)
        for finding in audit["findings"]:
            self.assertEqual(finding["path"], ["child", "grandchild"])

    def test_nested_ordinary_docs_are_not_reference_access(self):
        audit = _evaluation_integrity_audit(self.stream(
            {"type": "subagent_tool_use", "path": ["child"], "name": "http_fetch", "id": "docs",
             "args": {"url": "https://docs.python.org/3/library/asyncio.html"}},
        ))
        self.assertEqual(audit["networkToolCalls"], 1)
        self.assertEqual(audit["status"], "not_detected_review_required")

    def test_reference_fetch_blocks_grading_and_preserves_execution_metadata(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                final = OutcomeV1ValidationTests.final()
                source = "https://raw.githubusercontent.com/example/terminal-bench/main/tasks/arbitrary-task/solution/solve.sh"
                scope = {"path": ["child", "grandchild"]} if nested else {}
                prefix = "subagent_" if nested else ""
                stream = self.stream(
                    {**scope, "type": prefix + "tool_use", "name": "http_fetch", "id": "source", "args": {"url": source}},
                    {**scope, "type": prefix + "tool_result", "name": "http_fetch", "id": "source", "ok": True, "preview": "reference content omitted"},
                    final,
                )
                agent = _agent()
                agent.result_schema = "outcome-v1"
                environment = _Environment(SimpleNamespace(return_code=0, stdout=stream, stderr=""))
                context = SimpleNamespace(n_input_tokens=None, n_cache_tokens=None, n_output_tokens=None, metadata=None)
                with self.assertRaisesRegex(RuntimeError, "Evaluation integrity review required"):
                    asyncio.run(agent.run("ordinary task", environment, context))
                self.assertEqual(len(environment.calls), 1)
                self.assertEqual(context.metadata["processExitCode"], 0)
                self.assertEqual(context.metadata["execution"]["status"], "finished")
                self.assertEqual(context.metadata["evaluationIntegrity"]["status"], "reference_source_detected")

    def test_incomplete_source_evidence_blocks_grading_and_preserves_execution(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                scope = {"path": ["child", "grandchild"]} if nested else {}
                prefix = "subagent_" if nested else ""
                stream = self.stream(
                    {**scope, "type": prefix + "tool_result", "name": "web_search", "id": "source", "ok": True,
                     "preview": "ordinary docs", "sourceUrls": {"urls": [], "complete": False, "omitted": 1, "outputSha256": "a" * 64}},
                    OutcomeV1ValidationTests.final(),
                )
                agent = _agent()
                agent.result_schema = "outcome-v1"
                environment = _Environment(SimpleNamespace(return_code=0, stdout=stream, stderr=""))
                context = SimpleNamespace(n_input_tokens=None, n_cache_tokens=None, n_output_tokens=None, metadata=None)
                with self.assertRaisesRegex(RuntimeError, "Evaluation integrity evidence incomplete"):
                    asyncio.run(agent.run("ordinary task", environment, context))
                self.assertEqual(len(environment.calls), 1)
                self.assertEqual(context.metadata["processExitCode"], 0)
                self.assertEqual(context.metadata["execution"]["status"], "finished")
                self.assertEqual(context.metadata["evaluationIntegrity"]["status"], "source_audit_incomplete_review_required")

    def test_configured_source_policy_withholding_remains_gradeable_and_is_bound_to_the_selected_file(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                event = {"type": "subagent_tool_result" if nested else "tool_result", "path": ["child"] if nested else [],
                         "name": "web_search", "id": "source", "ok": False, "preview": "", "resultSourcePolicy": {
                             "version": 1, "configuredFileSha256": "a" * 64, "policyDigest": "b" * 64,
                             "decision": "withheld", "reason": "excluded_source"}}
                stream = self.stream(event, OutcomeV1ValidationTests.final())
                agent = _agent(); agent.result_schema = "outcome-v1"
                agent.result_source_policy_path = Path("selected.json")
                agent._result_source_policy_sha256 = "a" * 64
                agent._result_source_policy_tools = ["web_search"]
                environment = _Environment(SimpleNamespace(return_code=0, stdout=stream, stderr=""))
                context = SimpleNamespace(n_input_tokens=None, n_cache_tokens=None, n_output_tokens=None, metadata=None)
                asyncio.run(agent.run("ordinary task", environment, context))
                self.assertIn("--result-source-policy", environment.calls[0]["command"])
                self.assertEqual(context.metadata["preModelSourcePolicy"]["withheldResultCount"], 1)
                self.assertEqual(context.metadata["preModelSourcePolicy"]["gaps"], [])
                event["resultSourcePolicy"]["configuredFileSha256"] = "c" * 64
                environment.result.stdout = self.stream(event, OutcomeV1ValidationTests.final())
                with self.assertRaisesRegex(RuntimeError, "coverage missing or mismatched"):
                    asyncio.run(agent.run("ordinary task", environment, context))
                self.assertEqual(context.metadata["processExitCode"], 0)

    def test_missing_source_policy_observation_or_setup_never_silently_disables_policy(self):
        audit = _result_source_policy_audit(self.stream({"type": "tool_result", "name": "web_search", "id": "x", "ok": True}), "a" * 64, ["web_search"])
        self.assertEqual(len(audit["gaps"]), 1)
        agent = _agent(); agent.result_source_policy_path = Path("selected.json")
        environment = _Environment(SimpleNamespace(return_code=0, stdout="", stderr=""))
        with self.assertRaisesRegex(RuntimeError, "setup is incomplete"):
            asyncio.run(agent.run("ordinary task", environment, SimpleNamespace(metadata=None)))
        self.assertEqual(environment.calls, [])

    def test_setup_uploads_a_bound_policy_snapshot_without_copying_later_host_changes(self):
        class Environment:
            default_user = None
            def __init__(self): self.uploads = []
            async def exec(self, **kwargs):
                return SimpleNamespace(return_code=0, stdout="--result-schema --result-source-policy", stderr="")
            async def upload_file(self, source_path, target_path):
                self.uploads.append((str(target_path), Path(source_path).read_bytes()))
                if str(target_path).endswith("/source-policy.json"):
                    selected.write_text("{}")
        with TemporaryDirectory() as directory:
            root = Path(directory); binary = root / "zap"; binary.write_text("fixture")
            config = root / "config.json"
            config.write_text(json.dumps({"active": {"providerId": "p", "model": "fixture"}, "providers": [{"id": "p", "apiKey": "fixture", "models": ["fixture"]}]}))
            selected = root / "policy.json"
            body = json.dumps({"version": 1, "tools": ["web_search"], "denyUrlContains": [{"id": "restricted", "value": "/excluded-corpus/"}]}).encode()
            selected.write_bytes(body)
            agent = ZapAgent(logs_dir=root / "logs", binary_path=str(binary), config_path=str(config), result_source_policy_path=str(selected), model_name="fixture")
            environment = Environment()
            asyncio.run(agent.setup(environment))
            self.assertEqual(environment.uploads[-1][1], body)
            self.assertEqual(agent._result_source_policy_tools, ["web_search"])
            self.assertEqual(selected.read_text(), "{}")
            self.assertEqual(len(agent._result_source_policy_sha256), 64)

    def test_selected_source_policy_requires_explicit_binary_support(self):
        agent = _agent(); agent.result_schema = "outcome-v1"; agent.result_source_policy_path = Path("selected.json")
        environment = _Environment(SimpleNamespace(return_code=0, stdout="--result-schema", stderr=""))
        with self.assertRaisesRegex(RuntimeError, "supporting --result-source-policy"):
            asyncio.run(agent._probe_legacy_binary(environment))

    def test_full_result_source_evidence_catches_reference_beyond_preview(self):
        audit = _evaluation_integrity_audit(self.stream(
            {"type": "subagent_tool_result", "path": ["child", "grandchild"], "name": "web_search", "id": "source", "ok": True,
             "preview": "ordinary documentation only", "sourceUrls": {"urls": ["https://example.org/terminal-bench/arbitrary-task/trajectory.json?token=private"], "complete": True, "omitted": 0, "outputSha256": "a" * 64}},
        ))
        self.assertEqual(audit["status"], "reference_source_detected")
        self.assertEqual(audit["findings"][0]["source"], "result_source_urls")
        self.assertEqual(audit["findings"][0]["path"], ["child", "grandchild"])
        self.assertNotIn("private", json.dumps(audit))

    def test_incomplete_or_malformed_source_evidence_requires_review(self):
        for evidence in ({"urls": [], "complete": False, "omitted": 1, "outputSha256": "a" * 64},
                         {"urls": [], "complete": True, "omitted": 1, "outputSha256": "a" * 64},
                         None, {"urls": [], "complete": True, "omitted": 0, "outputSha256": "bad"},
                         {"urls": ["not-a-url"], "complete": True, "omitted": 0, "outputSha256": "a" * 64}):
            with self.subTest(evidence=evidence):
                audit = _evaluation_integrity_audit(self.stream({"type": "tool_result", "name": "web_search", "id": "source", "ok": True,
                    "preview": "ordinary docs", "sourceUrls": evidence}))
                self.assertEqual(audit["status"], "source_audit_incomplete_review_required")
                self.assertEqual(len(audit["sourceEvidenceGaps"]), 1)

    def test_search_result_exposure_is_detected_even_for_a_general_query(self):
        audit = _evaluation_integrity_audit(self.stream(
            {"type": "tool_use", "name": "web_search", "id": "search", "args": {"query": "general compiler documentation"}},
            {"type": "tool_result", "name": "web_search", "id": "search", "ok": True,
             "preview": "1. https://marginlab.ai/explorers/terminal-bench/arbitrary-task/"},
        ))
        self.assertEqual(audit["networkToolCalls"], 1)
        self.assertEqual(audit["findings"][0]["source"], "result_preview")

    def test_shell_urls_and_encoded_sources_are_screened_without_copying_secrets(self):
        audit = _evaluation_integrity_audit(self.stream(
            {"type": "tool_use", "name": "bash", "id": "shell", "args": {
                "command": "curl https://user:password@example.org/terminal%252Dbench/tasks/arbitrary-task/tests/test.py?token=private"}},
        ))
        self.assertEqual(audit["status"], "reference_source_detected")
        self.assertEqual(audit["findings"][0]["urls"], ["https://example.org/terminal-bench/tasks/arbitrary-task/tests/test.py"])
        self.assertNotIn("password", json.dumps(audit))
        self.assertNotIn("private", json.dumps(audit))

    def test_explicit_benchmark_search_requires_review_even_without_results(self):
        audit = _evaluation_integrity_audit(self.stream(
            {"type": "tool_use", "name": "web_search", "id": "search", "args": {"query": "terminal-bench arbitrary-task"}},
        ))
        self.assertEqual(audit["status"], "reference_source_detected")
        self.assertEqual(audit["findings"][0]["urls"], [])

    def test_other_builtin_url_tools_are_included_in_source_screening(self):
        for name, key in [("http_request", "url"), ("browser_screenshot", "target")]:
            with self.subTest(tool=name):
                audit = _evaluation_integrity_audit(self.stream(
                    {"type": "tool_use", "name": name, "id": "source", "args": {
                        key: "https://example.org/terminal-bench/tasks/arbitrary-task/solution"}},
                    {"type": "tool_result", "name": name, "id": "source", "ok": True,
                     "preview": "https://example.org/terminal-bench/tasks/arbitrary-task/solution"},
                ))
                self.assertEqual(audit["status"], "reference_source_detected")
                self.assertEqual(audit["networkToolCalls"], 1)
                self.assertEqual([f["source"] for f in audit["findings"]], ["tool_input", "result_preview"])

    def test_local_browser_targets_do_not_count_as_network_access(self):
        audit = _evaluation_integrity_audit(self.stream(
            {"type": "tool_use", "name": "browser_screenshot", "id": "local", "args": {
                "target": "/app/terminal-bench-notes.html"}},
        ))
        self.assertEqual(audit["networkToolCalls"], 0)
        self.assertEqual(audit["findings"], [])

    def test_ordinary_docs_dependencies_and_non_network_mentions_are_not_rejected(self):
        audit = _evaluation_integrity_audit(self.stream(
            {"type": "tool_use", "name": "http_fetch", "id": "docs", "args": {"url": "https://docs.python.org/3/library/asyncio-task.html"}},
            {"type": "tool_use", "name": "bash", "id": "dependency", "args": {"command": "curl https://github.com/astral-sh/uv/releases/download/v1/file.tar.gz"}},
            {"type": "assistant", "delta": "terminal-bench"},
            {"type": "tool_use", "name": "write_file", "id": "write", "args": {"path": "README.md", "content": "https://example.org/terminal-bench"}},
            {"type": "tool_result", "name": "read_file", "id": "read", "preview": "https://example.org/terminal-bench"},
        ))
        self.assertEqual(audit["status"], "not_detected_review_required")
        self.assertEqual(audit["findings"], [])
        self.assertIn("full trajectory review required", audit["coverage"])

    def test_malformed_rows_do_not_break_protocol_validation(self):
        audit = _evaluation_integrity_audit("bad json\n[]\nnull\n" + self.stream(
            {"type": "tool_use", "name": [], "args": {}},
            {"type": "tool_use", "name": "http_fetch", "args": None},
            {"type": "tool_result", "name": "web_search", "preview": None},
        ))
        self.assertEqual(audit["status"], "not_detected_review_required")


if __name__ == "__main__":
    unittest.main()
