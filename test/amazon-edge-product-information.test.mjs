import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { load } from "cheerio";
import { parseAmazonProductPage } from "../lib/amazon-store-client.mjs";
import { EdgeCdpSession } from "../lib/amazon-edge-cdp.mjs";

const ASIN = "B000000001";
const OTHER = "B000000002";
const row = (label = "Item Weight", value = "20 g") => `<tr><th>${label}</th><td>${value}</td></tr>`;
const table = content => `<table id="productDetails_techSpec_section_1">${content}</table>`;
const expander = (id, label = "See more product details", attributes = "") => `<a id="${id}" class="a-expander-header" aria-expanded="false" aria-controls="${id}-panel" href="#" ${attributes}>${label}</a><div id="${id}-panel"></div>`;

function mockedDom(content, { url = `https://www.amazon.ca/dp/${ASIN}`, inputAsin = ASIN, canonical, title = "Amazon product", onScroll, onClick } = {}) {
  const $ = load(`<html><head><title>${title}</title>${canonical ? `<link rel="canonical" href="${canonical}">` : ''}</head><body>${inputAsin === null ? '' : `<input id="ASIN" value="${inputAsin}">`}${content}</body></html>`);
  const wrapped = new WeakMap();
  const calls = { evaluations: 0, scrolls: [], clicks: [], commands: [] };
  const wrap = node => {
    if (!node || !["tag", "script", "style"].includes(node.type)) return null;
    if (wrapped.has(node)) return wrapped.get(node);
    const element = {
      get id() { return $(node).attr("id") || ""; },
      get tagName() { return node.name.toUpperCase(); },
      get textContent() { return $(node).text(); },
      get value() { return $(node).attr("value") || ""; },
      get hidden() { return $(node).attr("hidden") !== undefined; },
      get parentElement() { return wrap(node.parent); },
      get nextElementSibling() { return wrap($(node).next()[0]); },
      get children() { return $(node).children().toArray().map(wrap); },
      getAttribute(name) { return $(node).attr(name) ?? null; },
      querySelector(selector) { return wrap($(node).find(selector)[0]); },
      querySelectorAll(selector) { return $(node).find(selector).toArray().map(wrap); },
      matches(selector) { return $(node).is(selector); },
      closest(selector) { return wrap($(node).closest(selector)[0]); },
      contains(other) {
        for (let candidate = other; candidate; candidate = candidate.parentElement) if (candidate === element) return true;
        return false;
      },
      scrollIntoView(options) { calls.scrolls.push({ id: this.id, options: JSON.parse(JSON.stringify(options)) }); onScroll?.($, this.id); },
      click() { calls.clicks.push(this.id); onClick?.($, this.id, node); },
    };
    wrapped.set(node, element);
    return element;
  };
  const document = {
    get title() { return $("title").text(); },
    querySelector(selector) { return wrap($(selector)[0]); },
    querySelectorAll(selector) { return $(selector).toArray().map(wrap); },
    getElementById(id) { return wrap($(`[id="${id}"]`)[0]); },
  };
  const session = new EdgeCdpSession({ edgeExecutable: "mock-edge" });
  session.command = async (method, params, options) => {
    calls.evaluations++;
    calls.commands.push({ method, options });
    assert.equal(method, "Runtime.evaluate");
    assert.equal(params.returnByValue, true);
    const state = vm.runInNewContext(params.expression, { document, location: new URL(url), URL,
      getComputedStyle: element => ({ display: /display\s*:\s*none/i.test(element.getAttribute("style") || "") ? "none" : "block",
        visibility: /visibility\s*:\s*hidden/i.test(element.getAttribute("style") || "") ? "hidden" : "visible" }),
    });
    return { result: { value: JSON.parse(JSON.stringify(state)) } };
  };
  return { session, calls, $ };
}

