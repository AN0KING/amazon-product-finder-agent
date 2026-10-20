import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageSearchRatePolicy } from '../lib/image-search-rate-policy.mjs';

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-slow-queue-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 19);
  const file = path.join(directory, 'rate.json');
  const make = options => new ImageSearchRatePolicy({ file, now: () => now, ...options });
  return { file, make, advance(ms) { now += ms; }, now: () => now };
}

test('ordinary searches cannot dispatch at the former 18-second cadence', async t => {
  const f = await setup(t);
  const policy = f.make({ minGapMs: 18_000, cooldownMs: 20_000 });
  await policy.initialize();
  for (let i = 1; i <= 10; i++) {
    assert.equal(await policy.beginSearch({ taskId: `item-${i}` }), true);
    f.advance(18_000);
    assert.equal(await policy.beginSearch({ taskId: 'too-soon' }), false);
    f.advance(42_000);
  }
  assert.equal(await policy.beginSearch({ taskId: 'after-tenth' }), false);
  f.advance(119_999);
  assert.equal(await policy.beginSearch({ taskId: 'before-rest-end' }), false);
  f.advance(1);
  assert.equal(await policy.beginSearch({ taskId: 'after-rest-end' }), true);
  assert.equal(policy.state.searchCount, 11);
});

test('upgrade restores the full ordinary tenth-search rest from older saved state', async t => {
  const f = await setup(t);
  await fs.writeFile(f.file, JSON.stringify({ version: 1, searchCount: 10,
    lastStartedAt: f.now(), nextAllowedAt: f.now() + 38_000, cooldownUntil: 0,
    manualResumeRequired: false, rateTrial: null }));
  f.advance(38_000);
  const policy = f.make();
  await policy.initialize();
  assert.equal(policy.waitMs(), 142_000);
  assert.equal(await policy.beginSearch(), false);
  f.advance(142_000);
  assert.equal(await policy.beginSearch(), true);
});

test('ordinary pacing upgrade preserves a longer platform backoff and manual pause', async t => {
  const f = await setup(t);
  const policy = f.make();
  await policy.initialize();
  await policy.beginSearch();
  await policy.rateLimit({ retryAfter: '900' });
  await policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'blocked');
  const restarted = f.make();
  await restarted.initialize();
  assert.equal(restarted.waitMs(), 900_000);
  assert.equal(restarted.view().manualResumeRequired, true);
  assert.equal(restarted.view().blockedTaskId, 'blocked');
  f.advance(900_000);
  assert.equal(await restarted.beginSearch(), false);
});

test('a stopped rate trial cannot override conservative ordinary pacing after manual recovery', async t => {
  const f = await setup(t);
  const policy = f.make();
  await policy.initialize();
  await policy.startTrial();
  await policy.beginSearch({ taskId: 'trial-item' });
  await policy.pauseForManual('RISK_VERIFICATION_REQUIRED', 'trial-item');
  await policy.finishSearch({ taskId: 'trial-item', code: 'RISK_VERIFICATION_REQUIRED' });
  const historical = structuredClone(policy.state.rateTrial);
  await policy.markManualVerification({ purpose: 'image_search' });
  assert.equal(await policy.resume({ confirmed: true }), true);
  f.advance(40_000);
  assert.equal(await policy.beginSearch({ taskId: 'too-fast' }), false);
  f.advance(20_000);
  assert.equal(await policy.beginSearch({ taskId: 'ordinary' }), true);
  assert.equal(policy.view().minGapMs, 60_000);
  assert.equal(policy.view().cooldownEvery, 10);
  assert.equal(policy.view().cooldownMs, 120_000);
  assert.deepEqual(policy.state.rateTrial, historical);
  const restarted = f.make();
  await restarted.initialize();
  assert.equal(restarted.view().minGapMs, 60_000);
  assert.deepEqual(restarted.state.rateTrial, historical);
});
