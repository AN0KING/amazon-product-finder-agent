import { hasCompleteProductInformationInspection } from "./amazon-product-information.mjs";

// Date-only values deliberately avoid Date.parse and UTC conversion. The same
// calendar rules run in the collector, saved-data projection and browser filter.
export function normalizeISODateOnly(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function todayDateOnly(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  return normalizeISODateOnly(`${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
}

export function matchesAmazonListingDate(value, startDate, endDate = todayDateOnly()) {
  if (startDate === null || startDate === undefined || startDate === "") return true;
  const date = normalizeISODateOnly(value);
  const start = normalizeISODateOnly(startDate);
  const end = normalizeISODateOnly(endDate);
  return Boolean(date && start && end && start <= end && date >= start && date <= end);
}

const MONTHS = new Map([
  [1, "january jan janvier janv"], [2, "february feb fevrier fevr fev"], [3, "march mar mars"],
  [4, "april apr avril avr"], [5, "may mai"], [6, "june jun juin"],
  [7, "july jul juillet juil"], [8, "august aug aout"], [9, "september sep sept septembre"],
  [10, "october oct octobre"], [11, "november nov novembre"], [12, "december dec decembre"],
].flatMap(([month, names]) => names.split(" ").map(name => [name, month])));

// We currently recognize English/French date labels. Other marketplaces may
// present local labels that have not been implemented: complete DOM coverage
// does not prove semantic absence in an unsupported language.
const ABSENCE_SUPPORTED_MARKETPLACES = new Set(["US", "CA", "AU", "UK", "FR"]);

function foldedText(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}|\p{Cf}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function isFirstAvailableLabel(value) {
  const label = foldedText(value).replace(/\s*[:：]\s*$/, "");
  return /^date first available(?: on amazon(?:\.[a-z.]+)?)?$/.test(label)
    || /^date de (?:premiere )?mise en ligne(?: sur amazon(?:\.[a-z.]+)?)?$/.test(label)
    || /^date de premiere disponibilite(?: sur amazon(?:\.[a-z.]+)?)?$/.test(label)
    || /^im angebot von amazon(?:\.[a-z.]+)? seit$/.test(label)
    || /^datum eerste beschikbaarheid$/.test(label);
}

function parseAvailableDate(value) {
  if (typeof value !== "string") return null;
  const text = foldedText(value);
  const iso = normalizeISODateOnly(text);
  if (iso) return iso;
  let match = text.match(/^(\d{1,2}|1er)\s+([a-z]+)\.?(?:\s*,\s*|\s+)(\d{4})$/);
  let day, month, year;
  if (match) {
    day = Number(match[1] === "1er" ? 1 : match[1]); month = MONTHS.get(match[2]); year = match[3];
  } else {
    match = text.match(/^([a-z]+)\.?\s+(\d{1,2})(?:\s*,\s*|\s+)(\d{4})$/);
    if (!match) return null;
    month = MONTHS.get(match[1]); day = Number(match[2]); year = match[3];
  }
  if (!month) return null;
  return normalizeISODateOnly(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

// Only pass the collector's scoped Product information evidence, never page
// text, scripts, reviews or SellerSprite listingAvailableAt.
export function extractAmazonFirstAvailableDate(information, { asin, marketplace } = {}) {
  const result = { amazonFirstAvailableDate: null, amazonFirstAvailableDateEvidence: null, amazonFirstAvailableDateStatus: "unresolved" };
  const expectedAsin = typeof asin === "string" ? asin.trim().toUpperCase() : "";
  const market = typeof marketplace === "string" ? marketplace.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{10}$/.test(expectedAsin) || !/^[A-Z]{2}$/.test(market)
    || information?.version !== 1 || information.asin !== expectedAsin || information.reason === "asin_mismatch"
    || !["complete", "incomplete"].includes(information.status) || !Array.isArray(information.sections)) return result;
  const candidates = [];
  let rowCount = 0;
  let validStructure = information.sections.length > 0;
  for (const section of information.sections) {
    if (!section || !Array.isArray(section.rows) || typeof section.selector !== "string" || !section.selector.trim()) {
      validStructure = false;
      continue;
    }
    if (!section.rows.length) validStructure = false;
    for (const row of section.rows) {
      rowCount += 1;
      if (!row || typeof row.label !== "string" || typeof row.value !== "string") { validStructure = false; continue; }
      if (!row.label.trim() || !row.value.trim()) validStructure = false;
      if (!isFirstAvailableLabel(row.label)) {
        if (/first.*avail|premiere.*(?:disponibil|ligne)|date.*(?:avail|ligne)|首次.*(?:上架|销售|发售)/i.test(foldedText(row.label))) {
          candidates.push({ label: row.label, rawText: row.value, selector: section.selector, value: null });
        }
        continue;
      }
      candidates.push({ label: row.label, rawText: row.value, selector: section.selector, value: parseAvailableDate(row.value) });
    }
  }
  if (!candidates.length) {
    const language = typeof information.language === "string" ? information.language.trim().toLowerCase() : "";
    const supportedLanguage = language ? /^(?:en|fr)(?:[-_]|$)/.test(language) : ABSENCE_SUPPORTED_MARKETPLACES.has(market);
    if (supportedLanguage && validStructure && rowCount > 0 && information.rowCount === rowCount
      && hasCompleteProductInformationInspection(information, expectedAsin)) result.amazonFirstAvailableDateStatus = "not_provided";
    return result;
  }
  const values = new Set(candidates.map(candidate => candidate.value));
  const found = !values.has(null) && values.size === 1;
  result.amazonFirstAvailableDateEvidence = { asin: expectedAsin, marketplace: market, source: "amazon_product_information",
    ...candidates[0], value: found ? candidates[0].value : null,
    ...(candidates.length > 1 ? { candidates } : {}) };
  if (found) {
    result.amazonFirstAvailableDate = candidates[0].value;
    result.amazonFirstAvailableDateStatus = "found";
  }
  return result;
}

// Merge evidence rather than the last transport's scalar. A previously
// ambiguous/conflicting observation cannot disappear when a later DOM omits it.
export function mergeAmazonFirstAvailableDates(first, second) {
  const results = [first, second].filter(Boolean);
  const evidence = results.flatMap(result => {
    const item = result.amazonFirstAvailableDateEvidence;
    return item ? (Array.isArray(item.candidates) ? item.candidates : [item]) : [];
  });
  if (!evidence.length) return {
    amazonFirstAvailableDate: null, amazonFirstAvailableDateEvidence: null,
    amazonFirstAvailableDateStatus: results.some(result => result.amazonFirstAvailableDateStatus === "not_provided") ? "not_provided" : "unresolved",
  };
  const unique = [...new Map(evidence.map(item => [JSON.stringify([item.selector, item.label, item.rawText, item.value]), item])).values()];
  const ambiguous = results.some(result => result.amazonFirstAvailableDateEvidence && result.amazonFirstAvailableDateStatus !== "found");
  const owners = new Set(results.filter(result => result.amazonFirstAvailableDateEvidence)
    .map(result => `${result.amazonFirstAvailableDateEvidence.asin}:${result.amazonFirstAvailableDateEvidence.marketplace}`));
  const values = new Set(unique.map(item => normalizeISODateOnly(item.value)));
  const found = !ambiguous && owners.size === 1 && !values.has(null) && values.size === 1;
  const owner = results.find(result => result.amazonFirstAvailableDateEvidence)?.amazonFirstAvailableDateEvidence;
  return { amazonFirstAvailableDate: found ? [...values][0] : null,
    amazonFirstAvailableDateStatus: found ? "found" : "unresolved",
    amazonFirstAvailableDateEvidence: { ...owner, ...unique[0], value: found ? [...values][0] : null,
      ...(unique.length > 1 ? { candidates: unique } : {}) } };
}
