"""Plan supplemental file captures from scoped calls; never read/execute files.

Workspace bindings must come from the execution host, not model arguments or
result prose. A path is only a candidate until the observer checks its realpath,
file identity, size and bytes in that same container/workspace.
"""
import collections
import posixpath

FILE_TOOLS = {"write_file", "edit_file", "multi_edit"}
CALL_TYPES = {"tool_use", "subagent_tool_use"}
RESULT_TYPES = {"tool_result", "subagent_tool_result"}


def _identity(event):
    path = event.get("path", [])
    if (not isinstance(path, list) or any(not isinstance(part, str) or not part for part in path)
            or event["type"].startswith("subagent_") != bool(path)
            or not isinstance(event.get("id"), str) or not event["id"]):
        return None
    return tuple(path), event["id"]


def _workspace(value):
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise ValueError("Workspace binding must be an absolute container path")
    # A double-leading slash has implementation-defined semantics in POSIX.
    return "/" + posixpath.normpath(value).lstrip("/")


def plan_file_captures(events, *, root_workspace, workspaces=None):
    """Keep call ancestry, including failures/ambiguities, without guessing cwd.

    workspaces maps complete child agent paths (tuples) to host-observed roots.
    Missing child bindings never inherit the parent, even for absolute paths.
    Reused ids within the same agent path are ambiguous and never captured.
    Final-filesystem capture does not reconstruct earlier versions of a file.
    """
    bindings = {(): _workspace(root_workspace)}
    for path, root in (workspaces or {}).items():
        if not isinstance(path, tuple) or not path or any(not isinstance(part, str) or not part for part in path):
            raise ValueError("Child workspace binding requires a complete agent path")
        bindings[path] = _workspace(root)
    calls, results = collections.defaultdict(list), collections.defaultdict(list)
    for index, event in enumerate(events):
        if event.get("type") not in CALL_TYPES | RESULT_TYPES:
            continue
        identity = _identity(event)
        if identity is not None:
            (calls if event["type"] in CALL_TYPES else results)[identity].append((index, event))
    planned = []
    for index, event in enumerate(events):
        if event.get("type") not in CALL_TYPES or event.get("name") not in FILE_TOOLS:
            continue
        identity = _identity(event)
        args = event.get("args")
        requested = args.get("path") if isinstance(args, dict) else None
        row = {"callIndex": index, "toolCallId": event.get("id"), "toolName": event["name"],
               "agentPath": list(identity[0]) if identity is not None else None,
               "requestedPath": requested, "status": "invalid_call_identity"}
        planned.append(row)
        if identity is None:
            continue
        if len(calls[identity]) != 1 or len(results[identity]) > 1:
            row["status"] = "ambiguous_tool_identity"
            continue
        if not results[identity]:
            row["status"] = "unsettled_call"
            continue
        result_index, result = results[identity][0]
        row["resultIndex"] = result_index
        if result_index <= index or result.get("name") != event["name"]:
            row["status"] = "mismatched_result"
            continue
        if result.get("ok") is not True:
            row["status"] = "unsuccessful_call"
            continue
        if not isinstance(requested, str) or not requested or "\0" in requested:
            row["status"] = "invalid_requested_path"
            continue
        workspace = bindings.get(identity[0])
        if workspace is None:
            row["status"] = "workspace_unproven"
            continue
        row["workspace"] = workspace
        candidate = _workspace(requested if requested.startswith("/") else posixpath.join(workspace, requested))
        if candidate == workspace or (workspace != "/" and not candidate.startswith(workspace + "/")):
            row["status"] = "outside_workspace_skipped"
            continue
        row.update(candidatePath=candidate, status="capture_candidate")
    return planned
