# 独立运行与自动巡检

Scout 是本地 Node.js 程序。运行、采集、定时检查和断点保存不依赖 ChatGPT、Codex 或其他 AI 软件。SellerSprite 与 1688 都是可选接入；没有 SellerSprite 配置的同事可直接使用 Amazon 模式。

## Windows 首次启动

1. 安装 Node.js 24，并将仓库下载或克隆到自己的本地目录。
2. 在项目根目录打开 PowerShell，执行：

```powershell
node --version
npm ci
.\launch-scout-au.ps1 -NoBrowser
```

打开 <http://127.0.0.1:4173/>。也可以运行 `.\launch-scout-au.ps1`，由启动器打开浏览器窗口；`-NoBrowser` 仅控制是否打开界面。

Windows 推荐使用启动器：它启动本地服务和 `scripts/watch-scout-service.ps1` 守护进程。`npm start` 也能直接运行服务及服务内的任务、事件巡检，但不会启动 Windows 外部守护；关闭其终端可能结束服务。启动器会尝试启动 1688 桥接，1688 的安装和登录要求见 [1688 依赖说明](../1688-dependencies/README.md)。没有登录采购服务不应阻止 Amazon 采集。仅运行 Amazon 时可加 `-Skip1688Startup`：`.\launch-scout-au.ps1 -NoBrowser -Skip1688Startup`，完全跳过采购桥启动。服务守护恢复也会使用此选项，不因一次服务检查而探测或启动采购服务。

关闭 AI 软件不会中断程序；电脑仍须保持开机，Node 服务须继续运行。电脑关机、休眠或网络中断期间不会产生有效采集或速率观察。此启动器不等于 Windows 开机自启配置。

## 不使用 SellerSprite

保持“接入 SellerSprite”关闭即可，无需安装 MCP 宿主、浏览器扩展或任何 AI 软件，也无需创建 SellerSprite 配置文件。缺少配置只表示可选接入不可用，不阻断 Amazon 模式。

Amazon 模式读取同站点、同 ASIN 页面上的过去一个月购买量；`50+` 表示下限。页面没有提供数值时标记“未知”，不把它当作零销量，也不凭空生成销量。站点以导入店铺链接为准，例如加拿大链接使用 CA；不能借其他站点的数据补齐。

## 可选配置 SellerSprite

