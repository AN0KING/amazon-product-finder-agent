// AN0KING/amazon-product-finder-agent @ 94f9202873094e2ff7cfc0caa65410cc838cb743.
// Port the 0.9.50 detail visit policy, keeping current URL validation, field
// evidence and manual-pause contracts. Missing fields do not start a new visit.
export const AMAZON_SEARCH_BASELINE = '0.9.50';
export { AMAZON_SEARCH_POLICY } from './amazon-product-information.mjs';

export async function supplementV0950ProductDetail(session, detail, productUrl, asin, signal) {
  // The only successful-HTTP browser fallback in 0.9.50 was a price hidden
  // behind the cart gate. Weight/date absence must not trigger the new full
  // specification traversal (or turn its timeout into a product failure).
  if (detail.currentPrice === null
    && detail.pageContextEvidence?.priceUnavailableReason === 'price_requires_cart'
    && session.market.postalCode) {
    try {
      const browser = await session.fetchProductDetailWithEdgeCdp(productUrl, asin, signal);
      if (browser.currentPrice !== null || browser.pageContextEvidence?.priceUnavailableReason === 'page_not_provided') return browser;
    } catch (error) {
      // Unlike the historical broad catch, real verification/rate limits
      // retain today's durable pause behavior. Ordinary browser errors do not
      // erase fields already obtained from the successful HTTP response.
      if (signal?.aborted || ['AMAZON_ACCESS_CHALLENGE', 'AMAZON_HTTP_429', 'EDGE_CDP_CHALLENGE_TIMEOUT'].includes(error?.code)) throw error;
      return { ...detail, priceReadAttempt: { status: 'failed',
        code: String(error?.code || 'AMAZON_BROWSER_PRICE_FAILED'),
        message: String(error?.message || 'Browser price verification failed.').slice(0, 500) } };
    }
  }
  return detail;
}
