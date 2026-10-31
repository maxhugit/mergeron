/** Drizzle table declarations for Mergeron persistence. */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Durable idempotency receipts for project-scoped agent business tools. */
export const projectAgentToolRequests = sqliteTable(
  'project_agent_tool_requests',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    requestId: text('request_id').notNull(),
    digest: text('digest').notNull(),
    personId: text('person_id'),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.threadId, table.requestId] }),
  ],
);

/** Durable terminal intent survives disposal of its PTY and headless buffer. */
export const terminalIdentities = sqliteTable('terminal_identities', {
  id: text('id').primaryKey(),
  contextKey: text('context_key').notNull(),
  cwd: text('cwd').notNull(),
  shell: text('shell').notNull(),
  title: text('title').notNull(),
  sessionId: text('session_id').notNull(),
  generation: integer('generation').notNull(),
  closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
  /** At most three automatic attempts in the rolling recovery window. */
  automaticAttempts: text('automatic_attempts', { mode: 'json' })
    .$type<number[]>()
    .notNull(),
  createdAt: text('created_at').notNull(),
});

export type TerminalIdentity = typeof terminalIdentities.$inferSelect;

export const tokenUsageSnapshots = sqliteTable(
  'token_usage_snapshots',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    reasoningOutputTokens: integer('reasoning_output_tokens').notNull(),
    lastTotalTokens: integer('last_total_tokens').notNull(),
    lastInputTokens: integer('last_input_tokens').notNull(),
    lastCachedInputTokens: integer('last_cached_input_tokens').notNull(),
    lastOutputTokens: integer('last_output_tokens').notNull(),
    lastReasoningOutputTokens: integer(
      'last_reasoning_output_tokens',
    ).notNull(),
    modelContextWindow: integer('model_context_window'),
    rawPayload: text('raw_payload').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.turnId] }),
    index('idx_token_usage_thread_updated').on(table.threadId, table.updatedAt),
  ],
);

export type TokenUsageSnapshot = typeof tokenUsageSnapshots.$inferSelect;
export type InsertTokenUsageSnapshot = typeof tokenUsageSnapshots.$inferInsert;

/** Persists the cumulative turn-level diff from turn/diff/updated notifications. */
export const turnDiffs = sqliteTable(
  'turn_diffs',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    diff: text('diff').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.turnId] }),
    index('idx_turn_diffs_thread').on(table.threadId),
  ],
);

export type TurnDiffRow = typeof turnDiffs.$inferSelect;
export type InsertTurnDiffRow = typeof turnDiffs.$inferInsert;

/** Generic runtime-configurable settings seeded from code-owned definitions. */
export const settings = sqliteTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: text('value'),
    type: text('type').notNull(),
    category: text('category').notNull(),
    description: text('description').notNull(),
    defaultValue: text('default_value').notNull(),
    constraints: text('constraints').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_settings_category').on(table.category)],
);

export type SettingRow = typeof settings.$inferSelect;
export type InsertSettingRow = typeof settings.$inferInsert;

/** Persisted app-server requests that require a user response, such as approvals. */
export const pendingServerRequests = sqliteTable(
  'pending_server_requests',
  {
    // Legacy history has no instance identity and is expired at startup.
    instanceId: text('instance_id'),
    generation: integer('generation').notNull(),
    requestId: text('request_id').notNull(),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id'),
    itemId: text('item_id'),
    method: text('method').notNull(),
    paramsJson: text('params_json').notNull(),
    status: text('status').notNull(),
    resolvedBy: text('resolved_by'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    resolvedAt: integer('resolved_at'),
    failureReason: text('failure_reason'),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId] }),
    index('idx_pending_requests_origin').on(table.generation, table.requestId),
    index('idx_pending_requests_thread_status').on(
      table.threadId,
      table.status,
    ),
    index('idx_pending_requests_status_updated').on(
      table.status,
      table.updatedAt,
    ),
  ],
);

export type PendingServerRequestRow = typeof pendingServerRequests.$inferSelect;
export type InsertPendingServerRequestRow =
  typeof pendingServerRequests.$inferInsert;

/** Persists final turn errors for hydration after page refresh. */
export const turnErrors = sqliteTable(
  'turn_errors',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    message: text('message').notNull(),
    errorCategory: text('error_category'),
    additionalDetails: text('additional_details'),
    misalignmentErrorType: text('misalignment_error_type'),
    misalignmentExplanation: text('misalignment_explanation'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.turnId] }),
    index('idx_turn_errors_thread').on(table.threadId),
  ],
);

export type TurnErrorRow = typeof turnErrors.$inferSelect;
export type InsertTurnErrorRow = typeof turnErrors.$inferInsert;

/**
 * Grouping key stored when the edited message is the first turn, i.e. the
 * common prefix is empty. Turn ids are uuids, so this never collides.
 */
export const BRANCH_START_SENTINEL = '__start__';

/**
 * Topology-only fork boundary used when a child was forked after the parent's
 * last known turn. UUID turn ids cannot collide with this sentinel.
 */
export const BRANCH_END_SENTINEL = '__end__';

/**
 * One logical message-version group inside a locally tracked branch tree.
 *
 * Identified by `(treeRootThreadId, commonPrefixTurnId)`. The grouping key is
 * the last turn of the common prefix — not the edited turn — because editing
 * the same logical message from inside a branch names a different edited turn
 * each time while the prefix stays identical.
 */
