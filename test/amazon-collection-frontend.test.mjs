import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as priceState from "../lib/amazon-price-state.mjs";
import * as profitModel from "../lib/profit-model.mjs";
import * as pieceCount from "../lib/title-piece-count.mjs";
import * as handoff from "../lib/analysis-handoff.mjs";
import * as coverage from "../lib/analysis-coverage.mjs";
import * as detailRetry from "../lib/amazon-detail-retry.mjs";
import { buildSupplierSearchResult } from "../lib/1688-supplier-policy.mjs";
import { applySupplierProfitResult } from "../lib/supplier-profit-result.mjs";

const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const runId = "synthetic-server-run";
const productId = "AU:B000000001";
const job = (status = "running", revision = 1) => ({ owner: "server", runId, status, revision, enabled: !["paused", "needs_attention", "completed"].includes(status), workerActive: status === "running", counts: { total: 1, processed: 0, pending: 1 } });
const canonicalProduct = () => ({
  id: productId, asin: "B000000001", sourceAsin: "B000000001", marketplace: "AU", sourceMarketplace: "AU", analysisSourceMode: "amazon_only",
  detailStatus: "success", detailParserVersion: 5, currentPrice: 9.99, currentPriceStatus: "verified", manualSalePrice: true, salePrice: 18,
  name: "Canonical manual title", englishName: "Canonical manual title", sellerId: "EXAMPLESELLER", rating: 4.5, reviews: 33,
  productWeight: 0.1, billingWeight: 0.1, imageUrl: "https://m.media-amazon.com/images/I/example.jpg",
  manualPurchaseCost: true, purchaseCost: 6, purchaseUnitCostCny: 3, pieceCount: 2, pieceCountSource: "manual",
  manualFbaFee: true, fbaFee: 2, fulfillmentMode: "FBA", fulfillmentModeSource: "manual",
  manualAmazonFields: { title: true }, fieldSources: { title: "manual", currentPrice: "amazon_product_page" }, reviewStatus: "pending",
  suppliers: [{ name: "Preserved supplier", unitPriceCny: 3 }], supplierRuleVersion: "1688-image-only-always-top6-trimmed-10-v6", supplierSearchStatus: "manual_cost",
  profitInputs: { ...profitModel.DEFAULT_PROFIT_RATES, formulaVersion: profitModel.PROFIT_FORMULA_VERSION, exchangeRate: 4.8, actualWeightKg: 0.1 },
});
function imageCandidate(index = 1, overrides = {}) {
  const asin = `B${String(index).padStart(9, "0")}`;
  return {
    ...canonicalProduct(), id: `AU:${asin}`, asin, sourceAsin: asin, name: `Blue image product ${index}`, englishName: `Blue image product ${index}`,
    currentPrice: null, currentPriceStatus: "unavailable", salePrice: null, manualSalePrice: false, productWeight: null, fbaWeight: null, billingWeight: null,
    detailStatus: "pending", manualPurchaseCost: false, purchaseCost: null, purchaseUnitCostCny: null, suppliers: [], supplierSearchStatus: "not_started",
    manualFbaFee: false, fbaFee: null, manualAmazonFields: {}, pieceCount: 1,
    profitInputs: { ...profitModel.DEFAULT_PROFIT_RATES, formulaVersion: profitModel.PROFIT_FORMULA_VERSION, exchangeRate: 4.8, actualWeightKg: null },
    ...overrides,
  };
}
function snapshot(collectionJob = job(), items = [canonicalProduct()]) {
  return {
    runState: { id: collectionJob?.runId || runId, mode: "live", marketplace: "AU", currency: "AUD", amazonDomain: "www.amazon.com.au", analysisSourceMode: "amazon_only", criteria: { useSellerSprite: false }, coverage: {}, ...(collectionJob ? { amazonCollectionJob: collectionJob, amazonCollectionRevision: collectionJob.revision } : {}) },
    products: structuredClone(items), criteria: { useSellerSprite: false }, resultCriteria: { minRating: 3 },
    storeList: { stores: [{ sellerId: "EXAMPLESELLER", asins: ["B000000001"] }], audit: { marketplace: "AU", uniqueSellers: 1 } },
    profitModel: { formulaVersion: profitModel.PROFIT_FORMULA_VERSION, exchangeRate: 4.8 },
    ...(collectionJob ? { amazonCollection: { ...collectionJob, items: [{ asin: "B000000001", currentPrice: 999, title: "Raw must not replace canonical title" }] }, amazonCollectionRevision: collectionJob.revision } : {}),
  };
}

function harness() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: false, disabled: false, hidden: false, textContent: "", innerHTML: "", title: "", dataset: {}, scrollTop: 0, scrollLeft: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, scrollIntoView() {}, focus() {}, closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {} });
    return elements.get(id);
  };
  const calls = [], timers = [], toasts = [], events = [];
  let respond = async (path) => { throw new Error(`Unexpected API request: ${path}`); };
  const context = vm.createContext({
    ...priceState, ...profitModel, ...pieceCount, ...handoff, ...coverage, ...detailRetry,
    document: { body: element("body"), addEventListener() {}, getElementById: element, querySelector: element, querySelectorAll() { return []; } },
    window: { crypto: { randomUUID: () => "new-synthetic-run" }, setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {},
      setInterval(callback, ms) { timers.push({ callback, ms, interval: true }); return timers.length; }, clearInterval() {}, confirm: () => true,
      EventSource: class { constructor(url) { this.url = url; events.push(this); } } },
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {}, requestAnimationFrame(callback) { callback(); }, structuredClone, AbortController, DOMException, URL,
    async fixtureApi(path, options = {}) { calls.push({ path, options, body: options.body ? JSON.parse(options.body) : null }); return respond(path, options); },
    fixtureToast: (...args) => toasts.push(args),
  });
  const source = appSource.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/\}\)\(\);\s*$/, `
    renderMarketUi = renderStoreAuditUi = renderStoreManager = setImportStatus = resetStoreAuditUi = setDataMode = renderResults = renderRunCoverage = updateHistorySummary = updateStartAvailability = initIcons = restorePending1688RiskStatus = setStage = setProgress = hideProgressError = showProgressError = showView = scheduleRequested1688Resume = () => {};
    const originalPopulateDrawer = populateDrawer;
    populateDrawer = (product) => { document.getElementById('drawerProductName').textContent = product.name; };
    apiRequest = fixtureApi;
    showToast = fixtureToast;
    delay = async () => {};
    getSetupCriteria = () => ({ useSellerSprite: false });
    validateSetupCriteria = () => null;
    globalThis.scout = {
      restore: restoreRunSnapshot, poll: pollAmazonCollection, run: runAnalysis, control: controlAmazonCollection,
      load: loadAmazonCollectionStatus, apply: applyAmazonCollectionJob, locked: isCollectionWriteLocked,
      save: persistCurrentRun, saveRequired: persistCurrentRunRequired, capture: captureRunSnapshot, render: renderAmazonCollection,
      scheduleResume: scheduleAmazonRunResume,
      startEvents: startSnapshotEvents, refresh: refreshAmazonCollectionSnapshot,
      settleSnapshots: async () => { while (amazonCollectionSnapshotPromise) await amazonCollectionSnapshotPromise; },
      loadSupplier: loadSupplierPipelineStatus, pollSupplier: poll1688AutoResume,
      resumeSupplier: () => resumePending1688Candidates(), pauseSupplier: pauseServerSupplierPipeline,
      applySession: (auth, queue) => apply1688SessionStatus(auth, queue),
      applySupplierResult: apply1688SearchResult, row: (id) => renderProductRow(products.find(product => product.id === id)),
      spreadsheet: (items) => createSpreadsheetExportPayload(items, activeMarket),
      fetchLegacy: () => fetchProductCandidates(storeList.stores, runState.criteria, new AbortController().signal, () => {}),
      mutate: () => { approveActiveProduct(); rejectActiveProduct(); rematchActiveProduct(); saveManualCost(); commitProfitEdits(false); exportProducts(); exportAnalysisHandoff(); },
      filtered: getFilteredProducts, matching: getAmazonFilteredProductsFor1688, pending: getPending1688ResumeProducts,
      startMatching: startFiltered1688Matching, renderSupplier: renderSupplier1688Stage,
      batch: (items) => run1688ImageSearchBatch(items, new AbortController().signal),
      prepareSupplier: (...args) => prepareAmazonCollectionForSupplier(...args),
      releaseSupplier: (...args) => releaseAmazonCollectionAfterSupplier(...args),
      setProducts: (value) => { products = value; },
      setPipeline: (value) => { runState.supplier1688Pipeline = value; },
      setSupplierLoggedIn: (value) => { supplier1688LoggedIn = value; },
      openLocalDrawer: (id) => { const simplified = populateDrawer; populateDrawer = originalPopulateDrawer; try { openDrawer(id); } finally { populateDrawer = simplified; } },
      state: () => ({ runState, products, activeProductId, activeRunCriteria, resultPage, revision: amazonCollectionRevision, persistenceLastError }),
      view: (id, page, criteria) => { activeProductId = id; resultPage = page; activeRunCriteria = criteria; },
      known: (value) => { amazonCollectionStatusKnown = value; },
      queue: (promise) => { persistenceSaveQueue = promise; },
      setRevision: (value) => { amazonCollectionRevision = value; },
    };
  })();`);
  vm.runInContext(source, context, { filename: "app.js" });
  return { app: context.scout, element, calls, timers, toasts, events, respond(fn) { respond = fn; } };
}

