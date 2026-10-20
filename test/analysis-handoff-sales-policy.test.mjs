import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAnalysisProducts, createAnalysisHandoffPackage, evaluateAnalysisProduct,
  getAnalysisFormulaContract, selectManuallyReviewedProducts,
} from "../lib/analysis-handoff.mjs";
import { DEFAULT_PROFIT_RATES } from "../lib/profit-model.mjs";
import { todayDateOnly } from "../lib/amazon-listing-date.mjs";

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

test("handoff audits Amazon listing-date evidence and inclusive calendar bounds without using SellerSprite dates", () => {
  const today = todayDateOnly();
  const criteria = { results: { amazonFirstAvailableFrom: "2020-02-29" } };
  for (const date of ["2020-02-29", today]) {
    const item = product({ amazonFirstAvailableDate: date, amazonFirstAvailableDateStatus: "found",
      amazonFirstAvailableDateEvidence: { asin: "B000000001", marketplace: "AU", value: date, source: "amazon_product_information" } });
    const original = structuredClone(item);
    const record = evaluate(item, criteria);
    assert.equal(record.filter.decision, "pass");
    assert.equal(record.amazon_observations.first_available_date, date);
    assert.deepEqual(record.amazon_observations.first_available_date_evidence, item.amazonFirstAvailableDateEvidence);
    assert.equal(record.filter.effective_result_rules.amazonFirstAvailableThrough, today);
    assert.deepEqual(item, original);
  }
  for (const date of ["2020-02-28", "9999-12-31"]) {
    const record = evaluate(product({ amazonFirstAvailableDate: date, amazonFirstAvailableDateStatus: "found" }), criteria);
    assert.ok(record.filter.reasons.includes("AMAZON_FIRST_AVAILABLE_DATE_OUTSIDE_RANGE"));
  }
  for (const overrides of [{}, { listingAvailableAt: today }, { amazonFirstAvailableDate: today, amazonFirstAvailableDateStatus: "unresolved" }, { amazonFirstAvailableDate: "2025-02-29", amazonFirstAvailableDateStatus: "found" }]) {
    const item = product(overrides);
    assert.equal(evaluate(item).filter.decision, "pass", "Optional date does not block a product without date filtering");
    const record = evaluate(item, criteria);
    assert.equal(record.amazon_observations.first_available_date, null);
    assert.ok(record.filter.reasons.includes("AMAZON_FIRST_AVAILABLE_DATE_UNVERIFIED"));
  }
  for (const start of ["2025-02-29", "2026/01/01", "9999-12-31"]) {
    assert.throws(() => evaluate(product(), { amazon: { amazonFirstAvailableFrom: start } }), /Invalid Amazon/);
  }
});

test("unknown or numeric-only monthly sales cannot enter the default all candidate scope", () => {
  for (const sales30 of [undefined, null, 0, 50, 100, 1200]) {
    const result = evaluate(product({ sales30, sales30Evidence: null }));
    assert.equal(result.filter.decision, "pending");
    assert.ok(result.filter.reasons.includes("MONTHLY_SALES_EVIDENCE_MISSING"));
    assert.ok(!result.filter.reasons.includes("MONTHLY_SALES_BELOW_50"));
    assert.equal(result.amazon_observations.monthly_sales, null);
  }
});

test("pending detail collection without a monthly-purchase badge stays outside candidates", () => {
  const item = product({ detailStatus: "pending", sales30: null, sales30Evidence: null });
  const result = classifyAnalysisProducts({ runState, products: [item] });
  assert.equal(result.passed.length, 0);
  assert.equal(result.pending.length, 1);
  assert.equal(result.excluded.length, 0);
  assert.ok(result.pending[0].filter.reasons.includes("AMAZON_DETAIL_NOT_COMPLETE"));
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
    assert.equal(result.filter.decision, "pending");
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
  assert.equal(getAnalysisFormulaContract().amazon_monthly_sales_policy.missing_evidence, "unknown_and_pending");
});


test("same-ASIN SellerSprite evidence follows the enabled source in handoff filtering and manual selection", () => {
  const item = product({ marketplace: "US", analysisSourceMode: "amazon_sellsprite", sales30: 123,
    sales30Evidence: { source: "sellsprite_api", sourceTool: "competitor_lookup", field: "amzUnit", scope: "asin",
      asin: "B000000001", marketplace: "US", providerMarketplace: "US", period: "past_month", kind: "estimate", value: 123 } });
  const enabled = { runState, products: [item], criteria: { useSellerSprite: true } };
  const record = evaluate(item, enabled.criteria);
  assert.equal(record.filter.decision, "pass");
  assert.equal(record.amazon_observations.monthly_sales, 123);
  assert.equal(record.amazon_observations.monthly_sales_source, "sellsprite_api");
  assert.equal(selectManuallyReviewedProducts(enabled).length, 1);
  assert.equal(createAnalysisHandoffPackage(enabled).products.length, 1);
  const disabled = { ...enabled, criteria: { useSellerSprite: false } };
  assert.equal(selectManuallyReviewedProducts(disabled).length, 0);
  assert.equal(evaluate(item, disabled.criteria).amazon_observations.monthly_sales, null);
  assert.equal(selectManuallyReviewedProducts({ ...enabled, products: [{ ...item, marketplace: "AU" }] }).length, 0);
});

