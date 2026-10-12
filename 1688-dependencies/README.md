# 1688 找厂功能补充包（2.3.0）

本目录于2026-10-10补齐两个本地组件，最初直接复制可用版本。2026-10-12增加了用户授权的逐小时速率测试，详见 [1688-rate-trial.md](../docs/1688-rate-trial.md)。SOURCE-SHA256.json保留最初复制版本的历史校验，不表示后续修改文件的当前哈希。

## 包含内容

- 1688-procurement-assistant-2.3.0：监听 127.0.0.1:16880 的采购助手桥接服务、启动器及原有测试。
- 1688-image-finder：采购助手实际依赖的搜图及专用 Edge 会话组件、完整 dist 运行代码、依赖锁定文件及原有测试。
- SOURCE-SHA256.json：上述 47 个原始程序、测试和文档文件的 SHA-256 校验清单。

只复制采购助手一个目录仍无法启动，两个组件都必须安装。本补充包不包含 Amazon 主程序，保留人工验证暂停和HTTP 429退避机制。原 image-finder README 中提到的旧“图片找厂.bat”已不在当前程序中，请采用本文的启动命令。

## 使用条件

- Windows，具有真实可写的 D 盘。
- Node.js 24 LTS（现有组件声明最低 Node.js 20；本包用 24.21.0 验证）。Node.js 的 node 命令需要在 PATH 中。
- 已安装 Microsoft Edge；程序使用系统 Edge，无需另行下载 Chromium。
- 正常网络，以及同事自己的 1688/淘宝账号。

## 一、放置两个组件

GitHub 用户：将本目录中的两个组件文件夹复制到下面的真实目录。

压缩包用户：将压缩包内 deliverables 中的两个组件文件夹复制到 D:\deliverables。

默认安装布局：

    D:\deliverables\1688-procurement-assistant-2.3.0\server.mjs
    D:\deliverables\1688-procurement-assistant-2.3.0\scripts\1688-console-launcher.mjs
    D:\deliverables\1688-image-finder\dist\cli.js
    D:\deliverables\1688-image-finder\package.json

不要把文件留在压缩包预览中运行，也不要再多嵌套一层同名目录。已有这两个组件时，先备份旧程序再合并补充文件，保留原 data 目录。

**关于同事的 D:\选品Agent 路径：** 如果同事的 Amazon 程序已经把采购助手路径改成 D:\选品Agent\1688-procurement-assistant-2.3.0，可把同一份采购助手目录放到该位置，并使用该位置的启动器。这是采购助手的替代安装位置，与默认位置二选一，不需要复制或启动两份。1688-image-finder 仍必须放在 D:\deliverables\1688-image-finder，因为现有采购助手源码固定引用这里。无需再次修改源码。下方命令使用 GitHub 原版的默认 D:\deliverables 路径。

现有会话模块会拒绝目录联接、符号链接及 UNC 路径；请使用实际目录，不能只修改环境变量来迁移固定会话路径。

## 二、准备运行依赖

发给同事的 D 盘 ZIP 已附带干净安装的 1688-image-finder\node_modules，解压后无需再次安装 npm 依赖。ZIP 不包含 Node.js 或 Microsoft Edge 安装程序。

GitHub 不保存 node_modules。从 GitHub 下载时，在 PowerShell 中执行：

    Set-Location 'D:\deliverables\1688-image-finder'
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

该命令按随包 package-lock.json 安装依赖。采购助手桥接目录只有 Node.js 内置依赖，无需另行 npm install。

## 三、启动采购助手

在 PowerShell 中执行：

    node 'D:\deliverables\1688-procurement-assistant-2.3.0\scripts\1688-console-launcher.mjs'

看到“1688 采购助手已就绪”后，服务在本机 16880 端口运行。使用 D:\选品Agent 的同事，把这条命令中的采购助手路径替换为实际复制的位置即可，搜图组件路径不变。

然后打开原 Amazon 找品程序。GitHub 原版 Amazon 启动器也可以自动启动上述默认路径的采购助手。在 Amazon 页面打开 1688 专用 Edge，由同事使用自己的账号扫码登录，再按原流程进行图片匹配找厂。

登录会话会在目标电脑首次使用时自行生成。遇到人工验证时，在专用 Edge 内人工完成，再回到程序按提示继续。

## 四、发布范围

本补充包没有携带发布者的 data、Cookie、浏览器档案、登录会话、任务记录、商品图片、日志、采购报价或凭据；也没有携带旧启动器备份。每位同事的会话和业务数据都在自己的电脑生成。

- 采购助手运行数据：采购助手所在目录\data\sourcing-console。
- 专用 Edge 会话：D:\deliverables\1688-image-finder\data\1688-session。

## 五、已知原有文档和测试差异

未启用试验时，默认搜图节奏仍为基础间隔18秒、每10次额外休息20秒。2026-10-12已将4项过时测试断言与默认配置同步，并增加逐小时试验测试。原始发布验证结果作为历史保留在 [VALIDATION.md](VALIDATION.md)。启用试验后采用90次/小时起步的均匀节奏，实际吞吐另行记录。

## 六、本地验证方式

程序语法检查和以下原有测试使用本地模拟，不需要登录或发起真实搜图：

    Set-Location 'D:\deliverables\1688-procurement-assistant-2.3.0'
    node --check server.mjs
    node --test test/image-search-rate-policy.test.mjs test/bridge-queue.test.mjs
    Set-Location 'D:\deliverables\1688-image-finder'
    node --test test/image-search-single-submit.test.mjs test/login-managed-image-verification.test.mjs test/native-edge-launch.test.mjs

发布日期：2026-10-10。两组件版本：2.3.0；Amazon 主程序版本保持 v0.9.48。
