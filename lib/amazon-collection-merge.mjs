import { hasManualFulfillmentFee, resolveManualWeightOverride, automaticProfitWeightKg, profitWeightSourceLabel } from "./profit-model.mjs";
import { hasManualAmazonPrice, preserveUnconfirmedAmazonPrice } from "./amazon-price-state.mjs";
import { normalizeAmazonProductUrl } from "./amazon-store-client.mjs";
import { isItemWeightEvidence, usesItemWeightOnlyPolicy } from "./amazon-detail-quality.mjs";

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const DERIVED_FIELDS = [
  "targetCostCny", "thresholdCostCny", "supplierProfitable", "roughMargin",
  "margin", "profitValue", "totalCost", "profitCalculation",
];

// Projection is deliberately pure: API reads can expose durable collection
// results without altering the saved snapshot or the user's manual inputs.
export function mergeAmazonCollectionProducts(products = [], items = {}, context = {}) {
  const byAsin = new Map(Object.entries(items)
    .map(([key, item]) => [normalizeAsin(item?.asin || item?.sourceAsin || key), item])
    .filter(([asin, item]) => asin && item && typeof item === "object"));
  const existingAsins = new Set(products.flatMap((product) => [normalizeAsin(product?.sourceAsin), normalizeAsin(product?.asin)]).filter(Boolean));
  const merged = products.map((product) => {
    const asin = normalizeAsin(product?.sourceAsin || product?.asin);
    return mergeAmazonCollectionProduct(product, byAsin.get(asin));
  });
  for (const [asin, item] of byAsin) {
    if (existingAsins.has(asin)) continue;
    const created = createCollectionProduct(asin, item, context);
    if (created) merged.push(mergeAmazonCollectionProduct(created, item));
  }
  return merged;
}

