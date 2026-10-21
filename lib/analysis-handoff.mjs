import { AU_FBA_WORKBOOK_RATES, CA_FBA_PEAK_ENVELOPE_RATES, PROFIT_FORMULA_VERSION, calculateProductProfit, applyMissingWeightProfitAssumption, hasInvalidProductWeight, resolveManualWeightOverride, usesItemWeightOnly, resolveProductDimensionsCm, automaticProfitWeightKg, automaticProductWeightKg, automaticPackageWeightKg, profitWeightSourceLabel } from "./profit-model.mjs";
import { monthlySalesValue, monthlySalesEvidence, hasQualifyingMonthlySales, isMonthlySalesFilterRequired } from "./monthly-sales-policy.mjs";

import { normalizeISODateOnly, matchesAmazonListingDate, todayDateOnly } from "./amazon-listing-date.mjs";
import { normalizeReviewRange, reviewRangeExclusionReasons, intersectReviewRanges } from "./review-range.mjs";

export const ANALYSIS_HANDOFF_SCHEMA_VERSION = "1.0";
export const ANALYSIS_FILTER_RULE_VERSION = "analysis-candidate-explicit-asin-sales-v9";
const MARKETS = {
  AU: ["AUD", "en-AU", "www.amazon.com.au"],
  US: ["USD", "en-US", "www.amazon.com"],
  NL: ["EUR", "nl-NL", "www.amazon.nl"],
  CA: ["CAD", "en-CA", "www.amazon.ca"],
  UK: ["GBP", "en-GB", "www.amazon.co.uk"],
  DE: ["EUR", "de-DE", "www.amazon.de"],
  FR: ["EUR", "fr-FR", "www.amazon.fr"],
  IT: ["EUR", "it-IT", "www.amazon.it"],
  ES: ["EUR", "es-ES", "www.amazon.es"],
  PL: ["PLN", "pl-PL", "www.amazon.pl"],
  MX: ["MXN", "es-MX", "www.amazon.com.mx"],
  BR: ["BRL", "pt-BR", "www.amazon.com.br"],
};
const RATE_KEYS = ["commissionRate", "fxLossRate", "marketingRate", "managementRate", "returnsRate", "purchaseTaxRate", "domesticFreightRateCnyPerKg", "airFreightRateCnyPerKg"];
const NUMBER_KEYS = ["salePrice", "purchaseCostCny", "fulfillmentFee", "exchangeRate", "actualWeightKg", ...RATE_KEYS, "volumetricDivisor", "cartonWeightKg", "unitsPerCarton"];

/** Preserve explicitly resolved UI inputs. Never fill an unknown fee or rate with zero/defaults. */
export function resolveAnalysisProfitInputs(product = {}, marketplace = product.marketplace) {
  let input = product.analysisProfitInputs || product.resolvedProfitInputs;
  if (!input) {
    const base = product.profitInputs || {};
    const mode = fulfillmentMode(product.fulfillmentMode ?? base.fulfillmentMode);
    input = { ...base, salePrice: product.salePrice, purchaseCostCny: product.purchaseCost,
      fulfillmentMode: mode, fulfillmentFee: product.fulfillmentFee ?? (mode === "FBM" ? product.fbmFee : mode === "FBA" ? product.fbaFee : null) ?? base.fulfillmentFee,
      actualWeightKg: resolveManualWeightOverride(product)?.weightKg ?? (product.manualProfitInputs ? base.actualWeightKg ?? product.billingWeight : null) ?? product.actualWeightKg ?? (base.airFreightActualWeightOnly ? product.productWeight : product.billingWeight) ?? base.actualWeightKg ?? product.billingWeight,
      dimensionsCm: resolveProductDimensionsCm(product),
      cartonWeightKg: product.cartonWeightKg ?? base.cartonWeightKg, unitsPerCarton: product.unitsPerCarton ?? base.unitsPerCarton };
  }
  const resolved = { ...Object.fromEntries(NUMBER_KEYS.map((key) => [key, num(input[key])])), fulfillmentMode: fulfillmentMode(input.fulfillmentMode),
    airFreightActualWeightOnly: typeof input.airFreightActualWeightOnly === "boolean" ? input.airFreightActualWeightOnly : null, dimensionsCm: dimensions(input.dimensionsCm) };
  if (input.actualWeightSource === 'missing_weight_lowest_freight_assumption') {
    resolved.actualWeightKg = null;
  }
  if (usesItemWeightOnly(product)) {
    // Resolved export inputs can predate a new page inspection. A cached
    // package/billing mass is not evidence of Item Weight; explicit manual
    // provenance still takes priority over the automatic page observation.
    const manualWeight = resolveManualWeightOverride(product)
      || resolveManualWeightOverride({ ...product, profitInputs: input });
    resolved.actualWeightKg = manualWeight?.weightKg ?? automaticProfitWeightKg(product);
    resolved.weightSource = manualWeight?.source ?? profitWeightSourceLabel(product);
  }
  const invalidWeight = hasInvalidProductWeight({ actualWeightKg: input.actualWeightKg });
  return invalidWeight ? resolved : applyMissingWeightProfitAssumption(resolved, marketplace, product);
}

