import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mergeAmazonCollectionProduct } from "../lib/amazon-collection-merge.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scout-collection-persistence-"));
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
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("scout-collection-persistence-"));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const asin = "B000000001";
const otherAsin = "B000000002";
const product = (extra = {}) => ({
  id: `CA:${asin}`, asin, sourceAsin: asin, marketplace: "CA", currency: "CAD",
  analysisSourceMode: "amazon_only", name: "Saved title", englishName: "Saved title",
  currentPrice: 279, salePrice: 251.1, detailStatus: "success", detailParserVersion: 5,
  productWeight: 0.1, fbaWeight: 0.2, billingWeight: 0.1,
  fieldSources: { currentPrice: "amazon_product_page" },
  purchaseCost: 457, purchaseUnitCostCny: 457, manualPurchaseCost: true,
  suppliers: [{ unitPriceCny: 457, spec: "Saved quote" }],
  reviewStatus: "approved", complete: true, margin: 70, profitCalculation: { profit: 200 },
  ...extra,
});
const result = (extra = {}) => ({
  asin, sourceAsin: asin, marketplace: "CA", title: "Collected title",
  currentPrice: 9.99, priceEvidence: { asin, currency: "CAD", source: "visible_main_price", rawText: "$9.99" },
  productWeightKg: 0.3, fbaPackageWeightKg: 0.4, rating: 4.2, reviewCount: 18, sales30: 50,
  imageUrl: "https://m.media-amazon.com/images/I/synthetic.jpg",
  detailStatus: "success", detailParserVersion: 5, detailRetryable: false,
  detailError: null, detailErrorCode: null, collectedAt: "2026-09-24T03:00:00.000Z",
  fieldSources: { currentPrice: "amazon_product_page", productWeightKg: "amazon_product_page" },
  fieldAudit: { currentPrice: { status: "verified" } }, collectionQuality: { complete: true },
  ...extra,
});
async function storeWithSnapshot(name, products = [product()]) {
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, name) });
  await store.ready();
  await store.saveSnapshot({
    runState: { id: name, marketplace: "CA", currency: "CAD", amazonDomain: "www.amazon.ca", mode: "live", analysisSourceMode: "amazon_only" },
    products,
  });
  return store;
}

test("successful automatic fields project without changing manual costs or supplier quotes", () => {
  const saved = product();
  const original = structuredClone(saved);
  const merged = mergeAmazonCollectionProduct(saved, result());
  assert.deepEqual(saved, original);
  assert.equal(merged.currentPrice, 9.99);
  assert.equal(merged.salePrice, 9.99);
  assert.equal(merged.name, "Collected title");
  assert.equal(merged.englishName, "Collected title");
  assert.equal(merged.productWeight, 0.3);
  assert.equal(merged.fbaWeight, 0.4);
  assert.equal(merged.reviews, 18);
  assert.equal(merged.margin, null);
  assert.equal(merged.profitCalculation, null);
  assert.equal(merged.complete, false);
  assert.equal(merged.reviewStatus, "pending");
  assert.equal(merged.purchaseCost, 457);
  assert.equal(merged.manualPurchaseCost, true);
  assert.deepEqual(merged.suppliers, original.suppliers);
  assert.deepEqual(merged.priceEvidence, result().priceEvidence);
  assert.deepEqual(merged.fieldAudit, result().fieldAudit);
});

test("missing offers clear automatic prices while failed visits preserve previous successful fields", () => {
  const saved = product();
  const missing = mergeAmazonCollectionProduct(saved, result({ currentPrice: null }));
  assert.equal(missing.currentPrice, null);
  assert.equal(missing.salePrice, null);
  assert.equal(missing.margin, null);
  assert.equal(missing.currentPriceStatus, "unavailable");
  assert.equal(missing.lastKnownAmazonPrice.currentPrice, 279);
  const failed = mergeAmazonCollectionProduct(saved, result({ detailStatus: "failed", detailErrorCode: "AMAZON_HTTP_429", currentPrice: null, title: null, productWeightKg: null }));
  assert.equal(failed.currentPrice, 279);
  assert.equal(failed.name, "Saved title");
  assert.equal(failed.productWeight, 0.1);
  assert.equal(failed.detailStatus, "success");
  assert.equal(failed.collectionLastAttempt.code, "AMAZON_HTTP_429");
  assert.equal(failed.detailParserVersion, 5);
  const inconsistent = mergeAmazonCollectionProduct(product({ currentPrice: null, salePrice: null }), result({ currentPrice: null }));
  assert.equal(inconsistent.margin, null);
  assert.equal(inconsistent.complete, false);
});

