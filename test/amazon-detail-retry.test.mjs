import * as salesPolicy from "../lib/monthly-sales-policy.mjs";
import * as listingDate from "../lib/amazon-listing-date.mjs";
import * as reviewRange from "../lib/review-range.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as detailRetry from "../lib/amazon-detail-retry.mjs";
import * as priceState from "../lib/amazon-price-state.mjs";
import * as profitModel from "../lib/profit-model.mjs";
import * as pieceCount from "../lib/title-piece-count.mjs";
import * as handoff from "../lib/analysis-handoff.mjs";
import * as coverage from "../lib/analysis-coverage.mjs";

function absentInformationItem(version = 3) {
  const asin = "B09NXS1BLL";
  const selector = "#productDetails";
  return {
    asin, sourceAsin: asin, detailStatus: "success", amazonFirstAvailableDateStatus: "not_provided",
    collectionQuality: { fields: { weight: { status: "missing", reason: "product_information_incomplete" } } },
    productInformation: { version: 1, asin, status: "complete", reason: null, weightStatus: "not_provided", rowCount: 1,
      sections: [{ selector, rows: [{ label: "Brand", value: "Fixture" }] }],
      inspection: { version, asin, status: "complete", stable: true, rowCount: 1,
        sections: [{ selector, rowCount: 1, status: "complete", busy: false, closed: false }],
        parsedSections: [{ selector, rowCount: 1 }] } },
  };
}

test("obsolete absence inspection can use the existing recovery budget for missing weight or date", () => {
  for (const missing of ["weight", "date"]) {
    const item = absentInformationItem(2);
    if (missing === "weight") item.amazonFirstAvailableDateStatus = "found";
    else item.collectionQuality.fields.weight.status = "verified";
    const before = structuredClone(item);
    assert.equal(detailRetry.amazonCollectionRecoveryReason(item)?.reasonCode, "AMAZON_PRODUCT_INFORMATION_INCOMPLETE", missing);
    assert.deepEqual(item, before, "Eligibility evaluation must not rewrite saved evidence or retry counters.");
  }
});

test("current complete absence remains final and does not schedule another visit", () => {
  assert.equal(detailRetry.amazonCollectionRecoveryReason(absentInformationItem(3)), null);
});

test("obsolete absence cannot override manual weight/date decisions or an access restriction", () => {
  for (const manual of [
    { manualWeight: true }, { manualProductWeight: true }, { manualAmazonFields: { productWeightKg: true } },
    { fieldSources: { productWeightKg: "manual" } },
  ]) {
    const item = { ...absentInformationItem(2), ...manual, amazonFirstAvailableDateStatus: "found" };
    assert.equal(detailRetry.amazonCollectionRecoveryReason(item), null);
  }
  const manualDate = absentInformationItem(2);
  manualDate.collectionQuality.fields.weight.status = "verified";
  manualDate.manualAmazonFields = { amazonFirstAvailableDate: true };
  assert.equal(detailRetry.amazonCollectionRecoveryReason(manualDate), null);
  for (const code of ["AMAZON_ACCESS_CHALLENGE", "AMAZON_HTTP_429", "AMAZON_LOGIN_REQUIRED", "USER_PAUSED"]) {
    assert.equal(detailRetry.amazonCollectionRecoveryReason(absentInformationItem(2), { lastCode: code }), null);
  }
});

test("transient detail failures get exactly two additional retries", () => {
  assert.deepEqual(detailRetry.decideAmazonDetailRetry(), { action: "retry", retriesUsed: 1 });
  assert.deepEqual(detailRetry.decideAmazonDetailRetry({ retriesUsed: 1 }), { action: "retry", retriesUsed: 2 });
  assert.equal(detailRetry.decideAmazonDetailRetry({ retriesUsed: 2 }).action, "pause");
});

