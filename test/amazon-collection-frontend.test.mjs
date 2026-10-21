import * as reviewRange from "../lib/review-range.mjs";
import * as listingDate from "../lib/amazon-listing-date.mjs";
import * as salesPolicy from "../lib/monthly-sales-policy.mjs";
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
import { recomputeProductProfit } from "../lib/product-profit-state.mjs";
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
  const calls = [], timers = [], toasts = [], events = [], exports = [];
  const preferences = new Map();
  let today = "2026-10-13";
  let respond = async (path) => { throw new Error(`Unexpected API request: ${path}`); };
  const context = vm.createContext({
    ...reviewRange, ...salesPolicy, ...priceState, ...listingDate, ...profitModel, ...pieceCount, ...handoff, ...coverage, ...detailRetry,
    todayDateOnly: () => today,
    document: { body: element("body"), documentElement: element("html"), addEventListener() {}, getElementById: element, querySelector: element, querySelectorAll() { return []; } },
    window: { sessionStorage: { getItem: key => preferences.has(key) ? preferences.get(key) : null, setItem: (key, value) => preferences.set(key, value) },
      crypto: { randomUUID: () => "new-synthetic-run" }, setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {},
      setInterval(callback, ms) { timers.push({ callback, ms, interval: true }); return timers.length; }, clearInterval() {}, confirm: () => true,
      EventSource: class { constructor(url) { this.url = url; events.push(this); } } },
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {}, requestAnimationFrame(callback) { callback(); }, structuredClone, AbortController, DOMException, URL,
    async fixtureApi(path, options = {}) { calls.push({ path, options, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body ?? null }); return respond(path, options); },
    fixtureToast: (...args) => toasts.push(args),
    fixtureSpreadsheet: async payload => { exports.push(structuredClone(payload)); return { savedFilePath: "synthetic.xlsx", embeddedImageCount: 0, missingImageCount: 0, failedImageCount: 0 }; },
  });
  const source = appSource.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/\}\)\(\);\s*$/, `
    const originalAvailability = updateStartAvailability;
    const originalCriteria = getSetupCriteria;
    const originalValidateCriteria = validateSetupCriteria;
    const originalStoreManager = renderStoreManager;
    const originalAudit = renderStoreAuditUi;
    const originalMarketUi = renderMarketUi;
    const originalResults = renderResults;
    renderMarketUi = renderStoreAuditUi = renderStoreManager = setImportStatus = resetStoreAuditUi = setDataMode = renderResults = renderRunCoverage = updateHistorySummary = updateStartAvailability = initIcons = restorePending1688RiskStatus = setStage = setProgress = hideProgressError = showProgressError = showView = scheduleRequested1688Resume = () => {};
    const activity = { recomputed: 0, rendered: 0 };
    const originalComputed = updateProductComputed;
    updateProductComputed = (...args) => { activity.recomputed += 1; return originalComputed(...args); };
    renderResults = () => { activity.rendered += 1; };
    const originalPopulateDrawer = populateDrawer;
    populateDrawer = (product) => { document.getElementById('drawerProductName').textContent = product.name; };
    apiRequest = fixtureApi;
    requestSpreadsheetExport = fixtureSpreadsheet;
    showToast = fixtureToast;
    delay = async () => {};
    getSetupCriteria = () => ({ useSellerSprite: false });
    validateSetupCriteria = () => null;
    globalThis.scout = {
      useRealMarketUi: () => { renderMarketUi = originalMarketUi; renderMarketUi(); },
      marketState: () => ({ activeMarket, taskExchangeRate }),
      checkAmazon: refreshAmazonConnection, checkSellerSprite: checkSellerSpriteConnection,
      setImportMode, importTaskSource,
      settleAsinPreview: async () => { while (asinPreviewPromise) await asinPreviewPromise; },
      setSelectedFile: file => { selectedStoreFile = file; },
      useRealCriteria: () => { getSetupCriteria = originalCriteria; validateSetupCriteria = originalValidateCriteria; },
      criteria: originalCriteria, validateCriteria: originalValidateCriteria, syncCriteria: syncAmazonResultCriteria,
      renderImports: () => { originalAudit(storeList?.audit); originalStoreManager(); },
      filterReasons: singleStoreFilterExclusionReasons,
      bindUpload: bindFileImport, bindResults, bindStoreManager, availability: originalAvailability, history: loadHistoryRun, workspace: loadPersistentWorkspace,
      importState: () => ({ importMode, storeList, runHistory, storeImportPending, taskReplacementPending, amazonCollectionJob, supplierPipelineState }),
      bindCollection: bindAmazonCollection, restore: restoreRunSnapshot, poll: pollAmazonCollection, run: runAnalysis, control: controlAmazonCollection,
      load: loadAmazonCollectionStatus, apply: applyAmazonCollectionJob, locked: isCollectionWriteLocked,
      save: persistCurrentRun, saveRequired: persistCurrentRunRequired, capture: captureRunSnapshot, render: renderAmazonCollection,
      scheduleResume: scheduleAmazonRunResume,
      startEvents: startSnapshotEvents, refresh: refreshAmazonCollectionSnapshot,
      settleSnapshots: async () => { while (amazonCollectionSnapshotPromise) await amazonCollectionSnapshotPromise; },
      loadSupplier: loadSupplierPipelineStatus, pollSupplier: poll1688Status,
      resumeSupplier: () => resumePending1688Candidates(), pauseSupplier: pauseServerSupplierPipeline,
      requestControl: requestTaskControl, resumeQueue: resume1688AfterVerification,
      applySession: (auth, queue) => apply1688SessionStatus(auth, queue),
      applySupplierResult: apply1688SearchResult, row: (id) => renderProductRow(products.find(product => product.id === id)),
      spreadsheet: (items, market = activeMarket.code) => createSpreadsheetExportPayload(items, MARKET_CONFIGS[market]),
      fetchLegacy: () => fetchProductCandidates(storeList.stores, runState.criteria, new AbortController().signal, () => {}),
      fetchProvider: () => fetchProductCandidates(storeList.stores, runState.criteria, new AbortController().signal, () => {}, { allowSellerSprite: true }),
      mutate: () => { approveActiveProduct(); rejectActiveProduct(); rematchActiveProduct(); saveManualCost(); commitProfitEdits(false); exportProducts(); exportAnalysisHandoff(); },
      approve: approveActiveProduct, saveEditor: commitProfitEdits, mapCandidate: mapCandidateProduct, mergeCandidates: mergeAnalyzedCandidateProducts,
      editor: getEditorValues, preview: renderProfitPreview, manualPreview: renderManualCostPreview,
      bindEditor: bindDrawer, saveEditorToDisk: saveProfitEditor, settleSaves: () => persistenceSaveQueue,
      useRealDrawer: () => { populateDrawer = originalPopulateDrawer; },
      openManual: openManualCostDialog, approveManual: () => saveManualCost({ approve: true }), saveManualDraft: () => saveManualCost({ allowIncomplete: true }),
      filtered: getFilteredProducts, matching: getAmazonFilteredProductsFor1688, pending: getPending1688ResumeProducts,
      dateFilters: bindSetupFilters, applyDate: applyAmazonListingDateFilter, dateCoverage: renderAmazonListingDateCoverage,
      exportRows: getExportProducts, exportAll: () => exportProducts("all"), exportApproved: () => exportProducts("approved"),
      exportCounts: syncExportMenuCounts, handoffSummary: renderAnalysisHandoffSummary,
      renderResults: originalResults, handoffInput: buildAnalysisHandoffInput, taskMode: currentTaskInputMode,
      mergeRecords: mergeCandidateRecords, setupCriteria: () => ({ useSellerSprite: false }),
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
      activity: () => ({ ...activity }),
      resetActivity: () => { activity.recomputed = 0; activity.rendered = 0; },
      setPendingProfitSaves: (value) => { profitEditorPendingSaves = value; if (!value) flushDeferredProfitEditorSnapshot(); },
    };
  })();`);
  vm.runInContext(source, context, { filename: "app.js" });
  return { app: context.scout, element, calls, timers, toasts, events, exports, preferences,
    setToday(value) { today = value; },
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

test("Amazon product clicks open the imported URL in Edge instead of navigating the current browser", async () => {
  const fixture = harness();
  const item = { ...canonicalProduct(), canonicalUrl: "https://www.amazon.com.au/dp/B000000001?th=1&psc=1#productDetails" };
  fixture.app.restore(snapshot(job("completed"), [item]));
  fixture.app.bindResults();
  const link = { dataset: {}, getAttribute: () => item.canonicalUrl };
  let prevented = false;
  const event = { target: { closest: selector => selector === "a.product-title-link" ? link : null },
    preventDefault() { prevented = true; } };
  fixture.respond(async (path, options) => {
    assert.equal(path, "/api/amazon/open-in-edge");
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).url, item.canonicalUrl);
    return { opened: true, browser: "edge" };
  });
  await fixture.element("productTableBody").listeners.click[0](event);
  assert.equal(prevented, true, "The ordinary/default browser navigation must be canceled.");
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.app.row(item.id), /href="microsoft-edge:https:\/\/www\.amazon\.com\.au\/dp\/B000000001\?th=1&amp;psc=1#productDetails"/);
  assert.equal(fixture.app.state().activeProductId, null);
});

test("an Edge-opening failure keeps default-browser navigation canceled and reports the failure", async () => {
  const fixture = harness();
  fixture.app.bindResults();
  const link = { dataset: {}, getAttribute: () => "https://www.amazon.com.au/dp/B09NXS1BLL?th=1" };
  let prevented = false;
  fixture.respond(async () => { throw new Error("未找到 Microsoft Edge"); });
  await fixture.element("productTableBody").listeners.click[0]({
    target: { closest: selector => selector === "a.product-title-link" ? link : null },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.toasts[0][0], /无法在 Edge 打开 Amazon.*未找到 Microsoft Edge/);
  assert.equal(link.dataset.openingEdge, undefined);
});

test("Amazon title preserves the original imported link even when the fetched page has another canonical URL", () => {
  const fixture = harness();
  const saved = snapshot(job("completed"));
  saved.products[0].canonicalUrl = 'https://www.amazon.com.au/dp/B000000001';
  saved.storeList.stores[0].productUrls = { B000000001: 'https://www.amazon.com.au/gp/aw/d/B000000001?th=1&psc=1#productDetails' };
  fixture.app.restore(saved);
  assert.match(fixture.app.row(productId), /data-amazon-url="https:\/\/www\.amazon\.com\.au\/gp\/aw\/d\/B000000001\?th=1&amp;psc=1#productDetails"/);
  saved.storeList.stores[0].productUrls.B000000001 = 'https://www.amazon.com.au/dp/B000000002?th=1';
  fixture.app.restore(saved);
  assert.match(fixture.app.row(productId), /data-amazon-url="https:\/\/www\.amazon\.com\.au\/dp\/B000000001"/);
});

test("removing an imported ASIN also removes its saved product URL while retaining other original links", async () => {
  const fixture = harness();
  const saved = snapshot(null, []);
  saved.storeList.inputMode = "asins";
  saved.storeList.stores[0].asins.push("B000000002");
  saved.storeList.stores[0].productUrls = {
    B000000001: "https://www.amazon.com.au/dp/B000000001?th=1",
    B000000002: "https://www.amazon.com.au/gp/product/B000000002?psc=1",
  };
  fixture.app.restore(saved);
  fixture.app.bindStoreManager();
  const button = { dataset: { removeAsin: "B000000001" }, disabled: false };
  fixture.element("currentStoreList").closest = selector => selector === "[data-remove-asin]" ? button : null;
  await fixture.fire("currentStoreList", "click");
  const source = fixture.app.importState().storeList.stores[0];
  assert.deepEqual(Array.from(source.asins), ["B000000002"]);
  assert.deepEqual({ ...source.productUrls }, { B000000002: "https://www.amazon.com.au/gp/product/B000000002?psc=1" });
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

test("retained numeric quote shows pending verification and original observation time in row and drawer", () => {
  const { app, element } = harness();
  const item = { ...canonicalProduct(), currentPrice: 14.99, currentPriceStatus: 'pending_revalidation',
    priceVerifiedAt: '2026-10-20T01:31:27.910Z',
    priceRefresh: { status: 'pending', retained: true, reason: 'price_requires_cart' },
    collectionQuality: { fields: { price: { status: 'unavailable', reason: 'price_requires_cart' } } } };
  app.restore(snapshot(job('completed'), [item]));
  const html = app.row(item.id);
  assert.match(html, /14\.99/);
  assert.match(html, /上次核验报价 · 本次待复核/);
  assert.match(html, /09:31:27/);
  app.openLocalDrawer(item.id);
  assert.match(element('amazonMetrics').innerHTML, /上次核验报价 · 本次待复核/);
});

test("candidate rows show the exact failed ASIN reason and keep prior verified data untouched", () => {
  const { app, element, calls } = harness();
  const product = { ...canonicalProduct(), collectionLastAttempt: { status: "failed", code: "AMAZON_PRODUCT_ASIN_MISMATCH", message: "Amazon specification table belongs to another ASIN." } };
  app.restore(snapshot(job("completed"), [product]));
  const row = app.row(productId);
  assert.match(row, /Amazon 采集失败：旧版 ASIN 校验未通过，待按新规则重新采集/);
  assert.match(row, /AMAZON_PRODUCT_ASIN_MISMATCH/);
  assert.match(row, /本轮已结束/);
  assert.doesNotMatch(row, /待自动补查|已排队重新查找/);
  app.openLocalDrawer(productId);
  assert.match(element("amazonMetrics").innerHTML, /Amazon 采集说明/);
  assert.match(element("amazonMetrics").innerHTML, /旧版 ASIN 校验未通过，待按新规则重新采集/);
  assert.equal(app.state().products[0].productWeight, product.productWeight);
  assert.equal(app.state().products[0].currentPrice, product.currentPrice);
  assert.equal(calls.length, 0);
});

test("candidate rows distinguish unresolved weight conflict from incomplete information inspection", () => {
  for (const [reason, label] of [["conflicting_values", "重量值冲突"], ["inspection_timeout", "商品信息区检查超时"]]) {
    const { app, element } = harness();
    app.restore(snapshot(job("completed"), [imageCandidate(1, {
      detailStatus: "success", detailParserVersion: 11, currentPrice: 30, currentPriceStatus: "verified",
      collectionQuality: { fields: { weight: { status: "missing", reason: "product_information_incomplete", retryable: true } } },
      productInformation: { version: 1, asin: "B000000001", status: "incomplete", weightStatus: "unresolved", reason, inspection: { reason: "inspection_timeout" } },
    })]));
    const row = app.row(productId);
    assert.ok(row.includes(label));
    assert.match(row, /Amazon 字段核验/);
    assert.doesNotMatch(row, /页面未提供重量/);
    assert.match(row, /上架日期待核验 · 商品信息区检查超时.*不影响利润计算/);
    app.openLocalDrawer(productId);
    assert.ok(element("amazonMetrics").innerHTML.includes(label));
    assert.equal(app.state().products[0].productWeight, null);
  }
});

test("captured disabled specifications show their precise unresolved cause without changing data or recovery", async () => {
  const captured = JSON.parse(await readFile(new URL("./fixtures/amazon-b09nxs1bll-disabled-specifications.json", import.meta.url), "utf8"));
  const { source: _source, ...recorded } = captured;
  const { app, element, calls } = harness();
  const item = { ...imageCandidate(1, { detailStatus: "success", currentPrice: 30, currentPriceStatus: "verified" }),
    ...recorded, id: `AU:${recorded.asin}`, sourceAsin: recorded.asin,
    manualSalePrice: true, salePrice: 31, manualPurchaseCost: true, purchaseCost: 8, purchaseUnitCostCny: 8,
    suppliers: [{ name: "Preserved manual quote", unitPriceCny: 8 }],
    collectionQuality: { fields: { weight: { status: "missing", reason: "product_information_incomplete", retryable: true } } },
  };
  app.restore(snapshot(job("completed"), [item]), { persistMigrations: false });
  const beforeRendering = JSON.stringify(app.state().products[0]);
  const row = app.row(item.id);
  assert.match(row, /重量：完整规格入口当前不可用，Item Weight 待核验/);
  assert.match(row, /2021-12-21/);
  assert.doesNotMatch(row, /上架日期待核验|页面未提供重量|商品信息区检查超时/);
  app.openLocalDrawer(item.id);
  assert.match(element("amazonMetrics").innerHTML, /完整规格入口当前不可用，Item Weight 待核验/);
  const restored = app.state().products[0];
  for (const key of ["productWeight", "productWeightEvidence", "amazonFirstAvailableDate", "amazonFirstAvailableDateStatus",
    "manualSalePrice", "salePrice", "manualPurchaseCost", "purchaseCost", "purchaseUnitCostCny"]) assert.equal(restored[key], item[key], key);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.collectionRecovery)), item.collectionRecovery);
  assert.equal(restored.suppliers[0].name, item.suppliers[0].name);
  assert.equal(restored.suppliers[0].unitPriceCny, item.suppliers[0].unitPriceCny);
  assert.equal(JSON.stringify(restored), beforeRendering);
  assert.equal(restored.productInformation.weightStatus, "unresolved");
  assert.equal(calls.length, 0);
});

