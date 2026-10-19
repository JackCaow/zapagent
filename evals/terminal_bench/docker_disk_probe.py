"""Owned, streaming disk sampler started before a Docker image pull.

Snapshot reads never issue Docker RPCs. Missing, stale or malformed samples fail
closed. This is Host infrastructure, not an Agent tool or a resource grant.
"""
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

class DiskProbeError(RuntimeError):
    """Sampling or ownership evidence is unavailable; never admit a pull."""


def _positive(value, name):
    if (type(value) not in (int, float) or not math.isfinite(value) or value <= 0):
        raise ValueError(name + " must be finite and positive")
    return value


LABEL = "zap.bench.disk-probe"


class DiskSamples:
    def __init__(self, token, max_age_sec=5):
        self.token = token
        self.max_age = _positive(max_age_sec, "max_age_sec")
        self.sequence = 0
        self.sample_at = self.received_at = self.free = None

    def accept(self, line, *, wall, monotonic):
        fields = line.split()
        if (len(line) > 256 or len(fields) != 4 or fields[0] != self.token
            or any(not re.fullmatch(r"[0-9]{1,18}", x) for x in fields[1:])):
            raise DiskProbeError("Malformed Docker disk sample")
        sequence, sampled_at, free_kib = map(int, fields[1:])
        if sequence != self.sequence + 1 or not -2 <= wall - sampled_at <= self.max_age:
            raise DiskProbeError("Out-of-order, stale or future Docker disk sample")
        self.sequence, self.sample_at = sequence, sampled_at
        self.received_at, self.free = monotonic, free_kib * 1024

    def latest(self, *, wall, monotonic):
        if (self.free is None or not -2 <= wall - self.sample_at <= self.max_age
            or not 0 <= monotonic - self.received_at <= self.max_age):
            raise DiskProbeError("Fresh Docker disk sample unavailable")
        return self.free


