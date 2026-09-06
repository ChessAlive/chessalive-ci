#!/usr/bin/env bash
#
# Push large static assets to OCI Object Storage so they are not carried by the app bundle or the
# app server.
#
# Two buckets, because the two kinds of asset have different lifecycles:
#   chessalive-audio   coach / lesson / short / ceremony audio  (~835MB, 6.4k files)
#   chessalive-assets  3D models and URL-referenced images      (~14MB, ~60 files)
#
# ⚠️ What this does NOT do — and why. `apps/player-app/src/assets/` is ~128MB of images, but every
# one is pulled in by a Metro `require("@assets/...")` (~758 call sites). Metro inlines and
# content-hashes those into the bundle at build time; they have no stable URL to point a CDN at.
# Moving them would mean rewriting every call site to a URL string plus a loader — a large change
# with real regression risk, not a sync. They stay in the bundle, served with immutable caching.
# Only assets referenced by a root-relative URL string can move, which is what this script covers.
#
# Uploading is idempotent and safe to re-run: --overwrite replaces changed objects and leaves the
# rest.
#
# MIRROR MODE (--mirror, tracked ASSET_DIRS only) — added 2026-09-04 for the one-click release.
#   Plain uploads can only ever add or replace. A file DELETED from the repo stayed in the bucket
#   forever, which is how three `authors/*.html` pages survived the "no personal details on the
#   site" scrub (commit 7882976f0) and stayed publicly readable at the object-storage origin. So
#   the release now mirrors deletions for the tracked dirs: every object under `<dir>/` whose file
#   is not in this checkout is an ORPHAN.
#
#   Audio is NEVER mirrored. Those four dirs are gitignored — they exist only on the authoring Mac,
#   so a checkout that lacks them is normal, not a deletion. Mirroring them from CI would empty
#   835 MB of narration on the first run.
#
#   ASSETS_MIRROR_DELETE=report (DEFAULT) lists the orphans and deletes nothing, exit 0.
#   ASSETS_MIRROR_DELETE=apply   deletes them, one `os object delete` per name so the log names
#                                every key that was touched (bulk-delete can only take a prefix,
#                                which is precisely the blast radius this must not have).
#   Refuses to apply — a report is still printed — when:
#     * the local dir is missing or empty. UNCONDITIONAL: no flag lifts this one. A prefix with no
#       local files at all is a broken checkout, a wrong PUBLIC_DIR or a failed clone far more often
#       than it is a deletion, and "empty the whole prefix" is the one outcome this must never have.
#       To retire a whole dir, delete the objects in the OCI console once and drop it from ASSET_DIRS.
#     * the orphans exceed ASSETS_MIRROR_MAX (200) or ASSETS_MIRROR_MAX_PCT (30) % of the prefix.
#       These two — and only these two — are lifted by ASSETS_MIRROR_FORCE=yes (the release lane's
#       ASSETS_MIRROR_FORCE parameter), which is a decision taken with the list in front of you.
#   A key that does not start with `<dir>/` is refused outright: this script can only ever delete
#   inside the six prefixes it owns, whatever a listing returns.
#
# Usage:
#   infra/oci/sync-assets.sh                     # sync everything (upload only)
#   infra/oci/sync-assets.sh audio               # audio only
#   infra/oci/sync-assets.sh assets              # models/images only
#   infra/oci/sync-assets.sh assets --mirror     # + report orphans (ASSETS_MIRROR_DELETE=apply deletes)
#   infra/oci/sync-assets.sh verify              # assert every manifest URL exists in the bucket
#
# Credentials: the oci CLI's own resolution is used as-is, so OCI_CLI_CONFIG_FILE (and
# OCI_CLI_PROFILE) work — nothing here assumes ~/.oci. Every call is non-interactive: deletes pass
# --force, so the script never blocks on a prompt it cannot see (Cloud Build has no TTY).
#
set -euo pipefail

