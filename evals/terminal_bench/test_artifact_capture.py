import pathlib
import tempfile
import unittest
from unittest.mock import patch
from evals.terminal_bench import artifact_capture as capture
from evals.terminal_bench.test_artifact_scope import pair


class ArtifactCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.files = {"/app/shared.txt": b"PARENT", "/isolated/child/shared.txt": b"CHILD"}
        self.reads = []

    def read(self, container, *args):
        self.reads.append(args)
        if args[0] == "pwd": return b"/app\n"
        path = args[-1]
        if args[0] == "readlink": return (path + "\n").encode()
        if args[0] == "stat": return str(len(self.files[path])).encode()
        if args[0] == "sha256sum": return (capture.sha(self.files[path]) + "  " + path).encode()
        if args[0] == "head": return self.files[path]
        raise AssertionError(args)

    def invoke(self, events, **options):
        with patch.object(capture, "container_read", side_effect=self.read), \
             patch.object(capture, "run") as run:
            run.return_value.returncode = 0
            return capture.capture(self.root, "owned-container", b"STREAM", events, **options)

    def test_parent_and_child_same_basename_have_distinct_records_and_bytes(self):
        report = self.invoke(pair() + pair(("child",)), workspaces={("child",): "/isolated/child"})
        rows = report["files"]
        self.assertEqual([pathlib.Path(r["capture"]).read_bytes() for r in rows], [b"PARENT", b"CHILD"])
        self.assertNotEqual(rows[0]["capture"], rows[1]["capture"])
        self.assertTrue(all(r["status"] == "captured_matching" for r in rows))
        self.assertEqual(report["capturedBytes"], 11)
        self.assertEqual(rows[1]["agentPath"], ["child"])

    def test_unbound_child_never_reads_parent_or_guesses_its_root(self):
        report = self.invoke(pair(("child",)))
        self.assertEqual(report["files"][0]["status"], "workspace_unproven")
        self.assertTrue(all(args[0] in ("pwd", "readlink") for args in self.reads))
        self.assertEqual(report["capturedBytes"], 0)

    def test_realpath_escape_is_skipped_before_reading_bytes(self):
        real = self.read
        def read(container, *args):
            if args[0] == "readlink" and args[-1] == "/app/shared.txt": return b"/secrets/foreign\n"
            return real(container, *args)
        with patch.object(capture, "container_read", side_effect=read):
            report = capture.capture(self.root, "owned", b"STREAM", pair())
        self.assertEqual(report["files"][0]["status"], "outside_workspace_skipped")
        self.assertFalse(any(args[0] in ("stat", "head") for args in self.reads))

    def test_hash_mismatch_remains_changed_not_verified(self):
        real = self.read
        def read(container, *args):
            return b"CHANGED" if args[0] == "head" else real(container, *args)
        with patch.object(capture, "container_read", side_effect=read), patch.object(capture, "run") as run:
            run.return_value.returncode = 0
            report = capture.capture(self.root, "owned", b"STREAM", pair())
        self.assertEqual(report["files"][0]["status"], "changed_during_capture")

    def test_oversized_file_never_reads_payload(self):
        self.files["/app/shared.txt"] = b"x" * (capture.FILE_LIMIT + 1)
        report = self.invoke(pair())
        self.assertEqual(report["files"][0]["status"], "size_limit_skipped")
        self.assertFalse(any(args[0] == "head" for args in self.reads))

    def test_same_final_content_keeps_all_calls_without_duplicate_storage(self):
        report = self.invoke(pair(call_id="first") + pair(call_id="second"))
        self.assertEqual(len(report["files"]), 2)
        self.assertEqual(report["files"][0]["capture"], report["files"][1]["capture"])
        self.assertEqual(report["capturedBytes"], len(b"PARENT"))

    def test_literal_trailing_whitespace_is_not_trimmed_into_another_file(self):
        for filename in ["shared.txt ", "shared.txt\n"]:
            self.files["/app/" + filename] = b"LITERAL"
            report = self.invoke(pair(filename=filename))
            row = report["files"][0]
            self.assertEqual(row["resolvedPath"], "/app/" + filename)
            self.assertEqual(row["status"], "captured_matching")
            self.assertEqual(pathlib.Path(row["capture"]).read_bytes(), b"LITERAL")

    def test_checksums_handle_gnu_escaped_names_and_reject_malformed_records(self):
        expected = capture.sha(b"LITERAL")
        self.assertEqual(capture.checksum_output(("\\" + expected + "  filename\\n\n").encode()), expected)
        self.assertEqual(capture.checksum_output((expected + "  file\n").encode()), expected)
        for value in [b"", b"not-a-hash", b"g" * 64 + b"  file"]:
            with self.assertRaises(ValueError): capture.checksum_output(value)

    def test_timeout_is_explicit_failed_capture_and_never_executes_payload(self):
        real = self.read
        def read(container, *args):
            if args[0] == "head": raise capture.subprocess.TimeoutExpired("docker exec head", 20)
            return real(container, *args)
        with patch.object(capture, "container_read", side_effect=read), patch.object(capture, "run") as run:
            run.return_value.returncode = 0
            report = capture.capture(self.root, "owned", b"STREAM", pair())
        self.assertEqual(report["files"][0]["status"], "capture_failed")
        self.assertEqual(report["files"][0]["errorType"], "TimeoutExpired")


if __name__ == "__main__": unittest.main()
