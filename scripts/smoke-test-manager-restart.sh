#!/usr/bin/env bash
set -euo pipefail
image=${1:?Manager image required}
fixture_volume=$(docker volume create --label io.mergeron.test=manager-restart)
fixture_name="mergeron-manager-restart-$(date +%s)-$$"
cleanup() {
  docker stop -t 5 "$fixture_name" >/dev/null 2>&1 || true
  docker rm -f -v "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$fixture_volume" >/dev/null
}
trap cleanup EXIT
docker run -d --name "$fixture_name" --label io.mergeron.test=manager-restart \
  --restart unless-stopped --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 512m --cpus 0.25 --pids-limit 64 \
  --tmpfs /tmp:rw,nosuid,nodev,size=8m \
  --tmpfs /run/mergeron-manager:rw,nosuid,nodev,size=1m \
  --tmpfs /var/lib/mergeron-manager:rw,nosuid,nodev,size=1m \
  -v "$fixture_volume:/fixture" \
  --mount "type=bind,src=$(pwd)/manager/test/manager-restart.integration.mjs,dst=/tests/manager-restart.integration.mjs,readonly" \
  -e MERGERON_STACK_PREFIX=manager-restart-fixture \
  -e MERGERON_STACK_ENVIRONMENT=development -e MERGERON_INSTALL_ENABLED=false \
  -e MERGERON_MANAGER_SOCKET=/fixture/manager.sock -e MERGERON_MANAGER_SOCKET_GID=0 \
  -e MERGERON_MANAGER_ADOPTION_PATH=/fixture/state/adoption.json \
  -e MERGERON_STATE_ROOT=/fixture/synthetic -e MERGERON_MANAGER_HOST_STATE=/fixture/synthetic \
  -e MERGERON_DOCKER_SOCKET=/fixture/no-docker.sock \
  --entrypoint /nodejs/bin/node "$image" /tests/manager-restart.integration.mjs >/dev/null
recovered=false
for attempt in $(seq 1 90); do
  count=$(docker inspect --format '{{.RestartCount}}' "$fixture_name")
  health=$(docker inspect --format '{{.State.Health.Status}}' "$fixture_name")
  if [ "$count" -ge 1 ] && [ "$health" = healthy ]; then recovered=true; break; fi
  sleep 1
done
[ "$recovered" = true ]
docker exec "$fixture_name" /nodejs/bin/node -e 'const fs=require("node:fs");if(fs.readFileSync("/fixture/durable-marker","utf8")!=="synthetic-state-preserved")process.exit(1)'
docker stop -t 5 "$fixture_name" >/dev/null
sleep 2
[ "$(docker inspect --format '{{.State.Running}}' "$fixture_name")" = false ]
[ "$(docker inspect --format '{{.RestartCount}}' "$fixture_name")" = "$count" ]
printf '{"unexpectedExitRecovered":true,"persistentMarkerValid":true,"manualStopRespected":true,"restartCount":%s}\n' "$count"
