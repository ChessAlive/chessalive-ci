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
#                  rsync + ssh, ~200 MB) and the whole reason the box exists. It has no SCM trigger
#                  (manual: Build with Parameters -> plan -> approve -> publish). It is written
#                  disabled only for a file:// remote (a workstation), where a build of the local
#                  checkout would publish content from commits that were never pushed.
#                  The RELEASE job ignores it too when the build-backend file (below) says
#                  cloudbuild: then the build runs on Google Cloud Build and the box only fetches,
#                  verifies and deploys — node + gsutil + rsync + ssh, which the micro can do.
#   build-backend  not an env knob but a FILE the Jenkinsfile reads on the agent:
#                  ${HOME}/.jenkins/build-backend (/var/lib/jenkins/.jenkins/build-backend on
#                  Linux, ~/.jenkins/build-backend on a Mac). Containing "cloudbuild" makes
#                  Jenkinsfile.release's BUILD_BACKEND=auto resolve to cloudbuild; absent = local.
#                  install-linux.sh writes it (CHESSALIVE_BUILD_BACKEND); nothing writes it on a
#                  Mac. This script only READS it, to decide whether the release job is enabled.
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
# Same place the Jenkinsfile looks: ${HOME}/.jenkins/build-backend for the user Jenkins runs as.
if [[ "${LINUX_BOX}" == "yes" ]]; then
  BACKEND_FILE="${JENKINS_HOME}/.jenkins/build-backend"
else
  BACKEND_FILE="${JENKINS_HOME}/build-backend"
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

# The release lane is the exception to the RAM guard when the agent is set to build on Cloud
# Build: Jenkinsfile.release then replaces Install/Guard/Test/Build/Budgets with one
# `gcloud builds submit` (cloudbuild/release.yaml in ChessAlive) and a fetch of the built
# artifacts from gs://chessalive-ci-artifacts — the box never runs npm ci. What remains on the
# agent is a depth-1 checkout, gcloud/gsutil, and the same Content/Deploy/Smoke tail the content
# lane already proved fits. dev and config stay under the guard: they still build locally.
RELEASE_BACKEND=local
if [[ -s "${BACKEND_FILE}" ]] && grep -q cloudbuild "${BACKEND_FILE}"; then
  RELEASE_BACKEND=cloudbuild
fi
RELEASE_DISABLED_XML="${BUILD_DISABLED_XML}"
RELEASE_NOTE="${BUILD_DISABLED_NOTE}"
if [[ "${RELEASE_BACKEND}" == "cloudbuild" ]]; then
  RELEASE_DISABLED_XML=false
  RELEASE_NOTE=" ENABLED here with BUILD_BACKEND=cloudbuild (${BACKEND_FILE}): the guard, tests and build run as ONE Google Cloud Build (cloudbuild/release.yaml, project chessalive-495918, free tier = 120 build-minutes/day, a full release is about 35 of them) and this controller only fetches the binaries + web bundle from gs://chessalive-ci-artifacts/releases/SHA/, verifies every sha256 against the manifest, then runs Approve -> Content -> Deploy -> Smoke exactly as the Mac does. Start it by hand: infra/gcp/ci-vm.sh kick chessalive-release [REQUIRE_APPROVAL=true] [SKIP_WEB=true] ...; watch the Cloud Build in the build's console log or at the URL in its description. The Assets stage (oci CLI) does not run here - sync assets from the Mac when one changed."
fi

