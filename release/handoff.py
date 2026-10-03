"""Single-writer handoff shared by deployment and rollback.

The gateway owns the browser connections. Applications never overlap as writers.
An interrupted/failed candidate is recovered through a fresh process so its durable
updates cannot be overwritten by a frozen process's old memory.
"""
class Handoff:
    def __init__(self, platform):
        self.p = platform
        self.snapshot = None
        self.quiesced = False
        self.candidate_started = False
        self.candidate_restored = False
        self.committed = False

    def run(self, current, candidate):
        self.p.begin(current, candidate)
        try:
            self.p.gateway("hold")
            self.p.runtime(current, "quiesce")
            self.quiesced = True
            # Background jobs can broadcast between the first barrier and quiescence.
            self.p.gateway("hold")
            self.snapshot = self.p.runtime(current, "snapshot", method="GET")
            self.p.save_recovery(current, candidate, self.snapshot)
            self.candidate_started = True
            self.p.start(candidate)
            self.p.phase("initializing")
            self.p.runtime(candidate, "restore", self.snapshot)
            self.candidate_restored = True
            self.p.phase("prepared")
            self.p.gateway("switch", {"upstream": self.p.upstream(candidate)})
            self.p.publish_active(candidate)
            self.p.phase("activating")
            self.p.runtime(candidate, "resume")
            self.p.health(candidate)
            self.p.gateway("resume")
            self.committed = True
        except Exception:
            # A lost acknowledgement can follow a successfully committed gateway switch.
            state = self.p.gateway("status", method="GET")
            if state.get("phase") == "active" and state.get("currentUpstream") == self.p.upstream(candidate):
                self.committed = True
            else:
                self.recover(current, candidate)
                raise
        if self.committed:
            self.p.complete(current, candidate)
            self.p.stop(current)

    def recover(self, current, candidate):
        if not self.quiesced:
            status = self.p.runtime(current, "status", method="GET")
            if status.get("state") == "quiescing" and status.get("terminalLifecycleStopped"):
                # Terminal lifecycle cancellation cannot be undone. Join it, obtain the
                # verified snapshot, and recover through a fresh process instead.
                self.p.runtime(current, "quiesce")
                status = self.p.runtime(current, "status", method="GET")
            self.quiesced = status.get("state") == "quiesced"
        if not self.quiesced:
            # Failed drains leave the original writer recoverable; no new writer was started.
            self.p.runtime(current, "resume")
            self.p.gateway("abort")
            self.p.recovered(current)
            return
        if self.candidate_started and not self.candidate_restored:
            self.candidate_restored = self.p.runtime(candidate, "status", method="GET").get("state") in ("prepared", "resuming", "active", "quiesced", "quiescing")
        if self.candidate_restored:
            self.p.runtime(candidate, "quiesce")
            self.snapshot = self.p.runtime(candidate, "snapshot", method="GET")
            self.p.save_recovery(current, candidate, self.snapshot)
        if self.snapshot is None:
            # Never restart from a guessed or stale snapshot after a terminal quiesce.
            self.snapshot = self.p.runtime(current, "snapshot", method="GET")
            self.p.save_recovery(current, candidate, self.snapshot)
        if self.candidate_started:
            self.p.stop(candidate)
        self.p.publish_active(None)
        self.p.stop(current)
        self.p.start(current)
        self.p.runtime(current, "restore", self.snapshot)
        self.p.gateway("switch", {"upstream": self.p.upstream(current)})
        self.p.publish_active(current)
        self.p.runtime(current, "resume")
        self.p.health(current)
        self.p.gateway("resume")
        self.p.recovered(current)
