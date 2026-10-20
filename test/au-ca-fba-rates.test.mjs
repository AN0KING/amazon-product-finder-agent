import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AU_FBA_WORKBOOK_RATES,
  CA_FBA_PEAK_ENVELOPE_RATES,
  PROFIT_FORMULA_VERSION,
  calculateProductProfit,
  estimateAu2026FbaFeeByProductWeight,
  estimateCa2026FbaFeeByProductWeight,
  estimateMinimumFbaFee,
} from '../lib/profit-model.mjs';

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, actual + ' != ' + expected);

for (const [weight, low, high] of [[0.075, 3.67, 4.58], [0.225, 4.35, 5.26], [0.475, 4.70, 5.61]]) {
  test('AU standard envelope ' + weight + 'kg uses the confirmed sale-price boundary', () => {
    assert.equal(estimateAu2026FbaFeeByProductWeight({ actualWeightKg: weight, itemPriceAud: 12.99 }).fee, low);
    assert.equal(estimateAu2026FbaFeeByProductWeight({ actualWeightKg: weight, itemPriceAud: 13 }).fee, low);
    assert.equal(estimateAu2026FbaFeeByProductWeight({ actualWeightKg: weight, itemPriceAud: 13.01 }).fee, high);
  });
}

test('AU fractional grams advance across standard-envelope weight bands', () => {
  const next75 = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.075001, itemPriceAud: 13 });
  const next225 = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.225001, itemPriceAud: 13 });
  assert.equal(next75.billableWeightG, 76);
  assert.equal(next75.fee, 4.35);
  assert.equal(next225.billableWeightG, 226);
  assert.equal(next225.fee, 4.70);
  const above = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.475001, itemPriceAud: 13 });
  assert.equal(above.billableWeightG, 476);
  assert.equal(above.feeWeightG, 475);
  assert.equal(above.fee, 4.70);
  assert.equal(above.overweightCapped, true);
});

test('AU only permits standard envelopes, including legacy automatic policy callers', () => {
  for (const policy of ['standard', 'auto', 'smallest']) {
    const result = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.05, itemPriceAud: 10, envelopeSizePolicy: policy });
    assert.equal(result.fee, 3.67);
    assert.equal(result.effectiveEnvelopeSizePolicy, 'standard');
  }
  for (const policy of ['small', 'large', 'parcel']) {
    assert.equal(estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.05, itemPriceAud: 10, envelopeSizePolicy: policy }), null);
  }
  assert.equal(AU_FBA_WORKBOOK_RATES.length, 3);
});

test('AU supplied dimensions are checked independent of dimension order', () => {
  const fitting = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceAud: 13, dimensionsCm: [2.5, 33, 23] });
  assert.equal(fitting.fee, 4.35);
  assert.equal(fitting.dimensionsAssumption, null);
  for (const dimensionsCm of [[33.01, 23, 2.5], [33, 23.01, 2.5], [33, 23, 2.501]]) {
    assert.equal(estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceAud: 13, dimensionsCm }), null);
    const assumed = estimateMinimumFbaFee({ marketplace: 'AU', salePrice: 13, dimensionsCm });
    assert.equal(assumed.fee, 3.67);
    assert.equal(assumed.dimensionsAssumption, 'minimum_envelope_despite_known_dimensions');
    assert.equal(assumed.actualWeightKg, null);
  }
});

test('AU missing dimensions are clearly marked as an estimate', () => {
  const result = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceAud: 13 });
  assert.equal(result.dimensionsCm, null);
  assert.equal(result.dimensionsAssumption, 'standard_envelope_dimensions_not_verified');
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.maxDimensionsCm, [33, 23, 2.5]);
});

for (const [weight, expectedRegular, expectedDiscount] of [
  [0.1, 4.89555, 4.06755],
  [0.2, 5.16465, 4.33665],
  [0.3, 5.49585, 4.66785],
  [0.4, 5.796, 4.968],
  [0.5, 6.15825, 5.33025],
]) {
  test('CA ' + weight + 'kg applies the strict low-price boundary and surcharge', () => {
    const discounted = estimateCa2026FbaFeeByProductWeight({ actualWeightKg: weight, itemPriceCad: 13.99 });
    const regular = estimateCa2026FbaFeeByProductWeight({ actualWeightKg: weight, itemPriceCad: 14 });
    closeTo(discounted.fee, expectedDiscount);
    closeTo(regular.fee, expectedRegular);
    assert.equal(discounted.discount, 0.8);
    assert.equal(regular.discount, 0);
    assert.equal(discounted.surchargeMultiplier, 1.035);
  });
}

