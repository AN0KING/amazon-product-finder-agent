import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ImageSearchRatePolicy, classifySearchFailure } from '../lib/image-search-rate-policy.mjs';

// Evaluate bridge functions with all external session/browser dependencies mocked.
// Never import the executable server or open its production state / HTTP port.
const original = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-bridge-test-'));
  let calls = 0;
  let verifies = 0;
  let spawns = 0;
  let dispatchImpl = async () => ({ offers: [] });
  let clock = Date.now();
  const spawned = [];
  const context = vm.createContext({
    crypto, fsp: fs, path, Buffer, URL, setTimeout, clearTimeout, fileURLToPath, pathToFileURL, StringDecoder,
    serverUrl: pathToFileURL(path.join(dir, 'server.mjs')).href,
    process: { env: {}, pid: process.pid, execPath: process.execPath, stdout: { write: () => true } },
    ImageSearchRatePolicy: class extends ImageSearchRatePolicy { constructor(options) { super({ ...options, now: () => clock }); } },
    classifySearchFailure,
    readState: async () => ({ version: 1, memberId: 'cached-account', nick: 'cached-name' }),
    writeState: async () => {}, parseIdentity: () => ({ memberId: 'cached-account' }),
    verifyOnlineStatus: async () => { verifies++; return { ok: true }; },
    withSession: async (_options, callback) => callback({ cookies: async () => [] }),
    dispatch: async (...args) => { calls++; return dispatchImpl(...args); },
    CliError: Error, detectProcurementImageType: () => null,
    spawn: () => {
      spawns++;
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); };
      spawned.push(child); return child;
    },
  });
  let source = original.replace(/^import .*;\r?\n/gm, '')
    .replace(/const \[\{ withSession \}[\s\S]*?\r?\n  \]\);/, '')
    .replaceAll('import.meta.url', 'serverUrl')
    .replace('const LOGIN_READY_TIMEOUT_MS = 40_000;', 'const LOGIN_READY_TIMEOUT_MS = 10;');
  source = source.slice(0, source.lastIndexOf('\nmain().catch'));
  source += `\nglobalThis.api = { tasks, taskQueue, searchPolicy, auth, pumpQueue, executeTask, applyTaskError,
    publicTask, publicAuth, queueSummary, handleRequest, handleConfirmTask, handleResumeQueue, openLogin,
    spawnLoginChild, loginChildAlive, loadTasksFromDisk, healthPayload,
    ready: () => { queueReady = true; }, child: () => loginChild,
    flush: async () => { await logWriteQueue; }, cleanup: () => { cancelQueueWake(); queueReady = false; } };`;
  vm.runInContext(source, context, { filename: 'bridge-isolated-test.mjs' });
  const api = context.api;
  await fs.mkdir(path.join(dir, 'data', 'sourcing-console', 'runtime-cache', 'login-handshakes'), { recursive: true });
  await api.searchPolicy.initialize();
  api.auth.memberId = 'cached-account'; api.auth.nick = 'cached-name'; api.auth.ready = true;
  t.after(async () => { api.cleanup(); await api.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  return { ...api, dir, spawned,
    logText: async () => { await api.flush(); return fs.readFile(path.join(dir, 'data', 'sourcing-console', 'logs', 'service.log'), 'utf8'); },
    counts: () => ({ calls, verifies, spawns }),
    dispatch: impl => { dispatchImpl = impl; }, advance: ms => { clock += ms; },
    get: async url => {
      let status, body;
      await api.handleRequest({ method: 'GET', url }, { writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } });
      return { status, body };
    },
  };
}

function task(id, status = 'queued') {
  return { id, status, title: id, fileName: `${id}.png`, queueSequence: 1,
    imageFile: '/mock/image.png', mimeType: 'image/png', imageSha256: 'mock', failure: null, candidates: [] };
}
const confirm = { confirmed: true, sellingPrice: null, sellingPriceCurrency: 'USD', targetQuantity: 1 };

test('health and normal runtime GET are pure reads even with old risk tasks', async t => {
  const h = await harness(t);
  const risk = task('risk', 'risk_blocked'); h.tasks.set(risk.id, risk);
  const before = JSON.stringify(risk);
  await h.get('/api/v1/health'); await h.get('/api/v1/runtime');
  assert.deepEqual(h.counts(), { calls: 0, verifies: 0, spawns: 0 });
  assert.equal(JSON.stringify(risk), before);
  assert.equal(h.queueSummary().riskAutoRetryAt, null);
  assert.equal(h.healthPayload().capabilities.manualRiskResume, true);
});

