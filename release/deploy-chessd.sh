#!/usr/bin/env bash
#
# Deploy chessd + the web bundle to the OCI A1 box.
#
# This is the ONLY supported chessd deploy path. Before it existed the OCI box was provisioned by
# hand, which is how the box and the repo drifted apart; anything you change on the server that
# should survive the next deploy belongs in this file (or in the systemd unit beside it).
#
# Safety model — the deploy is reversible at every step:
#   • the previous binary is kept as chessd.prev and restored automatically if the new one fails
#     its health gate, so a bad build costs ~15s of downtime rather than an outage;
#   • the web bundle is staged into a sibling directory and swapped by rename, so a half-uploaded
#     bundle is never served;
#   • secrets are never uploaded — /etc/chessalive.env is owned by OCI Vault
#     (chessalive-pull-secrets.sh). This script does not read or write it.
#
# Usage:
#   infra/oci/deploy-chessd.sh                 # build, upload, restart, health-gate
#   SKIP_BUILD=yes infra/oci/deploy-chessd.sh  # reuse artifacts already on disk (CI: build once)
#   SKIP_WEB=yes   infra/oci/deploy-chessd.sh  # server-only deploy (no client change)
#
set -euo pipefail

CI_ROOT="${CI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SOURCE_ROOT="${SOURCE_ROOT:-/opt/chessalive}"

OCI_HOST="${OCI_HOST:-144.24.117.171}"
OCI_USER="${OCI_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-}"
LOCAL_DEPLOY="${LOCAL_DEPLOY:-no}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/chessalive}"
SERVICE="${SERVICE:-chessd}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-1}"
SKIP_BUILD="${SKIP_BUILD:-}"
SKIP_WEB="${SKIP_WEB:-}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')}"

BINARY_SRC="${SOURCE_ROOT}/apps/go-server/chessd-linux-${TARGET_ARCH}"
# chessd-migrate rides with every release so content publishes (publish-content.sh, the content
# lane on the CI box) write the catalog with the SAME persistence code the running server has.
MIGRATE_SRC="${SOURCE_ROOT}/apps/go-server/chessd-migrate-linux-${TARGET_ARCH}"
WEB_SRC="${SOURCE_ROOT}/apps/player-app/dist"
UNIT_SRC="${CI_ROOT}/production/chessd.service"

SSH_OPTS=(-o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
[[ -n "${SSH_KEY}" ]] && SSH_OPTS+=(-i "${SSH_KEY}")

if [[ "${LOCAL_DEPLOY}" == yes ]]; then
  # The build trigger lives on the OCI box. Keep the same install/rollback transaction as the SSH
  # deploy, but execute it directly so the release has no second machine or CI hop.
  remote() { bash -c "$*"; }
  copy_to_host() { cp -p "$1" "$2"; }
else
  remote() { ssh "${SSH_OPTS[@]}" "${OCI_USER}@${OCI_HOST}" "$@"; }
  copy_to_host() { scp "${SSH_OPTS[@]}" -q "$1" "${OCI_USER}@${OCI_HOST}:$2"; }
fi

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────────────────────────
say "Preflight"
remote true || die "cannot ssh to ${OCI_USER}@${OCI_HOST}"
remote "sudo -n systemctl is-enabled ${SERVICE} >/dev/null 2>&1" \
  || die "${SERVICE}.service is not installed on the host. Install infra/oci/chessd.service first."
# A deploy that lands on a box with no env file starts a server with no database and no session
# secret — it would boot, pass /health, and quietly serve a broken app.
remote "sudo -n test -s /etc/chessalive.env" \
  || die "/etc/chessalive.env missing or empty — run 'sudo chessalive-pull-secrets.sh' on the host."
echo "host reachable, service installed, env file present"

# ── Build ────────────────────────────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD}" == "yes" ]]; then
  say "Build skipped (SKIP_BUILD=yes) — using existing artifacts"
  [[ -f "${BINARY_SRC}" ]] || die "SKIP_BUILD=yes but ${BINARY_SRC} does not exist"
  [[ -f "${MIGRATE_SRC}" ]] || die "SKIP_BUILD=yes but ${MIGRATE_SRC} does not exist (npm run build:migrate:linux)"
else
  say "Building chessd (linux/arm64, static)"
  ( cd "${SOURCE_ROOT}" && npm run --silent build:server:linux && npm run --silent build:migrate:linux )
  if [[ "${SKIP_WEB}" != "yes" ]]; then
    say "Building web bundle"
    # Audio is served from object storage, not the bundle — see resolvePublicAssetUrl.
    export EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN="${EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN:-https://objectstorage.ap-mumbai-1.oraclecloud.com/n/bmt2adcjgo0u/b/chessalive-audio/o}"
    ( cd "${SOURCE_ROOT}" && npm run --silent build:web )
  fi
fi

[[ -f "${BINARY_SRC}" ]] || die "binary not found at ${BINARY_SRC}"
[[ -f "${UNIT_SRC}" ]] || die "systemd unit not found at ${UNIT_SRC}"
case "${TARGET_ARCH}" in
  arm64) EXPECTED_FILE_ARCH='ARM aarch64' ;;
  amd64) EXPECTED_FILE_ARCH='x86-64' ;;
  *) die "unsupported TARGET_ARCH=${TARGET_ARCH}; use arm64 or amd64" ;;
