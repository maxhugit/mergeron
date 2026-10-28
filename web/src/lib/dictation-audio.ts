/** Canonical PCM16 mono WAV accepted by API and experimental native CLI alike. */
export function pcmWave(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function dictationWave(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(
      await recording.arrayBuffer(),
    );
    if (!decoded.length || decoded.duration > 121)
      throw new Error('Enregistrement audio invalide ou trop long.');
    const offline = new OfflineAudioContext(
      1,
      Math.min(24000 * 120, Math.ceil(decoded.duration * 24000)),
      24000,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const audio = await offline.startRendering();
    return pcmWave(audio.getChannelData(0));
  } finally {
    await context.close();
  }
}
