# A02 · 店铺分析独立功能对照

初次只读审阅（历史记录）：2026-09-09 14:09（Asia/Shanghai）。当时以 backups/DIR-20260909-A01-predeploy 的0.9.29为基线，对照当时 package.json/app.js 的0.9.30；这些版本和时间不代表后续A02代码的当前状态。初次审阅未运行真实采集、1688匹配或导出，未改生产代码、共享目录或总监台账。2026-09-09追加的持久化修复及验证结果见文末；本文件不是浏览器验收或部署完成证明。

在初次审阅时，index.html没有删除任何基线DOM id，新增10个导入警告/初筛/交接相关id。主代理随后负责“创建新的分析版本”入口及其恢复逻辑，本审计不另行设计替代流程。

## 原功能与当时入口（历史对照）

| 功能 | 0.9.29原入口及当时保留入口 | 初次审阅时的行为与依据 |
| --- | --- | --- |
| 新任务与XLSX导入 | 新建任务导航；uploadZone/storeFileInput | bindNavigation/showView切到任务页；bindFileImport重新导入.xlsx并替换当前清单，已有在途请求有确认提示，旧历史仍保留。没有总监或采购授权条件。 |
| 当前店铺管理 | storeManagerToggle、clearStoreListButton、data-remove-store | 可展开、逐店移除、清空；不修改源Excel。在途Amazon/1688期间禁用修改。applyStoreMutation清空本页结果，已有结果时先提示。 |
| 站点选择 | marketplaceSelect | NL/AU/US开放，DE/EU仍明确标“后续”并禁用。bindMarketplace切站重置当前清单/结果，防止混市场采集。 |
| 数据源选择 | useSellerSpriteToggle；connectSellerSpriteButton/侧栏授权按钮 | 默认不勾选SellerSprite；仅使用Amazon即可开始，只有用户主动勾选后才要求SellerSprite连接。 |
| Amazon采集与连接 | startAnalysisButton、amazonRefreshButton | updateStartAvailability/runAnalysis要求有效本站店铺、无冲突请求；没有采购确认或总监审批条件。采集后1688独立启动，不自动对所有产品找厂。 |
| 分页/详情断点续跑 | startAnalysisButton、retryConnectionButton；历史恢复后的自动续跑 | amazonRunNeedsResume/scheduleAmazonRunResume识别店铺分页/待补详情；已保存断点可续跑。覆盖统计和店铺访问明细保留，新增初筛覆盖栏明确“可见范围/部分完成”。 |
| 人工Amazon信息 | 商品行进入openDrawer→openManualCostButton→手动弹窗 | 现有data-manual-amazon输入仍有标题、售价、月销量、星级/评价数、日期/A+等；saveManualCost保存后重算。未交接产品不要求先到采购端确认。 |
| 利润、FBA、运费和件数 | profitTab；editPurchaseCost/editPieceCount/editFbaFee/editWeight；手动弹窗data-product-cost | bindDrawer实时预览并自动保存有效值；套内件数单独可编辑；手工履约方式/费用、重量/尺寸/费率仍保留。售价在简版利润栏保持原readonly口径，通过人工Amazon输入调整竞品价。 |
| Amazon与结果筛选 | monthlySalesBand/minReviews/minRating + applyAmazonFiltersButton；resultSearch/resultMinMargin/resultsCompleteToggle | Amazon条件点击确认后生效；结果搜索/利润率/完整度入口保留，重置/显示隐藏项保留。所有源ASIN保存在products中，不因筛选删除。 |
| 独立1688参考匹配 | matchFiltered1688Button；单品rematchProductButton | renderSupplier1688Stage固定当前已确认筛选批次，并有继续未完成批次入口；Amazon未完成时已有合格资料仍可匹配。单品操作保留，无总监审批条件；存在输入/登录/忙碌状态约束。 |
| 共享1688登录与验证 | 侧栏login1688Button/check1688Button | load1688SessionStatus读取共享/api/v1/runtime；采购客户端openLogin调用现有/api/v1/auth/open-login，匹配走/api/1688/image-search。本应用没有另复制Cookie的前端流程。平台登录/风控验证仍是匹配的外部条件。 |
| 初审与淘汰 | approveProductButton/rejectProductButton；manualCostApproveButton | 初审使用当前有效利润，正在匹配时不能初审；淘汰入口保留。openDrawer/closeDrawer已保留列表位置并重新定位行。初审不是厂家成本确认或真实商品后续授权。 |
| 历史结果与本地记录 | 任务记录导航；data-history-run-id、data-history-folder-run-id | bindHistory仍支持恢复历史结果和打开记录文件夹；restoreRunSnapshot保持商品对象及断点。没有总监/采购接收前置。 |
| 原Excel导出 | exportButton→exportAllCandidatesButton/exportApprovedProductsButton | 原范围分别是全部候选与已初审通过；导出不强制完整字段，图片嵌入/缺失说明/源ID仍保留，保存到D:\铺货筛选。原Excel菜单没有被新的交接入口替换。 |
| 新增合格交接导出 | exportAnalysisHandoffButton | 在原Excel功能之外新增当前初筛合格的Excel+JSON交接，保留排除/待补审计。接收对象提示为1688采购端；导出前不要求采购已经导入或总监已经放行。 |

