import { MIN_IMAGE_SIMILARITY_SCORE } from "./image-similarity.mjs";

export const SUPPLIER_COST_RULE_VERSION = "1688-image-only-always-top6-trimmed-10-v6";
export const SUPPLIER_IMAGE_SIMILARITY_THRESHOLD = MIN_IMAGE_SIMILARITY_SCORE;
export const SUPPLIER_RELEVANCE_METHOD = "image-only-product-similarity";
export const SUPPLIER_RELEVANCE_VERSION = "image-only-always-top6-v1";
export const SUPPLIER_COST_MODE_VERIFIED = "verified_trimmed_10";
export const SUPPLIER_COST_MODE_FALLBACK = "low_confidence_top_6";
export const FALLBACK_SUPPLIER_COUNT = 6;

const MAX_ANALYSIS_QUOTES = 120;
const DEFAULT_SELECTOR_VERSION = "1688-procurement-assistant-2.3.0";

class SupplierPolicyError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "SupplierPolicyError";
    this.code = code;
    this.status = status;
  }
}

export function isImageSimilarityQualifiedQuote(value) {
  if (!value || typeof value !== "object") return false;
  const score = Number(value.imageSimilarityScore);
  return Number.isFinite(score)
    && score > MIN_IMAGE_SIMILARITY_SCORE
    && score <= 1
    && value.imageSimilarityDecision === "passed"
    && nonEmptyText(value.candidateImageUrl)
    && nonEmptyText(value.similarityMethod)
    && nonEmptyText(value.similarityVersion);
}

export function isSupplierMatchQualifiedQuote(value) {
  return isImageSimilarityQualifiedQuote(value) && value.supplierMatchDecision === "passed";
}

