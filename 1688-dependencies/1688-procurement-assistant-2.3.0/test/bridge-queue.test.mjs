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
import { ImageSearchRatePolicy, classifySearchFailure, isSearchExecutionPause } from '../lib/image-search-rate-policy.mjs';
import { resolve1688RuntimePaths } from '../lib/runtime-paths.mjs';

// Evaluate bridge functions with all external session/browser dependencies mocked.
// Never import the executable server or open its production state / HTTP port.
const original = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-bridge-test-'));
  let calls = 0;
  let workerActive = false;
  let verifies = 0;
  let spawns = 0;
  let dispatchImpl = async () => ({ offers: [] });
  let writeFileImpl = (...args) => fs.writeFile(...args);
  let clock = Date.now();
  const spawned = [];
  const context = vm.createContext({
    crypto, fsp: { ...fs, writeFile: (...args) => writeFileImpl(...args) }, path, Buffer, URL, setTimeout, clearTimeout, fileURLToPath, pathToFileURL, StringDecoder,
    serverUrl: pathToFileURL(path.join(dir, 'server.mjs')).href,
    process: { env: {}, pid: process.pid, execPath: process.execPath, stdout: { write: () => true } },
    ImageSearchRatePolicy: class extends ImageSearchRatePolicy { constructor(options) { super({ ...options, now: () => clock }); } },
    classifySearchFailure, isSearchExecutionPause,
    resolve1688RuntimePaths: ({ projectRoot }) => resolve1688RuntimePaths({ projectRoot, env: {
      BB1688_IMAGE_FINDER_ROOT: path.join(dir, 'image-finder'),
      BB1688_HOME: path.join(dir, 'session'),
    } }),
    readState: async () => ({ version: 1, memberId: 'cached-account', nick: 'cached-name' }),
    writeState: async () => {}, parseIdentity: () => ({ memberId: 'cached-account' }),
    verifyOnlineStatus: async () => { verifies++; return { ok: true }; },
    withSession: async (_options, callback) => callback({ cookies: async () => [] }),
    hasActiveSearchProcess: () => workerActive,
    SEARCH_EXECUTION_TIMEOUT_MS: 180_000,
    runImageSearchProcess: async (...args) => { calls++; return dispatchImpl(...args); },
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
    publicTask, publicAuth, queueSummary, handleRequest, handleConfirmTask, handleResumeQueue, handleStartRateTrial, openLogin,
    spawnLoginChild, loginChildAlive, loadTasksFromDisk, preserveInterruptedSearchPause, healthPayload,
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
    workerActive: value => { workerActive = value; },
    dispatch: impl => { dispatchImpl = impl; }, advance: ms => { clock += ms; }, now: () => clock,
    writeFile: impl => { writeFileImpl = impl; },
    post: async (url, payload) => {
      let status, body;
      const request = new EventEmitter(); request.method = 'POST'; request.url = url;
      const work = api.handleRequest(request, { writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } });
      request.emit('data', Buffer.from(JSON.stringify(payload)));
      request.emit('end');
      await work;
      return { status, body };
    },
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
  assert.equal(h.searchPolicy.waitMs(), 60_000);
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

const rateTrialConfig = { confirmed: true, startPerHour: 90, stepPerHour: 10, stageDurationMs: 3_600_000 };

test('rate-trial API strictly validates the approved parameters without starting work', async t => {
  const h = await harness(t);
  const initial = await h.get('/api/v1/queue/rate-trial');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.ratePolicy.rateTrial, null);
  for (const payload of [null, [], {}, { confirmed: true },
    { ...rateTrialConfig, confirmed: 'true' }, { ...rateTrialConfig, startPerHour: 100 },
    { ...rateTrialConfig, startPerHour: '90' }, { ...rateTrialConfig, stepPerHour: 20 },
    { ...rateTrialConfig, stageDurationMs: 1_800_000 }, { ...rateTrialConfig, override: true },
  ]) {
    await assert.rejects(h.post('/api/v1/queue/rate-trial', payload), { status: 422, code: 'RATE_TRIAL_INPUT_INVALID' });
    assert.equal(h.searchPolicy.view().rateTrial, null);
  }
  assert.deepEqual(h.counts(), { calls: 0, verifies: 0, spawns: 0 });
});