test("preloaded folded sections are expanded and observed stable before proving absence", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div"><div class="a-expander-container"><a id="loaded" class="a-expander-header" aria-expanded="false" href="#">Measurements</a><div class="a-expander-content" style="display:none">${table(row())}</div></div></div>`, {
    onClick($, id) { $(`#${id}`).attr("aria-expanded", "true"); $(".a-expander-content").attr("style", "display:block"); },
  });
  const result = await h.session.inspectProductInformation(ASIN);
  assert.equal(result.status, "complete");
  assert.equal(result.rowCount, 1);
  assert.equal(result.stable, true);
  assert.equal(result.version, 3);
  assert.equal(result.expanded, 1);
  assert.deepEqual(h.calls.clicks, ["loaded"]);
  assert.ok(result.sections.every(section => section.status === "complete" && !section.closed));
});

test("a selected AU child ASIN may retain its parent's canonical URL when URL, input and specification agree", async () => {
  const child = 'B08PSZMZRQ';
  const parent = 'B09XTNH1Q4';
  const h = mockedDom(`<div id="productDetails_feature_div">${table(row('ASIN', child) + row('Item Weight', '0.02 Kilograms'))}</div>`, {
    url: `https://www.amazon.com.au/dp/${child}`, inputAsin: child, canonical: `https://www.amazon.com.au/dp/${parent}`,
  });
  const result = await h.session.inspectProductInformation(child);
  assert.equal(result.status, 'complete');
  assert.equal(result.rowCount, 2);
  assert.equal(result.stable, true);
  assert.deepEqual(h.calls.clicks, []);
});

test('page URL, input, canonical and specification ASIN differences remain observations', async () => {
  for (const variant of ['missing_input', 'wrong_input', 'wrong_url', 'wrong_row', 'canonical_marketplace']) {
    const options = { url: `https://www.amazon.ca/dp/${ASIN}`, inputAsin: ASIN, canonical: `https://www.amazon.ca/dp/${OTHER}` };
    if (variant === 'missing_input') options.inputAsin = null;
    if (variant === 'wrong_input') options.inputAsin = OTHER;
    if (variant === 'wrong_url') options.url = `https://www.amazon.ca/dp/${OTHER}`;
    if (variant === 'canonical_marketplace') options.canonical = `https://www.amazon.com.au/dp/${OTHER}`;
    const h = mockedDom(`<div id="productDetails_feature_div">${table(row('ASIN', variant === 'wrong_row' ? OTHER : ASIN) + row('Item Weight', '140 g'))}</div>`, options);
    const result = await h.session.inspectProductInformation(ASIN, {expectedOrigin: 'https://www.amazon.ca'});
    assert.equal(result.status, 'complete', variant);
    assert.equal(result.identityDiagnostics.sourceAsin, ASIN);
    assert.equal(result.identityDiagnostics.policy, 'observe_without_rejection');
    assert.equal(result.reason, null);
  }
});

test("scrolling an existing empty information root can load its rows and waits for stable content", async () => {
  const h = mockedDom('<div id="productDetails_feature_div"></div>', {
    onScroll($) { $("#productDetails_feature_div").html(table(row())); },
  });
  const result = await h.session.inspectProductInformation(ASIN);
  assert.equal(result.status, "complete");
  assert.equal(result.rowCount, 1);
  assert.equal(result.scrolled, true);
  assert.equal(result.expanded, 0);
  assert.equal(result.stable, true);
  assert.equal(h.calls.scrolls.length, 2);
  assert.deepEqual(h.calls.clicks, []);
});

test("only a native information expander whose panel belongs to the same root can be opened", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div">${expander("details")}</div>`, {
    onClick($, id) { $(`#${id}-panel`).html(table(row())); $(`#${id}`).attr("aria-expanded", "true"); },
  });
  const result = await h.session.inspectProductInformation(ASIN);
  assert.equal(result.status, "complete");
  assert.equal(result.expanded, 1);
  assert.deepEqual(h.calls.clicks, ["details"]);
  assert.equal(result.stable, true);
});

