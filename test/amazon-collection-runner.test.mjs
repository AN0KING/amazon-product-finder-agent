import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AmazonCollectionRunner } from '../lib/amazon-collection-runner.mjs';

const A = 'B0FP55F3Q9';
const B = 'B0FPQN6JGG';
const RUN = 'memory-run';
const EPOCH = Date.parse('2026-09-24T01:00:00.000Z');
const copy = value => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const target = asin => ({ asin, sourceAsin: asin, sourceStores: [] });
const completeItem = asin => ({
  asin, sourceAsin: asin, marketplace: 'CA', detailStatus: 'success', detailParserVersion: 5,
  title: `Collected product ${asin}`, imageUrl: 'https://m.media-amazon.com/images/I/example.jpg',
  currentPrice: 9.99, productWeightKg: 0.06, rating: 4.1, reviewCount: 22,
  fieldSources: { productWeightKg: 'amazon_product_page', currentPrice: 'amazon_product_page' },
  priceEvidence: { asin, currency: 'CAD', source: 'visible_main_price', rawText: '$9.99', selector: '#corePrice_feature_div .priceToPay' },
});
const failedItem = (asin, code = 'AMAZON_FETCH_TIMEOUT') => ({
  asin, sourceAsin: asin, marketplace: 'CA', detailStatus: 'failed', detailRetryable: true, detailErrorCode: code,
});

class MemoryStore {
  constructor() {
    this.records = new Map();
    this.active = null;
    this.nextRead = null;
  }
  async getRunSnapshot() {
    return { runState: { analysisSourceMode: 'amazon_only', marketplace: 'CA', criteria: {} }, storeList: { stores: [] } };
  }
  async getActiveAmazonCollection() {
    return this.active ? { runId: this.active, ...copy(this.records.get(this.active)) } : null;
  }
  async getAmazonCollection(runId) {
    const snapshot = copy(this.records.get(runId) || { job: null, items: {} });
    const gate = this.nextRead;
    this.nextRead = null;
    if (gate) { gate.started.resolve(); await gate.release.promise; }
    return snapshot;
  }
  async updateAmazonCollection(runId, update, { activate = false } = {}) {
    const previous = copy(this.records.get(runId) || { job: null, items: {} });
    const next = update(previous);
    this.records.set(runId, copy(next));
    if (activate) this.active = runId;
    return copy(next);
  }
  read() { return copy(this.records.get(RUN)); }
  holdNextRead() {
    const gate = { started: deferred(), release: deferred() };
    this.nextRead = gate;
    return gate;
  }
}

async function setup(t, options = {}) {
  const store = options.store || new MemoryStore();
  const clock = options.clock || { value: EPOCH };
  const calls = [];
  const busy = [];
  const runner = new AmazonCollectionRunner({
    store, now: () => clock.value, intervalMs: 10,
    seed: async () => ({ discoveryComplete: true, targets: (options.asins || [A]).map(target), items: options.items || [] }),
    discover: async () => { throw new Error('Unexpected discovery request'); },
    loadDetails: async (job, asins, signal) => {
      calls.push([...asins]);
      return options.loadDetails ? options.loadDetails(job, asins, signal, calls.length) : asins.map(completeItem);
    },
    onBusy: value => busy.push(value),
    ...(options.config || {}),
  });
  t.after(() => runner.close());
  await runner.initialize({ timer: false });
  await runner.start(RUN);
  return { store, clock, calls, busy, runner, advance: ms => { clock.value += ms; } };
}

test('collection owns its signal and finishes after the page request is disconnected', async t => {
  const pageRequest = new AbortController();
  const entered = deferred();
  const result = deferred();
  let workerSignal;
  const h = await setup(t, { loadDetails: (_job, _asins, signal) => {
    workerSignal = signal; entered.resolve(); return result.promise;
  } });
  const tick = h.runner.tick();
  await entered.promise;
  pageRequest.abort(new Error('Browser tab disconnected'));
  assert.notEqual(workerSignal, pageRequest.signal);
  assert.equal(workerSignal.aborted, false);
  result.resolve([completeItem(A)]);
  await tick;
  assert.equal(h.store.read().job.status, 'completed');
  assert.equal(h.store.read().job.tasks[A].status, 'complete');
  assert.equal(h.store.read().items[A].currentPrice, 9.99);
});

