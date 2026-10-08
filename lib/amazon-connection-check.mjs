import { amazonDeliveryRegion, createAmazonStoreSession } from "./amazon-store-client.mjs";

const RETRYABLE_CODES = new Set([
  "AMAZON_ACCESS_CHALLENGE",
  "AMAZON_FETCH_REQUEST_FAILED",
  "AMAZON_FETCH_TIMEOUT",
  "AMAZON_DELIVERY_REGION_FAILED",
  "AMAZON_HTTP_429",
  "AMAZON_HTTP_500",
  "AMAZON_HTTP_502",
  "AMAZON_HTTP_503",
  "AMAZON_HTTP_504",
  "AMAZON_REQUEST_FAILED",
]);

export async function checkAmazonConnection({
  marketplace,
  sellerId,
  signal,
  createSession = createAmazonStoreSession,
} = {}) {
  const normalizedMarketplace = String(marketplace || "").trim().toUpperCase();
  const normalizedSellerId = String(sellerId || "").trim().toUpperCase();
  const startedAt = Date.now();
  const deliveryRegion = amazonDeliveryRegion(normalizedMarketplace);
  let session = null;

  try {
    session = await createSession(normalizedMarketplace, { signal });
    const result = await session.enumerateStore(normalizedSellerId, {
      maxPages: 1,
      maxAsins: 40,
      signal,
    });
    return {
      marketplace: normalizedMarketplace,
      sellerId: normalizedSellerId,
      status: "live",
      ready: true,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      pagesVisited: result.pagesVisited,
      discoveredAsins: result.asins.length,
      empty: result.asins.length === 0,
      hasMore: Boolean(result.nextHref),
      deliveryPostalCode: result.deliveryPostalCode,
      deliveryRegionReady: result.deliveryRegionReady === true,
      deliveryRegionMode: result.deliveryRegionMode,
      code: null,
      message: null,
      retryable: false,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : error;
    }
    const code = safeAmazonErrorCode(error?.code);
    return {
      marketplace: normalizedMarketplace,
      sellerId: normalizedSellerId,
      status: "error",
      ready: false,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      pagesVisited: 0,
      discoveredAsins: 0,
      empty: false,
      hasMore: false,
      deliveryPostalCode: deliveryRegion.postalCode,
      deliveryRegionReady: false,
      deliveryRegionMode: deliveryRegion.mode,
      code,
      message: safeMessage(error?.message),
      retryable: RETRYABLE_CODES.has(code),
    };
  } finally {
    await session?.close();
  }
}

function safeAmazonErrorCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^AMAZON_[A-Z0-9_]{1,72}$/.test(code) || code === "INVALID_SELLER_ID"
    ? code
    : "AMAZON_CONNECTION_CHECK_FAILED";
}

function safeMessage(value) {
  const message = typeof value === "string"
    ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ")
    : "";
  return (message || "Amazon connection check failed.").slice(0, 500);
}