test("disabled specifications explain unresolved dates only while the recorded entry remains unavailable", async () => {
  const { productInformation } = JSON.parse(await readFile(new URL("./fixtures/amazon-b09nxs1bll-disabled-specifications.json", import.meta.url), "utf8"));
  for (const changed of [null, { disabled: false }, { pending: false }, { visible: true }]) {
    const { app, calls } = harness();
    const info = structuredClone(productInformation);
    Object.assign(info.inspection.specifications, changed || {});
    app.restore(snapshot(job("completed"), [imageCandidate(1, {
      detailStatus: "success", detailParserVersion: 12, productInformation: info,
      amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: "unresolved",
      collectionQuality: { fields: { weight: { status: "missing", reason: "product_information_incomplete" } } },
    })]), { persistMigrations: false });
    const row = app.row(productId);
    assert.match(row, changed ? /上架日期待核验 · 商品信息区检查超时/ : /上架日期待核验 · 完整规格入口当前不可用/);
    assert.doesNotMatch(row, /Amazon 未提供上架日期|页面未提供重量/);
    if (changed) assert.doesNotMatch(row, /完整规格入口当前不可用/);
    assert.equal(calls.length, 0);
  }
});

test('legacy ASIN and weight failures explain the pending new-rule visit while retaining access pause and source errors', () => {
  for (const version of [9, 11]) {
    const { app, calls } = harness();
    const items = [
      imageCandidate(1, { detailParserVersion: version, detailStatus: 'failed',
        detailErrorCode: 'AMAZON_PRODUCT_ASIN_MISMATCH', detailError: 'Original ASIN diagnostic' }),
      imageCandidate(2, { detailParserVersion: version, detailStatus: 'success',
        collectionQuality: { fields: { weight: { status: 'missing', reason: 'product_information_incomplete' } } },
        productInformation: { status: 'incomplete', reason: 'conflicting_values' } }),
      imageCandidate(3, { detailParserVersion: version, detailStatus: 'failed',
        detailErrorCode: 'AMAZON_ACCESS_CHALLENGE', detailError: 'Original challenge diagnostic' }),
    ];
    app.restore(snapshot({ ...job('needs_attention'), causeCode: 'AMAZON_ACCESS_CHALLENGE' }, items), { persistMigrations: false });
    const asinRow = app.row(items[0].id), weightRow = app.row(items[1].id), challengeRow = app.row(items[2].id);
    assert.match(asinRow, version < 11 ? /旧版 ASIN 校验未通过，待按新规则重新采集/ : /上次采集记录的页面 ASIN 与输入不一致/);
    assert.match(weightRow, version < 11 ? /旧版重量核验未完成，待按 Item Weight 重新采集/ : /重量值冲突，尚未确认有效重量/);
    assert.match(asinRow, /AMAZON_PRODUCT_ASIN_MISMATCH/);
    assert.match(asinRow, /Original ASIN diagnostic/);
    assert.match(challengeRow, /验证码或访问验证，需人工处理/);
    for (const row of [asinRow, weightRow, challengeRow]) assert.match(row, /等待人工处理，已停止自动请求/);
    assert.equal(app.state().products[0].detailError, 'Original ASIN diagnostic');
    assert.equal(app.state().products[1].productInformation.reason, 'conflicting_values');
    assert.equal(calls.length, 0);
  }
});

test("candidate retry display follows per-product recovery, manual pauses and access challenges", () => {
  const fixtures = [
    { status: "cooldown", code: "AMAZON_REQUEST_TIMEOUT", recovery: { status: "scheduled", attempts: 1, maxAttempts: 2, nextRetryAt: "2026-10-14T07:00:00Z" }, expected: /页面访问超时.*待自动补查.*补查 1 \/ 2/ },
    { status: "completed", code: "AMAZON_REQUEST_TIMEOUT", recovery: { status: "exhausted", attempts: 2, maxAttempts: 2 }, expected: /页面访问超时.*自动补查已达上限（已补查 2 \/ 2 次）/ },
    { status: "completed", code: "AMAZON_REQUEST_TIMEOUT", recovery: { status: "waiting", attempts: 1, maxAttempts: 2, nextRetryAt: "2026-10-14T07:00:00Z" }, expected: /页面访问超时.*待自动补查/ },
    { status: "paused", code: "AMAZON_REQUEST_TIMEOUT", recovery: { status: "scheduled", attempts: 1 }, expected: /已暂停，保留当前结果/ },
    { status: "needs_attention", code: "AMAZON_ACCESS_CHALLENGE", recovery: { status: "blocked", attempts: 1 }, expected: /验证码或访问验证，需人工处理.*等待人工处理，已停止自动请求/ },
  ];
  for (const fixture of fixtures) {
    const { app, calls } = harness();
    app.restore(snapshot({ ...job(fixture.status), ...(fixture.recovery.status === "waiting" ? { enabled: true } : {}) }, [imageCandidate(1, {
      detailStatus: "failed", detailErrorCode: fixture.code, detailError: "Original detail failure", collectionRecovery: fixture.recovery,
    })]));
    const row = app.row(productId);
    assert.match(row, fixture.expected);
    if (fixture.status === "paused" || fixture.status === "needs_attention") assert.doesNotMatch(row, /待自动补查|已排队重新查找/);
    assert.equal(calls.length, 0);
  }
});

test("only inspected weight absence is shown as page-not-provided, never a stale absence audit", () => {
  const { app } = harness();
  app.restore(snapshot(job("completed"), [imageCandidate(1, {
    detailStatus: "success", collectionQuality: { fields: { weight: { status: "unavailable", reason: "page_not_provided", retryable: false } } },
    productInformation: { version: 1, asin: "B000000001", status: "incomplete", weightStatus: "not_provided", reason: "inspection_timeout" },
  })]));
  const row = app.row(productId);
  assert.match(row, /重量：商品信息区检查超时/);
  assert.doesNotMatch(row, /已完整检查，页面未提供重量/);
});

test("browser inspection failures retain their exact cause and date-only rechecks show the bounded status", () => {
  for (const [code, message, expected] of [
    ["EDGE_CDP_TIMEOUT", "CDP operation timed out", /浏览器检查超时/],
    ["AMAZON_EDGE_NAVIGATION_FAILED", "Browser navigation interrupted", /浏览器连接或页面导航失败/],
  ]) {
    const { app, element } = harness();
    app.restore(snapshot(job("cooldown"), [{ ...canonicalProduct(), amazonFirstAvailableDateStatus: "unresolved",
      collectionQuality: { fields: { weight: { status: "verified" }, price: { status: "verified" }, title: { status: "verified" }, image: { status: "verified" } } },
      collectionRecovery: { status: "scheduled", attempts: 1, maxAttempts: 2, nextRetryAt: "2026-10-14T07:00:00Z" },
      productInformation: { version: 1, asin: "B000000001", status: "incomplete", reason: "root_missing", inspection: {
        version: 2, asin: "B000000001", status: "incomplete", reason: "browser_inspection_failed", errorCode: code, errorMessage: message,
      } },
    }]));
    const row = app.row(productId);
    assert.match(row, expected);
    assert.match(row, /上架日期：.*待自动补查.*补查 1 \/ 2/);
    assert.ok(row.includes(code));
    assert.ok(row.includes(message));
    app.openLocalDrawer(productId);
    assert.ok(element("amazonMetrics").innerHTML.includes(code));
    assert.equal(app.state().products[0].productWeight, 0.1);
  }
});

test("per-product collection causes escape returned HTML and do not leak a different run's retry state", () => {
  const { app } = harness();
  app.restore(snapshot(job("completed"), [imageCandidate(1, {
    detailStatus: "failed", detailErrorCode: "AMAZON_UNKNOWN_FAILURE", detailError: '<img src=x onerror="alert(1)">',
  })]));
  app.apply({ ...job("running", 8), runId: "another-run", tasks: { B000000001: { status: "pending", attempts: 1 } } });
  const row = app.row(productId);
  assert.match(row, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(row, /<img src=x|已排队重新查找|待自动补查/);
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
    productInformation: productInformationWithoutWeight(),
    profitInputs: { ...pricedWithoutWeight.profitInputs, actualWeightKg: null, commissionRate: 9, marketingRate: 7, airFreightRateCnyPerKg: 52, airFreightRateSource: "product_manual" },
  });
  app.restore(snapshot(job("running", 1), [pricedWithoutWeight]));
  const incomplete = app.state().products[0];
  assert.equal(incomplete.salePrice, 9.99);
  assert.equal(incomplete.margin, null);
  assert.equal(incomplete.profitCalculation, null);
  assert.equal(incomplete.fbaFee, null);
  assert.equal(incomplete.fbaEstimate, null);
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

function amazonProductEvent(product, revision = 2, baseRevision = revision - 1) {
  return { runId, kind: "amazon_product", baseRevision, revision, products: [product],
    job: job("running", revision), runState: { mode: "live", completedAt: null }, formulaVersion: profitModel.PROFIT_FORMULA_VERSION };
}
function emitSnapshotEvent(events, update) { events[0].onmessage({ data: JSON.stringify(update) }); }

test("Amazon product events display canonical profit immediately and preserve untouched products and the current view", async () => {
  const { app, calls, events, element } = harness();
  app.restore(snapshot(job(), [canonicalProduct(), imageCandidate(2)]));
  const untouched = app.state().products[1];
  app.view(productId, 3, { minRating: 4.5, minReviews: 20 });
  element("resultSearch").value = "manual search";
  element("resultMinMargin").value = "25";
  element("resultsCompleteToggle").checked = true;
  element(".view-stack").scrollTop = 730; element(".drawer-content").scrollTop = 221;
  const next = recomputeProductProfit({ ...canonicalProduct(), name: "Fresh canonical product", productWeight: 0.8, billingWeight: 0.8,
    manualFbaFee: false, fbaFee: null, profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: 0.8 } });
  app.startEvents(); app.resetActivity();
  emitSnapshotEvent(events, amazonProductEvent(next));
  const state = app.state();
  assert.equal(state.revision, 2);
  assert.equal(state.runState.amazonCollectionJob.revision, 2);
  assert.equal(state.runState.amazonCollectionRevision, 2);
  assert.equal(state.products[0].margin, next.margin);
  assert.equal(state.products[0].fbaFee, next.fbaFee);
  assert.equal(state.products[0].billingWeight, 0.8);
  assert.strictEqual(state.products[1], untouched);
  assert.equal(app.activity().recomputed, 0, "canonical event data must not recompute all products");
  assert.equal(app.activity().rendered, 1);
  assert.equal(element("drawerProductName").textContent, "Fresh canonical product");
  assert.equal(state.activeProductId, productId); assert.equal(state.resultPage, 3);
  assert.equal(state.activeRunCriteria.minRating, 4.5);
  assert.equal(element("resultSearch").value, "manual search");
  assert.equal(element("resultMinMargin").value, "25");
  assert.equal(element("resultsCompleteToggle").checked, true);
  assert.equal(element(".view-stack").scrollTop, 730); assert.equal(element(".drawer-content").scrollTop, 221);
  assert.equal(calls.length, 0, "a contiguous event neither fetches a full snapshot nor writes it back");
  assert.match(app.row(productId), /FBA 封顶估算/);
});

for (const status of ["paused", "needs_attention", "completed"]) {
  test(`${status} product event preserves the known running worker until a status read confirms it stopped`, async () => {
    const fixture = harness(); const { app, events, calls } = fixture;
    app.restore(snapshot(job("running", 1))); app.startEvents();
    const update = amazonProductEvent(recomputeProductProfit(canonicalProduct()));
    update.job = job(status, 2); delete update.job.workerActive;
    emitSnapshotEvent(events, update);
    assert.equal(app.state().runState.amazonCollectionJob.workerActive, true);
    assert.equal(app.locked(), true);
    assert.equal(calls.length, 0, "worker-state protection must preserve the incremental update path");
    fixture.respond(async path => { assert.equal(path, "/api/amazon/collection"); return { ...job(status, 2), workerActive: false }; });
    await app.load();
    assert.equal(app.state().runState.amazonCollectionJob.workerActive, false);
    assert.equal(app.locked(), false);
    update.baseRevision = 2; update.revision = 3; update.job.revision = 3;
    emitSnapshotEvent(events, update);
    assert.equal(app.state().runState.amazonCollectionJob.workerActive, false);
    assert.equal(app.locked(), false, "later persisted events retain the explicit stopped state");
  });

  test(`${status} full snapshot preserves the known worker flag and accepts a later explicit false`, async () => {
    const fixture = harness(); const { app } = fixture;
    app.restore(snapshot(job("running", 1)));
    const persistedJob = job(status, 2); delete persistedJob.workerActive;
    fixture.respond(async path => path === "/api/amazon/collection"
      ? { ...persistedJob, workerActive: false } : snapshot(persistedJob));
    await app.refresh();
    assert.equal(app.state().runState.amazonCollectionJob.workerActive, true);
    assert.equal(app.locked(), true);
    await app.load(); await app.refresh();
    assert.equal(app.state().runState.amazonCollectionJob.workerActive, false);
    assert.equal(app.locked(), false);
  });
}

for (const route of ["status", "snapshot"]) {
  test(`worker state is not inherited from a different run through ${route}`, () => {
    const { app } = harness();
    app.restore(snapshot(job("running", 1)));
    const other = { ...job("paused", 2), runId: "other-synthetic-run" }; delete other.workerActive;
    if (route === "status") {
      app.apply(other);
      assert.equal(app.importState().amazonCollectionJob.workerActive, undefined);
      assert.equal(app.state().runState.amazonCollectionJob.workerActive, true, "the original run keeps its own lock");
    }
    app.restore(snapshot(other));
    assert.equal(app.state().runState.id, other.runId);
    assert.equal(app.state().runState.amazonCollectionJob.workerActive, undefined);
    assert.equal(app.locked(), false);
  });
}

test("stale Amazon product events and archived runs are ignored without refresh or recomputation", async () => {
  const { app, calls, events } = harness();
  app.restore(snapshot(job("running", 4))); app.startEvents(); app.resetActivity();
  const original = app.state().products[0];
  emitSnapshotEvent(events, amazonProductEvent({ ...canonicalProduct(), name: "Stale" }, 3, 2));
  emitSnapshotEvent(events, amazonProductEvent({ ...canonicalProduct(), name: "Duplicate" }, 4, 3));
  app.state().runState.archivedAt = "2026-10-13T00:00:00.000Z";
  emitSnapshotEvent(events, amazonProductEvent({ ...canonicalProduct(), name: "Archived" }, 5, 4));
  await app.settleSnapshots();
  assert.strictEqual(app.state().products[0], original);
  assert.equal(app.state().revision, 4); assert.equal(calls.length, 0);
  assert.equal(app.activity().recomputed, 0); assert.equal(app.activity().rendered, 0);
});

for (const reason of ["gap", "new product", "old formula", "job revision mismatch"]) {
  test(`unsafe Amazon product event (${reason}) falls back to a canonical snapshot`, async () => {
    const fixture = harness(); const { app, calls, events } = fixture;
    app.restore(snapshot()); app.startEvents();
    const update = amazonProductEvent(recomputeProductProfit({ ...canonicalProduct(), name: "Event data" }));
    if (reason === "gap") { update.baseRevision = 5; update.revision = 6; update.job.revision = 6; }
    if (reason === "new product") update.products = [imageCandidate(2)];
    if (reason === "old formula") update.formulaVersion = "profit-workbook-au-ca-envelope-fba-v10";
    if (reason === "job revision mismatch") update.job.revision = 9;
    fixture.respond(async path => { assert.equal(path, `/api/runs/${runId}`); return snapshot(job("running", 6), [{ ...canonicalProduct(), name: "Full canonical snapshot" }]); });
    emitSnapshotEvent(events, update); await app.settleSnapshots();
    assert.equal(app.state().products[0].name, "Full canonical snapshot");
    assert.equal(app.state().revision, 6);
    assert.equal(calls.length, 1); assert.ok(!calls[0].options.method || calls[0].options.method === "GET");
  });
}

test("Amazon product events during a snapshot refresh request a second read and retain the newer revision", async () => {
  const fixture = harness(); const { app, calls, events } = fixture;
  app.restore(snapshot()); app.startEvents();
  let resolveFirst;
  fixture.respond(async () => calls.length === 1 ? new Promise(resolve => { resolveFirst = resolve; })
    : snapshot(job("running", 3), [{ ...canonicalProduct(), name: "Latest persisted product" }]));
  const refresh = app.refresh();
  emitSnapshotEvent(events, amazonProductEvent({ ...canonicalProduct(), name: "Newer event" }, 3, 2));
  assert.equal(calls.length, 1);
  resolveFirst(snapshot(job("running", 2)));
  await refresh; await app.settleSnapshots();
  assert.equal(calls.length, 2);
  assert.equal(app.state().revision, 3);
  assert.equal(app.state().products[0].name, "Latest persisted product");
});

test("Amazon product events racing a profit save use the deferred full snapshot after saving", async () => {
  const fixture = harness(); const { app, calls, events } = fixture;
  app.restore(snapshot()); app.startEvents(); app.setPendingProfitSaves(1);
  fixture.respond(async () => snapshot(job("paused", 2), [{ ...canonicalProduct(), salePrice: 29 }]));
  emitSnapshotEvent(events, amazonProductEvent({ ...canonicalProduct(), salePrice: 999 }));
  await app.settleSnapshots();
  assert.equal(app.state().products[0].salePrice, 18);
  app.setPendingProfitSaves(0); await app.settleSnapshots();
  assert.equal(app.state().products[0].salePrice, 29);
  assert.equal(calls.length, 2);
});

