import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import * as profitModel from '../lib/profit-model.mjs';
import * as pieceCount from '../lib/title-piece-count.mjs';
import { recomputeProductProfit } from '../lib/product-profit-state.mjs';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const NOW = '2026-09-24T01:02:03.000Z';
const noWeightInformation = () => ({ version: 1, asin: 'B000000001', status: 'complete', reason: null,
  inspection: { version: 3, asin: 'B000000001', status: 'complete', stable: true, rowCount: 1,
    parsedSections: [{ selector: '#productDetails', rowCount: 1 }],
    sections: [{ selector: '#productDetails', status: 'complete', rowCount: 1 }] },
  rowCount: 1, weightStatus: 'not_provided', sections: [{ selector: '#productDetails', heading: 'Product information',
    rows: [{ label: 'Brand', value: 'Synthetic brand' }] }] });
const functionNames = [
  'getDefaultProfitInputs', 'migrateLegacyProfitDefaults', 'numberOrNull', 'finiteOrNull', 'roundMoney',
  'isAnalysisReadOnly', 'normalizeFulfillmentMode', 'ensureFulfillmentState', 'fbaEstimationWeightKg',
  'assumeFbaForWeightedProduct', 'refreshProductWeightState', 'ensureProductProfitInputs', 'parseDimensionsCm',
  'calculateOurSalePrice', 'ensureProductPieceCount', 'isManualCostProduct', 'totalPurchaseCostCny',
  'ensureProductPurchasePricing', 'applyAutomaticFba', 'automaticFbaFeeSource', 'estimateWeightOnlyFbaFee',
  'getFulfillmentFee', 'fulfillmentFeeMissingLabel', 'collectMissingFields', 'rebuildProductMissing',
  'calculateProfit', 'profitCalculationMissingReasons', 'updateProductComputed',
];
const functions = functionNames.map(name => {
  const match = appSource.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'));
  assert.ok(match, `The parity oracle requires the existing app function ${name}.`);
  return match[0];
}).join('\n');
const marketStart = appSource.indexOf('  const MARKET_CONFIGS = ');
const marketEnd = appSource.indexOf('  let activeMarket = ', marketStart);
assert.ok(marketStart >= 0 && marketEnd > marketStart);

// The comparison uses the app's actual function bodies, with no DOM, API,
// browser, timers, or real run files. Only the new context adapter is supplied.
function appProfitOracle(product, context = {}) {
  const fixedNow = context.now || NOW;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return Date.parse(fixedNow); }
  }
  const scope = vm.createContext({
    ...profitModel, ...pieceCount, structuredClone, Date: FixedDate,
    oracleProduct: structuredClone(product), oracleContext: structuredClone(context),
  });
  const expected = vm.runInContext(`
    ${appSource.slice(marketStart, marketEnd)}
    const scope = oracleContext.snapshot || oracleContext;
    const runState = scope.runState || {};
    const code = String(oracleProduct.marketplace || oracleContext.marketplace || scope.runState?.marketplace || scope.marketplace || 'NL').toUpperCase();
    let activeMarket = MARKET_CONFIGS[code] || MARKET_CONFIGS.NL;
    const analysisHandoffPendingIds = new Set();
    const analysisVersionPendingIds = new Set();
    const COMPETITOR_PRICE_RATIO = 1;
    const FBA_WEIGHT_STANDARD_SIZE_POLICY = 'large';
    const AU_FBA_ENVELOPE_SIZE_POLICY = 'standard';
    const MISSING_WEIGHT_LOWEST_FREIGHT_KG = 0.075;
    const MISSING_WEIGHT_LOWEST_FREIGHT_LABEL = "重量未采集 · 按最低运费档估算";
    ${functions}
    (() => {
      const product = oracleProduct;
      if (isAnalysisReadOnly(product)) return product;
      const defaults = migrateLegacyProfitDefaults(scope.costParams, activeMarket.code);
      for (const key of ['commissionRate', 'fxLossRate', 'marketingRate', 'managementRate', 'returnsRate', 'purchaseTaxRate', 'domesticFreightRateCnyPerKg', 'airFreightRateCnyPerKg', 'volumetricDivisor']) {
        const rate = finiteOrNull(scope.profitModel?.[key]);
        if (rate !== null && rate >= 0) defaults[key] = rate;
      }
      const contextRate = [scope.profitModel?.exchangeRate, scope.runState?.exchangeRate]
        .map(finiteOrNull).find(rate => rate !== null && rate > 0);
      if (contextRate > 0) defaults.exchangeRate = contextRate;
      ensureProductProfitInputs(product, defaults);
      ensureFulfillmentState(product);
      assumeFbaForWeightedProduct(product);
      refreshProductWeightState(product);
      ensureProductPurchasePricing(product);
      product.salePrice = calculateOurSalePrice(product);
      applyAutomaticFba(product);
      rebuildProductMissing(product);
      updateProductComputed(product);
      return product;
    })()
  `, scope, { filename: 'app-profit-parity.js' });
  return structuredClone(expected);
}