test('restart recovers running work as queued without requesting completed ASINs again', async t => {
  const h = await setup(t, { asins: [A, B], items: [completeItem(A)] });
  await h.runner.close();
  h.store.records.get(RUN).job.status = 'running'; // Persisted state from an abruptly stopped process.
  const restarted = await setup(t, { store: h.store, clock: h.clock });
  assert.equal(restarted.store.read().job.status, 'queued');
  assert.equal(restarted.store.read().job.restartCount, 1);
  await restarted.runner.tick();
  assert.deepEqual(restarted.calls, [[B]]);
  assert.equal(restarted.store.read().job.tasks[A].attempts, 1);
  assert.equal(restarted.store.read().job.tasks[B].status, 'complete');
  assert.equal(restarted.store.read().job.status, 'completed');
});

test('one successful page visit with missing fields is partial and never causes another automatic request', async t => {
  const h = await setup(t, { loadDetails: async () => [{ ...completeItem(A), currentPrice: null, priceEvidence: null, productWeightKg: null }] });
  await h.runner.tick();
  const { job, items } = h.store.read();
  assert.equal(job.tasks[A].attempts, 1);
  assert.equal(job.status, 'completed');
  assert.equal(job.nextRetryAt, null);
  assert.equal(items[A].collectionQuality.fields.price.status, 'unavailable');
  assert.equal(job.tasks[A].status, 'partial');
  assert.equal(job.status, 'completed');
  assert.equal(job.counts.partial, 1);
  assert.deepEqual(items[A].collectionQuality.requiredMissing, ['price', 'weight']);
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
});

test('seeded successful results keep absent title and image as partial without opening their page again', async t => {
  const source = { ...completeItem(A), title: null, imageUrl: null, productWeightKg: null };
  const h = await setup(t, { items: [source] });
  const seeded = h.store.read();
  assert.equal(seeded.job.tasks[A].status, 'partial');
  assert.deepEqual(seeded.items[A].collectionQuality.requiredMissing, ['weight', 'title', 'image']);
  await h.runner.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.read().job.status, 'completed');
  assert.equal(h.store.read().items[A].title, null);
  assert.equal(h.store.read().items[A].imageUrl, null);
});

test('only an explicit retry_missing requests another page, and one successful response ends that retry', async t => {
  const partial = { ...completeItem(A), productWeightKg: null };
  const h = await setup(t, { items: [partial], loadDetails: async () => [partial] });
  await h.runner.tick();
  assert.equal(h.calls.length, 0);
  await h.runner.command(RUN, 'resume');
  await h.runner.tick();
  assert.equal(h.calls.length, 0);
  await h.runner.command(RUN, 'retry_missing');
  assert.equal(h.store.read().job.tasks[A].status, 'pending');
  assert.equal(h.store.read().job.tasks[A].attempts, 0);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.read().job.tasks[A].status, 'partial');
  assert.equal(h.store.read().job.tasks[A].attempts, 1);
  assert.equal(h.store.read().job.tasks[A].nextRetryAt, null);
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
});

test('targeted retry visits only the selected existing incomplete ASIN and deduplicates the selection', async t => {
  const partial = asin => ({ ...completeItem(asin), currentPrice: null, priceEvidence: null });
  const h = await setup(t, { asins: [A, B], items: [partial(A), partial(B)] });
  await h.runner.tick();
  const before = h.store.read();
  await h.runner.command(RUN, 'retry_missing', { asins: [A, A.toLowerCase()] });
  assert.deepEqual(h.store.read().items, before.items, 'Scheduling must retain all existing source results.');
  assert.equal(h.store.read().job.id, before.job.id);
  assert.deepEqual(Object.keys(h.store.read().job.tasks), [A, B]);
  assert.deepEqual(h.store.read().job.targetedRetry.asins, [A]);
  await h.runner.tick();
  const after = h.store.read();
  assert.deepEqual(h.calls, [[A]]);
  assert.equal(after.job.status, 'completed');
  assert.equal(after.job.targetedRetry, undefined);
  assert.equal(after.items[A].currentPrice, 9.99);
  assert.deepEqual(after.items[B], before.items[B]);
  assert.deepEqual(after.job.tasks[B], before.job.tasks[B]);
  await h.runner.command(RUN, 'retry_missing', { asins: [A] });
  await h.runner.tick();
  assert.deepEqual(h.calls, [[A]], 'A resolved ASIN must not be requested again.');
});