export function buildSupplierSearchResult(rawQuotes, {
  targetMoq,
  targetUnit = "件",
  searchedAt,
  selectorVersion = DEFAULT_SELECTOR_VERSION,
} = {}) {
  const normalizedMoq = Number(targetMoq);
  if (!Number.isFinite(normalizedMoq) || normalizedMoq <= 0) {
    throw new SupplierPolicyError("INVALID_TARGET_MOQ", "目标 MOQ 必须大于 0。");
  }
  const normalizedUnit = normalizeUnit(targetUnit);
  if (!normalizedUnit) throw new SupplierPolicyError("INVALID_TARGET_UNIT", "目标采购单位无效。");

  const source = Array.isArray(rawQuotes) ? rawQuotes.slice(0, MAX_ANALYSIS_QUOTES) : [];
  const rejected = [];
  const evaluated = [];
  const qualified = [];
  const imageQualifiedSuppliers = new Set();
  const similarityAudit = createSimilarityAudit();

  source.forEach((raw, index) => {
    const normalized = normalizeSupplierQuote(raw, {
      fallbackRank: index + 1,
      targetMoq: normalizedMoq,
      targetUnit: normalizedUnit,
    });
    if (!normalized.ok) {
      rejected.push({ ...normalized.audit, included: false, excludedReason: normalized.reason });
      return;
    }

    const quote = normalized.quote;
    const similarityAvailable = Number.isFinite(quote.imageSimilarityScore)
      && quote.candidateImageUrl
      && quote.similarityMethod
      && quote.similarityVersion;
    if (!similarityAvailable) {
      similarityAudit.unavailableCount += 1;
      quote.imageSimilarityDecision = "unavailable";
    } else {
      similarityAudit.evaluatedCount += 1;
      similarityAudit.imageEvaluatedCount += 1;
      quote.imageSimilarityDecision = quote.imageSimilarityScore > MIN_IMAGE_SIMILARITY_SCORE
        ? "passed"
        : "below_threshold";
    }
    if (quote.imageSimilarityDecision === "below_threshold") similarityAudit.belowThresholdCount += 1;
    if (quote.imageSimilarityDecision === "passed") {
      similarityAudit.imageQualifiedCandidateCount += 1;
      imageQualifiedSuppliers.add(normalized.identity);
    }

    quote.supplierMatchDecision = quote.imageSimilarityDecision === "passed"
      ? "passed"
      : quote.imageSimilarityDecision === "unavailable" ? "unavailable" : "failed";
    const rankedQuote = {
      ...quote,
      rawPriceText: normalized.audit.rawPriceText,
      productRelevanceScore: supplierImageSimilarityScore(quote),
      productRelevanceMethod: SUPPLIER_RELEVANCE_METHOD,
      productRelevanceVersion: SUPPLIER_RELEVANCE_VERSION,
    };
    const entry = { quote: rankedQuote, identity: normalized.identity, sourceIndex: index };
    evaluated.push(entry);
    if (quote.supplierMatchDecision === "passed") {
      similarityAudit.qualifiedCandidateCount += 1;
      qualified.push(entry);
    } else {
      rejected.push({
        ...rankedQuote,
        included: false,
        excludedReason: supplierSimilarityFailureReason(rankedQuote),
      });
    }
  });
  similarityAudit.imageQualifiedCount = imageQualifiedSuppliers.size;

  const qualifiedBySupplier = uniqueQuotesBySupplier(qualified, rejected);
  similarityAudit.qualifiedCount = qualifiedBySupplier.size;

  const fallbackBySupplier = new Map();
  evaluated
    .filter(({ quote }) => isLowConfidenceFallbackQuote(quote))
    .sort(compareQuoteEntries)
    .forEach(({ quote, identity }) => {
      const selected = fallbackBySupplier.get(identity);
      if (selected) mergeSearchEvidence(selected, quote);
      else fallbackBySupplier.set(identity, {
        ...quote,
        similarityRank: fallbackBySupplier.size + 1,
        rank: fallbackBySupplier.size + 1,
      });
    });
  similarityAudit.fallbackCandidateCount = fallbackBySupplier.size;

  const strictQuotes = [...qualifiedBySupplier.values()].slice(0, 10);
  const fallbackQuotes = [...fallbackBySupplier.values()].slice(0, FALLBACK_SUPPLIER_COUNT);
  let selectionMode = null;
  let costConfidence = null;
  let aggregated;
  if (strictQuotes.length === 10) {
    selectionMode = SUPPLIER_COST_MODE_VERIFIED;
    costConfidence = "high";
    aggregated = calculateTrimmedSupplierCost(strictQuotes);
  } else if (fallbackQuotes.length === FALLBACK_SUPPLIER_COUNT) {
    selectionMode = SUPPLIER_COST_MODE_FALLBACK;
    costConfidence = "low";
    aggregated = calculateTopSixSupplierCost(fallbackQuotes);
    similarityAudit.fallbackSelectedCount = FALLBACK_SUPPLIER_COUNT;
  } else {
    aggregated = calculateTopSixSupplierCost(fallbackQuotes);
  }

  const quotes = aggregated.quotes.map(({ rawPriceText: _rawPriceText, ...quote }) => quote);
  const selectedKeys = new Set(quotes.map(supplierQuoteKey));
  const outsideSelection = selectionMode === SUPPLIER_COST_MODE_VERIFIED
    ? [...qualifiedBySupplier.values()].slice(10).map((quote) => ({ ...quote, included: false, excludedReason: "outside_top_10" }))
    : [...fallbackBySupplier.values()].slice(FALLBACK_SUPPLIER_COUNT).map((quote) => ({ ...quote, included: false, excludedReason: "outside_top_6_fallback" }));
  const rejectedQuotes = rejected
    .concat(outsideSelection)
    .filter((quote) => Number.isFinite(Number(quote.unitPriceCny)) && quote.name)
    .filter((quote) => !selectedKeys.has(supplierQuoteKey(quote)))
    .sort(compareSupplierImageSimilarity)
    .map(({ rawPriceText: _rawPriceText, ...quote }) => quote);
  const status = selectionMode === SUPPLIER_COST_MODE_VERIFIED
    ? "complete"
    : selectionMode === SUPPLIER_COST_MODE_FALLBACK
      ? "fallback_estimate"
      : similarityAudit.belowThresholdCount > 0 || similarityAudit.unavailableCount > 0
        ? "similarity_insufficient"
        : "insufficient";

  return {
    status,
    searchedAt: searchedAt || new Date().toISOString(),
    quotes,
    rejectedQuotes,
    validCount: selectionMode === SUPPLIER_COST_MODE_VERIFIED
      ? strictQuotes.length
      : selectionMode === SUPPLIER_COST_MODE_FALLBACK ? fallbackQuotes.length : fallbackBySupplier.size,
    includedCount: aggregated.includedCount,
    averageCostCny: aggregated.averageCostCny,
    selectionMode,
    costConfidence,
    ruleVersion: SUPPLIER_COST_RULE_VERSION,
    selectorVersion,
    similarity: similarityAudit,
    audit: {
      target: { moq: normalizedMoq, unit: normalizedUnit },
      rawCandidateCount: source.length,
      similarity: similarityAudit,
      accepted: aggregated.quotes.map(quoteAudit),
      rejected: rejected.concat(outsideSelection),
      groups: aggregated.groups,
      selectionMode,
      costConfidence,
    },
  };
}

