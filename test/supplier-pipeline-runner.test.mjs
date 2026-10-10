import test from 'node:test';
import assert from 'node:assert/strict';
import { SupplierPipelineRunner } from '../lib/supplier-pipeline-runner.mjs';

const RUN = 'confirmed-run';
const TASK = '12345678-1234-1234-1234-123456789abc';
const EPOCH = Date.parse('2026-09-24T00:00:00Z');
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const product = (id, extra = {}) => ({ id, asin: 'B012345678', imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg',
  sales30: 50, sales30Evidence: { source: 'amazon_product_page', period: 'past_month',
    value: 50, rawText: '50+ bought in past month', asin: 'B012345678', kind: 'lower_bound' },
  supplierSearchStatus: 'not_started', purchaseCost: null, ...extra });
const ready = () => ({ auth: { ready: true }, queue: { queued: 0, running: 0, riskBlocked: 0, ratePolicy: {} } });
const snapshot = (products, ids = products.map(item => item.id), pipeline = {}) => ({
  runState: { id: RUN, errors: [], supplier1688Pipeline: { productIds: ids, status: 'paused', ...pipeline } }, products,
});

class MemoryStore {
  constructor(value) { this.records = new Map([[RUN, copy(value)]]); this.active = null; this.writes = []; this.queue = Promise.resolve(); }
  async readSnapshot(id) { return copy(this.records.get(id)); }
  async getActiveRunId() { return this.active; }
  async setActiveRunId(id) { this.active = id; }
  updateSnapshot(id, operation) {
    const next = this.queue.then(async () => {
      const draft = copy(this.records.get(id));
      const result = await operation(draft) || draft;
      this.records.set(id, copy(result)); this.writes.push(copy(result)); return copy(result);
    });
    this.queue = next.catch(() => {}); return next;
  }
  read() { return copy(this.records.get(RUN)); }
}

async function setup(t, options = {}) {
  const store = options.store || new MemoryStore(options.snapshot || snapshot([product('A')]));
  const clock = options.clock || { now: EPOCH };
  const calls = [];
  const busy = [];
  const applied = [];
  const runner = new SupplierPipelineRunner({
    store, now: () => clock.now, retryMs: 100, intervalMs: 10,
    getRuntime: options.getRuntime || (async () => ready()),
    canRun: options.canRun || (() => true), onBusy: value => busy.push(value),
    search: async (item, state, contract) => {
      calls.push({ item: copy(item), snapshot: copy(state) });
      return options.search ? options.search(item, state, contract, store) : { cost: 10 };
    },
    applyResult: (item, result, state) => {
      applied.push(item.id);
      if (options.applyResult) return options.applyResult(item, result, state);
      return { ...item, supplierSearchStatus: 'complete', purchaseCost: result.cost, margin: 25, profitValue: 5 };
    },
  });
  t.after(() => runner.close());
  await runner.initialize({ timer: false });
  if (options.start !== false) await runner.start(RUN, { resume: true });
  return { runner, store, clock, calls, busy, applied, advance: ms => { clock.now += ms; } };
}

test('only the confirmed cohort runs and every successful result is applied to the latest snapshot before the next item', async t => {
  const state = snapshot([product('A'), product('B')], ['A']);
  const mock = await setup(t, { snapshot: state });
  await mock.runner.tick();
  assert.deepEqual(mock.calls.map(call => call.item.id), ['A']);
  assert.equal(mock.store.read().products[0].margin, 25);
  assert.equal(mock.store.read().products[1].supplierSearchStatus, 'not_started');
  const pipeline = mock.store.read().runState.supplier1688Pipeline;
  assert.equal(pipeline.status, 'complete'); assert.equal(pipeline.remaining, 0); assert.equal(pipeline.processed, 1);
  assert.deepEqual(pipeline.productIds, ['A']); assert.equal(pipeline.owner, 'server');
  assert.deepEqual(mock.busy, [true, false]);
  assert.ok(mock.store.writes.some(state => state.products[0].supplierSearchStatus === 'searching'));
});