export function getAnalysisFormulaContract({ inputMode = "stores", monthlySalesBand = "all" } = {}) {
  const directAsins = inputMode === "asins";
  const salesRequired = isMonthlySalesFilterRequired(inputMode, monthlySalesBand);
  return {
    formula_version: PROFIT_FORMULA_VERSION, fee_model_version: "au-standard-envelope-weight-price-v2;ca-peak-envelope-surcharge-v1;us-sop-2023-weight-v1;all-market-minimum-envelope-v1",
    implementation: "lib/profit-model.mjs#calculateProductProfit", representation: "declarative_data_only",
    input_policy: "Use explicit product inputs. Do not apply consumer defaults or execute uploaded formula text.",
    amazon_rule_update_2026_09_29: { missing_monthly_sales: salesRequired ? "未取得当前商品可信月销量证据时，月销量保持未知，不纳入候选；Amazon 购买量下限或已启用 SellerSprite 同站点同 ASIN 月销量达到 50 才能进入候选" : "ASIN 选择全部商品时，低销量和未知销量均保留为候选；未知保持未知，主动选择销量档位后按该条件筛选", missing_weight: "商品重量、包裹重量、尺寸三项均缺失时提示信息不完整；CA 按 cm³÷5021.69、AU 按 cm³÷6000 体积重暂估；FBA采用有另一项差额≤3当地货币支持的最高费用，单项标注缺少交叉核验，全冲突待计算；其他站点既有费用口径不变" },
    missing_weight_profit_policy: { id: "missing_weight_minimum_envelope", fulfillment_mode: "FBA", markets: Object.keys(MARKETS).filter(market => !["AU", "CA"].includes(market)), actual_weight: "Use the heavier evidenced Item Weight or package weight and label the selected source; keep Item Weight observations null for package fallback. Only assume a minimum tier when both are absent", assumed_weight_kg: { AU: 0.075, CA: 0.1, US_and_other_markets: 0.25 / 2.2046226218 }, applies_to: ["not_collected", "inspection_incomplete", "page_not_provided"], fees: "AU and CA use supplied envelope tables; US uses US SOP; NL/UK/DE/FR/IT/ES/PL/MX/BR use the existing 3.22 nominal local-currency US SOP reference, not official local rates", manual_fees: "Preserve explicit manual fulfillmentFee", real_weight: "Real verified or manual weight supersedes all assumption fields", result: "Minimum-tier preliminary estimate, not verified product weight or confirmed profit" },
    amazon_monthly_sales_policy: { input_mode: directAsins ? "asins" : "stores", applied: salesRequired, minimum: salesRequired ? 50 : null, requires_current_asin_monthly_purchase_badge: salesRequired, applies_when: salesRequired ? "SellerSprite is disabled or has no valid same-market ASIN evidence" : "ASIN all has no automatic sales floor; explicit bands still apply", seller_sprite_when_enabled: "same_asin_same_market_monthly_evidence", missing_evidence: salesRequired ? "unknown_and_pending" : "unknown_without_sales_exclusion", legacy_under_50_selection_allowed: false },
    inputs: {
      salePrice: { unit: "marketplace_currency/sellable_unit", positive: true },
      purchaseCostCny: { unit: "CNY/sellable_unit", non_negative: true, note: "Already piece-adjusted; do not multiply units_per_set again." },
      fulfillmentFee: { unit: "marketplace_currency/sellable_unit", non_negative: true }, fulfillmentMode: { values: ["FBA", "FBM"] },
      exchangeRate: { unit: "CNY/1 marketplace_currency", positive: true }, actualWeightKg: { unit: "kg/sellable_unit", positive: true, nullable: true },
      assumedWeightKg: { unit: "kg/sellable_unit", positive: true, nullable: true, policy: "missing_weight_minimum_envelope; independent assumption, never an Amazon observation" },
      weightAssumption: { nullable: true, values: ["missing_weight_minimum_envelope"] }, weightAssumptionMarket: { nullable: true, values: Object.keys(MARKETS) },
      dimensionsCm: { unit: "cm", nullable: true }, cartonWeightKg: { unit: "kg/carton", nullable: true }, unitsPerCarton: { unit: "sellable_units/carton", nullable: true },
      airFreightActualWeightOnly: { unit: "boolean" }, volumetricDivisor: { unit: "cubic_inches/pound", positive: true },
      ...Object.fromEntries(RATE_KEYS.map((key) => [key, { unit: key.endsWith("CnyPerKg") ? "CNY/kg" : "percent", non_negative: true }])),
    },
    equations: [
      { output: "purchaseTaxCny", expression: "purchaseCostCny * purchaseTaxRate / 100" },
      { output: "calculationWeightKg", expression: "actualWeightKg ?? assumedWeightKg", condition: "An assumption is allowed only by missing_weight_profit_policy for FBA" },
      { output: "domesticFreightCny", expression: "calculationWeightKg * domesticFreightRateCnyPerKg" },
      { output: "landedPurchaseCny", expression: "purchaseCostCny + purchaseTaxCny + domesticFreightCny" },
      { output: "parts.purchase", expression: "landedPurchaseCny / exchangeRate" },
      { output: "dimensionalWeightKg", expression: "product(dimensionsCm / 2.54) / volumetricDivisor / 2.2046226218", condition: "actual-weight-only is false and dimensions exist" },
      { output: "chargeableWeightKg", expression: "calculationWeightKg", condition: "airFreightActualWeightOnly is true" },
      { output: "chargeableWeightKg", expression: "cartonWeightKg / unitsPerCarton", condition: "actual-weight-only is false and both carton inputs are positive" },
      { output: "chargeableWeightKg", expression: "max(calculationWeightKg, dimensionalWeightKg)", condition: "actual-weight-only is false and carton inputs are incomplete; ignore absent dimensions" },
      { output: "parts.freight", expression: "chargeableWeightKg * airFreightRateCnyPerKg / exchangeRate" },
      ...["commission", "fxLoss", "marketing", "management", "returns"].map((name) => ({ output: `parts.${name}`, expression: `salePrice * ${name}Rate / 100` })),
      { output: "parts.fulfillment", expression: "fulfillmentFee", note: "Charge FBA or FBM once; parts.fba and parts.fbm are aliases, not extra fees." },
      { output: "totalCost", expression: "parts.purchase + parts.commission + parts.fulfillment + parts.freight + parts.fxLoss + parts.marketing + parts.management + parts.returns" },
      { output: "profit", expression: "salePrice - totalCost" }, { output: "margin", expression: "profit / salePrice * 100" },
    ],
    margin_denominator: "salePrice", result_units: { profit: "marketplace_currency/sellable_unit", totalCost: "marketplace_currency/sellable_unit", margin: "percent", parts: "marketplace_currency/sellable_unit", cny_suffix_fields: "CNY/sellable_unit" },
    rounding: { calculation: "IEEE-754 binary64; no intermediate or final rounding in calculateProductProfit", display: "2 decimal places for money and percentage; exported result keeps precision", upstream: "Keep already-resolved salePrice and piece-adjusted purchaseCostCny; do not derive again", comparison_absolute_tolerance: 1e-9 },
    au_fba: {
      currency: "AUD", source: "用户《澳洲站点fba配送费明细标准信封.xls》表格_20261009!A1:E4",
      weight_unit: "g", billable_weight_rule: "max(1, ceil(actualWeightKg * 1000 - 1e-9))",
      selection: "Compare item, package and dimensional fees (cm3 / 6000 kg). Select the highest fee corroborated within 3 AUD by another fee, otherwise a lower corroborated pair; no pair means no valid fee. A single fee is an uncorroborated preliminary estimate.",
      dimensional_weight: { unit: "kg", dimensions_unit: "cm", divisor: 6000, equation: "lengthCm * widthCm * heightCm / 6000" },
      max_dimensions_cm: [33, 23, 2.5], max_weight_g: 475,
      dimensions_policy: "Reject known dimensions beyond the standard envelope limits; missing dimensions are an explicit preliminary assumption",
      price_condition: { threshold: 13, low_operator: "<=", high_operator: ">", low_fee_field: "lowFee", high_fee_field: "highFee", boundary_source: "User confirmed exactly 13 AUD uses the low-price band" },
      rows: AU_FBA_WORKBOOK_RATES, out_of_range: "null; manual fee required", manual_override: "Preserve explicit manual fulfillmentFee",
      missing_weight: "Dimensions alone allow a preliminary estimate using cm3 / 6000 kg; real mass remains unknown. All specifications absent: pending.",
      missing_price_for_minimum_estimate: "Explicitly assume the low-price band until a valid sale price is available",
    },
    ca_fba: {
      currency: "CAD", tax_included: false, source: "用户《亚马逊加拿大站FBA配送费-旺季信封件..xlsx》Sheet1!A1:D8",
      weight_unit: "g", billable_weight_rule: "max(1, ceil(actualWeightKg * 1000 - 1e-9))", max_weight_g: 500,
      selection: "Compare item, package and dimensional fees. Select the highest fee corroborated within 3 CAD by another fee, otherwise a lower corroborated pair; no pair means no valid fee. A single fee is an uncorroborated preliminary estimate. Existing peak table, discount, surcharge and cap remain in force.",
      dimensional_weight: { unit: "kg", dimensions_unit: "cm", divisor: 5021.69, equation: "lengthCm * widthCm * heightCm / 5021.69" },
      dimensions_policy: "Dimensions produce a separate volumetric estimate; no envelope dimension limit is invented",
      source_peak_period: { from: "2026-10-15", through: "2027-01-14" },
      season_policy: "peak_only_user_selected", calendar_switching: false,
      season_note: "User selected this peak table for all current estimates; this is not an official year-round rate claim",
      price_condition: { threshold: 14, discount_operator: "<", discount: 0.8, otherwise_discount: 0 },
      surcharge_multiplier: 1.035, source_surcharge_starts_on: "2026-04-17", equation: "(baseFee - applicableDiscount) * 1.035",
      rounding: "Keep full calculation and export precision; display money with 2 decimal places",
      rows: CA_FBA_PEAK_ENVELOPE_RATES, out_of_range: "null; manual fee required", manual_override: "Preserve explicit manual fulfillmentFee",
      missing_weight: "Compare FBA fees for item mass, package mass and dimensionsCm product / 5021.69 kg; apply the 3 CAD corroboration policy. Dimensions alone allow a preliminary estimate with actual mass remaining null. All three absent: incomplete.",
      missing_price_for_minimum_estimate: "Explicitly assume the low-price discount until a valid sale price is available",
    },
    ownership: { stage: "preliminary", detailed_profit_owner: "procurement", manufacturer_cost_confirmed: false, supplier_cost_changes_return_to_analysis: false },
  };
}

