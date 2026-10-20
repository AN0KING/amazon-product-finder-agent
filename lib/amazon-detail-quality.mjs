import { AMAZON_PRICE_PARSER_VERSION } from "./amazon-price-state.mjs";
import { amazonWeightInformationState, usesItemWeightOnly, automaticPackageWeightKg } from "./profit-model.mjs";

export const AMAZON_DETAIL_QUALITY_VERSION = 5;
export const AMAZON_DETAIL_REQUIRED_FIELDS = Object.freeze(["price", "weight", "title", "image"]);

const CURRENCIES = Object.freeze({
  US: "USD", CA: "CAD", AU: "AUD", UK: "GBP", NL: "EUR", DE: "EUR",
  FR: "EUR", IT: "EUR", ES: "EUR", PL: "PLN", MX: "MXN", BR: "BRL",
});
const PRICE_SOURCES = new Set([
  "visible_main_price", "main_price_metadata", "matching_product_json_ld", "matching_product_attach_price",
]);
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const WEIGHT_FIELDS = [
  ["productWeightKg", "product"], ["productWeight", "product"],
];

export function usesItemWeightOnlyPolicy(item = {}) {
  return usesItemWeightOnly(item);
}

export function isItemWeightEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || evidence.kind === "package") return false;
  const label = String(evidence.label || "").normalize("NFKC").replace(/\p{Cf}/gu, "")
    .replace(/\s*[:：]\s*$/, "").trim();
  return /^item\s+weight$/i.test(label);
}

/**
 * Audit one collection result without changing it or filling absent fields.
 * `complete` means the four required fields are verified; ratings, reviews and
 * sales metrics are optional. Weight absence requires a complete same-ASIN
 * Product information inspection; a successful document alone is insufficient.
 * Fetch failures and incomplete verification remain distinct from absence.
 */
export function auditAmazonProductFields(product = {}, { marketplace, now = new Date() } = {}) {
  const item = product && typeof product === "object" ? product : {};
  const market = cleanText(marketplace ?? item.marketplace ?? item.sourceMarketplace)?.toUpperCase() || null;
  const asin = cleanText(item.sourceAsin ?? item.asin)?.toUpperCase() || null;
  const checkedAt = new Date(now).toISOString();
  const context = collectionContext(item);
  const fields = {
    price: auditPrice(item, context, market, asin),
    weight: auditWeight(item, context),
    title: auditSimpleField(item, context, ["title", "englishName"], (value) => cleanText(value), "invalid_title"),
    image: auditSimpleField(item, context, ["imageUrl"], validHttpUrl, "invalid_image_url"),
    rating: auditSimpleField(item, context, ["rating"], (value) => {
      const number = finiteNumber(value);
      return number !== null && number >= 0 && number <= 5 ? number : null;
    }, "rating_out_of_range"),
    reviews: auditSimpleField(item, context, ["reviewCount", "reviews"], (value) => {
      const number = finiteNumber(value);
      return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
    }, "invalid_review_count"),
    sales30: auditSalesField(item, context, "sales30", true),
    salesAmount30: auditSalesField(item, context, "salesAmount30", false),
  };
  const requiredMissing = AMAZON_DETAIL_REQUIRED_FIELDS.filter((name) => fields[name].status !== "verified");
  const retryableFields = Object.keys(fields).filter((name) => fields[name].retryable);
  const unavailableFields = Object.keys(fields).filter((name) => fields[name].status === "unavailable");
  const invalidFields = Object.keys(fields).filter((name) => fields[name].status === "invalid");
  const status = !requiredMissing.length ? "complete"
    : requiredMissing.some((name) => fields[name].retryable) ? "retryable"
      : context.failed ? "failed" : "partial";
  return {
    version: AMAZON_DETAIL_QUALITY_VERSION, marketplace: market, asin, checkedAt, status,
    fields, requiredMissing, retryableFields, unavailableFields, invalidFields,
  };
}

function collectionContext(item) {
  const status = cleanText(item.detailStatus)?.toLowerCase();
  const retainedFailure = item.collectionLastAttempt?.status === "failed" || Boolean(item.lastCollectionError);
  const errorCode = cleanText(item.detailErrorCode ?? item.error?.code ?? item.providerError?.code
    ?? item.lastCollectionError?.code ?? item.collectionLastAttempt?.code);
  const accessFailure = item.challenge === true || item.rateLimited === true || item.navigationError === true;
  const failed = accessFailure || retainedFailure || ["failed", "error", "cancelled"].includes(status)
    || (Boolean(errorCode) && status !== "success");
  const pending = ["pending", "loading", "running", "retrying"].includes(status);
  const retryable = failed
    ? item.detailRetryable ?? item.error?.retryable ?? item.providerError?.retryable
      ?? (accessFailure || /TIMEOUT|HTTP_(?:429|5\d\d)|REQUEST_FAILED|NAVIGATION_FAILED|ACCESS_CHALLENGE/i.test(errorCode || ""))
    : pending;
  return {
    failed, pending, retryable: retryable === true,
    successful: !failed && !pending && (status === "success" || item.explicitProduct === true),
    reason: failed ? "request_failed" : pending ? "not_collected" : null,
    errorCode,
  };
}

