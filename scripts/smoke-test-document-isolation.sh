#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-document-isolation.sh <image-ref>}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
apparmor_profile=unconfined
if docker info --format '{{json .SecurityOptions}}' | grep -q apparmor; then
  # A named userns grant is required on Ubuntu runners; do not disable the
  # host-wide restriction or grant host capabilities to the container.
  profile_file="${script_dir}/../deployment/config/apparmor-document-isolation-ci"
  sudo apparmor_parser -r "${profile_file}"
  trap 'sudo apparmor_parser -R "${profile_file}"' EXIT
  apparmor_profile=mergeron-document-isolation-ci
fi

# This disposable fixture mirrors Unraid's lack of AppArmor. It has no network,
# host data, extra capabilities or privileged mode; all writable mounts are RAM.
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=${script_dir}/../deployment/config/seccomp-bwrap.json" \
  --security-opt systempaths=unconfined \
  --security-opt "apparmor=${apparmor_profile}" \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --tmpfs /home/codex:rw,exec,nosuid,nodev,size=1g,uid=11002,gid=11002,mode=0750 \
  --tmpfs /workspaces:rw,nosuid,nodev,size=64m,uid=11002,gid=11002 \
  --tmpfs /run/secrets:rw,nosuid,nodev,size=1m,uid=11002,gid=11002 \
  --tmpfs /run/mergeron-manager:rw,nosuid,nodev,size=1m,uid=11002,gid=11002 \
  --tmpfs /appdata:rw,nosuid,nodev,size=1m,uid=11002,gid=11002 \
  --mount "type=bind,src=${script_dir}/smoke-test-document-isolation.cjs,dst=/document-isolation-probe.cjs,readonly" \
  "${image_ref}" node /document-isolation-probe.cjs
