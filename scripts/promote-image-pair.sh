#!/usr/bin/env bash
# GHCR cannot atomically update tags in two repositories. Serialize this step
# in the caller and compensate failures by restoring every previous channel tag.
set -Eeuo pipefail
: "${APP_SOURCE_IMAGE:?}" "${APP_SOURCE_DIGEST:?}" "${APP_TARGET_TAGS:?}"
: "${MANAGER_SOURCE_IMAGE:?}" "${MANAGER_SOURCE_DIGEST:?}" "${MANAGER_TARGET_TAGS:?}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
declare -a previous_tags=() previous_refs=()
remember() {
  local tag digest
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    # The first publication may not have a predecessor. Existing channel tags
    # must be readable before making any mutation; missing immutable SHA tags
    # do not need rollback because deployment never follows them implicitly.
    if digest=$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}'); then
      [[ "$digest" == sha256:* ]] || return 1
      previous_tags+=("$tag")
      previous_refs+=("${tag%:*}@${digest}")
    elif [[ "$tag" == *:edge || "$tag" == *:latest ]]; then
      echo "Cannot snapshot release tag $tag; refusing partial promotion" >&2
      return 1
    fi
  done <<< "$1"
}
remember "$APP_TARGET_TAGS"
remember "$MANAGER_TARGET_TAGS"
rollback() {
  local failed=0 index
  trap - ERR INT TERM
  for ((index=0; index<${#previous_tags[@]}; index++)); do
    docker buildx imagetools create --tag "${previous_tags[index]}" "${previous_refs[index]}" || failed=1
  done
  if ((failed)); then echo 'ERROR: release-tag rollback incomplete; operator repair required' >&2; fi
  exit 1
}
trap rollback ERR INT TERM
SOURCE_IMAGE="$APP_SOURCE_IMAGE" SOURCE_DIGEST="$APP_SOURCE_DIGEST" TARGET_TAGS="$APP_TARGET_TAGS" bash "$script_dir/promote-image.sh"
SOURCE_IMAGE="$MANAGER_SOURCE_IMAGE" SOURCE_DIGEST="$MANAGER_SOURCE_DIGEST" TARGET_TAGS="$MANAGER_TARGET_TAGS" bash "$script_dir/promote-image.sh"
trap - ERR INT TERM
