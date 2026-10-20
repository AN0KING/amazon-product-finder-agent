import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
const source=path.resolve('packaging/windows');
const powershell=path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const isWindows=process.platform==='win32';
async function ps(script,args=[]){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'scout-ps-output-'));
 const out=await fs.open(path.join(temporary,'out.txt'),'w'), err=await fs.open(path.join(temporary,'err.txt'),'w');
 try {
  const code=await new Promise((resolve,reject)=>{const child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,...args],{windowsHide:true,stdio:['ignore',out.fd,err.fd]});const timer=setTimeout(()=>{child.kill();reject(Error('PowerShell test timeout'));},60000);child.once('error',reject);child.once('exit',value=>{clearTimeout(timer);resolve(value);});});
  const stdout=await fs.readFile(path.join(temporary,'out.txt'),'utf8'),stderr=await fs.readFile(path.join(temporary,'err.txt'),'utf8');
  if(code!==0)throw Object.assign(Error(stderr),{code,stdout,stderr});
  return {stdout,stderr};
 } finally {await out.close();await err.close();await fs.rm(temporary,{recursive:true,force:true});}
}
async function prepare(t,{nestedPackage='',nestedInstall=''}={}){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'scout-windows-package-test-'));
 t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const pkg=path.join(temp,nestedPackage,'package');
 const installed=path.join(temp,nestedInstall,'installed');
 await fs.mkdir(path.join(pkg,'application/config'),{recursive:true});
 await fs.cp(source,path.join(pkg,'windows'),{recursive:true});
 await fs.writeFile(path.join(pkg,'application/server.mjs'),'// test fixture, never executed\n');
 await fs.writeFile(path.join(pkg,'application/package.json'),'{"version":"test-1"}');
 await fs.writeFile(path.join(pkg,'application/config/sellersprite.example.toml'),'# no credentials\n');
 const files=[];
 for(const directory of ['application','windows']){
   for(const entry of await fs.readdir(path.join(pkg,directory),{recursive:true,withFileTypes:true})){
     if(entry.isFile()){
       const absolute=path.join(entry.parentPath || entry.path,entry.name);
       files.push({path:path.relative(pkg,absolute).replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex')});
     }
   }
 }
 const manifest={product:'scout-amazon-agent-windows',version:'test-1',requirements:{node:'24.x',arch:'x64'},files};
 await fs.writeFile(path.join(pkg,'package-manifest.json'),JSON.stringify(manifest));
 const install=()=>ps(path.join(pkg,'windows/Install.ps1'),['-PackageRoot',pkg,'-NodePath',process.execPath,'-InstallRoot',installed,'-NoStart','-NoShortcuts']);
 return {temp,pkg,installed,manifest,install};
}
test('offline install and upgrade preserve all user data without starting services or registering shortcuts',{skip:!isWindows},async t=>{
 const fixture=await prepare(t); const {installed}=fixture;
 await fixture.install();
 assert.equal((JSON.parse(await fs.readFile(path.join(installed,'control/installation.json')))).product,'scout-amazon-agent-windows');
 await assert.rejects(fs.access(path.join(installed,'control/enabled')));
 await assert.rejects(fs.access(path.join(installed,'control/shortcuts.json')));
 for(const relative of ['data/scout/state.json','data/1688-session/cookies.json','config/sellersprite.local.toml']){
   await fs.mkdir(path.dirname(path.join(installed,relative)),{recursive:true});
   await fs.writeFile(path.join(installed,relative),'personal-data-sentinel');
 }
 await fixture.install();
 for(const relative of ['data/scout/state.json','data/1688-session/cookies.json','config/sellersprite.local.toml']) assert.equal(await fs.readFile(path.join(installed,relative),'utf8'),'personal-data-sentinel');
 assert.equal((await fs.readdir(installed)).filter(x=>x.startsWith('app.previous.')).length,1);
 for(const relative of ['Start.cmd','Stop.cmd','Uninstall.cmd','control/scripts/Supervisor.ps1']) await fs.access(path.join(installed,relative));
});
test('offline install rejects modified payload before creating installation',{skip:!isWindows},async t=>{
 const fixture=await prepare(t);
 await fs.appendFile(path.join(fixture.pkg,'application/server.mjs'),'modified');
 await assert.rejects(fixture.install(),error=>/checksum failed/.test(error.stderr));
 await assert.rejects(fs.access(fixture.installed));
});
test('installer rejects path traversal in package manifest',{skip:!isWindows},async t=>{
 const fixture=await prepare(t);
 fixture.manifest.files.push({path:'application/../../escape.txt',sha256:'0'.repeat(64)});
 await fs.writeFile(path.join(fixture.pkg,'package-manifest.json'),JSON.stringify(fixture.manifest));
 await assert.rejects(fixture.install(),error=>/Invalid package file path/.test(error.stderr));
 await assert.rejects(fs.access(fixture.installed));
});
test('installer refuses to adopt unrelated populated directory',{skip:!isWindows},async t=>{
 const fixture=await prepare(t);
 await fs.mkdir(fixture.installed); await fs.writeFile(path.join(fixture.installed,'unrelated.txt'),'preserve');
 await assert.rejects(fixture.install(),error=>/identity is missing/.test(error.stderr));
 assert.equal(await fs.readFile(path.join(fixture.installed,'unrelated.txt'),'utf8'),'preserve');
});
test('supervisor restores isolated service after exit and makes only passive status requests',{skip:!isWindows,timeout:120000},async t=>{
 const fixture=await prepare(t); await fixture.install();
 const {installed}=fixture;
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});});
 const script=path.join(installed,'app/server.mjs');
 const endpoint=`http://127.0.0.1:${port}/api/version`;
 const requests=path.join(installed,'control/requests.txt');
 await fs.writeFile(script,`import http from 'node:http';import fs from 'node:fs';http.createServer((req,res)=>{fs.appendFileSync(${JSON.stringify(requests)},req.url+'\\n');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:{version:'fixture',pid:process.pid}}))}).listen(${port},'127.0.0.1');`);
 const quote=value=>value.replaceAll("'","''");
 await fs.appendFile(path.join(installed,'control/scripts/Common.ps1'),`\r\nfunction Get-ServiceDefinitions([string]$Root) { @(@{name='scout';port=${port};path='${quote(script)}';endpoint='${endpoint}'}) }\r\n`);
 await fs.writeFile(path.join(installed,'control/enabled'),'enabled');
 let fixturePid;
 t.after(async()=>{if(fixturePid) {try{process.kill(fixturePid);}catch{}}});
 const supervisor=()=>ps(path.join(installed,'control/scripts/Supervisor.ps1'),['-InstallRoot',installed,'-Once']);
 await supervisor();
 const readRuntime=async()=>{for(let n=0;n<30;n++){try {return await (await fetch(endpoint)).json();}catch{await new Promise(r=>setTimeout(r,100));}}throw Error('fixture did not start');};
 const initial=await readRuntime(); fixturePid=initial.data.pid;
 await supervisor();
 let status=JSON.parse(await fs.readFile(path.join(installed,'logs/supervisor-status.json'),'utf8'));
 assert.equal(status.services[0].status,'running');
 process.kill(fixturePid);
 await new Promise(r=>setTimeout(r,400));
 await supervisor();
 const recovered=await readRuntime(); fixturePid=recovered.data.pid;
 assert.notEqual(recovered.data.pid,initial.data.pid);
 status=JSON.parse(await fs.readFile(path.join(installed,'logs/supervisor-status.json'),'utf8'));
 assert.equal(status.services[0].status,'started_from_saved_state');
 const called=(await fs.readFile(requests,'utf8')).trim().split('\n');
 assert(called.length>=3);
 assert(called.every(x=>['/api/version','/api/amazon/collection'].includes(x)));
 process.kill(fixturePid); fixturePid=null;
 await new Promise(r=>setTimeout(r,200));
});

