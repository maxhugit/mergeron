import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[2] / 'scripts/install-diarization-models.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ModelInstaller(unittest.TestCase):
    def test_download_is_pinned_and_published_without_credentials_or_cache(self):
        calls = []
        def download(repo, **kwargs):
            calls.append((repo, kwargs))
            folder = Path(kwargs['local_dir'])
            (folder/'config.yaml').write_text('pipeline: local')
            for name in ('embedding/pytorch_model.bin', 'segmentation/pytorch_model.bin', 'plda/plda.npz', 'plda/xvec_transform.npz'):
                path = folder/name
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(b'known-test-weights')
            (folder/'.cache').mkdir()
            (folder/'.cache'/'metadata').write_text('temporary metadata')
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HF_TOKEN':'test-only-secret'}), patch.dict('sys.modules', {'huggingface_hub':types.SimpleNamespace(snapshot_download=download)}):
            output = Path(tmp).resolve()/'models'
            installer.install(output, 'a'*40)
            self.assertEqual(calls[0][0], installer.REPOSITORY)
            self.assertEqual(calls[0][1]['revision'], 'a'*40)
            self.assertFalse((output/'.cache').exists())
            manifest = json.loads((output/'mergeron-models.json').read_text())
            self.assertEqual(manifest['files']['embedding/pytorch_model.bin'], hashlib.sha256(b'known-test-weights').hexdigest())
            self.assertNotIn('test-only-secret', str(manifest))

    def test_does_not_replace_existing_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'MODEL_DESTINATION_EXISTS'):
                installer.install(tmp, 'a'*40)

    def test_rejects_moving_reference_before_any_download(self):
        with self.assertRaisesRegex(ValueError,'MODEL_REVISION_MUST_BE_IMMUTABLE'):
            installer.install('/unneeded-path', 'main')

    def test_failed_download_cleans_staging_without_publishing(self):
        def download(*args, **kwargs):
            raise RuntimeError('private transport details')
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'HF_TOKEN':'test-only-secret'}), patch.dict('sys.modules', {'huggingface_hub':types.SimpleNamespace(snapshot_download=download)}):
            with self.assertRaises(RuntimeError):
                installer.install(Path(tmp).resolve()/'models', 'a'*40)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_symlinks_are_not_packaged_as_model_weights(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'weights.bin').symlink_to('/etc/hosts')
            with self.assertRaisesRegex(ValueError,'MODEL_SYMLINK_NOT_ALLOWED'):
                installer.manifest_for(root, 'a'*40)

if __name__ == '__main__': unittest.main()
