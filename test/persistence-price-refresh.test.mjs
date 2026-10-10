import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recomputeProductProfit } from "../lib/product-profit-state.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scout-price-persistence-"));
const previousDataDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, "module-default");
let PersistenceStore;
try {
  ({ PersistenceStore } = await import("../lib/persistence-store.mjs"));
} finally {
  if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDataDirectory;
}

after(async () => {
  const resolved = path.resolve(temporaryRoot);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("scout-price-persistence-"));
  await rm(resolved, { recursive: true, force: true });
});

async function createStore(name) {
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, name) });
  await store.ready();
  return store;
}

function assertPersistedProduct(actual, submitted, context) {
  // Sale price is derived again from the current Amazon offer unless manually
  // overridden. Source evidence, manual costs and analysis history stay intact.
  for (const [field, value] of Object.entries(submitted)) {
    if (field !== "salePrice") assert.deepEqual(actual[field], value, `Preserve submitted ${field}`);
  }
  assert.deepEqual(actual, recomputeProductProfit(submitted, context));
  if (submitted.currentPrice === null) {
    assert.equal(actual.salePrice, null);
    assert.equal(actual.profitCalculation, null);
    assert.ok(actual.profitPendingReasons.includes("售价"));
  } else {
    assert.equal(actual.salePrice, Math.round(submitted.currentPrice * 100) / 100);
    // Refreshing price does not supply a missing weight or a local CA minimum-fee table.
    assert.ok(actual.profitPendingReasons.includes('商品重量'));
    assert.ok(actual.profitPendingReasons.includes('FBA 配送费'));
    assert.equal(actual.profitInputs.actualWeightKg, null);
    assert.equal(actual.billingWeight, null);
    assert.equal(actual.fbaFee, null);
    assert.equal(actual.fbaEstimate, null);
    assert.equal(actual.margin, null);
    assert.equal(actual.profitCalculation, null);
  }
}

const savedBatch = (index) => ({
  phase: "analyze",
  marketplace: "CA",
  collectedAt: "2026-09-23T12:00:00.000Z",
  status: "completed",
  productCount: 1,
  response: { items: [{ asin: "B000000001", currentPrice: index + 1 }], auditSequence: index },
});

test("a run with 100 existing batches can refresh while preserving every historical audit", async () => {
  const store = await createStore("refresh-batches");
  const runId = "price-refresh-history";
  await store.appendSearchBatch(runId, savedBatch(0));
  const document = await store.readRunFile(runId);
  const history = Array.from({ length: 100 }, (_, index) => savedBatch(index));
  document.searchBatches = history;
  await store.writeRunFile(runId, document);

  const refreshedBatch = savedBatch(100);
  refreshedBatch.response.items[0].currentPrice = 9.99;
  await store.appendSearchBatch(runId, refreshedBatch);

  const persisted = await store.readRunFile(runId);
  assert.equal(persisted.searchBatches.length, 101);
  assert.deepEqual(persisted.searchBatches.slice(0, 100), history);
  assert.deepEqual(persisted.searchBatches[100], refreshedBatch);
});

test("the 1000-batch bound rejects excess audits without changing existing history", async () => {
  const store = await createStore("bounded-history");
  const runId = "price-refresh-bound";
  await store.appendSearchBatch(runId, savedBatch(0));
  const document = await store.readRunFile(runId);
  document.searchBatches = Array.from({ length: 1_000 }, (_, index) => savedBatch(index));
  await store.writeRunFile(runId, document);

  await assert.rejects(store.appendSearchBatch(runId, savedBatch(1_000)), {
    code: "TOO_MANY_SEARCH_BATCHES",
  });
  assert.deepEqual((await store.readRunFile(runId)).searchBatches, document.searchBatches);
});

