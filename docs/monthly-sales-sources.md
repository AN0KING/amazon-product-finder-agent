# 月销量来源与连接行为

## 来源与口径

- 关闭 SellerSprite：仅用 Amazon 当前商品页/同 ASIN 店铺卡片的过去一个月购买量；`50+` 是下限，不是精确销量。新版组件和多语言文本需要明确的一个月口径，隐藏、推荐商品、其他 ASIN 或冲突值被拒绝。
- 开启 SellerSprite：用户主动连接后，同市场、同目标 ASIN 查询 `competitor_lookup`，`month: nearly`、`variation: N`（包含变体）、每批最多 40 个 ASIN。子体月销量只取 `amzUnit`；`units` 父体月销量仅保留参考，不能替代子体。
- `asin_detail` 补充商品参数，官方返回字段未包含月销量；没有该可选工具时不逐商品制造调用失败。`asin_competitor` 查询相关竞品，不能用竞品销量填充目标商品。
- SellerSprite 原始来源字段、目标 ASIN、查询站点、采集时间及可用的数据更新时间保存在 `sales30Evidence`。若 API 没有更新时间，保留空值，不虚构。
- Amazon 原始证据可以保留在 `amazonSales30Evidence`，来源关闭或 API 没有有效数据时回退。有效 SellerSprite 值低于 50 时不会挑选更高 Amazon 值让商品通过。
- 月销量缺失/无法核验为未知，不等于零或低于 50；全部源 ASIN 保留。店铺导入应用有效月销量 ≥50 及所选档位筛选；ASIN 导入默认不限月销量，低销量和未知商品均进入候选，仅在主动选择销量档位后筛选。已有商品及人工结果保留。
- 仅修改采购成本、售价或重量不会使已有销量证据失效；人工修改的销量不作为自动核验结果，后台补采也不能覆盖该人工数值。

## 覆盖统计

统计区分有效值 ≥50、有效值 <50、未知。未知再分待采集、请求失败、页面未提供、待核验，并展示 Amazon 与 SellerSprite 来源数量。证据核验标准不因导入方式变化。ASIN 任务始终显示并启用月销量筛选，旧任务重新打开时按已保存档位筛选，不修改销量证据或重新采集。ASIN 的 all 表示不限销量；50_plus、50_to_100、100_plus 是用户主动选择的限制。店铺 all 仍要求有效月销量至少 50。候选、采购和交接沿用该规则，交接仍需人工初审。

已经记录为页面未提供的数据不能被新解析器凭空补齐。不存在原始 HTML 时，必须等真实页面再次被采集，或用户在支持的市场启用有权限的 API；代码升级不会把未知改为达标、重置任务或自动发起全量收费查询。

## 本地连接

在官方 MCP 配置页面获取自己的连接配置，保存在本程序的 `config/sellersprite.local.toml`，或通过 `SCOUT_SELLERSPRITE_CONFIG_PATH` 指定独立文件；不读取 AI 软件配置。首选独立 `[sellersprite]` 配置，兼容 `mcp_servers.sellersprite`、`mcp_servers.sellsprite`、`mcp_servers.sellersprite-mcp` 或 `mcp_servers.sellsprite-mcp`（只保留一个配置项，多个别名同时存在会报配置歧义），并支持 `http_headers`、`env_http_headers`、`bearer_token_env_var`。密钥只在本机设置，不放进源码、日志或聊天。

- GET `/api/sellsprite/status`：只读配置是否存在和已缓存工具能力，不返回地址、密钥或配置原文。
- POST `/api/sellsprite/connect`：要求 JSON `confirmed: true` 和实际 `marketplace`；显式操作才建立连接。关闭接入开关时按钮不会请求外部服务。
- GET `/api/health`：保留为仅本地状态兼容接口，不再负责连接。监控继续使用 `/api/version`。
- 官方接口市场表为 US、JP、UK、DE、FR、IT、ES、CA、IN。工具 schema 如更严格则以交集为准。AU、NL 不受支持时明确拒绝，不能使用别的站点代理其月销量。
- 连接缺少配置、凭据无效、网络失败、站点不支持、月销量工具缺失分别给出原因，不能把失败显示为已连接。
- 明确点击连接时重新读取服务端工具清单；后台状态读取不触发连接。官方 MCP 配置须提供 `competitor_lookup`，`asin_detail` 为可选补充。仅提供 `asin_competitor` 时，提示缺少目标 ASIN 月销量能力，不发起错误替代查询。

## 官方依据

- [目标 ASIN 竞品数据查询与字段](https://open.sellersprite.com/api/1)
- [ASIN 详情](https://open.sellersprite.com/api/3)
- [相关竞品 ASIN 查询](https://open.sellersprite.com/api/62)
- [市场与参数附录](https://open.sellersprite.com/appendix)
- [MCP 配置说明](https://open.sellersprite.com/mcp?language=zh-cn)

官方宣传页与接口附录对少数市场列举可能不同；此实现不根据宣传推测 AU 支持，且不把未执行的真实调用当作已验证成功。

独立启动和配置步骤见 [本地运行手册](standalone-operations.md)。未配置时保持 Amazon 模式；不需要安装 MCP 宿主或任何 AI 软件。
