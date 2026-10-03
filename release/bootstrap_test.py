"""First-adoption failure contracts; no test contacts a host or service."""
from contextlib import ExitStack
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import runtime_transaction as transaction


class BootstrapPlatform:
    def __init__(self, root, *, committed=True, status=None):
        self.journal = Path(root) / "transaction.json"
        self.recovery_file = Path(root) / "recovery.json"
        self.old = {"id": "legacy", "slot": "legacy", "port": 8080, "protocol": 0}
        self.new = {"id": "candidate", "slot": "blue", "port": 8081, "protocol": 1}
        self.current = self.upstream(self.old)
        self.pending = None
        self.phase = "active"
        self.writer = "legacy"
        self.candidate_state = "stopped"
        self.committed = committed
        self.status = status
        self.events = []
        self.new_user_state = 0
        self.failed_once = False

    @staticmethod
    def upstream(release):
        return "http://127.0.0.1:" + str(release["port"])

    def gateway(self, action, data=None, method="POST"):
        self.events.append(("gateway", action))
        if action == "status":
            if isinstance(self.status, Exception):
                raise self.status
            if self.status is not None:
                return self.status
        elif action == "hold":
            self.phase = "held"
        elif action == "switch":
            self.pending = data["upstream"]
            self.phase = "prepared"
        elif action == "resume":
            if not self.failed_once:
                self.failed_once = True
                if self.committed:
                    assert self.writer == "candidate"
                    self.current = self.pending
                    self.phase = "active"
                    # A user can mutate state before the lost response is detected.
                    self.new_user_state += 1
                raise OSError("gateway resume acknowledgement lost")
            assert self.writer == "legacy"
            self.current = self.pending
            self.phase = "active"
        elif action == "abort":
            assert self.writer == "legacy"
            self.phase = "active"
        return {"phase": self.phase, "currentUpstream": self.current}

    def command(self, *args, **kwargs):
        self.events.append(args)
        if args == ("systemctl", "stop", "chessd"):
            assert self.writer == "legacy"
            self.writer = None
        elif args == ("systemctl", "start", "chessd"):
            assert self.writer is None, "legacy must never overlap the candidate writer"
            self.writer = "legacy"

    def start(self, release):
        self.events.append(("candidate", "start"))
        assert self.writer is None
        self.candidate_state = "standby"

    def stop(self, release):
        self.events.append(("candidate", "stop"))
        self.candidate_state = "stopped"
        self.writer = None

    def runtime(self, release, action, data=None, method="POST"):
        self.events.append(("candidate", action))
        if action == "restore":
            assert self.writer is None and self.candidate_state == "standby"
            assert data["schemaVersion"] == 1 and data["rooms"]["rooms"] == []
            self.writer = "candidate"
            self.candidate_state = "prepared"
        elif action == "resume":
            assert self.writer == "candidate"
            self.candidate_state = "active"
        return {"state": self.candidate_state}

    def publish_active(self, release):
        self.events.append(("publish", release["id"] if release else None))

    def health(self, release):
        self.events.append(("candidate", "health"))
        assert self.candidate_state == "active" and self.writer == "candidate"

    def complete(self, current, candidate):
        self.events.append(("complete",))
        assert self.current == self.upstream(candidate) and self.writer == "candidate"
        self.journal.unlink()
        self.recovery_file.unlink()


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def run_bootstrap(self, platform, *, idle_error=None):
        with ExitStack() as stack:
            stack.enter_context(patch.object(transaction, "capture_legacy", return_value=platform.old))
            stack.enter_context(patch.object(transaction, "install_gateway_route"))
            idle = stack.enter_context(patch.object(transaction, "check_legacy_idle", side_effect=idle_error))
            stack.enter_context(patch.object(transaction, "command", side_effect=platform.command))
            stack.enter_context(patch.object(transaction, "http_json", return_value={"ok": True}))
            stack.enter_context(patch.object(transaction, "retire_legacy_service",
                                            side_effect=lambda p: p.events.append(("retire",))))
            transaction.bootstrap(platform, platform.new)
            return idle

    def assert_candidate_preserved(self, platform):
        self.assertEqual(platform.writer, "candidate")
        self.assertEqual(platform.candidate_state, "active")
        self.assertNotIn(("candidate", "stop"), platform.events)
        self.assertNotIn(("systemctl", "start", "chessd"), platform.events)
        self.assertNotIn(("publish", None), platform.events)
        self.assertNotIn(("gateway", "abort"), platform.events)

    def test_lost_resume_ack_reconciles_committed_candidate_without_restarting_legacy(self):
        platform = BootstrapPlatform(self.temp.name)
        idle = self.run_bootstrap(platform)
        self.assert_candidate_preserved(platform)
        self.assertEqual(platform.new_user_state, 1)
        self.assertEqual((platform.current, platform.phase), (platform.upstream(platform.new), "active"))
        self.assertIn(("complete",), platform.events)
        self.assertIn(("retire",), platform.events)
        self.assertFalse(platform.journal.exists())
        self.assertFalse(platform.recovery_file.exists())
        self.assertEqual(platform.events.count(("gateway", "resume")), 1)
        self.assertIsInstance(idle.call_args.kwargs["fresh_after"], float)

    def test_unknown_commit_status_preserves_writer_and_recovery_evidence(self):
        for committed in (False, True):
            for status in (OSError("gateway status unavailable"), {},
                           {"phase": "unknown", "currentUpstream": "http://127.0.0.1:8080"},
                           {"phase": "active", "currentUpstream": "http://127.0.0.1:9999"}):
                with self.subTest(committed=committed, status=status):
                    platform = BootstrapPlatform(self.temp.name, committed=committed, status=status)
                    with self.assertRaises((OSError, RuntimeError)):
                        self.run_bootstrap(platform)
                    self.assert_candidate_preserved(platform)
                    self.assertEqual(platform.new_user_state, int(committed))
                    self.assertEqual(json.loads(platform.journal.read_text())["phase"], "bootstrap")
                    self.assertEqual(json.loads(platform.recovery_file.read_text())["schemaVersion"], 1)
                    self.assertNotIn(("complete",), platform.events)
                    self.assertNotIn(("retire",), platform.events)

    def test_proven_uncommitted_failure_can_restore_legacy_without_two_writers(self):
        platform = BootstrapPlatform(self.temp.name, committed=False)
        with self.assertRaisesRegex(OSError, "acknowledgement lost"):
            self.run_bootstrap(platform)
        self.assertEqual((platform.writer, platform.phase, platform.current),
                         ("legacy", "active", platform.upstream(platform.old)))
        self.assertLess(platform.events.index(("candidate", "stop")),
                        platform.events.index(("systemctl", "start", "chessd")))
        self.assertFalse(platform.journal.exists())
        self.assertFalse(platform.recovery_file.exists())
        self.assertNotIn(("complete",), platform.events)

    def test_failed_post_hold_idle_check_never_stops_legacy(self):
        platform = BootstrapPlatform(self.temp.name)
        with self.assertRaisesRegex(RuntimeError, "live socket"):
            self.run_bootstrap(platform, idle_error=RuntimeError("live socket"))
        self.assertEqual((platform.writer, platform.phase), ("legacy", "active"))
        self.assertIn(("gateway", "abort"), platform.events)
        self.assertNotIn(("systemctl", "stop", "chessd"), platform.events)
        self.assertNotIn(("candidate", "start"), platform.events)
        self.assertFalse(platform.journal.exists())


