import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { normalizeISODateOnly, todayDateOnly, matchesAmazonListingDate, extractAmazonFirstAvailableDate, mergeAmazonFirstAvailableDates } from "../lib/amazon-listing-date.mjs";
import { parseAmazonProductPage } from "../lib/amazon-store-client.mjs";

const asin = "B000000001";
const context = { asin, marketplace: "CA" };
const information = (rows, extra = {}) => ({ version: 1, asin, status: "complete", reason: null,
  rowCount: rows.length, sections: [{ selector: "#productDetails_detailBullets_sections1", heading: "Product information", rows }], ...extra });
const dateInfo = (value, label = "Date First Available") => information([{ label, value }]);
const parse = (body, marketplace = "CA") => parseAmazonProductPage(`<input id="ASIN" value="${asin}"><h1 id="productTitle">Synthetic date product</h1>${body}`, { marketplace, asin });
const table = (label, value) => `<table id="productDetails_detailBullets_sections1"><tr><th>${label}</th><td>${value}</td></tr></table>`;

test("date-only validation rejects invalid calendar dates, timestamps and ambiguous numeric formats", () => {
  for (const valid of ["2024-02-29", "2000-02-29", "2026-10-13", "0001-01-01"]) assert.equal(normalizeISODateOnly(valid), valid);
  for (const invalid of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-01-00", "0000-01-01",
    "24-01-01", "2024-1-1", "03/04/2024", "2024-10-13T00:00:00Z", "2024-02-31", null, 20241013]) assert.equal(normalizeISODateOnly(invalid), null, String(invalid));
});

test("English AU/CA, French month names and exact ISO dates normalize without losing source text", () => {
  for (const [label, rawText, expected] of [
    ["Date First Available", "13 October 2026", "2026-10-13"],
    ["Date First Available", "October 13, 2026", "2026-10-13"],
    ["Date First Available", "Sept. 5 2021", "2021-09-05"],
    ["Date First Available", "5 Sep. 2021", "2021-09-05"],
    ["Date First Available", "2024-02-29", "2024-02-29"],
    ["Date de mise en ligne sur Amazon.ca", "29 février 2024", "2024-02-29"],
    ["Date de première disponibilité", "1er août 2020", "2020-08-01"],
    ["Date de première mise en ligne", "15 déc. 2019", "2019-12-15"],
    ["Date First Available:", "\u200e12\u00a0March 2022", "2022-03-12"],
  ]) {
    const value = extractAmazonFirstAvailableDate(dateInfo(rawText, label), context);
    assert.equal(value.amazonFirstAvailableDate, expected, rawText);
    assert.equal(value.amazonFirstAvailableDateStatus, "found");
    assert.deepEqual(value.amazonFirstAvailableDateEvidence, { asin, marketplace: "CA", source: "amazon_product_information",
      label, rawText, selector: "#productDetails_detailBullets_sections1", value: expected });
  }
});

test("invalid or ambiguous date rows remain unresolved with their exact original text", () => {
  for (const rawText of ["03/04/2024", "2024/04/03", "31 April 2024", "February 29, 2023", "May 52020", "12 March2020",
    "2024", "May 2024", "Coming soon", "Not available", "00 January 2020", "2024-02-29T00:00:00Z"]) {
    const value = extractAmazonFirstAvailableDate(dateInfo(rawText), context);
    assert.equal(value.amazonFirstAvailableDate, null, rawText);
    assert.equal(value.amazonFirstAvailableDateStatus, "unresolved", rawText);
    assert.equal(value.amazonFirstAvailableDateEvidence.rawText, rawText);
    assert.equal(value.amazonFirstAvailableDateEvidence.value, null);
  }
});

test("duplicate equivalent date formats agree; conflicting or partly invalid dates stay unresolved", () => {
  const same = extractAmazonFirstAvailableDate(information([
    { label: "Date First Available", value: "5 September 2021" }, { label: "Date First Available", value: "2021-09-05" },
  ], { status: "incomplete", reason: "conflicting_values" }), context);
  assert.equal(same.amazonFirstAvailableDate, "2021-09-05");
  for (const second of ["2021-09-06", "05/09/2021"]) {
    const value = extractAmazonFirstAvailableDate(information([
      { label: "Date First Available", value: "5 September 2021" }, { label: "Date First Available", value: second },
    ]), context);
    assert.equal(value.amazonFirstAvailableDate, null);
    assert.equal(value.amazonFirstAvailableDateStatus, "unresolved");
    assert.equal(value.amazonFirstAvailableDateEvidence.candidates.length, 2);
    assert.deepEqual(value.amazonFirstAvailableDateEvidence.candidates.map(item => item.rawText), ["5 September 2021", second]);
  }
});