test('foreign hosts, cross-market navigation and verification pages still block interaction', async () => {
  for (const variant of ['host', 'marketplace', 'challenge']) {
    const settings = variant === 'host' ? {url: `https://www.amazon.fake.example/dp/${ASIN}`}
      : variant === 'marketplace' ? {url: `https://www.amazon.com.au/dp/${ASIN}`} : {title: 'Robot Check'};
    const h = mockedDom(`<div id="productDetails_feature_div">${expander('details')}</div>`, settings);
    const result = await h.session.inspectProductInformation(ASIN, {expectedOrigin: 'https://www.amazon.ca'});
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, variant === 'challenge' ? 'access_challenge' : 'product_page_context_mismatch');
    assert.deepEqual(h.calls.scrolls, []);
    assert.deepEqual(h.calls.clicks, []);
  }
});

test('a native gp/aw/d product URL is inspected without changing imported identity', async () => {
  const h = mockedDom(`<div id="productDetails_feature_div">${table(row('ASIN', OTHER) + row('Item Weight', '70 g'))}</div>`, {
    url: `https://www.amazon.com.au/gp/aw/d/${ASIN}?th=1`, inputAsin: OTHER,
  });
  const inspection = await h.session.inspectProductInformation(ASIN, { expectedOrigin: 'https://www.amazon.com.au' });
  assert.equal(inspection.status, 'complete');
  assert.equal(inspection.identityDiagnostics.sourceAsin, ASIN);
  assert.equal(inspection.identityDiagnostics.urlAsin, ASIN);
  assert.equal(inspection.identityDiagnostics.pageAsin, OTHER);
  assert.deepEqual(h.calls.clicks, []);
});

test("missing canonical information roots remain incomplete", async () => {
  for (const content of ['<div id="productOverview_feature_div">20 g</div>']) {
    const h = mockedDom(content);
    const result = await h.session.inspectProductInformation(ASIN);
    assert.equal(result.status, "incomplete");
    assert.equal(result.reason, "root_missing");
    assert.deepEqual(h.calls.scrolls, []);
    assert.deepEqual(h.calls.clicks, []);
  }
});

test("another empty canonical section is not mistaken for complete details", async () => {
  const controller = new AbortController();
  const h = mockedDom(`${table(row())}<div id="detailBullets_feature_div"></div>`, {
    onScroll(_$, id) { if (id === "detailBullets_feature_div") controller.abort(new Error("stop incomplete second section")); },
  });
  await assert.rejects(h.session.inspectProductInformation(ASIN, { signal: controller.signal }), /stop incomplete second section/);
  assert.equal(h.calls.scrolls.at(-1).id, "detailBullets_feature_div");
  assert.deepEqual(h.calls.clicks, []);
});

test("an empty named productDetails anchor cannot keep valid product information waiting forever", async () => {
  const content = `<div id="productDetails_feature_div"><a id="productDetails" name="productDetails"></a>${table(row('ASIN', ASIN) + row('Item Weight', '170 Grams'))}</div>`;
  const h = mockedDom(content);
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.equal(inspection.status, 'complete');
  assert.equal(inspection.stable, true);
  assert.equal(inspection.reason, null);
  assert.ok(inspection.sections.every(section => section.selector !== '#productDetails'));
  assert.ok(h.calls.scrolls.every(call => call.id !== 'productDetails'));
  const parsed = parseAmazonProductPage(h.$.html(), { marketplace: 'AU', asin: ASIN, informationInspection: inspection });
  assert.equal(parsed.productInformation.status, 'complete');
  assert.equal(parsed.productWeightKg, 0.17);
  assert.equal(parsed.amazonFirstAvailableDateStatus, 'not_provided');
});

