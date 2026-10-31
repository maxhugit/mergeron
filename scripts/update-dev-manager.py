#!/usr/bin/env python3
"""Host-side replacement of the dev Manager; never removes images or volumes."""
import argparse
import copy
import http.client
import json
import re
import socket
import time
import uuid
from urllib.parse import quote

NAME = 'mergeron-dev-manager'
STATE = '/mnt/pool/appdata/mergeron-dev/state'
SOCKET = STATE + '/manager-run/manager.sock'
REPOSITORY = 'ghcr.io/maxhugit/mergeron-manager'


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=120)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def request(socket_path, path, method='GET', body=None):
    connection = UnixConnection(socket_path)
    try:
        connection.request(method, path, None if body is None else json.dumps(body),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read()
        if response.status >= 300:
            # Never relay daemon responses: they may contain configuration secrets.
            raise RuntimeError('HTTP ' + str(response.status))
        if path.startswith('/images/create?'):
            for line in data.splitlines():
                if line.strip() and json.loads(line).get('error'):
                    raise RuntimeError('Manager image pull failed')
            return None
        return json.loads(data) if data else None
    finally:
        connection.close()


def docker(path, method='GET', body=None):
    return request('/var/run/docker.sock', path, method, body)


def manager(path='/v1/status'):
    return request(SOCKET, path)


def require_idle(read_status=manager):
    state = read_status()
    if (state.get('stack') != 'mergeron-dev' or
            state.get('environment') != 'development' or
            state.get('update', {}).get('busy') is not False or
            (state.get('update', {}).get('operation') or {}).get('status') not in
            (None, 'succeeded', 'rolledBack', 'cancelled')):
        raise RuntimeError('Dev Manager is not idle and safe')


def inspect(api, identity):
    return api('/containers/' + quote(identity, safe='') + '/json')


def require_active(api, expected_id):
    active = inspect(api, NAME)
    if (active.get('Id') != expected_id or active.get('Name') != '/' + NAME or
            not active.get('State', {}).get('Running') or
            active.get('State', {}).get('Health', {}).get('Status') != 'healthy'):
        raise RuntimeError('Active dev Manager changed or is unhealthy')
    return active


def require_isolated_configuration(value):
    host = value['HostConfig']
    if (host.get('NetworkMode') != 'none' or host.get('Privileged') or
            not host.get('ReadonlyRootfs') or host.get('CapDrop') != ['ALL'] or
            set(host.get('CapAdd') or []) != {'CAP_CHOWN', 'CAP_DAC_READ_SEARCH'} or
            not any(m.get('Destination') == '/host-state' and m.get('Source') == STATE
                    for m in value.get('Mounts', []))):
        raise RuntimeError('Unexpected dev Manager configuration')


def enable_restart(api=docker, read_status=manager):
    """Explicit host repair: policy only, no stop/start, recreation or data writes."""
    require_idle(read_status)
    original = inspect(api, NAME)
    require_active(api, original['Id'])
    require_isolated_configuration(original)
    policy = {'Name': 'unless-stopped', 'MaximumRetryCount': 0}
    if original['HostConfig'].get('RestartPolicy') == policy:
        return {'changed': False, 'restartPolicy': policy['Name'], 'restarted': False}
    require_idle(read_status)
    require_active(api, original['Id'])
    api('/containers/' + quote(original['Id'], safe='') + '/update', 'POST',
        {'RestartPolicy': policy})
    current = require_active(api, original['Id'])
    expected_host = {**original['HostConfig'], 'RestartPolicy': policy}
    if (current['HostConfig'] != expected_host or current['Config'] != original['Config'] or
            current.get('Image') != original.get('Image') or
            current.get('RestartCount') != original.get('RestartCount')):
        raise RuntimeError('Dev Manager changed during restart-policy verification')
    return {'changed': True, 'restartPolicy': policy['Name'], 'restarted': False}


def validate_retired(api, name, expected_id, active_id):
    if not re.fullmatch(NAME + r'-rollback-[0-9a-f]{10}', name):
        raise RuntimeError('Not an explicitly named retired dev Manager')
    require_active(api, active_id)
    old = inspect(api, expected_id)
    if (old.get('Id') != expected_id or expected_id == active_id or
            old.get('Name') != '/' + name or
            old.get('State', {}).get('Running') is not False or
            old.get('State', {}).get('Status') != 'exited' or
            not re.fullmatch(re.escape(REPOSITORY) + r'(?:@sha256:[0-9a-f]{64}|:[A-Za-z0-9_.-]+)',
                             old.get('Config', {}).get('Image', ''))):
        raise RuntimeError('Retired dev Manager identity/state does not match')


def remove_retired(api, name, expected_id, active_id, read_status=manager):
    require_idle(read_status)
    validate_retired(api, name, expected_id, active_id)
    # Exact ID only. No force, volume removal, image pruning or filesystem calls.
    api('/containers/' + quote(expected_id, safe='') + '?force=false&v=false', 'DELETE')


def replace(revision, api=docker, read_status=manager, sleep=time.sleep, manage_browser=False):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise RuntimeError('A full Git revision is required')
    require_idle(read_status)
    old = inspect(api, NAME)
    require_active(api, old['Id'])
    host = old['HostConfig']
    require_isolated_configuration(old)
    tag = REPOSITORY + ':sha-' + revision[:7]
    api('/images/create?fromImage=' + quote(tag, safe=''), 'POST')
    image = api('/images/' + quote(tag, safe='') + '/json')
    labels = image.get('Config', {}).get('Labels') or {}
    if labels.get('org.opencontainers.image.revision') != revision:
        raise RuntimeError('Manager image revision mismatch')
    digest = next(d for d in image['RepoDigests'] if d.startswith(REPOSITORY + '@sha256:'))
    body = copy.deepcopy(old['Config'])
    if manage_browser:
        browser = inspect(api, 'mergeron-dev-browser')
        if (browser.get('Name') != '/mergeron-dev-browser' or
                browser.get('Config', {}).get('Labels', {}).get('io.mergeron.stack') != 'mergeron-dev' or
                browser.get('Config', {}).get('Labels', {}).get('io.mergeron.component') != 'browser' or
                browser.get('Config', {}).get('Labels', {}).get('io.mergeron.managed') != 'true' or
                browser.get('HostConfig', {}).get('Dns') != ['1.1.1.1'] or
                browser.get('State', {}).get('Health', {}).get('Status') != 'healthy'):
            raise RuntimeError('Managed DEV browser must be healthy and explicitly labeled')
        body['Env'] = [entry for entry in body.get('Env', []) if not entry.startswith('MERGERON_MANAGE_BROWSER=')] + ['MERGERON_MANAGE_BROWSER=true']
    body['Image'] = digest
    body['Labels'] = {**(body.get('Labels') or {}),
                      **{k: v for k, v in labels.items() if k.startswith('org.opencontainers.image.')}}
    body['HostConfig'] = copy.deepcopy(host)
    suffix = uuid.uuid4().hex[:10]
    candidate_name = NAME + '-candidate-' + suffix
    retired_name = NAME + '-rollback-' + suffix
    candidate = api('/containers/create?name=' + candidate_name, 'POST', body)['Id']
    renamed = candidate_named = stopped = False
    try:
        require_idle(read_status)
        require_active(api, old['Id'])
        api('/containers/' + old['Id'] + '/stop?t=30', 'POST')
        stopped = True
        api('/containers/' + old['Id'] + '/rename?name=' + retired_name, 'POST')
        renamed = True
        api('/containers/' + candidate + '/rename?name=' + NAME, 'POST')
        candidate_named = True
        api('/containers/' + candidate + '/start', 'POST')
        for _ in range(45):
            current = inspect(api, candidate)
            if current['State'].get('Health', {}).get('Status') == 'healthy':
                break
            if not current['State'].get('Running'):
                raise RuntimeError('Manager candidate stopped')
            sleep(2)
        else:
            raise RuntimeError('Manager candidate health timed out')
        require_idle(read_status)
        require_active(api, candidate)
        if current['HostConfig'] != host or current['Image'] != image['Id']:
            raise RuntimeError('Manager candidate configuration changed')
    except Exception:
        if renamed:
            try:
                api('/containers/' + candidate + '/stop?t=10', 'POST')
            except Exception:
                pass
            if candidate_named:
                api('/containers/' + candidate + '/rename?name=' + candidate_name, 'POST')
            api('/containers/' + old['Id'] + '/rename?name=' + NAME, 'POST')
        # Never start an old Manager when pre-stop validation found a concurrent
        # replacement. Also covers interruption between our stop and rename.
        if stopped:
            api('/containers/' + old['Id'] + '/start', 'POST')
        raise
    # Commit point: cleanup must NOT roll back a healthy replacement on failure.
    try:
        remove_retired(api, retired_name, old['Id'], candidate, read_status)
    except Exception:
        return {'healthy': True, 'revision': revision, 'cleanupPending': True,
                'retainedContainer': retired_name}
    return {'healthy': True, 'revision': revision, 'cleanupPending': False,
            'removedContainer': retired_name}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('revision', nargs='?')
    parser.add_argument('--confirm-replace', action='store_true')
    parser.add_argument('--manage-browser', action='store_true')
    parser.add_argument('--enable-restart', action='store_true',
                        help='Set unless-stopped on the verified idle Dev Manager only; no restart')
    parser.add_argument('--confirm-restart', action='store_true')
    parser.add_argument('--cleanup-only', action='store_true')
    parser.add_argument('--retired', action='append', default=[], metavar='NAME=ID')
    args = parser.parse_args()
    if args.enable_restart or args.confirm_restart:
        if (not args.enable_restart or not args.confirm_restart or args.revision or
                args.confirm_replace or args.manage_browser or args.cleanup_only or args.retired):
            parser.error('Restart-policy repair requires --enable-restart --confirm-restart only')
        print(json.dumps(enable_restart()), flush=True)
    elif args.cleanup_only:
        if args.revision or args.confirm_replace or args.manage_browser or not args.retired:
            parser.error('Cleanup requires explicit retired NAME=ID pairs only')
        require_idle()
        active_id = inspect(docker, NAME)['Id']
        targets = [pair.split('=', 1) for pair in args.retired]
        if any(len(pair) != 2 or not re.fullmatch(r'[0-9a-f]{64}', pair[1]) for pair in targets):
            parser.error('Invalid NAME=ID pair')
        # Validate all targets before the first removal.
        for name, identity in targets:
            validate_retired(docker, name, identity, active_id)
        before = sorted(b['id'] for b in manager('/v1/backups').get('backups', []))
        for name, identity in targets:
            remove_retired(docker, name, identity, active_id)
            print(json.dumps({'removedContainer': name, 'volumesRemoved': False}), flush=True)
        after = sorted(b['id'] for b in manager('/v1/backups').get('backups', []))
        require_active(docker, active_id)
        print(json.dumps({'managerHealthy': True, 'backupCountBefore': len(before),
                          'backupCountAfter': len(after), 'backupsUnchanged': before == after}), flush=True)
    elif args.confirm_replace and args.revision and not args.retired:
        result = replace(args.revision, manage_browser=args.manage_browser)
        print(json.dumps(result), flush=True)
        return 2 if result['cleanupPending'] else 0
    else:
        parser.error('Replacement requires REVISION --confirm-replace')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
