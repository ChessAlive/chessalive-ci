#!/usr/bin/env bash
#
# Create (or refresh) the four ChessAlive Jenkins jobs.
#
#   macOS workstation:   ./lib/install-jobs.sh /path/to/ChessAlive
#   Linux CI box:        sudo REPO_URL=git@github.com:ChessAlive/ChessAlive.git ./lib/install-jobs.sh
#
# Writes job definitions straight into JENKINS_HOME on disk rather than going through the REST
# API, so this needs no API token and never handles your Jenkins password.
#
# Run it after the Pipeline and Git plugins are in place (install.sh / install-linux.sh do that).
#
# Env:
#   JENKINS_HOME   /var/lib/jenkins when that exists (the Debian package), else ~/.jenkins.
#   REPO_URL       SCM remote for all four jobs. Default: file://<checkout> on macOS (the
#                  workstation flow, needs 04-allow-local-checkout); GitHub over SSH otherwise.
#   BRANCH         main.
#   TOOLCHAIN_DIR  where the node/npm/npx/go/git symlinks go. The Jenkinsfiles put
#                  "${env.HOME}/.jenkins/toolchain/bin" on PATH, so this must resolve to that for
#                  the user Jenkins runs as: ~/.jenkins/toolchain/bin on a workstation, and
#                  /var/lib/jenkins/.jenkins/toolchain/bin on Linux where HOME == JENKINS_HOME.
#   DISABLE_JOBS   yes → write dev/release/config disabled. For a box that cannot run a build: the
#                  dev job polls SCM, and a poll with no baseline build schedules one immediately.
#                  Unset on Linux → decided from MemTotal (< 3 GB = yes), so a plain re-run on the
#                  e2-micro can never enable a lane that would OOM it.
#                  The CONTENT job ignores this knob: it is the lane that fits the micro (node +
#                  rsync + ssh, ~200 MB) and the whole reason the box exists. It is written disabled
#                  only for a file:// remote (a workstation), where a poll of the local checkout
#                  would publish content from commits that were never pushed.
#
set -euo pipefail

CHESSALIVE_DIR="${1:-${CHESSALIVE_DIR:-}}"
BRANCH="${BRANCH:-main}"
CI_USER="jenkins"
MIN_BUILD_MB=3000

die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

# ── platform ─────────────────────────────────────────────────────────────────────────────────────
if [[ -z "${JENKINS_HOME:-}" ]]; then
  if [[ "$(uname -s)" == "Linux" && -d /var/lib/jenkins ]]; then
    JENKINS_HOME=/var/lib/jenkins
  else
    JENKINS_HOME="${HOME}/.jenkins"
  fi
fi
[[ -d "${JENKINS_HOME}" ]] || die "JENKINS_HOME not found at ${JENKINS_HOME}"
[[ -d "${JENKINS_HOME}/plugins/workflow-job" ]] \
  || die "Pipeline plugin missing in ${JENKINS_HOME}/plugins — run install.sh / install-linux.sh first."

LINUX_BOX=no
[[ "${JENKINS_HOME}" == "/var/lib/jenkins" ]] && LINUX_BOX=yes

if [[ -z "${TOOLCHAIN_DIR:-}" ]]; then
  if [[ "${LINUX_BOX}" == "yes" ]]; then
    TOOLCHAIN_DIR="${JENKINS_HOME}/.jenkins/toolchain/bin"
  else
    TOOLCHAIN_DIR="${JENKINS_HOME}/toolchain/bin"
  fi
fi

# ── remote ───────────────────────────────────────────────────────────────────────────────────────
# On the workstation your own checkout is the SCM source — that is what makes the dev lane useful
# before anything is pushed (feat/go-server lived only locally until 2026-08-24). On the CI box
# there is no checkout and no 04-allow-local-checkout; the Jenkinsfiles come from GitHub, so a
# pipeline change is one commit in ChessAlive and the jobs pick it up on their next run.
if [[ -z "${REPO_URL:-}" ]]; then
  if [[ "${LINUX_BOX}" == "no" && -n "${CHESSALIVE_DIR}" ]]; then
    REPO_URL="file://$(cd "${CHESSALIVE_DIR}" && pwd)"
  else
    REPO_URL="git@github.com:ChessAlive/ChessAlive.git"
  fi
