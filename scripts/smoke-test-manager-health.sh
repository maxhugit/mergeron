#!/usr/bin/env bash
set -euo pipefail
image=${1:?Manager image required}
fixture_volume=$(docker volume create --label io.mergeron.test=manager-health)
fixture_name="mergeron-manager-health-$(date +%s)-$$"
cleanup() {
  docker rm -f -v "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$fixture_volume" >/dev/null
}
trap cleanup EXIT
# Only synthetic files in this invocation's volume; no host paths or Docker API.
# Exercise the real server and packaged exec probe at the deployed limits.
docker run --name "$fixture_name" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 512m --cpus 0.25 --pids-limit 64 \
  --no-healthcheck -v "$fixture_volume:/fixture" \
  --mount "type=bind,src=$(pwd)/manager/test/health-load.integration.mjs,dst=/health-load.integration.mjs,readonly" \
  --entrypoint /nodejs/bin/node "$image" /health-load.integration.mjs
