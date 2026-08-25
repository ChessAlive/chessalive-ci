# chessalive-ci

## Install

One command. Requires only `git`, Homebrew, and SSH access to the ChessAlive org — the same
access you already need to clone the main repo. No `gh` CLI, no arguments.

```bash
rm -rf /tmp/chessalive-ci && git clone --depth 1 git@github.com:ChessAlive/chessalive-ci.git /tmp/chessalive-ci && /tmp/chessalive-ci/install.sh
```

It finds your ChessAlive checkout automatically (`~/Documents/ChessAlive`, `~/ChessAlive`,
`~/src/ChessAlive`, or a sibling of this repo). If yours is somewhere else, pass it:

```bash
/tmp/chessalive-ci/install.sh /path/to/ChessAlive
```

The installer puts Jenkins in place via Homebrew, bootstraps it non-interactively (no setup
wizard), installs the pipeline plugins, wires in the dev/release/config jobs, and starts the
service. Re-running is safe — it refreshes the job definitions.

Then open <http://localhost:8080> and sign in as **admin** / **admin**.

Override the password with `CHESSALIVE_JENKINS_PASSWORD=... /tmp/chessalive-ci/install.sh`. It is
written only to your own `~/.jenkins`, never committed.

Jenkins binds to `127.0.0.1` only — it is not reachable from your network. It can deploy to
production, so treat local access to it as production access.


One-command local Jenkins for [ChessAlive](https://chessalive.com). Stands up a Jenkins on your
own machine with the project's **dev** and **release** pipelines already wired in.

> **Keep this repository private.** It describes how ChessAlive reaches its production host.

## Install

```bash
git clone <this-repo> chessalive-ci
cd chessalive-ci
./install.sh /path/to/ChessAlive
```

The path is optional — the installer looks in the usual places (`~/Documents/ChessAlive`,
`~/ChessAlive`, `~/src/ChessAlive`, and a sibling directory) and uses what it finds.

Run it twice: the first run stops at the Jenkins setup wizard (you pick your own admin password —
this installer never sets one), the second run adds the jobs. Re-running later is safe and just
refreshes the job definitions.

Requires macOS with [Homebrew](https://brew.sh), plus `node`, `go`, and `git` for the pipelines
themselves. On Linux, install Jenkins with your package manager and run
`./lib/install-jobs.sh /path/to/ChessAlive` directly.

## What you get

Jenkins at **http://127.0.0.1:8080** — bound to localhost only, so it is not reachable from your
network. That is deliberate: Jenkins runs arbitrary code by design, and a build server on an open
port is a standing invitation.

| Job | What it does | When it runs |
|---|---|---|
| `chessalive-dev` | typecheck · lint · unit + infra tests · `go vet` · `go test` · cross-compile for linux/arm64 | Polls your checkout every 5 min. Touches no server — safe on every commit. |
| `chessalive-release` | Everything above, plus the slow gates (npm advisory audit, narration coverage, perf and bundle budgets), then deploys `chessd` and the web bundle to the OCI host. | Manual. Pauses for your approval *after* the guard is green, and rolls back automatically if the post-restart health gate fails. |

## Where things live

The pipelines are **not** in this repository — they live in the ChessAlive repo as
`Jenkinsfile.dev` and `Jenkinsfile.release`, with the deploy script at
`infra/oci/deploy-chessd.sh`.

That split is the point: a pipeline has to version with the code it builds. Adding a test script
and teaching CI to run it should be one commit, reviewed together. If the Jenkinsfiles lived here
instead, every pipeline change would be a two-repo dance and the two would drift.

So: **edit pipelines in ChessAlive. Edit the installer here.**

## Secrets

This repo contains none, and neither do the pipelines. Production secrets live in OCI Vault and
are materialized onto the host by `chessalive-pull-secrets.sh`. To change one, edit it in the
Vault console and then, on the host:

```bash
sudo chessalive-pull-secrets.sh && sudo systemctl restart chessd
```

The release job needs SSH access to the production host, which it takes from your own `~/.ssh`.
It never transports a credential of its own.

## Caveats

- **Builds only run while your machine is awake.** This is a workstation CI, not a service. There
  are no nightly or unattended runs. If you later want always-on CI, put it on a dedicated box —
  not on the production host, which is exactly what this layout avoids.
- The dev job builds `main` by default. The Go/OCI stack merged to main on 2026-08-24; the
  pre-merge main is preserved as `main-backup`. Override with
  `BRANCH=<name> ./lib/install-jobs.sh …`.
