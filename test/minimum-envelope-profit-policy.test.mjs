import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../lib/profit-model.mjs';

const markets = { AU: 'AUD', CA: 'CAD', US: 'USD', NL: 'EUR', UK: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', PL: 'PLN', MX: 'MXN', BR: 'BRL' };
const base = { salePrice: 20, purchaseCostCny: 5, fulfillmentMode: 'FBA', fulfillmentFee: 8.88,
  exchangeRate: 5, actualWeightKg: null, airFreightActualWeightOnly: true, airFreightRateCnyPerKg: 45,
  domesticFreightRateCnyPerKg: 5 };
const assumedKg = market => market === 'AU' ? .075 : market === 'CA' ? .1 : .25 / 2.2046226218;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('minimum fees cover all twelve configured markets and identify reference rates honestly', () => {
  for (const [marketplace, currency] of Object.entries(markets)) {
    const value = model.estimateMinimumFbaFee({ marketplace, salePrice: 20 });
    assert.ok(value, marketplace);
    assert.equal(value.currency, currency);
    assert.equal(value.actualWeightKg, null);
    close(value.assumedWeightKg, assumedKg(marketplace));
    assert.equal(value.weightAssumption, 'missing_weight_minimum_envelope');
    assert.equal(value.weightAssumptionMarket, marketplace);
    assert.doesNotMatch(value.weightSource, /页面未提供/);
    if (!['AU', 'CA', 'US'].includes(marketplace)) {
      assert.equal(value.fee, 3.22);
      assert.equal(value.referenceMarketplace, 'US');
      assert.equal(value.rateModel, 'us_sop_nominal_proxy');
      assert.match(value.rateApplicability, /名义.*估算/);
      assert.match(value.rateApplicability, /非当地官方/);
    }
  }
  for (const marketplace of ['FK', 'UNKNOWN', '', undefined]) assert.equal(model.estimateMinimumFbaFee({ marketplace }), null);
});

test('AU and CA minimum fees keep their actual selling-price boundaries and precision', () => {
  for (const [marketplace, salePrice, fee] of [['AU', 13, 3.67], ['AU', 13.01, 4.58], ['CA', 13.99, 4.06755], ['CA', 14, 4.89555]]) {
    close(model.estimateMinimumFbaFee({ marketplace, salePrice }).fee, fee);
  }
});

test('missing actual weight receives a separate assumption without modifying the supplied object', () => {
  for (const market of Object.keys(markets)) for (const actualWeightKg of [null, undefined, '']) {
    const input = { ...base, actualWeightKg };
    const before = structuredClone(input);
    const value = model.applyMissingWeightProfitAssumption(input, market);
    assert.notEqual(value, input);
    assert.deepEqual(input, before);
    assert.equal(value.actualWeightKg, actualWeightKg);
    assert.equal(value.fulfillmentFee, 8.88, 'A manually selected FBA fee must remain unchanged.');
    if (['AU', 'CA'].includes(market)) {
      assert.equal(value.assumedWeightKg, undefined);
      continue;
    }
    close(value.assumedWeightKg, assumedKg(market));
    assert.equal(value.weightAssumption, 'missing_weight_minimum_envelope');
    assert.equal(value.weightAssumptionMarket, market);
  }
});

test('explicit invalid masses, FBM and unknown markets never receive a missing-weight assumption', () => {
  for (const actualWeightKg of [0, -1, false, true, NaN, Infinity, 'invalid', '0', '-1']) {
    const result = model.applyMissingWeightProfitAssumption({ ...base, actualWeightKg }, 'AU');
    assert.equal(result.assumedWeightKg, undefined, String(actualWeightKg));
    assert.equal(model.calculateProductProfit(result), null, String(actualWeightKg));
  }
  for (const input of [{ ...base, fulfillmentMode: 'FBM' }, { ...base, fulfillmentMode: undefined }]) {
    assert.equal(model.applyMissingWeightProfitAssumption(input, 'AU').assumedWeightKg, undefined);
  }
  assert.equal(model.applyMissingWeightProfitAssumption(base, 'FK').assumedWeightKg, undefined);
});

test('estimated profit uses the separate mass for both freight costs while actual mass remains unknown', () => {
  for (const marketplace of Object.keys(markets)) {
    const value = model.calculateProductProfit(model.applyMissingWeightProfitAssumption(base, marketplace));
    if (['AU', 'CA'].includes(marketplace)) { assert.equal(value, null); continue; }
    assert.ok(value && Number.isFinite(value.profit), marketplace);
    assert.equal(value.airFreight.actualWeightKg, null);
    close(value.airFreight.assumedWeightKg, assumedKg(marketplace));
    close(value.airFreight.chargeableWeightKg, assumedKg(marketplace));
    close(value.airFreight.airFreightCny, assumedKg(marketplace) * 45);
    close(value.domesticFreightCny, assumedKg(marketplace) * 5);
    assert.equal(value.airFreight.source, 'minimum_envelope_assumption');
    assert.equal(value.airFreight.confidence, 'low');
    assert.equal(value.domesticFreightWeightSource, 'minimum_envelope_assumption');
    assert.equal(value.fulfillmentFee, 8.88);
    assert.equal(value.weightAssumption, 'missing_weight_minimum_envelope');
    assert.equal(value.weightAssumptionMarket, marketplace);
    assert.equal(value.isEstimate, true);
  }
});

test('a valid real weight removes old assumptions and keeps existing carton and dimension selection', () => {
  const assumed = model.applyMissingWeightProfitAssumption(base, 'US');
  const actual = model.applyMissingWeightProfitAssumption({ ...assumed, actualWeightKg: .42 }, 'US');
  assert.equal(actual.assumedWeightKg, undefined);
  assert.equal(actual.weightAssumption, undefined);
  assert.equal(actual.weightAssumptionMarket, undefined);
  const real = model.calculateProductProfit(actual);
  assert.equal(real.airFreight.actualWeightKg, .42);
  assert.equal(real.airFreight.chargeableWeightKg, .42);
  assert.equal(real.weightAssumption, undefined);
  assert.notEqual(real.isEstimate, true);
  const carton = model.calculateProductProfit({ ...assumed, airFreightActualWeightOnly: false, cartonWeightKg: 10, unitsPerCarton: 20 });
  assert.equal(carton.airFreight.chargeableWeightKg, .5);
  assert.equal(carton.airFreight.source, 'carton');
  const dimensionsCm = [30, 20, 10];
  const dimension = model.calculateProductProfit({ ...assumed, airFreightActualWeightOnly: false, dimensionsCm });
  close(dimension.airFreight.chargeableWeightKg, model.calculateDimensionalWeight({ dimensionsCm }).dimensionalWeightKg);
  const actualOnly = model.calculateProductProfit({ ...assumed, dimensionsCm, cartonWeightKg: 10, unitsPerCarton: 20 });
  close(actualOnly.airFreight.chargeableWeightKg, .25 / 2.2046226218);
});

test('known oversized dimensions are explicit minimum-fee assumptions only for missing weight', () => {
  const dimensionsCm = [40, 30, 5];
  const minimum = model.estimateMinimumFbaFee({ marketplace: 'AU', salePrice: 13, dimensionsCm });
  assert.equal(minimum.fee, 3.67);
  assert.deepEqual(minimum.dimensionsCm, dimensionsCm);
  assert.equal(minimum.dimensionsAssumption, 'minimum_envelope_despite_known_dimensions');
  assert.match(minimum.rateApplicability, /尺寸.*超出/);
  assert.equal(model.estimateAu2026FbaFeeByProductWeight({ actualWeightKg: .1, itemPriceAud: 13, dimensionsCm }), null);
});

test('a raw assumption cannot override explicit invalid or real weights and unknown assumption markets', () => {
  const assumed = model.applyMissingWeightProfitAssumption(base, 'AU');
  for (const actualWeightKg of [0, -1, false, 'invalid']) assert.equal(model.calculateProductProfit({ ...assumed, actualWeightKg }), null);
  const real = model.calculateProductProfit({ ...assumed, actualWeightKg: .2 });
  assert.equal(real.airFreight.actualWeightKg, .2);
  assert.equal(real.weightAssumption, undefined);
  assert.equal(model.calculateProductProfit({ ...assumed, weightAssumptionMarket: 'FK' }), null);
  assert.equal(model.calculateProductProfit({ ...assumed, fulfillmentMode: 'FBM' }), null);
});

test('normalizing invalid product mass to null does not make it eligible for a missing-weight estimate', () => {
  for (const field of ['productWeight', 'productWeightKg', 'billingWeight', 'actualWeightKg', 'profitInputs.actualWeightKg']) {
    for (const raw of [0, -1, false, true, NaN, Infinity, 'invalid', '0', '-1', ' ']) {
      const product = field.startsWith('profitInputs.') ? { profitInputs: { actualWeightKg: raw } } : { [field]: raw };
      assert.equal(model.hasInvalidProductWeight(product), true, `${field}=${String(raw)}`);
      const inputs = model.applyMissingWeightProfitAssumption(base, 'AU', product);
      assert.equal(inputs.assumedWeightKg, undefined, `${field}=${String(raw)}`);
      assert.equal(model.calculateProductProfit(inputs), null, `${field}=${String(raw)}`);
    }
  }
  for (const product of [
    { productWeight: null, billingWeight: null, profitInputs: { actualWeightKg: null } },
    { productWeight: .25, productWeightEvidence: null },
    { fbaWeight: 0, packageWeightKg: -1, fbaPackageWeightKg: 'invalid' },
  ]) {
    assert.equal(model.hasInvalidProductWeight(product), false);
    assert.equal(model.applyMissingWeightProfitAssumption(base, 'AU', product).assumedWeightKg, undefined);
  }
  const manual = model.applyMissingWeightProfitAssumption({ ...base, actualWeightKg: .2 }, 'AU', { productWeight: -1 });
  assert.equal(manual.assumedWeightKg, undefined);
  assert.equal(model.calculateProductProfit(manual).airFreight.actualWeightKg, .2);
});