test('scope is required, same-run start is idempotent and a different active run is rejected', async t => {
  const mock = await setup(t);
  const revision = (await mock.runner.status()).revision;
  await mock.runner.start(RUN, { resume: true });
  assert.equal((await mock.runner.status()).revision, revision);
  mock.store.records.set('other', snapshot([product('B')]));
  await assert.rejects(mock.runner.start('other'), { code: 'SUPPLIER_BUSY' });
  const empty = await setup(t, { snapshot: snapshot([], []), start: false });
  await assert.rejects(empty.runner.start(RUN), { code: 'SUPPLIER_SCOPE_REQUIRED' });
});

test('initialization never claims historical browser-owned batches or resumes a manual pause or risk block', async t => {
  for (const pipeline of [{}, { owner: 'server', status: 'paused', enabled: false }, { owner: 'server', status: 'needs_attention', enabled: false }]) {
    const store = new MemoryStore(snapshot([product('A')], ['A'], pipeline)); store.active = RUN;
    const mock = await setup(t, { store, start: false });
    await mock.runner.tick();
    assert.equal(mock.calls.length, 0);
    assert.equal(mock.runner.isRunnable(), false);
    if (!pipeline.owner) assert.equal(await mock.runner.status(), null);
  }
});

test('recovery of a server-owned running task preserves and reuses its durable task ID', async t => {
  const store = new MemoryStore(snapshot([product('A', { supplierSearchStatus: 'searching' })], ['A'], {
    owner: 'server', status: 'running', enabled: true, activeProductId: 'A',
    tasks: { A: { status: 'running', taskId: TASK, attempts: 1, failureCount: 0 } },
  })); store.active = RUN;
  const mock = await setup(t, { store, start: false });
  await mock.runner.tick();
  assert.equal(mock.calls[0].item.supplierProcurementTaskId, TASK);
  assert.equal(mock.store.read().products[0].supplierProcurementTaskId, TASK);
  assert.equal(mock.store.read().runState.supplier1688Pipeline.restartCount, 1);
});

test('overlapping ticks remain serial, and onTask is durably saved before further task work', async t => {
  const started = deferred(), release = deferred();
  const mock = await setup(t, { search: async (_item, _state, { onTask }, store) => {
    await onTask({ taskId: TASK });
    assert.equal(store.read().products[0].supplierProcurementTaskId, TASK);
    assert.equal(store.read().runState.supplier1688Pipeline.tasks.A.taskId, TASK);
    started.resolve(); await release.promise; return { cost: 10 };
  } });
  const first = mock.runner.tick(); await started.promise;
  const second = mock.runner.tick(); assert.equal(first, second); assert.equal(mock.calls.length, 1);
  release.resolve(); await first;
  assert.equal(mock.applied.length, 1);
});

for (const protection of [{ manualPurchaseCost: true, purchaseCost: 88 }, { analysisHandoff: { owner: 'procurement' } }, { reviewStatus: 'rejected' }]) {
  test(`a user edit during search preserves ${Object.keys(protection)[0]} and rejects stale result application`, async t => {
    const started = deferred(), release = deferred();
    const mock = await setup(t, { search: async () => { started.resolve(); await release.promise; return { cost: 10 }; } });
    const work = mock.runner.tick(); await started.promise;
    await mock.store.updateSnapshot(RUN, state => { Object.assign(state.products[0], protection); });
    release.resolve(); await work;
    assert.equal(mock.applied.length, 0);
    for (const [key, value] of Object.entries(protection)) assert.deepEqual(mock.store.read().products[0][key], value);
  });
}

test('manual pause lets the current result finish but never starts the next product or restores itself', async t => {
  const started = deferred(), release = deferred();
  const mock = await setup(t, { snapshot: snapshot([product('A'), product('B')]), search: async (_item, _state, { signal }) => {
    started.resolve(); await release.promise; assert.equal(signal.aborted, false); return { cost: 10 };
  } });
  const work = mock.runner.tick(); await started.promise;
  await mock.runner.pause(RUN);
  assert.equal((await mock.runner.status()).status, 'paused');
  release.resolve(); await work; await mock.runner.tick();
  assert.equal(mock.store.read().products[0].purchaseCost, 10);
  assert.equal(mock.store.read().products[1].purchaseCost, null);
  assert.equal(mock.calls.length, 1); assert.equal((await mock.runner.status()).status, 'paused');
});

