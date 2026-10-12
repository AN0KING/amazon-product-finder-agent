# 本地 HTTP API

本程序提供与 AI 厂商无关的 HTTP 接口。默认仅监听 `http://127.0.0.1:4173`。浏览器界面、本地脚本、具有本地执行能力的其他 AI 可使用同一接口。Amazon-only 和已确认的 1688 批次由服务后台调度；SellerSprite 多批分析目前仍由网页逐批请求，执行时需保留页面。两者均不依赖 AI 软件。

以下请求中的 `RUN_ID`、ASIN 和产品 ID 必须替换为当前已保存任务的真实值，示例不用于创建重复批次。云端 AI 的 `127.0.0.1` 不是用户电脑，需本地执行连接器；无需也不应开放公网。

## 请求约定

- `Host` 必须匹配 `127.0.0.1:4173`，不要用 `localhost` 替代。
- POST 必须带精确的 `Origin: http://127.0.0.1:4173`；JSON 接口使用 `Content-Type: application/json`。非 POST 若携带 Origin，也必须匹配。
- 只读查询不需要 `confirmed` 参数，也不建立 SellerSprite 连接；涉及接入、恢复或启动的操作须来自用户明确意图，不能由监控轮询顺带执行。
- 通常返回 `{ "ok": true, "data": ... }`；失败返回 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。检查 HTTP 状态和 `ok`，不要把一次可用 HTTP 响应当作任务成功。
- 普通接口不接受任意查询参数。监控优先读取 `/api/monitor`；直接排查 1688 时使用下文 16880 端口的原生只读接口，不带 `verify`，不调用任何 `health` 接口。

若显式改变 `SCOUT_PORT`，地址、Host 和 Origin 要一并改变；Windows 自带启动器和守护默认管理 4173 端口。

## 只读状态

| 方法和路径 | 内容 |
| --- | --- |
| `GET /api/version` | 程序版本、正在处理的请求计数、draining 及已缓存连接摘要 |
| `GET /api/amazon/collection` | 当前 Amazon 采集任务、进度、暂停或等待原因；无任务可返回 `data: null` |
| `GET /api/monitor` | 缓存的程序巡检摘要和已持久化事件；读取不触发外部查询 |
| `GET /api/sellsprite/status` | 可选配置是否可用、缓存连接状态、工具能力及真实调用统计；不返回密钥 |
| `GET /api/1688/pipeline` | 当前采购匹配批次状态、进度及暂停原因 |
| `GET /api/state` | 本地已保存任务概览，可用于取得真实 runId |
| `GET /api/runs/RUN_ID` | 指定任务快照；可较大，不应频繁全量轮询 |
| `GET /api/events` | SSE 快照更新通知；用于状态刷新，不替代业务调度 |

