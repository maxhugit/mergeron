import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from model_bundle import verify_bundle, MODEL_REVISION
import server

BUNDLE = Path(__file__).resolve().parent / 'models/diarization'


class ModelBundle(unittest.TestCase):
    def test_real_git_bundle_is_complete_and_matches_reviewed_fingerprints(self):
        value=verify_bundle(BUNDLE)
        self.assertEqual(value['revision'],MODEL_REVISION)
        self.assertEqual(value['license'],'CC-BY-4.0')
        self.assertGreaterEqual(value['files'],5)

    def test_corrupted_or_lfs_pointer_weights_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'bundle';shutil.copytree(BUNDLE,root)
            (root/'embedding/pytorch_model.bin').write_text('version https://git-lfs.github.com/spec/v1\noid sha256:fake\nsize 26646242\n')
            with self.assertRaisesRegex(ValueError,'TRANSCRIPTION_BUNDLE_INVALID'):
                verify_bundle(root)

    def test_modified_manifest_cannot_authorize_replacement_weights(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=json.loads((BUNDLE/'mergeron-models.json').read_text())
            manifest['revision']='a'*40
            (root/'mergeron-models.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'TRANSCRIPTION_BUNDLE_INVALID'):
                verify_bundle(root)

    def test_model_symlinks_are_rejected_even_with_identical_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'bundle';shutil.copytree(BUNDLE,root)
            target=root/'embedding/pytorch_model.bin';target.unlink()
            target.symlink_to(BUNDLE/'embedding/pytorch_model.bin')
            with self.assertRaisesRegex(ValueError,'TRANSCRIPTION_BUNDLE_INVALID'):
                verify_bundle(root)

    def test_missing_file_is_not_reported_as_healthy(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'bundle';shutil.copytree(BUNDLE,root)
            (root/'segmentation/pytorch_model.bin').unlink()
            with self.assertRaises(OSError):verify_bundle(root)


class Readiness(unittest.TestCase):
    def tearDown(self):server.models_ready.cache_clear()

    def test_bundled_integrity_is_checked_once(self):
        server.models_ready.cache_clear()
        with patch.dict(server.os.environ,{'TRANSCRIPTION_DIARIZATION':'true','TRANSCRIPTION_DIARIZATION_SOURCE':'bundled'}), patch.object(server,'verify_bundle') as verify:
            self.assertTrue(server.models_ready());self.assertTrue(server.models_ready())
            verify.assert_called_once_with('/models/diarization')

    def test_invalid_bundle_is_visible_in_readiness(self):
        server.models_ready.cache_clear()
        with patch.dict(server.os.environ,{'TRANSCRIPTION_DIARIZATION':'true','TRANSCRIPTION_DIARIZATION_SOURCE':'bundled'}), patch.object(server,'verify_bundle',side_effect=ValueError('bad')):
            self.assertFalse(server.models_ready())

    def test_disabled_and_custom_modes_do_not_require_builtin_bundle(self):
        for enabled,source in [('false','disabled'),('true','custom')]:
            server.models_ready.cache_clear()
            with patch.dict(server.os.environ,{'TRANSCRIPTION_DIARIZATION':enabled,'TRANSCRIPTION_DIARIZATION_SOURCE':source}), patch.object(server,'verify_bundle') as verify, patch.object(server.Path,'is_file',return_value=True):
                self.assertTrue(server.models_ready());verify.assert_not_called()

if __name__=='__main__':unittest.main()
