import * as salesPolicy from "../lib/amazon-sales-policy.mjs";
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
  sales30: 100, sales30Evidence: { source: "amazon_product_page", period: "past_month", kind: "lower_bound", value: 100, rawText: "100+ bought in past month", asin: "B000000001" },
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
    sales30: overrides.sales30 ?? 100,
    sales30Evidence: { source: "amazon_store_card", period: "past_month", kind: "lower_bound", value: overrides.sales30 ?? 100, rawText: `${overrides.sales30 ?? 100}+ bought in past month`, asin },
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
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, insertAdjacentHTML(position, html) { this.innerHTML = position === "afterbegin" ? html + this.innerHTML : this.innerHTML + html; }, scrollIntoView() {}, focus() {}, closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, listeners: {}, addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); } });
    return elements.get(id);
  };
  const calls = [], timers = [], toasts = [], events = [];
  let respond = async (path) => { throw new Error(`Unexpected API request: ${path}`); };
  const context = vm.createContext({
    ...salesPolicy, ...priceState, ...profitModel, ...pieceCount, ...handoff, ...coverage, ...detailRetry,
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
      approve: approveActiveProduct, saveEditor: commitProfitEdits, mapCandidate: mapCandidateProduct, mergeCandidates: mergeAnalyzedCandidateProducts,
      editor: getEditorValues, preview: renderProfitPreview, manualPreview: renderManualCostPreview,
      bindEditor: bindDrawer, saveEditorToDisk: saveProfitEditor, settleSaves: () => persistenceSaveQueue,
      useRealDrawer: () => { populateDrawer = originalPopulateDrawer; },
      openManual: openManualCostDialog, approveManual: () => saveManualCost({ approve: true }), saveManualDraft: () => saveManualCost({ allowIncomplete: true }),
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
  return { app: context.scout, element, calls, timers, toasts, events,
    fire(id, type) { return Promise.all((element(id).listeners[type] || []).map(callback => callback({ target: element(id), preventDefault() {} }))); },
    respond(fn) { respond = fn; } };
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

test("zero-cost estimates keep exported cost blank and allow initial review before matching", () => {
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
  assert.equal(element("approveProductButton").disabled, false);
  assert.match(element("drawerProfitValue").innerHTML, /预估利润率（未扣采购成本）/);
  const exported = app.spreadsheet([product]);
  assert.equal(exported.rows[0][exported.headers.indexOf("整套采购成本 (CNY)")], "");
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

for (const oldStatus of ['paused', 'complete']) {
  test(`current filters append to the same ${oldStatus} task and preserve earlier records`, async () => {
    const fixture = harness();
    const { app, calls } = fixture;
    const first = imageCandidate(1, oldStatus === 'complete' ? { supplierSearchStatus: 'manual_cost', manualPurchaseCost: true, purchaseCost: 8, purchaseUnitCostCny: 8 } : { supplierSearchStatus: 'pending' });
    const second = imageCandidate(2);
    const oldPipeline = { owner: 'server', status: oldStatus, productIds: [first.id], selectedCount: 1, matchableCount: 1, revision: 263, selectionId: 'original-selection', tasks: { [first.id]: { taskId: 'task_original', status: oldStatus === 'complete' ? 'complete' : 'pending', attempts: 1 } } };
    const current = job('completed', 139);
    const base = snapshot(current, [first, second]);
    base.runState.supplier1688Pipeline = oldPipeline;
    let saved = structuredClone(base);
    app.restore(structuredClone(base)); app.view(null, 1, {}); app.setSupplierLoggedIn(true);
    fixture.respond(async (path, options) => {
      if (path === '/api/amazon/collection') return current;
      if (path === '/api/amazon/collection/control') { assert.equal(JSON.parse(options.body).action, 'pause_for_supplier'); return current; }
      if (path === `/api/runs/${runId}`) return structuredClone(saved);
      if (path === '/api/runs') {
        const incoming = JSON.parse(options.body);
        assert.equal(incoming.runState.supplier1688Pipeline.revision, 263, 'the page may save the original snapshot, never replace the cohort');
        saved = { ...incoming, amazonCollection: saved.amazonCollection };
        return { runs: [] };
      }
      if (path === '/api/1688/pipeline/control') {
        const body = JSON.parse(options.body);
        assert.equal(body.runId, runId);
        if (body.action === 'append') {
          assert.deepEqual(body.productIds, oldStatus === 'complete' ? [second.id] : [first.id, second.id]);
          saved.runState.supplier1688Pipeline = { ...oldPipeline, status: 'paused', productIds: [first.id, second.id], selectedCount: 2, matchableCount: 2, revision: 264 };
          return { ...saved.runState.supplier1688Pipeline, runId };
        }
        assert.equal(body.action, 'resume');
        saved.runState.supplier1688Pipeline = { ...saved.runState.supplier1688Pipeline, status: 'queued', revision: 265 };
        return { ...saved.runState.supplier1688Pipeline, runId };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    assert.equal(await app.startMatching(), true);
    const appendIndex = calls.findIndex(call => call.body?.action === 'append');
    const resumeIndex = calls.findIndex(call => call.body?.action === 'resume');
    assert.ok(appendIndex >= 0 && resumeIndex > appendIndex);
    assert.ok(calls.slice(appendIndex + 1, resumeIndex).some(call => call.path === `/api/runs/${runId}`));
    assert.equal(calls.some(call => call.body?.action === 'discard'), false);
    assert.equal(calls.slice(appendIndex).some(call => call.path === '/api/runs'), false);
    assert.equal(calls.some(call => call.path === '/api/1688/image-search'), false);
    assert.equal(app.state().runState.id, runId);
    assert.equal(app.state().runState.supplier1688Pipeline.selectionId, 'original-selection');
    assert.deepEqual(JSON.parse(JSON.stringify(app.state().runState.supplier1688Pipeline.tasks)), oldPipeline.tasks);
    if (oldStatus === 'complete') assert.equal(app.state().products[0].purchaseCost, 8);
  });
}

test('an append failure retains the old task and shows its cause without resuming matching', async () => {
  const fixture = harness(); const { app, calls, toasts } = fixture;
  const current = job('completed', 139);
  const base = snapshot(current, [imageCandidate(1), imageCandidate(2)]);
  base.runState.supplier1688Pipeline = { owner: 'server', status: 'complete', productIds: [productId], revision: 263, selectionId: 'original-selection' };
  app.restore(structuredClone(base)); app.view(null, 1, {}); app.setSupplierLoggedIn(true);
  fixture.respond(async (path, options) => {
    if (path === '/api/runs') return { runs: [] };
    if (path === '/api/amazon/collection/control') return current;
    if (path === `/api/runs/${runId}`) return structuredClone(base);
    if (path === '/api/1688/pipeline/control') {
      assert.equal(JSON.parse(options.body).action, 'append');
      throw Object.assign(new Error('Synthetic disk write failure'), { code: 'SNAPSHOT_WRITE_FAILED' });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  assert.equal(await app.startMatching(), false);
  assert.equal(calls.some(call => ['resume', 'discard'].includes(call.body?.action)), false);
  assert.equal(app.state().runState.supplier1688Pipeline.revision, 263);
  assert.equal(app.state().runState.supplier1688Pipeline.selectionId, 'original-selection');
  assert.ok(toasts.some(([message]) => message.includes('Synthetic disk write failure')));
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
  assert.equal(incomplete.salePrice, 9.99);
  assert.equal(incomplete.margin, null);
  assert.ok(incomplete.profitPendingReasons.includes("商品重量"));
  assert.equal(incomplete.fbaFee, 3.67);
  assert.equal(incomplete.fbaEstimate.weightSource, "页面未提供重量 · FBA 配送费按最低档估算");
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

test("default candidates and resumed matching require each product's own 50+ badge while preserving excluded history", () => {
  const { app } = harness();
  const eligible = [50, 100, 200, 1200].map((sales30, index) => imageCandidate(index + 1, { sales30 }));
  const unknown = { ...serverPricedSnapshot({ score: 0.98, count: 10 }).saved.products[0],
    id: "AU:B000000005", asin: "B000000005", sourceAsin: "B000000005", sales30: null, sales30Evidence: null };
  const numericOnly = imageCandidate(6, { sales30: 100, sales30Evidence: null });
  const otherAsin = imageCandidate(7, { sales30Evidence: eligible[0].sales30Evidence });
  const items = [...eligible, unknown, numericOnly, otherAsin];
  app.restore(snapshot(job("completed"), items));
  app.setPipeline({ productIds: items.map(product => product.id), status: "paused", owner: "server" });
  assert.deepEqual(Array.from(app.filtered(), item => item.id), eligible.map(item => item.id));
  assert.deepEqual(Array.from(app.matching(), item => item.id), eligible.map(item => item.id));
  assert.deepEqual(Array.from(app.pending(), item => item.id), eligible.map(item => item.id));
  assert.equal(app.state().products.length, 7);
  const preserved = app.state().products.find(item => item.id === unknown.id);
  assert.equal(preserved.purchaseCost, unknown.purchaseCost);
  assert.deepEqual(structuredClone(preserved.suppliers), unknown.suppliers);
});

test("a completed server response never claims matching continued and explains sales exclusions", async () => {
  const fixture = harness();
  const item = imageCandidate(1, { supplierSearchStatus: "session_expired" });
  fixture.app.restore(supplierSnapshot(supplierPipeline({ status: "paused", enabled: false }), [item]));
  const complete = supplierPipeline({ status: "complete", enabled: false, remaining: 0, processed: 0, excludedMonthlySalesCount: 43, revision: 2 });
  fixture.respond(async path => path === '/api/1688/pipeline/control' ? complete : supplierSnapshot(complete, [{ ...item, sales30: null, sales30Evidence: null }]));
  assert.equal(await fixture.app.resumeSupplier(), false);
  assert.equal(fixture.toasts.some(([, severity]) => severity === 'success'), false);
  assert.match(fixture.toasts.at(-1)[0], /43.*50\+/);
  assert.equal(fixture.toasts.at(-1)[1], 'info');
  assert.equal(fixture.app.pending().length, 0);
  assert.equal(fixture.element('matchFiltered1688Button').disabled, true);
  assert.match(fixture.element('supplierBatchSummary').textContent, /43.*已跳过/);
  const callCount = fixture.calls.length;
  assert.equal(await fixture.app.resumeSupplier(), false);
  assert.equal(fixture.calls.length, callCount);
});

test("server no-pending rejection refreshes stale state and preserves its actionable explanation", async () => {
  const fixture = harness();
  const item = imageCandidate(1, { supplierSearchStatus: 'session_expired' });
  fixture.app.restore(supplierSnapshot(supplierPipeline({ status: 'paused', enabled: false }), [item]));
  const complete = supplierPipeline({ status: 'complete', remaining: 0, enabled: false, excludedMonthlySalesCount: 43, revision: 2 });
  fixture.respond(async path => {
    if (path === '/api/1688/pipeline/control') throw Object.assign(new Error('43 个商品已跳过，请刷新页面。'), { code: 'SUPPLIER_NO_PENDING_PRODUCTS' });
    return supplierSnapshot(complete, [{ ...item, sales30Evidence: null }]);
  });
  assert.equal(await fixture.app.resumeSupplier(), false);
  assert.equal(fixture.toasts.at(-1)[1], 'info');
  assert.match(fixture.toasts.at(-1)[0], /43.*刷新页面/);
  assert.equal(fixture.app.state().runState.supplier1688Pipeline.status, 'complete');
});

test("a paused or attention response cannot show the background matching success toast", async () => {
  for (const status of ['paused', 'needs_attention']) {
    const fixture = harness();
    const item = imageCandidate();
    fixture.app.restore(supplierSnapshot(supplierPipeline({ status: 'paused', enabled: false }), [item]));
    const paused = supplierPipeline({ status, remaining: 1, enabled: false, message: '请先完成验证，原断点保留。', revision: 2 });
    fixture.respond(async path => path === '/api/1688/pipeline/control' ? paused : supplierSnapshot(paused, [item]));
    assert.equal(await fixture.app.resumeSupplier(), false);
    assert.equal(fixture.toasts.at(-1)[1], 'info');
    assert.match(fixture.toasts.at(-1)[0], /验证/);
  }
});

test("a cooldown resume response reports waiting rather than active image matching", async () => {
  const fixture = harness();
  const item = imageCandidate();
  fixture.app.restore(supplierSnapshot(supplierPipeline({ status: 'paused', enabled: false }), [item]));
  const cooling = supplierPipeline({ status: 'cooldown', remaining: 1, enabled: true, revision: 2 });
  fixture.respond(async path => path === '/api/1688/pipeline/control' ? cooling : supplierSnapshot(cooling, [item]));
  assert.equal(await fixture.app.resumeSupplier(), true);
  assert.equal(fixture.toasts.at(-1)[1], 'info');
  assert.match(fixture.toasts.at(-1)[0], /冷却/);
});

function pageWithoutWeight(overrides = {}) {
  return { ...canonicalProduct(), productWeight: null, fbaWeight: null, billingWeight: null,
    manualFbaFee: false, fbaFee: null,
    collectionQuality: { fields: { weight: { status: "unavailable", reason: "page_not_provided" } } },
    profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: null }, ...overrides };
}

test("confirmed absent weight uses minimum FBA and can be reviewed without fabricating weight or profit", () => {
  const { app, element, toasts } = harness();
  const original = pageWithoutWeight();
  app.restore(snapshot(job("completed"), [original]));
  const restoredSuppliers = structuredClone(app.state().products[0].suppliers);
  app.openLocalDrawer(productId);
  assert.equal(element("editWeight").value, "");
  assert.equal(Number(element("editFbaFee").value), 4.58);
  assert.equal(element("approveProductButton").disabled, false);
  assert.match(element("costBreakdown").innerHTML, /最低档/);
  app.approve();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "approved");
  assert.equal(product.billingWeight, null);
  assert.equal(product.productWeight, null);
  assert.equal(product.profitInputs.actualWeightKg, null);
  assert.equal(product.profitCalculation, null);
  assert.equal(product.margin, null);
  assert.equal(product.salePrice, original.salePrice);
  assert.equal(product.purchaseCost, original.purchaseCost);
  assert.deepEqual(structuredClone(product.suppliers), restoredSuppliers);
  assert.match(toasts.at(-1)[0], /初审通过.*最低档估算/);
});

test("candidate initial review may precede purchase quotes and price collection", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight({ currentPrice: null, currentPriceStatus: "unavailable", salePrice: null,
    manualSalePrice: false, purchaseCost: null, purchaseUnitCostCny: null, manualPurchaseCost: false,
    supplierSearchStatus: "not_started", suppliers: [] })]));
  app.view(productId, 1, {});
  assert.equal(app.filtered().length, 1);
  app.openLocalDrawer(productId);
  assert.equal(element("approveProductButton").disabled, false);
  app.approve();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "approved");
  assert.equal(product.salePrice, null);
  assert.equal(product.purchaseCost, null);
  assert.equal(product.manualPurchaseCost, false);
});

for (const status of ["pending", "failed"]) test(status + " detail does not qualify as page weight absence", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("paused"), [pageWithoutWeight({ detailStatus: status })]));
  app.openLocalDrawer(productId);
  assert.equal(element("approveProductButton").disabled, true);
  assert.equal(app.state().products[0].fbaFee, null);
  app.approve();
  assert.equal(app.state().products[0].reviewStatus, "pending");
});

for (const raw of ["0", "-1", "oops"]) test("invalid weight " + raw + " cannot pass initial review", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight()]));
  app.openLocalDrawer(productId);
  element("editWeight").value = raw;
  app.approve();
  assert.equal(app.state().products[0].reviewStatus, "pending");
  assert.equal(app.state().products[0].billingWeight, null);
});

