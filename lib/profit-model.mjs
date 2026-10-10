const LB_PER_KG = 2.2046226218;
const US_FBA_MINIMUM_STANDARD_FEE = 3.22;
const FBA_WEIGHT_ONLY_RATE_SOURCE = "FBA物流费用计算 SOP · 2023-06-27 · 美国站非危险品/非服装";
const AU_FBA_WORKBOOK_RATE_SOURCE = "用户《澳洲站点fba配送费明细标准信封.xls》表格_20261009!A1:E4";
const CA_FBA_PEAK_WORKBOOK_RATE_SOURCE = "用户《亚马逊加拿大站FBA配送费-旺季信封件..xlsx》Sheet1!A1:D8";
const CA_FBA_LOW_PRICE_DISCOUNT = 0.8;
const CA_FBA_SURCHARGE_MULTIPLIER = 1.035;

export const PROFIT_FORMULA_VERSION = "profit-workbook-au-ca-envelope-fba-v10";

// Standard-envelope rates and the <=13 AUD boundary were confirmed by the user.
export const AU_FBA_WORKBOOK_RATES = Object.freeze([
  { minWeightG: 0, maxWeightG: 75, weightBand: "0-75g", fee: 3.67, highFee: 4.58, sourceRow: 2 },
  { minWeightG: 76, maxWeightG: 225, weightBand: "76-225g", fee: 4.35, highFee: 5.26, sourceRow: 3 },
  { minWeightG: 226, maxWeightG: 475, weightBand: "226-475g", fee: 4.70, highFee: 5.61, sourceRow: 4 },
].map(({ sourceRow, ...row }) => Object.freeze({
  ...row, lowFee: row.fee, envelopeSizePolicy: "standard", tierLabel: "标准信封",
  maxDimensionsCm: Object.freeze([33, 23, 2.5]),
  sourceRange: "表格_20261009!A" + sourceRow + ":E" + sourceRow,
  weightSourceCell: "表格_20261009!C" + sourceRow,
  sourceCell: "表格_20261009!D" + sourceRow,
  highSourceCell: "表格_20261009!E" + sourceRow,
})));

export const CA_FBA_PEAK_ENVELOPE_RATES = Object.freeze([
  { minWeightG: 0, maxWeightG: 100, weightBand: "0-100g", baseFee: 4.73, sourceRow: 4 },
  { minWeightG: 101, maxWeightG: 200, weightBand: "101-200g", baseFee: 4.99, sourceRow: 5 },
  { minWeightG: 201, maxWeightG: 300, weightBand: "201-300g", baseFee: 5.31, sourceRow: 6 },
  { minWeightG: 301, maxWeightG: 400, weightBand: "301-400g", baseFee: 5.60, sourceRow: 7 },
  { minWeightG: 401, maxWeightG: 500, weightBand: "401-500g", baseFee: 5.95, sourceRow: 8 },
].map(({ sourceRow, ...row }) => Object.freeze({
  ...row, tierLabel: "旺季信封件", sourceRange: "Sheet1!B" + sourceRow + ":D" + sourceRow,
  weightSourceCell: "Sheet1!B" + sourceRow, sourceCell: "Sheet1!C" + sourceRow,
  discountedSourceCell: "Sheet1!D" + sourceRow,
})));

/** True only when a successful Amazon detail visit confirms the page provides no weight. */
export function isAmazonWeightUnavailable(product = {}) {
  const status = String(product.detailStatus || '').toLowerCase();
  if (status !== 'success' && product.explicitProduct !== true) return false;
  if (['pending', 'loading', 'running', 'retrying', 'failed', 'error', 'cancelled'].includes(status)
    || product.challenge === true || product.rateLimited === true || product.navigationError === true
    || product.collectionLastAttempt?.status === 'failed' || product.lastCollectionError) return false;
  const weights = [product.productWeightKg, product.productWeight, product.fbaPackageWeightKg,
    product.packageWeightKg, product.fbaWeight, product.billingWeight, product.actualWeightKg,
    product.profitInputs?.actualWeightKg];
  // An invalid or unsourced value needs review; it is not evidence of page absence.
  if (weights.some((value) => value !== null && value !== undefined && value !== '')) return false;
  const quality = product.collectionQuality?.fields?.weight;
  return quality ? quality.status === 'unavailable' && quality.reason === 'page_not_provided' : true;
}

