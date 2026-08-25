#!/usr/bin/env bash
#
# ChessAlive CI — one-command local Jenkins setup.
#
#   ./install.sh [path-to-ChessAlive-checkout]
#
# Stands up a local Jenkins with the ChessAlive dev and release pipelines wired in. Everything
# runs on your own machine and listens on 127.0.0.1 only — nothing is exposed to your network,
# and no production resource is touched until you deliberately run the release job.
#
# Idempotent: safe to re-run. Re-running refreshes the job definitions.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JENKINS_URL="http://127.0.0.1:8080"

bold() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. Locate the ChessAlive checkout ────────────────────────────────────────────────────────────
bold "Locating your ChessAlive checkout"
CHESSALIVE_DIR="${1:-${CHESSALIVE_DIR:-}}"
if [[ -z "${CHESSALIVE_DIR}" ]]; then
  for guess in "${HOME}/Documents/ChessAlive" "${HOME}/ChessAlive" "${HOME}/src/ChessAlive" "$(dirname "${REPO_DIR}")/ChessAlive"; do
    if [[ -f "${guess}/Jenkinsfile.dev" ]]; then CHESSALIVE_DIR="${guess}"; break; fi
  done
fi
[[ -n "${CHESSALIVE_DIR}" ]] || die "Could not find your ChessAlive checkout.
  Pass it explicitly:  ./install.sh /path/to/ChessAlive"
CHESSALIVE_DIR="$(cd "${CHESSALIVE_DIR}" && pwd)"
[[ -f "${CHESSALIVE_DIR}/Jenkinsfile.dev" ]] \
  || die "${CHESSALIVE_DIR} has no Jenkinsfile.dev — is that really the ChessAlive repo, and is it up to date?"
ok "${CHESSALIVE_DIR}"

# ── 2. Prerequisites ─────────────────────────────────────────────────────────────────────────────
bold "Checking prerequisites"
[[ "$(uname -s)" == "Darwin" ]] || die "This installer targets macOS. On Linux, install Jenkins via your package manager, then run: ${REPO_DIR}/lib/install-jobs.sh ${CHESSALIVE_DIR}"
command -v brew >/dev/null 2>&1 || die "Homebrew is required: https://brew.sh"
ok "macOS + Homebrew"

for tool in node go git; do
  if command -v "${tool}" >/dev/null 2>&1; then
    ok "${tool} $("${tool}" version 2>/dev/null | head -1 || "${tool}" --version | head -1)"
  else
    warn "${tool} not found — the pipelines need it. Install with: brew install ${tool}"
  fi
done

# ── 3. Jenkins ───────────────────────────────────────────────────────────────────────────────────
bold "Installing Jenkins"
if brew list jenkins-lts >/dev/null 2>&1; then
  ok "jenkins-lts already installed"
else
  brew install jenkins-lts
  ok "jenkins-lts installed"
fi

# The Homebrew formula already binds 127.0.0.1:8080. Verified rather than assumed, because a
# Jenkins reachable from the network is a remote-code-execution surface.
if grep -q 'httpListenAddress=127.0.0.1' "$(brew --prefix)/opt/jenkins-lts/homebrew.mxcl.jenkins-lts.plist" 2>/dev/null; then
  ok "bound to 127.0.0.1 only (not reachable from your network)"
else
  warn "could not confirm the listen address is localhost-only — check before exposing anything"
fi

