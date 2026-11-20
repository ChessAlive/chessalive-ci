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

    def test_resumable_route_shells_must_match_index_and_exist_on_disk(self):
        loader = (
            f'<script data-ca-resumable-loader>window.__caShellVersion="{VERSION}";'
            f'var sources=["/{SCRIPT}?v={VERSION}"];</script>'
        )
        good = {
            "web/index.html": loader,
            "web/.route-shells/routes.json": json.dumps({"routes": ["/", "/play"]}),
            "web/.route-shells/home.html": loader,
            "web/.route-shells/play.html": loader,
        }
        rel = self.release("resumable-ok", good)
        verify(rel)
        mismatched = dict(good)
        mismatched["web/.route-shells/play.html"] = loader.replace(VERSION, "c" * 16)
        with self.assertRaisesRegex(ValueError, "version"):
            self.release("resumable-bad-version", mismatched)
        missing_route = dict(good)
        missing_route["web/.route-shells/routes.json"] = json.dumps({"routes": ["/", "/play", "/coach"]})
        with self.assertRaisesRegex(ValueError, "Missing route shell coach.html"):
            self.release("resumable-missing-shell", missing_route)

    def test_resumable_route_shells_allow_verified_per_route_preload_chunks(self):
        runtime_js = "_expo/static/js/web/__expo-metro-runtime-1111.js"
        common_js = "_expo/static/js/web/__common-2222.js"
        index_js = "_expo/static/js/web/index-3333.js"
        app_js = "_expo/static/js/web/App-4444.js"
        app_shared_js = "_expo/static/js/web/__app-shared-5555.js"
        play_setup_js = "_expo/static/js/web/PlaySetup-6666.js"
        play_shared_js = "_expo/static/js/web/__play-shared-7777.js"

        def shell_doc(extra_chunks):
            preloads = "".join(
                f'<link rel="preload" as="script" href="/{chunk}?v={VERSION}">'
                for chunk in extra_chunks
            )
            sources = ",".join(
                f'"/{chunk}?v={VERSION}"'
                for chunk in (*extra_chunks, runtime_js, common_js, index_js)
            )
            return (
                f"{preloads}"
                f'<script data-ca-resumable-loader>window.__caShellVersion="{VERSION}";'
                f"var sources=[{sources}];</script>"
            )

        base_files = {
            "web/" + runtime_js: "runtime",
            "web/" + common_js: "common",
            "web/" + index_js: "index",
            "web/" + app_js: "app",
            "web/" + app_shared_js: "app-shared",
            "web/" + play_setup_js: "play-setup",
            "web/" + play_shared_js: "play-shared",
            "web/index.html": shell_doc((app_js, app_shared_js)),
            "web/.route-shells/routes.json": json.dumps({"routes": ["/", "/play", "/analysis"]}),
            "web/.route-shells/home.html": shell_doc((app_js, app_shared_js)),
            "web/.route-shells/play.html": shell_doc((app_js, app_shared_js, play_setup_js, play_shared_js)),
            "web/.route-shells/analysis.html": shell_doc((app_js, app_shared_js, play_setup_js, play_shared_js)),
        }
        rel = self.release("resumable-per-route-ok", base_files)
        verify(rel)

        missing_preload = dict(base_files)
        del missing_preload["web/" + play_setup_js]
        with self.assertRaisesRegex(ValueError, "Missing script /_expo/static/js/web/PlaySetup-6666.js referenced by route shell analysis.html"):
            self.release("resumable-missing-preload", missing_preload)

        other_index_js = "_expo/static/js/web/index-9999.js"
        mismatched_core = dict(base_files)
        mismatched_core["web/" + other_index_js] = "other-index"
        mismatched_core["web/.route-shells/analysis.html"] = (
            mismatched_core["web/.route-shells/analysis.html"].replace(index_js, other_index_js)
        )
        with self.assertRaisesRegex(ValueError, "Route shell analysis.html entry scripts do not match index.html"):
            self.release("resumable-mismatched-core", mismatched_core)


if __name__ == "__main__":
    unittest.main()
