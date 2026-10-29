#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-document-isolation.sh <image-ref>}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
native_mounts=()
native_command=()
if [ -n "${MERGERON_NETLINK_EVIDENCE:-}" ]; then
  test "${3:-}" = '--netlink-route'
  test -d "$MERGERON_NETLINK_EVIDENCE" && test ! -L "$MERGERON_NETLINK_EVIDENCE"
  test -z "$(find "$MERGERON_NETLINK_EVIDENCE" -mindepth 1 -maxdepth 1 -print -quit)"
  # Output-only, empty fixture directory. It is read-only in the inner agent
  # mount namespace; only this trusted outer harness exports approved PNGs.
  native_mounts+=(--mount "type=bind,src=$MERGERON_NETLINK_EVIDENCE,dst=/netlink-evidence")
  native_mounts+=(--env MERGERON_NETLINK_EVIDENCE=/netlink-evidence)
fi
if [ -n "${2:-}" ]; then
  test -f "$2"
  native_mounts+=(--mount "type=bind,src=$2,dst=/mergeron-test-codex,readonly")
  native_mounts+=(--mount "type=bind,src=${script_dir}/smoke-test-agent-profile.cjs,dst=/agent-test-profile.cjs,readonly")
  native_command+=(/mergeron-test-codex)
  if [ "${3:-}" = '--netlink-route' ]; then
    native_command+=(--netlink-route)
    native_mounts+=(--mount "type=bind,src=${script_dir}/check-agent-netlink.py,dst=/agent-netlink-probe.py,readonly")
    native_mounts+=(--mount "type=bind,src=${script_dir}/test-agent-backend.cjs,dst=/agent-backend-fixture.cjs,readonly")
  fi
fi
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
  "${native_mounts[@]}" \
  "${image_ref}" node /document-isolation-probe.cjs "${native_command[@]}"
