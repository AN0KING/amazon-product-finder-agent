import { amazonMonthlySalesValue } from "./amazon-sales-policy.mjs";

const ASIN = /^[A-Z0-9]{10}$/;

/** Resolve only evidence tied to this ASIN and marketplace; unknown is never zero. */
export function monthlySalesValue(product, options = {}) {
  return monthlySalesEvidence(product, options)?.value ?? null;
}

export function hasQualifyingMonthlySales(product, options = {}) {
  const value = monthlySalesValue(product, options);
  return value !== null && value >= 50;
}

/** Preserve the selected evidence so UI and exports label the same value/source. */
export function monthlySalesEvidence(product, { useSellerSprite } = {}) {
  if (!product || isManualSales(product)) return null;
  const enabled = typeof useSellerSprite === "boolean"
    ? useSellerSprite : product.analysisSourceMode === "amazon_sellsprite";
  const evidence = product.sales30Evidence;
  if (enabled && isSellerSpriteEvidence(product, evidence)) return evidence;
  if (evidence?.value === product.sales30 && amazonMonthlySalesValue(product) !== null) return evidence;
  // API enrichment keeps the original Amazon observation for source-off fallback.
  const amazonEvidence = product.amazonSales30Evidence;
  if (amazonEvidence && amazonMonthlySalesValue({ ...product, sales30: amazonEvidence.value, sales30Evidence: amazonEvidence }) !== null) return amazonEvidence;
  return null;
}

export function summarizeMonthlySalesCoverage(products = [], options = {}) {
  const result = { total: 0, verified: 0, qualified: 0, belowThreshold: 0, unknown: 0,
    pending: 0, failed: 0, pageUnavailable: 0, unverified: 0,
    bySource: { amazon: 0, sellerSprite: 0 } };
  for (const product of Array.isArray(products) ? products : []) {
    result.total += 1;
    const evidence = monthlySalesEvidence(product, options);
    if (evidence) {
      result.verified += 1;
      result[evidence.value >= 50 ? "qualified" : "belowThreshold"] += 1;
      result.bySource[evidence.source === "sellsprite_api" ? "sellerSprite" : "amazon"] += 1;
      continue;
    }
    result.unknown += 1;
    const detailStatus = String(product?.detailStatus || "").toLowerCase();
    const quality = product?.collectionQuality?.fields?.sales30;
    const sellerSpriteEnabled = typeof options?.useSellerSprite === "boolean"
      ? options.useSellerSprite : product?.analysisSourceMode === "amazon_sellsprite";
    const lookupFailed = sellerSpriteEnabled
      && ["failed", "invalid"].includes(String(product?.competitorLookupStatus || "").toLowerCase());
    // A queued/retrying record can retain the previous attempt audit. The current
    // task state takes precedence over that stale or placeholder failure reason.
    if (["pending", "loading", "running", "retrying", "queued"].includes(detailStatus)) result.pending += 1;
    else if (lookupFailed || ["failed", "error", "cancelled"].includes(detailStatus)
      || quality?.reason === "request_failed") result.failed += 1;
    else if (quality?.reason === "not_collected") result.pending += 1;
    else if (quality?.status === "unavailable") result.pageUnavailable += 1;
    else result.unverified += 1;
  }
  return result;
}

function isSellerSpriteEvidence(product, evidence) {
  if (!evidence || evidence.source !== "sellsprite_api"
    || evidence.sourceTool !== "competitor_lookup"
    || evidence.field !== "amzUnit"
    || evidence.scope !== "asin" || evidence.period !== "past_month"
    || evidence.kind !== "estimate"
    || !Number.isSafeInteger(evidence.value) || evidence.value < 0
    || evidence.value !== product.sales30) return false;
  const asin = upper(product.sourceAsin || product.asin);
  const marketplace = upper(product.sourceMarketplace || product.marketplace);
  return ASIN.test(asin) && upper(evidence.asin) === asin
    && /^[A-Z]{2}$/.test(marketplace)
    && (!product.marketplace || upper(product.marketplace) === marketplace)
    && (!product.providerMarketplace || upper(product.providerMarketplace) === marketplace)
    && upper(evidence.marketplace) === marketplace
    && upper(evidence.providerMarketplace) === marketplace;
}

function isManualSales(product) {
  const fields = product.manualAmazonFields;
  const hasFieldMask = fields !== null && typeof fields === "object" && !Array.isArray(fields);
  return fields?.sales30 === true || product.fieldSources?.sales30 === "manual"
    || (product.manualAmazonOverride === true && !hasFieldMask);
}

function upper(value) { return String(value || "").trim().toUpperCase(); }