const canonicalProduct = (overrides = {}) => ({
  id: 'AU:B000000001', asin: 'B000000001', sourceAsin: 'B000000001', marketplace: 'AU', sourceMarketplace: 'AU', analysisSourceMode: 'amazon_only',
  detailStatus: 'success', detailParserVersion: 5, currentPrice: 9.99, currentPriceStatus: 'verified', manualSalePrice: true, salePrice: 18,
  name: 'Canonical manual title', englishName: 'Canonical manual title', sellerId: 'EXAMPLESELLER', rating: 4.5, reviews: 33,
  productWeight: 0.1, billingWeight: 0.1, imageUrl: 'https://m.media-amazon.com/images/I/example.jpg',
  manualPurchaseCost: true, purchaseCost: 6, purchaseUnitCostCny: 3, pieceCount: 2, pieceCountSource: 'manual',
  manualFbaFee: true, fbaFee: 2, fulfillmentMode: 'FBA', fulfillmentModeSource: 'manual',
  manualAmazonFields: { title: true }, fieldSources: { title: 'manual', currentPrice: 'amazon_product_page' }, reviewStatus: 'pending',
  suppliers: [{ name: 'Preserved supplier', unitPriceCny: 3 }], supplierSearchStatus: 'manual_cost',
  profitInputs: { ...profitModel.DEFAULT_PROFIT_RATES, formulaVersion: profitModel.PROFIT_FORMULA_VERSION, exchangeRate: 4.8, actualWeightKg: 0.1 },
  ...overrides,
});

function assertParity(product, context = {}) {
  const inputBefore = structuredClone(product);
  const contextBefore = structuredClone(context);
  const options = { now: NOW, ...context };
  const expected = appProfitOracle(product, options);
  const actual = recomputeProductProfit(product, options);
  assert.deepEqual(actual, expected);
  assert.deepEqual(product, inputBefore, 'Recomputation must not mutate the input product.');
  assert.deepEqual(context, contextBefore, 'Recomputation must not mutate the context.');
  assert.notEqual(actual, product);
  return actual;
}

test('Item Weight policy excludes unproven package and stale weights without inventing AU estimates', () => {
  const markers = [
    { detailParserVersion: 11 },
    { productInformation: { weightSelection: { policy: 'item_weight_only' } } },
    { weightSelection: { policy: 'item_weight_only' } },
  ];
  const evidenceCases = [null, { label: 'Package Weight', kind: 'package', value: 0.3 },
    { label: 'Item Weight', kind: 'product' }, { label: 'Item Weight', kind: 'product', value: 0.14 }];
  for (const marker of markers) {
    for (const productWeightEvidence of evidenceCases) {
      const input = canonicalProduct({ ...marker, productWeight: 0.3, fbaWeight: 0.3,
        billingWeight: 0.3, actualWeightKg: 0.3, productWeightEvidence,
        profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: 0.3, weightSource: 'Amazon 包装重量回退' } });
      const result = assertParity(input);
      assert.equal(result.billingWeight, null);
      assert.equal(result.profitInputs.actualWeightKg, null);
      assert.equal(result.profitCalculation, null);
      assert.equal(result.margin, null);
      assert.ok(result.profitPendingReasons.includes('商品重量或包裹重量'));
      assert.equal(result.complete, false);
      assert.equal(result.fbaWeight, 0.3, 'Separate logistics metadata is preserved.');
      assert.equal(result.purchaseCost, 6);
      assert.deepEqual(result.suppliers, input.suppliers);
    }
  }
});

