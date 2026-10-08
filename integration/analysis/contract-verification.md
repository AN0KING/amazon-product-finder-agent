# 交接核心验证记录 · DIR-20260909-A01 v1.1

2026-09-09，生产者模块为 `lib/analysis-handoff.mjs`，计算复用未改动的 `lib/profit-model.mjs#calculateProductProfit`，公式版本 `profit-workbook-au-weight-only-fba-v8`。

`test/analysis-handoff.test.mjs` 13项通过，与原利润测试合计34项通过。覆盖：初筛/排除/待补分离、严格数值类型且空白/数组/对象不转0、10位ASIN校验、缺项null与显式0、非业务授权、套内数量和订单数量分离、原公式一致、重复导出稳定身份、事实和筛选指纹区分、前驱复用不自我变化、费用变化revision失效、旧分析/采购任务ID映射、逐店任一满足与导入冲突排除、销量边界、低评分明确排除、详情待补、变体不合并、重复产品ID阻止传递、站点币种缺失不转US、浏览器可用及声明式公式。

合成文件由本项目实际生产函数生成，不是手写消费者期待值：

- analysis-to-procurement.synthetic.json：2个合格、1个排除、1个待补。厂家成本确认=false、业务授权=false、订单数量=null。
- formula-parity.synthetic.json：4组输入/输出，包括AU120g的FBA 4.35AUD=20.88CNY、人工FBA覆盖6.20AUD、FBM5.25AUD、显式0采购税及人工运费。每组 output 与原计算器深度相等。
- synthetic-fixtures.mjs / generate-samples.mjs：仅离线合成样例生成，不调用任何平台。

对实际生产者保存结构做了只读核对：最新944候选快照中187条已有利润结果可比对，新适配输入重算与其既存 profitCalculation.profit 全部一致，最大误差0。按当时快照保存的全局条件得128合格、25排除、791待补；该数值仅用于结构验证，最终导出还应使用当前已确认筛选与逐店条件。没有把任何真实账号、聊天、ASIN、商品照片或商品资料复制到本目录。

收尾更新：总监actual-apl-9ht1g5真实模块合成联调12/12通过，remaining-business-recheck跨站/筛选2/2通过。UI与保存API已集成并部署0.9.30，完整证据见implementation-receipt.md及deployment-evidence.json。本记录只列核心公式/资料验证，不声称真实Amazon全店采完，也不声称已获业务放行或真实外部执行已验收。