test("missing sales evidence blocks initial review even when weight is absent", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight({ sales30Evidence: null })]));
  app.openLocalDrawer(productId);
  assert.equal(element("approveProductButton").disabled, true);
  app.approve();
  assert.equal(app.state().products[0].reviewStatus, "pending");
});

test("unknown weight is not presented as a real low-weight band", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight()]));
  app.view(null, 1, {});
  assert.equal(app.filtered().length, 1);
  element("resultWeightBand").value = "under_100";
  assert.equal(app.filtered().length, 0);
});

test("manual cost dialog also permits confirmed missing weight and preserves manual sale price", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight()]));
  app.openLocalDrawer(productId);
  app.openManual();
  assert.equal(element("manualCostApproveButton").disabled, false);
  app.approveManual();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "approved");
  assert.equal(product.billingWeight, null);
  assert.equal(product.salePrice, 18);
  assert.equal(product.manualSalePrice, true);
  assert.equal(product.fbaFee, 4.58);
});

for (const raw of ["0", "-1", "oops"]) test("manual dialog rejects invalid weight " + raw, () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight()]));
  app.openLocalDrawer(productId);
  app.openManual();
  element("manualActualWeightKg").value = raw;
  app.approveManual();
  assert.equal(app.state().products[0].reviewStatus, "pending");
  assert.equal(app.state().products[0].billingWeight, null);
  assert.match(element("manualCostError").textContent, /实际重量/);
});

