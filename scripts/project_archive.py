"""Versioned, project-scoped ZIP transport. Never executes SQL supplied by an archive.

Invoked by the authenticated application, not a public command-line restore tool.
Only the Python standard library is required in the runtime image.
"""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import fcntl
import secrets
from contextlib import contextmanager
import shutil
import sqlite3
import stat
import sys
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timezone

FORMAT = 1
AGENT_CODECS = {'0.153': 'codex-history-0.153', '0.162': 'codex-history-state5-v2',
                '0.164': 'codex-history-state5-v2'}
CAPABILITIES = {'relational-v1', 'workspace-tree-v1', 'simple-chat-v1',
                'tasks-v1', 'deliverables-v1', 'knowledge-v1', 'automation-v1',
                'workspace-connections-v1', 'conversation-branches-v1', 'codex-history-0.153',
                'agent-display-detail-v1', 'codex-history-state5-v2', 'autonomous-branches-v1',
                'operational-path-relocation-v1'}
MAX_BYTES = 1024 ** 3
MAX_ZIP = 96 * 1024 ** 2
MAX_ENTRY = 256 * 1024 ** 2
MAX_ENTRIES = 20000
MAX_JSON = 64 * 1024 ** 2
EXCLUDED = {'project_workspace_secrets', 'document_access_sessions', 'impersonation_audit',
            # Transitional projections rebuild from the legacy records on import.
            'project_connections', 'project_locations',
            'auth_sessions', 'local_auth_credentials', 'oidc_auth_flows'}
THREAD_TABLES = {'token_usage_snapshots', 'turn_diffs', 'turn_errors',
                 'conversation_branch_groups', 'conversation_branch_versions',
                 'conversation_branch_edges', 'conversation_branch_active_members',
                 'conversation_owners'}
NATIVE_TABLES = {'threads', 'thread_dynamic_tools', 'thread_spawn_edges',
                 'thread_attachments', 'thread_read_receipts', 'guardian_review_feedback',
                 'projects', 'project_roots', 'thread_sections'}
AUXILIARY = {
    'thread_history_1.sqlite': {'thread_turns', 'thread_items', 'thread_history_projection_state', 'thread_realtime_items'},
    'goals_1.sqlite': {'thread_goals', 'thread_goal_continuation_deferrals'},
    'memories_1.sqlite': {'stage1_outputs'},
}
ID_KEYS = {'id', 'group_id', 'version_id', 'thread_id', 'child_thread_id',
           'tree_root_thread_id', 'conversation_id'}


class ArchiveError(Exception):
    pass


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def fail(message):
    raise ArchiveError(message)


def quote(name):
    if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name):
        fail('Identifiant de structure invalide.')
    return '"' + name + '"'


def connect(path, readonly=False):
    db = sqlite3.connect(Path(path).resolve().as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=10, factory=ClosingConnection)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA trusted_schema=OFF')
    return db


def tables(db):
    return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def columns(db, table):
    return [dict(r) for r in db.execute('SELECT * FROM pragma_table_info(?)', (table,))]


def rows(db, table):
    return [dict(r) for r in db.execute('SELECT * FROM ' + quote(table))]


def scoped_rows(db, table, column, values):
    values = list({v for v in values if v is not None})
    result = []
    byte_count = 0
    for offset in range(0, len(values), 400):
        batch = values[offset:offset + 400]
        query = 'SELECT * FROM ' + quote(table) + ' WHERE ' + quote(column) + ' IN (' + ','.join('?' for _ in batch) + ')'
        for row in db.execute(query, batch):
            record = dict(row)
            byte_count += len(json_bytes(record))
            if byte_count > MAX_JSON or len(result) >= 100_000:
                fail('Les données structurées du projet dépassent les limites de transport.')
            result.append(record)
    return result


def encoded(value):
    if isinstance(value, bytes):
        return {'$binary': base64.b64encode(value).decode('ascii')}
    if isinstance(value, dict):
        return {k: encoded(v) for k, v in value.items()}
    if isinstance(value, list):
        return [encoded(v) for v in value]
    return value


def decoded(value):
    if isinstance(value, dict) and set(value) == {'$binary'}:
        return base64.b64decode(value['$binary'], validate=True)
    return value


