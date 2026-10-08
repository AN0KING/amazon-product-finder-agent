const MAX_PIECE_COUNT = 10_000;

export const TITLE_PIECE_COUNT_RULE_VERSION = "amazon-title-piece-count-v1";

export function normalizePieceCount(value, fallback = null) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PIECE_COUNT) return fallback;
  return number;
}

export function calculatePieceAdjustedPurchaseCostCny(unitCostCny, pieceCount) {
  if (unitCostCny === null || unitCostCny === undefined || (typeof unitCostCny === 'string' && !unitCostCny.trim())) return null;
  const unitCost = Number(unitCostCny);
  const count = normalizePieceCount(pieceCount);
  if (!Number.isFinite(unitCost) || unitCost < 0 || count === null) return null;
  return Math.round((unitCost * count + Number.EPSILON) * 100) / 100;
}

export function extractTitlePieceCount(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return defaultResult();

  const matches = [];
  const addMatches = (pattern, priority, countFromMatch, unitFromMatch = () => "piece") => {
    for (const match of text.matchAll(pattern)) {
      const count = normalizePieceCount(countFromMatch(match));
      if (count === null) continue;
      matches.push({
        count,
        evidence: match[0].trim(),
        index: match.index ?? Number.MAX_SAFE_INTEGER,
        priority,
        unit: unitFromMatch(match),
      });
    }
  };

  addMatches(
    /\b(\d{1,5})\s*[- ]?(packs?|sets?|bundles?|boxes)\s+of\s+(\d{1,5})(?:\s*[- ]?(pieces?|pcs?|count|ct|pairs?))?\b/gi,
    120,
    (match) => Number(match[1]) * Number(match[3]),
    (match) => canonicalUnit(match[4] || match[2]),
  );
  addMatches(
    /\b(\d{1,5})\s*[- ]?(pieces?|pcs?|count|ct)\b/gi,
    110,
    (match) => match[1],
    (match) => canonicalUnit(match[2]),
  );
  addMatches(
    /\b(?:qty|quantity)\s*[:=x-]?\s*(\d{1,5})\b/gi,
    105,
    (match) => match[1],
  );
  addMatches(
    /\b(\d{1,5})\s*[- ]?(pairs?)\b/gi,
    100,
    (match) => match[1],
    () => "pair",
  );
  addMatches(
    /\b(\d{1,5})\s*[- ]?(packs?|sets?|bundles?)\b/gi,
    90,
    (match) => match[1],
    (match) => canonicalUnit(match[2]),
  );
  addMatches(
    /\b(?:pack|set|bundle|box|count)\s+of\s+(\d{1,5})\b/gi,
    80,
    (match) => match[1],
    (match) => canonicalUnit(match[0].split(/\s+/)[0]),
  );
  addMatches(
    /(\d{1,5})\s*(件套|件装|件|个装|只装|对装|对|套装|套)/g,
    110,
    (match) => match[1],
    (match) => match[2],
  );

  matches.sort((left, right) => right.priority - left.priority || left.index - right.index || right.count - left.count);
  const best = matches[0];
  if (!best) return defaultResult();
  return {
    count: best.count,
    source: "amazon_title",
    evidence: best.evidence,
    unit: best.unit,
    ruleVersion: TITLE_PIECE_COUNT_RULE_VERSION,
  };
}

function canonicalUnit(value) {
  const unit = String(value || "").toLowerCase();
  if (/pair/.test(unit)) return "pair";
  if (/pack/.test(unit)) return "pack";
  if (/set/.test(unit)) return "set";
  if (/bundle/.test(unit)) return "bundle";
  if (/box/.test(unit)) return "box";
  if (/count|\bct\b/.test(unit)) return "count";
  return "piece";
}

function defaultResult() {
  return {
    count: 1,
    source: "default",
    evidence: null,
    unit: "piece",
    ruleVersion: TITLE_PIECE_COUNT_RULE_VERSION,
  };
}
