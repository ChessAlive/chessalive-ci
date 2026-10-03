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
  # Host packages the application needs, installed by every deploy before the candidate starts,
  # so a new or rebuilt host never lacks them (no one-time host setup to forget). Idempotent and
  # never fatal: without Stockfish, chessd keeps Coach V5 off and /coach shows the previous Coach.
  # The slot unit points chessd at it (CHESSALIVE_COACH5_ENGINE=/usr/games/stockfish).
  if [[ ! -x /usr/games/stockfish ]] && command -v apt-get >/dev/null 2>&1; then
    { DEBIAN_FRONTEND=noninteractive apt-get install -y -q stockfish >/dev/null 2>&1 \
      || { apt-get update -q >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -q stockfish >/dev/null 2>&1; }; } \
      || echo "! stockfish could not be installed; Coach V5 stays off until it is" >&2
  fi
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
