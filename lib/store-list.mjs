import { readSheet } from "read-excel-file/node";
import { unzipSync, strFromU8 } from "fflate";
import { load } from "cheerio";
import { posix } from "node:path";

export const MAX_STORE_FILE_BYTES = 5 * 1024 * 1024;

const HEADER_ALIASES = new Map([
  ["sellerurl", "sellerUrl"],
  ["店铺链接", "sellerUrl"],
  ["卖家链接", "sellerUrl"],
  ["sellerid", "sellerId"],
  ["卖家id", "sellerId"],
  ["sellername", "sellerName"],
  ["店铺名", "sellerName"],
  ["卖家名称", "sellerName"],
  ["asins", "asins"],
  ["asin", "asins"],
  ["父asin", "asins"],
  ["marketplace", "marketplace"],
  ["market", "marketplace"],
  ["站点", "marketplace"],
  ["国家", "marketplace"],
  ["亚马逊站点", "marketplace"],
  ["amazonsite", "marketplace"],
  ["monthlysalesband", "monthlySalesBand"],
  ["月销量档", "monthlySalesBand"],
  ["月销量档位", "monthlySalesBand"],
  ["月销量", "monthlySalesBand"],
  ["amazon月销量", "monthlySalesBand"],
  ["minreviews", "minReviews"],
  ["最低评价数", "minReviews"],
  ["最低评价数量", "minReviews"],
  ["最低评论数", "minReviews"],
  ["minrating", "minRating"],
  ["最低星级", "minRating"],
  ["最低评价星级", "minRating"],
  ["最低评分", "minRating"],
  ["minprofitmargin", "minProfitMargin"],
  ["minprofitmarginpct", "minProfitMargin"],
  ["最低利润率", "minProfitMargin"],
  ["最低利润率%", "minProfitMargin"],
  ["最低利润率(%)", "minProfitMargin"],
]);

const CRITERIA_FIELDS = Object.freeze(["monthlySalesBand", "minReviews", "minRating", "minProfitMargin"]);

const SELLER_ID_PATTERN = /^[A-Z0-9]{8,20}$/;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const MARKETPLACE_CONFIGS = Object.freeze({
  AU: Object.freeze({
    code: "AU",
    domain: "amazon.com.au",
    hosts: new Set(["amazon.com.au", "www.amazon.com.au"]),
  }),
  US: Object.freeze({
    code: "US",
    domain: "amazon.com",
    hosts: new Set(["amazon.com", "www.amazon.com"]),
  }),
  NL: Object.freeze({
    code: "NL",
    domain: "amazon.nl",
    hosts: new Set(["amazon.nl", "www.amazon.nl"]),
  }),
  CA: Object.freeze({
    code: "CA",
    domain: "amazon.ca",
    hosts: new Set(["amazon.ca", "www.amazon.ca"]),
  }),
  UK: Object.freeze({
    code: "UK",
    domain: "amazon.co.uk",
    hosts: new Set(["amazon.co.uk", "www.amazon.co.uk"]),
  }),
  DE: Object.freeze({
    code: "DE",
    domain: "amazon.de",
    hosts: new Set(["amazon.de", "www.amazon.de"]),
  }),
  FR: Object.freeze({
    code: "FR",
    domain: "amazon.fr",
    hosts: new Set(["amazon.fr", "www.amazon.fr"]),
  }),
  IT: Object.freeze({
    code: "IT",
    domain: "amazon.it",
    hosts: new Set(["amazon.it", "www.amazon.it"]),
  }),
  ES: Object.freeze({
    code: "ES",
    domain: "amazon.es",
    hosts: new Set(["amazon.es", "www.amazon.es"]),
  }),
  PL: Object.freeze({
    code: "PL",
    domain: "amazon.pl",
    hosts: new Set(["amazon.pl", "www.amazon.pl"]),
  }),
  MX: Object.freeze({
    code: "MX",
    domain: "amazon.com.mx",
    hosts: new Set(["amazon.com.mx", "www.amazon.com.mx"]),
  }),
  BR: Object.freeze({
    code: "BR",
    domain: "amazon.com.br",
    hosts: new Set(["amazon.com.br", "www.amazon.com.br"]),
  }),
});

