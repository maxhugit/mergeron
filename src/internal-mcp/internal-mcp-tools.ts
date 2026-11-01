/** Stable execution keys are also used by persisted idempotency records.
 * Public names may change; handlers, policies and request fingerprints must not.
 */
export interface ToolPolicy {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  requiresWorkspaceWrite: boolean;
  administratorOnly: boolean;
  forbidImpersonation: boolean;
  transportApproval?: 'approve';
}

const projectRead: ToolPolicy = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
  requiresWorkspaceWrite: false,
  administratorOnly: false,
  forbidImpersonation: false,
};
const projectWrite: ToolPolicy = {
  ...projectRead,
  readOnly: false,
  requiresWorkspaceWrite: true,
};
const conversationWrite: ToolPolicy = {
  ...projectWrite,
  requiresWorkspaceWrite: false,
};
const monitorWrite: ToolPolicy = {
  ...conversationWrite,
  transportApproval: 'approve',
};
const gitRead: ToolPolicy = { ...projectRead, openWorld: true };
const gitWrite: ToolPolicy = { ...projectWrite, openWorld: true };
const browserRead: ToolPolicy = {
  ...projectRead,
  openWorld: true,
  administratorOnly: true,
  forbidImpersonation: true,
};

const definitions = {
  agent_monitor_read: {
    name: 'agent_monitor_read',
    title: 'Monitoring — Read conversation monitors',
    titleFr: 'Surveillance — Consulter les suivis de la conversation',
    handler: 'project',
    policy: projectRead,
  },
  agent_monitor_manage: {
    name: 'agent_monitor_manage',
    title: 'Monitoring — Schedule or pause a check',
    titleFr: 'Surveillance — Programmer ou suspendre un contrôle',
    handler: 'project',
    policy: monitorWrite,
  },
  agent_monitor_report: {
    name: 'agent_monitor_report',
    title: 'Monitoring — Report the current check',
    titleFr: 'Surveillance — Consigner le résultat du contrôle',
    handler: 'project',
    policy: monitorWrite,
  },
  project_preview_read: {
    name: 'project_preview_read',
    title: 'Test environment — Read status or logs',
    titleFr: 'Environnement de test — Consulter l’état ou les journaux',
    handler: 'project',
    policy: projectRead,
  },
  project_preview_prepare: {
    name: 'project_preview_prepare',
    title: 'Test environment — Prepare the launch recipe',
    titleFr: 'Environnement de test — Préparer la recette de lancement',
    handler: 'project',
    policy: projectWrite,
  },
  project_preview_manage: {
    name: 'project_preview_manage',
    title: 'Test environment — Manage this agent’s instance',
    titleFr: 'Environnement de test — Gérer l’instance de cet agent',
    handler: 'project',
    policy: projectWrite,
  },
  list_project_connections: {
    name: 'project_connection_list',
    title: 'Connections — List project connections',
    titleFr: 'Connexions — Lister les connexions du projet',
    handler: 'project',
    policy: projectRead,
  },
  create_project_git_copy: {
    name: 'project_git_copy_create',
    title: 'Git — Create this agent’s working copy',
    titleFr: 'Git — Créer la copie de travail de cet agent',
    handler: 'project',
    policy: gitWrite,
  },
  read_project_git: {
    name: 'project_git_read',
    title: 'Git — Read repository and working-copy state',
    titleFr: 'Git — Consulter le dépôt et l’état de la copie locale',
    handler: 'project',
    policy: gitRead,
  },
  prepare_project_git: {
    name: 'project_git_local_manage',
    title: 'Git — Stage, commit, integrate or restore local changes',
    titleFr:
      'Git — Préparer, committer, intégrer ou restaurer les modifications locales',
    handler: 'project',
    policy: { ...gitWrite, destructive: true },
  },
  publish_project_git: {
    name: 'project_git_publish',
    title: 'Git — Push changes, create or update a pull request',
    titleFr: 'Git — Publier les modifications, créer ou modifier une PR',
    handler: 'project',
    policy: { ...gitWrite, transportApproval: 'approve' },
  },
  local_browser_read: {
    name: 'local_browser_read',
    title: 'Local browser — Read the shared tab',
    titleFr: 'Navigateur local — Consulter l’onglet partagé',
    handler: 'localBrowserRead',
    policy: browserRead,
  },
  local_browser_action: {
    name: 'local_browser_interact',
    title: 'Local browser — Request an interaction',
    titleFr: 'Navigateur local — Demander une interaction',
    handler: 'localBrowserInteract',
    policy: {
      ...browserRead,
      readOnly: false,
      requiresWorkspaceWrite: true,
      destructive: true,
      idempotent: false,
    },
  },
  rename_agent: {
    name: 'agent_rename',
    title: 'Agent — Rename this conversation',
    titleFr: 'Agent — Renommer cette conversation',
    handler: 'project',
    policy: conversationWrite,
  },
  get_project: {
    name: 'project_get',
    title: 'Project — Read the project',
    titleFr: 'Projet — Consulter le projet',
    handler: 'project',
    policy: projectRead,
  },
  list_tasks: {
    name: 'project_task_list',
    title: 'Tasks — List project tasks',
    titleFr: 'Tâches — Lister les tâches du projet',
    handler: 'project',
    policy: projectRead,
  },
  get_task: {
    name: 'project_task_get',
    title: 'Tasks — Read a task',
    titleFr: 'Tâches — Consulter une tâche',
    handler: 'project',
    policy: projectRead,
  },
  list_deliverables: {
    name: 'project_deliverable_list',
    title: 'Deliverables — List project deliverables',
    titleFr: 'Livrables — Lister les livrables du projet',
    handler: 'project',
    policy: projectRead,
  },
  get_deliverable: {
    name: 'project_deliverable_get',
    title: 'Deliverables — Read a deliverable',
    titleFr: 'Livrables — Consulter un livrable',
    handler: 'project',
    policy: projectRead,
  },
  create_task: {
    name: 'project_task_create',
    title: 'Tasks — Create a task',
    titleFr: 'Tâches — Créer une tâche',
    handler: 'project',
    policy: projectWrite,
  },
  create_deliverable: {
    name: 'project_deliverable_create',
    title: 'Deliverables — Create a deliverable',
    titleFr: 'Livrables — Créer un livrable',
    handler: 'project',
    policy: projectWrite,
  },
} as const;