export function createAnalysisHandoffPackage({ runState = {}, products = [], criteria = {}, createdAt = new Date().toISOString(), synthetic = false } = {}) {
  const batchId = str(runState.id || runState.batch_id);
  if (!batchId) throw new TypeError("A saved run id is required for a stable batch identity");
  const classification = classifyAnalysisProducts({ runState, products, criteria });
  const { candidates, passed, excluded, pending, duplicateProductIds, rules } = classification;
  const selected = manuallyReviewedRecords(products, candidates, criteria, runState);
  const readinessProducts = selected.map((record) => {
    const reasons = uniq([...record.filter.reasons, ...(record.missing_fields.length ? ["MISSING_PRODUCT_FIELDS"] : [])]);
    return { product_id: record.product_id, status: record.filter.decision === "pass" && !reasons.length ? "ready_for_procurement_review" : "draft", reasons };
  });
  const draftCount = readinessProducts.filter((record) => record.status === "draft").length;
  const content = { schema_version: ANALYSIS_HANDOFF_SCHEMA_VERSION, package_type: "analysis_to_procurement", source_app: "amazon-product-finder-agent", batch_id: batchId, synthetic: synthetic === true,
    products: selected, filter_rules: rules,
    manual_selection: { method: "manual_analysis_review", source_field: "reviewStatus", required_value: "approved", selected_count: selected.length, product_ids: selected.map((record) => record.product_id), scope_only: true, business_approval: false, automatic_rules_control_selection: false, required_candidate_eligibility: rules.amazon.monthlySalesFilterApplied ? "verified_current_asin_monthly_sales_at_least_50" : "explicitly_imported_asin_without_automatic_sales_floor" },
    readiness: { status: !selected.length ? "empty_selection" : draftCount ? "draft" : "ready_for_procurement_review", draft: draftCount > 0, ready_count: selected.length - draftCount, draft_count: draftCount, requires_consumer_validation: true, consumer_import_compatibility: "not_verified", products: readinessProducts },
    coverage: json(runState.analysisCoverage || runState.coverage || { status: "unknown", full_store_complete: false, note: "No explicit store coverage audit; export does not prove complete store collection." }),
    audit: { counts_basis: "automatic_rule_diagnostics_only", manual_selected: selected.length, total_candidates: candidates.length, passed: passed.length, excluded: excluded.length, pending: pending.length, duplicate_product_ids: duplicateProductIds, excluded_products: excluded, pending_products: pending } };
  // Audit generation time alone is not a source-data revision.
  const identityContent = { ...content, coverage: { ...content.coverage } };
  delete identityContent.coverage.snapshot_at;
  return { ...content, package_id: `analysis:${batchId}:${hash(identityContent)}`, created_at: createdAt, formula_contract: getAnalysisFormulaContract({ inputMode: rules.input_mode, monthlySalesBand: rules.amazon.monthlySalesBand }),
    authorization: { business_approval: false, approved_next_steps: [], user_confirmation_required_in: "procurement", note: "Store imports require qualifying current-ASIN sales evidence; explicit ASIN imports apply sales screening only when a sales band is selected. Manual analysis review selects the eligible exported scope only. Automatic rule diagnostics do not approve products. Neither is manufacturer confirmation, purchase, paid generation or listing publication authorization." },
    handoff: { recipient: "1688-procurement-agent", next_stage: "manufacturer_cost_and_detailed_profit", detailed_profit_owner: "procurement", manufacturer_cost_changes_return_to_analysis: false } };
}

