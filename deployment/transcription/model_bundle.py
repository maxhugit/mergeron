"""Verify the reviewed, redistributable model bundle without any network client."""
import hashlib
import json
from pathlib import Path

MODEL_REVISION = '3533c8cf8e369892e6b79ff1bf80f7b0286a54ee'
MANIFEST_SHA256 = '30c5f54c87dab740fa324ebc323ceb5aa35acc163210bf7fcad41bfc36dc8092'


def verify_bundle(directory):
    root = Path(directory)
    manifest_path = root / 'mergeron-models.json'
    if root.is_symlink() or manifest_path.is_symlink():
        raise ValueError('TRANSCRIPTION_BUNDLE_INVALID')
    raw = manifest_path.read_bytes()
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != MANIFEST_SHA256:
        raise ValueError('TRANSCRIPTION_BUNDLE_INVALID')
    manifest = json.loads(raw)
    if (manifest.get('repository') != 'pyannote/speaker-diarization-community-1' or
            manifest.get('revision') != MODEL_REVISION or manifest.get('license') != 'CC-BY-4.0'):
        raise ValueError('TRANSCRIPTION_BUNDLE_INVALID')
    for name, digest in manifest['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('TRANSCRIPTION_BUNDLE_INVALID')
        path = root / relative
        if any((root / Path(*relative.parts[:i])).is_symlink() for i in range(1, len(relative.parts) + 1)):
            raise ValueError('TRANSCRIPTION_BUNDLE_INVALID')
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                raise ValueError('TRANSCRIPTION_BUNDLE_INVALID')
    return {'revision': MODEL_REVISION, 'license': 'CC-BY-4.0', 'files': len(manifest['files'])}


if __name__ == '__main__':
    import sys
    print(json.dumps(verify_bundle(sys.argv[1])))
