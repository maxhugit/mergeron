import { describe, expect, it } from 'vitest';
import { upsertTimelineUserMessage } from './timeline-user-messages';
import type { TimelineEntry } from '@/types/timeline';

const timeline: TimelineEntry[] = [
  { kind: 'user', turnId: 'one', itemId: 'prompt', content: 'First' },
  { kind: 'turn', turnId: 'one', completed: true, items: [] },
  { kind: 'user', turnId: 'two', itemId: 'next', content: 'Next' },
  { kind: 'turn', turnId: 'two', completed: false, items: [] },
];

describe('late user message ordering', () => {
  it('inserts recovered steering inside its own turn and settles repeated echoes', () => {
    const message = { itemId: 'steer', text: 'Correction', images: [] };
    const result = upsertTimelineUserMessage(timeline, 'one', message);
    expect(
      result.map((row) => (row.kind === 'user' ? row.content : row.turnId)),
    ).toEqual(['First', 'one', 'Correction', 'Next', 'two']);
    expect(upsertTimelineUserMessage(result, 'one', message)).toEqual(result);
  });

  it('keeps a recovered message before its terminal failure', () => {
    const failure: TimelineEntry = {
      kind: 'turnFailure',
      turnId: 'one',
      failure: {
        turnId: 'one',
        message: 'Failed',
        errorCategory: null,
        additionalDetails: null,
        misalignmentErrorType: null,
        misalignmentExplanation: null,
      },
    };
    const result = upsertTimelineUserMessage(
      [...timeline.slice(0, 2), failure, ...timeline.slice(2)],
      'one',
      { itemId: 'steer', text: 'Correction', images: [] },
    );
    expect(result[2]).toMatchObject({ kind: 'user', content: 'Correction' });
    expect(result[3]).toBe(failure);
  });
});
