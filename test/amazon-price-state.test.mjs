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

const { candidateCurrentPrice, invalidateLegacyAmazonPrice, mergeAmazonPriceState, mergeAmazonDetailAudit } = priceState;
const now = "2026-09-23T12:00:00.000Z";
const legacy = (extra = {}) => ({
  id: "AU:B000000001", asin: "B000000001", sourceAsin: "B000000001", marketplace: "AU",
  analysisSourceMode: "amazon_only", fieldSources: { currentPrice: "amazon_product_page" },
  detailStatus: "success", detailParserVersion: 4, detailRetryable: false,
  currentPrice: 279, price30: 279, salePrice: 251.1, reviewStatus: "approved",
  ...extra,
});
const detail = (extra = {}) => ({
  ...legacy(), currentPrice: 9.99, detailParserVersion: 5,
  priceEvidence: { source: "buybox", rawText: "$9.99" }, ...extra,
});
function mergePrice(existing, incoming) {
  mergeAmazonDetailAudit(existing, incoming);
  mergeAmazonPriceState(existing, incoming, { now });
}

test("obsolete automatic price is quarantined with an audit and approval revoked", () => {
  const product = legacy({ manualSalePrice: true, salePrice: 22, manualPurchaseCost: true, purchaseCost: 5, suppliers: [{ unitPriceCny: 5 }] });
  assert.equal(invalidateLegacyAmazonPrice(product, { now }), true);
  assert.equal(product.currentPrice, null);
  assert.equal(product.currentPriceStatus, "pending_revalidation");
  assert.equal(product.priceRevalidation.previousCurrentPrice, 279);
  assert.equal(product.priceRevalidation.previousPrice30, 279);
  assert.equal(product.priceRevalidation.previousParserVersion, 4);
  assert.equal(product.detailParserVersion, 4);
  assert.equal(Object.hasOwn(product.fieldSources, "currentPrice"), false);
  assert.equal(product.priceRevalidation.previousFieldSource, "amazon_product_page");
  assert.equal(product.reviewStatus, "pending");
  assert.equal(product.salePrice, 22);
  assert.equal(product.purchaseCost, 5);
  assert.deepEqual(product.suppliers, [{ unitPriceCny: 5 }]);
  assert.equal(invalidateLegacyAmazonPrice(product, { now: "later" }), false);
  assert.equal(product.priceRevalidation.invalidatedAt, now);
});

test("Amazon field provenance triggers migration even in a mixed-source run", () => {
  const product = legacy({ analysisSourceMode: "amazon_sellsprite" });
  assert.equal(invalidateLegacyAmazonPrice(product, { now }), true);
  assert.equal(product.currentPrice, null);
});

for (const protection of [{ manualAmazonFields: { currentPrice: true } }, { manualAmazonOverride: true }, { fieldSources: { currentPrice: "manual" } }]) {
  test(`manual price protection survives migration and successful refresh: ${Object.keys(protection)[0]}`, () => {
    const product = legacy(protection);
    assert.equal(invalidateLegacyAmazonPrice(product, { now }), false);
    mergePrice(product, detail({ currentPrice: null }));
    assert.equal(product.currentPrice, 279);
    assert.equal(product.currentPriceStatus, "manual");
    assert.equal(product.fieldSources.currentPrice, "manual");
    assert.equal(product.reviewStatus, "approved");
  });
}

test("current parser and provider-only prices are not migrated", () => {
  for (const product of [detail(), legacy({ analysisSourceMode: "amazon_sellsprite", fieldSources: { currentPrice: "sellsprite" } })]) {
    const before = structuredClone(product);
    assert.equal(invalidateLegacyAmazonPrice(product, { now }), false);
    assert.deepEqual(product, before);
  }
});

test("explicit empty current offer does not fall back to legacy price or average", () => {
  assert.equal(candidateCurrentPrice({ currentPrice: null, price: 279, averagePrice30: 279 }), null);
  assert.equal(candidateCurrentPrice({ currentPrice: "", price: 279 }), null);
  assert.equal(candidateCurrentPrice({ price: 9.99 }), 9.99);
});

test("a successful refresh without a current offer clears price and records unavailable", () => {
  const product = detail();
  mergePrice(product, detail({ currentPrice: null, priceEvidence: { status: "unavailable" } }));
  assert.equal(product.currentPrice, null);
  assert.equal(product.detailParserVersion, 5);
  assert.equal(product.currentPriceStatus, "unavailable");
  assert.equal(Object.hasOwn(product.fieldSources, "currentPrice"), false);
  assert.deepEqual(product.priceEvidence, { status: "unavailable" });
});

