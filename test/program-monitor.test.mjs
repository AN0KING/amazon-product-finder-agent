import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProgramMonitor, PROGRAM_MONITOR_INTERVALS } from '../lib/program-monitor.mjs';

const EPOCH = Date.parse('2026-10-12T00:00:00Z');
const clone = value => structuredClone(value);
const stage = (overrides = {}) => ({ started: 12, succeeded: 10, failed: 2, startedAt: EPOCH + 1,
  targetPerHour: 90, elapsedMs: 600_000, ...overrides });
const trial = (overrides = {}) => ({ createdAt: EPOCH, status: 'running', targetPerHour: 90,
  currentStage: stage(), history: [], trigger: null, lastPassedPerHour: null, ...overrides });
const supplier = (overrides = {}) => ({ rateTrial: trial(), runtime: { auth: { ready: true }, queue: {} },
  pipeline: { runId: 'new-run', status: 'running', startedAt: new Date(EPOCH + 1).toISOString() }, ...overrides });
const quality = { price: { verified: 8, unavailable: 2, invalid: 1, missing: 3 },
  weight: { verified: 7, unavailable: 3, invalid: 2, missing: 2 } };
const job = (overrides = {}) => ({ runId: 'amazon-run', status: 'running', counts: { total: 14, pending: 3 }, quality, ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-program-monitor-'));
  const state = { amazon: null, supplier1688: { available: false }, now: EPOCH, ...options.state };
  const calls = { amazon: 0, supplier1688: 0 };
  const timerCallbacks = [];
  const cleared = [];
  const args = { statePath: path.join(directory, 'program-monitor.json'), now: () => state.now,
    loadAmazon: async ({ signal }) => { assert.ok(signal instanceof AbortSignal); calls.amazon++; return clone(state.amazon); },
    loadSupplier1688: async ({ signal }) => { assert.ok(signal instanceof AbortSignal); calls.supplier1688++; return clone(state.supplier1688); },
    setIntervalFn: (callback, ms) => { const timer = { callback, ms, unref() {} }; timerCallbacks.push(timer); return timer; },
    clearIntervalFn: handle => cleared.push(handle), ...options.args };
  const monitor = new ProgramMonitor(args);
  t.after(async () => { await monitor.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  if (options.start !== false) await monitor.start({ timer: options.timer ?? false });
  return { monitor, state, calls, args, directory, timerCallbacks, cleared };
}

test('startup checks once; snapshot reads are pure and detached; intervals are program-owned', async t => {
  const s = await setup(t, { timer: true });
  assert.deepEqual(s.calls, { amazon: 1, supplier1688: 1 });
  assert.deepEqual(s.monitor.snapshot().intervals, PROGRAM_MONITOR_INTERVALS);
  assert.deepEqual(s.timerCallbacks.map(value => value.ms), [900_000, 1_800_000]);
  s.monitor.snapshot().checks.amazon.status = 'tampered';
  assert.equal(s.monitor.snapshot().checks.amazon.status, 'idle');
  for (let index = 0; index < 10; index++) s.monitor.snapshot();
  assert.deepEqual(s.calls, { amazon: 1, supplier1688: 1 });
  await s.monitor.start();
  assert.equal(s.timerCallbacks.length, 2);
  await s.monitor.stop();
  assert.equal(s.cleared.length, 2);
  assert.equal(s.monitor.snapshot().enabled, false);
});

test('normal states, manual pauses and an old completed pipeline remain silent', async t => {
  const s = await setup(t);
  for (const status of ['running', 'queued', 'cooldown', 'paused']) {
    s.state.amazon = job({ status });
    s.state.supplier1688 = supplier({ rateTrial: trial({ status: 'waiting', currentStage: null }),
      runtime: { auth: { ready: false } }, pipeline: { runId: 'old', status: 'complete', startedAt: EPOCH - 5000 } });
    await s.monitor.check('amazon'); await s.monitor.check('supplier1688');
  }
  assert.deepEqual(s.monitor.snapshot().events, []);
  s.state.supplier1688 = supplier({ pipeline: { runId: 'new-run', status: 'paused', causeCode: 'LOGIN_REQUIRED' },
    runtime: { auth: { ready: false } } });
  await s.monitor.check('supplier1688');
  assert.deepEqual(s.monitor.snapshot().events, []);
  assert.equal(s.monitor.snapshot().checks.supplier1688.status, 'paused');
});

test('Amazon completion requires an observed task transition and is emitted once', async t => {
  const s = await setup(t, { state: { amazon: job({ status: 'completed' }) } });
  assert.deepEqual(s.monitor.snapshot().events, []);
  s.state.amazon = job({ runId: 'new-amazon' });
  await s.monitor.check('amazon');
  s.state.amazon.status = 'completed';
  await s.monitor.check('amazon'); await s.monitor.check('amazon');
  const [event] = s.monitor.snapshot().events;
  assert.equal(event.kind, 'completed'); assert.equal(event.details.runId, 'new-amazon');
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.deepEqual(event.details.coverage.price, { verified: 8, unavailable: 2, invalid: 1, pending: 3 });
  assert.match(event.message, /价格：已核验 8、页面未提供 2、异常 1、待采集 3/);
});

test('attention fingerprints and coverage survive restart without touching task input', async t => {
  const source = job({ status: 'needs_attention', causeCode: 'AMAZON_ACCESS_CHALLENGE' });
  const s = await setup(t, { state: { amazon: source } });
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.deepEqual(s.state.amazon, source);
  await s.monitor.stop();
  const restarted = new ProgramMonitor(s.args);
  t.after(() => restarted.stop());
  await restarted.start({ timer: false });
  await restarted.check('amazon');
  assert.equal(restarted.snapshot().events.length, 1);
  assert.equal(restarted.snapshot().events[0].kind, 'needs_attention');
  s.state.amazon.causeCode = 'AMAZON_HTTP_429';
  await restarted.check('amazon');
  assert.equal(restarted.snapshot().events.length, 2);
});

test('ordinary failures require three consecutive observations and deduplicate an incident', async t => {
  let failing = false;
  const s = await setup(t, { args: { loadAmazon: async () => {
    if (failing) throw Object.assign(new Error('credential=secret'), { code: 'ECONNREFUSED' });
    return job();
  } } });
  failing = true;
  for (let i = 0; i < 2; i++) await s.monitor.check('amazon');
  assert.equal(s.monitor.snapshot().events.length, 0);
  await s.monitor.check('amazon'); await s.monitor.check('amazon');
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.equal(s.monitor.snapshot().events[0].kind, 'persistent_failure');
  assert.ok(!JSON.stringify(s.monitor.snapshot()).includes('secret'));
  failing = false; await s.monitor.check('amazon'); failing = true;
  assert.equal(s.monitor.snapshot().events.at(-1).kind, 'recovered');
  for (let i = 0; i < 3; i++) await s.monitor.check('amazon');
  assert.equal(s.monitor.snapshot().events.length, 3);
});

test('an optional uninstalled 1688 provider is quiet; a known active pipeline can fail persistently', async t => {
  const s = await setup(t);
  for (let i = 0; i < 4; i++) await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().checks.supplier1688.status, 'unavailable');
  assert.equal(s.monitor.snapshot().events.length, 0);
  s.state.supplier1688 = { available: false, errorCode: 'BRIDGE_UNAVAILABLE', pipeline: { runId: 'active', status: 'running' } };
  await s.monitor.check('supplier1688'); await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().events.length, 0);
  await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.equal(s.monitor.snapshot().events[0].kind, 'persistent_failure');
  assert.equal(s.monitor.snapshot().events[0].details.code, 'BRIDGE_UNAVAILABLE');
});

test('first slider freezes only that trial and reports actual starts including retries', async t => {
  const s = await setup(t, { state: { supplier1688: supplier() } });
  const trigger = { reason: 'RISK_VERIFICATION_REQUIRED', at: EPOCH + 600_000, targetPerHour: 90,
    started: 15, succeeded: 12, elapsedMs: 600_000, actualPerHour: 90, previousPassedPerHour: null };
  s.state.supplier1688.rateTrial = trial({ status: 'stopped_risk', trigger });
  await s.monitor.check('supplier1688');
  const [event] = s.monitor.snapshot().events;
  assert.equal(event.kind, 'verification_required');
  assert.deepEqual({ ...event.details, trialCreatedAt: undefined, runId: undefined }, { trialCreatedAt: undefined, runId: undefined,
    reason: 'RISK_VERIFICATION_REQUIRED', targetPerHour: 90, started: 15, succeeded: 12,
    elapsedMinutes: 10, actualPerHour: 90, previousPassedPerHour: null });
  assert.match(event.message, /尚无完整通过的档位/);
  assert.match(event.message, /实际发起 15 次（含重试）/);
  assert.match(event.message, /不能认定固定验证阈值/);
  assert.equal(s.monitor.snapshot().checks.supplier1688.status, 'stopped');
  await s.monitor.stop();
  const restarted = new ProgramMonitor(s.args); t.after(() => restarted.stop());
  await restarted.start({ timer: false });
  assert.equal(restarted.snapshot().events.length, 1);
  s.state.amazon = job({ status: 'needs_attention', causeCode: 'AMAZON_ACCESS_CHALLENGE' });
  await restarted.check('amazon');
  assert.equal(restarted.snapshot().events.length, 2);
  s.state.supplier1688.rateTrial = trial({ createdAt: EPOCH + 1000, status: 'stopped_risk',
    trigger: { ...trigger, previousPassedPerHour: 80, at: EPOCH + 900_000 } });
  await restarted.check('supplier1688');
  assert.equal(restarted.snapshot().events.length, 3);
  assert.match(restarted.snapshot().events.at(-1).message, /上一完整通过档位 80/);
});

test('throughput shortage is one event and never turns incomplete or interrupted hours into passes', async t => {
  const value = supplier({ rateTrial: trial({ status: 'throughput_limited', currentStage: stage({ started: 20, elapsedMs: 3_600_000 }),
    history: [stage({ outcome: 'interrupted' })] }) });
  const s = await setup(t, { state: { supplier1688: value } });
  await s.monitor.check('supplier1688');
  assert.deepEqual(s.state.supplier1688, value);
  const events = s.monitor.snapshot().events;
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'throughput_limited');
  assert.match(events[0].message, /该档未验证/); assert.match(events[0].message, /停止加速并保持当前速率/);
});