test("a successful Item Weight-only parse retires a known automatic package fallback without changing manual costs", () => {
  const saved = product({ productWeightKg: 0.1, weightKg: 0.1, actualWeightKg: 0.1,
    productWeightEvidence: { label: 'Package Weight', kind: 'package', value: 0.1 },
    fieldSources: { currentPrice: 'amazon_product_page', productWeightKg: 'amazon_package_weight_fallback' },
    weightSource: 'Amazon 包装重量回退', fbaFee: 5,
    profitInputs: { actualWeightKg: 0.1, weightSource: 'Amazon 包装重量回退', commissionRate: 0.11 } });
  const noItemWeight = result({ detailParserVersion: 11, productWeightKg: null, productWeightEvidence: null,
    productInformation: { weightSelection: { policy: 'item_weight_only', version: 1, selected: null, alternatives: [] } } });
  const before = structuredClone(saved);
  const merged = mergeAmazonCollectionProduct(saved, noItemWeight);
  for (const field of ['productWeight', 'productWeightKg', 'weightKg', 'billingWeight', 'actualWeightKg']) assert.equal(merged[field], null, field);
  assert.equal(merged.profitInputs.actualWeightKg, null);
  assert.equal(merged.profitInputs.commissionRate, 0.11);
  assert.equal(merged.productWeightEvidence, undefined);
  assert.equal(merged.fieldSources.productWeightKg, undefined);
  assert.equal(merged.fbaWeight, 0.4, 'Package data can remain as separately named observations.');
  assert.equal(merged.fbaFee, null);
  assert.equal(merged.profitCalculation, null);
  assert.equal(merged.purchaseCost, saved.purchaseCost);
  assert.deepEqual(merged.suppliers, saved.suppliers);
  assert.deepEqual(saved, before);
});

test("weight cleanup requires explicit fresh parser semantics and preserves all manual overrides and failed refreshes", () => {
  const saved = product({ productWeightEvidence: { label: 'Load Capacity', value: 0.1 },
    fieldSources: { productWeightKg: 'amazon_product_page' } });
  const noItemWeight = result({ detailParserVersion: 11, productWeightKg: null, productWeightEvidence: null });
  for (const change of [
    { manualProductWeight: true }, { manualWeight: true }, { manualAmazonOverride: true }, { manualAmazonFields: { productWeightKg: true, currentPrice: true } },
    { weightSource: '产品人工覆盖' }, { profitInputs: { actualWeightKg: 0.1, weightSource: 'manual' } },
  ]) {
    const input = { ...saved, ...change };
    const merged = mergeAmazonCollectionProduct(input, noItemWeight);
    assert.equal(merged.productWeight, input.productWeight);
    assert.equal(merged.billingWeight, input.billingWeight);
    assert.deepEqual(merged.productWeightEvidence, input.productWeightEvidence);
    assert.equal(merged.purchaseCost, input.purchaseCost);
    assert.deepEqual(merged.suppliers, input.suppliers);
    if (input.manualAmazonFields?.currentPrice) assert.equal(merged.currentPrice, input.currentPrice);
  }
  for (const incoming of [
    { ...noItemWeight, detailParserVersion: 10 },
    { ...noItemWeight, detailStatus: 'failed', detailErrorCode: 'AMAZON_FETCH_TIMEOUT' },
    { ...noItemWeight, lastCollectionError: { code: 'AMAZON_FETCH_TIMEOUT' } },
  ]) {
    const merged = mergeAmazonCollectionProduct(saved, incoming);
    assert.equal(merged.productWeight, saved.productWeight);
    assert.equal(merged.billingWeight, saved.billingWeight);
  }
  const legacy = product({ fieldSources: { productWeightKg: 'legacy_product_feed' } });
  assert.equal(mergeAmazonCollectionProduct(legacy, noItemWeight).productWeight, legacy.productWeight,
    'A legacy value with no contrary label/source evidence is not bulk-cleared.');
});

test("a replacement Item Weight with the same numeric value repairs old package provenance and derived fees", () => {
  const saved = product({ productWeight: 0.3, productWeightKg: 0.2, weightKg: 0.2, billingWeight: 0.3, fbaFee: 8,
    weightSource: 'Amazon 包装重量回退', fieldSources: { productWeightKg: 'amazon_package_weight_fallback' },
    productWeightEvidence: { label: 'Shipping Weight', kind: 'package', value: 0.3 } });
  const evidence = { label: 'item weight', kind: 'product', value: 0.3, unit: 'kg', source: 'amazon_product_page' };
  const merged = mergeAmazonCollectionProduct(saved, result({ detailParserVersion: 11, productWeightEvidence: evidence }));
  assert.equal(merged.productWeight, 0.3);
  assert.equal(merged.productWeightKg, 0.3);
  assert.equal(merged.weightKg, 0.3);
  assert.equal(merged.billingWeight, 0.3);
  assert.equal(merged.weightSource, 'Amazon 商品重量（Item Weight）');
  assert.equal(merged.fieldSources.productWeightKg, 'amazon_product_page');
  assert.deepEqual(merged.productWeightEvidence, evidence);
  assert.equal(merged.fbaFee, null);
  const forged = mergeAmazonCollectionProduct(product(), result({ detailParserVersion: 11,
    productWeightEvidence: { ...evidence, label: 'Product Dimensions' } }));
  assert.equal(forged.productWeight, 0.1, 'A non-Item Weight payload must not overwrite the previous product observation.');
});

