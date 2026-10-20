import test from "node:test";
import assert from "node:assert/strict";
import { auditAmazonProductFields } from "../lib/amazon-detail-quality.mjs";
import { parseAmazonProductPage } from "../lib/amazon-store-client.mjs";
import { isAmazonWeightUnavailable } from "../lib/profit-model.mjs";

const now = "2026-09-24T01:02:03.000Z";
const asin = "B0FP55F3Q9";
const noWeightInformation = (overrides = {}) => ({ version: 1, asin, status: "complete", reason: null,
  inspection: { version: 3, asin, status: "complete", stable: true, rowCount: 1,
    sections: [{ selector: "#productDetails_detailBullets_sections1", status: "complete", rowCount: 1 }],
    parsedSections: [{ selector: "#productDetails_detailBullets_sections1", rowCount: 1 }] },
  rowCount: 1, weightStatus: "not_provided", sections: [{ selector: "#productDetails_detailBullets_sections1",
    heading: "Product information", rows: [{ label: "Brand", value: "Synthetic brand" }] }], ...overrides });
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
  assert.equal(result.version, 5);
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
  const result = audit(product({ currentPrice: null, price: 279, price30: 299, averagePrice30: 299, priceEvidence: null, productWeightKg: null, productInformation: noWeightInformation() }));
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
  assert.ok(Object.entries(unavailable.fields).filter(([name]) => name !== "weight").every(([, field]) => field.status === "unavailable" && field.value === null));
  assert.equal(unavailable.fields.weight.status, "missing");
  assert.equal(unavailable.fields.weight.reason, "product_information_unchecked");
  assert.deepEqual(unavailable.retryableFields, ["weight"]);
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
    const result = audit(product({ currentPrice: value, productWeightKg: value, productInformation: noWeightInformation() }));
    assert.equal(result.fields.price.status, "unavailable");
    assert.equal(result.fields.weight.status, "unavailable");
    assert.equal(result.fields.price.value, null);
    assert.equal(result.fields.weight.value, null);
  }
});

test("package weight and historical package fallbacks cannot verify Item Weight", () => {
  const result = audit(product({ productWeightKg: 0, fbaPackageWeightKg: 0.08,
    fieldSources: { fbaPackageWeightKg: "amazon_product_page" } }));
  assert.equal(result.fields.weight.status, "invalid");
  assert.equal(result.fields.weight.field, "productWeightKg");
  assert.equal(result.fields.weight.value, null);
  assert.equal(result.fields.weight.issues[0].reason, "weight_not_positive");
  const fallback = audit(product({ fieldSources: { productWeightKg: "amazon_package_weight_fallback" } }));
  assert.equal(fallback.fields.weight.status, "invalid");
  assert.equal(fallback.fields.weight.reason, "not_item_weight");
});

