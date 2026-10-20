import test from "node:test";
import assert from "node:assert/strict";
import { createAnalysisHandoffPackage, getAnalysisFormulaContract } from "../lib/analysis-handoff.mjs";
import { DEFAULT_PROFIT_RATES, estimateCa2026FbaFeeByProductWeight } from "../lib/profit-model.mjs";

const candidate = (fulfillmentFee, overrides = {}) => ({
  id: "CA:B000000001", asin: "B000000001", marketplace: "CA", detailStatus: "success", reviewStatus: "approved",
  name: "Synthetic fee export", currentPrice: 13.99, sales30: 50,
  sales30Evidence: { asin: "B000000001", source: "amazon_product_page", kind: "lower_bound", period: "past_month", value: 50, rawText: "50+ bought in past month" },
  analysisProfitInputs: { ...DEFAULT_PROFIT_RATES, salePrice: 13.99, purchaseCostCny: 8,
    fulfillmentMode: "FBA", fulfillmentFee, exchangeRate: 5.2, actualWeightKg: 0.1,
    airFreightActualWeightOnly: true, volumetricDivisor: 139 },
  ...overrides,
});
const exportOne = (item) => JSON.parse(JSON.stringify(createAnalysisHandoffPackage({
  runState: { id: "synthetic-ca-fba-export", marketplace: "CA" }, products: [item],
})));

test("handoff fee contract distinguishes AU inclusive and CA strict low-price boundaries", () => {
  const contract = getAnalysisFormulaContract();
  assert.equal(contract.au_fba.price_condition.threshold, 13);
  assert.equal(contract.au_fba.price_condition.low_operator, "<=");
  assert.equal(contract.au_fba.price_condition.high_operator, ">");
  assert.equal(contract.ca_fba.price_condition.threshold, 14);
  assert.equal(contract.ca_fba.price_condition.discount_operator, "<");
  assert.equal(contract.ca_fba.price_condition.discount, 0.8);
  assert.equal(contract.ca_fba.price_condition.otherwise_discount, 0);
  assert.deepEqual(contract.au_fba.max_dimensions_cm, [33, 23, 2.5]);
  assert.match(contract.au_fba.out_of_range, /manual fee required/);
  assert.match(contract.ca_fba.out_of_range, /manual fee required/);
});

test("handoff records user-selected peak estimation separately from the workbook season", () => {
  const { ca_fba: ca, au_fba: au, fee_model_version: version } = getAnalysisFormulaContract();
  assert.equal(ca.season_policy, "peak_only_user_selected");
  assert.equal(ca.calendar_switching, false);
  assert.deepEqual(ca.source_peak_period, { from: "2026-10-15", through: "2027-01-14" });
  assert.equal(ca.tax_included, false);
  assert.equal(ca.surcharge_multiplier, 1.035);
  assert.match(ca.equation, /\(baseFee - applicableDiscount\) \* 1\.035/);
  assert.match(ca.source, /Sheet1!A1:D8/);
  assert.match(au.source, /!A1:E4/);
  assert.doesNotMatch(version, /au-user-workbook-weight-only/);
});

test("CA automatic fee retains surcharge precision through JSON handoff and profit result", () => {
  const fee = estimateCa2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceCad: 13.99 }).fee;
  const exported = exportOne(candidate(fee));
  const profit = exported.products[0].preliminary_profit;
  assert.ok(Math.abs(fee - 4.06755) < 1e-10);
  assert.equal(profit.inputs.fulfillmentFee, fee);
  assert.equal(profit.result.parts.fulfillment, fee);
  assert.notEqual(profit.inputs.fulfillmentFee, 4.07);
  assert.match(exported.formula_contract.ca_fba.rounding, /full calculation and export precision/);
});

test("manual fulfillment input is exported without applying CA discount or surcharge again", () => {
  const item = candidate(7.12345, { manualFbaFee: true, fbaFeeSource: "manual" });
  const exported = exportOne(item).products[0].preliminary_profit;
  assert.equal(exported.inputs.fulfillmentFee, 7.12345);
  assert.equal(exported.result.parts.fulfillment, 7.12345);
  assert.equal(exported.fee_sources.fulfillment.manual_override, true);
});

