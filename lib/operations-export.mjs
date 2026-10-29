export const OPERATIONS_MISSING = '【请填写对应内容】';

export function normalizeSupplierChoiceUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) return '';
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !(url.hostname === '1688.com' || url.hostname.endsWith('.1688.com'))) return '';
    return url.href;
  } catch { return ''; }
}

export function chosenSupplierUrl(product) {
  const choice = product?.supplierChoice;
  // An invalid nonempty manual value must not silently fall back to another factory.
  return String(choice?.manualUrl || '').trim()
    ? normalizeSupplierChoiceUrl(choice.manualUrl) : normalizeSupplierChoiceUrl(choice?.selectedUrl);
}

export function operationsColumnHeaders(currency) {
  return ['1688厂家链接', '亚马逊链接', 'ASIN', '月销量', `最低售价（${currency}）`, '采购成本（RMB）',
    '国内物流费用（RMB）', `采购成本（含提货入库配置费，${currency}）`, `佣金占比（${currency}）`,
    `FBA物流费（${currency}）`, '重量（g）', `空运头程（${currency}）`, `汇率折损费（${currency}）`,
    `Marketing（${currency}）`, `管理费（${currency}）`, `退货率损失（${currency}）`, `VAT（${currency}）`,
    `总成本（${currency}）`, `总利润额（${currency}）`, '利润率（%）'];
}

const number = (...values) => values.find(value => typeof value === 'number' && Number.isFinite(value)) ?? OPERATIONS_MISSING;
const text = value => typeof value === 'string' && value.trim() ? value : OPERATIONS_MISSING;

// This is an output view of saved results, never a second profit calculator.
// Fee columns contain saved amounts; the reference screenshot's rates are not inputs.
export function operationsColumnValues(product, { amazonUrl, weightKg } = {}) {
  const calculation = product.profitCalculation || {};
  const parts = calculation.parts || {};
  const mode = product.fulfillmentMode || calculation.fulfillmentMode;
  return [text(chosenSupplierUrl(product)), text(amazonUrl), text(product.sourceAsin || product.asin), number(product.sales30),
    number(product.salePrice, calculation.salePrice), number(product.purchaseCost, calculation.purchaseCostCny),
    number(calculation.domesticFreightCny), number(parts.purchase, calculation.purchaseAud),
    number(parts.commission, calculation.commission),
    mode === 'FBA' ? number(product.fbaFee, calculation.fba, parts.fba, calculation.fulfillmentFee) : OPERATIONS_MISSING,
    typeof weightKg === 'number' && Number.isFinite(weightKg) && weightKg > 0 ? Number((weightKg * 1000).toPrecision(12)) : OPERATIONS_MISSING,
    number(parts.freight, calculation.freightCost, calculation.freight), number(parts.fxLoss, calculation.fxLoss),
    number(parts.marketing, calculation.marketing), number(parts.management, calculation.management),
    number(parts.returns, calculation.returns), number(parts.vat, calculation.vat, product.vat),
    number(calculation.totalCost, product.totalCost), number(calculation.profit, product.profitValue), number(calculation.margin, product.margin)];
}