test("manual dialog can approve before price and procurement quotes exist", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight({ currentPrice: null, currentPriceStatus: "unavailable", salePrice: null,
    manualSalePrice: false, purchaseCost: null, purchaseUnitCostCny: null, manualPurchaseCost: false,
    supplierSearchStatus: "not_started", suppliers: [] })]));
  app.openLocalDrawer(productId);
  app.openManual();
  assert.equal(element("manualCostApproveButton").disabled, false);
  app.approveManual();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "approved");
  assert.equal(product.purchaseCost, null);
  assert.equal(product.manualPurchaseCost, false);
  assert.equal(product.profitCalculation, null);
});

test("legacy candidate mapping and refresh retain distinct weight evidence and audit", () => {
  const { app } = harness();
  app.restore(snapshot(job("completed")));
  const incoming = { asin: "B000000002", marketplace: "AU", detailStatus: "success", detailParserVersion: 6,
    title: "Weight evidence product", productWeightKg: 0.2, fbaPackageWeightKg: 0.3,
    productWeightEvidence: { kind: "item", rawText: "Item Weight: 200 g", value: 0.2 },
    packageWeightEvidence: { kind: "package", rawText: "Package Weight: 300 g", value: 0.3 },
    collectionQuality: { fields: { weight: { status: "verified" } } } };
  const mapped = app.mapCandidate(incoming, 0);
  assert.deepEqual(structuredClone(mapped.productWeightEvidence), incoming.productWeightEvidence);
  assert.deepEqual(structuredClone(mapped.packageWeightEvidence), incoming.packageWeightEvidence);
  assert.deepEqual(structuredClone(mapped.collectionQuality), incoming.collectionQuality);
  app.mergeCandidates([incoming]);
  incoming.productWeightKg = 0.25;
  incoming.productWeightEvidence = { kind: "item", rawText: "Item Weight: 250 g", value: 0.25 };
  app.mergeCandidates([incoming]);
  const updated = app.state().products.find(item => item.asin === incoming.asin);
  assert.equal(updated.productWeight, 0.25);
  assert.deepEqual(structuredClone(updated.productWeightEvidence), incoming.productWeightEvidence);
  assert.deepEqual(structuredClone(updated.packageWeightEvidence), incoming.packageWeightEvidence);
});

test("manual dialog cannot approve a manually changed monthly count using the old badge", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight()]));
  app.openLocalDrawer(productId);
  app.openManual();
  element("manualAmazonSales30").value = "20";
  app.approveManual();
  assert.equal(app.state().products[0].reviewStatus, "pending");
  assert.equal(app.state().products[0].sales30, 100);
  assert.match(element("manualCostError").textContent, /50\+/);
});

test("a real manual weight replaces the minimum FBA assumption with an ordinary weight fee", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight()]));
  app.openLocalDrawer(productId);
  element("editWeight").value = "0.2";
  app.approve();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "approved");
  assert.equal(product.fbaFee, 5.26);
  assert.equal(product.fbaFeeSource, "au_standard_envelope_price_rate");
  assert.equal(product.fbaEstimate.assumption, "standard_envelope_dimensions_assumed");
  assert.equal(product.profitInputs.actualWeightKg, 0.2);
  assert.ok(Number.isFinite(product.margin));
});

test("US manual dialog retains its minimum fee when page weight is unavailable", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight({ marketplace: "US" })]));
  app.openLocalDrawer(productId);
  app.openManual();
  assert.equal(Number(element("manualFulfillmentFee").value), 3.22);
  app.approveManual();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "approved");
  assert.equal(product.fbaFee, 3.22);
  assert.equal(product.billingWeight, null);
});

test("newly collected monthly evidence makes a saved no-badge product eligible", () => {
  const { app } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight({ sales30: null, sales30Evidence: null })]));
  assert.equal(app.filtered().length, 0);
  app.mergeCandidates([{ asin: "B000000001", marketplace: "AU", detailStatus: "success", detailParserVersion: 6,
    sales30: 100, sales30Evidence: canonicalProduct().sales30Evidence }]);
  assert.equal(app.filtered().length, 1);
  assert.deepEqual(structuredClone(app.state().products[0].sales30Evidence), canonicalProduct().sales30Evidence);
});

test("saving an incomplete handoff draft preserves missing fields without approving", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight({ currentPrice: null, currentPriceStatus: "unavailable", salePrice: null,
    manualSalePrice: false, purchaseCost: null, purchaseUnitCostCny: null, manualPurchaseCost: false,
    supplierSearchStatus: "not_started", suppliers: [] })]));
  app.openLocalDrawer(productId);
  app.openManual();
  element("manualAmazonTitle").value = "Updated draft title";
  app.saveManualDraft();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "pending");
  assert.equal(product.name, "Updated draft title");
  assert.equal(product.purchaseCost, null);
  assert.equal(product.profitCalculation, null);
});

test("saving changed manual sales archives the old badge without retaining candidate eligibility", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight()]));
  app.openLocalDrawer(productId);
  app.openManual();
  element("manualAmazonSales30").value = "20";
  app.saveManualDraft();
  const product = app.state().products[0];
  assert.equal(product.sales30, 20);
  assert.equal(product.sales30Evidence, null);
  assert.equal(product.sales30EvidenceHistory[0].value, 100);
  assert.equal(app.filtered().length, 0);
});

