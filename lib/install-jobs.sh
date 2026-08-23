#!/usr/bin/env bash
#
# Create (or refresh) the two ChessAlive Jenkins jobs.
#
#   ./lib/install-jobs.sh /path/to/ChessAlive
#
# Writes job definitions straight into JENKINS_HOME on disk rather than going through the REST
# API, so this needs no API token and never handles your Jenkins password.
#
# Run it after finishing the Jenkins setup wizard — the jobs need the Pipeline and Git plugins,
# both of which come with "Install suggested plugins".
#
set -euo pipefail

CHESSALIVE_DIR="${1:-${CHESSALIVE_DIR:-}}"
JENKINS_HOME="${JENKINS_HOME:-${HOME}/.jenkins}"
BRANCH="${BRANCH:-main}"

die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "${CHESSALIVE_DIR}" ]] || die "usage: install-jobs.sh /path/to/ChessAlive"
CHESSALIVE_DIR="$(cd "${CHESSALIVE_DIR}" && pwd)"
[[ -f "${CHESSALIVE_DIR}/Jenkinsfile.dev" ]] || die "${CHESSALIVE_DIR} has no Jenkinsfile.dev"
[[ -d "${JENKINS_HOME}" ]] || die "JENKINS_HOME not found at ${JENKINS_HOME}"
[[ -d "${JENKINS_HOME}/plugins/workflow-job" ]] \
  || die "Pipeline plugin missing — finish the Jenkins setup wizard ('Install suggested plugins') first."

# Your own checkout is the SCM source. That is deliberate, not a shortcut: the Go/OCI stack lived
# on feat/go-server until it merged to main on 2026-08-24, and that branch existed
# only locally on the maintainer's machine, and building from your working repo is what makes the
# dev lane useful before anything is pushed. Point REPO_URL at GitHub once the branch is pushed.
REPO_URL="${REPO_URL:-file://${CHESSALIVE_DIR}}"

write_job() {
  local name="$1" script_path="$2" triggers="$3" desc="$4"
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
  <disabled>false</disabled>
</flow-definition>
XML
  printf '  \033[32m✓\033[0m %s  (%s @ %s)\n' "${name}" "${script_path}" "${BRANCH}"
}

# ── toolchain shim ───────────────────────────────────────────────────────────────────────────────
# Jenkins runs from launchd with no login shell, so a version-managed toolchain is invisible to it:
# `go` resolves (Homebrew is on the default PATH) but nvm-managed `node`/`npm` do not, and every
# build dies at `npm ci` with exit 127. Hardcoding an nvm version into the Jenkinsfile would just
# move the breakage to the next Node upgrade.
#
# Resolve the tools HERE, once, into a stable directory the pipelines can reference by a fixed path.
# Machine specifics stay in the installer; the Jenkinsfiles stay portable.
link_toolchain() {
  local bin="${JENKINS_HOME}/toolchain/bin"
  mkdir -p "${bin}"
  local resolved=0
  for tool in node npm npx go git; do
    # Prefer whatever the developer's own interactive shell resolves, since that is the toolchain
    # they actually build with; fall back to a login shell so nvm/asdf shims get a chance to load.
    local path
    path="$(command -v "${tool}" 2>/dev/null || true)"
    if [[ -z "${path}" ]]; then
      path="$(bash -lc "command -v ${tool}" 2>/dev/null || true)"
    fi
    if [[ -n "${path}" ]]; then
      ln -sf "${path}" "${bin}/${tool}"
      printf '  \033[32m✓\033[0m %-5s %s\n' "${tool}" "${path}"
      resolved=$((resolved + 1))
    else
      printf '  \033[33m!\033[0m %-5s not found — builds needing it will fail\n' "${tool}"
    fi
  done
  [[ "${resolved}" -gt 0 ]] || die "resolved no build tools at all; Jenkins cannot build anything"
}

echo "  toolchain shim: ${JENKINS_HOME}/toolchain/bin"
link_toolchain

echo "  repo: ${REPO_URL}"

# Dev polls every 5 minutes. Cheap against a local repo, and it means a commit gets checked
# without you remembering to press anything.
write_job "chessalive-dev" "Jenkinsfile.dev" \
  "<hudson.triggers.SCMTrigger><spec>H/5 * * * *</spec><ignorePostCommitHooks>false</ignorePostCommitHooks></hudson.triggers.SCMTrigger>" \
  "ChessAlive DEV lane - typecheck, lint, tests, Go vet/test/cross-build. Polls SCM every 5 minutes. Touches no server."

# Release is manual only. A release is a decision; the pipeline also pauses for confirmation
# before it deploys anything.
write_job "chessalive-release" "Jenkinsfile.release" "" \
  "ChessAlive RELEASE lane - full guard, then deploy chessd + web bundle to the OCI box with automatic rollback on health-gate failure. Manual trigger with an in-pipeline approval step."

# Config/secrets. Manual only, and the pipeline itself gates every mutating action behind an
# approval step plus a post-change health check.
write_job "chessalive-config" "Jenkinsfile.config" "" \
  "ChessAlive CONFIG + SECRETS - one-click LIST / SET / UNSET / APPLY / VERSIONS / ROLLBACK over the production dotenv held in OCI Vault. Every write creates a new Vault version and health-checks the host afterwards."

echo "  reloading Jenkins..."
if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q '^jenkins-lts'; then
  brew services restart jenkins-lts >/dev/null
  printf '  \033[32m✓\033[0m jenkins restarted\n'
else
  printf '  \033[33m!\033[0m reload manually: Manage Jenkins -> Reload Configuration from Disk\n'
fi