test('explicit verify remains cached throughout manual pause and regular cooldown', async t => {
  const h = await harness(t);
  await h.searchPolicy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  h.advance(30 * 24 * 60 * 60_000);
  const paused = await h.get('/api/v1/runtime?verify=1');
  assert.equal(paused.body.auth.memberId, 'cached-account');
  assert.equal(paused.body.queue.ratePolicy.manualResumeRequired, true);
  assert.equal(h.counts().verifies, 0);
  await h.searchPolicy.markManualVerification({ purpose: 'image_search' });
  await h.searchPolicy.resume({ confirmed: true });
  await h.get('/api/v1/runtime?verify=1');
  assert.equal(h.counts().verifies, 0);
  h.advance(90_000);
  await h.get('/api/v1/runtime?verify=1');
  assert.equal(h.counts().verifies, 1);
});

test('one risk result stops all subsequent queued tasks without a wake timer retry', async t => {
  const h = await harness(t);
  for (const id of ['first', 'second']) { h.tasks.set(id, task(id)); h.taskQueue.push(id); }
  h.dispatch(async () => { throw Object.assign(new Error('请完成滑块验证'), { code: 'RISK_CONTROL' }); });
  h.ready(); await h.pumpQueue();
  assert.equal(h.counts().calls, 1);
  assert.equal(h.tasks.get('first').status, 'risk_blocked');
  assert.equal(h.tasks.get('second').status, 'queued');
  h.advance(30 * 24 * 60 * 60_000);
  await h.pumpQueue();
  assert.equal(h.counts().calls, 1);
  assert.equal(h.queueSummary().ratePolicy.manualResumeRequired, true);
});

test('queued/running/risk confirmation is idempotent and cannot erase a challenge', async t => {
  const h = await harness(t);
  for (const status of ['queued', 'running', 'risk_blocked']) {
    const item = task(status, status); item.failure = { code: 'existing' }; h.tasks.set(status, item);
    const before = JSON.stringify(item);
    await h.handleConfirmTask(status, confirm);
    assert.equal(JSON.stringify(item), before);
  }
  assert.equal(h.taskQueue.length, 0);
  assert.equal(h.counts().calls, 0);
});

test('a successful search never requeues another risk task', async t => {
  const h = await harness(t);
  h.tasks.set('risk', task('risk', 'risk_blocked')); h.tasks.set('okay', task('okay'));
  await h.executeTask('okay');
  assert.equal(h.tasks.get('okay').status, 'review_candidates');
  assert.equal(h.tasks.get('risk').status, 'risk_blocked');
  assert.equal(h.taskQueue.length, 0);
});

test('explicit resume refuses missing proof, then requeues only after confirmation with pacing intact', async t => {
  const h = await harness(t);
  h.tasks.set('risk', task('risk', 'risk_blocked'));
  await h.searchPolicy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  await assert.rejects(h.handleResumeQueue({}), { code: 'RESUME_CONFIRMATION_REQUIRED' });
  await assert.rejects(h.handleResumeQueue({ confirmed: true }), { code: 'MANUAL_VERIFICATION_REQUIRED' });
  await h.searchPolicy.markManualVerification({ purpose: 'image_search' });
  assert.equal(h.tasks.get('risk').status, 'risk_blocked');
  const result = await h.handleResumeQueue({ confirmed: true });
  assert.equal(result.queue.ratePolicy.manualResumeRequired, false);
  assert.equal(h.tasks.get('risk').status, 'queued');
  assert.equal(h.counts().calls, 0);
  assert.equal(h.searchPolicy.waitMs(), 30_000);
});

test('429 enters a shared persisted cooldown and bounded retry instead of a manual pause', async t => {
  const h = await harness(t); const item = task('rate'); h.tasks.set(item.id, item);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await h.applyTaskError(item, { code: 'RATE_LIMITED', retryAfter: '600' });
    assert.equal(item.status, attempt < 3 ? 'queued' : 'failed');
    assert.equal(h.searchPolicy.waitMs(), 600_000);
    assert.equal(h.searchPolicy.view().manualResumeRequired, false);
  }
});

