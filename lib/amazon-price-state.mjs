export const AMAZON_PRICE_PARSER_VERSION = 5;

export function hasManualAmazonPrice(product) {
  return product?.manualAmazonFields?.currentPrice === true || product?.manualAmazonOverride === true
    || product?.fieldSources?.currentPrice === "manual";
}

export function isAmazonPagePrice(product, analysisSourceMode = null) {
  return (product?.analysisSourceMode || analysisSourceMode) === "amazon_only"
    || product?.fieldSources?.currentPrice === "amazon_product_page";
}

export function hasFailedAmazonDetailAttempt(item = {}) {
  return ["failed", "error", "cancelled"].includes(item.detailStatus)
    || item.collectionLastAttempt?.status === "failed" || Boolean(item.lastCollectionError);
}

export function candidateCurrentPrice(item = {}) {
  // An explicit null means the page has no verified current offer. Never revive
  // it using a legacy price or a historical average.
  const value = Object.hasOwn(item, "currentPrice") ? item.currentPrice : item.price;
  return positivePrice(value);
}

// A cart gate or an unconfirmed delivery session does not prove no offer.
// Retained prices remain explicitly pending; they are not a fresh observation.
export function preserveUnconfirmedAmazonPrice(existing, incoming) {
  const reason = incoming.pageContextEvidence?.priceUnavailableReason;
  if (hasManualAmazonPrice(existing) || incoming.detailStatus !== "success"
    || incoming.currentPrice !== null
    || !["price_requires_cart", "delivery_region_unconfirmed"].includes(reason)) return false;
  const asin = String(existing.sourceAsin || existing.asin || "").toUpperCase();
  const currency = existing.currency || incoming.currency || ({ CA: "CAD", AU: "AUD", US: "USD", UK: "GBP", NL: "EUR",
    DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", PL: "PLN", MX: "MXN", BR: "BRL" })[existing.marketplace];
  const candidates = [
    { currentPrice: existing.currentPrice, priceEvidence: existing.priceEvidence,
      collectedAt: existing.priceVerifiedAt || existing.collectedAt,
      parserVersion: existing.detailParserVersion },
    existing.lastKnownAmazonPrice,
  ];
  const previous = candidates.find(candidate => {
    const evidence = candidate?.priceEvidence;
    return positivePrice(candidate?.currentPrice) !== null && !candidate?.invalidatedByNoOffer
      && Number(candidate?.parserVersion ?? existing.detailParserVersion ?? 0) >= AMAZON_PRICE_PARSER_VERSION
      && evidence?.asin?.toUpperCase() === asin && evidence.currency === currency
      && ["visible_main_price", "main_price_metadata", "matching_product_json_ld", "matching_product_attach_price"].includes(evidence.source)
      && evidence.rawText && evidence.selector
      && (evidence.value == null || Number(evidence.value) === Number(candidate.currentPrice))
      && Number.isFinite(Date.parse(candidate.collectedAt))
      && (!incoming.collectedAt || Date.parse(candidate.collectedAt) <= Date.parse(incoming.collectedAt));
  });
  existing.currentPrice = previous ? Number(previous.currentPrice) : null;
  existing.priceEvidence = previous ? structuredClone(previous.priceEvidence) : null;
  existing.priceVerifiedAt = previous?.collectedAt || null;
  existing.currentPriceStatus = "pending_revalidation";
  existing.priceRefresh = { status: "pending", reason, checkedAt: incoming.collectedAt || null,
    previousVerifiedAt: existing.priceVerifiedAt, retained: Boolean(previous),
    browser: incoming.priceReadAttempt ? structuredClone(incoming.priceReadAttempt) : null };
  if (previous) {
    existing.lastKnownAmazonPrice = { ...structuredClone(previous), currentPrice: Number(previous.currentPrice) };
    existing.fieldSources = { ...existing.fieldSources, currentPrice: "amazon_product_page" };
  } else clearAutomaticPriceSource(existing);
  // priceRevalidation tracks an obsolete-parser migration, not this visit.
  // Marking that migration pending makes a later discovery-only record erase
  // the retained quote. Keep its historical certification and separate audit.
  const verifiedParserVersion = Number(previous?.parserVersion ?? existing.detailParserVersion ?? 0);
  if (previous && existing.priceRevalidation && verifiedParserVersion >= Number(existing.priceRevalidation.requiredParserVersion)) {
    existing.priceRevalidation = { ...existing.priceRevalidation, status: "completed",
      verifiedParserVersion, completedAt: previous.collectedAt, errorCode: null };
  }
  if (existing.reviewStatus === "approved") existing.reviewStatus = "pending";
  return true;
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
  const failed = hasFailedAmazonDetailAttempt(incoming);
  if (incoming.detailStatus === "success" && !failed) {
    if (amazonPrice && preserveUnconfirmedAmazonPrice(existing, incoming)) return;
    const price = candidateCurrentPrice(incoming);
    if (amazonPrice && price === null && positivePrice(existing.currentPrice) !== null) {
      existing.lastKnownAmazonPrice = { currentPrice: existing.currentPrice, priceEvidence: existing.priceEvidence ?? null,
        collectedAt: existing.priceVerifiedAt || existing.collectedAt || null, parserVersion: existing.detailParserVersion,
        unavailableAt: incoming.collectedAt || now, invalidatedByNoOffer: true };
    }
    if (amazonPrice || price !== null || existing.currentPrice == null) existing.currentPrice = price;
    if (amazonPrice) {
      delete existing.priceRefresh;
      existing.priceVerifiedAt = price === null ? null : incoming.priceVerifiedAt || incoming.collectedAt || now;
      if (price === null && existing.lastKnownAmazonPrice) existing.lastKnownAmazonPrice.invalidatedByNoOffer = true;
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
    existing.currentPriceStatus = failed ? "refresh_failed" : "pending_revalidation";
    if (failed) {
      existing.priceRevalidation = {
        ...existing.priceRevalidation,
        status: "failed",
        errorCode: incoming.lastCollectionError?.code || incoming.collectionLastAttempt?.code || incoming.detailErrorCode || null,
      };
    }
  } else if (amazonPrice && failed) {
    existing.currentPriceStatus = "refresh_failed";
  }
}

export function mergeAmazonDetailAudit(existing, incoming) {
  const failed = hasFailedAmazonDetailAttempt(incoming);
  const success = incoming.detailStatus === "success" && !failed;
  const pendingPrice = ["pending", "failed"].includes(existing.priceRevalidation?.status);
  if (success || existing.detailStatus !== "success" || pendingPrice) {
    for (const field of ["detailStatus", "detailErrorCode", "detailError", "detailRetryable"]) {
      existing[field] = incoming[field];
    }
  }
  // Parser versions certify successful extraction only, never a failed attempt.
  if (success) {
    existing.detailParserVersion = incoming.detailParserVersion;
    delete existing.collectionLastAttempt;
    delete existing.lastCollectionError;
  } else if (failed) {
    // Retained successful values cannot certify page absence after a failed visit.
    const failure = incoming.lastCollectionError || incoming.collectionLastAttempt || {};
    existing.collectionLastAttempt = {
      status: "failed", code: failure.code || incoming.detailErrorCode || null,
      message: failure.message || incoming.detailError || null,
      retryable: (failure.retryable ?? incoming.detailRetryable) === true,
      checkedAt: failure.checkedAt || null,
      collectedAt: failure.collectedAt || failure.checkedAt || incoming.collectedAt || null,
    };
    // Normalize raw failures so an older marker cannot override the latest code.
    delete existing.lastCollectionError;
  }
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
