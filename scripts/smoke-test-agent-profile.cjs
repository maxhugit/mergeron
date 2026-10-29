/** CI-only: actual Core command sandbox, no account, inference or external network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const { filteredTestNetworkAvailable } = require('/app/dist/threads/agent-test-profile.js');
const binary = process.argv[2], root = process.argv[3], home = process.argv[4];
assert(binary && root && home);
execFileSync('git', ['init', '--quiet', root], { env: { ...process.env, HOME: path.dirname(home) } });
fs.writeFileSync(path.join(home, 'config.toml'), `model_provider="fixture"
model="fixture"
[model_providers.fixture]
name="fixture"
base_url="http://127.0.0.1:1/v1"
wire_api="responses"
[features]
apps=false
plugins=false
`);
const child = spawn(binary, ['app-server'], {
  cwd: root,
  env: { ...process.env, CODEX_HOME: home, HOME: path.dirname(home), OPENAI_API_KEY: '', SSH_AUTH_SOCK: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let sequence = 0;
const pending = new Map();
child.stderr.resume(); // Never print runtime logs or inherited configuration.
readline.createInterface({ input: child.stdout }).on('line', line => {
  let response; try { response = JSON.parse(line); } catch { return; }
  const waiter = pending.get(response.id);
  if (waiter) {
    pending.delete(response.id);
    response.error ? waiter.reject(new Error('Native profile RPC refused')) : waiter.resolve(response.result);
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const watchdog = setTimeout(() => { child.kill('SIGKILL'); console.error('Native profile timeout'); process.exit(2); }, 60000);
(async () => {
  await rpc('initialize', { clientInfo: { name: 'mergeron-network-fixture', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  assert.equal(filteredTestNetworkAvailable(await rpc('configRequirements/read', {})), true, 'Running Core must confirm administrator network rules');
  const sandboxPolicy = { type: 'workspaceWrite', writableRoots: [root], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const code = `
    const assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs');
    (async()=>{
      fs.writeFileSync('native-source.txt','allowed');
      assert.throws(()=>fs.writeFileSync('.git/native-tamper','forbidden'));
      assert.throws(()=>fs.writeFileSync('livrables/report.docx','forbidden'));
      const {loopbackProbe,browserProbe}=await import('/app/scripts/environment-check.mjs');
      await loopbackProbe();
      await browserProbe(15000);
      const rejected=cp.spawnSync('curl',['--disable','--silent','--show-error','--head','--max-time','3','https://example.invalid'],{encoding:'utf8',timeout:5000});
      assert.notEqual(rejected.status,0);
      assert.match(rejected.stderr,/403|denied|blocked/i,'Managed proxy must reject the destination, not merely fail DNS');
      console.log('native-profile-ok');
    })().catch(()=>{console.error('Sandboxed visual/network probe failed');process.exitCode=1;});
  `;
  const result = await rpc('command/exec', { command: [process.execPath, '-e', code], cwd: root, sandboxPolicy, timeoutMs: 30000, outputBytesCap: 4096 });
  assert.equal(result.exitCode, 0, 'Loopback, sandboxed Chromium and enforced destination denial must work in the actual command sandbox');
  assert.match(result.stdout, /native-profile-ok/);
  console.log('PASS: actual Core sandbox preserves Git/documents, supports loopback and sandboxed Chromium, and denies an unlisted host');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  child.kill('SIGKILL');
});
