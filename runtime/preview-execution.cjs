'use strict';
/** Conservative checks: a custom shell/script remains unknown, never inferred from its name. */
function executionCheck(profile) {
  const configured = profile.env?.NODE_ENV ?? 'development';
  const mode = ['development', 'production', 'test'].includes(configured)
    ? configured
    : 'unknown';
  const issues = [];
  const issue = (code, severity = 'error') => issues.push({ code, severity });
  if (
    profile.env?.PORT !== undefined &&
    (!/^\d+$/.test(profile.env.PORT) ||
      Number(profile.env.PORT) !== profile.port)
  )
    issue('portConflict');
  let command = profile.start.trim(),
    inlineMode;
  const assignment =
    /^(?:env\s+)?NODE_ENV=(development|production|test)\s+/.exec(command);
  if (assignment) {
    inlineMode = assignment[1];
    command = command.slice(assignment[0].length);
  }
  if (inlineMode && inlineMode !== configured) issue('modeOverride');
  const simple = !/[;&|`$<>\n\r'"\\]/.test(command);
  command = command
    .replace(/^exec\s+/, '')
    .replace(
      /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+exec\s+|npm\s+exec\s+--\s+)/,
      '',
    );
  const words = command.split(/\s+/);
  let kind = 'custom';
  if (
    simple &&
    ((words[0] === 'next' && words[1] === 'dev') ||
      (words[0] === 'vite' &&
        (!words[1] ||
          words[1].startsWith('-') ||
          ['dev', 'serve'].includes(words[1]))))
  )
    kind = 'development';
  if (
    simple &&
    ((words[0] === 'next' && words[1] === 'start') ||
      (words[0] === 'vite' && words[1] === 'preview'))
  )
    kind = 'production';
  if (kind !== 'custom') {
    for (const match of command.matchAll(
      /(?:^|\s)(?:--port(?:=|\s+)|-p\s+)([^\s]+)/g,
    ))
      if (!/^\d+$/.test(match[1]) || Number(match[1]) !== profile.port)
        issue('portConflict');
  }
  if (kind !== 'custom' && (inlineMode ?? mode) !== kind) issue('modeConflict');
  if (kind === 'custom') issue('commandUnknown', 'warning');
  if (mode === 'unknown') issue('modeUnknown', 'warning');
  if (mode === 'production' && profile.updateMode === 'hot')
    issue('hotProduction', 'warning');
  if (
    !/['"`\\#\n\r]/.test(profile.start) &&
    /(?:^|[^&])&\s*$/.test(profile.start.trim())
  )
    issue('backgroundServer');
  return {
    valid: !issues.some((v) => v.severity === 'error'),
    mode,
    port: profile.port,
    kind,
    issues,
  };
}
module.exports = { executionCheck };
