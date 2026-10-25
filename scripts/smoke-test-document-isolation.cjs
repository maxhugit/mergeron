/** Native Linux regression: no user project, credentials, or inference service. */
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
  documentIsolationArgs,
  documentAgentEnvironment,
} = require('/app/dist/document-publication/document-isolation.js');

const workspace = fs.mkdtempSync('/workspaces/.document-isolation-probe-');
const temporary = fs.mkdtempSync('/tmp/document-isolation-probe-');
try {
  const home = path.join(temporary, 'home', '.codex');
  fs.mkdirSync(home, { recursive: true });
  const ssh = path.join(temporary, 'home', '.ssh');
  fs.mkdirSync(ssh);
  fs.writeFileSync(path.join(ssh, 'operator-key'), 'private-canary');
  const retained = path.join(workspace, 'livrables');
  const history = path.join(workspace, '.mergeron');
  fs.mkdirSync(retained);
  fs.mkdirSync(history);
  fs.writeFileSync(path.join(retained, 'report.docx'), 'V1');
  fs.writeFileSync(path.join(history, 'v1.docx'), 'V1');
  const databasePath = path.join(home, 'webui.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    fs.writeFileSync(databasePath + suffix, 'private-canary');
  fs.writeFileSync('/run/secrets/backend_token', 'private-canary');
  fs.writeFileSync('/run/mergeron-manager/manager.sock', 'private-canary');
  fs.writeFileSync('/appdata/private-backup', 'private-canary');
  const probe = `
    const fs=require('fs'), assert=require('assert/strict');
    const root=process.argv[1], db=process.argv[2], ssh=process.argv[3];
    fs.writeFileSync(root+'/main.js','code-editable');
    assert.throws(()=>fs.writeFileSync(root+'/missing-project/tampered','no'),e=>e.code==='EROFS'||e.code==='EACCES');
    assert.equal(fs.readFileSync(root+'/livrables/report.docx','utf8'),'V1');
    for(const file of [root+'/livrables/report.docx',root+'/.mergeron/v1.docx']) {
      assert.throws(()=>fs.writeFileSync(file,'tampered'),e=>e.code==='EROFS'||e.code==='EACCES');
      assert.throws(()=>fs.renameSync(file,root+'/bypass.docx'));
      assert.throws(()=>fs.linkSync(file,root+'/hardlink-bypass.docx'));
    }
    for(const suffix of ['','-wal','-shm','-journal']) {
      try { assert.equal(fs.readFileSync(db+suffix,'utf8'),''); }
      catch(e) { assert.ok(['EACCES','EPERM'].includes(e.code)); }
      assert.throws(()=>fs.writeFileSync(db+suffix,'tampered'));
    }
    assert.equal(process.env.WEBUI_API_KEY,undefined);
    assert.equal(process.env.SSH_AUTH_SOCK,undefined);
    assert.equal(fs.existsSync(ssh+'/operator-key'),false);
    assert.equal(fs.existsSync('/run/secrets/backend_token'),false);
    assert.equal(fs.existsSync('/run/mergeron-manager/manager.sock'),false);
    assert.deepEqual(fs.readdirSync('/appdata'),[]);
    console.log('PASS: code writable; versions immutable; rename/hardlink refused; private state hidden');
  `;
  const args = documentIsolationArgs(
    {
      home,
      databasePath,
      writableRoots: [workspace],
      publishedRoots: [retained, history],
      unavailableRoots: [path.join(workspace, 'missing-project')],
    },
    process.execPath,
    ['-e', probe, workspace, databasePath, ssh],
  );
  const result = cp.spawnSync('/usr/bin/bwrap', args, {
    encoding: 'utf8',
    env: documentAgentEnvironment({
      ...process.env,
      WEBUI_API_KEY: 'private-canary',
      SSH_AUTH_SOCK: '/fake-agent',
    }),
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(databasePath, 'utf8'), 'private-canary');
  assert.equal(
    fs.readFileSync(path.join(retained, 'report.docx'), 'utf8'),
    'V1',
  );
  assert.equal(fs.readFileSync(path.join(history, 'v1.docx'), 'utf8'), 'V1');
} finally {
  fs.rmSync(workspace, { recursive: true });
  fs.rmSync(temporary, { recursive: true });
}