for (const draftVersion of [null, 2]) {
  test(`saving a cleared price preserves its audit and manual inputs (draft ${draftVersion ?? "legacy"})`, async () => {
    const store = await createStore(`cleared-price-${draftVersion ?? "legacy"}`);
    const product = {
      id: "CA:B000000001",
      asin: "B000000001",
      currentPrice: 279,
      salePrice: 251.1,
      detailParserVersion: 4,
      manualPurchaseCost: true,
      purchaseCost: 5,
      suppliers: [{ unitPriceCny: 5, imageSimilarityScore: 0.92 }],
      ...(draftVersion ? {
        analysisDraft: { version: draftVersion },
        analysisHistory: [{ version: 1, product: { currentPrice: 279, analysisHandoff: { revision: "archived-1" } } }],
      } : {}),
    };
    const snapshot = {
      runState: { id: `price-null-${draftVersion ?? "legacy"}`, marketplace: "CA", mode: "live" },
      products: [product],
    };
    await store.saveSnapshot(snapshot);
    const refreshed = structuredClone(snapshot);
    const updated = refreshed.products[0];
    updated.currentPrice = null;
    updated.salePrice = null;
    updated.detailParserVersion = 5;
    updated.currentPriceStatus = "unavailable";
    updated.priceEvidence = null;
    updated.priceRevalidation = {
      status: "completed",
      previousCurrentPrice: 279,
      previousParserVersion: 4,
      requiredParserVersion: 5,
      verifiedParserVersion: 5,
    };
    await store.saveSnapshot(refreshed);

    const persisted = await store.getRunSnapshot(snapshot.runState.id);
    assert.equal(persisted.products[0].currentPrice, null);
    assert.equal(persisted.products[0].salePrice, null);
    assertPersistedProduct(persisted.products[0], updated, refreshed);
    if (draftVersion) assert.equal(persisted.products[0].analysisHistory[0].product.currentPrice, 279);

    updated.currentPrice = 9.99;
    updated.currentPriceStatus = "verified";
    updated.priceEvidence = { source: "buybox", rawText: "$9.99", currency: "CAD" };
    await store.saveSnapshot(refreshed);
    assertPersistedProduct((await store.getRunSnapshot(snapshot.runState.id)).products[0], updated, refreshed);
  });
}

function automaticPriceSnapshot(runId, extra = {}) {
  return {
    runState: { id: runId, marketplace: "CA", mode: "live", analysisSourceMode: "amazon_only" },
    products: [{
      id: "CA:B000000001", currentPrice: 279, detailParserVersion: 4,
      // Only the price was observed; weight and automatic FBA have no source yet.
      fieldSources: { currentPrice: "amazon_product_page" }, ...extra,
    }],
  };
}

for (const savedState of ["pending", "verified"]) {
  test(`an old page cannot overwrite a ${savedState} automatic price`, async () => {
    const store = await createStore(`stale-${savedState}`);
    const runId = `stale-${savedState}`;
    const saved = automaticPriceSnapshot(runId, {
      currentPrice: savedState === "pending" ? null : 9.99,
      detailParserVersion: savedState === "pending" ? 4 : 5,
      priceRevalidation: { requiredParserVersion: 5, status: savedState },
    });
    await store.saveSnapshot(saved);
    const before = await store.readRunFile(runId);
    await assert.rejects(store.saveSnapshot(automaticPriceSnapshot(runId)), {
      code: "STALE_PRICE_SNAPSHOT", status: 409,
    });
    assert.deepEqual(await store.readRunFile(runId), before);

    if (savedState === "verified") {
      const olderMigratedPage = automaticPriceSnapshot(runId, {
        currentPrice: null, priceRevalidation: { requiredParserVersion: 5, status: "pending" },
      });
      await assert.rejects(store.saveSnapshot(olderMigratedPage), {
        code: "STALE_PRICE_SNAPSHOT", status: 409,
      });
      assert.deepEqual(await store.readRunFile(runId), before);
    }
  });
}

test("normal migration checkpoints and current-parser prices remain saveable", async () => {
  const store = await createStore("migration-checkpoints");
  const runId = "migration-checkpoints";
  await store.saveSnapshot(automaticPriceSnapshot(runId));
  const pending = automaticPriceSnapshot(runId, {
    currentPrice: null, priceRevalidation: { requiredParserVersion: 5, status: "pending" },
  });
  await store.saveSnapshot(pending);
  await store.saveSnapshot(pending);
  assert.equal((await store.getRunSnapshot(runId)).products[0].currentPrice, null);
  const verified = automaticPriceSnapshot(runId, { currentPrice: 9.99, detailParserVersion: 5 });
  await store.saveSnapshot(verified);
  await store.saveSnapshot(verified);
  assert.equal((await store.getRunSnapshot(runId)).products[0].currentPrice, 9.99);
});

test("explicit manual current prices and new analysis versions can still be saved", async () => {
  const store = await createStore("manual-and-new-version");
  for (const [name, override] of [
    ["manual", { currentPrice: 12.99, manualAmazonFields: { currentPrice: true } }],
    ["new-version", { currentPrice: 19.99, analysisDraft: { version: 2 } }],
  ]) {
    await store.saveSnapshot(automaticPriceSnapshot(name, { currentPrice: 9.99, detailParserVersion: 5 }));
    const updated = automaticPriceSnapshot(name, override);
    await store.saveSnapshot(updated);
    assertPersistedProduct((await store.getRunSnapshot(name)).products[0], updated.products[0], updated);
  }
});
