# 淘宝登录连接关闭与窗口错误分类

## 现场证据

2026-10-15 的 `02-07-38-777Z`、`02-12-59-101Z`、`02-14-55-898Z` 图片验证留存均显示 Edge 的内部错误页 `chrome-error://chromewebdata/`，页面标题为 `login.taobao.com`。最后一次留存 HTML 的错误码是 `ERR_CONNECTION_CLOSED`，与用户截图一致。留存位于源安装的 `data/1688-session/runs/`；不需要复制登录 URL 查询参数、Cookie 或账号标识来复现。

原分类器返回 `unknown`，受管理的验证循环随后报告 `IMAGE_SEARCH_UPLOAD_PAGE_UNSUPPORTED`。这是已复现的本地诊断缺陷；它掩盖了真正的浏览器连接失败。另一个 `02-14-22-768Z` 留存是普通搜索页，确实未识别到图片搜索应用，不应把所有历史错误都改判为网络失败。

## 假设与边界

排查顺序：特定登录跳转失败；普通与专用 Edge 的会话或代理差异；网络错误页误报为不支持上传；临时网络或服务端关闭连接。

本轮无凭据 HTTPS HEAD 探针中，`https://login.taobao.com/` 返回 302，`https://www.1688.com/` 返回 200，不能复现持续的整机域名不可达。这不证明历史 `/jump` 请求成功，也不证明当前账号在线。当前 Windows 用户代理关闭、未配置 PAC 和代理环境变量；后台会话源码带直连参数，专用可见窗口没有同一参数，但当前配置不足以证明代理是原因。

未访问真实登录跳转、未处理验证码、未切换账号或修改代理。现有证据不能判断账号被封，也不能据此建议换号。登录跳转为何被关闭仍需该次导航的网络证据；本次修复仅解决可复现的错误分类及误导提示。

## 修复

分类器严格识别浏览器内部错误 URL，保留可见的 `ERR_*` 错误码；普通业务页文本提到错误码不会被判为网络错误。受管理验证明确返回 `IMAGE_SEARCH_NETWORK_ERROR` 和中文连接失败原因。初始错误页不会被再次导航；提交图片后的连接错误不能被确认成功或引起重复上传。原账号、验证暂停、任务和速率策略保持原样。

源安装 `D:\deliverables\1688-image-finder` 与交付副本同步相同修复，保留两处既有路径校验差异。新验证进程会读取修复代码；历史 `lastWindowError` 不直接改写。

## 回归

```powershell
node --test 1688-dependencies/1688-image-finder/test/page-state-network.test.mjs 1688-dependencies/1688-image-finder/test/login-managed-image-verification.test.mjs
node --test test/1688-managed-verification-chain.test.mjs
```

新增 6 项：修复前 5 失败、1 通过；修复后相关 48 项全部通过，真实验证链路 31 项通过；源安装对应 48 项也通过。真实留存重放从 `unknown` 变为 `network_error`，保留 `ERR_CONNECTION_CLOSED`。日志为 `.diagnostics/0.9.58-taobao-network-red.log`、`0.9.58-taobao-network-green.log`、`0.9.58-taobao-network-source-green.log`、`0.9.58-taobao-chain-green.log` 和 `0.9.58-taobao-artifact-replay.log`。