test('rate-trial API is idempotent and does not count hours while the queue has no real searches', async t => {
  const h = await harness(t);
  h.ready();
  const first = await h.post('/api/v1/queue/rate-trial', rateTrialConfig);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  const initial = first.body.queue.ratePolicy.rateTrial;
  assert.equal(initial.status, 'waiting');
  assert.equal(initial.targetPerHour, 90);
  assert.equal(initial.currentStage, null);
  assert.equal(initial.gapMs, 40_000);
  h.advance(2 * 3_600_000);
  await h.pumpQueue();
  const reread = await h.get('/api/v1/queue/rate-trial');
  const repeated = await h.post('/api/v1/queue/rate-trial', rateTrialConfig);
  assert.deepEqual(reread.body.ratePolicy.rateTrial, initial);
  assert.deepEqual(repeated.body.queue.ratePolicy.rateTrial, initial);
  assert.deepEqual(h.counts(), { calls: 0, verifies: 0, spawns: 0 });
  h.tasks.set('fresh', task('fresh'));
  const realStart = h.now();
  await h.executeTask('fresh');
  const trial = h.searchPolicy.view().rateTrial;
  assert.equal(trial.currentStage.startedAt, realStart);
  assert.equal(trial.currentStage.started, 1);
  assert.equal(trial.currentStage.succeeded, 1);
  assert.equal(trial.targetPerHour, 90);
  assert.equal(trial.lastPassedPerHour, null);
  const repeatedAfterWork = await h.handleStartRateTrial(rateTrialConfig);
  assert.deepEqual(repeatedAfterWork.queue.ratePolicy.rateTrial, trial);
});

test('rate-trial API preserves policy error status and an existing trial instead of replacing it', async t => {
  const h = await harness(t);
  h.searchPolicy.loaded = false;
  await assert.rejects(h.handleStartRateTrial(rateTrialConfig), { status: 503, code: 'RATE_POLICY_NOT_READY' });
  h.searchPolicy.loaded = true;
  await h.searchPolicy.startTrial({ startPerHour: 80, stepPerHour: 10, stageDurationMs: 3_600_000 });
  const before = h.searchPolicy.view().rateTrial;
  await assert.rejects(h.handleStartRateTrial(rateTrialConfig), { status: 409, code: 'RATE_TRIAL_EXISTS' });
  assert.deepEqual(h.searchPolicy.view().rateTrial, before);
  assert.deepEqual(h.counts(), { calls: 0, verifies: 0, spawns: 0 });
});

test('rate-trial API refuses an in-flight search without creating or resetting rate state', async t => {
  const h = await harness(t);
  let signalStarted, release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  h.dispatch(async () => { signalStarted(); await pending; return { offers: [] }; });
  h.tasks.set('busy', task('busy')); h.taskQueue.push('busy');
  h.ready();
  const pumping = h.pumpQueue();
  await started;
  try {
    await assert.rejects(h.post('/api/v1/queue/rate-trial', rateTrialConfig), { status: 409, code: 'RATE_TRIAL_BUSY' });
    assert.equal(h.searchPolicy.view().rateTrial, null);
    assert.equal(h.tasks.get('busy').status, 'running');
  } finally { release(); await pumping; }
  assert.equal(h.counts().calls, 1);
});