test("managed restore never restarts legacy browser collection and retains canonical manual fields", async () => {
  const { app, calls } = harness();
  app.restore(snapshot(), { autoResume: true });
  await Promise.resolve();
  assert.equal(calls.length, 0);
  assert.equal(app.locked(), true);
  const product = app.state().products[0];
  assert.equal(product.name, "Canonical manual title");
  assert.equal(product.currentPrice, 9.99);
  assert.equal(product.salePrice, 18);
  assert.equal(product.purchaseCost, 6);
  assert.equal(product.suppliers[0].name, "Preserved supplier");
  await assert.rejects(app.fetchLegacy(), { code: "COLLECTION_MANAGED_READ_ONLY" });
  assert.equal(calls.length, 0);
});

test("restore initializes only raw ASINs missing from the canonical snapshot", () => {
  const { app } = harness();
  const saved = snapshot();
  saved.amazonCollection.items.push({ asin: "B000000002", title: "New raw product", marketplace: "AU", detailStatus: "success", detailParserVersion: 5, currentPrice: 12.5, productWeightKg: 0.2 });
  app.restore(saved);
  assert.equal(app.state().products.length, 2);
  assert.equal(app.state().products[0].purchaseCost, 6);
  assert.equal(app.state().products[1].name, "New raw product");
  assert.equal(app.state().products[1].currentPrice, 12.5);
  assert.equal(app.state().products[1].supplierSearchStatus, "not_started");
});

test("revision polling preserves filters, pagination, open drawer and scroll positions", async () => {
  const fixture = harness();
  const { app, element, calls } = fixture;
  app.restore(snapshot());
  app.view(productId, 3, { minRating: 4.5, minReviews: 20 });
  element("resultSearch").value = "manual search";
  element("resultMinMargin").value = "25";
  element("resultsCompleteToggle").checked = true;
  element(".view-stack").scrollTop = 730;
  element(".drawer-content").scrollTop = 221;
  fixture.respond(async (path) => {
    if (path === "/api/amazon/collection") return job("running", 2);
    if (path === "/api/1688/pipeline") return null;
    assert.equal(path, `/api/runs/${runId}`);
    return snapshot(job("running", 2));
  });
  await Promise.all([app.poll(), app.poll()]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/amazon/collection", `/api/runs/${runId}`, "/api/1688/pipeline"]);
  assert.equal(app.state().revision, 2);
  assert.equal(app.state().activeProductId, productId);
  assert.equal(app.state().resultPage, 3);
  assert.equal(app.state().activeRunCriteria.minRating, 4.5);
  assert.equal(element("resultSearch").value, "manual search");
  assert.equal(element("resultMinMargin").value, "25");
  assert.equal(element("resultsCompleteToggle").checked, true);
  assert.equal(element(".view-stack").scrollTop, 730);
  assert.equal(element(".drawer-content").scrollTop, 221);
  assert.equal(element("drawerProductName").textContent, "Canonical manual title");
  await app.poll();
  assert.equal(calls.filter((call) => call.path.startsWith("/api/runs/")).length, 1);
});

for (const status of ["queued", "running", "cooldown"]) {
  test(`${status} owned jobs block manual changes, exports and snapshot saves`, async () => {
    const { app, calls, element } = harness();
    app.restore(snapshot(job(status)));
    app.view(productId, 1, {});
    const before = JSON.stringify(app.state().products);
    app.render();
    app.mutate();
    assert.equal(await app.save(), false);
    assert.equal(JSON.stringify(app.state().products), before);
    assert.equal(calls.length, 0);
    assert.equal(element("editSalePrice").disabled, true);
    assert.equal(element("exportAllCandidatesButton").disabled, true);
    assert.ok(element("collectionEditingNote").textContent.length > 0);
  });
}

for (const status of ["paused", "needs_attention"]) {
  test(`${status} jobs permit editing only after their worker has stopped`, async () => {
    const fixture = harness();
    const stopped = job(status);
    fixture.app.restore(snapshot(stopped));
    fixture.app.apply({ ...stopped, workerActive: true });
    assert.equal(fixture.app.locked(), true);
    fixture.app.apply({ ...stopped, workerActive: false });
    assert.equal(fixture.app.locked(), false);
    fixture.respond(async (path, options) => {
      assert.equal(path, "/api/runs");
      assert.equal(JSON.parse(options.body).runState.amazonCollectionRevision, stopped.revision);
      return { runs: [] };
    });
    assert.equal(await fixture.app.save(), true);
  });
}

test("manual resume sends server control without invoking the old detail endpoint", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("paused")));
  app.known(true);
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") return { runs: [] };
    if (path === "/api/amazon/collection/control") {
      assert.deepEqual(JSON.parse(options.body), { runId, action: "resume" });
      return job("running", 2);
    }
    return snapshot(job("running", 2));
  });
  await app.run();
  assert.deepEqual(calls.map((call) => call.path), ["/api/runs", "/api/amazon/collection/control", `/api/runs/${runId}`]);
  assert.equal(app.state().runState.id, runId);
});

