#!/usr/bin/env bash
# ChessAlive local release lane.
#
# This is the replacement for the Jenkins -> Cloud Build release path. It runs on the build host,
# produces the tested target-architecture artifacts, and deploys them with the existing
# rollback-safe OCI installer. The build itself always runs on this host; DEPLOY_REMOTE=yes sends
# the finished artifacts to the production Mumbai host over SSH. It intentionally builds the
# current checkout; the trigger service must run from the checkout that should be released.

set -euo pipefail

CI_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${CI_ROOT_DIR}/release/progress.sh"

low_mem_host="no"
total_mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 16777216)"
if [[ -z "${COMMAND_LOG:-}" ]] && (( total_mem_kb < 2097152 )); then
  low_mem_host="yes"
fi

# When running on an Always Free E2.1.Micro (1 GB RAM) control plane with a remote 12 GB ARM64 host
# configured, delegate heavy compilation and bundle steps over SSH to the remote host so the build
# finishes without exhausting control-plane memory while capping CPU/IO impact on live production.
if [[ "${low_mem_host}" == yes && "${DEPLOY_REMOTE:-no}" == yes && -n "${DEPLOY_HOST:-}" && -n "${DEPLOY_SSH_KEY:-}" && -r "${DEPLOY_SSH_KEY:-}" && "${DELEGATE_LOW_MEM_BUILD:-yes}" == yes ]]; then
  echo "Delegating throttled build execution to host ${DEPLOY_USER:-ubuntu}@${DEPLOY_HOST}"
  delegated_control_path="${BUILD_SSH_CONTROL_PATH:-${TMPDIR:-/tmp}/chessalive-ci-ssh-%C}"
  delegated_ssh_opts=(
    -i "${DEPLOY_SSH_KEY}"
    -o IdentitiesOnly=yes
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o ControlMaster=auto
    -o "ControlPath=${delegated_control_path}"
    -o ControlPersist=300
  )
  ssh "${delegated_ssh_opts[@]}" "${DEPLOY_USER:-ubuntu}@${DEPLOY_HOST}" \
    "while IFS='=' read -r k v; do
       [[ -n \"\${k}\" && \"\${k}\" != \\#* ]] || continue
       v=\"\${v%\\\"}\"; v=\"\${v#\\\"}\"
       v=\"\${v%\\'}\"; v=\"\${v#\\'}\"
       export \"\${k}=\${v}\"
     done < <(sudo cat /etc/chessalive.env 2>/dev/null || true); \
     export CHESSALIVE_PROGRESS='${CHESSALIVE_PROGRESS:-no}' \
            SOURCE_DIR='/opt/chessalive/repo' \
            SYNC_SOURCE='${SYNC_SOURCE:-yes}' \
            SOURCE_GIT_URL='${SOURCE_GIT_URL:-git@github.com:ChessAlive/ChessAlive.git}' \
            SOURCE_GIT_REF='${SOURCE_GIT_REF:-main}' \
            SOURCE_SSH_KEY='/home/ubuntu/.ssh/chessalive_ci_deploy' \
            SKIP_TESTS='${SKIP_TESTS:-no}' \
            SKIP_FULL_TESTS='${SKIP_FULL_TESTS:-yes}' \
            SKIP_WEB_SETUP='${SKIP_WEB_SETUP:-yes}' \
            SKIP_BUDGETS='${SKIP_BUDGETS:-yes}' \
            SKIP_ASSETS='${SKIP_ASSETS:-yes}' \
            SKIP_CONTENT='${SKIP_CONTENT:-no}' \
            SKIP_DEPLOY='${SKIP_DEPLOY:-no}' \
            DEPLOY_TARGET='${DEPLOY_TARGET:-prod}' \
            PREPROD_URL='${PREPROD_URL:-}' \
            DEPLOY_REMOTE='no' \
            LOCAL_DEPLOY='yes' \
            PUBLIC_URL='${PUBLIC_URL:-https://chessalive.com}' \
            DELEGATE_LOW_MEM_BUILD='no' \
            DELEGATED_PRODUCTION_BUILD='yes' \
            PARALLEL_BUILD='${PARALLEL_BUILD:-no}' \
            CHESSALIVE_BUILD_MAX_WORKERS='${CHESSALIVE_BUILD_MAX_WORKERS:-1}' \
            DELEGATED_CPU_QUOTA='${DELEGATED_CPU_QUOTA:-120%}' \
            DELEGATED_CPU_WEIGHT='${DELEGATED_CPU_WEIGHT:-10}' \
            DELEGATED_IO_WEIGHT='${DELEGATED_IO_WEIGHT:-10}'; \
     bash /opt/chessalive-ci/release/local-release.sh"
  rc="$?"
  if (( rc == 0 )) && [[ -n "${SOURCE_DIR:-}" ]]; then
    ssh "${delegated_ssh_opts[@]}" "${DEPLOY_USER:-ubuntu}@${DEPLOY_HOST}" \
      "cat /opt/chessalive/repo/.source-commit 2>/dev/null" > "${SOURCE_DIR}/.source-commit" 2>/dev/null || true
    ssh "${delegated_ssh_opts[@]}" "${DEPLOY_USER:-ubuntu}@${DEPLOY_HOST}" \
      "cat /opt/chessalive/repo/.source-commit-message 2>/dev/null" > "${SOURCE_DIR}/.source-commit-message" 2>/dev/null || true
    ssh "${delegated_ssh_opts[@]}" "${DEPLOY_USER:-ubuntu}@${DEPLOY_HOST}" \
      "cat /opt/chessalive/repo/.source-commit-date 2>/dev/null" > "${SOURCE_DIR}/.source-commit-date" 2>/dev/null || true
  fi
  exit "${rc}"
fi

# When running as a delegated build guest on the live production VM, place the build inside a
# low-weight cgroup CPU/IO scope and single-worker concurrency so live games keep Dedicated CPU headroom.
if [[ "${DELEGATED_PRODUCTION_BUILD:-no}" == yes && "${DELEGATED_SCOPE_ACTIVE:-no}" != yes ]]; then
  export DELEGATED_SCOPE_ACTIVE=yes
  export PARALLEL_BUILD="${PARALLEL_BUILD:-no}"
  export CHESSALIVE_BUILD_MAX_WORKERS="${CHESSALIVE_BUILD_MAX_WORKERS:-1}"
  export GOMAXPROCS="${GOMAXPROCS:-1}"
  export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-2}"
  export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
  export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-1}"
  if [[ "${DELEGATED_DISABLE_SYSTEMD_SCOPE:-no}" != yes ]] && command -v systemd-run >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo -n -E true 2>/dev/null; then
    prio_cmd=()
    command -v nice >/dev/null 2>&1 && prio_cmd+=(nice -n 19)
    command -v ionice >/dev/null 2>&1 && prio_cmd+=(ionice -c 3)
    exec sudo -n -E systemd-run --quiet --scope --uid="$(id -u)" --gid="$(id -g)" \
      -p "CPUWeight=${DELEGATED_CPU_WEIGHT:-10}" \
      -p "IOWeight=${DELEGATED_IO_WEIGHT:-10}" \
      -p "CPUQuota=${DELEGATED_CPU_QUOTA:-120%}" -- \
      "${prio_cmd[@]}" bash "${BASH_SOURCE[0]}" "$@"
  elif command -v nice >/dev/null 2>&1; then
    exec nice -n 19 bash "${BASH_SOURCE[0]}" "$@"
  fi
