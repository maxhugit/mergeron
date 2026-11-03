import unittest
from pathlib import Path
import struct
import tempfile
import wave
from engine import attach_speakers, speaker_for, read_pcm16

class Speakers(unittest.TestCase):
    def test_words_crossing_speaker_boundary_remain_separate(self):
        result = attach_speakers([{'words': [{'start': 0, 'end': 1, 'word': ' Bonjour'}, {'start': 1, 'end': 2, 'word': ' Max'}, {'start': 2, 'end': 3, 'word': ' Salut'}]}], [(0, 2, 'PERSON_B'), (2, 3, 'PERSON_A')])
        self.assertEqual([r['speaker'] for r in result], ['speaker_1', 'speaker_2'])
        self.assertEqual([r['text'] for r in result], ['Bonjour Max', 'Salut'])
        self.assertNotIn('PERSON', str(result))
    def test_missing_overlap_does_not_invent_a_person(self):
        self.assertIsNone(speaker_for(3, 4, [(0, 2, 'someone')]))
        self.assertEqual(attach_speakers([{'start':3,'end':4,'text':'Hello'}], [])[0]['speaker'], None)
    def test_selects_largest_overlap(self):
        self.assertEqual(speaker_for(0,3,[(0,1,'a'),(1,3,'b')]),'b')

class DecodedAudio(unittest.TestCase):
    def fixture(self, directory, channels=1, width=2, rate=16000):
        target = Path(directory) / "decoded.wav"
        with wave.open(str(target), "wb") as audio:
            audio.setnchannels(channels)
            audio.setsampwidth(width)
            audio.setframerate(rate)
            audio.writeframes(struct.pack("<hhh", -32768, 0, 32767) * channels)
        return target

    def test_preserves_signed_pcm_samples_without_a_second_media_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            samples = read_pcm16(self.fixture(directory))
            self.assertEqual(struct.unpack("<hhh", samples), (-32768, 0, 32767))

    def test_rejects_audio_that_would_shift_timing_or_sample_values(self):
        for options in ({"channels": 2}, {"width": 1}, {"rate": 44100}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(ValueError, "TRANSCRIPTION_DECODE_FAILED"):
                    read_pcm16(self.fixture(directory, **options))

if __name__ == '__main__': unittest.main()
