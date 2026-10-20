import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseAmazonProductPage } from "../lib/amazon-store-client.mjs";

const ASIN = "B0FP55F3Q9";
const OTHER_ASIN = "B012345678";
const title = "Car Armrest Storage Box Mat";
const amount = (text, classes = "") => `<span class="a-price ${classes}"><span class="a-offscreen">${text}</span></span>`;
const mainPrice = (text) => `<div id="corePriceDisplay_desktop_feature_div">${amount(text, "priceToPay")}</div>`;
const product = (body, head = "") => `<!doctype html><html><head>${head}</head><body>
  <input id="ASIN" value="${ASIN}"><h1 id="productTitle">${title}</h1>${body}</body></html>`;
const schema = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const parse = (body, { marketplace = "CA", head = "" } = {}) => parseAmazonProductPage(product(body, head), { marketplace, asin: ASIN });

test("captured Amazon CA markup with an empty offscreen span preserves the real 9.99 price", () => {
  const captured = readFileSync(new URL("./fixtures/amazon-ca-b0fp55f3q9-price.html", import.meta.url), "utf8");
  const result = parse(`<div id="sp_detail"><meta itemprop="price" content="279">${amount("$279.00", "priceToPay")}</div>${captured}`);
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.priceEvidence.rawText, "$9.99");
  assert.equal(result.priceEvidence.selector, "#corePriceDisplay_desktop_feature_div .priceToPay");
});

test("the main accessible price label is usable when Amazon omits visual amount spans", () => {
  assert.equal(parse(`<div id="corePriceDisplay_desktop_feature_div"><span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> $9.99 </span></div>`).currentPrice, 9.99);
});

test("CA armrest regression: displayed 9.99 wins over unrelated 279 metadata and stale attach data", () => {
  const result = parse(`
    <div id="CardInstance-recommendations" data-asin="${OTHER_ASIN}">
      <meta itemprop="price" content="279.00">${amount("$279.00", "a-size-xl")}
    </div>
    <input id="attach-base-product-price" value="279.00">
    <div id="corePriceDisplay_desktop_feature_div">
      ${amount("$29.99", "a-text-price")}${amount("$9.99", "priceToPay")}
    </div>
    <div id="variation_color_name">${amount("$10.99")}</div>
  `, { head: schema({ "@type": "Product", sku: ASIN, offers: { price: "279.00", priceCurrency: "CAD" } }) });
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.priceEvidence.source, "visible_main_price");
  assert.equal(result.priceEvidence.rawText, "$9.99");
  assert.equal(result.priceEvidence.currency, "CAD");
  assert.equal(result.priceEvidence.asin, ASIN);
});

test("recommendations, variant prices and page-wide metadata never become a missing main price", () => {
  const result = parse(`
    <div id="similarities_feature_div">${amount("$279.00")}</div>
    <div class="a-carousel">${amount("$59.99", "priceToPay")}</div>
    <div id="variation_color_name">${amount("$10.99")}</div>
    <div data-asin="${OTHER_ASIN}"><meta itemprop="price" content="279.00">${amount("$279.00")}</div>
    ${amount("$149.00", "priceToPay")}
  `, { head: schema({ "@type": "Product", sku: OTHER_ASIN, offers: { price: 279, priceCurrency: "CAD" } }) });
  assert.equal(result.currentPrice, null);
  assert.equal(result.priceEvidence, null);
  assert.equal(result.fieldSources.currentPrice, undefined);
});

test("a recommendation ASIN is not interpreted as the detail-page ASIN", () => {
  const html = `<div data-asin="${OTHER_ASIN}">${amount("$279")}</div><h1 id="productTitle">${title}</h1>${mainPrice("$9.99")}`;
  assert.equal(parseAmazonProductPage(html, { marketplace: "CA", asin: ASIN }).currentPrice, 9.99);
  const result = parseAmazonProductPage(product(mainPrice("$9.99")).replace(`value="${ASIN}"`, `value="${OTHER_ASIN}"`), { marketplace: "CA", asin: ASIN });
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.asin, ASIN);
  assert.equal(result.priceEvidence.asin, ASIN);
  assert.equal(result.priceEvidence.observedAsin, OTHER_ASIN);
  assert.equal(result.productInformation.identityDiagnostics.pageAsin, OTHER_ASIN);
  assert.equal(result.productInformation.identityDiagnostics.policy, "observe_without_rejection");
});

