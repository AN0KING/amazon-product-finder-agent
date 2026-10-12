import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageSearchRatePolicy, classifySearchFailure } from '../lib/image-search-rate-policy.mjs';

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-rate-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 8, 24);
  const file = path.join(dir, 'policy.json');
  const policy = new ImageSearchRatePolicy({ file, now: () => clock, ...options });
  await policy.initialize();
  return { policy, file, now: () => clock, advance: ms => { clock += ms; }, dir };
}

test('configuration can only slow conservative task frequency; Infinity uses defaults', async t => {
  const { policy, file } = await fixture(t, { minGapMs: 1, cooldownMs: 1 });
  assert.equal(policy.view().minGapMs, 18_000);
  assert.equal(policy.view().maxConcurrent, 1);
  assert.equal(policy.view().cooldownMs, 20_000);
  const slow = new ImageSearchRatePolicy({ file, minGapMs: 120_000, cooldownMs: 600_000 });
  assert.equal(slow.view().minGapMs, 120_000);
  assert.equal(slow.view().cooldownMs, 600_000);
  assert.equal(new ImageSearchRatePolicy({ file, minGapMs: Infinity }).view().minGapMs, 18_000);
});

test('reservation persists before dispatch and tenth search adds a short pacing rest', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 10; i++) {
    assert.equal(await f.policy.beginSearch(), true);
    assert.equal(await f.policy.beginSearch(), false);
    assert.equal(JSON.parse(await fs.readFile(f.file)).searchCount, i);
    assert.equal(f.policy.waitMs(), i === 10 ? 38_000 : 18_000);
    if (i < 10) f.advance(18_000);
  }
  f.advance(18_000);
  assert.equal(await f.policy.beginSearch(), false);
  f.advance(20_000);
  assert.equal(await f.policy.beginSearch(), true);
});

test('simultaneous reservation requests allow one search only', async t => {
  const { policy } = await fixture(t);
  assert.equal((await Promise.all(Array.from({ length: 12 }, () => policy.beginSearch()))).filter(Boolean).length, 1);
});

test('timestamps and count survive restart, including tenth-search cooldown', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) { await f.policy.beginSearch(); if (i < 9) f.advance(18_000); }
  const restarted = new ImageSearchRatePolicy({ file: f.file, now: f.now });
  await restarted.initialize();
  assert.equal(restarted.state.searchCount, 10);
  assert.equal(restarted.waitMs(), 38_000);
  assert.equal(await restarted.beginSearch(), false);
});

test('historic risk blocks all new searches indefinitely and survives restart', async t => {
  const f = await fixture(t);
  await f.policy.initialize([{ id: 'old-risk', status: 'risk_blocked', updatedAt: new Date(f.now()).toISOString() }]);
  f.advance(10 * 24 * 60 * 60_000);
  const restarted = new ImageSearchRatePolicy({ file: f.file, now: f.now });
  await restarted.initialize();
  assert.equal(restarted.view().manualResumeRequired, true);
  assert.equal(restarted.view().blockedTaskId, 'old-risk');
  assert.equal(await restarted.beginSearch(), false);
});

test('only successful image verification then explicit confirmation resumes risk pause', async t => {
  const f = await fixture(t);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  assert.equal(await f.policy.resume({ confirmed: true }), false);
  assert.equal(await f.policy.markManualVerification({ purpose: 'login' }), false);
  assert.equal(await f.policy.resume({ confirmed: true }), false);
  f.advance(1);
  assert.equal(await f.policy.markManualVerification({ purpose: 'image_search' }), true);
  assert.equal(await f.policy.beginSearch(), false);
  assert.equal(await f.policy.resume({}), false);
  assert.equal(await f.policy.resume({ confirmed: true }), true);
  assert.equal(await f.policy.beginSearch(), false);
  f.advance(20_000);
  assert.equal(await f.policy.beginSearch(), true);
});