export function isLowConfidenceFallbackQuote(value) {
  if (!value || typeof value !== "object") return false;
  const offerUrl = normalize1688OfferUrl(value.url || value.offerUrl);
  const offerId = cleanIdentifier(value.offerId, 100) || offerIdFromUrl(offerUrl);
  if ([null, undefined, ""].includes(value.imageSimilarityScore)) return false;
  const imageScore = Number(value.imageSimilarityScore);
  return Number.isFinite(imageScore)
    && imageScore >= 0
    && imageScore <= 1
    && Number.isFinite(Number(value.unitPriceCny))
    && Number(value.unitPriceCny) > 0
    && nonEmptyText(value.supplierId)
    && Boolean(cleanText(value.name || value.supplierName, 300))
    && Boolean(offerUrl)
    && Boolean(offerId)
    && Boolean(firstPositiveNumber(value.moq, value.minimumOrder))
    && Boolean(normalizeUnit(value.unit));
}

export function calculateTopSixSupplierCost(inputQuotes) {
  const quotes = Array.isArray(inputQuotes)
    ? inputQuotes.slice(0, FALLBACK_SUPPLIER_COUNT).map((quote) => ({ ...quote }))
    : [];
  if (quotes.length < FALLBACK_SUPPLIER_COUNT) {
    return {
      status: "insufficient",
      quotes: quotes.map((quote) => ({
        ...quote,
        included: false,
        costSelectionDecision: "not_selected",
        excludedReason: "insufficient_fallback_quotes",
      })),
      includedCount: 0,
      averageCostCny: null,
      groups: { lowest: [], included: [], highest: [] },
    };
  }
  if (quotes.some((quote) => !isLowConfidenceFallbackQuote(quote))) {
    throw new SupplierPolicyError("INVALID_FALLBACK_QUOTE", "低匹配度估算要求 6 家报价都具备真实供应商、1688 商品链接、MOQ、单位和有效价格。");
  }
  if (new Set(quotes.map((quote) => quote.supplierId)).size !== FALLBACK_SUPPLIER_COUNT) {
    throw new SupplierPolicyError("DUPLICATE_FALLBACK_SUPPLIER", "低匹配度估算要求 6 家唯一供应商。");
  }

  const priceRanks = new Map(quotes
    .map((quote, index) => ({ quote, index }))
    .sort((left, right) => Number(left.quote.unitPriceCny) - Number(right.quote.unitPriceCny) || left.index - right.index)
    .map(({ index }, priceIndex) => [index, priceIndex + 1]));
  const decorated = quotes.map((quote, index) => ({
    ...quote,
    productRelevanceScore: supplierImageSimilarityScore(quote),
    productRelevanceMethod: SUPPLIER_RELEVANCE_METHOD,
    productRelevanceVersion: SUPPLIER_RELEVANCE_VERSION,
    priceRank: priceRanks.get(index),
    included: true,
    costSelectionDecision: "included_low_confidence",
    excludedReason: "included_top_six_fallback",
  }));
  return {
    status: "complete",
    quotes: decorated,
    includedCount: FALLBACK_SUPPLIER_COUNT,
    averageCostCny: roundMoney(decorated.reduce((sum, quote) => sum + Number(quote.unitPriceCny), 0) / FALLBACK_SUPPLIER_COUNT),
    groups: {
      lowest: [],
      included: decorated.map(groupQuote),
      highest: [],
    },
  };
}

