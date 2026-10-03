#!/usr/bin/env bash
# Restore the complete retained release. --status only reads safe release metadata.
set -euo pipefail
CI_ROOT="${CI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MODE=rollback
case "${1:-}" in
  --status) MODE=status ;;
  '') ;;
  *) echo 'Usage: rollback-chessd.sh [--status]' >&2; exit 64 ;;
esac
[[ "$#" -le 1 ]] || exit 64
OCI_HOST="${DEPLOY_HOST:-${OCI_HOST:-144.24.117.171}}"
OCI_USER="${DEPLOY_USER:-${OCI_USER:-ubuntu}}"
SSH_KEY="${DEPLOY_SSH_KEY:-${SSH_KEY:-}}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/chessalive}"
SERVICE="${SERVICE:-chessd}"
LOCAL_DEPLOY="${LOCAL_DEPLOY:-yes}"
[[ "${DEPLOY_REMOTE:-no}" != yes ]] || LOCAL_DEPLOY=no
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-1}"
[[ "${OCI_USER}" =~ ^[a-zA-Z0-9_.-]+$ && "${OCI_HOST}" =~ ^[a-zA-Z0-9_.:-]+$ ]] || exit 64
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
[[ -z "${SSH_KEY}" ]] || SSH_OPTS+=(-i "${SSH_KEY}")
remote() {
  if [[ "${LOCAL_DEPLOY}" == yes ]]; then bash -c "$1";
  else ssh "${SSH_OPTS[@]}" "${OCI_USER}@${OCI_HOST}" "$1"; fi
}
printf -v remote_command 'sudo -n env MODE=%q REMOTE_ROOT=%q SERVICE=%q HEALTH_URL=%q HEALTH_RETRIES=%q HEALTH_INTERVAL=%q CHESSALIVE_PROGRESS=%q bash -s' \
  "${MODE}" "${REMOTE_ROOT}" "${SERVICE}" "${HEALTH_URL}" "${HEALTH_RETRIES}" "${HEALTH_INTERVAL}" "${CHESSALIVE_PROGRESS:-}"
if [[ "${MODE}" == status ]]; then
  remote "${remote_command}" < "${CI_ROOT}/release/runtime-transaction.sh"
  exit
fi
source "${CI_ROOT}/release/progress.sh"
ROLLBACK_PROGRESS_LOG="$(mktemp "${TMPDIR:-/tmp}/chessalive-rollback-progress.XXXXXX")"
rollback_exit() {
  local status="$?"
  progress_adopt_log "${ROLLBACK_PROGRESS_LOG}"
  rm -f "${ROLLBACK_PROGRESS_LOG}"
  progress_on_exit "${status}"
}
trap rollback_exit EXIT
progress_mark rollback_prepare running
remote "${remote_command}" < "${CI_ROOT}/release/runtime-transaction.sh" | tee "${ROLLBACK_PROGRESS_LOG}"