test("challenge and throttling pause immediately instead of consuming a retry", () => {
  for (const input of [{ codes: ["AMAZON_ACCESS_CHALLENGE"] }, { codes: ["AMAZON_HTTP_429"] }, { status: 429 }]) {
    const decision = detailRetry.decideAmazonDetailRetry(input);
    assert.equal(decision.action, "pause");
    assert.equal(decision.reason, "access_restricted");
    assert.equal(decision.retriesUsed, 0);
    assert.match(detailRetry.amazonDetailPauseMessage(decision), /刷新页面不会自动继续/);
  }
});

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
function appHarness({ count = 45, respond } = {}) {
  const asins = Array.from({ length: count }, (_, index) => `B${String(index + 1).padStart(9, "0")}`);
  const calls = [], saved = [], waits = [];
  let responder = respond;
  const element = { hidden: false, disabled: false, value: "", checked: false, innerHTML: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {} };
  const context = vm.createContext({
    ...salesPolicy, ...detailRetry, ...priceState, ...listingDate, ...profitModel, ...pieceCount, ...handoff, ...coverage, ...reviewRange,
    fixtureAsins: asins,
    document: { addEventListener() {}, getElementById() { return element; }, querySelector() { return null; }, querySelectorAll() { return []; } },
    setTimeout() {}, structuredClone, AbortController, DOMException,
    fixtureSave(snapshot) { saved.push(structuredClone(snapshot)); },
    fixtureWait(ms) { waits.push(ms); },
    async fixtureApi(_path, options) {
      const body = JSON.parse(options.body);
      calls.push(body);
      return responder(body, calls.length);
    },
  });
  const instrumented = source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/\}\)\(\);\s*$/, `
    activeMarket = MARKET_CONFIGS.AU;
    storeList = { stores: [{ asins: fixtureAsins }], audit: { marketplace: 'AU', uniqueSellers: 1 } };
    runState = { ...createIdleRunState(), id: 'synthetic-pause-run', mode: 'live', analysisSourceMode: 'amazon_only', criteria: { useSellerSprite: false }, coverage: {},
      amazonPipeline: { phase: 'analyze', stores: [{ key: 'fixture', index: 0, status: 'discovered' }] } };
    products = fixtureAsins.map((asin) => ({ id: 'AU:' + asin, marketplace: 'AU', asin, sourceAsin: asin, analysisSourceMode: 'amazon_only', detailStatus: 'pending', detailRetryable: true, detailParserVersion: 5, currentPrice: null }));
    renderMarketUi = applyStoredCriteriaToInputs = renderStoreAuditUi = renderStoreManager = setImportStatus = resetStoreAuditUi = setDataMode = renderResults = renderRunCoverage = updateHistorySummary = updateStartAvailability = initIcons = restorePending1688RiskStatus = setText = setStage = hideProgressError = showProgressError = showView = showToast = scheduleRequested1688Resume = () => {};
    restoreSupplier1688Pipeline = () => false;
    ensureAmazonPipeline = () => runState.amazonPipeline;
    amazonDetailAsinsForPipelineStates = () => products.filter((item) => item.detailStatus !== 'success').map((item) => item.asin);
    updateAmazonPipelineCoverage = () => ({});
    replaceAmazonStoreVisits = mergeAmazonRunErrors = reconcileRecoveredAmazonProductErrors = () => {};
    mergeAnalyzedCandidateProducts = (items) => items.forEach((item) => { const prior = products.find((p) => p.asin === (item.sourceAsin || item.asin)); if (prior) Object.assign(prior, item); });
    apiRequest = fixtureApi;
    delayWithSignal = async (ms) => fixtureWait(ms);
    delay = async () => {};
    persistCurrentRun = async () => { fixtureSave({ runState, products, storeList, profitModel: { formulaVersion: PROFIT_FORMULA_VERSION } }); return true; };
    persistCurrentRunRequired = persistCurrentRun;
    getSetupCriteria = () => ({ ...runState.criteria });
    validateSetupCriteria = () => null;
    globalThis.scout = {
      fetch: (allowSellerSprite = false) => fetchProductCandidates(storeList.stores, runState.criteria, new AbortController().signal, () => {}, { allowSellerSprite }),
      state: () => runState,
      restore: restoreRunSnapshot,
      run: runAnalysis,
      needsResume: amazonRunNeedsResume,
    };
  })();`);
  vm.runInContext(instrumented, context, { filename: "app.js" });
  return { app: context.scout, calls, saved, waits, setResponder(value) { responder = value; } };
}

