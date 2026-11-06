import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../database/database.testing';
import {
  projects,
  projectWorkspaces,
  simpleChatMessages,
} from '../database/schema';
import type { ThreadsService } from '../threads/threads.service';
import { SimpleChatService } from './simple-chat.service';
import type { ProjectKnowledgeService } from '../project-knowledge/project-knowledge.service';
import type { KnowledgeProposalsService } from '../project-knowledge/knowledge-proposals.service';

describe('SimpleChatService execution backend', () => {
  const database = createTestDatabase();
  const runProjectStructuredPrompt = vi.fn();
  const activeFolders = {
    set: vi.fn(),
    get: vi.fn(() => null),
    resolve: vi.fn(() => '/workspaces/project'),
  };
  const service = new SimpleChatService(
    database.db,
    {
      runProjectStructuredPrompt,
    } as unknown as ThreadsService,
    activeFolders as never,
  );

  beforeEach(() => {
    database.db.delete(simpleChatMessages).run();
    runProjectStructuredPrompt.mockReset();
    database.db
      .insert(projects)
      .values({
        id: 'project-1',
        name: 'Project',
        workspacePath: '/workspaces/project',
        mcpServerIds: [],
        appIds: [],
        agentModel: 'gpt-project',
        agentReasoningEffort: 'high',
        createdAt: 1,
        updatedAt: 1,
      })
      .onConflictDoNothing()
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'workspace-1',
        projectId: 'project-1',
        name: 'Primary',
        path: '/workspaces/project',
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .onConflictDoNothing()
      .run();
  });

  afterAll(() => database.sqlite.close());

  it('uses Codex with the project workspace when selected globally', async () => {
    service.setBackend('codex');
    const created = service.createThread({ projectId: 'project-1' });
    runProjectStructuredPrompt.mockResolvedValue('Réponse Codex');

    const result = await service.respond(created.thread.id, {
      message: 'Bonjour',
    });

    const request = runProjectStructuredPrompt.mock.calls[0]?.[0] as
      | { cwd?: unknown; prompt?: unknown }
      | undefined;
    expect(request?.cwd).toBe('/workspaces/project');
    expect(request?.prompt).toContain('Utilisateur : Bonjour');
    expect(result.message).toMatchObject({
      content: 'Réponse Codex',
      model: 'gpt-project',
    });
    expect(
      database.db
        .select()
        .from(simpleChatMessages)
        .where(eq(simpleChatMessages.threadId, created.thread.id))
        .all(),
    ).toHaveLength(2);
  });

  it('preserves the submitted whitespace in storage and in the model request', async () => {
    service.setBackend('codex');
    const created = service.createThread({ projectId: 'project-1' });
    runProjectStructuredPrompt.mockResolvedValue('Réponse');
    const message = '\n\n  Bonjour\r\nSuite\n\n';
    await service.respond(created.thread.id, { message });
    const stored = database.db
      .select()
      .from(simpleChatMessages)
      .where(eq(simpleChatMessages.threadId, created.thread.id))
      .all()
      .find((m) => m.role === 'user');
    expect(stored?.content).toBe(message);
    const request = runProjectStructuredPrompt.mock.calls[0]?.[0] as
      | { prompt?: unknown }
      | undefined;
    expect(request?.prompt).toContain(message);
    await expect(
      service.respond(created.thread.id, { message: ' \n\n ' }),
    ).rejects.toThrow('message is required');
  });

  it('rejects an unknown backend', () => {
    expect(() => service.setBackend('other')).toThrow(
      'Invalid Simple Chat backend',
    );
  });

  it('refuses to move an existing conversation to another project', () => {
    database.db
      .insert(projects)
      .values({
        id: 'project-2',
        name: 'Other project',
        workspacePath: '/workspaces/other',
        createdAt: 1,
        updatedAt: 1,
      })
      .onConflictDoNothing()
      .run();
    const created = service.createThread({ projectId: 'project-1' });
    expect(() =>
      service.updateThread(created.thread.id, { projectId: 'project-2' }),
    ).toThrow('Conversations cannot be moved between projects');
  });

  it('captures simple-chat suggestions with the persistent conversation and message as their source', async () => {
    const capture = vi.fn();
    const simple = new SimpleChatService(
      database.db,
      { runProjectStructuredPrompt } as unknown as ThreadsService,
      activeFolders as never,
      undefined,
      { capture } as unknown as KnowledgeProposalsService,
    );
    simple.setBackend('codex');
    const created = simple.createThread({ projectId: 'project-1' });
    runProjectStructuredPrompt.mockResolvedValue('A memory suggestion');
    const result = await simple.respond(created.thread.id, {
      message: 'Remember this',
    });
    expect(capture).toHaveBeenCalledWith(
      'project-1',
      {
        sourceType: 'simple',
        threadId: created.thread.id,
        sourceId: result.message.id,
      },
      'A memory suggestion',
    );
    capture.mockImplementation(() => {
      throw new Error('Proposal storage unavailable');
    });
    await expect(
      simple.respond(created.thread.id, { message: 'Continue anyway' }),
    ).resolves.toMatchObject({ message: { content: 'A memory suggestion' } });
  });

  it('provides fresh shared knowledge to OpenAI without saving it as a user message', async () => {
    const contextForProject = vi
      .fn()
      .mockResolvedValue('Current project knowledge');
    const simple = new SimpleChatService(
      database.db,
      { runProjectStructuredPrompt } as unknown as ThreadsService,
      activeFolders as never,
      { contextForProject } as unknown as ProjectKnowledgeService,
    );
    simple.setBackend('openai');
    const created = simple.createThread({ projectId: 'project-1' });
    const response = vi
      .spyOn(
        simple as unknown as {
          createResponse: (
            model: string,
            messages: Array<{ role: string; content: string }>,
          ) => Promise<unknown>;
        },
        'createResponse',
      )
      .mockResolvedValue({
        output: [{ content: [{ type: 'output_text', text: 'Answer' }] }],
      });
    await simple.respond(created.thread.id, { message: 'Question' });
    expect(contextForProject).toHaveBeenCalledWith('project-1');
    expect(response).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        { role: 'user', content: 'Current project knowledge' },
        { role: 'user', content: 'Question' },
      ]),
    );
    expect(
      database.db
        .select()
        .from(simpleChatMessages)
        .where(eq(simpleChatMessages.threadId, created.thread.id))
        .all()
        .map((item) => item.content),
    ).toEqual(['Question', 'Answer']);
    response.mockRestore();
  });

  it('uses the stable active folder after the project primary changes', async () => {
    service.setBackend('codex');
    const created = service.createThread({ projectId: 'project-1' });
    activeFolders.resolve.mockReturnValueOnce('/workspaces/legacy');
    runProjectStructuredPrompt.mockResolvedValue('Réponse');
    await service.respond(created.thread.id, { message: 'Continue' });
    expect(runProjectStructuredPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspaces/legacy' }),
    );
  });
});