test("Amazon product events preserve an unsaved profit editor draft through snapshot fallback", async () => {
  const fixture = harness(); const { app, calls, events, element } = fixture;
  app.restore(snapshot(job("paused", 1))); app.openLocalDrawer(productId); app.bindEditor(); app.startEvents();
  element("editSalePrice").value = "25";
  await fixture.fire("editSalePrice", "input");
  fixture.respond(async () => snapshot(job("paused", 2), [{ ...canonicalProduct(), name: "Backend refreshed" }]));
  emitSnapshotEvent(events, amazonProductEvent({ ...canonicalProduct(), salePrice: 999 }));
  await app.settleSnapshots();
  assert.equal(calls.length, 1);
  assert.equal(app.state().products[0].name, "Backend refreshed");
  assert.equal(Number(element("editSalePrice").value), 25);
});

test("Amazon event fallback captures a drawer input even before its input handler runs", async () => {
  const fixture = harness(); const { app, events, element } = fixture;
  app.restore(snapshot(job("paused", 1))); app.openLocalDrawer(productId); app.startEvents();
  element("editSalePrice").value = "25";
  fixture.respond(async () => snapshot(job("paused", 2), [canonicalProduct()]));
  emitSnapshotEvent(events, amazonProductEvent({ ...canonicalProduct(), salePrice: 999 }));
  await app.settleSnapshots();
  assert.equal(app.state().products[0].salePrice, 18);
  assert.equal(Number(element("editSalePrice").value), 25);
});

for (const [marketplace, cap] of [["AU", 475], ["CA", 500]]) {
  test(`${marketplace} overweight drawer labels the capped estimate and retains the real freight weight`, () => {
    const { app, element } = harness();
    const item = automaticEnvelopeProduct(marketplace, 20, 2.345);
    app.restore(snapshot(job("paused"), [item])); app.useRealDrawer(); app.openLocalDrawer(item.id);
    const result = app.state().products[0];
    assert.equal(result.billingWeight, 2.345);
    assert.equal(result.profitCalculation.domesticFreightWeightKg, 2.345);
    assert.match(element("amazonMetrics").innerHTML, /FBA 超重封顶估算/);
    assert.match(element("amazonMetrics").innerHTML, new RegExp(`${cap} g · 国内运费与空运头程按实际重量`));
    assert.match(app.row(item.id), /FBA 封顶估算/);
  });
}

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

function productInformationWithoutWeight(asin = "B000000001") {
  return { version: 1, asin, status: "complete", reason: null, weightStatus: "not_provided", rowCount: 2,
    inspection: { version: 3, asin, status: "complete", stable: true, rowCount: 2, parsedSections: [{ selector: "#productDetails_feature_div", rowCount: 2 }], sections: [{ selector: "#productDetails_feature_div", status: "complete", rowCount: 2 }] },
    sections: [{ selector: "#productDetails_feature_div", heading: "Item details", rows: [{ label: "ASIN", value: asin }, { label: "Brand", value: "Example" }] }] };
}

function pageWithoutWeight(overrides = {}) {
  return { ...canonicalProduct(), productWeight: null, fbaWeight: null, billingWeight: null,
    manualFbaFee: false, fbaFee: null,
    productInformation: productInformationWithoutWeight(),
    collectionQuality: { fields: { weight: { status: "unavailable", reason: "page_not_provided" } } },
    profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: null }, ...overrides };
}

for (const marketplace of ["AU", "CA", "US", "NL", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"]) {
  test(`${marketplace} uncollected, incomplete and absent Item Weight show independent minimum-tier profit estimates`, () => {
    for (const state of ["uncollected", "incomplete", "not_provided"]) {
      const { app, element } = harness();
      const item = pageWithoutWeight({ marketplace, detailStatus: state === "uncollected" ? "pending" : "success",
        ...(state !== "not_provided" ? { productInformation: state === "incomplete" ? { ...productInformationWithoutWeight(), status: "incomplete", weightStatus: "unresolved" } : null,
          collectionQuality: { fields: { weight: { status: "missing", reason: "product_information_incomplete" } } } } : {}) });
      app.restore(snapshot(job("completed"), [item]));
      const current = app.state().products[0];
      const assumed = marketplace === "AU" ? 0.075 : marketplace === "CA" ? 0.1 : 0.25 / 2.2046226218;
      assert.equal(current.productWeight, null);
      assert.equal(current.billingWeight, null);
      assert.equal(current.profitInputs.actualWeightKg, null);
      if (["AU", "CA"].includes(marketplace)) {
        assert.equal(current.profitInputs.assumedWeightKg, undefined);
        assert.equal(current.profitCalculation, null);
        assert.equal(current.fbaFee, null);
        assert.ok(current.amazonMissing.includes("商品重量、包裹重量及尺寸均缺失"));
        continue;
      }
      assert.equal(current.profitInputs.assumedWeightKg, assumed);
      assert.equal(current.profitCalculation.airFreight.actualWeightKg, null);
      assert.equal(current.profitCalculation.assumedWeightKg, assumed);
      assert.ok(Number.isFinite(current.margin));
      assert.equal(current.complete, false);
      assert.match(app.row(productId), /最低档暂估/);
      app.openLocalDrawer(productId);
      assert.equal(element("editWeight").value, "");
      assert.match(element("drawerProfitValue").innerHTML, /最低档暂估/);
      assert.match(element("costBreakdown").innerHTML, /实际重量未知/);
      assert.doesNotMatch(element("costBreakdown").innerHTML, /nullg|商品重量 0g/);
      app.openManual();
      assert.match(element("manualCostProfitMargin").textContent, /最低档暂估/);
    }
  });
}

test("FBM missing weight still needs real weight and does not inherit a minimum-tier assumption", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("completed"), [pageWithoutWeight({ fulfillmentMode: "FBM", fbmFee: 3, manualFbmFee: true })]));
  const current = app.state().products[0];
  assert.equal(current.profitCalculation, null);
  assert.equal(current.profitInputs.assumedWeightKg, undefined);
  app.openLocalDrawer(productId);
  assert.equal(element("approveProductButton").disabled, true);
});

test("invalid saved actual weight cannot silently become a minimum-tier estimate in the frontend", () => {
  for (const raw of [0, -1, "invalid", false]) {
    for (const field of ["productWeight", "profitInputs"]) {
      const { app, element } = harness();
      const item = pageWithoutWeight({ detailParserVersion: 11,
        ...(field === "profitInputs" ? { profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: raw } } : { productWeight: raw }) });
      app.restore(snapshot(job("completed"), [item]));
      const current = app.state().products[0];
      assert.equal(current.profitCalculation, null, `${field}=${raw}`);
      assert.equal(current.profitInputs.assumedWeightKg, undefined);
      assert.equal(current.fbaFee, null);
      app.openLocalDrawer(productId);
      assert.equal(element("approveProductButton").disabled, true);
      assert.doesNotMatch(element("costBreakdown").innerHTML, /最低档|假设重量/);
    }
  }
});

test("confirmed absent weight estimates minimum-tier profit and can be reviewed without fabricating actual weight", () => {
  const { app, element, toasts } = harness();
  const original = pageWithoutWeight();
  app.restore(snapshot(job("completed"), [original]));
  const restoredSuppliers = structuredClone(app.state().products[0].suppliers);
  app.openLocalDrawer(productId);
  assert.equal(element("editWeight").value, "");
  assert.equal(element("editFbaFee").value, "");
  assert.equal(element("approveProductButton").disabled, false);
  assert.doesNotMatch(element("costBreakdown").innerHTML, /最低档/);
  app.approve();
  const product = app.state().products[0];
  assert.equal(product.reviewStatus, "approved");
  assert.equal(product.billingWeight, null);
  assert.equal(product.productWeight, null);
  assert.equal(product.profitInputs.actualWeightKg, null);
  assert.equal(product.profitCalculation, null);
  assert.equal(product.margin, null);
  assert.ok(product.amazonMissing.includes("商品重量、包裹重量及尺寸均缺失"));
  assert.equal(product.salePrice, original.salePrice);
  assert.equal(product.purchaseCost, original.purchaseCost);
  assert.deepEqual(structuredClone(product.suppliers), restoredSuppliers);
  assert.match(toasts.at(-1)[0], /初审通过.*尚无完整利润/);
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

for (const status of ["pending", "failed"]) test(status + " detail can estimate profit without claiming page weight absence", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("paused"), [pageWithoutWeight({ detailStatus: status })]));
  app.openLocalDrawer(productId);
  assert.equal(element("approveProductButton").disabled, false);
  assert.equal(app.state().products[0].fbaFee, null);
  assert.match(element("amazonMetrics").innerHTML, /待核验|尚未|待采集/);
  assert.doesNotMatch(element("costBreakdown").innerHTML, /页面未提供重量/);
  app.approve();
  assert.equal(app.state().products[0].reviewStatus, "approved");
  assert.equal(app.state().products[0].detailStatus, status);
  assert.equal(app.state().products[0].productWeight, null);
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
  assert.equal(product.fbaFee, null);
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
  assert.match(element("manualCostError").textContent, /有效月销量（至少 50）/);
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
  assert.equal(product.profitInputs.assumedWeightKg, undefined);
  assert.equal(product.profitCalculation.weightAssumption, undefined);
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
      productInformation: productInformationWithoutWeight(),
      collectionQuality: { fields: { weight: { status: 'unavailable', reason: 'page_not_provided' } } } };
    const { app, element, fire } = editableProfitFixture(initial);
    element('editSalePrice').value = String(after);
    await fire('editSalePrice', 'input');
    assert.equal(app.editor().fulfillmentFee, null);
    assert.equal(element('editFbaFee').value, '');
    app.approve();
    const result = app.state().products[0];
    assert.equal(result.reviewStatus, 'approved');
    assert.equal(result.fbaFee, null);
    assert.equal(result.billingWeight, null);
    assert.equal(result.profitCalculation, null);
    assert.equal(result.margin, null);
  }
});


for (const formulaVersion of ['profit-workbook-au-weight-only-fba-v9', 'profit-workbook-au-ca-envelope-fba-v10']) {
test(`${formulaVersion} migration retains preliminary approval unless the automatic fee really changes`, () => {
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
      formulaVersion };
    const { app } = harness();
    app.restore(snapshot(job('completed'), [product]), { persistMigrations: false });
    const restored = app.state().products[0];
    assert.equal(restored.reviewStatus, status);
    assert.equal(restored.fbaFee, fee);
  }
});

}

function uploadFixture(status = 'paused', marketplace = 'AU', exchangeRate = null) {
  const fixture = harness();
  const saved = snapshot(job(status));
  if (marketplace === 'CA') {
    Object.assign(saved.runState, { marketplace: 'CA', currency: 'CAD', amazonDomain: 'www.amazon.ca' });
    saved.storeList.audit.marketplace = 'CA';
    saved.profitModel.exchangeRate = 5.2;
    for (const product of saved.products) {
      Object.assign(product, { id: `CA:${product.asin}`, marketplace: 'CA', sourceMarketplace: 'CA' });
      product.profitInputs.exchangeRate = 5.2;
    }
  }
  if (Number.isFinite(exchangeRate)) {
    saved.profitModel.exchangeRate = exchangeRate;
    saved.runState.exchangeRate = exchangeRate;
    for (const product of saved.products) product.profitInputs.exchangeRate = exchangeRate;
  }
  fixture.app.restore(saved);
  fixture.app.useRealMarketUi();
  fixture.app.bindUpload();
  fixture.element('storeFileInput').files = [{ name: 'new-stores.xlsx', arrayBuffer: async () => new ArrayBuffer(4) }];
  return fixture;
}
const parsedUpload = (marketplace = 'AU') => ({ audit: { marketplace, uniqueSellers: 1 }, stores: [{ marketplace, sellerId: 'NEWSELLER01', asins: ['B000000002'] }] });
const archivedUpload = () => ({ summary: { id: runId, status: 'cancelled', archivedAt: '2026-10-12T03:30:00.000Z' }, runs: [{ id: runId, status: 'cancelled', productCount: 1, hasSnapshot: true }] });

test('pause preserves the current task and never invokes upload archiving', async () => {
  const fixture = uploadFixture('running');
  fixture.respond(async (path, options) => {
    if (path === '/api/amazon/collection/control') { assert.equal(JSON.parse(options.body).action, 'pause'); return job('paused', 2); }
    if (path === `/api/runs/${runId}`) return snapshot(job('paused', 2));
    throw new Error(`Unexpected ${path}`);
  });
  await fixture.app.control('pause');
  assert.equal(fixture.app.state().runState.id, runId);
  assert.equal(fixture.app.state().runState.amazonCollectionJob.status, 'paused');
  assert.equal(fixture.app.state().products[0].purchaseCost, 6);
  assert.equal(fixture.app.locked(), false);
  assert.equal(fixture.calls.some(call => call.path.endsWith('/archive')), false);
});

test('upload archives a paused task after saving edits and before clearing its view', async () => {
  const fixture = uploadFixture();
  let releaseArchive;
  const archiveStarted = new Promise(resolve => {
    fixture.respond(async (path, options) => {
      if (path === '/api/store-list/parse') return parsedUpload();
      if (path === '/api/runs') {
        assert.equal(JSON.parse(options.body).products[0].purchaseCost, 6);
        return { runs: [] };
      }
      if (path === `/api/runs/${runId}/archive`) {
        assert.deepEqual(JSON.parse(options.body), { reason: 'file_upload' });
        resolve();
        return new Promise(done => { releaseArchive = done; });
      }
      throw new Error(`Unexpected ${path}`);
    });
  });
  const importing = fixture.fire('storeFileInput', 'change');
  await archiveStarted;
  assert.equal(fixture.app.state().runState.id, runId);
  assert.equal(fixture.app.state().products.length, 1);
  assert.equal(fixture.app.importState().taskReplacementPending, true);
  assert.equal(fixture.element('body').inert, true);
  const beforeMatching = fixture.calls.length;
  await fixture.app.startMatching();
  await fixture.app.resumeSupplier();
  assert.equal(fixture.calls.length, beforeMatching, 'Upload cannot start a competing supplier task');
  releaseArchive(archivedUpload());
  await importing;
  assert.deepEqual(fixture.calls.map(call => call.path), ['/api/store-list/parse', '/api/runs', `/api/runs/${runId}/archive`]);
  assert.equal(fixture.app.state().runState.id, null);
  assert.equal(fixture.app.state().products.length, 0);
  assert.equal(fixture.app.importState().storeList.stores[0].sellerId, 'NEWSELLER01');
  assert.equal(fixture.app.importState().runHistory[0].status, 'cancelled');
  assert.equal(fixture.app.importState().amazonCollectionJob, null);
  assert.equal(fixture.app.importState().taskReplacementPending, false);
  assert.notEqual(fixture.element('body').inert, true);
});

for (const [from, to, oldCurrency, currency, exchangeRate] of [
  ['AU', 'CA', 'AUD', 'CAD', 5.2],
  ['CA', 'AU', 'CAD', 'AUD', 4.8],
]) test(`uploading ${to} links switches ${from} only after its saved task is archived`, async () => {
  const fixture = uploadFixture('paused', from, 6.23);
  const before = JSON.parse(JSON.stringify(fixture.app.capture()));
  let releaseArchive;
  const archiveStarted = new Promise(resolve => {
    fixture.respond(async (path, options) => {
      if (path === '/api/store-list/parse') {
        assert.equal(options.headers['X-Marketplace'], from, 'The selected market is only the parser fallback');
        return parsedUpload(to);
      }
      if (path === '/api/runs') {
        const saved = JSON.parse(options.body);
        assert.equal(saved.runState.marketplace, from);
        assert.equal(saved.runState.currency, oldCurrency);
        assert.equal(saved.storeList.audit.marketplace, from);
        assert.equal(saved.profitModel.exchangeRate, before.profitModel.exchangeRate);
        assert.deepEqual(saved.products, before.products, 'Archiving must preserve manual prices, costs, weights and supplier quotes');
        return { runs: [] };
      }
      if (path === `/api/runs/${runId}/archive`) {
        resolve();
        return new Promise(done => { releaseArchive = done; });
      }
      throw new Error(`Unexpected ${path}`);
    });
  });
  const importing = fixture.fire('storeFileInput', 'change');
  await archiveStarted;
  assert.equal(fixture.app.marketState().activeMarket.code, from);
  assert.equal(fixture.element('marketplaceSelect').value, from);
  assert.equal(fixture.app.state().runState.currency, oldCurrency);
  assert.equal(fixture.app.state().products[0].purchaseCost, 6);
  releaseArchive(archivedUpload());
  await importing;
  const next = fixture.app.capture();
  assert.equal(fixture.app.marketState().activeMarket.code, to);
  assert.equal(fixture.element('marketplaceSelect').value, to);
  assert.equal(fixture.element('brandMarket').textContent, `SCOUT ${to}`);
  assert.equal(fixture.element('exchangeRateLabel').textContent, `1 ${currency} 兑换人民币`);
  assert.equal(next.runState.id, null);
  assert.equal(next.runState.mode, 'idle');
  assert.equal(next.runState.marketplace, to);
  assert.equal(next.runState.sourceMarketplace, to);
  assert.equal(next.runState.currency, currency);
  assert.equal(next.runState.exchangeRate, exchangeRate);
  assert.equal(next.profitModel.exchangeRate, exchangeRate);
  assert.equal(next.products.length, 0);
  assert.equal(next.storeList.audit.marketplace, to);
  assert.deepEqual(fixture.calls.map(call => call.path), ['/api/store-list/parse', '/api/runs', `/api/runs/${runId}/archive`]);
});

