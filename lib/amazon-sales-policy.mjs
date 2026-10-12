const AMAZON_SALES_SOURCES = new Set(['amazon_store_card', 'amazon_product_page']);

// Only the purchase badge for the current product supplies monthly-sales evidence.
export function amazonMonthlySalesValue(product) {
  const evidence = product?.sales30Evidence;
  if (!evidence || !AMAZON_SALES_SOURCES.has(evidence.source) || evidence.period !== 'past_month'
    || !['lower_bound', 'displayed_count'].includes(evidence.kind)
    || !Number.isSafeInteger(evidence.value) || evidence.value < 0
    || typeof evidence.rawText !== 'string' || !evidence.rawText.trim()) return null;
  const asin = String(product.sourceAsin || product.asin || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin) || String(evidence.asin || '').trim().toUpperCase() !== asin) return null;
  const value = parseAmazonMonthlySales(evidence.rawText);
  return value === evidence.value ? value : null;
}

export function hasQualifyingAmazonMonthlySales(product) {
  const value = amazonMonthlySalesValue(product);
  return value !== null && value >= 50;
}

// Badge grammars bind one purchase quantity to a one-month period. Reviews,
// lifetime totals, multi-month statements and arbitrary surrounding prose are
// deliberately not accepted as monthly-sales evidence.
const MONTHLY_PURCHASE_PATTERNS = (() => {
  const quantity = String.raw`(\d(?:[\d., ]*\d)?)\s*(k|m|b|mil|tausend|tsd\.?|千|万)?\s*\+?`;
  const month = String.raw`(?:past|last)\s+(?:(?:one|1)\s+)?month`;
  const patterns = [
    // English and Dutch product/search badges.
    String.raw`(?:over\s+)?${quantity}\s+(?:bought|purchased|ordered)\s+(?:in|during|over)\s+(?:the\s+)?${month}`,
    String.raw`(?:in\s+)?(?:the\s+)?${month}\s*[:：,-]?\s*(?:over\s+)?${quantity}\s+(?:bought|purchased|ordered)`,
    String.raw`${quantity}\s+(?:gekocht|verkocht)\s+(?:in\s+)?(?:de\s+)?afgelopen\s+maand`,
    // Localized Amazon purchase badges; no BSR-to-sales estimation.
    String.raw`(?:mehr als\s+)?${quantity}\s+(?:mal\s+)?im\s+letzten\s+Monat\s+gekauft`,
    String.raw`${quantity}\s+(?:mal\s+)?gekauft\s+im\s+letzten\s+Monat`,
    String.raw`(?:plus de\s+)?${quantity}\s+achet[ée]s?\s+(?:au cours du|dans le|le)\s+mois\s+(?:dernier|passé)`,
    String.raw`(?:più di\s+)?${quantity}\s+acquistati\s+(?:nel|lo)\s+scorso\s+mese`,
    String.raw`(?:più di\s+)?${quantity}\s+acquistati\s+(?:nel|lo)\s+mese\s+scorso`,
    String.raw`(?:más de\s+)?${quantity}\s+comprados\s+(?:en\s+)?(?:el\s+)?(?:mes\s+pasado|último\s+mes)`,
    String.raw`(?:mais de\s+)?${quantity}\s+(?:compras|comprados)\s+no\s+(?:mês\s+passado|último\s+mês)`,
    String.raw`kupiono\s+(?:ponad\s+)?${quantity}\s+razy\s+w\s+(?:zeszłym|ostatnim)\s+miesiącu`,
    String.raw`(?:过去|近)\s*(?:一|1|一个)?\s*个?月\s*(?:内|中)?\s*(?:购买|售出)\s*了?\s*${quantity}\s*(?:件|次)?\s*(?:以上)?`,
    String.raw`(?:过去|近)\s*(?:一|1|一个)?\s*个?月\s*(?:内|中)?\s*${quantity}\s*(?:件|次)?\s*(?:以上)?\s*(?:被)?(?:购买|售出)`,
    String.raw`${quantity}\s*(?:件|次)?\s*(?:以上)?\s*(?:购买|售出)\s*(?:于)?\s*(?:过去|近)\s*(?:一|1|一个)?\s*个?月`,
    String.raw`過去\s*1\s*(?:か|ケ|カ|箇)月で\s*${quantity}\s*点以上購入されました`,
  ];
  return patterns.map(pattern => new RegExp(`^${pattern}[.!。]?$`, 'iu'));
})();

export function parseAmazonMonthlySales(value) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return null;
  for (const pattern of MONTHLY_PURCHASE_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const unit = String(match[2] || '').toLocaleLowerCase('en-US').replace(/\.$/, '');
    const number = match[1].trim();
    // Separators without a compact unit must be complete thousands groups.
    // This avoids interpreting malformed 1,00 or a fractional item as 100.
    if (unit ? !/^\d+(?:[.,]\d+)?$/.test(number)
      : !/^\d+$/.test(number) && !/^\d{1,3}([., ])\d{3}(?:\1\d{3})*$/.test(number)) return null;
    const amount = Number(unit ? number.replace(',', '.') : number.replace(/[., ]/g, ''));
    const multiplier = ['k', 'mil', 'tausend', 'tsd', '千'].includes(unit) ? 1_000
      : unit === 'm' ? 1_000_000 : unit === 'b' ? 1_000_000_000 : unit === '万' ? 10_000 : 1;
    const monthlySales = amount * multiplier;
    return Number.isSafeInteger(monthlySales) && monthlySales >= 0 ? monthlySales : null;
  }
  return null;
}