test('installer refuses a junction inside an existing installation',{skip:!isWindows},async t=>{
 const fixture=await prepare(t); await fixture.install();
 const external=path.join(fixture.temp,'outside'); await fs.mkdir(external);
 const config=path.join(fixture.installed,'config');
 await fs.rename(config,path.join(fixture.installed,'config.saved'));
 await fs.symlink(external,config,'junction');
 await assert.rejects(fixture.install(),error=>/reparse points/.test(error.stderr));
 assert.deepEqual(await fs.readdir(external),[]);
 await fs.unlink(config);
});

async function mockStopEnvironment(fixture,{queued=0,manual=false,busyAfterDrain=false}={}){
 const root=fixture.installed, quote=value=>value.replaceAll("'","''");
 const log=path.join(root,'control/stop-actions.txt');
 const script=`
$script:fixtureDraining = $false
function Assert-ServicePortsAvailable([string]$Root) {}
function Get-OwnedServiceProcesses([string]$Root,[string]$Script) { @(@{ProcessId=777777}) }
function Get-OwnedSupervisorProcesses([string]$Root) { @() }
function Invoke-RestMethod($Uri,$Method,$TimeoutSec,$Headers,$ContentType,$Body) {
 Add-Content -LiteralPath '${quote(log)}' -Value ($Method + ' ' + $Uri)
 if ($Uri -like '*/api/runtime/drain') { $script:fixtureDraining=$true; return @{ok=$true;data=@{draining=$true}} }
 if ($Uri -like '*/api/version') { return @{ok=$true;data=@{version='fixture';draining=$script:fixtureDraining;activeSearchRequests=0;activeAmazonRequests=$(if ($script:fixtureDraining -and $${busyAfterDrain}) {1} else {0});active1688Requests=0}} }
 if ($Uri -like '*/api/v1/runtime') { return @{ok=$true;product='1688-procurement-assistant';queue=@{running=0;waitingLogin=$false;queued=${queued};ratePolicy=@{manualResumeRequired=$${manual}}}} }
 return @{ok=$true;data=$null}
}
function Stop-Process($Id,$ErrorAction) { if(-not $script:fixtureDraining) { throw 'Stop attempted before drain' }; Add-Content -LiteralPath '${quote(log)}' -Value ('STOP ' + $Id) }
`;
 await fs.appendFile(path.join(root,'control/scripts/Common.ps1'),script);
 await fs.writeFile(path.join(root,'control/enabled'),'enabled');
 return {log,stop:()=>ps(path.join(root,'control/scripts/Stop.ps1'),['-InstallRoot',root])};
}
test('stop drains Scout and verifies idle before stopping only managed services',{skip:!isWindows},async t=>{
 const fixture=await prepare(t);await fixture.install();
 const mock=await mockStopEnvironment(fixture,{queued:1,manual:true});await mock.stop();
 const log=await fs.readFile(mock.log,'utf8');
 assert(log.indexOf('Post http://127.0.0.1:4173/api/runtime/drain') < log.indexOf('STOP'));
 await assert.rejects(fs.access(path.join(fixture.installed,'control/enabled')));
 assert.equal(log.match(/STOP/g)?.length,2);
});
test('stop refuses runnable bridge queue and leaves recovery enabled',{skip:!isWindows},async t=>{
 const fixture=await prepare(t);await fixture.install();
 const mock=await mockStopEnvironment(fixture,{queued:1});
 await assert.rejects(mock.stop(),error=>/runnable queued tasks/.test(error.stderr));
 const log=await fs.readFile(mock.log,'utf8');assert(!log.includes('STOP'));assert(!log.includes('/api/runtime/drain'));
 await fs.access(path.join(fixture.installed,'control/enabled'));
});
test('stop preserves services when a request appears while draining',{skip:!isWindows},async t=>{
 const fixture=await prepare(t);await fixture.install();
 const mock=await mockStopEnvironment(fixture,{busyAfterDrain:true});
 await assert.rejects(mock.stop(),error=>/not idle after draining/.test(error.stderr));
 assert(!(await fs.readFile(mock.log,'utf8')).includes('STOP'));
 await fs.access(path.join(fixture.installed,'control/enabled'));
});
test('start refuses a foreign port owner without changing it',{skip:!isWindows},async t=>{
 const fixture=await prepare(t);await fixture.install();
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port;
 const quote=value=>value.replaceAll("'","''");
 await fs.appendFile(path.join(fixture.installed,'control/scripts/Common.ps1'),`\nfunction Get-ServiceDefinitions([string]$Root) { @(@{name='scout';port=${port};path='${quote(path.join(fixture.installed,'app/server.mjs'))}';endpoint='http://127.0.0.1:${port}/api/version'}) }\n`);
 await assert.rejects(ps(path.join(fixture.installed,'control/scripts/Start.ps1'),['-InstallRoot',fixture.installed,'-NoBrowser']),error=>/another application or installation/.test(error.stderr));
 assert(server.listening);await assert.rejects(fs.access(path.join(fixture.installed,'control/enabled')));
});

