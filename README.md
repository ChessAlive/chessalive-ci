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
| `chessalive-content` | Ships committed `content/uploads` + `content/catalog` to the OCI host: installs the files prod lacks, merges the catalog slices, bumps `appStateRevision` — or does nothing when prod already matches. Node + rsync + ssh only. | Polls `main` every 5 min **on the GCP box** (below). Written disabled on a workstation, where a poll of the local checkout would publish unpushed commits. |

## Where things live

The pipelines are **not** in this repository — they live in the ChessAlive repo as
`Jenkinsfile.dev`, `Jenkinsfile.release`, `Jenkinsfile.config` and `Jenkinsfile.content`, with
the deploy script at `infra/oci/deploy-chessd.sh` and the content publisher at
`infra/oci/publish-content.sh`.

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

## Linux / GCP CI box

The always-on controller: `chessalive-prod-1` in GCP (`chessalive-495918`, `us-central1-a`,
`34.30.115.188`), the Debian 12 e2-micro that served ChessAlive before the OCI cutover and now runs
nothing but Jenkins. The lifecycle helper on the ChessAlive side is `infra/gcp/ci-vm.sh` and the
box is documented in `infra/gcp/CI-VM.md` there; this section is the installer's half.

**The decision (2026-09-04): the micro stays free-tier.** It runs one lane, `chessalive-content`
(`Jenkinsfile.content`) — the owner's "commit mechanism" for GLBs and catalog slices: a poll of
`main` every five minutes, a pure-node verify, then `infra/oci/publish-content.sh` with
`MIGRATE_BIN=remote`, which needs only node, rsync, ssh, curl and git (no `npm ci`, no Go) and
runs in well under 200 MB. `chessalive-dev`, `-release` and `-config` are written on the box too
but **disabled**: they need several GB and stay on the Mac's `jenkins-lts` until the VM is resized
(optional, below). Both controllers exist at once; only the Mac one releases code, only the GCP
one publishes content.

### Install

```bash
# from your Mac: copy the installer, then run it on the box
rsync -a --exclude .git --exclude __pycache__ --rsync-path='sudo -n rsync' \
  -e "ssh -i ~/.ssh/google_compute_engine -o IdentitiesOnly=yes" \
  ~/Documents/chessalive-ci/ lakshmi_chessalive_com@34.30.115.188:/opt/chessalive-ci/installer/
ssh -i ~/.ssh/google_compute_engine -o IdentitiesOnly=yes lakshmi_chessalive_com@34.30.115.188 \
  'sudo CHESSALIVE_JENKINS_PASSWORD=generate /opt/chessalive-ci/installer/install-linux.sh'
ssh -i ~/.ssh/google_compute_engine -o IdentitiesOnly=yes lakshmi_chessalive_com@34.30.115.188 \
  'sudo /opt/chessalive-ci/installer/lib/ci-user-keys.sh'
```

`install-linux.sh` (root, Debian/Ubuntu, idempotent — re-running it is how the box is updated)
installs Jenkins LTS from `pkg.jenkins.io` with the 2026 signing key pinned by fingerprint,
Temurin 21, Node 22 (nodesource, pinned to the major prod runs), Go from the official tarball
(checksum-verified; unused by the content lane, there for the day the build lanes move), git/rsync/
file/build-essential, Chromium's shared libraries for Playwright, and a 2 GB swap file. Jenkins is
bound to `127.0.0.1` by a systemd drop-in that also sets the heap (384m on the micro) and
`TimeoutStartSec=300` — the packaged 90 s is shorter than a cold boot on two shared vCPUs, and a
restart that loses that race is SIGTERMed mid-initialisation and left "failed" although the next
attempt comes up. The setup wizard is replaced by the same `init.groovy.d` bootstrap the Mac uses
(minus `04-allow-local-checkout` — the remote is GitHub here, and `file://` checkouts on a shared
box would let anyone build any local directory as the jenkins user), plugins are resolved with
their dependencies by `lib/resolve-plugins.py` against the LTS update center, and the four jobs are
written by `lib/install-jobs.sh` with `REPO_URL=git@github.com:ChessAlive/ChessAlive.git`.
`install-jobs.sh` decides from `MemTotal` on its own (under 3 GB → dev/release/config disabled,
content enabled), so a plain re-run on the micro can never switch on a lane that would OOM it.
The log of every run is appended to `/opt/chessalive-ci/install.log`.