test("completed job saves echo the current revision; stale rejection refreshes and terminates retry", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("completed", 7)));
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") {
      assert.equal(JSON.parse(options.body).amazonCollectionRevision, 7);
      throw Object.assign(new Error("Newer collection revision"), { status: 409, code: "STALE_COLLECTION_SNAPSHOT" });
    }
    return snapshot(job("completed", 8));
  });
  await assert.rejects(app.saveRequired(new AbortController().signal), { code: "STALE_COLLECTION_SNAPSHOT" });
  assert.deepEqual(calls.map((call) => call.path), ["/api/runs", `/api/runs/${runId}`]);
  assert.equal(app.state().revision, 8);
});

test("retrying missing fields saves completed-run edits before server control and shares concurrent clicks", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("completed", 4)));
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") {
      const saved = JSON.parse(options.body);
      assert.equal(saved.amazonCollectionRevision, 4);
      assert.equal(saved.products[0].purchaseCost, 6);
      return { runs: [] };
    }
    if (path === "/api/amazon/collection/control") {
      assert.equal(JSON.parse(options.body).action, "retry_missing");
      return job("running", 5);
    }
    return snapshot(job("running", 5));
  });
  await Promise.all([app.control("retry_missing"), app.control("retry_missing")]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/runs", "/api/amazon/collection/control", `/api/runs/${runId}`]);
});

test("queued snapshots are discarded when their collection revision changes before execution", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("completed", 1)));
  let release;
  app.queue(new Promise((resolve) => { release = resolve; }));
  const save = app.save();
  app.setRevision(2);
  fixture.respond(async () => snapshot(job("completed", 2)));
  release();
  assert.equal(await save, false);
  assert.equal(calls.some((call) => call.path === "/api/runs"), false);
  assert.equal(app.state().persistenceLastError.code, "STALE_COLLECTION_SNAPSHOT");
});

test("new Amazon-only run saves an initial snapshot then transfers collection to the server", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("completed", 17)));
  app.known(true);
  const nextJob = { ...job("queued", 1), runId: "new-synthetic-run" };
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") {
      const saved = JSON.parse(options.body);
      assert.equal(saved.runState.id, nextJob.runId);
      assert.equal(saved.amazonCollectionRevision, undefined);
      assert.equal(saved.products.length, 0);
      return { runs: [] };
    }
    if (path === "/api/amazon/collection/start") return nextJob;
    if (path === `/api/runs/${nextJob.runId}`) return snapshot(nextJob, []);
    throw new Error(`Unexpected path ${path}`);
  });
  await app.run();
  assert.deepEqual(calls.map((call) => call.path), ["/api/runs", "/api/amazon/collection/start", `/api/runs/${nextJob.runId}`]);
  assert.equal(app.state().runState.id, nextJob.runId);
  assert.equal(app.locked(), true);
});

test("unknown collector status is checked before a manual run and a failed read starts no business request", async () => {
  const fixture = harness();
  fixture.app.restore(snapshot(null));
  fixture.respond(async () => { throw new Error("Offline"); });
  await fixture.app.run();
  assert.deepEqual(fixture.calls.map((call) => call.path), ["/api/amazon/collection"]);
  assert.equal(fixture.app.state().runState.id, runId);
});

test("all 1200 image candidates remain matchable without prices, weights or successful detail status", () => {
  const { app } = harness();
  app.restore(snapshot(job("running"), []));
  app.setProducts(Array.from({ length: 1200 }, (_, index) => imageCandidate(index + 1, { detailStatus: index % 2 ? "failed" : "pending" })));
  app.view(null, 7, {});
  assert.equal(app.filtered().length, 1200);
  assert.equal(app.matching().length, 1200);
  assert.equal(app.matching().every((product) => product.currentPrice === null && product.productWeight === null), true);
});

test("the matching selection follows every current result filter across the entire filtered list", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("paused"), []));
  // 亚马逊准则 2026-10-09：under_50 档位已移除，档位筛选使用 50_to_100 / 100_plus。
  const base = { detailStatus: "success", productWeight: 0.12, billingWeight: 0.12, complete: true, margin: 35, sales30: 60, rating: 4.7, reviews: 30 };
  app.setProducts([
    imageCandidate(1, base), imageCandidate(2, { ...base, name: "Red image product", englishName: "Red image product" }),
    imageCandidate(3, { ...base, productWeight: 0.3, billingWeight: 0.3 }), imageCandidate(4, { ...base, complete: false }),
    imageCandidate(5, { ...base, margin: 10 }), imageCandidate(6, { ...base, rating: 3.8 }),
    imageCandidate(7, { ...base, sales30: 140 }), imageCandidate(8, { ...base, reviews: 2 }),
  ]);
  app.view(null, 5, { minRating: 4.5, minReviews: 20, monthlySalesBand: "50_to_100" });
  element("resultSearch").value = "blue";
  element("resultWeightBand").value = "100_150";
  element("resultsCompleteToggle").checked = true;
  element("resultMinMargin").value = "20";
  assert.deepEqual(Array.from(app.matching(), (product) => product.asin), ["B000000001"]);
  assert.deepEqual(Array.from(app.matching(), (product) => product.id), Array.from(app.filtered(), (product) => product.id));
  element("resultSearch").value = "";
  element("resultWeightBand").value = "";
  element("resultsCompleteToggle").checked = false;
  element("resultMinMargin").value = "";
  app.view(null, 5, {});
  assert.equal(app.matching().length, 8);
});

test("image matching retains protections for excluded and already matched products", () => {
  const { app } = harness();
  app.restore(snapshot(job("paused"), []));
  const excluded = [
    { imageUrl: null }, { asin: "", sourceAsin: "" }, { manualPurchaseCost: true }, { reviewStatus: "rejected" },
    { analysisHandoff: { owner: "procurement" } }, { dataMode: "mock" }, { supplierSearchStatus: "complete" },
    { supplierSearchStatus: "fallback_estimate" }, { supplierSearchStatus: "manual_cost" },
  ];
  app.setProducts([imageCandidate(1), ...excluded.map((values, index) => imageCandidate(index + 2, values))]);
  app.view(null, 1, {});
  assert.deepEqual(Array.from(app.matching(), (product) => product.asin), ["B000000001"]);
});

test("existing missing-input candidates with an image rejoin their saved supplier batch", () => {
  const { app } = harness();
  app.restore(snapshot(job("paused"), []));
  const withImage = imageCandidate(1, { supplierSearchStatus: "missing_inputs", supplierSearchErrorCode: "MISSING_INPUTS" });
  const withoutImage = imageCandidate(2, { supplierSearchStatus: "missing_inputs", imageUrl: null });
  app.setProducts([withImage, withoutImage]);
  app.setPipeline({ productIds: [withImage.id, withoutImage.id], status: "paused" });
  assert.deepEqual(Array.from(app.pending(), (product) => product.asin), ["B000000001"]);
});

test("an active collection offers the explicit supplier transition instead of disabling the matching button", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("running"), []));
  app.setProducts([imageCandidate()]);
  app.view(null, 1, {});
  app.renderSupplier();
  assert.equal(app.locked(), true);
  assert.equal(element("matchFiltered1688Button").disabled, false);
});