test('only the observed actual trial batch can produce completion', async t => {
  const s = await setup(t, { state: { supplier1688: supplier({
    pipeline: { runId: 'old-completed', status: 'complete', startedAt: EPOCH - 1000 } }) } });
  assert.equal(s.monitor.snapshot().events.length, 0);
  s.state.supplier1688 = supplier();
  await s.monitor.check('supplier1688');
  s.state.supplier1688.pipeline = { runId: 'wrong-run', status: 'complete' };
  await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().events.length, 0);
  s.state.supplier1688.pipeline = { runId: 'new-run', status: 'complete' };
  await s.monitor.check('supplier1688'); await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.equal(s.monitor.snapshot().events[0].kind, 'completed');
});

test('login required is reported for actual work, without leaking runtime auth data', async t => {
  const s = await setup(t, { state: { supplier1688: supplier({ runtime: {
    auth: { ready: false, cookie: 'sensitive', memberId: 'private' }, queue: {} } }) } });
  await s.monitor.check('supplier1688');
  const snapshot = s.monitor.snapshot();
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].kind, 'login_required');
  assert.ok(!JSON.stringify(snapshot).includes('sensitive')); assert.ok(!JSON.stringify(snapshot).includes('private'));
});

test('overlapping polls share one loader; stop aborts inflight work and ignores late results', async t => {
  const gate = deferred(); let signals = []; let calls = 0;
  const s = await setup(t, { start: false, args: { loadAmazon: async ({ signal }) => { calls++; signals.push(signal); return gate.promise; } } });
  const starting = s.monitor.start({ timer: false });
  while (!calls) await new Promise(resolve => setImmediate(resolve));
  const first = s.monitor.check('amazon'); const second = s.monitor.check('amazon');
  assert.equal(first, second); assert.equal(calls, 1);
  await s.monitor.stop(); await starting;
  assert.equal(signals[0].aborted, true);
  gate.resolve(job({ status: 'needs_attention' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.monitor.snapshot().events.length, 0);
  assert.equal(s.monitor.snapshot().enabled, false);
});

test('hung loaders time out; stopping does not require their cooperation', async t => {
  const s = await setup(t, { args: { checkTimeoutMs: 10, loadSupplier1688: async () => new Promise(() => {}) } });
  assert.equal(s.monitor.snapshot().checks.supplier1688.errorCode, 'MONITOR_READ_TIMEOUT');
  assert.equal(s.monitor.snapshot().events.length, 0);
});

test('event history is bounded, atomic persistence leaves no temp files and reload keeps fingerprints', async t => {
  const s = await setup(t, { args: { maxEvents: 3 } });
  for (let index = 0; index < 7; index++) {
    s.state.amazon = job({ runId: `run-${index}`, status: 'needs_attention', causeCode: 'AMAZON_ACCESS_CHALLENGE' });
    await s.monitor.check('amazon');
  }
  assert.equal(s.monitor.snapshot().events.length, 3);
  assert.deepEqual(await fs.readdir(s.directory), ['program-monitor.json']);
  const saved = JSON.parse(await fs.readFile(s.args.statePath, 'utf8'));
  assert.equal(saved.notifiedFingerprints.length, 7);
  await s.monitor.stop();
  const restarted = new ProgramMonitor(s.args); t.after(() => restarted.stop());
  await restarted.start({ timer: false });
  s.state.amazon.runId = 'run-0'; await restarted.check('amazon');
  assert.equal(restarted.snapshot().events.length, 3);
  assert.equal(restarted.snapshot().events.at(-1).details.runId, 'run-6');
});

test('a corrupted state is preserved and fails visibly instead of resetting deduplication', async t => {
  const s = await setup(t, { start: false });
  const invalid = '{ invalid state';
  await fs.writeFile(s.args.statePath, invalid);
  await assert.rejects(s.monitor.start({ timer: false }));
  assert.equal(await fs.readFile(s.args.statePath, 'utf8'), invalid);
  assert.equal(s.monitor.snapshot().enabled, false);
});

test('wrapped API payloads are supported and API error payloads are not treated as success', async t => {
  const s = await setup(t, { state: { amazon: { ok: true, data: job() }, supplier1688: {
    ratePolicy: { ok: true, data: { rateTrial: trial() } },
    runtime: { ok: true, data: { auth: { ready: true } } }, pipeline: { ok: true, data: supplier().pipeline } } } });
  assert.equal(s.monitor.snapshot().checks.amazon.status, 'running');
  assert.equal(s.monitor.snapshot().checks.supplier1688.runId, 'new-run');
  s.state.amazon = { ok: false, error: { code: 'SOURCE_UNAVAILABLE' } };
  await s.monitor.check('amazon');
  assert.equal(s.monitor.snapshot().checks.amazon.errorCode, 'SOURCE_UNAVAILABLE');
});


test('provider downtime after a manual pause does not raise a persistent-failure alert', async t => {
  const s = await setup(t, { state: { supplier1688: supplier() } });
  s.state.supplier1688 = { available: false, errorCode: 'BRIDGE_UNAVAILABLE',
    pipeline: { runId: 'new-run', status: 'paused' } };
  for (let index = 0; index < 4; index++) await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().checks.supplier1688.status, 'paused');
  assert.equal(s.monitor.snapshot().events.length, 0);
});


test('a new trial batch finishing entirely between polls is recognized using its timestamp ownership', async t => {
  const s = await setup(t, { state: { supplier1688: supplier({
    rateTrial: trial({ status: 'waiting', currentStage: null }), pipeline: null }) } });
  s.state.now += 1_800_000;
  s.state.supplier1688 = supplier({ pipeline: { runId: 'quick-new-batch', status: 'complete',
    startedAt: new Date(EPOCH + 1000).toISOString(), completedAt: new Date(EPOCH + 1_200_000).toISOString() } });
  await s.monitor.check('supplier1688'); await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().checks.supplier1688.runId, 'quick-new-batch');
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.equal(s.monitor.snapshot().events[0].kind, 'completed');
  assert.equal(s.monitor.snapshot().events[0].details.runId, 'quick-new-batch');
});

