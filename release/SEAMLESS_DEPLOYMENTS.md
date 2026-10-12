# Connection-preserving releases

Mumbai runs a stable `chessgate` connection gateway on loopback port 8079 behind the existing
Caddy security/TLS configuration. Application releases alternate between `chessd@blue` on 8081
and `chessd@green` on 8082. Only one application owns the writer lock. The gateway is installed
once and is not restarted or overwritten by routine application deployment or rollback.

The gateway holds new work, drains ordered WebSocket barriers, and retains browser sockets.
The old application drains accepted requests and background work, pauses game clocks, exports
its versioned volatile state, flushes persistence, and releases its writer lock. A fresh candidate
imports that state, reattaches authenticated transports, compensates clocks, and passes liveness,
readiness and database-backed version checks before traffic resumes. Queued actions keep their
order. Web clients offer updates without forcing navigation or refreshing open pages.

This is a short traffic pause during planned releases, not a guarantee against machine, network,
database or gateway failure. The first migration from a legacy binary requires a verified idle
window: no sockets, resident games, actual matchmaking waiters or active tournament windows. Its
old sockets cannot be retroactively migrated. Two advancing heartbeat samples are required after traffic is held.
Never bypass these checks to meet a deployment deadline.

## Storage and rollback

`/opt/chessalive/releases/deployment.json` identifies the current release and exactly one complete
previous release. Each has a checksum manifest covering server, publisher, unit, web and puzzle
files. Successful deployment or rollback verifies health, changes the active release, and removes
older managed complete releases. Rollback moves the latest live state to a fresh previous binary;
it never restores an old database backup or resumes stale in-memory game state. The console's
Rollback button enables only when a complete compatible fallback exists and no operation runs.
A legacy pre-gateway fallback is retained during initial adoption but cannot import live state;
the next compatible release enables seamless rollback.

`/opt/chessalive/client-releases` separately retains immutable assets needed by already-open tabs.
It does not retain extra runnable builds or HTML pages. Content-identical assets share disk blocks
using hard links; versioned URLs always return their original bytes, including compressed forms.
Deleting these compatibility assets can break older open tabs, so ordinary cleanup preserves them.

## Recovery and configuration

The private controls live under `/run/chessalive` with owner-only Unix sockets. The relay key is
`/etc/chessalive/relay.key`, root-owned and readable by the application group. The release journal
and recovery checkpoint are persistent local files with mode 0600. They contain private session
and game data: never print them in CI logs or upload them. The journal forces restarting slots
into standby until an interrupted operation is explicitly reconciled.

The host controller is installed in `/opt/chessalive-release-tools`. To inspect or reconcile an
interrupted transaction on Mumbai:

```sh
sudo python3 /opt/chessalive-release-tools/runtime_transaction.py status
sudo env MODE=recover bash /path/to/chessalive-ci/release/runtime-transaction.sh
```

The second command runs under a transient systemd service so losing the SSH viewer does not kill
the operation. Alternatively invoke the installed Python controller's `recover` mode from a
persistent operator session. Recovery refuses an older checkpoint if an initialized candidate
lost newer live state. Preserve the checkpoint and inspect the private service logs in that case.
Never delete the journal or manually start both slots to get past a refusal.

The retired legacy `chessd` unit is disabled and conditioned on absence of deployment.json, so an
old maintenance command cannot start an unfenced second writer. Vault still owns
`/etc/chessalive.env`. After changing/pulling configuration, activate it with a normal CI release;
manual restarts of the active slot do not provide connection-preserving state transfer. Rollback
of application code does not roll back Vault secrets or database schemas.

The application protocol and compatible schemas are versioned. Changes that cannot import the
retained release's state require a separately planned migration. Gateway upgrades also require a
separate connection-drain plan; routine application deployment deliberately leaves it running.

## Host packages

Every deploy installs what the application needs on the host before the candidate starts, skipping
anything already present and never failing the deploy: Stockfish for Coach V5, and a pinned
official Node 22 build in `/opt/chessalive/node-v<version>-linux-<arch>` behind the symlink
`/opt/chessalive/node`. chessd carries the Coach V4 (beta) brain in its own binary and runs it
itself as a supervised child process, so the deploy only installs Node: there is no brain service
or token to manage, and a rollback rolls the brain back with chessd. The child runs in its slot's
cgroup, so `chessd@.service` budgets for both (Go's 5 GiB `GOMEMLIMIT` plus up to 1.5 GiB for the
runtime, under `MemoryHigh=7G` and `MemoryMax=9G`; two slots overlap only during a handoff on the
24 GB host) and sets `KillMode=mixed`, so a stop signals chessd alone and chessd stops the child
itself. Change those limits together with `GOMEMLIMIT`. Without Node the deploy prints one warning
and V4 (beta) stays quiet. To upgrade Node, change the version and both sha256 values (from that
release's `SHASUMS256.txt`) in `runtime-transaction.sh` together.
