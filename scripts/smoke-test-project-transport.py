"""Cross-engine project round trip with isolated homes, no account or model call.

Run `export ARCHIVE BINARY` on the source runtime, then `import ARCHIVE BINARY`
on the destination. Only the fixed shell command `true` is executed.
"""
import json
import os
from pathlib import Path
import selectors
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

import project_archive as archive

ROOT = Path(__file__).resolve().parents[1]
if not (ROOT / 'drizzle').is_dir():
    ROOT = Path.cwd()


class NativeClient:
    def __init__(self, binary, home):
        self.process = subprocess.Popen(
            [binary, 'app-server', '--listen', 'stdio://'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=home, start_new_session=True,
            env={'PATH': os.environ.get('PATH', ''), 'HOME': str(home),
                 'CODEX_HOME': str(home), 'TMPDIR': str(home), 'LANG': 'C.UTF-8'})
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''
        self.sequence = 0
        self.notes = []

    def receive(self):
        deadline = time.monotonic() + 30
        while b'\n' not in self.buffer:
            if not self.selector.select(max(0, deadline - time.monotonic())):
                raise RuntimeError('Native fixture timed out')
            block = os.read(self.process.stdout.fileno(), 65536)
            if not block:
                raise RuntimeError('Native fixture exited')
            self.buffer += block
            assert len(self.buffer) < 4 * 1024 ** 2
        line, self.buffer = self.buffer.split(b'\n', 1)
        return json.loads(line)

    def send(self, message):
        self.process.stdin.write(archive.json_bytes(message) + b'\n')
        self.process.stdin.flush()

    def rpc(self, method, params):
        self.sequence += 1
        request = self.sequence
        self.send({'id': request, 'method': method, 'params': params})
        while True:
            message = self.receive()
            if message.get('id') == request and 'method' not in message:
                if 'error' in message:
                    raise RuntimeError(method + ': ' + json.dumps(message['error']))
                return message['result']
            if 'id' in message and 'method' in message:
                self.send({'id': message['id'], 'error': {'code': -32601, 'message': 'No tools authorized'}})
            else:
                self.notes.append(message)

    def initialize(self):
        self.rpc('initialize', {'clientInfo': {'name': 'mergeron-project-transport-test', 'version': '1'},
                                'capabilities': {'experimentalApi': True, 'requestAttestation': False}})
        self.send({'method': 'initialized', 'params': {}})

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=5)
        finally:
            self.selector.close()
            self.process.stdout.close()


def create_database(path):
    with sqlite3.connect(path) as db:
        for migration in json.loads((ROOT / 'drizzle/meta/_journal.json').read_text())['entries']:
            db.executescript((ROOT / 'drizzle' / (migration['tag'] + '.sql')).read_text())


def main():
    action, file, binary = sys.argv[1:]
    version = subprocess.check_output([binary, '--version'], text=True).strip().split()[-1]
    with tempfile.TemporaryDirectory(prefix='mergeron-project-runtime-test-') as temporary:
        base = Path(temporary)
        home, workspace = base / 'home', base / 'workspaces'
        home.mkdir()
        workspace.mkdir()
        (home / 'config.toml').write_text('model_provider="fixture"\nmodel="unused"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:1"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n')
        database = base / 'application.sqlite'
        create_database(database)
        options = dict(database=str(database), codexHome=str(home), workspaceRoot=str(workspace),
                       codexBin=binary, codexVersion=version, version='0.2.1', archive=file)
        if action == 'export':
            project = workspace / 'fixture-project'
            project.mkdir()
            (project / 'document.txt').write_text('Portable project fixture\n')
            client = NativeClient(binary, home)
            try:
                client.initialize()
                thread = client.rpc('thread/start', {'cwd': str(project), 'sandbox': 'read-only', 'approvalPolicy': 'never', 'historyMode': 'paginated'})['thread']
                client.rpc('thread/goal/get', {'threadId': thread['id']})
                client.rpc('thread/shellCommand', {'threadId': thread['id'], 'command': 'true'})
                while not any(n.get('method') == 'turn/completed' for n in client.notes):
                    client.notes.append(client.receive())
                child = client.rpc('thread/fork', {'threadId': thread['id'], 'cwd': str(project), 'sandbox': 'read-only', 'approvalPolicy': 'never', 'historyMode': 'paginated'})['thread']
                client.rpc('thread/shellCommand', {'threadId': child['id'], 'command': 'true'})
                while not any(n.get('method') == 'turn/completed' and n.get('params', {}).get('threadId') == child['id'] for n in client.notes):
                    client.notes.append(client.receive())
            finally:
                client.close()
            with sqlite3.connect(database) as db:
                db.execute('INSERT INTO projects(id,name,workspace_path,workspace_layout_version,created_at,updated_at) VALUES(?,?,?,2,1,1)', ('fixture-project', 'Fixture', str(project)))
                db.execute('INSERT INTO project_workspaces(id,project_id,name,path,is_primary,created_at,updated_at) VALUES(?,?,?,?,1,1,1)', ('fixture-workspace', 'fixture-project', 'Main', str(project)))
                db.execute('INSERT INTO project_agent_threads VALUES(?,?,?,?,?)', (thread['id'], 'fixture-project', str(project), 1, 1))
                db.execute('INSERT INTO project_agent_threads VALUES(?,?,?,?,?)', (child['id'], 'fixture-project', str(project), 1, 1))
                db.execute('INSERT INTO conversation_branch_edges VALUES(?,?,?,?,?,?,?,?)', (child['id'], thread['id'], thread['id'], '__end__', '__start__', '[]', 1, 'local'))
                db.execute('INSERT INTO conversation_branch_edges VALUES(?,?,?,?,?,?,?,?)', ('outside-project', thread['id'], thread['id'], '__end__', '__start__', '[]', 1, 'local'))
            result = archive.export_archive(dict(options, projectId='fixture-project'))
            print(json.dumps({'action': action, 'engine': version, 'files': result['files']}))
        elif action == 'import':
            preview = archive.run(dict(options, action='preview'))
            with archive.read_archive(file)[0] as zip_file:
                manifest = json.loads(zip_file.read('manifest.json'))
                result = archive.import_archive(options, zip_file, manifest)
            with archive.connect(database, True) as db:
                thread_ids = [r[0] for r in db.execute('SELECT thread_id FROM project_agent_threads WHERE project_id=?', (result['projectId'],))]
                assert not db.execute('PRAGMA foreign_key_check').fetchall()
            client = NativeClient(binary, home)
            try:
                client.initialize()
                counts = []
                for thread_id in thread_ids:
                    thread = client.rpc('thread/read', {'threadId': thread_id, 'includeTurns': False})['thread']
                    turns = client.rpc('thread/turns/list', {'threadId': thread_id, 'limit': 100})['data']
                    assert turns, 'Imported native history must remain readable'
                    assert thread['id'] == thread_id
                    counts.append(len(turns))
                assert sorted(counts) == [1, 2], 'The child must retain its inherited turn and its own turn'
            finally:
                client.close()
            assert (workspace / result['projectId'] / 'document.txt').read_text() == 'Portable project fixture\n'
            print(json.dumps({'action': action, 'engine': version, 'compatible': preview['compatible'], 'readableTurns': sorted(counts)}))
        else:
            raise ValueError('Expected export or import')


if __name__ == '__main__':
    main()