/** Lowest applicable weight tier, preserving unknown weight rather than inventing one. */
export function estimateMinimumFbaFee({ marketplace, salePrice, dimensionsCm } = {}) {
  const market = String(marketplace || '').toUpperCase();
  const common = {
    actualWeightKg: null,
    assumption: 'missing_weight_minimum_fba_estimate',
    weightSource: '页面未提供重量 · FBA 配送费按最低档估算',
    confidence: '低',
    ambiguity: ['product-weight-not-provided', 'minimum-fee-is-preliminary-only'],
  };
  if (market === 'AU' || market === 'CA') {
    const price = positiveNumber(salePrice);
    const estimated = market === 'AU'
      ? estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.001, itemPriceAud: price ?? 1, dimensionsCm })
      : estimateCa2026FbaFeeByProductWeight({ actualWeightKg: 0.001, itemPriceCad: price ?? 1 });
    if (!estimated) return null;
    const priceKey = market === 'AU' ? 'itemPriceAud' : 'itemPriceCad';
    return {
      ...estimated, ...common, marketplace: market, [priceKey]: price,
      billableWeightG: null, tierLabel: estimated.tierLabel.replace(/（.*）$/, '') + '（最低费暂估）',
      requestedEnvelopeSizePolicy: 'minimum-fee',
      priceAssumption: price === null ? 'missing_price_low_price_band_assumed' : null,
      ambiguity: [...new Set([...common.ambiguity, ...estimated.ambiguity,
        ...(price === null ? ['sale-price-not-provided', 'low-price-band-assumed'] : [])])],
      rateApplicability: '页面未提供重量 · 按' + (market === 'AU' ? '澳洲标准信封' : '加拿大旺季信封件')
        + '最低重量档及适用售价规则暂估；实际重量和头程运费待补'
        + (price === null ? '；售价待补，暂按低售价档估算' : ''),
    };
  }
  if (market === 'US') {
    return { ...common, marketplace: market, currency: 'USD', fee: US_FBA_MINIMUM_STANDARD_FEE,
      tier: 'small-standard', tierLabel: '小号标准件（最低费暂估）', billableWeightLb: null,
      standardSizePolicy: 'small', rateSource: FBA_WEIGHT_ONLY_RATE_SOURCE,
      rateApplicability: '页面未提供重量 · 按当前美国 SOP 费率表最低 FBA 配送费估算；实际重量和头程运费待补' };
  }
  // Other markets have no local minimum-fee table in this application.
  return null;
}

/** Resolve explicit manual weight inputs before automatic Amazon values are applied. */
export function resolveManualWeightOverride(product = {}) {
  const inputs = product.profitInputs || {};
  const manualField = (field) => product.manualAmazonFields?.[field] === true
    || isManualInputSource(product.fieldSources?.[field]);
  const pick = (values, source) => {
    const weightKg = values.map(positiveNumber).find((value) => value !== null);
    return weightKg === undefined ? null : { weightKg, source: source || 'product_manual' };
  };
  if (isManualInputSource(inputs.weightSource)) {
    const nested = pick([inputs.actualWeightKg, product.billingWeight, product.actualWeightKg], inputs.weightSource);
    if (nested) return nested;
  }
  if (product.manualBillingWeight === true || manualField('billingWeight')
    || isManualInputSource(product.weightSource)) {
    const billing = pick([product.billingWeight, product.actualWeightKg, inputs.actualWeightKg],
      isManualInputSource(product.weightSource) ? product.weightSource : null);
    if (billing) return billing;
  }
  if (manualField('actualWeightKg')) {
    const actual = pick([product.actualWeightKg, inputs.actualWeightKg, product.billingWeight], null);
    if (actual) return actual;
  }
  if (product.manualProductWeight === true || ['productWeight', 'productWeightKg'].some(manualField)) {
    const item = pick([product.productWeight, product.productWeightKg], null);
    if (item) return item;
  }
  if (product.manualFbaWeight === true || ['fbaWeight', 'fbaPackageWeightKg', 'packageWeightKg'].some(manualField)) {
    const packed = pick([product.fbaWeight, product.fbaPackageWeightKg, product.packageWeightKg], null);
    if (packed) return packed;
  }
  if (['weight', 'weightKg'].some(manualField)) {
    const generic = pick([product.weightKg, product.billingWeight, inputs.actualWeightKg, product.productWeight], null);
    if (generic) return generic;
  }
  if (product.manualWeight === true) {
    return pick([product.billingWeight, product.weightKg, product.actualWeightKg,
      inputs.actualWeightKg, product.productWeight, product.productWeightKg, product.fbaWeight], null);
  }
  return null;
}

