import { DEFAULT_PROFIT_RATES, PROFIT_FORMULA_VERSION, calculateProductProfit, estimateAu2026FbaFeeByProductWeight, estimateCa2026FbaFeeByProductWeight, estimateUs2023FbaFeeByProductWeight, isAmazonWeightUnavailable, estimateMinimumFbaFee, resolveManualWeightOverride, hasManualFulfillmentFee } from './profit-model.mjs';
import { TITLE_PIECE_COUNT_RULE_VERSION, calculatePieceAdjustedPurchaseCostCny, extractTitlePieceCount, normalizePieceCount } from './title-piece-count.mjs';

// These business defaults match app.js. The parity tests compare both paths.
const MARKET_CONFIGS = {
  "NL": {
    "code": "NL",
    "currency": "EUR",
    "defaultExchangeRate": 7.85
  },
  "AU": {
    "code": "AU",
    "currency": "AUD",
    "defaultExchangeRate": 4.8,
    "defaultAirFreightRateCnyPerKg": 45,
    "defaultCommissionRate": 11,
    "defaultManagementRate": 6,
    "defaultReturnsRate": 4,
    "airFreightActualWeightOnly": true
  },
  "US": {
    "code": "US",
    "currency": "USD",
    "defaultExchangeRate": 7.12
  },
  "CA": {
    "code": "CA",
    "currency": "CAD",
    "defaultExchangeRate": 5.2,
    "defaultAirFreightRateCnyPerKg": 45,
    "defaultReturnsRate": 4
  },
  "UK": {
    "code": "UK",
    "currency": "GBP",
    "defaultExchangeRate": 9.6
  },
  "DE": {
    "code": "DE",
    "currency": "EUR",
    "defaultExchangeRate": 7.85
  },
  "FR": {
    "code": "FR",
    "currency": "EUR",
    "defaultExchangeRate": 7.85
  },
  "IT": {
    "code": "IT",
    "currency": "EUR",
    "defaultExchangeRate": 7.85
  },
  "ES": {
    "code": "ES",
    "currency": "EUR",
    "defaultExchangeRate": 7.85
  },
  "PL": {
    "code": "PL",
    "currency": "PLN",
    "defaultExchangeRate": 1.85
  },
  "MX": {
    "code": "MX",
    "currency": "MXN",
    "defaultExchangeRate": 0.42
  },
  "BR": {
    "code": "BR",
    "currency": "BRL",
    "defaultExchangeRate": 1.35
  }
};
const COMPETITOR_PRICE_RATIO = 1;
const FBA_WEIGHT_STANDARD_SIZE_POLICY = 'large';
const AU_FBA_ENVELOPE_SIZE_POLICY = "standard";

/**
 * Recompute one canonical product without changing the product or its snapshot.
 * context may be a snapshot: { runState, costParams, profitModel }. Its defaults
 * fill missing product inputs; a product's saved profitInputs take precedence.
 * Pass now (an ISO string, Date, millisecond timestamp, or clock function) for a
 * fresh calculation timestamp. Without it, retain available source timestamps.
 * This function does not fetch data, choose suppliers, or reopen handed-off work.
 */