test('Item Weight drives freight and automatic FBA instead of the heavier package in both runtimes', () => {
  const result = assertParity(canonicalProduct({ detailParserVersion: 11, productWeight: 0.14,
    productWeightEvidence: { label: 'Item Weight', kind: 'product', value: 0.14 },
    billingWeight: 0.5, fbaWeight: 0.5, manualFbaFee: false, fbaFee: null,
    profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: 0.5 } }));
  assert.equal(result.billingWeight, 0.14);
  assert.equal(result.profitInputs.actualWeightKg, 0.14);
  assert.equal(result.profitCalculation.domesticFreightWeightKg, 0.14);
  assert.equal(result.profitCalculation.airFreight.actualWeightKg, 0.14);
  assert.equal(result.fbaFee, 5.26);
  assert.equal(result.fbaWeight, 0.5);
  assert.ok(Number.isFinite(result.margin));
  assert.equal(result.complete, true);
});

test('explicit invalid product or saved input weight stays pending through repeated recomputation', () => {
  for (const invalid of [0, -1, false, 'invalid']) {
    for (const source of ['product', 'saved_input']) {
      const input = canonicalProduct({ detailParserVersion: 12, productWeight: source === 'product' ? invalid : null,
        billingWeight: null, manualFbaFee: false, fbaFee: null, productWeightEvidence: null,
        profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: source === 'saved_input' ? invalid : null } });
      const first = assertParity(input);
      const result = assertParity(first);
      assert.equal(result.profitInputs.assumedWeightKg, undefined, `${source}: ${invalid}`);
      assert.equal(result.profitCalculation, null);
      assert.equal(result.fbaEstimate, null);
      assert.ok(result.profitPendingReasons.includes('商品重量或包裹重量'));
    }
  }
});

test('real Item Weight clears stale minimum-tier metadata while retaining manual fees in every market', () => {
  for (const marketplace of ['AU', 'CA', 'US', 'NL', 'UK', 'DE', 'FR', 'IT', 'ES', 'PL', 'MX', 'BR']) {
    const assumed = assertParity(canonicalProduct({ marketplace, detailParserVersion: 12,
      productWeight: null, billingWeight: null, manualFbaFee: false, fbaFee: null,
      profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: null } }));
    if (['AU', 'CA'].includes(marketplace)) assert.equal(assumed.fbaEstimate, null);
    else assert.equal(assumed.fbaEstimate.assumption, 'missing_weight_minimum_fba_estimate');
    const actual = assertParity({ ...assumed, productWeight: 0.2,
      productWeightEvidence: { label: 'Item Weight', kind: 'product', value: 0.2 },
      manualFbaFee: true, fbaFee: 8.88 });
    assert.equal(actual.fbaFee, 8.88);
    assert.equal(actual.profitInputs.actualWeightKg, 0.2);
    assert.equal(actual.profitInputs.assumedWeightKg, undefined);
    assert.notEqual(actual.fbaEstimate?.assumption, 'missing_weight_minimum_fba_estimate');
    assert.equal(actual.fbaEstimate?.assumedWeightKg, undefined);
    assert.equal(actual.profitCalculation.fulfillmentFee, 8.88);
    assert.equal(actual.profitCalculation.isEstimate, undefined);
  }
});

test('explicit manual weights remain usable under Item Weight policy without changing purchase inputs', () => {
  for (const manual of [
    { manualBillingWeight: true, billingWeight: 0.2 },
    { manualProductWeight: true, productWeight: 0.2 },
    { profitInputs: { ...canonicalProduct().profitInputs, actualWeightKg: 0.2, weightSource: 'product_manual' } },
  ]) {
    const input = canonicalProduct({ detailParserVersion: 11, productWeight: null,
      productWeightEvidence: null, fbaWeight: 0.5, billingWeight: 0.5, ...manual });
    const result = assertParity(input);
    assert.equal(result.billingWeight, 0.2);
    assert.equal(result.profitInputs.actualWeightKg, 0.2);
    assert.equal(result.profitCalculation.airFreight.actualWeightKg, 0.2);
    assert.ok(Number.isFinite(result.margin));
    assert.equal(result.purchaseCost, input.purchaseCost);
    assert.equal(result.purchaseUnitCostCny, input.purchaseUnitCostCny);
    assert.deepEqual(result.suppliers, input.suppliers);
  }
});

test('legacy automatic product weights without the new policy retain saved calculations', () => {
  const result = assertParity(canonicalProduct({ detailParserVersion: 10, productWeight: 0.3,
    productWeightEvidence: { label: 'Package Weight', kind: 'package', value: 0.3 }, fbaWeight: 0.5 }));
  assert.equal(result.billingWeight, 0.3);
  assert.equal(result.profitCalculation.airFreight.actualWeightKg, 0.3);
  assert.ok(Number.isFinite(result.margin));
});