export function mergeAmazonCollectionProduct(product, item) {
  if (!product || !item || product.analysisHandoff?.owner === "procurement") return product;
  const asin = normalizeAsin(product.sourceAsin || product.asin);
  const incomingAsin = normalizeAsin(item.sourceAsin || item.asin);
  if (!asin || (incomingAsin && incomingAsin !== asin)
    || (item.marketplace && product.marketplace && item.marketplace !== product.marketplace)) return product;
  const merged = structuredClone(product);
  merged.fieldSources = { ...(product.fieldSources || {}) };
  const manualWeight = hasManualWeight(product) || resolveManualWeightOverride(product) !== null;
  let decisionChanged = false;
  let weightChanged = false;

  const setField = (target, value, sourceField = target, { decision = false, weight = false } = {}) => {
    if (value === null || value === undefined || value === "" || isManualField(product, target, sourceField)) return;
    const changed = merged[target] !== value;
    merged[target] = value;
    if (item.fieldSources?.[sourceField]) merged.fieldSources[sourceField] = item.fieldSources[sourceField];
    decisionChanged ||= changed && decision;
    weightChanged ||= changed && weight;
  };
  const success = item.detailStatus === "success";
  if (success) {
    if (item.pageContextEvidence) merged.pageContextEvidence = structuredClone(item.pageContextEvidence);
    merged.priceReadAttempt = item.priceReadAttempt ? structuredClone(item.priceReadAttempt) : null;
    if (Object.hasOwn(item, "productInformation")) merged.productInformation = item.productInformation ? structuredClone(item.productInformation) : null;
    if (!isManualField(product, "amazonFirstAvailableDate", "amazonFirstAvailableDate")) {
      for (const field of ["amazonFirstAvailableDate", "amazonFirstAvailableDateStatus", "amazonFirstAvailableDateEvidence"]) {
        if (Object.hasOwn(item, field)) merged[field] = item[field] == null ? null : structuredClone(item[field]);
      }
      if (Object.hasOwn(item, "amazonFirstAvailableDateStatus")) {
        if (item.amazonFirstAvailableDateStatus === "found") merged.fieldSources.amazonFirstAvailableDate = "amazon_product_information";
        else delete merged.fieldSources.amazonFirstAvailableDate;
      }
    }
    if (typeof item.title === "string" && item.title.trim()) {
      setField("name", item.title.trim(), "title", { decision: true });
      setField("englishName", item.title.trim(), "title", { decision: true });
    }
    setField("rating", finiteNumber(item.rating, 0, 5));
    setField("reviews", finiteNumber(item.reviewCount ?? item.reviews, 0), "reviewCount");
    setField("sales30", finiteNumber(item.sales30, 0));
    if (item.sales30Evidence && !isManualField(product, "sales30", "sales30")) {
      merged.sales30Evidence = structuredClone(item.sales30Evidence);
    }
    if (typeof item.imageUrl === "string" && /^https?:\/\//i.test(item.imageUrl)) setField("imageUrl", item.imageUrl);
    const canonicalUrl = normalizeAmazonProductUrl(item.canonicalUrl, { marketplace: product.marketplace || item.marketplace, asin });
    if (canonicalUrl) setField("canonicalUrl", canonicalUrl);

    if (!manualWeight) {
      const strictWeight = usesItemWeightOnlyPolicy(item);
      const candidateWeight = positiveNumber(item.productWeightKg ?? item.weightKg);
      const productWeight = strictWeight && (!isItemWeightEvidence(item.productWeightEvidence)
        || item.productWeightEvidence?.kind !== "product"
        || positiveNumber(item.productWeightEvidence?.value) !== candidateWeight || hasKnownNonItemWeight(item)) ? null : candidateWeight;
      const packageWeight = positiveNumber(item.fbaPackageWeightKg ?? item.packageWeightKg);
      const oldNonItemWeight = hasKnownNonItemWeight(product);
      // Only a new, successful Item Weight-only parse can retire an older
      // automatic package/dimensions fallback. An access failure must retain
      // its earlier observations, and legacy sources without contrary evidence
      // are not erased merely because the latest response omitted a property.
      if (strictWeight && !item.lastCollectionError && item.collectionLastAttempt?.status !== "failed"
        && Object.hasOwn(item, "productWeightKg") && productWeight === null && oldNonItemWeight) {
        for (const field of ["productWeight", "productWeightKg", "weightKg", "billingWeight", "actualWeightKg"]) {
          if (Object.hasOwn(merged, field)) merged[field] = null;
          delete merged.fieldSources[field];
        }
        delete merged.productWeightEvidence;
        merged.weightSource = "商品重量缺失";
        if (merged.profitInputs && typeof merged.profitInputs === "object") {
          merged.profitInputs = { ...merged.profitInputs, actualWeightKg: null, weightSource: "商品重量缺失" };
        }
        decisionChanged = true; weightChanged = true;
      }
      setField("productWeight", productWeight, "productWeightKg", { decision: true, weight: true });
      if (strictWeight && productWeight !== null) {
        // Historical snapshots may contain raw aliases beside the normalized
        // productWeight. Keep an old alias from masking a newly verified value.
        for (const alias of ["productWeightKg", "weightKg"]) {
          if (Object.hasOwn(merged, alias)) setField(alias, productWeight, "productWeightKg", { decision: true, weight: true });
        }
      }
      setField("fbaWeight", packageWeight, "fbaPackageWeightKg", { decision: true, weight: true });
      if (productWeight !== null && item.productWeightEvidence) merged.productWeightEvidence = structuredClone(item.productWeightEvidence);
      if (strictWeight && productWeight !== null && oldNonItemWeight) {
        decisionChanged = true; weightChanged = true;
      }
      if (packageWeight !== null && item.packageWeightEvidence) merged.packageWeightEvidence = structuredClone(item.packageWeightEvidence);
      if (weightChanged && automaticProfitWeightKg(merged) !== null) {
        merged.billingWeight = automaticProfitWeightKg(merged);
        merged.weightSource = profitWeightSourceLabel(merged);
      }
    }

    if (hasManualAmazonPrice(product)) {
      merged.currentPriceStatus = "manual";
      merged.fieldSources.currentPrice = "manual";
    } else if (Object.hasOwn(item, "currentPrice")) {
      const currentPrice = positiveNumber(item.currentPrice);
      const evidenceMatches = !item.priceEvidence
        || ((!item.priceEvidence.asin || normalizeAsin(item.priceEvidence.asin) === asin)
          && (!item.priceEvidence.currency || !product.currency || item.priceEvidence.currency === product.currency));
      // A successful page explicitly without an offer cannot leave an earlier
      // automatic price displayed as the current offer.
      if (preserveUnconfirmedAmazonPrice(merged, item)) {
        decisionChanged ||= merged.currentPrice !== product.currentPrice || product.currentPriceStatus !== "pending_revalidation";
      } else if (item.currentPrice === null || (currentPrice !== null && evidenceMatches)) {
        delete merged.priceRefresh;
        decisionChanged ||= merged.currentPrice !== currentPrice;
        if (currentPrice === null && positiveNumber(merged.currentPrice) !== null) {
          merged.lastKnownAmazonPrice = {
            currentPrice: merged.currentPrice, priceEvidence: merged.priceEvidence ?? null,
            collectedAt: merged.priceVerifiedAt || merged.collectedAt || null, unavailableAt: item.collectedAt || null,
            parserVersion: merged.detailParserVersion, invalidatedByNoOffer: true,
          };
        }
        merged.currentPrice = currentPrice;
        merged.priceEvidence = currentPrice === null ? null : (item.priceEvidence ?? null);
        merged.currentPriceStatus = currentPrice === null ? "unavailable" : "verified";
        merged.priceVerifiedAt = currentPrice === null ? null : item.priceVerifiedAt || item.collectedAt || null;
        if (currentPrice === null && merged.lastKnownAmazonPrice) merged.lastKnownAmazonPrice.invalidatedByNoOffer = true;
        if (currentPrice === null && !product.manualSalePrice) decisionChanged = true;
        if (currentPrice === null) delete merged.fieldSources.currentPrice;
        else merged.fieldSources.currentPrice = item.fieldSources?.currentPrice || "amazon_product_page";
        if (merged.priceRevalidation) {
          merged.priceRevalidation = {
            ...merged.priceRevalidation, status: "completed",
            verifiedParserVersion: item.detailParserVersion ?? merged.detailParserVersion,
            completedAt: item.collectedAt || merged.priceRevalidation.completedAt || null, errorCode: null,
          };
        }
      }
    }
    for (const field of ["detailStatus", "detailErrorCode", "detailError", "detailRetryable", "detailParserVersion", "collectedAt", "dataSource"]) {
      if (Object.hasOwn(item, field)) merged[field] = item[field];
    }
  } else {
    // Failed refreshes retain earlier successful fields and parser provenance.
    // Their failure remains visible independently of those retained values.
    merged.collectionLastAttempt = {
      status: item.detailStatus || "pending", code: item.detailErrorCode || null,
      message: item.detailError || null, retryable: item.detailRetryable === true,
      collectedAt: item.collectedAt || null,
    };
    if (product.detailStatus !== "success") {
      for (const field of ["detailStatus", "detailErrorCode", "detailError", "detailRetryable"]) {
        if (Object.hasOwn(item, field)) merged[field] = item[field];
      }
    }
  }
  if (success) delete merged.collectionLastAttempt;
  if (item.lastCollectionError && typeof item.lastCollectionError === "object") {
    // The runner can retain the last successful raw result while recording a
    // newer transport failure separately; that failure must remain visible.
    merged.collectionLastAttempt = {
      status: "failed", code: item.lastCollectionError.code || null,
      message: item.lastCollectionError.message || null,
      checkedAt: item.lastCollectionError.checkedAt || null,
      collectedAt: item.lastCollectionError.checkedAt || null,
    };
  }
  if (merged.collectionLastAttempt?.status === "failed" && !hasManualAmazonPrice(product)) {
    merged.currentPriceStatus = "refresh_failed";
  }
  if (item.fieldAudit && typeof item.fieldAudit === "object" && !Array.isArray(item.fieldAudit)) {
    merged.fieldAudit = { ...(merged.fieldAudit || {}) };
    for (const [field, audit] of Object.entries(item.fieldAudit)) {
      if (!isManualField(product, field, field)
        && !(manualWeight && /weight/i.test(field))
        && !(field === "currentPrice" && hasManualAmazonPrice(product))) merged.fieldAudit[field] = structuredClone(audit);
    }
  }
  if (item.collectionQuality && typeof item.collectionQuality === "object") merged.collectionQuality = structuredClone(item.collectionQuality);
  if (item.collectionRecovery && typeof item.collectionRecovery === "object") {
    merged.collectionRecovery = structuredClone(item.collectionRecovery);
  } else {
    delete merged.collectionRecovery;
  }

  if (!product.manualSalePrice && success && Object.hasOwn(item, "currentPrice") && !hasManualAmazonPrice(product)) {
    const nextSalePrice = positiveNumber(merged.currentPrice) === null ? null : Math.round(merged.currentPrice * 100) / 100;
    decisionChanged ||= merged.salePrice !== nextSalePrice;
    merged.salePrice = nextSalePrice;
  }
  if (decisionChanged) {
    for (const field of DERIVED_FIELDS) merged[field] = null;
    if (!hasManualFulfillmentFee(merged, "FBA") && (weightChanged || merged.currentPrice !== product.currentPrice)) {
      merged.fbaFee = null;
      merged.fbaEstimate = null;
      merged.fbaFeeSource = null;
      delete merged.fieldSources.fbaFee;
    }
    merged.complete = false;
    if (merged.reviewStatus === "approved") merged.reviewStatus = "pending";
  }
  return merged;
}

function createCollectionProduct(asin, item, context) {
  const marketplace = String(item.marketplace || context.marketplace || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(marketplace) || (context.marketplace && context.marketplace !== marketplace)) return null;
  const sourceStore = item.sourceStores?.[0] || {};
  return {
    id: `${marketplace}:${asin}`, asin, sourceAsin: asin, sourceAsins: [asin],
    parentAsin: item.parentAsin || null, parentResolved: item.parentResolved === true,
    marketplace, marketplaceId: context.marketplaceId || item.marketplaceId || null,
    currency: context.currency || item.currency || item.priceEvidence?.currency || null,
    amazonDomain: context.amazonDomain || item.amazonDomain || null,
    sourceMarketplace: marketplace, providerMarketplace: null, providerMode: null,
    analysisSourceMode: "amazon_only", dataMode: "live",
    sellerId: item.sellerId || sourceStore.sellerId || null,
    storeName: item.sellerName || sourceStore.sellerName || null,
    sourceStores: Array.isArray(item.sourceStores) ? structuredClone(item.sourceStores) : [],
    name: `Amazon 商品 ${asin}`, englishName: "", translatedTitleZh: null,
    currentPrice: null, priceEvidence: null, currentPriceStatus: "pending_revalidation", price30: null, salePrice: null,
    sales30: null, sales60: null, rating: null, reviews: null, imageUrl: null, canonicalUrl: null,
    productWeight: null, fbaWeight: null, billingWeight: null, weightSource: "商品重量缺失",
    productDimensions: null, fbaDimensions: null, parameterSource: "参数缺失",
    fulfillment: null, fulfillmentMode: null, fulfillmentModeSource: null,
    fbaFee: null, fbaFeeSource: null, fbaEstimate: null, fbmFee: null,
    purchaseCost: null, purchaseUnitCostCny: null, pieceCount: null, pieceCountSource: null,
    manualSalePrice: false, manualFbaFee: false, manualFbmFee: false, manualPurchaseCost: false,
    suppliers: [], supplierSource: null, supplierSearchStatus: "not_started", rematchCount: 0,
    supplierSearchError: null, supplierSearchErrorCode: null,
    targetCostCny: null, thresholdCostCny: null, supplierAverageCny: null, supplierProfitable: null, roughMargin: null,
    complete: false, missing: [], amazonMissing: [], margin: null, profitValue: null, totalCost: null, profitCalculation: null,
    reviewStatus: "pending", fieldSources: {},
    detailStatus: "pending", detailRetryable: true, detailParserVersion: null,
    detailErrorCode: "AMAZON_DETAIL_PENDING", detailError: "Amazon 商品详情等待抓取。",
    collectedAt: item.collectedAt || null, dataSource: item.dataSource || "amazon-store-checkpoint",
    visualIcon: "package", visualTone: "visual-mint", risk: "实时数据待初审",
    filterMatch: item.filterMatch !== false, filterExclusionReasons: item.filterExclusionReasons || [],
  };
}

function hasManualWeight(product) {
  return (product.manualAmazonOverride === true && !product.manualAmazonFields)
    || product.manualWeight === true || product.manualProductWeight === true || product.manualFbaWeight === true
    || product.manualBillingWeight === true
    || [product.profitInputs?.weightSource, product.weightSource]
      .some((source) => /(?:manual|人工|手工)/i.test(String(source || "")))
    || ["weight", "weightKg", "productWeightKg", "productWeight", "fbaPackageWeightKg", "fbaWeight", "billingWeight"]
      .some((field) => isManualField(product, field, field));
}

function hasKnownNonItemWeight(product) {
  const evidence = product.productWeightEvidence;
  return [product.fieldSources?.productWeightKg, product.fieldSources?.productWeight, product.weightSource]
    .some(source => /package|shipping|dimensional|capacity|包装|包裹|承载/i.test(String(source || "")))
    || Boolean(evidence && !isItemWeightEvidence(evidence));
}

function isManualField(product, field, sourceField) {
  const aliases = { name: "title", englishName: "title", reviewCount: "reviews" };
  return [field, sourceField, aliases[field], aliases[sourceField]].filter(Boolean)
    .some((key) => product.manualAmazonFields?.[key] === true || product.fieldSources?.[key] === "manual");
}

function normalizeAsin(value) {
  const asin = String(value || "").trim().toUpperCase();
  return ASIN_PATTERN.test(asin) ? asin : null;
}

function finiteNumber(value, minimum = -Infinity, maximum = Infinity) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value, 0);
  return number !== null && number > 0 ? number : null;
}