def json_bytes(value):
    return json.dumps(encoded(value), ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_text(file, text):
    file = Path(file)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + file.name + '-', dir=file.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, file)
        sync_directory(file.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def allowed_table(name):
    return (name == 'projects' or name.startswith('project_') or
            name in THREAD_TABLES or name in {'simple_chat_threads', 'simple_chat_messages', 'people', 'settings'}) and name not in EXCLUDED


def agent_codec(version):
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        fail('Version du moteur d’agents indisponible ou invalide.')
    minor = '.'.join(version.split('.')[:2])
    if minor not in AGENT_CODECS:
        fail('Moteur Codex ' + version + ' non pris en charge par les codecs de transport vérifiés (0.153.x, 0.162.x, 0.164.x).')
    return minor, AGENT_CODECS[minor]


def history_base(payload):
    base = payload.get('history_base', payload.get('historyBase'))
    if base is None:
        return None
    if not isinstance(base, dict):
        fail('La base d’historique d’une branche est invalide.')
    parent = base.get('thread_id', base.get('threadId'))
    offset = base.get('end_byte_offset', base.get('endByteOffset'))
    ordinal = base.get('end_ordinal_exclusive', base.get('endOrdinalExclusive'))
    if not isinstance(parent, str) or not parent or type(offset) is not int or offset < 0 or type(ordinal) is not int or ordinal < 0:
        fail('La base d’historique d’une branche est invalide.')
    return parent, offset, ordinal


def history_header(stream):
    line = stream.readline(MAX_JSON + 1)
    if len(line) > MAX_JSON:
        fail('L’en-tête d’historique dépasse les limites de transport.')
    event = json.loads(line)
    if not isinstance(event, dict) or event.get('type') != 'session_meta' or not isinstance(event.get('payload'), dict):
        fail('L’historique d’un agent ne possède pas d’en-tête reconnu.')
    return event['payload']


def validate_branch_topology(data, thread_ids):
    for table in THREAD_TABLES:
        for record in data.get(table, []):
            if any(v and k.endswith('thread_id') and v not in thread_ids for k, v in record.items()):
                fail('Une branche référence une conversation hors du ZIP : ' + table)
    groups = {g['group_id'] for g in data.get('conversation_branch_groups', [])}
    if any(v['group_id'] not in groups for v in data.get('conversation_branch_versions', [])):
        fail('Groupe de branche absent du ZIP.')
    edges = {e['child_thread_id']: e['parent_thread_id'] for e in data.get('conversation_branch_edges', [])}
    for thread in edges:
        seen = set()
        while thread in edges:
            if len(seen) > 400:
                fail('La profondeur des branches dépasse la limite de transport.')
            if thread in seen:
                fail('Le graphe de branches contient un cycle.')
            seen.add(thread)
            thread = edges[thread]


def validate_agent_versions(source, destination):
    try:
        origin, source_codec = agent_codec(source)
        target, target_codec = agent_codec(destination)
    except ArchiveError as error:
        fail('Historique d’agent créé avec Codex ' + source + ', moteur cible ' + destination + '. ' + str(error))
    if source_codec != target_codec or int(origin.split('.')[1]) > int(target.split('.')[1]):
        fail('Historique d’agent créé avec Codex ' + source + ', moteur cible ' + destination + '. Cette conversion n’est pas prise en charge ; mettez la destination à jour avec un moteur compatible.')


def autonomous_branches(db, selected, thread_ids, warnings):
    """An induced graph: never traverse an outside conversation to export its data."""
    names = tables(db)
    if 'conversation_branch_edges' not in names:
        return
    candidates = {}
    for column in ('child_thread_id', 'parent_thread_id', 'tree_root_thread_id'):
        for edge in scoped_rows(db, 'conversation_branch_edges', column, thread_ids):
            candidates[edge['child_thread_id']] = edge
    edges = {key: edge for key, edge in candidates.items()
             if edge['child_thread_id'] in thread_ids and edge['parent_thread_id'] in thread_ids}

    def root(thread_id):
        seen = set()
        while thread_id in edges:
            if len(seen) > 400:
                fail('La profondeur des branches dépasse la limite de transport.')
            if thread_id in seen:
                fail('Le graphe de branches contient un cycle ; export impossible.')
            seen.add(thread_id)
            thread_id = edges[thread_id]['parent_thread_id']
        return thread_id

    boundary = any(e['child_thread_id'] not in thread_ids or e['parent_thread_id'] not in thread_ids
                   or e['tree_root_thread_id'] not in thread_ids for e in candidates.values())
    for edge in edges.values():
        edge['tree_root_thread_id'] = root(edge['child_thread_id'])
    selected['conversation_branch_edges'] = list(edges.values())
    if 'conversation_branch_versions' in names and 'conversation_branch_groups' in names:
        versions = scoped_rows(db, 'conversation_branch_versions', 'thread_id', thread_ids)
        groups = {g['group_id']: g for g in scoped_rows(db, 'conversation_branch_groups', 'group_id', {v['group_id'] for v in versions})}
        rebuilt, grouped = {}, {}
        for version in versions:
            original = groups.get(version['group_id'])
            if original is None:
                fail('Groupe de branche manquant ; export impossible.')
            local_root = root(version['thread_id'])
            group = dict(original)
            if original['tree_root_thread_id'] != local_root:
                boundary = True
                group['group_id'] = str(uuid.uuid5(uuid.NAMESPACE_URL, 'mergeron-archive-group:' + original['group_id'] + ':' + local_root))
                group['tree_root_thread_id'] = local_root
            rebuilt[group['group_id']] = group
            version['group_id'] = group['group_id']
            grouped.setdefault(group['group_id'], []).append(version)
        for versions_in_group in grouped.values():
            for position, version in enumerate(sorted(versions_in_group, key=lambda v: (v['version_index'], v['version_id'])), 1):
                version['version_index'] = position
        selected['conversation_branch_groups'] = list(rebuilt.values())
        selected['conversation_branch_versions'] = versions
    if 'conversation_branch_active_members' in names:
        members = {}
        for record in selected.get('conversation_branch_active_members', []):
            if record['active_thread_id'] in thread_ids:
                local_root = root(record['active_thread_id'])
                boundary |= record['tree_root_thread_id'] != local_root
                candidate = dict(record, tree_root_thread_id=local_root)
            elif record['tree_root_thread_id'] in thread_ids:
                boundary = True
                local_root = root(record['tree_root_thread_id'])
                candidate = dict(record, tree_root_thread_id=local_root, active_thread_id=local_root)
            else:
                continue
            if local_root not in members or members[local_root]['updated_at'] < candidate['updated_at']:
                members[local_root] = candidate
        selected['conversation_branch_active_members'] = list(members.values())
    if boundary:
        warnings.append('Des liens de branches vers des conversations extérieures au projet ne sont pas transférés. Les conversations du projet conservent leur propre historique et deviennent autonomes ; aucune association de production n’est modifiée.')


def select_project(db, project_id, warnings=None, relocations=None):
    """FK closure, excluding people as a traversal root (people span projects)."""
    names = {name for name in tables(db) if allowed_table(name)}
    selected = {name: [] for name in names}
    table_columns = {name: {c['name'] for c in columns(db, name)} for name in names}
    for name in names:
        if name == 'projects':
            selected[name] = scoped_rows(db, name, 'id', {project_id})
        elif 'project_id' in table_columns[name]:
            selected[name] = scoped_rows(db, name, 'project_id', {project_id})
    if len(selected.get('projects', [])) != 1:
        fail('Projet introuvable.')
    for _ in range(len(names)):
        changed = False
        for name in names - {'projects', 'people', 'settings'}:
            if 'project_id' in table_columns[name]:
                continue
            fks = [dict(r) for r in db.execute('SELECT * FROM pragma_foreign_key_list(?)', (name,))]
            keys = set(json_bytes(r) for r in selected[name])
            for fk in fks:
                if fk['table'] == 'people' or fk['table'] not in selected:
                    continue
                values = {r.get(fk['to']) for r in selected[fk['table']]}
                for record in scoped_rows(db, name, fk['from'], values):
                    key = json_bytes(record)
                    if key not in keys:
                        selected[name].append(record)
                        keys.add(key)
                        changed = True
        if not changed:
            break
    thread_ids = {r['thread_id'] for r in selected.get('project_agent_threads', [])}
    simple_ids = {r['id'] for r in selected.get('simple_chat_threads', [])}
    # Branch topology is not expressed as foreign keys in the application schema.
    for name in THREAD_TABLES & names:
        records = {}
        for column in table_columns[name] & {'thread_id', 'tree_root_thread_id', 'child_thread_id', 'parent_thread_id', 'active_thread_id', 'conversation_id'}:
            for record in scoped_rows(db, name, column, thread_ids | (simple_ids if name == 'conversation_owners' else set())):
                records[json_bytes(record)] = record
        selected[name] = list(records.values())
    autonomous_branches(db, selected, thread_ids, warnings if warnings is not None else [])
    person_ids = {v for records in selected.values() for r in records for k, v in r.items()
                  if (k.endswith('person_id') or k == 'assignee_id') and isinstance(v, str)}
    selected['people'] = scoped_rows(db, 'people', 'id', person_ids)
    # Credentials and SSO subjects are installation-specific, not project content.
    for person in selected['people']:
        person['identity_subject'] = None
    selected['settings'] = scoped_rows(db, 'settings', 'key', {prefix + tid for tid in thread_ids for prefix in ('thread-workspace:', 'thread-response-detail:')})
    primary = selected['projects'][0]['workspace_path']
    workspace_paths = [r['path'] for r in selected.get('project_workspaces', [])]
    for table, column, identity in [('project_tasks', 'workspace_path', 'id'),
                                    ('project_agent_threads', 'workspace_path', 'thread_id'),
                                    ('simple_chat_threads', 'cwd', 'id')]:
        for record in selected.get(table, []):
            path = record.get(column)
            if isinstance(path, str) and path.startswith('/') and not any(path == root or path.startswith(root.rstrip('/') + '/') for root in workspace_paths):
                if relocations is not None:
                    relocations.append({'table': table, 'id': record[identity], 'column': column, 'source': path})
                record[column] = primary
                warning = 'Des chemins de travail extérieurs aux espaces du projet sont réaffectés au projet importé. Les chemins d’origine sont conservés dans sa provenance ; aucun dossier extérieur n’est copié.'
                if warnings is not None and warning not in warnings:
                    warnings.append(warning)
    return {name: records for name, records in selected.items() if records}, thread_ids


def native_database(home):
    paths = list(Path(home).glob('state_[0-9]*.sqlite'))
    return max(paths, key=lambda p: int(re.search(r'state_(\d+)', p.name)[1])) if paths else None


def native_export(home, ids, warnings=None):
    if not ids:
        return None
    for file in Path(home).glob('*.sqlite'):
        if re.fullmatch(r'(?:thread_history|goals|memories)_\d+\.sqlite', file.name) and file.name not in AUXILIARY:
            fail('Nouvelle base d’historique non prise en charge : ' + file.name + '. Un codec de transport compatible est nécessaire pour éviter une perte de données.')
    source = native_database(home)
    if source is None:
        fail('L’historique des agents est introuvable : export complet impossible.')
    with connect(source, True) as db:
        selected = {}
        for name in NATIVE_TABLES & tables(db):
            relevant = {c['name'] for c in columns(db, name) if c['name'].endswith('thread_id') or name == 'threads' and c['name'] == 'id'}
            records = {}
            for column in relevant:
                for record in scoped_rows(db, name, column, ids):
                    records[json_bytes(record)] = record
            selected[name] = list(records.values())
        found = {r['id'] for r in selected.get('threads', [])}
        if found != ids:
            fail('Certains agents ne possèdent pas d’historique durable. Terminez leurs échanges avant l’export.')
        for thread in selected['threads']:
            with open_project_file(thread['rollout_path'], home) as stream:
                payload = history_header(stream)
            base = history_base(payload)
            if base and base[0] not in ids and (base[1] or base[2]):
                fail('Une branche dépend d’un préfixe d’historique stocké dans une conversation extérieure au projet. Ce préfixe doit être matérialisé avant un export autonome ; aucun historique ne sera supprimé et aucune association ne sera modifiée.')
        project_ids = {r.get('project_id') for r in selected['threads']}
        section_ids = {r.get('thread_section_id') for r in selected['threads']}
        for name, key, values in [('projects', 'id', project_ids), ('project_roots', 'project_id', project_ids), ('thread_sections', 'id', section_ids)]:
            if name in tables(db):
                selected[name] = scoped_rows(db, name, key, values)
        for name in tables(db) - NATIVE_TABLES:
            cols = {c['name'] for c in columns(db, name)}
            if 'thread_id' in cols and scoped_rows(db, name, 'thread_id', ids):
                fail('Ce moteur d’agents utilise une section non prise en charge : ' + name)
        if 'thread_spawn_edges' in selected:
            spawn = selected['thread_spawn_edges']
            selected['thread_spawn_edges'] = [r for r in spawn if r['parent_thread_id'] in ids and r['child_thread_id'] in ids]
            if len(selected['thread_spawn_edges']) != len(spawn) and warnings is not None:
                warnings.append('Des liens de sous-agents extérieurs au projet ne sont pas transférés. Aucun historique appartenant à une autre conversation n’est ajouté au ZIP.')
        auxiliary = {}
        for filename, allowed in AUXILIARY.items():
            if not (Path(home) / filename).is_file():
                continue
            with connect(Path(home) / filename, True) as history:
                records = {n: scoped_rows(history, n, 'thread_id', ids)
                           for n in allowed & tables(history)}
                for name in tables(history) - allowed:
                    if 'thread_id' in {c['name'] for c in columns(history, name)} and scoped_rows(history, name, 'thread_id', ids):
                        fail('Le moteur utilise une nouvelle section d’historique non prise en charge : ' + filename + '/' + name)
                records = {n: r for n, r in records.items() if r}
                if any(re.sub('[^a-z]', '', r.get('status', '').lower()) in {'inprogress', 'running', 'started'} for r in records.get('thread_turns', [])):
                    fail('Un agent a encore un échange en cours. Terminez ou interrompez-le avant d’exporter le projet.')
                if records:
                    auxiliary[filename] = {'tables': records, 'schemas': {n: columns(history, n) for n in records}}
        names = {}
        index = Path(home) / 'session_index.jsonl'
        if index.exists():
            with open_project_file(index, home) as stream:
                for line in stream:
                    record = json.loads(line)
                    if record.get('id') in ids:
                        names[record['id']] = record
        return {'database': source.name, 'tables': selected, 'auxiliary': auxiliary, 'sessionIndex': list(names.values()),
                'schemas': {n: columns(db, n) for n in selected}}


def safe_file(path, root):
    path = Path(path).absolute()
    lexical_root = Path(root).absolute()
    root = lexical_root.resolve()
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        fail('Un fichier du projet pointe hors de son espace : ' + path.name)
    current = path
    while current != lexical_root and current != current.parent:
        if current.is_symlink():
            fail('Lien symbolique non transportable : ' + path.name)
        current = current.parent
    if lexical_root.is_symlink():
        fail('La racine du projet est un lien symbolique.')
    if not resolved.is_file():
        fail('Fichier spécial non transportable : ' + path.name)
    return resolved


@contextmanager
def open_project_file(file, root):
    """Reject links at every component, including a swap after initial validation."""
    real = safe_file(file, root)
    physical_root = Path(root).resolve()
    descriptor = os.open(physical_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = real.relative_to(physical_root).parts
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        handle = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        with os.fdopen(handle, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                fail('Fichier spécial ou lien physique non transportable : ' + Path(file).name)
            yield stream
    finally:
        os.close(descriptor)


def export_archive(options):
    source_db = connect(options['database'], True)
    try:
        return export_snapshot(options, source_db)
    finally:
        source_db.close()


def export_snapshot(options, source_db):
    source_db.execute('BEGIN')
    warnings = []
    relocations = []
    data, thread_ids = select_project(source_db, options['projectId'], warnings, relocations)
    native = native_export(options['codexHome'], thread_ids, warnings)
    if native:
        _, codec = agent_codec(options.get('codexVersion', ''))
        native['engineVersion'] = options.get('codexVersion', '')
    roots = []
    for workspace in data.get('project_workspaces', []):
        roots.append({'key': 'workspace-' + str(len(roots)), 'source': workspace['path'], 'kind': 'workspace'})
    primary = data['projects'][0]['workspace_path']
    if primary not in {r['source'] for r in roots}:
        fail('Espace principal absent du projet.')
    if any(r['source'] != primary and Path(primary).is_relative_to(r['source']) for r in roots):
        fail('Un espace secondaire contient l’espace principal. Réorganisez ces racines avant l’export pour préserver leur structure sans duplication.')
    # An attached local workspace must never be a parent of another project's root.
    other_paths = [r['workspace_path'] for r in rows(source_db, 'projects') if r['id'] != options['projectId']]
    other_paths += [r['path'] for r in rows(source_db, 'project_workspaces') if r['project_id'] != options['projectId']]
    for root in roots:
        physical = Path(root['source']).resolve(strict=True)
        if physical == Path(physical.anchor) or Path(options['codexHome']).resolve().is_relative_to(physical) or Path(options['database']).resolve().is_relative_to(physical):
            fail('Une racine système ne peut pas être exportée comme espace de projet.')
        for other in other_paths:
            if Path(other).resolve().is_relative_to(physical):
                fail('Un espace contient les données d’un autre projet : export refusé.')
        if (physical / '.git').is_file() or (physical / '.git/objects/info/alternates').is_file():
            fail('Un espace Git dépend d’un dépôt extérieur. Créez une copie Git autonome avant l’export.')
    if native:
        for record in native['tables']['threads']:
            safe_file(record['rollout_path'], options['codexHome'])
            roots.append({'key': 'agent-' + record['id'], 'source': record['rollout_path'], 'kind': 'agent'})
    # Chat images live outside workspaces. Copy only paths referenced by this project.
    upload_root = Path(options['codexHome']) / 'webui-uploads'
    upload_patterns = [re.compile(re.escape(prefix) + r'/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]{1,16})?') for prefix in {str(upload_root), str(upload_root.resolve())}]
    uploads = {file for pattern in upload_patterns for file in pattern.findall(json_bytes([data, native]).decode('utf-8'))}
    for root in list(roots):
        if root['kind'] == 'agent':
            with open_project_file(root['source'], options['codexHome']) as stream:
                for line in stream:
                    for pattern in upload_patterns:
                        uploads.update(pattern.findall(line.decode('utf-8')))
    for file in sorted(uploads):
        safe_file(file, upload_root)
        roots.append({'key': 'attachment-' + str(len(roots)), 'source': file, 'kind': 'attachment'})
    manifest = {'kind': 'mergeron.project', 'formatVersion': FORMAT,
                'requiredCapabilities': sorted((CAPABILITIES - set(AGENT_CODECS.values()) - {'autonomous-branches-v1', 'operational-path-relocation-v1'}) | ({codec} if native else set()) | ({'autonomous-branches-v1'} if warnings else set()) | ({'operational-path-relocation-v1'} if relocations else set())),
                'applicationVersion': options.get('version', 'unknown'), 'exportedAt': int(time.time() * 1000),
                'project': {'id': options['projectId'], 'name': data['projects'][0]['name']},
                'tables': data, 'schemas': {n: columns(source_db, n) for n in data},
                'agents': native, 'roots': roots, 'files': [], 'directories': [],
                'relocatedOperationalPaths': relocations,
                'warnings': ['Les identifiants de connexion ne sont pas transférés. Les agents et automatisations importés restent arrêtés.',
                             'Les fichiers du projet peuvent contenir des données confidentielles. Le ZIP n’est pas chiffré.',
                             'Les connexions externes sont conservées comme définitions désactivées, sans leurs secrets ni une copie de leurs serveurs distants.'] + warnings}
    if not any(r['key'].startswith('thread-response-detail:') for r in data.get('settings', [])):
        manifest['requiredCapabilities'].remove('agent-display-detail-v1')
    size = 0
    watched = []
    seen = set()
    output = Path(options['archive'])
    try:
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for root in roots:
                source = Path(root['source'])
                if root['kind'] == 'workspace':
                    watched.append((source, source.stat()))
                    # A nested workspace is already included by its parent tree.
                    if any(r['kind'] == 'workspace' and r['source'] != root['source'] and source.is_relative_to(r['source']) for r in roots):
                        continue
                candidates = [source] if root['kind'] != 'workspace' else source.rglob('*')
                for file in candidates:
                    if file.is_dir() and not file.is_symlink():
                        manifest['directories'].append({'root': root['key'], 'relative': safe_entry(file.relative_to(source).as_posix())})
                        watched.append((file, file.stat()))
                        if len(manifest['directories']) > MAX_ENTRIES:
                            fail('Le projet contient trop de dossiers.')
                        continue
                    real = safe_file(file, options['codexHome'] if root['kind'] != 'workspace' else source)
                    before = real.stat()
                    if before.st_size > MAX_ENTRY:
                        fail('Un fichier dépasse la limite de 256 Mio : ' + file.name)
                    if len(manifest['files']) >= MAX_ENTRIES:
                        fail('Le projet dépasse la limite de 20 000 fichiers.')
                    relative = 'file' + file.suffix if root['kind'] != 'workspace' else file.relative_to(source).as_posix()
                    entry = safe_entry('content/' + root['key'] + '/' + relative)
                    if entry.casefold() in seen:
                        fail('Deux noms de fichiers ne sont pas portables entre systèmes : ' + file.name)
                    seen.add(entry.casefold())
                    digest = hashlib.sha256()
                    with open_project_file(file, options['codexHome'] if root['kind'] != 'workspace' else source) as input_file, archive.open(entry, 'w') as target:
                        for block in iter(lambda: input_file.read(1024 * 1024), b''):
                            size += len(block)
                            if size > MAX_BYTES:
                                fail('Le projet dépasse la limite décompressée de 1 Gio.')
                            digest.update(block)
                            target.write(block)
                    after = real.stat()
                    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                        fail('Le projet a été modifié pendant l’export. Arrêtez les modifications puis réessayez.')
                    watched.append((real, after))
                    manifest['files'].append({'path': entry, 'root': root['key'], 'relative': relative,
                                              'size': before.st_size, 'sha256': digest.hexdigest(),
                                              'mode': before.st_mode & 0o777, 'mtimeNs': before.st_mtime_ns})
            source_db.rollback()
            latest, _ = select_project(source_db, options['projectId'])
            latest_native = native_export(options['codexHome'], thread_ids)
            if latest_native:
                latest_native['engineVersion'] = options.get('codexVersion', '')
            if json_bytes(latest) != json_bytes(data) or json_bytes(latest_native) != json_bytes(native):
                fail('Le projet ou un agent a été modifié pendant l’export. Attendez la fin des opérations puis réessayez.')
            for file, before in watched:
                after = file.stat()
                if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                    fail('Des fichiers ont changé pendant l’export. Réessayez lorsque le projet est au repos.')
            payload = json_bytes(manifest)
            validate_project_content(manifest)
            if len(payload) > MAX_JSON:
                fail('Les métadonnées du projet dépassent 64 Mio.')
            archive.writestr('manifest.json', payload)
        if output.stat().st_size > MAX_ZIP:
            fail('Le ZIP dépasse la limite actuelle de transfert de 96 Mio.')
        return {'name': manifest['project']['name'], 'files': len(manifest['files']), 'bytes': size, 'warnings': manifest['warnings']}
    except BaseException:
        output.unlink(missing_ok=True)
        raise


def safe_entry(name):
    p = PurePosixPath(name)
    if not name or '\\' in name or '\x00' in name or ':' in name or p.is_absolute() or any(x in ('', '.', '..') for x in name.split('/')):
        fail('Chemin dangereux dans le ZIP.')
    return name


def read_archive(file):
    if Path(file).stat().st_size > MAX_ZIP:
        fail('Le ZIP dépasse la limite de 96 Mio.')
    archive = zipfile.ZipFile(file)
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES + 1 or sum(e.file_size for e in entries) > MAX_BYTES + MAX_JSON:
        archive.close()
        fail('Archive trop volumineuse après décompression.')
    seen = set()
    for entry in entries:
        safe_entry(entry.filename)
        folded = entry.filename.casefold()
        if folded in seen or entry.flag_bits & 1 or stat.S_ISLNK(entry.external_attr >> 16):
            archive.close()
            fail('ZIP ambigu, chiffré ou contenant un lien symbolique.')
        seen.add(folded)
        if entry.file_size > (MAX_JSON if entry.filename == 'manifest.json' else MAX_ENTRY):
            archive.close()
            fail('Une entrée du ZIP est trop volumineuse.')
    try:
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('kind') != 'mergeron.project':
            fail('Ce ZIP n’est pas une sauvegarde de projet Mergeron.')
        if manifest.get('formatVersion') != FORMAT:
            fail('Format de sauvegarde ' + str(manifest.get('formatVersion')) + ' non pris en charge ; cet importeur comprend le format 1. Mettez Mergeron à jour ou réexportez avec une version compatible.')
        required = manifest.get('requiredCapabilities')
        if not isinstance(required, list) or not all(isinstance(value, str) for value in required):
            fail('Le ZIP ne décrit pas ses fonctionnalités requises.')
        unknown = set(required) - CAPABILITIES
        if unknown:
            fail('La destination ne prend pas en charge la fonctionnalité ' + sorted(unknown)[0] + '. Une version ou un convertisseur compatible est nécessaire.')
        if not isinstance(manifest.get('applicationVersion'), str) or len(manifest['applicationVersion']) > 128 or not isinstance(manifest.get('project'), dict) or not isinstance(manifest['project'].get('name'), str) or not manifest['project']['name'].strip():
            fail('Description du projet invalide.')
        if not isinstance(manifest.get('warnings'), list) or not all(isinstance(w, str) for w in manifest['warnings']):
            fail('Description des avertissements invalide.')
        expected = {'manifest.json'}
        for record in manifest['files']:
            name = safe_entry(record['path'])
            if name in expected or not name.startswith('content/'):
                fail('Inventaire de fichiers ambigu.')
            expected.add(name)
            if archive.getinfo(name).file_size != record['size']:
                fail('Taille de fichier incorrecte : ' + name)
            digest = hashlib.sha256()
            with archive.open(name) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            if digest.hexdigest() != record['sha256']:
                fail('Le ZIP est altéré : empreinte incorrecte pour ' + name)
        if expected != {e.filename for e in entries}:
            fail('Le ZIP contient des fichiers absents de son inventaire.')
        return archive, manifest
    except BaseException:
        archive.close()
        raise


def validate_tables(db, records, schemas, native=False, allowed_native=None):
    if not isinstance(records, dict) or not isinstance(schemas, dict):
        fail('Structure des données invalide.')
    for table, items in records.items():
        if (table not in (allowed_native or NATIVE_TABLES) if native else not allowed_table(table)):
            fail('Section non autorisée : ' + str(table))
        if table not in tables(db):
            fail('La version cible ne connaît pas la section ' + table + '. Mettez la destination à jour.')
        target = {c['name']: c for c in columns(db, table)}
        source = {c['name']: c for c in schemas.get(table, [])}
        if not source or not isinstance(items, list):
            fail('Description de section manquante : ' + table)
        unknown = source.keys() - target.keys()
        if unknown:
            fail('La destination ne comprend pas ' + table + '.' + sorted(unknown)[0] + ' ; aucune donnée ne sera ignorée. Mettez la destination à jour.')
        for key, column in target.items():
            if key not in source and column['notnull'] and column['dflt_value'] is None:
                fail('La sauvegarde est trop ancienne : champ requis absent ' + table + '.' + key)
            if key in source and column['type'].upper() != source[key]['type'].upper():
                fail('Types incompatibles pour ' + table + '.' + key)
        for record in items:
            if not isinstance(record, dict) or set(record) != set(source):
                fail('Enregistrement invalide dans ' + table)
            if any(not (v is None or isinstance(v, (str, int, float)) or isinstance(v, dict) and set(v) == {'$binary'}) for v in record.values()):
                fail('Valeur invalide dans ' + table)
            for key, value in record.items():
                kind = target[key]['type'].upper()
                if value is None:
                    if target[key]['notnull']:
                        fail('Valeur requise absente : ' + table + '.' + key)
                    continue
                if kind == 'TEXT' and not isinstance(value, str) or 'INT' in kind and (not isinstance(value, int) or value < -(2 ** 63) or value >= 2 ** 63):
                    fail('Type de valeur incompatible pour ' + table + '.' + key)
        # Reject links outside the ZIP, even if a matching ID exists at the destination.
        for fk in db.execute('SELECT * FROM pragma_foreign_key_list(?)', (table,)):
            values = {r.get(fk['to']) for r in records.get(fk['table'], [])}
            if any(r.get(fk['from']) is not None and r[fk['from']] not in values for r in items):
                fail('Référence hors du projet ou manquante : ' + table + '.' + fk['from'])


def validate_project_content(manifest):
    roots = {r['key']: r for r in manifest['roots']}
    inventory = {}
    for file in manifest['files']:
        root = roots[file['root']]
        source = str(PurePosixPath(root['source']) / file['relative']) if root['kind'] == 'workspace' else root['source']
        inventory[source] = file
    versions = {r['id']: r for r in manifest['tables'].get('project_deliverable_document_versions', [])}
    for version in versions.values():
        file = inventory.get(version['snapshot_path'])
        if not file or file['sha256'] != version['sha256'] or file['size'] != version['size']:
            fail('Une version historique de document est absente ou ne correspond pas à son empreinte : ' + version['file_name'])
        if version.get('onlyoffice_changes_path') and version['onlyoffice_changes_path'] not in inventory:
            fail('L’historique OnlyOffice d’un document est absent du ZIP.')
    for version in manifest['tables'].get('project_deliverable_versions', []):
        for file in json.loads(version['files']):
            entry = inventory.get(file['snapshotPath'])
            if not entry or entry['sha256'] != file['sha256']:
                fail('Une ancienne version de livrable est absente ou altérée.')
    for snapshot in manifest['tables'].get('project_deliverable_snapshots', []):
        for document in json.loads(snapshot['documents']):
            version = versions.get(document['documentVersionId'])
            if not version or version['document_id'] != document['documentId'] or version['number'] != document['versionNumber'] or version['sha256'] != document['sha256']:
                fail('Un instantané de livrable contient une référence de document incompatible.')


def preview(options, manifest):
    with connect(options['database'], True) as db:
        validate_tables(db, manifest['tables'], manifest['schemas'])
    if len(manifest['tables'].get('projects', [])) != 1:
        fail('Une archive doit contenir un seul projet.')
    project_id = manifest['tables']['projects'][0]['id']
    if manifest['project']['id'] != project_id:
        fail('L’identité du projet ne correspond pas à l’inventaire.')
    thread_ids = {r['thread_id'] for r in manifest['tables'].get('project_agent_threads', [])}
    validate_branch_topology(manifest['tables'], thread_ids)
    if any(r['key'] not in {prefix + tid for tid in thread_ids for prefix in ('thread-workspace:', 'thread-response-detail:')} for r in manifest['tables'].get('settings', [])):
        fail('Le ZIP ne peut pas contenir de réglages globaux de l’installation.')
    if any(r['key'].startswith('thread-response-detail:') and r['value'] not in ('hidden', 'collapsed', 'expanded') for r in manifest['tables'].get('settings', [])):
        fail('Niveau de détail d’un agent incompatible.')
    if len(manifest['roots']) > MAX_ENTRIES or len(manifest.get('directories', [])) > MAX_ENTRIES:
        fail('Le ZIP contient trop de racines ou de dossiers.')
    root_keys, root_sources = set(), set()
    for root in manifest['roots']:
        key = safe_entry(root['key'])
        if root['kind'] not in ('workspace', 'agent', 'attachment') or '/' in key or key in root_keys or root['source'] in root_sources or not Path(root['source']).is_absolute() or '..' in PurePosixPath(root['source']).parts or '\\' in root['source'] or '\x00' in root['source']:
            fail('Inventaire des espaces de travail invalide.')
        root_keys.add(key)
        root_sources.add(root['source'])
    if manifest['tables']['projects'][0]['workspace_path'] not in root_sources:
        fail('L’espace principal est absent du ZIP.')
    primary = manifest['tables']['projects'][0]['workspace_path']
    if any(r['kind'] == 'workspace' and r['source'] != primary and Path(primary).is_relative_to(r['source']) for r in manifest['roots']):
        fail('Un espace secondaire contient l’espace principal : cette organisation ne peut pas être restaurée sans duplication.')
    if {r['source'] for r in manifest['roots'] if r['kind'] == 'workspace'} != {r['path'] for r in manifest['tables'].get('project_workspaces', [])}:
        fail('Les espaces de travail ne correspondent pas au contenu du ZIP.')
    for record in manifest['files']:
        relative = safe_entry(record['relative'])
        if record['root'] not in root_keys or record['path'] != 'content/' + record['root'] + '/' + relative:
            fail('Le fichier ne correspond pas à une racine déclarée.')
    for record in manifest.get('directories', []):
        safe_entry(record['relative'])
        if record['root'] not in root_keys:
            fail('Dossier sans espace de travail.')
    for table, records in manifest['tables'].items():
        if any(r.get('project_id', project_id) != project_id for r in records):
            fail('Le ZIP contient les données de plusieurs projets.')
        for row in records:
            for key in ('workspace_path', 'cwd', 'source_path', 'snapshot_path', 'onlyoffice_changes_path', 'linked_file_path'):
                value = row.get(key)
                if isinstance(value, str) and value:
                    if '\\' in value or '\x00' in value or '..' in PurePosixPath(value).parts:
                        fail('Chemin opérationnel dangereux : ' + table + '.' + key)
                    if value.startswith('/') and not any(value == source or value.startswith(source.rstrip('/') + '/') for source in root_sources):
                        fail('Un chemin opérationnel n’est pas inclus dans le ZIP : ' + table + '.' + key)
    for folder in manifest['tables'].get('project_active_folders', []):
        if folder['relative_path']:
            safe_entry(folder['relative_path'])
    known_resources = {'task_board', 'automation_board', 'deliverable_board'}
    for resource in manifest['tables'].get('project_resources', []):
        if resource['type'] not in known_resources:
            fail('Ce type de ressource nécessite une version plus récente : ' + resource['type'])
    validate_project_content(manifest)
    native = manifest.get('agents')
    if native:
        if {r['key'].removeprefix('agent-') for r in manifest['roots'] if r['kind'] == 'agent'} != {r['id'] for r in native['tables']['threads']}:
            fail('Les historiques ne correspondent pas aux agents du projet.')
        for record in native['tables']['threads']:
            if not any(r['key'] == 'agent-' + record['id'] and r['source'] == record['rollout_path'] for r in manifest['roots']):
                fail('Le chemin d’historique ne correspond pas à son agent.')
        native_ids = {r['id'] for r in native['tables']['threads']}
        if native_ids != thread_ids:
            fail('L’inventaire natif ne correspond pas aux agents associés au projet.')
        for edge in native['tables'].get('thread_spawn_edges', []):
            if edge['parent_thread_id'] not in native_ids or edge['child_thread_id'] not in native_ids:
                fail('Un lien de sous-agent pointe hors du ZIP.')
        for name in native.get('sessionIndex', []):
            if set(name) != {'id', 'thread_name', 'updated_at'} or name['id'] not in native_ids or not isinstance(name['thread_name'], str) or len(json_bytes(name)) > 4000 or not isinstance(name['updated_at'], str):
                fail('L’index des noms d’agents utilise un format incompatible.')
        target = native_database(options['codexHome'])
        if target is None or target.name != native['database']:
            fail('Le format de stockage des agents est incompatible avec le moteur installé. Installez un moteur compatible avant l’import.')
        with connect(target, True) as db:
            validate_tables(db, native['tables'], native['schemas'], True)
        for record in native['tables'].get('project_roots', []):
            if record['path'] not in root_sources:
                fail('Le projet natif d’un agent dépend d’un espace extérieur à cette sauvegarde.')
        for filename, section in native.get('auxiliary', {}).items():
            if filename not in AUXILIARY or not (Path(options['codexHome']) / filename).is_file():
                fail('Le moteur cible ne comprend pas la section d’historique ' + filename)
            with connect(Path(options['codexHome']) / filename, True) as db:
                validate_tables(db, section['tables'], section['schemas'], True, AUXILIARY[filename])
        # Raw history storage is a native versioned contract, independent of app releases.
        validate_agent_versions(native.get('engineVersion', ''), options.get('codexVersion', ''))
        _, capability = agent_codec(native['engineVersion'])
        if capability not in manifest['requiredCapabilities']:
            fail('Le ZIP ne déclare pas le codec requis pour son historique d’agents.')
    return {'compatible': True, 'projectName': manifest['project']['name'],
            'people': [{k: p.get(k) for k in ('id', 'name', 'first_name', 'last_name', 'email', 'reference')}
                       for p in manifest['tables'].get('people', [])],
            'availablePeople': available_people(options),
            'sourceVersion': manifest['applicationVersion'], 'targetVersion': options.get('version', 'unknown'),
            'formatVersion': FORMAT, 'files': len(manifest['files']),
            'bytes': sum(r['size'] for r in manifest['files']),
            'counts': {n: len(r) for n, r in manifest['tables'].items()},
            'warnings': manifest['warnings']}


def available_people(options):
    with connect(options['database'], True) as db:
        return [dict(row) for row in db.execute('SELECT id,name,first_name,last_name,email,reference,active FROM people ORDER BY name,id')]


def person_equivalences(options, manifest):
    sources = {p['id'] for p in manifest['tables'].get('people', [])}
    mappings = options.get('personMappings', {})
    if not isinstance(mappings, dict) or set(mappings) != sources:
        fail('Choisissez une correspondance ou une nouvelle personne pour chaque personne du ZIP.')
    targets = {p['id'] for p in available_people(options)}
    if any(value is not None and (not isinstance(value, str) or value not in targets) for value in mappings.values()):
        fail('Une personne sélectionnée n’existe plus. Analysez de nouveau le ZIP.')
    return mappings


def remap(value, ids, paths):
    if isinstance(value, list):
        return [remap(v, ids, paths) for v in value]
    if isinstance(value, dict):
        return {k: remap(v, ids, paths) for k, v in value.items()}
    if not isinstance(value, str):
        return value
    if value in ids:
        return ids[value]
    for source, target in sorted(paths.items(), key=lambda item: -len(item[0])):
        if value == source or value.startswith(source.rstrip('/') + '/'):
            tail = '/'.join(ids.get(part, part) for part in value[len(source):].split('/'))
            return target + tail
    if ':' in value:
        prefix, suffix = value.split(':', 1)
        if prefix in ('agent', 'simple', 'resource', 'thread', 'thread-workspace', 'thread-response-detail') and suffix in ids:
            return prefix + ':' + ids[suffix]
    if value.startswith(('{', '[')):
        try:
            return json.dumps(remap(json.loads(value), ids, paths), ensure_ascii=False, separators=(',', ':'))
        except (ValueError, TypeError):
            pass
    for source, target in paths.items():
        if '/webui-uploads/' in source:
            value = value.replace(source, target)
    return value


def insert_rows(db, records):
    db.execute('PRAGMA defer_foreign_keys=ON')
    for table, items in records.items():
        for record in items:
            keys = list(record)
            sql = 'INSERT INTO ' + quote(table) + '(' + ','.join(quote(k) for k in keys) + ') VALUES (' + ','.join('?' for k in keys) + ')'
            db.execute(sql, tuple(decoded(record[k]) for k in keys))


def select_import_content(manifest, selection):
    """Coarse bundles; dependencies are included, never references silently severed."""
    if selection is None:
        return manifest
    if not isinstance(selection, list) or any(not isinstance(s, str) or s not in {'files', 'conversations', 'work'} for s in selection):
        fail('Sélection d’import invalide. Choisissez les catégories proposées.')
    selected = set(selection)
    if 'work' in selected:
        selected.add('conversations')
    if 'conversations' in selected:
        selected.add('files')
    result = copy.deepcopy(manifest)
    core = {'projects', 'people', 'project_participants', 'project_manager_assignments',
            'project_person_groups', 'project_person_group_members', 'project_workspaces',
            'project_workspace_resources', 'project_workspace_copies',
            'project_workspace_transfers', 'project_workspace_transfer_runs'}
    conversations = THREAD_TABLES | {'project_agent_threads', 'project_active_folders',
                                    'simple_chat_threads', 'simple_chat_messages', 'settings'}
    result['tables'] = {name: rows for name, rows in result['tables'].items()
                        if name in core or (name in conversations and 'conversations' in selected)
                        or (name not in core | conversations and 'work' in selected)}
    if 'conversations' not in selected:
        result.pop('agents', None)
        result['roots'] = [r for r in result['roots'] if r['kind'] == 'workspace']
    roots = {r['key'] for r in result['roots']}
    result['files'] = [r for r in result['files'] if 'files' in selected and r['root'] in roots]
    result['directories'] = [r for r in result.get('directories', []) if 'files' in selected and r['root'] in roots]
    if 'work' not in selected:
        result['tables']['projects'][0]['sidebar_order'] = '[]'
    return result


def import_archive(options, archive, manifest):
    # Validate the complete original archive first, then revalidate the selected closure.
    preview(options, manifest)
    manifest = select_import_content(manifest, options.get('selection'))
    preview(options, manifest)
    person_mappings = person_equivalences(options, manifest)
    ids = {}
    native = manifest.get('agents')
    # Codex thread identifiers retain their UUIDv7 contract; business IDs use UUIDv4.
    for thread in (native or {}).get('tables', {}).get('threads', []):
        random = secrets.randbits(74)
        value = (int(time.time() * 1000) << 80) | (7 << 76) | ((random >> 62) << 64) | (2 << 62) | (random & ((1 << 62) - 1))
        ids[thread['id']] = str(uuid.UUID(int=value))
    sections = [manifest['tables']] + ([native['tables']] if native else [])
    for records in sections:
        for table, items in records.items():
            for record in items:
                for key in ID_KEYS:
                    if key in record and isinstance(record[key], str) and record[key]:
                        ids.setdefault(record[key], str(uuid.uuid4()))
    source_project = manifest['tables']['projects'][0]
    for source, destination in person_mappings.items():
        if destination is not None:
            ids[source] = destination
    project_id = ids[source_project['id']]
    root = Path(options['workspaceRoot']).resolve(strict=True)
    target = root / project_id
    if target.exists() or target.is_symlink():
        fail('Le dossier cible existe déjà ; il ne sera pas écrasé.')
    staging = Path(tempfile.mkdtemp(prefix='.mergeron-import-', dir=root))
    os.chmod(staging, 0o700)
    operation_id = str(uuid.uuid4())
    ownership = json.dumps({'projectId': project_id, 'operationId': operation_id})
    durable_text(staging / '.mergeron-import-owner', ownership)
    paths, root_targets = {}, {}
    # Resolve workspace parents before children, retaining nested folder identity.
    ordered_roots = sorted(manifest['roots'], key=lambda r: (r['kind'] != 'workspace', len(PurePosixPath(r['source']).parts)))
    for record in ordered_roots:
        key = safe_entry(record['key'])
        if '/' in key:
            fail('Racine de contenu invalide.')
        if record['source'] == source_project['workspace_path']:
            location = target
        elif record['kind'] == 'workspace':
            ancestors = [r for r in ordered_roots if r['kind'] == 'workspace' and r['key'] in root_targets and Path(record['source']).is_relative_to(r['source'])]
            if ancestors:
                ancestor = max(ancestors, key=lambda r: len(r['source']))
                relative = Path(record['source']).relative_to(ancestor['source'])
                location = root_targets[ancestor['key']] / Path(*(ids.get(part, part) for part in relative.parts))
            else:
                location = target / '.mergeron' / 'imported-workspaces' / key
        elif record['kind'] == 'agent' and native:
            thread_id = ids[key.removeprefix('agent-')]
            instant = datetime.now().astimezone()
            stamp = instant.strftime('%Y-%m-%dT%H-%M-%S')
            original = next(r for r in native['tables']['threads'] if r['id'] == key.removeprefix('agent-'))
            partition = Path(options['codexHome']).resolve() / ('archived_sessions' if original.get('archived') else 'sessions')
            folder = partition if original.get('archived') else partition / instant.strftime('%Y/%m/%d')
            location = folder / ('rollout-' + stamp + '-' + thread_id + '.jsonl')
        elif record['kind'] == 'attachment':
            location = target / '.mergeron' / 'imported-attachments' / (key + Path(record['source']).suffix)
        else:
            fail('Racine de contenu inconnue.')
        paths[record['source']] = str(location)
        root_targets[key] = location
    records = remap(manifest['tables'], ids, paths)
    # Existing identities are referenced, never overwritten with archive profiles.
    existing = {value for value in person_mappings.values() if value is not None}
    records['people'] = [p for p in records.get('people', []) if p['id'] not in existing]
    records['projects'][0]['name'] = (options.get('name') or source_project['name'] + ' (importé)').strip()[:200]
    records['projects'][0]['mcp_server_ids'] = '[]'
    records['projects'][0]['app_ids'] = '[]'
    for person in records.get('people', []):
        person.update(identity_subject=None, email=None, active=0, role='standard', reference='IMPORT-' + person['id'])
    for source, resource in zip(manifest['tables'].get('project_workspace_resources', []),
                                records.get('project_workspace_resources', [])):
        # Protocol/access enums are not identifiers, even if an old resource id
        # happens to be "ssh" or "local". Keep the normalized projection valid.
        resource['type'] = source['type']
        resource['access_mode'] = source['access_mode']
        if resource['type'] != 'local':
            resource.update(enabled=0, connection_state='disabled', last_checked_at=None, last_error=None)
    for resource in records.get('project_resources', []):
        config = json.loads(resource['config'])
        for automation in config.get('automations', []):
            automation.update(active=False, nextRunAt=None)
        resource['config'] = json.dumps(config, ensure_ascii=False)
    for task in records.get('project_tasks', []):
        if task.get('agent_state') in ('running', 'ready', 'waiting'):
            task['agent_state'] = 'manual'
            task['execution_mode'] = 'manual'
    for record in records.get('project_workspace_transfer_runs', []):
        record['staging_path'] = None
        if record['status'] == 'running':
            record.update(status='error', error='Transfert interrompu lors de l’export/import.', finished_at=int(time.time() * 1000))
    for version in records.get('project_deliverable_document_versions', []):
        version['onlyoffice_key'] = None
    if options.get('personId'):
        records.setdefault('project_participants', []).append({'project_id': project_id, 'person_id': options['personId'], 'created_at': int(time.time() * 1000)})
    # Several source contacts may intentionally represent the same destination person.
    for table, keys in [('project_participants', ('project_id', 'person_id')),
                        ('project_person_group_members', ('group_id', 'person_id'))]:
        unique = {}
        for row in records.get(table, []):
            unique.setdefault(tuple(row[key] for key in keys), row)
        if table in records:
            records[table] = list(unique.values())
    native_records = remap(native['tables'], ids, paths) if native else None
    auxiliary_records = {filename: remap(section['tables'], ids, paths)
                         for filename, section in (native or {}).get('auxiliary', {}).items()}
    for section in auxiliary_records.values():
        for goal in section.get('thread_goals', []):
            if goal['status'] == 'active':
                goal['status'] = 'paused'
    if native_records:
        workspaces = {r['thread_id']: r['workspace_path'] for r in records.get('project_agent_threads', [])}
        for record in native_records['threads']:
            if not Path(record['cwd']).is_relative_to(target):
                record['cwd'] = workspaces[record['id']]
            record['approval_mode'] = 'on-request'
            record['sandbox_policy'] = '{"type":"read-only"}'
            for key in ('creator_user_id', 'creator_account_id'):
                if key in record:
                    record[key] = None
            override_key = 'thread-workspace:' + record['id']
            records['settings'] = [r for r in records.get('settings', []) if r['key'] != override_key]
            records['settings'].append({'key': override_key, 'value': record['cwd'], 'type': 'string', 'category': 'thread-workspace', 'description': 'Workspace restored from a project archive', 'default_value': '', 'constraints': '{}', 'updated_at': int(time.time() * 1000)})
    journal_dir = Path(options['database']).parent / 'project-import-journal'
    journal_dir.mkdir(mode=0o700, exist_ok=True)
    sync_directory(journal_dir.parent)
    journal = journal_dir / (project_id + '.json')
    agent_dir = Path(options['codexHome']).resolve() / 'webui' / 'project-imports' / project_id
    journal_data = {'projectId': project_id, 'operationId': operation_id, 'staging': str(staging), 'target': str(target),
                                  'people': [r['id'] for r in records.get('people', [])],
                                  'nativeProjects': [r['id'] for r in (native_records or {}).get('projects', [])],
                                  'nativeSections': [r['id'] for r in (native_records or {}).get('thread_sections', [])],
                                  'agentFiles': [r['rollout_path'] for r in (native_records or {}).get('threads', [])],
                                  'agentFileIdentities': [], 'nativeReserved': False,
                                  'agents': [r['id'] for r in (native_records or {}).get('threads', [])]}
    durable_text(journal, json.dumps(journal_data))
    try:
        if native_records:
            agent_dir.mkdir(parents=True, exist_ok=False)
            durable_text(agent_dir / '.mergeron-import-owner', ownership)
            sync_directory(agent_dir.parent)
        for record in manifest.get('directories', []):
            final = root_targets[record['root']]
            if not final.is_relative_to(target):
                fail('Dossier déclaré hors du projet.')
            relative = '/'.join(ids.get(part, part) for part in safe_entry(record['relative']).split('/'))
            (staging / final.relative_to(target) / relative).mkdir(parents=True, exist_ok=True)
        for record in manifest['files']:
            relative = safe_entry(record['relative'])
            key = record['root']
            if key not in root_targets or record['path'] != 'content/' + key + '/' + relative:
                fail('Emplacement de fichier incompatible avec son inventaire.')
            final = root_targets[key]
            if final.is_relative_to(target):
                relocated = '/'.join(ids.get(part, part) for part in relative.split('/'))
                destination = staging / final.relative_to(target)
                if not key.startswith('attachment-'):
                    destination /= relocated
            else:
                destination = agent_dir / final.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(record['path']) as source, open(destination, 'xb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(destination, int(record.get('mode', 0o600)) & 0o755)
            if isinstance(record.get('mtimeNs'), int):
                os.utime(destination, ns=(record['mtimeNs'], record['mtimeNs']))
        if native_records:
            # Parents must be rewritten before children: history_base stores byte
            # offsets into the parent's rollout, not into the child's file.
            by_id = {r['id']: r for r in native_records['threads']}
            bases = {}
            for thread_id, thread in by_id.items():
                with (agent_dir / Path(thread['rollout_path']).name).open('rb') as stream:
                    bases[thread_id] = history_base(remap(history_header(stream), ids, paths))
            ordered, visiting, visited = [], set(), set()

            def visit(thread_id):
                if len(visiting) > 400:
                    fail('La profondeur des branches dépasse la limite de transport.')
                if thread_id in visiting:
                    fail('Le graphe natif d’historiques contient un cycle.')
                if thread_id in visited:
                    return
                visiting.add(thread_id)
                base = bases[thread_id]
                if base:
                    if base[0] in by_id:
                        visit(base[0])
                    elif base[1] or base[2]:
                        fail('Un préfixe d’historique natif est absent du ZIP ; aucun agent ne sera publié.')
                visiting.remove(thread_id)
                visited.add(thread_id)
                ordered.append(by_id[thread_id])

            for thread_id in by_id:
                visit(thread_id)
            rewritten_offsets = {}
            for record in ordered:
                if not any(Path(record['rollout_path']).is_relative_to(Path(options['codexHome']).resolve() / part) for part in ('sessions', 'archived_sessions')):
                    fail('Le chemin de l’agent importé ne se trouve pas dans son dossier réservé.')
                file = agent_dir / Path(record['rollout_path']).name
                # JSONL histories carry structural IDs/cwd. Never rewrite arbitrary prose.
                if file.suffix == '.jsonl':
                    rewritten = file.with_suffix('.rewritten')
                    offsets = {0: 0}
                    with file.open('rb') as source, rewritten.open('xb') as output:
                        for line in source:
                            event = remap(json.loads(line), ids, paths)
                            if event.get('type') == 'turn_context':
                                context = event['payload']
                                context['approval_policy'] = 'on-request'
                                context['approvals_reviewer'] = 'user'
                                context['sandbox_policy'] = {'type': 'read-only'}
                                context['permission_profile'] = {'type': 'managed', 'file_system': {'type': 'restricted', 'entries': [{'path': {'type': 'special', 'value': {'kind': 'root'}}, 'access': 'read'}]}, 'network': 'restricted'}
                            if event.get('type') in ('session_meta', 'turn_context'):
                                context = event['payload']
                                if not Path(context.get('cwd', '/')).is_relative_to(target):
                                    context['cwd'] = record['cwd']
                                if event['type'] == 'session_meta':
                                    for key in ('forked_from_id', 'forkedFromId'):
                                        if context.get(key) and context[key] not in by_id:
                                            context[key] = None
                                    base = history_base(context)
                                    if base:
                                        if base[0] not in by_id:
                                            context.pop('history_base', None)
                                            context.pop('historyBase', None)
                                        else:
                                            parent_offsets = rewritten_offsets[base[0]]
                                            if base[1] not in parent_offsets:
                                                fail('Le préfixe d’une branche ne correspond pas à une limite d’enregistrement de son parent.')
                                            raw_base = context.get('history_base', context.get('historyBase'))
                                            offset_key = 'end_byte_offset' if 'end_byte_offset' in raw_base else 'endByteOffset'
                                            raw_base[offset_key] = parent_offsets[base[1]]
                            output.write(json_bytes(event) + b'\n')
                            offsets[source.tell()] = output.tell()
                        output.flush()
                        os.fsync(output.fileno())
                    rewritten_offsets[record['id']] = offsets
                    for section in auxiliary_records.values():
                        for items in section.values():
                            for item in items:
                                if item.get('thread_id') != record['id']:
                                    continue
                                for key in ('rollout_byte_offset', 'rollout_end_byte_offset', 'next_rollout_byte_offset'):
                                    if item.get(key) is not None:
                                        if item[key] not in offsets:
                                            fail('L’index paginé d’un agent ne correspond pas à son historique.')
                                        item[key] = offsets[item[key]]
                    os.replace(rewritten, file)
                else:
                    fail('Format d’historique d’agent non reconnu.')
            sync_directory(agent_dir)
        marker = staging / '.mergeron' / 'project.json'
        marker.parent.mkdir(exist_ok=True)
        durable_text(marker, json.dumps({'projectId': project_id, 'layoutVersion': records['projects'][0]['workspace_layout_version']}))
        for directory, _, _ in os.walk(staging, topdown=False):
            sync_directory(directory)
        with connect(options['database']) as db:
            db.execute('BEGIN IMMEDIATE')
            # Recheck under the write lock: a deleted target must abort the whole import.
            person_equivalences(options, manifest)
            insert_rows(db, records)
            provenance = {
                'sourceProjectId': source_project['id'], 'sourceVersion': manifest['applicationVersion'],
                'exportedAt': manifest['exportedAt'],
                'contacts': manifest['tables'].get('people', []),
                'personMappings': {source: ids[source] for source in person_mappings},
                'mcpServerIds': source_project.get('mcp_server_ids'), 'appIds': source_project.get('app_ids'),
                'relocatedOperationalPaths': manifest.get('relocatedOperationalPaths', []),
                'safetyOverrides': {'automationsPaused': True, 'contactsInactive': not bool(existing), 'newContactsInactive': True, 'existingAccountsUnchanged': True, 'externalConnectionsDisabled': True},
            }
            db.execute('INSERT INTO project_archive_imports(id,project_id,source_version,imported_at,provenance) VALUES(?,?,?,?,?)',
                       (str(uuid.uuid4()), project_id, manifest['applicationVersion'], int(time.time() * 1000), json.dumps(provenance, ensure_ascii=False)))
            if native_records:
                with connect(native_database(options['codexHome'])) as agent_db:
                    agent_db.execute('BEGIN IMMEDIATE')
                    insert_rows(agent_db, native_records)
                    for filename, section in auxiliary_records.items():
                        with connect(Path(options['codexHome']) / filename, True) as history_db:
                            for table in section:
                                if scoped_rows(history_db, table, 'thread_id', {r['id'] for r in native_records['threads']}):
                                    fail('Un identifiant d’historique existe déjà ; aucun contenu existant ne sera remplacé.')
                    journal_data['nativeReserved'] = True
                    durable_text(journal, json.dumps(journal_data))
                    for filename, section in auxiliary_records.items():
                        with connect(Path(options['codexHome']) / filename) as history_db:
                            history_db.execute('BEGIN IMMEDIATE')
                            insert_rows(history_db, section)
                    # Publish canonical filenames while native DB writers are locked.
                    # Only native-generated date directories are used, not ZIP paths.
                    for thread in native_records['threads']:
                        final = Path(thread['rollout_path'])
                        parent = final.parent
                        home = Path(options['codexHome']).resolve()
                        while parent != home:
                            if parent.is_symlink():
                                fail('Un dossier d’historique natif est un lien symbolique.')
                            parent = parent.parent
                        final.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        temporary = final.parent / ('.mergeron-' + operation_id + '-' + final.name)
                        try:
                            with (agent_dir / final.name).open('rb') as source, temporary.open('xb') as output:
                                shutil.copyfileobj(source, output, 1024 * 1024)
                                output.flush()
                                os.fsync(output.fileno())
                            info = temporary.stat()
                            os.chmod(temporary, 0o600)
                            journal_data['agentFileIdentities'].append({'path': str(final), 'inode': info.st_ino, 'device': info.st_dev})
                            durable_text(journal, json.dumps(journal_data))
                            os.link(temporary, final)  # atomic and refuses any existing file
                        finally:
                            temporary.unlink(missing_ok=True)
                        sync_directory(final.parent)
                # The native name log is append-only. Never rewrite existing entries,
                # even on rollback; stale names for missing new UUIDs are ignored natively.
                names = remap(native.get('sessionIndex', []), ids, paths)
                if names:
                    index = Path(options['codexHome']) / 'session_index.jsonl'
                    descriptor = os.open(index, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                    try:
                        for name in names:
                            line = json_bytes(name) + b'\n'
                            if os.write(descriptor, line) != len(line):
                                fail('Écriture incomplète de l’index natif des agents.')
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
            if target.exists():
                fail('Le dossier cible existe déjà ; il ne sera pas écrasé.')
            os.rename(staging, target)
            sync_directory(root)
        try:
            (target / '.mergeron-import-owner').unlink(missing_ok=True)
            if native_records:
                shutil.rmtree(agent_dir)
            journal.unlink()
        except OSError:
            # The DB commit is authoritative. Cleanup may be safely retried at startup.
            pass
        return {'projectId': project_id, 'name': records['projects'][0]['name'], 'warnings': manifest['warnings']}
    except BaseException:
        recover_import(options, json.loads(journal.read_text()))
        journal.unlink(missing_ok=True)
        raise


def recover_import(options, record):
    project_id = record['projectId']
    if str(uuid.UUID(project_id)) != project_id:
        fail('Journal d’import invalide ; intervention administrative requise.')
    with connect(options['database']) as db:
        if db.execute('SELECT 1 FROM projects WHERE id=?', (project_id,)).fetchone():
            target = Path(options['workspaceRoot']).resolve() / project_id
            marker = target / '.mergeron-import-owner'
            ownership = {'projectId': project_id, 'operationId': record['operationId']}
            if marker.is_file() and not marker.is_symlink() and json.loads(marker.read_text()) == ownership:
                marker.unlink()
            temporary = Path(options['codexHome']).resolve() / 'webui' / 'project-imports' / project_id
            marker = temporary / '.mergeron-import-owner'
            if marker.is_file() and not marker.is_symlink() and not temporary.is_symlink() and json.loads(marker.read_text()) == ownership:
                shutil.rmtree(temporary)
            return  # committed before interruption; never remove committed data
    native = native_database(options['codexHome'])
    if native and record['agents'] and record.get('nativeReserved'):
        for filename, allowed in AUXILIARY.items():
            if not (Path(options['codexHome']) / filename).is_file():
                continue
            with connect(Path(options['codexHome']) / filename) as db:
                for table in allowed & tables(db):
                    for tid in record['agents']:
                        db.execute('DELETE FROM ' + quote(table) + ' WHERE thread_id=?', (tid,))
        with connect(native) as db:
            for tid in record['agents']:
                for table in (NATIVE_TABLES & tables(db)) - {'threads', 'projects', 'project_roots', 'thread_sections'}:
                    for column in columns(db, table):
                        if column['name'].endswith('thread_id'):
                            db.execute('DELETE FROM ' + quote(table) + ' WHERE ' + quote(column['name']) + '=?', (tid,))
                db.execute('DELETE FROM threads WHERE id=?', (tid,))
            for pid in record.get('nativeProjects', []):
                db.execute('DELETE FROM projects WHERE id=?', (pid,))
            for sid in record.get('nativeSections', []):
                db.execute('DELETE FROM thread_sections WHERE id=?', (sid,))
        home = Path(options['codexHome']).resolve()
        for identity in record.get('agentFileIdentities', []):
            file = Path(identity['path'])
            if file.resolve().is_relative_to(home) and file.is_file() and file.suffix == '.jsonl' and any(file.name.endswith('-' + tid + '.jsonl') for tid in record['agents']) and not file.is_symlink():
                info = file.stat()
                if info.st_ino == identity['inode'] and info.st_dev == identity['device']:
                    file.unlink()
    for directory in [Path(options['workspaceRoot']).resolve() / project_id,
                      Path(options['codexHome']).resolve() / 'webui' / 'project-imports' / project_id]:
        marker = directory / '.mergeron-import-owner'
        if directory.is_dir() and not directory.is_symlink() and marker.is_file() and not marker.is_symlink():
            try:
                owned = json.loads(marker.read_text()) == {'projectId': project_id, 'operationId': record['operationId']}
            except (ValueError, OSError):
                owned = False
            if owned:
                shutil.rmtree(directory)
    staging = Path(record['staging'])
    if staging.parent == Path(options['workspaceRoot']).resolve() and staging.name.startswith('.mergeron-import-') and not staging.is_symlink():
        marker = staging / '.mergeron-import-owner'
        if marker.is_file() and not marker.is_symlink() and json.loads(marker.read_text()) == {'projectId': project_id, 'operationId': record['operationId']}:
            shutil.rmtree(staging)


def run(options):
    action = options['action']
    if action == 'export':
        return export_archive(options)
    if action == 'recover':
        directory = Path(options['database']).parent / 'project-import-journal'
        if directory.exists():
            for journal in directory.glob('*.json'):
                recover_import(options, json.loads(journal.read_text()))
                journal.unlink()
        return {'recovered': True}
    archive, manifest = read_archive(options['archive'])
    with archive:
        if manifest.get('agents') and action in ('preview', 'import'):
            source_minor = '.'.join(manifest['agents'].get('engineVersion', '').split('.')[:2])
            target_minor = '.'.join(options.get('codexVersion', '').split('.')[:2])
            validate_agent_versions(manifest['agents'].get('engineVersion', ''), options.get('codexVersion', ''))
            if source_minor in AGENT_CODECS and target_minor in AGENT_CODECS:
                from project_archive_native import initialize_stores
                required = set(manifest['agents'].get('auxiliary', {}))
                if not required <= set(AUXILIARY):
                    fail('Section native inconnue dans le ZIP.')
                database_name = manifest['agents'].get('database')
                if database_name != 'state_5.sqlite':
                    fail('Format de stockage natif non pris en charge par ce codec.')
                required.add(database_name)
                try:
                    initialize_stores(options.get('codexBin'), options['codexHome'], required)
                except RuntimeError as error:
                    fail(str(error))
        if action == 'preview':
            return preview(options, manifest)
        if action == 'import':
            return import_archive(options, archive, manifest)
    fail('Action inconnue.')


if __name__ == '__main__':
    try:
        def interrupted(_number, _frame):
            raise ArchiveError('Le transfert a été interrompu ; les modifications non publiées sont annulées.')
        signal.signal(signal.SIGTERM, interrupted)
        options = json.load(sys.stdin)
        lock = Path(options['database']).parent / '.project-archive.lock'
        with lock.open('a') as guard:
            os.chmod(lock, 0o600)
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail('Un autre transfert de projet est encore actif. Réessayez après sa fin.')
            print(json.dumps({'ok': True, 'result': run(options)}, ensure_ascii=False))
    except (ArchiveError, ValueError, TypeError, KeyError, OSError, RuntimeError, sqlite3.Error, zipfile.BadZipFile) as error:
        message = str(error) if isinstance(error, ArchiveError) else 'Archive invalide ou opération impossible (' + type(error).__name__ + '). Aucun contenu existant n’a été remplacé.'
        print(json.dumps({'ok': False, 'error': message}, ensure_ascii=False))
        sys.exit(1)