ROOT_DIR="${SOURCE_ROOT:-/opt/chessalive}"
NAMESPACE="${OCI_NAMESPACE:-bmt2adcjgo0u}"
AUDIO_BUCKET="${AUDIO_BUCKET:-chessalive-audio}"
ASSET_BUCKET="${ASSET_BUCKET:-chessalive-assets}"
PARALLEL="${PARALLEL:-20}"
OCI_BIN="${OCI_BIN:-oci}"
PUBLIC="${PUBLIC_DIR:-${ROOT_DIR}/apps/player-app/public}"

# Mirror knobs (see the MIRROR MODE note in the header).
MIRROR="${MIRROR:-no}"                                    # also set by the --mirror flag
ASSETS_MIRROR_DELETE="${ASSETS_MIRROR_DELETE:-report}"    # report | apply
ASSETS_MIRROR_FORCE="${ASSETS_MIRROR_FORCE:-no}"
ASSETS_MIRROR_MAX="${ASSETS_MIRROR_MAX:-200}"
ASSETS_MIRROR_MAX_PCT="${ASSETS_MIRROR_MAX_PCT:-30}"

# The CLI warns (to stderr, every call) when the config or key file is not 0600. In CI the key is
# written 0600 anyway; on a shared checkout the warning is noise that hides the real output.
export OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING="${OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING:-True}"

die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

command -v "${OCI_BIN}" >/dev/null 2>&1 || die "oci CLI not found. Install it, or set OCI_BIN."

# When the caller points the CLI at an explicit profile (Cloud Build does: a key fetched from
# Secret Manager into a temp path), fail here with a readable message rather than 40 lines of
# Python traceback from the first API call.
if [[ -n "${OCI_CLI_CONFIG_FILE:-}" ]]; then
  [[ -f "${OCI_CLI_CONFIG_FILE}" ]] || die "OCI_CLI_CONFIG_FILE=${OCI_CLI_CONFIG_FILE} does not exist"
  key_file_line="$(sed -n 's/^[[:space:]]*key_file[[:space:]]*=[[:space:]]*//p' "${OCI_CLI_CONFIG_FILE}" | head -1)"
  [[ -n "${key_file_line}" ]] || die "OCI_CLI_CONFIG_FILE has no key_file= line: ${OCI_CLI_CONFIG_FILE}"
  [[ -f "${key_file_line}" ]] || die "the private key named by OCI_CLI_CONFIG_FILE is missing: ${key_file_line}"
  printf 'oci config: %s (profile %s)\n' "${OCI_CLI_CONFIG_FILE}" "${OCI_CLI_PROFILE:-DEFAULT}"
fi

# Directories that are referenced by ROOT-RELATIVE URL strings (never by a Metro require), so they
# can be served from another origin without touching call sites.
AUDIO_DIRS=(lesson-audio coach-audio short-audio ceremony-audio)
ASSET_DIRS=(vault icons voyage guides authors perf-assets)