test("a price-only manual field mask does not freeze an old automatic package weight", () => {
  const saved = product({ manualAmazonOverride: true, manualAmazonFields: { currentPrice: true },
    fieldSources: { currentPrice: 'manual', productWeightKg: 'amazon_package_weight_fallback' },
    weightSource: 'Amazon 包装重量回退', productWeightEvidence: { label: 'Package Weight', kind: 'package', value: 0.1 } });
  const missing = mergeAmazonCollectionProduct(saved, result({ detailParserVersion: 11,
    productWeightKg: null, productWeightEvidence: null }));
  assert.equal(missing.productWeight, null);
  assert.equal(missing.billingWeight, null);
  assert.equal(missing.currentPrice, saved.currentPrice);
  assert.equal(missing.fieldSources.currentPrice, 'manual');
  assert.equal(missing.purchaseCost, saved.purchaseCost);
  assert.deepEqual(missing.suppliers, saved.suppliers);
  const replaced = mergeAmazonCollectionProduct(saved, result({ detailParserVersion: 11,
    productWeightKg: 0.17, productWeightEvidence: { label: 'Item Weight', kind: 'product', value: 0.17, unit: 'kg' } }));
  assert.equal(replaced.productWeight, 0.17);
  assert.equal(replaced.billingWeight, 0.17);
  assert.equal(replaced.currentPrice, saved.currentPrice);
  assert.deepEqual(replaced.manualAmazonFields, saved.manualAmazonFields);
});

test("collection recovery progress projects without changing manual values and clears stale retry messages", () => {
  const saved = product({ manualAmazonFields: { currentPrice: true }, manualProductWeight: true });
  const recovery = { status: "scheduled", attempts: 1, maxAttempts: 2,
    reasonCode: "AMAZON_FETCH_TIMEOUT", message: "商品访问超时", nextRetryAt: "2026-10-14T07:00:00.000Z" };
  const merged = mergeAmazonCollectionProduct(saved, result({ detailStatus: "failed", collectionRecovery: recovery }));
  assert.deepEqual(merged.collectionRecovery, recovery);
  assert.equal(merged.currentPrice, saved.currentPrice);
  assert.equal(merged.productWeight, saved.productWeight);
  assert.deepEqual(merged.suppliers, saved.suppliers);
  merged.collectionRecovery.attempts = 99;
  assert.equal(recovery.attempts, 1);
  const completed = mergeAmazonCollectionProduct(merged, result());
  assert.equal(completed.collectionRecovery, undefined);
});

test("manual Amazon fields, manual weights and sale prices, and handed-off products are protected", () => {
  const saved = product({
    manualAmazonFields: { title: true, currentPrice: true, reviews: true },
    manualSalePrice: true, salePrice: 19, manualFbaFee: true, fbaFee: 6,
    weightSource: "产品人工覆盖", profitInputs: { actualWeightKg: 0.1, weightSource: "产品人工覆盖", commissionRate: 0.11 },
  });
  const merged = mergeAmazonCollectionProduct(saved, result());
  assert.equal(merged.name, saved.name);
  assert.equal(merged.currentPrice, saved.currentPrice);
  assert.equal(merged.reviews, saved.reviews);
  assert.equal(merged.productWeight, saved.productWeight);
  assert.equal(merged.fbaWeight, saved.fbaWeight);
  assert.equal(merged.billingWeight, saved.billingWeight);
  assert.equal(merged.salePrice, 19);
  assert.equal(merged.fbaFee, 6);
  assert.deepEqual(merged.profitInputs, saved.profitInputs);
  const archived = product({ analysisHandoff: { owner: "procurement", revision: "saved" } });
  assert.deepEqual(mergeAmazonCollectionProduct(archived, result()), archived);
  assert.deepEqual(mergeAmazonCollectionProduct(saved, result({ asin: otherAsin, sourceAsin: otherAsin })), saved);
  const manualBilling = mergeAmazonCollectionProduct(product({ weightSource: "产品人工覆盖", profitInputs: { weightSource: "Amazon 商品重量（Item Weight）" } }), result());
  assert.equal(manualBilling.billingWeight, 0.1);
  assert.equal(manualBilling.productWeight, 0.1);
  const wrongPriceEvidence = mergeAmazonCollectionProduct(product(), result({ priceEvidence: { asin: otherAsin, currency: "CAD" } }));
  assert.equal(wrongPriceEvidence.currentPrice, 279);
});

