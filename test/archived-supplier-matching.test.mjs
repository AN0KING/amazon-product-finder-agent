import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SupplierPipelineRunner } from '../lib/supplier-pipeline-runner.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'scout-archived-supplier-'));
const oldDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(root, 'module-default');
const { PersistenceStore } = await import('../lib/persistence-store.mjs');
if (oldDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
else process.env.SCOUT_DATA_DIR = oldDirectory;
after(async () => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('scout-archived-supplier-'));
  await rm(root, { recursive: true, force: true });
});
const RUN = 'history';
const item = (n, extra = {}) => ({ id: `CA:B${String(n).padStart(9, '0')}`, asin: `B${String(n).padStart(9, '0')}`,
  marketplace: 'CA', currency: 'CAD', imageUrl: 'https://example.invalid/image.jpg', supplierSearchStatus: 'not_started',
  manualSalePrice: true, salePrice: 42, manualBillingWeight: true, billingWeight: 0.75, ...extra });
const ready = { auth: { ready: true }, queue: { queued: 0, running: 0, riskBlocked: 0, ratePolicy: {} } };
const adapter = store => ({ readSnapshot: id => store.getRunSnapshot(id), readPipeline: id => store.getSupplierPipelineStatus(id),
  updateSnapshot: (id, fn, options) => store.updateSupplierSnapshot(id, fn, options),
  getActiveRunId: () => store.getActiveSupplierRunId(), setActiveRunId: id => store.setActiveSupplierRunId(id) });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(root, 'case-'));
  const store = new PersistenceStore({ directory });
  await store.saveSnapshot({ runState: { id: RUN, inputMode: 'asins', marketplace: 'CA', mode: 'live',
    supplier1688Pipeline: options.pipeline }, products: options.products || [item(1), item(2), item(3, { manualPurchaseCost: true, purchaseCost: 88 })] });
  await store.updateAmazonCollection(RUN, () => ({ job: { runId: RUN, owner: 'server', revision: 1, status: 'completed' }, items: {} }), { activate: true });
  await store.archiveRun(RUN);
  const frozen = await store.getRunSnapshot(RUN);
  await store.saveSnapshot({ runState: { id: 'current', marketplace: 'CA', mode: 'live' }, products: [] });
  await store.updateAmazonCollection('current', () => ({ job: { runId: 'current', owner: 'server', revision: 1, status: 'paused', enabled: false }, items: {} }), { activate: true });
  const currentBytes = await readFile(store.runPath('current'), 'utf8');
  const calls = [];
  const makeRunner = async (target = store) => {
    const runner = new SupplierPipelineRunner({ store: adapter(target),
      getRuntime: options.getRuntime || (async () => ready),
      search: async (product, snapshot, contract) => {
        calls.push(product.id);
        return options.search ? options.search(product, snapshot, contract) : { cost: 12 };
      },
      applyResult: (product, result) => ({ ...product, purchaseCost: result.cost, supplierSearchStatus: 'complete',
        suppliers: [{ name: 'Synthetic quote', unitPriceCny: result.cost }] }),
    });
    t.after(() => runner.close());
    await runner.initialize({ timer: false });
    return runner;
  };
  const runner = await makeRunner();
  const select = (ids = [item(1).id], extra = {}) => runner.selectArchived(RUN, { archivedAt: frozen.runState.archivedAt, productIds: ids, ...extra });
  return { store, frozen, calls, runner, select, makeRunner, directory, currentBytes };
}