export class StoreListError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreListError";
    this.code = code;
  }
}

export async function parseStoreListBuffer(input, { fileName = "stores.xlsx", marketplace = "AU", detectMarketplace = false } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  validateWorkbook(buffer, fileName);
  const market = requireMarketplace(marketplace);

  let rows;
  try {
    rows = await readSheet(buffer);
  } catch {
    throw new StoreListError("INVALID_XLSX", "The workbook could not be parsed as an XLSX file.");
  }
  if (!Array.isArray(rows)) {
    throw new StoreListError("INVALID_XLSX", "The workbook did not contain a readable first sheet.");
  }

  return parseStoreRows(rows, { marketplace: market.code, detectMarketplace, percentageCells: workbookPercentageCells(buffer) });
}

export function parseStoreRows(rows, { marketplace = "AU", detectMarketplace = false, percentageCells = new Set() } = {}) {
  const selectedMarket = requireMarketplace(marketplace);
  const header = detectHeader(rows[0]);
  const market = detectMarketplace
    ? detectImportMarketplace(rows, header, percentageCells, selectedMarket)
    : selectedMarket;
  const startIndex = header ? 1 : 0;
  const records = new Map();
  const issues = [];
  const rejectedRows = [];
  const marketplaceGroups = new Map();
  let rawRows = 0;
  let duplicates = 0;
  let repaired = 0;
  let invalid = 0;

  for (let index = startIndex; index < rows.length; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    if (isEmptyRow(row)) continue;
    rawRows += 1;
    const rowNumber = index + 1;
    const rawRecord = storeRecordFromRow(row, header);

    const rowMarket = marketplaceFromCell(rawRecord.marketplace);
    const urlMarket = marketplaceFromUrl(rawRecord.sellerUrl);
    const declaredMarketplace = rowMarket?.code || (hasCellValue(rawRecord.marketplace) ? "unsupported" : urlMarket?.code || market.code);
    const group = marketplaceGroups.get(declaredMarketplace) || {
      marketplace: declaredMarketplace, rowNumbers: [], acceptedRows: 0, rejectedRows: 0,
      requiresSeparateBatch: declaredMarketplace !== market.code,
    };
    group.rowNumbers.push(rowNumber);
    marketplaceGroups.set(declaredMarketplace, group);
    const rejectRow = (code, message) => {
      issues.push({ rowNumber, code, message });
      rejectedRows.push({ rowNumber, code, marketplace: declaredMarketplace, rawRecord: { ...rawRecord }, message });
      group.rejectedRows += 1;
      invalid += 1;
    };
    if (hasCellValue(rawRecord.marketplace) && !rowMarket) {
      rejectRow("UNSUPPORTED_ROW_MARKETPLACE", "The row marketplace is not recognized; supported sites are AU, US, NL, CA, UK, DE, FR, IT, ES, PL, MX, and BR.");
      continue;
    }
    if (rowMarket && urlMarket && rowMarket.code !== urlMarket.code) {
      rejectRow("ROW_MARKETPLACE_URL_MISMATCH", `The row declares ${rowMarket.code}, but sellerUrl belongs to ${urlMarket.code}.`);
      continue;
    }
    if (rowMarket && rowMarket.code !== market.code) {
      rejectRow("MARKETPLACE_MISMATCH", `The row belongs to Amazon ${rowMarket.code}, but this batch is ${market.code}; import it in a separate ${rowMarket.code} batch.`);
      continue;
    }
    const marginIsPercentage = percentageCells.has(`${rowNumber}:${header?.minProfitMargin}`);
    const parsedCriteria = parseRowCriteria(rawRecord, header, rows[0], { marginIsPercentage });
    if (parsedCriteria.error) {
      rejectRow(parsedCriteria.error.code, parsedCriteria.error.message);
      continue;
    }
    const parsed = parseStoreRecord(rawRecord, rowNumber, issues, market);
    if (!parsed) {
      invalid += 1;
      group.rejectedRows += 1;
      const issue = issues.filter((item) => item.rowNumber === rowNumber).at(-1);
      rejectedRows.push({ rowNumber, code: issue?.code || "INVALID_ROW", marketplace: declaredMarketplace, rawRecord: { ...rawRecord }, message: issue?.message || "The row could not be imported." });
      continue;
    }
    if (parsed.repaired) repaired += 1;
    group.acceptedRows += 1;
    const criteriaRow = {
      rowNumber,
      marketplace: market.code,
      marketplaceSource: rowMarket ? "row" : urlMarket ? "seller_url" : detectMarketplace && market.code !== selectedMarket.code ? "detected_batch" : "selected_batch",
      criteria: parsedCriteria.criteria,
      rawCriteria: Object.fromEntries(CRITERIA_FIELDS.map((field) => [field, cellValue(rawRecord[field])])),
      cellUnits: { minProfitMargin: marginIsPercentage ? "excel_percentage_fraction" : null },
    };

    const key = storeIdentity(parsed, rowNumber);
    const existing = records.get(key);
    if (existing) {
      duplicates += 1;
      existing.rowNumbers.push(rowNumber);
      existing.criteriaSource.rows.push(criteriaRow);
      if (JSON.stringify(existing.criteria) !== JSON.stringify(parsedCriteria.criteria)) {
        existing.importBlocked = true;
        const message = "Duplicate rows for the same store contain different filter criteria; resolve the conflicting rows before collecting this store.";
        issues.push({ rowNumber, code: "DUPLICATE_STORE_CRITERIA_CONFLICT", message, conflictingRowNumbers: [...existing.rowNumbers] });
        rejectedRows.push({ rowNumber, code: "DUPLICATE_STORE_CRITERIA_CONFLICT", marketplace: market.code, rawRecord: { ...rawRecord }, message });
        invalid += 1;
        group.acceptedRows -= 1;
        group.rejectedRows += 1;
      }
      existing.asins = uniqueStrings([...existing.asins, ...parsed.asins]);
      if (!existing.sellerName && parsed.sellerName) existing.sellerName = parsed.sellerName;
      if (!existing.sellerId && parsed.sellerId) existing.sellerId = parsed.sellerId;
      if (!existing.sellerUrl && parsed.sellerUrl) existing.sellerUrl = parsed.sellerUrl;
      continue;
    }

    records.set(key, {
      marketplace: market.code,
      sellerId: parsed.sellerId,
      sellerName: parsed.sellerName,
      sellerUrl: parsed.sellerUrl,
      asins: parsed.asins,
      rowNumbers: [rowNumber],
      criteria: parsedCriteria.criteria,
      criteriaSource: { schemaVersion: "1.0", marginUnit: "percent", rows: [criteriaRow] },
      importBlocked: false,
    });
  }

  const stores = [...records.values()].map((store) => ({
    ...store,
    resolved: !store.importBlocked && Boolean(store.sellerId || store.sellerName || store.asins.length),
  }));
  const resolved = stores.filter((store) => store.resolved).length;

  return {
    audit: {
      rawRows,
      uniqueSellers: stores.length,
      duplicates,
      repaired,
      invalid,
      resolved,
      unresolved: stores.length - resolved,
      marketplace: market.code,
      marketplaceDomain: market.domain,
      detectedMarketplaces: [...marketplaceGroups.keys()],
      requiresSeparateBatches: !detectMarketplace && [...marketplaceGroups.values()].some((group) => group.requiresSeparateBatch),
      criteriaConflictStores: stores.filter((store) => store.importBlocked).length,
    },
    stores,
    issues,
    rejectedRows,
    marketplaceGroups: [...marketplaceGroups.values()],
  };
}