upload_dir() {
  local bucket="$1" dir="$2" src="${PUBLIC}/$2"
  if [[ ! -d "${src}" ]]; then
    printf '  \033[33m-\033[0m %-16s (absent locally, skipped)\n' "${dir}"
    return 0
  fi
  local count
  count="$(find "${src}" -type f ! -name '.DS_Store' | wc -l | tr -d ' ')"
  if [[ "${count}" == "0" ]]; then
    printf '  \033[33m-\033[0m %-16s (empty, skipped)\n' "${dir}"
    return 0
  fi
  # A deterministic directory fingerprint makes the overwhelmingly common unchanged release a
  # single cheap HEAD request instead of re-sending every byte with --overwrite. The marker lives
  # outside owned asset/audio prefixes, so mirror mode never treats it as user content. A changed
  # file or filename creates a new fingerprint and retains the existing overwrite semantics.
  local digest marker hash_cmd
  if command -v sha256sum >/dev/null 2>&1; then hash_cmd=sha256sum; else hash_cmd="shasum -a 256"; fi
  digest="$(
    cd "${src}"
    while IFS= read -r file; do
      # shellcheck disable=SC2086 # hash_cmd is an intentional command plus fixed arguments.
      ${hash_cmd} "${file}"
    done < <(find . -type f ! -name '.DS_Store' | LC_ALL=C sort)
  )"
  digest="$(printf '%s' "${digest}" | ${hash_cmd} | awk '{print $1}')"
  marker="_release-sync/${dir}-${digest}.complete"
  if "${OCI_BIN}" os object head --namespace "${NAMESPACE}" --bucket-name "${bucket}" \
       --name "${marker}" >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %-16s %s files unchanged (upload skipped)\n' "${dir}" "${count}"
    return 0
  fi
  printf '  → %-16s %s files (%s)\n' "${dir}" "${count}" "$(du -sh "${src}" | cut -f1 | tr -d ' ')"
  "${OCI_BIN}" os object bulk-upload \
    --namespace "${NAMESPACE}" \
    --bucket-name "${bucket}" \
    --src-dir "${src}" \
    --object-prefix "${dir}/" \
    --parallel-upload-count "${PARALLEL}" \
    --exclude '.DS_Store' \
    --overwrite \
    >/dev/null
  local marker_file
  marker_file="$(mktemp)"
  printf '%s\n' "${digest}" > "${marker_file}"
  "${OCI_BIN}" os object put --namespace "${NAMESPACE}" --bucket-name "${bucket}" \
    --name "${marker}" --file "${marker_file}" --content-type text/plain --force >/dev/null
  rm -f "${marker_file}"
  printf '    \033[32m✓\033[0m uploaded to %s/%s/\n' "${bucket}" "${dir}"
}

# ── mirror (tracked ASSET_DIRS only) ─────────────────────────────────────────────────────────────
MIRROR_TMPDIR=""
MIRROR_TOTAL_ORPHANS=0
MIRROR_TOTAL_DELETED=0
MIRROR_REFUSALS=()

# `oci os object list --raw-output` prints a pretty JSON array, one quoted name per line. Peeling
# the quotes with sed keeps names that contain spaces intact — `tr -d ' "[],'` (what `verify` does)
# would silently split them.
list_prefix() {
  local bucket="$1" prefix="$2"
  # LC_ALL=C on BOTH sides of the comparison (here and on the local list) and on comm itself.
  # sort's dedup and comm's merge must agree on collation exactly; under a UTF-8 locale the order
  # of names differing only in punctuation ("a-b.png" vs "ab.png") is not byte order, and a
  # disagreement between the two would show up as an invented orphan — i.e. a deletion. Byte order
  # is the one ordering every agent and every container image agrees on.
  "${OCI_BIN}" os object list \
    --namespace "${NAMESPACE}" --bucket-name "${bucket}" \
    --prefix "${prefix}" --all --query 'data[*].name' --raw-output \
    | sed -n 's/^[[:space:]]*"\(.*\)",\{0,1\}$/\1/p' \
    | LC_ALL=C sort -u
}

