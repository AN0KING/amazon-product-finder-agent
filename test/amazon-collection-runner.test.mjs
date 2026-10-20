import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PROFIT_FORMULA_VERSION } from '../lib/profit-model.mjs';
import { AmazonCollectionRunner } from '../lib/amazon-collection-runner.mjs';
import { AMAZON_DETAIL_QUALITY_VERSION } from '../lib/amazon-detail-quality.mjs';

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
  async getRunSnapshot(runId) {
    const archivedAt = this.records.get(runId)?.job?.archivedAt;
    return { runState: { analysisSourceMode: 'amazon_only', marketplace: 'CA', criteria: {}, archivedAt }, storeList: { stores: [] } };
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
  async archiveRun(runId) {
    const saved = this.records.get(runId);
    if (saved?.job && !saved.job.archivedAt) {
      Object.assign(saved.job, { status: 'cancelled', enabled: false, archivedAt: new Date().toISOString(),
        causeCode: 'USER_REPLACED', nextRetryAt: null, revision: saved.job.revision + 1 });
    }
    if (this.active === runId) this.active = null;
    return saved;
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
    loadDetails: async (job, asins, signal, onItem) => {
      calls.push([...asins]);
      return options.loadDetails ? options.loadDetails(job, asins, signal, calls.length, onItem) : asins.map(completeItem);
    },
    onBusy: value => busy.push(value),
    ...(options.config || {}),
  });
  t.after(() => runner.close());
  await runner.initialize({ timer: false });
  await runner.start(RUN);
  return { store, clock, calls, busy, runner, advance: ms => { clock.value += ms; } };
}

const listingInformation = (asin, value) => {
  const rows = [{ label: 'Brand', value: 'Saved example' }];
  if (value !== undefined) rows.push({ label: 'Date First Available', value });
  return { version: 1, asin, status: 'complete', reason: null, rowCount: rows.length,
    weightStatus: 'not_provided', sections: [{ selector: '#productDetails_detailBullets_sections1', rows }] };
};

const incompleteInspectionItem = asin => ({ ...completeItem(asin), productWeightKg: null,
  amazonFirstAvailableDateStatus: 'unresolved', productInformation: { version: 1, asin,
    status: 'incomplete', reason: 'inspection_timeout', weightStatus: 'unresolved', rowCount: 1,
    sections: [{ selector: '#productDetails', rows: [{ label: 'Brand', value: 'Example' }] }],
    inspection: { version: 3, asin, status: 'incomplete', reason: 'inspection_timeout' } } });

test('a completed incomplete inspection is automatically revisited after cooldown without touching other ASINs', async t => {
  const h = await setup(t, { asins: [A, B], items: [incompleteInspectionItem(A), completeItem(B)] });
  await h.runner.tick();
  assert.equal(h.store.read().job.status, 'completed');
  const previousB = h.store.read().items[B];
  await h.runner.tick();
  const queued = h.store.read();
  assert.equal(queued.job.status, 'cooldown');
  assert.equal(queued.job.tasks[A].automaticRecoveryAttempts, 1);
  assert.equal(queued.items[A].collectionRecovery.status, 'scheduled');
  assert.equal(h.calls.length, 0);
  h.advance(59_999);
  await h.runner.tick();
  assert.equal(h.calls.length, 0);
  h.advance(1);
  await h.runner.tick();
  assert.deepEqual(h.calls, [[A]]);
  assert.deepEqual(h.store.read().items[B], previousB);
  assert.equal(h.store.read().job.runId, RUN);
  assert.equal(h.store.read().items[A].collectionRecovery.status, 'resolved');
  h.advance(3_600_000);
  await h.runner.tick();
  assert.deepEqual(h.calls, [[A]]);
});

test('incomplete information has only two extra inspections and keeps that budget across restarts', async t => {
  const h = await setup(t, { items: [incompleteInspectionItem(A)], loadDetails: async () => [incompleteInspectionItem(A)] });
  await h.runner.tick();
  await h.runner.tick();
  assert.equal(h.store.read().job.tasks[A].recoveryPending, true);
  await h.runner.close();
  const restarted = await setup(t, { store: h.store, clock: h.clock, loadDetails: async () => [incompleteInspectionItem(A)] });
  assert.equal(restarted.store.read().job.tasks[A].status, 'pending', 'Startup cannot settle away an explicitly queued inspection.');
  restarted.advance(60_000);
  await restarted.runner.tick();
  assert.equal(restarted.store.read().items[A].collectionRecovery.status, 'waiting');
  await restarted.runner.tick();
  assert.equal(restarted.store.read().job.tasks[A].automaticRecoveryAttempts, 2);
  restarted.advance(119_999);
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 1);
  restarted.advance(1);
  await restarted.runner.tick();
  const final = restarted.store.read();
  assert.equal(final.job.status, 'completed');
  assert.equal(final.items[A].collectionRecovery.status, 'exhausted');
  assert.match(final.items[A].collectionRecovery.message, /自动补查上限/);
  assert.equal(final.job.tasks[A].attempts, 3);
  restarted.advance(86_400_000);
  await restarted.runner.tick();
  await restarted.runner.tick();
  assert.equal(restarted.calls.length, 2);
  assert.deepEqual(restarted.store.read(), final, 'Exhausted completed jobs must not write or requeue forever.');
});

test('completed legacy transport failures receive at most two follow-ups without resetting their original attempts', async t => {
  const h = await setup(t, { loadDetails: async () => [failedItem(A)] });
  const saved = h.store.records.get(RUN);
  Object.assign(saved.job, { status: 'completed', completedAt: new Date(EPOCH - 60_000).toISOString() });
  Object.assign(saved.job.tasks[A], { status: 'failed', attempts: 3, lastCode: 'AMAZON_FETCH_TIMEOUT' });
  saved.items[A] = h.runner.audit(failedItem(A), saved.job);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.read().job.tasks[A].attempts, 4);
  await h.runner.tick();
  h.advance(120_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.read().job.tasks[A].attempts, 5);
  assert.equal(h.store.read().items[A].collectionRecovery.status, 'exhausted');
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 2);
});