/** Preserve saved manual fee provenance, including legacy records without the boolean flag. */
export function hasManualFulfillmentFee(product = {}, mode = 'FBA') {
  const field = String(mode).toUpperCase() === 'FBM' ? 'fbmFee' : 'fbaFee';
  const flag = field === 'fbmFee' ? 'manualFbmFee' : 'manualFbaFee';
  return Boolean(product[flag]) || product.manualAmazonFields?.[field] === true
    || isManualInputSource(product[field + 'Source']) || isManualInputSource(product.fieldSources?.[field]);
}

function isManualInputSource(source) {
  return /(?:manual|人工|手工)/i.test(String(source || ''));
}

export const DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG = Object.freeze({
  min: 2,
  max: 5,
});

export const DEFAULT_PROFIT_RATES = Object.freeze({
  commissionRate: 15,
  fxLossRate: 1.5,
  marketingRate: 10,
  managementRate: 5,
  returnsRate: 8,
  purchaseTaxRate: 4,
  domesticFreightRateCnyPerKg: DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.max,
  airFreightRateCnyPerKg: 10,
});

export function calculateDimensionalWeight({ dimensionsCm, divisor = 139 } = {}) {
  const dimensions = normalizeDimensions(dimensionsCm);
  const normalizedDivisor = positiveNumber(divisor);
  if (!dimensions || normalizedDivisor === null) return null;
  const dimensionsIn = dimensions.map((value) => value / 2.54);
  const dimensionalWeightLb = dimensionsIn.reduce((total, value) => total * value, 1) / normalizedDivisor;
  return {
    dimensionsCm: dimensions,
    dimensionsIn,
    dimensionalWeightLb,
    dimensionalWeightKg: dimensionalWeightLb / LB_PER_KG,
    divisor: normalizedDivisor,
  };
}

export function calculateAirFreight({
  actualWeightKg,
  dimensionsCm,
  cartonWeightKg,
  unitsPerCarton,
  rateCnyPerKg = DEFAULT_PROFIT_RATES.airFreightRateCnyPerKg,
  volumetricDivisor = 139,
  actualWeightOnly = false,
} = {}) {
  const rate = nonNegativeNumber(rateCnyPerKg);
  if (rate === null) return null;
  const useActualWeightOnly = actualWeightOnly === true;
  const actual = positiveNumber(actualWeightKg);
  const cartonWeight = positiveNumber(cartonWeightKg);
  const cartonUnits = positiveNumber(unitsPerCarton);
  const dimensional = useActualWeightOnly ? null : calculateDimensionalWeight({ dimensionsCm, divisor: volumetricDivisor });
  const fallbackWeight = Math.max(actual || 0, dimensional?.dimensionalWeightKg || 0) || null;
  const chargeableWeightKg = useActualWeightOnly
    ? actual
    : cartonWeight !== null && cartonUnits !== null
      ? cartonWeight / cartonUnits
      : fallbackWeight;
  if (chargeableWeightKg === null) return null;
  return {
    actualWeightKg: actual,
    volumetricWeightKg: dimensional?.dimensionalWeightKg ?? null,
    dimensionalWeightLb: dimensional?.dimensionalWeightLb ?? null,
    chargeableWeightKg,
    airFreightCny: chargeableWeightKg * rate,
    airFreightRateCnyPerKg: rate,
    airFreightRateCnyPerGram: rate / 1_000,
    cartonWeightKg: useActualWeightOnly ? null : cartonWeight,
    unitsPerCarton: useActualWeightOnly ? null : cartonUnits,
    source: useActualWeightOnly ? "product_weight" : cartonWeight !== null && cartonUnits !== null ? "carton" : "single_package_fallback",
    confidence: useActualWeightOnly || (cartonWeight !== null && cartonUnits !== null) ? "standard" : "low",
  };
}