/** Explicit human review selects export scope; selected monthly-sales rules remain authoritative. */
export function selectManuallyReviewedProducts({ runState = {}, products = [], criteria = {} } = {}) {
  const { candidates } = classifyAnalysisProducts({ runState, products, criteria });
  return manuallyReviewedRecords(products, candidates, criteria, runState);
}

function manuallyReviewedRecords(products, records, criteria, runState) {
  const options = monthlySalesOptions(criteria, runState);
  const salesRequired = isMonthlySalesFilterRequired(runState.inputMode, (criteria.amazon || criteria).monthlySalesBand);
  return records.filter((_, index) => products[index]?.reviewStatus === "approved"
    && (!salesRequired || hasQualifyingMonthlySales(products[index], options)));
}

/** Rule diagnostics only; passed is not a manual selection or business approval. */
export function classifyAnalysisProducts({ runState = {}, products = [], criteria = {} } = {}) {
  if (!Array.isArray(products)) throw new TypeError("products must be an array");
  const rules = normalizeCriteria(criteria, runState);
  const candidates = products.map((product) => evaluateAnalysisProduct(product, { runState, criteria: rules }));
  const counts = new Map();
  for (const item of candidates) counts.set(item.product_id, (counts.get(item.product_id) || 0) + 1);
  const duplicateProductIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  for (const item of candidates) if (counts.get(item.product_id) > 1) { item.filter.decision = "pending"; item.filter.reasons = uniq([...item.filter.reasons, "DUPLICATE_PRODUCT_ID"]); finalizeRevision(item); }
  return { candidates, passed: candidates.filter((p) => p.filter.decision === "pass"), excluded: candidates.filter((p) => p.filter.decision === "excluded"), pending: candidates.filter((p) => p.filter.decision === "pending"), duplicateProductIds, rules };
}

