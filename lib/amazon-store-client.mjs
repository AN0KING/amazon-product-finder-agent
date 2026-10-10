import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { load } from "cheerio";
import { EdgeCdpSession } from "./amazon-edge-cdp.mjs";
import { createDualEgressFetch } from "./fetch-proxy.mjs";
import { parseAmazonMonthlySales } from "./amazon-sales-policy.mjs";

const execFileAsync = promisify(execFile);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 50_000;
const FETCH_REQUEST_TIMEOUT_MS = 20_000;
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_SESSION_ATTEMPTS = 2;
const DELIVERY_REGION_MAX_ATTEMPTS = 2;
const MIN_REQUEST_INTERVAL_MS = 1_400;
const MAX_REDIRECTS = 3;
const MAX_STORE_PAGES_PER_ATTEMPT = 25;
const MAX_STORE_TOTAL_PAGES = 10_000;
const MAX_STORE_ASINS = 10_000;
// 亚马逊准则 2026-10-09：店铺首页卡片直接以销量角标判断月销量档位。
// 未显示角标的商品没有满足门槛的证据，不纳入候选；50+/100+/200+/1000+（含 1.2K+ 等缩写）分别对应
// 50/100/200/1000 的下界，只有角标数值 >= 该阈值的卡片才进入后续分析。
const MIN_STORE_CARD_MONTHLY_SALES = 50;
const STORE_CARD_MONTHLY_SALES_SELECTORS = Object.freeze([
  "#social-proofing-faceout-title-tk_bought",
  "[id*='social-proofing'][id*='bought']",
  ".social-proofing-faceout-title-text",
]);
const SELLER_ID_PATTERN = /^[A-Z0-9]{8,20}$/;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
export const AMAZON_PRODUCT_DETAIL_PARSER_VERSION = 6;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_FETCH_STATUSES = new Set([500, 502, 503, 504]);
const RESUMABLE_INTERRUPTION_ERRORS = new Set([
  "AMAZON_ACCESS_CHALLENGE",
  "AMAZON_HTTP_429",
  "AMAZON_HTTP_500",
  "AMAZON_HTTP_502",
  "AMAZON_HTTP_503",
  "AMAZON_HTTP_504",
  "AMAZON_FETCH_REQUEST_FAILED",
  "AMAZON_FETCH_TIMEOUT",
  "AMAZON_REQUEST_FAILED",
  "AMAZON_EDGE_REQUEST_FAILED",
  "AMAZON_EDGE_NAVIGATION_FAILED",
  "AMAZON_EDGE_INVALID_STORE_PAGE",
  "AMAZON_INVALID_STORE_PAGE",
]);

const MARKET_CONFIGS = Object.freeze({
  AU: Object.freeze({
    code: "AU",
    baseUrl: "https://www.amazon.com.au",
    marketplaceId: "A39IBJ37TRP1C6",
    postalCode: "3010",
    countryCode: "AU",
    language: "en-AU,en;q=0.9",
  }),
  US: Object.freeze({
    code: "US",
    baseUrl: "https://www.amazon.com",
    marketplaceId: "ATVPDKIKX0DER",
    postalCode: "10001",
    countryCode: "US",
    language: "en-US,en;q=0.9",
  }),
  NL: Object.freeze({
    code: "NL",
    baseUrl: "https://www.amazon.nl",
    marketplaceId: "A1805IZSGTT6HS",
    postalCode: null,
    countryCode: "NL",
    language: "nl-NL,nl;q=0.9,en;q=0.8",
    useCookies: false,
  }),
  CA: Object.freeze({
    code: "CA",
    baseUrl: "https://www.amazon.ca",
    marketplaceId: "A2EUQ1WTGCTBG2",
    postalCode: "M5V 2T6",
    countryCode: "CA",
    language: "en-CA,en;q=0.9,fr-CA;q=0.8",
    requestIntervalMs: 1_200,
  }),
  UK: Object.freeze({
    code: "UK",
    baseUrl: "https://www.amazon.co.uk",
    marketplaceId: "A1F83G8C2ARO7P",
    postalCode: "EC1A 1BB",
    countryCode: "GB",
    language: "en-GB,en;q=0.9",
  }),
  DE: Object.freeze({
    code: "DE",
    baseUrl: "https://www.amazon.de",
    marketplaceId: "A1PA6795UKMFR9",
    postalCode: "10115",
    countryCode: "DE",
    language: "de-DE,de;q=0.9,en;q=0.8",
    requestIntervalMs: 3_000,
  }),
  FR: Object.freeze({
    code: "FR",
    baseUrl: "https://www.amazon.fr",
    marketplaceId: "A13V1IB3VIYZZH",
    postalCode: "75001",
    countryCode: "FR",
    language: "fr-FR,fr;q=0.9,en;q=0.8",
  }),
  IT: Object.freeze({
    code: "IT",
    baseUrl: "https://www.amazon.it",
    marketplaceId: "APJ6JRA9NG5V4",
    postalCode: "20121",
    countryCode: "IT",
    language: "it-IT,it;q=0.9,en;q=0.8",
  }),
  ES: Object.freeze({
    code: "ES",
    baseUrl: "https://www.amazon.es",
    marketplaceId: "A1RKKUPIHCS9HS",
    postalCode: "28001",
    countryCode: "ES",
    language: "es-ES,es;q=0.9,en;q=0.8",
  }),
  PL: Object.freeze({
    code: "PL",
    baseUrl: "https://www.amazon.pl",
    marketplaceId: "A1C3SOZRARQ6R3",
    postalCode: "00-001",
    countryCode: "PL",
    language: "pl-PL,pl;q=0.9,en;q=0.8",
  }),
  MX: Object.freeze({
    code: "MX",
    baseUrl: "https://www.amazon.com.mx",
    marketplaceId: "A1AM78C64UM0Y8",
    postalCode: "06600",
    countryCode: "MX",
    language: "es-MX,es;q=0.9,en;q=0.8",
  }),
  BR: Object.freeze({
    code: "BR",
    baseUrl: "https://www.amazon.com.br",
    marketplaceId: "A2Q3Y263D00KWC",
    postalCode: "01310-100",
    countryCode: "BR",
    language: "pt-BR,pt;q=0.9,en;q=0.8",
    requestIntervalMs: 3_000,
  }),
});

export class AmazonStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AmazonStoreError";
    this.code = code;
  }
}

