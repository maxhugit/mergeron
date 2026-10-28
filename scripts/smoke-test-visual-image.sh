#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-visual-image.sh <image> [evidence-directory]}"
evidence_dir="${2:-artifacts/visual-image}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$evidence_dir"
container_id=""
cleanup() { if [[ -n "$container_id" ]]; then docker rm --force --volumes "$container_id" >/dev/null; fi; }
trap cleanup EXIT
# Same hardening as the agent: non-root, read-only image, dropped capabilities,
# private IPC, and a namespace-capable seccomp profile. No host IPC/SYS_ADMIN.
container_id="$(docker create --init --network none --read-only \
  --user 11002:11002 --cap-drop ALL --security-opt no-new-privileges \
  --security-opt "seccomp=${script_dir}/../deployment/config/seccomp-bwrap.json" \
  --security-opt systempaths=unconfined --shm-size 64m \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs /home/codex:rw,exec,nosuid,nodev,size=2g,uid=11002,gid=11002 \
  --volume /workspaces --volume /app/logs \
  "$image_ref" sh -c '
    mergeron-visual-check --smoke --output /workspaces/visual-smoke/local &&
    PORT=4173 WEBUI_API_KEY=isolated-visual-smoke WEBUI_DB_PATH=/tmp/visual-check.sqlite \
      WEBUI_REQUIRE_IDENTITY=false mergeron-visual-check \
      --start "node /app/dist/main.js" --url http://127.0.0.1:4173/login \
      --selector form --text Mergeron --output /workspaces/visual-smoke/mergeron
  ')"
docker start --attach "$container_id" || true
docker cp "$container_id:/workspaces/visual-smoke/." "$evidence_dir/"
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$container_id")" == 0 ]]
for scenario in local mergeron; do
  test -s "$evidence_dir/$scenario/desktop.png"
  test -s "$evidence_dir/$scenario/mobile.png"
  test -s "$evidence_dir/$scenario/report.json"
done
