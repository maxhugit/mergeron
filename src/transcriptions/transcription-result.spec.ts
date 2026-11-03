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
