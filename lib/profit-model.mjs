import { hasCompleteProductInformationInspection } from "./amazon-product-information.mjs";

const LB_PER_KG = 2.2046226218;
const US_FBA_MINIMUM_STANDARD_FEE = 3.22;
const FBA_WEIGHT_ONLY_RATE_SOURCE = "FBA物流费用计算 SOP · 2023-06-27 · 美国站非危险品/非服装";
const AU_FBA_WORKBOOK_RATE_SOURCE = "用户《澳洲站点fba配送费明细标准信封.xls》表格_20261009!A1:E4";
const CA_FBA_PEAK_WORKBOOK_RATE_SOURCE = "用户《亚马逊加拿大站FBA配送费-旺季信封件..xlsx》Sheet1!A1:D8";
const CA_FBA_LOW_PRICE_DISCOUNT = 0.8;
const CA_FBA_SURCHARGE_MULTIPLIER = 1.035;

export const PROFIT_FORMULA_VERSION = "profit-workbook-all-market-minimum-envelope-v12";

const MINIMUM_ENVELOPE_CURRENCIES = Object.freeze({
  AU: "AUD", CA: "CAD", US: "USD", NL: "EUR", UK: "GBP", DE: "EUR", FR: "EUR",
  IT: "EUR", ES: "EUR", PL: "PLN", MX: "MXN", BR: "BRL",
});
const MISSING_WEIGHT_ASSUMPTION = "missing_weight_minimum_envelope";

function minimumEnvelopeWeightKg(marketplace) {
  const market = String(marketplace || "").toUpperCase();
  if (!Object.hasOwn(MINIMUM_ENVELOPE_CURRENCIES, market)) return null;
  return market === "AU" ? 0.075 : market === "CA" ? 0.1 : 0.25 / LB_PER_KG;
}

function isMissingWeight(value) {
  return value === null || value === undefined || value === "";
}

function positiveWeightNumber(value) {
  return typeof value === "number" || typeof value === "string" ? positiveNumber(value) : null;
}

/** Distinguish an explicitly invalid product mass from an uncollected mass. */
export function hasInvalidProductWeight(product = {}) {
  return [product?.productWeight, product?.productWeightKg, product?.billingWeight,
    product?.actualWeightKg, product?.profitInputs?.actualWeightKg]
    .some(value => !isMissingWeight(value) && positiveWeightNumber(value) === null);
}

/** Keep the calculation assumption separate from the product's actual weight. */
export function applyMissingWeightProfitAssumption(input = {}, marketplace, product) {
  const result = { ...input };
  delete result.assumedWeightKg;
  delete result.weightAssumption;
  delete result.weightAssumptionMarket;
  delete result.dimensionalWeightEstimateKg;
  const market = String(marketplace || "").toUpperCase();
  // Dimensional estimates never replace observed item or package mass.
  if (market === 'AU' || market === 'CA') {
    if (market === 'AU') result.airFreightActualWeightOnly = true;
    {
      result.dimensionsCm = resolveProductDimensionsCm(product) || normalizeDimensions(result.dimensionsCm);
      if (isMissingWeight(result.actualWeightKg) && !hasInvalidProductWeight(product)) {
        result.dimensionalWeightEstimateKg = marketDimensionalWeightKg(result.dimensionsCm, market);
      }
    }
    return result;
  }
  const assumedWeightKg = minimumEnvelopeWeightKg(market);
  if (normalizeFulfillmentMode(result.fulfillmentMode) === "FBA" && isMissingWeight(result.actualWeightKg)
    && assumedWeightKg !== null && !hasInvalidProductWeight(product)) {
    Object.assign(result, { assumedWeightKg, weightAssumption: MISSING_WEIGHT_ASSUMPTION, weightAssumptionMarket: market });
  }
  return result;
}

