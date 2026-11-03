/** Treat even the isolated worker as an untrusted producer. */
export interface TranscriptionResult {
  text: string;
  language: string;
  languageProbability: number;
  duration: number;
  segments: {
    start: number;
    end: number;
    text: string;
    speaker: string | null;
  }[];
  diarization: {
    state: 'ready' | 'unavailable' | 'failed';
    speakerCount?: number;
    identitiesKnown?: false;
    reason?: string;
    warnings?: {
      code:
        | 'overlapping_speech'
        | 'short_turns'
        | 'uncertain_assignment'
        | 'no_speakers_detected';
      count: number;
      duration?: number;
    }[];
  };
  model: { name: string; revision: string };
}
export function validateResult(value: unknown): TranscriptionResult {
  if (!value || typeof value !== 'object')
    throw Error('TRANSCRIPTION_INVALID_RESULT');
  const v = value as TranscriptionResult;
  const time = (x: unknown): x is number =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 7201;
  if (
    typeof v.text !== 'string' ||
    v.text.length > 2_000_000 ||
    !/^[a-z]{2,3}$/.test(v.language) ||
    !Number.isFinite(v.languageProbability) ||
    v.languageProbability < 0 ||
    v.languageProbability > 1 ||
    !time(v.duration) ||
    v.duration === 0 ||
    !Array.isArray(v.segments) ||
    v.segments.length > 50_000 ||
    !['ready', 'unavailable', 'failed'].includes(v.diarization?.state) ||
    v.model?.name !== 'faster-whisper-small' ||
    !/^[a-f0-9]{40}$/.test(v.model.revision)
  )
    throw Error('TRANSCRIPTION_INVALID_RESULT');
  let previous = 0;
  const segments = v.segments.map((s) => {
    if (
      !s ||
      !time(s.start) ||
      !time(s.end) ||
      s.start < previous ||
      s.end < s.start ||
      s.end > v.duration + 1 ||
      typeof s.text !== 'string' ||
      s.text.length > 100_000 ||
      (s.speaker !== null &&
        (typeof s.speaker !== 'string' ||
          !/^(?:speaker_[1-9][0-9]{0,2}|SPEAKER_[0-9]{2,3})$/.test(s.speaker)))
    )
      throw Error('TRANSCRIPTION_INVALID_RESULT');
    previous = s.start;
    return {
      start: s.start,
      end: s.end,
      text: s.text,
      speaker: v.diarization.state === 'ready' ? s.speaker : null,
    };
  });
  const attributedCount = new Set(
    segments.map((s) => s.speaker).filter(Boolean),
  ).size;
  const speakerCount = v.diarization.speakerCount ?? attributedCount;
  if (
    v.diarization.warnings !== undefined &&
    !Array.isArray(v.diarization.warnings)
  )
    throw Error('TRANSCRIPTION_INVALID_RESULT');
  const warnings = v.diarization.warnings?.map((warning) => {
    if (
      !warning ||
      ![
        'overlapping_speech',
        'short_turns',
        'uncertain_assignment',
        'no_speakers_detected',
      ].includes(warning.code) ||
      !Number.isInteger(warning.count) ||
      warning.count < 1 ||
      warning.count > 1_000_000 ||
      (warning.duration !== undefined &&
        (!time(warning.duration) || warning.duration > v.duration + 0.001))
    )
      throw Error('TRANSCRIPTION_INVALID_RESULT');
    return {
      code: warning.code,
      count: warning.count,
      ...(warning.duration === undefined ? {} : { duration: warning.duration }),
    };
  });
  if (
    (warnings?.length ?? 0) > 4 ||
    !Number.isInteger(speakerCount) ||
    speakerCount < attributedCount ||
    speakerCount > 1000
  )
    throw Error('TRANSCRIPTION_INVALID_RESULT');
  return {
    text: v.text,
    language: v.language,
    languageProbability: v.languageProbability,
    duration: v.duration,
    segments,
    model: { name: v.model.name, revision: v.model.revision },
    diarization:
      v.diarization.state === 'ready'
        ? {
            state: 'ready',
            speakerCount,
            ...(warnings ? { warnings } : {}),
            identitiesKnown: false,
          }
        : {
            state: v.diarization.state,
            reason:
              v.diarization.state === 'failed'
                ? v.diarization.reason === 'model_load_failed'
                  ? 'model_load_failed'
                  : 'diarization_failed'
                : v.diarization.reason === 'disabled'
                  ? 'disabled'
                  : v.diarization.reason === 'no_speech_detected'
                    ? 'no_speech_detected'
                    : 'models_not_configured',
          },
  };
}