test('after importing Canada, explicit Amazon and SellerSprite checks use the uploaded market', async () => {
  const fixture = uploadFixture();
  fixture.respond(async path => {
    if (path === '/api/store-list/parse') return parsedUpload('CA');
    if (path === '/api/runs') return { runs: [] };
    if (path === `/api/runs/${runId}/archive`) return archivedUpload();
    if (path === '/api/amazon/check') return { ready: true, checkedAt: '2026-10-12T08:00:00.000Z', sellerId: 'NEWSELLER01', discoveredAsins: 1 };
    if (path === '/api/sellsprite/status') return { configuration: { configured: true }, capabilities: { supportedMarketplaces: ['CA'] } };
    if (path === '/api/sellsprite/connect') return { tools: ['competitor_lookup'], capabilities: { supportedMarketplaces: ['CA'] } };
    throw new Error(`Unexpected ${path}`);
  });
  await fixture.fire('storeFileInput', 'change');
  assert.equal(fixture.calls.some(call => /check|connect|sellsprite/.test(call.path)), false, 'Upload must not automatically call external services');
  assert.equal(await fixture.app.checkAmazon(), true);
  fixture.element('useSellerSpriteToggle').checked = true;
  assert.equal(await fixture.app.checkSellerSprite(), true);
  assert.deepEqual(fixture.calls.find(call => call.path === '/api/amazon/check').body, { marketplace: 'CA', sellerId: 'NEWSELLER01' });
  assert.deepEqual(fixture.calls.find(call => call.path === '/api/sellsprite/connect').body, { confirmed: true, marketplace: 'CA' });
});

test('running upload accepts one replacement and rejects late snapshot/status responses', async () => {
  const fixture = uploadFixture('running');
  let releaseSnapshot, releaseStatus, releaseArchive;
  const archiveStarted = new Promise(resolve => {
    fixture.respond(async path => {
      if (path === `/api/runs/${runId}`) return new Promise(done => { releaseSnapshot = done; });
      if (path === '/api/amazon/collection') return new Promise(done => { releaseStatus = done; });
      if (path === '/api/store-list/parse') return parsedUpload('CA');
      if (path === `/api/runs/${runId}/archive`) { resolve(); return new Promise(done => { releaseArchive = done; }); }
      throw new Error(`Unexpected ${path}`);
    });
  });
  const readingSnapshot = fixture.app.refresh();
  const readingStatus = fixture.app.load();
  const importing = fixture.fire('storeFileInput', 'change');
  await archiveStarted;
  await fixture.fire('storeFileInput', 'change');
  releaseArchive(archivedUpload());
  await importing;
  releaseSnapshot(snapshot(job('running', 90)));
  releaseStatus(job('running', 90));
  await Promise.all([readingSnapshot, readingStatus]);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/archive')).length, 1);
  assert.equal(fixture.calls.some(call => call.path === '/api/runs'), false);
  assert.equal(fixture.app.state().runState.id, null);
  assert.equal(fixture.app.state().products.length, 0);
  assert.equal(fixture.app.importState().amazonCollectionJob, null);
  assert.equal(fixture.app.importState().storeList.stores[0].sellerId, 'NEWSELLER01');
  assert.equal(fixture.app.marketState().activeMarket.code, 'CA');
  assert.equal(fixture.element('marketplaceSelect').value, 'CA');
  assert.equal(fixture.app.state().runState.currency, 'CAD');
  assert.equal(fixture.app.capture().profitModel.exchangeRate, 5.2);
});

for (const [label, parse] of [
  ['invalid workbook', async () => { throw new Error('Invalid XLSX'); }],
  ['empty workbook', async () => ({ audit: { marketplace: 'CA', uniqueSellers: 0 }, stores: [] })],
  ['empty stores with an inconsistent audit count', async () => ({ audit: { marketplace: 'CA', uniqueSellers: 1 }, stores: [] })],
  ['unsupported marketplace', async () => parsedUpload('XX')],
  ['missing marketplace', async () => ({ ...parsedUpload('CA'), audit: { uniqueSellers: 1 } })],
  ['mixed marketplace audit', async () => ({ ...parsedUpload('CA'), audit: { marketplace: 'CA', uniqueSellers: 1, requiresSeparateBatches: true } })],
  ['store marketplace inconsistent with audit', async () => ({ ...parsedUpload('AU'), audit: { marketplace: 'CA', uniqueSellers: 1 } })],
  ['mixed marketplace workbook', async () => { throw Object.assign(new Error('Workbook contains CA and AU links'), { code: 'MIXED_MARKETPLACES' }); }],
]) {
  test(`${label} keeps the paused task, manual data and checkpoint without archiving`, async () => {
    const fixture = uploadFixture();
    fixture.respond(async path => { assert.equal(path, '/api/store-list/parse'); return parse(); });
    await fixture.fire('storeFileInput', 'change');
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.app.state().runState.id, runId);
    assert.equal(fixture.app.state().products[0].purchaseCost, 6);
    assert.equal(fixture.app.importState().storeList.stores[0].sellerId, 'EXAMPLESELLER');
    assert.equal(fixture.app.importState().storeImportPending, false);
    assert.equal(fixture.app.marketState().activeMarket.code, 'AU');
    assert.equal(fixture.element('marketplaceSelect').value, 'AU');
    assert.equal(fixture.app.capture().profitModel.exchangeRate, 4.8);
  });
}

test('failed archive preserves the old view and marketplace and does not offer the new batch as ready', async () => {
  const fixture = uploadFixture('running');
  fixture.respond(async path => {
    if (path === '/api/store-list/parse') return parsedUpload('CA');
    if (path.endsWith('/archive')) throw new Error('Disk write failed');
    throw new Error(`Unexpected ${path}`);
  });
  await fixture.fire('storeFileInput', 'change');
  assert.equal(fixture.app.state().runState.id, runId);
  assert.equal(fixture.app.state().products[0].purchaseCost, 6);
  assert.equal(fixture.app.importState().storeList.stores[0].sellerId, 'EXAMPLESELLER');
  assert.ok(fixture.toasts.some(([message]) => /Disk write failed/.test(message)));
  assert.equal(fixture.app.marketState().activeMarket.code, 'AU');
  assert.equal(fixture.element('marketplaceSelect').value, 'AU');
  assert.equal(fixture.app.state().runState.currency, 'AUD');
  assert.equal(fixture.app.capture().profitModel.exchangeRate, 4.8);
});

test('a failed old snapshot save prevents both marketplace switching and archiving', async () => {
  const fixture = uploadFixture('paused');
  fixture.respond(async path => {
    if (path === '/api/store-list/parse') return parsedUpload('CA');
    if (path === '/api/runs') throw new Error('Snapshot could not be persisted');
    throw new Error(`Unexpected ${path}`);
  });
  await fixture.fire('storeFileInput', 'change');
  assert.equal(fixture.calls.some(call => call.path.endsWith('/archive')), false);
  assert.equal(fixture.app.state().runState.id, runId);
  assert.equal(fixture.app.state().products[0].purchaseCost, 6);
  assert.equal(fixture.app.importState().storeList.stores[0].sellerId, 'EXAMPLESELLER');
  assert.equal(fixture.app.marketState().activeMarket.code, 'AU');
  assert.equal(fixture.element('marketplaceSelect').value, 'AU');
  assert.equal(fixture.app.state().runState.currency, 'AUD');
  assert.equal(fixture.app.capture().profitModel.exchangeRate, 4.8);
});

test('cancelling the file picker does not pause, cancel or archive the current run', async () => {
  const fixture = uploadFixture('running');
  fixture.element('storeFileInput').files = [];
  await fixture.fire('storeFileInput', 'change');
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.app.state().runState.id, runId);
});

test('upload remains available during collection while archived history cannot resume', async () => {
  const fixture = uploadFixture('running');
  fixture.app.availability();
  assert.equal(fixture.element('storeFileInput').disabled, false);
  assert.equal(fixture.element('uploadZone').disabled, false);
  const archived = snapshot(job('cancelled'));
  archived.runState.archivedAt = '2026-10-12T03:30:00.000Z';
  fixture.app.restore(archived, { autoResume: true });
  fixture.app.availability();
  assert.equal(fixture.element('startAnalysisButton').disabled, true);
  await fixture.app.control('resume');
  await fixture.app.run();
  assert.equal(fixture.calls.length, 0);
});


for (const source of ['history', 'workspace']) {
  test(`a late ${source} response cannot change the archived run selection or replace an uploaded file`, async () => {
    const fixture = uploadFixture();
    let releaseOldRead;
    fixture.respond(async path => {
      if (path === '/api/runs/other-history-run' || path === '/api/state') return new Promise(resolve => { releaseOldRead = resolve; });
      if (path === '/api/store-list/parse') return parsedUpload();
      if (path === '/api/runs') return { runs: [] };
      if (path === `/api/runs/${runId}/archive`) return archivedUpload();
      throw new Error(`Unexpected ${path}`);
    });
    const oldRead = source === 'history' ? fixture.app.history('other-history-run') : fixture.app.workspace();
    await fixture.fire('storeFileInput', 'change');
    const old = snapshot({ ...job('paused'), runId: 'other-history-run' });
    releaseOldRead(source === 'history' ? old : { latestRun: old, runs: [] });
    await oldRead;
    assert.equal(fixture.calls.filter(call => call.path.endsWith('/archive')).length, 1);
    assert.equal(fixture.app.state().runState.id, null);
    assert.equal(fixture.app.importState().storeList.stores[0].sellerId, 'NEWSELLER01');
    assert.equal(fixture.app.importState().runHistory[0].status, 'cancelled');
  });
}


test("a late successful collection result cannot overwrite manually entered monthly sales or restore its superseded evidence", () => {
  const { app } = harness();
  const manual = canonicalProduct();
  manual.sales30 = 20;
  manual.sales30Evidence = null;
  manual.amazonSales30Evidence = null;
  manual.manualAmazonOverride = true;
  manual.manualAmazonFields = { ...manual.manualAmazonFields, sales30: true };
  manual.fieldSources = { ...manual.fieldSources, sales30: "manual" };
  app.restore(snapshot(job("completed"), [manual]));
  const collectedEvidence = { source: "amazon_product_page", period: "past_month", kind: "lower_bound",
    value: 200, rawText: "200+ bought in past month", asin: manual.asin };
  app.mergeCandidates([{ id: manual.id, asin: manual.asin, sourceAsin: manual.sourceAsin, marketplace: "AU",
    analysisSourceMode: "amazon_only", detailStatus: "success", title: "Late successful result", sales30: 200,
    sales30Evidence: collectedEvidence, amazonSales30Evidence: collectedEvidence,
    fieldSources: { sales30: "amazon_product_page" } }]);
  const saved = app.state().products.find(item => item.id === manual.id);
  assert.equal(saved.sales30, 20);
  assert.equal(saved.sales30Evidence, null);
  assert.equal(saved.amazonSales30Evidence, null);
  assert.equal(saved.fieldSources.sales30, "manual");
  assert.equal(saved.manualAmazonFields.sales30, true);
  assert.equal(app.filtered().some(item => item.id === manual.id), false);
});


const lostControlResponse = () => Object.assign(new Error('Response timed out after submission'), { code: 'REQUEST_TIMEOUT' });

test('a lost Amazon pause response is confirmed once and a later snapshot timeout is only a sync warning', async () => {
  const fixture = harness();
  const { app, calls, toasts } = fixture;
  app.restore(snapshot(job('running', 1)));
  const paused = { ...job('paused', 2), causeCode: 'USER_PAUSED' };
  fixture.respond(async path => {
    if (path === '/api/amazon/collection/control') throw lostControlResponse();
    if (path === '/api/amazon/collection') return paused;
    if (path === `/api/runs/${runId}`) throw lostControlResponse();
    throw new Error(`Unexpected ${path}`);
  });
  await app.control('pause');
  assert.equal(app.state().runState.amazonCollectionJob.status, 'paused');
  assert.deepEqual(calls.map(call => call.path), ['/api/amazon/collection/control', '/api/amazon/collection', `/api/runs/${runId}`]);
  assert.ok(toasts.some(([message]) => message.includes('已确认') && message.includes('进度待同步')));
  assert.equal(toasts.some(([message]) => /状态未更新|尚未开始/.test(message)), false);
});

test('an unconfirmed command for another run is never replayed by a second click', async () => {
  const fixture = harness();
  const { app, calls, toasts } = fixture;
  app.restore(snapshot(job('running', 1)));
  fixture.respond(async path => {
    if (path === '/api/amazon/collection/control') throw new TypeError('Failed to fetch');
    if (path === '/api/amazon/collection') return { ...job('paused', 2), runId: 'different-run', causeCode: 'USER_PAUSED' };
    throw new Error(`Unexpected ${path}`);
  });
  await app.control('pause');
  await app.control('pause');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.path === '/api/amazon/collection').length, 2);
  assert.equal(app.state().runState.amazonCollectionJob.status, 'running');
  assert.ok(toasts.every(([message]) => message.includes('结果待确认')));
});

for (const action of ['resume', 'resume_after_supplier', 'retry_missing']) {
  for (const advanced of [false, true]) {
    test(`Amazon ${action} requires a newer revision to confirm completed after a lost response (${advanced})`, async () => {
      const fixture = harness();
      const { app, calls } = fixture;
      const before = { ...job('paused', 3), causeCode: action === 'resume_after_supplier' ? 'SUPPLIER_MATCHING' : 'USER_PAUSED' };
      app.restore(snapshot(before));
      fixture.respond(async path => {
        if (path.endsWith('/control')) throw lostControlResponse();
        assert.equal(path, '/api/amazon/collection');
        return job('completed', advanced ? 4 : 3);
      });
      const pending = app.requestControl('amazon', { runId, action });
      if (advanced) assert.equal((await pending).status, 'completed');
      else await assert.rejects(pending, { code: 'CONTROL_OUTCOME_UNKNOWN' });
      assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
      assert.equal(calls.length, 2);
    });
  }
}

test('retry_missing does not infer acceptance from an unchanged active revision', async () => {
  const fixture = harness();
  const { app } = fixture;
  app.restore(snapshot(job('running', 5)));
  fixture.respond(async path => { if (path.endsWith('/control')) throw lostControlResponse(); return job('running', 5); });
  await assert.rejects(app.requestControl('amazon', { runId, action: 'retry_missing' }), { code: 'CONTROL_OUTCOME_UNKNOWN' });
});

for (const [workerActive, snapshotRevision, expected] of [[false, 2, true], [true, 2, false], [false, 1, false]]) {
  test(`supplier preparation after a lost pause response requires an idle worker and matching snapshot (${workerActive},${snapshotRevision})`, async () => {
    const fixture = harness();
    const { app, calls } = fixture;
    app.restore(snapshot(job('running', 1), [imageCandidate()]));
    const paused = { ...job('paused', 2), causeCode: 'SUPPLIER_MATCHING', workerActive };
    fixture.respond(async path => {
      if (path === '/api/amazon/collection/control') throw lostControlResponse();
      if (path === '/api/amazon/collection') return paused;
      if (path === `/api/runs/${runId}`) return snapshot({ ...paused, revision: snapshotRevision }, [imageCandidate()]);
      throw new Error(`Unexpected ${path}`);
    });
    assert.equal(await app.prepareSupplier(), expected);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    assert.equal(calls.some(call => call.path.includes('/1688/')), false);
  });
}

test('a lost supplier resume response is adopted even when its subsequent snapshot cannot load', async () => {
  const fixture = harness();
  const { app, calls, toasts } = fixture;
  app.restore(supplierSnapshot(supplierPipeline({ status: 'paused', enabled: false, revision: 1 }), [imageCandidate()]));
  const running = supplierPipeline({ revision: 2 });
  fixture.respond(async path => {
    if (path === '/api/1688/pipeline/control') throw lostControlResponse();
    if (path === '/api/1688/pipeline') return running;
    if (path === `/api/runs/${runId}`) throw lostControlResponse();
    throw new Error(`Unexpected ${path}`);
  });
  assert.equal(await app.resumeSupplier(), true);
  assert.equal(app.state().runState.supplier1688Pipeline.status, 'running');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(toasts.some(([message]) => message.includes('进度待同步')));
  assert.equal(toasts.some(([message]) => /暂未继续|尚未开始/.test(message)), false);
});

test('supplier pause response loss performs one status read and adopts the confirmed paused task', async () => {
  const fixture = harness();
  const { app, calls } = fixture;
  app.restore(supplierSnapshot(supplierPipeline(), [imageCandidate()]));
  const paused = supplierPipeline({ status: 'paused', enabled: false, revision: 2 });
  fixture.respond(async path => {
    if (path === '/api/1688/pipeline/control') throw new TypeError('Failed to fetch');
    if (path === '/api/1688/pipeline') return paused;
    if (path === `/api/runs/${runId}`) return supplierSnapshot(paused, [imageCandidate()]);
    throw new Error(`Unexpected ${path}`);
  });
  await app.pauseSupplier();
  assert.equal(app.state().runState.supplier1688Pipeline.status, 'paused');
  assert.deepEqual(calls.map(call => call.path), ['/api/1688/pipeline/control', '/api/1688/pipeline', `/api/runs/${runId}`]);
});

for (const [revision, includesSelection, expected] of [[1, true, false], [2, false, false], [2, true, true]]) {
  test(`lost append response requires the selected IDs and revision evidence (${revision},${includesSelection})`, async () => {
    const fixture = harness();
    const { app, calls } = fixture;
    app.restore(supplierSnapshot(supplierPipeline({ status: 'paused', enabled: false }), [imageCandidate(), imageCandidate(2)]));
    const selected = [productId, imageCandidate(2).id];
    fixture.respond(async path => {
      if (path.endsWith('/control')) throw lostControlResponse();
      return supplierPipeline({ revision, productIds: includesSelection ? selected : [productId] });
    });
    const pending = app.requestControl('supplier', { runId, action: 'append', productIds: selected });
    if (expected) assert.equal((await pending).revision, revision);
    else await assert.rejects(pending, { code: 'CONTROL_OUTCOME_UNKNOWN' });
    assert.equal(calls.length, 2);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  });
}