function resolveMissingWeightProfitAssumption(input) {
  if (input.weightAssumption !== MISSING_WEIGHT_ASSUMPTION || !isMissingWeight(input.actualWeightKg)
    || normalizeFulfillmentMode(input.fulfillmentMode) !== "FBA") return null;
  const market = String(input.weightAssumptionMarket || "").toUpperCase();
  const expected = minimumEnvelopeWeightKg(market);
  const supplied = positiveWeightNumber(input.assumedWeightKg);
  if (expected === null || supplied === null || Math.abs(expected - supplied) > 1e-9) return null;
  return { assumedWeightKg: expected, weightAssumption: MISSING_WEIGHT_ASSUMPTION, weightAssumptionMarket: market };
}

/** Whether Item Weight observations require explicit product-field evidence. */
export function usesItemWeightOnly(product = {}) {
  return Number(product.detailParserVersion) >= 11
    || product.productInformation?.weightSelection?.policy === "item_weight_only"
    || product.weightSelection?.policy === "item_weight_only";
}

/** Resolve an automatic product mass without promoting package or cached billing weights. */
export function automaticProductWeightKg(product = {}) {
  const value = positiveNumber(Object.hasOwn(product, "productWeight") ? product.productWeight : product.productWeightKg);
  if (!usesItemWeightOnly(product)) return value;
  const evidence = product.productWeightEvidence;
  const label = String(evidence?.label || "").normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[:：]\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (label !== "item weight" || evidence?.kind !== "product") return null;
  const recorded = positiveNumber(evidence.value);
  if (recorded === null || value === null || Math.abs(recorded - value) > 1e-9) return null;
  return value;
}

/** Package observations remain separate from Item Weight, including dimensions tails. */
export function automaticPackageWeightKg(product = {}) {
  const value = positiveNumber(product.fbaWeight ?? product.fbaPackageWeightKg ?? product.packageWeightKg);
  const evidence = product.packageWeightEvidence;
  const label = String(evidence?.label || '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const labels = new Set(['package weight', 'parcel weight', 'shipping weight', 'gross weight',
    'package dimensions', 'packaged dimensions', 'parcel dimensions', 'pakketgewicht', 'verpakkingsgewicht',
    'gewicht verpakking', 'gewicht van verpakking', 'gewicht van het pakket', 'pakketafmetingen',
    'verpakkingsafmetingen', 'afmetingen verpakking', 'afmetingen van het pakket']);
  const asin = String(product.sourceAsin || product.asin || '').toUpperCase();
  if (value === null || evidence?.kind !== 'package' || !labels.has(label)
    || evidence.source !== 'amazon_product_page' || !evidence.rawText || !evidence.selector
    || (asin && String(evidence.asin || '').toUpperCase() !== asin)
    || positiveNumber(evidence.value) === null || Math.abs(Number(evidence.value) - value) > 1e-9) return null;
  return value;
}

/** User policy: use the heavier evidenced mass; never promote cached billing mass. */
export function automaticProfitWeightKg(product = {}) {
  const item = automaticProductWeightKg(product);
  const packed = automaticPackageWeightKg(product);
  return item === null ? packed : packed === null ? item : Math.max(item, packed);
}

export function profitWeightSourceLabel(product = {}) {
  const manual = resolveManualWeightOverride(product);
  if (manual) return manual.source;
  const item = automaticProductWeightKg(product);
  const packed = automaticPackageWeightKg(product);
  if (packed !== null && (item === null || packed > item)) {
    return item === null ? 'Amazon 包裹重量（无商品重量，按包裹重量计算）' : 'Amazon 包裹重量（较重，按包裹重量计算）';
  }
  if (item !== null) return packed !== null && item > packed ? 'Amazon 商品重量（Item Weight 较重）' : 'Amazon 商品重量（Item Weight）';
  return '商品及包裹重量尚未采集';
}

/** Parse three lengths, never the mass after a dimensions row. Legacy
 * normalized fields without a unit are cm; raw page rows must name a unit. */
