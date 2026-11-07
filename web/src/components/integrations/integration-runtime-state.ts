/** Execution location and observed health are independent; neither implies offline operation. */
export type McpOrigin =
  | 'localProcess'
  | 'directRemote'
  | 'viaOpenAI'
  | 'originUnknown';
export type McpConnection =
  | 'connected'
  | 'starting'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled'
  | 'notStarted'
  | 'unverified';

export function mcpOrigin(
  name: string,
  config?: { command?: unknown; url?: unknown },
): McpOrigin {
  if (name === 'codex_apps') return 'viaOpenAI';
  if (typeof config?.command === 'string' && config.command.trim())
    return 'localProcess';
  if (typeof config?.url === 'string' && config.url.trim())
    return 'directRemote';
  return 'originUnknown';
}

export function mcpConnection(runtimeStatus?: string | null): McpConnection {
  switch (runtimeStatus) {
    case 'connected':
    case 'starting':
    case 'authenticationRequired':
    case 'failed':
    case 'cancelled':
    case 'disabled':
    case 'notStarted':
      return runtimeStatus;
    default:
      return 'unverified';
  }
}

export function appRuntimeState(
  observed: boolean,
  enabled: boolean,
  callable: boolean,
) {
  if (!observed) return 'connectionUnverified';
  if (!enabled) return 'runtimeDisabled';
  return callable ? 'toolsAvailable' : 'noCallableTools';
}
