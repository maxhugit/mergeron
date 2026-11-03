"""Offline CPU inference. Called in an owned subprocess so cancellation releases RAM."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

from diarization import attach_speakers, speaker_for, diarize_segments

MAX_SECONDS = 7200
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"

# Enforce offline inference even outside the shipped Docker image. No token or
# network fallback is needed to load the separately provisioned local bundle.
for key, value in {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                   "HF_HUB_DISABLE_TELEMETRY": "1", "PYANNOTE_METRICS_ENABLED": "0"}.items():
    os.environ[key] = value


def progress(directory, phase):
    path = Path(directory) / "progress.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"phase": phase}), encoding="utf8")
    temporary.replace(path)


def transcribe(directory, operation="transcribe"):
    directory = Path(directory)
    progress(directory, "decoding")
    decoded = directory / "audio.wav"
    # Embedded playlists/URLs cannot make ffmpeg fetch remote resources.
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(directory / "input"), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-t", str(MAX_SECONDS + 1), "-c:a", "pcm_s16le", str(decoded)], check=True, timeout=300, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with wave.open(str(decoded)) as audio:
        duration = audio.getnframes() / audio.getframerate()
        if duration <= 0 or duration > MAX_SECONDS:
            raise ValueError("TRANSCRIPTION_DURATION")
    audio_result = None
    if operation in {"extract", "both"}:
        progress(directory, "extracting")
        target_audio = directory / "audio.mp3"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(directory / "input"), "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "96k", "-ar", "44100", "-ac", "2", str(target_audio)], check=True, timeout=300, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        size = target_audio.stat().st_size
        if not 0 < size <= 128 * 1024**2:
            raise ValueError("TRANSCRIPTION_AUDIO_LIMIT")
        with target_audio.open("rb") as audio_file:
            digest = hashlib.file_digest(audio_file, "sha256").hexdigest()
        audio_result = {"size": size, "sha256": digest, "mime": "audio/mpeg", "duration": duration}
    result = None
    transcription_error = None
    if operation != "extract":
        try:
            result = recognize(directory, decoded, duration)
        except Exception:
            if operation != "both":
                raise
            transcription_error = "TRANSCRIPTION_ENGINE_FAILED"
    payload = {"transcript": result, "audio": audio_result, "transcriptionError": transcription_error}
    target = directory / "result.json"
    target.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf8")
    if target.stat().st_size > 4 * 1024**2:
        target.unlink()
        raise ValueError("TRANSCRIPTION_RESULT_LIMIT")
    progress(directory, "ready")


def read_pcm16(decoded):
    """Read only the mono/16-kHz PCM contract produced by our FFmpeg step."""
    with wave.open(str(decoded)) as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("TRANSCRIPTION_DECODE_FAILED")
        frames = audio.getnframes()
        if not 0 < frames <= MAX_SECONDS * 16000:
            raise ValueError("TRANSCRIPTION_DURATION")
        samples = audio.readframes(frames)
        if len(samples) != frames * 2:
            raise ValueError("TRANSCRIPTION_DECODE_FAILED")
        return samples


def recognize(directory, decoded, duration):
    progress(directory, "loading")
    import numpy as np
    from faster_whisper import WhisperModel
    # FFmpeg already decoded and normalized the input. Pass the supported
    # waveform API instead of decoding it again through PyAV (whose newer
    # av.open no longer accepts Faster-Whisper 1.2.1's metadata_errors option).
    waveform = np.frombuffer(read_pcm16(decoded), dtype="<i2").astype(np.float32) / 32768.0
    model = WhisperModel("/models/asr", device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)
    progress(directory, "transcribing")
    stream, info = model.transcribe(waveform, language=None, word_timestamps=True, vad_filter=True, language_detection_segments=3)
    segments = []
    for segment in stream:
        segments.append({"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip(), "speaker": None, "words": [{"start": word.start, "end": word.end, "word": word.word} for word in segment.words or []]})
    del model
    result = {"text": " ".join(s["text"] for s in segments), "language": info.language if segments else "und", "languageProbability": info.language_probability if segments else 0, "duration": duration, "segments": segments, "diarization": {"state": "unavailable", "reason": "models_not_configured"}, "model": {"name": "faster-whisper-small", "revision": MODEL_REVISION}}
    if os.environ.get('TRANSCRIPTION_DIARIZATION', 'true') == 'false':
        result['diarization'] = {'state': 'unavailable', 'reason': 'disabled'}
        return strip_words(result)
    if (Path("/models/diarization") / "config.yaml").is_file() and segments:
        progress(directory, "diarizing")
        try:
            import torch
            from pyannote.audio import Pipeline
            torch.set_num_threads(4)
            try:
                pipeline = Pipeline.from_pretrained("/models/diarization")
                pipeline.to(torch.device("cpu"))
            except Exception:
                result["diarization"] = {"state": "failed", "reason": "model_load_failed"}
                return strip_words(result)
            # Reuse the normalized waveform: no secondary media decoder or URL.
            output = pipeline({"waveform": torch.from_numpy(waveform).unsqueeze(0), "sample_rate": 16000})
            # The exclusive annotation deliberately hides simultaneous voices.
            # Keep the regular acoustic output so overlaps remain observable.
            turns = [(turn.start, turn.end, str(speaker)) for turn, _, speaker in output.speaker_diarization.itertracks(yield_label=True)]
            result["segments"], result["diarization"] = diarize_segments(segments, turns, duration)
        except Exception:
            result["diarization"] = {"state": "failed", "reason": "diarization_failed"}
    if not segments:
        result["diarization"] = {"state": "unavailable", "reason": "no_speech_detected"}
    return strip_words(result)


def strip_words(result):
    for segment in result["segments"]:
        segment.pop("words", None)
    return result


if __name__ == "__main__":
    try:
        operation = sys.argv[2] if len(sys.argv) > 2 else "transcribe"
        if operation not in {"transcribe", "extract", "both"}:
            raise ValueError("TRANSCRIPTION_INVALID_OPERATION")
        transcribe(sys.argv[1], operation)
    except Exception as error:
        code = str(error) if str(error) in {"TRANSCRIPTION_DURATION", "TRANSCRIPTION_RESULT_LIMIT", "TRANSCRIPTION_AUDIO_LIMIT", "TRANSCRIPTION_INVALID_OPERATION"} else "TRANSCRIPTION_PROCESSING_FAILED"
        if code == "TRANSCRIPTION_PROCESSING_FAILED":
            try:
                phase = json.loads((Path(sys.argv[1]) / "progress.json").read_text())["phase"]
                code = {"decoding": "TRANSCRIPTION_DECODE_FAILED", "extracting": "TRANSCRIPTION_EXTRACTION_FAILED", "loading": "TRANSCRIPTION_MODEL_UNAVAILABLE", "transcribing": "TRANSCRIPTION_ENGINE_FAILED"}.get(phase, code)
            except (OSError, ValueError, KeyError):
                pass
        progress(sys.argv[1], "failed")
        (Path(sys.argv[1]) / "error.json").write_text(json.dumps({"code": code}), encoding="utf8")
        sys.exit(1)