export function calculateTrimmedSupplierCost(inputQuotes) {
  const quotes = Array.isArray(inputQuotes) ? inputQuotes.slice(0, 10).map((quote) => ({ ...quote })) : [];
  if (quotes.length < 10) {
    return {
      status: "insufficient",
      quotes: quotes.map((quote) => ({ ...quote, priceRank: null, included: false, excludedReason: "insufficient_valid_quotes" })),
      includedCount: 0,
      averageCostCny: null,
      groups: { lowest: [], included: [], highest: [] },
    };
  }
  if (quotes.some((quote) => !Number.isFinite(Number(quote.unitPriceCny)) || Number(quote.unitPriceCny) <= 0)) {
    throw new SupplierPolicyError("INVALID_SUPPLIER_PRICE", "供应商报价必须是大于 0 的人民币单价。");
  }

  const sorted = quotes.map((quote, index) => ({ quote, index }))
    .sort((left, right) => Number(left.quote.unitPriceCny) - Number(right.quote.unitPriceCny)
      || Number(left.quote.rank || 0) - Number(right.quote.rank || 0)
      || left.index - right.index);
  const lowest = sorted.slice(0, 2);
  const middle = sorted.slice(2, 8);
  const highest = sorted.slice(8, 10);
  const disposition = new Map();
  sorted.forEach(({ index }, priceIndex) => disposition.set(index, { priceRank: priceIndex + 1 }));
  lowest.forEach(({ index }) => Object.assign(disposition.get(index), { included: false, excludedReason: "trimmed_low_price" }));
  middle.forEach(({ index }) => Object.assign(disposition.get(index), { included: true, excludedReason: null }));
  highest.forEach(({ index }) => Object.assign(disposition.get(index), { included: false, excludedReason: "trimmed_high_price" }));
  return {
    status: "complete",
    quotes: quotes.map((quote, index) => ({ ...quote, ...disposition.get(index) })),
    includedCount: middle.length,
    averageCostCny: roundMoney(middle.reduce((sum, item) => sum + Number(item.quote.unitPriceCny), 0) / middle.length),
    groups: {
      lowest: lowest.map(({ quote }) => groupQuote(quote)),
      included: middle.map(({ quote }) => groupQuote(quote)),
      highest: highest.map(({ quote }) => groupQuote(quote)),
    },
  };
}

export function compareSupplierImageSimilarity(left, right) {
  const leftScore = numericSimilarityScore(left?.imageSimilarityScore, -1);
  const rightScore = numericSimilarityScore(right?.imageSimilarityScore, -1);
  if (leftScore !== rightScore) return rightScore - leftScore;
  return sourceRank(left) - sourceRank(right);
}