test("main price excludes list prices, units, installments, used offers, recommendations and hidden amounts", () => {
  const rejected = [
    amount("$279.00", "a-text-price"),
    `<del>${amount("$279.00")}</del>`,
    `<div id="basisPrice">${amount("$279.00")}</div>`,
    `<div class="pricePerUnit">${amount("$0.99")}</div>`,
    `<span>${amount("$0.99")} / count</span>`,
    `<span>4 payments of ${amount("$2.99")}</span>`,
    `<div id="installmentCalculator">${amount("$2.99")}</div>`,
    `<div id="usedBuySection">${amount("$7.99")}</div>`,
    `<div id="variation_color_name">${amount("$10.99")}</div>`,
    `<div id="sp_detail" data-asin="${OTHER_ASIN}">${amount("$279.00")}</div>`,
    `<div class="aok-hidden">${amount("$279.00", "priceToPay")}</div>`,
    `<div style="display: none">${amount("$279.00", "priceToPay")}</div>`,
  ];
  const html = `<div id="apex_desktop">${rejected.join("")}${amount("$9.99")}</div>`;
  assert.equal(parse(html).currentPrice, 9.99);
  for (const secondary of rejected) assert.equal(parse(`<div id="apex_desktop">${secondary}</div>`).currentPrice, null, secondary);
});

test("a different data-asin alone does not exclude a visible main price", () => {
  const result = parse(`<div id="apex_desktop"><div data-asin="${OTHER_ASIN}">${amount("$9.99")}</div></div>`);
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.priceEvidence.asin, ASIN);
});

test("split whole and fraction markup retains cents even without an offscreen amount", () => {
  const html = `<div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay">
    <span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">9<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span>
  </span></div>`;
  assert.equal(parse(html).currentPrice, 9.99);
  assert.equal(parse(html.replace(">9<span", ">1,299<span")).currentPrice, 1299.99);
  assert.equal(parse(html.replace(">$</span>", ">€</span>").replace(">9<span", ">1.299<span"), { marketplace: "DE" }).currentPrice, 1299.99);
});

test("sale and deal blocks take precedence over the legacy regular price", () => {
  assert.equal(parse(`<span id="priceblock_ourprice">$29.99</span><span id="priceblock_dealprice">$9.99</span>`).currentPrice, 9.99);
  assert.equal(parse(`<div id="price_inside_buybox">$9.99</div>`).currentPrice, 9.99);
});

test("JSON-LD selects the matching ASIN rather than the first Product", () => {
  const result = parse("", { head: schema({ "@graph": [
    { "@type": "Product", sku: OTHER_ASIN, offers: { price: 279, priceCurrency: "CAD" } },
    { "@type": "Product", url: `https://www.amazon.ca/dp/${ASIN}`, offers: { "@type": "Offer", price: "9.99", priceCurrency: "CAD" } },
  ] }) });
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.priceEvidence.source, "matching_product_json_ld");
});

test("unidentified JSON-LD must match the actual product title", () => {
  const offer = { price: 9.99, priceCurrency: "CAD" };
  assert.equal(parse("", { head: schema({ "@type": "Product", name: title, offers: offer }) }).currentPrice, 9.99);
  assert.equal(parse("", { head: schema({ "@type": "Product", name: "Recommended sofa", offers: offer }) }).currentPrice, null);
});

test("JSON-LD rejects aggregate minima, ambiguous offers, unavailable offers and foreign currency or sites", () => {
  const invalidOffers = [
    { "@type": "AggregateOffer", lowPrice: 9.99, highPrice: 29.99, priceCurrency: "CAD" },
    { lowPrice: 9.99, priceCurrency: "CAD" },
    { price: 9.99, priceCurrency: "USD" },
    { price: 9.99, priceCurrency: "CAD", availability: "https://schema.org/OutOfStock" },
    { price: 9.99, priceCurrency: "CAD", url: `https://www.amazon.com/dp/${ASIN}` },
    { price: 9.99, priceCurrency: "CAD", url: `https://www.amazon.ca.example.com/dp/${ASIN}` },
    { price: 9.99, priceCurrency: "CAD", itemOffered: { url: `https://www.amazon.com/dp/${ASIN}` } },
    [{ price: 9.99, priceCurrency: "CAD" }, { price: 29.99, priceCurrency: "CAD" }],
  ];
  for (const offers of invalidOffers) {
    assert.equal(parse("", { head: schema({ "@type": "Product", sku: ASIN, offers }) }).currentPrice, null, JSON.stringify(offers));
  }
  assert.equal(parse("", { head: schema({ "@type": "Product", sku: ASIN, url: `https://www.amazon.com/dp/${ASIN}`, offers: { price: 9.99, priceCurrency: "CAD" } }) }).currentPrice, null);
});