for (const code of ['SEARCH_TIMEOUT', 'SEARCH_WORKER_EXITED', 'SEARCH_WORKER_STOP_FAILED', 'SEARCH_INTERRUPTED']) {
  test(`${code} exposes an explicit technical recovery button without describing a captcha or automatically resuming`, async () => {
    const fixture = harness();
    const { app, element, calls, toasts } = fixture;
    app.restore(snapshot(job('completed', 1), [imageCandidate()]));
    app.applySession({ ready: true, reason: 'ready' }, { running: 0, queued: 0, activeTasks: [], ratePolicy: { pausedReason: code, manualResumeRequired: true } });
    assert.equal(element('resume1688Button').hidden, false);
    assert.equal(element('resume1688Button').textContent, '检查后继续');
    assert.match(element('supplier1688StatusText').textContent, /搜图进程中断/);
    assert.doesNotMatch(element('supplier1688StatusText').textContent, /验证/);
    assert.equal(await app.startMatching(), false);
    assert.equal(calls.length, 0);
    fixture.respond(async (path, options) => {
      assert.equal(path, '/api/v1/queue/resume');
      assert.deepEqual(JSON.parse(options.body), { confirmed: true });
      return { auth: { ready: true, reason: 'ready' }, queue: { running: 0, queued: 0, activeTasks: [], ratePolicy: { pausedReason: null } } };
    });
    assert.equal(await app.resumeQueue(), true);
    assert.equal(calls.length, 1);
    assert.equal(toasts.some(([message]) => message.includes('图片验证已确认')), false);
  });
}


test('technical interruption keeps the ordinary login entry available after session expiry', () => {
  const { app, element, calls } = harness();
  app.restore(snapshot(job('completed', 1), [imageCandidate()]));
  app.applySession({ ready: false, reason: 'login_required' }, { running: 0, queued: 0, activeTasks: [],
    ratePolicy: { pausedReason: 'SEARCH_INTERRUPTED', manualResumeRequired: true } });
  assert.equal(element('login1688Button').hidden, false);
  assert.match(element('login1688Button').title, /专用 Edge/);
  assert.doesNotMatch(element('login1688Button').title, /图片搜索验证/);
  assert.match(element('supplier1688StatusText').textContent, /请先登录/);
  assert.equal(calls.length, 0);
});


test("the drawer retains complete Product information rows and escapes their original text", () => {
  const { app, element } = harness();
  const product = canonicalProduct();
  product.productInformation = { version: 1, asin: product.asin, status: "complete", weightStatus: "found", rowCount: 3,
    sections: [{ selector: "#prodDetails", heading: "Item details", rows: [
      { label: "ASIN", value: product.asin }, { label: "Item Weight", value: "20 g" },
      { label: "Brand", value: '<img src=x onerror="alert(1)">' },
    ] }] };
  app.restore(snapshot(job("completed"), [product]));
  app.openLocalDrawer(product.id);
  const html = element("amazonProductInformation").innerHTML;
  assert.match(html, /已完整读取 3 项/);
  assert.match(html, /Item Weight/);
  assert.match(html, /20 g/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(element("amazonProductInformation").hidden, false);
});

test("an old successful page without Product information proof can estimate profit without claiming page absence", () => {
  const { app, element } = harness();
  const product = pageWithoutWeight({ productInformation: null });
  app.restore(snapshot(job("completed"), [product]));
  app.openLocalDrawer(product.id);
  assert.match(element("amazonProductInformation").innerHTML, /尚未完整读取/);
  assert.equal(app.state().products[0].fbaFee, null);
  assert.equal(app.state().products[0].profitCalculation, null);
  assert.doesNotMatch(element("costBreakdown").innerHTML, /页面未提供重量/);
});


function datedCandidate(index, date, extra = {}) {
  return imageCandidate(index, { detailStatus: "success", amazonFirstAvailableDate: date,
    amazonFirstAvailableDateStatus: date ? "found" : "unresolved", rating: 4.7, reviews: 40, missing: [], amazonMissing: [],
    amazonFirstAvailableDateEvidence: date ? { source: "amazon_product_information", asin: `B${String(index).padStart(9, "0")}`,
      marketplace: "AU", label: "Date First Available", rawText: date, value: date } : null, ...extra });
}

test("missing listing dates are labelled without blocking profit, complete candidates or explicit date filtering", () => {
  const { app, element, calls } = harness();
  const items = ['found', 'not_provided', 'unresolved'].map((status, index) => {
    const asin = `B${String(index + 1).padStart(9, '0')}`;
    return { ...canonicalProduct(), id: `AU:${asin}`, asin, sourceAsin: asin,
      sales30Evidence: { ...canonicalProduct().sales30Evidence, asin },
      amazonFirstAvailableDate: status === 'found' ? '2026-10-01' : null, amazonFirstAvailableDateStatus: status,
      missing: ['竞品上架时间'], amazonMissing: ['竞品上架时间'], complete: false };
  });
  const saved = snapshot(job('completed'), items);
  saved.runState.inputMode = saved.storeList.inputMode = 'asins';
  app.restore(saved);
  app.view(null, 1, {});
  element('resultsCompleteToggle').checked = true;
  const restored = app.state().products;
  assert.equal(app.filtered().length, 3);
  for (const product of restored) {
    assert.equal(product.complete, true);
    assert.ok(Number.isFinite(product.margin));
    assert.equal(product.margin, restored[0].margin);
    assert.equal(product.profitValue, restored[0].profitValue);
    assert.ok(!product.missing.some(value => /上架|日期/.test(value)));
    assert.ok(!product.profitPendingReasons.some(value => /上架|日期/.test(value)));
    assert.doesNotMatch(app.row(product.id), /待计算/);
  }
  assert.match(app.row(restored[1].id), /Amazon 未提供上架日期.*不影响利润计算/);
  assert.match(app.row(restored[2].id), /上架日期待核验.*不影响利润计算/);
  app.openLocalDrawer(restored[1].id);
  assert.match(element('amazonMetrics').innerHTML, /Amazon 未提供上架日期/);
  assert.match(element('amazonMetrics').innerHTML, /不影响利润计算及正常分析/);
  app.dateCoverage();
  assert.match(element('amazonListingDateCoverage').textContent, /未知日期正常参与分析/);
  element('amazonFirstAvailableFrom').value = '2026-10-01';
  app.applyDate();
  assert.deepEqual(Array.from(app.filtered(), product => product.id), [restored[0].id]);
  assert.equal(restored[1].margin, restored[0].margin, 'An active date filter must not erase stored profit.');
  assert.equal(calls.length, 0);
});

test("unavailable and unverified listing dates do not block the default ASIN supplier-matching selection", () => {
  const { app, element } = harness();
  const items = ['not_provided', 'unresolved'].map((status, index) => imageCandidate(index + 1, {
    detailStatus: 'success', currentPrice: 30, currentPriceStatus: 'verified', productWeight: 0.1, billingWeight: 0.1,
    amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: status,
  }));
  const saved = snapshot(job('completed'), items);
  saved.runState.inputMode = saved.storeList.inputMode = 'asins';
  app.restore(saved);
  app.view(null, 1, {});
  assert.equal(app.filtered().length, 2);
  assert.equal(app.matching().length, 2);
  element('amazonFirstAvailableFrom').value = '2026-10-01';
  app.applyDate();
  assert.equal(app.filtered().length, 0);
  assert.equal(app.matching().length, 0);
  assert.equal(app.state().products.length, 2);
});

test("calendar filtering includes start and local today, excludes unknown/future dates and never mutates or recollects products", async () => {
  const fixture = harness();
  const { app, element, calls } = fixture;
  app.restore(snapshot(job("paused"), []));
  const items = [datedCandidate(1, "2026-10-01"), datedCandidate(2, "2026-10-13"), datedCandidate(3, "2026-09-30"),
    datedCandidate(4, "2026-10-14"), datedCandidate(5, null, { amazonFirstAvailableDateStatus: "not_provided" }),
    datedCandidate(6, null, { listingAvailableAt: "2026-10-12", firstFba: "2026-10-12" }),
    datedCandidate(7, "2026-02-30"), datedCandidate(8, null)];
  app.setProducts(items);
  app.view(null, 6, {});
  app.dateFilters();
  const before = JSON.stringify(items);
  assert.equal(element("amazonFirstAvailableFrom").max, "2026-10-13");
  element("amazonFirstAvailableFrom").value = "2026-10-01";
  await fixture.fire("amazonFirstAvailableFrom", "change");
  assert.deepEqual(Array.from(app.filtered(), p => p.asin), [items[0].asin, items[1].asin]);
  assert.equal(app.state().resultPage, 1);
  assert.equal(app.capture().resultCriteria.amazonFirstAvailableFrom, "2026-10-01");
  assert.equal(app.capture().criteria.amazonFirstAvailableFrom, undefined, "date is a display criterion, never a collection input");
  app.dateCoverage();
  assert.match(element("amazonListingDateCoverage").textContent, /已取得 4 \/ 8.*未知 4.*页面未提供 1/);
  assert.match(element("amazonListingDateCoverage").textContent, /2026-10-01 至 2026-10-13/);
  await fixture.fire("clearAmazonListingDateButton", "click");
  assert.equal(app.filtered().length, 8);
  assert.equal(element("amazonFirstAvailableFrom").value, "");
  assert.equal(JSON.stringify(items), before);
  assert.match(app.row(items[4].id), /Amazon 未提供上架日期.*不影响利润计算/);
  assert.equal(calls.length, 0);
});

test("invalid and future calendar input leaves the accepted range unchanged", () => {
  const { app, element, toasts, calls } = harness();
  app.restore(snapshot(job("paused"), [datedCandidate(1, "2026-10-03")]));
  element("amazonFirstAvailableFrom").value = "2026-10-01";
  assert.equal(app.applyDate(), true);
  for (const invalid of ["2026-10-14", "2026-02-30", "10/01/2026"]) {
    element("amazonFirstAvailableFrom").value = invalid;
    assert.equal(app.applyDate(), false);
    assert.equal(app.state().activeRunCriteria.amazonFirstAvailableFrom, "2026-10-01");
  }
  assert.equal(toasts.filter(([message]) => message.includes("有效上架起始日期")).length, 3);
  assert.equal(calls.length, 0);
});

test("date criterion restores from snapshots, remains local to each run and survives a newer collection snapshot", async () => {
  const fixture = harness();
  const { app, element } = fixture;
  const initial = snapshot(job("running", 1), [datedCandidate(1, "2026-10-12")]);
  initial.resultCriteria.amazonFirstAvailableFrom = "2026-10-01";
  app.restore(initial);
  assert.equal(element("amazonFirstAvailableFrom").value, "2026-10-01");
  element("amazonFirstAvailableFrom").value = "2026-10-10";
  app.applyDate();
  const newer = snapshot(job("running", 2), [datedCandidate(1, "2026-10-12")]);
  fixture.respond(async path => { assert.equal(path, `/api/runs/${runId}`); return newer; });
  await app.refresh();
  assert.equal(app.state().activeRunCriteria.amazonFirstAvailableFrom, "2026-10-10");
  assert.equal(element("amazonFirstAvailableFrom").value, "2026-10-10");
  const other = snapshot({ ...job("paused"), runId: "other-date-run" }, [datedCandidate(2, null)]);
  app.restore(other);
  assert.equal(element("amazonFirstAvailableFrom").value, "");
  assert.equal(app.filtered().length, 1);
  app.restore(initial);
  assert.equal(element("amazonFirstAvailableFrom").value, "2026-10-10");
  const isolated = harness();
  isolated.app.restore({ ...initial, resultCriteria: app.capture().resultCriteria });
  assert.equal(isolated.element("amazonFirstAvailableFrom").value, "2026-10-10", "portable snapshot restores in a fresh browser session");
});

test("date and existing filters share the complete export/matching range and export button counts", async () => {
  const fixture = harness();
  const { app, element, exports } = fixture;
  app.restore(snapshot(job("paused"), []));
  const base = { complete: true, margin: 35, productWeight: 0.12, billingWeight: 0.12, sales30: 60, reviewStatus: "approved" };
  app.setProducts([datedCandidate(1, "2026-10-01", base), datedCandidate(2, "2026-10-13", { ...base, reviewStatus: "pending" }),
    datedCandidate(3, "2026-09-30", base), datedCandidate(4, null, base),
    datedCandidate(5, "2026-10-12", { ...base, rating: 2 }), datedCandidate(6, "2026-10-12", { ...base, sales30: 120 }),
    datedCandidate(7, "2026-10-12", { ...base, productWeight: 0.3 }), datedCandidate(8, "2026-10-12", { ...base, margin: 5 }),
    datedCandidate(9, "2026-10-12", { ...base, name: "Red product", englishName: "Red product" }),
    datedCandidate(10, "2026-10-12", { ...base, complete: false })]);
  app.view(null, 3, { monthlySalesBand: "50_to_100", minRating: 4, minReviews: 20, amazonFirstAvailableFrom: "2026-10-01" });
  element("resultSearch").value = "blue";
  element("resultWeightBand").value = "100_150";
  element("resultMinMargin").value = "20";
  element("resultsCompleteToggle").checked = true;
  const expected = Array.from(app.filtered(), p => p.id);
  assert.equal(expected.length, 2);
  assert.deepEqual(Array.from(app.exportRows(), p => p.id), expected);
  assert.deepEqual(Array.from(app.matching(), p => p.id), expected);
  app.exportCounts();
  app.handoffSummary();
  assert.equal(String(element("exportAllCandidateCount").textContent), "2");
  assert.equal(String(element("exportApprovedProductCount").textContent), "1");
  assert.equal(String(element("analysisReviewedExportCount").textContent), "1");
  assert.equal(element("exportAllCandidatesButton").disabled, false);
  await app.exportAll();
  await app.exportApproved();
  assert.deepEqual(exports.map(payload => payload.rows.length), [2, 1], JSON.stringify(fixture.toasts));
  element("resultSearch").value = "matches-nothing";
  app.exportCounts();
  app.handoffSummary();
  assert.equal(element("exportAllCandidatesButton").disabled, true);
  assert.equal(element("exportApprovedProductsButton").disabled, true);
  assert.equal(element("exportAnalysisHandoffButton").disabled, true);
});

test("Amazon listing fields survive mapping and successful refreshes replace dates without changing SellerSprite dates", () => {
  const { app, element } = harness();
  app.restore(snapshot(job("paused"), []));
  const old = datedCandidate(1, "2026-10-01", { listingAvailableAt: "2024-01-01", firstFba: "2024-02-01", manualFbaFee: true, fbaFee: 2 });
  const incoming = { asin: old.asin, sourceAsin: old.asin, marketplace: "AU", detailStatus: "success", detailParserVersion: 8,
    amazonFirstAvailableDate: "2026-10-12", amazonFirstAvailableDateStatus: "found", amazonFirstAvailableDateEvidence: { rawText: "12 October 2026", value: "2026-10-12" } };
  const mapped = app.mapCandidate(incoming, 0);
  assert.equal(mapped.amazonFirstAvailableDate, "2026-10-12");
  assert.equal(mapped.amazonFirstAvailableDateEvidence.rawText, "12 October 2026");
  assert.equal(mapped.listingAvailableAt, null);
  app.setProducts([old]);
  app.mergeCandidates([incoming]);
  assert.equal(old.amazonFirstAvailableDate, "2026-10-12");
  assert.equal(old.listingAvailableAt, "2024-01-01");
  assert.equal(old.fbaFee, 2);
  app.openLocalDrawer(old.id);
  assert.match(element("amazonMetrics").innerHTML, /Amazon 上架日期/);
  const failed = { ...incoming, detailStatus: "failed", detailErrorCode: "AMAZON_FETCH_TIMEOUT", amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: "unresolved" };
  app.mergeCandidates([failed]);
  assert.equal(old.amazonFirstAvailableDate, "2026-10-12");
  const absent = { ...incoming, amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: "not_provided", amazonFirstAvailableDateEvidence: null };
  app.mergeCandidates([absent]);
  assert.equal(old.amazonFirstAvailableDate, null);
  assert.equal(old.amazonFirstAvailableDateStatus, "not_provided");
  assert.equal(old.collectionLastAttempt, undefined);
  const batch = app.mergeRecords(incoming, absent);
  assert.equal(batch.amazonFirstAvailableDate, null);
  assert.equal(batch.amazonFirstAvailableDateStatus, "not_provided");
  assert.equal(app.mapCandidate({ ...incoming, amazonFirstAvailableDate: null, listingAvailableAt: "2026-10-13" }, 0).amazonFirstAvailableDate, null);
});


for (const [marketplace, currency] of [["AU", "AUD"], ["CA", "CAD"]]) {
  test(`Excel preserves the 35-column review contract and numeric/date values for ${marketplace}`, () => {
    const { app } = harness();
    const source = canonicalProduct();
    Object.assign(source, { marketplace, sourceMarketplace: marketplace, currency, id: `${marketplace}:${source.asin}`,
      amazonFirstAvailableDate: "2024-02-29", amazonFirstAvailableDateStatus: "found" });
    const saved = snapshot(job("paused"), [source]);
    saved.runState.marketplace = marketplace; saved.runState.currency = currency;
    app.restore(saved);
    const product = app.state().products[0];
    const payload = app.spreadsheet([product,
      { ...product, amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: "not_provided", listingAvailableAt: "2024-02-29" },
      { ...product, amazonFirstAvailableDate: "2024-02-30", amazonFirstAvailableDateStatus: "found" }], marketplace);
    const expected = ["商品 ID", "竞品图片", "源 ASIN", "商品名称", "生效采购件数",
      `竞品当前售价 (${currency})`, "竞品当前售价 (CNY)", `我们的售价 (${currency})`, "我们的售价 (CNY)",
      "评分", "评价数", "竞品 30 天销量", "利润计算重量 (kg)", "商品上架时间", "整套采购成本 (CNY)", "采购税率 (%)", "采购税费 (CNY)", "落地采购成本 (CNY)",
      "履约方式", `FBA 配送费 (${currency})`, "FBA 配送费 (CNY)", "空运单价 (CNY/kg)", "单件空运头程 (CNY)",
      "Amazon 佣金率 (%)", "汇损率 (%)", "营销费率 (%)", "管理费率 (%)", "退货预留率 (%)",
      `预估总成本 (${currency})`, "预估总成本 (CNY)", `预估单件利润 (${currency})`, "预估单件利润 (CNY)", "预估经营利润率 (%)", "数据采集时间", "重量来源"];
    assert.deepEqual(Array.from(payload.headers), expected);
    assert.equal(payload.layout, "reviewed-products-v1");
    assert.equal(payload.imageColumnIndex, 1);
    assert.equal(payload.columnFormats[13], "yyyy-mm-dd");
    assert.equal(payload.columnFormats.length, 35);
    assert.deepEqual(Array.from(payload.rows, row => row.length), [35, 35, 35]);
    assert.equal(payload.rows[0][13], 45351, "2024-02-29 is a numeric Excel date, independent of local timezone");
    assert.equal(payload.rows[1][13], "", "unknown Amazon date never falls back to SellerSprite");
    assert.equal(payload.rows[2][13], "");
    const row = payload.rows[0];
    assert.equal(row[4], 2);
    assert.equal(row[5], 9.99);
    assert.equal(row[7], 18);
    assert.equal(row[12], 0.1);
    assert.equal(row[14], 6);
    assert.equal(row[19], 2);
    for (const column of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21]) assert.equal(typeof row[column], "number");
    assert.equal(payload.images.length, 3);
    assert.equal(payload.images[0].url, product.imageUrl);
    assert.equal((product.amazonMissing || []).some(label => label.includes("上架")), false, "Amazon date is not a completeness requirement");
  });
}