export function calculateProductProfit(input = {}) {
  const salePrice = positiveNumber(input.salePrice);
  const purchaseCostCny = nonNegativeNumber(input.purchaseCostCny ?? input.purchaseCost);
  const fulfillmentFee = nonNegativeNumber(input.fulfillmentFee);
  const exchangeRate = positiveNumber(input.exchangeRate);
  const fulfillmentMode = normalizeFulfillmentMode(input.fulfillmentMode);
  if (salePrice === null || purchaseCostCny === null || fulfillmentFee === null || exchangeRate === null || !fulfillmentMode) {
    return null;
  }

  const rates = normalizeRates(input);
  if (!rates) return null;
  const freight = calculateAirFreight({
    actualWeightKg: input.actualWeightKg,
    dimensionsCm: input.dimensionsCm,
    cartonWeightKg: input.cartonWeightKg,
    unitsPerCarton: input.unitsPerCarton,
    rateCnyPerKg: rates.airFreightRateCnyPerKg,
    volumetricDivisor: input.volumetricDivisor ?? 139,
    actualWeightOnly: input.airFreightActualWeightOnly === true,
  });
  if (!freight) return null;

  const domesticFreightWeightKg = positiveNumber(input.actualWeightKg);
  if (domesticFreightWeightKg === null) return null;
  const purchaseTaxCny = purchaseCostCny * (rates.purchaseTaxRate / 100);
  const domesticFreightCny = domesticFreightWeightKg * rates.domesticFreightRateCnyPerKg;
  const domesticFreightMinCny = domesticFreightWeightKg * DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.min;
  const domesticFreightMaxCny = domesticFreightWeightKg * DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.max;
  const landedPurchaseCny = purchaseCostCny + purchaseTaxCny + domesticFreightCny;
  const proportional = (rate) => salePrice * (rate / 100);
  const parts = {
    purchaseBase: purchaseCostCny / exchangeRate,
    purchaseTax: purchaseTaxCny / exchangeRate,
    domesticFreight: domesticFreightCny / exchangeRate,
    purchase: landedPurchaseCny / exchangeRate,
    commission: proportional(rates.commissionRate),
    fulfillment: fulfillmentFee,
    fba: fulfillmentMode === "FBA" ? fulfillmentFee : 0,
    fbm: fulfillmentMode === "FBM" ? fulfillmentFee : 0,
    freight: freight.airFreightCny / exchangeRate,
    fxLoss: proportional(rates.fxLossRate),
    marketing: proportional(rates.marketingRate),
    management: proportional(rates.managementRate),
    returns: proportional(rates.returnsRate),
  };
  const totalCost = parts.purchase + parts.commission + parts.fulfillment + parts.freight
    + parts.fxLoss + parts.marketing + parts.management + parts.returns;
  const profit = salePrice - totalCost;

  return {
    formulaVersion: PROFIT_FORMULA_VERSION,
    salePrice,
    purchaseCostCny,
    exchangeRate,
    fulfillmentMode,
    fulfillmentFee,
    rates,
    airFreight: freight,
    parts,
    purchaseBaseAud: parts.purchaseBase,
    purchaseTaxAud: parts.purchaseTax,
    domesticFreightAud: parts.domesticFreight,
    purchaseAud: parts.purchase,
    purchaseTaxCny,
    domesticFreightCny,
    domesticFreightWeightKg,
    domesticFreightMinCny,
    domesticFreightMaxCny,
    landedPurchaseCny,
    commission: parts.commission,
    fulfillment: parts.fulfillment,
    fba: parts.fba,
    fbm: parts.fbm,
    freightCost: parts.freight,
    freight: parts.freight,
    fxLoss: parts.fxLoss,
    marketing: parts.marketing,
    management: parts.management,
    returns: parts.returns,
    totalCost,
    profit,
    margin: (profit / salePrice) * 100,
  };
}