test('executeTask persists successful trial results and releases each reservation for the next product', async t => {
  const h = await harness(t);
  await h.handleStartRateTrial(rateTrialConfig);
  h.dispatch(async () => { h.advance(2000); return { offers: [], imageId: 'matched-image' }; });
  for (const id of ['first-trial-product', 'second-trial-product']) {
    h.tasks.set(id, task(id));
    await h.executeTask(id);
    assert.equal(h.tasks.get(id).status, 'review_candidates');
    assert.equal(h.tasks.get(id).imageId, 'matched-image');
    h.advance(40_000);
  }
  const trial = h.searchPolicy.view().rateTrial;
  assert.equal(trial.currentStage.started, 2);
  assert.equal(trial.currentStage.succeeded, 2);
  assert.equal(trial.currentStage.failed, 0);
  assert.equal(trial.currentStage.pending, 0);
  assert.equal(trial.activeSearch, null);
  const persisted = JSON.parse(await fs.readFile(h.searchPolicy.file, 'utf8'));
  assert.equal(persisted.rateTrial.currentStage.succeeded, 2);
  assert.equal(persisted.rateTrial.activeSearch, null);
  assert.equal(h.counts().calls, 2);
});

test('executeTask records a slider failure in the trial report and keeps all later searches paused', async t => {
  const h = await harness(t);
  await h.handleStartRateTrial(rateTrialConfig);
  h.tasks.set('challenged', task('challenged')); h.tasks.set('later', task('later'));
  h.dispatch(async () => {
    h.advance(12_000);
    throw Object.assign(new Error('请完成滑块验证'), { code: 'RISK_CONTROL' });
  });
  await h.executeTask('challenged');
  const trial = h.searchPolicy.view().rateTrial;
  assert.equal(h.tasks.get('challenged').status, 'risk_blocked');
  assert.equal(trial.status, 'stopped_risk');
  assert.equal(trial.currentStage.started, 1);
  assert.equal(trial.currentStage.succeeded, 0);
  assert.equal(trial.currentStage.failed, 1);
  assert.equal(trial.currentStage.pending, 0);
  assert.equal(trial.activeSearch, null);
  assert.equal(trial.trigger.targetPerHour, 90);
  assert.equal(trial.trigger.elapsedMs, 12_000);
  assert.equal(trial.trigger.failed, 1);
  assert.equal(trial.trigger.previousPassedPerHour, null);
  const persisted = JSON.parse(await fs.readFile(h.searchPolicy.file, 'utf8'));
  assert.equal(persisted.rateTrial.trigger.failed, 1);
  assert.equal(persisted.rateTrial.activeSearch, null);
  const repeated = await h.handleStartRateTrial(rateTrialConfig);
  assert.equal(repeated.queue.ratePolicy.manualResumeRequired, true);
  assert.deepEqual(repeated.queue.ratePolicy.rateTrial, trial);
  h.advance(3_600_000);
  await h.executeTask('later');
  assert.equal(h.counts().calls, 1);
  assert.equal(h.tasks.get('later').status, 'queued');
  assert.equal(h.searchPolicy.view().manualResumeRequired, true);
  assert.deepEqual(h.searchPolicy.view().rateTrial.trigger, trial.trigger);
});

test('executeTask releases and records a completed search even when saving its final task snapshot fails', async t => {
  const h = await harness(t);
  await h.handleStartRateTrial(rateTrialConfig);
  h.tasks.set('save-failure', task('save-failure'));
  let taskWrites = 0;
  h.writeFile(async (file, ...args) => {
    if (path.basename(file) === 'save-failure.json' && ++taskWrites === 2) {
      throw Object.assign(new Error('task snapshot write failed'), { code: 'EIO' });
    }
    return fs.writeFile(file, ...args);
  });
  await assert.rejects(h.executeTask('save-failure'), { code: 'EIO' });
  assert.equal(h.counts().calls, 1);
  const trial = h.searchPolicy.view().rateTrial;
  assert.equal(trial.currentStage.started, 1);
  assert.equal(trial.currentStage.succeeded, 1);
  assert.equal(trial.currentStage.pending, 0);
  assert.equal(trial.activeSearch, null);
});

