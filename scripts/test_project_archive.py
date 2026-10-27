"""Portable project transport against the real application migrations and isolated files."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('project_archive', ROOT / 'scripts/project_archive.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def database(path):
    db = sqlite3.connect(path)
    db.execute('PRAGMA foreign_keys=ON')
    journal = json.loads((ROOT / 'drizzle/meta/_journal.json').read_text())
    for migration in journal['entries']:
        db.executescript((ROOT / 'drizzle' / (migration['tag'] + '.sql')).read_text())
    return db


class ProjectArchiveTest(unittest.TestCase):
    def test_copy_ownership_follows_the_conversation_import_bundle(self):
        owner = {'copy_id': 'copy', 'agent_thread_id': 'agent', 'project_id': 'p', 'created_at': 1}
        manifest = {'tables': {'projects': [{'id': 'p', 'sidebar_order': '[]'}],
                               'project_git_copy_owners': [owner]},
                    'roots': [], 'files': [], 'directories': []}
        for selection in (['conversations'], ['work']):
            self.assertEqual(engine.select_import_content(manifest, selection)['tables']['project_git_copy_owners'], [owner])
        for selection in ([], ['files']):
            self.assertNotIn('project_git_copy_owners', engine.select_import_content(manifest, selection)['tables'])

    def test_normalized_locations_roundtrip_and_legacy_archive_compatibility(self):
        self.export()
        archive, manifest = self.load()
        self.assertEqual(manifest['locationModel']['version'], 1)
        self.assertEqual(manifest['locationModel']['locations'][0]['id'], 'local:workspace')
        result = engine.import_archive(self.target, archive, manifest)
        with engine.connect(self.target_db) as db:
            rows = db.execute('SELECT id,path FROM project_locations WHERE project_id=?', (result['projectId'],)).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertNotEqual(rows[0]['id'], 'local:workspace')
            self.assertTrue(Path(rows[0]['path']).is_relative_to(self.target_root.resolve()))
        self.rewrite_manifest(lambda m: m.pop('locationModel'))
        self.import_project()

    def test_inconsistent_normalized_descriptor_is_rejected(self):
        self.export()
        self.rewrite_manifest(lambda m: m['locationModel']['locations'][0].update(path='/outside'))
        with self.assertRaises(engine.ArchiveError):
            self.import_project()

    def test_export_refuses_to_silently_lose_an_unrepresentable_location(self):
        with engine.connect(self.source_db) as db:
            db.execute("UPDATE project_locations SET path='/outside' WHERE id='local:workspace'")
        with self.assertRaises(engine.ArchiveError):
            self.export()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mergeron-archive-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source_root = self.base / 'source-workspaces'
        self.target_root = self.base / 'destination-workspaces'
        self.home = self.base / 'codex-source'
        self.target_home = self.base / 'codex-target'
        for folder in (self.source_root, self.target_root, self.home, self.target_home):
            folder.mkdir()
        self.source_db = self.base / 'source.sqlite'
        self.target_db = self.base / 'target.sqlite'
        self.project = self.source_root / 'project-source'
        self.project.mkdir()
        (self.project / 'documents').mkdir()
        (self.project / 'empty-directory').mkdir()
        (self.project / 'documents' / 'budget.txt').write_text('Budget français : 42 €\n')
        self.archive = self.base / 'project.zip'
        with database(self.source_db) as db:
            db.execute("INSERT INTO people(id,reference,name,email,identity_subject,role,active,created_at,updated_at) VALUES('person','P1','Alice','alice@example.test','must-not-travel','administrator',1,1,1)")
            db.execute("INSERT INTO projects(id,name,workspace_path,workspace_layout_version,created_at,updated_at) VALUES('project-source','Projet complet',?,2,1,2)", (str(self.project),))
            db.execute("INSERT INTO project_workspaces(id,project_id,name,path,is_primary,created_at,updated_at) VALUES('workspace','project-source','Principal',?,1,1,1)", (str(self.project),))
            db.execute("INSERT INTO project_participants VALUES('project-source','person',1)")
            db.execute("INSERT INTO project_resources(id,project_id,type,name,config,created_at,updated_at) VALUES('board','project-source','task_board','Tâches','{}',1,1)")
            db.execute("INSERT INTO project_task_statuses(id,resource_id,name,position,created_at,updated_at) VALUES('status','board','À faire',0,1,1)")
            db.execute("INSERT INTO project_tasks(id,resource_id,status_id,title,assignee_id,position,created_at,updated_at) VALUES('task','board','status','Parent','person',0,1,1)")
            db.execute("INSERT INTO project_tasks(id,resource_id,status_id,title,parent_task_id,position,created_at,updated_at) VALUES('subtask','board','status','Enfant','task',1,1,1)")
            db.execute("INSERT INTO simple_chat_threads(id,title,model,project_id,cwd,created_at,updated_at) VALUES('chat','Discussion','model','project-source',?,1,1)", (str(self.project),))
            db.execute("INSERT INTO simple_chat_messages(id,thread_id,role,content,created_at) VALUES('message','chat','user','Bonjour',1)")
            # Unrelated records and login credentials must never leave this database.
            db.execute("INSERT INTO projects(id,name,workspace_path,created_at,updated_at) VALUES('other','Autre projet',?,1,1)", (str(self.source_root / 'other'),))
            db.execute("INSERT INTO local_auth_credentials(id,person_id,username,password_hash,password_changed_at,created_at,updated_at) VALUES('credential','person','alice','never-export-a-password',1,1,1)")
        with database(self.target_db) as db:
            db.execute("INSERT INTO people(id,reference,name,email,role,active,created_at,updated_at) VALUES('target-admin','D1','Admin','alice@example.test','administrator',1,1,1)")
        self.source = dict(database=str(self.source_db), workspaceRoot=str(self.source_root), codexHome=str(self.home), version='0.1.0', codexVersion='0.153.2', projectId='project-source', archive=str(self.archive))
        self.target = dict(database=str(self.target_db), workspaceRoot=str(self.target_root), codexHome=str(self.target_home), version='0.9.0', codexVersion='0.153.3', personId='target-admin', archive=str(self.archive), personMappings={'person': None})

    def export(self):
        return engine.export_archive(self.source)

    def load(self):
        archive, manifest = engine.read_archive(self.archive)
        self.addCleanup(archive.close)
        return archive, manifest

    def import_project(self):
        archive, manifest = self.load()
        return engine.import_archive(self.target, archive, manifest)

    def rewrite_manifest(self, change):
        with zipfile.ZipFile(self.archive) as source:
            content = {entry.filename: source.read(entry) for entry in source.infolist()}
        manifest = json.loads(content['manifest.json'])
        change(manifest)
        content['manifest.json'] = engine.json_bytes(manifest)
        with zipfile.ZipFile(self.archive, 'w') as target:
            for name, data in content.items():
                target.writestr(name, data)

    def test_selected_bundles_keep_dependencies_and_valid_foreign_keys(self):
        self.add_agent()
        self.export()
        for selection in ([], ['files'], ['conversations'], ['work']):
            with self.subTest(selection=selection):
                archive, manifest = self.load()
                result = engine.import_archive(dict(self.target, selection=selection), archive, manifest)
                target = self.target_root / result['projectId']
                self.assertEqual((target / 'documents/budget.txt').exists(), bool(selection))
                with engine.connect(self.target_db) as db:
                    pid = result['projectId']
                    self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
                    self.assertEqual(db.execute('SELECT count(*) FROM simple_chat_threads WHERE project_id=?', (pid,)).fetchone()[0], int(selection in (['conversations'], ['work'])))
                    resources = db.execute('SELECT count(*) FROM project_resources WHERE project_id=?', (pid,)).fetchone()[0]
                    self.assertEqual(resources, int(selection == ['work']))
                    self.assertEqual(db.execute('SELECT count(*) FROM project_agent_threads WHERE project_id=?', (pid,)).fetchone()[0], int(selection in (['conversations'], ['work'])))

    def test_invalid_selection_fails_before_creating_anything(self):
        self.export()
        archive, manifest = self.load()
        for selection in ('files', ['unknown'], [None], {}):
            with self.assertRaisesRegex(engine.ArchiveError, 'Sélection'):
                engine.import_archive(dict(self.target, selection=selection), archive, manifest)
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_round_trip_between_different_application_versions(self):
        self.export()
        archive, manifest = self.load()
        preview = engine.preview(self.target, manifest)
        self.assertTrue(preview['compatible'])
        self.assertNotEqual(preview['sourceVersion'], preview['targetVersion'])
        result = engine.import_archive(self.target, archive, manifest)
        self.assertNotEqual(result['projectId'], 'project-source')
        target = self.target_root / result['projectId']
        self.assertEqual((target / 'documents/budget.txt').read_text(), 'Budget français : 42 €\n')
        self.assertTrue((target / 'empty-directory').is_dir())
        with engine.connect(self.target_db) as db:
            parent = db.execute("SELECT * FROM project_tasks WHERE title='Parent'").fetchone()
            child = db.execute("SELECT * FROM project_tasks WHERE title='Enfant'").fetchone()
            self.assertEqual(child['parent_task_id'], parent['id'])
            self.assertNotEqual(parent['id'], 'task')
            self.assertEqual(db.execute('SELECT content FROM simple_chat_messages').fetchone()[0], 'Bonjour')
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertEqual(db.execute('SELECT count(*) FROM projects').fetchone()[0], 1)

    def test_excludes_other_projects_credentials_and_identity_subjects(self):
        self.export()
        _, manifest = self.load()
        payload = engine.json_bytes(manifest)
        self.assertNotIn(b'never-export-a-password', payload)
        self.assertNotIn(b'must-not-travel', payload)
        self.assertNotIn('local_auth_credentials', manifest['tables'])
        self.assertEqual(len(manifest['tables']['projects']), 1)

    def test_import_contacts_do_not_adopt_existing_accounts_or_grant_rights(self):
        self.export()
        result = self.import_project()
        with engine.connect(self.target_db) as db:
            people = db.execute('SELECT * FROM people WHERE id<>?', ('target-admin',)).fetchall()
            self.assertEqual(len(people), 1)
            self.assertEqual((people[0]['active'], people[0]['role'], people[0]['identity_subject']), (0, 'standard', None))
            provenance = json.loads(db.execute('SELECT provenance FROM project_archive_imports WHERE project_id=?', (result['projectId'],)).fetchone()[0])
            self.assertEqual(provenance['contacts'][0]['email'], 'alice@example.test')

    def test_preview_exposes_safe_person_choices(self):
        self.export()
        _, manifest = self.load()
        result = engine.preview(self.target, manifest)
        self.assertEqual(result['people'][0]['id'], 'person')
        self.assertEqual(result['availablePeople'][0]['id'], 'target-admin')
        self.assertNotIn('identity_subject', result['people'][0])
        self.assertNotIn('identity_subject', result['availablePeople'][0])

    def test_explicit_existing_person_keeps_account_and_relinks_tasks(self):
        self.export()
        self.target['personMappings'] = {'person': 'target-admin'}
        with engine.connect(self.target_db) as db:
            before = dict(db.execute('SELECT * FROM people').fetchone())
        result = self.import_project()
        with engine.connect(self.target_db) as db:
            self.assertEqual([dict(r) for r in db.execute('SELECT * FROM people')], [before])
            self.assertEqual(db.execute("SELECT assignee_id FROM project_tasks WHERE title='Parent'").fetchone()[0], 'target-admin')
            self.assertEqual(db.execute('SELECT count(*) FROM project_participants WHERE project_id=?', (result['projectId'],)).fetchone()[0], 1)
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
            provenance = json.loads(db.execute('SELECT provenance FROM project_archive_imports').fetchone()[0])
            self.assertEqual(provenance['personMappings'], {'person': 'target-admin'})

    def test_person_mapping_is_required_complete_and_valid_before_any_write(self):
        self.export()
        archive, manifest = self.load()
        for mapping in (None, {}, {'unknown': None}, {'person': 'missing'}, {'person': {}}, {'person': None, 'extra': None}):
            with self.subTest(mapping=mapping), self.assertRaises(engine.ArchiveError):
                engine.import_archive(dict(self.target, personMappings=mapping), archive, manifest)
            self.assertEqual(list(self.target_root.iterdir()), [])
            with engine.connect(self.target_db) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM people').fetchone()[0], 1)
                self.assertEqual(db.execute('SELECT count(*) FROM projects').fetchone()[0], 0)

    def test_two_source_people_can_map_to_one_existing_person(self):
        with engine.connect(self.source_db) as db:
            db.execute("INSERT INTO people(id,reference,name,active,created_at,updated_at) VALUES('second','P2','Alice bis',0,1,1)")
            db.execute("INSERT INTO project_participants VALUES('project-source','second',1)")
        self.export()
        self.target['personMappings'] = {'person': 'target-admin', 'second': 'target-admin'}
        result = self.import_project()
        with engine.connect(self.target_db) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM people').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM project_participants WHERE project_id=?', (result['projectId'],)).fetchone()[0], 1)

    def test_failed_import_never_removes_reused_identity(self):
        self.export()
        self.target['personMappings'] = {'person': 'target-admin'}
        with engine.connect(self.target_db) as db:
            before = dict(db.execute('SELECT * FROM people').fetchone())
            db.execute("CREATE TRIGGER reject_import BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'test rollback'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.import_project()
        self.assertEqual(list(self.target_root.iterdir()), [])
        with engine.connect(self.target_db) as db:
            self.assertEqual([dict(r) for r in db.execute('SELECT * FROM people')], [before])
            self.assertEqual(db.execute('SELECT count(*) FROM projects').fetchone()[0], 0)

    def test_same_zip_can_be_imported_twice_without_overwriting(self):
        self.export()
        first, second = self.import_project(), self.import_project()
        self.assertNotEqual(first['projectId'], second['projectId'])
        self.assertTrue((self.target_root / first['projectId'] / 'documents/budget.txt').is_file())

    def test_nested_workspaces_preserve_shared_files_without_duplication(self):
        nested = self.project / 'documents'
        with sqlite3.connect(self.source_db) as db:
            db.execute("INSERT INTO project_workspaces(id,project_id,name,path,is_primary,created_at,updated_at) VALUES('nested','project-source','Nested',?,0,1,1)", (str(nested),))
        self.export()
        _, manifest = self.load()
        self.assertEqual(len(manifest['files']), 1)
        imported = self.import_project()
        with engine.connect(self.target_db, True) as db:
            workspace = db.execute("SELECT path FROM project_workspaces WHERE name='Nested'").fetchone()[0]
        self.assertEqual(Path(workspace), self.target_root.resolve() / imported['projectId'] / 'documents')
        self.assertEqual(len(list((self.target_root / imported['projectId']).rglob('budget.txt'))), 1)

    def test_rejects_unknown_archive_format_with_reason(self):
        self.export()
        self.rewrite_manifest(lambda m: m.update(formatVersion=99))
        with self.assertRaisesRegex(engine.ArchiveError, 'Format de sauvegarde 99'):
            self.load()

    def test_rejects_future_fields_instead_of_silently_dropping_them(self):
        self.export()
        def change(m):
            m['schemas']['projects'].append(dict(name='future_required_field', type='TEXT', notnull=1, dflt_value=None, pk=0))
            m['tables']['projects'][0]['future_required_field'] = 'important'
        self.rewrite_manifest(change)
        _, manifest = self.load()
        with self.assertRaisesRegex(engine.ArchiveError, 'projects.future_required_field'):
            engine.preview(self.target, manifest)
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_rejects_unknown_required_capability_with_reason(self):
        self.export()
        self.rewrite_manifest(lambda m: m['requiredCapabilities'].append('future-feature-v2'))
        with self.assertRaisesRegex(engine.ArchiveError, 'fonctionnalité future-feature-v2'):
            self.load()

    def test_refuses_global_settings_in_a_project_zip(self):
        self.export()
        _, manifest = self.load()
        with engine.connect(self.source_db, True) as db:
            manifest['schemas']['settings'] = engine.columns(db, 'settings')
        manifest['tables']['settings'] = [dict(key='global-setting', value='unsafe', type='string', category='general', description='', default_value='', constraints='{}', updated_at=1)]
        with self.assertRaisesRegex(engine.ArchiveError, 'réglages globaux'):
            engine.preview(self.target, manifest)

    def test_rejects_operational_path_traversal_before_import(self):
        self.export()
        self.rewrite_manifest(lambda m: m['tables']['simple_chat_threads'][0].update(cwd=str(self.project) + '/../other'))
        with self.assertRaisesRegex(engine.ArchiveError, 'Chemin opérationnel dangereux'):
            self.import_project()
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_rejects_null_for_new_required_target_value(self):
        self.export()
        self.rewrite_manifest(lambda m: m['tables']['projects'][0].update(name=None))
        _, manifest = self.load()
        with self.assertRaisesRegex(engine.ArchiveError, 'Valeur requise absente : projects.name'):
            engine.preview(self.target, manifest)

    def test_rejects_missing_new_required_field(self):
        self.export()
        _, manifest = self.load()
        with sqlite3.connect(self.target_db) as db:
            db.execute("ALTER TABLE projects ADD COLUMN future_required TEXT NOT NULL")
        with self.assertRaisesRegex(engine.ArchiveError, 'champ requis absent projects.future_required'):
            engine.preview(self.target, manifest)

    def test_accepts_new_target_columns_with_defaults(self):
        self.export()
        with sqlite3.connect(self.target_db) as db:
            db.execute("ALTER TABLE projects ADD COLUMN future_default TEXT NOT NULL DEFAULT 'ok'")
        self.assertTrue(self.import_project()['projectId'])

    def test_rejects_corrupted_file_checksum_before_import(self):
        self.export()
        self.rewrite_manifest(lambda m: m['files'][0].update(sha256='0' * 64))
        with self.assertRaisesRegex(engine.ArchiveError, 'empreinte incorrecte'):
            self.import_project()
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_rejects_zip_slip(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('../escape', 'bad')
        with self.assertRaisesRegex(engine.ArchiveError, 'Chemin dangereux'):
            self.load()

    def test_rejects_symlink_export_instead_of_following_it(self):
        (self.project / 'escape').symlink_to(self.source_db)
        with self.assertRaises(engine.ArchiveError):
            self.export()
        self.assertFalse(self.archive.exists())

    def test_rollback_after_file_stage_preserves_existing_data(self):
        self.export()
        # A destination-only constraint is intentionally violated after extraction.
        with sqlite3.connect(self.target_db) as db:
            db.execute("CREATE TRIGGER reject_import BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'test rollback'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.import_project()
        self.assertEqual(list(self.target_root.iterdir()), [])
        with sqlite3.connect(self.target_db) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM projects').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM people').fetchone()[0], 1)

    def add_agent(self):
        agent = '018f0000-0000-7000-8000-000000000001'
        rollout = self.home / 'sessions/rollout.jsonl'
        rollout.parent.mkdir()
        raw = engine.json_bytes({'type': 'session_meta', 'payload': {'id': agent, 'cwd': str(self.project)}}) + b'\n'
        rollout.write_bytes(raw)
        for home, source in ((self.home, True), (self.target_home, False)):
            with sqlite3.connect(home / 'state_5.sqlite') as db:
                db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cli_version TEXT NOT NULL, cwd TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, project_id TEXT, thread_section_id TEXT)')
                if source:
                    db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,NULL,NULL)', (agent, str(rollout), '0.153.2', str(self.project), '{}', 'never'))
            with sqlite3.connect(home / 'thread_history_1.sqlite') as db:
                db.execute('CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL)')
                if source:
                    db.execute('INSERT INTO thread_history_projection_state VALUES(?,?,1)', (agent, len(raw)))
        with sqlite3.connect(self.source_db) as db:
            db.execute('INSERT INTO project_agent_threads VALUES(?,?,?,?,?)', (agent, 'project-source', str(self.project), 1, 1))
        return agent

    def test_agent_history_and_paginated_offsets_follow_new_ids_and_paths(self):
        old_id = self.add_agent()
        source_rollout = (self.home / 'sessions/rollout.jsonl').read_bytes()
        with sqlite3.connect(self.source_db) as db:
            db.execute("INSERT INTO settings(key,value,type,category,description,default_value,constraints,updated_at) VALUES(?,'hidden','string','thread-response-detail','Display','collapsed','{}',1)", ('thread-response-detail:' + old_id,))
        self.export()
        _, manifest = self.load()
        self.assertIn('agent-display-detail-v1', manifest['requiredCapabilities'])
        self.import_project()
        with engine.connect(self.target_home / 'state_5.sqlite') as db:
            thread = db.execute('SELECT * FROM threads').fetchone()
            self.assertNotEqual(thread['id'], old_id)
            self.assertEqual(uuid.UUID(thread['id']).version, 7)
            rollout = Path(thread['rollout_path'])
            self.assertTrue(rollout.is_file())
            self.assertEqual(json.loads(rollout.read_text())['payload']['id'], thread['id'])
            with engine.connect(self.target_db) as app:
                self.assertEqual(app.execute('SELECT value FROM settings WHERE key=?', ('thread-response-detail:' + thread['id'],)).fetchone()[0], 'hidden')
                self.assertIsNone(app.execute('SELECT value FROM settings WHERE key=?', ('thread-response-detail:' + old_id,)).fetchone())
            with engine.connect(self.target_home / 'thread_history_1.sqlite') as history:
                state = history.execute('SELECT * FROM thread_history_projection_state').fetchone()
                self.assertEqual(state['thread_id'], thread['id'])
                self.assertEqual(state['next_rollout_byte_offset'], rollout.stat().st_size)
        self.assertEqual((self.home / 'sessions/rollout.jsonl').read_bytes(), source_rollout)

    def test_refuses_incompatible_agent_engine_before_creating_project(self):
        self.add_agent()
        self.export()
        self.target['codexVersion'] = '0.160.0'
        with self.assertRaisesRegex(engine.ArchiveError, 'moteur cible 0.160.0'):
            self.import_project()
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_outgoing_branch_is_not_a_reason_to_export_another_project(self):
        agent = self.add_agent()
        with sqlite3.connect(self.source_db) as db:
            db.execute('INSERT INTO conversation_branch_edges VALUES(?,?,?,?,?,?,?,?)', ('private-child', agent, agent, '__end__', 'turn', '[]', 1, 'local'))
            db.execute('INSERT INTO conversation_branch_active_members VALUES(?,?,?)', (agent, 'private-child', 2))
            before = list(db.iterdump())
        self.export()
        _, manifest = self.load()
        self.assertNotIn(b'private-child', engine.json_bytes(manifest))
        self.assertIn('autonomous-branches-v1', manifest['requiredCapabilities'])
        self.assertTrue(any('extérieures' in warning for warning in manifest['warnings']))
        self.assertEqual(manifest['tables']['conversation_branch_active_members'][0]['active_thread_id'], agent)
        self.import_project()
        with sqlite3.connect(self.source_db) as db:
            self.assertEqual(list(db.iterdump()), before)

    def test_shared_parent_is_cut_without_losing_child_rollout(self):
        agent = self.add_agent()
        rollout = self.home / 'sessions/rollout.jsonl'
        event = json.loads(rollout.read_text())
        event['payload']['forked_from_id'] = 'outside-parent'
        rollout.write_bytes(engine.json_bytes(event) + b'\n')
        with sqlite3.connect(self.home / 'thread_history_1.sqlite') as db:
            db.execute('UPDATE thread_history_projection_state SET next_rollout_byte_offset=?', (rollout.stat().st_size,))
        with sqlite3.connect(self.source_db) as db:
            db.execute('INSERT INTO conversation_branch_edges VALUES(?,?,?,?,?,?,?,?)', (agent, 'outside-parent', 'outside-root', '__end__', 'prefix', '[]', 1, 'local'))
            db.execute('INSERT INTO conversation_branch_groups VALUES(?,?,?,?,?)', ('group', 'outside-root', 'prefix', 1, 1))
            db.execute('INSERT INTO conversation_branch_versions(version_id,group_id,thread_id,version_index,kind,preview_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', ('v-local', 'group', agent, 2, 'branch', 'Child message', 1, 1))
            db.execute('INSERT INTO conversation_branch_versions(version_id,group_id,thread_id,version_index,kind,preview_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', ('v-external', 'group', 'outside-parent', 1, 'original', 'PRIVATE OTHER PROJECT', 1, 1))
        self.export()
        _, manifest = self.load()
        self.assertNotIn(b'PRIVATE OTHER PROJECT', engine.json_bytes(manifest))
        self.assertNotIn(b'outside-parent', engine.json_bytes(manifest))
        self.assertEqual(manifest['tables']['conversation_branch_groups'][0]['tree_root_thread_id'], agent)
        self.assertEqual(manifest['tables']['conversation_branch_versions'][0]['version_index'], 1)
        self.import_project()
        with engine.connect(self.target_home / 'state_5.sqlite') as db:
            thread = db.execute('SELECT * FROM threads').fetchone()
            restored = json.loads(Path(thread['rollout_path']).read_text())
            self.assertIsNone(restored['payload']['forked_from_id'])
            self.assertEqual(restored['payload']['id'], thread['id'])

    def test_current_codec_transfers_162_to_164_and_rejects_unverified_versions(self):
        self.add_agent()
        self.source['codexVersion'] = '0.162.1'
        self.target['codexVersion'] = '0.164.0'
        self.export()
        _, manifest = self.load()
        self.assertIn('codex-history-state5-v2', manifest['requiredCapabilities'])
        self.assertNotIn('codex-history-0.153', manifest['requiredCapabilities'])
        self.import_project()
        for version in ('0.163.0', '0.165.0', '1.0.0', ''):
            with self.subTest(version=version), self.assertRaises(engine.ArchiveError):
                engine.validate_agent_versions('0.162.1', version)
        with self.assertRaises(engine.ArchiveError):
            engine.validate_agent_versions('0.164.0', '0.162.1')

    def test_current_codec_still_rejects_unknown_target_fields_without_loss(self):
        self.add_agent()
        self.source['codexVersion'] = '0.162.1'
        self.target['codexVersion'] = '0.164.0'
        self.export()
        _, manifest = self.load()
        manifest['agents']['schemas']['threads'].append(dict(name='future_native_data', type='TEXT', notnull=0, dflt_value=None, pk=0))
        manifest['agents']['tables']['threads'][0]['future_native_data'] = 'must not disappear'
        with self.assertRaisesRegex(engine.ArchiveError, 'threads.future_native_data'):
            engine.preview(self.target, manifest)
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_older_reader_must_not_accept_the_new_native_codec(self):
        self.add_agent()
        self.source['codexVersion'] = '0.162.1'
        self.export()
        with patch.object(engine, 'CAPABILITIES', engine.CAPABILITIES - {'codex-history-state5-v2'}):
            with self.assertRaisesRegex(engine.ArchiveError, 'codex-history-state5-v2'):
                self.load()

    def test_operational_workspace_outside_project_is_relocated_without_copying_it(self):
        outside = self.base / 'private-other-workspace'
        outside.mkdir()
        (outside / 'private.txt').write_text('OTHER PROJECT SECRET')
        with sqlite3.connect(self.source_db) as db:
            db.execute('UPDATE project_tasks SET workspace_path=? WHERE id=?', (str(outside), 'task'))
        self.export()
        _, manifest = self.load()
        self.assertIn('operational-path-relocation-v1', manifest['requiredCapabilities'])
        task = next(r for r in manifest['tables']['project_tasks'] if r['id'] == 'task')
        self.assertEqual(task['workspace_path'], str(self.project))
        self.assertFalse(any(r['source'] == str(outside) for r in manifest['roots']))
        result = self.import_project()
        with engine.connect(self.target_db, True) as db:
            task = db.execute("SELECT workspace_path FROM project_tasks WHERE title='Parent'").fetchone()
            self.assertEqual(task[0], str(self.target_root.resolve() / result['projectId']))
            provenance = json.loads(db.execute('SELECT provenance FROM project_archive_imports').fetchone()[0])
            self.assertEqual(provenance['relocatedOperationalPaths'][0]['source'], str(outside))
        with sqlite3.connect(self.source_db) as db:
            self.assertEqual(db.execute("SELECT workspace_path FROM project_tasks WHERE id='task'").fetchone()[0], str(outside))

    def test_internal_branch_prefix_offsets_follow_rewritten_parent(self):
        parent = self.add_agent()
        child = '018f0000-0000-7000-8000-000000000002'
        parent_file = self.home / 'sessions/rollout.jsonl'
        child_file = self.home / 'sessions/child.jsonl'
        payload = {'id': child, 'cwd': str(self.project), 'forked_from_id': parent,
                   'history_base': {'thread_id': parent, 'end_byte_offset': parent_file.stat().st_size, 'end_ordinal_exclusive': 1}}
        child_file.write_bytes(engine.json_bytes({'type': 'session_meta', 'payload': payload}) + b'\n')
        with sqlite3.connect(self.home / 'state_5.sqlite') as db:
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,NULL,NULL)', (child, str(child_file), '0.153.2', str(self.project), '{}', 'never'))
        with sqlite3.connect(self.source_db) as db:
            db.execute('INSERT INTO project_agent_threads VALUES(?,?,?,?,?)', (child, 'project-source', str(self.project), 1, 1))
            db.execute('INSERT INTO conversation_branch_edges VALUES(?,?,?,?,?,?,?,?)', (child, parent, parent, '__end__', 'prefix', '[]', 1, 'local'))
        self.export()
        zip_file, manifest = self.load()
        manifest['agents']['tables']['threads'].sort(key=lambda r: r['id'] != child)
        engine.import_archive(self.target, zip_file, manifest)
        with engine.connect(self.target_home / 'state_5.sqlite') as db:
            restored = [dict(r) for r in db.execute('SELECT * FROM threads')]
        by_id = {r['id']: r for r in restored}
        headers = [json.loads(Path(r['rollout_path']).read_text())['payload'] for r in restored]
        child_header = next(h for h in headers if h.get('history_base'))
        base = child_header['history_base']
        self.assertNotEqual(base['thread_id'], parent)
        self.assertEqual(base['end_byte_offset'], Path(by_id[base['thread_id']]['rollout_path']).stat().st_size)
        self.assertEqual(child_header['forked_from_id'], base['thread_id'])

    def test_external_history_prefix_is_never_silently_discarded(self):
        self.add_agent()
        file = self.home / 'sessions/rollout.jsonl'
        event = json.loads(file.read_text())
        event['payload']['history_base'] = {'thread_id': 'external', 'end_byte_offset': 200, 'end_ordinal_exclusive': 1}
        file.write_bytes(engine.json_bytes(event) + b'\n')
        with self.assertRaisesRegex(engine.ArchiveError, 'préfixe d’historique stocké'):
            self.export()
        self.assertFalse(self.archive.exists())

    def test_import_rejects_topology_with_foreign_threads_even_if_target_has_them(self):
        agent = self.add_agent()
        self.export()
        _, manifest = self.load()
        with engine.connect(self.source_db, True) as db:
            manifest['schemas']['conversation_branch_edges'] = engine.columns(db, 'conversation_branch_edges')
        manifest['tables']['conversation_branch_edges'] = [dict(child_thread_id=agent, parent_thread_id='foreign', tree_root_thread_id=agent, fork_before_turn_id='__end__', common_prefix_turn_id='prefix', inherited_turn_ids='[]', created_at=1, source='local')]
        with self.assertRaisesRegex(engine.ArchiveError, 'conversation hors du ZIP'):
            engine.preview(self.target, manifest)
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_export_rejects_cycles_instead_of_following_them_forever(self):
        agent = self.add_agent()
        with sqlite3.connect(self.source_db) as db:
            db.execute('INSERT INTO conversation_branch_edges VALUES(?,?,?,?,?,?,?,?)', (agent, agent, agent, '__end__', 'prefix', '[]', 1, 'local'))
        with self.assertRaisesRegex(engine.ArchiveError, 'cycle'):
            self.export()

    def test_deliverable_documents_versions_and_snapshots_are_relinked(self):
        live = self.project / 'livrables/deliverable/report.docx'
        snapshot = self.project / '.mergeron/history/deliverable/document/1.docx'
        for file in (live, snapshot):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'document-content')
        digest = engine.sha(live.read_bytes())
        with sqlite3.connect(self.source_db) as db:
            db.execute("INSERT INTO project_resources(id,project_id,type,name,created_at,updated_at) VALUES('delivery-board','project-source','deliverable_board','Livrables',1,1)")
            db.execute("INSERT INTO project_deliverables(id,resource_id,title,primary_task_id,current_snapshot_id,last_approved_snapshot_id,created_at,updated_at) VALUES('deliverable','delivery-board','Rapport','task','snapshot','snapshot',1,1)")
            db.execute("INSERT INTO project_deliverable_documents(id,deliverable_id,name,format,source_path,current_version_number,created_at,updated_at) VALUES('document','deliverable','report.docx','docx',?,1,1,1)", (str(live),))
            db.execute("INSERT INTO project_deliverable_document_versions(id,document_id,number,file_name,source_path,snapshot_path,size,sha256,author_person_id,author_name,created_at) VALUES('document-version','document',1,'report.docx',?,?,16,?,'person','Alice',1)", (str(live), str(snapshot), digest))
            composition = json.dumps([{'documentId': 'document', 'documentVersionId': 'document-version', 'versionNumber': 1, 'sha256': digest}])
            db.execute("INSERT INTO project_deliverable_snapshots(id,deliverable_id,documents,created_by_person_id,created_by_name,created_at) VALUES('snapshot','deliverable',?,'person','Alice',1)", (composition,))
        self.export()
        self.target['selection'] = ['work']  # must pull tasks, snapshots and files together
        self.import_project()
        with engine.connect(self.target_db) as db:
            document = db.execute('SELECT * FROM project_deliverable_documents').fetchone()
            version = db.execute('SELECT * FROM project_deliverable_document_versions').fetchone()
            snapshot_row = db.execute('SELECT * FROM project_deliverable_snapshots').fetchone()
            delivery = db.execute('SELECT * FROM project_deliverables').fetchone()
            self.assertEqual(Path(version['snapshot_path']).read_bytes(), b'document-content')
            self.assertEqual(Path(document['source_path']).read_bytes(), b'document-content')
            self.assertEqual(json.loads(snapshot_row['documents'])[0]['documentVersionId'], version['id'])
            self.assertEqual(delivery['current_snapshot_id'], snapshot_row['id'])
            self.assertNotIn('/deliverable/', document['source_path'])
            self.assertEqual(version['author_name'], 'Alice')

    def test_refuses_document_version_without_its_immutable_snapshot(self):
        self.export()
        _, manifest = self.load()
        manifest['tables']['project_deliverable_document_versions'] = [{
            'id': 'missing-version', 'snapshot_path': str(self.project / 'missing.docx'),
            'sha256': '0' * 64, 'size': 10, 'file_name': 'missing.docx',
        }]
        with self.assertRaisesRegex(engine.ArchiveError, 'version historique de document est absente'):
            engine.validate_project_content(manifest)

    def test_pauses_automations_and_disables_external_connections_without_secrets(self):
        with sqlite3.connect(self.source_db) as db:
            config = json.dumps({'automations': [{'id': 'schedule', 'active': True, 'nextRunAt': 1, 'instructions': 'Original instructions'}]})
            db.execute("INSERT INTO project_resources(id,project_id,type,name,config,created_at,updated_at) VALUES('automation','project-source','automation_board','Automation',?,1,1)", (config,))
            db.execute("INSERT INTO project_workspace_resources(id,project_id,name,type,address,capabilities,connection_state,created_at,updated_at) VALUES('ssh','project-source','Prod SSH','ssh','prod.example.test','{}','connected',1,1)")
            db.execute("INSERT INTO project_workspace_secrets VALUES('ssh','encrypted-secret','iv','tag',1,1)")
        self.export()
        _, manifest = self.load()
        self.assertNotIn(b'encrypted-secret', engine.json_bytes(manifest))
        self.import_project()
        with engine.connect(self.target_db) as db:
            config = json.loads(db.execute("SELECT config FROM project_resources WHERE type='automation_board'").fetchone()[0])
            self.assertFalse(config['automations'][0]['active'])
            self.assertEqual(config['automations'][0]['instructions'], 'Original instructions')
            resource = db.execute('SELECT * FROM project_workspace_resources').fetchone()
            self.assertEqual((resource['enabled'], resource['connection_state']), (0, 'disabled'))
            self.assertEqual(resource['type'], 'ssh')
            self.assertNotIn('project_connections', manifest['tables'])
            self.assertNotIn('project_locations', manifest['tables'])
            connection = db.execute('SELECT * FROM project_connections').fetchone()
            self.assertEqual((connection['id'], connection['protocol'], connection['enabled']),
                             (resource['id'], 'ssh', 0))
            location = db.execute("SELECT * FROM project_locations WHERE kind='remote'").fetchone()
            self.assertEqual((location['connection_id'], location['path']),
                             (connection['id'], resource['root_path']))
            self.assertEqual(db.execute('SELECT count(*) FROM project_workspace_secrets').fetchone()[0], 0)

    def test_chat_attachments_are_copied_and_relinked(self):
        upload = self.home / 'webui-uploads/image.png'
        upload.parent.mkdir()
        upload.write_bytes(b'image-data')
        with sqlite3.connect(self.source_db) as db:
            db.execute('UPDATE simple_chat_messages SET content=?', ('Image: ' + str(upload),))
        self.export()
        result = self.import_project()
        copies = list((self.target_root / result['projectId'] / '.mergeron/imported-attachments').iterdir())
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_bytes(), b'image-data')
        with engine.connect(self.target_db) as db:
            self.assertEqual(db.execute('SELECT content FROM simple_chat_messages').fetchone()[0], 'Image: ' + str(copies[0].resolve()))

    def test_native_commit_is_compensated_if_filesystem_publication_fails(self):
        self.add_agent()
        self.export()
        with patch.object(engine.os, 'rename', side_effect=OSError('publication failed')):
            with self.assertRaises(OSError):
                self.import_project()
        with engine.connect(self.target_home / 'state_5.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM threads').fetchone()[0], 0)
        with engine.connect(self.target_home / 'thread_history_1.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM thread_history_projection_state').fetchone()[0], 0)
        self.assertEqual(list(self.target_root.iterdir()), [])

    def test_recovery_never_removes_a_directory_without_its_ownership_marker(self):
        project_id = str(uuid.uuid4())
        target = self.target_root / project_id
        target.mkdir()
        (target / 'keep.txt').write_text('existing data')
        stage = self.target_root.resolve() / '.mergeron-import-owned'
        stage.mkdir()
        record = {'projectId': project_id, 'operationId': str(uuid.uuid4()), 'staging': str(stage), 'agents': []}
        (stage / '.mergeron-import-owner').write_text(json.dumps({'projectId': project_id, 'operationId': record['operationId']}))
        engine.recover_import(self.target, record)
        self.assertEqual((target / 'keep.txt').read_text(), 'existing data')
        self.assertFalse(stage.exists())

    def test_rejects_cross_project_foreign_keys_even_if_target_id_exists(self):
        self.export()
        self.rewrite_manifest(lambda m: m['tables']['project_tasks'][0].update(resource_id='outside-board'))
        _, manifest = self.load()
        with self.assertRaisesRegex(engine.ArchiveError, 'Référence hors du projet'):
            engine.preview(self.target, manifest)

    def test_rejects_case_collisions(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('content/A', 'one')
            archive.writestr('content/a', 'two')
        with self.assertRaisesRegex(engine.ArchiveError, 'ZIP ambigu'):
            self.load()

    def test_large_files_fail_without_creating_a_partial_archive(self):
        with patch.object(engine, 'MAX_ENTRY', 2):
            with self.assertRaises(engine.ArchiveError):
                self.export()
        self.assertFalse(self.archive.exists())

    def test_refuses_git_worktrees_referencing_external_storage(self):
        (self.project / '.git').write_text('gitdir: /somewhere/else\n')
        with self.assertRaisesRegex(engine.ArchiveError, 'dépôt extérieur'):
            self.export()


if __name__ == '__main__':
    unittest.main()
