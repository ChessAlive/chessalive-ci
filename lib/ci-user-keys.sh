#!/usr/bin/env bash
#
# Give the jenkins user its own SSH identity and the two host keys the pipelines need.
#
#   sudo ./lib/ci-user-keys.sh
#
# The release lane clones from GitHub and deploys to the OCI box over SSH, both as the jenkins
# user. The Mac controller borrowed the developer's own ~/.ssh for that; a shared VM must not —
# so this makes a fresh ed25519 key for jenkins (no passphrase: nothing is there to type it) and
# prints the PUBLIC half for the owner to register as a read-only GitHub deploy key and in
# /home/ubuntu/.ssh/authorized_keys on the OCI host. The private key never leaves the box.
#
# Host keys are pinned here rather than accepted on first use. GitHub's are checked against the
# fingerprints GitHub publishes (https://api.github.com/meta, pinned below and re-fetched live when
# the network allows). The OCI host's is recorded and its fingerprint printed so the owner can
# compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the box; a CHANGED key for a
# host already in known_hosts fails loudly instead of being overwritten.
#
# Idempotent: existing keys and matching known_hosts entries are left alone.
#
set -euo pipefail

CI_USER="${CI_USER:-jenkins}"
OCI_HOST="${OCI_HOST:-144.24.117.171}"
KEY_COMMENT="${KEY_COMMENT:-jenkins@chessalive-ci-gcp}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# Published by GitHub at https://api.github.com/meta → ssh_key_fingerprints (2026-09).
GITHUB_FP_ED25519="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
GITHUB_FP_ECDSA="SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM"
GITHUB_FP_RSA="SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s"

id -u "${CI_USER}" >/dev/null 2>&1 || die "user '${CI_USER}' does not exist — install Jenkins first"
CI_HOME="$(getent passwd "${CI_USER}" | cut -d: -f6)"
[[ -d "${CI_HOME}" ]] || die "home directory of ${CI_USER} (${CI_HOME}) does not exist"

if [[ "$(id -un)" == "${CI_USER}" ]]; then
  as_ci() { bash -c "$1"; }
elif [[ "$(id -u)" -eq 0 ]]; then
  as_ci() { sudo -u "${CI_USER}" -H bash -c "$1"; }
else
  die "run as root (sudo) or as ${CI_USER}"
fi

SSH_DIR="${CI_HOME}/.ssh"
KEY="${SSH_DIR}/id_ed25519"
KNOWN="${SSH_DIR}/known_hosts"
as_ci "mkdir -p '${SSH_DIR}' && chmod 700 '${SSH_DIR}' && touch '${KNOWN}' && chmod 600 '${KNOWN}'"
# The scratch files below are made by root in a 0700 mktemp dir; the jenkins user cannot read them
# there, so they are handed over on stdin (sudo passes it through) rather than by path.
append_known() { as_ci "cat >> '${KNOWN}'" < "$1"; }

# ── key ──────────────────────────────────────────────────────────────────────────────────────────
if as_ci "test -s '${KEY}' && test -s '${KEY}.pub'"; then
  ok "key exists: ${KEY}"
else
  as_ci "ssh-keygen -q -t ed25519 -N '' -C '${KEY_COMMENT}' -f '${KEY}'"
  ok "generated ${KEY} (ed25519, no passphrase)"
fi

# ── github.com ───────────────────────────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
ssh-keyscan -T 15 -t ed25519,ecdsa,rsa github.com > "${TMP}/github" 2>/dev/null \
  || die "ssh-keyscan github.com failed — no network, or port 22 to GitHub is blocked"
[[ -s "${TMP}/github" ]] || die "ssh-keyscan returned no keys for github.com"

# Cross-check the pinned fingerprints against what GitHub publishes right now, when reachable. A
# rotation would show up here as a mismatch, which is the moment to update the pins — not to
# silently trust whatever the scan returned.
if live="$(curl -fsS --max-time 15 https://api.github.com/meta 2>/dev/null)"; then
  for pair in "SHA256_ED25519=${GITHUB_FP_ED25519}" "SHA256_ECDSA=${GITHUB_FP_ECDSA}" "SHA256_RSA=${GITHUB_FP_RSA}"; do
    name="${pair%%=*}"; pinned="${pair#*=}"
    published="SHA256:$(printf '%s' "${live}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ssh_key_fingerprints"][sys.argv[1]])' "${name}")"
    [[ "${published}" == "${pinned}" ]] \
      || die "GitHub's published ${name} fingerprint (${published}) differs from the pin in this script (${pinned}). Update the pin only after checking https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints"
  done
  ok "pinned GitHub fingerprints match api.github.com/meta"
else
  warn "api.github.com unreachable — trusting the pinned fingerprints"
fi

while read -r host type key; do
  fp="$(printf '%s %s %s\n' "${host}" "${type}" "${key}" | ssh-keygen -lf - | awk '{print $2}')"
  case "${type}" in
    ssh-ed25519)         want="${GITHUB_FP_ED25519}" ;;
    ecdsa-sha2-nistp256) want="${GITHUB_FP_ECDSA}" ;;
    ssh-rsa)             want="${GITHUB_FP_RSA}" ;;
    *) continue ;;
  esac
  [[ "${fp}" == "${want}" ]] || die "github.com ${type} host key from ssh-keyscan (${fp}) does not match GitHub's published fingerprint (${want}) — possible interception, refusing to record it"
done < "${TMP}/github"

as_ci "ssh-keygen -q -R github.com -f '${KNOWN}' >/dev/null 2>&1 || true"
append_known "${TMP}/github"
ok "github.com host keys recorded (ed25519/ecdsa/rsa, verified against GitHub's published fingerprints)"

# ── OCI host ─────────────────────────────────────────────────────────────────────────────────────
ssh-keyscan -T 15 -t ed25519 "${OCI_HOST}" > "${TMP}/oci" 2>/dev/null \
  || die "ssh-keyscan ${OCI_HOST} failed — is the OCI box reachable from here?"
[[ -s "${TMP}/oci" ]] || die "ssh-keyscan returned no ed25519 key for ${OCI_HOST}"
NEW_FP="$(ssh-keygen -lf "${TMP}/oci" | awk '{print $2}')"
if existing="$(as_ci "ssh-keygen -F '${OCI_HOST}' -f '${KNOWN}'" | grep -v '^#' | grep ssh-ed25519 || true)" && [[ -n "${existing}" ]]; then
  OLD_FP="$(printf '%s\n' "${existing}" | ssh-keygen -lf - | awk '{print $2}')"
  [[ "${OLD_FP}" == "${NEW_FP}" ]] \
    || die "${OCI_HOST} presents ed25519 ${NEW_FP} but known_hosts holds ${OLD_FP}. A rebuilt host or an interception — verify on the box (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), then remove the stale line with: sudo -u ${CI_USER} ssh-keygen -R ${OCI_HOST}"
  ok "${OCI_HOST} host key unchanged (${NEW_FP})"
else
  append_known "${TMP}/oci"
  ok "${OCI_HOST} ed25519 host key recorded: ${NEW_FP}"
  warn "compare with: ssh ubuntu@${OCI_HOST} 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'"
fi

# ── public key ───────────────────────────────────────────────────────────────────────────────────
echo
echo "Public key for ${CI_USER} (register as a READ-ONLY deploy key on ChessAlive/ChessAlive and in"
echo "/home/ubuntu/.ssh/authorized_keys on ${OCI_HOST}):"
echo
as_ci "cat '${KEY}.pub'"
echo