export function evaluateAnalysisProduct(product, { runState = {}, criteria = {} } = {}) {
  const rules = normalizeCriteria(criteria, runState);
  const selectedSalesEvidence = monthlySalesEvidence(product, rules.amazon);
  const marketplace = upper(product.marketplace || runState.marketplace), market = MARKETS[marketplace], asin = upper(product.sourceAsin || product.asin);
  const productId = str(product.product_id || product.id) || (marketplace && asin ? `${marketplace}:${asin}` : `unresolved:${hash({ asin: product.asin, sourceAsin: product.sourceAsin, marketplace, sellerId: product.sellerId, name: product.name })}`);
  const currency = upper(product.currency) || market?.[0] || null, language = str(product.language || product.locale) || market?.[1] || null;
  const input = resolveAnalysisProfitInputs(product, marketplace), missing = inputProblems(input);
  const result = missing.length ? null : calculateProductProfit(input);
  if (!result && !missing.length) missing.push("profit_calculation");
  const record = {
    product_id: productId, batch_id: str(runState.id || runState.batch_id),
    source_ids: { analysis_product_id: str(product.id), analysis_run_id: str(runState.id || runState.batch_id), procurement_task_id: str(product.supplierProcurementTaskId), analysis_export_task_id: str(product.exportTaskId || product.legacyExportId), amazon_asins: uniq([asin, upper(product.asin), ...(product.sourceAsins || []).map(upper)]), amazon_parent_asin: upper(product.parentAsin), seller_ids: uniq([str(product.sellerId), ...(product.sourceStores || []).map((s) => str(s.sellerId))]) },
    asin, parent_asin: upper(product.parentAsin), variant: { source_asins: uniq([asin, ...(product.sourceAsins || []).map(upper)]), parent_resolved: typeof product.parentResolved === "boolean" ? product.parentResolved : null, policy: "Original source ASIN identity; parent is a relation, not permission to merge variants." },
    marketplace, language, currency, title: str(product.englishName || product.title || product.name), translated_title_zh: str(product.translatedTitleZh),
    stores: sourceStores(product, marketplace), source_store_criteria: json(Array.isArray(product.sourceStoreCriteria) ? product.sourceStoreCriteria : []), reference_materials: { amazon_url: market && validAsin(asin) ? `https://${market[2]}/dp/${encodeURIComponent(asin)}` : null, image_urls: uniq([url(product.imageUrl), ...(Array.isArray(product.imageUrls) ? product.imageUrls.map(url) : [])]), role: "competitor_reference_only" },
    amazon_observations: { current_price: num(product.currentPrice), monthly_sales: selectedSalesEvidence?.value ?? null, monthly_sales_source: str(selectedSalesEvidence?.source), monthly_sales_evidence: json(selectedSalesEvidence), rating: num(product.rating), reviews: num(product.reviews), item_weight_kg: usesItemWeightOnly(product) ? automaticProductWeightKg(product) : num(product.productWeight), package_weight_kg: automaticPackageWeightKg(product), first_available_date: product.amazonFirstAvailableDateStatus === "found" ? normalizeISODateOnly(product.amazonFirstAvailableDate) : null, first_available_date_status: str(product.amazonFirstAvailableDateStatus) || "unresolved", first_available_date_evidence: json(product.amazonFirstAvailableDateEvidence ?? null), collected_at: str(product.collectedAt), detail_status: str(product.detailStatus), detail_error_code: str(product.detailErrorCode) },
    unit_basis: { sellable_unit: "one Amazon offer unit", piece_count: num(product.pieceCount), units_per_set: num(product.pieceCount), order_quantity: null, detected_piece_count: num(product.detectedPieceCount), piece_count_source: str(product.pieceCountSource), piece_count_evidence: str(product.pieceCountEvidence), reference_unit_cost_cny: num(product.purchaseUnitCostCny), purchase_cost_already_piece_adjusted: true },
    preliminary_profit: { status: result ? "calculated_estimate" : "pending_inputs", stage: "preliminary", formula_version: PROFIT_FORMULA_VERSION, input_formula_version: str(product.profitInputs?.formulaVersion || product.analysisProfitFormulaVersion), inputs: input, result, units: { local_currency: currency, purchase_currency: "CNY", exchange_rate: `CNY/1 ${currency || "marketplace_currency"}`, weight: "kg", dimensions: "cm", rates: "percent", margin: "percent" }, fee_sources: feeSources(product, input), missing_inputs: missing, manufacturer_cost_confirmed: false, detailed_profit_owner: "procurement" },
    analysis_review_status: str(product.reviewStatus), missing_fields: Array.isArray(product.missing) ? product.missing.map(String) : [],
  };
  const facts = { ...record };
  delete facts.source_store_criteria;
  facts.stores = record.stores.map(({ criteria_source, raw_criteria, ...store }) => store);
  record.facts_revision = `facts:${hash(facts)}`;
  record.filter = evaluateFilters(product, record, rules, result, missing);
  record.source_version = { scheme: "content_fingerprint", ordering: "unordered", supersedes_revision: str(product.analysisHandoff?.revision) };
  finalizeRevision(record);
  const previous = product.analysisHandoff;
  if (previous?.facts_revision === record.facts_revision && previous?.screening_revision === record.screening_revision) {
    record.source_version.supersedes_revision = str(previous.source_version?.supersedes_revision ?? previous.supersedes_revision);
    finalizeRevision(record);
  } else if (previous?.revision) {
    const withoutPredecessor = { ...record, source_version: { ...record.source_version, supersedes_revision: null } };
    finalizeRevision(withoutPredecessor);
    if (withoutPredecessor.revision === previous.revision) return withoutPredecessor;
  }
  return record;
}