test("the actual supplier batch submits null price fields and stores real quotes without inventing profit", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("paused"), []));
  const product = imageCandidate();
  app.setProducts([product]);
  fixture.respond(async (path, options) => {
    assert.equal(path, "/api/1688/image-search");
    const body = JSON.parse(options.body);
    assert.equal(body.currentPrice, null);
    assert.equal(body.salePrice, null);
    assert.equal(body.targetCostCny, null);
    assert.equal(body.imageUrl, product.imageUrl);
    return {
      status: "complete", selectionMode: "verified_trimmed_10", costConfidence: "high",
      ruleVersion: "1688-image-only-always-top6-trimmed-10-v6", similarity: { threshold: 0.5, operator: "gt" },
      quotes: Array.from({ length: 10 }, (_, index) => ({ supplierId: `supplier-${index}`, offerId: `offer-${index}`, name: `Real quote ${index}`,
        unitPriceCny: index + 1, candidateImageUrl: `https://cbu01.alicdn.com/img/${index}.jpg`, imageSimilarityScore: 0.9 - index * 0.01,
        similarityMethod: "image", similarityVersion: "fixture-v1" })),
    };
  });
  const audit = await app.batch([product]);
  assert.equal(calls.length, 1);
  assert.equal(audit.attempted, 1);
  assert.equal(product.supplierSearchStatus, "complete");
  assert.equal(product.purchaseCost, 5.5);
  assert.equal(product.targetCostCny, null);
  assert.equal(product.roughMargin, null);
  assert.equal(product.margin, null);
});

test("no supplier quote keeps procurement cost missing even when sale price and weight are available", async () => {
  const fixture = harness();
  const { app } = fixture;
  app.restore(snapshot(job("paused"), []));
  const product = imageCandidate(1, { currentPrice: 30, salePrice: 27, productWeight: 0.12, billingWeight: 0.12, fbaFee: 2, manualFbaFee: true });
  app.setProducts([product]);
  fixture.respond(async (path) => {
    assert.equal(path, "/api/1688/image-search");
    return { status: "insufficient", quotes: [] };
  });
  await app.batch([product]);
  assert.equal(product.purchaseCost, null);
  assert.ok(Number.isFinite(product.margin));
  assert.equal(product.profitCalculation.purchaseCostAssumedZero, true);
  assert.equal(product.complete, false);
  assert.equal(product.profitPendingReasons.includes("采购成本"), false);
  assert.match(app.row(product.id), /预估利润率（未扣采购成本）/);
});

test("restoring an historical automatic zero cost without quote evidence clears the false cost", () => {
  const { app } = harness();
  const erroneousZero = imageCandidate(1, {
    currentPrice: 30, productWeight: 0.12, billingWeight: 0.12, fbaFee: 2,
    purchaseCost: 0, purchaseUnitCostCny: 0, supplierAverageCny: null, supplierSearchStatus: "insufficient",
  });
  app.restore(snapshot(job("paused"), [erroneousZero]));
  const restored = app.state().products[0];
  assert.equal(restored.purchaseCost, null);
  assert.equal(restored.purchaseUnitCostCny, null);
  assert.ok(Number.isFinite(restored.margin));
  assert.equal(restored.profitCalculation.purchaseCostAssumedZero, true);
  assert.equal(restored.profitPendingReasons.includes("采购成本"), false);
});

test("restoring a legitimate manual zero cost preserves the user's explicit input", () => {
  const { app } = harness();
  const manualZero = { ...canonicalProduct(), purchaseCost: 0, purchaseUnitCostCny: 0, supplierAverageCny: null, suppliers: [] };
  app.restore(snapshot(job("paused"), [manualZero]));
  const restored = app.state().products[0];
  assert.equal(restored.manualPurchaseCost, true);
  assert.equal(restored.purchaseCost, 0);
  assert.equal(restored.purchaseUnitCostCny, 0);
  assert.ok(Number.isFinite(restored.margin));
  assert.equal(restored.profitCalculation.purchaseCostAssumedZero, false);
  assert.equal(restored.profitPendingReasons.includes("采购成本"), false);
});

test("zero-cost estimates filter immediately, keep exported cost blank and cannot approve without actual cost", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("paused"), [imageCandidate(1, {
    detailStatus: "success", currentPrice: 30, currentPriceStatus: "verified",
    productWeight: 0.12, billingWeight: 0.12, manualFbaFee: true, fbaFee: 2,
  })]));
  const product = app.state().products[0];
  app.view(null, 1, {});
  element("resultMinMargin").value = String(product.margin - 0.1);
  assert.equal(app.filtered().length, 1);
  element("resultMinMargin").value = String(product.margin + 0.1);
  assert.equal(app.filtered().length, 0);
  app.openLocalDrawer(product.id);
  assert.equal(element("editPurchaseCost").value, "");
  assert.equal(element("approveProductButton").disabled, true);
  assert.match(element("drawerProfitValue").innerHTML, /预估利润率（未扣采购成本）/);
  const exported = app.spreadsheet([product]);
  assert.equal(exported.rows[0][exported.headers.indexOf("整套采购成本 (CNY)")], "");
  assert.ok(exported.rows[0].some((value) => typeof value === "string" && value.includes("预估利润率（未扣采购成本）")));
});

test("missing Amazon fields no longer show the removed cart or delivery-region price labels", () => {
  for (const reason of ["price_requires_cart", "delivery_region_unconfirmed"]) {
    const { app, element } = harness();
    app.restore(snapshot(job("paused"), [imageCandidate(1, {
      detailStatus: "success", rating: null, reviews: null,
      pageContextEvidence: { priceUnavailableReason: reason },
      collectionQuality: { fields: Object.fromEntries(["rating", "reviews", "sales30", "salesAmount30"].map(field => [field, { status: "unavailable" }])) },
    })]));
    const product = app.state().products[0];
    // 误导性说明已按用户要求删除；Amazon 并不会因未加购而不给售价。
    assert.ok(!app.row(product.id).includes("加入购物车"));
    assert.ok(!app.row(product.id).includes("配送地区未确认"));
    assert.equal(product.currentPrice, null);
    assert.equal(product.margin, null);
    app.openLocalDrawer(product.id);
    assert.match(element("amazonMetrics").innerHTML, /评分：页面未提供/);
    assert.match(element("amazonMetrics").innerHTML, /评论数：页面未提供/);
    assert.match(element("amazonMetrics").innerHTML, /准确销售额/);
  }
});

