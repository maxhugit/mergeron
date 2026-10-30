#!/usr/bin/env python3
"""No account/inference: verify managed copy profiles against a real Codex CLI."""
import argparse
import json
import os
import signal
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', help='Absolute path to the installed managed Codex executable')
    args = parser.parse_args()
    def timed_out(_signal, _frame):
        raise TimeoutError('Native copy fixture exceeded its deadline')
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(45)
    binary = str(Path(args.binary).resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix='mergeron-copy-isolation-') as temporary:
        root = Path(temporary)
        home = root / 'home'
        home.mkdir(mode=0o700)
        home.joinpath('config.toml').write_text('''model_provider="fixture"
model="fixture"
[model_providers.fixture]
name="fixture"
base_url="http://127.0.0.1:1/v1"
wire_api="responses"
[features]
apps=false
plugins=false
''')
        project = root / 'project'
        container = project / 'sources/.external'
        own = container / 'own'
        foreign = container / 'foreign'
        for folder in (own, foreign):
            folder.mkdir(parents=True)
        foreign.joinpath('source.txt').write_text('preserve')
        project.joinpath('alias').symlink_to(foreign, target_is_directory=True)
        # The same profile contract produced by agentCopyPermissions: writable
        # project root, read-only copies container, one explicit writable owner.
        filesystem = {str(container): 'read', str(own): 'write', str(foreign): 'read'}
        profile = '{ extends = ":workspace", filesystem = { ' + ', '.join(
            json.dumps(k) + ' = ' + json.dumps(v) for k, v in filesystem.items()
        ) + ' } }'
        readonly = '{ extends = ":read-only", filesystem = { ' + ', '.join(
            json.dumps(k) + ' = "read"' for k in filesystem
        ) + ' } }'
        env = {key: value for key, value in os.environ.items() if key in (
            'PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
            'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
        )}
        env.update(CODEX_HOME=str(home), HOME=str(root))
        command = [binary, '-c', 'default_permissions="copy_fixture"',
                   '-c', 'permissions.copy_fixture=' + profile,
                   '-c', 'permissions.copy_read=' + readonly]
        # Validate the exact experimental thread profile acknowledgement without
        # starting a model turn or making a remote request.
        child = subprocess.Popen(command + ['app-server'], cwd=project, env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
        def rpc(number, method, params):
            child.stdin.write(json.dumps({'id': number, 'method': method, 'params': params}) + '\n')
            child.stdin.flush()
            while True:
                line = child.stdout.readline()
                if not line:
                    raise RuntimeError('Fixture app-server exited before replying')
                response = json.loads(line)
                if response.get('id') == number:
                    if 'error' in response:
                        raise RuntimeError('Fixture app-server rejected ' + method)
                    return response['result']
        try:
            rpc(1, 'initialize', {'clientInfo': {'name': 'copy-fixture', 'version': '1'},
                                  'capabilities': {'experimentalApi': True}})
            started = rpc(2, 'thread/start', {'cwd': str(project), 'ephemeral': True,
                                             'permissions': 'copy_fixture', 'approvalPolicy': 'never'})
            assert started['activePermissionProfile']['id'] == 'copy_fixture'
        finally:
            child.terminate()
            child.wait(timeout=10)
        # No model or backend is involved in the actual filesystem assertions.
        probe = '''import os
from pathlib import Path
own=Path('sources/.external/own')
foreign=Path('sources/.external/foreign')
own.joinpath('allowed').write_text('own')
for target in [foreign/'source.txt', Path('alias/source.txt'), foreign/'new']:
    try:
        target.write_text('forbidden')
    except OSError:
        pass
    else:
        raise AssertionError('Foreign copy write succeeded')
try:
    foreign.rename(foreign.with_name('renamed'))
except OSError:
    pass
else:
    raise AssertionError('Foreign copy rename succeeded')
'''
        result = subprocess.run(command + ['sandbox', '--', '/usr/bin/python3', '-c', probe],
                                cwd=project, env=env, capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise RuntimeError('Native copy sandbox failed: ' + result.stderr[-1500:])
        assert own.joinpath('allowed').read_text() == 'own'
        assert foreign.joinpath('source.txt').read_text() == 'preserve'
        result = subprocess.run(command + ['sandbox', '--permission-profile', 'copy_read', '--',
                                          '/usr/bin/python3', '-c',
                                          "from pathlib import Path; Path('sources/.external/own/no-write').write_text('forbidden')"],
                                cwd=project, env=env, capture_output=True, text=True, timeout=20)
        assert result.returncode != 0 and not own.joinpath('no-write').exists()
        print('PASS: native profile acknowledged; own copy writable; foreign writes, alias writes and rename refused; read-only profile preserved.')


if __name__ == '__main__':
    main()