function evaluateFilters(product, record, rules, calculation, missing) {
  const excluded = [], pending = [];
  // Candidate screening precedes supplier pricing and complete profit calculation.
  if (!record.asin) pending.push("ASIN_MISSING");
  else if (!validAsin(record.asin)) pending.push("ASIN_INVALID");
  if (record.parent_asin && !validAsin(record.parent_asin)) pending.push("PARENT_ASIN_INVALID");
  if (record.source_ids.amazon_asins.some((asin) => !validAsin(asin))) pending.push("SOURCE_ASIN_INVALID");
  if (!record.marketplace || !MARKETS[record.marketplace]) pending.push("MARKETPLACE_UNSUPPORTED_OR_MISSING");
  if (!record.currency) pending.push("CURRENCY_MISSING");
  if (MARKETS[record.marketplace] && record.currency !== MARKETS[record.marketplace][0]) pending.push("MARKETPLACE_CURRENCY_MISMATCH");
  if (!record.language) pending.push("LANGUAGE_MISSING");
  if (String(product.detailStatus || "").toLowerCase() !== "success") pending.push("AMAZON_DETAIL_NOT_COMPLETE");
  if (product.reviewStatus === "rejected") excluded.push("ANALYSIS_REVIEW_REJECTED");
  const storeRules = (Array.isArray(product.storeCriteria) && product.storeCriteria.length ? product.storeCriteria.map((r) => ({ ...rules.amazon, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined && v !== "")), ...intersectReviewRanges(rules.amazon, r) })) : [rules.amazon])
    .map(rule => ({ ...rule, monthlySalesFilterApplied: isMonthlySalesFilterRequired(rules.input_mode, rule.monthlySalesBand) }));
  const storeResults = storeRules.map((rule) => evaluateStoreRule(product, rule, calculation));
  if (!storeResults.some((r) => !r.excluded.length && !r.pending.length)) {
    const possible = storeResults.filter((r) => !r.excluded.length);
    if (possible.length) pending.push(...possible.flatMap((r) => r.pending));
    else excluded.push(...storeResults.flatMap((r) => r.excluded));
  }
  const view = rules.results;
  if (view.query && ![product.asin, product.name, product.englishName, product.storeName, product.sellerId].join(" ").toLowerCase().includes(view.query)) excluded.push("RESULT_QUERY_NOT_MATCHED");
  if (view.minMargin !== null && calculation && calculation.margin < view.minMargin) excluded.push("MARGIN_BELOW_MINIMUM");
  if (view.completeOnly && product.complete !== true) pending.push("COMPLETE_FIELDS_REQUIRED");
  if (view.amazonFirstAvailableFrom) {
    const date = record.amazon_observations.first_available_date;
    if (!date) pending.push("AMAZON_FIRST_AVAILABLE_DATE_UNVERIFIED");
    else if (!matchesAmazonListingDate(date, view.amazonFirstAvailableFrom, view.amazonFirstAvailableThrough)) excluded.push("AMAZON_FIRST_AVAILABLE_DATE_OUTSIDE_RANGE");
  }
  if (rules.selected_product_ids && !rules.selected_product_ids.includes(record.product_id)) excluded.push("OUTSIDE_SELECTED_EXPORT_SCOPE");
  if (rules.export_scope === "approved" && product.reviewStatus !== "approved") excluded.push("OUTSIDE_APPROVED_EXPORT_SCOPE");
  return { decision: excluded.length ? "excluded" : pending.length ? "pending" : "pass", reasons: uniq([...excluded, ...pending]), rule_version: ANALYSIS_FILTER_RULE_VERSION, effective_store_rules: json(storeRules), effective_result_rules: json(rules.results), export_scope: rules.export_scope, business_confirmation: false };
}

