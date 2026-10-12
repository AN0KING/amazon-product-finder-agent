import assert from "node:assert/strict";
import test from "node:test";
import { AMAZON_PRODUCT_DETAIL_PARSER_VERSION, parseAmazonProductPage } from "../lib/amazon-store-client.mjs";
import { auditAmazonProductFields } from "../lib/amazon-detail-quality.mjs";

const asin = "B0GCFF3CTF";
const otherAsin = "B012345678";
const title = "Makeup Bag Set 3 Piece, Small Clear Makeup Organiser Bag, Mini Makeup Pouch for Travel Toiletries, Small Makeup Bag";
const amount = (price, classes = "priceToPay") => `<span class="a-price ${classes}"><span class="a-offscreen">${price}</span></span>`;
// Synthetic regression markup matching the reported values, not a captured page.
const page = body => `<html><body><input id="ASIN" value="${asin}"><h1 id="productTitle">${title}</h1>${body}</body></html>`;
const parse = body => parseAmazonProductPage(page(body), { marketplace: "CA", asin });

test("new detail results identify the corrected parser without a price migration", () => {
  assert.equal(AMAZON_PRODUCT_DETAIL_PARSER_VERSION, 7);
});

test("makeup bag total stays 9.59 beside a separate 3.20/count amount", () => {
  for (const unitPrice of [
    `<span class="pricePerUnit">($3.20 / count)</span>`,
    `<span>($3.20 / count)</span>`,
    `<span class="aok-relative"><span class="apex-priceperunit-accessibility-label">$3.20 per count</span><span aria-hidden="true">($3.20 / count)</span></span>`,
  ]) {
    const result = parse(`<div id="corePriceDisplay_desktop_feature_div"><div>${amount("$9.59")}${unitPrice}</div></div>
      <div id="averageCustomerReviews"><span id="acrPopover" title="3.5 out of 5 stars"></span><span id="acrCustomerReviewText">(3)</span></div>`);
    assert.equal(result.currentPrice, 9.59, unitPrice);
    assert.equal(result.priceEvidence.rawText, "$9.59");
    assert.equal(result.rating, 3.5);
    assert.equal(result.reviewCount, 3);
    assert.equal(result.sales30, null);
    assert.equal(result.salesAmount30, null);
  }
});

test("a unit or installment price itself remains ineligible as the main price", () => {
  for (const body of [
    `<span>${amount("$3.20")} / count</span>`,
    `<span>${amount("$3.20")}<span> / count</span></span>`,
    `<span class="pricePerUnit">${amount("$3.20")}</span>`,
    `<span>4 payments of ${amount("$3.20")}</span>`,
  ]) assert.equal(parse(`<div id="corePrice_feature_div">${body}</div>`).currentPrice, null);
});

test("main review header wins over recommendation and hidden duplicate metrics", () => {
  const result = parse(`
    <div id="recommendations" data-asin="${otherAsin}"><span id="acrPopover" title="5.0 out of 5 stars"></span><span id="acrCustomerReviewText">279 ratings</span></div>
    <div hidden><span id="acrPopover" title="4.8 out of 5 stars"></span><span id="acrCustomerReviewText">888 ratings</span></div>
    <div id="averageCustomerReviews"><span id="acrPopover" title="3.5 out of 5 stars"></span><span id="acrCustomerReviewText">(3)</span></div>`);
  assert.equal(result.rating, 3.5);
  assert.equal(result.reviewCount, 3);
  assert.equal(result.ratingEvidence.rawText, "3.5 out of 5 stars");
  assert.equal(result.ratingEvidence.selector, "#averageCustomerReviews #acrPopover");
  assert.equal(result.ratingEvidence.asin, asin);
  assert.equal(result.reviewCountEvidence.rawText, "(3)");
});

test("unrelated review widgets and buying badges cannot fill missing main metrics", () => {
  for (const wrapper of [
    `id="recommendations"`, `data-asin="${otherAsin}"`, `hidden`, `class="a-carousel"`, `data-hook="review"`,
  ]) {
    const result = parse(`<div ${wrapper}><span id="acrPopover" title="5.0 out of 5 stars"></span>
      <span data-hook="rating-out-of-text">5.0 out of 5</span><span id="acrCustomerReviewText">279 ratings</span>
      <span data-hook="total-review-count">279 global ratings</span><span class="social-proofing-faceout-title-text">100+ bought in past month</span></div>`);
    assert.equal(result.rating, null, wrapper);
    assert.equal(result.reviewCount, null, wrapper);
    assert.equal(result.sales30, null, wrapper);
  }
});