test('a timestamped completed pipeline with no trial searches is not a trial completion', async t => {
  const s = await setup(t, { state: { supplier1688: supplier({
    rateTrial: trial({ status: 'waiting', currentStage: null }), pipeline: { runId: 'finished-elsewhere',
      status: 'complete', startedAt: EPOCH + 1000 } }) } });
  assert.equal(s.monitor.snapshot().events.length, 0);
  assert.equal(s.monitor.snapshot().checks.supplier1688.runId, null);
});

test('persistence failures expose only a safe code and clear after a successful retry', async t => {
  const s = await setup(t);
  const normalPath = s.monitor.statePath;
  const blocker = path.join(s.directory, 'private-file-path');
  await fs.writeFile(blocker, 'file prevents directory creation');
  s.monitor.statePath = path.join(blocker, 'program-monitor.json');
  s.state.amazon = job({ status: 'needs_attention', causeCode: 'AMAZON_ACCESS_CHALLENGE' });
  await assert.rejects(s.monitor.check('amazon'));
  const failedSnapshot = s.monitor.snapshot();
  assert.equal(failedSnapshot.persistenceError, 'PROGRAM_MONITOR_PERSISTENCE_FAILED');
  assert.equal(failedSnapshot.enabled, true);
  assert.ok(!JSON.stringify(failedSnapshot).includes('private-file-path'));
  s.monitor.statePath = normalPath;
  await s.monitor.check('amazon');
  assert.equal(s.monitor.snapshot().persistenceError, null);
  const saved = JSON.parse(await fs.readFile(normalPath, 'utf8'));
  assert.equal(saved.events.length, 1);
  assert.equal(saved.notifiedFingerprints.length, 1);
});