function auditPrice(item, context, marketplace, asin) {
  if (context.failed || context.pending) return absent(context, "currentPrice");
  if (["pending_revalidation", "refresh_failed"].includes(item.currentPriceStatus)
    || ["pending", "failed"].includes(item.priceRevalidation?.status)) {
    return field("missing", null, null, "price_revalidation_pending", true, { field: "currentPrice" });
  }
  if (isManual(item, "currentPrice")) return field("missing", null, "manual", "manual_value_not_collected", false, { field: "currentPrice" });
  if (isAbsent(item.currentPrice)) {
    const result = absent(context, "currentPrice");
    const reason = item.pageContextEvidence?.priceUnavailableReason;
    if (context.successful && ["price_requires_cart", "delivery_region_unconfirmed", "unavailable", "page_not_provided"].includes(reason)) {
      result.reason = reason;
      // price_requires_cart / delivery_region_unconfirmed are delivery-region
      // artifacts: the CDP-driven Edge channel re-visits with a confirmed
      // postcode and unlocks the hidden price, so they stay retryable.
      // "unavailable" (out of stock) and "page_not_provided" are page-truth
      // reasons that a re-visit cannot change.
      result.retryable = reason === "price_requires_cart" || reason === "delivery_region_unconfirmed";
    }
    return result;
  }
  const price = finiteNumber(item.currentPrice);
  if (price === null || price <= 0) return field("invalid", null, null, "price_not_positive", false, { field: "currentPrice" });
  if (item.currentPriceStatus === "unavailable") return field("invalid", null, null, "price_status_conflict", false, { field: "currentPrice" });
  if (!isAbsent(item.detailParserVersion) && finiteNumber(item.detailParserVersion) < AMAZON_PRICE_PARSER_VERSION) {
    return field("missing", null, null, "obsolete_price_parser", true, { field: "currentPrice" });
  }
  const evidence = item.priceEvidence;
  if (!evidence || typeof evidence !== "object") return field("missing", null, null, "price_evidence_missing", true, { field: "currentPrice" });
  const source = cleanText(evidence.source);
  if (!PRICE_SOURCES.has(source)) return field("invalid", null, source, "untrusted_price_source", false, { field: "currentPrice" });
  if (!CURRENCIES[marketplace]) return field("invalid", null, source, "unsupported_marketplace", false, { field: "currentPrice" });
  if (!asin || !ASIN_PATTERN.test(asin) || cleanText(evidence.asin)?.toUpperCase() !== asin) {
    return field("invalid", null, source, "price_asin_mismatch", false, { field: "currentPrice" });
  }
  if (cleanText(evidence.currency)?.toUpperCase() !== CURRENCIES[marketplace]
    || (cleanText(item.currency) && cleanText(item.currency).toUpperCase() !== CURRENCIES[marketplace])) {
    return field("invalid", null, source, "price_currency_mismatch", false, { field: "currentPrice" });
  }
  if (!cleanText(evidence.rawText) || !cleanText(evidence.selector)) return field("missing", null, source, "price_evidence_incomplete", true, { field: "currentPrice" });
  if (!isAbsent(evidence.value) && finiteNumber(evidence.value) !== price) return field("invalid", null, source, "price_evidence_value_mismatch", false, { field: "currentPrice" });
  return field("verified", price, source, "current_offer_evidence", false, {
    field: "currentPrice", currency: CURRENCIES[marketplace],
    evidence: { asin, currency: CURRENCIES[marketplace], source, selector: evidence.selector, rawText: evidence.rawText },
  });
}

