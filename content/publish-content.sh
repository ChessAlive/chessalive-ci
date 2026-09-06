#!/usr/bin/env bash
#
# Publish committed content (content/uploads + content/catalog) to the OCI box.
#
# This is the "content by commit" step of the release job. Before it existed, hero GLBs and the
# catalog records that name them were carried to prod by hand (scripts/publish-ivory-combos/README.md)
# — the deploy ships code, never data/uploads, so a new hero never reached players unless somebody
# remembered the scp + chessd-migrate dance. Now the dance is: stage → commit → chessalive-release.
#
# Order of operations, and why:
#   (a) files first. Until the catalog names them the new files are inert bytes nobody requests,
#       so the publish is safe to interrupt anywhere before the catalog write. Files are compared
#       by sha256 against what the box already serves: identical → skip, missing → install,
#       DIFFERENT → the release FAILS. /uploads/<name> is immutable (service worker + Cloudflare);
#       a name reused for new bytes would be served stale forever, so it is never installed.
#   (b) the inventory of the uploads dir after install is the ground truth for "which GLBs exist".
#   (c) merge the committed slices into prod's LIVE catalog (chessd-migrate replaces arrays
#       wholesale, so it must be handed the complete document). If prod already carries every
#       record we own → NOOP, exit 0, nothing written — a release with no content change costs
#       nothing and bumps no ETag.
#   (d) chessd-migrate --dry-run on the box, then for real: the ONLY write, and it bumps
#       appStateRevision so the /catalog/state ETag changes and clients refetch. Right before the
#       write the live revision is re-read: the document was merged from the catalog fetched in
#       (c), and writing it over a revision that moved meanwhile (a Studio publish) would silently
#       undo that publish — so the run aborts and asks to be re-run instead.
#   (e) prove it from the outside: the public catalog reports the new revision, the ETag changed,
#       and a second merge against it is a NOOP.
#   (f) PRUNE the uploads dir. The catalog is authoritative for the sets this repo owns
#       (merge-catalog.mjs), so a file of an owned family that no record references any more, and
#       that the commit is not shipping, is dead weight on a 3 GB box. scripts/content/prune-plan.mjs
#       computes the list (it is the only thing that decides what may go); this script only executes
#       it, re-checking every name against the merged document one more time before rm. It refuses
#       to delete anything at all when the list is longer than CONTENT_PRUNE_MAX — a big deletion is
#       a decision, not a side effect. The immutable-name law is untouched: bytes under a name are
#       never rewritten. Deleting is safe because a client on a stale catalog that asks for a gone
#       file gets a 404 and the ceremony falls back until it picks up the new /catalog/state ETag.
#
# Usage:
#   infra/oci/publish-content.sh             # publish
#   infra/oci/publish-content.sh --dry-run   # everything up to and including the migrate dry-run;
#                                            # nothing is installed, nothing is written
# Env (same names as deploy-chessd.sh): OCI_HOST OCI_USER SSH_KEY REMOTE_ROOT PUBLIC_URL
#   UPLOAD_DIR   remote uploads dir (default REMOTE_ROOT/data/uploads = CHESSALIVE_UPLOAD_DIR)
#   CONTENT_PRUNE      apply (default) | report — whether step (f) deletes or only prints
#   CONTENT_PRUNE_MAX  refuse to delete more than this many files in one run (default 40)
#   MIGRATE_BIN  path to a prebuilt linux/arm64 chessd-migrate (skips the go build), or "remote"
#                to use the copy every code release installs at REMOTE_ROOT/bin/chessd-migrate
#                (deploy-chessd.sh). Unset + no `go` on this agent = remote, so the content lane
#                on the free-tier CI box never compiles anything.
#
# Never transports a secret: run-migrate.sh loads /etc/chessalive.env ON the box.
#
set -euo pipefail

SOURCE_ROOT="${SOURCE_ROOT:-/opt/chessalive}"
ROOT_DIR="${SOURCE_ROOT}"