test('completion recovery respects manual pause, explicit disablement, access restrictions and supplier occupancy', async t => {
  for (const state of [
    { status: 'paused', enabled: false, causeCode: 'USER_PAUSED' },
    { status: 'completed', enabled: false },
    { status: 'needs_attention', enabled: false, causeCode: 'AMAZON_ACCESS_CHALLENGE' },
    { status: 'paused', enabled: false, causeCode: 'SUPPLIER_MATCHING', supplierPause: { expiresAt: new Date(EPOCH + 3_600_000).toISOString() } },
    { status: 'cooldown', enabled: true, nextRetryAt: new Date(EPOCH + 3_600_000).toISOString() },
  ]) {
    const h = await setup(t, { items: [incompleteInspectionItem(A)] });
    Object.assign(h.store.records.get(RUN).job, state);
    const before = h.store.read();
    await h.runner.tick();
    assert.deepEqual(h.store.read(), before);
    assert.equal(h.calls.length, 0);
  }
  const occupied = await setup(t, { items: [incompleteInspectionItem(A)], config: { canRun: () => false } });
  Object.assign(occupied.store.records.get(RUN).job, { status: 'completed' });
  const before = occupied.store.read();
  await occupied.runner.tick();
  assert.deepEqual(occupied.store.read(), before);
});

test('ASIN mismatches and verification failures never become automatic completion follow-ups', async t => {
  for (const code of ['AMAZON_PRODUCT_ASIN_MISMATCH', 'AMAZON_ACCESS_CHALLENGE', 'AMAZON_LOGIN_REQUIRED', 'AMAZON_HTTP_429']) {
    const h = await setup(t);
    const saved = h.store.records.get(RUN);
    Object.assign(saved.job, { status: 'completed', completedAt: new Date(EPOCH - 60_000).toISOString() });
    Object.assign(saved.job.tasks[A], { status: 'failed', attempts: 1, lastCode: code });
    saved.items[A] = h.runner.audit({ ...failedItem(A, code), detailRetryable: code !== 'AMAZON_PRODUCT_ASIN_MISMATCH' }, saved.job);
    const before = h.store.read();
    await h.runner.tick();
    assert.deepEqual(h.store.read(), before);
    assert.equal(h.calls.length, 0);
  }
});

test('a fully inspected page without weight or listing date is final, while an incomplete date check is revisited', async t => {
  const source = incompleteInspectionItem(A);
  const section = { selector: '#productDetails', rowCount: 1, status: 'complete', busy: false, closed: false };
  Object.assign(source, { amazonFirstAvailableDateStatus: 'not_provided' });
  Object.assign(source.productInformation, { status: 'complete', reason: null, weightStatus: 'not_provided',
    inspection: { version: 3, asin: A, status: 'complete', stable: true, rowCount: 1,
      sections: [section], parsedSections: [{ selector: '#productDetails', rowCount: 1 }] } });
  const h = await setup(t, { items: [source] });
  await h.runner.tick();
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.store.read().items[A].collectionQuality.fields.weight.status, 'unavailable');
  assert.equal(h.calls.length, 0);

  const dateOnly = { ...incompleteInspectionItem(A), productWeightKg: 0.06 };
  dateOnly.productInformation.weightStatus = 'found';
  const second = await setup(t, { items: [dateOnly] });
  await second.runner.tick();
  assert.equal(second.store.read().job.tasks[A].status, 'complete', 'The original four required fields can be complete while the date inspection is unfinished.');
  second.advance(60_000);
  await second.runner.tick();
  assert.deepEqual(second.calls, [[A]]);
});

test('competing completed-job checks reserve only one follow-up and manual pause wins before it starts', async t => {
  const h = await setup(t, { items: [incompleteInspectionItem(A)] });
  await h.runner.tick();
  await Promise.all([h.runner.tick(), h.runner.tick()]);
  assert.equal(h.store.read().job.tasks[A].automaticRecoveryAttempts, 1);
  assert.equal(h.calls.length, 0);
  await h.runner.command(RUN, 'pause');
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.store.read().job.causeCode, 'USER_PAUSED');
  assert.equal(h.calls.length, 0);
});

test('recheck reserves the existing bounded follow-up without resetting attempts or starting a duplicate worker', async t => {
  const h = await setup(t, { items: [incompleteInspectionItem(A)], loadDetails: async () => [incompleteInspectionItem(A)] });
  await h.runner.tick();
  const completed = await h.runner.status();
  assert.deepEqual(completed.recovery, { eligible: 1, scheduled: 0, exhausted: 0, blocked: 0 });
  assert.ok(completed.nextCheckAt, 'An incomplete completed job must still advertise the next background check.');
  const initialAttempts = h.store.read().job.tasks[A].attempts;
  await Promise.all([h.runner.command(RUN, 'recheck'), h.runner.command(RUN, 'recheck'), h.runner.tick()]);
  const scheduled = await h.runner.status();
  assert.equal(scheduled.recovery.scheduled, 1);
  assert.equal(h.store.read().job.tasks[A].automaticRecoveryAttempts, 1);
  assert.equal(h.store.read().job.tasks[A].attempts, initialAttempts);
  assert.equal(h.calls.length, 0);
  h.advance(60_000);
  await h.runner.tick();
  await h.runner.command(RUN, 'recheck');
  h.advance(120_000);
  await h.runner.tick();
  const exhausted = h.store.read();
  assert.equal(exhausted.job.tasks[A].automaticRecoveryAttempts, 2);
  assert.equal(exhausted.job.recovery.exhausted, 1);
  for (let check = 0; check < 3; check++) await h.runner.command(RUN, 'recheck');
  assert.deepEqual(h.store.read(), exhausted, 'Explicit monitor rechecks cannot reset a spent retry budget.');
  assert.equal((await h.runner.status()).nextCheckAt, null);
  assert.equal(h.calls.length, 2);
});

test('recheck preserves paused, disabled, restricted, cooling and occupied tasks and rejects a different run or ASIN selection', async t => {
  const h = await setup(t, { items: [incompleteInspectionItem(A)] });
  await h.runner.tick();
  for (const state of [
    { status: 'paused', enabled: false, causeCode: 'USER_PAUSED' },
    { status: 'paused', enabled: false, causeCode: 'SUPPLIER_MATCHING' },
    { status: 'needs_attention', enabled: false, causeCode: 'AMAZON_ACCESS_CHALLENGE' },
    { status: 'completed', enabled: false, causeCode: null },
    { status: 'completed', enabled: true, causeCode: 'AMAZON_HTTP_429' },
    { status: 'cooldown', enabled: true, causeCode: null, nextRetryAt: new Date(EPOCH + 60_000).toISOString() },
  ]) {
    Object.assign(h.store.records.get(RUN).job, state);
    const before = h.store.read();
    await h.runner.command(RUN, 'recheck');
    assert.deepEqual(h.store.read(), before);
  }
  Object.assign(h.store.records.get(RUN).job, { status: 'completed', enabled: true, causeCode: null, nextRetryAt: null });
  h.runner.canRun = () => false;
  const before = h.store.read();
  await h.runner.command(RUN, 'recheck');
  assert.deepEqual(h.store.read(), before);
  await assert.rejects(h.runner.command('different-run', 'recheck'), { code: 'COLLECTION_NOT_ACTIVE' });
  await assert.rejects(h.runner.command(RUN, 'recheck', { asins: [A] }), { code: 'INVALID_COLLECTION_ASINS' });
  assert.deepEqual(h.store.read(), before);
  assert.equal(h.calls.length, 0);
});