export function supplierImageSimilarityScore(value) {
  const score = value?.imageSimilarityScore;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

function createSimilarityAudit() {
  return {
    threshold: MIN_IMAGE_SIMILARITY_SCORE,
    operator: "gt",
    evaluatedCount: 0,
    imageEvaluatedCount: 0,
    imageQualifiedCandidateCount: 0,
    imageQualifiedCount: 0,
    qualifiedCandidateCount: 0,
    qualifiedCount: 0,
    belowThresholdCount: 0,
    unavailableCount: 0,
    fallbackCandidateCount: 0,
    fallbackSelectedCount: 0,
    rankingPriority: "image_similarity_desc_source_order",
    relevanceMethod: SUPPLIER_RELEVANCE_METHOD,
    relevanceVersion: SUPPLIER_RELEVANCE_VERSION,
  };
}

function uniqueQuotesBySupplier(entries, rejected) {
  const selected = new Map();
  [...entries].sort(compareQuoteEntries).forEach(({ quote, identity }) => {
    const existing = selected.get(identity);
    if (existing) {
      mergeSearchEvidence(existing, quote);
      rejected.push({ ...quote, included: false, excludedReason: "duplicate_supplier" });
      return;
    }
    selected.set(identity, {
      ...quote,
      searchRank: quote.rank,
      similarityRank: selected.size + 1,
      rank: selected.size + 1,
    });
  });
  return selected;
}

function normalizeSupplierQuote(raw, { fallbackRank, targetMoq, targetUnit }) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rank = positiveInteger(source.rank) || fallbackRank;
  const name = cleanText(source.name || source.supplierName, 300);
  const url = normalize1688OfferUrl(source.url || source.offerUrl);
  const offerId = cleanIdentifier(source.offerId, 100) || offerIdFromUrl(url);
  const supplierId = cleanIdentifier(source.supplierId || source.memberId, 160);
  const identity = supplierId || normalizeIdentity(name) || offerId;
  const rawPriceText = cleanText(source.rawPriceText || source.priceText || source.price, 240);
  const sourceUnit = normalizeUnit(source.unit || unitFromText(rawPriceText) || unitFromText(source.moqText));
  const sourceMoq = firstPositiveNumber(source.moq, source.minimumOrder, numberFromText(source.moqText));
  const tier = choosePriceTier(source.priceTiers, targetMoq, sourceUnit || targetUnit);
  const effectiveUnit = tier?.unit || sourceUnit || null;
  const unitPriceCny = tier?.price ?? singlePriceFromValue(source.unitPriceCny ?? source.price, rawPriceText);
  const candidateImageUrl = normalizeSupplierImageUrl(source.candidateImageUrl || source.imageUrl);
  const imageSimilarityScore = normalizeSimilarityScore(source.imageSimilarityScore ?? source.similarityScore);
  const similarityMethod = cleanText(source.similarityMethod, 120);
  const similarityVersion = cleanText(source.similarityVersion || source.similarityModelVersion, 160);
  const candidateTitle = cleanText(source.candidateTitle || source.spec, 500);
  const sourceImageSha256 = normalizeSha256(source.sourceImageSha256);
  const candidateImageSha256 = normalizeSha256(source.candidateImageSha256);
  const comparedAt = normalizeIsoTimestamp(source.comparedAt);
  const imageSimilarityErrorCode = cleanIdentifier(source.imageSimilarityErrorCode, 100);
  const sourceRankValue = positiveInteger(source.sourceRank) || rank;
  const sourceRanks = {};
  const providedImageRank = positiveInteger(source.sourceRanks?.image);
  if (providedImageRank) sourceRanks.image = providedImageRank;
  if (!sourceRanks.image) sourceRanks.image = sourceRankValue;
  const audit = {
    rank,
    supplierId,
    name,
    offerId,
    url,
    rawPriceText,
    sourceUnit: effectiveUnit,
    sourceMoq,
    candidateImageUrl,
    imageSimilarityScore,
    similarityMethod,
    similarityVersion,
    candidateTitle,
    sourceImageSha256,
    candidateImageSha256,
    comparedAt,
    imageSimilarityErrorCode,
    searchSource: "image",
    searchSources: ["image"],
    sourceRank: sourceRankValue,
    sourceRanks,
  };
  if (!name || !identity) return rejectedQuote("supplier_identity_missing", audit);
  if (!url || !offerId) return rejectedQuote("offer_url_invalid", audit);
  if (!effectiveUnit) return rejectedQuote("unit_unconfirmed", audit);
  if (effectiveUnit !== targetUnit) return rejectedQuote("unit_mismatch", audit);
  if (!sourceMoq && !tier) return rejectedQuote("moq_unconfirmed", audit);
  if (!tier && sourceMoq > targetMoq) return rejectedQuote("moq_too_high", audit);
  if (!Number.isFinite(unitPriceCny) || unitPriceCny <= 0) {
    return rejectedQuote(/\d\s*[-~至]\s*\d/.test(rawPriceText || "") ? "price_range_unresolved" : "price_invalid", audit);
  }
  return {
    ok: true,
    identity,
    audit,
    quote: {
      rank,
      supplierId: supplierId || identity,
      name,
      offerId,
      url,
      unitPriceCny: roundMoney(unitPriceCny),
      unit: targetUnit,
      moq: targetMoq,
      priceTier: tier?.label || `展示单价；起订量 ${sourceMoq}`,
      spec: cleanText(source.spec, 500),
      candidateTitle,
      factoryVerified: source.factoryVerified === true,
      candidateImageUrl,
      imageSimilarityScore,
      imageSimilarityDecision: null,
      similarityMethod,
      similarityVersion,
      sourceImageSha256,
      candidateImageSha256,
      comparedAt,
      imageSimilarityComponents: normalizeSimilarityComponents(source.imageSimilarityComponents),
      imageSimilarityErrorCode,
      supplierMatchDecision: null,
      searchSource: "image",
      searchSources: ["image"],
      sourceRank: sourceRankValue,
      sourceRanks,
    },
  };
}