代码初始化先绑定导航、导入、店铺管理、筛选、结果、人工修改和历史，再以Promise.allSettled读取运行状态/历史/1688状态（app.js#init）。1688不可用不会成为绑定这些独立入口的前置条件。

## 锁定与新增分析版本（初次审阅记录）

初次审阅源码isAnalysisReadOnly约束为analysisHandoff.owner=procurement或正在保存该商品交接包。该约束保护已交接的初算快照，影响人工修改/重匹配/审批；它不是所有新任务的总监/采购前置。

主代理已明确负责新增“创建新的分析版本”，用于从已交接资料恢复一个可编辑的本地分析版本并保留交接历史。本审阅没有修改锁定逻辑、增加另一套解锁方案，也不把尚未核验的新按钮记录为已部署。

## 可改进的按钮原因与名称（历史发现，已回传主代理）

1. app.js#updateStartAvailability：hasActive1688Work且Amazon无待续时，开始按钮被禁用，但analysisRequirementText可能仍显示“X个店铺可访问”。建议同步说明正在匹配、当前开始操作暂不可执行；不要把这误写成缺采购确认。
2. app.js#loadHistoryRun/#renderHistoryList：在途Amazon或1688时loadHistoryRun直接return，但历史“查看结果”仍可呈现可点击。建议禁用并附原因，或点击后说明当前不能切换。
3. app.js#renderAnalysisHandoffSummary：无任务、无合格产品或模拟数据时新交接按钮被禁用，但title仍可能是“保存…”。现只有报价更新分支解释禁用。建议根据真实原因显示“先采集/补齐初算/无合格产品”等。
4. “新建任务”导航实际上只切换视图，真正更换批次由重新导入或切站触发；“手动成本”弹窗还包含Amazon资料。可用简短副文案说明，避免误以为点击导航即清空任务、或不知道可在弹窗补Amazon信息。
5. 原“全部候选产品”Excel刻意不跟当前筛选收窄；新“导出合格产品与交接包”使用初筛范围。当前两种入口均保留，建议继续保持明确命名，不能悄悄让原导出只导当前页。

这些是初次审阅定位的提示/名称边界，不代表后续A02改动后仍全部存在。当时未发现独立新任务被总监或采购前置条件整体阻断；后续按钮调整由主代理核验，本次文档更新未重复进行UI验收。

## 持久化与源身份