test('ordinary failures retry at most three times with backoff and the same existing task ID', async t => {
  const mock = await setup(t, { search: async (_item, _state, { onTask }) => {
    await onTask(TASK); throw Object.assign(new Error('temporary error'), { code: 'NETWORK_ERROR' });
  } });
  await mock.runner.tick(); assert.equal(mock.calls.length, 1);
  await mock.runner.tick(); assert.equal(mock.calls.length, 1);
  mock.advance(100); await mock.runner.tick(); assert.equal(mock.calls.length, 2);
  mock.advance(199); await mock.runner.tick(); assert.equal(mock.calls.length, 2);
  mock.advance(1); await mock.runner.tick(); assert.equal(mock.calls.length, 3);
  mock.advance(10000); await mock.runner.tick(); assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.slice(1).every(call => call.item.supplierProcurementTaskId === TASK));
  assert.ok(mock.store.read().runState.errors.every(error => error.taskId === TASK));
  assert.equal((await mock.runner.status()).failedCount, 1);
  assert.equal((await mock.runner.status()).status, 'complete');
});

test('risk control preserves its task ID and requires explicit resume even after the runtime becomes ready', async t => {
  let risk = true;
  const mock = await setup(t, { search: async () => {
    if (risk) throw Object.assign(new Error('manual verification required'), { code: 'RISK_CONTROL', details: { taskId: TASK } });
    return { cost: 10 };
  } });
  await mock.runner.tick(); risk = false; mock.advance(100000);
  await mock.runner.tick(); assert.equal(mock.calls.length, 1);
  assert.equal((await mock.runner.status()).status, 'needs_attention');
  assert.equal(mock.store.read().products[0].supplierProcurementTaskId, TASK);
  await mock.runner.start(RUN, { resume: true }); await mock.runner.tick();
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[1].item.supplierProcurementTaskId, TASK);
});

test('runtime cooldown, an unrelated queued task, and risk blocks start no search', async t => {
  for (const queue of [
    { ratePolicy: { nextAllowedAt: new Date(EPOCH + 1000).toISOString() } },
    { queued: 1, ratePolicy: {} },
    { riskBlocked: 1, ratePolicy: {} },
    { ratePolicy: { manualResumeRequired: true } },
  ]) {
    const mock = await setup(t, { getRuntime: async () => ({ auth: { ready: true }, queue }) });
    await mock.runner.tick(); assert.equal(mock.calls.length, 0); assert.equal(mock.runner.isRunnable(), false);
    assert.equal(mock.busy.length, 0);
  }
});

test('an existing task may be reused while the queue is active, and takes priority over better-priced new products', async t => {
  const mock = await setup(t, {
    snapshot: snapshot([product('A', { salePrice: 20, productWeight: 1 }), product('B', { supplierProcurementTaskId: TASK })]),
    getRuntime: async () => ({ ...ready(), queue: { running: 1 } }),
  });
  await mock.runner.tick(); assert.equal(mock.calls[0].item.id, 'B');
  assert.equal(mock.calls[0].item.supplierProcurementTaskId, TASK);
});

test('valid price and weight get priority after reusable tasks, and terminal quotes are skipped', async t => {
  const mock = await setup(t, { snapshot: snapshot([
    product('A'), product('B', { salePrice: 20, productWeight: 1 }),
    product('C', { supplierSearchStatus: 'fallback_estimate', purchaseCost: 8 }),
  ]) });
  await mock.runner.tick(); await mock.runner.tick(); await mock.runner.tick();
  assert.deepEqual(mock.calls.map(call => call.item.id), ['B', 'A']);
  assert.equal(mock.store.read().products[2].purchaseCost, 8);
});

test('the shared browser busy guard prevents work without claiming another product', async t => {
  const mock = await setup(t, { canRun: () => false });
  await mock.runner.tick(); assert.equal(mock.calls.length, 0); assert.deepEqual(mock.busy, []);
  assert.equal(mock.store.read().products[0].supplierSearchStatus, 'not_started');
});

