# 1688 采购助手（桥接服务）2.3.0

本目录是店铺分析 Agent（scout-amazon-agent）期望的本机「1688 采购助手」兼容实现。
它在 `127.0.0.1:16880` 提供完整集成协议（integrationProtocol 8 / loginBrokerProtocol 5），
浏览器操作复用 `D:\deliverables\1688-image-finder` 的专用 Edge 会话。

## 工作流（无需任何手动导入）

1. Agent 内 Amazon 分析完成后，点击「1688 匹配」旁边的 **打开 1688 专用 Edge** 按钮：
   自动弹出专用 Edge 窗口 → 用 1688/淘宝 App 扫码 → 登录成功后窗口自动关闭。
2. 点击 **匹配当前筛选**：Agent 自动把每个商品的 Amazon 图片发给本服务，
   后台用该图片在 1688 以图搜款，返回候选供应商与参考报价。
3. 若 1688 弹出滑块/人工验证：立即暂停全部新搜图。打开专用 Edge，在对应商品图片的验证页手动完成验证。
   确认该图片搜索成功后，回到 Agent 点击 **验证完成，继续搜图** 才会重新排队；普通扫码登录、查询状态、等待或重启都不会解除图片风控暂停。

## 搜图节奏与恢复

- 同时只执行 1 个图片搜索任务，启动间隔至少 30 秒（约每分钟 2 次），每累计 5 次搜索后额外休息 30 秒。
  这是任务频率配置，并不是测得的 1688 HTTP 安全请求阈值。
- `BB1688_SEARCH_MIN_GAP_MS` 和 `BB1688_SEARCH_COOLDOWN_MS` 可增大间隔与休息时间，不能降低上述底线。
- 时间戳、累计次数、人工暂停与验证完成记录持久化到 `data/sourcing-console/runtime-cache/image-search-rate-policy.json`。
  升级时发现历史 `risk_blocked` 任务也会暂停队列。状态文件损坏会保守暂停，需要人工处理。
- 普通 HTTP 429 遵守 `Retry-After`，并至少冷却 5 分钟；同任务最多尝试 3 次。
  CAPTCHA、滑块、人工验证没有定时重试，不会通过账户验证或其他商品搜索成功而自动恢复。
- 专用 Edge 创建较慢时接口返回 `pending: true` 并保留原进程与缓存身份，后续打开请求复用该窗口。

## 会话数据

- 登录状态与 Edge 档案：`D:\deliverables\1688-image-finder\data\1688-session`（与精简版 CLI 共享，
  在 CLI 里扫码登录过则本服务直接免登录）。
- 任务与图片：本目录 `data\sourcing-console\`（任务 JSON、任务图片、登录握手文件、日志）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/v1/health | 服务身份握手 |
| GET | /api/v1/runtime[?verify=1] | 普通查询只读缓存；显式 verify=1 仅在没有人工暂停/冷却时校验账号，不恢复搜图 |
| POST | /api/v1/auth/open-login | 打开专用 Edge（purpose=login 扫码 / image_search 专项验证） |
| POST | /api/v1/queue/resume | 本次人工验证成功后传入 `{ "confirmed": true }` 明确恢复，否则返回 409 |
| POST | /api/v1/tasks | 以 base64 图片创建找厂任务 |
| GET | /api/v1/tasks(/:id) | 任务列表 / 详情（轮询 status: pending_review→queued→running→review_candidates） |
| POST | /api/v1/tasks/:id/confirm | 确认任务并入队执行 |

## 启动方式

- 随店铺分析 Agent 自启（launch-scout-au.ps1 已接入），也可手动：

```powershell
node D:\deliverables\amazon-product-finder-agent\scripts\start-1688-dependency.mjs
```

本地隔离回归（临时目录、模拟浏览器与会话，不访问 1688）：

```powershell
node --check server.mjs
node --test test/image-search-rate-policy.test.mjs test/bridge-queue.test.mjs
```
