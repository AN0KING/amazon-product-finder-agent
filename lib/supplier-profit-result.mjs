import { recomputeProductProfit } from './product-profit-state.mjs';
import { calculatePieceAdjustedPurchaseCostCny } from './title-piece-count.mjs';
import { SUPPLIER_COST_RULE_VERSION } from './1688-supplier-policy.mjs';

// Receives only server-finalized quotes. The same deterministic profit formula
// runs in the transaction that stores the quote, without another browser visit.
export function applySupplierProfitResult(product, result, snapshot) {
  if (product.analysisHandoff?.owner === 'procurement' || product.manualPurchaseCost
    || product.costSource === 'manual' || String(product.supplierSource || '').startsWith('manual')
    || product.reviewStatus === 'rejected') return product;
  const next = recomputeProductProfit(product, snapshot);
  const usable = result.ruleVersion === SUPPLIER_COST_RULE_VERSION
    && ['complete', 'fallback_estimate'].includes(result.status)
    && Number.isFinite(result.averageCostCny) && result.averageCostCny > 0;
  Object.assign(next, {
    supplierProcurementTaskId: result.procurementTaskId || next.supplierProcurementTaskId || null,
    suppliers: structuredClone(result.quotes || []),
    supplierSearchStatus: result.status,
    supplierCostMode: result.selectionMode || null,
    supplierCostConfidence: result.costConfidence || null,
    supplierSearchErrorCode: null,
    supplierSearchError: result.status === 'fallback_estimate'
      ? '已按图片相似度选取 6 家真实报价计算参考利润率，采购前请核实款式与规格。'
      : usable ? null : '有效供应商报价不足，采购成本尚未确定。',
    supplierSearchedAt: result.searchedAt || new Date().toISOString(),
    supplierRuleVersion: result.ruleVersion || null,
    supplierSearchAudit: result.audit || null,
    supplierSimilarity: result.similarity || null,
    supplierSource: usable
      ? result.status === 'complete' ? '1688-image-search-verified' : '1688-image-search-low-confidence'
      : `1688-${result.status}`,
  });
  // An unsuccessful optional refresh must not destroy a previously obtained cost.
  if (usable) {
    next.supplierAverageCny = result.averageCostCny;
    next.purchaseUnitCostCny = result.averageCostCny;
    next.purchaseCost = calculatePieceAdjustedPurchaseCostCny(result.averageCostCny, next.pieceCount);
    for (const error of snapshot.runState.errors || []) {
      if (error.stage === '1688_image_search' && (error.productId === next.id || error.asin === next.asin)) {
        error.recovered = true;
        error.recoveredAt = new Date().toISOString();
      }
    }
    snapshot.runState.dataSource = `Amazon ${next.marketplace} 官网商品页 + 1688 图片找厂`;
  }
  return recomputeProductProfit(next, { ...snapshot, now: new Date().toISOString() });
}
