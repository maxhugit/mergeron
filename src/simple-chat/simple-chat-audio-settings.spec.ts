import { createTestDatabase } from '../database/database.testing';
import { SimpleChatService } from './simple-chat.service';

it('inherits chat until an explicit audio choice exists, then keeps both independent without API fallback', async () => {
  const db = createTestDatabase();
  const transcribe = vi
    .fn()
    .mockRejectedValue(new Error('CLI voice unavailable'));
  const service = new SimpleChatService(
    db.db,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    { transcribe } as never,
  );
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  try {
    service.setBackend('codex');
    expect(service.getAudioBackend()).toBe('codex');
    service.setAudioBackend('openai');
    expect(service.getBackend()).toBe('codex');
    expect(service.getAudioBackend()).toBe('openai');
    service.setBackend('openai');
    service.setAudioBackend('codex');
    await expect(
      service.transcribeAudio({
        bytes: Buffer.from('recording'),
        filename: 'dictation.wav',
        mimeType: 'audio/wav',
      }),
    ).rejects.toThrow('CLI voice unavailable');
    expect(transcribe).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => service.setAudioBackend('unknown')).toThrow();
    expect(service.getStatus()).toMatchObject({
      backend: 'openai',
      audioBackend: 'codex',
      audioExperimental: true,
    });
  } finally {
    vi.unstubAllGlobals();
    db.sqlite.close();
  }
});
