"""Bounded host-side monitoring of one Docker image pull, before any model run.

A sampling guard limits exposure; it cannot predict unpacked size or guarantee
that the daemon has stopped after its client exits. It never retries or prunes.
"""
import math
import subprocess
import time


class PullCapacityError(RuntimeError):
    """Pull was not accepted; preserve this infrastructure attempt."""


def _positive(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(name + " must be finite and positive")
    return value


def _bytes(value, name):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0 or int(value) != value):
        raise ValueError(name + " must be finite nonnegative integer bytes")
    return int(value)


def guarded_pull(image_ref, *, snapshot, reserve_bytes, record, log,
                 interval_sec=1, timeout_sec=1800, terminate_grace_sec=10):
    """Pull the original amd64 reference and retain every capacity observation.

    snapshot() must return fresh hostFreeBytes and dockerFreeBytes, with bounded
    latency. reserve_bytes must include task storage and host/evidence headroom;
    admission must still verify the image digest and all resources afterwards.
    record() must persist locally, and log must be a file (never an unread pipe).
    A rejected pull is terminal for this call, including missing observations or
    persistence errors. A caller must never start Harbor on an exception.
    """
    if not isinstance(image_ref, str) or not image_ref or image_ref.startswith("-") or any(c.isspace() for c in image_ref):
        raise ValueError("Expected a non-option image reference")
    reserve_bytes = _bytes(reserve_bytes, "reserve_bytes")
    _positive(reserve_bytes, "reserve_bytes")
    for value, name in [(interval_sec, "interval_sec"), (timeout_sec, "timeout_sec"),
                        (terminate_grace_sec, "terminate_grace_sec")]:
        _positive(value, name)
    start = time.monotonic()
    process = None

    def observe(phase):
        observed = snapshot()
        free = {key: _bytes(observed.get(key), key)
                for key in ("hostFreeBytes", "dockerFreeBytes")}
        sufficient = all(value >= reserve_bytes for value in free.values())
        record({"phase": phase, "at": time.time(), "elapsedSec": time.monotonic() - start,
                **free, "clientPid": process.pid if process is not None else None, "minimumFreeBytes": reserve_bytes, "sufficient": sufficient})
        if not sufficient:
            raise PullCapacityError("Free space reached the reserved pull boundary")

    try:
        observe("before_pull")
        if time.monotonic() - start >= timeout_sec:
            raise PullCapacityError("Docker pull exceeded its deadline before launch")
        process = subprocess.Popen(
            ["docker", "pull", "--platform", "linux/amd64", image_ref],
            stdout=log, stderr=subprocess.STDOUT,
        )
        while True:
            code = process.poll()
            observe("after_pull" if code is not None else "during_pull")
            if time.monotonic() - start >= timeout_sec:
                raise PullCapacityError("Docker pull exceeded its deadline")
            if code is not None:
                if code != 0:
                    raise PullCapacityError("Docker pull failed with exit " + str(code))
                return {"clientExitCode": code, "postPullAdmissionRequired": True}
            time.sleep(min(interval_sec, max(0, timeout_sec - (time.monotonic() - start))))
    except BaseException:
        # Signal only the exact child owned by this call; never scan/kill other
        # Docker clients, daemon workers or unrelated containers.
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=terminate_grace_sec)
                except subprocess.TimeoutExpired:
                    process.kill()
                    try:
                        process.wait(timeout=terminate_grace_sec)
                    except subprocess.TimeoutExpired as error:
                        raise PullCapacityError("Pull client termination remains unconfirmed; inspect this exact PID") from error
            record({"phase": "pull_rejected", "at": time.time(), "clientPid": process.pid,
                    "clientExitCode": process.poll(), "daemonQuiescence": "unproven",
                    "requiresInspectionBeforeAnotherPull": True})
        raise