esac
file "${BINARY_SRC}" | grep -q "${EXPECTED_FILE_ARCH}" \
  || die "${BINARY_SRC} is not a ${TARGET_ARCH} ELF binary — wrong GOOS/GOARCH would fail on the host"
file "${MIGRATE_SRC}" | grep -q "${EXPECTED_FILE_ARCH}" \
  || die "${MIGRATE_SRC} is not a ${TARGET_ARCH} ELF binary"

# ── Upload ───────────────────────────────────────────────────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="/tmp/chessd-deploy-${STAMP}"
say "Staging deployment at ${STAGE}"
remote "mkdir -p ${STAGE}"
copy_to_host "${BINARY_SRC}" "${STAGE}/chessd"
copy_to_host "${UNIT_SRC}" "${STAGE}/chessd.service"
copy_to_host "${MIGRATE_SRC}" "${STAGE}/chessd-migrate"

# The puzzle catalog ships WITH the server, not the web bundle: chessd reads it at runtime
# (packages/data/puzzles.json + daily-puzzles.json). Without it the daily endpoint 404s and
# /puzzles/meta silently falls back to a compiled-in stub — which is exactly what happened on the
# 2026-08-24 cutover, where the box had no packages/ directory at all.
DATA_SRC="${SOURCE_ROOT}/packages/data"
[[ -d "${DATA_SRC}" ]] || die "puzzle catalog not found at ${DATA_SRC}"
DATA_TAR="/tmp/chessd-data-${STAMP}.tar.gz"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "${DATA_TAR}" -C "${DATA_SRC}" .
echo "puzzle catalog: $(du -h "${DATA_TAR}" | cut -f1)"
copy_to_host "${DATA_TAR}" "${STAGE}/data.tar.gz"
rm -f "${DATA_TAR}"

WEB_TAR=""
if [[ "${SKIP_WEB}" != "yes" ]]; then
  if [[ -n "${PREBUILT_WEB_ARCHIVE:-}" ]]; then
    [[ "${SKIP_BUILD:-}" == yes && -f "${PREBUILT_WEB_ARCHIVE}" ]] || die 'prebuilt web archive requires SKIP_BUILD=yes and a verified archive'
    copy_to_host "${PREBUILT_WEB_ARCHIVE}" "${STAGE}/web.tar.gz"
  else
    [[ -d "${WEB_SRC}" ]] || die "web bundle not found at ${WEB_SRC}"
    WEB_TAR="/tmp/chessd-web-${STAMP}.tar.gz"
    # COPYFILE_DISABLE stops macOS from injecting ._AppleDouble files into the archive.
    COPYFILE_DISABLE=1 tar --no-xattrs -czf "${WEB_TAR}" -C "${WEB_SRC}" .
    echo "web bundle: $(du -h "${WEB_TAR}" | cut -f1)"
    copy_to_host "${WEB_TAR}" "${STAGE}/web.tar.gz"
    rm -f "${WEB_TAR}"
  fi
fi

# ── Install + health gate ────────────────────────────────────────────────────────────────────────
say "Installing and restarting ${SERVICE}"
remote "STAGE='${STAGE}' REMOTE_ROOT='${REMOTE_ROOT}' SERVICE='${SERVICE}' \
        HEALTH_URL='${HEALTH_URL}' HEALTH_RETRIES='${HEALTH_RETRIES}' \
        HEALTH_INTERVAL='${HEALTH_INTERVAL}' SKIP_WEB='${SKIP_WEB}' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

BIN_DIR="${REMOTE_ROOT}/bin"
UNIT_PATH="/etc/systemd/system/${SERVICE}.service"
UNIT_BACKUP="${STAGE}/${SERVICE}.service.prev"
sudo install -d -o root -g root -m 0755 "${BIN_DIR}"

# Keep the running binary so a failed health gate can roll straight back to it.
if sudo test -f "${BIN_DIR}/chessd"; then
  sudo cp -a "${BIN_DIR}/chessd" "${BIN_DIR}/chessd.prev"
fi
sudo install -o root -g root -m 0755 "${STAGE}/chessd" "${BIN_DIR}/chessd.new"
# Not part of the health gate: it is only ever run by a content publish, never by the service.
sudo install -o root -g root -m 0755 "${STAGE}/chessd-migrate" "${BIN_DIR}/chessd-migrate"

