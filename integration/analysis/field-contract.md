# DIR-20260909-A01 v1.1 · 分析→采购 JSON 1.0

生产入口：`lib/analysis-handoff.mjs#createAnalysisHandoffPackage`。样例 `synthetic: true` 仅用于离线验证，不是实际商品授权。

包字段：`schema_version: "1.0"`、`package_type: "analysis_to_procurement"`、`package_id`、`created_at`、`source_app: "amazon-product-finder-agent"`、`batch_id`、`products`。

- `products` 只包含初筛 pass 且有完整有效初算者，无需强制人工 approved；人工 rejected 排除。初筛不是采购/计费生成/发布授权。
- `audit` 保留 total_candidates/passed/excluded/pending 和 excluded_products/pending_products 完整明细。必要缺失保持 null/pending，显式零才允许 0。
- `coverage` 保留可见分页/详情/缺口证据；导出不能证明全店采全。
- `filter_rules` 保留版本、Amazon 月销量/评价筛选和结果 query/minMargin/completeOnly。逐店条件空则继承全局，同一 ASIN 任一来源店铺满足即可。
- `formula_contract` 是声明式数据，禁止对上传公式文本 eval。
- authorization.business_approval=false、approved_next_steps=[]；后期厂家成本/详细利润由采购负责，不回流分析端。

产品：product_id（优先既有id，通常AU:ASIN）、batch_id、source_ids（对象：analysis_product_id、amazon_asins数组、amazon_parent_asin、seller_ids数组）、asin、parent_asin、variant、marketplace、language（BCP47）、currency（ISO4217）、revision、title、stores、reference_materials（amazon_url/image_urls）、amazon_observations、unit_basis、preliminary_profit、filter、analysis_review_status、missing_fields。

source_ids 兼容新增追溯字段：analysis_run_id=现有runState.id；procurement_task_id=原supplierProcurementTaskId；analysis_export_task_id=原exportTaskId/legacyExportId。有原值则保留，没有则null，不新造旧任务ID。逐店规则importBlocked=true代表导入条件冲突，该来源以STORE_IMPORT_RULE_CONFLICT排除；只有另一来源有有效通过条件时才可保留产品。

preliminary_profit：stage=preliminary、status、formula_version、inputs、result、units、fee_sources、missing_inputs。inputs 使用真实 calculateProductProfit 的 camelCase 键：salePrice、purchaseCostCny、fulfillmentFee、fulfillmentMode、exchangeRate、actualWeightKg、dimensionsCm、cartonWeightKg、unitsPerCarton、airFreightActualWeightOnly、volumetricDivisor，以及 commissionRate/fxLossRate/marketingRate/managementRate/returnsRate/purchaseTaxRate/domesticFreightRateCnyPerKg/airFreightRateCnyPerKg。

purchaseCostCny 是一件 Amazon 可售套装对应的人民币采购总成本，已乘 unit_basis.units_per_set=pieceCount，采购方不可再乘件数。reference_unit_cost_cny 保留参考单件成本。order_quantity 固定 null，不把套内数量当订单数量。exchangeRate 单位 CNY/1站点币。费率25代表25%。利润率分母 salePrice；result 是原公式未舍入双精度结果，展示再保留两位。result 内历史 *Aud 字段实际是当前站点币，按 currency 解释。

重复导出同资料保持 product_id/revision；package_id 基于批次及内容，不受 created_at 影响。revision 包含完整产品事实及筛选信息，facts_revision 表示不含筛选元数据的事实指纹，screening_revision 表示筛选及逐店原始规则指纹。source_version={scheme:"content_fingerprint",ordering:"unordered",supersedes_revision:原analysisHandoff.revision或null}。这些指纹不可按字符串排序推断新旧，不是签名/确认令牌，也不证明发送时间顺序。

消费者合并要求：同revision但内容不同须拒绝；已见过的旧facts_revision回放须拒绝；不同且陌生的facts_revision若缺乏当前版本的前驱映射，只能pending conflict，不可自动覆盖。相同facts_revision仅screening_revision变化时可更新筛选元数据。分析端不伪造supersedes_revision。stores保留criteria_source/raw_criteria，source_store_criteria保留完整来源规则关联。

生产端保存交接回执时必须同时保留 revision、facts_revision、screening_revision、source_version。同事实同筛选再次导出会复用原前驱，不把自己设为自己的前驱；只有revision的旧回执只能识别首个无前驱版本，不能凭空恢复其历史链路。

数值输入仅接受有限number或非空十进制数字字符串，数组、对象、布尔、空白均为null，不按JavaScript强制转换变0。ASIN必须是10位字母数字，格式不符标ASIN_INVALID/pending，不产生详情跳转链接。

集成输入 `{runState,products,criteria:{amazon,results},createdAt,synthetic}`。每产品优先 analysisProfitInputs 或完整 resolvedProfitInputs，否则读取已保存 profitInputs 与商品值；不补默认费率。runState.analysisCoverage 接收覆盖审计输出。classifyAnalysisProducts/evaluateAnalysisProduct 用于 UI 复用判定。生产者样例仍需采购接收方验证，不以 mock 声称真实链路完成。

## 0.9.30 页面与本地接口

结果页“导出合格产品并交接采购”按已确认全局筛选、结果筛选及逐店来源规则生成产品范围。`POST /api/exports/analysis-handoff` 接受上述输入及可选兼容 `worksheet`；要求本机同源，空候选/无pass/非法输入返回422，表格商品ID/行数/顺序必须与JSON一致。返回 `savedFilePath/packageId/createdAt/products`（产品含完整四项版本字段）及可选 `workbook/workbookError`。默认保存到 `D:\铺货筛选`，重名生成新文件，不覆盖旧文件；JSON已成功而Excel失败时会明确分别告知。

页面保存采购所有者与版本回执，并锁定分析初算事实；重复导出仍可进行，后续详细成本在采购端处理。当前交接方式是导出JSON后在采购端导入，未提供自动导入或业务放行。实际函数合成联调12/12及跨站/筛选定向2/2已经总监验证；真实商品授权和外部执行不由这些测试证明。样例正式共享文件名为 `analysis_to_procurement.synthetic.json`，连字符文件名保留兼容别名。