test("repeatedly opening actual local product drawers never requests Amazon details", async () => {
  const { app, calls, element } = harness();
  app.restore(snapshot(job("paused"), [
    imageCandidate(1, { detailStatus: "pending" }),
    imageCandidate(2, { detailStatus: "failed", detailRetryable: true }),
    imageCandidate(3, { detailStatus: "success", currentPrice: null }),
  ]));
  for (let iteration = 0; iteration < 9; iteration += 1) {
    const product = app.state().products[iteration % 3];
    app.openLocalDrawer(product.id);
    assert.equal(element("drawerProductName").textContent, product.name);
    assert.equal(app.state().activeProductId, product.id);
  }
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test("a failed Amazon-to-supplier pause never saves a batch or submits an image search", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("running"), [imageCandidate()]));
  app.view(null, 1, {});
  app.setSupplierLoggedIn(true);
  fixture.respond(async (path, options) => {
    if (path === "/api/amazon/collection") return job("running");
    if (path === "/api/amazon/collection/control") {
      assert.equal(JSON.parse(options.body).action, "pause_for_supplier");
      throw Object.assign(new Error("Synthetic pause failed"), { code: "COLLECTION_BUSY" });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  await app.startMatching();
  assert.equal(calls.some((call) => call.body?.action === "pause_for_supplier"), true);
  assert.equal(calls.some((call) => call.path === "/api/runs" || call.path === "/api/1688/image-search"), false);
});

test("supplier preparation adopts the current run when the server tracks another collection", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  const paused = { ...job("paused", 4), causeCode: "SUPPLIER_MATCHING" };
  app.restore(snapshot(job("completed", 4), [imageCandidate()]));
  app.apply({ ...job("needs_attention", 9), runId: "other-collection-run" });
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") return { runs: [] };
    if (path === "/api/amazon/collection/start") {
      assert.deepEqual(JSON.parse(options.body), { runId });
      return job("completed", 4);
    }
    if (path === "/api/amazon/collection/control") {
      assert.deepEqual(JSON.parse(options.body), { runId, action: "pause_for_supplier" });
      return paused;
    }
    if (path === `/api/runs/${runId}`) return snapshot(paused, [imageCandidate()]);
    throw new Error(`Unexpected request ${path}`);
  });
  assert.equal(await app.prepareSupplier(), true);
  assert.deepEqual(calls.map((call) => call.path),
    ["/api/runs", "/api/amazon/collection/start", "/api/amazon/collection/control", `/api/runs/${runId}`]);
});

test("supplier preparation pauses a busy stale collection and adopts the current run", async () => {
  const fixture = harness();
  const { app, calls, toasts } = fixture;
  const paused = { ...job("paused", 4), causeCode: "SUPPLIER_MATCHING" };
  const stale = { ...job("running", 9), runId: "stale-collection-run" };
  app.restore(snapshot(job("completed", 4), [imageCandidate()]));
  app.apply(stale);
  let startAttempts = 0;
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") return { runs: [] };
    if (path === "/api/amazon/collection/start") {
      assert.deepEqual(JSON.parse(options.body), { runId });
      startAttempts += 1;
      if (startAttempts === 1) {
        throw Object.assign(new Error("已有后台采集任务，请先暂停该任务。"), { code: "COLLECTION_BUSY" });
      }
      return job("completed", 4);
    }
    if (path === "/api/amazon/collection/control") {
      const body = JSON.parse(options.body);
      if (body.action === "pause") {
        assert.equal(body.runId, "stale-collection-run");
        return { ...stale, status: "paused", enabled: false };
      }
      assert.deepEqual(body, { runId, action: "pause_for_supplier" });
      return paused;
    }
    if (path === "/api/amazon/collection") return { ...stale, status: "paused", enabled: false };
    if (path === `/api/runs/${runId}`) return snapshot(paused, [imageCandidate()]);
    throw new Error(`Unexpected request ${path}`);
  });
  assert.equal(await app.prepareSupplier(), true);
  assert.equal(startAttempts, 2);
  assert.deepEqual(calls.map((call) => `${call.path}:${call.body?.action || ""}`), [
    "/api/runs:",
    "/api/amazon/collection/start:",
    "/api/amazon/collection/control:pause",
    "/api/amazon/collection:",
    "/api/amazon/collection/start:",
    "/api/amazon/collection/control:pause_for_supplier",
    `/api/runs/${runId}:`,
  ]);
  assert.equal(toasts.some(([message]) => String(message).includes("已清空之前的后台采集任务")), true);
});