test('CA fractional grams advance into the next band and never fall back to US fees', () => {
  for (const [weight, nextBase] of [[0.100001, 4.99], [0.200001, 5.31], [0.300001, 5.60], [0.400001, 5.95]]) {
    assert.equal(estimateCa2026FbaFeeByProductWeight({ actualWeightKg: weight, itemPriceCad: 20 }).baseFee, nextBase);
  }
  const above = estimateCa2026FbaFeeByProductWeight({ actualWeightKg: 0.500001, itemPriceCad: 20 });
  assert.equal(above.billableWeightG, 501);
  assert.equal(above.feeWeightG, 500);
  closeTo(above.fee, 6.15825);
  assert.equal(above.overweightCapped, true);
  assert.equal(CA_FBA_PEAK_ENVELOPE_RATES.length, 5);
});

test('automatic estimates require valid positive weight and selling price', () => {
  for (const invalid of [undefined, null, '', 0, -1, NaN, Infinity, 'invalid']) {
    assert.equal(estimateAu2026FbaFeeByProductWeight({ actualWeightKg: invalid, itemPriceAud: 13 }), null);
    assert.equal(estimateCa2026FbaFeeByProductWeight({ actualWeightKg: invalid, itemPriceCad: 14 }), null);
    assert.equal(estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceAud: invalid }), null);
    assert.equal(estimateCa2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceCad: invalid }), null);
  }
});

test('CA keeps the supplied peak policy and workbook traceability without switching dates', () => {
  const result = estimateCa2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceCad: 13.99 });
  assert.equal(result.currency, 'CAD');
  assert.equal(result.seasonPolicy, 'peak_only_user_selected');
  assert.equal(result.peakStartsOn, '2026-10-15');
  assert.equal(result.peakEndsOn, '2027-01-14');
  assert.equal(result.sourceCell, 'Sheet1!C4');
  assert.ok(result.sourceCells.includes('Sheet1!D4'));
  assert.ok(result.sourceCells.includes('Sheet1!D3'));
  assert.match(result.rateSource, /亚马逊加拿大站FBA配送费-旺季信封件/);
  assert.match(PROFIT_FORMULA_VERSION, /all-market-minimum-envelope-v12$/);
});

test('AU traceability selects the correct low or high price source cell', () => {
  const low = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.079, itemPriceAud: 13 });
  const high = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.079, itemPriceAud: 13.01 });
  assert.equal(low.sourceCell, '表格_20261009!D3');
  assert.equal(high.sourceCell, '表格_20261009!E3');
  assert.ok(high.sourceCells.includes('表格_20261009!E3'));
  assert.match(high.rateSource, /澳洲站点fba配送费明细标准信封/);
});

test('missing-weight AU and CA fees use the selling-price rules without fabricating weight', () => {
  const cases = [['AU', 13, 3.67], ['AU', 13.01, 4.58], ['CA', 13.99, 4.06755], ['CA', 14, 4.89555]];
  for (const [marketplace, salePrice, expected] of cases) {
    const result = estimateMinimumFbaFee({ marketplace, salePrice });
    closeTo(result.fee, expected);
    assert.equal(result.actualWeightKg, null);
    assert.equal(result.billableWeightG, null);
    assert.equal(result.feeWeightG, null);
    assert.equal(result.overweightCapped, false);
    assert.equal(result.assumption, 'missing_weight_minimum_fba_estimate');
    assert.equal(result.priceAssumption, null);
  }
});

test('missing selling price only permits an explicitly labelled minimum estimate', () => {
  for (const [marketplace, expected, priceKey] of [['AU', 3.67, 'itemPriceAud'], ['CA', 4.06755, 'itemPriceCad']]) {
    const result = estimateMinimumFbaFee({ marketplace });
    closeTo(result.fee, expected);
    assert.equal(result[priceKey], null);
    assert.equal(result.actualWeightKg, null);
    assert.equal(result.priceAssumption, 'missing_price_low_price_band_assumed');
    assert.ok(result.ambiguity.includes('sale-price-not-provided'));
  }
  assert.equal(estimateMinimumFbaFee({ marketplace: 'US' }).fee, 3.22);
  assert.equal(estimateMinimumFbaFee({ marketplace: 'GB' }), null);
});

