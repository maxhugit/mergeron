#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-office-image.sh <image-ref>}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
docker run --rm --interactive --network none \
  --entrypoint /opt/office-venv/bin/python "${image_ref}" \
  - < "${script_dir}/smoke-test-office-conversions.py"

# Test the shipped helpers as the real agent user, without network, capabilities
# or writable root. Only synthetic fixtures and rendered evidence can be written.
evidence="$(mktemp -d "${TMPDIR:-/tmp}/mergeron-office-evidence.XXXXXX")"
chmod 0777 "$evidence"
trap 'rm -rf -- "$evidence"' EXIT
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 11002:11002 \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --env HOME=/tmp --env OFFICE_TEST_EVIDENCE=/evidence \
  --mount "type=bind,src=$evidence,dst=/evidence" \
  --entrypoint /opt/office-venv/bin/python "$image_ref" \
  -m unittest discover -s /opt/codex-skills/office-files/tests -v
if [[ -n "${OFFICE_RENDER_EVIDENCE:-}" ]]; then
  mkdir -p -- "$OFFICE_RENDER_EVIDENCE"
  cp -R -- "$evidence/." "$OFFICE_RENDER_EVIDENCE/"
fi
