export const AMAZON_PRICE_PARSER_VERSION = 5;

export function hasManualAmazonPrice(product) {
  return product?.manualAmazonFields?.currentPrice === true || product?.manualAmazonOverride === true
    || product?.fieldSources?.currentPrice === "manual";
}

export function isAmazonPagePrice(product, analysisSourceMode = null) {
  return (product?.analysisSourceMode || analysisSourceMode) === "amazon_only"
    || product?.fieldSources?.currentPrice === "amazon_product_page";
}

export function candidateCurrentPrice(item = {}) {
  // An explicit null means the page has no verified current offer. Never revive
  // it using a legacy price or a historical average.
  const value = Object.hasOwn(item, "currentPrice") ? item.currentPrice : item.price;
  return positivePrice(value);
}

export function invalidateLegacyAmazonPrice(product, {
  analysisSourceMode = null,
  parserVersion = AMAZON_PRICE_PARSER_VERSION,
  now = new Date().toISOString(),
} = {}) {
  if (!product || hasManualAmazonPrice(product) || !isAmazonPagePrice(product, analysisSourceMode)
    || Number(product.detailParserVersion || 0) >= parserVersion) return false;
  if (product.priceRevalidation?.requiredParserVersion === parserVersion) {
    // A restored checkpoint may contain an obsolete fallback price. Keep the
    // original audit while enforcing its pending verification state.
    const changed = product.currentPrice !== null || product.reviewStatus === "approved"
      || !["pending_revalidation", "refresh_failed"].includes(product.currentPriceStatus);
    product.currentPrice = null;
    product.priceEvidence = null;
    clearAutomaticPriceSource(product);
    product.priceRevalidation.status = product.priceRevalidation.status === "failed" ? "failed" : "pending";
    product.currentPriceStatus = product.priceRevalidation.status === "failed" ? "refresh_failed" : "pending_revalidation";
    if (product.reviewStatus === "approved") product.reviewStatus = "pending";
    return changed;
  }
  product.priceRevalidation = {
    status: "pending",
    previousCurrentPrice: positivePrice(product.currentPrice),
    previousPrice30: positivePrice(product.price30),
    previousParserVersion: Number(product.detailParserVersion || 0),
    previousFieldSource: product.fieldSources?.currentPrice ?? null,
    previousEvidence: product.priceEvidence ?? null,
    requiredParserVersion: parserVersion,
    invalidatedAt: now,
  };
  product.currentPrice = null;
  product.priceEvidence = null;
  clearAutomaticPriceSource(product);
  product.currentPriceStatus = "pending_revalidation";
  if (product.reviewStatus === "approved") product.reviewStatus = "pending";
  return true;
}

export function mergeAmazonPriceState(existing, incoming, {
  analysisSourceMode = null,
  parserVersion = AMAZON_PRICE_PARSER_VERSION,
  now = new Date().toISOString(),
} = {}) {
  if (hasManualAmazonPrice(existing)) {
    existing.currentPriceStatus = "manual";
    existing.fieldSources = { ...(existing.fieldSources || {}), currentPrice: "manual" };
    if (existing.priceRevalidation) existing.priceRevalidation.status = "manual";
    return;
  }
  const amazonPrice = isAmazonPagePrice(incoming, analysisSourceMode)
    || isAmazonPagePrice(existing, analysisSourceMode);
  if (incoming.detailStatus === "success") {
    const price = candidateCurrentPrice(incoming);
    if (amazonPrice || price !== null || existing.currentPrice == null) existing.currentPrice = price;
    if (amazonPrice) {
      existing.priceEvidence = incoming.priceEvidence ?? null;
      existing.currentPriceStatus = price === null ? "unavailable" : "verified";
      if (price === null) clearAutomaticPriceSource(existing);
      else existing.fieldSources = { ...(existing.fieldSources || {}), currentPrice: incoming.fieldSources?.currentPrice || "amazon_product_page" };
      if (existing.priceRevalidation) {
        existing.priceRevalidation = {
          ...existing.priceRevalidation,
          status: "completed",
          verifiedParserVersion: Number(incoming.detailParserVersion || 0),
          completedAt: now,
          errorCode: null,
        };
      }
      // A successful response from an obsolete parser is still untrusted.
      if (Number(incoming.detailParserVersion || 0) < parserVersion) {
        existing.currentPrice = null;
        existing.priceEvidence = null;
        clearAutomaticPriceSource(existing);
        existing.currentPriceStatus = "pending_revalidation";
        if (existing.priceRevalidation) existing.priceRevalidation.status = "pending";
      }
    }
  } else if (amazonPrice && ["pending", "failed"].includes(existing.priceRevalidation?.status)) {
    existing.currentPrice = null;
    existing.priceEvidence = null;
    clearAutomaticPriceSource(existing);
    const failed = incoming.detailStatus === "failed";
    existing.currentPriceStatus = failed ? "refresh_failed" : "pending_revalidation";
    if (failed) {
      existing.priceRevalidation = {
        ...existing.priceRevalidation,
        status: "failed",
        errorCode: incoming.detailErrorCode || null,
      };
    }
  }
}

export function mergeAmazonDetailAudit(existing, incoming) {
  const success = incoming.detailStatus === "success";
  const pendingPrice = ["pending", "failed"].includes(existing.priceRevalidation?.status);
  if (success || existing.detailStatus !== "success" || pendingPrice) {
    for (const field of ["detailStatus", "detailErrorCode", "detailError", "detailRetryable"]) {
      existing[field] = incoming[field];
    }
  }
  // Parser versions certify successful extraction only, never a failed attempt.
  if (success) existing.detailParserVersion = incoming.detailParserVersion;
}

function positivePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clearAutomaticPriceSource(product) {
  if (!product.fieldSources || !Object.hasOwn(product.fieldSources, "currentPrice")) return;
  product.fieldSources = { ...product.fieldSources };
  delete product.fieldSources.currentPrice;
}