export function estimateUs2023FbaFee({ actualWeightKg, dimensionsCm } = {}) {
  const weightKg = positiveNumber(actualWeightKg);
  const dimensions = normalizeDimensions(dimensionsCm);
  if (weightKg === null || !dimensions) return null;

  const dimensionsIn = dimensions.map((value) => value / 2.54).sort((left, right) => right - left);
  const [longest, median, shortest] = dimensionsIn;
  const actualWeightLb = weightKg * LB_PER_KG;
  const dimensionalWeightLb = (longest * median * shortest) / 139;
  const oversizeDimensionalWeightLb = (longest * Math.max(median, 2) * Math.max(shortest, 2)) / 139;
  const lengthPlusGirth = longest + 2 * (median + shortest);
  let tier;
  let tierLabel;
  let billableWeightLb;
  let fee;

  if (longest <= 15 && median <= 12 && shortest <= 0.75 && actualWeightLb <= 1) {
    tier = "small-standard";
    tierLabel = "小号标准件";
    billableWeightLb = ceilTo(actualWeightLb, 0.25);
    if (billableWeightLb <= 0.25) fee = US_FBA_MINIMUM_STANDARD_FEE;
    else if (billableWeightLb <= 0.5) fee = 3.4;
    else if (billableWeightLb <= 0.75) fee = 3.58;
    else fee = 3.77;
  } else if (longest <= 18 && median <= 14 && shortest <= 8 && actualWeightLb <= 20) {
    tier = "large-standard";
    tierLabel = "大号标准件";
    const rawBillingWeight = Math.max(actualWeightLb, dimensionalWeightLb);
    billableWeightLb = ceilTo(rawBillingWeight, rawBillingWeight <= 1 ? 0.25 : 0.5);
    if (billableWeightLb <= 0.25) fee = 3.86;
    else if (billableWeightLb <= 0.5) fee = 4.08;
    else if (billableWeightLb <= 0.75) fee = 4.24;
    else if (billableWeightLb <= 1) fee = 4.75;
    else if (billableWeightLb <= 1.5) fee = 5.4;
    else if (billableWeightLb <= 2) fee = 5.69;
    else if (billableWeightLb <= 2.5) fee = 6.1;
    else if (billableWeightLb <= 3) fee = 6.39;
    else fee = 7.17 + 0.16 * Math.ceil((billableWeightLb - 3) / 0.5);
  } else if (longest <= 60 && median <= 30 && lengthPlusGirth <= 130 && actualWeightLb <= 70) {
    tier = "small-oversize";
    tierLabel = "小号大件";
    billableWeightLb = Math.ceil(Math.max(actualWeightLb, oversizeDimensionalWeightLb));
    fee = 9.73 + 0.42 * Math.ceil(Math.max(0, billableWeightLb - 1));
  } else if (longest <= 108 && lengthPlusGirth <= 130 && actualWeightLb <= 150) {
    tier = "medium-oversize";
    tierLabel = "中号大件";
    billableWeightLb = Math.ceil(Math.max(actualWeightLb, oversizeDimensionalWeightLb));
    fee = 19.05 + 0.42 * Math.ceil(Math.max(0, billableWeightLb - 1));
  } else if (longest <= 108 && lengthPlusGirth <= 165 && actualWeightLb <= 150) {
    tier = "large-oversize";
    tierLabel = "大号大件";
    billableWeightLb = Math.ceil(Math.max(actualWeightLb, oversizeDimensionalWeightLb));
    fee = 89.98 + 0.83 * Math.ceil(Math.max(0, billableWeightLb - 90));
  } else {
    tier = "special-oversize";
    tierLabel = "特殊大件";
    billableWeightLb = Math.ceil(actualWeightLb);
    fee = 158.49 + 0.83 * Math.ceil(Math.max(0, billableWeightLb - 90));
  }

  return {
    tier,
    tierLabel,
    fee: roundMoney(fee),
    billableWeightLb,
    actualWeightLb,
    dimensionalWeightLb,
    oversizeDimensionalWeightLb,
    dimensionsIn,
    lengthPlusGirth,
  };
}