for (const status of ['paused', 'needs_attention']) {
  test(`targeted retry restores ${status} without visiting unrelated pending or failed tasks`, async t => {
    const partial = { ...completeItem(A), productWeightKg: null };
    const h = await setup(t, { asins: [A, B], items: [partial], loadDetails: async () => [partial] });
    const saved = h.store.records.get(RUN);
    Object.assign(saved.job, { status, enabled: false, causeCode: status === 'paused' ? 'USER_PAUSED' : 'AMAZON_ACCESS_CHALLENGE', restrictionCount: 3 });
    saved.job.tasks[B].status = status === 'paused' ? 'pending' : 'failed';
    saved.job.tasks[B].attempts = 2;
    const before = h.store.read();
    await h.runner.tick();
    assert.equal(h.calls.length, 0);
    await h.runner.command(RUN, 'retry_missing', { asins: [A] });
    await h.runner.tick();
    const after = h.store.read();
    assert.deepEqual(h.calls, [[A]]);
    assert.equal(after.job.status, status);
    assert.equal(after.job.enabled, false);
    assert.equal(after.job.causeCode, before.job.causeCode);
    assert.equal(after.job.restrictionCount, 3);
    assert.equal(after.job.tasks[A].status, 'partial');
    assert.deepEqual(after.job.tasks[B], before.job.tasks[B]);
    h.advance(3_600_000);
    await h.runner.tick();
    assert.deepEqual(h.calls, [[A]], 'Successful partial results must end the requested retry.');
  });
}

test('targeted retry rejects unknown ASINs, invalid selections and unrelated actions without mutation', async t => {
  const h = await setup(t, { items: [{ ...completeItem(A), productWeightKg: null }] });
  await h.runner.tick();
  const before = h.store.read();
  for (const asins of [[], null, 'not-an-array', ['invalid'], [123], Array(101).fill(A)]) {
    await assert.rejects(h.runner.command(RUN, 'retry_missing', { asins }), { code: 'INVALID_COLLECTION_ASINS' });
  }
  await assert.rejects(h.runner.command(RUN, 'pause', { asins: [A] }), { code: 'INVALID_COLLECTION_ASINS' });
  await assert.rejects(h.runner.command(RUN, 'retry_missing', { asins: [A, B] }), { code: 'COLLECTION_ASIN_NOT_FOUND' });
  assert.deepEqual(h.store.read(), before);
  assert.equal(h.calls.length, 0);
});

test('targeted retry cannot interrupt a queued or active collection worker', async t => {
  const entered = deferred();
  const result = deferred();
  const h = await setup(t, { loadDetails: () => { entered.resolve(); return result.promise; } });
  await assert.rejects(h.runner.command(RUN, 'retry_missing', { asins: [A] }), { code: 'COLLECTION_BUSY' });
  const pending = h.runner.tick();
  await entered.promise;
  await assert.rejects(h.runner.command(RUN, 'retry_missing', { asins: [A] }), { code: 'COLLECTION_BUSY' });
  result.resolve([completeItem(A)]);
  await pending;
  assert.deepEqual(h.calls, [[A]]);
});

test('targeted retry scope survives pause and restart and cannot be replaced while unfinished', async t => {
  const first = await setup(t, { asins: [A, B], items: [{ ...completeItem(A), productWeightKg: null }] });
  await first.runner.command(RUN, 'pause');
  const otherTask = first.store.read().job.tasks[B];
  await first.runner.command(RUN, 'retry_missing', { asins: [A] });
  await first.runner.command(RUN, 'pause');
  await first.runner.close();
  const restarted = await setup(t, { store: first.store, clock: first.clock });
  restarted.advance(3_600_000);
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 0);
  assert.deepEqual(restarted.store.read().job.targetedRetry.asins, [A]);
  await assert.rejects(restarted.runner.command(RUN, 'retry_missing', { asins: [B] }), { code: 'COLLECTION_BUSY' });
  await restarted.runner.command(RUN, 'resume');
  await restarted.runner.tick();
  assert.deepEqual(restarted.calls, [[A]]);
  assert.deepEqual(restarted.store.read().job.tasks[B], otherTask);
  assert.equal(restarted.store.read().job.status, 'paused');
  assert.equal(restarted.store.read().job.causeCode, 'USER_PAUSED');
});

test('targeted retry can retry a selected terminal failure without resetting other failure budgets', async t => {
  const h = await setup(t, { asins: [A, B] });
  const saved = h.store.records.get(RUN);
  Object.assign(saved.job, { status: 'completed', enabled: false });
  for (const asin of [A, B]) Object.assign(saved.job.tasks[asin], { status: 'failed', attempts: 3, lastCode: 'AMAZON_FETCH_TIMEOUT' });
  const before = h.store.read();
  await h.runner.command(RUN, 'retry_missing', { asins: [A] });
  await h.runner.tick();
  assert.deepEqual(h.calls, [[A]]);
  assert.equal(h.store.read().job.tasks[A].status, 'complete');
  assert.deepEqual(h.store.read().job.tasks[B], before.job.tasks[B]);
});

