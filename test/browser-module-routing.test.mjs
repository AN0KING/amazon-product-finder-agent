import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const listener = createTcpServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  assert.ok(![4173, 16880].includes(port));
  return port;
}

function get(origin, endpoint) {
  const url = new URL(endpoint, origin);
  assert.equal(url.origin, origin);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(!['4173', '16880'].includes(url.port));
  assert.ok(url.pathname === '/api/version' || !url.pathname.startsWith('/api/'));
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', headers: { Connection: 'close', Origin: origin } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode,
        type: response.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Isolated static-module request timed out')));
    request.end();
  });
}

function moduleDependencies(source) {
  // Parse real ECMAScript imports and re-exports, including multiline forms.
  // Construction does not link or evaluate the source or any browser code.
  const parser = `import { SourceTextModule } from 'node:vm';
    import { readFileSync } from 'node:fs';
    process.stdout.write(JSON.stringify(new SourceTextModule(readFileSync(0, 'utf8')).dependencySpecifiers));`;
  return JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', parser], {
    input: source, encoding: 'utf8', windowsHide: true, timeout: 5000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

test('the app and every transitive browser import are served as JavaScript while private modules stay inaccessible', { timeout: 20000 }, async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'scout-browser-module-routing-'));
  const guardPath = path.join(temporaryRoot, 'deny-outbound.mjs');
  const deniedLog = path.join(temporaryRoot, 'denied.log');
  const configPath = path.join(temporaryRoot, 'empty-config.toml');
  let child, exited;
  t.after(async () => {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        let timer;
        try {
          await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test service did not stop')), 5000); })]);
        } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
        finally { clearTimeout(timer); }
      }
      assert.equal(await readFile(deniedLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '',
        'Static module requests must not invoke any external provider, socket or process.');
    } finally {
      assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith('scout-browser-module-routing-'));
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
  await writeFile(configPath, '[mcp_servers]\n');
  await writeFile(guardPath, `
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const deny = kind => { appendFileSync(process.env.SCOUT_TEST_DENIED_LOG, kind + '\\n'); throw new Error('Unexpected outbound operation'); };
net.Socket.prototype.connect = () => deny('socket');
tls.connect = () => deny('tls');
globalThis.fetch = async () => deny('fetch');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = () => deny('process');
syncBuiltinESMExports();
`);
  const origin = `http://127.0.0.1:${await freePort()}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CODEX|OPENAI|CHATGPT|SELLERSPRITE|SCOUT_)/i.test(name)));
  Object.assign(env, { SCOUT_MONITOR_ENABLED: '0', SCOUT_PORT: new URL(origin).port,
    SCOUT_DATA_DIR: path.join(temporaryRoot, 'service-state'), SCOUT_SELLERSPRITE_CONFIG_PATH: configPath, SCOUT_TEST_DENIED_LOG: deniedLog });
  child = spawn(process.execPath, ['--import', pathToFileURL(guardPath).href, path.join(projectRoot, 'server.mjs')], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let output = '', spawnError;
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.once('error', error => { spawnError = error; });
  let ready = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated service exited: ${output}`);
    try { ready = (await get(origin, '/api/version')).status === 200; if (ready) break; }
    catch (error) { if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error; }
    await delay(25);
  }
  assert.equal(ready, true, output);

  const modules = new Set();
  const pending = [new URL('/app.js', origin).href];
  while (pending.length) {
    const url = pending.shift();
    if (modules.has(url)) continue;
    const response = await get(origin, url);
    assert.equal(response.status, 200, `Browser module ${url} must have an explicit static route.`);
    assert.match(response.type, /^(?:text|application)\/javascript(?:\s*;|$)/i, `Wrong JavaScript MIME for ${url}`);
    modules.add(url);
    for (const specifier of moduleDependencies(response.body)) {
      assert.match(specifier, /^\.{1,2}\//, `Browser import ${specifier} in ${url} must resolve locally.`);
      const dependency = new URL(specifier, url);
      assert.equal(dependency.origin, origin);
      pending.push(dependency.href);
    }
  }
  assert.ok(modules.has(new URL('/lib/amazon-listing-date.mjs', origin).href), 'The new shared date module must be reachable.');
  assert.ok(modules.has(new URL('/lib/amazon-sales-policy.mjs', origin).href), 'Traversal must include indirect imports, not only app.js imports.');

  for (const endpoint of ['/server.mjs', '/lib/persistence-store.mjs', '/lib/amazon-store-client.mjs', '/lib/sellsprite-client.mjs']) {
    const response = await get(origin, endpoint);
    assert.equal(response.status, 404, `Private module ${endpoint} must stay outside the static allowlist.`);
    assert.doesNotMatch(response.type, /(?:text|application)\/javascript/i);
  }
});