test('another risk invalidates a prior manual verification', async t => {
  const f = await fixture(t);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'one');
  await f.policy.markManualVerification({ purpose: 'image_search' });
  f.advance(1);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'two');
  assert.equal(f.policy.view().manualVerificationCompletedAt, null);
  assert.equal(await f.policy.resume({ confirmed: true }), false);
});

test('manual verification proof persists without automatically resuming', async t => {
  const f = await fixture(t);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'one');
  await f.policy.markManualVerification({ purpose: 'image_search' });
  const restarted = new ImageSearchRatePolicy({ file: f.file, now: f.now });
  await restarted.initialize([{ id: 'one', status: 'risk_blocked' }]);
  assert.equal(restarted.view().manualResumeRequired, true);
  assert.ok(restarted.view().manualVerificationCompletedAt);
  assert.equal(await restarted.resume({ confirmed: true }), true);
});

test('plain login can prove expired-auth pause but still requires explicit resume', async t => {
  const { policy } = await fixture(t);
  await policy.pauseForManual('AUTH_REQUIRED', 'one');
  assert.equal(await policy.markManualVerification({ purpose: 'login' }), true);
  assert.equal(policy.view().manualResumeRequired, true);
  assert.equal(await policy.resume({ confirmed: true }), true);
});

for (const [name, error, expected] of [
  ['default', {}, 300_000], ['short seconds', { retryAfter: '10' }, 300_000],
  ['long seconds', { retryAfter: '600' }, 600_000],
  ['headers', { headers: { 'retry-after': '900' } }, 900_000],
  ['http date', { retryAfter: 'Thu, 24 Sep 2026 00:10:00 GMT' }, 600_000],
]) test(`normal 429 honors ${name}`, async t => {
  const { policy } = await fixture(t);
  await policy.rateLimit(error);
  assert.equal(policy.waitMs(), expected);
  assert.equal(policy.view().manualResumeRequired, false);
  assert.equal(policy.view().pausedReason, 'RATE_LIMITED');
});

test('bad stored state fails closed until manual recovery', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, '{bad json');
  const restarted = new ImageSearchRatePolicy({ file: f.file, now: f.now });
  await restarted.initialize();
  assert.equal(restarted.view().pausedReason, 'RATE_STATE_UNREADABLE');
  assert.equal(await restarted.beginSearch(), false);
});

test('failed persistence never grants a dispatch reservation', async t => {
  const { policy, dir } = await fixture(t);
  policy.file = dir;
  await assert.rejects(policy.beginSearch());
});

test('failed resume persistence preserves the manual pause in memory', async t => {
  const f = await fixture(t);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk');
  await f.policy.markManualVerification({ purpose: 'image_search' });
  f.policy.file = f.dir;
  await assert.rejects(f.policy.resume({ confirmed: true }));
  assert.equal(f.policy.view().manualResumeRequired, true);
  assert.equal(f.policy.view().blockedTaskId, 'risk');
  f.advance(24 * 60 * 60_000);
  assert.equal(await f.policy.beginSearch(), false);
});

test('failed pause persistence still blocks new searches in memory', async t => {
  const { policy, dir } = await fixture(t);
  policy.file = dir;
  await assert.rejects(policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'risk'));
  assert.equal(policy.view().manualResumeRequired, true);
  assert.equal(await policy.beginSearch(), false);
});

test('captcha takes precedence over HTTP 429; ordinary 429 uses cooldown', () => {
  assert.equal(classifySearchFailure({ code: 'RATE_LIMITED', status: 429, message: '请完成滑块验证' }), 'manual');
  assert.equal(classifySearchFailure({ code: 'CAPTCHA_REQUIRED' }), 'manual');
  assert.equal(classifySearchFailure({ status: 429 }), 'rate');
  assert.equal(classifySearchFailure({ code: 'NOT_LOGGED_IN' }), 'login');
});


async function runSearch(f, taskId, { success = true, code = null } = {}) {
  assert.equal(await f.policy.beginSearch({ taskId }), true);
  assert.equal(await f.policy.finishSearch({ taskId, success, code }), true);
}