for (const [marketplace, exchangeRate] of Object.entries({
  AU: 4.8, US: 7.12, NL: 7.85, CA: 5.2, UK: 9.6, DE: 7.85,
  FR: 7.85, IT: 7.85, ES: 7.85, PL: 1.85, MX: 0.42, BR: 1.35,
})) {
  test(`${marketplace} uses the same market defaults, automatic sale price and FBA result as the app`, () => {
    const product = canonicalProduct({ marketplace, sourceMarketplace: marketplace, profitInputs: undefined, manualSalePrice: false, salePrice: 8.99, manualFbaFee: false, fbaFee: null });
    const result = assertParity(product);
    assert.equal(result.profitInputs.exchangeRate, exchangeRate);
    assert.equal(result.salePrice, 9.99);
    assert.ok(Number.isFinite(result.margin));
  });
}

test('canonical manual sale price, FBA fee, procurement cost and piece count survive recomputation', () => {
  const result = assertParity(canonicalProduct());
  assert.equal(result.salePrice, 18);
  assert.equal(result.fbaFee, 2);
  assert.equal(result.purchaseCost, 6);
  assert.equal(result.pieceCount, 2);
  assert.equal(result.profitCalculation.purchaseCostAssumedZero, false);
});

test('listing-date absence and unfinished date verification do not change profit or completeness', () => {
  const dated = assertParity(canonicalProduct({ amazonFirstAvailableDate: '2020-01-01', amazonFirstAvailableDateStatus: 'found' }));
  for (const status of ['not_provided', 'unresolved']) {
    const result = assertParity(canonicalProduct({ amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: status,
      productInformation: { version: 1, asin: 'B000000001', status: status === 'unresolved' ? 'incomplete' : 'complete', reason: status === 'unresolved' ? 'inspection_timeout' : null },
      missing: ['竞品上架时间'], amazonMissing: ['竞品上架时间'], complete: false,
    }));
    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.profitPendingReasons, []);
    assert.deepEqual(result.profitCalculation, dated.profitCalculation);
    assert.equal(result.margin, dated.margin);
    assert.equal(result.amazonFirstAvailableDate, null);
    assert.equal(result.amazonFirstAvailableDateStatus, status);
  }
});

test('legacy provider listing dates remain optional metadata for normal analysis', () => {
  const base = canonicalProduct({ analysisSourceMode: 'sellersprite', sales30: 100, sales60: 200, hasAPlus: false,
    firstFba: '2020-02-01', productDimensions: '10 x 5 x 2 cm', listingAvailableAt: '2020-01-01' });
  const dated = assertParity(base);
  const undated = assertParity({ ...base, listingAvailableAt: null, amazonFirstAvailableDateStatus: 'not_provided' });
  assert.equal(dated.complete, true);
  assert.equal(undated.complete, true);
  assert.deepEqual(undated.profitCalculation, dated.profitCalculation);
  assert.ok(!undated.missing.some(value => /上架|日期/.test(value)));
});

test('manual FBM fees remain independent of automatic FBA estimation', () => {
  const result = assertParity(canonicalProduct({ fulfillmentMode: 'FBM', manualFbmFee: true, fbmFee: 4.25, manualFbaFee: false, fbaFee: 99 }));
  assert.equal(result.fulfillmentMode, 'FBM');
  assert.equal(result.fbmFee, 4.25);
  assert.equal(result.profitCalculation.fulfillmentFee, 4.25);
});

test('manual weight and custom per-product rates survive automatic source updates', () => {
  const product = canonicalProduct({ marketplace: 'US', manualFbaFee: false, fbaFee: null, productWeight: 0.7, billingWeight: 0.7 });
  product.profitInputs = { ...product.profitInputs, actualWeightKg: 0.2, weightSource: '产品手工覆盖', commissionRate: 9, marketingRate: 7, airFreightRateCnyPerKg: 52, airFreightRateSource: 'product_manual' };
  const result = assertParity(product);
  assert.equal(result.billingWeight, 0.2);
  assert.equal(result.profitInputs.actualWeightKg, 0.2);
  assert.equal(result.profitInputs.commissionRate, 9);
  assert.equal(result.profitInputs.airFreightRateCnyPerKg, 52);
});

