"""Read-only admission check between completed Harbor jobs.

The caller must first confirm its Harbor process is terminal. This check never
retries a trial, changes a reward, or certifies source integrity/test execution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def inspect_completed_job(
    job_dir: Path, expected_tasks: list[str], exit_code: int
) -> dict[str, Any]:
    """Stop subsequent jobs on infrastructure errors or incomplete evidence.

    A normal official reward of zero does not stop the cohort: keeping those
    originals is necessary to avoid selecting only successful tasks.
    """
    if (not expected_tasks
        or any(not isinstance(task, str) or not task for task in expected_tasks)
        or len(set(expected_tasks)) != len(expected_tasks)):
        raise ValueError("Expected tasks must be unique non-empty names")
    if type(exit_code) is not int:
        raise ValueError("Harbor must have a terminal integer exit code")
    reasons = [] if exit_code == 0 else ["harbor_process_failed"]
    trials: list[dict[str, Any]] = []
    seen: list[str] = []
    # Include trial directories without result.json; absence must not disappear
    # from the decision merely because glob('*/result.json') missed it.
    for directory in sorted(job_dir.iterdir()) if job_dir.is_dir() else []:
        if not directory.is_dir() or "__" not in directory.name:
            continue
        result_path = directory / "result.json"
        record: dict[str, Any] = {"trial": directory.name}
        trial_reasons: list[str] = []
        try:
            data = result_path.read_bytes()
            record["resultSha256"] = hashlib.sha256(data).hexdigest()
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("Invalid result object")
            task = result.get("task_name")
            record["task"] = task
            if (not isinstance(task, str) or task not in expected_tasks
                or result.get("trial_name") != directory.name):
                trial_reasons.append("unexpected_trial_identity")
            else:
                seen.append(task)
            if not result.get("finished_at"):
                trial_reasons.append("trial_not_terminal")
            if "exception_info" not in result:
                trial_reasons.append("missing_exception_status")
            elif result["exception_info"] is not None:
                trial_reasons.append("trial_execution_exception")
            verifier = result.get("verifier_result")
            rewards = verifier.get("rewards") if isinstance(verifier, dict) else None
            reward = rewards.get("reward") if isinstance(rewards, dict) else None
            if type(reward) not in (int, float) or reward not in (0, 1):
                record["officialReward"] = None
                trial_reasons.append("missing_or_invalid_reward")
            else:
                record["officialReward"] = reward
            phase = result.get("verifier")
            if not isinstance(phase, dict) or not phase.get("finished_at"):
                trial_reasons.append("verifier_phase_incomplete")
        except (OSError, ValueError):
            trial_reasons.append("missing_or_invalid_result")
        record["stopReasons"] = trial_reasons
        trials.append(record)
        reasons.extend(trial_reasons)
    if sorted(seen) != sorted(expected_tasks):
        reasons.append("missing_or_duplicate_originals")
    return {
        "continueAllowed": not reasons,
        "stopReasons": sorted(set(reasons)),
        "expectedTasks": expected_tasks,
        "harborExitCode": exit_code,
        "trials": trials,
        "limits": [
            "Caller must confirm the original Harbor process is terminal.",
            "Completed verifier phase and reward do not prove tests executed or source independence.",
            "Only admission of the next job is controlled; already scheduled trials are unaffected.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("--task", action="append", required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    args = parser.parse_args()
    report = inspect_completed_job(args.job_dir, args.task, args.exit_code)
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["continueAllowed"] else 2)