function choosePriceTier(value, targetMoq, fallbackUnit) {
  if (!Array.isArray(value)) return null;
  const tiers = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const minimum = firstPositiveNumber(entry.minQty, entry.moq, entry.minimum);
    const maximum = firstPositiveNumber(entry.maxQty, entry.maximum) || Number.POSITIVE_INFINITY;
    const price = singlePriceFromValue(entry.unitPriceCny ?? entry.price, entry.priceText);
    const unit = normalizeUnit(entry.unit) || fallbackUnit;
    return minimum && price && unit ? [{ minimum, maximum, price, unit }] : [];
  }).sort((left, right) => left.minimum - right.minimum);
  const match = tiers.filter((tier) => tier.minimum <= targetMoq && targetMoq <= tier.maximum).at(-1);
  if (!match) return null;
  return {
    price: match.price,
    unit: match.unit,
    label: `${match.minimum}-${Number.isFinite(match.maximum) ? match.maximum : "以上"} ${match.unit}`,
  };
}

function normalize1688OfferUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !(host === "1688.com" || host.endsWith(".1688.com"))) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_) {
    return null;
  }
}

function normalizeSupplierImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    const allowed = ["alicdn.com", "1688.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed) return null;
    url.hash = "";
    return url.href;
  } catch (_) {
    return null;
  }
}

function normalizeUnit(value) {
  const text = cleanText(value, 80)?.toLowerCase().replace(/[\s/每]/g, "") || "";
  return new Map([
    ["件", "件"], ["个", "件"], ["只", "件"], ["支", "件"],
    ["piece", "件"], ["pieces", "件"], ["pc", "件"], ["pcs", "件"],
    ["套", "套"], ["set", "套"], ["sets", "套"], ["组", "组"],
    ["盒", "盒"], ["箱", "箱"], ["包", "包"], ["袋", "袋"],
  ]).get(text) || null;
}

