import io
import subprocess
import sys
import unittest
from unittest.mock import patch

from evals.terminal_bench import image_pull_guard as guard


def space(host=100, docker=100):
    return {"hostFreeBytes": host, "dockerFreeBytes": docker}


class Client:
    pid = 123
    def __init__(self, codes=(None, 0), stubborn=False):
        self.codes = iter(codes)
        self.code = None
        self.stubborn = stubborn
        self.terminated = self.killed = False
    def poll(self):
        self.code = next(self.codes, self.code)
        return self.code
    def terminate(self): self.terminated = True
    def kill(self): self.killed = True
    def wait(self, timeout):
        if self.stubborn and not self.killed:
            raise subprocess.TimeoutExpired("docker", timeout)
        self.codes = iter(())
        self.code = -9 if self.killed else -15
        return self.code


class GuardTests(unittest.TestCase):
    def run_pull(self, snapshots, client=None, **options):
        observations = iter(snapshots)
        entries = []
        def snapshot():
            value = next(observations)
            if isinstance(value, Exception): raise value
            return value
        client = client or Client()
        with patch.object(guard.subprocess, "Popen", return_value=client) as spawn, patch.object(guard.time, "sleep"):
            result = guard.guarded_pull("registry.example/image:original", snapshot=snapshot,
                reserve_bytes=50, record=entries.append, log=io.StringIO(), **options)
        return result, entries, spawn

    def test_success_keeps_original_command_and_requires_post_admission(self):
        result, entries, spawn = self.run_pull([space(), space(), space(50, 50)])
        self.assertEqual(spawn.call_args.args[0], ["docker", "pull", "--platform", "linux/amd64", "registry.example/image:original"])
        self.assertTrue(result["postPullAdmissionRequired"])
        self.assertEqual([e["phase"] for e in entries], ["before_pull", "during_pull", "after_pull"])

    def test_low_host_or_daemon_space_stops_before_launch(self):
        for observed in [space(49), space(docker=49), space(0)]:
            with patch.object(guard.subprocess, "Popen") as spawn:
                with self.assertRaises(guard.PullCapacityError):
                    guard.guarded_pull("image", snapshot=lambda: observed, reserve_bytes=50, record=lambda e: None, log=io.StringIO())
                spawn.assert_not_called()

    def test_drop_during_pull_terminates_owned_client_without_retry(self):
        for observed in [space(49), space(docker=49)]:
            client = Client((None, None, None))
            with self.assertRaises(guard.PullCapacityError):
                self.run_pull([space(), observed], client)
            self.assertTrue(client.terminated)
            self.assertIsNotNone(client.code)

    def test_missing_or_bad_observation_fails_closed(self):
        for observed in [{}, space(False), space(-1), space(float("nan")), space(1.5), OSError("probe failed")]:
            client = Client((None, None, None))
            with self.assertRaises((ValueError, OSError)):
                self.run_pull([space(), observed], client)
            self.assertTrue(client.terminated)

    def test_successful_client_exit_cannot_hide_capacity_breach(self):
        client = Client((0, 0))
        with self.assertRaises(guard.PullCapacityError): self.run_pull([space(), space(49)], client)
        self.assertFalse(client.terminated)

    def test_nonzero_exit_preserved(self):
        with self.assertRaisesRegex(guard.PullCapacityError, "exit 7"):
            self.run_pull([space(), space()], Client((7, 7)))

    def test_termination_timeout_escalates_only_owned_child(self):
        client = Client((None, None, None), stubborn=True)
        with self.assertRaises(guard.PullCapacityError): self.run_pull([space(), space(49)], client)
        self.assertTrue(client.terminated)
        self.assertTrue(client.killed)

    def test_pull_deadline_is_terminal(self):
        with patch.object(guard.time, "monotonic", side_effect=[0, 0, 0, 0, 2]):
            client = Client((None, None, None))
            with self.assertRaisesRegex(guard.PullCapacityError, "deadline"):
                self.run_pull([space(), space()], client, timeout_sec=1)
            self.assertTrue(client.terminated)

    def test_unconfirmed_termination_never_returns_a_ready_result(self):
        client = Client((None, None, None))
        with patch.object(client, "wait", side_effect=subprocess.TimeoutExpired("docker", 1)):
            with self.assertRaisesRegex(guard.PullCapacityError, "termination remains unconfirmed"):
                self.run_pull([space(), space(49)], client)
        self.assertTrue(client.killed)

    def test_slow_pre_pull_probe_cannot_launch_after_deadline(self):
        with patch.object(guard.time, "monotonic", side_effect=[0, 2, 2]), \
             patch.object(guard.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(guard.PullCapacityError, "before launch"):
                guard.guarded_pull("image", snapshot=space, reserve_bytes=50,
                    record=lambda entry: None, log=io.StringIO(), timeout_sec=1)
            spawn.assert_not_called()

    def test_persistence_error_stops_before_launch(self):
        with patch.object(guard.subprocess, "Popen") as spawn:
            with self.assertRaises(OSError):
                guard.guarded_pull("image", snapshot=space, reserve_bytes=50,
                    record=lambda e: (_ for _ in ()).throw(OSError("disk write failed")), log=io.StringIO())
            spawn.assert_not_called()

    def test_persistence_error_during_pull_stops_owned_client(self):
        client = Client((None, None, None))
        count = 0
        def record(entry):
            nonlocal count
            count += 1
            if count == 2: raise OSError("disk write failed")
        with patch.object(guard.subprocess, "Popen", return_value=client):
            with self.assertRaises(OSError):
                guard.guarded_pull("image", snapshot=space, reserve_bytes=50, record=record, log=io.StringIO())
        self.assertTrue(client.terminated)
        self.assertIsNotNone(client.poll())

    def test_bad_options_cannot_start_client(self):
        for options in [{"reserve_bytes": False}, {"reserve_bytes": 0}, {"interval_sec": 0},
                        {"timeout_sec": float("inf")}, {"terminate_grace_sec": -1}, {"image_ref": "--all-tags"}]:
            args = {"image_ref": "image", "snapshot": space, "reserve_bytes": 50,
                    "record": lambda entry: None, "log": io.StringIO(), **options}
            with patch.object(guard.subprocess, "Popen") as spawn:
                with self.assertRaises(ValueError): guard.guarded_pull(**args)
                spawn.assert_not_called()

    def test_real_owned_child_is_reaped_on_synthetic_capacity_drop(self):
        popen = subprocess.Popen
        clients = []
        def start(*args, **kwargs):
            client = popen([sys.executable, "-c", "import time; time.sleep(30)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            clients.append(client)
            return client
        observations = iter([space(), space(49)])
        entries = []
        with patch.object(guard.subprocess, "Popen", side_effect=start):
            with self.assertRaises(guard.PullCapacityError):
                guard.guarded_pull("image", snapshot=lambda: next(observations), reserve_bytes=50, record=entries.append, log=io.StringIO())
        self.assertIsNotNone(clients[0].poll())
        self.assertEqual(entries[-1]["daemonQuiescence"], "unproven")


if __name__ == "__main__": unittest.main()