function evaluateStoreRule(product, rule, calculation) {
  const excluded = [], pending = [], monthly = monthlySalesValue(product, rule), band = rule.monthlySalesBand || "all";
  // Eligibility uses the enabled source and verified current-ASIN monthly evidence.
  // Unknown sales stay unknown, including while detail collection is pending.
  if (rule.importBlocked === true) excluded.push("STORE_IMPORT_RULE_CONFLICT");
  if (rule.monthlySalesFilterApplied !== false) {
    if (monthly === null) pending.push("MONTHLY_SALES_EVIDENCE_MISSING");
    else if (monthly < 50) excluded.push("MONTHLY_SALES_BELOW_50");
    if (band === "under_50") excluded.push("MONTHLY_SALES_RULE_BELOW_REQUIRED_FLOOR");
    else if (!["all", "50_plus", "50_to_100", "100_plus"].includes(band)) pending.push("MONTHLY_SALES_RULE_INVALID");
    else if (monthly !== null && monthly >= 50) {
      if (band === "50_to_100" && monthly >= 100) excluded.push("MONTHLY_SALES_OUTSIDE_50_TO_100");
      else if (band === "100_plus" && monthly < 100) excluded.push("MONTHLY_SALES_BELOW_100");
    }
  }
  for (const reason of reviewRangeExclusionReasons(product.reviews, rule)) {
    (reason === "REVIEWS_MISSING" ? pending : excluded).push(reason);
  }
  for (const [field, raw, code] of [["rating", rule.minRating, "RATING"]]) {
    const minimum = num(raw), value = num(product[field]);
    if (minimum !== null) { if (value === null) pending.push(`${code}_MISSING`); else if (value < minimum) excluded.push(`${code}_BELOW_MINIMUM`); }
  }
  const minProfit = num(rule.minProfitMargin);
  if (minProfit !== null && calculation && calculation.margin < minProfit) excluded.push("STORE_MARGIN_BELOW_MINIMUM");
  return { excluded, pending };
}

function normalizeCriteria(criteria, runState = {}) {
  const directAsins = runState.inputMode === "asins";
  const amazon = criteria.amazon || criteria, results = criteria.results || {}, monthly = str(amazon.monthlySalesBand) || "all";
  if (!["all", "under_50", "50_plus", "50_to_100", "100_plus"].includes(monthly)) throw new TypeError("Unsupported monthlySalesBand");
  const rawStart = results.amazonFirstAvailableFrom ?? amazon.amazonFirstAvailableFrom;
  const start = rawStart ? normalizeISODateOnly(rawStart) : null;
  const through = todayDateOnly();
  if (rawStart && (!start || start > through)) throw new TypeError("Invalid Amazon first-available start date");
  return { version: ANALYSIS_FILTER_RULE_VERSION, input_mode: directAsins ? "asins" : "stores", amazon: { ...monthlySalesOptions(criteria, runState), monthlySalesFilterApplied: isMonthlySalesFilterRequired(runState.inputMode, monthly), monthlySalesBand: monthly, ...normalizeReviewRange(amazon), minRating: num(amazon.minRating), minProfitMargin: num(amazon.minProfitMargin) },
    results: { query: String(results.query || "").trim().toLowerCase(), minMargin: num(results.minMargin), completeOnly: results.completeOnly === true, amazonFirstAvailableFrom: start, amazonFirstAvailableThrough: start ? through : null },
    export_scope: (criteria.exportScope || criteria.export_scope) === "approved" ? "approved" : "qualified", selected_product_ids: Array.isArray(criteria.selectedProductIds || criteria.selected_product_ids) ? uniq((criteria.selectedProductIds || criteria.selected_product_ids).map(String)).sort() : null };
}