test('explicit historical selection persists quotes, preserves manual fields and never reactivates Amazon or changes another run', async t => {
  const f = await fixture(t);
  const choice = { selectedUrl: 'https://detail.1688.com/offer/100000001.html', manualUrl: 'https://detail.1688.com/offer/100000002.html' };
  const review = await f.store.getRunSnapshot(RUN);
  review.products[0].supplierChoice = choice;
  await f.store.saveSnapshot(review);
  await assert.rejects(f.runner.start(RUN, { resume: true }), { code: 'RUN_ARCHIVED' });
  await assert.rejects(f.store.updateSupplierSnapshot(RUN, () => {}), { code: 'RUN_ARCHIVED' });
  const selected = await f.select();
  assert.equal(selected.status, 'paused'); assert.equal(f.calls.length, 0);
  await f.runner.start(RUN, { resume: true });
  const stale = await f.store.getRunSnapshot(RUN);
  await f.runner.tick();
  assert.deepEqual(f.calls, [item(1).id]);
  const restored = new PersistenceStore({ directory: f.directory });
  const saved = await restored.getRunSnapshot(RUN);
  assert.deepEqual(saved.products[0].supplierChoice, choice);
  assert.equal(saved.products[0].purchaseCost, 12);
  assert.equal(saved.products[0].salePrice, 42); assert.equal(saved.products[0].billingWeight, 0.75);
  assert.deepEqual(saved.products.slice(1), f.frozen.products.slice(1));
  assert.equal(saved.runState.archivedAt, f.frozen.runState.archivedAt);
  assert.deepEqual(saved.amazonCollection, f.frozen.amazonCollection);
  assert.equal((await restored.getActiveAmazonCollection()).runId, 'current');
  assert.equal((await restored.getOverview()).latestRunId, 'current');
  assert.equal(await readFile(restored.runPath('current'), 'utf8'), f.currentBytes);
  await assert.rejects(restored.saveSnapshot(stale), { code: 'STALE_SUPPLIER_SNAPSHOT' });
  await assert.rejects(restored.updateAmazonCollection(RUN, () => {}), { code: 'RUN_ARCHIVED' });
  saved.products[0].reviewStatus = 'approved';
  await restored.saveSnapshot(saved);
  assert.equal((await restored.getRunSnapshot(RUN)).products[0].reviewStatus, 'approved');
});

test('authorized history resumes after restart, with verification and rate cooldown still enforced', async t => {
  let runtime = { ...ready, queue: { ...ready.queue, riskBlocked: 1, ratePolicy: { pausedReason: 'RISK_CONTROL' } } };
  const f = await fixture(t, { getRuntime: async () => runtime });
  await f.select(); await f.runner.start(RUN, { resume: true });
  await f.runner.close();
  const restart = await f.makeRunner(new PersistenceStore({ directory: f.directory }));
  await restart.tick();
  assert.equal((await restart.status()).status, 'needs_attention'); assert.equal(f.calls.length, 0);
  runtime = ready;
  await restart.tick(); // A ready browser alone cannot release the saved verification pause.
  assert.equal(f.calls.length, 0);
  const until = new Date(Date.now() + 60_000).toISOString();
  runtime = { ...ready, queue: { ...ready.queue, ratePolicy: { nextAllowedAt: until } } };
  await restart.start(RUN, { resume: true }); await restart.tick();
  assert.equal((await restart.status()).status, 'cooldown'); assert.equal(f.calls.length, 0);
});

test('selection validates the archived task scope and keeps protected products and retry history', async t => {
  const done = item(1, { supplierSearchStatus: 'complete', purchaseCost: 25 });
  const f = await fixture(t, { products: [done, item(2), item(3, { analysisHandoff: { owner: 'procurement' } })],
    pipeline: { owner: 'server', status: 'paused', productIds: [done.id], tasks: { [done.id]: { status: 'complete', attempts: 2 } } } });
  await assert.rejects(f.select([item(99).id]), { code: 'SUPPLIER_SCOPE_INVALID' });
  await assert.rejects(f.select([item(3).id]), { code: 'SUPPLIER_NO_PENDING_PRODUCTS' });
  await assert.rejects(f.select([item(2).id], { archivedAt: 'stale' }), { code: 'RUN_ARCHIVED' });
  const selected = await f.select([item(2).id]);
  assert.equal(selected.tasks[done.id].attempts, 2);
  await f.runner.start(RUN, { resume: true }); await f.runner.tick();
  assert.deepEqual(f.calls, [item(2).id]);
  assert.deepEqual((await f.store.getRunSnapshot(RUN)).products[0], f.frozen.products[0]);
  const single = await f.select([done.id], { rematch: true });
  assert.deepEqual(single.productIds, [done.id]);
  assert.equal(single.tasks[done.id].previousAttempts[0].attempts, 2);
  await f.runner.start(RUN, { resume: true }); await f.runner.tick();
  assert.deepEqual(f.calls, [item(2).id, done.id]);
});

