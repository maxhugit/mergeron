#!/usr/bin/env bash
set -euo pipefail
image=${1:?Manager image required}
container_id=
cleanup() {
  if [[ -n "$container_id" ]]; then
    docker logs "$container_id"
    docker rm -f "$container_id" >/dev/null
  fi
}
trap cleanup EXIT
for environment in development production; do
prefix=mergeron
if [[ "$environment" == development ]]; then prefix=mergeron-dev; fi
# Disposable fixture: no Docker socket, host mounts or network access.
container_id=$(docker run -d --read-only --network none --cap-drop ALL --cap-add CHOWN \
  --security-opt no-new-privileges:true \
  --tmpfs /run/mergeron-manager:rw,nosuid,nodev,size=1m \
  --tmpfs /var/lib/mergeron-manager:rw,nosuid,nodev,size=8m \
  -e MERGERON_STACK_PREFIX="$prefix" \
  -e MERGERON_STACK_ENVIRONMENT="$environment" \
  -e MERGERON_MANAGE_BROWSER=true \
  -e MERGERON_INSTALL_ENABLED=false "$image")
healthy=false
for attempt in $(seq 1 20); do
  if docker exec "$container_id" /nodejs/bin/node src/healthcheck.mjs; then
    echo "Manager starts with the managed $environment browser enabled."
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]] || exit 1
# Exercise the application identity: health as root alone misses an
# inaccessible socket parent on a genuinely fresh installation.
docker exec --user 11002:11002 "$container_id" /nodejs/bin/node --input-type=module -e '
import http from "node:http";
const request = http.get({socketPath:"/run/mergeron-manager/manager.sock",path:"/v1/codex-cli"}, response => {
  response.resume();
  if (response.statusCode !== 200) process.exitCode = 1;
});
request.setTimeout(5000, () => request.destroy(new Error("Manager socket timeout")));
request.on("error", error => { console.error(error.message); process.exitCode = 1; });
'
cleanup
container_id=
done