# One tracked dir: report (and, only in apply mode, delete) the objects under "<dir>/" that this
# checkout does not have. Never returns non-zero on its own — the caller decides, after every dir
# has been reported, whether the run as a whole failed.
mirror_dir() {
  local bucket="$1" dir="$2" src="${PUBLIC}/$2"
  local t="${MIRROR_TMPDIR}/${dir}"
  mkdir -p "${t}"

  list_prefix "${bucket}" "${dir}/" > "${t}/remote"
  # A prefix listing must only ever return keys under that prefix. If it does not, every count,
  # percentage and cap below is measuring the wrong thing — so stop here, before any of them, and
  # long before the delete loop that would otherwise reach the first name in sorted order.
  local stray
  # `|| true`: grep exits 1 when nothing matches, which under pipefail would abort the script on
  # the ordinary case of a clean listing.
  stray="$( { grep -v -- "^${dir}/" "${t}/remote" || true; } | sed -n '1,5p')"
  if [[ -n "${stray}" ]]; then
    printf '%s\n' "${stray}" | sed 's/^/      /' >&2
    die "the listing for prefix '${dir}/' returned keys outside it (above) — refusing to mirror"
  fi
  local remote_n; remote_n="$(wc -l < "${t}/remote" | tr -d ' ')"

  # An absent or empty local dir is the dangerous case: taken literally it means "delete the whole
  # prefix". A partial checkout, a bad PUBLIC_DIR or a failed clone all look exactly like that, so
  # it is refused unless someone deliberately says otherwise.
  local local_n=0
  if [[ -d "${src}" ]]; then
    ( cd "${src}" && find . -type f ! -name '.DS_Store' | sed "s#^\./#${dir}/#" ) | LC_ALL=C sort -u > "${t}/local"
    local_n="$(wc -l < "${t}/local" | tr -d ' ')"
  else
    : > "${t}/local"
  fi
  if [[ "${local_n}" == "0" ]]; then
    if [[ "${remote_n}" == "0" ]]; then
      printf '  \033[33m-\033[0m %-16s (absent locally and in the bucket, nothing to mirror)\n' "${dir}"
      return 0
    fi
    printf '  \033[33m!\033[0m %-16s local dir is missing/empty — %s bucket object(s) LEFT ALONE\n' "${dir}" "${remote_n}"
    printf '      an incomplete checkout must never empty a prefix — this refusal has no override.\n'
    printf '      To retire the whole dir: delete its objects once in the console, then drop it from ASSET_DIRS.\n'
    MIRROR_REFUSALS+=("${dir}: local dir missing/empty, ${remote_n} object(s) kept")
    return 0
  fi

  LC_ALL=C comm -13 "${t}/local" "${t}/remote" > "${t}/orphans"
  local n; n="$(wc -l < "${t}/orphans" | tr -d ' ')"
  printf '  → %-16s local %-4s bucket %-4s orphan %s\n' "${dir}" "${local_n}" "${remote_n}" "${n}"
  if [[ "${n}" == "0" ]]; then
    return 0
  fi
  sed 's/^/      ✗ /' "${t}/orphans"
  MIRROR_TOTAL_ORPHANS=$((MIRROR_TOTAL_ORPHANS + n))

  if [[ "${ASSETS_MIRROR_DELETE}" != "apply" ]]; then
    printf '      report mode — nothing deleted. Read the list, then re-run with ASSETS_MIRROR_DELETE=apply.\n'
    return 0
  fi

  local pct=$(( n * 100 / remote_n ))
  if [[ "${ASSETS_MIRROR_FORCE}" != "yes" ]]; then
    if [[ "${n}" -gt "${ASSETS_MIRROR_MAX}" ]]; then
      printf '      \033[31mREFUSED\033[0m %s deletions is over ASSETS_MIRROR_MAX=%s — ASSETS_MIRROR_FORCE=yes to override\n' "${n}" "${ASSETS_MIRROR_MAX}"
      MIRROR_REFUSALS+=("${dir}: ${n} orphans > ASSETS_MIRROR_MAX=${ASSETS_MIRROR_MAX}")
      return 0
    fi
    if [[ "${pct}" -gt "${ASSETS_MIRROR_MAX_PCT}" ]]; then
      printf '      \033[31mREFUSED\033[0m %s%% of the prefix is over ASSETS_MIRROR_MAX_PCT=%s%% — ASSETS_MIRROR_FORCE=yes to override\n' "${pct}" "${ASSETS_MIRROR_MAX_PCT}"
      MIRROR_REFUSALS+=("${dir}: ${n}/${remote_n} = ${pct}% > ASSETS_MIRROR_MAX_PCT=${ASSETS_MIRROR_MAX_PCT}%")
      return 0
    fi
  fi

  # Deleted BY NAME, one call each. `bulk-delete` can only be aimed at a prefix — exactly the blast
  # radius this must not have — and a per-name loop puts every key that was touched in the log.
  local name failed=0
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    case "${name}" in
      "${dir}/"*) ;;
      *) die "refusing to delete '${name}': outside the '${dir}/' prefix this script owns" ;;
    esac
    if "${OCI_BIN}" os object delete \
         --namespace "${NAMESPACE}" --bucket-name "${bucket}" \
         --object-name "${name}" --force >/dev/null; then
      printf '      \033[31m−\033[0m deleted %s\n' "${name}"
      MIRROR_TOTAL_DELETED=$((MIRROR_TOTAL_DELETED + 1))
    else
      printf '      \033[31m!\033[0m delete FAILED %s\n' "${name}" >&2
      failed=$((failed + 1))
    fi
  done < "${t}/orphans"
  [[ "${failed}" == "0" ]] || die "${failed} object(s) under ${dir}/ could not be deleted"
}

