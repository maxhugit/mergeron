/** Preserve phase exports/cwd, but never start after a failed AND-list. */
export function previewCommand(profile) {
  return (
    'set -eu\numask 077\n' +
    '_mergeron_preview_phase=setup\n' +
    // An EXIT trap also reports simple failures terminated by `set -e`.
    // These are application logs, not trusted runtime/security observations.
    'trap \'_mergeron_preview_exit=$?; if [ "$_mergeron_preview_exit" -ne 0 ]; then printf "[mergeron-preview] phase=%s exitCode=%s\\n" "$_mergeron_preview_phase" "$_mergeron_preview_exit" >&2; fi\' 0\n' +
    'mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$COREPACK_HOME" "$PNPM_HOME" "$npm_config_cache" "$npm_config_store_dir" "$npm_config_devdir"\n' +
    ['install', 'build', 'start']
      .filter((name) => profile[name].trim())
      .map(
        (name) =>
          `_mergeron_preview_phase=${name}\n` +
          profile[name] +
          '\n_mergeron_preview_phase_status=$?\nif [ "$_mergeron_preview_phase_status" -ne 0 ]; then exit "$_mergeron_preview_phase_status"; fi\n',
      )
      .join('\n')
  );
}
