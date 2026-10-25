#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-project-mcp.sh <image-ref>}"
codex_binary="${2:-/app/node_modules/.bin/codex}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
docker run --rm --network none --read-only --cap-drop ALL --user 11002:11002 \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=128m,mode=1777 \
  --tmpfs /home/codex:rw,exec,nosuid,nodev,size=1g,uid=11002,gid=11002,mode=0750 \
  --mount "type=bind,src=${script_dir}/smoke-test-project-mcp.cjs,dst=/project-mcp-test.cjs,readonly" \
  "${image_ref}" node /project-mcp-test.cjs "${codex_binary}"
