import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase } from './database.testing';
import * as schema from './schema';

it('removes retired conversations and links while preserving agents, project work and settings', () => {
  const test = createTestDatabase();
  const db = test.db;
  try {
    db.insert(schema.projects)
      .values({
        id: 'p',
        name: 'Project',
        workspacePath: '/workspaces/p',
        sidebarOrder: ['agent:a', 'simple:old', 'resource:r'],
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.projectResources)
      .values({
        id: 'r',
        projectId: 'p',
        type: 'deliverable_board',
        name: 'Work',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.projectAgentThreads)
      .values({
        threadId: 'a',
        projectId: 'p',
        workspacePath: '/workspaces/p',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.simpleChatThreads)
      .values({
        id: 'old',
        projectId: 'p',
        title: 'Retired',
        model: 'old',
        cwd: '/workspaces/p',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.simpleChatMessages)
      .values({
        id: 'm',
        threadId: 'old',
        role: 'user',
        content: 'retired content',
        createdAt: 1,
      })
      .run();
    db.insert(schema.projectDeliverables)
      .values({
        id: 'd',
        resourceId: 'r',
        title: 'Preserved deliverable',
        conversations: [
          { type: 'agent', id: 'a' },
          { type: 'simple', id: 'old' },
        ],
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.projectTaskStatuses)
      .values({
        id: 's',
        resourceId: 'r',
        name: 'Todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.projectTasks)
      .values({
        id: 't',
        resourceId: 'r',
        statusId: 's',
        title: 'Preserved task',
        linkedThreadId: 'a',
        linkedSimpleChatId: 'old',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    for (const key of [
      'simple-chat:backend',
      'simple-chat:audio-backend',
      'general.updateBackupMode',
    ])
      db.insert(schema.settings)
        .values({
          key,
          value: key.startsWith('simple') ? 'openai' : 'minimal',
          type: 'string',
          category: key.startsWith('simple') ? 'simple-chat' : 'general',
          description: '',
          defaultValue: '',
          constraints: '{}',
          updatedAt: 1,
        })
        .run();
    db.insert(schema.people)
      .values({
        id: 'person',
        reference: 'P1',
        name: 'Owner',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    for (const [kind, conversationId] of [
      ['agent', 'a'],
      ['simple', 'old'],
    ] as const)
      db.insert(schema.conversationOwners)
        .values({ kind, conversationId, personId: 'person' })
        .run();
    for (const [contextType, contextId] of [
      ['agent', 'a'],
      ['simple_chat', 'old'],
    ] as const)
      db.insert(schema.projectActiveFolders)
        .values({
          contextType,
          contextId,
          projectId: 'p',
          resourceId: 'r',
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
    // Source identifiers are scoped to a conversation, not globally unique.
    for (const threadId of ['old', 'another-retired-thread'])
      db.insert(schema.projectKnowledgeProposals)
        .values({
          id: `proposal-${threadId}`,
          projectId: 'p',
          sourceType: 'simple',
          threadId,
          sourceId: 'same-source-id',
          title: 'Retained review',
          file: 'DECISIONS.md',
          baseRevision: 'rev',
          baseFiles: { 'DECISIONS.md': 'Before' },
          proposedFiles: { 'DECISIONS.md': 'After' },
          status: 'accepted',
          reviewer: 'Owner',
          reviewedAt: 2,
          createdAt: 1,
          updatedAt: 2,
        })
        .run();
    const sql = readFileSync(
      join(process.cwd(), 'drizzle/0075_retire_simple_conversations.sql'),
      'utf8',
    );
    test.sqlite.exec(sql);
    expect(db.select().from(schema.simpleChatThreads).all()).toHaveLength(0);
    expect(db.select().from(schema.simpleChatMessages).all()).toHaveLength(0);
    expect(db.select().from(schema.projectAgentThreads).all()).toHaveLength(1);
    expect(db.select().from(schema.projectTasks).get()).toMatchObject({
      title: 'Preserved task',
      linkedThreadId: 'a',
      linkedSimpleChatId: null,
    });
    expect(db.select().from(schema.projectDeliverables).get()).toMatchObject({
      title: 'Preserved deliverable',
      conversations: [{ type: 'agent', id: 'a' }],
    });
    expect(db.select().from(schema.projects).get()?.sidebarOrder).toEqual([
      'agent:a',
      'resource:r',
    ]);
    expect(
      db
        .select()
        .from(schema.settings)
        .all()
        .map((row) => row.key),
    ).toEqual(['general.updateBackupMode']);
    expect(db.select().from(schema.conversationOwners).all()).toEqual([
      { kind: 'agent', conversationId: 'a', personId: 'person' },
    ]);
    expect(
      db
        .select()
        .from(schema.projectActiveFolders)
        .all()
        .map((row) => row.contextType),
    ).toEqual(['agent']);
    const reviews = db.select().from(schema.projectKnowledgeProposals).all();
    expect(reviews).toHaveLength(2);
    expect(new Set(reviews.map((row) => row.threadId)).size).toBe(2);
    for (const review of reviews)
      expect(review).toMatchObject({
        sourceType: 'retired',
        status: 'accepted',
        reviewer: 'Owner',
        reviewedAt: 2,
        proposedFiles: { 'DECISIONS.md': 'After' },
      });
    test.sqlite.exec(sql);
    expect(db.select().from(schema.projectAgentThreads).all()).toHaveLength(1);
    expect(test.sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    test.sqlite.close();
  }
});
