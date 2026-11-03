#!/usr/bin/env python3
"""Provision Community-1 before runtime; never reads or uploads an audio file.

Run in an installation environment with huggingface_hub available. Accept the
upstream access conditions using your own Hugging Face account first. Provide
HF_TOKEN in the installer environment (never as a command-line argument). The
credential is not copied to the model bundle. Mergeron workers need no token.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

REPOSITORY = "pyannote/speaker-diarization-community-1"


def manifest_for(directory, revision):
    files = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError("MODEL_SYMLINK_NOT_ALLOWED")
        if path.is_file():
            with path.open('rb') as stream:
                files[path.relative_to(directory).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
    required = {'config.yaml', 'embedding/pytorch_model.bin',
                'segmentation/pytorch_model.bin', 'plda/plda.npz', 'plda/xvec_transform.npz'}
    if not required.issubset(files):
        raise ValueError('MODEL_BUNDLE_INCOMPLETE')
    return {"repository": REPOSITORY, "revision": revision, "files": files}


def install(output, revision):
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('MODEL_REVISION_MUST_BE_IMMUTABLE')
    output = Path(output).absolute()
    # Never modify or replace an installed bundle; a new path is mandatory.
    if output.exists() or output.is_symlink():
        raise ValueError('MODEL_DESTINATION_EXISTS')
    if any(parent.is_symlink() for parent in [output.parent, *output.parents]):
        raise ValueError('MODEL_SYMLINK_NOT_ALLOWED')
    if not output.parent.is_dir():
        raise ValueError('MODEL_PARENT_MISSING')
    token = os.environ.get('HF_TOKEN')
    if not token:
        raise ValueError('MODEL_ACCESS_REQUIRED')
    staging = Path(tempfile.mkdtemp(prefix='.diarization-install-', dir=output.parent))
    try:
        # This is the only network-enabled step. No user media is involved.
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        os.environ['HF_HUB_OFFLINE'] = '0'  # Installer only; inference stays offline.
        from huggingface_hub import snapshot_download
        snapshot_download(REPOSITORY, revision=revision, local_dir=staging, token=token)
        shutil.rmtree(staging / '.cache', ignore_errors=True)
        manifest = manifest_for(staging, revision)
        (staging / 'mergeron-models.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
        for path in staging.rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o644)
        staging.chmod(0o755)
        # Publication on the same filesystem; existing destination is never replaced.
        if output.exists() or output.is_symlink():
            raise ValueError('MODEL_DESTINATION_EXISTS')
        staging.rename(output)
        print(json.dumps({'installed': True, 'repository': REPOSITORY, 'revision': revision, 'fileCount': len(manifest['files'])}))
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--revision', required=True, help='Reviewed full 40-character upstream commit SHA; branches are rejected.')
    args = parser.parse_args()
    try:
        install(args.output, args.revision)
    except Exception as error:
        # Download exceptions may contain authenticated URLs; never print them.
        code = str(error) if re.fullmatch('MODEL_[A-Z_]+', str(error)) else 'MODEL_INSTALL_FAILED'
        raise SystemExit(code) from None
