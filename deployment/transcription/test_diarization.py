"""Deterministic reconciliation tests, not evidence of acoustic model accuracy."""
import unittest
from diarization import diarize_segments, speaker_for


def words(times):
    return [{"words": [{"start": a, "end": b, "word": " " + text} for a, b, text in times]}]


class Attribution(unittest.TestCase):
    def test_one_two_and_three_anonymous_voices_in_first_occurrence_order(self):
        for count in (1, 2, 3):
            with self.subTest(count=count):
                turns = [(2*i, 2*i+1.5, f"private-{count-i}") for i in range(count)]
                units = words([(a, b, "hello") for a, b, _ in turns])
                output, status = diarize_segments(units, list(reversed(turns)), count*2)
                self.assertEqual(status["speakerCount"], count)
                self.assertEqual(status["warnings"], [])
                self.assertEqual([s["speaker"] for s in output], [f"SPEAKER_{i:02d}" for i in range(count)])
                self.assertNotIn("private", str(output))

    def test_same_voice_returns_after_a_different_speaker(self):
        output, _ = diarize_segments(words([(0,1,"A"),(2,3,"B"),(4,5,"A")]), [(0,1,"a"),(2,3,"b"),(4,5,"a")], 5)
        self.assertEqual([s["speaker"] for s in output], ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"])

    def test_simultaneous_voices_are_unattributed_without_hiding_overlap(self):
        output, status = diarize_segments(words([(0,1,"clear"),(1,2,"both"),(2,3,"clear")]), [(0,3,"a"),(1,2,"b")], 3)
        self.assertEqual([s["speaker"] for s in output], ["SPEAKER_00", None, "SPEAKER_00"])
        self.assertEqual(status["speakerCount"], 2)
        self.assertIn({"code":"overlapping_speech","count":1,"duration":1}, status["warnings"])

    def test_short_turn_is_not_counted_as_a_confident_attribution(self):
        output, status = diarize_segments(words([(0,0.2,"oui"),(1,2,"long")]), [(0,0.2,"a"),(1,2,"b")], 2)
        self.assertIsNone(output[0]["speaker"])
        self.assertEqual(output[1]["speaker"], "SPEAKER_01")
        self.assertEqual(status["speakerCount"], 2)
        self.assertIn("short_turns", [w["code"] for w in status["warnings"]])

    def test_short_word_inside_a_long_turn_can_be_attributed(self):
        self.assertEqual(speaker_for(0.2,0.3,[(0,2,"a")]), "a")

    def test_low_coverage_and_zero_duration_are_unattributed(self):
        self.assertIsNone(speaker_for(0,1,[(0,0.6,"a")]))
        self.assertIsNone(speaker_for(0,0,[(0,1,"a")]))

    def test_without_word_times_change_is_not_assigned_from_dialogue(self):
        output, status = diarize_segments([{"start":0,"end":3,"text":"A then B"}], [(0,1,"a"),(1,3,"b")], 3)
        self.assertEqual(output, [{"start":0,"end":3,"text":"A then B","speaker":None}])
        self.assertEqual(status["speakerCount"], 2)

    def test_nested_overlaps_are_found_even_after_shorter_turn_ends(self):
        output, status = diarize_segments(words([(0,1,"A"),(2,3,"both"),(4,5,"A"),(6,7,"both")]), [(0,10,"a"),(2,3,"b"),(6,7,"c")], 10)
        self.assertEqual([s["speaker"] for s in output], ["SPEAKER_00",None,"SPEAKER_00",None])
        self.assertIn({"code":"overlapping_speech","count":2,"duration":2},status["warnings"])

    def test_duplicate_same_voice_is_not_false_overlap(self):
        output, status = diarize_segments(words([(0,1,"A")]), [(0,1,"a"),(0,1,"a")], 1)
        self.assertEqual(status["warnings"], [])
        self.assertEqual(output[0]["speaker"], "SPEAKER_00")

    def test_no_turns_is_explicit_not_false_success_with_named_voice(self):
        output, status = diarize_segments(words([(0,1,"A")]), [], 1)
        self.assertIsNone(output[0]["speaker"])
        self.assertEqual(status["speakerCount"], 0)
        self.assertIn("no_speakers_detected", [w["code"] for w in status["warnings"]])

    def test_bad_model_timing_is_rejected(self):
        for start,end in [(float('nan'),1),(0,float('inf')),(2,1)]:
            with self.assertRaisesRegex(ValueError,'DIARIZATION_INVALID_TURNS'):
                diarize_segments([],[(start,end,'a')],3)

if __name__ == '__main__': unittest.main()