test("collection results and active pointer survive restart; reads are pure and returned state is isolated", async () => {
  const runId = "durable-collection";
  const store = await storeWithSnapshot(runId);
  await store.updateAmazonCollection(runId, () => ({ job: { revision: 1, status: "running", message: "Working" }, items: { [asin]: result() } }), { activate: true });
  const savedBytes = await readFile(store.runPath(runId), "utf8");
  const snapshot = await store.getRunSnapshot(runId);
  assert.equal(snapshot.products[0].currentPrice, 9.99);
  assert.equal(snapshot.runState.amazonCollectionRevision, 1);
  assert.equal(snapshot.runState.amazonCollectionJob.status, "running");
  assert.equal(snapshot.amazonCollection.items.length, 1);
  assert.equal(snapshot.runState.mode, "live");
  assert.equal(snapshot.runState.completedAt, null);
  snapshot.amazonCollection.items[0].currentPrice = 500;
  await store.getOverview();
  assert.equal(await readFile(store.runPath(runId), "utf8"), savedBytes);
  assert.equal((await store.getAmazonCollection(runId)).items[asin].currentPrice, 9.99);
  const restarted = new PersistenceStore({ directory: store.directory });
  await restarted.ready();
  assert.equal((await restarted.getActiveAmazonCollection()).runId, runId);
  assert.equal((await restarted.getActiveAmazonCollection()).job.revision, 1);
  assert.equal((await restarted.getRunSnapshot(runId)).products[0].purchaseCost, 457);
});

test("historical cart-gate loss is repaired by projection and survives normal save/restart without changing raw results or budgets", async () => {
  const runId = 'historical-cart-price';
  const stamp = '2026-09-24T02:00:00.000Z';
  const previous = { currentPrice: 14.99, collectedAt: stamp,
    priceEvidence: { asin, currency: 'CAD', source: 'visible_main_price', selector: '#corePriceDisplay_desktop_feature_div', rawText: '$14.99' } };
  const store = await storeWithSnapshot(runId, [product({ currentPrice: null, salePrice: null, priceEvidence: null,
    lastKnownAmazonPrice: previous, collectedAt: '2026-09-24T03:00:00.000Z' })]);
  const raw = result({ currentPrice: null, priceEvidence: null,
    pageContextEvidence: { priceUnavailableReason: 'price_requires_cart' },
    collectionRecovery: { attempts: 2, maxAttempts: 2, status: 'exhausted' } });
  await store.updateAmazonCollection(runId, () => ({ job: { revision: 5, status: 'completed' }, items: { [asin]: raw } }));
  const restored = await store.getRunSnapshot(runId);
  assert.equal(restored.products[0].currentPrice, 14.99);
  assert.equal(restored.products[0].priceVerifiedAt, stamp);
  assert.equal(restored.products[0].currentPriceStatus, 'pending_revalidation');
  await store.saveSnapshot(restored);
  const restarted = new PersistenceStore({ directory: store.directory });
  await restarted.ready();
  const final = (await restarted.getRunSnapshot(runId)).products[0];
  assert.equal(final.currentPrice, 14.99);
  assert.equal(final.priceVerifiedAt, stamp);
  assert.equal(final.purchaseCost, 457);
  assert.equal(final.suppliers[0].unitPriceCny, 457);
  assert.deepEqual((await restarted.getAmazonCollection(runId)).items[asin], raw);
});

test("same-parser stale pages cannot overwrite background results even when jobs are completed or paused", async () => {
  for (const status of ["running", "completed", "paused"]) {
    const runId = `revision-${status}`;
    const store = await storeWithSnapshot(runId);
    const stale = await store.getRunSnapshot(runId);
    await store.updateAmazonCollection(runId, () => ({ job: { revision: 2, status, completedAt: status === "completed" ? "2026-09-24T04:00:00.000Z" : null }, items: { [asin]: result() } }));
    const bytes = await readFile(store.runPath(runId), "utf8");
    await assert.rejects(store.saveSnapshot(stale), { code: "STALE_COLLECTION_SNAPSHOT", status: 409 });
    assert.equal(await readFile(store.runPath(runId), "utf8"), bytes);
    const fresh = await store.getRunSnapshot(runId);
    assert.equal(fresh.runState.mode, status === "paused" ? "error" : "live");
    fresh.runState.amazonCollectionJob = { status: "forged", revision: 100 };
    fresh.products[0].manualAmazonFields = { currentPrice: true };
    fresh.products[0].currentPrice = 12.99;
    await store.saveSnapshot(fresh);
    assert.equal((await store.getAmazonCollection(runId)).job.status, status);
    assert.equal((await store.getRunSnapshot(runId)).runState.amazonCollectionJob.status, status);
    assert.equal((await store.getRunSnapshot(runId)).products[0].currentPrice, 12.99);
    assert.equal((await store.getAmazonCollection(runId)).items[asin].currentPrice, 9.99);
  }
});

