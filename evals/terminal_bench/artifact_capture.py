"""Supplemental read-only container capture with explicit call/workspace scope."""
import hashlib
import json
import pathlib
import subprocess
import time

from .artifact_scope import plan_file_captures

FILE_LIMIT = 2 * 1024**2
TRIAL_LIMIT = 16 * 1024**2


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checksum_output(data):
    # GNU sha256sum prefixes escaped filename records with a backslash. Do not
    # parse the filename or decode it as part of the checksum.
    parts = data.removeprefix(b"\\").split(maxsplit=1)
    if not parts:
        raise ValueError("Missing container checksum")
    value = parts[0]
    if len(value) != 64 or any(byte not in b"0123456789abcdef" for byte in value):
        raise ValueError("Malformed container checksum")
    return value.decode("ascii")


def run(argv):
    return subprocess.run(argv, capture_output=True, timeout=20)


def container_read(container, *args):
    result = run(["docker", "exec", container, *args])
    if result.returncode:
        raise RuntimeError("Container audit read failed")
    return result.stdout


def capture(trial_dir, container, stream, events, *, workspaces=None):
    """Capture only proven scopes; no task/generated code is executed.

    workspaces must be host-observed full child-path bindings. Without those,
    child file writes remain explicitly unproven instead of inheriting root cwd.
    The observer still needs to run while files/containers exist. This is final
    filesystem evidence, not a reconstruction of every intermediate tool write.
    """
    cwd = container_read(container, "pwd").decode().removesuffix("\n")
    root = container_read(container, "readlink", "-f", "--", cwd).decode().removesuffix("\n")
    report = {"at": time.time(), "trial": trial_dir.name, "container": container,
              "streamSha256": sha(stream), "workspace": root, "readOnly": True,
              "limits": ["Successful file tools only; shell-generated files require separate review.",
                         "Unknown child workspaces are not resolved against the parent.",
                         "2 MiB per file, 16 MiB unique captured bytes per trial.",
                         "Final-filesystem evidence only; not earlier versions or an atomic snapshot.",
                         "Captured contents are audit data and never executed or supplied to the Agent."],
              "files": plan_file_captures(events, root_workspace=root, workspaces=workspaces)}
    out = pathlib.Path(trial_dir) / "written-artifacts"
    out.mkdir(exist_ok=True)
    total = 0
    captured_hashes = set()
    for row in report["files"]:
        if row["status"] != "capture_candidate":
            continue
        try:
            workspace = row["workspace"]
            resolved = container_read(container, "readlink", "-f", "--", row["candidatePath"]).decode().removesuffix("\n")
            row["resolvedPath"] = resolved
            # Normalize supplied roots in the planner, but check real symlink
            # destinations here before asking the container to read any bytes.
            if resolved == workspace or (workspace != "/" and not resolved.startswith(workspace + "/")):
                row["status"] = "outside_workspace_skipped"
                continue
            if run(["docker", "exec", container, "test", "-f", resolved]).returncode:
                row["status"] = "not_regular_or_missing"
                continue
            size = int(container_read(container, "stat", "-c", "%s", "--", resolved))
            row["bytes"] = size
            if size < 0 or size > FILE_LIMIT or total + size > TRIAL_LIMIT:
                row["status"] = "size_limit_skipped"
                continue
            before = checksum_output(container_read(container, "sha256sum", "--", resolved))
            data = container_read(container, "head", "-c", str(FILE_LIMIT + 1), "--", resolved)
            if len(data) > FILE_LIMIT or total + len(data) > TRIAL_LIMIT:
                row["status"] = "grew_beyond_size_limit"
                continue
            local = sha(data)
            after = checksum_output(container_read(container, "sha256sum", "--", resolved))
            target = out / (local + ".artifact")
            target.write_bytes(data)
            if local not in captured_hashes:
                captured_hashes.add(local)
                total += len(data)
            row.update(capture=str(target), sha256=local, containerHashBefore=before, containerHashAfter=after,
                       status="captured_matching" if before == local == after and len(data) == size else "changed_during_capture")
        except (RuntimeError, ValueError, OSError, IndexError, subprocess.TimeoutExpired) as error:
            row.update(status="capture_failed", errorType=type(error).__name__)
    report["capturedBytes"] = total
    path = pathlib.Path(trial_dir) / "written-artifact-capture.json"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(path)
    return report