export async function createAmazonStoreSession(marketplace, {
  signal,
  executeRequest = execFileAsync,
  executeBrowser = execFileAsync,
  executeFetch,
  // Omitted: auto-resolve the installed Edge executable (production default).
  // Explicit false: disable the Edge channel.
  edgeExecutable,
  requestIntervalMs,
} = {}) {
  const market = requireMarket(marketplace);
  const temporaryRoot = await realpath(path.resolve(os.tmpdir()));
  const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, "scout-amazon-"));
  const usesDefaultTransport = executeRequest === execFileAsync && executeBrowser === execFileAsync;
  const fetchImplementation = executeFetch === false
    ? null
    : typeof executeFetch === "function"
      ? executeFetch
      : usesDefaultTransport ? createDualEgressFetch() : null;
  const session = new AmazonStoreSession(
    market,
    temporaryRoot,
    temporaryDirectory,
    executeRequest,
    executeBrowser,
    fetchImplementation,
    edgeExecutable,
    requestIntervalMs ?? market.requestIntervalMs,
  );
  try {
    await session.bootstrap(signal);
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

class AmazonStoreSession {
  constructor(market, temporaryRoot, temporaryDirectory, executeRequest, executeBrowser, executeFetch, edgeExecutable, requestIntervalMs) {
    this.market = market;
    this.temporaryRoot = temporaryRoot;
    this.temporaryDirectory = temporaryDirectory;
    this.executeRequest = executeRequest;
    this.executeBrowser = executeBrowser;
    this.executeFetch = typeof executeFetch === "function" ? executeFetch : null;
    this.edgeExecutable = typeof edgeExecutable === "string" && edgeExecutable.trim()
      ? path.resolve(edgeExecutable.trim())
      : null;
    this.edgeExecutableResolved = edgeExecutable === false || Boolean(this.edgeExecutable);
    this.requestIntervalMs = Number.isFinite(Number(requestIntervalMs))
      ? Math.max(0, Number(requestIntervalMs))
      : executeRequest === execFileAsync && executeBrowser === execFileAsync ? MIN_REQUEST_INTERVAL_MS : 0;
    this.cookieFile = path.join(temporaryDirectory, "cookies.txt");
    this.edgeProfileDirectory = path.join(temporaryDirectory, "edge-profile");
    this.edgeCacheDirectory = path.join(temporaryDirectory, "edge-cache");
    this.edgeProfileGeneration = 0;
    this.initialized = false;
    this.fetchInitialized = false;
    this.fetchInitializationPromise = null;
    this.fetchSessionGeneration = 0;
    this.curlInitialized = false;
    this.deliveryRegionReady = new Set();
    this.fetchCookies = new Map();
    this.edgeCdpSession = null;
    this.edgeCdpProductDetailQueue = Promise.resolve();
    this.closed = false;
    this.lastRequestAt = 0;
    this.requestTimestamps = [];
  }

  async bootstrap(signal) {
    this.assertOpen();
    if (this.executeFetch) {
      this.initialized = true;
      return;
    }
    // Windows curl can become unusable when Schannel cannot acquire a TLS
    // credential. An isolated temporary Edge profile avoids that machine-wide
    // dependency without touching the user's normal browser profile.
    if (await this.resolveEdgeExecutable()) {
      this.initialized = true;
      return;
    }
    await this.ensureCurlInitialized(signal);
    this.initialized = true;
  }

  async ensureCurlInitialized(signal) {
    if (this.curlInitialized) return;
    await this.request(this.market.baseUrl, [], signal, false);
    if (this.market.postalCode) {
      await confirmDeliveryRegion(async () => this.request(
        `${this.market.baseUrl}/gp/delivery/ajax/address-change.html`,
        [
          "--request", "POST",
          "--header", "X-Requested-With: XMLHttpRequest",
          "--header", "Content-Type: application/x-www-form-urlencoded;charset=UTF-8",
          "--referer", `${this.market.baseUrl}/`,
          "--data-urlencode", "locationType=LOCATION_INPUT",
          "--data-urlencode", `zipCode=${this.market.postalCode}`,
          "--data-urlencode", "storeContext=generic",
          "--data-urlencode", "pageType=Gateway",
          "--data-urlencode", "actionSource=glow",
        ],
        signal,
        true,
      ), this.market, signal);
    }
    this.deliveryRegionReady.add("curl");
    this.curlInitialized = true;
  }

  async ensureFetchInitialized(signal) {
    if (this.fetchInitialized) return;
    if (!this.fetchInitializationPromise) {
      // One initializer owns the cookie jar until the delivery region is ready.
      // Product workers must share both the initialization and its failure.
      this.fetchInitializationPromise = Promise.resolve().then(async () => {
        if (this.market.postalCode) {
          await this.requestWithFetch(this.market.baseUrl, signal);
          await confirmDeliveryRegion(
            () => this.requestWithFetch(
              `${this.market.baseUrl}/gp/delivery/ajax/address-change.html`,
              signal,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                  "X-Requested-With": "XMLHttpRequest",
                  Referer: `${this.market.baseUrl}/`,
                },
                body: deliveryRegionForm(this.market).toString(),
              },
            ),
            this.market,
            signal,
          );
        }
        this.deliveryRegionReady.add("fetch");
        this.fetchInitialized = true;
      }).catch((error) => {
        this.fetchInitialized = false;
        this.fetchCookies.clear();
        this.deliveryRegionReady.delete("fetch");
        throw error;
      }).finally(() => {
        this.fetchInitializationPromise = null;
      });
    }
    await this.fetchInitializationPromise;
  }

  resetFetchSession() {
    // Concurrent workers retrying the same failed session join recovery that
    // already started; clearing its cookies would corrupt the new session.
    if (this.fetchInitializationPromise) return;
    this.fetchSessionGeneration += 1;
    this.fetchInitialized = false;
    this.fetchCookies.clear();
    this.deliveryRegionReady.delete("fetch");
  }

  assertFetchSessionGeneration(generation) {
    if (generation !== this.fetchSessionGeneration) {
      throw new AmazonStoreError("AMAZON_FETCH_SESSION_CHANGED", "Amazon HTTPS session changed while the request was in flight.");
    }
  }

  async getProductDetail(asin, { signal } = {}) {
    this.assertOpen();
    const normalizedAsin = String(asin || "").trim().toUpperCase();
    if (!ASIN_PATTERN.test(normalizedAsin)) {
      throw new AmazonStoreError("INVALID_ASIN", "Amazon ASIN is invalid.");
    }
    const productUrl = buildProductUrl(this.market, normalizedAsin);
    if (this.executeFetch) {
      let fetchError = null;
      for (let attempt = 0; attempt < FETCH_SESSION_ATTEMPTS; attempt += 1) {
        try {
          if (attempt > 0 && fetchError?.code !== "AMAZON_FETCH_SESSION_CHANGED") this.resetFetchSession();
          await this.ensureFetchInitialized(signal);
          const response = await this.requestWithFetch(productUrl, signal);
          const detail = productDetailResult(
            parseAmazonProductPage(response.body, { marketplace: this.market.code, asin: normalizedAsin }),
            this.market,
            normalizedAsin,
            response.effectiveUrl,
            "fetch",
            this.deliveryRegionReady,
          );
          // The plain fetch egress may visit without a confirmed delivery
          // region, so Amazon hides the price behind an "add to cart"
          // interstitial. The CDP-driven Edge channel proves the postcode
          // inside the real page session, which unlocks the price. Retry
          // once through the browser instead of returning a priceless item.
          if (
            detail.currentPrice === null
            && detail.pageContextEvidence?.priceUnavailableReason === "price_requires_cart"
            && this.market.postalCode
          ) {
            try {
              const cdpDetail = await this.fetchProductDetailWithEdgeCdp(productUrl, normalizedAsin, signal);
              // 浏览器会话中页面确实没有精选报价（无 BuyBox）时，保留 CDP 的
              // 真实证据（page_not_provided + 配送地 match），而不是回退到 fetch
              // 的 price_requires_cart 假证据，避免补价看门狗无限重访。
              if (
                cdpDetail.currentPrice !== null
                || cdpDetail.pageContextEvidence?.priceUnavailableReason === "page_not_provided"
              ) return cdpDetail;
            } catch (cdpError) {
              if (signal?.aborted) throw cdpError;
              // Keep the fetch-channel result when the browser retry fails;
              // the item keeps its audit reason for a later targeted retry.
            }
          }
          // Read every available field from this response. Missing fields on
          // a successful page do not trigger another product-page visit.
          return detail;
        } catch (error) {
          if (error?.code !== "AMAZON_FETCH_SESSION_CHANGED" && !isRecoverableProductFetchFailure(error)) throw error;
          fetchError = error;
        }
      }
      if (fetchError?.code === "AMAZON_FETCH_SESSION_CHANGED") throw fetchError;
      // US/AU results must stay on the HTTPS session that proved the selected
      // delivery postcode. The CDP-driven Edge channel proves it inside the
      // real page session, so it is a valid fallback; raw browser dumps and
      // Windows curl are not.
      if (this.market.postalCode) {
        try {
          const detail = await this.fetchProductDetailWithEdgeCdp(productUrl, normalizedAsin, signal);
          return detail;
        } catch (cdpError) {
          if (signal?.aborted || !isRecoverableEdgeFailure(cdpError)) throw cdpError;
          throw fetchError;
        }
      }
    }

    await this.ensureCurlInitialized(signal);
    const response = await this.request(productUrl, [], signal, true);
    const detail = productDetailResult(
      parseAmazonProductPage(response.body, { marketplace: this.market.code, asin: normalizedAsin }),
      this.market,
      normalizedAsin,
      response.effectiveUrl,
      "curl",
      this.deliveryRegionReady,
    );
    return detail;
  }

  async enumerateStore(sellerId, {
    maxPages = MAX_STORE_PAGES_PER_ATTEMPT,
    maxAsins = MAX_STORE_ASINS,
    signal,
    resume = null,
    onCheckpoint = null,
  } = {}) {
    this.assertOpen();
    const normalizedSellerId = String(sellerId || "").trim().toUpperCase();
    if (!SELLER_ID_PATTERN.test(normalizedSellerId)) {
      throw new AmazonStoreError("INVALID_SELLER_ID", "Amazon seller ID is invalid.");
    }
    const pageLimit = boundedInteger(
      maxPages,
      1,
      MAX_STORE_PAGES_PER_ATTEMPT,
      MAX_STORE_PAGES_PER_ATTEMPT,
    );
    const asinLimit = boundedInteger(maxAsins, 1, MAX_STORE_ASINS, MAX_STORE_ASINS);
    const resumeState = normalizeStoreResume(this.market, normalizedSellerId, resume, asinLimit);
    const checkpoint = typeof onCheckpoint === "function" ? onCheckpoint : null;
    if (this.executeFetch) {
      let fetchError = null;
      let fetchInterrupted = null;
      for (let attempt = 0; attempt < FETCH_SESSION_ATTEMPTS; attempt += 1) {
        try {
          if (attempt > 0 && fetchError?.code !== "AMAZON_FETCH_SESSION_CHANGED") this.resetFetchSession();
          await this.ensureFetchInitialized(signal);
          const fetchResult = await this.enumerateStoreWithFetch(normalizedSellerId, {
            pageLimit,
            asinLimit,
            signal,
            resumeState,
            onCheckpoint: checkpoint,
          });
          // A resumable interruption (5xx / 429 / challenge leftover on a deep
          // page) means the plain fetch egress is throttled. Hand the visit to
          // the Edge CDP channel instead of returning the partial result.
          if (!fetchResult.interruption || !RESUMABLE_INTERRUPTION_ERRORS.has(fetchResult.interruption.code)) {
            return fetchResult;
          }
          fetchInterrupted = fetchResult;
          break;
        } catch (error) {
          if (error?.code !== "AMAZON_FETCH_SESSION_CHANGED" && !isRecoverableFetchFailure(error)) throw error;
          fetchError = error;
        }
      }
      if (fetchError?.code === "AMAZON_FETCH_SESSION_CHANGED") throw fetchError;
      if (this.market.postalCode) {
        // AWS WAF blocks plain HTTP clients on networks whose egress IP it
        // does not trust. The CDP-driven Edge channel executes the challenge
        // and proves the delivery postcode inside the real page session, so
        // it preserves the AU/US data-correctness requirement.
        try {
          return await this.enumerateStoreWithEdgeCdp(normalizedSellerId, {
            pageLimit,
            asinLimit,
            signal,
            resumeState,
            onCheckpoint: checkpoint,
          });
        } catch (cdpError) {
          if (signal?.aborted || !isRecoverableEdgeFailure(cdpError)) throw cdpError;
          if (fetchInterrupted) return fetchInterrupted;
          throw fetchError;
        }
      }
      if (fetchInterrupted) return fetchInterrupted;
      throw fetchError;
    }
    // A raw --dump-dom Edge process cannot prove that Amazon accepted a
    // delivery postcode. Do not silently analyze the default-region catalog.
    if (!this.market.postalCode && await this.resolveEdgeExecutable()) {
      try {
        const edgeResult = await this.enumerateStoreWithEdge(normalizedSellerId, {
          pageLimit,
          asinLimit,
          signal,
          resumeState,
          onCheckpoint: checkpoint,
        });
        if (edgeResult) return edgeResult;
      } catch (error) {
        if (!isRecoverableEdgeFailure(error)) throw error;
        await this.ensureCurlInitialized(signal);
      }
    }
    await this.ensureCurlInitialized(signal);
    const asins = [...resumeState.asins];
    const seenAsins = new Set(asins);
    const pageAudit = [...resumeState.pageAudit];
    const salesByAsin = { ...resumeState.salesByAsin };
    const seenPages = new Set(pageAudit.filter((page) => page.status === "success" && page.exhausted !== false).map((page) => page.url));
    let currentUrl = resumeState.nextHref || buildSellerUrl(this.market, normalizedSellerId, 1);
    let storeName = resumeState.storeName;
    let pagesVisited = resumeState.pagesVisited;
    let nextHref = resumeState.nextHref;
    let interruption = resumeState.interruption;
    let reportedTotalAsins = resumeState.reportedTotalAsins;
    let pagesVisitedThisAttempt = 0;

    while (
      pagesVisitedThisAttempt < pageLimit
      && pagesVisited < MAX_STORE_TOTAL_PAGES
      && asins.length < asinLimit
    ) {
      throwIfAborted(signal);
      const validatedUrl = assertAllowedSellerPageUrl(
        currentUrl,
        currentUrl,
        this.market,
        normalizedSellerId,
        "AMAZON_PAGINATION_REJECTED",
      ).toString();
      if (seenPages.has(validatedUrl)) {
        interruption = { code: "AMAZON_PAGINATION_LOOP", message: "Amazon returned an already collected store page URL." };
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: interruption.code });
        break;
      }
      seenPages.add(validatedUrl);

      let response;
      try {
        response = await this.request(validatedUrl, [], signal, true);
      } catch (error) {
        const partial = resumableInterruption(error, asins.length);
        if (!partial) throw error;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        await emitStoreCheckpoint(checkpoint, enumerationResult({
          market: this.market,
          sellerId: normalizedSellerId,
          storeName,
          asins,
          pagesVisited,
          reportedTotalAsins,
          pageAudit,
          nextHref,
          interruption,
          salesByAsin,
          transport: "curl",
          deliveryRegionReady: this.deliveryRegionReady,
        }));
        break;
      }

      const effectiveUrl = assertAllowedSellerPageUrl(
        response.effectiveUrl,
        validatedUrl,
        this.market,
        normalizedSellerId,
        "AMAZON_PAGINATION_REJECTED",
      ).toString();
      const parsed = parseAmazonStorePage(response.body);
      const accessError = amazonAccessPageError(parsed);
      if (accessError) {
        const partial = resumableInterruption(accessError, asins.length);
        if (!partial) throw accessError;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        await emitStoreCheckpoint(checkpoint, enumerationResult({
          market: this.market,
          sellerId: normalizedSellerId,
          storeName,
          asins,
          pagesVisited,
          reportedTotalAsins,
          pageAudit,
          nextHref,
          interruption,
          salesByAsin,
          transport: "curl",
          deliveryRegionReady: this.deliveryRegionReady,
        }));
        break;
      }
      if (parsed.asins.length === 0 && !parsed.explicitEmpty && !parsed.badgeGateActive) {
        const pageError = new AmazonStoreError(
          "AMAZON_INVALID_STORE_PAGE",
          "Amazon returned a page without product results or an explicit empty-store state.",
        );
        const partial = resumableInterruption(pageError, asins.length);
        if (!partial) throw pageError;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        await emitStoreCheckpoint(checkpoint, enumerationResult({
          market: this.market,
          sellerId: normalizedSellerId,
          storeName,
          asins,
          pagesVisited,
          reportedTotalAsins,
          pageAudit,
          nextHref,
          interruption,
          salesByAsin,
          transport: "curl",
          deliveryRegionReady: this.deliveryRegionReady,
        }));
        break;
      }
      pagesVisited += 1;
      pagesVisitedThisAttempt += 1;
      if (!storeName && parsed.storeName) storeName = parsed.storeName;
      reportedTotalAsins = maximumKnownCount(reportedTotalAsins, parsed.reportedTotalAsins);
      mergeStoreCardSales(salesByAsin, parsed.salesByAsin);
      const previousAsinCount = asins.length;
      const priorDuplicateCount = parsed.asins.filter((asin) => seenAsins.has(asin)).length;
      const pageExhausted = appendUniqueAsins(asins, seenAsins, parsed.asins, asinLimit);
      const parsedNextHref = parsed.nextHref
        ? assertAllowedSellerPageUrl(
            parsed.nextHref,
            effectiveUrl,
            this.market,
            normalizedSellerId,
            "AMAZON_PAGINATION_REJECTED",
          ).toString()
        : null;
      nextHref = pageExhausted ? parsedNextHref : validatedUrl;
      interruption = null;
      recordStorePage(pageAudit, {
        url: validatedUrl, nextHref, status: "success", exhausted: pageExhausted,
        resultAsinCount: parsed.asins.length, addedAsinCount: asins.length - previousAsinCount,
        duplicateAsinCount: parsed.duplicateAsinCount + priorDuplicateCount,
        deferredAsinCount: parsed.asins.length - priorDuplicateCount - (asins.length - previousAsinCount),
        reportedTotalAsins: parsed.reportedTotalAsins, reportedTotalKind: parsed.reportedTotalKind,
        variantLinks: parsed.variantLinks, observedAsins: parsed.observedAsins,
        badgeExcludedCount: parsed.excludedUnder50Count || 0, badgeGateActive: parsed.badgeGateActive === true,
      });
      await emitStoreCheckpoint(checkpoint, enumerationResult({
        market: this.market,
        sellerId: normalizedSellerId,
        storeName,
        asins,
        pagesVisited,
        reportedTotalAsins,
        pageAudit,
        nextHref,
        interruption,
        salesByAsin,
        transport: "curl",
        deliveryRegionReady: this.deliveryRegionReady,
      }));
      if (!nextHref || asins.length >= asinLimit) break;
      currentUrl = nextHref;
    }
    interruption = totalPageLimitInterruption(pagesVisited, nextHref, interruption);

    return enumerationResult({
      market: this.market,
      sellerId: normalizedSellerId,
      storeName,
      asins,
      pagesVisited,
      reportedTotalAsins,
      pageAudit,
      nextHref,
      interruption,
      salesByAsin,
      transport: "curl",
      deliveryRegionReady: this.deliveryRegionReady,
    });
  }

  async enumerateStoreWithFetch(sellerId, { pageLimit, asinLimit, signal, resumeState, onCheckpoint }) {
    const asins = [...resumeState.asins];
    const seenAsins = new Set(asins);
    const pageAudit = [...resumeState.pageAudit];
    const salesByAsin = { ...resumeState.salesByAsin };
    const seenPages = new Set(pageAudit.filter((page) => page.status === "success" && page.exhausted !== false).map((page) => page.url));
    let currentUrl = resumeState.nextHref || buildSellerUrl(this.market, sellerId, 1);
    let storeName = resumeState.storeName;
    let pagesVisited = resumeState.pagesVisited;
    let nextHref = resumeState.nextHref;
    let interruption = resumeState.interruption;
    let reportedTotalAsins = resumeState.reportedTotalAsins;
    let pagesVisitedThisAttempt = 0;

    while (
      pagesVisitedThisAttempt < pageLimit
      && pagesVisited < MAX_STORE_TOTAL_PAGES
      && asins.length < asinLimit
    ) {
      throwIfAborted(signal);
      const validatedUrl = assertAllowedSellerPageUrl(
        currentUrl,
        currentUrl,
        this.market,
        sellerId,
        "AMAZON_PAGINATION_REJECTED",
      ).toString();
      if (seenPages.has(validatedUrl)) {
        interruption = { code: "AMAZON_PAGINATION_LOOP", message: "Amazon returned an already collected store page URL." };
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: interruption.code });
        break;
      }
      seenPages.add(validatedUrl);

      let response;
      try {
        response = await this.requestWithFetch(validatedUrl, signal);
      } catch (error) {
        const partial = resumableInterruption(error, asins.length);
        if (!partial) throw error;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        await emitStoreCheckpoint(onCheckpoint, enumerationResult({
          market: this.market,
          sellerId,
          storeName,
          asins,
          pagesVisited,
          reportedTotalAsins,
          pageAudit,
          nextHref,
          interruption,
          salesByAsin,
          transport: "fetch",
          deliveryRegionReady: this.deliveryRegionReady,
        }));
        break;
      }

      const effectiveUrl = assertAllowedSellerPageUrl(
        response.effectiveUrl,
        validatedUrl,
        this.market,
        sellerId,
        "AMAZON_PAGINATION_REJECTED",
      ).toString();
      const parsed = parseAmazonStorePage(response.body);
      const accessError = amazonAccessPageError(parsed);
      if (accessError) {
        const partial = resumableInterruption(accessError, asins.length);
        if (!partial) throw accessError;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        await emitStoreCheckpoint(onCheckpoint, enumerationResult({
          market: this.market,
          sellerId,
          storeName,
          asins,
          pagesVisited,
          reportedTotalAsins,
          pageAudit,
          nextHref,
          interruption,
          salesByAsin,
          transport: "fetch",
          deliveryRegionReady: this.deliveryRegionReady,
        }));
        break;
      }
      if (parsed.asins.length === 0 && !parsed.explicitEmpty && !parsed.badgeGateActive) {
        const pageError = new AmazonStoreError(
          "AMAZON_INVALID_STORE_PAGE",
          "Amazon returned a page without product results or an explicit empty-store state.",
        );
        const partial = resumableInterruption(pageError, asins.length);
        if (!partial) throw pageError;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        await emitStoreCheckpoint(onCheckpoint, enumerationResult({
          market: this.market,
          sellerId,
          storeName,
          asins,
          pagesVisited,
          reportedTotalAsins,
          pageAudit,
          nextHref,
          interruption,
          salesByAsin,
          transport: "fetch",
          deliveryRegionReady: this.deliveryRegionReady,
        }));
        break;
      }
      pagesVisited += 1;
      pagesVisitedThisAttempt += 1;
      if (!storeName && parsed.storeName) storeName = parsed.storeName;
      reportedTotalAsins = maximumKnownCount(reportedTotalAsins, parsed.reportedTotalAsins);
      mergeStoreCardSales(salesByAsin, parsed.salesByAsin);
      const previousAsinCount = asins.length;
      const priorDuplicateCount = parsed.asins.filter((asin) => seenAsins.has(asin)).length;
      const pageExhausted = appendUniqueAsins(asins, seenAsins, parsed.asins, asinLimit);
      const parsedNextHref = parsed.nextHref
        ? assertAllowedSellerPageUrl(
            parsed.nextHref,
            effectiveUrl,
            this.market,
            sellerId,
            "AMAZON_PAGINATION_REJECTED",
          ).toString()
        : null;
      nextHref = pageExhausted ? parsedNextHref : validatedUrl;
      interruption = null;
      recordStorePage(pageAudit, {
        url: validatedUrl, nextHref, status: "success", exhausted: pageExhausted,
        resultAsinCount: parsed.asins.length, addedAsinCount: asins.length - previousAsinCount,
        duplicateAsinCount: parsed.duplicateAsinCount + priorDuplicateCount,
        deferredAsinCount: parsed.asins.length - priorDuplicateCount - (asins.length - previousAsinCount),
        reportedTotalAsins: parsed.reportedTotalAsins, reportedTotalKind: parsed.reportedTotalKind,
        variantLinks: parsed.variantLinks, observedAsins: parsed.observedAsins,
        badgeExcludedCount: parsed.excludedUnder50Count || 0, badgeGateActive: parsed.badgeGateActive === true,
      });
      await emitStoreCheckpoint(onCheckpoint, enumerationResult({
        market: this.market,
        sellerId,
        storeName,
        asins,
        pagesVisited,
        reportedTotalAsins,
        pageAudit,
        nextHref,
        interruption,
        salesByAsin,
        transport: "fetch",
        deliveryRegionReady: this.deliveryRegionReady,
      }));
      if (!nextHref || asins.length >= asinLimit) break;
      currentUrl = nextHref;
    }
    interruption = totalPageLimitInterruption(pagesVisited, nextHref, interruption);

    return enumerationResult({
      market: this.market,
      sellerId,
      storeName,
      asins,
      pagesVisited,
      reportedTotalAsins,
      pageAudit,
      nextHref,
      interruption,
      salesByAsin,
      transport: "fetch",
      deliveryRegionReady: this.deliveryRegionReady,
    });
  }

  async enumerateStoreWithEdge(sellerId, { pageLimit, asinLimit, signal, resumeState, onCheckpoint }) {
    const edgeExecutable = await this.resolveEdgeExecutable();
    if (!edgeExecutable) return null;

    const asins = [...resumeState.asins];
    const seenAsins = new Set(asins);
    const pageAudit = [...resumeState.pageAudit];
    const salesByAsin = { ...resumeState.salesByAsin };
    const seenPages = new Set(pageAudit.filter((page) => page.status === "success" && page.exhausted !== false).map((page) => page.url));
    let currentUrl = resumeState.nextHref || buildSellerUrl(this.market, sellerId, 1);
    let storeName = resumeState.storeName;
    let pagesVisited = resumeState.pagesVisited;
    let nextHref = resumeState.nextHref;
    let interruption = resumeState.interruption;
    let reportedTotalAsins = resumeState.reportedTotalAsins;
    let pagesVisitedThisAttempt = 0;

    while (
      pagesVisitedThisAttempt < pageLimit
      && pagesVisited < MAX_STORE_TOTAL_PAGES
      && asins.length < asinLimit
    ) {
      throwIfAborted(signal);
      const validatedUrl = assertAllowedSellerPageUrl(
        currentUrl,
        currentUrl,
        this.market,
        sellerId,
        "AMAZON_PAGINATION_REJECTED",
      ).toString();
      if (seenPages.has(validatedUrl)) {
        interruption = { code: "AMAZON_PAGINATION_LOOP", message: "Amazon returned an already collected store page URL." };
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: interruption.code });
        break;
      }
      seenPages.add(validatedUrl);

      let response;
      try {
        response = await this.requestWithEdge(edgeExecutable, validatedUrl, signal);
      } catch (error) {
        const partial = resumableInterruption(error, asins.length);
        if (!partial) throw error;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        await emitStoreCheckpoint(onCheckpoint, enumerationResult({
          market: this.market,
          sellerId,
          storeName,
          asins,
          pagesVisited,
          reportedTotalAsins,
          pageAudit,
          nextHref,
          interruption,
          salesByAsin,
          transport: "edge",
          deliveryRegionReady: this.deliveryRegionReady,
        }));
        break;
      }
      const parsed = parseAmazonStorePage(response.body);

      pagesVisited += 1;
      pagesVisitedThisAttempt += 1;
      if (!storeName && parsed.storeName) storeName = parsed.storeName;
      reportedTotalAsins = maximumKnownCount(reportedTotalAsins, parsed.reportedTotalAsins);
      mergeStoreCardSales(salesByAsin, parsed.salesByAsin);
      const previousAsinCount = asins.length;
      const priorDuplicateCount = parsed.asins.filter((asin) => seenAsins.has(asin)).length;
      const pageExhausted = appendUniqueAsins(asins, seenAsins, parsed.asins, asinLimit);
      const parsedNextHref = parsed.nextHref
        ? assertAllowedSellerPageUrl(
            parsed.nextHref,
            validatedUrl,
            this.market,
            sellerId,
            "AMAZON_PAGINATION_REJECTED",
          ).toString()
        : null;
      nextHref = pageExhausted ? parsedNextHref : validatedUrl;
      interruption = null;
      recordStorePage(pageAudit, {
        url: validatedUrl, nextHref, status: "success", exhausted: pageExhausted,
        resultAsinCount: parsed.asins.length, addedAsinCount: asins.length - previousAsinCount,
        duplicateAsinCount: parsed.duplicateAsinCount + priorDuplicateCount,
        deferredAsinCount: parsed.asins.length - priorDuplicateCount - (asins.length - previousAsinCount),
        reportedTotalAsins: parsed.reportedTotalAsins, reportedTotalKind: parsed.reportedTotalKind,
        variantLinks: parsed.variantLinks, observedAsins: parsed.observedAsins,
        badgeExcludedCount: parsed.excludedUnder50Count || 0, badgeGateActive: parsed.badgeGateActive === true,
      });
      await emitStoreCheckpoint(onCheckpoint, enumerationResult({
        market: this.market,
        sellerId,
        storeName,
        asins,
        pagesVisited,
        reportedTotalAsins,
        pageAudit,
        nextHref,
        interruption,
        salesByAsin,
        transport: "edge",
        deliveryRegionReady: this.deliveryRegionReady,
      }));
      if (!nextHref || asins.length >= asinLimit) break;
      currentUrl = nextHref;
    }
    interruption = totalPageLimitInterruption(pagesVisited, nextHref, interruption);

    return enumerationResult({
      market: this.market,
      sellerId,
      storeName,
      asins,
      pagesVisited,
      reportedTotalAsins,
      pageAudit,
      nextHref,
      interruption,
      salesByAsin,
      transport: "edge",
      deliveryRegionReady: this.deliveryRegionReady,
    });
  }

  async resolveEdgeExecutable() {
    if (this.edgeExecutableResolved) return this.edgeExecutable;
    this.edgeExecutableResolved = true;
    if (process.platform !== "win32") return null;

    for (const candidate of installedEdgeCandidates()) {
      try {
        await access(candidate);
        this.edgeExecutable = candidate;
        return candidate;
      } catch {
        // Continue through the known machine and per-user Edge installation paths.
      }
    }
    return null;
  }

  async requestWithEdge(edgeExecutable, url, signal) {
    this.assertOpen();
    throwIfAborted(signal);
    const validatedUrl = assertAllowedAmazonUrl(url, this.market, "AMAZON_URL_REJECTED").toString();
    let finalFailureCode = "AMAZON_EDGE_NAVIGATION_FAILED";
    let finalFailureMessage = "Edge could not load the Amazon store page after one isolated retry.";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const edgeProxyUrl = process.env.HTTPS_PROXY
        || process.env.https_proxy
        || process.env.HTTP_PROXY
        || process.env.http_proxy
        || "";
      const proxyArguments = /^https?:\/\//i.test(edgeProxyUrl)
        ? [`--proxy-server=${edgeProxyUrl}`]
        : [];
      const argumentsList = [
        "--headless=new",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-quic",
        "--no-first-run",
        "--no-default-browser-check",
        "--metrics-recording-only",
        "--disable-features=msEdgeFirstRunExperience",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
        `--user-data-dir=${this.edgeProfileDirectory}`,
        `--disk-cache-dir=${this.edgeCacheDirectory}`,
        `--lang=${this.market.language.split(",", 1)[0]}`,
        "--dump-dom",
        ...proxyArguments,
        validatedUrl,
      ];

      let stdout;
      await this.waitForRequestSlot(signal);
      try {
        ({ stdout } = await this.executeBrowser(edgeExecutable, argumentsList, {
          encoding: "utf8",
          maxBuffer: MAX_RESPONSE_BYTES,
          timeout: REQUEST_TIMEOUT_MS,
          windowsHide: true,
          signal,
        }));
      } catch (error) {
        throwIfAborted(signal);
        throw new AmazonStoreError("AMAZON_EDGE_REQUEST_FAILED", `Amazon Edge request failed (${String(error?.code || "edge")}).`);
      } finally {
        this.lastRequestAt = Date.now();
      }
      const body = String(stdout || "");
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        throw new AmazonStoreError("AMAZON_RESPONSE_TOO_LARGE", "Amazon returned a store page larger than the allowed limit.");
      }
      const parsed = parseAmazonStorePage(body);
      if (parsed.rateLimited) {
        throw new AmazonStoreError("AMAZON_HTTP_429", "Amazon returned a rate-limit page.");
      }
      if (parsed.challenge) {
        throw new AmazonStoreError("AMAZON_ACCESS_CHALLENGE", "Amazon returned an automated-access challenge.");
      }
      if (!parsed.navigationError && !parsed.challenge && (parsed.asins.length > 0 || parsed.explicitEmpty || parsed.badgeGateActive)) {
        return { status: 200, body, effectiveUrl: validatedUrl };
      }
      if (!parsed.navigationError) {
        finalFailureCode = "AMAZON_EDGE_INVALID_STORE_PAGE";
        finalFailureMessage = "Edge returned a page without Amazon product results or an explicit empty-store state.";
      } else {
        finalFailureCode = "AMAZON_EDGE_NAVIGATION_FAILED";
        finalFailureMessage = "Edge could not load the Amazon store page after one isolated retry.";
      }
      if (attempt === 0) {
        this.edgeProfileGeneration += 1;
        this.edgeProfileDirectory = path.join(
          this.temporaryDirectory,
          `edge-profile-retry-${this.edgeProfileGeneration}`,
        );
        this.edgeCacheDirectory = path.join(
          this.temporaryDirectory,
          `edge-cache-retry-${this.edgeProfileGeneration}`,
        );
      }
    }
    throw new AmazonStoreError(finalFailureCode, finalFailureMessage);
  }

  async ensureEdgeCdpSession(signal) {
    this.assertOpen();
    throwIfAborted(signal);
    if (this.edgeCdpSession) return this.edgeCdpSession;
    const edgeExecutable = await this.resolveEdgeExecutable();
    if (!edgeExecutable) {
      throw new AmazonStoreError("AMAZON_EDGE_UNAVAILABLE", "Microsoft Edge is not installed; the browser channel is unavailable.");
    }
    const proxyUrl = process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || "";
    const session = new EdgeCdpSession({
      edgeExecutable,
      temporaryRoot: this.temporaryRoot,
      proxyUrl,
      language: this.market.language,
      requestIntervalMs: this.requestIntervalMs,
    });
    await session.open();
    this.edgeCdpSession = session;
    return session;
  }

  async setupEdgeCdpDeliveryRegion(cdp, signal) {
    if (!this.market.postalCode) {
      this.deliveryRegionReady.add("edge_cdp");
      return;
    }
    // The address-change endpoint is also WAF-throttled at times; retry the
    // bootstrap with a human-like pause instead of failing the store visit.
    const setupRetryLimit = 2;
    const transientCodes = new Set([
      "AMAZON_DELIVERY_REGION_FAILED",
      "AMAZON_EDGE_NAVIGATION_FAILED",
      "AMAZON_EDGE_REQUEST_FAILED",
    ]);
    let lastError = null;
    for (let attempt = 0; attempt <= setupRetryLimit; attempt += 1) {
      if (attempt > 0) {
        await abortableDelay(8_000 + Math.floor(Math.random() * 4_000), signal);
      }
      try {
        await confirmDeliveryRegion(async () => {
          await cdp.navigateUntilSettled(`${this.market.baseUrl}/`, signal);
          const response = await cdp.fetchInPage(`${this.market.baseUrl}/gp/delivery/ajax/address-change.html`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: deliveryRegionForm(this.market).toString(),
          });
          if (response.status !== 200) {
            throw new AmazonStoreError("AMAZON_DELIVERY_REGION_FAILED", `Amazon delivery region change returned HTTP ${response.status}.`);
          }
          return { body: response.body };
        }, this.market, signal);
        this.deliveryRegionReady.add("edge_cdp");
        return;
      } catch (error) {
        throwIfAborted(signal);
        if (!(error instanceof AmazonStoreError) || !transientCodes.has(error.code)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async enumerateStoreWithEdgeCdp(sellerId, { pageLimit, asinLimit, signal, resumeState, onCheckpoint }) {
    const cdp = await this.ensureEdgeCdpSession(signal);
    await this.setupEdgeCdpDeliveryRegion(cdp, signal);
    const asins = [...resumeState.asins];
    const seenAsins = new Set(asins);
    const pageAudit = [...resumeState.pageAudit];
    const salesByAsin = { ...resumeState.salesByAsin };
    const seenPages = new Set(pageAudit.filter((page) => page.status === "success" && page.exhausted !== false).map((page) => page.url));
    let currentUrl = resumeState.nextHref || buildSellerUrl(this.market, sellerId, 1);
    let storeName = resumeState.storeName;
    let pagesVisited = resumeState.pagesVisited;
    let nextHref = resumeState.nextHref;
    let interruption = resumeState.interruption;
    let reportedTotalAsins = resumeState.reportedTotalAsins;
    let pagesVisitedThisAttempt = 0;

    while (
      pagesVisitedThisAttempt < pageLimit
      && pagesVisited < MAX_STORE_TOTAL_PAGES
      && asins.length < asinLimit
    ) {
      throwIfAborted(signal);
      const validatedUrl = assertAllowedSellerPageUrl(
        currentUrl,
        currentUrl,
        this.market,
        sellerId,
        "AMAZON_PAGINATION_REJECTED",
      ).toString();
      if (seenPages.has(validatedUrl)) {
        interruption = { code: "AMAZON_PAGINATION_LOOP", message: "Amazon returned an already collected store page URL." };
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: interruption.code });
        break;
      }
      seenPages.add(validatedUrl);

      // Amazon intermittently serves HTTP 503 or a challenge leftover between
      // pagination pages. Refresh the same page with a human-like pause instead
      // of ending the whole store visit on the first hiccup.
      const pageRetryLimit = 2;
      let parsed = null;
      let pageFailure = null;
      for (let pageAttempt = 0; pageAttempt <= pageRetryLimit; pageAttempt += 1) {
        if (pageAttempt > 0) {
          await abortableDelay(9_000 + Math.floor(Math.random() * 4_000), signal);
        }
        await cdp.navigateUntilSettled(validatedUrl, signal);
        const body = await cdp.pageHtml();
        if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
          throw new AmazonStoreError("AMAZON_RESPONSE_TOO_LARGE", "Amazon returned a store page larger than the allowed limit.");
        }
        parsed = parseAmazonStorePage(body);
        pageFailure = amazonAccessPageError(parsed)
          || (parsed.asins.length === 0 && !parsed.explicitEmpty && !parsed.badgeGateActive
            ? new AmazonStoreError(
              "AMAZON_INVALID_STORE_PAGE",
              "Amazon returned a page without product results or an explicit empty-store state.",
            )
            : null);
        if (!pageFailure) break;
      }
      if (pageFailure) {
        const partial = resumableInterruption(pageFailure, asins.length);
        if (!partial) throw pageFailure;
        interruption = partial;
        nextHref = validatedUrl;
        recordStorePage(pageAudit, { url: validatedUrl, status: "failed", code: partial.code });
        break;
      }
      pagesVisited += 1;
      pagesVisitedThisAttempt += 1;
      if (!storeName && parsed.storeName) storeName = parsed.storeName;
      reportedTotalAsins = maximumKnownCount(reportedTotalAsins, parsed.reportedTotalAsins);
      mergeStoreCardSales(salesByAsin, parsed.salesByAsin);
      const previousAsinCount = asins.length;
      const priorDuplicateCount = parsed.asins.filter((asin) => seenAsins.has(asin)).length;
      const pageExhausted = appendUniqueAsins(asins, seenAsins, parsed.asins, asinLimit);
      const parsedNextHref = parsed.nextHref
        ? assertAllowedSellerPageUrl(
            parsed.nextHref,
            validatedUrl,
            this.market,
            sellerId,
            "AMAZON_PAGINATION_REJECTED",
          ).toString()
        : null;
      nextHref = pageExhausted ? parsedNextHref : validatedUrl;
      interruption = null;
      recordStorePage(pageAudit, {
        url: validatedUrl, nextHref, status: "success", exhausted: pageExhausted,
        resultAsinCount: parsed.asins.length, addedAsinCount: asins.length - previousAsinCount,
        duplicateAsinCount: parsed.duplicateAsinCount + priorDuplicateCount,
        deferredAsinCount: parsed.asins.length - priorDuplicateCount - (asins.length - previousAsinCount),
        reportedTotalAsins: parsed.reportedTotalAsins, reportedTotalKind: parsed.reportedTotalKind,
        variantLinks: parsed.variantLinks, observedAsins: parsed.observedAsins,
        badgeExcludedCount: parsed.excludedUnder50Count || 0, badgeGateActive: parsed.badgeGateActive === true,
      });
      await emitStoreCheckpoint(onCheckpoint, enumerationResult({
        market: this.market,
        sellerId,
        storeName,
        asins,
        pagesVisited,
        reportedTotalAsins,
        pageAudit,
        nextHref,
        interruption,
        salesByAsin,
        transport: "edge_cdp",
        deliveryRegionReady: this.deliveryRegionReady,
      }));
      if (!nextHref || asins.length >= asinLimit) break;
      currentUrl = nextHref;
    }
    interruption = totalPageLimitInterruption(pagesVisited, nextHref, interruption);

    return enumerationResult({
      market: this.market,
      sellerId,
      storeName,
      asins,
      pagesVisited,
      reportedTotalAsins,
      pageAudit,
      nextHref,
      interruption,
      salesByAsin,
      transport: "edge_cdp",
      deliveryRegionReady: this.deliveryRegionReady,
    });
  }

  async fetchProductDetailWithEdgeCdp(productUrl, normalizedAsin, signal) {
    this.assertOpen();
    throwIfAborted(signal);
    // All fallback workers share one browser tab. Keep initialization, region
    // setup, navigation and the matching DOM read in the same critical section.
    const pending = this.edgeCdpProductDetailQueue.then(async () => {
      this.assertOpen();
      throwIfAborted(signal);
      const cdp = await this.ensureEdgeCdpSession(signal);
      this.assertOpen();
      throwIfAborted(signal);
      if (!this.deliveryRegionReady.has("edge_cdp")) await this.setupEdgeCdpDeliveryRegion(cdp, signal);
      this.assertOpen();
      throwIfAborted(signal);
      await cdp.navigateUntilSettled(productUrl, signal);
      this.assertOpen();
      throwIfAborted(signal);
      const body = await cdp.pageHtml();
      this.assertOpen();
      throwIfAborted(signal);
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        throw new AmazonStoreError("AMAZON_RESPONSE_TOO_LARGE", "Amazon returned a product page larger than the allowed limit.");
      }
      return productDetailResult(
        parseAmazonProductPage(body, { marketplace: this.market.code, asin: normalizedAsin }),
        this.market,
        normalizedAsin,
        productUrl,
        "edge_cdp",
        this.deliveryRegionReady,
      );
    });
    // Preserve each caller's rejection, while allowing the next queued product
    // to run after a navigation, parsing or cancellation failure.
    this.edgeCdpProductDetailQueue = pending.catch(() => {});
    return pending;
  }

  async requestWithFetch(url, signal, request = {}) {
    this.assertOpen();
    throwIfAborted(signal);
    const requestGeneration = this.fetchSessionGeneration;
    let currentUrl = assertAllowedAmazonUrl(url, this.market, "AMAZON_URL_REJECTED").toString();
    let currentMethod = String(request.method || "GET").toUpperCase();
    let currentBody = request.body;
    let currentHeaders = { ...(request.headers || {}) };

    for (let redirectCount = 0; ; redirectCount += 1) {
      let response = null;
      let responseTimeoutSignal = null;
      let lastError = null;
      for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt += 1) {
        await this.waitForRequestSlot(signal);
        this.assertFetchSessionGeneration(requestGeneration);
        const timeoutSignal = AbortSignal.timeout(FETCH_REQUEST_TIMEOUT_MS);
        responseTimeoutSignal = timeoutSignal;
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const cookieHeader = [...this.fetchCookies.entries()]
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
        const headers = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
          "Accept-Language": this.market.language,
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Cache-Control": "no-cache",
          ...(currentMethod === "GET" ? { "Upgrade-Insecure-Requests": "1" } : {}),
          ...currentHeaders,
        };
        if (cookieHeader) headers.Cookie = cookieHeader;
        try {
          response = await this.executeFetch(currentUrl, {
            method: currentMethod,
            headers,
            ...(currentBody === undefined ? {} : { body: currentBody }),
            redirect: "manual",
            signal: requestSignal,
          });
          // An older request must not install its cookies into a replacement
          // session, even when that replacement has already finished setup.
          if (requestGeneration !== this.fetchSessionGeneration) {
            await cancelFetchBody(response);
            this.assertFetchSessionGeneration(requestGeneration);
          }
          captureFetchCookies(response?.headers, this.fetchCookies);
          if (!TRANSIENT_FETCH_STATUSES.has(Number(response?.status)) || attempt === FETCH_MAX_ATTEMPTS - 1) break;
          await cancelFetchBody(response);
          response = null;
        } catch (error) {
          throwIfAborted(signal);
          this.assertFetchSessionGeneration(requestGeneration);
          lastError = error;
          response = null;
          const timedOut = timeoutSignal.aborted;
          const mayRetry = attempt < Math.min(1, FETCH_MAX_ATTEMPTS - 1);
          if (!mayRetry) {
            throw new AmazonStoreError(
              timedOut ? "AMAZON_FETCH_TIMEOUT" : "AMAZON_FETCH_REQUEST_FAILED",
              timedOut ? "Amazon HTTPS request timed out." : `Amazon HTTPS request failed (${String(error?.code || error?.name || "fetch")}).`,
            );
          }
        } finally {
          this.lastRequestAt = Date.now();
        }
      }
      if (!response) {
        throw new AmazonStoreError(
          "AMAZON_FETCH_REQUEST_FAILED",
          `Amazon HTTPS request failed (${String(lastError?.code || lastError?.name || "fetch")}).`,
        );
      }

      const status = Number(response.status);
      if (REDIRECT_STATUSES.has(status)) {
        await cancelFetchBody(response);
        const location = response.headers?.get?.("location");
        if (!location) {
          throw new AmazonStoreError("AMAZON_INVALID_RESPONSE", "Amazon redirect did not include a valid target URL.");
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw new AmazonStoreError("AMAZON_TOO_MANY_REDIRECTS", "Amazon exceeded the allowed redirect limit.");
        }
        const currentSellerId = new URL(currentUrl).searchParams.get("me")?.toUpperCase();
        const currentProductAsin = productAsinFromUrl(currentUrl);
        currentUrl = currentSellerId && SELLER_ID_PATTERN.test(currentSellerId)
          ? assertAllowedSellerPageUrl(location, currentUrl, this.market, currentSellerId, "AMAZON_REDIRECT_REJECTED").toString()
          : currentProductAsin
            ? assertAllowedProductPageUrl(location, currentUrl, this.market, currentProductAsin, "AMAZON_PRODUCT_REDIRECT_REJECTED").toString()
            : assertAllowedAmazonUrl(new URL(location, currentUrl).toString(), this.market, "AMAZON_REDIRECT_REJECTED").toString();
        if (status === 303 || ([301, 302].includes(status) && currentMethod === "POST")) {
          currentMethod = "GET";
          currentBody = undefined;
          currentHeaders = withoutEntityHeaders(currentHeaders);
        }
        continue;
      }
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        await cancelFetchBody(response);
        throw new AmazonStoreError(`AMAZON_HTTP_${status || "ERROR"}`, `Amazon returned HTTP ${status || "error"}.`);
      }
      let body;
      try {
        body = await readBoundedFetchBody(response);
      } catch (error) {
        throwIfAborted(signal);
        this.assertFetchSessionGeneration(requestGeneration);
        if (error instanceof AmazonStoreError) throw error;
        const timedOut = responseTimeoutSignal?.aborted === true;
        throw new AmazonStoreError(
          timedOut ? "AMAZON_FETCH_TIMEOUT" : "AMAZON_FETCH_REQUEST_FAILED",
          timedOut ? "Amazon HTTPS response timed out." : `Amazon HTTPS response failed (${String(error?.code || error?.name || "stream")}).`,
        );
      }
      this.assertFetchSessionGeneration(requestGeneration);
      return {
        status,
        body,
        effectiveUrl: currentUrl,
      };
    }
  }

  async request(url, additionalArguments, signal, includeCookies) {
    this.assertOpen();
    throwIfAborted(signal);
    const command = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe")
      : "curl";
    let currentUrl = assertAllowedAmazonUrl(url, this.market, "AMAZON_URL_REJECTED").toString();
    let currentArguments = [...additionalArguments];

    for (let redirectCount = 0; ; redirectCount += 1) {
      await this.waitForRequestSlot(signal);
      const argumentsList = [
        "--silent",
        "--show-error",
        "--proto", "=https",
        "--compressed",
        "--connect-timeout", "15",
        "--max-time", "45",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
        "--header", `Accept-Language: ${this.market.language}`,
        "--header", "Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "--cookie-jar", this.cookieFile,
      ];
      if ((includeCookies || this.curlInitialized) && this.market.useCookies !== false) {
        argumentsList.push("--cookie", this.cookieFile);
      }
      argumentsList.push(
        ...currentArguments,
        "--write-out",
        "\n__SCOUT_HTTP_META__:%{http_code}|%{url_effective}|%{redirect_url}",
        currentUrl,
      );

      let stdout;
      try {
        ({ stdout } = await this.executeRequest(command, argumentsList, {
          encoding: "utf8",
          maxBuffer: MAX_RESPONSE_BYTES,
          timeout: REQUEST_TIMEOUT_MS,
          windowsHide: true,
          signal,
        }));
        this.lastRequestAt = Date.now();
      } catch (error) {
        throwIfAborted(signal);
        throw new AmazonStoreError("AMAZON_REQUEST_FAILED", `Amazon request failed (${String(error?.code || "curl")}).`);
      }

      const parsed = parseCurlResponse(stdout, this.market);
      if (!REDIRECT_STATUSES.has(parsed.status)) {
        if (!Number.isInteger(parsed.status) || parsed.status < 200 || parsed.status >= 300) {
          throw new AmazonStoreError(`AMAZON_HTTP_${parsed.status || "ERROR"}`, `Amazon returned HTTP ${parsed.status || "error"}.`);
        }
        const currentSellerId = new URL(currentUrl).searchParams.get("me")?.toUpperCase();
        const currentProductAsin = productAsinFromUrl(currentUrl);
        if (currentSellerId && SELLER_ID_PATTERN.test(currentSellerId)) {
          assertAllowedSellerPageUrl(parsed.effectiveUrl, currentUrl, this.market, currentSellerId, "AMAZON_REDIRECT_REJECTED");
        } else if (currentProductAsin) {
          assertAllowedProductPageUrl(parsed.effectiveUrl, currentUrl, this.market, currentProductAsin, "AMAZON_PRODUCT_REDIRECT_REJECTED");
        }
        return { status: parsed.status, body: parsed.body, effectiveUrl: parsed.effectiveUrl };
      }
      if (!parsed.redirectUrl) {
        throw new AmazonStoreError("AMAZON_INVALID_RESPONSE", "Amazon redirect did not include a valid target URL.");
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw new AmazonStoreError("AMAZON_TOO_MANY_REDIRECTS", "Amazon exceeded the allowed redirect limit.");
      }
      const currentSellerId = new URL(currentUrl).searchParams.get("me")?.toUpperCase();
      const currentProductAsin = productAsinFromUrl(currentUrl);
      currentUrl = currentSellerId && SELLER_ID_PATTERN.test(currentSellerId)
        ? assertAllowedSellerPageUrl(parsed.redirectUrl, currentUrl, this.market, currentSellerId, "AMAZON_REDIRECT_REJECTED").toString()
        : currentProductAsin
          ? assertAllowedProductPageUrl(parsed.redirectUrl, currentUrl, this.market, currentProductAsin, "AMAZON_PRODUCT_REDIRECT_REJECTED").toString()
          : assertAllowedAmazonUrl(parsed.redirectUrl, this.market, "AMAZON_REDIRECT_REJECTED").toString();
      currentArguments = redirectedRequestArguments(parsed.status, currentArguments);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const edgeCdpSession = this.edgeCdpSession;
    this.edgeCdpSession = null;
    if (edgeCdpSession) {
      await edgeCdpSession.close().catch(() => {});
    }
    try {
      const resolvedDirectory = await realpath(this.temporaryDirectory);
      const relative = path.relative(this.temporaryRoot, resolvedDirectory);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolvedDirectory).startsWith("scout-amazon-")) return;
      await rm(resolvedDirectory, { recursive: true, force: true });
    } catch {
      // Temporary sessions expire with the operating system even if cleanup is unavailable.
    }
  }

  assertOpen() {
    if (this.closed) throw new AmazonStoreError("AMAZON_SESSION_CLOSED", "Amazon store session is closed.");
  }

  async waitForRequestSlot(signal) {
    // 滑动窗口限速：允许并发请求，但限制一个时间窗口内的请求密度，
    // 兼顾「同节点并发提速」与「不触发 Amazon WAF」的平衡。
    const now = Date.now();
    if (!Array.isArray(this.requestTimestamps)) this.requestTimestamps = [];
    const windowMs = Math.max(500, this.requestIntervalMs);
    // 移除窗口外的历史请求
    while (this.requestTimestamps.length && this.requestTimestamps[0] <= now - windowMs) {
      this.requestTimestamps.shift();
    }
    // 窗口内允许的并发请求数（上限 3；间隔越大、并发越保守）
    const maxInWindow = Math.max(1, Math.min(3, Math.round(3_600 / windowMs)));
    if (this.requestTimestamps.length >= maxInWindow) {
      const waitMs = this.requestTimestamps[0] + windowMs - now + Math.floor(Math.random() * Math.min(350, windowMs));
      if (waitMs > 0) await abortableDelay(waitMs, signal);
      // 等待后重新裁剪窗口
      const now2 = Date.now();
      while (this.requestTimestamps.length && this.requestTimestamps[0] <= now2 - windowMs) {
        this.requestTimestamps.shift();
      }
    }
    this.requestTimestamps.push(Date.now());
  }
}