mirror_assets() {
  MIRROR_TMPDIR="$(mktemp -d)"
  trap 'rm -rf "${MIRROR_TMPDIR}"' EXIT
  say "Mirror (deletions) → ${ASSET_BUCKET}   mode=${ASSETS_MIRROR_DELETE}$([[ "${ASSETS_MIRROR_FORCE}" == "yes" ]] && echo ' FORCE' || true)"
  local d
  for d in "${ASSET_DIRS[@]}"; do mirror_dir "${ASSET_BUCKET}" "${d}"; done
  printf '\n  orphans found: %s · deleted: %s\n' "${MIRROR_TOTAL_ORPHANS}" "${MIRROR_TOTAL_DELETED}"
  if [[ "${#MIRROR_REFUSALS[@]}" -gt 0 ]]; then
    printf '  \033[31mrefused:\033[0m\n'
    printf '    %s\n' "${MIRROR_REFUSALS[@]}"
    # In report mode a refusal is information. In apply mode the caller asked for the bucket to
    # match the commit and it does not, so the release stops here rather than shipping a client
    # against a bucket nobody has looked at.
    [[ "${ASSETS_MIRROR_DELETE}" != "apply" ]] || die "mirror refused ${#MIRROR_REFUSALS[@]} prefix(es) — read the list above"
  fi
}

WHAT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror)   MIRROR=yes ;;
    --no-mirror) MIRROR=no ;;
    -h|--help)  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    -*)         die "unknown flag '$1'. Flags: --mirror --no-mirror" ;;
    *)          [[ -z "${WHAT}" ]] || die "give one target, got '${WHAT}' and '$1'"; WHAT="$1" ;;
  esac
  shift
done
WHAT="${WHAT:-all}"
case "${WHAT}" in
  all|audio|assets|verify) ;;
  *) die "unknown target '${WHAT}'. One of: all audio assets verify" ;;
esac
case "${ASSETS_MIRROR_DELETE}" in
  report|apply) ;;
  *) die "ASSETS_MIRROR_DELETE must be 'report' or 'apply', got '${ASSETS_MIRROR_DELETE}'" ;;
esac
if [[ "${MIRROR}" == "yes" && "${WHAT}" == "audio" ]]; then
  die "--mirror is for the tracked ASSET_DIRS only; the audio dirs are gitignored, so a checkout without them is not a deletion"
fi