export function parseProductDimensionsCm(value, { requireUnit = false } = {}) {
  if (Array.isArray(value)) return normalizeDimensions(value);
  const text = String(value || '').normalize('NFKC');
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:[Ll])?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:[Ww])?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:[Hh])?\s*(centimet(?:er|re)s?|cm|millimet(?:er|re)s?|mm|inches|inch|in\b|["″]|met(?:er|re)s?|m\b)?/i);
  if (!match || (requireUnit && !match[4])) return null;
  const unit = String(match[4] || 'cm').toLowerCase();
  const factor = /^(in|["″])/.test(unit) ? 2.54 : /^(mm|millim)/.test(unit) ? .1 : /^(m|met)/.test(unit) && !/^mm/.test(unit) ? 100 : 1;
  return normalizeDimensions(match.slice(1, 4).map(value => Number(value) * factor));
}

export function resolveProductDimensionsCm(product = {}) {
  const inputs = product?.profitInputs || {};
  if (isManualInputSource(inputs.dimensionSource)) {
    const manual = normalizeDimensions(inputs.dimensionsCm);
    if (manual) return manual;
  }
  // Structured page sections were already inspected by the single-page parser.
  const rows = (product?.productInformation?.sections || []).flatMap(section => section.rows || []);
  for (const pattern of [/^(?:product|item) dimensions(?:\b|$)/i, /^(?:package|parcel|packaged) dimensions(?:\b|$)/i]) {
    for (const row of rows) {
      if (!pattern.test(String(row.label || '').trim())) continue;
      const dimensions = parseProductDimensionsCm(row.value, { requireUnit: true });
      if (dimensions) return dimensions;
    }
  }
  return parseProductDimensionsCm(product?.productDimensions) || parseProductDimensionsCm(product?.fbaDimensions)
    || normalizeDimensions(product?.dimensionsCm) || normalizeDimensions(inputs.dimensionsCm);
}

export function canadaDimensionalWeightKg(dimensionsCm) {
  return marketDimensionalWeightKg(dimensionsCm, 'CA');
}

export function marketDimensionalWeightKg(dimensionsCm, marketplace) {
  const dimensions = normalizeDimensions(dimensionsCm);
  const divisor = { AU: 6000, CA: 5021.69 }[String(marketplace || '').toUpperCase()];
  if (!dimensions || !divisor) return null;
  const weight = dimensions.reduce((volume, length) => volume * length, 1) / divisor;
  return Number.isFinite(weight) && weight > 0 ? weight : null;
}

/** Fees are compared in the marketplace currency, before display rounding. */
export function selectCorroboratedFbaFee(candidates = []) {
  const sorted = candidates.filter(candidate => Number.isFinite(candidate.fee) && candidate.fee >= 0)
    .slice().sort((a, b) => b.fee - a.fee);
  if (sorted.length === 1) return { selected: sorted[0], status: 'single_source_estimate' };
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (sorted[i].fee - sorted[i + 1].fee <= 3 + 1e-9) {
      return { selected: sorted[i], status: i === 0 ? 'corroborated' : 'outlier_excluded' };
    }
  }
  return { selected: null, status: sorted.length ? 'fee_conflict' : 'missing' };
}

export function fbaSelectionExplanation(estimate) {
  if (!estimate) return '';
  if (estimate.selectionStatus === 'single_source_estimate') return `FBA费用暂估：仅有${estimate.weightSource}依据，缺少交叉核验；利润率为暂估`;
  if (estimate.selectionStatus === 'fee_conflict') return `FBA费用差异过大：各项差额均超过3 ${estimate.currency}，需核验规格；利润率待计算`;
  if (estimate.selectionStatus === 'outlier_excluded') return `已排除最高异常FBA费用，采用${estimate.weightSource}费用；与另一项差额不超过3 ${estimate.currency}`;
  if (estimate.selectionStatus === 'corroborated') return `采用${estimate.weightSource}对应的最高FBA费用；与另一项差额不超过3 ${estimate.currency}`;
  return '';
}

export function hasAnyProductShippingSpecification(product = {}) {
  return resolveManualWeightOverride(product) !== null || automaticProfitWeightKg(product) !== null
    || (!usesItemWeightOnly(product) && positiveNumber(product.fbaWeight) !== null)
    || resolveProductDimensionsCm(product) !== null;
}

/** Compare fees, not just masses: capped tiers may tie at different weights. */
export function estimateFbaByAvailableSpecifications(product = {}, { marketplace = product.marketplace, actualWeightKg, dimensionsCm } = {}) {
  const market = String(marketplace || '').toUpperCase();
  if (market !== 'AU' && market !== 'CA') return null;
  dimensionsCm = normalizeDimensions(dimensionsCm) || resolveProductDimensionsCm(product);
  const manual = resolveManualWeightOverride(product);
  const candidates = [];
  const add = (source, weightKg, label) => {
    if (positiveNumber(weightKg) === null) return;
    const estimate = market === 'CA'
      ? estimateCa2026FbaFeeByProductWeight({ actualWeightKg: weightKg, itemPriceCad: product.salePrice })
      : estimateAu2026FbaFeeByProductWeight({ actualWeightKg: weightKg, itemPriceAud: product.salePrice, dimensionsCm });
    if (estimate) candidates.push({ ...estimate, source, weightSource: label, calculationWeightKg: weightKg });
  };
  if (manual) add('manual', manual.weightKg, manual.source);
  else {
    add('item', automaticProductWeightKg(product), '商品重量（Item Weight）');
    add('package', automaticPackageWeightKg(product) ?? (!usesItemWeightOnly(product) ? positiveNumber(product.fbaWeight) : null), '包裹重量');
    if (!candidates.length) add('actual', actualWeightKg, product.weightSource || '实重');
    add('dimensional', marketDimensionalWeightKg(dimensionsCm, market), `${market === 'AU' ? '澳洲' : '加拿大'}体积重（cm³ ÷ ${market === 'AU' ? 6000 : 5021.69}）`);
  }
  if (!candidates.length) return null;
  const { selected, status } = selectCorroboratedFbaFee(candidates);
  const result = { ...selected, fee: selected?.fee ?? null, currency: market === 'AU' ? 'AUD' : 'CAD',
    selectionPolicy: 'highest_corroborated_fba_fee', selectionStatus: manual ? 'manual_weight' : status,
    selectedWeightSource: selected?.source ?? null,
    dimensionalWeightKg: marketDimensionalWeightKg(dimensionsCm, market),
    dimensionsCm: normalizeDimensions(dimensionsCm),
    feeCandidates: candidates.map(({ source, calculationWeightKg, fee, weightSource }) => ({ source, weightKg: calculationWeightKg, fee, weightSource })),
    rateApplicability: selected?.rateApplicability || '' };
  result.selectionExplanation = fbaSelectionExplanation(result);
  return result;
}

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

/** Validate the bounded, same-product information inspection before treating a missing weight as absence. */
export function amazonWeightInformationState(product = {}) {
  const information = product.productInformation;
  const asin = String(product.sourceAsin || product.asin || "").trim().toUpperCase();
  if (!information || information.version !== 1 || !/^[A-Z0-9]{10}$/.test(asin)
    || String(information.asin || "").trim().toUpperCase() !== asin) return "unchecked";
  if (!hasCompleteProductInformationInspection(information, asin)) return "incomplete";
  const rows = information.sections.flatMap(section => section.rows);
  if (rows.length !== information.rowCount) return "incomplete";
  // A label without a parsed mass is unresolved, even if an older producer
  // incorrectly tagged the information block as having no weight.
  const hasWeightLabel = rows.some(row => (usesItemWeightOnly(product)
    ? /^\s*item\s+weight\s*[:：]?\s*$/i
    : /\b(?:weight|gewicht|itemgewicht|artikelgewicht|pakketgewicht|verpakkingsgewicht|poids|peso)\b|重量|重さ/i)
    .test(row.label.normalize("NFKC").replace(/\p{Cf}/gu, "")));
  return information.weightStatus === "not_provided" && !hasWeightLabel ? "not_provided" : "unresolved";
}

/** True only when a successful Amazon detail visit confirms the page provides no weight. */
export function isAmazonWeightUnavailable(product = {}) {
  if (automaticPackageWeightKg(product) !== null) return false;
  const status = String(product.detailStatus || '').toLowerCase();
  if (status !== 'success' && product.explicitProduct !== true) return false;
  if (['pending', 'loading', 'running', 'retrying', 'failed', 'error', 'cancelled'].includes(status)
    || product.challenge === true || product.rateLimited === true || product.navigationError === true
    || product.collectionLastAttempt?.status === 'failed' || product.lastCollectionError) return false;
  const weights = usesItemWeightOnly(product)
    ? [product.productWeightKg, product.productWeight, resolveManualWeightOverride(product)?.weightKg]
    : [product.productWeightKg, product.productWeight, product.fbaPackageWeightKg,
      product.packageWeightKg, product.fbaWeight, product.billingWeight, product.actualWeightKg,
      product.profitInputs?.actualWeightKg];
  // An invalid or unsourced value needs review; it is not evidence of page absence.
  if (weights.some((value) => value !== null && value !== undefined && value !== '')) return false;
  if (amazonWeightInformationState(product) !== 'not_provided') return false;
  const quality = product.collectionQuality?.fields?.weight;
  return quality ? quality.status === 'unavailable' && quality.reason === 'page_not_provided' : true;
}

/** Lowest applicable weight tier, preserving unknown weight rather than inventing one. */
export function estimateMinimumFbaFee({ marketplace, salePrice, dimensionsCm } = {}) {
  const market = String(marketplace || '').toUpperCase();
  const assumedWeightKg = minimumEnvelopeWeightKg(market);
  if (assumedWeightKg === null) return null;
  const common = {
    actualWeightKg: null,
    assumedWeightKg,
    weightAssumption: MISSING_WEIGHT_ASSUMPTION,
    weightAssumptionMarket: market,
    assumption: 'missing_weight_minimum_fba_estimate',
    weightSource: '重量未核验 · FBA 配送费按最低档估算',
    confidence: '低',
    ambiguity: ['product-weight-unverified', 'minimum-envelope-weight-assumed', 'minimum-fee-is-preliminary-only'],
  };
  if (market === 'AU' || market === 'CA') {
    const price = positiveNumber(salePrice);
    const dimensions = normalizeDimensions(dimensionsCm);
    const dimensionsExceedEnvelope = market === 'AU' && dimensions?.slice().sort((left, right) => right - left)
      .some((value, index) => value > AU_FBA_WORKBOOK_RATES[0].maxDimensionsCm[index] + 1e-9);
    const estimated = market === 'AU'
      ? estimateAu2026FbaFeeByProductWeight({ actualWeightKg: assumedWeightKg, itemPriceAud: price ?? 1,
          dimensionsCm: dimensionsExceedEnvelope ? undefined : dimensionsCm })
      : estimateCa2026FbaFeeByProductWeight({ actualWeightKg: assumedWeightKg, itemPriceCad: price ?? 1 });
    if (!estimated) return null;
    const priceKey = market === 'AU' ? 'itemPriceAud' : 'itemPriceCad';
    return {
      ...estimated, ...common, marketplace: market, [priceKey]: price,
      billableWeightG: null, feeWeightG: null, tierLabel: estimated.tierLabel.replace(/（.*）$/, '') + '（最低费暂估）',
      requestedEnvelopeSizePolicy: 'minimum-fee',
      priceAssumption: price === null ? 'missing_price_low_price_band_assumed' : null,
      ...(dimensionsExceedEnvelope ? { dimensionsCm: dimensions, dimensionsAssumption: 'minimum_envelope_despite_known_dimensions' } : {}),
      ambiguity: [...new Set([...common.ambiguity, ...estimated.ambiguity.filter(value =>
        !dimensionsExceedEnvelope || value !== 'standard-envelope-dimensions-not-verified'),
        ...(dimensionsExceedEnvelope ? ['known-dimensions-exceed-envelope-assumed-by-user-policy'] : []),
        ...(price === null ? ['sale-price-not-provided', 'low-price-band-assumed'] : [])])],
      rateApplicability: '重量未核验 · 按' + (market === 'AU' ? '澳洲标准信封' : '加拿大旺季信封件')
        + '最低重量档及适用售价规则暂估；头程和国内运费以该档上限重量暂估，实际重量待核验'
        + (dimensionsExceedEnvelope ? '；已知尺寸超出信封范围，按用户指定最低档暂估，不代表实际信封适用性' : '')
        + (price === null ? '；售价待补，暂按低售价档估算' : ''),
    };
  }
  if (market === 'US') {
    return { ...common, marketplace: market, currency: 'USD', fee: US_FBA_MINIMUM_STANDARD_FEE,
      tier: 'small-standard', tierLabel: '小号标准件（最低费暂估）', billableWeightLb: null,
      standardSizePolicy: 'small', rateSource: FBA_WEIGHT_ONLY_RATE_SOURCE,
      rateApplicability: '重量未核验 · 按当前美国 SOP 费率表最低 FBA 配送费估算；国内运费以 4 oz 暂估，头程沿用箱重或计费重规则，缺重时以 4 oz 参与估算；实际重量待核验' };
  }
  // Preserve the existing non-US weight model's nominal local-currency proxy;
  // this does not claim that a local official envelope rate table exists.
  return { ...common, marketplace: market, currency: MINIMUM_ENVELOPE_CURRENCIES[market],
    fee: US_FBA_MINIMUM_STANDARD_FEE, tier: 'small-standard-reference', tierLabel: '最低档（美国 SOP 名义费率暂估）',
    billableWeightLb: null, standardSizePolicy: 'small', referenceMarketplace: 'US', rateModel: 'us_sop_nominal_proxy',
    rateSource: FBA_WEIGHT_ONLY_RATE_SOURCE,
    rateApplicability: '重量未核验 · 沿用美国 SOP 最低档 3.22 的当地币值名义费率估算，非当地官方费表；国内运费以 4 oz 暂估，头程沿用箱重或计费重规则，缺重时以 4 oz 参与估算；实际重量待核验' };
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
  assumedWeightKg,
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
  const actual = positiveWeightNumber(actualWeightKg);
  const assumed = isMissingWeight(actualWeightKg) ? positiveWeightNumber(assumedWeightKg) : null;
  const cartonWeight = positiveNumber(cartonWeightKg);
  const cartonUnits = positiveNumber(unitsPerCarton);
  const dimensional = useActualWeightOnly ? null : calculateDimensionalWeight({ dimensionsCm, divisor: volumetricDivisor });
  const fallbackWeight = Math.max(actual || assumed || 0, dimensional?.dimensionalWeightKg || 0) || null;
  const chargeableWeightKg = useActualWeightOnly
    ? actual ?? assumed
    : cartonWeight !== null && cartonUnits !== null
      ? cartonWeight / cartonUnits
      : fallbackWeight;
  if (chargeableWeightKg === null) return null;
  return {
    actualWeightKg: actual,
    ...(assumed !== null ? { assumedWeightKg: assumed, weightAssumption: MISSING_WEIGHT_ASSUMPTION } : {}),
    volumetricWeightKg: dimensional?.dimensionalWeightKg ?? null,
    dimensionalWeightLb: dimensional?.dimensionalWeightLb ?? null,
    chargeableWeightKg,
    airFreightCny: chargeableWeightKg * rate,
    airFreightRateCnyPerKg: rate,
    airFreightRateCnyPerGram: rate / 1_000,
    cartonWeightKg: useActualWeightOnly ? null : cartonWeight,
    unitsPerCarton: useActualWeightOnly ? null : cartonUnits,
    source: useActualWeightOnly ? assumed !== null ? "minimum_envelope_assumption" : "product_weight"
      : cartonWeight !== null && cartonUnits !== null ? "carton"
        : assumed !== null && (!dimensional || assumed >= dimensional.dimensionalWeightKg) ? "minimum_envelope_assumption" : "single_package_fallback",
    confidence: assumed !== null ? "low" : useActualWeightOnly || (cartonWeight !== null && cartonUnits !== null) ? "standard" : "low",
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
  const weightAssumption = resolveMissingWeightProfitAssumption(input);
  const freight = calculateAirFreight({
    actualWeightKg: input.actualWeightKg,
    assumedWeightKg: weightAssumption?.assumedWeightKg ?? (input.airFreightActualWeightOnly === true ? positiveNumber(input.dimensionalWeightEstimateKg) : null),
    dimensionsCm: input.dimensionsCm,
    cartonWeightKg: input.cartonWeightKg,
    unitsPerCarton: input.unitsPerCarton,
    rateCnyPerKg: rates.airFreightRateCnyPerKg,
    volumetricDivisor: input.volumetricDivisor ?? 139,
    actualWeightOnly: input.airFreightActualWeightOnly === true,
  });
  if (!freight) return null;

  const dimensionalEstimate = positiveNumber(input.dimensionalWeightEstimateKg);
  if (dimensionalEstimate !== null && isMissingWeight(input.actualWeightKg)) {
    delete freight.assumedWeightKg;
    delete freight.weightAssumption;
    freight.dimensionalWeightEstimateKg = dimensionalEstimate;
    freight.source = 'dimensional_weight_estimate';
    freight.confidence = 'low';
  }
  const domesticFreightWeightKg = positiveWeightNumber(input.actualWeightKg) ?? weightAssumption?.assumedWeightKg ?? dimensionalEstimate;
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
    ...(dimensionalEstimate !== null ? { isEstimate: true, dimensionalWeightEstimateKg: dimensionalEstimate,
      domesticFreightWeightSource: 'dimensional_weight_estimate' } : {}),
    ...(weightAssumption ? { ...weightAssumption, isEstimate: true, domesticFreightWeightSource: "minimum_envelope_assumption" } : {}),
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

  const selection = selectCappedEnvelopeRate(weightKg, AU_FBA_WORKBOOK_RATES);
  if (!selection) return null;
  const { rate, billableWeightG, feeWeightG, weightCapG, overweightCapped } = selection;
  const lowPrice = priceAud <= 13;
  const fee = lowPrice ? rate.fee : rate.highFee;
  const sourceCell = lowPrice ? rate.sourceCell : rate.highSourceCell;
  return {
    marketplace: "AU", currency: "AUD", tier: "au-standard-envelope",
    tierLabel: overweightCapped ? "标准信封（超重按最高档封顶估算）" : "标准信封（按重量与售价估算）",
    fee, baseFee: fee, discount: 0, surchargeMultiplier: 1,
    billableWeightG, feeWeightG, weightCapG, overweightCapped, actualWeightKg: weightKg, itemPriceAud: priceAud,
    priceBand: lowPrice ? "low-price" : "high-price",
    priceBandLabel: lowPrice ? "售价 ≤13 AUD" : "售价 >13 AUD",
    weightBand: rate.weightBand, dimensionsCm: dimensions, maxDimensionsCm: limits,
    envelopeSizePolicy: "standard", requestedEnvelopeSizePolicy: requestedSizePolicy,
    effectiveEnvelopeSizePolicy: "standard", seasonPolicy: "user_standard_envelope_table",
    assumption: overweightCapped ? "overweight_maximum_tier_capped"
      : dimensions ? "standard_envelope_weight_price" : "standard_envelope_dimensions_assumed",
    dimensionsAssumption: dimensions ? null : "standard_envelope_dimensions_not_verified",
    rateSource: AU_FBA_WORKBOOK_RATE_SOURCE, sourceRange: rate.sourceRange, sourceCell,
    sourceCells: ["表格_20261009!B2", rate.weightSourceCell, sourceCell],
    rateApplicability: "标准信封 ≤33×23×2.5 cm、≤475g；售价 ≤13 AUD 按低价档，>13 AUD 按高价档"
      + (overweightCapped ? "；实际重量超出费表范围，按用户指定最高重量档封顶估费，不代表实际配送费或信封合规" : "")
      + (dimensions ? "" : "；尺寸未提供，按标准信封暂估"),
    confidence: dimensions && !overweightCapped ? "standard" : "low",
    ambiguity: [...(dimensions ? [] : ["standard-envelope-dimensions-not-verified"]),
      ...(overweightCapped ? ["weight-exceeds-envelope-table", "maximum-tier-fee-applied-by-user-policy"] : [])],
  };
}

export function estimateCa2026FbaFeeByProductWeight({ actualWeightKg, itemPriceCad } = {}) {
  const weightKg = positiveNumber(actualWeightKg);
  const priceCad = positiveNumber(itemPriceCad);
  if (weightKg === null || priceCad === null) return null;
  const selection = selectCappedEnvelopeRate(weightKg, CA_FBA_PEAK_ENVELOPE_RATES);
  if (!selection) return null;
  const { rate, billableWeightG, feeWeightG, weightCapG, overweightCapped } = selection;
  const lowPrice = priceCad < 14;
  const discount = lowPrice ? CA_FBA_LOW_PRICE_DISCOUNT : 0;
  return {
    marketplace: "CA", currency: "CAD", tier: "ca-peak-envelope",
    tierLabel: overweightCapped ? "旺季信封件（超重按最高档封顶估算）" : "旺季信封件（按重量与售价估算）",
    // Keep full precision throughout profit calculation; only presentation rounds money.
    fee: (rate.baseFee - discount) * CA_FBA_SURCHARGE_MULTIPLIER,
    baseFee: rate.baseFee, discount, surchargeMultiplier: CA_FBA_SURCHARGE_MULTIPLIER,
    surchargeRate: 0.035, lowPriceDiscount: CA_FBA_LOW_PRICE_DISCOUNT,
    billableWeightG, feeWeightG, weightCapG, overweightCapped, actualWeightKg: weightKg, itemPriceCad: priceCad,
    priceBand: lowPrice ? "low-price" : "standard-price",
    priceBandLabel: lowPrice ? "售价 <14 CAD，减 0.8 CAD" : "售价 ≥14 CAD，无低价优惠",
    weightBand: rate.weightBand, envelopeSizePolicy: "envelope", seasonPolicy: "peak_only_user_selected",
    peakStartsOn: "2026-10-15", peakEndsOn: "2027-01-14", surchargeStartsOn: "2026-04-17",
    assumption: overweightCapped ? "overweight_maximum_tier_capped" : "peak_envelope_user_selected", rateSource: CA_FBA_PEAK_WORKBOOK_RATE_SOURCE,
    sourceRange: rate.sourceRange, sourceCell: rate.sourceCell,
    sourceCells: ["Sheet1!A2", "Sheet1!D3", rate.weightSourceCell, rate.sourceCell,
      ...(lowPrice ? [rate.discountedSourceCell] : [])],
    rateApplicability: "统一按加拿大旺季信封件表估费，≤500g；售价 <14 CAD 减 0.8；(基础费－优惠)×1.035；CAD 不含税"
      + (overweightCapped ? "；实际重量超出费表范围，按用户指定最高重量档封顶估费，不代表实际配送费或信封合规" : ""),
    confidence: "low", ambiguity: ["peak-rates-applied-by-user-policy", "envelope-dimensions-not-specified-in-source",
      ...(overweightCapped ? ["weight-exceeds-envelope-table", "maximum-tier-fee-applied-by-user-policy"] : [])],
  };
}

function selectCappedEnvelopeRate(weightKg, rates) {
  // Preserve the actual rounded grams for diagnostics; only the fee lookup
  // weight is capped. Freight calculations continue to use actualWeightKg.
  const billableWeightG = Math.max(1, Math.ceil((weightKg * 1_000) - 1e-9));
  if (!Number.isFinite(billableWeightG)) return null;
  const weightCapG = rates.at(-1).maxWeightG;
  const feeWeightG = Math.min(billableWeightG, weightCapG);
  const rate = rates.find((row) => feeWeightG >= row.minWeightG && feeWeightG <= row.maxWeightG);
  return rate ? { rate, billableWeightG, feeWeightG, weightCapG, overweightCapped: billableWeightG > weightCapG } : null;
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