test("focusing the calendar after midnight updates today without clearing its accepted start", async () => {
  const fixture = harness();
  fixture.app.restore(snapshot(job("paused"), [datedCandidate(1, "2026-10-13")]));
  fixture.app.dateFilters();
  fixture.element("amazonFirstAvailableFrom").value = "2026-10-01";
  fixture.app.applyDate();
  fixture.setToday("2026-10-14");
  await fixture.fire("amazonFirstAvailableFrom", "focus");
  assert.equal(fixture.element("amazonFirstAvailableFrom").max, "2026-10-14");
  assert.equal(fixture.element("amazonFirstAvailableFrom").value, "2026-10-01");
  assert.equal(fixture.app.state().activeRunCriteria.amazonFirstAvailableFrom, "2026-10-01");
  assert.equal(fixture.calls.length, 0);
});

test("the upper product-data reset clears its date filter without altering the saved source products", async () => {
  const fixture = harness();
  fixture.app.restore(snapshot(job("running"), [datedCandidate(1, "2026-10-01"), datedCandidate(2, null)]));
  fixture.app.dateFilters();
  const before = JSON.stringify(fixture.app.state().products);
  fixture.element("amazonFirstAvailableFrom").value = "2026-10-01";
  fixture.app.applyDate();
  assert.equal(fixture.app.filtered().length, 1);
  await fixture.fire("clearFiltersButton", "click");
  assert.equal(fixture.element("amazonFirstAvailableFrom").value, "");
  assert.equal(fixture.app.state().activeRunCriteria.amazonFirstAvailableFrom, "");
  assert.equal(fixture.app.filtered().length, 2);
  assert.equal(JSON.stringify(fixture.app.state().products), before);
  assert.equal(fixture.calls.length, 0);
});

test("the review template exports the effective manual weight while preserving original Amazon weight", () => {
  const { app } = harness();
  const product = canonicalProduct();
  Object.assign(product, { productWeight: 0.1, billingWeight: 0.25, manualBillingWeight: true,
    profitInputs: { ...product.profitInputs, actualWeightKg: 0.25, weightSource: "product_manual" } });
  app.restore(snapshot(job("paused"), [product]));
  const current = app.state().products[0];
  const payload = app.spreadsheet([current]);
  assert.equal(payload.rows[0][payload.headers.indexOf("利润计算重量 (kg)")], 0.25);
  assert.equal(current.productWeight, 0.1);
  assert.equal(current.billingWeight, 0.25);
  assert.equal(current.profitInputs.actualWeightKg, 0.25);
  assert.equal(current.purchaseCost, 6);
  assert.equal(current.salePrice, 18);
  assert.equal(current.fbaFee, 2);
});

test('Item Weight policy rejects package and unsourced legacy mass consistently in rows, filters, drawer and export', () => {
  for (const evidence of [null, { label: 'Package Weight', kind: 'package', value: 0.3 }]) {
    const { app, element, calls } = harness();
    const product = { ...canonicalProduct(), detailParserVersion: 11, productWeight: 0.3,
      productWeightEvidence: evidence, fbaWeight: 0.3, billingWeight: 0.3,
      profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: 0.3 } };
    app.restore(snapshot(job('paused'), [product]), { persistMigrations: false });
    app.view(null, 1, {});
    assert.match(app.row(productId), /商品及包裹重量待采集/);
    assert.doesNotMatch(app.row(productId), /Item Weight 0\.3/);
    element('resultWeightBand').value = '250_500';
    assert.equal(app.filtered().length, 0);
    app.openLocalDrawer(productId);
    const metrics = element('amazonMetrics').innerHTML;
    assert.doesNotMatch(metrics, /<dt>商品重量<\/dt><dd>0\.3/);
    assert.match(metrics, /<dt>FBA 包装重量<\/dt><dd>0\.3/);
    const current = app.state().products[0];
    const payload = app.spreadsheet([current]);
    assert.equal(payload.rows[0][payload.headers.indexOf('利润计算重量 (kg)')], '');
    assert.equal(current.profitCalculation, null);
    assert.equal(current.margin, null);
    assert.equal(current.fbaWeight, 0.3);
    assert.equal(current.purchaseCost, 6);
    assert.equal(calls.length, 0);
  }
});

test('Item Weight and manual override use the same product mass in row, drawer, filter and export', () => {
  for (const manual of [false, true]) {
    const { app, element } = harness();
    const product = { ...canonicalProduct(), detailParserVersion: 11, productWeight: 0.14,
      productWeightEvidence: { label: 'Item Weight', kind: 'product', value: 0.14 },
      fbaWeight: 0.5, billingWeight: 0.5,
      ...(manual ? { manualBillingWeight: true, billingWeight: 0.2,
        profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: 0.2, weightSource: 'product_manual' } } : {}) };
    const mass = manual ? 0.2 : 0.14;
    app.restore(snapshot(job('paused'), [product]), { persistMigrations: false });
    app.view(null, 1, {});
    assert.match(app.row(productId).replace(/<[^>]*>/g, ''), new RegExp(`${manual ? '人工重量' : 'Item Weight'}${mass}`));
    element('resultWeightBand').value = manual ? '150_250' : '100_150';
    assert.equal(app.filtered().length, 1);
    element('resultWeightBand').value = '250_500';
    assert.equal(app.filtered().length, 0);
    app.openLocalDrawer(productId);
    assert.match(element('amazonMetrics').innerHTML, new RegExp(`<dt>利润计算重量</dt><dd>${mass}`));
    const current = app.state().products[0];
    const payload = app.spreadsheet([current]);
    assert.equal(payload.rows[0][payload.headers.indexOf('利润计算重量 (kg)')], mass);
    assert.equal(current.profitCalculation.airFreight.actualWeightKg, mass);
    assert.equal(current.productWeight, 0.14);
    assert.equal(current.fbaWeight, 0.5);
    assert.equal(current.purchaseCost, 6);
  }
});

test('package fallback is labelled in row, drawer and export and drives profit without changing Item Weight', () => {
  const { app, element } = harness();
  const product = { ...canonicalProduct(), detailParserVersion: 13, productWeight: null,
    productWeightEvidence: null, fbaWeight: .06, billingWeight: null,
    packageWeightEvidence: { kind: 'package', label: 'parcel dimensions', value: .06, unit: 'kg',
      source: 'amazon_product_page', asin: 'B000000001', selector: '#detailBullets_feature_div',
      rawText: '16.5 x 15 x 1.9 cm; 60 g' } };
  app.restore(snapshot(job('completed'), [product]), { persistMigrations: false });
  app.view(null, 1, {});
  assert.match(app.row(productId).replace(/<[^>]*>/g, ''), /包裹重量0.06/);
  app.openLocalDrawer(productId);
  assert.match(element('amazonMetrics').innerHTML, /包裹重量/);
  const current = app.state().products[0];
  assert.equal(current.profitCalculation.airFreight.actualWeightKg, .06);
  assert.equal(current.productWeight, null);
  const payload = app.spreadsheet([current]);
  assert.equal(payload.rows[0][payload.headers.indexOf('利润计算重量 (kg)')], .06);
  assert.match(payload.rows[0][payload.headers.indexOf('重量来源')], /包裹重量/);
});

test('raw Item Weight-only candidates retain policy and manual override without package fallback', () => {
  const { app } = harness();
  app.restore(snapshot(job('paused'), []));
  const raw = { asin: 'B000000001', title: 'Package only', detailStatus: 'success',
    weightSelection: { policy: 'item_weight_only' }, productWeightKg: null, packageWeightKg: 0.5 };
  const mapped = app.mapCandidate(raw, 0);
  assert.equal(mapped.productWeight, null);
  assert.equal(mapped.billingWeight, null);
  assert.equal(mapped.fbaWeight, 0.5);
  assert.equal(profitModel.usesItemWeightOnly(mapped), true);
  const manual = app.mapCandidate({ ...raw, billingWeight: 0.2, manualBillingWeight: true }, 0);
  assert.equal(profitModel.resolveManualWeightOverride(manual).weightKg, 0.2);
  assert.equal(manual.fbaWeight, 0.5);
});

test('successive manual weight edits preview and save the entered mass under Item Weight policy', async () => {
  const item = { ...automaticEnvelopeProduct('AU', 18, 0.14), detailParserVersion: 11,
    productWeightEvidence: { label: 'Item Weight', kind: 'product', value: 0.14 }, fbaWeight: 0.5 };
  const { app, element, fire } = editableProfitFixture(item);
  for (const [mass, fee] of [[0.3, 5.61], [0.14, 5.26]]) {
    element('editWeight').value = String(mass);
    await fire('editWeight', 'input');
    assert.equal(app.editor().fulfillmentFee, fee);
    assert.equal(await app.saveEditorToDisk(), true);
    const product = app.state().products[0];
    assert.equal(product.billingWeight, mass);
    assert.equal(product.profitInputs.actualWeightKg, mass);
    assert.equal(product.profitCalculation.airFreight.actualWeightKg, mass);
    assert.equal(product.fbaFee, fee);
    assert.equal(product.productWeight, 0.14);
    assert.equal(product.fbaWeight, 0.5);
    assert.equal(product.purchaseCost, 6);
  }
});


const parsedAsins = (marketplace = "CA", asins = ["B09V6TRGTD", "B000000002"]) => ({
  inputMode: "asins", marketplace,
  audit: { marketplace, uniqueSellers: 0, uniqueAsins: asins.length, rawRows: asins.length, duplicates: 0, invalid: 0, resolved: 1, unresolved: 0 },
  stores: [{ marketplace, sellerId: null, sellerName: null, sellerUrl: null, asins, rowNumbers: asins.map((_, i) => i + 1), resolved: true }],
  rows: asins.map((asin, i) => ({ asin, marketplace, rowNumber: i + 1, rowNumbers: [i + 1], productUrl: `https://www.amazon.ca/dp/${asin}` })),
});

test("ASIN input mode, text and draft market changes leave a running task and manual fields untouched", async () => {
  const fixture = uploadFixture("running");
  const before = JSON.stringify(fixture.app.state());
  await fixture.fire("asinImportTab", "click");
  fixture.element("asinTextInput").value = "B09V6TRGTD";
  fixture.element("asinMarketplaceSelect").value = "CA";
  await fixture.fire("asinMarketplaceSelect", "change");
  assert.equal(fixture.app.importState().importMode, "asins");
  assert.equal(fixture.element("asinImportPanel").hidden, false);
  assert.equal(JSON.stringify(fixture.app.state()), before);
  assert.equal(fixture.app.marketState().activeMarket.code, "AU");
  assert.equal(fixture.calls.length, 0);
  fixture.app.restore(snapshot(job("running", 2)));
  assert.equal(fixture.app.importState().importMode, "asins");
  assert.equal(fixture.element("asinMarketplaceSelect").value, "CA");
  assert.equal(fixture.element("asinTextInput").value, "B09V6TRGTD");
});

test("valid ASIN text archives only after parsing, preserves the old snapshot and waits for explicit start", async () => {
  const fixture = uploadFixture("paused");
  fixture.respond(async (path, options) => {
    if (path === "/api/asin-list/parse") {
      assert.deepEqual(JSON.parse(options.body), { text: "B09V6TRGTD B000000002", marketplace: "CA" });
      assert.equal(fixture.app.state().runState.id, runId);
      return parsedAsins();
    }
    if (path === "/api/runs") {
      const saved = JSON.parse(options.body);
      assert.equal(saved.products[0].purchaseCost, 6);
      assert.equal(saved.runState.marketplace, "AU");
      return { runs: [] };
    }
    if (path === `/api/runs/${runId}/archive`) return archivedUpload();
    throw new Error(`Unexpected ${path}`);
  });
  await fixture.fire("asinImportTab", "click");
  fixture.element("asinTextInput").value = "B09V6TRGTD B000000002";
  fixture.element("asinMarketplaceSelect").value = "CA";
  await fixture.fire("importAsinsButton", "click");
  assert.deepEqual(fixture.calls.map(call => call.path), ["/api/asin-list/parse", "/api/runs", `/api/runs/${runId}/archive`]);
  assert.equal(fixture.app.importState().storeList.inputMode, "asins");
  assert.equal(fixture.app.state().runState.mode, "idle");
  assert.equal(fixture.app.marketState().activeMarket.code, "CA");
  fixture.app.renderImports(); fixture.app.availability();
  assert.equal(fixture.element("uniqueStoresMetric").textContent, "2");
  assert.equal(fixture.element("uniqueImportMetricLabel").textContent, "唯一 ASIN");
  assert.equal(fixture.element("startAnalysisButton").disabled, false);
  assert.match(fixture.element("startAnalysisButton").innerHTML, /开始采集 2 个ASIN/);
  assert.match(fixture.element("currentStoreList").innerHTML, /B09V6TRGTD/);
  assert.doesNotMatch(fixture.element("currentStoreList").innerHTML, /Seller ID|未提供/);
});

for (const code of ["INVALID_ASIN_INPUT", "ASIN_MARKETPLACE_MISMATCH"]) {
  test(`ASIN parse ${code} leaves old task and input intact without archive`, async () => {
    const fixture = uploadFixture("running");
    fixture.element("asinTextInput").value = "bad or mixed input";
    const before = JSON.stringify(fixture.app.state());
    fixture.respond(async path => {
      assert.equal(path, "/api/asin-list/parse");
      throw Object.assign(new Error("无效 ASIN 或不同站点，请修正后重试。"), { code });
    });
    await fixture.fire("importAsinsButton", "click");
    assert.equal(JSON.stringify(fixture.app.state()), before);
    assert.equal(fixture.element("asinTextInput").value, "bad or mixed input");
    assert.deepEqual(fixture.calls.map(call => call.path), ["/api/asin-list/parse"]);
  });
}

test("ASIN Excel uses the ASIN parser and the explicit draft marketplace", async () => {
  const fixture = uploadFixture("paused");
  await fixture.fire("asinImportTab", "click");
  fixture.element("asinMarketplaceSelect").value = "CA";
  fixture.respond(async (path, options) => {
    if (path === "/api/asin-list/parse") {
      assert.equal(options.headers["X-Marketplace"], "CA");
      assert.equal(options.headers["X-File-Name"], "new-stores.xlsx");
      assert.ok(options.body instanceof ArrayBuffer);
      return parsedAsins();
    }
    if (path === "/api/runs") return { runs: [] };
    if (path.endsWith("/archive")) return archivedUpload();
    throw new Error(`Unexpected ${path}`);
  });
  await fixture.fire("storeFileInput", "change");
  assert.equal(fixture.app.importState().storeList.inputMode, "asins");
  assert.equal(fixture.calls.some(call => call.path === "/api/store-list/parse"), false);
});

test("concurrent ASIN submissions make only one parse and one archive", async () => {
  const fixture = uploadFixture("running");
  let release;
  fixture.respond(async path => {
    if (path === "/api/asin-list/parse") return new Promise(resolve => { release = () => resolve(parsedAsins()); });
    if (path.endsWith("/archive")) return archivedUpload();
    throw new Error(`Unexpected ${path}`);
  });
  const first = fixture.app.importTaskSource({ text: "B09V6TRGTD", mode: "asins", marketplace: "CA" });
  const second = fixture.app.importTaskSource({ text: "B000000002", mode: "asins", marketplace: "CA" });
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, [true, false]);
  assert.equal(fixture.calls.filter(call => call.path === "/api/asin-list/parse").length, 1);
  assert.equal(fixture.calls.filter(call => call.path.endsWith("/archive")).length, 1);
});