test('a slow live login window returns pending, preserves identity and is reused', async t => {
  const h = await harness(t);
  const first = await h.openLogin({ restart: false, purpose: 'login', taskId: null });
  const entry = h.child();
  assert.equal(first.pending, true); assert.equal(first.auth.memberId, 'cached-account');
  assert.equal(h.loginChildAlive(), true);
  await fs.writeFile(entry.readyPath, 'ready');
  const second = await h.openLogin({ restart: false, purpose: 'login', taskId: null });
  assert.equal(second.edgeReady, true); assert.equal(second.alreadyRunning, true);
  assert.equal(h.counts().spawns, 1);
  assert.equal(h.child(), entry);
});

test('successful manual verification child exit records proof without resuming any task', async t => {
  const h = await harness(t);
  h.tasks.set('risk', task('risk', 'risk_blocked'));
  await h.searchPolicy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  const entry = h.spawnLoginChild({ purpose: 'image_search', taskId: 'risk' });
  entry.child.exitCode = 0; entry.child.emit('exit', 0, null);
  for (let i = 0; i < 100 && !h.searchPolicy.view().manualVerificationCompletedAt; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(h.searchPolicy.view().manualVerificationCompletedAt);
  assert.equal(h.searchPolicy.view().manualResumeRequired, true);
  assert.equal(h.tasks.get('risk').status, 'risk_blocked');
  assert.equal(h.counts().calls, 0);
});

test('startup task loading only queues data, before initializing policy from historic risk', async t => {
  const h = await harness(t);
  const taskDir = path.join(h.dir, 'data', 'sourcing-console', 'tasks');
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'queued.json'), JSON.stringify(task('queued')));
  await fs.writeFile(path.join(taskDir, 'risk.json'), JSON.stringify(task('risk', 'risk_blocked')));
  await h.loadTasksFromDisk();
  assert.equal(h.counts().calls, 0);
  await h.searchPolicy.initialize([...h.tasks.values()]);
  h.ready(); await h.pumpQueue();
  assert.equal(h.counts().calls, 0);
  assert.equal(h.searchPolicy.view().manualResumeRequired, true);
});

test('whitelisted image verification phases stream across chunk boundaries without forwarding other stderr', async t => {
  const h = await harness(t);
  h.tasks.set('risk', task('risk', 'risk_blocked'));
  await h.searchPolicy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  const entry = h.spawnLoginChild({ purpose: 'image_search', taskId: 'risk' });
  entry.child.stderr.emit('data', Buffer.from('[image-search-verifi'));
  entry.child.stderr.emit('data', Buffer.from('cation] waiting_upload_page'));
  assert.equal(h.publicAuth().imageSearchPhase, null);
  entry.child.stderr.emit('data', Buffer.from('\r\nprivate-cookie=secret-do-not-log\n[image-search-verification] unknown_phase\n'));
  assert.equal(h.publicAuth().imageSearchPhase, 'waiting_upload_page');
  for (const phase of ['upload_control_ready', 'image_selected_waiting_result', 'waiting_manual_verification', 'verified_result']) {
    entry.child.stderr.emit('data', Buffer.from(`[image-search-verification] ${phase}\n`));
    assert.equal(h.publicAuth().imageSearchPhase, phase);
  }
  entry.child.stderr.emit('data', Buffer.from('[image-search-verification] verified_result\n'));
  const log = await h.logText();
  assert.equal((log.match(/\[image-search-verification\]/g) || []).length, 5);
  assert.doesNotMatch(log, /private-cookie|secret-do-not-log|unknown_phase/);
  assert.equal(h.searchPolicy.view().manualResumeRequired, true);
  assert.equal(h.searchPolicy.view().manualVerificationCompletedAt, null);
});

