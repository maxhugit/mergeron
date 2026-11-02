import { describe, expect, it } from 'vitest';
import { transcriptSrt } from './api';
describe('subtitle export', () => {
  it('keeps millisecond timecodes and anonymous speaker labels', () => {
    expect(
      transcriptSrt({
        text: 'Bonjour',
        language: 'fr',
        languageProbability: 1,
        duration: 2,
        diarization: { state: 'ready' },
        segments: [
          { start: 0.125, end: 1.75, text: 'Bonjour', speaker: 'speaker_1' },
        ],
      }),
    ).toBe('1\n00:00:00,125 --> 00:00:01,750\nspeaker_1: Bonjour\n');
  });
});
