# 补充包验证记录

> 下方为2026-10-10原始复制版本的历史记录。2026-10-12已修改速率策略、桥接集成及对应测试，4项旧节奏断言已同步；新增试验说明见 [1688-rate-trial.md](../docs/1688-rate-trial.md)。SOURCE-SHA256.json仅用于原始版本。

日期：2026-10-10。环境：Windows，Node.js v24.21.0，npm 11.19.0。

## 文件和依赖

- 47 个原始程序、测试、依赖配置和文档文件与本机原文件逐字节一致，见 SOURCE-SHA256.json。
- 42 个 JavaScript / MJS 文件全部通过 node --check 语法检查。
- 1688-image-finder 的 node_modules 在独立分发目录通过 npm ci --omit=dev --ignore-scripts --no-audit --no-fund 安装；共 79 个 npm 包。
- npm ls --omit=dev --depth=0 通过，7 项直接依赖齐全。
- GitHub 仅包含程序和依赖声明，D 盘 ZIP 额外包含干净安装的 node_modules。
- data、浏览器会话、用户登录信息、日志、图片、任务及旧启动器备份均不在发布清单。

## 原有测试结果

- image-finder：71 / 71 项通过。
- 采购助手桥接及队列策略：30 / 34 项通过。
- 合计：101 项通过，4 项失败。

4 项失败均来自原有节奏配置与旧测试预期不一致。现有源码 lib/image-search-rate-policy.mjs 默认基础间隔为 18 秒、每 10 次额外休息 20 秒；原测试仍要求 30 秒、每 5 次额外休息 30 秒。原采购助手 README 的相应描述也未同步。此补充发布按用户要求原样保留程序、测试及原文档，未修复或跳过失败测试。

失败项：

1. test/bridge-queue.test.mjs:142：显式恢复后的等待时长，实际 18000 ms，预期 30000 ms。
2. test/image-search-rate-policy.test.mjs:18：默认最小间隔，实际 18000 ms，预期 30000 ms。
3. test/image-search-rate-policy.test.mjs:29：单次派发间隔，实际 18000 ms，预期 30000 ms。
4. test/image-search-rate-policy.test.mjs:49：第 5 次派发后的等待时长，实际 18000 ms，预期 60000 ms。

## 验证边界

本次验证在独立补充目录运行模拟测试，未启动本机生产采购队列、登录窗口或真实搜图，也未用发布者账号替同事登录。目标电脑仍需满足 README 中的 Node.js、Microsoft Edge、真实 D 盘目录要求，并由同事用自己的账号完成登录与必要的人工验证。