test('snapshot exchange-rate defaults prefer profitModel over runState and legacy costParams', () => {
  const product = canonicalProduct({ profitInputs: undefined });
  const result = assertParity(product, {
    runState: { marketplace: 'AU', exchangeRate: 4.9 }, profitModel: { exchangeRate: 5.1 },
    costParams: { exchangeRate: 4.7, commission: 9, marketing: 7 },
  });
  assert.equal(result.profitInputs.exchangeRate, 5.1);
  assert.equal(result.profitInputs.commissionRate, 9);
});

test('product exchange-rate and rate overrides take priority over snapshot defaults', () => {
  const product = canonicalProduct();
  product.profitInputs.exchangeRate = 5.6;
  product.profitInputs.marketingRate = 3;
  const result = assertParity(product, { runState: { exchangeRate: 4.9 }, profitModel: { exchangeRate: 5.1 }, costParams: { marketing: 7 } });
  assert.equal(result.profitInputs.exchangeRate, 5.6);
  assert.equal(result.profitInputs.marketingRate, 3);
});

test('an invalid zero snapshot exchange rate falls back to the valid run-state default', () => {
  const result = assertParity(canonicalProduct({ profitInputs: undefined }), {
    profitModel: { exchangeRate: 0 }, runState: { exchangeRate: 5.1 },
  });
  assert.equal(result.profitInputs.exchangeRate, 5.1);
});

test('a wrapped snapshot supplies market and exchange rate when the product has no marketplace', () => {
  const product = canonicalProduct({ marketplace: undefined, profitInputs: undefined });
  const result = assertParity(product, { snapshot: { runState: { marketplace: 'UK', exchangeRate: 9.8 }, costParams: { exchangeRate: 9.6 } } });
  assert.equal(result.profitInputs.exchangeRate, 9.8);
  assert.equal(result.profitInputs.airFreightActualWeightOnly, false);
  const explicit = assertParity(product, { marketplace: 'AU', snapshot: { runState: { marketplace: 'UK' } } });
  assert.equal(explicit.profitInputs.exchangeRate, 4.8);
  assert.equal(explicit.profitInputs.airFreightActualWeightOnly, true);
});

test('modern snapshot rates override legacy defaults without replacing saved product rates', () => {
  const context = { costParams: { commission: 13, marketing: 9 }, profitModel: { commissionRate: 8, marketingRate: 0, airFreightRateCnyPerKg: 51, domesticFreightRateCnyPerKg: 3 } };
  const result = assertParity(canonicalProduct({ profitInputs: undefined }), context);
  assert.equal(result.profitInputs.commissionRate, 8);
  assert.equal(result.profitInputs.marketingRate, 0);
  assert.equal(result.profitInputs.airFreightRateCnyPerKg, 51);
  assert.equal(result.profitInputs.domesticFreightRateCnyPerKg, 3);
  const saved = assertParity(canonicalProduct(), context);
  assert.equal(saved.profitInputs.commissionRate, profitModel.DEFAULT_PROFIT_RATES.commissionRate);
});

test('timestamps use only supplied or existing values and never read the current clock by default', () => {
  const product = canonicalProduct();
  const withoutTime = recomputeProductProfit(product);
  assert.equal(withoutTime.profitCalculation.calculatedAt, null);
  assert.equal(withoutTime.profitInputs.updatedAt, null);
  assert.deepEqual(recomputeProductProfit(product), withoutTime);
  const fromSource = recomputeProductProfit({ ...product, collectedAt: NOW });
  assert.equal(fromSource.profitCalculation.calculatedAt, NOW);
  assert.equal(fromSource.profitInputs.updatedAt, NOW);
  const withClock = recomputeProductProfit(product, { now: () => NOW });
  assert.deepEqual(withClock, recomputeProductProfit(product, { now: NOW }));
  const quoted = recomputeProductProfit({ ...product, collectedAt: '2025-01-01T00:00:00.000Z' }, { now: NOW });
  assert.equal(recomputeProductProfit(quoted).profitCalculation.calculatedAt, NOW,
    'Reading a just-calculated quote must not revert its timestamp to the older Amazon visit.');
});

test('legacy AU and CA defaults migrate while explicit manual air-freight rates survive', () => {
  for (const marketplace of ['AU', 'CA']) {
    const product = canonicalProduct({ marketplace });
    product.profitInputs = { ...product.profitInputs, formulaVersion: 'legacy-v1', airFreightRateCnyPerKg: 60, managementRate: 5, returnsRate: 8, commissionRate: 15 };
    const migrated = assertParity(product, { costParams: { freightRate: 60, returns: 10, commission: 15, management: 5 } });
    assert.equal(migrated.profitInputs.airFreightRateCnyPerKg, 45);
    assert.equal(migrated.profitInputs.returnsRate, 4);
    product.profitInputs.airFreightRateSource = 'product_manual';
    assert.equal(assertParity(product).profitInputs.airFreightRateCnyPerKg, 60);
  }
});