async function passFirstHour(f) {
  for (let i = 0; i < 90; i++) {
    await runSearch(f, `first-${i}`);
    f.advance(40_000);
  }
  assert.equal(await f.policy.beginSearch({ taskId: 'second-0' }), true);
}

test('trial configuration waits for real work and is idempotent across repeated requests', async t => {
  const f = await fixture(t);
  const first = await f.policy.startTrial({ startPerHour: 90, stepPerHour: 10, stageDurationMs: 3_600_000 });
  f.advance(5 * 3_600_000);
  assert.equal(f.policy.view().rateTrial.status, 'waiting');
  assert.equal(f.policy.view().rateTrial.currentStage, null);
  assert.deepEqual(await f.policy.startTrial(), first);
  await assert.rejects(f.policy.startTrial({ startPerHour: 100 }), { code: 'RATE_TRIAL_EXISTS' });
  await runSearch(f, 'first');
  const trial = f.policy.view().rateTrial;
  assert.equal(trial.currentStage.startedAt, f.now());
  assert.equal(trial.currentStage.started, 1);
  assert.equal(trial.targetPerHour, 90);
  assert.equal(trial.lastPassedPerHour, null);
  assert.equal(f.policy.waitMs(), 40_000);
  assert.equal(f.policy.view().cooldownEvery, 0);
});

test('a fully observed hour promotes 90 to 100 then 110, without routine tenth-search rests', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  await passFirstHour(f);
  let trial = f.policy.view().rateTrial;
  assert.equal(trial.targetPerHour, 100);
  assert.equal(trial.lastPassedPerHour, 90);
  assert.equal(trial.history.length, 1);
  assert.equal(trial.history[0].elapsedMs, 3_600_000);
  assert.equal(trial.history[0].actualPerHour, 90);
  assert.equal(trial.history[0].successPerHour, 90);
  assert.equal(trial.history[0].outcome, 'passed');
  assert.equal(f.policy.waitMs(), 36_000);
  assert.equal(await f.policy.finishSearch({ taskId: 'second-0', success: true }), true);
  for (let i = 1; i < 100; i++) {
    f.advance(36_000);
    await runSearch(f, `second-${i}`);
  }
  f.advance(36_000);
  assert.equal(await f.policy.beginSearch({ taskId: 'third-0' }), true);
  trial = f.policy.view().rateTrial;
  assert.equal(trial.targetPerHour, 110);
  assert.equal(trial.lastPassedPerHour, 100);
  assert.equal(trial.history[1].actualPerHour, 100);
  assert.equal(trial.history[1].succeeded, 100);
  assert.equal(f.policy.waitMs(), Math.ceil(3_600_000 / 110));
});

test('an unfinished reservation prevents another search and duplicate or foreign results do not count', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  const reserved = await Promise.all(Array.from({ length: 12 }, (_, i) => f.policy.beginSearch({ taskId: `task-${i}` })));
  assert.equal(reserved.filter(Boolean).length, 1);
  f.advance(40_000);
  assert.equal(await f.policy.beginSearch({ taskId: 'another' }), false);
  assert.equal(await f.policy.finishSearch({ taskId: 'foreign', success: true }), false);
  assert.equal(await f.policy.finishSearch({ taskId: 'task-0', success: false, code: 'SEARCH_FAILED' }), true);
  assert.equal(await f.policy.finishSearch({ taskId: 'task-0', success: true }), false);
  const trial = f.policy.view().rateTrial;
  assert.equal(trial.currentStage.started, 1);
  assert.equal(trial.currentStage.succeeded, 0);
  assert.equal(trial.currentStage.failed, 1);
  assert.equal(trial.currentStage.pending, 0);
});