function automaticCostFixture(overrides = {}) {
  const { saved, result } = serverPricedSnapshot({ score: 0.98, count: 10 });
  Object.assign(saved.products[0], overrides);
  const fixture = harness();
  fixture.app.restore(saved, { persistMigrations: false });
  fixture.app.openLocalDrawer(productId);
  return { ...fixture, supplierResult: result };
}

for (const route of ["drawer", "manual"]) {
  test(route + " initial review defaults to the saved 1688 average when purchase input is empty", () => {
    const { app, element } = automaticCostFixture({ purchaseUnitCostCny: null, purchaseCost: null });
    const average = app.state().products[0].supplierAverageCny;
    const quotes = structuredClone(app.state().products[0].suppliers);
    if (route === "manual") {
      app.openManual();
      element("manualPurchaseCost").value = "";
      app.manualPreview();
      assert.equal(Number(element("manualPurchaseTotal").value), average);
      assert.match(element("manualPurchaseCostSource").textContent, /默认使用 1688/);
      app.approveManual();
    } else {
      element("editPurchaseCost").value = "";
      app.preview();
      assert.equal(app.editor().purchaseUnitCostCny, average);
      assert.match(element("editPurchaseCostSource").textContent, /默认使用 1688/);
      app.approve();
    }
    const product = app.state().products[0];
    assert.equal(product.reviewStatus, "approved");
    assert.equal(product.purchaseUnitCostCny, average);
    assert.equal(product.purchaseCost, average);
    assert.equal(product.profitCalculation.purchaseCostCny, average);
    assert.equal(product.profitCalculation.purchaseCostAssumedZero, false);
    assert.equal(product.manualPurchaseCost, false);
    assert.notEqual(product.costSource, "manual");
    assert.deepEqual(structuredClone(product.suppliers), quotes);
  });

  test(route + " unchanged precise average is never converted into a manual override", () => {
    const { app } = automaticCostFixture({ supplierAverageCny: 3.14159, purchaseUnitCostCny: null, purchaseCost: null, pieceCount: 3, pieceCountSource: "manual" });
    if (route === "manual") { app.openManual(); app.approveManual(); }
    else app.approve();
    const product = app.state().products[0];
    assert.equal(product.reviewStatus, "approved");
    assert.equal(product.purchaseUnitCostCny, 3.14159);
    assert.equal(product.purchaseCost, 9.42);
    assert.equal(product.manualPurchaseCost, false);
    assert.notEqual(product.costSource, "manual");
  });

  for (const unit of [0, 2.34567]) test(route + " manual price " + unit + " survives reload and later supplier results", () => {
    const { app, element, supplierResult } = automaticCostFixture({ pieceCount: 3, pieceCountSource: "manual" });
    const originalAverage = app.state().products[0].supplierAverageCny;
    const quotes = structuredClone(app.state().products[0].suppliers);
    if (route === "manual") {
      app.openManual(); element("manualPurchaseCost").value = String(unit); app.manualPreview();
      assert.equal(Number(element("manualPurchaseTotal").value), Math.round(unit * 3 * 100) / 100);
      app.approveManual();
    } else {
      element("editPurchaseCost").value = String(unit); app.preview();
      assert.equal(app.editor().purchaseCost, Math.round(unit * 3 * 100) / 100);
      assert.match(element("costBreakdown").innerHTML, /人工单价/);
      assert.doesNotMatch(element("costBreakdown").innerHTML, /÷ 6 家/);
      app.approve();
    }
    const product = app.state().products[0];
    assert.equal(product.reviewStatus, "approved");
    assert.equal(product.manualPurchaseCost, true);
    assert.equal(product.costSource, "manual");
    assert.equal(product.purchaseUnitCostCny, unit);
    assert.equal(product.purchaseCost, Math.round(unit * 3 * 100) / 100);
    assert.equal(product.profitCalculation.purchaseCostCny, product.purchaseCost);
    if (route === "manual") assert.equal(Number(element("manualCostSalePrice").value), product.salePrice);
    const restarted = harness().app;
    restarted.restore(app.capture(), { persistMigrations: false });
    const reloaded = restarted.state().products[0];
    restarted.applySupplierResult(reloaded, { ...supplierResult, averageCostCny: 99 });
    assert.equal(reloaded.purchaseUnitCostCny, unit);
    assert.equal(reloaded.purchaseCost, product.purchaseCost);
    assert.equal(reloaded.manualPurchaseCost, true);
    assert.equal(reloaded.supplierAverageCny, originalAverage);
    assert.deepEqual(structuredClone(reloaded.suppliers), quotes);
  });

  for (const raw of ["-1", "invalid"]) test(route + " invalid manual procurement price cannot silently use the average", () => {
    const { app, element } = automaticCostFixture();
    const before = app.state().products[0].purchaseCost;
    if (route === "manual") { app.openManual(); element("manualPurchaseCost").value = raw; app.approveManual(); }
    else { element("editPurchaseCost").value = raw; app.approve(); }
    assert.equal(app.state().products[0].reviewStatus, "pending");
    assert.equal(app.state().products[0].purchaseCost, before);
    assert.equal(app.state().products[0].manualPurchaseCost, false);
  });
}

test("an untouched open input follows a newer average without becoming a manual override", () => {
  const { app } = automaticCostFixture();
  app.state().products[0].supplierAverageCny = 7.25;
  app.preview();
  assert.equal(app.editor().purchaseUnitCostCny, 7.25);
  app.approve();
  assert.equal(app.state().products[0].purchaseUnitCostCny, 7.25);
  assert.equal(app.state().products[0].manualPurchaseCost, false);
});

for (const marker of [{ costSource: "manual" }, { supplierSource: "manual-product-cost" }]) test("legacy manual purchase marker remains authoritative with an empty input", () => {
  const { app, element, supplierResult } = automaticCostFixture({ ...marker, manualPurchaseCost: false, purchaseUnitCostCny: 2, purchaseCost: 2 });
  element("editPurchaseCost").value = "";
  app.approve();
  const product = app.state().products[0];
  assert.equal(product.purchaseUnitCostCny, 2);
  const before = structuredClone(product);
  app.applySupplierResult(product, supplierResult);
  assert.deepEqual(structuredClone(product), before);
});

for (const marker of [{ costSource: "manual" }, { supplierSource: "manual-product-cost" }]) test("legacy manual purchase markers skip frontend supplier matching", () => {
  const { app } = automaticCostFixture({ ...marker, manualPurchaseCost: false, purchaseUnitCostCny: 2, purchaseCost: 2, supplierSearchStatus: "pending" });
  assert.equal(app.matching().length, 0);
  assert.equal(app.pending().length, 0);
});

test("successive auto-saves can change a manual unit price back to the original displayed average", () => {
  const { app, element } = automaticCostFixture();
  const original = app.state().products[0].supplierAverageCny;
  element("editPurchaseCost").value = "7.25";
  assert.equal(app.saveEditor(false, { preserveEditor: true }), true);
  assert.equal(app.state().products[0].purchaseUnitCostCny, 7.25);
  element("editPurchaseCost").value = String(original);
  app.approve();
  const product = app.state().products[0];
  assert.equal(product.purchaseUnitCostCny, original);
  assert.equal(product.manualPurchaseCost, true);
  assert.equal(product.reviewStatus, "approved");
});


const editableProfitInputs = ["editSalePrice", "editPurchaseCost", "editPieceCount", "editPurchaseTotal", "editFbaFee", "editWeight"];

