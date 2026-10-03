"""Browser archive compatibility uses the same paths and authorization as chessgate."""
import json
from pathlib import Path
import tempfile
import unittest

from release_store import archive_client, manifest, verify

VERSION = "a" * 16
SCRIPT = "_expo/static/js/web/reused.js"
IMAGE = "assets/piece-0123456789abcdef.png"


class ImmutableClientControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "archive"

    def release(self, name, changes=None, asset_urls=None):
        root = self.root / name
        assets = asset_urls if asset_urls is not None else [f"/{SCRIPT}?v={VERSION}", f"/{IMAGE}", f"/.route-shells/play.json?v={VERSION}", "/index.html"]
        files = {
            "chessd": "server", "chessd-migrate": "migrate", "chessd.service": "unit",
            "packages/data/puzzles.json": "[]", "web/index.html": "shell v1",
            "web/play/index.html": "route v1", "web/.route-shells/play.html": "internal HTML v1",
            "web/version.json": json.dumps({"version": VERSION}),
            "web/asset-manifest.json": json.dumps({"version": VERSION, "assets": assets, "critical": []}),
            "web/sw.js": "worker v1", "web/metadata.json": "metadata v1",
            "web/" + SCRIPT: "unchanged JS", "web/" + SCRIPT + ".br": "compressed JS",
            "web/" + IMAGE: "hashed image", "web/" + IMAGE + ".gz": "compressed image",
            "web/.route-shells/play.json": "route data",
        }
        files.update(changes or {})
        for filename, text in files.items():
            target = root / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        manifest(root, {"commitHash": "b" * 40})
        return root

    def test_worker_metadata_and_html_can_change_with_same_asset_version(self):
        first = self.release("first")
        second = self.release("second", {
            "chessd": "updated server", "web/sw.js": "new no-reload worker",
            "web/version.json": json.dumps({"version": VERSION, "reset": "new metadata"}),
            "web/metadata.json": "new exporter metadata", "web/index.html": "new shell reset token",
            "web/play/index.html": "new route reset token", "web/.route-shells/play.html": "new injected metadata",
            "web/asset-manifest.json": json.dumps({"version": VERSION, "assets": [f"/{SCRIPT}?v={VERSION}", f"/{IMAGE}", f"/.route-shells/play.json?v={VERSION}", "/index.html"], "critical": [f"/{SCRIPT}?v={VERSION}"], "reset": "new metadata"}),
        })
        archive_client(first, self.archive)
        self.assertEqual(archive_client(second, self.archive), VERSION)
        self.assertEqual((self.archive / VERSION / "web" / SCRIPT).read_text(), "unchanged JS")
        self.assertEqual((second / "web/sw.js").read_text(), "new no-reload worker")
        verify(second)

    def test_immutable_assets_and_compressed_sidecars_cannot_change(self):
        first = self.release("first")
        archive_client(first, self.archive)
        for index, path in enumerate((SCRIPT, SCRIPT + ".br", IMAGE, IMAGE + ".gz", ".route-shells/play.json")):
            with self.subTest(path=path):
                second = self.release("changed-" + str(index), {"web/" + path: "different immutable bytes"})
                with self.assertRaisesRegex(ValueError, "immutable client version"):
                    archive_client(second, self.archive)

    def test_manifest_cannot_change_an_archived_paths_routing_authorization(self):
        first = self.release("first")
        archive_client(first, self.archive)
        second = self.release("second", asset_urls=[f"/{IMAGE}", f"/.route-shells/play.json?v={VERSION}"])
        with self.assertRaisesRegex(ValueError, "immutable client version"):
            archive_client(second, self.archive)

    def test_unserved_stable_paths_and_navigation_urls_do_not_become_immutable(self):
        extras = [f"/{SCRIPT}?v={VERSION}", f"/{IMAGE}", f"/.route-shells/play.json?v={VERSION}", "/index.html", f"/.route-shells/play.html?v={VERSION}", "/assets/current.png", "/sw.js", "/version.json"]
        first = self.release("first", {"web/assets/current.png": "old unused stable file"}, extras)
        second = self.release("second", {"web/assets/current.png": "new stable file", "web/.route-shells/play.html": "new HTML", "web/sw.js": "new worker"}, extras)
        archive_client(first, self.archive)
        self.assertEqual(archive_client(second, self.archive), VERSION)


if __name__ == "__main__":
    unittest.main()