test('a long gap interrupts the current hour instead of promoting or skipping stages', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  await runSearch(f, 'before-gap');
  f.advance(4 * 3_600_000);
  await runSearch(f, 'after-gap');
  const trial = f.policy.view().rateTrial;
  assert.equal(trial.targetPerHour, 90);
  assert.equal(trial.lastPassedPerHour, null);
  assert.equal(trial.history[0].outcome, 'interrupted');
  assert.equal(trial.history[0].reason, 'observation_gap');
  assert.equal(trial.currentStage.started, 1);
  assert.equal(trial.currentStage.startedAt, f.now());
});

test('an observed hour below the target stops automatic promotion and reports actual throughput', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  for (let i = 0; i < 72; i++) {
    await runSearch(f, `slow-${i}`);
    f.advance(50_000);
  }
  await runSearch(f, 'after-limited');
  let trial = f.policy.view().rateTrial;
  assert.equal(trial.status, 'throughput_limited');
  assert.equal(trial.targetPerHour, 90);
  assert.equal(trial.lastPassedPerHour, null);
  assert.equal(trial.history[0].actualPerHour, 72);
  assert.equal(trial.history[0].succeeded, 72);
  assert.equal(trial.history[0].outcome, 'throughput_limited');
  f.advance(5 * 3_600_000);
  await runSearch(f, 'still-fixed');
  trial = f.policy.view().rateTrial;
  assert.equal(trial.status, 'throughput_limited');
  assert.equal(trial.targetPerHour, 90);
  assert.equal(f.policy.waitMs(), 40_000);
  f.advance(40_000);
  await f.policy.beginSearch({ taskId: 'later-slider' });
  f.advance(5_000);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'later-slider');
  await f.policy.finishSearch({ taskId: 'later-slider', success: false, code: 'RISK_VERIFICATION_REQUIRED' });
  trial = f.policy.view().rateTrial;
  assert.equal(trial.status, 'stopped_risk');
  assert.equal(trial.history[0].started, 72);
  assert.equal(trial.trigger.started, 75);
  assert.equal(trial.trigger.succeeded, 74);
  assert.equal(trial.trigger.failed, 1);
  assert.equal(trial.trigger.elapsedMs, 6 * 3_600_000 + 45_000);
  assert.equal(trial.trigger.actualPerHour, 75 * 3_600_000 / trial.trigger.elapsedMs);
  assert.equal(trial.trigger.previousPassedPerHour, null);
});

test('restart preserves configuration and counters but restarts the unverified hour', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  await runSearch(f, 'done');
  f.advance(40_000);
  await f.policy.beginSearch({ taskId: 'unknown-result' });
  f.advance(4 * 3_600_000);
  const restarted = new ImageSearchRatePolicy({ file: f.file, now: f.now });
  await restarted.initialize();
  let trial = restarted.view().rateTrial;
  assert.equal(trial.status, 'waiting');
  assert.equal(trial.targetPerHour, 90);
  assert.equal(trial.history[0].started, 2);
  assert.equal(trial.history[0].succeeded, 1);
  assert.equal(trial.history[0].pending, 1);
  assert.equal(trial.history[0].reason, 'service_restart');
  assert.equal(await restarted.finishSearch({ taskId: 'unknown-result', success: true }), false);
  assert.equal(await restarted.beginSearch({ taskId: 'new-task' }), true);
  trial = restarted.view().rateTrial;
  assert.equal(trial.currentStage.started, 1);
  assert.equal(trial.currentStage.startedAt, f.now());
  assert.equal(trial.lastPassedPerHour, null);
});

