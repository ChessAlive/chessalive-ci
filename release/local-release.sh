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

  local checkout
  checkout="$(mktemp -d "${TMPDIR:-/tmp}/chessalive-source.XXXXXX")"
  say "Synchronizing ${SOURCE_GIT_URL} @ ${SOURCE_GIT_REF}"
  if [[ -n "${SOURCE_SSH_KEY}" ]]; then
    [[ -r "${SOURCE_SSH_KEY}" ]] || die "SOURCE_SSH_KEY is not readable: ${SOURCE_SSH_KEY}"
    export GIT_SSH_COMMAND="ssh -i ${SOURCE_SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  fi

  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    say "Updating persistent release checkout"
    git -C "${SOURCE_DIR}" remote set-url origin "${SOURCE_GIT_URL}" 2>/dev/null || git -C "${SOURCE_DIR}" remote add origin "${SOURCE_GIT_URL}"
    git -C "${SOURCE_DIR}" fetch --quiet --prune --depth=1 origin "${SOURCE_GIT_REF}"
    git -C "${SOURCE_DIR}" reset --hard --quiet "origin/${SOURCE_GIT_REF}"
    git -C "${SOURCE_DIR}" clean -fd -e node_modules/ -e apps/player-app/dist/ -e 'apps/go-server/chessd-linux-*' -e 'apps/go-server/chessd-migrate-linux-*' >/dev/null
    git -C "${SOURCE_DIR}" rev-parse HEAD > "${SOURCE_COMMIT_FILE}"
    git -C "${SOURCE_DIR}" log -1 --format=%s > "${SOURCE_COMMIT_MESSAGE_FILE}"
    git -C "${SOURCE_DIR}" log -1 --format=%aI > "${SOURCE_COMMIT_DATE_FILE}"
    echo "source checkout: $(cut -c1-12 "${SOURCE_COMMIT_FILE}")"
    return 0
  fi

  git clone --quiet --depth=1 --branch "${SOURCE_GIT_REF}" "${SOURCE_GIT_URL}" "${checkout}/repo"

  # Keep generated dependencies, build output, and content-addressed image cache local, but delete
  # stale tracked source files. The cache survives normal git clean (it is ignored), and must also
  # survive this rsync fallback when the checkout has to be recreated.
  rsync -a --delete \
    --exclude node_modules/ \
    --exclude apps/player-app/dist/ \
    --exclude '/.cache/squoosh-webp-v1/' \
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
SKIP_CONTENT="${SKIP_CONTENT:-yes}"
SKIP_INSTALL="${SKIP_INSTALL:-no}"
SKIP_DEPLOY="${SKIP_DEPLOY:-no}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-no}"
DEPLOY_HOST="${DEPLOY_HOST:-144.24.117.171}"
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
  step_run install npm ci --include=dev
else
  progress_mark install skipped
fi

if [[ "${SKIP_TESTS}" != yes ]]; then
  step_run typecheck npm run typecheck
  step_run lint npx eslint apps/player-app/src apps/go-server packages --no-error-on-unmatched-pattern
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

browser_pid=""
if [[ "${SKIP_WEB}" != yes && "${SKIP_WEB_SETUP}" != yes ]]; then
  say 'Installing/verifying browser dependencies in parallel with native builds'
  ( step_run browser npm run setup:web-browser ) &
  browser_pid="$!"
else
  progress_mark browser skipped
fi

say "Building linux/${BUILD_ARCH} server artifacts in parallel"
server_status=0
migrate_status=0
( progress_run server env BUILD_ARCH="${BUILD_ARCH}" npm run build:server:local ) &
server_pid="$!"
( progress_run migrate env BUILD_ARCH="${BUILD_ARCH}" npm run build:migrate:local ) &
migrate_pid="$!"
wait "${server_pid}" || server_status="$?"
wait "${migrate_pid}" || migrate_status="$?"
browser_status=0
if [[ -n "${browser_pid}" ]]; then
  wait "${browser_pid}" || browser_status="$?"
fi
# Reap every parallel job before exiting, including when one build failed.
(( server_status == 0 )) || die 'server build failed'
(( migrate_status == 0 )) || die 'migration build failed'
(( browser_status == 0 )) || die 'browser dependency setup failed'

if [[ "${SKIP_WEB}" != yes ]]; then
  step_run web env EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN="${EXPO_PUBLIC_CHESSALIVE_AUDIO_CDN_ORIGIN}" npm run build:web
  if [[ "${SKIP_BUDGETS}" == yes ]]; then
    say 'Performance/bundle budgets skipped (SKIP_BUDGETS=yes)'
    progress_mark performance skipped
    progress_mark bundle skipped
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
  run env MIGRATE_BIN="${ROOT_DIR}/apps/go-server/chessd-migrate-linux-${BUILD_ARCH}" \
    CONTENT_PRUNE="${CONTENT_PRUNE:-report}" \
    "${CI_ROOT_DIR}/content/publish-content.sh"
  progress_mark content done
else
  progress_mark content skipped
fi

if [[ "${SKIP_DEPLOY}" == yes ]]; then
  say 'Build complete; deployment skipped (SKIP_DEPLOY=yes)'
  progress_mark deploy skipped
  progress_mark health skipped
else
  if [[ "${DEPLOY_REMOTE}" == yes ]]; then
    say "Deploying from this build host to ${DEPLOY_USER}@${DEPLOY_HOST}"
    env LOCAL_DEPLOY=no TARGET_ARCH="${BUILD_ARCH}" OCI_HOST="${DEPLOY_HOST}" OCI_USER="${DEPLOY_USER}" \
      SSH_KEY="${DEPLOY_SSH_KEY}" SKIP_BUILD=yes SKIP_WEB="${SKIP_WEB}" \
      PUBLIC_URL="${PUBLIC_URL}" SOURCE_ROOT="${SOURCE_DIR}" CI_ROOT="${CI_ROOT_DIR}" "${CI_ROOT_DIR}/release/deploy-chessd.sh"
  else
    say 'Deploying locally on this host (no SSH, Jenkins, or Cloud Build)'
    env LOCAL_DEPLOY=yes TARGET_ARCH="${BUILD_ARCH}" SKIP_BUILD=yes SKIP_WEB="${SKIP_WEB}" \
      PUBLIC_URL="${PUBLIC_URL}" SOURCE_ROOT="${SOURCE_DIR}" CI_ROOT="${CI_ROOT_DIR}" "${CI_ROOT_DIR}/release/deploy-chessd.sh"
  fi
fi

say 'Local release complete'
