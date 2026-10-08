import test from 'node:test';
import assert from 'node:assert/strict';
import { SupplierPipelineRunner } from '../lib/supplier-pipeline-runner.mjs';

const RUN = 'confirmed-run';
const TASK = '12345678-1234-1234-1234-123456789abc';
const EPOCH = Date.parse('2026-09-24T00:00:00Z');
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const product = (id, extra = {}) => ({ id, asin: id, imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg',
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
