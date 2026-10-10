import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recomputeProductProfit } from '../lib/product-profit-state.mjs';
import { applySupplierProfitResult } from '../lib/supplier-profit-result.mjs';
import { SUPPLIER_COST_RULE_VERSION } from '../lib/1688-supplier-policy.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'scout-purchase-precedence-'));
const previousDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(root, 'module-default');
let PersistenceStore;
try {
  ({ PersistenceStore } = await import('../lib/persistence-store.mjs'));
} finally {
  if (previousDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDirectory;
}
after(async () => {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('scout-purchase-precedence-'));
  await rm(resolved, { recursive: true, force: true });
});

const product = (extra = {}) => ({
  id: 'AU:B000000001', asin: 'B000000001', marketplace: 'AU', analysisSourceMode: 'amazon_only',
  name: 'Synthetic three-piece set', englishName: 'Synthetic three-piece set', detailStatus: 'success',
  currentPrice: 25, productWeight: 0.2, billingWeight: 0.2,
  pieceCount: 3, pieceCountSource: 'manual', supplierAverageCny: 3.14159,
  purchaseUnitCostCny: 99, purchaseCost: 297, manualPurchaseCost: false,
  suppliers: [{ offerId: 'original-quote', unitPriceCny: 3.14159 }],
  ...extra,
});
const snapshot = (id, item) => ({ runState: { id, marketplace: 'AU', errors: [] }, products: [item] });
const quoteResult = (extra = {}) => ({
  ruleVersion: SUPPLIER_COST_RULE_VERSION, status: 'complete', averageCostCny: 4.125,
  quotes: [{ offerId: 'new-quote', unitPriceCny: 4.125 }],
  ...extra,
});

test('automatic purchase price uses the available 1688 mean at full unit precision and recomputes set totals', () => {
  const input = product();
  const original = structuredClone(input);
  const result = recomputeProductProfit(input);
  assert.equal(result.purchaseUnitCostCny, 3.14159);
  assert.equal(result.purchaseCost, 9.42);
  assert.equal(result.profitCalculation.purchaseCostCny, 9.42);
  assert.equal(result.manualPurchaseCost, false);
  assert.deepEqual(result.suppliers, original.suppliers);
  const repeated = recomputeProductProfit(result);
  assert.equal(repeated.purchaseUnitCostCny, 3.14159);
  assert.equal(repeated.manualPurchaseCost, false);
  const quoted = applySupplierProfitResult(repeated, quoteResult(), snapshot('new-average', repeated));
  assert.equal(quoted.supplierAverageCny, 4.125);
  assert.equal(quoted.purchaseUnitCostCny, 4.125);
  assert.equal(quoted.purchaseCost, 12.38);
  assert.equal(quoted.manualPurchaseCost, false);
  assert.deepEqual(input, original);
});

test('manual unit prices including zero persist after restart, reprice and background quotes under every saved marker', async () => {
  const markers = [{ manualPurchaseCost: true }, { costSource: 'manual' }, { supplierSource: 'manual_legacy' }];
  for (const [index, marker] of markers.entries()) {
    for (const unitPrice of [0, 2.34567]) {
      const id = `manual-${index}-${unitPrice === 0 ? 'zero' : 'precise'}`;
      const directory = path.join(root, id);
      const store = new PersistenceStore({ directory });
      await store.ready();
      const input = product({ ...marker, purchaseUnitCostCny: unitPrice, purchaseCost: unitPrice * 3 });
      await store.saveSnapshot(snapshot(id, input));
      const restarted = new PersistenceStore({ directory });
      await restarted.ready();
      const restored = (await restarted.getRunSnapshot(id)).products[0];
      assert.equal(restored.purchaseUnitCostCny, unitPrice);
      assert.equal(restored.purchaseCost, unitPrice === 0 ? 0 : 7.04);
      assert.equal(restored.supplierAverageCny, 3.14159);
      assert.deepEqual(restored.suppliers, input.suppliers);
      const repriced = recomputeProductProfit({ ...restored, currentPrice: 30 });
      assert.equal(repriced.purchaseUnitCostCny, unitPrice);
      const beforeQuote = structuredClone(repriced);
      assert.deepEqual(applySupplierProfitResult(repriced, quoteResult(), snapshot(id, repriced)), beforeQuote);
    }
  }
});

test('no quotes and invalid finalized averages keep procurement cost unresolved rather than manufacturing a mean', () => {
  const input = product({ supplierAverageCny: null, purchaseUnitCostCny: null, purchaseCost: null, suppliers: [] });
  const pending = recomputeProductProfit(input);
  assert.equal(pending.supplierAverageCny, null);
  assert.equal(pending.purchaseUnitCostCny, null);
  assert.equal(pending.purchaseCost, null);
  for (const averageCostCny of [null, 0, -1, Number.NaN]) {
    const result = applySupplierProfitResult(pending, quoteResult({ averageCostCny, quotes: [] }), snapshot('invalid-average', pending));
    assert.equal(result.supplierAverageCny, null);
    assert.equal(result.purchaseUnitCostCny, null);
    assert.equal(result.purchaseCost, null);
  }
});

test('procurement-owned products retain frozen purchase prices and quotes even when an automatic average differs', () => {
  const input = product({ analysisHandoff: { owner: 'procurement', revision: 'saved' }, purchaseUnitCostCny: 2.34567,
    purchaseCost: 7.04, margin: 42, profitCalculation: { purchaseCostCny: 7.04, profit: 10 } });
  const original = structuredClone(input);
  assert.deepEqual(recomputeProductProfit(input), original);
  assert.deepEqual(applySupplierProfitResult(input, quoteResult(), snapshot('frozen', input)), original);
  assert.deepEqual(input, original);
});