test("captured B08YWZC4C6 details finish inspection with 170g and explicitly confirmed missing first-available date", async () => {
  const sourceAsin = 'B08YWZC4C6';
  const content = readFileSync(new URL('./fixtures/amazon-b08ywzc4c6-product-information.html', import.meta.url), 'utf8');
  const h = mockedDom(content, { inputAsin: sourceAsin, url: `https://www.amazon.com.au/dp/${sourceAsin}`,
    onClick($, _id, node) {
      // Model each captured panel's normal local expander response without
      // network or product changes; other collapsed panels stay untouched.
      $(node).attr('aria-expanded', 'true');
      $(node).closest('.a-expander-container').find('.a-expander-content').attr('style', 'display:block');
    },
  });
  const inspection = await h.session.inspectProductInformation(sourceAsin);
  assert.equal(inspection.status, 'complete', JSON.stringify(inspection));
  assert.equal(inspection.stable, true);
  assert.equal(inspection.expanded, 2);
  assert.equal(inspection.rowCount, 18);
  const parsed = parseAmazonProductPage(h.$.html(), { marketplace: 'AU', asin: sourceAsin, informationInspection: inspection });
  assert.equal(parsed.productInformation.status, 'complete');
  assert.equal(parsed.productInformation.reason, null);
  assert.equal(parsed.productWeightKg, 0.17);
  assert.equal(parsed.productWeightEvidence.rawText, '170 Grams');
  assert.equal(parsed.productWeightEvidence.asin, sourceAsin);
  assert.equal(parsed.packageWeightKg, null);
  assert.equal(parsed.amazonFirstAvailableDateStatus, 'not_provided');
  assert.equal(parsed.amazonFirstAvailableDate, null);
  assert.equal(parsed.productInformation.weightStatus, 'found');
});

test('captured Voyager mixed ASINs keep displayed bullet data and source task identity', async () => {
  const sourceAsin = 'B09NXS1BLL';
  const content = readFileSync(new URL('./fixtures/amazon-b09nxs1bll-mixed-identity.html', import.meta.url), 'utf8');
  const h = mockedDom(content, {inputAsin: null, url: `https://www.amazon.com.au/dp/${sourceAsin}`,
    onClick($, _id, node) { $(node).attr('aria-expanded', 'true'); $(node).closest('.a-expander-container').find('.a-expander-content').attr('style', 'display:block'); }});
  const inspection = await h.session.inspectProductInformation(sourceAsin);
  assert.equal(inspection.status, 'complete', JSON.stringify(inspection));
  assert.equal(inspection.rowCount, 17);
  assert.ok(inspection.identityDiagnostics.specificationAsins.includes('B09QHCKV68'));
  assert.equal(inspection.discardedSections, undefined);
  const parsed = parseAmazonProductPage(h.$.html(), {marketplace:'AU', asin:sourceAsin, informationInspection:inspection});
  assert.equal(parsed.asin, sourceAsin);
  assert.equal(parsed.amazonFirstAvailableDate, '2021-12-21');
  assert.equal(parsed.productInformation.weightStatus, 'not_provided');
});

test('different specification ASINs in every supported layout remain diagnostics', async () => {
  const shapes = [
    `<dl><dt>ASIN</dt><dd>${OTHER}</dd></dl>`,
    `<div role="row"><span role="cell">ASIN</span><span role="cell">${OTHER}</span></div>`,
    `<div class="a-row"><span class="a-column">ASIN</span><span class="a-column">${OTHER}</span></div>`,
    `<div class="a-fixed-left-grid"><div class="a-fixed-left-grid-col">ASIN</div><div class="a-fixed-left-grid-col">${OTHER}</div></div>`,
    `<div class="a-row"><span class="a-text-bold">ASIN</span><span>${OTHER}</span></div>`,
  ];
  for (const shape of shapes) {
    const h = mockedDom(`<div id="productDetails_feature_div">${table(row('ASIN', ASIN) + row('Item Weight', '140 g'))}${shape}</div>`);
    const inspection = await h.session.inspectProductInformation(ASIN);
    assert.equal(inspection.status, 'complete', shape);
    assert.deepEqual(inspection.identityDiagnostics.specificationAsins, [ASIN, OTHER]);
    assert.equal(inspection.discardedSections, undefined);
  }
});

test("shopping, login, foreign panels and recommendations are never expanded", async () => {
  const controller = new AbortController();
  const content = `<div id="productDetails_feature_div">${expander("buy", "See more buying choices")}${expander("login", "Sign in for more information")}
    ${expander("navigate", "More product information").replace('href="#"', 'href="/gp/cart/view.html"')}
    <a id="outside" class="a-expander-header" aria-expanded="false" aria-controls="outside-panel" href="#">More details</a>
    <div id="sims-recommendations">${expander("recommend")}</div>
    </div><div data-asin="${OTHER}"><div id="prodDetails">${expander("foreign")}</div></div><div id="outside-panel"></div>`;
  const h = mockedDom(content);
  const pending = h.session.inspectProductInformation(ASIN, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("inspection stopped")), 20);
  await assert.rejects(pending, /inspection stopped/);
  assert.deepEqual(h.calls.clicks, []);
});