test('deep payload files install and upgrade beyond 260 characters in Chinese and space paths',{skip:!isWindows},async t=>{
 const fixture=await prepare(t,{nestedPackage:'资料包 ' + 'p'.repeat(40),nestedInstall:'安装目录 中文 ' + 'i'.repeat(40)});
 const relative='application/1688-dependencies/1688-image-finder/node_modules/playwright-core/lib/tools/skills/playwright-component-testing/references/gallery-spec.md';
 const source=path.join(fixture.pkg,relative);
 const target=path.join(fixture.installed,'app',relative.slice(12));
 assert(source.length>260,`expected long source, got ${source.length}`);
 assert(target.length>260,`expected long destination, got ${target.length}`);
 await fs.mkdir(path.dirname(source),{recursive:true});
 const content=Buffer.from('long-path fixture — payload preserved');await fs.writeFile(source,content);
 fixture.manifest.files.push({path:relative,sha256:crypto.createHash('sha256').update(content).digest('hex')});
 await fs.writeFile(path.join(fixture.pkg,'package-manifest.json'),JSON.stringify(fixture.manifest));
 await fixture.install();assert.deepEqual(await fs.readFile(target),content);
 await fs.writeFile(path.join(fixture.installed,'data/scout/state.json'),'checkpoint preserved');
 await fixture.install();assert.deepEqual(await fs.readFile(target),content);
 assert.equal(await fs.readFile(path.join(fixture.installed,'data/scout/state.json'),'utf8'),'checkpoint preserved');
});