test("failed revalidation keeps old parser provenance and never restores old price", () => {
  const product = legacy();
  invalidateLegacyAmazonPrice(product, { now });
  mergePrice(product, detail({ detailStatus: "failed", detailRetryable: false, detailErrorCode: "AMAZON_HTTP_404", currentPrice: null }));
  assert.equal(product.currentPrice, null);
  assert.equal(product.detailParserVersion, 4);
  assert.equal(product.detailStatus, "failed");
  assert.equal(product.currentPriceStatus, "refresh_failed");
  assert.equal(product.priceRevalidation.previousCurrentPrice, 279);
  assert.equal(product.priceRevalidation.status, "failed");
});

test("successful revalidation accepts 9.99 with evidence and preserves the former 279 audit", () => {
  const product = legacy();
  invalidateLegacyAmazonPrice(product, { now });
  mergePrice(product, detail());
  assert.equal(product.currentPrice, 9.99);
  assert.equal(product.currentPriceStatus, "verified");
  assert.equal(product.detailParserVersion, 5);
  assert.equal(product.priceRevalidation.previousCurrentPrice, 279);
  assert.equal(product.priceRevalidation.status, "completed");
  assert.deepEqual(product.priceEvidence, detail().priceEvidence);
});

test("an obsolete successful refresh cannot certify a price", () => {
  const product = legacy();
  invalidateLegacyAmazonPrice(product, { now });
  mergePrice(product, detail({ detailParserVersion: 4, currentPrice: 279 }));
  assert.equal(product.currentPrice, null);
  assert.equal(product.currentPriceStatus, "pending_revalidation");
  assert.equal(product.priceRevalidation.status, "pending");
});

const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
function appHarness() {
  const source = appSource.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/\}\)\(\);\s*$/, `
    renderMarketUi = applyStoredCriteriaToInputs = renderStoreAuditUi = renderStoreManager = setImportStatus = resetStoreAuditUi = setDataMode = renderResults = renderRunCoverage = updateHistorySummary = updateStartAvailability = initIcons = restorePending1688RiskStatus = setText = () => {};
    restoreSupplier1688Pipeline = () => false;
    globalThis.scout = {
      restore: restoreRunSnapshot,
      merge: mergeAnalyzedCandidateProducts,
      mergeRecords: mergeCandidateRecords,
      products: () => products,
      setProducts: (value) => { products = value; runState.analysisSourceMode = 'amazon_only'; runState.marketplace = 'AU'; },
      needsRepair: amazonProductNeedsDetailRepair,
    };
  })();`);
  const context = vm.createContext({
    ...salesPolicy, ...priceState, ...profitModel, ...pieceCount, ...handoff, ...coverage, ...detailRetry,
    document: { addEventListener() {}, getElementById() { return null; } }, setTimeout() {}, structuredClone,
  });
  vm.runInContext(source, context, { filename: "app.js" });
  return context.scout;
}

function completeLegacy(extra = {}) {
  return legacy({
    sellerId: "EXAMPLESELLER", name: "Example product", englishName: "Example product",
    productWeight: 0.1, billingWeight: 0.1, rating: 4.5, reviews: 20,
    imageUrl: "https://m.media-amazon.com/images/I/example.jpg",
    fulfillmentMode: "FBA", fulfillmentModeSource: "manual", fbaFee: 2, manualFbaFee: true,
    manualPurchaseCost: true, purchaseCost: 5, purchaseUnitCostCny: 5,
    pieceCount: 1, pieceCountSource: "manual", suppliers: [{ name: "Synthetic supplier", unitPriceCny: 5, imageSimilarityDecision: "unavailable", supplierMatchDecision: "unavailable" }],
    supplierRuleVersion: "1688-image-only-always-top6-trimmed-10-v6", supplierSearchStatus: "manual_cost",
    profitInputs: { ...profitModel.DEFAULT_PROFIT_RATES, formulaVersion: profitModel.PROFIT_FORMULA_VERSION,
      exchangeRate: 4.8, actualWeightKg: 0.1, airFreightActualWeightOnly: true },
    ...extra,
  });
}

test("actual snapshot restore clears automatic sale, target and profit without reviving price30", () => {
  const app = appHarness();
  app.restore({ runState: { id: "synthetic", marketplace: "AU", analysisSourceMode: "amazon_only", mode: "live" },
    products: [completeLegacy()], profitModel: { formulaVersion: profitModel.PROFIT_FORMULA_VERSION } });
  const product = app.products()[0];
  assert.equal(product.currentPrice, null);
  assert.equal(product.salePrice, null);
  assert.equal(product.targetCostCny, null);
  assert.equal(product.margin, null);
  assert.equal(product.profitCalculation, null);
  assert.equal(product.reviewStatus, "pending");
  assert.equal(product.purchaseCost, 5);
  assert.equal(product.suppliers[0].unitPriceCny, 5);
  assert.equal(app.needsRepair(product), true);
});

