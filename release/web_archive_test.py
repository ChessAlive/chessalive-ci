import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from release_store import digest, extract, inventory
from web_archive import DELTA_INDEX, write_archive


class WebTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "releases/release-old"
        self.base_web = self.base / "web"
        self.build = self.root / "build"
        self.destination = self.root / "releases/release-new/web"
        self.write(self.base_web, {"index.html": b"old shell", "assets/unchanged.png": b"exact picture",
                                   "removed.js": b"removed", "manifest.json": b"old public manifest"})
        self.write(self.build, {"index.html": b"new shell", "assets/unchanged.png": b"exact picture",
                                ".route-shells/new.json": b"new route", "manifest.json": b"new public manifest"})
        checksums = {"web/" + name: digest(path) for name, path in self.paths(self.base_web).items()}
        self.metadata = {"schemaVersion": 1, "complete": True, "files": checksums}
        (self.base / "manifest.json").write_text(json.dumps(self.metadata))

    def paths(self, root):
        return {path.relative_to(root).as_posix(): path for path in root.rglob("*") if path.is_file()}

    def write(self, root, files):
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)

    def archive(self, baseline=True):
        data = io.BytesIO()
        write_archive(self.build, {"releaseId": "release-old", "manifest": self.metadata} if baseline else {}, data)
        path = self.root / "web.tar.gz"
        path.write_bytes(data.getvalue())
        return path

    def rewrite(self, archive, mutate):
        entries = []
        with tarfile.open(archive) as source:
            for item in source:
                entries.append((item.name, source.extractfile(item).read()))
        entries = mutate(entries)
        with tarfile.open(archive, "w:gz") as output:
            for name, data in entries:
                item = tarfile.TarInfo(name)
                item.size = len(data)
                output.addfile(item, io.BytesIO(data))

    def test_delta_recreates_exact_tree_and_reuses_without_mutating_baseline(self):
        archive = self.archive()
        with tarfile.open(archive) as source:
            names = source.getnames()
        self.assertNotIn("assets/unchanged.png", names)
        extract(archive, self.destination)
        self.assertEqual({k: p.read_bytes() for k, p in self.paths(self.destination).items()},
                         {k: p.read_bytes() for k, p in self.paths(self.build).items()})
        self.assertEqual((self.destination / "assets/unchanged.png").stat().st_ino,
                         (self.base_web / "assets/unchanged.png").stat().st_ino)
        self.assertEqual((self.base_web / "index.html").read_bytes(), b"old shell")
        self.assertTrue((self.base_web / "removed.js").exists())
        self.assertFalse((self.destination / "removed.js").exists())

    def test_no_baseline_sends_a_complete_legacy_compatible_archive(self):
        archive = self.archive(False)
        with tarfile.open(archive) as source:
            self.assertNotIn(DELTA_INDEX, source.getnames())
        extract(archive, self.destination)
        self.assertEqual(inventory(self.destination), inventory(self.build))
        self.assertEqual((self.destination / "manifest.json").read_bytes(), b"new public manifest")

    def test_corrupt_baseline_fails_before_linking(self):
        archive = self.archive()
        (self.base_web / "assets/unchanged.png").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "baseline checksum"):
            extract(archive, self.destination)

    def test_missing_baseline_fails(self):
        archive = self.archive()
        (self.base / "manifest.json").unlink()
        with self.assertRaisesRegex(ValueError, "baseline is unavailable"):
            extract(archive, self.destination)

    def test_missing_changed_file_fails(self):
        archive = self.archive()
        self.rewrite(archive, lambda entries: entries[:-1])
        with self.assertRaisesRegex(ValueError, "incomplete"):
            extract(archive, self.destination)

    def test_corrupt_changed_file_fails(self):
        archive = self.archive()
        self.rewrite(archive, lambda entries: [*entries[:-1], (entries[-1][0], b"corrupt")])
        with self.assertRaisesRegex(ValueError, "payload checksum"):
            extract(archive, self.destination)

    def test_duplicate_changed_file_fails(self):
        archive = self.archive()
        self.rewrite(archive, lambda entries: [*entries, entries[-1]])
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            extract(archive, self.destination)

    def test_traversal_and_linked_payloads_are_rejected(self):
        for malicious in ("../outside", "/outside", "safe/../../outside"):
            with self.subTest(name=malicious):
                archive = self.archive()
                def rewrite(entries):
                    plan = json.loads(entries[0][1])
                    plan["files"][malicious] = "a" * 64
                    return [(DELTA_INDEX, json.dumps(plan).encode()), *entries[1:]]
                self.rewrite(archive, rewrite)
                with self.assertRaisesRegex(ValueError, "inventory"):
                    extract(archive, self.destination)

    def test_symlinks_in_build_and_baseline_are_rejected(self):
        archive = self.archive()
        original = self.base_web / "assets/unchanged.png"
        original.unlink()
        original.symlink_to(self.build / "assets/unchanged.png")
        with self.assertRaisesRegex(ValueError, "baseline checksum"):
            extract(archive, self.destination)
        (self.build / "unsafe").symlink_to(original)
        with self.assertRaisesRegex(ValueError, "symbolic links"):
            self.archive()


if __name__ == "__main__":
    unittest.main()
