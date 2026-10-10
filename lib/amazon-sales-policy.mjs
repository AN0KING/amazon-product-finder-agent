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

export function parseAmazonMonthlySales(value) {
  const text = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const hasMonthlyPurchaseEvidence = /(?:bought|purchased|ordered|gekocht|verkocht).{0,80}(?:past|last|afgelopen)\s+(?:(?:one|1)\s+)?(?:month|maand)|(?:past|last|afgelopen)\s+(?:(?:one|1)\s+)?(?:month|maand).{0,80}(?:bought|purchased|ordered|gekocht|verkocht)|(?:过去|近)\s*(?:一|1|一个)?\s*(?:个)?月.{0,80}(?:购买|售出)|(?:购买|售出).{0,80}(?:过去|近)\s*(?:一|1|一个)?\s*(?:个)?月/i.test(text);
  if (!hasMonthlyPurchaseEvidence) return null;
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*([kmb]|千|万)?\s*\+?\s*(?:bought|purchased|ordered|gekocht|verkocht|购买|售出)/i)
    || text.match(/(?:购买|售出)\s*(\d+(?:[.,]\d+)?)\s*([kmb]|千|万)?\s*\+?/i);
  if (!match) return null;
  const unit = String(match[2] || '').toLocaleLowerCase('en-US');
  const amount = Number(unit ? match[1].replace(',', '.') : match[1].replace(/,/g, ''));
  const multiplier = unit === 'k' || unit === '千' ? 1_000
    : unit === 'm' ? 1_000_000 : unit === 'b' ? 1_000_000_000 : unit === '万' ? 10_000 : 1;
  const monthlySales = amount * multiplier;
  return Number.isSafeInteger(monthlySales) && monthlySales >= 0 ? monthlySales : null;
}
