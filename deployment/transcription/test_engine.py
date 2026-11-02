import unittest
from engine import attach_speakers, speaker_for

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

if __name__ == '__main__': unittest.main()
