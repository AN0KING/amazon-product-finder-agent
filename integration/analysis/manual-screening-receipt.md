# DIR-20260909-A03 · 人工筛选与手动导出实施回执

已完成小范围修复、定向验收和可恢复部署。正式服务 **0.9.32**，2026-09-09 15:09（Asia/Shanghai）核验，入口 http://127.0.0.1:4173/ 。总监台账未修改。

## 根因

原运营导出 exportProducts 已正确区分全部 products 与 reviewStatus === "approved"，无需重写。错误在A01新增路径：renderAnalysisHandoffSummary 显示 classifyAnalysisProducts 的规则统计；exportAnalysisHandoff 和 createAnalysisHandoffPackage 都采用 classification.passed。规则符合128条被当作交接范围，与人工初审2条不一致。它没有直接修改原审核状态，但绕过人工范围另选了126条。只把 criteria.exportScope 改为 approved 仍不够：旧规则会继续剔除已人工选择但资料不完整或规则不达标的商品。

## 页面和范围

- 删除新增的“初筛合格 / 排除 / 待补”自动业务卡、自动交接推荐文案及其渲染时的规则分类。只保留客观采集覆盖信息。
- 原“导出运营表 → 全部候选产品”：全部候选，含全部审核状态与完整度，不限当前显示结果；不等于全部人工通过。
- 原“导出运营表 → 已初审产品”：只按人工 reviewStatus === "approved" 取集合，不再加月销量、利润、完整度等算法门槛。原Excel表格、图片和字段格式保留。
- 原独立店铺输入、人工资料和成本、利润模型、AU Excel FBA、确认筛选、1688按批次匹配、历史及审批滚动均保留。
- 可选交接按钮退出常规卡片，放入关闭状态的导出菜单，标为“已初审产品交接包（可选）”。只有点击才导出，同一人工初审快照同时供Excel与JSON使用；未新增全部候选JSON，没有自动导出、发送采购或修改审核状态。

## 实际交接边界

前端在用户点击后只捕获人工初审 exportRows，深拷贝为快照，Excel和JSON使用同一顺序和ID。后端 createAnalysisHandoffPackage 同样只选择原始 reviewStatus 严格等于 approved 的商品；缺少该值不能按规则自动成为已初审。

selectManuallyReviewedProducts 是唯一手动选择函数。classifyAnalysisProducts / evaluateAnalysisProduct 保留兼容诊断用途，但 passed / excluded / pending 不再决定导出集合。包内 manual_selection 明确方法、原字段、ID、数量及“仅范围、不是采购业务批准”；audit.counts_basis 明确自动诊断不能冒充人工选择。资料缺项、详情失效、低利润或当前筛选不满足的已初审商品均保留，通过 readiness 标记草稿并保留缺项原因及null数据。重复导出、筛选或资料变化不增加或删去人工选择。

文件保存层不再要求 filter.decision === "pass"，改为严格核对每条 analysis_review_status === "approved"、manual_selection 的ID顺序/数量/元数据及草稿状态。没有人工通过时HTTP返回422 NO_REVIEWED_PRODUCTS；Excel夹带待审商品、错序或数量不一致返回422 HANDOFF_WORKBOOK_SCOPE_MISMATCH，不写文件。

新JSON名为 Scout_站点_已初审产品交接包_时间.json；有需核对项则标为已初审产品交接草稿。配套Excel仍用原已初审产品格式。缺资料的包没有宣称可直接被采购端接收；本轮未重做采购导入。A01旧JSON文件和历史样本未改写，其中规则通过元数据也不等于用户人工批准。应使用新版用户点击导出的人工范围；无需将任何128条旧自动结果视为新授权。

A02独立启动、新分析版本的保存后解锁、失败回退、旧历史不可改写、前驱版本关系均保留。新分析草稿依原流程回到待初审，再交接需由用户真实点击初审，不能借规则自动恢复批准。

## 定向验收

全部使用合成数据、模拟接口或随机本机端口/临时目录，没有真实平台采集或业务导出。

| 验收 | 结果 |
| --- | --- |
| 原利润、AU FBA、实时编辑、审核、运营Excel、文件保存与持久化 | 68项通过 |
| 手选集合、公式不变、版本前驱与重复导出核心契约 | 22项通过 |
| 实际HTTP与文件保存边界 | 3项通过 |
| 944候选 / 规则128 / 当前显示795 / 人工2 浏览器场景 | 全部Excel944，已初审Excel2，可选JSON2，ID和顺序一致 |
| 将显示筛选改至0条 | 人工初审数量仍2，导出仍是原2条 |
| 人工2中包含低利润、缺重量或成本、详情失效等 | 保留同一范围，缺项维持null，交接标草稿 |
| 未点击、筛选变化、页面渲染 | 没有自动导出或自动改审核状态 |
| 连续重复交接及资料/筛选变更 | 人工ID集合保持；同内容revision稳定，变化有正确前驱 |
| 原交接浏览器回归 | 真实点击2次初审、3次交接；9项快照只读、来源与版本通过 |
| 原独立UI / A02新版本 | 保存失败回退、先保存后解锁、重复保护、2/3版平铺历史、再人工审批交接、原init/导入/成本保存通过 |
| 审批滚动 | 连续通过和淘汰4296→4296；手工审批、筛选移出、重绘、快速重开通过 |

脚本：scripts/verify-manual-screening-ui.mjs、verify-analysis-handoff-ui.mjs、verify-standalone-ui.mjs、verify-review-scroll.mjs。未重复全套439项或扩展采购重构。

## 部署与数据保留

部署前后原32个业务数据文件SHA256全部一致，涵盖原商品资料、历史和审核状态。未替用户修改944商品或执行产品审批，未导出真实运营表。SellerSprite历史调用608，本次0；正式服务三个在途请求计数均0。

只在4173确认空闲、核对进程归属及请求封存后，将0.9.31/29304升级为0.9.32/16436。16880采购服务未重启。首页、app.js、styles.css、analysis-handoff.mjs均HTTP200，正式响应与本地文件一致，Cache-Control=no-store。完整结构化记录见 manual-screening-evidence.json。

生产改动仅本应用 app.js、index.html、styles.css、lib/analysis-handoff.mjs、lib/export-file-store.mjs、server.mjs及版本号文件/启动器。修改前9个明确代码文件备份于 D:\deliverables\amazon-product-finder-agent\backups\DIR-20260909-A03-predeploy；其中两个lib模块在备份根目录按原文件名保存。恢复须只针对这些代码文件并先检查空闲，不能覆盖业务数据或其他Agent。原利润模型和A02持久化模块未改。

本轮无未解决部署阻塞。用户刷新页面后继续自主筛选、人工初审，再选择原手动导出入口即可。