PowerShell 只读示例：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/version'
Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/monitor'
```

`GET /api/monitor` 的 `data` 结构：

```json
{
  "configured": true,
  "enabled": true,
  "errorCode": null,
  "persistenceError": null,
  "intervals": { "amazonMs": 900000, "supplier1688Ms": 1800000 },
  "checks": {
    "amazon": { "lastCheckedAt": null, "status": "waiting" },
    "supplier1688": { "lastCheckedAt": null, "status": "waiting" }
  },
  "events": []
}
```

上面是结构示例，实际时间、状态和事件来自本机。`configured` 表示是否启用配置，`enabled` 表示监控是否实际运行；初始化错误由 `errorCode` 表示，保存失败由 `persistenceError` 表示，不能将配置开关当作运行成功。每个事件含 `id`、`kind`、`source`、`message`、`createdAt`、`details`。尚未初始化或依赖暂不可用时可能显示 `waiting` / `unavailable`，不能据此主动重置任务。详情按事件种类提供进度或试验观察指标。

## 显式连接 SellerSprite

`POST /api/sellsprite/connect`，JSON 只允许：

```json
{ "confirmed": true, "marketplace": "CA" }
```

仅用户主动开启接入并连接时调用。`marketplace` 使用当前店铺批次的站点，不用其他市场代替。该接口读取独立本地配置、建立 MCP 连接并刷新工具能力，不查询商品销量；连接检查不计为商品工具调用。

实际月销量请求使用同市场目标 ASIN，由程序调用 `competitor_lookup`；成功握手、工具数量、调用次数和成功取得月销量的 ASIN 数是不同指标。缺少 MCP 配置的用户保持 Amazon 模式即可，详见 [独立运行说明](standalone-operations.md)。

## Amazon 后台任务

| 接口 | JSON 请求体 | 作用 |
| --- | --- | --- |
| `POST /api/amazon/collection/start` | `{"runId":"RUN_ID"}` | 启动已保存批次的后台采集；先检查现有任务，避免重复启动 |
| `POST /api/amazon/collection/control` | `{"runId":"RUN_ID","action":"pause"}` | 人工暂停并保留断点 |
| 同上 | `{"runId":"RUN_ID","action":"resume"}` | 按用户明确操作恢复当前任务 |
| 同上 | `{"runId":"RUN_ID","action":"retry_missing"}` | 用户明确要求重新补采缺项 |
| 同上 | `{"runId":"RUN_ID","action":"retry_missing","asins":["B000000001"]}` | 只补采当前任务中的指定 ASIN，数量 1–100；需先稳定暂停或处于可补采终态 |

接口也支持 `pause_for_supplier` / `resume_after_supplier` 供内部采购互斥使用。外部监控不要调用它们；人工暂停必须用 `pause`，不能转为可被自动解除的临时让出状态。

后台控制成功返回 HTTP 202，表示命令已接收，完成情况继续读取状态。`409` 通常表示任务正在退出、另有请求运行或批次正在替换，应读取状态而非反复提交。

仅在新文件验证通过、明确替换旧任务时，界面调用 `POST /api/runs/RUN_ID/archive`，请求体为 `{"reason":"file_upload"}`，取消并归档旧任务后再切换批次。该接口不是普通暂停接口，也不是轮询恢复工具。上传解析本身与归档是两个步骤，不能先归档再验证文件。

## 商品分析请求

`POST /api/products/search` 为商品分析入口，`POST /api/sellsprite/search` 为兼容路径。两者都由 `useSellerSprite` 决定数据源，不能仅看路径判断发生了 MCP 调用。

```json
{
  "runId": "RUN_ID",
  "marketplace": "CA",
  "stores": [{ "marketplace": "CA", "sellerId": "ACTUAL_SELLER_ID", "asins": ["B000000001"] }],
  "filters": { "monthlySalesBand": "all", "minRating": null, "minReviews": null },
  "useSellerSprite": false,
  "phase": "analyze"
}
```

使用当前批次中的真实卖家及 ASIN，示例值是占位。`phase` 支持 `full`、`discover`、`analyze`；`useSellerSprite` 默认 false。打开接入时传 true，先完成同站点显式连接并确认工具可用；这会执行真实商品查询，可能消耗 SellerSprite 配额。每个店铺的 `asins` 最多 100 个，程序内部按接口限制拆批。`detailAsins` 只允许用于 Amazon-only 的 `analyze` 请求。不要与后台已运行的同批采集并发执行。

`monthlySalesBand` 支持 `all`、`50_to_100`、`100_plus`，未知销量不会伪装成零。该入口返回分析结果，不替代界面的任务保存与归档流程；SellerSprite 多批次查询不会由该接口自动建立持久后台队列，断开请求或关闭网页可能中断后续批次，需要用户明确继续；普通使用者先在界面导入并建立批次，本地脚本再读取和控制该批次。

## 1688 任务与验证恢复

`POST /api/1688/pipeline/control`：

```json
{ "runId": "RUN_ID", "action": "pause" }
```

`action` 支持 `start`、`resume`、`pause`、`discard`、`append`。`start` / `resume` 推进已保存批次；`pause` 保留断点；`discard` 停止该批次的匹配；`append` 可带 `productIds` 数组，只应添加用户已经确认的产品。监控不得扩大范围或创建重复匹配。

遇到滑块或登录问题时，由用户在自己的浏览器完成验证。明确恢复搜图队列使用 `POST /api/v1/queue/resume`：

```json
{ "confirmed": true }
```

按匹配批次状态再决定是否需要用户明确 `resume`。恢复队列不会重新启用已被滑块终止的递增速率试验。

4173 端口的兼容采购状态代理会进行依赖协议探测，不作为无人值守巡检入口。桥接原生只读地址为 `http://127.0.0.1:16880/api/v1/queue/rate-trial` 和 `http://127.0.0.1:16880/api/v1/runtime`，后者不带 `verify`。试验配置和指标见 [速率试验文档](1688-rate-trial.md)。程序事件监控不会修改速率、重开试验、自动通过验证或把旧已完成批次算作当前试验完成。

## POST 调用示例

下面仅用于用户明确要求暂停现有任务时；将 ID 替换为真实值：

```powershell
$scoutOrigin = 'http://127.0.0.1:4173'
$scoutBody = @{ runId = 'RUN_ID'; action = 'pause' } | ConvertTo-Json
Invoke-RestMethod -Uri "$scoutOrigin/api/amazon/collection/control" `
  -Method Post -Headers @{ Origin = $scoutOrigin } `
  -ContentType 'application/json' -Body $scoutBody
```

状态读取失败时先检查本地进程和 [运行日志](standalone-operations.md)，不要通过授权 SellerSprite、调用健康接口、重置任务或删除数据来“修复”监控。
