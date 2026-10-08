# 店铺表导入接口（DIR-20260909-A01 v1.1）

以下为 synthetic 测试说明，不代表真实业务授权。

既有 XLSX 首工作表、5 MB 限制、无表头单列链接和中英文卖家字段保持兼容。原程序不支持 CSV，本次不新增该格式。

新增列：marketplace/站点；monthlySalesBand/月销量档；minReviews/最低评价数量；minRating/最低评价星级；minProfitMargin/最低利润率。站点支持 AU/澳洲、US/美国、NL/荷兰及对应 Amazon 域名。月销量支持 all、under_50、50_to_100、100_plus 和现有中文档位。

每个 stores 项新增 criteria、criteriaSource、importBlocked。criteria 四项为 monthlySalesBand、minReviews、minRating、minProfitMargin；空值保持 null 并继承全局条件，显式 0/all 保留。最低利润率单位为百分点，20 代表 20%。Excel 百分比格式的原始 0.2 或文本 20% 均转为 20。无明确单位且绝对值小于 1 的非零裸数字拒绝歧义；0.2% 可使用文本或标有 %/Pct 的列。

criteriaSource 含 schemaVersion=1.0、marginUnit=percent、rows。每行保存 rowNumber、marketplace、marketplaceSource(row/seller_url/selected_batch)、criteria、rawCriteria、cellUnits。Excel 百分比数值的 cellUnits.minProfitMargin 为 excel_percentage_fraction，并保留 rawCriteria 原始 0.2。

只将与当前任务站点一致的行放进 stores；不同站点分批导入，站点与链接矛盾或未知站点均拒绝。新增 marketplaceGroups 含 marketplace/rowNumbers/acceptedRows/rejectedRows/requiresSeparateBatch；audit 增加 detectedMarketplaces、requiresSeparateBatches、criteriaConflictStores；rejectedRows 保留行号、错误码、原始行和原因。

同店同条件重复行合并 ASIN 并保留所有原始行；条件冲突时整店 importBlocked=true、resolved=false。应用不得采集 importBlocked 店铺。原始 storeList 与简化商品 sourceStores 通过 sellerId/rowNumbers 映射，每个非 null 店铺条件优先于全局条件。一个商品来自多店铺时可在任一来源规则通过时纳入，仍需保留全部来源和逐规则结论。

示例：sellerId=A1EXAMPLEAU99、marketplace=AU、rowNumbers=[2]、criteria={monthlySalesBand:50_to_100,minReviews:50,minRating:4.5,minProfitMargin:20}；该例仅为 synthetic 数据。

验证：test/marketplace.test.mjs 和 test/store-list-criteria.test.mjs 共 22 项通过，覆盖旧格式、站点/链接、混站、条件冲突、缺值、零、XLSX 百分比样式；未调用 Amazon 或 1688。模块需随主应用安全重启生效，UI 消费和共享目录发布由主代理集成。
