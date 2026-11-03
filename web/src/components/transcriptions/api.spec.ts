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

describe('TXT export', () => {
  it('uses acoustic labels, precise times, warnings and explicit unassigned passages', async () => {
    const { transcriptTxt } = await import('./api');
    const text = transcriptTxt({
      text: 'Original unsplit text',
      language: 'fr',
      languageProbability: 1,
      duration: 3,
      diarization: {
        state: 'ready',
        speakerCount: 2,
        warnings: [{ code: 'overlapping_speech', count: 1, duration: 0.5 }],
      },
      segments: [
        { start: 0.125, end: 1.75, text: 'Bonjour', speaker: 'SPEAKER_00' },
        { start: 1.75, end: 2.25, text: 'Simultané', speaker: null },
        { start: 2.25, end: 3, text: 'Salut', speaker: 'SPEAKER_01' },
      ],
    });
    expect(text).toContain('Estimated speakers: 2');
    expect(text).toContain('Warning: overlapping_speech (1)');
    expect(text).toContain(
      '[00:00:00.125 --> 00:00:01.750] SPEAKER_00: Bonjour',
    );
    expect(text).toContain('[unattributed]: Simultané');
    expect(text).toContain('SPEAKER_01: Salut');
    expect(text).not.toContain('Original unsplit text');
  });
});