test("package aliases are not Item Weight, and an unsourced product weight is not verified", () => {
  const result = audit(product({ productWeightKg: null, fbaWeight: 0.08, fieldSources: { packageWeightKg: "amazon_product_page" } }));
  assert.equal(result.fields.weight.status, "missing");
  assert.equal(result.fields.weight.value, null);
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


test("legacy successful records and incomplete information never certify missing weight as page absence", () => {
  const cases = [
    [undefined, "product_information_unchecked"],
    [noWeightInformation({ asin: "B000000002" }), "product_information_unchecked"],
    [noWeightInformation({ version: 0 }), "product_information_unchecked"],
    [noWeightInformation({ status: "incomplete", reason: "empty_details" }), "product_information_incomplete"],
    [noWeightInformation({ rowCount: 0, sections: [] }), "product_information_incomplete"],
    [noWeightInformation({ rowCount: 2 }), "product_information_incomplete"],
    [noWeightInformation({ weightStatus: "unresolved" }), "product_information_unresolved"],
    [noWeightInformation({ weightStatus: "found" }), "product_information_unresolved"],
    [noWeightInformation({ sections: [{ selector: "#productDetails_detailBullets_sections1", heading: "Product information",
      rows: [{ label: "Item Weight", value: "Not available" }] }] }), "product_information_unresolved"],
  ];
  for (const [productInformation, reason] of cases) {
    const input = product({ productWeightKg: null, productInformation,
      collectionQuality: { version: 1, fields: { weight: { status: "unavailable", reason: "page_not_provided" } } } });
    const before = structuredClone(input); const result = audit(input);
    assert.equal(result.version, 5); assert.equal(result.fields.weight.status, "missing");
    assert.equal(result.fields.weight.reason, reason); assert.equal(result.fields.weight.retryable, true);
    assert.equal(result.fields.weight.value, null); assert.deepEqual(input, before);
  }
});

test("version 11 requires exact Item Weight evidence and rejects every other automatic label", () => {
  const evidence = { label: 'item weight', kind: 'product', value: 0.06, unit: 'kg', asin,
    rawText: '60 Grams', selector: '#productDetails', source: 'amazon_product_page' };
  const valid = audit(product({ detailParserVersion: 11, productWeightEvidence: evidence,
    amazonFirstAvailableDateStatus: 'unresolved' }));
  assert.equal(valid.fields.weight.status, 'verified');
  assert.equal(valid.fields.weight.kind, 'product');
  assert.equal(valid.status, 'complete', 'An unavailable listing date is not a required profit field.');
  assert.equal(audit(product({ detailParserVersion: 11 })).fields.weight.reason, 'item_weight_evidence_missing');
  for (const value of [undefined, null, 0, -1, NaN, Infinity]) {
    assert.equal(audit(product({ detailParserVersion: 11, productWeightEvidence: { ...evidence, value } })).fields.weight.reason,
      'item_weight_evidence_missing', String(value));
  }
  for (const label of ['Package Weight', 'Shipping Weight', 'Product Weight', 'Weight', 'Item Dimensions', 'Load Capacity']) {
    const result = audit(product({ detailParserVersion: 11, productWeightEvidence: { ...evidence, label } }));
    assert.equal(result.fields.weight.status, 'invalid', label);
    assert.equal(result.fields.weight.reason, 'not_item_weight', label);
  }
  assert.equal(audit(product({ detailParserVersion: 11, productWeightEvidence: { ...evidence, value: 0.07 } })).fields.weight.reason,
    'item_weight_evidence_value_mismatch');
  assert.equal(audit(product({ detailParserVersion: 11, productWeightEvidence: { ...evidence, kind: 'package' } })).fields.weight.reason,
    'not_item_weight');
});

test("complete same-ASIN product information confirms absence, while access failures still remain failures", () => {
  const input = product({ productWeightKg: null, productInformation: noWeightInformation() });
  const result = audit(input);
  assert.equal(result.fields.weight.status, "unavailable");
  assert.equal(result.fields.weight.reason, "page_not_provided");
  assert.equal(result.fields.weight.retryable, false);
  assert.equal(result.fields.weight.evidence.asin, asin);
  assert.equal(result.fields.weight.evidence.rowCount, 1);
  for (const override of [{ detailStatus: "failed", detailErrorCode: "AMAZON_FETCH_TIMEOUT", detailRetryable: true },
    { challenge: true }, { rateLimited: true }, { navigationError: true }, { detailStatus: "pending" },
    { lastCollectionError: { code: "AMAZON_FETCH_TIMEOUT" } },
    { collectionLastAttempt: { status: "failed", code: "AMAZON_FETCH_TIMEOUT" } }]) {
    const failed = audit({ ...input, ...override });
    assert.equal(failed.fields.weight.status, "missing");
    assert.notEqual(failed.fields.weight.reason, "page_not_provided");
  }
});

test("an actual same-product Item Weight of 20 g remains verified independently of missing fields", () => {
  const parsed = parseAmazonProductPage(`<input id="ASIN" value="B08PSZMZRQ"><h1 id="productTitle">Synthetic product</h1>
    <table id="productDetails_detailBullets_sections1"><tr><th>Item Weight</th><td>20 g</td></tr></table>`,
    { marketplace: "AU", asin: "B08PSZMZRQ" });
  const result = audit(parsed, { marketplace: "AU" });
  assert.equal(result.fields.weight.status, "verified");
  assert.equal(result.fields.weight.value, 0.02);
  assert.equal(result.fields.weight.unit, "kg");
  assert.equal(result.fields.weight.source, "amazon_product_page");
  assert.equal(result.fields.price.value, null);
});


test("the real information parser certifies only a fully inspected weightless detail table", () => {
  const table = '<table id="productDetails_detailBullets_sections1"><tr><th>Brand</th><td>Synthetic brand</td></tr></table>';
  for (const hidden of [false, true]) {
    const parsed = parseAmazonProductPage(`<input id="ASIN" value="${asin}"><h1 id="productTitle">Synthetic product</h1>
      ${hidden ? '<div style="display:none">' + table + '</div>' : table}`, { marketplace: 'CA', asin, informationInspection: noWeightInformation().inspection });
    const result = audit(parsed, { marketplace: 'CA' });
    assert.equal(result.fields.weight.status, hidden ? 'missing' : 'unavailable');
    assert.equal(isAmazonWeightUnavailable({ ...parsed, collectionQuality: result }), !hidden);
    assert.equal(parsed.productWeightKg, null);
  }
});


test("legacy absence and incomplete panel coverage remain retryable without mutating saved evidence", () => {
  for (const inspection of [undefined, { ...noWeightInformation().inspection, parsedSections: [{ selector: "#wrong-section", rowCount: 1 }] },
    {...noWeightInformation().inspection, parsedSections: [null]},
    {...noWeightInformation().inspection, parsedSections: [{selector: "#productDetails_detailBullets_sections1", rowCount: 1.5}]},
    {...noWeightInformation().inspection, parsedSections: [{selector: "#productDetails_detailBullets_sections1", rowCount: 0}]},
    { ...noWeightInformation().inspection, stable: false }]) {
    const input = product({ productWeightKg: null, productInformation: noWeightInformation({inspection}) });
    const before = structuredClone(input);
    const result = audit(input);
    assert.equal(result.fields.weight.status, "missing");
    assert.equal(result.fields.weight.retryable, true);
    assert.equal(isAmazonWeightUnavailable({...input, collectionQuality: result}), false);
    assert.deepEqual(input, before);
  }
});
