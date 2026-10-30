/** Preserve phase exports/cwd, but never start after a failed AND-list. */
export function previewCommand(profile) {
  return (
    'set -eu\numask 077\nmkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$COREPACK_HOME" "$PNPM_HOME" "$npm_config_cache" "$npm_config_store_dir" "$npm_config_devdir"\n' +
    [profile.install, profile.build, profile.start]
      .filter((phase) => phase.trim())
      .map(
        (phase) =>
          phase +
          '\n_mergeron_preview_phase_status=$?\nif [ "$_mergeron_preview_phase_status" -ne 0 ]; then exit "$_mergeron_preview_phase_status"; fi\n',
      )
      .join('\n')
  );
}
