import { expect, it } from 'vitest';
import {
  activeCue,
  cueAtOrBefore,
  MAX_SRT_BYTES,
  parseSrt,
  subtitleTime,
} from './srt';
it('parses BOM, CRLF, multiline cues and standard formatting without interpreting HTML', () => {
  const cues = parseSrt(
    '\uFEFF1\r\n00:00:01,200 --> 00:00:03,000\r\n<i>Bonjour</i>\r\nDeuxième ligne\r\n\r\n2\r\n00:00:04.000 --> 00:00:05.100\r\n<script>texte</script>',
  );
  expect(cues).toEqual([
    { start: 1.2, end: 3, text: 'Bonjour\nDeuxième ligne' },
    { start: 4, end: 5.1, text: '<script>texte</script>' },
  ]);
  expect(activeCue(cues, 1.2)).toBe(0);
  expect(activeCue(cues, 3)).toBe(-1);
  expect(activeCue(cues, 4.5)).toBe(1);
  expect(cueAtOrBefore(cues, 3.5)).toBe(0);
});
it('keeps seek positions correct for out-of-order and overlapping cues', () => {
  const cues = parseSrt(
    '2\n00:00:02,000 --> 00:00:03,000\nB\n\n1\n00:00:01,000 --> 00:00:04,000\nA',
  );
  expect(activeCue(cues, 2.5)).toBe(1);
  expect(activeCue(cues, 3.5)).toBe(0);
  expect(activeCue(cues, 4)).toBe(-1);
  expect(subtitleTime(3661)).toBe('01:01:01');
});
it.each([
  '',
  'Not an SRT',
  '1\n00:61:00,000 --> 00:62:00,000\nBad',
  '1\n00:00:02,000 --> 00:00:01,000\nBackwards',
  '1\n00:00:00,000 --> 00:00:01,000\n',
])(
  'rejects malformed cues rather than silently shifting the transcript',
  (text) => {
    expect(() => parseSrt(text)).toThrow('invalid');
  },
);
it('bounds subtitle payloads before rendering', () => {
  expect(() => parseSrt('x'.repeat(MAX_SRT_BYTES + 1))).toThrow('tooLarge');
});
