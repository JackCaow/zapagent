"""Prepare a declared, task-independent Harbor network treatment.

Only agent phase network fields and a container capability overlay change.
Instructions, tests, solutions and environment files remain byte-identical.
This is destination control, not a semantic proof that allowed content is clean.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import ipaddress
import json
import re
import shutil
import tomllib
from pathlib import Path
from typing import Any

import toml
import yaml


def normalize_hosts(values: object) -> list[str]:
    if not isinstance(values, list) or not values:
        raise ValueError("network allowlist must be a nonempty list of exact DNS names")
    hosts = []
    for value in values:
        if not isinstance(value, str) or value != value.strip():
            raise ValueError("network hosts must be exact DNS names")
        host = value.lower().removesuffix(".")
        if not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", host):
            raise ValueError("network hosts must be exact DNS names, without URLs, wildcards or ports")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError("IP allowlist entries are not supported by this profile")
        if host.endswith((".localhost", ".local")):
            raise ValueError("local destinations are not supported by this profile")
        hosts.append(host)
    return sorted(set(hosts))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root: Path) -> dict[str, str]:
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"task symlinks are unsupported: {path.relative_to(root)}")
        if path.is_file():
            files[str(path.relative_to(root))] = digest(path)
        elif not path.is_dir():
            raise ValueError("task contains a non-regular filesystem entry")
    return files


def restrict_agent(config: dict[str, Any], hosts: list[str]) -> dict[str, Any]:
    candidate = copy.deepcopy(config)
    if config.get("environment", {}).get("os", "linux").lower() != "linux":
        raise ValueError("this network profile requires Linux containers")
    # Existing restrictions are task requirements. Do not silently broaden them.
    for section in [config.get("environment", {}), config.get("agent", {})]:
        if section.get("network_mode", "public") != "public" or section.get("allowed_hosts") or section.get("allow_internet") is False:
            raise ValueError("task already has network restrictions; an explicit policy intersection is required")
    if config.get("steps"):
        raise ValueError("multi-step tasks require per-step policy preparation")
    candidate.setdefault("agent", {}).update(network_mode="allowlist", allowed_hosts=hosts)
    return candidate


def validate_environment(root: Path) -> None:
    # Native Harbor skips explicitly networked services when creating its sidecar
    # override. Refuse those layouts rather than claiming they are controlled.
    # This is the task compose filename consumed by DockerEnvironment.
    path = root / "environment" / "docker-compose.yaml"
    if path.exists():
        document = yaml.safe_load(path.read_text()) or {}
        if not isinstance(document, dict) or document.get("include"):
            raise ValueError("compose includes require separate boundary review")
        services = document.get("services", {})
        if not isinstance(services, dict):
            raise ValueError("compose services must be a mapping")
        for name, service in services.items():
            if not isinstance(service, dict):
                raise ValueError("compose service must be a mapping")
            if any(service.get(key) for key in (
                "extends", "provider", "post_start", "pre_stop", "devices",
                "device_cgroup_rules", "use_api_socket", "volumes_from", "configs", "secrets",
            )):
                raise ValueError(f"service {name} has unreviewed inheritance, hooks or host access")
            caps = {str(cap).upper() for cap in service.get("cap_add", [])}
            if service.get("privileged") or caps & {"ALL", "NET_ADMIN", "NET_RAW", "SYS_ADMIN"}:
                raise ValueError(f"service {name} grants capabilities incompatible with network control")
            if any(key in service for key in ("network_mode", "networks", "pid", "ipc", "userns_mode")):
                raise ValueError(f"service {name} has an unsupported explicit namespace/network layout")
            if name != "main":
                raise ValueError("multi-service tasks require a capability overlay for every service")
            if service.get("volumes"):
                raise ValueError("task service mounts require separate boundary review")


def prepare_job(base: dict[str, Any], tasks: dict[str, Path], hosts: list[str], destination: Path, job_name: str) -> dict[str, Any]:
    hosts = normalize_hosts(hosts)
    destination = destination.resolve()
    if destination.exists():
        raise ValueError("destination already exists; never overwrite an experiment")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,100}", job_name):
        raise ValueError("invalid job name")
    datasets = base.get("datasets", [])
    if len(datasets) != 1 or set(datasets[0].get("task_names", [])) != set(tasks):
        raise ValueError("task set must exactly match the original single dataset selection")
    if len(tasks) != len(datasets[0]["task_names"]) or not tasks:
        raise ValueError("empty or duplicate task selection")
    if datasets[0].get("exclude_task_names") or datasets[0].get("n_tasks") is not None:
        raise ValueError("dataset filtering must not change the declared task selection")
    if base.get("tasks") or base.get("source_job"):
        raise ValueError("explicit/regraded task sources are unsupported")
    if len(base.get("agents", [])) != 1:
        raise ValueError("exactly one agent is required")
    for scope in [base.get("environment", {}), base["agents"][0]]:
        if scope.get("extra_allowed_hosts"):
            raise ValueError("extra_allowed_hosts would broaden the frozen profile")
    env = base.get("environment", {})
    if env.get("extra_docker_compose") or env.get("mounts") or env.get("mounts_json") or env.get("kwargs") or env.get("type", "docker") != "docker":
        raise ValueError("custom environment overrides require separate boundary review")
    if base.get("orchestrator") or base.get("n_attempts", 1) != 1 or base.get("install_only"):
        raise ValueError("a single-attempt execution config without legacy orchestrator overrides is required")
    retries = base.get("retry", {}).get("max_retries", 0)
    if retries:
        raise ValueError("automatic retries must be disabled for the original cohort")
    validated = []
    for name, source in tasks.items():
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
            raise ValueError("task names must be single path components")
        source = source.resolve()
        if source.name != name:
            raise ValueError("task directory name must match the selected task")
        if source == destination.resolve() or source in destination.resolve().parents:
            raise ValueError("destination cannot be inside a task")
        hashes = inventory(source)
        if "task.toml" not in hashes or "instruction.md" not in hashes:
            raise ValueError("task config or instruction missing")
        validate_environment(source)
        original = tomllib.loads((source / "task.toml").read_text())
        candidate = restrict_agent(original, hosts)
        serialized = toml.dumps(candidate)
        if tomllib.loads(serialized) != candidate:
            raise ValueError("task TOML does not roundtrip without semantic changes")
        validated.append((name, source, hashes, serialized))
    destination.mkdir(parents=True)
    records = []
    for name, source, hashes, serialized in validated:
        target = destination / "tasks" / name
        shutil.copytree(source, target)
        if inventory(target) != hashes:
            raise ValueError("source changed during copy; preserve failed preparation for review")
        (target / "task.toml").write_text(serialized)
        copied = inventory(target)
        if {k: v for k, v in copied.items() if k != "task.toml"} != {k: v for k, v in hashes.items() if k != "task.toml"}:
            raise ValueError("non-policy task contents changed")
        records.append({"task": name, "source": str(source), "target": str(target), "originalFiles": hashes, "preparedFiles": copied})
    overlay = destination / "capabilities.json"
    overlay.write_text(json.dumps({"services": {"main": {"cap_drop": ["NET_ADMIN", "NET_RAW"], "security_opt": ["no-new-privileges:true"]}}}, indent=2) + "\n")
    job = copy.deepcopy(base)
    job["job_name"] = job_name
    job["datasets"] = [{"path": str(destination / "tasks"), "task_names": datasets[0]["task_names"]}]
    job.setdefault("environment", {}).update(type="docker", extra_docker_compose=[str(overlay)])
    job["agents"][0].setdefault("kwargs", {})["network_allowlist"] = hosts
    # Harbor's default retries must not replace any of this condition's trials.
    job.setdefault("retry", {})["max_retries"] = 0
    (destination / "job.json").write_text(json.dumps(job, indent=2) + "\n")
    report = {"schemaVersion": 1, "status": "prepared_not_launched", "allowedHosts": hosts, "taskRecords": records,
              "baseConfigSha256": hashlib.sha256(json.dumps(base, sort_keys=True).encode()).hexdigest(),
              "jobSha256": digest(destination / "job.json"), "overlaySha256": digest(overlay),
              "limits": ["Changed network condition and task config checksums; never compare as a model-only treatment.",
                         "Destination filtering is not semantic content filtering. Allowed hosts can still serve unwanted content.",
                         "Harbor permits resolver DNS, ICMP and local traffic; this is not an arbitrary-channel confidentiality sandbox.",
                         "Requires actual container preflight and full trace/verifier review. No accuracy claim at preparation."]}
    (destination / "network-profile.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def verify_prepared(destination: Path) -> dict[str, Any]:
    """Recheck the exact prepared condition immediately before launch."""
    destination = destination.resolve()
    report = json.loads((destination / "network-profile.json").read_text())
    if digest(destination / "job.json") != report["jobSha256"] or digest(destination / "capabilities.json") != report["overlaySha256"]:
        raise ValueError("prepared job or capability overlay changed")
    hosts = normalize_hosts(report["allowedHosts"])
    job = json.loads((destination / "job.json").read_text())
    if job["agents"][0]["kwargs"]["network_allowlist"] != hosts:
        raise ValueError("adapter profile differs from task policy")
    selected = job["datasets"][0]["task_names"]
    recorded = [record["task"] for record in report["taskRecords"]]
    if not recorded or len(recorded) != len(set(recorded)) or set(recorded) != set(selected):
        raise ValueError("task records do not cover the complete selection")
    if job["datasets"][0]["path"] != str(destination / "tasks"):
        raise ValueError("prepared dataset path differs")
    if sorted(path.name for path in (destination / "tasks").iterdir()) != sorted(recorded):
        raise ValueError("prepared dataset contains unexpected entries")
    for record in report["taskRecords"]:
        original, target = Path(record["source"]), Path(record["target"])
        if target != destination / "tasks" / record["task"]:
            raise ValueError("prepared task path differs")
        if inventory(original) != record["originalFiles"] or inventory(target) != record["preparedFiles"]:
            raise ValueError("original or prepared task contents changed")
        expected = restrict_agent(tomllib.loads((original / "task.toml").read_text()), hosts)
        if tomllib.loads((target / "task.toml").read_text()) != expected:
            raise ValueError("task changed outside the declared agent network fields")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--config", type=Path, required=True)
    prepare.add_argument("--profile", type=Path, required=True, help="JSON with allowed_hosts; chosen by the evaluation host")
    prepare.add_argument("--task", action="append", required=True, help="NAME=original task directory")
    prepare.add_argument("--destination", type=Path, required=True)
    prepare.add_argument("--job-name", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.command == "verify":
        report = verify_prepared(args.destination)
        print(json.dumps({"status": "prepared_files_verified", "tasks": len(report["taskRecords"])}))
        return
    pairs = [item.split("=", 1) for item in args.task]
    if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
        parser.error("each task must have a distinct NAME=PATH")
    report = prepare_job(json.loads(args.config.read_text()), {name: Path(path) for name, path in pairs},
                         json.loads(args.profile.read_text())["allowed_hosts"], args.destination.resolve(), args.job_name)
    print(json.dumps({"status": report["status"], "tasks": len(report["taskRecords"]), "job": str(args.destination / "job.json")}))

if __name__ == "__main__":
    main()