fi

trap 'progress_on_exit "$?"' EXIT
progress_mark prepare running
SOURCE_DIR="${SOURCE_DIR:-/opt/chessalive}"
SYNC_SOURCE="${SYNC_SOURCE:-yes}"
SOURCE_GIT_URL="${SOURCE_GIT_URL:-${BUILD_GIT_URL:-https://github.com/ChessAlive/ChessAlive.git}}"
SOURCE_GIT_REF="${SOURCE_GIT_REF:-main}"
SOURCE_SSH_KEY="${SOURCE_SSH_KEY:-}"
SOURCE_COMMIT_FILE="${SOURCE_COMMIT_FILE:-${SOURCE_DIR}/.source-commit}"
SOURCE_COMMIT_MESSAGE_FILE="${SOURCE_COMMIT_MESSAGE_FILE:-${SOURCE_DIR}/.source-commit-message}"
SOURCE_COMMIT_DATE_FILE="${SOURCE_COMMIT_DATE_FILE:-${SOURCE_DIR}/.source-commit-date}"

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

sync_source_checkout() {
  command -v git >/dev/null || die 'git is required to synchronize the release checkout'
  command -v rsync >/dev/null || die 'rsync is required to synchronize the release checkout'
  [[ -n "${SOURCE_GIT_URL}" ]] || die 'SOURCE_GIT_URL is empty; cannot synchronize the release checkout'

  say "Synchronizing ${SOURCE_GIT_URL} @ ${SOURCE_GIT_REF}"
  if [[ -n "${SOURCE_SSH_KEY}" ]]; then
    [[ -r "${SOURCE_SSH_KEY}" ]] || die "SOURCE_SSH_KEY is not readable: ${SOURCE_SSH_KEY}"
    export GIT_SSH_COMMAND="ssh -i ${SOURCE_SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  fi

  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    say "Updating persistent release checkout"
    if [[ "$(id -u)" != 0 ]] && command -v sudo >/dev/null 2>&1; then
      if [[ -n "$(find "${SOURCE_DIR}" -maxdepth 3 -not -user "$(id -un)" -print -quit 2>/dev/null)" ]]; then
        sudo -n chown -R "$(id -u):$(id -g)" "${SOURCE_DIR}" 2>/dev/null || true
      fi
    fi
    git -C "${SOURCE_DIR}" config core.trustctime false 2>/dev/null || true
    git -C "${SOURCE_DIR}" remote set-url origin "${SOURCE_GIT_URL}" 2>/dev/null || git -C "${SOURCE_DIR}" remote add origin "${SOURCE_GIT_URL}"
    git -C "${SOURCE_DIR}" fetch --quiet --prune --depth=1 origin "${SOURCE_GIT_REF}"
    # A single-branch checkout may only map origin/main. FETCH_HEAD identifies the
    # successful fetch even when the selected branch has no remote-tracking ref.
    git -C "${SOURCE_DIR}" reset --hard --quiet FETCH_HEAD
    git -C "${SOURCE_DIR}" clean -fd -e node_modules/ -e apps/player-app/dist/ -e 'apps/go-server/chessd-linux-*' -e 'apps/go-server/chessd-migrate-linux-*' >/dev/null
    git -C "${SOURCE_DIR}" rev-parse HEAD > "${SOURCE_COMMIT_FILE}"
    git -C "${SOURCE_DIR}" log -1 --format=%s > "${SOURCE_COMMIT_MESSAGE_FILE}"
    git -C "${SOURCE_DIR}" log -1 --format=%aI > "${SOURCE_COMMIT_DATE_FILE}"
    echo "source checkout: $(cut -c1-12 "${SOURCE_COMMIT_FILE}")"
    return 0
  fi

  local checkout
  checkout="$(mktemp -d "${TMPDIR:-/tmp}/chessalive-source.XXXXXX")"
  git clone --quiet --depth=1 --branch "${SOURCE_GIT_REF}" "${SOURCE_GIT_URL}" "${checkout}/repo"

  # Keep generated dependencies, build output, and content-addressed image cache local, but delete
  # stale tracked source files. The cache survives normal git clean (it is ignored), and must also
  # survive this rsync fallback when the checkout has to be recreated.
  rsync -a --delete \
    --exclude node_modules/ \
    --exclude apps/player-app/dist/ \
    --exclude '/.cache/squoosh-webp-v1/' \
    --exclude '/.cache/web-compression-v1/' \
    --exclude '/.cache/tsconfig.player-app.tsbuildinfo' \
    --exclude '/.cache/eslintcache' \
    --exclude 'apps/go-server/chessd-linux-*' \
    --exclude 'apps/go-server/chessd-migrate-linux-*' \
    "${checkout}/repo/" "${SOURCE_DIR}/"
  git -C "${SOURCE_DIR}" rev-parse HEAD > "${SOURCE_COMMIT_FILE}"
  git -C "${SOURCE_DIR}" log -1 --format=%s > "${SOURCE_COMMIT_MESSAGE_FILE}"
  git -C "${SOURCE_DIR}" log -1 --format=%aI > "${SOURCE_COMMIT_DATE_FILE}"
  rm -rf "${checkout}"
  echo "source checkout: $(cut -c1-12 "${SOURCE_COMMIT_FILE}")"
}

