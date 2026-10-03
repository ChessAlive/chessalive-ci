import copy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from handoff import Handoff
from release_store import archive_client, extract, manifest, verify
from runtime_transaction import conservative_catalog_idle


class FakePlatform:
    def __init__(self, failure=None, lost_ack=None):
        self.old = {"id": "old"}
        self.new = {"id": "new"}
        self.states = {"old": "active", "new": "stopped"}
        self.gate = "active"
        self.current = "old"
        self.pending = None
        self.writer = "old"
        self.events = []
        self.failure = failure
        self.lost_ack = lost_ack
        self.failed = False
        self.value = {"old": 7, "new": 0}
        self.old_starts = 0

    def event(self, name, after=False):
        if not after:
            self.events.append(name)
        target = self.lost_ack if after else self.failure
        if not self.failed and name == target:
            self.failed = True
            raise RuntimeError("injected failure")

    def begin(self, current, candidate):
        self.event("begin")

    def phase(self, phase):
        self.event("phase/" + phase)

    def gateway(self, action, data=None, method="POST"):
        name = "gateway/" + action
        self.event(name)
        if action == "hold":
            self.gate = "held"
        elif action == "switch":
            self.pending = data["upstream"]
            self.gate = "prepared"
            # Candidate authentication/Attach is allowed to persist newer room state.
            self.value[self.pending] += 2
        elif action == "resume":
            assert self.writer == self.pending
            self.current = self.pending
            self.gate = "active"
        elif action == "abort":
            assert self.writer == self.current
            self.gate = "active"
        self.event(name, after=True)
        return {"phase": self.gate, "currentUpstream": self.current}

    def runtime(self, release, action, data=None, method="POST"):
        identity = release["id"]
        name = identity + "/" + action
        self.event(name)
        if action == "quiesce":
            assert self.gate != "active"
            self.states[identity] = "quiesced"
            self.writer = None
        elif action == "snapshot":
            assert self.states[identity] == "quiesced"
            return {"schemaVersion": 1, "value": self.value[identity]}
        elif action == "restore":
            assert self.writer is None, "two writers overlap"
            assert self.states[identity] == "standby"
            self.writer = identity
            self.value[identity] = data["value"]
            self.states[identity] = "prepared"
        elif action == "resume":
            assert self.writer in (None, identity), "two writers overlap"
            self.states[identity] = "active"
            self.writer = identity
        self.event(name, after=True)
        return {"state": self.states[identity]}

    def start(self, release):
        identity = release["id"]
        self.event(identity + "/start")
        self.states[identity] = "standby"
        self.old_starts += identity == "old"

    def stop(self, release):
        identity = release["id"]
        self.event(identity + "/stop")
        self.states[identity] = "stopped"
        if self.writer == identity:
            self.writer = None

    def upstream(self, release):
        return release["id"]

    def publish_active(self, release):
        self.event("publish/" + (release["id"] if release else "none"))

    def save_recovery(self, current, candidate, snapshot):
        self.event("save")
        self.saved = copy.deepcopy(snapshot)

    def health(self, release):
        self.event(release["id"] + "/health")

    def complete(self, current, candidate):
        self.event("complete")

    def recovered(self, current):
        self.event("recovered")