test("review interval filters include both bounds, exclude unknown without converting it to zero, and drive exports", () => {
  const fixture = harness();
  const items = [0, 10, 20, 21, null].map((reviews, index) => imageCandidate(index + 1, { reviews, detailStatus: "success" }));
  fixture.app.restore(snapshot(job("completed"), items));
  fixture.app.useRealCriteria();
  fixture.element("minReviews").value = "10";
  fixture.element("maxReviews").value = "20";
  assert.equal(fixture.app.syncCriteria(), true);
  assert.deepEqual(Array.from(fixture.app.filtered(), product => product.reviews), [10, 20]);
  assert.deepEqual(Array.from(fixture.app.exportRows("all"), product => product.reviews), [10, 20]);
  const saved = fixture.app.capture();
  assert.equal(saved.criteria.minReviews, 10);
  assert.equal(saved.criteria.maxReviews, 20);
  assert.equal(saved.resultCriteria.maxReviews, 20);
  fixture.app.restore(saved);
  assert.equal(fixture.element("maxReviews").value, 20);
  assert.deepEqual(Array.from(fixture.app.filterReasons(items[4], { maxReviews: 20 })).filter(reason => reason.startsWith("REVIEWS")), ["REVIEWS_MISSING"]);
  assert.deepEqual(Array.from(fixture.app.filterReasons(items[0], { minReviews: 0, maxReviews: 0 })).filter(reason => reason.startsWith("REVIEWS")), []);
});

test("invalid review intervals reject before changing result filters; clearing removes both bounds", async () => {
  const fixture = harness();
  fixture.app.restore(snapshot(job("completed")));
  fixture.app.useRealCriteria();
  const before = JSON.stringify(fixture.app.state().activeRunCriteria);
  for (const [min, max] of [["20", "10"], ["-1", ""], ["", "1.5"], ["", "9007199254740992"]]) {
    fixture.element("minReviews").value = min; fixture.element("maxReviews").value = max;
    assert.equal(fixture.app.syncCriteria(), false);
    assert.equal(JSON.stringify(fixture.app.state().activeRunCriteria), before);
  }
  fixture.element("minReviews").value = "10"; fixture.element("maxReviews").value = "20";
  fixture.app.syncCriteria(); fixture.app.dateFilters();
  fixture.respond(async path => { assert.equal(path, "/api/runs"); return { runs: [] }; });
  await fixture.fire("clearFiltersButton", "click");
  await fixture.app.settleSaves();
  assert.equal(fixture.element("minReviews").value, "");
  assert.equal(fixture.element("maxReviews").value, "");
  assert.equal(fixture.app.state().activeRunCriteria.minReviews, null);
  assert.equal(fixture.app.state().activeRunCriteria.maxReviews, null);
});


test("explicit ASIN start persists direct mode and review bounds before transferring the exact batch to background collection", async () => {
  const fixture = harness();
  const saved = snapshot(job("completed"), []);
  saved.storeList = parsedAsins("AU");
  saved.runState.inputMode = "asins";
  fixture.app.restore(saved); fixture.app.known(true); fixture.app.useRealCriteria();
  fixture.element("minReviews").value = "10"; fixture.element("maxReviews").value = "20";
  const nextJob = { ...job("queued", 1), runId: "new-synthetic-run" };
  let nextSnapshot;
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") {
      nextSnapshot = JSON.parse(options.body);
      assert.equal(nextSnapshot.runState.inputMode, "asins");
      assert.equal(nextSnapshot.storeList.inputMode, "asins");
      assert.equal(nextSnapshot.criteria.maxReviews, 20);
      assert.deepEqual(nextSnapshot.storeList.stores[0].asins, ["B09V6TRGTD", "B000000002"]);
      assert.equal(nextSnapshot.storeList.stores[0].sellerId, null);
      return { runs: [] };
    }
    if (path === "/api/amazon/collection/start") return nextJob;
    if (path === `/api/runs/${nextJob.runId}`) return { ...nextSnapshot, amazonCollection: nextJob };
    throw new Error(`Unexpected ${path}`);
  });
  await fixture.app.run();
  assert.deepEqual(fixture.calls.map(call => call.path), ["/api/runs", "/api/amazon/collection/start", `/api/runs/${nextJob.runId}`]);
  assert.equal(fixture.app.state().runState.inputMode, "asins");
});

test("ASIN provider requests explicitly preserve input mode, source ASINs and both review bounds", async () => {
  const fixture = harness();
  const saved = snapshot(null, []);
  saved.storeList = parsedAsins("AU");
  saved.criteria = { useSellerSprite: true, monthlySalesBand: "all", minReviews: 10, maxReviews: 20 };
  saved.runState.inputMode = "asins";
  saved.runState.analysisSourceMode = "amazon_sellsprite";
  fixture.app.restore(saved); fixture.app.known(true);
  fixture.respond(async (path, options) => {
    if (path === "/api/runs") return { runs: [] };
    assert.equal(path, "/api/products/search");
    const body = JSON.parse(options.body);
    assert.equal(body.inputMode, "asins");
    assert.equal(body.stores[0].sellerId, null);
    assert.deepEqual(body.stores[0].asins, ["B09V6TRGTD", "B000000002"]);
    assert.equal(body.filters.minReviews, 10); assert.equal(body.filters.maxReviews, 20);
    if (body.phase === "discover") {
      assert.equal(body.useSellerSprite, false);
      return { discoveryComplete: true, items: [], errors: [], unresolved: [], storeVisits: [{ storeIndex: 0, sellerId: null,
        asins: body.stores[0].asins, status: "not_required", complete: true, discoveredAsins: 2, reportedTotalAsins: 2 }] };
    }
    assert.equal(body.phase, "analyze");
    assert.equal(body.useSellerSprite, true);
    return { discoveryComplete: true, items: [], errors: [], unresolved: [], analysisAudit: { uniqueAsins: 0, retainedSourceAsins: 0 },
      storeVisits: [{ storeIndex: 0, sellerId: null, asins: body.stores[0].asins, status: "not_required", complete: true, discoveredAsins: 2 }] };
  });
  await fixture.app.fetchProvider();
  assert.deepEqual(fixture.calls.filter(call => call.path === "/api/products/search").map(call => call.body.phase), ["discover", "analyze"]);
  assert.equal(fixture.calls.some(call => call.path.includes("/sellsprite/")), false);
});

test("saved row review limits intersect with both current result bounds and report an empty intersection", () => {
  const fixture = harness();
  const saved = snapshot(job("completed"), [imageCandidate(1, { reviews: 10 }), imageCandidate(2, { reviews: 15 }), imageCandidate(3, { reviews: 20 })]);
  saved.storeList.stores[0].criteria = { minReviews: 12, maxReviews: 30 };
  fixture.app.restore(saved);
  fixture.app.view(null, 1, { minReviews: 0, maxReviews: 15 });
  assert.deepEqual(Array.from(fixture.app.filtered(), item => item.reviews), [15]);
  fixture.app.view(null, 1, { minReviews: 0, maxReviews: 10 });
  assert.equal(fixture.app.filtered().length, 0);
});


for (const marker of ["manualAmazonFields", "fieldSources"]) {
  for (const replacement of ["different_date", "not_provided", "failed"]) {
    test(`manual listing date survives ${replacement} browser merges when protected by ${marker}`, () => {
      const { app } = harness();
      app.restore(snapshot(job("paused"), []));
      const original = datedCandidate(1, "2025-01-03", {
        amazonFirstAvailableDateStatus: "manual",
        amazonFirstAvailableDateEvidence: { source: "manual", value: "2025-01-03", note: "Verified by user" },
        manualAmazonFields: marker === "manualAmazonFields" ? { amazonFirstAvailableDate: true } : {},
        fieldSources: marker === "fieldSources" ? { amazonFirstAvailableDate: "manual" } : { amazonFirstAvailableDate: "amazon_product_page" },
      });
      const incoming = { asin: original.asin, sourceAsin: original.asin, marketplace: "AU",
        detailStatus: replacement === "failed" ? "failed" : "success",
        detailErrorCode: replacement === "failed" ? "AMAZON_FETCH_TIMEOUT" : null,
        amazonFirstAvailableDate: replacement === "different_date" ? "2026-10-01" : null,
        amazonFirstAvailableDateStatus: replacement === "different_date" ? "found" : replacement === "failed" ? "unresolved" : "not_provided",
        amazonFirstAvailableDateEvidence: replacement === "different_date" ? { value: "2026-10-01", source: "amazon_product_page" } : null,
        fieldSources: { amazonFirstAvailableDate: "amazon_product_page" },
      };
      const merged = app.mergeRecords(original, incoming);
      app.setProducts([structuredClone(original)]); app.mergeCandidates([incoming]);
      for (const result of [merged, app.state().products[0]]) {
        assert.equal(result.amazonFirstAvailableDate, "2025-01-03");
        assert.equal(result.amazonFirstAvailableDateStatus, "manual");
        assert.deepEqual(structuredClone(result.amazonFirstAvailableDateEvidence), original.amazonFirstAvailableDateEvidence);
        assert.equal(result.fieldSources.amazonFirstAvailableDate, "manual");
        assert.equal(result.manualAmazonFields.amazonFirstAvailableDate, true);
      }
    });
  }
}

test("new manual listing date wins over older manual data in both frontend merge paths and mapping retains its flag", () => {
  const { app } = harness();
  app.restore(snapshot(job("paused"), []));
  const original = datedCandidate(1, "2025-01-03", { manualAmazonFields: { amazonFirstAvailableDate: true }, fieldSources: { amazonFirstAvailableDate: "manual" } });
  const incoming = { asin: original.asin, sourceAsin: original.asin, marketplace: "AU", detailStatus: "success",
    amazonFirstAvailableDate: "2025-03-09", amazonFirstAvailableDateStatus: "manual",
    amazonFirstAvailableDateEvidence: { source: "manual", value: "2025-03-09" }, manualAmazonFields: { amazonFirstAvailableDate: true } };
  assert.equal(app.mapCandidate(incoming, 0).manualAmazonFields.amazonFirstAvailableDate, true);
  const merged = app.mergeRecords(original, incoming);
  app.setProducts([original]); app.mergeCandidates([incoming]);
  for (const result of [merged, app.state().products[0]]) {
    assert.equal(result.amazonFirstAvailableDate, "2025-03-09");
    assert.equal(result.amazonFirstAvailableDateStatus, "manual");
    assert.equal(result.fieldSources.amazonFirstAvailableDate, "manual");
    assert.deepEqual(structuredClone(result.amazonFirstAvailableDateEvidence), incoming.amazonFirstAvailableDateEvidence);
  }
});


const withExcelAsinProjection = (saved, data = parsedAsins("AU", ["B09V6TRGTD", "B000000002"])) => {
  saved.storeList.fileName = "current-upload.xlsx";
  data.audit.sourceColumn = "asin";
  saved.storeList.directAsinInput = { version: 1, source: "uploaded_excel_asin_column", status: "ready", data };
  return saved;
};

for (const status of ["running", "paused", "needs_attention"]) {
  test(`selecting ASIN mode then start replaces ${status} store run with only original Excel ASINs and never resumes it`, async () => {
    const fixture = harness();
    const saved = withExcelAsinProjection(snapshot(job(status)));
    saved.storeList.stores = Array.from({ length: 5 }, (_, index) => ({ marketplace: "AU", sellerId: `SELLER${index}`, asins: ["B999999999"] }));
    saved.storeList.audit.uniqueSellers = 5;
    fixture.app.restore(saved); fixture.app.bindUpload(); fixture.app.known(true);
    let nextSnapshot;
    const nextJob = { ...job("queued", 1), runId: "new-synthetic-run" };
    fixture.respond(async (path, options) => {
      if (path === "/api/runs") {
        const body = JSON.parse(options.body);
        if (body.runState.id === nextJob.runId) {
          nextSnapshot = body;
          assert.equal(body.runState.inputMode, "asins");
          assert.equal(body.products.length, 0);
          assert.deepEqual(body.storeList.stores[0].asins, ["B09V6TRGTD", "B000000002"]);
          assert.equal(body.storeList.stores[0].sellerId, null);
          assert.equal(body.runState.amazonCollectionJob, undefined);
        } else assert.equal(body.runState.id, runId);
        return { runs: [] };
      }
      if (path === `/api/runs/${runId}/archive`) return archivedUpload();
      if (path === "/api/amazon/collection") return null;
      if (path === "/api/amazon/collection/start") {
        assert.deepEqual(JSON.parse(options.body), { runId: nextJob.runId });
        return nextJob;
      }
      if (path === `/api/runs/${nextJob.runId}`) return { ...nextSnapshot, amazonCollection: nextJob };
      throw new Error(`Unexpected request ${path}`);
    });
    await fixture.fire("asinImportTab", "click");
    assert.equal(fixture.calls.length, 0, "mode switch is a local preview only");
    fixture.app.availability();
    assert.equal(fixture.element("startAnalysisButton").disabled, false);
    assert.match(fixture.element("startAnalysisButton").innerHTML, /新 ASIN.*2/);
    assert.equal(fixture.element("importMetrics").hidden, true);
    assert.equal(fixture.element("storeManager").hidden, true);
    assert.match(fixture.element("selectedInputSummary").textContent, /2 个唯一 ASIN/);
    assert.doesNotMatch(fixture.element("selectedInputSummary").textContent, /SELLER|B999999999/);
    await fixture.app.run();
    assert.ok(nextSnapshot);
    assert.equal(fixture.calls.some(call => call.path === "/api/amazon/collection/control"), false);
    assert.equal(fixture.calls.filter(call => call.path.endsWith("/archive")).length, 1);
    assert.equal(fixture.calls.filter(call => call.path === "/api/amazon/collection/start").length, 1);
    assert.equal(fixture.app.state().runState.id, nextJob.runId);
    assert.equal(fixture.app.state().products.length, 0);
  });
}

for (const state of ["legacy", "empty", "invalid"]) {
  test(`selected ASIN start with ${state} Excel scope neither resumes nor archives a previous task`, async () => {
    const fixture = harness();
    const saved = snapshot(job("paused"));
    if (state !== "legacy") saved.storeList.directAsinInput = { version: 1, source: "uploaded_excel_asin_column", status: "unavailable", data: null,
      error: { code: "INVALID_ASIN_INPUT", message: state === "empty" ? "ASIN 列为空" : "ASIN 格式无效" } };
    fixture.app.restore(saved); fixture.app.bindUpload(); fixture.app.known(true);
    const before = JSON.stringify(fixture.app.state());
    await fixture.fire("asinImportTab", "click"); fixture.app.availability();
    assert.equal(fixture.element("startAnalysisButton").disabled, true);
    await fixture.app.run();
    assert.equal(JSON.stringify(fixture.app.state()), before);
    assert.equal(fixture.calls.length, 0);
    assert.match(fixture.toasts.at(-1)[0], /ASIN|Excel/);
  });
}

test("an available current workbook is parsed only for preview and unsupported store-only data cannot become ASIN scope", async () => {
  const fixture = uploadFixture("paused");
  fixture.app.setSelectedFile(fixture.element("storeFileInput").files[0]);
  fixture.respond(async path => {
    assert.equal(path, "/api/asin-list/parse");
    throw Object.assign(new Error("文件只有店铺链接，没有商品 ASIN"), { code: "INVALID_ASIN_INPUT" });
  });
  await fixture.fire("asinImportTab", "click"); await fixture.app.settleAsinPreview();
  fixture.app.availability();
  assert.equal(fixture.element("startAnalysisButton").disabled, true);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls.some(call => call.path.endsWith("/archive")), false);
  assert.equal(fixture.app.state().runState.id, runId);
});

test("reloaded original Excel ASIN projection is usable without file bytes and remains limited to its ASIN column", async () => {
  const saved = withExcelAsinProjection(snapshot(job("paused")));
  const fixture = harness(); fixture.app.restore(JSON.parse(JSON.stringify(saved))); fixture.app.bindUpload();
  await fixture.fire("asinImportTab", "click");
  fixture.app.availability();
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.element("startAnalysisButton").disabled, false);
  assert.match(fixture.element("selectedInputSummary").textContent, /current-upload.xlsx.*ASIN 列.*AU.*2 个/);
  assert.equal(fixture.app.capture().storeList.directAsinInput.data.audit.sourceColumn, "asin");
});

test("fresh single-column product links produce an explicit marketplace preview without enumeration", async () => {
  const fixture = uploadFixture("paused");
  fixture.app.setSelectedFile(fixture.element("storeFileInput").files[0]);
  fixture.respond(async path => {
    assert.equal(path, "/api/asin-list/parse");
    const data = parsedAsins("AU", ["B09V6TRGTD"]);
    data.audit.sourceColumn = "product_url"; data.audit.sourceFormat = "headerless_single_column";
    return data;
  });
  await fixture.fire("asinImportTab", "click"); await fixture.app.settleAsinPreview(); fixture.app.availability();
  assert.equal(fixture.element("startAnalysisButton").disabled, false);
  assert.match(fixture.element("selectedInputSummary").textContent, /商品链接.*AU.*1 个唯一 ASIN/);
  assert.deepEqual(fixture.calls.map(call => call.path), ["/api/asin-list/parse"]);
});


