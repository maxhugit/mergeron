#!/usr/bin/env bash
# Run inside the agent's mount namespace, after /tmp has been isolated.
set -euo pipefail
umask 077
# Bootstrap tools before consulting the inherited PATH. The backend passes its
# absolute Node executable; no project file or profile chooses it.
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
agent_node_binary="${MERGERON_AGENT_NODE_BINARY:-$(command -v node || true)}"
if [[ "$agent_node_binary" != /* || ! -x "$agent_node_binary" ]]; then
  echo 'MERGERON_AGENT_NODE_UNAVAILABLE' >&2
  exit 65
fi
export PATH="${agent_node_binary%/*}:$PATH"
export NODE_ENV="${MERGERON_AGENT_NODE_ENV:-development}"
case "$NODE_ENV" in development|production|test) ;; *)
  echo 'MERGERON_AGENT_NODE_ENV_INVALID' >&2; exit 65 ;; esac
cache_root="$(mktemp -d "${TMPDIR:-/tmp}/mergeron-agent-cache.XXXXXXXX")"
export XDG_CACHE_HOME="$cache_root/xdg"
export COREPACK_HOME="$cache_root/corepack"
export npm_config_cache="$cache_root/npm"
export npm_config_store_dir="$cache_root/pnpm-store"
# pnpm 11 uses its own environment prefix; pnpm 10 uses npm_config_.
export pnpm_config_store_dir="$npm_config_store_dir"
export npm_config_devdir="$cache_root/node-gyp"
export PNPM_HOME="$cache_root/pnpm"
export PATH="$PNPM_HOME:$PATH"
mkdir -p "$XDG_CACHE_HOME" "$COREPACK_HOME" "$npm_config_cache" \
  "$npm_config_store_dir" "$npm_config_devdir" "$PNPM_HOME"

# The pinned manager survives image cache cleanup and existing home volumes.
# Copy, never mutate the immutable seed; other versions may then be cached too.
if [[ -d /opt/mergeron-corepack ]]; then
  cp -R /opt/mergeron-corepack/. "$COREPACK_HOME/"
fi

# Native addons can use matching installed headers without a network download.
# Preserve an explicitly configured alternative runtime (e.g. Electron).
if [[ -z "${npm_config_nodedir:-}" ]]; then
  node_root="$("$agent_node_binary" -e '
    const fs = require("node:fs"), path = require("node:path");
    const root = path.dirname(path.dirname(process.execPath));
    try {
      const headers = fs.readFileSync(path.join(root, "include/node/node_version.h"), "utf8");
      const version = ["MAJOR", "MINOR", "PATCH"].map(part =>
        headers.match(new RegExp("#define\\s+NODE_" + part + "_VERSION\\s+(\\d+)"))?.[1]
      ).join(".");
      if (version === process.versions.node && fs.existsSync(path.join(root, "include/node/node.h")))
        process.stdout.write(root);
    } catch { /* The preflight reports missing headers without fetching them. */ }
  ')"
  if [[ -n "$node_root" ]]; then export npm_config_nodedir="$node_root"; fi
fi
exec "$@"