# ── verify ───────────────────────────────────────────────────────────────────────────────────────
# Every audio URL the client can ask for must exist in the bucket. This replaces the old
# `existsSync(public/...)` unit assertions, which could only ever check the machine running the
# tests; now that audio ships from object storage, the bucket is the only place the answer is real.
# A manifest entry with no object behind it is silently broken narration, so this fails the release.
if [[ "${WHAT}" == "verify" ]]; then
  say "Verifying audio manifests against ${AUDIO_BUCKET}"

  listing="$(mktemp)"; manifest_urls="$(mktemp)"
  trap 'rm -f "${listing}" "${manifest_urls}"' EXIT

  # Keep every runtime-owned audio catalog in this one release contract. Ceremony music is
  # player-selectable just like narration; omitting its catalog here previously let four broken
  # opening/finale choices pass the release gate while only the two story defaults were checked
  # manually. Absolute paths also make `verify` independent of the caller's working directory.
  AUDIO_MANIFEST_FILES=(
    "${ROOT_DIR}/apps/player-app/src/features/academy/lessonNarrationClips.ts"
    "${ROOT_DIR}/apps/player-app/src/features/academy/chessShorts.ts"
    "${ROOT_DIR}/apps/player-app/src/gameplay/audio/coachVoiceClipManifest.ts"
    "${ROOT_DIR}/apps/player-app/src/gameplay/audio/coach2ClipManifest.ts"
    "${ROOT_DIR}/apps/player-app/src/gameplay/audio/coach2ClipManifestTa.ts"
    "${ROOT_DIR}/apps/player-app/src/gameplay/audio/coachFragmentClipManifest.ts"
    "${ROOT_DIR}/apps/player-app/src/gameplay/audio/coachFragmentClipManifestTa.ts"
    "${ROOT_DIR}/packages/funny-mode/src/ceremonyMusicCatalog.ts"
  )
  for manifest_file in "${AUDIO_MANIFEST_FILES[@]}"; do
    [[ -f "${manifest_file}" ]] || die "audio manifest source is missing: ${manifest_file}"
  done

  "${OCI_BIN}" os object list --namespace "${NAMESPACE}" --bucket-name "${AUDIO_BUCKET}" \
    --all --query 'data[*].name' --raw-output 2>/dev/null \
    | tr -d ' ",[]' | grep -v '^$' | sort -u > "${listing}"
  echo "  bucket holds $(wc -l < "${listing}" | tr -d ' ') objects"

  # The manifests are generated TS holding plain string literals, so a grep over them is both
  # dependency-free and exactly as accurate as parsing would be.
  grep -hoE '"/(lesson|short|coach|ceremony)-audio/[^"]+"' \
      "${AUDIO_MANIFEST_FILES[@]}" \
    | tr -d '"' | sed 's#^/##' | sort -u > "${manifest_urls}"
  total="$(wc -l < "${manifest_urls}" | tr -d ' ')"
  [[ "${total}" -gt 0 ]] || die "found no audio URLs in the manifests — the grep paths are stale"
  echo "  manifests reference ${total} distinct clips"

  # `head` closes its input early and, under pipefail, can turn a long missing list into an
  # unexplained SIGPIPE exit before the diagnostic below runs. sed consumes the complete list.
  missing="$(comm -23 "${manifest_urls}" "${listing}" | sed -n '1,25p')"
  missing_count="$(comm -23 "${manifest_urls}" "${listing}" | wc -l | tr -d ' ')"
  if [[ "${missing_count}" != "0" ]]; then
    printf '\033[31m✖ %s clip(s) referenced by a manifest are NOT in the bucket:\033[0m\n' "${missing_count}" >&2
    printf '    %s\n' ${missing} >&2
    [[ "${missing_count}" -gt 25 ]] && echo "    … and $((missing_count - 25)) more" >&2
    die "run 'infra/oci/sync-assets.sh audio' to upload them"
  fi
  printf '  \033[32m✓\033[0m every referenced clip exists in the bucket\n'
  exit 0
fi

# Plain conditionals, not case-with-;;& fallthrough: that is a bash 4 feature and macOS ships 3.2.
if [[ "${WHAT}" == "all" || "${WHAT}" == "audio" ]]; then
  say "Audio → ${AUDIO_BUCKET}"
  for d in "${AUDIO_DIRS[@]}"; do upload_dir "${AUDIO_BUCKET}" "${d}"; done
fi

if [[ "${WHAT}" == "all" || "${WHAT}" == "assets" ]]; then
  say "Models and images → ${ASSET_BUCKET}"
  for d in "${ASSET_DIRS[@]}"; do upload_dir "${ASSET_BUCKET}" "${d}"; done
  # AFTER the uploads: a rename lands as add-then-delete, and doing it in that order means the new
  # name is already readable when the old one goes away.
  if [[ "${MIRROR}" == "yes" ]]; then mirror_assets; fi
fi

say "Done"
echo "  audio   https://objectstorage.ap-mumbai-1.oraclecloud.com/n/${NAMESPACE}/b/${AUDIO_BUCKET}/o"
echo "  assets  https://objectstorage.ap-mumbai-1.oraclecloud.com/n/${NAMESPACE}/b/${ASSET_BUCKET}/o"