test('transport failure still retries, but a following successful partial page does not retry again', async t => {
  const h = await setup(t, { loadDetails: async (_job, _asins, _signal, count) => count === 1
    ? [failedItem(A)] : [{ ...completeItem(A), productWeightKg: null }],
  });
  await h.runner.tick();
  assert.equal(h.store.read().job.status, 'cooldown');
  h.advance(60_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.read().job.tasks[A].attempts, 2);
  assert.equal(h.store.read().job.tasks[A].status, 'partial');
  assert.equal(h.store.read().job.status, 'completed');
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 2);
});

test('restart removes legacy automatic missing-field retries without losing the successful result', async t => {
  const source = { ...completeItem(A), productWeightKg: null };
  const first = await setup(t, { items: [source] });
  await first.runner.close();
  const saved = first.store.records.get(RUN);
  saved.job.status = 'cooldown';
  saved.job.tasks[A].status = 'pending';
  saved.job.tasks[A].nextRetryAt = new Date(EPOCH + 120_000).toISOString();
  saved.job.nextRetryAt = saved.job.tasks[A].nextRetryAt;
  const restarted = await setup(t, { store: first.store, clock: first.clock });
  assert.equal(restarted.store.read().job.tasks[A].status, 'partial');
  assert.equal(restarted.store.read().job.tasks[A].attempts, 1);
  assert.equal(restarted.store.read().items[A].currentPrice, 9.99);
  assert.equal(restarted.store.read().items[A].collectionQuality.fields.weight.status, 'unavailable');
  restarted.advance(3_600_000);
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 0);
});

test('restart preserves a user-requested retry that has not visited the page yet', async t => {
  const source = { ...completeItem(A), productWeightKg: null };
  const first = await setup(t, { items: [source] });
  await first.runner.command(RUN, 'retry_missing');
  await first.runner.close();
  const restarted = await setup(t, { store: first.store, clock: first.clock, loadDetails: async () => [source] });
  assert.equal(restarted.store.read().job.tasks[A].status, 'pending');
  assert.equal(restarted.store.read().job.tasks[A].attempts, 0);
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.store.read().job.tasks[A].status, 'partial');
});

test('legacy migration preserves failed attempts even when older successful values were retained', async t => {
  const first = await setup(t, { items: [{ ...completeItem(A), productWeightKg: null }] });
  await first.runner.command(RUN, 'retry_missing');
  first.runner.loadDetails = async () => [failedItem(A)];
  await first.runner.tick();
  assert.equal(first.store.read().items[A].detailStatus, 'success');
  assert.equal(first.store.read().items[A].lastCollectionError.code, 'AMAZON_FETCH_TIMEOUT');
  await first.runner.close();
  const restarted = await setup(t, { store: first.store, clock: first.clock });
  assert.equal(restarted.store.read().job.tasks[A].status, 'pending');
  assert.equal(restarted.store.read().job.tasks[A].attempts, 1);
  restarted.advance(60_000);
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.store.read().job.tasks[A].status, 'complete');
});

test('ordinary failures stop at three attempts while other ASINs complete between retries', async t => {
  const h = await setup(t, { asins: [A, B], config: { batchSize: 1 },
    loadDetails: async (_job, asins) => asins.map(asin => asin === A ? failedItem(asin) : completeItem(asin)),
  });
  await h.runner.tick();
  assert.equal(h.store.read().job.status, 'queued');
  await h.runner.tick();
  assert.equal(h.store.read().job.tasks[B].status, 'complete');
  h.advance(60_000);
  await h.runner.tick();
  assert.equal(h.store.read().job.tasks[A].attempts, 2);
  h.advance(119_999);
  await h.runner.tick();
  assert.equal(h.calls.length, 3);
  h.advance(1);
  await h.runner.tick();
  assert.deepEqual(h.calls, [[A], [B], [A], [A]]);
  const { job } = h.store.read();
  assert.equal(job.status, 'completed');
  assert.equal(job.tasks[A].status, 'failed');
  assert.equal(job.tasks[A].attempts, 3);
  assert.deepEqual([job.counts.complete, job.counts.failed], [1, 1]);
  await h.runner.tick();
  assert.equal(h.calls.length, 4);
});

for (const code of ['AMAZON_ACCESS_CHALLENGE', 'AMAZON_HTTP_429']) {
  test(`${code} waits five then ten minutes and stops for attention on the third restriction`, async t => {
    const h = await setup(t, { loadDetails: async () => [failedItem(A, code)] });
    await h.runner.tick();
    assert.equal(h.store.read().job.restrictionCount, 1);
    assert.equal(Date.parse(h.store.read().job.nextRetryAt), EPOCH + 300_000);
    h.advance(299_999);
    await h.runner.tick();
    assert.equal(h.calls.length, 1);
    h.advance(1);
    await h.runner.tick();
    assert.equal(h.store.read().job.restrictionCount, 2);
    assert.equal(Date.parse(h.store.read().job.nextRetryAt), EPOCH + 900_000);
    h.advance(599_999);
    await h.runner.tick();
    assert.equal(h.calls.length, 2);
    h.advance(1);
    await h.runner.tick();
    const { job } = h.store.read();
    assert.equal(job.restrictionCount, 3);
    assert.equal(job.status, 'needs_attention');
    assert.equal(job.nextRetryAt, null);
    assert.equal(job.causeCode, code);
    h.advance(3_600_000);
    await h.runner.tick();
    assert.equal(h.calls.length, 3);
  });
}