test('recheck during an active follow-up leaves the worker and its budget untouched', async t => {
  const entered = deferred();
  const response = deferred();
  const h = await setup(t, { items: [incompleteInspectionItem(A)], loadDetails: () => { entered.resolve(); return response.promise; } });
  await h.runner.tick();
  h.advance(60_000);
  const worker = h.runner.tick();
  await entered.promise;
  const before = h.store.read();
  const status = await h.runner.command(RUN, 'recheck');
  assert.equal(status.workerActive, true);
  assert.deepEqual(h.store.read(), before);
  assert.equal(h.calls.length, 1);
  response.resolve([completeItem(A)]);
  await worker;
  assert.equal(h.store.read().job.tasks[A].automaticRecoveryAttempts, 1);
});

test('hanging follow-up ends at its deadline and records the specific product error', async t => {
  let lateItem;
  const h = await setup(t, { items: [incompleteInspectionItem(A)], config: { timeoutMs: 10 },
    loadDetails: async (_job, _asins, _signal, _count, onItem) => {
      lateItem = onItem;
      return new Promise(() => {});
    } });
  await h.runner.tick();
  h.advance(60_000);
  await h.runner.tick();
  assert.equal((await h.runner.status()).workerActive, false);
  const saved = h.store.read();
  assert.equal(saved.items[A].lastCollectionError.code, 'COLLECTION_TIMEOUT');
  assert.match(saved.items[A].lastCollectionError.message, /超时/);
  assert.equal(saved.items[A].collectionRecovery.status, 'waiting');
  assert.equal(saved.job.tasks[A].attempts, 2);
  assert.equal(await lateItem(completeItem(A)), false);
  assert.deepEqual(h.store.read(), saved, 'A late callback from the timed-out page cannot overwrite the checkpoint.');
});

for (const status of ['paused', 'needs_attention']) {
  test(`saved date migration runs once and preserves ${status}, task attempts, manual fields and existing date evidence`, async t => {
    const C = 'B000000003';
    const manualFields = { manualAmazonFields: { currentPrice: true }, currentPrice: 23.45,
      manualWeight: true, productWeightKg: 0.21, manualPurchaseCost: true, purchaseCost: 8.5,
      suppliers: [{ unitPriceCny: 8.5, source: 'saved_manual_quote' }] };
    const originalEvidence = { asin: C, marketplace: 'CA', source: 'amazon_product_information',
      label: 'Date First Available', rawText: '8 July 2019', selector: '#original-fetch-table', value: '2019-07-08' };
    const h = await setup(t, { asins: [A, B, C], items: [
      { ...completeItem(A), ...manualFields, productInformation: listingInformation(A, '17 June 2020') },
      { ...completeItem(B), productInformation: listingInformation(B) },
      { ...completeItem(C), productInformation: listingInformation(C, '19 June 2021'),
        amazonFirstAvailableDate: '2019-07-08', amazonFirstAvailableDateStatus: 'found', amazonFirstAvailableDateEvidence: originalEvidence },
    ] });
    await h.runner.close();
    const raw = h.store.records.get(RUN);
    Object.assign(raw.job, { status, enabled: false, causeCode: status === 'paused' ? 'USER_PAUSED' : 'AMAZON_ACCESS_CHALLENGE',
      restrictionCount: 3, discoveryCursor: 4 });
    raw.job.tasks[A].attempts = 3;
    raw.job.tasks[B].attempts = 2;
    const before = h.store.read();
    let requests = 0;
    const denyRequest = async () => { requests++; throw new Error('Date migration must be offline'); };
    const restarted = new AmazonCollectionRunner({ store: h.store, now: () => EPOCH + 60_000,
      seed: denyRequest, discover: denyRequest, loadDetails: denyRequest });
    t.after(() => restarted.close());
    let writes = 0;
    const update = h.store.updateAmazonCollection;
    t.mock.method(h.store, 'updateAmazonCollection', async function (...args) { writes++; return update.apply(this, args); });
    await restarted.initialize({ timer: false });
    const after = h.store.read();
    assert.equal(writes, 1);
    assert.equal(after.items[A].amazonFirstAvailableDate, '2020-06-17');
    assert.equal(after.items[A].amazonFirstAvailableDateStatus, 'found');
    assert.equal(after.items[A].amazonFirstAvailableDateEvidence.rawText, '17 June 2020');
    assert.equal(after.items[B].amazonFirstAvailableDate, null);
    assert.equal(after.items[B].amazonFirstAvailableDateStatus, 'unresolved', 'Saved rows without complete section inspection cannot prove the date is absent.');
    for (const [key, value] of Object.entries(manualFields)) assert.deepEqual(after.items[A][key], value, key);
    assert.deepEqual(after.items[C], before.items[C], 'An existing evidence result must not be re-derived from a different supplemental table.');
    assert.deepEqual(after.job.tasks, before.job.tasks);
    for (const key of ['id', 'runId', 'status', 'enabled', 'causeCode', 'restrictionCount', 'discoveryCursor', 'phase', 'nextRetryAt', 'createdAt']) {
      assert.deepEqual(after.job[key], before.job[key], key);
    }
    assert.equal(after.job.revision, before.job.revision + 1);
    await restarted.initialize({ timer: false });
    await restarted.tick();
    assert.equal(writes, 1, 'Repeated startup must not migrate or persist the same optional field again.');
    assert.equal(requests, 0);
    assert.deepEqual(h.store.read(), after);
  });
}