async function readBoundedFetchBody(response) {
  const body = response?.body;
  if (!body) return "";
  if (typeof body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) {
      throw new AmazonStoreError("AMAZON_RESPONSE_TOO_LARGE", "Amazon returned a store page larger than the allowed limit.");
    }
    return buffer.toString("utf8");
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new AmazonStoreError("AMAZON_RESPONSE_TOO_LARGE", "Amazon returned a store page larger than the allowed limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function cancelFetchBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is being discarded before a retry or validated redirect.
  }
}

function captureFetchCookies(headers, target) {
  if (!headers || !(target instanceof Map)) return;
  const rawValues = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get?.("set-cookie")].filter(Boolean);
  for (const rawValue of rawValues) {
    const pair = String(rawValue || "").split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\x00-\x20\x7f;]/.test(value) || value.length > 4096) continue;
    if (/(?:^|;)\s*max-age=0(?:;|$)/i.test(String(rawValue))) target.delete(name);
    else target.set(name, value);
  }
}

function parseCurlResponse(stdout, market) {
  const marker = "\n__SCOUT_HTTP_META__:";
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) throw new AmazonStoreError("AMAZON_INVALID_RESPONSE", "Amazon response did not include an HTTP status.");
  const body = stdout.slice(0, markerIndex);
  const metadata = stdout.slice(markerIndex + marker.length).trim();
  const firstSeparator = metadata.indexOf("|");
  const secondSeparator = firstSeparator < 0 ? -1 : metadata.indexOf("|", firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) {
    throw new AmazonStoreError("AMAZON_INVALID_RESPONSE", "Amazon response metadata was incomplete.");
  }
  const status = Number(metadata.slice(0, firstSeparator));
  const effectiveUrl = metadata.slice(firstSeparator + 1, secondSeparator);
  const redirectUrl = metadata.slice(secondSeparator + 1);
  assertAllowedAmazonUrl(effectiveUrl, market, "AMAZON_REDIRECT_REJECTED");
  return { status, body, effectiveUrl, redirectUrl };
}

