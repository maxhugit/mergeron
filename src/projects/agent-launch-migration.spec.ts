/** Upgrade old launch receipts without losing their uncertainty or replaying work. */
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
it('preserves submitted and uncertain task receipts before retiring the old table', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    const folder = join(process.cwd(), 'drizzle');
    const journal = JSON.parse(
      readFileSync(join(folder, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      if (entry.tag === '0074_shared_agent_launch_recovery') break;
      sqlite.exec(readFileSync(join(folder, entry.tag + '.sql'), 'utf8'));
    }
    sqlite.exec(`INSERT INTO projects(id,name,workspace_path,created_at,updated_at) VALUES('p','Project','/work',1,1);
      INSERT INTO project_resources(id,project_id,type,name,created_at,updated_at) VALUES('r','p','task_board','Tasks',1,1);
      INSERT INTO project_task_statuses(id,resource_id,name,kind,position,created_at,updated_at) VALUES('s','r','Todo','unassigned',0,1,1);
      INSERT INTO project_tasks(id,resource_id,status_id,title,position,workspace_path,created_at,updated_at) VALUES('t1','r','s','Sent',0,'/work',1,2),('t2','r','s','Unknown',1,'/work',1,3);
      INSERT INTO project_task_launches(task_id,project_id,request_id,owner_id,state,thread_id,updated_at) VALUES('t1','p','request1','owner','submitted','agent',5),('t2','p','request2','owner','needs_attention',NULL,6);`);
    sqlite.exec(
      readFileSync(
        join(folder, '0074_shared_agent_launch_recovery.sql'),
        'utf8',
      ),
    );
    const rows = sqlite
      .prepare('SELECT * FROM project_agent_launches ORDER BY id')
      .all() as Array<{
      id: string;
      context: string;
      state: string;
      phase: string;
      owner_id: string;
      request_id: string;
      thread_id: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 't1',
      state: 'submitted',
      phase: 'legacy',
      owner_id: 'owner',
      request_id: 'request1',
      thread_id: 'agent',
    });
    expect(rows[1]).toMatchObject({
      id: 't2',
      state: 'needs_attention',
      phase: 'legacy',
      owner_id: 'owner',
      thread_id: null,
    });
    expect(JSON.parse(rows[1].context)).toMatchObject({
      kind: 'task',
      targetId: 't2',
      cwd: '/work',
      createdSubtask: false,
      existing: false,
    });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='project_task_launches'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    sqlite.close();
  }
});