function quoteAudit(quote) {
  return {
    rank: quote.rank,
    searchRank: quote.searchRank,
    similarityRank: quote.similarityRank,
    priceRank: quote.priceRank,
    supplierId: quote.supplierId,
    offerId: quote.offerId,
    unitPriceCny: quote.unitPriceCny,
    imageSimilarityScore: quote.imageSimilarityScore,
    imageSimilarityDecision: quote.imageSimilarityDecision,
    similarityMethod: quote.similarityMethod,
    similarityVersion: quote.similarityVersion,
    candidateTitle: quote.candidateTitle,
    supplierMatchDecision: quote.supplierMatchDecision,
    productRelevanceScore: quote.productRelevanceScore,
    productRelevanceMethod: quote.productRelevanceMethod,
    productRelevanceVersion: quote.productRelevanceVersion,
    costSelectionDecision: quote.costSelectionDecision,
    searchSources: quote.searchSources,
    sourceRanks: quote.sourceRanks,
    rawPriceText: quote.rawPriceText,
    included: quote.included,
    excludedReason: quote.excludedReason,
  };
}

function compareQuoteEntries(left, right) {
  return compareSupplierImageSimilarity(left.quote, right.quote) || left.sourceIndex - right.sourceIndex;
}

function supplierSimilarityFailureReason(quote) {
  return quote.imageSimilarityDecision === "below_threshold"
    ? "image_similarity_below_threshold"
    : "image_similarity_unavailable";
}

function supplierQuoteKey(quote) {
  return `${quote?.supplierId || ""}\u0000${quote?.offerId || ""}`;
}

function mergeSearchEvidence(target, source) {
  target.searchSources = [...new Set([...(target.searchSources || []), ...(source.searchSources || [])])];
  target.sourceRanks = { ...(target.sourceRanks || {}), ...(source.sourceRanks || {}) };
}

function groupQuote(quote) {
  return { rank: quote.rank, supplierId: quote.supplierId, unitPriceCny: Number(quote.unitPriceCny) };
}

function rejectedQuote(reason, audit) {
  return { ok: false, reason, audit };
}

function numericSimilarityScore(value, fallback) {
  const score = Number(value);
  return Number.isFinite(score) ? score : fallback;
}

function sourceRank(value) {
  return Number(value?.sourceRank || value?.searchRank || value?.rank || Number.MAX_SAFE_INTEGER);
}

function normalizeSimilarityScore(value) {
  if ([null, undefined, ""].includes(value)) return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

function normalizeSimilarityComponents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const key of ["perceptualHash", "differenceHash", "structuralSimilarity", "colorHistogram"]) {
    const score = normalizeSimilarityScore(value[key]);
    if (score !== null) normalized[key] = score;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeSha256(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function normalizeIsoTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const timestamp = new Date(text);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function unitFromText(value) {
  const match = (cleanText(value, 240) || "").match(/(?:\/|每)\s*(件|个|只|支|套|组|盒|箱|包|袋|pcs?|pieces?|sets?)/i);
  return match?.[1] || null;
}

function singlePriceFromValue(value, fallbackText = null) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = cleanText(fallbackText ?? value, 240);
  if (!text) return null;
  const numbers = text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g)
    ?.map((item) => Number(item.replace(/,/g, "")))
    .filter((item) => item > 0) || [];
  return numbers.length === 1 ? numbers[0] : null;
}

function numberFromText(value) {
  const match = cleanText(value, 160)?.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function offerIdFromUrl(value) {
  return String(value || "").match(/\/offer\/(\d+)\.html/i)?.[1] || null;
}

function cleanIdentifier(value, maximumLength) {
  const text = cleanText(value, maximumLength);
  return text && /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function normalizeIdentity(value) {
  return cleanText(value, 300)?.normalize("NFKC").toLowerCase().replace(/\s+/g, "") || null;
}

function cleanText(value, maximumLength) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ")
    : "";
  return text && text.length <= maximumLength ? text : null;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