test('manual pause aborts active collection, prevents stale writes, and never resumes on a timer tick', async t => {
  const entered = deferred();
  const result = deferred();
  let workerSignal;
  const h = await setup(t, { loadDetails: (_job, asins, signal, count) => {
    if (count > 1) return asins.map(completeItem);
    workerSignal = signal; entered.resolve(); return result.promise;
  } });
  const pending = h.runner.tick();
  await entered.promise;
  const paused = await h.runner.command(RUN, 'pause');
  assert.equal(paused.workerActive, false);
  await pending;
  assert.equal(workerSignal.aborted, true);
  result.resolve([completeItem(A)]);
  await Promise.resolve();
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.read().job.status, 'paused');
  assert.equal(h.store.read().job.enabled, false);
  assert.equal(h.store.read().items[A], undefined);
  await h.runner.command(RUN, 'resume');
  await h.runner.tick();
  assert.equal(h.store.read().job.tasks[A].status, 'complete');
  assert.equal(h.calls.length, 2);
});

test('a timed out request releases the worker and resumes its saved ASIN after cooldown', async t => {
  let firstSignal;
  const h = await setup(t, { config: { timeoutMs: 10, retryMs: 20 }, loadDetails: (_job, asins, signal, count) => {
    if (count > 1) return asins.map(completeItem);
    firstSignal = signal;
    return new Promise(() => {});
  } });
  // Keep the process alive while the runner's unref'ed deadline fires.
  await Promise.all([h.runner.tick(), delay(25)]);
  assert.equal(firstSignal.aborted, true);
  assert.equal(h.runner.work, null);
  assert.equal(h.store.read().job.causeCode, 'COLLECTION_TIMEOUT');
  assert.equal(h.store.read().job.status, 'cooldown');
  assert.equal(h.store.read().job.tasks[A].attempts, 1);
  h.advance(20);
  await h.runner.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.read().job.tasks[A].status, 'complete');
  assert.equal(h.store.read().job.status, 'completed');
});

test('competing timer ticks start only one worker and one request for an ASIN', async t => {
  const entered = deferred();
  const result = deferred();
  const h = await setup(t, { loadDetails: () => { entered.resolve(); return result.promise; } });
  const ticks = Array.from({ length: 20 }, () => h.runner.tick());
  await entered.promise;
  assert.equal(h.calls.length, 1);
  assert.equal((await h.runner.status()).workerActive, true);
  result.resolve([completeItem(A)]);
  await Promise.all(ticks);
  assert.deepEqual(h.busy, [true, false]);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
});

test('pause during a pending persistence read cannot be undone by that stale timer tick', async t => {
  const h = await setup(t);
  const gate = h.store.holdNextRead();
  const pendingTick = h.runner.tick();
  await gate.started.promise;
  await h.runner.command(RUN, 'pause');
  gate.release.resolve();
  await pendingTick;
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.read().job.status, 'paused');
  assert.equal(h.store.read().job.enabled, false);
});

test('close during a pending persistence read cannot start a worker after shutdown', async t => {
  const h = await setup(t);
  const gate = h.store.holdNextRead();
  const pendingTick = h.runner.tick();
  await gate.started.promise;
  await h.runner.close();
  gate.release.resolve();
  await pendingTick;
  assert.equal(h.calls.length, 0);
  assert.notEqual(h.store.read().job.status, 'running');
});

