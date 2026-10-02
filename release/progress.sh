#!/usr/bin/env bash
# Source-only progress protocol. Each event is a single write so parallel build
# processes cannot interleave their JSON. The build runner timestamps receipt.
# Commands remain silent unless the runner exports CHESSALIVE_PROGRESS=yes.

CHESSALIVE_ACTIVE_STEPS=""

progress_track() {
  local step="$1" status="$2" active
  local remaining=""
  for active in ${CHESSALIVE_ACTIVE_STEPS}; do
    [[ "${active}" == "${step}" ]] || remaining+=" ${active}"
  done
  CHESSALIVE_ACTIVE_STEPS="${remaining}"
  [[ "${status}" != running ]] || CHESSALIVE_ACTIVE_STEPS+=" ${step}"
  return 0
}

progress_mark() {
  local step="$1" status="$2"
  [[ "${CHESSALIVE_PROGRESS:-}" == yes ]] || return 0
  # Only fixed identifiers are allowed in the line protocol; no log text or
  # environment values are interpolated into JSON.
  [[ "${step}" =~ ^[a-z][a-z0-9_-]*$ ]] || return 2
  case "${status}" in running|done|failed|skipped) ;; *) return 2 ;; esac
  progress_track "${step}" "${status}"
  printf '@@CHESSALIVE_STEP {"id":"%s","status":"%s"}\n' "${step}" "${status}"
}

progress_on_exit() {
  local status="$1" step
  if (( status != 0 )); then
    for step in ${CHESSALIVE_ACTIVE_STEPS}; do
      progress_mark "${step}" failed
    done
  fi
  return "${status}"
}

progress_run() {
  local step="$1" status
  shift
  progress_mark "${step}" running
  if "$@"; then
    progress_mark "${step}" done
  else
    status="$?"
    progress_mark "${step}" failed
    return "${status}"
  fi
}

# A remote transaction owns its install/health events. Reconcile those events
# before the caller's EXIT trap so a dropped SSH connection fails the actual
# active phase, and a failed health gate never overwrites completed installation.
# The log is written by tee, which also streams every line to the build runner.
progress_adopt_log() {
  local log="$1" line step status payload
  [[ "${CHESSALIVE_PROGRESS:-}" == yes && -f "${log}" ]] || return 0
  while IFS= read -r line; do
    case "${line}" in
      '@@CHESSALIVE_STEP {"id":"'*'","status":"'*'"}')
        payload="${line#*\"id\":\"}"
        step="${payload%%\"*}"
        payload="${line#*\"status\":\"}"
        status="${payload%%\"*}"
        case "${step}:${status}" in
          deploy:running|deploy:done|deploy:failed|health:running|health:done|health:failed)
            progress_track "${step}" "${status}"
            ;;
        esac
        ;;
    esac
  done < "${log}"
}