test("a stale supplier-batch checkpoint terminates before any image search", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  const paused = { ...job("paused", 2), causeCode: "SUPPLIER_MATCHING" };
  app.restore(snapshot(job("running", 1), [imageCandidate()]));
  app.view(null, 1, {});
  app.setSupplierLoggedIn(true);
  let current = job("running", 1);
  fixture.respond(async (path, options) => {
    if (path === "/api/amazon/collection") return current;
    if (path === "/api/amazon/collection/control") {
      const action = JSON.parse(options.body).action;
      current = action === "pause_for_supplier" ? paused : job("queued", 4);
      return current;
    }
    if (path === `/api/runs/${runId}`) return snapshot(current, [imageCandidate()]);
    if (path === "/api/runs") {
      const saved = JSON.parse(options.body);
      assert.equal(saved.runState.amazonCollectionRevision, 2);
      assert.equal(saved.runState.supplier1688Pipeline.productIds.length, 1);
      current = { ...paused, revision: 3 };
      throw Object.assign(new Error("Synthetic newer revision"), { status: 409, code: "STALE_COLLECTION_SNAPSHOT" });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  await app.startMatching();
  assert.equal(calls.filter((call) => call.path === "/api/runs").length, 1);
  assert.equal(calls.some((call) => call.path === "/api/1688/image-search"), false);
});

test("re-scoping to the current filter discards the server-owned batch before saving a new one", async () => {
  const fixture = harness();
  const { app, calls, toasts } = fixture;
  const first = imageCandidate(1, { supplierSearchStatus: "pending" });
  const second = imageCandidate(2);
  const oldPipeline = { owner: "server", status: "paused", productIds: [first.id], selectedCount: 1, matchableCount: 1, revision: 5 };
  const paused = { ...job("paused", 2), causeCode: "SUPPLIER_MATCHING" };
  const base = snapshot(job("paused", 2), [first, second]);
  base.runState.supplier1688Pipeline = oldPipeline;
  app.restore(structuredClone(base));
  app.view(null, 1, {});
  app.setSupplierLoggedIn(true);
  let saved = structuredClone(base);
  fixture.respond(async (path, options) => {
    if (path === "/api/amazon/collection") return paused;
    if (path === "/api/amazon/collection/control") {
      const action = JSON.parse(options.body).action;
      if (action === "resume_after_supplier") return job("queued", 3);
      assert.equal(action, "pause_for_supplier");
      return paused;
    }
    if (path === "/api/1688/pipeline/control") {
      const body = JSON.parse(options.body);
      if (body.action === "discard") {
        assert.equal(body.runId, runId);
        saved = structuredClone(base);
        delete saved.runState.supplier1688Pipeline;
        return null;
      }
      assert.equal(body.action, "resume");
      const pipeline = { ...saved.runState.supplier1688Pipeline, owner: "server", status: "queued", revision: 6, runId };
      saved = { ...saved, runState: { ...saved.runState, supplier1688Pipeline: pipeline } };
      return pipeline;
    }
    if (path === `/api/runs/${runId}`) return structuredClone(saved);
    if (path === "/api/runs") {
      const incoming = JSON.parse(options.body);
      saved = { ...incoming, amazonCollection: saved.amazonCollection };
      return { runs: [] };
    }
    throw new Error(`Unexpected request ${path}`);
  });
  assert.equal(await app.startMatching(), true);
  const discardIndex = calls.findIndex((call) => call.body?.action === "discard");
  assert.ok(discardIndex > 0, "the old server-owned batch must be discarded first");
  const batchSaveIndex = calls.findIndex((call) => call.path === "/api/runs"
    && call.body.runState.supplier1688Pipeline?.productIds?.length === 2);
  assert.ok(batchSaveIndex > discardIndex, "the new filtered batch is saved after the discard");
  const resumeIndex = calls.findIndex((call) => call.body?.action === "resume");
  assert.ok(resumeIndex > batchSaveIndex, "the new batch is handed to the background after saving");
  assert.equal(toasts.some(([message]) => String(message).includes("已清空旧批次")), true);
});

test("supplier preparation waits for an older in-flight snapshot before loading the final pause revision", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(snapshot(job("running", 1), [imageCandidate()]));
  let releaseOldSnapshot, markOldSnapshotStarted;
  const oldSnapshotStarted = new Promise((resolve) => { markOldSnapshotStarted = resolve; });
  const oldSnapshot = new Promise((resolve) => { releaseOldSnapshot = resolve; });
  const paused = { ...job("paused", 3), causeCode: "SUPPLIER_MATCHING" };
  let snapshotReads = 0;
  fixture.respond(async (path, options) => {
    if (path === "/api/amazon/collection") return job("running", 2);
    if (path === "/api/amazon/collection/control") {
      assert.equal(JSON.parse(options.body).action, "pause_for_supplier");
      return paused;
    }
    if (path === `/api/runs/${runId}`) {
      snapshotReads += 1;
      if (snapshotReads === 1) { markOldSnapshotStarted(); return oldSnapshot; }
      return snapshot(paused, [imageCandidate()]);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const poll = app.poll();
  await oldSnapshotStarted;
  const prepared = app.prepareSupplier();
  await Promise.resolve();
  assert.equal(calls.some((call) => call.path === "/api/amazon/collection/control"), false);
  releaseOldSnapshot(snapshot(job("running", 2), [imageCandidate()]));
  await poll;
  assert.equal(await prepared, true);
  assert.equal(snapshotReads, 2);
  assert.equal(app.state().revision, 3);
  assert.equal(app.state().runState.amazonCollectionJob.causeCode, "SUPPLIER_MATCHING");
});

for (const manuallyPaused of [false, true]) {
  test(`supplier server handoff ${manuallyPaused ? "preserves a user's manual Amazon pause" : "releases the temporary Amazon pause after the fixed batch is saved and accepted"}`, async () => {
    const fixture = harness();
    const { app, calls } = fixture;
    let current = manuallyPaused ? { ...job("paused", 1), causeCode: "USER_PAUSED" } : job("running", 1);
    let saved = snapshot(current, [imageCandidate()]);
    app.restore(structuredClone(saved));
    app.view(null, 1, {});
    app.setSupplierLoggedIn(true);
    fixture.respond(async (path, options) => {
      if (path === "/api/amazon/collection") return current;
      if (path === "/api/amazon/collection/control") {
        const action = JSON.parse(options.body).action;
        if (action === "pause_for_supplier" && !manuallyPaused) current = { ...job("paused", 2), causeCode: "SUPPLIER_MATCHING" };
        if (action === "resume_after_supplier") current = job("queued", 3);
        saved = { ...saved, runState: { ...saved.runState, amazonCollectionJob: current, amazonCollectionRevision: current.revision }, amazonCollection: { ...current, items: [] }, amazonCollectionRevision: current.revision };
        return current;
      }
      if (path === `/api/runs/${runId}`) return structuredClone(saved);
      if (path === "/api/runs") {
        const incoming = JSON.parse(options.body);
        assert.equal(incoming.runState.amazonCollectionRevision, current.revision);
        saved = { ...incoming, amazonCollection: { ...current, items: [] } };
        return { runs: [] };
      }
      if (path === "/api/1688/pipeline/control") {
        assert.deepEqual(JSON.parse(options.body), { runId, action: "resume" });
        assert.deepEqual(saved.runState.supplier1688Pipeline.productIds, [productId]);
        const pipeline = { ...saved.runState.supplier1688Pipeline, owner: "server", status: "running", revision: 1, runId };
        saved = { ...saved, runState: { ...saved.runState, supplier1688Pipeline: pipeline } };
        return pipeline;
      }
      throw new Error(`Unexpected request ${path}`);
    });
    assert.equal(await app.startMatching(), true);
    const handoffIndex = calls.findIndex((call) => call.path === "/api/1688/pipeline/control");
    assert.ok(handoffIndex > 0);
    assert.equal(calls.some((call) => call.path === "/api/1688/image-search"), false);
    assert.equal(calls.filter((call) => call.path === "/api/1688/pipeline/control").length, 1);
    const fixedBatchSaveIndex = calls.findIndex((call) => call.path === "/api/runs" && call.body.runState.supplier1688Pipeline?.productIds?.length === 1);
    assert.ok(fixedBatchSaveIndex >= 0 && fixedBatchSaveIndex < handoffIndex);
    assert.equal(app.state().runState.supplier1688Pipeline.owner, "server");
    assert.equal(app.state().runState.supplier1688Pipeline.status, "running");
    assert.deepEqual(Array.from(app.state().runState.supplier1688Pipeline.productIds), [productId]);
    const releaseIndex = calls.findIndex((call) => call.body?.action === "resume_after_supplier");
    if (manuallyPaused) {
      assert.equal(releaseIndex, -1);
      assert.equal(current.status, "paused");
      assert.equal(current.causeCode, "USER_PAUSED");
    } else {
      assert.ok(releaseIndex > handoffIndex);
      assert.equal(calls[releaseIndex - 1].path, `/api/runs/${runId}`);
      assert.equal(saved.runState.supplier1688Pipeline.status, "running", "The browser releases its preparation pause while the durable supplier runner continues.");
      assert.equal(current.status, "queued");
    }
  });
}

test("a new collection revision automatically computes profit once weight arrives and retains manual rates", async () => {
  const fixture = harness();
  const { app } = fixture;
  const pricedWithoutWeight = canonicalProduct();
  Object.assign(pricedWithoutWeight, {
    manualSalePrice: false, salePrice: null, productWeight: null, fbaWeight: null, billingWeight: null,
    manualFbaFee: false, fbaFee: null,
    profitInputs: { ...pricedWithoutWeight.profitInputs, actualWeightKg: null, commissionRate: 9, marketingRate: 7, airFreightRateCnyPerKg: 52, airFreightRateSource: "product_manual" },
  });
  app.restore(snapshot(job("running", 1), [pricedWithoutWeight]));
  const incomplete = app.state().products[0];
  assert.equal(incomplete.salePrice, 8.99);
  // 亚马逊准则 2026-09-29：重量未采集的一律按最低运费档计算，不再阻断利润。
  assert.ok(Number.isFinite(incomplete.margin));
  assert.deepEqual(Array.from(incomplete.profitPendingReasons), []);
  assert.equal(incomplete.fbaFee, 3.64);
  assert.equal(incomplete.fbaEstimate.weightSource, "重量未采集 · 按最低运费档估算");
  const nextProduct = { ...structuredClone(pricedWithoutWeight), productWeight: 0.12, billingWeight: 0.12 };
  fixture.respond(async (path) => path === "/api/amazon/collection" ? job("completed", 2) : snapshot(job("completed", 2), [nextProduct]));
  await app.poll();
  const complete = app.state().products[0];
  assert.equal(complete.profitInputs.commissionRate, 9);
  assert.equal(complete.profitInputs.marketingRate, 7);
  assert.equal(complete.profitInputs.airFreightRateCnyPerKg, 52);
  assert.ok(Number.isFinite(complete.fbaFee));
  const expected = profitModel.calculateProductProfit({
    ...complete.profitInputs, salePrice: complete.salePrice, purchaseCostCny: complete.purchaseCost,
    fulfillmentMode: complete.fulfillmentMode, fulfillmentFee: complete.fbaFee, actualWeightKg: 0.12,
  });
  assert.ok(expected);
  assert.equal(complete.margin, expected.margin);
  assert.equal(complete.profitValue, expected.profit);
  assert.deepEqual(Array.from(complete.profitPendingReasons), []);
});

const supplierPipeline = (overrides = {}) => ({
  owner: "server", runId, version: 2, status: "running", revision: 1,
  selectionId: "fixed-synthetic-selection", scope: "confirmed_amazon_filters", productIds: [productId],
  selectedCount: 1, matchableCount: 1, processed: 0, remaining: 1, enabled: true, ...overrides,
});
function supplierSnapshot(pipeline, items, collection = job("completed", 7)) {
  const saved = snapshot(collection, items);
  saved.runState.supplier1688Pipeline = structuredClone(pipeline);
  return saved;
}
const supplierQuotes = () => ({
  status: "complete", selectionMode: "verified_trimmed_10", costConfidence: "high",
  ruleVersion: "1688-image-only-always-top6-trimmed-10-v6", similarity: { threshold: 0.5, operator: "gt" },
  quotes: Array.from({ length: 10 }, (_, index) => ({
    supplierId: `supplier-${index}`, offerId: `offer-${index}`, name: `Saved quote ${index}`, unitPriceCny: index + 1,
    candidateImageUrl: `https://cbu01.alicdn.com/img/${index}.jpg`, imageSimilarityScore: 0.9 - index * 0.01,
    similarityMethod: "image", similarityVersion: "fixture-v1",
  })),
});

test("a supplier result event refreshes quotes and formula profit in the visible row without another search", async () => {
  const fixture = harness();
  const { app, calls, events } = fixture;
  const awaitingCost = imageCandidate(1, { detailStatus: "success", currentPrice: 30, currentPriceStatus: "verified",
    manualSalePrice: true, salePrice: 27, productWeight: 0.12, billingWeight: 0.12, fbaFee: 2, manualFbaFee: true,
    supplierSearchStatus: "pending" });
  app.restore(supplierSnapshot(supplierPipeline(), [awaitingCost]));
  const estimatedMargin = app.state().products[0].margin;
  assert.ok(Number.isFinite(estimatedMargin));
  assert.equal(app.state().products[0].profitCalculation.purchaseCostAssumedZero, true);
  assert.match(app.row(productId), /预估利润率（未扣采购成本）/);
  const completed = structuredClone(awaitingCost);
  app.applySupplierResult(completed, supplierQuotes());
  assert.equal(completed.purchaseCost, 5.5);
  const nextPipeline = supplierPipeline({ revision: 2, processed: 1, remaining: 0, status: "complete", enabled: false });
  fixture.respond(async path => {
    assert.equal(path, `/api/runs/${runId}`);
    return supplierSnapshot(nextPipeline, [completed]);
  });
  app.startEvents(); app.startEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].url, "/api/events");
  events[0].onmessage({ data: JSON.stringify({ runId, revision: 2, source: "supplier" }) });
  await app.settleSnapshots();
  const visible = app.state().products[0];
  assert.equal(visible.supplierSearchStatus, "complete");
  assert.equal(visible.suppliers.length, 10);
  assert.equal(visible.purchaseCost, 5.5);
  const expected = profitModel.calculateProductProfit({ ...visible.profitInputs, salePrice: visible.salePrice,
    purchaseCostCny: visible.purchaseCost, fulfillmentMode: visible.fulfillmentMode,
    fulfillmentFee: visible.fulfillmentFee ?? visible.fbaFee, actualWeightKg: visible.productWeight });
  assert.ok(expected);
  assert.equal(visible.margin, expected.margin);
  assert.ok(visible.margin < estimatedMargin);
  assert.equal(visible.profitCalculation.purchaseCostAssumedZero, false);
  assert.doesNotMatch(app.row(productId), /未扣采购成本/);
  assert.equal(visible.profitValue, expected.profit);
  assert.deepEqual(Array.from(visible.profitPendingReasons), []);
  assert.match(app.row(productId), /margin-value/);
  assert.doesNotMatch(app.row(productId), /待计算/);
  assert.deepEqual(calls.map(call => call.path), [`/api/runs/${runId}`]);
  assert.equal(calls.every(call => !call.options.method || call.options.method === "GET"), true);
});

test("supplier events for another run and malformed events leave the active run and requests untouched", async () => {
  const { app, calls, events } = harness();
  app.restore(supplierSnapshot(supplierPipeline(), [imageCandidate()]));
  app.startEvents();
  events[0].onmessage({ data: JSON.stringify({ runId: "other-synthetic-run", revision: 99 }) });
  events[0].onmessage({ data: "not-json" });
  await app.settleSnapshots();
  assert.equal(calls.length, 0);
  assert.equal(app.state().runState.id, runId);
  assert.equal(app.state().runState.supplier1688Pipeline.revision, 1);
});

for (const status of ["running", "paused", "cooldown"]) {
  test(`reloading a server ${status} supplier batch preserves ownership, revision, task links and its fixed cohort`, async () => {
    const { app, calls } = harness();
    const selected = imageCandidate(1, { supplierSearchStatus: "session_expired", supplierSearchErrorCode: "RISK_CONTROL" });
    const laterArrival = imageCandidate(2);
    const pipeline = supplierPipeline({ status, revision: 17, enabled: status !== "paused", lastReason: status === "paused" ? "USER_PAUSED" : "task_saved",
      tasks: { [selected.id]: { taskId: "b2ed267c-8137-491e-860b-fc1e60d7f83e" } } });
    app.restore(supplierSnapshot(pipeline, [selected, laterArrival]), { autoResume: true });
    await Promise.resolve();
    const restored = app.state().runState.supplier1688Pipeline;
    assert.equal(restored.owner, "server");
    assert.equal(restored.status, status);
    assert.equal(restored.revision, 17);
    assert.equal(restored.enabled, status !== "paused");
    assert.equal(restored.lastReason, pipeline.lastReason);
    assert.equal(restored.tasks[selected.id].taskId, pipeline.tasks[selected.id].taskId);
    assert.deepEqual(Array.from(restored.productIds), [selected.id]);
    assert.deepEqual(Array.from(app.pending(), product => product.id), [selected.id]);
    assert.equal(calls.length, 0, "Restoring server ownership must not start a browser batch or issue a resume POST.");
  });
}

test("polling a server batch paused for manual verification only reads status and never resumes it", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  const pipeline = supplierPipeline({ status: "paused", enabled: false, revision: 12, lastReason: "RISK_VERIFICATION_REQUIRED" });
  app.restore(supplierSnapshot(pipeline, [imageCandidate(1, { supplierSearchStatus: "session_expired" })]));
  app.applySession({ ready: true, reason: "ready" }, { riskBlocked: 1, activeTasks: [],
    ratePolicy: { pausedReason: "RISK_VERIFICATION_REQUIRED", manualResumeRequired: true } });
  fixture.respond(async path => { assert.equal(path, "/api/1688/pipeline"); return structuredClone(pipeline); });
  await app.pollSupplier();
  assert.deepEqual(calls.map(call => call.path), ["/api/1688/pipeline"]);
  assert.equal(app.state().runState.supplier1688Pipeline.status, "paused");
  assert.equal(app.state().runState.supplier1688Pipeline.enabled, false);
  assert.equal(app.state().runState.supplier1688Pipeline.lastReason, "RISK_VERIFICATION_REQUIRED");
});

test("supplier revision changes trigger one snapshot refresh even when Amazon collection has not changed", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(supplierSnapshot(supplierPipeline(), [imageCandidate()]));
  const next = supplierPipeline({ revision: 2, status: "paused", enabled: false, lastReason: "USER_PAUSED" });
  fixture.respond(async path => {
    if (path === "/api/1688/pipeline") return next;
    assert.equal(path, `/api/runs/${runId}`);
    return supplierSnapshot(next, [imageCandidate()]);
  });
  await app.loadSupplier();
  await app.loadSupplier();
  assert.deepEqual(calls.map(call => call.path), ["/api/1688/pipeline", `/api/runs/${runId}`, "/api/1688/pipeline"]);
  assert.equal(app.state().revision, 7);
  assert.equal(app.state().runState.supplier1688Pipeline.revision, 2);
  assert.equal(app.state().runState.supplier1688Pipeline.status, "paused");
});

