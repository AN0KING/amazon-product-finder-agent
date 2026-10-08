import test from "node:test";
import assert from "node:assert/strict";
import { auditAmazonProductFields } from "../lib/amazon-detail-quality.mjs";
import { parseAmazonProductPage } from "../lib/amazon-store-client.mjs";

const now = "2026-09-24T01:02:03.000Z";
const asin = "B0FP55F3Q9";
function product(overrides = {}) {
  return {
    marketplace: "CA", asin, detailStatus: "success", detailParserVersion: 5,
    title: "Car Armrest Storage Box Mat", imageUrl: "https://m.media-amazon.com/images/I/example.jpg",
    currentPrice: 9.99, productWeightKg: 0.06, rating: 4.1, reviewCount: 22,
    sourceTool: "amazon_product_page",
    fieldSources: { currentPrice: "amazon_product_page", productWeightKg: "amazon_product_page" },
    priceEvidence: { source: "visible_main_price", asin, currency: "CAD", rawText: "$9.99", selector: "#corePriceDisplay_desktop_feature_div .priceToPay" },
    ...overrides,
  };
}
const audit = (value, options = {}) => auditAmazonProductFields(value, { now, ...options });

test("a complete collected product verifies each field and preserves the input", () => {
  const input = product();
  const before = structuredClone(input);
  const result = audit(input);
  assert.equal(result.status, "complete");
  assert.equal(result.checkedAt, now);
  assert.equal(result.marketplace, "CA");
  assert.equal(result.asin, asin);
  assert.deepEqual(result.requiredMissing, []);
  assert.deepEqual(result.retryableFields, []);
  assert.ok(["price", "weight", "title", "image", "rating", "reviews"].every((name) => result.fields[name].status === "verified"));
  assert.ok(["sales30", "salesAmount30"].every((name) => result.fields[name].status === "unavailable"));
  assert.equal(result.fields.price.value, 9.99);
  assert.equal(result.fields.weight.value, 0.06);
  assert.equal(result.fields.weight.unit, "kg");
  assert.deepEqual(input, before);
});

test("a successful page without price or weight reports absence, not zeros or retryable transport failure", () => {
  const result = audit(product({ currentPrice: null, price: 279, price30: 299, averagePrice30: 299, priceEvidence: null, productWeightKg: null }));
  assert.equal(result.status, "partial");
  assert.deepEqual(result.requiredMissing, ["price", "weight"]);
  for (const name of ["price", "weight"]) {
    assert.equal(result.fields[name].value, null);
    assert.equal(result.fields[name].status, "unavailable");
    assert.equal(result.fields[name].reason, "page_not_provided");
    assert.equal(result.fields[name].retryable, false);
  }
  assert.deepEqual(result.retryableFields, []);
});

test("an entirely absent product differs from a completed page with no fields", () => {
  const pending = audit({});
  const unavailable = audit({ detailStatus: "success" });
  assert.deepEqual(pending.requiredMissing, ["price", "weight", "title", "image"]);
  assert.ok(Object.values(pending.fields).every((field) => field.status === "missing" && field.value === null));
  assert.ok(Object.values(unavailable.fields).every((field) => field.status === "unavailable" && field.value === null));
  assert.deepEqual(unavailable.retryableFields, []);
});

test("transient failures never certify stale retained values, and expose retryability", () => {
  const result = audit(product({ detailStatus: "failed", detailErrorCode: "AMAZON_HTTP_429", detailRetryable: true }));
  assert.equal(result.status, "retryable");
  assert.ok(Object.values(result.fields).every((field) => field.status === "missing" && field.reason === "request_failed"));
  assert.ok(["price", "weight", "title", "image", "rating", "reviews"].every((name) => result.fields[name].retryable));
  assert.ok(["sales30", "salesAmount30"].every((name) => !result.fields[name].retryable));
  assert.ok(Object.values(result.fields).every((field) => field.value === null));
  assert.equal(result.fields.price.errorCode, "AMAZON_HTTP_429");
  const permanent = audit(product({ detailStatus: "failed", detailErrorCode: "INVALID_ASIN", detailRetryable: false }));
  assert.equal(permanent.status, "failed");
  assert.deepEqual(permanent.retryableFields, []);
});

test("raw access challenge and pending results remain retryable without assuming page absence", () => {
  for (const overrides of [{ challenge: true }, { rateLimited: true }, { navigationError: true }, { detailStatus: "pending" }]) {
    const result = audit(product(overrides));
    assert.equal(result.status, "retryable");
    assert.equal(result.fields.price.status, "missing");
    assert.notEqual(result.fields.price.reason, "page_not_provided");
  }
});

test("price evidence must refer to the same ASIN and the requested marketplace currency", () => {
  for (const [evidence, reason] of [
    [{ ...product().priceEvidence, asin: "B012345678" }, "price_asin_mismatch"],
    [{ ...product().priceEvidence, asin: null }, "price_asin_mismatch"],
    [{ ...product().priceEvidence, currency: "USD" }, "price_currency_mismatch"],
    [{ ...product().priceEvidence, source: "recommendation_card" }, "untrusted_price_source"],
  ]) {
    const result = audit(product({ priceEvidence: evidence }));
    assert.equal(result.fields.price.status, "invalid");
    assert.equal(result.fields.price.reason, reason);
    assert.equal(result.fields.price.value, null);
  }
  assert.equal(audit(product({ currency: "USD" })).fields.price.reason, "price_currency_mismatch");
  assert.equal(audit(product(), { marketplace: "US" }).fields.price.reason, "price_currency_mismatch");
  assert.equal(audit(product({ asin: "B012345678", sourceAsin: asin })).fields.price.status, "verified");
});

