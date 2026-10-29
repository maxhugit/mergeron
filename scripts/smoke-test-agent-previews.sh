#!/usr/bin/env bash
# Trusted orchestrator test on an ephemeral GitHub runner only. Never point it
# at an Unraid/Dev/production daemon: the controller needs the runner's socket.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'Agent preview orchestration requires an isolated GitHub-hosted runner.' >&2
  exit 1
fi
preview_manager_image="${1:?Pass the freshly built Manager image}"
preview_stack="mergeron-preview-check-$(openssl rand -hex 4)"
preview_root="$(mktemp -d /tmp/mergeron-preview-check-XXXXXXXX)"
mkdir "$preview_root/workspace"
# The trusted controller is UID 0 with ALL capabilities dropped, so it cannot
# bypass the runner-owned mktemp directory's 0700 mode. Assign only this NEW
# fixture tree to its owner rather than granting DAC_OVERRIDE to the container.
sudo chown 0:0 "$preview_root" "$preview_root/workspace"
cleanup() {
  # Every object is resolved by the unique fixture stack label before removal.
  for id in $(docker ps -aq --filter "label=io.mergeron.stack=$preview_stack"); do
    test "$(docker inspect --format '{{index .Config.Labels "io.mergeron.stack"}}' "$id")" = "$preview_stack" || continue
    docker stop --time 3 "$id" >/dev/null || true
    docker rm "$id" >/dev/null || true
  done
  for name in $(docker volume ls -q --filter "label=io.mergeron.stack=$preview_stack"); do
    docker volume rm "$name" >/dev/null || true
  done
  for name in $(docker network ls -q --filter "label=io.mergeron.stack=$preview_stack"); do
    docker network rm "$name" >/dev/null || true
  done
  docker image rm "$preview_stack:test" >/dev/null || true
  # The GitHub runner disposes of this tiny source-only directory at job end.
}
trap cleanup EXIT
docker pull node:22-bookworm-slim
docker pull python:3.13-slim-bookworm
preview_node="$(docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}')"
preview_python="$(docker image inspect python:3.13-slim-bookworm --format '{{index .RepoDigests 0}}')"
docker build --pull=false --build-arg "MANAGER_IMAGE=$preview_manager_image" -f manager/test/Dockerfile.previews -t "$preview_stack:test" .
docker network create --internal --driver bridge \
  --opt com.docker.network.bridge.gateway_mode_ipv4=isolated \
  --opt com.docker.network.bridge.gateway_mode_ipv6=isolated \
  --label "io.mergeron.preview-test=$preview_stack" --label "io.mergeron.stack=$preview_stack" "$preview_stack-admin"
timeout --kill-after=10s 180s docker run --rm --name "$preview_stack-controller" \
  --label "io.mergeron.preview-test=$preview_stack" --label "io.mergeron.stack=$preview_stack" --label io.mergeron.component=manager \
  --network "$preview_stack-admin" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --cpus 1 --pids-limit 128 --tmpfs /tmp:rw,nosuid,nodev,size=32m \
  --tmpfs /run/mergeron-manager:ro,nosuid,nodev,size=1m,mode=0000 \
  --tmpfs /var/lib/mergeron-manager:ro,nosuid,nodev,size=1m,mode=0000 \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount "type=bind,src=$preview_root,dst=/host-test" \
  -e MERGERON_PREVIEW_INTEGRATION=true -e "MERGERON_PREVIEW_TEST_STACK=$preview_stack" \
  -e "MERGERON_PREVIEW_TEST_ROOT=$preview_root" -e "MERGERON_PREVIEW_TEST_SDK=$preview_node" \
  -e "MERGERON_PREVIEW_TEST_PYTHON=$preview_python" "$preview_stack:test"
