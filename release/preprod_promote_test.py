import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_store
import runtime_transaction


def sign_proof(release_id, secret, approvers, issued_at=None, commit_hash="c" * 40):
    issued = issued_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    items = sorted(f"{a['id']}:{a['email']}:{a['approvedAt']}" for a in approvers)
    msg = f"v1|{release_id}|{commit_hash}|{issued}|" + "|".join(items)
    sig = hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()
    payload = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "commitHash": commit_hash,
        "issuedAt": issued,
        "approvers": approvers,
        "signature": sig,
    }
    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


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

    def test_verify_promote_approval_enforces_all_three_admins_and_signature(self):
        rel_id = "release-20261120t120000z-333333"
        secret = "9" * 64
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        three_admins = [
            {"id": "lakshmi", "name": "Lakshmi", "email": "lakshminathanlaky@gmail.com", "approvedAt": now_iso},
            {"id": "vinoth", "name": "Vinoth", "email": "vinoth121022@gmail.com", "approvedAt": now_iso},
            {"id": "avinash", "name": "Avinash", "email": "avinashr95@gmail.com", "approvedAt": now_iso},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "promote-approval.key"
            key_file.write_text(secret + "\n", encoding="utf-8")

            # Missing proof is rejected
            with self.assertRaisesRegex(RuntimeError, "all 3 required admins"):
                runtime_transaction.verify_promote_approval(rel_id, "", key_file=key_file)

            # Valid 3/3 signed proof passes
            valid = sign_proof(rel_id, secret, three_admins)
            self.assertEqual(
                runtime_transaction.verify_promote_approval(rel_id, valid, key_file=key_file),
                ["avinash", "lakshmi", "vinoth"],
            )

            # 2/3 approvers rejected
            two_only = sign_proof(rel_id, secret, three_admins[:2])
            with self.assertRaisesRegex(RuntimeError, "missing approvals from avinash"):
                runtime_transaction.verify_promote_approval(rel_id, two_only, key_file=key_file)

            # Duplicate approver rejected
            dup = sign_proof(rel_id, secret, [three_admins[0], three_admins[0], three_admins[1]])
            with self.assertRaisesRegex(RuntimeError, "duplicate approver"):
                runtime_transaction.verify_promote_approval(rel_id, dup, key_file=key_file)

            # Wrong releaseId rejected
            wrong_rel = sign_proof("release-20261120t999999z-999999", secret, three_admins)
            with self.assertRaisesRegex(RuntimeError, "does not match the Pre-Prod release ID"):
                runtime_transaction.verify_promote_approval(rel_id, wrong_rel, key_file=key_file)

            # Expired timestamp rejected
            old_iso = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat().replace("+00:00", "Z")
            expired = sign_proof(rel_id, secret, three_admins, issued_at=old_iso)
            with self.assertRaisesRegex(RuntimeError, "expired"):
                runtime_transaction.verify_promote_approval(rel_id, expired, key_file=key_file)

            # Wrong signing secret rejected
            bad_sig = sign_proof(rel_id, "8" * 64, three_admins)
            with self.assertRaisesRegex(RuntimeError, "signature verification failed"):
                runtime_transaction.verify_promote_approval(rel_id, bad_sig, key_file=key_file)

            # Cross-language verification: proof minted by Node approvals.mjs must verify in Python
            approvals_path = Path(__file__).resolve().parent / "approvals.mjs"
            node_out = subprocess.check_output(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    (
                        f"import {{ createApprovalManager }} from {json.dumps(approvals_path.as_uri())};"
                        f"const m = createApprovalManager();"
                        f"for (const id of ['lakshmi', 'vinoth', 'avinash']) m.approve({json.dumps(rel_id)}, {{ id }}, {{ commitHash: 'abc123' }});"
                        f"process.stdout.write(m.buildSignedProof({json.dumps(rel_id)}, {json.dumps(secret)}, {{ commitHash: 'abc123' }}));"
                    ),
                ],
                text=True,
            )
            self.assertEqual(
                runtime_transaction.verify_promote_approval(rel_id, node_out.strip(), key_file=key_file),
                ["avinash", "lakshmi", "vinoth"],
            )


if __name__ == "__main__":
    unittest.main()