OCI_HOST="${OCI_HOST:-144.24.117.171}"
OCI_USER="${OCI_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/chessalive}"
UPLOAD_DIR="${UPLOAD_DIR:-${REMOTE_ROOT}/data/uploads}"
PUBLIC_URL="${PUBLIC_URL:-https://chessalive.com}"
MIGRATE_BIN="${MIGRATE_BIN:-}"
CONTENT_PRUNE="${CONTENT_PRUNE:-apply}"
# Set when the prune hit its cap: the run succeeds (the content is published) and the caller is told,
# so a release can go UNSTABLE rather than FAILURE. Read by the exit code below.
PRUNE_REFUSED=""
CONTENT_PRUNE_MAX="${CONTENT_PRUNE_MAX:-40}"
case "${CONTENT_PRUNE}" in
  apply|report) ;;
  *) printf '\033[31m✖ CONTENT_PRUNE must be apply or report, got: %s\033[0m\n' "${CONTENT_PRUNE}" >&2; exit 2 ;;
esac
[[ "${CONTENT_PRUNE_MAX}" =~ ^[0-9]+$ ]] || { printf '\033[31m✖ CONTENT_PRUNE_MAX must be a number, got: %s\033[0m\n' "${CONTENT_PRUNE_MAX}" >&2; exit 2; }
DRY_RUN=""
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=yes ;;
    *) printf '\033[31m✖ unknown argument: %s\033[0m\n' "${arg}" >&2; exit 2 ;;
  esac
done

CONTENT_UPLOADS="${ROOT_DIR}/content/uploads"
CONTENT_CATALOG="${ROOT_DIR}/content/catalog"
RUN_MIGRATE_SRC="${ROOT_DIR}/scripts/publish-ivory-combos/run-migrate.sh"