test("concurrent collection patches serialize without losing ASIN results or changing another run", async () => {
  const runId = "concurrent-collection";
  const store = await storeWithSnapshot(runId);
  await store.saveSnapshot({ runState: { id: "other-run", marketplace: "AU", mode: "live" }, products: [] });
  const otherBytes = await readFile(store.runPath("other-run"), "utf8");
  await Promise.all([
    store.updateAmazonCollection(runId, (current) => ({ job: { revision: (current.job?.revision || 0) + 1, status: "queued" }, items: { [asin]: result() } }), { activate: true }),
    store.updateAmazonCollection(runId, (current) => ({ job: { revision: current.job.revision + 1, status: "running" }, items: { [otherAsin]: result({ asin: otherAsin, sourceAsin: otherAsin }) } })),
  ]);
  const collection = await store.getAmazonCollection(runId);
  assert.equal(collection.job.revision, 2);
  assert.deepEqual(Object.keys(collection.items).sort(), [asin, otherAsin]);
  assert.equal(await readFile(store.runPath("other-run"), "utf8"), otherBytes);
  assert.equal((await store.getOverview()).latestRunId, "other-run");
});

test("empty snapshots expose discovered and newly successful ASINs without recreating existing user records", async () => {
  const runId = "new-collection-products";
  const store = await storeWithSnapshot(runId, []);
  const pending = result({ title: null, currentPrice: null, detailStatus: "pending", detailRetryable: true });
  await store.updateAmazonCollection(runId, () => ({ job: { revision: 1, status: "running" }, items: { [asin]: pending } }));
  let snapshot = await store.getRunSnapshot(runId);
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0].id, `CA:${asin}`);
  assert.equal(snapshot.products[0].detailStatus, "pending");
  assert.equal(snapshot.products[0].name, `Amazon 商品 ${asin}`);
  assert.equal(snapshot.products[0].currency, "CAD");
  assert.equal(snapshot.products[0].amazonDomain, "www.amazon.ca");
  assert.deepEqual(snapshot.products[0].suppliers, []);
  assert.equal(snapshot.products[0].rematchCount, 0);
  snapshot.products[0].manualPurchaseCost = true;
  snapshot.products[0].purchaseCost = 457;
  snapshot.products[0].suppliers = [{ unitPriceCny: 457 }];
  await store.saveSnapshot(snapshot);
  await store.updateAmazonCollection(runId, () => ({ job: { revision: 2, status: "running" }, items: {
    [asin]: result(),
    [otherAsin]: result({ asin: otherAsin, sourceAsin: otherAsin, priceEvidence: { asin: otherAsin, currency: "CAD" } }),
  } }));
  snapshot = await store.getRunSnapshot(runId);
  assert.equal(snapshot.products.length, 2);
  assert.equal(snapshot.products.filter(p => p.asin === asin).length, 1);
  const existing = snapshot.products.find(p => p.asin === asin);
  const created = snapshot.products.find(p => p.asin === otherAsin);
  assert.equal(existing.purchaseCost, 457);
  assert.deepEqual(existing.suppliers, [{ unitPriceCny: 457 }]);
  assert.equal(created.currentPrice, 9.99);
  assert.equal(created.salePrice, 9.99);
  assert.equal(created.detailStatus, "success");
  assert.equal(created.name, "Collected title");
  assert.equal(created.reviewStatus, "pending");
  assert.deepEqual(created.suppliers, []);
});

test("retained successful raw results still expose the latest failed collection attempt", () => {
  const original = mergeAmazonCollectionProduct(product(), result());
  const retained = result({
    lastCollectionError: { code: "AMAZON_HTTP_429", checkedAt: "2026-09-24T04:00:00.000Z" },
    collectionQuality: { status: "failed", complete: false },
  });
  const merged = mergeAmazonCollectionProduct(original, retained);
  assert.equal(merged.currentPrice, 9.99);
  assert.equal(merged.detailStatus, "success");
  assert.equal(merged.collectionLastAttempt.status, "failed");
  assert.equal(merged.collectionLastAttempt.code, "AMAZON_HTTP_429");
  assert.equal(merged.collectionLastAttempt.checkedAt, retained.lastCollectionError.checkedAt);
  assert.equal(merged.currentPriceStatus, "refresh_failed");
  assert.equal(merged.collectionQuality.status, "failed");
  const recovered = mergeAmazonCollectionProduct(merged, result());
  assert.equal(recovered.collectionLastAttempt, undefined);
  assert.equal(recovered.currentPriceStatus, "verified");
});