function assertAllowedAmazonUrl(value, market, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AmazonStoreError(code, "Amazon returned an invalid request URL.");
  }
  if (
    url.origin !== market.baseUrl
    || url.username
    || url.password
    || !isAllowedAmazonPath(url.pathname)
  ) {
    throw new AmazonStoreError(code, "Amazon request URL is outside the selected marketplace.");
  }
  return url;
}

function assertAllowedSellerPageUrl(value, baseUrl, market, sellerId, code) {
  let resolved;
  try {
    resolved = new URL(value, baseUrl);
  } catch {
    throw new AmazonStoreError(code, "Amazon returned an invalid store pagination URL.");
  }
  const url = assertAllowedAmazonUrl(resolved, market, code);
  if (!isSellerSearchPath(url.pathname) || url.searchParams.get("me")?.toUpperCase() !== sellerId) {
    throw new AmazonStoreError(code, "Amazon store pagination left the selected seller.");
  }
  const marketplaceId = url.searchParams.get("marketplaceID");
  if (marketplaceId && marketplaceId !== market.marketplaceId) {
    throw new AmazonStoreError(code, "Amazon store pagination changed marketplace.");
  }
  return url;
}

function assertAllowedProductPageUrl(value, baseUrl, market, asin, code) {
  let resolved;
  try {
    resolved = new URL(value, baseUrl);
  } catch {
    throw new AmazonStoreError(code, "Amazon returned an invalid product URL.");
  }
  const url = assertAllowedAmazonUrl(resolved, market, code);
  if (productAsinFromUrl(url) !== asin) {
    throw new AmazonStoreError(code, "Amazon product navigation left the selected ASIN.");
  }
  return url;
}

