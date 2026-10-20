# 0.9.62：1688节奏与AU/CA重量排查

## 范围与结论

用户确认同事使用0.9.62。对照保存的正式0.9.62安装包，当前工作区的 Amazon 页面解析、CDP规格展开及1688限速模块在本次修改前与该包SHA-256完全一致。0.9.63/0.9.64的其他更新不能视作这两项问题的解决方案。

本次仅修正普通1688队列节奏：最小开始间隔由18秒改为60秒，每10件的额外休息由20秒改为120秒。长时理论上限从约180件/小时降为约50件/小时；实际速度还取决于每件处理耗时。这是降低请求密度的措施，不是验证码原因已被现场证实，也不保证不出现验证。

旧配置只能使普通队列更慢，不能把新下限调快。初始化从旧保存状态恢复第10件休息时采用更保守的期限；不缩短已有429冷却，不解除人工暂停。独立速率试验，包括其停止状态、目标速率、历史及验证规则，维持原实现。本次未恢复任何队列、未重启生产服务、未改业务持久化数据。

## 复现及验证

新增 `1688-dependencies/1688-procurement-assistant-2.3.0/test/ordinary-search-pacing.test.mjs`。旧代码：18秒后再次调度的断言失败；旧第10件38秒期限到期后升级恢复的断言失败（实际等待0，预期142000毫秒）。修复后两个复现均通过。

验证命令：

```text
node --test 1688-dependencies/1688-procurement-assistant-2.3.0/test/*.test.mjs
node --test test/1688-rate-policy-client.test.mjs test/1688-managed-verification-chain.test.mjs test/amazon-product-weight.test.mjs test/amazon-item-weight-normalization.test.mjs test/amazon-full-specifications.test.mjs
node --test --test-name-pattern="B09 user-provided source" test/amazon-product-single-visit.test.mjs
```

分别82、98、1项通过。第一轮桥接隔离测试因沙箱拒绝标准用户目录realpath而失败，允许正常路径读取后全数通过；未改变产品逻辑来适配测试。现有速率试验90→100→110、风险停止、显式验证与恢复、平台429退避测试均通过。

## Amazon未解决项

只读检查本地CA任务 `4da35131-fdbe-40a3-b8c7-fbd9aeeaa7e4`：49件，12件重量已核验、37件待核验。价格43件已核验、6件不可获取。任务已结束，38件额外补查预算耗尽，没有重置或再次提交。

49件的商品信息检查原因分布：44件 `inspection_timeout`，5件 `unparsed_rows`。示例B0FVS6BDTZ已读到19行、4个已完成的规格区，但“完整规格”入口处于disabled且未显示侧栏，因此整体检查未完成。这不是页面没有重量的证明。

AU B09NXS1BLL的用户原始`Item Weight = 110 g`行经现有解析、浏览器补充、映射和持久化链路得到0.11kg。旧诊断已记录普通用户会话与采集会话返回规格不同，尚无证据定位差异原因。不能把包装重量、承载重量或尺寸尾部重量拿来填空。

本次用内置浏览器只读打开CA B0FVS6BDTZ，收到`net::ERR_BLOCKED_BY_CLIENT`，没有绕过限制继续访问。没有取得同事0.9.62的失败ASIN及实际页面HTML，不能声称修复了AU/CA多数重量缺失或错误。需要同事各提供一件AU/CA失败商品的原链接，以及普通浏览器展开Product information、Measurements、Item details后的截图或保存HTML，才能比较页面内容与解析输入。截图可核对重量，HTML用于可重复解析回归。

本次不修改Amazon解析代码、不发布重量修复声明。