if [[ "${SYNC_SOURCE}" == yes ]]; then
  sync_source_checkout
else
  [[ -s "${SOURCE_COMMIT_FILE}" ]] || die "${SOURCE_COMMIT_FILE} is missing; refusing to build an unverified checkout"
  source_commit="$(tr -d '[:space:]' < "${SOURCE_COMMIT_FILE}")"
  if [[ -n "${BUILD_COMMIT_HASH:-}" && "${BUILD_COMMIT_HASH}" != unknown && "${source_commit}" != "${BUILD_COMMIT_HASH}" ]]; then
    die "source checkout ${source_commit:0:12} does not match BUILD_COMMIT_HASH ${BUILD_COMMIT_HASH:0:12}; refusing stale release"
  fi
  echo "verified source checkout: ${source_commit:0:12}"
fi

ROOT_DIR="${SOURCE_DIR}"
cd "${SOURCE_DIR}"

SKIP_TESTS="${SKIP_TESTS:-no}"
SKIP_FULL_TESTS="${SKIP_FULL_TESTS:-no}"
SKIP_WEB="${SKIP_WEB:-no}"
SKIP_ASSETS="${SKIP_ASSETS:-yes}"
SKIP_INSTALL="${SKIP_INSTALL:-no}"
SKIP_DEPLOY="${SKIP_DEPLOY:-no}"
DEPLOY_TARGET="${DEPLOY_TARGET:-prod}"
# Build-only invocations stay read-only unless content publishing is requested.
# Pre-prod deploys must never mutate production's live content catalog.
if [[ "${DEPLOY_TARGET}" == "preprod" && "${ALLOW_PREPROD_CONTENT_PUBLISH:-no}" != yes ]]; then
  SKIP_CONTENT="yes"
