import { validateResult } from './transcription-result';
const result = () => ({
  text: 'Bonjour',
  language: 'fr',
  languageProbability: 0.98,
  duration: 2,
  segments: [{ start: 0, end: 1, text: 'Bonjour', speaker: 'speaker_1' }],
  diarization: { state: 'ready', identitiesKnown: true, name: 'private' },
  model: { name: 'faster-whisper-small', revision: 'a'.repeat(40) },
  token: 'secret',
});
describe('worker result boundary', () => {
  it('keeps anonymous speakers and strips extra worker data', () => {
    const clean = validateResult(result());
    expect(clean.diarization).toEqual({
      state: 'ready',
      identitiesKnown: false,
      speakerCount: 1,
    });
    expect(clean).not.toHaveProperty('token');
  });
  it.each([NaN, Infinity, -1, 7202])('rejects invalid time %s', (time) => {
    const value = result();
    value.segments[0].end = time;
    expect(() => validateResult(value)).toThrow('TRANSCRIPTION_INVALID_RESULT');
  });
  it('rejects named identities', () => {
    const value = result();
    value.segments[0].speaker = 'Max';
    expect(() => validateResult(value)).toThrow();
  });
  it('preserves partial ASR success with failed diarization', () => {
    const value = result();
    value.diarization.state = 'failed';
    expect(validateResult(value).diarization).toEqual({
      state: 'failed',
      reason: 'diarization_failed',
    });
  });
});

describe('acoustic diarization metadata', () => {
  const acoustic = () => ({
    ...result(),
    segments: [
      { start: 0, end: 1, text: 'Oui', speaker: 'SPEAKER_00' as string | null },
    ],
    diarization: {
      state: 'ready',
      speakerCount: 3,
      warnings: [{ code: 'short_turns', count: 2, duration: 0.4 }],
    },
  });
  it('preserves estimated voices that have no confident text attribution', () => {
    expect(validateResult(acoustic()).diarization).toEqual({
      state: 'ready',
      speakerCount: 3,
      identitiesKnown: false,
      warnings: [{ code: 'short_turns', count: 2, duration: 0.4 }],
    });
  });
  it.each([-1, 0, 1.5, 1001])(
    'rejects inconsistent estimated count %s',
    (count) => {
      const value = acoustic();
      value.diarization.speakerCount = count;
      expect(() => validateResult(value)).toThrow(
        'TRANSCRIPTION_INVALID_RESULT',
      );
    },
  );
  it.each(['person_name', 'SPEAKER_A', 'SPEAKER_0000'])(
    'rejects arbitrary or invalid identity %s',
    (speaker) => {
      const value = acoustic();
      value.segments[0].speaker = speaker;
      expect(() => validateResult(value)).toThrow(
        'TRANSCRIPTION_INVALID_RESULT',
      );
    },
  );
  it('does not expose labels after a failed analysis', () => {
    const value = acoustic();
    value.diarization.state = 'failed';
    expect(validateResult(value).segments[0].speaker).toBeNull();
  });
  it.each([NaN, -1, 1000001])('rejects invalid warning counts %s', (count) => {
    const value = acoustic();
    value.diarization.warnings[0].count = count;
    expect(() => validateResult(value)).toThrow('TRANSCRIPTION_INVALID_RESULT');
  });
});