test('shutdown aborts transport but keeps the task ID available to the next server instance', async t => {
  const assigned = deferred();
  const mock = await setup(t, { search: async (_item, _state, { onTask, signal }) => {
    await onTask(TASK); assigned.resolve();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const work = mock.runner.tick(); await assigned.promise; await mock.runner.close(); await work;
  assert.equal(mock.store.read().products[0].supplierProcurementTaskId, TASK);
  assert.equal(mock.store.read().runState.errors.length, 0);
  const replacement = await setup(t, { store: mock.store, start: false });
  await replacement.runner.tick(); assert.equal(replacement.calls[0].item.supplierProcurementTaskId, TASK);
});

test('removed products and a changed cohort cannot receive an in-flight result', async t => {
  const started = deferred(), release = deferred();
  const mock = await setup(t, { search: async () => { started.resolve(); await release.promise; return { cost: 10 }; } });
  const work = mock.runner.tick(); await started.promise;
  await mock.store.updateSnapshot(RUN, state => { state.runState.supplier1688Pipeline.productIds = []; });
  release.resolve(); await work; assert.equal(mock.applied.length, 0);
});

test('a manual pause arriving during the runtime check prevents the pending business request', async t => {
  const started = deferred(), release = deferred();
  const mock = await setup(t, { getRuntime: async () => { started.resolve(); await release.promise; return ready(); } });
  const work = mock.runner.tick(); await started.promise;
  await mock.runner.pause(RUN); release.resolve(); await work;
  assert.equal(mock.calls.length, 0);
  assert.equal((await mock.runner.status()).status, 'paused');
});

test('discard clears the batch checkpoint, keeps matched quotes and resets transient states', async t => {
  const state = snapshot([
    product('A', { supplierSearchStatus: 'pending' }),
    product('B', { supplierSearchStatus: 'complete', purchaseCost: 8 }),
    product('C', { supplierSearchStatus: 'queue_waiting' }),
    product('D', { supplierSearchStatus: 'failed', supplierSearchErrorCode: 'NO_MATCH' }),
  ], ['A', 'B', 'C', 'D']);
  const mock = await setup(t, { snapshot: state });
  assert.equal((await mock.runner.status())?.owner, 'server');
  await mock.runner.discard(RUN);
  const saved = mock.store.read();
  assert.equal(saved.runState.supplier1688Pipeline, undefined);
  assert.equal(saved.products[0].supplierSearchStatus, 'not_started');
  assert.equal(saved.products[1].supplierSearchStatus, 'complete');
  assert.equal(saved.products[1].purchaseCost, 8);
  assert.equal(saved.products[2].supplierSearchStatus, 'not_started');
  assert.equal(saved.products[3].supplierSearchStatus, 'failed');
  assert.equal(await mock.runner.status(), null);
  assert.equal(mock.store.active, null);
});

test('a replacement batch starts cleanly after the old one is discarded', async t => {
  const mock = await setup(t);
  await mock.runner.discard(RUN);
  mock.store.records.set(RUN, snapshot([product('Z')], ['Z'], { status: 'queued' }));
  await mock.runner.start(RUN, { resume: true });
  await mock.runner.tick();
  assert.deepEqual(mock.calls.map(call => call.item.id), ['Z']);
  assert.equal(mock.store.read().runState.supplier1688Pipeline.owner, 'server');
});

test('append extends the same 66-product cohort by 194 and preserves every old result and task', async t => {
  const old = Array.from({ length: 66 }, (_, index) => product('old-' + index, {
    supplierSearchStatus: 'complete', purchaseCost: index + 1, margin: 25,
    supplierQuotes: [{ offerId: 'offer-' + index, price: index + 1 }],
  }));
  const fresh = Array.from({ length: 194 }, (_, index) => product('new-' + index));
  const tasks = Object.fromEntries(old.map(item => [item.id, {
    status: 'complete', taskId: TASK, attempts: 2, failureCount: 1,
  }]));
  const state = snapshot([...old, ...fresh, product('no-image', { imageUrl: '' })], old.map(item => item.id), {
    owner: 'server', selectionId: 'original-selection', startedAt: '2026-10-09T00:00:00Z',
    status: 'complete', enabled: false, revision: 263, selectedCount: 66, matchableCount: 66,
    processed: 66, remaining: 0, completedAt: '2026-10-09T01:00:00Z', tasks,
  });
  const mock = await setup(t, { snapshot: state, start: false });
  const ids = [...fresh.map(item => item.id), 'new-0', 'old-0', 'no-image'];
  const status = await mock.runner.append(RUN, ids);
  assert.equal(status.runId, RUN);
  assert.equal(status.selectionId, 'original-selection');
  assert.equal(status.startedAt, state.runState.supplier1688Pipeline.startedAt);
  assert.equal(status.revision, 264);
  assert.equal(status.selectedCount, 260); assert.equal(status.matchableCount, 260);
  assert.equal(status.processed, 66); assert.equal(status.remaining, 194);
  assert.equal(status.status, 'paused'); assert.equal(status.enabled, false);
  assert.equal(status.lastReason, 'selection_saved');
  assert.deepEqual(status.tasks, tasks);
  assert.deepEqual(mock.store.read().products, state.products);
  assert.deepEqual(status.productIds, [...old, ...fresh].map(item => item.id));
  assert.equal(mock.calls.length, 0); assert.equal(mock.store.active, null);
  const writes = mock.store.writes.length;
  assert.deepEqual(await mock.runner.append(RUN, ids), status);
  assert.equal(mock.store.writes.length, writes);
  await mock.runner.tick(); assert.equal(mock.calls.length, 0);
  await mock.runner.start(RUN, { resume: true });
  await mock.runner.tick();
  assert.deepEqual(mock.calls.map(call => call.item.id), ['new-0']);
  assert.deepEqual(mock.store.read().products.slice(0, 66), old);
});

test('append excludes prior terminal, protected, missing-image and exhausted products without resetting their tasks', async t => {
  const items = [
    product('old', { supplierSearchStatus: 'complete', purchaseCost: 18 }),
    product('new'), product('estimate', { supplierSearchStatus: 'fallback_estimate', purchaseCost: 8 }),
    product('manual', { manualPurchaseCost: true, purchaseCost: 0 }),
    product('manual-source', { costSource: 'manual', purchaseCost: 9 }),
    product('handoff', { analysisHandoff: { owner: 'procurement' } }),
    product('rejected', { reviewStatus: 'rejected' }),
    product('missing-image', { imageUrl: null }),
    product('failed'), product('skipped'), product('finished-task'),
  ];
  const tasks = { old: { status: 'complete', taskId: TASK, attempts: 1 },
    failed: { status: 'failed', taskId: TASK, attempts: 5, failureCount: 3 },
    skipped: { status: 'skipped', attempts: 1 }, 'finished-task': { status: 'complete', attempts: 2 } };
  const mock = await setup(t, { start: false, snapshot: snapshot(items, ['old'], {
    owner: 'server', status: 'complete', enabled: false, revision: 10, tasks,
  }) });
  const status = await mock.runner.append(RUN, items.map(item => item.id));
  assert.deepEqual(status.productIds, ['old', 'new']);
  assert.equal(status.failedCount, 1);
  assert.deepEqual(status.tasks, tasks);
  assert.deepEqual(mock.store.read().products, items);
  assert.equal(mock.calls.length, 0);
});

test('append retains browser ownership and manual or risk pauses until a separate explicit resume', async t => {
  for (const saved of [
    { owner: 'server', status: 'paused', enabled: false, causeCode: 'USER_PAUSED', lastReason: 'user_paused' },
    { owner: 'server', status: 'needs_attention', enabled: false, causeCode: 'RISK_CONTROL', lastReason: 'RISK_CONTROL' },
    { status: 'paused', enabled: false, causeCode: null, lastReason: 'selection_saved' },
  ]) {
    const tasks = { A: { status: 'pending', taskId: TASK, attempts: 2, failureCount: 1, nextRetryAt: '2026-10-10T00:00:00Z' } };
    const mock = await setup(t, { start: false, snapshot: snapshot([product('A'), product('B')], ['A'], { ...saved, tasks }) });
    const status = await mock.runner.append(RUN, ['B']);
    for (const key of ['owner', 'status', 'enabled', 'causeCode', 'lastReason']) assert.equal(status[key], saved[key]);
    assert.deepEqual(status.tasks, tasks);
    await mock.runner.tick();
    assert.equal(mock.calls.length, 0); assert.equal(mock.store.active, null);
  }
});

test('append validates all product IDs before saving and rejects unsupported or foreign scope without a partial write', async t => {
  const mock = await setup(t, { start: false, snapshot: snapshot([product('A'), product('B')], ['A']) });
  const before = mock.store.read();
  for (const ids of [undefined, [], [''], ['  '], [1], ['B\n'], Array(10001).fill('B'), ['B', 'foreign']]) {
    await assert.rejects(mock.runner.append(RUN, ids), { code: 'SUPPLIER_SCOPE_INVALID', status: 422 });
    assert.deepEqual(mock.store.read(), before);
  }
  assert.equal(mock.store.writes.length, 0); assert.equal(mock.runner.runId, null);
  const status = await mock.runner.append(RUN, [' B ', 'B']);
  assert.deepEqual(status.productIds, ['A', 'B']);
});

test('append refuses running or queued cohorts and another unfinished run without changing their snapshots', async t => {
  for (const status of ['queued', 'running', 'cooldown']) {
    const mock = await setup(t, { start: false, snapshot: snapshot([product('A'), product('B')], ['A'], { owner: 'server', status }) });
    const before = mock.store.read();
    await assert.rejects(mock.runner.append(RUN, ['B']), { code: 'SUPPLIER_BUSY' });
    assert.deepEqual(mock.store.read(), before); assert.equal(mock.calls.length, 0);
  }
  const mock = await setup(t, { start: false, snapshot: snapshot([product('A'), product('B')], ['A']) });
  mock.store.records.set('other', snapshot([product('Z')], ['Z'], { owner: 'server', status: 'paused' }));
  mock.store.active = 'other';
  await assert.rejects(mock.runner.append(RUN, ['B']), { code: 'SUPPLIER_BUSY' });
  assert.equal(mock.store.writes.length, 0); assert.equal(mock.store.active, 'other');
});

test('append refuses a paused cohort while its in-flight result is still being saved', async t => {
  const started = deferred(), release = deferred();
  const mock = await setup(t, { snapshot: snapshot([product('A'), product('B')], ['A']),
    search: async () => { started.resolve(); await release.promise; return { cost: 10 }; } });
  const work = mock.runner.tick(); await started.promise;
  await mock.runner.pause(RUN);
  await assert.rejects(mock.runner.append(RUN, ['B']), { code: 'SUPPLIER_BUSY' });
  release.resolve(); await work;
  assert.deepEqual(mock.store.read().runState.supplier1688Pipeline.productIds, ['A']);
  assert.equal(mock.calls.length, 1);
});

test('append merges against the transaction snapshot and leaves concurrent product edits and retry history intact', async t => {
  const mock = await setup(t, { start: false, snapshot: snapshot([product('A'), product('B'), product('C')], ['A'], {
    owner: 'server', status: 'paused', enabled: false, causeCode: 'USER_PAUSED', revision: 9,
  }) });
  const update = mock.store.updateSnapshot.bind(mock.store);
  mock.store.updateSnapshot = (id, operation) => update(id, draft => {
    draft.products[1].manualPurchaseCost = true; draft.products[1].purchaseCost = 77;
    draft.runState.supplier1688Pipeline.revision = 12;
    draft.runState.supplier1688Pipeline.tasks = { A: { status: 'pending', attempts: 4, failureCount: 2, taskId: TASK } };
    return operation(draft);
  });
  const status = await mock.runner.append(RUN, ['B', 'C']);
  assert.deepEqual(status.productIds, ['A', 'C']);
  assert.equal(status.revision, 13);
  assert.equal(status.causeCode, 'USER_PAUSED');
  assert.deepEqual(status.tasks.A, { status: 'pending', attempts: 4, failureCount: 2, taskId: TASK });
  assert.equal(mock.store.read().products[1].purchaseCost, 77);
  assert.equal(mock.calls.length, 0);
});

test('a failed append save does not switch runner ownership or the active saved run', async t => {
  const mock = await setup(t, { start: false, snapshot: snapshot([product('A'), product('B')], ['A']) });
  const other = snapshot([product('Z')], ['Z'], { owner: 'server', status: 'complete', revision: 7 });
  mock.store.records.set('other', other); mock.store.active = 'other'; mock.runner.runId = 'other';
  const beforeStatus = await mock.runner.status();
  const before = mock.store.read();
  mock.store.updateSnapshot = async () => { throw new Error('disk full'); };
  await assert.rejects(mock.runner.append(RUN, ['B']), /disk full/);
  assert.equal(mock.runner.runId, 'other'); assert.equal(mock.store.active, 'other');
  assert.deepEqual(mock.runner.cachedStatus, beforeStatus);
  assert.deepEqual(mock.store.read(), before);
  assert.equal(mock.calls.length, 0);
});
test('append checks the persisted active run even when the runner still points at a completed earlier run', async t => {
  const mock = await setup(t, { start: false, snapshot: snapshot([product('A'), product('B')], ['A']) });
  mock.store.records.set('completed', snapshot([product('X')], ['X'], { owner: 'server', status: 'complete' }));
  mock.store.records.set('active', snapshot([product('Y')], ['Y'], { owner: 'server', status: 'running' }));
  mock.runner.runId = 'completed'; mock.store.active = 'active';
  await assert.rejects(mock.runner.append(RUN, ['B']), { code: 'SUPPLIER_BUSY' });
  assert.equal(mock.store.writes.length, 0); assert.equal(mock.store.active, 'active');
  assert.equal(mock.runner.runId, 'completed'); assert.equal(mock.calls.length, 0);
});
test('append skips unverified or below-threshold sales while preserving old results, costs and task IDs', async t => {
  const old = product('old', { sales30Evidence: null, supplierSearchStatus: 'complete', purchaseCost: 77,
    supplierQuotes: [{ id: 'saved-offer', price: 77 }], supplierProcurementTaskId: TASK });
  const items = [old, product('new'), product('numeric-only', { sales30: 200, sales30Evidence: null }),
    product('below', { sales30: 49, sales30Evidence: { source: 'amazon_product_page', period: 'past_month',
      kind: 'lower_bound', value: 49, rawText: '49+ bought in past month', asin: 'B012345678' } }),
    product('wrong-asin', { sales30Evidence: { source: 'amazon_product_page', period: 'past_month',
      kind: 'lower_bound', value: 100, rawText: '100+ bought in past month', asin: 'B098765432' } })];
  const tasks = { old: { status: 'complete', taskId: TASK, attempts: 2, failureCount: 1 } };
  const mock = await setup(t, { start: false, snapshot: snapshot(items, ['old'], {
    owner: 'server', status: 'complete', enabled: false, selectionId: 'same-selection', tasks,
  }) });
  const status = await mock.runner.append(RUN, items.map(item => item.id));
  assert.deepEqual(status.productIds, ['old', 'new']);
  assert.equal(status.processed, 1); assert.equal(status.remaining, 1);
  assert.equal(status.excludedMonthlySalesCount, 0); assert.equal(status.selectionId, 'same-selection');
  assert.deepEqual(status.tasks, tasks); assert.deepEqual(mock.store.read().products, items);
  const writes = mock.store.writes.length;
  await mock.runner.append(RUN, items.map(item => item.id));
  assert.equal(mock.store.writes.length, writes); assert.equal(mock.calls.length, 0);
});

test('restored queue skips historical products without qualifying sales without claiming they were matched', async t => {
  const old = product('old', { sales30Evidence: null, supplierSearchStatus: 'complete', purchaseCost: 18,
    supplierQuotes: [{ offerId: 'historical', price: 18 }], supplierProcurementTaskId: TASK });
  const unverified = product('unverified', { sales30: 500, sales30Evidence: null, supplierProcurementTaskId: TASK });
  const tasks = { old: { status: 'complete', taskId: TASK, attempts: 1 },
    unverified: { status: 'pending', taskId: TASK, attempts: 2, failureCount: 1 } };
  const store = new MemoryStore(snapshot([old, unverified, product('eligible')], ['old', 'unverified', 'eligible'], {
    owner: 'server', status: 'queued', enabled: true, selectionId: 'original-selection', tasks,
  }));
  store.active = RUN;
  const mock = await setup(t, { store, start: false });
  assert.equal((await mock.runner.status()).remaining, 1);
  await mock.runner.tick(); await mock.runner.tick();
  assert.deepEqual(mock.calls.map(call => call.item.id), ['eligible']);
  const saved = store.read();
  assert.deepEqual(saved.products.slice(0, 2), [old, unverified]);
  assert.deepEqual(saved.runState.supplier1688Pipeline.tasks.unverified, tasks.unverified);
  assert.deepEqual(saved.runState.supplier1688Pipeline.tasks.old, tasks.old);
  const status = await mock.runner.status();
  assert.equal(status.processed, 2); assert.equal(status.remaining, 0);
  assert.equal(status.excludedMonthlySalesCount, 1); assert.equal(status.matchableCount, 2);
  assert.equal(status.lastReason, 'monthly_sales_filtered'); assert.equal(status.status, 'complete');
  assert.equal(status.selectionId, 'original-selection');
});

test('sales exclusions never release manual pauses and do not issue runtime or supplier calls', async t => {
  const items = [product('A', { sales30Evidence: null })];
  const store = new MemoryStore(snapshot(items, ['A'], { owner: 'server', status: 'paused', enabled: false,
    causeCode: 'USER_PAUSED', lastReason: 'user_paused', tasks: { A: { status: 'pending', taskId: TASK } } }));
  store.active = RUN;
  const mock = await setup(t, { store, start: false, getRuntime: async () => { throw new Error('must not check login'); } });
  await mock.runner.tick();
  const status = await mock.runner.status();
  assert.equal(status.status, 'paused'); assert.equal(status.causeCode, 'USER_PAUSED');
  assert.equal(status.lastReason, 'user_paused'); assert.equal(status.processed, 0);
  assert.equal(status.remaining, 0); assert.equal(status.excludedMonthlySalesCount, 1);
  assert.deepEqual(store.read().products, items); assert.equal(mock.calls.length, 0);
});

test('repeated resumes of a completed sales-filtered cohort explain exclusions without changing its checkpoint', async t => {
  const done = product('done', { supplierSearchStatus: 'complete', purchaseCost: 12, suppliers: [{ unitPriceCny: 12 }] });
  const excluded = Array.from({ length: 43 }, (_, index) => product(`excluded-${index}`, { sales30: null, sales30Evidence: null }));
  const state = snapshot([done, ...excluded], ['done', ...excluded.map(item => item.id)], {
    owner: 'server', status: 'complete', enabled: false, remaining: 0, processed: 1,
    excludedMonthlySalesCount: 43, selectionId: 'original-selection', completedAt: new Date(EPOCH).toISOString(),
    tasks: { done: { status: 'complete', taskId: TASK, attempts: 1 } },
  });
  const mock = await setup(t, { snapshot: state, start: false, getRuntime: async () => { throw new Error('No runtime call expected'); } });
  const before = mock.store.read();
  const writes = mock.store.writes.length;
  for (let index = 0; index < 2; index++) {
    await assert.rejects(mock.runner.start(RUN, { resume: true }), error => error.code === 'SUPPLIER_NO_PENDING_PRODUCTS' && /43.*50\+.*刷新页面/.test(error.message));
  }
  assert.deepEqual(mock.store.read(), before);
  assert.equal(mock.store.writes.length, writes);
  assert.deepEqual(mock.calls, []);
  assert.equal(mock.store.active, null);
});