export type InternalMcpOperation = keyof typeof definitions;

export interface InternalMcpIdentity {
  name: string;
  operation: InternalMcpOperation;
  aliases: InternalMcpOperation[];
  title: string;
  titleFr: string;
  handler: 'project' | 'localBrowserRead' | 'localBrowserInteract';
  policy: ToolPolicy;
  readOnly: boolean;
}

export function internalMcpIdentity(
  operation: InternalMcpOperation,
): InternalMcpIdentity {
  const definition = definitions[operation];
  return {
    ...definition,
    operation,
    // Only names from previous published catalogues are accepted as aliases.
    aliases: definition.name === operation ? [] : [operation],
    readOnly: definition.policy.readOnly,
  };
}

export const INTERNAL_MCP_IDENTITIES = (
  Object.keys(definitions) as InternalMcpOperation[]
).map(internalMcpIdentity);

export function validateInternalMcpIdentities(
  identities: readonly InternalMcpIdentity[],
) {
  const names = new Set<string>();
  const operations = new Set<string>();
  for (const tool of identities) {
    if (
      tool.name.length > 64 ||
      !/^(?:project|agent|local_browser)_(?:[a-z][a-z0-9]*_)*(?:get|list|read|create|rename|prepare|manage|publish|interact|report)$/.test(
        tool.name,
      ) ||
      operations.has(tool.operation) ||
      (tool.policy.readOnly && tool.policy.requiresWorkspaceWrite)
    )
      throw new Error('Invalid internal MCP tool definition');
    operations.add(tool.operation);
    for (const name of [tool.name, ...tool.aliases]) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || names.has(name))
        throw new Error('Invalid or duplicate internal MCP tool name');
      names.add(name);
    }
  }
}
validateInternalMcpIdentities(INTERNAL_MCP_IDENTITIES);

const byName = new Map<string, InternalMcpIdentity>(
  INTERNAL_MCP_IDENTITIES.flatMap((tool) =>
    [tool.name, ...tool.aliases].map((name) => [name, tool] as const),
  ),
);

export function resolveInternalMcpTool(name: string) {
  return byName.get(name);
}

/** Rewrite only the declared name, before SDK schema validation; never arguments. */
export function normalizeInternalMcpRequest(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const params = request.params;
  if (
    request.method !== 'tools/call' ||
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params)
  )
    return body;
  const values = params as Record<string, unknown>;
  if (typeof values.name !== 'string') return body;
  const tool = resolveInternalMcpTool(values.name);
  return tool ? { ...request, params: { ...values, name: tool.name } } : body;
}

export function internalMcpAnnotations(tool: InternalMcpIdentity) {
  return {
    readOnlyHint: tool.policy.readOnly,
    destructiveHint: tool.policy.destructive,
    idempotentHint: tool.policy.idempotent,
    openWorldHint: tool.policy.openWorld,
  };
}

/** Preserve existing transport exceptions for cached aliases as well as new names. */
export function internalMcpTransportApprovals() {
  return Object.fromEntries(
    INTERNAL_MCP_IDENTITIES.flatMap((tool) => {
      const approval_mode = tool.policy.transportApproval;
      return approval_mode
        ? [tool.name, ...tool.aliases].map((name) => [name, { approval_mode }])
        : [];
    }),
  );
}