export function estimateUs2023FbaFeeByProductWeight({
  actualWeightKg,
  standardSizePolicy = "large",
} = {}) {
  const weightKg = positiveNumber(actualWeightKg);
  const normalizedPolicy = String(standardSizePolicy || "").trim().toLowerCase();
  if (weightKg === null || !["small", "large"].includes(normalizedPolicy)) return null;

  const actualWeightLb = weightKg * LB_PER_KG;
  let tier;
  let tierLabel;
  let billableWeightLb;
  let fee;
  let ambiguity;
  let effectiveStandardSizePolicy = null;

  if (actualWeightLb <= 20 + 1e-9) {
    effectiveStandardSizePolicy = normalizedPolicy === "small" && actualWeightLb <= 1 + 1e-9
      ? "small"
      : "large";
    tier = effectiveStandardSizePolicy === "small" ? "small-standard" : "large-standard";
    tierLabel = effectiveStandardSizePolicy === "small" ? "小号标准件（重量代理）" : "大号标准件（重量代理）";
    billableWeightLb = ceilTo(actualWeightLb, actualWeightLb <= 1 + 1e-9 ? 0.25 : 0.5);

    if (effectiveStandardSizePolicy === "small") {
      if (billableWeightLb <= 0.25 + 1e-9) fee = US_FBA_MINIMUM_STANDARD_FEE;
      else if (billableWeightLb <= 0.5 + 1e-9) fee = 3.4;
      else if (billableWeightLb <= 0.75 + 1e-9) fee = 3.58;
      else fee = 3.77;
    } else {
      if (billableWeightLb <= 0.25 + 1e-9) fee = 3.86;
      else if (billableWeightLb <= 0.5 + 1e-9) fee = 4.08;
      else if (billableWeightLb <= 0.75 + 1e-9) fee = 4.24;
      else if (billableWeightLb <= 1 + 1e-9) fee = 4.75;
      else if (billableWeightLb <= 1.5 + 1e-9) fee = 5.4;
      else if (billableWeightLb <= 2 + 1e-9) fee = 5.69;
      else if (billableWeightLb <= 2.5 + 1e-9) fee = 6.1;
      else if (billableWeightLb <= 3 + 1e-9) fee = 6.39;
      else fee = 7.17 + 0.16 * Math.ceil((billableWeightLb - 3 - 1e-9) / 0.5);
    }
    ambiguity = actualWeightLb <= 1 + 1e-9
      ? ["small-standard", "large-standard", "oversize-by-dimensions"]
      : ["large-standard", "oversize-by-dimensions"];
  } else if (actualWeightLb <= 70 + 1e-9) {
    tier = "small-oversize";
    tierLabel = "小号大件（重量代理）";
    billableWeightLb = Math.ceil(actualWeightLb - 1e-9);
    fee = 9.73 + 0.42 * Math.ceil(Math.max(0, billableWeightLb - 1));
    ambiguity = ["small-oversize", "medium-oversize", "large-oversize", "special-oversize-by-dimensions"];
  } else if (actualWeightLb <= 150 + 1e-9) {
    tier = "medium-oversize";
    tierLabel = "中号大件（重量代理）";
    billableWeightLb = Math.ceil(actualWeightLb - 1e-9);
    fee = 19.05 + 0.42 * Math.ceil(Math.max(0, billableWeightLb - 1));
    ambiguity = ["medium-oversize", "large-oversize", "special-oversize-by-dimensions"];
  } else {
    tier = "special-oversize";
    tierLabel = "特殊大件（重量确定）";
    billableWeightLb = Math.ceil(actualWeightLb - 1e-9);
    fee = 158.49 + 0.83 * Math.ceil(Math.max(0, billableWeightLb - 90));
    ambiguity = [];
  }

  return {
    tier,
    tierLabel,
    fee: roundMoney(fee),
    billableWeightLb,
    actualWeightLb,
    actualWeightKg: weightKg,
    standardSizePolicy: normalizedPolicy,
    effectiveStandardSizePolicy,
    assumption: "weight_only_proxy",
    rateSource: FBA_WEIGHT_ONLY_RATE_SOURCE,
    confidence: ambiguity.length ? "low" : "standard",
    ambiguity,
  };
}