else
  SKIP_CONTENT="${SKIP_CONTENT:-${SKIP_DEPLOY}}"
fi
DEPLOY_REMOTE="${DEPLOY_REMOTE:-no}"
DEPLOY_HOST="${DEPLOY_HOST:-161.118.175.12}"
DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
SKIP_WEB_SETUP="${SKIP_WEB_SETUP:-no}"
SKIP_BUDGETS="${SKIP_BUDGETS:-no}"
LOCAL_DEPLOY="${LOCAL_DEPLOY:-yes}"
PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:8080}"
BUILD_ARCH="${BUILD_ARCH:-$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')}"
EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN="${EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN:-https://objectstorage.ap-mumbai-1.oraclecloud.com/n/bmt2adcjgo0u/b/chessalive-audio/o}"

run() { say "$*"; "$@"; }
step_run() { local step="$1"; shift; say "$*"; progress_run "${step}" "$@"; }

[[ "${LOCAL_DEPLOY}" == yes ]] || die 'local-release.sh requires LOCAL_DEPLOY=yes; it never delegates builds to Jenkins or Cloud Build'
command -v node >/dev/null || die 'node is required'
command -v npm >/dev/null || die 'npm is required'
command -v go >/dev/null || die 'go is required'
command -v file >/dev/null || die 'file is required'
progress_mark prepare done

if [[ "${SKIP_INSTALL}" != yes ]]; then
  # The service also loads the production runtime environment so the built server matches Mumbai.
  # npm treats NODE_ENV=production as a request to omit devDependencies, but the release gate
  # itself needs TypeScript, ESLint, Vitest, Expo, and the build tooling. Explicitly include them.
  lock_hash=""
  if [[ -f package-lock.json ]]; then
    lock_hash="$(sha256sum package-lock.json 2>/dev/null | awk '{print $1}' || shasum -a 256 package-lock.json 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [[ -n "${lock_hash}" ]] && [[ -f node_modules/.package-lock.sha256 ]] && [[ "$(cat node_modules/.package-lock.sha256)" == "${lock_hash}" ]]; then
    say "Dependencies up to date with package-lock.json (${lock_hash:0:12}); running fast install check"
    step_run install echo "dependencies match package-lock.json (${lock_hash:0:12})"
  else
    step_run install npm ci --include=dev
    if [[ -n "${lock_hash}" && -d node_modules ]]; then
      printf '%s\n' "${lock_hash}" > node_modules/.package-lock.sha256
    fi
  fi
