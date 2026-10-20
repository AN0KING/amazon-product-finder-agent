// Shared by the browser, collector and export audit. Empty bounds are unlimited.
function countBound(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    value = value.normalize("NFKC").trim();
    if (!value) return null;
    if (!/^\d+$/.test(value)) throw new RangeError(`${name}需要填写非负整数。`);
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name}需要填写非负安全整数。`);
  }
  return value;
}

export function normalizeReviewRange(criteria = {}) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) throw new RangeError("评价区间格式无效。");
  const minReviews = countBound(criteria.minReviews, "最小评价数");
  const maxReviews = countBound(criteria.maxReviews, "最大评价数");
  if (minReviews !== null && maxReviews !== null && minReviews > maxReviews) {
    throw new RangeError("最小评价数不能大于最大评价数。");
  }
  return { minReviews, maxReviews };
}

export function reviewRangeExclusionReasons(value, criteria = {}) {
  const { minReviews, maxReviews } = normalizeReviewRange(criteria);
  if (minReviews === null && maxReviews === null) return [];
  let count;
  try { count = countBound(value, "商品评价数"); } catch { count = null; }
  if (count === null) return ["REVIEWS_MISSING"];
  if (minReviews !== null && count < minReviews) return ["REVIEWS_BELOW_MINIMUM"];
  if (maxReviews !== null && count > maxReviews) return ["REVIEWS_ABOVE_MAXIMUM"];
  return [];
}

// Imported store rules and the user's current range must both hold.
export function intersectReviewRanges(current = {}, imported = {}) {
  const a = normalizeReviewRange(current), b = normalizeReviewRange(imported);
  const minima = [a.minReviews, b.minReviews].filter(value => value !== null);
  const maxima = [a.maxReviews, b.maxReviews].filter(value => value !== null);
  const minReviews = minima.length ? Math.max(...minima) : null;
  const maxReviews = maxima.length ? Math.min(...maxima) : null;
  return minReviews !== null && maxReviews !== null && minReviews > maxReviews
    ? { minReviews: null, maxReviews: null, importBlocked: true }
    : { minReviews, maxReviews };
}