# The content lane: enabled everywhere except a workstation building from its own checkout.
CONTENT_DISABLED_XML=false
CONTENT_DISABLED_NOTE=""
if [[ "${REPO_URL}" == file://* ]]; then
  CONTENT_DISABLED_XML=true
  CONTENT_DISABLED_NOTE=" DISABLED on this workstation: the always-on GCP controller (infra/gcp/CI-VM.md) runs this lane against GitHub; a build of the local checkout would publish content from unpushed commits. Enable here only while that box is down."
fi

# The Jenkinsfile itself is fetched by a NON-lightweight checkout into <job>@script/ (kept between
# builds). By default that is a full clone: 2.6 GB for this repo (10.8k commits of GLB history), on
# top of whatever the pipeline clones for itself. Fine on the Mac; on the 20 GB micro with ~3.7 GB
# free it fills the disk before the first stage runs. The content job therefore narrows the
# fetch to its one branch (refspec — origin carries ~750 branches, and a depth-1 clone of all
# their tips is still 1.1 GB against 0.27 GB for main alone) and takes a shallow, sparse clone
# that checks out nothing but the Jenkinsfile: ≈0.3 GB, kept. The pipeline's own checkout
# inherits the refspec through scm.userRemoteConfigs.
# The content job's build parameters, written into the job so that "Build with Parameters" (and
# `ci-vm.sh kick chessalive-content DRY_RUN=true`) works from the moment the job exists. Declarative
# re-declares them from Jenkinsfile.content on every run — that file is the source of truth for
# names, defaults and the WHY — but a job that has never run carries none, and Jenkins answers a
# parameterised build request on such a job with 500 "not parameterized". Keep the three in step
# with the Jenkinsfile's parameters block.
content_parameters() {
  cat <<XML
    <hudson.model.ParametersDefinitionProperty>
      <parameterDefinitions>
        <hudson.model.StringParameterDefinition>
          <name>BRANCH</name>
          <description>Branch whose content/ to publish. main is what players should see; another branch is for rehearsing a content commit before it merges (pair it with DRY_RUN). A plain branch name, not a ref.</description>
          <defaultValue>main</defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>DRY_RUN</name>
          <description>Plan only: what would be installed and how the catalog would change, written into the build description. Nothing is installed or written.</description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>REQUIRE_APPROVAL</name>
          <description>Pause after the plan and wait (up to 8 hours) for a human to click Publish. ON by default: a commit stages content, a person releases it. Turn OFF only for a publish you have already planned with DRY_RUN.</description>
          <defaultValue>true</defaultValue>
        </hudson.model.BooleanParameterDefinition>
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
XML
}

# The release job's parameters, for the same reason as the content job's: `ci-vm.sh kick
# chessalive-release REQUIRE_APPROVAL=true` must work on a job that has never run. Keep in step
# with Jenkinsfile.release's parameters block (names, defaults; the descriptions there are the
# full WHY, these are the short form).
release_parameters() {
  cat <<XML
    <hudson.model.ParametersDefinitionProperty>
      <parameterDefinitions>
        <hudson.model.StringParameterDefinition>
          <name>BRANCH</name>
          <description>Branch to release (a plain branch name). main is what players get.</description>
          <defaultValue>main</defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>SKIP_WEB</name>
          <description>Server-only deploy: ship the chessd binary, keep the web bundle the host has.</description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>SKIP_ASSETS</name>
          <description>Skip the object-storage sync (audio, models, images). Only runs on the local backend anyway; on cloudbuild the log says how to sync from the Mac.</description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>SKIP_CONTENT</name>
          <description>Skip publishing content/ (hero GLBs + catalog slices) to the box. Already a no-op when prod matches the commit.</description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>REQUIRE_APPROVAL</name>
          <description>Pause before deploying and wait (up to 8 hours) for a human to click Deploy: infra/gcp/ci-vm.sh approve chessalive-release.</description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>SKIP_TESTS</name>
          <description>DANGER: skip Guard and Test. The build is tagged NO-GATES.</description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>
        <hudson.model.ChoiceParameterDefinition>
          <name>BUILD_BACKEND</name>
          <description>auto = cloudbuild when this agent's ~/.jenkins/build-backend says so (the GCP box), else local (the Mac). cloudbuild = one Google Cloud Build does the guard/tests/build; this agent fetches, verifies and deploys.</description>
          <choices class="java.util.Arrays\$ArrayList">
            <a class="string-array">
              <string>auto</string>
              <string>local</string>
              <string>cloudbuild</string>
            </a>
          </choices>
        </hudson.model.ChoiceParameterDefinition>
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
XML
}

content_scm_extensions() {
  cat <<XML
        <hudson.plugins.git.extensions.impl.CloneOption>
          <shallow>true</shallow>
          <noTags>true</noTags>
          <reference></reference>
          <depth>1</depth>
          <honorRefspec>true</honorRefspec>
        </hudson.plugins.git.extensions.impl.CloneOption>
        <hudson.plugins.git.extensions.impl.SparseCheckoutPaths>
          <sparseCheckoutPaths>
            <hudson.plugins.git.extensions.impl.SparseCheckoutPath>
              <path>$1</path>
            </hudson.plugins.git.extensions.impl.SparseCheckoutPath>
          </sparseCheckoutPaths>
        </hudson.plugins.git.extensions.impl.SparseCheckoutPaths>
XML
}

write_job() {
  local name="$1" script_path="$2" triggers="$3" desc="$4" disabled="${5:-false}" refspec="${6:-}" extensions="${7:-}" properties="${8:-}"
  local dir="${JENKINS_HOME}/jobs/${name}"
  local refspec_xml="" extensions_xml="<extensions/>" properties_xml="<properties/>"
  [[ -n "${properties}" ]] && properties_xml="<properties>
${properties}
  </properties>"
  [[ -n "${refspec}" ]] && refspec_xml="
          <refspec>${refspec}</refspec>"
  [[ -n "${extensions}" ]] && extensions_xml="<extensions>
${extensions}
      </extensions>"
  mkdir -p "${dir}"
  cat > "${dir}/config.xml" <<XML
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>${desc}</description>
  <keepDependencies>false</keepDependencies>
  ${properties_xml}
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
    <scm class="hudson.plugins.git.GitSCM" plugin="git">
      <configVersion>2</configVersion>
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>${REPO_URL}</url>${refspec_xml}
        </hudson.plugins.git.UserRemoteConfig>
      </userRemoteConfigs>
      <branches>
        <hudson.plugins.git.BranchSpec>
          <name>${BRANCH}</name>
        </hudson.plugins.git.BranchSpec>
      </branches>
      <doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations>
      <submoduleCfg class="empty-list"/>
      ${extensions_xml}
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
  # gcloud + gsutil are OPTIONAL: the cloudbuild backend of the release lane needs them (the
  # box: /usr/bin from google-cloud-cli, authenticated by the VM's service account through the
  # metadata server); the local backend never calls them, so a Mac without them is fine.
  for tool in node npm npx go git gcloud gsutil; do
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
      printf '  \033[32m✓\033[0m %-6s %s\n' "${tool}" "${path}"
      resolved=$((resolved + 1))
    elif [[ "${tool}" == gcloud || "${tool}" == gsutil ]]; then
      rm -f "${TOOLCHAIN_DIR}/${tool}"
      printf '  \033[33m!\033[0m %-6s not found — left out of the shim (only the release lane'"'"'s cloudbuild backend needs it)\n' "${tool}"
    else
      # No link rather than a dangling one: a dangling `go` makes `command -v go` succeed and the
      # exec fail with a confusing ENOENT, whereas an absent one lets publish-content.sh pick
      # MIGRATE_BIN=remote on its own. The content lane needs no Go at all.
      rm -f "${TOOLCHAIN_DIR}/${tool}"
      printf '  \033[33m!\033[0m %-6s not found — left out of the shim (lanes needing it will fail; the content lane does not)\n' "${tool}"
    fi
  done
  [[ "${resolved}" -gt 0 ]] || die "resolved no build tools at all; Jenkins cannot build anything"
}

echo "  toolchain shim: ${TOOLCHAIN_DIR}"
link_toolchain

echo "  repo: ${REPO_URL}"
[[ "${DISABLE_JOBS}" == "yes" ]] && warn "build lanes written DISABLED (${MEM_MB:-?} MB RAM < ${MIN_BUILD_MB} MB)"
if [[ "${RELEASE_BACKEND}" == "cloudbuild" ]]; then
  ok "release lane: BUILD_BACKEND=cloudbuild (${BACKEND_FILE}) — written ENABLED; builds run on Google Cloud Build"
  for t in gcloud gsutil; do
    [[ -x "${TOOLCHAIN_DIR}/${t}" ]] || warn "${t} is not in the shim: the release lane's Cloud Build stage will fail until google-cloud-cli is installed (install-linux.sh does that)"
  done
else
  echo "  release lane: BUILD_BACKEND=local (no cloudbuild in ${BACKEND_FILE})"
fi

POLL="<hudson.triggers.SCMTrigger><spec>H/5 * * * *</spec><ignorePostCommitHooks>false</ignorePostCommitHooks></hudson.triggers.SCMTrigger>"

# Content: the owner's "commit mechanism" for GLBs and catalog slices (content/README.md) — and,
# by the same owner's rule, MANUAL: "I don't want automatic publishing." A commit stages content; a
# person releases it. So this job gets NO SCM trigger (an empty <triggers/>): the poll it used to
# have shipped a catalog change (build #3 on the box, revision 14 -> 15) minutes after a commit
# landed with nobody deciding it should. The flow is Build with Parameters (or
# infra/gcp/ci-vm.sh kick chessalive-content [DRY_RUN=true]) -> the pipeline plans
# (publish-content.sh --dry-run, plan in the build description) -> a human clicks Publish
# (ci-vm.sh approve chessalive-content) -> the real publish. Pure node + rsync + ssh, no npm ci,
# no Go — the one lane that fits the free-tier box, so it is never disabled by memory.
write_job "chessalive-content" "Jenkinsfile.content" "" \
  "ChessAlive CONTENT lane - manual: Build with Parameters -> plan -> approve -> publish. Ships committed content/uploads + content/catalog to the OCI box: installs files prod lacks, merges the catalog slices into the live catalog and bumps appStateRevision, or does nothing when prod already matches. Never runs on its own (no SCM trigger - the owner wants no automatic publishing; a commit stages content, a person releases it): the Plan stage is a dry run whose result lands in the build description, and the Approve gate waits up to 8 hours for a human to click Publish. DRY_RUN=true plans and writes nothing. Needs only node, rsync and ssh (no npm ci, no Go: the catalog is written by the chessd-migrate the last code release installed on the box), so it runs in under 200 MB and fits this e2-micro.${CONTENT_DISABLED_NOTE}" \
  "${CONTENT_DISABLED_XML}" \
  "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" \
  "$(content_scm_extensions Jenkinsfile.content)" \
  "$(content_parameters)"

# Dev polls every 5 minutes. Cheap (a ls-remote against GitHub), and it means a commit gets checked
# without you remembering to press anything.
write_job "chessalive-dev" "Jenkinsfile.dev" "${POLL}" \
  "ChessAlive DEV lane - typecheck, lint, tests, Go vet/test/cross-build. Polls SCM every 5 minutes. Touches no server.${BUILD_DISABLED_NOTE}" \
  "${BUILD_DISABLED_XML}"

# Release is manual only. A release is a decision; the pipeline also pauses for confirmation
# before it deploys anything. On the Linux box its Jenkinsfile fetch gets the same main-only,
# shallow, sparse @script clone as the content job (a default full clone is 2.6 GB — the micro's
# whole free disk); on a workstation the file:// remote is cheap and stays as it was. The
# parameters are written in so a kick with NAME=value works before the first run.
RELEASE_REFSPEC=""
RELEASE_EXTENSIONS=""
if [[ "${LINUX_BOX}" == "yes" ]]; then
  RELEASE_REFSPEC="+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
  RELEASE_EXTENSIONS="$(content_scm_extensions Jenkinsfile.release)"
fi
write_job "chessalive-release" "Jenkinsfile.release" "" \
  "ChessAlive RELEASE lane - full guard, then deploy chessd + web bundle to the OCI box with automatic rollback on health-gate failure. Manual trigger with an in-pipeline approval step.${RELEASE_NOTE}" \
  "${RELEASE_DISABLED_XML}" \
  "${RELEASE_REFSPEC}" \
  "${RELEASE_EXTENSIONS}" \
  "$(release_parameters)"

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