- lib/persistence-store.mjs#validateSnapshot仅检查products是对象数组、每个id安全有效及少量UI标记；随后对整个products执行JSON克隆，没有商品字段白名单。因此商品对象上的analysisHistory、analysisDraft、analysisHandoff可随其他JSON兼容字段保留；null保持null，undefined按JSON规则不落盘。
- app.js#captureRunSnapshot传递完整products；restoreRunSnapshot直接接收保存的商品对象，未重新构造只含固定字段的商品。已交接商品跳过利润迁移以保留交接快照。
- 历史覆盖边界已修复：初次审阅时mergeSnapshotProducts对同id直接使用新提交商品整条覆盖，旧窗口缺字段时可能丢失版本元数据。现已增加下节所述的分析版本比较及历史归档合并；“任何同id提交都整条覆盖”的描述不再适用于已采用新分析版本的商品。双方都没有合法新版本字段的旧商品仍保持原覆盖行为。顶层未知字段不在validateSnapshot返回结构中，analysisHistory、analysisDraft、analysisHandoff仍应放在商品对象内。
- mapCandidateProduct沿用基线`${marketplace}:${sourceAsin}`身份。有效来源ASIN、parentAsin关系、sourceStores及sourceAsins保留；mergeAnalyzedCandidateProducts按id合并，现有商品对象持续更新。无ASIN时仍有旧版索引备用id，但交接校验会将缺失/非法ASIN列为待补，不能把该备用id宣称为完整Amazon产品身份。
- 原Excel exportTaskIdForProduct保持批次+商品身份映射；JSON source_ids另保留既有分析run、采购任务和导出任务ID，不需要新造原来源ID。新增分析草稿/历史版本不应改变原商品id或源ASIN；这与版本元数据是不同维度。

## 本轮持久化修复与验证（现行行为）

2026-09-09，已在lib/persistence-store.mjs的mergeSnapshotProducts中加入限定的mergeAnalysisDraftProduct处理。它保护同一商品的新分析版本和历史快照，不更改商品源身份，不扩展为通用冲突或时间戳机制。

- analysisDraft.version必须是大于等于2的安全整数，才启用新分析版本保护。现存商品版本高于提交版本时，保留现存整条商品；提交版本缺失或无效按旧版1比较，因此旧窗口不能覆盖较新的草稿、交接信息或历史。
- 提交版本相同或更高时，允许保存当前商品的编辑；analysisHistory按“归档version + 归档product.analysisHandoff.revision”合并。同键以已保存归档为准，不能改写此前交接快照；提交缺少history时仍保留已有归档。不同交接revision的归档不会因version相同而互相覆盖。
- 双方均无合法新版本字段时，旧商品沿用原来的同id覆盖行为，不凭空补出版本或历史。归档中的商品、当前商品的analysisDraft/analysisHandoff及其他JSON兼容字段仍通过原保存路径落盘。
- 测试确认保存后重新读取保留完整草稿、历史、交接字段及原商品id/sourceAsin；同版本可以编辑成本并再次交接给采购，但不能篡改旧归档。该保护不改变原导出接口，也不为运行级元数据新增冲突保护。

本轮相关测试共43项，全部通过；其中新增5项持久化回归测试，其他为既有相关验证：

| 测试文件 | 通过数 | 已验证范围 |
| --- | ---: | --- |
| test/persistence-store.test.mjs | 21 | 原保存行为；新增草稿/历史保存重读、旧窗口或较旧/非法版本回退拦截、同版本可编辑但旧快照不可改、高版本归档合并、旧商品兼容。 |
| test/persistence-latest-run-pointer.test.mjs | 3 | 最新任务指针相关既有行为。 |
| test/export-file-store.test.mjs | 6 | 导出文件保存相关既有行为。 |
| test/analysis-handoff.test.mjs | 13 | 分析交接包相关既有行为。 |

复核命令：`node --test test/persistence-store.test.mjs test/persistence-latest-run-pointer.test.mjs test/export-file-store.test.mjs test/analysis-handoff.test.mjs`。本记录汇总已完成的21项持久化测试与另外22项相关测试；本次仅更新文档，未重复运行。当前持久化模块及A02恢复副本另已通过语法检查。

验证只使用临时测试数据，没有触发真实采集、1688匹配、业务导出或修改真实任务；也未复制真实商品资料到本文件。43项结果证明上述持久化及相关模块回归范围，不证明新增UI入口、真实多窗口操作或部署已经完成。