test('an orphan saved item missing only its optional date status does not repeatedly write the active job', async t => {
  const h = await setup(t, { items: [completeItem(A)] });
  await h.runner.close();
  const saved = h.store.records.get(RUN);
  Object.assign(saved.job, { status: 'paused', enabled: false, causeCode: 'USER_PAUSED' });
  saved.items[B] = h.runner.audit({ ...completeItem(B), productInformation: listingInformation(B, '17 June 2020') }, saved.job);
  const before = h.store.read();
  let writes = 0;
  const update = h.store.updateAmazonCollection;
  t.mock.method(h.store, 'updateAmazonCollection', async function (...args) { writes++; return update.apply(this, args); });
  const restarted = new AmazonCollectionRunner({ store: h.store });
  t.after(() => restarted.close());
  await restarted.initialize({ timer: false });
  await restarted.initialize({ timer: false });
  assert.equal(writes, 0);
  assert.deepEqual(h.store.read(), before);
});

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
  assert.equal(restarted.store.read().items[A].collectionQuality.fields.weight.status, 'missing');
  assert.equal(restarted.store.read().items[A].collectionQuality.fields.weight.reason, 'product_information_unchecked');
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

for (const code of ['AMAZON_HTTP_429']) {
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
  assert.equal(h.store.read().job.lastError, null);
  assert.equal(h.store.read().job.lastFailure.code, 'COLLECTION_TIMEOUT');
  assert.equal(h.store.read().job.lastFailure.at, new Date(EPOCH).toISOString());
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


test('replacement cancellation preserves paused checkpoints and allows a new run without reviving the old one', async t => {
  const h = await setup(t, { asins: [A, B], items: [completeItem(A)] });
  await h.runner.command(RUN, 'pause');
  const before = h.store.read();
  const archived = await h.runner.cancelForReplacement(RUN);
  assert.equal(archived.status, 'cancelled');
  assert.equal(archived.workerActive, false);
  assert.equal(h.runner.runId, null);
  assert.equal(h.store.active, null);
  assert.deepEqual(h.store.read().items, before.items);
  assert.deepEqual(h.store.read().job.tasks, before.job.tasks);
  await assert.rejects(h.runner.start(RUN), { code: 'RUN_ARCHIVED' });
  await assert.rejects(h.runner.command(RUN, 'resume'), { code: 'COLLECTION_NOT_ACTIVE' });
  await assert.rejects(h.runner.command(RUN, 'retry_missing'), { code: 'COLLECTION_NOT_ACTIVE' });
  await h.runner.start('replacement-run');
  await h.runner.tick();
  assert.equal(h.runner.runId, 'replacement-run');
  assert.deepEqual(h.calls, [[B]]);
  assert.equal(h.store.read().job.status, 'cancelled');
});

test('replacement aborts in-flight work and rejects late results after a new run begins', async t => {
  const entered = deferred();
  const late = deferred();
  let workerSignal;
  const h = await setup(t, { loadDetails: (_job, asins, signal, count) => {
    if (count > 1) return asins.map(completeItem);
    workerSignal = signal; entered.resolve(); return late.promise;
  } });
  const tick = h.runner.tick();
  await entered.promise;
  await h.runner.cancelForReplacement(RUN);
  await tick;
  assert.equal(workerSignal.aborted, true);
  const archived = h.store.read();
  await h.runner.start('new-run-after-abort');
  late.resolve([{ ...completeItem(A), currentPrice: 999 }]);
  await Promise.resolve();
  await h.runner.tick();
  assert.deepEqual(h.store.read(), archived);
  assert.equal(h.store.records.get('new-run-after-abort').items[A].currentPrice, 9.99);
});

test('archiving a non-current run does not abort or release the current worker', async t => {
  const entered = deferred();
  const response = deferred();
  let workerSignal;
  const h = await setup(t, { loadDetails: (_job, _asins, signal) => {
    workerSignal = signal; entered.resolve(); return response.promise;
  } });
  h.store.records.set('historical-run', { job: { status: 'paused', revision: 1, tasks: {} }, items: {} });
  const tick = h.runner.tick();
  await entered.promise;
  await h.runner.cancelForReplacement('historical-run');
  assert.equal(workerSignal.aborted, false);
  assert.equal(h.runner.runId, RUN);
  assert.equal(h.store.active, RUN);
  response.resolve([completeItem(A)]);
  await tick;
  assert.equal(h.store.read().job.status, 'completed');
});

test('replacement during a pending timer read invalidates that stale read before another run starts', async t => {
  const h = await setup(t);
  const gate = h.store.holdNextRead();
  const tick = h.runner.tick();
  await gate.started.promise;
  await h.runner.cancelForReplacement(RUN);
  await h.runner.start('new-run-after-read');
  gate.release.resolve();
  await tick;
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.read().job.status, 'cancelled');
});

test('a cancelled collection is never restored even with a stale active pointer at restart', async t => {
  const h = await setup(t);
  await h.runner.cancelForReplacement(RUN);
  await h.runner.close();
  h.store.active = RUN;
  const restored = new AmazonCollectionRunner({ store: h.store, loadDetails: () => { throw new Error('must not collect'); } });
  t.after(() => restored.close());
  assert.equal(await restored.initialize({ timer: false }), null);
  await restored.tick();
  assert.equal(restored.runId, null);
  assert.equal(h.store.read().job.status, 'cancelled');
});


test('an already aborted deadline does not start a discovery or detail request', async t => {
  const h = await setup(t);
  const controller = new AbortController();
  const reason = new Error('Manual pause already persisted');
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(h.runner.withDeadline(() => { calls += 1; return new Promise(() => {}); }, controller),
    error => error === reason);
  assert.equal(calls, 0);
});

test('a pause before the request microtask prevents the network operation from starting', async t => {
  const h = await setup(t);
  const controller = new AbortController();
  const reason = new Error('Manual pause won before network dispatch');
  let calls = 0;
  const pending = h.runner.withDeadline(() => { calls += 1; return new Promise(() => {}); }, controller);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls, 0);
});