class DockerDiskProbe:
    def __init__(self, root, *, image_id, record, log, startup_timeout_sec=20,
                 max_age_sec=5, lifetime_sec=1860, control_timeout_sec=5):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
            raise ValueError("Probe requires an already inspected, pinned image ID")
        for value, name in [(startup_timeout_sec, "startup_timeout_sec"),
                            (control_timeout_sec, "control_timeout_sec")]:
            _positive(value, name)
        if type(lifetime_sec) is not int or not 1 <= lifetime_sec <= 86400:
            raise ValueError("Probe lifetime must be bounded integer seconds")
        self.root, self.image_id, self.record, self.log = root, image_id, record, log
        self.startup_timeout, self.control_timeout = startup_timeout_sec, control_timeout_sec
        self.lifetime = lifetime_sec
        self.token = uuid.uuid4().hex
        self.name = "zap-disk-probe-" + self.token
        self.samples = DiskSamples(self.token, max_age_sec)
        self.process = None
        self.buffer = b""
        self.closed = False
        self.container_id = None
        self.temporary = None
        self.cidfile = None

    def __enter__(self):
        # The token and lifetime are Host-generated/validated, never model input.
        command = ("i=0; while :; do "
                   "free=$(timeout 2 df -Pk / | awk 'NR==2 {print $4}'); "
                   "i=$((i+1)); printf '" + self.token + " %s %s %s\\n' "
                   '"$i" "$(date +%s)" "$free"; sleep 1; done')
        try:
            self.temporary = tempfile.TemporaryDirectory(prefix="zap-disk-probe-")
            self.cidfile = Path(self.temporary.name) / "container.id"
            self.process = subprocess.Popen([
                "docker", "run", "--rm", "--init", "--pull", "never", "--name", self.name,
                "--cidfile", str(self.cidfile),
                "--label", LABEL + "=" + self.token, "--network", "none",
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--entrypoint", "/bin/sh", self.image_id, "-c",
                'exec timeout -s KILL "$@"', "zap-disk-probe",
                str(self.lifetime), "/bin/sh", "-c", command,
            ], stdout=subprocess.PIPE, stderr=self.log)
            os.set_blocking(self.process.stdout.fileno(), False)
            deadline = time.monotonic() + self.startup_timeout
            while self.samples.free is None:
                self._refresh()
                if time.monotonic() >= deadline:
                    raise DiskProbeError("Docker disk probe startup timed out before pull")
                if self.samples.free is None:
                    time.sleep(0.05)
            self.container_id = self.cidfile.read_text().strip()
            if not re.fullmatch(r"[a-f0-9]{64}", self.container_id):
                raise DiskProbeError("Probe has no valid bound container ID")
            self.record({"phase": "disk_probe_started", "at": time.time(),
                         "containerName": self.name, "clientPid": self.process.pid,
                         "containerId": self.container_id, "imageId": self.image_id,
                         "lifetimeSec": self.lifetime})
            return self
        except BaseException as error:
            self.__exit__(type(error), error, error.__traceback__)
            raise

    def _refresh(self):
        if self.closed or self.process is None or self.process.poll() is not None:
            raise DiskProbeError("Docker disk probe is not running")
        # Drain a bounded amount without waiting for a partial line or an RPC.
        remaining = 65536
        while remaining:
            try:
                data = os.read(self.process.stdout.fileno(), min(4096, remaining))
            except BlockingIOError:
                break
            if not data:
                raise DiskProbeError("Docker disk sample stream ended")
            remaining -= len(data)
            self.buffer += data
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                try:
                    self.samples.accept(line.decode("ascii"), wall=time.time(), monotonic=time.monotonic())
                except UnicodeError as error:
                    raise DiskProbeError("Invalid Docker disk sample encoding") from error
            if len(self.buffer) > 256:
                raise DiskProbeError("Oversized Docker disk sample")
        if not remaining:
            raise DiskProbeError("Docker disk sample stream exceeded its read budget")

    def snapshot(self):
        self._refresh()
        host_free = shutil.disk_usage(self.root).free
        if type(host_free) is not int or host_free < 0:
            raise DiskProbeError("Invalid Host free-space observation")
        result = {"hostFreeBytes": host_free,
                  "dockerFreeBytes": self.samples.latest(wall=time.time(), monotonic=time.monotonic())}
        self.record({"phase": "disk_probe_sample", "at": time.time(),
                     "containerName": self.name, "sampleAt": self.samples.sample_at,
                     "sampleSequence": self.samples.sequence, **result})
        return result

    def close(self):
        if self.closed:
            return
        self.closed = True
        cleanup_error = None
        try:
            if self.process is not None:
                if self.container_id is None and self.cidfile is not None and self.cidfile.exists():
                    self.container_id = self.cidfile.read_text().strip()
                    if not re.fullmatch(r"[a-f0-9]{64}", self.container_id):
                        raise DiskProbeError("Invalid startup probe container ID")
                found = subprocess.run(["docker", "container", "inspect", self.container_id or self.name],
                                       capture_output=True, text=True, timeout=self.control_timeout)
                if found.returncode == 0:
                    rows = json.loads(found.stdout)
                    if (len(rows) != 1 or rows[0]["Name"] != "/" + self.name
                        or rows[0]["Config"].get("Labels", {}).get(LABEL) != self.token
                        or (self.container_id is not None and rows[0]["Id"] != self.container_id)
                        or not re.fullmatch(r"[a-f0-9]{64}", rows[0]["Id"])):
                        raise DiskProbeError("Probe cleanup ownership mismatch")
                    # Exact owned ID only. Never remove an image or another container.
                    subprocess.run(["docker", "container", "rm", "--force", rows[0]["Id"]],
                                   stdout=self.log, stderr=self.log, check=True, timeout=self.control_timeout)
                elif "No such container" not in found.stderr:
                    raise DiskProbeError("Probe container disposition unknown")
                elif self.container_id is None:
                    # A timed-out create request can finish after this lookup.
                    # Without its CID, absence now is not cleanup confirmation.
                    raise DiskProbeError("Probe startup has no bound ID; late creation is unconfirmed")
        except Exception as error:
            cleanup_error = error
        finally:
            if self.process is not None:
                try:
                    if self.process.poll() is None:
                        self.process.terminate()
                        try:
                            self.process.wait(timeout=self.control_timeout)
                        except subprocess.TimeoutExpired:
                            self.process.kill()
                            self.process.wait(timeout=self.control_timeout)
                except Exception as error:
                    cleanup_error = cleanup_error or error
                finally:
                    self.process.stdout.close()
            self.record({"phase": "disk_probe_closed" if cleanup_error is None else "disk_probe_cleanup_unknown",
                         "at": time.time(), "containerName": self.name,
                         "containerId": self.container_id,
                         "errorType": type(cleanup_error).__name__ if cleanup_error else None})
            if self.temporary is not None and cleanup_error is None:
                self.temporary.cleanup()
        if cleanup_error:
            raise DiskProbeError("Owned disk probe cleanup unconfirmed; inspect its recorded name") from cleanup_error

    def __exit__(self, _kind, error, _traceback):
        try:
            self.close()
        except Exception as cleanup_error:
            if error is None:
                raise
            # Cleanup still fails closed, but must not replace the failure that
            # already rejected admission (for example a crossed disk reserve).
            # close() retains its separate cleanup-unknown observation.
            if hasattr(error, "add_note"):
                error.add_note("Disk probe cleanup unconfirmed (" + type(cleanup_error).__name__
                               + "); inspect owned container " + self.name)
        return False
