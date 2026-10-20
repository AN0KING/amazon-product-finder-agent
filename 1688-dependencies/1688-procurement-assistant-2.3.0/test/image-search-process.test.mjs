import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { runImageSearchProcess, hasActiveSearchProcess } from '../lib/image-search-process.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-owned-worker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'dist', 'session'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(path.join(dir, 'dist', 'session', 'dispatch.js'), `
    import fs from 'node:fs/promises';
    import { spawn } from 'node:child_process';
    export async function dispatch(name, args, options) {
      if (name !== 'image-search' || options.headed || options.profile !== 'default') throw new Error('Bad invocation');
      if (args.imagePath === 'risk') throw Object.assign(new Error('manual verification required'), { code: 'RISK_CONTROL', details: { retryable: false } });
      if (args.imagePath === 'rate') throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED', retryAfter: 601, status: 429 });
      if (args.imagePath === 'exit') process.exit(12);
      if (args.max === 'hang-with-child') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
        await fs.writeFile(args.imagePath, JSON.stringify({ pid: process.pid, childPid: child.pid }));
        return new Promise(() => {});
      }
      for (const phase of ['validating_image', 'uploading_image', 'searching_offers', 'saving_candidates']) await args.onProgress({ phase });
      return { imageId: '123', offers: [{ offerId: '456' }] };
    }
  `);
  return dir;
}

test('real isolated worker returns candidates and whitelisted progress after exit', async t => {
  const dir = await fixture(t);
  const phases = [];
  const result = await runImageSearchProcess({ imageFinderRoot: dir, imagePath: 'success', max: 40,
    timeoutMs: 5000, onProgress: ({ phase }) => phases.push(phase) });
  assert.equal(result.offers[0].offerId, '456');
  assert.deepEqual(phases, ['validating_image', 'uploading_image', 'searching_offers', 'saving_candidates']);
  assert.equal(hasActiveSearchProcess(), false);
});

for (const [imagePath, code] of [['risk', 'RISK_CONTROL'], ['rate', 'RATE_LIMITED'], ['exit', 'SEARCH_WORKER_EXITED']]) {
  test(`worker preserves ${code} instead of disguising it as a generic timeout`, async t => {
    const dir = await fixture(t);
    await assert.rejects(runImageSearchProcess({ imageFinderRoot: dir, imagePath, max: 40, timeoutMs: 5000 }), error => {
      assert.equal(error.code, code);
      if (imagePath === 'rate') { assert.equal(error.retryAfter, 601); assert.equal(error.status, 429); }
      if (imagePath === 'risk') assert.equal(error.details.retryable, false);
      return true;
    });
    assert.equal(hasActiveSearchProcess(), false);
  });
}

test('deadline stops the owned process tree before reporting timeout and releasing the slot', async t => {
  const dir = await fixture(t);
  const pidsFile = path.join(dir, 'worker-pids.json');
  await assert.rejects(runImageSearchProcess({ imageFinderRoot: dir, imagePath: pidsFile,
    max: 'hang-with-child', timeoutMs: 1500 }), { code: 'SEARCH_TIMEOUT' });
  const pids = JSON.parse(await fs.readFile(pidsFile, 'utf8'));
  assert.throws(() => process.kill(pids.pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(pids.childPid, 0), { code: 'ESRCH' });
  assert.equal(hasActiveSearchProcess(), false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123; child.exitCode = null; child.signalCode = null; child.send = () => {};
  child.finish = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  return child;
}

test('a result cannot release a slot until the owned process actually exits', async () => {
  const child = fakeChild();
  let settled = false;
  const result = runImageSearchProcess({ spawnImpl: () => child, timeoutMs: 1000 }).then(value => { settled = true; return value; });
  child.emit('message', { type: 'result', ok: true, data: { offers: [] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false); assert.equal(hasActiveSearchProcess(), true);
  child.finish(); await result;
  assert.equal(hasActiveSearchProcess(), false);
});

test('a termination failure keeps the active-process guard until actual exit', async () => {
  const child = fakeChild();
  await assert.rejects(runImageSearchProcess({ spawnImpl: () => child, timeoutMs: 10,
    terminateImpl: async () => { throw new Error('access denied'); } }), { code: 'SEARCH_WORKER_STOP_FAILED' });
  assert.equal(hasActiveSearchProcess(), true);
  child.finish();
  assert.equal(hasActiveSearchProcess(), false);
});

test('a hanging terminator is bounded without claiming the worker stopped', async () => {
  const child = fakeChild();
  await assert.rejects(runImageSearchProcess({ spawnImpl: () => child, timeoutMs: 10, stopTimeoutMs: 10,
    terminateImpl: async () => new Promise(() => {}) }), { code: 'SEARCH_WORKER_STOP_FAILED' });
  assert.equal(hasActiveSearchProcess(), true);
  child.finish();
  assert.equal(hasActiveSearchProcess(), false);
});

test('a known verification failure remains a verification failure when worker exit hangs', async () => {
  const child = fakeChild();
  const work = runImageSearchProcess({ spawnImpl: () => child, timeoutMs: 10,
    terminateImpl: async () => child.finish() });
  child.emit('message', { type: 'result', ok: false, error: { code: 'RISK_CONTROL', message: 'complete manual verification' } });
  await assert.rejects(work, { code: 'RISK_CONTROL' });
  assert.equal(hasActiveSearchProcess(), false);
});

test('known challenge survives a failed worker-tree stop while the live guard stays set', async () => {
  const child = fakeChild();
  const work = runImageSearchProcess({ spawnImpl: () => child, timeoutMs: 10,
    terminateImpl: async () => { throw new Error('cannot terminate'); } });
  child.emit('message', { type: 'result', ok: false, error: { code: 'RISK_CONTROL', message: 'complete manual verification' } });
  await assert.rejects(work, error => error.code === 'RISK_CONTROL' && error.details.workerStopFailed === true);
  assert.equal(hasActiveSearchProcess(), true);
  child.finish();
});

test('a completed result survives a stuck exit after the owned process is confirmed stopped', async () => {
  const child = fakeChild();
  const work = runImageSearchProcess({ spawnImpl: () => child, timeoutMs: 10,
    terminateImpl: async () => child.finish() });
  child.emit('message', { type: 'result', ok: true, data: { offers: [{ offerId: 'saved' }] } });
  assert.equal((await work).offers[0].offerId, 'saved');
  assert.equal(hasActiveSearchProcess(), false);
});

test('worker and owned descendants stop when the bridge parent disappears', async t => {
  const dir = await fixture(t);
  const pidsFile = path.join(dir, 'orphan-pids.json');
  const managerFile = path.join(dir, 'manager.mjs');
  await fs.writeFile(managerFile, `
    import { runImageSearchProcess } from ${JSON.stringify(new URL('../lib/image-search-process.mjs', import.meta.url).href)};
    await runImageSearchProcess({ imageFinderRoot: ${JSON.stringify(dir)}, imagePath: ${JSON.stringify(pidsFile)}, max: 'hang-with-child' });
  `);
  const manager = spawn(process.execPath, [managerFile], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (manager.exitCode === null && manager.signalCode === null) manager.kill(); });
  const deadline = Date.now() + 5000;
  let pids;
  while (Date.now() < deadline) {
    try { pids = JSON.parse(await fs.readFile(pidsFile, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(pids, 'test worker launched');
  manager.kill();
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (Date.now() < deadline && (alive(pids.pid) || alive(pids.childPid))) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(pids.pid), false);
  assert.equal(alive(pids.childPid), false);
});