for (const phase of ['start', 'result', 'failure']) {
  test(`manual pause cannot be overwritten by a delayed ${phase} persistence callback`, async t => {
    const entered = deferred();
    const response = deferred();
    const h = await setup(t, { loadDetails: () => { entered.resolve(); return response.promise; } });
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const pauseSaved = deferred();
    const originalUpdate = h.store.updateAmazonCollection.bind(h.store);
    let holdWrite = phase === 'start';
    h.store.updateAmazonCollection = async (...args) => {
      if (holdWrite) {
        holdWrite = false;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      const result = await originalUpdate(...args);
      if (result.job?.causeCode === 'USER_PAUSED') pauseSaved.resolve();
      return result;
    };
    const pendingTick = h.runner.tick();
    if (phase !== 'start') {
      await entered.promise;
      holdWrite = true;
      if (phase === 'result') response.resolve([completeItem(A)]);
      else response.resolve(Promise.reject(new Error('Transport failed after pause was requested')));
    }
    await writeStarted.promise;
    const pausing = h.runner.command(RUN, 'pause');
    await pauseSaved.promise;
    const atPause = h.store.read();
    releaseWrite.resolve();
    const paused = await pausing;
    await pendingTick;
    const saved = h.store.read();
    assert.equal(paused.workerActive, false);
    assert.equal(saved.job.status, 'paused');
    assert.equal(saved.job.enabled, false);
    assert.equal(saved.job.causeCode, 'USER_PAUSED');
    assert.equal(saved.job.revision, atPause.job.revision, 'Discarded writes must not change the saved revision.');
    assert.deepEqual(saved.items, atPause.items);
    assert.deepEqual(saved.job.tasks, atPause.job.tasks);
    h.advance(3_600_000);
    await h.runner.tick();
    assert.equal(h.calls.length, phase === 'start' ? 0 : 1);
  });
}


test('status treats a timeout in a legacy completed snapshot as history without rewriting stored results', async t => {
  const h = await setup(t);
  await h.runner.tick();
  h.store.records.get(RUN).job.lastError = 'Old discovery timeout before completion';
  const before = h.store.read();
  const status = await h.runner.status();
  assert.equal(status.status, 'completed');
  assert.equal(status.lastError, null);
  assert.equal(status.lastFailure.message, before.job.lastError);
  assert.equal(status.lastFailure.at, null, 'A legacy error must not be assigned an invented timestamp.');
  assert.deepEqual(h.store.read(), before);
});

test('pause, supplier handoff and status use lightweight job storage without loading product results', async t => {
  const h = await setup(t, { asins: [A, B], items: [completeItem(A)] });
  const originalItems = copy(h.store.records.get(RUN).items);
  let reads = 0;
  let writes = 0;
  h.store.getAmazonCollectionJob = async runId => {
    reads += 1;
    return copy(h.store.records.get(runId)?.job);
  };
  h.store.updateAmazonCollectionJob = async (runId, update) => {
    writes += 1;
    const entry = h.store.records.get(runId);
    entry.job = copy(update(copy(entry.job)));
    return copy(entry.job);
  };
  h.store.getAmazonCollection = async () => { throw new Error('Full collection read must not run for job control'); };
  h.store.updateAmazonCollection = async () => { throw new Error('Full collection write must not run for job control'); };
  const paused = await h.runner.command(RUN, 'pause_for_supplier');
  assert.equal(paused.causeCode, 'SUPPLIER_MATCHING');
  const renewed = await h.runner.command(RUN, 'pause_for_supplier');
  assert.equal(renewed.revision, paused.revision);
  const restored = await h.runner.command(RUN, 'resume_after_supplier');
  assert.equal(restored.status, 'queued');
  const manual = await h.runner.command(RUN, 'pause');
  assert.equal(manual.causeCode, 'USER_PAUSED');
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal((await h.runner.status()).status, 'paused');
  assert.ok(reads > 0);
  assert.equal(writes, 4);
  assert.deepEqual(h.store.records.get(RUN).items, originalItems);
});


for (const source of ['detail', 'discovery', 'request']) {
  test(`a confirmed Amazon access challenge from ${source} stops immediately and remains paused across restart`, async t => {
    let discoveries = 0;
    const config = source === 'detail' ? {} : {
      seed: async () => ({ discoveryComplete: false, targets: [], items: [] }),
      discover: async () => {
        discoveries += 1;
        if (source === 'request') throw Object.assign(new Error('Amazon access verification required'), { code: 'AMAZON_ACCESS_CHALLENGE' });
        return { targets: [], items: [], complete: false, restrictionCode: 'AMAZON_ACCESS_CHALLENGE' };
      },
    };
    const h = await setup(t, { config, loadDetails: async () => [failedItem(A, 'AMAZON_ACCESS_CHALLENGE')] });
    await h.runner.tick();
    const checkpoint = h.store.read();
    assert.equal(checkpoint.job.status, 'needs_attention');
    assert.equal(checkpoint.job.enabled, false);
    assert.equal(checkpoint.job.nextRetryAt, null);
    assert.equal(checkpoint.job.restrictionCount, 1);
    assert.equal(checkpoint.job.causeCode, 'AMAZON_ACCESS_CHALLENGE');
    h.advance(86_400_000);
    await h.runner.tick();
    assert.equal(h.calls.length + discoveries, 1);
    await h.runner.close();
    const restarted = await setup(t, { store: h.store, clock: h.clock });
    await restarted.runner.tick();
    assert.equal(restarted.calls.length, 0);
    assert.equal(restarted.store.read().job.status, 'needs_attention');
    assert.deepEqual(restarted.store.read().job.tasks, checkpoint.job.tasks);
  });
}


test('an access challenge in a detail batch takes priority over another product rate limit', async t => {
  const h = await setup(t, { asins: [A, B], loadDetails: async () => [
    failedItem(A, 'AMAZON_ACCESS_CHALLENGE'), failedItem(B, 'AMAZON_HTTP_429'),
  ] });
  await h.runner.tick();
  const { job } = h.store.read();
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.causeCode, 'AMAZON_ACCESS_CHALLENGE');
  assert.equal(job.enabled, false);
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
});