else
  progress_mark install skipped
fi

low_mem_host="no"
total_mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 16777216)"
if [[ -z "${COMMAND_LOG:-}" ]] && (( total_mem_kb < 2097152 )); then
  low_mem_host="yes"
fi
PARALLEL_BUILD="${PARALLEL_BUILD:-$([[ "${low_mem_host}" == yes || "${DELEGATED_PRODUCTION_BUILD:-no}" == yes ]] && echo no || echo yes)}"

# Wave 1: run verification checks, browser setup, and Go builds in parallel on multi-core/high-memory hosts.
run_check_step() {
  local step="$1"
  shift
  step_run "${step}" "$@"
}

if [[ "${PARALLEL_BUILD}" != yes ]]; then
  if [[ "${SKIP_TESTS}" != yes ]]; then
    step_run typecheck npm run typecheck
    step_run lint npx eslint apps/player-app/src apps/go-server packages --no-error-on-unmatched-pattern --cache --cache-location .cache/eslintcache
    if [[ "${SKIP_FULL_TESTS}" == yes ]]; then
      say 'Full Vitest suite skipped (SKIP_FULL_TESTS=yes); typecheck and scoped lint remain enabled'
      progress_mark tests skipped
    else
      step_run tests npm run test
    fi
    step_run infra npm run test:infra
    step_run audit npm run check:production-audit
    step_run narration npm run check:narration-coverage
  else
    for step in typecheck lint tests infra audit narration; do progress_mark "${step}" skipped; done
  fi

  if [[ "${SKIP_WEB}" != yes && "${SKIP_WEB_SETUP}" != yes ]]; then
    say 'Installing/verifying browser dependencies sequentially on low-memory host'
    step_run browser npm run setup:web-browser
  else
    progress_mark browser skipped
  fi

  say "Building linux/${BUILD_ARCH} server artifacts"
  server_status=0
  migrate_status=0
  build_server_artifacts() {
    env BUILD_ARCH="${BUILD_ARCH}" npm run build:server:local || return "$?"
    env BUILD_ARCH="${BUILD_ARCH}" npm run build:gateway:local
  }
  progress_run server build_server_artifacts || server_status="$?"
  progress_run migrate env BUILD_ARCH="${BUILD_ARCH}" npm run build:migrate:local || migrate_status="$?"
  (( server_status == 0 )) || die 'server build failed'
  (( migrate_status == 0 )) || die 'migration build failed'