test("actual snapshot restore preserves a manual sale price and recalculates from it", () => {
  const app = appHarness();
  app.restore({ runState: { id: "synthetic", marketplace: "AU", analysisSourceMode: "amazon_only", mode: "live" },
    products: [completeLegacy({ manualSalePrice: true, salePrice: 22 })], profitModel: { formulaVersion: profitModel.PROFIT_FORMULA_VERSION } });
  const product = app.products()[0];
  assert.equal(product.currentPrice, null);
  assert.equal(product.salePrice, 22);
  assert.equal(product.targetCostCny, 21.12);
  assert.ok(Number.isFinite(product.margin));
  assert.equal(product.reviewStatus, "pending");
});

test("actual candidate merge clears a newly unavailable offer and invalidates approval", () => {
  const app = appHarness();
  const product = completeLegacy({ detailParserVersion: 5 });
  app.setProducts([product]);
  app.merge([detail({ currentPrice: null, price: 279, priceEvidence: null })]);
  assert.equal(product.currentPrice, null);
  assert.equal(product.salePrice, null);
  assert.equal(product.margin, null);
  assert.equal(product.reviewStatus, "pending");
  assert.equal(product.priceEvidence, null);
});

test("actual batch record merge retains successful provenance after failure and respects explicit null", () => {
  const app = appHarness();
  app.setProducts([]);
  const left = detail();
  const failed = app.mergeRecords(left, detail({ detailStatus: "failed", detailParserVersion: 6, currentPrice: null }));
  assert.equal(failed.currentPrice, 9.99);
  assert.equal(failed.detailParserVersion, 5);
  assert.equal(failed.detailStatus, "success");
  const unavailable = app.mergeRecords(left, detail({ currentPrice: null, priceEvidence: null }));
  assert.equal(unavailable.currentPrice, null);
  assert.equal(unavailable.priceEvidence, null);
  assert.equal(Object.hasOwn(unavailable.fieldSources, "currentPrice"), false);
});

test("actual candidate refresh recomputes the corrected price and keeps supplier evidence", () => {
  const app = appHarness();
  const product = completeLegacy();
  invalidateLegacyAmazonPrice(product, { now });
  app.setProducts([product]);
  app.merge([detail()]);
  assert.equal(product.currentPrice, 9.99);
  assert.equal(product.salePrice, 9.99);
  assert.equal(product.detailParserVersion, 5);
  assert.equal(product.priceEvidence.rawText, "$9.99");
  assert.equal(product.priceRevalidation.previousCurrentPrice, 279);
  assert.equal(product.reviewStatus, "pending");
  assert.equal(product.purchaseCost, 5);
  assert.equal(product.suppliers[0].unitPriceCny, 5);
});

test("actual candidate failure remains unverified and cannot display the historical price", () => {
  const app = appHarness();
  const product = completeLegacy();
  invalidateLegacyAmazonPrice(product, { now });
  app.setProducts([product]);
  app.merge([detail({ detailStatus: "failed", detailRetryable: false, currentPrice: null })]);
  assert.equal(product.currentPrice, null);
  assert.equal(product.salePrice, null);
  assert.equal(product.detailParserVersion, 4);
  assert.equal(product.currentPriceStatus, "refresh_failed");
});

test("actual candidate merge respects manual competitor price and its source", () => {
  const app = appHarness();
  const product = completeLegacy({ currentPrice: 20, manualAmazonFields: { currentPrice: true } });
  app.setProducts([product]);
  app.merge([detail({ currentPrice: null })]);
  assert.equal(product.currentPrice, 20);
  assert.equal(product.salePrice, 20);
  assert.equal(product.fieldSources.currentPrice, "manual");
  assert.equal(product.currentPriceStatus, "manual");
});

test("manual field source alone survives actual restore and merged incoming provenance", () => {
  const app = appHarness();
  const product = completeLegacy({ currentPrice: 20, fieldSources: { currentPrice: "manual" } });
  app.restore({ runState: { id: "synthetic", marketplace: "AU", analysisSourceMode: "amazon_only", mode: "live" },
    products: [product], profitModel: { formulaVersion: profitModel.PROFIT_FORMULA_VERSION } });
  assert.equal(product.currentPrice, 20);
  assert.equal(product.priceRevalidation, undefined);
  app.merge([detail({ currentPrice: null })]);
  assert.equal(product.currentPrice, 20);
  assert.equal(product.fieldSources.currentPrice, "manual");
  const raw = app.mergeRecords(product, detail({ currentPrice: null }));
  assert.equal(raw.currentPrice, 20);
  assert.equal(raw.fieldSources.currentPrice, "manual");
});