test("an inspection has a fixed total budget and visits each section at most once even when details stay empty", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div">${expander("first")}${expander("second")}${expander("third")}</div>`);
  const result = await h.session.inspectProductInformation(ASIN);
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "inspection_timeout");
  assert.equal(h.calls.scrolls.length, 4);
  assert.deepEqual(h.calls.clicks, ["first", "second", "third"]);
  assert.equal(result.expanded, 3);
  assert.ok(result.elapsedMs >= 11_500 && result.elapsedMs < 13_500);
});

test("a pre-aborted information inspection sends no CDP command", async () => {
  const h = mockedDom(table(row()));
  const controller = new AbortController();
  controller.abort(new Error("already paused"));
  await assert.rejects(h.session.inspectProductInformation(ASIN, { signal: controller.signal }), /already paused/);
  assert.equal(h.calls.commands.length, 0);
});

test("an abort cancels a pending CDP command and releases its timeout bookkeeping", async () => {
  const session = new EdgeCdpSession({ edgeExecutable: "mock-edge" });
  const sent = [];
  session.socket = { send(value) { sent.push(JSON.parse(value)); } };
  const controller = new AbortController();
  const pending = session.inspectProductInformation(ASIN, { signal: controller.signal });
  assert.equal(sent.length, 1);
  assert.equal(session.pendingCommands.size, 1);
  controller.abort(new Error("cancel waiting DOM"));
  await assert.rejects(pending, /cancel waiting DOM/);
  assert.equal(session.pendingCommands.size, 0);
});


test("Measurements with existing rows still expands and captures the missing 140g instead of 4.54kg capacity", async () => {
  const sourceAsin = "B09V6TRGTD";
  const content = `<div id="productDetails_feature_div">
    <div class="a-expander-container"><a class="a-expander-header" aria-expanded="true">Features &amp; Specs</a><div class="a-expander-content"><table><tr><th>Load Capacity</th><td>4.54 kg</td></tr></table></div></div>
    <div class="a-expander-container"><a id="measurements" class="a-expander-header" aria-expanded="false" href="#">Measurements</a><div class="a-expander-content" style="display:none"><table id="measurements-data">${row("Item Dimensions L x W x H", "22.1L x 17.5W x 5.7H centimetres")}${row("Number of Items", "4")}${row("Size", "2L+2M")}${row("Number of Sets", "4")}</table></div></div>
    <div class="a-expander-container"><a class="a-expander-header" aria-expanded="true">Item details</a><div class="a-expander-content"><table>${row("ASIN", sourceAsin)}</table></div></div>
    </div>`;
  const h = mockedDom(content, { inputAsin: sourceAsin, url: `https://www.amazon.com.au/dp/${sourceAsin}`,
    onClick($, id) { if (id === "measurements") { $("#measurements-data").append(row("Item Weight", "140 g")); $("#measurements").attr("aria-expanded", "true").next().attr("style", "display:block"); } } });
  const initial = parseAmazonProductPage(h.$.html(), {marketplace: "AU", asin: sourceAsin});
  assert.equal(initial.productWeightKg, null);
  assert.equal(initial.productInformation.weightStatus, "unresolved");
  const inspection = await h.session.inspectProductInformation(sourceAsin);
  assert.equal(inspection.status, "complete");
  assert.deepEqual(h.calls.clicks, ["measurements"]);
  const parsed = parseAmazonProductPage(h.$.html(), {marketplace: "AU", asin: sourceAsin, informationInspection: inspection});
  assert.equal(parsed.productWeightKg, 0.14);
  assert.equal(parsed.productWeightEvidence.rawText, "140 g");
  assert.equal(parsed.productInformation.rowCount, 7);
  assert.equal(parsed.amazonFirstAvailableDateStatus, "not_provided");
});