SSH_OPTS=(-o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
[[ -n "${SSH_KEY}" ]] && SSH_OPTS+=(-i "${SSH_KEY}")

remote() { ssh "${SSH_OPTS[@]}" "${OCI_USER}@${OCI_HOST}" "$@"; }

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── (f) File prune ───────────────────────────────────────────────────────────────────────────────
# prune_files <catalog-doc.json> <apply|report>
# The document handed in is the one prod holds AFTER this run: the merged doc when the catalog was
# written, prod's own catalog when the merge was a NOOP. Every decision lives in prune-plan.mjs;
# this executes it. Nothing is deleted in report mode, and nothing at all is deleted when the plan
# refuses (too many candidates, or a candidate the plan itself can still see referenced).
prune_files() {
  local doc="$1" mode="$2" list rc name gone=0
  list="${WORK}/prune-list.txt"
  say "Pruning ${UPLOAD_DIR} (${mode}, cap ${CONTENT_PRUNE_MAX})"
  set +e
  ( cd "${ROOT_DIR}" && node scripts/content/prune-plan.mjs "${doc}" "${INVENTORY}" \
      --out "${list}" --max "${CONTENT_PRUNE_MAX}" )
  rc=$?
  set -e
  if [[ "${rc}" -eq 4 ]]; then
    if [[ "${mode}" == "report" ]]; then
      echo "(report mode: the refusal above is informational — nothing was going to be deleted)"
      return 0
    fi
    # NOT fatal. By the time the prune runs, the content is published and (in a release) the new
    # binary and bundle are about to deploy or already have. Deleting superseded files is
    # housekeeping: refusing it is the cap doing its job, and failing the whole release over
    # housekeeping would turn a safety net into an outage of the one-click promise. Say it loudly,
    # leave the files, and let the caller decide — the release lane marks the build UNSTABLE on
    # exit code 4 so it is visible in the job list without being red.
    printf '\033[33m! prune refused (see the list above) — NOTHING was deleted, and the content IS published.\033[0m\n' >&2
    printf '  Raise CONTENT_PRUNE_MAX with that list in front of you to clear the backlog in one run,\n' >&2
    printf '  or leave it: the next release reports the same list again and changes nothing.\n' >&2
    PRUNE_REFUSED=yes
    return 0
  fi
  [[ "${rc}" -eq 0 ]] || die "prune-plan.mjs failed (exit ${rc})"
  if [[ ! -s "${list}" ]]; then
    echo "nothing to prune"
    return 0
  fi
  if [[ "${mode}" == "report" ]]; then
    echo "report mode — $(grep -c . "${list}") file(s) would be deleted; nothing was removed"
    return 0
  fi
  # An independent second opinion, in a different language, on the exact bytes about to be deleted:
  # the merged document must not contain the name anywhere. A JSON string always ends at a quote,
  # so the closing quote keeps "…v1.glb" from matching "…v1.glb.bak". Three shapes are checked,
  # matching prune-plan.mjs: the canonical "/uploads/<path>", the bare relative path, and the bare
  # basename — the `fileName` field the Studio writes beside every `path`. A false positive here
  # only ever keeps a file, which is the safe direction for a disagreement.
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    [[ "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "${name}" != *".."* ]] \
      || die "refusing to delete a suspicious name: ${name}"
    for probe in "/uploads/${name}\"" "\"${name}\"" "\"${name##*/}\""; do
      ! grep -qF -- "${probe}" "${doc}" \
        || die "${name} IS referenced by the merged catalog (matched ${probe}) — prune-plan and this re-check disagree; nothing deleted"
    done
  done < "${list}"
  scp "${SSH_OPTS[@]}" -q "${list}" "${OCI_USER}@${OCI_HOST}:${STAGE}/prune-list.txt"
  remote "UPLOAD_DIR='${UPLOAD_DIR}' LIST='${STAGE}/prune-list.txt' bash -s" <<'REMOTE_PRUNE'
set -euo pipefail
deleted=0; missing=0
while IFS= read -r name; do
  [ -n "${name}" ] || continue
  dst="${UPLOAD_DIR}/${name}"
  if sudo -n test -e "${dst}"; then
    sudo -n rm -f "${dst}"
    if sudo -n test -e "${dst}"; then echo "✖ still present after rm: ${name}" >&2; exit 1; fi
    echo "deleted        ${name}"; deleted=$((deleted + 1))
  else
    echo "already gone   ${name}"; missing=$((missing + 1))
  fi
done < "${LIST}"
echo "pruned: ${deleted} deleted, ${missing} already gone"
REMOTE_PRUNE
  gone="$(grep -c . "${list}")"
  echo "prune complete — ${gone} file(s) no longer on the box"
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="/tmp/content-stage-${STAMP}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/publish-content.XXXXXX")"
cleanup() {
  rm -rf "${WORK}"
  # Best effort: what is left behind is harmless, but do not litter /tmp on the box.
  remote "rm -rf '${STAGE}' /tmp/chessd-migrate /tmp/run-migrate.sh" 2>/dev/null || true
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────────────────────────────────
say "Preflight${DRY_RUN:+ (DRY RUN — nothing will be installed or written)}"
[[ -d "${CONTENT_CATALOG}" ]] || die "${CONTENT_CATALOG} missing — run 'npm run content:export' and commit"
[[ -f "${CONTENT_UPLOADS}/SHA256SUMS" ]] || die "${CONTENT_UPLOADS}/SHA256SUMS missing — run 'npm run content:stage -- <file>' and commit"
[[ -f "${RUN_MIGRATE_SRC}" ]] || die "${RUN_MIGRATE_SRC} missing"
command -v rsync >/dev/null || die "rsync is not installed on this agent"
command -v node >/dev/null || die "node is not on PATH"
remote true || die "cannot ssh to ${OCI_USER}@${OCI_HOST}"
remote "command -v sha256sum >/dev/null && command -v rsync >/dev/null" || die "the box lacks sha256sum or rsync"
remote "sudo -n test -d '${UPLOAD_DIR}'" || die "${UPLOAD_DIR} does not exist on the box (CHESSALIVE_UPLOAD_DIR)"
remote "sudo -n test -s /etc/chessalive.env" || die "/etc/chessalive.env missing on the box — run 'sudo chessalive-pull-secrets.sh' there"
echo "host reachable, uploads dir present, env file present"
echo "content: $(ls "${CONTENT_CATALOG}"/*.json | wc -l | tr -d ' ') slice(s), $(grep -c . "${CONTENT_UPLOADS}/SHA256SUMS") staged file(s)"

# ── (a) Files ────────────────────────────────────────────────────────────────────────────────────
say "Uploading content/uploads to ${STAGE}"
remote "mkdir -p '${STAGE}'"
# -rlt: recurse, keep symlinks as symlinks, keep mtimes; --checksum: never trust size+mtime for
# the "already there" decision. No -a: owner/group/mode on the box are decided by install(1).
rsync -rlt --checksum -e "ssh ${SSH_OPTS[*]}" "${CONTENT_UPLOADS}/" "${OCI_USER}@${OCI_HOST}:${STAGE}/"

say "Installing files into ${UPLOAD_DIR}${DRY_RUN:+ (dry run: reporting only)}"
INSTALL_LOG="${WORK}/install.log"
remote "STAGE='${STAGE}' UPLOAD_DIR='${UPLOAD_DIR}' DRY_RUN='${DRY_RUN}' bash -s" <<'REMOTE_SCRIPT' | tee "${INSTALL_LOG}"
set -euo pipefail
cd "${STAGE}"
# The transfer itself is proven against the committed manifest before anything is installed.
sha256sum -c --quiet SHA256SUMS || { echo "✖ staged files do not match SHA256SUMS — transfer corrupt" >&2; exit 1; }
install=0; skip=0; conflict=0
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  want="${line%%  *}"; name="${line#*  }"
  dst="${UPLOAD_DIR}/${name}"
  if sudo -n test -f "${dst}"; then
    have="$(sudo -n sha256sum "${dst}" | cut -d' ' -f1)"
    if [[ "${have}" == "${want}" ]]; then
      echo "identical      ${name}"; skip=$((skip + 1))
    else
      echo "✖ CONFLICT     ${name}: prod has ${have:0:12}…, commit has ${want:0:12}… — /uploads names are immutable; ship a new version" >&2
      conflict=$((conflict + 1))
    fi
  elif [[ -n "${DRY_RUN}" ]]; then
    echo "would install  ${name}"; install=$((install + 1))
  else
    sudo -n install -D -o chessalive -g chessalive -m 0644 "${STAGE}/${name}" "${dst}"
    got="$(sudo -n sha256sum "${dst}" | cut -d' ' -f1)"
    [[ "${got}" == "${want}" ]] || { echo "✖ ${name}: sha256 mismatch after install" >&2; exit 1; }
    echo "installed      ${name}  (sha256 verified)"; install=$((install + 1))
  fi
done < SHA256SUMS
echo "files: ${install} ${DRY_RUN:+would-}install, ${skip} identical, ${conflict} conflict"
[[ "${conflict}" -eq 0 ]] || { echo "✖ ${conflict} filename(s) reused with different bytes — nothing more is published" >&2; exit 1; }
REMOTE_SCRIPT

# ── (b) Inventory ────────────────────────────────────────────────────────────────────────────────
say "Prod inventory"
INVENTORY="${WORK}/prod-inventory.txt"
# Paths relative to the uploads dir, recursively, so a staged sub-directory name (thumbs/x.png)
# compares like-for-like with the manifest.
remote "find '${UPLOAD_DIR}' -type f -printf '%P\\n'" | sort > "${INVENTORY}"
echo "$(grep -c . "${INVENTORY}") files in ${UPLOAD_DIR}"

say "Content gate against the inventory"
( cd "${ROOT_DIR}" && node scripts/content/verify.mjs --inventory "${INVENTORY}" ) || die "content verify failed"

# ── (c) Merge ────────────────────────────────────────────────────────────────────────────────────
say "Merging slices into the live catalog"
PROD_BEFORE="${WORK}/prod-catalog.before.json"
DOC="${WORK}/migrate-doc.json"
curl -fsS --max-time 30 -H 'Cache-Control: no-cache' "${PUBLIC_URL}/catalog/state" -o "${PROD_BEFORE}" \
  || die "cannot fetch ${PUBLIC_URL}/catalog/state"
REV_BEFORE="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).appStateRevision))' "${PROD_BEFORE}")"
ETAG_BEFORE="$(curl -fsSI --max-time 30 -H 'Cache-Control: no-cache' "${PUBLIC_URL}/catalog/state" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
echo "prod appStateRevision ${REV_BEFORE}, ETag ${ETAG_BEFORE:-?}"
set +e
( cd "${ROOT_DIR}" && node scripts/content/merge-catalog.mjs "${PROD_BEFORE}" "${INVENTORY}" "${DOC}" )
merge_rc=$?
set -e
if [[ "${merge_rc}" -eq 3 ]]; then
  say "NOOP — prod already carries this commit's content; catalog untouched"
  # Still prune: the catalog can be identical while the uploads dir carries files no record names
  # any more (an earlier release published the catalog change and stopped short of the files).
  # In a dry run this only ever reports.
  prune_files "${PROD_BEFORE}" "$([[ -n "${DRY_RUN}" ]] && echo report || echo "${CONTENT_PRUNE}")"
  [[ -n "${PRUNE_REFUSED}" ]] && exit 4
  exit 0
fi
[[ "${merge_rc}" -eq 0 ]] || die "merge-catalog failed (exit ${merge_rc})"

# ── (d) chessd-migrate ───────────────────────────────────────────────────────────────────────────
REMOTE_BIN="/tmp/chessd-migrate"
if [[ -z "${MIGRATE_BIN}" ]] && ! command -v go >/dev/null 2>&1; then
  echo "no go toolchain on this agent — using the box's own chessd-migrate (MIGRATE_BIN=remote)"
  MIGRATE_BIN=remote
fi
if [[ "${MIGRATE_BIN}" == "remote" ]]; then
  # Shipped by deploy-chessd.sh with every code release, so it is always the persistence code the
  # running server was built from. Nothing is compiled or uploaded here.
  REMOTE_BIN="${REMOTE_ROOT}/bin/chessd-migrate"
  say "Using the box's chessd-migrate: ${REMOTE_BIN}"
  remote "sudo -n test -x '${REMOTE_BIN}'" \
    || die "${REMOTE_BIN} is not on the box — run a code release (deploy-chessd.sh installs it) or set MIGRATE_BIN to a local build"
  MIGRATE_BIN=""
elif [[ -n "${MIGRATE_BIN}" ]]; then
  say "Using prebuilt chessd-migrate: ${MIGRATE_BIN}"
  [[ -f "${MIGRATE_BIN}" ]] || die "MIGRATE_BIN=${MIGRATE_BIN} does not exist"
else
  say "Building chessd-migrate (linux/arm64, static)"
  MIGRATE_BIN="${WORK}/chessd-migrate"
  ( cd "${ROOT_DIR}/apps/go-server" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o "${MIGRATE_BIN}" ./cmd/chessd-migrate )
fi
if [[ -n "${MIGRATE_BIN}" ]]; then
  command -v file >/dev/null || die "file(1) is not installed on this agent (needed to check the binary)"
  file "${MIGRATE_BIN}" | grep -q "ARM aarch64" || die "${MIGRATE_BIN} is not an arm64 ELF binary"
fi

say "Uploading ${MIGRATE_BIN:+migrate binary + }document"
REMOTE_DOC="${STAGE}/migrate-doc.json"
REMOTE_RUNNER="/tmp/run-migrate.sh"
if [[ -n "${MIGRATE_BIN}" ]]; then
  scp "${SSH_OPTS[@]}" -q "${MIGRATE_BIN}" "${OCI_USER}@${OCI_HOST}:${REMOTE_BIN}"
  remote "chmod +x '${REMOTE_BIN}'"
fi
scp "${SSH_OPTS[@]}" -q "${DOC}" "${OCI_USER}@${OCI_HOST}:${REMOTE_DOC}"
scp "${SSH_OPTS[@]}" -q "${RUN_MIGRATE_SRC}" "${OCI_USER}@${OCI_HOST}:${REMOTE_RUNNER}"
remote "chmod +x '${REMOTE_RUNNER}'"
MIGRATE_ARGS="--key app:state --file ${REMOTE_DOC} --only animationClips,animationSets,pieceSets,appStateRevision"
# The runner execs CHESSD_MIGRATE_BIN; sudo -n env … keeps that one variable across the privilege hop.
RUN_MIGRATE="sudo -n env CHESSD_MIGRATE_BIN='${REMOTE_BIN}' '${REMOTE_RUNNER}'"

say "chessd-migrate --dry-run"
remote "${RUN_MIGRATE} ${MIGRATE_ARGS} --dry-run" || die "chessd-migrate --dry-run failed on the box"

if [[ -n "${DRY_RUN}" ]]; then
  # report, never apply: a dry run deletes nothing, it only says what a publish would delete.
  prune_files "${DOC}" report
  say "DRY RUN complete — nothing installed, catalog not written, nothing pruned (would have gone ${REV_BEFORE} -> $((REV_BEFORE + 1)))"
  exit 0
fi

say "Re-checking the live revision before the write"
PROD_NOW="${WORK}/prod-catalog.now.json"
curl -fsS --max-time 30 -H 'Cache-Control: no-cache' "${PUBLIC_URL}/catalog/state" -o "${PROD_NOW}" \
  || die "cannot re-fetch ${PUBLIC_URL}/catalog/state"
REV_NOW="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).appStateRevision))' "${PROD_NOW}")"
[[ "${REV_NOW}" == "${REV_BEFORE}" ]] \
  || die "prod appStateRevision moved ${REV_BEFORE} -> ${REV_NOW} while this run was preparing the write (a Studio publish?) — nothing written; re-run the release so the merge starts from the live catalog"
echo "still at appStateRevision ${REV_BEFORE}"

say "chessd-migrate (writing app:state)"
remote "${RUN_MIGRATE} ${MIGRATE_ARGS}" || die "chessd-migrate FAILED — the catalog write did not happen; files already installed are inert"

# ── (e) Prove it from outside ────────────────────────────────────────────────────────────────────
say "Verifying the public catalog"
REV_AFTER=""
ETAG_AFTER=""
PROD_AFTER="${WORK}/prod-catalog.after.json"
# /catalog/state is cacheable for 30s (public, max-age=30), so allow the edge to catch up.
for i in $(seq 1 20); do
  curl -fsS --max-time 30 -H 'Cache-Control: no-cache' "${PUBLIC_URL}/catalog/state" -o "${PROD_AFTER}" || true
  REV_AFTER="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).appStateRevision))}catch{process.stdout.write("")}' "${PROD_AFTER}")"
  if [[ "${REV_AFTER}" == "$((REV_BEFORE + 1))" ]]; then break; fi
  sleep 3
done
[[ "${REV_AFTER}" == "$((REV_BEFORE + 1))" ]] \
  || die "public catalog still reports appStateRevision ${REV_AFTER:-?} (expected $((REV_BEFORE + 1))) — write not visible"
ETAG_AFTER="$(curl -fsSI --max-time 30 -H 'Cache-Control: no-cache' "${PUBLIC_URL}/catalog/state" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
[[ -n "${ETAG_AFTER}" && "${ETAG_AFTER}" != "${ETAG_BEFORE}" ]] || die "ETag did not change (${ETAG_BEFORE} -> ${ETAG_AFTER:-?}) — clients would never refetch"
echo "appStateRevision ${REV_BEFORE} -> ${REV_AFTER}, ETag ${ETAG_BEFORE} -> ${ETAG_AFTER}"

set +e
( cd "${ROOT_DIR}" && node scripts/content/merge-catalog.mjs "${PROD_AFTER}" "${INVENTORY}" "${WORK}/should-be-noop.json" >/dev/null )
noop_rc=$?
set -e
[[ "${noop_rc}" -eq 3 ]] || die "re-merge against the published catalog is not a NOOP (exit ${noop_rc}) — the write did not land as sent"
echo "re-merge is a NOOP: prod now carries exactly what the commit describes"

# (f) Only now, with the new catalog live and proven, may files disappear.
prune_files "${DOC}" "${CONTENT_PRUNE}"

say "Content published"

# 4 = published, but the file prune hit its cap and deleted nothing (see the list above). Anything
# that actually failed has already exited non-zero through die().
[[ -n "${PRUNE_REFUSED}" ]] && exit 4
exit 0