function inputProblems(input) {
  const validAssumption = input.actualWeightKg === null && input.fulfillmentMode === "FBA"
    && input.weightAssumption === "missing_weight_minimum_envelope" && Number.isFinite(input.assumedWeightKg) && input.assumedWeightKg > 0;
  const validDimensionsEstimate = input.actualWeightKg === null && Number.isFinite(input.dimensionalWeightEstimateKg) && input.dimensionalWeightEstimateKg > 0;
  return [...["salePrice", "exchangeRate", "volumetricDivisor", ...(validAssumption || validDimensionsEstimate ? [] : ["actualWeightKg"])].filter((key) => input[key] === null || input[key] <= 0), ...["purchaseCostCny", "fulfillmentFee", ...RATE_KEYS].filter((key) => input[key] === null || input[key] < 0), ...(input.fulfillmentMode ? [] : ["fulfillmentMode"]), ...(typeof input.airFreightActualWeightOnly === "boolean" ? [] : ["airFreightActualWeightOnly"])];
}
function feeSources(product, input) {
  const base = product.profitInputs || {}, fields = product.fieldSources || {};
  const rates = Object.fromEntries(RATE_KEYS.map((key) => [key, str(base[`${key}Source`] || fields[key]) || "resolved_analysis_input"]));
  rates.domesticFreightRateCnyPerKg = str(base.domesticFreightSource) || rates.domesticFreightRateCnyPerKg;
  rates.airFreightRateCnyPerKg = str(base.airFreightRateSource) || rates.airFreightRateCnyPerKg;
  return { purchase_cost: { value_cny: input.purchaseCostCny, source: str(product.purchaseCostSource || fields.purchaseCost) || (product.manualPurchaseCost ? "analysis_manual_reference" : product.supplierCostMode ? "shared_1688_reference" : null), mode: str(product.supplierCostMode), status: "estimate_not_manufacturer_confirmation", rule_version: str(product.supplierRuleVersion), quote_count: num(product.supplierAvailable), included_quote_count: num(product.supplierIncludedCount) },
    fulfillment: { mode: input.fulfillmentMode, source: str(input.fulfillmentMode === "FBM" ? product.fbmFeeSource || fields.fbmFee : product.fbaFeeSource || fields.fbaFee), manual_override: input.fulfillmentMode === "FBM" ? product.manualFbmFee === true : product.manualFbaFee === true, workbook_cell: str(product.fbaEstimate?.sourceCell), rate_source: str(product.fbaEstimate?.rateSource), selected_weight_source: str(product.fbaEstimate?.weightSource), fee_candidates: json(product.fbaEstimate?.feeCandidates || []), dimensional_weight_kg: num(product.fbaEstimate?.dimensionalWeightKg), status: "preliminary_estimate" },
    weight: str(input.weightSource || base.weightSource || product.weightSource || fields.productWeight),
    weight_assumption: input.weightAssumption ? { policy: input.weightAssumption, assumed_weight_kg: input.assumedWeightKg, marketplace: input.weightAssumptionMarket, actual_weight_kg: null, status: "minimum_envelope_preliminary_estimate" } : null,
    exchange_rate: { value: input.exchangeRate, source: str(base.exchangeRateSource || product.exchangeRateSource) || "resolved_analysis_input" }, rates, source_field_values: json(fields) };
}
function sourceStores(product, marketplace) {
  const stores = [...(Array.isArray(product.sourceStores) ? product.sourceStores : [])];
  if (product.sellerId || product.storeName) stores.push({ sellerId: product.sellerId, sellerName: product.storeName, url: product.storeUrl });
  const mapped = stores.map((s) => {
    const linked = (Array.isArray(product.sourceStoreCriteria) ? product.sourceStoreCriteria : []).find((entry) => str(entry.sellerId || entry.seller_id) === str(s.sellerId || s.seller_id)) || {};
    return { seller_id: str(s.sellerId || s.seller_id), name: str(s.sellerName || s.storeName || s.name), marketplace: upper(s.marketplace) || marketplace, url: url(s.storeUrl || s.url), imported_row_numbers: Array.isArray(s.rowNumbers) ? s.rowNumbers : [], criteria_source: json(s.criteriaSource ?? linked.criteriaSource ?? null), raw_criteria: json(s.rawCriteria ?? linked.rawCriteria ?? null) };
  });
  return [...new Map(mapped.map((s) => [stable(s), s])).values()];
}
function num(value) { if (typeof value !== "number" && typeof value !== "string") return null; if (typeof value === "string" && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function finalizeRevision(record) {
  record.screening_revision = `screening:${hash({ filter: record.filter, source_store_criteria: record.source_store_criteria, stores: record.stores.map((store) => ({ seller_id: store.seller_id, criteria_source: store.criteria_source, raw_criteria: store.raw_criteria })) })}`;
  const content = { ...record }; delete content.revision;
  record.revision = `rev:${hash(content)}`;
}
function validAsin(value) { return typeof value === "string" && /^[A-Z0-9]{10}$/.test(value); }
function str(value) { return value === null || value === undefined ? null : String(value).trim() || null; }
function upper(value) { return str(value)?.toUpperCase() || null; }
function uniq(items) { return [...new Set(items.filter((v) => v !== null && v !== undefined && v !== ""))]; }
function fulfillmentMode(value) { const mode = upper(value) || ""; if (/(?:FBM|MFN|MERCHANT)/.test(mode)) return "FBM"; if (/(?:FBA|AMAZON)/.test(mode)) return "FBA"; return null; }
function url(value) { try { const u = new URL(String(value || "")); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; } }
function dimensions(value) { const v = Array.isArray(value) ? value.slice(0, 3) : String(value || "").match(/\d+(?:\.\d+)?/g)?.slice(0, 3); if (!v || v.length !== 3) return null; const r = v.map(num); return r.every((n) => n !== null && n > 0) ? r : null; }
function json(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { if (value === null || value === undefined) return "null"; if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`; return JSON.stringify(value); }
// Content fingerprints identify revisions; they are never security signatures or business approval tokens.
function hash(value) { const text = stable(value); let a = 0x811c9dc5, b = 0x9e3779b9; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x85ebca6b) >>> 0; } return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0"); }

function monthlySalesOptions(criteria = {}, runState = {}) {
  const useSellerSprite = (criteria.amazon || criteria).useSellerSprite ?? runState.criteria?.useSellerSprite;
  return typeof useSellerSprite === "boolean" ? { useSellerSprite } : {};
}
