#!/usr/bin/env bash
# Promote the verified Pre-Prod release to live Production via zero-disruption chessgate handoff.
set -euo pipefail
CI_ROOT="${CI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[[ "$#" -eq 0 ]] || { echo 'Usage: promote-chessd.sh' >&2; exit 64; }
OCI_HOST="${DEPLOY_HOST:-${OCI_HOST:-161.118.175.12}}"
OCI_USER="${DEPLOY_USER:-${OCI_USER:-ubuntu}}"
SSH_KEY="${DEPLOY_SSH_KEY:-${SSH_KEY:-}}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/chessalive}"
SERVICE="${SERVICE:-chessd}"
LOCAL_DEPLOY="${LOCAL_DEPLOY:-yes}"
[[ "${DEPLOY_REMOTE:-no}" != yes ]] || LOCAL_DEPLOY=no
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8079/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-1}"
[[ "${OCI_USER}" =~ ^[a-zA-Z0-9_.-]+$ && "${OCI_HOST}" =~ ^[a-zA-Z0-9_.:-]+$ ]] || exit 64
CONTROL_PATH="${BUILD_SSH_CONTROL_PATH:-${TMPDIR:-/tmp}/chessalive-ci-ssh-%C}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o "ControlPath=${CONTROL_PATH}" -o ControlPersist=300)
[[ -z "${SSH_KEY}" ]] || SSH_OPTS+=(-i "${SSH_KEY}")
remote() {
  if [[ "${LOCAL_DEPLOY}" == yes ]]; then bash -c "$1";
  else ssh "${SSH_OPTS[@]}" "${OCI_USER}@${OCI_HOST}" "$1"; fi
}
printf -v remote_command 'sudo -n env MODE=promote REMOTE_ROOT=%q SERVICE=%q HEALTH_URL=%q HEALTH_RETRIES=%q HEALTH_INTERVAL=%q CHESSALIVE_PROGRESS=%q bash -s' \
  "${REMOTE_ROOT}" "${SERVICE}" "${HEALTH_URL}" "${HEALTH_RETRIES}" "${HEALTH_INTERVAL}" "${CHESSALIVE_PROGRESS:-}"
source "${CI_ROOT}/release/progress.sh"
PROMOTE_PROGRESS_LOG="$(mktemp "${TMPDIR:-/tmp}/chessalive-promote-progress.XXXXXX")"
promote_exit() {
  local status="$?"
  progress_adopt_log "${PROMOTE_PROGRESS_LOG}"
  rm -f "${PROMOTE_PROGRESS_LOG}"
  progress_on_exit "${status}"
}
trap promote_exit EXIT
progress_mark promote_verify running
remote "${remote_command}" < "${CI_ROOT}/release/runtime-transaction.sh" | tee "${PROMOTE_PROGRESS_LOG}"
