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

test('uniform ordinary pacing starts at most 70 searches in every rolling hour', async t => {
  const f = await setup(t);
  const policy = f.make({ minGapMs: 18_000, cooldownMs: 20_000 });
  await policy.initialize();
  const starts = [];
  for (let i = 0; i < 145; i++) {
    assert.equal(await policy.beginSearch({ taskId: `item-${i}` }), true);
    starts.push(f.now());
    assert.ok(starts.filter(at => at > f.now() - 3_600_000).length <= 70);
    f.advance(51_428);
    assert.equal(await policy.beginSearch({ taskId: 'too-soon' }), false);
    f.advance(1);
  }
  assert.equal(policy.state.searchCount, 145);
  assert.equal(starts[70] - starts[0], 3_600_030);
});

test('upgrade keeps an already reserved old rest without adding future tenth-search rests', async t => {
  const f = await setup(t);
  await fs.writeFile(f.file, JSON.stringify({ version: 1, searchCount: 10,
    lastStartedAt: f.now(), nextAllowedAt: f.now() + 180_000, cooldownUntil: 0,
    manualResumeRequired: false, rateTrial: null }));
  f.advance(38_000);
  const policy = f.make();
  await policy.initialize();
  assert.equal(policy.waitMs(), 142_000);
  assert.equal(await policy.beginSearch(), false);
  f.advance(142_000);
  assert.equal(await policy.beginSearch(), true);
  assert.equal(policy.waitMs(), 51_429);
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
  f.advance(11_429);
  assert.equal(await policy.beginSearch({ taskId: 'ordinary' }), true);
  assert.equal(policy.view().minGapMs, 51_429);
  assert.equal(policy.view().cooldownEvery, 0);
  assert.equal(policy.view().cooldownMs, 0);
  assert.deepEqual(policy.state.rateTrial, historical);
  const restarted = f.make();
  await restarted.initialize();
  assert.equal(restarted.view().minGapMs, 51_429);
  assert.deepEqual(restarted.state.rateTrial, historical);
});