test("supplierSearchAudit is compacted on save: rejected detail is reduced to counts, scalar fields survive", async () => {
  const runId = "audit-compaction";
  const bulkyRejected = Array.from({ length: 71 }, (_, i) => ({
    rank: i + 1,
    supplierId: `b2b-supplier-${i}`,
    offerId: `offer-${i}`,
    name: `供应商 ${i}`,
    url: `https://detail.1688.com/offer/${i}.html`,
    candidateImageUrl: `https://cbu01.alicdn.com/img/${i}.jpg`,
    unitPriceCny: 1 + i * 0.01,
    moq: 100,
    unit: "件",
    imageSimilarityScore: 0.3 + i * 0.001,
    imageSimilarityDecision: "below_threshold",
    imageSimilarityComponents: { perceptualHash: 0.9, differenceHash: 0.1 },
    excludedReason: i % 2 ? "image_similarity_below_threshold" : "outside_top_6_fallback",
  }));
  const bulkyAccepted = Array.from({ length: 6 }, (_, i) => ({
    rank: i + 1,
    supplierId: `accepted-${i}`,
    offerId: `aoffer-${i}`,
    unitPriceCny: 5 + i,
    imageSimilarityScore: 0.8,
    imageSimilarityComponents: { perceptualHash: 0.95, differenceHash: 0.05 },
  }));
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, runId) });
  await store.ready();
  await store.saveSnapshot({
    runState: { id: runId, marketplace: "CA", currency: "CAD", amazonDomain: "www.amazon.ca", mode: "live", analysisSourceMode: "amazon_only" },
    products: [product({
      supplierSearchAudit: {
        target: { moq: 100, unit: "件" },
        rawCandidateCount: 40,
        similarity: { threshold: 0.5, evaluatedCount: 40 },
        accepted: bulkyAccepted,
        rejected: bulkyRejected,
        groups: { primary: 6 },
        selectionMode: "fallback_estimate",
        costConfidence: "low",
        procurementTaskId: "task-1",
        procurementTaskStatus: "complete",
        procurementTaskReused: false,
        searchAttempts: 1,
        searchStrategyVersion: "v1",
        sharedContext: false,
        onlineAuthRequired: false,
      },
    })],
  });
  const saved = await store.getRunSnapshot(runId);
  const audit = saved.products[0].supplierSearchAudit;
  // 标量摘要字段原样保留。
  assert.deepEqual(audit.target, { moq: 100, unit: "件" });
  assert.equal(audit.rawCandidateCount, 40);
  assert.equal(audit.selectionMode, "fallback_estimate");
  assert.equal(audit.costConfidence, "low");
  assert.equal(audit.procurementTaskId, "task-1");
  assert.deepEqual(audit.similarity, { threshold: 0.5, evaluatedCount: 40 });
  assert.deepEqual(audit.groups, { primary: 6 });
  // rejected 被压缩为计数摘要，不再保留完整报价明细。
  assert.equal(audit.rejected.summary, true);
  assert.equal(audit.rejected.count, 71);
  assert.deepEqual(audit.rejected.reasons, {
    outside_top_6_fallback: 36,
    image_similarity_below_threshold: 35,
  });
  assert.ok(!Array.isArray(audit.rejected) || audit.rejected.summary === true);
  // accepted 被精简为三元组，不含 imageSimilarityComponents。
  assert.equal(audit.accepted.length, 6);
  assert.deepEqual(audit.accepted[0], { supplierId: "accepted-0", offerId: "aoffer-0", rank: 1, unitPriceCny: 5 });
  assert.equal("imageSimilarityComponents" in audit.accepted[0], false);
  // 落盘文件体积应远小于未裁剪前的 ~100KB 量级。
  const rawFile = await readFile(store.runPath(runId), "utf8");
  assert.ok(rawFile.length < 200_000, `run file ${rawFile.length} bytes should be well under 200KB`);
});

test("products without supplierSearchAudit pass through compaction unchanged", async () => {
  const runId = "audit-compaction-null";
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, runId) });
  await store.ready();
  await store.saveSnapshot({
    runState: { id: runId, marketplace: "CA", currency: "CAD", amazonDomain: "www.amazon.ca", mode: "live", analysisSourceMode: "amazon_only" },
    products: [product({ supplierSearchAudit: null })],
  });
  const saved = await store.getRunSnapshot(runId);
  assert.equal(saved.products[0].supplierSearchAudit, null);
});