test("rating extracts the score rather than the five-star denominator", () => {
  for (const text of ["3.5 out of 5 stars", "3,5 out of 5", "3.5 3.5 out of 5 stars"]) {
    assert.equal(parse(`<span id="acrPopover" title="${text}"></span>`).rating, 3.5, text);
  }
  assert.equal(parse(`<span id="acrPopover" title="5 stars"></span>`).rating, null);
});

test("review counts preserve thousands and never concatenate unrelated numbers", () => {
  for (const [text, expected] of [["(3)", 3], ["1,234 ratings", 1234], ["1.234 ratings", 1234], ["1 234 ratings", 1234], ["0 ratings", 0], ["3 ratings, 2 reviews", null], ["3.5 ratings", null]]) {
    assert.equal(parse(`<span id="acrCustomerReviewText">${text}</span>`).reviewCount, expected, text);
  }
});

test("monthly sales bind to the purchase quantity, not the month count", () => {
  for (const [text, expected] of [["100+ bought in past month", 100], ["In the last 1 month: 100+ bought", 100], ["1.2K+ bought in past month", 1200], ["1,2K+ bought in past month", 1200], ["1,000+ bought in past month", 1000]]) {
    const result = parse(`<span id="social-proofing-faceout-title-tk_bought">${text}</span>`);
    assert.equal(result.sales30, expected, text);
    assert.equal(result.salesAmount30, null);
    assert.equal(result.sales30Evidence.kind, "lower_bound");
    assert.equal(result.sales30Evidence.rawText, text);
  }
});

test("missing sales metrics are explicit unavailable fields without extra retries", () => {
  const result = parse(`<div id="corePrice_feature_div">${amount("$9.59")}</div>`);
  const quality = auditAmazonProductFields(result, { marketplace: "CA" });
  for (const name of ["rating", "reviews", "sales30", "salesAmount30"]) {
    assert.equal(quality.fields[name].status, "unavailable", name);
    assert.equal(quality.fields[name].reason, "page_not_provided", name);
    assert.equal(quality.fields[name].value, null, name);
    assert.equal(quality.fields[name].retryable, false, name);
    assert.ok(!quality.requiredMissing.includes(name));
    assert.ok(!quality.retryableFields.includes(name));
  }
});

test("sourced monthly sales audit retains lower-bound evidence without fabricating revenue", () => {
  const result = parse(`<div id="corePrice_feature_div">${amount("$9.59")}</div><span id="social-proofing-faceout-title-tk_bought">100+ bought in past month</span>`);
  const quality = auditAmazonProductFields(result, { marketplace: "CA" });
  assert.equal(quality.fields.sales30.status, "verified");
  assert.equal(quality.fields.sales30.source, "amazon_product_page");
  assert.equal(quality.fields.sales30.evidence.kind, "lower_bound");
  assert.equal(quality.fields.salesAmount30.status, "unavailable");
});

test("sales amount audit requires a field-specific source and does not estimate missing revenue", () => {
  const base = { asin, explicitProduct: true, currentPrice: 9.59, sales30: 100 };
  assert.equal(auditAmazonProductFields(base).fields.salesAmount30.status, "unavailable");
  assert.equal(auditAmazonProductFields({ ...base, salesAmount30: 959 }).fields.salesAmount30.status, "missing");
  const sourced = auditAmazonProductFields({ ...base, salesAmount30: 959, fieldSources: { salesAmount30: "sellersprite_product_detail" } });
  assert.equal(sourced.fields.salesAmount30.status, "verified");
  assert.equal(sourced.fields.salesAmount30.source, "sellersprite_product_detail");
});

