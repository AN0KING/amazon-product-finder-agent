import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parseStoreListBuffer, parseStoreRows, StoreListError } from "../lib/store-list.mjs";

const seller = "A1EXAMPLE001";
const url = (domain, id = seller) => `https://www.${domain}/sp?seller=${id}`;
const detected = (rows, options = {}) => parseStoreRows(rows, { marketplace: "AU", detectMarketplace: true, ...options });

function workbook(rows) {
  const escaped = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const sheet = rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${escaped(value ?? "")}</t></is></c>`).join("")}</row>`).join("");
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stores" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)]))));
}

test("auto-detect imports a Canadian URL while UI selects AU without rewriting the URL", () => {
  const inputUrl = url("amazon.ca");
  const result = detected([[inputUrl]]);
  assert.equal(result.audit.marketplace, "CA");
  assert.equal(result.audit.marketplaceDomain, "amazon.ca");
  assert.equal(result.audit.invalid, 0);
  assert.equal(result.audit.requiresSeparateBatches, false);
  assert.equal(result.stores[0].marketplace, "CA");
  assert.equal(result.stores[0].sellerUrl, inputUrl);
  assert.equal(result.stores[0].criteriaSource.rows[0].marketplaceSource, "seller_url");
});

test("reverse switching follows an Australian file while UI selects Canada", () => {
  const result = detected([[url("amazon.com.au")]], { marketplace: "CA" });
  assert.equal(result.audit.marketplace, "AU");
  assert.equal(result.stores[0].sellerUrl, url("amazon.com.au"));
});

test("manual parser mode keeps rejecting a URL from a different selected market", () => {
  const result = parseStoreRows([[url("amazon.ca")]], { marketplace: "AU" });
  assert.equal(result.audit.marketplace, "AU");
  assert.equal(result.stores.length, 0);
  assert.equal(result.issues[0].code, "MARKETPLACE_MISMATCH");
});

test("XLSX buffer API passes detectMarketplace through without changing its default", async () => {
  const file = workbook([["店铺链接"], [url("amazon.ca")]]);
  const auto = await parseStoreListBuffer(file, { marketplace: "AU", detectMarketplace: true });
  assert.equal(auto.audit.marketplace, "CA");
  assert.equal(auto.stores[0].sellerId, seller);
  const manual = await parseStoreListBuffer(file, { marketplace: "AU" });
  assert.equal(manual.stores.length, 0);
  assert.equal(manual.issues[0].code, "MARKETPLACE_MISMATCH");
});

test("Canadian country values are supported with or without a URL", () => {
  for (const country of ["CA", "Canada", "加拿大", "加拿大站", "amazon.ca"]) {
    const result = detected([["sellerId", "国家"], [seller, country]]);
    assert.equal(result.audit.marketplace, "CA", country);
    assert.equal(result.stores[0].criteriaSource.rows[0].marketplaceSource, "row", country);
  }
});