test("replacement archives preserve manual values, quotes, collected results and checkpoints while releasing ownership", async () => {
  const runId = "archive-preserves-data";
  const store = await storeWithSnapshot(runId, [product({ manualSalePrice: true, salePrice: 19,
    manualAmazonFields: { currentPrice: true }, weightSource: "产品人工覆盖" })]);
  await store.updateAmazonCollection(runId, () => ({ job: { owner: "server", runId, revision: 2,
    status: "paused", enabled: false, causeCode: "USER_PAUSED", tasks: { [asin]: { status: "partial", attempts: 1 } },
    targetedRetry: { asins: [asin], returnState: { status: "paused", causeCode: "USER_PAUSED" } },
    supplierPause: { previousStatus: "cooldown", expiresAt: "2026-10-12T03:00:00.000Z" } },
    items: { [asin]: result() } }), { activate: true });
  await store.saveAmazonStoreCheckpoint(runId, { marketplace: "CA", sellerId: "A123456789", asins: [asin], status: "waiting" });
  await store.saveAsinDetailResult(runId, { marketplace: "CA", asin, data: { saved: true } });
  await store.updateSupplierSnapshot(runId, snapshot => {
    snapshot.runState.supplier1688Pipeline = { owner: "server", status: "paused", enabled: false, revision: 1,
      productIds: [snapshot.products[0].id], tasks: { [snapshot.products[0].id]: { taskId: "saved-quote-task" } } };
    return snapshot;
  });
  await store.setActiveSupplierRunId(runId);
  const before = JSON.parse(await readFile(store.runPath(runId), "utf8"));
  const beforeSources = (await store.getRunSnapshot(runId)).amazonDiscoveredSources;
  assert.equal((await store.getOverview()).runs[0].status, "paused");
  const archived = await store.archiveRun(runId);
  const saved = JSON.parse(await readFile(store.runPath(runId), "utf8"));
  assert.equal(archived.summary.status, "cancelled");
  assert.ok(archived.summary.archivedAt);
  assert.equal(archived.summary.archiveReason, "USER_REPLACED");
  assert.deepEqual(saved.snapshot.products, before.snapshot.products);
  assert.deepEqual(saved.amazonCollection.items, before.amazonCollection.items);
  assert.deepEqual(saved.amazonCollection.job.tasks, before.amazonCollection.job.tasks);
  assert.deepEqual(saved.amazonCollection.job.targetedRetry, before.amazonCollection.job.targetedRetry);
  assert.deepEqual(saved.amazonCollection.job.supplierPause, before.amazonCollection.job.supplierPause);
  assert.equal(saved.amazonCollection.job.archiveCheckpoint.status, "paused");
  assert.deepEqual(saved.amazonStoreCheckpoints, before.amazonStoreCheckpoints);
  assert.deepEqual(saved.asinDetails, before.asinDetails);
  assert.deepEqual(saved.snapshot.runState.supplier1688Pipeline.tasks, before.snapshot.runState.supplier1688Pipeline.tasks);
  assert.equal(saved.amazonCollection.job.status, "cancelled");
  assert.equal(saved.amazonCollection.job.enabled, false);
  assert.equal(saved.snapshot.runState.supplier1688Pipeline.status, "cancelled");
  assert.equal(await store.getActiveAmazonCollection(), null);
  assert.equal(await store.getActiveSupplierRunId(), null);
  assert.equal((await store.getOverview()).latestRun, null);
  const bytes = await readFile(store.runPath(runId), "utf8");
  const again = await store.archiveRun(runId);
  assert.equal(again.summary.archivedAt, archived.summary.archivedAt);
  assert.equal(await readFile(store.runPath(runId), "utf8"), bytes);
  assert.deepEqual((await store.getRunSnapshot(runId)).products, before.snapshot.products);
  assert.deepEqual((await store.getRunSnapshot(runId)).amazonDiscoveredSources, beforeSources);
  const restarted = new PersistenceStore({ directory: store.directory });
  await restarted.ready();
  assert.equal(await restarted.getActiveAmazonCollection(), null);
  assert.equal(await restarted.getActiveSupplierRunId(), null);
  assert.equal((await restarted.getOverview()).latestRun, null);
  assert.equal((await restarted.getOverview()).runs[0].status, "cancelled");
  assert.equal((await restarted.getOverview()).runs[0].archivedAt, archived.summary.archivedAt);
  assert.equal((await restarted.getOverview()).runs[0].archiveReason, "USER_REPLACED");
});

test("late writes and pointer activation cannot mutate or reopen an archived run", async () => {
  const runId = "archive-write-barrier";
  const store = await storeWithSnapshot(runId);
  const stale = await store.getRunSnapshot(runId);
  await store.archiveRun(runId);
  const bytes = await readFile(store.runPath(runId), "utf8");
  const index = await readFile(store.indexPath, "utf8");
  const writes = [
    () => store.saveSnapshot(stale),
    () => store.updateAmazonCollection(runId, () => { throw new Error("must not call archived updater"); }, { activate: true }),
    () => store.updateSupplierSnapshot(runId, () => { throw new Error("must not call archived updater"); }),
    () => store.setActiveSupplierRunId(runId),
    () => store.appendSearchBatch(runId, { phase: "discover", collectedAt: new Date().toISOString() }),
    () => store.appendSearchBatch(runId, { phase: "details", status: "completed" }),
    () => store.saveAsinDetailResult(runId, { marketplace: "CA", asin, data: { late: true } }),
    () => store.saveAmazonStoreCheckpoint(runId, { marketplace: "CA", sellerId: "A123456789", asins: [asin] }),
    () => store.saveCompetitorLookupBatch(runId, { marketplace: "CA", month: "202609", requestedAsins: [asin], items: [] }),
    () => store.recordToolCall({ runId, tool: "late_call" }),
  ];
  for (const write of writes) await assert.rejects(write(), { code: "RUN_ARCHIVED", status: 409 });
  assert.equal(await readFile(store.runPath(runId), "utf8"), bytes);
  assert.equal(await readFile(store.indexPath, "utf8"), index);
});

