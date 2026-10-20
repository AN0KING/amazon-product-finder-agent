import { hasCompleteProductInformationInspection, AMAZON_SEARCH_POLICY } from './amazon-product-information.mjs';
import { automaticProfitWeightKg } from './profit-model.mjs';

export const MAX_AMAZON_DETAIL_RETRIES = 2;
export const MAX_AMAZON_COLLECTION_RECOVERIES = 2;

// This is deliberately narrower than “a field is missing”. A stable, fully
// inspected page is a final result; incomplete inspection or a known transport
// failure can receive a bounded follow-up within the same saved task.
export function amazonCollectionRecoveryReason(item = {}, task = {}) {
  const code = String(item.lastCollectionError?.code || item.collectionLastAttempt?.code
    || item.detailErrorCode || task.lastCode || '').toUpperCase();
  if (/CHALLENGE|CAPTCHA|LOGIN|AUTH|HTTP_40[13]|HTTP_429|ACCESS_DENIED|BLOCKED|RISK|USER_PAUSED|SUPPLIER/.test(code)) return null;
  if (item.detailStatus !== 'success' || item.lastCollectionError || item.collectionLastAttempt?.status === 'failed') {
    if (item.detailRetryable === false && !item.lastCollectionError) return null;
    if (/TIMEOUT|CONNECTION_(?:CLOSED|RESET|FAILED)|ECONNRESET|ECONNREFUSED|EPIPE|PROCESS_EXIT|REQUEST_FAILED|NAVIGATION_FAILED|HTTP_5\d\d|DETAIL_NOT_RETURNED|EDGE_CDP_(?:CONNECT_FAILED|CLOSED)/.test(code)) {
      return { reasonCode: code, message: /TIMEOUT/.test(code) ? '商品访问超时' : '商品页面访问中断' };
    }
    return null;
  }
  const asin = String(item.sourceAsin || item.asin || '').toUpperCase();
  const information = item.productInformation;
  if (!information || information.asin !== asin || information.reason === 'asin_mismatch') return null;
  const complete = hasCompleteProductInformationInspection(information, asin);
  const weight = item.collectionQuality?.fields?.weight;
  const manualWeight = weight?.reason === 'manual_value_not_collected'
    || item.manualWeight === true || item.manualProductWeight === true || item.manualFbaWeight === true
    || item.manualBillingWeight === true || (item.manualAmazonOverride === true && !item.manualAmazonFields)
    || [item.profitInputs?.weightSource, item.weightSource].some(source => /(?:manual|人工|手工)/i.test(String(source || '')))
    || ['weight', 'weightKg', 'productWeightKg', 'productWeight', 'fbaPackageWeightKg', 'fbaWeight', 'billingWeight']
      .some(field => item.manualAmazonFields?.[field] === true || item.fieldSources?.[field] === 'manual');
  // A previous inspection's absence label is final only while its proof is
  // current. New inspection rules may find fields the old traversal missed;
  // the runner still applies the existing cooldown and remaining retry budget.
  const weightMissing = weight?.status !== 'verified' && automaticProfitWeightKg(item) === null && !manualWeight
    && !(complete && information.weightStatus === 'not_provided');
  const dateMissing = (item.amazonFirstAvailableDateStatus === 'unresolved'
    || (!complete && item.amazonFirstAvailableDateStatus === 'not_provided'))
    && !item.manualAmazonFields?.amazonFirstAvailableDate && item.fieldSources?.amazonFirstAvailableDate !== 'manual';
  // The restored single-page search intentionally does not traverse hidden
  // date panels. Repeating a successful weighted item cannot prove absence.
  if (information.collectionStrategy === AMAZON_SEARCH_POLICY && !weightMissing) return null;
  if ((!complete && (weightMissing || dateMissing)) || (weightMissing && information.weightStatus === 'unresolved')) {
    return { reasonCode: 'AMAZON_PRODUCT_INFORMATION_INCOMPLETE',
      message: ['weight_value_conflict', 'conflicting_values'].includes(information.reason)
        ? '商品重量证据冲突，需重新核对' : '商品信息展开或重量、上架日期检查未完成' };
  }
  return null;
}

export function decideAmazonDetailRetry({ retriesUsed = 0, codes = [], status = null } = {}) {
  const normalizedCodes = codes.map((code) => String(code || "").toUpperCase());
  const restriction = normalizedCodes.find((code) => ["AMAZON_ACCESS_CHALLENGE", "AMAZON_HTTP_429"].includes(code))
    || (Number(status) === 429 ? "AMAZON_HTTP_429" : null);
  const attempts = Math.max(0, Math.trunc(Number(retriesUsed) || 0));
  if (restriction) return { action: "pause", reason: "access_restricted", causeCode: restriction, retriesUsed: attempts };
  if (attempts >= MAX_AMAZON_DETAIL_RETRIES) {
    return { action: "pause", reason: "retry_limit", causeCode: normalizedCodes.find(Boolean) || "AMAZON_DETAIL_INCOMPLETE", retriesUsed: attempts };
  }
  return { action: "retry", retriesUsed: attempts + 1 };
}

export function amazonDetailPauseMessage(pause = {}) {
  const reason = pause.causeCode === "AMAZON_ACCESS_CHALLENGE"
    ? "Amazon 要求访问验证"
    : pause.causeCode === "AMAZON_HTTP_429"
      ? "Amazon 已限制请求频率"
      : `商品详情在额外重试 ${MAX_AMAZON_DETAIL_RETRIES} 次后仍未完成`;
  return `${reason}，已暂停并保留全部断点和候选。请稍后点击“继续 Amazon 详情”恢复；刷新页面不会自动继续。`;
}

export function canAutomaticallyResumeAmazonDetails(runState) {
  return !runState?.amazonDetailPause;
}