test('supervisor replaces a verified unresponsive Scout after three persisted checks without touching foreign services', {skip:!isWindows,timeout:120000}, async t => {
 const fixture = await prepare(t); await fixture.install();
 const {installed} = fixture;
 const port = await new Promise(resolve => { const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); });
 const script=path.join(installed,'app/server.mjs'), boot=path.join(installed,'control/boot-count.txt'), pidLog=path.join(installed,'control/test-pids.txt');
 await fs.writeFile(script, `import http from 'node:http';import fs from 'node:fs';const file=${JSON.stringify(boot)};fs.appendFileSync(${JSON.stringify(pidLog)},String(process.pid)+'\\n');const count=Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1;fs.writeFileSync(file,String(count));http.createServer((req,res)=>{if(count===1)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:req.url==='/api/version'?{version:'fixture',pid:process.pid,activeSearchRequests:0,active1688Requests:0}:null}));}).listen(${port},'127.0.0.1');`);
 const quote=value=>value.replaceAll("'","''");
 await fs.appendFile(path.join(installed,'control/scripts/Common.ps1'),`\nfunction Get-ServiceDefinitions([string]$Root) { @(@{name='scout';port=${port};path='${quote(script)}';endpoint='http://127.0.0.1:${port}/api/version'}) }\n`);
 await fs.writeFile(path.join(installed,'control/enabled'),'enabled');
 const supervisor=()=>ps(path.join(installed,'control/scripts/Supervisor.ps1'),['-InstallRoot',installed,'-Once']);
 try {
 await supervisor();
 for(let i=0;i<3;i++) await supervisor();
 await new Promise(resolve=>setTimeout(resolve,400));
 assert.equal(await fs.readFile(boot,'utf8'),'2');
 const state=JSON.parse(await fs.readFile(path.join(installed,'logs/supervisor-status.json'),'utf8'));
 assert.equal(state.services[0].status,'restarted_unresponsive_from_saved_state');
 const result=await fetch(`http://127.0.0.1:${port}/api/version`).then(r=>r.json());
 assert.equal(result.data.version,'fixture');
 } finally {
  for(const value of (await fs.readFile(pidLog,'utf8').catch(()=>'' )).trim().split(/\s+/)) { if(Number(value)>0) {try{process.kill(Number(value));}catch{}} }
  await new Promise(resolve=>setTimeout(resolve,300));
 }
});


