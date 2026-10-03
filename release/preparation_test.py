"""Preparation cleanup owns only new files, never a release in recovery."""
from contextlib import ExitStack
import fcntl
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import runtime_transaction as transaction
from release_store import verify


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.platform = transaction.Platform(Path(self.temp.name) / "app")
        self.platform.releases.mkdir(parents=True)

    def archive(self, path, files):
        with tarfile.open(path, "w:gz") as archive:
            for name, value in files.items():
                contents = value.encode()
                info = tarfile.TarInfo(name)
                info.size = len(contents)
                archive.addfile(info, io.BytesIO(contents))

    def stage(self, script="unchanged client"):
        temp = tempfile.TemporaryDirectory(prefix="chessd-deploy-test-", dir="/tmp")
        self.addCleanup(temp.cleanup)
        stage = Path(temp.name)
        for name in ("chessd", "chessd-migrate", "chessd.service"):
            (stage / name).write_text(name)
        (stage / "release.json").write_text(json.dumps({"commitHash": "a" * 40}))
        self.archive(stage / "data.tar.gz", {"puzzles.json": "[]"})
        version = "a" * 16
        self.archive(stage / "web.tar.gz", {
            "index.html": "shell",
            "version.json": json.dumps({"version": version}),
            "asset-manifest.json": json.dumps({"version": version, "assets": [f"/_expo/static/js/web/client.js?v={version}"]}),
            "_expo/static/js/web/client.js": script,
        })
        return stage

    def release_directories(self):
        return sorted(path for path in self.platform.releases.iterdir() if path.is_dir())

    def run_main(self, stage, *, prepare_error=None, bootstrap=None):
        opened_locks = []
        original_open = Path.open
        def tracked_open(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            if path == self.platform.releases / "transaction.lock":
                opened_locks.append(stream)
            return stream
        with ExitStack() as stack:
            stack.enter_context(patch.object(Path, "open", tracked_open))
            stack.enter_context(patch.object(transaction.sys, "argv", ["release", "deploy", "--stage", str(stage)]))
            stack.enter_context(patch.object(transaction, "Platform", return_value=self.platform))
            environment = stack.enter_context(patch.object(transaction, "prepare_environment", side_effect=prepare_error))
            handoff = stack.enter_context(patch.object(transaction, "bootstrap", side_effect=bootstrap))
            # No tested path may advance beyond the handoff boundary into live operations.
            stack.enter_context(patch.object(transaction, "command", side_effect=AssertionError("unexpected host command")))
            stack.enter_context(patch.object(transaction, "http_json", side_effect=AssertionError("unexpected HTTP request")))
            try:
                transaction.main()
            finally:
                self.environment = environment
                self.handoff = handoff
                # The CLI normally exits after main. Keep this in-process fixture
                # from retaining its process-lifetime lock between tests.
                for stream in opened_locks:
                    stream.close()

    def test_corrupt_archive_removes_only_new_directory(self):
        stage = self.stage()
        (stage / "data.tar.gz").write_bytes(b"truncated upload")
        preserved = self.platform.releases / "release-recovery"
        preserved.mkdir()
        (preserved / "evidence").write_text("keep")
        self.platform.journal.write_text(json.dumps({"candidate": {"id": preserved.name}}))
        with self.assertRaises(tarfile.ReadError):
            transaction.stage_release(self.platform, stage, "blue")
        self.assertEqual(self.release_directories(), [preserved])
        self.assertEqual((preserved / "evidence").read_text(), "keep")
        self.assertTrue(self.platform.journal.exists())

    def test_incomplete_manifest_removes_new_directory(self):
        stage = self.stage()
        self.archive(stage / "data.tar.gz", {"other.json": "[]"})
        with self.assertRaisesRegex(ValueError, "Release is incomplete"):
            transaction.stage_release(self.platform, stage, "blue")
        self.assertEqual(self.release_directories(), [])

    def test_immutable_client_mismatch_preserves_previous_release_and_archive(self):
        first = transaction.stage_release(self.platform, self.stage(), "blue")
        first_directory = self.platform.release_dir(first)
        archived = self.platform.root / "client-releases" / ("a" * 16) / "web/_expo/static/js/web/client.js"
        with self.assertRaisesRegex(ValueError, "immutable client version"):
            transaction.stage_release(self.platform, self.stage("changed client under same version"), "green")
        self.assertEqual(self.release_directories(), [first_directory])
        self.assertEqual(archived.read_text(), "unchanged client")
        verify(first_directory)

    def test_directory_collision_never_removes_preexisting_recovery_candidate(self):
        with patch.object(transaction.secrets, "token_hex", return_value="abcdef"), \
                patch.object(transaction.time, "strftime", return_value="20261003t123456z"):
            candidate = transaction.stage_release(self.platform, self.stage(), "blue")
            directory = self.platform.release_dir(candidate)
            original = (directory / "manifest.json").read_bytes()
            self.platform.journal.write_text(json.dumps({"candidate": candidate}))
            with self.assertRaises(FileExistsError):
                transaction.stage_release(self.platform, self.stage(), "blue")
            self.assertEqual((directory / "manifest.json").read_bytes(), original)
            self.assertEqual(self.release_directories(), [directory])
            verify(directory)

    def test_legacy_capture_failure_preserves_production_hardlinks(self):
        stage = self.stage()
        root = self.platform.root
        (root / "bin").mkdir()
        for name in ("chessd", "chessd-migrate"):
            (root / "bin" / name).write_text("live " + name)
        transaction.extract(stage / "web.tar.gz", root / "web")
        transaction.extract(stage / "data.tar.gz", root / "packages/data")
        for fail_at in ("manifest", "archive_client"):
            with self.subTest(fail_at=fail_at), \
                    patch.object(transaction.shutil, "copyfile", side_effect=lambda src, dst: Path(dst).write_text("unit")), \
                    patch.object(transaction, fail_at, side_effect=ValueError("injected preparation failure")):
                with self.assertRaisesRegex(ValueError, "injected preparation failure"):
                    transaction.capture_legacy(self.platform)
                self.assertEqual(self.release_directories(), [])
                self.assertEqual((root / "bin/chessd").read_text(), "live chessd")
                self.assertEqual((root / "web/index.html").read_text(), "shell")
                self.assertEqual((root / "packages/data/puzzles.json").read_text(), "[]")

    def test_controller_removes_input_stage_on_environment_or_extraction_failure(self):
        for fail_at in ("environment", "archive"):
            with self.subTest(fail_at=fail_at):
                stage = self.stage()
                if fail_at == "archive":
                    (stage / "web.tar.gz").write_bytes(b"corrupt browser archive")
                with self.assertRaises((RuntimeError, tarfile.ReadError)):
                    self.run_main(stage, prepare_error=RuntimeError("environment failed") if fail_at == "environment" else None)
                self.assertFalse(stage.exists())
                self.assertEqual(self.release_directories(), [])
                self.handoff.assert_not_called()

    def test_input_stage_removed_under_lock_before_handoff_but_recovery_release_retained(self):
        stage = self.stage()
        def interrupted_handoff(platform, candidate):
            self.assertFalse(stage.exists())
            with (platform.releases / "transaction.lock").open("a+") as contender:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            directory = platform.release_dir(candidate)
            verify(directory)
            platform.journal.write_text(json.dumps({"phase": "prepared", "candidate": candidate}))
            platform.recovery_file.parent.mkdir(parents=True)
            platform.recovery_file.write_bytes(b"latest recovery snapshot")
            raise RuntimeError("interrupted handoff")
        with self.assertRaisesRegex(RuntimeError, "interrupted handoff"):
            self.run_main(stage, bootstrap=interrupted_handoff)
        candidate = json.loads(self.platform.journal.read_text())["candidate"]
        verify(self.platform.release_dir(candidate))
        self.assertEqual(self.platform.recovery_file.read_bytes(), b"latest recovery snapshot")
        self.assertFalse(stage.exists())

    def test_existing_journal_or_lock_never_authorizes_cleanup(self):
        for barrier in ("journal", "lock"):
            with self.subTest(barrier=barrier), ExitStack() as stack:
                stage = self.stage()
                if barrier == "journal":
                    self.platform.journal.write_text(json.dumps({"phase": "prepared"}))
                    stack.callback(self.platform.journal.unlink)
                else:
                    lock = stack.enter_context((self.platform.releases / "transaction.lock").open("a+"))
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(RuntimeError):
                    self.run_main(stage)
                self.assertTrue(stage.exists())
                self.environment.assert_not_called()
                self.handoff.assert_not_called()


if __name__ == "__main__":
    unittest.main()
