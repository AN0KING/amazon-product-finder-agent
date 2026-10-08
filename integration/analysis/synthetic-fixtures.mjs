import { calculateProductProfit, estimateAu2026FbaFeeByProductWeight, PROFIT_FORMULA_VERSION } from "../../lib/profit-model.mjs";
import { createAnalysisHandoffPackage, getAnalysisFormulaContract } from "../../lib/analysis-handoff.mjs";

export const syntheticProfitInputs = Object.freeze({ salePrice: 19.99, purchaseCostCny: 6, fulfillmentMode: "FBA", fulfillmentFee: 4.35, exchangeRate: 4.8, actualWeightKg: 0.12, dimensionsCm: null, cartonWeightKg: null, unitsPerCarton: null, airFreightActualWeightOnly: true, volumetricDivisor: 139, commissionRate: 15, fxLossRate: 1.5, marketingRate: 10, managementRate: 6, returnsRate: 10, purchaseTaxRate: 4, domesticFreightRateCnyPerKg: 5, airFreightRateCnyPerKg: 60 });

export function syntheticProduct(overrides = {}) {
  return { id: "AU:B0SYNTH001", asin: "B0SYNTH001", sourceAsin: "B0SYNTH001", sourceAsins: ["B0SYNTH001"], parentAsin: "B0SYNTH000", parentResolved: true,
    marketplace: "AU", currency: "AUD", sellerId: "SYNTHETIC_SELLER_A", storeName: "Synthetic AU Store", englishName: "Synthetic Example 2 Pieces Storage Bags", imageUrl: "https://example.invalid/synthetic-product.jpg", collectedAt: "2026-09-09T00:00:00.000Z", detailStatus: "success", currentPrice: 22.21, sales30: 100, rating: 4.5, reviews: 80, productWeight: 0.12, billingWeight: 0.12,
    salePrice: syntheticProfitInputs.salePrice, purchaseCost: 6, purchaseUnitCostCny: 3, pieceCount: 2, detectedPieceCount: 2, pieceCountSource: "synthetic_title", pieceCountEvidence: "2 Pieces", fulfillmentMode: "FBA", fbaFee: 4.35, fbaFeeSource: "au_workbook_weight_rate", fbaEstimate: estimateAu2026FbaFeeByProductWeight({ actualWeightKg: 0.12 }),
    supplierCostMode: "low_confidence_top_6", supplierAvailable: 6, supplierIncludedCount: 6, supplierRuleVersion: "1688-image-only-always-top6-trimmed-10-v6", supplierProcurementTaskId: "synthetic-existing-procurement-task-001", exportTaskId: "synthetic-existing-analysis-export-001", reviewStatus: "pending", complete: true, missing: [],
    profitInputs: { ...syntheticProfitInputs, formulaVersion: PROFIT_FORMULA_VERSION, weightSource: "synthetic_amazon_item_weight", airFreightRateSource: "au_workbook_60_cny_per_kg", domesticFreightSource: "product_weight_rate_estimate" }, analysisProfitInputs: { ...syntheticProfitInputs }, ...overrides };
}

export function syntheticAnalysisInput() {
  return { synthetic: true, createdAt: "2026-09-09T00:00:00.000Z", runState: { id: "synthetic-analysis-batch-20260909", marketplace: "AU", analysisCoverage: { scope: "amazon_visible_store_results", status: "partial", full_store_complete: false, counts: { imported_stores: 1, visible_candidates: 4 }, detail_counts: { success: 3, pending: 1 }, limitations: ["Synthetic multi-page fixture: one product detail intentionally pending; not a real store crawl."] } },
    criteria: { amazon: { monthlySalesBand: "100_plus", minRating: 4, minReviews: 50 }, results: { query: "", minMargin: 0, completeOnly: false } },
    products: [syntheticProduct({ reviewStatus: "approved" }), syntheticProduct({ id: "AU:B0SYNTH002", asin: "B0SYNTH002", sourceAsin: "B0SYNTH002", sourceAsins: ["B0SYNTH002"], reviewStatus: "approved", fulfillmentMode: "FBM", fbmFee: 5.25, manualFbmFee: true, fbmFeeSource: "analysis_manual", analysisProfitInputs: { ...syntheticProfitInputs, fulfillmentMode: "FBM", fulfillmentFee: 5.25 } }),
      syntheticProduct({ id: "AU:B0SYNTH003", asin: "B0SYNTH003", sourceAsin: "B0SYNTH003", sourceAsins: ["B0SYNTH003"], sales30: 30 }),
      syntheticProduct({ id: "AU:B0SYNTH004", asin: "B0SYNTH004", sourceAsin: "B0SYNTH004", sourceAsins: ["B0SYNTH004"], detailStatus: "pending", productWeight: null, purchaseCost: null, complete: false, missing: ["采购成本", "商品重量"], analysisProfitInputs: { ...syntheticProfitInputs, purchaseCostCny: null, actualWeightKg: null } })] };
}

export function createSyntheticArtifacts() {
  const formulaCases = [
    { name: "AU 120g workbook FBA / 2 units per set", input: { ...syntheticProfitInputs }, units_per_set: 2, reference_unit_cost_cny: 3 },
    { name: "AU manual FBA override preserved", input: { ...syntheticProfitInputs, fulfillmentFee: 6.2 }, manual_fba_override: true },
    { name: "AU FBM fulfillment fee charged once", input: { ...syntheticProfitInputs, fulfillmentMode: "FBM", fulfillmentFee: 5.25 } },
    { name: "Explicit zero purchase tax and manual freight rates", input: { ...syntheticProfitInputs, purchaseTaxRate: 0, domesticFreightRateCnyPerKg: 3.4, airFreightRateCnyPerKg: 52 } },
  ].map((item) => ({ ...item, output: calculateProductProfit(item.input), displayed: { fulfillment_cny: Number((item.input.fulfillmentFee * item.input.exchangeRate).toFixed(2)), profit_cny: Number((calculateProductProfit(item.input).profit * item.input.exchangeRate).toFixed(2)) } }));
  return { handoff: createAnalysisHandoffPackage(syntheticAnalysisInput()), formula: { synthetic: true, schema_version: "1.0", formula_contract: getAnalysisFormulaContract(), cases: formulaCases } };
}