function editableProfitFixture(product = canonicalProduct(), collectionJob = job("completed")) {
  const fixture = harness();
  fixture.app.restore(snapshot(collectionJob, [product]), { persistMigrations: false });
  fixture.respond(async (path) => { assert.equal(path, "/api/runs"); return { runs: [] }; });
  fixture.app.openLocalDrawer(productId);
  fixture.app.bindEditor();
  return fixture;
}

const profitEditCases = [
  { id: "editSalePrice", raw: "25.50", field: "salePrice", value: 25.5, marker: "manualSalePrice" },
  { id: "editPurchaseCost", raw: "2.34567", field: "purchaseUnitCostCny", value: 2.34567, marker: "manualPurchaseCost" },
  { id: "editPieceCount", raw: "7", field: "pieceCount", value: 7, marker: "pieceCountSource", markerValue: "manual" },
  { id: "editPurchaseTotal", raw: "10", field: "purchaseCost", value: 10, marker: "manualPurchaseCost" },
  { id: "editFbaFee", raw: "7.35", field: "fbaFee", value: 7.35, marker: "manualFbaFee" },
  { id: "editWeight", raw: "0.25", field: "billingWeight", value: 0.25, marker: "manualBillingWeight" },
];

test("the six profit fields are editable markup with an explicit non-submit save button", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of editableProfitInputs) {
    const input = html.match(new RegExp('<input\\b[^>]*\\bid="' + id + '"[^>]*>'))?.[0];
    assert.ok(input, id);
    assert.doesNotMatch(input, /\breadonly\b|\bdisabled\b/, id);
  }
  assert.match(html, /<button[^>]*type="button"[^>]*id="saveProfitEditsButton"/);
});

for (const edit of profitEditCases) test(edit.id + " change auto-saves a manual value, updates profit and survives reload", async () => {
  const initial = { ...canonicalProduct(), pieceCount: 3, purchaseCost: 9 };
  const { app, element, fire, calls } = editableProfitFixture(initial);
  const originalQuotes = JSON.stringify(app.state().products[0].suppliers);
  element(edit.id).value = edit.raw;
  await fire(edit.id, "input");
  const preview = app.editor();
  if (edit.id === "editPurchaseTotal") assert.equal(preview.purchaseUnitCostCny, 10 / 3);
  await fire(edit.id, "change");
  await app.settleSaves();
  assert.ok(calls.length >= 1, "the real change handler must persist without clicking initial review");
  const saved = calls.at(-1).body;
  const product = saved.products[0];
  assert.equal(product[edit.field], edit.value);
  assert.equal(product[edit.marker], edit.markerValue ?? true);
  assert.equal(product.purchaseCost, pieceCount.calculatePieceAdjustedPurchaseCostCny(product.purchaseUnitCostCny, product.pieceCount));
  assert.equal(product.reviewStatus, "pending");
  assert.equal(product.currentPrice, initial.currentPrice, "our sale price must not overwrite the Amazon price");
  assert.equal(JSON.stringify(product.suppliers), originalQuotes);
  const expected = profitModel.calculateProductProfit({ ...product.profitInputs, salePrice: product.salePrice,
    purchaseCostCny: product.purchaseCost, fulfillmentMode: "FBA", fulfillmentFee: product.fbaFee, actualWeightKg: product.billingWeight });
  assert.ok(expected);
  assert.equal(product.margin, expected.margin);
  const reloaded = harness();
  reloaded.app.restore(saved, { persistMigrations: false });
  reloaded.app.openLocalDrawer(productId);
  const restored = reloaded.app.state().products[0];
  assert.equal(restored[edit.field], edit.value);
  assert.equal(restored[edit.marker], edit.markerValue ?? true);
  assert.equal(restored.margin, product.margin);
  if (edit.id === "editPurchaseTotal") {
    assert.equal(restored.purchaseUnitCostCny, 10 / 3);
    assert.equal(Number(reloaded.element("editPurchaseTotal").value), 10);
  }
});

for (const edit of profitEditCases) test(edit.id + " saves independently while other profit inputs and monthly evidence are missing", async () => {
  const initial = imageCandidate(1, { pieceCount: 3, pieceCountSource: "manual", fulfillmentMode: null,
    sales30: null, sales30Evidence: null });
  const { app, element, fire, calls } = editableProfitFixture(initial);
  element(edit.id).value = edit.raw;
  await fire(edit.id, "input");
  await fire(edit.id, "change");
  await app.settleSaves();
  assert.ok(calls.length >= 1, "an incomplete draft must save");
  const saved = calls.at(-1).body;
  assert.equal(saved.products[0][edit.field], edit.value);
  assert.equal(saved.products[0][edit.marker], edit.markerValue ?? true);
  assert.equal(saved.products[0].reviewStatus, "pending");
  const reloaded = harness().app;
  reloaded.restore(saved, { persistMigrations: false });
  assert.equal(reloaded.state().products[0][edit.field], edit.value);
  app.approve();
  assert.equal(app.state().products[0].reviewStatus, "pending", "saving a draft must not waive review requirements");
});

test("manual total conversion retains unit precision across later unit and quantity edits", async () => {
  const { app, element, fire } = editableProfitFixture({ ...canonicalProduct(), pieceCount: 3, purchaseCost: 9 });
  element("editPurchaseTotal").value = "10";
  await fire("editPurchaseTotal", "input");
  assert.equal(Number(element("editPurchaseCost").value), 10 / 3);
  assert.equal(await app.saveEditorToDisk(), true);
  element("editPieceCount").value = "7";
  await fire("editPieceCount", "input");
  assert.equal(Number(element("editPurchaseTotal").value), 23.33);
  assert.equal(await app.saveEditorToDisk(), true);
  assert.equal(app.state().products[0].purchaseUnitCostCny, 10 / 3);
  element("editPurchaseCost").value = "1.23456789";
  await fire("editPurchaseCost", "input");
  assert.equal(Number(element("editPurchaseTotal").value), 8.64);
  assert.equal(await app.saveEditorToDisk(), true);
  assert.equal(app.state().products[0].purchaseUnitCostCny, 1.23456789);
  const restarted = harness().app;
  restarted.restore(app.capture(), { persistMigrations: false });
  assert.equal(restarted.state().products[0].purchaseUnitCostCny, 1.23456789);
  assert.equal(restarted.state().products[0].purchaseCost, 8.64);
});

test("zero total and zero manual delivery fee remain deliberate manual inputs", async () => {
  const { app, element, fire } = editableProfitFixture();
  for (const id of ["editPurchaseTotal", "editFbaFee"]) { element(id).value = "0"; await fire(id, "input"); }
  assert.equal(await app.saveEditorToDisk(), true);
  const reloaded = harness().app;
  reloaded.restore(app.capture(), { persistMigrations: false });
  const product = reloaded.state().products[0];
  assert.equal(product.purchaseCost, 0);
  assert.equal(product.purchaseUnitCostCny, 0);
  assert.equal(product.fbaFee, 0);
  assert.equal(product.manualPurchaseCost, true);
  assert.equal(product.manualFbaFee, true);
});

for (const [id, raw] of [["editSalePrice", "0"], ["editPurchaseCost", "-1"], ["editPieceCount", "2.5"], ["editPurchaseTotal", "-3"], ["editFbaFee", "-2"], ["editWeight", "0"]]) {
  test(id + " invalid input cannot save or overwrite a previous value", async () => {
    const { app, element, fire, calls } = editableProfitFixture();
    const before = JSON.stringify(app.state().products);
    element(id).value = raw;
    await fire(id, "input");
    assert.equal(await app.saveEditorToDisk(), false);
    assert.equal(JSON.stringify(app.state().products), before);
    assert.equal(calls.length, 0);
    assert.match(element("profitEditorStatus").textContent, /未保存/);
  });
}