function isAllowedAmazonPath(pathname) {
  return pathname === "/"
    || pathname === "/s"
    || pathname === "/gp/delivery/ajax/address-change.html"
    || /^\/dp\/[A-Z0-9]{10}\/?$/i.test(pathname)
    || /^\/-\/[a-z]{2}(?:-[a-z]{2})?\/s$/i.test(pathname);
}

function isSellerSearchPath(pathname) {
  return pathname === "/s" || /^\/-\/[a-z]{2}(?:-[a-z]{2})?\/s$/i.test(pathname);
}

function productAsinFromUrl(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
  const match = url.pathname.match(/^\/dp\/([A-Z0-9]{10})\/?$/i);
  return match?.[1]?.toUpperCase() || null;
}

function installedEdgeCandidates() {
  // Scheduled-task / service contexts may lack standard environment variables,
  // so fall back to the fixed Windows install locations as well.
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    localAppData && path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  return [...new Set(candidates)];
}

function redirectedRequestArguments(status, argumentsList) {
  const requestIndex = argumentsList.lastIndexOf("--request");
  const method = requestIndex >= 0 ? String(argumentsList[requestIndex + 1] || "GET").toUpperCase() : "GET";
  return status === 303 || ((status === 301 || status === 302) && method === "POST")
    ? []
    : argumentsList;
}

function withoutEntityHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => ![
    "content-length",
    "content-type",
    "origin",
  ].includes(String(name).toLowerCase())));
}

function deliveryRegionForm(market) {
  return new URLSearchParams({
    locationType: "LOCATION_INPUT",
    zipCode: market.postalCode,
    storeContext: "generic",
    pageType: "Gateway",
    actionSource: "glow",
  });
}

function deliveryRegionMetadata(market, transport, readyTransports) {
  const usesPostalCode = Boolean(market.postalCode);
  return {
    deliveryPostalCode: market.postalCode,
    deliveryRegionReady: usesPostalCode ? readyTransports.has(transport) : true,
    deliveryRegionMode: usesPostalCode ? "postal_code" : "marketplace_domain",
  };
}

async function confirmDeliveryRegion(requestRegionChange, market, signal) {
  let lastError = null;
  for (let attempt = 0; attempt < DELIVERY_REGION_MAX_ATTEMPTS; attempt += 1) {
    const response = await requestRegionChange();
    try {
      assertDeliveryRegionAccepted(response.body, market);
      return;
    } catch (error) {
      if (error?.code !== "AMAZON_DELIVERY_REGION_FAILED") throw error;
      lastError = error;
      if (attempt + 1 < DELIVERY_REGION_MAX_ATTEMPTS) {
        await abortableDelay(250, signal);
      }
    }
  }
  throw lastError;
}

function assertDeliveryRegionAccepted(body, market) {
  let payload;
  try {
    payload = JSON.parse(String(body || ""));
  } catch {
    throw new AmazonStoreError(
      "AMAZON_DELIVERY_REGION_FAILED",
      `Amazon did not confirm delivery region ${market.postalCode}.`,
    );
  }
  const accepted = [true, 1, "1"].includes(payload?.isValidAddress)
    && [true, 1, "1"].includes(payload?.isAddressUpdated)
    && [true, 1, "1"].includes(payload?.successful);
  const returnedPostalCode = String(payload?.address?.zipCode || "").replace(/\s+/g, "").toUpperCase();
  const expectedPostalCode = String(market.postalCode || "").replace(/\s+/g, "").toUpperCase();
  const returnedCountryCode = String(payload?.address?.countryCode || "").trim().toUpperCase();
  if (!accepted || returnedPostalCode !== expectedPostalCode || returnedCountryCode !== market.countryCode) {
    throw new AmazonStoreError(
      "AMAZON_DELIVERY_REGION_REJECTED",
      `Amazon rejected delivery region ${market.postalCode} for ${market.code}.`,
    );
  }
}

function appendUniqueAsins(target, seen, pageAsins, limit) {
  for (const asin of pageAsins) {
    if (seen.has(asin)) continue;
    if (target.length >= limit) return false;
    seen.add(asin);
    target.push(asin);
  }
  return true;
}

function amazonAccessPageError(parsed) {
  if (parsed.rateLimited) {
    return new AmazonStoreError("AMAZON_HTTP_429", "Amazon returned a rate-limit page.");
  }
  if (parsed.challenge) {
    return new AmazonStoreError("AMAZON_ACCESS_CHALLENGE", "Amazon returned an automated-access challenge.");
  }
  return null;
}

function resumableInterruption(error, discoveredAsinCount) {
  if (!discoveredAsinCount || !(error instanceof AmazonStoreError)) return null;
  if (!RESUMABLE_INTERRUPTION_ERRORS.has(error.code)) return null;
  return {
    code: error.code,
    message: String(error.message || "Amazon store discovery was interrupted."),
  };
}

function isRecoverableEdgeFailure(error) {
  return error instanceof AmazonStoreError && (
    error.code === "AMAZON_EDGE_NAVIGATION_FAILED"
    || error.code === "AMAZON_EDGE_INVALID_STORE_PAGE"
    || error.code === "AMAZON_EDGE_REQUEST_FAILED"
  );
}

function isRecoverableFetchFailure(error) {
  return error instanceof AmazonStoreError && (
    error.code === "AMAZON_FETCH_REQUEST_FAILED"
    || error.code === "AMAZON_FETCH_TIMEOUT"
    || error.code === "AMAZON_DELIVERY_REGION_FAILED"
    || error.code === "AMAZON_INVALID_STORE_PAGE"
    || [500, 502, 503, 504].some((status) => error.code === `AMAZON_HTTP_${status}`)
  );
}

function isRecoverableProductFetchFailure(error) {
  return isRecoverableFetchFailure(error)
    || error instanceof AmazonStoreError && (
      error.code === "AMAZON_INVALID_PRODUCT_PAGE"
      || error.code === "AMAZON_PRODUCT_NAVIGATION_FAILED"
    );
}

function isBrowserNavigationError(source) {
  const $ = load(String(source || ""));
  // Amazon scripts contain counters such as err_count and network error
  // constants. Only rendered browser-error evidence describes navigation.
  $("script, style, template, noscript").remove();
  if ($("#main-frame-error, html.neterror, body.neterror, html.network-error, body.network-error").length) return true;
  if (/\bERR_[A-Z0-9_]{3,}\b/.test($("#error-code, .error-code").text())) return true;
  if ($("#productTitle, #dp, #search").length) return false;
  const visibleText = $("body").text();
  return /\bERR_[A-Z0-9_]{3,}\b/.test(visibleText)
    || /(?:chrome|edge)-error:\/\/(?:chrome|edge)webdata/i.test(visibleText);
}

function maximumKnownCount(current, candidate) {
  if (!Number.isInteger(candidate) || candidate < 0) return current;
  return Number.isInteger(current) && current >= 0 ? Math.max(current, candidate) : candidate;
}

function knownCountGap(reportedTotalAsins, enumeratedAsins) {
  if (!Number.isInteger(reportedTotalAsins) || reportedTotalAsins < 0) return 0;
  return Math.max(0, reportedTotalAsins - Math.max(0, Number(enumeratedAsins) || 0));
}

function normalizeStoreResume(market, sellerId, value, asinLimit) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      asins: [],
      storeName: null,
      pagesVisited: 0,
      reportedTotalAsins: null,
      pageAudit: [],
      nextHref: null,
      interruption: null,
      salesByAsin: {},
    };
  }
  const salesByAsin = normalizeStoreCardSales(value.salesByAsin, asinLimit);
  const asins = [];
  const seen = new Set();
  const savedAsins = [...(Array.isArray(value.asins) ? value.asins : []),
    ...(Array.isArray(value.observedAsins) ? value.observedAsins : []),
    ...(Array.isArray(value.pageAudit) ? value.pageAudit : []).filter(page => page?.status === "success")
      .flatMap(page => Array.isArray(page.observedAsins) ? page.observedAsins : [])];
  for (const rawAsin of savedAsins) {
    const asin = String(rawAsin || "").trim().toUpperCase();
    if (!ASIN_PATTERN.test(asin) || seen.has(asin)) continue;
    seen.add(asin);
    asins.push(asin);
    if (asins.length >= asinLimit) break;
  }
  const nextHref = value.nextHref
    ? assertAllowedSellerPageUrl(
        value.nextHref,
        buildSellerUrl(market, sellerId, 1),
        market,
        sellerId,
        "AMAZON_RESUME_URL_REJECTED",
      ).toString()
    : null;
  const interruption = value.interruption && typeof value.interruption === "object"
    ? {
        code: String(value.interruption.code || "AMAZON_STORE_VISIT_INTERRUPTED").slice(0, 80),
        message: String(value.interruption.message || "Amazon store discovery was interrupted.").slice(0, 500),
      }
    : null;
  const pageAudit = normalizePageAudit(value.pageAudit, market, sellerId);
  const lastSuccessfulPage = pageAudit.findLast((page) => page.status === "success");
  if (lastSuccessfulPage) {
    lastSuccessfulPage.observedAsins = [...new Set([
      ...(lastSuccessfulPage.observedAsins || []),
      ...(Array.isArray(value.asins) ? value.asins : []).map((asin) => String(asin).trim().toUpperCase()).filter((asin) => ASIN_PATTERN.test(asin)),
    ])];
  }
  return {
    asins,
    storeName: typeof value.storeName === "string" ? value.storeName.trim().slice(0, 200) || null : null,
    pagesVisited: boundedInteger(value.pagesVisited, 0, MAX_STORE_TOTAL_PAGES, 0),
    reportedTotalAsins: Number.isInteger(value.reportedTotalAsins) && value.reportedTotalAsins >= 0
      ? value.reportedTotalAsins
      : null,
    pageAudit,
    nextHref,
    interruption,
    salesByAsin,
  };
}

// 店铺卡片角标读数（asin -> { sales30, rawText }）跨分页/断点保留，用于给商品条目
// 预填月销量下界（详情页采集成功后由产品页角标覆盖）。
function normalizeStoreCardSales(value, asinLimit) {
  const sales = {};
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  for (const [rawAsin, entry] of Object.entries(source)) {
    const asin = String(rawAsin || "").trim().toUpperCase();
    if (!ASIN_PATTERN.test(asin)) continue;
    const sales30 = Number.isInteger(entry?.sales30) && entry.sales30 >= 0 ? entry.sales30 : null;
    if (sales30 === null) continue;
    const rawText = String(entry?.rawText || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    if (!rawText || parseAmazonMonthlySales(rawText) !== sales30) continue;
    sales[asin] = { sales30, rawText };
    if (Object.keys(sales).length >= asinLimit) break;
  }
  return sales;
}

// 合并一页解析出的卡片角标读数（首次读到即保留，翻页/重试不会覆盖）。
function mergeStoreCardSales(target, pageSales) {
  const source = pageSales && typeof pageSales === "object" && !Array.isArray(pageSales) ? pageSales : {};
  for (const [asin, entry] of Object.entries(source)) {
    if (target[asin] || !Number.isInteger(entry?.sales30) || entry.sales30 < 0) continue;
    target[asin] = entry.rawText ? { sales30: entry.sales30, rawText: entry.rawText } : { sales30: entry.sales30 };
  }
}


function normalizePageAudit(value, market, sellerId) {
  return (Array.isArray(value) ? value : []).filter((page) => page && typeof page === "object").map((page) => {
    const url = assertAllowedSellerPageUrl(page.url, buildSellerUrl(market, sellerId, 1), market, sellerId, "AMAZON_RESUME_URL_REJECTED").toString();
    return { ...page, url };
  });
}

function recordStorePage(pageAudit, page) {
  pageAudit.push({ ...page, collectedAt: new Date().toISOString() });
}

function storeCoverageEvidence({ pageAudit, reportedTotalAsins, notEnumeratedAsins, nextHref, interruption }) {
  const successfulPages = pageAudit.filter((page) => page.status === "success");
  const knownKinds = successfulPages.filter((page) => page.reportedTotalAsins === reportedTotalAsins).map((page) => page.reportedTotalKind);
  const reportedTotalKind = knownKinds.includes("lower_bound") ? "lower_bound"
    : knownKinds.includes("exact") ? "exact" : reportedTotalAsins === null ? "unknown" : "legacy_unverified";
  const paginationComplete = !nextHref && !interruption;
  return {
    version: "1.0",
    scope: "amazon_visible_store_results",
    paginationComplete,
    fullStoreComplete: false,
    status: paginationComplete && notEnumeratedAsins === 0 && reportedTotalKind === "exact" ? "visible_scope_complete" : "partial",
    reportedTotalKind,
    knownMissingAsins: reportedTotalAsins === null ? null : notEnumeratedAsins,
    collectedAt: pageAudit.at(-1)?.collectedAt || null,
    successfulPageAttempts: successfulPages.length,
    failedPageAttempts: pageAudit.filter((page) => page.status === "failed").length,
    duplicateAsinOccurrences: successfulPages.reduce((sum, page) => sum + (page.duplicateAsinCount || 0), 0),
    variantScope: "all_search_result_card_asins; explicit_product_links_audit_only",
  };
}

function totalPageLimitInterruption(pagesVisited, nextHref, interruption) {
  if (pagesVisited < MAX_STORE_TOTAL_PAGES || (!nextHref && !interruption)) return interruption;
  return {
    code: "AMAZON_STORE_TOTAL_PAGE_LIMIT_REACHED",
    message: `Amazon store discovery reached the ${MAX_STORE_TOTAL_PAGES}-page cumulative safety limit.`,
  };
}

function enumerationResult({
  market,
  sellerId,
  storeName,
  asins,
  pagesVisited,
  reportedTotalAsins,
  pageAudit = [],
  nextHref,
  interruption,
  salesByAsin = {},
  transport,
  deliveryRegionReady,
}) {
  // Coverage counts all observed cards, independently of candidate eligibility.
  // Repeated cards across pages must not inflate coverage or exclusion totals.
  const observedAsins = new Set(asins);
  for (const page of pageAudit) {
    if (page.status !== "success") continue;
    for (const asin of page.observedAsins || []) if (ASIN_PATTERN.test(asin)) observedAsins.add(asin);
  }
  const notEnumeratedAsins = knownCountGap(reportedTotalAsins, observedAsins.size);
  const normalizedSales = normalizeStoreCardSales(salesByAsin, MAX_STORE_ASINS);
  const excludedUnder50Count = [...observedAsins].filter((asin) => (normalizedSales[asin]?.sales30 ?? -1) < MIN_STORE_CARD_MONTHLY_SALES).length;
  return {
    marketplace: market.code,
    sellerId,
    storeName,
    asins: [...asins],
    observedAsins: [...observedAsins],
    salesByAsin: normalizedSales,
    excludedUnder50Count,
    pagesVisited,
    reportedTotalAsins,
    notEnumeratedAsins,
    pageAudit: pageAudit.map((page) => ({ ...page })),
    coverageEvidence: storeCoverageEvidence({ pageAudit, reportedTotalAsins, notEnumeratedAsins, nextHref, interruption }),
    truncated: Boolean(nextHref) || notEnumeratedAsins > 0,
    complete: !nextHref && !interruption && notEnumeratedAsins === 0,
    nextHref: nextHref || null,
    interruption: interruption || null,
    canonicalUrl: buildSellerUrl(market, sellerId, 1),
    ...deliveryRegionMetadata(market, transport, deliveryRegionReady),
  };
}

async function emitStoreCheckpoint(callback, result) {
  if (typeof callback === "function") await callback(result);
}

function parseReportedTotalAsins($) {
  const headerTexts = [];
  const selectors = [
    '[data-component-type="s-result-info-bar"]',
    "#search .s-desktop-toolbar",
    "#search .a-section.a-spacing-small.a-spacing-top-small",
    "main .a-section.a-spacing-small.a-spacing-top-small",
  ];
  selectors.forEach((selector) => {
    $(selector).slice(0, 4).each((_index, element) => {
      const text = $(element).text().replace(/\s+/g, " ").trim();
      if (text) headerTexts.push(text);
    });
  });
  const text = [...new Set(headerTexts)].join(" ");
  const patterns = [
    /\b\d[\d,.\s]*\s*[-\u2013]\s*\d[\d,.\s]*\s+(?:of|van)\s+(?:(?:over|meer dan)\s+)?([\d,.\s]+?)\s+(?:results?|resultaten?)\b/i,
    /\b(?:(?:over|meer dan)\s+)?([\d,.]+)\s+(?:results?|resultaten?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/\D/g, ""));
    if (Number.isSafeInteger(value) && value >= 0) return { value, kind: /\b(?:over|meer dan)\b/i.test(match[0]) ? "lower_bound" : "exact" };
  }
  return { value: null, kind: "unknown" };
}