test("a known item weight does not skip a separately lazy first-available date panel", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div">${table(row("Item Weight", "140 g"))}<div id="itemDetails_feature_div"></div></div>`, {
    onScroll($, id) { if (id === "itemDetails_feature_div") $("#itemDetails_feature_div").html(`<table id="date-data">${row("Date First Available", "17 June 2020")}</table>`); }
  });
  const inspection = await h.session.inspectProductInformation(ASIN);
  const parsed = parseAmazonProductPage(h.$.html(), {marketplace: "CA", asin: ASIN, informationInspection: inspection});
  assert.equal(inspection.status, "complete");
  assert.equal(parsed.productWeightKg, 0.14);
  assert.equal(parsed.amazonFirstAvailableDate, "2020-06-17");
});

test("inspection coverage from a different table cannot establish field absence", async () => {
  const h = mockedDom(table(row("Brand", "Example")));
  const inspection = await h.session.inspectProductInformation(ASIN);
  const body = h.$.html();
  assert.equal(parseAmazonProductPage(body, {marketplace: "CA", asin: ASIN, informationInspection: inspection}).productInformation.weightStatus, "not_provided");
  for (const changed of [{ ...inspection, parsedSections: [{selector: "#other", rowCount: 1}] }, {...inspection, parsedSections: []},
    {...inspection, rowCount: 2}, {...inspection, stable: false}]) {
    const parsed = parseAmazonProductPage(body, {marketplace: "CA", asin: ASIN, informationInspection: changed});
    assert.equal(parsed.productInformation.weightStatus, "unresolved");
    assert.equal(parsed.amazonFirstAvailableDateStatus, "unresolved");
  }
});


test("the captured CREST layout inspects all four real nested sections and matches parser coverage", async () => {
  const sourceAsin = "B08PSZMZRQ";
  const content = readFileSync(new URL("./fixtures/amazon-b08pszmzrq-product-information.html", import.meta.url), "utf8");
  const h = mockedDom(content, { inputAsin: sourceAsin, url: `https://www.amazon.com.au/dp/${sourceAsin}`,
    onClick($, _id, node) { const control = $(node); control.attr("aria-expanded", "true"); control.closest(".a-expander-container").find(".a-expander-content").first().attr("style", "display:block"); } });
  const inspection = await h.session.inspectProductInformation(sourceAsin);
  assert.equal(inspection.status, "complete", JSON.stringify(inspection));
  assert.equal(inspection.rowCount, 23);
  assert.equal(inspection.expanded, 4);
  assert.equal(inspection.parsedSections.length, 4);
  const parsed = parseAmazonProductPage(h.$.html(), {marketplace: "AU", asin: sourceAsin, informationInspection: inspection});
  assert.equal(parsed.productWeightKg, 0.02);
  assert.equal(parsed.amazonFirstAvailableDateStatus, "not_provided");
});

test("Materials & Care finishes the native information inspection instead of keeping found weight pending", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div">
    <div class="a-expander-container"><a id="materials" class="a-expander-header" aria-expanded="false" href="#">Materials &amp; Care</a><div class="a-expander-content" style="display:none"><table>${row("Material", "Nylon")}</table></div></div>
    <div class="a-expander-container"><a id="measurements" class="a-expander-header" aria-expanded="false" href="#">Measurements</a><div class="a-expander-content" style="display:none"><table>${row("Item Weight", "70 g")}</table></div></div>
    <div class="a-expander-container"><a id="item-details" class="a-expander-header" aria-expanded="false" href="#">Item details</a><div class="a-expander-content" style="display:none"><table>${row("Brand Name", "Elisel")}</table></div></div>
    </div>`, { onClick($, id) { $(`#${id}`).attr("aria-expanded", "true").next().attr("style", "display:block"); } });
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.equal(inspection.status, "complete");
  assert.deepEqual(h.calls.clicks, ["item-details", "measurements", "materials"]);
  const parsed = parseAmazonProductPage(h.$.html(), { marketplace: "CA", asin: ASIN, informationInspection: inspection });
  assert.equal(parsed.productWeightKg, 0.07);
  assert.equal(parsed.amazonFirstAvailableDateStatus, "not_provided");
});