function storeRecordFromRow(row, header) {
  return header
    ? {
        sellerUrl: cellValue(row[header.sellerUrl]),
        sellerId: cellValue(row[header.sellerId]),
        sellerName: cellValue(row[header.sellerName]),
        asins: cellValue(row[header.asins]),
        marketplace: cellValue(row[header.marketplace]),
        ...Object.fromEntries(CRITERIA_FIELDS.map((field) => [field, cellValue(row[header[field]])])),
      }
    : { sellerUrl: cellValue(row[0]), sellerId: null, sellerName: null, asins: null };
}

function detectImportMarketplace(rows, header, percentageCells, selectedMarket) {
  const markets = new Map();
  for (let index = header ? 1 : 0; index < rows.length; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    if (isEmptyRow(row)) continue;
    const record = storeRecordFromRow(row, header);
    const rowMarket = marketplaceFromCell(record.marketplace);
    const urlMarket = marketplaceFromUrl(record.sellerUrl);
    if (hasCellValue(record.marketplace) && !rowMarket) continue;
    if (rowMarket && urlMarket && rowMarket.code !== urlMarket.code) continue;
    const market = urlMarket || rowMarket;
    if (!market) continue;
    const rowNumber = index + 1;
    const criteria = parseRowCriteria(record, header, rows[0], {
      marginIsPercentage: percentageCells.has(`${rowNumber}:${header?.minProfitMargin}`),
    });
    // Invalid rows must not switch the batch or create a false mixed-market error.
    if (criteria.error || !parseStoreRecord(record, rowNumber, [], market)) continue;
    markets.set(market.code, market);
  }
  if (markets.size > 1) {
    const codes = [...markets.keys()].sort();
    throw new StoreListError("MIXED_MARKETPLACES", `The workbook contains multiple Amazon marketplaces (${codes.join(", ")}); upload a separate workbook for each marketplace.`);
  }
  // Rows without country evidence inherit the file's single detected marketplace.
  return markets.values().next().value || selectedMarket;
}

function hasCellValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function marketplaceFromCell(value) {
  const text = String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
  const aliases = {
    au: "AU", aus: "AU", australia: "AU", 澳洲: "AU", 澳洲站: "AU", 澳大利亚: "AU", 澳大利亚站: "AU",
    us: "US", usa: "US", unitedstates: "US", 美国: "US", 美国站: "US",
    nl: "NL", nld: "NL", netherlands: "NL", 荷兰: "NL", 荷兰站: "NL",
    ca: "CA", can: "CA", canada: "CA", 加拿大: "CA", 加拿大站: "CA",
    uk: "UK", gb: "UK", gbr: "UK", unitedkingdom: "UK", 英国: "UK", 英国站: "UK",
    de: "DE", deu: "DE", germany: "DE", 德国: "DE", 德国站: "DE",
    fr: "FR", fra: "FR", france: "FR", 法国: "FR", 法国站: "FR",
    it: "IT", ita: "IT", italy: "IT", 意大利: "IT", 意大利站: "IT",
    es: "ES", esp: "ES", spain: "ES", 西班牙: "ES", 西班牙站: "ES",
    pl: "PL", pol: "PL", poland: "PL", 波兰: "PL", 波兰站: "PL",
    mx: "MX", mex: "MX", mexico: "MX", 墨西哥: "MX", 墨西哥站: "MX",
    br: "BR", bra: "BR", brazil: "BR", 巴西: "BR", 巴西站: "BR",
  };
  return MARKETPLACE_CONFIGS[aliases[text]] || marketplaceFromUrl(text);
}