test("transient browser badInput does not clear the saved numeric value", async () => {
  const { app, element, fire, calls } = editableProfitFixture();
  element("editSalePrice").value = "";
  element("editSalePrice").validity = { badInput: true };
  await fire("editSalePrice", "input");
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(app.state().products[0].salePrice, 18);
  assert.equal(calls.length, 0);
});

test("an empty weight edit retains an existing manual weight while other edits save", async () => {
  const { app, element, fire } = editableProfitFixture({ ...canonicalProduct(), billingWeight: 0.25,
    manualBillingWeight: true, manualProfitInputs: true,
    profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: 0.25, weightSource: "product_manual" } });
  element("editWeight").value = "";
  await fire("editWeight", "input");
  element("editSalePrice").value = "22";
  await fire("editSalePrice", "input");
  assert.equal(await app.saveEditorToDisk(), true);
  assert.equal(app.state().products[0].billingWeight, 0.25);
  assert.equal(app.state().products[0].profitInputs.actualWeightKg, 0.25);
});

for (const status of ["queued", "running", "cooldown"]) test(status + " collection protects all six fields and explicit save", async () => {
  const { app, element, fire, calls } = editableProfitFixture(canonicalProduct(), job(status));
  for (const id of editableProfitInputs) assert.equal(element(id).disabled, true, id);
  assert.equal(element("saveProfitEditsButton").disabled, true);
  const before = JSON.stringify(app.state().products);
  element("editPurchaseTotal").value = "100";
  await fire("editPurchaseTotal", "input");
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(JSON.stringify(app.state().products), before);
  assert.equal(calls.length, 0);
});

for (const status of ["paused", "needs_attention"]) test(status + " fields unlock only after the active worker has stopped", () => {
  const collection = { ...job(status), workerActive: true };
  const { app, element } = editableProfitFixture(canonicalProduct(), collection);
  for (const id of editableProfitInputs) assert.equal(element(id).disabled, true, id);
  app.apply({ ...collection, workerActive: false });
  for (const id of editableProfitInputs) assert.equal(element(id).disabled, false, id);
  assert.equal(element("saveProfitEditsButton").disabled, false);
});

test("handed-off product and active supplier work retain six-field edit protection", async () => {
  for (const overrides of [{ analysisHandoff: { owner: "procurement" } }, { supplierSearchStatus: "searching" }]) {
    const { app, element, calls } = editableProfitFixture({ ...canonicalProduct(), ...overrides });
    Object.assign(app.state().products[0], overrides);
    app.render();
    for (const id of editableProfitInputs) assert.equal(element(id).disabled, true, id);
    assert.equal(element("saveProfitEditsButton").disabled, true);
    const before = JSON.stringify(app.state().products);
    element("editSalePrice").value = "100";
    assert.equal(await app.saveEditorToDisk(), false);
    assert.equal(JSON.stringify(app.state().products), before);
    assert.equal(calls.length, 0);
  }
});

test("a storage failure is shown as unsaved and the explicit save button retries the same edits", async () => {
  const fixture = editableProfitFixture();
  fixture.respond(async () => { throw new Error("Synthetic storage unavailable"); });
  fixture.element("editSalePrice").value = "23";
  await fixture.fire("editSalePrice", "input");
  assert.equal(await fixture.app.saveEditorToDisk(), false);
  assert.match(fixture.element("profitEditorStatus").textContent, /尚未保存/);
  fixture.respond(async () => ({ runs: [] }));
  await fixture.fire("saveProfitEditsButton", "click");
  assert.match(fixture.element("profitEditorStatus").textContent, /已保存/);
  assert.equal(fixture.calls.at(-1).body.products[0].salePrice, 23);
});


for (const edit of profitEditCases) test(edit.id + " survives a real drawer refresh after a stale save and retries against the new snapshot", async () => {
  const initial = { ...canonicalProduct(), pieceCount: 3, purchaseCost: 9 };
  const fixture = editableProfitFixture(initial);
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  const newer = snapshot(job("completed", 2), [{ ...initial, currentPrice: 12.55, reviews: 44,
    suppliers: [{ name: "New backend supplier", unitPriceCny: 4 }] }, imageCandidate(2)]);
  let rejectSave = true;
  fixture.respond(async (path) => {
    if (path === "/api/runs") {
      if (rejectSave) throw Object.assign(new Error("Newer collection revision"), { code: "STALE_COLLECTION_SNAPSHOT" });
      return { runs: [] };
    }
    assert.equal(path, `/api/runs/${runId}`);
    return structuredClone(newer);
  });
  element(edit.id).value = edit.raw;
  await fire(edit.id, "input");
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(Number(element(edit.id).value), Number(edit.raw));
  assert.equal(app.state().revision, 2);
  assert.equal(app.state().products[0].salePrice, 18, "pending edits must not replace the new canonical snapshot");
  assert.match(element("profitEditorStatus").textContent, /尚未保存/);
  assert.equal(calls.filter(call => call.path === "/api/runs").length, 1, "a conflict never replays the old snapshot automatically");
  rejectSave = false;
  assert.equal(await app.saveEditorToDisk(), true);
  const retried = calls.at(-1).body;
  assert.equal(retried.amazonCollectionRevision, 2);
  assert.equal(retried.products[0][edit.field], edit.value);
  assert.equal(retried.products[0][edit.marker], edit.markerValue ?? true);
  assert.equal(retried.products[0].currentPrice, 12.55);
  assert.equal(retried.products[0].reviews, 44);
  assert.equal(retried.products[0].suppliers[0].name, "New backend supplier");
  assert.equal(retried.products[1].id, imageCandidate(2).id);
  assert.match(element("profitEditorStatus").textContent, /已保存/);
});

test("a sale-only draft preserves new backend weight, automatic purchase average and untouched price fields", async () => {
  const initial = { ...serverPricedSnapshot({ score: 0.98, count: 10 }).saved.products[0], pieceCount: 2, pieceCountSource: "manual",
    manualFbaFee: false, fulfillmentModeSource: "amazon_product_page" };
  const fixture = editableProfitFixture(initial);
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  const newer = { ...initial, currentPrice: 19, productWeight: 0.35, billingWeight: 0.35, supplierAverageCny: 7.25,
    purchaseUnitCostCny: 7.25, purchaseCost: 14.5, suppliers: initial.suppliers.map(quote => ({ ...quote, name: "New automatic quote", unitPriceCny: 7.25, price: 7.25 })),
    profitInputs: { ...initial.profitInputs, actualWeightKg: 0.35 } };
  let rejectSave = true;
  fixture.respond(async (path) => {
    if (path === "/api/runs") {
      if (rejectSave) throw Object.assign(new Error("Newer collection revision"), { code: "STALE_COLLECTION_SNAPSHOT" });
      return { runs: [] };
    }
    return snapshot(job("completed", 2), [newer]);
  });
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(Number(element("editSalePrice").value), 23);
  assert.equal(Number(element("editWeight").value), 0.35);
  assert.equal(Number(element("editPurchaseCost").value), 7.25);
  assert.equal(Number(element("editPurchaseTotal").value), 14.5);
  rejectSave = false;
  assert.equal(await app.saveEditorToDisk(), true);
  const product = calls.at(-1).body.products[0];
  assert.equal(product.salePrice, 23);
  assert.equal(product.currentPrice, 19);
  assert.equal(product.billingWeight, 0.35);
  assert.equal(product.manualBillingWeight, undefined);
  assert.equal(product.purchaseUnitCostCny, 7.25);
  assert.equal(product.manualPurchaseCost, false);
  assert.equal(product.manualFbaFee, false);
  assert.equal(product.fbaFee, product.fbaEstimate.fee);
});