test("a Measurements weight arriving 1.4 seconds after expansion is collected before proving absence", async t => {
  let timer;
  t.after(() => clearTimeout(timer));
  const h = mockedDom(`<div id="productDetails_feature_div"><div class="a-expander-container"><a id="delayed-measurements" class="a-expander-header" aria-expanded="false" href="#">Measurements</a><div class="a-expander-content" style="display:none"><table id="delayed-rows">${row("Size", "Universal model")}</table></div></div></div>`, {
    onClick($, id) {
      $(`#${id}`).attr("aria-expanded", "true").next().attr("style", "display:block");
      timer = setTimeout(() => $("#delayed-rows").append(row("Item Weight", "70 g")), 1_400);
    },
  });
  const inspection = await h.session.inspectProductInformation(ASIN);
  const parsed = parseAmazonProductPage(h.$.html(), { marketplace: "CA", asin: ASIN, informationInspection: inspection });
  assert.equal(inspection.status, "complete");
  assert.equal(parsed.productWeightKg, 0.07);
  assert.equal(parsed.productInformation.weightStatus, "found");
  assert.deepEqual(h.calls.clicks, ["delayed-measurements"]);
});

test("the native full specifications entry opens its visible side sheet before declaring a weight absent", async () => {
  const sheet = '<div id="voyager-ns-desktop-side-sheet-container" role="dialog" aria-modal="true" class="a-section btf-lazy-load-target aok-hidden"><div id="voyager-ns-desktop-side-sheet-main-section"><div class="voyager-ns-desktop-attribute-sections"><div class="voyager-side-sheet-attribute-section"><h1 class="voyager-ns-desktop-subsection-name">Measurements</h1><div class="a-section"><table class="a-keyvalue prodDetTable">' + row("Item Weight", "70 g") + '</table></div></div></div></div></div>';
  const entry = '<span class="a-declarative" data-action="open-voyager-ns-desktop-side-sheet"><span class="a-button voyager-ns-desktop-side-sheet-jump-link"><span class="a-button-inner"><a id="all-specifications" class="a-button-text" href="javascript:void(0)">See all product specifications</a></span></span></span>';
  const h = mockedDom(`<div id="productDetails_feature_div"><table>${row("Brand Name", "Elisel")}</table></div>${entry}${sheet}`, {
    onClick($, id) { if (id === "all-specifications") $("#voyager-ns-desktop-side-sheet-container").removeClass("aok-hidden"); },
  });
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.deepEqual(h.calls.clicks, ["all-specifications"]);
  assert.equal(inspection.status, "complete");
  assert.equal(inspection.rowCount, 2);
  assert.ok(inspection.parsedSections.some(section => section.selector.startsWith("#voyager-ns-desktop-side-sheet-main-section")));
  const parsed = parseAmazonProductPage(h.$.html(), { marketplace: "CA", asin: ASIN, informationInspection: inspection });
  assert.equal(parsed.productWeightKg, 0.07);
  assert.equal(parsed.productWeightEvidence.rawText, "70 g");
  assert.equal(parsed.amazonFirstAvailableDateStatus, "not_provided");
});

test("a disabled full specifications entry stays unresolved and is never forced open", async t => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("disabled specifications remain unresolved")), 3_200);
  t.after(() => clearTimeout(timer));
  const h = mockedDom(`<div id="productDetails_feature_div"><table>${row("Brand Name", "Elisel")}</table></div><span class="a-declarative" data-action="open-voyager-ns-desktop-side-sheet"><span class="a-button" aria-disabled="true"><a id="disabled-specifications" href="javascript:void(0)">See all product specifications</a></span></span>`);
  await assert.rejects(h.session.inspectProductInformation(ASIN, { signal: controller.signal }), /disabled specifications remain unresolved/);
  assert.deepEqual(h.calls.clicks, []);
});

