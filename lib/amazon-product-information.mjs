// Structural HTML can prove a field is present. Absence additionally needs a
// bounded browser inspection of every observed information panel after loading.
export const AMAZON_INFORMATION_INSPECTION_VERSION = 3;
export const AMAZON_SEARCH_POLICY = 'v0.9.50-single-page';

export function hasCompleteProductInformationInspection(information, asin = information?.asin) {
  const expected = String(asin || "").trim().toUpperCase();
  const inspection = information?.inspection;
  if (!/^[A-Z0-9]{10}$/.test(expected) || information?.version !== 1 || information.asin !== expected
    || information.status !== "complete" || information.reason
    || inspection?.version !== AMAZON_INFORMATION_INSPECTION_VERSION || inspection.asin !== expected
    || inspection.status !== "complete" || inspection.stable !== true
    || !Number.isSafeInteger(information.rowCount) || information.rowCount < 1
    || inspection.rowCount !== information.rowCount
    || !Array.isArray(information.sections) || !information.sections.length
    || !Array.isArray(inspection.sections) || !inspection.sections.length
    || !Array.isArray(inspection.parsedSections) || !inspection.parsedSections.length) return false;
  const validSection = section => section && typeof section.selector === "string" && section.selector.trim();
  if (inspection.sections.some(section => !validSection(section) || section.status !== "complete"
    || !Number.isSafeInteger(section.rowCount) || section.rowCount < 1 || section.busy || section.closed)) return false;
  if (information.sections.some(section => !validSection(section) || !Array.isArray(section.rows) || !section.rows.length
    || section.rows.some(row => !row || typeof row.label !== "string" || !row.label.trim()
      || typeof row.value !== "string" || !row.value.trim()))) return false;
  if (inspection.parsedSections.some(section => !validSection(section) || !Number.isSafeInteger(section.rowCount) || section.rowCount < 1)) return false;
  const coverage = new Map(inspection.parsedSections.map(section => [section.selector, section.rowCount]));
  if (coverage.size !== inspection.parsedSections.length || coverage.size !== information.sections.length
    || information.sections.some(section => coverage.get(section.selector) !== section.rows.length)) return false;
  return information.sections.reduce((count, section) => count + section.rows.length, 0) === information.rowCount;
}