test("a total-cost draft rebases on a newer backend quantity without turning it into a manual quantity", async () => {
  const initial = { ...canonicalProduct(), name: "Blue clips Pack of 2", englishName: "Blue clips Pack of 2", pieceCountSource: "amazon_title" };
  const fixture = editableProfitFixture(initial);
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  fixture.respond(async (path) => {
    if (path === "/api/runs") throw Object.assign(new Error("Newer collection revision"), { code: "STALE_COLLECTION_SNAPSHOT" });
    return snapshot(job("completed", 2), [{ ...initial, name: "Blue clips Pack of 3", englishName: "Blue clips Pack of 3", pieceCount: 3, purchaseCost: 9 }]);
  });
  element("editPurchaseTotal").value = "10";
  await fire("editPurchaseTotal", "input");
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(Number(element("editPieceCount").value), 3);
  assert.equal(Number(element("editPurchaseTotal").value), 10);
  assert.equal(Number(element("editPurchaseCost").value), 10 / 3);
  fixture.respond(async () => ({ runs: [] }));
  assert.equal(await app.saveEditorToDisk(), true);
  const product = calls.at(-1).body.products[0];
  assert.equal(product.purchaseCost, 10);
  assert.equal(product.purchaseUnitCostCny, 10 / 3);
  assert.equal(product.pieceCount, 3);
  assert.equal(product.pieceCountSource, "amazon_title");
});

test("ordinary snapshot refreshes preserve pending input and clear its draft only after a successful save", async () => {
  const fixture = editableProfitFixture();
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  let newer = snapshot(job("completed", 2));
  fixture.respond(async (path) => path === "/api/runs" ? { runs: [] } : structuredClone(newer));
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  await app.refresh();
  assert.equal(Number(element("editSalePrice").value), 23);
  assert.equal(app.state().products[0].salePrice, 18);
  assert.equal(calls.some(call => call.path === "/api/runs"), false);
  assert.equal(await app.saveEditorToDisk(), true);
  newer = snapshot(job("completed", 3), [{ ...canonicalProduct(), salePrice: 25 }]);
  await app.refresh();
  assert.equal(Number(element("editSalePrice").value), 25, "saved draft must not override later backend changes");
});

test("a stale save cannot overwrite a newer input entered while its snapshot read is in flight", async () => {
  const fixture = editableProfitFixture();
  const { app, element, fire } = fixture;
  app.useRealDrawer();
  let releaseRead, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  fixture.respond(async (path) => {
    if (path === "/api/runs") throw Object.assign(new Error("Newer collection revision"), { code: "STALE_COLLECTION_SNAPSHOT" });
    readStarted();
    return new Promise(resolve => { releaseRead = resolve; });
  });
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  const saving = app.saveEditorToDisk();
  await started;
  element("editSalePrice").value = "27";
  await fire("editSalePrice", "input");
  releaseRead(snapshot(job("completed", 2)));
  assert.equal(await saving, false);
  assert.equal(Number(element("editSalePrice").value), 27);
  assert.notEqual(element("profitEditorStatus").dataset.state, "saved");
  fixture.respond(async () => ({ runs: [] }));
  assert.equal(await app.saveEditorToDisk(), true);
  assert.equal(fixture.calls.at(-1).body.products[0].salePrice, 27);
});

test("an older successful save does not clear newer pending input before a subsequent snapshot refresh", async () => {
  const fixture = editableProfitFixture();
  const { app, element, fire } = fixture;
  app.useRealDrawer();
  let releaseSave, saveStarted;
  const started = new Promise(resolve => { saveStarted = resolve; });
  fixture.respond(async () => {
    saveStarted();
    return new Promise(resolve => { releaseSave = resolve; });
  });
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  const saving = app.saveEditorToDisk();
  await started;
  element("editSalePrice").value = "27";
  await fire("editSalePrice", "input");
  releaseSave({ runs: [] });
  assert.equal(await saving, true);
  assert.notEqual(element("profitEditorStatus").dataset.state, "saved");
  fixture.respond(async () => snapshot(job("completed", 2), [{ ...canonicalProduct(), salePrice: 23 }]));
  await app.refresh();
  assert.equal(Number(element("editSalePrice").value), 27);
});

test("a pending conflict refresh never restores a former product draft into a different drawer", async () => {
  const fixture = editableProfitFixture();
  const { app, element, fire } = fixture;
  app.useRealDrawer();
  const second = { ...imageCandidate(2), manualSalePrice: true, salePrice: 31 };
  app.state().products.push(second);
  let releaseRead, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  fixture.respond(async (path) => {
    if (path === "/api/runs") throw Object.assign(new Error("Newer collection revision"), { code: "STALE_COLLECTION_SNAPSHOT" });
    readStarted();
    return new Promise(resolve => { releaseRead = resolve; });
  });
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  const saving = app.saveEditorToDisk();
  await started;
  app.openLocalDrawer(second.id);
  releaseRead(snapshot(job("completed", 2), [canonicalProduct(), second]));
  assert.equal(await saving, false);
  assert.equal(app.state().activeProductId, second.id);
  assert.equal(Number(element("editSalePrice").value), 31);
  assert.doesNotMatch(element("profitEditorStatus").textContent, /尚未保存/);
});

test("a draft restored after a conflict remains locked when the backend collection resumes", async () => {
  const fixture = editableProfitFixture();
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  fixture.respond(async (path) => {
    if (path === "/api/runs") throw Object.assign(new Error("Newer collection revision"), { code: "STALE_COLLECTION_SNAPSHOT" });
    return snapshot(job("running", 2));
  });
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(Number(element("editSalePrice").value), 23);
  for (const id of editableProfitInputs) assert.equal(element(id).disabled, true, id);
  assert.equal(element("saveProfitEditsButton").disabled, true);
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(calls.filter(call => call.path === "/api/runs").length, 1);
  assert.equal(app.state().products[0].salePrice, 18);
});


test("editing only quantity preserves the newer automatic unit price and its source after a conflict", async () => {
  const initial = serverPricedSnapshot({ score: 0.98, count: 10 }).saved.products[0];
  const fixture = editableProfitFixture(initial);
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  fixture.respond(async (path) => {
    if (path === "/api/runs") throw Object.assign(new Error("Newer collection revision"), { code: "STALE_COLLECTION_SNAPSHOT" });
    return snapshot(job("completed", 2), [{ ...initial, supplierAverageCny: 9, purchaseUnitCostCny: 9, purchaseCost: 9,
      suppliers: initial.suppliers.map(quote => ({ ...quote, unitPriceCny: 9, price: 9 })) }]);
  });
  element("editPieceCount").value = "7";
  await fire("editPieceCount", "input");
  assert.equal(await app.saveEditorToDisk(), false);
  assert.equal(Number(element("editPieceCount").value), 7);
  assert.equal(Number(element("editPurchaseCost").value), 9);
  assert.equal(Number(element("editPurchaseTotal").value), 63);
  fixture.respond(async () => ({ runs: [] }));
  assert.equal(await app.saveEditorToDisk(), true);
  const product = calls.at(-1).body.products[0];
  assert.equal(product.purchaseUnitCostCny, 9);
  assert.equal(product.purchaseCost, 63);
  assert.equal(product.manualPurchaseCost, false);
  assert.equal(product.pieceCountSource, "manual");
});