test('three discovery responses without progress stop for attention without faking lastProgressAt', async t => {
  let discoveryCalls = 0;
  const h = await setup(t, { config: {
    seed: async () => ({ discoveryComplete: false, targets: [], items: [] }),
    discover: async job => {
      discoveryCalls += 1;
      // Rotating a store cursor alone is not evidence that collection advanced.
      return { targets: [], items: [], complete: false, progressed: false, cursor: job.discoveryCursor + 1 };
    },
  } });
  const initialProgressAt = h.store.read().job.lastProgressAt;
  h.advance(1_000);
  await h.runner.tick();
  let job = h.store.read().job;
  assert.equal(discoveryCalls, 1);
  assert.equal(job.discoveryAttempts, 1);
  assert.equal(job.discoveryCursor, 1);
  assert.equal(job.status, 'cooldown');
  assert.equal(job.lastProgressAt, initialProgressAt);
  assert.notEqual(job.updatedAt, initialProgressAt);
  assert.equal(Date.parse(job.nextRetryAt), h.clock.value + 60_000);
  h.advance(59_999);
  await h.runner.tick();
  assert.equal(discoveryCalls, 1);
  h.advance(1);
  await h.runner.tick();
  job = h.store.read().job;
  assert.equal(discoveryCalls, 2);
  assert.equal(job.discoveryAttempts, 2);
  assert.equal(job.lastProgressAt, initialProgressAt);
  assert.equal(Date.parse(job.nextRetryAt), h.clock.value + 120_000);
  h.advance(120_000);
  await h.runner.tick();
  job = h.store.read().job;
  assert.equal(discoveryCalls, 3);
  assert.equal(job.discoveryAttempts, 3);
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.causeCode, 'AMAZON_DISCOVERY_NO_PROGRESS');
  assert.equal(job.nextRetryAt, null);
  assert.equal(job.lastProgressAt, initialProgressAt);
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(discoveryCalls, 3);
  assert.equal(h.calls.length, 0);
});

test('actual discovery progress resets the consecutive no-progress budget', async t => {
  let discoveryCalls = 0;
  const h = await setup(t, { config: {
    seed: async () => ({ discoveryComplete: false, targets: [], items: [] }),
    discover: async job => {
      discoveryCalls += 1;
      return { targets: [], items: [], complete: false, progressed: discoveryCalls === 2, cursor: job.discoveryCursor + 1 };
    },
  } });
  h.advance(1_000);
  await h.runner.tick();
  assert.equal(h.store.read().job.discoveryAttempts, 1);
  h.advance(60_000);
  await h.runner.tick();
  let job = h.store.read().job;
  assert.equal(job.discoveryAttempts, 0);
  assert.equal(job.status, 'queued');
  assert.equal(Date.parse(job.lastProgressAt), h.clock.value);
  const genuineProgressAt = job.lastProgressAt;
  h.advance(1_000);
  await h.runner.tick();
  job = h.store.read().job;
  assert.equal(job.discoveryAttempts, 1);
  assert.equal(job.status, 'cooldown');
  assert.equal(job.lastProgressAt, genuineProgressAt);
});

test('supplier pause waits for the worker to exit and returns a stable editable revision', async t => {
  const entered = deferred();
  const result = deferred();
  let signal;
  const h = await setup(t, { loadDetails: (_job, _asins, workerSignal) => {
    signal = workerSignal; entered.resolve(); return result.promise;
  } });
  const pending = h.runner.tick();
  await entered.promise;
  const paused = await h.runner.command(RUN, 'pause_for_supplier');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.causeCode, 'SUPPLIER_MATCHING');
  assert.equal(paused.workerActive, false);
  assert.equal(signal.aborted, true);
  assert.equal(Date.parse(paused.supplierPause.expiresAt), h.clock.value + 120_000);
  assert.equal(paused.supplierPause.previousStatus, 'running');
  assert.equal(h.store.read().job.tasks[A].attempts, 0);
  const revision = paused.revision;
  result.resolve([completeItem(A)]);
  await pending;
  await h.runner.tick();
  assert.equal(h.store.read().job.revision, revision);
  assert.equal(h.store.read().items[A], undefined);
});

test('supplier lease renewal changes only its expiry and automatically resumes after expiry', async t => {
  const h = await setup(t);
  await h.runner.command(RUN, 'pause_for_supplier');
  const beforeRenewal = h.store.read();
  h.advance(5_000);
  const renewed = await h.runner.command(RUN, 'pause_for_supplier');
  assert.equal(renewed.revision, beforeRenewal.job.revision);
  assert.equal(Date.parse(renewed.supplierPause.expiresAt), h.clock.value + 120_000);
  const afterRenewal = h.store.read();
  beforeRenewal.job.supplierPause.expiresAt = afterRenewal.job.supplierPause.expiresAt;
  assert.deepEqual(afterRenewal, beforeRenewal);
  h.advance(119_999);
  await h.runner.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.read().job.status, 'paused');
  h.advance(1);
  await Promise.all([h.runner.tick(), h.runner.tick()]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.read().job.status, 'completed');
  assert.equal(h.store.read().job.supplierPause, undefined);
});

