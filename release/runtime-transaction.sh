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
  # Node for the Coach V4 (beta) brain, which chessd carries in its own binary and runs as a child
  # process with /opt/chessalive/node/bin/node (else `node` on PATH). Pinned official build; each
  # sha256 is from that release's SHASUMS256.txt. To upgrade, change all three values together;
  # older versions stay on disk until removed by hand. Without Node, V4 (beta) stays quiet.
  # The function never reads the deploy's stdin (this script itself) and reports one problem.
  NODE_VERSION=v22.23.3
  install_node() {
    local machine arch sum name work problem="" link=/opt/chessalive/node
    [[ "$("${link}/bin/node" --version 2>/dev/null)" != "${NODE_VERSION}" ]] || return 0
    machine="$(uname -m)"
    case "${machine}" in
      aarch64) arch=arm64 sum=5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2 ;;
      x86_64) arch=x64 sum=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af ;;
      *) echo "no official build for ${machine}"; return 1 ;;
    esac
    name="node-${NODE_VERSION}-linux-${arch}"
    work="$(mktemp -d /opt/chessalive/.node-install.XXXXXX 2>/dev/null)" || { echo "no staging directory"; return 1; }
    if ! curl -fsSL --retry 2 --connect-timeout 20 --max-time 300 -o "${work}/${name}.tar.gz" \
      "https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz" 2>/dev/null; then
      problem="download failed"
    elif [[ "$(sha256sum "${work}/${name}.tar.gz" 2>/dev/null)" != "${sum} "* ]]; then
      problem="checksum mismatch"
    elif ! tar --no-same-owner -xzf "${work}/${name}.tar.gz" -C "${work}" 2>/dev/null \
      || [[ "$("${work}/${name}/bin/node" --version 2>/dev/null)" != "${NODE_VERSION}" ]]; then
      problem="the downloaded build does not run"
    elif ! { chmod -R a+rX "${work}/${name}" && rm -rf "/opt/chessalive/${name}" \
      && mv "${work}/${name}" "/opt/chessalive/${name}" \
      && { [[ ! -e "${link}" || -L "${link}" ]] || mv "${link}" "${link}.replaced.$$"; } \
      && ln -sfn "/opt/chessalive/${name}" "${link}"; } 2>/dev/null; then
      problem="could not switch ${link}"
    fi
    rm -rf "${work}"
    [[ -z "${problem}" ]] || { echo "${problem}"; return 1; }
  }
  if ! node_problem="$(install_node </dev/null)"; then
    echo "! Node ${NODE_VERSION} could not be installed (${node_problem}); V4 (beta) stays quiet until it is" >&2
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