else
  say "Running verification checks and linux/${BUILD_ARCH} Go builds in parallel"
  typecheck_pid=""; typecheck_status=0
  lint_pid=""; lint_status=0
  tests_pid=""; tests_status=0
  infra_pid=""; infra_status=0
  audit_pid=""; audit_status=0
  narration_pid=""; narration_status=0
  browser_pid=""; browser_status=0
  server_pid=""; server_status=0
  migrate_pid=""; migrate_status=0

  if [[ "${SKIP_TESTS}" != yes ]]; then
    ( step_run typecheck npm run typecheck ) & typecheck_pid="$!"
    ( step_run lint npx eslint apps/player-app/src apps/go-server packages --no-error-on-unmatched-pattern --cache --cache-location .cache/eslintcache ) & lint_pid="$!"
    if [[ "${SKIP_FULL_TESTS}" == yes ]]; then
      say 'Full Vitest suite skipped (SKIP_FULL_TESTS=yes); typecheck and scoped lint remain enabled'
      progress_mark tests skipped
    else
      ( step_run tests npm run test ) & tests_pid="$!"
    fi
    ( step_run infra npm run test:infra ) & infra_pid="$!"
    ( step_run audit npm run check:production-audit ) & audit_pid="$!"
    ( step_run narration npm run check:narration-coverage ) & narration_pid="$!"
  else
    for step in typecheck lint tests infra audit narration; do progress_mark "${step}" skipped; done
  fi

  if [[ "${SKIP_WEB}" != yes && "${SKIP_WEB_SETUP}" != yes ]]; then
    ( step_run browser npm run setup:web-browser ) & browser_pid="$!"
  else
    progress_mark browser skipped
  fi

  build_server_artifacts() {
    local s_pid="" g_pid="" s_rc=0 g_rc=0
    ( env BUILD_ARCH="${BUILD_ARCH}" npm run build:server:local ) & s_pid="$!"
    ( env BUILD_ARCH="${BUILD_ARCH}" npm run build:gateway:local ) & g_pid="$!"
    wait "${s_pid}" || s_rc="$?"
    wait "${g_pid}" || g_rc="$?"
    (( s_rc == 0 )) || return "${s_rc}"
    return "${g_rc}"
  }
  ( progress_run server build_server_artifacts ) & server_pid="$!"
  ( progress_run migrate env BUILD_ARCH="${BUILD_ARCH}" npm run build:migrate:local ) & migrate_pid="$!"

  [[ -z "${typecheck_pid}" ]] || wait "${typecheck_pid}" || typecheck_status="$?"
  [[ -z "${lint_pid}" ]] || wait "${lint_pid}" || lint_status="$?"
  [[ -z "${tests_pid}" ]] || wait "${tests_pid}" || tests_status="$?"
  [[ -z "${infra_pid}" ]] || wait "${infra_pid}" || infra_status="$?"
  [[ -z "${audit_pid}" ]] || wait "${audit_pid}" || audit_status="$?"
  [[ -z "${narration_pid}" ]] || wait "${narration_pid}" || narration_status="$?"
  [[ -z "${browser_pid}" ]] || wait "${browser_pid}" || browser_status="$?"
  wait "${server_pid}" || server_status="$?"
  wait "${migrate_pid}" || migrate_status="$?"

  # Reap every parallel job before exiting, including when one fails.
  (( typecheck_status == 0 )) || die 'typecheck failed'
  (( lint_status == 0 )) || die 'lint failed'
  (( tests_status == 0 )) || die 'tests failed'
  (( infra_status == 0 )) || die 'infra tests failed'
  (( audit_status == 0 )) || die 'production audit failed'
  (( narration_status == 0 )) || die 'narration coverage failed'
  (( browser_status == 0 )) || die 'browser dependency setup failed'
  (( server_status == 0 )) || die 'server build failed'
  (( migrate_status == 0 )) || die 'migration build failed'
fi

if [[ "${SKIP_WEB}" != yes ]]; then
  # The Coach's browser engine is on in the web build (app ADR 2026-10-22); chessd's slot unit turns on its side.
  step_run web env EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN="${EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN}" \
    EXPO_PUBLIC_COACH5_BROWSER_ENGINE="${EXPO_PUBLIC_COACH5_BROWSER_ENGINE:-true}" npm run build:web
  if [[ "${SKIP_BUDGETS}" == yes ]]; then
    say 'Performance/bundle budgets skipped (SKIP_BUDGETS=yes)'
    progress_mark performance skipped
    progress_mark bundle skipped
  elif [[ "${PARALLEL_BUILD}" == yes ]]; then
    perf_pid=""; perf_status=0
    bundle_pid=""; bundle_status=0
    ( step_run performance npm run check:performance ) & perf_pid="$!"
    ( step_run bundle npm run check:bundle ) & bundle_pid="$!"
    wait "${perf_pid}" || perf_status="$?"
    wait "${bundle_pid}" || bundle_status="$?"
    (( perf_status == 0 )) || die 'performance budget failed'
    (( bundle_status == 0 )) || die 'bundle budget failed'
  else
    step_run performance npm run check:performance
    step_run bundle npm run check:bundle
  fi
else
  for step in web performance bundle; do progress_mark "${step}" skipped; done
fi