test('first observing Amazon as paused then completed does not invent an active transition', async t => {
  const s = await setup(t, { state: { amazon: job({ status: 'paused' }) } });
  s.state.amazon.status = 'completed';
  await s.monitor.check('amazon');
  assert.equal(s.monitor.snapshot().events.length, 0);
});


test('an Amazon batch created and completed between polls generates one completion', async t => {
  const s = await setup(t);
  s.state.now += 900_000;
  s.state.amazon = job({ runId: 'short-new-run', status: 'completed',
    createdAt: new Date(EPOCH + 10_000).toISOString(), completedAt: new Date(EPOCH + 600_000).toISOString() });
  await s.monitor.check('amazon'); await s.monitor.check('amazon');
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.equal(s.monitor.snapshot().events[0].kind, 'completed');
  assert.equal(s.monitor.snapshot().events[0].details.runId, 'short-new-run');
});

test('old, undated, future-dated and first-observed completed Amazon tasks stay silent', async t => {
  const s = await setup(t, { state: { amazon: job({ status: 'completed',
    createdAt: new Date(EPOCH - 3000).toISOString(), completedAt: new Date(EPOCH - 1000).toISOString() }) } });
  assert.equal(s.monitor.snapshot().events.length, 0);
  s.state.now += 900_000;
  for (const [index, dates] of [
    { createdAt: new Date(EPOCH - 3000).toISOString(), completedAt: new Date(EPOCH + 5000).toISOString() },
    { createdAt: new Date(EPOCH + 1000).toISOString() },
    { createdAt: new Date(EPOCH + 1000).toISOString(), completedAt: new Date(s.state.now + 5000).toISOString() },
  ].entries()) {
    s.state.amazon = job({ runId: `unproven-${index}`, status: 'completed', ...dates });
    await s.monitor.check('amazon');
  }
  assert.equal(s.monitor.snapshot().events.length, 0);
});

