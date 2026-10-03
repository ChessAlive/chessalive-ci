#!/usr/bin/env bash
#
# Deploy an isolated chessd release behind the persistent connection gateway.
#
# This is the ONLY supported chessd deploy path. Before it existed the OCI box was provisioned by
# hand, which is how the box and the repo drifted apart; anything you change on the server that
# should survive the next deploy belongs in this file (or in the systemd unit beside it).
#
# The gateway retains browser connections while the sole writer hands its state to a fresh
# application. One complete prior release remains available; immutable browser assets are
# deduplicated separately so long-lived tabs retain their exact files.
#
# Usage:
#   infra/oci/deploy-chessd.sh                 # build, upload, restart, health-gate
#   SKIP_BUILD=yes infra/oci/deploy-chessd.sh  # reuse artifacts already on disk (CI: build once)
#   SKIP_WEB=yes   infra/oci/deploy-chessd.sh  # server-only deploy (no client change)
#
set -euo pipefail

CI_ROOT="${CI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SOURCE_ROOT="${SOURCE_ROOT:-/opt/chessalive}"
source "${CI_ROOT}/release/progress.sh"
DEPLOY_PROGRESS_LOG=""
deploy_progress_exit() {
  local status="$1"
  if [[ -n "${DEPLOY_PROGRESS_LOG}" ]]; then
    progress_adopt_log "${DEPLOY_PROGRESS_LOG}"
    rm -f "${DEPLOY_PROGRESS_LOG}"
  fi
  progress_on_exit "${status}"
}
trap 'deploy_progress_exit "$?"' EXIT
progress_mark deploy running

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
GATEWAY_SRC="${SOURCE_ROOT}/apps/go-server/chessgate-linux-${TARGET_ARCH}"
# chessd-migrate rides with every release so content publishes (publish-content.sh, the content
# lane on the CI box) write the catalog with the SAME persistence code the running server has.
MIGRATE_SRC="${SOURCE_ROOT}/apps/go-server/chessd-migrate-linux-${TARGET_ARCH}"
WEB_SRC="${SOURCE_ROOT}/apps/player-app/dist"
UNIT_SRC="${CI_ROOT}/production/chessd@.service"

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
remote "sudo -n test -f /etc/systemd/system/chessd.service" \
  || die "The production service has not been provisioned on this host."
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
  [[ -f "${GATEWAY_SRC}" ]] || die "SKIP_BUILD=yes but the persistent gateway artifact is missing"
else
  say "Building chessd (linux/arm64, static)"
  ( cd "${SOURCE_ROOT}" && progress_run server npm run --silent build:server:linux && progress_run migrate npm run --silent build:migrate:linux )
  ( cd "${SOURCE_ROOT}" && BUILD_ARCH="${TARGET_ARCH}" npm run --silent build:gateway:local )
  if [[ "${SKIP_WEB}" != "yes" ]]; then
    say "Building web bundle"
    # Audio is served from object storage, not the bundle — see resolvePublicAssetUrl.
    export EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN="${EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN:-https://objectstorage.ap-mumbai-1.oraclecloud.com/n/bmt2adcjgo0u/b/chessalive-audio/o}"
    ( cd "${SOURCE_ROOT}" && progress_run web npm run --silent build:web )
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
file "${GATEWAY_SRC}" | grep -q "${EXPECTED_FILE_ARCH}" \
  || die "${GATEWAY_SRC} is not a ${TARGET_ARCH} ELF binary"

# ── Upload ───────────────────────────────────────────────────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(remote 'mktemp -d /tmp/chessd-deploy-XXXXXXXX')"
[[ "${STAGE}" =~ ^/tmp/chessd-deploy-[a-zA-Z0-9._-]+$ ]] || die 'Invalid staging directory returned by host'
say "Staging deployment at ${STAGE}"
copy_to_host "${BINARY_SRC}" "${STAGE}/chessd"
copy_to_host "${GATEWAY_SRC}" "${STAGE}/chessgate"
copy_to_host "${UNIT_SRC}" "${STAGE}/chessd.service"
copy_to_host "${MIGRATE_SRC}" "${STAGE}/chessd-migrate"
for name in runtime_transaction.py release_store.py handoff.py; do
  copy_to_host "${CI_ROOT}/release/${name}" "${STAGE}/${name}"