test("all supported country codes can identify a seller-ID-only file", () => {
  for (const market of ["AU", "US", "NL", "CA", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"]) {
    const result = detected([["sellerId", "marketplace"], [seller, market]]);
    assert.equal(result.audit.marketplace, market);
    assert.equal(result.audit.invalid, 0);
  }
});

test("identifier-only rows inherit the file's sole detected country; empty evidence uses selected country", () => {
  const result = detected([["sellerUrl", "sellerId"], [url("amazon.ca"), ""], ["", "A1EXAMPLE002"]]);
  assert.equal(result.audit.marketplace, "CA");
  assert.deepEqual(result.stores.map((store) => store.marketplace), ["CA", "CA"]);
  assert.equal(result.stores[1].criteriaSource.rows[0].marketplaceSource, "detected_batch");
  const fallback = detected([["sellerId"], [seller]], { marketplace: "DE" });
  assert.equal(fallback.audit.marketplace, "DE");
  assert.equal(fallback.stores[0].criteriaSource.rows[0].marketplaceSource, "selected_batch");
});

test("mixed valid countries reject the entire auto-detected file deterministically", () => {
  for (const rows of [
    [[url("amazon.ca")], [url("amazon.com.au")]],
    [[url("amazon.com.au")], [url("amazon.ca")]],
    [["sellerUrl", "sellerId", "国家"], [url("amazon.ca"), "", ""], ["", "A1EXAMPLE002", "US"]],
  ]) {
    assert.throws(() => detected(rows), (error) => error instanceof StoreListError
      && error.code === "MIXED_MARKETPLACES" && /separate workbook/.test(error.message));
  }
  assert.throws(() => detected([[url("amazon.ca")], [url("amazon.com.au")]]), /\(AU, CA\)/);
});

test("conflicting country declaration stays rejected instead of being overwritten", () => {
  const result = detected([["sellerUrl", "国家"], [url("amazon.ca"), "AU"]]);
  assert.equal(result.stores.length, 0);
  assert.equal(result.issues[0].code, "ROW_MARKETPLACE_URL_MISMATCH");
  assert.equal(result.rejectedRows[0].rawRecord.sellerUrl, url("amazon.ca"));
});

test("invalid and unsupported rows cannot determine or falsely mix the batch country", () => {
  const result = detected([
    ["sellerUrl", "国家", "minRating"],
    [url("amazon.ca"), "CA", 4.5],
    [url("amazon.com.au"), "AU", 99],
    [url("amazon.com"), "JP", 4],
    [url("amazon.co.jp"), "", 4],
    [url("amazon.com"), "DE", 4],
  ]);
  assert.equal(result.audit.marketplace, "CA");
  assert.equal(result.stores.length, 1);
  assert.equal(result.audit.invalid, 4);
  assert.equal(result.audit.requiresSeparateBatches, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNSUPPORTED_ROW_MARKETPLACE"));
  assert.ok(result.issues.some((issue) => issue.code === "ROW_MARKETPLACE_URL_MISMATCH"));
});

test("unsafe URLs are rejected and never select a country", () => {
  for (const unsafeUrl of [
    "ftp://www.amazon.ca/sp?seller=A1EXAMPLE001",
    "https://user:password@www.amazon.ca/sp?seller=A1EXAMPLE001",
    "https://www.amazon.ca:1234/sp?seller=A1EXAMPLE001",
    "https://www.amazon.ca.evil.invalid/sp?seller=A1EXAMPLE001",
    "https://www.amazon.ca@evil.invalid/sp?seller=A1EXAMPLE001",
  ]) {
    const result = detected([[unsafeUrl]]);
    assert.equal(result.audit.marketplace, "AU", unsafeUrl);
    assert.equal(result.stores.length, 0, unsafeUrl);
    assert.equal(result.issues[0].code, "INVALID_SELLER_URL", unsafeUrl);
  }
});

test("autodetection preserves URL repairs, deduplication and per-store criteria", () => {
  const result = detected([
    ["店铺链接", "ASIN", "最低星级", "最低利润率"],
    ["www.amazon.ca/sp?seller=A1EXAMPLE001", "B012345678", 4.5, "20%"],
    [url("amazon.ca"), "B012345679", 4.5, "20%"],
  ]);
  assert.equal(result.audit.marketplace, "CA");
  assert.equal(result.audit.repaired, 1);
  assert.equal(result.audit.duplicates, 1);
  assert.equal(result.stores[0].criteria.minRating, 4.5);
  assert.equal(result.stores[0].criteria.minProfitMargin, 20);
  assert.deepEqual(result.stores[0].asins, ["B012345678", "B012345679"]);
  assert.deepEqual(result.stores[0].rowNumbers, [2, 3]);
});

test("duplicate conflicting criteria still block the store after country detection", () => {
  const result = detected([["sellerUrl", "minRating"], [url("amazon.ca"), 4], [url("amazon.ca"), 4.5]]);
  assert.equal(result.audit.marketplace, "CA");
  assert.equal(result.stores[0].importBlocked, true);
  assert.equal(result.stores[0].resolved, false);
  assert.equal(result.issues.at(-1).code, "DUPLICATE_STORE_CRITERIA_CONFLICT");
});