# The unit is runtime code too: memory ceilings, privileges, and the executable path must deploy
# with the binary instead of drifting as one-time host setup. Keep the active unit so a failed
# restart or health gate restores the complete previous runtime, not only the executable.
sudo cp -a "${UNIT_PATH}" "${UNIT_BACKUP}"
sudo install -o root -g root -m 0644 "${STAGE}/chessd.service" "${UNIT_PATH}"

if [[ "${SKIP_WEB}" != "yes" ]]; then
  # Stage into a sibling then rename: the swap is atomic, so no request ever sees a partial bundle.
  sudo rm -rf "${REMOTE_ROOT}/web.new"
  sudo install -d -o chessalive -g chessalive -m 0755 "${REMOTE_ROOT}/web.new"
  sudo tar -xzf "${STAGE}/web.tar.gz" -C "${REMOTE_ROOT}/web.new"
  sudo chown -R chessalive:chessalive "${REMOTE_ROOT}/web.new"
fi

# chessd's WorkingDirectory is REMOTE_ROOT and puzzlesDataDir() searches upward for
# packages/data/puzzles.json, so this is the first place it looks. Swap by rename so a restart
# never reads a half-extracted catalog.
sudo rm -rf "${REMOTE_ROOT}/packages/data.new"
sudo install -d -o chessalive -g chessalive -m 0755 "${REMOTE_ROOT}/packages/data.new"
sudo tar -xzf "${STAGE}/data.tar.gz" -C "${REMOTE_ROOT}/packages/data.new"
sudo chown -R chessalive:chessalive "${REMOTE_ROOT}/packages/data.new"
sudo rm -rf "${REMOTE_ROOT}/packages/data.old"
sudo test -d "${REMOTE_ROOT}/packages/data" && sudo mv "${REMOTE_ROOT}/packages/data" "${REMOTE_ROOT}/packages/data.old"
sudo mv "${REMOTE_ROOT}/packages/data.new" "${REMOTE_ROOT}/packages/data"

sudo mv "${BIN_DIR}/chessd.new" "${BIN_DIR}/chessd"
if [[ "${SKIP_WEB}" != "yes" ]]; then
  sudo rm -rf "${REMOTE_ROOT}/web.old"
  sudo test -d "${REMOTE_ROOT}/web" && sudo mv "${REMOTE_ROOT}/web" "${REMOTE_ROOT}/web.old"
  sudo mv "${REMOTE_ROOT}/web.new" "${REMOTE_ROOT}/web"
fi

restart_failed=""
if ! sudo systemctl daemon-reload || ! sudo systemctl restart "${SERVICE}"; then
  restart_failed=yes
fi

# ── Health gate ──────────────────────────────────────────────────────────────────────────────────
ok=""
if [[ -z "${restart_failed}" ]]; then
  for i in $(seq 1 "${HEALTH_RETRIES}"); do
    if curl -fsS --max-time 3 "${HEALTH_URL}" 2>/dev/null | grep -q '"ok":true'; then
      ok=yes; echo "health ok after ${i}s"; break
    fi
    sleep "${HEALTH_INTERVAL}"
  done
fi

if [[ -z "${ok}" ]]; then
  echo "✖ health gate FAILED — rolling back" >&2
  sudo systemctl status "${SERVICE}" --no-pager -l | tail -30 >&2 || true
  sudo journalctl -u "${SERVICE}" -n 50 --no-pager >&2 || true
  if sudo test -f "${BIN_DIR}/chessd.prev"; then
    sudo mv "${BIN_DIR}/chessd.prev" "${BIN_DIR}/chessd"
    if [[ "${SKIP_WEB}" != "yes" ]] && sudo test -d "${REMOTE_ROOT}/web.old"; then
      sudo rm -rf "${REMOTE_ROOT}/web"
      sudo mv "${REMOTE_ROOT}/web.old" "${REMOTE_ROOT}/web"
    fi
    sudo install -o root -g root -m 0644 "${UNIT_BACKUP}" "${UNIT_PATH}"
    sudo systemctl daemon-reload
    sudo systemctl restart "${SERVICE}"
    echo "rolled back to the previous binary and service unit" >&2
  else
    echo "no previous binary to roll back to — service is DOWN" >&2
  fi
  rm -rf "${STAGE}"
  exit 1
fi

sudo rm -f "${BIN_DIR}/chessd.prev"
sudo rm -rf "${REMOTE_ROOT}/web.old"
rm -rf "${STAGE}"
REMOTE_SCRIPT

say "Deployed"
# Ask the RUNNING service, not the binary: `chessd --version` starts a fresh process with no
# EnvironmentFile, so it fails config validation and prints a scary (meaningless) error.
remote "systemctl is-active ${SERVICE}"
curl -fsS --max-time 10 "${PUBLIC_URL:-https://chessalive.com}/version" 2>/dev/null || true
echo
echo "${PUBLIC_URL:-https://chessalive.com}"