test('FBA-only formula migrations preserve existing manual operating rates', () => {
  const product = canonicalProduct();
  product.profitInputs = { ...product.profitInputs, formulaVersion: 'profit-workbook-au-2026-weight-fba-rates-v6', airFreightRateCnyPerKg: 60, commissionRate: 15, returnsRate: 8, managementRate: 5 };
  const result = assertParity(product);
  assert.equal(result.profitInputs.airFreightRateCnyPerKg, 60);
  assert.equal(result.profitInputs.commissionRate, 15);
  assert.equal(result.profitInputs.returnsRate, 8);
});

test('missing price still blocks profit while a successful weightless page estimates only its minimum FBA fee', () => {
  const product = canonicalProduct({ currentPrice: null, salePrice: null, manualSalePrice: false, productWeight: null, billingWeight: null, fbaWeight: null, purchaseCost: null, purchaseUnitCostCny: null, manualPurchaseCost: false, suppliers: [], manualFbaFee: false, fbaFee: null });
  product.profitInputs.actualWeightKg = null;
  product.productInformation = noWeightInformation();
  const result = assertParity(product);
  assert.equal(result.margin, null);
  assert.equal(result.purchaseCost, null);
  assert.equal(result.totalCost, null);
  assert.ok(result.profitPendingReasons.includes('售价'));
  assert.equal(result.profitPendingReasons.includes('采购成本'), false);
  // A confirmed absent weight allows a minimum FBA estimate, not a fabricated weight.
  assert.equal(result.fbaFee, null);
  assert.equal(result.profitPendingReasons.includes('FBA 配送费'), true);
});

for (const purchaseCost of [null, undefined, '']) {
  test(`missing procurement cost (${String(purchaseCost) || 'empty string'}) allows an estimate without making the product complete`, () => {
    const result = assertParity(canonicalProduct({
      manualPurchaseCost: false, purchaseCost, purchaseUnitCostCny: null, supplierAverageCny: null,
      suppliers: [], supplierSearchStatus: 'not_started',
    }));
    assert.equal(result.purchaseCost, null);
    assert.equal(result.purchaseUnitCostCny, null);
    assert.equal(result.supplierAverageCny, null);
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('采购成本'));
    assert.ok(Number.isFinite(result.margin));
    assert.ok(Number.isFinite(result.profitValue));
    assert.ok(Number.isFinite(result.totalCost));
    assert.equal(result.profitCalculation.purchaseCostAssumedZero, true);
    assert.deepEqual(result.profitPendingReasons, []);
  });
}

test('a weightless page uses minimum-envelope profit and preserves manual rates until actual weight arrives', () => {
  const product = canonicalProduct({ manualSalePrice: false, salePrice: null, productWeight: null, fbaWeight: null, billingWeight: null, manualFbaFee: false, fbaFee: null });
  product.profitInputs = { ...product.profitInputs, actualWeightKg: null, commissionRate: 9, marketingRate: 7, airFreightRateCnyPerKg: 52, airFreightRateSource: 'product_manual' };
  product.productInformation = noWeightInformation();
  const incomplete = assertParity(product);
  assert.equal(incomplete.salePrice, 9.99);
  assert.equal(incomplete.margin, null);
  assert.equal(incomplete.fbaFee, null);
  assert.equal(incomplete.fbaEstimate, null);
  assert.equal(incomplete.profitCalculation, null);
  assert.equal(incomplete.productWeight, null);
  assert.equal(incomplete.billingWeight, null);
  assert.equal(incomplete.profitInputs.actualWeightKg, null);
  assert.ok(incomplete.profitPendingReasons.includes('商品重量或包裹重量'));
  const complete = assertParity({ ...incomplete, productWeight: 0.12, billingWeight: 0.12 });
  assert.equal(complete.profitInputs.commissionRate, 9);
  assert.equal(complete.profitInputs.marketingRate, 7);
  assert.equal(complete.profitInputs.airFreightRateCnyPerKg, 52);
  assert.ok(Number.isFinite(complete.margin));
  assert.ok(complete.profitCalculation.assumedWeightKg == null);
  assert.notEqual(complete.profitCalculation.isEstimate, true);
  assert.deepEqual(complete.profitPendingReasons, []);
});

