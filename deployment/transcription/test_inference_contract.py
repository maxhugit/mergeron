"""Mocked boundary tests. These do not validate model acoustic accuracy."""
from contextlib import ExitStack
import types
import unittest
from unittest.mock import Mock, patch
import engine


class Waveform:
    def astype(self, *_): return self
    def __truediv__(self, *_): return self
    def unsqueeze(self, *_): return self


class InferenceContract(unittest.TestCase):
    def recognize(self, failure=None):
        waveform = Waveform()
        word = types.SimpleNamespace(start=0,end=1,word=' Bonjour')
        model = Mock()
        model.transcribe.return_value = ([types.SimpleNamespace(start=0,end=1,text=' Bonjour',words=[word])], types.SimpleNamespace(language='fr',language_probability=0.98))
        whisper = types.SimpleNamespace(WhisperModel=Mock(return_value=model))
        annotation = types.SimpleNamespace(itertracks=Mock(return_value=[(types.SimpleNamespace(start=0,end=1),None,'raw-private-label')]))
        class Output:
            speaker_diarization = annotation
            @property
            def exclusive_speaker_diarization(self):
                raise AssertionError('Exclusive output hides overlap')
        pipeline = Mock(return_value=Output())
        loader = Mock(return_value=pipeline)
        if failure == 'load': loader.side_effect=RuntimeError('internal path, not for public error')
        if failure == 'inference': pipeline.side_effect=RuntimeError('internal path, not for public error')
        modules = {
            'numpy':types.SimpleNamespace(frombuffer=lambda *_args,**_kwargs: waveform, float32='float32'),
            'faster_whisper':whisper,
            'torch':types.SimpleNamespace(set_num_threads=Mock(),device=lambda d:d,from_numpy=lambda w:w),
            'pyannote':types.ModuleType('pyannote'),
            'pyannote.audio':types.SimpleNamespace(Pipeline=types.SimpleNamespace(from_pretrained=loader)),
        }
        with ExitStack() as stack:
            stack.enter_context(patch.dict('sys.modules',modules))
            stack.enter_context(patch.object(engine,'progress'))
            stack.enter_context(patch.object(engine,'read_pcm16',return_value=b'\x00\x00'))
            stack.enter_context(patch.object(engine.Path,'is_file',return_value=True))
            result = engine.recognize('owned-job','local.wav',1)
        whisper.WhisperModel.assert_called_once_with('/models/asr',device='cpu',compute_type='int8',cpu_threads=4,num_workers=1,local_files_only=True)
        loader.assert_called_once_with('/models/diarization')
        return result, pipeline, waveform

    def test_uses_local_pipeline_and_regular_acoustic_turns_on_normalized_waveform(self):
        result, pipeline, waveform = self.recognize()
        pipeline.assert_called_once_with({'waveform':waveform,'sample_rate':16000})
        self.assertEqual(result['segments'],[{'start':0,'end':1,'text':'Bonjour','speaker':'SPEAKER_00'}])
        self.assertEqual(result['diarization']['speakerCount'],1)
        self.assertNotIn('raw-private-label',str(result))

    def test_model_load_failure_preserves_text_and_distinguishes_failure_reason(self):
        result, _, _ = self.recognize('load')
        self.assertEqual(result['text'],'Bonjour')
        self.assertEqual(result['diarization'],{'state':'failed','reason':'model_load_failed'})
        self.assertIsNone(result['segments'][0]['speaker'])
        self.assertNotIn('words',result['segments'][0])

    def test_inference_failure_preserves_text_without_exposing_internal_exception(self):
        result, _, _ = self.recognize('inference')
        self.assertEqual(result['diarization'],{'state':'failed','reason':'diarization_failed'})
        self.assertNotIn('internal path',str(result))

if __name__ == '__main__': unittest.main()
