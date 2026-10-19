import io
import json
import subprocess
import time
import unittest
from unittest.mock import patch, Mock

from evals.terminal_bench.docker_disk_probe import DiskSamples, DockerDiskProbe, DiskProbeError, LABEL
from evals.terminal_bench.image_pull_guard import PullCapacityError


class SampleTests(unittest.TestCase):
    def test_zero_and_boundary_values_are_preserved(self):
        state = DiskSamples("token")
        state.accept("token 1 100 0", wall=100, monotonic=10)
        self.assertEqual(state.latest(wall=105, monotonic=15), 0)

    def test_wall_and_monotonic_freshness_are_both_required(self):
        for wall, mono in [(106, 11), (100, 16), (97, 11), (101, 9)]:
            state = DiskSamples("token")
            state.accept("token 1 100 20", wall=100, monotonic=10)
            with self.assertRaises(DiskProbeError):
                state.latest(wall=wall, monotonic=mono)

    def test_delayed_buffer_cannot_refresh_an_old_sample(self):
        state = DiskSamples("token")
        with self.assertRaises(DiskProbeError):
            state.accept("token 1 100 20", wall=110, monotonic=1000)

    def test_malformed_duplicate_skipped_and_foreign_frames_fail_closed(self):
        for line in ["wrong 1 100 10", "token 0 100 10", "token 2 100 10",
                     "token 1 100 -1", "token 1 100 nan", "token 1 100 1.5",
                     "token 1 103 10", "token 1 100 " + "1"*300]:
            with self.subTest(line=line):
                with self.assertRaises(DiskProbeError):
                    DiskSamples("token").accept(line, wall=100, monotonic=10)
        state = DiskSamples("token")
        state.accept("token 1 100 10", wall=100, monotonic=10)
        with self.assertRaises(DiskProbeError):
            state.accept("token 1 100 10", wall=100, monotonic=10)

    def test_snapshot_does_not_issue_docker_commands(self):
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=lambda x: None, log=io.StringIO())
        probe.process = Mock()
        probe.process.poll.return_value = None
        probe.process.stdout.fileno.return_value = 7
        probe.samples.accept(f"{probe.token} 1 {int(time.time())} 123", wall=time.time(), monotonic=time.monotonic())
        with patch("os.read", side_effect=BlockingIOError), patch("subprocess.run") as run, patch("subprocess.Popen") as spawn:
            self.assertEqual(probe.snapshot()["dockerFreeBytes"], 123*1024)
            probe.snapshot()
        run.assert_not_called()
        spawn.assert_not_called()

    def test_partial_line_never_blocks_and_eof_is_not_a_fresh_sample(self):
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=lambda x: None, log=io.StringIO())
        probe.process = Mock()
        probe.process.poll.return_value = None
        with patch("os.read", side_effect=[b"partial", BlockingIOError]):
            probe._refresh()
        self.assertEqual(probe.buffer, b"partial")
        with patch("os.read", return_value=b""):
            with self.assertRaises(DiskProbeError):
                probe._refresh()

    def test_cleanup_never_removes_a_container_with_other_ownership(self):
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=lambda x: None, log=io.StringIO())
        probe.process = Mock()
        probe.process.poll.return_value = 0
        import json
        row = {"Id": "b"*64, "Name": "/"+probe.name, "Config": {"Labels": {LABEL: "other"}}}
        with patch("subprocess.run", return_value=Mock(returncode=0, stdout=json.dumps([row]))) as run:
            with self.assertRaises(DiskProbeError):
                probe.close()
        self.assertEqual(run.call_count, 1)

    def test_unpinned_image_cannot_start_a_probe(self):
        for image in ["alpine:latest", "--privileged", "sha256:bad"]:
            with self.assertRaises(ValueError):
                DockerDiskProbe("/", image_id=image, record=lambda x: None, log=io.StringIO())

    def test_cleanup_cannot_substitute_another_id_even_with_same_name_and_label(self):
        import json
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=lambda x: None, log=io.StringIO())
        probe.container_id = "a"*64
        probe.process = Mock()
        probe.process.poll.return_value = 0
        row = {"Id": "b"*64, "Name": "/"+probe.name, "Config": {"Labels": {LABEL: probe.token}}}
        with patch("subprocess.run", return_value=Mock(returncode=0, stdout=json.dumps([row]))) as run:
            with self.assertRaises(DiskProbeError):
                probe.close()
        self.assertEqual(run.call_count, 1)

    def test_absence_without_a_startup_id_does_not_certify_cleanup(self):
        events = []
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=events.append, log=io.StringIO())
        probe.process = Mock()
        probe.process.poll.return_value = 125
        with patch("subprocess.run", return_value=Mock(returncode=1, stderr="No such container")):
            with self.assertRaisesRegex(DiskProbeError, "unconfirmed"):
                probe.close()
        self.assertEqual(events[-1]["phase"], "disk_probe_cleanup_unknown")

    def test_capacity_failure_survives_a_simultaneous_owned_cleanup_timeout(self):
        events = []
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=events.append, log=io.StringIO())
        probe.container_id = "b"*64
        probe.process = Mock()
        probe.process.poll.return_value = 143
        row = {"Id": probe.container_id, "Name": "/"+probe.name,
               "Config": {"Labels": {LABEL: probe.token}}}
        primary = PullCapacityError("Free space reached the reserved pull boundary")
        with patch.object(DockerDiskProbe, "__enter__", return_value=probe), patch("subprocess.run", side_effect=[
            Mock(returncode=0, stdout=json.dumps([row])), subprocess.TimeoutExpired("docker rm", 5),
        ]) as run:
            with self.assertRaises(PullCapacityError) as caught:
                with probe:
                    raise primary
        self.assertIs(caught.exception, primary)
        self.assertEqual(run.call_args_list[-1].args[0][-1], probe.container_id)
        self.assertEqual(events[-1]["phase"], "disk_probe_cleanup_unknown")
        self.assertEqual(events[-1]["errorType"], "TimeoutExpired")
        if hasattr(primary, "__notes__"):
            self.assertIn(probe.name, primary.__notes__[-1])

    def test_cleanup_failure_without_an_earlier_error_still_rejects_admission(self):
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=lambda x: None, log=io.StringIO())
        with patch.object(probe, "close", side_effect=DiskProbeError("cleanup unconfirmed")):
            with self.assertRaisesRegex(DiskProbeError, "cleanup unconfirmed"):
                probe.__exit__(None, None, None)

    def test_startup_failure_survives_cleanup_failure(self):
        probe = DockerDiskProbe("/", image_id="sha256:"+"a"*64, record=lambda x: None, log=io.StringIO())
        primary = OSError("Docker unavailable before startup")
        with patch("subprocess.Popen", side_effect=primary), patch.object(
            probe, "close", side_effect=DiskProbeError("cleanup unconfirmed")
        ):
            with self.assertRaises(OSError) as caught:
                probe.__enter__()
        probe.temporary.cleanup()
        self.assertIs(caught.exception, primary)