function response(body, { failure = null, emptyPrice = false } = {}) {
  const items = (body.detailAsins || ["B000000001"]).map((asin) => ({
    id: `AU:${asin}`, asin, sourceAsin: asin, marketplace: "AU", analysisSourceMode: "amazon_only",
    detailStatus: failure ? "failed" : "success", detailRetryable: Boolean(failure), detailErrorCode: failure,
    detailParserVersion: 5, currentPrice: failure || emptyPrice ? null : 9.99,
  }));
  return { discoveryComplete: true, items, errors: [], unresolved: [], storeVisits: [],
    analysisAudit: { uniqueAsins: items.length, retainedSourceAsins: items.length } };
}

test("legacy app pauses after three failed requests and restores without API calls", async () => {
  const harness = appHarness({ respond: (body) => response(body, { failure: "AMAZON_FETCH_TIMEOUT" }) });
  await assert.rejects(harness.app.fetch(), { code: "AMAZON_DETAIL_PAUSED" });
  assert.equal(harness.calls.length, 3);
  assert.deepEqual(harness.waits, [15000, 15000]);
  const checkpoint = harness.saved.at(-1);
  assert.equal(checkpoint.runState.amazonPipeline.phase, "analyze_paused");
  assert.equal(checkpoint.runState.completedAt, null);
  assert.equal(checkpoint.runState.amazonDetailPause.retriesUsed, 2);
  assert.equal(checkpoint.products.length, 45);
  assert.equal(harness.saved.some((item) => item.runState.amazonPipeline.phase === "amazon_complete"), false);
  harness.app.restore(checkpoint, { autoResume: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.calls.length, 3);
  assert.equal(harness.app.needsResume(), true);
});

test("actual request-level failures share the finite retry budget", async () => {
  const harness = appHarness({ respond: () => { throw Object.assign(new Error("Synthetic timeout"), { code: "REQUEST_TIMEOUT", status: 408 }); } });
  await assert.rejects(harness.app.fetch(), { code: "AMAZON_DETAIL_PAUSED" });
  assert.equal(harness.calls.length, 3);
  assert.equal(harness.saved.at(-1).runState.completedAt, null);
});

test("request-level challenge pauses even when the HTTP status is otherwise terminal", async () => {
  const harness = appHarness({ respond: () => { throw Object.assign(new Error("Synthetic verification"), { code: "AMAZON_ACCESS_CHALLENGE", status: 403 }); } });
  await assert.rejects(harness.app.fetch(), { code: "AMAZON_DETAIL_PAUSED" });
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.waits, []);
  assert.equal(harness.app.state().amazonDetailPause.causeCode, "AMAZON_ACCESS_CHALLENGE");
});

test("successful batches reset their retry budget and empty prices do not stop the queue", async () => {
  const perBatchCalls = new Map();
  const harness = appHarness({ respond: (body) => {
    const key = body.detailAsins[0];
    const count = (perBatchCalls.get(key) || 0) + 1;
    perBatchCalls.set(key, count);
    return response(body, count <= 2 ? { failure: "AMAZON_FETCH_TIMEOUT" } : { emptyPrice: true });
  } });
  await harness.app.fetch();
  assert.equal(harness.calls.length, 9);
  assert.equal(harness.app.state().amazonPipeline.phase, "amazon_complete");
  assert.equal(harness.app.state().amazonDetailPause, undefined);
  assert.deepEqual([...perBatchCalls.values()], [3, 3, 3]);
});

test("SellerSprite detail failures still stop immediately using their existing error", async () => {
  const harness = appHarness({ respond: (body) => response(body, { failure: "SELLSPRITE_UPSTREAM_ERROR" }) });
  await assert.rejects(harness.app.fetch(true), { code: "SELLSPRITE_ANALYSIS_INCOMPLETE" });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.app.state().amazonDetailPause, undefined);
});
