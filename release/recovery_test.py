"""Interrupted-release contracts using the real recovery coordinator and journals.

The platform fake models the runtime's important refusal rules: exclusive writer
ownership, terminal lifecycle stop, fresh-standby-only restore, and snapshot access
only after successful quiesce. No test contacts a host or service.
"""
import json
from pathlib import Path
import tempfile
import unittest

from runtime_transaction import recover_interrupted


class RecoveryPlatform:
    def __init__(self, root, *, old_state="quiesced", new_state="standby",
                 phase="held", gate="held", touched=False, terminal=False):
        self.root = Path(root)
        self.journal = self.root / "transaction.json"
        self.recovery_file = self.root / "recovery.json"
        self.old = {"id": "old", "slot": "blue", "protocol": 1}
        self.new = {"id": "new", "slot": "green", "protocol": 1}
        self.journal.write_text(json.dumps({"phase": phase, "current": self.old, "candidate": self.new}))
        self.states = {"old": old_state, "new": new_state}
        self.terminal = {"old": terminal, "new": False}
        self.generation = {"old": 0, "new": 0}
        self.values = {"old": 7, "new": 9}
        self.gate = gate
        self.current = "new" if gate == "active" and new_state == "active" else "old"
        self.pending = "new" if touched else None
        self.touched = touched
        self.writer = "old" if old_state in ("active", "quiescing", "resuming") else "new" if new_state in ("active", "prepared", "resuming", "quiescing") else None
        self.events = []
        self.restored = []
        self.stop_failure = False
        self.health_failure = False
        self.saved = None

    def record(self, *event):
        self.events.append(event)

    @staticmethod
    def upstream(release):
        return release["id"]

    def gateway(self, action, data=None, method="POST"):
        self.record("gateway", action)
        if action == "hold":
            self.gate = "held"
        elif action == "switch":
            self.pending = data["upstream"]
            if self.states[self.pending] not in ("prepared", "active"):
                raise RuntimeError("socket preparation requires an initialized runtime")
            self.touched = True
            self.gate = "prepared"
        elif action == "resume":
            if self.states.get(self.pending) != "active" or self.writer != self.pending:
                raise RuntimeError("gateway cannot release traffic before a sole active writer")
            self.current = self.pending
            self.gate = "active"
            self.pending = None
        elif action == "abort":
            if self.touched:
                raise RuntimeError("cannot abort after candidate transports were touched")
            if self.states[self.current] != "active" or self.writer != self.current:
                raise RuntimeError("abort requires a healthy current writer")
            self.gate = "active"
        return {"phase": self.gate, "currentUpstream": self.current, "candidateTouched": self.touched}

    def runtime(self, release, action, data=None, method="POST"):
        name = release["id"]
        state = self.states[name]
        self.record(name, action, self.generation[name])
        if action == "quiesce":
            if state not in ("active", "prepared", "quiescing", "quiesced"):
                raise RuntimeError("runtime cannot quiesce")
            if self.stop_failure:
                raise RuntimeError("terminal lifecycle still has not joined")
            self.states[name] = "quiesced"
            self.terminal[name] = True
            if self.writer == name:
                self.writer = None
        elif action == "snapshot":
            if state != "quiesced":
                raise RuntimeError("snapshot requires successful quiesce")
            return json.dumps({"schemaVersion": 1, "value": self.values[name]}, separators=(",", ":")).encode()
        elif action == "restore":
            if state != "standby" or self.writer is not None:
                raise RuntimeError("restore requires fresh standby and exclusive writer")
            snapshot = json.loads(data) if isinstance(data, bytes) else data
            if snapshot.get("schemaVersion") != 1:
                raise RuntimeError("unsupported snapshot")
            self.restored.append((name, self.generation[name], snapshot["value"]))
            self.values[name] = snapshot["value"]
            self.writer = name
            self.states[name] = "prepared"
        elif action == "resume":
            if state == "resuming":
                # Runtime control requests serialize. This follow-up waits for the
                # in-progress resume to finish, then observes idempotent active.
                self.states[name] = state = "active"
            if self.terminal[name] or state not in ("active", "prepared", "quiescing"):
                raise RuntimeError("fresh-process-required")
            if self.writer not in (None, name):
                raise RuntimeError("two writers")
            self.writer = name
            self.states[name] = "active"
        return {"state": self.states[name], "terminalLifecycleStopped": self.terminal[name],
                "canResume": not self.terminal[name] and self.states[name] in ("active", "prepared", "quiescing")}

    def start(self, release):
        name = release["id"]
        if self.states[name] != "stopped":
            raise RuntimeError("recovery must start a fresh old process")
        self.generation[name] += 1
        self.states[name] = "standby"
        self.values[name] = 0
        self.terminal[name] = False
        self.record(name, "start", self.generation[name])

    def stop(self, release):
        name = release["id"]
        self.record(name, "stop", self.generation[name])
        self.states[name] = "stopped"
        if self.writer == name:
            self.writer = None

    def publish_active(self, release):
        self.record("publish", release["id"] if release else None)

    def save_recovery(self, current, candidate, snapshot):
        self.record("save",)
        self.saved = bytes(snapshot)
        self.recovery_file.write_bytes(snapshot)

    def health(self, release):
        self.record(release["id"], "health")
        if self.health_failure or self.states[release["id"]] != "active":
            raise RuntimeError("database-backed health failed")

    def complete(self, current, candidate):
        self.record("complete", current["id"], candidate["id"])
        self.journal.unlink()
        self.recovery_file.unlink(missing_ok=True)

    def recovered(self, current):
        self.record("recovered", current["id"])
        self.journal.unlink()
        self.recovery_file.unlink(missing_ok=True)

    def prune(self):
        self.record("prune",)


class InterruptedRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def platform(self, **kwargs):
        return RecoveryPlatform(self.temp.name, **kwargs)

    def test_lost_commit_ack_reconciles_without_replaying_or_reversing_traffic(self):
        p = self.platform(new_state="active", phase="activating", gate="active", touched=True)
        recover_interrupted(p)
        self.assertEqual((p.current, p.writer, p.gate), ("new", "new", "active"))
        self.assertEqual(p.values["new"], 9)
        self.assertEqual(p.restored, [])
        self.assertNotIn(("gateway", "hold"), p.events)
        self.assertNotIn(("new", "quiesce", 0), p.events)
        self.assertIn(("old", "stop", 0), p.events)
        self.assertIn(("complete", "old", "new"), p.events)
        self.assertFalse(p.journal.exists())

    def test_committed_candidate_failing_health_keeps_recovery_evidence(self):
        p = self.platform(new_state="active", phase="activating", gate="active", touched=True)
        p.health_failure = True
        with self.assertRaisesRegex(RuntimeError, "health failed"):
            recover_interrupted(p)
        self.assertTrue(p.journal.exists())
        self.assertFalse(any(event[0] in ("complete", "prune") for event in p.events))
        self.assertEqual(p.restored, [])

    def test_terminal_quiescing_old_is_joined_then_restored_in_a_fresh_process(self):
        p = self.platform(old_state="quiescing", terminal=True)
        recover_interrupted(p)
        self.assertEqual(p.restored, [("old", 1, 7)])
        self.assertNotIn(("old", "resume", 0), p.events)
        self.assertLess(p.events.index(("old", "quiesce", 0)), p.events.index(("old", "snapshot", 0)))
        self.assertLess(p.events.index(("old", "snapshot", 0)), p.events.index(("old", "stop", 0)))
        self.assertEqual((p.current, p.writer, p.gate), ("old", "old", "active"))
        self.assertFalse(p.journal.exists())

    def test_repeated_terminal_join_failure_preserves_writer_and_held_traffic(self):
        p = self.platform(old_state="quiescing", terminal=True)
        p.stop_failure = True
        with self.assertRaisesRegex(RuntimeError, "has not joined"):
            recover_interrupted(p)
        self.assertEqual((p.writer, p.gate), ("old", "held"))
        self.assertEqual(p.restored, [])
        self.assertTrue(p.journal.exists())
        self.assertNotIn(("old", "resume", 0), p.events)
        self.assertFalse(any(event[1:2] == ("stop",) for event in p.events))

    def test_initialized_candidate_restart_never_uses_older_checkpoint(self):
        for phase in ("prepared", "activating"):
            for state in ("standby", "stopped", "failed"):
                with self.subTest(phase=phase, state=state):
                    p = self.platform(new_state=state, phase=phase, touched=True)
                    original = b'{"schemaVersion":1,"value":7}'
                    p.recovery_file.write_bytes(original)
                    with self.assertRaisesRegex(RuntimeError, "refusing to overwrite newer durable data"):
                        recover_interrupted(p)
                    self.assertEqual(p.restored, [])
                    self.assertTrue(p.journal.exists())
                    self.assertEqual(p.recovery_file.read_bytes(), original)
                    self.assertEqual(p.gate, "held")
                    self.assertFalse(any(event[1:2] in (("stop",), ("start",), ("restore",)) for event in p.events))

    def test_recoverable_old_uses_abort_only_before_candidate_transports_are_touched(self):
        for old_state, gate in (("active", "active"), ("active", "held"), ("quiescing", "held")):
            for touched in (False, True):
                with self.subTest(old_state=old_state, gate=gate, touched=touched):
                    p = self.platform(old_state=old_state, phase="holding", gate=gate, touched=touched)
                    recover_interrupted(p)
                    self.assertEqual((p.current, p.writer, p.gate), ("old", "old", "active"))
                    self.assertEqual(p.restored, [])
                    self.assertEqual(p.generation["old"], 0)
                    self.assertIn(("old", "resume", 0), p.events)
                    if gate == "active":
                        self.assertIn(("gateway", "hold"), p.events)
                    if touched:
                        self.assertIn(("gateway", "switch"), p.events)
                        self.assertIn(("gateway", "resume"), p.events)
                        self.assertNotIn(("gateway", "abort"), p.events)
                    else:
                        self.assertIn(("gateway", "abort"), p.events)
                        self.assertNotIn(("gateway", "switch"), p.events)
                    self.assertFalse(p.journal.exists())

    def test_in_progress_old_resume_rebinds_touched_transports_without_stale_restore(self):
        for phase in ("held", "prepared", "activating"):
            with self.subTest(phase=phase):
                p = self.platform(old_state="resuming", new_state="stopped", phase=phase,
                                  gate="prepared", touched=True)
                # A prior recovery already restored and began resuming this fresh
                # old process. The lost resume response must not recreate it again.
                p.generation["old"] = 1
                p.values["old"] = 11
                p.pending = "old"
                p.recovery_file.write_bytes(b'{"schemaVersion":1,"value":9}')
                recover_interrupted(p)
                self.assertEqual((p.current, p.writer, p.gate), ("old", "old", "active"))
                self.assertEqual(p.values["old"], 11)
                self.assertEqual(p.generation["old"], 1)
                self.assertEqual(p.restored, [])
                self.assertIn(("old", "resume", 1), p.events)
                self.assertIn(("gateway", "switch"), p.events)
                self.assertIn(("gateway", "resume"), p.events)
                self.assertNotIn(("gateway", "abort"), p.events)
                self.assertFalse(p.journal.exists())

    def test_live_prepared_candidate_exports_latest_state_before_fresh_rollback(self):
        p = self.platform(new_state="prepared", phase="prepared", gate="prepared", touched=True)
        p.recovery_file.write_bytes(b'{"schemaVersion":1,"value":7}')
        recover_interrupted(p)
        self.assertEqual(p.restored, [("old", 1, 9)])
        self.assertEqual(json.loads(p.saved)["value"], 9)
        self.assertLess(p.events.index(("new", "snapshot", 0)), p.events.index(("new", "stop", 0)))
        self.assertEqual((p.current, p.writer, p.gate), ("old", "old", "active"))

    def test_pre_initialization_failure_can_use_verified_persistent_checkpoint(self):
        p = self.platform(old_state="stopped", new_state="standby", phase="initializing")
        p.recovery_file.write_bytes(b'{"schemaVersion":1,"value":7}')
        recover_interrupted(p)
        self.assertEqual(p.restored, [("old", 1, 7)])
        self.assertEqual((p.current, p.writer, p.gate), ("old", "old", "active"))

    def test_missing_checkpoint_and_absent_old_process_never_invents_empty_state(self):
        p = self.platform(old_state="stopped", new_state="standby", phase="initializing")
        with self.assertRaisesRegex(RuntimeError, "snapshot requires successful quiesce"):
            recover_interrupted(p)
        self.assertEqual(p.restored, [])
        self.assertTrue(p.journal.exists())
        self.assertEqual(p.gate, "held")


if __name__ == "__main__":
    unittest.main()