export const conversationBranchGroups = sqliteTable(
  'conversation_branch_groups',
  {
    groupId: text('group_id').primaryKey(),
    treeRootThreadId: text('tree_root_thread_id').notNull(),
    /** Last turn id of the common prefix, or `BRANCH_START_SENTINEL`. */
    commonPrefixTurnId: text('common_prefix_turn_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_branch_groups_root_prefix').on(
      table.treeRootThreadId,
      table.commonPrefixTurnId,
    ),
    index('idx_branch_groups_root').on(table.treeRootThreadId),
  ],
);

export type ConversationBranchGroup =
  typeof conversationBranchGroups.$inferSelect;
export type InsertConversationBranchGroup =
  typeof conversationBranchGroups.$inferInsert;

/**
 * A concrete sibling version for one edited user-message group.
 *
 * A thread appears once per group it participates in, so the same thread can
 * hold several rows: the root thread is the `original` version of every group
 * created from one of its own turns.
 */
export const conversationBranchVersions = sqliteTable(
  'conversation_branch_versions',
  {
    versionId: text('version_id').primaryKey(),
    groupId: text('group_id').notNull(),
    threadId: text('thread_id').notNull(),
    /** 1-based position rendered as `< n/m >`. */
    versionIndex: integer('version_index').notNull(),
    /** `original` for the pre-existing continuation, `branch` for forks. */
    kind: text('kind').notNull(),
    /** `local` rows came from this client; `adopted` rows came from disk scan. */
    source: text('source').notNull().default('local'),
    /** Turn carrying this version's user message; null until the turn starts. */
    messageTurnId: text('message_turn_id'),
    previewText: text('preview_text').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_branch_versions_group_thread').on(
      table.groupId,
      table.threadId,
    ),
    uniqueIndex('uidx_branch_versions_group_index').on(
      table.groupId,
      table.versionIndex,
    ),
    index('idx_branch_versions_thread').on(table.threadId),
    index('idx_branch_versions_group').on(table.groupId),
  ],
);

export type ConversationBranchVersion =
  typeof conversationBranchVersions.$inferSelect;
export type InsertConversationBranchVersion =
  typeof conversationBranchVersions.$inferInsert;

/**
 * Fork edge captured locally because app-server does not expose the boundary.
 *
 * Recorded per child thread rather than per version row: a thread has exactly
 * one origin, but participates in as many version groups as it has edited
 * turns, so inlining provenance into version rows would duplicate it.
 */
export const conversationBranchEdges = sqliteTable(
  'conversation_branch_edges',
  {
    childThreadId: text('child_thread_id').primaryKey(),
    parentThreadId: text('parent_thread_id').notNull(),
    treeRootThreadId: text('tree_root_thread_id').notNull(),
    /** Turn the fork excluded; the child's history stops right before it. */
    forkBeforeTurnId: text('fork_before_turn_id').notNull(),
    commonPrefixTurnId: text('common_prefix_turn_id').notNull(),
    /** `local` rows came from this client; `adopted` rows came from disk scan. */
    source: text('source').notNull().default('local'),
    /**
     * JSON array of turn ids this child inherited from its ancestors, captured
     * from the fork response. Bounds provenance read-through so a child never
     * reads per-turn data its parent produced after the fork point.
     */
    inheritedTurnIds: text('inherited_turn_ids').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_branch_edges_parent').on(table.parentThreadId),
    index('idx_branch_edges_root').on(table.treeRootThreadId),
  ],
);

export type ConversationBranchEdge =
  typeof conversationBranchEdges.$inferSelect;
export type InsertConversationBranchEdge =
  typeof conversationBranchEdges.$inferInsert;

/**
 * Last viewed member for one conversation branch tree.
 *
 * This is global server-side view state, not a browser preference: whichever
 * device opens a tree member most recently owns the collapsed sidebar target.
 */
export const conversationBranchActiveMembers = sqliteTable(
  'conversation_branch_active_members',
  {
    treeRootThreadId: text('tree_root_thread_id').primaryKey(),
    activeThreadId: text('active_thread_id').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_branch_active_members_active').on(table.activeThreadId),
  ],
);

export type ConversationBranchActiveMember =
  typeof conversationBranchActiveMembers.$inferSelect;
export type InsertConversationBranchActiveMember =
  typeof conversationBranchActiveMembers.$inferInsert;

/**
 * User-facing projects. A project has a stable identity and display name while
 * its primary workspace remains the filesystem execution context.
 */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    workspacePath: text('workspace_path').notNull(),
    workspaceLayoutVersion: integer('workspace_layout_version')
      .notNull()
      .default(0),
    mcpServerIds: text('mcp_server_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    appIds: text('app_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    agentModel: text('agent_model'),
    agentReasoningEffort: text('agent_reasoning_effort'),
    browserSettings: text('browser_settings', { mode: 'json' })
      .$type<{ homeUrl: string; desktopSplit: boolean; allowPopups: boolean }>()
      .notNull()
      .default({
        homeUrl: 'https://www.google.com',
        desktopSplit: true,
        allowPopups: true,
      }),
    sidebarOrder: text('sidebar_order', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_projects_workspace_path').on(table.workspacePath),
    index('idx_projects_name').on(table.name),
  ],
);

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