test("a snapshot racing a successful profit save cannot leave the canonical model with the old price", async () => {
  const fixture = editableProfitFixture();
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  let releaseSave, saveStarted, storedPrice = 18;
  const started = new Promise(resolve => { saveStarted = resolve; });
  fixture.respond(async (path) => {
    if (path !== "/api/runs") return snapshot(job("completed"), [{ ...canonicalProduct(), salePrice: storedPrice, reviews: storedPrice === 23 ? 45 : 33 }]);
    saveStarted();
    return new Promise(resolve => { releaseSave = resolve; });
  });
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  const saving = app.saveEditorToDisk();
  await started;
  await app.refresh();
  storedPrice = 23;
  releaseSave({ runs: [] });
  assert.equal(await saving, true);
  await app.settleSnapshots();
  assert.equal(Number(element("editSalePrice").value), 23);
  assert.equal(app.state().products[0].salePrice, 23);
  assert.equal(app.state().products[0].reviews, 45, "the deferred refresh catches up new backend fields");
  assert.equal(calls.filter(call => call.path === `/api/runs/${runId}`).length, 2, "one deferred read follows the discarded read");
  fixture.respond(async () => ({ runs: [] }));
  assert.equal(await app.save(), true);
  assert.equal(calls.at(-1).body.products[0].salePrice, 23);
});

test("a snapshot started before a profit save cannot arrive after success and roll back the edited price", async () => {
  const fixture = editableProfitFixture();
  const { app, element, fire, calls } = fixture;
  app.useRealDrawer();
  let releaseRead, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  fixture.respond(async (path) => {
    if (path === "/api/runs") return { runs: [] };
    readStarted();
    return new Promise(resolve => { releaseRead = resolve; });
  });
  const refreshing = app.refresh();
  await started;
  element("editSalePrice").value = "23";
  await fire("editSalePrice", "input");
  assert.equal(await app.saveEditorToDisk(), true);
  fixture.respond(async () => snapshot(job("completed"), [{ ...canonicalProduct(), salePrice: 23, reviews: 45 }]));
  releaseRead(snapshot(job("completed")));
  await refreshing;
  await app.settleSnapshots();
  assert.equal(Number(element("editSalePrice").value), 23);
  assert.equal(app.state().products[0].salePrice, 23);
  assert.equal(app.state().products[0].reviews, 45);
  assert.equal(calls.filter(call => call.path === `/api/runs/${runId}`).length, 2);
});


function automaticEnvelopeProduct(marketplace, salePrice, weight = 0.1) {
  return { ...canonicalProduct(), marketplace, sourceMarketplace: marketplace,
    currentPrice: salePrice, salePrice, manualSalePrice: true,
    productWeight: weight, billingWeight: weight, manualFbaFee: false, fbaFee: null,
    profitInputs: undefined };
}

test('Canadian fee displays cents but retains full precision through preview, unrelated edits, save and reload', async () => {
  const fee = (4.73 - 0.8) * 1.035;
  const { app, element, fire, calls } = editableProfitFixture(automaticEnvelopeProduct('CA', 13.99));
  assert.equal(element('editFbaFee').value, '4.07');
  assert.equal(app.editor().fulfillmentFee, fee);
  assert.equal(app.state().products[0].profitCalculation.fulfillmentFee, fee);
  element('editPieceCount').value = '3';
  await fire('editPieceCount', 'input');
  assert.equal(await app.saveEditorToDisk(), true);
  const saved = calls.at(-1).body;
  assert.equal(saved.products[0].fbaFee, fee);
  assert.equal(saved.products[0].manualFbaFee, false);
  const restarted = harness();
  restarted.app.restore(saved, { persistMigrations: false });
  restarted.app.openLocalDrawer(productId);
  assert.equal(restarted.element('editFbaFee').value, '4.07');
  assert.equal(restarted.app.editor().fulfillmentFee, fee);
  app.openManual();
  app.manualPreview();
  assert.equal(element('manualFulfillmentFee').value, '4.07');
  app.saveManualDraft();
  assert.equal(app.state().products[0].fbaFee, fee);
  assert.equal(app.state().products[0].manualFbaFee, false);
});

for (const [marketplace, before, after, expected] of [
  ['AU', 13, 13.01, 5.26], ['AU', 13.01, 13, 4.35],
  ['CA', 13.99, 14, 4.73 * 1.035], ['CA', 14, 13.99, (4.73 - 0.8) * 1.035],
]) test(marketplace + ' sale boundary updates exact automatic fee and retains an explicit manual override', async () => {
  const fixture = editableProfitFixture(automaticEnvelopeProduct(marketplace, before));
  const { app, element, fire } = fixture;
  element('editSalePrice').value = String(after);
  await fire('editSalePrice', 'input');
  assert.equal(app.editor().fulfillmentFee, expected);
  assert.equal(element('editFbaFee').value, expected.toFixed(2));
  assert.equal(await app.saveEditorToDisk(), true);
  assert.equal(app.state().products[0].fbaFee, expected);
  element('editFbaFee').value = '2.99';
  await fire('editFbaFee', 'input');
  assert.equal(await app.saveEditorToDisk(), true);
  element('editSalePrice').value = String(before);
  await fire('editSalePrice', 'input');
  assert.equal(await app.saveEditorToDisk(), true);
  assert.equal(app.state().products[0].fbaFee, 2.99);
  assert.equal(app.state().products[0].manualFbaFee, true);
});

test('confirmed missing weight follows the current price band and still permits preliminary approval', async () => {
  for (const [marketplace, before, after, expected] of [
    ['AU', 13, 13.01, 4.58], ['CA', 13.99, 14, 4.73 * 1.035],
  ]) {
    const initial = { ...automaticEnvelopeProduct(marketplace, before, null),
      collectionQuality: { fields: { weight: { status: 'unavailable', reason: 'page_not_provided' } } } };
    const { app, element, fire } = editableProfitFixture(initial);
    element('editSalePrice').value = String(after);
    await fire('editSalePrice', 'input');
    assert.equal(app.editor().fulfillmentFee, expected);
    assert.equal(element('editFbaFee').value, expected.toFixed(2));
    app.approve();
    const result = app.state().products[0];
    assert.equal(result.reviewStatus, 'approved');
    assert.equal(result.fbaFee, expected);
    assert.equal(result.billingWeight, null);
    assert.equal(result.profitCalculation, null);
  }
});


test('v9 migration retains preliminary approval unless the automatic fee really changes', () => {
  const cases = [
    { product: { ...canonicalProduct(), manualFbaFee: true, fbaFee: 2 }, status: 'approved', fee: 2 },
    { product: { ...canonicalProduct(), manualFbaFee: false, fbaFee: 2, fbaFeeSource: 'manual' }, status: 'approved', fee: 2 },
    { product: { ...automaticEnvelopeProduct('US', 13), fbaFee: 3.86 }, status: 'approved', fee: 3.86 },
    { product: { ...automaticEnvelopeProduct('AU', 13), fbaFee: 4.35 }, status: 'approved', fee: 4.35 },
    { product: { ...automaticEnvelopeProduct('AU', 13.01), fbaFee: 4.35 }, status: 'pending', fee: 5.26 },
  ];
  for (const { product, status, fee } of cases) {
    product.reviewStatus = 'approved';
    product.profitInputs = { ...(product.profitInputs || canonicalProduct().profitInputs),
      formulaVersion: 'profit-workbook-au-weight-only-fba-v9' };
    const { app } = harness();
    app.restore(snapshot(job('completed'), [product]), { persistMigrations: false });
    const restored = app.state().products[0];
    assert.equal(restored.reviewStatus, status);
    assert.equal(restored.fbaFee, fee);
  }
});