export function recomputeProductProfit(product, context = {}) {
  const result = structuredClone(product);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (isAnalysisReadOnly(result)) return result;
  const scope = context.snapshot || context;
  const marketCode = String(result.marketplace || context.marketplace || scope.runState?.marketplace || scope.marketplace || 'NL').toUpperCase();
  const activeMarket = MARKET_CONFIGS[marketCode] || MARKET_CONFIGS.NL;
  const requestedTime = typeof context.now === 'function' ? context.now() : context.now;
  const sourceTime = requestedTime ?? context.calculatedAt ?? result.profitCalculation?.calculatedAt ?? result.collectedAt ?? result.profitInputs?.updatedAt ?? null;
  const parsedTime = sourceTime === null ? null : new Date(sourceTime);
  const calculatedAt = parsedTime && Number.isFinite(parsedTime.getTime()) ? parsedTime.toISOString() : null;
  const defaults = migrateLegacyProfitDefaults(scope.costParams, activeMarket.code);
  const contextRates = scope.profitModel && typeof scope.profitModel === 'object' ? scope.profitModel : {};
  for (const key of ['commissionRate', 'fxLossRate', 'marketingRate', 'managementRate', 'returnsRate', 'purchaseTaxRate', 'domesticFreightRateCnyPerKg', 'airFreightRateCnyPerKg', 'volumetricDivisor']) {
    const value = finiteOrNull(contextRates[key]);
    if (value !== null && value >= 0) defaults[key] = value;
  }
  const exchangeRate = [contextRates.exchangeRate, scope.runState?.exchangeRate]
    .map(finiteOrNull).find(value => value !== null && value > 0);
  if (exchangeRate !== undefined) defaults.exchangeRate = exchangeRate;
  ensureProductProfitInputs(result, defaults);
  ensureFulfillmentState(result);
  assumeFbaForWeightedProduct(result);
  refreshProductWeightState(result);
  ensureProductPurchasePricing(result);
  result.salePrice = calculateOurSalePrice(result);
  applyAutomaticFba(result);
  rebuildProductMissing(result);
  updateProductComputed(result);
  return result;

  function isAnalysisReadOnly(value) { return value?.analysisHandoff?.owner === 'procurement'; }

  function getDefaultProfitInputs(marketCode = activeMarket.code) {
    const market = MARKET_CONFIGS[marketCode] || MARKET_CONFIGS.AU;
    return {
      formulaVersion: PROFIT_FORMULA_VERSION,
      exchangeRate: market.defaultExchangeRate,
      ...DEFAULT_PROFIT_RATES,
      airFreightRateCnyPerKg: market.defaultAirFreightRateCnyPerKg ?? DEFAULT_PROFIT_RATES.airFreightRateCnyPerKg,
      commissionRate: market.defaultCommissionRate ?? DEFAULT_PROFIT_RATES.commissionRate,
      managementRate: market.defaultManagementRate ?? DEFAULT_PROFIT_RATES.managementRate,
      returnsRate: market.defaultReturnsRate ?? DEFAULT_PROFIT_RATES.returnsRate,
      airFreightActualWeightOnly: market.airFreightActualWeightOnly === true,
      volumetricDivisor: 139,
    };
  }

  function migrateLegacyProfitDefaults(value, marketCode) {
    const defaults = getDefaultProfitInputs(marketCode);
    if (!value || typeof value !== "object") return defaults;
    const legacyMap = {
      exchangeRate: "exchangeRate",
      commission: "commissionRate",
      fxLoss: "fxLossRate",
      marketing: "marketingRate",
      management: "managementRate",
      returns: "returnsRate",
      freightRate: "airFreightRateCnyPerKg",
    };
    for (const [legacyKey, currentKey] of Object.entries(legacyMap)) {
      const number = finiteOrNull(value[legacyKey]);
      const isLegacyAuAirFreightDefault = (marketCode === "AU" || marketCode === "CA")
        && currentKey === "airFreightRateCnyPerKg"
        && (number === DEFAULT_PROFIT_RATES.airFreightRateCnyPerKg || number === 60);
      const isLegacyAuOperatingRate = marketCode === "AU" || marketCode === "CA"
        ? ((currentKey === "managementRate" && marketCode === "AU" && number === DEFAULT_PROFIT_RATES.managementRate)
          || (currentKey === "returnsRate" && (number === DEFAULT_PROFIT_RATES.returnsRate || number === 10))
          || (currentKey === "commissionRate" && marketCode === "AU" && number === DEFAULT_PROFIT_RATES.commissionRate))
        : false;
      if (number !== null && number >= 0 && !isLegacyAuAirFreightDefault && !isLegacyAuOperatingRate) defaults[currentKey] = number;
    }
    if (defaults.exchangeRate <= 0) defaults.exchangeRate = MARKET_CONFIGS[marketCode]?.defaultExchangeRate || activeMarket.defaultExchangeRate;
    return defaults;
  }

  function normalizeFulfillmentMode(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (/(?:FBM|MFN|MERCHANT)/.test(normalized)) return "FBM";
    if (/(?:FBA|AMZ|AMAZON)/.test(normalized)) return "FBA";
    return null;
  }

  function ensureFulfillmentState(product) {
    if (isAnalysisReadOnly(product)) return product;
    product.fulfillmentMode = normalizeFulfillmentMode(product.fulfillmentMode || product.fulfillment);
    product.fbaFee = finiteOrNull(product.fbaFee);
    product.fbmFee = finiteOrNull(product.fbmFee);
    product.manualFbaFee = hasManualFulfillmentFee(product, "FBA");
    product.manualFbmFee = hasManualFulfillmentFee(product, "FBM");
    const savedSource = String(product.fulfillmentModeSource || "").trim().toLowerCase();
    if (savedSource) {
      product.fulfillmentModeSource = savedSource;
    } else if (product.fulfillmentMode && normalizeFulfillmentMode(product.fulfillment) === product.fulfillmentMode) {
      product.fulfillmentModeSource = "provider";
    } else if ((product.fulfillmentMode === "FBA" && product.manualFbaFee)
      || (product.fulfillmentMode === "FBM" && product.manualFbmFee)) {
      product.fulfillmentModeSource = "manual";
    } else if (product.fulfillmentMode === "FBA") {
      product.fulfillmentModeSource = "assumed_fba_for_estimate";
    } else if (product.fulfillmentMode) {
      product.fulfillmentModeSource = "legacy_unknown";
    } else {
      product.fulfillmentModeSource = null;
    }
    return product;
  }

  function fbaEstimationWeightKg(product) {
    const candidate = product?.manualProfitInputs
      ? product.billingWeight
      : product?.productWeight ?? product?.billingWeight;
    const weightKg = Number(candidate);
    return Number.isFinite(weightKg) && weightKg > 0 ? weightKg : null;
  }

  function assumeFbaForWeightedProduct(product) {
    if (isAnalysisReadOnly(product)) return false;
    ensureFulfillmentState(product);
    // Fulfillment may be estimated independently while full profit inputs are pending.
    if (product.fulfillmentMode) return false;
    product.fulfillmentMode = "FBA";
    product.fulfillmentModeSource = "assumed_fba_for_estimate";
    return true;
  }

  function isManualCostProduct(product) {
    return Boolean(product.manualPurchaseCost || product.costSource === "manual" || String(product.supplierSource || "").startsWith("manual"));
  }

  function getFulfillmentFee(product) {
    ensureFulfillmentState(product);
    return product.fulfillmentMode === "FBM" ? product.fbmFee : product.fulfillmentMode === "FBA" ? product.fbaFee : null;
  }

  function fulfillmentFeeMissingLabel(mode) {
    const normalized = normalizeFulfillmentMode(mode);
    return normalized === "FBM" ? "FBM 履约费" : normalized === "FBA" ? "FBA 配送费" : "履约方式";
  }

  function ensureProductPieceCount(product) {
    if (isAnalysisReadOnly(product)) return product.pieceCount;
    const detected = extractTitlePieceCount(product?.englishName || product?.name || "");
    const savedCount = normalizePieceCount(product?.pieceCount);
    const manual = product?.pieceCountSource === "manual" && savedCount !== null;
    product.detectedPieceCount = detected.count;
    product.pieceCountEvidence = detected.evidence;
    product.pieceCountRuleVersion = TITLE_PIECE_COUNT_RULE_VERSION;
    product.pieceCount = manual ? savedCount : detected.count;
    product.pieceCountSource = manual ? "manual" : detected.source;
    return product.pieceCount;
  }

  function totalPurchaseCostCny(unitCostCny, pieceCount) {
    return calculatePieceAdjustedPurchaseCostCny(unitCostCny, pieceCount);
  }

  function ensureProductPurchasePricing(product) {
    if (isAnalysisReadOnly(product)) return { pieceCount: product.pieceCount, unitCostCny: product.purchaseUnitCostCny, totalCostCny: product.purchaseCost };
    const pieceCount = ensureProductPieceCount(product);
    // Earlier empty quote results were coerced through Number(null) to zero.
    // Preserve an explicit manual zero, but never treat an absent quote as free stock.
    if (!isManualCostProduct(product) && finiteOrNull(product.supplierAverageCny) === null
      && !(product.suppliers || []).some(quote => Number.isFinite(quote.unitPriceCny) && quote.unitPriceCny > 0)
      && (product.purchaseCost === 0 || product.purchaseUnitCostCny === 0)) {
      product.purchaseCost = null;
      product.purchaseUnitCostCny = null;
    }
    const totalCost = finiteOrNull(product.purchaseCost);
    const supplierUnitCost = finiteOrNull(product.supplierAverageCny);
    let unitCost = finiteOrNull(product.purchaseUnitCostCny);
    if (isManualCostProduct(product)) {
      if (unitCost === null && totalCost !== null) unitCost = totalCost / pieceCount;
    } else if (supplierUnitCost !== null) {
      unitCost = supplierUnitCost;
    } else if (unitCost === null && totalCost !== null) {
      unitCost = totalCost / pieceCount;
    }
    product.purchaseUnitCostCny = unitCost;
    const resolvedTotal = totalPurchaseCostCny(product.purchaseUnitCostCny, pieceCount);
    product.purchaseCost = resolvedTotal;
    return {
      pieceCount,
      unitCostCny: product.purchaseUnitCostCny,
      totalCostCny: resolvedTotal,
    };
  }

  function refreshProductWeightState(product) {
    if (isAnalysisReadOnly(product)) return;
    const manualWeight = resolveManualWeightOverride(product);
    if (manualWeight) {
      product.billingWeight = manualWeight.weightKg;
      product.weightSource = manualWeight.source;
      product.manualProfitInputs = true;
      return;
    }
    const hasValidProductWeight = Number.isFinite(product.productWeight) && product.productWeight > 0;
    const source = String(product.fieldSources?.productWeightKg || "");
    product.weightSource = hasValidProductWeight
      ? source === "amazon_package_weight_fallback" ? "Amazon 包装重量回退" : "Amazon 商品重量"
      : Number.isFinite(product.productWeight) ? "商品重量（值无效）" : "商品重量缺失";
    product.billingWeight = hasValidProductWeight ? product.productWeight : product.productWeight ?? null;
  }

  function ensureProductProfitInputs(product, defaultsOverride = null) {
    if (isAnalysisReadOnly(product)) return product.profitInputs || {};
    const defaults = { ...(defaultsOverride || getDefaultProfitInputs(product.marketplace)) };
    const existing = product.profitInputs && typeof product.profitInputs === "object" ? product.profitInputs : {};
    const packageDimensions = parseDimensionsCm(product.fbaDimensions);
    const productDimensions = parseDimensionsCm(product.productDimensions);
    const existingDimensions = Array.isArray(existing.dimensionsCm) && existing.dimensionsCm.length >= 3
      ? existing.dimensionsCm.slice(0, 3).map(finiteOrNull)
      : null;
    const dimensionsCm = existingDimensions?.every((value) => value !== null && value > 0)
      ? existingDimensions
      : packageDimensions || productDimensions;
    const automaticWeight = [product.productWeight, product.billingWeight]
      .map(finiteOrNull)
      .find((value) => value !== null && value > 0) ?? null;
    const formulaChanged = existing.formulaVersion !== PROFIT_FORMULA_VERSION;
    const previousVersionHasCurrentSharedRates = [
      "profit-workbook-airfreight-us2023-domestic-v3",
      "profit-workbook-au-weight-freight-us2023-domestic-v4",
      "profit-workbook-au-flat-fba-rates-v5",
      "profit-workbook-au-2026-weight-fba-rates-v6",
      "profit-workbook-au-2026-smallest-envelope-fba-v7",
      "profit-workbook-au-weight-only-fba-v8",
      "profit-workbook-au-weight-only-fba-v9",
    ].includes(existing.formulaVersion);
    const previousVersionHasOnlyFbaMigration = [
      "profit-workbook-au-2026-weight-fba-rates-v6",
      "profit-workbook-au-2026-smallest-envelope-fba-v7",
      "profit-workbook-au-weight-only-fba-v9",
    ].includes(existing.formulaVersion);
    const marketplace = String(product.marketplace || activeMarket.code).toUpperCase();
    const rateKeys = ["exchangeRate", "commissionRate", "fxLossRate", "marketingRate", "managementRate", "returnsRate", "purchaseTaxRate", "domesticFreightRateCnyPerKg", "airFreightRateCnyPerKg", "volumetricDivisor"];
    const resolved = { ...existing };
    for (const key of rateKeys) {
      const value = finiteOrNull(existing[key]);
      const resetAuAirFreight = formulaChanged
        && !previousVersionHasOnlyFbaMigration
        && (marketplace === "AU" || marketplace === "CA")
        && key === "airFreightRateCnyPerKg"
        && existing.airFreightRateSource !== "product_manual"
        && (value === null || value === DEFAULT_PROFIT_RATES.airFreightRateCnyPerKg || value === 60);
      const resetAuOperatingRate = formulaChanged
        && !previousVersionHasOnlyFbaMigration
        && (marketplace === "AU" || marketplace === "CA")
        && ((key === "managementRate" && (value === null || value === DEFAULT_PROFIT_RATES.managementRate))
          || (key === "returnsRate" && (value === null || value === DEFAULT_PROFIT_RATES.returnsRate))
          || (key === "commissionRate" && marketplace === "AU" && (value === null || value === DEFAULT_PROFIT_RATES.commissionRate)));
      const resetSharedRate = formulaChanged
        && !previousVersionHasCurrentSharedRates
        && ["purchaseTaxRate", "domesticFreightRateCnyPerKg"].includes(key);
      const resetForNewPolicy = resetSharedRate
        || resetAuAirFreight
        || resetAuOperatingRate;
      resolved[key] = !resetForNewPolicy && value !== null && value >= 0 ? value : defaults[key];
    }
    delete resolved.domesticFreightCny;
    resolved.formulaVersion = PROFIT_FORMULA_VERSION;
    resolved.purchaseTaxRateSource = formulaChanged && !previousVersionHasOnlyFbaMigration ? "default_4_percent" : existing.purchaseTaxRateSource || "default_4_percent";
    resolved.domesticFreightSource = formulaChanged && !previousVersionHasOnlyFbaMigration ? "product_weight_rate_estimate" : existing.domesticFreightSource || "product_weight_rate_estimate";
    resolved.airFreightActualWeightOnly = defaults.airFreightActualWeightOnly === true;
    resolved.airFreightRateSource = existing.airFreightRateSource === "product_manual"
      ? "product_manual"
      : resolved.airFreightRateCnyPerKg === defaults.airFreightRateCnyPerKg
        ? resolved.airFreightActualWeightOnly ? "au_workbook_45_cny_per_kg" : existing.airFreightRateSource || "market_default_air_freight"
        : existing.airFreightRateSource || "legacy_custom";
    const existingWeightKg = finiteOrNull(existing.actualWeightKg);
    const manualWeight = resolveManualWeightOverride(product);
    resolved.actualWeightKg = manualWeight
      ? manualWeight.weightKg
      : automaticWeight ?? existingWeightKg;
    resolved.dimensionsCm = dimensionsCm;
    resolved.dimensionSource = existing.dimensionSource || (packageDimensions ? "SellerSprite FBA 包装参数" : productDimensions ? "SellerSprite 商品参数回退" : "参数缺失");
    resolved.weightSource = manualWeight
      ? manualWeight.source
      : automaticWeight !== null
        ? product.weightSource || "商品重量"
        : existing.weightSource || "商品重量缺失";
    resolved.cartonWeightKg = finiteOrNull(existing.cartonWeightKg);
    resolved.unitsPerCarton = finiteOrNull(existing.unitsPerCarton);
    resolved.updatedAt ||= product.collectedAt || calculatedAt;
    product.profitInputs = resolved;
    return resolved;
  }

  function calculateOurSalePrice(product) {
    const manualSalePrice = finiteOrNull(product?.salePrice);
    if (product?.manualSalePrice === true) {
      return manualSalePrice !== null && manualSalePrice > 0 ? roundMoney(manualSalePrice) : null;
    }
    const currentPrice = finiteOrNull(product.currentPrice);
    if (currentPrice === null || currentPrice <= 0) return null;
    return roundMoney(currentPrice * COMPETITOR_PRICE_RATIO);
  }

  function collectMissingFields(product) {
    const missing = [];
    const amazonOnly = product.analysisSourceMode === "amazon_only";
    if (!product.sourceAsin && !product.asin) missing.push("源 ASIN");
    if (!product.sellerId && !product.storeName) missing.push("店铺标识");
    if (!String(product.name || product.englishName || "").trim() || (/^Amazon 商品\s+/i.test(String(product.name || "")) && !product.manualAmazonFields?.title)) missing.push("商品标题");
    if (!Number.isFinite(product.currentPrice)) missing.push("当前售价");
    else if (product.currentPrice <= 0) missing.push("当前售价（值无效）");
    if (!Number.isFinite(product.rating)) missing.push("竞品评价星级");
    if (!Number.isFinite(product.reviews)) missing.push("竞品评价数量");
    if (!product.imageUrl) missing.push("商品主图");
    const hasCollectedWeight = Number.isFinite(product.fbaWeight) || Number.isFinite(product.productWeight);
    const hasValidWeight = (Number.isFinite(product.fbaWeight) && product.fbaWeight > 0) || (Number.isFinite(product.productWeight) && product.productWeight > 0);
    if (!hasCollectedWeight) missing.push("重量");
    else if (!hasValidWeight) missing.push("重量（值无效）");
    if (!amazonOnly) {
      if (!Number.isFinite(product.sales30)) missing.push("竞品 30 天销量");
      if (!Number.isFinite(product.sales60)) missing.push("竞品 60 天销量");
      if (typeof product.hasAPlus !== "boolean") missing.push("竞品 A+ 状态");
      if (!product.listingAvailableAt) missing.push("竞品上架时间");
      if (!product.firstFba) missing.push("首次 FBA 有货时间");
      if (!parseDimensionsCm(product.fbaDimensions) && !parseDimensionsCm(product.productDimensions)) missing.push("长宽高");
      if (!normalizeFulfillmentMode(product.fulfillmentMode || product.fulfillment)) missing.push("履约方式");
    }
    return missing;
  }

  function rebuildProductMissing(product) {
    if (isAnalysisReadOnly(product)) return product.missing || [];
    const amazonMissing = collectMissingFields(product);
    const missing = [...amazonMissing];
    const profitInputs = ensureProductProfitInputs(product);
    if (!Number.isFinite(product.purchaseCost) || product.purchaseCost < 0) missing.push("采购成本");
    if (!Number.isFinite(getFulfillmentFee(product)) || getFulfillmentFee(product) < 0) {
      missing.push(fulfillmentFeeMissingLabel(product.fulfillmentMode));
    }
    if (!Number.isFinite(profitInputs.actualWeightKg) || profitInputs.actualWeightKg <= 0) missing.push("计费重量");
    if (!Number.isFinite(profitInputs.airFreightRateCnyPerKg) || profitInputs.airFreightRateCnyPerKg < 0) missing.push("空运单价");
    product.amazonMissing = [...new Set(amazonMissing)];
    product.missing = [...new Set(missing)];
    return product.missing;
  }

  function updateProductComputed(product) {
    if (isAnalysisReadOnly(product)) return;
    if (!Array.isArray(product.missing)) product.missing = [];
    product.complete = product.missing.length === 0;
    const calculation = calculateProfit(product);
    if (!calculation) {
      product.profitPendingReasons = profitCalculationMissingReasons(product);
      if (product.complete) {
        product.complete = false;
        if (!product.missing.includes("利润计算参数")) product.missing.push("利润计算参数");
      }
      product.margin = null;
      product.profitValue = null;
      product.totalCost = null;
      product.profitCalculation = null;
      return;
    }
    product.margin = calculation?.margin ?? null;
    product.profitPendingReasons = [];
    product.profitValue = calculation?.profit ?? null;
    product.totalCost = calculation?.totalCost ?? null;
    product.profitCalculation = {
      ...calculation,
      calculatedAt: calculatedAt,
      parameterConfidence: calculation.airFreight?.confidence || "low",
    };
  }

  function profitCalculationMissingReasons(product) {
    const inputs = ensureProductProfitInputs(product);
    const reasons = [];
    if (!Number.isFinite(product.salePrice) || product.salePrice <= 0) reasons.push('售价');
    if (product.purchaseCost != null && product.purchaseCost !== '' && (!Number.isFinite(product.purchaseCost) || product.purchaseCost < 0)) reasons.push('有效采购成本');
    const weight = finiteOrNull((product.manualProfitInputs ? inputs.actualWeightKg ?? product.billingWeight : null)
      ?? product.actualWeightKg
      ?? (inputs.airFreightActualWeightOnly ? product.productWeight : product.billingWeight)
      ?? inputs.actualWeightKg ?? product.billingWeight);
    if (weight === null || weight <= 0) reasons.push('商品重量');
    const mode = normalizeFulfillmentMode(product.fulfillmentMode);
    if (!mode) reasons.push('履约方式');
    const fee = product.fulfillmentFee ?? (mode === 'FBM' ? product.fbmFee : mode === 'FBA' ? product.fbaFee : null);
    if (!Number.isFinite(fee) || fee < 0) reasons.push(mode === 'FBA' ? 'FBA 配送费' : '配送费');
    if (!Number.isFinite(inputs.exchangeRate) || inputs.exchangeRate <= 0) reasons.push('汇率');
    return reasons;
  }

  function calculateProfit(subject = {}) {
    if (isAnalysisReadOnly(subject) && subject.profitCalculation) return subject.profitCalculation;
    const inputs = subject.profitInputs && typeof subject.profitInputs === "object"
      ? ensureProductProfitInputs(subject)
      : { ...getDefaultProfitInputs(subject.marketplace || activeMarket.code), ...(subject.resolvedProfitInputs || {}) };
    const mode = normalizeFulfillmentMode(subject.fulfillmentMode);
    const selectedFulfillmentFee = subject.fulfillmentFee ?? (mode === "FBM" ? subject.fbmFee : mode === "FBA" ? subject.fbaFee : null);
    const dimensionsCm = Array.isArray(subject.dimensionsCm)
      ? subject.dimensionsCm
      : inputs.dimensionsCm || parseDimensionsCm(subject.fbaDimensions) || parseDimensionsCm(subject.productDimensions);
    const actualWeightKg = finiteOrNull((subject.manualProfitInputs ? inputs.actualWeightKg ?? subject.billingWeight : null)
      ?? subject.actualWeightKg
      ?? (inputs.airFreightActualWeightOnly ? subject.productWeight : subject.billingWeight)
      ?? inputs.actualWeightKg
      ?? subject.billingWeight);
    const purchaseCostAssumedZero = subject.purchaseCost == null || subject.purchaseCost === '';
    const calculation = calculateProductProfit({
      ...inputs,
      salePrice: subject.salePrice,
      purchaseCostCny: purchaseCostAssumedZero ? 0 : subject.purchaseCost,
      fulfillmentMode: mode,
      fulfillmentFee: selectedFulfillmentFee,
      actualWeightKg,
      dimensionsCm,
      cartonWeightKg: subject.cartonWeightKg ?? inputs.cartonWeightKg,
      unitsPerCarton: subject.unitsPerCarton ?? inputs.unitsPerCarton,
    });
    return calculation ? { ...calculation, purchaseCostAssumedZero } : null;
  }

  function automaticFbaFeeSource(product) {
    if (product.fbaEstimate?.assumption === 'missing_weight_minimum_fba_estimate') return 'missing_weight_minimum_fba_estimate';
    const market = MARKET_CONFIGS[String(product?.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    return market.code === "AU" ? "au_standard_envelope_price_rate" : market.code === "CA" ? "ca_peak_envelope_price_rate" : "fba_sop_product_weight";
  }

  function applyAutomaticFba(product) {
    if (isAnalysisReadOnly(product)) return;
    ensureFulfillmentState(product);
    assumeFbaForWeightedProduct(product);
    if (product.fulfillmentMode !== "FBA") return;
    const market = MARKET_CONFIGS[String(product.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    if (product.manualFbaFee) {
      if (market.code === "AU" || market.code === "CA") product.fbaEstimate = estimateWeightOnlyFbaFee(product);
      return;
    }
    const estimate = estimateWeightOnlyFbaFee(product);
    product.fbaEstimate = estimate;
    product.fieldSources = { ...(product.fieldSources || {}) };
    if (estimate) {
      product.fbaFee = estimate.fee;
      product.fbaFeeSource = automaticFbaFeeSource(product);
      product.fieldSources.fbaFee = automaticFbaFeeSource(product);
    } else if (product.fbaFeeSource !== "manual") {
      product.fbaFee = null;
      product.fbaFeeSource = null;
      delete product.fieldSources.fbaFee;
    }
  }

  function estimateWeightOnlyFbaFee(product) {
    const market = MARKET_CONFIGS[String(product?.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    const weightKg = fbaEstimationWeightKg(product);
    const dimensionsCm = product.profitInputs?.dimensionsCm || product.dimensionsCm
      || parseDimensionsCm(product.fbaDimensions) || parseDimensionsCm(product.productDimensions);
    if (weightKg === null) return isAmazonWeightUnavailable(product)
      ? estimateMinimumFbaFee({ marketplace: market.code, salePrice: product.salePrice, dimensionsCm }) : null;
    const weightSource = product.weightSource || "商品重量";
    if (market.code === "AU" || market.code === "CA") {
      const estimate = market.code === "AU"
        ? estimateAu2026FbaFeeByProductWeight({ actualWeightKg: weightKg, itemPriceAud: product.salePrice,
            envelopeSizePolicy: AU_FBA_ENVELOPE_SIZE_POLICY, dimensionsCm })
        : estimateCa2026FbaFeeByProductWeight({ actualWeightKg: weightKg, itemPriceCad: product.salePrice });
      return estimate ? { ...estimate, weightSource } : null;
    }
    const estimate = estimateUs2023FbaFeeByProductWeight({
      actualWeightKg: weightKg,
      standardSizePolicy: FBA_WEIGHT_STANDARD_SIZE_POLICY,
    });
    if (!estimate) return null;
    return {
      ...estimate,
      weightSource,
      confidence: estimate.confidence === "standard" ? "标准" : "低",
      rateApplicability: market.code === "US" ? "美国站 SOP 重量代理" : "非美国站按美国 SOP 费率名义估算",
      fbaPromoApplied: false,
    };
  }

  function parseDimensionsCm(value) {
    if (!value || value === "未知") return null;
    const matches = String(value).match(/\d+(?:\.\d+)?/g);
    if (!matches || matches.length < 3) return null;
    const dimensions = matches.slice(0, 3).map(Number);
    return dimensions.every((number) => Number.isFinite(number) && number > 0) ? dimensions : null;
  }

  function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function finiteOrNull(value) {
    return numberOrNull(value);
  }

  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }
}
