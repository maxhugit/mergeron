#!/usr/bin/env bash
set -euo pipefail
image=${1:?Manager image required}
fixture_volume=$(docker volume create --label io.mergeron.test=manager-performance)
fixture_name="mergeron-manager-performance-$(date +%s)-$$"
cleanup() {
  docker rm -f -v "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$fixture_volume" >/dev/null
}
trap cleanup EXIT
# No host state, Docker socket, published port or external network. The fixture
# runs the real HTTP server alongside bounded synthetic work at deployed quotas.
docker run --name "$fixture_name" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 512m --cpus 0.25 --pids-limit 64 \
  --tmpfs /tmp:rw,nosuid,nodev,size=8m \
  --tmpfs /run/mergeron-manager:rw,nosuid,nodev,size=1m \
  --tmpfs /var/lib/mergeron-manager:rw,nosuid,nodev,size=1m \
  --no-healthcheck -v "$fixture_volume:/fixture" \
  --mount "type=bind,src=$(pwd)/manager/test,dst=/tests,readonly" \
  --entrypoint /nodejs/bin/node "$image" /tests/manager-load.integration.mjs candidate
