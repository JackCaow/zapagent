"""Report a bound cohort snapshot without conflating pending review with failure.

Reads Host-owned JSON only. Does not run trials, verifiers, captured programs,
retries, cleanup, or process probes. A snapshot is never proof of live activity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path
from typing import Any


BUCKETS = ("independent_pass", "official_zero", "pass_ineligible",
           "pass_review_pending", "ungraded", "skipped", "pending", "running",
           "invalid_evidence")


def read_bound(path: str, digest: str) -> dict[str, Any]:
    data = Path(path).read_bytes()
    if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Evidence hash or size mismatch")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("Evidence must be an object")
    return value


def report_snapshot(plan: dict[str, Any], snapshot: dict[str, Any], *,
                    plan_sha256: str, now: float | None = None) -> dict[str, Any]:
    expected = [(job["name"], task) for job in plan["jobs"] for task in job["tasks"]]
    if (not expected or len(set(expected)) != len(expected)
        or type(plan["denominator"]) is not int or plan["denominator"] != len(expected)):
        raise ValueError("Original identities or fixed denominator are invalid")
    originals = snapshot["originals"]
    identities = [(row["job"], row["task"]) for row in originals]
    if identities != expected:
        raise ValueError("Snapshot must retain every original once in original order")
    if snapshot.get("frozenSourceCommit") != plan["sourceCommit"]:
        raise ValueError("Snapshot belongs to another source cohort")
    at = snapshot.get("at")
    if type(at) not in (int, float) or not math.isfinite(at) or at < 0:
        raise ValueError("Snapshot observation time is missing or invalid")
    counts = dict.fromkeys(BUCKETS, 0)
    rows = []
    for entry in originals:
        row = {"job": entry["job"], "task": entry["task"], "recordedState": entry["state"]}
        try:
            state = entry["state"]
            if state in ("pending", "running"):
                if entry.get("result"):
                    raise ValueError("Nonterminal original already has a recorded result")
                bucket = state
            elif state == "skipped":
                skip = read_bound(entry["skipRecord"], entry["skipRecordSha256"])
                if (skip["job"] != entry["job"] or entry["task"] not in skip["tasks"]
                    or skip["originalPlanSha256"] != plan_sha256
                    or skip["authorization"]["source"] != "direct_user_instruction"
                    or not skip["authorization"].get("text")
                    or skip["disposition"] != "user_requested_skip_ungraded"
                    or skip["modelStarted"] is not False or skip["officialVerifierRan"] is not False
                    or skip["officialReward"] is not None):
                    raise ValueError("Skip is not bound to human authorization and this plan")
                bucket = "skipped"
            elif state == "completed":
                result = read_bound(entry["result"], entry["resultSha256"])
                if (result["task_name"] != entry["task"]
                    or result["trial_name"] != entry["trial"] or not result.get("finished_at")):
                    raise ValueError("Result identity or terminal state mismatch")
                verifier = result.get("verifier_result")
                rewards = verifier.get("rewards") if isinstance(verifier, dict) else None
                reward = rewards.get("reward") if isinstance(rewards, dict) else None
                if reward is not None and (type(reward) not in (int, float) or reward not in (0, 1)):
                    raise ValueError("Invalid official reward")
                row["rawOfficialReward"] = reward
                bucket = ("ungraded" if reward is None else
                          "official_zero" if reward == 0 else "pass_review_pending")
                if entry.get("review"):
                    review = read_bound(entry["review"], entry["reviewSha256"])
                    if (review["trial"] != entry["trial"]
                        or review["evidence"]["resultSha256"] != entry["resultSha256"]
                        or review["officialReward"] != reward
                        or (reward is not None and type(review["officialReward"]) not in (int, float))
                        or review.get("sourceCommit", plan["sourceCommit"]) != plan["sourceCommit"]):
                        raise ValueError("Review is bound to another result or cohort")
                    classification = review["classification"]
                    row["reviewClassification"] = classification
                    phase = result.get("verifier")
                    graded = (isinstance(phase, dict) and bool(phase.get("finished_at"))
                              and review.get("officialVerifierRan") is True)
                    if review["independentOfficialPass"] is True:
                        if (reward != 1 or classification != "official_pass_source_access_reviewed"
                            or not graded or result.get("exception_info", {}) is not None
                            or review.get("sourceReview", {}).get("referenceExposureObserved") is True):
                            raise ValueError("Independent pass eligibility is inconsistent")
                        bucket = "independent_pass"
                    elif classification == "official_pass_reference_exposure_ineligible":
                        source = review.get("sourceReview", {})
                        if (reward != 1 or not graded
                            or source.get("referenceExposureObserved") is not True
                            or source.get("independenceEligibility") != "ineligible"):
                            raise ValueError("Ineligible raw pass evidence is inconsistent")
                        bucket = "pass_ineligible"
            else:
                raise ValueError("Unknown original state")
        except (OSError, ValueError, KeyError, TypeError) as error:
            bucket = "invalid_evidence"
            # Do not print file contents, paths or exceptions containing secrets.
            row["evidenceError"] = type(error).__name__
        row["bucket"] = bucket
        counts[bucket] += 1
        rows.append(row)
    return {"schemaVersion": 1, "generatedAt": time.time() if now is None else now,
            "snapshotAt": at, "sourceCommit": plan["sourceCommit"],
            "fixedDenominator": len(expected), "counts": counts, "originals": rows,
            "evidenceValid": counts["invalid_evidence"] == 0,
            "limits": ["States describe the supplied snapshot; current process or image-pull activity is not inspected.",
                       "Raw reward, independent eligibility, ungraded outcomes and pending review remain separate.",
                       "Review hashes bind Host audit records; this reporter does not redo the source or verifier audit.",
                       "No aggregate final accuracy is asserted before the full cohort is resolved."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--status", type=Path, required=True)
    args = parser.parse_args()
    plan_bytes = args.plan.read_bytes()
    snapshot_bytes = args.status.read_bytes()
    report = report_snapshot(json.loads(plan_bytes), json.loads(snapshot_bytes),
                             plan_sha256=hashlib.sha256(plan_bytes).hexdigest())
    report["snapshotSha256"] = hashlib.sha256(snapshot_bytes).hexdigest()
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["evidenceValid"] else 2)
