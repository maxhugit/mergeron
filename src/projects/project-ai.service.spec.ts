import { ProjectAiService } from './project-ai.service';
it('generates project reports through a locked read-only CLI turn without an API call', async () => {
  const runProjectStructuredPrompt = vi
    .fn()
    .mockResolvedValue('  Project report  ');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    const service = new ProjectAiService({
      runProjectStructuredPrompt,
    } as never);
    await expect(
      service.runProjectAutomation('Analyse the task board', '/workspaces/p'),
    ).resolves.toBe('Project report');
    expect(runProjectStructuredPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspaces/p',
        prompt: 'Analyse the task board',
        lockedReadOnly: true,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