test("resuming the saved server batch sends only its run ID and does not add newly available products", async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  const selected = imageCandidate(1, { supplierSearchStatus: "session_expired" });
  const laterArrival = imageCandidate(2);
  const saved = supplierPipeline({ status: "paused", enabled: false });
  app.restore(supplierSnapshot(saved, [selected, laterArrival]));
  app.setSupplierLoggedIn(true);
  app.view(null, 1, {});
  assert.equal(app.matching().length, 2);
  assert.equal(app.pending().length, 1);
  const running = supplierPipeline({ revision: 2 });
  fixture.respond(async (path, options) => {
    if (path === "/api/1688/pipeline/control") {
      assert.deepEqual(JSON.parse(options.body), { runId, action: "resume" });
      return running;
    }
    assert.equal(path, `/api/runs/${runId}`);
    return supplierSnapshot(running, [selected, laterArrival]);
  });
  assert.equal(await app.resumeSupplier(), true);
  assert.deepEqual(calls.map(call => call.path), ["/api/1688/pipeline/control", `/api/runs/${runId}`]);
  assert.deepEqual(Array.from(app.state().runState.supplier1688Pipeline.productIds), [selected.id]);
  assert.equal(app.state().products.find(product => product.id === laterArrival.id).supplierSearchStatus, "not_started");
});

