"""Real FFmpeg extraction on synthetic video; never imports speech models."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import engine

class Extraction(unittest.TestCase):
    def video(self, directory, audio=True):
        command=['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10:d=1']
        if audio:
            command += ['-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','aac']
        command += ['-t','1','-c:v','mpeg4','-f','mp4',str(directory/'input')]
        subprocess.run(command,check=True,timeout=30)
    def test_extracts_playable_mp3_without_loading_speech_models(self):
        with tempfile.TemporaryDirectory(prefix='media-extract-test-') as path:
            directory=Path(path);self.video(directory)
            original=hashlib.sha256((directory/'input').read_bytes()).hexdigest()
            with patch.object(engine,'recognize',side_effect=AssertionError('ASR must not load')):
                engine.transcribe(directory,'extract')
            payload=json.loads((directory/'result.json').read_text())
            audio=directory/'audio.mp3'
            self.assertIsNone(payload['transcript'])
            self.assertEqual(payload['audio']['size'],audio.stat().st_size)
            self.assertEqual(payload['audio']['sha256'],hashlib.sha256(audio.read_bytes()).hexdigest())
            self.assertEqual(original,hashlib.sha256((directory/'input').read_bytes()).hexdigest())
            info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(audio)],timeout=10))
            self.assertEqual(len(info['streams']),1)
            self.assertEqual(info['streams'][0]['codec_name'],'mp3')
            self.assertEqual(info['streams'][0]['channels'],2)
    def test_video_without_audio_fails_instead_of_fabricating_a_track(self):
        with tempfile.TemporaryDirectory(prefix='media-empty-test-') as path:
            directory=Path(path);self.video(directory,audio=False)
            with self.assertRaises(subprocess.CalledProcessError):engine.transcribe(directory,'extract')
            self.assertFalse((directory/'audio.mp3').exists())
            self.assertFalse((directory/'result.json').exists())

    def test_combined_job_preserves_audio_if_speech_recognition_fails(self):
        with tempfile.TemporaryDirectory(prefix='media-partial-test-') as path:
            directory=Path(path);self.video(directory)
            with patch.object(engine,'recognize',side_effect=RuntimeError('synthetic ASR failure')):
                engine.transcribe(directory,'both')
            payload=json.loads((directory/'result.json').read_text())
            self.assertIsNone(payload['transcript'])
            self.assertEqual(payload['transcriptionError'],'TRANSCRIPTION_ENGINE_FAILED')
            self.assertGreater(payload['audio']['size'],0)
            self.assertTrue((directory/'audio.mp3').is_file())
if __name__=='__main__':unittest.main()
