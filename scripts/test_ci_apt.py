import importlib.util
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ci_apt', Path(__file__).with_name('configure-ci-apt.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CiAptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'etc/apt/apt.conf.d').mkdir(parents=True)
        (self.root / 'etc/apt/sources.list.d').mkdir()
        (self.root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID="24.04"\n')

    def test_mirrorlist_preserves_priorities_and_other_hosts(self):
        file = self.root / 'etc/apt/apt-mirrors.txt'
        file.write_text('http://azure.archive.ubuntu.com/ubuntu priority:1\nhttps://security.ubuntu.com/ubuntu priority:2\n')
        self.assertEqual(module.configure(self.root), 1)
        self.assertEqual(file.read_text(), 'https://archive.ubuntu.com/ubuntu priority:1\nhttps://security.ubuntu.com/ubuntu priority:2\n')
        self.assertEqual(module.configure(self.root), 0)

    def test_signed_deb822_source_keeps_suites_components_and_keyring(self):
        file = self.root / 'etc/apt/sources.list.d/ubuntu.sources'
        source = 'Types: deb\nURIs: https://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
        file.write_text(source)
        module.configure(self.root)
        self.assertEqual(file.read_text(), source.replace('azure.archive.ubuntu.com', 'archive.ubuntu.com'))
        config = (self.root / 'etc/apt/apt.conf.d/80mergeron-ci-network').read_text()
        self.assertIn('Acquire::https::Timeout "30";', config)
        self.assertIn('Acquire::Retries "2";', config)
        self.assertNotRegex(config.lower(), 'allowunauthenticated|allowinsecure|verify-peer|verify-host|trusted=')

    def test_does_not_rewrite_lookalike_domains(self):
        file = self.root / 'etc/apt/sources.list'
        source = 'deb https://azure.archive.ubuntu.com.example.org/ubuntu noble main\n'
        file.write_text(source)
        self.assertEqual(module.configure(self.root), 0)
        self.assertEqual(file.read_text(), source)

    def test_command_refuses_non_runner_execution_before_accessing_host_config(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('configure-ci-apt.py'))], env={**os.environ, 'GITHUB_ACTIONS': 'false', 'RUNNER_OS': 'Linux'}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restricted to disposable', result.stderr)

    def test_refuses_non_ubuntu_and_symlinks(self):
        (self.root / 'etc/os-release').write_text('ID=debian\n')
        with self.assertRaises(RuntimeError):
            module.configure(self.root)
        (self.root / 'etc/os-release').write_text('ID=ubuntu\n')
        target = self.root / 'private'
        target.write_text('keep')
        (self.root / 'etc/apt/sources.list').symlink_to(target)
        with self.assertRaises(RuntimeError):
            module.configure(self.root)
        self.assertEqual(target.read_text(), 'keep')