test('supervisor preserves pause and cooldown, detects a stalled collection, and persists its restart budget', {skip:!isWindows,timeout:120000}, async t => {
 const fixture=await prepare(t); await fixture.install(); const {installed}=fixture;
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const script=path.join(installed,'app/server.mjs'), pidLog=path.join(installed,'control/pids.txt'), jobFile=path.join(installed,'control/job.json');
 const active={runId:'same-run',enabled:true,status:'running',phase:'details',workerActive:true,revision:1,lastProgressAt:'2026-01-01T00:00:00Z',discoveryComplete:true,counts:{processed:1,pending:1}};
 await fs.writeFile(jobFile,JSON.stringify(active));
 await fs.writeFile(script,`import http from 'node:http';import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(pidLog)},String(process.pid)+'\\n');http.createServer((req,res)=>{const job=JSON.parse(fs.readFileSync(${JSON.stringify(jobFile)},'utf8'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:req.url==='/api/version'?{version:'fixture',activeSearchRequests:1,activeAmazonRequests:1,active1688Requests:0}:req.url==='/api/amazon/collection'?job:null}));}).listen(${port},'127.0.0.1');`);
 const quote=v=>v.replaceAll("'","''");
 await fs.appendFile(path.join(installed,'control/scripts/Common.ps1'),`\nfunction Get-ServiceDefinitions([string]$Root) { @(@{name='scout';port=${port};path='${quote(script)}';endpoint='http://127.0.0.1:${port}/api/version'}) }\n`);
 await fs.writeFile(path.join(installed,'control/enabled'),'enabled');
 const supervise=()=>ps(path.join(installed,'control/scripts/Supervisor.ps1'),['-InstallRoot',installed,'-Once']);
 const stateFile=path.join(installed,'logs/supervisor-recovery.json');
 const seedStall=async()=>{await fs.writeFile(jobFile,JSON.stringify(active));await supervise();const state=JSON.parse(await fs.readFile(stateFile,'utf8'));state.probes.scout.observedSince=new Date(Date.now()-16*60_000).toISOString();await fs.writeFile(stateFile,JSON.stringify(state));};
 const pids=async()=>(await fs.readFile(pidLog,'utf8')).trim().split(/\s+/).map(Number);
 try {
  await supervise(); await new Promise(r=>setTimeout(r,200));
  for (const patch of [{status:'paused',enabled:false,causeCode:'USER_PAUSED'},{status:'needs_attention',causeCode:'AMAZON_ACCESS_CHALLENGE'},{status:'cooldown',nextRetryAt:new Date(Date.now()+3600_000).toISOString()},{runId:'new-run'},{lastProgressAt:new Date().toISOString()},{status:'completed'}]) {
    await seedStall();await fs.writeFile(jobFile,JSON.stringify({...active,...patch}));await supervise();assert.equal((await pids()).length,1,JSON.stringify(patch));
  }
  await seedStall();await supervise();await new Promise(r=>setTimeout(r,300));
  assert.equal((await pids()).length,2,'stalled task receives a new process');
  assert.deepEqual(JSON.parse(await fs.readFile(jobFile,'utf8')),active,'checkpoint untouched');
  for (const causeCode of ['EDGE_CDP_CLOSED','EDGE_CDP_CONNECT_TIMEOUT']) {
    active.causeCode=causeCode;
    const count=(await pids()).length;
    await seedStall();await supervise();await new Promise(r=>setTimeout(r,300));
    assert.equal((await pids()).length,count+1,'historical CDP network errors allow stalled recovery');
  }
  await seedStall();const state=JSON.parse(await fs.readFile(stateFile,'utf8'));state.attempts.scout=Array(5).fill(new Date().toISOString());await fs.writeFile(stateFile,JSON.stringify(state));await supervise();
  assert.equal((await pids()).length,4,'restart cap survives supervisor restart');
  const status=JSON.parse(await fs.readFile(path.join(installed,'logs/supervisor-status.json'),'utf8'));assert.equal(status.services[0].status,'restart_limit_reached');
 } finally { for (const pid of await pids().catch(()=>[])) {try{process.kill(pid);}catch{}} await new Promise(r=>setTimeout(r,300)); }
});