test("only complete same-ASIN information without the field establishes not_provided", () => {
  const complete = information([{ label: "Brand", value: "Example" }], { inspection: { version: 3, asin, status: "complete", stable: true,
    rowCount: 1, sections: [{ selector: "#productDetails_detailBullets_sections1", status: "complete", rowCount: 1 }],
    parsedSections: [{ selector: "#productDetails_detailBullets_sections1", rowCount: 1 }] } });
  assert.equal(extractAmazonFirstAvailableDate(complete, context).amazonFirstAvailableDateStatus, "not_provided");
  for (const value of [null, { ...complete, version: 0 }, { ...complete, inspection: undefined },
    { ...complete, inspection: { ...complete.inspection, version: 2 } },
    { ...complete, inspection: { ...complete.inspection, stable: false } }, { ...complete, asin: "B000000002" }, { ...complete, rowCount: 99 },
    { ...complete, status: "incomplete" }, { ...complete, reason: "asin_mismatch" }, { ...complete, sections: [] },
    information([]), { ...complete, sections: [{ rows: complete.sections[0].rows }] }]) {
    assert.equal(extractAmazonFirstAvailableDate(value, context).amazonFirstAvailableDateStatus, "unresolved");
  }
  assert.equal(extractAmazonFirstAvailableDate({ ...dateInfo("2020-06-12"), asin: "B000000002" }, context).amazonFirstAvailableDate, null);
});

test("a real HTML fixture without a date remains unresolved until browser completeness is verified", () => {
  const fixture = readFileSync(new URL("./fixtures/amazon-b08pszmzrq-product-information.html", import.meta.url), "utf8");
  const value = parseAmazonProductPage(fixture, { marketplace: "AU", asin: "B08PSZMZRQ" });
  assert.equal(value.productInformation.rowCount, 23);
  assert.equal(value.productWeightKg, 0.02);
  assert.equal(value.amazonFirstAvailableDate, null);
  assert.equal(value.amazonFirstAvailableDateStatus, "unresolved");
  assert.equal(value.amazonFirstAvailableDateEvidence, null);
});

test("scoped table and bullet date rows are parsed; comments, ranks, scripts, descriptions and recommendations are excluded", () => {
  const direct = parse(table("Date First Available", "17 June 2020"), "AU");
  assert.equal(direct.amazonFirstAvailableDate, "2020-06-17");
  assert.equal(direct.amazonFirstAvailableDateEvidence.marketplace, "AU");
  assert.equal(direct.fieldSources.amazonFirstAvailableDate, "amazon_product_information");
  const bullet = parse('<div id="detailBullets_feature_div"><ul><li><b>Date de mise en ligne sur Amazon.ca :</b> 17 juin 2020</li></ul></div>');
  assert.equal(bullet.amazonFirstAvailableDate, "2020-06-17");
  for (const content of [
    '<div id="productDescription">Date First Available: 17 June 2020</div>',
    '<div data-hook="review">Date First Available: 17 June 2020</div>',
    '<script type="application/ld+json">{"datePublished":"2020-06-17"}</script>',
    table("Best Sellers Rank", "Date First Available: 17 June 2020"),
    '<div hidden>' + table("Date First Available", "17 June 2020") + '</div>',
    '<div id="recommendations">' + table("Date First Available", "17 June 2020") + '</div>',
  ]) assert.equal(parse(content).amazonFirstAvailableDate, null, content);
  assert.equal(direct.listingAvailableAt, undefined);
});

test("a valid date in an incomplete information section is retained without pretending other fields are complete", () => {
  const result = parse(table("Date First Available", "2020-06-17") + '<div id="prodDetails"></div>');
  assert.equal(result.productInformation.status, "incomplete");
  assert.equal(result.amazonFirstAvailableDateStatus, "found");
  assert.equal(result.amazonFirstAvailableDate, "2020-06-17");
});