test('each streamed product is saved before the next product returns, with the exact incremental ASIN scope', async t => {
  const firstSaved = deferred();
  const releaseSecond = deferred();
  const scopes = [];
  const h = await setup(t, { asins: [A, B], loadDetails: async (_job, _asins, _signal, _count, onItem) => {
    assert.equal(await onItem(completeItem(A)), true);
    firstSaved.resolve();
    await releaseSecond.promise;
    assert.equal(await onItem(completeItem(B)), true);
    return [completeItem(A), completeItem(B)];
  } });
  const originalUpdate = h.store.updateAmazonCollection.bind(h.store);
  h.store.updateAmazonCollection = async (runId, update, options) => {
    if (options?.changedAsins) scopes.push(copy(options.changedAsins));
    return originalUpdate(runId, update, options);
  };
  const tick = h.runner.tick();
  await firstSaved.promise;
  const first = h.store.read();
  assert.equal(first.job.status, 'running');
  assert.equal(first.job.counts.processed, 1);
  assert.equal(first.items[A].currentPrice, 9.99);
  assert.equal(first.items[B], undefined);
  assert.equal(first.job.tasks[A].attempts, 1);
  assert.equal(first.job.tasks[B].attempts, 0);
  assert.deepEqual(scopes, [[A]]);
  releaseSecond.resolve();
  await tick;
  const final = h.store.read();
  assert.equal(final.job.status, 'completed');
  assert.equal(final.job.counts.processed, 2);
  assert.equal(final.job.tasks[A].attempts, 1);
  assert.equal(final.job.tasks[B].attempts, 1);
  assert.deepEqual(scopes, [[A], [B]], 'returned results must not save streamed products twice');
});

test('concurrent callbacks serialize and duplicate or unrelated ASINs never consume an attempt', async t => {
  const h = await setup(t, { asins: [A, B], loadDetails: async (_job, _asins, _signal, _count, onItem) => {
    const outcomes = await Promise.all([onItem(completeItem(A)), onItem(completeItem(B)), onItem(completeItem(A)), onItem(completeItem('B000000003'))]);
    assert.deepEqual(outcomes, [true, true, false, false]);
    return [completeItem(A), completeItem(B)];
  } });
  await h.runner.tick();
  assert.equal(h.store.read().job.counts.processed, 2);
  assert.equal(h.store.read().job.tasks[A].attempts, 1);
  assert.equal(h.store.read().job.tasks[B].attempts, 1);
  assert.equal(h.store.read().items.B000000003, undefined);
});

test('a batch tail exception never overwrites an already persisted product or counts it twice', async t => {
  const h = await setup(t, { asins: [A, B], loadDetails: async (_job, _asins, _signal, count, onItem) => {
    if (count === 1) {
      await onItem(completeItem(A));
      throw Object.assign(new Error('Second product timed out'), { code: 'AMAZON_FETCH_TIMEOUT' });
    }
    return [completeItem(B)];
  } });
  await h.runner.tick();
  const partial = h.store.read();
  assert.equal(partial.items[A].currentPrice, 9.99);
  assert.equal(partial.items[A].lastCollectionError, undefined);
  assert.equal(partial.job.tasks[A].status, 'complete');
  assert.equal(partial.job.tasks[A].attempts, 1);
  assert.equal(partial.job.tasks[B].attempts, 1);
  assert.equal(partial.job.status, 'cooldown');
  h.advance(60_000);
  await h.runner.tick();
  assert.deepEqual(h.calls, [[A, B], [B]]);
  assert.equal(h.store.read().job.status, 'completed');
  assert.equal(h.store.read().job.tasks[A].attempts, 1);
  assert.equal(h.store.read().job.tasks[B].attempts, 2);
});

test('a deadline after one streamed product only schedules the unfinished ASIN', async t => {
  const h = await setup(t, { asins: [A, B], config: { timeoutMs: 30 }, loadDetails: async (_job, _asins, _signal, _count, onItem) => {
    await onItem(completeItem(A));
    await new Promise(() => {});
  } });
  await h.runner.tick();
  const partial = h.store.read();
  assert.equal(partial.job.tasks[A].status, 'complete');
  assert.equal(partial.job.tasks[A].attempts, 1);
  assert.equal(partial.job.tasks[B].lastCode, 'COLLECTION_TIMEOUT');
  assert.equal(partial.job.tasks[B].attempts, 1);
  assert.equal(partial.items[A].lastCollectionError, undefined);
});

test('a trailing transport error after all streamed products cannot turn completion into a retry', async t => {
  const h = await setup(t, { asins: [A, B], loadDetails: async (_job, _asins, _signal, _count, onItem) => {
    await onItem(completeItem(A));
    await onItem(completeItem(B));
    throw new Error('Transport cleanup failed after successful responses');
  } });
  await h.runner.tick();
  assert.equal(h.store.read().job.status, 'completed');
  assert.equal(h.store.read().job.lastError, null);
  assert.equal(h.store.read().job.tasks[A].attempts, 1);
  assert.equal(h.store.read().job.tasks[B].attempts, 1);
  h.advance(3_600_000);
  await h.runner.tick();
  assert.equal(h.calls.length, 1);
});

test('manual pause preserves an already streamed item and rejects every late callback', async t => {
  const firstSaved = deferred();
  const h = await setup(t, { asins: [A, B], loadDetails: async (_job, _asins, _signal, _count, onItem) => {
    await onItem(completeItem(A));
    firstSaved.resolve(onItem);
    await new Promise(() => {});
  } });
  const tick = h.runner.tick();
  const onItem = await firstSaved.promise;
  await h.runner.command(RUN, 'pause');
  await tick;
  const checkpoint = h.store.read();
  assert.equal(checkpoint.job.status, 'paused');
  assert.equal(checkpoint.job.tasks[A].attempts, 1);
  assert.equal(checkpoint.job.tasks[B].attempts, 0);
  assert.equal(await onItem(completeItem(B)), false);
  assert.deepEqual(h.store.read(), checkpoint);
});

test('a streamed challenge aborts immediately, preserves prior progress and leaves unvisited ASINs pending', async t => {
  const C = 'B000000003';
  let batchSignal;
  let lateCallback;
  const h = await setup(t, { asins: [A, B, C], loadDetails: async (_job, _asins, signal, _count, onItem) => {
    batchSignal = signal;
    lateCallback = onItem;
    await onItem(completeItem(A));
    await onItem(failedItem(B, 'AMAZON_ACCESS_CHALLENGE'));
    await new Promise(() => {});
  } });
  await h.runner.tick();
  const paused = h.store.read();
  assert.equal(batchSignal.aborted, true);
  assert.equal(paused.job.status, 'needs_attention');
  assert.equal(paused.job.enabled, false);
  assert.equal(paused.job.causeCode, 'AMAZON_ACCESS_CHALLENGE');
  assert.equal(paused.job.tasks[A].status, 'complete');
  assert.equal(paused.job.tasks[A].attempts, 1);
  assert.equal(paused.job.tasks[B].attempts, 1);
  assert.equal(paused.job.tasks[C].attempts, 0);
  assert.equal(await lateCallback(completeItem(C)), false);
  assert.deepEqual(h.store.read(), paused);
});

