const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const list = (value) => Array.isArray(value) ? value : [];
const normalizedAsin = (value) => /^[A-Z0-9]{10}$/.test(String(value || "").trim().toUpperCase())
  ? String(value).trim().toUpperCase() : null;

/** Describe evidence for the visible seller catalog, never an unseen parent/child catalog. */
export function summarizeAnalysisCoverage({ stores = [], storeVisits = [], products = [], createdAt = null, marketplace = null } = {}) {
  const visits = list(storeVisits);
  const importedStores = list(stores);
  const allProducts = list(products);
  const detailCounts = { success: 0, failed: 0, pending: 0 };
  const uniqueProducts = new Set();
  let duplicateProductRows = 0;
  for (const product of allProducts) {
    const asin = normalizedAsin(product?.sourceAsin || product?.asin);
    const productMarket = product?.marketplace || marketplace || null;
    // An absent marketplace is not silently converted to US or merged into another market.
    const key = asin && productMarket ? `${productMarket}:${asin}` : product?.id || null;
    if (key && uniqueProducts.has(key)) duplicateProductRows += 1;
    else if (key) uniqueProducts.add(key);
    if (product?.detailStatus === "success") detailCounts.success += 1;
    else if (["failed", "error"].includes(product?.detailStatus)) detailCounts.failed += 1;
    else detailCounts.pending += 1;
  }
  const storeRows = visits.map((visit, index) => {
    const audit = list(visit?.pageAudit);
    const source = importedStores.find((store) => visit?.sellerId && store?.sellerId === visit.sellerId) || importedStores[index] || {};
    const reported = count(visit?.reportedTotalAsins);
    const discovered = count(visit?.discoveredAsins) ?? (Array.isArray(visit?.asins) ? new Set(visit.asins).size : null);
    const knownGap = count(visit?.notEnumeratedAsins) ?? (reported !== null && discovered !== null ? Math.max(0, reported - discovered) : null);
    const kind = visit?.coverageEvidence?.reportedTotalKind || audit.at(-1)?.reportedTotalKind || (reported === null ? "unknown" : "legacy_unverified");
    const isInputList = visit?.status === "not_required";
    const paginationComplete = !isInputList && visit?.complete === true && !visit?.nextHref && !visit?.interruption;
    const unknownDenominator = reported === null || kind !== "exact";
    const partial = !paginationComplete || (knownGap || 0) > 0 || unknownDenominator || Boolean(visit?.truncated);
    const reasons = list(visit?.omissionReasons).map((reason) => ({ ...reason }));
    if (unknownDenominator) reasons.push({ code: "AMAZON_TOTAL_NOT_VERIFIED", count: null });
    if (isInputList) reasons.push({ code: "IMPORTED_ASIN_SCOPE_ONLY", count: null });
    return {
      store_index: visit?.storeIndex ?? index,
      seller_id: visit?.sellerId || source.sellerId || null,
      marketplace: visit?.marketplace || source.marketplace || marketplace || null,
      source_url: visit?.canonicalUrl || source.storeUrl || source.url || null,
      status: partial ? "partial" : "visible_scope_complete",
      pagination_complete: paginationComplete,
      full_store_complete: false,
      pages_visited: count(visit?.pagesVisited) ?? 0,
      discovered_asins: discovered,
      reported_total_asins: reported,
      reported_total_kind: kind,
      known_missing_asins: knownGap,
      collected_at: audit.at(-1)?.collectedAt || visit?.coverageEvidence?.collectedAt || visit?.collectedAt || null,
      next_url: visit?.nextHref || null,
      failure: visit?.interruption || (visit?.status === "failed" ? { code: visit?.code || "AMAZON_STORE_VISIT_FAILED" } : null),
      page_audit: audit.map((page) => ({ ...page })),
      variant_scope: "search_result_card_asins_and_explicit_product_links; unseen_child_variants_not_expanded",
      reasons,
    };
  });
  const requested = Math.max(importedStores.length, visits.length);
  const visited = visits.filter((visit) => ["visited", "empty"].includes(visit?.status)).length;
  const partialStores = storeRows.filter((store) => store.status === "partial").length;
  const missingStores = Math.max(0, requested - visits.length);
  const complete = requested > 0 && !partialStores && !missingStores && !detailCounts.failed && !detailCounts.pending;
  return {
    scope: "amazon_visible_store_results",
    status: !visits.length && !allProducts.length ? "not_started" : complete ? "visible_scope_complete" : "partial",
    full_store_complete: false,
    snapshot_at: createdAt,
    counts: {
      requested_stores: requested,
      visited_stores: visited,
      partial_stores: partialStores + missingStores,
      unvisited_stores: missingStores,
      failed_stores: visits.filter((visit) => visit?.status === "failed").length,
      pages_visited: storeRows.reduce((sum, store) => sum + store.pages_visited, 0),
      product_rows: allProducts.length,
      unique_product_identities: uniqueProducts.size,
      duplicate_product_rows: duplicateProductRows,
      known_missing_asins: storeRows.reduce((sum, store) => sum + (store.known_missing_asins || 0), 0),
      unknown_total_stores: storeRows.filter((store) => store.reported_total_kind !== "exact").length,
    },
    detail_counts: detailCounts,
    stores: storeRows,
    limitations: [
      "Amazon search headers may be approximate; store gaps are summed per store, not netted against other stores.",
      "Only visible seller result cards and explicit product links are enumerated. Unseen child variants and inaccessible listings are not proved complete.",
      "A completed page cursor or processed candidate list does not establish a complete store catalog.",
    ],
  };
}