test('stderr stage buffering is bounded and recovers after an oversized line', async t => {
  const h = await harness(t);
  h.tasks.set('risk', task('risk', 'risk_blocked'));
  const entry = h.spawnLoginChild({ purpose: 'image_search', taskId: 'risk' });
  entry.child.stderr.emit('data', Buffer.from('private-large-line'.repeat(10_000)));
  assert.ok(entry.stderrTail.length <= 4000);
  assert.ok(entry.stderrLine.length <= 256);
  entry.child.stderr.emit('data', Buffer.from('[image-search-verification] verified_result\n'));
  assert.equal(h.publicAuth().imageSearchPhase, null);
  entry.child.stderr.emit('data', Buffer.from('[image-search-verification] waiting_manual_verification'));
  entry.child.stderr.emit('end');
  assert.equal(h.publicAuth().imageSearchPhase, 'waiting_manual_verification');
  const log = await h.logText();
  assert.match(log, /waiting_manual_verification/);
  assert.doesNotMatch(log, /private-large-line|verified_result/);
});

test('failure exposes only a bounded parsed code and message, preserving UTF-8 split chunks and queue pause', async t => {
  const h = await harness(t);
  h.tasks.set('risk', task('risk', 'risk_blocked'));
  await h.searchPolicy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  const entry = h.spawnLoginChild({ purpose: 'image_search', taskId: 'risk' });
  const message = `请完成验证${'。'.repeat(350)}`;
  const output = Buffer.from(`${JSON.stringify({ ok: false, code: 'IMAGE_SEARCH_TIMEOUT', message, details: { cookie: 'private-error-details' } })}\n`);
  for (const byte of output) entry.child.stderr.emit('data', Buffer.from([byte]));
  entry.child.stderr.emit('end');
  entry.child.exitCode = 1; entry.child.emit('exit', 1, null); entry.child.emit('close', 1, null);
  const auth = h.publicAuth();
  assert.equal(auth.imageSearchPhase, null);
  assert.deepEqual(Object.keys(auth.lastWindowError).sort(), ['code', 'message']);
  assert.equal(auth.lastWindowError.code, 'IMAGE_SEARCH_TIMEOUT');
  assert.equal(auth.lastWindowError.message.length, 300);
  assert.match(auth.lastWindowError.message, /^请完成验证/);
  assert.equal(auth.memberId, 'cached-account');
  assert.equal(h.searchPolicy.view().manualResumeRequired, true);
  assert.doesNotMatch(await h.logText(), /private-error-details|请完成验证/);
});

test('late stderr after exit updates the current error at close, then a new launch clears it', async t => {
  const h = await harness(t);
  const failed = h.spawnLoginChild({ purpose: 'login' });
  failed.child.exitCode = 1; failed.child.emit('exit', 1, null);
  failed.child.stderr.emit('data', Buffer.from('{"ok":false,"code":"WINDOW_NOT_VISIBLE","message":"窗口未出现","details":{"secret":"omit-me"}}\n'));
  failed.child.stderr.emit('end'); failed.child.emit('close', 1, null);
  assert.equal(h.publicAuth().lastWindowError.code, 'WINDOW_NOT_VISIBLE');
  const current = h.spawnLoginChild({ purpose: 'login' });
  assert.equal(h.publicAuth().lastWindowError, null);
  current.child.exitCode = 0; current.child.emit('exit', 0, null); current.child.emit('close', 0, null);
  assert.equal(h.publicAuth().lastWindowError, null);
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('canceled stale attempts cannot replace a new phase or error or prove manual verification', async t => {
  const h = await harness(t);
  h.tasks.set('risk', task('risk', 'risk_blocked'));
  await h.searchPolicy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  const old = h.spawnLoginChild({ purpose: 'image_search', taskId: 'risk' });
  old.canceled = true;
  const current = h.spawnLoginChild({ purpose: 'image_search', taskId: 'risk' });
  current.child.stderr.emit('data', Buffer.from('[image-search-verification] waiting_upload_page\n'));
  old.child.stderr.emit('data', Buffer.from('[image-search-verification] verified_result\n{"ok":false,"code":"OLD_ERROR","message":"stale failure"}\n'));
  old.child.emit('error', new Error('stale process error'));
  old.child.exitCode = 0; old.child.emit('exit', 0, null); old.child.emit('close', 1, null);
  assert.equal(h.publicAuth().imageSearchPhase, 'waiting_upload_page');
  assert.equal(h.publicAuth().lastWindowError, null);
  assert.equal(h.child(), current);
  assert.equal(h.searchPolicy.view().manualResumeRequired, true);
  assert.equal(h.searchPolicy.view().manualVerificationCompletedAt, null);
  assert.doesNotMatch(await h.logText(), /\[image-search-verification\] verified_result/);
});