test('a later supplier unit quote replaces the zero-cost estimate with cost-inclusive profit', () => {
  const incomplete = assertParity(canonicalProduct({ manualPurchaseCost: false, purchaseCost: null, purchaseUnitCostCny: null, suppliers: [] }));
  assert.ok(Number.isFinite(incomplete.margin));
  assert.equal(incomplete.profitCalculation.purchaseCostAssumedZero, true);
  assert.equal(incomplete.complete, false);
  const complete = assertParity({ ...incomplete, supplierAverageCny: 3.5, suppliers: [{ unitPriceCny: 3.5 }] });
  assert.equal(complete.purchaseCost, 7);
  assert.ok(Number.isFinite(complete.margin));
  assert.ok(complete.margin < incomplete.margin);
  assert.ok(complete.totalCost > incomplete.totalCost);
  assert.equal(complete.profitCalculation.purchaseCostAssumedZero, false);
  assert.equal(complete.missing.includes('采购成本'), false);
  assert.deepEqual(complete.profitPendingReasons, []);
});

test('title piece counts multiply unit purchase cost while manual counts retain their override', () => {
  const product = canonicalProduct({ englishName: 'Reusable storage bags, 4 Pack', pieceCount: 1, pieceCountSource: 'default', manualPurchaseCost: false, supplierAverageCny: 3 });
  const automatic = assertParity(product);
  assert.equal(automatic.pieceCount, 4);
  assert.equal(automatic.purchaseCost, 12);
  const manual = assertParity({ ...product, pieceCount: 2, pieceCountSource: 'manual' });
  assert.equal(manual.pieceCount, 2);
  assert.equal(manual.purchaseCost, 6);
});

test('manual zero procurement cost is retained while unsupported automatic zero is cleared', () => {
  const manual = assertParity(canonicalProduct({ purchaseCost: 0, purchaseUnitCostCny: 0, suppliers: [] }));
  assert.equal(manual.purchaseCost, 0);
  assert.ok(Number.isFinite(manual.margin));
  assert.equal(manual.profitCalculation.purchaseCostAssumedZero, false);
  const automatic = assertParity(canonicalProduct({ manualPurchaseCost: false, purchaseCost: 0, purchaseUnitCostCny: 0, suppliers: [] }));
  assert.equal(automatic.purchaseCost, null);
  assert.equal(automatic.complete, false);
  assert.ok(Number.isFinite(automatic.margin));
  assert.equal(automatic.profitCalculation.purchaseCostAssumedZero, true);
  assert.equal(automatic.profitPendingReasons.includes('采购成本'), false);
});

test('procurement-owned handoff products are cloned without changing frozen calculations', () => {
  const product = canonicalProduct({ analysisHandoff: { owner: 'procurement', revision: 3 }, margin: 42, profitCalculation: { profit: 7, calculatedAt: '2025-01-01T00:00:00.000Z' } });
  const result = assertParity(product);
  assert.deepEqual(result, product);
  assert.notEqual(result.analysisHandoff, product.analysisHandoff);
  assert.notEqual(result.profitInputs, product.profitInputs);
});

test('recomputed nested outputs cannot mutate the source product or context', () => {
  const product = canonicalProduct();
  const context = { costParams: { commission: 9 }, profitModel: { exchangeRate: 4.9 }, now: NOW };
  const before = structuredClone({ product, context });
  const result = assertParity(product, context);
  result.profitInputs.exchangeRate = 99;
  result.fieldSources.title = 'changed';
  result.suppliers[0].unitPriceCny = 999;
  assert.deepEqual({ product, context }, before);
});


test('legacy manual weight sources and explicit billing flags match frontend recomputation', () => {
  const cases = [
    { billingWeight: 0.7, profitInputs: { actualWeightKg: 0.2, weightSource: 'product_manual' } },
    { billingWeight: 0.2, weightSource: '产品手工覆盖', profitInputs: { actualWeightKg: 0.7 } },
    { billingWeight: 0.2, manualBillingWeight: true, profitInputs: { actualWeightKg: 0.7 } },
    { billingWeight: 0.7, productWeight: 0.2, fieldSources: { productWeightKg: 'manual' } },
  ];
  for (const override of cases) {
    const result = assertParity(canonicalProduct({ productWeight: 0.7, manualFbaFee: false, fbaFee: null, ...override }));
    assert.equal(result.billingWeight, 0.2);
    assert.equal(result.profitInputs.actualWeightKg, 0.2);
    assert.equal(result.profitCalculation.domesticFreightWeightKg, 0.2);
    assert.equal(result.fbaFee, 5.26);
  }
});

