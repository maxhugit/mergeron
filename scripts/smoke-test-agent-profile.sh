#!/usr/bin/env bash
# Isolated CI fixture only. Never installs a CLI into the production image.
set -Eeuo pipefail
runtime_image="${1:?Usage: smoke-test-agent-profile.sh <runtime-image> <builder-image>}"
builder_image="${2:?Missing builder image}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture_dir="$(mktemp -d /tmp/mergeron-agent-profile.XXXXXX)"
trap 'rm -f -- "$fixture_dir/codex"; rmdir -- "$fixture_dir"' EXIT
chmod 755 "$fixture_dir"
# Extract only the already-locked Linux CLI from the build-only dependency.
# No account, home volume, network or host directory is visible to this step.
docker run --rm --network none --read-only --cap-drop ALL --entrypoint node \
  "$builder_image" -e '
const fs=require("node:fs"),path=require("node:path"),{createRequire}=require("node:module");
const root=fs.realpathSync("/app/node_modules/@openai/codex");
const req=createRequire(path.join(root,"package.json"));
const pkg=req.resolve("@openai/codex-linux-x64/package.json");
process.stdout.write(fs.readFileSync(path.join(path.dirname(pkg),"vendor/x86_64-unknown-linux-musl/bin/codex")));
' > "$fixture_dir/codex"
chmod 755 "$fixture_dir/codex"
bash "$script_dir/smoke-test-document-isolation.sh" "$runtime_image" "$fixture_dir/codex"