test("archiving a historical run never clears another run's active pointers or latest snapshot", async () => {
  const runId = "archive-historical-only";
  const store = await storeWithSnapshot(runId);
  const other = "new-active-run";
  await store.saveSnapshot({ runState: { id: other, marketplace: "CA", mode: "live", analysisSourceMode: "amazon_only" }, products: [] });
  await store.updateAmazonCollection(other, () => ({ job: { owner: "server", runId: other, revision: 1,
    status: "queued", enabled: true }, items: {} }), { activate: true });
  await store.setActiveSupplierRunId(other);
  const bytes = await readFile(store.runPath(other), "utf8");
  await store.archiveRun(runId);
  assert.equal((await store.getActiveAmazonCollection()).runId, other);
  assert.equal(await store.getActiveSupplierRunId(), other);
  assert.equal((await store.getOverview()).latestRunId, other);
  assert.equal(await readFile(store.runPath(other), "utf8"), bytes);
});

test("a durable archive tombstone blocks restart recovery even if index cleanup was interrupted", async () => {
  const runId = "archive-interrupted-index";
  const store = await storeWithSnapshot(runId);
  await store.updateAmazonCollection(runId, () => ({ job: { owner: "server", runId, revision: 1,
    status: "queued", enabled: true }, items: {} }), { activate: true });
  await store.setActiveSupplierRunId(runId);
  const persistIndex = store.persistIndex;
  store.persistIndex = async () => { throw new Error("Synthetic index write failure"); };
  await assert.rejects(store.archiveRun(runId), /Synthetic index write failure/);
  store.persistIndex = persistIndex;
  const restarted = new PersistenceStore({ directory: store.directory });
  await restarted.ready();
  assert.equal(await restarted.getActiveAmazonCollection(), null);
  assert.equal(await restarted.getActiveSupplierRunId(), null);
  assert.equal((await restarted.getOverview()).latestRun, null);
  await restarted.archiveRun(runId);
  assert.equal((await restarted.getOverview()).runs[0].status, "cancelled");
});


test("incremental results recompute and notify legacy ASIN casing without changing product identity or manual inputs", async () => {
  const variants = [
    { asin: asin.toLowerCase(), sourceAsin: asin.toLowerCase() },
    { asin: asin.toLowerCase(), sourceAsin: null },
    { asin, sourceAsin: ` ${asin.toLowerCase()} ` },
  ];
  for (const [index, fields] of variants.entries()) {
    const runId = `incremental-legacy-asin-${index}`;
    const saved = product({ id: `CA:legacy-${index}`, ...fields });
    const untouched = product({ id: `CA:${otherAsin}`, asin: otherAsin, sourceAsin: otherAsin });
    const store = await storeWithSnapshot(runId, [saved, untouched]);
    await store.updateAmazonCollection(runId, () => ({ job: { revision: 1, status: "running" }, items: {} }));
    const before = (await store.readRunFile(runId)).snapshot.products;
    assert.ok(before[0].profitCalculation);
    const events = [];
    store.onSnapshotUpdated(event => events.push(event));
    await store.updateAmazonCollection(runId, current => ({
      job: { ...current.job, revision: 2 }, items: { [asin]: result() },
    }), { changedAsins: [asin] });
    // Read the durable document: the public snapshot read also projects and
    // could otherwise conceal a skipped incremental profit computation.
    const after = (await store.readRunFile(runId)).snapshot.products;
    assert.equal(after.length, 2);
    assert.equal(after[0].id, saved.id);
    assert.equal(after[0].asin, saved.asin);
    assert.equal(after[0].sourceAsin, saved.sourceAsin);
    assert.equal(after[0].currentPrice, 9.99);
    assert.equal(after[0].profitCalculation.salePrice, 9.99);
    assert.equal(after[0].profitCalculation.airFreight.actualWeightKg, 0.3);
    assert.equal(after[0].manualPurchaseCost, true);
    assert.equal(after[0].purchaseCost, saved.purchaseCost);
    assert.deepEqual(after[0].suppliers, saved.suppliers);
    assert.deepEqual(after[1], before[1]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "amazon_product");
    assert.equal(events[0].baseRevision, 1);
    assert.equal(events[0].revision, 2);
    assert.deepEqual(events[0].products, [after[0]]);
  }
});
