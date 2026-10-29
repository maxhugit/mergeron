#!/usr/bin/env bash
set -euo pipefail

# One stable entry point for Codex and its argv[0]-dispatched helper tools.
# A WebUI-managed selection wins; an installation left by older images remains
# available as a migration fallback. Fresh installations fail with a precise
# diagnostic until an administrator installs the CLI from the WebUI.
tool="$(basename "$0")"
codex_home="${CODEX_HOME:-${HOME}/.codex}"
selection_file="${codex_home}/webui/cli/selection.json"
if [ -e "${selection_file}" ] || [ -L "${selection_file}" ]; then
  selected_binary="$(node /app/scripts/resolve-managed-cli.cjs "${codex_home}" "${1:-}")" || exit 78
  if [ -n "${selected_binary}" ]; then
  if [ ! -x "${selected_binary}" ]; then
    echo "Selected Codex CLI executable is unavailable." >&2
    exit 127
  fi
  exec -a "${tool}" "${selected_binary}" "$@"
  fi
fi

legacy_binary="$(find "${HOME}/.local/share/mise/installs/node" -type f -name codex \
  \( -path '*/vendor/*/bin/codex' -o -path '*/vendor/*/codex/codex' \) \
  2>/dev/null | sort -V | tail -1 || true)"
if [ -n "${legacy_binary}" ]; then
  exec -a "${tool}" "${legacy_binary}" "$@"
fi

echo "Codex CLI is not installed. Open Administration > Codex CLI to install it." >&2
exit 127
