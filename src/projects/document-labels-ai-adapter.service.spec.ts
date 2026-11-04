import { EventEmitter } from 'node:events';
import { DocumentLabelsAiAdapter } from './document-labels-ai-adapter.service';
import { DocumentOrganizationService } from '../deliverables/document-organization.service';
import { ThreadsService } from '../threads/threads.service';

describe('document classifier execution', () => {
  it('keeps the classification turn read-only even when project defaults allow writes', async () => {
    const client = new EventEmitter();
    const startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'classifier' } });
    const startTurn = vi.fn().mockImplementation(() => {
      client.emit('notification', {
        method: 'turn/completed',
        params: {
          threadId: 'classifier',
          turn: {
            status: 'completed',
            items: [{ type: 'agentMessage', text: '{"labels":[]}' }],
          },
        },
      });
      return Promise.resolve();
    });
    const request = vi.fn().mockResolvedValue({});
    const threads = {
      startThread,
      startTurn,
      codex: { getClient: () => client, request },
      runProjectStructuredPrompt: function (
        input: Parameters<ThreadsService['runProjectStructuredPrompt']>[0],
      ) {
        return ThreadsService.prototype.runProjectStructuredPrompt.call(
          this,
          input,
        ) as Promise<string>;
      },
    } as unknown as ThreadsService;
    let runner!: Parameters<DocumentOrganizationService['setRunner']>[0];
    const organization = {
      setRunner: (value: typeof runner) => {
        runner = value;
      },
    } as unknown as DocumentOrganizationService;
    new DocumentLabelsAiAdapter(organization, threads).onModuleInit();
    const result = await runner({
      cwd: '/project',
      prompt: 'Classify metadata',
      instructions: 'Use metadata only',
      outputSchema: {} as never,
    });
    expect(result).toBe('{"labels":[]}');
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true, sandbox: 'read-only' }),
    );
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }),
    );
    expect(request).toHaveBeenCalledWith('thread/delete', {
      threadId: 'classifier',
    });
    expect(client.listenerCount('notification')).toBe(0);
  });
});
