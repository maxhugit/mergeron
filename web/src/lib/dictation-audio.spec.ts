import { pcmWave } from './dictation-audio';
import { it, expect } from 'vitest';

it('encodes bounded PCM16 little-endian mono 24 kHz with a real WAV header', async () => {
  const blob = pcmWave(new Float32Array([-2, 0, 1]));
  const data = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(data.buffer);
  expect(new TextDecoder().decode(data.slice(0, 4))).toBe('RIFF');
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(24000);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(46, true)).toBe(0);
  expect(view.getInt16(48, true)).toBe(32767);
});