function auditWeight(item, context) {
  if (context.failed || context.pending) return absent(context, "weight");
  const issues = [];
  for (const [name, kind] of WEIGHT_FIELDS) {
    if (isAbsent(item[name])) continue;
    const source = weightSource(item, name);
    if (isManual(item, name) || source === "manual") {
      issues.push({ field: name, status: "missing", source: "manual", reason: "manual_value_not_collected", retryable: false });
      continue;
    }
    const value = finiteNumber(item[name]);
    if (value === null || value <= 0) {
      issues.push({ field: name, status: "invalid", source, reason: "weight_not_positive", retryable: false });
      continue;
    }
    if (!source || /^(?:unknown|unverified|none)$/i.test(source)) {
      issues.push({ field: name, status: "missing", source: null, reason: "weight_source_missing", retryable: true });
      continue;
    }
    const evidence = item.productWeightEvidence;
    if (/package|shipping|dimensional|capacity/i.test(source)
      || (evidence && !isItemWeightEvidence(evidence))) {
      issues.push({ field: name, status: "invalid", source, reason: "not_item_weight", retryable: false });
      continue;
    }
    if (usesItemWeightOnlyPolicy(item) && (!isItemWeightEvidence(evidence) || evidence.kind !== "product"
      || !(finiteNumber(evidence.value) > 0))) {
      issues.push({ field: name, status: "missing", source, reason: "item_weight_evidence_missing", retryable: true });
      continue;
    }
    if (evidence && !isAbsent(evidence.value) && (finiteNumber(evidence.value) === null
      || Math.abs(finiteNumber(evidence.value) - value) > 1e-9)) {
      issues.push({ field: name, status: "invalid", source, reason: "item_weight_evidence_value_mismatch", retryable: false });
      continue;
    }
    return field("verified", value, source, "sourced_weight", false, {
      field: name, unit: "kg", kind,
      ...(evidence ? { evidence: { ...evidence } } : {}),
      ...(issues.length ? { issues } : {}),
    });
  }
  const packageWeight = automaticPackageWeightKg(item);
  if (packageWeight !== null && !["fbaWeight", "fbaPackageWeightKg", "packageWeightKg"].some(name => isManual(item, name))) {
    return field("verified", packageWeight, "amazon_product_page", "package_weight_fallback", false, {
      field: "packageWeightKg", unit: "kg", kind: "package", evidence: { ...item.packageWeightEvidence },
      ...(issues.length ? { issues } : {}),
    });
  }
  if (!issues.length) {
    if (!context.successful) return absent(context, "weight");
    const inspection = amazonWeightInformationState(item);
    if (inspection === "not_provided") return field("unavailable", null, "amazon_product_information", "page_not_provided", false, {
      field: "weight", evidence: { asin: item.productInformation.asin, version: item.productInformation.version,
        rowCount: item.productInformation.rowCount, weightStatus: "not_provided" },
    });
    return field("missing", null, null, `product_information_${inspection}`, true, { field: "weight" });
  }
  const issue = issues.find((entry) => entry.retryable) || issues.find((entry) => entry.status === "invalid") || issues[0];
  return field(issue.status, null, issue.source, issue.reason, issue.retryable, { field: issue.field, unit: "kg", issues });
}

function weightSource(item, name) {
  const aliases = name === "productWeight" ? [name, "productWeightKg"]
    : name === "fbaWeight" ? [name, "fbaPackageWeightKg", "packageWeightKg"]
      : name === "fbaPackageWeightKg" ? [name, "packageWeightKg"] : [name];
  return aliases.map((key) => cleanText(item.fieldSources?.[key])).find(Boolean) || null;
}

function auditSimpleField(item, context, names, validate, invalidReason) {
  const name = names.find((key) => Object.hasOwn(item, key)) || names[0];
  if (context.failed || context.pending) return absent(context, name);
  const source = cleanText(item.fieldSources?.[name]) || cleanText(item.sourceTool) || cleanText(item.dataSource);
  if (isManual(item, name)) return field("missing", null, "manual", "manual_value_not_collected", false, { field: name });
  if (isAbsent(item[name])) return absent(context, name);
  const value = validate(item[name]);
  return value === null ? field("invalid", null, source, invalidReason, false, { field: name })
    : field("verified", value, source, "present_and_valid", false, { field: name,
      ...(item[`${name}Evidence`] && typeof item[`${name}Evidence`] === "object" ? { evidence: { ...item[`${name}Evidence`] } } : {}),
    });
}

function auditSalesField(item, context, name, integer) {
  const result = auditSimpleField(item, context, [name], (value) => {
    const number = finiteNumber(value);
    return number !== null && number >= 0 && (!integer || Number.isSafeInteger(number)) ? number : null;
  }, integer ? "invalid_sales_count" : "invalid_sales_amount");
  // Optional sales fields never trigger another visit to a public product page.
  result.retryable = false;
  if (result.status !== "verified") return result;
  const source = cleanText(item.fieldSources?.[name]);
  if (!source || /^(?:unknown|unverified|none)$/i.test(source)) {
    return field("missing", null, null, "sales_source_missing", false, { field: name });
  }
  result.source = source;
  const evidence = item[`${name}Evidence`];
  if (evidence && typeof evidence === "object") {
    if (finiteNumber(evidence.value) !== result.value) {
      return field("invalid", null, source, "sales_evidence_value_mismatch", false, { field: name });
    }
    result.evidence = { ...evidence };
  }
  return result;
}

function absent(context, name) {
  return field(context.successful ? "unavailable" : "missing", null, null,
    context.reason || (context.successful ? "page_not_provided" : "not_collected"),
    context.retryable, { field: name, ...(context.errorCode ? { errorCode: context.errorCode } : {}) });
}

function field(status, value, source, reason, retryable, extra = {}) {
  return { status, value, source, reason, retryable, ...extra };
}

function isManual(item, name) {
  return item.manualAmazonOverride === true || item.manualAmazonFields?.[name] === true || item.fieldSources?.[name] === "manual";
}

function isAbsent(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() || null : null;
}

function validHttpUrl(value) {
  if (!cleanText(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