class LegacyIdleTests(unittest.TestCase):
    def check_samples(self, samples, *, fresh_after=1000.0, waiting=0, windows=None):
        """Samples are (elapsed seconds, completed heartbeat, metric overrides)."""
        clock = {"elapsed": 0.0, "reads": 0}
        def sample(request, timeout):
            index = min(clock["reads"], len(samples) - 1)
            elapsed, heartbeat, overrides = samples[index]
            clock["reads"] += 1
            clock["elapsed"] = max(clock["elapsed"], elapsed)
            values = {"chessalive_job_last_run_seconds:heartbeat": heartbeat,
                      "chessalive_ws_connections": 0, "chessalive_rooms_live": 0,
                      "chessalive_rooms_resident": 0}
            values.update(overrides)
            return io.BytesIO("\n".join(f"{key} {value}" for key, value in values.items()).encode())
        def sleep(duration):
            clock["elapsed"] += duration
        def http_json(url, token=None):
            return {"waiting": waiting} if url.endswith("/pool") else (windows or {})
        with ExitStack() as stack:
            stack.enter_context(patch.object(transaction, "process_env", return_value={"CHESSALIVE_METRICS_TOKEN": "test"}))
            stack.enter_context(patch.object(transaction.urllib.request, "urlopen", side_effect=sample))
            endpoints = stack.enter_context(patch.object(transaction, "http_json", side_effect=http_json))
            stack.enter_context(patch.object(transaction.time, "time", side_effect=lambda: 1000 + clock["elapsed"]))
            stack.enter_context(patch.object(transaction.time, "monotonic", side_effect=lambda: clock["elapsed"]))
            stack.enter_context(patch.object(transaction.time, "sleep", side_effect=sleep))
            try:
                transaction.check_legacy_idle(object(), "http://127.0.0.1:8080", "chessd", fresh_after=fresh_after)
            finally:
                self.clock = clock
                self.endpoints = endpoints

    def test_only_two_advancing_post_hold_completions_admit_idle_bootstrap(self):
        self.check_samples([(0, 999.9, {}), (0.5, 1000.1, {}),
                            (1, 1000.1, {}), (30.5, 1030.1, {})])
        self.assertEqual(self.clock["reads"], 4)
        self.assertEqual(self.endpoints.call_count, 2)

    def test_repeated_first_completion_never_counts_as_second_and_times_out(self):
        with self.assertRaisesRegex(RuntimeError, "fresh legacy heartbeat"):
            self.check_samples([(0.5, 1000.1, {})])
        self.assertGreaterEqual(self.clock["elapsed"], 70)
        self.assertLess(self.clock["elapsed"], 71)
        self.endpoints.assert_not_called()

    def test_pre_hold_completions_and_stale_scrapes_do_not_admit_bootstrap(self):
        with self.assertRaisesRegex(RuntimeError, "fresh legacy heartbeat"):
            self.check_samples([(0, 999, {}), (1, 1000, {})])
        self.endpoints.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "measurements are stale"):
            self.check_samples([(0, 954, {})], fresh_after=None)
        self.endpoints.assert_not_called()

    def test_activity_in_either_fresh_sample_fails_closed(self):
        for key in ("chessalive_ws_connections", "chessalive_rooms_live", "chessalive_rooms_resident"):
            for active_sample in (0, 1):
                with self.subTest(key=key, active_sample=active_sample):
                    samples = [(0.5, 1000.1, {}), (30.5, 1030.1, {})]
                    samples[active_sample][2][key] = 1
                    with self.assertRaisesRegex(RuntimeError, "no active games or sockets"):
                        self.check_samples(samples)
                    self.endpoints.assert_not_called()

    def test_fresh_heartbeats_do_not_bypass_queue_or_event_freeze(self):
        samples = [(0.5, 1000.1, {}), (30.5, 1030.1, {})]
        with self.assertRaisesRegex(RuntimeError, "empty matchmaking queue"):
            self.check_samples(samples, waiting=1)
        with self.assertRaisesRegex(RuntimeError, "live event window"):
            self.check_samples(samples, windows={"freeze": True})


if __name__ == "__main__":
    unittest.main()
