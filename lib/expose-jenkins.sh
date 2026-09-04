#!/usr/bin/env bash
#
# Give the CI box's Jenkins a PUBLIC, password-protected HTTPS front door (run as root on the box).
#
#   sudo lib/expose-jenkins.sh            # https://<ip-with-dashes>.sslip.io/, Basic Auth + Jenkins login
#   sudo CI_PUBLIC_HOST=ci.example.com lib/expose-jenkins.sh   # a name of your own (DNS must already resolve)
#
# Owner 2026-09-04: "I want the public url, with password protected page … this is an internal
# deploy tool, any random public url is fine." So the default host is the sslip.io name of the
# instance's static IP — no DNS record to create, and Let's Encrypt issues for it.
#
# Two locks, on purpose. Jenkins can deploy to production, so its login page alone should not be
# what the internet sees: Caddy asks for a Basic Auth password first (user `chessalive`, password in
# root-only ${JENKINS_HOME}/chessalive-ci-proxy-password.txt), then Jenkins asks for its own admin
# login. Jenkins itself keeps listening on 127.0.0.1:8080 only.
#
# ⚠️ Two traps this script encodes:
#   • `header_up -Authorization` — Caddy forwards the Basic Auth header upstream by default, and
#     Jenkins reads it as a (wrong) Jenkins login and answers 401 to the RIGHT proxy password.
#   • `caddy hash-password` (2.6) must be given the password with --plaintext; piping it in adds a
#     newline to the hashed value or dies with "EOF".
#
# Idempotent: re-running keeps the password, rewrites the Caddyfile, reloads Caddy and re-applies
# the Jenkins root URL. The previous Caddyfile is kept as /etc/caddy/Caddyfile.pre-ci-<stamp>.
#
set -euo pipefail

JENKINS_HOME="${JENKINS_HOME:-/var/lib/jenkins}"
PWFILE="${JENKINS_HOME}/chessalive-ci-proxy-password.txt"
URLFILE="${JENKINS_HOME}/chessalive-ci-public-url.txt"
TOKENFILE="${JENKINS_HOME}/chessalive-ci-api-token.txt"
BASIC_USER="${CI_BASIC_USER:-chessalive}"
ACME_EMAIL="${CI_ACME_EMAIL:-contact@chessalive.com}"

die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo)"
command -v caddy >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq caddy; }
command -v caddy >/dev/null 2>&1 || die "caddy is not installed"

# ── Host: the static IP's sslip.io name unless told otherwise ────────────────────────────────────
if [[ -z "${CI_PUBLIC_HOST:-}" ]]; then
  ip="$(curl -fsS -H 'Metadata-Flavor: Google' \
        http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)"
  [[ -n "${ip}" ]] || die "cannot read the external IP from the GCE metadata server — set CI_PUBLIC_HOST"
  CI_PUBLIC_HOST="${ip//./-}.sslip.io"
fi
ok "public host ${CI_PUBLIC_HOST}"

# ── Proxy password: generated once, root-only, never printed ─────────────────────────────────────
if [[ ! -s "${PWFILE}" ]]; then
  openssl rand -base64 18 | tr -d '/+=' > "${PWFILE}"
  ok "generated the proxy password"
fi
chown root:root "${PWFILE}"; chmod 600 "${PWFILE}"
PW="$(cat "${PWFILE}")"
HASH="$(caddy hash-password --algorithm bcrypt --plaintext "${PW}")"

# ── Caddyfile ────────────────────────────────────────────────────────────────────────────────────
if [[ -f /etc/caddy/Caddyfile ]] && ! grep -q 'ChessAlive CI (Jenkins)' /etc/caddy/Caddyfile; then
  cp -n /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.pre-ci-$(date -u +%Y%m%dT%H%M%SZ)"
  ok "previous Caddyfile kept"
fi
cat > /etc/caddy/Caddyfile <<CADDY
{
	email ${ACME_EMAIL}
}

# ChessAlive CI (Jenkins) — public HTTPS front door (chessalive-ci lib/expose-jenkins.sh).
# Two locks: this Basic Auth password (root-only file ${PWFILE}) and Jenkins' own login behind it.
# Jenkins itself still listens on 127.0.0.1:8080 only.
${CI_PUBLIC_HOST} {
	encode zstd gzip
	basicauth {
		${BASIC_USER} ${HASH}
	}
	reverse_proxy 127.0.0.1:8080 {
		# The proxy password must not reach Jenkins, which would read it as a (wrong) Jenkins login.
		header_up -Authorization
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Proto {scheme}
	}
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || die "Caddyfile does not validate"
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy
ok "caddy serving ${CI_PUBLIC_HOST} (ports 80/443 must be open in the GCP firewall: tag chessalive-web)"

# ── Jenkins root URL: persisted for every boot (init.groovy.d/03-location) and applied live ───────
echo "https://${CI_PUBLIC_HOST}/" > "${URLFILE}"; chown jenkins:jenkins "${URLFILE}"
if [[ -s "${TOKENFILE}" && -f "${JENKINS_HOME}/init.groovy.d/03-location.groovy" ]]; then
  if curl -fsS -u "admin:$(cat "${TOKENFILE}")" \
       --data-urlencode "script=$(cat "${JENKINS_HOME}/init.groovy.d/03-location.groovy")" \
       http://127.0.0.1:8080/scriptText | grep -q "jenkins url set"; then
    ok "Jenkins root URL = https://${CI_PUBLIC_HOST}/ (applied live)"
  else
    echo "  ! could not apply the root URL live; it is applied at the next Jenkins restart"
  fi
fi

# ── Prove both locks from the box ────────────────────────────────────────────────────────────────
code_anon=""
for _ in $(seq 1 12); do
  code_anon="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${CI_PUBLIC_HOST}/login" || true)"
  [[ "${code_anon}" == "401" ]] && break
  sleep 5   # first run: Let's Encrypt issuance
done
[[ "${code_anon}" == "401" ]] || die "anonymous request did not get the password prompt (HTTP ${code_anon:-none}) — certificate or firewall?"
code_ok="$(curl -s -o /dev/null -w '%{http_code}' -u "${BASIC_USER}:${PW}" "https://${CI_PUBLIC_HOST}/login")"
[[ "${code_ok}" == "200" ]] || die "the proxy password was not accepted (HTTP ${code_ok})"
code_job="$(curl -s -o /dev/null -w '%{http_code}' -u "${BASIC_USER}:${PW}" "https://${CI_PUBLIC_HOST}/job/")"
[[ "${code_job}" == "403" || "${code_job}" == "404" ]] || die "Jenkins let the proxy password through without its own login (HTTP ${code_job})"
ok "anonymous → 401, proxy password → Jenkins sign-in, Jenkins pages → still need the Jenkins login"

cat <<EOF

  URL       https://${CI_PUBLIC_HOST}/
  1st lock  user ${BASIC_USER}, password:  sudo cat ${PWFILE}
  2nd lock  Jenkins user admin, password:  sudo cat ${JENKINS_HOME}/chessalive-ci-admin-password.txt
EOF
