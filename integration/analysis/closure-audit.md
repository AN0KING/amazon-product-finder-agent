# DIR-20260909-A01 v1.1 · 交接资料收尾审计

审计更新时间：2026-09-09（Asia/Shanghai）。范围是本应用交接字段说明、当前生产函数、离线样例/公式向量，以及总监已生成的联合报告来源 SHA-256。最新联合报告 actual-apl-9ht1g5 为12/12通过，独立跨站/筛选更新为2/2通过。本审计未重跑采购或Listing模块，未操作总监台账；页面与0.9.30部署的独立证据见implementation-receipt.md。

## 版本与可复现生成

- 应用 package.json：0.9.30。
- 交接 schema_version：1.0；package_type：analysis_to_procurement。
- 筛选规则版本：analysis-preliminary-filter-v1。
- 利润公式版本：profit-workbook-au-weight-only-fba-v8。
- 生产入口：lib/analysis-handoff.mjs#createAnalysisHandoffPackage，利润计算复用 lib/profit-model.mjs#calculateProductProfit。

本项目根目录执行 `node integration/analysis/generate-samples.mjs` 可生成两份 synthetic 样例。已读该脚本，写入目标仅为本目录固定的 analysis-to-procurement.synthetic.json 和 formula-parity.synthetic.json；没有平台调用。本次直接调用同一 createSyntheticArtifacts 生成内存结果，与磁盘两份 JSON 做深度相等比较，全部一致，因此没有不必要地重写样例。

当前样例 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| analysis-to-procurement.synthetic.json | aef39f7fb54e784fbad7c2c9af25f8a3e796fb7ab723065fbc674e4df30fb5f4 |
| formula-parity.synthetic.json | b227253ada01821314d24418e032690fe0713469c8db40c6c40112edbd783f0a |

## 字段约定与代码一致性

field-contract.md 与当前实现一致：

1. product_id 优先保留既有 ID；source_ids 为对象，包含 analysis_product_id、analysis_run_id、procurement_task_id、analysis_export_task_id、amazon_asins、amazon_parent_asin、seller_ids。旧采购/导出任务有原值才带入，无值保持 null；变体保留原 ASIN，不按父体静默合并。
2. facts_revision 对事实内容生成指纹，排除 source_store_criteria 和 stores 内的原始筛选元数据；screening_revision 包含判定、有效规则及逐店来源规则；revision 覆盖完整记录。指纹不具顺序性，不是签名或业务确认令牌。
3. source_version.scheme=content_fingerprint、ordering=unordered。第一次无前驱时 supersedes_revision=null；后续有保存回执才引用原 revision。同事实同筛选重复导出复用原前驱，不把自己设为自己的前驱。消费者是否正确拒绝旧版本回放仍需其实际模块验证，不仅凭字段存在作结论。
4. unit_basis.units_per_set 是每个 Amazon 可售单位内的件数，order_quantity=null；purchaseCostCny 是已乘件数的整套人民币采购成本。当前样例每件参考价3元、2件一套，整套成本6元；计算未再次乘2。总监联合测试采用每件5元、2件一套、整套10元，是另一个合成输入，不能混作同一数值用例。
5. 汇率单位 CNY/1站点币，重量 kg、尺寸 cm、百分费率/利润率为百分点（15表示15%）；利润率分母是 salePrice。实际公式保留双精度，展示才保留两位。空白、数组、对象、布尔值等不会被交接数值解析器强制转为0；明确零保留0。导入的20%最低利润率保持20百分点，不重复乘100。
6. 当前生产者样例为2个合格、1个排除、1个待补，coverage为partial且full_store_complete=false；authorization.business_approval=false、approved_next_steps=[]，不是厂家成本确认、采购、计费生成或发布授权。

## 本地证明与复核点

本次执行 test/analysis-handoff.test.mjs 与 test/store-list-criteria.test.mjs，共28项全部通过；涵盖事实/筛选修订、前驱复用、源ID、严格数值、ASIN、行级筛选、单位与XLSX百分比格式。4组公式向量逐项与 calculateProductProfit 输出深度相等，包括120g自动FBA=4.35AUD（汇率4.8时20.88CNY）、手工FBA、FBM及明确零税率。

独立审计发现的 saveExportHandoff(document:undefined) 问题已增加校验并修复。维护者导出相关72项全部通过，含该回归、空/非法包拒绝、并发JSON无覆盖及隔离真实HTTP验证；完整扫描首次427/429，修正两处旧测试适配后定向12项全通过。完整方法及分层结果见总回执，不将重叠测试数相加。

## 已有联合报告的来源复核

已直接读取更新报告：C:\Users\nanashiWu\Documents\Codex\2026-09-09\wo\outputs\integration\joint\actual-apl-9ht1g5\actual-apl-report.json。运行时间2026-09-09T05:07:07.111Z至05:07:07.656Z，12通过、0失败、0跳过，result=passed_synthetic_integration。报告标记 synthetic=true、external_network_calls=0、production_data_access=false。

报告内7份来源的运行前后 SHA-256 一致（source_stable=true）。本轮仅重新复核A端两份当前文件，两者均与新报告相同；没有重复全局扫描下游项目：

| A端源文件 | 新报告和本次磁盘 SHA-256 | 是否一致 |
| --- | --- | --- |
| lib/analysis-handoff.mjs | 7b75f724b2ba5e9345a08b2ce71b115ecf0a04d18b05fcc9a94fc136e4581a51 | 是 |
| lib/profit-model.mjs | 0aa9cf4af78f44e7c2aa54e1c7e743a48af531fde9e3e40b8504fe5d9ded4298 | 是 |

新报告证明其选定真实模块在合成资料上完成A→P→L的12个指定场景：A身份/两件成本口径、P重复导入及工单/导出幂等、明确合成决定、验证器的synthetic阻止和内容摘要绑定、L接收P包的身份/单位/版本、合成资料不能正式生成图文或交付、成本变化使旧决定/工单/产物引用待复核、重新确认后的新采购成本与工单版本、L接收同分析revision的新采购成本版本并保留本地草稿、L旧包回放不回退、A→P已知历史来源回放被拒绝。

这里的 actual 指调用真实模块，并非真实店铺或真实商业授权。旧 actual-apl-XVnXZF 的 procurement_secret_field 误拦截已由新版联合报告验证修复；旧8/1/3结果及旧来源差异不能继续作为当前联合结论。本次仅读报告和A端hash，没有重跑联合脚本或修改其他应用。

## 独立采购业务场景已验

另已读取 C:\Users\nanashiWu\Documents\Codex\2026-09-09\wo\outputs\integration\remaining-business-recheck.md，最新报告时间2026-09-09T05:19:33.146Z，两个附加场景2/2通过，不与上述12个主场景混同。

跨站更新场景通过：AU/AUD转US/USD后，未重算被BUSINESS_PROFIT_INCOMPLETE阻止；显式按US重新核算后可确认导出，旧利润保留为历史。

筛选更新已通过：仅把minProfitMargin改为1，A的facts_revision不变、screening_revision改变，并正确附带指向当前版本的source_version.supersedes_revision，采购端成功接受新包。此前BUSINESS_SOURCE_ORDER_UNPROVEN已修复，不能继续列为当前阻塞。分析端未伪造采集时间或版本顺序。

## 未证明的范围

12/12主链和2/2定向通过仅对应报告列出的合成场景，不证明所有现实业务边界均已完成。A01页面和部署已由主代理另行核实，见总回执；不声称真实Amazon全店采集完整，也不声称真实1688登录/厂家询盘/订单/付费模型/图片/发布已验收。共享目录只发布脱敏样例与验证资料。