for (const persistentFailure of [false, true]) {
  test('a ' + (persistentFailure ? 'persistent' : 'single') + ' trial result write failure pauses pending work without repeated dispatch or queue spinning', async t => {
    const h = await harness(t);
    await h.handleStartRateTrial(rateTrialConfig);
    for (const id of ['finished-unrecorded', 'pending-second']) {
      h.tasks.set(id, task(id)); h.taskQueue.push(id);
    }
    const persist = h.searchPolicy.persist.bind(h.searchPolicy);
    let resultWrites = 0, reservations = 0;
    const beginSearch = h.searchPolicy.beginSearch.bind(h.searchPolicy);
    h.searchPolicy.beginSearch = async options => {
      reservations++;
      // Fail a regressed requeue loop deterministically instead of hanging
      // the test worker on an endless chain of resolved microtasks.
      if (reservations > 2) throw new Error('unexpected repeated reservation loop');
      return beginSearch(options);
    };
    h.dispatch(async () => {
      // The next rate window has already opened when result persistence fails.
      h.advance(60_000);
      h.searchPolicy.persist = async () => {
        resultWrites++;
        if (persistentFailure || resultWrites === 1) {
          throw Object.assign(new Error('trial result disk unavailable'), { code: 'EIO' });
        }
        return persist();
      };
      return { offers: [], imageId: 'preserved-image' };
    });
    h.ready();
    await h.pumpQueue();
    const policy = h.searchPolicy.view();
    assert.equal(h.counts().calls, 1);
    assert.equal(reservations, 1);
    assert.equal(resultWrites, 2); // Failed result, then attempted durable pause.
    assert.equal(policy.manualResumeRequired, true);
    assert.equal(policy.pausedReason, 'RATE_TRIAL_RECORD_FAILED');
    assert.equal(policy.blockedTaskId, 'finished-unrecorded');
    assert.equal(policy.rateTrial.status, 'stopped_manual');
    assert.equal(policy.rateTrial.activeSearch.taskId, 'finished-unrecorded');
    assert.equal(policy.rateTrial.currentStage.succeeded, 0);
    assert.equal(policy.rateTrial.currentStage.pending, 1);
    assert.equal(h.tasks.get('finished-unrecorded').status, 'review_candidates');
    assert.equal(h.tasks.get('finished-unrecorded').imageId, 'preserved-image');
    assert.equal(h.tasks.get('pending-second').status, 'queued');
    assert.deepEqual(Array.from(h.taskQueue), ['pending-second']);
    const savedTask = JSON.parse(await fs.readFile(path.join(h.dir, 'data', 'sourcing-console', 'tasks', 'finished-unrecorded.json'), 'utf8'));
    assert.equal(savedTask.status, 'review_candidates');
    const savedPolicy = JSON.parse(await fs.readFile(h.searchPolicy.file, 'utf8'));
    assert.equal(savedPolicy.rateTrial.activeSearch.taskId, 'finished-unrecorded');
    if (!persistentFailure) assert.equal(savedPolicy.pausedReason, 'RATE_TRIAL_RECORD_FAILED');
    h.advance(3_600_000);
    await h.pumpQueue();
    await h.pumpQueue();
    assert.equal(h.counts().calls, 1);
    assert.equal(reservations, 1);
    assert.equal(resultWrites, 2);
    assert.deepEqual(Array.from(h.taskQueue), ['pending-second']);
  });
}

test('an outstanding result reservation alone prevents dequeue and an empty requeue loop', async t => {
  const h = await harness(t);
  await h.handleStartRateTrial(rateTrialConfig);
  await h.searchPolicy.beginSearch({ taskId: 'awaiting-result-record' });
  h.advance(60_000);
  h.tasks.set('pending-second', task('pending-second')); h.taskQueue.push('pending-second');
  let attempts = 0;
  const beginSearch = h.searchPolicy.beginSearch.bind(h.searchPolicy);
  h.searchPolicy.beginSearch = async options => {
    if (++attempts > 1) throw new Error('unexpected repeated reservation loop');
    return beginSearch(options);
  };
  h.ready();
  await h.pumpQueue();
  assert.equal(h.searchPolicy.view().manualResumeRequired, false);
  assert.equal(attempts, 0);
  assert.equal(h.counts().calls, 0);
  assert.equal(h.tasks.get('pending-second').status, 'queued');
  assert.deepEqual(Array.from(h.taskQueue), ['pending-second']);
});