test('a streamed rate limit cannot be cleared by a subsequent successful product', async t => {
  const h = await setup(t, { asins: [A, B], loadDetails: async (_job, _asins, _signal, _count, onItem) => {
    await onItem(failedItem(A, 'AMAZON_HTTP_429'));
    await onItem(completeItem(B));
    return [failedItem(A, 'AMAZON_HTTP_429'), completeItem(B)];
  } });
  await h.runner.tick();
  const saved = h.store.read();
  assert.equal(saved.job.status, 'cooldown');
  assert.equal(saved.job.causeCode, 'AMAZON_HTTP_429');
  assert.equal(saved.job.restrictionCount, 1);
  assert.equal(saved.job.nextRetryAt, new Date(EPOCH + 300_000).toISOString());
  assert.equal(saved.job.tasks[B].status, 'complete');
  assert.equal(saved.job.tasks[B].attempts, 1);
});


for (const legacyFormula of [false, true]) {
  test(`real persistence commits the first product and its profit before the batch completes (${legacyFormula ? 'legacy migration' : 'current formula'})`, async t => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'scout-streaming-store-'));
    let runner;
    t.after(async () => {
      await runner?.close();
      assert.equal(path.dirname(temporaryRoot), os.tmpdir());
      assert.ok(path.basename(temporaryRoot).startsWith('scout-streaming-store-'));
      await rm(temporaryRoot, { recursive: true, force: true });
    });
    const previous = process.env.SCOUT_DATA_DIR;
    process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, 'module-default');
    let PersistenceStore;
    try { ({ PersistenceStore } = await import('../lib/persistence-store.mjs')); }
    finally {
      if (previous === undefined) delete process.env.SCOUT_DATA_DIR;
      else process.env.SCOUT_DATA_DIR = previous;
    }
    const store = new PersistenceStore({ directory: path.join(temporaryRoot, 'isolated') });
    await store.ready();
    const runId = 'streaming-real';
    await store.saveSnapshot({
      runState: { id: runId, marketplace: 'CA', currency: 'CAD', mode: 'live', analysisSourceMode: 'amazon_only' },
      products: [A, B].map(asin => ({ id: `CA:${asin}`, asin, sourceAsin: asin, marketplace: 'CA', currency: 'CAD', currentPrice: null,
        manualPurchaseCost: true, purchaseCost: 6, purchaseUnitCostCny: 6, suppliers: [{ unitPriceCny: 18, source: 'saved_manual_quote' }] })),
      storeList: { stores: [] },
    });
    const firstSaved = deferred();
    const releaseSecond = deferred();
    const events = [];
    runner = new AmazonCollectionRunner({
      store,
      seed: async () => ({ discoveryComplete: true, targets: [target(A), target(B)], items: [] }),
      discover: async () => { throw new Error('No discovery expected'); },
      loadDetails: async (_job, _asins, _signal, onItem) => {
        await onItem(completeItem(A));
        firstSaved.resolve();
        await releaseSecond.promise;
        await onItem(completeItem(B));
        return [completeItem(A), completeItem(B)];
      },
    });
    await runner.initialize({ timer: false });
    await runner.start(runId);
    if (legacyFormula) {
      const old = await store.readRunFile(runId);
      old.snapshot.products.forEach(product => { product.profitInputs.formulaVersion = 'legacy-profit-formula-v10'; });
      await store.writeRunFile(runId, old);
    }
    store.onSnapshotUpdated(event => events.push(copy(event)));
    const tick = runner.tick();
    await firstSaved.promise;
    // Read the durable document directly: a read-time projection must not be
    // able to hide failure to save the first product's computed profit.
    const first = await store.readRunFile(runId);
    const savedA = first.snapshot.products.find(product => product.asin === A);
    const savedB = first.snapshot.products.find(product => product.asin === B);
    assert.equal(first.amazonCollection.job.status, 'running');
    assert.equal(first.amazonCollection.job.counts.processed, 1);
    assert.equal(savedA.currentPrice, 9.99);
    assert.equal(savedA.purchaseCost, 6);
    assert.deepEqual(savedA.suppliers, [{ unitPriceCny: 18, source: 'saved_manual_quote' }]);
    assert.equal(savedA.profitInputs.formulaVersion, PROFIT_FORMULA_VERSION);
    assert.ok(Number.isFinite(savedA.profitCalculation?.profit));
    assert.equal(savedB.currentPrice, null);
    const firstEvent = events.find(event => event.revision === first.amazonCollection.job.revision);
    if (legacyFormula) {
      assert.equal(firstEvent, undefined, 'legacy formula migration uses a full snapshot event');
      assert.deepEqual(events.at(-1), { runId });
    } else {
      assert.equal(firstEvent.kind, 'amazon_product');
      assert.deepEqual(firstEvent.products.map(product => product.asin), [A]);
      assert.deepEqual(firstEvent.products[0].profitCalculation, savedA.profitCalculation);
    }
    releaseSecond.resolve();
    await tick;
    const final = await store.readRunFile(runId);
    assert.equal(final.amazonCollection.job.status, 'completed');
    const lastEvent = events.at(-1);
    assert.equal(lastEvent.kind, 'amazon_product');
    assert.deepEqual(lastEvent.products.map(product => product.asin), [B]);
    assert.equal(lastEvent.products[0].purchaseCost, 6);
    assert.ok(Number.isFinite(lastEvent.products[0].profitCalculation?.profit));
    assert.equal(final.amazonCollection.job.tasks[A].attempts, 1);
    assert.equal(final.amazonCollection.job.tasks[B].attempts, 1);
  });
}


