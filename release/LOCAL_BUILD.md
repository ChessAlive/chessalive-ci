# Local OCI build trigger

The supported release path is now local to the Hyderabad build host:

```text
browser (in-page password) → build-trigger.mjs → local-release.sh → build on Hyderabad → SSH deploy to Mumbai
```

It does not invoke Jenkins, Google Cloud Build, `gcloud`, or a second build machine. The release
uses the current checkout on Hyderabad and the deployment keeps the existing atomic web swap,
health gate, and one-build rollback behavior on Mumbai.

## Install on the OCI host

Copy the repository to `/opt/chessalive`, install the pinned Node and Go toolchains, and make sure
the Oracle Linux host is already provisioned with `chessd.service`, `/etc/chessalive.env`, the
`chessalive` service user, and passwordless sudo for the deployment operations. The trigger unit
runs as the default Oracle Linux account `opc`. Then:

```sh
sudo install -m 0644 infra/oci/chessalive-build-trigger.service \
  /etc/systemd/system/chessalive-build-trigger.service
sudoedit /etc/chessalive-build.env
```

Put the console credentials and release settings in `/etc/chessalive-build.env` (mode `0600`):

```text
BUILD_TRIGGER_TOKEN=replace-with-a-long-random-token
BUILD_TRIGGER_USER=admin
BUILD_TRIGGER_PORT=8787
# The new host can build before the production Vault env is migrated.
# Remove this line only after chessd.service and /etc/chessalive.env are provisioned.
SKIP_DEPLOY=yes
SKIP_INSTALL=yes
SKIP_TESTS=yes
SKIP_BUDGETS=yes
```

Start it:

```sh
sudo chmod 0600 /etc/chessalive-build.env
sudo systemctl daemon-reload
sudo systemctl enable --now chessalive-build-trigger
curl http://127.0.0.1:8787/health
```

Open `http://<instance-public-ip>:8787/` from the allowed network and enter the same token. The
OCI security list must allow TCP `8787` from the intended source IPs; do not open the build port to
the whole internet. The console uses an in-page password form and no browser username/password
alert. The token is never stored in the repository or in browser storage. Release status refreshes
every 2 seconds; production is checked every 10 seconds
and transition alerts reuse the original ChessAlive Resend credentials from `/etc/chessalive.env`
(`CHESSALIVE_RESEND_API_KEY` and `CHESSALIVE_OTP_FROM`) together with `BUILD_ADMIN_EMAILS`.
SMTP through `BUILD_SMTP_URL` remains an optional fallback.

The default local release runs the complete code/test/build gates and skips the optional object
storage/content publishing lanes:

```sh
npm run release:local
```

The build trigger can use `LOCAL_DEPLOY=yes` for same-host installs, or `DEPLOY_REMOTE=yes` with
`DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY` to cross-compile on Hyderabad and deploy the
host-native artifact to Mumbai over SSH. This remote path still performs the same atomic install,
restart, and health gate; it does not use Jenkins or Cloud Build.
On a newly created host, `SKIP_DEPLOY=yes` runs all local checks and produces the host-native
binary/web artifacts while the existing production Vault secret is being migrated. Set it to `no`
after `chessd.service` and `/etc/chessalive.env` are installed.

The Release Now button runs the full code release, including dependency installation, test/lint
gates, browser setup, performance/bundle checks, ARM64 compilation, atomic Mumbai deployment, and
the production health gate. It intentionally leaves the optional object-storage asset lane and
content/database lane disabled.

For a quick manual trigger, `SKIP_INSTALL=yes` reuses the already-installed lockfile dependencies
and `SKIP_TESTS=yes` omits the repository test/lint gates. The server and migration binaries build
in parallel; browser setup also runs alongside them. `SKIP_BUDGETS=yes` omits only the performance
and bundle-size checks when the current checkout is over those release budgets.
`SKIP_ASSETS=no` can be enabled after the host has a working OCI CLI profile. Content publishing
remains a separate data operation because its existing script has its own catalog conflict and
prune safeguards.