test('first slider freezes its measured rate and queue resume never restarts the staircase', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  await passFirstHour(f);
  f.advance(5_000);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'second-0');
  await f.policy.finishSearch({ taskId: 'second-0', success: false, code: 'RISK_VERIFICATION_REQUIRED' });
  let trial = f.policy.view().rateTrial;
  assert.equal(trial.status, 'stopped_risk');
  assert.equal(trial.trigger.targetPerHour, 100);
  assert.equal(trial.trigger.previousPassedPerHour, 90);
  assert.equal(trial.trigger.elapsedMs, 5_000);
  assert.equal(trial.trigger.started, 1);
  assert.equal(trial.trigger.failed, 1);
  assert.equal(await f.policy.beginSearch({ taskId: 'blocked' }), false);
  await f.policy.markManualVerification({ purpose: 'image_search' });
  assert.equal(await f.policy.resume({ confirmed: true }), true);
  f.advance(3 * 3_600_000);
  const frozen = structuredClone(f.policy.view().rateTrial.trigger);
  await runSearch(f, 'user-resumed');
  await f.policy.startTrial();
  trial = f.policy.view().rateTrial;
  assert.equal(trial.status, 'stopped_risk');
  assert.equal(trial.targetPerHour, 100);
  assert.deepEqual(trial.trigger, frozen);
  assert.equal(trial.history.length, 1);
  assert.equal(f.policy.waitMs(), 36_000);
});

test('enabling the trial during a manual pause cannot clear that pause or verification proof', async t => {
  const f = await fixture(t);
  await f.policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'old-risk');
  await f.policy.startTrial();
  assert.equal(f.policy.view().manualResumeRequired, true);
  assert.equal(f.policy.view().blockedTaskId, 'old-risk');
  assert.equal(f.policy.view().rateTrial.status, 'stopped_risk');
  assert.equal(await f.policy.beginSearch({ taskId: 'blocked' }), false);
});

test('429 interrupts only the observed hour and preserves the full platform backoff', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  await f.policy.beginSearch({ taskId: 'rate-limited' });
  await f.policy.rateLimit({ retryAfter: '600' });
  await f.policy.finishSearch({ taskId: 'rate-limited', success: false, code: 'RATE_LIMITED' });
  assert.equal(f.policy.waitMs(), 600_000);
  assert.equal(f.policy.view().rateTrial.status, 'waiting');
  assert.equal(f.policy.view().rateTrial.history[0].reason, 'RATE_LIMITED');
  assert.equal(f.policy.view().rateTrial.history[0].failed, 1);
  assert.equal(await f.policy.beginSearch({ taskId: 'blocked' }), false);
  f.advance(600_000);
  await runSearch(f, 'retry');
  assert.equal(f.policy.view().rateTrial.targetPerHour, 90);
  assert.equal(f.policy.view().rateTrial.currentStage.started, 1);
  assert.equal(f.policy.view().rateTrial.lastPassedPerHour, null);
});

test('failed trial writes do not grant reservations, count phantom searches or lose a result', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  f.policy.file = f.dir;
  await assert.rejects(f.policy.beginSearch({ taskId: 'not-dispatched' }));
  assert.equal(f.policy.state.searchCount, 0);
  assert.equal(f.policy.view().rateTrial.currentStage, null);
  assert.equal(f.policy.view().rateTrial.activeSearch, null);
  f.policy.file = f.file;
  await f.policy.beginSearch({ taskId: 'real' });
  f.policy.file = f.dir;
  await assert.rejects(f.policy.finishSearch({ taskId: 'real', success: true }));
  assert.equal(f.policy.view().rateTrial.currentStage.succeeded, 0);
  assert.equal(f.policy.view().rateTrial.activeSearch.taskId, 'real');
  f.policy.file = f.file;
  assert.equal(await f.policy.finishSearch({ taskId: 'real', success: true }), true);
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(saved.rateTrial.currentStage.succeeded, 1);
});

test('invalid saved trial state fails closed instead of silently disabling pacing', async t => {
  const f = await fixture(t);
  await f.policy.startTrial();
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  saved.rateTrial.targetPerHour = 0;
  await fs.writeFile(f.file, JSON.stringify(saved));
  const restarted = new ImageSearchRatePolicy({ file: f.file, now: f.now });
  await restarted.initialize();
  assert.equal(restarted.view().manualResumeRequired, true);
  assert.equal(restarted.view().pausedReason, 'RATE_STATE_UNREADABLE');
  assert.equal(await restarted.beginSearch(), false);
});