test("page context records the actual selected ASIN and matching delivery postcode", () => {
  const result = parse(`<span id="glow-ingress-line1">Deliver to</span><span id="glow-ingress-line2">Toronto M5V 2T6\u200c</span>
    <div id="availability">In Stock</div><div id="corePrice_feature_div">${amount("$9.59")}</div>`);
  assert.deepEqual(result.pageContextEvidence, {
    expectedPostalCode: "M5V 2T6", observedDeliveryText: "Deliver to | Toronto M5V 2T6", regionStatus: "match",
    availabilityText: "In Stock", priceNotAvailableText: null, selectedAsin: asin, priceUnavailableReason: null,
  });
});

test("missing or city-only delivery text is unconfirmed, while a different postcode is a mismatch", () => {
  for (const [text, status] of [["", "unconfirmed"], ["Select delivery location", "unconfirmed"], ["Toronto", "unconfirmed"], ["V6B 1A1", "mismatch"], ["M5V2T6", "match"]]) {
    const result = parse(`<span id="glow-ingress-line2">${text}</span>`);
    assert.equal(result.pageContextEvidence.regionStatus, status, text);
    assert.equal(result.pageContextEvidence.priceUnavailableReason, status === "match" ? "page_not_provided" : "delivery_region_unconfirmed", text);
    const quality = auditAmazonProductFields(result, { marketplace: "CA" });
    assert.equal(quality.fields.price.reason, result.pageContextEvidence.priceUnavailableReason);
    assert.equal(quality.fields.price.status, "unavailable");
    // 配送地区未确认属于会话问题：CDP 通道带邮编重访可解锁价格，保持可重试；
    // 已确认地区仍无价格（page_not_provided）才是页面事实，不可重试。
    const deliveryArtifact = status !== "match";
    assert.equal(quality.fields.price.retryable, deliveryArtifact, text);
    assert.deepEqual(quality.retryableFields, deliveryArtifact ? ["price"] : []);
  }
});

test("cart-only price messages remain explicit even when the page has no confirmed delivery region", () => {
  const message = "To see product details, add this item to your cart. You can always remove it later.";
  const result = parse(`<span id="contextualIngressPtLabel_deliveryShortLine">Select delivery location</span>
    <div id="priceNotAvailable_feature_div">${message}</div>`);
  assert.equal(result.currentPrice, null);
  assert.equal(result.pageContextEvidence.regionStatus, "unconfirmed");
  assert.equal(result.pageContextEvidence.priceNotAvailableText, message);
  assert.equal(result.pageContextEvidence.priceUnavailableReason, "price_requires_cart");
  const audit = auditAmazonProductFields(result, { marketplace: "CA" });
  assert.equal(audit.fields.price.reason, "price_requires_cart");
  // 加购提示属于配送会话问题：保持可重试，由 CDP 通道重访解锁价格。
  assert.equal(audit.fields.price.retryable, true);
  assert.deepEqual(audit.retryableFields, ["price"]);
});

test("out-of-stock context is distinct from a confirmed page without a price", () => {
  const result = parse(`<span id="glow-ingress-line2">M5V 2T6</span><div id="availability">Currently unavailable.</div>`);
  assert.equal(result.pageContextEvidence.priceUnavailableReason, "unavailable");
  assert.equal(auditAmazonProductFields(result).fields.price.reason, "unavailable");
  const noRegion = parse(`<div id="availability">Currently unavailable.</div>`);
  assert.equal(noRegion.pageContextEvidence.priceUnavailableReason, "delivery_region_unconfirmed");
  assert.equal(noRegion.pageContextEvidence.availabilityText, "Currently unavailable.");
});

test("context ignores hidden and unrelated product delivery or cart prompts", () => {
  const result = parse(`<div hidden><span id="glow-ingress-line2">V6B 1A1</span><div id="priceNotAvailable_feature_div">See price in cart</div></div>
    <div data-asin="${otherAsin}"><div id="priceNotAvailable_feature_div">See price in cart</div></div>
    <span id="glow-ingress-line2">M5V 2T6<script>private token</script></span>`);
  assert.equal(result.pageContextEvidence.observedDeliveryText, "M5V 2T6");
  assert.equal(result.pageContextEvidence.regionStatus, "match");
  assert.equal(result.pageContextEvidence.priceNotAvailableText, null);
  assert.equal(result.pageContextEvidence.priceUnavailableReason, "page_not_provided");
});

