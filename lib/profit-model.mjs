const LB_PER_KG = 2.2046226218;
const FBA_WEIGHT_ONLY_RATE_SOURCE = "FBA物流费用计算 SOP · 2023-06-27 · 美国站非危险品/非服装";
const AU_FBA_WORKBOOK_RATE_SOURCE = "用户《澳洲FBA运费.xlsx》Sheet1 A2:D8";

export const PROFIT_FORMULA_VERSION = "profit-workbook-au-weight-only-fba-v9";

// Preserve all seven workbook rows so explicit envelope choices use the same source as automatic selection.
export const AU_FBA_WORKBOOK_RATES = Object.freeze([
  { envelopeSizePolicy: "small", tierLabel: "小号信封", maxDimensionsCm: [20, 15, 1], minWeightG: 0, maxWeightG: 75, weightBand: "0-75g", fee: 3.64, sourceRange: "Sheet1!A2:D2", sourceCell: "Sheet1!D2" },
  { envelopeSizePolicy: "standard", tierLabel: "标准信封", maxDimensionsCm: [33, 23, 2.5], minWeightG: 0, maxWeightG: 75, weightBand: "0-75g", fee: 3.67, sourceRange: "Sheet1!A3:D3", sourceCell: "Sheet1!D3" },
  { envelopeSizePolicy: "standard", tierLabel: "标准信封", maxDimensionsCm: [33, 23, 2.5], minWeightG: 76, maxWeightG: 225, weightBand: "76-225g", fee: 4.35, sourceRange: "Sheet1!A4:D4", sourceCell: "Sheet1!D4" },
  { envelopeSizePolicy: "standard", tierLabel: "标准信封", maxDimensionsCm: [33, 23, 2.5], minWeightG: 226, maxWeightG: 475, weightBand: "226-475g", fee: 4.70, sourceRange: "Sheet1!A5:D5", sourceCell: "Sheet1!D5" },
  { envelopeSizePolicy: "large", tierLabel: "大号信封", maxDimensionsCm: [33, 23, 5], minWeightG: 0, maxWeightG: 225, weightBand: "0-225g", fee: 5.87, sourceRange: "Sheet1!A6:D6", sourceCell: "Sheet1!D6" },
  { envelopeSizePolicy: "large", tierLabel: "大号信封", maxDimensionsCm: [33, 23, 5], minWeightG: 226, maxWeightG: 475, weightBand: "226-475g", fee: 6.11, sourceRange: "Sheet1!A7:D7", sourceCell: "Sheet1!D7" },
  { envelopeSizePolicy: "large", tierLabel: "大号信封", maxDimensionsCm: [33, 23, 5], minWeightG: 476, maxWeightG: 975, weightBand: "476-975g", fee: 6.33, sourceRange: "Sheet1!A8:D8", sourceCell: "Sheet1!D8" },
].map((row) => Object.freeze({ ...row, maxDimensionsCm: Object.freeze(row.maxDimensionsCm) })));

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
    if (billableWeightLb <= 0.25) fee = 3.22;
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
      if (billableWeightLb <= 0.25 + 1e-9) fee = 3.22;
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
  envelopeSizePolicy = "auto",
} = {}) {
  const weightKg = positiveNumber(actualWeightKg);
  const priceAud = positiveNumber(itemPriceAud);
  const requestedSizePolicy = String(envelopeSizePolicy ?? "auto").trim().toLowerCase();
  if (weightKg === null || !["auto", "smallest", "small", "standard", "large"].includes(requestedSizePolicy)) return null;

  // Convert kilograms to the workbook's whole-gram bands; fractions advance to the next gram.
  const billableWeightG = Math.max(1, Math.ceil((weightKg * 1_000) - 1e-9));
  const automaticSizePolicy = requestedSizePolicy === "auto" || requestedSizePolicy === "smallest";
  // Workbook order is small, standard, large: the first eligible row is the smallest available envelope.
  const rate = AU_FBA_WORKBOOK_RATES.find((row) =>
    (automaticSizePolicy || row.envelopeSizePolicy === requestedSizePolicy)
    && billableWeightG >= row.minWeightG && billableWeightG <= row.maxWeightG);
  if (!rate) return null;
  const sizePolicy = rate.envelopeSizePolicy;
  return {
    tier: `au-${sizePolicy}-envelope`,
    tierLabel: `${rate.tierLabel}（重量代理）`,
    fee: rate.fee,
    billableWeightG,
    actualWeightKg: weightKg,
    itemPriceAud: priceAud,
    priceBand: "weight-only",
    priceBandLabel: "仅按重量",
    weightBand: rate.weightBand,
    envelopeSizePolicy: sizePolicy,
    requestedEnvelopeSizePolicy: requestedSizePolicy,
    effectiveEnvelopeSizePolicy: sizePolicy,
    assumption: "weight_only_envelope_proxy",
    rateSource: AU_FBA_WORKBOOK_RATE_SOURCE,
    sourceRange: rate.sourceRange,
    sourceCell: rate.sourceCell,
    confidence: "low",
    ambiguity: ["actual-size-tier-requires-package-dimensions"],
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