test("missing-weight minimum envelope estimates profit without inventing actual weight", () => {
  const item = candidate(4.06755);
  item.analysisProfitInputs.actualWeightKg = null;
  item.analysisProfitInputs.actualWeightSource = "missing_weight_lowest_freight_assumption";
  const pack = exportOne(item);
  const record = pack.products[0];
  assert.equal(record.preliminary_profit.inputs.fulfillmentFee, 4.06755);
  assert.equal(record.preliminary_profit.inputs.actualWeightKg, null);
  assert.equal(record.preliminary_profit.inputs.assumedWeightKg, undefined);
  assert.equal(record.preliminary_profit.result, null);
  assert.equal(record.filter.decision, "pass");
  assert.match(pack.formula_contract.ca_fba.missing_weight, /5021.69/);
});

for (const marketplace of ["AU", "CA", "US", "NL", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"]) {
  test(`${marketplace} handoff keeps actual weight unknown and exports its minimum-tier assumption`, () => {
    const item = candidate(7.12345, { marketplace, manualFbaFee: true });
    item.analysisProfitInputs.actualWeightKg = null;
    const record = exportOne(item).products[0];
    const profit = record.preliminary_profit;
    const assumed = marketplace === "AU" ? 0.075 : marketplace === "CA" ? 0.1 : 0.25 / 2.2046226218;
    assert.equal(record.amazon_observations.item_weight_kg, null);
    assert.equal(profit.inputs.actualWeightKg, null);
    if (["AU", "CA"].includes(marketplace)) {
      assert.equal(profit.inputs.assumedWeightKg, undefined);
      assert.equal(profit.result, null);
      assert.equal(profit.inputs.fulfillmentFee, 7.12345);
      assert.ok(profit.missing_inputs.includes("actualWeightKg"));
      return;
    }
    assert.equal(profit.inputs.assumedWeightKg, assumed);
    assert.equal(profit.inputs.weightAssumptionMarket, marketplace);
    assert.equal(profit.result.airFreight.actualWeightKg, null);
    assert.equal(profit.result.domesticFreightWeightKg, assumed);
    assert.equal(profit.result.fulfillmentFee, 7.12345, 'Preserve the explicit manual fee.');
    assert.equal(profit.fee_sources.weight_assumption.assumed_weight_kg, assumed);
    assert.deepEqual(profit.missing_inputs, []);
  });
}

test("handoff recomputes legacy fake weight as a separate assumption and real weight clears it", () => {
  const item = candidate(4.06755);
  item.analysisProfitInputs.actualWeightKg = 0.075;
  item.analysisProfitInputs.actualWeightSource = "missing_weight_lowest_freight_assumption";
  let record = exportOne(item).products[0];
  assert.equal(record.preliminary_profit.inputs.actualWeightKg, null);
  assert.equal(record.preliminary_profit.inputs.assumedWeightKg, undefined);
  item.analysisProfitInputs.actualWeightKg = 0.11;
  delete item.analysisProfitInputs.actualWeightSource;
  item.analysisProfitInputs.assumedWeightKg = 0.1;
  item.analysisProfitInputs.weightAssumption = "missing_weight_minimum_envelope";
  record = exportOne(item).products[0];
  assert.equal(record.preliminary_profit.inputs.actualWeightKg, 0.11);
  assert.equal(record.preliminary_profit.inputs.assumedWeightKg, undefined);
  assert.equal(record.preliminary_profit.fee_sources.weight_assumption, null);
});

test("FBM and explicitly invalid weight cannot use the missing-weight assumption in handoff", () => {
  for (const weight of [0, -1, "invalid", false]) {
    for (const detailParserVersion of [undefined, 11]) {
      const item = candidate(4, { detailParserVersion });
      item.analysisProfitInputs.actualWeightKg = weight;
      const profit = exportOne(item).products[0].preliminary_profit;
      assert.equal(profit.result, null, `weight=${weight}; parser=${detailParserVersion}`);
      assert.ok(profit.missing_inputs.includes("actualWeightKg"));
      assert.equal(profit.inputs.assumedWeightKg, undefined);
    }
  }
  const item = candidate(4);
  item.analysisProfitInputs.actualWeightKg = null;
  item.analysisProfitInputs.fulfillmentMode = "FBM";
  const profit = exportOne(item).products[0].preliminary_profit;
  assert.equal(profit.result, null);
  assert.equal(profit.inputs.assumedWeightKg, undefined);
});