export function parseAmazonStorePage(html) {
  const source = String(html || "");
  const $ = load(source);
  const title = $("title").first().text().trim();
  const navigationError = isBrowserNavigationError(source);
  const rateLimited = /(?:\b429\b.{0,80}\btoo many requests\b|\btoo many requests\b.{0,80}\b429\b|request (?:rate )?limit(?:ed)?|temporarily rate limited)/is.test(source)
    || /^\s*429(?:\s|-|:)/i.test(title);
  const challenge = /\/(?:_sec\/verify|errors\/validatecaptcha|ap\/cvf)\b|bm-verify|automated[-\s]+access|robot check|enter the characters you see below|api-services-support@amazon\.com|unusual activity|make sure you(?:'|&#39;)?re not a robot|verify that you(?:'|&#39;)?re not a robot|awswaf\.com|AwsWafIntegration|challenge-container|window\.gokuProps/i.test(source)
    || /^robot check$/i.test(title)
    || title === "\u00a0"
    || title === "&nbsp;";
  if (navigationError) {
    return {
      asins: [],
      salesByAsin: {},
      excludedUnder50Count: 0,
      badgeGateActive: false,
      hasNext: false,
      nextHref: null,
      storeName: null,
      challenge: false,
      rateLimited,
      navigationError: true,
      explicitEmpty: false,
      reportedTotalAsins: null,
    };
  }
  const asins = [];
  const seen = new Set();
  const variantLinks = [];
  const salesByAsin = {};
  let duplicateAsinCount = 0;
  // 第一遍：读取每张卡片的 ASIN 与月销量角标（大图下方 "X+ bought in past month"）。
  const storeCards = [];
  $('[data-component-type="s-search-result"][data-asin]').each((_index, element) => {
    const card = $(element);
    const asin = String(card.attr("data-asin") || "").trim().toUpperCase();
    const hasCardAsin = ASIN_PATTERN.test(asin);
    // Amazon also renders this explicit purchase statement in ordinary spans.
    // A nested result/variant must not supply evidence for its enclosing card.
    let badgeText = "";
    let badgeValue = null;
    const badgeNodes = card.find([...STORE_CARD_MONTHLY_SALES_SELECTORS, "span"].join(", "));
    for (const node of badgeNodes.toArray()) {
      const badge = $(node);
      if (badge.closest("[data-asin]")[0] !== card[0]) continue;
      if (badge.find("[data-asin]").length) continue;
      const text = badge.text().replace(/\s+/g, " ").trim();
      if (!text || text.length > 120) continue;
      const value = parseAmazonMonthlySales(text);
      if (value === null) continue;
      badgeText = text;
      badgeValue = value;
      break;
    }
    storeCards.push({ card, asin, hasCardAsin, badgeText, badgeValue });
  });
  // Discover every product first. Monthly purchase evidence gates candidates later.
  const badgeGateActive = false;
  const observedAsins = [...new Set(storeCards.filter((entry) => entry.hasCardAsin).map((entry) => entry.asin))];
  for (const { card, asin, hasCardAsin, badgeText, badgeValue } of storeCards) {
    if (!hasCardAsin) continue;
    if (hasCardAsin) {
      if (!seen.has(asin)) {
        seen.add(asin);
        asins.push(asin);
      } else {
        duplicateAsinCount += 1;
      }
    }

    if (badgeValue !== null && !salesByAsin[asin]) salesByAsin[asin] = { sales30: badgeValue, rawText: badgeText };

    card.find('a[href*="/dp/"], a[href*="/gp/product/"]').each((_linkIndex, link) => {
      const href = String($(link).attr("href") || "");
      const match = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
      const linkedAsin = match?.[1]?.toUpperCase();
      if (!linkedAsin) return;
      if (linkedAsin !== asin && hasCardAsin && !variantLinks.some((entry) => entry.cardAsin === asin && entry.linkedAsin === linkedAsin)) {
        variantLinks.push({ cardAsin: asin, linkedAsin, relationship: "linked_product_unverified_variant" });
      }
      // Other ASIN links are provenance only; do not borrow the enclosing card badge.
    });
  }
  const excludedUnder50Count = observedAsins.filter(asin => (salesByAsin[asin]?.sales30 ?? -1) < MIN_STORE_CARD_MONTHLY_SALES).length;
  const nextLink = $("a.s-pagination-next").first();
  const nextHref = nextLink.length && !nextLink.hasClass("s-pagination-disabled")
    ? String(nextLink.attr("href") || "").trim() || null
    : null;
  const hasNext = Boolean(nextHref);
  const resultText = $("#search, main, [role=\"main\"]").text().replace(/\s+/g, " ").trim();
  const explicitEmpty = /\b(?:no results|0 results|did not match any products)\b|geen (?:zoek)?resultaten|geen producten gevonden|leverde geen resultaten op/i.test(resultText);
  const totalEvidence = parseReportedTotalAsins($);
  const reportedTotalAsins = totalEvidence.value ?? (explicitEmpty ? 0 : null);
  const reportedTotalKind = explicitEmpty ? "exact" : totalEvidence.kind;
  const storeName = navigationError
    ? null
    : cleanStoreName(
      $("#twotabsearchtextbox").attr("value")
        || $('input[name="field-keywords"]').attr("value")
        || $("h1").first().text(),
    );
  return {
    asins,
    salesByAsin,
    observedAsins,
    excludedUnder50Count,
    badgeGateActive,
    hasNext,
    nextHref,
    storeName,
    challenge,
    rateLimited,
    navigationError,
    explicitEmpty,
    reportedTotalAsins,
    reportedTotalKind,
    duplicateAsinCount,
    variantLinks,
  };
}

export function parseAmazonProductPage(html, { marketplace = "US", asin = null } = {}) {
  const market = requireMarket(marketplace);
  const requestedAsin = asin === null || asin === undefined || asin === ""
    ? null
    : String(asin).trim().toUpperCase();
  if (requestedAsin && !ASIN_PATTERN.test(requestedAsin)) {
    throw new AmazonStoreError("INVALID_ASIN", "Amazon ASIN is invalid.");
  }

  const source = String(html || "");
  const $ = load(source);
  const documentTitle = $("title").first().text().trim();
  const navigationError = isBrowserNavigationError(source);
  const rateLimited = /(?:\b429\b.{0,80}\btoo many requests\b|\btoo many requests\b.{0,80}\b429\b|request (?:rate )?limit(?:ed)?|temporarily rate limited)/is.test(source)
    || /^\s*429(?:\s|-|:)/i.test(documentTitle);
  const challenge = /\/(?:_sec\/verify|errors\/validatecaptcha|ap\/cvf)\b|bm-verify|automated[-\s]+access|robot check|enter the characters you see below|api-services-support@amazon\.com|unusual activity|make sure you(?:'|&#39;)?re not a robot|verify that you(?:'|&#39;)?re not a robot|awswaf\.com|AwsWafIntegration|challenge-container|window\.gokuProps/i.test(source)
    || /^robot check$/i.test(documentTitle)
    || documentTitle === "\u00a0"
    || documentTitle === "&nbsp;";
  const pageAsin = productPageAsin($);
  if (requestedAsin && pageAsin && requestedAsin !== pageAsin) {
    throw new AmazonStoreError("AMAZON_PRODUCT_ASIN_MISMATCH", "Amazon returned details for a different ASIN.");
  }
  const jsonLd = findJsonLdProduct($, requestedAsin || pageAsin);

  const title = cleanProductText($("#productTitle").first().text())
    || cleanProductText(jsonLd?.name);
  const priceResult = firstAmazonPrice($, market, jsonLd, requestedAsin || pageAsin);
  const currentPrice = priceResult?.price ?? null;
  const imageUrl = firstAmazonImage($, jsonLd);
  const ratingResult = firstAmazonRating($, jsonLd, requestedAsin || pageAsin);
  const rating = ratingResult?.value ?? null;
  const reviewCountResult = firstAmazonReviewCount($, jsonLd, requestedAsin || pageAsin);
  const reviewCount = reviewCountResult?.value ?? null;
  const monthlySales = firstAmazonMonthlySales($, requestedAsin || pageAsin);
  const sales30 = monthlySales?.value ?? null;
  const details = amazonProductDetailPairs($, requestedAsin || pageAsin);
  const identity = amazonProductIdentity(details, requestedAsin || pageAsin);
  const productWeight = firstDetailWeight(details, PRODUCT_WEIGHT_LABELS, market)
    ?? firstDetailWeight(details, PRODUCT_DIMENSION_LABELS, market)
    ?? schemaWeightResult(jsonLd?.weight, market)
    ?? firstInlineWeight(details, market, "product");
  const packageWeight = firstDetailWeight(details, PACKAGE_WEIGHT_LABELS, market)
    ?? firstDetailWeight(details, PACKAGE_DIMENSION_LABELS, market)
    ?? firstInlineWeight(details, market, "package");
  const productWeightKg = productWeight?.value ?? null;
  const packageWeightKg = packageWeight?.value ?? null;
  const explicitProduct = Boolean(
    jsonLd
    || pageAsin
    || $("#productTitle, #dp, #centerCol, [data-feature-name='title']").length,
  );
  const values = { title, currentPrice, imageUrl, rating, reviewCount, sales30, productWeightKg, packageWeightKg };
  const fieldSources = Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key]) => [key, "amazon_product_page"]));

  return {
    asin: requestedAsin || pageAsin,
    title,
    currentPrice,
    priceEvidence: priceResult?.evidence ?? null,
    pageContextEvidence: amazonPageContextEvidence($, market, pageAsin, requestedAsin || pageAsin, currentPrice),
    imageUrl,
    rating,
    ratingEvidence: ratingResult?.evidence ?? null,
    reviewCount,
    reviewCountEvidence: reviewCountResult?.evidence ?? null,
    sales30,
    sales30Evidence: monthlySales?.evidence ?? null,
    // Amazon's public detail page exposes purchase-count bands, not revenue.
    salesAmount30: null,
    productWeightKg,
    packageWeightKg,
    productWeightEvidence: productWeight ? { ...productWeight.evidence, asin: requestedAsin || pageAsin, kind: "product" } : null,
    packageWeightEvidence: packageWeight ? { ...packageWeight.evidence, asin: requestedAsin || pageAsin, kind: "package" } : null,
    identity,
    fieldSources,
    dataSource: "amazon-product-page",
    sourceTool: "amazon_product_page",
    challenge,
    rateLimited,
    navigationError,
    explicitProduct,
  };
}

const PRODUCT_WEIGHT_LABELS = new Set([
  "item weight",
  "product weight",
  "net weight",
  "weight",
  "itemgewicht",
  "artikelgewicht",
  "gewicht van item",
  "gewicht van het item",
  "productgewicht",
  "gewicht van product",
  "gewicht van het product",
]);
const PACKAGE_WEIGHT_LABELS = new Set([
  "package weight",
  "shipping weight",
  "gross weight",
  "pakketgewicht",
  "verpakkingsgewicht",
  "gewicht verpakking",
  "gewicht van verpakking",
  "gewicht van het pakket",
]);
const PRODUCT_DIMENSION_LABELS = new Set([
  "product dimensions",
  "item dimensions",
  "productafmetingen",
  "afmetingen van product",
  "afmetingen van het product",
]);
const PACKAGE_DIMENSION_LABELS = new Set([
  "package dimensions",
  "packaged dimensions",
  "parcel dimensions",
  "pakketafmetingen",
  "verpakkingsafmetingen",
  "afmetingen verpakking",
  "afmetingen van het pakket",
]);

function productDetailResult(parsed, market, asin, effectiveUrl, transport, readyTransports) {
  const accessError = amazonAccessPageError(parsed);
  if (accessError) throw accessError;
  if (parsed.navigationError) {
    throw new AmazonStoreError("AMAZON_PRODUCT_NAVIGATION_FAILED", "Amazon could not load the product page.");
  }
  if (!parsed.explicitProduct) {
    throw new AmazonStoreError("AMAZON_INVALID_PRODUCT_PAGE", "Amazon returned a page without product detail evidence.");
  }
  return {
    marketplace: market.code,
    asin,
    title: parsed.title,
    currentPrice: parsed.currentPrice,
    priceEvidence: parsed.priceEvidence,
    pageContextEvidence: parsed.pageContextEvidence,
    imageUrl: parsed.imageUrl,
    rating: parsed.rating,
    ratingEvidence: parsed.ratingEvidence,
    reviewCount: parsed.reviewCount,
    reviewCountEvidence: parsed.reviewCountEvidence,
    sales30: parsed.sales30,
    sales30Evidence: parsed.sales30Evidence,
    salesAmount30: parsed.salesAmount30,
    productWeightKg: parsed.productWeightKg,
    packageWeightKg: parsed.packageWeightKg,
    identity: parsed.identity,
    productWeightEvidence: parsed.productWeightEvidence || null,
    packageWeightEvidence: parsed.packageWeightEvidence || null,
    fieldSources: parsed.fieldSources,
    dataSource: parsed.dataSource,
    sourceTool: parsed.sourceTool,
    canonicalUrl: assertAllowedProductPageUrl(
      effectiveUrl,
      buildProductUrl(market, asin),
      market,
      asin,
      "AMAZON_PRODUCT_REDIRECT_REJECTED",
    ).toString(),
    ...deliveryRegionMetadata(market, transport, readyTransports),
  };
}