for (const oldMode of ["stores", "asins"]) {
  test(`invalid replacement file blocks start for an old ${oldMode} task until the user explicitly discards it`, async () => {
    const fixture = harness();
    const saved = withExcelAsinProjection(snapshot(job("paused")));
    if (oldMode === "asins") saved.storeList = parsedAsins("AU");
    fixture.app.restore(saved); fixture.app.bindUpload(); fixture.app.known(true);
    await fixture.fire("asinImportTab", "click");
    fixture.element("storeFileInput").files = [{ name: "invalid-new-asins.xlsx", arrayBuffer: async () => new ArrayBuffer(4) }];
    fixture.respond(async path => {
      assert.equal(path, "/api/asin-list/parse");
      throw Object.assign(new Error("新文件 ASIN 格式无效"), { code: "INVALID_ASIN_INPUT" });
    });
    await fixture.fire("storeFileInput", "change");
    fixture.app.availability();
    assert.equal(fixture.element("startAnalysisButton").disabled, true);
    assert.match(fixture.element("selectedInputSummary").textContent, /invalid-new-asins.xlsx.*ASIN 格式无效/);
    await fixture.app.run();
    assert.deepEqual(fixture.calls.map(call => call.path), ["/api/asin-list/parse"]);
    assert.equal(fixture.app.state().runState.id, runId);
    assert.equal(fixture.app.state().products[0].purchaseCost, 6);
    await fixture.fire("discardImportDraftButton", "click"); fixture.app.availability();
    assert.equal(fixture.app.importState().importMode, oldMode);
    assert.equal(fixture.element("selectedInputSummary").hidden, true);
    assert.equal(fixture.calls.length, 1, "discarding a draft does not start or resume anything");
  });
}

test("persisted direct-product projection supports an uploaded headerless URL workbook without using seller scope", async () => {
  const fixture = harness();
  const saved = snapshot(job("paused"));
  const data = parsedAsins("AU", ["B09V6TRGTD"]);
  data.audit.sourceColumn = "product_url"; data.audit.sourceFormat = "headerless_single_column";
  saved.storeList.fileName = "ASIN测试数据集.xlsx";
  saved.storeList.directAsinInput = { version: 1, source: "uploaded_excel_direct_products", status: "ready", data };
  fixture.app.restore(saved); fixture.app.bindUpload();
  await fixture.fire("asinImportTab", "click"); fixture.app.availability();
  assert.equal(fixture.element("startAnalysisButton").disabled, false);
  assert.match(fixture.element("selectedInputSummary").textContent, /ASIN测试数据集.xlsx.*商品链接.*AU.*1 个唯一 ASIN/);
  assert.equal(fixture.calls.length, 0);
});

function directAsinSnapshot(items, { legacy = false, band = "100_plus" } = {}) {
  const saved = snapshot(job("completed"), items);
  if (!legacy) saved.runState.inputMode = "asins";
  saved.storeList = parsedAsins("AU", items.map(product => product.asin));
  saved.criteria = { useSellerSprite: false, monthlySalesBand: band, minReviews: null, maxReviews: null, minRating: null };
  saved.resultCriteria = { ...saved.criteria };
  saved.amazonCollection.items = [];
  return saved;
}

for (const legacy of [false, true]) test(`restored ${legacy ? "source-list legacy" : "persisted"} ASIN task restores monthly screening while retaining low/unknown source records`, () => {
  const fixture = harness();
  const rows = [0, 20, null, 60, 120].map((sales30, index) => imageCandidate(index + 1, {
    sales30, sales30Evidence: sales30 === null ? null : { source: "amazon_product_page", period: "past_month", kind: "lower_bound", value: sales30, rawText: `${sales30}+ bought in past month`, asin: `B${String(index + 1).padStart(9, "0")}` },
    filterMatch: false, filterExclusionReasons: [sales30 === null ? "MONTHLY_SALES_EVIDENCE_MISSING" : "MONTHLY_SALES_BELOW_100"],
  }));
  const saved = directAsinSnapshot(rows, { legacy });
  saved.storeList.stores[0].criteria = { monthlySalesBand: "50_to_100" };
  fixture.app.restore(saved, { persistMigrations: false });
  fixture.app.setImportMode("stores");
  const before = JSON.stringify(fixture.app.state().products.map(product => [product.sales30, product.sales30Evidence, product.filterMatch, product.filterExclusionReasons]));
  fixture.app.renderResults();
  assert.equal(fixture.app.taskMode(), "asins");
  assert.equal(fixture.app.filtered().length, 1);
  assert.equal(fixture.app.filtered()[0].id, rows[4].id);
  assert.equal(String(fixture.element("totalCandidateCount").textContent), "5");
  assert.equal(String(fixture.element("navCandidateCount").textContent), "5");
  assert.equal(String(fixture.element("visibleCount").textContent), "1");
  assert.equal(String(fixture.element("filteredAsinCount").textContent), "4");
  assert.equal(fixture.element("monthlySalesBand").disabled, false);
  assert.equal(fixture.element("monthlySalesFilter").hidden, false);
  assert.match(fixture.element("monthlySalesAdmissionNote").textContent, /默认显示全部商品/);
  assert.match(fixture.element("monthlySalesCoverage").textContent, /已取得 4 \/ 5.*达到 50：2.*低于 50：2.*未知：1/);
  assert.equal(JSON.stringify(fixture.app.state().products.map(product => [product.sales30, product.sales30Evidence, product.filterMatch, product.filterExclusionReasons])), before, "rendering never fabricates sales or rewrites saved evidence/filter flags");
  assert.equal(fixture.app.handoffInput().runState.inputMode, "asins");
  assert.equal(fixture.calls.length, 0, "restoration and filtering do not retry or save a completed collection");
});

test("switching to the ASIN import draft does not loosen an existing store task's monthly admission", async () => {
  const fixture = harness();
  const rows = [imageCandidate(1, { sales30: null, sales30Evidence: null }), imageCandidate(2, { sales30: 60 }), imageCandidate(3, { sales30: 120 })];
  const saved = directAsinSnapshot(rows);
  saved.runState.inputMode = "stores";
  saved.storeList.inputMode = "stores";
  fixture.app.restore(saved, { persistMigrations: false });
  fixture.app.setImportMode("asins");
  await fixture.app.settleAsinPreview();
  fixture.app.renderResults();
  assert.equal(fixture.app.importState().importMode, "asins");
  assert.equal(fixture.app.taskMode(), "stores");
  assert.deepEqual(Array.from(fixture.app.filtered(), product => product.asin), [rows[2].asin]);
  assert.equal(fixture.element("monthlySalesBand").disabled, false);
  assert.equal(fixture.element("monthlySalesFilter").hidden, false);
  assert.equal(fixture.app.handoffInput().runState.inputMode, "stores");
  assert.equal(fixture.calls.length, 0);
});

test("ASIN direct candidates keep review range, rating, date, weight, completion, margin and search filters aligned with exports and matching", async () => {
  const fixture = harness();
  const { app, element } = fixture;
  const base = { sales30: 120, complete: true, margin: 35, productWeight: 0.12, billingWeight: 0.12, reviews: 33, rating: 4.5, reviewStatus: "approved" };
  const rows = [datedCandidate(1, "2026-10-01", base), datedCandidate(2, "2026-10-13", { ...base, reviewStatus: "pending" }),
    datedCandidate(3, "2026-10-12", { ...base, reviews: 10 }), datedCandidate(4, "2026-10-12", { ...base, reviews: 51 }),
    datedCandidate(5, "2026-10-12", { ...base, rating: 2 }), datedCandidate(6, "2026-09-01", base),
    datedCandidate(7, null, base), datedCandidate(8, "2026-10-12", { ...base, productWeight: 0.3 }),
    datedCandidate(9, "2026-10-12", { ...base, complete: false }), datedCandidate(10, "2026-10-12", { ...base, margin: 5 }),
    datedCandidate(11, "2026-10-12", { ...base, name: "Red product", englishName: "Red product" })];
  app.restore(directAsinSnapshot([]), { persistMigrations: false });
  app.setProducts(rows);
  app.view(null, 1, { monthlySalesBand: "100_plus", minReviews: 20, maxReviews: 50, minRating: 4, amazonFirstAvailableFrom: "2026-10-01" });
  element("resultWeightBand").value = "100_150"; element("resultsCompleteToggle").checked = true;
  element("resultMinMargin").value = "20"; element("resultSearch").value = "blue";
  const expected = rows.slice(0, 2).map(product => product.id);
  assert.deepEqual(Array.from(app.filtered(), product => product.id), expected);
  assert.deepEqual(Array.from(app.matching(), product => product.id), expected);
  assert.deepEqual(Array.from(app.exportRows(), product => product.id), expected);
  app.exportCounts();
  assert.equal(String(element("exportAllCandidateCount").textContent), "2");
  assert.equal(String(element("exportApprovedProductCount").textContent), "1");
  await app.exportAll(); await app.exportApproved();
  assert.deepEqual(fixture.exports.map(payload => payload.rows.length), [2, 1]);
});

test("ASIN fixed supplier cohort filters low/unknown sales without changing the saved selection", () => {
  const fixture = harness();
  const rows = [imageCandidate(1, { sales30: null, sales30Evidence: null }), imageCandidate(2, { sales30: 0 }), imageCandidate(3, { sales30: 20 })];
  fixture.app.restore(directAsinSnapshot(rows), { persistMigrations: false });
  fixture.app.setPipeline({ status: "paused", productIds: [rows[0].id, rows[1].id], remaining: 2 });
  assert.deepEqual(Array.from(fixture.app.pending(), product => product.id), []);
  assert.equal(fixture.app.matching().length, 0);
  assert.equal(fixture.app.capture().runState.supplier1688Pipeline.productIds.length, 2);
  assert.equal(fixture.calls.length, 0);
});

for (const route of ["drawer", "manual"]) {
  for (const inputMode of ["asins", "stores"]) test(`${inputMode} ${route} preliminary approval respects task-specific monthly admission`, () => {
    const fixture = harness();
    const product = pageWithoutWeight({ sales30: null, sales30Evidence: null });
    const saved = directAsinSnapshot([product]);
    saved.runState.inputMode = inputMode; saved.storeList.inputMode = inputMode;
    fixture.app.restore(saved, { persistMigrations: false });
    fixture.app.openLocalDrawer(productId);
    if (route === "manual") { fixture.app.openManual(); fixture.app.approveManual(); }
    else fixture.app.approve();
    const result = fixture.app.state().products[0];
    assert.equal(result.reviewStatus, "pending");
    assert.equal(result.sales30, null);
    assert.equal(result.sales30Evidence, null);
  });
}

test("ASIN qualifying monthly sales permit minimum-tier approval while retaining unverified weight", () => {
  const fixture = harness();
  fixture.app.restore(directAsinSnapshot([pageWithoutWeight({ detailStatus: "failed" })]), { persistMigrations: false });
  fixture.app.openLocalDrawer(productId);
  assert.equal(fixture.element("approveProductButton").disabled, false);
  fixture.app.approve();
  assert.equal(fixture.app.state().products[0].reviewStatus, "approved");
  assert.equal(fixture.app.state().products[0].productWeight, null);
  assert.equal(fixture.app.state().products[0].detailStatus, "failed");
  assert.equal(fixture.app.state().products[0].margin, null);
});

test('access pause exposes the original product link and manual instructions without dispatching requests', () => {
  const h = harness();
  const saved = snapshot({ ...job('needs_attention'), causeCode: 'AMAZON_ACCESS_CHALLENGE' }, [{ ...canonicalProduct(), detailStatus: 'failed', detailErrorCode: 'AMAZON_ACCESS_CHALLENGE', detailError: 'Amazon browser page requires access verification.' }]);
  saved.storeList.stores[0].asins = ['B000000001'];
  saved.storeList.stores[0].productUrls = { B000000001: 'https://www.amazon.com.au/product/dp/B000000001?th=1' };
  h.app.restore(saved);
  h.app.render();
  assert.match(h.element('collectionAccessProducts').innerHTML, /https:\/\/www.amazon.com.au\/product\/dp\/B000000001\?th=1/);
  assert.match(h.element('collectionAccessProducts').innerHTML, /data-copy-amazon-url/);
  assert.match(h.element('collectionAccessProducts').innerHTML, /新标签页/);
  assert.match(h.element('collectionAccessProducts').innerHTML, /未保存验证页面证据/);
  assert.equal(h.element('collectionAccessResumeButton').disabled, true);
  assert.equal(h.calls.length, 0);
});

test('access recovery controls stay unavailable for a different task and an active worker', () => {
  const h = harness();
  h.app.restore(snapshot());
  h.app.apply({...job('needs_attention'), runId:'another-task', causeCode:'AMAZON_ACCESS_CHALLENGE'});
  h.app.render();
  assert.equal(h.element('collectionAccessPanel').hidden, true);
  assert.equal(h.element('collectionAccessResumeButton').disabled, true);
});


test('manual access resume requires a deliberate checkbox and preserves the original run and manual values', async () => {
  const h = harness();
  const blocked = {...job('needs_attention'), causeCode:'AMAZON_ACCESS_CHALLENGE'};
  h.app.restore(snapshot(blocked));
  h.app.bindCollection();
  await h.fire('collectionAccessResumeButton', 'click');
  assert.equal(h.calls.length, 0);
  h.element('collectionAccessConfirmed').checked = true;
  await h.fire('collectionAccessConfirmed', 'change');
  assert.equal(h.element('collectionAccessResumeButton').disabled, false);
  h.respond(async (path, options) => {
    if (path === '/api/runs') {
      const saved = JSON.parse(options.body);
      assert.equal(saved.products[0].purchaseCost, 6);
      assert.equal(saved.products[0].salePrice, 18);
      return {runs:[]};
    }
    if (path === '/api/amazon/collection/control') {
      assert.deepEqual(JSON.parse(options.body), {runId,action:'resume'});
      return job('running',2);
    }
    return snapshot(job('running',2));
  });
  await h.fire('collectionAccessResumeButton', 'click');
  assert.equal(h.calls.filter(call => call.path.endsWith('/control')).length, 1);
  assert.equal(h.app.state().runState.id,runId);
  assert.equal(h.element('collectionAccessPanel').hidden,true);
  assert.equal(h.element('collectionAccessConfirmed').checked,false);
});

test('new access failure revision clears prior confirmation, and active worker cannot be resumed', () => {
  const h=harness();
  h.app.restore(snapshot({...job('needs_attention',2),causeCode:'AMAZON_ACCESS_CHALLENGE'}));
  h.element('collectionAccessConfirmed').checked=true;
  h.app.render();
  h.app.apply({...job('needs_attention',3),causeCode:'AMAZON_ACCESS_CHALLENGE',workerActive:true});
  h.app.render();
  assert.equal(h.element('collectionAccessConfirmed').checked,false);
  h.element('collectionAccessConfirmed').checked=true;
  h.app.render();
  assert.equal(h.element('collectionAccessResumeButton').disabled,true);
  assert.equal(h.calls.length,0);
});

test('CA dimensions-only profit reaches drawer, editor and handoff with a volumetric label', () => {
  const { app, element } = harness();
  const original = { ...canonicalProduct(), marketplace: 'CA', sourceMarketplace: 'CA', detailParserVersion: 13,
    productWeight: null, fbaWeight: null, billingWeight: null, manualFbaFee: false, fbaFee: null,
    productDimensions: '20 x 10 x 6 cm', profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: null } };
  app.restore(snapshot(job('completed'), [original]), { persistMigrations: false });
  app.openLocalDrawer(productId);
  const product = app.state().products[0];
  assert.equal(product.fbaEstimate.selectedWeightSource, 'dimensional');
  assert.equal(product.fbaEstimate.calculationWeightKg, 1200 / 5021.69);
  assert.ok(Number.isFinite(product.margin));
  assert.equal(product.profitInputs.actualWeightKg, null);
  assert.ok(!product.missing.includes('计费重量'));
  assert.match(element('amazonMetrics').innerHTML, /加拿大体积重/);
  assert.match(element('amazonMetrics').innerHTML, /5021\.69/);
  assert.match(element('costBreakdown').innerHTML, /加拿大体积重/);
  assert.equal(element('editWeight').value, '');
  assert.equal(app.editor().fulfillmentFee, product.fbaFee);
  app.openManual();
  assert.equal(element('manualCostApproveButton').disabled, false);
  const exported = handoff.evaluateAnalysisProduct(product, { runState: { marketplace: 'CA', inputMode: 'asins' } });
  assert.equal(exported.preliminary_profit.inputs.actualWeightKg, null);
  assert.equal(exported.preliminary_profit.inputs.dimensionalWeightEstimateKg, 1200 / 5021.69);
  assert.ok(exported.preliminary_profit.result);
});

test('AU dimensions alone estimate FBA and profit while real weight stays unknown', () => {
  const { app, element } = harness();
  app.restore(snapshot(job('completed'), [{ ...pageWithoutWeight(), productDimensions: '20 x 10 x 2 cm' }]));
  app.openLocalDrawer(productId);
  const product = app.state().products[0];
  assert.ok(Number.isFinite(product.fbaFee));
  assert.ok(Number.isFinite(product.margin));
  assert.equal(product.fbaEstimate.dimensionalWeightKg, 400 / 6000);
  assert.equal(product.profitInputs.actualWeightKg, null);
  assert.equal(product.fbaEstimate.selectionStatus, 'single_source_estimate');
  assert.ok(!product.amazonMissing.includes('商品重量、包裹重量及尺寸均缺失'));
  assert.doesNotMatch(element('amazonMetrics').innerHTML, /加拿大体积重/);
  assert.match(element('amazonMetrics').innerHTML, /6000/);
  assert.match(element('amazonMetrics').innerHTML, /缺少交叉核验/);
});