test('legacy absence claims are re-audited once without resuming completed or manually paused tasks', async t => {
  for (const status of ['completed', 'paused', 'needs_attention']) {
    const source = { ...completeItem(A), productWeightKg: null, manualPurchaseCost: true, purchaseCost: 8, suppliers: [{ unitPriceCny: 8 }] };
    const first = await setup(t, { items: [source] });
    await first.runner.close();
    const saved = first.store.records.get(RUN);
    saved.job.status = status; saved.job.enabled = false;
    saved.job.causeCode = status === 'paused' ? 'USER_PAUSED' : status === 'needs_attention' ? 'AMAZON_ACCESS_CHALLENGE' : null;
    saved.items[A].collectionQuality.version = 1;
    saved.items[A].collectionQuality.fields.weight = { status: 'unavailable', reason: 'page_not_provided' };
    const before = copy(saved.job.tasks);
    const restarted = await setup(t, { store: first.store, clock: first.clock });
    const current = restarted.store.read();
    assert.equal(current.items[A].collectionQuality.version, AMAZON_DETAIL_QUALITY_VERSION);
    assert.equal(current.items[A].collectionQuality.fields.weight.status, 'missing');
    assert.equal(current.items[A].collectionQuality.fields.weight.reason, 'product_information_unchecked');
    assert.equal(current.job.status, status);
    assert.equal(current.job.enabled, false);
    assert.deepEqual(current.job.tasks, before);
    assert.equal(current.items[A].purchaseCost, 8);
    assert.deepEqual(current.items[A].suppliers, source.suppliers);
    await restarted.runner.tick();
    assert.equal(restarted.calls.length, 0);
    const revision = restarted.store.read().job.revision;
    await restarted.runner.initialize({ timer: false });
    assert.equal(restarted.store.read().job.revision, revision);
  }
});


test('network-only discovery interruption automatically cools down and resumes the same cursor after restart', async t => {
  const h = await setup(t, { config: { discover: async () => { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }); } } });
  await h.store.updateAmazonCollection(RUN, saved => {
    saved.job.phase = 'discover'; saved.job.discoveryComplete = false; saved.job.discoveryCursor = 7;
    return saved;
  });
  for (let i = 0; i < 3; i++) { await h.runner.tick(); h.advance(60_000); }
  assert.equal((await h.runner.status()).status, 'needs_attention');
  const checkpoint = h.store.read();
  await h.runner.tick();
  const scheduled = await h.runner.status();
  assert.equal(scheduled.status, 'cooldown');
  assert.equal(scheduled.causeCode, 'ECONNRESET');
  assert.ok(Date.parse(scheduled.nextRetryAt) >= h.clock.value + 300_000);
  assert.deepEqual(h.store.read().job.tasks, checkpoint.job.tasks);
  await h.runner.close();
  let cursor;
  const next = await setup(t, { store: h.store, clock: h.clock, config: { discover: async job => {
    cursor = job.discoveryCursor; return { targets: [], complete: true, cursor: 8 };
  } } });
  await next.runner.tick(); assert.equal(cursor, undefined);
  next.advance(300_000);
  await next.runner.tick(); assert.equal(cursor, 7);
  assert.equal((await next.runner.status()).runId, RUN);
  assert.equal(h.store.read().job.discoveryRecovery.attempts.length, 1);
});

test('discovery recovery preserves manual, verification, supplier and unknown-error stops', async t => {
  for (const patch of [
    { enabled: false }, { status: 'paused', causeCode: 'USER_PAUSED' },
    { causeCode: 'AMAZON_ACCESS_CHALLENGE' }, { causeCode: 'UNEXPECTED_ERROR' },
    { supplierPause: { previousStatus: 'running' } }, { archivedAt: new Date(EPOCH).toISOString() },
  ]) {
    const h = await setup(t);
    Object.assign(h.store.records.get(RUN).job, { status: 'needs_attention', phase: 'discover',
      discoveryComplete: false, causeCode: 'ECONNRESET', ...patch });
    const before = h.store.read();
    await h.runner.tick();
    assert.deepEqual(h.store.read(), before);
    assert.equal(h.calls.length, 0);
  }
});

test('discovery recovery defers a saturated hourly budget without resetting item attempts', async t => {
  const h = await setup(t);
  const attempts = Array.from({ length: 5 }, (_, i) => new Date(EPOCH - 60_000 + i * 1000).toISOString());
  Object.assign(h.store.records.get(RUN).job, { status: 'needs_attention', phase: 'discover',
    discoveryComplete: false, causeCode: 'ECONNRESET', discoveryRecovery: { attempts } });
  const before = h.store.read();
  await h.runner.tick();
  const after = h.store.read();
  assert.equal(after.job.status, 'cooldown');
  assert.ok(Date.parse(after.job.nextRetryAt) >= Date.parse(attempts[0]) + 3_600_000);
  assert.deepEqual(after.job.discoveryRecovery.attempts, attempts);
  assert.deepEqual(after.job.tasks, before.job.tasks);
  await h.runner.tick();
  assert.equal(h.calls.length, 0);
});

test('a pause arriving during discovery recovery inspection wins over automatic continuation', async t => {
  const h = await setup(t);
  Object.assign(h.store.records.get(RUN).job, { status: 'needs_attention', phase: 'discover',
    discoveryComplete: false, causeCode: 'ECONNRESET' });
  const gate = h.store.holdNextRead();
  const tick = h.runner.tick();
  await gate.started.promise;
  await h.runner.command(RUN, 'pause');
  gate.release.resolve();
  await tick;
  assert.equal(h.store.read().job.status, 'paused');
  assert.equal(h.store.read().job.enabled, false);
  assert.equal(h.store.read().job.discoveryRecovery, undefined);
});

test('normalized store timeout results retain their cause and automatically recover through the production discovery adapter', async t => {
  const { discoverAmazonCollection } = await import('../server.mjs');
  let requests = 0;
  const h = await setup(t, { config: {
    seed: async () => ({ targets: [], items: [], discoveryComplete: false }),
    discover: (job, signal) => discoverAmazonCollection(job, signal, {
      store: { getAmazonStoreCheckpoints: async () => ({}) },
      search: async () => { requests++; return { errors: [{ code: 'AMAZON_FETCH_TIMEOUT', retryable: true, message: 'store timed out' }],
        storeVisits: [{ code: 'AMAZON_FETCH_TIMEOUT', status: 'pending' }], items: [] }; },
    }),
  } });
  h.store.records.get(RUN).job.stores = [{ sellerId: 'TESTSELLER01', asins: [], rowNumbers: [2] }];
  for (let i = 0; i < 3; i++) { await h.runner.tick(); h.advance(120_000); }
  assert.equal(requests, 3);
  assert.equal((await h.runner.status()).causeCode, 'AMAZON_FETCH_TIMEOUT');
  await h.runner.tick();
  const status = await h.runner.status();
  assert.equal(status.status, 'cooldown');
  assert.ok(Date.parse(status.nextRetryAt) >= h.clock.value + 300_000);
  h.advance(300_000);
  await h.runner.tick();
  assert.equal(requests, 4);
  assert.equal((await h.runner.status()).runId, RUN);
});