test("missing evidence and obsolete parser output need revalidation instead of being certified", () => {
  assert.equal(audit(product({ priceEvidence: null })).fields.price.reason, "price_evidence_missing");
  assert.equal(audit(product({ priceEvidence: { ...product().priceEvidence, rawText: " " } })).fields.price.reason, "price_evidence_incomplete");
  assert.equal(audit(product({ detailParserVersion: 4 })).fields.price.reason, "obsolete_price_parser");
  assert.equal(audit(product({ currentPriceStatus: "pending_revalidation" })).fields.price.reason, "price_revalidation_pending");
  assert.equal(audit(product({ currentPriceStatus: "unavailable" })).fields.price.reason, "price_status_conflict");
});

test("zero, malformed or non-finite prices and weights are invalid, while omitted values stay null", () => {
  for (const value of [0, -1, NaN, Infinity, false, "bad", "0.06 kg"]) {
    const result = audit(product({ currentPrice: value, productWeightKg: value }));
    assert.equal(result.fields.price.status, "invalid", String(value));
    assert.equal(result.fields.weight.status, "invalid", String(value));
  }
  for (const value of [null, undefined, "", "  "]) {
    const result = audit(product({ currentPrice: value, productWeightKg: value }));
    assert.equal(result.fields.price.status, "unavailable");
    assert.equal(result.fields.weight.status, "unavailable");
    assert.equal(result.fields.price.value, null);
    assert.equal(result.fields.weight.value, null);
  }
});

test("valid package weight remains usable with its actual source when product weight is absent or invalid", () => {
  const result = audit(product({ productWeightKg: 0, fbaPackageWeightKg: 0.08,
    fieldSources: { fbaPackageWeightKg: "amazon_product_page" } }));
  assert.equal(result.fields.weight.status, "verified");
  assert.equal(result.fields.weight.field, "fbaPackageWeightKg");
  assert.equal(result.fields.weight.kind, "package");
  assert.equal(result.fields.weight.source, "amazon_product_page");
  assert.equal(result.fields.weight.value, 0.08);
  assert.equal(result.fields.weight.issues[0].reason, "weight_not_positive");
  const fallback = audit(product({ fieldSources: { productWeightKg: "amazon_package_weight_fallback" } }));
  assert.equal(fallback.fields.weight.kind, "package");
});

test("weight aliases retain source and unit, and an unsourced number is not verified", () => {
  const result = audit(product({ productWeightKg: null, fbaWeight: 0.08, fieldSources: { packageWeightKg: "amazon_product_page" } }));
  assert.equal(result.fields.weight.field, "fbaWeight");
  assert.equal(result.fields.weight.value, 0.08);
  assert.equal(result.fields.weight.source, "amazon_product_page");
  const missing = audit(product({ fieldSources: {} }));
  assert.equal(missing.fields.weight.status, "missing");
  assert.equal(missing.fields.weight.reason, "weight_source_missing");
  assert.equal(missing.fields.weight.retryable, true);
});

test("manual overrides do not count as successful automated collection", () => {
  const result = audit(product({ fieldSources: { currentPrice: "manual", productWeightKg: "manual" } }));
  assert.equal(result.fields.price.status, "missing");
  assert.equal(result.fields.weight.status, "missing");
  assert.equal(result.fields.price.reason, "manual_value_not_collected");
  assert.equal(result.fields.weight.reason, "manual_value_not_collected");
  assert.deepEqual(result.retryableFields, []);
});

test("optional reviews may be explicitly zero, but absent ratings or reviews are never converted to zero", () => {
  const empty = audit(product({ rating: null, reviewCount: null }));
  assert.equal(empty.status, "complete");
  assert.equal(empty.fields.rating.status, "unavailable");
  assert.equal(empty.fields.reviews.status, "unavailable");
  assert.equal(empty.fields.reviews.value, null);
  const zero = audit(product({ reviewCount: 0 }));
  assert.equal(zero.fields.reviews.status, "verified");
  assert.equal(zero.fields.reviews.value, 0);
  assert.equal(audit(product({ rating: 6 })).fields.rating.status, "invalid");
  assert.equal(audit(product({ reviewCount: 1.5 })).fields.reviews.status, "invalid");
});

test("image URLs and titles are validated instead of accepting arbitrary filled values", () => {
  assert.equal(audit(product({ imageUrl: "javascript:alert(1)" })).fields.image.status, "invalid");
  assert.equal(audit(product({ imageUrl: "https://user:password@example.com/x.jpg" })).fields.image.status, "invalid");
  assert.equal(audit(product({ title: 123 })).fields.title.status, "invalid");
  assert.equal(audit(product({ title: " " })).fields.title.status, "unavailable");
});

test("actual parser output can be audited before normalization without inventing missing data", () => {
  const parsed = parseAmazonProductPage(`<input id="ASIN" value="${asin}"><h1 id="productTitle">Car Armrest</h1>
    <img id="landingImage" src="https://m.media-amazon.com/images/I/example.jpg">
    <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$9.99</span></span></div>
    <table id="productDetails_detailBullets_sections1"><tr><th>Item Weight</th><td>60 g</td></tr></table>`, { marketplace: "CA", asin });
  const result = audit(parsed, { marketplace: "CA" });
  assert.equal(result.status, "complete");
  assert.equal(result.fields.price.value, 9.99);
  assert.equal(result.fields.weight.value, 0.06);
  assert.equal(result.fields.rating.status, "unavailable");
});
