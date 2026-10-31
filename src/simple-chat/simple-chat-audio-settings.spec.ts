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

it('negotiates only the selected CLI engine and still closes its session after a settings change', async () => {
  const db = createTestDatabase();
  const audio = {
    start: vi.fn().mockResolvedValue({ id: 'owned', sdp: 'answer' }),
    finish: vi.fn().mockResolvedValue({ text: 'Texte dicté' }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
  };
  const service = new SimpleChatService(
    db.db,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    audio as never,
  );
  try {
    service.setAudioBackend('openai');
    expect(() => service.startAudioSession('offer')).toThrow(/pas sélectionné/);
    expect(audio.start).not.toHaveBeenCalled();
    service.setAudioBackend('codex');
    await expect(service.startAudioSession('offer')).resolves.toEqual({
      id: 'owned',
      sdp: 'answer',
    });
    expect(audio.start).toHaveBeenCalledWith('offer');
    service.setAudioBackend('openai');
    await expect(service.finishAudioSession('owned')).resolves.toEqual({
      text: 'Texte dicté',
    });
    await expect(service.cancelAudioSession('owned')).resolves.toEqual({
      ok: true,
    });
    expect(audio.finish).toHaveBeenCalledWith('owned');
    expect(audio.cancel).toHaveBeenCalledWith('owned');
  } finally {
    db.sqlite.close();
  }
});