test("marketplaces without a delivery postcode do not claim a missing region", () => {
  const result = parseAmazonProductPage(page(""), { marketplace: "NL", asin });
  assert.equal(result.pageContextEvidence.expectedPostalCode, null);
  assert.equal(result.pageContextEvidence.regionStatus, "not_required");
  assert.equal(result.pageContextEvidence.priceUnavailableReason, "page_not_provided");
});

test("context does not replace a failed request reason or invent an observed ASIN", () => {
  const parsed = parseAmazonProductPage(`<h1 id="productTitle">${title}</h1>`, { marketplace: "CA", asin });
  assert.equal(parsed.asin, asin);
  assert.equal(parsed.pageContextEvidence.selectedAsin, null);
  const result = auditAmazonProductFields({ ...parsed, detailStatus: "failed", detailErrorCode: "AMAZON_HTTP_429", detailRetryable: true });
  assert.equal(result.fields.price.reason, "request_failed");
  assert.equal(result.fields.price.retryable, true);
});


// Synthetic A/B markup exercises alternate layouts without claiming any live
// Amazon response has supplied a missing quantity.
test('monthly purchase extraction supports feature containers and ordinary main-header text', () => {
  const cases = [
    '<div id="socialProofingAsinFaceout_feature_div"><div>50+ bought in past month</div></div>',
    '<div data-feature-name="socialProofingAsinFaceout"><p>100+ bought in past month</p></div>',
    '<div id="centerCol"><span class="a-color-secondary">50+ bought in past month</span></div>',
    '<div id="title_feature_div"><p>50+ bought in past month</p></div>',
    '<span id="social-proofing-faceout-title-tk_bought" aria-label="50+ bought in past month"><b>50+</b></span>',
  ];
  for (const body of cases) {
    const result = parse(body);
    assert.ok(result.sales30 >= 50, body);
    assert.equal(result.sales30Evidence.asin, asin);
    assert.equal(result.sales30Evidence.kind, 'lower_bound');
    assert.equal(result.sales30Evidence.period, 'past_month');
  }
});

test('localized and full-width purchase markers remain lower bounds in detail evidence', () => {
  for (const text of ['５０＋ bought in past month', 'Plus de 50 achetés au cours du mois dernier', '100+ Mal im letzten Monat gekauft']) {
    const result = parse(`<div id="socialProofingAsinFaceout_feature_div">${text}</div>`);
    assert.equal(result.sales30Evidence.kind, 'lower_bound', text);
    assert.equal(result.sales30Evidence.rawText, text);
  }
});

test('new main-header fallback never borrows another ASIN, user text or recommendation', () => {
  for (const wrapper of [
    `id="recommendations"`, `data-asin="${otherAsin}"`, `hidden`, `class="a-carousel"`,
    `data-hook="review-body"`, `id="productDescription"`, `id="feature-bullets"`, `id="aplus"`,
    `id="CardInstance-unattributed"`,
  ]) {
    const result = parse(`<div id="centerCol"><div ${wrapper}><span>100+ bought in past month</span></div></div>`);
    assert.equal(result.sales30, null, wrapper);
  }
  assert.equal(parse(`<div id="socialProofingAsinFaceout_feature_div"><div data-asin="${otherAsin}">50+ bought in past month</div></div>`).sales30, null);
  assert.equal(parse('<div id="centerCol"><span>100+ bought in past month for another product</span></div>').sales30, null);
});

test('a modern product component must identify the current ASIN to supply its badge', () => {
  assert.equal(parse(`<div id="CardInstance-main" data-asin="${asin}"><div id="socialProofingAsinFaceout_feature_div">50+ bought in past month</div></div>`).sales30, 50);
  assert.equal(parse(`<div id="recommendations"><div id="CardInstance-main" data-asin="${asin}"><div id="socialProofingAsinFaceout_feature_div">50+ bought in past month</div></div></div>`).sales30, null);
});

test('conflicting current product badges do not pick the first quantity', () => {
  const result = parse('<span class="social-proofing-faceout-title-text">50+ bought in past month</span><span class="social-proofing-faceout-title-text">200+ bought in past month</span>');
  assert.equal(result.sales30, null);
  assert.equal(result.sales30Evidence, null);
});