fi
if [[ "${REPO_URL}" == file://* ]]; then
  CHESSALIVE_DIR="${REPO_URL#file://}"
  [[ -f "${CHESSALIVE_DIR}/Jenkinsfile.dev" ]] || die "${CHESSALIVE_DIR} has no Jenkinsfile.dev"
elif [[ -n "${CHESSALIVE_DIR}" ]]; then
  [[ -f "${CHESSALIVE_DIR}/Jenkinsfile.dev" ]] \
    || warn "${CHESSALIVE_DIR} has no Jenkinsfile.dev (only used for the sanity check; the jobs fetch from ${REPO_URL})"
fi

# ── build capacity ───────────────────────────────────────────────────────────────────────────────
# The dev/release/config lanes need `npm ci` + vitest + `expo export`: several GB. On Linux the
# decision is made from the box itself when the caller did not make it; on macOS the workstation
# is assumed able (it has been building this all along).
MEM_MB=""
if [[ -r /proc/meminfo ]]; then
  MEM_MB=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
fi
if [[ -z "${DISABLE_JOBS:-}" ]]; then
  if [[ -n "${MEM_MB}" && "${MEM_MB}" -lt "${MIN_BUILD_MB}" ]]; then DISABLE_JOBS=yes; else DISABLE_JOBS=no; fi
fi
BUILD_DISABLED_XML=false
BUILD_DISABLED_NOTE=""
if [[ "${DISABLE_JOBS}" == "yes" ]]; then
  BUILD_DISABLED_XML=true
  BUILD_DISABLED_NOTE=" DISABLED on this controller: ${MEM_MB:-unknown} MB RAM cannot run a build (needs about 3 GB for npm ci + vitest + expo export); it runs on the workstation Jenkins until this box is resized (infra/gcp/ci-vm.sh resize, then DISABLE_JOBS=no)."
fi

# The content lane: enabled everywhere except a workstation polling its own checkout.
CONTENT_DISABLED_XML=false
CONTENT_DISABLED_NOTE=""
if [[ "${REPO_URL}" == file://* ]]; then
  CONTENT_DISABLED_XML=true
  CONTENT_DISABLED_NOTE=" DISABLED on this workstation: the always-on GCP controller (infra/gcp/CI-VM.md) runs this lane against GitHub; a poll of the local checkout would publish content from unpushed commits. Enable here only while that box is down."
fi

write_job() {
  local name="$1" script_path="$2" triggers="$3" desc="$4" disabled="${5:-false}"
  local dir="${JENKINS_HOME}/jobs/${name}"
  mkdir -p "${dir}"
  cat > "${dir}/config.xml" <<XML
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>${desc}</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
    <scm class="hudson.plugins.git.GitSCM" plugin="git">
      <configVersion>2</configVersion>
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>${REPO_URL}</url>
        </hudson.plugins.git.UserRemoteConfig>
      </userRemoteConfigs>
      <branches>
        <hudson.plugins.git.BranchSpec>
          <name>${BRANCH}</name>
        </hudson.plugins.git.BranchSpec>
      </branches>
      <doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations>
      <submoduleCfg class="empty-list"/>
      <extensions/>
    </scm>
    <scriptPath>${script_path}</scriptPath>
    <lightweight>false</lightweight>
  </definition>
  <triggers>${triggers}</triggers>
  <disabled>${disabled}</disabled>
</flow-definition>
XML
  printf '  \033[32m✓\033[0m %s  (%s @ %s%s)\n' "${name}" "${script_path}" "${BRANCH}" \
    "$( [[ "${disabled}" == true ]] && echo ', DISABLED' )"
}

# ── toolchain shim ───────────────────────────────────────────────────────────────────────────────
# Jenkins runs with no login shell (launchd on the Mac, systemd on Linux), so a version-managed or
# non-default-PATH toolchain is invisible to it: `go` in /usr/local/go/bin and nvm's `node` both
# fail with exit 127 at the first `npm ci`. Hardcoding a path into the Jenkinsfile would just move
# the breakage to the next upgrade.
#
# Resolve the tools HERE, once, into a stable directory the pipelines reference by a fixed path.
# Machine specifics stay in the installer; the Jenkinsfiles stay portable.
link_toolchain() {
  mkdir -p "${TOOLCHAIN_DIR}"
  local resolved=0
  for tool in node npm npx go git; do
    local path=""
    # Prefer the interactive shell's own resolution (that is what you build with), then a login
    # shell for nvm/asdf shims, then the fixed places install-linux.sh puts things.
    path="$(command -v "${tool}" 2>/dev/null || true)"
    [[ -n "${path}" ]] || path="$(bash -lc "command -v ${tool}" 2>/dev/null || true)"
    if [[ -z "${path}" ]]; then
      for candidate in "/usr/local/go/bin/${tool}" "/usr/local/bin/${tool}" "/usr/bin/${tool}" "/opt/homebrew/bin/${tool}"; do
        [[ -x "${candidate}" ]] && { path="${candidate}"; break; }
      done
    fi
    if [[ -n "${path}" ]]; then
      ln -sfn "${path}" "${TOOLCHAIN_DIR}/${tool}"
      printf '  \033[32m✓\033[0m %-5s %s\n' "${tool}" "${path}"
      resolved=$((resolved + 1))
    else
      # No link rather than a dangling one: a dangling `go` makes `command -v go` succeed and the
      # exec fail with a confusing ENOENT, whereas an absent one lets publish-content.sh pick
      # MIGRATE_BIN=remote on its own. The content lane needs no Go at all.
      rm -f "${TOOLCHAIN_DIR}/${tool}"
      printf '  \033[33m!\033[0m %-5s not found — left out of the shim (lanes needing it will fail; the content lane does not)\n' "${tool}"
    fi
  done
  [[ "${resolved}" -gt 0 ]] || die "resolved no build tools at all; Jenkins cannot build anything"
}

echo "  toolchain shim: ${TOOLCHAIN_DIR}"
link_toolchain

echo "  repo: ${REPO_URL}"
[[ "${DISABLE_JOBS}" == "yes" ]] && warn "build lanes written DISABLED (${MEM_MB:-?} MB RAM < ${MIN_BUILD_MB} MB)"

POLL="<hudson.triggers.SCMTrigger><spec>H/5 * * * *</spec><ignorePostCommitHooks>false</ignorePostCommitHooks></hudson.triggers.SCMTrigger>"

# Content: the owner's "commit mechanism" for GLBs and catalog slices (content/README.md). Polls
# main every 5 minutes; a run with nothing new for prod is a NOOP. Pure node + rsync + ssh, no
# npm ci, no Go — the one lane that fits the free-tier box, so it is never disabled by memory.
write_job "chessalive-content" "Jenkinsfile.content" "${POLL}" \
  "ChessAlive CONTENT lane - ships committed content/uploads + content/catalog to the OCI box: installs files prod lacks, merges the catalog slices into the live catalog and bumps appStateRevision, or does nothing when prod already matches. Polls main every 5 minutes. Needs only node, rsync and ssh (no npm ci, no Go: the catalog is written by the chessd-migrate the last code release installed on the box), so it runs in under 200 MB and fits this e2-micro.${CONTENT_DISABLED_NOTE}" \
  "${CONTENT_DISABLED_XML}"

# Dev polls every 5 minutes. Cheap (a ls-remote against GitHub), and it means a commit gets checked
# without you remembering to press anything.
write_job "chessalive-dev" "Jenkinsfile.dev" "${POLL}" \
  "ChessAlive DEV lane - typecheck, lint, tests, Go vet/test/cross-build. Polls SCM every 5 minutes. Touches no server.${BUILD_DISABLED_NOTE}" \
  "${BUILD_DISABLED_XML}"

# Release is manual only. A release is a decision; the pipeline also pauses for confirmation
# before it deploys anything.
write_job "chessalive-release" "Jenkinsfile.release" "" \
  "ChessAlive RELEASE lane - full guard, then deploy chessd + web bundle to the OCI box with automatic rollback on health-gate failure. Manual trigger with an in-pipeline approval step.${BUILD_DISABLED_NOTE}" \
  "${BUILD_DISABLED_XML}"

# Config/secrets. Manual only, and the pipeline itself gates every mutating action behind an
# approval step plus a post-change health check.
write_job "chessalive-config" "Jenkinsfile.config" "" \
  "ChessAlive CONFIG + SECRETS - one-click LIST / SET / UNSET / APPLY / VERSIONS / ROLLBACK over the production dotenv held in OCI Vault. Every write creates a new Vault version and health-checks the host afterwards.${BUILD_DISABLED_NOTE}" \
  "${BUILD_DISABLED_XML}"

# On Linux the files were written by root; Jenkins runs as jenkins and must own them (a job
# directory it cannot write to shows up as a build that cannot even create build.xml).
if [[ "${LINUX_BOX}" == "yes" && "$(id -u)" -eq 0 ]] && id -u "${CI_USER}" >/dev/null 2>&1; then
  chown -R "${CI_USER}:${CI_USER}" "${JENKINS_HOME}/jobs" "${JENKINS_HOME}/.jenkins"
  ok "owned by ${CI_USER}"
fi

# ── reload ───────────────────────────────────────────────────────────────────────────────────────
wait_for_login() {
  printf '  waiting for Jenkins'
  for _ in $(seq 1 150); do
    if curl -sf -o /dev/null http://127.0.0.1:8080/login 2>/dev/null; then echo; return 0; fi
    printf '.'; sleep 2
  done
  echo; return 1
}

echo "  reloading Jenkins..."
if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q '^jenkins-lts'; then
  brew services restart jenkins-lts >/dev/null
  ok "jenkins restarted"
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files jenkins.service >/dev/null 2>&1 \
     && systemctl list-unit-files jenkins.service | grep -q '^jenkins.service'; then
  systemctl restart jenkins
  wait_for_login && ok "jenkins restarted (systemd)" || die "Jenkins did not come back after the restart: journalctl -u jenkins -n 100"
else
  warn "reload manually: Manage Jenkins -> Reload Configuration from Disk"
fi