test('Canadian surcharge precision survives profit calculation', () => {
  const estimate = estimateCa2026FbaFeeByProductWeight({ actualWeightKg: 0.1, itemPriceCad: 13.99 });
  const inputs = { salePrice: 13.99, purchaseCostCny: 2, fulfillmentFee: estimate.fee,
    exchangeRate: 5, fulfillmentMode: 'FBA', actualWeightKg: 0.1, airFreightActualWeightOnly: true };
  const result = calculateProductProfit(inputs);
  const roundedResult = calculateProductProfit({ ...inputs, fulfillmentFee: 4.07 });
  assert.equal(result.fulfillmentFee, estimate.fee);
  assert.equal(result.parts.fulfillment, estimate.fee);
  assert.notEqual(result.fulfillmentFee, 4.07);
  closeTo(result.profit - roundedResult.profit, 0.00245);
});

for (const [market, estimate, priceKey, cap, lowPrice, highPrice, lowFee, highFee] of [
  ['AU', estimateAu2026FbaFeeByProductWeight, 'itemPriceAud', 475, 13, 13.01, 4.70, 5.61],
  ['CA', estimateCa2026FbaFeeByProductWeight, 'itemPriceCad', 500, 13.99, 14, 5.33025, 6.15825],
]) {
  test(`${market} maximum fee tier caps only the fee and retains exact real weight for freight`, () => {
    for (const actualWeightKg of [cap / 1000, cap / 1000 + 0.000001, 2.345]) {
      for (const [price, expectedFee] of [[lowPrice, lowFee], [highPrice, highFee]]) {
        const result = estimate({ actualWeightKg, [priceKey]: price });
        closeTo(result.fee, expectedFee);
        assert.equal(result.actualWeightKg, actualWeightKg);
        assert.equal(result.billableWeightG, Math.ceil(actualWeightKg * 1000 - 1e-9));
        assert.equal(result.feeWeightG, cap);
        assert.equal(result.weightCapG, cap);
        assert.equal(result.overweightCapped, actualWeightKg > cap / 1000);
        if (result.overweightCapped) {
          assert.equal(result.assumption, 'overweight_maximum_tier_capped');
          assert.match(result.rateApplicability, /用户指定最高重量档封顶/);
          assert.ok(result.ambiguity.includes('weight-exceeds-envelope-table'));
          assert.equal(result.confidence, 'low');
        }
        const profit = calculateProductProfit({ salePrice: price, purchaseCostCny: 1, fulfillmentFee: result.fee,
          exchangeRate: 5, fulfillmentMode: 'FBA', actualWeightKg: result.actualWeightKg,
          airFreightActualWeightOnly: true, airFreightRateCnyPerKg: 10 });
        assert.equal(profit.airFreight.actualWeightKg, actualWeightKg);
        assert.equal(profit.airFreight.chargeableWeightKg, actualWeightKg);
        closeTo(profit.airFreight.airFreightCny, actualWeightKg * 10);
        assert.equal(profit.domesticFreightWeightKg, actualWeightKg);
      }
    }
  });
}

test('overweight AU cap cannot certify a product that exceeds known envelope dimensions', () => {
  const input = { actualWeightKg: 2, itemPriceAud: 13 };
  const fitting = estimateAu2026FbaFeeByProductWeight({ ...input, dimensionsCm: [33, 23, 2.5] });
  assert.equal(fitting.fee, 4.70);
  assert.equal(fitting.assumption, 'overweight_maximum_tier_capped');
  assert.equal(fitting.dimensionsAssumption, null);
  assert.equal(fitting.confidence, 'low');
  for (const dimensionsCm of [[34, 23, 2.5], [33, 24, 2.5], [33, 23, 3]]) {
    assert.equal(estimateAu2026FbaFeeByProductWeight({ ...input, dimensionsCm }), null);
  }
});

test('overweight cap keeps AU and CA top-row workbook traceability and CA surcharge precision', () => {
  const au = estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 2, itemPriceAud: 13.01 });
  const ca = estimateCa2026FbaFeeByProductWeight({ actualWeightKg: 2, itemPriceCad: 13.99 });
  assert.equal(au.sourceCell, '表格_20261009!E4');
  assert.equal(ca.sourceCell, 'Sheet1!C8');
  assert.ok(ca.sourceCells.includes('Sheet1!D8'));
  assert.equal(ca.baseFee, 5.95);
  assert.equal(ca.discount, 0.8);
  assert.equal(ca.surchargeMultiplier, 1.035);
  closeTo(ca.fee, (5.95 - 0.8) * 1.035);
});
