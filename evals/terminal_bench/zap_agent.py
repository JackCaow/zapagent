"""Harbor agent adapter for the current Zap checkout.

The adapter uploads a cross-compiled Zap executable and an existing owner-only
Zap configuration into the disposable task container. Harbor's Docker
environment is the OS isolation boundary so benchmark tasks can install their
declared build/runtime dependencies inside that container.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shlex
import tempfile
from urllib.parse import unquote, urlsplit, urlunsplit
from pathlib import Path
from typing import Any, override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


REMOTE_BINARY = "/usr/local/bin/zap"
REMOTE_DATA_DIR = "/tmp/zapcode"
REMOTE_CONFIG = f"{REMOTE_DATA_DIR}/config.json"
REMOTE_STDOUT = "/logs/agent/zap-stream.jsonl"
REMOTE_STDERR = "/logs/agent/zap-stderr.log"
DEFAULT_OUTER_TIMEOUT_SEC = 900
DEFAULT_FINALIZE_RESERVE_SEC = 60
INDEPENDENT_EVALUATION_INSTRUCTION = (
    "Solve the task independently using its instructions, provided files, and ordinary "
    "documentation or dependencies. Do not seek, retrieve, or use benchmark reference "
    "solutions, answer keys, hidden tests, evaluator internals, or other agents' "
    "task-specific solution traces. Do not search for the benchmark task or browse "
    "benchmark task repositories or result explorers. General technical research is allowed."
)


def _source_url_value_valid(value: str) -> bool:
    try:
        parts = urlsplit(value)
        return parts.scheme.lower() in ("http", "https") and bool(parts.hostname)
    except (ValueError, UnicodeError):
        return False


def _evaluation_integrity_audit(stdout: str) -> dict[str, Any]:
    """Host source-access screen; absence of a match is never clean attestation.

    New formatters enumerate bounded URLs from full network results; older
    streams expose only previews. Mirrors/redirects still require trajectory review.
    """
    findings: list[dict[str, Any]] = []
    gaps: list[dict[str, Any]] = []
    network_calls = 0
    enumeration = {"resultsWithEvidence": 0, "resultsWithoutEvidence": 0}
    marker = re.compile(r"terminal[-_]bench|(?:^|[/.])t-bench(?:[/.]|$)", re.I)
    url_pattern = re.compile(r"https?://[^\s<>\"']+", re.I)
    input_fields = {"web_search": "query", "http_fetch": "url", "http_request": "url",
                    "browser_screenshot": "target", "bash": "command"}
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or not isinstance(event.get("name"), str):
            continue
        name, event_type = event["name"], event.get("type")
        sources = []
        scope = {}
        if event_type in ("subagent_tool_use", "subagent_tool_result"):
            path = event.get("path")
            scope["path"] = [item[:256] for item in path[:32] if isinstance(item, str)] if isinstance(path, list) else []
        if event_type in ("tool_use", "subagent_tool_use") and name in input_fields:
            args = event.get("args")
            value = args.get(input_fields[name]) if isinstance(args, dict) else None
            if not isinstance(value, str):
                continue
            if name != "bash" and (name != "browser_screenshot" or url_pattern.match(value.strip())):
                network_calls += 1
            sources.append(("tool_input", value))
        elif event_type in ("tool_result", "subagent_tool_result") and name in input_fields and name != "bash":
            if isinstance(event.get("preview"), str):
                sources.append(("result_preview", event["preview"]))
            if "sourceUrls" not in event:
                enumeration["resultsWithoutEvidence"] += 1
            else:
                evidence = event["sourceUrls"]
                valid = (isinstance(evidence, dict) and isinstance(evidence.get("urls"), list)
                         and len(evidence["urls"]) <= 32
                         and all(isinstance(url, str) and len(url) <= 2048 and _source_url_value_valid(url) for url in evidence["urls"])
                         and type(evidence.get("complete")) is bool
                         and type(evidence.get("omitted")) is int and evidence["omitted"] >= 0
                         and isinstance(evidence.get("outputSha256"), str)
                         and re.fullmatch(r"[a-f0-9]{64}", evidence["outputSha256"]) is not None
                         and evidence["complete"] is (evidence["omitted"] == 0))
                if valid:
                    enumeration["resultsWithEvidence"] += 1
                    sources.extend(("result_source_urls", url) for url in evidence["urls"])
                if not valid or not evidence["complete"]:
                    gaps.append({"callId": event.get("id"), "tool": name,
                                 "reason": "invalid_or_incomplete_source_url_evidence", **scope})
        for source, value in sources:
            decoded = unquote(unquote(value))
            urls = []
            for url in url_pattern.findall(decoded):
                if not marker.search(url):
                    continue
                try:
                    parts = urlsplit(url.rstrip("),;]"))
                    urls.append(urlunsplit((parts.scheme, parts.hostname or "", parts.path, "", "")))
                except ValueError:
                    urls.append("[unparseable benchmark source URL]")
            if urls or (name == "web_search" and source == "tool_input" and marker.search(decoded)):
                findings.append({"callId": event.get("id"), "tool": name, "source": source,
                                 "urls": sorted(set(urls)), "toolSucceeded": event.get("ok"), **scope})
    return {
        "status": "reference_source_detected" if findings else "source_audit_incomplete_review_required" if gaps else "not_detected_review_required",
        "networkToolCalls": network_calls, "findings": findings,
        "sourceEnumeration": enumeration, "sourceEvidenceGaps": gaps,
        "coverage": "Root/scoped-child URL/query/command inputs; bounded full-result source URLs where supplied, otherwise previews; full trajectory review required.",
    }


def _result_source_policy_audit(stdout: str, expected_sha256: str, tools: list[str]) -> dict[str, Any]:
    verified = withheld = 0
    gaps = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (not isinstance(event, dict) or event.get("type") not in ("tool_result", "subagent_tool_result")
            or event.get("name") not in tools):
            continue
        evidence = event.get("resultSourcePolicy")
        valid = (isinstance(evidence, dict) and type(evidence.get("version")) is int and evidence["version"] == 1
                 and evidence.get("configuredFileSha256") == expected_sha256
                 and evidence.get("decision") in ("allowed", "withheld")
                 and evidence.get("reason") in ("no_literal_match", "excluded_source", "scan_limit")
                 and isinstance(evidence.get("policyDigest"), str)
                 and re.fullmatch(r"[a-f0-9]{64}", evidence["policyDigest"]) is not None
                 and (evidence["decision"] != "withheld" or event.get("ok") is False))
        if not valid:
            gaps.append({"callId": event.get("id"), "tool": event.get("name"), "path": event.get("path", [])})
        else:
            verified += 1
            withheld += evidence["decision"] == "withheld"
    return {"configured": True, "configuredFileSha256": expected_sha256,
            "verifiedResultCount": verified, "withheldResultCount": withheld, "gaps": gaps,
            "coverage": "Configured result text channels only, not network isolation or a clean-source attestation."}


def _last_result_record(stdout: str) -> dict[str, Any] | None:
    result: dict[str, Any] | None = None
    initial: dict[str, Any] | None = None
    for line in stdout.splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and record.get("type") == "system" and record.get("subtype") == "init":
            if initial is not None:
                raise RuntimeError("Zap emitted duplicate init records")
            initial = record
        if isinstance(record, dict) and record.get("type") == "result":
            if result is not None:
                raise RuntimeError("Zap emitted duplicate final result records")
            result = record
    if initial is not None and result is not None:
        if initial.get("sessionId") != result.get("sessionId"):
            raise RuntimeError("Init/result session identity mismatch")
        if (initial.get("schema"), initial.get("schemaVersion")) != (result.get("schema"), result.get("schemaVersion")):
            raise RuntimeError("Init/result schema mismatch")
    return result


def _validate_final_result(final: dict[str, Any], exit_code: int, profile: str) -> None:
    soft = {"max_steps", "max_tokens", "budget", "timeout", "max_repeat"}
    if (final.get("type") != "result" or type(final.get("ok")) is not bool
        or not isinstance(final.get("text"), str) or not isinstance(final.get("sessionId"), str) or not final["sessionId"]
        or type(final.get("turns")) is not int or final["turns"] < 0
        or not isinstance(final.get("usage"), dict) or not isinstance(final.get("toolCalls"), list)):
        raise RuntimeError("Missing result summary fields")
    if not all(type(final["usage"].get(key)) is int and final["usage"][key] >= 0 for key in ("inputTokens", "outputTokens")):
        raise RuntimeError("Invalid result usage")
    if profile == "legacy":
        if "schema" in final or "schemaVersion" in final:
            raise RuntimeError("Unexpected schema for legacy result")
        reason = final.get("stopReason")
        if reason in soft | {"end_turn"} and exit_code == 0:
            return
        if reason == "incomplete" and exit_code == 1 and isinstance(final.get("completion"), dict) and final["completion"].get("status") == "incomplete":
            return
        raise RuntimeError(f"Zap exited with code {exit_code}: invalid legacy outcome {reason}")
    if final.get("schema") != "zap.outcome" or type(final.get("schemaVersion")) is not int or final["schemaVersion"] != 1:
        raise RuntimeError("Invalid outcome schema")
    ids = [final.get(key) for key in ("threadId", "turnId", "runId", "attemptId", "sessionId")]
    if not all(isinstance(value, str) and value for value in ids) or ids[2] != ids[3] or ids[0] != ids[4]:
        raise RuntimeError("Outcome identity mismatch")
    parts = [final.get(key) for key in ("execution", "acceptance", "workflow")]
    if not all(isinstance(part, dict) and part.get("attemptId") == ids[3] for part in parts):
        raise RuntimeError("Outcome attempt identity mismatch")
    execution, acceptance, workflow = parts
    status, reason = execution.get("status"), execution.get("stopReason")
    reasons = {"finished": {"end_turn"}, "limited": soft, "failed": {"error"}, "cancelled": {"aborted"},
               "blocked": {"permission_denied", "input_required", "capability_unavailable"}}
    if status not in reasons or reason not in reasons[status]:
        raise RuntimeError("Invalid execution status/reason")
    if final.get("ok") is not (status == "finished") or final.get("stopReason") != reason or final.get("text") != execution.get("finalResponse"):
        raise RuntimeError("Conflicting outcome projection")
    if not isinstance(execution.get("finalResponse"), str) or not isinstance(execution.get("unresolvedActions"), list):
        raise RuntimeError("Malformed execution outcome")
    if acceptance.get("status") not in {"not_requested", "unverified"} or not isinstance(acceptance.get("checks"), list) or not isinstance(acceptance.get("code"), str):
        raise RuntimeError("Invalid M1 acceptance report")
    for action in execution["unresolvedActions"]:
        if not isinstance(action, dict) or not isinstance(action.get("actionId"), str) or action.get("owner") not in {"host", "runtime"} or action.get("kind") not in {"approval", "input", "capability", "running_tool"} or action.get("state") != "pending" or not isinstance(action.get("reason"), str):
            raise RuntimeError("Invalid unresolved action")
    background_tasks = execution.get("backgroundTasks", [])
    if not isinstance(background_tasks, list) or any(
        not isinstance(task, dict) or not isinstance(task.get("taskId"), str)
        or task.get("disposition") not in {"stopped", "host_owned", "pending"}
        for task in background_tasks
    ):
        raise RuntimeError("Invalid background task receipt")
    for check in acceptance["checks"]:
        if not isinstance(check, dict) or not isinstance(check.get("checkId"), str) or check.get("source") != "agent_check" or check.get("observedOutcome") not in {"passed", "failed", "error"} or not isinstance(check.get("evidenceRefs"), list) or not all(isinstance(ref, str) for ref in check["evidenceRefs"]) or type(check.get("observedAt")) not in (int, float):
            raise RuntimeError("Invalid acceptance check")
    if workflow.get("status") != "not_requested" or type(workflow.get("controlRevision")) is not int or workflow["controlRevision"] != 0 or not isinstance(workflow.get("code"), str):
        raise RuntimeError("Invalid M1 workflow decision")
    if not all(isinstance(final.get(key), (int, float)) and not isinstance(final[key], bool) for key in ("startedAt", "endedAt", "turns")) or not isinstance(final.get("usage"), dict) or not isinstance(final.get("toolCalls"), list):
        raise RuntimeError("Missing outcome summary fields")
    if status in {"finished", "limited"} and exit_code == 0:
        return
    raise RuntimeError(f"Zap exited with code {exit_code}: execution {status}/{reason}")

def _write_minimal_eval_config(
    source: Path, model_name: str | None = None, prompt_profile: str | None = None
) -> Path:
    """Create a disposable config containing only the active provider.

    A Terminal-Bench task is untrusted code. It needs the active provider's
    credential to call Zap, but it must not receive unrelated provider keys,
    MCP credentials, search keys, or personal settings from the owner's full
    config. A remote credential proxy remains the long-term boundary; this
    helper narrows the immediately exposed secret surface in the meantime.
    """
    try:
        config = json.loads(source.read_text(encoding="utf-8"))
        active = config["active"]
        provider_id = active["providerId"]
        provider = next(
            item for item in config["providers"] if item.get("id") == provider_id
        )
    except (KeyError, StopIteration, TypeError, json.JSONDecodeError) as exc:
        raise ValueError(
            "Terminal-Bench requires a config with active.providerId and its provider entry"
        ) from exc

    if model_name is not None:
        if not isinstance(model_name, str) or not model_name.strip():
            raise ValueError("Terminal-Bench model_name must be a non-empty model ID")
        models = provider.get("models")
        if not isinstance(models, list) or model_name not in models:
            raise ValueError("Terminal-Bench model_name must be configured in the active provider")
        active = {**active, "model": model_name}

    if prompt_profile is not None and prompt_profile not in ("standard", "concise"):
        raise ValueError("prompt_profile must be standard or concise")
    minimal = {"active": active, "providers": [provider]}
    if prompt_profile is not None:
        minimal["promptProfile"] = prompt_profile

    fd, raw_path = tempfile.mkstemp(prefix="zap-terminal-bench-config-", suffix=".json")
    path = Path(raw_path)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(minimal, output)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path


def _record_final_result(context: AgentContext, final: dict[str, Any]) -> None:
    """Persist the agent outcome without conflating it with verifier success.

    A streamed Zap result is useful to Terminal-Bench even when the agent hit a
    soft budget boundary such as ``max_steps``.  The task verifier is the
    authority on whether the files produced up to that point are correct; the
    adapter should expose the incomplete agent outcome rather than prevent the
    verifier from running.
    """
    usage = final.get("usage")
    if isinstance(usage, dict):
        fresh = usage.get("inputTokens")
        cached = usage.get("cacheReadInputTokens")
        created = usage.get("cacheCreationInputTokens")
        output = usage.get("outputTokens")
        prompt_parts = [
            value for value in (fresh, cached, created) if isinstance(value, int)
        ]
        if prompt_parts:
            context.n_input_tokens = sum(prompt_parts)
        if isinstance(cached, int):
            context.n_cache_tokens = cached
        if isinstance(output, int):
            context.n_output_tokens = output

    error = final.get("error")
    context.metadata = {
        **(context.metadata or {}),
        "resultSchema": final.get("schema", "legacy"),
        "execution": final.get("execution"),
        "acceptance": final.get("acceptance"),
        "turns": final.get("turns"),
        "stopReason": final.get("stopReason"),
        "toolCalls": len(final.get("toolCalls") or []),
        "streamPath": REMOTE_STDOUT,
        "agentOk": final.get("ok") is True,
        "agentError": error if isinstance(error, (str, dict)) else None,
    }


class ZapAgent(BaseAgent):
    """Run Zap's public headless stream-json interface inside Harbor."""

    SUPPORTS_ATIF = False
    SUPPORTS_RESUME = False

    def __init__(
        self,
        *args: Any,
        binary_path: str,
        config_path: str,
        max_turns: int | str = 80,
        outer_timeout_sec: int | str = DEFAULT_OUTER_TIMEOUT_SEC,
        finalize_reserve_sec: int | str = DEFAULT_FINALIZE_RESERVE_SEC,
        result_schema: str = "outcome-v1",
        prompt_profile: str | None = None,
        network_allowlist: list[str] | None = None,
        result_source_policy_path: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.binary_path = Path(binary_path).expanduser().resolve()
        self.config_path = Path(config_path).expanduser().resolve()
        if result_schema not in ("outcome-v1", "legacy"):
            raise ValueError("result_schema must be outcome-v1 or legacy")
        self.result_schema = result_schema
        if prompt_profile is not None and prompt_profile not in ("standard", "concise"):
            raise ValueError("prompt_profile must be standard or concise")
        self.prompt_profile = prompt_profile
        self.network_allowlist = None
        if network_allowlist is not None:
            from .network_profile import normalize_hosts
            self.network_allowlist = normalize_hosts(network_allowlist)
        self.result_source_policy_path = Path(result_source_policy_path).expanduser().resolve() if result_source_policy_path else None
        if self.result_source_policy_path is not None and not self.result_source_policy_path.is_file():
            raise ValueError("Result source policy file does not exist")
        self._supports_result_schema = True
        self.max_turns = int(max_turns)
        self.outer_timeout_sec = int(outer_timeout_sec)
        self.finalize_reserve_sec = int(finalize_reserve_sec)
        if not self.binary_path.is_file():
            raise ValueError(f"Zap binary does not exist: {self.binary_path}")
        if not self.config_path.is_file():
            raise ValueError(f"Zap config does not exist: {self.config_path}")
        if self.max_turns < 1:
            raise ValueError("max_turns must be positive")
        if self.outer_timeout_sec < 1:
            raise ValueError("outer_timeout_sec must be positive")
        if self.finalize_reserve_sec < 1:
            raise ValueError("finalize_reserve_sec must be positive")
        if self.finalize_reserve_sec >= self.outer_timeout_sec:
            raise ValueError("finalize_reserve_sec must be smaller than outer_timeout_sec")

    @property
    def run_timeout_ms(self) -> int:
        """Budget Zap may spend before its own final synthesis window.

        Harbor's agent timeout is an external kill switch. Giving Zap a
        shorter self-managed deadline lets it stop issuing work and emit a
        gradeable final JSON result before Harbor terminates the process.
        """
        return (self.outer_timeout_sec - self.finalize_reserve_sec) * 1_000

    @staticmethod
    @override
    def name() -> str:
        return "zap"

    @override
    def version(self) -> str:
        return "1.9.0-current-checkout"

    async def _probe_legacy_binary(self, environment: BaseEnvironment) -> None:
        if self.result_schema != "legacy" and getattr(self, "result_source_policy_path", None) is None:
            return
        help_result = await environment.exec(command=f"{REMOTE_BINARY} --help-headless < /dev/null")
        if help_result.return_code != 0:
            raise RuntimeError("Could not inspect legacy binary's headless interface")
        self._supports_result_schema = "--result-schema" in (help_result.stdout or "")
        if getattr(self, "result_source_policy_path", None) is not None and "--result-source-policy" not in (help_result.stdout or ""):
            raise RuntimeError("Selected source policy requires a binary supporting --result-source-policy")

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        install = await environment.exec(
            command=(
                "set -eu; "
                "if test -s /etc/ssl/certs/ca-certificates.crt; then exit 0; fi; "
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update -qq && "
                "  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "
                "    ca-certificates; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache ca-certificates; "
                "elif command -v dnf >/dev/null 2>&1; then "
                "  dnf install -y ca-certificates; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y ca-certificates; "
                "else echo 'No supported package manager for CA certificates' >&2; exit 1; fi"
            ),
            user="root",
            timeout_sec=180,
        )
        if install.return_code != 0:
            raise RuntimeError(install.stderr or install.stdout or "CA certificate install failed")

        await environment.upload_file(self.binary_path, REMOTE_BINARY)
        await environment.exec(
            command=(
                f"mkdir -p {REMOTE_DATA_DIR} && chmod 700 {REMOTE_DATA_DIR} && "
                f"chmod 755 {REMOTE_BINARY}"
            ),
            user="root",
        )
        minimal_config = _write_minimal_eval_config(self.config_path, self.model_name, self.prompt_profile)
        try:
            await environment.upload_file(minimal_config, REMOTE_CONFIG)
        finally:
            minimal_config.unlink(missing_ok=True)

        ownership = ""
        if environment.default_user is not None:
            ownership = (
                f"chown {shlex.quote(str(environment.default_user))} "
                f"{REMOTE_DATA_DIR} {REMOTE_CONFIG} && "
            )
        secured = await environment.exec(
            command=f"{ownership}chmod 700 {REMOTE_DATA_DIR} && chmod 600 {REMOTE_CONFIG}",
            user="root",
        )
        if secured.return_code != 0:
            raise RuntimeError(secured.stderr or secured.stdout or "Zap config setup failed")
        await self._probe_legacy_binary(environment)
        if getattr(self, "result_source_policy_path", None) is not None:
            with self.result_source_policy_path.open("rb") as source:
                policy_bytes = source.read(64 * 1024 + 1)
            if len(policy_bytes) > 64 * 1024:
                raise ValueError("Result source policy exceeds 64 KiB")
            policy = json.loads(policy_bytes)
            if (not isinstance(policy, dict) or not isinstance(policy.get("tools"), list)
                or not policy["tools"] or not all(isinstance(item, str) for item in policy["tools"])):
                raise ValueError("Invalid result source policy tool scope")
            self._result_source_policy_sha256 = hashlib.sha256(policy_bytes).hexdigest()
            self._result_source_policy_tools = list(policy["tools"])
            fd, path = tempfile.mkstemp(prefix="zap-source-policy-", suffix=".json")
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "wb") as output:
                    output.write(policy_bytes)
                await environment.upload_file(Path(path), REMOTE_DATA_DIR + "/source-policy.json")
            finally:
                Path(path).unlink(missing_ok=True)
            owner = f"chown {shlex.quote(str(environment.default_user))} {REMOTE_DATA_DIR}/source-policy.json && " if environment.default_user is not None else ""
            secured = await environment.exec(command=f"{owner}chmod 600 {REMOTE_DATA_DIR}/source-policy.json", user="root")
            if secured.return_code != 0:
                raise RuntimeError("Could not secure source policy file")

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._verify_network_boundary(environment, context)
        source_policy_selected = getattr(self, "result_source_policy_path", None) is not None
        if source_policy_selected and not getattr(self, "_result_source_policy_sha256", None):
            raise RuntimeError("Result source policy setup is incomplete; no model run started")
        evaluation_instruction = INDEPENDENT_EVALUATION_INSTRUCTION
        if getattr(self, "network_allowlist", None) is not None:
            evaluation_instruction += (
                " Outbound HTTP/TLS access during this run is restricted by the host to these exact destinations: "
                + ", ".join(self.network_allowlist)
                + ". Other HTTP/TLS destinations are unavailable through this route; the agent cannot change this policy."
            )
        command = " ".join(
            [
                REMOTE_BINARY,
                "--print",
                shlex.quote(instruction),
                "--output-format stream-json",
                f"--result-schema {self.result_schema}" if getattr(self, "_supports_result_schema", True) else "",
                "--permission-mode bypassPermissions",
                "--dangerously-disable-os-sandbox",
                f"--max-turns {self.max_turns}",
                f"--timeout-ms {self.run_timeout_ms}",
                "--continue-on-tool-denial",
                f"--result-source-policy {REMOTE_DATA_DIR}/source-policy.json" if source_policy_selected else "",
                "--system-prompt-append",
                shlex.quote(evaluation_instruction),
                '--cwd "$PWD"',
                "--no-devtools",
                "< /dev/null",
                f"> {REMOTE_STDOUT}",
                f"2> {REMOTE_STDERR}",
                "; status=$?;",
                f"cat {REMOTE_STDOUT};",
                f"cat {REMOTE_STDERR} >&2;",
                "exit $status",
            ]
        )
        result = await environment.exec(
            command=command,
            env={
                "ZAPCODE_DATA_DIR": REMOTE_DATA_DIR,
                # Match ordinary local execution, including owned background work.
                "ZAPCODE_DISABLE_BACKGROUND_TASKS": "0",
            },
        )

        final = _last_result_record(result.stdout or "")
        if final is not None:
            _record_final_result(context, final)

        integrity = _evaluation_integrity_audit(result.stdout or "")
        if context.metadata is None:
            context.metadata = {}
        context.metadata["evaluationIntegrity"] = integrity
        context.metadata["processExitCode"] = result.return_code
        context.metadata["preModelSourcePolicy"] = (_result_source_policy_audit(result.stdout or "", self._result_source_policy_sha256, self._result_source_policy_tools)
            if source_policy_selected else {"configured": False})
        if source_policy_selected and context.metadata["preModelSourcePolicy"]["gaps"]:
            raise RuntimeError("Result source policy coverage missing or mismatched; evaluation review required")
        if integrity["status"] == "reference_source_detected":
            raise RuntimeError("Evaluation integrity review required: benchmark reference source access detected")

        if integrity["status"] == "source_audit_incomplete_review_required":
            raise RuntimeError("Evaluation integrity evidence incomplete: source URL evidence requires review")

        if final is not None:
            _validate_final_result(final, result.return_code, self.result_schema)
        if final is None and result.return_code != 0:
            detail = (result.stderr or result.stdout or "Zap exited without output")[-8000:]
            raise RuntimeError(f"Zap exited with code {result.return_code}:\n{detail}")
        if final is None:
            raise RuntimeError("Zap emitted no final stream-json result record")

    async def _verify_network_boundary(self, environment: BaseEnvironment, context: AgentContext) -> None:
        """Fail before any model execution if the declared treatment is absent.

        The Host selects and applies the policy through Harbor. This adapter
        verifies it; it never changes network rules from inside the guest.
        """
        expected = getattr(self, "network_allowlist", None)
        if expected is None:
            return
        from .network_profile import normalize_hosts
        policy = environment.network_policy
        capabilities = environment.capabilities
        if (policy.network_mode.value != "allowlist"
                or normalize_hosts(policy.allowed_hosts) != expected
                or not capabilities.network_allowlist_hostnames
                or not capabilities.dynamic_network_policy):
            raise RuntimeError("Declared agent network allowlist is not enforced by the environment")
        observed = await environment.exec(command="cat /proc/self/status", user="root")
        if observed.return_code != 0:
            raise RuntimeError("Could not verify container network capability boundary")
        fields = dict(line.split(":", 1) for line in (observed.stdout or "").splitlines() if ":" in line)
        try:
            effective = int(fields["CapEff"].strip(), 16)
            bounding = int(fields["CapBnd"].strip(), 16)
            no_new_privileges = int(fields["NoNewPrivs"].strip())
        except (KeyError, ValueError):
            raise RuntimeError("Missing container network capability evidence") from None
        # NET_ADMIN can change the rules; NET_RAW can set SO_MARK on modern
        # kernels and imitate the transparent proxy's privileged egress mark.
        network_caps = (1 << 12) | (1 << 13)
        if (effective | bounding) & network_caps or no_new_privileges != 1:
            raise RuntimeError("Container can regain or bypass network enforcement capabilities")
        if context.metadata is None:
            context.metadata = {}
        context.metadata["networkBoundary"] = {
            "mode": "allowlist", "allowedHosts": expected,
            "capEff": fields["CapEff"].strip(), "capBnd": fields["CapBnd"].strip(),
            "noNewPrivileges": True,
            "scope": "Host-enforced destination policy; source-content and verifier reviews still required.",
        }
