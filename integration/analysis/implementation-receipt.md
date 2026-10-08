# DIR-20260909-A01 v1.1 实施回执

状态：已完成代码、必要回归及店铺分析服务部署。版本 **0.9.30**；2026-09-09 13:28（Asia/Shanghai）核验。工程：`D:\deliverables\amazon-product-finder-agent`，入口：http://127.0.0.1:4173/ 。本回执覆盖 A01，后续真实商品放行仍由用户本人决定。

## 实际变更

- 店铺 XLSX 支持逐店月销量、评价数量、星级及初步利润率条件，保留行号、原始值和百分比格式来源。空条件继承当前全局条件；重复店铺条件冲突暂停该来源，混合站点明确分批，不静默转 US。
- Amazon 分页保留逐页 URL/下一页/日期/商品数量/新增与重复 ASIN/中断原因，并贯穿断点保存及恢复；循环游标终止无进展重试。覆盖汇总区分可见结果、详情待补、估算分母与未知变体；历史无证据不补造“全店完成”。
- 初筛复用原 `calculateProductProfit`，分别输出通过、排除、待补及原因。数值缺项保持 null；不把空白、数组、对象或布尔转为0。AU FBA及现有人工覆盖规则未重写。
- 页面新增初筛统计、覆盖说明及“导出合格产品并交接采购”；旧全部候选/已初审 Excel 菜单保留。新入口保存同一合格范围的嵌图 XLSX 与 `analysis_to_procurement` JSON 到 `D:\铺货筛选`。JSON 含排除/待补明细、费用来源和完整声明式公式契约；空包或表格范围/格式不合法会被拒绝。
- 导出后保存 `revision`、`facts_revision`、`screening_revision`、`source_version` 与采购所有者。初算快照及事实输入锁定，手工成本、审批、重匹配和异步报价不能再修改该快照；可重复导出或更新筛选元数据。下一步是用户在采购端导入文件并核实厂家成本、详细利润；本功能没有自动导入、询盘或业务放行。
- `units_per_set` 是每个可售套装包含的件数，采购总成本已经乘件数；`order_quantity=null`。费率25代表25%，汇率为 CNY/1售价币种，利润率分母为 salePrice，原计算器未舍入结果随包传递。
- 保留用户要求的审批滚动修复：列表刷新和关闭详情后维持位置，重新定位当前商品行；行隐藏及快速重开均有处理。

## 回归与验收证据

1. 完整本地回归扫描429项：首次427通过、2项旧测试适配失败。修复两处隔离依赖/既有按钮条件断言后，相关12项定向复跑全通过；无剩余已知失败。语法检查通过。另维护者定向45项和相关66项通过，有重叠，不累计为独立总数。
2. 导出相关72项通过，含随机本机端口、临时数据和导出目录上的真实HTTP请求，以及生成JSON/XLSX实读。证明非法/空输入422、仅pass、商品ID/数量/顺序一致、同名不覆盖、完整版本回传和旧Excel接口兼容；空图片夹具不产生图片网络请求。
3. `scripts/verify-analysis-handoff-ui.mjs` 离线浏览器通过：2合格/1排除/1待补；3次导出验证范围、同内容幂等、筛选改变时facts不变且有正确前驱；9个事实/审批入口锁定，保留来源冲突/混合站点提示，平台请求0。
4. `scripts/verify-review-scroll.mjs` 通过：连续2次通过和1次淘汰，scrollTop均4363→4363；删除行回退与快速重开均通过。使用120个模拟商品，不写真实审批。
5. 两份生产者样例与 `createSyntheticArtifacts()` 输出深度一致，4组利润输入输出与原计算器一致；核心13项与原利润21项合计34项通过。
6. 总监已有真实模块的合成联调报告 `outputs/integration/joint/actual-apl-9ht1g5/actual-apl-report.json`：12/12通过。分析端核心与利润模块SHA-256与该报告一致。本轮复核报告，没有重跑跨项目联调；旧XVnXZF的Listing误拦截结论已被替代。

## 部署与数据保留

使用 `scripts/restart-scout-only.ps1`，重启前核对监听PID归属、三种任务计数均0，再经接口确认排空。只将4173从0.9.29/PID6656更新至0.9.30/PID16960；没有启动、停止或重启16880。

部署后 `/api/version` 返回0.9.30、任务计数均0、draining=false；首页、app.js及两个新模块均HTTP200且内容与磁盘源码完全一致、Cache-Control=no-store。在线空交接请求返回422/INVALID_ANALYSIS_HANDOFF，没有生成测试业务文件。全部32个原业务数据文件逐一比较SHA-256，升级前后完全相同。详见 `deployment-evidence.json`。

## 回滚点

保留原代码备份：`backups\DIR-20260909-A01-predeploy`（0.9.29）。覆盖首页/样式/app/server、package及lock、启动器、店铺导入、Amazon客户端、导出存储和原利润模型；备份中lib文件按basename平放，恢复时须放回对应lib路径。

需要回退时先确认无在途请求、暂停新交接，再恢复上述对应代码并用仅4173重启脚本核对版本。新增加的兼容审计持久化字段及业务数据不回退，不删除交接包。该回滚方案未实际执行演练，不能声称完整进程/数据回滚已验收。

## 交付文件与未验范围

共享目录：`C:\Users\nanashiWu\Documents\Codex\2026-09-09\wo\outputs\integration\analysis`。

- `analysis_to_procurement.synthetic.json`（保留`analysis-to-procurement.synthetic.json`别名）：实际生产函数生成，2合格/1排除/1待补，synthetic=true、business_approval=false。
- `formula-parity.synthetic.json`：4组真实公式输入/输出及公式、费用口径。
- `field-contract.md`、`store-import.md`：最终字段/版本前驱与输入表约定。
- `closure-audit.md`、`contract-verification.md`、本回执、`deployment-evidence.json`：分层证据。

总监定向报告 `outputs/integration/remaining-business-recheck.md`（2026-09-09T05:19:33.146Z）已确认跨站/筛选两项2/2通过：跨站先要求按新币种重算；仅变minProfitMargin时facts稳定、screening改变及合法前驱被采购端接受。此前 BUSINESS_SOURCE_ORDER_UNPROVEN 已修复，不再列为当前阻塞；分析端没有伪造采集时间。本轮仅复核该报告，没有重复运行。

本轮没有重新运行真实Amazon全店抓取，不能证明平台可见范围或所有子变体已采齐；没有真实1688登录验证、厂家询盘/回复、采购下单/付款、模型/图片付费生成或Amazon发布。实际商品仍需在采购端导入并经用户确认。所有新验收数据均为合成资料，服务升级保留原业务文件。
