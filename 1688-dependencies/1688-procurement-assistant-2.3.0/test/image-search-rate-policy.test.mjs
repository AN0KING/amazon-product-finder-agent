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
  assert.equal(policy.view().minGapMs, 30_000);
  assert.equal(policy.view().maxConcurrent, 1);
  assert.equal(policy.view().cooldownMs, 30_000);
  const slow = new ImageSearchRatePolicy({ file, minGapMs: 120_000, cooldownMs: 600_000 });
  assert.equal(slow.view().minGapMs, 120_000);
  assert.equal(slow.view().cooldownMs, 600_000);
  assert.equal(new ImageSearchRatePolicy({ file, minGapMs: Infinity }).view().minGapMs, 30_000);
});

test('reservation persists before dispatch and fifth search adds a short pacing rest', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 5; i++) {
    assert.equal(await f.policy.beginSearch(), true);
    assert.equal(await f.policy.beginSearch(), false);
    assert.equal(JSON.parse(await fs.readFile(f.file)).searchCount, i);
    assert.equal(f.policy.waitMs(), i === 5 ? 60_000 : 30_000);
    if (i < 5) f.advance(30_000);
  }
  f.advance(30_000);
  assert.equal(await f.policy.beginSearch(), false);
  f.advance(30_000);
  assert.equal(await f.policy.beginSearch(), true);
});

test('simultaneous reservation requests allow one search only', async t => {
  const { policy } = await fixture(t);
  assert.equal((await Promise.all(Array.from({ length: 12 }, () => policy.beginSearch()))).filter(Boolean).length, 1);
});

test('timestamps and count survive restart, including fifth-search cooldown', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) { await f.policy.beginSearch(); if (i < 4) f.advance(30_000); }
  const restarted = new ImageSearchRatePolicy({ file: f.file, now: f.now });
  await restarted.initialize();
  assert.equal(restarted.state.searchCount, 5);
  assert.equal(restarted.waitMs(), 60_000);
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
  f.advance(30_000);
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