test('executeTask propagates the original result-record error if recording the manual pause also fails', async t => {
  const h = await harness(t);
  await h.handleStartRateTrial(rateTrialConfig);
  h.tasks.set('original-error', task('original-error'));
  const resultError = Object.assign(new Error('original finishSearch disk error'), { code: 'EIO' });
  const pauseError = Object.assign(new Error('pause disk error'), { code: 'ENOSPC' });
  let writes = 0;
  h.dispatch(async () => {
    h.searchPolicy.persist = async () => { throw ++writes === 1 ? resultError : pauseError; };
    return { offers: [] };
  });
  await assert.rejects(h.executeTask('original-error'), error => error === resultError);
  assert.equal(writes, 2);
  assert.equal(h.searchPolicy.view().manualResumeRequired, true);
  assert.equal(h.searchPolicy.view().pausedReason, 'RATE_TRIAL_RECORD_FAILED');
  assert.equal(h.counts().calls, 1);
});

for (const code of ['SEARCH_TIMEOUT', 'SEARCH_WORKER_EXITED', 'SEARCH_WORKER_STOP_FAILED']) {
  test(`${code} preserves the task and stops the queue without repeating an unknown search`, async t => {
    const h = await harness(t);
    await h.handleStartRateTrial(rateTrialConfig);
    for (const id of ['stalled', 'next']) { h.tasks.set(id, task(id)); h.taskQueue.push(id); }
    h.dispatch(async () => { throw Object.assign(new Error('owned search did not complete'), { code }); });
    h.ready(); await h.pumpQueue();
    assert.equal(h.counts().calls, 1);
    assert.equal(h.tasks.get('stalled').status, 'failed');
    assert.equal(h.tasks.get('stalled').failure.code, code);
    assert.equal(h.tasks.get('next').status, 'queued');
    assert.equal(h.searchPolicy.view().manualResumeRequired, true);
    assert.equal(h.searchPolicy.view().pausedReason, code);
    const trial = h.searchPolicy.view().rateTrial;
    assert.equal(trial.activeSearch, null);
    assert.equal(trial.currentStage.started, 1);
    assert.equal(trial.currentStage.failed, 1);
    assert.equal(trial.status, 'stopped_manual');
    h.advance(24 * 3_600_000); await h.pumpQueue();
    assert.equal(h.counts().calls, 1);
    const saved = JSON.parse(await fs.readFile(path.join(h.dir, 'data', 'sourcing-console', 'tasks', 'stalled.json'), 'utf8'));
    assert.equal(saved.failure.code, code);
    assert.ok(saved.execution.finishedAt);
  });
}

test('an unconfirmed worker stop blocks login, queue resume, and new execution even after policy confirmation', async t => {
  const h = await harness(t);
  h.workerActive(true);
  h.tasks.set('pending', task('pending')); h.taskQueue.push('pending');
  h.ready(); await h.pumpQueue();
  assert.equal(h.counts().calls, 0);
  assert.equal(h.queueSummary().running, 1);
  await assert.rejects(h.handleResumeQueue({ confirmed: true }), { code: 'SEARCH_WORKER_STOP_FAILED' });
  await assert.rejects(h.openLogin({ purpose: 'login', restart: false }), { code: 'SEARCH_WORKER_STOP_FAILED' });
  assert.equal(h.counts().spawns, 0);
});

