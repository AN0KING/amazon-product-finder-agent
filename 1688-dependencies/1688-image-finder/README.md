# 1688 图片找厂精简版 (image-finder)

从 `1688-procurement-assistant-2.3.0` 中分离出的 **1688 以图搜款（图片找厂）** 独立命令行工具。

只保留两个命令：

- `login` — 扫码登录 1688，建立专用 Edge 会话
- `image-search` — 以图搜款，返回匹配的供应商/商品候选

## 环境要求

- **Windows**（会话路径硬编码为 D 盘，见下文）
- **Node.js ≥ 20**
- **Microsoft Edge**（必须，登录和浏览器自动化都依赖 Edge，不支持 Chrome/Chromium 回退）

## 部署步骤

1. 把整个 `1688-image-finder` 目录放到目标电脑的 **D 盘**，例如：

   ```
   D:\deliverables\1688-image-finder\
   ```

2. 打开 PowerShell，进入该目录：

   ```powershell
   cd D:\deliverables\1688-image-finder
   npm install
   ```

   > 依赖包括 `playwright`（含 Edge 控制）、`playwright-extra`、`puppeteer-extra-plugin-stealth`、`commander`、`qrcode`、`proper-lockfile`、`iconv-lite`。安装完成后 Playwright 需要能调用系统已安装的 Edge（本工具使用 `channel: 'msedge'`，无需额外下载浏览器内核）。

3. 创建会话目录（如果不存在，登录时会自动创建）：

   ```
   D:\deliverables\1688-image-finder\data\1688-session
   ```

## 使用

### 方式一：命令行

```powershell
# 1) 首次先登录（扫码）
node dist/cli.js login

# 遇到验证码需要人工处理时，用 headed 模式打开 Edge 窗口登录
node dist/cli.js login --headed

# 2) 以图搜款
node dist/cli.js image-search "D:\path\to\product.jpg" --max 40

# 交互式（遇滑块验证码时弹出 Edge 窗口手动处理）
node dist/cli.js image-search "D:\path\to\product.jpg" --max 40 --headed
```

### 方式二：双击批处理

双击 `图片找厂.bat`，按菜单选择登录或以图搜款。

## 输出

`image-search` 会返回匹配的商品列表，每项含：标题、价格、供应商、链接等。支持 `--json` / `--json-v2` 输出机器可读结果。

## 重要说明

### 会话路径（固定 D 盘）

本工具沿用了原采购助手的会话隔离机制，会话目录**硬编码为**：

```
D:\deliverables\1688-image-finder\data\1688-session
```

启动前会校验 `BB1688_HOME` 环境变量必须等于该路径（`图片找厂.bat` 已自动设置）。如果目标电脑没有 D 盘，需要修改 `dist/session/paths.js` 里的 `FIXED_WINDOWS_HOME` 常量。

### 风控与验证码

- 1688 会不定时弹出滑块/验证码。无头模式（默认）遇到风控会报 `RISK_CONTROL` 错误并停止，不会绕过验证。
- 遇到风控请用 `--headed` 模式重试，在弹出的 Edge 窗口里手动完成滑块，工具会自动继续。

### 与原采购助手的关系

- 本精简版**不依赖** `1688-procurement-assistant-2.3.0`，可独立部署运行。
- 它只做「以图搜款」这一件事，不含关键词搜索、供应商管理、采购工单、批量找厂控制台等原采购助手的其他功能。
- 会话目录与原采购助手**相互独立**（各自 `data\1688-session`），互不干扰，但需要各自单独登录 1688。

## 目录结构

```
1688-image-finder/
├── dist/
│   ├── cli.js                  # 命令行入口（仅 login + image-search）
│   ├── auth/                   # 登录会话解析、在线校验
│   ├── commands/
│   │   ├── login.js            # 扫码登录
│   │   └── image-search.js     # 以图搜款核心
│   ├── session/                # Edge 会话、Cookie、mtop 捕获、风控检测
│   ├── io/                     # 输入输出、错误处理
│   ├── procurement/            # store(图片类型检测)、类型定义
│   └── util/                   # 编码、临时文件、时间
├── package.json
└── 图片找厂.bat                # 便捷启动菜单
```
