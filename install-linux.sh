#!/usr/bin/env bash
#
# ChessAlive CI — Jenkins controller on a Debian/Ubuntu box (the GCP VM, chessalive-prod-1).
#
#   sudo CHESSALIVE_JENKINS_PASSWORD=generate ./install-linux.sh
#
# The Linux counterpart of install.sh. Same shape — Jenkins LTS bound to 127.0.0.1 only, the
# init.groovy.d bootstrap instead of the setup wizard, the pipeline plugins, the four jobs — but
# on a shared VM rather than a workstation, which changes three things:
#
#   • the admin password is REQUIRED (CHESSALIVE_JENKINS_PASSWORD). "generate" makes a random one
#     and writes it ONLY to ${JENKINS_HOME}/chessalive-ci-admin-password.txt (0600, jenkins).
#     A default of "admin" on a box other people can ssh into is a production-access giveaway;
#   • the SCM remote is GitHub over SSH (lib/ci-user-keys.sh gives the jenkins user a key), so
#     04-allow-local-checkout is deliberately NOT installed;
#   • the toolchain is installed here rather than discovered: Temurin 21, Node 22 (nodesource —
#     prod and cloudbuild run 22), Go from the official tarball, git/rsync/file for the deploy
#     script, build-essential + python3 for node-gyp.
#
# Idempotent: re-running refreshes the drop-in, bootstrap scripts, plugins and jobs, then restarts
# Jenkins. Do not re-run while a build is in flight.
#
# Env knobs (all optional except the password):
#   CHESSALIVE_JENKINS_PASSWORD  admin password, or "generate". Reused from the password file on
#                                re-runs when unset.
#   CHESSALIVE_JENKINS_HEAP      -Xms/-Xmx for the controller. Default 384m: the VM has 969 MB
#                                (plus the swap file below). Use 2g once it is resized (see
#                                infra/gcp/CI-VM.md).
#   CHESSALIVE_CI_SWAP_GB        swap file to create when the box has none. Default 2; 0 disables.
#                                Idle Jenkins + kernel + sshd sit at ~700 MB on this box; without a
#                                spill the first plugin load can OOM-kill the JVM.
#   CHESSALIVE_GO_VERSION        Go toolchain version. Default matches apps/go-server/go.mod.
#   REPO_URL / BRANCH            forwarded to lib/install-jobs.sh (GitHub over SSH, main).
#   DISABLE_JOBS                 yes|no for the dev/release/config lanes. Defaults to yes when
#                                MemTotal < 3 GB: a polling dev job would otherwise start a build
#                                on the first push and OOM the box. The content lane
#                                (Jenkinsfile.content: node + rsync + ssh, no npm ci, no Go) is
#                                always enabled — it is what the e2-micro is kept for.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JENKINS_URL="http://127.0.0.1:8080"
JENKINS_HOME="${JENKINS_HOME:-/var/lib/jenkins}"
CI_USER="jenkins"
HEAP="${CHESSALIVE_JENKINS_HEAP:-384m}"
SWAP_GB="${CHESSALIVE_CI_SWAP_GB:-2}"
NODE_MAJOR=22
GO_VERSION="${CHESSALIVE_GO_VERSION:-1.27.1}"
PASSWORD_FILE="${JENKINS_HOME}/chessalive-ci-admin-password.txt"
DROPIN_DIR="/etc/systemd/system/jenkins.service.d"
DROPIN="${DROPIN_DIR}/chessalive-ci.conf"

# Plugins the pipelines use, beyond lib/plugins.txt: `input` (Approve stages), milestone, the
# credentials pair the git plugin loads at startup, and junit for the Pipeline model's defaults.
EXTRA_PLUGINS=(pipeline-input-step pipeline-milestone-step credentials ssh-credentials junit)

