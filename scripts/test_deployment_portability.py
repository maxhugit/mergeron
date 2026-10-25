"""Keep host-specific adapters out of the generic Docker installation path."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DeploymentPortabilityTest(unittest.TestCase):
    def test_checks_and_canonical_build_files_are_host_neutral(self):
        paths = list((ROOT / '.github').rglob('*.yml')) + [
            ROOT / '.github/PULL_REQUEST_TEMPLATE.md', ROOT / 'Dockerfile',
            ROOT / 'Dockerfile.manager', ROOT / 'docker-compose.yml',
            ROOT / 'deployment/compose.yml', ROOT / 'deployment/.env.example',
            ROOT / 'deployment/.env.dev.example', ROOT / '.env.example',
        ]
        for path in paths:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertNotIn('unraid', path.read_text().lower())
        self.assertFalse((ROOT / 'Dockerfile.unraid').exists())
        self.assertFalse((ROOT / 'deployment/compose.unraid.yml').exists())
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('USER 11002:11002', dockerfile)
        self.assertIn('AS ssh-test-server', dockerfile)
        adapter = (ROOT / 'deployment/adapters/unraid/compose.yml').read_text()
        for forbidden in ['volumes:', 'ports:', 'networks:', 'privileged:', 'cap_add:']:
            self.assertNotIn(forbidden, adapter)

    def test_generic_documentation_does_not_require_a_host_product(self):
        paths = list((ROOT / 'docs').glob('*.md')) + [
            ROOT / 'README.md', ROOT / 'CONTRIBUTING.md',
            ROOT / 'SECURITY.md', ROOT / 'deployment/README.md',
        ]
        for path in paths:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertNotIn('unraid', path.read_text().lower())

    def test_runtime_and_ui_keep_platform_names_in_explicit_adapters_only(self):
        paths = list((ROOT / 'src').rglob('*.ts')) + list((ROOT / 'web/src').rglob('*.tsx')) + list((ROOT / 'web/src').rglob('*.ts')) + list((ROOT / 'web/src/locales').rglob('*.json')) + list((ROOT / 'manager/src').rglob('*.mjs'))
        for path in paths:
            if '.spec.' in path.name or 'codex-schema' in path.parts or path == ROOT / 'manager/src/integrations/host-platform.mjs':
                continue
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertNotIn('unraid', path.read_text().lower())
        manifest = (ROOT / 'manager/stack-manifest.json').read_text()
        # The historical repository is an adoption alias, not a default or a cache.
        self.assertNotIn('unraid', manifest.replace('ghcr.io/maxhugit/codex-webui-unraid', '').lower())


if __name__ == '__main__':
    unittest.main()