test('a reported Amazon failure recovers once for the same task even across restart', async t => {
  let broken = false;
  const s = await setup(t, { args: { loadAmazon: async () => {
    if (broken) throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
    return job();
  } } });
  broken = true;
  for (let index = 0; index < 3; index++) await s.monitor.check('amazon');
  await s.monitor.stop();
  broken = false;
  const restarted = new ProgramMonitor(s.args); t.after(() => restarted.stop());
  await restarted.start({ timer: false }); await restarted.check('amazon');
  assert.deepEqual(restarted.snapshot().events.map(event => event.kind), ['persistent_failure', 'recovered']);
  assert.deepEqual(restarted.snapshot().events[1].details.coverage.price,
    { verified: 8, unavailable: 2, invalid: 1, pending: 3 });
});

test('idle, manual pause, replacement tasks and unreported transient faults do not create recovery events', async t => {
  for (const next of [null, job({ status: 'paused' }), job({ runId: 'replacement' })]) {
    let broken = false; let current = job();
    const s = await setup(t, { args: { loadAmazon: async () => {
      if (broken) throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
      return current;
    } } });
    broken = true;
    for (let index = 0; index < 3; index++) await s.monitor.check('amazon');
    broken = false; current = next;
    await s.monitor.check('amazon');
    assert.deepEqual(s.monitor.snapshot().events.map(event => event.kind), ['persistent_failure']);
  }
  let broken = false;
  const transient = await setup(t, { args: { loadAmazon: async () => {
    if (broken) throw new Error('brief failure');
    return job();
  } } });
  broken = true; await transient.monitor.check('amazon');
  broken = false; await transient.monitor.check('amazon');
  assert.equal(transient.monitor.snapshot().events.length, 0);
});