function serverPricedSnapshot({ score = 0.4, count = 6 } = {}) {
  const product = imageCandidate(1, {
    detailStatus: "success", currentPrice: 30, currentPriceStatus: "verified", manualSalePrice: true, salePrice: 27,
    productWeight: 0.12, billingWeight: 0.12, actualWeightKg: 0.12, fbaFee: 4.7, manualFbaFee: true,
    supplierSearchStatus: "pending", pieceCount: 1,
  });
  const saved = supplierSnapshot(supplierPipeline({ status: "complete", processed: 1, remaining: 0, revision: 2 }), [product]);
  // Use the production server quote policy and result writer. Hand-authoring
  // frontend-normalized decisions would hide the failed/below_threshold mismatch.
  const result = buildSupplierSearchResult(Array.from({ length: count }, (_, index) => ({
    supplierId: `server-supplier-${index}`, supplierName: `Server quote ${index}`, price: 12 + index,
    moq: 100, unit: "件", offerId: String(100000 + index), offerUrl: `https://detail.1688.com/offer/${100000 + index}.html`,
    candidateImageUrl: `https://cbu01.alicdn.com/img/ibank/server-quote-${index}.jpg`,
    imageSimilarityScore: score, similarityMethod: "perceptual-image", similarityVersion: "fixture-v1",
  })), { targetMoq: 100, targetUnit: "件", searchedAt: "2026-09-24T10:00:00.000Z" });
  saved.products[0] = applySupplierProfitResult(product, {
    ...result, procurementTaskId: "b2ed267c-8137-491e-860b-fc1e60d7f83e",
  }, saved);
  return { saved, result };
}

test("actual server fallback quotes survive profit persistence and real frontend policy migration with their cost and margin intact", () => {
  const fixture = harness();
  const { saved, result } = serverPricedSnapshot();
  assert.equal(result.status, "fallback_estimate");
  assert.equal(result.costConfidence, "low");
  assert.equal(result.quotes.length, 6);
  assert.equal(result.quotes.every(quote => quote.imageSimilarityDecision === "below_threshold" && quote.supplierMatchDecision === "failed"), true);
  const backendProduct = structuredClone(saved.products[0]);
  assert.equal(backendProduct.manualPurchaseCost, false);
  assert.equal(backendProduct.purchaseCost, 14.5);
  assert.ok(Number.isFinite(backendProduct.margin));
  assert.ok(Number.isFinite(backendProduct.profitValue));
  fixture.app.restore(saved, { persistMigrations: false });
  const restored = fixture.app.state().products[0];
  assert.equal(restored.supplierSearchStatus, "fallback_estimate");
  assert.equal(restored.supplierCostConfidence, "low");
  assert.equal(restored.purchaseUnitCostCny, backendProduct.purchaseUnitCostCny);
  assert.equal(restored.purchaseCost, backendProduct.purchaseCost);
  assert.equal(restored.margin, backendProduct.margin);
  assert.equal(restored.profitValue, backendProduct.profitValue);
  assert.equal(restored.suppliers.length, 6);
  assert.deepEqual(Array.from(restored.profitPendingReasons), []);
  assert.match(fixture.app.row(productId), /低置信度/);
  assert.doesNotMatch(fixture.app.row(productId), /待计算|匹配待更新/);
  assert.equal(fixture.calls.length, 0);
});

test("a saved below-threshold quote falsely marked passed still invalidates automatic procurement cost on restore", () => {
  const { app, calls } = harness();
  const { saved } = serverPricedSnapshot();
  saved.products[0].suppliers[0].imageSimilarityDecision = "passed";
  saved.products[0].suppliers[0].supplierMatchDecision = "passed";
  app.restore(saved, { persistMigrations: false });
  const restored = app.state().products[0];
  assert.equal(restored.supplierSearchStatus, "similarity_unverified");
  assert.equal(restored.purchaseCost, null);
  assert.ok(Number.isFinite(restored.margin));
  assert.equal(restored.profitCalculation.purchaseCostAssumedZero, true);
  assert.equal(restored.profitPendingReasons.includes("采购成本"), false);
  assert.equal(calls.length, 0);
});

test("server failed is not equivalent to a passed match even when its image score qualifies", () => {
  const { app, calls } = harness();
  const { saved, result } = serverPricedSnapshot({ score: 0.98, count: 10 });
  assert.equal(result.status, "complete");
  assert.equal(saved.products[0].suppliers[0].imageSimilarityDecision, "passed");
  saved.products[0].suppliers[0].supplierMatchDecision = "failed";
  app.restore(saved, { persistMigrations: false });
  const restored = app.state().products[0];
  assert.equal(restored.supplierSearchStatus, "similarity_unverified");
  assert.equal(restored.purchaseCost, null);
  assert.ok(Number.isFinite(restored.margin));
  assert.equal(restored.profitCalculation.purchaseCostAssumedZero, true);
  assert.equal(calls.length, 0);
});