/** Preview recipes are operator-authored; the complete payload is encrypted. */
export const projectPreviewProfiles = sqliteTable('project_preview_profiles', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  encryptedProfile: text('encrypted_profile').notNull(),
  revision: text('revision').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Agent-owned recipes never replace the administrator's project policy. */
export const agentPreviewRecipes = sqliteTable('agent_preview_recipes', {
  agentId: text('agent_id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  encryptedRecipe: text('encrypted_recipe').notNull(),
  revision: text('revision').notNull(),
  policyRevision: text('policy_revision').notNull(),
  requestId: text('request_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** One preview slot per work-agent family. No credentials or transport URLs. */
export const agentPreviews = sqliteTable('agent_previews', {
  agentId: text('agent_id').primaryKey(),
  threadId: text('thread_id').notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  previewId: text('preview_id').notNull().unique(),
  runId: text('run_id').notNull(),
  requestId: text('request_id').notNull(),
  sourcePath: text('source_path').notNull(),
  sourceSha: text('source_sha'),
  sourceFingerprint: text('source_fingerprint'),
  ownerPersonId: text('owner_person_id'),
  profileRevision: text('profile_revision').notNull(),
  state: text('state').notNull(),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Import provenance preserves contact details without importing login rights. */
export const projectArchiveImports = sqliteTable(
  'project_archive_imports',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceVersion: text('source_version').notNull(),
    importedAt: integer('imported_at').notNull(),
    provenance: text('provenance', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [index('idx_project_archive_imports_project').on(table.projectId)],
);

/** Immutable versions sent to agents, retained so delayed proposals have a base. */
export const projectKnowledgeSnapshots = sqliteTable(
  'project_knowledge_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: text('revision').notNull(),
    files: text('files', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_knowledge_snapshot_revision').on(
      table.projectId,
      table.revision,
    ),
  ],
);

/** Proposed edits never become shared context before explicit acceptance. */
export const projectKnowledgeProposals = sqliteTable(
  'project_knowledge_proposals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    threadId: text('thread_id').notNull(),
    sourceId: text('source_id').notNull(),
    title: text('title').notNull(),
    file: text('file').notNull(),
    baseRevision: text('base_revision').notNull(),
    baseFiles: text('base_files', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull(),
    proposedFiles: text('proposed_files', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull(),
    status: text('status').notNull().default('pending'),
    version: integer('version').notNull().default(1),
    reviewer: text('reviewer'),
    reviewedAt: integer('reviewed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_knowledge_proposals_project').on(
      table.projectId,
      table.createdAt,
    ),
    uniqueIndex('idx_knowledge_proposal_source').on(
      table.projectId,
      table.sourceType,
      table.threadId,
      table.sourceId,
    ),
  ],
);

/** High-level audit trail for changes affecting a project as a whole. */
export const projectActivity = sqliteTable(
  'project_activity',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    label: text('label').notNull(),
    details: text('details', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    actorPersonId: text('actor_person_id'),
    actorName: text('actor_name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_project_activity_project_created').on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export type ProjectActivity = typeof projectActivity.$inferSelect;

/** Extensible project tools (task boards today, other skills later). */
/** Security audit: immutable identity snapshots, retained if a person is removed. */
export const impersonationAudit = sqliteTable('impersonation_audit', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  administratorId: text('administrator_id').notNull(),
  administratorName: text('administrator_name').notNull(),
  personId: text('person_id').notNull(),
  personName: text('person_name').notNull(),
  action: text('action').notNull(),
  method: text('method'),
  route: text('route'),
  createdAt: integer('created_at').notNull(),
});

export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  reference: text('reference').notNull().unique(),
  name: text('name').notNull(),
  email: text('email').unique(),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  phone: text('phone').notNull().default(''),
  role: text('role')
    .$type<'standard' | 'administrator'>()
    .notNull()
    .default('standard'),
  identitySubject: text('identity_subject').unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  theme: text('theme').notNull().default('light'),
  language: text('language').notNull().default('fr'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Personal navigation choices, never included in shared people/project exports. */
export const personNavigationPreferences = sqliteTable(
  'person_navigation_preferences',
  {
    personId: text('person_id')
      .primaryKey()
      .references(() => people.id, { onDelete: 'cascade' }),
    fastNavigationProjectId: text('fast_navigation_project_id').references(
      () => projects.id,
      { onDelete: 'set null' },
    ),
  },
);

/** Local credentials are optional and kept separate from the person profile. */
export const localAuthCredentials = sqliteTable(
  'local_auth_credentials',
  {
    id: text('id').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: integer('locked_until'),
    lastLoginAt: integer('last_login_at'),
    passwordChangedAt: integer('password_changed_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_local_auth_credentials_person').on(table.personId),
    uniqueIndex('uidx_local_auth_credentials_username').on(table.username),
  ],
);

/** Opaque browser sessions; only a SHA-256 digest of the cookie is stored. */
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('idx_auth_sessions_person').on(table.personId),
    index('idx_auth_sessions_expires').on(table.expiresAt),
  ],
);

/** Short-lived, single-use state for an OIDC Authorization Code + PKCE flow. */
export const oidcAuthFlows = sqliteTable(
  'oidc_auth_flows',
  {
    stateHash: text('state_hash').primaryKey(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    returnTo: text('return_to').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('idx_oidc_auth_flows_expires').on(table.expiresAt)],
);

export const projectParticipants = sqliteTable(
  'project_participants',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.personId] })],
);

/** One informational project manager selected from the project participants. */
export const projectManagerAssignments = sqliteTable(
  'project_manager_assignments',
  {
    projectId: text('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_project_manager_person').on(table.personId)],
);

/** Named, project-scoped groups prepared for future deliverable visibility. */
export const projectPersonGroups = sqliteTable(
  'project_person_groups',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_project_person_groups_name').on(
      table.projectId,
      table.name,
    ),
    index('idx_project_person_groups_project').on(table.projectId),
  ],
);

export const projectPersonGroupMembers = sqliteTable(
  'project_person_group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => projectPersonGroups.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.personId] })],
);

export const projectResources = sqliteTable(
  'project_resources',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_project_resources_project').on(table.projectId)],
);

export type ProjectResource = typeof projectResources.$inferSelect;
export type InsertProjectResource = typeof projectResources.$inferInsert;

export const projectDeliverables = sqliteTable(
  'project_deliverables',
  {
    id: text('id').primaryKey(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => projectResources.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    criteria: text('criteria').notNull().default(''),
    confidentiality: text('confidentiality')
      .$type<'standard' | 'restricted'>()
      .notNull()
      .default('standard'),
    authorizedGroupIds: text('authorized_group_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    assigneeId: text('assignee_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    dueAt: integer('due_at'),
    status: text('status').notNull().default('planned'),
    lifecycleStatus: text('lifecycle_status')
      .$type<'draft' | 'in_constitution' | 'finalized' | 'archived'>()
      .notNull()
      .default('draft'),
    currentSnapshotId: text('current_snapshot_id'),
    lastApprovedSnapshotId: text('last_approved_snapshot_id'),
    validationRequired: integer('validation_required', { mode: 'boolean' })
      .notNull()
      .default(false),
    validationStatus: text('validation_status')
      .$type<
        'not_required' | 'pending' | 'approved' | 'rejected' | 'outdated'
      >()
      .notNull()
      .default('not_required'),
    finalizedAt: integer('finalized_at'),
    finalizedByPersonId: text('finalized_by_person_id').references(
      () => people.id,
      { onDelete: 'set null' },
    ),
    finalizedByName: text('finalized_by_name'),
    primaryTaskId: text('primary_task_id').references(() => projectTasks.id, {
      onDelete: 'set null',
    }),
    taskIds: text('task_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    conversations: text('conversations', { mode: 'json' })
      .$type<Array<{ type: 'agent' | 'simple'; id: string }>>()
      .notNull()
      .default([]),
    validatedVersionId: text('validated_version_id'),
    createdByName: text('created_by_name'),
    updatedByName: text('updated_by_name'),
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_deliverables_resource').on(table.resourceId)],
);

export interface DeliverableFile {
  name: string;
  sourcePath: string;
  snapshotPath: string;
  size: number;
  sha256: string;
}
export const projectDeliverableVersions = sqliteTable(
  'project_deliverable_versions',
  {
    id: text('id').primaryKey(),
    deliverableId: text('deliverable_id')
      .notNull()
      .references(() => projectDeliverables.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    note: text('note').notNull().default(''),
    files: text('files', { mode: 'json' }).$type<DeliverableFile[]>().notNull(),
    status: text('status').notNull().default('proposed'),
    reviewer: text('reviewer'),
    reviewedAt: integer('reviewed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_deliverable_version_number').on(
      table.deliverableId,
      table.number,
    ),
  ],
);

/** Stable document identities composing a deliverable. */
export const projectDeliverableDocuments = sqliteTable(
  'project_deliverable_documents',
  {
    id: text('id').primaryKey(),
    deliverableId: text('deliverable_id')
      .notNull()
      .references(() => projectDeliverables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    format: text('format').notNull(),
    sourcePath: text('source_path').notNull(),
    previousSourcePaths: text('previous_source_paths', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    currentVersionNumber: integer('current_version_number')
      .notNull()
      .default(0),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_deliverable_document_source').on(
      table.deliverableId,
      table.sourcePath,
    ),
    index('idx_deliverable_documents_deliverable').on(table.deliverableId),
  ],
);

/** Immutable history for one document, independent from other documents. */
export const projectDeliverableDocumentVersions = sqliteTable(
  'project_deliverable_document_versions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => projectDeliverableDocuments.id, {
        onDelete: 'cascade',
      }),
    number: integer('number').notNull(),
    fileName: text('file_name').notNull(),
    sourcePath: text('source_path').notNull(),
    snapshotPath: text('snapshot_path').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    authorPersonId: text('author_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    authorName: text('author_name').notNull(),
    comment: text('comment').notNull().default(''),
    restoredFromVersionId: text('restored_from_version_id'),
    onlyofficeKey: text('onlyoffice_key'),
    onlyofficeChangesPath: text('onlyoffice_changes_path'),
    onlyofficeChanges: text('onlyoffice_changes', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
    onlyofficeServerVersion: text('onlyoffice_server_version'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_deliverable_document_version_number').on(
      table.documentId,
      table.number,
    ),
    index('idx_deliverable_document_versions_document').on(table.documentId),
  ],
);

export interface DeliverableSnapshotDocument {
  documentId: string;
  documentVersionId: string;
  versionNumber: number;
  sha256: string;
}

/** Immutable composition captured whenever a deliverable is finalized. */
export const projectDeliverableSnapshots = sqliteTable(
  'project_deliverable_snapshots',
  {
    id: text('id').primaryKey(),
    deliverableId: text('deliverable_id')
      .notNull()
      .references(() => projectDeliverables.id, { onDelete: 'cascade' }),
    documents: text('documents', { mode: 'json' })
      .$type<DeliverableSnapshotDocument[]>()
      .notNull(),
    createdByPersonId: text('created_by_person_id').references(
      () => people.id,
      {
        onDelete: 'set null',
      },
    ),
    createdByName: text('created_by_name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_deliverable_snapshots_deliverable').on(table.deliverableId),
  ],
);

/** Append-only audit trail for lifecycle changes. */
export const projectDeliverableLifecycleEvents = sqliteTable(
  'project_deliverable_lifecycle_events',
  {
    id: text('id').primaryKey(),
    deliverableId: text('deliverable_id')
      .notNull()
      .references(() => projectDeliverables.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    snapshotId: text('snapshot_id').references(
      () => projectDeliverableSnapshots.id,
      { onDelete: 'set null' },
    ),
    actorPersonId: text('actor_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    actorName: text('actor_name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_deliverable_lifecycle_events_deliverable').on(
      table.deliverableId,
    ),
  ],
);

/** Human validation decisions attached to an immutable deliverable snapshot. */
export const projectDeliverableValidations = sqliteTable(
  'project_deliverable_validations',
  {
    id: text('id').primaryKey(),
    deliverableId: text('deliverable_id')
      .notNull()
      .references(() => projectDeliverables.id, { onDelete: 'cascade' }),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => projectDeliverableSnapshots.id, {
        onDelete: 'restrict',
      }),
    taskId: text('task_id').references(() => projectTasks.id, {
      onDelete: 'set null',
    }),
    status: text('status')
      .$type<'pending' | 'approved' | 'rejected' | 'cancelled'>()
      .notNull()
      .default('pending'),
    requestedByPersonId: text('requested_by_person_id').references(
      () => people.id,
      { onDelete: 'set null' },
    ),
    requestedByName: text('requested_by_name').notNull(),
    requestedAt: integer('requested_at').notNull(),
    decidedByPersonId: text('decided_by_person_id').references(
      () => people.id,
      { onDelete: 'set null' },
    ),
    decidedByName: text('decided_by_name'),
    decisionComment: text('decision_comment'),
    decidedAt: integer('decided_at'),
  },
  (table) => [
    index('idx_deliverable_validations_deliverable').on(table.deliverableId),
    index('idx_deliverable_validations_snapshot').on(table.snapshotId),
  ],
);

/** Audit trail for enabling, disabling and cancelling deliverable validation. */
export const projectDeliverableValidationEvents = sqliteTable(
  'project_deliverable_validation_events',
  {
    id: text('id').primaryKey(),
    deliverableId: text('deliverable_id')
      .notNull()
      .references(() => projectDeliverables.id, { onDelete: 'cascade' }),
    action: text('action')
      .$type<'enabled' | 'disabled' | 'cancelled'>()
      .notNull(),
    validationId: text('validation_id').references(
      () => projectDeliverableValidations.id,
      { onDelete: 'set null' },
    ),
    reason: text('reason'),
    actorPersonId: text('actor_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    actorName: text('actor_name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_deliverable_validation_events_deliverable').on(
      table.deliverableId,
    ),
  ],
);

export const projectTaskStatuses = sqliteTable(
  'project_task_statuses',
  {
    id: text('id').primaryKey(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => projectResources.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('slate'),
    kind: text('kind').notNull().default('custom'),
    position: integer('position').notNull(),
    system: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_project_task_statuses_resource').on(table.resourceId)],
);

export type ProjectTaskStatus = typeof projectTaskStatuses.$inferSelect;

export const projectTasks = sqliteTable(
  'project_tasks',
  {
    id: text('id').primaryKey(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => projectResources.id, { onDelete: 'cascade' }),
    statusId: text('status_id')
      .notNull()
      .references(() => projectTaskStatuses.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priority: text('priority').notNull().default('normal'),
    parentTaskId: text('parent_task_id'),
    assigneeId: text('assignee_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    subtaskStatus: text('subtask_status').notNull().default('todo'),
    workspacePath: text('workspace_path'),
    executionMode: text('execution_mode').notNull().default('manual'),
    agentState: text('agent_state').notNull().default('manual'),
    estimateMinutes: integer('estimate_minutes').notNull().default(0),
    progress: integer('progress').notNull().default(0),
    startAt: integer('start_at'),
    dueAt: integer('due_at'),
    validationCriteria: text('validation_criteria').notNull().default(''),
    labels: text('labels', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    linkedThreadId: text('linked_thread_id'),
    linkedSimpleChatId: text('linked_simple_chat_id'),
    linkedFilePath: text('linked_file_path'),
    position: integer('position').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_project_tasks_resource').on(table.resourceId),
    index('idx_project_tasks_status_position').on(
      table.statusId,
      table.position,
    ),
  ],
);

export type ProjectTask = typeof projectTasks.$inferSelect;

export const projectTaskActivity = sqliteTable(
  'project_task_activity',
  {
    id: text('id').primaryKey(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => projectResources.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    taskTitle: text('task_title').notNull(),
    parentTaskId: text('parent_task_id'),
    action: text('action').notNull(),
    changes: text('changes', { mode: 'json' })
      .$type<Record<string, { before: unknown; after: unknown }>>()
      .notNull()
      .default({}),
    actorPersonId: text('actor_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    actorName: text('actor_name').notNull().default('Système'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_project_task_activity_resource_created').on(
      table.resourceId,
      table.createdAt,
    ),
  ],
);

export type ProjectTaskActivity = typeof projectTaskActivity.$inferSelect;

export const projectTaskDependencies = sqliteTable(
  'project_task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: text('depends_on_task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
    index('idx_project_task_dependencies_task').on(table.taskId),
  ],
);

export type ProjectTaskDependency = typeof projectTaskDependencies.$inferSelect;

/** Filesystem execution contexts attached to a user-facing project. */
export const projectWorkspaces = sqliteTable(
  'project_workspaces',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    primary: integer('is_primary', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_project_workspaces_path').on(table.path),
    uniqueIndex('idx_project_workspaces_id_project').on(
      table.id,
      table.projectId,
    ),
    uniqueIndex('idx_project_workspaces_primary')
      .on(table.projectId)
      .where(sql`${table.primary} = 1`),
    index('idx_project_workspaces_project').on(table.projectId),
  ],
);

export type ProjectWorkspace = typeof projectWorkspaces.$inferSelect;
export type InsertProjectWorkspace = typeof projectWorkspaces.$inferInsert;

/** A project resource definition, independent from an optional local folder. */
export const projectWorkspaceResources = sqliteTable(
  'project_workspace_resources',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    localWorkspaceId: text('local_workspace_id').references(
      () => projectWorkspaces.id,
      { onDelete: 'set null' },
    ),
    name: text('name').notNull(),
    type: text('type')
      .$type<'local' | 'git' | 'ssh' | 'sftp' | 'ftp' | 'ftps'>()
      .notNull(),
    address: text('address'),
    rootPath: text('root_path').notNull().default('/'),
    accessMode: text('access_mode')
      .$type<'read_only' | 'read_write'>()
      .notNull()
      .default('read_only'),
    capabilities: text('capabilities', { mode: 'json' })
      .$type<{ read: boolean; write: boolean; execute: false }>()
      .notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    connectionState: text('connection_state')
      .$type<'local' | 'untested' | 'connected' | 'unreachable' | 'disabled'>()
      .notNull(),
    lastCheckedAt: integer('last_checked_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_project_workspace_resources_project').on(table.projectId),
    uniqueIndex('idx_project_workspace_resources_local').on(
      table.localWorkspaceId,
    ),
  ],
);

/** Encrypted connection material. Values are never returned by the API. */
export const projectWorkspaceSecrets = sqliteTable(
  'project_workspace_secrets',
  {
    resourceId: text('resource_id')
      .primaryKey()
      .references(() => projectWorkspaceResources.id, { onDelete: 'cascade' }),
    encryptedValue: text('encrypted_value').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
);

export type ProjectWorkspaceResource =
  typeof projectWorkspaceResources.$inferSelect;

/** Connection configuration only: no directory, access grant or plaintext secret. */
export const projectConnections = sqliteTable(
  'project_connections',
  {
    // During the expand phase the legacy resource remains the write authority.
    id: text('id')
      .primaryKey()
      .references(() => projectWorkspaceResources.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    protocol: text('protocol')
      .$type<'git' | 'ssh' | 'sftp' | 'ftp' | 'ftps'>()
      .notNull(),
    address: text('address'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    connectionState: text('connection_state')
      .$type<'untested' | 'connected' | 'unreachable' | 'disabled'>()
      .notNull(),
    lastCheckedAt: integer('last_checked_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_project_connections_id_project').on(
      table.id,
      table.projectId,
    ),
    index('idx_project_connections_project').on(table.projectId),
    check(
      'project_connections_protocol',
      sql`${table.protocol} IN ('git', 'ssh', 'sftp', 'ftp', 'ftps')`,
    ),
  ],
);

/** A local directory or a root accessible through a connection; not an agent grant. */
export const projectLocations = sqliteTable(
  'project_locations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind')
      .$type<'managed_local' | 'attached_local' | 'remote'>()
      .notNull(),
    path: text('path').notNull(),
    localWorkspaceId: text('local_workspace_id'),
    connectionId: text('connection_id'),
    legacyResourceId: text('legacy_resource_id').references(
      () => projectWorkspaceResources.id,
      { onDelete: 'cascade' },
    ),
    accessMode: text('access_mode')
      .$type<'read_only' | 'read_write'>()
      .notNull(),
    capabilities: text('capabilities', { mode: 'json' })
      .$type<{ read: boolean; write: boolean; execute: false }>()
      .notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_project_locations_project').on(table.projectId),
    index('idx_project_locations_connection').on(table.connectionId),
    uniqueIndex('idx_project_locations_workspace').on(table.localWorkspaceId),
    uniqueIndex('idx_project_locations_legacy_resource').on(
      table.legacyResourceId,
    ),
    uniqueIndex('idx_project_locations_managed')
      .on(table.projectId)
      .where(sql`${table.kind} = 'managed_local'`),
    foreignKey({
      columns: [table.connectionId, table.projectId],
      foreignColumns: [projectConnections.id, projectConnections.projectId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.localWorkspaceId, table.projectId],
      foreignColumns: [projectWorkspaces.id, projectWorkspaces.projectId],
    }).onDelete('cascade'),
    check(
      'project_locations_kind',
      sql`(${table.kind} IN ('managed_local', 'attached_local') AND ${table.localWorkspaceId} IS NOT NULL AND ${table.connectionId} IS NULL AND ${table.legacyResourceId} IS NULL) OR (${table.kind} = 'remote' AND ${table.localWorkspaceId} IS NULL AND ${table.connectionId} IS NOT NULL)`,
    ),
    check(
      'project_locations_access',
      sql`${table.accessMode} IN ('read_only', 'read_write')`,
    ),
  ],
);

export type ProjectConnection = typeof projectConnections.$inferSelect;
export type ProjectLocation = typeof projectLocations.$inferSelect;

/** Explicit local snapshot of an external resource, suitable for activities. */
export const projectWorkspaceCopies = sqliteTable(
  'project_workspace_copies',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceResourceId: text('source_resource_id').notNull(),
    localWorkspaceId: text('local_workspace_id')
      .notNull()
      .references(() => projectWorkspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    branch: text('branch'),
    revision: text('revision').notNull(),
    state: text('state').$type<'ready' | 'revoked' | 'error'>().notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_project_workspace_copies_project').on(table.projectId),
    index('idx_project_workspace_copies_source').on(table.sourceResourceId),
    uniqueIndex('idx_project_workspace_copies_local').on(
      table.localWorkspaceId,
    ),
  ],
);

export type ProjectWorkspaceCopy = typeof projectWorkspaceCopies.$inferSelect;

/** Persistent one-to-one reservation, independent of the currently selected cwd. */
export const projectGitCopyOwners = sqliteTable('project_git_copy_owners', {
  copyId: text('copy_id')
    .primaryKey()
    .references(() => projectWorkspaceCopies.id, { onDelete: 'cascade' }),
  agentThreadId: text('agent_thread_id').notNull().unique(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
});

/** Reusable one-way copy rule. Synchronization is always explicit. */
export const projectWorkspaceTransfers = sqliteTable(
  'project_workspace_transfers',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sourceResourceId: text('source_resource_id').notNull(),
    destinationWorkspaceId: text('destination_workspace_id')
      .notNull()
      .references(() => projectWorkspaces.id, { onDelete: 'cascade' }),
    sourcePath: text('source_path').notNull().default(''),
    destinationPath: text('destination_path').notNull().default(''),
    exclusions: text('exclusions', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    conflictPolicy: text('conflict_policy')
      .$type<'skip' | 'overwrite'>()
      .notNull()
      .default('skip'),
    propagateDeletes: integer('propagate_deletes', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_project_workspace_transfers_project').on(table.projectId),
    index('idx_project_workspace_transfers_source').on(table.sourceResourceId),
    index('idx_project_workspace_transfers_destination').on(
      table.destinationWorkspaceId,
    ),
  ],
);

export type ProjectWorkspaceTransfer =
  typeof projectWorkspaceTransfers.$inferSelect;

/** Immutable preview and result of one transfer attempt. */
export const projectWorkspaceTransferRuns = sqliteTable(
  'project_workspace_transfer_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    transferId: text('transfer_id')
      .notNull()
      .references(() => projectWorkspaceTransfers.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<
        | 'previewed'
        | 'running'
        | 'success'
        | 'completed_with_conflicts'
        | 'error'
      >()
      .notNull(),
    planHash: text('plan_hash').notNull(),
    changes: text('changes', { mode: 'json' })
      .$type<
        Array<{
          path: string;
          action: 'create' | 'update' | 'conflict' | 'delete' | 'unchanged';
          size: number;
          sourceHash: string | null;
          destinationHash: string | null;
        }>
      >()
      .notNull(),
    summary: text('summary', { mode: 'json' })
      .$type<Record<string, number>>()
      .notNull(),
    stagingPath: text('staging_path'),
    error: text('error'),
    actorPersonId: text('actor_person_id'),
    actorName: text('actor_name').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('idx_workspace_transfer_runs_transfer').on(
      table.transferId,
      table.startedAt,
    ),
    index('idx_workspace_transfer_runs_project').on(
      table.projectId,
      table.startedAt,
    ),
  ],
);

export type ProjectWorkspaceTransferRun =
  typeof projectWorkspaceTransferRuns.$inferSelect;

/**
 * Stable folder selected by one project context.
 *
 * resourceId intentionally has no foreign key: detaching a secondary resource
 * must keep the reference so the user can repair it instead of silently being
 * moved to the primary workspace.
 */
export const projectActiveFolders = sqliteTable(
  'project_active_folders',
  {
    contextType: text('context_type')
      .$type<'agent' | 'simple_chat' | 'task' | 'deliverable'>()
      .notNull(),
    contextId: text('context_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    resourceId: text('resource_id').notNull(),
    relativePath: text('relative_path').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.contextType, table.contextId] }),
    index('idx_project_active_folders_project').on(table.projectId),
    index('idx_project_active_folders_resource').on(table.resourceId),
  ],
);

export type ProjectActiveFolder = typeof projectActiveFolders.$inferSelect;

/** Explicit project membership for Codex work-agent conversations. */
export const projectAgentThreads = sqliteTable(
  'project_agent_threads',
  {
    threadId: text('thread_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspacePath: text('workspace_path').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_project_agent_threads_project').on(table.projectId),
    index('idx_project_agent_threads_workspace').on(table.workspacePath),
  ],
);

/** Server-owned wakeups: a schedule is not an execution or an access grant. */
export const agentMonitors = sqliteTable(
  'agent_monitors',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => projectAgentThreads.threadId, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    name: text('name').notNull(),
    instructions: text('instructions').notNull(),
    intervalMs: integer('interval_ms'),
    nextRunAt: integer('next_run_at'),
    expiresAt: integer('expires_at').notNull(),
    maxRuns: integer('max_runs').notNull(),
    maxRunMs: integer('max_run_ms').notNull(),
    runCount: integer('run_count').notNull().default(0),
    accessMode: text('access_mode')
      .$type<'readOnly' | 'workspaceWrite'>()
      .notNull()
      .default('readOnly'),
    status: text('status')
      .$type<
        | 'active'
        | 'paused'
        | 'completed'
        | 'expired'
        | 'exhausted'
        | 'needs_attention'
      >()
      .notNull()
      .default('active'),
    lastReason: text('last_reason'),
    lastResultDigest: text('last_result_digest'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_agent_monitors_request').on(
      table.threadId,
      table.requestId,
    ),
    index('idx_agent_monitors_due').on(table.status, table.nextRunAt),
    index('idx_agent_monitors_project').on(table.projectId, table.updatedAt),
    check(
      'agent_monitor_limits',
      sql`${table.maxRuns} BETWEEN 1 AND 100 AND ${table.maxRunMs} BETWEEN 30000 AND 1800000 AND ${table.runCount} >= 0`,
    ),
    check(
      'agent_monitor_interval',
      sql`${table.intervalMs} IS NULL OR ${table.intervalMs} BETWEEN 60000 AND 2592000000`,
    ),
  ],
);

/** The nullable reservation serializes wakeups across processes and monitors. */
export const agentMonitorRuns = sqliteTable(
  'agent_monitor_runs',
  {
    id: text('id').primaryKey(),
    monitorId: text('monitor_id')
      .notNull()
      .references(() => agentMonitors.id, { onDelete: 'cascade' }),
    activeThreadId: text('active_thread_id'),
    turnId: text('turn_id'),
    status: text('status')
      .$type<
        | 'claimed'
        | 'dispatching'
        | 'running'
        | 'completed'
        | 'failed'
        | 'deferred'
        | 'uncertain'
      >()
      .notNull(),
    scheduledAt: integer('scheduled_at').notNull(),
    claimedAt: integer('claimed_at').notNull(),
    leaseUntil: integer('lease_until').notNull(),
    finishedAt: integer('finished_at'),
    result: text('result').notNull().default(''),
    reason: text('reason'),
    disposition: text('disposition')
      .$type<'continue' | 'complete' | 'attention'>()
      .notNull()
      .default('continue'),
    changed: integer('changed', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    uniqueIndex('idx_agent_monitor_active_thread').on(table.activeThreadId),
    index('idx_agent_monitor_runs_history').on(
      table.monitorId,
      table.claimedAt,
    ),
    index('idx_agent_monitor_runs_lease').on(table.status, table.leaseUntil),
  ],
);

/** Lightweight OpenAI API conversations, separate from Codex work threads. */
export const simpleChatThreads = sqliteTable(
  'simple_chat_threads',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    model: text('model').notNull(),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }),
    cwd: text('cwd').notNull().default('/workspaces'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_simple_chat_threads_updated').on(table.updatedAt),
    index('idx_simple_chat_threads_cwd_updated').on(table.cwd, table.updatedAt),
  ],
);

export const simpleChatMessages = sqliteTable(
  'simple_chat_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => simpleChatThreads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    model: text('model'),
    sources: text('sources', { mode: 'json' })
      .$type<Array<{ title: string; url: string }>>()
      .notNull()
      .default([]),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_simple_chat_messages_thread_created').on(
      table.threadId,
      table.createdAt,
    ),
  ],
);

/** Unknown legacy owners deliberately remain absent (administrator-only). */
export const conversationOwners = sqliteTable(
  'conversation_owners',
  {
    kind: text('kind').$type<'agent' | 'simple'>().notNull(),
    conversationId: text('conversation_id').notNull(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.kind, table.conversationId] })],
);

/** Private Web Push capabilities; never returned by profile/list endpoints. */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint_secret').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth_secret').notNull(),
    label: text('label').notNull(),
    language: text('language').notNull().default('en'),
    completed: integer('completed', { mode: 'boolean' })
      .notNull()
      .default(true),
    approvals: integer('approvals', { mode: 'boolean' })
      .notNull()
      .default(true),
    questions: integer('questions', { mode: 'boolean' })
      .notNull()
      .default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastTestAt: integer('last_test_at'),
  },
  (table) => [index('idx_push_person').on(table.personId)],
);

/** Receipt deduplication also covers subscription changes and zero recipients. */
export const pushEvents = sqliteTable('push_events', {
  eventKey: text('event_key').primaryKey(),
  createdAt: integer('created_at').notNull(),
});

/** Durable per-device outbox. A stable ID/tag coalesces ambiguous network retries. */
export const pushDeliveries = sqliteTable(
  'push_deliveries',
  {
    id: text('id').primaryKey(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    threadId: text('thread_id'),
    requestInstanceId: text('request_instance_id'),
    kind: text('kind')
      .$type<'completed' | 'approvals' | 'questions' | 'test'>()
      .notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    leaseAt: integer('lease_at'),
  },
  (table) => [
    uniqueIndex('idx_push_event_device').on(
      table.subscriptionId,
      table.eventKey,
    ),
    index('idx_push_due').on(table.status, table.nextAttemptAt),
  ],
);

/** Revocable server-to-server document capabilities, never general login tokens. */
export const documentAccessSessions = sqliteTable('document_access_sessions', {
  id: text('id').primaryKey(),
  path: text('path').notNull(),
  projectId: text('project_id').references(() => projects.id, {
    onDelete: 'cascade',
  }),
  personId: text('person_id').references(() => people.id, {
    onDelete: 'cascade',
  }),
  administrator: integer('administrator', { mode: 'boolean' }).notNull(),
  writable: integer('writable', { mode: 'boolean' }).notNull(),
  impersonation: text('impersonation', { mode: 'json' }).$type<{
    sessionId: string;
    administratorId: string;
    administratorName: string;
    personId: string;
    personName: string;
    expiresAt: number;
  }>(),
  expiresAt: integer('expires_at').notNull(),
});
