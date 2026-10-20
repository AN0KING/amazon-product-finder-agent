import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const clientPath = fileURLToPath(new URL('../interfaces/Invoke-Scout.ps1', import.meta.url));
const spec = JSON.parse(await readFile(new URL('../interfaces/scout-local.openapi.json', import.meta.url), 'utf8'));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

test('WorkBuddy OpenAPI describes loopback reads and only explicit existing-task controls', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec.servers.map(item => item.url), ['http://127.0.0.1:4173']);
  const names = new Set();
  for (const [route, methods] of Object.entries(spec.paths)) {
    assert.ok(!/health|verify|connect|archive|image-search|\/start/.test(route), route);
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(!names.has(operation.operationId));
      names.add(operation.operationId);
      assert.ok(['get', 'post'].includes(method));
      if (method === 'post') {
        assert.equal(operation['x-scout-explicit-user-action'], true);
        assert.ok(route.endsWith('/control'));
        assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/TaskControl');
        assert.ok(operation.parameters.some(parameter => parameter.$ref === '#/components/parameters/Origin'));
      } else assert.equal(operation['x-scout-read-only'], true);
    }
  }
  assert.deepEqual(spec.components.schemas.TaskControl.properties.action.enum, ['pause', 'resume']);
  assert.deepEqual(spec.components.schemas.TaskControl.required, ['runId', 'action']);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'));
      const resolved = value.$ref.slice(2).split('/').reduce((result, key) => result?.[key], spec);
      assert.ok(resolved, `Unresolved reference ${value.$ref}`);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(spec);
});

// Invoke-RestMethod is replaced before the client executes. These tests never
// use a real HTTP server, the user's service, a provider, or a business task.
async function mockClient(args, { runId = 'example-run', noTask = false, failedRead = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scout-workbuddy-client-'));
  const log = path.join(directory, 'requests.jsonl');
  const wrapper = path.join(directory, 'mock.ps1');
  try {
    const operation = args[args.indexOf('-Operation') + 1];
    const parameters = [`Operation = ${quote(operation)}`];
    if (args.includes('-RunId')) parameters.push(`RunId = ${quote(args[args.indexOf('-RunId') + 1])}`);
    if (args.includes('-Confirmed')) parameters.push('Confirmed = $true');
    await writeFile(wrapper, `
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
function Invoke-RestMethod {
  param($Uri, $Method, $Headers, $TimeoutSec, $MaximumRedirection, $ErrorAction, $ContentType, $Body)
  if (-not ([string]$Uri).StartsWith('http://127.0.0.1:4173/api/')) { throw 'Unexpected URL' }
  $payload = if ($Body) { [Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json } else { $null }
  $entry = @{ uri = $Uri; method = $Method; origin = $Headers.Origin; timeout = $TimeoutSec; redirects = $MaximumRedirection; body = $payload }
  [IO.File]::AppendAllText(${quote(log)}, ($entry | ConvertTo-Json -Compress) + [Environment]::NewLine)
  ${failedRead ? "throw 'Synthetic failure; no network performed'" : ''}
  $data = ${noTask ? '$null' : `@{ runId = ${quote(runId)}; status = 'paused' }`}
  return (@{ ok = $true; data = $data } | ConvertTo-Json -Compress | ConvertFrom-Json)
}
$clientArgs = @{ ${parameters.join('; ')} }
& ${quote(clientPath)} @clientArgs
exit $LASTEXITCODE
`, 'utf8');
    let result;
    try {
      const output = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { windowsHide: true, timeout: 15000 });
      result = { ...output, code: 0 };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    const calls = await readFile(log, 'utf8').then(text => text.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse), error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    return { code: result.code, reply: JSON.parse(result.stdout.trim()), calls };
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('scout-workbuddy-client-'));
    await rm(directory, { recursive: true, force: true });
  }
}
const windows = { skip: process.platform !== 'win32', timeout: 20000 };

test('status is one-shot, uses only safe GET endpoints, and disables redirects', windows, async () => {
  const result = await mockClient(['-Operation', 'Status']);
  assert.equal(result.code, 0);
  assert.equal(result.reply.ok, true);
  assert.deepEqual(result.calls.map(item => new URL(item.uri).pathname), [
    '/api/version', '/api/amazon/collection', '/api/1688/pipeline', '/api/monitor', '/api/sellsprite/status',
  ]);
  for (const call of result.calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.origin, 'http://127.0.0.1:4173');
    assert.equal(call.redirects, 0);
    assert.equal(call.timeout, 15);
    assert.equal(call.body, null);
  }
});

test('pause requires user acknowledgement before any request', windows, async () => {
  const result = await mockClient(['-Operation', 'PauseAmazon', '-RunId', 'example-run']);
  assert.equal(result.code, 1);
  assert.equal(result.reply.error.code, 'USER_CONFIRMATION_REQUIRED');
  assert.deepEqual(result.calls, []);
});

test('resume rejects invalid runId before any request', windows, async () => {
  const result = await mockClient(['-Operation', 'Resume1688', '-RunId', '../../other', '-Confirmed']);
  assert.equal(result.reply.error.code, 'RUN_ID_REQUIRED');
  assert.deepEqual(result.calls, []);
});

for (const options of [{ runId: 'different-run' }, { noTask: true }]) {
  test(`control never starts or switches a missing/currently different task (${JSON.stringify(options)})`, windows, async () => {
    const result = await mockClient(['-Operation', 'ResumeAmazon', '-RunId', 'example-run', '-Confirmed'], options);
    assert.equal(result.code, 1);
    assert.equal(result.reply.error.code, 'CURRENT_RUN_MISMATCH');
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].method, 'GET');
  });
}

for (const [operation, route, action] of [
  ['PauseAmazon', '/api/amazon/collection', 'pause'],
  ['ResumeAmazon', '/api/amazon/collection', 'resume'],
  ['Pause1688', '/api/1688/pipeline', 'pause'],
  ['Resume1688', '/api/1688/pipeline', 'resume'],
]) {
  test(`${operation} validates current run then sends one exact control request`, windows, async () => {
    const result = await mockClient(['-Operation', operation, '-RunId', 'example-run', '-Confirmed']);
    assert.equal(result.code, 0);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.calls.map(item => [new URL(item.uri).pathname, item.method]), [[route, 'GET'], [route + '/control', 'POST']]);
    assert.deepEqual(result.calls[1].body, { runId: 'example-run', action });
  });
}

test('a failed status check is not retried or converted into a resume', windows, async () => {
  const result = await mockClient(['-Operation', 'Resume1688', '-RunId', 'example-run', '-Confirmed'], { failedRead: true });
  assert.equal(result.code, 1);
  assert.equal(result.reply.error.code, 'LOCAL_API_REQUEST_FAILED');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].method, 'GET');
});
