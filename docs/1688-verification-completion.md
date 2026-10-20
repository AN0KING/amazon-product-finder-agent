# 1688 图片验证完成状态修复

## 现场症状与原因

用户点击图片验证后，专用 Edge 已显示本次图片对应的商品结果，Scout 却显示“上次窗口处理未完成：1688 did not confirm the signed-in session online.”。

2026-10-15 09:40（北京时间）的失败截图有完整的商品结果列表，页面分类为 `normal_1688_page`。错误堆栈是 `runManagedImageSearchVerification → verifiedImageSearchIdentity → requireOnlineIdentity`：完成新图片结果的稳定检查后，程序另开 `work.1688.com` 检查工作台登录；这个独立检查失败，否决了已得到的搜图结果。原流程关闭窗口后还会再执行一次同类工作台检查。

原测试把在线检查及持久化回读都模拟成成功，未覆盖这条失败路径。新的隔离测试执行真实入口、搜图验证、Cookie 保存与重新打开检查，并模拟本次图片成功响应及工作台失败，能稳定复现同一错误码。

## 完成条件

受管理的图片验证先监听本次请求，再提交原任务图片。只有可信 1688 搜图请求、当前新 imageId、成功的商品响应及非空商品结果同时满足，且页面无挑战、身份一致时，才确认图片验证完成。仅打开页面、URL 带 imageId、历史结果或缓存登录状态均不能证明成功。

已获得本次搜图证明后，不再用独立工作台可达性重复决定图片验证结果；仍保存官方会话 Cookie，并重新打开专用档案核对同一账号与 Cookie 持久性。普通账号登录继续执行原在线检查。

临时令牌刷新不等同于退出登录。真实登录失效、限流及风控仍阻止成功；人工挑战期间的旧响应不能用于完成证明。出现人工验证时保留原窗口及人工处理时间，不重复上传图片。

## 状态回写与暂停

成功退出后，现有 broker 写入 `manualVerificationCompletedAt` 并清除本次窗口错误。前端显示“图片验证已完成，等待继续搜图”。队列保持暂停，仅提供“验证完成，继续搜图”按钮；修复不自动调用恢复，不改变速率试验、40 秒间隔、任务编号、候选结果或人工成本。

若独立在线登录校验确实未确认，前端明确说明该原因，不再笼统展示英文窗口未完成错误。

## 隔离回归命令

```powershell
node --test test/1688-managed-verification-chain.test.mjs test/1688-session-frontend.test.mjs
node --test 1688-dependencies/1688-procurement-assistant-2.3.0/test/bridge-queue.test.mjs
```

测试使用内存浏览器或临时目录，不读取真实凭据，不访问 1688，不恢复真实队列。源安装的执行器位于 `D:\deliverables\1688-image-finder`，交付副本位于项目的 `1688-dependencies\1688-image-finder`；两处修复应保持一致，但保留各自原有的运行路径校验。

## 本机验证结果

2026-10-15：真实链路 31 项、前端状态 33 项、受管理验证 42 项、broker 队列 37 项，共 143 项通过；`npm run check`、新增模块语法和限定 diff 检查通过。实际执行目录的链路 31 项与 managed/single-submit 65 项另行通过。实际执行目录和交付副本的证据模块 SHA256 一致。

本机 `/app.js` 已返回更新后的提示代码，无需重启服务。原任务 `91b66734-f894-438a-a93e-7bb6f186afcd` 的首次现场启动未成功创建窗口；确认子进程退出后仅重试一次，窗口创建成功，但导航到淘宝登录页时出现 `ERR_CONNECTION_CLOSED`（浏览器错误页），尚未提交图片。这是现场联网阻塞，不能记为修复后的真实匹配成功。

前后比对确认：采购批次内容、任务编号和完整 ratePolicy 均未改变，队列仍暂停、运行中任务为 0。未调用队列恢复，也未重置验证码、重试预算或速率试验。脱敏前后状态保存于 `.diagnostics/1688-verification-before-2026-10-15.json` 和 `.diagnostics/1688-verification-after-2026-10-15.json`。