class HandoffTests(unittest.TestCase):
    def test_fresh_catalog_probe_never_treats_unknown_or_active_events_as_idle(self):
        now = 1_800_000_000_000
        catalog = lambda event: {"schemaVersion": 1, "events": {"event": event}}
        for event in ({"status": "live"}, {"status": "registration"}, {"status": "unknown"},
                      {"status": "registration", "startsAt": now + 3_599_999},
                      {"status": "finished", "finishedAt": now - 3_599_999}):
            self.assertFalse(conservative_catalog_idle(catalog(event), now))
        for event in ({"status": "cancelled"}, {"status": "draft"},
                      {"status": "registration", "startsAt": now + 3_600_001},
                      {"status": "finished", "finishedAt": now - 3_600_001}):
            self.assertTrue(conservative_catalog_idle(catalog(event), now))
        self.assertFalse(conservative_catalog_idle({}, now))
        self.assertFalse(conservative_catalog_idle({"schemaVersion": 2, "events": {}}, now))
        self.assertTrue(conservative_catalog_idle(None, now))

    def test_success_is_single_writer_with_final_barrier(self):
        p = FakePlatform()
        Handoff(p).run(p.old, p.new)
        self.assertEqual(p.current, "new")
        self.assertEqual(p.value["new"], 9)
        self.assertEqual(p.states["old"], "stopped")
        self.assertLess(p.events.index("old/quiesce"), p.events.index("old/snapshot"))
        self.assertEqual(p.events.count("gateway/hold"), 2)
        self.assertLess(p.events.index("new/health"), p.events.index("gateway/resume"))

    def test_recoverable_failures_restore_a_single_healthy_writer(self):
        for failure in ("gateway/hold", "old/quiesce", "old/snapshot", "new/start", "new/restore", "gateway/switch", "new/resume", "new/health", "gateway/resume"):
            with self.subTest(failure=failure):
                p = FakePlatform(failure=failure)
                with self.assertRaises(RuntimeError):
                    Handoff(p).run(p.old, p.new)
                self.assertEqual((p.current, p.writer, p.gate), ("old", "old", "active"))
                if failure not in ("gateway/hold", "old/quiesce"):
                    self.assertEqual(p.old_starts, 1, "a frozen old cache must not resume")

    def test_latest_candidate_writes_survive_rollback(self):
        p = FakePlatform(failure="new/health")
        with self.assertRaises(RuntimeError):
            Handoff(p).run(p.old, p.new)
        self.assertEqual(p.saved["value"], 9)
        self.assertEqual(p.value["old"], 11)  # latest state + fresh reattach, never old value 7

    def test_lost_control_acknowledgements_are_reconciled(self):
        for ack in ("old/quiesce", "new/restore", "gateway/switch", "new/resume"):
            with self.subTest(ack=ack):
                p = FakePlatform(lost_ack=ack)
                with self.assertRaises(RuntimeError):
                    Handoff(p).run(p.old, p.new)
                self.assertEqual((p.current, p.writer, p.gate), ("old", "old", "active"))
        p = FakePlatform(lost_ack="gateway/resume")
        Handoff(p).run(p.old, p.new)
        self.assertEqual(p.current, "new")
        self.assertNotIn("old/start", p.events)


class ReleaseStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def make_release(self, name, version, script=b"same bytes"):
        root = self.root / name
        for path, value in {"chessd": b"server", "chessd-migrate": b"migrate", "chessd.service": b"unit",
                            "packages/data/puzzles.json": b"[]", "web/index.html": b"shell",
                            "web/version.json": json.dumps({"version": version}).encode(),
                            "web/fonts/shared-0123456789abcdef.woff2": b"shared font",
                            "web/_expo/static/js/web/reused.js": script}.items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)
        manifest(root, {"commitHash": "a" * 40})
        return root

    def test_checksum_failure_refuses_modified_fallback(self):
        release = self.make_release("one", "a" * 16)
        verify(release)
        (release / "chessd").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            verify(release)

    def test_client_versions_preserve_changed_reused_names_and_deduplicate(self):
        one = self.make_release("one", "a" * 16)
        two = self.make_release("two", "b" * 16, b"new bytes")
        archive = self.root / "archive"
        archive_client(one, archive)
        archive_client(two, archive)
        self.assertEqual((archive / ("a" * 16) / "web/_expo/static/js/web/reused.js").read_bytes(), b"same bytes")
        self.assertEqual((archive / ("b" * 16) / "web/_expo/static/js/web/reused.js").read_bytes(), b"new bytes")
        self.assertEqual((archive / ("a" * 16) / "web/fonts/shared-0123456789abcdef.woff2").stat().st_ino,
                         (archive / ("b" * 16) / "web/fonts/shared-0123456789abcdef.woff2").stat().st_ino)
        self.assertFalse((archive / ("a" * 16) / "web/index.html").exists())
        self.assertFalse((archive / ("a" * 16) / "chessd").exists())
        # Removing the full old runnable build cannot break its browser assets.
        import shutil
        shutil.rmtree(one)
        self.assertEqual((archive / ("a" * 16) / "web/_expo/static/js/web/reused.js").read_bytes(), b"same bytes")

    def test_client_version_is_immutable(self):
        one = self.make_release("one", "a" * 16)
        two = self.make_release("two", "a" * 16, b"different bytes")
        archive_client(one, self.root / "archive")
        with self.assertRaises(ValueError):
            archive_client(two, self.root / "archive")

    def test_archive_rejects_traversal_and_links(self):
        for filename, item_type in (("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE)):
            with self.subTest(filename=filename):
                path = self.root / "unsafe.tar.gz"
                with tarfile.open(path, "w:gz") as archive:
                    info = tarfile.TarInfo(filename)
                    info.type = item_type
                    info.linkname = "/etc/passwd"
                    info.size = 0
                    archive.addfile(info, io.BytesIO())
                with self.assertRaises(ValueError):
                    extract(path, self.root / "extracted")


if __name__ == "__main__":
    unittest.main()