bold() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# ── 0. Preconditions ─────────────────────────────────────────────────────────────────────────────
bold "Preconditions"
[[ "$(id -u)" -eq 0 ]] || die "run as root: sudo CHESSALIVE_JENKINS_PASSWORD=... ${BASH_SOURCE[0]}"
[[ -f /etc/debian_version ]] || die "this installer targets Debian/Ubuntu (no /etc/debian_version here)"
. /etc/os-release
CODENAME="${VERSION_CODENAME:-}"
[[ -n "${CODENAME}" ]] || die "cannot read VERSION_CODENAME from /etc/os-release"
ARCH="$(dpkg --print-architecture)"
case "${ARCH}" in
  amd64) GO_ARCH=amd64 ;;
  arm64) GO_ARCH=arm64 ;;
  *) die "unsupported architecture ${ARCH}" ;;
esac
ok "${PRETTY_NAME} (${CODENAME}, ${ARCH})"

# rsync -a from the Mac keeps the developer's uid on the copied files, and on this box that uid
# belongs to a leftover pre-OS-Login account. Root must not execute scripts a non-root account can
# edit, so an installer that lives under /opt is made root's before anything else runs.
if [[ "${REPO_DIR}" == /opt/* ]] && find "${REPO_DIR}" -not -user root -print -quit | grep -q .; then
  chown -R root:root "${REPO_DIR}"
  ok "installer files now owned by root (${REPO_DIR})"
fi

MEM_MB=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
if [[ "${MEM_MB}" -lt 3000 ]]; then
  warn "${MEM_MB} MB RAM: enough to keep Jenkins idle, NOT enough to run a build (npm ci + vitest +"
  warn "expo export need several GB). Resize first: infra/gcp/ci-vm.sh resize --machine-type e2-medium"
  DISABLE_JOBS="${DISABLE_JOBS:-yes}"
else
  ok "${MEM_MB} MB RAM"
  DISABLE_JOBS="${DISABLE_JOBS:-no}"
fi

# ── 1. Admin password ────────────────────────────────────────────────────────────────────────────
# Resolved early so a missing password fails before anything is installed. Never echoed.
bold "Admin password"
ADMIN_PASSWORD="${CHESSALIVE_JENKINS_PASSWORD:-}"
if [[ -z "${ADMIN_PASSWORD}" && -s "${PASSWORD_FILE}" ]]; then
  ADMIN_PASSWORD="$(cat "${PASSWORD_FILE}")"
  ok "reusing ${PASSWORD_FILE}"
elif [[ "${ADMIN_PASSWORD}" == "generate" ]]; then
  ADMIN_PASSWORD="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)"
  ok "generated (written only to ${PASSWORD_FILE})"
elif [[ -n "${ADMIN_PASSWORD}" ]]; then
  ok "taken from CHESSALIVE_JENKINS_PASSWORD"
else
  die "CHESSALIVE_JENKINS_PASSWORD is required on a shared VM (no default). Use 'generate' for a random one."
fi
# | & \ break the sed substitution; " $ and ` break the Groovy string literal the password lands in
# (a bootstrap script that fails to compile leaves the admin account with the OLD password).
case "${ADMIN_PASSWORD}" in *'|'*|*'&'*|*'\'*|*'"'*|*'$'*|*'`'*) die "password may not contain | & \\ \" \$ or \` (it is substituted into sed and a Groovy string)";; esac

# ── 2. OS packages ───────────────────────────────────────────────────────────────────────────────
# The pkg.jenkins.io apt source, written BEFORE the first apt-get update so a stale key from an
# earlier run can never wedge apt for every step after it. The repo signing key rotates: the 2023
# key expired 2026-03-26 and debian-stable is signed by the 2026 key (apt: NO_PUBKEY
# 7198F4B714ABFC68 with the old one). Pinned by fingerprint so a rotated download is a named
# failure, not a silently different trust root.
JENKINS_KEY_URL="https://pkg.jenkins.io/debian-stable/jenkins.io-2026.key"
JENKINS_KEY_FPR="5E386EADB55F01504CAE8BCF7198F4B714ABFC68"
configure_jenkins_repo() {
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "${JENKINS_KEY_URL}" -o /etc/apt/keyrings/jenkins-keyring.asc.new \
    || die "could not download the Jenkins apt signing key from ${JENKINS_KEY_URL}"
  local got_fpr
  got_fpr="$(gpg --show-keys --with-colons /etc/apt/keyrings/jenkins-keyring.asc.new 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')"
  [[ "${got_fpr}" == "${JENKINS_KEY_FPR}" ]] \
    || die "Jenkins signing key fingerprint is ${got_fpr}, expected ${JENKINS_KEY_FPR} — check https://pkg.jenkins.io/debian-stable/ before updating the pin"
  mv /etc/apt/keyrings/jenkins-keyring.asc.new /etc/apt/keyrings/jenkins-keyring.asc
  echo "deb [signed-by=/etc/apt/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" \
    > /etc/apt/sources.list.d/jenkins.list
}

bold "OS packages"
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg >/dev/null 2>&1 || true   # gpg/curl for the key check below
configure_jenkins_repo
apt-get update -qq || die "apt-get update failed — an apt source on this box is broken or unsigned (see the lines above)"
# git/rsync/file: infra/oci/deploy-chessd.sh and the Jenkinsfiles call them. build-essential +
# python3: node-gyp for native npm deps. fontconfig: Jenkins needs it even headless.
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg apt-transport-https \
  git rsync file openssh-client fontconfig \
  build-essential python3 \
  procps unzip xz-utils >/dev/null
ok "git rsync file build-essential python3"

# Chromium's shared libraries for `playwright install --with-deps chromium` (npm run
# setup:web-browser in the release lane). Playwright installs these itself with sudo when it is
# not root — and the jenkins user has no sudo — so they are put in place here. The browser binary
# itself is still downloaded by the pipeline into the jenkins user's cache.
apt-get install -y -qq --no-install-recommends \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 \
  libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  fonts-liberation >/dev/null
ok "chromium runtime libraries (playwright)"

# ── 3. Java 21 (Temurin) ─────────────────────────────────────────────────────────────────────────
# Debian 12 ships OpenJDK 17 only; Jenkins LTS 2.5xx wants 17 or 21 and 21 is the one that gets
# another five years. Adoptium publishes signed debs for bookworm.
bold "Java"
install -d -m 0755 /etc/apt/keyrings
if ! command -v java >/dev/null 2>&1 || ! java -version 2>&1 | grep -q '"21\.'; then
  curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
    | gpg --dearmor --yes -o /etc/apt/keyrings/adoptium.gpg
  echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb ${CODENAME} main" \
    > /etc/apt/sources.list.d/adoptium.list
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends temurin-21-jre >/dev/null \
    || die "temurin-21-jre did not install — is ${CODENAME} supported by packages.adoptium.net?"
fi
ok "$(java -version 2>&1 | head -1)"

# ── 4. Node 22 ───────────────────────────────────────────────────────────────────────────────────
# Pinned to major 22, the version prod and cloudbuild run; a CI on a different major would green a
# build the deploy target cannot reproduce.
bold "Node ${NODE_MAJOR}"
node_major() { node --version 2>/dev/null | sed -E 's/^v([0-9]+)\..*/\1/'; }
if [[ "$(node_major || true)" != "${NODE_MAJOR}" ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  cat > /etc/apt/sources.list.d/nodesource.sources <<SRC
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x
Suites: nodistro
Components: main
Architectures: ${ARCH}
Signed-By: /etc/apt/keyrings/nodesource.gpg
SRC
  rm -f /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null || die "nodejs ${NODE_MAJOR} did not install from nodesource"
fi
[[ "$(node_major)" == "${NODE_MAJOR}" ]] || die "node is $(node --version), expected major ${NODE_MAJOR}"
ok "node $(node --version) · npm $(npm --version)"

# ── 5. Go ────────────────────────────────────────────────────────────────────────────────────────
# The official tarball, not Debian's package (bookworm ships 1.19). Version pinned to what
# apps/go-server/go.mod declares; the checksum is the one go.dev publishes beside the archive.
bold "Go ${GO_VERSION}"
GO_ROOT=/usr/local/go
if [[ ! -x "${GO_ROOT}/bin/go" ]] || ! "${GO_ROOT}/bin/go" version | grep -q "go${GO_VERSION} "; then
  GO_TAR="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
  TMP="$(mktemp -d)"
  curl -fsSL -o "${TMP}/${GO_TAR}" "https://go.dev/dl/${GO_TAR}" || die "could not download ${GO_TAR}"
  # go.dev publishes the checksums in its release feed (there is no <file>.sha256 next to the
  # archive — that URL answers with the download page's HTML).
  WANT="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' \
    | python3 -c 'import json,sys; f=sys.argv[1]; print(next(x["sha256"] for r in json.load(sys.stdin) for x in r["files"] if x["filename"] == f))' "${GO_TAR}")" \
    || die "could not find the checksum for ${GO_TAR} in https://go.dev/dl/?mode=json — is ${GO_VERSION} a real Go release?"
  [[ "${WANT}" =~ ^[0-9a-f]{64}$ ]] || die "unexpected checksum for ${GO_TAR} from go.dev: ${WANT}"
  GOT="$(sha256sum "${TMP}/${GO_TAR}" | cut -d' ' -f1)"
  [[ "${GOT}" == "${WANT}" ]] || die "checksum mismatch for ${GO_TAR}: got ${GOT}, go.dev says ${WANT}"
  rm -rf "${GO_ROOT}"
  tar -C /usr/local -xzf "${TMP}/${GO_TAR}"
  rm -rf "${TMP}"
fi
cat > /etc/profile.d/chessalive-go.sh <<'PROFILE'
# chessalive-ci: Go toolchain (the Jenkins jobs use the toolchain shim, this is for humans)
case ":${PATH}:" in *":/usr/local/go/bin:"*) ;; *) export PATH="${PATH}:/usr/local/go/bin" ;; esac
PROFILE
ok "$("${GO_ROOT}/bin/go" version)"

# ── 6. Swap ──────────────────────────────────────────────────────────────────────────────────────
# Reversible: swapoff /swapfile && rm /swapfile && sed -i '/chessalive-ci swap/d' /etc/fstab
bold "Swap"
if [[ "${SWAP_GB}" == "0" ]]; then
  ok "skipped (CHESSALIVE_CI_SWAP_GB=0)"
elif [[ "$(awk 'NR>1' /proc/swaps | wc -l)" -gt 0 ]]; then
  ok "already active: $(awk 'NR>1 {print $1" ("int($3/1024)" MB)"}' /proc/swaps | tr '\n' ' ')"
else
  FREE_GB=$(( $(df --output=avail -B1G / | tail -1) ))
  [[ "${FREE_GB}" -gt $(( SWAP_GB + 2 )) ]] || die "only ${FREE_GB} GB free on /: not enough for a ${SWAP_GB} GB swap file plus headroom"
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo "/swapfile none swap sw 0 0  # chessalive-ci swap" >> /etc/fstab
  ok "${SWAP_GB} GB /swapfile enabled"
fi

# ── 7. Jenkins LTS ───────────────────────────────────────────────────────────────────────────────
bold "Jenkins LTS"
if ! dpkg-query -W -f='${Status}' jenkins 2>/dev/null | grep -q 'install ok installed'; then
  # The package enables and starts the service straight away — with the setup wizard and a
  # network-agnostic listen address. It is stopped below and reconfigured before its real first boot.
  apt-get install -y -qq jenkins >/dev/null || die "jenkins did not install from pkg.jenkins.io"
fi
JENKINS_VERSION="$(dpkg-query -W -f='${Version}' jenkins)"
ok "jenkins ${JENKINS_VERSION}"
id -u "${CI_USER}" >/dev/null 2>&1 || die "the jenkins package did not create the '${CI_USER}' user"
[[ -d "${JENKINS_HOME}" ]] || die "JENKINS_HOME ${JENKINS_HOME} does not exist"

systemctl stop jenkins >/dev/null 2>&1 || true

# Loopback only, fixed heap, serial GC (2 shared vCPUs — a parallel collector just fights the
# executor), setup wizard off (the bootstrap scripts do that job).
#
# TimeoutStartSec: the packaged unit gives Jenkins 90 s to report ready. On 2 shared vCPUs with
# 71 plugins the boot takes ~80-100 s, so a restart raced the default and lost: systemd sent
# SIGTERM mid-initialisation ("Failed with result 'timeout'", then NoClassDefFoundError /
# "zip file closed" noise as the plugin classloaders were torn down under the init thread), and
# the unit was left failed even though the next attempt came up. Five minutes is generous on
# purpose; a box that needs more than that is swapping, and that is the thing to fix.
install -d -m 0755 "${DROPIN_DIR}"
cat > "${DROPIN}.new" <<CONF
# chessalive-ci — written by install-linux.sh; re-run it rather than editing by hand.
[Service]
Environment="JENKINS_LISTEN_ADDRESS=127.0.0.1"
Environment="JAVA_OPTS=-Djava.awt.headless=true -Xms${HEAP} -Xmx${HEAP} -XX:+UseSerialGC -Djenkins.install.runSetupWizard=false"
TimeoutStartSec=300
TimeoutStopSec=120
CONF
if ! cmp -s "${DROPIN}.new" "${DROPIN}" 2>/dev/null; then
  mv "${DROPIN}.new" "${DROPIN}"
  ok "drop-in written: listen 127.0.0.1, heap ${HEAP}, TimeoutStartSec 300"
else
  rm -f "${DROPIN}.new"
  ok "drop-in unchanged: listen 127.0.0.1, heap ${HEAP}, TimeoutStartSec 300"
fi
systemctl daemon-reload
[[ "$(systemctl show jenkins -p TimeoutStartUSec --value)" == "5min" ]] \
  || die "systemd did not pick up TimeoutStartSec=300 from ${DROPIN} (systemctl show jenkins -p TimeoutStartUSec)"

# ── 7a. Bootstrap scripts (no setup wizard) ──────────────────────────────────────────────────────
# 04-allow-local-checkout is skipped on purpose: the remote is GitHub, and permitting file://
# checkouts on a shared box is a way to build arbitrary local directories as the jenkins user.
install -d -m 0700 -o "${CI_USER}" -g "${CI_USER}" "${JENKINS_HOME}/init.groovy.d"
for src in "${REPO_DIR}"/lib/init.groovy.d/*.groovy; do
  name="$(basename "${src}")"
  case "${name}" in 04-allow-local-checkout.groovy) continue ;; esac
  dest="${JENKINS_HOME}/init.groovy.d/${name}"
  sed "s|__CHESSALIVE_ADMIN_PASSWORD__|${ADMIN_PASSWORD}|g" "${src}" > "${dest}"
  chmod 600 "${dest}"; chown "${CI_USER}:${CI_USER}" "${dest}"
done
rm -f "${JENKINS_HOME}/init.groovy.d/04-allow-local-checkout.groovy"
ok "bootstrap scripts installed (admin user, api token, root URL)"

umask 077
printf '%s\n' "${ADMIN_PASSWORD}" > "${PASSWORD_FILE}"
chown "${CI_USER}:${CI_USER}" "${PASSWORD_FILE}"; chmod 600 "${PASSWORD_FILE}"
umask 022
ok "password file: ${PASSWORD_FILE} (0600 ${CI_USER})"

# ── 7b. Plugins ──────────────────────────────────────────────────────────────────────────────────
# Jenkins does NOT fetch a dropped plugin's dependencies on its own — an .hpi whose dependency is
# absent fails to load, and the job that needs it disappears with a MissingMethodException-shaped
# error. lib/resolve-plugins.py walks the update center's dependency graph for THIS core version,
# verifies each archive's sha256 against the update center, and skips anything already present.
bold "Plugins"
mapfile -t WANTED < <(grep -Ev '^\s*(#|$)' "${REPO_DIR}/lib/plugins.txt")
WANTED+=("${EXTRA_PLUGINS[@]}")
python3 "${REPO_DIR}/lib/resolve-plugins.py" \
  --jenkins-version "${JENKINS_VERSION}" \
  --plugins-dir "${JENKINS_HOME}/plugins" \
  "${WANTED[@]}" || die "plugin resolution failed (see the plugin named above)"
chown -R "${CI_USER}:${CI_USER}" "${JENKINS_HOME}/plugins"

# ── 7c. Start and verify ─────────────────────────────────────────────────────────────────────────
bold "Starting Jenkins"
systemctl enable jenkins >/dev/null 2>&1
BOOT_MARK="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl start jenkins
printf '  waiting for Jenkins to boot (first boot on 2 shared vCPUs takes a few minutes)'
for _ in $(seq 1 150); do
  if curl -sf -o /dev/null "${JENKINS_URL}/login" 2>/dev/null; then break; fi
  printf '.'; sleep 2
done
echo
curl -sf -o /dev/null "${JENKINS_URL}/login" \
  || die "Jenkins did not come up. Check: journalctl -u jenkins --since '${BOOT_MARK}'"
ok "Jenkins is up at ${JENKINS_URL} (loopback only)"

# Plugin load failures are logged, not fatal to Jenkins — which is exactly why they must be checked
# here rather than discovered when a job vanishes.
if journalctl -u jenkins --since "${BOOT_MARK}" --no-pager 2>/dev/null \
     | grep -Ei 'Failed to load|missing.*(plugin|dependenc)|SEVERE' | grep -v 'SEVERE.*(Jenkins is fully up|hudson.model.UpdateCenter)' | head -5 | grep -q .; then
  journalctl -u jenkins --since "${BOOT_MARK}" --no-pager | grep -Ei 'Failed to load|missing.*(plugin|dependenc)|SEVERE' | head -20 >&2
  die "the Jenkins log shows plugin/initialisation errors (above)"
fi
[[ -f "${JENKINS_HOME}/chessalive-ci-marker.txt" ]] || warn "init.groovy.d marker missing — did the bootstrap scripts run? journalctl -u jenkins | grep chessalive-ci"
[[ -d "${JENKINS_HOME}/plugins/workflow-job" ]] || die "workflow-job did not load; the pipeline jobs cannot be installed"
ok "no plugin or init errors in the log"

# ── 8. Jobs + toolchain shim ─────────────────────────────────────────────────────────────────────
bold "Jobs"
JENKINS_HOME="${JENKINS_HOME}" DISABLE_JOBS="${DISABLE_JOBS}" \
  REPO_URL="${REPO_URL:-git@github.com:ChessAlive/ChessAlive.git}" BRANCH="${BRANCH:-main}" \
  "${REPO_DIR}/lib/install-jobs.sh"

cat <<EOT

$(printf '\033[1mDone.\033[0m') Jenkins ${JENKINS_VERSION} at ${JENKINS_URL} on this box only.

  From your Mac:   infra/gcp/ci-vm.sh tunnel      → http://127.0.0.1:8080  (admin / the password file)
  SSH for the jenkins user (GitHub deploy key + OCI host):  sudo ${REPO_DIR}/lib/ci-user-keys.sh
  chessalive-content is enabled (polls main every 5 min; node + rsync + ssh only).
  dev/release/config $( [[ "${DISABLE_JOBS}" == "yes" ]] && echo "DISABLED (${MEM_MB} MB RAM cannot run a build — they stay on the workstation Jenkins; resize, then re-run with DISABLE_JOBS=no)" || echo "enabled" ).
  Heap is ${HEAP}; after a resize re-run with CHESSALIVE_JENKINS_HEAP=2g.
EOT
