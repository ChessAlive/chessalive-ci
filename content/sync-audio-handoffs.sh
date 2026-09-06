#!/usr/bin/env bash
# Upload tracked audio delivery packs exactly once, then prove their public CDN bytes.
#
# A handoff is immutable: its completion marker includes the SHA-256 of inventory.json. A changed
# inventory therefore gets a new marker and is uploaded/verified again. Normal audio directories
# remain handled by sync-assets.sh; this script only owns infra/oci/audio-handoffs/*/public.
set -euo pipefail

ROOT_DIR="${SOURCE_ROOT:-/opt/chessalive}"
HANDOFF_ROOT="${ROOT_DIR}/infra/oci/audio-handoffs"
NAMESPACE="${OCI_NAMESPACE:-bmt2adcjgo0u}"
AUDIO_BUCKET="${AUDIO_BUCKET:-chessalive-audio}"
OCI_BIN="${OCI_BIN:-oci}"

command -v "${OCI_BIN}" >/dev/null 2>&1 || { echo "oci CLI not found" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required to verify audio handoffs" >&2; exit 1; }

packs=0
uploaded=0
skipped=0
for pack in "${HANDOFF_ROOT}"/*; do
  [[ -f "${pack}/inventory.json" && -f "${pack}/verify.mjs" ]] || continue
  packs=$((packs + 1))
  name="$(basename "${pack}")"
  inventory_sha="$(sha256sum "${pack}/inventory.json" | awk '{print $1}')"
  public_tree="$(git -C "${ROOT_DIR}" rev-parse "HEAD:infra/oci/audio-handoffs/${name}/public")"
  marker="_release-handoffs/${name}-${inventory_sha}-${public_tree}.complete.json"

  echo
  echo "▶ Audio handoff ${name}"
  read -r count bytes < <(node -e 'const i=require(process.argv[1]); console.log(i.files.length, i.files.reduce((sum,f)=>sum+f.bytes,0))' "${pack}/inventory.json")

  if "${OCI_BIN}" os object head --namespace "${NAMESPACE}" --bucket-name "${AUDIO_BUCKET}" \
       --name "${marker}" >/dev/null 2>&1; then
    echo "  ✓ ${count} files / ${bytes} bytes already uploaded and byte-verified; marker ${marker}"
    skipped=$((skipped + 1))
    continue
  fi

  [[ -d "${pack}/public" ]] || { echo "Audio completion marker is missing and delivery bytes were not fetched; retry the release." >&2; exit 1; }
  node "${pack}/verify.mjs"
  echo "  → uploading ${count} files / ${bytes} bytes"
  PUBLIC_DIR="${pack}/public" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync-assets.sh" audio
  node "${pack}/verify.mjs" --cloud

  marker_file="$(mktemp)"
  trap 'rm -f "${marker_file:-}"' EXIT
  printf '{"handoff":"%s","inventorySha256":"%s","files":%s,"bytes":%s,"verifiedAt":"%s"}\n' \
    "${name}" "${inventory_sha}" "${count}" "${bytes}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${marker_file}"
  "${OCI_BIN}" os object put --namespace "${NAMESPACE}" --bucket-name "${AUDIO_BUCKET}" \
    --name "${marker}" --file "${marker_file}" --content-type application/json --force >/dev/null
  rm -f "${marker_file}"
  trap - EXIT
  echo "  ✓ uploaded, CDN byte-verified, and marked complete"
  uploaded=$((uploaded + 1))
done

echo
echo "Audio handoffs: ${packs} pack(s) · ${uploaded} uploaded · ${skipped} unchanged/skipped"