The admin password is **required** — there is no `admin`/`admin` on a VM other people can reach.
`CHESSALIVE_JENKINS_PASSWORD=generate` makes a random one and writes it only to
`/var/lib/jenkins/chessalive-ci-admin-password.txt` (0600, jenkins); re-runs reuse that file. Read
it with `sudo cat /var/lib/jenkins/chessalive-ci-admin-password.txt` on the box.

`lib/ci-user-keys.sh` gives the `jenkins` user an ed25519 key (comment `jenkins@chessalive-ci-gcp`;
the private half never leaves the box) and pins the host keys for `github.com` (checked against
GitHub's published fingerprints) and the OCI host. It prints the public key: register it as a
**read-only deploy key** on `ChessAlive/ChessAlive` and append it to
`/home/ubuntu/.ssh/authorized_keys` on `144.24.117.171`. Verify both from the box:

```bash
sudo -u jenkins -H ssh -n -o BatchMode=yes ubuntu@144.24.117.171 'sudo -n true && echo OK'
sudo -u jenkins -H git ls-remote git@github.com:ChessAlive/ChessAlive.git main
```

### Reaching it

Jenkins listens on loopback only. From your Mac:

```bash
infra/gcp/ci-vm.sh tunnel        # in the ChessAlive repo → http://127.0.0.1:8080
```

(or the raw form: `ssh -i ~/.ssh/google_compute_engine -o IdentitiesOnly=yes -N -L 8080:127.0.0.1:8080 lakshmi_chessalive_com@34.30.115.188`).
Local port 8080 is taken while the Mac's own `jenkins-lts` is running — use `--local-port 8081`.

### What the box can and cannot do

969 MB RAM, 2 GB swap, 20 GB disk with **3.7 GB free** (the retired site still occupies ≈7 GB
under `/opt/chessalive*`). Idle Jenkins is ≈370 MB RSS on a 384 MB heap, leaving ≈200–300 MB
for a build: enough for the content lane's shallow clone + node + rsync, not for anything that
runs `npm ci`. Keep it that way — do not enable the build lanes here without a resize.

### Optional: moving the build lanes here

Only if the owner wants to retire the Mac's Jenkins entirely. Not free tier.

1. **Resize.** After `gcloud auth login` on your Mac:
   `infra/gcp/ci-vm.sh resize --machine-type e2-medium --disk-gb 40` (e2-medium = 4 GB is the
   floor; e2-standard-2 = 8 GB makes `expo export` comfortable), then re-run
   `install-linux.sh` with `CHESSALIVE_JENKINS_HEAP=2g DISABLE_JOBS=no`.
2. **OCI API key for the jenkins user.** The Assets stage (`infra/oci/sync-assets.sh`) and the
   config lane (`infra/oci/vault-config.sh`) call the `oci` CLI. Install it on the box and
   register a CI-only API key in the OCI console — do not copy your own `~/.oci`. The content lane
   needs none of this.
3. **Green a dev build, then a release**, and only then `brew services stop jenkins-lts` on the
   Mac. Two controllers *releasing* is the thing to avoid.

### Rollback of the box

The retired stack is stopped and disabled, not deleted — `systemctl start chessalive-green
chessalive-router caddy redis-server` brings it back exactly as it was (Caddy takes 80/443 again;
Jenkins on loopback 8080 does not conflict). The state it was in is recorded in
`/opt/chessalive-ci/PREVIOUS-STACK.md` on the VM. DNS points at OCI, so this is only an
application rollback on a pre-cutover data snapshot.