export function estimateAu2026FbaFeeByProductWeight({
  actualWeightKg,
  itemPriceAud,
  envelopeSizePolicy = "standard",
  dimensionsCm,
} = {}) {
  const weightKg = positiveNumber(actualWeightKg);
  const priceAud = positiveNumber(itemPriceAud);
  const requestedSizePolicy = String(envelopeSizePolicy ?? "standard").trim().toLowerCase();
  if (weightKg === null || priceAud === null || !["auto", "smallest", "standard"].includes(requestedSizePolicy)) return null;
  const dimensions = normalizeDimensions(dimensionsCm);
  const limits = AU_FBA_WORKBOOK_RATES[0].maxDimensionsCm;
  const sortedDimensions = dimensions?.slice().sort((left, right) => right - left);
  if (sortedDimensions?.some((value, index) => value > limits[index] + 1e-9)) return null;

  // Convert kilograms to whole-gram bands; fractions advance to the next gram.
  const billableWeightG = Math.max(1, Math.ceil((weightKg * 1_000) - 1e-9));
  const rate = AU_FBA_WORKBOOK_RATES.find((row) => billableWeightG >= row.minWeightG && billableWeightG <= row.maxWeightG);
  if (!rate) return null;
  const lowPrice = priceAud <= 13;
  const fee = lowPrice ? rate.fee : rate.highFee;
  const sourceCell = lowPrice ? rate.sourceCell : rate.highSourceCell;
  return {
    marketplace: "AU", currency: "AUD", tier: "au-standard-envelope", tierLabel: "标准信封（按重量与售价估算）",
    fee, baseFee: fee, discount: 0, surchargeMultiplier: 1,
    billableWeightG, actualWeightKg: weightKg, itemPriceAud: priceAud,
    priceBand: lowPrice ? "low-price" : "high-price",
    priceBandLabel: lowPrice ? "售价 ≤13 AUD" : "售价 >13 AUD",
    weightBand: rate.weightBand, dimensionsCm: dimensions, maxDimensionsCm: limits,
    envelopeSizePolicy: "standard", requestedEnvelopeSizePolicy: requestedSizePolicy,
    effectiveEnvelopeSizePolicy: "standard", seasonPolicy: "user_standard_envelope_table",
    assumption: dimensions ? "standard_envelope_weight_price" : "standard_envelope_dimensions_assumed",
    dimensionsAssumption: dimensions ? null : "standard_envelope_dimensions_not_verified",
    rateSource: AU_FBA_WORKBOOK_RATE_SOURCE, sourceRange: rate.sourceRange, sourceCell,
    sourceCells: ["表格_20261009!B2", rate.weightSourceCell, sourceCell],
    rateApplicability: "标准信封 ≤33×23×2.5 cm、≤475g；售价 ≤13 AUD 按低价档，>13 AUD 按高价档"
      + (dimensions ? "" : "；尺寸未提供，按标准信封暂估"),
    confidence: dimensions ? "standard" : "low",
    ambiguity: dimensions ? [] : ["standard-envelope-dimensions-not-verified"],
  };
}