Scout 的 Node 客户端直接连接 SellerSprite 远端 MCP；无需先给某个 AI 应用安装 MCP。先在 [SellerSprite 官方页面](https://open.sellersprite.com/mcp?language=zh-cn) 获取本人可用的连接和工具权限。

将 `config/sellersprite.example.toml` 复制为 `config/sellersprite.local.toml`。默认示例如下：

```toml
[sellersprite]
enabled = true
url = "https://mcp.sellersprite.com/mcp"
env_http_headers = { "secret-key" = "SCOUT_SELLERSPRITE_SECRET_KEY" }
```

在启动 Scout 的进程环境中设置 `SCOUT_SELLERSPRITE_SECRET_KEY`。或者仅在本机 `.local.toml` 中使用 `http_headers = { "secret-key" = "替换为本人密钥" }`，替代上面的 `env_http_headers`。需要 bearer 认证的连接可使用 `bearer_token_env_var`，具体形式以服务提供者配置为准。不要把真实密钥放入命令示例、聊天、截图或提交记录。

也可通过 `SCOUT_SELLERSPRITE_CONFIG_PATH` 指向另一份 TOML。默认路径和相对覆盖路径都基于程序安装目录，不基于终端当前目录。程序不自动读取 `~/.codex` 或其他 AI 应用配置。迁移旧配置时，仅将本人需要的一个 SellerSprite 节复制到上述独立文件；支持 `mcp_servers.sellersprite`、`mcp_servers.sellsprite`、`mcp_servers.sellersprite-mcp`、`mcp_servers.sellsprite-mcp` 四种节名。它们与 `[sellersprite]` 只能保留一个，防止用错凭据。

然后在界面主动开启接入并连接当前站点。连接握手与工具清单检查不代表已取得销量；商品查询次数与成功取得销量的 ASIN 数分别统计，一次批量请求可包含多个 ASIN。查询目标销量需要 `competitor_lookup` 工具，`asin_detail` 仅补充详情；`asin_competitor` 返回相关竞品，不能替代目标 ASIN 销量。站点还须在工具支持范围内。具体口径见 [月销量来源](monthly-sales-sources.md)。

## 调度职责与频率

| 组件 | 频率 | 作用 |
| --- | --- | --- |
| Amazon 后台采集器 | 每 30 秒检查 | 推进已保存任务、处理有限重试和断点恢复 |
| 1688 匹配任务执行器 | 根据 `nextRetryAt` 唤醒，并每 5 秒兜底检查 | 单任务推进、冷却和有限重试；不是每 5 秒提交一次搜图 |
| Windows 服务守护 | 每 60 秒 | 只检查本地服务，确认所属进程后恢复退出或持续失去响应的服务 |
| 程序事件监控：Amazon | 每 15 分钟 | 记录完成、故障恢复、持续故障或需人工处理事件 |
| 程序事件监控：1688 | 每 30 分钟 | 记录速率试验验证暂停、吞吐不足或实际试验完成等事件 |

Amazon-only 采集和已确认的 1688 后台匹配由服务计时、重试与恢复，界面只读取其状态；刷新或关闭页面后，这些后台任务继续运行。SellerSprite 多店铺、多批次分析目前仍由网页逐批发起，执行时需保留页面，关闭后须用户明确继续；不要把它当作已完整托管的后台任务。两种模式都不依赖 AI 软件。事件巡检只读业务状态，不创建任务、不授权 SellerSprite、不解除人工暂停，也不通过 `health` 接口制造额外连接。

监控事件及去重信息持久化在 `data/program-monitor.json`，在界面及 `GET /api/monitor` 可查看。正常运行、冷却、人工暂停、等待新批次和重复状态不反复生成通知。`SCOUT_MONITOR_ENABLED=0` 可停用这层事件监控，供诊断或隔离测试使用；它不会停止业务执行器或 Windows 守护。

## 暂停、换批与验证

- 点击暂停：保留当前任务、结果和断点，等待明确恢复；守护进程或轮询不能擅自恢复人工暂停。
- 上传新文件：先验证文件有效，再取消并归档旧任务，清理旧执行缓存并切换新批次。无效文件不能取消当前任务。历史人工价格、重量、采购成本和供应商报价保留在归档中。
- 服务退出：守护器只恢复属于本项目的服务；业务执行器根据保存状态恢复可运行任务，已暂停或已归档任务不会变成新任务。
- Amazon/1688 访问验证：保持断点，由本人在页面处理；完成后明确恢复。不会自动解验证码、循环强行重试或扩大任务范围。
- 1688 实际匹配间隔与冷却以桥接返回的 `ratePolicy` 为准。用户明确启用的逐小时速率试验从 90 次/小时起步，满足整小时、实际样本足够且无验证暂停才增加 10 次/小时。样本不足标记 `throughput_limited`，保持当前速率并停止加档；观测中断或不足一小时不算通过。旧批次已完成不代表新试验完成。滑块暂停后的队列恢复不自动重新开启递增试验。

速率、成功返回候选次数、实际发起次数（含重试）及上一档完整通过记录的定义见 [1688 速率试验](1688-rate-trial.md)。一次观察不能证明平台固定的验证码阈值。

## 排障与迁移

先读取 `GET /api/version`、`GET /api/amazon/collection` 与 `GET /api/monitor`；不要把“连不上 SellerSprite”与“本地程序不能运行”混为一谈。SellerSprite 只读诊断使用 `GET /api/sellsprite/status`；未配置、凭据无效、工具缺失和不支持的站点应分别处理。

服务日志在 `%TEMP%\scout-au\server-output.log`、`server-error.log`；守护日志为 `watchdog.log`，其 PID 记录为 `watchdog.pid`。排障前先保存这些错误信息，不要删除 `data` 或重置任务。启动器遇到不属于本项目的端口占用时不会终止其他进程。

GitHub 交付源码、占位配置、测试和文档，不携带本机密钥、任务数据、Cookies 或浏览器登录状态。同事使用自己的账户配置。替换已有目录前备份本机配置及 `data`，不要用仓库内容覆盖工作数据。

其他 AI 可通过 [本地 HTTP API](local-api.md) 作为可选操作入口。云端 AI 通常无法直接访问用户电脑的 `127.0.0.1`，需要有本地执行能力的连接器；不应为此将服务开放公网。