function findJsonLdProduct($, expectedAsin) {
  const candidates = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    const text = $(element).text().trim();
    if (!text) return;
    try {
      collectJsonLdNodes(JSON.parse(text), candidates);
    } catch {
      // Amazon occasionally includes malformed auxiliary JSON-LD blocks.
    }
  });
  const products = candidates.filter((value) => {
    const types = Array.isArray(value?.["@type"]) ? value["@type"] : [value?.["@type"]];
    return types.some((type) => String(type || "").toLowerCase() === "product");
  });
  if (expectedAsin) {
    const matching = products.find((product) => {
      const asins = jsonLdAsins(product);
      return asins.length && asins.every((value) => value === expectedAsin);
    });
    if (matching) return matching;
  }
  const title = normalizeIdentityValue($("#productTitle").first().text());
  const unidentified = products.filter((product) => !jsonLdAsins(product).length);
  // A Product in a recommendation widget is also valid JSON-LD. Only use an
  // unidentified node when its name agrees with the actual detail-page title.
  const matchingTitle = unidentified.filter((product) => title && normalizeIdentityValue(product.name) === title);
  if (matchingTitle.length === 1) return matchingTitle[0];
  return !expectedAsin && !title && products.length === 1 ? products[0] : null;
}

function jsonLdAsins(value) {
  if (!value || typeof value !== "object") return [];
  const values = [value.sku, value.asin, value.productID, value.url, value["@id"]];
  return values.flatMap((candidate) => {
    const text = String(candidate || "").trim().toUpperCase();
    if (ASIN_PATTERN.test(text)) return [text];
    const match = text.match(/(?:\/(?:DP|GP\/PRODUCT)\/|\bASIN\s*[:=]\s*)([A-Z0-9]{10})(?:[/?#\s]|$)/);
    return match ? [match[1]] : [];
  });
}

function collectJsonLdNodes(value, target) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLdNodes(item, target));
    return;
  }
  if (!value || typeof value !== "object") return;
  target.push(value);
  if (Array.isArray(value["@graph"])) collectJsonLdNodes(value["@graph"], target);
}

function productPageAsin($) {
  const values = [
    $("#ASIN").attr("value"),
    $("input[name='ASIN']").first().attr("value"),
    $("#dp[data-asin], #centerCol[data-asin]").first().attr("data-asin"),
    $("link[rel='canonical']").first().attr("href")?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1],
  ];
  return values.map((value) => String(value || "").trim().toUpperCase()).find((value) => ASIN_PATTERN.test(value)) || null;
}

const AMAZON_MAIN_PRICE_SCOPES = [
  "#corePrice_feature_div", "#corePriceDisplay_desktop_feature_div", "#corePrice_desktop",
  "#corePrice_mobile_feature_div", "#corePriceDisplay_mobile_feature_div",
  "#apex_desktop", "#apex_mobile", "#buybox", "#buybox_feature_div", "#newAccordionRow",
];
const AMAZON_PRICE_CURRENCIES = Object.freeze({
  US: "USD", CA: "CAD", AU: "AUD", UK: "GBP", NL: "EUR", DE: "EUR",
  FR: "EUR", IT: "EUR", ES: "EUR", PL: "PLN", MX: "MXN", BR: "BRL",
});
const AMAZON_UNAVAILABLE_TEXT = /currently unavailable|temporarily out of stock|derzeit nicht verfügbar|actuellement indisponible|non disponibile|no disponible|niet beschikbaar/i;

function amazonPageContextEvidence($, market, selectedAsin, expectedAsin, currentPrice) {
  const visibleText = (selector) => [...new Set($(selector).toArray()
    .filter((element) => isCurrentProductMetric($, element, expectedAsin))
    .map((element) => $(element).clone().find("script, style").remove().end().text()
      .normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim())
    .filter(Boolean))].join(" | ").slice(0, 800) || null;
  const observedDeliveryText = visibleText("#glow-ingress-line1, #glow-ingress-line2, #glow-ingress-single-line, #contextualIngressPtLabel_deliveryShortLine");
  const availabilityText = visibleText("#availability");
  const priceNotAvailableText = visibleText("#priceNotAvailable_feature_div");
  const expectedPostalCode = market.postalCode || null;
  let regionStatus = "not_required";
  if (expectedPostalCode) {
    const pattern = market.code === "CA" ? /\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/gi
      : market.code === "UK" ? /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi
        : market.code === "PL" ? /\b\d{2}[-\s]?\d{3}\b/g
          : market.code === "BR" ? /\b\d{5}[-\s]?\d{3}\b/g
            : new RegExp(`\\b\\d{${expectedPostalCode.length}}\\b`, "g");
    const normalizePostal = (value) => value.replace(/[\s-]/g, "").toUpperCase();
    const observedPostalCodes = (observedDeliveryText || "").match(pattern) || [];
    regionStatus = !observedPostalCodes.length ? "unconfirmed"
      : observedPostalCodes.every((value) => normalizePostal(value) === normalizePostal(expectedPostalCode)) ? "match" : "mismatch";
  }
  const priceUnavailableReason = currentPrice !== null ? null
    : /(?:add|price|details).{0,70}(?:cart|basket)/i.test(priceNotAvailableText || "") ? "price_requires_cart"
      : ["unconfirmed", "mismatch"].includes(regionStatus) ? "delivery_region_unconfirmed"
        : AMAZON_UNAVAILABLE_TEXT.test(availabilityText || "") ? "unavailable" : "page_not_provided";
  return { expectedPostalCode, observedDeliveryText, regionStatus, availabilityText, priceNotAvailableText, selectedAsin, priceUnavailableReason };
}

function firstAmazonPrice($, market, jsonLd, expectedAsin) {
  if (AMAZON_UNAVAILABLE_TEXT.test($("#availability").text())) return null;
  const inMainPrice = (suffix) => AMAZON_MAIN_PRICE_SCOPES.map((scope) => `${scope} ${suffix}`).join(", ");
  // Prefer the displayed payable amount. Structured metadata and attach inputs
  // can be stale, and neither their type nor their position binds them to an ASIN.
  const tiers = [
    inMainPrice(".priceToPay") + ", " + inMainPrice(".apexPriceToPay"),
    inMainPrice("#apex-pricetopay-accessibility-label"),
    "#priceblock_dealprice, #priceblock_saleprice",
    inMainPrice(".a-price"),
    "#priceblock_ourprice, #price_inside_buybox, #newBuyBoxPrice",
  ];
  for (const selector of tiers) {
    const prices = $(selector).toArray()
      .filter((element) => isMainProductPrice($, element, expectedAsin))
      .map((element) => ({
        value: amazonPriceElementValue($, element, market),
        rawText: $(element).find(".a-offscreen").first().text().trim() || $(element).text().trim(),
        selector: $(element).attr("id") ? `#${$(element).attr("id")}`
          : `#${$(element).closest(AMAZON_MAIN_PRICE_SCOPES.join(", ")).attr("id")} .${$(element).hasClass("priceToPay") ? "priceToPay" : $(element).hasClass("apexPriceToPay") ? "apexPriceToPay" : "a-price"}`,
      }))
      .filter(({ value }) => value !== null && value > 0);
    if (prices.length) return amazonPriceResult(prices, "visible_main_price", selector, market, expectedAsin);
  }

  const scopedMeta = $(inMainPrice("meta[itemprop='price']")).toArray()
    .filter((element) => isMainProductPrice($, element, expectedAsin))
    .map((element) => {
      const offer = $(element).closest("[itemscope]");
      const currency = offer.find("meta[itemprop='priceCurrency']").first().attr("content");
      const rawText = $(element).attr("content");
      return { value: currencyMatchesMarket(currency, market) ? parseLocalizedMoney(rawText, market) : null, rawText };
    }).filter(({ value }) => value !== null && value > 0);
  if (scopedMeta.length) return amazonPriceResult(scopedMeta, "main_price_metadata", "main price scope meta[itemprop='price']", market, expectedAsin);

  const offers = Array.isArray(jsonLd?.offers) ? jsonLd.offers : [jsonLd?.offers];
  const offerPrices = offers.filter((offer) => {
    if (!offer || /AggregateOffer/i.test(String(offer["@type"] || ""))) return false;
    if (!currencyMatchesMarket(offer.priceCurrency, market)) return false;
    if (/OutOfStock|Discontinued|SoldOut/i.test(String(offer.availability || ""))) return false;
    const offerAsins = [...jsonLdAsins(offer), ...jsonLdAsins(offer.itemOffered)];
    return !expectedAsin || !offerAsins.length || offerAsins.every((value) => value === expectedAsin);
  }).map((offer) => ({ value: parseLocalizedMoney(offer.price, market), rawText: String(offer.price ?? "") })).filter(({ value }) => value !== null && value > 0);
  if (offerPrices.length) return amazonPriceResult(offerPrices, "matching_product_json_ld", "Product.offers.price", market, expectedAsin);

  const attachPrice = $("#attach-base-product-price").first();
  const attachAsin = String($("#attach-base-asin").first().attr("value") || productPageAsin($) || "").trim().toUpperCase();
  if (expectedAsin && attachAsin === expectedAsin && isMainProductPrice($, attachPrice[0], expectedAsin, true)) {
    const rawText = attachPrice.attr("value");
    const value = parseLocalizedMoney(rawText, market);
    return value !== null && value > 0 ? amazonPriceResult([{ value, rawText }], "matching_product_attach_price", "#attach-base-product-price", market, expectedAsin) : null;
  }
  // No page-wide .a-price or itemprop fallback: recommendation, variation and
  // secondary-offer prices are not evidence of this product's current price.
  return null;
}

function amazonPriceResult(prices, source, selector, market, asin) {
  const values = [...new Set(prices.map(({ value }) => value))];
  if (values.length !== 1) return null;
  return {
    price: values[0],
    evidence: {
      source, selector: prices[0].selector || selector,
      rawText: String(prices[0].rawText || "").replace(/\s+/g, " ").trim(),
      currency: AMAZON_PRICE_CURRENCIES[market.code],
      asin,
    },
  };
}

function isMainProductPrice($, element, expectedAsin, allowHiddenInput = false) {
  if (!element) return false;
  const wrapper = $(element).parent();
  if (!wrapper.is(AMAZON_MAIN_PRICE_SCOPES.join(", ")) && wrapper.find(".a-price").length <= 1) {
    // A separate per-unit amount often shares the main price's parent. It
    // labels its own amount, not the payable total. Keep bare '/ count' text
    // so that an actual unit price is still rejected.
    const label = wrapper.contents().toArray().map((node) => {
      const text = $(node).text();
      const separateUnitAmount = node !== element
        && /(?:[$€£]|\b(?:CAD|USD|AUD|EUR|GBP)\b)\s*\d|\d[\d.,]*\s*(?:[$€£]|zł)/i.test(text)
        && /(?:\/|\bper\s+)\s*(?:count|unit|item|piece|pack|kg|g\b|oz|lb|l\b|litre|liter|100\s*(?:g|ml))/i.test(text);
      return separateUnitAmount ? "" : text;
    }).join(" ").replace(/\s+/g, " ").trim();
    if (/(?:\/|\bper\s+)(?:\s*)(?:month|mo\b|count|unit|item|piece|pack|kg|kilogram|g\b|gram|oz|ounce|lb|pound|l\b|litre|liter|100\s*(?:g|ml))|\bpayments?\s+of\b|\b(?:list price|RRP|MSRP)\b/i.test(label)) return false;
  }
  const nodes = $(element).parents().addBack().toArray();
  for (const node of nodes) {
    const part = $(node);
    if (part.is(".a-text-price, .a-text-strike, [data-a-strike='true'], del, s, .a-price-range")) return false;
    if ((!allowHiddenInput || node !== element) && (part.is("[hidden], .aok-hidden, .a-hidden") || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(part.attr("style") || ""))) return false;
    const identity = [part.attr("id"), part.attr("class"), part.attr("data-feature-name"), part.attr("data-component-type")].join(" ");
    if (/CardInstance|carousel|sponsored|recommend|similarities|comparison|compare|p13n|sp_detail|dp-sims|buyitwith|frequently.?bought|twister|variation|installment|financing|payment.?plan|price.?per.?unit|unit.?price|basis.?price|list.?price|strike.?price|sns.?price|subscribe|usedBuy|usedAccordion|aod-|olp-/i.test(identity)) return false;
    const containerAsin = String(part.attr("data-asin") || "").trim().toUpperCase();
    if (expectedAsin && ASIN_PATTERN.test(containerAsin) && containerAsin !== expectedAsin) return false;
  }
  return true;
}

