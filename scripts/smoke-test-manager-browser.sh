#!/usr/bin/env bash
set -euo pipefail
image=${1:?Manager image required}
# Disposable fixture: no Docker socket, host mounts or network access.
container_id=$(docker run -d --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /run/mergeron-manager:rw,nosuid,nodev,size=1m \
  --tmpfs /var/lib/mergeron-manager:rw,nosuid,nodev,size=8m \
  -e MERGERON_STACK_PREFIX=mergeron-dev \
  -e MERGERON_STACK_ENVIRONMENT=development \
  -e MERGERON_MANAGE_BROWSER=true \
  -e MERGERON_INSTALL_ENABLED=false "$image")
trap 'docker logs "$container_id"; docker rm -f "$container_id" >/dev/null' EXIT
for attempt in $(seq 1 20); do
  if docker exec "$container_id" /nodejs/bin/node src/healthcheck.mjs; then
    echo 'Manager starts with the managed DEV browser enabled.'
    exit 0
  fi
  sleep 1
done
exit 1
