#!/usr/bin/env bash
# Install/run the host-side controller. systemd owns the transaction even if SSH disconnects.
set -euo pipefail
MODE="${MODE:-deploy}"
TOOLS=/opt/chessalive-release-tools
case "${MODE}" in deploy|rollback|status|recover) ;; *) exit 64 ;; esac
if [[ "${MODE}" == deploy ]]; then
  [[ "${STAGE:-}" =~ ^/tmp/chessd-deploy-[a-zA-Z0-9._-]+$ ]] || exit 64
  install -d -m 0755 "${TOOLS}"
  for name in runtime_transaction.py release_store.py handoff.py; do
    install -m 0644 "${STAGE}/${name}" "${TOOLS}/${name}"
  done
fi
if [[ ! -f "${TOOLS}/runtime_transaction.py" ]]; then
  if [[ "${MODE}" == status ]]; then
    printf '%s\n' '{"available":false,"reason":"no_complete_fallback","current":null,"previous":null}'
    exit 0
  fi
  echo 'Release controller is not installed' >&2
  exit 1
fi
if [[ "${MODE}" == status ]]; then
  exec python3 "${TOOLS}/runtime_transaction.py" status
fi
args=("${MODE}")
[[ "${MODE}" != deploy ]] || args+=(--stage "${STAGE}")
exec systemd-run --quiet --wait --pipe --collect --unit=chessalive-release-operation \
  --property=TimeoutStartSec=infinity \
  --setenv="CHESSALIVE_PROGRESS=${CHESSALIVE_PROGRESS:-}" \
  python3 "${TOOLS}/runtime_transaction.py" "${args[@]}"
