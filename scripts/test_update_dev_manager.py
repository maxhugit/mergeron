import copy
import importlib.util
import pathlib
import unittest
from urllib.parse import unquote, urlsplit, parse_qs

spec = importlib.util.spec_from_file_location('update_dev_manager', pathlib.Path(__file__).with_name('update-dev-manager.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
OLD = 'a' * 64
NEW = 'b' * 64
REVISION = 'c' * 40
RETIRED = updater.NAME + '-rollback-0123456789'


def status():
    return {'stack': 'mergeron-dev', 'environment': 'development', 'update': {'busy': False}}


class Docker:
    def __init__(self):
        self.calls = []
        self.fail_delete = False
        self.fail_health = False
        self.containers = {OLD: {'Id': OLD, 'Name': '/' + updater.NAME,
            'State': {'Running': True, 'Status': 'running', 'Health': {'Status': 'healthy'}},
            'HostConfig': {'NetworkMode': 'none', 'Privileged': False, 'ReadonlyRootfs': True,
                           'CapDrop': ['ALL'], 'CapAdd': ['CAP_CHOWN', 'CAP_DAC_READ_SEARCH']},
            'Mounts': [{'Destination': '/host-state', 'Source': updater.STATE}],
            'Config': {'Image': updater.REPOSITORY + ':edge', 'Labels': {}}, 'Image': 'old-image'}}

    def __call__(self, path, method='GET', body=None):
        self.calls.append((path, method))
        parsed = urlsplit(path)
        parts = parsed.path.strip('/').split('/')
        query = parse_qs(parsed.query)
        if parts[0] == 'images':
            return {'Id': 'new-image', 'RepoDigests': [updater.REPOSITORY + '@sha256:' + 'd' * 64],
                    'Config': {'Labels': {'org.opencontainers.image.revision': REVISION}}}
        if parts[1] == 'create':
            self.containers[NEW] = {'Id': NEW, 'Name': '/' + query['name'][0],
                'State': {'Running': False, 'Status': 'created'}, 'HostConfig': body['HostConfig'],
                'Config': body, 'Image': 'new-image'}
            return {'Id': NEW}
        identity = unquote(parts[1])
        item = next((c for c in self.containers.values() if c['Id'] == identity or c['Name'] == '/' + identity), None)
        if item is None:
            raise RuntimeError('HTTP 404')
        if method == 'DELETE':
            if self.fail_delete:
                raise RuntimeError('delete failed')
            del self.containers[item['Id']]
        elif parts[-1] == 'json':
            return copy.deepcopy(item)
        elif parts[-1] == 'rename':
            item['Name'] = '/' + query['name'][0]
        elif parts[-1] == 'stop':
            item['State'] = {'Running': False, 'Status': 'exited'}
        elif parts[-1] == 'start':
            item['State'] = {'Running': True, 'Status': 'running', 'Health': {
                'Status': 'starting' if self.fail_health and item['Id'] == NEW else 'healthy'}}


class CleanupTests(unittest.TestCase):
    def retired(self):
        api = Docker()
        api.containers[NEW] = copy.deepcopy(api.containers[OLD])
        api.containers[NEW].update(Id=NEW, Name='/' + RETIRED, State={'Running': False, 'Status': 'exited'})
        return api

    def test_exact_stopped_container_only_without_volumes_or_force(self):
        api = self.retired()
        updater.remove_retired(api, RETIRED, NEW, OLD, status)
        self.assertEqual([c for c in api.calls if c[1] == 'DELETE'], [('/containers/' + NEW + '?force=false&v=false', 'DELETE')])
        self.assertIn(OLD, api.containers)

    def test_rejects_running_wrong_name_or_changed_active_manager(self):
        for variant in ('running', 'wrong-name', 'changed-active', 'unhealthy-active'):
            with self.subTest(variant=variant):
                api = self.retired()
                if variant == 'running': api.containers[NEW]['State']['Running'] = True
                if variant == 'wrong-name': api.containers[NEW]['Name'] = '/mergeron-manager'
                if variant == 'changed-active': api.containers[OLD]['Id'] = 'e' * 64
                if variant == 'unhealthy-active': api.containers[OLD]['State']['Health']['Status'] = 'unhealthy'
                with self.assertRaises(RuntimeError): updater.remove_retired(api, RETIRED, NEW, OLD, status)
                self.assertFalse(any(method == 'DELETE' for _, method in api.calls))

    def test_rejects_production_and_busy_manager(self):
        for state in ({**status(), 'stack': 'mergeron'}, {**status(), 'update': {'busy': True}}):
            api = self.retired()
            with self.assertRaises(RuntimeError): updater.remove_retired(api, RETIRED, NEW, OLD, lambda: state)
            self.assertEqual(api.calls, [])
        with self.assertRaises(RuntimeError): updater.remove_retired(self.retired(), 'mergeron-manager-rollback-0123456789', NEW, OLD, status)

    def test_successful_replacement_removes_old_manager_only(self):
        api = Docker()
        result = updater.replace(REVISION, api, status, lambda _: None)
        self.assertFalse(result['cleanupPending'])
        self.assertNotIn(OLD, api.containers)
        self.assertEqual(api.containers[NEW]['Name'], '/' + updater.NAME)

    def test_browser_enablement_is_explicit_and_persists(self):
        api = Docker()
        browser_id = 'f' * 64
        api.containers[browser_id] = {'Id': browser_id, 'Name': '/mergeron-dev-browser',
            'Config': {'Labels': {'io.mergeron.stack': 'mergeron-dev', 'io.mergeron.component': 'browser', 'io.mergeron.managed': 'true'}},
            'HostConfig': {'Dns': ['1.1.1.1']}, 'State': {'Health': {'Status': 'healthy'}}}
        updater.replace(REVISION, api, status, lambda _: None, manage_browser=True)
        self.assertIn('MERGERON_MANAGE_BROWSER=true', api.containers[NEW]['Config']['Env'])
        self.assertIn(browser_id, api.containers)

    def test_browser_enablement_refuses_unverified_browser(self):
        api = Docker()
        with self.assertRaises(RuntimeError):
            updater.replace(REVISION, api, status, lambda _: None, manage_browser=True)
        self.assertFalse(any('/stop' in path for path, _ in api.calls))

    def test_failed_health_restores_old_manager_without_deleting_it(self):
        api = Docker()
        api.fail_health = True
        with self.assertRaisesRegex(RuntimeError, 'health timed out'):
            updater.replace(REVISION, api, status, lambda _: None)
        self.assertEqual(api.containers[OLD]['Name'], '/' + updater.NAME)
        self.assertTrue(api.containers[OLD]['State']['Running'])
        self.assertFalse(any(method == 'DELETE' for _, method in api.calls))

    def test_cleanup_failure_never_rolls_back_healthy_new_manager(self):
        api = Docker()
        api.fail_delete = True
        result = updater.replace(REVISION, api, status, lambda _: None)
        self.assertTrue(result['cleanupPending'])
        self.assertEqual(api.containers[NEW]['Name'], '/' + updater.NAME)
        self.assertTrue(api.containers[NEW]['State']['Running'])
        self.assertIn(OLD, api.containers)
        self.assertFalse(api.containers[OLD]['State']['Running'])

    def test_pre_stop_concurrent_replacement_does_not_start_or_stop_old_manager(self):
        api = Docker()
        count = 0
        def read_status():
            nonlocal count
            count += 1
            if count == 2:
                api.containers[OLD]['Name'] = '/' + RETIRED
            return status()
        with self.assertRaises(RuntimeError):
            updater.replace(REVISION, api, read_status, lambda _: None)
        self.assertFalse(any(path.endswith('/start') or '/stop?' in path for path, _ in api.calls))

    def test_wrong_image_and_unexpected_configuration_are_not_removed(self):
        api = self.retired()
        api.containers[NEW]['Config']['Image'] = 'unrelated:latest'
        with self.assertRaises(RuntimeError): updater.remove_retired(api, RETIRED, NEW, OLD, status)
        self.assertFalse(any(method == 'DELETE' for _, method in api.calls))
        api = Docker()
        api.containers[OLD]['HostConfig']['Privileged'] = True
        with self.assertRaises(RuntimeError): updater.replace(REVISION, api, status)
        self.assertFalse(any(method != 'GET' for _, method in api.calls))


if __name__ == '__main__':
    unittest.main()