test('replacing reopened history fences an in-flight result and revokes permission across restart', async t => {
  let begin, finish;
  const started = new Promise(resolve => { begin = resolve; });
  const released = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { search: async () => { begin(); await released; return { cost: 999 }; } });
  await f.select(); await f.runner.start(RUN, { resume: true });
  const work = f.runner.tick(); await started;
  const cancelling = f.runner.cancelForReplacement(RUN);
  await new Promise(resolve => setImmediate(resolve));
  finish(); await cancelling; await work;
  await f.store.archiveRun(RUN);
  const stopped = await f.store.getRunSnapshot(RUN);
  assert.notEqual(stopped.products[0].purchaseCost, 999);
  assert.equal(stopped.runState.supplier1688Pipeline.status, 'cancelled');
  assert.equal(stopped.runState.supplier1688Pipeline.authorizedArchivedAt, undefined);
  assert.equal(await f.store.getActiveSupplierRunId(), null);
  await assert.rejects(f.store.updateSupplierSnapshot(RUN, () => {}), { code: 'RUN_ARCHIVED' });
  const restart = await f.makeRunner(new PersistenceStore({ directory: f.directory }));
  await restart.tick(); assert.equal(f.calls.length, 1);
  await assert.rejects(restart.start(RUN, { resume: true }), { code: 'RUN_ARCHIVED' });
});

test('large partitioned history retains the supplier permission and result through restart', async t => {
  const f = await fixture(t, { products: [item(1, { notes: 'x'.repeat(1024 * 1024) })] });
  assert.ok(JSON.parse(await readFile(f.store.runPath(RUN), 'utf8')).runPartitions);
  await f.select(); await f.runner.start(RUN, { resume: true }); await f.runner.close();
  const restored = new PersistenceStore({ directory: f.directory });
  const restarted = await f.makeRunner(restored);
  await restarted.tick();
  assert.deepEqual(f.calls, [item(1).id]);
  assert.equal((await restored.getRunSnapshot(RUN)).products[0].purchaseCost, 12);
  assert.equal((await restored.getRunSnapshot(RUN)).products[0].notes.length, 1024 * 1024);
});

test('historical selection cannot take over another paused supplier task or accept a forged browser permission', async t => {
  const f = await fixture(t);
  const forged = structuredClone(f.frozen);
  forged.runState.supplier1688Pipeline = { owner: 'server', authorizedArchivedAt: forged.runState.archivedAt,
    status: 'queued', enabled: true, productIds: [item(1).id] };
  await f.store.saveSnapshot(forged);
  await assert.rejects(f.runner.start(RUN, { resume: true }), { code: 'RUN_ARCHIVED' });
  await f.store.updateSupplierSnapshot('current', snapshot => {
    snapshot.runState.supplier1688Pipeline = { owner: 'server', status: 'paused', enabled: false, productIds: [], causeCode: 'USER_PAUSED' };
  });
  await f.store.setActiveSupplierRunId('current');
  const before = await f.store.getRunSnapshot(RUN);
  await assert.rejects(f.select(), { code: 'SUPPLIER_BUSY' });
  assert.deepEqual(await f.store.getRunSnapshot(RUN), before);
  assert.equal(await f.store.getActiveSupplierRunId(), 'current');
  assert.equal(f.calls.length, 0);
});
