# WorkBuddy / 其他本地 AI 的接口文件

本目录可独立阅读，也随 Windows 包安装到 `%LOCALAPPDATA%\ScoutAmazon\interfaces`。自动巡检已经由 Scout 程序执行，**不要在 WorkBuddy 再建立定时采集、自动恢复或重复匹配任务**。AI 只是按用户要求查看状态、暂停或恢复的入口；关闭 AI 不影响已经保存并启动的 Amazon 和 1688 后台任务。

Windows 10/11 64 位电脑准备好系统 Edge 和 Node.js 24.x Windows x64，完整解压后双击 `Install.cmd` 即可安装。轻量包使用本机 Node；安装器检查版本与架构并记录绝对路径，不修改全局 Node。npm 生产依赖与采购组件已随包提供，无需运行 `npm install`；1688 首次使用仅需登录本人账号。安装路径、启动方式以 [安装说明](../docs/workbuddy-installation.md) 为准，附带源码文档中的旧 `D:` 盘路径不适用于此包。巡检状态保存在安装目录 `data\scout\program-monitor.json`。

## 文件与兼容范围

| 文件 | 用途 |
| --- | --- |
| `scout-local.openapi.json` | 标准 OpenAPI 3.1 接口定义，限定只读状态与显式暂停/恢复；不是整个服务的 API 清单 |
| `Invoke-Scout.ps1` | Windows PowerShell 5.1 / PowerShell 7 均可执行的单次 HTTP 客户端，输出 JSON |
| `../docs/workbuddy-installation.md` | Windows 安装、首次使用、故障边界和迁移说明 |

本包不假定 WorkBuddy 的某个专有插件或 MCP 导入格式。若当前 WorkBuddy 版本支持 OpenAPI 导入，可按其产品说明导入本 JSON 并使用电脑本地执行环境；若支持本地命令/终端，直接运行下面的 PowerShell 示例。只有云端执行能力时，不能访问同事电脑的 `127.0.0.1`；应使用其可信本地执行功能，不要将 Scout 开放到公网。无需把 SellerSprite 密钥交给 WorkBuddy。

## 一次性查看状态

在 PowerShell 中执行：

```powershell
$scoutClient = Join-Path $env:LOCALAPPDATA 'ScoutAmazon\interfaces\Invoke-Scout.ps1'
& $scoutClient -Operation Status
```

若由 WorkBuddy 使用普通命令行运行，可使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ScoutAmazon\interfaces\Invoke-Scout.ps1" -Operation Status
```

`-ExecutionPolicy Bypass` 仅针对该次受信任脚本进程，不更改系统执行策略；应使用你收到的完整可信安装包。企业策略禁止脚本时应让 IT 按内部流程处理。

`Status` 依次读取版本、Amazon 任务、1688 批次、缓存巡检和 SellerSprite 可选状态。它不会开启接入或请求商品数据。某一读取失败时输出 `ok:false` 并以退出码 `1` 结束，不自动重试。接口成功退出码为 `0`。

可选操作：

| `-Operation` | 作用 |
| --- | --- |
| `Status`（默认） | 汇总上述五种只读状态 |
| `Version` / `Monitor` | 读取版本和缓存巡检事件 |
| `Amazon` / `Supplier1688` | 读取当前任务和真实 `runId` |
| `SellerSprite` | 读取可选配置、缓存连接和调用统计，不连接 MCP |
| `Runs` | 读取已保存任务概览 |
| `Run -RunId ...` | 按需读取一个完整快照；避免频繁全量读取 |
| `PauseAmazon` / `ResumeAmazon` | 用户明确操作当前 Amazon 任务 |
| `Pause1688` / `Resume1688` | 用户明确操作当前 1688 批次 |

## 明确暂停或恢复

先读取状态得到真实 `runId`。以下值只是占位，**不要直接照抄**。只有用户明确要求时，才传 `-Confirmed`：

```powershell
& $scoutClient -Operation Amazon
& $scoutClient -Operation PauseAmazon -RunId '替换为当前任务ID' -Confirmed
& $scoutClient -Operation Amazon

# 用户随后明确要求继续，且已处理需要本人操作的登录/验证问题：
& $scoutClient -Operation ResumeAmazon -RunId '替换为当前任务ID' -Confirmed
```

匹配使用 `Supplier1688`、`Pause1688`、`Resume1688`。客户端先检查 ID 与当前后台任务相同，再发送一次控制命令。它不自动创建或切换任务。`-Confirmed` 是调用方对用户意图的确认，不是身份验证凭据；不能在自动监控中固定添加。

服务的控制请求为：

```http
POST /api/amazon/collection/control HTTP/1.1
Host: 127.0.0.1:4173
Origin: http://127.0.0.1:4173
Content-Type: application/json

{"runId":"REPLACE_WITH_CURRENT_RUN_ID","action":"pause"}
```

1688 路径为 `/api/1688/pipeline/control`。两个接口请求体都没有 `confirmed` 字段；`-Confirmed` 由 PowerShell 客户端自己检查。Amazon 成功响应为 `202`，1688 为 `200`，只表示命令已接收，之后应读取状态确认。控制超时或 `409` 时先查看状态，不能假定失败后自动再次提交。

## 可给本地 AI 的操作说明

> Scout 的自动轮询、有限重试、断点恢复由本地程序负责。请仅在我要求时调用 Invoke-Scout.ps1 查看状态。正常运行、冷却、人工暂停、等待新批次时无需采取动作。任何暂停或恢复都必须有我的明确指令，并核对当前 runId。不要自动创建任务、扩大匹配产品范围、修改速率、调用 health 或 runtime?verify 接口、授权 SellerSprite、解验证码或反复续跑。遇到登录/验证码需要我本人处理。不要删除 data/config，或修改人工价格、重量、采购成本和供应商报价。

上述说明不是额外的定时任务。完整接口背景见 [本地 API](../docs/local-api.md)。