function amazonPriceElementValue($, element, market) {
  const price = $(element);
  const offscreen = price.find(".a-offscreen").first();
  if (offscreen.length && offscreen.text().trim()) return parseLocalizedMoney(offscreen.text(), market);
  const whole = price.find(".a-price-whole").first();
  if (whole.length) {
    const fraction = price.find(".a-price-fraction").first().text().trim();
    const symbol = price.find(".a-price-symbol").first().text();
    const integer = whole.text().normalize("NFKC").trim().replace(/[.,]\s*$/, "");
    if (fraction && !/^\d{1,2}$/.test(fraction)) return null;
    if (!/^\d+$/.test(integer) && !/^\d{1,3}(?:[., '’]\d{3})+$/.test(integer)) return null;
    return parseLocalizedMoney(`${symbol}${integer.replace(/[., '’]/g, "")}${fraction ? `.${fraction}` : ""}`, market);
  }
  return parseLocalizedMoney(price.text(), market);
}

function currencyMatchesMarket(currency, market) {
  return !currency || String(currency).trim().toUpperCase() === AMAZON_PRICE_CURRENCIES[market.code];
}

function firstAmazonImage($, jsonLd) {
  const image = $("#landingImage, #imgBlkFront").first();
  const dynamicImages = image.attr("data-a-dynamic-image");
  let dynamicImageUrl = null;
  if (dynamicImages) {
    try {
      dynamicImageUrl = Object.keys(JSON.parse(dynamicImages))[0] || null;
    } catch {
      dynamicImageUrl = null;
    }
  }
  const jsonImages = Array.isArray(jsonLd?.image) ? jsonLd.image : [jsonLd?.image];
  const candidates = [
    image.attr("data-old-hires"),
    image.attr("src"),
    dynamicImageUrl,
    $("meta[property='og:image']").first().attr("content"),
    ...jsonImages.map((value) => typeof value === "string" ? value : value?.url || value?.contentUrl),
  ];
  return candidates.map(normalizeHttpUrl).find(Boolean) || null;
}

function firstAmazonRating($, jsonLd, expectedAsin) {
  return firstCurrentProductMetric($, expectedAsin, [
    "#averageCustomerReviews #acrPopover", "#acrPopover",
    "#averageCustomerReviews .a-icon-alt", "[data-hook='rating-out-of-text']",
  ], (element) => parseRating($(element).attr("title") || $(element).text()))
    ?? jsonLdMetricResult(parseRating(jsonLd?.aggregateRating?.ratingValue), jsonLd?.aggregateRating?.ratingValue, "Product.aggregateRating.ratingValue", expectedAsin);
}

function firstAmazonReviewCount($, jsonLd, expectedAsin) {
  return firstCurrentProductMetric($, expectedAsin, [
    "#averageCustomerReviews #acrCustomerReviewText", "#acrCustomerReviewText", "[data-hook='total-review-count']",
  ], (element) => parseIntegerCount($(element).text()))
    ?? jsonLdMetricResult(parseIntegerCount(jsonLd?.aggregateRating?.reviewCount), jsonLd?.aggregateRating?.reviewCount, "Product.aggregateRating.reviewCount", expectedAsin)
    ?? jsonLdMetricResult(parseIntegerCount(jsonLd?.aggregateRating?.ratingCount), jsonLd?.aggregateRating?.ratingCount, "Product.aggregateRating.ratingCount", expectedAsin);
}

function firstCurrentProductMetric($, expectedAsin, selectors, parse) {
  for (const selector of selectors) {
    const candidates = $(selector).toArray().filter((element) => isCurrentProductMetric($, element, expectedAsin))
      .map((element) => ({ value: parse(element), rawText: $(element).attr("title") || $(element).text() })).filter(({ value }) => value !== null);
    if (candidates.length) {
      if (new Set(candidates.map(({ value }) => value)).size !== 1) return null;
      const { value, rawText } = candidates[0];
      return { value, evidence: { source: "amazon_product_page", selector, rawText: rawText.replace(/\s+/g, " ").trim(), value, asin: expectedAsin } };
    }
  }
  return null;
}

function jsonLdMetricResult(value, raw, selector, asin) {
  return value === null ? null : { value, evidence: { source: "matching_product_json_ld", selector, rawText: String(raw), value, asin } };
}

function isCurrentProductMetric($, element, expectedAsin) {
  return $(element).parents().addBack().toArray().every((node) => {
    const part = $(node);
    if (part.is("[hidden], .aok-hidden, .a-hidden, [data-hook='review'], #cm_cr-review_list")
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(part.attr("style") || "")) return false;
    const identity = [part.attr("id"), part.attr("class"), part.attr("data-feature-name"), part.attr("data-component-type")].join(" ");
    if (/CardInstance|carousel|sponsored|recommend|similarities|comparison|compare|p13n|sp_detail|dp-sims|buyitwith|frequently.?bought|twister|variation/i.test(identity)) return false;
    const containerAsin = String(part.attr("data-asin") || "").trim().toUpperCase();
    return !expectedAsin || !ASIN_PATTERN.test(containerAsin) || containerAsin === expectedAsin;
  });
}

function firstAmazonMonthlySales($, expectedAsin) {
  const selectors = [
    "#social-proofing-faceout-title-tk_bought",
    "[id*='social-proofing'][id*='bought']",
    ".social-proofing-faceout-title-text",
  ];
  for (const selector of selectors) {
    for (const element of $(selector).toArray().filter((element) => isCurrentProductMetric($, element, expectedAsin))) {
      const rawText = $(element).text().replace(/\s+/g, " ").trim();
      const value = parseAmazonMonthlySales(rawText);
      if (value !== null) return { value, evidence: {
        source: "amazon_product_page", selector, rawText, value, asin: expectedAsin,
        period: "past_month", kind: /\+/.test(rawText) ? "lower_bound" : "displayed_count",
      } };
    }
  }
  return null;
}


function amazonProductDetailPairs($, expectedAsin) {
  const pairs = [];
  const add = (label, value, row) => {
    if (row && !isCurrentProductMetric($, row, expectedAsin)) return;
    const normalizedLabel = normalizeDetailLabel(label);
    const normalizedValue = cleanProductText(value);
    const containerId = row ? $(row).closest("[id]").attr("id") : null;
    if (normalizedLabel && normalizedValue) pairs.push([normalizedLabel, normalizedValue, containerId ? "#" + containerId : "product_details"]);
  };
  const detailRoots = "#productDetails_feature_div, #prodDetails, #itemDetails_feature_div, #productOverview_feature_div, #productFactsDesktop_feature_div, #productFactsMobile_feature_div, #productFactsDesktopExpander, #productFactsMobileExpander";
  const tableRows = detailRoots.split(", ").map(root => root + " tr").join(", ");
  $("#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr, " + tableRows).each((_index, row) => {
    const cells = $(row).children("th, td, [role='cell']");
    if (cells.length < 2) return;
    const header = $(row).find("th, td.prodDetSectionEntry").first().length
      ? $(row).find("th, td.prodDetSectionEntry").first() : cells.first();
    add(header.text(), cells.last().text(), row);
  });
  $("#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li").each((_index, row) => {
    const label = $(row).find(".a-text-bold, b, strong").first().text();
    const fullText = $(row).text();
    if (label && fullText.indexOf(label) >= 0) {
      add(label, fullText.slice(fullText.indexOf(label) + label.length).replace(/^\s*:\s*/, ""), row);
    } else {
      const inline = String(fullText || "").match(/^([^:\n]{1,40}?)\s*:\s*(.+)$/);
      if (inline) add(inline[1], inline[2], row);
      else add(fullText, fullText, row);
    }
  });
  $(detailRoots).find(".a-fixed-left-grid").each((_index, row) => {
    const columns = $(row).find(".a-fixed-left-grid-col");
    if (columns.length >= 2) add(columns.first().text(), columns.last().text(), row);
  });
  $(detailRoots).find("[role='row'], .a-row").each((_index, row) => {
    const columns = $(row).children("[role='cell'], .a-column");
    if (columns.length >= 2) add(columns.first().text(), columns.last().text(), row);
  });
  $(detailRoots).find("dt").each((_index, row) => add($(row).text(), $(row).next("dd").text(), row));
  // Scan the product's own prose only, and require a weight label adjacent to its value.
  $("#productDescription_feature_div, #productDescription, #productDescription .a-expander-content, #feature-bullets .a-unordered-list li, #featurebullets_feature_div li, #aplus_feature_div, #aplus .a-expander-content").each((_index, row) => {
    if (!isCurrentProductMetric($, row, expectedAsin)) return;
    const clone = $(row).clone();
    clone.find("script, style, [hidden], .aok-hidden, .a-hidden, .a-carousel, [id*='comparison'], [id*='recommend']").remove();
    clone.find("[data-asin]").filter((_i, node) => {
      const nestedAsin = String($(node).attr("data-asin") || "").trim().toUpperCase();
      return ASIN_PATTERN.test(nestedAsin) && nestedAsin !== expectedAsin;
    }).remove();
    const text = cleanProductText(clone.text());
    if (text && text.length <= 600) add(text, text, row);
  });
  return pairs;
}

function weightResult(value, label, rawText, selector, source = "amazon_product_page") {
  return value === null ? null : { value, evidence: { source, label, rawText, selector, value, unit: "kg" } };
}

function firstDetailWeight(details, acceptedLabels, market) {
  for (const [label, rawText, selector] of details) {
    if (!acceptedLabels.has(label)) continue;
    const weight = parseWeightKg(rawText, market);
    if (weight !== null) return weightResult(weight, label, rawText, selector);
  }
  return null;
}

function firstInlineWeight(details, market, kind) {
  const labels = /\b((?:item|product|package|shipping|net|gross)\s+weight|weight)\s*(?::|：|=|is)?\s*(-?(?:\d+(?:[.,]\d+)*|[.,]\d+))\s*(kilograms?|kilogrammes?|kg|grams?|grammes?|g|pounds?|lbs?|lb|ounces?|oz)\b/ig;
  for (const [, text, selector] of details) {
    for (const match of text.matchAll(labels)) {
      const label = normalizeDetailLabel(match[1]);
      const isPackage = /^(?:package|shipping|gross)\s/.test(label);
      if ((kind === "package") !== isPackage) continue;
      if (/\b(?:maximum|max|capacity|load|supports?)\s*$/i.test(text.slice(0, match.index))) continue;
      const weight = parseWeightKg(match[2] + " " + match[3], market);
      if (weight !== null) return weightResult(weight, label, match[0], selector);
    }
  }
  return null;
}

function schemaWeightResult(raw, market) {
  const value = schemaWeightKg(raw, market);
  return weightResult(value, "weight", typeof raw === "object" ? JSON.stringify(raw) : String(raw), "Product.weight", "matching_product_json_ld");
}

function amazonProductIdentity(details, asin) {
  const valueFor = (...labels) => {
    const accepted = new Set(labels);
    return details.find(([label]) => accepted.has(label))?.[1] || null;
  };
  return {
    asin: ASIN_PATTERN.test(String(asin || "").toUpperCase()) ? String(asin).toUpperCase() : null,
    upc: valueFor("upc"),
    partNumber: valueFor("part number", "manufacturer reference", "item model number", "model number"),
    brand: valueFor("brand", "brand name"),
    manufacturer: valueFor("manufacturer"),
  };
}

function normalizeIdentityValue(value) {
  const normalized = String(value || "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return normalized || null;
}

function schemaWeightKg(value, market) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return parseWeightKg(String(value), market);
  if (typeof value !== "object") return null;
  const amount = value.value ?? value.maxValue ?? value.minValue;
  const unit = value.unitText ?? value.unitCode ?? "";
  return parseWeightKg(`${amount ?? ""} ${unit}`, market);
}

function parseWeightKg(value, market) {
  const text = String(value || "").normalize("NFKC").replace(/\p{Cf}/gu, "");
  const pattern = /(-?(?:\d+(?:[.,]\d+)*|[.,]\d+))\s*(kilograms?|kilogrammes?|kgm?|grams?|grammes?|grm|g|pounds?|lbs?|lb|lbr|ounces?|onz|oz)\b/ig;
  let match;
  while ((match = pattern.exec(text))) {
    const amount = parseLocalizedDecimal(match[1], market);
    if (amount === null || amount < 0) continue;
    const unit = match[2].toLowerCase();
    let kilograms;
    if (unit === "kg" || unit === "kgm" || unit.startsWith("kilogram")) kilograms = amount;
    else if (unit === "g" || unit === "grm" || unit.startsWith("gram")) kilograms = amount / 1_000;
    else if (unit === "oz" || unit === "onz" || unit.startsWith("ounce")) kilograms = amount * 0.028349523125;
    else kilograms = amount * 0.45359237;
    return Math.round(kilograms * 1_000_000) / 1_000_000;
  }
  return null;
}

function parseLocalizedMoney(value, market) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  let raw = String(value ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
  if (!raw) return null;
  const currencyTokens = /\b(?:USD|CAD|AUD|MXN|BRL|EUR|GBP|PLN)\b|CDN\$|CA\$|C\$|US\$|AU\$|A\$|MX\$|R\$|zł|[$€£]/giu;
  const tokenCurrencies = {
    "CDN$": "CAD", "CA$": "CAD", "C$": "CAD", "US$": "USD", "AU$": "AUD", "A$": "AUD",
    "MX$": "MXN", "R$": "BRL", "ZŁ": "PLN", "€": "EUR", "£": "GBP",
  };
  const firstDigit = raw.search(/\d/);
  const lastDigit = raw.search(/\d\D*$/);
  for (const match of raw.matchAll(currencyTokens)) {
    const token = match[0];
    if (match.index > firstDigit && match.index < lastDigit) return null;
    const normalized = token.toUpperCase();
    if (normalized === "$") {
      if (!["USD", "CAD", "AUD", "MXN"].includes(AMAZON_PRICE_CURRENCIES[market.code])) return null;
    } else if (!currencyMatchesMarket(tokenCurrencies[normalized] || normalized, market)) return null;
  }
  raw = raw.replace(currencyTokens, "").trim();
  // Require a complete amount. Never salvage the first digits of a range,
  // instalment, per-unit amount, percentage or a concatenated pair of prices.
  if (!/^\d[\d., '’]*$/.test(raw)) return null;
  if (/[ '’]/.test(raw)) {
    if (!/^\d{1,3}(?:[ '’]\d{3})+(?:[.,]\d{1,2})?$/.test(raw)) return null;
    raw = raw.replace(/[ '’]/g, "");
  }
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  let normalized;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const grouping = decimal === "," ? "." : ",";
    const parts = raw.split(decimal);
    if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1])) return null;
    const groupedInteger = new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`);
    if (!groupedInteger.test(parts[0])) return null;
    normalized = `${parts[0].split(grouping).join("")}.${parts[1]}`;
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const parts = raw.split(separator);
    if (parts.length === 2 && /^\d{1,2}$/.test(parts[1])) normalized = `${parts[0]}.${parts[1]}`;
    else if (/^\d{1,3}$/.test(parts[0]) && parts.slice(1).every((part) => /^\d{3}$/.test(part))) normalized = parts.join("");
    else return null;
  } else normalized = raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseLocalizedDecimal(value, market) {
  let text = String(value || "").trim();
  if (!text) return null;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    text = text.split(groupingSeparator).join("").replace(decimalSeparator, ".");
  } else if (comma >= 0) {
    const digitsAfter = text.length - comma - 1;
    const decimalComma = market.code === "NL" || digitsAfter !== 3;
    text = decimalComma ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (dot >= 0 && market.code === "NL" && text.length - dot - 1 === 3) {
    text = text.replace(/\./g, "");
  } else {
    text = text.replace(/,/g, "");
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseRating(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:out of|von|sur|su|de|van(?: de)?)\s*5\b/i)
    || text.match(/^(\d+(?:[.,]\d+)?)$/);
  if (!match) return null;
  const rating = Number(match[1].replace(",", "."));
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null;
}

function parseIntegerCount(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = String(value ?? "").normalize("NFKC").trim();
  const match = text.match(/^\(?\s*(\d{1,3}(?:[,.'’\s]\d{3})+|\d+)\s*\)?(?:\s+[^\d]*)?$/);
  if (!match) return null;
  const count = Number(match[1].replace(/\D/g, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function normalizeDetailLabel(value) {
  const withoutFormattingControls = String(value ?? "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "");
  return cleanProductText(withoutFormattingControls)?.replace(/\s*:\s*$/, "").toLocaleLowerCase("en-US") || null;
}

function cleanProductText(value) {
  const text = String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function nonNegativeFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function buildSellerUrl(marketplace, sellerId, page = 1) {
  const market = typeof marketplace === "string" ? requireMarket(marketplace) : marketplace;
  const url = new URL("/s", market.baseUrl);
  if (market.code === "NL") url.searchParams.set("i", "merchant-items");
  url.searchParams.set("me", sellerId);
  if (market.code === "NL") url.searchParams.set("language", "en");
  url.searchParams.set("marketplaceID", market.marketplaceId);
  if (page > 1) {
    url.searchParams.set("page", String(page));
    url.searchParams.set("ref", `sr_pg_${page}`);
  }
  return url.toString();
}

export function buildProductUrl(marketplace, asin) {
  const market = typeof marketplace === "string" ? requireMarket(marketplace) : marketplace;
  const normalizedAsin = String(asin || "").trim().toUpperCase();
  if (!ASIN_PATTERN.test(normalizedAsin)) throw new AmazonStoreError("INVALID_ASIN", "Amazon ASIN is invalid.");
  return new URL(`/dp/${normalizedAsin}`, market.baseUrl).toString();
}

export function normalizeAmazonProductUrl(value, { marketplace, asin } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const market = requireMarket(marketplace);
    const normalizedAsin = String(asin || "").trim().toUpperCase();
    const url = assertAllowedProductPageUrl(new URL(value), buildProductUrl(market, normalizedAsin), market, normalizedAsin, "AMAZON_PRODUCT_REDIRECT_REJECTED");
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function amazonDeliveryPostalCode(marketplace) {
  return requireMarket(marketplace).postalCode;
}

export function amazonDeliveryRegion(marketplace) {
  const market = requireMarket(marketplace);
  return {
    postalCode: market.postalCode,
    countryCode: market.countryCode,
    mode: market.postalCode ? "postal_code" : "marketplace_domain",
  };
}

function requireMarket(value) {
  const code = String(value || "").trim().toUpperCase();
  const market = MARKET_CONFIGS[code];
  if (!market) throw new AmazonStoreError("UNSUPPORTED_MARKETPLACE", "Unsupported Amazon marketplace for store sessions.");
  return market;
}

function cleanStoreName(value) {
  const text = String(value || "").normalize("NFC").trim().replace(/\s+/g, " ");
  return text && text.length <= 300 ? text : null;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  throw error;
}

function abortableDelay(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("The request was aborted."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