done
for name in chessgate.service chessalive-runtime.conf; do
  copy_to_host "${CI_ROOT}/production/${name}" "${STAGE}/${name}"
done

# Tie the installed release to its source, independent of later checkout updates or rollback.
RELEASE_METADATA="$(mktemp "${TMPDIR:-/tmp}/chessalive-release-metadata.XXXXXX")"
python3 - "${SOURCE_ROOT}" > "${RELEASE_METADATA}" <<'PY_METADATA'
import json, os, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
def source_value(env, name, git_args):
    path = pathlib.Path(os.environ.get(env, str(root / name)))
    try: return path.read_text().strip() or None
    except OSError:
        try: return subprocess.check_output(['git', '-C', str(root), *git_args], stderr=subprocess.DEVNULL, text=True).strip() or None
        except (OSError, subprocess.CalledProcessError): return None
print(json.dumps(dict(commitHash=source_value('SOURCE_COMMIT_FILE', '.source-commit', ['rev-parse', 'HEAD']),
                     commitMessage=source_value('SOURCE_COMMIT_MESSAGE_FILE', '.source-commit-message', ['log', '-1', '--format=%s']),
                     commitDate=source_value('SOURCE_COMMIT_DATE_FILE', '.source-commit-date', ['log', '-1', '--format=%aI']))))
PY_METADATA
copy_to_host "${RELEASE_METADATA}" "${STAGE}/release.json"
rm -f "${RELEASE_METADATA}"

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
    # Stream directly to production; Hyderabad need not hold a second multi-GB bundle.
    echo 'Streaming the web bundle to the production staging directory'
    COPYFILE_DISABLE=1 tar --no-xattrs -czf - -C "${WEB_SRC}" . \
      | remote "cat > '${STAGE}/web.tar.gz'"
  fi
fi

# ── Install + health gate ────────────────────────────────────────────────────────────────────────
say "Handing traffic and game state to the verified release"
DEPLOY_PROGRESS_LOG="$(mktemp "${TMPDIR:-/tmp}/chessalive-deploy-progress.XXXXXX")"
# Pass values as shell-quoted arguments rather than interpolating an SSH command.
printf -v remote_command 'sudo -n env MODE=deploy STAGE=%q REMOTE_ROOT=%q SERVICE=%q HEALTH_URL=%q HEALTH_RETRIES=%q HEALTH_INTERVAL=%q SKIP_WEB=%q CHESSALIVE_PROGRESS=%q bash -s' \
  "${STAGE}" "${REMOTE_ROOT}" "${SERVICE}" "${HEALTH_URL}" "${HEALTH_RETRIES}" "${HEALTH_INTERVAL}" "${SKIP_WEB}" "${CHESSALIVE_PROGRESS:-}"
remote "${remote_command}" < "${CI_ROOT}/release/runtime-transaction.sh" | tee "${DEPLOY_PROGRESS_LOG}"

progress_adopt_log "${DEPLOY_PROGRESS_LOG}"
rm -f "${DEPLOY_PROGRESS_LOG}"
DEPLOY_PROGRESS_LOG=""

say "Deployed"
# Ask the RUNNING service, not the binary: `chessd --version` starts a fresh process with no
# EnvironmentFile, so it fails config validation and prints a scary (meaningless) error.
remote "systemctl is-active chessgate"
curl -fsS --max-time 10 "${PUBLIC_URL:-https://chessalive.com}/version" 2>/dev/null || true
echo
echo "${PUBLIC_URL:-https://chessalive.com}"