function marketplaceFromUrl(value) {
  if (!hasCellValue(value)) return null;
  let candidate = String(value).normalize("NFKC").trim();
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate.replace(/^\/+/, "")}`;
  try { return marketplaceForHost(new URL(candidate).hostname); } catch { return null; }
}

function parseRowCriteria(record, header, headerRow, { marginIsPercentage = false } = {}) {
  const criteria = Object.fromEntries(CRITERIA_FIELDS.map((field) => [field, null]));
  for (const field of CRITERIA_FIELDS) {
    const value = record[field];
    if (!hasCellValue(value)) continue;
    if (field === "monthlySalesBand") {
      const band = normalizeMonthlySalesBand(value);
      if (!band) return { error: { code: "INVALID_MONTHLY_SALES_BAND", message: "monthlySalesBand must be all, under_50, 50_to_100, or 100_plus (or the corresponding Chinese sales band)." } };
      criteria[field] = band;
      continue;
    }
    const text = String(value).normalize("NFKC").trim();
    const hasPercent = /%$/.test(text);
    const numericText = hasPercent ? text.slice(0, -1).trim() : text;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numericText) || (hasPercent && field !== "minProfitMargin")) {
      return { error: { code: "INVALID_STORE_CRITERIA", message: `${field} must contain a number${field === "minProfitMargin" ? " in percent" : ""}.` } };
    }
    const cellNumber = Number(numericText);
    const number = field === "minProfitMargin" && marginIsPercentage && !hasPercent
      ? Number((cellNumber * 100).toPrecision(15)) : cellNumber;
    if (!Number.isFinite(number)
      || (field === "minReviews" && (number < 0 || !Number.isSafeInteger(number)))
      || (field === "minRating" && (number < 0 || number > 5))
      || (field === "minProfitMargin" && (number < -100 || number > 100))) {
      return { error: { code: "INVALID_STORE_CRITERIA", message: `${field} is outside its supported range.` } };
    }
    const marginHeader = field === "minProfitMargin" ? normalizeHeader(headerRow?.[header?.[field]]) : "";
    const explicitlyPercent = hasPercent || marginIsPercentage || marginHeader.includes("%") || marginHeader.endsWith("pct");
    if (field === "minProfitMargin" && !explicitlyPercent && number !== 0 && Math.abs(number) < 1) {
      return { error: { code: "AMBIGUOUS_PROFIT_MARGIN_UNIT", message: "Fractional minProfitMargin is ambiguous. Write 20% for a twenty-percent minimum, or label the column minProfitMarginPct for percentage-point values." } };
    }
    criteria[field] = number;
  }
  return { criteria };
}

function normalizeMonthlySalesBand(value) {
  const text = String(value).normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "").replace(/[–—~～]/g, "-");
  if (["all", "全部", "不限", "全部销量"].includes(text)) return "all";
  if (["under_50", "<50", "小于50", "小于50(不到50)", "0-49"].includes(text)) return "under_50";
  if (["50_to_100", "50+", "50-100", "50-<100", "50+(50-100)", "50+(50-<100)"].includes(text)) return "50_to_100";
  if (["100_plus", "100+", ">=100", "≥100", "100以上", "100+(100以上)", "100+(≥100)"].includes(text)) return "100_plus";
  return null;
}

function workbookPercentageCells(buffer) {
  const cells = new Set();
  try {
    const files = unzipSync(buffer, { filter: ({ name }) => ["xl/styles.xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"].includes(name) || /^xl\/worksheets\/[^/]+\.xml$/.test(name) });
    if (!files["xl/styles.xml"] || !files["xl/workbook.xml"] || !files["xl/_rels/workbook.xml.rels"]) return cells;
    const styles = load(strFromU8(files["xl/styles.xml"]), { xml: true });
    const percentageFormats = new Set([9, 10]);
    styles("numFmt").each((_index, element) => {
      const format = String(styles(element).attr("formatCode") || "").replace(/"[^"]*"/g, "").replace(/\\./g, "");
      if (format.includes("%")) percentageFormats.add(Number(styles(element).attr("numFmtId")));
    });
    const percentageStyles = new Set();
    styles("cellXfs > xf").each((index, element) => {
      if (percentageFormats.has(Number(styles(element).attr("numFmtId")))) percentageStyles.add(index);
    });
    if (!percentageStyles.size) return cells;
    const workbook = load(strFromU8(files["xl/workbook.xml"]), { xml: true });
    const relationshipId = workbook("sheets > sheet").first().attr("r:id");
    const relationships = load(strFromU8(files["xl/_rels/workbook.xml.rels"]), { xml: true });
    let target = null;
    relationships("Relationship").each((_index, element) => {
      if (relationships(element).attr("Id") === relationshipId) target = relationships(element).attr("Target");
    });
    if (!target) return cells;
    const sheetPath = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join("xl", target));
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath) || !files[sheetPath]) return cells;
    const sheet = load(strFromU8(files[sheetPath]), { xml: true });
    sheet("sheetData c").each((_index, element) => {
      if (!percentageStyles.has(Number(sheet(element).attr("s")))) return;
      const match = /^([A-Z]+)(\d+)$/.exec(sheet(element).attr("r") || "");
      if (!match) return;
      const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      cells.add(`${Number(match[2])}:${column}`);
    });
  } catch {
    // Ambiguous fractional values remain rejected by parseRowCriteria if style metadata is unavailable.
  }
  return cells;
}

function validateWorkbook(buffer, fileName) {
  if (!buffer.length) throw new StoreListError("EMPTY_FILE", "The uploaded workbook is empty.");
  if (buffer.length > MAX_STORE_FILE_BYTES) {
    throw new StoreListError("FILE_TOO_LARGE", "The workbook exceeds the 5 MB limit.");
  }
  const decodedName = decodeFileName(fileName);
  if (!decodedName.toLowerCase().endsWith(".xlsx")) {
    throw new StoreListError("UNSUPPORTED_FILE_TYPE", "Only .xlsx workbooks are supported.");
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new StoreListError("INVALID_XLSX", "The uploaded body is not an XLSX workbook.");
  }
}

function detectHeader(row) {
  if (!Array.isArray(row)) return null;
  const indexes = {};
  row.forEach((value, index) => {
    const key = HEADER_ALIASES.get(normalizeHeader(value));
    if (key && indexes[key] === undefined) indexes[key] = index;
  });
  return Object.keys(indexes).length ? indexes : null;
}

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function parseStoreRecord(record, rowNumber, issues, market) {
  let sellerId = normalizeSellerId(record.sellerId);
  const sellerName = normalizeText(record.sellerName, 200);
  const parsedAsins = parseAsins(record.asins);
  const asins = parsedAsins.asins;
  for (let index = 0; index < parsedAsins.invalidCount; index += 1) {
    issues.push({ rowNumber, code: "INVALID_ASIN", message: "An invalid ASIN value was ignored." });
  }
  let sellerUrl = null;
  let repaired = false;

  if (record.sellerUrl) {
    const parsedUrl = parseSellerUrl(record.sellerUrl, market);
    if (parsedUrl.ok) {
      sellerUrl = parsedUrl.url;
      repaired = parsedUrl.repaired;
      if (sellerId && parsedUrl.sellerId && sellerId !== parsedUrl.sellerId) {
        issues.push({ rowNumber, code: "SELLER_ID_MISMATCH", message: "sellerId does not match the ID in sellerUrl; the explicit sellerId was kept." });
      } else if (!sellerId) {
        sellerId = parsedUrl.sellerId;
      }
    } else {
      issues.push({ rowNumber, code: parsedUrl.code, message: parsedUrl.message });
      return null;
    }
  }

  if (record.sellerId && !sellerId) {
    issues.push({ rowNumber, code: "INVALID_SELLER_ID", message: "sellerId must be 8 to 20 uppercase letters or digits." });
  }

  if (!sellerId && !sellerName && !asins.length) {
    issues.push({ rowNumber, code: "UNRESOLVED_ROW", message: "The row has no valid sellerId, sellerName, or ASIN." });
    return null;
  }

  return { sellerId, sellerName, sellerUrl, asins, repaired };
}

function parseSellerUrl(value, market) {
  let candidate = String(value).normalize("NFKC").trim();
  if (!candidate) return { ok: false, code: "EMPTY_SELLER_URL", message: "sellerUrl is empty." };
  if (/^\/\//.test(candidate)) candidate = `https:${candidate}`;
  let repaired = false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, "")}`;
    repaired = true;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, code: "INVALID_SELLER_URL", message: "sellerUrl is not a valid URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "INVALID_SELLER_URL", message: "sellerUrl must use HTTP or HTTPS." };
  }
  if (url.username || url.password || url.port) {
    return { ok: false, code: "INVALID_SELLER_URL", message: "sellerUrl must not contain credentials or a non-default port." };
  }
  const detectedMarket = marketplaceForHost(url.hostname);
  if (!detectedMarket) {
    return { ok: false, code: "INVALID_SELLER_URL", message: "sellerUrl must use a recognized Amazon host." };
  }
  if (detectedMarket.code !== market.code) {
    return {
      ok: false,
      code: "MARKETPLACE_MISMATCH",
      message: `sellerUrl belongs to Amazon ${detectedMarket.code}, but the selected marketplace is ${market.code}.`,
    };
  }

  const query = new Map([...url.searchParams.entries()].map(([key, entry]) => [key.toLowerCase(), entry]));
  const sellerId = normalizeSellerId(query.get("me") || query.get("seller") || query.get("merchant"));
  return {
    ok: true,
    repaired,
    sellerId,
    url: url.toString(),
  };
}

