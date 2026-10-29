/** Native Linux regression: no user project, credentials, or inference service. */
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
  documentIsolationArgs,
  documentAgentEnvironment,
} = require('/app/dist/document-publication/document-isolation.js');
const { agentEnvironmentCommand } = require('/app/dist/codex/agent-environment.js');

const workspace = fs.mkdtempSync('/workspaces/.document-isolation-probe-');
const temporary = fs.mkdtempSync('/tmp/document-isolation-probe-');
// Core intentionally refuses executable helper aliases in a /tmp CODEX_HOME.
// This home is disposable RAM in the networkless container, never a host home.
const nativeHome = process.argv[2] ? fs.mkdtempSync('/home/codex/.native-profile-') : null;
try {
  const home = path.join(nativeHome || path.join(temporary, 'home'), '.codex');
  fs.mkdirSync(home, { recursive: true });
  const ssh = path.join(path.dirname(home), '.ssh');
  fs.mkdirSync(ssh);
  fs.writeFileSync(path.join(ssh, 'operator-key'), 'private-canary');
  const retained = path.join(workspace, 'livrables');
  const history = path.join(workspace, '.mergeron');
  fs.mkdirSync(retained);
  fs.mkdirSync(history);
  const clone = path.join(workspace, 'sources', 'new-clone');
  fs.mkdirSync(clone, { recursive: true });
  const system = path.join(workspace, 'system');
  fs.mkdirSync(system);
  fs.writeFileSync(path.join(system, 'private-state'), 'private-canary');
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
    fs.writeFileSync(root+'/sources/new-clone/main.js','clone-editable');
    assert.equal(fs.existsSync(root+'/system/private-state'),false);
    assert.throws(()=>fs.writeFileSync(root+'/system/tampered','no'),e=>e.code==='EROFS'||e.code==='EACCES');
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
    const cacheKeys=['XDG_CACHE_HOME','COREPACK_HOME','npm_config_cache','npm_config_store_dir','pnpm_config_store_dir','npm_config_devdir','PNPM_HOME'];
    for(const key of cacheKeys) {
      assert.ok(process.env[key].startsWith('/tmp/mergeron-agent-cache.'));
      fs.writeFileSync(process.env[key]+'/probe','writable');
    }
    const cp=require('child_process');
    const env={...process.env,COREPACK_ENABLE_NETWORK:'0',COREPACK_ENABLE_PROJECT_SPEC:'0',HTTPS_PROXY:'',https_proxy:'',HTTP_PROXY:'',http_proxy:''};
    const pnpm=cp.execFileSync('pnpm',['--version'],{env,encoding:'utf8',timeout:15000}).trim();
    assert.match(pnpm,/^\\d+\\.\\d+\\.\\d+$/);
    const store=cp.execFileSync('pnpm',['store','path','--silent'],{env,encoding:'utf8',timeout:15000}).trim();
    assert.ok(store.startsWith(process.env.npm_config_store_dir+'/'),store);
    const preflight=JSON.parse(cp.execFileSync('mergeron-environment-check',['--cwd',root,'--visual','--json'],{env,encoding:'utf8',timeout:45000}));
    assert.equal(preflight.success,true,JSON.stringify(preflight));
    assert.equal(preflight.checks.find(c=>c.id==='node.headers').status,'ok');
    if(process.argv[4]) {
      cp.execFileSync(process.execPath,['/agent-test-profile.cjs',process.argv[4],root,process.env.CODEX_HOME,...(process.argv[5]==='--netlink-route'?['--netlink-route']:[])],{env:process.env,stdio:'inherit',timeout:65000,killSignal:'SIGKILL'});
    }
    console.log('PASS: code writable; versions immutable; rename/hardlink refused; private state hidden');
    console.log('PASS: private caches writable; pnpm available offline; loopback and sandboxed Chromium ready inside bwrap');
  `;
  const command = agentEnvironmentCommand(process.execPath, ['-e', probe, workspace, databasePath, ssh, ...(process.argv[2] ? [process.argv[2]] : []), ...(process.argv[3]==='--netlink-route'?['--netlink-route']:[])]);
  const args = documentIsolationArgs(
    {
      home,
      databasePath,
      writableRoots: ['/workspaces', workspace, clone],
      publishedRoots: [retained, history],
      privateRoots: [system],
      unavailableRoots: [path.join(workspace, 'missing-project')],
    },
    command.binary,
    command.args,
  );
  const result = cp.spawnSync('/usr/bin/bwrap', args, {
    encoding: 'utf8',
    timeout: 120000,
    killSignal: 'SIGKILL',
    env: documentAgentEnvironment({
      ...process.env,
      CODEX_HOME: home,
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
  if (process.argv[3] === '--netlink-route' && process.env.MERGERON_NETLINK_EVIDENCE) {
    const source = path.join(workspace, 'artifacts/native-backend-visual');
    for (const name of ['desktop.png', 'mobile.png', 'report.json']) {
      const file = path.join(source, name);
      assert(fs.lstatSync(file).isFile());
      const bytes = fs.readFileSync(file);
      assert(bytes.length < 15 * 1024 * 1024);
      if (name.endsWith('.png')) assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const destination = path.join(process.env.MERGERON_NETLINK_EVIDENCE, name);
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
      // Only these synthetic fixture outputs are public CI artifacts. The
      // uploader uses the host runner UID, not the container's application UID.
      // Explicit chmod also handles a restrictive umask without changing it.
      fs.chmodSync(destination, 0o644);
    }
    console.log('PASS: desktop/mobile evidence exported by the trusted outer fixture');
  }
} finally {
  fs.rmSync(workspace, { recursive: true });
  fs.rmSync(temporary, { recursive: true });
  if (nativeHome) fs.rmSync(nativeHome, { recursive: true });
}
