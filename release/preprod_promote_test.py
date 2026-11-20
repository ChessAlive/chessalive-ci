import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_store
import runtime_transaction


def make_release(platform, rel_id, slot, version, commit_hash):
    rel_dir = platform.releases / rel_id
    (rel_dir / "web").mkdir(parents=True, exist_ok=True)
    (rel_dir / "packages/data").mkdir(parents=True, exist_ok=True)
    (rel_dir / "chessd").write_bytes(b"binary-" + rel_id.encode())
    (rel_dir / "chessd-migrate").write_bytes(b"migrate-" + rel_id.encode())
    (rel_dir / "chessd.service").write_text("[Unit]\nDescription=test\n")
    (rel_dir / "web/index.html").write_text("<html>ok</html>")
    (rel_dir / "web/version.json").write_text(json.dumps({"version": version}))
    (rel_dir / "packages/data/puzzles.json").write_text("[]")
    release_store.manifest(rel_dir, {"commitHash": commit_hash, "commitMessage": "msg " + rel_id})
    port = 8083 if slot == "preprod" else (8081 if slot == "blue" else 8082)
    return {"id": rel_id, "slot": slot, "port": port, "protocol": 1}


class PreprodPromoteTest(unittest.TestCase):
    def test_preprod_activation_preserves_prod_and_prune_keeps_all_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            platform = runtime_transaction.Platform(root=root)
            platform.releases.mkdir(parents=True, exist_ok=True)
            prev_rel = make_release(platform, "release-20261120t100000z-111111", "green", "1111111111111111", "a" * 40)
            curr_rel = make_release(platform, "release-20261120t110000z-222222", "blue", "2222222222222222", "b" * 40)
            stale_rel = make_release(platform, "release-20261120t090000z-000000", "preprod", "0000000000000000", "0" * 40)
            release_store.atomic_json(platform.state_file, {"schemaVersion": 1, "current": curr_rel, "previous": prev_rel})

            pp_rel = make_release(platform, "release-20261120t120000z-333333", "preprod", "3333333333333333", "c" * 40)
            platform.activate_preprod(pp_rel)
            platform.prune()

            state = release_store.read_json(platform.state_file)
            self.assertEqual(state["current"]["id"], curr_rel["id"])
            self.assertEqual(state["previous"]["id"], prev_rel["id"])
            self.assertEqual(state["preprod"]["id"], pp_rel["id"])
            self.assertTrue((platform.releases / curr_rel["id"]).is_dir())
            self.assertTrue((platform.releases / prev_rel["id"]).is_dir())
            self.assertTrue((platform.releases / pp_rel["id"]).is_dir())
            self.assertFalse((platform.releases / stale_rel["id"]).is_dir())
            self.assertEqual((root / "slots/preprod").resolve(), (platform.releases / pp_rel["id"]).resolve())

            status = platform.status()
            self.assertTrue(status["preprod"]["promotable"])
            self.assertFalse(status["preprod"]["inSyncWithProd"])
            self.assertEqual(status["preprod"]["reason"], "ready_to_promote")
            self.assertEqual(status["preprod"]["releaseId"], pp_rel["id"])

            # Simulating promote completion preserves preprod and marks it in sync with prod.
            promoted = {"id": pp_rel["id"], "slot": "green", "port": 8082, "protocol": 1}
            platform.complete(curr_rel, promoted)
            platform.prune()
            after = platform.status()
            self.assertFalse(after["preprod"]["promotable"])
            self.assertTrue(after["preprod"]["inSyncWithProd"])
            self.assertEqual(after["preprod"]["reason"], "already_live")
            self.assertEqual(after["current"]["commitHash"], "c" * 40)
            self.assertEqual(after["previous"]["commitHash"], "b" * 40)


if __name__ == "__main__":
    unittest.main()