test("direct ASIN handoffs enforce monthly eligibility and selected bands without changing observations", () => {
  for (const value of [null, 30, 50, 200]) {
    const item = product({ sales30: value, sales30Evidence: value === null ? null : evidence(value) });
    const input = { runState: { ...runState, inputMode: "asins" }, products: [item], criteria: { monthlySalesBand: "100_plus" } };
    const before = structuredClone(input);
    const pack = createAnalysisHandoffPackage(input);
    const record = evaluateAnalysisProduct(item, input);
    const storeRecord = evaluateAnalysisProduct(item, { ...input, runState });
    assert.deepEqual(record.filter.reasons, storeRecord.filter.reasons);
    assert.equal(record.filter.decision, value === null ? "pending" : value < 100 ? "excluded" : "pass");
    assert.equal(pack.products.length, value !== null && value >= 50 ? 1 : 0);
    assert.equal(record.amazon_observations.monthly_sales, value);
    assert.equal(pack.filter_rules.input_mode, "asins");
    assert.equal(pack.filter_rules.amazon.monthlySalesFilterApplied, true);
    assert.equal(pack.filter_rules.amazon.monthlySalesBand, "100_plus");
    assert.equal(pack.formula_contract.amazon_monthly_sales_policy.minimum, 50);
    assert.equal(pack.formula_contract.amazon_monthly_sales_policy.applied, true);
    assert.equal(pack.manual_selection.required_candidate_eligibility, "verified_current_asin_monthly_sales_at_least_50");
    assert.deepEqual(input, before);
  }
  assert.throws(() => evaluateAnalysisProduct(product(), {
    runState: { ...runState, inputMode: "asins" }, criteria: { monthlySalesBand: "stale-unsupported-band" },
  }), /Unsupported monthlySalesBand/);
});

test("ASIN filtering preserves review, rating, detail, date and manual selection requirements", () => {
  const directRun = { ...runState, inputMode: "asins" };
  for (const [fields, criteria, expected] of [
    [{ reviews: 5 }, { minReviews: 10 }, "REVIEWS_BELOW_MINIMUM"],
    [{ reviews: 30 }, { maxReviews: 20 }, "REVIEWS_ABOVE_MAXIMUM"],
    [{ rating: 2 }, { minRating: 4 }, "RATING_BELOW_MINIMUM"],
    [{ detailStatus: "pending" }, {}, "AMAZON_DETAIL_NOT_COMPLETE"],
    [{}, { results: { amazonFirstAvailableFrom: "2020-01-01" } }, "AMAZON_FIRST_AVAILABLE_DATE_UNVERIFIED"],
    [{ reviewStatus: "rejected" }, {}, "ANALYSIS_REVIEW_REJECTED"],
  ]) {
    const record = evaluateAnalysisProduct(product(fields), { runState: directRun, criteria });
    assert.ok(record.filter.reasons.includes(expected));
  }
  assert.equal(selectManuallyReviewedProducts({ runState: directRun, products: [product({ reviewStatus: "pending" })] }).length, 0);
});

test("legacy bypass flags cannot disable sales in either import mode and JSON restore preserves revisions", () => {
  for (const inputMode of ["stores", "asins"]) {
    const item = product({ sales30: null, sales30Evidence: null, inputMode: "asins",
      storeCriteria: [{ monthlySalesBand: "100_plus", monthlySalesFilterApplied: false }] });
    const input = { runState: { ...runState, inputMode }, products: [item], criteria: { monthlySalesBand: '100_plus', monthlySalesFilterApplied: false } };
    assert.ok(evaluateAnalysisProduct(item, input).filter.reasons.includes("MONTHLY_SALES_EVIDENCE_MISSING"));
    const pack = createAnalysisHandoffPackage(input);
    assert.equal(pack.products.length, 0);
    assert.equal(pack.package_id, createAnalysisHandoffPackage(JSON.parse(JSON.stringify(input))).package_id);
    assert.equal(pack.filter_rules.amazon.monthlySalesFilterApplied, true);
  }
});

test("ASIN all handoff retains manually reviewed low/unknown sales while explicit bands still require sales", () => {
  for (const value of [null, 0, 30]) {
    const item = product({ sales30: value, sales30Evidence: value === null ? null : evidence(value) });
    const before = structuredClone(item);
    const input = { runState: { ...runState, inputMode: 'asins' }, products: [item], criteria: { monthlySalesBand: 'all' } };
    const pack = createAnalysisHandoffPackage(input);
    assert.equal(pack.products.length, 1);
    assert.equal(pack.products[0].amazon_observations.monthly_sales, value);
    assert.equal(pack.filter_rules.amazon.monthlySalesFilterApplied, false);
    assert.equal(pack.formula_contract.amazon_monthly_sales_policy.applied, false);
    assert.equal(pack.products[0].filter.decision, 'pass');
    assert.equal(createAnalysisHandoffPackage({ ...input, criteria: { monthlySalesBand: '50_plus' } }).products.length, 0);
    assert.equal(createAnalysisHandoffPackage({ ...input, runState }).products.length, 0);
    assert.deepEqual(item, before);
  }
});
