# ChessAlive CI control plane

This repository is the private operations control plane for ChessAlive. It runs on the Hyderabad
OCI build instance and owns the release console, build orchestration, Mumbai deployment, release
monitoring, notifications, and the separated admin source snapshot.

## Architecture

```text
browser → Hyderabad :8787 (in-page password)
        → local release build/test on Hyderabad
        → SSH artifact deploy + health gate on Mumbai
        → chessalive.com
```

There is no Jenkins, Google Cloud Build, or second build service in this path. Mumbai is a
production-only host: it runs the persistent connection gateway and active application slot, serving the already-built web bundle. The
Hyderabad host is the only place that builds, releases, monitors, and sends operations mail.

The release lane deliberately skips object-storage asset mirroring and content publishing. Those
lanes can mutate uploaded content or the live catalog/database and are not part of a code release.
Before deployment, a read-only content readiness gate compares the source's required motion
names, model versions and ceremony bindings with the public production catalog, then checks every
required model URL. A code release fails when reviewed content has not been published; an app
health response alone is insufficient. Publish approved content separately with:

```sh
SOURCE_ROOT=/opt/chessalive OCI_HOST=144.24.117.171 OCI_USER=ubuntu \
  SSH_KEY=/home/opc/.ssh/chessalive-deploy MIGRATE_BIN=remote CONTENT_PRUNE=report \
  bash content/publish-content.sh --dry-run
# After reviewing the plan, run the same command without --dry-run.
```

The publisher installs immutable, checksum-verified model files before updating the catalog,
checks revision conflicts, and proves the public revision, ETag and a no-op re-merge. Report pruning
preserves previous model versions. Its inventory uses non-interactive sudo to traverse protected
upload subdirectories without changing their permissions. Code releases do not publish or prune.
The deploy still ships the read-only puzzle data files required by the running server.

The web build stages a production public subset while preserving the full source asset library.
The current Coach keeps its existing welcome recording; retired Coach artwork and animation
libraries are excluded. Image dependency scanning covers every exported tab, linked catalogs,
PWA icons, model textures and server previews, rather than relying on which screens a guest visits.
Source-keyed image validation and compression caches survive source synchronization.

Web transfer compares the candidate with the checksum manifest of one exact retained Mumbai
release. It streams changed files plus a complete inventory; installation verifies unchanged
bytes before linking them into the isolated candidate. Deleted files are omitted, and checksum
or missing-baseline failures stop preparation before traffic handoff. First installs and explicitly
provided full archives remain supported. Logs report transfer and install/health durations
separately; cached builds and small releases do not upload the entire media library again.

## Repository layout

- `release/` — authenticated web console, local build pipeline, atomic Mumbai deploy, and systemd unit
- `admin/` — admin UI source and admin operations documentation removed from the public app surface
- `production/` — the production runtime unit installed on Mumbai
- `content/` — retained, explicitly separate data/asset tools; never called by the code release
- `config/build.env.example` — non-secret configuration template

## Hyderabad installation

The source checkout being released lives at `/opt/chessalive`. This repository is installed beside
it at `/opt/chessalive-ci`:

```sh
cd /opt/chessalive-ci
npm ci --omit=optional
sudo install -m 0644 release/chessalive-build-trigger.service \
  /etc/systemd/system/chessalive-build-trigger.service
sudo chmod 0600 /etc/chessalive-build.env
sudo systemctl daemon-reload
sudo systemctl enable --now chessalive-build-trigger
```

Set the secret values only in `/etc/chessalive-build.env`, never in Git. At minimum configure
`BUILD_TRIGGER_TOKEN`, `SOURCE_DIR=/opt/chessalive`, the Mumbai SSH values, and
`BUILD_ADMIN_EMAILS`. Release and monitoring mail reuse the original ChessAlive Resend credentials
(`CHESSALIVE_RESEND_API_KEY` and `CHESSALIVE_OTP_FROM`) loaded from `/etc/chessalive.env` on
Hyderabad. SMTP remains an optional fallback through `BUILD_SMTP_URL`.

Open `http://<hyderabad-public-ip>:8787/`. The console displays an in-page password screen; no
browser username/password alert is used. Enter `BUILD_TRIGGER_TOKEN` and the console creates a
short-lived HttpOnly session.

## Measurements

Each release records independent step start/end times, total elapsed time and sampled build
process memory. Skipped steps have no duration. Memory is sampled once a second from the build
process group and descendants; shared pages may be counted more than once, and brief peaks
between samples can be missed. The latest run survives a console restart in `.state/`.

The infrastructure panel samples Hyderabad locally and Mumbai through the existing deploy SSH
connection every ten seconds. It reports CPU counter deltas, `MemAvailable`, filesystem space,
default-route network counters and rates, and systemd cgroup memory. Service memory and process
RSS are separately labeled. A failed collection preserves its last timestamp and marks the data
unavailable rather than showing zero.

OCI information is collected independently on each host every five minutes using its instance
principal. The two servers belong to separate accounts; their allowances must never be combined.
Hyderabad uses `python3` and Mumbai uses `/opt/oci-cli-venv/bin/python3`, with the OCI SDK installed.
Provider measurements retain their own observation time and aggregation window. Consumption
covers completed UTC days and may lag; NIC traffic is not monthly billable traffic. Provisioning
quotas are not free-tier allowances. The dashboard only labels a database as free tier when OCI
reports that status, and does not invent unavailable entitlement balances.

## Safety boundary

`Release Now` performs code install, tests, ARM64 compilation, web build, a connection-preserving
application handoff, and Mumbai readiness checks. It does not publish content or run standalone
database migrations. One complete compatible previous release supports the console Rollback
button. Failed candidates recover through a fresh previous process with the latest transferred
game state. See [deployment and recovery](release/SEAMLESS_DEPLOYMENTS.md) for bootstrap,
retention, operational limits and interrupted-release recovery.