test('supplier completion restores the original cooldown and all retry budgets', async t => {
  const h = await setup(t);
  const job = h.store.records.get(RUN).job;
  job.status = 'cooldown'; job.causeCode = 'AMAZON_HTTP_429';
  job.nextRetryAt = new Date(EPOCH + 300_000).toISOString();
  job.restrictionCount = 2; job.discoveryAttempts = 2;
  job.tasks[A].attempts = 2; job.tasks[A].nextRetryAt = job.nextRetryAt;
  const priorTask = copy(job.tasks[A]);
  const priorNextRetryAt = job.nextRetryAt;
  await h.runner.command(RUN, 'pause_for_supplier');
  h.advance(10_000);
  const resumed = await h.runner.command(RUN, 'resume_after_supplier');
  assert.equal(resumed.status, 'cooldown');
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.causeCode, 'AMAZON_HTTP_429');
  assert.equal(resumed.nextRetryAt, priorNextRetryAt);
  assert.equal(resumed.restrictionCount, 2);
  assert.equal(resumed.discoveryAttempts, 2);
  assert.deepEqual(h.store.read().job.tasks[A], priorTask);
  await h.runner.tick();
  assert.equal(h.calls.length, 0);
  const revision = resumed.revision;
  await h.runner.command(RUN, 'resume_after_supplier');
  assert.equal(h.store.read().job.revision, revision);
});

for (const [status, causeCode] of [['paused', 'USER_PAUSED'], ['needs_attention', 'AMAZON_ACCESS_CHALLENGE'], ['completed', null]]) {
  test(`supplier commands preserve ${status} and wait for any worker cleanup`, async t => {
    const h = await setup(t);
    Object.assign(h.store.records.get(RUN).job, { status, causeCode, enabled: status !== 'paused' });
    const before = h.store.read();
    const exiting = deferred();
    h.runner.work = exiting.promise.finally(() => { h.runner.work = null; });
    let returned = false;
    const pausing = h.runner.command(RUN, 'pause_for_supplier').then(value => { returned = true; return value; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(returned, false);
    exiting.resolve();
    const paused = await pausing;
    assert.equal(paused.workerActive, false);
    assert.equal(paused.status, status);
    assert.equal(paused.causeCode, causeCode);
    assert.deepEqual(h.store.read(), before);
    await h.runner.command(RUN, 'resume_after_supplier');
    assert.deepEqual(h.store.read(), before);
  });
}

test('manual pause overrides a supplier lease and cannot be resumed by expiry or supplier completion', async t => {
  const h = await setup(t);
  await h.runner.command(RUN, 'pause_for_supplier');
  const paused = await h.runner.command(RUN, 'pause');
  assert.equal(paused.causeCode, 'USER_PAUSED');
  assert.equal(paused.supplierPause, undefined);
  h.advance(3_600_000);
  await h.runner.tick();
  await h.runner.command(RUN, 'resume_after_supplier');
  await h.runner.command(RUN, 'pause_for_supplier');
  assert.equal(h.store.read().job.causeCode, 'USER_PAUSED');
  assert.equal(h.store.read().job.status, 'paused');
  assert.equal(h.calls.length, 0);
});

test('restart respects the unexpired supplier lease and canRun blocks recovery during a long supplier request', async t => {
  const first = await setup(t);
  await first.runner.command(RUN, 'pause_for_supplier');
  const expiry = first.store.read().job.supplierPause.expiresAt;
  await first.runner.close();
  let supplierHttpActive = false;
  const restarted = await setup(t, { store: first.store, clock: first.clock,
    config: { canRun: () => !supplierHttpActive },
  });
  assert.equal(restarted.store.read().job.supplierPause.expiresAt, expiry);
  restarted.advance(119_999);
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 0);
  supplierHttpActive = true;
  restarted.advance(1);
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 0);
  assert.equal(restarted.store.read().job.status, 'paused');
  supplierHttpActive = false;
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.store.read().job.status, 'completed');
});

test('a lease renewal queued during expiry recheck prevents stale expiry recovery', async t => {
  const h = await setup(t);
  await h.runner.command(RUN, 'pause_for_supplier');
  h.advance(120_000);
  const gate = h.store.holdNextRead();
  const pendingTick = h.runner.tick();
  await gate.started.promise;
  const renewed = await h.runner.command(RUN, 'pause_for_supplier');
  gate.release.resolve();
  await pendingTick;
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.read().job.status, 'paused');
  assert.equal(h.store.read().job.revision, renewed.revision);
  assert.equal(h.store.read().job.supplierPause.expiresAt, renewed.supplierPause.expiresAt);
});

