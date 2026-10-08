export const MAX_AMAZON_DETAIL_RETRIES = 2;

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