test('worker progress preserves in-memory phases while rate trial records exactly one result', async t => {
  const h = await harness(t);
  await h.handleStartRateTrial(rateTrialConfig);
  h.tasks.set('phases', task('phases'));
  h.dispatch(async ({ onProgress, imagePath, max }) => {
    assert.equal(imagePath, '/mock/image.png'); assert.equal(max, 40);
    for (const phase of ['validating_image', 'uploading_image', 'searching_offers', 'saving_candidates']) {
      onProgress({ phase });
      assert.equal(h.publicTask(h.tasks.get('phases')).execution.phase, phase);
    }
    return { offers: [{ offerId: '123' }], imageId: '456' };
  });
  await h.executeTask('phases');
  assert.equal(h.tasks.get('phases').candidates.length, 1);
  assert.equal(h.publicTask(h.tasks.get('phases')).execution.phase, 'finished');
  assert.equal(h.searchPolicy.view().rateTrial.currentStage.started, 1);
  assert.equal(h.searchPolicy.view().rateTrial.currentStage.succeeded, 1);
});

test('a restart preserves unknown running work for inspection rather than submitting it twice', async t => {
  const h = await harness(t);
  const taskDir = path.join(h.dir, 'data', 'sourcing-console', 'tasks');
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'interrupted.json'), JSON.stringify(task('interrupted', 'running')));
  await fs.writeFile(path.join(taskDir, 'next.json'), JSON.stringify(task('next')));
  await h.loadTasksFromDisk();
  await h.searchPolicy.initialize([...h.tasks.values()]);
  await h.preserveInterruptedSearchPause();
  h.ready(); await h.pumpQueue();
  assert.equal(h.counts().calls, 0);
  assert.equal(h.tasks.get('interrupted').failure.code, 'SEARCH_INTERRUPTED');
  assert.equal(h.tasks.get('interrupted').status, 'failed');
  assert.equal(h.tasks.get('next').status, 'queued');
  assert.equal(h.searchPolicy.view().pausedReason, 'SEARCH_INTERRUPTED');
  const saved = JSON.parse(await fs.readFile(path.join(taskDir, 'interrupted.json'), 'utf8'));
  assert.equal(saved.failure.code, 'SEARCH_INTERRUPTED');
});

test('restart inspection never overwrites an existing challenge or human pause', async t => {
  const h = await harness(t);
  const interrupted = task('interrupted', 'failed'); interrupted.failure = { code: 'SEARCH_INTERRUPTED' };
  h.tasks.set(interrupted.id, interrupted);
  await h.searchPolicy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  const before = h.searchPolicy.view();
  await h.preserveInterruptedSearchPause();
  assert.deepEqual(h.searchPolicy.view(), before);
});

for (const code of ['SEARCH_TIMEOUT', 'SEARCH_WORKER_EXITED', 'SEARCH_WORKER_STOP_FAILED', 'SEARCH_INTERRUPTED']) {
  test(`explicit resume after ${code} retries only that checkpoint using its existing task ID`, async t => {
    const h = await harness(t);
    const blocked = task('blocked', 'failed'); blocked.failure = { code };
    const historical = task('older', 'failed'); historical.failure = { code };
    h.tasks.set(blocked.id, blocked); h.tasks.set(historical.id, historical);
    await h.searchPolicy.pauseForManual(code, blocked.id);
    await assert.rejects(h.handleResumeQueue({}), { code: 'RESUME_CONFIRMATION_REQUIRED' });
    const resumed = await h.handleResumeQueue({ confirmed: true });
    assert.equal(resumed.queue.ratePolicy.manualResumeRequired, false);
    assert.equal(h.tasks.get('blocked').status, 'queued');
    assert.equal(h.tasks.get('blocked').failure, null);
    assert.equal(h.tasks.get('older').status, 'failed');
    assert.deepEqual(Array.from(h.taskQueue), ['blocked']);
    assert.equal(h.counts().calls, 0); // no timer, no implicit user action
  });
}
