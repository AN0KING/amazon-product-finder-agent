import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AmazonCollectionRunner } from '../lib/amazon-collection-runner.mjs';

async function fixture(t, products, { status = 'completed', causeCode = null, canRun = () => true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scout-profit-recovery-'));
  const previous = process.env.SCOUT_DATA_DIR;
  process.env.SCOUT_DATA_DIR = path.join(directory, 'default');
  let PersistenceStore;
  try { ({ PersistenceStore } = await import('../lib/persistence-store.mjs')); }
  finally {
    if (previous === undefined) delete process.env.SCOUT_DATA_DIR;
    else process.env.SCOUT_DATA_DIR = previous;
  }
  const store = new PersistenceStore({ directory });
  await store.ready();
  const runId = 'profit-recovery';
  await store.saveSnapshot({ runState: { id: runId, marketplace: 'CA', analysisSourceMode: 'amazon_only', mode: 'live' },
    storeList: { stores: [] }, products });
  await store.updateAmazonCollection(runId, () => ({ items: {}, job: { runId, id: runId,
    status, causeCode, enabled: false, revision: 1, tasks: {}, discoveryComplete: true } }), { activate: true });
  // Fixture: emulate an old interrupted calculation. Reads project profits, so
  // durable output is also inspected to ensure a refresh cannot mask a lost write.
  const legacy = await store.readRunFile(runId);
  legacy.snapshot.products = structuredClone(products);
  await store.writeRunFile(runId, legacy);
  const events = [];
  store.onSnapshotUpdated(event => events.push(event));
  const clock = { value: Date.parse('2026-10-16T08:00:00Z') };
  const unexpected = async () => { assert.fail('Profit maintenance must not visit Amazon or start a new batch'); };
  const runner = new AmazonCollectionRunner({ store, canRun, now: () => clock.value, seed: unexpected, discover: unexpected, loadDetails: unexpected });
  t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
  await runner.initialize({ timer: false });
  return { store, runId, runner, events, clock };
}

const product = (number, extra = {}) => ({ id: `CA:B${String(number).padStart(9, '0')}`,
  asin: `B${String(number).padStart(9, '0')}`, marketplace: 'CA', currentPrice: 25,
  productWeight: .1, margin: null, profitCalculation: null, profitPendingReasons: ['商品重量'], ...extra });

test('background inspection durably finishes every pending profit in a completed task without collecting again', async t => {
  const h = await fixture(t, Array.from({ length: 127 }, (_, index) => product(index)));
  const before = await h.runner.status();
  await h.runner.tick();
  const saved = await h.store.readRunFile(h.runId);
  assert.equal(saved.snapshot.products.length, 127);
  for (const row of saved.snapshot.products) {
    assert.ok(Math.abs(row.margin - 41.07164615384615) < 1e-9);
    assert.equal(row.profitCalculation.airFreight.actualWeightKg, .1);
    assert.equal(row.profitCalculation.weightAssumption, undefined);
    assert.equal(row.profitCalculation.purchaseCostAssumedZero, true);
    assert.equal(row.productWeight, .1);
    assert.deepEqual(row.profitPendingReasons, []);
  }
  const status = await h.runner.status();
  assert.equal(status.status, before.status);
  assert.equal(status.enabled, false);
  assert.equal(status.revision, before.revision + 1, 'polling catches up even when the SSE notification is missed');
  assert.equal(h.events.length, 1, 'one refresh notifies the open page');
  assert.equal(h.events[0].runId, h.runId);
  const savedAt = saved.updatedAt;
  h.clock.value += 60_000;
  await h.runner.tick();
  assert.equal((await h.store.readRunFile(h.runId)).updatedAt, savedAt);
  assert.equal(h.events.length, 1, 'unchanged results are not repeatedly rewritten');
});

for (const [status, causeCode] of [['paused', 'USER_PAUSED'], ['needs_attention', 'AMAZON_ACCESS_CHALLENGE']]) {
  test(`local profit repair preserves ${causeCode}, manual inputs, invalid values and procurement ownership`, async t => {
    const manual = product(1, { manualSalePrice: true, salePrice: 30, manualPurchaseCost: true,
      purchaseCost: 6, purchaseUnitCostCny: 6, suppliers: [{ unitPriceCny: 18, source: 'manual' }] });
    const invalid = product(2, { manualSalePrice: true, salePrice: 0 });
    const handedOff = product(3, { analysisHandoff: { owner: 'procurement', revision: 2 } });
    const invalidWeight = product(4, { productWeight: 0 });
    const h = await fixture(t, [manual, invalid, handedOff, invalidWeight], { status, causeCode });
    const before = await h.runner.status();
    await Promise.all([h.runner.tick(), h.runner.tick()]);
    const saved = await h.store.readRunFile(h.runId);
    const [good, badPrice, frozen, badWeight] = saved.snapshot.products;
    for (const key of Object.keys(manual).filter(key => !['margin', 'profitCalculation', 'profitPendingReasons'].includes(key))) {
      assert.deepEqual(good[key], manual[key], `saved ${key} is not replaced by a normalized input`);
    }
    assert.ok(Number.isFinite(good.margin));
    assert.equal(good.profitCalculation.salePrice, 30);
    assert.equal(good.profitCalculation.purchaseCostCny, 6);
    assert.equal(badPrice.salePrice, 0);
    assert.equal(badPrice.margin, null);
    assert.deepEqual(badPrice.profitPendingReasons, ['售价', 'FBA 配送费']);
    assert.deepEqual(frozen, handedOff);
    assert.equal(badWeight.productWeight, 0);
    assert.equal(badWeight.margin, null);
    assert.ok(badWeight.profitPendingReasons.includes('商品重量或包裹重量'));
    assert.deepEqual(await h.runner.status(), { ...before, revision: before.revision + 1 });
    assert.equal(h.events.length, 1);
    h.clock.value += 60_000;
    await h.runner.tick();
    assert.equal(h.events.length, 1, 'invalid inputs keep reasons without repeated writes');
  });
}

test('profit repair sees the latest saved edit and does not reopen an archived task', async t => {
  const h = await fixture(t, [product(1)]);
  // This is the public edit path and shares the serialized queue with inspection.
  const editing = h.store.updateSupplierSnapshot(h.runId, draft => {
    Object.assign(draft.products[0], { manualSalePrice: true, salePrice: 42, manualPurchaseCost: true,
      purchaseCost: 9, purchaseUnitCostCny: 9 });
  });
  await Promise.all([editing, h.runner.tick()]);
  const saved = await h.store.getRunSnapshot(h.runId);
  assert.equal(saved.products[0].profitCalculation.salePrice, 42);
  assert.equal(saved.products[0].profitCalculation.purchaseCostCny, 9);
  await h.runner.cancelForReplacement(h.runId);
  const archived = await h.store.getRunSnapshot(h.runId);
  h.clock.value += 60_000;
  await h.runner.tick();
  assert.deepEqual(await h.store.getRunSnapshot(h.runId), archived);
});

test('local profit completion does not wait for supplier or Amazon network capacity', async t => {
  const h = await fixture(t, [product(1)], { canRun: () => false });
  await h.runner.tick();
  const saved = await h.store.readRunFile(h.runId);
  assert.ok(Number.isFinite(saved.snapshot.products[0].margin));
  assert.equal((await h.runner.status()).workerActive, false);
});