test('qualifying store badge evidence survives seed, discovery, pause and service restart before detail loading', async t => {
  const withSales = (asin, value) => ({ ...target(asin), sales30: value,
    sales30Evidence: { source: 'amazon_store_card', period: 'past_month', kind: 'lower_bound',
      value, rawText: `${value}+ bought in past month`, asin } });
  const seededTarget = withSales(A, 50);
  const refreshedTarget = withSales(A, 100);
  const discoveredTarget = withSales(B, 200);
  const h = await setup(t, { config: {
    seed: async () => ({ discoveryComplete: false, targets: [seededTarget], items: [] }),
    discover: async () => ({ complete: true, progressed: true, targets: [refreshedTarget, discoveredTarget], items: [] }),
  } });
  assert.deepEqual(h.store.read().job.tasks[A].sales30Evidence, seededTarget.sales30Evidence);
  assert.equal(h.store.read().job.tasks[A].sales30, 50);
  await h.runner.tick();
  const discovered = h.store.read().job.tasks;
  assert.deepEqual(discovered[A].sales30Evidence, refreshedTarget.sales30Evidence);
  assert.equal(discovered[A].sales30, 100);
  assert.deepEqual(discovered[B].sales30Evidence, discoveredTarget.sales30Evidence);
  assert.equal(discovered[A].attempts, 0); assert.equal(discovered[B].attempts, 0);
  assert.equal(discovered[A].status, 'pending'); assert.equal(discovered[B].status, 'pending');
  await h.runner.command(RUN, 'pause');
  const paused = h.store.read();
  await h.runner.close();
  const restarted = await setup(t, { store: h.store, clock: h.clock, loadDetails: async (job, asins) => {
    assert.deepEqual(job.tasks[A].sales30Evidence, refreshedTarget.sales30Evidence);
    assert.deepEqual(job.tasks[B].sales30Evidence, discoveredTarget.sales30Evidence);
    return asins.map(completeItem);
  } });
  assert.equal(restarted.store.read().job.status, 'paused');
  assert.deepEqual(restarted.store.read().job.tasks, paused.job.tasks);
  await restarted.runner.tick(); assert.equal(restarted.calls.length, 0);
  await restarted.runner.command(RUN, 'resume');
  await restarted.runner.tick();
  assert.deepEqual(restarted.calls, [[A, B]]);
  assert.equal(restarted.store.read().job.status, 'completed');
  assert.deepEqual(restarted.store.read().job.tasks[A].sales30Evidence, refreshedTarget.sales30Evidence);
});

test('target refresh copies only valid monthly evidence and never changes task progress or manual pause', async t => {
  const h = await setup(t);
  const evidence = { source: 'amazon_store_card', period: 'past_month', kind: 'lower_bound',
    value: 50, rawText: '50+ bought in past month', asin: A };
  const job = h.store.read().job;
  job.status = 'paused'; job.enabled = false; job.causeCode = 'USER_PAUSED';
  job.tasks[A] = { ...job.tasks[A], status: 'failed', attempts: 3, nextRetryAt: '2026-10-10T00:00:00Z' };
  const before = copy(job.tasks[A]);
  const source = { ...target(A), sales30: 999, sales30Evidence: evidence };
  h.runner.addTarget(job, source);
  assert.deepEqual(job.tasks[A], { ...before, sales30: 50, sales30Evidence: evidence });
  source.sales30Evidence.rawText = 'mutated';
  assert.equal(job.tasks[A].sales30Evidence.rawText, '50+ bought in past month');
  const preserved = copy(job);
  for (const invalid of [
    { ...target(A), sales30: 500 },
    { ...target(A), sales30Evidence: { ...evidence, value: 49, rawText: '50+ bought in past month' } },
    { ...target(A), sales30Evidence: { ...evidence, value: 50, rawText: '50+ bought in past month', asin: B } },
  ]) {
    h.runner.addTarget(job, invalid);
    assert.deepEqual(job, preserved);
  }
  h.runner.addTarget(job, { ...target(B), sales30: 500 });
  assert.equal(job.tasks[B].sales30, undefined);
  assert.equal(job.tasks[B].sales30Evidence, undefined);
  assert.equal(job.status, 'paused'); assert.equal(job.causeCode, 'USER_PAUSED');
});


test('full collection retains and fetches low-sales and missing-sales products before candidate screening', async t => {
  const evidence = { source: 'amazon_store_card', period: 'past_month', kind: 'lower_bound', value: 10, rawText: '10+ bought in past month', asin: A };
  const h = await setup(t, { config: {
    seed: async () => ({ discoveryComplete: true, targets: [{ ...target(A), sales30Evidence: evidence }, target(B)], items: [] }),
  } });
  assert.equal(h.store.read().job.counts.total, 2);
  assert.equal(h.store.read().job.tasks[A].sales30, 10);
  assert.deepEqual(h.store.read().job.tasks[A].sales30Evidence, evidence);
  assert.equal(h.store.read().job.tasks[B].sales30Evidence, undefined);
  await h.runner.tick();
  assert.deepEqual(h.calls, [[A, B]]);
  assert.equal(h.store.read().job.status, 'completed');
});