# ── 3a. Non-interactive bootstrap ────────────────────────────────────────────────────────────────
# Written BEFORE the first start so Jenkins never presents the setup wizard: the scripts create the
# admin account, mark setup complete, and apply the GitSCM local-checkout fix. Doing this by hand is
# the step that made "install Jenkins" a 20-minute job instead of one command.
JENKINS_HOME="${JENKINS_HOME:-${HOME}/.jenkins}"
ADMIN_PASSWORD="${CHESSALIVE_JENKINS_PASSWORD:-admin}"
mkdir -p "${JENKINS_HOME}/init.groovy.d"
for src in "${REPO_DIR}"/lib/init.groovy.d/*.groovy; do
  dest="${JENKINS_HOME}/init.groovy.d/$(basename "${src}")"
  # The password is substituted at install time, never committed. Default "admin" suits a
  # localhost-only dev controller; override with CHESSALIVE_JENKINS_PASSWORD.
  sed "s|__CHESSALIVE_ADMIN_PASSWORD__|${ADMIN_PASSWORD}|g" "${src}" > "${dest}"
  chmod 600 "${dest}"
done
ok "bootstrap scripts installed (admin user, no setup wizard)"

bold "Starting Jenkins"
brew services start jenkins-lts >/dev/null 2>&1 || brew services restart jenkins-lts >/dev/null
printf '  waiting for Jenkins to boot'
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${JENKINS_URL}/login" 2>/dev/null; then break; fi
  printf '.'; sleep 2
done
echo
curl -sf -o /dev/null "${JENKINS_URL}/login" || die "Jenkins did not come up. Check: brew services info jenkins-lts"
ok "Jenkins is up at ${JENKINS_URL}"

# ── 4. First-run guidance ────────────────────────────────────────────────────────────────────────
JENKINS_HOME="${JENKINS_HOME:-${HOME}/.jenkins}"
SECRET_FILE="${JENKINS_HOME}/secrets/initialAdminPassword"
WIZARD_DONE=""
[[ -d "${JENKINS_HOME}/plugins/workflow-job" ]] && WIZARD_DONE=yes

if [[ -z "${WIZARD_DONE}" ]]; then
  bold "Installing plugins"
  # The bootstrap skipped the wizard, so nothing has installed the Pipeline/Git plugins yet.
  # jenkins-plugin-cli resolves dependencies and writes straight into the plugin directory, which
  # avoids needing an authenticated session before the controller is usable.
  CLI_JAR="$(brew --prefix)/opt/jenkins-lts/libexec/jenkins.war"
  if command -v jenkins-plugin-cli >/dev/null 2>&1; then
    jenkins-plugin-cli --war "${CLI_JAR}" \
      --plugin-download-directory "${JENKINS_HOME}/plugins" \
      --plugin-file "${REPO_DIR}/lib/plugins.txt" || die "plugin install failed"
  else
    # Fallback: fetch each plugin and let Jenkins resolve dependencies on restart.
    UC="https://updates.jenkins.io/latest"
    mkdir -p "${JENKINS_HOME}/plugins"
    while read -r plugin; do
      case "${plugin}" in ''|\#*) continue ;; esac
      curl -fsSL -o "${JENKINS_HOME}/plugins/${plugin}.jpi" "${UC}/${plugin}.hpi" \
        || die "could not download plugin: ${plugin}"
      printf '  %s\n' "${plugin}"
    done < "${REPO_DIR}/lib/plugins.txt"
  fi
  ok "plugins installed"

  bold "Restarting Jenkins to load them"
  brew services restart jenkins-lts >/dev/null
  printf '  waiting'
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "${JENKINS_URL}/login" 2>/dev/null; then break; fi
    printf '.'; sleep 2
  done
  echo
  curl -sf -o /dev/null "${JENKINS_URL}/login" || die "Jenkins did not come back up after the plugin install."
  ok "Jenkins is up with the pipeline plugins"
fi

# ── 5. Jobs ──────────────────────────────────────────────────────────────────────────────────────
bold "Installing pipelines"
"${REPO_DIR}/lib/install-jobs.sh" "${CHESSALIVE_DIR}"

cat <<EOF

$(printf '\033[1mDone.\033[0m') Jenkins: ${JENKINS_URL}

  chessalive-dev      typecheck · lint · tests · Go vet/test/cross-build
                      Polls your local repo every 5 min. Touches no server. Safe on every push.

  chessalive-release  full guard, then deploys chessd to the OCI box.
                      Manual trigger, pauses for your approval, auto-rolls-back on a failed
                      health gate. Needs SSH access to the production host.

The pipelines themselves live in the ChessAlive repo (Jenkinsfile.dev / Jenkinsfile.release),
so they version with the code they build. Edit them there, not here.
EOF
