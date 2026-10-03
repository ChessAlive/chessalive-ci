#!/usr/bin/env python3
"""Production host installer. Control sockets and snapshots never leave this host."""
import argparse
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

from handoff import Handoff
from release_store import archive_client, atomic_bytes, atomic_json, extract, manifest, public_info, read_json, verify

ROOT = Path("/opt/chessalive")
RUN = Path("/run/chessalive")
CONFIG = Path("/etc/chessalive")


def command(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout=90):
        super().__init__("localhost", timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def control(path, action, data=None, method="POST"):
    connection = UnixHTTP(path)
    try:
        payload = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode() if data is not None else b"{}" if method == "POST" else None
        connection.request(method, "/" + action, payload, {"Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read(64 * 1024 * 1024 + 1)
        if len(raw) > 64 * 1024 * 1024:
            raise RuntimeError("Runtime control response exceeded its bound")
        if response.status != 200:
            # Snapshot contents and auth headers must never become deploy logs.
            raise RuntimeError(f"{Path(path).name} /{action}: HTTP {response.status}")
        if action == "snapshot" and method == "GET":
            json.loads(raw)  # Validate, but keep the exact bounded UTF-8 bytes for restore.
            return raw
        return json.loads(raw) if raw else {}
    finally:
        connection.close()


def http_json(url, token=None):
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token} if token else {})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def process_env(service):
    pid = command("systemctl", "show", service, "-p", "MainPID", "--value", capture_output=True).stdout.strip()
    if not pid.isdecimal() or int(pid) == 0:
        raise RuntimeError("Application process is not running")
    return dict(part.split("=", 1) for part in Path(f"/proc/{pid}/environ").read_bytes().decode().split("\0") if "=" in part)


def mark(step, status):
    if os.environ.get("CHESSALIVE_PROGRESS") == "yes":
        try:
            print("@@CHESSALIVE_STEP " + json.dumps({"id": step, "status": status}, separators=(",", ":")), flush=True)
        except BrokenPipeError:
            pass  # Losing the log viewer must never interrupt a state transfer.


class Platform:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.releases = self.root / "releases"
        self.state_file = self.releases / "deployment.json"
        self.active_file = self.root / "data/release/active.json"
        self.journal = self.releases / "transaction.json"
        self.recovery_file = self.root / "data/release/recovery.json"

    def gateway(self, action, data=None, method="POST"):
        return control(RUN / "gateway.sock", action, data, method)

    def runtime(self, release, action, data=None, method="POST"):
        try:
            return control(RUN / (release["slot"] + ".sock"), action, data, method)
        except (OSError, http.client.HTTPException):
            if action == "status" and subprocess.run(["systemctl", "is-active", "--quiet", "chessd@" + release["slot"]]).returncode != 0:
                return {"state": "stopped"}
            raise

    def health(self, release):
        if not http_json(self.upstream(release) + "/health").get("ok"):
            raise RuntimeError("Candidate did not pass its health gate")
        if not http_json(self.upstream(release) + "/ready").get("ok"):
            raise RuntimeError("Candidate did not pass its readiness gate")
        # Liveness alone does not exercise the production database connection.
        if not http_json(self.upstream(release) + "/version").get("version"):
            raise RuntimeError("Candidate did not pass its database-backed version check")

    def upstream(self, release):
        return "http://127.0.0.1:" + str(release["port"])

    def release_dir(self, release):
        if not re.fullmatch(r"[a-z0-9-]+", release["id"]):
            raise ValueError("Invalid release ID")
        return self.releases / release["id"]

    def configure(self, release):
        slot = release["slot"]
        if slot not in ("blue", "green", "legacy"):
            raise ValueError("Invalid release slot")
        directory = self.release_dir(release)
        slots = self.root / "slots"
        slots.mkdir(exist_ok=True)
        link = slots / (slot + ".new")
        link.unlink(missing_ok=True)
        link.symlink_to(directory)
        os.replace(link, slots / slot)
        env = {
            "CHESSALIVE_REALTIME_PORT": release["port"],
            "CHESSALIVE_WEB_ROOT": directory / "web",
            "CHESSALIVE_UPLOAD_DIR": self.root / "data/uploads",
            "CHESSALIVE_DARE_UPLOAD_DIR": self.root / "data/uploads",
            "CHESSALIVE_ORACLE_POOL": 6,
            "CHESSALIVE_RELEASE_CONTROL_SOCKET": RUN / (slot + ".sock"),
            "CHESSALIVE_RELEASE_STANDBY": 1,
            "CHESSALIVE_RELEASE_ID": release["id"],
            "CHESSALIVE_RELEASE_ACTIVE_FILE": self.active_file,
            "CHESSALIVE_RELEASE_TRANSACTION_FILE": self.journal,
            "CHESSALIVE_RELEASE_WRITER_LOCK": RUN / "writer.lock",
            "CHESSALIVE_RELAY_SECRET_FILE": CONFIG / "relay.key",
        }
        (CONFIG / ("slot-" + slot + ".env")).write_text("".join(f"{key}={value}\n" for key, value in env.items()))
        unit = (directory / "chessd.service").read_text()
        # The first fallback contains the previous unit verbatim. Give it isolated paths
        # while preserving its resource limits and Vault environment.
        if release.get("protocol") == 0:
            unit = re.sub(r"^ExecStart=.*$", f"ExecStart={directory}/chessd", unit, flags=re.M)
            unit = re.sub(r"^WorkingDirectory=.*$", f"WorkingDirectory={directory}", unit, flags=re.M)
            unit = unit.replace("EnvironmentFile=/etc/chessalive.env", "EnvironmentFile=/etc/chessalive.env\nEnvironmentFile=/etc/chessalive/slot-legacy.env")
        Path(f"/etc/systemd/system/chessd@{slot}.service").write_text(unit)
        command("systemctl", "daemon-reload")

    def start(self, release):
        self.configure(release)
        command("systemctl", "enable", "chessd@" + release["slot"])
        command("systemctl", "start", "chessd@" + release["slot"])
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                state = self.runtime(release, "status", method="GET")
                if state.get("state") in ("standby", "active"):
                    return
                if state.get("state") == "failed":
                    raise RuntimeError("Candidate failed initialization")
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.25)
        raise RuntimeError("Candidate control readiness timed out")

    def stop(self, release):
        command("systemctl", "stop", "chessd@" + release["slot"])
        command("systemctl", "disable", "chessd@" + release["slot"])

    def publish_active(self, release):
        atomic_json(self.active_file, {"activeReleaseId": release["id"] if release else None}, 0o644)

    def begin(self, current, candidate):
        atomic_json(self.journal, {"phase": "holding", "current": current, "candidate": candidate})

    def phase(self, phase):
        value = read_json(self.journal)
        value["phase"] = phase
        atomic_json(self.journal, value)

    def save_recovery(self, current, candidate, snapshot):
        atomic_bytes(self.recovery_file, snapshot)
        atomic_json(self.journal, {"phase": "held", "current": current, "candidate": candidate})

    def compatibility_links(self, release):
        directory = self.release_dir(release)
        for name, target in (("bin/chessd", "chessd"), ("bin/chessd-migrate", "chessd-migrate"), ("web", "web"), ("packages/data", "packages/data")):
            path = self.root / name
            if path.is_symlink() or path.is_file():
                path.unlink()
            elif path.exists():
                shutil.rmtree(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(directory / target)

    def complete(self, current, candidate):
        atomic_json(self.state_file, {"schemaVersion": 1, "current": candidate, "previous": current})
        self.compatibility_links(candidate)
        self.recovery_file.unlink(missing_ok=True)
        self.journal.unlink(missing_ok=True)

    def recovered(self, current):
        self.compatibility_links(current)
        self.recovery_file.unlink(missing_ok=True)
        self.journal.unlink(missing_ok=True)

    def prune(self):
        state = read_json(self.state_file)
        keep = {state.get(key, {}).get("id") for key in ("current", "previous")}
        for path in self.releases.iterdir():
            if path.is_dir() and not path.is_symlink() and path.name not in keep and re.fullmatch(r"(?:release|legacy)-[a-z0-9-]+", path.name):
                if read_json(path / "manifest.json").get("complete") is True:
                    shutil.rmtree(path)
        objects = self.root / "client-releases/.objects"
        if objects.exists():
            for path in objects.iterdir():
                if path.is_file() and not path.is_symlink() and re.fullmatch(r"[a-f0-9]{64}", path.name) and path.stat().st_nlink == 1:
                    path.unlink()

    def status(self, busy=False):
        state = read_json(self.state_file)
        current, previous = state.get("current"), state.get("previous")
        info = lambda item: public_info(read_json(self.release_dir(item) / "manifest.json")) if item else None
        complete = previous and read_json(self.release_dir(previous) / "manifest.json").get("complete") is True
        pending = self.journal.exists()
        compatible = complete and previous.get("protocol") == 1
        return {"available": bool(compatible and not busy and not pending),
                "reason": "operation_in_progress" if busy else "recovery_required" if pending else "ready" if compatible else "fallback_requires_upgrade" if complete else "no_complete_fallback",
                "requiresIdle": bool(previous and previous.get("protocol") == 0),
                "current": info(current), "previous": info(previous), "version": (info(previous) or {}).get("version")}


def conservative_catalog_idle(catalog, now_ms):
    """Strict subset of the event-window rules, used only for a fresh read-only probe.

    Unknown, active, recently finished, unscheduled, and overdue events all block.
    It is deliberately more restrictive than the normal live-window endpoint.
    """
    if catalog is None:
        return True
    if catalog.get("schemaVersion") != 1 or not isinstance(catalog.get("events"), dict):
        return False
    for event in catalog["events"].values():
        if not isinstance(event, dict):
            return False
        status = event.get("status")
        if status in ("draft", "cancelled"):
            continue
        if status in ("registration", "published"):
            start = event.get("checkInOpensAt") or event.get("startsAt")
            if isinstance(start, (int, float)) and start > now_ms + 3_600_000:
                continue
        if status == "finished":
            finish = event.get("finishedAt")
            if isinstance(finish, (int, float)) and 0 < finish < now_ms - 3_600_000:
                continue
        return False
    return True


def fresh_catalogs_idle(platform, environment):
    environment = {**environment, "CHESSALIVE_ORACLE_POOL": "1"}
    results = []
    for key in ("season-events:catalog:v1", "team-tournaments:v2:catalog"):
        result = subprocess.run([str(platform.root / "bin/chessd-migrate"), "--key", key, "--get"],
                                env=environment, capture_output=True, text=True, timeout=40)
        if result.returncode == 3:
            results.append(None)
        elif result.returncode == 0:
            value = json.loads(result.stdout)
            if not isinstance(value, dict):
                raise RuntimeError("Invalid event catalog in fresh database probe")
            results.append(value)
        else:
            raise RuntimeError("Fresh read-only event catalog check failed")
    season, team = results
    # Team events have their own timing contract. A nonempty catalog needs a healthy
    # original endpoint/operator review; this recovery path never guesses those windows.
    team_idle = team is None or (isinstance(team.get("events"), dict) and not team["events"])
    if not team_idle or not conservative_catalog_idle(season, time.time() * 1000):
        raise RuntimeError("Fresh catalog probe cannot confirm an idle migration window")


def check_legacy_idle(platform, upstream, service, fresh_after=None):
    environment = process_env(service)
    token = environment.get("CHESSALIVE_METRICS_TOKEN")
    if not token:
        raise RuntimeError("Cannot verify legacy activity without its metrics token")
    request = urllib.request.Request(upstream + "/metrics", headers={"Authorization": "Bearer " + token})
    deadline = time.monotonic() + 70
    previous_heartbeat = fresh_after
    completed_samples = 0
    while True:
        with urllib.request.urlopen(request, timeout=10) as response:
            metrics = {}
            for line in response.read().decode().splitlines():
                if not line.startswith("#") and len(line.split()) == 2:
                    key, value = line.split()
                    try:
                        metrics[key] = float(value)
                    except ValueError:
                        pass
        heartbeat = metrics.get("chessalive_job_last_run_seconds:heartbeat", 0)
        if fresh_after is None:
            break
        if heartbeat > previous_heartbeat:
            # The timestamp is recorded after its gauge sample. A second completed
            # sweep proves that at least one entire sample happened after the hold.
            for key in ("chessalive_ws_connections", "chessalive_rooms_live", "chessalive_rooms_resident"):
                if metrics.get(key) != 0:
                    raise RuntimeError("Initial connection migration waits for no active games or sockets")
            previous_heartbeat = heartbeat
            completed_samples += 1
            if completed_samples >= 2:
                break
        if time.monotonic() >= deadline:
            raise RuntimeError("Cannot verify a fresh legacy heartbeat while traffic is held")
        time.sleep(0.5)
    if heartbeat < time.time() - 45:
        raise RuntimeError("Legacy activity measurements are stale")
    for key in ("chessalive_ws_connections", "chessalive_rooms_live", "chessalive_rooms_resident"):
        if metrics.get(key) != 0:
            raise RuntimeError("Initial connection migration waits for no active games or sockets")
    if http_json(upstream + "/matchmaking/pool").get("waiting") != 0:
        raise RuntimeError("Initial connection migration waits for an empty matchmaking queue")
    try:
        windows = http_json(upstream + "/season-events/active-windows", token)
    except urllib.error.HTTPError as error:
        if error.code != 503:
            raise
        # A poisoned old database connection must not be confused with an empty catalog.
        # Verify through fresh authenticated read-only connections before replacing it.
        fresh_catalogs_idle(platform, environment)
        return
    if windows.get("freeze") or windows.get("windows") or windows.get("events"):
        raise RuntimeError("Initial migration waits until the live event window ends")


def prepare_environment(stage):
    command("install", "-d", "-m", "0750", "-o", "chessalive", "-g", "chessalive", str(RUN), str(ROOT / "data/release"))
    CONFIG.mkdir(mode=0o755, exist_ok=True)
    key = CONFIG / "relay.key"
    if not key.exists():
        descriptor = os.open(key, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
        with os.fdopen(descriptor, "w") as output:
            output.write(secrets.token_hex(32) + "\n")
        command("chown", "root:chessalive", str(key))
    shutil.copyfile(stage / "chessalive-runtime.conf", "/etc/tmpfiles.d/chessalive-runtime.conf")
    installed = CONFIG / "gateway-installed.json"
    active = subprocess.run(["systemctl", "is-active", "--quiet", "chessgate"]).returncode == 0
    if active:
        if control(RUN / "gateway.sock", "status", method="GET").get("protocolVersion") != 1:
            raise RuntimeError("The existing gateway protocol is not compatible")
        if not installed.exists():
            atomic_json(installed, {"protocolVersion": 1})
        return
    if not installed.exists():
        command("install", "-m", "0755", str(stage / "chessgate"), str(ROOT / "bin/chessgate"))
        shutil.copyfile(stage / "chessgate.service", "/etc/systemd/system/chessgate.service")
        (CONFIG / "gateway.env").write_text("\n".join((
            "CHESSALIVE_GATEWAY_LISTEN=127.0.0.1:8079",
            "CHESSALIVE_GATEWAY_CONTROL_SOCKET=/run/chessalive/gateway.sock",
            "CHESSALIVE_GATEWAY_STATE_FILE=/opt/chessalive/data/release/gateway.json",
            "CHESSALIVE_RELAY_SECRET_FILE=/etc/chessalive/relay.key",
            "CHESSALIVE_GATEWAY_UPSTREAM=http://127.0.0.1:8080",
            "CHESSALIVE_GATEWAY_LEGACY_UPSTREAM=yes",
            "CHESSALIVE_GATEWAY_ALLOWED_UPSTREAMS=http://127.0.0.1:8080,http://127.0.0.1:8081,http://127.0.0.1:8082",
            "CHESSALIVE_GATEWAY_ASSET_ROOT=/opt/chessalive/client-releases", "")))
        command("systemctl", "daemon-reload")
        command("systemctl", "enable", "--now", "chessgate")
    else:
        # Recover a stopped gateway with its existing binary/configuration, never replace
        # an established connection owner as a side effect of an application deploy.
        command("systemctl", "start", "chessgate")
    deadline = time.monotonic() + 15
    while True:
        try:
            if control(RUN / "gateway.sock", "status", method="GET").get("protocolVersion") == 1:
                atomic_json(installed, {"protocolVersion": 1})
                break
        except (OSError, http.client.HTTPException):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Persistent gateway did not become ready")
        time.sleep(0.2)
    # The stable gateway is deliberately not overwritten/restarted on application releases.


def stage_release(platform, stage, slot):
    metadata = read_json(stage / "release.json")
    release_id = "release-" + time.strftime("%Y%m%dt%H%M%Sz", time.gmtime()) + "-" + secrets.token_hex(3)
    release = {"id": release_id, "slot": slot, "port": 8081 if slot == "blue" else 8082, "protocol": 1}
    directory = platform.release_dir(release)
    directory.mkdir()
    try:
        for name in ("chessd", "chessd-migrate", "chessd.service"):
            shutil.copyfile(stage / name, directory / name)
            (directory / name).chmod(0o755 if not name.endswith(".service") else 0o644)
        extract(stage / "data.tar.gz", directory / "packages/data")
        if (stage / "web.tar.gz").exists():
            extract(stage / "web.tar.gz", directory / "web")
        else:
            shutil.copytree(platform.root / "web", directory / "web", copy_function=os.link)
        manifest(directory, metadata)
        archive_client(directory, platform.root / "client-releases")
    except Exception:
        # Only this newly created directory is ours. It has not yet been returned to
        # the handoff coordinator, published to a slot, or referenced by a journal.
        shutil.rmtree(directory)
        raise
    return release


def capture_legacy(platform):
    release = {"id": "legacy-" + time.strftime("%Y%m%dt%H%M%Sz", time.gmtime()), "slot": "legacy", "port": 8080, "protocol": 0}
    directory = platform.release_dir(release)
    directory.mkdir()
    try:
        for name in ("chessd", "chessd-migrate"):
            os.link((platform.root / "bin" / name).resolve(), directory / name)
        shutil.copyfile("/etc/systemd/system/chessd.service", directory / "chessd.service")
        shutil.copytree((platform.root / "web").resolve(), directory / "web", copy_function=os.link)
        shutil.copytree((platform.root / "packages/data").resolve(), directory / "packages/data", copy_function=os.link)
        manifest(directory, {})
        archive_client(directory, platform.root / "client-releases")
    except Exception:
        shutil.rmtree(directory)
        raise
    return release


def install_gateway_route(platform):
    check_legacy_idle(platform, "http://127.0.0.1:8080", "chessd")
    path = Path("/etc/caddy/Caddyfile")
    original = path.read_text()
    if "reverse_proxy 127.0.0.1:8079" in original:
        return
    if original.count("reverse_proxy 127.0.0.1:8080") != 1:
        raise RuntimeError("Unexpected proxy configuration; refusing to replace its security rules")
    updated = original.replace("reverse_proxy 127.0.0.1:8080", "reverse_proxy 127.0.0.1:8079")
    temporary = path.with_suffix(".candidate")
    temporary.write_text(updated)
    command("caddy", "validate", "--config", str(temporary), "--adapter", "caddyfile", capture_output=True)
    check_legacy_idle(platform, "http://127.0.0.1:8080", "chessd")
    shutil.copyfile(path, path.with_suffix(".before-gateway"))
    os.replace(temporary, path)
    try:
        command("systemctl", "reload", "caddy")
    except Exception:
        path.write_text(original)
        command("systemctl", "reload", "caddy")
        raise


def bootstrap(platform, candidate):
    # The old binary predates connection handoff. It may only be replaced when no game,
    # matchmaking entry, event window or WebSocket needs migration.
    current = capture_legacy(platform)
    install_gateway_route(platform)
    platform.gateway("hold")
    try:
        check_legacy_idle(platform, "http://127.0.0.1:8080", "chessd", fresh_after=time.time())
    except Exception:
        platform.gateway("abort")
        raise
    atomic_json(platform.journal, {"phase": "bootstrap", "current": current, "candidate": candidate})
    command("systemctl", "stop", "chessd")
    try:
        # Only this verified-idle legacy path creates empty volatile state. Normal releases
        # and rollback always use the complete old process's exported snapshot.
        paused = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        initial = {"schemaVersion": 1,
                   "rooms": {"version": 1, "pausedAt": paused, "rooms": [], "dareTombs": {}, "watcherSalt": secrets.token_hex(32)},
                   "match": {"version": 1, "pausedAt": paused, "queue": {}, "results": {}, "expired": {}, "boardRefused": {},
                             "pending": {}, "chats": [], "rematchHandled": {}, "settledSeen": {}, "recentOpponents": {}},
                   "dataplane": {"version": 1, "invites": {}, "recovery": {}}}
        atomic_json(platform.recovery_file, initial)
        platform.publish_active(candidate)
        platform.start(candidate)
        platform.runtime(candidate, "restore", initial)
        platform.runtime(candidate, "resume")
        platform.health(candidate)
        platform.gateway("switch", {"upstream": platform.upstream(candidate)})
        platform.gateway("resume")
    except Exception:
        gate = platform.gateway("status", method="GET")
        if gate.get("phase") != "active" or gate.get("currentUpstream") != platform.upstream(candidate):
            if gate.get("phase") not in ("held", "prepared", "failed") or gate.get("currentUpstream") != platform.upstream(current):
                raise RuntimeError("Initial migration commit status is uncertain; preserving the candidate and recovery checkpoint")
            # Once the gateway commits, users may already have created new state.
            # A lost ACK must not discard that writer and return to legacy memory.
            platform.stop(candidate)
            platform.publish_active(None)
            command("systemctl", "start", "chessd")
            for _ in range(60):
                try:
                    if http_json("http://127.0.0.1:8080/health").get("ok"):
                        break
                except (OSError, ValueError):
                    time.sleep(1)
            else:
                raise RuntimeError("Initial migration recovery requires attention; snapshot retained")
            platform.gateway("switch", {"upstream": "http://127.0.0.1:8080", "legacy": True})
            platform.gateway("resume")
            platform.journal.unlink(missing_ok=True)
            platform.recovery_file.unlink(missing_ok=True)
            raise
    platform.complete(current, candidate)
    retire_legacy_service(platform)
    command("systemctl", "enable", "chessd@" + candidate["slot"])


def retire_legacy_service(platform):
    # The original unit has no writer fence. Prevent accidental manual starts after
    # adoption while keeping the captured original unit available for inspection.
    directory = Path("/etc/systemd/system/chessd.service.d")
    directory.mkdir(exist_ok=True)
    (directory / "release-gateway.conf").write_text(
        "[Unit]\nConditionPathExists=!" + str(platform.state_file) + "\n")
    command("systemctl", "disable", "chessd")
    command("systemctl", "daemon-reload")


def recover_interrupted(platform):
    journal = read_json(platform.journal)
    if not journal:
        raise RuntimeError("There is no interrupted handoff to recover")
    current, candidate = journal["current"], journal["candidate"]
    gate = platform.gateway("status", method="GET")
    if gate.get("phase") == "active" and gate.get("currentUpstream") == platform.upstream(candidate):
        # Commit reached the stable gateway; reconcile bookkeeping without reversing traffic.
        platform.health(candidate)
        platform.publish_active(candidate)
        platform.complete(current, candidate)
        if current.get("protocol") == 1:
            platform.stop(current)
        else:
            retire_legacy_service(platform)
        platform.prune()
        return
    if current.get("protocol") == 0:
        # Initial migration has no transferable old state and is admitted only while idle.
        old_running = subprocess.run(["systemctl", "is-active", "--quiet", "chessd"]).returncode == 0
        candidate_state = platform.runtime(candidate, "status", method="GET").get("state")
        if gate.get("phase") == "active":
            platform.gateway("hold")
        if candidate_state == "active" and not old_running:
            platform.health(candidate)
            platform.gateway("switch", {"upstream": platform.upstream(candidate)})
            platform.publish_active(candidate)
            platform.gateway("resume")
            platform.complete(current, candidate)
            retire_legacy_service(platform)
        else:
            platform.stop(candidate)
            platform.publish_active(None)
            if not old_running:
                command("systemctl", "start", "chessd")
            deadline = time.monotonic() + 90
            while True:
                try:
                    if http_json("http://127.0.0.1:8080/health").get("ok"):
                        break
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("Legacy application has not recovered; traffic remains held")
                time.sleep(0.25)
            platform.gateway("switch", {"upstream": "http://127.0.0.1:8080", "legacy": True})
            platform.gateway("resume")
            platform.journal.unlink(missing_ok=True)
        return
    old = platform.runtime(current, "status", method="GET")
    new = platform.runtime(candidate, "status", method="GET")
    if gate.get("phase") == "active":
        platform.gateway("hold")
    if journal.get("phase") in ("prepared", "activating") and new.get("state") in ("standby", "stopped", "failed") and old.get("state") not in ("active", "quiescing", "resuming"):
        raise RuntimeError("Initialized candidate lost its live state; refusing to overwrite newer durable data with an older checkpoint")
    if old.get("state") in ("active", "quiescing", "resuming") and not old.get("terminalLifecycleStopped") and new.get("state") in ("standby", "stopped", "failed"):
        # This also covers an interrupted recovery after the fresh old process resumed.
        platform.runtime(current, "resume")
        platform.health(current)
        platform.stop(candidate)
        platform.publish_active(current)
        if gate.get("candidateTouched"):
            platform.gateway("switch", {"upstream": platform.upstream(current)})
            platform.gateway("resume")
        else:
            platform.gateway("abort")
        platform.recovered(current)
        return
    handoff = Handoff(platform)
    handoff.quiesced = old.get("state") in ("quiesced", "standby", "stopped", "failed")
    handoff.candidate_started = new.get("state") != "stopped"
    handoff.candidate_restored = new.get("state") in ("prepared", "resuming", "active", "quiesced", "quiescing")
    if platform.recovery_file.exists():
        handoff.snapshot = platform.recovery_file.read_bytes()
    # Missing snapshots are never substituted with guessed empty game state.
    handoff.recover(current, candidate)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("status", "deploy", "rollback", "recover"))
    parser.add_argument("--stage", type=Path)
    args = parser.parse_args()
    platform = Platform()
    if args.mode == "status" and not platform.releases.exists():
        print(json.dumps(platform.status()))
        return
    platform.releases.mkdir(parents=True, exist_ok=True)
    lock = (platform.releases / "transaction.lock").open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        if args.mode == "status":
            print(json.dumps(platform.status(busy=True)))
            return
        raise RuntimeError("Another deployment or rollback is running")
    if args.mode == "status":
        print(json.dumps(platform.status()))
        return
    if args.mode == "recover":
        recover_interrupted(platform)
        return
    if platform.journal.exists():
        raise RuntimeError("A previous interrupted handoff needs recovery before another release")
    state = read_json(platform.state_file)
    current = state.get("current")
    if args.mode == "deploy":
        if not args.stage or args.stage.parent != Path("/tmp") or not args.stage.name.startswith("chessd-deploy-") or args.stage.is_symlink() or not args.stage.is_dir():
            raise ValueError("Invalid deployment staging directory")
        try:
            prepare_environment(args.stage)
            candidate = stage_release(platform, args.stage, "green" if current and current["slot"] == "blue" else "blue")
        finally:
            # The host controller owns the transaction lock here; all later work
            # uses the isolated release. SSH loss must not run a competing cleanup.
            shutil.rmtree(args.stage)
    else:
        candidate = state.get("previous")
        if not current or not candidate:
            raise RuntimeError("No complete fallback is available")
        verify(platform.release_dir(candidate))
        if candidate.get("protocol") != 1:
            raise RuntimeError("The retained pre-gateway build requires an idle migration; seamless rollback starts with the next compatible release")
        mark("rollback_prepare", "done")
        mark("rollback_restore", "running")
    if not current:
        bootstrap(platform, candidate)
    else:
        if current.get("protocol") != 1:
            raise RuntimeError("Legacy deployment must complete its initial migration first")
        Handoff(platform).run(current, candidate)
    mark("rollback_restore" if args.mode == "rollback" else "deploy", "done")
    mark("rollback_health" if args.mode == "rollback" else "health", "running")
    if not http_json("http://127.0.0.1:8079/health").get("ok"):
        raise RuntimeError("Gateway health verification failed")
    command("systemctl", "enable", "chessd@" + candidate["slot"])
    if current:
        command("systemctl", "disable", "chessd@" + current["slot"])
    platform.prune()
    mark("rollback_health" if args.mode == "rollback" else "health", "done")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Release stopped: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