test("listing-date filtering includes both calendar endpoints and excludes unknown, future and reversed ranges", () => {
  for (const value of ["2024-01-01", "2024-05-10", "2024-10-13"]) assert.equal(matchesAmazonListingDate(value, "2024-01-01", "2024-10-13"), true);
  for (const value of [null, "", "2023-12-31", "2024-10-14", "2024-02-31", "2024-10-13T01:00:00Z"]) assert.equal(matchesAmazonListingDate(value, "2024-01-01", "2024-10-13"), false);
  assert.equal(matchesAmazonListingDate(null, "", "2024-10-13"), true);
  assert.equal(matchesAmazonListingDate("2024-06-01", "2024-07-01", "2024-01-01"), false);
  assert.equal(matchesAmazonListingDate("2024-06-01", "invalid", "2024-10-13"), false);
  assert.equal(todayDateOnly(new Date(NaN)), null);
});

test("today uses the local calendar rather than UTC at opposite timezone day boundaries", () => {
  const moduleUrl = new URL("../lib/amazon-listing-date.mjs", import.meta.url).href;
  const source = `import {todayDateOnly} from ${JSON.stringify(moduleUrl)}; process.stdout.write(todayDateOnly(new Date('2024-10-13T10:30:00.000Z')));`;
  for (const [zone, expected] of [["Pacific/Honolulu", "2024-10-13"], ["Pacific/Kiritimati", "2024-10-14"]]) {
    const actual = execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: { ...process.env, TZ: zone } });
    assert.equal(actual, expected, zone);
  }
});


test("previous unresolved date evidence survives a later consistent or absent row", () => {
  for (const initial of [dateInfo("03/04/2020"), information([{label: "Date First Available", value: "17 June 2020"}, {label: "Date First Available", value: "18 June 2020"}])]) {
    const original = extractAmazonFirstAvailableDate(initial, context);
    const later = extractAmazonFirstAvailableDate(dateInfo("17 June 2020"), context);
    const merged = mergeAmazonFirstAvailableDates(original, later);
    assert.equal(merged.amazonFirstAvailableDate, null);
    assert.equal(merged.amazonFirstAvailableDateStatus, "unresolved");
    assert.ok(merged.amazonFirstAvailableDateEvidence.candidates.length >= 2);
  }
});

test("unknown first-available labels remain evidence to review instead of claiming absence", () => {
  const result = extractAmazonFirstAvailableDate(dateInfo("17 June 2020", "First Available Date (new layout)"), context);
  assert.equal(result.amazonFirstAvailableDateStatus, "unresolved");
  assert.equal(result.amazonFirstAvailableDateEvidence.rawText, "17 June 2020");
});


test("German and Dutch first-available labels retain untranslated date evidence instead of reporting absence", () => {
  for (const [marketplace, label, rawText] of [["DE", "Im Angebot von Amazon.de seit", "17. Oktober 2020"],
    ["NL", "Datum eerste beschikbaarheid", "17 oktober 2020"]]) {
    const result = parse(table(label, rawText), marketplace);
    assert.equal(result.amazonFirstAvailableDateStatus, "unresolved");
    assert.equal(result.amazonFirstAvailableDate, null);
    assert.equal(result.amazonFirstAvailableDateEvidence.label, label);
    assert.equal(result.amazonFirstAvailableDateEvidence.rawText, rawText);
    const body = table("Brand", "Example");
    const proof = { version: 3, asin, status: "complete", stable: true, rowCount: 1,
      sections: [{ selector: "#productDetails_detailBullets_sections1", status: "complete", rowCount: 1 }],
      parsedSections: [{ selector: "#productDetails_detailBullets_sections1", rowCount: 1 }] };
    const missing = parseAmazonProductPage(`<input id="ASIN" value="${asin}">${body}`, { marketplace, asin, informationInspection: proof });
    assert.equal(missing.amazonFirstAvailableDateStatus, "unresolved", "DOM completeness cannot prove absence in an unsupported marketplace language");
    const translated = parseAmazonProductPage(`<html lang="de"><body><input id="ASIN" value="${asin}">${body}</body></html>`, {marketplace: "AU", asin, informationInspection: proof});
    assert.equal(translated.amazonFirstAvailableDateStatus, "unresolved", "An unsupported page language takes precedence over the marketplace default");
    const english = parse(table("Date First Available", "17 June 2020"), marketplace);
    assert.equal(english.amazonFirstAvailableDate, "2020-06-17", "Known explicit evidence remains usable in every marketplace");
  }
});