test('1688 bridge recovery reports only the same active task once', async t => {
  const s = await setup(t, { state: { supplier1688: supplier() } });
  s.state.supplier1688 = { available: false, errorCode: 'BRIDGE_UNAVAILABLE',
    pipeline: { runId: 'new-run', status: 'running' } };
  for (let index = 0; index < 3; index++) await s.monitor.check('supplier1688');
  s.state.supplier1688 = supplier();
  await s.monitor.check('supplier1688'); await s.monitor.check('supplier1688');
  assert.deepEqual(s.monitor.snapshot().events.map(event => event.kind), ['persistent_failure', 'recovered']);
});


test('a replacement 1688 batch starts its own failure streak and cannot inherit prior recovery', async t => {
  const s = await setup(t, { state: { supplier1688: supplier() } });
  s.state.supplier1688 = { available: false, errorCode: 'BRIDGE_UNAVAILABLE',
    pipeline: { runId: 'new-run', status: 'running' } };
  await s.monitor.check('supplier1688'); await s.monitor.check('supplier1688');
  s.state.supplier1688.pipeline.runId = 'replacement';
  await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().events.length, 0);
  assert.equal(s.monitor.snapshot().checks.supplier1688.consecutiveFailures, 1);
  await s.monitor.check('supplier1688'); await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().events.length, 1);
  assert.equal(s.monitor.snapshot().events[0].details.runId, 'replacement');
  s.state.supplier1688 = supplier({ pipeline: { runId: 'another-new-run', status: 'running', startedAt: EPOCH + 5000 } });
  await s.monitor.check('supplier1688');
  assert.deepEqual(s.monitor.snapshot().events.map(event => event.kind), ['persistent_failure']);
});

test('removing the last unconfigured 1688 pipeline clears activity before optional provider downtime', async t => {
  const s = await setup(t, { state: { supplier1688: supplier({ rateTrial: null, ratePolicy: { rateTrial: null } }) } });
  s.state.supplier1688.pipeline = null;
  await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().checks.supplier1688.hasActivity, false);
  assert.equal(s.monitor.snapshot().checks.supplier1688.runId, null);
  s.state.supplier1688 = { available: false, pipeline: null, errorCode: 'BRIDGE_UNAVAILABLE' };
  for (let index = 0; index < 4; index++) await s.monitor.check('supplier1688');
  assert.equal(s.monitor.snapshot().checks.supplier1688.status, 'unavailable');
  assert.equal(s.monitor.snapshot().checks.supplier1688.hasActivity, false);
  assert.equal(s.monitor.snapshot().events.length, 0);
});
