#!/usr/bin/env python3
"""Adopt the existing DEV browser without changing its image or isolation."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import time
import uuid

spec = importlib.util.spec_from_file_location('dev_manager', Path(__file__).with_name('update-dev-manager.py'))
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
NAME = 'mergeron-dev-browser'


def specification(old):
    host = old.get('HostConfig', {})
    config = old.get('Config', {})
    if (old.get('Name') != '/' + NAME or
            config.get('Labels', {}).get('io.mergeron.dev-browser') != 'true' or
            config.get('User') != 'pwuser' or not host.get('ReadonlyRootfs') or
            host.get('Privileged') or host.get('CapDrop') != ['ALL'] or host.get('CapAdd') or
            host.get('PortBindings') or old.get('Mounts') or
            'no-new-privileges:true' not in host.get('SecurityOpt', []) or
            not any(s.startswith('seccomp=') and 'unconfined' not in s for s in host.get('SecurityOpt', [])) or
            old.get('State', {}).get('Health', {}).get('Status') != 'healthy' or
            set(old.get('NetworkSettings', {}).get('Networks', {})) !=
            {'mergeron-dev-browser-control', 'mergeron-dev-browser-egress'}):
        raise RuntimeError('Existing DEV browser identity or isolation check failed')
    body = copy.deepcopy(config)
    body['Labels'] = {**config['Labels'], 'io.mergeron.managed': 'true',
                      'io.mergeron.stack': 'mergeron-dev', 'io.mergeron.component': 'browser'}
    body['HostConfig'] = copy.deepcopy(host)
    body['HostConfig']['Dns'] = ['1.1.1.1']
    endpoints = {}
    for name, endpoint in old['NetworkSettings']['Networks'].items():
        endpoints[name] = {'Aliases': [a for a in endpoint.get('Aliases') or []
                                     if a not in (old['Id'], old['Id'][:12])]}
        if endpoint.get('IPAMConfig'):
            endpoints[name]['IPAMConfig'] = endpoint['IPAMConfig']
    body['NetworkingConfig'] = {'EndpointsConfig': endpoints}
    return body


def configure():
    manager.require_idle()
    api = manager.docker
    old = manager.inspect(api, NAME)
    body = specification(old)
    suffix = uuid.uuid4().hex[:10]
    candidate_name = NAME + '-candidate-' + suffix
    rollback = NAME + '-rollback-' + suffix
    candidate = api('/containers/create?name=' + candidate_name, 'POST', body)['Id']
    renamed = stopped = candidate_named = False
    try:
        manager.require_idle()
        if manager.inspect(api, NAME)['Id'] != old['Id']:
            raise RuntimeError('DEV browser changed during configuration')
        api('/containers/' + old['Id'] + '/stop?t=20', 'POST')
        stopped = True
        api('/containers/' + old['Id'] + '/rename?name=' + rollback, 'POST')
        renamed = True
        api('/containers/' + candidate + '/rename?name=' + NAME, 'POST')
        candidate_named = True
        api('/containers/' + candidate + '/start', 'POST')
        for _ in range(40):
            current = manager.inspect(api, candidate)
            if current['State'].get('Health', {}).get('Status') == 'healthy':
                assert current['Image'] == old['Image']
                print(json.dumps({'healthy': True, 'dns': ['1.1.1.1'], 'rollbackContainer': rollback}))
                return
            time.sleep(2)
        raise RuntimeError('Browser readiness timeout')
    except Exception:
        if renamed:
            try:
                api('/containers/' + candidate + '/stop?t=10', 'POST')
            except Exception:
                pass
            if candidate_named:
                api('/containers/' + candidate + '/rename?name=' + candidate_name, 'POST')
            api('/containers/' + old['Id'] + '/rename?name=' + NAME, 'POST')
        if stopped:
            api('/containers/' + old['Id'] + '/start', 'POST')
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--confirm-configure', action='store_true', required=True)
    parser.parse_args()
    configure()