export function estimateCa2026FbaFeeByProductWeight({ actualWeightKg, itemPriceCad } = {}) {
  const weightKg = positiveNumber(actualWeightKg);
  const priceCad = positiveNumber(itemPriceCad);
  if (weightKg === null || priceCad === null) return null;
  const billableWeightG = Math.max(1, Math.ceil((weightKg * 1_000) - 1e-9));
  const rate = CA_FBA_PEAK_ENVELOPE_RATES.find((row) => billableWeightG >= row.minWeightG && billableWeightG <= row.maxWeightG);
  if (!rate) return null;
  const lowPrice = priceCad < 14;
  const discount = lowPrice ? CA_FBA_LOW_PRICE_DISCOUNT : 0;
  return {
    marketplace: "CA", currency: "CAD", tier: "ca-peak-envelope", tierLabel: "旺季信封件（按重量与售价估算）",
    // Keep full precision throughout profit calculation; only presentation rounds money.
    fee: (rate.baseFee - discount) * CA_FBA_SURCHARGE_MULTIPLIER,
    baseFee: rate.baseFee, discount, surchargeMultiplier: CA_FBA_SURCHARGE_MULTIPLIER,
    surchargeRate: 0.035, lowPriceDiscount: CA_FBA_LOW_PRICE_DISCOUNT,
    billableWeightG, actualWeightKg: weightKg, itemPriceCad: priceCad,
    priceBand: lowPrice ? "low-price" : "standard-price",
    priceBandLabel: lowPrice ? "售价 <14 CAD，减 0.8 CAD" : "售价 ≥14 CAD，无低价优惠",
    weightBand: rate.weightBand, envelopeSizePolicy: "envelope", seasonPolicy: "peak_only_user_selected",
    peakStartsOn: "2026-10-15", peakEndsOn: "2027-01-14", surchargeStartsOn: "2026-04-17",
    assumption: "peak_envelope_user_selected", rateSource: CA_FBA_PEAK_WORKBOOK_RATE_SOURCE,
    sourceRange: rate.sourceRange, sourceCell: rate.sourceCell,
    sourceCells: ["Sheet1!A2", "Sheet1!D3", rate.weightSourceCell, rate.sourceCell,
      ...(lowPrice ? [rate.discountedSourceCell] : [])],
    rateApplicability: "统一按加拿大旺季信封件表估费，≤500g；售价 <14 CAD 减 0.8；(基础费－优惠)×1.035；CAD 不含税",
    confidence: "low", ambiguity: ["peak-rates-applied-by-user-policy", "envelope-dimensions-not-specified-in-source"],
  };
}

function normalizeRates(input) {
  const result = {};
  for (const key of ["commissionRate", "fxLossRate", "marketingRate", "managementRate", "returnsRate", "purchaseTaxRate", "domesticFreightRateCnyPerKg", "airFreightRateCnyPerKg"]) {
    const value = nonNegativeNumber(input[key] ?? DEFAULT_PROFIT_RATES[key]);
    if (value === null) return null;
    result[key] = value;
  }
  return result;
}

function normalizeFulfillmentMode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (/(?:FBM|MFN|MERCHANT)/.test(normalized)) return "FBM";
  if (/(?:FBA|AMAZON)/.test(normalized)) return "FBA";
  return null;
}

function normalizeDimensions(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const dimensions = value.slice(0, 3).map(positiveNumber);
  return dimensions.every((number) => number !== null) ? dimensions : null;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveNumber(value) {
  const number = nonNegativeNumber(value);
  return number !== null && number > 0 ? number : null;
}

function ceilTo(value, increment) {
  return Math.ceil((value - Number.EPSILON) / increment) * increment;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
