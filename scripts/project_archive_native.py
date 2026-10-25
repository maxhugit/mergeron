"""Initialize empty native stores with the installed engine, not SQL from a ZIP.

The engine runs in an isolated, credential-free home. A fixed `true` shell turn
materializes the native paginated store; no model turn is ever requested.
"""
import json
import os
from pathlib import Path
import selectors
import signal
import sqlite3
import subprocess
import tempfile
import time
import uuid


def initialize_stores(binary, home, required):
    missing = [name for name in required if not (Path(home) / name).exists()]
    if not missing:
        return
    if not binary:
        raise RuntimeError('Le moteur d’agents est nécessaire pour initialiser son stockage.')
    with tempfile.TemporaryDirectory(prefix='mergeron-native-store-') as temporary:
        sandbox = Path(temporary)
        (sandbox / 'config.toml').write_text(
            'model_provider = "archive-initialization"\nmodel = "unused"\n'
            '[model_providers.archive-initialization]\nname = "Archive initialization"\n'
            'base_url = "http://127.0.0.1:1"\nwire_api = "responses"\n'
            'request_max_retries = 0\nstream_max_retries = 0\n'
        )
        # Do not inherit provider keys, SSH agents, proxy credentials or user config.
        env = {'PATH': os.environ.get('PATH', ''), 'HOME': temporary,
               'CODEX_HOME': temporary, 'TMPDIR': temporary, 'LANG': 'C.UTF-8'}
        process = subprocess.Popen([binary, 'app-server', '--listen', 'stdio://'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, cwd=temporary, env=env,
                                   start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffer = b''
        sequence = 0
        notifications = []

        def receive(deadline):
            nonlocal buffer
            while b'\n' not in buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise RuntimeError('Initialisation du stockage natif trop longue.')
                block = os.read(process.stdout.fileno(), 65536)
                if not block:
                    raise RuntimeError('Le moteur a interrompu l’initialisation de son stockage.')
                buffer += block
                if len(buffer) > 4 * 1024 * 1024:
                    raise RuntimeError('Réponse native anormalement volumineuse.')
            line, buffer = buffer.split(b'\n', 1)
            return json.loads(line)

        def send(message):
            process.stdin.write(json.dumps(message).encode() + b'\n')
            process.stdin.flush()

        def rpc(method, params):
            nonlocal sequence
            sequence += 1
            request = sequence
            send({'id': request, 'method': method, 'params': params})
            deadline = time.monotonic() + 30
            while True:
                message = receive(deadline)
                if message.get('id') == request and 'method' not in message:
                    if 'error' in message:
                        raise RuntimeError('Le moteur ne peut pas initialiser son stockage natif.')
                    return message['result']
                if 'id' in message and 'method' in message:
                    # Never authorize an unexpected tool, network request or escalation.
                    send({'id': message['id'], 'error': {'code': -32601, 'message': 'Archive initialization does not authorize tools'}})
                else:
                    notifications.append(message)

        try:
            rpc('initialize', {'clientInfo': {'name': 'mergeron-archive-initializer', 'version': '1'},
                               'capabilities': {'experimentalApi': True, 'requestAttestation': False}})
            send({'method': 'initialized', 'params': {}})
            thread = rpc('thread/start', {'cwd': temporary, 'sandbox': 'read-only', 'approvalPolicy': 'never', 'historyMode': 'paginated'})['thread']
            rpc('thread/goal/get', {'threadId': thread['id']})
            rpc('thread/shellCommand', {'threadId': thread['id'], 'command': 'true'})
            deadline = time.monotonic() + 30
            while not any(note.get('method') == 'turn/completed' and note.get('params', {}).get('threadId') == thread['id'] for note in notifications):
                notifications.append(receive(deadline))
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            for name in missing:
                source = sandbox / name
                if not source.is_file():
                    raise RuntimeError('Le moteur installé ne produit pas la structure requise : ' + name)
                stage = Path(home) / ('.archive-store-' + str(uuid.uuid4()) + '.sqlite')
                try:
                    origin = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
                    target = sqlite3.connect(stage)
                    try:
                        origin.backup(target)
                        # Keep native migration checksums, but never retain fixture conversations.
                        target.execute('PRAGMA foreign_keys=OFF')
                        names = [r[0] for r in target.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
                        for table in names:
                            if table in {'_sqlx_migrations', 'consolidation_progress'}:
                                continue
                            target.execute('DELETE FROM "' + table.replace('"', '""') + '"')
                        target.commit()
                    finally:
                        origin.close()
                        target.close()
                    os.chmod(stage, 0o600)
                    with stage.open('rb') as file:
                        os.fsync(file.fileno())
                    # Atomic, no-clobber installation; a concurrent native initializer wins.
                    try:
                        os.link(stage, Path(home) / name)
                        descriptor = os.open(home, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            os.fsync(descriptor)
                        finally:
                            os.close(descriptor)
                    except FileExistsError:
                        pass
                finally:
                    stage.unlink(missing_ok=True)
        finally:
            selector.close()
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()
