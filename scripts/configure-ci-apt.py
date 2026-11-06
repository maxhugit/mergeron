#!/usr/bin/env python3
"""Avoid a stalled Azure mirror on disposable Ubuntu GitHub runners only."""
import os
from pathlib import Path
import re

TIMEOUTS = '''// Mergeron CI: fail a stalled connection, never bypass package authentication.
Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
'''


def configure(root: Path) -> int:
    release = (root / 'etc/os-release').read_text()
    if not re.search(r'^ID=["\']?ubuntu["\']?$', release, re.MULTILINE):
        raise RuntimeError('Only Ubuntu CI runners are supported')
    apt = root / 'etc/apt'
    candidates = [apt / 'sources.list', apt / 'apt-mirrors.txt', apt / 'apt-security-mirrors.txt']
    candidates += sorted((apt / 'sources.list.d').glob('*.list'))
    candidates += sorted((apt / 'sources.list.d').glob('*.sources'))
    changed = 0
    for file in candidates:
        if file.is_symlink():
            raise RuntimeError('Refusing a symbolic APT configuration')
        if not file.is_file():
            continue
        before = file.read_text()
        after = re.sub(r'https?://azure\.archive\.ubuntu\.com/ubuntu\b', 'https://archive.ubuntu.com/ubuntu', before)
        if before != after:
            file.write_text(after)
            changed += 1
    config = apt / 'apt.conf.d/80mergeron-ci-network'
    if config.is_symlink():
        raise RuntimeError('Refusing a symbolic APT configuration')
    config.write_text(TIMEOUTS)
    return changed


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_OS') != 'Linux':
        raise SystemExit('This command is restricted to disposable Linux GitHub Actions runners')
    count = configure(Path('/'))
    print(f'APT CI network: {count} Azure mirror references switched to the official Ubuntu archive; signed sources retained; network timeouts enabled.')