test('legacy manual FBA fee provenance and zero fees match frontend recomputation', () => {
  for (const fee of [0, 9.87]) {
    for (const marker of [{ fbaFeeSource: 'manual' }, { fieldSources: { fbaFee: 'manual' } }]) {
      const result = assertParity(canonicalProduct({ manualFbaFee: false, fbaFee: fee, ...marker }));
      assert.equal(result.manualFbaFee, true);
      assert.equal(result.fbaFee, fee);
      assert.equal(result.profitCalculation.fulfillmentFee, fee);
    }
  }
});

test('general manual-profit marker keeps automatic weights refreshable in both runtimes', () => {
  const result = assertParity(canonicalProduct({ manualProfitInputs: true, productWeight: 0.7,
    billingWeight: 0.2, profitInputs: { actualWeightKg: 0.2, weightSource: 'Amazon 商品重量', marketingRate: 7 } }));
  assert.equal(result.billingWeight, 0.7);
  assert.equal(result.profitInputs.actualWeightKg, 0.7);
  assert.equal(result.profitInputs.marketingRate, 7);
});


test('AU and CA approved envelope boundaries agree across frontend, backend and repeated recomputation', () => {
  const cases = [
    ['AU', 13, 0.075, 3.67], ['AU', 13.01, 0.075, 4.58],
    ['AU', 13, 0.075001, 4.35], ['AU', 13.01, 0.225, 5.26],
    ['AU', 13, 0.225001, 4.70], ['AU', 13.01, 0.475, 5.61],
    ['AU', 13, 0.475001, 4.70], ['AU', 14, 2.345, 5.61],
    ['CA', 13.99, 0.1, (4.73 - 0.8) * 1.035], ['CA', 14, 0.1, 4.73 * 1.035],
    ['CA', 13.99, 0.100001, (4.99 - 0.8) * 1.035],
    ['CA', 14, 0.5, 5.95 * 1.035], ['CA', 14, 0.500001, 5.95 * 1.035], ['CA', 13, 2.345, (5.95 - 0.8) * 1.035],
  ];
  for (const [marketplace, salePrice, weight, fee] of cases) {
    const input = canonicalProduct({ marketplace, sourceMarketplace: marketplace, currentPrice: salePrice,
      salePrice, manualSalePrice: true, productWeight: weight, billingWeight: weight,
      manualFbaFee: false, fbaFee: 99, profitInputs: undefined });
    const actual = assertParity(input);
    assert.equal(actual.fbaFee, fee, JSON.stringify([marketplace, salePrice, weight]));
    assert.equal(actual.fbaFee, recomputeProductProfit(actual).fbaFee);
    if (fee !== null) assert.equal(actual.profitCalculation.fulfillmentFee, fee);
    else assert.equal(actual.profitCalculation, null);
  }
});

for (const formulaVersion of ['profit-workbook-au-weight-only-fba-v9', 'profit-workbook-au-ca-envelope-fba-v10', 'profit-workbook-au-ca-envelope-capped-fba-v11']) {
test(`${formulaVersion} migration preserves all manually saved operating inputs and frozen records`, () => {
  for (const marketplace of ['AU', 'CA']) {
    const input = canonicalProduct({ marketplace, manualFbaFee: false, fbaFee: 3.64 });
    input.profitInputs = { ...input.profitInputs, formulaVersion,
      purchaseTaxRate: 6, domesticFreightRateCnyPerKg: 4, airFreightRateCnyPerKg: 60,
      commissionRate: 15, managementRate: 5, returnsRate: 8,
      purchaseTaxRateSource: 'product_manual', domesticFreightSource: 'product_manual' };
    const actual = assertParity(input);
    for (const key of ['purchaseTaxRate', 'domesticFreightRateCnyPerKg', 'airFreightRateCnyPerKg',
      'commissionRate', 'managementRate', 'returnsRate', 'purchaseTaxRateSource', 'domesticFreightSource']) {
      assert.equal(actual.profitInputs[key], input.profitInputs[key], key);
    }
    const manual = assertParity({ ...input, manualFbaFee: true, fbaFee: 1.23456 });
    assert.equal(manual.fbaFee, 1.23456);
    const frozen = { ...input, analysisHandoff: { owner: 'procurement' } };
    assert.deepEqual(recomputeProductProfit(frozen), frozen);
  }
});

}
