import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAnalysisProducts, createAnalysisHandoffPackage, evaluateAnalysisProduct,
  getAnalysisFormulaContract, selectManuallyReviewedProducts,
} from "../lib/analysis-handoff.mjs";
import { DEFAULT_PROFIT_RATES } from "../lib/profit-model.mjs";

const runState = { id: "synthetic-sales-handoff", marketplace: "AU" };
const evidence = (value = 50, overrides = {}) => ({
  asin: "B000000001", source: "amazon_product_page", kind: "lower_bound", period: "past_month",
  value, rawText: value + "+ bought in past month", ...overrides,
});
const product = (overrides = {}) => ({
  id: "AU:B000000001", asin: "B000000001", marketplace: "AU", detailStatus: "success", sales30: 50,
  name: "Synthetic handoff product", currentPrice: 25, reviewStatus: "approved", sales30Evidence: evidence(),
  manualSalePrice: true, manualPurchaseCost: true, salePrice: 25, purchaseCost: 8,
  suppliers: [{ offerId: "saved-quote", unitPriceCny: 8 }],
  analysisProfitInputs: {
    ...DEFAULT_PROFIT_RATES, salePrice: 25, purchaseCostCny: 8, fulfillmentMode: "FBA", fulfillmentFee: 3.64,
    exchangeRate: 4.8, actualWeightKg: 0.075, airFreightActualWeightOnly: true, volumetricDivisor: 139,
  },
  ...overrides,
});
const evaluate = (item, criteria = {}) => evaluateAnalysisProduct(item, { runState, criteria });

test("unknown or numeric-only monthly sales cannot enter the default all candidate scope", () => {
  for (const sales30 of [undefined, null, 0, 50, 100, 1200]) {
    const result = evaluate(product({ sales30, sales30Evidence: null }));
    assert.equal(result.filter.decision, "excluded");
    assert.ok(result.filter.reasons.includes("MONTHLY_SALES_EVIDENCE_MISSING"));
    assert.ok(!result.filter.reasons.includes("MONTHLY_SALES_BELOW_50"));
    assert.equal(result.amazon_observations.monthly_sales, null);
  }
});

test("pending detail collection without a monthly-purchase badge stays outside candidates", () => {
  const item = product({ detailStatus: "pending", sales30: null, sales30Evidence: null });
  const result = classifyAnalysisProducts({ runState, products: [item] });
  assert.equal(result.passed.length, 0);
  assert.equal(result.pending.length, 0);
  assert.equal(result.excluded.length, 1);
  assert.ok(result.excluded[0].filter.reasons.includes("AMAZON_DETAIL_NOT_COMPLETE"));
});

test("verified 50+, 100+, 200+, and larger current-product badges qualify and sales bands still apply", () => {
  for (const value of [50, 100, 200, 1200]) {
    const result = evaluate(product({ sales30: value, sales30Evidence: evidence(value) }));
    assert.equal(result.filter.decision, "pass");
    assert.equal(result.amazon_observations.monthly_sales, value);
  }
  assert.equal(evaluate(product({ sales30: 30, sales30Evidence: evidence(30) })).filter.decision, "excluded");
  assert.equal(evaluate(product(), { monthlySalesBand: "50_to_100" }).filter.decision, "pass");
  assert.equal(evaluate(product(), { monthlySalesBand: "100_plus" }).filter.decision, "excluded");
  assert.equal(evaluate(product({ sales30: 200, sales30Evidence: evidence(200) }), { monthlySalesBand: "50_to_100" }).filter.decision, "excluded");
});

test("legacy under_50 store rules cannot bypass the mandatory candidate floor", () => {
  for (const value of [null, 30, 50, 100]) {
    const item = product({ sales30: value, sales30Evidence: value === null ? null : evidence(value) });
    assert.equal(evaluate(item, { monthlySalesBand: "under_50" }).filter.decision, "excluded");
    assert.equal(evaluate({ ...item, storeCriteria: [{ monthlySalesBand: "under_50" }] }).filter.decision, "excluded");
  }
});

test("unrelated, third-party, or non-monthly badge evidence cannot qualify a handoff", () => {
  for (const override of [
    { asin: "B000000002" }, { source: "sellersprite" }, { period: "past_week" },
    { rawText: "100+ reviews" }, { value: 100, rawText: "50+ bought in past month" },
  ]) {
    const result = evaluate(product({ sales30: 100, sales30Evidence: evidence(50, override) }));
    assert.equal(result.filter.decision, "excluded");
    assert.equal(result.amazon_observations.monthly_sales, null);
  }
});

test("manual approval cannot hand off unverified sales and eligible manual prices, costs, and quotes remain intact", () => {
  const eligible = product();
  const unknown = product({ id: "AU:B000000002", asin: "B000000002", sales30Evidence: null });
  const input = { runState, products: [eligible, unknown], criteria: { minProfitMargin: 99 } };
  const original = structuredClone(input);
  const selected = selectManuallyReviewedProducts(input);
  assert.deepEqual(selected.map((record) => record.product_id), [eligible.id]);
  const pack = createAnalysisHandoffPackage(input);
  assert.equal(pack.products.length, 1);
  assert.equal(pack.products[0].preliminary_profit.inputs.salePrice, 25);
  assert.equal(pack.products[0].preliminary_profit.inputs.purchaseCostCny, 8);
  assert.equal(pack.products[0].filter.decision, "excluded", "Other diagnostics do not override the explicit eligible manual selection");
  assert.deepEqual(input, original);
});

test("policy evaluation never rewrites existing procurement handoff records", () => {
  const item = product({ sales30Evidence: null, analysisHandoff: {
    owner: "procurement", packageId: "saved-package", revision: "saved-revision", exportedAt: "2026-10-01T00:00:00.000Z",
  } });
  const original = structuredClone(item);
  const pack = createAnalysisHandoffPackage({ runState, products: [item] });
  assert.equal(pack.products.length, 0);
  assert.deepEqual(item, original);
  assert.equal(getAnalysisFormulaContract().amazon_monthly_sales_policy.missing_evidence, "unknown_and_excluded");
});
