import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('configure_browser', Path(__file__).with_name('configure-dev-browser.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigureBrowserTests(unittest.TestCase):
    def fixture(self):
        return {'Id': 'a' * 64, 'Name': '/mergeron-dev-browser',
                'Config': {'User': 'pwuser', 'Image': 'mergeron-dev-browser:existing',
                           'Env': ['BROWSER_WS_PATH=private'], 'Labels': {'io.mergeron.dev-browser': 'true'}},
                'HostConfig': {'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                               'SecurityOpt': ['no-new-privileges:true', 'seccomp=reviewed']},
                'State': {'Health': {'Status': 'healthy'}}, 'Mounts': [],
                'NetworkSettings': {'Networks': {name: {'Aliases': ['mergeron-dev-browser']}
                                                for name in ['mergeron-dev-browser-control', 'mergeron-dev-browser-egress']}}}

    def test_changes_only_dns_and_managed_labels(self):
        old = self.fixture()
        saved = copy.deepcopy(old)
        body = module.specification(old)
        self.assertEqual(body['HostConfig']['Dns'], ['1.1.1.1'])
        self.assertEqual(body['Env'], old['Config']['Env'])
        self.assertEqual(body['Image'], old['Config']['Image'])
        self.assertEqual(body['Labels']['io.mergeron.stack'], 'mergeron-dev')
        self.assertEqual(body['HostConfig']['SecurityOpt'], old['HostConfig']['SecurityOpt'])
        self.assertEqual(old, saved)

    def test_rejects_production_and_unsafe_browser(self):
        for change in ['production', 'capabilities', 'ports', 'mounts', 'sandbox', 'root']:
            old = self.fixture()
            if change == 'production': old['Name'] = '/mergeron-browser'
            if change == 'capabilities': old['HostConfig']['CapAdd'] = ['SYS_ADMIN']
            if change == 'ports': old['HostConfig']['PortBindings'] = {'3000/tcp': [{}]}
            if change == 'mounts': old['Mounts'] = [{'Source': '/var/run/docker.sock'}]
            if change == 'sandbox': old['HostConfig']['SecurityOpt'] = ['seccomp=unconfined']
            if change == 'root': old['Config']['User'] = 'root'
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                module.specification(old)
