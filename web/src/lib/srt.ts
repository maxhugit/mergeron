/** Plain-text SRT cues. Subtitle contents are never interpreted as HTML. */
export const MAX_SRT_BYTES = 2 * 1024 * 1024;
export const MAX_SRT_CUES = 10000;
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}
const timestamp = (text: string) => {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(text);
  return match
    ? Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3]) +
        Number(match[4]) / 1000
    : NaN;
};
export function parseSrt(text: string): SubtitleCue[] {
  if (new TextEncoder().encode(text).length > MAX_SRT_BYTES)
    throw new Error('tooLarge');
  const cues: SubtitleCue[] = [];
  for (const block of text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    if (/^\d+\s*$/.test(lines[0] ?? '')) lines.shift();
    const timing = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(
      lines.shift()?.trim() ?? '',
    );
    if (!timing) throw new Error('invalid');
    const start = timestamp(timing[1]),
      end = timestamp(timing[2]);
    const content = lines
      .join('\n')
      .trim()
      .replace(/<\/?(?:b|i|u|font)(?:\s[^>]*)?>/gi, '');
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      !content
    )
      throw new Error('invalid');
    cues.push({ start, end, text: content });
    if (cues.length > MAX_SRT_CUES) throw new Error('tooLarge');
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}
export function cueAtOrBefore(cues: SubtitleCue[], time: number): number {
  let low = 0,
    high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
export function activeCue(cues: SubtitleCue[], time: number): number {
  const low = cueAtOrBefore(cues, time) + 1;
  // SRT can contain overlapping speaker cues. Prefer the latest active one.
  for (let index = low - 1; index >= 0; index--)
    if (time < cues[index].end) return index;
  return -1;
}
export function subtitleTime(seconds: number) {
  const whole = Math.floor(seconds),
    hours = Math.floor(whole / 3600);
  return (
    (hours ? String(hours).padStart(2, '0') + ':' : '') +
    String(Math.floor(whole / 60) % 60).padStart(2, '0') +
    ':' +
    String(whole % 60).padStart(2, '0')
  );
}