function requireMarketplace(value) {
  const code = String(value ?? "").trim().toUpperCase();
  const market = MARKETPLACE_CONFIGS[code];
  if (!market) throw new StoreListError("UNSUPPORTED_MARKETPLACE", "Unsupported marketplace; use one of AU, US, NL, CA, UK, DE, FR, IT, ES, PL, MX, BR.");
  return market;
}

function marketplaceForHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return Object.values(MARKETPLACE_CONFIGS).find((market) => market.hosts.has(normalized)) || null;
}

function normalizeSellerId(value) {
  const normalized = normalizeText(value, 20)?.toUpperCase() || null;
  return normalized && SELLER_ID_PATTERN.test(normalized) ? normalized : null;
}

function parseAsins(value) {
  if (Array.isArray(value)) return classifyAsinTokens(value);
  const text = normalizeText(value, 5_000);
  if (!text) return { asins: [], invalidCount: 0 };
  return classifyAsinTokens(text.split(/[\s,;|，；]+/));
}

function classifyAsinTokens(tokens) {
  const normalized = tokens.map(normalizeAsin);
  return {
    asins: uniqueStrings(normalized.filter(Boolean)),
    invalidCount: normalized.filter((value) => !value).length,
  };
}

function normalizeAsin(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().toUpperCase();
  return ASIN_PATTERN.test(normalized) ? normalized : null;
}

function storeIdentity(store, rowNumber) {
  if (store.sellerId) return `id:${store.sellerId}`;
  if (store.sellerName) return `name:${store.sellerName.toLocaleLowerCase("en-US")}`;
  return `asins:${store.asins.slice().sort().join(",") || rowNumber}`;
}

function cellValue(value) {
  return value === undefined || value === null ? null : value;
}

function normalizeText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).normalize("NFC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function decodeFileName(value) {
  const text = String(value || "stores.xlsx").slice(0, 512);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function isEmptyRow(row) {
  return row.every((value) => value === null || value === undefined || String(value).trim() === "");
}
