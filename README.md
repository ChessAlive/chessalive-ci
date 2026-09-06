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
production-only host: it runs the chessd service and serves the already-built web bundle. The
Hyderabad host is the only place that builds, releases, monitors, and sends operations mail.

The release lane deliberately skips object-storage asset mirroring and content publishing. Those
lanes can mutate uploaded content or the live catalog/database and are not part of a code release.
The deploy still ships the read-only puzzle data files required by the running server.

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
`BUILD_ADMIN_EMAILS`. `BUILD_SMTP_URL` is required before release or monitoring mail can be
delivered.

Open `http://<hyderabad-public-ip>:8787/`. The console displays an in-page password screen; no
browser username/password alert is used. Enter `BUILD_TRIGGER_TOKEN` and the console creates a
short-lived HttpOnly session.

## Safety boundary

`Release Now` performs code install, tests, ARM64 compilation, web build, atomic deployment, and a
Mumbai health gate. It does not run database migrations or publish content. A failed health gate
restores the previous Mumbai binary, web bundle, and service unit.
