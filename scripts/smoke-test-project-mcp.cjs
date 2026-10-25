/** Native protocol regression. Fake MCP and unreachable local model; no account or tool call. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-mcp-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
const fixture = path.join(root, 'fixture.cjs');
fs.writeFileSync(fixture, `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);if(!('id' in r))return;
if(r.method==='tools/call')throw Error('This fixture must never execute a tool');
let result={};
if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
if(r.method==='tools/list')result={tools:[{name:'fixture_tool',description:'Fixture only',inputSchema:{type:'object'}}]};
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`);
fs.writeFileSync(path.join(home, 'config.toml'), `model_provider="fixture"
model="fixture"
[model_providers.fixture]
name="fixture"
base_url="http://127.0.0.1:1/v1"
wire_api="responses"
request_max_retries=0
stream_max_retries=0
[features]
apps=false
plugins=false
[mcp_servers.fixture]
command=${JSON.stringify(process.execPath)}
args=[${JSON.stringify(fixture)}]
`);
let child, sequence = 0, stderr = '';
const pending = new Map();
const completed = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  child = spawn(process.argv[2] || 'codex', ['app-server'], {
    // Do not inherit a developer's credentials or configuration.
    env: {PATH:process.env.PATH,HOME:home,CODEX_HOME:home,TMPDIR:root},
    stdio: ['pipe','pipe','pipe'],
  });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  readline.createInterface({input:child.stdout}).on('line', line => {
    let result;try { result = JSON.parse(line); } catch { return; }
    if(result.method==='turn/completed')completed.add(result.params.threadId);
    const waiter = pending.get(result.id);
    if(waiter){pending.delete(result.id);result.error?waiter.reject(new Error(result.error.message)):waiter.resolve(result.result);}
  });
  await rpc('initialize',{clientInfo:{name:'mergeron-project-mcp-test',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
}
function rpc(method, params) {
  return new Promise((resolve,reject) => {
    const id = ++sequence;pending.set(id,{resolve,reject});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
}
async function stop() {
  const stopped = new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;
}
async function tools(threadId) {
  const result=await rpc('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly'});
  return result.data.reduce((count,server)=>count+Object.keys(server.tools||{}).length,0);
}
async function waitFor(check, label) {
  for(let attempt=0;attempt<100;attempt++){if(await check())return;await delay(100);}
  throw new Error('Native MCP fixture did not reach expected state: '+label);
}
const watchdog=setTimeout(()=>{console.error('MCP fixture timeout',stderr);child?.kill('SIGKILL');process.exit(2);},40000);
(async()=>{
  await start();
  const {thread}=await rpc('thread/start',{cwd:root});
  await waitFor(async()=>await tools(thread.id)===1, 'initial connection');
  // Materialize a retained thread through a deliberately failing local turn.
  // No model request can leave this container, no key is present, no tool runs.
  const {turn}=await rpc('turn/start',{threadId:thread.id,input:[{type:'text',text:'Local MCP policy fixture',text_elements:[]}]});
  await rpc('turn/interrupt',{threadId:thread.id,turnId:turn.id}).catch(error=>{if(!error.message.includes('no active turn'))throw error;});
  await waitFor(async()=>{const result=await rpc('thread/read',{threadId:thread.id,includeTurns:false});return result.thread.status.type!=='active';}, 'stopped turn');
  const denied={features:{apps:false},apps:{_default:{enabled:false}},mcp_servers:{fixture:{command:process.execPath,args:[fixture],enabled:false}}};
  await stop();await start();
  await rpc('thread/resume',{threadId:thread.id,excludeTurns:true,config:denied});
  assert.equal(await tools(thread.id),0,'Existing thread must not retain global tools');
  const read=await rpc('thread/read',{threadId:thread.id,includeTurns:false});
  assert.equal(read.thread.id,thread.id);
  await stop();await start();
  await rpc('thread/resume',{threadId:thread.id,excludeTurns:true,config:{...denied,mcp_servers:{fixture:{command:process.execPath,args:[fixture],enabled:true}}}});
  await waitFor(async()=>await tools(thread.id)===1, 'selected connection after resume');
  console.log('PASS: existing conversation can revoke and re-enable only the selected fixture MCP after connection replacement; no real tool called');
})().catch(error=>{console.error(error.message,stderr);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);if(child?.exitCode===null)await stop();fs.rmSync(root,{recursive:true,force:true});});