if [[ "${SKIP_ASSETS}" != yes ]]; then
  progress_mark assets running
  run env ASSETS_MIRROR_DELETE="${ASSETS_MIRROR_DELETE:-report}" \
    ASSETS_MIRROR_FORCE="${ASSETS_MIRROR_FORCE:-no}" "${CI_ROOT_DIR}/content/sync-assets.sh" all --mirror
  run "${CI_ROOT_DIR}/content/sync-audio-handoffs.sh"
  run ./infra/oci/sync-assets.sh verify
  progress_mark assets done
else
  progress_mark assets skipped
fi

if [[ "${SKIP_CONTENT}" != yes ]]; then
  progress_mark content running
  [[ -f "apps/go-server/chessd-migrate-linux-${BUILD_ARCH}" ]] || die "content publish requires the linux/${BUILD_ARCH} migration binary"
  run env SOURCE_ROOT="${ROOT_DIR}" OCI_HOST="${DEPLOY_HOST}" OCI_USER="${DEPLOY_USER}" \
    SSH_KEY="${DEPLOY_SSH_KEY}" PUBLIC_URL="${PUBLIC_URL}" \
    MIGRATE_BIN="${ROOT_DIR}/apps/go-server/chessd-migrate-linux-${BUILD_ARCH}" \
    CONTENT_PRUNE="${CONTENT_PRUNE:-report}" \
    "${CI_ROOT_DIR}/content/publish-content.sh"
  progress_mark content done
else
  progress_mark content skipped
fi

# After publishing, a production code release must prove that the
# exact required motions, bodies and cast bindings are already publicly available.
# A healthy app process alone does not prove that capture previews can play.
if [[ "${SKIP_DEPLOY}" != yes ]]; then
  step_run content_readiness env SOURCE_ROOT="${SOURCE_DIR}" PUBLIC_URL="${PUBLIC_URL}" \
    node "${CI_ROOT_DIR}/release/content-readiness.mjs"
else
  progress_mark content_readiness skipped
fi

if [[ "${SKIP_DEPLOY}" == yes ]]; then
  say 'Build complete; deployment skipped (SKIP_DEPLOY=yes)'
  progress_mark deploy skipped
  progress_mark health skipped
else
  if [[ "${DEPLOY_REMOTE}" == yes ]]; then
    say "Deploying (${DEPLOY_TARGET}) from this build host to ${DEPLOY_USER}@${DEPLOY_HOST}"
    env LOCAL_DEPLOY=no TARGET_ARCH="${BUILD_ARCH}" OCI_HOST="${DEPLOY_HOST}" OCI_USER="${DEPLOY_USER}" \
      DEPLOY_TARGET="${DEPLOY_TARGET}" PREPROD_URL="${PREPROD_URL:-}" \
      DEPLOY_POD_HOSTS="${DEPLOY_POD_HOSTS:-}" OKE_DEPLOY_ENABLED="${OKE_DEPLOY_ENABLED:-no}" \
      SSH_KEY="${DEPLOY_SSH_KEY}" SKIP_BUILD=yes SKIP_WEB="${SKIP_WEB}" \
      PUBLIC_URL="${PUBLIC_URL}" SOURCE_ROOT="${SOURCE_DIR}" CI_ROOT="${CI_ROOT_DIR}" "${CI_ROOT_DIR}/release/deploy-chessd.sh"
  else
    say "Deploying (${DEPLOY_TARGET}) locally on this host (no SSH, Jenkins, or Cloud Build)"
    env LOCAL_DEPLOY=yes TARGET_ARCH="${BUILD_ARCH}" \
      DEPLOY_TARGET="${DEPLOY_TARGET}" PREPROD_URL="${PREPROD_URL:-}" \
      DEPLOY_POD_HOSTS="${DEPLOY_POD_HOSTS:-}" OKE_DEPLOY_ENABLED="${OKE_DEPLOY_ENABLED:-no}" \
      SKIP_BUILD=yes SKIP_WEB="${SKIP_WEB}" \
      PUBLIC_URL="${PUBLIC_URL}" SOURCE_ROOT="${SOURCE_DIR}" CI_ROOT="${CI_ROOT_DIR}" "${CI_ROOT_DIR}/release/deploy-chessd.sh"
  fi
fi

say 'Local release complete'