test("an information root arriving after the first DOM read is inspected within the bounded window", async t => {
  const h = mockedDom("");
  const timer = setTimeout(() => h.$("body").append(`<div id="productDetails_feature_div"><table>${row("Item Weight", "70 g")}</table></div>`), 400);
  t.after(() => clearTimeout(timer));
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.equal(inspection.status, "complete");
  assert.equal(inspection.version, 3);
  assert.equal(inspection.rowCount, 1);
  assert.ok(h.calls.scrolls.some(call => call.id === "productDetails_feature_div"));
  const parsed = parseAmazonProductPage(h.$.html(), { marketplace: "CA", asin: ASIN, informationInspection: inspection });
  assert.equal(parsed.productWeightKg, 0.07);
});

test("full specification controls in recommendations and hidden templates are ignored", async () => {
  const entry = id => `<span data-action="open-voyager-ns-desktop-side-sheet"><a id="${id}" href="javascript:void(0)">See all product specifications</a></span>`;
  const h = mockedDom(`<div id="productDetails_feature_div"><table>${row("Item Weight", "70 g")}</table></div><div id="sims-recommendations">${entry("recommendation-specs")}</div><div class="aok-hidden">${entry("hidden-specs")}</div>`);
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.equal(inspection.status, "complete");
  assert.equal(inspection.specifications.entryCount, 0);
  assert.deepEqual(h.calls.clicks, []);
});

test("a full specifications click that reaches a challenge stops before any further inspection action", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div"><table>${row("Size", "Universal model")}</table></div><span data-action="open-voyager-ns-desktop-side-sheet"><a id="challenge-specs" href="javascript:void(0)">See all product specifications</a></span>`, {
    onClick($) { $("title").text("Robot Check"); },
  });
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.reason, "access_challenge");
  assert.deepEqual(h.calls.clicks, ["challenge-specs"]);
});

test("a challenge appearing while scrolling to full specifications prevents the click", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div"><table>${row("Size", "Universal model")}</table></div><span data-action="open-voyager-ns-desktop-side-sheet"><a id="scroll-challenge-specs" href="javascript:void(0)">See all product specifications</a></span>`, {
    onScroll($, id) { if (id === "scroll-challenge-specs") $("title").text("Robot Check"); },
  });
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.reason, "access_challenge");
  assert.deepEqual(h.calls.clicks, []);
});

test("Product details opens before its Item details and Measurements sections", async () => {
  const h = mockedDom(`<div id="productDetails_feature_div" class="a-expander-container"><a id="product-details" class="a-expander-header" aria-expanded="false" href="#">Product details</a><div class="a-expander-content" style="display:none">
    <div class="a-expander-container"><a id="nested-measurements" class="a-expander-header" aria-expanded="false" href="#">Measurements</a><div class="a-expander-content" style="display:none"><table>${row("Item Weight", "70 g")}</table></div></div>
    <div class="a-expander-container"><a id="nested-item-details" class="a-expander-header" aria-expanded="false" href="#">Item details</a><div class="a-expander-content" style="display:none"><table>${row("Brand Name", "Elisel")}</table></div></div>
    </div></div>`, { onClick($, id) { $(`#${id}`).attr("aria-expanded", "true").next().attr("style", "display:block"); } });
  const inspection = await h.session.inspectProductInformation(ASIN);
  assert.equal(inspection.status, "complete");
  assert.deepEqual(h.calls.clicks, ["product-details", "nested-item-details", "nested-measurements"]);
});

test("a spinner under a hidden ancestor cannot keep visible product information busy", async t => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("hidden spinner must not exhaust inspection budget")), 4_000);
  t.after(() => clearTimeout(timer));
  const h = mockedDom(`<div id="productDetails_feature_div"><table>${row("Item Weight", "70 g")}</table><div class="aok-hidden"><span class="a-spinner"></span></div></div>`);
  const inspection = await h.session.inspectProductInformation(ASIN, { signal: controller.signal });
  assert.equal(inspection.status, "complete");
  assert.ok(inspection.sections.every(section => !section.busy));
  assert.equal(inspection.rowCount, 1);
});