test("JSON-LD same-market variant URLs remain usable under the task ASIN", () => {
  const result = parse("", { head: schema({ "@type": "Product", sku: ASIN, offers: { price: 9.99, priceCurrency: "CAD", url: `https://www.amazon.ca/dp/${OTHER_ASIN}` } }) });
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.priceEvidence.asin, ASIN);
  assert.equal(result.priceEvidence.source, "matching_product_json_ld");
});

test("unavailability blocks stale structured and attach prices", () => {
  assert.equal(parse(`<div id="availability">Currently unavailable.</div><input id="attach-base-product-price" value="279">`, {
    head: schema({ "@type": "Product", sku: ASIN, offers: { price: 279, priceCurrency: "CAD" } }),
  }).currentPrice, null);
});

test("attach prices belong to the displayed page product and are only a last resort", () => {
  assert.equal(parse(`<input id="attach-base-product-price" value="9.99">`).currentPrice, 9.99);
  assert.equal(parse(`<input id="attach-base-asin" value="${OTHER_ASIN}"><input id="attach-base-product-price" value="279">`).currentPrice, null);
  const redirectedPage = product(`<input id="attach-base-asin" value="${OTHER_ASIN}"><input type="hidden" id="attach-base-product-price" value="9.99">`).replace(`value="${ASIN}"`, `value="${OTHER_ASIN}"`);
  const result = parseAmazonProductPage(redirectedPage, { marketplace: "CA", asin: ASIN });
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.priceEvidence.asin, ASIN);
  assert.equal(result.priceEvidence.observedAsin, OTHER_ASIN);
  assert.equal(result.priceEvidence.source, "matching_product_attach_price");
  for (const scope of [`id="sp_detail"`, `class="aok-hidden"`, `style="display: none"`, `id="variation_color_name"`]) {
    assert.equal(parse(`<div ${scope}><input id="attach-base-product-price" value="279"></div>`).currentPrice, null, scope);
  }
});

test("metadata is accepted only inside a main price scope with a matching currency", () => {
  assert.equal(parse(`<div id="corePrice_feature_div" itemscope><meta itemprop="price" content="9.99"><meta itemprop="priceCurrency" content="CAD"></div>`).currentPrice, 9.99);
  assert.equal(parse(`<div id="corePrice_feature_div" itemscope><meta itemprop="price" content="9.99"><meta itemprop="priceCurrency" content="USD"></div>`).currentPrice, null);
});

for (const [marketplace, raw, expected] of [
  ["CA", "$9.99", 9.99], ["CA", "CDN$ 9.99", 9.99], ["CA", "CAD 1299.99", 1299.99],
  ["CA", "$1,299.99", 1299.99], ["CA", "9,99 $ CAD", 9.99], ["US", "$9999.99", 9999.99],
  ["AU", "A$1,299.99", 1299.99], ["UK", "£1299.99", 1299.99], ["DE", "1.299,99 €", 1299.99],
  ["NL", "€ 1299,99", 1299.99], ["FR", "1\u202f299,99 €", 1299.99], ["IT", "1.299 €", 1299],
  ["ES", "1.299,00 €", 1299], ["PL", "1 299,99 zł", 1299.99], ["MX", "MX$1,299.99", 1299.99],
  ["BR", "R$ 1.299,99", 1299.99], ["CA", "\u200e$9.99\u200f", 9.99],
]) {
  test(`${marketplace} parses the entire localized amount ${JSON.stringify(raw)}`, () => {
    assert.equal(parse(mainPrice(raw), { marketplace }).currentPrice, expected);
  });
}

for (const raw of ["$9.99 - $19.99", "$9.99 to $19.99", "$2.50 / month", "$0.99 / count", "Save 20%", "$9.99$9.99", "$9$999", "-$9.99", "$0.00", "US$9.99", "€9.99", "$12,34,56", "$1 2 9.99"]) {
  test(`rejects a range, secondary amount, foreign currency or malformed price ${JSON.stringify(raw)}`, () => {
    assert.equal(parse(mainPrice(raw)).currentPrice, null);
  });
}

test("conflicting primary amounts fail closed, duplicate desktop/mobile amounts are safe", () => {
  assert.equal(parse(`${mainPrice("$9.99")}<div id="apex_mobile">${amount("$29.99", "priceToPay")}</div>`).currentPrice, null);
  assert.equal(parse(`${mainPrice("$9.99")}<div id="apex_mobile">${amount("$9.99", "priceToPay")}</div>`).currentPrice, 9.99);
});
